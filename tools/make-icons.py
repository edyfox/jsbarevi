#!/usr/bin/env python3
"""Render the extension icons.

The mark is the product: a vi block caret sitting on a line of text. One green
block, two grey lines — legible at 16 px, which is the only size that matters in a
toolbar, and it stays a square where a letter would be mush.

    python3 tools/make-icons.py            # writes extension/icons/*.png

Written at 512 px and downsampled with LANCZOS so the 16 px version is a real
rasterisation rather than a different drawing.
"""
import pathlib
import sys

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "icons"

BG = (20, 22, 26, 255)          # --bg
EDGE = (58, 64, 72, 255)        # a hairline so the icon reads on a dark toolbar
TEXT = (139, 147, 160, 255)     # --dim, used as "text"
CARET = (166, 226, 46, 255)     # --accent
S = 512


def draw_mark() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.19), fill=BG, outline=EDGE, width=max(2, S // 128))

    # Two elements only: vim's block caret, and the line it sits on. At 16 px a third
    # element turns to mush, so the mark spends its pixels on contrast instead.
    cell_w = int(S * 0.20)
    cell_h = int(S * 0.40)
    cell_x = (S - cell_w) // 2 - int(S * 0.10)
    cell_y = int(S * 0.17)
    d.rounded_rectangle([cell_x, cell_y, cell_x + cell_w, cell_y + cell_h],
                        radius=int(S * 0.035), fill=CARET)

    line_y = cell_y + cell_h + int(S * 0.10)
    line_h = int(S * 0.075)
    d.rounded_rectangle([int(S * 0.20), line_y, int(S * 0.80), line_y + line_h],
                        radius=line_h // 2, fill=TEXT)
    return img


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    base = draw_mark()
    for size in (16, 32, 48, 128):
        path = OUT / f"icon-{size}.png"
        base.resize((size, size), Image.LANCZOS).save(path)
        print(f"wrote {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
