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
 * Returns false when the host refused — the caller then leaves the document alone
 * rather than rewriting it and losing whatever is in there.
 */
export function deleteRange(el, from, to) {
  setSelectionRange(el, from, to);
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
