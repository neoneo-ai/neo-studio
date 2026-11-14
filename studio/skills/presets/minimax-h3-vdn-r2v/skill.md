---
name: minimax-h3-vdn-r2v
cn_name: H3参考生视频 (VDN)
tags:
- MiniMax
- H3
- video
- VDN
- 参考
inputs:
- image
- video
- audio
- text
description: H3参考生视频（VDN 加速）：最多 9 张参考图 / 3 个参考视频 / 3 个参考音频
category: video_gen
gen_video: true
mode: r2v
requires_ref: true
created_at: '2026-09-15T00:00:00+00:00'
multi_frame: true
---

# H3 参考生视频（VDN 加速）

与非 VDN 的 `minimax-h3-r2v` 同一条参考链，只在采样链上多插一个 `ApplyVDNH3Advanced`，`config.json` 钉 8 步
（对齐 8 步 DMD 蒸馏 checkpoint），需要安装 ComfyUI-VDN-H3 并把 stage 放到 `models/vdn/stage-dmd-step-250/`。

`config.json` 带与非 VDN 那一条逐字同源的特效表，默认钉「无特效」：特效下拉、缺本体文件的硬挡、
「定格瞬间」不在表里，口径全在那一份表里，见 `minimax-h3-r2v` 的「特效镜头」一节。


