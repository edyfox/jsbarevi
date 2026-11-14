// The `:` line and the regex contract (docs/REGEX.md).
//
// Ruling: JS RegExp, no POSIX translator. A pattern is translated where Vim and
// JS disagree in a SILENT way (\+ is literal in JS, \< is an identity escape),
// refused where there is no cheap equivalent, and passed through otherwise.
// Replacement syntax follows Vim, not JS: it is walked into a replacer function
// so JS never reinterprets $&, $$ or $`.

import * as B from "./buffer.js";

const REFUSE = [
  ["\\zs", "\\zs (match start) has no JS equivalent"],
  ["\\ze", "\\ze (match end) has no JS equivalent"],
  ["\\%(", "\\%( non-capturing groups have no JS equivalent; use (?: )"],
  ["\\%[", "\\%[ has no JS equivalent"],
  ["\\@!", "\\@! has no JS equivalent; use a negative lookahead"],
  ["\\@<=", "\\@<= has no JS equivalent; use a lookbehind"],
  ["\\@<!", "\\@<! has no JS equivalent; use a negative lookbehind"],
  ["\\{-", "\\{- non-greedy has no JS equivalent; use *? or +?"],
  ["\\v", "\\v (very magic) is not supported"],
  ["\\m", "\\m (magic) is not supported; the default is the only mode"],
  ["\\M", "\\M (nomagic) is not supported"],
  ["\\V", "\\V (very nomagic) is not supported"],
];

const POSIX_CLASS = /\[:(\w+):\]/;

/** Translate one Vim pattern into a JS RegExp source. Throws on refuse-list hits. */
export function translatePattern(pattern) {
  for (const [needle, why] of REFUSE) {
    if (pattern.includes(needle)) throw new Error(why);
  }
  const cls = pattern.match(POSIX_CLASS);
  if (cls) {
    throw new Error(
      `[[:${cls[1]}]] is a POSIX class and JS cannot match it; use \\` +
        ({ space: "s", alpha: "w", alnum: "w", digit: "d", lower: "a-z", upper: "A-Z" }[cls[1]] || "…"),
    );
  }
  let out = "";
  let inBracket = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const n = pattern[i + 1];
      if (inBracket) {
        out += c + (n ?? "");
        i++;
        continue;
      }
      switch (n) {
        case "+": out += "+"; i++; continue;
        case "?": case "=": out += "?"; i++; continue;
        case "(": out += "("; i++; continue;
        case ")": out += ")"; i++; continue;
        case "|": out += "|"; i++; continue;
        case "{": out += "{"; i++; continue;
        case "}": out += "}"; i++; continue;
        case "<": out += "\\b(?=\\w)"; i++; continue;
        case ">": out += "\\b(?<=\\w)"; i++; continue;
        default: out += c + (n ?? ""); i++; continue;
      }
    }
    if (c === "[" && !inBracket) inBracket = true;
    else if (c === "]" && inBracket) inBracket = false;
    out += c;
  }
  return out;
}

export function compilePattern(pattern, { ignorecase = false } = {}) {
  const source = translatePattern(pattern);
  try {
    return new RegExp(source, ignorecase ? "gi" : "g");
  } catch (err) {
    throw new Error(`invalid pattern: ${err.message}`);
  }
}

/** Walk a Vim replacement into a replacer function (JS $ syntax never applies). */
export function replacementFunction(replacement) {
  return (...args) => {
    const whole = args[0];
    const groups = args.slice(1, -2);
    let out = "";
    for (let i = 0; i < replacement.length; i++) {
      const c = replacement[i];
      if (c === "&") { out += whole; continue; }
      if (c === "\\") {
        const n = replacement[i + 1];
        if (n === undefined) { out += "\\"; continue; }
        if (/[0-9]/.test(n)) { out += n === "0" ? whole : groups[Number(n) - 1] ?? ""; i++; continue; }
        if (n === "n" || n === "r") { out += "\n"; i++; continue; }
        if (n === "&") { out += "&"; i++; continue; }
        if (n === "\\") { out += "\\"; i++; continue; }
        out += n; i++; continue;
      }
      out += c;
    }
    return out;
  };
}

// --- ranges ----------------------------------------------------------------
function splitRangeSpec(spec) {
  const out = [];
  let cur = "";
  let inPattern = null;
  for (const ch of spec) {
    if (inPattern) {
      cur += ch;
      if (ch === inPattern) inPattern = null;
      continue;
    }
    if (ch === "/" || ch === "?") { inPattern = ch; cur += ch; continue; }
    if (ch === "," || ch === ";") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Resolve a Vim range spec into [firstLine, lastLine] (0-based, inclusive).
 * Supports numbers, `.`, `$`, `%`, `/pat/`, `?pat?`, `'x`, and one address.
 */
export function resolveRange(engine, spec) {
  const text = engine.text;
  const curLine = B.lineNumber(text, engine.cursor);
  const lastLine = B.lineCount(text) - 1;
  if (!spec || spec.trim() === "") return [curLine, curLine];
  if (spec.trim() === "%") return [0, lastLine];

  const parts = splitRangeSpec(spec);
  const address = (a, def) => {
    a = a.trim();
    if (a === "") return def;
    if (a === ".") return curLine;
    if (a === "$") return lastLine;
    if (/^\d+$/.test(a)) return Number(a) - 1;
    if (/^'[a-z]$/.test(a)) {
      const mk = engine.marks.get(a[1]);
      return mk == null ? def : B.lineNumber(text, mk);
    }
    if (/^[/?]/.test(a)) {
      const dir = a[0];
      const pat = a.slice(1, -1) || engine.lastSearch;
      if (!pat) throw new Error("no previous search pattern");
      const re = compilePattern(pat, engine.options);
      re.lastIndex = 0;
      if (dir === "/") {
        const from = B.lineOffset(text, curLine + 1);
        const m = re.exec(text.slice(from));
        if (!m) throw new Error(`pattern not found: ${pat}`);
        return B.lineNumber(text, from + m.index);
      }
      const before = text.slice(0, B.lineOffset(text, curLine));
      let found = -1;
      let m;
      while ((m = re.exec(before)) !== null) found = m.index;
      if (found < 0) throw new Error(`pattern not found: ${pat}`);
      return B.lineNumber(text, found);
    }
    if (/^[+-]\d+$/.test(a)) return Math.max(0, Math.min(lastLine, curLine + Number(a)));
    throw new Error(`invalid address: ${a}`);
  };

  if (parts.length === 1) {
    const n = address(parts[0], curLine);
    return [n, n];
  }
  const a = address(parts[0], curLine);
  const b = address(parts[1], parts[0] === "" ? a : curLine);
  return [Math.min(a, b), Math.max(a, b)];
}

/** Split `[range]cmd[!] args` into its pieces. */
export function parseEx(line) {
  // No space is required before the argument: `:s/a/b/` is one token. The range
  // prefix may itself contain `/pat/`, so it is consumed before the command word.
  const m = line.match(/^([%$.,;0-9'/?+-]*)([a-zA-Z]+|!|=|&|<|>|~|#|@|\*)(!?)([\s\S]*)$/);
  if (!m) return { range: "", cmd: "", bang: false, args: "" };
  return { range: m[1] ?? "", cmd: m[2], bang: m[3] === "!", args: (m[4] ?? "").replace(/^\s+/, "") };
}

const OPTION_ALIASES = {
  ai: "autoindent", autoindent: "autoindent",
  et: "expandtab", expandtab: "expandtab",
  ic: "ignorecase", ignorecase: "ignorecase",
  scs: "smartcase", smartcase: "smartcase",
  sm: "showmatch", showmatch: "showmatch",
  flash: "flash", fl: "flash",
  ts: "tabstop", tabstop: "tabstop",
  sw: "shiftwidth", shiftwidth: "shiftwidth",
};

export function applySet(engine, args) {
  const notes = [];
  for (const raw of args.split(/\s+/).filter(Boolean)) {
    const m = raw.match(/^(\w+)(?:=(\d+))?$/);
    if (!m) return { ok: false, message: `invalid option: ${raw}` };
    const [, name, value] = m;
    const negated = name.startsWith("no");
    const key = OPTION_ALIASES[negated ? name.slice(2) : name];
    if (!key) return { ok: false, message: `unknown option: ${name}` };
    if (value !== undefined) engine.options[key] = Number(value);
    else engine.options[key] = !negated;
    notes.push(`${key}${value !== undefined ? "=" + value : engine.options[key] ? "" : " (off)"}`);
  }
  return { ok: true, message: notes.join(" ") || printOptions(engine) };
}

export function printOptions(engine) {
  const o = engine.options;
  const b = (v) => (v ? "" : "no");
  return [
    `${b(o.autoindent)}autoindent`,
    `${b(o.expandtab)}expandtab`,
    `${b(o.ignorecase)}ignorecase`,
    `${b(o.showmatch)}showmatch`,
    `${b(o.flash)}flash`,
    `tabstop=${o.tabstop}`,
    `shiftwidth=${o.shiftwidth}`,
  ].join(" ");
}

/**
 * Execute one ex command line. Returns {ok, message, exit?}.
 * `engine.session` may implement {open(), write(), close(discard)} for the
 * external-editor escape hatch; without it, those commands report why.
 */
export function runEx(engine, line) {
  const { range, cmd, bang, args } = parseEx(line);
  if (!cmd) {
    if (range.trim() === "") return { ok: true, message: "" };
    const [a] = resolveRange(engine, range);
    engine.cursor = B.firstNonBlank(engine.text, B.lineOffset(engine.text, a));
    return { ok: true, message: "" };
  }
  if (cmd === "s") return exSubstitute(engine, range, args, bang);
  if (cmd === "d" || cmd === "delete") return exDelete(engine, range, args);
  if (cmd === "y" || cmd === "yank") return exYank(engine, range, args);
  if (cmd === "=") {
    const [a] = resolveRange(engine, range);
    return { ok: true, message: String(a + 1) };
  }
  if (cmd === "list" || cmd === "l") {
    const [a, b] = resolveRange(engine, range);
    const out = [];
    for (let n = a; n <= b; n++) {
      const s = B.lineOffset(engine.text, n);
      out.push(B.lineText(engine.text, s).replace(/\t/g, "^I"));
    }
    return { ok: true, message: out.join("$\\n") + "$" };
  }
  if (cmd === "set" || cmd === "se") return applySet(engine, args);
  // vim's :version reports the build, and here it is the only in-field way to tell
  // a stale page from a broken one.
  if (cmd === "version" || cmd === "ve") return { ok: true, message: `jsbarevi ${engine.version || "0.1.0"}` };
  if (cmd === "features") {
    return { ok: true, message: "jsbarevi: no ex mode, no macros, no block visual, JS regex, marks, registers, visual, viewport" };
  }
  if (cmd === "file" || cmd === "f") return { ok: true, message: engine.describeBuffer ? engine.describeBuffer() : "[No Name]" };

  // External-editor session commands.
  const session = engine.session;
  if (cmd === "e" || cmd === "edit") {
    if (args) return { ok: false, message: "no file — this buffer is a page field" };
    if (!session) return { ok: false, message: "no editor transport configured for this host" };
    return session.open();
  }
  if (cmd === "w" || cmd === "write" || cmd === "wq" || cmd === "x") {
    if (!session) return { ok: false, message: "no editor transport configured for this host" };
    const r = session.write ? session.write() : { ok: true };
    if (cmd !== "w") session.close(false);
    return r;
  }
  if (cmd === "q" || cmd === "quit") {
    if (!session) return { ok: true, message: "" };
    session.close(bang);
    return { ok: true, message: "" };
  }
  if (cmd === "read" || cmd === "r" || cmd === "n" || cmd === "next" || cmd === "prev" || cmd === "rewind") {
    return { ok: false, message: `:${cmd} has no meaning in a page field` };
  }
  if (cmd === "!") return { ok: false, message: "no shell in a page" };
  return { ok: false, message: `unknown command: :${cmd}` };
}

function exSubstitute(engine, range, args, bang) {
  const delim = args[0];
  if (!delim) return { ok: false, message: "no pattern" };
  const parts = [];
  let cur = "";
  let esc = false;
  for (let i = 1; i < args.length; i++) {
    const c = args[i];
    if (esc) { cur += "\\" + c; esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === delim) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  const [patRaw, replRaw = "", flags = ""] = parts;
  const pattern = patRaw === "" ? engine.lastSearch : patRaw;
  if (!pattern) return { ok: false, message: "no previous pattern" };
  engine.lastSearch = pattern;
  if (flags.includes("c")) return { ok: false, message: "the c flag needs interaction and is not supported" };

  const [a, b] = resolveRange(engine, range);
  let re;
  try {
    re = compilePattern(pattern, engine.options);
  } catch (err) {
    return { ok: false, message: err.message };
  }
  const global = flags.includes("g");
  const replacer = replacementFunction(replRaw);
  const text = engine.text;
  const pieces = [];
  let last = 0;
  let changed = 0;
  for (let n = a; n <= b; n++) {
    const s = B.lineOffset(text, n);
    const e = B.lineEnd(text, s);
    if (s > last) { pieces.push(text.slice(last, s)); last = s; }
    const lineText = text.slice(s, e);
    re.lastIndex = 0;
    let out = "";
    let pos = 0;
    let m;
    let hits = 0;
    while ((m = re.exec(lineText)) !== null) {
      if (m[0] === "" ) { if (re.lastIndex >= lineText.length) break; re.lastIndex++; continue; }
      out += lineText.slice(pos, m.index) + replacer(m[0], ...m.slice(1), m.index, lineText);
      pos = m.index + m[0].length;
      last = s + pos;
      hits++;
      if (!global) break;
    }
    if (hits) {
      out += lineText.slice(pos);
      pieces.push(out);
      last = e;
      changed++;
    } else {
      pieces.push(lineText);
      last = e;
    }
    // preserve the newline between lines
    if (e < text.length) { pieces.push("\n"); last = e + 1; }
  }
  pieces.push(text.slice(last));
  if (!changed) return { ok: false, message: `pattern not found: ${pattern}` };
  const before = engine.text;
  engine.setText(pieces.join(""), Math.min(engine.cursor, pieces.join("").length));
  engine.noteLineChange?.(a, b, before);
  return { ok: true, message: "" };
}

function exDelete(engine, range, args) {
  const bad = engine.badRegister(args.trim());
  if (bad) return { ok: false, message: bad };
  const [a, b] = resolveRange(engine, range);
  const text = engine.text;
  let from = B.lineOffset(text, a);
  let to = B.lineEnd(text, B.lineOffset(text, b)); // NOTE: offset, not line number
  // include the newline so the lines disappear rather than leaving blanks
  if (to < text.length) to += 1;
  else if (from > 0) from -= 1;
  // A delete, not a yank: `:d` fills the unnamed register through deleteRange.
  engine.deleteRange(from, to, { record: true, linewise: true, reg: args.trim() || null });
  engine.cursor = Math.min(from, Math.max(0, engine.text.length ? engine.text.length - 1 : 0));
  engine.cursor = B.firstNonBlank(engine.text, engine.cursor);
  return { ok: true, message: "" };
}

function exYank(engine, range, args) {
  const bad = engine.badRegister(args.trim());
  if (bad) return { ok: false, message: bad };
  const [a, b] = resolveRange(engine, range);
  const text = engine.text;
  const from = B.lineOffset(text, a);
  let to = B.lineEnd(text, B.lineOffset(text, b));
  if (to < text.length) to += 1;
  engine.yankRange(from, to, true, args.trim() || undefined);
  return { ok: true, message: `${b - a + 1} lines yanked` };
}
