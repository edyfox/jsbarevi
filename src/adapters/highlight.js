// Visual-mode highlight.
//
// Relying on the host's native selection was not enough: the OS highlight is
// low-contrast in a dark field, and selecting one character (what `v` does) is
// almost invisible. So VISUAL and VISUAL LINE paint their own overlay, one box
// per selected line segment, measured with a mirror element - the same technique
// the block caret uses, which is what makes it work with soft wrap, tabs and
// proportional fonts.
//
// The native selection is collapsed while this is active, so the two never
// double-paint. Copy still works: Ctrl-C copies the engine's visual range.

import { bindTheme } from "./theme.js";

const STYLE_ID = "jsbarevi-highlight-style";
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
  .jsbarevi-sel{position:fixed;z-index:2147483645;pointer-events:none;
    background:var(--jsbarevi-sel-bg,rgba(96,140,255,.38));
    box-shadow:inset 0 0 0 1px var(--jsbarevi-sel-border,rgba(140,175,255,.55));
    border-radius:1px}
  `;
  document.documentElement.appendChild(s);
}

const MIRROR_PROPS = [
  "boxSizing", "width", "fontStyle", "fontVariant", "fontWeight", "fontStretch",
  "fontSize", "lineHeight", "fontFamily", "letterSpacing", "wordSpacing",
  "textAlign", "textIndent", "textTransform", "tabSize", "whiteSpace",
  "wordBreak", "overflowWrap", "paddingTop", "paddingRight", "paddingBottom",
  "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
  "borderLeftWidth",
];

export class SelectionHighlight {
  constructor(el, opts = {}) {
    ensureStyle();
    this.el = el;
    this.pool = [];
    this.host = document.createElement("div");
    this.host.setAttribute("aria-hidden", "true");
    this.host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483645;";
    document.documentElement.appendChild(this.host);
    // The boxes inherit their colours from the host, which carries the page's palette.
    this.releaseTheme = bindTheme(el, this.host);
    this.mirror = null;
    this._mirrorText = null;
  }

  destroy() {
    try { this.releaseTheme?.(); } catch { /* already gone */ }
    this.host.remove();
    this.mirror?.remove();
  }

  invalidate() {
    this.mirror?.remove();
    this.mirror = null;
    this._mirrorText = null;
  }

  clear() {
    for (const box of this.pool) box.style.display = "none";
  }

  /** Paint [from, to); a collapsed range clears the overlay.
   *  `linewise` stretches each box to the field's right edge, which is how V
   *  looks in a real vi (the line is highlighted, not just its text). */
  update(from, to, text, { linewise = false } = {}) {
    if (from >= to) { this.clear(); return; }
    this.paint(this._rects(from, to, text, linewise));
  }

  /**
   * Paint boxes that were measured somewhere else.
   *
   * A mirror is the right technique for a flat field, where the DOM has no elements
   * to read. A contenteditable has real nodes, so its adapter asks the DOM for the
   * rects (Range.getClientRects) — exact, chip-aware, and no mirror to go stale. The
   * painting was the shared part all along.
   */
  paint(rects) {
    if (!rects.length) { this.clear(); return; }
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      let box = this.pool[i];
      if (!box) {
        box = document.createElement("div");
        box.className = "jsbarevi-sel";
        this.host.appendChild(box);
        this.pool.push(box);
      }
      box.style.display = "block";
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
    }
    for (let i = rects.length; i < this.pool.length; i++) this.pool[i].style.display = "none";
  }

  _rects(from, to, text, linewise = false) {
    const el = this.el;
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const mirror = this._getMirror(cs, text);
    const mr = mirror.getBoundingClientRect();
    const inner = {
      left: box.left + (mr.left - box.left), // mirror shares the field's box origin
      top: mr.top,
    };
    const node = mirror.firstChild;
    if (!node) return [];
    const range = document.createRange();
    range.setStart(node, Math.min(from, text.length));
    range.setEnd(node, Math.min(to, text.length));
    const raw = range.getClientRects();
    const padLeft = parseFloat(cs.paddingLeft || "0");
    const padTop = parseFloat(cs.paddingTop || "0");
    const top0 = box.top + parseFloat(cs.borderTopWidth || "0");
    const bottom0 = box.bottom;
    const left0 = box.left;
    const right0 = box.right;
    const out = [];
    for (const r of raw) {
      const left = box.left + (r.left - mr.left) - el.scrollLeft;
      const top = box.top + (r.top - mr.top) - el.scrollTop;
      const width = r.width;
      const height = r.height || parseFloat(cs.lineHeight) || 16;
      if (width <= 0 || left + width < left0 || left > right0) continue;
      if (top + height < top0 || top > bottom0) continue;
      const widthToEdge = linewise ? Math.max(width, right0 - left - parseFloat(cs.paddingRight || "0")) : width;
      out.push({ left, top, width: widthToEdge, height });
    }
    void inner; void padLeft; void padTop;
    return out;
  }

  _getMirror(cs, text) {
    if (this.mirror && this._mirrorText === text) return this.mirror;
    if (!this.mirror) {
      const mirror = document.createElement("div");
      mirror.setAttribute("aria-hidden", "true");
      mirror.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;top:0;left:-99999px;z-index:-1;";
      for (const prop of MIRROR_PROPS) mirror.style[prop] = cs[prop];
      mirror.style.whiteSpace = "pre-wrap";
      mirror.style.overflowWrap = this.el.tagName === "TEXTAREA" ? "break-word" : "normal";
      mirror.style.width = `${this.el.clientWidth}px`;
      mirror.style.height = "auto";
      document.body.appendChild(mirror);
      this.mirror = mirror;
    }
    this.mirror.textContent = text;
    this._mirrorText = text;
    return this.mirror;
  }
}
