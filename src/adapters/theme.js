// The overlay's palette, chosen from the page it is drawn on.
//
// Everything vi adds to a page is painted ON TOP of that page: the mode badge, the
// status line, the command line, the block caret and the visual selection. Tuned for a
// dark editor (which is where the first hosts lived), the light-green caret and the
// pale blue selection are nearly invisible on a white document — and a page's colours
// are not ours to change. So the palette adapts instead: one set of CSS custom
// properties, two values, picked from the background actually behind the field.
//
// Three rules keep this honest:
//
//   * **The field decides, not the OS.** A dark <textarea> on a white page (a code
//     editor in a light app, and Lark's chat in light mode) looks like the field it is,
//     so detection starts at the element and walks up to the first ancestor that paints
//     a background. `prefers-color-scheme` is only the tie-break when nothing paints.
//   * **The switch point is contrast, not taste.** Text goes dark when dark text has the
//     better contrast ratio against that background, which puts the boundary at relative
//     luminance 0.179 rather than an eyeballed 0.5 (0.5 calls mid-gray "dark" and then
//     puts white text on it).
//   * **Dark is the default everywhere**, so a page we cannot measure (a background
//     image, a transparent field over a canvas) keeps exactly today's appearance.

/** Relative luminance of an sRGB triple, per WCAG 2.x. */
export function luminance({ r, g, b }) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The luminance at which dark text becomes the better choice: where contrast against
 * white equals contrast against black, `(L + 0.05) / 0.05 == 1.05 / (L + 0.05)`.
 */
export const LIGHT_SWITCH = Math.sqrt(1.05 * 0.05) - 0.05;

let ctx = null;
/**
 * Parse any CSS colour to RGB.
 *
 * Through a canvas: `getComputedStyle` returns `rgb()`/`rgba()` for most properties but
 * not all (and `color(srgb …)`/`oklch()` are real in current browsers), while assigning
 * to a 2D context's `fillStyle` normalises every syntax the engine understands. The
 * regex fallback is for a document with no canvas.
 */
export function parseColor(value) {
  if (!value) return null;
  if (ctx === null) {
    try { ctx = document.createElement("canvas").getContext("2d"); } catch { ctx = false; }
  }
  if (ctx) {
    try {
      ctx.fillStyle = "#000";
      ctx.fillStyle = value;                     // invalid colours leave the old value
      const normal = ctx.fillStyle;
      const m = /^#([0-9a-f]{6})$/i.exec(normal);
      if (m) {
        const n = parseInt(m[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
      }
      const rgba = /^rgba?\(([^)]+)\)$/i.exec(normal);
      if (rgba) return fromParts(rgba[1]);
    } catch { /* fall through */ }
  }
  return fromAny(value);
}

/** Hex and functional colour syntaxes, for a context with no canvas (SSR, tests). */
export function fromAny(value) {
  const s = String(value || "").trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  return fn ? fromParts(fn[1]) : null;
}

function fromParts(parts) {
  const p = String(parts).split(/[\s,/]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.some((n, i) => i < 3 && !Number.isFinite(n))) return null;
  return { r: p[0], g: p[1], b: p[2], a: Number.isFinite(p[3]) ? p[3] : 1 };
}

/** "light" when dark text reads better on this colour, "dark" when light text does.
 *  A colour that is not a surface (transparent, unparsable) answers null: the caller
 *  has to keep walking up, not guess. */
export function themeFromColor(value) {
  const c = parseColor(value);
  if (!c || c.a <= 0.5) return null;
  return luminance(c) > LIGHT_SWITCH ? "light" : "dark";
}

/** The theme an explicit `data-jsbarevi-theme` asks for, if any. */
function explicitTheme(el) {
  const holder = el?.closest?.("[data-jsbarevi-theme]");
  const asked = holder?.getAttribute("data-jsbarevi-theme");
  if (asked === "light" || asked === "dark") return asked;
  return null;
}

/**
 * Which palette this field needs.
 *
 * `null` from a transparent ancestor means "keep walking"; a background IMAGE stops the
 * walk, because its colour is unknowable — the safe answer there is the default, not a
 * guess that could invert a light HUD onto a dark photo.
 */
export function pageTheme(el) {
  const forced = explicitTheme(el);
  if (forced) return forced;
  let node = el;
  while (node && node.nodeType === 1) {
    const cs = getComputedStyle(node);
    if (cs.backgroundImage && cs.backgroundImage !== "none") return "dark";
    const t = themeFromColor(cs.backgroundColor);
    if (t) return t;
    node = node.parentElement;
  }
  try {
    if (matchMedia("(prefers-color-scheme: light)").matches) return "light";
  } catch { /* no matchMedia */ }
  return "dark";
}

/**
 * The two palettes.
 *
 * Dark is the original: #111 chip, the Monokai-ish green, the pale blue selection.
 * Light keeps the same hues but takes them far enough down to hold on white — a light
 * green at 35 % alpha is a caret you cannot find, and the chip needs a ring and a
 * shadow because a white chip on a white page has no edge of its own.
 */
export const THEMES = {
  dark: {
    "--jsbarevi-ui-bg": "#111",
    "--jsbarevi-ui-fg": "#ddd",
    "--jsbarevi-ui-accent": "#a6e22e",
    "--jsbarevi-ui-error": "#ff6188",
    "--jsbarevi-ui-prompt": "#fd971f",
    "--jsbarevi-ui-ring": "transparent",
    "--jsbarevi-ui-shadow": "transparent",
    "--jsbarevi-caret-bg": "rgba(166,226,46,.35)",
    "--jsbarevi-caret-border": "rgba(166,226,46,.85)",
    "--jsbarevi-sel-bg": "rgba(96,140,255,.38)",
    "--jsbarevi-sel-border": "rgba(140,175,255,.55)",
  },
  light: {
    "--jsbarevi-ui-bg": "#ffffff",
    "--jsbarevi-ui-fg": "#333333",
    "--jsbarevi-ui-accent": "#2f6f00",
    "--jsbarevi-ui-error": "#b3272d",
    "--jsbarevi-ui-prompt": "#8a4700",
    // A white chip on a white page has no edge: a hairline ring plus a soft drop
    // shadow is what makes it read as floating rather than as part of the document.
    "--jsbarevi-ui-ring": "rgba(0,0,0,.16)",
    "--jsbarevi-ui-shadow": "rgba(0,0,0,.22)",
    "--jsbarevi-caret-bg": "rgba(47,111,0,.28)",
    "--jsbarevi-caret-border": "rgba(47,111,0,.95)",
    "--jsbarevi-sel-bg": "rgba(41,98,201,.22)",
    "--jsbarevi-sel-border": "rgba(41,98,201,.65)",
  },
};

export const vars = (theme) => THEMES[theme] || THEMES.dark;

// ---------------------------------------------------------------------------
// binding: one registry of (field -> overlay nodes) repainted on a theme change
// ---------------------------------------------------------------------------

/** field element -> { nodes: Set<HTMLElement>, dispose } */
const bound = new Map();
let observer = null;
let media = null;

function paint(entry, field) {
  const set = vars(pageTheme(field));
  for (const node of entry.nodes) {
    for (const [name, value] of Object.entries(set)) node.style.setProperty(name, value);
  }
}

/** Re-measure and repaint every bound overlay. Cheap: one style read per field. */
export function refreshTheme() {
  for (const [field, entry] of bound) {
    if (!field.isConnected) { entry.dispose(); continue; }
    paint(entry, field);
  }
}

function ensureWatchers() {
  if (observer) return;
  // Only the two elements a page normally re-themes. Observing the whole document with
  // an attribute filter would fire on every class change an SPA makes (hundreds a
  // second in Lark), and each fire costs a computed-style read per bound field.
  const watch = (node) => node && observer.observe(node, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-color-mode", "data-color-scheme"],
  });
  observer = new MutationObserver(() => refreshTheme());
  watch(document.documentElement);
  watch(document.body);
  try {
    media = matchMedia("(prefers-color-scheme: light)");
    media.addEventListener("change", refreshTheme);
  } catch { media = null; }
}

/**
 * Keep `node` (one of our overlays) painted for `field`'s page, now and on every theme
 * change. Returns a disposer; call it from destroy() or the registry leaks fields.
 */
export function bindTheme(field, node) {
  ensureWatchers();
  let entry = bound.get(field);
  if (!entry) {
    // A page can change its theme while the field is unfocused (a manual switch, an OS
    // change that the app applies on the next focus), and focus is when the user finds
    // out. Re-measuring there costs one style read per focus.
    const onFocus = () => refreshTheme();
    field.addEventListener("focus", onFocus);
    entry = {
      nodes: new Set(),
      dispose() {
        field.removeEventListener("focus", onFocus);
        bound.delete(field);
      },
    };
    bound.set(field, entry);
  }
  entry.nodes.add(node);
  paint(entry, field);
  return () => {
    entry.nodes.delete(node);
    if (!entry.nodes.size) entry.dispose();
  };
}

/** The palette in force for a field — for diagnostics and tests. */
export function currentTheme(field) {
  return pageTheme(field);
}
