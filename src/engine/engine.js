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

export const Mode = { NORMAL: "NORMAL", INSERT: "INSERT", VISUAL: "VISUAL", VISUAL_LINE: "VISUAL_LINE" };

const LINE_MOTIONS = new Set(["j", "k", "+", "-", "_", "CR", "G", "gg", "H", "M", "L"]);

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
    this.registers = new Map(); // name -> {text, linewise}
    this.marks = new Map(); // char -> offset
    this.lastSearch = null;
    this.lastSearchForward = true;
    this.lastFind = null; // {kind, char, forward}
    this.undoStack = [];
    this.redoStack = [];
    this.lastChange = null;
    this.lineSnapshot = null;
    this.state = { text: "", cursor: 0 };
    this.mode = Mode.NORMAL;
    this.pending = this._emptyPending();
    this.visual = null;
    this.insertEntry = null;
    this.prompt = null;
    this.viewport = opts.viewport || null; // () => ({top, height}) in buffer lines
    this.status = [];
    this.onStatus = (msg, kind) => { if (msg) this.status.push(msg); (opts.onStatus || (() => {}))(msg, kind); };
    this.onScroll = opts.onScroll || (() => {});
    this.session = opts.session || null;
    this.describeBuffer = opts.describeBuffer || null;
    this.suppressName = true;
  }

  // --- host API ------------------------------------------------------------
  setText(text, cursor = 0) {
    this.state.text = text;
    this.state.cursor = Math.max(0, Math.min(cursor, Math.max(0, text.length - 1)));
  }
  get text() { return this.state.text; }
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
    if (this.mode === Mode.INSERT) return this._insertKey(key);
    const res = this.mode === Mode.VISUAL || this.mode === Mode.VISUAL_LINE
      ? this._visualKey(key)
      : this._normalKey(key);
    this._stayOffNewline();
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
      if (result.message) this.onStatus(result.message, result.ok ? "info" : "error");
      if (result.ok && !result.message) this.onStatus("");
      return { handled: true, ex: result };
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

    // an operator already waiting for a text-object target: take it verbatim
    if (p.op && p.textObj) {
      const range = this._textObject(p.textObj, key);
      const op = p.op;
      this.pending = this._emptyPending();
      if (!range) { this.onStatus("no text object", "error"); return { handled: true }; }
      this._applyOperatorRange(op, range.from, range.to, !!range.linewise, true, false, null, range.inclusive);
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
    if (key === "g") {
      if (p.gPending) { p.gPending = false; return this._doMotion("gg"); }
      p.gPending = true;
      return { handled: true };
    }

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

    // a pending operator followed by a motion or text object
    if (p.op) {
      if (p.textObj) {
        const range = this._textObject(p.textObj, key);
        if (!range) { this.pending = this._emptyPending(); this.onStatus("no text object", "error"); return { handled: true }; }
        const op = p.op;
        this.pending = this._emptyPending();
        this._applyOperatorRange(op, range.from, range.to, false, range.inclusive);
        return { handled: true, edit: op !== "y" };
      }
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
      case "s": { const c = count(); this._deleteChars(c, false); this._enterInsert("s"); return { handled: true, edit: true }; }
      case "S": { const c = count(); this._applyLinewiseOperator("c", c); return { handled: true, edit: true, enterInsert: true }; }
      case "~": return this._toggleCase(count());
      case "J": return this._join(count());
      case "<": case ">": return this._shift(count(), key === ">");
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
      case "C-f": case "C-b": return this._page(key === "C-f" ? 1 : -1);
      case ";": case ",": return this._repeatFind(key === ";");
      case "C-g": return this._status();
      case "z": p.awaiting = "z"; return { handled: true };
      default: return null;
    }
  }

  _consumeArgument(kind, key) {
    const p = this.pending;
    p.awaiting = null;
    const count = this._takeCount(1);

    if (kind === "register") {
      p.reg = key;
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
      const off = this.marks.get(key);
      this.pending = this._emptyPending();
      if (off == null) { this.onStatus(`mark ${key} not set`, "error"); return { handled: true }; }
      this.state.cursor = kind === "'" ? B.firstNonBlank(this.text, off) : off;
      this._setDesiredCol();
      return { handled: true };
    }
    if (kind === "z") {
      const vp = this._viewport();
      this.pending = this._emptyPending();
      if (!vp) { this.onStatus("no viewport on this host", "error"); return { handled: true }; }
      const line = B.lineNumber(this.text, this.state.cursor);
      const target = key === "t" ? line : key === "b" ? Math.max(0, line - vp.height + 1) : Math.max(0, line - Math.floor(vp.height / 2));
      this.onScroll(target);
      return { handled: true };
    }
    this.pending = this._emptyPending();
    return { handled: true };
  }

  // --- motions -------------------------------------------------------------
  _viewport() {
    if (typeof this.viewport !== "function") return null;
    const vp = this.viewport();
    return vp && vp.height > 0 ? vp : null;
  }

  _setDesiredCol() {
    const s = B.lineStart(this.text, this.state.cursor);
    this.desiredCol = this.state.cursor - s;
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
      case "}": return { to: B.paragraphForward(text, cur, count), linewise: true };
      case "{": return { to: B.paragraphBack(text, cur, count), linewise: true };
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
        this.lastSearch = `\\<${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\>`;
        this.lastSearchForward = name === "*";
        return this._searchMotion(this.lastSearch, name === "*", count);
      }
      case "H": case "M": case "L": {
        const vp = this._viewport();
        if (!vp) { this.onStatus("no viewport on this host", "error"); return null; }
        const lastLine = B.lineCount(text) - 1;
        let line;
        if (name === "H") line = Math.min(lastLine, vp.top + count - 1);
        else if (name === "L") line = Math.max(vp.top, Math.min(lastLine, vp.top + vp.height - count));
        else line = Math.min(lastLine, vp.top + Math.floor(vp.height / 2));
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
    return { to: pos, charwise: true, inclusive: kind === "f" || kind === "F" };
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
        this.onStatus(pattern + (forward ? ": not found" : ": not found backwards"), "error");
        break;
      }
      pos = found;
    }
    if (this.options.showmatch) this.flashRange?.(pos, pos + 1);
    return { to: pos, charwise: true };
  }

  _doMotion(name) {
    const count = this._takeCount(1);
    const motion = this._motion(name, count, {});
    this.pending = this._emptyPending();
    if (!motion) return { handled: true };
    this.state.cursor = Math.max(0, Math.min(motion.to, Math.max(0, this.text.length - 1)));
    if (LINE_MOTIONS.has(name)) { /* keep desiredCol */ } else this._setDesiredCol();
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
    return this._applyOperatorRange(op, from, to, true, true, keepCursor);
  }

  /** Shift the lines a motion spans (`>j`, `>G`, `>ap` treated linewise). */
  _shiftByMotion(motionName, count, right) {
    const m = this._motion(motionName, count, { forOperator: true });
    if (!m) { this.onStatus("motion failed", "error"); return { handled: true }; }
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
    return this._applyOperatorRange(op, from, to, false, true);
  }

  _operatorWithMotion(op, name, count, reg) {
    const motion = this._motion(name, count, { forOperator: true });
    if (!motion || motion.failed) { this.onStatus("motion failed", "error"); return { handled: true }; }
    return this._operatorWithMotionResult(op, motion, count, reg, name);
  }

  _operatorWithMotionResult(op, motion, count, reg, name = "") {
    const text = this.text;
    const cur = this.state.cursor;
    const linewise = !!motion.linewise || LINE_MOTIONS.has(name);
    if (linewise) {
      const a = Math.min(cur, motion.to);
      const b = Math.max(cur, motion.to);
      let from = B.lineOffset(text, B.lineNumber(text, a));
      let to = B.lineEnd(text, B.lineOffset(text, B.lineNumber(text, b)));
      if (to < text.length) to += 1;
      else if (from > 0) from -= 1;
      return this._applyOperatorRange(op, from, to, true, true, false, reg);
    }
    const from = Math.min(cur, motion.to);
    let to = Math.max(cur, motion.to);
    if (motion.inclusive) to = Math.min(text.length, B.nextChar(text, to));
    return this._applyOperatorRange(op, from, to, false, true, false, reg);
  }

  _applyOperatorRange(op, from, to, linewise, record, keepCursor = false, reg = null, inclusive = false) {
    const text = this.text;
    from = Math.max(0, Math.min(from, text.length));
    to = Math.max(from, Math.min(to, text.length));
    if (inclusive) to = Math.min(text.length, B.nextChar(text, to));
    const slice = text.slice(from, to);
    const before = { text, cursor: this.state.cursor };

    if (op === "y") {
      this._storeRegister(slice, linewise, reg);
      this._noteChange({ kind: "op", op, from, to, linewise });
      return { handled: true, edit: false };
    }

    this._pushUndo(before);
    this._storeRegister(slice, linewise, reg);
    this.state.text = text.slice(0, from) + text.slice(to);
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

  deleteRange(from, to, { record = true } = {}) {
    const text = this.text;
    this._pushUndo({ text, cursor: this.state.cursor });
    this.state.text = text.slice(0, from) + text.slice(to);
    this.state.cursor = Math.min(from, Math.max(0, this.state.text.length - 1));
    if (record) this._noteChange({ kind: "del", count: 1 });
    return { handled: true, edit: true };
  }

  noteLineChange() { /* line-level bookkeeping hook; `U` uses lineSnapshot */ }

  _storeRegister(slice, linewise, reg = null) {
    const name = reg || '"';
    this.registers.set(name, { text: slice, linewise });
    if (!reg) this.registers.set('"', { text: slice, linewise });
    this.registers.set("0", { text: slice, linewise });
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
  _pushUndo(snapshot) {
    this.undoStack.push(snapshot);
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
      for (let i = 0; i < count; i++) from = B.prevChar(text, from);
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
    this._storeRegister(slice, false, this.pending.reg);
    this.state.text = text.slice(0, from) + text.slice(to);
    this.state.cursor = B.clampToLineEnd(this.state.text, Math.min(from, Math.max(0, this.state.text.length - 1)), from);
    this._setDesiredCol();
    this._noteChange({ kind: "del", count, backwards });
    return { handled: true, edit: true };
  }

  _replaceChars(count, ch) {
    const text = this.text;
    const cur = this.state.cursor;
    const last = B.lastCharOffset(text, cur);
    let to = cur;
    for (let i = 0; i < count; i++) {
      if (to > last) break;
      to = B.nextChar(text, to);
    }
    const n = [...text.slice(cur, to)].length;
    const repl = ch.repeat(Math.max(1, n));
    this._pushUndo({ text, cursor: cur });
    this.state.text = text.slice(0, cur) + repl + text.slice(to);
    this.state.cursor = Math.max(cur, Math.min(cur + repl.length - 1, this.state.text.length - 1));
    this._noteChange({ kind: "replace", count, ch });
    return { handled: true, edit: true };
  }

  _toggleCase(count) {
    const text = this.text;
    const cur = this.state.cursor;
    const last = B.lastCharOffset(text, cur);
    let to = cur;
    for (let i = 0; i < count; i++) { if (to > last) break; to = B.nextChar(text, to); }
    const slice = text.slice(cur, to);
    const flipped = [...slice].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");
    if (flipped === slice) return { handled: true };
    this._pushUndo({ text, cursor: cur });
    this.state.text = text.slice(0, cur) + flipped + text.slice(to);
    this.state.cursor = Math.min(to, Math.max(0, this.state.text.length - 1));
    this._noteChange({ kind: "tilde", count });
    return { handled: true, edit: true };
  }

  _join(count) {
    const text = this.text;
    const cur = this.state.cursor;
    const line = B.lineNumber(text, cur);
    if (line >= B.lineCount(text) - 1) return { handled: true };
    this._pushUndo({ text, cursor: cur });
    let out = text;
    let changed = 0;
    let joinAt = -1;
    // vim: [count]J joins [count] lines, i.e. count-1 joins
    const joins = Math.max(1, count - 1);
    for (let i = 0; i < joins && B.lineNumber(out, B.lineOffset(out, line) + Math.max(0, joinAt)) < B.lineCount(out) - 1; i++) {
      const target = joinAt < 0 ? B.lineOffset(out, line) : joinAt + 1;
      const e = B.lineEnd(out, target);
      const nextStart = e + 1;
      if (nextStart > out.length) break;
      const nextEnd = B.lineEnd(out, nextStart);
      const next = out.slice(nextStart, nextEnd).replace(/^[ \t]+/, "");
      out = out.slice(0, e) + " " + next + out.slice(nextEnd);
      joinAt = e;
      changed++;
    }
    if (!changed) return { handled: true };
    this.state.text = out;
    this.state.cursor = Math.min(joinAt, Math.max(0, out.length - 1));
    this._noteChange({ kind: "join", count });
    return { handled: true, edit: true };
  }

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
      if (right) lines[n] = unit + lines[n];
      else lines[n] = lines[n].replace(new RegExp(`^(\\t| {1,${this.options.shiftwidth}})`), "");
    }
    this.state.text = lines.join("\n");
    this.state.cursor = B.firstNonBlank(this.state.text, B.lineOffset(this.state.text, startLine));
    this._noteChange({ kind: "shift", count: 1, right });
    return { handled: true, edit: true };
  }

  _put(count, before) {
    const reg = this.registers.get(this.pending.reg || '"') || this.registers.get('"');
    if (!reg) { this.onStatus("register empty", "error"); return { handled: true }; }
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
      this.state.text = text.slice(0, insertAt) + (needsNewline ? "\n" : "") + payload.replace(/\n$/, "") + "\n" + text.slice(insertAt);
      this.state.cursor = B.firstNonBlank(this.state.text, insertAt + (needsNewline ? 1 : 0));
    } else {
      insertAt = before ? cur : Math.min(text.length, B.nextChar(text, cur));
      if (B.isLineEmpty(text, cur) && text.length > 0 && cur >= text.length) insertAt = text.length;
      this.state.text = text.slice(0, insertAt) + payload + text.slice(insertAt);
      this.state.cursor = Math.max(0, insertAt + payload.length - 1);
    }
    this._noteChange({ kind: "put", count, before });
    return { handled: true, edit: true };
  }

  _undo() {
    const prev = this.undoStack.pop();
    if (!prev) { this.onStatus("already at oldest change", "error"); return { handled: true }; }
    this.redoStack.push({ text: this.text, cursor: this.state.cursor });
    this.state.text = prev.text;
    this.state.cursor = Math.min(prev.cursor, Math.max(0, prev.text.length - 1));
    this.onStatus("");
    return { handled: true, edit: true };
  }

  _redo() {
    const next = this.redoStack.pop();
    if (!next) { this.onStatus("already at newest change", "error"); return { handled: true }; }
    this.undoStack.push({ text: this.text, cursor: this.state.cursor });
    this.state.text = next.text;
    this.state.cursor = Math.min(next.cursor, Math.max(0, next.text.length - 1));
    return { handled: true, edit: true };
  }

  _restoreLine() {
    if (this.lineSnapshot == null) { this.onStatus("no line change to restore", "error"); return { handled: true }; }
    const text = this.text;
    const line = B.lineNumber(text, this.state.cursor);
    const lines = text.split("\n");
    lines[line] = this.lineSnapshot;
    this.state.text = lines.join("\n");
    this.state.cursor = B.firstNonBlank(this.state.text, B.lineOffset(this.state.text, line));
    return { handled: true, edit: true };
  }

  // --- insert mode ---------------------------------------------------------
  _enterInsert(kind, count = 1) {
    const text = this.text;
    const cur = this.state.cursor;
    this._pushUndo({ text, cursor: cur });
    this.lineSnapshot = B.lineText(text, cur);
    this.mode = Mode.INSERT;
    this.pending = this._emptyPending();

    switch (kind) {
      // appends after the cursor character; dot_right refuses to step past a
      // newline, which is what an empty line needs
      case "a": this.state.cursor = C.right(text, cur); break;
      case "I": this.state.cursor = B.firstNonBlank(text, cur); break;
      case "A": this.state.cursor = B.lineEnd(text, cur); break;
      case "o": {
        const e = B.lineEnd(text, cur);
        this.state.text = text.slice(0, e) + "\n" + text.slice(e);
        this.state.cursor = e + 1;
        break;
      }
      case "O": {
        const s = B.lineStart(text, cur);
        this.state.text = text.slice(0, s) + "\n" + text.slice(s);
        this.state.cursor = s;
        break;
      }
      case "R": /* replace mode is approximated by insert; documented deviation */ break;
      default: break;
    }
    // capture the baseline AFTER the entry's own edit, otherwise the newline that
    // `o`/`O` create looks like typed text
    this.insertEntry = { kind, start: cur, textBefore: this.state.text, cursorBefore: cur, count };
    return { handled: true, edit: true, enterInsert: true, mode: Mode.INSERT };
  }

  _insertKey(key) {
    if (key === "Esc") {
      const entry = this.insertEntry;
      this.insertEntry = null;
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
    // insert mode belongs to the host
    return { handled: false };
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
          this.state.text = t.slice(0, at) + inserted + "\n" + t.slice(at);
          this.state.cursor = at;
        } else {
          const at = B.lineStart(t, this.state.cursor);
          this.state.text = t.slice(0, at) + inserted + "\n" + t.slice(at);
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
    this.state.text = t.slice(0, end) + payload + t.slice(end);
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
    const to = Math.min(text.length, B.nextChar(text, Math.max(a, b)));
    return { from, to, linewise: false };
  }

  _visualKey(key) {
    const p = this.pending;
    if (key === "Esc") { this.mode = Mode.NORMAL; this.visual = null; this.pending = this._emptyPending(); return { handled: true }; }
    if (key === "v" && this.mode === Mode.VISUAL) { this.mode = Mode.NORMAL; this.visual = null; return { handled: true }; }
    if (key === "V" && this.mode === Mode.VISUAL_LINE) { this.mode = Mode.NORMAL; this.visual = null; return { handled: true }; }
    if (key === "v") { this.mode = Mode.VISUAL; return { handled: true }; }
    if (key === "V") { this.mode = Mode.VISUAL_LINE; return { handled: true }; }
    if (key === "o") { const a = this.visual.anchor; this.visual.anchor = this.state.cursor; this.state.cursor = a; return { handled: true }; }
    if (/^[1-9]$/.test(key) || (key === "0" && p.count !== "")) { p.count += key; return { handled: true }; }

    // text objects extend the selection to exactly that object (vim-only: busybox
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
      const res = this._shiftLines(range.from, range.to, key === ">");
      this.mode = Mode.NORMAL;
      this.visual = null;
      return { ...res, handled: true };
    }

    const opMap = { d: "d", x: "d", y: "y", c: "c", s: "c" };
    if (opMap[key]) {
      const range = this._visualRange();
      const op = opMap[key];
      this.mode = Mode.NORMAL;
      this.visual = null;
      this.pending = this._emptyPending();
      const res = this._applyOperatorRange(op, range.from, range.to, range.linewise, true);
      if (op === "y") this.state.cursor = range.from;   // vim parks at the start
      return res;
    }
    if (key === "~") {
      const range = this._visualRange();
      const slice = this.text.slice(range.from, range.to);
      const flipped = [...slice].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");
      this._pushUndo({ text: this.text, cursor: this.state.cursor });
      this.state.text = this.text.slice(0, range.from) + flipped + this.text.slice(range.to);
      this.state.cursor = range.from;
      this.mode = Mode.NORMAL; this.visual = null;
      return { handled: true, edit: true };
    }
    if (key === "J") {
      const range = this._visualRange();
      const slice = this.text.slice(range.from, range.to).replace(/\n\s*/g, " ");
      this._pushUndo({ text: this.text, cursor: this.state.cursor });
      this.state.text = this.text.slice(0, range.from) + slice + this.text.slice(range.to);
      this.state.cursor = range.from;
      this.mode = Mode.NORMAL; this.visual = null;
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
    const r = this._vertical(step, dir);
    this.state.cursor = B.firstNonBlank(this.text, B.lineOffset(this.text, B.lineNumber(this.text, r.to)));
    this.onScroll(Math.max(0, B.lineNumber(this.text, this.state.cursor) - (dir > 0 ? 0 : vp.height - 1)));
    return { handled: true };
  }
  _halfPage(dir) {
    const vp = this._viewport();
    const step = vp ? Math.max(1, Math.floor(vp.height / 2)) : this._takeCount(20);
    const r = this._vertical(step, dir);
    this.state.cursor = r.to;
    if (vp) this.onScroll(Math.max(0, B.lineNumber(this.text, this.state.cursor) - (dir > 0 ? 0 : vp.height - 1)));
    return { handled: true };
  }
  _scrollLines(dir) {
    const vp = this._viewport();
    if (!vp) { this.onStatus("no viewport on this host", "error"); return { handled: true }; }
    this.onScroll(Math.max(0, vp.top + dir));
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
      this.state.text = text.slice(0, at) + payload + text.slice(at);
      this.state.cursor = at + payload.length;
      this._insertKey("Esc");          // leaves insert mode and records the change
      return { handled: true, edit: true, ...moved };
    }
    if (lc.kind === "del") return this._deleteChars(count, !!lc.backwards);
    if (lc.kind === "tilde") return this._toggleCase(count);
    if (lc.kind === "join") return this._join(count);
    if (lc.kind === "replace") return this._replaceChars(count, lc.ch);
    if (lc.kind === "shift") return this._shift(count, lc.right);
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
