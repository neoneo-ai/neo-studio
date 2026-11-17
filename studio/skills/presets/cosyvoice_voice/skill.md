---
name: cosyvoice_voice
cn_name: CosyVoice 语音克隆
tags:
- 语音
- CosyVoice
- 克隆
inputs:
- audio
- text
category: audio_gen
landing: voice
gen_audio: true
requires_ref: true
created_at: '2026-10-10T00:00:00+00:00'
---

CosyVoice3 零样本语音克隆：以参考音频的音色朗读目标文字。参考文本由 ZeroShot 内部用 Whisper 自动转写，无需手填。

- 参考音频（{{REF_AUDIO_1}}）= 画廊音频卡片落盘到 input/ 的音源。
- 目标文字（{{PROMPT}}）= 弹窗里要说的内容，用克隆出的音色合成。
- 输出由 SaveAudio 落盘到 Output/Voice/<日期>。
