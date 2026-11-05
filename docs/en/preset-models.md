# Preset model file inventory

> 🇨🇳 中文: [../preset-models.md](../preset-models.md)

The model files each preset skill runs on, family by family: file name, drop-in category, size and
sources. The manifest schema, the readiness rules and where a download plan lands live in
[model-hub.md](model-hub.md) ("Preset model manifests (models.json)") - this page is the data, not the
rules. What your machine is missing is the Model Hub's **Preset readiness** panel
(`GET /neo_skill_models/all`).

- Sizes are decimal GB, the same unit the `gb` field of `models.json` uses.
- The `Download links` column turns every `sources` entry into a clickable link, in manifest order;
  the first one (`sources[0]`) is the recommended source. A download plan builds for the source the
  hub currently has selected.
- `Alt` counts the manifest's `alt` names: when your machine has a different quantisation of the same
  model, readiness recognises it through those names.
- Landing path = `<ComfyUI root>/models/<category>/<family dir>/<file>`; files whose repository path
  carries a directory land with that directory - details in [model-hub.md](model-hub.md).

## Overview

| Family                 | Kind           | Presets          | Files          | Total GB          | Base preset              |
|------------------------|----------------|------------------|----------------|-------------------|--------------------------|
| krea2_image            | image          |               12 |              3 |             18.60 | image_gen                |
| minimax_h3             | video          |               15 |              4 |             53.15 | minimax_h3_base          |
| qwen_image_21          | image          |               10 |              7 |             21.65 | qwen_image_21            |
| Total                  |                |               37 |             14 |             93.40 |                          |

37 presets ship a manifest across 3 families; presets inside a family share the base weights, so the
totals deduplicate by (category + file name) and a file the family shares counts once. Four presets
ship no manifest (see the last section).

## Krea2 image family (`krea2_image`, base `image_gen`)

License: Comfy-Org repackaged weights, the license follows the Krea source repository. All 12 presets
of the family run on this set and add nothing on top of it.

| Field            | File name                                | Category             | GB        | Download links                                                    | Alt     | Owner     |
|------------------|------------------------------------------|----------------------|-----------|-------------------------------------------------------------------|---------|-----------|
| model            | krea2_turbo_int8_convrot.safetensors     | diffusion_models     |     13.49 | [MS][k2-0-0] · [HF][k2-0-1]                                       |       7 | base      |
| text_encoder     | qwen3vl_4b_int8_convrot.safetensors      | text_encoders        |      4.86 | [MS][k2-1-0] · [HF][k2-1-1]                                       |       2 | base      |
| vae              | qwen_image_vae.safetensors               | vae                  |      0.25 | [MS1][k2-2-0] · [HF1][k2-2-1] · [MS2][k2-2-2] · [HF2][k2-2-3]     |       0 | base      |

[k2-0-0]: https://modelscope.cn/models/Comfy-Org/Krea-2/resolve/master/diffusion_models/krea2_turbo_int8_convrot.safetensors
[k2-0-1]: https://huggingface.co/models/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_int8_convrot.safetensors
[k2-1-0]: https://modelscope.cn/models/Comfy-Org/Krea-2/resolve/master/text_encoders/qwen3vl_4b_int8_convrot.safetensors
[k2-1-1]: https://huggingface.co/models/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_int8_convrot.safetensors
[k2-2-0]: https://modelscope.cn/models/Comfy-Org/Krea-2/resolve/master/vae/qwen_image_vae.safetensors
[k2-2-1]: https://huggingface.co/models/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors
[k2-2-2]: https://modelscope.cn/models/Comfy-Org/Qwen-Image_ComfyUI/resolve/master/split_files/vae/qwen_image_vae.safetensors
[k2-2-3]: https://huggingface.co/models/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors

Each mark in the `Download links` column is a direct link: `MS` is the ModelScope `resolve/master`
address and `HF` is the Hugging Face `resolve/main` address - the same `resolve_url()` the Model
Hub downloads use (`studio/model_hub.py`), so a click starts the file. When one file sits on
more than one repository of the same source the labels are numbered `MS1` / `MS2`. `Civitai`
points at the model page: the Civitai download endpoint needs a login and an API token, so the
page is where the version gets picked.

## MiniMax H3 video family (`minimax_h3`, base `minimax_h3_base`)

License: Comfy-Org repackaged weights, the license follows the MiniMax source repository. All 15
presets of the family run on this set. `audio_vae` is only needed by the segments that carry audio
(multi-segment synthesis, reference-to-video) and drops into the `vae` category as well.

| Field            | File name                                         | Category             | GB        | Download links                                                    | Alt     | Owner     |
|------------------|---------------------------------------------------|----------------------|-----------|-------------------------------------------------------------------|---------|-----------|
| model            | minimax_h3_fl2va_int8_convrot.safetensors         | diffusion_models     |     34.04 | [MS][h3-0-0] · [HF][h3-0-1]                                       |       7 | base      |
| text_encoder     | qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors      | text_encoders        |     15.69 | [MS1][h3-1-0] · [HF1][h3-1-1] · [MS2][h3-1-2] · [HF2][h3-1-3]     |       2 | base      |
| vae              | minimax_h3_video_vae_int8_convrot.safetensors     | vae                  |      2.81 | [MS1][h3-2-0] · [HF1][h3-2-1] · [MS2][h3-2-2] · [HF2][h3-2-3]     |       1 | base      |
| audio_vae        | minimax_h3_audio_vae_fp32.safetensors             | vae                  |      0.61 | [MS1][h3-3-0] · [HF1][h3-3-1] · [MS2][h3-3-2] · [HF2][h3-3-3]     |       0 | base      |

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

## Qwen Image 2.1 image family (`qwen_image_21`, base `qwen_image_21`)

License: Comfy-Org repackaged weights (license follows the Qwen source repository); the BFS body-swap
and head-swap LoRAs are MIT, and the outpaint LoRA follows the ausboss repository. Beyond the base trio
the family carries 4 preset-owned extras - the `Owner` column names the preset that pulls each of
them in: the `model_patches` file the ControlNet preset runs with, and the body-swap, head-swap and
outpaint LoRAs.

A LoRA row counts as a gap only while that LoRA is in the preset's or the global LoRA list: a LoRA the
configuration does not carry never reaches the workflow, so it never blocks a generation.
`qwen_image_21_controlnet`, `qwen_image_21_identity_swap`, `qwen_image_21_outpaint` and
`qwen_image_21_pose_edit` ship no `extends` - their own manifests carry the base trio (with the
`QwenImage2.1/` subfolder in the configured name), and the overview deduplicates them onto the base set.

| Field            | File name                                                        | Category             | GB       | Download links                                                        | Alt     | Owner                        |
|------------------|------------------------------------------------------------------|----------------------|----------|-----------------------------------------------------------------------|---------|------------------------------|
| model            | qwen_image_2.1_int8_convrot.safetensors                          | diffusion_models     |     7.26 | [MS][q21-0-0] · [HF][q21-0-1]                                         |       3 | base                         |
| text_encoder     | qwen3vl_8b_int8_convrot.safetensors                              | text_encoders        |     9.35 | [MS1][q21-1-0] · [HF1][q21-1-1] · [MS2][q21-1-2] · [HF2][q21-1-3]     |       2 | base                         |
| vae              | qwen_image_2.1_vae_bf16.safetensors                              | vae                  |     0.68 | [MS][q21-2-0] · [HF][q21-2-1]                                         |       0 | base                         |
| loras            | Qwen21-换身bfs_body_swap_v1.0_qwen_2.1.safetensors               | loras                |     0.21 | [HF][q21-3-0] · [Civitai][q21-3-1]                                    |       1 | qwen_image_21_body_swap      |
| patch            | qwen_image_2.1_fun_controlnet_union_int8_convrot.safetensors     | model_patches        |     3.78 | [MS][q21-4-0] · [HF][q21-4-1]                                         |       1 | qwen_image_21_controlnet     |
| loras            | Qwen21-换头bfs_head_v1.1_qwen_2.1.safetensors                    | loras                |     0.21 | [HF][q21-5-0]                                                         |       1 | qwen_image_21_face_swap      |
| loras            | qwen-image-2.1-outpaint-v2.safetensors                           | loras                |     0.16 | [HF][q21-6-0] · [Civitai][q21-6-1]                                    |       0 | qwen_image_21_outpaint       |

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

## Preset → family

`Manifest` says what the preset's own `models.json` declares: a manifest with `extends` lists only its
extras and merges with the base at check time, a manifest without `extends` carries the full set
itself. A preset reading "1 extra" does carry `extends` - the family row whose `Owner` names it is
the extra it adds.

| Preset                                  | cn_name                                          | Family                 | Manifest                                    |
|-----------------------------------------|--------------------------------------------------|------------------------|---------------------------------------------|
| Krea2_subject                           | Krea2 角色分镜设定                               | krea2_image            | extras only (base image_gen)                |
| chinese_ancient_fantasy                 | 中国古风玄幻                                     | krea2_image            | extras only (base image_gen)                |
| chinese_ancient_movie                   | 中国古装影视写真                                 | krea2_image            | extras only (base image_gen)                |
| chinese_classical                       | 中国古风                                         | krea2_image            | extras only (base image_gen)                |
| chinese_wuxia                           | 古风武侠                                         | krea2_image            | extras only (base image_gen)                |
| fashion_photo                           | 时尚摄影                                         | krea2_image            | extras only (base image_gen)                |
| general_enhance                         | 通用增强                                         | krea2_image            | extras only (base image_gen)                |
| image_gen                               | Krea2文生图                                      | krea2_image            | full set, no extends                        |
| image_gen_text_subject                  | Krea2文生角色图                                  | krea2_image            | extras only (base image_gen)                |
| image_to_video                          | 图生视频                                         | minimax_h3             | extras only (base minimax_h3_base)          |
| minimax-h3-r2v                          | H3参考生视频                                     | minimax_h3             | extras only (base minimax_h3_base)          |
| minimax-h3-vdn-r2v                      | H3参考生视频 (VDN)                               | minimax_h3             | extras only (base minimax_h3_base)          |
| minimax_h3_base                         | H3首尾帧或文生视频                               | minimax_h3             | full set, no extends                        |
| minimax_h3_fl2v                         | 首尾帧生视频                                     | minimax_h3             | extras only (base minimax_h3_base)          |
| minimax_h3_full_ref                     | H3全参考生视频                                   | minimax_h3             | extras only (base minimax_h3_base)          |
| minimax_h3_i2v                          | H3 图生视频                                      | minimax_h3             | extras only (base minimax_h3_base)          |
| minimax_h3_image_ref                    | H3图像参考生成视频                               | minimax_h3             | extras only (base minimax_h3_base)          |
| minimax_h3_multiframe                   | H3 连续多段合成                                  | minimax_h3             | extras only (base minimax_h3_base)          |
| minimax_h3_t2v                          | H3 文生视频                                      | minimax_h3             | extras only (base minimax_h3_base)          |
| minimax_h3_vdn_fl2v                     | 首尾帧生视频 (VDN)                               | minimax_h3             | extras only (base minimax_h3_base)          |
| minimax_h3_vdn_i2v                      | H3 图生视频 (VDN)                                | minimax_h3             | extras only (base minimax_h3_base)          |
| minimax_h3_vdn_multiframe               | H3 连续多段合成 (VDN)                            | minimax_h3             | extras only (base minimax_h3_base)          |
| minimax_h3_vdn_t2v                      | H3 文生视频 (VDN)                                | minimax_h3             | extras only (base minimax_h3_base)          |
| my_variants                             | 三变体                                           | krea2_image            | extras only (base image_gen)                |
| nine_grid_storyboard                    | 九宫格分镜图（Qwen Image 2.1）                   | qwen_image_21          | extras only (base qwen_image_21)            |
| pure_desire_aesthetics                  | 纯欲美学                                         | krea2_image            | extras only (base image_gen)                |
| qwen_image_21                           | Qwen Image 2.1 生图/编辑                         | qwen_image_21          | full set, no extends                        |
| qwen_image_21_body_swap                 | Qwen Image 2.1 换身                              | qwen_image_21          | 1 extra                                     |
| qwen_image_21_controlnet                | Qwen Image 2.1 ControlNet                        | qwen_image_21          | base trio + 1 extra                         |
| qwen_image_21_face_swap                 | Qwen Image 2.1 换脸                              | qwen_image_21          | 1 extra                                     |
| qwen_image_21_identity_swap             | Qwen Image 2.1 换脸（LLM 改写·无 LoRA）          | qwen_image_21          | full set, no extends                        |
| qwen_image_21_local_edit                | Qwen Image 2.1 高分局部编辑                      | qwen_image_21          | extras only (base qwen_image_21)            |
| qwen_image_21_outpaint                  | Qwen Image 2.1 扩图                              | qwen_image_21          | base trio + 1 extra                         |
| qwen_image_21_pose_edit                 | Qwen Image 2.1 姿势编辑                          | qwen_image_21          | full set, no extends                        |
| qwen_image_21_watermark_remove          | Qwen Image 2.1 去水印                            | qwen_image_21          | extras only (base qwen_image_21)            |
| realistic_photo                         | 写实摄影                                         | krea2_image            | extras only (base image_gen)                |
| text_to_video                           | WAN文生视频                                      | minimax_h3             | extras only (base minimax_h3_base)          |

## Presets without a manifest

The three translate presets run on the LLM alone and need no local model file. `cosyvoice_voice` needs
weights, but that set does not live in the ComfyUI category tree (see below). All four report
`has_manifest: false` in the self-check, stay out of the **Preset readiness** panel, and a generation
is never blocked on them.

| Preset                         | cn_name                      | Needs models        | Notes                                                 |
|--------------------------------|------------------------------|---------------------|-------------------------------------------------------|
| video_first_last_frames        | 首尾帧补间（WAN 2.2）        | No                  | No `workflow.json`; the skill never loads             |
| video_reference2video          | 参考视频（WAN 2.2）          | No                  | No `workflow.json`; the skill never loads             |
| 3d_pose                        | 3D 摆姿                      | No                  | Pose editor loads no workflow                         |
| cosyvoice_voice                | CosyVoice 音色克隆           | Yes                 | Weights live in the plugin's own path, see below      |

### CosyVoice voice cloning (`cosyvoice_voice`)

- The plugin defines its own weight directory: `<ComfyUI root>/models/cosyvoice/<model_version>/`, and
  the preset's `workflow.json` pins `model_version` to `Fun-CosyVoice3-0.5B`.
- That directory is not a registered ComfyUI category, so the hub's drop-in root does not resolve it
  and readiness cannot read it - which is why this preset ships no `models.json`. The
  `FL_CosyVoice3_ModelLoader` node pulls the whole repository itself: `download_source` picks
  ModelScope or Hugging Face, a first source that fails over falls back to the other, and both hosts
  carry `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` (the same files on both, Apache-2.0, no gating, no token).
- Completing the set through the hub file by file needs it to land under
  `models/cosyvoice/Fun-CosyVoice3-0.5B/`: the hub's sub-folder follows the repository's own relative
  path with no family prefix, so the flat files need `Fun-CosyVoice3-0.5B` as their sub-folder and the
  `CosyVoice-BlankEN/` layer needs `Fun-CosyVoice3-0.5B/CosyVoice-BlankEN` before the plugin reads them.
- The minimal bundle ships none of these weights (`tools/minimal_plugins.json` says so on its
  `comfyui_fl-cosyvoice3` entry); the plugin's python dependencies (`modelscope`, `transformers`,
  `onnxruntime`, `hyperpyyaml` and the rest) are checked by the packaging self-check via `import_smoke`.

Required files (relative to the model directory, about 5.4 GB in total; the KB-sized configs read 0.00):

| File (relative to the model dir)          | GB        | What reads it                       | Download links                   |
|-------------------------------------------|-----------|-------------------------------------|----------------------------------|
| cosyvoice3.yaml                           |      0.00 | hyper-params entry                  | [HF][cv-0-hf] · [MS][cv-0-ms]    |
| llm.pt                                    |      2.02 | text → speech tokens                | [HF][cv-1-hf] · [MS][cv-1-ms]    |
| flow.pt                                   |      1.33 | tokens → acoustics                  | [HF][cv-2-hf] · [MS][cv-2-ms]    |
| hift.pt                                   |      0.08 | vocoder (acoustics → waveform)      | [HF][cv-3-hf] · [MS][cv-3-ms]    |
| campplus.onnx                             |      0.03 | speaker embedding of the reference  | [HF][cv-4-hf] · [MS][cv-4-ms]    |
| speech_tokenizer_v3.onnx                  |      0.97 | reference audio → speech tokens     | [HF][cv-5-hf] · [MS][cv-5-ms]    |
| CosyVoice-BlankEN/model.safetensors       |      0.99 | Qwen2 base weights of the LLM       | [HF][cv-6-hf] · [MS][cv-6-ms]    |
| CosyVoice-BlankEN/vocab.json              |      0.00 | tokenizer vocabulary                | [HF][cv-7-hf] · [MS][cv-7-ms]    |
| CosyVoice-BlankEN/merges.txt              |      0.00 | tokenizer merge table               | [HF][cv-8-hf] · [MS][cv-8-ms]    |
| CosyVoice-BlankEN/tokenizer_config.json   |      0.00 | tokenizer config                    | [HF][cv-9-hf] · [MS][cv-9-ms]    |
| CosyVoice-BlankEN/config.json             |      0.00 | base model config                   | [HF][cv-10-hf] · [MS][cv-10-ms]  |
| CosyVoice-BlankEN/generation_config.json  |      0.00 | sampling config                     | [HF][cv-11-hf] · [MS][cv-11-ms]  |
| CosyVoice-BlankEN/vocab-config.json       |      0.00 | tokenizer + config copies           | with the folder                  |

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

The links point at the same repository on both hosts: the [Hugging Face page](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)
and its [ModelScope twin](https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512). `HF` is
the `resolve/main` address and `MS` the `resolve/master` address - the same URLs the
`FL_CosyVoice3_ModelLoader` node hits through `download_source`: Apache-2.0, no login, no token. The
node pulls the whole repository itself, so the links above are only for filling a partial set by hand.
`CosyVoice-BlankEN/vocab-config.json` comes with that folder - the repository has no file of that name,
so it gets no link.

Three more repository files are not read by this skill and need no download: `llm.rl.pt` (2.02 GB, the
official RL weights - loading goes through `llm.pt`), `speech_tokenizer_v3.batch.onnx` (0.97 GB, batch
inference) and `flow.decoder.estimator.fp32.onnx` (1.33 GB, the TensorRT decode path). `spk2info.pt` is
written by the machine the first time a speaker is saved, so it is on no download list.

## Related

- Manifest schema, readiness rules and download plans: [model-hub.md](model-hub.md)
- The pre-generation check and its download entry points: [image-gen.md](image-gen.md)
- Route inventory (the `skill_models.py` section): [api-routes.md](api-routes.md)
- The preset skills themselves: [skills.md](skills.md)
