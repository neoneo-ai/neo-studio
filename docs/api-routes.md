# 后端 API 路由

路由通过各模块自带的 `web.RouteTableDef` 注册（`gallery.py` / `bookmark.py` / `gallery_lora.py` /
`gallery_oss.py`），由 `__init__.py` 统一挂进 `PromptServer.instance.routes`；总入口见
[../Developer.md](../Developer.md)。
下表只列路由与用途；请求体字段与返回结构以源码为准。


## gallery.py — `/neo_gallery/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_gallery/list` | 目录内容列表（预设 / 自定义 / 系统聚合） |
| GET | `/neo_gallery/css` | 内置素材 CSS 资源 |
| GET | `/neo_gallery/placeholder.png` | 占位图 |
| GET | `/neo_gallery/subdirs` | 子目录列表 |
| GET | `/neo_gallery/thumbnail` | 缩略图（带缓存生成） |
| GET | `/neo_gallery/video` | 视频流 |
| GET | `/neo_gallery/media_meta` | 媒体元数据 |
| GET | `/neo_gallery/image` | 媒体文件 |
| GET | `/neo_gallery/txt` | 副文件 `.txt` 全文（列表里的 `txt_content` 是预览） |
| POST | `/neo_gallery/dir_cover_images` | 目录封面图 |
| POST | `/neo_gallery/save_settings` | 保存素材设置（自定义目录等） |
| GET | `/neo_gallery/get_settings` | 读取素材设置 |
| POST | `/neo_gallery/upload_txt` | 上传配套 `.txt` 描述 |
| POST | `/neo_gallery/copy_to_input` | 复制素材到 `input/` |
| POST | `/neo_gallery/delete` | 删除素材（presets 只读保护） |
| POST | `/neo_gallery/clear_thumbnails` | 清空缩略图缓存 |

- `dir_name=Grid|Character` 走主目录（本地生成结果 + 只读远端预设），首页不注入这两张卡。

## lora_tag.py — LoRA 打标

仅可写来源（Input / 用户自定义目录）的叶子图片目录可用；HEIC / HEIF 转换依赖可选的 `pillow-heif`。

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_gallery/tag_preflight` | 目录校验 + 图片数 + 建议触发词 |
| POST | `/neo_gallery/tag_dir` | 批量打标（SSE 进度，可选先标准化目录） |

## gallery_lora.py — Civitai LORA

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_gallery/lora_dirs` | `models/loras` 第一级子目录列表 |
| POST | `/neo_gallery/civitai_test` | Civitai 连通性 / API KEY 探测 |
| GET | `/neo_gallery/lora_cache_status` | LORA 缓存队列状态 |
| POST | `/neo_gallery/lora_retry_failed` | 重试失败项 |
| POST | `/neo_gallery/lora_refresh_dir` | 重读目录内 LORA 的 safetensors 头部元数据（本地，不重新下载示例图） |

## gallery_oss.py — 云端预设

云端预设索引是分层的：`index.json` 是 v2 主索引，每个目录只有一条 `count` / `index` / `rev` / `covers`，
目录的完整 items 在 `index` 声明的 `<dir>/index.json` 里，进目录才下载。目录索引缓存在
`gallery/oss_cache/<dir>/_index.json`，StoryBoard / CharacterSheet 预设缓存在各自主目录的
`presets/<dir>/_index.json`；主索引的 `rev` 变了才重拉。顶层可选的 `categories` 把远端目录归到
StoryBoard / CharacterSheet 主目录的只读预设区；未归类的目录仍留在旧版 **Cloud Presets**
（条目里带 `items` 的旧版整包索引继续按老行为工作，计数与封面从 items 现算）。

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/neo_gallery/sync_oss` | 同步 OSS 预设索引 |
| GET | `/neo_gallery/oss_status` | OSS 同步状态 |

## recipes.py — `/rs_recipes/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/rs_recipes/list` | 配方列表（custom / presets，按最近修改倒序） |
| POST | `/rs_recipes/load` | 读取单个配方 |
| POST | `/rs_recipes/save` | 保存配方（含 assets 收集） |
| POST | `/rs_recipes/append_results` | 追加示例结果（含工作流备份） |
| POST | `/rs_recipes/add_results` | 记录产物路径到 `results`（不复制文件） |
| POST | `/rs_recipes/delete_result` | 摘掉结果并删除 output 里的真实文件 |
| POST | `/rs_recipes/delete_sample` | 删除示例结果 |
| POST | `/rs_recipes/delete` | 删除配方（仅 custom） |
| POST | `/rs_recipes/copy` | 复制为新 custom 副本（自动改名） |
| GET | `/rs_recipes/export` | 导出配方 zip（包内附 Readme.txt） |
| POST | `/rs_recipes/import` | 导入配方 zip（重名自动改名） |
| GET | `/rs_recipes/asset` | 配方资源文件 |
| GET | `/rs_recipes/thumbnail` | 封面 / 网格缩略图（带缓存） |
| GET | `/rs_recipes/workflow` | 示例对应的工作流快照 |
| POST | `/rs_recipes/send_to_workflow` | 资源复制进 `input/` 供一键还原 |
| GET | `/rs_recipes/director_spec` | 导演配方 `{shared, segments}` 与身份参考图 |
| POST | `/rs_recipes/director_generate_segments` | 按主题 / 脚本生成分段 JSON（智能体 / MCP 路径，编辑器 UI 不调用） |
| POST | `/rs_recipes/director_optimize_prompts` | 单段提示词按 H3 格式重写 |
| POST | `/rs_recipes/grid_split` | 宫格分镜图拆分为各段首帧 |
| POST | `/rs_recipes/director_describe_panel` | 逐格描述生成单段成品提示词 |
| POST | `/rs_recipes/director_modify_segment` | 按修改指令重写段提示词（SSE） |

## h3_video_director.py / h3_segment.py / h3_assemble.py / simple_video.py — `/neo_video_gen/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_video_gen/director_progress` | director 运行进度（段 / 步） |
| POST | `/neo_video_gen/director/cancel` | 取消进行中的 director 任务 |
| POST | `/neo_video_gen/run_segment` | 单段生成 / 重生成入队 |
| GET | `/neo_video_gen/run_segment/{task_id}` | 单段任务快照 |
| POST | `/neo_video_gen/run_segment/{task_id}/cancel` | 取消单段任务 |
| POST | `/neo_video_gen/assemble_segments` | 把勾选的段拼回完整成片 |
| GET | `/neo_video_gen/assemble_segments/{task_id}` | 拼接任务快照 |
| POST | `/neo_video_gen/assemble_segments/{task_id}/cancel` | 取消拼接 |
| POST | `/neo_video_gen/simple` | 简单视频生成入队（技能模板 + SaveVideo，落 `output/NeoSimple/`） |
| GET | `/neo_video_gen/simple/{task_id}` | 简单视频任务快照 |
| POST | `/neo_video_gen/simple/{task_id}/cancel` | 取消简单视频任务 |
| GET | `/neo_video_gen/settings` | 读取「生视频模型」设置 |
| POST | `/neo_video_gen/settings` | 保存「生视频模型」设置 |
| GET | `/neo_video_gen/models` | 扫描 H3 模型并给出自动挑选结果 |

- `run_segment` 只做校验 + 组装 prompt + 入队，真正生成跑在 ComfyUI 执行器里（`NeoH3SegmentRun` 节点）：
  显存、进度、取消由执行器负责，插件只轮询任务快照。产物写 `output/neo_director_regen/` 并记进配方 `results`。
- 锚点来源由 `film` 指定（空 = 最新成片），**分辨率沿用该成片**（同尺寸才能无缝拼回）。
  段序号越界 / 未知锚点 / 成片帧数与复算不一致 / 预设配方一律 400。
- `assemble_segments` 是单段生成的后续步骤：只把勾选的段换成单段产物，其余段沿用原成片对应帧与音频。
  它只做解码 → 拼接 → 再编码，不用模型、不占执行队列，在后台线程跑，取消为协作式。
  新成片写 `output/neo_director_merge/`，记进 `results` 时带逐段真实帧数 `layout`，
  后续单段重生成按它定位段边界。
- `simple_video.py` 是「一句话 + 首帧出一段视频」的独立入口（Studio `#/video` 页，与导演多段流程互不影响）：
  复用 `resolve_video_params` + `render_template` 把请求解析成技能模板参数，在末端 VIDEO 上接一个 `SaveVideo`
  落 `output/NeoSimple/`，不建配方、不进配方 `results`；生成走执行队列，产物只播放。首帧缺省时 `references` 为空
  （t2v 路径），时长以秒进来按 H3 帧网格换算成模板 `length`。
- 采样期间的实时预览走插件自己的 taeh3 通道（WS 事件 `rs.h3.preview`），按 `node_id` 推回对应节点面板。

## studio.py — `/neo_studio/*`

Neo Studio 独立页面（`web/studio/index.html`）的后端。素材 / 生图 / 配方 / 单段直接复用已有路由，
这里只补页面短路径、整片生成与版本信息：

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo-studio` | Studio 独立页面 |
| POST | `/neo_studio/director/generate` | 整片生成入队（可只跑勾选的段） |
| GET | `/neo_studio/director/{task_id}` | 整片任务快照 |
| POST | `/neo_studio/director/{task_id}/cancel` | 取消整片任务 |
| GET | `/neo_studio/queue` | 顶栏队列面板的聚合行：六表按提交时间倒序、条数封顶；行带 `kind` `label` `status` `progress` `created` `updated` `count` `result` `page`，行缩略图按 `result` 取 `/neo_gallery/thumbnail` |
| GET | `/neo_studio/version` | 插件 / ComfyUI 版本与导演配方列表，附「设置 → 关于」的路径行 `data_root` / `comfy_local`（`remote` 留空，远程地址只有桌面端知道） |
| GET | `/neo_studio/log` | ComfyUI 控制台日志（`app.logger` 环形缓冲 300 条），Studio「设置 → 日志」轮询 |
| GET | `/neo_studio/mem_stats` | 驱动级显存占用（含全部进程）：顶栏队列面板展开时每 3 秒取一次读数 |
| POST | `/neo_studio/clear_memory` | 卸载模型并清理显存缓存（顶栏队列面板的「清理」钮） |

- `only_segments` 为只读时间轴上勾选的段号文本（1 基、逗号分隔，空 = 整片）；勾选是运行期临时状态，不写进配方。
- 任务跟踪与 `run_segment` 同一套做法：入队 + 轮询快照 + WS 事件按变化推送。

## pose.py — `/neo-pose` 与摆姿包静态前缀

「3D 摆姿」页后端：伺服 3d-pose-art 的构建产物 + 与页面之间的桥接口。页面与桥接口只做文件读写，桌面端
离线服务同样答这些路由；桥消息与装包方式见 [studio-pose.md](studio-pose.md)。

| 方法   | 路由                        | 说明                                                                         |
|--------|-----------------------------|------------------------------------------------------------------------------|
| GET    | `/neo-pose`                 | 摆姿页短路径：两级落点里有入口页就 302 到 `/pose-dist/index.html`，都没有回 404 与安装提示 |
| GET    | `/pose-dist/{path}`         | 摆姿包子资源，由 iframe 内部直接加载；逐请求按 `<数据根>/pose/dist` → `studio/pose_dist` 两级找（两端各自直接注册，不进能力归属表） |
| GET    | `/models/{path}`            | 产物里写死的根路径前缀（道具注册表 `props/index.json`、素体与道具的 `<file>.glb`）；与 `/pose-dist/{path}` 同一套两级查找、同一个根内校验 |
| GET    | `/neo_pose/status`          | 装没装、生效那一级（`dist_source`）、随包清单与在着的 GLB、能力位、已存场景与姿态、桥消息名单、缺包提示 |
| GET    | `/neo_pose/scenes`          | 场景列表（`name` / `size` / `mtime`）                                        |
| GET    | `/neo_pose/scene?name=`     | 读一份场景                                                                   |
| POST   | `/neo_pose/scene`           | 写场景（`.tmp` + replace 原子落盘）                                          |
| GET    | `/neo_pose/presets`         | 姿势库列表（`name` / `size` / `mtime`，按修改时间倒序）                      |
| GET    | `/neo_pose/preset?name=`    | 读一份姿态（PoseFile v1 原样交回）                                           |
| POST   | `/neo_pose/preset`          | 写姿态 `{name, pose}`（`.tmp` + replace 原子落盘）                           |
| POST   | `/neo_pose/preset/delete`   | 删一份姿态（单条，名字过同一套白名单）                                       |
| POST   | `/neo_pose/import_image`    | 把素材库的一张图交进页面                                                     |
| POST   | `/neo_pose/import_model`    | 自备素体 GLB 写进 `<数据根>/pose/dist/models/<key>.glb`，回 `{key, name, url, size, from}` |
| GET    | `/neo_pose/refs/{name}`     | 伺服交进页面的那张参考图                                                     |
| POST   | `/neo_pose/export_image`    | 页面画布导出落进 `output/Pose`，回 `{filename, subfolder, size}`             |
| POST   | `/neo_pose/export_set`      | ControlNet 图组落进 `output/Pose`（≤12 张），回 `{saved, count}`             |

前缀本身（`/pose-dist/`，空路径）落到入口页，地址栏直接敲前缀也要进页面。产物里的资源路径是构建时写死的
两条根路径：页面与脚本走 `/pose-dist/...`，道具注册表与 GLB 走 `/models/props/index.json`、
`/models/<file>.glb`。两条前缀是同一条静态伺服挂的两个名字 —— 同一个两级落点、同一个根内校验，出根的
请求 400、缺文件 404，绝不回一份空注册表让页面把「加具失败」当成用户的问题。`import_model` 收
`{key, data}`（base64）或 `{key, filename, subfolder, type}`（素材库里的文件），key 过场景名那套白名单、
体积 ≤ 35MB、文件头须为 `glTF`，四道校验都在写盘之前（35MB 是 base64 进 JSON 后还装得进 48MB
请求体上限的那一档，桌面端服务的请求体上限也按这条抬到接口之上，不会先被 transport 挡成 413）。桥的页面侧实现是
3d-pose-art 的 `src/neoBridge.js`，口径见 [studio-pose.md](studio-pose.md)。

## workflow.py — `/neo_nodes/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/neo_nodes/repair` | 工作流模型路径修复 |
| GET | `/neo_nodes/repair_mappings` | 读取已保存的修复映射 |
| DELETE | `/neo_nodes/repair_mappings` | 删除修复映射 |

修复细节见 [workflow-repair.md](workflow-repair.md)。

## image_gen.py / image_gen_files.py — `/neo_image_gen/*`

设置与技能配置（`settings` / `models` / `input_images` / `skill_config` / `skill_workflow` /
`save_workflow_skill` / `update_workflow_skill*` / `copy_skill_files` / `save_combo_skill`）在
`image_gen_files.py`，只读文件目录，桌面端离线可用；入队与任务跟踪（`generate` / `status` /
`tasks` / `cancel` / `skill_dims`）在 `image_gen.py`，需要 ComfyUI 运行时。

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_image_gen/settings` | 读取内置生图默认参数 |
| POST | `/neo_image_gen/settings` | 保存默认参数 |
| GET | `/neo_image_gen/models` | 扫描模型目录并给出自动挑选结果 |
| POST | `/neo_image_gen/generate` | 生图入队（可带单次覆盖参数 / 扩图），响应带 `skill_id`（出这一发用的技能） |
| GET | `/neo_image_gen/status/{task_id}` | 任务快照（进度 / 图片 / 实时预览） |
| GET | `/neo_image_gen/tasks` | 最近任务列表（最多 32 条），每条带 `skill_id` |
| POST | `/neo_image_gen/cancel/{task_id}` | 出队并在运行中时中断 |
| GET | `/neo_image_gen/skill_dims` | 技能预设宽高与步数（填默认值用） |
| GET | `/neo_image_gen/skill_config` | 读取技能生图 / 生视频设置 |
| POST | `/neo_image_gen/skill_config` | 写技能设置（预设写本地覆盖文件） |
| GET | `/neo_image_gen/skill_workflow` | 技能 `workflow.json` 模板（只读） |
| POST | `/neo_image_gen/plan_workflow_skill` | 导出预览：列出画布里可替换成占位符的 widget 候选 |
| POST | `/neo_image_gen/save_workflow_skill` | 画布工作流导出为新技能（勾选的候选写进模板） |
| POST | `/neo_image_gen/update_workflow_skill` | 把画布工作流回写为技能模板 |
| POST | `/neo_image_gen/save_combo_skill` | 主模型 + LoRA 组合存为新技能 |

- `generate` 的 body 可带单次覆盖 `model` / `text_encoder` / `vae` / `loras`（空 = 跟随全局设置）；
  扩图请求带 `outpaint` 字段，见 [image-gen.md](image-gen.md)。
- 任务状态不走 HTTP 轮询：按变化经 WS 事件 `rs.image_gen.status` 推送任务快照，
  `/status` 仅作订阅前首拉与断线重连补漏，取消时后端也主动推送 `cancelled` 快照。

## agent.py — `/neo_agent/*`

右栏「智能体」的后端代理循环。工具调用一律经进程内 MCP 客户端逐行走 `mcp_server.serve` 的 JSON-RPC，
工具表就是 MCP 全集（出片链路在内），面板自己不直接调 handler。

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/neo_agent/run` | 智能体一轮对话，SSE 时间线；body `{text, mode, images, context, preview_side, resume, skill_id}`（`mode` 只认 `plan` / `act`，缺省 `act`；`skill_id` 是输入框 `@` 点名的技能，只认 `^[A-Za-z0-9_.\-]{1,64}$` 的形态，进系统提示词排在焦点链与用户偏好之后，认不认得到由循环里那次 `list_skills` 定；`images` 是输入框附件图，按图片源口径给，最多 6 张；`context` 是界面当前状态，非 dict 整块丢掉；`preview_side` 是这一轮要的采样预览最长边（像素），非数按右栏卡片那档 384，绘画页中间舞台挂着时要 1024，0 与负数是关掉采样预览（后端不读预览表，SSE 不带 `preview` 载荷）；`resume` 带旧会话的 `run_id` 时这一轮接在那条会话后面跑，那条还在跑与查不到都在首帧前 `[ERROR]` 收场），首帧 `run`（带 `run_id`，取消 / 暂停 / 继续整条循环与回答问句都要用），帧 `plan` / `tool_call` / `status` / `tool_result` / `ask` / `paused` / `resumed` / `content`，收尾 `[ERROR]` / `[DONE]` |
| POST | `/neo_agent/answer` | 回答 `ask` 帧：body `{run_id, ask_id, text}`，把用户选的方向交回正等在 `ask_user` 上的循环；`run_id` / `ask_id` 只收 `run` / `ask` 帧发过的形态，运行收场 404、问句已收场 404 |
| POST | `/neo_agent/cancel` | 取消：带 `run_id` 停整条智能体循环并掐掉在跑的任务（`run_id` 只收 `run` 帧发过的形态，查不到 404）；带 `task_id` 只掐那一个任务（走 MCP `cancel_task`，图片 / 整片 / 单段 / 拼接四类由协议自己找路由），`task_id` 只收 UUID 形态 |
| POST | `/neo_agent/pause` | 暂停：body `{run_id}`（校验同 cancel），让循环停在下一个轮次 / 轮询边界，SSE 开着不收尾；在飞的 ComfyUI 任务没有暂停态，边界上掐掉它并交回 `cancelled`，恢复后不自动重发 |
| POST | `/neo_agent/resume` | 继续：body `{run_id}`（校验同 cancel），放开正等在暂停检查点上的循环；没在暂停时是空操作，重复点「继续」不会把运行推过检查点 |
| GET | `/neo_agent/sessions` | 「🗂 历史」列表：新的在前，只回摘要（时间 / 模式 / 终态 / 首句 / 工具数 / 产物数 / `reason` 收场原因 / `focus_skill`）；读时顺带收掉落盘超 7 天的会话 |
| GET | `/neo_agent/session` | 按 `run_id`（查询串，只收 `run` 帧发过的形态）读回一条会话：`frames` 逐帧时间线、续聊要用的 `messages` 与 `focus`（焦点链）；形态不对 400、没有 404 |
| POST | `/neo_agent/session/delete` | 删一条会话：body `{run_id}`（校验同上），只删那一个文件，没有 404 |
| POST | `/neo_agent/session/delete_all` | 「清空对话」连着清历史：只删会话目录里按名字认出来的文件，目录与别的文件不碰 |

- 一轮对话全程由 LLM 规划并调工具，轮次上限按本轮点名的技能给：默认 12，`@` 点名没有模板的正文型技能
  那一轮放宽到 20；右栏的 `@` 能点名技能（带 `workflow.json` 的直接当 `skill_id`，正文型的走
  `generate_prompt`），没点名时由 LLM 自己查 `list_skills` 定，`context` 就是它判断「围绕哪个配方、
  哪种绘画模式干活」的唯一依据。一次运行只取一次点名技能的摘要（`/rs_prompts/load_skill`：类别 /
  `description` / 有无模板 / 引用文件清单），技能正文不进右栏的上下文，取不到时（技能被删）交回只报 id 的那一份。
- `context` 只当事实进系统提示词，不当指令：`page` 只认 `gallery` / `director` / `paint` / `skills` /
  `settings`，`paint_mode` 只在 `page=paint` 时生效且只认 `text` / `edit`，配方名与素材库目录按 120 字裁剪，
  `segments` 只取整数；表外的值整行丢掉。
- `mode=plan` 是计划模式：`generate_image` / `director_run` / `segment_run` / `assemble_run` /
  `director_save` / `director_copy` / `cancel_task` 不进 LLM 的工具表，硬调也拒回错误；
  查询类工具照旧可用。
- `ask_user` 是右栏伪工具，不在 MCP 注册表里：循环发 `ask` 帧（带 `ask_id`、问题与 2-5 个选项）
  后挂在等回答上，`/neo_agent/answer` 交回答案，30 分钟无回应就按「用户没回应」继续；
  按 `run_id` 取消时挂着的问句一并交收。
- 暂停与停止都只在轮次与工具边界生效：LLM 的单轮请求在飞时掐不掉，回来后的第一个边界收场。
  暂停是发 `paused` 帧后挂在检查点上等 `/neo_agent/resume`，30 分钟无「继续」按「暂停超时」收场；
  取消会同时放开 `resume`，正挂在检查点上的循环也退得出来，时间线补一行「已取消」。
- 附件图只进首个 user 消息（多模态）。粘贴与点选的图按 `kind:"data"`
  的 data URI 给；从素材库卡片拖入的图先经 `/neo_gallery/copy_to_input` 落进 `input/`，再按
  `kind:"input"` 的文件名给。右栏只收后端解得动的图片后缀，素材库里的视频 / 音频卡片在拖入这一步就挡掉。
- `generate_image` / `director_run` / `segment_run` / `assemble_run` 只回 `task_id`，循环里轮询 `task_status` 到终态，
  采样步数与整片段号经 `status` 帧发出去；等待上限单图 600 秒、整片 2400 秒。
- 生成中的 `status` 帧可带 `preview`（`{frames:[dataURL…], fps, w, h, step}`）：出片按请求体里的 `preview_side`
  选档（右栏卡片 384、中间舞台 1024），生图是进度预览捕获的那一张，只在载荷推进时挂一次，右栏工具卡与中间舞台
  用它播该步动画。这一份只进界面——会话落盘与 `tool_result` 文本都不带它，LLM 永远看不到帧字节。
- `tool_result` 帧带 `media`：出图的 `images` 逐条成 `{kind:"image", url, title}`，出片三类的成片 `filename` 补成一条
  `{kind:"video", url}` 的 `/view` 地址（单段与拼接的快照只给文件名，子目录按生成模块的产物目录补）。右栏的产物
  缩略图与产物链接只认这一份列表。
- `director_save` / `director_copy` 的结果 JSON 带 `name`：右栏认出来就广播导演编辑器那条保存事件
  （窗口事件 `neo-director-recipe-saved`，`{name, created:true}`），导演页配方弹窗随之刷新并选中这份新配方，
  点开即进编辑器改分段与参数；重放旧会话的那一路不广播，读一次历史不改动界面。
- 工具回指的 ComfyUI 取本次请求自己的来源，请求体里没有地址可注入。
- 一次运行落一个会话文件在数据根的 `agent_sessions/`（`<创建时间>-<run_id>.json`，原子写；最多 100 条、
  单文件 400 KB）：`frames` 是时间线逐帧，供前端只读重放；`messages` 是续聊要回填 LLM 的原文，不含 system、
  不含图字节（附件图只留一句引用），单条按 4000 字裁剪、整份最多 40 条，超上限时从最旧消息丢起、再超就只留
  最终回答。终态记 `succeeded` / `failed` / `cancelled` / `interrupted`（断流收尾），续聊记 `resume_of`。
- 会话文件带 `focus`（焦点链）：最近一次成功生成用的 `skill_id` / `model` / `loras` / `width` / `height` / `seed` /
  `recipe` / `prompt` 与产物文件名，由循环在生成工具的成功终态上写下——failed 与 cancelled 的入参是试过的路，不立事实。
  这一段逐轮重注入系统提示词，续聊时从会话文件接上：用户说「再来一张」默认沿用上一发的技能与参数，不重查技能表与模型表；
  里面的种子是上一发的真值，不是「必须复现同一张」的指令。焦点链之前的会话文件没有这一项，按空焦点接上。
- 会话文件含用户提示词与本机路径：gitignore 与 Registry 包都把它挡在外面，只存本机。历史与续聊的路由只在
  ComfyUI 侧有，不进桌面端能力表 `app/studio_caps.py`，右栏在离线桌面端整栏不出现。

## prompts.py — `/rs_prompts/*`

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/rs_prompts/save_prompt` | 保存提示词预设 |
| POST | `/rs_prompts/list_prompts` | 提示词列表（含配方条目） |
| POST | `/rs_prompts/load_prompt` | 读取提示词 |
| POST | `/rs_prompts/list_prompt_lines` | 提示词行级列表 |
| POST | `/rs_prompts/delete_prompt` | 删除提示词 |
| GET | `/rs_prompts/get_models` | 可用 LLM 模型列表（远程 + 本地） |
| GET | `/rs_prompts/native_models` | 原生文本生成模型列表（扫描 `models/text_encoders/` 下 `.safetensors`） |
| POST | `/rs_prompts/set_model` | 切换当前 LLM 模型 |
| GET/POST | `/rs_prompts/remote_llm_config` | 远程 LLM 配置读取 / 保存 |
| POST | `/rs_prompts/llm_connection_test` | 连接测试（远程用当前表单值发送「你好」；Native 实跑一次本地推理） |
| GET | `/rs_prompts/llm_mode` | 当前 LLM 模式 |
| POST | `/rs_prompts/extract_title` | AI 提取标题 |
| POST | `/rs_prompts/extract_classify` | AI 提取分类 |
| POST | `/rs_prompts/enhance_prompt` | 提示词增强 |
| POST | `/rs_prompts/translate_prompt` | 提示词翻译 |
| POST | `/rs_prompts/smart_prompt` | 快捷描述生成 |
| POST | `/rs_prompts/reverse_prompt` | 图片反推（SSE + 同名 .txt 缓存） |
| POST | `/rs_prompts/stream_{task_name}` | 按任务名注册的流式生成端点 |
| POST | `/rs_prompts/stream_generate_prompt` | 流式生成 |
| POST | `/rs_prompts/random_prompt` | 随机提示词 |
| POST | `/rs_prompts/random_prompts` | 运行时随机批量抽条（1–16） |
| POST | `/rs_prompts/fetch_remote_models` | 拉取远程服务端模型列表 |
| GET | `/rs_prompts/skills` | 技能列表（预设 / 任务 / 自定义分组） |
| POST | `/rs_prompts/load_skill` | 读取单个技能 |
| POST | `/rs_prompts/save_skill` | 新建 / 更新技能主文件（预设只读） |
| POST | `/rs_prompts/delete_skill` | 删除整个技能目录（仅 USR） |
| POST | `/rs_prompts/reset_skill_config` | 技能设置恢复默认（删本地覆盖文件） |

- `fetch_remote_models` 请求带 `provider`，`api_key` 留空时回退该 provider 已存密钥。
  本地 / 局域网端点先依次尝试 LM Studio、Ollama 原生端点，没有结果再按 OpenAI 兼容 `/v1/models` 尝试。
- `skills` 里的生图 / 生视频技能另带可选 `gen_config` 摘要（主模型、LoRA 名列表、长边尺寸、默认比例、步数），
  全空时不附该字段。
- `load_skill` 返回正文、附属 `.md` 清单、`max_tokens`、生图 / 生视频标记、视频模式、参考图要求、
  是否存在本地配置覆盖，以及目录里有没有 `workflow.json` 模板（`has_workflow`；右栏智能体靠这一项认出
  正文型技能只能走 `generate_prompt`，见 `docs/skills.md`）。
- `save_skill` 校验名称唯一性（与其它技能重名返回 409）；可选字段缺省沿用 frontmatter 既有值，显式假值移除该字段。
- LLM 配置与标题提取（`get_models` / `native_models` / `set_model` / `remote_llm_config` /
  `llm_connection_test` / `llm_mode` / `extract_title` / `fetch_remote_models`）由 `llm.py` 的
  `RouteTableDef` 注册：只读 `configs/` 与 8080 服务，不依赖 ComfyUI 运行时，桌面端离线同样服务。

LLM 模式与配置见 [llm.md](llm.md)，技能设计见 [skills.md](skills.md)。

## prompt_names.py — `/rs_prompts/list_prompt_names`

| 方法 | 路由 | 说明 |
|------|------|------|
| POST | `/rs_prompts/list_prompt_names` | 提示词名字与标签（@ 点名弹层的候选） |

- 只从目录列表取名字：一次请求 = `presets/` 与 `custom/` 各一次目录列表、各开一份 `_tags_index.json`，
  全程不逐个 stat `.txt`，也不打开任何正文；正文是选中那一发才读。custom 在前、presets 在后，与 `list_prompts` 同序。
- 写侧（`save_prompt` / `delete_prompt` 更新标签索引）留在 `prompts.py`；这条读侧在 `prompt_names.py`，
  模块不碰 PromptServer，桌面端离线同样服务。

## model_hub.py — `/neo_model_hub/*`

模型库（Comfy-Org 专区 · ModelScope / Hugging Face 双源搜索与断点续传下载），细节见 [model-hub.md](model-hub.md)。

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/neo_model_hub/settings` | 设置 + 策展注册表 + 落盘类别 + 可用源 |
| POST | `/neo_model_hub/settings` | 保存设置（源 / 端点 / Token / LLM 子目录 / 超时，写入前清洗） |
| POST | `/neo_model_hub/repos` | 仓库列表（双源并集 + 注册表补齐，带 `query` 时叠加跨组织搜索） |
| POST | `/neo_model_hub/files` | 仓库文件清单（过滤非模型文件，附类别 / 文件名 / 已存在标记） |
| POST | `/neo_model_hub/subfolders` | 类别落盘目录下已有子目录列表 + 默认子目录自动探查 |
| POST | `/neo_model_hub/download` | 启动下载（单任务，`.part` + HTTP Range 续传） |
| GET | `/neo_model_hub/progress` | 当前下载快照（进度 / 速度 / 状态） |
| POST | `/neo_model_hub/cancel` | 取消进行中的下载（保留断点） |

- 仓库列表与文件清单走服务端缓存（15 / 10 分钟），请求带 `refresh: true` 跳过缓存。
- ModelScope 组织列表与跨组织搜索走匿名 `dolphin/models` 接口；接口失败时按注册表逐仓库探测存在性（缓存 1 天）。
- 源侧失败返回带 `code` 的错误：`need_token`（401）、`busy`（409）、`not_on_source`（404，附 `other_source` 建议换源）。

## 桌面端服务 — `app/studio_server.py`

桌面端（`app/studio_app.py`）在 ComfyUI 端口 +3（默认 `8191`）起一个 aiohttp 服务，按 `app/studio_caps.py`
的能力表挂载插件模块挂在各自 `RouteTableDef` 上的 handler。判定标准是「只做文件读写 / 本地检索 /
远程下载 / 打 8080 LLM 服务」；需要执行队列、显存、节点定义的归 ComfyUI，表外接口一律 409。
桌面端服务的启动序列、关窗回收与缓存约定见 [studio-desktop.md](studio-desktop.md)。

| 方法     | 路由                                                                                                                                                        | 说明                                                                                                                                                                |
|----------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| GET      | `/neo-studio`                                                                                                                                               | Studio 页面（桌面端同一份 `web/studio/index.html`）                                                                                                                 |
| GET      | `/extensions/comfyui-neo-studio/*`                                                                                                                          | 前端静态文件                                                                                                                                                        |
| GET      | `/neo-pose` `/neo_pose/*`                                                                                                                                   | 摆姿页跳转与桥接口；`/pose-dist/*` 与 `/models/*` 是摆姿包静态前缀（两端直接注册，不在能力表）                                                                                     |
| GET/POST | `/neo_gallery/*` `/neo_bookmark/*`                                                                                                                          | 素材库与收藏（含删除 / 上传 / 打标 / OSS 同步）                                                                                                                     |
| GET/POST | `/rs_prompts/skills` `load_skill` `save_skill` `delete_skill` `*_*_skill_file`                                                                              | 技能编辑                                                                                                                                                            |
| POST     | `/rs_prompts/list_prompt_names`                                                                                                                             | @ 点名弹层的提示词候选（只扫数据根 `prompts/` 的名字与标签）                                                                                                        |
| GET/POST | `/rs_recipes/*`                                                                                                                                             | 配方读写、LLM 重写 / 逐格描述 / 分段 / 宫格切分                                                                                                                     |
| GET/POST | `/neo_image_gen/settings` `models` `input_images` `skill_config` `skill_workflow` `*workflow_skill*` `copy_skill_files`、`/neo_video_gen/settings` `models` | 生图 / 生视频设置                                                                                                                                                   |
| GET/POST | `/rs_prompts/get_models` `native_models` `set_model` `remote_llm_config` `llm_connection_test` `llm_mode` `extract_title` `fetch_remote_models`             | LLM 配置与标题提取（只读 `configs/` 与 8080 服务）                                                                                                                  |
| GET/POST | `/neo_model_hub/*` `/neo_backyard/*`                                                                                                                        | 模型库与 Backyard                                                                                                                                                   |
| GET/POST | `/userdata/neo_gallery_data.json`                                                                                                                           | 素材库状态文件（`user/default/`，写入走 `.tmp` + replace）                                                                                                          |
| GET      | `/neo_studio/version`                                                                                                                                       | 能力快照：`offline: true` + `caps` + `starting` + `routes` + `comfy_base` + `data_root` / `comfy_local` / `remote`（「设置 → 关于」的路径行），前端据此门控与选目标 |
| GET      | `/neo_studio/comfy_state`                                                                                                                                   | 内核状态快照（端口 / PID / 谁启动 / 运行 / 就绪 / 启动中）：整页刷新后 pywebview 的桥晚于页面注入，顶栏状态位靠它从 HTTP 侧补上；桌面端还没装配出内核时 `409`       |
| GET      | `/neo_studio/log` `/view` `/ws`                                                                                                                             | 启动日志 / 图片只读 / WS 桩                                                                                                                                         |
| ANY      | 其余 `/neo_*` `/rs_*` `/userdata/*` `/api/*`                                                                                                                | `409 {"success": false, "offline": true}`                                                                                                                           |

- `routes` 是归属表（`studio_caps.route_list()`，形如 `"GET /neo_gallery/list"`）：页面钉在桌面端端口上时，
  前端按它判定每条请求打桌面端还是打 ComfyUI，不在前端另立第二份清单。
- `comfy_base` 是生成类请求的直连目标，只在桌面端自己拉起且只监听本机的那路非空；为空时表外的接口照旧
  在桌面端上拿 `409`。直连的开启条件与 CORS 放行见 [studio-desktop.md](studio-desktop.md)。

- 生成与队列类接口必须 ComfyUI 在跑：`/neo_image_gen/generate`、`/neo_video_gen/run_segment`
  `assemble_segments` `storyboard_generate`、`/neo_voice/generate`、`/neo_studio/director/generate`、
  `/neo_agent/run` `/neo_agent/cancel` `/neo_agent/answer` `/neo_agent/pause` `/neo_agent/resume`、
  `/neo_studio/mem_stats`、`/neo_nodes/repair`。
- 缩略图与 ComfyUI 共用 `gallery/thumbnails` 缓存；两边同时跑时同一张图可能各生成一次。
- 目录取 `folder_paths` 的默认 `output` / `input` / `user`：外部用 `--output-directory` 启动 ComfyUI 时，
  桌面端浏览仍指向默认目录。

## MCP 服务 — `studio/mcp_server.py`

不是 HTTP 服务：MCP 客户端把它作为 **stdio 子进程**启动，外部智能体经 JSON-RPC 调用工具，
服务器再经本机 ComfyUI 的 HTTP 接口干活（地址强制回环）。工具清单、参数与用法约定见
[mcp.md](mcp.md)。

| 工具 | 打到的路由 |
|------|-----------|
| `neo_status` | `GET /neo_studio/version` + `GET /queue` |
| `list_skills` `generate_prompt` | `GET /rs_prompts/skills` + `POST /rs_prompts/stream_generate_prompt`（SSE） |
| `list_models` `generate_image` `list_tasks` | `GET /neo_image_gen/models` + `POST /neo_image_gen/generate` + `GET /neo_image_gen/tasks`（`list_models` 的 `scope=video` 读 `GET /neo_video_gen/models`，`group=diffusion_models` 时另读 `GET /rs_prompts/skills` 取主模型 ↔ 技能映射；`generate_image` 与 `list_tasks` 的响应带 `skill_id`，就是这一发用的技能） |
| `task_status` | 生图在 `GET /neo_image_gen/tasks` 整表里按 `task_id` 命中，快照字段原样透传（含 `skill_id`）；整片 / 单段 / 拼接依次探测 `GET /neo_studio/director/{id}` `GET /neo_video_gen/run_segment/{id}` `GET /neo_video_gen/assemble_segments/{id}`，整片附带 `GET /neo_video_gen/director_progress` |
| `cancel_task` | 依次探测上述四张表的 `…/cancel` |
| `get_media` | `GET /view`（产物只经 ComfyUI 读；图片 png 与成片 mp4 同一地址，视频不回传字节） |
| `list_gallery` | `GET /neo_gallery/list` |
| `list_recipes` `load_recipe` | `POST /rs_recipes/list` `POST /rs_recipes/load` |
| `director_recipes` `director_spec` | `GET /neo_studio/version` + `GET /rs_recipes/director_spec` |
| `director_plan` | `POST /rs_recipes/director_generate_segments` / `director_optimize_prompts`（SSE）/ `director_modify_segment`（SSE） |
| `director_save` `director_copy` | `POST /rs_recipes/save` `POST /rs_recipes/copy`（唯一的两个写操作） |
| `director_run` `segment_run` `assemble_run` | `POST /neo_studio/director/generate` `POST /neo_video_gen/run_segment` `POST /neo_video_gen/assemble_segments` |

- 段序号对外一律 1 基；`run_segment` 的 `segment` 与 `assemble_segments` 的 `use` 是 0 基，由服务器换算。
- 不暴露删除端点（`/rs_recipes/delete`、`/neo_gallery/delete` 等），不直连本地文件路径。

