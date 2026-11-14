---
name: effect_h3
cn_name: 特效-特效镜头
tags:
- MiniMax
- H3
- video
- 特效
inputs:
- image
- text
description: 首帧 + 一句话挑一个特效镜头：子弹时间、定格瞬间、画面炸开、繁花盛开、黑暗魔法、火焰吐息、四季流转、亲吻镜头、螺旋升腾、风暴魔法、楚门式片场
category: video_gen
gen_video: true
mode: i2v
requires_ref: true
created_at: '2026-11-13T00:00:00+00:00'
---

# 特效镜头（MiniMax H3 特效嵌入）

一枚技能带 11 个特效镜头：视频页选技能后出现的「特效」下拉就是这一份表，一句话 + 首帧出一发带特效的片。

- **特效本体是文本嵌入**：除「定格瞬间」外，每个特效的本体是一个社区文本嵌入文件（`models/embeddings/minimaxh3_*.safetensors`），
  最终提示词里由后端拼上官方语法的触发段 `embedding:minimaxh3_<特效名>`（ComfyUI 0.30+ 在 H3 提示词里支持 `embedding:name`，
  触发词 = 文件名去后缀，逐字匹配，改写过的文本让特效跑不出来）。段前后就是这一发的画面描述，别删这一段。
- **特效项各自带契约**：提示词模板、示例提示词、特效本体文件、时长上限、首尾同帧全钉在 config.json 的
  `effects` 表里，每个特效自己的那一发按自己的那一条跑；页面只交一个特效 id。
- **缺文件就挡**：本发特效的嵌入文件没落盘时，页面在提交前预检就拦下并给出「去模型库」直达，后端同样硬报错并点名缺的文件名——
  ComfyUI 读不到 `embedding:` 段只 warning 后整段忽略，静默出一发没有特效的片比报错更坏。其余特效的文件缺了不挡这一发。
- **定格瞬间不吃文件**：它是基座就能跑的近似镜头（尾帧自动取首帧、成片可无缝循环）；相机环绕用「子弹时间」。
- **时长与步数**：环绕与定格类钉死 124 帧（≈5.17 秒），选更长的秒数会被夹回来。特效表不写步数：官方那组
  24 / 28 是未加速官方模型上的参考值，本技能 `config.json` 钉 24 步作为出厂默认，换 8 步蒸馏 checkpoint 时
  把自定参数面板的步数改成 8 就真跑 8 步。
- **出处与许可**：10 个嵌入是社区作者 silveroxides 的非官方作品，经 [Comfy-Org/MiniMax-H3/embeddings](https://huggingface.co/Comfy-Org/MiniMax-H3/tree/main/embeddings)
  分发（[discussion #50](https://huggingface.co/Comfy-Org/MiniMax-H3/discussions/50)）；基座权重许可随 MiniMax 原仓库，
  本地生成用于商用需 MiniMax 商用许可。
