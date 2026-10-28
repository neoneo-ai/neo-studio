# tools/ 规则（离线开发与发布脚本）

本层独有的规则。跨层规则与产品不变量在 [../AGENTS.md](../AGENTS.md)，本文件不复述它；
路径占位与数据根解析归根文件（Docs Discipline、Architecture Boundaries），
包边界与删除规则归根文件（Data, Config, and Secrets）。
exe 里随包的插件副本只取 `studio/` 的跟踪文件，`tools/` 不在其中。

## Script Groups

- 素材管线：`build_gallery_presets.py` → `gallery_preprocess.py` → `gallery_deploy_oss.py`，
  配套 `format_tags.py`、`profile_gallery.py`。
- 打包与安装：`build_studio_exe.ps1`（`Neo-Studio.spec`）、`install_plugin.ps1`、
  `mcp_setup.ps1`。
- 摆姿包：`build_pose_package.ps1` 生成随包最小副本 `studio/pose_dist/`，`sync_pose_dist.ps1`
  把全量产物同步进 `<数据根>/pose/dist/`，`test_pose_package.ps1` 复查随包那份（发货清单逐文件核对）。
- 取证与性能：`e2e_ref_grid.mjs`、`bench-director-timeline.mjs`、`capture-gif.mjs`、
  `capture-video.mjs`；`_hub_check.py`、`check_h3_context_layout.py` 是排查脚本。
- 热同步：`watch_web.py`，同步语义与 `app/studio_app.py` 的 `sync_plugin()` 一致，
  细则见 [../app/AGENTS.md](../app/AGENTS.md)。

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
  `build_pose_package.ps1`（只有 CC0 的 `ybot.glb`），加一份要先有可再分发的授权行；道具注册表
  `models/props/index.json` 清空 `props` 数组，与「不随包发道具 GLB」是同一件事。
- `*.map` 不进包，`studio/pose_dist` 里的 JS 要清掉开发机绝对路径（注册表的 `sourceImage` 与
  「引号 + 盘符 + 斜杠」的字面量），清不掉就回摆姿仓库改注册表，不在这里打补丁。
- `MANIFEST.json` 逐文件 `bytes` + `sha256`，清单不含它自己（一份清单算不出自己的哈希）；
  `test_pose_package.ps1` 按同一口径核对，体积上限（4.5MB）与白名单在这两条里各钉一遍。
- `sync_pose_dist.ps1` 的 `robocopy /MIR` 只动 `dist/`：源产物里没有的文件（用户导入的素体 GLB）
  先存进临时目录、镜像完搬回，同步脚本不许成为删用户文件的那只手。场景与参考图在 `pose/` 下的
  别的目录，本来就不在镜像范围内。

## Validation

脚本从仓库根运行，相对路径才成立：

```
pwsh tools\build_studio_exe.ps1 -DryRun          # 只验打包清单，不出 exe
pwsh tools\build_pose_package.ps1 -Source <3d-pose-art 仓库根> -Build
pwsh tools\test_pose_package.ps1                 # 随包摆姿包自检：清单哈希、白名单、体积上限
python tools\gallery_preprocess.py --output <dir> --dirs <dir1>
node tools\e2e_ref_grid.mjs                       # 需本机 ComfyUI 在 8188
```
