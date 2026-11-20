# Chrome Web Store listing — copy to paste into the dashboard

Everything below is the exact text for the store form. The build artifact is
`dist/jbarevi-<version>.zip` (from `npm run build:ext`).

> **Status (2026-11-20): 0.1.0 is published and its review has PASSED.** The next
> upload ships **0.5.0**, which adds one permission the approved build never had —
> **`clipboardRead`** (added 2026-11-14, `76383b1`) — so that justification is the
> one a reviewer will actually read, and users will see Chrome's
> *"Read data you copy and paste"* warning for the first time.
>
> Upload needs `npm run build:ext` → `dist/jsbarevi-<version>.zip`, and the
> privacy-policy URL in `PRIVACY.md` must be public.

---

## Name (max 75)

```
jsbarevi — vi keys in any text field
```

## Summary / short description (max 132)

```
Traditional vi keys in any text field: NORMAL, VISUAL and INSERT modes, operators, text objects, registers and ex commands.
```

(The build fails if this exceeds 132 characters — see `DESCRIPTION` in
`tools/build-extension.mjs`, which is the single source of this string.)

## Category

`Developer Tools` — secondary `Productivity`.

## Language

English (the field UI is mode names only: `-- INSERT --`, `-- VISUAL --`).

## Detailed description

```
vi keys, in the text field you are already in.

jsbarevi binds the traditional vi command set — not a Vim clone — to
<textarea>, <input> and the composers inside web apps. A field starts in INSERT
and behaves like any other input; press Escape and you are in NORMAL mode: hjkl,
operators with motions and text objects, counts, registers, marks, search, visual
mode, undo, and an ex command line. (Prefer to land in NORMAL? One setting in the
toolbar popup.)

WHAT IT DOES
• Modes: NORMAL, VISUAL, VISUAL LINE, INSERT, and real REPLACE (R)
• Operators: d c y > < = with motions, counts and text objects (iw aw i( a" ip …)
• Motions: h j k l w b e W B E 0 ^ $ | f F t T ; , % { } ( ) G gg H M L
• Screen-line motions for wrapped text: gj gk g0 g$ g^ — and C-b C-d C-e C-f C-u C-y
• Registers, marks as motions, . repeat, vim's undo (one u per change command)
• / ? search with n N * #; :s with real regex translation and an explicit refuse
• :e hands the field to a real editor (pyTextFilter / emacs_chrome protocol)

WHAT IT DOES NOT DO
• No page content is read, collected or transmitted. Ever.
• Insert mode is the browser's: typing, IME and paste stay native.
• Not Vim: no Vim script, no plugins, no :g/:v, no ex mode.

WHO IT IS FOR
People who already use vi or Vim and lose their muscle memory the moment they
click a chat box, a comment field or a search bar.

Privacy: no analytics, no accounts, no network requests except the one you
configure yourself for :e (to your own machine).

Source and issue tracker: https://github.com/edyfox/jsbarevi
Licence: MIT
```

## Single purpose (required field)

```
Provide traditional vi (NORMAL / VISUAL / INSERT) keybindings for editing text
inside text fields on web pages.
```

## Permission justifications

**`storage`**
```
Saves the extension's own configuration: the master on/off switch, the list of
hosts the user turned off, and the local editor endpoint used by :e. Nothing
else is stored.
```

**`activeTab`**
```
The popup offers a per-site on/off switch. Clicking the toolbar icon grants
access to the current tab so the popup can ask the page which host it is on. No
tab URLs are read at any other time.
```

**`clipboardRead`**
```
Used only for the vi "+ register: "+y copies, "+p pastes, and Ctrl-R + inserts
the register in insert mode. The read is synchronous (execCommand("paste") into
a hidden field with the focus restored) because the browser's clipboard API is
asynchronous and a per-site prompt would fail on most pages. A field taking
focus also refreshes it without blocking. Nothing else is read or transmitted.
```

**Host permissions `http://127.0.0.1/*` and `http://localhost/*`**
```
Used only for the :e command: when the user explicitly types :e in a field, the
field's text is POSTed to the local editor server the user configured in the
popup (default http://127.0.0.1:31416/, a pyTextFilter-compatible endpoint) and
the edited text is read back. No other host is contacted, and nothing is sent
anywhere unless the user invokes :e.
```

**Content script on `<all_urls>`**
```
The extension's entire purpose is editing text fields on the pages the user
visits, so it has to be present on them. It reads nothing from the page: the
engine attaches to a field only after the user focuses it, and only the focused
field's text is touched. Nothing is transmitted.
```

## Remote code

`No, I do not use remote code.` — everything is in the package; there is no
`eval`, no remote script, no dynamic import of a network resource.

## Data usage / privacy practices

- Data collected: **none**. Do not tick any collection category.
- Certify: not being sold to third parties, not used for unrelated purposes, not
  used to determine creditworthiness.
- Privacy policy URL: **required** — host `store/PRIVACY.md` somewhere public
  and paste the URL.

## Screenshots (1280×800, PNG)

Generated by `npm run store:shots` into `store/screenshots/`:

| File | Caption |
|---|---|
| `01-normal.png` | NORMAL mode in any text field — block caret, mode badge, one engine |
| `02-visual.png` | VISUAL LINE: the selection is drawn by the editor, not the OS |
| `03-command-line.png` | The `:` line: ex commands with ranges and real regex |
| `04-insert.png` | INSERT stays the browser's: typing, IME and paste |

## Small promo tile (440×280, optional)

`store/promo-440x280.png` — generated by the same script.

## Upload checklist

1. `npm run build:ext` → `dist/jbarevi-<version>.zip` (the version comes from `package.json`)
2. Chrome Web Store dashboard → New item → upload the zip.
3. Paste the text above into the matching fields; upload the screenshots.
4. Fill in the privacy questionnaire (all "no").
5. Submit for review. Expect a manual review because of the broad host access —
   the justification above is the answer to it.
