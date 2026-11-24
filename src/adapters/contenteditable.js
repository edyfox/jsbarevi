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
import { tokenFor, shiftMotionFor } from "./keys.js";
import { modeToReturn, applyReturnedMode } from "./focus-mode.js";
import {
  getFlatText, flatOffsetAt, flatOffsetFromSelection, setCursorAt, projectRange,
  deleteRange, deleteBackwardAt, backspaceViaKey, insertTextAt, caretRect, rangeRects, snapRange, snapInsert,
} from "./contenteditable-dom.js";

/**
 * Do two texts differ ONLY in line breaks?
 *
 * The question the adapter needs after an edit: a host that owns its block structure may
 * collapse a block a change command emptied (`S`/`cc`, or `ciw` on a one-word line) or add
 * the placeholder block it needs. That is line structure, not a lost edit — while any
 * other difference is text that went missing, which must be reported.
 */
// Hosts normalize the document in ways that are not edits: a block join becomes a break,
// an emptied chip leaves a non-breaking space, Lark sprinkles zero-width spaces. Two texts
// that differ only in those are the SAME text, and treating them as a lost edit is what
// made a successful chip deletion report "refused".
const withoutBreaks = (text) => text.replace(/\n/g, "").replace(/\u00a0/g, " ").replace(/\u200b/g, "");

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
      clipboard: opts.clipboard ?? null,
      version: opts.version,
      options: opts.options,
    });
    this.onStatus = opts.onStatus;
    this.onModeChange = opts.onModeChange;
    this.onPrompt = opts.onPrompt;
    // `:q` (see finishPrompt): the host detaches this field until it is focused again.
    this.onQuit = opts.onQuit;
    // Host capability, same contract as the textarea adapter: a synchronous cache in
    // front of the browser's asynchronous clipboard.
    this.clipboard = opts.clipboard ?? null;
    this.onKeyConsumed = opts.onKeyConsumed;
    this._keysDispatchedByHost = !!opts.keysDispatchedByHost;
    this.caret = opts.caret === false ? null : new BlockCaret(el, { enabled: opts.caret !== false });
    this.highlight = new SelectionHighlight(el);

    this._lastText = getFlatText(el);
    this._target = this._lastText;
    this._draining = false;
    this._slow = false;
    this._reverts = 0;
    this._commitSeq = 0;
    this._ignoreSelectionUntil = 0;
    this._destroyed = false;
    // Text → the host's own DOM for that text. A text diff cannot re-create an
    // element, so restoring a state that still exists as markup (vim's u and redo)
    // puts the markup back instead. Same idea as Input Vim's innerHTML undo stack,
    // scoped to what we need: the states we have actually seen.
    this._snaps = [];
    // What we last asked the host selection to be (a range in visual mode).
    this._expectedSel = null;
    // Projection health (see textarea.js): bounded re-assertion, then paint it ourselves.
    this._reasserts = [];
    this._projectionOff = false;
    this._mouseDown = false;
    this._beforeClick = null;
    this._typing = false;
    // The mode to come back in after a blur (see focus-mode.js).
    this._returnMode = null;

    this._bound = {
      // Keydown on the DOCUMENT in the capture phase: the host's own handler may be
      // registered on the element, and anything registered later on the same node
      // runs after it. Capture on the document always runs first.
      keydown: (e) => this._onKeydown(e),
      input: () => this._onInput(),
      mouseup: (e) => this._onMouseUp(e),
      mousedown: (e) => this._onMouseDown(e),
      selectionchange: () => this._onSelectionChange(),
      // See textarea.js: a drag inside the projected range would MOVE TEXT, outside the
      // engine's undo. In visual mode a drag means "adjust the selection", never "move".
      dragstart: (e) => {
        if (this.engine.mode === Mode.VISUAL || this.engine.mode === Mode.VISUAL_LINE) e.preventDefault();
      },
      contextmenu: (e) => this._onContextMenu(e),
      blur: () => this._onBlur(),
      focus: () => this._onFocus(),
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
    el.addEventListener("dragstart", this._bound.dragstart);
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
    // See textarea.js: the extension starts a field in INSERT; a plain host does not.
    if (opts.startMode === "insert") {
      this.engine.mode = Mode.INSERT;
      this.engine.insertEntry = null;
      this._writeSelection();
    }
    this._emitMode();
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._verifyTimer);
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
    // The beam is hidden INLINE in NORMAL/VISUAL mode (`caret-color: transparent`). Put it
    // back, or a detached field keeps an invisible caret — which is what `:q` looks like in
    // a rich composer that the host refuses to re-style (found in Lark, 2026-11-14).
    this.el.style.caretColor = "";
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

  /** Insert a register's text at the host's own insertion point (`<C-r>{register}`). */
  _insertFromRegister(text) {
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch { ok = false; }
    if (!ok) { this.onStatus?.("this editor refused the insert", "error"); return; }
    // The execCommand fires `input`; read the result anyway so a host that suppresses
    // that event still ends up in sync with what its document now says.
    this.syncFromHost();
  }

  syncFromHost() {
    const before = this.engine.hostText;
    const prevCursor = this.engine.cursor;
    const text = getFlatText(this.el);
    const offset = flatOffsetFromSelection(this.el);
    this.engine.applyHostEdit(fromField(text), offset);
    const endedVisual = this._afterHostEdit(before, prevCursor);
    if (this.engine.hostText !== text) this._commit();
    else { this._lastText = text; this._updateCaret(); }
    if (endedVisual) this._emitMode();
  }

  /**
   * A host edit that changes the text invalidates a visual selection's anchor. Native Cut
   * and Paste are host edits, which is the accepted cost of letting the browser do them.
   */
  _afterHostEdit(before, prevCursor) {
    if (this.engine.hostText === before) return false;
    if (this.engine.mode !== Mode.VISUAL && this.engine.mode !== Mode.VISUAL_LINE) return false;
    // A native Cut/Paste mutated the document behind the engine's back. Three things have
    // to happen, and the field reported all three as one symptom:
    //   1. it must be UNDOABLE, or `u` skips it and undoes an older command;
    //   2. visual mode ends — the range it was measured from is gone;
    //   3. it ends in the mode the selection was MADE FROM: one begun in insert goes back
    //      to insert, because that is where the next keystroke belongs.
    this.engine.recordHostEdit(fromField(before), prevCursor);
    this.engine.mode = this._selectionReturn || Mode.NORMAL;
    this.engine.visual = null;
    return true;
  }

  _onInput() {
    // `_drain` (and `_dispatchInput`) drive the document themselves; a host's echo of one
    // of those writes must not overwrite the text the drain is converging on.
    if (this._typing || this._draining) return;
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
    if (this._draining) return;
    // `deleteRange` sets a REAL range as the edit primitive, and Chrome reports
    // selectionchange for it asynchronously — after the edit returned. Without this guard
    // the adapter reads its own edit selection as "the user selected this" and switches
    // to visual, which is what made `x` on a chip do nothing at all.
    if (Date.now() < this._ignoreSelectionUntil) return;
    if (document.activeElement !== this.el) return;
    if (this.engine.prompt || this._mouseDown) return;
    const sel = this._selection();
    if (!sel) return;
    if (this._isEcho(sel)) return;

    if (sel.collapsed) {
      // Collapsed while the engine is in charwise visual: our range was taken away.
      // Put it back, bounded (see textarea.js for why this is not a loop).
      if (this.engine.mode === Mode.VISUAL && !this._projectionOff) { this._reassert(); return; }
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

    // A selection the host makes IS visual mode — same rule as the textarea adapter, in
    // every mode: a mouse drag, Shift+arrow, Ctrl-A. The range's own direction decides
    // which end is the head.
    const [anchor, head] = sel.anchor <= sel.focus
      ? [sel.anchor, sel.focus - 1]
      : [sel.anchor - 1, sel.focus];
    // Only when ENTERING visual: a second Shift+arrow reports another range
    // while we are already visual, and that must not overwrite the origin.
    if (this.engine.mode !== Mode.VISUAL && this.engine.mode !== Mode.VISUAL_LINE) {
      this._selectionReturn = this.engine.mode === Mode.INSERT ? Mode.INSERT : Mode.NORMAL;
    }
    this.engine.enterVisualFromHost(anchor, head);
    this._lastText = getFlatText(this.el);
    this._commit();
    this._emitMode();
  }

  /** Is this event the echo of a selection write we just did? */
  _isEcho(sel) {
    const e = this._expectedSel;
    if (!e) return false;
    return sel.anchor === e.anchor && sel.focus === e.focus;
  }

  /** The host took our visual range away — put the engine's back, bounded. */
  _reassert() {
    const now = Date.now();
    this._reasserts = this._reasserts.filter((t) => now - t < 500);
    this._reasserts.push(now);
    if (this._reasserts.length > 3) {
      this._projectionOff = true;
      this.onStatus?.("this host keeps clearing the selection; painting it ourselves", "error");
      this._writeSelection();
      this._updateCaret();
      return;
    }
    this._project();
    this._updateCaret();
  }

  /**
   * The flat offset under a viewport point, or null when the point is elsewhere. Same
   * reason as the textarea adapter: with a range projected, the browser's shift+click
   * moves the other end from the one vim moves, so the click must come from the pointer.
   */
  _offsetAtPoint(x, y) {
    const pos = document.caretPositionFromPoint?.(x, y);
    if (!pos || !this.el.contains(pos.offsetNode)) return null;
    return Math.max(0, flatOffsetAt(this.el, pos.offsetNode, pos.offset));
  }

  _onMouseDown(e) {
    const target = e.composedPath?.()[0] ?? e.target;
    if (!(target === this.el || this.el.contains(target))) return;
    this._menuProjection = false;
    this._mouseDown = true;
    this._pressPoint = { x: e.clientX, y: e.clientY };
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
      // See textarea.js: a drag can read as collapsed for one task after `mouseup`.
      const moved = this._pressPoint
        && (Math.abs(e.clientX - this._pressPoint.x) > 2 || Math.abs(e.clientY - this._pressPoint.y) > 2);
      if (moved && sel.collapsed && (this._dragRetry = (this._dragRetry || 0) + 1) < 4) {
        setTimeout(() => this._onMouseUp(e), 0);
        return;
      }
      this._dragRetry = 0;
      this._lastText = getFlatText(this.el);
      const before = this._beforeClick;

      if (this.engine.mode === Mode.INSERT && sel.collapsed) {
        // A click while inserting: the host's insertion point is the model. A drag is a
        // selection, and a selection means visual mode in every mode.
        this.engine.setText(fromField(this._lastText), sel.focus);
        this._emitMode();
        return;
      }
      if (e.button === 2 && before && (before.mode === Mode.VISUAL || before.mode === Mode.VISUAL_LINE)) {
        this.engine.extendVisualToClick(sel.focus, before.anchor, before.cursor);
      } else if (e.shiftKey && before && (before.mode === Mode.VISUAL || before.mode === Mode.VISUAL_LINE)) {
        // See textarea.js: with a projected range the browser extends from its own anchor,
        // so the vim rule needs the click resolved from the POINTER.
        const click = this._offsetAtPoint(e.clientX, e.clientY);
        this.engine.extendVisualToClick(click ?? sel.focus, before.anchor, before.cursor);
      } else if (!sel.collapsed) {
        // A drag is adopted from the host's range; the press decides where it is anchored
        // (see textarea.js — a browser drag restarts even from inside the selection).
        const [a, h] = sel.anchor <= sel.focus
          ? [sel.anchor, sel.focus - 1]
          : [sel.anchor - 1, sel.focus];
        // Only when ENTERING visual: a second Shift+arrow reports another range
        // while we are already visual, and that must not overwrite the origin.
        if (this.engine.mode !== Mode.VISUAL && this.engine.mode !== Mode.VISUAL_LINE) {
          this._selectionReturn = this.engine.mode === Mode.INSERT ? Mode.INSERT : Mode.NORMAL;
        }
        this.engine.enterVisualFromHost(a, h);
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

  /**
   * See textarea.js: charwise visual already has a real native selection, so the menu needs
   * no suppressing; VISUAL LINE projects its range just before the menu opens (a native
   * range cannot paint its bar, so it normally stays collapsed) and the overlay steps
   * aside.
   */
  _onContextMenu() {
    if (this.engine.mode !== Mode.VISUAL_LINE) return;
    const sel = this.engine.visualSelection();
    if (!sel) return;
    const flat = getFlatText(this.el).length;
    const from = Math.max(0, Math.min(sel.from, flat));
    const to = Math.max(from, Math.min(sel.to, flat));
    this._expectedSel = { anchor: from, focus: to };
    projectRange(this.el, from, to);
    this._menuProjection = true;
    this.highlight.clear();
  }

  _onBlur() {
    const active = document.activeElement;
    if (this.engine.prompt || active?.classList?.contains("jsbarevi-prompt")) return;
    // See textarea.js: leaving insert on a blur must still take vim's step to the left,
    // or the block lands on the character after where the beam was. The mode is
    // remembered first, so the field comes back the way it was left (focus-mode.js).
    this._returnMode = modeToReturn(this.engine);
    if (this.engine.mode === Mode.INSERT || this.engine.replaceSession) this.engine.feed("Esc");
    this.engine.reset();
    // A blurred composer must not keep a selection no mode owns. Dropping the ranges
    // rather than writing a caret: `setCursorAt` REFOCUSES a contenteditable in Chromium
    // (measured — the focus handler then restored INSERT and the blur never happened).
    try { window.getSelection()?.removeAllRanges(); } catch { /* nothing selected */ }
    this.caret?.hide();
    this.highlight.clear();
    this.onModeChange?.(this.engine.mode, "");
  }

  _onFocus() {
    const remembered = this._returnMode;
    this._returnMode = null;
    applyReturnedMode(this.engine, remembered);
    this._emitMode();
  }

  // -------------------------------------------------------------------------
  // keys
  // -------------------------------------------------------------------------

  _onKeydown(e) {
    if (e.__jsbareviSynthetic) return;           // a key WE dispatched (probe or edit)
    const target = e.composedPath?.()[0] ?? e.target;
    if (!(target === this.el || this.el.contains(target))) return;
    // See textarea.js: the composition guard belongs to insert mode only, otherwise a
    // stale isComposing flag eats one keystroke after every Escape.
    if (e.isComposing && (this.engine.mode === Mode.INSERT || this.engine.replaceSession)) {
      this.onKeyConsumed?.("composing");
      return;
    }
    // See textarea.js: Shift+caret is the host's everywhere except VISUAL LINE, which has
    // no native selection to extend.
    this._menuProjection = false;
    const key = shiftMotionFor(e, this.engine.mode) ?? tokenFor(e, this.engine.mode);
    if (key == null) return;

    const wasInsert = this.engine.mode === Mode.INSERT || !!this.engine.replaceSession;
    const r = this.engine.feed(key);
    if (!wasInsert && (this.engine.mode === Mode.VISUAL || this.engine.mode === Mode.VISUAL_LINE)) {
      if (key === "v" || key === "V") this._selectionReturn = null;
    }
    this._emitMode();
    if (r.insertText != null) {
      // `<C-r>{register}`. execCommand rather than a text-node rewrite: it is the
      // host's own undo entry, and it cannot delete a chip the register ends inside.
      e.preventDefault();
      e.stopImmediatePropagation();
      this._insertFromRegister(r.insertText);
      return;
    }

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

  /**
   * Escape whose keydown never reached us.
   *
   * PORTED FROM INPUT VIM (event-interceptor.js): "if keydown was swallowed by the
   * page, handle Escape on keyup". Another extension (Vimium) or a host's own key
   * driver can consume the keydown and stop propagation; nobody consumes the keyup.
   * Returns true when it changed something.
   */
  handleEscape() {
    // An Escape always wins over the mode the field would have come back in (see
    // focus-mode.js): the user asked to leave insert, a focus regain must not undo it.
    this._returnMode = null;
    if (this.engine.mode === Mode.NORMAL && !this.engine.prompt) return false;
    const r = this.engine.feed("Esc");
    this._emitMode();
    if (r.prompt) return false;
    if (r.handled) this._commit();
    return !!r.handled;
  }

  finishPrompt(kind, value) {
    this.engine.prompt = kind === "ex" ? "ex" : kind === "search" ? "search" : null;
    const r = this.engine.submitPrompt(value);
    if (r.quit) {
      // `:q` — the host lets go of this field; nothing to commit, and no mode to emit.
      // The engine has no listeners to remove, so this is the host's call, not ours.
      this.onQuit?.();
      return;
    }
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
    // The DOM writes below drop the native selection, so the projection and the caret are
    // re-established for EVERY path out of this method — refused edits included.
    try {
      this._commitBody();
    } finally {
      this._project();
      this._updateCaret();
    }
  }

  _commitBody() {
    this._commitSeq++;
    // A host can declare that it needs one edit per tick (`__jsbareviSlowEdits`, set from the
    // payload's runtime config). Detection alone is too slow to rely on: Lark repaints its
    // model back SECONDS later, so the 80 ms check never fires and the adapter never learns.
    if (!this._slow && globalThis.__jsbareviSlowEdits === true) this._slow = true;
    // `"keys"`: this host only accepts edits through its own key pipeline, so deletions are
    // dispatched as synthetic Backspaces and must go one per tick.
    if (!this._slow && globalThis.__jsbareviDestructiveEdits === "keys") this._slow = true;
    const next = this.engine.hostText;
    const prev = this._lastText;
    if (next === prev) return;
    const html = this.el.innerHTML;
    const restore = this._snaps.find((s) => s.text === next && s.html !== html);
    if (restore) {
      // An exact restoration (vim's u, or a redo): put the host's own markup back so
      // chips and inline marks survive. A text diff cannot re-create an element, and
      // undoing a deleted mention into plain text would be a lie about the document.
      this.el.innerHTML = restore.html;
      this._lastText = next;
      this._dispatchInput();
      return;
    }
    this._remember(prev, html);

    // A host that has already disagreed once gets the slow path from then on.
    if (this._slow) {
      this._target = next;
      this._drain();
      return;
    }

    const { from, to, insert } = diffRange(prev, next);

    // A host can forbid edits that DELETE text (`__jsbareviDestructiveEdits === false`, from
    // the payload's config). Lark's editor-kit keeps its own model and both accepts and then
    // re-inserts what we remove, so a deletion there is a fight with no winner — measured
    // 2026-11-24: per-tick deletes applied, then the host re-inserted them, 59 deletes in one
    // second. Refuse cleanly instead: no DOM write, no loop, and say why once.
    if (to > from && globalThis.__jsbareviDestructiveEdits === false) {
      globalThis.__jsbareviReport?.("edit-blocked", JSON.stringify({ from, to, insert, prev, next }).slice(0, 900));
      this._lastText = getFlatText(this.el);
      this.engine.setText(fromField(this._lastText), Math.min(this.engine.cursor, this._lastText.length));
      this.onStatus?.("this host blocks edits that delete text — Esc/:q to leave", "error");
      return;
    }

    let ok = true;
    this._ignoreSelectionUntil = Date.now() + 60;
    if (to > from) {
      // A deletion never half-covers an unbreakable element: `x` on a mention deletes the
      // whole mention, because that is the only thing the host can do.
      const range = snapRange(this.el, from, to);
      ok = deleteRange(this.el, range.from, range.to);
      if (ok && insert) ok = insertTextAt(this.el, snapInsert(this.el, range.from), insert);
    } else if (insert) {
      ok = insertTextAt(this.el, snapInsert(this.el, from), insert);
    }
    if (!ok) {
      // The host refused. Do not rewrite its document to force the point: re-read what is
      // really there and say so.
      globalThis.__jsbareviReport?.("edit-refused", JSON.stringify({ from, to, insert, prev, next }).slice(0, 900));
      this._lastText = getFlatText(this.el);
      this.engine.setText(fromField(this._lastText), Math.min(this.engine.cursor, this._lastText.length));
      this.onStatus?.("this editor refused the edit", "error");
      return;
    }

    const actual = getFlatText(this.el);
    this._lastText = actual;
    if (actual !== next) {
      // The host re-styled its own document. Two shapes, and only one of them is a problem:
      //
      //   * ONLY line breaks differ — the host collapsed a block that a change command
      //     emptied (`S`, `cc`, `ciw` on a one-word line) or added the placeholder it
      //     needs. That is the host's line model, not a lost edit, so it is adopted
      //     SILENTLY: a red status line for the host's own normalization trains the user
      //     to ignore the status line.
      //   * any other difference — text survived that we deleted, or disappeared that we
      //     did not remove. That is a host with its own model that did not apply the edit.
      const breaksOnly = withoutBreaks(actual) === withoutBreaks(next);
      const removedMore = withoutBreaks(actual).length < withoutBreaks(next).length;
      this.engine.setText(fromField(actual), Math.min(this.engine.cursor, actual.length));
      globalThis.__jsbareviReport?.(breaksOnly ? "edit-reflowed" : removedMore ? "edit-mismatch" : "edit-reverted", JSON.stringify({
        from, to, insert, prev, next, actual,
      }).slice(0, 900));
      if (removedMore) {
        // The host took MORE than we asked — an unbreakable element went whole, which is
        // the only thing it can do. Adopt its document and say so once.
        this.onStatus?.("the host removed more than the command asked for (an unbreakable element)", "error");
        this._dispatchInput();
        this._verifySoon();
        return;
      }
      if (!breaksOnly) {
        // Stop asking this host for range edits, and finish the command the slow way so
        // the user is not left with a half-applied change.
        this._slow = true;
        this.engine.setText(fromField(next), Math.min(from, next.length));
        this._target = next;
        this._dispatchInput();
        this._drain();
        return;
      }
    }
    this._dispatchInput();
    this._verifySoon();
  }

  /**
   * The host can rewrite its document AFTER we finish, and tell nobody.
   *
   * The check above runs in the same tick, so it sees the DOM we just wrote and reports
   * success — while a host with its own model can paint that model back over the field a
   * moment later, with no `input` event to announce it. The result is ghost text: the field
   * shows what we deleted and the next keystrokes land at a caret the content does not back.
   *
   * Read the field once, shortly after, and ADOPT what the host really has — a host is the
   * authority on its own document. Two content mismatches are enough to conclude the host
   * models its own text, and from then on it gets one edit per tick (`_drain`).
   */
  _verifySoon() {
    clearTimeout(this._verifyTimer);
    clearTimeout(this._verifyLate);
    const seq = this._commitSeq;
    // A host that repaints lazily can take seconds. Check once quickly and once late, so a
    // silent rewrite is caught before it can eat the next keystroke.
    this._verifyLate = setTimeout(() => this._verifyNow(seq), 1200);
    this._verifyTimer = setTimeout(() => {
      this._verifyNow(seq);
    }, 80);
  }

  _verifyNow(seq) {
    {
      const actual = getFlatText(this.el);
      const expected = this._lastText;
      if (actual === expected) return;
      this._lastText = actual;
      this.engine.setText(fromField(actual), Math.min(this.engine.cursor, actual.length));
      // Line breaks are the host's own line model — adopt them silently, exactly as
      // `_commit` does. Only a CONTENT difference means the host rewrote our edit.
      if (withoutBreaks(actual) === withoutBreaks(expected)) return;
      // One repaint is proof enough: from here on this host gets one edit per tick. The
      // edit that revealed it is absorbed rather than chased — a host that just refused
      // would only refuse again, and chasing it would fight the person typing.
      this._slow = true;
      this.onStatus?.("the host re-rendered the text after the edit", "error");
      globalThis.__jsbareviReport?.("edit-reverted", JSON.stringify({
        expected: expected.slice(0, 300),
        actual: actual.slice(0, 300),
      }).slice(0, 900));
    }
  }

  /**
   * Make the DOM converge on `this._target`, ONE edit per tick.
   *
   * This is the shape a host with its own document model can actually apply. Lark's
   * `editor-kit` takes exactly one edit per input event and applies the `inputType` it is
   * given — a burst issued in one tick collapses into a single model update, so a
   * multi-character deletion has to be delivered as a sequence of single backward deletes,
   * each in its own tick (measured 2026-11-24: seven deletes in one tick reached the model
   * as one, and `est` came back; a single ranged delete lost six of seven).
   *
   * The engine stays the authority on TEXT: every keystroke just moves `_target`, and this
   * loop chases it. Nothing is dropped and nothing races, because a keystroke never writes
   * the DOM directly.
   */
  async _drain() {
    if (this._draining) return;
    this._draining = true;
    let changed = false;
    let stuck = 0;
    let lastSeen = null;
    let noProgress = 0;
    let best = Infinity;
    try {
      for (let guard = 0; guard < 800; guard++) {
        if (this._destroyed) break;
        const current = getFlatText(this.el);
        if (current === this._target) break;
        // A host that keeps putting the same text back (it does not believe the edit):
        // stop after two attempts and adopt what it really has.
        if (current === lastSeen) {
          if (++stuck > 2) break;
        } else {
          lastSeen = current;
          stuck = 0;
        }
        // MONOTONIC PROGRESS OR STOP. A host that fights the edit (Lark re-inserts a
        // character we just removed) turns this loop into a visible thrash — hundreds of
        // deletes a second. Distance to the target must keep shrinking; if it does not for
        // three steps, give up, adopt what the host has, and report it.
        const distance = Math.abs(current.length - this._target.length);
        if (distance < best) { best = distance; noProgress = 0; }
        else if (++noProgress > 3) break;

        const { from, to, insert } = diffRange(current, this._target);
        if (to > from) {
          // One character per tick — except a span so large that stepping through it would
          // take longer than the user is willing to wait.
          this._ignoreSelectionUntil = Date.now() + 60;
        const viaKeys = globalThis.__jsbareviDestructiveEdits === "keys";
        const ok = to - from > 160 && !viaKeys
            ? deleteRange(this.el, from, to)
            : viaKeys
              ? backspaceViaKey(this.el, Math.min(to, current.length))
              : deleteBackwardAt(this.el, Math.min(to, current.length));
          if (!ok) break;
          changed = true;
          // A host edited through its own key pipeline applies the edit ASYNCHRONOUSLY: its
          // model lands a few tens of milliseconds after the key. Measuring in the same tick
          // made the drain stop one character early and the host repaint the survivor on the
          // next keystroke (`abc` became `tbc`, measured 2026-11-24). Give it room to land.
          await new Promise((resolve) => setTimeout(resolve, viaKeys ? 30 : 0));
          continue;
        }
        if (insert) {
          if (!insertTextAt(this.el, snapInsert(this.el, from), insert)) break;
          changed = true;
          await new Promise((resolve) => setTimeout(resolve, 0));
          continue;
        }
        break;                                  // nothing left to converge
      }
    } finally {
      this._draining = false;
    }

    const actual = getFlatText(this.el);
    const expected = this._target;
    this._lastText = actual;
    if (actual !== expected) {
      // The host rewrote it. Adopt its text — it is the authority on its own document —
      // and say so, instead of keeping a caret the document does not back.
      this.engine.setText(fromField(actual), Math.min(this.engine.cursor, actual.length));
      this.onStatus?.("the host edited this differently", "error");
      globalThis.__jsbareviReport?.("edit-reverted", JSON.stringify({
        expected: expected.slice(0, 300),
        actual: actual.slice(0, 300),
      }).slice(0, 900));
    }
    this._project();
    this._updateCaret();
    if (changed) this._dispatchInput();
    this._verifySoon();
  }

  _remember(text, html) {
    if (this._snaps.some((s) => s.text === text && s.html === html)) return;
    this._snaps.push({ text, html });
    if (this._snaps.length > 40) this._snaps.shift();
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
    this._expectedSel = { anchor: offset, focus: offset };
    const current = flatOffsetFromSelection(this.el);
    const sel = window.getSelection();
    if (sel?.isCollapsed && current === offset && document.activeElement === this.el) return;
    setCursorAt(this.el, offset);
  }

  /**
   * Put the engine's selection into the host: the visual range in charwise visual, a caret
   * everywhere else. The host's two ends are the anchor and the focus, and the focus is
   * always on the HEAD side, which is where the direction comes from. VISUAL LINE stays
   * collapsed on purpose — its look is a full-width bar, which is the overlay's job.
   */
  _project() {
    const sel = this._projectionOff ? null : this.engine.visualSelection();
    if (!sel || this.engine.mode !== Mode.VISUAL) { this._writeSelection(); return; }
    const flat = getFlatText(this.el).length;
    const from = Math.max(0, Math.min(sel.from, flat));
    const to = Math.max(from, Math.min(sel.to, flat));
    const backward = this.engine.visual.anchor > this.engine.cursor;
    const anchor = backward ? to : from;
    const focus = backward ? from : to;
    this._expectedSel = { anchor, focus };
    const cur = this._selection();
    if (cur && !cur.collapsed && cur.anchor === anchor && cur.focus === focus) return;
    projectRange(this.el, anchor, focus);
  }

  _emitMode() {
    const replace = !!this.engine.replaceSession;
    const label = replace ? "REPLACE" : this.engine.mode;
    this.onModeChange?.(label, this.engine.pending?.count || "");
    const focused = document.activeElement === this.el;
    const beam = this.engine.mode === Mode.INSERT && !replace;
    // The native caret has to go for the same reason as in a textarea: a beam next to a
    // block is two cursors, and at a line end (where the insertion point sits one past
    // the last character) the beam is the one you notice. The textarea adapter has
    // always done this; the contenteditable one never did.
    this.el.style.caretColor = beam || !focused ? "" : "transparent";
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
    // The browser paints charwise visual now; we paint the linewise bar, and everything
    // when this field has fallen back off the projection.
    const sel = this.engine.visualSelection();
    if (sel && (sel.linewise || this._projectionOff) && !this._menuProjection) {
      this.highlight.paint(rangeRects(this.el, sel.from, sel.to, { linewise }));
    } else this.highlight.clear();
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
