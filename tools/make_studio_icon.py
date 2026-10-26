"""生成桌面端图标 web/neo-studio.ico：拍板造型，与 Studio 顶栏的「新影工坊」一致。
用法：python tools/make_studio_icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

PLUGIN_DIR = Path(__file__).resolve().parent.parent
OUT = PLUGIN_DIR / "web" / "neo-studio.ico"
S = 1024  # 4x 超采样，缩到 256 后边缘才不毛糙
BG = (34, 34, 38, 255)     # Studio 顶栏底色 #202024 略提亮
BAR = (232, 232, 236, 255)
BODY = (62, 166, 255, 255)


def clapper_bar():
    """拍板条：白底加斜纹。单独一层再旋转，斜边才干净。"""
    w, h = 760, 210
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.rectangle((0, 0, w, h), fill=BAR)
    for k in range(4):
        x = 60 + k * 190
        draw.polygon([(x, 0), (x + 90, 0), (x + 20, h), (x - 70, h)], fill=BG)
    return layer.rotate(8, resample=Image.BICUBIC, expand=True)


def make() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((0, 0, S - 1, S - 1), radius=S // 6, fill=BG)
    draw.rounded_rectangle((150, 470, 874, 880), radius=60, fill=BODY)
    bar = clapper_bar()
    img.paste(bar, (130, 200), bar)
    return img.resize((256, 256), Image.LANCZOS)


if __name__ == "__main__":
    icon = make()
    icon.save(OUT, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (256, 256)])
    print(OUT)
