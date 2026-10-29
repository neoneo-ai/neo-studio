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
  buttons drop their blocking listener and restore their labels, the `body.ns-offline` mark is dropped, the header queue
  entry shows up and reseeds from the six task tables (the VRAM / RAM readout is built with it), and `/ws` moves from
  the desktop stub to the real ComfyUI event stream. Enabling the buttons without moving the event stream is the
  half-online state where a task is accepted and
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

The director page is a full-width main column split into two panes: **left = the director editor**,
**right = the film generation panel**, with a **vertical splitter** between them. The **📋 Recipes** /
**🖼 Asset library** entries take no row of their own — while the editor is open they sit at the left end of the
editor's title row, and they leave with it (assets are what you use while editing). The recipe
list and the asset library both open in modals (`js/core/lib-modal.js`), so the whole width goes to editing and running.

- The director editor is embedded in Studio (`setDirectorEditorHost` registers the host): it fills the
  left pane with no overlay window, so title-bar dragging / ⛶ maximize / the resize handle do not appear.
  The main canvas (the ComfyUI page) registers no host, so the editor stays an overlay window there.
  An embedded save (including **🎬 Save & Generate Film**) leaves the editor **in place** — the film runs in the
  pane on the right and the editor the user was just editing is not pulled away. Closing is the title-bar **✕**, the
  footer **Cancel**, the dirty bar's "Save & close", or switching to another recipe (the singleton reload path).
- **Startup always lands on home, and only a click opens the editor**: when the recipe list lands, the first director
  recipe is auto-selected (the film generate pane and the agent context read it) but is **not** opened embedded in the
  left pane — opening it fires the host's "open → switch to this page" entry and drags the window from home to the
  director page. The director page stays on the guide page until a recipe is picked with **📋 Recipes** or started with
  **📝 New recipe**. One close is remembered (`neo_studio_director_closed`), and from then on the panel stops
  auto-selecting — the list sorts by modification time, so the recipe just edited is always the top card and would
  otherwise come back selected on every launch.
  **Clicking a recipe card selects it, opens it embedded and closes the recipe modal** (clicking the same card again only switches
  the current segment, so unsaved edits survive). When the editor has unsaved changes the click is blocked by the dirty
  bar and nothing moves — the card highlight, the segment chips and the size echo all stay on the old recipe — and
  "Save & close" / "Discard" on that bar closes the old editor and opens the recipe that was clicked, while
  "Keep editing" cancels the switch. "🎬 New director recipe" on the gallery page switches to the
  director page and opens it embedded, and the recipe modal's "新增导演配方" takes the same path — the modal closes
  and the blank recipe fills the pane, instead of an editor stacked behind an open modal. After **✕** / Cancel closes
  the editor the generation panel **leaves with it**: the main column steps out entirely and the whole column is the
  guide page — the opening line in the same idle style as the paint and video pages (title + fine note + four corner
  marks), worded as the home entry card is (**Direct a Video** / chain recipe segments into a finished video), and two
  entries **📋 Recipes** / **📝 New recipe** (the Recipes button instance moves here from the title row, so there is
  only one on screen, and the asset library is not on the guide page); clicking a recipe card or
  "新建配方" reopens the editor and returns to the left/right split.
- "**📋 Recipes**" opens the recipe modal (`.ns-libmodal[data-lib-scope="recipes"]`, director
  recipes only) and "**🖼 Asset library**" opens the asset modal (`data-lib-scope="assets"`, the same instance the
  paint page uses). The **🖼 Asset library** button inside the director editor drives the same entry (Studio has no
  ComfyUI left sidebar, so `media-transfer` writes `sidebarTab.activeSidebarTabId` and the shim forwards it to the
  modal), and the entry button lights while it is open. The library is the same Neo Gallery the gallery
  page uses (one element moved between the gallery host, the modal host and the standby host, wide styling),
  breadcrumbs and directory navigation work there, every host you leave behind stays on **the directory you were
  browsing** (never the home root), and cards drag straight into the editor's first-frame / reference slots.
  **Clicking a card in the modal fills the slot that was clicked and closes the modal**; multi-select goes
  through the footer **📥 N selected**, which lays the batch out from the slot the editor announced.
- Modal geometry: it covers the whole window by default, dragging the title bar turns it into a floating window
  (its own position and size, shared across pages), and the maximize button, the right-edge resize handle
  (640px floor), `Esc`, the backdrop and **✕** all work like the other Studio windows. Width, position and the
  maximized flag live in `localStorage["neo_studio_libmodal_recipes"]` and
  `localStorage["neo_studio_libmodal_assets"]`. Switching pages closes the modal of the page you left, and the
  gallery goes back to the standby host.
- Splitter: a vertical line between the two panes that is also the drag zone — drag to resize the generation panel
  (editor floor 360px, panel floor 200px, and dragging 90px past that floor is treated as dragging the panel shut;
  like the VS Code sash, collapsing and expanding are both done by dragging). Once collapsed the strip carries a
  vertical **◂ Generate panel** caption: drag outward a bit and the panel comes back, and clicking that caption
  works too for anyone who can't get the drag going — the click that trails a released drag is ignored. An
  expanded strip carries no caption. `←`/`→` resize and `Enter` collapses and expands from the keyboard. Width and
  collapsed state live in `localStorage["neo_studio_director_split"]`. Dragging the panel wider or narrower
  stretches the result area inside it (live preview / final film) at the recipe's own `width × height` ratio, so a
  portrait recipe stays a narrow strip, instead of leaving a blank strip under a fixed preview box. The grab zone is
  18px wide with a 1px vertical hairline that thickens to 4px and turns accent blue on hover, keyboard focus and
  while dragging; the caption only gets a pointer cursor in the collapsed state.
- The generation panel only answers "which segments to run, and what came out" — it carries no parameter
  controls. Inside it the control area is squeezed onto **one row at the top**: **Select all** / **Clear** / the
  **segment chip strip** (one chip per segment, the chip shows only its number) / the check hint / one read-only
  echo (`width×height · steps` for the run, taken from the recipe) / **🎬 Generate Film** / **⏹ Cancel** all share
  that row; with many segments the chip strip scrolls sideways on its own, and a panel dragged narrower than the row
  wraps that row onto extra lines instead of scrolling sideways, so the height below stays with the result area. **Clicking a chip checks the segment to run; nothing checked = the whole film**;
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
- The main column is a left/right split, so a narrow window scrolls sideways instead of squeezing both panes into
  unreadable strips; the recipe and asset modals cover the window with a 640px minimum width.

## Paint page layout

The paint page is a **top bar** (the **text-to-image / image-edit** mode bar plus the **🖼 Asset library** entry)
above one full-width panel. Only one panel fills the page at a time — unlike the director
page, no editor and generation panel split one width. The asset modal, the scrollbars and the
narrow-window rules are shared with the director page (one modal instance, one geometry in
`localStorage["neo_studio_libmodal_assets"]`).

- The paint panels are embedded in Studio (`setPaintHost` registers the hosts): they fill the page with
  no overlay window, so title-bar dragging and the ✕ do not appear. The main canvas (the ComfyUI page) registers
  no host, so "🖼️ Generate asset" and "🖼️ Edit image" stay overlay windows there.
- "🖼️ Generate asset" in the gallery page header and "🖼️ Edit image" in an image card's menu both switch to the
  paint page in Studio and open in the matching panel; "🖼️ New image recipe" opens a blank text-to-image panel.
  The paint page no longer carries an image-recipe list.
- The text-to-image panel is a composer ("one prompt box + a bottom chip row: skill+params / ratio /
  max side … `⋯` Generate") docked at the bottom of the page (the input bar follows the
  ArtCraft promptbox): one line in the box is enough to generate, the three chips are pill buttons with panels
  that float open upward (the native selects stay inside as state containers and never show; the skill list and
  the main model / LoRA controls share the one two-column panel of the first chip), fill-random /
  prompt enhance / runtime random / preset list live in the `⋯` menu. The panel fills the column height: progress and finished images stack from the top above
  the composer, and idle leaves one start hint in the result area ("Write a prompt, then hit Generate") with no
  empty canvas (control list: [gallery.md](gallery.md), "Generate assets" and "Image editing").

- On the paint page, "Generate asset" in the asset modal and "Edit image" in an image card's menu close the modal
  once the panel is in place — `go()` on the same page skips the `showView()` close, so the modal would stay over
  the panel.
- The chosen mode lives in `localStorage["neo_studio_paint_mode"]`.
- The gallery in the asset modal is the same element the gallery page and the director page use: a
  `media-transfer` write only opens the current page's modal, and leaving the page closes it. Leaving the gallery
  page resets `sidebarTab.activeSidebarTabId` — mounting the gallery sets it to `neo.gallery`, and without the
  reset the page's own asset-library button writes the same id, gets deduped, and never opens the modal.
  **Clicking a card in the modal fills the image-edit source preview and closes the modal**; the footer
  **📥 N selected** collects a batch and lays it out in one go.
- The VRAM / RAM readout and the **Clear** button live in the header queue panel: polling runs only while that panel is
  open, and generation pages no longer carry their own bar.

## Skills page layout

The Skills page starts on a **guide page**: the same blank-state layout as the paint / video / director pages
(heading line + hint line + corner brackets), with three entries below it:
**📂 Import workflow** / **✏ New template skill** / **🗂 Skill list**. The manager is assembled only when an entry
is picked; landing on the guide does not fetch the skill list.

- **Import workflow** accepts only the `.json` ComfyUI writes with "Export (API)" (a flat
  `node_id → class_type / inputs` map): the file first goes through `plan_workflow_skill` to preview the bindable
  variables, then the "Create skill from an imported workflow" dialog asks for the name and the variables to bind,
  and `save_workflow_skill` writes a custom generation skill. The list opens with the new skill selected. An
  interface workflow (ComfyUI's plain "Save" with `nodes` / `links`) is rejected with a hint to re-export it as API
  format; it is never written into the skill folder.
- **New template skill** opens the new-skill form of the unified manager: it writes `skill.md` only and has no
  `workflow.json`.
- **Skill list** opens the unified manager (`createSkillManager(host, { showClose: false, showCanvasBtn: false, autoSelect: false })`):
  left list + splitter + right detail, no floating window, no ✕ and no "from canvas" export button; the first item
  of the expanded category is selected by default. **← Guide** in the list-mode title bar returns to the guide;
  unsaved detail changes are confirmed first, and the whole manager is unmounted so the next visit assembles it again.
- The component is modal-born: `prompts.css` gives it the `#1a1a2a` panel, `#1a2a3a` title bar, `#5090cc` blue
  highlight and `#1a3a5a` small blue buttons, which is a whole palette away from the shell's grey + `#7aa2ff`.
  The shell remaps that set onto shell tokens inside the `.ns-skills` scope (`#17171b` page, `#202024` title
  bars, `#2a2a2e` + `#444` inputs and buttons, the settings tab's translucent blue for the selected row), so
  Home / Assets / Paint / Director / Settings / Skills sit on one palette. The skill modal and the node skill picker
  inside ComfyUI keep the modal palette.
- The guide state hides the "🗂 Skill Management" title bar (the header tab already names the page); list mode shows
  it, titled "Skill list" and carrying the back-to-guide entry.
- Left-column width drag and memory (`localStorage["neo.skillManagerLeftWidth"]`), the category accordion, the
  per-row copy / delete icons and the + New / ⬆ ZIP / ⬆ Folder footer behave exactly as in the standalone window.
- Copy and delete icons all come from `studio/web/js/core/icons.js`: icon-only buttons carry no text,
  labeled buttons put the icon before the label, so a glyph never reflows with the font fallback.


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
  `data/studio_desktop.log`). The header window controls attach on the `pywebviewready` event that `finish.js`
  dispatches once it fills in the bridge methods, with the 5-second poll kept only as a backstop for a bridge that
  landed before the page's module scripts ran; the header status chip still sits on a 5-second bridge poll and
  never gives up after a few rounds — giving up once means a refresh strips that part of the header, and the
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
- How that header press gets wired decides whether the window drags during cold start: `initWindowChrome` runs before
  the startup chain and the press rides the `pywebviewready` event (`finish.js` dispatches it when it fills in the
  bridge methods), so it never waits on the extension setups or the version snapshot — both of those requests hit a
  desktop-side service that was just assembled and is bringing ComfyUI up, and can stall for tens of seconds while the
  window sits on the cold-start page.
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

## Text selection and copy

- Text stays selectable: the window is created with `text_select=True` — pywebview defaults it to False and the
  injected `customize.js` calls `preventDefault` on `selectstart` for every non-form element, so not a single
  character of the chat text can be selected. Inside the chat scope `studio/web/agent-panel.css` hands `user-select`
  back as `text`; buttons and form controls stay out of that rule.
- The native copy keys are re-opened once the window is shown: `enable_copy_keys` sets
  CoreWebView2's `AreBrowserAcceleratorKeysEnabled`, so Ctrl+C / Ctrl+V / Ctrl+X / Ctrl+A / Ctrl+Z / Ctrl+Y work
  without dev mode. The page side grabs those keys in the capture phase in `initClipboardKeys`
  (`studio/web/studio/studio-app.js`) so the injected key-swallowing handler never sees them; the reload keys stay
  out of that allow-list and remain owned by `initReloadHotkey`.
- `http://127.0.0.1` is not a secure context, so `navigator.clipboard` does not exist. The agent chat page puts one
  copy button per turn (`mkCopyBtn`), pinned after the final answer body: the button face is only Cline's
  overlapping-squares glyph as an inline SVG — no label and no tooltip at all. The click goes through
  `navigator.clipboard` and falls back to `execCommand`; success swaps in a check and failure swaps in a cross, and
  the glyph comes back after 1.5 seconds. One is enough — two buttons side by side in the same ask-and-answer card
  leave it unreadable which text each one copies. The button sits outside the body text, so selecting text never
  drags the button along.
- The input grows with its content up to a 108px cap (`fitInput`): sending clears the input and hands focus back to
  it, and Esc clears a half-written entry while the panel is idle.

## Dev mode

- Dev mode is a startup setting, stored as `dev_mode` in `launcher_config.json` (off by default): checking it makes
  the next start go through `webview.start(debug=True)`, and the settings toggle is `set_dev_mode`. DevTools does not
  open by default (`OPEN_DEVTOOLS_IN_DEBUG` is off — pywebview calls `OpenDevToolsWindow` under `debug`); open it
  with F12 or the right-inspect context menu.
- pywebview sets `AreBrowserAcceleratorKeysEnabled`, `AreDefaultContextMenusEnabled`, and `AreDevToolsEnabled` all
  equal to `debug` when the CoreWebView2 environment is created: without dev mode, F5 / Ctrl+F5 / Ctrl+R and the
  WebView2 context menu do not work in the window. The context menu and DevTools are fixed at environment creation
  and cannot be changed on a running window, so that toggle takes effect after the window restarts. The native copy
  keys are not under that limit — `enable_copy_keys` re-opens them once the window is shown (see "Text selection and
  copy").
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
  settings (including the ⓘ notes), the header status pill, and the queue panel's VRAM / RAM readout. The assets and
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

Only the ComfyUI the desktop started itself is taken away — the one spawned this session through its `Popen` handle,
the one spawned by an earlier session through the `data/comfy_child.json` marker. ComfyUI started by the user has no
marker and is never touched.

- The spawned ComfyUI is put into a Job Object (`KILL_ON_JOB_CLOSE`) the moment it starts: when the desktop process
  dies, the OS closes the handle and kills everything inside the job (including the children ComfyUI spawned
  itself). The teardown chain only runs when the desktop reaches its own exit code — Ctrl+C, "End task", signing out,
  or a crash cut it off before the kill. Without this kernel-level constraint ComfyUI stays on the port as an orphan,
  the next desktop run finds the port taken and can only attach (`self.comfy` is `None`), so every later close kills
  nothing.
- In attach mode (`self.comfy` is `None`) the close claims the orphan through `data/comfy_child.json`:
  `spawn_comfy()` records pid + port when it starts that instance, and the teardown kills it only when the port is
  still listening and the listener is still that pid. A ComfyUI an earlier session spawned and an interrupted
  teardown left behind is therefore taken away on the next close — the plugin modules in its memory were imported
  hours ago, files synced to disk since are never re-imported, and while it lives every export keeps landing in the
  old place. A ComfyUI the user started has no marker; both `comfy_stop` and `comfy_close` clear the marker when
  they finish.
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
