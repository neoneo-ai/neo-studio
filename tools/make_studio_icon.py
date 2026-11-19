"""生成桌面端图标 studio/web/neo-studio.ico：拍板造型，与 Studio 顶栏的「新影工坊」一致。
底板必须透明：整块深色实心的图在浅色任务栏上就是一块黑方块，斜纹与播放三角都挖空。
用法：python tools/make_studio_icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT = REPO_ROOT / "studio" / "web" / "neo-studio.ico"   # app/studio_app.py 的 STUDIO_ICON 与 tools/Neo-Studio.spec 读同一份
S = 1024  # 4x 超采样，缩到 256 后边缘才不毛糙
BAR = (26, 26, 30, 255)     # 拍板条：深色墨，浅色与深色任务栏都认得
BODY = (62, 166, 255, 255)  # 板身：品牌蓝
CLEAR = (0, 0, 0, 0)        # 斜纹与播放三角挖空，任务栏的颜色从底下透上来


def clapper_bar():
    """拍板条：深色墨条挖出斜纹。单独一层再旋转，斜边才干净。"""
    w, h = 760, 210
    layer = Image.new("RGBA", (w, h), CLEAR)
    draw = ImageDraw.Draw(layer)
    draw.rectangle((0, 0, w, h), fill=BAR)
    for k in range(4):
        x = 60 + k * 190
        draw.polygon([(x, 0), (x + 90, 0), (x + 20, h), (x - 70, h)], fill=CLEAR)
    return layer.rotate(8, resample=Image.BICUBIC, expand=True)


def make() -> Image.Image:
    img = Image.new("RGBA", (S, S), CLEAR)
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((150, 470, 874, 880), radius=60, fill=BODY)
    draw.polygon([(392, 556), (640, 675), (392, 794)], fill=CLEAR)   # 板身挖播放三角，与启动页遮罩同一枚
    bar = clapper_bar()
    img.paste(bar, (130, 200), bar)
    return img.resize((256, 256), Image.LANCZOS)


if __name__ == "__main__":
    icon = make()
    icon.save(OUT, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (256, 256)])
    print(OUT)
