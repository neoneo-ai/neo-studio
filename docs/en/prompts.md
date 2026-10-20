# Prompt Nodes

> 🇨🇳 中文: [../prompts.md](../prompts.md)

Covers the two prompt nodes Neo Prompt Encoder / Neo Prompt Agent, the shared interface and buttons, and
the image-captioning input. Skill management: [skills.md](skills.md). LLM modes and local setup:
[llm.md](llm.md).

## 📝 Neo Prompt Encoder - AI-driven prompt encoder

A full prompt-management + CLIP encoding node:

- **Prompt save / pick** - save and load preset prompts, presets and custom directories supported.
- **LLM prompt enhancement** - raise prompt quality with a remote API or a local LLM, with skill-template
  management and quick switching.
- **Quick generate / random generate** - type a short description and generate, or generate a creative
  prompt in one click.
- **Image to prompt** - attach a reference image (paste, drag, `@` reference to workflow images) and have
  the AI reverse a descriptive prompt from it.
- **Classify / title extraction** - when saving a preset, the AI classifies the content and extracts a
  title, so one click saves a prompt or a recipe.
- **Skill system** - call different capabilities through the skill picker, grouped: image prompt
  enhancement and video prompt enhancement (generator / omni reference) first, then image / reverse,
  direct generation or editing, custom; the video-generation (H3) and task skills are internal and are
  not listed.

### Inputs / Outputs

| Input | Type | Description |
|------|------|------|
| `clip` | CLIP | Text encoder (required) |
| `text_input` | STRING (forceInput) | External text input |
| `image` | IMAGE | Reference image (for image-to-prompt) |

| Output | Type | Description |
|------|------|------|
| `POSITIVE` | CONDITIONING | Positive encoded conditioning |
| `PROMPT` | STRING | Final prompt text |

## ⚡ Neo Prompt Agent - minimal prompt agent

A lightweight prompt-generation node for the cases that only use the generated prompt text and need no
CLIP encoding:

- **No CLIP input** - not bound to a text encoder.
- **No status bar / toggles** - a simpler interface.
- **Outputs PROMPT + BUNDLE** - PROMPT is the prompt text; BUNDLE is this run's runtime package id,
  consumed by id in 🎨 Krea2 / 🎬 H3 (it carries the prompt and the reference images, not the skill).
- **The skill dropdown lists only skills without a `workflow.json`** - a skill that ships a workflow is
  driven by `workflow.json`, its body text does not participate in this node, so it is not listed here.

![⚡ Neo Prompt Agent node](../assets/images/neo-prompt-agent.png)

### Inputs / Outputs

| Input | Type | Description |
|------|------|------|
| `prompt` | STRING (hidden) | Prompt text (hidden) |
| `instance_uid` | STRING (hidden) | Instance id (hidden) |

| Output | Type | Description |
|------|------|------|
| `PROMPT` | STRING | Prompt string (multi-result skills consume it entry by entry) |
| `BUNDLE` | STRING | Runtime bundle id (`bnd_*`), see below |

- Connect `BUNDLE` to the `bundle` input of 🎨 Krea2 / 🎬 H3 to carry the prompt and the reference images
  in one go (wire / `@` reference / local upload), without the skill.
- A bundle lives in memory only; once it expires, downstream safely falls back to its local inputs.

## 📦 Neo Bundle Expand - expand a BUNDLE

Expands the **BUNDLE** from ⚡ Neo Prompt Agent into standard input slots, aligned with the official
MiniMax H3 Reference to Video `ref_images` (up to 9):

- **Output slots grow** - only `prompt` + `image_1` are shown by default; connecting the last visible
  image slot reveals the next one, up to 9.
- After a run the node shows the prompt and a thumbnail grid of the reference images in output order
  (read-only). Video and audio references are not expanded.

| Input | Type | Description |
|------|------|------|
| `bundle` | STRING (forceInput) | The BUNDLE output of ⚡ Neo Prompt Agent |

| Output | Type | Description |
|------|------|------|
| `prompt` | STRING | The prompt text inside the bundle |
| `image_1..image_9` | IMAGE | Reference images (up to 9, revealed as slots grow) |

## 🔲 Neo Reference Grid - reference-image grid node

Prompt + up to 12 reference images in a single node:

![Neo image processing nodes on the canvas](../assets/images/image-process.png)

- **Grid slots (1~12)** - the toolbar −/+ adjusts the slot count at runtime (default 9, not saved with
  the workflow; it grows automatically when more images arrive). Drag in from the asset panel / add
  locally in batches (multi-select) / drag OS files straight onto the grid; tiles are
  drag-reorderable, removable with ✕, clickable for a preview.
- **Load recipe** - the toolbar ☰ opens a picker listing only plain recipes that contain images
  (multi-segment director recipes and image-less recipes are excluded); clicking loads the images
  (≤12) and the prompt into the grid.
- **Width-driven flow layout** - columns follow the node width (minimum card width 84px), card aspect
  follows the image's real ratio (whole image visible, never cropped); the node height follows the
  content.
- **Output slots grow** - `prompt` / `BUNDLE` / `image_1` by default, slots reveal up to `image_12` as
  you connect them; after a run the node shows how many reference images were actually used and their
  source order (cell N).
- **Recipe integration** - when a recipe is saved, the grid images are collected as the **primary image
  assets** (ahead of wired LoadImage nodes); on restore they fill the grid first (≤12) and the rest goes
  into LoadImage; when a sub-graph has no Neo Prompt node, the prompt falls back into the grid's prompt box.

No visible inputs (only the hidden `refs` / `prompt_text`).

| Output | Type | Description |
|------|------|------|
| `prompt` | STRING | The content of the node's prompt box |
| `BUNDLE` | STRING | Runtime package id; connect straight to 🎨 Krea2 / 🎬 H3, or expand it with 📦 Neo Bundle Expand |
| `image_1..image_12` | IMAGE | Reference images in grid-slot order; a broken file keeps its slot empty instead of shifting the rest |

## Node interface & buttons

Both nodes share the same layout (the Agent shows no status bar):

| Control | Position | Function |
|------|------|------|
| LOCAL / EXTERNAL | Top status bar | Switch between local prompt / external text_input (shown automatically once connected) |
| 🎲 | Bottom-right of the text area | Generate a random creative prompt |
| ☰ | Bottom-right of the text area | Open the preset list (search, delete, category tab filtering) |
| 💾 | Bottom-right of the text area | Save the current prompt or recipe as a preset; the AI extracts the title and category tags |
| 👁 | Bottom-right of the text area | Markdown preview toggle (see below) |
| ✕ | Top-right of the text area | Clear the current prompt in one click, synced to the widget and local storage |
| ＋ | Bottom input bar | Attach a reference image (captioning / multimodal skills); paste, drag and `@` reference supported |
| Skill picker | Bottom input bar | Pick the skill used for this generation ([skills.md](skills.md)) |
| Auto generate ☐ | Bottom input bar | When ticked, running the workflow performs the generation and writes the result back live |
| ✨ | Bottom input bar | Generate a prompt from the quick-input description |

- **Markdown preview (👁)** - when the generated result is recognized as Markdown (headings / code blocks
  / lists and the like) it switches to a typeset preview automatically; 👁 toggles manually between
  preview and raw editing; streaming output renders live; task-list checkboxes (`- [ ]`) are clickable
  directly, and the choice is written back into the text and carried into the next generation. Clearing
  the prompt clears the preview too.
- **Category tabs** - the three tabs under the preset list's search box: image / video / recipe. Image is
  everything except `presets/video/`, video is the prompts under `presets/video/`, recipe is the plain
  recipes. Image is selected by default, and the choice is stored in frontend local storage for the next
  opening.
- **Skill picker** - pick the skill for this generation: image / reverse, task, style template, custom;
  hovering a row shows a floating preview card (generation skills = configuration summary, the rest = an
  excerpt of the skill.md body), clicking the card opens the detail window; + New Skill / ⬆ ZIP /
  ⬆ Folder at the bottom of the dropdown are the skill-management entries.
  The first option is the empty "Default" entry: with no skill
  selected the backend decides on its own whether a template applies, and an image with no skill routes to captioning.
  In the desktop agent dock, image and film generation both go through the backend agent
  (`POST /neo_agent/run`, an SSE timeline — see [api-routes.md](api-routes.md)): the dock has no skill picker, the
  LLM picks the skill itself through `list_skills`, and the tool list is the whole MCP registry (the `director_run` /
  `segment_run` / `assemble_run` film chain included). The transcript shows the plan line, one card per tool call
  (arguments / progress / result with result thumbnails — an image skill lays out the picture and a film task a muted
  clip, and a click opens the popup viewer for the full image or the playback instead of taking over the whole window)
  and the final answer; a running task card carries a Cancel button. Links inside the timeline stay in the page: a
  result link opens the popup viewer, an external link opens a new window, and the window never navigates to the
  bare image / video page — navigating away and coming back reloads the Studio page, taking the startup status
  and the whole transcript with it. The main button **✨ Generate** sits in the bottom-right corner of the composer's
  bottom row and has three states: idle is generate, a running turn turns it into **⏸ Pause** (it posts
  `/neo_agent/pause` with the `run_id` from the first frame, parks the loop at the
  next turn / poll boundary, and kills the in-flight ComfyUI task at that boundary without resending it), and a paused
  turn turns it into **▶ Resume** (it posts `/neo_agent/resume` to release the checkpoint). A full-width **⏹ Cancel**
  row appears above the textarea only while a run is active — Cline's rule: with nothing running there is no cancel
  button, and that row takes no space. Pressing it aborts the stream and posts `/neo_agent/cancel` by `run_id`, so the
  backend stops the loop, kills the task in flight and releases resume, letting a loop parked on a pause checkpoint exit
  too, and the timeline lands a「⏹ 已取消 / Cancelled」row. A stream cut by navigating away or closing the page cancels
  the background loop and the task the same way, so nothing keeps polling once the page is gone.
  The dock starts closed and the header **✨** button opens it; a sash between the page view and the
  dock resizes it (260px floor for the dock, the page view keeps 420px), dragging it narrower than 150px closes the
  column, double-click collapses / expands, `←`/`→` nudges it, and a key in the closed state reopens it at the
  width it had. Open state and width live in `localStorage["neo_studio_agent_dock"]`, and closing keeps the width.
  Drag the dock narrower than 316px and the composer's bottom row keeps only the glyphs (📎 / 🔌 / 📝 / ⚡ / ✨):
  the full label stays in the DOM as the button's `aria-label` (the main button carries it as its tooltip too),
  the row wraps, and the dock's `overflow: hidden` no longer clips the Generate button in the bottom-right corner
  (`@container (max-width: 300px)` in `studio/web/agent-panel.css`, measured on the composer's inner width —
  dock width minus its 16px padding).
  The composer: on top a context bar (📍 current page · current recipe and segment count ·
  paint mode · gallery directory) that the host refreshes on page switch, recipe selection, paint-mode switch and
  opening / closing the director page's library drawer. Only the selected tab's own fields are reported and travel in
  the request body's `context` into the system prompt: a director recipe is reported on the director page only, a paint
  mode on the paint page only, and a gallery directory only while the library is on screen, and `_context_block` in
  `studio/agent.py` gates the same payload on the same page. A directory carrying the 👤 character-directory flag shows
  as「directory name（角色图 / character images）」and the request body carries `character_dir: true` — the gallery's
  `isCharacterDir(view)` decides the flag and the host hands it its own view. A「✕」on the bar drops the context for this
  turn — the
  request sends `context: null` and the bar reads「已取消上下文 / Context off for this turn」; clicking the bar brings it
  back, and so does any host refresh. 📎 attachments (paste, drop, or pick, up to 6, with removable
  thumbnails) travel in
  the request body as multimodal content, so an image with no text is a valid turn; in Act mode they are the references
  this turn generates with — `generate_image` gets them automatically when its `references` argument is left out (a pasted
  image lands in `input/NeoAgent/`, deduplicated by content hash and written once per run), and film references land on the
  recipe this turn creates (character references and per-segment `refs.images`; an existing recipe is left untouched), and in
  a character directory that new recipe gets `shared.mode=r2v` filled in on the same rule as the gallery's ⋯ menu (a
  three-view sheet as a first frame opens the video on the sheet; a mode the model wrote itself — `i2v` or `mixed` — is
  left alone), while
  an explicit `references: []` stays plain text-to-image; a turn that carries references is an edit of that image, so the
  skill has to accept them — `list_skills` rows carry `mode` / `requires_ref`, and picking a `mode=t2i` skill never reaches
  the backend: the tool result names the `mode=edit / t2i_edit` skill to switch to (canvas-imported skills have no `mode`,
  so `requires_ref` decides), the same filter the paint page skill list uses; the other direction is refused the same way —
  an empty `references` on a `mode=edit` skill never reaches the backend, since the template's reference slot is required
  and an empty one makes the backend run the template as text-to-image and ignore the editing intent, and `list_skills`'s
  `q` matches the `mode` value too, so `q=t2i` is enough to find a text-to-image skill; a main model or LoRA whose family
  word (`krea2` / `qwen`, the one inside the skill id and Chinese name) disagrees with the skill is refused before the
  request goes out, and the prompt spells the scan's `suggested_*` fields out as the machine-wide defaults not to copy into
  this request; after the same arguments fail twice the prompt stops, and a node hint inside an error message (a
  `CLIPLoader` type, for one) is a loading mode, not a model filename to search for with `q`; swapping the main model or
  adding a LoRA is a per-request
  override — the system prompt spells out `list_models` (`q` / `group` / `near`, same-directory entries first,
  every item with its `dir`) and `generate_image`'s `model` / `loras`, which affect that one request and never
  write skill config; with a proper noun in the description (a character, an art style, a work) the prompt runs
  a `q` LoRA search first — one hit attaches to this request, several hits open a choice card with
  「不用 LoRA / No LoRA」 fixed last, and no hit generates as asked; a named main model gets the same search inside
  that two-keyword budget, with the skill taken from that item's `skills` and an empty `skills` asking the user which
  skill to run, and a `model` name outside the image scan's `diffusion_models` is refused before the request goes out
  with the closest filenames plus the "leave it empty" hint; the **📝 Plan / ⚡ Act** switch
  decides whether this turn runs anything — in plan mode the generation and recipe-writing tools stay out of the LLM's
  tool list, a call that arrives anyway is refused, and the turn ends with a step-by-step plan naming the tools and
  parameters; and when the backend's `ask_user` asks a question the loop parks on it, the timeline shows a choice card
  (the question, 2-5 options, and a free-text box) whose answer goes back through `POST /neo_agent/answer` — the card
  locks after answering, a 30-minute wait continues with a note that the user never replied, and cancelling by `run_id`
  settles a parked question.
  A turn that ends with `[ERROR]` (a one-shot failure like a remote LLM 502) lays a 「🔁 Retry」 row above the text box:
  it resends that turn's text, mode and attachments as-is, reads the interface context at the moment of the retry, and
  starts a fresh run with no `resume`. The row goes away on the next **✨ Generate**, on **＋** new session, and after a
  run that completes; a user-initiated **⏹ Cancel** never shows it. Clicking it with a draft still in the text box only
  warns to clear the box first — the draft is never overwritten.
  The empty composer shows the three most recent sessions by default (the same summary as 🗂: one row per run, first line + date); clicking a row replays that session read-only and arms the continue bar, **View all ›** opens the full list, and clearing the conversation or deleting a session empties the list; session history is plain files under `agent_sessions/`, and the desktop service lists, reads and deletes them itself, so the list still shows with ComfyUI stopped (only `/neo_agent/run` waits for the kernel). The **＋** header button starts a new session (the timeline drops back to the empty state with the recent list, the continue bar detaches, and the next message opens a fresh session — saved history stays untouched); the **🗂** header button opens the session list (`GET /neo_agent/sessions`: one row per run, newest first, with time /
  mode / status / first line / tool count); the full-page list carries its own header **✕** back to the timeline; **Open** replays that session's timeline into the dock **read-only** — a
  finished loop has no task to cancel and its choice card is fully greyed out. The composer then shows a
  「↩ continue the last session」 bar: the next **✨ Generate** posts that session's `run_id` as `resume`, and the saved
  conversation goes back in after the system prompt for the LLM to continue from (resuming into plan mode works the
  same way — the old system message is never stored, so this turn rebuilds it). One run lands as one JSON in
  `agent_sessions/` under the data root, and the trash icon button deletes the saved history too, behind one in-page confirm; the row delete and the replay header's delete are
the same trash icon, and deleting one session is confirmed before its file goes.
  The dock can run that same chain: `director_plan` (split, writing `story`) → `director_save` →
  `director_keyframes` (keyframes land in the recipe's `assets/`) → echo the returned `segments` / `shared` /
  `story` back to `director_save` (records `storyboard` and the first frame of non-r2v segments) →
  `segment_run` / `director_run`; same backend as the 📖 page, see [mcp.md](mcp.md).
  In act mode, a successful `director_save` / `director_copy` broadcasts the director editor's own saved-recipe event:
  the director page's recipe list picks the new recipe up on the spot and selects it, so opening the card is the editor
  for segment and parameter edits, and the whole film and single segments reuse that same recipe; in plan mode those
  two tools stay out of the tool list.
  The numbered directions at the end of the final answer are laid out as full-width clickable rows (the heading must be
  a one-line title — 下一步 / 接下来 / 后续 with 选项 / 方向 / 建议 / 操作, or English Options / Choices / Next options):
  a click fills the composer and posts that sentence as the next turn, which is the same path as typing it, the picked
  group locks with a「✔ …」line, and the rows left by earlier turns stay locked while a run is in flight and come back
  once it ends; every row spans the dock and wraps, so nothing is clipped at the 260px floor. Fewer than 2 or more than
  6 numbered items, and any numbered list with no such heading (plan mode's step-by-step plan), stays plain text.
  Enhancement skills only produce a prompt through `/rs_prompts/stream_generate_prompt`.
- **Multi-turn skills** - when a skill that declares `multi_turn` is selected, a line of small text
  appears at the very bottom of the node (it hides again when the skill is switched or cleared): each
  generation advances one stage only, so fill in the returned questions completely and click ✨ again to
  continue to the next stage.
- **Quick-input history** - the bottom quick-input bar supports terminal-style ↑/↓ recall of earlier
  inputs (locally persisted, deduplicated, newest first, capped at 20); editing the text leaves
  navigation mode, and both node types share one history.

## Skill management

Skill composition, the skill manager window, the embedded workflow editor, skill ⇄ canvas import and
writeback, writeback confirmation and change history: [skills.md](skills.md).

The skill picker at the bottom of the node groups the selectable skills by purpose: 🖼️ image / reverse,
🎨 style template, 📝 custom (the video-generation H3 skills and task skills are internal and are not
listed). A 📷 prefix on an option means that skill needs image input.

## Image captioning & image input

When a 📷 image / reverse skill is selected, reference images can be supplied in these ways:

| Method | Action | Description |
|------|------|------|
| ＋ button | Click the ＋ next to the input box | Pick a local image through the file picker |
| Clipboard paste | `Ctrl+V` | Converted to base64 automatically and turned into a thumbnail chip |
| Drag import | Drag a local image into the quick-input box | Read automatically and turned into a thumbnail chip |
| `@` reference | Type `@` in the input box | Lists every Load Image node image available in the current workflow |

Asset integration: "Copy to Input" in the gallery puts the image into ComfyUI's `input` directory, so a
Load Image node in the workflow can pick it up and the `@` picker can reference it for captioning; the
lightbox's send button can also write the information attached to an image straight back into a Neo
Prompt node.

### `@` image references

Typing `@` anywhere in the quick-input box opens the image picker, positioned next to the cursor:

- **Image sources** - scans every Load Image style node (variants included) in the current workflow,
  skipping BYPASS / disabled nodes.
- **Entry badges** - `#N`: this image is already wired into this node's IMAGE input slot, `N` being the
  parameter position number, and inserting it produces a `<Picture N>` marker at the `@`;
  `✓`: not wired but already attached for captioning; no badge: an unwired image, clicking only attaches
  it for captioning and takes no `<Picture N>` number.
- **Keyboard** - `↑`/`↓` move the highlight, `Home`/`End` jump to the ends, `Enter` inserts the selection,
  `Esc` closes; deleting the `@` closes the popup automatically.
- **Dedup & numbering** - the same image is never attached twice; numbering follows the parameter order of
  the workflow's Load Image nodes and stays consistent with the number badge on the thumbnail chip.

**Thumbnail chips & image markers**

- Attached images appear as thumbnail chips above the quick-input box; hovering enlarges the original,
  ✕ removes it.
- A chip with an `N` badge corresponds to the `<Picture N>` marker in the body text, used to describe the
  interaction between images.
- A chip without a number is only sent along as a captioning attachment.

### `/` skill quick menu

Typing `/` in the quick-input box opens the skill quick menu below the input, filtered live as you keep
typing (by skill name / id / tags, case-insensitive; Chinese skill names match on full pinyin and on
initials):

![`/` skill quick menu](../assets/images/prompts-slash-menu.png)

- **Filtering** - every keystroke refilters; an empty query lists all skills sorted by category; the
  popup closes when the query contains whitespace or the `/` is deleted. Chinese skills accept pinyin
  (`dmfg` / `dongman` hits 「动漫风格」).
- **Rows** - each row shows the skill name (📷 badge when images are required) and its category name; the
  internal id is not shown.
- **Keyboard** - `↑`/`↓` move the highlight, `Home`/`End` jump to the ends, `Enter` or `Tab` commits the
  highlighted row, `Esc` closes; filtering never auto-commits, a key press is always required.
- **Commit effect** - the selected skill is written into the node's bottom skill dropdown (equivalent to
  picking it by hand), the `/xxx` prefix is cleared from the input, and focus stays in the input box.

Good for keyboard-only skill switching: type `/` plus a name fragment, arrow to the row, Enter.

Backend implementation: [architecture.md](architecture.md) (`prompt_agent.py` / `prompt_encoder.py`),
API: [api-routes.md](api-routes.md).
