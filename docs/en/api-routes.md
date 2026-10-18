# Backend API Routes

> 🇨🇳 中文: [../api-routes.md](../api-routes.md)

Routes are registered by each module's own `web.RouteTableDef` (`gallery.py` / `bookmark.py` / `gallery_lora.py` /
`gallery_oss.py`) and mounted onto `PromptServer.instance.routes` by `__init__.py`; the main entry point is
[../../Developer_EN.md](../../Developer_EN.md).
The tables below list routes and their purpose only; request body fields and response shapes are defined by the
source code.

## gallery.py — `/neo_gallery/*`

| Method | Route | Description |
|------|------|------|
| GET | `/neo_gallery/list` | Directory content listing (presets / custom / system aggregation) |
| GET | `/neo_gallery/css` | Built-in asset CSS resources |
| GET | `/neo_gallery/placeholder.png` | Placeholder image |
| GET | `/neo_gallery/subdirs` | Subdirectory listing |
| GET | `/neo_gallery/thumbnail` | Thumbnail (generated with caching) |
| GET | `/neo_gallery/video` | Video stream |
| GET | `/neo_gallery/media_meta` | Media metadata |
| GET | `/neo_gallery/image` | Media file |
| GET | `/neo_gallery/txt` | Full sidecar `.txt` text (list `txt_content` is a preview) |
| POST | `/neo_gallery/dir_cover_images` | Directory cover images |
| POST | `/neo_gallery/save_settings` | Save asset settings (custom directories, etc.) |
| GET | `/neo_gallery/get_settings` | Read asset settings |
| POST | `/neo_gallery/upload_txt` | Upload the companion `.txt` description |
| POST | `/neo_gallery/copy_to_input` | Copy an asset into `input/` |
| POST | `/neo_gallery/delete` | Delete an asset (presets are read-only protected) |
| POST | `/neo_gallery/clear_thumbnails` | Clear the thumbnail cache |

- `dir_name=Grid|Character` resolves to the main directories (locally generated results + read-only remote
  presets); the home page does not inject those two cards.

## lora_tag.py — LoRA tagging

Only leaf image directories under writable sources (Input / user custom directories) are eligible; HEIC / HEIF
conversion depends on the optional `pillow-heif`.

| Method | Route | Description |
|------|------|------|
| GET | `/neo_gallery/tag_preflight` | Directory validation + image count + suggested trigger words |
| POST | `/neo_gallery/tag_dir` | Batch tagging (SSE progress, optional directory normalization first) |

## gallery_lora.py — Civitai LORA

| Method | Route | Description |
|------|------|------|
| GET | `/neo_gallery/lora_dirs` | First-level subdirectory listing of `models/loras` |
| POST | `/neo_gallery/civitai_test` | Civitai connectivity / API KEY probe |
| GET | `/neo_gallery/lora_cache_status` | LORA cache queue status |
| POST | `/neo_gallery/lora_retry_failed` | Retry failed entries |
| POST | `/neo_gallery/lora_refresh_dir` | Re-read the safetensors header metadata of the LORAs in a directory (local, no example-image re-download) |

## gallery_oss.py — Cloud presets

The cloud preset index is layered: `index.json` is a v2 master index carrying one entry per directory with
`count` / `index` / `rev` / `covers`, and the full item list of a directory lives in the `<dir>/index.json`
that entry points at, downloaded when the directory is opened. Directory indexes are cached in
`gallery/oss_cache/<dir>/_index.json` (StoryBoard / CharacterSheet presets in their main dir's
`presets/<dir>/_index.json`) and re-fetched only when the master's `rev` changes. The optional top-level
`categories` maps remote directories into the read-only preset areas of the StoryBoard / CharacterSheet
main directories; unclassified directories stay in the legacy **Cloud Presets**. A legacy full index whose
entries carry `items` keeps working unchanged (counts and covers are derived from them).

| Method | Route | Description |
|------|------|------|
| POST | `/neo_gallery/sync_oss` | Sync the OSS preset index |
| GET | `/neo_gallery/oss_status` | OSS sync status |

## recipes.py — `/rs_recipes/*`

| Method | Route | Description |
|------|------|------|
| POST | `/rs_recipes/list` | Recipe list (custom / presets, newest-modified first) |
| POST | `/rs_recipes/load` | Read a single recipe |
| POST | `/rs_recipes/save` | Save a recipe (including assets collection) |
| POST | `/rs_recipes/append_results` | Append sample results (including a workflow backup) |
| POST | `/rs_recipes/add_results` | Record artifact paths into `results` (no file copying) |
| POST | `/rs_recipes/delete_result` | Drop a result and delete the real files in output |
| POST | `/rs_recipes/delete_sample` | Delete a sample result |
| POST | `/rs_recipes/delete` | Delete a recipe (custom only) |
| POST | `/rs_recipes/copy` | Copy as a new custom copy (auto-renamed) |
| GET | `/rs_recipes/export` | Export a recipe zip (a Readme.txt is included) |
| POST | `/rs_recipes/import` | Import a recipe zip (auto-renamed on collision) |
| GET | `/rs_recipes/asset` | Recipe asset file |
| GET | `/rs_recipes/thumbnail` | Cover / grid thumbnail (cached) |
| GET | `/rs_recipes/workflow` | The workflow snapshot of a sample |
| POST | `/rs_recipes/send_to_workflow` | Copy assets into `input/` for one-click restore |
| GET | `/rs_recipes/director_spec` | Director recipe `{shared, segments}` and identity reference images |
| POST | `/rs_recipes/director_generate_segments` | Text storyboard → segment JSON |
| POST | `/rs_recipes/director_optimize_prompts` | Rewrite a single segment prompt in H3 format |
| POST | `/rs_recipes/grid_split` | Split a grid storyboard image into per-segment first frames |
| POST | `/rs_recipes/director_describe_panel` | Per-panel description → finished single-segment prompt |
| POST | `/rs_recipes/director_modify_segment` | Rewrite a segment prompt from an edit instruction (SSE) |

## h3_video_director.py / h3_segment.py / h3_assemble.py — `/neo_video_gen/*`

| Method | Route | Description |
|------|------|------|
| GET | `/neo_video_gen/director_progress` | Director run progress (segment / step) |
| POST | `/neo_video_gen/director/cancel` | Cancel a running director task |
| POST | `/neo_video_gen/run_segment` | Enqueue a single-segment generate / regenerate |
| GET | `/neo_video_gen/run_segment/{task_id}` | Single-segment task snapshot |
| POST | `/neo_video_gen/run_segment/{task_id}/cancel` | Cancel a single-segment task |
| POST | `/neo_video_gen/assemble_segments` | Stitch the checked segments back into a full film |
| GET | `/neo_video_gen/assemble_segments/{task_id}` | Assembly task snapshot |
| POST | `/neo_video_gen/assemble_segments/{task_id}/cancel` | Cancel an assembly |
| GET | `/neo_video_gen/settings` | Read the "video model" settings |
| POST | `/neo_video_gen/settings` | Save the "video model" settings |
| GET | `/neo_video_gen/models` | Scan H3 models and report the auto-selection result |

- `run_segment` only validates + assembles the prompt + enqueues; the real generation runs inside the ComfyUI
  executor (the `NeoH3SegmentRun` node): VRAM, progress and cancellation are the executor's responsibility, and the
  plugin only polls the task snapshot. Artifacts are written to `output/neo_director_regen/` and recorded in the
  recipe's `results`.
- The anchor source is given by `film` (empty = the newest film), and **the resolution follows that film** (only the
  same size can be stitched back seamlessly). Out-of-range segment indexes, unknown anchors, a film frame count that
  disagrees with the recomputed one, and preset recipes all return 400.
- `assemble_segments` is the follow-up step to single-segment generation: it replaces only the checked segments with
  single-segment artifacts; the other segments keep the original film's frames and audio. It only decodes → stitches
  → re-encodes, uses no model and no execution queue, runs on a background thread, and cancellation is cooperative.
  The new film is written to `output/neo_director_merge/`, and the `results` entry carries the real per-segment
  frame counts in `layout`, which later single-segment regenerations use to locate segment boundaries.
- Live preview during sampling goes through the plugin's own taeh3 channel (WS event `rs.h3.preview`), pushed back to
  the matching node panel by `node_id`.

## studio.py — `/neo_studio/*`

The backend of the standalone Neo Studio page (`web/studio/index.html`). Assets / image generation / recipes /
single segments reuse the existing routes; this module only adds the page's short paths, full-film generation and
version information:

| Method | Route | Description |
|------|------|------|
| GET | `/neo-studio` | The standalone Studio page |
| POST | `/neo_studio/director/generate` | Enqueue a full-film run (optionally only the checked segments) |
| GET | `/neo_studio/director/{task_id}` | Full-film task snapshot |
| POST | `/neo_studio/director/{task_id}/cancel` | Cancel a full-film task |
| GET | `/neo_studio/version` | Plugin / ComfyUI versions and the director recipe list |
| GET | `/neo_studio/log` | ComfyUI console log (a 300-entry `app.logger` ring buffer), polled by Studio "Settings → Logs" |
| POST | `/neo_studio/clear_memory` | Unload models and clear the VRAM cache |

- `only_segments` is the text of segment numbers checked on the read-only timeline (1-based, comma-separated, empty =
  the whole film); checking is transient runtime state and is never written into the recipe.
- Task tracking follows the same approach as `run_segment`: enqueue + poll snapshots + WS events pushed on change.

## workflow.py — `/neo_nodes/*`

| Method | Route | Description |
|------|------|------|
| POST | `/neo_nodes/repair` | Workflow model-path repair |
| GET | `/neo_nodes/repair_mappings` | Read saved repair mappings |
| DELETE | `/neo_nodes/repair_mappings` | Delete a repair mapping |

Repair details: [workflow-repair.md](workflow-repair.md).

## image_gen.py / image_gen_files.py — `/neo_image_gen/*`

Settings and skill configuration (`settings` / `models` / `input_images` / `skill_config` / `skill_workflow` /
`save_workflow_skill` / `update_workflow_skill*` / `copy_skill_files` / `save_combo_skill`) live in
`image_gen_files.py` and only read file directories, so they work with the Studio desktop offline; enqueueing and
task tracking (`generate` / `status` / `tasks` / `cancel` / `skill_dims`) live in `image_gen.py` and need the
ComfyUI runtime.

| Method | Route | Description |
|------|------|------|
| GET | `/neo_image_gen/settings` | Read the built-in image-generation defaults |
| POST | `/neo_image_gen/settings` | Save the default parameters |
| GET | `/neo_image_gen/models` | Scan the model directories and report the auto-selection result |
| POST | `/neo_image_gen/generate` | Enqueue image generation (optional per-run overrides / outpaint) |
| GET | `/neo_image_gen/status/{task_id}` | Task snapshot (progress / images / live preview) |
| GET | `/neo_image_gen/tasks` | Recent task list (at most 32 entries) |
| POST | `/neo_image_gen/cancel/{task_id}` | Dequeue and interrupt when running |
| GET | `/neo_image_gen/skill_dims` | Skill preset width/height and steps (for filling defaults) |
| GET | `/neo_image_gen/skill_config` | Read a skill's image / video generation settings |
| POST | `/neo_image_gen/skill_config` | Write a skill's settings (presets write a local override file) |
| GET | `/neo_image_gen/skill_workflow` | The skill's `workflow.json` template (read-only) |
| POST | `/neo_image_gen/update_workflow_skill` | Write the canvas workflow back as the skill template |
| POST | `/neo_image_gen/save_combo_skill` | Save a main-model + LoRA combination as a new skill |

- The `generate` body may carry per-run overrides `model` / `text_encoder` / `vae` / `loras` (empty = follow the
  global settings); outpaint requests carry an `outpaint` field, see [image-gen.md](image-gen.md).
- Task status does not use HTTP polling: task snapshots are pushed on change through the WS event
  `rs.image_gen.status`; `/status` only serves as the first pull before subscribing and as the gap filler after a
  reconnect, and on cancel the backend also pushes a `cancelled` snapshot.

## agent.py — `/neo_agent/*`

The backend agent loop behind the right-side agent dock. Every tool call goes through an in-process MCP client
that feeds `mcp_server.serve` line by line over JSON-RPC; the tool list is the whole MCP registry (the film chain
included), and the dock never calls a handler directly.

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/neo_agent/run` | One agent turn, SSE timeline; body `{text, skill_id}`, first frame `run` (carries the `run_id` the cancel route needs), frames `plan` / `tool_call` / `status` / `tool_result` / `content`, ending with `[ERROR]` / `[DONE]` |
| POST | `/neo_agent/cancel` | Cancel: with `run_id` it stops the whole agent loop and kills the in-flight task (`run_id` accepts only the shape the `run` frame issued; unknown id is 404); with `task_id` it kills just that task (through MCP `cancel_task`, which resolves the image / film / segment / assemble route itself), `task_id` accepts UUID shapes only |

- A non-empty `skill_id` makes the backend generate straight from that skill without calling the LLM; an empty one
  lets the LLM plan and call tools, with a 12-turn cap.
- `generate_image` / `director_run` / `segment_run` / `assemble_run` return a `task_id` only; the loop polls
  `task_status` to a terminal state and emits sampling steps and film segment numbers through `status` frames.
  The wait cap is 600s for a single image and 2400s for a whole film.
- A `tool_result` frame carries `media`: the image task's `images` become `{kind:"image", url, title}` items, and a
  finished film becomes one `{kind:"video", url}` `/view` item (segment and assemble snapshots carry a filename
  only, so the subfolder comes from the generating module's output directory). The dock's result thumbnails and
  result links read nothing else.
- The ComfyUI the tools talk to is the source of the current request; the body carries no address to inject.

## prompts.py — `/rs_prompts/*`

| Method | Route | Description |
|------|------|------|
| POST | `/rs_prompts/save_prompt` | Save a prompt preset |
| POST | `/rs_prompts/list_prompts` | Prompt list (including recipe entries) |
| POST | `/rs_prompts/load_prompt` | Read a prompt |
| POST | `/rs_prompts/list_prompt_lines` | Line-level prompt list |
| POST | `/rs_prompts/delete_prompt` | Delete a prompt |
| GET | `/rs_prompts/get_models` | Available LLM model list (remote + local) |
| GET | `/rs_prompts/native_models` | Native text-generation model list (scans `.safetensors` under `models/text_encoders/`) |
| POST | `/rs_prompts/set_model` | Switch the current LLM model |
| GET/POST | `/rs_prompts/remote_llm_config` | Read / save the remote LLM configuration |
| POST | `/rs_prompts/llm_connection_test` | Connection test (remote sends "hello" with the current form values; Native runs one real local inference) |
| GET | `/rs_prompts/llm_mode` | The current LLM mode |
| POST | `/rs_prompts/extract_title` | AI title extraction |
| POST | `/rs_prompts/extract_classify` | AI classification extraction |
| POST | `/rs_prompts/enhance_prompt` | Prompt enhancement |
| POST | `/rs_prompts/translate_prompt` | Prompt translation |
| POST | `/rs_prompts/smart_prompt` | Quick description generation |
| POST | `/rs_prompts/reverse_prompt` | Image reverse-prompting (SSE + same-name .txt cache) |
| POST | `/rs_prompts/stream_{task_name}` | Streaming generation endpoint registered by task name |
| POST | `/rs_prompts/stream_generate_prompt` | Streaming generation |
| POST | `/rs_prompts/random_prompt` | Random prompt |
| POST | `/rs_prompts/random_prompts` | Runtime random batch draw (1–16) |
| POST | `/rs_prompts/fetch_remote_models` | Fetch the remote server's model list |
| GET | `/rs_prompts/skills` | Skill list (grouped presets / tasks / custom) |
| POST | `/rs_prompts/load_skill` | Read a single skill |
| POST | `/rs_prompts/save_skill` | Create / update a skill main file (presets read-only) |
| POST | `/rs_prompts/delete_skill` | Delete an entire skill directory (USR only) |
| POST | `/rs_prompts/reset_skill_config` | Reset skill settings to default (delete the local override file) |

- `fetch_remote_models` requests carry `provider`; an empty `api_key` falls back to that provider's stored key.
  Local / LAN endpoints try the LM Studio and Ollama native endpoints in order first, and only then try the
  OpenAI-compatible `/v1/models` endpoint.
- Image / video generation skills in `skills` also carry an optional `gen_config` summary (main model, LoRA name
  list, long-edge size, default ratio, steps); the field is omitted when everything is empty.
- `load_skill` returns the body, the list of companion `.md` files, `max_tokens`, the image / video generation
  flags, the video mode, the reference-image requirement, and whether a local configuration override exists.
- `save_skill` validates name uniqueness (a collision with another skill returns 409); omitted optional fields keep
  the existing frontmatter values, and an explicit falsy value removes the field.
- The LLM configuration and title-extraction routes (`get_models` / `native_models` / `set_model` /
  `remote_llm_config` / `llm_connection_test` / `llm_mode` / `extract_title` / `fetch_remote_models`) are registered
  by `llm.py`'s `RouteTableDef`: they only read `configs/` and the 8080 service, do not depend on the ComfyUI
  runtime, and serve identically in the Studio desktop offline.

LLM modes and configuration: [llm.md](llm.md). Skill design: [skills.md](skills.md).

## model_hub.py — `/neo_model_hub/*`

The model hub (Comfy-Org curated section · ModelScope / Hugging Face dual-source search and resumable downloads);
details in [model-hub.md](model-hub.md).

| Method | Route | Description |
|------|------|------|
| GET | `/neo_model_hub/settings` | Settings + curated registry + drop-in categories + available sources |
| POST | `/neo_model_hub/settings` | Save settings (source / endpoint / token / LLM subfolder / timeout, sanitized before writing) |
| POST | `/neo_model_hub/repos` | Repository list (union of both sources + registry completion; with `query` it adds cross-organization search) |
| POST | `/neo_model_hub/files` | Repository file manifest (non-model files filtered, with category / file name / already-exists flags) |
| POST | `/neo_model_hub/subfolders` | Existing subfolders under the category drop-in directory + automatic default subfolder probing |
| POST | `/neo_model_hub/download` | Start a download (single task, `.part` + HTTP Range resume) |
| GET | `/neo_model_hub/progress` | Current download snapshot (progress / speed / state) |
| POST | `/neo_model_hub/cancel` | Cancel a running download (keeps the resume point) |

- Repository lists and file manifests use server-side caching (15 / 10 minutes); requests with `refresh: true` skip
  the cache.
- ModelScope organization lists and cross-organization search use the anonymous `dolphin/models` endpoint; when that
  endpoint fails, repositories are probed for existence one by one from the registry (cached 1 day).
- Source-side failures return errors with a `code`: `need_token` (401), `busy` (409), `not_on_source` (404, with an
  `other_source` suggestion to switch source).

## Desktop-side service — `app/studio_server.py`

The Studio desktop (`app/studio_app.py`) starts an aiohttp service on the ComfyUI port +3 (default `8191`) and mounts
the handlers that plugin modules attach to their own `RouteTableDef`s, according to the capability table in
`app/studio_caps.py`. The criterion is "pure file read/write / local lookup / remote download / calls to the 8080 LLM
service"; anything needing the execution queue, VRAM, or node definitions belongs to ComfyUI, and every route outside
the table answers 409. Startup sequence, close teardown and cache conventions: [studio-desktop.md](studio-desktop.md).

| Method | Route | Description |
|------|------|------|
| GET | `/neo-studio` | The Studio page (the same `web/studio/index.html` on the desktop side) |
| GET | `/extensions/comfyui-neo-studio/*` | Frontend static files |
| GET/POST | `/neo_gallery/*` `/neo_bookmark/*` | Asset library and bookmarks (including delete / upload / tagging / OSS sync) |
| GET/POST | `/rs_prompts/skills` `load_skill` `save_skill` `delete_skill` `*_*_skill_file` | Skill editing |
| GET/POST | `/rs_recipes/*` | Recipe read/write, LLM rewrite / per-panel description / segmentation / grid split |
| GET/POST | `/neo_image_gen/settings` `models` `input_images` `skill_config` `skill_workflow` `*workflow_skill*` `copy_skill_files`, `/neo_video_gen/settings` `models` | Image / video generation settings |
| GET/POST | `/rs_prompts/get_models` `native_models` `set_model` `remote_llm_config` `llm_connection_test` `llm_mode` `extract_title` `fetch_remote_models` | LLM configuration and title extraction (reads only `configs/` and the 8080 service) |
| GET/POST | `/neo_model_hub/*` `/neo_backyard/*` | Model hub and Backyard |
| GET/POST | `/userdata/neo_gallery_data.json` | Asset library state file (`user/default/`, writes go through `.tmp` + replace) |
| GET | `/neo_studio/version` | Capability snapshot: `offline: true` + `caps` + `starting` + `routes` + `comfy_base`; the frontend gates on it and picks the request target |
| GET | `/neo_studio/log` `/view` `/ws` | Startup log / read-only images / WS stub |
| ANY | any other `/neo_*` `/rs_*` `/userdata/*` `/api/*` | `409 {"success": false, "offline": true}` |

- `routes` is the ownership table (`studio_caps.route_list()`, entries like `"GET /neo_gallery/list"`): with the page
  pinned to the desktop port, the frontend decides per request whether it goes to the desktop service or to ComfyUI,
  and keeps no second copy of the list.
- `comfy_base` is the direct target for generation requests, non-empty only for the loopback-only ComfyUI the desktop
  spawned itself; when it is empty, routes outside the table keep answering `409` on the desktop service. The enabling
  condition and the CORS rule: [studio-desktop.md](studio-desktop.md).

- Generation and queue routes require ComfyUI to be running: `/neo_image_gen/generate`,
  `/neo_video_gen/run_segment` `assemble_segments` `storyboard_generate`, `/neo_voice/generate`,
  `/neo_studio/director/generate`, `/neo_agent/run` `/neo_agent/cancel`, `/neo_studio/mem_stats`, `/neo_nodes/repair`.
- Thumbnails share the `gallery/thumbnails` cache with ComfyUI; when both run at the same time the same image may be
  generated twice.
- Directories come from `folder_paths`' default `output` / `input` / `user`: if ComfyUI is started externally with
  `--output-directory`, desktop-side browsing still points at the default directories.

## MCP service — `studio/mcp_server.py`

Not an HTTP service: the MCP client starts it as a **stdio subprocess**, external agents call its tools over
JSON-RPC, and the server does the work through the local ComfyUI HTTP endpoints (the address is forced to
loopback). Tool list, parameters, and usage conventions: [mcp.md](mcp.md).

| Tool | Routes it hits |
|------|----------------|
| `neo_status` | `GET /neo_studio/version` + `GET /queue` |
| `list_skills` `generate_prompt` | `GET /rs_prompts/skills` + `POST /rs_prompts/stream_generate_prompt` (SSE) |
| `list_models` `generate_image` `list_tasks` | `GET /neo_image_gen/models` + `POST /neo_image_gen/generate` + `GET /neo_image_gen/tasks` |
| `task_status` | Image generation is matched by `task_id` inside `GET /neo_image_gen/tasks`; film / segment / assemble probe `GET /neo_studio/director/{id}`, `GET /neo_video_gen/run_segment/{id}`, `GET /neo_video_gen/assemble_segments/{id}` in order, with `GET /neo_video_gen/director_progress` attached for the film |
| `cancel_task` | Probes the `…/cancel` route of those four tables in order |
| `get_media` | `GET /view` (output is read through ComfyUI only; png images and mp4 films share one address, video bytes are not returned) |
| `list_gallery` | `GET /neo_gallery/list` |
| `list_recipes` `load_recipe` | `POST /rs_recipes/list` `POST /rs_recipes/load` |
| `director_recipes` `director_spec` | `GET /neo_studio/version` + `GET /rs_recipes/director_spec` |
| `director_plan` | `POST /rs_recipes/director_generate_segments` / `director_optimize_prompts` (SSE) / `director_modify_segment` (SSE) |
| `director_save` `director_copy` | `POST /rs_recipes/save` `POST /rs_recipes/copy` (the only two write operations) |
| `director_run` `segment_run` `assemble_run` | `POST /neo_studio/director/generate` `POST /neo_video_gen/run_segment` `POST /neo_video_gen/assemble_segments` |

- Segment numbers are 1-based in the API; `segment` in `run_segment` and `use` in `assemble_segments` are
  0-based, converted by the server.
- Delete endpoints (`/rs_recipes/delete`, `/neo_gallery/delete`, …) are not exposed, and local file paths are
  never touched directly.
