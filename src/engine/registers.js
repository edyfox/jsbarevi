// The registers we support, and deliberately nothing more.
//
//   ""    the unnamed register — what `p` reads, and what every yank and delete writes
//   a-z   named registers (one character, one store; `"ayy` then `"ap` is the whole API)
//   + *   the SYSTEM CLIPBOARD, a host capability (see adapters/clipboard.js). `*` is an
//         ALIAS of `+` here on purpose: on X11 they are primary-selection vs clipboard,
//         but a browser exposes one clipboard, and a bare editor has no business
//         inventing a second one it cannot fill.
//   _     the BLACK HOLE: writes go nowhere and reads get nothing, so `"_dd` deletes
//         without disturbing the unnamed register (or the clipboard)
//   =     an expression, evaluated when the register is read
//
// Deliberately NOT here: `"1`–`"9`, `"0` and `"-`. Vim's numbered registers are not one
// rule but three that interact — they rotate on a linewise or multi-line delete, hold
// every *small* delete back in `"-` instead, and rotate anyway when the small delete was
// given a named register. Measured against vim 9.2 and written down in docs/ENGINE.md;
// the measurements are the argument against porting them: the rotation exists so you can
// walk back through a session's deletes, which is not what this editor is for, and the
// small/big split needs a per-operation classification that nothing else in the engine
// has. A bare vi needs the unnamed register and one escape hatch to the real clipboard.
//
// Named registers are here because they are one line each, and `"A`-style appending is
// in as well: not because it is useful, but because leaving it out is a SILENT WRONG —
// `"Ayy` would quietly create a second register named `A` instead of appending, and a
// wrong is worse than a gap. The append rule is one condition (see `_append`), measured
// for all four type combinations rather than assumed.

/** Is this a name we can store into and read back? */
export function isNamed(name) {
  return typeof name === "string" && /^[a-zA-Z]$/.test(name);
}

/** The two spellings of the system clipboard. One clipboard, two names. */
export function isClipboard(name) {
  return name === "+" || name === "*";
}

export class Registers {
  /**
   * @param {{clipboard?: {read: () => string|null, write: (text: string) => void}|null}} opts
   */
  constructor(opts = {}) {
    this.store = new Map();          // "a".."z" (and the unnamed `"` marker)
    this.clipboard = opts.clipboard || null;
    this.expression = null;
  }

  /** The `=` register's value, set by the expression prompt. */
  setExpression(text) { this.expression = text; }

  /**
   * Read a register. `name` is null for the unnamed one.
   * Returns `{text, linewise}` or null when there is nothing to paste.
   */
  read(name = null) {
    if (name === "_") return null;              // nothing ever goes in, so nothing comes out
    if (isClipboard(name)) return this._readClipboard();
    if (name === "=") {
      if (this.expression == null) return null;
      return { text: this.expression, linewise: false };
    }
    return this.store.get(name || '"') || null;
  }

  /**
   * Record a yank or a delete. Returns `{ok}` or `{ok: false, error}` for a name we do
   * not write (the caller reports it: a silently ignored `"+` would look like it worked).
   */
  write({ text, linewise = false, name = null }) {
    const entry = { text, linewise: !!linewise };

    // The black hole returns before ANY other store is touched — that is its whole
    // point: `"_dd` must leave the unnamed register alone, not merely skip one of them.
    if (name === "_") return { ok: true };

    if (isClipboard(name)) {
      // The unnamed register still tracks it: `"+yy` then `p` is a yank like any other.
      this.store.set('"', entry);
      this._writeClipboard(text, linewise);
      return { ok: true };
    }
    if (name === "=") return { ok: false, error: "cannot write to the expression register" };
    if (name !== null && !isNamed(name)) return { ok: false, error: `unsupported register: ${name}` };
    if (name === null) { this.store.set('"', entry); return { ok: true }; }

    const stored = /^[A-Z]$/.test(name) ? this._append(name.toLowerCase(), entry) : entry;
    this.store.set(name.toLowerCase(), stored);
    // The unnamed register follows the register's CONTENT, appended part included —
    // measured: `"ayy"Ayy"ap""p` pastes the merged two lines twice, not once plus once.
    this.store.set('"', stored);
    return { ok: true };
  }

  /**
   * `"A`-form append. The only non-obvious part, and it is one rule:
   *
   *   if EITHER side is linewise, the result is linewise and the new text becomes its
   *   own line; otherwise the two texts are concatenated.
   *
   * Measured against vim for all four combinations (`"ayy"Ayy`, `"ayy"Ayw`, `"ayw"Ayy`,
   * `"ayw"Ayw`), which is why it is written as one condition rather than four cases.
   */
  _append(key, entry) {
    const prev = this.store.get(key);
    if (!prev) return entry;
    if (prev.linewise || entry.linewise) {
      return {
        text: `${prev.text.replace(/\n$/, "")}\n${entry.text.replace(/\n$/, "")}`,
        linewise: true,
      };
    }
    return { text: prev.text + entry.text, linewise: false };
  }

  /** Everything a diagnostic wants to know, without leaking page content into logs. */
  names() {
    const out = ["\""];
    for (const key of this.store.keys()) if (key !== '"') out.push(key);
    if (this.expression != null) out.push("=");
    if (this.clipboard) out.push("+");
    return out;
  }

  _readClipboard() {
    if (!this.clipboard) return null;
    let value = null;
    try { value = this.clipboard.read(); } catch { return null; }
    if (value == null) return null;
    // The system clipboard carries TEXT, not a type. Vim guesses: a trailing newline
    // means linewise, everything else is characterwise. Same guess, so `"+p` after
    // copying two lines elsewhere pastes two lines instead of joining them.
    const linewise = value.endsWith("\n");
    return { text: linewise ? value.replace(/\n$/, "") : value, linewise };
  }

  _writeClipboard(text, linewise) {
    if (!this.clipboard) return;
    // A linewise yank leaves a trailing newline in the clipboard, which is what makes
    // the guess above come back as linewise when the same text is pasted again.
    const payload = linewise ? text.replace(/\n$/, "") + "\n" : text;
    try { this.clipboard.write(payload); } catch { /* the host reports its own failure */ }
  }
}
