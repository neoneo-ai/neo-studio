# studio/ 规则（内核插件 comfyui-neo-studio）

本层独有的规则。跨层规则与产品不变量在 [../AGENTS.md](../AGENTS.md)，本文件不复述它；
数据根、密钥、包边界（`comfy node publish` 在 `studio/` 里跑）也归根文件的
Data, Config, and Secrets。模块地图见 [../Developer.md](../Developer.md)。

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

## Architecture Boundaries

- `studio/__init__.py` registers and merges. It owns no business logic:
  node mappings merge from each module's `NODE_CLASS_MAPPINGS`, routes
  mount from each module's `routes`, and the load banner is its only output.
- Leaf modules own the shared low-level helpers. `plugin_paths.py`
  and `util.py` depend on the standard library only so any module can
  import them without a cycle; do not add a plugin import to them.
- Node code must not reach into ComfyUI internals. Queue submission,
  `/object_info`, folder resolution, and output paths go through the
  ComfyUI public interfaces and the helpers already in this repo.
- Modules whose handlers the desktop service reuses carry their own
  `web.RouteTableDef` and must not reference `PromptServer`, `nodes`, or `comfy.*`
  in source: there is no ComfyUI runtime in the desktop process.
  `app/tests/test_studio_server.py` asserts this.

## Interface Contracts

- Route paths, request bodies, and response shapes stay stable for the frontend modules that
  consume them. Changing a route's shape means updating every caller in `web/` in the same change.
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

## Testing

- New nodes must pass `studio/tests/test_node_metadata.py`: registry
  keys, the `NEO_NODES` list, the help doc file, aliases,
  description, output tooltip alignment, and visible widget tooltips.

## Validation

在仓库根目录跑（`pytest.ini` 与 `conftest.py` 都在根，套件里的桩互不兼容）：

```
python -m pytest -q studio/tests
python -m pytest -q studio/tests/test_node_metadata.py   # 新增或改动节点
pwsh tests\run-tests.ps1                                 # 两套套件分进程
```
