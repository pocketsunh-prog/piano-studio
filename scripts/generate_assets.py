"""Generate Android launcher/splash artwork for Piano Studio.

Run: python scripts/generate_assets.py
Outputs assets/icon.png, icon-foreground.png, icon-background.png,
splash.png and splash-dark.png (consumed by `npx capacitor-assets generate`).
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)

BG = (11, 14, 20, 255)
CREAM = (246, 241, 230, 255)
CREAM_DARK = (222, 212, 193, 255)
GOLD = (224, 182, 76, 255)
GOLD_SOFT = (224, 182, 76, 90)
INK = (20, 24, 32, 255)


def rounded_rect(draw: ImageDraw.ImageDraw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_keyboard(img: Image.Image, cx: float, cy: float, width: float) -> None:
    """Draw a stylised 7-white-key piano centred at (cx, cy)."""
    draw = ImageDraw.Draw(img, "RGBA")
    key_h = width * 0.62
    left = cx - width / 2
    top = cy - key_h / 2
    white_w = width / 7
    radius = max(4, int(width * 0.03))

    # soft glow behind the keyboard
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse(
        [
            left - width * 0.18,
            top - key_h * 0.35,
            left + width * 1.18,
            top + key_h * 1.35,
        ],
        fill=GOLD_SOFT,
    )
    glow = glow.filter(ImageFilter.GaussianBlur(width * 0.08))
    img.alpha_composite(glow)

    # keyboard body
    rounded_rect(draw, [left - width * 0.03, top - width * 0.03, left + width * 1.03, top + key_h + width * 0.03],
                 radius * 2, (24, 30, 40, 255))
    for i in range(7):
        x0 = left + i * white_w
        rounded_rect(
            draw,
            [x0 + white_w * 0.035, top + key_h * 0.035, x0 + white_w * 0.965, top + key_h * 0.97],
            radius,
            CREAM if i % 3 else CREAM_DARK,
        )

    black_offsets = [0, 1, 3, 4, 5]
    black_w = white_w * 0.58
    black_h = key_h * 0.62
    for i in black_offsets:
        x0 = left + (i + 1) * white_w - black_w / 2
        rounded_rect(draw, [x0, top + key_h * 0.02, x0 + black_w, top + black_h], radius, INK)

    # gold accent line under the keys
    line_y = top + key_h + width * 0.055
    rounded_rect(
        draw,
        [left + width * 0.05, line_y, left + width * 0.95, line_y + max(4, width * 0.028)],
        max(3, width * 0.014),
        GOLD,
    )


def make_icon(size: int = 1024) -> Image.Image:
    img = Image.new("RGBA", (size, size), BG)
    # subtle vignette / gold glow
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse([size * 0.05, size * 0.02, size * 0.95, size * 0.78], fill=(224, 182, 76, 26))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.12))
    img.alpha_composite(glow)
    draw_keyboard(img, size * 0.5, size * 0.5, size * 0.62)
    return img


def make_foreground(size: int = 1024) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_keyboard(img, size * 0.5, size * 0.5, size * 0.46)
    return img


def make_background(size: int = 1024) -> Image.Image:
    img = Image.new("RGBA", (size, size), BG)
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse([size * 0.05, size * 0.02, size * 0.95, size * 0.78], fill=(224, 182, 76, 26))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.14))
    img.alpha_composite(glow)
    return img


def load_font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        Path(r"C:\Windows\Fonts\segoeuib.ttf"),
        Path(r"C:\Windows\Fonts\arialbd.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def make_splash(size: int = 2732) -> Image.Image:
    img = Image.new("RGBA", (size, size), BG)
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse([size * 0.12, size * 0.1, size * 0.88, size * 0.72], fill=(224, 182, 76, 34))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.1))
    img.alpha_composite(glow)

    draw_keyboard(img, size * 0.5, size * 0.47, size * 0.34)

    draw = ImageDraw.Draw(img)
    font = load_font(int(size * 0.045))
    text = "PIANO STUDIO"
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text(
        (size * 0.5 - (bbox[2] - bbox[0]) / 2, size * 0.66),
        text,
        font=font,
        fill=(232, 237, 245, 255),
    )
    small = load_font(int(size * 0.016))
    sub = "PLAY  ·  READ  ·  PRACTICE"
    bbox = draw.textbbox((0, 0), sub, font=small)
    draw.text(
        (size * 0.5 - (bbox[2] - bbox[0]) / 2, size * 0.735),
        sub,
        font=small,
        fill=(141, 153, 173, 255),
    )
    return img


def main() -> None:
    make_icon().save(ASSETS / "icon.png")
    make_foreground().save(ASSETS / "icon-foreground.png")
    make_background().save(ASSETS / "icon-background.png")
    splash = make_splash()
    splash.save(ASSETS / "splash.png")
    splash.save(ASSETS / "splash-dark.png")
    print("Wrote icon/splash assets to", ASSETS)


if __name__ == "__main__":
    main()
