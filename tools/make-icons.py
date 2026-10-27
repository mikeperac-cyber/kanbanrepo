#!/usr/bin/env python3
"""
Generate all icon assets for Kanban Repo Cards.

Outputs:
  build/icon.png                   1024x1024 master icon (electron-builder source)
  build/icon.ico                   multi-size Windows icon (16..256)
  build/appx/Square44x44Logo.png   Microsoft Store tile assets
  build/appx/Square71x71Logo.png
  build/appx/Square150x150Logo.png
  build/appx/Square310x310Logo.png
  build/appx/Wide310x150Logo.png
  build/appx/StoreLogo.png
  assets/icon-64.png               in-app brand mark
"""

from __future__ import annotations

import os
import struct
from PIL import Image, ImageDraw, ImageFilter, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
APPX = os.path.join(BUILD, "appx")
ASSETS = os.path.join(ROOT, "assets")

C1 = (67, 56, 202)     # indigo-700
C2 = (14, 165, 233)    # sky-500
ACCENTS = [
    (99, 102, 241),    # indigo-500
    (139, 92, 246),    # violet-500
    (14, 165, 233),    # sky-500
    (20, 184, 166),    # teal-500
]


def diagonal_gradient(size: int, c1=C1, c2=C2) -> Image.Image:
    """Smooth 45-degree gradient from c1 (bottom-left) to c2 (top-right)."""
    big = Image.linear_gradient("L").resize((size * 2, size * 2), Image.Resampling.BICUBIC)
    big = big.rotate(45, resample=Image.Resampling.BICUBIC, expand=False)
    off = (size * 2 - size) // 2
    gray = big.crop((off, off, off + size, off + size))
    return ImageOps.colorize(gray, black=c1, white=c2).convert("RGBA")


def rounded_background(size: int) -> Image.Image:
    bg = diagonal_gradient(size)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * 0.225), fill=255
    )
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)
    return out


def draw_board(img: Image.Image, box: tuple[float, float, float, float]) -> None:
    """Draw the kanban board glyph into the given bounding box."""
    x0, y0, x1, y1 = [float(v) for v in box]
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return

    # Soft drop shadow under the board
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [x0 + 0.015 * w, y0 + 0.035 * h, x1 + 0.015 * w, y1 + 0.05 * h],
        radius=0.10 * min(w, h),
        fill=(2, 6, 23, 120),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(1, 0.05 * min(w, h))))
    img.alpha_composite(shadow)

    d = ImageDraw.Draw(img)
    radius = 0.10 * min(w, h)
    d.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=(255, 255, 255, 255))

    pad = 0.062 * w
    gap = 0.030 * w
    col_w = (w - 2 * pad - 3 * gap) / 4.0
    top = y0 + 0.075 * h
    bottom = y1 - 0.075 * h
    header_h = 0.042 * h
    header_y = top + 0.024 * h
    card_top = header_y + header_h + 0.030 * h
    card_h = 0.100 * h
    card_gap = 0.026 * h
    counts = [3, 2, 3, 2]

    for i in range(4):
        cx0 = x0 + pad + i * (col_w + gap)
        cx1 = cx0 + col_w

        d.rounded_rectangle(
            [cx0, top, cx1, bottom],
            radius=0.030 * w,
            fill=(238, 242, 255, 255),
        )
        d.rounded_rectangle(
            [cx0 + 0.010 * w, header_y, cx1 - 0.010 * w, header_y + header_h],
            radius=0.016 * w,
            fill=ACCENTS[i] + (255,),
        )

        for j in range(counts[i]):
            cy0 = card_top + j * (card_h + card_gap)
            cy1 = cy0 + card_h
            if cy1 > bottom - 0.018 * h:
                break
            d.rounded_rectangle(
                [cx0 + 0.010 * w, cy0, cx1 - 0.010 * w, cy1],
                radius=0.014 * w,
                fill=(255, 255, 255, 255),
                outline=(226, 232, 240, 255),
                width=max(1, int(0.0035 * w)),
            )
            line_x = cx0 + 0.022 * w
            line_h = 0.011 * h
            d.rounded_rectangle(
                [line_x, cy0 + 0.024 * h, line_x + 0.52 * col_w, cy0 + 0.024 * h + line_h],
                radius=line_h / 2,
                fill=(203, 213, 225, 255),
            )
            d.rounded_rectangle(
                [line_x, cy0 + 0.052 * h, line_x + 0.34 * col_w, cy0 + 0.052 * h + line_h],
                radius=line_h / 2,
                fill=(226, 232, 240, 255),
            )


def draw_simple_mark(size: int) -> Image.Image:
    """Simplified mark that stays legible at 16-32 px."""
    img = rounded_background(size)
    d = ImageDraw.Draw(img)
    bar_w = size * 0.115
    gap = size * 0.075
    total = 4 * bar_w + 3 * gap
    left = (size - total) / 2
    base_y = size * 0.775
    heights = [0.46, 0.32, 0.53, 0.39]
    for i, hh in enumerate(heights):
        x = left + i * (bar_w + gap)
        top_y = base_y - size * hh
        d.rounded_rectangle(
            [x, top_y, x + bar_w, base_y],
            radius=bar_w * 0.42,
            fill=(255, 255, 255, 240),
        )
    return img


def render_icon(size: int) -> Image.Image:
    if size <= 32:
        return draw_simple_mark(size)
    img = rounded_background(size)
    margin_x = 0.15 * size
    margin_y = 0.205 * size
    draw_board(img, (margin_x, margin_y, size - margin_x, size - margin_y))
    return img


def render_tile(w: int, h: int, *, rounded: bool = False) -> Image.Image:
    if rounded:
        img = rounded_background(min(w, h)).resize((w, h), Image.Resampling.LANCZOS)
    else:
        img = diagonal_gradient(max(w, h)).resize((w, h), Image.Resampling.LANCZOS)
    if w >= h:
        box_w = min(h * 1.55, w * 0.8)
        box_h = min(h * 0.76, w * 0.6)
        bx = (w - box_w) / 2
        by = (h - box_h) / 2
    else:
        box_w = w * 0.7
        box_h = h * 0.58
        bx = (w - box_w) / 2
        by = (h - box_h) / 2
    draw_board(img, (bx, by, bx + box_w, by + box_h))
    return img


def save_ico(frames: list[Image.Image], path: str) -> None:
    """Write a PNG-compressed multi-resolution .ico (Vista+)."""
    blobs = []
    for frame in frames:
        import io

        buf = io.BytesIO()
        frame.save(buf, format="PNG", optimize=True)
        blobs.append(buf.getvalue())

    header = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries = b""
    for frame, blob in zip(frames, blobs):
        w, h = frame.size
        entries += struct.pack(
            "<BBBBHHII",
            0 if w >= 256 else w,
            0 if h >= 256 else h,
            0,
            0,
            1,
            32,
            len(blob),
            offset,
        )
        offset += len(blob)

    with open(path, "wb") as fh:
        fh.write(header)
        fh.write(entries)
        for blob in blobs:
            fh.write(blob)


def main() -> None:
    for path in (BUILD, APPX, ASSETS):
        os.makedirs(path, exist_ok=True)

    master = render_icon(1024)
    master.save(os.path.join(BUILD, "icon.png"), format="PNG", optimize=True)

    sizes = [16, 24, 32, 48, 64, 128, 256]
    save_ico([render_icon(s) for s in sizes], os.path.join(BUILD, "icon.ico"))

    render_icon(64).save(os.path.join(ASSETS, "icon-64.png"), format="PNG", optimize=True)
    render_icon(128).save(os.path.join(ASSETS, "icon-128.png"), format="PNG", optimize=True)

    # electron-builder maps every file in build/appx to assets\ inside the package.
    # "LargeTile.png" and "SmallTile.png" are the names its manifest generator
    # looks for when wiring Square310x310Logo / Square71x71Logo.
    tile_specs = {
        "StoreLogo.png": (50, 50),
        "Square44x44Logo.png": (44, 44),
        "Square150x150Logo.png": (150, 150),
        "Wide310x150Logo.png": (310, 150),
        "LargeTile.png": (310, 310),
        "SmallTile.png": (71, 71),
        "SplashScreen.png": (620, 300),
    }
    for name, (w, h) in tile_specs.items():
        render_tile(w, h).save(os.path.join(APPX, name), format="PNG", optimize=True)
    print("Icons written to build/, build/appx/ and assets/")


if __name__ == "__main__":
    main()
