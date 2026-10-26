"""生成「从论坛下载的 MiniMax H3 全能参考工作流」演示素材（脚本三片头用）。

拿真实社区工作流 user/default/workflows/MMH3/MiniMax H3全能参考工作流 .json（75 节点），
把模型名换成作者机器上的原始权重名（fp16 / fp8），本机只有量化版；按 ComfyUI 存图的写法
把 UI 工作流写进 PNG 的 workflow tEXt 块，落到 input/NeoDemo/。素材库灯箱「导入工作流」
载入画布后模型路径全部失效，顶栏 Neo 图标亮红点。

三行演示位（旁路节点不参与修复）：
  - UNET 只差量化标记（fp8 ↔ 本机 int8_convrot，置信度 90%，标准档自动匹配）
  - CLIP 相似度不够（0.84，手动改选 + 「模型库」按钮）
  - VAE 本机没有（「模型库」按钮）
其余模型名精确命中本机文件（100%，不产生修复行）。

参考图与音频是程序画的抽象几何素材（机甲 / 异形 / 废墟 + 一段音），全部落在 input/NeoDemo/，
素材库进这个子目录就只有安全素材，面板上不会出现真人照片或敏感画面。

用法： python tools/make-community-workflow.py
"""
import json
import math
import os
import wave

from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 插件目录
COMFY = os.path.dirname(os.path.dirname(ROOT))  # ComfyUI 根目录
DEMO = os.path.join(COMFY, "input", "NeoDemo")
SRC = os.path.join(COMFY, "user", "default", "workflows", "MMH3",
                   "MiniMax H3全能参考工作流 .json")
OUT = os.path.join(DEMO, "minimax-h3-community.png")

MODEL_EXTS = (".safetensors", ".pt", ".ckpt", ".pth", ".bin", ".gguf", ".onnx")
FONT = r"C:\Windows\Fonts\msyh.ttc"
# 作者机器上的原始权重名（社区工作流原样），本机只有量化版
# UNET / CLIP 只差量化标记（90% 置信度），VAE 本机没有（修复弹窗给「模型库」按钮）
OVERRIDES = {
    201: "MiniMaxH3/minimax_h3_ref2va_pruned_fp16.safetensors",
    127: "MiniMaxH3/minimax_h3_ref2va_pruned_fp16.safetensors",
    227: "MiniMaxH3/minimax_h3_fl2va_fp8_convrot.safetensors",
    202: "qwen3vl_32b_minimax_h3_fp16.safetensors",
    238: "qwen3vl_32b_minimax_h3_fp16.safetensors",
    216: "minimax_h3_video_vae_pruned_fp8.safetensors",
}
# 参考图 / 音频槽位换成生成的抽象素材（LoadImage/LoadAudio 认子目录前缀）
FILE_OVERRIDES = {
    208: "NeoDemo/neo_ref_mecha.png",
    137: "NeoDemo/neo_ref_alien.png",
    139: "NeoDemo/neo_ref_ruins.png",
    142: "NeoDemo/neo_ref_mecha.png",
    143: "NeoDemo/neo_ref_voice.wav",
    144: "NeoDemo/neo_ref_voice.wav",
    214: "NeoDemo/neo_ref_voice.wav",
}


def rewrite(wf):
    refs = 0
    for n in wf["nodes"]:
        wv = n.get("widgets_values")
        if not isinstance(wv, list):
            continue
        for i, v in enumerate(wv):
            if not isinstance(v, str):
                continue
            if v.lower().endswith(MODEL_EXTS):
                wv[i] = OVERRIDES.get(n["id"], v)
                refs += 1
            elif i == 0 and n["id"] in FILE_OVERRIDES:
                wv[i] = FILE_OVERRIDES[n["id"]]
    return refs


def _font(size):
    return ImageFont.truetype(FONT, size)


def tile(name, kind, label):
    """16:9 抽象几何参考图：渐变底 + 网格 + 主体形状 + 底部标签条。"""
    w, h = 1024, 576
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        if kind == "ruins":
            c = (28 + y * 120 // h, 20 + y * 70 // h, 18 + y * 20 // h)
        elif kind == "alien":
            c = (18 + y * 40 // h, 16 + y * 26 // h, 30 + y * 70 // h)
        else:
            c = (16 + y * 26 // h, 20 + y * 40 // h, 34 + y * 90 // h)
        d.line([(0, y), (w, y)], fill=c)
    for x in range(0, w, 64):  # 网格
        d.line([(x, 0), (x, h)], fill=(60, 66, 80))
    for y in range(0, h, 64):
        d.line([(0, y), (w, y)], fill=(60, 66, 80))
    if kind == "mecha":
        d.polygon([(512, 96), (656, 192), (608, 392), (416, 392), (368, 192)],
                  fill=(178, 188, 202), outline=(232, 240, 250))
        d.ellipse([468, 236, 556, 324], fill=(64, 158, 236), outline=(204, 230, 252))
        d.rectangle([288, 392, 736, 408], fill=(118, 130, 148))
    elif kind == "alien":
        pts = []
        for i in range(12):
            a = i * math.pi / 6
            r = 200 if i % 2 == 0 else 118
            pts.append((512 + r * math.cos(a), 300 + int(r * 0.72) * math.sin(a)))
        d.polygon(pts, fill=(38, 26, 44), outline=(150, 78, 96))
        d.ellipse([486, 268, 538, 320], fill=(214, 92, 74))
    else:
        d.ellipse([352, 112, 672, 432], outline=(244, 156, 84), width=10)
        for x, y, bw, bh in [(120, 372, 90, 26), (760, 196, 120, 30),
                             (300, 452, 200, 22), (820, 424, 70, 20)]:
            d.rectangle([x, y, x + bw, y + bh], fill=(96, 84, 78))
        d.rectangle([0, 496, w, h], fill=(64, 52, 46))
    d.rectangle([0, 512, w, h], fill=(12, 14, 18))
    d.text((24, 528), label, font=_font(34), fill=(226, 232, 240))
    img.save(os.path.join(DEMO, name), "PNG")


def tone(name, seconds=2.5, hz=196):
    sr = 24000
    n = int(seconds * sr)
    frames = bytearray()
    for i in range(n):
        env = min(1.0, i / (sr * 0.05), max(0.0, (n - i) / (sr * 0.1)))
        s = 0.28 * env * (math.sin(2 * math.pi * hz * i / sr)
                          + 0.35 * math.sin(2 * math.pi * hz * 2 * i / sr))
        frames += int(s * 32767).to_bytes(2, "little", signed=True)
    with wave.open(os.path.join(DEMO, name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))


def cover(w=1280, h=720):
    img = Image.new("RGB", (w, h), (22, 24, 30))
    d = ImageDraw.Draw(img)
    for y in range(h):  # 深色渐变底
        d.line([(0, y), (w, y)], fill=(22 + y * 18 // h, 24 + y * 22 // h, 30 + y * 30 // h))
    for x in range(4):  # 模型目录条
        d.rectangle([60 + x * 300, 160, 320 + x * 300, 560], fill=(34, 38, 46), outline=(70, 78, 92))
    d.rectangle([60, 160, 320, 560], outline=(198, 120, 60), width=4)
    d.text((60, 56), "MiniMax H3 全能参考工作流", font=_font(46), fill=(236, 240, 248))
    d.text((60, 112), "社区工作流 · 模型名是作者机器上的", font=_font(30), fill=(150, 158, 172))
    return img


def main():
    os.makedirs(DEMO, exist_ok=True)
    with open(SRC, encoding="utf-8") as f:
        wf = json.load(f)
    refs = rewrite(wf)
    tile("neo_ref_mecha.png", "mecha", "参考图 1 · 白银机甲")
    tile("neo_ref_alien.png", "alien", "参考图 2 · 异形对手")
    tile("neo_ref_ruins.png", "ruins", "参考图 3 · 末日废墟")
    tone("neo_ref_voice.wav")
    # tEXt 只能装 ASCII，json.dumps 默认把中文转义成 \uXXXX，和 ComfyUI 存图的写法一致
    info = PngImagePlugin.PngInfo()
    info.add_text("workflow", json.dumps(wf))
    cover().save(OUT, "PNG", pnginfo=info)
    print(f"{OUT}  {os.path.getsize(OUT)} bytes  nodes {len(wf['nodes'])}  model refs {refs}")
    for n in wf["nodes"]:
        for v in n.get("widgets_values") or []:
            if isinstance(v, str) and (v in OVERRIDES.values() or v.startswith("NeoDemo/")):
                print(f"  {n['type']}#{n['id']} {v}")


if __name__ == "__main__":
    main()
