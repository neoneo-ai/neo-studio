# app/ 规则（桌面端）

本层独有的规则。跨层规则与产品不变量在 [../AGENTS.md](../AGENTS.md)，本文件不复述它；
Python 写法（SPDX 头、原子写配置、`_json_safe()`、注释纪律）与插件同源，写在
[../studio/AGENTS.md](../studio/AGENTS.md) 的 Python Style。
能力表决定"桌面端能答什么"这条属于根文件的 Architecture Boundaries。
窗口管道的权威规格是 [../docs/studio-desktop.md](../docs/studio-desktop.md)，按它实现，不在两处写同一条规则。

## Desktop App

- The window comes first. Opening the app unpacks and creates the window; the
  self-check, the offline service, and the ComfyUI launch run on a background thread. The
  landing points are the full Studio page, the offline asset page, and the startup page.
- Port conventions: ComfyUI on 8188, the desktop asset service
  on the ComfyUI port plus `DESKTOP_PORT_OFFSET`, the cold-start e2e port
  on `NEO_STUDIO_STOP_PORT`. Never stop the user's own ComfyUI on 8188: the
  kernel start/stop controls act only on the instance the desktop app launched.
- The cold-start page stays on the desktop port and connects generation in place when ComfyUI
  gets ready; a full-page navigation or a reload clears the director editor and the settings
  forms, so the ready path never navigates. Direct mode is on only for the loopback-only ComfyUI
  the desktop spawned itself (`StudioDesktop.direct`) and must share its condition with
  `comfy_cors()`: ComfyUI's `--enable-cors-header` replaces its origin_only middleware, so
  without the flag the page's cross-origin requests are 403, and the flag is never given for
  LAN listen or remote mode, where the navigation path stays.
- The single-instance lock is a named mutex that lives until the process
  exits. Do not implement it as a port listener: a listener on 8189 shows up in
  `netstat` and reads to users as a second ComfyUI that survives the window close.
- Closing the window stores the geometry and reaps the ComfyUI child the app started.
  A close that lands during the launch cancels the launch that just started, so the
  app never leaves an orphan ComfyUI behind. That covers the child this session spawned;
  a child an earlier session spawned and an interrupted teardown left behind is claimed
  through the `data/comfy_child.json` marker (pid + port, the port re-checked before the
  kill), while a ComfyUI the user started has no marker and is never stopped. `kill_pid()`
  declares `OpenProcess`'s `restype` explicitly, or the 64-bit handle is truncated and the
  kill fails silently.
- `pythonw` has no console and its `stderr` is `None`. A console
  logging handler interrupts window creation, so desktop logging goes to
  `data/studio_desktop.log` and the pywebview handlers stay console-free.
- Plugin sync copies same-name files from `studio/` into `custom_nodes` and deletes
  nothing in the target. A git checkout is never overwritten; the bundled copy replaces
  an installed copy only when its version is newer, and skips when the directory is busy.
  `tools/watch_web.py` hot-syncs `studio/web/` with the same semantics, so a frontend
  edit lands on a page reload instead of a relaunch.
- "Save and restart" writes the whole launcher config in one write: root, interpreter,
  port, the toggles, and the remote address together, so a stored setting can never be
  dropped by a partial save.
- Window plumbing is specified in [docs/studio-desktop.md](../docs/studio-desktop.md): dev
  mode and the WebView2 accelerator keys, LAN listen and `comfy_listen()`, remote ComfyUI
  and `comfy_remote()`, the Job Object close chain, the frozen-build root and `_MEIPASS`
  resolution, and the `%APPDATA%` state-directory fallback. Implement to that doc; do not
  restate one rule in two places.

## Adding a Route

1. 把条目加进 `app/studio_caps.py` 的能力表——表外一律 `409 offline`。同一张表也是 pinned 页面取用的
   请求归属清单（`/neo_studio/version` 里的 `route_list()`），前端不再留第二份拷贝。
2. 桌面服务要离线提供它，就在 `app/tests/test_studio_server.py` 加用例。
3. 被复用的 handler 模块自带 `web.RouteTableDef` 且不得碰 ComfyUI 运行时，这条约束写在
   [../studio/AGENTS.md](../studio/AGENTS.md) 的 Architecture Boundaries。
4. 前端在能力缺失时要显示不可用，控件不能只回失败——这条在根文件的 Product Surface。

## Testing

- New routes get an entry in `app/studio_caps.py` and a case in
  `app/tests/test_studio_server.py` when the desktop service must serve them offline.

## Validation

`app/tests` 需要同级 `../ComfyUI`（`folder_paths` 与真实产物），桌面用例在开发机跑，不进 CI：

```
python -m pytest -q app/tests
pwsh tests\run-tests.ps1
python app\studio_app.py          # 真开窗口；等价于 npm run e2e:app 那条用例
```
