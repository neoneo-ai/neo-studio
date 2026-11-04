# tools/ 规则（离线开发与发布脚本）

本层独有的规则。跨层规则与产品不变量在 [../AGENTS.md](../AGENTS.md)，本文件不复述它；
路径占位与数据根解析归根文件（Docs Discipline、Architecture Boundaries），
包边界与删除规则归根文件（Data, Config, and Secrets）。
exe 里随包的插件副本只取 `studio/` 的跟踪文件，`tools/` 不在其中。

## Script Groups

- 素材管线：`build_gallery_presets.py` → `gallery_preprocess.py` → `gallery_deploy_oss.py`，
  配套 `format_tags.py`、`profile_gallery.py`。
- 打包与安装：`build_studio_exe.ps1`（`Neo-Studio.spec`）、`build_studio_mac.sh`
  （macOS remote-only `.app`）、`build_studio_update.ps1`（整合包更新件，`update_neo_studio.ps1` 在包内消费它）、
  `install_plugin.ps1`、`mcp_setup.ps1`。
- 摆姿包：`build_pose_package.ps1` 生成随包最小副本 `studio/pose_dist/`，`sync_pose_dist.ps1`
  把全量产物同步进 `<数据根>/pose/dist/`，`sync_pose_lib.ps1` 把场景库同步进 `<数据根>/pose/lib/`，
  `test_pose_package.ps1` 复查随包那份（发货清单逐文件核对）。
- 取证与性能：`e2e_ref_grid.mjs`、`bench-director-timeline.mjs`、`capture-gif.mjs`、
  `capture-video.mjs`；`_hub_check.py`、`check_h3_context_layout.py` 是排查脚本。
- 热同步：`watch_web.py`，同步语义与 `app/studio_app.py` 的 `sync_plugin()` 一致，
  细则见 [../app/AGENTS.md](../app/AGENTS.md)。
- 最小整合包：`build_minimal_package.ps1` 生成整包，`check_minimal_package.py` 核对节点与整包，
  `verify_minimal_package.ps1` 在自检之上做验收；插件与 commit 的钉版口径在 `minimal_plugins.json`。


## Gallery Preset Pipeline

产物是 `<数据根>/gallery/presets/<云端目录>/`，一张图 + 同名 `.txt` 旁车；`studio/gallery.py`
读旁车、灯箱按「标签：值」分段、`/neo_gallery/txt` 读全文，`gallery_preprocess.py` 生成
webp 缩略图与 `index.json`，`gallery_deploy_oss.py` 按 `OSS_ACCESS_KEY_ID` /
`OSS_ACCESS_KEY_SECRET` / `OSS_ENDPOINT` 上云。这条链是三处加消费端：改命名、改旁车格式、
改云端目录名，要在同一个改动里改 `studio/gallery.py` 与 `studio/configs/oss_presets.json`。

## Packaging

- Non-ASCII filenames in packaging scripts must go through
  `git ls-files -z`; default output escapes them into fake names.
- 打包两步都在 `build_studio_exe.ps1` 里：先按 git 跟踪列表把 `studio/` 复制成
  `build/bundled/comfyui-neo-studio`，再按 `Neo-Studio.spec` 打进 `_MEIPASS`。
  跟踪列表减去 `studio/.comfyignore` 就是包内容，改包边界要同时改那份 ignore 文件。
- 发布流程、签名与公证在 [../docs/release.md](../docs/release.md)。

## Pose Package

摆姿页产物有两级落点，两个脚本各管一级，`test_pose_package.ps1` 复查随包那一级：

- 随包发什么由摆姿仓库 `models/ATTRIBUTION.md` 的授权口径决定，不由体积决定：GLB 白名单写死在
  `build_pose_package.ps1`（素体只有 CC0 的 `ybot.glb`，道具只有自制的 `stick.glb` / `sword.glb`），
  加一份要先有可再分发的授权行；道具注册表 `models/props/index.json` 只留随包发了的那几条，
  与「本地导入的道具 GLB（arrow / sting-sword / 枪械）不随包发」是同一件事。
- `*.map` 不进包，`studio/pose_dist` 里的 JS 要清掉开发机绝对路径（注册表的 `sourceImage` 与
  「引号 + 盘符 + 斜杠」的字面量），清不掉就回摆姿仓库改注册表，不在这里打补丁。
- `MANIFEST.json` 逐文件 `bytes` + `sha256`，清单不含它自己（一份清单算不出自己的哈希）；
  `test_pose_package.ps1` 按同一口径核对，体积上限（4.5MB）与白名单在这两条里各钉一遍。
- `sync_pose_dist.ps1` 的 `robocopy /MIR` 只动 `dist/`：源产物里没有的文件（用户导入的素体 GLB）
  先存进临时目录、镜像完搬回，同步脚本不许成为删用户文件的那只手。场景与参考图在 `pose/` 下的
  别的目录，本来就不在镜像范围内。
- 场景库只落 `<数据根>/pose/lib/`，不进随包副本（授权口径与摆姿包不同）：`sync_pose_lib.ps1` 按
  `-Light`（skeleton + silhouette）/ 默认（clay + skeleton + silhouette）/ `-All`（四档）镜像预览，
  `index.json` 由摆姿仓库的 `npm run lib` 生成、同步原样带过去。`pose/scenes`、`pose/refs`、
  `pose/presets` 是用户写的东西，同样不在镜像范围内。

## Minimal Package

整合包 = ComfyUI 核心 + 清单插件 + Neo Studio + 便携 Python + 相对路径启动器，口径只有一处：

- `minimal_plugins.json` 是插件与 commit 的唯一来源：预设用到的节点决定装哪几个插件，条目写 commit、插件提供的
  节点名与用到它的预设。预设开始用一个新插件的节点，就在同一个改动里加清单条目，并让
  `studio/tests/test_minimal_package.py` 过；被排除插件的节点出现在任何预设里，那条预设就不能发。
- 打包用哪份源码由 `-StudioSource` 决定（默认当前工作树，发版口径填 tag 检出的 worktree）。整合包更新件由
  `build_studio_update.ps1` 出：zip 条目 = 仓库相对路径，边界就是整包复制 `Neo-Studio\` 的那一份，
  `docs/`、`Developer.md`、`.github/`、测试与开发目录不进更新件。`update_neo_studio.ps1` 是包内更新入口：
  从 GitHub Release 取更新件，只刷 `Neo-Studio\` 与插件代码副本，robocopy 不带 `/MIR`（整合包不删东西）、
  `data_root.json` 指针排除在覆盖之外、被覆盖的文件先进包根 `updates\backup-<旧版本>\`，更新完跑整包自检。
- 依赖在构建时装进包内 `python\`（torch + CUDA、ComfyUI 与每个插件的 `requirements.txt`、App 的
  `pyproject.toml` 依赖），包开箱即用，`setup_runtime.bat` / `setup_app.bat` 只是换掉 `python\` 之后的修复路径，
  `-SkipPluginDeps` 跳过预装。pip 的约束取包内已装版本：不钉版本时 `mediapipe` 要的 `numpy<2` 会降级 numpy、
  `pyarrow` 随之废掉；带约束解不动的清单退化成 `--no-deps` 只装清单点名的包。`Copy-Tree -Mir` 只给 `python\` 用
  （重建时清掉上一次降级出来的包），包内 `python\` 已是 `mklink` 链接时不复制不清它。
  清单的 `import_smoke` 是依赖底线：整包自检在包内 python 里真 import 一遍；当前环境导入不了、又认下来的模块
  写进 `import_notes` 讲清原因，自检只报说明不跑它。
- 模型与插件自带权重都不随包发（`comfyui_controlnet_aux\ckpts`、`comfyui_fl-cosyvoice3\FL_CosyVoice3`），
  `ComfyUI\models\` 只发空目录树，`extra_model_paths.yaml` 只写包内相对路径，值必须是字符串。
- 启动器与安装脚本写死相对路径：VBS 从当前目录算包根，BAT 用 `%~dp0`。启动器与 BAT 文件名用 ASCII ——
  中文名在 cmd 代码页下会被读成乱码；带中文的 VBS 必须是 UTF-16 带 BOM，WSH 才认。启动器给子进程
  `PYTHONUTF8=1`。
- 包里的 `data_root` 指针必须落包内；密钥文件、带盘符的开发机路径、`.git`/`__pycache__`/`user`/数据根、
  以及清单 `excluded` 里的插件都不能进包。
- 复制走 robocopy（`/COPY:DAT` + `/XD` `/XF`），顶层排除项给全路径（`/XD models` 会连 `comfy\ldm\models`
  一起排掉），退出码 8 以上才是失败；`git` 模式 clone 完要 checkout 到清单 commit 并核对落点。

  `index.json` 由摆姿仓库的 `npm run lib` 生成、同步原样带过去。`pose/scenes`、`pose/refs`、
  `pose/presets` 是用户写的东西，同样不在镜像范围内。

## Validation

脚本从仓库根运行，相对路径才成立：

```
pwsh tools\build_studio_exe.ps1 -DryRun          # 只验打包清单，不出 exe
bash tools/build_studio_mac.sh                   # macOS remote-only .app；需 PyInstaller
pwsh tools\build_pose_package.ps1 -Source <3d-pose-art 仓库根> -Build
pwsh tools\test_pose_package.ps1                 # 随包摆姿包自检：清单哈希、白名单、体积上限
pwsh tools\build_minimal_package.ps1 -DryRun     # 最小整合包：只打印要做的事
pwsh tools\build_studio_update.ps1 -DryRun        # 整合包更新件：只打印计划（默认写 build\Neo-Studio-<version>-package-update.zip）
pwsh tools\verify_minimal_package.ps1 -Package <包根>   # 整包自检 + 清单/预设/安装脚本验收
pwsh tools\update_neo_studio.ps1 -Package <包根> -DryRun   # 整合包更新：只打印要做的事
python tools\gallery_preprocess.py --output <dir> --dirs <dir1>
node tools\e2e_ref_grid.mjs                       # 需本机 ComfyUI 在 8188
```
