from pathlib import Path
import skia
from PIL import Image

OUT_DIR = Path(__file__).resolve().parent
OUT_DIR.mkdir(parents=True, exist_ok=True)

SIZE = 256
surface = skia.Surface(SIZE, SIZE)
canvas = surface.getCanvas()
canvas.clear(skia.ColorTRANSPARENT)

# Graphite rounded square base
bg_rect = skia.Rect.MakeXYWH(12, 12, 232, 232)
bg_rrect = skia.RRect.MakeRectXY(bg_rect, 52, 52)
canvas.drawRRect(bg_rrect, skia.Paint(Color=skia.ColorSetARGB(255, 25, 25, 27), AntiAlias=True))
canvas.drawRRect(
    bg_rrect,
    skia.Paint(
        Color=skia.ColorSetARGB(40, 237, 237, 237),
        Style=skia.Paint.kStroke_Style,
        StrokeWidth=4,
        AntiAlias=True,
    ),
)

# Subtle scrolling comment bars inside
bar_paint = skia.Paint(Color=skia.ColorSetARGB(210, 237, 237, 237), AntiAlias=True)
muted_bar = skia.Paint(Color=skia.ColorSetARGB(140, 161, 161, 166), AntiAlias=True)
green_bar = skia.Paint(Color=skia.ColorSetARGB(230, 92, 230, 138), AntiAlias=True)

canvas.drawRRect(skia.RRect.MakeRectXY(skia.Rect.MakeXYWH(44, 58, 126, 18), 9, 9), bar_paint)
canvas.drawRRect(skia.RRect.MakeRectXY(skia.Rect.MakeXYWH(92, 92, 120, 18), 9, 9), green_bar)
canvas.drawRRect(skia.RRect.MakeRectXY(skia.Rect.MakeXYWH(52, 180, 152, 18), 9, 9), muted_bar)

# Crisp flat broadcast crimson play glyph
path = skia.Path()
path.moveTo(98, 118)
path.lineTo(98, 174)
path.lineTo(156, 146)
path.close()
canvas.drawPath(path, skia.Paint(Color=skia.ColorSetARGB(255, 217, 72, 65), AntiAlias=True))

png_path = OUT_DIR / "icon.png"
ico_path = OUT_DIR / "icon.ico"
png_data = surface.makeImageSnapshot().encodeToData().bytes()
png_path.write_bytes(png_data)

with Image.open(png_path) as im:
    im.save(
        ico_path,
        format="ICO",
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
    )

print(f"Generated {ico_path} and {png_path}")
