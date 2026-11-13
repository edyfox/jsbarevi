// Block caret for normal/visual mode.
//
// A browser field shows a hairline insertion caret, which is invisible as a vi
// cursor and useless for judging `dw` vs `d2w`. So in NORMAL and VISUAL we draw
// a block over the character under the engine cursor and hide the native caret
// (`caret-color: transparent`); in INSERT the native caret comes back and the
// block disappears.
//
// Measurement is a mirror element: a hidden copy of the field with the same
// typography, containing the text up to the offset plus a zero-width probe.
// That handles soft wrap, tabs and proportional fonts, which arithmetic on
// line-height does not.

const MIRROR_PROPS = [
  "boxSizing", "width", "fontStyle", "fontVariant", "fontWeight", "fontStretch",
  "fontSize", "lineHeight", "fontFamily", "letterSpacing", "wordSpacing",
  "textAlign", "textIndent", "textTransform", "tabSize", "whiteSpace",
  "wordBreak", "overflowWrap", "paddingTop", "paddingRight", "paddingBottom",
  "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
  "borderLeftWidth",
];

const STYLE_ID = "jsbarevi-caret-style";
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
  .jsbarevi-caret{position:fixed;z-index:2147483646;pointer-events:none;
    background:rgba(166,226,46,.35);border:1px solid rgba(166,226,46,.85);
    border-radius:1px;mix-blend-mode:normal}
  .jsbarevi-caret.line{border-left-width:2px;border-right-width:2px}
  .jsbarevi-caret.blink{animation:jsbarevi-blink 1.1s steps(1,end) infinite}
  @keyframes jsbarevi-blink{0%,60%{opacity:1}61%,100%{opacity:.25}}
  `;
  document.documentElement.appendChild(s);
}

export class BlockCaret {
  constructor(el, opts = {}) {
    ensureStyle();
    this.el = el;
    this.enabled = opts.enabled !== false;
    this.node = document.createElement("div");
    this.node.className = "jsbarevi-caret blink";
    this.node.style.display = "none";
    document.documentElement.appendChild(this.node);
    this.mirror = null;
    this._lastText = null;
  }

  destroy() {
    this.node.remove();
    this.mirror?.remove();
  }

  /** Show the block at `offset`. `linewise` widens it for VISUAL LINE. */
  update(offset, { linewise = false } = {}) {
    if (!this.enabled) return;
    const rect = this.measure(offset);
    if (!rect) { this.hide(); return; }
    this.node.classList.toggle("line", linewise);
    this.node.style.display = "block";
    this.node.style.left = `${rect.left}px`;
    this.node.style.top = `${rect.top}px`;
    this.node.style.width = `${Math.max(rect.width, 2)}px`;
    this.node.style.height = `${rect.height}px`;
  }

  hide() { this.node.style.display = "none"; }

  /**
   * Where the character at `offset` sits in CONTENT space (the mirror's own
   * coordinates), which is what a screen-line question needs: it is independent of
   * how far the field is scrolled and of whether the character is on screen.
   *
   * `height` is the line box, so two offsets are on the same screen line when
   * their `y` differs by less than half of it - rounding on a fractional line
   * height otherwise splits a row in two.
   */
  contentPoint(offset) {
    const el = this.el;
    const text = el.value ?? "";
    const mirror = this._getMirror();
    mirror.textContent = "";
    mirror.appendChild(document.createTextNode(text.slice(0, offset)));
    const probe = document.createElement("span");
    probe.textContent = text.slice(offset, offset + 1) || "\u200b";
    mirror.appendChild(probe);
    const pr = probe.getBoundingClientRect();
    const mr = mirror.getBoundingClientRect();
    const height = pr.height || parseFloat(getComputedStyle(el).lineHeight) || 16;
    return { x: pr.left - mr.left, y: pr.top - mr.top, width: pr.width, height };
  }

  /** Position and size of the character at `offset`, in client coordinates. */
  measure(offset) {
    const el = this.el;
    const text = el.value ?? "";
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return null;

    const mirror = this._getMirror();
    mirror.textContent = "";
    mirror.appendChild(document.createTextNode(text.slice(0, offset)));
    const probe = document.createElement("span");
    probe.textContent = text.slice(offset, offset + 1) || "\u200b";
    mirror.appendChild(probe);

    const pr = probe.getBoundingClientRect();
    const mr = mirror.getBoundingClientRect();
    const left = box.left + (pr.left - mr.left) - el.scrollLeft;
    let top = box.top + (pr.top - mr.top) - el.scrollTop;
    const height = pr.height || parseFloat(getComputedStyle(el).lineHeight) || 16;

    // Keep the block inside the field's box.
    const visibleTop = box.top + parseFloat(getComputedStyle(el).borderTopWidth || "0");
    const visibleBottom = box.bottom;
    if (top + height < visibleTop || top > visibleBottom) {
      this.hide();
      return null;
    }
    if (top < visibleTop) top = visibleTop;
    return { left, top, width: pr.width || (height * 0.6), height };
  }

  /**
   * A cached mirror whose WIDTH is re-read on every use: the field can be
   * resized by its container without a window resize event, and a mirror whose
   * width is stale wraps at the wrong column, which is exactly how the block
   * caret ended up sitting at the right edge of a wrapped row.
   */
  _getMirror() {
    if (this.mirror) {
      const w = `${this.el.clientWidth}px`;
      if (this.mirror.style.width !== w) this.mirror.style.width = w;
      return this.mirror;
    }
    const el = this.el;
    const cs = getComputedStyle(el);
    const mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    mirror.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;top:0;left:-99999px;z-index:-1;";
    for (const prop of MIRROR_PROPS) mirror.style[prop] = cs[prop];
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.overflowWrap = el.tagName === "TEXTAREA" ? "break-word" : "normal";
    mirror.style.width = `${el.clientWidth}px`;
    mirror.style.height = "auto";
    document.body.appendChild(mirror);
    this.mirror = mirror;
    return mirror;
  }

  /** Call after a resize or a font change. */
  invalidate() {
    this.mirror?.remove();
    this.mirror = null;
  }
}
