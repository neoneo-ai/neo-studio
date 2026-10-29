---
name: minimax-h3-r2v
cn_name: H3参考生视频
tags:
- MiniMax
- H3
- video
- 参考
inputs:
- image
- video
- audio
- text
description: H3参考生视频：最多 9 张参考图 / 3 个参考视频 / 3 个参考音频
category: video_gen
gen_video: true
mode: r2v
requires_ref: true
created_at: '2026-09-14T00:00:00+00:00'
multi_frame: true
---

# H3 参考生视频（Reference to Video）

用 MiniMax H3 的 `MiniMaxH3ReferenceToVideo`（ref2va）把参考素材带进生成，产出单个含音频的视频。

## 可挂的参考

| 类型 | 上限 | 模板占位符 | 加载链 |
| --- | --- | --- | --- |
| 参考图 | 9 | `{{REF_IMAGE_1..9}}` | `LoadImage → ref_images.ref_image_0..8` |
| 参考视频 | 3 | `{{REF_VIDEO_1..3}}` | `LoadVideo → GetVideoComponents → ref_videos.ref_video_0..2` |
| 参考音频 | 3 | `{{REF_AUDIO_1..3}}` | `LoadAudio → ref_audios.ref_audio_0..2` |

模板只写演示槽（2 图 / 1 视频 / 1 音频）：参考数超过模板槽位时，运行时克隆加载链补齐槽位（上限 9 / 3 / 3）；未挂的槽位在渲染模板时连同加载节点一起裁掉，所以只挂一两张图也能正常执行。

## 提示词写法

参考素材在条件里按**同类型 1 基序号**编号，写提示词时用同样的标签指代：

- `<Picture 1>` / `<Picture 2>` …：参考图
- `<Video 1>` …：参考视频（作为剪辑来源 / 续接起点 / 整片时间结构）
- `<Audio 1>` …：参考音频（照搬或仅参考音色）

例如：`<Subject 1> 是 <Picture 1> 中的女孩，动作参考 <Video 1>，音色参考 <Audio 1>`。
只用来定义角色/场景/服装/风格的图不要单独写成 `<Picture N>`，应在对应 `<Subject N>` 里引用。
没有被指代的参考完全不进条件：提示词里缺某一类参考的标签时，执行前自动补一行该类型的指代，已写好的不重复添加。

## 模型

模型沿用「生视频设置」（`video_gen.json`），缺省时按名称线索自动挑选（`suggest_video_model`）。
参考生视频需要 **ref2va** 权重；自动挑到 fl2va（文生/图生权重）时请在「生视频设置」或本技能的技能设置里手动改。

