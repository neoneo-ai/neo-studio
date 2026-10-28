# AGENTS.md

Agent-facing rules for the Neo Studio repo. Read them in this order:

1. This file: the cross-cutting rules and the product invariants every change obeys.
2. The `AGENTS.md` of the directory being changed: [studio/AGENTS.md](studio/AGENTS.md),
   [studio/web/AGENTS.md](studio/web/AGENTS.md), [app/AGENTS.md](app/AGENTS.md),
   [tools/AGENTS.md](tools/AGENTS.md). A rule lives in the deepest one that owns it.
3. The doc for the area being changed: [docs/architecture.md](docs/architecture.md) for the
   repository layout, modules and routes, [docs/testing.md](docs/testing.md) for the test
   inventory, [docs/studio-desktop.md](docs/studio-desktop.md) for the desktop implementation,
   [docs/release.md](docs/release.md) for packaging. [Developer.md](Developer.md) is the map entry.

The version number has one source: `util.plugin_version()`, which reads `studio/pyproject.toml`.
Never hardcode a version in a banner, a test, a doc snippet, or the MCP server. Tagging `vX.Y.Z`
publishes the Registry package and builds the desktop exe from the same tag.

## Project Overview

Neo Studio turns one sentence into prompts, images, and multi-segment film. It ships as one
product in two artifacts: the ComfyUI plugin `comfyui-neo-studio`, built from `studio/`, and the
Neo Studio desktop window, built by `tools\build_studio_exe.ps1`.

- The core is usable the moment it is installed: no model, no API key, no extra dependency.
  Civitai, ModelScope, Hugging Face, remote OpenAI-compatible LLM providers, and Aliyun OSS are
  the optional layer on top, and each degrades on its own.
- User-visible surfaces: the `Neo Studio` node category, the Gallery and Recipes sidebars, the
  top-menu items (Workflow Repair, Model Hub, Skill Management), the standalone Studio page at
  `/neo-studio`, the desktop window with its offline asset pages, and the stdio MCP server.
- The tree, the module list and what each layer owns:
  [docs/architecture.md](docs/architecture.md).

## Engineering Style

- Keep changes small and direct. Touch the narrowest code path that explains the broken node, the
  broken route, the window bug, the data-root bug, or the user-facing behavior. A change that
  spreads across `studio/`, `app/`, `studio/web/`, and `tools/` is more likely bad than good unless
  the broader scope is directly required.
- Prefer practical fixes over broad architecture work. Add a shared module only when it removes
  real repeated logic or matches an existing `studio/web/js/core/` pattern.
- Prefer fewer dependencies. `studio/requirements.txt` is the kernel plugin list and the root
  `pyproject.toml` is the desktop app list; do not add to either. Optional enhancements stay in
  `[project.optional-dependencies]` (`laya`, `pillow-heif`, `oss2`, `pywebview`) and degrade on
  their own.
- Delete obsolete code aggressively: dead fallbacks, migration paths, unused widgets, debug
  prints, compatibility branches, and the tests of code that no longer exists.
- Revert or disable a behavior that breaks users quickly. Removing a broken generation path beats
  keeping a complicated partial fix.
- Preserve existing node keys, display names, route paths, config file names, data directory
  layout, and saved workflow compatibility unless the change is explicitly about replacing them.
- Code must look hand-written for this repository. Changes that read like generic AI-generated code
  get rejected automatically: unnecessary helper layers, vague names, boilerplate comments,
  defensive branches without a real failure mode, broad rewrites, comments that restate the code.
- Comments explain why, not what: the SMB round trip behind `os.walk`, the 64-bit handle
  truncation behind an `OpenProcess` `restype`, the pending timer that keeps `node --test` alive.
  A comment that names no real failure mode is noise.

## Repository Map

- The repo root is the desktop app repository. The root `pyproject.toml` declares desktop
  dependencies only and publishes no Python package; packaging is `tools\build_studio_exe.ps1`.
- `studio/` is the ComfyUI kernel plugin, and its Registry publish metadata, dependency list, and
  package boundary all live in that layer. Run `comfy node publish` from inside `studio/`, never
  from the repo root.
- `ComfyUI\custom_nodes\comfyui-neo-studio` is a generated sync target, not a source tree:
  `sync_plugin()` in `app/studio_app.py` overwrites it from `studio/` on every launch and leaves
  the user data (`gallery/`, `locals/`, `configs/`) where it is. A fix written there is
  overwritten by the next launch: edit `studio/` and let the sync carry it.

## Area Rules

A rule lives in exactly one `AGENTS.md` — the one at the deepest directory that owns the
behavior. A nested file carries only rules this file does not have, points back here for
everything else, and links to a doc page that already owns a rule instead of copying it.

| File                                         | Owns                                                       |
| -------------------------------------------- | ---------------------------------------------------------- |
| [studio/AGENTS.md](studio/AGENTS.md)         | node contract, plugin Python style, plugin-only boundaries |
| [studio/web/AGENTS.md](studio/web/AGENTS.md) | frontend style, shim boundary, golden snapshots            |
| [app/AGENTS.md](app/AGENTS.md)               | window-first startup, ports, child process chain, routes   |
| [tools/AGENTS.md](tools/AGENTS.md)           | gallery preset pipeline, exe and install scripts           |

`studio/tests/test_agent_docs.py` fails when an `AGENTS.md` exists that this table does not
list, so a new layer cannot go undiscovered.

## File Layout

Read a file top-down as "what it defines, then where execution starts, then the details".

- Constants go right after the imports; the primary class, node, route table, or page module
  comes next, and option lists, sub-structures, and leaf formatters go below it.
- A helper an entry point calls goes below that entry point, so the call chain reads downward.
  Module-private helpers stay inside the module: promote one to `studio/web/js/core/` or
  `util.py` only when a second module needs it.
- Test files: imports, fixture constants, cases, helpers last. Group cases by subject and keep
  nesting two levels deep at most.
- Apply this to new files and to the code this change adds. Do not reorder a file the change
  does not need to touch.

## Product Surface

- User-visible copy is Chinese-first; the desktop-window copy goes through
  `studio/web/js/core/i18n.js` and the startup-setting tips live in `studio/web/AGENTS.md`.
- A control that cannot work is not shipped. Say in the UI that the capability is unavailable;
  never leave an option that is only going to fail.
- Installed copies stay readable. `launcher_config.json`, the `configs/*.json` files, recipes,
  skill `workflow.json`, and saved user workflows are read by a plugin build and an exe older
  than the one being edited. Add fields with a compatible read and ignore unknown keys; never
  change what an existing field means, and never add a legacy alias for an API this repo no
  longer uses.
- One feature has five names and they are one change: the UI label, the node key with its
  `NODE_DISPLAY_NAME_MAPPINGS` entry, the route path, `studio/web/docs/<node key>.md`, and the
  matching `docs/` page. Renaming any one of them renames all five.
- Destructive actions stay on the single-item routes the UI already offers. Do not add a bulk
  "clear everything" action to a product surface; the delete rules live in Data, Config, and
  Secrets.

## Architecture Boundaries

- Keep each layer focused on the concepts it owns. Do not leak window management, launcher
  state, Registry publishing, or desktop process concerns into plugin modules, and do not leak
  node, route, or gallery concerns into the desktop app.
- What the offline desktop service can serve is decided by the table in `app/studio_caps.py`
  and nothing else. Add a route to the table when it needs no ComfyUI runtime; everything outside
  it answers `409 offline` and the frontend gates on that flag. Do not scatter per-route offline
  checks through handlers, and keep no second copy of the table in the frontend.
- Data root resolution lives only in `plugin_paths.py`. No other module reads `NEO_STUDIO_DATA`,

## Data, Config, and Secrets

- The data root resolves in three steps: the `NEO_STUDIO_DATA` environment variable, then the
  `configs/data_root.json` pointer the desktop app writes, then the plugin directory as the last
  fallback. User data never lives in the plugin directory; it keeps code and built-in presets only.
- Built-in presets ship with the code in `studio/configs/`, `studio/prompts/presets/`,
  `studio/skills/presets/`, `studio/skills/tasks/`, and `studio/recipes/presets/`. `seed_presets()`
  copies missing files into a fresh data root and never overwrites a file the user changed; do not
  add a second seeding path.
- Missing config files fall back to the `DEFAULT_SETTINGS` in code. Do not ship default copies of
  user config.
- Secrets stay on the local machine and out of the package: `remote_llm_config.json`,
  `backyard_oss.json`, and the `hf_token` / `ms_token` fields of `model_hub.json` are gitignored and
  excluded by `studio/.comfyignore`. Never log an API key, never echo one back, never send one
  anywhere but its provider endpoint.
- Cache directories stay deletable and rebuildable: `gallery/thumbnails/`, `gallery/lora_cache/`,
  `gallery/oss_cache/`, `gallery/waveform_cache/`, `configs/gallery_dim_cache.json`, whose key
  stays path + mtime + size.
- Never delete user data, and never delete a directory, without the user's explicit confirmation
  in this conversation. This covers the commands the agent itself runs: `git clean -fdx`,
  `Remove-Item -Recurse`, `rm -rf`. The data root and every subtree under it, ComfyUI's
  `custom_nodes` tree, and anything outside this repo all count as user data.
- The only exception is data the agent created for one test run, and only inside the temp root
  `conftest.py` pins. Production code deletes only its own scratch: the sync staging and backup
  directories and the WebView cache in `app/studio_app.py`, the cache paths above, and the
  single-item routes the UI already offers. Walking a user tree with `Remove-Item -Recurse -Force`
  is a data-loss bug, not a cleanup.
- Pruning this repo deletes Git-tracked paths only. Untracked and gitignored local files
  (`node_modules/`, `tmp/`, `build/`, `data/`, and the cache paths above) are not cleanup targets,
  and clearing any of them needs the same explicit confirmation as a delete.
- The Registry package boundary is "git-tracked minus `studio/.comfyignore`": `tests/`, `tools/`,
  `docs/`, `.vscode/`, `.github/`, and dev-only scripts stay out of the package. When adding a file,
  decide which side of that boundary it belongs to and update the ignore file in the same change.

## Network Boundary

- Neo Studio talks to the network on purpose: Civitai, ModelScope, Hugging Face, remote
  OpenAI-compatible LLM providers, and Aliyun OSS are product features. Every outbound request is
  initiated by an explicit user action in this repo and scoped to what the user asked for.
- No telemetry, analytics, tracking, usage reporting, crash reporting, update checks, remote
  feature flags, licensing checks, or any other background network path. There is no opt-in,
  opt-out, anonymized, aggregated, diagnostic, or user-triggered exception to this rule.
- No background polling that keeps hitting a provider after the user stopped caring about the
  result. Task watchers poll the local ComfyUI queue, not a cloud endpoint.
- Local control planes are loopback-only. The MCP server refuses a non-loopback ComfyUI URL at
  startup, the desktop service binds locally, and generation endpoints are reached on
  `127.0.0.1`. The MCP transport and write-surface contract is in
  [docs/mcp.md](docs/mcp.md).
- Model downloads land in the model folder that matches the repo path, stay resumable, and carry
  no telemetry and no unrelated metadata upload.
- Optional providers degrade on their own without a network call, as the dependency rule in
  Engineering Style says; a page whose provider is missing shows itself as unavailable.

## State Ownership

- Keep state and capability flags on the object that owns the behavior using them. The offline
  capability table belongs to `app/studio_caps.py`; do not probe plugin module attributes to
  decide what the desktop service serves.
- Avoid probing child objects with `getattr(child, "...", default)` to drive parent control flow.
  If parent code must branch on a capability, initialize an explicit parent-owned field when the
  child is attached.
- Do not add global, module-level, class-level, singleton, or model-owned stores for media, task
  tables, caches, or LLM clients that outlive one request. Scope a cache to the call that needs
  it, pass it through the call stack, and let it go when that call returns.

## Interface Contracts

- Preserve how existing callers invoke a shared helper. Do not change required arguments,
  parameter order, return shape, side effects, or error behavior unless every call site is
  intentionally updated.
- Do not add compatibility parameters, stored-but-unused values, or legacy aliases for an API the
  repo no longer uses. Remove the pass-through value instead of keeping it.

  parses the pointer file, or computes a fallback root.
- Before touching many files, identify the layer that owns the problem. A change that spreads
  one feature across `studio/`, `app/`, `studio/web/`, `tools/`, and `.github/` needs a clear
  reason, not convenience.
## Testing

- Python unit tests run without ComfyUI, and the two suites run in separate processes:
  `python -m pytest -q` for the `testpaths` in `pytest.ini`, `pwsh tests/run-tests.ps1` for both
  suites. Desktop cases need a real `folder_paths`, node cases need a stubbed `comfy`, and the two
  stubs are incompatible in one process.
- The suite runs on a 30 second budget: the full Python suite takes about 28 seconds and `npm test`
  about 12 today. A new case that pushes a suite past 30 seconds is too slow: cut it, mock the slow
  boundary, or move it to e2e.
- No sleeps, polls, or real timers in unit tests. A case that needs a longer timeout than the runner
  supplies is a slow case.
- New tests rely on the root `conftest.py` pinning `NEO_STUDIO_DATA` to a temp directory. Never
  point a test at the real `Neo-Studio/data/`.
- Never run `node --test` bare: node creation leaves an uncleaned `setInterval`, so the process
  hangs on a pending timer after every case passed. The force-exit flag is built into `npm test`
  and `tests/run-tests.ps1`.
- Test the user-visible failure path: a missing config falling back to `DEFAULT_SETTINGS`, the
  three-step data-root resolution, a path re-validated at the load/save boundary, an older recipe
  or config reading a field this change added, and the offline `409` gate.
- Do not add cases for trivial construction or plain getters, and do not keep a case for a code
  path this change deleted.
- Suite inventory, runner flags, e2e environment switches, and the Pylance `extraPaths` assumption:
  [docs/testing.md](docs/testing.md).

## Docs Discipline

- Behavior is the unit of work, and the code path leads. When a change has a code path to fix and
  doc text to update, name the code path that produces the behavior first, land the fix, then
  update what it invalidates. A plan whose deliverable is doc text is a misdiagnosis.
- Doc volume is not progress: a small fix should not arrive with a rewritten page around it, and a
  docs-only commit is for a real doc gap, not for polishing prose while a code problem is open.
- `docs/*.md` and `docs/en/*.md` are mirrors. A doc change lands in both languages in the same
  change; a page that exists in one language only is a defect. The README / Developer pairs and the
  `<ComfyUI root>` / `<data root>` placeholder rule are in [CONTRIBUTING.md](CONTRIBUTING.md).
- Documentation states facts tied to the behavior that changed. No narrative, no marketing
  expansion, no feature list attached to a fix.
- Install and config snippets use `<ComfyUI root>` and `<data root>` placeholders. Do not write
  fixed drive letters into docs, scripts, or test fixtures.
- Registry `description` and `keywords` are the search surface `comfy-cli` writes into the Registry
  list: name real nodes, not abstract marketing text.
- Markdown tables get read raw in terminals, diffs, and editors at least as often as they get
  rendered: pad every cell to its column width so the columns line up as plain text. Pad the tables
  this change touches; leave a table it does not touch alone.
- `AGENTS.md` files, `CONTRIBUTING.md`, and `CONTRIBUTING_ZH.md` are not part of the `docs/` mirror
  pair and carry no translated twin. A rule lands in one `AGENTS.md` once; do not open an
  `AGENTS_ZH.md` beside any of them.

## Commit and Review Habits

- Use Conventional Commits with a scope (`feat(studio): ...`, `fix(studio-desktop): ...`,
  `docs: ...`), one coherent behavioral change per commit, and a short PR description: the
  problem, the behavioral change, the tests run.
- Do not bump the version in a feature change; a release is a maintainer act.
- A user-visible change gets its `CHANGELOG.md` entry in the same change: English, naming the
  behavior the user gets, not the files touched.
- The commit format, the PR shape, and the list of changes a review rejects live in
  [CONTRIBUTING.md](CONTRIBUTING.md).

