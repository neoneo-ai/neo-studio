---
name: qwen_image_21_camera_angle
cn_name: Qwen Image 2.1 机位编辑
tags:
- 生图
- Qwen
- 编辑
inputs:
- text
category: image_gen
gen_image: true
mode: edit
requires_ref: true
created_at: '2026-10-08T00:00:00+00:00'
---

Qwen Image 2.1 机位编辑：保住 <image1> 的长相、发型、服装、光线与背景，只把相机机位换到指定角度重出这一张。

- 参考图顺序：<image1> = 要换机位的原图（编辑目标，按画布尺寸缩放）。
- 三个机位档位：转角（正面 / 右前 / 右侧 / 右后 / 背面 / 左后 / 左侧 / 左前，八档）、俯仰（仰拍 -30° / 平视 0° / 俯拍 30° / 高俯 60°）、镜头（远景 0 / 中景 5 / 特写 10）。
- 默认触发词在 config.json 的 default_prompt，三个方括号按「转角 / 俯仰 / 镜头」顺序填；编辑面板选到「机位」模式时由机位球自动填好，直接改球即可。
- 手写下提示词也行：把三档写成英文短语，如 "Move the camera of <image1> to the right side view, high-angle shot looking down, medium shot ..."。
- 不加载额外 LoRA（基础模型 + 参考图编辑通道），与姿势编辑同一条链。
