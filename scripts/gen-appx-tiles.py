#!/usr/bin/env python3
"""Generate branded Windows Store (appx) tile assets from the Legilo icon.

Without these, electron-builder ships its default SampleAppx.* placeholder
tiles, which fails Microsoft Store policy 10.1.1.11 (On Device Tiles).
Files land in build/appx/ where electron-builder auto-detects them.
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "logo", "icon-1024.png")
OUT = os.path.join(ROOT, "build", "appx")
STORE = os.path.join(ROOT, "logo", "store")

WHITE = (255, 255, 255, 255)

src = Image.open(SRC).convert("RGBA")


def square(size):
    return src.resize((size, size), Image.LANCZOS)


def on_canvas(w, h, logo_frac=0.72, bg=WHITE):
    """Center the square icon on a w*h canvas, sized to logo_frac of height."""
    canvas = Image.new("RGBA", (w, h), bg)
    side = int(h * logo_frac)
    logo = square(side)
    canvas.paste(logo, ((w - side) // 2, (h - side) // 2), logo)
    return canvas


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG")
    print("wrote", os.path.relpath(path, ROOT), img.size)


# --- Package tiles (build/appx/) — these fix the rejection ---
save(square(50),  os.path.join(OUT, "StoreLogo.png"))
save(square(44),  os.path.join(OUT, "Square44x44Logo.png"))
save(square(150), os.path.join(OUT, "Square150x150Logo.png"))
save(square(71),  os.path.join(OUT, "SmallTile.png"))          # Square71x71
save(square(310), os.path.join(OUT, "LargeTile.png"))          # Square310x310
save(on_canvas(310, 150), os.path.join(OUT, "Wide310x150Logo.png"))
save(on_canvas(620, 300), os.path.join(OUT, "SplashScreen.png"))

# --- Optional Store listing images (upload manually in Partner Center) ---
save(square(300), os.path.join(STORE, "app-tile-300.png"))
save(square(150), os.path.join(STORE, "app-tile-150.png"))
save(square(71),  os.path.join(STORE, "app-tile-71.png"))
save(on_canvas(1080, 1080, logo_frac=0.66), os.path.join(STORE, "box-art-1x1-1080.png"))
save(on_canvas(2160, 2160, logo_frac=0.66), os.path.join(STORE, "box-art-1x1-2160.png"))
