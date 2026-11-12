// Adapter for <textarea> and single-line <input>.
//
// The engine owns NORMAL and VISUAL mode; the host owns INSERT mode, IME, paste
// and the browser's own undo. So this adapter:
//   * intercepts keys only when the engine says it handled them
//   * lets the browser type while the engine is in INSERT
//   * re-syncs the engine's text/cursor from the element after any input
//   * commits engine text back with a minimal DOM write

import { Engine, Mode } from "../engine/engine.js";
import { BlockCaret } from "./caret.js";
import { HttpEditorSession } from "./editor-session.js";
import { SelectionHighlight } from "./highlight.js";

export class TextareaAdapter {
  constructor(el, opts = {}) {
    this.el = el;
    this.engine = new Engine({
      viewport: () => this.viewport(),
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
    this._bound = {
      keydown: (e) => this._onKeydown(e),
      input: () => this.syncFromHost(),
      // Only the focused field may show a caret or a highlight: two fields on one
      // page must not both look active.
      blur: () => { this.engine.reset(); this.caret?.hide(); this.highlight.clear(); this.onModeChange?.(this.engine.mode, ""); },
      focus: () => { this.el.style.caretColor = ""; this._emitMode(); },
    };
    this._bound.scroll = () => this._updateCaret();
    this._bound.resize = () => { this.caret?.invalidate(); this.highlight.invalidate(); this._updateCaret(); };
    el.addEventListener("keydown", this._bound.keydown, true);
    el.addEventListener("input", this._bound.input);
    el.addEventListener("blur", this._bound.blur);
    el.addEventListener("focus", this._bound.focus);
    el.addEventListener("scroll", this._bound.scroll);
    window.addEventListener("resize", this._bound.resize);
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
    window.removeEventListener("resize", this._bound.resize);
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
      this.onPrompt?.(r.prompt.kind, "");
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
    if (this.el.value !== this.engine.text) this.el.value = this.engine.text;
    // The overlay paints the selection; the native selection stays collapsed so
    // the two never double-paint (and the OS highlight is too weak to rely on).
    const c = Math.min(this.engine.cursor, this.el.value.length);
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
    const named = {
      Escape: "Esc", Enter: "CR", Backspace: "BS", Tab: "Tab",
      ArrowLeft: null, ArrowRight: null, ArrowUp: null, ArrowDown: null,
      PageUp: null, PageDown: null, Home: null, End: null,
    };
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "c") return "C-c";
      if (["r", "w", "u", "d", "f", "b", "e", "y", "g"].includes(k)) return `C-${k}`;
      return null;
    }
    if (e.altKey || e.metaKey) return null;
    if (named[e.key] !== undefined) return named[e.key];
    if (e.key.length === 1) return e.key;
    return null;
  }
}

export { Mode };
