// DOM primitives for a contenteditable host: flat-text model, offset ⇄ DOM position,
// and edits.
//
// PORTED FROM INPUT VIM (MIT) — `content/handlers/contenteditable-handler.js`. That
// project solved this across six hosts (Teams, Outlook, Gmail, CKEditor, plain
// contenteditable) and its decisions are the result of real breakage, so this file
// adopts them rather than re-deriving them:
//
//   * a field is a list of BLOCKS joined by "\n"; with no block children the element
//     itself is one block (so "text<br>text" is a single block with an internal "\n");
//   * a <br> with nothing meaningful after it is a PLACEHOLDER, not a line: every
//     browser leaves one behind to make the last empty line reachable, and counting
//     it would give a one-line field two lines;
//   * an element inside the text — a mention chip, a formatted span — contributes its
//     TEXT, and offsets inside it map to positions inside it. A chip is unbreakable in
//     practice because the browser refuses to split a non-editable element;
//   * edits go through the SELECTION and `document.execCommand`, not through node
//     surgery. This is the load-bearing choice: execCommand deletes a chip whole,
//     keeps the host's own undo stack coherent, and lets framework editors (which
//     preventDefault on beforeinput) still behave like editors.
//
// Deviation from the reference, deliberate: no framework bridge (CKEditor et al). We
// target the composer in front of us; if a host refuses an edit we say so instead of
// guessing. See docs/EXTENSION.md.

const BLOCK_TAGS = {
  P: 1, DIV: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
  LI: 1, UL: 1, OL: 1, BLOCKQUOTE: 1, PRE: 1, SECTION: 1,
  ARTICLE: 1, ASIDE: 1, HEADER: 1, FOOTER: 1, NAV: 1,
  MAIN: 1, FIGURE: 1, FIGCAPTION: 1, TABLE: 1, TR: 1, TD: 1, TH: 1,
  DD: 1, DT: 1, DL: 1, DETAILS: 1, SUMMARY: 1, ADDRESS: 1,
};

const isBlock = (node) => node.nodeType === 1 && !!BLOCK_TAGS[node.tagName];

/** A <br> is a placeholder when nothing meaningful follows it in its parent. */
function isPlaceholderBR(br) {
  let next = br.nextSibling;
  while (next) {
    if (next.nodeType === 3 && next.textContent.length > 0) return false;
    if (next.nodeType === 1) return false;
    next = next.nextSibling;
  }
  return true;
}

/** Text of one block, with placeholder BRs contributing nothing. */
function blockText(block) {
  if (block.nodeType === 3) return block.textContent;
  const parts = [];
  const walk = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) parts.push(child.textContent);
      else if (child.nodeName === "BR") { if (!isPlaceholderBR(child)) parts.push("\n"); }
      else if (child.nodeType === 1) walk(child);
    }
  };
  walk(block);
  return parts.join("");
}

/** The direct block children of `el`, or `[el]` when the content is flat. */
export function getBlocks(el) {
  let hasBlock = false;
  for (let child = el.firstChild; child; child = child.nextSibling) {
    if (isBlock(child)) { hasBlock = true; break; }
  }
  if (!hasBlock) return [el];
  const blocks = [];
  for (let child = el.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 || (child.nodeType === 3 && child.textContent.trim())) blocks.push(child);
  }
  return blocks.length ? blocks : [el];
}

function childIdx(node) {
  let i = 0;
  for (let n = node.parentNode.firstChild; n && n !== node; n = n.nextSibling) i++;
  return i;
}

/** The flat text the engine edits. */
export function getFlatText(el) {
  return getBlocks(el).map(blockText).join("\n");
}

/** Characters a node contributes to the flat text. */
function countChars(node) {
  if (node.nodeType === 3) return node.textContent.length;
  if (node.nodeName === "BR") return isPlaceholderBR(node) ? 0 : 1;
  let count = 0;
  for (let child = node.firstChild; child; child = child.nextSibling) count += countChars(child);
  return count;
}

/** Flat offset from the start of a block to a DOM position inside it. */
function offsetInBlock(block, targetNode, targetOff) {
  if (block.nodeType === 3) {
    return targetNode === block ? Math.min(targetOff, block.textContent.length) : 0;
  }
  if (targetNode === block) {
    let offset = 0;
    for (let i = 0; i < targetOff && i < block.childNodes.length; i++) offset += countChars(block.childNodes[i]);
    return offset;
  }
  const result = { offset: 0, done: false };
  const walk = (container) => {
    if (result.done) return;
    let child = container.firstChild;
    while (child && !result.done) {
      if (child === targetNode) {
        if (child.nodeType === 3) result.offset += Math.min(targetOff, child.textContent.length);
        else for (let j = 0; j < targetOff && j < child.childNodes.length; j++) result.offset += countChars(child.childNodes[j]);
        result.done = true;
        return;
      }
      if (child.nodeType === 1 && child.contains && child.contains(targetNode)) { walk(child); return; }
      result.offset += countChars(child);
      child = child.nextSibling;
    }
  };
  walk(block);
  return result.offset;
}

/** Flat offset for any DOM position inside `el`. */
export function flatOffsetAt(el, targetNode, targetOff) {
  const blocks = getBlocks(el);
  let flatPos = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) flatPos++;
    const block = blocks[i];
    if (block === targetNode || (block.contains && block.contains(targetNode))) {
      return flatPos + offsetInBlock(block, targetNode, targetOff);
    }
    flatPos += blockText(block).length;
  }
  // A container-level position: between blocks.
  if (targetNode === el) {
    flatPos = 0;
    for (let j = 0; j < blocks.length; j++) {
      if (j > 0) flatPos++;
      if (childIdx(blocks[j]) >= targetOff) return flatPos;
      flatPos += blockText(blocks[j]).length;
    }
  }
  return flatPos;
}

export function flatOffsetFromSelection(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return 0;
  return flatOffsetAt(el, range.startContainer, range.startOffset);
}

/** DOM position for a flat offset inside one block. */
function domPosInBlock(block, localOffset) {
  if (block.nodeType === 3) return { node: block, offset: Math.min(localOffset, block.textContent.length) };

  if (localOffset === 0) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ALL, null, false);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) return { node: n, offset: 0 };
      if (n.nodeName === "BR") return { node: n.parentNode, offset: childIdx(n) };
    }
    return { node: block, offset: 0 };
  }

  let remaining = localOffset;
  let result = null;
  const walk = (container) => {
    if (result) return;
    let child = container.firstChild;
    while (child && !result) {
      if (child.nodeType === 3) {
        if (remaining <= child.textContent.length) { result = { node: child, offset: remaining }; return; }
        remaining -= child.textContent.length;
      } else if (child.nodeName === "BR") {
        if (!isPlaceholderBR(child)) {
          if (remaining === 0) { result = { node: child.parentNode, offset: childIdx(child) }; return; }
          remaining--;
          if (remaining === 0) { result = { node: child.parentNode, offset: childIdx(child) + 1 }; return; }
        }
      } else if (child.nodeType === 1) {
        walk(child);
      }
      child = child.nextSibling;
    }
  };
  walk(block);
  if (result) return result;

  // Past the end of the block.
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
  let last = null;
  let node;
  while ((node = walker.nextNode())) last = node;
  if (last) return { node: last, offset: last.textContent.length };
  return { node: block, offset: block.childNodes.length };
}

/** DOM position for a flat offset across the whole element. */
export function selectionFromFlatOffset(el, offset) {
  // An unbreakable element's boundaries are OUTSIDE it. A selection endpoint placed
  // inside a non-editable element is normalized by execCommand in a way that deletes
  // the editable text BEFORE the chip instead of the chip — measured, not guessed:
  // selecting [end-of-previous-text, one char into the chip] removed the text and kept
  // the chip. Ending at its element boundary instead is what `x` means.
  for (const span of atomicSpans(el)) {
    if (offset === span.start) return { node: span.node.parentNode, offset: childIdx(span.node) };
    if (offset === span.end) return { node: span.node.parentNode, offset: childIdx(span.node) + 1 };
  }

  const blocks = getBlocks(el);
  if (offset <= 0 && blocks.length > 0) return domPosInBlock(blocks[0], 0);

  let flatPos = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) flatPos++;
    const block = blocks[i];
    const len = blockText(block).length;
    if (offset <= flatPos + len) return domPosInBlock(block, offset - flatPos);
    flatPos += len;
  }
  if (blocks.length) {
    const last = blocks[blocks.length - 1];
    return domPosInBlock(last, blockText(last).length);
  }
  return { node: el, offset: 0 };
}

export function setCursorAt(el, flatOffset) {
  const point = selectionFromFlatOffset(el, flatOffset);
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function setSelectionRange(el, start, end) {
  const p1 = selectionFromFlatOffset(el, start);
  const p2 = selectionFromFlatOffset(el, end);
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(p1.node, p1.offset);
  range.setEnd(p2.node, p2.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Show the engine's selection in the host, direction included.
 *
 * Deliberately NOT `setSelectionRange` above: that one is the EDIT primitive (`deleteRange`
 * uses it, and its ordered `addRange` is what stops an atomic chip from being
 * half-deleted). This one is only for painting, so it must be able to say which end is the
 * head — `o` and a leftward drag put the head BEFORE the anchor, and only
 * `setBaseAndExtent` can express that.
 */
export function projectRange(el, anchorFlat, focusFlat) {
  const a = selectionFromFlatOffset(el, anchorFlat);
  const f = selectionFromFlatOffset(el, focusFlat);
  const sel = window.getSelection();
  if (!sel) return;
  if (typeof sel.setBaseAndExtent === "function") {
    try {
      sel.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
      return;
    } catch { /* a host that refuses the node pair: fall through to an ordered range */ }
  }
  // No direction on this host: the span is still right, only the head is implied.
  const lo = selectionFromFlatOffset(el, Math.min(anchorFlat, focusFlat));
  const hi = selectionFromFlatOffset(el, Math.max(anchorFlat, focusFlat));
  const range = document.createRange();
  range.setStart(lo.node, lo.offset);
  range.setEnd(hi.node, hi.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

function execCmd(cmd, value) {
  try {
    return document.execCommand(cmd, false, value);
  } catch {
    return false;
  }
}

/** True when the document holds something a plain text rewrite would destroy. */
export function hasAtomicContent(el) {
  return !!el.querySelector('[contenteditable="false"], [data-mention], img');
}

/**
 * Delete [from, to) through the browser's own editing command.
 *
 * One ranged `execCommand("delete")` empties the span in the DOM, and that is all the
 * immediate check can see. What a RICH host receives is different: `beforeinput`/`input`
 * with inputType `deleteContentBackward` and no data — "backspace one character". A host
 * that keeps its own model (Lark's editor-kit) applies exactly that, one character, and
 * re-renders the rest back later; the two documents then disagree and the next keystroke
 * lands at a caret that no longer exists (measured 2026-11-24: `C` on `test` left the
 * composer holding `cbtest`).
 *
 * So delete from the TAIL, one caret-width at a time: every step is a single backward
 * delete, the one edit every editor models the way we do. A span too large to step
 * through falls back to the ranged delete, which is right for plain hosts.
 *
 * Returns false when the host refused — the caller then leaves the document alone rather
 * than rewriting it and losing whatever is in there.
 */
const DELETE_STEPS = 240;

/** Line breaks and Lark's zero-width placeholders are the host's business, not ours. */
const stripTail = (s) => s.replace(/[\s\u00a0\u200b]+$/, "");
/** Two spellings of the same text: breaks, non-breaking spaces, zero-width spaces. */
const sameText = (a, b) => a.replace(/[\u00a0]/g, " ").replace(/[\n\u200b]/g, "") ===
  b.replace(/[\u00a0]/g, " ").replace(/[\n\u200b]/g, "");

export function deleteRange(el, from, to) {
  if (to <= from) return true;
  const original = getFlatText(el);
  const expected = original.slice(0, from) + original.slice(to);
  let end = to;
  for (let step = 0; step <= to - from + 2; step++) {
    const current = getFlatText(el);
    // Exact equality only. A looser test looked done when only line breaks were left,
    // which stopped `dd` before it deleted the line's own break (buffer kept a trailing
    // newline). The step budget, not the text, decides when to stop.
    if (current === expected) return true;
    // Out of span, and what is left is only the host's empty-block placeholder (`<br>` +
    // zero-width space): the deletion DID land. Trying one more delete here is a no-op
    // that reported a finished edit as "refused" (Lark, 2026-11-24: `abcest`).
    if (end <= from && sameText(current, expected)) return true;
    const beforeLen = current.length;
    setCursorAt(el, Math.min(end, beforeLen));
    if (!execCmd("delete")) return false;
    const after = getFlatText(el);
    if (after === current) return sameText(after, expected);
    end -= Math.max(1, beforeLen - after.length);        // a mention goes as one unit
    if (end < from) break;
  }
  // Out of span to delete. If what is left is only the host's own empty-block
  // placeholder (`<br>` + zero-width space), the deletion DID land — saying "refused"
  // here aborted edits that had worked (found in Lark, 2026-11-24: `abcest`).
  if (to - from > DELETE_STEPS) {
    setSelectionRange(el, from, Math.min(to, getFlatText(el).length));
    return execCmd("delete");
  }
  return sameText(getFlatText(el), expected);
}

/**
 * Replace [from, to) with `insert` as ONE editing command.
 *
 * "Replace this selection with this text" is what a vim change command means, and
 * `execCommand("insertText", …)` over a real selection is the one edit the browser
 * reports in exactly those terms: a single `input` with `inputType: "insertText"`
 * (data "" for a pure deletion). That matters on a host with its own model: a burst of
 * `deleteContentBackward` events issued in one tick gets coalesced into a single model
 * update, so most of the deletion never reaches it (measured in Lark, 2026-11-24: seven
 * deletes landed in the DOM, its model lost one character, and `est` came back).
 *
 * Returns false when the host ignored it, so the caller can fall back to deleting
 * character by character.
 */
export function replaceRange(el, from, to, insert = "") {
  if (to <= from && !insert) return true;
  setSelectionRange(el, from, to);
  const before = getFlatText(el);
  if (!execCmd("insertText", insert || "")) return false;
  return getFlatText(el) !== before;
}

/**
 * Delete ONE character before `at` — the unit a host with its own model understands.
 *
 * `editor-kit` (Lark) applies exactly one edit per input event, and it applies the
 * `inputType` it is handed: a burst issued inside one tick collapses into a single model
 * update, and a range it cannot see is ignored entirely. A backward delete with the caret
 * before the character to remove is the one shape it applies faithfully — so the adapter
 * issues them, one per tick, from `_drain`.
 */
export function deleteBackwardAt(el, at) {
  const text = getFlatText(el);
  if (!text.length) return false;
  setCursorAt(el, Math.max(0, Math.min(at, text.length)));
  return execCmd("delete");
}

export function insertTextAt(el, offset, str) {
  setCursorAt(el, offset);
  const ok = execCmd("insertText", str);
  if (ok) setCursorAt(el, offset + str.length);
  return ok;
}

export function insertParagraphAt(el, offset) {
  setCursorAt(el, offset);
  return execCmd("insertParagraph");
}

/**
 * Flat spans of UNBREAKABLE elements (a mention chip, an image).
 *
 * They matter because `execCommand` normalizes a selection that ends inside one: given
 * a range that starts at the end of the text before a chip and ends one character into
 * the chip, Chrome deletes the TEXT and keeps the chip — the opposite of what `x` means
 * in vi, and silently wrong. So a range handed to execCommand never starts or ends
 * inside one of these.
 */
export function atomicSpans(el) {
  const spans = [];
  for (const node of el.querySelectorAll('[contenteditable="false"], [data-mention], img')) {
    const start = flatOffsetAt(el, node.parentNode, childIdx(node));
    spans.push({ start, end: start + countChars(node), node });
  }
  return spans;
}

/** Push a [from, to) range out to element boundaries, so neither end lands inside one. */
export function snapRange(el, from, to) {
  let f = from;
  let t = to;
  for (const span of atomicSpans(el)) {
    if (f > span.start && f < span.end) f = span.start;
    if (t > span.start && t < span.end) t = span.end;
  }
  return { from: f, to: Math.max(f, t) };
}

/** Where text may be inserted: never inside an unbreakable element (it goes after). */
export function snapInsert(el, offset) {
  for (const span of atomicSpans(el)) {
    if (offset > span.start && offset < span.end) return span.end;
  }
  return offset;
}

/** Client rect of the caret cell at `offset` — the block cursor's box. */
export function caretRect(el, offset) {
  const start = selectionFromFlatOffset(el, offset);
  const end = selectionFromFlatOffset(el, offset + 1);
  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    if (end) range.setEnd(end.node, end.offset);
    else range.collapse(true);
    let rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      const collapsed = document.createRange();
      collapsed.setStart(start.node, start.offset);
      collapsed.collapse(true);
      rect = collapsed.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { left: rect.left, top: rect.top, width: 0, height: rect.height || parseFloat(cs.lineHeight) || 16 };
    }
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  } catch {
    return null;
  }
}

/** Client rects covering [from, to), one per screen line. */
export function rangeRects(el, from, to, { linewise = false } = {}) {
  const start = selectionFromFlatOffset(el, from);
  const end = selectionFromFlatOffset(el, to);
  const box = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const padRight = parseFloat(cs.paddingRight) || 0;
  const lineHeight = parseFloat(cs.lineHeight) || 16;
  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const out = [];
    for (const r of range.getClientRects()) {
      if (r.width <= 0) continue;
      if (r.bottom < box.top || r.top > box.bottom) continue;
      out.push({
        left: r.left,
        top: r.top,
        width: linewise ? Math.max(r.width, box.right - padRight - r.left) : r.width,
        height: r.height || lineHeight,
      });
    }
    return out;
  } catch {
    return [];
  }
}
