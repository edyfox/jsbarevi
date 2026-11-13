// Adapter for contenteditable hosts: the composer in a chat app, a rich comment box,
// `role="textbox"` editors.
//
// The DOM work lives in contenteditable-dom.js — ported from Input Vim, which had
// already solved the flat-text model, the offset ⇄ DOM-position maps and the
// execCommand edits across six hosts. What is OURS here is the part that is about the
// engine rather than the DOM: keys, modes, the caret/highlight overlay, and turning a
// whole-buffer change into the smallest possible host edit.
//
// The two host differences this adapter exists for:
//   * the host owns a DOCUMENT, so an edit must be surgical. We diff the engine's new
//     buffer against what we last read and apply only the changed span, through the
//     selection and execCommand, so chips and inline marks survive and the host's own
//     undo stack stays coherent.
//   * the host may have its OWN key handling (a composer that sends on Enter). Our
//     keydown listener is on the document in the capture phase, and a consumed key
//     stops immediate propagation — otherwise `j` would also navigate and Enter would
//     also send.

import { Engine, Mode } from "../engine/engine.js";
import { fromField } from "../engine/buffer.js";
import { BlockCaret } from "./caret.js";
import { SelectionHighlight } from "./highlight.js";
import { attachSession } from "./session.js";
import { tokenFor } from "./keys.js";
import {
  getFlatText, flatOffsetAt, flatOffsetFromSelection, setCursorAt,
  deleteRange, insertTextAt, caretRect, rangeRects, snapRange, snapInsert,
} from "./contenteditable-dom.js";

/** Longest common prefix/suffix, i.e. the smallest edit between two buffers. */
export function diffRange(prev, next) {
  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev[start] === next[start]) start++;
  let end = 0;
  while (end < max - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++;
  return { from: start, to: prev.length - end, insert: next.slice(start, next.length - end) };
}

export class ContenteditableAdapter {
  constructor(el, opts = {}) {
    this.el = el;
    this.engine = new Engine({
      viewport: () => this.viewport(),
      metrics: (offset) => this.metricsFor(offset),
      // Image-based notes wrapped? These hosts use white-space: pre-wrap, so the row
      // model applies and hscroll stays unused.
      hscroll: () => null,
      onStatus: (msg, kind) => this.onStatus?.(msg, kind),
      onScroll: (line) => this.scrollToLine(line),
      describeBuffer: () => opts.describeBuffer?.() ?? this.describe(),
      session: opts.session ?? null,
      version: opts.version,
      options: opts.options,
    });
    this.onStatus = opts.onStatus;
    this.onModeChange = opts.onModeChange;
    this.onPrompt = opts.onPrompt;
    this.onKeyConsumed = opts.onKeyConsumed;
    this._keysDispatchedByHost = !!opts.keysDispatchedByHost;
    this.caret = opts.caret === false ? null : new BlockCaret(el, { enabled: opts.caret !== false });
    this.highlight = new SelectionHighlight(el);

    this._lastText = getFlatText(el);
    // Text → the host's own DOM for that text. A text diff cannot re-create an
    // element, so restoring a state that still exists as markup (vim's u and redo)
    // puts the markup back instead. Same idea as Input Vim's innerHTML undo stack,
    // scoped to what we need: the states we have actually seen.
    this._snaps = [];
    this._expectedOffset = null;
    this._mouseDown = false;
    this._beforeClick = null;
    this._typing = false;

    this._bound = {
      // Keydown on the DOCUMENT in the capture phase: the host's own handler may be
      // registered on the element, and anything registered later on the same node
      // runs after it. Capture on the document always runs first.
      keydown: (e) => this._onKeydown(e),
      input: () => this._onInput(),
      mouseup: (e) => this._onMouseUp(e),
      mousedown: (e) => this._onMouseDown(e),
      selectionchange: () => this._onSelectionChange(),
      contextmenu: (e) => this._onContextMenu(e),
      blur: () => this._onBlur(),
      focus: () => this._emitMode(),
      scroll: () => this._updateCaret(),
      resize: () => { this.highlight.invalidate(); this._updateCaret(); },
    };
    // WINDOW capture, not document: a host's own key driver listens on window and runs
    // before anything on document — which is exactly how an app handles Escape first.
    // Skipped when the extension dispatches keys to us (see textarea.js: two listeners
    // mean every key twice, and `d` twice is `dd`).
    if (!opts.keysDispatchedByHost) window.addEventListener("keydown", this._bound.keydown, true);
    el.addEventListener("input", this._bound.input);
    el.addEventListener("contextmenu", this._bound.contextmenu);
    el.addEventListener("blur", this._bound.blur);
    el.addEventListener("focus", this._bound.focus);
    el.addEventListener("scroll", this._bound.scroll);
    document.addEventListener("mouseup", this._bound.mouseup, true);
    document.addEventListener("mousedown", this._bound.mousedown, true);
    document.addEventListener("selectionchange", this._bound.selectionchange);
    window.addEventListener("resize", this._bound.resize);
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this._bound.resize());
      this._resizeObserver.observe(el);
    }

    attachSession(this, this.engine, opts);

    this.syncFromHost();
    this._emitMode();
  }

  destroy() {
    if (!this._keysDispatchedByHost) window.removeEventListener("keydown", this._bound.keydown, true);
    this.el.removeEventListener("input", this._bound.input);
    this.el.removeEventListener("contextmenu", this._bound.contextmenu);
    this.el.removeEventListener("blur", this._bound.blur);
    this.el.removeEventListener("focus", this._bound.focus);
    this.el.removeEventListener("scroll", this._bound.scroll);
    document.removeEventListener("mouseup", this._bound.mouseup, true);
    document.removeEventListener("mousedown", this._bound.mousedown, true);
    document.removeEventListener("selectionchange", this._bound.selectionchange);
    window.removeEventListener("resize", this._bound.resize);
    this._resizeObserver?.disconnect();
    this.caret?.destroy();
    this.highlight?.destroy();
  }

  describe() {
    const hint = this.el.getAttribute("aria-label") || this.el.className || "editable";
    return `contenteditable: ${String(hint).slice(0, 40)}`;
  }

  /** These hosts wrap (`white-space: pre-wrap`), so screen rows are real rows. */
  wraps() { return true; }

  // -------------------------------------------------------------------------
  // host → engine
  // -------------------------------------------------------------------------

  syncFromHost() {
    const text = getFlatText(this.el);
    const offset = flatOffsetFromSelection(this.el);
    this.engine.applyHostEdit(fromField(text), offset);
    if (this.engine.hostText !== text) this._commit();
    else { this._lastText = text; this._updateCaret(); }
  }

  _onInput() {
    if (this._typing) return;
    this.syncFromHost();
  }

  /** Flat offsets of both ends of the host selection, or null when it is elsewhere. */
  _selection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.el.contains(range.startContainer)) return null;
    return {
      anchor: flatOffsetAt(this.el, sel.anchorNode, sel.anchorOffset),
      focus: flatOffsetAt(this.el, sel.focusNode, sel.focusOffset),
      collapsed: range.collapsed,
      button: null,
    };
  }

  _onSelectionChange() {
    if (document.activeElement !== this.el) return;
    if (this.engine.prompt || this._mouseDown) return;
    const sel = this._selection();
    if (!sel) return;

    if (sel.collapsed) {
      if (sel.focus === this._expectedOffset) return;    // our own write echoing back
      this._expectedOffset = null;
      if (this.engine.mode === Mode.INSERT) {
        // While inserting, the host's insertion point IS the model.
        this.engine.setText(fromField(getFlatText(this.el)), sel.focus);
        this._lastText = this.engine.hostText;
        return;
      }
      this.engine.setCursorFromHost(sel.focus);
      this._writeSelection();
      this._updateCaret();
      return;
    }

    // A selection the host makes IS visual mode — same rule as the textarea adapter,
    // so a mouse drag or Shift+arrow means the same thing in both.
    const [anchor, head] = sel.anchor <= sel.focus
      ? [sel.anchor, sel.focus - 1]
      : [sel.anchor - 1, sel.focus];
    this.engine.enterVisualFromHost(anchor, head);
    this._lastText = getFlatText(this.el);
    this._commit();
    this._emitMode();
  }

  _onMouseDown(e) {
    const target = e.composedPath?.()[0] ?? e.target;
    if (!(target === this.el || this.el.contains(target))) return;
    this._mouseDown = true;
    this._beforeClick = {
      cursor: this.engine.cursor,
      mode: this.engine.mode,
      anchor: this.engine.visual ? this.engine.visual.anchor : this.engine.cursor,
    };
  }

  _onMouseUp(e) {
    const inside = this.el.contains(e.target) || document.activeElement === this.el;
    this._mouseDown = false;
    if (!inside) return;
    // Deferred by a tick: the browser finishes updating the selection after the event,
    // which is the same reason Input Vim's mouseup handler defers.
    setTimeout(() => {
      if (document.activeElement !== this.el || this.engine.prompt) return;
      const sel = this._selection();
      if (!sel) return;
      this._lastText = getFlatText(this.el);
      const before = this._beforeClick;

      if (this.engine.mode === Mode.INSERT) {
        this.engine.setText(fromField(this._lastText), sel.focus);
        this._emitMode();
        return;
      }
      if (e.button === 2 && before && (before.mode === Mode.VISUAL || before.mode === Mode.VISUAL_LINE)) {
        this.engine.extendVisualToClick(sel.focus, before.anchor, before.cursor);
      } else if (e.shiftKey && sel.collapsed && before) {
        if (before.mode === Mode.VISUAL || before.mode === Mode.VISUAL_LINE) {
          this.engine.extendVisualToClick(sel.focus, before.anchor, before.cursor);
        } else {
          this.engine.enterVisualFromHost(before.cursor, sel.focus);
        }
      } else if (!sel.collapsed) {
        const [anchor, head] = sel.anchor <= sel.focus
          ? [sel.anchor, sel.focus - 1]
          : [sel.anchor - 1, sel.focus];
        this.engine.enterVisualFromHost(anchor, head);
      } else {
        // A bare click ends visual mode (vim's rule, mouse.c:769).
        if (this.engine.mode === Mode.VISUAL || this.engine.mode === Mode.VISUAL_LINE) {
          this.engine.mode = Mode.NORMAL;
          this.engine.visual = null;
        }
        this.engine.setCursorFromHost(sel.focus);
      }
      this._commit();
      this._emitMode();
    }, 0);
  }

  _onContextMenu(e) {
    if (this.engine.mode !== Mode.VISUAL && this.engine.mode !== Mode.VISUAL_LINE) return;
    e.preventDefault();
  }

  _onBlur() {
    const active = document.activeElement;
    if (this.engine.prompt || active?.classList?.contains("jsbarevi-prompt")) return;
    this.engine.reset();
    this.caret?.hide();
    this.highlight.clear();
    this.onModeChange?.(this.engine.mode, "");
  }

  // -------------------------------------------------------------------------
  // keys
  // -------------------------------------------------------------------------

  _onKeydown(e) {
    const target = e.composedPath?.()[0] ?? e.target;
    if (!(target === this.el || this.el.contains(target))) return;
    // See textarea.js: the composition guard belongs to insert mode only, otherwise a
    // stale isComposing flag eats one keystroke after every Escape.
    if (e.isComposing && (this.engine.mode === Mode.INSERT || this.engine.replaceSession)) {
      this.onKeyConsumed?.("composing");
      return;
    }
    const key = tokenFor(e, this.engine.mode);
    if (key == null) return;

    if (key === "C-c") {
      const text = this.engine.visualText();
      if (text) {
        e.preventDefault();
        e.stopImmediatePropagation();
        navigator.clipboard?.writeText(text).catch(() => {});
        this.onStatus?.(`copied ${text.length} chars`);
        return;
      }
    }

    const r = this.engine.feed(key);
    this._emitMode();

    if (r.prompt) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.onPrompt?.(r.prompt.kind, r.prompt.initial ?? "");
      return;
    }
    if (!r.handled) return;                           // insert mode: the host types
    this.onKeyConsumed?.(key);

    // preventDefault AND stopImmediatePropagation: the host's own keymap must not
    // also act on a key the engine just consumed. In a plain textarea there is
    // nothing to suppress; in a composer this is the difference between `j` moving
    // and `j` navigating, or Enter moving a line and Enter sending the message.
    e.preventDefault();
    e.stopImmediatePropagation();
    this._commit();
  }

  finishPrompt(kind, value) {
    this.engine.prompt = kind === "ex" ? "ex" : kind === "search" ? "search" : null;
    this.engine.submitPrompt(value);
    this._commit();
    this._emitMode();
  }

  cancelPrompt() {
    this.engine.prompt = null;
    this._emitMode();
  }

  // -------------------------------------------------------------------------
  // engine → host
  // -------------------------------------------------------------------------

  /** Write the engine's buffer back, touching only the span that changed. */
  _commit() {
    const next = this.engine.hostText;
    const prev = this._lastText;
    if (next !== prev) {
      const html = this.el.innerHTML;
      const restore = this._snaps.find((s) => s.text === next && s.html !== html);
      if (restore) {
        // An exact restoration (vim's u, or a redo): put the host's own markup back so
        // chips and inline marks survive. A text diff cannot re-create an element, and
        // undoing a deleted mention into plain text would be a lie about the document.
        this.el.innerHTML = restore.html;
        this._lastText = next;
        this._dispatchInput();
      } else {
        const { from, to, insert } = diffRange(prev, next);
        if (!this._applyEdit(from, to, insert)) {
          // The host refused. Do not rewrite its document to force the point: re-read
          // what is really there and say so.
          this._lastText = getFlatText(this.el);
          this.engine.setText(fromField(this._lastText), Math.min(this.engine.cursor, this._lastText.length));
          this.onStatus?.("this editor refused the edit", "error");
          return;
        }
        const actual = getFlatText(this.el);
        if (actual !== next) {
          // The host's own atomicity: deleting part of an unbreakable element removed
          // the whole element. Adopt what really happened instead of insisting.
          this.engine.setText(fromField(actual), Math.min(from, Math.max(0, actual.length - 1)));
          this.onStatus?.("the host removed more than the command asked for (an unbreakable element)", "error");
        }
        this._lastText = this.engine.hostText;
        this._dispatchInput();
      }
      this._remember(prev, html);
    }
    this._writeSelection();
    this._updateCaret();
  }

  _remember(text, html) {
    if (this._snaps.some((s) => s.text === text && s.html === html)) return;
    this._snaps.push({ text, html });
    if (this._snaps.length > 40) this._snaps.shift();
  }

  _applyEdit(from, to, insert) {
    try {
      let at = from;
      if (to > from) {
        // A deletion never half-covers an unbreakable element: `x` on a mention deletes
        // the whole mention, because that is the only thing the host can do.
        const range = snapRange(this.el, from, to);
        at = range.from;
        if (!deleteRange(this.el, range.from, range.to)) return false;
      }
      if (insert) {
        at = snapInsert(this.el, at);
        if (!insertTextAt(this.el, at, insert)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Tell the host its document changed.
   *
   * A textarea needs nothing here (its value IS the state). A rich composer keeps its
   * own model and rebuilds it from the DOM on `input`; without this event the engine
   * would edit the screen while the host sent the old text.
   */
  _dispatchInput() {
    this._typing = true;
    try {
      this.el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    } catch {
      this.el.dispatchEvent(new Event("input", { bubbles: true }));
    } finally {
      this._typing = false;
    }
  }

  /** Collapse the native selection onto the engine cursor, remembering that we did. */
  _writeSelection() {
    const offset = Math.min(this.engine.cursor, getFlatText(this.el).length);
    const current = flatOffsetFromSelection(this.el);
    const sel = window.getSelection();
    if (sel?.isCollapsed && current === offset && document.activeElement === this.el) {
      this._expectedOffset = offset;
      return;
    }
    setCursorAt(this.el, offset);
    this._expectedOffset = offset;
  }

  _emitMode() {
    const replace = !!this.engine.replaceSession;
    const label = replace ? "REPLACE" : this.engine.mode;
    this.onModeChange?.(label, this.engine.pending?.count || "");
    const focused = document.activeElement === this.el;
    const beam = this.engine.mode === Mode.INSERT && !replace;
    if (beam || !focused) { this.caret?.hide(); this.highlight.clear(); }
    else this._updateCaret();
  }

  _updateCaret() {
    if (document.activeElement !== this.el) { this.caret?.hide(); this.highlight.clear(); return; }
    if (this.engine.mode === Mode.INSERT && !this.engine.replaceSession) {
      this.caret?.hide();
      this.highlight.clear();
      return;
    }
    const linewise = this.engine.mode === Mode.VISUAL_LINE;
    this._scrollToCaret();
    this.caret?.update(this.engine.cursor, { linewise, rect: caretRect(this.el, this.engine.cursor) });
    const sel = this.engine.visualSelection();
    if (sel) this.highlight.paint(rangeRects(this.el, sel.from, sel.to, { linewise }));
    else this.highlight.clear();
  }

  /** Bring the cursor back into the host's viewport, like vim never letting it leave. */
  _scrollToCaret() {
    const rect = caretRect(this.el, this.engine.cursor);
    if (!rect) return;
    const box = this.el.getBoundingClientRect();
    if (rect.top < box.top) this.el.scrollTop -= box.top - rect.top;
    else if (rect.top + rect.height > box.bottom) this.el.scrollTop += rect.top + rect.height - box.bottom;
  }

  /** Content-space position of the character at `offset`, for screen-line questions. */
  metricsFor(offset) {
    const rect = caretRect(this.el, offset);
    if (!rect) return null;
    const box = this.el.getBoundingClientRect();
    const cs = getComputedStyle(this.el);
    return {
      x: rect.left - box.left - (parseFloat(cs.paddingLeft) || 0),
      y: rect.top - box.top - (parseFloat(cs.paddingTop) || 0),
      width: rect.width,
      height: rect.height,
    };
  }

  viewport() {
    const cs = getComputedStyle(this.el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
    const height = Math.max(1, Math.floor(this.el.clientHeight / lh));
    return { top: Math.max(0, Math.floor(this.el.scrollTop / lh)), height };
  }

  scrollToLine(line) {
    const cs = getComputedStyle(this.el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
    this.el.scrollTop = Math.max(0, line * lh);
  }
}

export { Mode };
