# /// script
# dependencies = ["pillow"]
# ///
"""Draws the app icon (pink balloon) for the home screen: 180, 192 and 512 px PNG + SVG."""
from PIL import Image, ImageDraw

PINK = (232, 70, 124)
BG = (255, 247, 249)


def draw(size: int) -> Image.Image:
    s = size / 512
    im = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(im)
    d.ellipse([136 * s, 70 * s, 376 * s, 350 * s], fill=PINK)
    d.ellipse([180 * s, 120 * s, 230 * s, 190 * s], fill=(246, 150, 184))
    d.polygon([(240 * s, 348 * s), (272 * s, 348 * s), (256 * s, 372 * s)], fill=PINK)
    d.line([(256 * s, 372 * s), (240 * s, 420 * s), (270 * s, 460 * s)], fill=(160, 120, 135), width=max(2, int(6 * s)))
    return im


for size, name in [(180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")]:
    draw(size).save(f"web/public/{name}")

open("web/public/icon.svg", "w").write(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#fff7f9"/>'
    '<ellipse cx="256" cy="210" rx="120" ry="140" fill="#e8467c"/><ellipse cx="205" cy="155" rx="25" ry="35" fill="#f696b8"/>'
    '<path d="M240 348h32l-16 24z" fill="#e8467c"/><path d="M256 372l-16 48 30 40" stroke="#a07887" stroke-width="6" fill="none"/></svg>'
)
