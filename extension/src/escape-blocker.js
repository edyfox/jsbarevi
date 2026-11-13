// Escape must not leave the field.
//
// PORTED FROM INPUT VIM (MIT) — `content/page-escape-blocker.js`. The problem it
// solves cannot be solved from a keydown handler: a site's Escape handler is free to
// call `el.blur()`, and `preventDefault()` only cancels the browser's default action,
// not a function call made by page code. A chat composer that treats Escape as "leave
// the composer" therefore wins against every key-level guard.
//
// So the prototype is patched in the PAGE'S OWN WORLD, where the site's calls land. A
// content script's isolated world has its own `HTMLElement.prototype`, so patching it
// there changes nothing for the page — which is why this file is declared with
// `world: "MAIN"` and runs at `document_start`, before the app can capture a
// reference to the native method.
//
// The marker is the extension's own contract with this file: `data-jsbarevi-mode` is
// set on the element the engine owns, for as long as it owns it. No marker, native
// behaviour — a page that the user turned us off for keeps its Escape.
(function () {
  if (typeof HTMLElement === "undefined") return;
  const proto = HTMLElement.prototype;
  if (proto.blur.__jsbareviBlocked) return;

  const nativeBlur = proto.blur;
  const blocked = function () {
    // While the engine owns this element, focus is released only by the extension
    // itself (:q / :q!), which calls the native method from its own world.
    if (this.getAttribute && this.getAttribute("data-jsbarevi-mode") !== null) return;
    return nativeBlur.apply(this, arguments);
  };
  blocked.__jsbareviBlocked = true;
  proto.blur = blocked;
})();
