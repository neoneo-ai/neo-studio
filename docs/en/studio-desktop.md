# Studio Desktop

The desktop puts the Studio page in a local window: it starts ComfyUI itself and serves a local Studio service on the
ComfyUI port +3 (`app/studio_server.py`, a process with no ComfyUI runtime; the file read/write routes are served
there as usual), so browsing assets and editing recipes and skills keep working while ComfyUI is not running.
Source runs and the packaged exe go through the same `app/studio_app.py`.

## Components

| File                   | Responsibility                                                                                                                                                                                                                              |
| ------                 | ----------------                                                                                                                                                                                                                            |
| `app/studio_app.py`    | Window, self-check, start / stop ComfyUI, frameless window, close teardown, startup settings                                                                                                                                                |
| `app/studio_server.py` | Desktop-side aiohttp service (ComfyUI port +3, `DESKTOP_PORT_OFFSET`); loads the plugin modules' own `RouteTableDef` handlers by directory                                                                                                  |
| `app/studio_caps.py`   | Capability table: which routes the desktop service serves itself, which of the rest it proxies to the kernel, and everything else answers `409 offline`                                                                                     |
| `app/studio_pose.py`   | Pose asset auto-sync: with "Startup settings → Pose repo" pointing at the 3d-pose-art repo root, tops the dist pose package and the pose-lib pose library up in the data root   |
| `data/`                | State directory: `studio_window.json` (geometry), `studio_profile` (Windows WebView2 profile / localStorage), `launcher_config.json` (root / python / port / frameless / dev_mode / listen / remote / pose_repo), `studio_desktop.log`, `comfy_run.log` |

Source runs keep state in the repository's `data/`; the Windows exe prefers `data/` beside the exe and falls back to
`%APPDATA%\Neo Studio` when the exe sits in a non-writable directory. macOS v1 uses remote mode and prefers the
project/user-directory `data/` when writable, falling back to `~/Library/Application Support/Neo Studio`.

## Offline gating

The test is "file read/write / local lookup / remote download / the 8080 LLM service only"; anything needing the
execution queue, VRAM, or node definitions belongs to ComfyUI. The feature-flag table ships with
`/neo_studio/version`, and Studio gates only the run-type buttons (generate / run segment / assemble); recipe
editing, skill editing, settings and LLM configuration never need the ComfyUI runtime. The header queue panel lists
the task-center history offline (`GET /neo_studio/tasks`, `<data root>/configs/studio_tasks.sqlite`), with generation
and cancel disabled and no VRAM readout. Route list: [api-routes.md](api-routes.md).

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

- The desktop ships `caps` (the feature table, `studio_caps.features(kernel_ready)`) plus where the kernel lives
  (`kernel_ready` / `kernel_port` / `kernel_origin`) in `/neo_studio/version`. The generation side flips with
  `kernel_ready`; the page never decides which origin a request goes to and keeps no second copy of any list.
- What a path outside the desktop table does is decided by `forwardable()` in the same layer: inside the list
  `proxy_forward` in `app/studio_server.py` hands it to the kernel; outside it the desktop has no such route and
  answers `404`. The `409` that carries `offline` — the one that drives the single "This feature needs ComfyUI"
  prompt — comes only from a route that belongs to the kernel when no kernel is up: it is the page's offline signal,
  and no route sends it while the kernel runs. The desktop port is not a forwarder anyone can hit: the plugin
  families come in by prefix and ComfyUI's own routes are named family by family (the queue panel's 内存 readout
  reads the kernel's `/system_stats`).
- The forward is the desktop process sending the page's request on its behalf: request and response bodies both stay
  streamed (a finished image and a whole film are minute-long responses and an upload is tens of MB — none of them
  belong in memory), hop-by-hop headers and the browser's identity headers (Origin / Referer / Sec-Fetch-*) are
  stripped and Host is rewritten to the kernel address, so ComfyUI's origin_only middleware keeps working exactly as
  before — the desktop never passes `--enable-cors-header`, and a browser hitting the ComfyUI port directly is still
  403: this CSRF line never moves onto the proxy. LAN listen (`--listen`) and remote mode never get the flag either
  and keep the same pinned page: those paths used to navigate the whole window, now the flip and the proxy are the
  same for them.
- The kernel's own version snapshot and kernel-side caps come through the dedicated `/neo_studio/kernel_version`
  entry: `/neo_studio/version` exists on both ends and the desktop has to answer its own copy (the page reads the
  desktop capability table and the offline form from it).
- `/ws` is relayed by the desktop (`studio_ws`): both directions to the kernel's event stream while it runs, and the
  connection is held open when it does not (without that the offline page logs a connection error every 2 seconds);
  when the kernel closes with 4000 — "server restarted, reconnect" — that code reaches the page unchanged, the page
  reconnects after 2 seconds, every client connection opens its own upstream, and the tunnel comes back with the
  kernel.
- The main canvas still lives on ComfyUI's own page: a local kernel is reached on "the page's own hostname plus the
  kernel port" (for a LAN peer that hostname is the address that machine sees for this box), a remote kernel on the
  address the startup settings carry. The desktop port has no canvas page and the proxy never proxies one.
- The MCP registry and its stdio sessions live in the desktop process only, and the page is same origin with them, so
  `/neo_mcp/*` is on the desktop port. That family never carries a CORS header, so an outside site — including one
  that DNS-rebinds to loopback — reads nothing.
- The flip happens as one step and nothing flips until ComfyUI answers: the capability table becomes the ready one,
  gated buttons drop their blocking listener and restore their labels, the `body.ns-offline` mark is dropped, the
  header queue entry shows up and reseeds from the six task tables (the panel merges the task-center history, the live
  tables take over the progress of rows still running and a finished row never regresses, and the VRAM / RAM readout is
  built with it), and
  `/ws` moves from the desktop stub to the real kernel event stream. Enabling the buttons without moving the event
  stream is the half-online state where a task is accepted and no progress ever comes back.
- The flip is driven by `ready`, not by who launched the kernel: the desktop clears `starting` in the very snapshot
  that reports readiness, so gating the flip on `starting` never fires for a cold start where the desktop launched
  the kernel itself — the header pill says "Running" while the page stays pinned to the offline form and every
  generation request answers `409`.
- The offline page carries no banner: the header pill reports "● Stopped" and points the start entry at
  "Settings → Startup settings", generation entries are dimmed by the capability gate, and `body.ns-offline` is the
  mark the shared modules read to tell the offline form apart.
- Stopping the kernel flips the page back to the offline form: the proxy target is cleared, the generation buttons
  are gated again, the event stream goes back to the stub, the window navigation never moves, and the queue panel
  falls back to the task-center history with generation and cancel disabled.

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
  only one on screen, and the asset library is not on the guide page). Under those buttons sits the three most recent
  director recipes, one per row — **source tag + segment count + recipe name**, the top three in the backend's
  modification-time order, and the block is absent when there is no director recipe. Clicking a row takes the same path
  as clicking that recipe's card: the recipe fills the left pane embedded, the film pane switches to it, and no recipe
  modal comes in between; the block refetches when the editor closes, so the recipe just saved is back at the top.
  Clicking a recipe card or
  "新建配方" reopens the editor and returns to the left/right split.
- "**📋 Recipes**" opens the recipe modal (`.ns-libmodal[data-lib-scope="recipes"]`, director
  recipes only) and "**🖼 Asset library**" opens the asset modal (`data-lib-scope="assets"`, the same instance the
  edit page uses). The **🖼 Asset library** button inside the director editor drives the same entry (Studio has no
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

## Input page / Edit page layout

The input page is one full-width text-to-image panel; the edit page is one full-width image-edit panel with a
**🖼 Asset library** button floating at its top right (absolutely positioned over the preview, so no toolbar
row is reserved for it). Only one panel fills the page at a time — unlike the director
page, no editor and generation panel split one width. The asset modal, the scrollbars and the
narrow-window rules are shared with the director page (one modal instance, one geometry in
`localStorage["neo_studio_libmodal_assets"]`).

- Both panels are embedded in Studio (`setPaintHost` registers the hosts): they fill the page with
  no overlay window, so title-bar dragging and the ✕ do not appear. The main canvas (the ComfyUI page) registers
  no host, so "🖼️ Generate asset" and "🖼️ Edit image" stay overlay windows there.
- "🖼️ Generate asset" and "🖼️ New image recipe" switch to the input page; "🖼️ Edit image" in an image card's
  menu switches to the edit page. Each page owns one panel and one job — the input page generates, the edit page
  edits — so there is no text-to-image / image-edit mode bar and no image-recipe list.
- The direct cards of the home **Edit** section (Image Edit / Outpaint / Local / Remove / Camera angle / Blend / Pose)
  carry their mode into the panel the edit page already built (`openImageEditMode` through the host's `__neoSetMode`): a
  card switches the mode instead of rebuilding the panel, because a rebuild clears a half-written prompt. The mode
  switches the moment you land,
  source image or not, and the empty-state hint names it. The mode chip stays clickable at all times and **only the user
  switches the mode** - neither `applySource` (a new source) nor `clearSource` (the source removed) touches it; clearing
  the source only tears down the layer that sat on it (the outpaint box, the paint layer, the remove markers). The controls
  a mode drives on the source (the outpaint box, the paint row, the click-to-remove row, the camera-angle ball with its
  three sliders) stay folded away with no source - the camera-angle card folds its reference slot and prompt box away on
  the spot, as that mode always does - and `setupModeLayer` lays them once `applySource` puts the source in; clicking an
  empty preview no longer opens a compare lightbox that has no source to show.
- The text-to-image panel is a composer ("one prompt box + a bottom chip row: skill+params / ratio /
  max side … `⋯` Generate") docked at the bottom of the page (the input bar follows the
  ArtCraft promptbox): one line in the box is enough to generate, the three chips are pill buttons with panels
  that float open upward (the native selects stay inside as state containers and never show; the skill list and
  the main model / LoRA controls share the one two-column panel of the first chip), fill-random /
  prompt enhance / runtime random / preset list live in the `⋯` menu. The panel fills the column height: progress and finished images stack from the top above
  the composer, and idle leaves one start hint in the result area ("Write a prompt, then hit Generate") with no
  empty canvas (control list: [gallery.md](gallery.md), "Generate assets" and "Image editing").
  Filling and docking are independent of how short the window is: Windows display scaling reports an 800px window as
  640 / 533 CSS px and the composer stays docked at the panel bottom; the result area scrolls on its own, and the
  page never scrolls vertically — the composer does not float in the middle of the window with an empty lower half.
  In a wide window the composer is 980px centred (gallery.css sizes the embedded panel with `width: min(92vw,980px)`,
  which caps out at this width on wide windows and follows 92vw once the window narrows); the prompt box floors at two
  lines (64px, `max-height: 26vh`) and grows by dragging its bottom edge. The video page's composer capsule takes the
  same 980px centred width and the same two-line box, and it no longer stretches to the height of the 首帧 / 尾帧 /
  参考图 squares beside it.
- The edit page docks its composer at the bottom the same way, and the image-edit area takes the gap above it: the
  source image scales up to fill that gap (`object-fit: contain`, centred, never cropped; its delete mask and marker
  points cap with it, so the mask never spills outside the card), and an empty preview carries the fixed-size
  "＋ Source" box in its centre (click opens the asset library, hovering floats the upload menu — see
  [gallery.md](gallery.md), "Image editing"). The edit page's page padding and composer padding each give up a
  strip to the preview; the paint page keeps its own page padding and composer, because the two pages' styles hang
  on their own hosts (`.ns-paint-edit` / `.ns-paint-text`) and one side never restyles the other. The prompt box
  is two lines tall (40px floor; camera-angle mode folds the box away entirely), and the width / height inputs sit
  **above** the chip row — a panel that floats open upward gets clipped by the page edge when it hangs off a
  bottom-docked row. The "source / result" label row and the zoom button do not appear in Studio: clicking the
  source opens the lightbox, and in paint / mark modes a click paints or marks instead.

- On the input page / edit page, "Generate asset" in the asset modal and "Edit image" in an image card's
  menu close the modal once the panel is in place — `go()` on the same page skips the `showView()` close, so
  the modal would stay over the panel. Page jumps are gated by the top-level `paintArmed` / `editArmed` flags,
  set only after the panel is built, so the host's construction-time ping never drags the page away from the
  home page or a settings deep link.
- The gallery in the asset modal is the same element the gallery page and the director page use: a
  `media-transfer` write only opens the current page's modal, and leaving the page closes it. Leaving the gallery
  page resets `sidebarTab.activeSidebarTabId` — mounting the gallery sets it to `neo.gallery`, and without the
  reset the page's own asset-library button writes the same id, gets deduped, and never opens the modal.
  Which slot a pick lands in is decided by who opened the modal: the floating **🖼 Asset library** button fills the
  image-edit source preview and closes the modal, while **🖼 Pick from library** in the reference-slot menu appends the
  card to the reference slots and leaves the source alone; the footer **📥 N selected** collects a batch and lays it
  out on that same target.
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
- The guide state hides the "🗂 Skill Management" title bar (the guide page names itself, and the header keeps no
  tab for the skills page); list mode shows it, titled "Skill list" and carrying the back-to-guide entry.
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
- The start / stop row on top of "Settings → Startup settings" carries a third button, "Open ComfyUI": it shows up once the
  kernel is ready and hands that kernel's address to the system default browser (a frameless window has no new tab to open, so
  the link goes through the js_api `open_url` and the window itself never navigates). The address is the one `comfy_state`
  reports — with the local port taken the desktop starts ComfyUI on the next free port, and the port in the startup settings is
  not necessarily the one listening; in remote mode it opens the remote address from the startup settings. With nobody listening
  on the port (stopped / starting) the button is not on the page: opening a ComfyUI that cannot be reached is just an error page
  in a browser.

## Guide page (first-time setup)

When the root cannot be derived, or `python.exe` is found neither beside the plugin nor inside it, the window opens
on the guide page (`guide_html`, `load_html` + js_api): at that point `build_app` cannot even import `folder_paths`,
the desktop-side service cannot start at all, so the page has to work without an HTTP service. Validation and launch
all go through js_api (`check_setup` / `pick_root` / `pick_python` / `start_setup`), and the service only becomes
startable once the root is filled in.


## Frameless window and dragging

- Frameless is a startup setting stored as `frameless` in `launcher_config.json`: Windows defaults it on, and macOS v1
  defaults it off with the native title bar; on macOS the window controls belong to the native title bar and the
  settings page hides the frameless toggle. On Windows the setting is fed to pywebview at window creation and switched
  as style bits at runtime (only `WS_CAPTION` is removed, `WS_THICKFRAME` stays set — pywebview's frameless uses
  `FormBorderStyle=None`, which drops edge-drag resizing as well, restored by `ensure_resizable_frame` after the
  window is Shown; the native window is only created inside `start()`, so there is no hwnd at creation time).
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

## Home layout (inline editing on the home page)

- The shell pages scroll on one thin ghost slot defined on the page container: `.ns-page` sets
  `scrollbar-width: thin` with `scrollbar-color: transparent transparent`, the thumb lands on `#555` only on
  `:hover` (`::-webkit-scrollbar` keeps the same 8px width) - the same treatment as the asset library and recipe
  modals. Home / Assets / Director all scroll on this layer (the gallery host is `height: 100%` and does not
  scroll; in short and narrow windows the director's `min-height` / `min-width` overflow on it too).
  `scrollbar-width` and `scrollbar-color` are inherited, so the gallery's Civitai column, the skill and
  custom-parameter panels and the director editor panels thin down with the page instead of each container
  carrying a rule; the zoomed director timeline keeps its own visible horizontal bar - that bar is the drag
  handle. The home additionally pins `scrollbar-gutter: stable`, so the centered content column does not shift
  when the edit bar appears or removing and adding a card changes the page height.
- "Edit home" standing in the top-right corner of the home page in view mode (`.ns-home-edit-entry`, `position: absolute`
  inside `.ns-home`, so it scrolls away with the content instead of staying pinned on the window) switches that page into
  edit mode, and the page itself is the editor: the whole
  card is the drag gesture (no handle and no ↑ ↓ arrows), the tool row in its top-right corner carries a single Remove
  button (a built-in card leaves the home page and comes back through Add a card, a custom card is deleted for good; leaving
  the home page only says so in a toast - it does not open that face by itself), the five
  hero text lines are edited by clicking the text itself (`contenteditable`, committed on blur), and a slim bar at
  the top of the page (`.ns-home-edit-bar`, `position: sticky` + `width: fit-content` +
  `margin: 0 0 14px auto`) is shrunk into one compact group pinned to the page's top-right corner: it owns the grid
  column count, the hero and hero-button switches and restore defaults, and the Done button - that same entry -
  sits at the end of its row, pinned together with the bar while you edit. Sections get no controls at
  all: their order and collapsed state are read from a layout an older build saved, and this build does not let you move
  them from the home page.
- Editing works on a local draft: every change goes back through `host.onDraft` into `renderHome()`, so this page redraws
  live and no request is sent. In edit mode the card face is not clickable (`.ns-home-editing .ns-home-card` sets
  `cursor: default` and the inner layers get `pointer-events: none`, and the `homeCard` / hero CTA onclick checks the same
  flag), so jumping pages cannot carry an unsaved draft away.
- Edit mode lays out the cards that are really on the home page: a built-in card you removed keeps no grid slot and no ghost
  tile - it waits in the "Add a card" face; a section a collapsed layout hid comes back with its cards, dimmed
  (`.ns-home-section.is-off` with a Collapsed tag). The grid ends with an "Add a card" placeholder tile
  (`.ns-home-add-tile`) that opens that face (`.ns-home-card-dialog`, on the library modal's overlay and box,
  `.ns-home-card-dialog-body` scrolls on its own). Its top half is this section's preset cards (one `.ns-home-preset-card`
  per cell inside `.ns-home-preset-grid`: icon + title + subtitle + a `+`). The preset list holds only the built-in cards
  currently off the home page (`presetCards()` reads `hidden`) - a card already on the home is never listed twice, and when
  every preset of the section is on the home the face says so. Clicking a preset puts that card on the home page, back in
  its own slot of `order`, and the face stays open for the next click. The bottom half is the custom-card form in three
  rows — jump type + jump target, title + subtitle, icon + section. The icon cell spans both columns and shows the icons
  themselves (`.ns-home-f-icons` with one `.ns-home-icon-swatch` per candidate, 34px each, wrapping; the picked one lights
  up its border and the icon name stays in the tooltip — a dropdown of identifiers like `pencil` / `maximize` nobody
  reads). Changing the jump type refills every cell you have not touched with that destination's title / subtitle / icon /
  section (the recipe or skill name, the link's host); text you typed stays. Recipes and skills that already have a card
  are dropped from the candidates, so one destination never shows two cards. Only Save writes the card into the draft (the
  20-custom-card cap is said on that button), Cancel and Esc drop this one. × and Esc close this face only, never the page's
  edit mode, and leaving edit mode (Esc / switching pages) closes it with the draft.
- A custom card's jump type is one of three: director recipe / skill / external link (`FORM_TARGETS`); a recipe or skill
  target left as "None" just opens the director page / the skills page. Edit mode and direct page (`target: "edit"` /
  `"page"`) come from the built-in preset cards and the UI no longer creates them; cards an older layout saved with those
  types still read, jump and delete, and both the frontend read gate (`HOME_TARGETS` + `LEGACY_TARGET`) and the backend
  `CUSTOM_TARGETS` keep them so one save cannot silently drop a card the user owns. `hidden` holds built-in cards only: a
  custom card an older layout hid shows on the home again, keeping its slot of `order`.
- A skill card lands on the page that applies the skill: `openHomeCard` checks the id against `listVideoSkills()`, and a
  video skill goes through `openVideoReuse({ skill })` so the video page opens with that skill selected (when that page
  was never built in this window, the `setVideoPageJump` hook the app registers at startup builds it first and the run is
  handed over in the same gesture; only the canvas page, which has no app layer, says "The video page is not ready yet").
  A skill that is no longer in that page's dropdown names the skill and points to the Skills page, and fills everything
  else as before. An
  image-generation skill opens the paint page and `paintTextHost.__neoSetPrompt({ skill })` selects it. A skill with no
  slot in either page's skill list (enhancement / template skills) says on screen that it has no page to land on and
  opens the skills page.
- The drop gesture is vendored SortableJS (`studio/web/vendor/sortable.min.js`, 1.15.7, MIT, pulled in by
  `import "../vendor/sortable.min.js"` in `home-layout.js`, the same route marked/purify take — the three third-party
  libs all live in `studio/web/vendor/` — nothing fetched at runtime):
  `decorateGrid` builds one instance per grid in edit mode — `group: "ns-home"` lets the three grids accept each other's
  cards, `draggable: ".ns-home-card"` keeps the 添加卡片 placeholder and the section headers out of it, `ignore` keeps the
  buttons on a card from starting a drag, `animation: 150` is the slide of the cards making room, and
  `forceFallback: true` with `fallbackOnBody: true` means the card riding the pointer is Sortable's clone pinned to
  `body` (`.sortable-fallback`, styled by `.ns-home-card.is-dragging`) while the card in the original slot keeps
  `.sortable-chosen` — with forceFallback Sortable never applies `ghostClass`, so passing it would be a dead option and
  only `dragClass` is passed. The whole card is the gesture and the card no longer carries a native `draggable` (the two gestures cannot
  run side by side); dragging on touch devices is taken by the same instance.
  The drop reads only what `onEnd` hands over — `oldDraggableIndex` / `newDraggableIndex` (which slot the card lands in;
  the last one is "move to the end"): inside one section it goes through `moveCard`, a custom card crossing a section
  writes `custom[].section` and lands in that slot, a built-in card dropped into another section is sent back with
  `cancel()` and the bar writes "Built-in cards reorder inside their own section; custom cards can be dragged into
  another section" instead of letting the user try.
  Redrawing the home page swaps the whole set of grid elements: `renderHome` hands the grids to `decorateGrid` only after
  they are in the document — an instance built on a detached grid knows how to start a drag and nothing else (measured in
  a real browser: `dragStarted` / `emulateDragOver` / `onDragOver` all fire, no card ever changes slot); a grid that is
  not in the document this round gets no instance and is decorated by the next round. `render()` destroys the previous
  round's instances when it bumps the round (`gridEpoch`), while the old grids are still in the document (the home page
  only calls `replaceChildren` after `onDraft`): the instance's `document`-level listeners (`dragover` / `drop` /
  `keydown` / `visibilitychange`) do not leave with the grid, so destroying them after `replaceChildren` would leave them
  on the page. A detached grid's instance is dropped without calling `destroy()` (`Sortable.destroy()` writes
  `el.parentNode`, which throws on a detached element). Re-decorating the same grid inside one round drops its old
  instance first, so one grid never carries two gestures.
- In edit mode the entry button *is* Done: it sends one `POST /neo_home/layout`, broadcasts `neo:home-layout`, the home page
  redraws from the shape that comes back, edit mode ends and a saved toast says it on screen. That POST writes
  `hidden_sections` as an empty list, so a section an older layout collapsed comes back expanded on this save.
  "Restore defaults" sends `POST /neo_home/layout/reset`, deletes the layout file, and broadcasts exactly once with its own
  toast.
- Esc and navigating to another page (`route()` calls `stopHomeEdit()` when the target is not home) discard the draft: the
  home page falls back to the layout that is on disk, with no request and no file write. When the POST behind Done fails the
  page stays in edit mode with the draft intact and the button is clickable again; the in-flight save disables the button
  (`homeSaving`) so one click cannot become two requests. The layout never lives in localStorage - the plugin page, the
  desktop window and the paired phone page share `configs/home_layout.json` in the data root.
- The card table, the layout shape and the editor's decorate hooks (`decorateHero` / `decorateCard` /
  `decorateGrid` / `addTile`) exist once, in `studio/web/studio/home-layout.js`; `studio-app.js` only builds the DOM, hands the built
  hero and card to those hooks and wires the Done button at the bar's right end to the editor's `save()`. "Which page this
  card lands on" is the card's target / value data, applied
  by `openHomeCard` in `studio-app.js`. The settings sidebar no longer has a 首页 entry. Cases:
  `studio/tests/js/home-layout.test.mjs`, `studio/tests/test_home_layout.py` and the layout cases in
  `app/tests/test_studio_server.py`.
- The 声音克隆 card in Create and the 图片反推 card in Edit are two `target: "page"` cards (`value: "voice"` /
  `"reverse"`) that land in two branches of `route()`, mounting the `#/voice` and `#/reverse` pages
  (`studio/web/voice-clone/voice-clone.js`, `studio/web/reverse-prompt/reverse-prompt.js`). The seven top-bar tabs
  give them no place: hide the card on the home page and the page has no way in. Both pages ride the same
  "views stay mounted, pages show and hide" route as every other page, and their run buttons go through
  `RUN_GATES` (`voice` / `prompt_reverse`) — offline, clicking one starts the kernel instead of sending a request
  that can only answer 409. Cases: `studio/tests/js/studio-home-pages.test.mjs`,
  `studio/tests/js/reverse-prompt.test.mjs`, `studio/tests/js/voice-clone.test.mjs`.

## Settings page groups

- The ten entries in the settings sidebar run top-down in four blocks: `Startup & Connection` (Startup Settings /
  Startup Log / Phone Pairing), `Generate` (LLM Settings / Image Gen Settings / Video Gen Settings), `Agent` (Agent
  Preferences / MCP Server) and `Language & About` (Interface Language / About). Between the blocks there is only a
  text-free hairline `.ns-settings-sep`, a sibling of the tabs inside `.ns-settings-tabs` — the line carries no label, so
  the sidebar shows exactly one row per setting. The tab `data-key`s and the `#/settings?tab=..` deep links are
  unchanged, and when a tab is dropped the lines follow the tabs that remain: in a browser tab, where there is no
  Startup Settings panel, only that one tab is removed and no line is left hanging at the top of the strip. With the
  首页 tab gone together with the home page's own inline editing, an old `?tab=home` bookmark falls back to the default
  panel (`showSection`), so the settings page never opens blank.
- The long panels keep their titled sections: Startup Settings splits into `ComfyUI location` (root / interpreter),
  `Network & port` (port / LAN listening / remote ComfyUI) and `Desktop window` (frameless window / dev mode), with the
  start / stop buttons and the state line kept above the sections; LLM Settings splits into `Provider & model`,
  `Connection` (API Key and custom endpoint) and `Local model` (models folder and the two auto-unload checks), where the
  last two sections hide their heading together with the rows (`.rs-form-group`), so switching to Local GGUF leaves no
  heading over an empty section; Image Gen Settings splits into `Model` (model / Text Encoder / VAE) and `Output`
  (target pixels / output prefix).
- The 🅝 settings popup in the ComfyUI top bar uses the same order: the three generate tabs (LLM Settings / Image
  Defaults / Video Models) first, Interface Language last, with one `.neo-settings-sep` between them.
- Block names are not UI copy — they only become the hairline; tab names and in-panel section labels are Chinese-source
  keys in `studio/web/js/core/i18n.js`, and the shared forms (LLM / image / video) keep Chinese.

## Info notes in Startup settings

- Every row in "Startup settings" carries an ⓘ next to its label; hovering it (keyboard focus works the
  same way) spells out that row's prerequisites and how it takes effect: root / interpreter / port / LAN
  listen / Remote ComfyUI go through "Save and restart ComfyUI", frameless applies immediately and is
  stored in the config, dev mode needs the desktop window to restart, and the Pose repo saves and starts
  one background sync round at once. The text lives in `TIPS` in
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
- With LAN listening on, the desktop service binds itself to the picked NICs too (`lan_bind_hosts`; `0.0.0.0` binds
  the wildcard alone - binding loopback again on that port collides), because the pairing page lives only on the
  desktop-service port and a phone cannot reach a 127.0.0.1-only bind. The `lan_surface` middleware gates every
  non-loopback peer by its address: a private-range device uses this machine as a second screen - the page, the gallery,
  the pose page, the recipes and the skills data routes answer it (a pair page alone leaves the phone's gallery empty
  and the pose page reading 「后端未就绪」). `lan_path_open` hides the desktop-management surface - `/neo_mcp*`,
  `/neo_studio/launcher`, restart / shutdown / log / memory, `/neo-studio/settings`, the QR data on `pair/info` and its
  bridge counterparts - and `/userdata/configs/` (`remote_llm_config.json` / `backyard_oss.json` / `model_hub.json`
  live there); public and link-local peers get nothing. With LAN listening off the desktop service binds loopback only.
- A phone browser on `http://<LAN IP>:<port>/neo-studio` is the same route, and the layout folds itself in two media
  queries: `max-width: 720px` folds the layout (the 6-tab header becomes one horizontally scrollable strip, all eight
  pages go single-column, no horizontal overflow inside a page) and `(hover: none) and (pointer: coarse)` folds the
  touch behaviour (44px targets including the queue and Settings icon slots, 16px inputs so iOS does not zoom the
  page, the six hover-only gallery controls permanently visible). Neither block reaches the wide desktop window or
  the ComfyUI sidebar.
- The drag-to-resize sashes (the director page's gen panel, the 技能 page's skill list) are mouse gestures, so on a
  phone they are removed and the widths are pinned back by CSS. Safe areas are handled with `viewport-fit=cover` +
  `env(safe-area-inset-*)` on the header edges, the page bottom padding, the video composer and the asset-picker
  dialog bars; the input cards switch from `100vh` to `100dvh` under `@supports` so the pinned 生成 button is not
  hidden behind the mobile browser's toolbars. The Pose page is a three.js iframe: only its shell stacks (scene
  library and control panel below the canvas), the 3D controls inside keep their layout.

## Phone pairing (scan to enter Studio)

- "Settings → Phone pairing" shows a QR code and the pairing link once LAN listening is on: the link is
  `http://<LAN IP>:<port>/neo-studio/pair?token=<one-time token>`; the phone scans it, its browser verifies the token,
  and a valid scan hands back the `http://<LAN IP>:<port>/neo-studio` entry. Nothing is installed on the phone - this is
  the same LAN direct path described above.
- The token is minted by the desktop service and persisted in `launcher_config.json` as `pair_token` /
  `pair_expires_at` / `pair_host`, valid 5 minutes; the panel's countdown rotates it at zero, and the "refresh now"
  button rotates it too. The save writes only those three fields and touches no startup setting.
- The panel reads its data over two channels with the same semantics: inside the desktop window the pywebview
  bridge (`pair_info` / `pair_rotate`) comes first — it lands later than the page script after a full-page reload, so
  it is what fills the gap — and the page uses `GET /neo-studio/pair/info` and the `pair_rotate` action: the page is
  pinned to the desktop-service port, and the three pair routes are on that same origin. The bridge and the desktop
  service share the same `launcher` dict and the same save entry (`app/studio_app.py`), so both channels yield the
  same address and the same QR.
- The QR is generated on the spot by `studio/web/js/core/qrcode-lite.js` (QR Model 2 byte mode, EC level L, mask
  scoring, version fitting) and drawn as inline SVG - no third-party library.
- The three routes `/neo-studio/pair`, `/neo-studio/pair/check` and `/neo-studio/pair/info` are registered by the
  desktop server itself (`app/mobile_pair.py` + `app/studio_server.py`); the ownership table is `app/studio_caps.py`.
  The pair page and `pair/check` answer LAN hosts only: loopback, `localhost` and public hosts get 403. The address on
  the QR comes from `pair.pick_lan_host`: the NIC picked in "LAN listen" first, then the persisted address when it is
  still a physical adapter, then the top of the ranked list. `private_addrs()` ranks 192.168 → 10 → 172.16/12 and
  pushes adapters named `vEthernet` / `Hyper-WSL` / `Loopback` to the end, and link-local 169.254 and public
  addresses never go on a QR (Hyper-WSL's `172.24.80.1` is what hostname resolution reports first on many machines,
  and a QR built from it opens a NIC the phone cannot reach). The picked address is persisted as `pair_host`. The
  bridge channel has no Host header to read, so it mints the QR from the persisted `pair_host`; `pair/info` reads the
  peer off the request Host. All
  three replies carry `Cache-Control: no-store`, and the pair page reports only "valid / invalid" - an expired token
  and a wrong token read the same.
- With LAN listening off the panel shows no QR and names the setting to enable - a control that cannot work is not
  shipped: the link box, the copy button and the refresh button collapse together, and only the "a refresh is what
  produces the code" state keeps the refresh button.
- Tests: `app/tests/test_mobile_pair.py` (token lifecycle / LAN prefixes / host gate / merge-only save / QR host
  ranking), `MobilePairServiceTests` in `app/tests/test_studio_server.py` (the host gate and token checks on the three
  routes) and `LanSurfaceTests` (the peer gate once the port is bound to a NIC), the `lan_bind_hosts` cases in
  `app/tests/test_studio_desktop.py` (which addresses the desktop service binds when LAN listening opens),
  `studio/tests/js/qrcode-lite.test.mjs` (round-trip through its own decoder + spec geometry),
  `studio/tests/js/pair-access.test.mjs` (QR on screen, copy, refresh, polling stops on tab change).

## Remote ComfyUI

- "Startup settings → Remote ComfyUI" takes `http://host[:port]` (`https` too; path / query / fragment / credentials
  are rejected) and stores it as `remote` in `launcher_config.json`. When it is set, the window opens
  `http://<remote>/neo-studio` directly and the probe and the ready jump both target the remote base — `probe()` takes
  a base URL, `http://127.0.0.1:port` in local mode. An empty field means local, which is the default.
- Remote mode never starts a local process: `port_busy`, `free_comfy_port`, `start_comfy`, `port_owner` and `kill_pid`
  are not involved. "Start kernel" becomes "reconnect to the remote", and "Stop kernel" is disabled — the remote
  machine starts and stops its own ComfyUI.
- macOS v1 ships remote-only mode: `python app/studio_app.py --remote <http://host:port>` or the stored `remote`
  field points at the remote machine; local rows stay disabled. The desktop snapshot exposes `remote_ok` /
  `remote_down`, the header shows "Remote ready" / "Remote unreachable", and unreachable remote mode keeps the
  window on the remote guide, where the user can refill the remote address and retry without starting local ComfyUI
  or the local desktop service.
- The macOS remote-only `.app` is built with `bash tools/build_studio_mac.sh`, and the artifact lives at
  `tools/Neo-Studio.app`; launch it with `open tools/Neo-Studio.app --args --remote <http://host:port>` or
  double-click it from Finder. The local artifact is an unsigned ad-hoc build, so Gatekeeper may prompt on first
  launch.
- macOS uses `flock` on `data/.studio.lock`, `osascript` alerts, and `.app` / `.command` interpreter file types instead
  of the Windows named mutex, Win32 alert and `python.exe` picker; remote data reads and writes are delegated to the
  remote machine.
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

## Pose asset auto-sync

- "Startup settings → Pose repo" is a row of its own, stored as `pose_repo` in `launcher_config.json`. The
  validation lives in `app/studio_pose.py`: only a directory carrying the `pose-lib/` container plus
  `package.json` counts as the pose repo root, and a save that fails the check leaves the stored value
  untouched. A saved row starts one background sync round on the spot; saving this row does not restart
  ComfyUI. Repo resolution takes the three candidates in order: the config's `pose_repo` → the
  environment variable `NEO_POSE_REPO` → the `3d-pose-art` directory beside the ComfyUI root. A row left
  empty means auto-sync stays off.
- The startup sequence runs one sync round on a background daemon thread after the desktop service is up
  (`auto_sync` in `app/studio_pose.py`); `studio_desktop.log` gets a `pose auto-sync` line with the dist /
  lib / index counts, and nothing is logged when no repo resolves. The pose page reads the data root per
  request, so the assets land without restarting the window.
- The gate matches `tools\sync_pose_dist.ps1` and `tools\sync_pose_lib.ps1` point for point: files move
  only when the source is newer than the data root, so relaunching an unchanged repo copies nothing, and
  files deleted by hand come back on the next start. dist mirrors through robocopy; pose-lib mirrors the
  local set with the preset set only filling gaps, previews land at the default tier, stale depth
  previews get pruned, and the merged index is rebuilt through the pose repo's
  `node scripts\poseLib.mjs merged --out` - a rebuild also fires when the index is missing, when a
  preview the index references is not on disk, and when no entry carries a `charKey` (the base filter in
  the pose-library modal has nothing to work on in an index without it). The extra GLBs in
  `pose/dist/models/` that the source build does not carry are parked and restored around the mirror, and
  `pose/scenes/` stays out of the mirror's scope.

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
  errors land here).
- Studio "Settings → Startup log" stitches those two into one panel (the desktop-owned `GET /neo_studio/log`, entries
  carry `src`): the kernel block first, the desktop block after it, and the source filter shows or hides a whole block
  by `src`. Drag-step lines stay out of the panel — one line per drag would push the startup lines off the tail — and
  stay in the file. A browser tab has no desktop trace, so the panel keeps the single kernel block with no headings and
  no desktop filter.

## Related tests

The settings-page grouping is covered by `studio-settings-groups.test.mjs`, the startup-log source blocks and the
filter by `studio-log-panel.test.mjs`, the "Open ComfyUI" link on the kernel row by `studio-kernel-open.test.mjs`,
the pose asset auto-sync's gate and mirror rules by `app/tests/test_studio_pose.py`, and the launcher panel's rows
and ⓘ notes by `studio-desktop.test.mjs`.
`app/tests/test_studio_desktop.py`, `app/tests/test_studio_server.py` and `studio-app.e2e.mjs` —
the narrow-screen and touch layout invariants by `studio-mobile-layout.e2e.mjs` (the 390×844 and 1440×900 viewports) —
see [testing.md](testing.md).
