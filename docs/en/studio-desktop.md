# Studio Desktop

The desktop puts the Studio page in a local window: it starts ComfyUI itself and serves a local Studio service on the
ComfyUI port +3 (`app/studio_server.py`, a process with no ComfyUI runtime; the file read/write routes are served
there as usual), so browsing assets and editing recipes and skills keep working while ComfyUI is not running.
Source runs and the packaged exe go through the same `app/studio_app.py`.

## Components

| File | Responsibility |
|------|----------------|
| `app/studio_app.py` | Window, self-check, start / stop ComfyUI, frameless window, close teardown, startup settings |
| `app/studio_server.py` | Desktop-side aiohttp service (ComfyUI port +3, `DESKTOP_PORT_OFFSET`); loads the plugin modules' own `RouteTableDef` handlers by directory |
| `app/studio_caps.py` | Capability table: which routes the desktop service owns; everything outside answers `409 offline` |
| `data/` | State directory: `studio_window.json` (geometry), `studio_profile` (WebView2 profile / localStorage), `launcher_config.json` (root / python / port / frameless / dev_mode / listen / remote), `studio_desktop.log`, `comfy_run.log` |

Source runs keep state in the repository's `data/`; the exe prefers `data/` beside the exe and falls back to
`%APPDATA%\Neo Studio` when the exe sits in a non-writable directory.

## Offline gating

The test is "file read/write / local lookup / remote download / the 8080 LLM service only"; anything needing the
execution queue, VRAM, or node definitions belongs to ComfyUI. The feature-flag table ships with
`/neo_studio/version`, and Studio gates only the run-type buttons (generate / run segment / assemble); recipe
editing, skill editing, settings and LLM configuration never need the ComfyUI runtime. Route list:
[api-routes.md](api-routes.md).

When the desktop service reads model directories it loads the kernel's `extra_model_paths.yaml` itself
(`build_app()` calls ComfyUI's `utils.extra_config.load_extra_path_config`): only ComfyUI's `main.py` reads
that file, so a desktop process that skips it scans nothing but `<root>/models/` in `get_filename_list`, and on
a machine whose models live in an extra path (this pack ships `base_path: F:\`, models under `F:\models\`) the
offline model dropdown comes back empty and every model path saved in a skill is flagged "(missing)".

The main canvas (the ComfyUI page) is an SPA: the page stays alive after the process stops, the canvas stays
editable, and nothing written there reaches any execution. `studio/web/canvas-lock.js` uses the frontend's own
connection events as the signal — an empty `status` / `reconnecting` means the backend is gone, `reconnected` /
a `status` payload means it is back — and confirms with a `/system_stats` probe before locking, so a websocket
blip never locks the canvas. Once confirmed it applies the frontend's own canvas lock (`LGraphCanvas.read_only`,
the same one `Comfy.Canvas.Lock` uses): panning keeps working, node dragging / resizing / widget editing / the
right-click add-node menu stop, and a bottom bar reads "🔒 ComfyUI is not running · canvas is read-only".
While offline it re-probes every 3 seconds; recovery unlocks the canvas and restores the lock state the user had set.

The offline page runs on the desktop-side service, and the skill detail's "⤒ Edit in main canvas" opens the
root path of the current origin — the desktop service has no canvas page there, so clicking it while ComfyUI is not
ready only lands on a missing page. `openSkillWorkflowInMainUi()` checks the run state the header pill already shows:
"ComfyUI is starting… edit the main canvas once it is ready" while booting, "This feature needs ComfyUI" when it is
stopped.

## Generation connects in place once ComfyUI is ready

A cold-start window lands on the Studio page served by the desktop service, and once ComfyUI is ready the page
**connects generation in place**: no URL change, no reload, no full-page navigation. A navigation or a reload clears
the unsaved content of the director editor and the settings forms, and a cross-origin navigation loses all of it.

- The desktop ships `routes` (the ownership table, `studio_caps.route_list()`) and `comfy_base` (the direct target for
  generation requests) in `/neo_studio/version`. The frontend decides per request which origin it goes to using that
  table; while `comfy_base` is empty, routes outside the table keep hitting the desktop service and answering `409`,
  which drives the single "This feature needs ComfyUI" prompt.
- Direct mode is on only for "the ComfyUI the desktop spawned itself + loopback-only listen + the desktop service has
  a bound port" (`StudioDesktop.direct`). That decision must share its source with `comfy_cors()`: ComfyUI's
  `--enable-cors-header` and its origin_only middleware are mutually exclusive (`ComfyUI/server.py`), and without the
  flag every request from the desktop port origin is rejected with 403 because Host and Origin no longer match.
- The price is that this ComfyUI instance gives up its origin_only CSRF defence, so LAN listen (`--listen`) and remote
  mode never get the flag and keep the full-page navigation: an instance exposed to a NIC does not trade that defence
  for convenience.
- The flip happens as one step and nothing flips until ComfyUI answers: the capability table becomes ComfyUI's, gated
  buttons drop their blocking listener and restore their labels, the `body.ns-offline` mark is dropped, the memory bar is
  mounted into the generation panel where it belongs, and `/ws` moves from the desktop stub to the real ComfyUI event
  stream. Enabling the buttons without moving the event stream is the half-online state where a task is accepted and
  no progress ever comes back.
- The flip is driven by `ready`, not by who launched the kernel: the desktop clears `starting` in the very snapshot that
  reports readiness, so gating the flip on `starting` never fires for a cold start where the desktop launched the kernel
  itself — the header pill says "Running" while the page stays pinned to the offline form and every generation request
  answers `409`.
- The offline page carries no banner: the header pill reports "● Stopped" and points the start entry at
  "Settings → Startup settings", generation entries are dimmed by the capability gate, and `body.ns-offline` is the
  mark the shared modules read to tell the offline form apart.
- Stopping the kernel flips the page back to the offline form: the direct target is cleared, the generation buttons are
  gated again, the event stream goes back to the stub, and the window navigation never moves.

## Director page layout

The director page is a **360px recipe list** in the left column (director recipes only) plus a right main column
split into two panes: **top = the director editor**, **bottom = the film generation panel**, with a
**splitter** between them. A **📋 Recipes / 🖼 Assets** switch bar on top of the left column flips that column
between the recipe list and the asset library (widened to 380px), so assets are one click away while editing.

- The director editor is embedded in Studio (`setDirectorEditorHost` registers the host): it fills the
  top-right pane with no overlay window, so title-bar dragging / ⛶ maximize / the resize handle do not appear.
  The main canvas (the ComfyUI page) registers no host, so the editor stays an overlay window there.
  An embedded save (including **🎬 Save & Generate Film**) leaves the editor **in place** — the film runs in the
  pane below and the editor the user was just editing is not pulled away. Closing is the title-bar **✕**, the
  footer **Cancel**, the dirty bar's "Save & close", or switching to another recipe (the singleton reload path).
- With no editor open the top-right pane **takes no space**: it collapses to zero, the dashed placeholder no
  longer blocks the layout, and the generation panel fills the whole column (the splitter steps out);
  reopening the editor returns to the top/bottom split. **Clicking a left-column recipe card selects it
  and opens it embedded** (clicking the same card again only switches the current segment, so unsaved edits
  survive), and "🎬 New director recipe" on the gallery page switches to the director page and opens it embedded.
- The **📋 Recipes / 🖼 Assets** switch bar on top of the left column is that column's switch: "🖼 Assets" turns
  the whole column into the **asset library** (`.ns-director-lib`, the column widens to 380px), "📋 Recipes"
  turns it back. The **asset library** button inside the director editor drives the same switch (Studio has no
  ComfyUI left sidebar, so `media-transfer` writes `sidebarTab.activeSidebarTabId` and the shim forwards it to
  that column), and the switch bar follows the button's open / close. The library is the same Neo Gallery the gallery
  page uses (one element moved between the two hosts, wide styling), breadcrumbs and directory navigation work
  there, and cards drag straight into the editor's first-frame / reference slots. The widening is driven by the
  grid column, so the editor gives way instead of being covered. Leaving the director page closes it automatically.
- Splitter: drag to resize the generation panel (editor floor 240px, panel floor 90px), double-click to
  collapse / expand the panel, `↑`/`↓` resize and `Enter` collapses from the keyboard. Height and collapsed
  state live in `localStorage["neo_studio_director_split"]`. Dragging the panel taller or shorter stretches the
  result column on the right (live preview / final film) with it, instead of leaving a blank strip under a
  fixed 640×360 preview box.
- Left-column divider: a vertical line between the left column and the editor that doubles as a drag handle —
  drag it to resize the column (recipe-list floor 200px, asset-library floor 320px, editor floor 420px); drag it
  narrower than 160px and the whole column closes (zero width, content hidden, the main column takes the full
  width). `←`/`→` nudges, `→` reopens a closed column, and double-click collapses / expands. Each mode keeps its
  own width and closed flag in `localStorage["neo_studio_director_side_col"]` — closing only writes the flag, so
  a reopen lands on the width you had before the collapse. The divider disappears in the stacked narrow layout,
  and the closed state has no effect there (no grab zone to drag). Both splitters share one look: an 18px grab
  zone with a 1px hairline that thickens to 4px and turns accent blue on hover, keyboard focus and while dragging,
  plus a three-dot grip dead-centre (the VS Code sash) that stays lit on hover and while the column is closed —
  that grip is how a closed column gets dragged back out.
- The generation panel only answers "which segments to run, and what came out" — it carries no parameter
  controls, and its control area is squeezed onto **one line**: **Select all** / **Clear** / the **segment chip
  strip** (one chip per segment, the chip shows only its number) / the check hint / one read-only echo
  (`width×height · steps` for the run, taken from the recipe) / **🎬 Generate Film** / **⏹ Cancel** all share
  that line, and with many segments the chip strip scrolls sideways on its own so the vertical space stays with
  the result column. **Clicking a chip checks the segment to run; nothing checked = the whole film**;
  **Select all** / **Clear** act on the whole strip, and hovering a chip shows that segment's shot description.
  The selection is runtime-only: switching recipes clears it, and it is never written into the recipe. The chip
  of the segment being generated is highlighted while the run is live.
- The run parameters for the film (resolution / steps / seed / continuity / context frames) are set only in the
  director editor and saved into the recipe's `shared`; neither the panel nor the request repeats that control set.
  The first row of the editor's "🎞️ Storyboard timeline" page keeps only the generation mode / skill / chunk
  seconds / resolution: seed, steps, continuity and context frames sit behind the **Advanced** checkbox at the
  end of that row, collapsed by default (collapsed values still apply — saving reads them).
- **🎬 Save & Generate Film** in the editor footer and **🎬 Generate Film** in the panel submit the same way:
  after a successful save the film is submitted with the parameters just saved in the recipe plus the checked
  segments, and the editor stays open.
- The generation status freezes on the first terminal status (succeeded / failed / cancelled): a payload issued
  before the terminal event and landing after it is dropped, so the progress bar and **⏹ Cancel** never come
  back (cancelling a finished task only answers "任务已结束，无法取消").
- Narrow windows shrink the left column first (340px below 1180px); below 900px the columns stack. The default
  width is wide enough for the recipe header row ("Recipe ↻ 📦 Import 🎬 New director recipe") to stay on one line.

## Paint page layout

The paint page is a **left column with the image recipes** (`gen_type = "image"` only) plus a right main column
holding the **text-to-image** and **image-edit** panels under a mode bar. Only one panel fills the column at a
time — unlike the director page, no editor and generation panel fight for the same height. The asset-library
drawer, the left-column divider, the scrollbars and the narrow-window rules are shared with the director page.

- The paint panels are embedded in Studio (`setPaintHost` registers the hosts): they fill the right column with
  no overlay window, so title-bar dragging and the ✕ do not appear. The main canvas (the ComfyUI page) registers
  no host, so "🖼️ Generate asset" and "🖼️ Edit image" stay overlay windows there.
- "🖼️ Generate asset" in the gallery page header and "🖼️ Edit image" in an image card's menu both switch to the
  paint page in Studio and open in the matching panel. Clicking an image recipe card switches to text-to-image
  and prefills that recipe's prompt into the output box; "🖼️ New image recipe" opens a blank text-to-image panel.
- The chosen mode lives in `localStorage["neo_studio_paint_mode"]`, and the column width is the paint page's own
  `localStorage["neo_studio_paint_side_col"]` — dragging it never overwrites the director page's width, and the
  closed state is remembered per page the same way.
- Asset-library drawers are per page (`libDrawers[view]`, one for the director page and one for the paint page):
  `media-transfer` writes only reach the current page's drawer, and leaving the page closes it. Leaving the gallery
  page resets `sidebarTab.activeSidebarTabId` — mounting the gallery sets it to `neo.gallery`, and without the
  reset the page's own asset-library button writes the same id, gets deduped, and never opens the drawer.
- The VRAM / RAM bar exists once per generation page (director and paint), and polling only runs on those pages.

## Skills page layout

The Skills page is the unified skill manager mounted full-bleed in the main area
(`createSkillManager(host, { showClose: false, showCanvasBtn: false })`): left list + splitter + right detail,
no floating window, no ✕ and no "from canvas" export button.

- The component is modal-born: `prompts.css` gives it the `#1a1a2a` panel, `#1a2a3a` title bar, `#5090cc` blue
  highlight and `#1a3a5a` small blue buttons, which is a whole palette away from the shell's grey + `#7aa2ff`.
  The shell remaps that set onto shell tokens inside the `.ns-skills` scope (`#17171b` page, `#202024` title
  bars, `#2a2a2e` + `#444` inputs and buttons, the settings tab's translucent blue for the selected row), so
  Assets / Paint / Director / Settings / Skills sit on one palette. The skill modal and the node skill picker
  inside ComfyUI keep the modal palette.
- The modal's "🗂 Skill Management" title bar is hidden on the page: the header tab already names the page, and
  nothing here is a draggable window.
- Left-column width drag and memory (`localStorage["neo.skillManagerLeftWidth"]`), the category accordion, the
  per-row ⧉ copy / 🗑 delete and the + New / ⬆ ZIP / ⬆ Folder footer behave exactly as in the standalone window.

## Startup sequence

- The window comes first: opening the window only unpacks and creates it (splash / guide page); the self-check,
  the desktop-side service and starting ComfyUI all finish on a background thread.
- `starting` while the desktop is bringing ComfyUI up is one dict shared by `StudioDesktop` and the desktop-side service,
  emitted by both `comfy_state` and `/neo_studio/version`. pywebview injects `js_api` later than page load, and
  `window.pywebview` appears before its methods, which finish.js fills in afterwards: desktop-side api code always
  waits for the method it needs to show up before taking over, and the frontend knows it is starting from the version
  snapshot alone. During that window only "ComfyUI is starting…" is shown; the "ComfyUI required" toast and the start
  entry stay hidden.
- After a full-page reload (the F5 hotkey) pywebview re-injects the bridge on navigation completion, measured to land
  more than ten seconds after the page script runs (`before_load` and `loaded` are 13 seconds apart in
  `data/studio_desktop.log`). The header status chip and the window controls therefore sit on a 5-second bridge poll
  instead of giving up after a few rounds — giving up once means a refresh strips that part of the header, and the
  in-place ready flip breaks there too. The chip also refuses the bridge as its only source: a bridge result is handed
  back to the page by the window thread (pywebview computes it on a worker thread and delivers it through
  `evaluate_js`'s `Invoke` plus a semaphore), and the drag loop runs on that same window thread with a `sleep` per step
  and no message pumping, so bridge promises do not land at all during a drag. Every poll round asks the bridge and the
  desktop-side `GET /neo_studio/comfy_state` (the same `comfy_state`, answered on the service thread, independent of the
  window thread) and takes whichever lands first; when the page origin does not answer that route (browser tab, remote
  mode) it stops asking.
- When the desktop starts, "is there a ComfyUI" is decided only by whether anyone is listening on the port: a missing
  `/neo_studio/version` probe (that instance has not loaded the plugin yet and is still importing custom nodes) also
  only attaches — a second instance is never started on a neighbouring port, and the "Startup settings → Start
  kernel" button only attaches as well.

## Guide page (first-time setup)

When the root cannot be derived, or `python.exe` is found neither beside the plugin nor inside it, the window opens
on the guide page (`guide_html`, `load_html` + js_api): at that point `build_app` cannot even import `folder_paths`,
the desktop-side service cannot start at all, so the page has to work without an HTTP service. Validation and launch
all go through js_api (`check_setup` / `pick_root` / `pick_python` / `start_setup`), and the service only becomes
startable once the root is filled in.


## Frameless window and dragging

- Frameless is a startup setting, stored as `frameless` in `launcher_config.json` (on by default; unchecking it
  restores the system title bar): it is fed to pywebview at window creation and switched as style bits at runtime
  (only `WS_CAPTION` is removed, `WS_THICKFRAME` stays set — pywebview's frameless uses `FormBorderStyle=None`,
  which drops edge-drag resizing as well, restored by `ensure_resizable_frame` after the window is Shown; the native
  window is only created inside `start()`, so there is no hwnd at creation time).
- The window background is set explicitly at creation time to the page color (`WINDOW_BG` = `#17171b`, the same as
  the `body` background in `studio/web/studio/style.css`): pywebview's `background_color` defaults to `#FFFFFF` and
  sets both the WinForms `Form.BackColor` and the WebView2 control's `DefaultBackgroundColor`. Dragging a window edge
  runs the system size/move loop, where the Form and the `Dock=Fill` WebView2 control are resized together and the
  newly exposed client area is painted by those two backgrounds first — a white one is a white window flash. The
  restored `WS_THICKFRAME` ring is drawn by DWM in the system theme color, so on a light theme that border line is
  white during resizing: `set_window_frame` pins `DWMWA_BORDER_COLOR` / `DWMWA_CAPTION_COLOR` to the same color while
  it reapplies the style bits (Windows 10 ignores both attributes and only returns a non-zero HRESULT).
- `easy_drag` must stay off — pywebview's simple drag is a global mousedown, and frameless means clicking any card
  drags the window along. Dragging starts by pressing an empty part of the header and calling `win_start_drag`,
  with the desktop looping on the window thread and following the cursor (`SetWindowPos` +
  `GetAsyncKeyState(VK_LBUTTON)`), stopping the moment the left button is released — handing it back to the system
  through `WM_NCLBUTTONDOWN + HTCAPTION` or `WM_SYSCOMMAND·SC_MOUSEMOVE` never starts, because the WinForms Form
  swallows the non-client-area press.
- A press that never leaves the system drag threshold (`SM_CXDRAG`) is not a drag: the window stays put, and
  maximize / fullscreen are only exited once the cursor crosses that threshold — under maximize `SetWindowPos`
  knocks the window back to its restored rectangle, so a plain header click restoring it is not native title-bar
  semantics. Double-clicking an empty part of the header calls `win_maximize` to toggle maximize / restore, and
  exits fullscreen first when fullscreen.
- Minimize / maximize / fullscreen / close go through `window_state` plus the `win_*` group of js_api methods, and
  whether the controls appear is decided by `frameless`. The maximized and fullscreen states are tracked by the
  desktop itself (pywebview's `Window.maximized` / `.fullscreen` are creation-time initial values): frameless maximize
  fills the work area (the system maximize returns a full-screen rectangle and would cover the task bar); exiting
  fullscreen makes pywebview write `FormBorderStyle` back to its creation value so the title bar comes back, with
  the style re-applied from the desktop's state; closing while fullscreen does not save geometry (it would store a
  full-screen rectangle and the window would fill the screen on the next start).

## Dev mode

- Dev mode is a startup setting, stored as `dev_mode` in `launcher_config.json` (off by default): checking it makes
  the next start go through `webview.start(debug=True)`, and the settings toggle is `set_dev_mode`. DevTools does not
  open by default (`OPEN_DEVTOOLS_IN_DEBUG` is off — pywebview calls `OpenDevToolsWindow` under `debug`); open it
  with F12 or the right-inspect context menu.
- pywebview sets `AreBrowserAcceleratorKeysEnabled`, `AreDefaultContextMenusEnabled`, and `AreDevToolsEnabled` all
  equal to `debug` when the CoreWebView2 environment is created: without dev mode, F5 / Ctrl+F5 / Ctrl+R and the
  WebView2 context menu do not work in the window. All three are fixed at environment creation and cannot be changed
  on a running window, so the toggle takes effect after the window restarts.
- The reload entry does not depend on dev mode: the Studio page takes over F5 / Ctrl+F5 / Ctrl+R itself
  (`initReloadHotkey` in `studio/web/studio/studio-app.js`), so one keypress after a frontend hot-sync
  (`tools/watch_web.py`) loads the new code.

## Info notes in Startup settings

- Every row in "Startup settings" carries an ⓘ next to its label; hovering it (keyboard focus works the
  same way) spells out that row's prerequisites and how it takes effect: root / interpreter / port / LAN
  listen / Remote ComfyUI go through "Save and restart ComfyUI", frameless applies immediately and is
  stored in the config, dev mode needs the desktop window to restart. The text lives in `TIPS` in
  `studio/web/studio/studio-app.js`.

## Interface language

- The settings page has a "Language" section (`中文` / `English` radio group): picking one saves it and reloads the
  page right away — there is no separate save step.
- The choice lives in `localStorage["neo_studio_lang"]` and defaults to the browser language. The desktop window and
  a browser tab are different origins, so each keeps its own language choice.
- Translated: the desktop app's own strings — header and window controls, the director generation panel, startup
  settings (including the ⓘ notes), the header status pill, and the VRAM bar. The assets and
  skills views and the LLM / image / video forms are shared modules and keep their Chinese source text.
- Entries live in `studio/web/js/core/i18n.js`: Chinese source strings are the keys, so a missing English entry falls
  back to Chinese instead of exposing a placeholder.

## LAN access

- "Startup settings → LAN listen" is a dropdown whose choices come from the NIC list the desktop reports
  (loopback only / all adapters `0.0.0.0` / each host NIC address), stored as `listen` in `launcher_config.json`
  ("loopback only" is the default = not passed, so ComfyUI keeps its 127.0.0.1-only default). Pick one and press
  "Save and restart ComfyUI"; the hint line shows the LAN URL live. A hand-edited config that holds something that is
  not an IP is rejected instead of being handed to `--listen`.
- When only a NIC address is given, the desktop adds `127.0.0.1` to the list (`comfy_listen`): the window navigates to
  `http://127.0.0.1:port/neo-studio` and the `port_busy` probe is a loopback probe — with nobody on loopback the window
  cannot open, and a running ComfyUI reads as a free port and gets started a second time.
- ComfyUI has no authentication: with listening on, `/api/*`, `/neo_studio/*` and `/view` are open to whatever is on
  the network, so enable it only on a trusted segment and clear the field afterwards. The MCP service is not part of
  this network surface (stdio + loopback — see [mcp.md](mcp.md)).

## Remote ComfyUI

- "Startup settings → Remote ComfyUI" takes `http://host[:port]` (`https` too; path / query / fragment / credentials
  are rejected) and stores it as `remote` in `launcher_config.json`. When it is set, the window opens
  `http://<remote>/neo-studio` directly and the probe and the ready jump both target the remote base — `probe()` takes
  a base URL, `http://127.0.0.1:port` in local mode. An empty field means local, which is the default.
- Remote mode never starts a local process: `port_busy`, `free_comfy_port`, `start_comfy`, `port_owner` and `kill_pid`
  are not involved. "Start kernel" becomes "reconnect to the remote", and "Stop kernel" is disabled — the remote
  machine starts and stops its own ComfyUI.
- The remote machine must have `comfyui-neo-studio` installed and must open its own listen address under
  "Startup settings → LAN listen". When the probe fails the window stays on the offline page and reports
  "Remote ComfyUI unreachable: <address>".
- Remote mode reads and writes the plugin data of the remote machine (recipes, skills, settings all live there);
  the offline page is still the local desktop service browsing the local asset directory.
- The local startup rows (ComfyUI root, interpreter, port, LAN listen) are greyed out in remote mode: they belong to
  the remote machine's own settings.
- A different window URL is a different origin, so the Studio page's `localStorage` settings do not travel with it.

## Window close and process reaping

Only the ComfyUI the desktop started itself is taken away; ComfyUI started by the user has no handle and is never
touched.

- The spawned ComfyUI is put into a Job Object (`KILL_ON_JOB_CLOSE`) the moment it starts: when the desktop process
  dies, the OS closes the handle and kills everything inside the job (including the children ComfyUI spawned
  itself). The teardown chain only runs when the desktop reaches its own exit code — Ctrl+C, "End task", signing out,
  or a crash cut it off before the kill. Without this kernel-level constraint ComfyUI stays on the port as an orphan,
  the next desktop run finds the port taken and can only attach (`self.comfy` is `None`), so every later close kills
  nothing.
- The first `closing` only saves geometry and lets the close through (returns `False`); the teardown (kill the
  process → show "stopping ComfyUI" → shut the desktop-side service → `destroy`) all runs on a background thread —
  the kill comes before the notice, so a stuck `evaluate_js` cannot delay taking the kernel with it. `closing` runs
  synchronously on the UI thread, so every second the teardown sleeps is a
  second the window is frozen (`join` burns the full 5 seconds when the desktop-side service is busy), and
  `evaluate_js` additionally needs the UI thread back in its message loop before it executes, so calling it from
  the handler deadlocks.
- Geometry must be read before the window is destroyed (reading properties afterwards throws, the teardown chain
  breaks halfway and the process becomes an orphan); `closed` and a final pass before process exit each cover it
  once (the `destroy` path may never fire `closing`), and the teardown thread is joined before exiting — leaving
  before the join finishes means an orphan.
- Liveness is asked by PID through `OpenProcess`, not `Popen.poll()` (once the child handle has been reaped it
  falsely reports "already exited").
- After `terminate` the child must be reaped (`Popen.wait`) — without reaping, the process is left as a bare
  kernel object, so `pid_alive` always reports "still alive": closing the window sleeps the full wait ceiling
  (that is the multi-second stall), and both the PID-based fallback kill and the port sweep behind "Startup
  settings → Stop kernel" are guaranteed to fail (the "no permission to terminate this process" line). Only a
  reaping timeout triggers the fallback kill; the port sweep is not used.

## Single-instance lock

The named mutex `Local\Neo.Studio.SingleInstance`, holding no port: listening on 8189 looks like a second ComfyUI in
netstat and reads as "ports 8188 and 8189 are up, closing the window only killed one". The already-exists signal
comes from `kernel32.GetLastError()`; `ctypes.get_last_error()` does not return 183 for this call.

## Plugin sync

When running from source, every start syncs `studio/` into the `custom_nodes` copy (`sync_plugin`: only same-named
code is overwritten, files matching on size and mtime are skipped, a copy currently held by ComfyUI is skipped and
picked up on the next start, and nothing in the target directory is deleted). Both the desktop-side service and the
ComfyUI page take their frontend files from `custom_nodes`, so once the sync finishes the window opens straight into
the new UI. The exe only swaps the directory when its bundled copy's version is newer, and a git checkout is never
touched. **Changing `app/studio_app.py` requires repackaging** — see [release.md](release.md).

## Static assets and cache

Desktop-side `/extensions/` static responses carry `no-store` (matching ComfyUI's `/extensions`), and
`data/studio_profile/EBWebView/Default/Cache` is cleared before the window opens: a stale plugin JS in the cache is
served straight out of it (no request), and once it is linked into the same ES module graph as the new modules the
link error happens before `studio-app.js` executes and JS cannot catch it — the page is left with only the header:
no views mounted and the header status slot stuck at `hidden`.

## Logs

- `data/studio_desktop.log`: startup / navigation / window close / drag steps (`drag N steps`, 0 = the press never
  left the drag threshold, or the left button was already released), plus uncaught frontend errors reported by the
  page (the `[web]` prefix, sent through
  the js_api `log()`), keeping only the tail 200KB.
- `data/comfy_run.log`: the full stdout / stderr of the ComfyUI the desktop launched (port conflicts and import
  errors land here; read by Studio "Settings → Logs").

## Related tests

`app/tests/test_studio_desktop.py`, `app/tests/test_studio_server.py` and `studio-app.e2e.mjs` —
see [testing.md](testing.md).
