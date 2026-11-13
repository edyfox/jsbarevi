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
  update(offset, { linewise = false, rect = null } = {}) {
    if (!this.enabled) return;
    const r = rect || this.measure(offset);
    if (!r || !this.isVisible(r)) { this.hide(); return; }
    const rect2 = this.clampIntoBox(r);
    this.node.classList.toggle("line", linewise);
    this.node.style.display = "block";
    this.node.style.left = `${rect2.left}px`;
    this.node.style.top = `${rect2.top}px`;
    this.node.style.width = `${Math.max(rect2.width, 2)}px`;
    this.node.style.height = `${rect2.height}px`;
  }

  hide() { this.node.style.display = "none"; }

  /**
   * Is this rect inside the FIELD at all? The border box, not the padding box: a field
   * scrolled to its end leaves the last character a few pixels into the padding, and
   * that is exactly where the browser draws its own caret - clipping our block there
   * would hide the cursor at the end of every long line.
   */
  isVisible(rect) {
    const box = this.el.getBoundingClientRect();
    const tol = 2;
    return rect.left + rect.width > box.left - tol && rect.left < box.right + tol
      && rect.top + rect.height > box.top - tol && rect.top < box.bottom + tol;
  }

  /** Keep the block inside the field's border box when it is only partly visible. */
  clampIntoBox(rect) {
    const box = this.el.getBoundingClientRect();
    const l = box.left;
    const r = box.right;
    const t = box.top;
    const b = box.bottom;
    let left = rect.left;
    let top = rect.top;
    if (left < l) left = l;
    if (left + rect.width > r) left = Math.max(l, r - rect.width);
    if (top < t) top = t;
    if (top + rect.height > b) top = Math.max(t, b - rect.height);
    return { ...rect, left, top };
  }

  /**
   * Where the character at `offset` sits in CONTENT space (the mirror's own
   * coordinates), which is what a screen-line question needs: it is independent of
   * how far the field is scrolled and of whether the character is on screen.
   *
   * `height` is the line box, so two offsets are on the same screen line when
   * their `y` differs by less than half of it - rounding on a fractional line
   * height otherwise splits a row in two.
   */
  /**
   * The rect of the character at `offset`, in content space, read with a Range over
   * ONE text node.
   *
   * The previous technique appended the measured character as a <span> after the text
   * before it, and a span boundary is a line-break opportunity in Chrome: measuring at
   * a wrap point therefore MOVED the wrap, and every position after a soft break came
   * out one cell late ("the cursor can go one past the row's end and `l` lands on the
   * second character of the next row"). A Range reads the layout instead of joining it,
   * and the mirror holds the whole text once instead of being rebuilt per measurement.
   *
   * Content-box relative, not border-box: with padding, a border-box origin puts row 0
   * at y = paddingTop and rounding y/lineHeight calls that row 1, which shifts every
   * screen-row index against viewport().
   */
  _charRect(offset) {
    const el = this.el;
    const text = el.value ?? "";
    const mirror = this._getMirror(true);
    if (!this._textNode || this._textNode.data !== text || this._textNode.parentNode !== mirror) {
      mirror.textContent = "";
      this._textNode = document.createTextNode(text);
      mirror.appendChild(this._textNode);
    }
    const node = this._textNode;
    const range = document.createRange();
    const start = Math.max(0, Math.min(offset, text.length));   // a -1 must not reach setStart
    range.setStart(node, start);
    range.setEnd(node, Math.min(start + 1, text.length));
    let rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && offset >= text.length) {
      // past the last character: use the collapsed caret position instead
      range.setStart(node, text.length);
      range.setEnd(node, text.length);
      rect = range.getBoundingClientRect();
    }
    const mr = mirror.getBoundingClientRect();
    const mcs = getComputedStyle(mirror);
    const height = rect.height || parseFloat(mcs.lineHeight) || 16;
    return {
      x: rect.left - mr.left - (parseFloat(mcs.paddingLeft) || 0),
      y: rect.top - mr.top - (parseFloat(mcs.paddingTop) || 0),
      width: rect.width,
      height,
    };
  }

  /**
   * Where the character at `offset` is drawn, in content space. A SPACE at a soft
   * wrap is special: the field hangs it at the end of the row (it has no cell of its
   * own), so where the browser reports the space itself is not where you see it, and
   * the row's last character looks advanceable.
   */
  contentPoint(offset) {
    const text = this.el.value ?? "";
    if (offset < 0) offset = 0;
    const own = this._charRect(offset);
    if (text[offset] !== " " || offset === 0) return own;
    const prev = this._charRect(offset - 1);
    const h = own.height || prev.height || 16;
    if (Math.abs(own.y - prev.y) < h / 2) return own; // an ordinary space, same row
    // it wrapped: the space hangs at the end of the previous row, where it is drawn
    return { x: prev.x + prev.width, y: prev.y, width: 0, height: prev.height };
  }

  /** Position and size of the character at `offset`, in client coordinates. */
  measure(offset) {
    const el = this.el;
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return null;

    const cp = this.contentPoint(offset);
    const cs = getComputedStyle(el);
    const height = cp.height || parseFloat(cs.lineHeight) || 16;
    // a hanging space has no width of its own; the block still needs a cell to draw in
    const width = cp.width > 0.5 ? cp.width : Math.max(2, height * 0.6);
    const innerLeft = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
    const innerTop = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
    // RAW position, possibly outside the field: the caller scrolls the field to bring
    // the cursor back (vim never lets the cursor leave the window) and hides the block
    // only when that is impossible, e.g. a field with overflow:hidden.
    const left = box.left + innerLeft + cp.x - el.scrollLeft;
    const top = box.top + innerTop + cp.y - el.scrollTop;
    return { left, top, width, height };
  }

  /**
   * Give the mirror the field's text layout rules. Every text-affecting property is
   * copied, because overriding one says "lay out like I think you lay out" - the field
   * breaks between words, inside a long word, or not at all, according to its own
   * computed style, and a mirror that differs wraps at a different character, so its
   * rows are simply not the rows on screen.
   *
   * The exception is an <input>: it renders its value LITERALLY (one line, spaces
   * preserved, never wrapped) while its computed white-space says "normal" - a CSS
   * inheritance artefact. Copying that makes the mirror collapse runs of spaces and
   * wrap long values, which draws the block on a line the field does not have.
   */
  _styleMirror(mirror, el, cs) {
    for (const prop of MIRROR_PROPS) mirror.style[prop] = cs[prop];
    if (el.tagName === "INPUT") {
      mirror.style.whiteSpace = "pre";
      mirror.style.overflowWrap = "normal";
      mirror.style.wordBreak = "normal";
    }
    mirror.style.width = `${this._contentWidth(el, cs)}px`;
    mirror.style.height = "auto";
  }

  /**
   * A cached mirror whose WIDTH is re-read on every use: the field can be
   * resized by its container without a window resize event, and a mirror whose
   * width is stale wraps at the wrong column, which is exactly how the block
   * caret ended up sitting at the right edge of a wrapped row.
   */
  /**
   * The width the mirror must be given: the field's CONTENT box. clientWidth
   * includes the padding and the mirror inherits the field's box-sizing, so using
   * clientWidth directly makes every row wider than the field's - which moves the
   * wrap points, and with them every screen-line answer (gj/gk/g0/g$/H/M/L).
   */
  _contentWidth(el, cs) {
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    return Math.max(1, el.clientWidth - pl - pr);
  }

  _getMirror() {
    const el = this.el;
    const cs = getComputedStyle(el);
    if (this.mirror) {
      // Re-copy on every use: a field's white-space, font or size can change after
      // attach (a theme class, a container resize, a <textarea> switched to nowrap),
      // and a mirror holding the OLD rules measures a layout that is not on screen.
      this._styleMirror(this.mirror, el, cs);
      return this.mirror;
    }
    const mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    mirror.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;top:0;left:-99999px;z-index:-1;";
    this._styleMirror(mirror, el, cs);
    document.body.appendChild(mirror);
    this.mirror = mirror;
    return mirror;
  }

  /** Call after a resize or a font change. */
  invalidate() {
    this.mirror?.remove();
    this.mirror = null;
    this._textNode = null;   // it belonged to the removed mirror
  }
}
