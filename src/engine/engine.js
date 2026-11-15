// The engine: a pure state machine over (text, cursor, mode).
//
// Contract with the host:
//   * the engine emits a NEW TEXT + CURSOR; the adapter commits the difference
//   * insert mode belongs to the host - the engine returns handled:false and the
//     host does the typing, IME, paste and its own undo
//   * anything needing the layout is optional: without a viewport capability the
//     screen commands report why instead of guessing

import * as B from "./buffer.js";
import * as C from "./cursor.js";
import { runEx } from "./ex.js";
import { Registers, isNamed, isClipboard } from "./registers.js";

export const Mode = { NORMAL: "NORMAL", INSERT: "INSERT", VISUAL: "VISUAL", VISUAL_LINE: "VISUAL_LINE" };

const LINE_MOTIONS = new Set(["j", "k", "+", "-", "_", "CR", "G", "gg", "H", "M", "L"]);

// The two-key `g` motions. Kept in one table because every path - a plain jump, a
// pending operator (`dgg`, `dgj`) and a visual extension - has to see the same set;
// when this lived inside the key handler, `dgg` moved the cursor and dropped the
// operator.
const G_MOTIONS = { j: "gj", k: "gk", "0": "g0", $: "g$", "^": "g^", g: "gg" };

export class Engine {
  constructor(opts = {}) {
    this.version = opts.version || "0.1.0";
    this.options = {
      autoindent: false,
      expandtab: true,
      ignorecase: false,
      smartcase: false,
      showmatch: true,
      flash: true,
      tabstop: 4,
      shiftwidth: 4,
      ...opts.options,
    };
    this.registers = new Registers({ clipboard: opts.clipboard || null });
    this.marks = new Map(); // char -> offset
    this.lastSearch = null;
    this.lastSearchForward = true;
    this.lastFind = null; // {kind, char, forward}
    this.undoStack = [];
    this.redoStack = [];
    this.undoBlock = null;
    this.lastChange = null;
    this.lineSnapshot = null;
    this.state = { text: "", cursor: 0 };
    this.mode = Mode.NORMAL;
    this.pending = this._emptyPending();
    this.visual = null;
    this.insertEntry = null;
    // Replace mode (R): insert is the host's, so what was overwritten has to be
    // reconstructed from a snapshot of the field at entry. See applyHostEdit().
    this.replaceSession = null;
    this.prompt = null;
    this.viewport = opts.viewport || null; // () => ({top, height}) in buffer lines
    // (offset) => {x, y, width, height} in content coordinates, for screen lines.
    this.metrics = opts.metrics || null;
    // () => {from, to} | null: the character range visible in a horizontally
    // scrolled, non-wrapping field, in buffer offsets on the cursor's line.
    this.hscroll = opts.hscroll || null;
    // The vertical wish, in SCREEN space, for gj/gk - separate from desiredCol,
    // which is in buffer columns for j/k. `g$` sets desireRowEnd instead.
    this.desiredX = null;
    this.desireRowEnd = false;
    this.status = [];
    this.onStatus = (msg, kind) => { if (msg) this.status.push(msg); (opts.onStatus || (() => {}))(msg, kind); };
    this.onScroll = opts.onScroll || (() => {});
    this.session = opts.session || null;
    this.describeBuffer = opts.describeBuffer || null;
    this.suppressName = true;
  }

  // --- host API ------------------------------------------------------------
  setText(text, cursor = 0) {
    this._setText(B.ensureEol(text));
    this.state.cursor = Math.max(0, Math.min(cursor, Math.max(0, this.state.text.length - 1)));
  }
  /**
   * The single writer for the buffer. Every mutation goes through here so the
   * trailing-terminator invariant (buffer.js) cannot be lost by one call site
   * that happens to delete through the end of the buffer. Same shape as
   * busybox's end-of-command `dot--`: one place enforces the model.
   */
  _setText(text) {
    this.state.text = B.ensureEol(text);
    const max = Math.max(0, this.state.text.length - 1);
    if (this.state.cursor > max) this.state.cursor = max;
  }
  get text() { return this.state.text; }
  /** What the host field should contain: the buffer without its terminator. */
  get hostText() { return B.hostText(this.state.text); }

  /**
   * The host moved its own caret (a mouse click, or a key the host owns).
   * vi's cursor is a CHARACTER, so a caret that sits past the end of a line -
   * which the DOM allows and vim does not - is clamped back onto that line's
   * last character; column 1 of an empty line stays legitimate. The same clamp
   * Input Vim applies in `clampCursorToLine` (cursor-controller.js), and the
   * reason it is needed at all is that the host's caret is an insertion point
   * between characters while ours is a character.
   */
  setCursorFromHost(hostOffset) {
    const t = this.text;
    const at = Math.max(0, Math.min(hostOffset, Math.max(0, t.length - 1)));
    this.state.cursor = B.clampToLineEnd(t, at, at);
    this._stayOffNewline();
    this._resetWishes();
  }

  /**
   * The host applied an edit while insert mode owns the keyboard. In plain insert
   * the host's text IS the truth. In REPLACE mode (R) it is not: the browser
   * inserts, so the text it displaced has to be dropped. Recomputed from the
   * snapshot taken when R was pressed:
   *
   *     snap[0 .. at) + typed + snap[at + consumed ..)
   *
   * `typed` is tracked by diffing the host's edits, which is what makes Backspace
   * restore the replaced character for free - recomputing from the snapshot puts
   * the original back. `consumed` stops at a newline, because replacing never eats
   * across a line break: typing past the end of the line appends, as in vim.
   */
  applyHostEdit(hostText, hostCursor) {
    this._resetWishes();
    const session = this.replaceSession;
    if (!session) { this.setText(hostText, hostCursor); return; }
    const prev = this.hostText;
    const grown = hostText.length - prev.length;
    if (grown === 0) {
      if (hostText === prev) { this.setText(hostText, hostCursor); return; } // just a caret move
      // something replaced text in place (a framework rewriting the value, an IME
      // commit, a paste). Adopt it and REBASE rather than dropping the session:
      // silently becoming insert mode is exactly what the user cannot see.
      this.setText(hostText, hostCursor);
      this.replaceSession = { at: Math.min(hostCursor, B.hostText(this.text).length), snap: B.hostText(this.text), typed: "" };
      return;
    }
    // the edit must continue (or shorten) the typed run; anything else - a click
    // elsewhere, IME, a paste - ends replace tracking and takes the host's text
    let prefix = 0;
    while (prefix < prev.length && prefix < hostText.length && prev[prefix] === hostText[prefix]) prefix++;
    const typedEnd = session.at + session.typed.length;
    if (grown > 0 && prefix >= session.at && prefix <= typedEnd) {
      session.typed += hostText.slice(prefix, prefix + grown);
    } else if (grown < 0 && prefix + (-grown) >= session.at && prefix + (-grown) <= typedEnd) {
      session.typed = session.typed.slice(0, session.typed.length + grown);
    } else {
      // an edit that did not extend the typed run (a click elsewhere, IME, paste):
      // adopt it, then continue replacing from where the cursor now is
      this.setText(hostText, hostCursor);
      this.replaceSession = { at: Math.min(hostCursor, B.hostText(this.text).length), snap: B.hostText(this.text), typed: "" };
      return;
    }
    const consumed = this._replaceConsumed();
    this.setText(session.snap.slice(0, session.at) + session.typed + session.snap.slice(session.at + consumed), hostCursor);
    this._resetWishes();
  }

  /**
   * Adopt a selection the host created (a mouse drag) as visual mode. The
   * anchor is where the selection started, the head (the live end of the
   * selection) becomes the cursor - which is exactly vim's model, and the
   * reason the host's selection and ours can be the same object.
   */
  enterVisualFromHost(anchor, head, linewise = false) {
    const t = this.text;
    const clamp = (i) => Math.max(0, Math.min(i, Math.max(0, t.length - 1)));
    this.pending = this._emptyPending();
    this.mode = linewise ? Mode.VISUAL_LINE : Mode.VISUAL;
    this.visual = { anchor: clamp(anchor) };
    this.state.cursor = clamp(head);
    this._stayOffNewline();
    this._resetWishes();
  }

  /**
   * Shift+click while selecting. vim rewrites a shifted left click into a right
   * click (mouse.c:753-757), and a right click inside visual mode moves the
   * ANCHOR - "If the click is before the start of visual, change the start.  If
   * the click is after the end of visual, change the end.  If the click is
   * inside the visual, change the closest side." (mouse.c:934-936).
   *
   * Which side moves is the whole rule, and it means a shift+click both grows
   * and shrinks:
   *   - clicked OUTSIDE the selection -> the far boundary stays and the near one
   *     moves to the click, so the selection grows (it spans click..far end);
   *   - clicked INSIDE -> one boundary moves to the click, so the selection
   *     SHRINKS, keeping the far half and dropping the part the click is on.
   * The mode is untouched, so a linewise selection stays linewise.
   */
  extendVisualToClick(click, anchor, head) {
    const t = this.text;
    const clamp = (i) => Math.max(0, Math.min(i, Math.max(0, t.length - 1)));
    const raw = clamp(click);
    const at = B.clampToLineEnd(t, raw, raw);
    const from = Math.min(clamp(anchor), clamp(head));
    const to = Math.max(clamp(anchor), clamp(head));
    let next;
    if (at < from) next = to;          // clicked before the selection: keep its end
    else if (at > to) next = from;     // clicked after it: keep its start
    else {
      // inside: the far side stays and the nearer side moves, exactly as vim
      // measures it (columns on one line, line distance across lines).
      const lFrom = B.lineNumber(t, from);
      const lTo = B.lineNumber(t, to);
      const lAt = B.lineNumber(t, at);
      if (lFrom === lTo) {
        next = at - from > to - at ? from : to;
      } else {
        const diff = (lAt - lFrom) - (lTo - lAt);
        if (diff > 0) next = from;
        else if (diff < 0) next = to;
        else {
          const cFrom = from - B.lineStart(t, from);
          const cTo = to - B.lineStart(t, to);
          const cAt = at - B.lineStart(t, at);
          next = cAt < (cFrom + cTo) / 2 ? to : from;
        }
      }
    }
    this.visual = { anchor: next };
    this.state.cursor = at;
    this._stayOffNewline();
  }
  get cursor() { return this.state.cursor; }
  set cursor(v) {
    this.state.cursor = Math.max(0, Math.min(v, Math.max(0, this.text.length - 1)));
  }
  reset() {
    this.mode = Mode.NORMAL;
    this.pending = this._emptyPending();
    this.visual = null;
    this.insertEntry = null;
    this.prompt = null;
  }

  _emptyPending() {
    return { count: "", op: null, reg: null, awaiting: null, gPending: false, textObj: null, opCount: "" };
  }

  _takeCount(def = 1) {
    const n = parseInt(this.pending.count, 10);
    this.pending.count = "";
    return Number.isFinite(n) && n > 0 ? n : def;
  }

  feed(key) {
    if (this.prompt) return { handled: false };
    if (this._swallowNext) {
      // One key after a REJECTED register prefix: the command it belonged to. This lives
      // in feed() rather than in _normalKey because the prefix can be typed in visual
      // mode too, where swallowing only in normal mode let the operator half-run.
      this._swallowNext = false;
      this.pending = this._emptyPending();
      return { handled: true };
    }
    const before = this.state.text;
    const preCursor = this.state.cursor;
    let res;
    if (this.mode === Mode.INSERT) {
      res = this._insertKey(key);
    } else {
      res = this.mode === Mode.VISUAL || this.mode === Mode.VISUAL_LINE
        ? this._visualKey(key)
        : this._normalKey(key);
      this._stayOffNewline();
    }
    // One undo block per change command; insert mode keeps the block open until
    // Esc, so the command that opened insert and the typing undo together.
    if (this.mode === Mode.NORMAL) this._closeUndo();
    // `U`'s snapshot, taken before the first change to this line (see _restoreLine).
    if (this.state.text !== before) {
      const line = before === this.state.text ? 0 : B.lineNumber(before, Math.min(preCursor, Math.max(0, before.length - 1)));
      if (!this.lineSnapshot || this.lineSnapshot.line !== line) {
        // The column is recorded AFTER the command, not before: measured (`llXU` lands on
        // 1:2, `lXjllkU` on 1:1, `xxU` on 1:1) — vim saves the position the change left
        // the cursor at, and U reproduces it.
        this.lineSnapshot = {
          line,
          text: B.lineText(before, B.lineOffset(before, line)),
          col: this.state.cursor - B.lineStart(this.state.text, this.state.cursor),
        };
      }
      if (B.lineCount(this.state.text) !== B.lineCount(before)) this.lineSnapshot = null;
      void preCursor;
    }
    return res;
  }

  /**
   * busybox normalises this at the tail of every command (vi.c: "Try to stay off
   * of the Newline": `if (*dot == '\n' && cnt > 0 && cmd_mode == 0) dot--`).
   * Centralising it is why busybox cannot have the bug we hit: a command that
   * forgets to place the cursor carefully is corrected anyway. Column 1 of an
   * empty line is legitimate (a zero-length line has no character to stand on),
   * and insert mode owns the cursor until Esc.
   */
  _stayOffNewline() {
    // Normal mode only: a visual selection legitimately ends on a newline, and
    // insert mode owns the cursor until Esc. (busybox's guard is `cmd_mode == 0`,
    // and it has no visual mode to worry about.)
    if (this.mode !== Mode.NORMAL) return;
    const t = this.text;
    const c = this.state.cursor;
    if (c < 0 || c >= t.length) return;
    if (t[c] !== "\n") return;
    if (c === B.lineStart(t, c)) return;   // col 1 of an empty line
    this.state.cursor = B.prevChar(t, c);
  }

  /** Feed a key sequence using the oracle notation: <Esc> <CR> <Tab> <BS> <C-r>. */
  feedKeys(seq) {
    const tokens = seq.match(/<[A-Za-z-]+>|[\s\S]/g) || [];
    let last = { handled: true };
    for (const tok of tokens) {
      const key = this._normalizeToken(tok);
      if (key === null) continue;
      last = this.feed(key);
    }
    return last;
  }

  _normalizeToken(tok) {
    const map = {
      "<Esc>": "Esc", "<CR>": "CR", "<Tab>": "Tab", "<BS>": "BS",
      "<C-r>": "C-r", "<C-w>": "C-w", "<C-u>": "C-u", "<C-d>": "C-d", "<C-f>": "C-f", "<C-b>": "C-b",
      "<C-e>": "C-e", "<C-y>": "C-y", "<C-g>": "C-g", "<Space>": " ",
      "<C-a>": "C-a", "<C-x>": "C-x",
    };
    return map[tok] ?? tok;
  }

  submitPrompt(value) {
    const kind = this.prompt;
    this.prompt = null;
    if (!kind) return { handled: true };
    if (kind === "search") {
      if (value) {
        this.lastSearch = value;
        this.lastSearchForward = this._promptDirection === "/";
      }
      const motion = this._promptDirection === "/"
        ? (this.lastSearchForward ? "n" : "N")
        : (this.lastSearchForward ? "N" : "n");
      const r = this._motion(motion, 1, {});
      if (r) this.state.cursor = r.to;
      return { handled: true };
    }
    if (kind === "ex") {
      const result = runEx(this, value);
      // An ex command mutates outside `feed()`, so it has to close its own undo
      // block - otherwise the block stays open and swallows the next command's.
      this._closeUndo();
      if (result.message) this.onStatus(result.message, result.ok ? "info" : "error");
      if (result.ok && !result.message) this.onStatus("");
      // `:q` on a field with no editor session: the adapter tells the host to let go of
      // this element until it is focused again.
      return { handled: true, ex: result, quit: !!result.quit };
    }
    return { handled: true };
  }

  // --- normal mode ---------------------------------------------------------
  _normalKey(key) {
    const p = this.pending;

    if (key === "Esc") {
      this.pending = this._emptyPending();
      return { handled: true };
    }

    // An operator already waiting for a text-object target: take it verbatim.
    //
    // This is the path `"ayaw` actually takes, and it used to pass `null` for the
    // register: `"+yaw` yanked into the unnamed register and never reached the system
    // clipboard, while `"+yy` worked — the two look like the same command and are not.
    // There was a second, unreachable copy of this block further down (inside `if (p.op)`,
    // which can never see a textObj set in an earlier keystroke); it is gone, because two
    // copies of a rule is how one of them gets forgotten.
    if (p.op && p.textObj) {
      const range = this._textObject(p.textObj, key);
      const op = p.op;
      const reg = p.reg;
      this.pending = this._emptyPending();
      if (!range) { this.onStatus("no text object", "error"); return { handled: true }; }
      this._applyOperatorRange(op, range.from, range.to, !!range.linewise, true, false, reg, range.inclusive);
      return { handled: true, edit: op !== "y" };
    }

    // single-character argument collectors
    if (p.awaiting) {
      return this._consumeArgument(p.awaiting, key);
    }

    if (key === '"') { p.awaiting = "register"; return { handled: true }; }
    if (key === "r") { p.awaiting = "replaceChar"; return { handled: true }; }
    if (key === "f" || key === "F" || key === "t" || key === "T") { p.awaiting = key; return { handled: true }; }
    if (key === "m") { p.awaiting = "mark"; return { handled: true }; }
    if (key === "'" || key === "`") { p.awaiting = key; return { handled: true }; }
    if (p.gPending) {
      p.gPending = false;
      const gmotion = G_MOTIONS[key];
      if (!gmotion) return { handled: true }; // an unmapped g-command: swallow both keys
      if (p.op) {
        const op = p.op;
        const reg = p.reg;
        const count = parseInt(p.opCount || p.count || "1", 10);
        this.pending = this._emptyPending();
        this._operatorWithMotion(op, gmotion, count, reg);
        return { handled: true, edit: op !== "y" };
      }
      return this._doMotion(gmotion);
    }
    if (key === "g") { p.gPending = true; return { handled: true }; }

    // counts
    if (/^[1-9]$/.test(key) || (key === "0" && p.count !== "")) {
      p.count += key;
      return { handled: true };
    }

    // operators (and their doubled form). `>`/`<` are operators too: `>>` shifts
    // the line, `>j` shifts two, `>ap` shifts the paragraph.
    if (key === "d" || key === "c" || key === "y" || key === ">" || key === "<") {
      if (p.op === key) {
        const count = parseInt(p.count || p.opCount || "1", 10);
        p.op = null;
        if (key === ">" || key === "<") {
          const line = B.lineNumber(this.text, this.state.cursor);
          const from = B.lineOffset(this.text, line);
          const to = B.lineEnd(this.text, B.lineOffset(this.text, Math.min(B.lineCount(this.text) - 1, line + count - 1)));
          return { ...this._shiftLines(from, to, key === ">"), handled: true };
        }
        this._applyLinewiseOperator(key, count);
        return { handled: true, edit: key !== "y" };
      }
      if (p.op) { this.pending = this._emptyPending(); return { handled: true }; }
      p.op = key;
      p.opCount = p.count;
      p.count = "";
      return { handled: true };
    }
    if (key === "i" || key === "a" || key === "I" || key === "A" || key === "o" || key === "O" || key === "R") {
      if (p.op) {
        p.textObj = key; // `diw` etc: operator + text object prefix
        return { handled: true };
      }
      return this._enterInsert(key, this._takeCount(1));
    }

    // a pending operator followed by a motion
    if (p.op) {
      const motion = this._resolveMotionKey(key);
      if (!motion) { this.pending = this._emptyPending(); this.onStatus("not a motion", "error"); return { handled: true }; }
      let count;
      if (p.count) count = this._takeCount(1);
      else if (p.opCount) count = parseInt(p.opCount, 10);
      else count = 1;
      const op = p.op;
      const reg = p.reg;
      this.pending = this._emptyPending();
      if (op === ">" || op === "<") {
        const res = this._shiftByMotion(motion, count, op === ">");
        return { ...res, handled: true, edit: true };
      }
      this._operatorWithMotion(op, motion, count, reg);
      return { handled: true, edit: op !== "y" };
    }

    // plain commands
    const simple = this._simpleCommand(key);
    if (simple) return simple;

    // plain motions
    const motion = this._resolveMotionKey(key);
    if (motion) return this._doMotion(motion);

    if (key.length > 1) return { handled: false };
    this.onStatus(`unmapped: ${key}`);
    return { handled: true };
  }

  _resolveMotionKey(key) {
    const named = new Set([
      "h", "l", "j", "k", "w", "b", "e", "W", "B", "E", "0", "^", "$",
      "g0", "g$", "g^", "gj", "gk",
      "{", "}", "(", ")", "%", "n", "N", "*", "#", "|", "+", "-", "_",
      "CR", " ", "H", "M", "L", "G", "gg", "/", "?",
    ]);
    if (named.has(key)) return key;
    return null;
  }

  _simpleCommand(key) {
    const p = this.pending;
    const count = () => this._takeCount(1);
    switch (key) {
      case "x": return this._deleteChars(count(), false);
      case "X": return this._deleteChars(count(), true);
      case "D": return this._applyOperatorToEol("d", count());
      case "C": return this._applyOperatorToEol("c", count());
      case "Y": { const c = count(); return this._applyLinewiseOperator("y", c, true); }
      case "s": {
        const c = count();
        // `s` inserts where the deletion STARTED, not where a plain delete leaves
        // the cursor: `$s` on "abc" must insert after 'b' ("abZ"), and a delete
        // that runs to the end of the line clamps the cursor one character left,
        // which would put the typed text there instead. Found by the extended
        // matrix (s, S, C were not in it), measured against vim.
        const at = this.state.cursor;
        this._deleteChars(c, false);
        this._enterInsert("s", 1, at);
        return { handled: true, edit: true };
      }
      case "S": { const c = count(); this._applyLinewiseOperator("c", c); return { handled: true, edit: true, enterInsert: true }; }
      case "~": return this._toggleCase(count());
      case "J": return this._join(count());
      case "p": case "P": return this._put(count(), key === "P");
      case "u": return this._undo();
      case "U": return this._restoreLine();
      case "C-r": return this._redo();
      case ".": return this._repeat();
      case "v": this.mode = Mode.VISUAL; this.visual = { anchor: this.state.cursor }; return { handled: true };
      case "V": this.mode = Mode.VISUAL_LINE; this.visual = { anchor: this.state.cursor }; return { handled: true };
      case ":": this.prompt = "ex"; return { handled: true, prompt: { kind: "ex", initial: ":" } };
      case "/": this.prompt = "search"; this._promptDirection = "/"; return { handled: true, prompt: { kind: "search", initial: "/" } };
      case "?": this.prompt = "search"; this._promptDirection = "?"; return { handled: true, prompt: { kind: "search", initial: "?" } };
      case "C-d": case "C-u": return this._halfPage(key === "C-d" ? 1 : -1);
      case "C-e": case "C-y": return this._scrollLines(key === "C-e" ? 1 : -1);
      case "C-a": return this._adjustNumber(this._takeCount(1));
      case "C-x": return this._adjustNumber(-this._takeCount(1));
      case "C-f": case "C-b": return this._page(key === "C-f" ? 1 : -1);
      case ";": case ",": return this._repeatFind(key === ";");
      case "C-g": return this._status();
      case "z": p.awaiting = "z"; return { handled: true };
      default: return null;
    }
  }

  /**
   * Where a mark motion lands. `'` goes to the first non-blank of the mark's line and
   * is LINEWISE (so `d'a` takes whole lines), ``` `` ``` goes to the exact position and
   * is charwise. One definition, because the same motion has to serve a plain jump, an
   * operator, and a visual-mode extension.
   */
  _markMotion(kind, key) {
    const off = this.marks.get(key);
    if (off == null) return null;
    if (kind === "'") return { to: B.firstNonBlank(this.text, off), linewise: true };
    return { to: off, charwise: true };
  }

  _consumeArgument(kind, key) {
    const p = this.pending;
    p.awaiting = null;
    const count = this._takeCount(1);

    if (kind === "register") {
      // Supported: a-z, "+"/"*" (the system clipboard) and `""` for the unnamed
      // register. Anything else is REFUSED here, before the command runs: vim's
      // "1-"9, "-" and "=" are deliberately not implemented (registers.js says why),
      // and a half-executed `"1dd` that deleted the line and stored it nowhere would
      // be worse than an error.
      if (!isClipboard(key) && key !== '"' && key !== "_" && !isNamed(key)) {
        // Vim rejects the whole command (E354) rather than falling back to the unnamed
        // register, so the next key is swallowed: `"1dd` must not delete the line.
        this.onStatus(`unsupported register: ${key}`, "error");
        this.pending = this._emptyPending();
        this._swallowNext = true;
        return { handled: true };
      }
      p.reg = key === '"' ? null : key;
      return { handled: true };
    }
    if (kind === "replaceChar") {
      return this._replaceChars(count, key);
    }
    if (kind === "f" || kind === "F" || kind === "t" || kind === "T") {
      this.lastFind = { kind, char: key, forward: kind === "f" || kind === "t" };
      const motion = this._charMotion(kind, key, count);
      if (p.op) {
        const op = p.op;
        this.pending = this._emptyPending();
        this._operatorWithMotionResult(op, motion, count, p.reg);
        return { handled: true, edit: op !== "y" };
      }
      this.state.cursor = motion.to;
      this._setDesiredCol();
      return { handled: true };
    }
    if (kind === "mark") {
      if (/[a-z]/.test(key)) {
        this.marks.set(key, this.state.cursor);
        this.onStatus(`mark ${key} set`);
      }
      this.pending = this._emptyPending();
      return { handled: true };
    }
    if (kind === "'" || kind === "`") {
      const op = p.op;
      const reg = p.reg;
      this.pending = this._emptyPending();
      const motion = this._markMotion(kind, key);
      if (!motion) { this.onStatus(`mark ${key} not set`, "error"); return { handled: true }; }
      if (op) {
        // `d`a` and friends: the mark IS a motion, so it goes through the same
        // operator range code as `db` or `de` - including the exclusive-linewise rule.
        return this._operatorWithMotionResult(op, motion, 1, reg);
      }
      this.state.cursor = motion.to;
      this._setDesiredCol();
      return { handled: true };
    }
    if (kind === "z") {
      const vp = this._viewport();
      this.pending = this._emptyPending();
      if (!vp) { this.onStatus("no viewport on this host", "error"); return { handled: true }; }
      const row = this._rowIndex(this.state.cursor);
      const line = row ?? B.lineNumber(this.text, this.state.cursor);
      const target = key === "t" ? line : key === "b" ? Math.max(0, line - vp.height + 1) : Math.max(0, line - Math.floor(vp.height / 2));
      this.onScroll(target);
      return { handled: true };
    }
    this.pending = this._emptyPending();
    return { handled: true };
  }

  // --- screen lines --------------------------------------------------------
  // A wrapped line has more screen lines than buffer lines, and vim keeps the two
  // apart on purpose: `j`/`k`/`0`/`$` are buffer-line motions, `gj`/`gk`/`g0`/`g$`
  // are screen-line motions, and `<Up>`/`<Down>` are screen-line motions too when
  // 'wrap' is set. The host supplies the measurement the same way it supplies a
  // viewport - `metrics(offset) -> {x, y, width, height}` in CONTENT coordinates,
  // so scrolling cannot affect it. Without it the g-motions fall back to the
  // buffer-line ones, which is exactly right for a host that cannot wrap.
  _point(offset) {
    if (typeof this.metrics !== "function") return null;
    const t = this.text;
    const at = Math.max(0, Math.min(offset, Math.max(0, t.length - 1)));
    return this.metrics(at) || null;
  }

  /** Same screen line? Half a line box of tolerance absorbs fractional heights. */
  _sameRow(a, b) {
    if (!a || !b) return false;
    const h = Math.max(1, (a.height || 16) * 0.5);
    return Math.abs(a.y - b.y) < h;
  }

  /**
   * The screen row containing `offset`, as the first and last character offsets of
   * that row. Bounded by the buffer line, because a soft wrap never crosses a hard
   * line break - which also keeps the binary searches short.
   */
  _screenRow(offset) {
    const t = this.text;
    const here = this._point(offset);
    if (!here) return null;
    const lineStart = B.lineStart(t, offset);
    const lineEnd = B.lastCharOffset(t, offset);
    if (lineEnd <= lineStart) return { start: lineStart, end: lineStart };

    // first offset on the row
    let lo = lineStart, hi = offset;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._sameRow(this._point(mid), here)) hi = mid; else lo = mid + 1;
    }
    const start = lo;

    // last offset on the row
    let a = offset, b = lineEnd;
    if (this._sameRow(this._point(lineEnd), here)) {
      a = lineEnd;
    } else {
      while (a < b) {
        const mid = (a + b + 1) >> 1;
        if (this._sameRow(this._point(mid), here)) a = mid; else b = mid - 1;
      }
    }
    return { start, end: Math.max(start, a) };
  }

  /** First offset of the row after `rowEnd`, or null at the end of the buffer. */
  _nextScreenRow(rowEnd) {
    const t = this.text;
    let next = rowEnd + 1;
    if (next >= t.length) return null;
    if (t[next] === "\n") next += 1; // a hard line break ends the row
    return next < t.length ? next : null;
  }

  /** Last offset of the row before `rowStart`, or null at the start of the buffer. */
  _prevScreenRow(rowStart) {
    const t = this.text;
    if (rowStart <= 0) return null;
    let prev = B.prevChar(t, rowStart);
    if (t[prev] === "\n" && prev > 0) prev = B.prevChar(t, prev);
    const row = this._screenRow(prev);
    return row ? row.end : null;
  }

  /**
   * The offset in [start, end] nearest `x`. vim keeps the SCREEN COLUMN, which is
   * the character's index within the row - that is its left edge, not a pixel
   * centre, so `gj` from the second character of a row lands on the second
   * character of the next one.
   */
  _offsetNearX(start, end, x) {
    let lo = start, hi = end;
    while (lo < hi) {
      const mid = lo + ((hi - lo) >> 1);
      const p = this._point(mid);
      if (!p) return mid;
      if (p.x < x) lo = mid + 1; else hi = mid;
    }
    if (lo > start) {
      const a = this._point(lo - 1);
      const b = this._point(lo);
      if (a && b && Math.abs(a.x - x) <= Math.abs(b.x - x)) return lo - 1;
    }
    return lo;
  }

  /**
   * The visible column window of a horizontally scrolled field. With 'wrap' off the
   * screen line is only the VISIBLE part of a long line, so vim's g0/g$/g^ are relative
   * to that window rather than to the line (measured: `:help g0` - "when 'wrap' is off,
   * this goes to the first character of the display line"). Null when the host cannot
   * report one, which is the wrapping case where the row model already covers it.
   */
  _hscrollWindow() {
    if (typeof this.hscroll !== "function") return null;
    const w = this.hscroll();
    return w && typeof w.from === "number" && typeof w.to === "number" && w.to >= w.from ? w : null;
  }

  /** Document screen row of an offset (0-based), or null without a measurement. */
  _rowIndex(offset) {
    const p = this._point(offset);
    if (!p) return null;
    return Math.round(p.y / Math.max(1, p.height));
  }

  /**
   * The offset on screen row `row`, at the screen column nearest `x` - what a
   * viewport command needs, because `viewport()` speaks rows (clientHeight /
   * lineHeight) and feeding a row to lineOffset() is wrong the moment anything
   * wraps. Null when the row does not exist (before the top, after the bottom).
   */
  _offsetAtRow(row, x = 0) {
    const t = this.text;
    const last = Math.max(0, t.length - 1);
    const p0 = this._point(0);
    if (!p0) return null;
    const h = Math.max(1, p0.height);
    const rowOf = (i) => Math.round(this._point(i).y / h);
    if (row < 0) return null;
    // a window taller than the buffer asks for a row that does not exist: vim
    // clamps H/M/L to the last line, so clamp to the last row rather than refusing
    const lastRow = rowOf(last);
    if (row > lastRow) row = lastRow;
    let lo = 0, hi = last;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowOf(mid) < row) lo = mid + 1; else hi = mid;
    }
    if (rowOf(lo) !== row) return null;
    const rowStart = lo;
    let a = rowStart, b = last;
    while (a < b) {
      const mid = (a + b + 1) >> 1;
      if (rowOf(mid) === row) a = mid; else b = mid - 1;
    }
    return this._offsetNearX(rowStart, a, x);
  }

  /** Where a viewport command lands: the row's own start, or the first non-blank
   *  when that row also begins its buffer line (H/M/L in vim go to the
   *  first non-blank of the LINE, which a wrapped row may be in the middle of). */
  _rowLanding(row, x = 0) {
    const at = this._offsetAtRow(row, x);
    if (at == null) return null;
    return at === B.lineStart(this.text, at) ? B.firstNonBlank(this.text, at) : at;
  }

  /** `gj`/`gk`: the row above or below, at the same screen column. */
  _screenVertical(dir, count) {
    const t = this.text;
    const cur = this.state.cursor;
    const here = this._point(cur);
    if (!here) return null; // no measurement: the caller falls back to j/k
    const wantX = this.desiredX ?? here.x;
    let at = cur;
    for (let i = 0; i < count; i++) {
      const row = this._screenRow(at);
      if (!row) return null;
      const next = dir > 0 ? this._nextScreenRow(row.end) : this._prevScreenRow(row.start);
      if (next == null) break; // vim stops at the edge rather than beeping
      at = next;
    }
    const row = this._screenRow(at);
    if (!row) return null;
    if (this.desireRowEnd) return { to: row.end };
    return { to: this._offsetNearX(row.start, row.end, wantX) };
  }


  _viewport() {
    if (typeof this.viewport !== "function") return null;
    const vp = this.viewport();
    return vp && vp.height > 0 ? vp : null;
  }

  _setDesiredCol() {
    const s = B.lineStart(this.text, this.state.cursor);
    this.desiredCol = this.state.cursor - s;
  }

  /**
   * A caret that moved WITHOUT a command (a mouse click, an IME jump, the host
   * typing) invalidates both vertical wishes: desiredCol for j/k and desiredX for
   * gj/gk. Otherwise the next vertical motion uses the column from before the
   * click and the cursor "goes back" to where it was - which is what it looks like
   * when a wish outlives the caret it described.
   */
  _resetWishes() {
    this.desiredX = null;
    this.desireRowEnd = false;
    this._setDesiredCol();
  }

  _vertical(count, dir) {
    const text = this.text;
    const cur = this.state.cursor;
    const line = B.lineNumber(text, cur);
    if (this.desiredCol == null) this._setDesiredCol();
    const target = Math.max(0, Math.min(B.lineCount(text) - 1, line + dir * count));
    const start = B.lineOffset(text, target);
    const last = B.lastCharOffset(text, start);
    const col = Math.min(this.desiredCol, Math.max(0, last - start));
    return { to: start + col };
  }

  _motion(name, count, { forOperator = false } = {}) {
    const text = this.text;
    const cur = this.state.cursor;
    switch (name) {
      case "h": {
        let to = cur;
        for (let i = 0; i < count; i++) to = C.left(text, to);
        return { to, charwise: true };
      }
      case "l": {
        let to = cur;
        for (let i = 0; i < count; i++) to = C.right(text, to);
        return { to, charwise: true };
      }
      case "j": return { ...this._vertical(count, 1), linewise: true };
      case "k": return { ...this._vertical(count, -1), linewise: true };
      case "0": return { to: C.beginLine(text, cur), charwise: true };
      case "^": return { to: C.skipBlank(text, cur), charwise: true };
      case "$": {
        let line = B.lineNumber(text, cur);
        line = Math.min(B.lineCount(text) - 1, line + count - 1);
        return { to: C.endLine(text, B.lineOffset(text, line)), charwise: true, inclusive: true };
      }
      case "g0": {
        const win = this._hscrollWindow();
        if (win) return { to: win.from, charwise: true };
        const row = this._screenRow(cur);
        return { to: row ? row.start : C.beginLine(text, cur), charwise: true };
      }
      case "g$": {
        const win = this._hscrollWindow();
        if (win) return { to: win.to, charwise: true, inclusive: true };
        const row = this._screenRow(cur);
        if (!row) return { to: C.endLine(text, cur), charwise: true, inclusive: true };
        return { to: row.end, charwise: true, inclusive: true };
      }
      case "g^": {
        // first non-blank of the SCREEN line: the visible window when the field scrolls
        // horizontally, otherwise the wrapped row
        const win = this._hscrollWindow();
        let from;
        let to;
        if (win) { from = win.from; to = win.to; } else {
          const row = this._screenRow(cur);
          from = row ? row.start : C.beginLine(text, cur);
          to = row ? row.end : C.endLine(text, cur);
        }
        let k = from;
        while (k < to && B.isBlank(text[k])) k = B.nextChar(text, k);
        return { to: k, charwise: true };
      }
      case "gj": case "gk": {
        const r = this._screenVertical(name === "gj" ? 1 : -1, count);
        if (r) return { to: r.to, charwise: true };
        // no measurement (or no wrap): the buffer-line motion is the same thing
        return { ...this._vertical(count, name === "gj" ? 1 : -1), linewise: true };
      }
      case "|": {
        const s = B.lineStart(text, cur);
        const last = B.lastCharOffset(text, cur);
        return { to: Math.min(s + count - 1, last), charwise: true };
      }
      case "w": case "W": {
        let to = cur;
        for (let i = 0; i < count; i++) to = B.wordForward(text, to, name === "W");
        return { to: Math.min(to, Math.max(0, text.length - 1)), charwise: true };
      }
      case "b": case "B": {
        let to = cur;
        for (let i = 0; i < count; i++) to = B.wordBack(text, to, name === "B");
        return { to, charwise: true };
      }
      case "e": case "E": {
        let to = cur;
        for (let i = 0; i < count; i++) to = B.wordEnd(text, to, name === "E");
        return { to, charwise: true, inclusive: true };
      }
      // Exclusive linewise: the motion spans lines, so an operator takes whole lines,
      // but the line it LANDS on is not included (measured: "a\nb\n\nc\nd" + `d}` is
      // "\nc\nd", and `d{` from the last line is "a\nb\nd").
      case "}": {
        const raw = B.paragraphForward(text, cur, count);
        // `to` is where the CURSOR may land (a valid character); `end` is what an
        // operator takes, which is EOF when there is no further paragraph.
        return {
          to: Math.min(raw, Math.max(0, text.length - 1)),
          end: raw,
          linewise: true,
          exclusive: true,
        };
      }
      case "{": return { to: B.paragraphBack(text, cur, count), linewise: true, exclusive: true };
      case ")": return { to: B.sentenceForward(text, cur, count), charwise: true };
      case "(": return { to: B.sentenceBack(text, cur, count), charwise: true };
      case "%": {
        let k = cur;
        let hit = B.matchBracket(text, k);
        if (hit == null) {
          // scan the rest of the line for a bracket, as vi does
          const e = B.lineEnd(text, k);
          for (let p = k; p < e; p = B.nextChar(text, p)) {
            if ("()[]{}".includes(text[p])) { hit = B.matchBracket(text, p); if (hit != null) { k = p; break; } }
          }
        }
        if (hit == null) return null;
        return { to: hit, charwise: true, inclusive: true };
      }
      case "G": {
        const line = /^\d+$/.test(this.pending.count) ? parseInt(this.pending.count, 10) - 1 : B.lineCount(text) - 1;
        return { to: B.firstNonBlank(text, B.lineOffset(text, Math.min(line, B.lineCount(text) - 1))), linewise: true };
      }
      case "gg": {
        const line = count > 1 ? count - 1 : 0;
        return { to: B.firstNonBlank(text, B.lineOffset(text, line)), linewise: true };
      }
      case "+": case "CR": case "_": {
        const r = this._vertical(count, 1);
        return { to: B.firstNonBlank(text, r.to), linewise: true };
      }
      case "-": {
        const r = this._vertical(count, -1);
        return { to: B.firstNonBlank(text, r.to), linewise: true };
      }
      case " ": {
        const last = B.lastCharOffset(text, cur);
        return { to: Math.min(last, cur + count), charwise: true };
      }
      case "n": case "N": {
        if (!this.lastSearch) { this.onStatus("no previous pattern", "error"); return null; }
        const forward = (name === "n") === this.lastSearchForward;
        return this._searchMotion(this.lastSearch, forward, count);
      }
      case "*": case "#": {
        const word = this._wordUnderCursor();
        if (!word) return null;
        // `\\b`, not vim's `\\<` / `\\>`: those are VIM syntax and JS reads them as a
        // literal "<", so `*` searched for "<alpha>" and never moved (found by the
        // coverage sweep — nothing had ever run this line).
        this.lastSearch = `\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`;
        this.lastSearchForward = name === "*";
        return this._searchMotion(this.lastSearch, name === "*", count);
      }
      case "H": case "M": case "L": {
        const vp = this._viewport();
        if (!vp) { this.onStatus("no viewport on this host", "error"); return null; }
        const here = this._point(cur);
        const row = name === "H" ? vp.top + count - 1
          : name === "L" ? vp.top + vp.height - count
            : vp.top + Math.floor(vp.height / 2);
        // a screen row is the unit the viewport speaks, so the target is a row
        const landing = this._rowLanding(row, here ? here.x : 0);
        if (landing != null) return { to: landing, linewise: true };
        // no measurement on this host: fall back to counting buffer lines
        const lastLine = B.lineCount(text) - 1;
        const line = Math.max(0, Math.min(lastLine, row));
        return { to: B.firstNonBlank(text, B.lineOffset(text, line)), linewise: true };
      }
      case "/": case "?": {
        this.prompt = "search";
        this._promptDirection = name;
        return null;
      }
      default:
        return null;
    }
  }

  _repeatFind(same) {
    const last = this.lastFind;
    if (!last) { this.onStatus("no previous f/t", "error"); return { handled: true }; }
    const count = this._takeCount(1);
    const kind = same ? last.kind : { f: "F", F: "f", t: "T", T: "t" }[last.kind];
    const motion = this._charMotion(kind, last.char, count);
    if (motion.failed) { this.onStatus(`character not found: ${last.char}`, "error"); return { handled: true }; }
    this.state.cursor = motion.to;
    this._setDesiredCol();
    this.lastFind = { ...last, kind };
    return { handled: true };
  }

  _charMotion(kind, ch, count) {
    const text = this.text;
    let pos = this.state.cursor;
    const forward = kind === "f" || kind === "t";
    for (let i = 0; i < count; i++) {
      const s = B.lineStart(text, pos);
      const e = B.lineEnd(text, pos);
      let hit = -1;
      if (forward) {
        for (let p = B.nextChar(text, pos); p < e; p = B.nextChar(text, p)) {
          if (text[p] === ch) { hit = p; break; }
        }
      } else {
        for (let p = B.prevChar(text, pos); p >= s; p = B.prevChar(text, p)) {
          if (text[p] === ch) { hit = p; break; }
          if (p === 0) break;
        }
      }
      if (hit === -1) return { to: pos, charwise: true, failed: true };
      pos = kind === "t" ? (forward ? B.prevChar(text, hit) : B.nextChar(text, hit)) : hit;
    }
    // `f` lands ON a character and `t` lands on the one BEFORE the target; under an
    // operator both ranges include the character they land on (measured against vim:
    // "alpha,beta" + `dt,` deletes "alpha", not "alph"). Only the plain motion differs.
    return { to: pos, charwise: true, inclusive: true };
  }

  _wordUnderCursor() {
    const text = this.text;
    const s = B.lineStart(text, this.state.cursor);
    const e = B.lineEnd(text, this.state.cursor);
    let a = this.state.cursor;
    let b = this.state.cursor;
    if (!B.isWordChar(text[a])) return null;
    while (a > s && B.isWordChar(text[B.prevChar(text, a)])) a = B.prevChar(text, a);
    while (b < e && B.isWordChar(text[b])) b = B.nextChar(text, b);
    return text.slice(a, b);
  }

  /** The same pattern from the other end of the buffer — `'wrapscan'` is on by default. */
  _searchWrap(text, re, pos, forward) {
    re.lastIndex = 0;
    if (forward) {
      const m = re.exec(text);
      return m && m.index <= pos ? m.index : null;
    }
    let best = -1, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index >= pos) best = m.index;
      if (m[0] === "") re.lastIndex++;
    }
    return best >= 0 ? best : null;
  }

  _searchMotion(pattern, forward, count) {
    let re;
    try {
      re = new RegExp(pattern, this.options.ignorecase ? "gi" : "g");
    } catch (err) {
      this.onStatus(`bad pattern: ${err.message}`, "error");
      return null;
    }
    const text = this.text;
    let pos = this.state.cursor;
    for (let i = 0; i < count; i++) {
      let found = -1;
      if (forward) {
        re.lastIndex = re.lastIndex = B.nextChar(text, pos);
        const before = text.slice(0, pos + 1);
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          if (m.index > pos) { found = m.index; break; }
          if (m.index === pos) { re.lastIndex = pos + 1; continue; }
        }
      } else {
        re.lastIndex = 0;
        let m;
        let best = -1;
        while ((m = re.exec(text)) !== null) {
          if (m.index < pos) best = m.index;
          else break;
          if (m[0] === "") re.lastIndex++;
        }
        found = best;
      }
      if (found < 0) {
        // vim wraps by default ('wrapscan'): search from the other end before giving up.
        const wrapped = this._searchWrap(text, re, pos, forward);
        if (wrapped == null) {
          this.onStatus(pattern + (forward ? ": not found" : ": not found backwards"), "error");
          break;
        }
        found = wrapped;
      }
      pos = found;
    }
    if (this.options.showmatch) this.flashRange?.(pos, pos + 1);
    return { to: pos, charwise: true };
  }

  _doMotion(name) {
    const count = this._takeCount(1);
    const screenMotion = name === "gj" || name === "gk";
    if (screenMotion && this.desiredX == null && !this.desireRowEnd) {
      // before the move: afterwards the wish would just be "where I landed"
      const p = this._point(this.state.cursor);
      if (p) this.desiredX = p.x;
    }
    const motion = this._motion(name, count, {});
    this.pending = this._emptyPending();
    if (!motion) return { handled: true };
    this.state.cursor = Math.max(0, Math.min(motion.to, Math.max(0, this.text.length - 1)));
    // `$` sets vim's curswant to MAXCOL (measured: `j$k` keeps the end-of-line
    // wish, so `k` lands on the last character however short the target line is).
    if (name === "$") this.desiredCol = Infinity;
    else if (LINE_MOTIONS.has(name)) { /* keep desiredCol */ }
    else this._setDesiredCol();
    // The screen-line wish is a separate track: gj/gk keep it (so a short row does
    // not lose the column), g$ remembers "end of the row", anything else drops it.
    if (name === "g$") this.desireRowEnd = true;
    else if (!screenMotion) {
      this.desiredX = null;
      this.desireRowEnd = false;
    }
    return { handled: true };
  }

  // --- operators -----------------------------------------------------------
  _applyLinewiseOperator(op, count, keepCursor = false) {
    const text = this.text;
    const startLine = B.lineNumber(text, this.state.cursor);
    const endLine = Math.min(B.lineCount(text) - 1, startLine + count - 1);
    const from = B.lineOffset(text, startLine);
    let to = B.lineEnd(text, B.lineOffset(text, endLine));
    // `c` replaces the *content* of the line(s) and keeps the line itself;
    // `d` and `y` take the line including its newline.
    if (op !== "c" && to < text.length) to += 1;
    return this._applyOperatorRange(op, from, to, true, true, keepCursor, this._takeReg());
  }

  /** Shift the lines a motion spans (`>j`, `>G`, `>ap` treated linewise). */
  _shiftByMotion(motionName, count, right) {
    const m = this._motion(motionName, count, { forOperator: true });
    if (!m) { this.onStatus("motion failed", "error"); return { handled: true }; }
    if ((motionName === "j" || motionName === "k") && m.to === this.state.cursor) {
      this.onStatus("motion failed", "error");
      return { handled: true };
    }
    const text = this.text;
    const a = Math.min(this.state.cursor, m.to);
    const b = Math.max(this.state.cursor, m.to);
    const from = B.lineOffset(text, B.lineNumber(text, a));
    const to = B.lineEnd(text, B.lineOffset(text, B.lineNumber(text, b)));
    return this._shiftLines(from, to, right);
  }

  _applyOperatorToEol(op, count) {
    const text = this.text;
    const line = B.lineNumber(text, this.state.cursor);
    const lastLine = Math.min(B.lineCount(text) - 1, line + count - 1);
    const from = this.state.cursor;
    const to = B.lineEnd(text, B.lineOffset(text, lastLine));
    return this._applyOperatorRange(op, from, to, false, true, false, this._takeReg());
  }

  _operatorWithMotion(op, name, count, reg) {
    // `cw` is `ce` when the cursor is on a non-blank, `dw` when it is on a blank.
    let effective = name;
    if (op === "c" && (name === "w" || name === "W")) {
      const text = this.text;
      const cur = this.state.cursor;
      const c = B.charAt(text, cur);
      const big = name === "W";
      const kind = (ch) => (ch === undefined || /\s/.test(ch) ? "space" : big || B.isWordChar(ch) ? "word" : "punct");
      const here = kind(c);
      const next = kind(B.charAt(text, B.nextChar(text, cur)));
      if (B.isLineEmpty(text, cur) && count === 1) {
        // measured: `cw` on an empty line deletes NOTHING and just enters insert.
        // (`dw` there does delete the line break, and `c2w` deletes as usual, so
        // this is the c+w special case, not a general rule.)
        this._enterInsert("c");
        return { handled: true, edit: true, enterInsert: true };
      }
      if (here !== "space" && next === here) {
        // still inside the word: change to its end
        effective = big ? "E" : "e";
      } else if (here !== "space") {
        // already at the end of the word: change just this character
        effective = "l";
      }
    }
    let motion = this._motion(effective, count, { forOperator: true });
    if (!motion || motion.failed) { this.onStatus("motion failed", "error"); return { handled: true }; }
    // `dw` on the last word of a line does not take the line break (vim; busybox
    // does the same by stepping back off the newline in find_range)
    if ((name === "w" || name === "W") && (op === "d" || op === "y" || op === "c")) {
      const text = this.text;
      const from = B.lineNumber(text, this.state.cursor);
      // ... but not when the cursor is on an empty line: there `dw` really does
      // take the line break (measured: "a\n\nb" + `jdw` is "a\nb").
      if (B.lineNumber(text, motion.to) > from && !B.isLineEmpty(text, this.state.cursor)) {
        motion = { to: B.lastCharOffset(text, this.state.cursor), charwise: true, inclusive: true };
      }
    }
    return this._operatorWithMotionResult(op, motion, count, reg, effective);
  }

  _operatorWithMotionResult(op, motion, count, reg, name = "") {
    const text = this.text;
    const cur = this.state.cursor;
    const linewise = !!motion.linewise || LINE_MOTIONS.has(name);
    if (linewise) {
      const a = Math.min(cur, motion.to);
      const b = Math.max(cur, motion.to);
      let from = B.lineOffset(text, B.lineNumber(text, a));
      if (motion.exclusive) {
        // `d}` / `d{`: the motion spans lines, so the operator takes whole lines, but
        // the line it LANDS on is excluded — the range is [start(a), start(b)). Measured
        // in both directions: "a\nb\n\nc\nd" + `d}` is "\nc\nd"; `Gd{` is "a\nb\nd".
        // A motion that ran out of paragraphs reports `end` past the last character, and
        // then the range really is the rest of the buffer (vim: `d}` on the last
        // paragraph deletes to EOF).
        // `b`, not `motion.to`: a BACKWARD motion (`d{`) reports the small offset, and
        // the range has to end at the cursor's line, not at the motion's start.
        const end = motion.end ?? b;
        if (end >= text.length) {
          // The motion ran out of paragraphs and ended at EOF. Vim backs an exclusive
          // motion's end off by one character, which changes the SHAPE at the last line:
          //   `Gd}` on the last line EMPTIES it   ("…e\nf" -> "…e\n", an empty line left)
          //   `GdG` / `Gdd` remove the line       ("…e\nf" -> "…e")
          //   `d}` from an earlier line takes whole lines to the end.
          const lastLine = B.lineCount(text) - 1;
          if (B.lineNumber(text, a) === lastLine) {
            return this._applyOperatorRange(op, from, Math.max(from, text.length - 1), false, true, false, reg);
          }
          return this._applyOperatorRange(op, from, text.length, true, true, false, reg);
        }
        const to = B.lineOffset(text, B.lineNumber(text, end));
        return this._applyOperatorRange(op, from, to, true, true, false, reg);
      }
      let to = B.lineEnd(text, B.lineOffset(text, B.lineNumber(text, b)));
      if (to < text.length) to += 1;
      else if (from > 0) from -= 1;
      return this._applyOperatorRange(op, from, to, true, true, false, reg);
    }
    const from = Math.min(cur, motion.to);
    let to = Math.max(cur, motion.to);
    const crossed = B.lineNumber(text, from) !== B.lineNumber(text, to);
    if (motion.inclusive) {
      // An inclusive motion stops at the end of the line it landed in: `$` on an
      // empty line is a no-op, `de` on the last word does not take the newline.
      const extended = to < text.length && text[to] !== "\n" ? B.nextChar(text, to) : to;
      // Exclusive-linewise, the other way round: a motion that crossed a line
      // break and covers the whole tail of its target line takes whole lines
      // (measured: `de` from an empty line deletes "\nword\n", not "\nword").
      // It needs the same start condition - a `de` that begins mid-line inside a
      // word stops at the target word's end instead ("abc\ndef" + `$de` is "ab").
      if (crossed && from === B.firstNonBlank(text, from)
          && extended < text.length && text[extended] === "\n") {
        const lastLine = B.lineNumber(text, to);
        return this._applyOperatorRange(
          op,
          B.lineOffset(text, B.lineNumber(text, from)),
          B.lineEnd(text, B.lineOffset(text, lastLine)) + 1,
          true, true, false, reg,
        );
      }
      to = extended;
      return this._applyOperatorRange(op, from, to, false, true, false, reg);
    }
    if (crossed && to === B.lineStart(text, to)) {
      // Exclusive-linewise: a charwise motion that starts on the first non-blank
      // of a line and ends on a line boundary becomes LINEWISE (vim; measured
      // with `db` from column 1). Otherwise the end steps back off the newline
      // so the delete does not swallow the line break.
      if (from === B.firstNonBlank(text, from)) {
        const lastLine = B.lineNumber(text, to) - 1;
        return this._applyOperatorRange(
          op,
          B.lineOffset(text, B.lineNumber(text, from)),
          B.lineEnd(text, B.lineOffset(text, lastLine)) + 1,
          true, true, false, reg,
        );
      }
      to = B.prevChar(text, to);
    }
    return this._applyOperatorRange(op, from, to, false, true, false, reg);
  }

  _applyOperatorRange(op, from, to, linewise, record, keepCursor = false, reg = null, inclusive = false, undoCursor = null) {
    const text = this.text;
    from = Math.max(0, Math.min(from, text.length));
    to = Math.max(from, Math.min(to, text.length));
    if (inclusive) to = Math.min(text.length, B.nextChar(text, to));
    const slice = text.slice(from, to);
    // The undo snapshot's cursor is where vim puts the cursor after `u`: the START of the
    // changed range, not wherever the cursor happened to be. A visual selection carries
    // the HEAD in `state.cursor`, and a backward one is on the wrong side entirely —
    // measured (`vll` then `d`/`~`/`>` then `u` returns to 1:1, and a backward `llvhd`
    // returns to 1:2, i.e. the min of the range, every time).
    const before = { text, cursor: undoCursor == null ? this.state.cursor : undoCursor };

    if (op === "y") {
      this._storeRegister(slice, linewise, reg);
      this._noteChange({ kind: "op", op, from, to, linewise });
      // measured (vim): after a CHARWISE yank the cursor sits at the start of the
      // yanked text, so a backward `yb`/`y\`a` moves it back; a linewise yank leaves
      // the cursor where it was.
      if (!linewise) this.state.cursor = from;
      return { handled: true, edit: false };
    }

    this._pushUndo(before);
    this._storeRegister(slice, linewise, reg);
    this._setText(text.slice(0, from) + text.slice(to));
    this.state.cursor = Math.min(from, Math.max(0, this.state.text.length - 1));
    if (linewise) {
      const ln = B.lineNumber(this.state.text, Math.min(this.state.cursor, Math.max(0, this.state.text.length - 1)));
      this.state.cursor = B.lineNumber(this.state.text, this.state.cursor) === ln
        ? B.firstNonBlank(this.state.text, B.lineOffset(this.state.text, ln))
        : this.state.cursor;
    }
    this._noteChange({ kind: "op", op, from, to, linewise });
    if (op === "c") {
      this._enterInsert("c");
      return { handled: true, edit: true, enterInsert: true };
    }
    this._setDesiredCol();
    return { handled: true, edit: true };
  }

  // --- helpers used by the `:` line ---------------------------------------
  yankRange(from, to, linewise, reg = null) {
    this._storeRegister(this.text.slice(from, to), linewise, reg);
  }

  /** Delete a range for the `:` commands, recording it in the registers like any other
   *  delete (vim does the same for `:d`; it is NOT a yank, whatever `:y` says). */
  deleteRange(from, to, { record = true, linewise = false, reg = null } = {}) {
    const text = this.text;
    this._storeRegister(text.slice(from, to), linewise, reg);
    this._pushUndo({ text, cursor: this.state.cursor });
    this._setText(text.slice(0, from) + text.slice(to));
    this.state.cursor = Math.min(from, Math.max(0, this.state.text.length - 1));
    if (record) this._noteChange({ kind: "del", count: 1 });
    return { handled: true, edit: true };
  }

  noteLineChange() { /* line-level bookkeeping hook; `U` uses lineSnapshot */ }

  /**
   * Is this a register name we refuse? Returns the message, or "" when it is fine.
   *
   * The ex commands take the register as an ARGUMENT (`:d a`), which means they can be
   * validated before anything is deleted — vim answers E354 and leaves the buffer alone,
   * so `:d 1` must not delete the line and then discover it has nowhere to put it.
   */
  badRegister(name) {
    if (!name) return "";
    if (name === "_" || isClipboard(name) || isNamed(name)) return "";
    return `E354: Invalid register name: '${name}'`;
  }

  _storeRegister(slice, linewise, reg = null) {
    const res = this.registers.write({ text: slice, linewise, name: reg });
    if (!res.ok) this.onStatus(res.error, "error");
    return res.ok;
  }

  /**
   * Take the pending register prefix, and clear it.
   *
   * A register prefix applies to ONE command. Leaving it in `pending` made a plain `p`
   * re-use the named register for ever: `"ayw … "ap … p` pasted `a` twice, measured on
   * the old code. The operator path already resets `pending` when it fires; the
   * single-key commands have to consume the name explicitly.
   */
  _takeReg() {
    const name = this.pending.reg;
    this.pending.reg = null;
    return name;
  }

  _textObject(prefix, target) {
    const text = this.text;
    const cur = this.state.cursor;
    const inner = prefix === "i";
    const lineS = B.lineStart(text, cur);
    const lineE = B.lineEnd(text, cur);

    if (target === "w" || target === "W") {
      const big = target === "W";
      const cls = (c) => (c === undefined || /\s/.test(c) ? "space" : big ? "word" : B.isWordChar(c) ? "word" : "punct");
      const kind = cls(text[cur]);
      let a = cur;
      let b = cur;
      if (kind === "space") {
        while (a > lineS && cls(text[B.prevChar(text, a)]) === "space") a = B.prevChar(text, a);
        while (b < lineE && cls(text[b]) === "space") b = B.nextChar(text, b);
        return { from: a, to: b, inclusive: false };
      }
      while (a > lineS && cls(text[B.prevChar(text, a)]) === kind) a = B.prevChar(text, a);
      while (b < lineE && cls(text[b]) === kind) b = B.nextChar(text, b);
      if (inner) return { from: a, to: b, inclusive: false };
      while (b < lineE && cls(text[b]) === "space") b = B.nextChar(text, b);
      return { from: a, to: b, inclusive: false };
    }
    if (target === '"' || target === "'" || target === "`") {
      let a = -1;
      let b = -1;
      for (let p = lineS; p < lineE; p++) if (text[p] === target) { if (a < 0) a = p; else { b = p; break; } }
      if (a < 0 || b < 0 || cur < a || cur > b + 1) return null;
      if (inner) return { from: a + 1, to: b, inclusive: false };
      // vim's `a"` also takes the trailing white space but stops at the newline
      let to = B.nextChar(text, b);
      while (to < lineE && /[ \t]/.test(text[to])) to = B.nextChar(text, to);
      return { from: a, to, inclusive: false };
    }
    // Brackets: Vim's current_block() (src/textobject.c). The cursor does NOT
    // have to sit inside the block:
    //   1. on the opener            -> use it
    //   2. else search BACKWARDS for an unmatched opener (one whose closer is
    //      still ahead of the cursor)
    //   3. else search FORWARDS for the next opener
    //   4. then match its closer; if either search fails there is no object
    const pairs = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };
    if (pairs[target]) {
      const open = "([{<".includes(target) ? target : pairs[target];
      const close = ")]}>"["([{<".indexOf(open)];

      let start = -1;
      if (text[cur] === open) {
        start = cur;                                   // 1
      }
      if (start < 0) {                                  // 2: unmatched opener behind us
        let depth = 0;
        for (let p = B.prevChar(text, cur); p >= 0; p = B.prevChar(text, p)) {
          const c = text[p];
          if (c === close) depth++;
          else if (c === open) {
            if (depth > 0) depth--;
            else { start = p; break; }
          }
          if (p === 0) break;
        }
      }
      if (start < 0) {                                  // 3: nearest opener ahead
        for (let p = cur; p < text.length; p = B.nextChar(text, p)) {
          if (text[p] === open) { start = p; break; }
        }
      }
      if (start < 0) return null;

      const end = B.matchBracket(text, start);           // 4
      if (end == null || end < cur) return null;

      if (!inner) return { from: start, to: B.nextChar(text, end), inclusive: false };
      let from = B.nextChar(text, start);
      const to = end;
      // Vim keeps the newline that follows the opener in a multi-line block
      // (`di(` on "foo(\n  body\n)" leaves "foo(\n)").
      if (text[from] === "\n") from = B.nextChar(text, from);
      if (from > to) return null;
      return { from, to, inclusive: false };
    }

    if (target === "p") {
      const startLine = B.lineNumber(text, cur);
      let a = startLine;
      let b = startLine;
      while (a > 0 && !B.isLineEmpty(text, B.lineOffset(text, a - 1))) a--;
      while (b < B.lineCount(text) - 1 && !B.isLineEmpty(text, B.lineOffset(text, b + 1))) b++;
      let from = B.lineOffset(text, a);
      let to = B.lineEnd(text, B.lineOffset(text, b));
      if (to < text.length) to += 1;
      return { from, to, inclusive: false, linewise: true };
    }
    if (target === "e") return { from: 0, to: text.length, inclusive: false };
    return null;
  }

  // --- edits ---------------------------------------------------------------
  /**
   * vim's unit of undo is the CHANGE COMMAND, not the operation under it: `s`,
   * `cw` and `cc` record one block and the insert they open belongs to it, so a
   * single `u` puts back the deletion *and* what was typed. Measured: vim and
   * nvi agree on every one of those. busybox does not - its undo is
   * per-operation, so `sX<Esc>u` there undoes only the insert - which is why this
   * rule is taken from vim/nvi and not from the scope oracle.
   *
   * Recording opens a block on the first mutation of a command and commits it
   * when the command finishes (`_closeUndo`). A block that changed no text is
   * dropped rather than becoming an undo step that does nothing, which is what
   * `i<Esc>u` must not create.
   */
  _pushUndo(snapshot) {
    if (this.undoBlock) return; // already recording this change
    this.undoBlock = { text: snapshot.text, cursor: snapshot.cursor };
  }

  _closeUndo() {
    const block = this.undoBlock;
    this.undoBlock = null;
    if (!block) return;
    if (block.text === this.text) return; // nothing changed: not an undo step
    this.undoStack.push(block);
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  _deleteChars(count, backwards) {
    const text = this.text;
    const before = { text, cursor: this.state.cursor };
    const cur = this.state.cursor;
    let from = cur;
    let to = cur;
    if (backwards) {
      const ls = B.lineStart(text, cur);
      for (let i = 0; i < count && from > ls; i++) from = C.left(text, from);
    } else {
      const last = B.lastCharOffset(text, cur);
      for (let i = 0; i < count; i++) {
        if (to > last) break;
        to = B.nextChar(text, to);
      }
      if (to > last) to = Math.min(text.length, B.lineEnd(text, cur));
    }
    if (from === to) return { handled: true };
    const slice = text.slice(from, to);
    this._pushUndo(before);
    this._storeRegister(slice, false, this._takeReg());
    this._setText(text.slice(0, from) + text.slice(to));
    this.state.cursor = B.clampToLineEnd(this.state.text, Math.min(from, Math.max(0, this.state.text.length - 1)), from);
    this._setDesiredCol();
    this._noteChange({ kind: "del", count, backwards });
    return { handled: true, edit: true };
  }

  /**
   * The character a key argument means when it has to become TEXT rather than act.
   *
   * `CR`, `Tab` and `BS` are TOKENS in this engine's key notation (`r<CR>`, `i<CR>`), so a
   * command that puts the key into the buffer must translate them. It did not: `r<CR>`
   * inserted the two characters "CR", and `r<Tab>` inserted "Tab" — measured 2026-11-15,
   * fixed here because the visual form needs the same translation and two copies of a
   * rule is how one of them gets forgotten.
   */
  _typedChar(key) {
    if (key === "CR") return "\n";
    if (key === "Tab") return "\t";
    return key;
  }

  _replaceChars(count, ch) {
    const text = this.text;
    const cur = this.state.cursor;
    ch = this._typedChar(ch);
    // nothing to replace: empty buffer, or the cursor sits on an empty line
    if (text.length === 0 || B.isLineEmpty(text, cur)) return { handled: true };
    const last = B.lastCharOffset(text, cur);
    let to = cur;
    for (let i = 0; i < count; i++) {
      if (to > last) break;
      to = B.nextChar(text, to);
    }
    const n = [...text.slice(cur, to)].length;
    // A line break is not repeated: `2r<CR>` and `3r<CR>` each break the line ONCE and
    // delete the count characters (measured — "abcdef" with `3r<CR>` is "\ndef", not
    // "\n\n\ndef"), because r-with-CR means "split here", not "put n breaks here".
    // Every other character does repeat, and `3r<Tab>` really is three tabs.
    const repl = ch === "\n" ? "\n" : ch.repeat(Math.max(1, n));
    this._pushUndo({ text, cursor: cur });
    this._setText(text.slice(0, cur) + repl + text.slice(to));
    // The cursor stays on the replaced character — except for a line break, which nobody
    // can stand on, so it lands on the first character of the new line (measured:
    // `r<CR>` at column 1 of "abc" reports 2:1, and at the last character 2:1 as well).
    this.state.cursor = Math.max(cur, Math.min(cur + repl.length - (repl === "\n" ? 0 : 1), this.state.text.length - 1));
    this._noteChange({ kind: "replace", count, ch });
    return { handled: true, edit: true };
  }

  _toggleCase(count) {
    const text = this.text;
    const cur = this.state.cursor;
    const last = B.lastCharOffset(text, cur);
    let out = text;
    let at = cur;
    let flipped = 0;
    // busybox's `~` is `dot_right()` in a loop (vi.c: `case '~'`): it advances
    // whether or not the character changed. vim agrees - `~` on a blank moves
    // right instead of stopping - and that advancement is what makes `2~` walk
    // two characters rather than flip the same one twice.
    for (let i = 0; i < count; i++) {
      const ch = B.charAt(out, at);
      if (ch !== undefined) {
        const upper = ch.toUpperCase();
        const next = ch === upper ? ch.toLowerCase() : upper;
        if (next !== ch) {
          out = out.slice(0, at) + next + out.slice(at + ch.length);
          flipped++;
        }
      }
      if (at >= last) break;
      at = B.nextChar(out, at);
    }
    this.state.cursor = Math.min(at, Math.max(0, out.length - 1));
    if (!flipped) return { handled: true };
    this._pushUndo({ text, cursor: cur });
    this._setText(out);
    this._noteChange({ kind: "tilde", count });
    return { handled: true, edit: true };
  }

  /**
   * Join line `ln` with the one below it. THE join rule, in one place: `J`, `3J` and
   * visual `J` all come through here, because a second copy of it - the visual handler
   * replaced every newline-plus-blanks with a single space - inserted a space even when
   * the line already ended in one: "two spaces between" survived the fix that was meant
   * to remove exactly that.
   *
   * Measured (vim, nvi): a blank or whitespace-only next line is removed outright with
   * no separator, and otherwise a space is added only when the line joined INTO has no
   * trailing blank of its own (and none at all when that line is empty, where it would
   * be a leading space).
   */
  _joinPair(out, ln) {
    const target = B.lineOffset(out, ln);
    const e = B.lineEnd(out, target);
    const nextStart = e + 1;
    if (nextStart > out.length) return null;
    const nextEnd = B.lineEnd(out, nextStart);
    const raw = out.slice(nextStart, nextEnd);
    if (raw.trim() === "") return { out: out.slice(0, e) + out.slice(nextEnd), joinAt: e };
    const next = raw.replace(/^[ \t]+/, "");
    const first = out.slice(target, e);
    const sep = first === "" || /[ \t]$/.test(first) ? "" : " ";
    return { out: out.slice(0, e) + sep + next + out.slice(nextEnd), joinAt: e };
  }

  _join(count) {
    const text = this.text;
    const cur = this.state.cursor;
    const line = B.lineNumber(text, cur);
    if (line >= B.lineCount(text) - 1) return { handled: true };
    this._pushUndo({ text, cursor: cur });
    let out = text;
    let joinAt = -1;
    // vim: [count]J joins [count] lines, i.e. count-1 joins
    const joins = Math.max(1, count - 1);
    const ln = line;
    for (let i = 0; i < joins && ln < B.lineCount(out) - 1; i++) {
      const r = this._joinPair(out, ln);
      if (!r) break;
      out = r.out;
      joinAt = r.joinAt;
    }
    if (joinAt < 0) return { handled: true };
    this._setText(out);
    this.state.cursor = Math.min(joinAt, Math.max(0, out.length - 1));
    this._noteChange({ kind: "join", count });
    return { handled: true, edit: true };
  }

  /**
   * `<C-a>` / `<C-x>`: add or subtract from the number under the cursor, or the next one
   * on the line. Every rule here is measured against vim 9.2 (oracle/cases/increment.json):
   *
   *   * the number is the one CONTAINING the cursor, else the first one AT OR AFTER it —
   *     a cursor just past a number does not pick it up;
   *   * a leading `+`/`-` belongs to the number, even when the cursor sits on it;
   *   * `0x`/`0X` is hex and `0b`/`0B` is binary, and both are UNSIGNED 64-bit, so
   *     `0x0` minus one is `0xffffffffffffffff` (vim, measured), not -1;
   *   * `0` followed by octal digits is OCTAL (`007` + 1 is `010`, because it is 0 + "10",
   *     not zero padding) — while `009` is decimal, and its leading zeros are dropped;
   *   * the sign is kept only when it still means something: `-1` + 1 is `0`, and a
   *     written `+` survives (`+5` -> `+6`);
   *   * the cursor lands on the LAST character of the new number.
   */
  _adjustNumber(delta) {
    const text = this.text;
    const ls = B.lineStart(text, this.state.cursor);
    const le = B.lineEnd(text, this.state.cursor);
    const line = text.slice(ls, le);
    const spot = this._numberAt(line, this.state.cursor - ls);
    if (!spot) { this.onStatus("no number under or after the cursor", "error"); return { handled: true }; }
    const next = this._increment(spot, delta);
    if (next == null) { this.onStatus("cannot change this number", "error"); return { handled: true }; }
    this._pushUndo({ text, cursor: this.state.cursor });
    this._setText(text.slice(0, ls) + line.slice(0, spot.from) + next + line.slice(spot.to) + text.slice(le));
    this.state.cursor = ls + spot.from + next.length - 1;
    this._noteChange({ kind: "adjust", delta });
    this._setDesiredCol();
    return { handled: true, edit: true };
  }

  /**
   * The number at `cur`, or the next one to its right. One regex, ordered so the longer
   * forms win and so the octal form cannot swallow `009` (the lookahead rejects it, and
   * the decimal branch takes the whole thing).
   */
  _numberAt(line, cur) {
    const re = /([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]+(?![0-9])|[0-9]+)/g;
    let m;
    let next = null;
    while ((m = re.exec(line)) !== null) {
      const from = m.index;
      const to = from + m[0].length;
      if (cur >= from && cur < to) return { from, to, sign: m[1], body: m[2] };
      if (!next && from >= cur) next = { from, to, sign: m[1], body: m[2] };
    }
    return next;
  }

  /** The replacement text for one number, or null when it cannot be parsed. */
  _increment(spot, delta) {
    const { sign, body } = spot;
    const hex = /^0[xX]/.test(body);
    const bin = /^0[bB]/.test(body);
    const oct = !hex && !bin && body.length > 1 && body[0] === "0" && /^[0-7]+$/.test(body);
    if (hex || bin || oct) {
      const prefix = hex || bin ? body.slice(0, 2) : "0";
      const digits = hex || bin ? body.slice(2) : body.slice(1);
      const radix = hex ? 16 : bin ? 2 : 8;
      const literal = radix === 16 ? `0x${digits}` : radix === 2 ? `0b${digits}` : `0o${digits}`;
      let value;
      try { value = BigInt(literal); } catch { return null; }
      // Unsigned 64-bit, as vim: `0x0` - 1 wraps rather than going negative.
      value = (value + BigInt(delta)) & ((1n << 64n) - 1n);
      // ...and the digits keep their WIDTH: `0x10` - 1 is `0x0f`, not `0xf`, while a
      // value that outgrows the width simply grows (`0xff` + 1 is `0x100`).
      return prefix + value.toString(radix).padStart(digits.length, "0");
    }
    if (!/^[0-9]+$/.test(body)) return null;
    const value = Number(body) * (sign === "-" ? -1 : 1) + delta;
    const abs = String(Math.abs(value));
    if (value < 0) return `-${abs}`;
    // A written `+` is part of the number and survives; leading zeros do not.
    return sign === "+" ? `+${abs}` : abs;
  }

  /** Shift the cursor's line(s) — the `.` repeat path for `>>`/`<<` (see _repeat). */
  _shift(count, right) {
    const startLine = B.lineNumber(this.text, this.state.cursor);
    return this._shiftLines(
      B.lineOffset(this.text, startLine),
      B.lineEnd(this.text, B.lineOffset(this.text, Math.min(B.lineCount(this.text) - 1, startLine + count - 1))),
      right,
      count,
    );
  }

  _shiftLines(from, to, right) {
    const text = this.text;
    const startLine = B.lineNumber(text, from);
    const endLine = B.lineNumber(text, Math.min(to, Math.max(0, text.length - 1)));
    const unit = this.options.expandtab ? " ".repeat(this.options.shiftwidth) : "\t";
    const lines = text.split("\n");
    this._pushUndo({ text, cursor: this.state.cursor });
    for (let n = startLine; n <= endLine; n++) {
      if (lines[n].length === 0) continue;             // vim leaves blank lines alone
      if (right) lines[n] = unit + lines[n];
      else lines[n] = lines[n].replace(new RegExp(`^(\\t| {1,${this.options.shiftwidth}})`), "");
    }
    this._setText(lines.join("\n"));
    this.state.cursor = B.firstNonBlank(this.state.text, B.lineOffset(this.state.text, startLine));
    this._noteChange({ kind: "shift", count: 1, right });
    return { handled: true, edit: true };
  }

  _put(count, before) {
    const asked = this._takeReg();
    const reg = this.registers.read(asked);
    // an empty register has nothing to insert, and must not move the cursor either
    if (!reg || reg.text === "") {
      this.onStatus(isClipboard(asked)
        ? "system clipboard unavailable in this host"
        : "register empty", "error");
      return { handled: true };
    }
    const text = this.text;
    const cur = this.state.cursor;
    this._pushUndo({ text, cursor: cur });
    let insertAt;
    let payload = reg.text.repeat(count);
    if (reg.linewise) {
      const line = B.lineNumber(text, cur);
      const start = before ? B.lineOffset(text, line) : B.lineOffset(text, line) + (B.lineEnd(text, B.lineOffset(text, line)) - B.lineOffset(text, line)) + 1;
      insertAt = before ? start : Math.min(start, text.length);
      if (insertAt > text.length) insertAt = text.length;
      if (!payload.endsWith("\n")) payload += "\n";
      const needsNewline = insertAt > 0 && text[insertAt - 1] !== "\n";
      this._setText(text.slice(0, insertAt) + (needsNewline ? "\n" : "") + payload.replace(/\n$/, "") + "\n" + text.slice(insertAt));
      this.state.cursor = B.firstNonBlank(this.state.text, insertAt + (needsNewline ? 1 : 0));
    } else {
      // `p` inserts after the cursor's character - but an EMPTY line has no character,
      // so the paste lands at the line start (measured: on "a\n\nb\n" with the cursor
      // on the empty line, `p` puts the text there and pushes the line break along).
      insertAt = before || B.isLineEmpty(text, cur) ? cur : Math.min(text.length, B.nextChar(text, cur));
      this._setText(text.slice(0, insertAt) + payload + text.slice(insertAt));
      // measured (vim): a charwise register that CONTAINS a line break leaves the
      // cursor on the FIRST inserted character; a single-line one on the last.
      this.state.cursor = payload.includes("\n") ? insertAt : Math.max(0, insertAt + payload.length - 1);
    }
    this._noteChange({ kind: "put", count, before });
    return { handled: true, edit: true };
  }

  _undo() {
    const prev = this.undoStack.pop();
    if (!prev) { this.onStatus("already at oldest change", "error"); return { handled: true }; }
    this.redoStack.push({ text: this.text, cursor: this.state.cursor });
    this._setText(prev.text);
    this.state.cursor = Math.min(prev.cursor, Math.max(0, prev.text.length - 1));
    this.onStatus("");
    return { handled: true, edit: true };
  }

  _redo() {
    const next = this.redoStack.pop();
    if (!next) { this.onStatus("already at newest change", "error"); return { handled: true }; }
    this.undoStack.push({ text: this.text, cursor: this.state.cursor });
    this._setText(next.text);
    this.state.cursor = Math.min(next.cursor, Math.max(0, next.text.length - 1));
    return { handled: true, edit: true };
  }

  /**
   * `U`: undo every change to THIS line, back to how it looked before its first change.
   *
   * Measured against vim 9.2: `XU` and `xxU` restore the whole line, the snapshot
   * survives moving away and coming back, `U` is itself undoable (`xUu` gives the
   * deleted text back), a line with no changes is a no-op, and a linewise delete
   * clears it (`ddU` restores nothing) — so the snapshot is dropped whenever the buffer
   * gains or loses lines, because the line mapping is no longer trustworthy.
   */
  _restoreLine() {
    const snap = this.lineSnapshot;
    const text = this.text;
    if (!snap || snap.line >= B.lineCount(text)) { this.onStatus("no line change to restore", "error"); return { handled: true }; }
    const col = snap.col;
    this._pushUndo({ text, cursor: this.state.cursor });
    const lines = text.split("\n");
    lines[snap.line] = snap.text;
    this._setText(lines.join("\n"));
    // The cursor goes to the line that changed, in the column the first change left it
    // in (clamped to the restored line). Measured: `xxU` -> 1:1, `llXU` -> 1:2,
    // `lXjllkU` -> 1:1 (after moving to another line and back).
    const at = B.lineOffset(this.state.text, snap.line);
    this.state.cursor = B.clampToLineEnd(this.state.text, at, at + Math.max(0, col));
    this.lineSnapshot = null;
    this._closeUndo();
    return { handled: true, edit: true };
  }

  // --- insert mode ---------------------------------------------------------
  _enterInsert(kind, count = 1, at = null) {
    const text = this.text;
    const cur = this.state.cursor;
    // vim opens the undo block where the change BEGINS, and that is also where
    // undo puts the cursor back: after the entry motion for i/a/I/A (measured:
    // `aX<Esc>u` returns to 1:2, `AX<Esc>u` to the last character of the line),
    // but at the pre-command cursor for o/O, whose new line is gone after the
    // undo. `s`/`c` have already opened the block at the deleted position.
    const entry = at != null ? Math.max(0, Math.min(at, Math.max(0, text.length - 1)))
      : kind === "a" ? C.right(text, cur)
        : kind === "I" ? B.firstNonBlank(text, cur)
          : kind === "A" ? B.lineEnd(text, cur)
            : cur;
    this._pushUndo({ text, cursor: entry });
    // U restores the line to how it looked before its FIRST change (see feed()).
    this.lineSnapshot = { line: B.lineNumber(text, entry), text: B.lineText(text, entry), col: entry - B.lineStart(text, entry) };
    this.mode = Mode.INSERT;
    this.pending = this._emptyPending();

    switch (kind) {
      // i/a/I/A/s/c all insert at `entry` - the entry motion's landing point for
      // the first four, and the start of the deletion for s/c.
      case "o": {
        const e = B.lineEnd(text, cur);
        this._setText(text.slice(0, e) + "\n" + text.slice(e));
        this.state.cursor = e + 1;
        break;
      }
      case "O": {
        const s = B.lineStart(text, cur);
        this._setText(text.slice(0, s) + "\n" + text.slice(s));
        this.state.cursor = s;
        break;
      }
      case "R":
        // R overwrites instead of inserting. The host still does the typing, so the
        // session keeps what the field looked like when R was pressed.
        this.replaceSession = { at: entry, snap: B.hostText(text), typed: "" };
        break;
      default: this.state.cursor = entry; break;
    }
    // capture the baseline AFTER the entry's own edit, otherwise the newline that
    // `o`/`O` create looks like typed text
    // `insStart` is where the insertion begins RIGHT NOW: the entry motion's landing
    // point for i/a/I/A, the new line for o/O, the start of the deletion for s/c.
    // Insert-mode C-w / C-u never reach behind it once something has been typed, and
    // that one position is the whole difference between "delete what I just typed"
    // and "delete the document" (measured; see _insertBackspaceWord).
    this.insertEntry = {
      kind, start: cur, textBefore: this.state.text, cursorBefore: cur, count,
      insStart: this.state.cursor,
    };
    return { handled: true, edit: true, enterInsert: true, mode: Mode.INSERT };
  }

  _insertKey(key) {
    // `<C-r>{register}` inserts a register's text — the fast way to bring the system
    // clipboard into a field without leaving insert mode. Two rules matter more than
    // the feature: the FIRST Ctrl-R must be consumed even when the register can never
    // work (an unconsumed Ctrl-R is a page reload, which loses the user's work), and
    // the pending state must not survive Esc.
    if (this._insertRegPending) {
      this._insertRegPending = false;
      return this._insertRegister(key);
    }
    if (key === "C-r") {
      this._insertRegPending = true;
      return { handled: true };
    }
    if (key === "Esc") {
      const entry = this.insertEntry;
      this._insertRegPending = false;
      this.insertEntry = null;
      this.replaceSession = null;
      this.mode = Mode.NORMAL;
      let repeated = false;
      if (entry) {
        // the count repeat must happen while the cursor is still at the end of
        // the typed run, before the leave-insert step to the left
        const inserted = this._contiguousInsert(entry);
        const repeatsEvenWhenEmpty = entry.kind === "o" || entry.kind === "O";
        if (entry.count > 1 && (inserted || repeatsEvenWhenEmpty)) repeated = this._repeatInsert(entry, inserted);
        this._noteChange({ kind: "insert", entry: entry.kind, inserted });
      }
      // Leaving insert steps one character left, but never across the line
      // boundary: at column 1 the cursor stays (vim, nvi and busybox agree).
      // A count repeat already parked the cursor on the last copied character.
      // leaving insert is exactly busybox's dot_left: one left, never across a newline
      if (!repeated) this.state.cursor = C.left(this.text, this.state.cursor);
      return { handled: true };
    }
    // The two insert-mode backspace commands. Both are ALWAYS consumed, even when
    // there is nothing to delete: an unconsumed Ctrl-W closes the tab (or the PWA
    // window, or the Electron app) and an unconsumed Ctrl-U is the browser's own
    // action - the same reasoning that makes the first `<C-r>` unconditional.
    if (key === "C-w") return this._insertBackspaceWord();
    if (key === "C-u") return this._insertBackspaceLine();
    // insert mode belongs to the host
    return { handled: false };
  }

  /** Where this insert began — the wall C-w / C-u may not cross once text is typed. */
  _insertStart() {
    return this.insertEntry ? this.insertEntry.insStart : this.state.cursor;
  }

  /**
   * INSERT `<C-w>`: delete back to the start of the word before the cursor.
   *
   * Measured against vim 9.2 (`oracle/cases/insert-backspace.json`). Two of vim's rules
   * here are not in the documentation:
   *
   *   1. **The scan never crosses a line start.** The floor is `lineStart`, so a word
   *      that begins on the previous line is out of reach. vim's extra move - deleting
   *      the line BREAK at column 1 and joining the lines - is NOT implemented; see
   *      `docs/ENGINE.md`, "what is deliberately not covered".
   *   2. **Once anything is typed, the insert start is a wall.** `AXY<C-w>` on
   *      "foo bar" gives "foo bar", not "foo ": the typed run goes, the word does not.
   *      A second C-w then has nothing typed before it and takes "bar".
   *
   * With nothing typed the word before the insert start goes (`A<C-w>` on "foo bar"
   * empties it to "foo "), which is the case that makes the key useful at all — and the
   * one that classic vi and nvi refuse. Whitespace before the cursor goes with the word.
   */
  _insertBackspaceWord() {
    const t = this.text;
    const cur = this.state.cursor;
    const ins = this._insertStart();
    const ls = B.lineStart(t, cur);
    // Column 1: there is no word on this line, and the line break is out of scope.
    if (cur === ls) return { handled: true };
    let from = B.wordBack(t, cur, false, ls);
    // The wall: while text typed in this insert sits between the cursor and the word
    // start, the deletion stops at the insert start instead of reaching past it.
    if (from < ins && cur > ins) from = Math.max(ins, ls);
    if (from >= cur) return { handled: true };
    return this._insertDelete(from, cur);
  }

  /**
   * INSERT `<C-u>`: delete everything before the cursor on this line, down to where
   * this insert began — or, when nothing has been typed yet, down to the start of the
   * line.
   *
   * That two-part rule is vim's, and both halves are measured: `AXY<C-u>` on "foo bar"
   * leaves "foo bar" (the typed run goes, the line does not), while `A<C-u>` on the same
   * buffer empties the line. `A<CR>XY<C-u>` deletes only the typed run on the NEW line,
   * because the entered characters on this line are exactly that run - which is why the
   * stop is clamped to the line start as well as to the insert start.
   *
   * At column 1 there is nothing behind the cursor on this line, and vim's line JOIN is
   * not implemented (see ENGINE.md), so it is inert — but still consumed.
   */
  _insertBackspaceLine() {
    const cur = this.state.cursor;
    const ins = this._insertStart();
    const ls = B.lineStart(this.text, cur);
    const stop = cur > ins ? Math.max(ins, ls) : ls;
    if (stop >= cur) return { handled: true };
    return this._insertDelete(stop, cur);
  }

  /**
   * Delete [from, to) as an insert-mode edit, leaving the cursor where the deletion
   * began.
   *
   * In REPLACE mode this is not a plain deletion: the typed text is what displaced the
   * snapshot's characters, so un-typing it has to put them BACK. Measured:
   * `RXY<C-w>` over "cd" restores "cd" (the text is "abXYef" -> "abcdef"), and a
   * deletion that would reach past the typed run does nothing at all rather than
   * eating pre-existing text. Both fall out of trimming `typed` and rebuilding from
   * the snapshot — the same reconstruction applyHostEdit() runs in the other
   * direction, which is why they share one copy of it.
   */
  _insertDelete(from, to) {
    const text = this.text;
    const session = this.replaceSession;
    this._pushUndo({ text, cursor: this.state.cursor });
    if (session) {
      if (from < session.at) from = session.at;      // pre-insert text is out of reach
      if (from >= to) return { handled: true };
      session.typed = session.typed.slice(0, Math.max(0, session.typed.length - (to - from)));
      this._rebuildReplace();
    } else {
      this._setText(text.slice(0, from) + text.slice(to));
      this.state.cursor = from;
    }
    this._setDesiredCol();
    return { handled: true, edit: true };
  }

  /**
   * Rebuild a replace-mode buffer from its snapshot: the typed run overwrites the
   * front of the snapshot, and only up to a line break — typing past the end of a
   * line appends (measured). One copy, because a second one is how the write and the
   * un-write of a replacement come to disagree.
   */
  _replaceConsumed() {
    const session = this.replaceSession;
    if (!session) return 0;
    const snap = session.snap;
    let consumed = 0;
    while (consumed < session.typed.length
      && session.at + consumed < snap.length
      && snap[session.at + consumed] !== "\n") consumed++;
    return consumed;
  }

  _rebuildReplace() {
    const session = this.replaceSession;
    if (!session) return;
    const consumed = this._replaceConsumed();
    this.setText(session.snap.slice(0, session.at) + session.typed + session.snap.slice(session.at + consumed),
      session.at + session.typed.length);
  }

  /**
   * The value for `<C-r>{register}`: the engine decides WHAT, the adapter does the
   * inserting (insert mode belongs to the host, and a textarea and a rich composer
   * insert text in two different ways).
   */
  _insertRegister(name) {
    const asked = name === '"' ? null : name;
    // null is the unnamed register, which is a legitimate target: `i<C-r>"`.
    if (asked !== null && !isClipboard(asked) && asked !== "_" && !isNamed(asked)) {
      this.onStatus(`unsupported register: ${name}`, "error");
      return { handled: true };
    }
    const reg = this.registers.read(asked);
    if (!reg || reg.text === "") {
      this.onStatus(isClipboard(asked) ? "system clipboard unavailable in this host" : "register empty", "error");
      return { handled: true };
    }
    return { handled: true, insertText: reg.text };
  }

  /**
   * A count before an insert entry repeats the typed text: `3iX<Esc>` gives XXX,
   * `3oX<Esc>` gives three lines. busybox drops this case; it is cheap here only
   * because the host owns insert mode, so at Esc we already hold the typed text
   * as one contiguous run (the same capture `.` uses).
   */
  _repeatInsert(entry, inserted) {
    const count = entry.count;
    if (entry.kind === "o" || entry.kind === "O") {
      // each extra copy becomes its own line, below for `o`, above for `O`
      for (let i = 1; i < count; i++) {
        const t = this.text;
        if (entry.kind === "o") {
          const at = Math.min(B.lineEnd(t, this.state.cursor) + 1, t.length);
          this._setText(t.slice(0, at) + inserted + "\n" + t.slice(at));
          this.state.cursor = at;
        } else {
          const at = B.lineStart(t, this.state.cursor);
          this._setText(t.slice(0, at) + inserted + "\n" + t.slice(at));
          this.state.cursor = at + inserted.length + 1;
        }
      }
      return true;
    }
    // i a I A: the copies are contiguous, appended right after the typed run.
    // In insert mode the cursor already sits past the last typed character.
    const t = this.text;
    const end = Math.min(this.state.cursor, t.length);
    const payload = inserted.repeat(count - 1);
    this._setText(t.slice(0, end) + payload + t.slice(end));
    this.state.cursor = Math.max(0, end + payload.length - 1);
    return true;
  }

  /** The text typed during the last insert, if it is a single contiguous change. */
  _contiguousInsert(entry) {
    const before = entry.textBefore;
    const after = this.text;
    let a = 0;
    while (a < before.length && a < after.length && before[a] === after[a]) a++;
    let b = 0;
    while (b < before.length - a && b < after.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
    const inserted = after.slice(a, after.length - b);
    return inserted;
  }

  // --- visual mode ---------------------------------------------------------
  _visualRange() {
    const text = this.text;
    const a = this.visual.anchor;
    const b = this.state.cursor;
    if (this.mode === Mode.VISUAL_LINE) {
      const l1 = B.lineNumber(text, Math.min(a, b));
      const l2 = B.lineNumber(text, Math.max(a, b));
      let from = B.lineOffset(text, l1);
      let to = B.lineEnd(text, B.lineOffset(text, l2));
      if (to < text.length) to += 1;
      return { from, to, linewise: true };
    }
    const from = Math.min(a, b);
    const last = Math.max(a, b);
    // A charwise selection excludes the trailing newline of its last line - measured:
    // `v$y` on "abcdef" yanks "abcdef", and `vjy` on "abcdef\ngh\n" yanks
    // "abcdef\ng". An EMPTY last line is the exception: its only character IS the
    // line break, and vim includes it (`vjy` on "a\n\nb\n" yanks "a\n\n"), while a
    // selection that never leaves an empty line is empty (`v y` on an empty buffer
    // yanks nothing, not "\n").
    let to;
    if (text[last] === "\n") {
      // the cursor is ON a line break - an empty line, or the tail of a text object.
      // That break is part of the selection, unless it is the buffer's own terminator:
      // an empty buffer and an empty LAST line select nothing (measured).
      to = last < text.length - 1 ? B.nextChar(text, last) : last;
    } else {
      // ... and a charwise selection excludes the trailing newline of its last line
      // (measured: `v$y` yanks "abcdef", not "abcdef\n")
      to = Math.min(B.lineEnd(text, last), B.nextChar(text, last));
    }
    return { from, to, linewise: false };
  }

  /**
   * VISUAL `r`: every selected character becomes the typed character.
   *
   * Measured against vim (`vllrX`, `v$rX`, `vjllrX`, `VrX`, `VjrX`):
   *
   *   * charwise AND linewise both mean "each character in the range" — a linewise `VjrX`
   *     turns every character of both lines into X, it does not shorten a line to one X;
   *   * line breaks inside the selection are NOT replaced (`vjllrX` on "abcdef\nghijkl"
   *     gives "XXXXXX\nXXXjkl"), so a selection can never lose a line this way;
   *   * `r<CR>` therefore replaces each character with a newline and splits the selection
   *     into lines — it falls out of the same rule, so it needs no special case;
   *   * `r<Esc>` aborts and leaves the text alone, and the cursor lands at the start of
   *     the range with the whole replacement as ONE undo step.
   *
   * `.` does not replay it: the last-change record for `r` is a count from the cursor,
   * which describes a range going the other way. Recorded as a gap in docs/ENGINE.md
   * rather than approximated into something wrong.
   */
  _visualReplaceChars(key) {
    const ch = this._typedChar(key);
    const text = this.text;
    const range = this._visualRange();
    const slice = text.slice(range.from, range.to);
    const out = [...slice].map((c) => (c === "\n" ? c : ch)).join("");
    this._pushUndo({ text, cursor: range.from });
    this._setText(text.slice(0, range.from) + out + text.slice(range.to));
    this.state.cursor = Math.min(range.from, Math.max(0, this.state.text.length - 1));
    this.mode = Mode.NORMAL;
    this.visual = null;
    this.pending = this._emptyPending();
    this._setDesiredCol();
    return { handled: true, edit: true };
  }

  _visualKey(key) {
    const p = this.pending;
    if (key === "Esc") { this.mode = Mode.NORMAL; this.visual = null; this.pending = this._emptyPending(); return { handled: true }; }
    if (key === "v" && this.mode === Mode.VISUAL) { this.mode = Mode.NORMAL; this.visual = null; return { handled: true }; }
    // The register prefix works on a visual yank/delete too (`vj"ay`). It used to be
    // collected only in normal mode, so the prefix was silently ignored here and the
    // yank went to the unnamed register — the same "wrong beats missing" trap.
    //
    // `"` is ALSO a text-object target (`va"`, `vi"`), so a pending i/a prefix owns the
    // key: collecting it as a register first broke `va"d`, which the differential caught.
    if (!p.textObj && p.awaiting === "register") return this._consumeArgument("register", key);
    if (!p.textObj && key === '"') { p.awaiting = "register"; return { handled: true }; }
    if (key === "V" && this.mode === Mode.VISUAL_LINE) { this.mode = Mode.NORMAL; this.visual = null; return { handled: true }; }
    if (key === "v") { this.mode = Mode.VISUAL; return { handled: true }; }
    if (key === "V") { this.mode = Mode.VISUAL_LINE; return { handled: true }; }
    if (key === "o") { const a = this.visual.anchor; this.visual.anchor = this.state.cursor; this.state.cursor = a; return { handled: true }; }
    if (/^[1-9]$/.test(key) || (key === "0" && p.count !== "")) { p.count += key; return { handled: true }; }
    // a mark jump extends the selection here exactly as a motion would: the visual
    // head IS the cursor, so the same motion object serves both
    // `r` collects the replacement character exactly as normal-mode `r` does, and then
    // applies it to the SELECTION instead of to a count of characters.
    if (p.awaiting === "visualReplaceChar") {
      p.awaiting = null;
      return this._visualReplaceChars(key);
    }
    if (p.awaiting) return this._consumeArgument(p.awaiting, key);
    if (key === "'" || key === "`") { p.awaiting = key; return { handled: true }; }
    if (key === "m") { p.awaiting = "mark"; return { handled: true }; }
    if (p.gPending) {
      p.gPending = false;
      const gmotion = G_MOTIONS[key];
      if (gmotion) {
        const m = this._motion(gmotion, this._takeCount(1), {});
        if (m) this.state.cursor = Math.max(0, Math.min(m.to, Math.max(0, this.text.length - 1)));
        return { handled: true };
      }
      return { handled: true };
    }
    if (key === "g") { p.gPending = true; return { handled: true }; }

    // text objects extend the selection to exactly that object&# (vim-only: busybox
    // has no visual mode at all)
    if (p.textObj) {
      const prefix = p.textObj;
      this.pending = this._emptyPending();
      const range = this._textObject(prefix, key);
      if (!range) return { handled: true };
      this.visual.anchor = range.from;
      const last = B.prevChar(this.text, range.to);
      this.state.cursor = Math.max(range.from, last);
      return { handled: true };
    }
    if (key === "i" || key === "a") { p.textObj = key; return { handled: true }; }

    if (key === ">" || key === "<") {
      const range = this._visualRange();
      this.state.cursor = range.from;   // vim records the range start for `u` (see _applyOperatorRange)
      const res = this._shiftLines(range.from, range.to, key === ">");
      this.mode = Mode.NORMAL;
      this.visual = null;
      return { ...res, handled: true };
    }

    const opMap = { d: "d", x: "d", y: "y", c: "c", s: "c" };
    if (opMap[key]) {
      const range = this._visualRange();
      const op = opMap[key];
      const reg = this.pending.reg;
      this.mode = Mode.NORMAL;
      this.visual = null;
      this.pending = this._emptyPending();
      const res = this._applyOperatorRange(op, range.from, range.to, range.linewise, true, false, reg, false, range.from);
      if (op === "y") this.state.cursor = range.from;   // vim parks at the start
      return res;
    }
    if (key === "r") { p.awaiting = "visualReplaceChar"; return { handled: true }; }
    if (key === "~") {
      const range = this._visualRange();
      const slice = this.text.slice(range.from, range.to);
      const flipped = [...slice].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");
      this._pushUndo({ text: this.text, cursor: range.from });
      this._setText(this.text.slice(0, range.from) + flipped + this.text.slice(range.to));
      this.state.cursor = range.from;
      this.mode = Mode.NORMAL; this.visual = null;
      return { handled: true, edit: true };
    }
    if (key === "J") {
      // join every line the selection spans, through the same rule as `J`
      const range = this._visualRange();
      const text = this.text;
      const first = B.lineNumber(text, range.from);
      // range.to is EXCLUSIVE: the last line of the selection is the one holding to-1,
      // otherwise a selection ending on a blank line reports one line too many and the
      // join then eats the following line too ("a b" instead of "a\nb").
      const lastOffset = Math.max(range.from, Math.min(range.to - 1, Math.max(0, text.length - 1)));
      const last = B.lineNumber(text, lastOffset);
      const joins = Math.max(0, last - first);
      this._pushUndo({ text, cursor: this.state.cursor });
      let out = text;
      let joinAt = -1;
      for (let i = 0; i < joins; i++) {
        const r = this._joinPair(out, first);
        if (!r) break;
        out = r.out;
        joinAt = r.joinAt;
      }
      this.mode = Mode.NORMAL;
      this.visual = null;
      if (joinAt < 0) {
        // nothing to join (a one-line selection): vim still parks the cursor at the
        // start of the selection, which is where the join would have happened.
        this.state.cursor = Math.min(range.from, Math.max(0, this.text.length - 1));
        return { handled: true };
      }
      this._setText(out);
      this.state.cursor = Math.min(joinAt, Math.max(0, this.text.length - 1));
      this._noteChange({ kind: "join", count: 1 });
      return { handled: true, edit: true };
    }
    if (key === "p" || key === "P") {
      const range = this._visualRange();
      this._applyOperatorRange("d", range.from, range.to, range.linewise, true);
      return this._put(1, false);
    }
    const motion = this._resolveMotionKey(key);
    if (motion) {
      const count = this._takeCount(1);
      const m = this._motion(motion, count, {});
      this.pending = this._emptyPending();
      if (m) this.state.cursor = Math.max(0, Math.min(m.to, Math.max(0, this.text.length - 1)));
      return { handled: true };
    }
    return { handled: true };
  }

  /** Text of the current visual selection (for Ctrl-C). */
  visualText() {
    const sel = this.visualSelection();
    return sel ? this.text.slice(sel.from, sel.to) : "";
  }

  /** Public: the current visual selection, or null when not in visual mode. */
  visualSelection() {
    if (this.mode !== Mode.VISUAL && this.mode !== Mode.VISUAL_LINE) return null;
    if (!this.visual) return null;
    const r = this._visualRange();
    return { from: r.from, to: r.to, linewise: !!r.linewise };
  }

  // --- viewport ------------------------------------------------------------
  _page(dir) {
    const vp = this._viewport();
    if (!vp) { this.onStatus("no viewport on this host", "error"); return { handled: true }; }
    const step = Math.max(1, vp.height - 2);
    const row = Math.max(0, vp.top + dir * step);
    const landing = this._rowLanding(row, 0);
    if (landing != null) {
      // vim puts the cursor on the first line of the new page
      this.state.cursor = landing;
      this.onScroll(row);
      return { handled: true };
    }
    const r = this._vertical(step, dir);
    this.state.cursor = B.firstNonBlank(this.text, B.lineOffset(this.text, B.lineNumber(this.text, r.to)));
    this.onScroll(Math.max(0, vp.top + dir * step));
    return { handled: true };
  }
  _halfPage(dir) {
    const vp = this._viewport();
    const step = vp ? Math.max(1, Math.floor(vp.height / 2)) : this._takeCount(20);
    const here = this._point(this.state.cursor);
    const curRow = this._rowIndex(this.state.cursor);
    if (vp && here && curRow != null) {
      // the cursor moves half a page of ROWS and the window follows it, keeping
      // the screen column - which is what vim's C-d/C-u do
      const row = Math.max(0, curRow + dir * step);
      const at = this._offsetAtRow(row, here.x);
      if (at != null) this.state.cursor = at;
      this.onScroll(Math.max(0, vp.top + dir * step));
      return { handled: true };
    }
    const r = this._vertical(step, dir);
    this.state.cursor = r.to;
    return { handled: true };
  }
  /**
   * `C-e` / `C-y`: scroll the window one line and keep the cursor INSIDE it.
   *
   * The window belongs to the host, so the engine can only ask (`onScroll`); what it can
   * do on its own is move the cursor when the new window would no longer contain it —
   * which is vim's rule (measured: `3<C-e>` from line 1 puts the cursor on line 4, and
   * `G<C-y>` at the end of the buffer leaves the cursor where it is, because it is still
   * on screen).
   */
  _scrollLines(dir) {
    const vp = this._viewport();
    if (!vp) { this.onStatus("no viewport on this host", "error"); return { handled: true }; }
    const top = Math.max(0, vp.top + dir);
    this.onScroll(top);
    const row = this._rowIndex(this.state.cursor);
    const current = row != null ? row : B.lineNumber(this.text, this.state.cursor);
    if (current >= top && current <= top + vp.height - 1) return { handled: true };
    const target = current < top ? top : top + vp.height - 1;
    const landing = this._rowLanding(target, 0);
    if (landing != null) this.state.cursor = landing;
    else {
      const lines = B.lineCount(this.text);
      const line = Math.max(0, Math.min(target, lines - 1));
      this.state.cursor = B.firstNonBlank(this.text, B.lineOffset(this.text, line));
    }
    this._setDesiredCol();
    return { handled: true };
  }
  _status() {
    const text = this.text;
    const line = B.lineNumber(text, this.state.cursor) + 1;
    const total = B.lineCount(text);
    const col = this.state.cursor - B.lineStart(text, this.state.cursor) + 1;
    const chars = [...text].length;
    this.onStatus(`[${this.lineSnapshot != null && this.lineSnapshot !== B.lineText(text, this.state.cursor) ? "Modified" : ""}] line ${line} of ${total} · col ${col} · ${chars} chars`);
    return { handled: true };
  }

  // --- repeat --------------------------------------------------------------
  _noteChange(desc) {
    this.lastChange = { ...desc, count: desc.count ?? this.lastCount };
  }

  _repeat() {
    const lc = this.lastChange;
    if (!lc) { this.onStatus("no previous change", "error"); return { handled: true }; }
    const count = this._takeCount(lc.count || 1);
    if (lc.kind === "insert" && lc.inserted) {
      // Replay the ENTRY (`A` means end-of-line, `o` means a new line), then the
      // typed text. Splicing at the current cursor would ignore the entry.
      const moved = this._enterInsert(lc.entry || "i");
      const at = Math.min(this.state.cursor, this.text.length);
      const payload = lc.inserted.repeat(count);
      const text = this.state.text;
      this._setText(text.slice(0, at) + payload + text.slice(at));
      this.state.cursor = at + payload.length;
      this._insertKey("Esc");          // leaves insert mode and records the change
      return { handled: true, edit: true, ...moved };
    }
    if (lc.kind === "del") return this._deleteChars(count, !!lc.backwards);
    if (lc.kind === "tilde") return this._toggleCase(count);
    if (lc.kind === "join") return this._join(count);
    if (lc.kind === "replace") return this._replaceChars(count, lc.ch);
    if (lc.kind === "shift") return this._shift(count, lc.right);
    if (lc.kind === "adjust") return this._adjustNumber(lc.delta * count);
    if (lc.kind === "put") return this._put(count, lc.before);
    if (lc.kind === "op") {
      const text = this.text;
      const from = Math.min(lc.from, text.length);
      const to = Math.min(lc.to, text.length);
      return this._applyOperatorRange(lc.op, from, to, lc.linewise, true);
    }
    this.onStatus("cannot repeat that change", "error");
    return { handled: true };
  }
}
