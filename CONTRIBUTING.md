# Contributing to Neo Studio

> 🇨🇳 中文：[CONTRIBUTING_ZH.md](CONTRIBUTING_ZH.md)

Apache-2.0, public repository. Fork and open a pull request — no organization membership required. The rules
below are what a change gets reviewed against; the full rule set is [AGENTS.md](AGENTS.md) plus the
`AGENTS.md` in `studio/`, `studio/web/`, `app/`, and `tools/`, the module map is
[Developer.md](Developer.md), and the test inventory is [docs/testing.md](docs/testing.md).

## Set up

Clone inside the ComfyUI tree so `folder_paths`, `server` and `comfy.*` resolve:

```
git clone https://github.com/neoneo-ai/neo-studio.git <ComfyUI root>/custom_nodes/comfyui-neo-studio
```

`tools\install_plugin.ps1` installs the kernel plugin from source, `tools\watch_web.py` hot-syncs
`studio/web/` into the installed web directory so a frontend edit lands on a page reload, and
`.vscode/settings.json`'s `python.analysis.extraPaths` points Pylance at the sibling ComfyUI root.

## Run the tests

```
python -m pytest -q studio/tests      kernel plugin: comfy is stubbed, no ComfyUI needed
python -m pytest -q app/tests         desktop service: needs a sibling ../ComfyUI
pwsh tests\run-tests.ps1              both suites in separate processes - the two stub families clash
npm install
npm test                              frontend golden snapshots
npm run e2e                           drives a ComfyUI at http://127.0.0.1:8188, skips itself without one
```

- The suite runs on a 30 second budget. No sleeps, polls, or real timers in a case.
- Never run `node --test` bare: node creation leaves an uncleaned `setInterval`, so the test process hangs on
  a pending timer after every case passed. `--test-force-exit` is built into `npm test`.
- `app/tests` reads a sibling `../ComfyUI` and real outputs from an integrated pack, and `app/studio_app.py`
  imports `pythonnet`, so the desktop suite runs on a dev machine, not in CI. CI gates `studio/tests` and
  `npm test` in `.github/workflows/tests.yml`.
- JS tests are golden snapshots in `studio/tests/js/golden/*.txt`. Run the suite before refactoring
  `prompt-manager.js` or `node-behavior.js`, and rewrite a golden only when the behavior change is intended
  (`npm run update-goldens`).

## Adding a node

All of this in one change:

- the class, plus its module-level `NODE_CLASS_MAPPINGS` and `NODE_DISPLAY_NAME_MAPPINGS`;
- the `NEO_NODES` entry in `studio/__init__.py` — a key missing from that list registers nothing, and the node
  vanishes silently at load;
- `studio/web/docs/<node key>.md`, the ComfyUI property-panel help doc;
- `SEARCH_ALIASES` (lowercase, deduplicated, Chinese aliases and old names), `DESCRIPTION`, `OUTPUT_TOOLTIPS`
  aligned one-to-one with `RETURN_TYPES`, and a `{"tooltip": ...}` on every visible widget;
- `CATEGORY = "Neo Studio"` and a `Neo`-prefixed key;
- the matching `studio/web/<node>.js` with a same-named `.css` for panel UI. Frontend modules load as `.js`
  only — renaming one to `.mjs` makes the whole frontend fail to load.

`studio/tests/test_node_metadata.py` enforces this. V3 nodes use the `io` API
(`io.Schema(description=..., search_aliases=[...])`, `io.Image.Output(tooltip=...)`); do not mix a V3
`io.Schema` with a hand-written `INPUT_TYPES` in one node. Use `io.Autogrow` for a variable number of repeated
inputs such as reference images.

## Adding a route

- Add the entry to the capability table in `app/studio_caps.py`. Everything outside that table answers
  `409 offline` on the desktop and the frontend gates on that flag; do not scatter per-route offline checks.
- Add a case in `app/tests/test_studio_server.py` when the desktop service must serve it offline.
- A module whose handlers the desktop service reuses carries its own `web.RouteTableDef` and must not import
  `PromptServer`, `nodes`, or `comfy.*` — there is no ComfyUI runtime in the desktop process.
- Route paths, request bodies and response shapes stay stable, and every caller in `studio/web/` is updated in
  the same change.

## Docs

`docs/*.md` and `docs/en/*.md` are mirrors: a doc change lands in both languages in the same change.
`README.md` is English and `README_ZH.md` is Chinese, `Developer.md` / `Developer_EN.md` are the same pair, and
`CHANGELOG.md` is English. Install snippets use `<ComfyUI root>` and `<data root>` placeholders, never a fixed
drive letter.

## Package boundary

The Registry package is "git-tracked minus `studio/.comfyignore`". Decide which side of that boundary a new
file belongs to in the same change. Secrets stay local and out of the package: `remote_llm_config.json`,
`backyard_oss.json`, and the `hf_token` / `ms_token` fields of `model_hub.json`. Never commit user data, and
never move the data root into the plugin directory — it resolves through `NEO_STUDIO_DATA`, then the
`configs/data_root.json` pointer, then the plugin directory as the last fallback, and only `plugin_paths.py`
reads it.

## Style

Plain ES modules with no build step; `marked.min.js` and `purify.min.js` stay vendored; a shared frontend
helper goes in `studio/web/js/core/` once more than one module needs it. Python modules start with
`# SPDX-License-Identifier: Apache-2.0` and `from __future__ import annotations`, keep imports at module
scope, write user config files atomically (`<name>.json.tmp` then replace), and re-validate path values that
arrive from combo boxes, request bodies, and saved configs. Comments explain why and name the failure mode
they guard, in Chinese where the module is Chinese. No `einops`. No telemetry, analytics, update checks, or
any outbound network path that is not an explicit user action against Civitai, ModelScope, Hugging Face, an
OpenAI-compatible provider, or Aliyun OSS.

## Commits and pull requests

Conventional Commits with a scope (`feat(studio): ...`, `fix(studio-desktop): ...`, `perf(gallery): ...`,
`refactor: ...`, `docs: ...`, `chore(ci): ...`), one coherent behavioral change per commit, and a PR
description that states the problem, the behavioral change, and the tests run.

Do not bump the version in a feature PR. The version has one source — `studio/pyproject.toml`, read through
`util.plugin_version()` — and a release is a maintainer act: tagging `vX.Y.Z` publishes to the Comfy Registry
and builds the desktop exe.

## What gets rejected

A node that registers without a `NEO_NODES` entry; a data root inside the plugin directory; a secret or user
config inside the package; a route the offline service answers `409` for by accident; a frontend module renamed
to `.mjs`; a test that hangs the runner on a pending timer; telemetry in any form; and code written to look
machine-generated — unnecessary helper layers, vague names, defensive branches with no real failure mode behind
them, and comments that restate the code.
