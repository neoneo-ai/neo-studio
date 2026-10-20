# Neo Studio

> 📄 English: [README.md](README.md)

**「一句话 → 提示词 → 成图 → 成片」**：提示词 AI 增强、生图与参考编辑、MiniMax H3 多段导演，全在一个插件里；
LLM 可在 ComfyUI 进程内零依赖运行。

[![配方一键发送到工作流](docs/assets/videos/hero-recipes-send-poster.jpg)](https://github.com/neoneo-ai/neo-studio/blob/main/docs/assets/videos/hero-recipes-send.mp4)

▶ [播放 57 秒演示视频（3.9 MB，MP4）](https://github.com/neoneo-ai/neo-studio/blob/main/docs/assets/videos/hero-recipes-send.mp4)

**安装**：ComfyUI Manager 搜 `Neo Studio` 一键安装（已发布至 ComfyUI Registry），详见 [安装](#安装)。

## 为什么选 Neo Studio

| 能力 | 常见做法 | Neo Studio |
|------|----------|-----------|
| 本地 LLM | 需要 `llama-cpp-python`（Windows 上常编译失败） | **Native**：safetensors 文本生成模型在 ComfyUI 进程内推理，零额外依赖 |
| 云端 LLM | 手填端点与模型名 | 内置 DeepSeek / 阿里云百炼 / Kimi / 智谱 GLM / 硅基流动，填 Key 即用，🔌 测试连接当场验证 |
| 模型下载 | 手动下载再拖进模型目录 | ModelScope + Hugging Face 双源搜索，按仓库内路径自动归类落盘，断点续传 |
| 中文检索 | 只按英文 / 文件名匹配 | 中文技能名全拼 + 首字母缩写检索，LoRA 触发词拼音建议 |
| 生图 / 生视频 | 自己搭几十个节点 | 选技能即生成（技能自带 `workflow.json` 模板），H3 多段导演时间轴拖拽重排 |
| 换机器 / 改目录后 | 满屏红节点逐个改路径 | 顶栏 🅝「🔧 修复工作流」按文件名匹配磁盘真实文件一键修复 |
| 素材复用 | 手动 LoadImage 逐张挑 | 素材库灯箱 + ✈️ 一键写入指定节点，配方一键发送到画布 |

## 零配置可用（不配 LLM 也能用）

安装重启后即可直接使用，不需要任何模型或 API Key：

- **🖼️ Neo Gallery** — 素材浏览 / 灯箱 / 文件管理 / ✈️ 一键写入节点；Civitai LORA 匹配与收藏；LoRA 目录批量打标
- **🧊 Neo Recipes** — 提示词 + 素材保存为配方，一键发送到工作流（含导演配方编辑器）
- **🔧 工作流修复** — 模型路径失效时按文件名匹配磁盘真实文件一键修复
- **📥 模型库** — ModelScope / Hugging Face 双源搜索与断点续传下载（ModelScope 列表与搜索匿名可用）
- **🔲 Neo Reference Grid / 🧩 Neo Grid Split** — 参考图宫格管理、分镜宫格图自动切格
- **🧊 Neo Studio** — 独立页面（`neo-studio.bat` 或 `http://127.0.0.1:8188/neo-studio`；`neo-studio-app.bat` 是独立窗口版）：素材 / 导演 / 技能 / 设置

LLM 增强（✨ 生成 / 图片反推 / 翻译分类）是可选的第二步，三模式配置见 [docs/llm.md](docs/llm.md)。

## 模块一览

**节点**

- **📝 Neo Prompt Encoder** — 提示词管理 + AI 增强（预设 / 搜索 / LLM 增强），输出 CLIP 编码与文本
  → [prompts.md](docs/prompts.md)
- **⚡ Neo Prompt Agent** — 无需连 CLIP 的提示词生成，输出 PROMPT 文本与 BUNDLE 运行时包（可直接接 Krea2 / H3 视频节点）
  → [prompts.md](docs/prompts.md)
- **🖌️ 聊天生图** — 节点内置：选生图技能后 ✨ 直接生成（文生图 / 参考图编辑），实时进度与取消
  → [image-gen.md](docs/image-gen.md)
- **🎨 Neo Image Gen & Edit** — 按技能模板同步生成 / 参考编辑，直接输出 IMAGE 张量到下游
  → [image-gen.md](docs/image-gen.md)
- **🎞️ H3 Video Director** — MiniMax H3 视频生成：按 `video_director` 配方逐段生成并拼接为含音频 `VIDEO`
  → [h3-video-gen.md](docs/h3-video-gen.md)
- **📦 Neo Bundle Expand** — 把 BUNDLE 展开成 `prompt` + `image_1..9`，对齐官方 H3 Reference to Video
  → [prompts.md](docs/prompts.md)
- **🔲 Neo Reference Grid** — 单节点管理「提示词 + 最多 12 张参考图」，宫格参与配方保存与还原
  → [prompts.md](docs/prompts.md)
- **🧩 Neo Grid Split** — 分镜宫格图自动切格，行优先拼成 `IMAGE` 批次并带出原图内嵌提示词
  → [h3-video-gen.md](docs/h3-video-gen.md)

**面板与入口**

- **🖼️ Neo Gallery** — 侧边栏素材浏览与管理：预设 / 自定义目录 / Civitai LORA、灯箱、LoRA 打标
  → [gallery.md](docs/gallery.md)
- **⭐ 收藏（书签）** — 本地收藏（路径记录）+ Civitai 收藏（边下边开）
  → [gallery.md](docs/gallery.md)
- **🧊 Neo Recipes** — 侧边栏配方（提示词 + 图片 / 视频 / 音频资源）管理与一键发送
  → [recipes.md](docs/recipes.md)
- **🅝 顶栏菜单** — 插件统一入口（悬停约 0.3 秒或点击展开，指针离开自动收起）：新影工坊 / 生成素材 /
  新建导演配方 / 创建节点 / 修复工作流 / 回写入技能 / 设置 / 模型库 / 技能管理
  → [workflow-repair.md](docs/workflow-repair.md)
- **🗂 技能管理** — 技能详情页（设置区 + 提示词 + 工作流区内嵌编辑 `workflow.json`）：「⤒ 导入到画布」/
  「💾 回写入技能」，落盘前弹变更确认并记本机变更历史；预设只读，复制为自定义后可编辑
  → [skills.md](docs/skills.md)
- **🔧 工作流修复** — 模型路径失效时按文件名匹配磁盘真实文件一键修复，可手动改选与记住映射
  → [workflow-repair.md](docs/workflow-repair.md)
- **📥 模型库** — Comfy-Org 专区双源（ModelScope / Hugging Face）搜索与断点续传下载，按仓库内路径自动归类落盘
  → [model-hub.md](docs/model-hub.md)
- **🤖 MCP 服务** — `studio\mcp_server.py` 由 MCP 客户端（Claude Desktop / Cursor）作为子进程启动，
  外部智能体经 stdio 调用生图与导演工具；只连本机 ComfyUI，不暴露删除端点
  → [mcp.md](docs/mcp.md)

节点外观：

![图片生成/编辑节点](docs/assets/images/image-gen-edit.png)

## 功能演示

主要模块的交互实录（点击缩略图进入对应文档）：

- [![多段导演时间轴拖拽重排](docs/assets/images/hero-director-timeline.gif)](docs/h3-video-gen.md)
  — 🎞️ H3 Video Director · 时间轴重排
- [![配方一键发送到工作流](docs/assets/images/neo-recipes-send.gif)](docs/recipes.md) — 🧊 Neo Recipes · 一键发送

## 目录

- [为什么选 Neo Studio](#为什么选-neo-studio)
- [零配置可用](#零配置可用不配-llm-也能用)
- [模块一览](#模块一览)
- [功能演示](#功能演示)
- [安装](#安装)
- [依赖](#依赖)
- [快速上手](#快速上手)
- [新影工坊](#新影工坊neo-studio--独立应用)
- [示例工作流](#示例工作流)
- [基础概念](#基础概念)
- [模块文档](#模块文档)
- [许可证与变更记录](#许可证与变更记录)
- [开发者文档](#开发者文档)

## 安装

**首推 Neo Studio App（桌面应用形态）**：它就是新影工坊窗口（素材 / 导演 / 技能 / 设置），在自己的
设置页启停 ComfyUI，并自行把插件装进 `custom_nodes`——不用手动碰插件目录。它需要一个已装好的
ComfyUI 及其 Python 解释器，不自带 ComfyUI。

- **便携版** — 单文件 `Neo-Studio-<版本>-windows-x64.exe`，由 `.github/workflows/release-app.yml`
  挂在 [GitHub Releases](https://github.com/neoneo-ai/neo-studio/releases)（`tools\build_studio_exe.ps1`
  构建，未签名，首次运行会有 SmartScreen 提示）。exe 从自身位置推导 ComfyUI 根目录与解释器，
  找不到时打开首次设置页，并用自带的插件副本安装 / 更新插件——用户数据目录沿用，git 检出目录永不改写。
- **源码版** — 克隆仓库后运行 `tools\neo-studio-app.vbs`（无控制台黑窗；`tools\neo-studio-app.bat`
  是带控制台的调试入口，`--debug` 开 DevTools）。源码运行时每次启动都把 `studio/` 同步进
  `custom_nodes`（只同步同名文件，目标目录不删除任何东西）。

窗口、离线服务与内核启停：见 [新影工坊](#新影工坊neo-studio--独立应用)。

<details>
<summary>ComfyUI 插件形态 —— 只在 ComfyUI 自己的界面里用节点，不带 Studio 窗口</summary>

- **ComfyUI Manager**：搜索 `Neo Studio` 一键安装（已发布至 ComfyUI Registry）
- **comfy CLI**：`comfy node install comfyui-neo-studio`
- **手动克隆**：克隆成 `ComfyUI/custom_nodes/comfyui-neo-studio`，然后重启 ComfyUI

```bash
git clone https://github.com/neoneo-ai/neo-studio.git ComfyUI/custom_nodes/comfyui-neo-studio
```

克隆安装认的是仓库根的 `__init__.py`，它把节点与路由注册交给 `studio/`；正式安装的副本
（Registry、Manager、`tools\install_plugin.ps1`、桌面端同步）根目录就是 `studio/__init__.py`，不经过这个文件。

源码安装：`tools\install_plugin.ps1` 把代码与内置预设装进插件目录，并写好 `configs/data_root.json`
数据根指针（用户数据在插件目录之外，卸载只删插件目录）。命令、参数与发布开关见
[docs/release.md](docs/release.md)。

> **从旧版升级**：包名从 `comfyui-neo-nodes` 换成 `comfyui-neo-studio`，新版**不会**自动禁用旧插件——
> 桌面端同步只写 `comfyui-neo-studio`，旧目录留着就继续加载。先删掉
> `ComfyUI/custom_nodes/ComfyUI-Neo-Nodes`（或改名成 `ComfyUI-Neo-Nodes.disabled`，ComfyUI 会跳过
> `*.disabled`）再装新包——两个目录同时存在会把同一批节点注册两遍，节点菜单里每个 Neo 节点出现两次。
> 1.2.0 起的安装把用户数据放在插件目录之外，删旧目录不动数据；1.2.0 之前的旧插件把
> `configs/`、`gallery/`、`prompts/`、`recipes/`、`skills/`、`locals/` 存在自己目录里，且没有迁移代码，
> 先把这些目录拷进数据根（源码运行是仓库里的 `data/`，exe 是 exe 旁的 `data/`）再删。

</details>

## 依赖

- `openai`、`PyYAML`、`pypinyin`、`Pillow`（随 `requirements.txt` 自动安装；Pillow 由 ComfyUI 核心自带）
- 可选增强（缺包时对应功能自行降级）：`laya`（智能 skill 选择）、`pillow-heif`（HEIC 读取）、
  `oss2`（Backyard OSS 上传）
- `llama_cpp_python`（**可选**，仅 Local GGUF 本地推理需要，见 [docs/llm.md](docs/llm.md)；原生引擎与远程 API 可跳过）

---

## 快速上手

1. **打开新影工坊**（推荐形态）：它会把插件装好并替你拉起 ComfyUI；只用插件的话在 ComfyUI Manager
   搜 `Neo Studio` 安装后重启 ComfyUI。
2. **先玩零配置功能**（不需要 LLM 与任何模型配置）：灯箱里 ✈️ 把素材写进 LoadImage 类节点
   （[gallery.md](docs/gallery.md)）、模型库双源下载并按仓库路径自动归类落盘
   （[model-hub.md](docs/model-hub.md)）、顶栏 🅝 一键修复失效的模型路径
   （[workflow-repair.md](docs/workflow-repair.md)）。
3. **配置 LLM（三选一，✨ 增强 / 图片反推 / 翻译分类需要）**：**原生**（safetensors 放
   `models/text_encoders/`，在 ComfyUI 进程内推理，零额外依赖）、**远程**（选 Provider 填 API Key 与端点，
   「🔌 测试连接」当场验证）或**本地**（GGUF 放 `models/LLM/`）。配置、端点与目录规范见
   [docs/llm.md](docs/llm.md)。
4. **第一次提示词增强**：添加 ⚡ Neo Prompt Agent 节点 → 写一句简短描述 → 点 ✨ → AI 生成的提示词文本
   （无需连 CLIP，可直接接下游）。
5. **第一次生图**：添加 🎨 Neo Image Gen & Edit 节点 → 选一个生图技能 → prompt（接 Agent 或手填）
   + 可选参考图 → 排队执行 → 输出 IMAGE 张量。需 GPU / 显存，且技能必须声明 `gen_image: true`
   并附 `workflow.json`；生图模型 / Text Encoder / VAE 默认「自动」按技能模板匹配。
6. **第一次多段视频**：添加 🎞️ H3 Video Director 节点 → 选 `video_director` 配方 → 时间轴拖拽重排 /
   单段重生成 → 逐段生成并拼接为单个含音频 `VIDEO`。

---

## 新影工坊（Neo Studio · 独立应用）

不依赖画布的独立页面，四个页签：**素材**（完整 Neo Gallery：浏览 / 灯箱 / 文件管理）、**导演**
（只列多段导演配方 + 导演编辑器 + 整片生成面板，带进度 / 取消与实时预览）、**技能**（与顶栏
「🗂 技能管理」同组件）、**设置**（生图 / 生视频 / LLM 设置 / ComfyUI 控制台日志）。依赖画布的功能
（如「发送到节点」）在 Studio 内自动降级为提示。

| 入口 | 作用 |
|------|------|
| `neo-studio.bat` | 浏览器打开 `http://127.0.0.1:8188/neo-studio`，并自动拉起 ComfyUI |
| `neo-studio-app.vbs` | 同一页面跑在独立 WebView2 窗口：无控制台黑窗、不占浏览器标签，窗口几何与状态重开保留（需 `pywebview`，Windows 自带 WebView2 Runtime 即可） |
| `neo-studio-app.bat` | 同一窗口的带控制台调试入口（`--debug` 开 DevTools） |
| `tools/neo-studio.exe` | 拍板造型图标的打包启动器，由 `tools\build_studio_exe.ps1` 产出（见 [docs/release.md](docs/release.md)） |

- **桌面端是启动器，不只是窗口** — 自带离线服务（`app/studio_server.py`，ComfyUI 端口 +3，默认 `8191`），
  ComfyUI 没在跑时素材浏览 / 技能与配方编辑 / 设置（含 LLM 配置）/ 模型库 / 收藏 / LoRA 打标照常可用；
  需要运行时的请求回 `409 offline`（不假装成功），生成按钮变成启动入口。
- **顶栏只报状态** — 「● 运行中」「● 已停止」「● 启动中」，端口 / PID / 谁启动收在鼠标提示里；启停在
  「设置 → 启动设置」顶部：状态一行 + 「▶ 启动内核」「■ 停止内核」两枚按钮，此刻做不了的那枚禁用。
- **窗口先出** — 依赖自检、装配服务、拉起 ComfyUI 都在后台线程，期间停在启动页；端口就绪后页面原地接上生成，
  不换页、不刷新，停掉 ComfyUI 再翻回离线 Studio。
- **关窗收掉桌面端自己拉起的 ComfyUI**（用户自己起的那路不碰）；端口已有 ComfyUI 在监听就直接附着，
  绝不另起第二路。
- **画布跳转留在窗口内** — 「⤒ 主画布编辑」与「🎬 新影工坊」在桌面端窗口内切换，非 Studio 页左上角由桌面端
  挂一枚「🎬 返回 Studio」胶囊。
- ComfyUI 后台日志在「设置 → 日志」里看；桌面端自己的启动 / 跳转 / 拖动过程落在 `data/studio_desktop.log`。

无边框窗口、窗口与任务栏图标、exe 打包、便携启动器与源码同步：见 [Developer.md](Developer.md)。

---

## 示例工作流

`example_workflows/` 下提供可直接加载的 UI 格式模板，ComfyUI 会自动将它们暴露在顶栏
**Templates（模板）** 面板中，选择后一键载入画布。

## 基础概念

### skill

技能不只是提示词模板，还包含内置模型配置（model / vae / clip）、内置工作流与默认基础参数。
技能列表可进入详情页查看；系统预设不可编辑，复制为自定义后即可编辑。

### bundle

包含运行时需要的参数：提示词和图片（可选）。

### recipe

- **基础配方**：把当前的提示词和图片资源保存下来，便于复用。
- **导演配方**：支持多段连续生成，由导演台编辑生成并保存，director 节点运行时选择对应配方，
  点击节点上的 timeline 可直接进入编辑。故事板分镜页支持主题 / 脚本一键 LLM 生成分段分镜
  （角色参考图锁身份），也支持宫格图自动拆分（各格作分段首帧）与逐格 LLM 描述提示词。

### model

技能内置了模型；若想常改，可直接接入外部 `model` 与 `lora`，覆盖技能内置的主模型配置。

---

## 模块文档

各功能模块的详细文档按模块拆分在 `docs/`，完整索引与一句话摘要见 [docs/README.md](docs/README.md)。

---

## 许可证与变更记录

SPDX-License-Identifier: Apache-2.0

每个发布版本的改动清单见 [CHANGELOG.md](CHANGELOG.md)（随标签发布至 ComfyUI Registry）。

collections portrait 10000+ 精美提示词来源：[civitai.com/models/2231696](https://civitai.com/models/2231696)

---

## 开发者文档

开发相关内容（项目结构、后端模块、API 路由、节点注册、测试、桌面端内部机制）见 [Developer.md](Developer.md)。

---

## 参与开发

fork 之后直接提 Pull Request 即可，不需要加入组织。环境搭建、测试命令、节点与路由清单、提交规范见
[CONTRIBUTING_ZH.md](CONTRIBUTING_ZH.md)；漏洞上报与密钥涂改规则见 [SECURITY.md](SECURITY.md)。

