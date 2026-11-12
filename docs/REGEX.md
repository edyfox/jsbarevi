# REGEX — the `:s` and `/` contract

Ruling: **JS `RegExp`, no POSIX translator.** One engine serves both `:s` and
`/ ?`; `ignorecase` maps to the `i` flag. Emulating POSIX BRE is not worth the
code, and the user is told what differs.

## Why a wrapper at all

"No wrapper" is not the simple option — it is the **silently wrong** option,
because Vim's default pattern syntax and JS disagree on the three things people
type most:

| You type | Vim means | Raw JS means |
|---|---|---|
| `\d\+` | one or more digits | a digit followed by a **literal `+`** → matches nothing |
| `\<word\>` | word boundaries | `\<` is an identity escape → matches a literal `<` |
| `foo\|bar` | alternation | a literal `|` → matches nothing |

Three silent non-matches. So the wrapper exists to convert them into correct
behaviour, and to convert the fourth class (POSIX-only constructs) into a loud
refusal.

## Translate (outside bracket expressions)

| Vim | JS | Note |
|---|---|---|
| `\+` | `+` | |
| `\?` `\=` | `?` | `\=` is Vim's older spelling of the same thing |
| `\(` `\)` | `(` `)` | |
| `\|` | `\|` | |
| `\{` `\}` | `{` `}` | |
| `\<` | `\b(?=\w)` | start of word |
| `\>` | `\b(?<=\w)` | end of word |

Bracket-expression state is tracked char by char: everything inside `[...]` is
left alone (`[\+*]` is a character class, not a quantifier).

Nothing else is rewritten. `\d \s \w \b`, `.`, `*`, `[]`, `^ $`, non-greedy `*?`,
and `.` not matching newline are already identical between Vim and JS.

## Replacement syntax follows Vim (not busybox)

The replacement is walked once into a **replacer function**, so JS never
reinterprets `$&`, `$$`, `` $` ``:

| Vim | Meaning |
|---|---|
| `&`, `\0` | whole match |
| `\1`–`\9` | capture group |
| `\n`, `\r` | newline — works because our buffer is a plain string |
| `\\` | literal backslash |

busybox treats `&` **literally** in the replacement; Vim expands it. We follow
Vim.

## Refuse, with a message naming the construct

Never a silent non-match:

- `\zs` `\ze` (match start/end)
- `\%(…\)` `\%[…]` (non-capturing group, collection)
- `\@!` `\@<=` `\@<!` (Vim lookaround spellings — use JS lookaround directly)
- `\{-…}` (Vim non-greedy)
- `[[:alpha:]]` and the other POSIX classes — never supported by JS; tell the user
  the equivalent (`\s`, `\w`, `\d`) instead
- the mode switches `\v \m \M \V`

## Known, documented deviations

1. **Leftmost-first vs leftmost-longest.** JS prefers the first alternative that
   can match; POSIX prefers the longest. `a\|ab` on `ab` picks `a` for us, `ab`
   for POSIX.
2. **`ignorecase` is a flag**, not a `:set` interaction with a regex cache — no
   difference in behaviour, but it means changing `:set ic` takes effect
   immediately.
3. **Empty pattern** (`:s//new/`) reuses the last pattern, as both busybox and Vim
   do. `/` on an empty prompt likewise.

## Cost

~85 lines plus tests: a pattern walker with the translate/refuse tables, and a
replacement walker. No POSIX matching engine, no lookaround translation beyond
`\<`/`\>`.
