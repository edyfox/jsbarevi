// Adapter for <textarea> and single-line <input>.
//
// The engine owns NORMAL and VISUAL mode; the host owns INSERT mode, IME, paste
// and the browser's own undo. So this adapter:
//   * intercepts keys only when the engine says it handled them
//   * lets the browser type while the engine is in INSERT
//   * re-syncs the engine's text/cursor from the element after any input
//   * commits engine text back with a minimal DOM write

import { Engine, Mode } from "../engine/engine.js";

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
    this._bound = {
      keydown: (e) => this._onKeydown(e),
      input: () => this.syncFromHost(),
      blur: () => this.engine.reset(),
    };
    el.addEventListener("keydown", this._bound.keydown, true);
    el.addEventListener("input", this._bound.input);
    el.addEventListener("blur", this._bound.blur);
    this.syncFromHost();
    this.engine.setText(this.el.value, this.el.selectionStart ?? 0);
    this._emitMode();
  }

  destroy() {
    this.el.removeEventListener("keydown", this._bound.keydown, true);
    this.el.removeEventListener("input", this._bound.input);
    this.el.removeEventListener("blur", this._bound.blur);
  }

  describe() {
    const tag = this.el.tagName.toLowerCase();
    const hint = this.el.getAttribute("aria-label") || this.el.className || "unnamed";
    return `${tag}: ${String(hint).slice(0, 40)}`;
  }

  syncFromHost() {
    this.engine.setText(this.el.value, this.el.selectionStart ?? 0);
  }

  _emitMode() {
    this.onModeChange?.(this.engine.mode, this.engine.pending?.count || "");
  }

  _onKeydown(e) {
    if (e.isComposing) return; // IME: never touch it
    const key = this._token(e);
    if (key == null) return;

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
    const c = Math.min(this.engine.cursor, this.el.value.length);
    this.el.setSelectionRange(c, c);
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
