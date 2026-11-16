// Mode survives a focus loss.
//
// vi has no "unfocused" mode, and an editor you come back to should still be the editor
// you left: leaving a composer in INSERT and returning to it in NORMAL means the next
// keystroke you aim at the text (`a`, `x`, a letter) is quietly a command. The engine
// cannot know this on its own — a blur is a host event — so the adapters remember the
// mode and the engine is told on the way back in.
//
// The rule lives here, once, because both adapters would otherwise re-derive it, and the
// first divergence would be a mode that only one host restores.
//
// What is NOT restored, and why:
//
//   * REPLACE (`R`) — it rebuilds the buffer from the snapshot taken when the key was
//     pressed, and a blur is time in which the host can change the text underneath it.
//     Coming back in plain INSERT would silently turn `R` into `i`, so it comes back in
//     NORMAL and says nothing.
//   * VISUAL — the selection the user made is gone, and a visual mode with no selection
//     is a lie about what the next operator would act on.
//
// An explicit Escape always wins: the adapters clear the memory in `handleEscape`, so the
// swallowed-Escape path (a host key driver eats the keydown, then blurs the field and the
// content script reclaims focus) comes back in NORMAL — which is what the user asked for
// by pressing Escape.

import { Mode } from "../engine/engine.js";

/** The mode this field should come back in when it is focused again, or null. */
export function modeToReturn(engine) {
  if (engine.replaceSession) return null;
  return engine.mode === Mode.INSERT ? Mode.INSERT : null;
}

/**
 * Apply a remembered mode on focus. Returns true when it changed anything.
 *
 * Only NORMAL is upgraded, and never while a prompt owns the field: a `:`/`/` line in
 * flight means the mode is not the interesting state.
 */
export function applyReturnedMode(engine, remembered) {
  if (remembered !== Mode.INSERT) return false;
  if (engine.mode !== Mode.NORMAL || engine.prompt) return false;
  engine.mode = Mode.INSERT;
  // A FRESH insert session, exactly what `startMode: "insert"` creates at attach time:
  // there is no typed run to remember, so insert-mode `C-w` treats the cursor as the wall
  // instead of reaching into text typed before the blur.
  engine.insertEntry = null;
  return true;
}
