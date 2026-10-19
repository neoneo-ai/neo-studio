# MCP Server (External Agent Access)

> 🇨🇳 中文: [../mcp.md](../mcp.md)

`studio/mcp_server.py` is a standalone MCP server (stdio transport). An MCP client (Claude Desktop /
Cursor / your own client) launches it as a subprocess, so an external agent can call Neo Studio's image and
director capabilities (full film / single segment / assembly).

It does not start with ComfyUI and takes no part in node registration: zero relative imports, standard library
only, and every capability is reached through the local ComfyUI HTTP interface. `stdout` carries JSON-RPC only;
logs always go to `stderr`.

## Prerequisites

1. ComfyUI is running with the Neo Studio plugin installed — MCP uses the plugin's HTTP endpoints and needs
   plugin v1.2.0 or newer. The Studio desktop runs ComfyUI at `http://127.0.0.1:8188` by default (the desktop's
   own service on 8191 is unrelated to MCP).
2. Python 3.10+ — the same Python that runs ComfyUI. No extra dependencies.
3. `generate_prompt` / `director_plan` need an LLM configured in Neo Studio settings.

## Setup

### 1. Self-test (no ComfyUI needed)

```powershell
python studio\mcp_server.py --selftest
# Neo Studio MCP Server v1.3.0 · 21 tools: neo_status, list_skills, ...
```

### 2. Add it to the MCP client

`tools\mcp_setup.ps1` prints the snippets below; add `-Write` to merge them into the Claude Desktop and Cursor
config files (only the `neo-studio` entry is added or updated, everything else is preserved).

Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`, restart Claude afterwards):

```json
{
  "mcpServers": {
    "neo-studio": {
      "command": "<ComfyUI root>\\python\\python.exe",
      "args": ["<Neo-Studio root>\\studio\\mcp_server.py"],
      "env": { "NEO_MCP_COMFY_URL": "http://127.0.0.1:8188" }
    }
  }
}
```

Replace the two paths with the ones on your machine; `tools\mcp_setup.ps1` prints them filled in from the
repository's current location.

Cursor (`.cursor/mcp.json` in the project root, same content). When other MCP servers are configured, add only
the `neo-studio` entry instead of overwriting the file.

### 3. Confirm in the client

Ask the agent to "list the Neo Studio MCP tools" — 21 tools such as `neo_status` means the wiring works. Asking
it to call `neo_status` proves ComfyUI is reachable.

## The Studio MCP servers settings (built-in MCP client)

The **Settings → MCP Servers** tab of the desktop window is its own MCP client: registry, connect /
disconnect, and tool calls all live in that tab, with the registry at `data/configs/mcp_servers.json`.
The agent dock has a **🔌 MCP** entry under **✨ Generate** that jumps straight to the tab. Tool cards open
with the server's example arguments (`_meta.example` in `tools/list`): a read-only tool runs as soon as you
press Execute, and a tool with required arguments only needs the angle-bracket placeholders swapped for the
ids the previous call returned. While the
registry file does not exist, the tab offers one built-in `neo-studio` entry: `command` is the Python
from the startup settings, the script is the `mcp_server.py` inside the installed plugin directory, and
`--comfy-url` points at the ComfyUI port the desktop launched — press Connect, no paths to type. Once
the registry has been saved the file is the only source: a saved empty list stays empty and the built-in
entry never reappears; a file that exists but is malformed reads as empty, and the built-in entry never
overwrites JSON the user broke. In remote ComfyUI mode there is no built-in entry and the tab points at
the external MCP clients instead.

The agent dock's **✨ Generate** is a second client on the same protocol: `studio/agent.py` feeds
`mcp_server.serve` line by line in-process, the tool list it hands the LLM is the whole MCP registry (the film
chain included), and the dock never calls a handler directly — see [api-routes.md](api-routes.md).

## Flags and environment variables

| Flag | Environment | Meaning |
|------|-------------|---------|
| `--comfy-url` | `NEO_MCP_COMFY_URL` | ComfyUI URL; must be loopback (`127.0.0.1` / `localhost` / `::1`), anything else refuses to start; default `http://127.0.0.1:8188` |
| `--tools` | `NEO_MCP_TOOLS` | Comma-separated tool allowlist; empty enables everything |
| `--image-base64` | `NEO_MCP_IMAGE_BASE64=1` | `get_media` attaches base64 bytes for images by default |
| `--timeout` | `NEO_MCP_TIMEOUT` | Timeout in seconds for regular requests (default 30) |
| `--selftest` | — | Print the enabled tools and exit (no ComfyUI needed) |

Example — expose only the image pipeline:

```json
"env": {
  "NEO_MCP_COMFY_URL": "http://127.0.0.1:8188",
  "NEO_MCP_TOOLS": "neo_status,list_skills,generate_image,task_status,get_media"
}
```

## Tools

| Tool | Purpose |
|------|---------|
| `neo_status` | Versions / queue / director recipe count — call it first to confirm the service is up |
| `list_skills` | Skill ids (with `mode` / `requires_ref`, the two fields the reference check reads; `q` also matches the `mode` value, so `q=t2i` lists `mode=t2i` and `t2i_edit`) |
| `list_models` | Models and LoRAs scanned for image / video: `q` filters by directory+filename, `group` lists one group, `scope=video` uses the H3 scan, `near=<main model name>` puts the same-directory entries first (every item carries its `dir`), every item of `group=diffusion_models` carries `skills` (the skill ids that family can run, empty when the family word list does not recognize it), plus the `suggested_*` auto-picks |
| `generate_prompt` | Short idea → finished prompt (uses the LLM, requires a configured model) |
| `generate_image` | Submits an image job and returns a `task_id` immediately; `model` / `loras` override that one request only |
| `task_status` `list_tasks` `cancel_task` | Task snapshot / list / cancel (all five task tables share `task_id`: image / full film / segment / assembly / image storyboard) |
| `get_media` | Fetch an output file: images (png) and videos (mp4) both return a `/view` URL; base64 bytes only for images with `base64=true` |
| `list_gallery` `list_recipes` `load_recipe` | Asset library tree, recipe list, single recipe metadata (`results` lists past outputs, including finished films) |
| `director_recipes` `director_spec` | Director recipe list, `shared` + segment list |
| `director_plan` | Storyboard planning: `plan` idea/script → segments; `optimize` rewrites one segment in H3 format; `modify` rewrites one segment per instruction |
| `director_keyframes` | Image storyboard: renders keyframes per segment into the recipe's `assets/`; returns `segments` / `shared` / `story` that must go back to `director_save` to stick |
| `director_copy` `director_save` | Copy a recipe (unlocks read-only presets), write segments into a custom recipe (`story` carries idea / character refs / storyboard settings) |
| `director_run` `segment_run` `assemble_run` | Full film / single segment / assembly, all return a `task_id` immediately and produce an mp4 |

## Typical flows

**Image pipeline (png output)**

```
neo_status → list_skills (pick skill_id) → generate_image → poll task_status until succeeded
→ get_media (png: URL, add base64=true when bytes are needed)
```

**Per-run model and LoRA (one request only)**

```
list_models(group=diffusion_models, q=<keyword>)  → main-model items carry skills: the skills that family can run
list_models(near=<current main model>, group=loras)   → same-directory LoRAs first, dir names every item's folder
→ generate_image(model=..., loras=[{name,strength}], ...)   → this run only; the skill's config.json and global settings stay
```

Main model and LoRA names are checked against their scan tables before the request goes out: a name that is not
there comes back with the closest filenames — for `model`, plus the "leave it empty and the backend picks per the
skill" hint — instead of a doomed 404. `strength` is clamped to 0-2 and a repeated
name is attached once. Video runs (`director_run` / `segment_run`) take their model and LoRAs from the
segment skill's `config.json` — the request-level override applies to image generation only.

With no LoRA named, a description that carries a proper noun — a character, an art style, a work or an artist —
gets one proactive search (`list_models(group=loras, q=<keyword>)`, at most two keywords per description): one hit goes
into this `generate_image` call and the answer names which LoRA ran; several hits go through `ask_user`, with the
options copying the filenames verbatim and 「不用 LoRA / No LoRA」 fixed as the last one — that question uses up the
turn's single ask; no hit means generate as asked. A named main model gets the same search
(`list_models(group=diffusion_models, q=<keyword>)`) inside that same two-keyword budget: the skill has to come from
that item's `skills`, and an empty `skills` asks the user which skill to run.

**Director pipeline (mp4 output)**

```
director_recipes → director_spec (read segments) → director_plan (story → segments, needs the LLM)
→ director_copy → director_save (write into a custom recipe)
→ director_run → poll task_status (multi-segment long job) → on succeeded, filename / subfolder is where the
  file landed and url is the playable link
→ get_media (the mp4's /view URL — playable in a browser or player)
→ fixes: segment_run (regenerate one segment) → assemble_run (stitch it back into the film)
```

**Text-storyboard pipeline (idea or script → segments → keyframes → finished segments)**

```
director_plan(mode=plan, idea|script, segment_seconds[, characters])   → segments (prompt / duration_sec / storyboard_prompt)
→ director_save(name, segments, story{idea|story, characters, segment_seconds, image_mode, image_skill})
→ director_keyframes(recipe[, segments, skill_id, mode, force])       → keyframes land in the recipe's assets/ (one segment at a time)
→ director_save(echo segments / shared / story back)                   → storyboard filename + first frame recorded in the recipe
→ segment_run / director_run → poll task_status → get_media
```

This is the same backend the director page's 📖 Storyboard tab uses. The `segments` / `shared` / `story` that
`director_keyframes` returns have to go back to `director_save` unchanged — a save replaces the whole recipe, and
dropping `story` wipes the idea and the character references with it. A non-r2v segment gets its keyframe as the
first frame (i2v / fl2v use it), an r2v segment gets it in its reference pool; writing only `storyboard` leaves the
backend treating it as a multi-frame anchor, so the segment still runs as plain text-to-video.

Full film, regenerated segment and assembled film outputs are mp4 files: `SaveVideo` writes the film into
`output/NeoDirector/<recipe>/`, a regenerated segment lands in `output/neo_director_regen/`, an assembled film
in `output/neo_director_merge/`. The `succeeded` `task_status` snapshot carries `filename`, `subfolder` and the
backend-built `url`; `/view` serves these as `video/mp4`, so they can be downloaded or played directly; MCP
never returns video bytes.

**What to say to the agent** (the tool descriptions and `initialize.instructions` already state the
conventions, so you normally don't have to repeat them)

The image sentence only runs when the machine has an image skill with a `workflow.json`
(`has_workflow=true` in `list_skills`).

- "Generate a 1024×1024 image of an orange cat with Neo Studio and give me the picture when it's done."
- "List the director recipes, read the segments of the Red Carpet recipe, regenerate segment 3, stitch the
  film back together and give me the finished film URL."
- "Turn this script into a 6-segment short film and give me the output filename when it finishes."

## Conventions

- **Async tasks**: `generate_image`, `director_run`, `segment_run`, `assemble_run` only return a `task_id`.
  Poll with `task_status` until `succeeded`, then fetch the output; a full film is a multi-segment long job,
  so never wait on it synchronously.
- **The default film is one 5-second segment**: an agent asked to make a video plans a single segment of
  5 seconds with a VDN skill (`minimax_h3_vdn_*`, 8 steps in the skill config) and runs it through
  `segment_run`; a multi-segment full film only runs when the user asks for one. `director_plan.segment_seconds`
  defaults to 5, and the non-VDN `minimax_h3_*` skills run 20 steps — twice as slow.
- **Image generation needs a skill with a template**: `generate_image.skill_id` must be a `list_skills`
  entry with `has_workflow=true`. The MCP layer never picks one for you, and an empty `skill_id` fails with
  that pointer before any request reaches the backend.
- **A turn with `references` edits that image**: `skill_id` must be a skill that accepts references —
  `mode=edit / t2i_edit` in the `list_skills` rows, or `requires_ref=true` for canvas-imported skills that
  declare no `mode`. A `mode=t2i` template has no reference slot and drops the image in silence, so that call
  fails with the skill to switch to before any request reaches the backend, the same rule the paint page
  skill list filters by.
- **A turn with empty `references` is plain text-to-image**: `skill_id` must be a skill that accepts text —
  `mode=t2i / t2i_edit`, or `requires_ref=false` for canvas-imported skills that declare no `mode`. An
  `mode=edit` skill has a required reference slot, and an empty slot makes the backend run the template as
  text-to-image, so the picture ignores the editing intent; that call fails the same way, naming the skill
  to use.
- **Main model and LoRA must match the skill's family**: the family word is `krea2` / `qwen` — the one inside
  the skill id and Chinese name, the same word list the model dropdown sorting and `list_models`'s `near`
  use. A Krea2 main model wants a 12-tap × 2560 conditioning stack and a Qwen skill's template hands it 2560,
  and a LoRA on a main model of another family is a `LoraLoader` shape mismatch; both fail before any request
  reaches the backend with the same-family lookup (`list_skills(q=<family word>)`). The scan's `suggested_*`
  fields are the machine-wide defaults, not parameters for this request.
- **Model and LoRA are overridden per request only**: `generate_image`'s `model` / `loras` affect this run
  and leave the skill's `config.json` and the global image settings alone. Look the names up with
  `list_models` (`near=<current main model>` ranks the same-directory batch first and `dir` names each item's
  folder); a LoRA name that is not in the `models/loras` scan fails before any request reaches the backend,
  with the closest filenames, and a `model` name that is not in the image scan's `diffusion_models` fails the
  same way with the closest filenames plus the "leave it empty" hint. The `skills` a
  `group=diffusion_models` item carries are the skills that main model's family can run. Video runs take no
  request-level override.
- **Segment numbers are 1-based everywhere** (segment 1 = the first segment on the timeline).
  `segment_run.segment` and the lists in `assemble_run.segments` / `director_run.only_segments` are 1-based
  and converted to the endpoints' 0-based indices internally.
- **Only two recipe writes**: recipe metadata is written through `rs_recipes/save` and `rs_recipes/copy` only. No
  delete endpoints are exposed; file reads go through ComfyUI's `/view` only, the MCP layer never touches local
  paths. Built-in preset recipes are read-only — `director_copy` first, then `director_save`. The keyframes that
  `director_keyframes` renders land in the recipe's `assets/` along the same path the director page uses (add-only),
  and the segment-level references still go through `director_save`.
- **LLM dependency**: `generate_prompt` and `director_plan` need an LLM configured in Neo Studio settings.
  Without one they return a short error pointing at the settings instead of a fake success.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No tools in the client | Check the `command` Python path and the script path; read the client's MCP logs (server logs go to `stderr`) |
| Server exits immediately | A non-loopback ComfyUI URL is refused — set `--comfy-url` |
| `neo_status` cannot connect | ComfyUI is not running, or the port is wrong |
| `generate_prompt` / `director_plan` fail | No LLM configured, or the remote channel is unhealthy — follow the returned error in Neo Studio settings |
| `task_status` says task not found | Snapshots are pruned after a task finishes; collect output names as soon as it is `succeeded` |
| A storyboard segment is `skipped` | That segment has no `storyboard_prompt`, so the backend fell back to the video prompt; add a storyboard line or split again with `director_plan` |
| `director_keyframes` takes very long | Keyframes render one segment at a time; on timeout it returns `running` with a `task_id` — continue with `task_status`, do not resubmit |
| No storyboard image on the dock / 📖 page | After rendering, the returned `segments` must go back through `director_save`; the segment-level `storyboard` / `first_frame` are written on save |
| Response truncated | Text is capped at 12000 characters; filter `list_skills` with `q` (`all=true` is long) |

## LAN access (not over MCP)

The MCP layer is stdio plus loopback: it opens no network listener and does no cross-machine serving. Machines on the
LAN that need Neo Studio capabilities should use ComfyUI's HTTP API directly — put `0.0.0.0` or the host NIC address in
"Startup settings → LAN listen" (see "LAN access" in [studio-desktop.md](studio-desktop.md)) and reach
`http://<host IP>:8188` for `/neo_studio/*`, `/rs_*`, `/neo_*` and `/view`. ComfyUI has no authentication: anything
that can reach the port can submit and read jobs, so enable it only on a trusted segment and restrict the port in the
firewall.

The desktop can also point its window at a remote ComfyUI ("Startup settings → Remote ComfyUI", see "Remote ComfyUI"
in [studio-desktop.md](studio-desktop.md)): the remote machine needs the plugin installed and its own listen address
open. The MCP layer takes no part in that — it stays stdio plus loopback, and `--comfy-url` accepts loopback only.

## Known limits

- Per-segment prompt rewriting (`director_plan` with `optimize` / `modify`) handles one segment per call;
  multiple segments need repeated calls.
- `director_keyframes` renders one segment at a time, so it competes for VRAM with the 📖 page's own storyboard run.
- Base64 images are capped at 4 per call and 1.5 MB per image — larger ones return the `/view` URL only;
  video and audio bytes are never returned.
- Text responses are capped at 12000 characters, longer output is truncated.
- Front-end orchestration features (grid split, voice-over, subtitles) are not exposed as tools.

## Tests

```powershell
# Protocol and tool layer unit tests (fake HTTP, no ComfyUI needed)
python -m pytest studio\tests\test_mcp_server.py -q

# Live smoke test (ComfyUI must be running): image pipeline + director read/write + finished film fetch
python tests\mcp_smoke.py --director
```
