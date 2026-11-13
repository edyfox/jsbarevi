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
import { BlockCaret } from "./caret.js";
import { HttpEditorSession } from "./editor-session.js";
import { SelectionHighlight } from "./highlight.js";

export class TextareaAdapter {
  constructor(el, opts = {}) {
    this.el = el;
    this.engine = new Engine({
      viewport: () => this.viewport(),
      // Screen lines need measurement, not arithmetic: only the host knows where
      // a soft wrap happens. Content coordinates, so scrolling cannot affect it.
      metrics: (offset) => this.caret?.contentPoint(offset) ?? null,
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
        this.engine.reset();
        this.caret?.hide();
        this.highlight.clear();
        this.onModeChange?.(this.engine.mode, "");
      },
      focus: () => { this.el.style.caretColor = ""; this._emitMode(); },
    };
    this._bound.scroll = () => this._updateCaret();
    this._bound.resize = () => { this.caret?.invalidate(); this.highlight.invalidate(); this._updateCaret(); };
    el.addEventListener("keydown", this._bound.keydown, true);
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
    // `:e` needs a transport; without one the engine reports why instead.
    if (opts.editorUrl) {
      this.engine.session = new HttpEditorSession({
        engine: this.engine,
        url: opts.editorUrl,
        token: opts.editorToken,
        basic: opts.editorBasic,
        onStatus: (msg, kind) => this.onStatus?.(msg, kind),
        onApplied: () => { this._commit(); this._emitMode(); },
      });
    }
    this.syncFromHost();
    this.engine.setText(this.el.value, this.el.selectionStart ?? 0);
    this._emitMode();
  }

  destroy() {
    this.el.removeEventListener("keydown", this._bound.keydown, true);
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

  describe() {
    const tag = this.el.tagName.toLowerCase();
    const hint = this.el.getAttribute("aria-label") || this.el.className || "unnamed";
    return `${tag}: ${String(hint).slice(0, 40)}`;
  }

  syncFromHost() {
    this.engine.setText(this.el.value, this.el.selectionStart ?? 0);
    this._updateCaret();
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
      this.engine.setText(this.el.value, start);
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
    this.onModeChange?.(this.engine.mode, this.engine.pending?.count || "");
    const focused = document.activeElement === this.el;
    const insert = this.engine.mode === Mode.INSERT;
    // hide the native hairline caret in normal/visual, show ours instead
    this.el.style.caretColor = insert || !focused ? "" : "transparent";
    if (insert || !focused) { this.caret?.hide(); this.highlight.clear(); }
    else this._updateCaret();
  }

  _updateCaret() {
    if (document.activeElement !== this.el) { this.caret?.hide(); this.highlight.clear(); return; }
    if (this.engine.mode === Mode.INSERT) { this.caret?.hide(); this.highlight.clear(); return; }
    const linewise = this.engine.mode === Mode.VISUAL_LINE;
    this.caret?.update(this.engine.cursor, { linewise });
    const sel = this.engine.visualSelection();
    if (sel) this.highlight.update(sel.from, sel.to, this.engine.text, { linewise: sel.linewise });
    else this.highlight.clear();
  }

  _onKeydown(e) {
    if (e.isComposing) return; // IME: never touch it
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
    e.preventDefault();
    e.stopPropagation();
    this._commit();
  }

  /** Ask the UI for a prompt line and finish it. */
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
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "c") return "C-c";
      if (["r", "w", "u", "d", "f", "b", "e", "y", "g"].includes(k)) return `C-${k}`;
      return null;
    }
    if (e.altKey || e.metaKey) return null;
    // Caret-moving keys vi also has: the ENGINE owns them outside insert mode, so
    // the model stays authoritative (and visual mode extends on an arrow instead
    // of the browser painting a selection we then have to guess back). Same
    // mapping vim uses: arrows are h/j/k/l, Home/End are 0/$, PageUp/PageDown are
    // C-b/C-f. In insert mode they belong to the browser, and Shift+arrows select.
    // Screen-line keys. vim maps <Up>/<Down> to the screen-line motions when
    // 'wrap' is set, and the browser does the same with carets in insert mode -
    // which we cannot change, because insert mode is the host's. So normal mode
    // follows the same rule: arrows and Home/End are gj/gk/g0/g$, and 0/$/j/k stay
    // the buffer-line motions they are in vim.
    const caret = {
      ArrowLeft: "h", ArrowRight: "l", ArrowUp: "gk", ArrowDown: "gj",
      Home: "g0", End: "g$", PageUp: "C-b", PageDown: "C-f",
    };
    if (caret[e.key] !== undefined) {
      if (this.engine.mode === Mode.INSERT || e.shiftKey) return null;
      return caret[e.key];
    }
    const named = { Escape: "Esc", Enter: "CR", Backspace: "BS", Tab: "Tab" };
    if (named[e.key] !== undefined) return named[e.key];
    if (e.key.length === 1) return e.key;
    return null;
  }
}

export { Mode };
