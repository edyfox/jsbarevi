#!/usr/bin/env python3
"""Render the Chrome Web Store promo tile (440x280, optional asset).

Kept separate from make-icons.py because it is a different artefact with a
different reason to change: the icon is the product mark, the tile is the listing
graphic, and the store lets you update the tile without shipping a release.

    python3 tools/make-promo.py       # writes store/promo-440x280.png
"""
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON = ROOT / "extension" / "icons" / "icon-128.png"
OUT = ROOT / "store" / "promo-440x280.png"

W, H = 440, 280
BG = (20, 22, 26)
ACCENT = (166, 226, 46)
TEXT = (231, 233, 236)
DIM = (139, 147, 160)

MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def main() -> int:
    if not ICON.exists():
        print("run tools/make-icons.py first", file=sys.stderr)
        return 1

    img = Image.new("RGB", (W, H), BG)
    # A vertical gradient instead of a flat fill; no rings, no fake 3D.
    grad = Image.new("RGB", (1, H))
    for y in range(H):
        t = y / (H - 1)
        grad.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip((28, 31, 37), (16, 18, 22))))
    img = grad.resize((W, H))
    d = ImageDraw.Draw(img)

    icon = Image.open(ICON).convert("RGBA").resize((96, 96), Image.LANCZOS)
    img.paste(icon, (34, 92), icon)

    word = ImageFont.truetype(MONO, 40)
    tag = ImageFont.truetype(SANS, 17)
    hint = ImageFont.truetype(MONO, 13)

    d.text((150, 92), "jsbarevi", font=word, fill=TEXT)
    d.text((152, 146), "vi keys in any text field", font=tag, fill=DIM)
    d.text((152, 176), "NORMAL · VISUAL · INSERT · :e", font=hint, fill=ACCENT)

    d.rectangle([0, H - 4, W, H], fill=ACCENT)
    img.save(OUT)
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
