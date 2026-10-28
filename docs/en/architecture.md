# Architecture & Modules

> 🇨🇳 中文: [../architecture.md](../architecture.md)

Project structure, backend and frontend module responsibilities, node registration and data directories.
Entry point for developers: [../../Developer_EN.md](../../Developer_EN.md).
The rules for changing a layer live in that directory's `AGENTS.md` (`studio/`, `studio/web/`, `app/`,
`tools/`); the cross-cutting invariants live in [../../AGENTS.md](../../AGENTS.md).

## Project structure

```
Neo-Studio/                            desktop app repo; root pyproject lists desktop deps, publishes no package
├── AGENTS.md                          cross-cutting rules and product invariants
├── CLAUDE.md                          pointer to AGENTS.md
├── Developer.md · Developer_EN.md     module map (Chinese / English)
├── CONTRIBUTING.md · CONTRIBUTING_ZH.md
├── CHANGELOG.md                       English, one entry per user-visible change
├── conftest.py · pytest.ini           test stubs and suite config (data root pinned to a temp dir)
├── docs/ · docs/en/                   architecture / desktop / MCP / release / testing (mirrored pair)
├── app/                               desktop app: window, offline service, launcher
│   ├── AGENTS.md                      window-first startup, ports, child process chain, routes
│   ├── studio_app.py                  pywebview + WebView2, plugin sync, process reaping
│   ├── studio_server.py               offline service: no ComfyUI runtime
│   ├── studio_caps.py                 the offline capability table, the only offline gate
│   └── mcp_client.py · mcp_routes.py
├── studio/                            the kernel plugin comfyui-neo-studio (the Registry package ships from here)
│   ├── AGENTS.md                      node contract, plugin Python style
│   ├── __init__.py                    merges node mappings and routes, prints the version banner
│   ├── plugin_paths.py · util.py      standard-library leaves: data root, shared helpers
│   ├── mcp_server.py                  stdio MCP subprocess, standard library only
│   ├── web/                           frontend, WEB_DIRECTORY = "./web"
│   │   ├── AGENTS.md                  no build step, shim boundary, golden snapshots
│   │   ├── studio/                    standalone Studio page; shim/ is its ComfyUI boundary
│   │   ├── js/core/                   cross-node shared tool layer
│   │   └── docs/                      node help docs, one file per node key
│   ├── configs/ prompts/ skills/ recipes/ example_workflows/   built-in presets
│   ├── gallery/                       preset media; the cache here is the data-root fallback
│   ├── pyproject.toml · requirements.txt · .comfyignore   publish metadata, dependencies, package boundary
│   └── tests/                         node metadata and behavior unit tests
├── __init__.py                        clone-into-custom_nodes compat entry only
├── tests/                             run-tests.ps1: the two pytest suites and the JS runner
├── tools/                             offline dev and release scripts, never packaged
│   └── AGENTS.md                      script groups, gallery preset pipeline, exe build
├── pyproject.toml                     desktop dependencies
└── package.json                       npm test / npm run e2e / npm run update-goldens
```

## Kernel plugin files

One node group per module: each carries its own `routes` and `NODE_CLASS_MAPPINGS`, merged by `studio/__init__.py`.

```
studio/
├── prompts.py                 # prompt nodes + /rs_prompts/* routes
├── prompt_names.py            # prompt name and tag scan + /rs_prompts/list_prompt_names
├── prompt_lines.py            # multi-line prompt collection parsing
├── skill.py                   # skill system + skill routes
├── llm.py                     # LLM inference: remote API / native safetensors / local GGUF
├── laya_router.py             # lightweight local text classification
├── minimax_h3.py              # MiniMax H3 generation modes & grounding
├── h3_prompt_audit.py         # H3 prompt format audit
├── video_gen.py               # global video generation settings
├── h3_video_gen.py            # shared H3 video generation helpers
├── h3_video_director.py       # multi-segment director node NeoH3VideoDirector
├── h3_segment.py              # single-segment generation / regeneration
├── h3_assemble.py             # merging a single segment back into the film
├── h3_preview.py              # live preview during sampling
├── image_gen.py               # image generation backend + /neo_image_gen/* routes
├── image_gen_edit.py          # image generation/editing node NeoImageGenEdit
├── sam3_seg.py                # SAM3 point-prompt segmentation
├── storyboard.py              # storyboard keyframe generation
├── bundles.py                 # runtime bundle (in-memory temporary package)
├── bundle_expand.py           # BUNDLE expand node
├── ref_grid.py                # reference-image grid node
├── grid_split.py              # storyboard grid splitting algorithm
├── grid_split_node.py         # grid split node NeoGridSplit
├── gallery.py                 # asset backend + /neo_gallery/* routes
├── gallery_lora.py            # Civitai LORA example fetching
├── gallery_oss.py             # cloud preset synchronization
├── lora_tag.py                # LoRA image tagging
├── bookmark.py                # bookmarks backend (local / Civitai / OSS)
├── backyard.py                # Backyard preprocessing & OSS upload page
├── recipes.py                 # recipe backend + /rs_recipes/* routes
├── studio.py                  # Neo Studio backend + /neo_studio/* routes
├── model_hub.py               # model hub + /neo_model_hub/* routes
├── model_download.py          # download and placement
├── workflow.py                # workflow repair + /neo_nodes/* routes
├── neo-studio-app.bat         # Studio desktop debug entry (with console)
└── neo-studio-app.vbs         # Studio desktop double-click entry (pythonw, no console window)
```

## Backend modules

### Prompts & LLM

| Module | Responsibility |
|------|------|
| `prompts.py` | Prompt nodes + preset CRUD + image parsing |
| `prompt_names.py` | Prompt name and tag scan (the @ picker's candidates); touches no `PromptServer`, shared with the offline desktop service |
| `prompt_lines.py` | Parsing and random selection of the multi-line prompt collections under `collections/` |
| `skill.py` | Skill scanning and loading, multi-result contract, reference-file tool loop, skill routes |
| `llm.py` | Remote OpenAI-compatible calls, domestic cloud providers, native safetensors text generation, local GGUF inference |
| `laya_router.py` | Lightweight text classification: enhancement-skill selection and intent pre-routing |

### Image generation

| Module | Responsibility |
|------|------|
| `image_gen.py` | Image generation backend: template rendering, queue submission, status push, settings read/write |
| `image_gen_edit.py` | `NeoImageGenEdit`: executes the skill workflow in-process and outputs IMAGE |
| `sam3_seg.py` | SAM3 point-prompt segmentation, producing the binary mask for local editing |
| `bundles.py` | Runtime bundle: in-memory package of prompt + reference images |
| `bundle_expand.py` | `NeoBundleExpand`: expands a bundle into prompt and reference images |
| `ref_grid.py` | `NeoRefGrid`: reference grid → prompt + BUNDLE + IMAGE |
| `grid_split.py` | Grid splitting algorithm: gap detection, thin-strip removal, white-edge cleanup |
| `grid_split_node.py` | `NeoGridSplit`: grid into an IMAGE batch + embedded prompts |

### Video

| Module | Responsibility |
|------|------|
| `minimax_h3.py` | H3 generation-mode decision, grounding constraints, body conditional-section trimming |
| `h3_prompt_audit.py` | Deterministic H3 prompt format audit and narrow-fix messages |
| `video_gen.py` | Global video settings, automatic model and VAE selection |
| `h3_video_gen.py` | Resolves a generation request into template parameters (model/VAE/references/LoRA) |
| `h3_video_director.py` | `NeoH3VideoDirector` multi-segment director; the `NeoH3AddKeyframe` family of injection nodes |
| `h3_segment.py` | Single-segment generation / regeneration: anchor frame extraction, segment range recomputation |
| `h3_assemble.py` | Merging a single segment back into the film: layout records, audio trimming |
| `h3_preview.py` | Live preview during sampling: taeh3 decode + WS event push |
| `storyboard.py` | Storyboard keyframe generation (t2i / r2i) |

### Assets, recipes & tools

| Module | Responsibility |
|------|------|
| `gallery.py` | Directory browsing, thumbnails, upload/delete/rename, lightbox data |
| `gallery_lora.py` | Background Civitai LORA example fetching and caching |
| `gallery_oss.py` | Cloud preset synchronization |
| `lora_tag.py` | Batch `.txt` tag generation for gallery leaf directories |
| `bookmark.py` | Bookmarks backend: local / Civitai / OSS |
| `backyard.py` | Backyard page: Gallery preprocessing and OSS upload management |
| `recipes.py` | Recipe CRUD, one-click send, director recipes and storyboards, import/export |
| `studio.py` | Neo Studio backend: standalone page entry and full-film generation jobs |
| `app/studio_app.py` | Studio desktop: launches ComfyUI and hosts the WebView2 window (geometry / localStorage persistence) |
| `workflow.py` | Workflow model-path repair, repair mappings, skill model suggestions |
| `util.py` | Media extension constants, media probing, metadata and prompt collection |

## Frontend assets

| File | Responsibility |
|------|------|
| `gallery.js` | Asset sidebar main logic (state, persistence, API, view switching) |
| `gallery-list.js` | List browsing: toolbar, breadcrumbs, paging, lazy cover loading |
| `gallery-card.js` | A single card: directory cover, thumbnail, send and bookmark menus |
| `gallery-gen.js` | One-click generation (character sheet / nine-cell storyboard) and its setup dialogs |
| `gallery-setting.js` | Directory-management configuration dialog |
| `gallery-masonry.js` | Card masonry layout |
| `gallery-utils.js` | Asset utility functions |
| `gallery-node-drop.js` | Dragging assets onto canvas nodes |
| `lightbox.js` | Lightbox viewer |
| `media-transfer.js` | Asset upload and transfer |
| `prompts.js` | Prompt node frontend interaction |
| `prompt-manager.js` | Prompt manager (preset list / collection views / save & delete) |
| `prompt-service.js` | Prompt API wrapper |
| `llm-chat.js` | LLM chat domain (input, output preview, skill dropdown, streaming generation) |
| `llm-setting.js` | LLM configuration form |
| `at-picker.js` | `@` image picker |
| `slash-picker.js` | `/` skill quick menu |
| `skill.js` | Skill module facade: assembles the sub-modules below and exports one interface |
| `skill/skill-core.js` | Skill API, Markdown rendering, category tabs, workflow template pre-rendering, writeback change records |
| `skill/skill-writeback.js` | Workflow writeback confirmation, change-record dialog, canvas import & pending-writeback dot |
| `skill/skill-detail-popup.js` | Single-skill detail popup and its cross-node singleton |
| `image-gen.js` | Image generation client and generation settings form |
| `image-gen-edit-node.js` | Image generation/editing node frontend |
| `live-preview.js` | Live preview panel during sampling (shared by the director node, the Studio director page and the agent dock's tool card) |
| `director.js` | Director recipe editor |
| `director-node.js` | Director node's embedded timeline and preview |
| `director-timeline.js` | Reusable timeline component |
| `recipes.js` | Recipe panel logic |
| `bundle-expand.js` | BUNDLE expand node frontend |
| `bundle-lock.js` | Bundle locking and auto-enhancement |
| `ref-grid.js` | Reference grid frontend |
| `workflow.js` | Workflow repair interaction |
| `workflow-graph.js` | Read-only skill workflow flowchart (autogrow slots merged into a synthetic node, internal ids hidden in the graph and tooltips; columns width-aligned, model-loading nodes widened to show the model name; fields filled from settings carry their `{{TOKEN}}` source and the summary lists variable chips); `canvasLayout` re-lays canvas nodes after "import to canvas" with the same layering and in-layer ordering, and returns the shared column width for setSize |
| `workflow-context.js` | Workflow context collection |
| `top-menu.js` | Top-bar 🅝 menu |
| `canvas-lock.js` | Main-canvas offline gate: locks the canvas with the frontend's own `read_only` canvas lock when ComfyUI is gone and shows a banner; unlocks when it returns |
| `node-behavior.js` | Node drag, paste and similar interaction behavior |
| `combo-box.js` | Generic dropdown component |
| `dom-utils.js` | Shared DOM factories |
| `toast.js` | Notification bars |
| `quick-input-history.js` | Quick-input history |
| `studio/` | Neo Studio standalone page (index.html + studio-app.js + shim/) |
| `*.css` | Styles per module |

## Node registration

Node classes are mapped at the bottom of each module and merged by `__init__.py`:

```python
# prompts.py
NODE_CLASS_MAPPINGS = {
    "NeoPromptEncoder": NeoPrompts,    # CLIP node: prompt management + LLM enhancement + CLIP encoding
    "NeoPromptAgent": NeoPromptAgent,  # prompt node: prompt text output + LLM enhancement
}
```

- `NeoPrompts` (Neo Prompt Encoder): outputs `CONDITIONING` + `STRING`
- `NeoPromptAgent` (Neo Prompt Agent): no CLIP input, outputs `STRING`
- `NeoRefGrid` (Neo Reference Grid): outputs `STRING`×2 + `IMAGE`×12
- `NeoBundleExpand` / `NeoImageGenEdit` / `NeoH3VideoDirector` / `NeoH3SegmentRun` / `NeoGridSplit` and the H3
  anchor nodes (`NeoH3AddKeyframe` / `NeoH3AddGuides` / `NeoH3AddContext`) register in their own modules

The frontend extension directory is declared with `WEB_DIRECTORY = "./web"`. ComfyUI loads
`extensions/**/*.js` recursively and **only accepts `.js`**: subdirectories are fine, renaming a file to `.mjs`
makes the whole frontend fail to load.

- `web/js/core/`: utilities shared across nodes. `cache.js` is a TTL cache guard — pull results that the user can
  change, such as recipe specs and skill templates, all go through it (save events clear it explicitly, with the
  TTL as backstop). `i18n.js` is the UI language layer: Chinese source strings are the dictionary keys, missing
  English entries fall back to Chinese, the choice lives in `localStorage["neo_studio_lang"]` and defaults to the
  browser language; the settings dialog's "🌐 Interface Language" tab and the desktop app's "Language" settings tab
  reload the page on selection. What gets translated is the top menu plus the desktop Studio's own strings (header,
  director panel, launcher settings, status pill); shared modules — assets, skills, and the settings
  forms — keep their Chinese source text.
- `web/docs/<node key>.md`: node help documents. The ComfyUI frontend fetches them automatically at
  `/extensions/comfyui-neo-studio/docs/<node key>.md` and renders them on the node's property-panel "Info" tab
  (it tries `<node key>/<language>.md` first and only falls back to `DESCRIPTION`), so the plugin needs no
  loading code.

`__init__.py` registers the 11 nodes and their owning modules in `NEO_NODES`: a module that fails to import makes
its nodes vanish silently, so the list is verified at the end of loading and prints
`[Neo Studio] v<version> registered N/11 nodes`, naming any missing node and its module. The version has a single
source, `util.plugin_version()` (reading `pyproject.toml`, shared with the Studio version page). The consistency
between the list and the registry is validated by `tests/test_node_metadata.py`.

### Node metadata

Nodes must carry their own search and hover information; `server.py` passes it through to `/object_info`
verbatim, and `tests/test_node_metadata.py` validates each one:

- `SEARCH_ALIASES`: frontend search aliases, mixed Chinese and English, lowercase, including synonyms and old
  names.
- `DESCRIPTION`: the node's hover description.
- `OUTPUT_TOOLTIPS`: output tooltips, aligned one-to-one with `RETURN_TYPES` (multi-slot nodes build the tuple by
  concatenation to keep them aligned).
- widget `{"tooltip": ...}`: the meaning of non-hidden inputs; semantics like `-1` and mode switches must be
  spelled out.

V3 nodes (`NeoImageGenEdit`) use `io.Schema(description=..., search_aliases=[...])` and
`io.Image.Output(tooltip=...)`, validated by the same test.

## Data & configuration directories

Every directory below is relative to the **user data root**, not to the plugin directory. The data root is
resolved by `plugin_paths.py`: the `NEO_STUDIO_DATA` environment variable (injected when the desktop launches
ComfyUI) → the plugin's `configs/data_root.json` pointer (written by the desktop, also honored when you start
ComfyUI yourself) → only when both are missing does it fall back to the plugin directory. The plugin directory
keeps code and built-in presets only (`configs/`, `prompts/presets/`, `skills/presets/`, `skills/tasks/`,
`recipes/presets/`, filled in by `seed_presets()` when the data root lacks them), and the copy installed into
`custom_nodes` is code and presets as well. Running from source uses `Neo-Studio/data/` as the data root; the exe
uses the `data/` next to the exe.

| Directory / file | Description |
|------|------|
| `prompts/presets/` | Built-in presets (`collections/` collections, `video/` video subset) |
| `prompts/custom/` | User prompts; `_tags_index.json` is the tag index |
| `skills/presets/<id>/skill.md` | Built-in skills (Markdown + YAML frontmatter) |
| `skills/tasks/<id>/skill.md` | Built-in task skills (captioning, titles, translation, …) |
| `skills/custom/<id>/skill.md` | User-defined skills |
| `gallery/presets/` | Built-in preset assets (read-only) |
| `gallery/custom/` | User-uploaded assets |
| `gallery/thumbnails/` | Thumbnail cache (deletable, rebuilt) |
| `gallery/lora_cache/` | Civitai LORA example cache |
| `gallery/oss_cache/` | Cloud preset cache |
| `recipes/presets/` | Built-in preset recipes (read-only) |
| `recipes/custom/` | User recipes: `recipe.json` + `assets/` |
| `agent_sessions/` | Agent session records: one JSON per run (timeline frames + resume text), stored on this machine only, never packaged |
| `configs/llm_providers.json` | Provider definitions (the single source of truth); the frontend dropdown is built from it |
| `configs/remote_llm_config.json` | Remote LLM configuration; API keys stay on this machine |
| `configs/image_gen.json` | Image generation defaults |
| `configs/video_gen.json` | Video generation defaults |
| `configs/gallery_settings.json` | Custom directories and Civitai settings |
| `configs/gallery_dim_cache.json` | Card width/height cache (keyed by path+mtime+size, deletable and rebuilt) |
| `configs/bookmarks.json` | Local bookmarks (path information only) |
| `configs/oss_presets.json` | OSS preset asset source configuration |
| `configs/backyard_oss.json` | Backyard's OSS configuration |
| `configs/laya_config.json` | Laya classifier configuration |
| `configs/studio_window.json` | Studio desktop window geometry (written by `app/studio_app.py` on window close) |
| `user/neo_repair_mappings.json` | Manual workflow-repair mappings |
| `locals/zh_CN.json` | Localization resources |
