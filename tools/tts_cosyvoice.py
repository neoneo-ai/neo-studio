"""CosyVoice3 旁白生成：按 docs/promo/video-scripts.md 的分镜窗口合成解说，
输出 tmp/narration/<scenario>/segNN.wav + narration.wav + segments.json（含 start 时刻）。

用法： python tools/tts_cosyvoice.py script1
"""
import json
import os
import sys

import numpy as np
import soundfile as sf
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMFY = os.path.dirname(os.path.dirname(ROOT))
PLUGIN = os.environ.get("COSYVOICE_PLUGIN", os.path.join(os.path.dirname(ROOT), "comfyui_fl-cosyvoice3"))
MODEL_DIR = os.environ.get("COSYVOICE_MODEL", os.path.join(COMFY, "models", "cosyvoice",
                        "Fun-CosyVoice3-0.5B", "FunAudioLLM", "Fun-CosyVoice3-0___5B-2512"))
REF_WAV = os.environ.get("COSYVOICE_REF_WAV", os.path.join(COMFY, "input", "女中音、严厉、强势.wav"))
sys.path.insert(0, PLUGIN)

from cosyvoice.cli.cosyvoice import CosyVoice3  # noqa: E402

# (窗口起, 窗口止, 解说词)
SEGMENTS = {
    "script1": [
        (0, 6, "一张六格分镜图，直接变成一条带声音的片子。"),
        (6, 16, "加一个导演节点，点右下角的加号新增导演配方，打开编辑器。宫格图分镜页里，宫格图故事板卡片选这张图，从素材库拖进去。"),
        (16, 28, "切分方式选自动检测，点拆分到各段。宫格按行优先切开，每一格成为这一段的首帧和分镜图，下面的各段对照逐格排好。"),
        (28, 40, "右边这栏是全局故事参考，写整片的故事走向，可改写。时间线页选模式和技能，保存，回画布，节点时间轴就是这些段。"),
        (40, 54, "点运行，逐段生成。当前段琥珀色按比例增长，跑完的段变绿，节点里的预览面板实时出画面。想重跑某一段，悬停段块勾上它，只跑勾选的段。"),
        (54, 64, "最后拼成一个带音频的视频。连续性默认开着，上一段尾部二十来帧作为下一段开头参考，接缝六帧淡化。"),
        (64, 70, "一张宫格图，一个导演节点。装 Neo Studio，重启即用。"),
    ],
    "script2": [
        (0, 6, "十二张参考图，一个节点管完；一句话，直接出提示词。"),
        (6, 18, "参考图宫格节点，加减号调槽位，一到十二。素材面板拖进来，本地文件多选批量加，系统里的文件直接拖到宫格。瓷砖拖放重排。"),
        (18, 30, "提示词不用连 CLIP。底部快捷框写一句大白话，点闪光，AI 生成提示词。宫格输出提示词和图，连线时槽位自动长出来。"),
        (30, 42, "提示词里用 Picture 1、Picture 2 指代第几张参考图，顺序就是槽位编号。接参考生视频，参考图最多九张。"),
        (42, 55, "保存配方时宫格作为主图片资产收集，还原时优先填回宫格。一句话加十二张图，就是一个可复用的配方。装 Neo Studio，重启即用。"),
    ],
    "script3": [
        (0, 6, "从论坛下的 MiniMax H3 全能参考工作流，模型名是作者机器上的。导入画布，满屏红节点。一键，全修好；缺的模型，直接下。"),
        (6, 20, "顶栏菜单亮起红点，点修复工作流。确认框里，原路径红色删除线，候选新路径绿色，带置信度百分比。阈值三档。点修复，画布原地更新，节点位置不动。"),
        (20, 34, "匹配不上的，在修复为那一列手动选文件；勾上记住手动选择，下次同样的失效路径自动替换。模型压根没装，失效行直接给模型库按钮，预填类别和搜索词。"),
        (34, 48, "模型库里选源，双源都能搜，仓库里的模型文件列出来，每条带落盘类别和大小，磁盘已有的标已存在。选文件自动带出类别，子目录是下拉。"),
        (48, 60, "下载有进度条、百分比和速度。中途取消，断点保留，状态写着断点保留。再点下载，按 Range 续传，不重头开始。"),
        (60, 70, "修复记录存在本机，最多五十条，不上传。装 Neo Studio，重启就能用。"),
    ],
}

SYSTEM_PROMPT = "You are a helpful assistant.<|endofprompt|>"


def synth(cv, text):
    chunks = []
    for out in cv.inference_cross_lingual(
        tts_text=SYSTEM_PROMPT + text,
        prompt_wav=REF_WAV,
        stream=False,
        speed=1.0,
        text_frontend=True,
    ):
        chunks.append(out["tts_speech"])
    if not chunks:
        raise RuntimeError("no audio produced")
    return torch.cat(chunks, dim=-1).cpu().numpy().flatten()


def main():
    scenario = sys.argv[1] if len(sys.argv) > 1 else "script1"
    plan = SEGMENTS[scenario]
    out_dir = os.path.join(ROOT, "tmp", "narration", scenario)
    os.makedirs(out_dir, exist_ok=True)

    cv = CosyVoice3(MODEL_DIR, load_trt=False, load_vllm=False, fp16=False)
    sr = cv.sample_rate

    segs = []
    cursor = 0.0
    pad = 0.6
    for i, (a, b, text) in enumerate(plan):
        wav = synth(cv, text)
        dur = len(wav) / sr
        name = f"seg{i:02d}.wav"
        sf.write(os.path.join(out_dir, name), wav, sr)
        segs.append({"index": i, "window": [a, b], "text": text, "path": name,
                     "duration": round(dur, 2), "start": round(cursor, 2),
                     "beat": round(dur + pad, 2)})
        cursor += dur + pad
        print(f"seg{i:02d} 名义 {a}-{b}s  实测 {dur:.2f}s  start {segs[-1]['start']}s  {text[:18]}")

    total = cursor
    track = np.zeros(int(total * sr), dtype=np.float32)
    for s in segs:
        w = sf.read(os.path.join(out_dir, s["path"]))[0]
        at = int(s["start"] * sr)
        track[at:at + len(w)] = w
    sf.write(os.path.join(out_dir, "narration.wav"), track, sr)
    with open(os.path.join(out_dir, "segments.json"), "w", encoding="utf-8") as f:
        json.dump({"scenario": scenario, "sample_rate": sr, "total": round(total, 2),
                   "segments": segs}, f, ensure_ascii=False, indent=2)
    print("narration.wav", round(total, 2), "s ->", os.path.join(out_dir, "narration.wav"))


if __name__ == "__main__":
    main()
