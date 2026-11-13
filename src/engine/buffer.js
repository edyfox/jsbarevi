// Buffer model: a plain string plus integer offsets.
//
// Deliberate choice: the engine works on ONE immutable string and indexes into
// it. busybox uses a mutable char* and memmoves it, which is why its C code is
// full of pointer bookkeeping; a string makes that bookkeeping disappear.
//
// Indices are UTF-16 code units (what JS strings use). "Characters" are stepped
// with nextChar/prevChar so a surrogate pair is never split; the review's
// "offset unit = code point" concern is handled at character granularity rather
// than by converting the whole model.

export const isWordChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
export const isBlank = (c) => c === " " || c === "\t";

// --- the trailing-terminator invariant -------------------------------------
// The engine's buffer ALWAYS ends with exactly one "\n", and the host's text is
// that buffer minus the terminator. Two references settle this, and neither one
// works without it:
//
//   * busybox appends the newline a file is missing precisely so that `dot_end()`
//     can return a real '\n' for the last line and the end-of-command `dot--`
//     normalisation has something to step back off (vi.c);
//   * vim's buffer is a list of lines, not a byte range, so the newline after the
//     last line exists whether or not the file ends with one - which is the only
//     way "delete the last line's text" can leave an EMPTY last line rather than
//     shortening the buffer by a line.
//
// Without the terminator the empty-buffer, empty-last-line and
// last-line-without-an-EOL cases are simply not representable, which is what the
// alignment audit kept reporting as 70 unrelated-looking failures.
export const ensureEol = (t) => (t.endsWith("\n") ? t : `${t}\n`);

/** The host's view of the buffer: the documented text minus its terminator. */
export const hostText = (t) => (t === "\n" ? "" : t.replace(/\n$/, ""));

/**
 * A <textarea>'s value is line-*separated*, not line-*terminated*: "a\nb\n" is
 * three lines, the last one empty. The buffer is line-terminated, so a field value
 * ending in a newline needs one more before it means the same thing - otherwise
 * the empty last line disappears the moment the value goes through setText().
 * File text (what the oracle cases contain) needs no conversion: there a trailing
 * newline really is the terminator.
 */
export const fromField = (value) => (value.endsWith("\n") ? `${value}\n` : value);

export function nextChar(text, i) {
  if (i >= text.length) return i;
  const cp = text.codePointAt(i);
  return i + (cp > 0xffff ? 2 : 1);
}

export function prevChar(text, i) {
  if (i <= 0) return 0;
  const lo = text.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = text.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return i - 2;
  }
  return i - 1;
}

export function charAt(text, i) {
  if (i < 0 || i >= text.length) return undefined;
  return String.fromCodePoint(text.codePointAt(i));
}

// --- lines -----------------------------------------------------------------
export function lineStart(text, i) {
  if (i > text.length) i = text.length;
  const from = i - 1;
  // NB: do NOT clamp `from` to 0 — lastIndexOf("\n", 0) would match a newline
  // sitting AT index 0 and claim position 0 starts on line 2.
  const nl = from < 0 ? -1 : text.lastIndexOf("\n", from);
  return nl === -1 ? 0 : nl + 1;
}

export function lineEnd(text, i) {
  const nl = text.indexOf("\n", i);
  return nl === -1 ? text.length : nl;
}

export function lineText(text, i) {
  return text.slice(lineStart(text, i), lineEnd(text, i));
}

export function lineNumber(text, i) {
  let n = 0;
  for (let k = 0; k < i && k < text.length; k++) if (text[k] === "\n") n++;
  return n;
}

export function lineCount(text) {
  if (text.length === 0) return 1;
  let n = 1;
  for (let k = 0; k < text.length; k++) if (text[k] === "\n") n++;
  // the newline at EOF terminates the last line rather than starting a new one
  return text.endsWith("\n") ? Math.max(1, n - 1) : n;
}

/** Offset of the start of line `n` (0-based). Clamped to the last line. */
export function lineOffset(text, n) {
  if (n <= 0) return 0;
  const max = lineCount(text) - 1;
  if (n > max) n = max;
  let seen = 0;
  for (let k = 0; k < text.length; k++) {
    if (text[k] === "\n" && ++seen === n) return k + 1;
  }
  return lineStart(text, text.length);
}

export function firstNonBlank(text, i) {
  const s = lineStart(text, i);
  const e = lineEnd(text, i);
  let k = s;
  while (k < e && isBlank(text[k])) k = nextChar(text, k);
  return k >= e ? s : k;
}

/** Last character offset of the line (never the newline; never past the end). */
export function lastCharOffset(text, i) {
  const s = lineStart(text, i);
  const e = lineEnd(text, i);
  if (e === s) return s;
  return prevChar(text, e);
}

/** Is `i` on the (virtual) newline / end-of-line position? */
export function isLineEmpty(text, i) {
  return lineStart(text, i) === lineEnd(text, i);
}

/** Clamp an offset into the line containing `reference`, at most its last char. */
export function clampToLineEnd(text, reference, offset) {
  const s = lineStart(text, reference);
  const last = lastCharOffset(text, reference);
  if (offset < s) return s;
  if (offset > last) return last;
  return offset;
}

/** Total number of lines whose text is non-empty (used by `%` status). */
export function charCount(text) {
  return [...text].length;
}

// --- words -----------------------------------------------------------------
// Traditional vi: a "word" is a run of [A-Za-z0-9_]; a run of other non-blank
// characters is also a word (punctuation counts as a word of its own); runs of
// blanks separate words. WORD (`W`) is any run of non-blanks.
function classify(c, big) {
  if (c === undefined || c === "\n" || isBlank(c)) return "space";
  if (big) return "word";
  return isWordChar(c) ? "word" : "punct";
}

export function wordForward(text, i, big = false) {
  const kind = classify(charAt(text, i), big);
  let k = i;
  // skip the rest of the current word/punct run
  while (k < text.length && classify(charAt(text, k), big) === kind && kind !== "space") {
    const c = charAt(text, k);
    if (c === "\n") break;
    k = nextChar(text, k);
  }
  // then skip separators (blanks and newlines) - but an EMPTY line is a word
  // stop, so `w` from "a" in "a\n\nb" lands on the blank line rather than on "b"
  // (measured against vim; motion.txt: "an empty line counts as a word").
  while (k < text.length && classify(charAt(text, k), big) === "space") {
    if (charAt(text, k) === "\n" && isLineEmpty(text, k + 1)) return k + 1;
    k = nextChar(text, k);
  }
  return k;
}

export function wordBack(text, i, big = false) {
  let k = prevChar(text, i);
  while (k > 0 && classify(charAt(text, k), big) === "space") {
    // the mirror of `w`: an empty line is a word stop, so `b` from "b" in
    // "a\n\nb" stops on the blank line instead of on "a".
    if (k === lineStart(text, k) && isLineEmpty(text, k)) return k;
    k = prevChar(text, k);
  }
  const kind = classify(charAt(text, k), big);
  while (k > 0) {
    const p = prevChar(text, k);
    if (classify(charAt(text, p), big) !== kind) break;
    k = p;
  }
  return k;
}

export function wordEnd(text, i, big = false) {
  const kind0 = classify(charAt(text, i), big);
  // still inside a word: the end of this word is ahead, unless we are already on it
  if (kind0 !== "space") {
    let k = nextChar(text, i);
    if (k < text.length && classify(charAt(text, k), big) === kind0) {
      while (k < text.length && classify(charAt(text, k), big) === kind0) k = nextChar(text, k);
      return prevChar(text, k);
    }
  }
  // at the end of a word already: the next word's end, crossing line breaks
  let k = kind0 === "space" ? i : nextChar(text, i);
  while (k < text.length && classify(charAt(text, k), big) === "space") k = nextChar(text, k);
  // past the end: the last character of the last line, never the trailing newline
  if (k >= text.length) return text.length ? lastCharOffset(text, text.length - 1) : 0;
  const kind = classify(charAt(text, k), big);
  while (k < text.length && classify(charAt(text, k), big) === kind) k = nextChar(text, k);
  return prevChar(text, k);
}

// --- paragraphs and sentences ----------------------------------------------
export function paragraphForward(text, i, count = 1) {
  let k = i;
  const last = lineCount(text) - 1;
  for (let n = 0; n < count; n++) {
    // to the next empty line
    k = lineEnd(text, k);
    if (k < text.length) k += 1; // step over \n
    while (k < text.length && !isLineEmpty(text, k)) {
      const ln = lineNumber(text, k);
      // NOTE: without this bound, a buffer whose last line is non-empty loops
      // forever - lineOffset() clamps to the last line, so k stops advancing.
      if (ln >= last) { k = text.length; break; }
      k = lineOffset(text, ln + 1);
    }
  }
  return Math.min(k, Math.max(0, text.length === 0 ? 0 : prevChar(text, text.length)));
}

export function paragraphBack(text, i, count = 1) {
  let k = i;
  for (let n = 0; n < count; n++) {
    const ln = lineNumber(text, k);
    let target = ln;
    // walk up to the previous blank line (or line 0)
    while (target > 0 && !isLineEmpty(text, lineOffset(text, target - 1))) target--;
    k = lineOffset(text, Math.max(0, target));
  }
  return k;
}

const SENTENCE_END = /[.!?]/;

export function sentenceForward(text, i, count = 1) {
  let k = i;
  for (let n = 0; n < count; n++) {
    let e = lineEnd(text, k);
    let found = -1;
    for (let p = k; p < e; p = nextChar(text, p)) {
      if (SENTENCE_END.test(charAt(text, p))) {
        let q = nextChar(text, p);
        while (q < e && /[)\]"'”’]/.test(charAt(text, q))) q = nextChar(text, q);
        if (q >= e || isBlank(charAt(text, q))) {
          found = q;
          break;
        }
      }
    }
    if (found === -1) {
      // next line's first non-blank, or EOF
      if (e >= text.length) return lastCharOffset(text, e);
      e += 1;
      k = e < text.length ? firstNonBlank(text, e) : e;
      continue;
    }
    while (found < text.length && /[\s)\]"'”’]/.test(charAt(text, found))) found = nextChar(text, found);
    k = found >= text.length ? lastCharOffset(text, text.length) : found;
  }
  return k;
}

export function sentenceBack(text, i, count = 1) {
  let k = i;
  for (let n = 0; n < count; n++) {
    let p = prevChar(text, k);
    let hit = -1;
    while (p > 0) {
      if (SENTENCE_END.test(charAt(text, p))) {
        const q = nextChar(text, p);
        if (q >= text.length || /\s/.test(charAt(text, q))) {
          hit = q;
          break;
        }
      }
      p = prevChar(text, p);
    }
    if (hit === -1) return 0;
    while (hit < text.length && /\s/.test(charAt(text, hit))) hit = nextChar(text, hit);
    k = hit;
  }
  return k;
}

// --- bracket matching ------------------------------------------------------
const PAIRS = { "(": ")", "[": "]", "{": "}", "<": ">" };
const RP = { ")": "(", "]": "[", "}": "{", ">": "<" };

export function matchBracket(text, i) {
  const c = charAt(text, i);
  if (!c) return null;
  if (PAIRS[c]) {
    const close = PAIRS[c];
    let depth = 0;
    for (let k = i; k < text.length; k = nextChar(text, k)) {
      const ch = charAt(text, k);
      if (ch === c) depth++;
      else if (ch === close && --depth === 0) return k;
    }
    return null;
  }
  if (RP[c]) {
    const open = RP[c];
    let depth = 0;
    for (let k = i; k >= 0; k = prevChar(text, k)) {
      const ch = charAt(text, k);
      if (ch === c) depth++;
      else if (ch === open && --depth === 0) return k;
      if (k === 0) break;
    }
    return null;
  }
  return null;
}
