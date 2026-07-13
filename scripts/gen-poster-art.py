#!/usr/bin/env python3
"""Generate 9:16 Poster art for the Microsoft Store listing.

Renders at 1440x2160 and downscales to 720x1080 so both required sizes
are crisp. Output: logo/store/poster-9x16-1440.png and -720.png.
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "logo", "icon-1024.png")
STORE = os.path.join(ROOT, "logo", "store")
FONT_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"

BLUE = (9, 105, 218)
DARK = (31, 41, 55)
GRAY = (107, 114, 128)

W, H = 1440, 2160  # render size (2x the 720x1080 target)
icon_src = Image.open(SRC).convert("RGBA")


def vertical_gradient(w, h, top, bottom):
    base = Image.new("RGB", (w, h))
    px = base.load()
    for y in range(h):
        t = y / (h - 1)
        px_row = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = px_row
    return base


def centered(draw, text, font, y, fill):
    box = draw.textbbox((0, 0), text, font=font)
    tw = box[2] - box[0]
    draw.text(((W - tw) / 2 - box[0], y), text, font=font, fill=fill)
    return box[3] - box[1]


img = vertical_gradient(W, H, (238, 244, 252), (255, 255, 255)).convert("RGBA")
draw = ImageDraw.Draw(img)

wordmark_font = ImageFont.truetype(FONT_BOLD, 190)
tagline_font = ImageFont.truetype(FONT_REG, 60)

icon_size = int(W * 0.50)
gap1, gap2 = 96, 44
wm_box = draw.textbbox((0, 0), "Legilo", font=wordmark_font)
wm_h = wm_box[3] - wm_box[1]
tg_box = draw.textbbox((0, 0), "Markdown reader & editor", font=tagline_font)
tg_h = tg_box[3] - tg_box[1]

total = icon_size + gap1 + wm_h + gap2 + tg_h
top_y = (H - total) // 2

icon = icon_src.resize((icon_size, icon_size), Image.LANCZOS)
img.paste(icon, ((W - icon_size) // 2, top_y), icon)

y = top_y + icon_size + gap1
centered(draw, "Legilo", wordmark_font, y - wm_box[1], DARK)
y += wm_h + gap2
centered(draw, "Markdown reader & editor", tagline_font, y - tg_box[1], GRAY)

os.makedirs(STORE, exist_ok=True)
big = os.path.join(STORE, "poster-9x16-1440.png")
small = os.path.join(STORE, "poster-9x16-720.png")
img.convert("RGB").save(big, "PNG")
img.resize((720, 1080), Image.LANCZOS).convert("RGB").save(small, "PNG")
print("wrote", os.path.relpath(big, ROOT), "(1440x2160)")
print("wrote", os.path.relpath(small, ROOT), "(720x1080)")
