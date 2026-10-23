# 架构与模块

项目结构、前后端模块职责、节点注册与数据目录。总入口见 [../Developer.md](../Developer.md)。

## 项目结构

```
studio/
├── __init__.py                # 插件入口：注册 API 路由、合并节点映射、声明 WEB_DIRECTORY
├── prompts.py                 # 提示词节点 + /rs_prompts/* 路由
├── prompt_names.py            # 提示词名字与标签扫描 + /rs_prompts/list_prompt_names
├── prompt_lines.py            # 多行提示词集合解析
├── skill.py                   # 技能系统 + 技能路由
├── llm.py                     # LLM 推理：远程 API / 原生 safetensors / 本地 GGUF
├── laya_router.py             # 本地轻量文本分类
├── minimax_h3.py              # MiniMax H3 生成模式与 grounding
├── h3_prompt_audit.py         # H3 提示词格式审计
├── video_gen.py               # 生视频全局设置
├── h3_video_gen.py            # H3 视频生成共享 helper
├── h3_video_director.py       # 多段导演节点 NeoH3VideoDirector
├── h3_segment.py              # 单段生成 / 重生成
├── h3_assemble.py             # 单段结果拼回成片
├── h3_preview.py              # 采样期实时预览
├── image_gen.py               # 生图后端 + /neo_image_gen/* 路由
├── image_gen_edit.py          # 生图/编辑节点 NeoImageGenEdit
├── sam3_seg.py                # SAM3 点选分割
├── storyboard.py              # 图片分镜关键帧生成
├── bundles.py                 # 运行时 bundle（内存临时生成包）
├── bundle_expand.py           # BUNDLE 展开节点
├── ref_grid.py                # 参考图宫格节点
├── grid_split.py              # 宫格分镜图拆分算法
├── grid_split_node.py         # 宫格拆分节点 NeoGridSplit
├── gallery.py                 # 素材后端 + /neo_gallery/* 路由
├── gallery_lora.py            # Civitai LORA 示例抓取
├── gallery_oss.py             # 云端预设同步
├── lora_tag.py                # LoRA 图片打标
├── bookmark.py                # 收藏后端（本地 / C 站 / OSS）
├── backyard.py                # Backyard 预处理与 OSS 上传页
├── recipes.py                 # 配方后端 + /rs_recipes/* 路由
├── studio.py                  # 新影工坊后端 + /neo_studio/* 路由
├── app/studio_app.py          # 桌面端（pywebview + WebView2）：拉起 ComfyUI 并托管窗口
├── neo-studio-app.bat         # 桌面端调试入口（带控制台）
├── neo-studio-app.vbs         # 桌面端双击入口（pythonw，无控制台窗口）
├── workflow.py                # 工作流修复 + /neo_nodes/* 路由
├── util.py                    # 媒体常量与共享工具
├── requirements.txt           # Python 依赖
├── pyproject.toml             # Registry 发布元数据
├── pytest.ini                 # 测试配置
├── configs/                   # 运行时配置（见「数据与配置目录」）
├── locals/                    # 本地化资源（zh_CN.json）
├── prompts/                   # 提示词目录（presets / custom）
├── skills/                    # 技能目录（presets / tasks / custom）
├── gallery/                   # 素材媒体与缓存
├── recipes/                   # 配方目录（presets / custom）
├── tools/                     # 离线工具脚本（make_studio_icon.py / build_studio_exe.ps1）
├── tests/                     # pytest 单元测试 + JS/E2E 测试
├── web/                       # 前端资源（WEB_DIRECTORY）
└── .github/workflows/         # Registry 发布 Action
```

## 后端模块

### 提示词与 LLM

| 模块 | 职责 |
|------|------|
| `prompts.py` | 提示词节点 + 预设 CRUD + 图片解析 |
| `prompt_names.py` | 提示词名字与标签扫描（@ 点名弹层的候选）；不碰 PromptServer，桌面端离线共用 |
| `prompt_lines.py` | `collections/` 多行提示词集合的解析与随机选取 |
| `skill.py` | 技能扫描加载、多结果契约、引用文件工具循环、技能路由 |
| `llm.py` | 远程 OpenAI 兼容调用、国产云供应商、原生 safetensors 文本生成、本地 GGUF 推理 |
| `laya_router.py` | 轻量文本分类：增强技能选择与意图预路由 |

### 生图

| 模块 | 职责 |
|------|------|
| `image_gen.py` | 生图后端：模板渲染、队列提交、状态推送、设置读写 |
| `image_gen_edit.py` | `NeoImageGenEdit`：进程内执行技能工作流，输出 IMAGE |
| `sam3_seg.py` | SAM3 点选分割，为局部编辑生成二值遮罩 |
| `bundles.py` | 运行时 bundle：提示词 + 参考图的内存包 |
| `bundle_expand.py` | `NeoBundleExpand`：把 bundle 展开为提示词与参考图 |
| `ref_grid.py` | `NeoRefGrid`：参考图宫格 → 提示词 + BUNDLE + IMAGE |
| `grid_split.py` | 宫格拆分算法：间隙检测、细条剔除、白边清理 |
| `grid_split_node.py` | `NeoGridSplit`：宫格拆成 IMAGE 批次 + 内嵌提示词 |

### 视频

| 模块 | 职责 |
|------|------|
| `minimax_h3.py` | H3 生成模式判定、grounding 约束、正文条件段落裁剪 |
| `h3_prompt_audit.py` | H3 提示词确定性格式审计与窄修复消息 |
| `video_gen.py` | 生视频全局设置、模型与 VAE 自动挑选 |
| `h3_video_gen.py` | 把生成请求解析成模板参数（模型/VAE/参考/LoRA） |
| `h3_video_director.py` | `NeoH3VideoDirector` 多段导演；`NeoH3AddKeyframe` 等注入节点 |
| `h3_segment.py` | 单段生成 / 重生成：锚点取帧、段区间复算 |
| `h3_assemble.py` | 单段结果拼回成片：layout 记录、音频裁齐 |
| `h3_preview.py` | 采样期实时预览：taeh3 解码 + WS 事件推送 |
| `storyboard.py` | 图片分镜关键帧生成（t2i / r2i） |

### 素材、配方与工具

| 模块 | 职责 |
|------|------|
| `gallery.py` | 目录浏览、缩略图、上传删除重命名、灯箱数据 |
| `gallery_lora.py` | Civitai LORA 示例后台抓取与缓存 |
| `gallery_oss.py` | 云端预设同步 |
| `lora_tag.py` | 画廊叶子目录批量生成标签 `.txt` |
| `bookmark.py` | 收藏后端：本地 / C 站 / OSS 收藏 |
| `backyard.py` | Backyard 页面：Gallery 预处理与 OSS 上传管理 |
| `recipes.py` | 配方 CRUD、一键发送、导演配方与故事板、导入导出 |
| `studio.py` | 新影工坊后端：独立页面入口与整片生成任务 |
| `app/studio_app.py` | 桌面端：拉起 ComfyUI 并托管 WebView2 窗口（几何 / localStorage 持久化） |
| `workflow.py` | 工作流模型路径修复、修复映射、技能模型建议 |
| `util.py` | 媒体扩展名常量、媒体探测、元数据与提示词收集 |

## 前端资源

| 文件 | 职责 |
|------|------|
| `gallery.js` | 素材侧栏主逻辑（状态、持久化、API、视图切换） |
| `gallery-list.js` | 列表浏览：工具条、面包屑、分页、封面懒加载 |
| `gallery-card.js` | 单卡片：目录封面、缩略图、发送与收藏菜单 |
| `gallery-gen.js` | 一键生图（角色图 / 九宫格分镜图）与前置小窗 |
| `gallery-setting.js` | 目录管理配置弹窗 |
| `gallery-masonry.js` | 卡片瀑布流布局 |
| `gallery-utils.js` | 素材工具函数 |
| `gallery-node-drop.js` | 素材拖放到画布节点 |
| `lightbox.js` | 灯箱查看器 |
| `media-transfer.js` | 素材上传与传输 |
| `prompts.js` | 提示词节点前端交互 |
| `prompt-manager.js` | 提示词管理器（预设列表 / 集合视图 / 保存删除） |
| `prompt-service.js` | 提示词 API 封装 |
| `llm-chat.js` | LLM 聊天域（输入、输出预览、技能下拉、流式生成） |
| `llm-setting.js` | LLM 配置表单 |
| `at-picker.js` | `@` 图片选择器 |
| `slash-picker.js` | `/` 技能快捷菜单 |
| `skill.js` | 技能模块门面：组装下列子模块并统一对外导出 |
| `skill/skill-core.js` | 技能 API、Markdown 渲染、分类标签、工作流模板预渲染、回写变更记录 |
| `skill/skill-writeback.js` | 工作流回写确认、变更记录弹窗、画布导入与待回写绿点 |
| `skill/skill-detail-popup.js` | 单技能详情弹窗与跨节点单例 |
| `image-gen.js` | 生图客户端与生图设置表单 |
| `image-gen-edit-node.js` | 生图/编辑节点前端 |
| `live-preview.js` | 采样实时预览面板（导演节点 / Studio 导演页 / 右栏智能体工具卡共用） |
| `director.js` | 导演配方编辑器 |
| `director-node.js` | 导演节点内嵌时间轴与预览 |
| `director-timeline.js` | 可复用时间轴组件 |
| `recipes.js` | 配方面板逻辑 |
| `bundle-expand.js` | BUNDLE 展开节点前端 |
| `bundle-lock.js` | bundle 锁定与自动增强 |
| `ref-grid.js` | 参考图宫格前端 |
| `workflow.js` | 工作流修复交互 |
| `workflow-graph.js` | 技能工作流只读流程图（autogrow 槽位合并为合成节点，图上与 tooltip 不显示内部 id；同列宽度拉齐，模型加载节点放宽以显示模型名；被设置填走值的字段带 `{{TOKEN}}` 来源，摘要给出变量芯片）；`canvasLayout` 按同一套分层与同层排序重排「导入到画布」后的画布节点，并返回同列统一宽度供 setSize |
| `workflow-context.js` | 工作流上下文采集 |
| `top-menu.js` | 顶栏 🅝 菜单 |
| `canvas-lock.js` | 主画布离线闸门：ComfyUI 掉线时锁画布（前端自带的 `read_only` 画布锁）并出横幅，恢复后解锁 |
| `node-behavior.js` | 节点拖拽、粘贴等交互行为 |
| `combo-box.js` | 通用下拉组件 |
| `dom-utils.js` | 共享 DOM 工厂 |
| `toast.js` | 提示条 |
| `quick-input-history.js` | 快速输入历史 |
| `studio/` | 新影工坊独立页面（index.html + studio-app.js + shim/） |
| `*.css` | 各模块样式 |

## 节点注册

节点类在各模块底部映射，`__init__.py` 合并导出：

```python
# prompts.py
NODE_CLASS_MAPPINGS = {
    "NeoPromptEncoder": NeoPrompts,    # CLIP 节点：提示词管理 + LLM 增强 + CLIP 编码
    "NeoPromptAgent": NeoPromptAgent,  # 提示词节点：提示词文本输出 + LLM 增强
}
```

- `NeoPrompts`（Neo Prompt Encoder）：输出 `CONDITIONING` + `STRING`
- `NeoPromptAgent`（Neo Prompt Agent）：无 CLIP 输入，输出 `STRING`
- `NeoRefGrid`（Neo Reference Grid）：输出 `STRING`×2 + `IMAGE`×12
- `NeoBundleExpand` / `NeoImageGenEdit` / `NeoH3VideoDirector` / `NeoH3SegmentRun` / `NeoGridSplit`
  与 H3 锚点节点（`NeoH3AddKeyframe` / `NeoH3AddGuides` / `NeoH3AddContext`）在各自模块注册

前端扩展目录由 `WEB_DIRECTORY = "./web"` 声明。ComfyUI 以 `extensions/**/*.js` 递归加载，**只认 `.js`**：
子目录可用，改名成 `.mjs` 会让前端全部加载不到。

- `web/js/core/`：跨节点共享工具。`cache.js` 是带 TTL 的缓存守卫——配方 spec、技能模板这类会被用户改掉的
  拉取结果统一走它（保存事件显式清空 + TTL 兜底）。`i18n.js` 是界面语言：中文原文作 key，英文缺项回落中文，
  语言存 `localStorage["neo_studio_lang"]`、默认跟随浏览器语言，顶栏设置弹窗「🌐 界面语言」与桌面端设置页
  「界面语言」选完整页刷新生效。翻译范围是顶栏菜单与桌面端 Studio 自有文案（顶栏、导演页、启动设置、状态位）；
  素材 / 技能 / 各设置表单这些共享模块的文案保持中文原文。
- `web/docs/<节点键>.md`：节点帮助文档。ComfyUI 前端按 `/extensions/comfyui-neo-studio/docs/<节点键>.md`
  自动取用并渲染在节点属性面板的「信息」页（先试 `<节点键>/<语言>.md`，取不到才回退 `DESCRIPTION`），
  插件侧不需要任何加载代码。

`__init__.py` 用 `NEO_NODES` 登记 11 个节点及各自所属模块：模块导入失败时节点会静默消失，所以加载结束时按清单核对，
打印 `[Neo Studio] v<版本> 已注册 N/11 个节点`，缺失项点名节点与模块。版本号单一来源 `util.plugin_version()`（读 `pyproject.toml`，
Studio 版本页共用）。清单与注册表的一致性由 `tests/test_node_metadata.py` 校验。

### 节点元数据

节点必须自带搜索与悬停信息，`server.py` 原样透传进 `/object_info`，由 `tests/test_node_metadata.py` 逐个校验：

- `SEARCH_ALIASES`：前端搜索别名，中英混合、小写，含同义词与旧名。
- `DESCRIPTION`：节点悬停描述。
- `OUTPUT_TOOLTIPS`：输出提示词，与 `RETURN_TYPES` 一一对应（多槽位节点用元组拼接保证对齐）。
- widget 的 `{"tooltip": ...}`：非 hidden 输入的含义，`-1`、模式开关这类语义必须写出来。

V3 节点（`NeoImageGenEdit`）走 `io.Schema(description=..., search_aliases=[...])` 与
`io.Image.Output(tooltip=...)`，由同一测试校验。

## 数据与配置目录

下表目录都相对**用户数据根**，不是插件目录。数据根由 `plugin_paths.py` 解析：环境变量
`NEO_STUDIO_DATA`（桌面端拉起 ComfyUI 时注入）→ 插件目录的 `configs/data_root.json` 指针
（桌面端写入，用户自己起 ComfyUI 时认得）→ 都落空才回退插件目录。插件目录只留代码与内置预设
（`configs/`、`prompts/presets/`、`skills/presets/`、`skills/tasks/`、`recipes/presets/`，
数据根缺文件时由 `seed_presets()` 补齐），装进 `custom_nodes` 的副本同样是代码与预设。
源码运行的数据根是 `Neo-Studio/data/`，exe 运行是 exe 旁的 `data/`。

| 目录/文件 | 说明 |
|------|------|
| `prompts/presets/` | 内置预设（`collections/` 合集、`video/` 视频子集） |
| `prompts/custom/` | 用户提示词，`_tags_index.json` 为标签索引 |
| `skills/presets/<id>/skill.md` | 内置技能（Markdown + YAML frontmatter） |
| `skills/tasks/<id>/skill.md` | 内置任务技能（反推、标题、翻译等） |
| `skills/custom/<id>/skill.md` | 用户自定义技能 |
| `gallery/presets/` | 内置预设素材（只读） |
| `gallery/custom/` | 用户上传素材 |
| `gallery/thumbnails/` | 缩略图缓存（可删除重建） |
| `gallery/lora_cache/` | Civitai LORA 示例缓存 |
| `gallery/oss_cache/` | 云端预设缓存 |
| `recipes/presets/` | 内置预设配方（只读） |
| `recipes/custom/` | 用户配方：`recipe.json` + `assets/` |
| `agent_sessions/` | 智能体会话落盘：一次运行一个 JSON（时间线逐帧 + 续聊原文），只存本机、不进包 |
| `configs/llm_providers.json` | Provider 定义（唯一真源），前端下拉由此生成 |
| `configs/remote_llm_config.json` | 远程 LLM 配置，API Key 仅存本机 |
| `configs/image_gen.json` | 生图默认参数 |
| `configs/video_gen.json` | 生视频默认参数 |
| `configs/gallery_settings.json` | 自定义目录与 Civitai 设置 |
| `configs/gallery_dim_cache.json` | 卡片宽高缓存（路径+mtime+大小 为键，可删除重建） |
| `configs/bookmarks.json` | 本地收藏（仅路径信息） |
| `configs/oss_presets.json` | OSS 预设素材源配置 |
| `configs/backyard_oss.json` | Backyard 的 OSS 配置 |
| `configs/laya_config.json` | Laya 分类器配置 |
| `configs/studio_window.json` | 桌面端窗口几何（`app/studio_app.py` 关窗时写入） |
| `user/neo_repair_mappings.json` | 工作流修复的手动映射 |
| `locals/zh_CN.json` | 本地化资源 |
