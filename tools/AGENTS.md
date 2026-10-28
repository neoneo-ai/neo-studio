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

## Validation

脚本从仓库根运行，相对路径才成立：

```
pwsh tools\build_studio_exe.ps1 -DryRun          # 只验打包清单，不出 exe
python tools\gallery_preprocess.py --output <dir> --dirs <dir1>
node tools\e2e_ref_grid.mjs                       # 需本机 ComfyUI 在 8188
```
