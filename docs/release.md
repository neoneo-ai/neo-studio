# 发布与离线工具

总入口见 [../Developer.md](../Developer.md)。

## 发布

### 打包范围

`.comfyignore`（gitignore 语法）决定 Registry 包里有什么：comfy-cli 取 git 已跟踪文件减去这里的条目。
`tests/`、`tools/`、`.github/`、`.vscode/`、`test-results/`、`pytest.ini`、`package.json` 等开发文件被排除；
运行时 `.py`、`web/`（含 `web/docs/` 节点帮助）、`configs/`、`skills/`、`prompts/`、`example_workflows/`
与 README/LICENSE/pyproject/requirements 留在包里。未跟踪的本地文件（`node_modules/`、`tmp/`、
gallery 缓存、`configs/backyard_oss.json`）已被 `.gitignore` 排除，无需在此重复。
应用仓库的 `README_ZH.md`、`Developer.md` 与 `docs/` 在 `studio/` 之外，不进 Registry 包。

Registry 安装只读 `pyproject.toml` 的 `dependencies`，`requirements.txt` 供 ComfyUI-Manager 与开发环境使用，
两边需保持一致；可选增强（`laya` / `pillow-heif` / `oss2`）写在 `[project.optional-dependencies]`。

Registry 与前端搜索的命中靠 `pyproject.toml` 的 `description` / `keywords`，以及节点自身的
`SEARCH_ALIASES`（约定见 [architecture.md](architecture.md) 的「节点元数据」，由 `tests/test_node_metadata.py` 校验）。

「3D 摆姿」随包发的那份产物在 `studio/pose_dist/`（git 已跟踪，`tools\build_pose_package.ps1` 生成，
约 3.0MB：代码 + 页面默认基座的 CC0 标准素体 `bodyMale.glb` / `bodyFemale.glb` + 自制道具 `props/stick.glb` / `props/sword.glb` + `LICENSE` / `THIRD-PARTY.md` / `models/ATTRIBUTION.md` /
逐文件 sha256 的 `MANIFEST.json`）。数据根那份全量产物在 `data/pose/dist/`，`data/` 不进包，用户写的
场景、参考图与自备素体 GLB 也都落在那里。发什么由摆姿仓库 `models/ATTRIBUTION.md` 的授权口径决定
（Mixamo 与 SMPL 派生素体不入库），发完用 `tools\test_pose_package.ps1` 逐文件核对清单与体积上限，
口径见 [studio-pose.md](studio-pose.md)。清单比的是字节，仓库根 `.gitattributes` 把整棵 `pose_dist/`
钉成不转换行尾（`-text`，GLB / wasm / ktx2 记 binary）：`core.autocrlf=true` 的机器 checkout 出来的
文本带 CRLF，那份包的字节数与 sha256 就会全对不上，自检会指着正常的包报错。

### Git Action 方式

- Registry 元数据在 `studio/pyproject.toml` 的 `[tool.comfy]`（PublisherId `neoneo-ai`，DisplayName `Neo Studio`）。
- `.github/workflows/publish.yaml`：推送 `v*` tag、发布 Release 或手动触发时，在 `studio/` 里跑
  `comfy node publish --token`（需要 `COMFY_REGISTRY_PUBLISH_TOKEN` secret）。发布必须在那一层跑：
  `pyproject.toml` 与 `.comfyignore` 都在 `studio/`，仓库根的 `pyproject.toml` 是桌面端自己的清单。

```bash
# 1. 改版本号（例如改成 1.0.1）：编辑 studio/pyproject.toml 里的 version = "1.0.1"
git add studio/pyproject.toml
git commit -m "Bump version to 1.0.1"

# 2. 打 tag（指向这个新 commit）
git tag v1.0.1

# 3. 推送代码 + tag，触发发布
git push origin main v1.0.1
```

### comfy cli 方式

```bash
cd studio
comfy node publish    # 按提示输入 API TOKEN
```

## 桌面版与源码安装

```powershell
# 桌面端打包：onefile 单文件 / onedir 目录版 / both；副本 = studio 的 git 已跟踪文件
tools\build_studio_exe.ps1 [-Mode onefile|onedir|both] [-DryRun]
tools\build_studio_exe.ps1 -Mode both -Sign -CertThumbprint <指纹>   # signtool 签名 + verify
tools\build_studio_exe.ps1 -Notarize -AppleTeamId <TeamID>          # macOS notarytool（只能在 mac 上）
tools\build_studio_exe.ps1 -Publish                                  # comfy node publish

# macOS remote-only 打包：PyInstaller .app，产物 tools/Neo-Studio.app
# 需要构建期依赖 PyInstaller；可在仓库根运行
bash tools/build_studio_mac.sh

# 源码安装内核插件：只装代码与内置预设，写好 configs/data_root.json 数据根指针，不删目标目录里的东西
# 脚本是 UTF-8 无 BOM，用 pwsh（PowerShell 7）跑；Windows PowerShell 5.1 会把中文注释读成乱码
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/install_plugin.ps1 -ComfyUI <ComfyUI 根> -DataRoot <数据根> [-SkipDeps] [-DryRun]
```

**改完 `app/studio_app.py` 必须重新打包。** 源码运行桌面端时每次启动把 `studio/` 同步进
`custom_nodes`（只覆盖同名文件，不删目标目录里的东西）；exe 只在内置副本版本更新时才替换插件目录，
git 检出的那份不碰。

窗口与任务栏图标是拍板造型的 `web/neo-studio.ico`（`tools/make_studio_icon.py` 生成），启动器打包时带同款图标。

### Release 工作流

`.github/workflows/release-app.yml` 在打 `v*` tag 时（或手动触发）在 `windows-latest` 上跑同一条
`build_studio_exe.ps1`，把产物挂到该 tag 的 GitHub Release：

- `Neo-Studio-<版本>-windows-x64.exe` —— onefile 单文件，约 52 MB
- `Neo-Studio-<版本>-windows-x64-portable.zip` —— onedir 整包压缩（`Neo-Studio.exe` + `_internal/`，
  解压后整目录直接用，启动不解包、出窗口更快）

默认 `both`，两种形态一起挂上 Release；手动触发只想出一种时把 `mode` 填成 `onefile` 或 `onedir`。

版本号只有一个源：`studio/pyproject.toml`（`util.plugin_version()` 读的就是它）。tag 触发直接用 tag 名，
手动触发读同一份文件；根 `pyproject.toml` 只声明桌面端依赖，不参与命名。

macOS remote-only `.app` 目前不在 GitHub Actions 里发布，本地用 `bash tools/build_studio_mac.sh` 打包，
产物在 `tools/Neo-Studio.app`；首次运行可能遇到 Gatekeeper 提示，本地未签名构建可先右键「打开」或
`xattr -dr com.apple.quarantine tools/Neo-Studio.app`。

产物是未签名版，首次运行会有 SmartScreen 提示；签名与公证仍走本地 `-Sign` / `-Notarize`（CI 里没有
机器证书，也不在 mac 上跑）。Registry 发布由 `publish.yaml` 负责，两条工作流互不依赖。

CI 打包固定 Python 3.12，与本地验证过的构建一致。

### CLR 托管兜底

桌面端的窗口是 pywebview 的 WinForms 后端，要 pythonnet 把 .NET 托管起来。部分机器上 .NET Framework（netfx）
托管起不来——AppDomain 里解析不到 `Python.Runtime.Loader.Initialize`，窗口开不出来。桌面端在 `webview.start()`
前自己 `import clr`，失败就把 `pythonnet` 的 runtime 覆盖成 coreclr 再加载一次：pywebview 自带的 coreclr
兜底在 pythonnet 3.x 上是失效的（netfx 的 runtime 对象已经占住 `pythonnet._RUNTIME`，改环境变量再 import
走的还是那个坏掉的 netfx）。coreclr 要的是桌面运行时（`System.Windows.Forms` 在
`Microsoft.WindowsDesktop.App` 里），随包带的配置是 `tools/coreclr.runtimeconfig.json` → `_internal/runtime/`。
切换会记一行 `clr switched to coreclr` 到 `data/studio_desktop.log`。

## 最小整合包

`tools\build_minimal_package.ps1` 产出一个「装完就能跑、模型自己放」的整合包：ComfyUI 核心 + 清单里锁 commit 的
必需插件 + Neo Studio（App 源码与装好的插件副本）+ 便携 Python + 相对路径启动器。

- 随包发：`ComfyUI\`（排除 `.git`、`custom_nodes`、`user`、`output`、`input`、`temp`）、清单里的必需插件、
  `Neo-Studio\`（排除 `.venv` 与 `data`）、`studio/` 复制成 `ComfyUI\custom_nodes\comfyui-neo-studio\`（排除 `tests`）、
  便携 Python、空的 `ComfyUI\models\` 目录树，以及只指包内相对路径的 `extra_model_paths.yaml`。
- 不随包发：模型与权重（含 `comfyui_controlnet_aux\ckpts` 预打包 annotator 模型与
  `comfyui_fl-cosyvoice3\FL_CosyVoice3` 这两处插件自带权重）、`.git`、`__pycache__`、`user` 数据、用户数据根、
  密钥文件（`remote_llm_config.json`、`backyard_oss.json`）、带开发机盘符的路径，以及 `comfyui-krea2edit`。
- 必需插件按内置预设用到的节点定：`tools\minimal_plugins.json` 写死 commit、插件提供的节点名与用到它的预设 ——
  `comfyui_controlnet_aux`（AIO_Preprocessor）、`ComfyUI-VDN-H3`（ApplyVDNH3Advanced）、
  `comfyui_fl-cosyvoice3`（FL_CosyVoice3_*）。`ResolutionSelector`、`TextEncodeQwenImage21`、`MiniMaxH3*`、
  `CreateVideo` 这些在 ComfyUI 0.44.0 是核心节点，不为它们装插件。
- 依赖在构建时装进包内那个 `python\`：`torch` + CUDA、`ComfyUI\requirements.txt`、`studio\requirements.txt`、
  桌面 App 的 `pyproject.toml` 依赖、每个必需插件的 `requirements.txt`，桌面 App 与内核共用它，包开箱即用。
  `setup_runtime.bat` / `setup_app.bat` 是换掉 `python\` 之后或缺依赖时的修复路径，`-SkipPluginDeps` 跳过预装。
  pip 带的约束是包内已装版本（`pip list --format=freeze`）：不钉版本时 `mediapipe` 要求的 `numpy<2` 会把 numpy
  降级，`pyarrow` 当场导入不了；带约束解不动的那几条退化成 `--no-deps` 只装清单里列的包。启动器只认包内
  `python\pythonw.exe`，并把 `PYTHONUTF8=1` 传给子进程（打印非 ASCII 的插件在 GBK 控制台下导入会失败）；
  复用已装好的可移植 Python 用 `mklink /J python "<可移植 Python 根目录>"`，包内 `python\` 已是链接时构建不复制不清它。
- 自检分两级：`tools\check_minimal_package.py` 扫 `NODE_CLASS_MAPPINGS` 与 `node_id=` 注册，比对预设用到的节点，
  整包模式还核对布局、空 models 树、盘符路径、密钥文件、`comfyui-krea2edit` 痕迹，以及清单 `import_smoke`
  里的依赖在包内 python 里 import 得出（`import_notes` 点过名的模块只报说明）；`tools\verify_minimal_package.ps1`
  在它之上核对清单插件、随包预设集与安装脚本。预设与被排除插件节点的一致性由 `studio/tests/test_minimal_package.py` 钉住。
- 打包用哪份源码由 `-StudioSource` 决定：默认当前工作树，发版口径填 tag 检出的 worktree，整包就按那份代码出。
- 整合包更新件 `Neo-Studio-<version>-package-update.zip` 由 `tools\build_studio_update.ps1` 出，随 Release 一起发；
  包内入口是 `Neo-Studio\tools\update_neo_studio.ps1`：从 GitHub Release 取更新件，只刷包内 `Neo-Studio\`（App 源码、
  `studio` 副本、`tools` 脚本、启动脚本）与 `ComfyUI\custom_nodes\comfyui-neo-studio\` 的代码副本，再补一次依赖、
  跑一遍整包自检。ComfyUI 核心、清单插件、包内 python、模型与用户数据都不动；更新不删任何文件，被覆盖的文件先进
  包根 `updates\backup-<旧版本>\`，插件副本的 `data_root.json` 指针排除在覆盖之外。连不上 GitHub 的机器用
  `-Zip <更新件.zip>` 指定已下好的更新件。

```powershell
pwsh tools\build_minimal_package.ps1 -DryRun              # 只打印要做的事，不写文件
pwsh tools\build_minimal_package.ps1 -Target <包根>       # 复制整包（-PluginMode git 按清单 clone）
python tools\check_minimal_package.py --comfyui <ComfyUI root> --studio <repo root>\studio
python tools\check_minimal_package.py --package <包根>    # 整包体检
pwsh tools\verify_minimal_package.ps1 -Package <包根>     # 自检 + 清单/预设/脚本验收
pwsh tools\build_minimal_package.ps1 -StudioSource <worktree 根>   # 按 tag 检出的那份源码打包
pwsh tools\build_studio_update.ps1 -DryRun        # 整合包更新件：只打印计划（产物默认落 build\，Release 里指到 dist\）
pwsh Neo-Studio\tools\update_neo_studio.ps1 -DryRun      # 在包根跑：只打印更新要做的事
```


## 离线工具

`tools/` 下的脚本用于构建 / 部署素材预设，不在 ComfyUI 运行时加载：

```bash
# 0. 素材包整理：把素材汇总包整理成预设目录（图 + 同名 .txt 旁车 + 角色索引.txt），包配置见 --list
python tools/build_gallery_presets.py --list
python tools/build_gallery_presets.py --pkg <云端目录名> [--out <预设根>] [--compress 0.25] [--sample 5]
#    --compress 0.25 把图片压到原字节数的四分之一（JPEG 逐档降质量，压不到目标再缩边）：
#    3D 三视图那几包是 8-10 MB 一张的 PNG，一包 200 张就是 2 GB，上传和首屏拉取都吃这个体积

# 1. 预处理：扫描预设目录，生成缩略图与 index.json（需要 ffmpeg 生成视频缩略图）
python tools/gallery_preprocess.py --presets <presets_dir> --output <output_dir> [--size 320]

# 增量模式：只新增/更新指定子目录（源目录中已删除的文件会同步清理），
# 自动从 OSS 拉取最新 index.json（configs/oss_presets.json -> index_url）作为合并基准，
# 其余目录保持不变；--no-fetch-index 改为与本地 index.json 合并，--fetch-index <url> 显式指定来源。
# --presets 可省略：默认使用当前工作目录（把新增/更新的目录放在该目录下即可）
cd <dir_with_new_dirs> && python tools/gallery_preprocess.py --output <output_dir> --dirs dir1 dir2

# 分批发布：--draft 只写目录索引 <dir>/index.json，主索引不动，素材库还看不到；
# --publish 把已写好的目录索引挂进主索引（不重扫素材）。
python tools/gallery_preprocess.py --output <output_dir> --dirs dir1 dir2 --draft
python tools/gallery_preprocess.py --output <output_dir> --publish dir1 dir2

# 旧版整包索引拆成分层索引：--split-legacy 把带 items 的 index.json 拆成 <dir>/index.json + v2 主索引
python tools/gallery_preprocess.py --output <output_dir> --split-legacy

# 只改标签：--tag-dirs 给主索引里已有的目录打 / 清标签，不重扫素材、不动目录在首页的板块位置
# （tags 是目录属性、一个目录可以有多个；主索引没列出的目录标签原样保留）
python tools/gallery_preprocess.py --output <output_dir> --tag-dirs dir1 dir2 --tag character-sheet
python tools/gallery_preprocess.py --output <output_dir> --tag-dirs dir1 --clear-tags

# 2. 部署：上传预处理产物到阿里云 OSS（需要 pip install oss2，
#    凭证从环境变量 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_ENDPOINT 读取）
python tools/gallery_deploy_oss.py --source <output_dir> --bucket <bucket> --prefix <prefix>
```

预处理产物是分层的索引：`index.json` 是 v2 主索引（每个目录一条 `count` / `index` / `rev` / `covers`），
每个目录的完整 items 在 `<dir>/index.json`，素材副本与缩略图在 `<dir>/`、`thumbnails/<dir>/`。
部署脚本递归上传整个输出目录，目录索引随素材一起上传，`.json` 不带长缓存头，索引改动立刻生效。
部署后的 OSS 源通过 `configs/oss_presets.json` 配置，运行时由 `gallery_oss.py` 拉取到 `gallery/oss_cache/`。

Backyard 页面（`/neo-studio-backyard`）走同一套增量语义：预处理页的源目录按数据根解析，源目录内直接放素材
（`data/gallery/presets_src/仙侠玄幻人物` 这种单个预设目录）时按增量处理；增量合并基准优先取
`configs/oss_presets.json -> index_url` 的云端 `index.json`，拉不到才回退输出目录里的本地 `index.json`，
所以本地从没跑过预处理也不会把云端其余目录冲掉。勾选「完成后上传 OSS」会在预处理后接着上传，
ETag 相同的文件跳过；上传的 key 前缀会补尾部 `/`，前缀写成 `/neo/presets` 也对得上云端的
`neo/presets/index.json`。上传写入新文件后会强刷一次素材库的云端索引缓存（与 `/neo_gallery/sync_oss`
同源），新目录立刻出现在素材页；不刷的话要等 `sync_interval_hours`（默认 24 小时）缓存过期才看得见。
素材库「Manage Directories」弹窗标题栏的「⟳ 刷新索引」走同一个接口，随时可以手动强刷这份云端索引缓存。

上传页打开先列一份待上传清单（`GET /neo_backyard/upload_plan`）：每个目录的条目数、要传的文件数与体积，
按云端主索引比对出「待上传」（云端没有这条）、「已更新待传」（`rev` 与云端不同，旧版整包索引没有 `rev`，
重扫过的目录都算）、「未发布」（`--draft` 只写了目录索引，主索引还没这条）、「已同步」四种状态，
汇总行给出待传的目录数、文件数与总字节；云端索引没缓存时全部按待上传列并说明无从比对。
上传与预处理的输出走 SSE 逐行推送，进度条跟着每行 `[i/total]` 刷新，跑完清单自动重取一次。
