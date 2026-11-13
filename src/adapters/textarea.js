// Adapter for <textarea> and single-line <input>.
//
// The engine owns NORMAL and VISUAL mode; the host owns INSERT mode, IME, paste
// and the browser's own undo. So this adapter:
//   * intercepts keys only when the engine says it handled them
//   * lets the browser type while the engine is in INSERT
//   * re-syncs the engine's text/cursor from the element after any input
//   * commits engine text back with a minimal DOM write
//
// Two rules decide who owns the caret, both adapted from Input Vim (MIT - see
// NOTICE), which solves the same problem across six hosts:
//
//   1. Keys that move a caret and that vi also has (arrows, Home, End, PageUp,
//      PageDown) belong to the ENGINE outside insert mode, so the model never
//      has to be guessed back out of the DOM. In insert mode they stay native.
//   2. The MOUSE belongs to the HOST. A click is a caret move we adopt; a drag
//      is a selection we adopt as visual mode. That is Input Vim's mouseup
//      handler (cursor-controller.js) plus getMouseSelection
//      (handlers/input-handler.js), including the exclusive-end adjustment that
//      turns a DOM selection back into an anchor/head pair, and
//      clampCursorToLine for a caret the DOM allows and vi does not.

import { Engine, Mode } from "../engine/engine.js";
import * as B from "../engine/buffer.js";
import { fromField } from "../engine/buffer.js";
import { BlockCaret } from "./caret.js";
import { attachSession } from "./session.js";
import { tokenFor } from "./keys.js";
import { SelectionHighlight } from "./highlight.js";

export class TextareaAdapter {
  constructor(el, opts = {}) {
    this.el = el;
    this.engine = new Engine({
      viewport: () => this.viewport(),
      // Screen lines need measurement only WHEN the field wraps. A field that does not
      // wrap (an <input>, or a <textarea> with white-space:pre/nowrap and horizontal
      // scrolling) has exactly one screen row per buffer line, so the answer is
      // arithmetic - see metricsFor().
      metrics: (offset) => this.metricsFor(offset),
      // g0/g$/g^ are relative to the visible COLUMN window when the field scrolls
      // horizontally instead of wrapping; null when it wraps (the row model covers it).
      hscroll: () => this.hscrollWindow(),
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
    // A hairline caret is invisible as a vi cursor: normal/visual get a block.
    this.caret = opts.caret === false ? null : new BlockCaret(el, { enabled: opts.caret !== false });
    this.highlight = new SelectionHighlight(el);
    // Set while we are writing the selection ourselves: a `selectionchange` event
    // cannot tell our own write from the user moving the caret, so we record the
    // caret we asked for and ignore the echo.
    this._expectedCaret = null;
    this._mouseDown = false;
    this._beforeClick = null;
    this._bound = {
      keydown: (e) => this._onKeydown(e),
      input: () => this.syncFromHost(),
      mouseup: (e) => this._onMouseUp(e),
      contextmenu: (e) => this._onContextMenu(e),
      mousedown: (e) => { if (this.el.contains(e.target)) { this._mouseDown = true; this._rememberBeforeClick(); } },
      selectionchange: () => this._onSelectionChange(),
      // Only the focused field may show a caret or a highlight: two fields on one
      // page must not both look active.
      // Focusing the prompt moves focus off the field, which is NOT losing the
      // field: resetting here would make the engine forget it owns a prompt.
      blur: () => {
        const inPrompt = document.activeElement?.classList?.contains("jsbarevi-prompt");
        if (this.engine.prompt || inPrompt) return;
        // A blur can be the ONLY exit we ever see (another extension or a host key
        // driver may take the Escape keydown). Leave insert through the engine's own
        // path so the cursor still steps one character left, as vim does — a bare
        // reset leaves it at the insertion point, which draws the block on the
        // character AFTER the beam.
        if (this.engine.mode === Mode.INSERT || this.engine.replaceSession) this.engine.feed("Esc");
        this.engine.reset();
        this.caret?.hide();
        this.highlight.clear();
        this.onModeChange?.(this.engine.mode, "");
      },
      focus: () => { this.el.style.caretColor = ""; this._emitMode(); },
    };
    this._bound.scroll = () => this._updateCaret();
    this._bound.resize = () => { this.caret?.invalidate(); this.highlight.invalidate(); this._updateCaret(); };
    // WINDOW capture, not document: a host's own key driver listens on window and runs
    // before anything on document.
    //
    // Skipped when the HOST dispatches keys to us (`opts.keysDispatchedByHost`): the
    // extension registers one listener at document_start — before any page script — and
    // routes each key to the owning adapter. Registering here as well would run every
    // key twice, and `d` twice is `dd`: it deleted a whole line instead of a word.
    if (!opts.keysDispatchedByHost) window.addEventListener("keydown", this._bound.keydown, true);
    el.addEventListener("input", this._bound.input);
    el.addEventListener("blur", this._bound.blur);
    el.addEventListener("focus", this._bound.focus);
    el.addEventListener("scroll", this._bound.scroll);
    el.addEventListener("contextmenu", this._bound.contextmenu);
    // Capture phase, on the document, like Input Vim: the caret has already moved
    // by the time these fire, and a host page may stop propagation lower down.
    document.addEventListener("mouseup", this._bound.mouseup, true);
    document.addEventListener("mousedown", this._bound.mousedown, true);
    document.addEventListener("selectionchange", this._bound.selectionchange);
    window.addEventListener("resize", this._bound.resize);
    // A container can resize the field without a window resize (flex layout,
    // sidebar toggling, devtools opening), and a stale mirror measures wrapped
    // text in the wrong coordinate space - which draws the block at the row's
    // right edge instead of its start.
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this._bound.resize());
      this._resizeObserver.observe(el);
    }
    // `:e` — one transport rule for every adapter; see session.js.
    attachSession(this, this.engine, opts);
    this.syncFromHost();
    this.engine.setText(this.el.value, this.el.selectionStart ?? 0);
    // PORTED FROM INPUT VIM (settings.getStartMode / activate): a field can start in
    // INSERT, which is what a browser input normally feels like — click it and type.
    // The default here stays NORMAL; the extension passes "insert" (see content.js).
    if (opts.startMode === "insert") {
      this.engine.mode = Mode.INSERT;
      this.engine.insertEntry = null;
      this._writeSelection();
    }
    this._emitMode();
  }

  destroy() {
    if (!this._keysDispatchedByHost) window.removeEventListener("keydown", this._bound.keydown, true);
    this.el.removeEventListener("input", this._bound.input);
    this.el.removeEventListener("blur", this._bound.blur);
    this.el.removeEventListener("focus", this._bound.focus);
    this.el.removeEventListener("scroll", this._bound.scroll);
    this.el.removeEventListener("contextmenu", this._bound.contextmenu);
    document.removeEventListener("mouseup", this._bound.mouseup, true);
    document.removeEventListener("mousedown", this._bound.mousedown, true);
    document.removeEventListener("selectionchange", this._bound.selectionchange);
    window.removeEventListener("resize", this._bound.resize);
    this._resizeObserver?.disconnect();
    this.el.style.caretColor = "";
    this.caret?.destroy();
    this.highlight?.destroy();
  }

  /**
   * Does this field wrap at all? An <input> renders one line, and a <textarea> only
   * wraps when white-space allows it - `pre` and `nowrap` scroll horizontally instead.
   */
  wraps() {
    if (this.el.tagName === "INPUT") return false;
    const ws = getComputedStyle(this.el).whiteSpace;
    return ws === "normal" || ws === "pre-wrap" || ws === "pre-line" || ws === "break-spaces";
  }

  /**
   * The character range visible in a horizontally scrolled, non-wrapping field, as
   * buffer offsets on the CURSOR's line - so `g0` goes to the first character on
   * screen, `g$` to the last one on screen, and `g^` to the first non-blank between
   * them, which is what vim does when 'wrap' is off (`:help g0`: "when 'wrap' is off,
   * this goes to the first character of the display line").
   *
   * Null when the field wraps: there the screen line is a wrapped row, which the row
   * model already answers.
   */
  hscrollWindow() {
    if (this.wraps() || !this.caret) return null;
    const el = this.el;
    const t = this.engine.text;
    const cur = Math.max(0, Math.min(this.engine.cursor, Math.max(0, t.length - 1)));
    const start = B.lineStart(t, cur);
    const end = B.lastCharOffset(t, cur);
    if (end <= start) return null;
    const xAt = (off) => this.caret.contentPoint(off).x;
    // scrollLeft is in the same space as the mirror's x, and the visible slice is
    // [scrollLeft, scrollLeft + the CONTENT width] - clientWidth includes the padding,
    // which made g$ land about 20px (three characters) past the right edge.
    const cs = getComputedStyle(el);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const visibleWidth = Math.max(1, el.clientWidth - padL - padR);
    // scrollLeft counts from the PADDING edge, while the mirror's x is measured from the
    // CONTENT edge - so the visible content window is [scrollLeft - padL, + width].
    // Without the padL shift the window sits one to two characters too far right
    // (reported from the field: g0 was +1, g$ was +2).
    const leftEdge = el.scrollLeft - padL;
    const left = this._offsetAtX(start, end, leftEdge, xAt, false);
    const right = this._offsetAtX(start, end, leftEdge + visibleWidth, xAt, true);
    return { from: left, to: Math.max(left, right) };
  }

  /** First (or last) offset in [start, end] whose content x is at `x`. */
  _offsetAtX(start, end, x, xAt, last) {
    let lo = start;
    let hi = end;
    if (last) {
      // largest offset with x <= target
      while (lo < hi) {
        const mid = lo + ((hi - lo + 1) >> 1);
        if (xAt(mid) <= x) lo = mid; else hi = mid - 1;
      }
      return lo;
    }
    // smallest offset with x >= target
    while (lo < hi) {
      const mid = lo + ((hi - lo) >> 1);
      if (xAt(mid) < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /**
   * Row/column space for the engine's screen-line questions.
   *
   * When the field does NOT wrap, a buffer line IS a screen row: the row is the line
   * number, the column is the character's index in the line, and the unit height is 1.
   * That is exact (no measurement can be wrong) and free (no mirror, no Range, no
   * layout flush) - and with it `gj`/`gk`/`g0`/`g$`/`H`/`M`/`L`/`C-f`/`C-b` all reduce to
   * their buffer-line equivalents by construction, which is what they should be.
   *
   * When it does wrap, only the host knows where the wrap lands, so the caret mirror
   * answers in content pixels.
   */
  metricsFor(offset) {
    if (this.wraps()) return this.caret?.contentPoint(offset) ?? null;
    const t = this.engine.text;
    const at = Math.max(0, Math.min(offset, Math.max(0, t.length - 1)));
    const line = B.lineNumber(t, at);
    return { x: at - B.lineStart(t, at), y: line, width: 1, height: 1 };
  }

  describe() {
    const tag = this.el.tagName.toLowerCase();
    const hint = this.el.getAttribute("aria-label") || this.el.className || "unnamed";
    return `${tag}: ${String(hint).slice(0, 40)}`;
  }

  syncFromHost() {
    // applyHostEdit, not setText: in replace mode the engine has to drop what the
    // browser overwrote, so the field can differ from what the host typed.
    // fromField: a field value ending in a newline has an EMPTY LAST LINE, which
    // the buffer's line-terminated model only sees if one more newline follows.
    this.engine.applyHostEdit(fromField(this.el.value), this.el.selectionStart ?? 0);
    if (this.engine.hostText !== this.el.value) this._commit();
    else this._updateCaret();
  }

  /**
   * The host moved its caret without producing input: a mouse click, an IME
   * caret jump, an arrow key in insert mode, or a Shift+arrow selection. Two
   * outcomes, and the rule that unifies them is that **a selection the host
   * creates IS visual mode**: guessing back out of the DOM is what makes native
   * selection and visual mode fight over the same pixels.
   */
  _onSelectionChange() {
    if (document.activeElement !== this.el) return;
    if (this.engine.prompt) return;
    const start = this.el.selectionStart ?? 0;
    const end = this.el.selectionEnd ?? start;
    if (start === this._expectedCaret && end === this._expectedCaret) return; // our own write
    if (start !== end) {
      // A live drag owns the selection until it is released: collapsing it now
      // would break the drag. Everything else (Shift+arrow, a selection made by
      // the page) is adopted immediately.
      if (this._mouseDown) return;
      const sel = this._selectionFromHost(start, end);
      this.engine.enterVisualFromHost(sel.anchor, sel.head);
      // Collapse the host selection and let the overlay paint it, so exactly one
      // of the two is ever visible.
      this._commit();
      this._emitMode();
      return;
    }
    if (this.engine.mode === Mode.INSERT) {
      // While inserting the host's insertion point IS the model.
      this.engine.setText(fromField(this.el.value), start);
      return;
    }
    const before = this.engine.cursor;
    this.engine.setCursorFromHost(start);
    this._writeSelection();
    if (this.engine.cursor !== before) this._updateCaret();
  }

  /**
   * A mouse release ends a click (a caret move) or a drag (a selection). Deferred
   * by a tick because Chrome finishes updating the selection after the event -
   * Input Vim's mouseup handler defers for the same reason. In insert mode the
   * native caret is authoritative, so the model just follows it.
   */
  _onMouseUp(e) {
    const inside = this.el.contains(e.target) || document.activeElement === this.el;
    this._mouseDown = false;
    if (!inside) return;
    setTimeout(() => {
      if (document.activeElement !== this.el) return;
      if (this.engine.prompt) return;
      const start = this.el.selectionStart ?? 0;
      const end = this.el.selectionEnd ?? start;
      if (this.engine.mode === Mode.INSERT) {
        this.engine.setText(this.el.value, start);
        this._emitMode();
        return;
      }
      const before = this._beforeClick;
      // Right click is vim's other mouse gesture for adjusting a selection: vim
      // folds a shifted left click onto the right-button path (mouse.c:753), and
      // the right-button path is where the anchor moves to the far side. Outside
      // visual mode it is an ordinary caret move - the browser has already moved
      // the caret, and _onSelectionChange synced the model.
      if (e.button === 2) {
        if (before && (before.mode === Mode.VISUAL || before.mode === Mode.VISUAL_LINE)) {
          this.engine.extendVisualToClick(start, before.anchor, before.cursor);
        } else {
          this.engine.setCursorFromHost(start);
        }
        this._commit();
        this._emitMode();
        return;
      }
      // Shift+click: the same adjustment, plus it can start a selection.
      if (e.shiftKey && start === end && before) {
        if (before.mode === Mode.VISUAL || before.mode === Mode.VISUAL_LINE) {
          this.engine.extendVisualToClick(start, before.anchor, before.cursor);
        } else {
          this.engine.enterVisualFromHost(before.cursor, start);
        }
        this._commit();
        this._emitMode();
        return;
      }
      if (start !== end) {
        const sel = this._selectionFromHost(start, end);
        this.engine.enterVisualFromHost(sel.anchor, sel.head);
      } else {
        // A bare click ends any visual selection and puts the cursor where it
        // was clicked. Both references agree, and vim says it in one line
        // (mouse.c:769-776): a left click sets MOUSE_MAY_STOP_VIS, which calls
        // end_visual_mode_keep_button(); only a left *drag* starts visual mode.
        // Input Vim's handler does the same ("no selection - exit visual").
        if (this.engine.mode === Mode.VISUAL || this.engine.mode === Mode.VISUAL_LINE) {
          this.engine.mode = Mode.NORMAL;
          this.engine.visual = null;
        }
        this.engine.setCursorFromHost(start);
      }
      this._commit();
      this._emitMode();
    }, 0);
  }

  /**
   * Turn a DOM selection into visual anchor/head. A DOM selection is [start, end)
   * between characters and ours is two character offsets, so the live end loses
   * one - Input Vim's getMouseSelection, backward direction included so a drag
   * upwards or leftwards keeps its anchor where the drag began.
   */
  _selectionFromHost(start, end) {
    const backward = this.el.selectionDirection === "backward";
    return {
      anchor: backward ? end - 1 : start,
      head: backward ? start : end - 1,
    };
  }

  /**
   * The browser's menu is useless while WE own the selection: its Copy would copy
   * the collapsed native selection (nothing), and its Paste would bypass the
   * engine's registers and undo. So it is suppressed in visual mode only - in
   * normal mode it belongs to the host, and Esc (which leaves visual) is the
   * escape hatch to get it back.
   */
  _onContextMenu(e) {
    if (this.engine.mode !== Mode.VISUAL && this.engine.mode !== Mode.VISUAL_LINE) return;
    e.preventDefault();
  }

  /** Remember where the caret and the selection were before the click lands. */
  _rememberBeforeClick() {
    this._beforeClick = {
      cursor: this.engine.cursor,
      mode: this.engine.mode,
      anchor: this.engine.visual ? this.engine.visual.anchor : this.engine.cursor,
    };
  }

  /** Write the engine cursor back to the host caret, remembering that we did. */
  _writeSelection() {
    const c = Math.min(this.engine.cursor, this.el.value.length);
    if (this.el.selectionStart === c && this.el.selectionEnd === c) return;
    this._expectedCaret = c;
    this.el.setSelectionRange(c, c);
  }

  _emitMode() {
    // replace mode IS insert mode as far as the host is concerned (the browser
    // types), but vim shows a BLOCK there: the block marks the character about to
    // be overwritten, which is the whole point of the mode. So only plain insert
    // gets the native beam.
    const replace = !!this.engine.replaceSession;
    const label = replace ? "REPLACE" : this.engine.mode;
    this.onModeChange?.(label, this.engine.pending?.count || "");
    const focused = document.activeElement === this.el;
    const beam = this.engine.mode === Mode.INSERT && !replace;
    this.el.style.caretColor = beam || !focused ? "" : "transparent";
    if (beam || !focused) { this.caret?.hide(); this.highlight.clear(); }
    else this._updateCaret();
  }

  _updateCaret() {
    if (document.activeElement !== this.el) { this.caret?.hide(); this.highlight.clear(); return; }
    // replace mode keeps the block: it is how the mode tells you what it will eat
    if (this.engine.mode === Mode.INSERT && !this.engine.replaceSession) { this.caret?.hide(); this.highlight.clear(); return; }
    const linewise = this.engine.mode === Mode.VISUAL_LINE;
    // Scroll the field so the cursor is visible BEFORE drawing it: vim never lets the
    // cursor sit outside the window, and without this the block was drawn (and kept
    // blinking) outside the field whenever the caret was scrolled away.
    const rect = this.caret ? this._scrollToCaret(this.caret.measure(this.engine.cursor)) : null;
    this.caret?.update(this.engine.cursor, { linewise, rect });
    const sel = this.engine.visualSelection();
    if (sel) this.highlight.update(sel.from, sel.to, this.engine.text, { linewise: sel.linewise });
    else this.highlight.clear();
  }

  _onKeydown(e) {
    // Ownership: the listener is on WINDOW (capture), so every attached field sees every
    // keystroke on the page. Without this, typing into one field would also feed the
    // engine of every other attached field — including our own command line.
    const target = e.composedPath?.()[0] ?? e.target;
    if (!(target === this.el || this.el.contains(target))) return;
    // IME: never touch it — but only while the HOST owns typing. In NORMAL/VISUAL
    // there is no composition to protect, and a key flagged isComposing after an
    // Escape (Chrome keeps the flag briefly) must not be dropped: that swallows
    // exactly one keystroke, which reads as "I have to press it twice".
    if (e.isComposing && (this.engine.mode === Mode.INSERT || this.engine.replaceSession)) {
      this.onKeyConsumed?.("composing");
      return;
    }
    const key = this._token(e);
    if (key == null) return;

    if (key === "C-c") {
      const text = this.engine.visualText();
      if (text) {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard?.writeText(text).catch(() => {});
        this.onStatus?.(`copied ${text.length} chars`);
        return;
      }
    }

    const r = this.engine.feed(key);
    this._emitMode();

    if (r.prompt) {
      e.preventDefault();
      e.stopPropagation();
      this.onPrompt?.(r.prompt.kind, r.prompt.initial ?? "");
      return;
    }
    if (!r.handled) return; // insert mode: let the browser type
    // Tell the host glue which key was consumed: an Escape that the page also reacts
    // to (by moving focus) needs a follow-up, and only the adapter knows it fired.
    this.onKeyConsumed?.(key);
    e.preventDefault();
    e.stopPropagation();
    this._commit();
  }

  /** Ask the UI for a prompt line and finish it. */
  /**
   * Escape whose keydown never reached us.
   *
   * PORTED FROM INPUT VIM (event-interceptor.js): "if keydown was swallowed by the
   * page, handle Escape on keyup". Another extension (Vimium) or a host's own key
   * driver can consume the keydown and stop propagation; nobody consumes the keyup.
   * Returns true when it changed something.
   */
  handleEscape() {
    if (this.engine.mode === Mode.NORMAL && !this.engine.prompt) return false;
    const r = this.engine.feed("Esc");
    this._emitMode();
    if (r.prompt) return false;
    if (r.handled) this._commit();
    return !!r.handled;
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

  /**
   * Bring the cursor into view. Returns the (re-measured) rect, because scrolling
   * changes where the cursor is - the caller must draw at the new position, not the old.
   */
  _scrollToCaret(rect) {
    if (!rect) return null;
    const el = this.el;
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const l = box.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
    const r = box.right - (parseFloat(cs.borderRightWidth) || 0) - (parseFloat(cs.paddingRight) || 0);
    const top = box.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
    const bottom = box.bottom - (parseFloat(cs.borderBottomWidth) || 0) - (parseFloat(cs.paddingBottom) || 0);
    let dx = 0;
    let dy = 0;
    if (rect.left < l) dx = rect.left - l;
    else if (rect.left + rect.width > r) dx = rect.left + rect.width - r;
    if (rect.top < top) dy = rect.top - top;
    else if (rect.top + rect.height > bottom) dy = rect.top + rect.height - bottom;
    if (!dx && !dy) return rect;
    // Move the view by the delta we asked for and shift the rect by what the field
    // ACTUALLY scrolled (it clamps at the ends). Re-measuring here looked simpler but
    // was wrong: the browser applies its own caret-reveal scroll at the next layout, so
    // the mirror still read the old scrollLeft and the block ended up a couple of pixels
    // over the field's right edge.
    const sx = el.scrollLeft;
    const sy = el.scrollTop;
    if (dx) el.scrollLeft = sx + dx;
    if (dy) el.scrollTop = sy + dy;
    const appliedX = el.scrollLeft - sx;
    const appliedY = el.scrollTop - sy;
    return { ...rect, left: rect.left - appliedX, top: rect.top - appliedY };
  }

  _commit() {
    // hostText, not text: the engine's buffer carries a terminating newline so
    // the last line has something to end on (buffer.js). Writing it into the
    // field would append a phantom line on every command.
    const host = this.engine.hostText;
    if (this.el.value !== host) this.el.value = host;
    // The overlay paints the selection; the native selection stays collapsed so
    // the two never double-paint (and the OS highlight is too weak to rely on).
    const c = Math.min(this.engine.cursor, this.el.value.length);
    this._expectedCaret = c;
    this.el.setSelectionRange(c, c);
    this._updateCaret();
  }

  /** Visible line window, in buffer lines. Approximate under soft wrap. */
  viewport() {
    if (this.el.tagName === "INPUT") return null;
    const cs = getComputedStyle(this.el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
    const height = Math.max(1, Math.floor(this.el.clientHeight / lh));
    const top = Math.max(0, Math.floor(this.el.scrollTop / lh));
    return { top, height };
  }

  scrollToLine(line) {
    const cs = getComputedStyle(this.el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
    this.el.scrollTop = Math.max(0, line * lh);
  }

  _token(e) {
    return tokenFor(e, this.engine.mode);
  }

}

export { Mode };
