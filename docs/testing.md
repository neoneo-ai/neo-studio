# 测试

总入口见 [../Developer.md](../Developer.md)。

pytest 配置见 `pytest.ini`（`testpaths = studio/tests app/tests`，无需启动 ComfyUI 即可运行）：

```bash
python -m pytest -q studio/tests   # 内核插件套件
python -m pytest -q app/tests      # 桌面端套件（需同级 ComfyUI 根）
```

全量跑要分进程（`tests/run-tests.ps1` 不带参数依次跑 `studio/tests` 与 `app/tests`）：
桌面端用例要真实 `folder_paths`，节点用例要桩掉的 comfy，同进程互不相容。
根目录 `conftest.py` 在收集前把 `NEO_STUDIO_DATA` 钉进临时目录并在退出时清掉，
删目录 / 写配置的用例因此碰不到 `Neo-Studio/data/` 与插件目录里的真实数据。

## Python 单测

- `studio/tests/test_llm.py` — 远程配置加载 / 迁移、模型下载（ModelScope / HuggingFace 回退）、翻译缓存、
  语言检测、文本规范化。
- `studio/tests/test_skills.py` — 技能扫描与分组、内置任务技能存在性、图片解码缩放、多结果解析、
  技能代理（语言互斥主文件选择、引用列表、越界读取拒绝、工具循环按需读引用、本地模式回退）、
  `gen_image` / `requires_ref` 元数据透传与编辑保存保留。
- `studio/tests/test_skill_pose_edit.py` / `studio/tests/test_skill_controlnet.py` — 姿势编辑与 ControlNet 预设技能：
  扫描与去重、`default_prompt` 透出、模板占位符、控制链（预处理 → 模型补丁 → 采样器）接线、
  控制图不占编码器参考槽（`control_ref`）。
- `studio/tests/test_workflow_repair.py` — 模型路径修复匹配算法：精确 / 归一化匹配、量化变体替换、歧义拒绝、
  扩展名约束。
- `studio/tests/test_image_gen.py` — 内置生图参数解析：比例与尺寸取整、输出前缀消毒、模型自动挑选、
  下拉展示排序与自动挑选结果、LoRA 缺失告警、参考图落地、多路槽位空槽裁剪、生图张数覆盖、
  扩图 / 局部编辑仅 Qwen Image 2.1 模板、ControlNet 模板槽位展开与参考张数下限拦截、工作流图结构与 sidecar 写入。
- `studio/tests/test_image_gen_edit.py` — mini-executor：拓扑排序与环检测、引用解析与输出归一化、
  末端 IMAGE 收集与 SaveImage 跳过、未知节点报错、张量 → base64 PNG 往返、请求组装
  （缺 `workflow.json` 报错 / 参考图按槽位排序 / bundle 参考图优先 / 按 `config.json` 的 `max_refs` 限张数）。
- `app/tests/test_studio_desktop.py` — 桌面端（`app/studio_app.py`）：ComfyUI 根与 python 路径解析（整合包同级 `python/` 优先）、
  `/neo_studio/version` 探活与轮询、窗口几何读写（缺文件 / 坏 JSON / 部分字段）、单实例端口占用判定、
  提示走系统消息框（pythonw 无控制台）、拉起 ComfyUI 时压制子控制台窗口、桌面端日志落盘
  `data/studio_desktop.log` 与 pywebview 日志 handler（pythonw 的 `stderr` 是 None，控制台 handler 会打断窗口创建）、
  窗口图标路径传给 `webview.start(icon=...)` 与 AppUserModelID（缺 `.ico` 时传 None）、frozen 下 `resolve_root()`
  沿 exe 自身的祖先目录向上找到 ComfyUI 根（单文件在 `tools` 下、目录版多一层包目录都要认得）且随包资源走 `_MEIPASS`；`comfy_state()`（顶栏状态位与启动设置共用一份轮询；桌面端拉起那路以端口
  探活为准 / 外部按端口 `netstat` 找 PID / 无监听者）、`comfy_stop()`（`terminate()` 后按端口反复 `kill_pid()`
  到没人监听；`kill_pid()` 用 `PROCESS_TERMINATE` 并显式声明 `OpenProcess` 的 `restype`，否则 64 位句柄被截断、
  杀不动还静默失败）、`comfy_start()`（等旧进程退出再 `start_comfy`）、`pid_alive()`、关窗只存几何。
  窗口先出的启动序列：开窗只解包与建窗口（启动页 / 引导页），自检、桌面端服务、拉起 ComfyUI 在后台线程走完，
  落点分别是完整 Studio、离线素材页与停在启动页；测试里后台线程同步跑完（`_SyncThread`），落点才断言得准。
  关窗正好压在拉起这一刻（`desktop.closing` 闸门）：刚起的那路立刻收掉，桌面端退出后不留孤儿 ComfyUI。
- 启动设置（`launcher_api` / `launcher_config.json`）：插件目录不可写时状态目录退回 `%APPDATA%/NeoStudio`；
  `startup_state()` 的五种状态（就绪 / 根目录无效 / 找不到 Python / 缺少插件依赖 / 插件安装失败）；
  配置读写往返与相对路径归一；
  根目录取用优先级 命令行 → 配置 → 插件同级；`ensure_plugin()` 在插件缺失时装内置副本、带上
  `requirements.txt`；exe 内置副本的版本比已装的那份新时覆盖更新（新副本先在状态目录拼好、用户数据目录整目录
  并进去再换目录，目录被占用就跳过），源码运行与 git 检出的那份不覆盖。
- 打包后的 exe（`tools\build_studio_exe.ps1`：`-Mode onefile` 产出 `tools/neo-studio.exe`，`-Mode onedir`
  产出目录版 `tools/neo-studio/Neo-Studio.exe`，`-Mode both` 两个都出；目录版启动不解包，重打包保留包旁 `data/`）：
  起桩服务让桌面端认为已就绪，启动 exe 后
  `ExtractIconExW` 确认内嵌图标资源数为 1，`FindWindowW` 找到窗口，`WM_GETICON` 取到 24x24 图标（我们的 `.ico`；
  无 AppUserModelID 且不传 icon 的 pythonw 基线是 48x48 通用图标），`WM_CLOSE` 后退出码 0，
  `configs/studio_window.json` 与 `data/studio_profile` 落在插件目录而不是临时解包目录。
- 内置插件副本（`tools\build_studio_exe.ps1` 的 `build_bundle()`）：边界是「git 已跟踪 - 开发目录」，
  `configs/` 只剩预设，用户配置与密钥不在跟踪列表里因此进不了 exe；`tests` / `tools` / `docs` 等整目录排除；
  非 ASCII 文件名必须走 `git ls-files -z` 的 NUL 分条，默认输出会把它们转义成假名字。
- `studio/tests/test_studio.py` — 整片生成路由与任务 watcher、版本路由、日志路由（`/neo_studio/log` 读 `app.logger` 环形缓冲）。
- `app/tests/test_studio_server.py` — 桌面端服务（`app/studio_server.py`，进程里没有 ComfyUI 运行时）：起真服务打真接口，断言 ComfyUI 不在跑时
  Studio 页面 / 前端静态文件 / 目录列表 / 缩略图 / 收藏文件都出得来，写操作与生成类接口回 `409 offline`；
  gallery 模块族自带 `RouteTableDef` 且源码不再出现 `PromptServer`（桌面端进程里没有 ComfyUI 运行时）；
  启动设置路由 `/neo_studio/launcher` GET 读配置、POST 校验后落盘（根目录缺 `main.py` 拒绝、未知动作拒绝）。

- `studio/tests/test_node_metadata.py` — 节点元数据契约：注册表键清单、`__init__.py` 的 `NEO_NODES` 清单与注册表一致、
  每个节点都有 `web/docs/<节点键>.md` 帮助文档（ComfyUI 原生「信息」页的取用路径）、`SEARCH_ALIASES`（小写、去重、含中文别名）、
  `DESCRIPTION`、`OUTPUT_TOOLTIPS` 与 `RETURN_TYPES` 数量对齐、可见 widget 的输入提示词、V3 节点 schema 元数据。

## 前端回归测试（studio/tests/js）

前端模块在 jsdom + ComfyUI `api` / `app` 替身下加载，用 golden 快照锁定 UI 结构、隐藏控件状态与请求轨迹。
重构 `prompt-manager.js` / `node-behavior.js` 前先跑一遍，确认行为有意变化后再重写 golden。

```bash
npm test                 # 比对 studio/tests/js/golden/*.txt
npm run update-goldens   # NEO_UPDATE_GOLDENS=1，写入新 golden
```

- `smoke.test.mjs` — 模块可导入、节点扩展注册项。
- `prompt-manager-dom.test.mjs` — 节点创建后的 UI 结构、body 弹层、隐藏控件状态。
- `cache-guard.test.mjs` — 共享 TTL 缓存守卫：命中、过期失效、显式清空。
- `node-behavior-flows.test.mjs` — 随机取词、Enter 流式生成、技能路由请求体、@ 图片选择器、运行时随机菜单。
- `studio-skills.test.mjs` — 技能页引导页：默认不装配管理组件、三个入口、导入 API 工作流（界面工作流被挡下）、
  返回引导页与新建模板技能。
- `llm-setting-advanced.test.mjs` — 有预设 Base URL 的供应商默认收起「自定义端点」，展开后改写仍能落盘；
  无预设的 OpenAI Compatible 常显，Local GGUF 整体隐藏。

## JS 测试运行器（带超时强制终止）

**跑 JS 测试必须带 `--test-force-exit`。** 节点创建会启动未清理的 `setInterval`，
不带该参数时 `node --test` 子进程因 pending timer 使 event loop 永不空闲而无法自然退出——
表现为测试已全部通过却卡到超时。因此**不要裸跑 `node --test studio/tests/js/*.test.mjs`**。
两个入口都已内置该参数：`npm test`（package.json）与 `tests/run-tests.ps1`
（后者额外提供超时强杀 node 进程树、文件名模糊匹配）。

```powershell
# 跑全部 JS 测试（默认超时 120s）
pwsh tests/run-tests.ps1

# 按文件名模糊匹配（支持多关键词逗号分隔）
pwsh tests/run-tests.ps1 skill-gen-layout
pwsh tests/run-tests.ps1 skill-gen-layout,css-integrity

# 自定义超时秒数
pwsh tests/run-tests.ps1 -Timeout 60
```

退出码：`0` = 全部通过，`1` = 有测试失败 / 无匹配文件，`2` = 超时强制终止。

## 浏览器端到端测试（studio/tests/e2e）

Playwright 驱动真实 ComfyUI 前端，验证窗口控制、内嵌 LiteGraph 画布等 jsdom 覆盖不了的行为。
**需要本机已启动 ComfyUI（默认 `http://127.0.0.1:8188`，可用环境变量 `COMFY_BASE_URL` 覆盖）**；
服务不可达时用例自动 skip 而不是失败。

```bash
npm run e2e                       # studio/tests/e2e/*.e2e.mjs
node --test --test-force-exit --test-timeout=180000 studio/tests/e2e/skill-manager.e2e.mjs
```

- `skill-manager.e2e.mjs` — 技能管理窗口：overlay 指针穿透、⛶ 放大还原、标题栏双击放大、Esc 关闭、
  标题栏拖动、右下角把手拉伸；工作流区默认展开直接挂内嵌编辑画布（canvas 铺满盒子、随窗口缩放与 ⛶ 放大跟随、
  折叠卸载画布、再展开重挂、预设技能保存按钮说明结构变更自动复制、125% 缩放下 widget 弹窗贴着鼠标落点、
  combo 下拉浮在技能弹窗之上）。
  截图落 `tmp/skill-wf-editor.png`、`tmp/skill-wf-prompt.png`。
- `node-docs.e2e.mjs` — 节点帮助：11 个节点文档在 `/extensions/comfyui-neo-studio/docs/<节点键>.md` 可取、
  节点上不再有 `neo_help` 徽标 widget、属性面板「信息」页渲染出文档正文（会话未注册属性面板时 skip）。
- `studio-app.e2e.mjs` — 桌面端窗口：桌面端自行拉起 ComfyUI，经 WebView2 远程调试端口连 CDP，断言窗口按
  `configs/studio_window.json` 的存档尺寸打开、四视图渲染、顶栏状态位只报「● 运行中」（端口 / PID 在提示里）、日志 tab 读到控制台内容、
  重开页面后 localStorage 保留；第二条用例在冷启动专用端口（`NEO_STUDIO_STOP_PORT`，默认 8190；设 `NEO_STUDIO_EXE`
  则改跑打包的 exe 时显式传 `--root`/`--python`，exe 落在任意目录推不出根目录）在「设置 → 启动设置」顶部点「■ 停止内核」停掉桌面端拉起的 ComfyUI（端口探活失败），再点「▶ 启动内核」重新拉起，断言顶栏显示「● 启动中」且就绪后
  页面原地接上生成（不换页、不刷新，8188 上用户自己的服务绝不动）；第三条用例断言冷启动窗口先出启动页、随后落在桌面端服务的 Studio 页
  （端口 +3，出离线标记与缩略图、写操作 `409`），ComfyUI 就绪后页面原地接上生成（地址不变、离线标记摘掉、队列面板补种、桌面端 origin 被 ComfyUI 认下），停掉后页面翻回离线形态且无未捕获错误。
  **会弹真实窗口，默认 skip；启用：`NEO_STUDIO_APP=1`（前置：整合包 python 已装 `pywebview`，且没有别的
  Neo Studio 桌面端占着单实例端口 8189——已有桌面端在跑时新实例会直接退出）。**

- `prompt-width.e2e.mjs` — prompt 节点面板宽度：创建、`setSize`、工作流 `configure` 还原宽度后，
  `prompt_ui` DOM widget 宽度都等于 `node.size[0]`（LiteGraph 的 size setter 不触发 `onResize`，
  插件在 `onConfigure` 补同步）。
- `paint-panel-layout.e2e.mjs` — 绘画页文生图面板与 chip 浮层的布局不变量：结果区吃掉输入卡上方的余隙、
  进度与成品贴着输入卡往上长（空档不足时内容从容器顶部铺开、起手提示落在那片余隙正中）；浮层右栏的
  LoRA 下拉拿到列的余宽，强度与 ✕ 不掉行。纯前端：注入 `web/studio/style.css`、`web/gallery.css`、
  `web/prompts.css` 与真实同构 DOM，不需要 ComfyUI 在跑。
