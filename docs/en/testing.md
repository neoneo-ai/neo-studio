# Testing

> 🇨🇳 中文: [../testing.md](../testing.md)

Entry point for developers: [../../Developer_EN.md](../../Developer_EN.md).

The pytest configuration is in `pytest.ini` (`testpaths = studio/tests app/tests`, runnable without starting ComfyUI):

```bash
python -m pytest -q studio/tests   # kernel plugin suite
python -m pytest -q app/tests      # desktop suite (needs the sibling ComfyUI root)
```

A full run is split across processes (`tests/run-tests.ps1` with no arguments runs `studio/tests` and
`app/tests` in sequence): the desktop-side cases need the real `folder_paths`, the node cases need a stubbed comfy,
and the two are incompatible in one process. The root `conftest.py` pins `NEO_STUDIO_DATA` into a temporary
directory before collection and clears it on exit, so cases that delete directories or write configuration can
never touch the real data under `Neo-Studio/data/` or the plugin directory.

## Python unit tests

- `studio/tests/test_llm.py` — remote configuration loading / migration, model downloads (ModelScope / HuggingFace
  fallback), translation cache, language detection, text normalization.
- `studio/tests/test_skills.py` — skill scanning and grouping, built-in task skill presence, image decode & scaling,
  multi-result parsing, the skill agent (language-exclusive main-file selection, reference lists, out-of-bounds
  reads refused, on-demand reference reads in the tool loop, local-mode fallback), `gen_image` / `requires_ref`
  metadata pass-through and preservation on edit-save.
- `studio/tests/test_skill_pose_edit.py` / `studio/tests/test_skill_controlnet.py` — the pose-editing and ControlNet preset
  skills: scanning and dedup, `default_prompt` exposure, template placeholders, control chain
  (preprocessor → model patch → sampler) wiring, the control image not occupying an encoder reference slot
  (`control_ref`).
- `studio/tests/test_workflow_repair.py` — the model-path repair matching algorithm: exact / normalized matching,
  quantized-variant replacement, ambiguity rejection, extension constraints.
- `studio/tests/test_image_gen.py` — built-in generation parameter resolution: ratio and size rounding, output-prefix
  sanitizing, automatic model selection, dropdown ordering and auto-selection results, missing-LoRA warnings,
  reference landing, empty-slot pruning in multi-chain slots, image-count override, outpaint / local edit
  restricted to the Qwen Image 2.1 template, ControlNet template slot expansion and reference-count floor,
  workflow graph structure and sidecar writing.
- `studio/tests/test_image_gen_edit.py` — the mini-executor: topological sort and cycle detection, reference resolution
  and output normalization, terminal IMAGE collection and SaveImage skipping, unknown-node errors, tensor →
  base64 PNG round trip, request assembly (missing `workflow.json` errors / references ordered by slot / bundle
  references preferred / count capped by `config.json`'s `max_refs`).
- `app/tests/test_studio_desktop.py` — the Studio desktop (`app/studio_app.py`): ComfyUI root and python path
  resolution (a sibling `python/` of the bundled distribution wins), `/neo_studio/version` probing and polling,
  window geometry read/write (missing file / bad JSON / partial fields), single-instance port occupancy,
  messages going through the system message box (pythonw has no console), suppressing the child console window
  when launching ComfyUI, desktop logging to `data/studio_desktop.log` and the pywebview log handler (pythonw's
  `stderr` is None and a console handler aborts window creation), the window icon path passed to
  `webview.start(icon=...)` and the AppUserModelID (None when the `.ico` is missing), `resolve_root()` under
  frozen mode walking the exe's own ancestors up to the ComfyUI root (recognizing both the single-file build
  under `tools` and the folder build one level deeper) with bundled resources going through `_MEIPASS`;
  `comfy_state()` (one shared poll for the header status and the startup settings; the desktop-launched instance is
  judged by port probing / an external one by finding the PID from the port with `netstat` / nobody listening),
  `comfy_stop()` (after `terminate()`, repeated `kill_pid()` by port until nobody listens; `kill_pid()` uses
  `PROCESS_TERMINATE` and declares `OpenProcess`'s `restype` explicitly, otherwise 64-bit handles are truncated
  and killing fails silently), `comfy_start()` (waits for the old process to exit before `start_comfy`),
  `pid_alive()`, and window close saving geometry only. The window-first startup sequence: opening the window only
  unpacks and creates it (splash page / setup page) while the self-check, the desktop-side service and the ComfyUI
  launch run to completion on a background thread, landing on the full Studio, the offline asset page, or staying
  on the splash page; tests run the background thread synchronously (`_SyncThread`) so the landing point can be
  asserted. Closing the window exactly during a launch (`desktop.closing` gate): the instance that just started is
  reaped immediately, so the desktop leaves no orphan ComfyUI.
- Startup settings (`launcher_api` / `launcher_config.json`): when the plugin directory is not writable the state
  directory falls back to `%APPDATA%/NeoStudio`; the five `startup_state()` states (ready / invalid root / python
  not found / missing plugin dependencies / plugin install failed); configuration read-write round trip and
  relative-path normalization; root resolution priority command line → configuration → plugin sibling;
  `ensure_plugin()` installs the bundled copy when the plugin is missing, together with `requirements.txt`; when
  the exe's bundled copy is newer than the installed one it updates in place (assembled in the state directory
  first, the user data directories merged in, then the directory swapped; a busy directory is skipped), and source
  runs and git checkouts are never overwritten.
- The packaged exe (`tools\build_studio_exe.ps1`: `-Mode onefile` produces `tools/neo-studio.exe`, `-Mode onedir`
  the folder build `tools/neo-studio/Neo-Studio.exe`, `-Mode both` both; the folder build does not unpack at
  startup, and repacking keeps the `data/` next to the package): a stub service makes the desktop believe it is
  ready, the exe is started, `ExtractIconExW` confirms exactly 1 embedded icon resource, `FindWindowW` finds the
  window, `WM_GETICON` returns a 24x24 icon (our `.ico`; the baseline of pythonw with no AppUserModelID and no
  icon is a 48x48 generic icon), `WM_CLOSE` exits with code 0, and `configs/studio_window.json` and
  `data/studio_profile` land in the plugin directory rather than the temporary unpack directory.
- The bundled plugin copy (`build_bundle()` in `tools\build_studio_exe.ps1`): the boundary is "git-tracked minus
  development directories", `configs/` keeps presets only, and user configuration and keys are not in the tracked
  list so they never enter the exe; `tests` / `tools` / `docs` and similar whole directories are excluded;
  non-ASCII file names must go through the NUL-separated output of `git ls-files -z`, since the default output
  escapes them into fake names.
- `studio/tests/test_studio.py` — full-film generation routes and the job watcher, version route, log route
  (`/neo_studio/log` reads the `app.logger` ring buffer).
- `app/tests/test_studio_server.py` — the desktop-side service (`app/studio_server.py`, a process with no ComfyUI runtime):
  a real service is started and hit for real, asserting that with ComfyUI not running the Studio page, frontend
  static files, directory listings, thumbnails and the bookmarks file all come through, while write operations and
  generation routes answer `409 offline`; the gallery module family carries its own `RouteTableDef` and its source no longer
  mentions `PromptServer` (there is no ComfyUI runtime in the desktop process); the startup-settings route
  `/neo_studio/launcher` GET reads the configuration and POST validates before writing (a root without `main.py`
  is refused, an unknown action is refused).
- `studio/tests/test_node_metadata.py` — the node metadata contract: the registry key list, the `NEO_NODES` list in
  `__init__.py` matching the registry, every node having a `web/docs/<node key>.md` help document (the path the
  ComfyUI native "Info" tab fetches), `SEARCH_ALIASES` (lowercase, deduplicated, including Chinese aliases),
  `DESCRIPTION`, `OUTPUT_TOOLTIPS` aligned in count with `RETURN_TYPES`, input tooltips on visible widgets, and V3
  node schema metadata.

## Frontend regression tests (studio/tests/js)

Frontend modules are loaded under jsdom with ComfyUI `api` / `app` stand-ins, and golden snapshots lock the UI
structure, hidden-widget states and request traces. Run them once before refactoring `prompt-manager.js` /
`node-behavior.js`, and rewrite the goldens only after confirming the behavior change is intentional.

```bash
npm test                 # compares studio/tests/js/golden/*.txt
npm run update-goldens   # NEO_UPDATE_GOLDENS=1, writes new goldens
```

- `smoke.test.mjs` — modules import cleanly, node extension registrations.
- `prompt-manager-dom.test.mjs` — UI structure after node creation, body-level popups, hidden-widget states.
- `cache-guard.test.mjs` — the shared TTL cache guard: hit, expiry, explicit clear.
- `node-behavior-flows.test.mjs` — random word picking, Enter streaming generation, skill-routed request bodies,
  the @ image picker, the runtime random menu.
- `studio-skills.test.mjs` — the Skills guide page: the manager is not assembled by default, the three entries,
  importing an API workflow (an interface workflow is refused), returning to the guide and the new template form.
- `llm-setting-advanced.test.mjs` — providers with a preset Base URL keep "custom endpoint" collapsed and an
  edited value still saves after expanding; OpenAI Compatible without a preset stays visible, and Local GGUF hides
  the whole area.

## JS test runner (with forced exit)

**JS tests must run with `--test-force-exit`.** Creating nodes starts `setInterval`s that are never cleaned up,
so without that flag the `node --test` child process can never exit naturally — pending timers keep the event loop
non-idle, which looks like every test passing followed by a hang until timeout. So **never run
`node --test studio/tests/js/*.test.mjs` bare**. Both entry points already carry the flag: `npm test` (package.json) and
`tests/run-tests.ps1` (which additionally force-kills the node process tree on timeout and supports fuzzy file-name
matching).

```powershell
# run every JS test (120s timeout by default)
pwsh tests/run-tests.ps1

# fuzzy file-name matching (comma-separated keywords supported)
pwsh tests/run-tests.ps1 skill-gen-layout
pwsh tests/run-tests.ps1 skill-gen-layout,css-integrity

# custom timeout in seconds
pwsh tests/run-tests.ps1 -Timeout 60
```

Exit codes: `0` = all passed, `1` = failures / no matching files, `2` = forced exit on timeout.

## Browser end-to-end tests (studio/tests/e2e)

Playwright drives the real ComfyUI frontend, verifying what jsdom cannot cover: window controls, the embedded
LiteGraph canvas and similar. **ComfyUI must be running locally (`http://127.0.0.1:8188` by default, overridable
with the `COMFY_BASE_URL` environment variable)**; when the service is unreachable the cases skip instead of
failing.

```bash
npm run e2e                       # studio/tests/e2e/*.e2e.mjs
node --test --test-force-exit --test-timeout=180000 studio/tests/e2e/skill-manager.e2e.mjs
```

- `skill-manager.e2e.mjs` — the skill manager window: overlay pointer pass-through, ⛶ maximize/restore,
  title-bar double-click maximize, Esc close, title-bar dragging, bottom-right handle resize; the workflow area
  expands by default and mounts the embedded editing canvas (canvas filling the box, following window resizes and
  ⛶ maximization, collapse unmounts the canvas, expanding remounts it, the preset-skill save button's explanation
  about automatic copying on structural change, widget popups next to the cursor at 125% zoom, the combo dropdown
  floating above the skill dialog). Screenshots go to `tmp/skill-wf-editor.png` and `tmp/skill-wf-prompt.png`.
- `node-docs.e2e.mjs` — node help: the 11 node documents are reachable at
  `/extensions/comfyui-neo-studio/docs/<node key>.md`, no `neo_help` badge widget remains on nodes, and the
  property panel's "Info" tab renders the document body (skipped when no property panel is registered in the
  session).
- `studio-app.e2e.mjs` — the Studio desktop window: the desktop launches ComfyUI itself, connects over CDP through
  the WebView2 remote debugging port, and asserts the window opens at the size archived in
  `configs/studio_window.json`, the four views render, the header status reports only "● Running" (port / PID in
  the tooltip), the log tab reads console content, and localStorage survives a page reload; the second case uses a
  cold-start dedicated port (`NEO_STUDIO_STOP_PORT`, default 8190; set `NEO_STUDIO_EXE` to run the packaged exe
  instead, passing `--root`/`--python` explicitly since an exe in an arbitrary directory cannot derive the root),
  clicks "■ Stop kernel" at the top of "Settings → Startup settings" to stop the desktop-launched ComfyUI (port probe
  then fails), clicks "▶ Start kernel" to launch it again, and asserts the header shows "● Starting" and that after
  readiness the page connects generation in place (same document, no reload; the user's own service on 8188 is never
  touched); the
  third case asserts the cold-start window shows the splash page first, then lands on the Studio page served by the
  desktop service (port +3, offline mark and thumbnails shown, writes answered `409`), connects generation in place once
  ComfyUI is ready (same URL, offline mark dropped, queue panel reseeded, the desktop origin accepted by ComfyUI), and flips
  back to the offline form after stopping it with no uncaught errors.
  **It opens a real window and is skipped by default; enable with `NEO_STUDIO_APP=1` (prerequisites: `pywebview`
  installed in the bundled distribution's python, and no other Neo Studio desktop holding the single-instance port
  8189 — a new instance exits immediately when a desktop is already running).**
- `prompt-width.e2e.mjs` — prompt node panel width: after creation, `setSize`, and restoring the width through
  workflow `configure`, every `prompt_ui` DOM widget width equals `node.size[0]` (LiteGraph's size setter does not
  fire `onResize`, so the plugin re-syncs in `onConfigure`).
- `paint-panel-layout.e2e.mjs` — Paint text-to-image panel and chip popup layout invariants: the result area
  absorbs the free space above the prompt card and progress / finished images grow upward from the card (content
  starts from the container top when that space runs out, the start hint sits in the middle of it); the LoRA
  dropdown in the popup's right column takes the column's remaining width with strength and ✕ staying on one row.
  Pure frontend: injects `web/studio/style.css`, `web/gallery.css` and `web/prompts.css` into a DOM mirroring the
  real page, no running ComfyUI required.