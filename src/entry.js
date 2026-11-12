// Entry point: attach the engine to fields and provide the minimal UI
// (mode badge, one-line status, prompt line). No framework, no build step.

import { TextareaAdapter } from "./adapters/textarea.js";

const OVERLAY_CSS = `
.jsbarevi-badge{position:fixed;z-index:2147483647;pointer-events:none;
  font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
  padding:1px 5px;border-radius:3px;background:#111;color:#a6e22e;opacity:.92}
.jsbarevi-line{position:fixed;z-index:2147483647;font:500 12px/1.5 ui-monospace,monospace;
  background:#111;color:#ddd;padding:2px 8px;border-radius:3px;max-width:60vw;
  white-space:pre;overflow:hidden;text-overflow:ellipsis;display:none}
.jsbarevi-line.error{color:#ff6188}
.jsbarevi-prompt{position:fixed;z-index:2147483647;font:500 12px/1.5 ui-monospace,monospace;
  background:#111;color:#fd971f;border:0;outline:0;padding:2px 8px;border-radius:3px}
`;

function ensureStyles() {
  if (document.getElementById("jsbarevi-style")) return;
  const style = document.createElement("style");
  style.id = "jsbarevi-style";
  style.textContent = OVERLAY_CSS;
  document.documentElement.appendChild(style);
}

function makeUi(el) {
  ensureStyles();
  const badge = document.createElement("div");
  badge.className = "jsbarevi-badge";
  const line = document.createElement("div");
  line.className = "jsbarevi-line";
  const prompt = document.createElement("input");
  prompt.className = "jsbarevi-prompt";
  prompt.style.display = "none";
  document.body.append(badge, line, prompt);

  const place = () => {
    const r = el.getBoundingClientRect();
    badge.style.left = `${Math.max(4, r.left + 4)}px`;
    badge.style.top = `${Math.max(4, r.top - 18)}px`;
    line.style.left = `${Math.max(4, r.left + 4)}px`;
    line.style.top = `${Math.max(4, r.bottom + 4)}px`;
    prompt.style.left = `${Math.max(4, r.left + 4)}px`;
    prompt.style.top = `${Math.max(4, r.bottom + 4)}px`;
  };

  let statusTimer = 0;
  return {
    place,
    setMode(mode, count) {
      place();
      const label = mode === "INSERT" ? "-- INSERT --" : mode === "VISUAL" ? "-- VISUAL --" : mode === "VISUAL_LINE" ? "-- VISUAL LINE --" : "";
      badge.textContent = label;
      badge.style.display = label ? "block" : "none";
      if (count) badge.textContent = `${label} ${count}`;
    },
    status(msg, kind) {
      place();
      clearTimeout(statusTimer);
      if (!msg) { line.style.display = "none"; return; }
      line.textContent = msg;
      line.className = "jsbarevi-line" + (kind === "error" ? " error" : "");
      line.style.display = "block";
      statusTimer = setTimeout(() => { line.style.display = "none"; }, 4000);
    },
    prompt(kind, initial) {
      place();
      prompt.style.display = "block";
      // The sigil lives in the input, as it does in vi: ":" for ex, "/" or "?"
      // for search. That is what makes "delete the sigil to leave" expressible.
      prompt.value = initial || (kind === "ex" ? ":" : "/");
      prompt.dataset.sigil = prompt.value[0];
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      return prompt;
    },
    hidePrompt() { prompt.style.display = "none"; el.focus(); },
    promptEl: prompt,
  };
}

/** Attach to one field. Returns a handle with destroy(). */
export const BUILD = "0.1.0+" + (typeof __JSBAREVI_BUILD__ === "string" ? __JSBAREVI_BUILD__ : "dev");

export function attach(el, opts = {}) {
  const ui = makeUi(el);
  // A stale page is invisible otherwise: say which build is running.
  if (typeof console !== "undefined") console.info(`[jsbarevi] ${BUILD} attached to`, el.tagName.toLowerCase());
  const adapter = new TextareaAdapter(el, {
    ...opts,
    onStatus: (msg, kind) => ui.status(msg, kind),
    onModeChange: (mode, count) => ui.setMode(mode, count),
    onPrompt: (kind, initial) => {
      const input = ui.prompt(kind, initial);
      input.dataset.kind = kind;
    },
  });

  const promptOpen = () => ui.promptEl.style.display !== "none";
  const cancelPrompt = () => { ui.hidePrompt(); adapter.cancelPrompt(); };

  const onPromptKey = (e) => {
    if (!promptOpen()) return;
    const kind = ui.promptEl.dataset.kind;
    if (e.key === "Enter") {
      e.preventDefault();
      const value = ui.promptEl.value.replace(/^[:/?]/, "");
      ui.hidePrompt();
      adapter.finishPrompt(kind, value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelPrompt();
    } else if (e.ctrlKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      cancelPrompt();
    }
    e.stopPropagation();
  };

  // Measured against vim, nvi and busybox vi: deleting the typed text but leaving
  // the sigil keeps you in the command line — only deleting the ":" itself (or the
  // "/") leaves it. So the test is "is the sigil still there", not "is anything
  // left after it".
  const onPromptInput = () => {
    if (!promptOpen()) return;
    const sigil = ui.promptEl.dataset.sigil || ":";
    if (ui.promptEl.value[0] !== sigil) cancelPrompt();
  };
  ui.promptEl.addEventListener("keydown", onPromptKey, true);
  ui.promptEl.addEventListener("input", onPromptInput);

  const onResize = () => ui.place();
  window.addEventListener("resize", onResize);
  window.addEventListener("scroll", onResize, true);

  return {
    adapter,
    engine: adapter.engine,
    destroy() {
      adapter.destroy();
      ui.promptEl.removeEventListener("keydown", onPromptKey, true);
      ui.promptEl.removeEventListener("input", onPromptInput);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
      ui.promptEl.remove();
    },
  };
}

export { Engine } from "./engine/engine.js";
export { TextareaAdapter } from "./adapters/textarea.js";
