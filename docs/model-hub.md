# 模型库（Model Hub）

顶栏 🅝 → **📥 模型库**：在 Comfy-Org 专区搜索并下载模型，双源可选
（ModelScope / Hugging Face），下载直接落进 ComfyUI 的模型目录。

## 流程

1. 选源 → 拉取 Comfy-Org 仓库列表（按策展注册表分组显示，组内顺序 = ModelScope
   综合排序；可搜索，⟳ 跳过缓存重拉）。
2. 选仓库 → 列出仓库内模型文件（自动过滤非模型文件），每条显示
   `文件名 [落盘类别] 大小`，磁盘已有同名文件的标 `✓ 已存在 (所在子目录)`。
3. 选文件 → 自动带出落盘类别；**子目录为下拉列表**，取自该类别目录下已存在的子目录
   （默认自动探查：仓库同名 / 仓库名前缀的已有目录，否则根目录），可选「＋ 新建子目录…」现填新名。
   点已存在的文件时自动选中该文件实际所在的子目录（同模型同类别的文件通常同目录），优先于探查默认。
   预览 `→ models/<类别>/<子目录>/<文件名>`（LLM 类别预览含强制的 `<仓库名>/` 段；
   已存在位置就是该强制段时不重复叠加）。
4. ⬇ 下载 → 进度条 + 百分比 / 已下载 / 速度，可「取消」；完成后提示并刷新文件清单。

## 落盘类别

- 仓库内 `split_files/<类别>/...` 前缀直接映射 ComfyUI 模型类别
  （`transformer` / `unet` → `diffusion_models`，`clip` → `text_encoders` 等）。
- 无该前缀时按文件名关键词兜底（`vae` / `lora` / `esrgan` / `clip` / `t5` / `qwen` …），
  都不匹配则落 `diffusion_models`。
- `.gguf` 落 **LLM 类别**：`models/<LLM 子目录>/<仓库名>/`，与内置本地推理（llama-cpp）共用同一目录。
- 落盘根目录取 `folder_paths` 注册目录（含 `extra_model_paths.yaml` 指向的外部目录）：
  类别同名者优先（`unet` / `diffusion_models` 同组时选对），其次第一个已存在的。
  `✓ 已存在` 标记扫描该类别的**全部**注册目录及其子目录。

## 断点续传

下载写 `<文件名>.part`，同目录附 `<文件名>.part.meta.json` 记录源 / 仓库 / 路径 / 总大小 / 已下载字节：

- 「取消」保留断点，状态显示「已取消（断点保留）」；再次下载同一文件按 HTTP Range 续传。
- `.part` 与本次请求的源 / 仓库 / 文件不一致时报错并提示删除 `.part`，不会静默拼接坏文件。
- 下载完成后 `.part` 改名为正式文件并删除元数据。
- 单任务：同一时间只有一个下载在进行，重复发起返回「已有下载任务进行中」。

## 设置（⚙）

| 项 | 说明 |
|----|------|
| 默认下载源 | `modelscope` / `huggingface` |
| HF 端点 | 镜像站根地址（只接受 http/https 绝对地址，非法值回落官方端点） |
| HF Token | 受限仓库必需 |
| ModelScope Token | 可选，仅受限仓库下载需要（列表与搜索匿名可用） |
| LLM 子目录 | `models/` 下的目录名，GGUF 落此处（默认 `LLM`） |
| 下载总超时 / 读超时 | 秒，最小 10 |

设置存 `configs/model_hub.json`。子目录与文件名在落盘前一律清洗（去目录、去非法字符、拒绝 `..`），
落盘路径必须位于模型目录内。

**ModelScope Token 可留空**：组织列表与跨组织搜索都走站点同款 `dolphin/models` 接口
（综合排序 `SortBy=Default`，匿名可用）；接口不可用时，缺失仓库由 Hugging Face 结果 +
注册表逐仓库探测存在性补齐（探测结果缓存 1 天）。Token 仅在下发受限仓库文件时才需要，
填错 Token 不影响列表与搜索。

## 策展注册表

`configs/model_registry.json` 维护分组与推荐组合（只存仓库名与说明，不存元数据），
用于仓库列表分组显示与补齐。分组内仓库按 ModelScope 组织页的**综合排序**排列
（`SortBy=Default` 的返回顺序），ModelScope 未收录的仓库排在本组末尾。

## 预设模型清单（models.json）

`skills/presets/<id>/models.json` 声明一个预设要用的模型文件，供模型库的「预设就绪」面板（见下）与下载计划使用
（路由见 [api-routes.md](api-routes.md)）。清单只描述文件层：不检查 ComfyUI 版本、显存、队列，也不预测生成成败。

- 顶层：`family` / `label` / `kind`（`image` / `video`）/ `license` / `notes`（显示用的注意事项）。
  `extends` 指向同族基座预设，预设自己的清单只写追加项（LoRA 等）；extends 只解一层，环到此为止。
- `files[]`：`field`（生图 / 生视频配置里的键，`loras` 表示 LoRA 项）、`filename`（预设口径的相对名，含子目录）、
  `category`（落盘类别）、`gb`、`label`、`optional`（可选项，不计入缺失）、`alt`（同族变体名，本机落到别的名字时靠它认）、
  `sources[]`（`source` = `modelscope` / `huggingface` / `civitai` + `repo` + `path`，`gated` 标 HF 上要先申请授权的条目；
  `sources[0]` 为推荐源）。
- 就位判定跟生成侧一致：配置写死了模型名就按那个相对名精确查；名留空才按推荐名 + `alt` 在类别整棵树里认
  （大小写与斜杠方向不敏感）。`loras` 项只在该 LoRA 出现在预设 / 全局 LoRA 列表里才算数。
- 下载计划按模型库当前源出条目，条目 `payload` 就是 `/neo_model_hub/download` 的入参；该源没有这条文件时条目
  标 `not_on_source` 并给出另一源，不自动换源；出处非法标 `bad_source`。C 站出处必须是 `/api/download/models/<id>?…` 端点。
- 不吃本地模型文件的预设不带清单：`translate` / `translate_to_chinese` / `translate_to_english` / `cosyvoice_voice`，
  自检对它们返回 `has_manifest: false`。清单缺失或坏 JSON 同样按无清单降级，不报错。

## 预设就绪面板（模型库 → 预设就绪）

模型库顶栏的「预设就绪」展开就绪面板，把上面的就位检查与下载计划接成一条可点的路径：

1. 展开时读 `GET /neo_skill_models/all`：按族系列出预设数、文件数、总体积与「缺 N 项 · X GB」徽标，
   没有缺项的族系标「已就绪」；顶部计数是「P 个预设 · F 个族系 · 需要补模型的族系 B 个」。
2. 点族系里的预设名 → `POST /neo_skill_models/plan`（带模型库当前源与「计划含可选文件」勾选）出计划：
   每条显示 `名称 · 类别/子目录/落盘名` 与源、体积，条目的 `payload` 就是发给 `/neo_model_hub/download` 的入参。
   当前源没有这条文件时按钮禁用并写出另一源；出处非法时写明原因；源要 HF Token / C 站 KEY 时在计划头部说去哪填。
3. 单条「下载」或「全部下载」把计划逐条喂进模型库的下载位（同一时间只有一个下载，上一条完成接下一条），
   进度条与「取消」沿用下载区；取消即断队列，断点留在当前文件。
4. 计划下完自动重读就位总览与该预设的计划：刚落盘的文件从缺项里消失，同族预设一起变回「已就绪」。

## 与生成侧联动（缺失模型的下载入口）

就位检查的结果不止就绪面板一处，生图侧的三个入口读的是同一份清单（前端 `skillModelCheck` / `manifestGap` /
`manifestHubTarget`，`web/image-gen.js`）：

- **生成前预检**：带清单的预设在提交 `/neo_image_gen/generate` 前先读 `GET /neo_skill_models/check`，
  有「要下又没落盘」的文件就不进队列，报错写清缺哪些文件与体积，通知给「去模型库」→
  `openModelHub({ readySkill })` 直接展开就绪面板并出该预设的下载计划。详见 [image-gen.md](image-gen.md)。
- **生图设置的模型行**：清单缺哪个字段就在哪一行出「⬇ 模型库」，点击按清单上的源 / 仓库 / 落盘类别 /
  文件名预选（`openModelHub({ source, repo, category, query })`），提示里写明体积与 gated 的授权前置；
  已就位的行不给，无清单的预设也不给（只保留下拉里的「(缺失)」标记）。
- **技能修复弹窗**：缺模型的条目按清单项精确打开模型库（提示写「源 · 仓库」），自建技能没有清单时
  回落到失效文件名 + 字段类别（`openModelHub({ query, category })`）。

---

后端 `model_hub.py`（路由见 [api-routes.md](api-routes.md)），前端 `web/model-hub.js` + `web/model-hub.css`。
