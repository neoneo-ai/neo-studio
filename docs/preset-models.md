# Neo Studio 预设模型清单

> 🇬🇧 English: [preset-models.md](en/preset-models.md)
> 中文 | [English](en/preset-models.md)

预设技能自带的工作流要跑起来需要真实权重。本文把 `studio/skills/presets/<preset>/models.json`
里的机器可读清单逐条摊开：每个预设声明哪些文件、落在模型目录的哪个类别、多大、从哪个仓库取。
清单口径与就位判定在 [model-hub.md](model-hub.md) 的「技能预设自带工作流」一节，本文只列数据本身。

- 体积按十进制 GB（1 GB = 10⁹ 字节）保留两位小数，与 Model Hub 和生成前预检的显示口径一致。
- 文件数与体积按「类别目录 + 文件名末段」去重：族系内共用基座权重时只算一次。
- 预设清单只声明该预设的追加项，基座（`base_skill_id`）的文件由同族系的基座预设声明，
  下表已合并成完整的一套。

| 族系                       | 类型        | 预设数        | 文件数        | 合计 GB        | 基座预设             |
|----------------------------|-------------|---------------|---------------|----------------|----------------------|
| Krea2 生图族               | image       |            12 |             3 |          18.60 | image_gen            |
| MiniMax H3 生视频族        | video       |            16 |            14 |          63.79 | minimax_h3_base      |
| Qwen Image 2.1 生图族      | image       |            10 |             7 |          21.65 | qwen_image_21        |
| 合计                       |             |            38 |            24 |         104.04 |                      |

38 个预设带清单，分 3 个族系；族系内共用基座权重，体积按「类别 + 文件名末段」去重后只算一次。
另有 4 个预设不带清单（见文末）。

## Krea2 生图族（`krea2_image`，基座 `image_gen`）

许可：Comfy-Org 重打包权重，许可随 Krea 原仓库。族内 12 个预设共用这一套，预设侧没有追加项。

| 字段             | 文件名                                   | 落盘类别             | GB        | 下载来源（点开即下载）                                            | 变体名     | 归属     |
|------------------|------------------------------------------|----------------------|-----------|-------------------------------------------------------------------|------------|----------|
| model            | krea2_turbo_int8_convrot.safetensors     | diffusion_models     |     13.49 | [MS][k2-0-0] · [HF][k2-0-1]                                       |          7 | 基座     |
| text_encoder     | qwen3vl_4b_int8_convrot.safetensors      | text_encoders        |      4.86 | [MS][k2-1-0] · [HF][k2-1-1]                                       |          2 | 基座     |
| vae              | qwen_image_vae.safetensors               | vae                  |      0.25 | [MS1][k2-2-0] · [HF1][k2-2-1] · [MS2][k2-2-2] · [HF2][k2-2-3]     |          0 | 基座     |

[k2-0-0]: https://modelscope.cn/models/Comfy-Org/Krea-2/resolve/master/diffusion_models/krea2_turbo_int8_convrot.safetensors
[k2-0-1]: https://huggingface.co/models/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_int8_convrot.safetensors
[k2-1-0]: https://modelscope.cn/models/Comfy-Org/Krea-2/resolve/master/text_encoders/qwen3vl_4b_int8_convrot.safetensors
[k2-1-1]: https://huggingface.co/models/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_int8_convrot.safetensors
[k2-2-0]: https://modelscope.cn/models/Comfy-Org/Krea-2/resolve/master/vae/qwen_image_vae.safetensors
[k2-2-1]: https://huggingface.co/models/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors
[k2-2-2]: https://modelscope.cn/models/Comfy-Org/Qwen-Image_ComfyUI/resolve/master/split_files/vae/qwen_image_vae.safetensors
[k2-2-3]: https://huggingface.co/models/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors

来源列每个标记都是一条直链：`MS` 是 ModelScope 的 `resolve/master` 地址，`HF` 是 Hugging Face 的
`resolve/main` 地址，与 Model Hub 下载走的同一条 `resolve_url()`（`studio/model_hub.py`），浏览器里
点开即下载；同一文件在同一个源上有多个仓库时编号 `MS1` / `MS2`。`C 站` 指向 Civitai 模型页——
C 站的下载接口要登录与 API Token，进页面按版本取文件。

| 字段             | 文件名                                            | 落盘类别             | GB        | 下载来源（点开即下载）                                            | 变体名     | 归属               |
|------------------|---------------------------------------------------|----------------------|-----------|-------------------------------------------------------------------|------------|--------------------|
| model            | minimax_h3_fl2va_int8_convrot.safetensors         | diffusion_models     |     34.04 | [MS][h3-0-0] · [HF][h3-0-1]                                       |          7 | 基座               |
| text_encoder     | qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors      | text_encoders        |     15.69 | [MS1][h3-1-0] · [HF1][h3-1-1] · [MS2][h3-1-2] · [HF2][h3-1-3]     |          2 | 基座               |
| vae              | minimax_h3_video_vae_int8_convrot.safetensors     | vae                  |      2.81 | [MS1][h3-2-0] · [HF1][h3-2-1] · [MS2][h3-2-2] · [HF2][h3-2-3]     |          1 | 基座               |
| audio_vae        | minimax_h3_audio_vae_fp32.safetensors             | vae                  |      0.61 | [MS1][h3-3-0] · [HF1][h3-3-1] · [MS2][h3-3-2] · [HF2][h3-3-3]     |          0 | 基座               |
| effect           | minimaxh3_bullet_time.safetensors                 | embeddings           |      0.96 | [MS][h3-4-0] · [HF][h3-4-1]                                       |          0 | effect_h3          |
| effect           | minimaxh3_art_is_explosion.safetensors            | embeddings           |      0.51 | [MS][h3-5-0] · [HF][h3-5-1]                                       |          0 | effect_h3          |
| effect           | minimaxh3_blooming_flowers.safetensors            | embeddings           |      1.26 | [MS][h3-6-0] · [HF][h3-6-1]                                       |          0 | effect_h3          |
| effect           | minimaxh3_dark_magic.safetensors                  | embeddings           |      0.60 | [MS][h3-7-0] · [HF][h3-7-1]                                       |          0 | effect_h3          |
| effect           | minimaxh3_fire_breath.safetensors                 | embeddings           |      1.21 | [MS][h3-8-0] · [HF][h3-8-1]                                       |          0 | effect_h3          |
| effect           | minimaxh3_four_seasons.safetensors                | embeddings           |      1.45 | [MS][h3-9-0] · [HF][h3-9-1]                                       |          0 | effect_h3          |
| effect           | minimaxh3_kiss_camera.safetensors                 | embeddings           |      0.99 | [MS][h3-10-0] · [HF][h3-10-1]                                     |          0 | effect_h3          |
| effect           | minimaxh3_spiral_ascent.safetensors               | embeddings           |      1.34 | [MS][h3-11-0] · [HF][h3-11-1]                                     |          0 | effect_h3          |
| effect           | minimaxh3_storm_magic.safetensors                 | embeddings           |      1.40 | [MS][h3-12-0] · [HF][h3-12-1]                                     |          0 | effect_h3          |
| effect           | minimaxh3_truman_show.safetensors                 | embeddings           |      0.92 | [MS][h3-13-0] · [HF][h3-13-1]                                     |          0 | effect_h3          |

[h3-0-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/diffusion_models/minimax_h3_fl2va_int8_convrot.safetensors
[h3-0-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_int8_convrot.safetensors
[h3-1-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
[h3-1-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
[h3-1-2]: https://modelscope.cn/models/Comfy-Org/FastVideo-FastH3/resolve/master/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
[h3-1-3]: https://huggingface.co/models/Comfy-Org/FastVideo-FastH3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
[h3-2-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/vae/minimax_h3_video_vae_int8_convrot.safetensors
[h3-2-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors
[h3-2-2]: https://modelscope.cn/models/Comfy-Org/FastVideo-FastH3/resolve/master/vae/minimax_h3_video_vae_int8_convrot.safetensors
[h3-2-3]: https://huggingface.co/models/Comfy-Org/FastVideo-FastH3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors
[h3-3-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/vae/minimax_h3_audio_vae_fp32.safetensors
[h3-3-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors
[h3-3-2]: https://modelscope.cn/models/Comfy-Org/FastVideo-FastH3/resolve/master/vae/minimax_h3_audio_vae_fp32.safetensors
[h3-3-3]: https://huggingface.co/models/Comfy-Org/FastVideo-FastH3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors
[h3-4-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/embeddings/minimaxh3_bullet_time.safetensors
[h3-4-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/embeddings/minimaxh3_bullet_time.safetensors
[h3-5-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/embeddings/minimaxh3_art_is_explosion.safetensors
[h3-5-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/embeddings/minimaxh3_art_is_explosion.safetensors
[h3-6-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/embeddings/minimaxh3_blooming_flowers.safetensors
[h3-6-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/embeddings/minimaxh3_blooming_flowers.safetensors
[h3-7-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/embeddings/minimaxh3_dark_magic.safetensors
[h3-7-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/embeddings/minimaxh3_dark_magic.safetensors
[h3-8-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/embeddings/minimaxh3_fire_breath.safetensors
[h3-8-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/embeddings/minimaxh3_fire_breath.safetensors
[h3-9-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/embeddings/minimaxh3_four_seasons.safetensors
[h3-9-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/embeddings/minimaxh3_four_seasons.safetensors
[h3-10-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/embeddings/minimaxh3_kiss_camera.safetensors
[h3-10-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/embeddings/minimaxh3_kiss_camera.safetensors
[h3-11-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/embeddings/minimaxh3_spiral_ascent.safetensors
[h3-11-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/embeddings/minimaxh3_spiral_ascent.safetensors
[h3-12-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/embeddings/minimaxh3_storm_magic.safetensors
[h3-12-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/embeddings/minimaxh3_storm_magic.safetensors
[h3-13-0]: https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/embeddings/minimaxh3_truman_show.safetensors
[h3-13-1]: https://huggingface.co/models/Comfy-Org/MiniMax-H3/resolve/main/embeddings/minimaxh3_truman_show.safetensors

## MiniMax H3 生视频族（`minimax_h3`，基座 `minimax_h3_base`）

许可：Comfy-Org 重打包权重，许可随 MiniMax 原仓库；10 颗特效文本嵌入也是 Comfy-Org 仓库里的社区重打包产物（作者 silveroxides），署名随仓库。16 个预设共用这一套基座，追加项只有特效预设 `effect_h3` 声明的这 10 颗嵌入；「定格瞬间」不下载任何文件，走首尾帧插值。
`audio_vae` 只有带音频的段（连续多段合成、参考生视频）会读，落盘类别同样是 `vae`。

| 字段             | 文件名                                                           | 落盘类别             | GB       | 下载来源（点开即下载）                                                | 变体名     | 归属                         |
|------------------|------------------------------------------------------------------|----------------------|----------|-----------------------------------------------------------------------|------------|------------------------------|
| model            | qwen_image_2.1_int8_convrot.safetensors                          | diffusion_models     |     7.26 | [MS][q21-0-0] · [HF][q21-0-1]                                         |          3 | 基座                         |
| text_encoder     | qwen3vl_8b_int8_convrot.safetensors                              | text_encoders        |     9.35 | [MS1][q21-1-0] · [HF1][q21-1-1] · [MS2][q21-1-2] · [HF2][q21-1-3]     |          2 | 基座                         |
| vae              | qwen_image_2.1_vae_bf16.safetensors                              | vae                  |     0.68 | [MS][q21-2-0] · [HF][q21-2-1]                                         |          0 | 基座                         |
| loras            | Qwen21-换身bfs_body_swap_v1.0_qwen_2.1.safetensors               | loras                |     0.21 | [HF][q21-3-0] · [C 站][q21-3-1]                                       |          1 | qwen_image_21_body_swap      |
| patch            | qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors     | model_patches        |     3.78 | [MS][q21-4-0] · [HF][q21-4-1]                                         |          1 | qwen_image_21_controlnet     |
| loras            | Qwen21-换头bfs_head_v1.1_qwen_2.1.safetensors                    | loras                |     0.21 | [HF][q21-5-0]                                                         |          1 | qwen_image_21_face_swap      |
| loras            | qwen-image-2.1-outpaint-v2.safetensors                           | loras                |     0.16 | [HF][q21-6-0] · [C 站][q21-6-1]                                       |          0 | qwen_image_21_outpaint       |

[q21-0-0]: https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1/resolve/master/diffusion_models/qwen_image_2.1_int8_convrot.safetensors
[q21-0-1]: https://huggingface.co/models/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors
[q21-1-0]: https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1/resolve/master/text_encoders/qwen3vl_8b_int8_convrot.safetensors
[q21-1-1]: https://huggingface.co/models/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors
[q21-1-2]: https://modelscope.cn/models/Comfy-Org/Qwen3-VL/resolve/master/text_encoders/qwen3vl_8b_int8_convrot.safetensors
[q21-1-3]: https://huggingface.co/models/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors
[q21-2-0]: https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1/resolve/master/vae/qwen_image_2.1_vae_bf16.safetensors
[q21-2-1]: https://huggingface.co/models/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors
[q21-3-0]: https://huggingface.co/models/Alissonerdx/BFS-Best-Face-Swap/resolve/main/bfs_body_swap_v1.0_qwen_2.1.safetensors
[q21-3-1]: https://civitai.com/models/2027766
[q21-4-0]: https://modelscope.cn/models/Comfy-Org/Qwen-Image-2.1/resolve/master/model_patches/qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors
[q21-4-1]: https://huggingface.co/models/Comfy-Org/Qwen-Image-2.1/resolve/main/model_patches/qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors
[q21-5-0]: https://huggingface.co/models/Alissonerdx/BFS-Best-Face-Swap/resolve/main/bfs_head_v1.1_qwen_2.1.safetensors
[q21-6-0]: https://huggingface.co/models/ausboss/Qwen-Image-2.1-Outpaint-LoRA/resolve/main/qwen-image-2.1-outpaint-v2.safetensors
[q21-6-1]: https://civitai.com/models/2967375

## Qwen Image 2.1 生图族（`qwen_image_21`，基座 `qwen_image_21`）

许可：Comfy-Org 重打包权重，许可随 Qwen 原仓库；BFS 换身 / 换头 LoRA 是 MIT，扩图 LoRA 随
ausboss 仓库。基座 3 个文件之外，族里另有 4 个由预设各自带入的追加项（「归属」列写明是哪个预设）：
ControlNet 预设的 `model_patches` 文件，以及换身、换头、扩图三个 LoRA。

LoRA 行只在预设的 LoRA 列表或全局 LoRA 列表带着它时才算缺口：配置里没带的 LoRA 进不了工作流，
也就卡不住生成。`qwen_image_21_controlnet` 与 `qwen_image_21_outpaint` 不带 `extends`，自己的清单
带基座三项加那一个追加项；`qwen_image_21_identity_swap` 不带 `extends`
且只带基座三项——总览按「类别 + 文件名末段」把它们并回基座一套。

`text_encoder` 一项在 Qwen 基座与 MiniMax H3 族系里是两个不同的文件（`qwen3vl_8b` 与
`qwen3vl_32b_minimax_h3`），两族各自计入。

## 族系 → 预设

`cn_name` 取自预设的 `skill.md`，即技能选择列表里显示的名称；`family` 取自清单的 `family`。
带 `extends` 的清单只写追加项（检查时与基座合并），不带的自己带全套。

| 预设                                | 名称                                             | 族系               | 清单口径                                |
|-------------------------------------|--------------------------------------------------|--------------------|-----------------------------------------|
| Krea2_subject                       | Krea2 角色分镜设定                               | krea2_image        | 只写追加项（基座 image_gen）            |
| chinese_ancient_fantasy             | 中国古风玄幻                                     | krea2_image        | 只写追加项（基座 image_gen）            |
| chinese_ancient_movie               | 中国古装影视写真                                 | krea2_image        | 只写追加项（基座 image_gen）            |
| chinese_classical                   | 中国古风                                         | krea2_image        | 只写追加项（基座 image_gen）            |
| chinese_wuxia                       | 古风武侠                                         | krea2_image        | 只写追加项（基座 image_gen）            |
| fashion_photo                       | 时尚摄影                                         | krea2_image        | 只写追加项（基座 image_gen）            |
| general_enhance                     | 通用增强                                         | krea2_image        | 只写追加项（基座 image_gen）            |
| image_gen                           | Krea2文生图                                      | krea2_image        | 基座                                    |
| image_gen_text_subject              | Krea2文生角色图                                  | krea2_image        | 只写追加项（基座 image_gen）            |
| image_to_video                      | 图生视频                                         | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| minimax-h3-r2v                      | H3参考生视频                                     | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| minimax-h3-vdn-r2v                  | H3参考生视频 (VDN)                               | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| minimax_h3_base                     | H3首尾帧或文生视频                               | minimax_h3         | 基座                                    |
| minimax_h3_fl2v                     | 首尾帧生视频                                     | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| minimax_h3_full_ref                 | H3全参考生视频                                   | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| minimax_h3_i2v                      | H3 图生视频                                      | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| minimax_h3_image_ref                | H3图像参考生成视频                               | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| minimax_h3_multiframe               | H3 连续多段合成                                  | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| minimax_h3_t2v                      | H3 文生视频                                      | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| minimax_h3_vdn_fl2v                 | 首尾帧生视频 (VDN)                               | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| minimax_h3_vdn_i2v                  | H3 图生视频 (VDN)                                | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| minimax_h3_vdn_multiframe           | H3 连续多段合成 (VDN)                            | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| minimax_h3_vdn_t2v                  | H3 文生视频 (VDN)                                | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |
| my_variants                         | 三变体                                           | krea2_image        | 只写追加项（基座 image_gen）            |
| nine_grid_storyboard                | 九宫格分镜图（Qwen Image 2.1）                   | qwen_image_21      | 只写追加项（基座 qwen_image_21）        |
| pure_desire_aesthetics              | 纯欲美学                                         | krea2_image        | 只写追加项（基座 image_gen）            |
| qwen_image_21                       | Qwen Image 2.1 生图/编辑                         | qwen_image_21      | 基座                                    |
| qwen_image_21_body_swap             | Qwen Image 2.1 换身                              | qwen_image_21      | 只写追加项（基座 qwen_image_21）        |
| qwen_image_21_controlnet            | Qwen Image 2.1 ControlNet                        | qwen_image_21      | 自带基座三项 + 追加 1 项                |
| qwen_image_21_face_swap             | Qwen Image 2.1 换脸                              | qwen_image_21      | 只写追加项（基座 qwen_image_21）        |
| qwen_image_21_identity_swap         | Qwen Image 2.1 换脸（LLM 改写·无 LoRA）          | qwen_image_21      | 自带全套（无 extends）                  |
| qwen_image_21_local_edit            | Qwen Image 2.1 高分局部编辑                      | qwen_image_21      | 只写追加项（基座 qwen_image_21）        |
| qwen_image_21_outpaint              | Qwen Image 2.1 扩图                              | qwen_image_21      | 自带基座三项 + 追加 1 项                |
| qwen_image_21_watermark_remove      | Qwen Image 2.1 去水印                            | qwen_image_21      | 只写追加项（基座 qwen_image_21）        |
| realistic_photo                     | 写实摄影                                         | krea2_image        | 只写追加项（基座 image_gen）            |
| text_to_video                       | WAN文生视频                                      | minimax_h3         | 只写追加项（基座 minimax_h3_base）      |

## 不带清单的 4 个预设

| 预设                         | 名称                       | 族系        | 需要        | 备注                                |
|------------------------------|----------------------------|-------------|-------------|-------------------------------------|
| video_first_last_frames      | 首尾帧补间（WAN 2.2）      | 无          | 无          | 无 `workflow.json`，技能不加载      |
| video_reference2video        | 参考视频（WAN 2.2）        | 无          | 无          | 无 `workflow.json`，技能不加载      |
| 3d_pose                      | 3D 姿势                    | 无          | 无          | 姿势编辑器不加载工作流              |
| cosyvoice3_tts               | CosyVoice3 语音合成        | 无          | 是          | 模型走插件自己的目录，见下节        |

前三个预设没有 `workflow.json`，技能不会加载，因此不声明清单。`cosyvoice3_tts` 有工作流，
权重不读 `models.json`：`studio/cosyvoice_tts.py` 直接从
`<模型目录>/cosyvoice/Fun-CosyVoice3-0.5B/` 加载，因此不出现在 Model Hub 的技能清单里。

## CosyVoice3 语音合成（`models/cosyvoice/Fun-CosyVoice3-0.5B/`）

许可：Fun-CosyVoice 官方仓库许可。必需文件合计 5.40 GB，加载入口是仓库根目录的
`cosyvoice3.yaml`；文件缺失时合成请求直接失败，技能照常列出。

| 文件（相对模型目录）                      | GB        | 用途                            | 下载直链                         |
|-------------------------------------------|-----------|---------------------------------|----------------------------------|
| cosyvoice3.yaml                           |      0.00 | 超参加载入                      | [HF][cv-0-hf] · [MS][cv-0-ms]    |
| llm.pt                                    |      2.02 | 文字 → 语音 token（LLM 权重）   | [HF][cv-1-hf] · [MS][cv-1-ms]    |
| flow.pt                                   |      1.33 | token → 声学特征（flow 权重）   | [HF][cv-2-hf] · [MS][cv-2-ms]    |
| hift.pt                                   |      0.08 | 声码器（特殊 token 数 6564）    | [HF][cv-3-hf] · [MS][cv-3-ms]    |
| campplus.onnx                             |      0.03 | 参考音频的说话人嵌入            | [HF][cv-4-hf] · [MS][cv-4-ms]    |
| speech_tokenizer_v3.onnx                  |      0.97 | 参考音频 → 语音 token           | [HF][cv-5-hf] · [MS][cv-5-ms]    |
| CosyVoice-BlankEN/model.safetensors       |      0.99 | LLM 的 Qwen2 底座语言模型       | [HF][cv-6-hf] · [MS][cv-6-ms]    |
| CosyVoice-BlankEN/vocab.json              |      0.00 | LLM 分词器词表                  | [HF][cv-7-hf] · [MS][cv-7-ms]    |
| CosyVoice-BlankEN/merges.txt              |      0.00 | LLM 分词器合并表                | [HF][cv-8-hf] · [MS][cv-8-ms]    |
| CosyVoice-BlankEN/tokenizer_config.json   |      0.00 | 分词器配置                      | [HF][cv-9-hf] · [MS][cv-9-ms]    |
| CosyVoice-BlankEN/config.json             |      0.00 | 底座模型配置                    | [HF][cv-10-hf] · [MS][cv-10-ms]  |
| CosyVoice-BlankEN/generation_config.json  |      0.00 | 采样配置                        | [HF][cv-11-hf] · [MS][cv-11-ms]  |
| CosyVoice-BlankEN/vocab-config.json       |      0.00 | 分词器与底座配置副本            | 随目录                           |

[cv-0-hf]: https://huggingface.co/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/cosyvoice3.yaml
[cv-0-ms]: https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/cosyvoice3.yaml
[cv-1-hf]: https://huggingface.co/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/llm.pt
[cv-1-ms]: https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/llm.pt
[cv-2-hf]: https://huggingface.co/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/flow.pt
[cv-2-ms]: https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/flow.pt
[cv-3-hf]: https://huggingface.co/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/hift.pt
[cv-3-ms]: https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/hift.pt
[cv-4-hf]: https://huggingface.co/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/campplus.onnx
[cv-4-ms]: https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/campplus.onnx
[cv-5-hf]: https://huggingface.co/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/speech_tokenizer_v3.onnx
[cv-5-ms]: https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/speech_tokenizer_v3.onnx
[cv-6-hf]: https://huggingface.co/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/CosyVoice-BlankEN/model.safetensors
[cv-6-ms]: https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/CosyVoice-BlankEN/model.safetensors
[cv-7-hf]: https://huggingface.co/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/CosyVoice-BlankEN/vocab.json
[cv-7-ms]: https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/CosyVoice-BlankEN/vocab.json
[cv-8-hf]: https://huggingface.co/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/CosyVoice-BlankEN/merges.txt
[cv-8-ms]: https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/CosyVoice-BlankEN/merges.txt
[cv-9-hf]: https://huggingface.co/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/CosyVoice-BlankEN/tokenizer_config.json
[cv-9-ms]: https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/CosyVoice-BlankEN/tokenizer_config.json
[cv-10-hf]: https://huggingface.co/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/CosyVoice-BlankEN/config.json
[cv-10-ms]: https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/CosyVoice-BlankEN/config.json
[cv-11-hf]: https://huggingface.co/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/main/CosyVoice-BlankEN/generation_config.json
[cv-11-ms]: https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512/resolve/master/CosyVoice-BlankEN/generation_config.json

直链指向两个源站上的同一仓库 [HF 仓库页](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512) ·
[ModelScope 仓库页](https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)：`HF` 是
`resolve/main` 地址，`MS` 是 `resolve/master` 地址，与 `FL_CosyVoice3_ModelLoader` 的
`download_source` 同源，Apache-2.0、不登录、无需 Token。整仓取用时技能自己拉包，上表的直链只用于
手工补齐单个文件；`CosyVoice-BlankEN/vocab-config.json` 随目录一起取，仓库里没有这个单文件，不给直链。

仓库里另有三个文件本技能不读，不必下载：`llm.rl.pt`（2.02 GB，官方 RL 权重，加载走 `llm.pt`）、
`speech_tokenizer_v3.batch.onnx`（0.97 GB，批量推理）、`flow.decoder.estimator.fp32.onnx`（1.33 GB，
TensorRT 解码路径）。`spk2info.pt` 是本机第一次保存说话人时生成的，不在下载清单里。

## 相关

- 清单口径、就位判定与下载计划：[model-hub.md](model-hub.md)
- 生成前预检与缺失模型的下载入口：[image-gen.md](image-gen.md)
- 路由清单（`skill_models.py` 一节）：[api-routes.md](api-routes.md)
- 预设技能本身：[skills.md](skills.md)
