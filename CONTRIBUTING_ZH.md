# Neo Studio 贡献指南

> 📄 English: [CONTRIBUTING.md](CONTRIBUTING.md)

Apache-2.0、公开仓库：fork 之后直接提 Pull Request 即可，不需要加入组织。下面这些就是评审时对照的规则；
完整规则在 [AGENTS.md](AGENTS.md) 与 `studio/`、`studio/web/`、`app/`、`tools/` 各自的 `AGENTS.md`，
模块地图在 [Developer.md](Developer.md)，测试清单在 [docs/testing.md](docs/testing.md)。

## 环境

克隆到 ComfyUI 目录树里，`folder_paths`、`server`、`comfy.*` 才解析得到：

```
git clone https://github.com/neoneo-ai/neo-studio.git <ComfyUI 根>/custom_nodes/comfyui-neo-studio
```

`tools\install_plugin.ps1` 从源码装内核插件，`tools\watch_web.py` 把 `studio/web/` 热同步进已装插件的 web
目录（前端改动刷新页面就生效），`.vscode/settings.json` 的 `python.analysis.extraPaths` 指向同级 ComfyUI 根。

## 跑测试

```
python -m pytest -q studio/tests      内核插件：comfy 是桩，不需要 ComfyUI
python -m pytest -q app/tests         桌面端服务：需要同级 ../ComfyUI
pwsh tests\run-tests.ps1              两套用例分进程跑（两族桩互不相容）
npm install
npm test                              前端 golden 快照
npm run e2e                           打 http://127.0.0.1:8188 的真 ComfyUI，连不上自动跳过
```

- 整套测试跑在 30 秒预算内，用例里不许 sleep、轮询、真实定时器。
- 不要裸跑 `node --test`：建节点会留下没清掉的 `setInterval`，用例全绿之后进程仍挂在 pending timer 上。
  `--test-force-exit` 已经写进 `npm test`。
- `app/tests` 要读同级 `../ComfyUI` 和整合包里的真实产物，`app/studio_app.py` 还 import 了 `pythonnet`，
  所以桌面端用例是开发机专属，进不了 CI。CI 门禁跑的是 `.github/workflows/tests.yml` 里的
  `studio/tests` 与 `npm test`。
- JS 测试是 `studio/tests/js/golden/*.txt` 里的 golden 快照。重构 `prompt-manager.js` 或 `node-behavior.js`
  之前先跑一遍；只有在行为改动是有意的时候才重写 golden（`npm run update-goldens`）。

## 加一个节点

下面这些必须在同一个改动里全部完成：

- 节点类，以及模块级 `NODE_CLASS_MAPPINGS` 与 `NODE_DISPLAY_NAME_MAPPINGS`；
- `studio/__init__.py` 里的 `NEO_NODES` 条目——清单里缺这个键，节点在加载时静默消失；
- `studio/web/docs/<节点键>.md`，ComfyUI 属性面板的 Info 帮助文档；
- `SEARCH_ALIASES`（小写、去重、中文别名与旧名）、`DESCRIPTION`、与 `RETURN_TYPES` 一一对齐的
  `OUTPUT_TOOLTIPS`，以及每个可见 widget 上的 `{"tooltip": ...}`；
- `CATEGORY = "Neo Studio"`，节点键以 `Neo` 开头；
- 需要面板 UI 时配套的 `studio/web/<节点>.js` 与同名 `.css`。前端扩展只认 `.js`，改成 `.mjs` 会让整个前端加载失败。

`studio/tests/test_node_metadata.py` 校验这份契约。V3 节点用 `io` API
（`io.Schema(description=..., search_aliases=[...])`、`io.Image.Output(tooltip=...)`），同一个节点里不要把 V3
`io.Schema` 和手写 `INPUT_TYPES` 混用；数量可变的重复输入（例如参考图）用 `io.Autogrow`。

## 加一条路由

- 在 `app/studio_caps.py` 的能力表里加条目。表外的接口在桌面端一律回 `409 offline`，前端按这个标志门控；
  不要在各个 handler 里散着写离线判断。
- 桌面端服务需要离线提供时，在 `app/tests/test_studio_server.py` 加用例。
- 被桌面端服务复用 handler 的模块自带 `web.RouteTableDef`，源码里不得 import `PromptServer`、`nodes`、
  `comfy.*`——桌面进程里没有 ComfyUI 运行时。
- 路由路径、请求体、响应结构保持稳定；改了形状就要在同一个改动里更新 `studio/web/` 里的每个调用方。

## 文档

`docs/*.md` 与 `docs/en/*.md` 互为镜像，一次改动两种语言一起改。`README.md` 英文、`README_ZH.md` 中文，
`Developer.md` / `Developer_EN.md` 同理成对，`CHANGELOG.md` 用英文。安装与配置片段用 `<ComfyUI 根>`、
`<数据根>` 占位，不写死盘符。

## 打包边界

Registry 包 = git 跟踪的文件减去 `studio/.comfyignore`。新文件属于包内还是包外，在同一个改动里定下来。
密钥只留本机、不进包：`remote_llm_config.json`、`backyard_oss.json`，以及 `model_hub.json` 里的
`hf_token` / `ms_token`。不要提交用户数据，也不要把数据根搬回插件目录——数据根按 `NEO_STUDIO_DATA`、
`configs/data_root.json` 指针、插件目录回退这三步解析，且只有 `plugin_paths.py` 读它。

## 代码风格

前端是无构建步骤的纯 ES 模块；`marked.min.js`、`purify.min.js` 保持 vendored；共享的 DOM 工具在两个以上
模块用到时进 `studio/web/js/core/`。Python 模块以 `# SPDX-License-Identifier: Apache-2.0` 和
`from __future__ import annotations` 开头，import 留在模块作用域，用户配置文件原子写（先 `<name>.json.tmp`
再 replace），从下拉框、请求体、已存配置里拿到的路径要在读写边界上重新校验。注释解释「为什么」并写明它守的是
哪个真实故障，模块用中文注释时注释也用中文。不用 `einops`。不做遥测、统计、更新检查，也不做任何不是由用户
显式操作发起的对外请求（Civitai、ModelScope、Hugging Face、OpenAI 兼容 LLM、阿里云 OSS 之外没有网络路径）。

## 提交与 Pull Request

Conventional Commits 带 scope（`feat(studio): ...`、`fix(studio-desktop): ...`、`perf(gallery): ...`、
`refactor: ...`、`docs: ...`、`chore(ci): ...`），一个 commit 装一个连贯的行为改动。PR 描述只写三件事：
问题是什么、行为怎么变、跑了哪些测试。

功能 PR 里不要改版本号。版本号只有一个来源——`studio/pyproject.toml`，经 `util.plugin_version()` 读——发布是
维护者动作：打 `vX.Y.Z` 标签会同时触发 Registry 发布与桌面端 exe 构建。

## 会被拒的改动

注册了却没进 `NEO_NODES` 清单的节点；把数据根放进插件目录；把密钥或用户配置打进包；桌面端意外回 `409`
的路由；被改名成 `.mjs` 的前端模块；把测试进程挂在 pending timer 上的用例；任何形式的遥测；以及一眼看出是
机器生成的代码——多余的 helper 层、含糊的命名、背后没有真实故障模式的防御分支、复述代码的注释。