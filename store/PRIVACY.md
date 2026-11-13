# jsbarevi — privacy policy

_Last updated: 2026-11-13_

jsbarevi is a browser extension that gives text fields traditional vi
keybindings. It runs entirely inside your browser.

## What jsbarevi does not do

- It does not collect, transmit, sell or share any data.
- It has no analytics, no telemetry, no accounts, and no server.
- It does not read, log or store the contents of any page or text field. Text
  you edit stays in the field you are editing.
- It does not inject remote code. Everything it runs is inside the extension
  package.

## What it stores on your device

Three settings, in the browser's extension storage (`chrome.storage.local`):

1. the master on/off switch,
2. the list of hosts you turned the extension off for,
3. the local editor endpoint you configured for the `:e` command.

These never leave your machine.

## The one network request

If — and only if — you type `:e` in a field, the extension sends that field's
text to the **local** editor endpoint you configured (by default
`http://127.0.0.1:31416/`, a pyTextFilter-compatible server running on your own
computer) and reads the edited text back. No other endpoint is ever contacted,
and the extension holds host permissions for no host except `127.0.0.1` and
`localhost`. If you never type `:e`, the extension makes no network requests at
all.

## Permissions, and why

| Permission | Why |
|---|---|
| Content script on all sites | The product is editing text fields on the pages you visit. It attaches to a field only after you focus it, and touches only that field's text. |
| `storage` | Holds the three settings above. |
| `activeTab` | Lets the popup identify the current site when you click the toolbar icon, so you can turn the extension off for that site. |
| `http://127.0.0.1/*`, `http://localhost/*` | The `:e` request to your own local editor server. |

## Limited Use disclosure

jsbarevi's use of any data it touches is limited to its single purpose — providing vi
keybindings for text fields:

- **Allowed use:** field text is read only to display and edit it in the field you are
  focused on. Nothing is used for any other purpose.
- **No transfer:** nothing is sold, transferred or disclosed to anyone. There is no
  server, no analytics and no third party.
- **No advertising:** no data is used or transferred for personalised, re-targeted or
  interest-based advertising.
- **No human reading:** no human — including the developer — can read what you type.
  There is no channel for it to reach anyone.
- **Local only:** the three settings described above are the only thing stored, and they
  live in your browser's extension storage.

This disclosure applies to the whole extension, not to a subset of features.

## Contact

Open an issue at https://github.com/edyfox/jsbarevi/issues, or write to the
address published with the extension listing.

## Changes

If this policy ever changes, the change ships with a new extension version and
the date above moves.
