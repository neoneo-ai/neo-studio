---
name: qwen_image_21_controlnet
cn_name: Qwen Image 2.1 ControlNet
tags:
- 生图
- Qwen
- ControlNet
inputs:
- text
category: image_gen
gen_image: true
mode: edit
requires_ref: true
created_at: '2026-10-08T00:00:00+00:00'
---

Qwen Image 2.1 ControlNet（Fun ControlNet 模型补丁）：`<image1>` 出内容与长相，第 2 张参考图只进模型补丁，姿势与构图被控制图锁住。画廊「图片编辑」的「姿势」模式就是这条链。

- 参考图顺序：`<image1>` = 内容主体（要保留长相 / 服装 / 背景的那张），第 2 张 = 控制图，`<image3>` 起 = 附加内容参考（服装、风格、道具），最多 4 张。
- 控制图不进编码器：config.json 的 `control_ref: 2` 在解析期把它从编码器参考里摘出来，只喂控制链。它一旦同时占编码器槽，模型会把这张照片当内容参考直接复刻（出图 = 参考图）。
- 至少 2 张参考图（config.json 的 `min_refs`）：控制槽空时控制链会渲染成缺输入的图，后端在解析期直接报「该技能需要至少 2 张参考图」。
- 控制图已是控制图（3D 姿势页导出的骨架 / 深度 / 法线 / 线稿 / 剪影）时走直连：请求带 `control_direct: true`，模板里的 `AIO_Preprocessor` 整节被摘掉，模型补丁直连那张 `LoadImage`。骨架过 Openpose 是二次检测，深度 / 法线 / 线稿过它是喂人体检测器（图上没有人体，出来一张空白控制图，锁形变成随机出图）。
- 控制图是人物照片时不带 `control_direct`：控制链 `LoadImage(控制图) → AIO_Preprocessor(OpenposePreprocessor) → ZImageFunControlnet → KSampler.model` 先检测出骨架，模型补丁由 `ModelPatchLoader` 提供。
- 控制图会被拉伸到画布尺寸：3D 姿势页导出的方形图配方形出图最稳，长方形出图会把控制图拉变形。
- 默认触发词只提「按 ControlNet 姿势参考」：提示词里的 `<image1>` 指内容主体，控制图不在编码器里、不要用 `<image2>` 指它；换控制格式就换锁的东西（骨架锁姿势、深度锁空间、法线锁表面、线稿锁轮廓、剪影锁外形）。
- 控制强度固定 `strength=0.8`、`start_percent=0`、`end_percent=1`（模板 `ZImageFunControlnet`）：结构贴不紧就调高 strength，画面被骨架绑死就调低。
- 预处理分辨率对齐画布（模板 `AIO_Preprocessor.resolution = {{CANVAS_HEIGHT}}`），只有走检测那条路时这一项才存在。
- 依赖模型补丁 `qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors`（放 `models/model_patches`）；Openpose 预处理模型（`comfyui_controlnet_aux` 自带）只在检测那条路上才用到。
- 默认触发词在 config.json 的 default_prompt，选到本技能时自动预填。