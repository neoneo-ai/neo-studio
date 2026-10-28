# Neo Studio Developer Docs

> 🇨🇳 中文: [Developer.md](Developer.md)

For developers: project structure, front-end and back-end module responsibilities, API routes, node registration,
data directories, testing and release. End-user documentation lives in [README.md](README.md); the detailed docs are
split by major module under `docs/en/` (index: [docs/en/README.md](docs/en/README.md)).

## Documentation map

| Doc | Content |
|-----|---------|
| [docs/en/architecture.md](docs/en/architecture.md) | Project structure, module responsibilities, node registration, data & configuration directories |
| [docs/en/api-routes.md](docs/en/api-routes.md) | Backend API route overview |
| [docs/en/studio-desktop.md](docs/en/studio-desktop.md) | Studio desktop: startup sequence, frameless window, close teardown, plugin sync, cache and logs |
| [docs/en/mcp.md](docs/en/mcp.md) | MCP server (`studio/mcp_server.py`, stdio, external agents calling image & director capabilities) |
| [docs/en/testing.md](docs/en/testing.md) | pytest unit tests and JS regression tests (golden snapshots, run-tests.ps1) |
| [docs/en/release.md](docs/en/release.md) | Registry publishing and offline tooling (preset preprocessing / OSS deployment) |
| [docs/en/llm.md](docs/en/llm.md) | LLM modes, local GGUF installation, model directory conventions |

Feature module docs (user guide + implementation details):
[prompts](docs/en/prompts.md) · [skills](docs/en/skills.md) · [image-gen](docs/en/image-gen.md) ·
[h3-video-gen](docs/en/h3-video-gen.md) · [recipes](docs/en/recipes.md) · [gallery](docs/en/gallery.md) ·
[workflow-repair](docs/en/workflow-repair.md)

Agent and contributor rules do not live in `docs/`: the root [AGENTS.md](AGENTS.md) holds only the
cross-cutting rules and product invariants, while `studio/`, `studio/web/`, `app/` and `tools/` each
carry their own `AGENTS.md` with the rules specific to that layer.

## Quick tour

- **Plugin entry** `__init__.py`: imports the backend modules to register API routes, merges node mappings following
  the `NEO_NODES` list and prints the version banner, and declares `WEB_DIRECTORY = "./web"`.
- **Node registration**: `NODE_CLASS_MAPPINGS` at the bottom of `prompts.py` (NeoPromptEncoder / NeoPromptAgent),
  plus NeoImageGenEdit from `image_gen_edit.py` (a V3 node + Autogrow reference images).
- **API routes**: the gallery family and `llm.py` (LLM configuration / title extraction) carry their own
  `web.RouteTableDef` and are mounted onto `PromptServer.instance.routes` by `__init__.py` (the remaining modules
  still register with direct decorators); the list is in [docs/en/api-routes.md](docs/en/api-routes.md).
- **Studio desktop**: `app/studio_app.py` (pywebview + WebView2) starts ComfyUI and hosts the window; the
  desktop-side service reuses the same handlers on the ComfyUI port +3 to run the offline Studio
  (`app/studio_server.py` plus the `app/studio_caps.py` capability table). Startup sequence, guide page, frameless
  window and dragging, close and process reaping, single-instance lock, plugin sync, cache and logs:
  [docs/en/studio-desktop.md](docs/en/studio-desktop.md).
- **Frontend assets**: the modules under `web/` are loaded by the ComfyUI extension mechanism (only `.js` is
  accepted); the standalone Studio page lives in `web/studio/`, cross-node shared utilities in `web/js/core/`, and
  node help documents in `web/docs/<node key>.md` (the ComfyUI native convention path, loaded directly by the
  property panel's "Info" tab).
- **Data directories**: assets, recipes, prompts, skills and configuration do not live in the plugin directory;
  the resolution order and the directory list are in the "Data & configuration directories" section of
  [docs/en/architecture.md](docs/en/architecture.md).

## Common commands

```bash
python -m pytest tests -v      # Python unit tests (no ComfyUI needed)
npm test                       # JS regression tests (golden snapshot comparison)
pwsh tests/run-tests.ps1       # JS test runner (forced exit on timeout; never run `node --test` bare)
```

Details: [docs/en/testing.md](docs/en/testing.md).

The `folder_paths` / `server` / `comfy.*` imports of the kernel plugin are provided at runtime by the ComfyUI root;
Pylance needs `.vscode/settings.json`'s `python.analysis.extraPaths` pointing at the sibling ComfyUI root to
recognize these imports.