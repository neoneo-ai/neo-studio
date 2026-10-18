# AGENTS.md

Agent-facing rules for the Neo Studio repo. Read [Developer.md](Developer.md) for the
module map, [docs/architecture.md](docs/architecture.md) for directories and routes, and
[docs/testing.md](docs/testing.md) for the full test inventory. This file carries only
the rules a change has to obey.

## Engineering Style

- Keep changes small and direct. Most fixes should touch the narrowest
  code path that explains the broken node, the broken route, the
  desktop window bug, the data-root bug, or the user-facing behavior.
- Change the least amount of files possible. A change that spreads across
  `studio/`, `app/`, `studio/web/`, and `tools/` is more likely to be a
  bad change than a good one unless the broader scope is directly required.
- Prefer practical fixes over broad architecture work. Add a shared module only when
  it removes real repeated logic or matches an existing `studio/web/js/core/` pattern.
- Prefer fewer dependencies. `studio/requirements.txt` is the kernel plugin
  list and the root `pyproject.toml` is the desktop app list; do not add to
  either. Optional enhancements stay in `[project.optional-dependencies]`
  (`laya`, `pillow-heif`, `oss2`, `pywebview`) and degrade on their own.
- Delete obsolete code aggressively. Remove dead fallbacks, migration paths, unused
  widgets, debug prints, and compatibility branches that are no longer needed. Do
  not leave dead branches, unreachable code, or tests for code that no longer exists.
- Revert or disable problematic behavior quickly when it breaks users. It is
  better to remove a broken generation path than keep a complicated partial fix.
- Preserve existing node keys, display names, route paths,
  config file names, data directory layout, and saved workflow
  compatibility unless the change is explicitly about replacing them.
- Code must look hand-written for this repository. Changes that read like
  generic AI-generated code will be rejected automatically: unnecessary helper
  layers, vague names, boilerplate comments, defensive branches without a
  real failure mode, broad rewrites, and comments that restate the code.
- Comments explain why, not what: the SMB round trip behind `os.walk`, the 64-bit
  handle truncation behind an `OpenProcess` `restype`, the pending timer that
  keeps `node --test` alive. A comment that names no real failure mode is noise.

## Repo Layers

- Repo root is the desktop app repository. The root
  `pyproject.toml` declares desktop dependencies only and publishes
  no Python package; packaging is `tools\build_studio_exe.ps1`.
- `studio/` is the ComfyUI kernel plugin (`comfyui-neo-studio`). The Registry publish
  metadata, the plugin dependency list, and the package boundary all live in that
  layer: `studio/pyproject.toml`, `studio/requirements.txt`, `studio/.comfyignore`.
  Run `comfy node publish` from inside `studio/`, never from the repo root.
- `ComfyUI\custom_nodes\comfyui-neo-studio` is a generated sync target, not a source
  tree. `sync_plugin()` in `app/studio_app.py` overwrites it from `studio/` on every
  launch and leaves the user data (`gallery/`, `locals/`, `configs/`) where it is.
  A fix written there is overwritten by the next launch: edit `studio/` and let the
  sync carry it.
- `app/` is the desktop app: `studio_app.py` (pywebview + WebView2
  window), `studio_server.py` (offline service: a local process with no ComfyUI
  runtime, not a no-write service), `studio_caps.py`
  (capability table). It owns window, process, and launcher concerns.
- `studio/web/` is the frontend, served through `WEB_DIRECTORY = "./web"`.
  `studio/web/studio/` is the standalone Studio page;
  `studio/web/js/core/` is the cross-node shared tool layer.
- `tools/` holds offline dev and release scripts.
  Nothing in `tools/` ships in the Registry package.
- The version number has one source: `util.plugin_version()`,
  which reads `studio/pyproject.toml`. Do not hardcode a
  version in a banner, a test, a doc snippet, or the MCP server.
- Registry `description` and `keywords` are the search surface that `comfy-cli`
  writes into the Registry list. They name real nodes, not abstract marketing text.

## Architecture Boundaries

- Keep each layer focused on the concepts it owns. Do not leak window management,
  launcher state, Registry publishing, or desktop process concerns into plugin
  modules, and do not leak node, route, or gallery concerns into the desktop app.
- Modules whose handlers the desktop service reuses carry their own
  `web.RouteTableDef` and must not reference `PromptServer`, `nodes`, or `comfy.*`
  in source: there is no ComfyUI runtime in the desktop process.
  `app/tests/test_studio_server.py` asserts this.
- What the offline desktop service can serve is decided by `app/studio_caps.py`
  and nothing else. Add a route to the table when it needs no ComfyUI runtime;
  everything outside it answers `409 offline` and the frontend gates on
  that flag. Do not scatter per-route offline checks through handlers.
  The same table is the request-ownership list the pinned page ships to
  (`route_list()` in the `/neo_studio/version` payload); the frontend keeps no
  second copy of it.
- `studio/__init__.py` registers and merges. It owns no business logic:
  node mappings merge from each module's `NODE_CLASS_MAPPINGS`, routes
  mount from each module's `routes`, and the load banner is its only output.
- Leaf modules own the shared low-level helpers. `plugin_paths.py`
  and `util.py` depend on the standard library only so any module can
  import them without a cycle; do not add a plugin import to them.
- Data root resolution lives only in `plugin_paths.py`. No other module reads
  `NEO_STUDIO_DATA`, parses the pointer file, or computes a fallback root.
- Node code must not reach into ComfyUI internals. Queue submission,
  `/object_info`, folder resolution, and output paths go through the
  ComfyUI public interfaces and the helpers already in this repo.
- Before touching many files, identify the layer that owns the problem. A
  change that spreads one feature across `studio/`, `app/`, `studio/web/`,
  `tools/`, and `.github/` needs a clear reason, not convenience.

## Node Contract

- The node registry is a checklist, not a side effect. Every key in
  `NODE_CLASS_MAPPINGS` is listed in `NEO_NODES` in `studio/__init__.py`; a module that
  fails to import makes its nodes vanish silently, which is why the load banner
  prints the registered count. `studio/tests/test_node_metadata.py` enforces it.
- Adding a node means adding, in one change: the class and its module-level
  `NODE_CLASS_MAPPINGS` and `NODE_DISPLAY_NAME_MAPPINGS` entries, the `NEO_NODES`
  entry, and `studio/web/docs/<node key>.md`. That help doc path is the ComfyUI-native
  property-panel "Info" convention; do not add plugin-side loading code for it.
- Every node carries its own search and hover metadata, which `server.py`
  passes into `/object_info` untouched: `SEARCH_ALIASES` (lowercase,
  deduplicated, Chinese aliases, synonyms and old names), `DESCRIPTION`,
  `OUTPUT_TOOLTIPS` aligned one-to-one with `RETURN_TYPES` (tuple concatenation
  on multi-slot nodes keeps them aligned), and a `{"tooltip": ...}` on every
  visible widget. A `-1` sentinel or a mode switch must say what it means.
- V3 nodes use the `io` API: `io.Schema(description=..., search_aliases=[...])`
  and `io.Image.Output(tooltip=...)`. The same test validates them. Do
  not mix a V3 `io.Schema` with a hand-written `INPUT_TYPES` in one node.
- Use `io.Autogrow` for a variable number of repeated inputs such as
  reference images. Set its minimum to zero when the template has a valid
  no-image path, and cap it only where the template has a real limit.
- Keep `CATEGORY = "Neo Studio"` and keep node keys prefixed `Neo`.
- Frontend extensions load as `extensions/**/*.js` and only
  `.js` is recognized. Subdirectories are fine; renaming a
  module to `.mjs` makes the whole frontend fail to load.
- Node panel UI lives in the matching `studio/web/<node>.js`
  with a same-named `.css`. Shared DOM factories go in
  `dom-utils.js`, dropdowns in `combo-box.js`, toasts in `toast.js`.

## Data, Config, and Secrets

- User data never lives in the plugin directory. The data root resolves
  in three steps: the `NEO_STUDIO_DATA` environment variable, then the
  `configs/data_root.json` pointer the desktop app writes, then the plugin directory
  as the last fallback. The plugin directory keeps code and built-in presets only.
- Built-in presets ship with the code in `studio/configs/`, `studio/prompts/presets/`,
  `studio/skills/presets/`, `studio/skills/tasks/`, and `studio/recipes/presets/`.
  `seed_presets()` copies missing files into a fresh data root and never
  overwrites a file the user changed. Do not add a second seeding path.
- Missing config files fall back to the `DEFAULT_SETTINGS`
  in code. Do not ship default copies of user config.
- Secrets stay on the local machine and out of the package: `remote_llm_config.json`,
  `backyard_oss.json`, and the `hf_token` / `ms_token` fields of `model_hub.json`
  are gitignored and excluded by `studio/.comfyignore`. Never log an API key, never
  echo one back in a response, never send one anywhere but its provider endpoint.
- Cache directories stay deletable and rebuildable: `gallery/thumbnails/`,
  `gallery/lora_cache/`, `gallery/oss_cache/`, `gallery/waveform_cache/`,
  `configs/gallery_dim_cache.json`, whose key stays path + mtime + size.
- Never delete user data, and never delete a directory, without the user's
  explicit confirmation in this conversation. This covers the commands the
  agent itself runs: `git clean -fdx`, `Remove-Item -Recurse`, `rm -rf`. The
  data root and every subtree under it, ComfyUI's `custom_nodes` tree, and
  anything outside this repo all count as user data.
- The only exception is data the agent created for one test run, and only
  inside the temp root `conftest.py` pins. Production code deletes only its
  own scratch: the sync staging and backup directories and the WebView cache
  in `app/studio_app.py`, the cache paths above, and the single-item routes
  the UI already offers. A script that walks a user tree with
  `Remove-Item -Recurse -Force` is a data-loss bug, not a cleanup.
- The Registry package boundary is "git-tracked minus `studio/.comfyignore`".
  `tests/`, `tools/`, `docs/`, `.vscode/`, `.github/`, and dev-only scripts
  stay out of the package. When adding a file, decide which side of that
  boundary it belongs to and update the ignore file in the same change.
- Non-ASCII filenames in packaging scripts must go through
  `git ls-files -z`; default output escapes them into fake names.

## Network Boundary

- Neo Studio talks to the network on purpose: Civitai, ModelScope, Hugging
  Face, remote OpenAI-compatible LLM providers, and Aliyun OSS are product
  features. Every outbound request is initiated by an explicit user action
  in this repo and scoped to the artifact or completion the user asked for.
- No telemetry, analytics, tracking, usage reporting, crash reporting,
  update checks, remote feature flags, licensing checks, or any other
  background network path. There is no opt-in, opt-out, anonymized,
  aggregated, diagnostic, or user-triggered exception to this rule.
- No background polling that keeps hitting a provider after the user stopped caring
  about the result. Task watchers poll the local ComfyUI queue, not a cloud endpoint.
- Local control planes are loopback-only. The MCP server refuses
  a non-loopback ComfyUI URL at startup, the desktop service binds
  locally, and generation endpoints are reached on `127.0.0.1`.
- `stdout` on the MCP server carries JSON-RPC only; all logs
  go to `stderr`. The MCP server exposes no delete endpoint, and its
  recipe writes are `rs_recipes/save` and `rs_recipes/copy`
  (`director_keyframes` only adds keyframe PNGs to a recipe's `assets/`).
- Model downloads land in the model folder that matches the repo path,
  stay resumable, and carry no telemetry and no unrelated metadata upload.
- Optional providers degrade without a network call: a missing `laya`
  install skips the skill recommendation, a missing `pillow-heif`
  skips HEIC files, a missing `oss2` leaves the OSS upload page inert.

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
  app never leaves an orphan ComfyUI behind. `kill_pid()` declares `OpenProcess`'s
  `restype` explicitly, or the 64-bit handle is truncated and the kill fails silently.
- `pythonw` has no console and its `stderr` is `None`. A console
  logging handler interrupts window creation, so desktop logging goes to
  `data/studio_desktop.log` and the pywebview handlers stay console-free.
- Plugin sync copies same-name files from `studio/` into `custom_nodes` and deletes
  nothing in the target. A git checkout is never overwritten; the bundled copy replaces
  an installed copy only when its version is newer, and skips when the directory is busy.
- `tools/watch_web.py` hot-syncs `studio/web/` into the installed plugin web directory so
  a frontend edit lands on a page reload instead of a relaunch. Same semantics as the
  plugin sync: same-name overwrite, nothing deleted in the target.
- pywebview binds WebView2's browser accelerator keys, the default context menu, and DevTools all
  to `debug`, and the value is fixed when the CoreWebView2 environment is created: without it,
  F5, Ctrl+F5, Ctrl+R, and the right-click menu are off in the window. Dev mode is the startup
  setting that turns that flag on (`dev_mode` in `launcher_config.json`) and takes effect on the
  next window start; the Studio page owns its own reload hotkey in page JS, so a frontend reload
  never waits on dev mode.
- The LAN listen startup setting (`listen` in `launcher_config.json`) is ComfyUI's `--listen`; empty keeps the
  loopback-only default. A NIC address always gets `127.0.0.1` added in `comfy_listen()`: the window navigates to
  loopback and `port_busy()` probes loopback, so a listen list without it leaves the window unopenable and a running
  ComfyUI reads as a free port. `save_config()` writes root, interpreter, port, the toggles and the remote address
  together, so "Save and restart" cannot drop a stored setting.
- The remote startup setting (`remote` in `launcher_config.json`) is a base URL normalized by `comfy_remote()`
  (`http(s)://host[:port]`, no path / query / fragment / credentials). It moves the window URL, the probe target
  (`probe()` takes a base URL) and the ready jump to the remote machine; in that mode the desktop never runs
  `port_busy()`, `free_comfy_port()`, `start_comfy()`, `port_owner()` or `kill_pid()`, kernel stop is disabled, and
  the remote machine owns its own root, interpreter, port and listen setting. The remote needs the plugin installed
  and listening, and has no authentication — network access is a firewall and trusted-network decision.
- Frozen builds resolve the ComfyUI root by walking the exe's ancestor
  directories, and package resources go through `_MEIPASS`. Both the onefile
  layout and the onedir layout, which has one extra directory level, resolve.
- When the exe sits in a non-writable directory, the app
  state directory falls back to `%APPDATA%\Neo Studio`.

## State Ownership

- Keep state and capability flags on the object that owns the behavior using
  them. The offline capability table belongs to `app/studio_caps.py`; do not
  probe plugin module attributes to decide what the desktop service serves.
- Avoid probing child objects with `getattr(child, "...", default)` to
  drive parent control flow. If parent code must branch on a capability,
  initialize an explicit parent-owned field when the child is attached.
- Do not add global, module-level, class-level, singleton, or
  model-owned stores for media, task tables, caches, or LLM clients
  that outlive one request. Scope a cache to the call that needs it,
  pass it through the call stack, and let it go when that call returns.
- Frontend caches follow the same rule: anything a user can edit goes through
  `studio/web/js/core/cache.js`, with the TTL as a backstop and an explicit clear
  on the save event. A cache keyed only by path that never invalidates is a bug.

## Interface Contracts

- Route paths, request bodies, and response shapes stay stable for
  the frontend modules that consume them. Changing a route's shape
  means updating every caller in `studio/web/` in the same change.
- Preserve how existing callers invoke a shared helper. Do not change
  required arguments, parameter order, return shape, side effects,
  or error behavior unless every call site is intentionally updated.
- Do not add compatibility parameters, stored-but-unused values, or legacy aliases for
  an API the repo no longer uses. Remove the pass-through value instead of keeping it.
- MCP segment numbers are 1-based for callers and convert to the endpoints' 0-based
  indices inside the server. Keep that mapping at the boundary, not in the endpoints.
- Nodes output only values they own. Do not add pass-through outputs
  for workflow convenience; the input flows to the next consumer.
- Prompt, conditioning, bundle, and media outputs stay on their own sockets.
  Do not expose an intermediate image from a prompt node as a convenience
  output; use the existing image path or a dedicated image operation.

## Python Style

- Keep imports at module scope. Plugin and desktop modules
  start with `# SPDX-License-Identifier: Apache-2.0` and
  `from __future__ import annotations`; new modules keep both.
- `studio/mcp_server.py` stays import-clean: standard library
  only, zero relative imports, no ComfyUI node imports. It
  runs as a standalone subprocess, not as part of plugin load.
- Do not add unnecessary `try`/`except` blocks. Entry-point optional
  imports are the established pattern: each node group degrades on its
  own import failure and prints one short actionable line naming what
  became unavailable. Inside a handler, let the real failure surface.
- Config files users can have open in an editor are written
  atomically: write `<name>.json.tmp`, then replace. Settings
  writers raise so the caller can report a real failure.
- Responses that go to a browser pass through `_json_safe()`,
  so a non-finite float never produces invalid JSON.
- Path values that arrive from combo boxes, request bodies, or saved configs
  are untrusted. Re-validate at the load/save boundary with an existing
  resolver or containment helper; do not rely on the advertised combo options.
- Keep comments sparse, keep them in Chinese where the surrounding module uses Chinese,
  and name the failure mode the code is guarding. Strip comments that restate the code.
- Log lines carry the `[Neo Studio]` prefix through `PrefixFilter`, stay
  short and actionable, and remove noisy logging rather than adding more.
- Avoid `einops` in plugin code; use native torch ops when a tensor is involved.
- Do not create tensors for Python-side control-flow metadata.
  Sequence lengths, split indices, window counts, padding math, slice
  boundaries, and size estimates stay plain Python ints and lists.
- Match the local style of the file you edit: long lines, simple
  module-level helpers, and direct tensor work are all normal here.

## Frontend Style

- No build step. `studio/web/` ships plain ES modules that ComfyUI loads
  directly; do not add a bundler, a transpiler, a package-managed runtime
  dependency, or a source tree that has to be compiled before it works.
- Vendored third-party files (`marked.min.js`, `purify.min.js`)
  stay vendored. Do not replace them with npm dependencies,
  and do not render untrusted text without sanitization.
- Shared tools go in `studio/web/js/core/` once more than one
  module needs them. Module-private helpers stay in the module.
- The standalone Studio page reaches ComfyUI-shaped APIs
  through `studio/web/studio/shim/`. Keep the shim as the
  boundary: page modules do not learn which process served them.
- Frameless window chrome, dragging, maximize/restore, and Esc
  handling stay in the window layer instead of being duplicated per page.
- CSS goes in the module's same-named stylesheet. Do not
  inline styles for structure a stylesheet already owns.

## Testing

- Python unit tests run without ComfyUI: `python -m pytest -q` runs the `testpaths`
  in `pytest.ini`: `studio/tests` and `app/tests`, in separate processes
  (`pwsh tests/run-tests.ps1`): desktop cases need a real `folder_paths`, node
  cases need a stubbed `comfy`, and the two stubs are incompatible in one process.
- The suite runs on a 30 second budget: the full Python suite takes about 28
  seconds and `npm test` about 12 today. A new case that pushes a suite past
  30 seconds is too slow: cut it, mock the slow boundary, or move it to e2e.
- No sleeps, polls, or real timers in unit tests. `npm test` already carries
  `--test-timeout=30000`, and a case that needs a longer timeout is a slow case.
- The root `conftest.py` pins `NEO_STUDIO_DATA` to a temp directory
  before collection and installs a placeholder `studio` package so
  importing the plugin entry point never registers nodes offline. New
  tests rely on that; never point a test at the real `Neo-Studio/data/`.
- JS regression tests are golden snapshots: `npm test` compares
  `studio/tests/js/golden/*.txt` and `npm run update-goldens` rewrites them.
  Run the suite before refactoring `prompt-manager.js` or `node-behavior.js`,
  and rewrite a golden only when the behavior change is intended.
- Never run `node --test` bare. Node creation leaves an uncleaned `setInterval`,
  so the test process hangs on a pending timer after every case passed.
  `--test-force-exit` is built into `npm test` and `tests/run-tests.ps1`.
- E2E tests drive a real ComfyUI frontend at `http://127.0.0.1:8188`
  (`COMFY_BASE_URL` overrides) and skip themselves when the service is
  unreachable. Window-creating cases stay behind `NEO_STUDIO_APP=1`.
- New nodes must pass `studio/tests/test_node_metadata.py`: registry
  keys, the `NEO_NODES` list, the help doc file, aliases,
  description, output tooltip alignment, and visible widget tooltips.
- New routes get an entry in `app/studio_caps.py` and a case in
  `app/tests/test_studio_server.py` when the desktop service must serve them offline.
- Pylance needs `.vscode/settings.json`'s `python.analysis.extraPaths`
  pointed at the sibling ComfyUI root to resolve `folder_paths`, `server`,
  and `comfy.*`; keep that assumption aligned with `tools/install_plugin.ps1`.

## Docs Discipline

- Behavior is the unit of work. When a change has a code path to fix and doc text
  to update, the code path leads: land the fix, then update what it invalidates.
- A plan whose deliverable is doc text is a misdiagnosis: name the code path
  that produces the behavior first, and let the doc edit follow in the same change.
- Doc volume is not progress: a small fix should not arrive with a rewritten
  page around it, and a docs-only commit is for a real doc gap, not for
  polishing prose while a code problem is open.
- `docs/*.md` and `docs/en/*.md` are mirrors. A doc change lands in both
  languages in the same change; a page that exists in one language only is a defect.
- `README.md` is English and `README_ZH.md` is Chinese, each linking the other at
  the top; `Developer.md` and `Developer_EN.md` do the same. `CHANGELOG.md` is English.
- Documentation states facts tied to the behavior that changed. No
  narrative, no marketing expansion, no feature list attached to a fix.
- Install and config snippets use `<ComfyUI root>` and `<data root>` placeholders.
  Do not write fixed drive letters into docs, scripts, or test fixtures.
- Node help docs stay at `studio/web/docs/<node key>.md`
  and cover the widgets, sentinels, and modes.
- Registry `description` and `keywords` are user-facing search text: name real nodes.

## Commit and Review Habits

- Use Conventional Commits with a scope: `feat(studio): ...`,
  `fix(studio-desktop): ...`, `perf(gallery): ...`, `refactor: ...`, `docs: ...`,
  `chore(ci): ...`. The subject is one imperative clause, not a file list.
- Prefer one coherent behavioral change per commit. A dependency pin, the code
  that needs it, and its tests belong in the same commit when they are inseparable.
- Keep PR descriptions short: the problem, the behavioral
  change, the tests run. No implementation diary.
- In reviews, prioritize real user impact in this order: a node that silently vanishes
  at load, a data root that points at the plugin directory, a secret or user config that
  lands in the Registry package, an orphan ComfyUI process after the window closes, a
  route the offline service answers `409` for by accident, a frontend module renamed
  to `.mjs`, a suite that hangs on a pending timer, and noisy or misleading log output.
