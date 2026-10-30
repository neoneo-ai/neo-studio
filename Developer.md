# Neo Studio 开发者文档

> 🇬🇧 English: [Developer_EN.md](Developer_EN.md)

面向开发者：项目结构、前后端模块职责、API 路由、节点注册、数据目录、测试与发布。
终端用户使用文档见 [README_ZH.md](README_ZH.md)，详细文档按大模块拆分在 `docs/`（索引见 [docs/README.md](docs/README.md)）。

## 文档地图

| 文档 | 内容 |
|------|------|
| [docs/en/README.md](docs/en/README.md) | 英文文档镜像（以下各文档的英文版） |
| [docs/architecture.md](docs/architecture.md) | 项目结构、模块职责、节点注册、数据与配置目录 |
| [docs/api-routes.md](docs/api-routes.md) | 后端 API 路由一览 |
| [docs/studio-desktop.md](docs/studio-desktop.md) | 桌面端：启动序列 / 无边框窗口 / 关窗回收 / 插件同步 / 缓存与日志 |
| [docs/mcp.md](docs/mcp.md) | MCP 服务器（`studio/mcp_server.py`，stdio，外部智能体调用生图 / 导演能力） |
| [docs/testing.md](docs/testing.md) | pytest 单测与 JS 回归测试（golden 快照、run-tests.ps1） |
| [docs/release.md](docs/release.md) | Registry 发布与离线工具（预设预处理 / OSS 部署） |
| [docs/llm.md](docs/llm.md) | LLM 模式、本地 GGUF 安装、模型目录规范 |

功能模块文档（用户说明 + 实现细节）：
[prompts](docs/prompts.md) · [skills](docs/skills.md) · [image-gen](docs/image-gen.md) · [h3-video-gen](docs/h3-video-gen.md) ·
[recipes](docs/recipes.md) · [gallery](docs/gallery.md) · [workflow-repair](docs/workflow-repair.md) ·
[3D 摆姿](docs/studio-pose.md) · [视频抽帧](docs/studio-frames.md)

智能体与贡献者规则不在 `docs/` 里：根 [AGENTS.md](AGENTS.md) 只写跨层不变量与产品规则，
`studio/`、`studio/web/`、`app/`、`tools/` 各有一份 `AGENTS.md` 写该层独有的规则。

## 速览

- **插件入口** `__init__.py`：导入后端模块注册 API 路由，按 `NEO_NODES` 清单合并节点映射并打印版本 banner，
  声明 `WEB_DIRECTORY = "./web"`。
- **节点注册**：`prompts.py` 底部 `NODE_CLASS_MAPPINGS`（NeoPromptEncoder / NeoPromptAgent），
  另含 `image_gen_edit.py` 的 NeoImageGenEdit（V3 节点 + Autogrow 参考图）。
- **API 路由**：gallery 系列与 `llm.py`（LLM 配置 / 标题提取）自带 `web.RouteTableDef`，由 `__init__.py` 统一挂进
  `PromptServer.instance.routes`（其余模块仍直接装饰注册），清单见 [docs/api-routes.md](docs/api-routes.md)。
- **桌面端**：`app/studio_app.py`（Windows 为 pywebview + WebView2 全功能路径；macOS v1 为远程模式窗口）拉起或附着 ComfyUI 并托管窗口，桌面端服务在 ComfyUI 端口 +3
  复用同一批 handler 跑离线 Studio（`app/studio_server.py` + `app/studio_caps.py` 能力表）。启动序列、引导页、
  无边框窗口与拖动、关窗与进程回收、单实例锁、插件同步、缓存与日志的约定见
  [docs/studio-desktop.md](docs/studio-desktop.md)。
- **前端资源**：`web/` 下的模块由 ComfyUI 扩展机制加载（只认 `.js`），Studio 独立页面在 `web/studio/`，
  跨节点共享工具在 `web/js/core/`，节点帮助文档在 `web/docs/<节点键>.md`（ComfyUI 原生约定路径，属性面板「信息」页直接加载）。
- **数据目录**：素材 / 配方 / 提示词 / 技能 / 配置不随插件目录走，解析顺序与目录清单见
  [docs/architecture.md](docs/architecture.md) 的「数据与配置目录」。

## 常用命令

```bash
python -m pytest tests -v      # Python 单元测试（无需启动 ComfyUI）
npm test                       # JS 回归测试（golden 快照比对）
pwsh tests/run-tests.ps1       # JS 测试运行器（带超时强制终止，勿裸跑 node --test）
```

详见 [docs/testing.md](docs/testing.md)。

内核插件 import 的 `folder_paths` / `server` / `comfy.*` 由 ComfyUI 根目录在运行时提供，Pylance 需要
`.vscode/settings.json` 的 `python.analysis.extraPaths` 指向同级的 ComfyUI 根才认得这些 import。
