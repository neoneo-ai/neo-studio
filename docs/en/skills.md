# Skill Management

> 🇨🇳 中文: [../skills.md](../skills.md)

A skill = prompt template (`skill.md`) + built-in model configuration (model / VAE / CLIP) + built-in
workflow (`workflow.json`) + default base parameters. Presets are read-only and become editable after
"Copy as custom". The node-side skill picker and `/` quick menu: [prompts.md](prompts.md).

## Skill files

A skill is one or more Markdown files (main file `skill.md`) whose head is a YAML frontmatter (fields such
as `name`, `tags`, `max_tokens`, `multi_turn`, `audit`) and whose body is the System Prompt content (an
image-generation skill that ships a `workflow.json` generates through that workflow; its body text is help
documentation only and never participates in generation):

| Source badge | Storage directory | Description |
|----------|----------|------|
| SYS (built-in) | `skills/presets/<id>/skill.md` | Shipped with the plugin, read-only |
| TASK (task) | `skills/tasks/<id>/skill.md` | Built-in task skills (captioning, translation between Chinese and English, …), read-only, not listed in the picker |
| USR (custom) | `skills/custom/<id>/skill.md` | Created by the user, editable and deletable |

Image and video skills additionally have a `config.json` (saved settings: model / LoRA / size / count /
prefix …) and a `workflow.json` (an API-format workflow template with runtime variables as `{{...}}`
placeholders).

## How the right agent dock uses skills

The `@` in the agent dock's input designates a skill, and the candidates come in two kinds:

| Kind | How to tell | What a designated turn does |
|------|-------------|------------------------------|
| Generator skill | Has `workflow.json` and `gen_image` / `gen_video` | Becomes `generate_image`'s `skill_id`; on film work it is written into the recipe's segment `skill_id` |
| Body-only skill | No `workflow.json`; `category` is image / video prompt enhance, vision, or custom | Runs as `generate_prompt(skill_id=…)` — the skill body and its `references/` are read by the server inside that call, which produces the script / storyboard / shot list / finished prompt; the film-shaped one is delivered as a new director recipe |

`task` skills are not candidates — that work needs a recipe and running tasks, so designating one produces
nothing. The designated skill stays across turns and travels in the request body as `skill_id`; one run reads
that skill's summary once (category, `description`, template flag, reference-file list) and the body never enters
the dock's context. A turn that designates a body-only skill gets its turn cap widened to 20 and its ask cap
widened to 6 (every gate in the body gets its own `ask_user`); every other run keeps 12 turns and one question.
The backend enforces that cap on `ask_user` itself, not just in its tool description: asking past the cap and
re-asking a gate the user already answered (spacing and punctuation differences count as the same gate) are both
refused, and the refusal tells the model to settle the rest on defaults and deliver.
An imported Agent Skills folder (`SKILL.md` + `references/`) is the second kind:
the whole `references/` tree lands with the skill and the server reads it on demand inside `generate_prompt`.

The long body-only flows (the video-prompt kind: several confirm gates, output produced in passes) carry two more
requirements on that turn, injected by the backend into the system prompt (`_skill_block` in `studio/agent.py`;
the same rules for the unnamed path live in `studio/prompts/agent/system_prompt.md`): **the first sentence of the
turn lists the steps this flow is going to take** — one line per step, naming which step asks the user and which
step produces what, and the first tool call comes only after that list. When a long flow keeps its step count
secret until halfway through, the user spends the whole run finding out one gate was still open. That rule is
enforced at the call site: calling `generate_prompt` before the turn has said anything visible to the user is
refused once — one nag only, so a model that never speaks still reaches the delivery path. The text the skill
produces is the content of this turn's deliverable: the film-shaped one (script / storyboard / shot list /
per-segment finished prompts) is written up as **a new director recipe** and handed over — `director_plan` splits
it, `director_save` lands the recipe (segment prompts copied from that output, `story` carrying the idea and the
character references), the new recipe name is reported to the user, and the whole film and each single segment run
from that recipe instead of calling `segment_run` / `director_run` naked per segment; the image-shaped one
(image prompts) generates images by the skill's own rules. The closing `finish_task` `result` names the recipe and
its segment count, and the recipe name `director_save` saved this run counts as a product in `media` — its receipt
carries only `{success, name}` with no media items, so a media check that knows image names alone reports the
just-saved recipe as no product at all. The step list lands on the timeline's existing plan line (a content frame that comes with tool
calls renders as a plan card), and saving a recipe still refreshes the director page's recipe list with the
`✅ Recipe saved` toast — no second UI surface is built for this in the dock.

## Skill manager window

Two entry points: the 🅝 menu's "🗂 Skill Management" opens the unified window (left: collapsible
category-grouped list; right: detail, with search / new / upload / export from canvas; categories behave as
an accordion with "image generation" expanded by default, and every category expands temporarily while
searching), or the embedded entry inside the node's bottom skill dropdown.

### Creating & maintaining

- **New skill** - click "+ New Skill" at the bottom of the dropdown, type the skill name directly in the
  detail window's title bar, fill in the system prompt content and save.
- **Upload / import** - "⬆ ZIP" or "⬆ Folder" at the bottom of the dropdown imports a `.zip` or a whole
  folder (several `.md` files) as new skills.
- **Copy as custom** - built-in templates and task skills cannot be deleted, but one click
  the header's "Copy as custom" icon button makes an editable copy and switches the detail view to it immediately.
- **Delete** - only user skills (USR) can be deleted (with confirmation); built-ins (SYS / TASK) are
  protected.

### Browsing & search

- **Search filter** - the dropdown's input filters skills live (by name / tags; Chinese names match on full
  pinyin and on initials).
- **View / edit** - hovering a skill row shows a floating preview card; clicking the card opens the
  single-skill detail window, which renders the body as Markdown by default; "✎ Edit" switches to raw text
  editing, "👁 Preview" switches back (a new skill opens straight in edit mode).

### Detail window

- **Layout** - the main area has two columns: left "image / video generation settings", right "system
  prompt content" (side by side and equal height when the panel is wide enough, stacked in a narrow panel);
  for a skill with a `workflow.json` the generation is decided by the workflow and the body text does not
  participate, so the body area leaves the main area entirely and lives in a centered document popup opened
  from the "?" badge in the title bar, where preview / editing / attached-file management work as usual
  (built-in skills are read-only with no edit entry); the bottom "💾 Save / Delete (trash icon)" bar sticks to the top;
  the workflow area is collapsed by default and expands into the embedded editing canvas when its header is
  clicked.
- **Skill name** - the name takes no separate row and lives in the detail window's title bar (like the
  recipe name in the director editor): click it for inline editing, Enter / blur commits, Esc restores the
  saved name; a rename counts as an unsaved change and is written out with "💾 Save"; built-in (SYS / TASK)
  skills cannot be renamed.
- **Multiple files** - a skill may contain several `.md` files, concatenated in ascending file-name order;
  the detail window has a dropdown to switch between them (for the main file `skill.md` only the body is
  edited, its frontmatter metadata is kept), and attached files can be added or removed.
- **Multi-turn switch** - the `Multi-turn (multi_turn)` checkbox above the body area reads and writes the
  frontmatter's `multi_turn` field (unchecking removes it); when checked the node shows the multi-turn hint
  at its bottom, and "Copy as custom" copies that setting along.

### Window behavior

- **Left column width** - drag the divider between the panels to set the list width; it is remembered on
  release and reused next time; double-click restores the default.
- **Automatic sync** - saving, uploading, copying and deleting broadcast an update event and every skill
  picker on every node refreshes immediately.
- **Independent window controls** - the unified window has no overlay (the canvas behind stays usable):
  drag the title bar to move, double-click it to maximize/restore, "⛶" in the title bar maximizes to fill
  (8px margin) / restores, the bottom-right handle resizes; closing only happens through "✕" (Esc does not
  close the window).

## Workflow area: embedded editing

Open a skill that ships a `workflow.json` and the workflow area is collapsed; clicking its header mounts
the template into the embedded canvas: the API format is converted into a LiteGraph graph through the node
type registry, wires are restored by slot name and widget values are matched by name, and the skill's
`config.json` overrides the saved model / size / count / steps / prefix values and injects LoRA beyond the
template slots (prompts, seeds, reference images and other runtime variables stay as they are).

The toolbar offers "fit view", "reload" and "💾 Save workflow": it writes back into that skill's
`workflow.json` and syncs `config.json` (the settings area then reloads with the new configuration).
Preset skills never modify their `workflow.json`: model / size values go into a preset-local override
(`configs/skill_overrides/`), and when the workflow structure changes the skill is copied as a custom skill
automatically and the copy is written; the detail view then switches to the copy. The canvas backing buffer
is sized to the box by the system display scale (DPR), and widget input popups appear next to the cursor.
Template node ids may be non-numeric strings produced by canvas exports, such as `"193_82"`, and are mapped
to consecutive integers during conversion (LiteGraph only accepts numeric ids). Node positions share one
layout with "⤒ Import to canvas" (topological layers left to right, reference loaders pinned to the
leftmost column top to bottom, stacked inside a column by upstream center of mass, columns width-aligned);
the layout is computed during the API prompt → LiteGraph conversion from the workflow keys, and non-numeric
ids are laid out the same way instead of stacking.

Collapsing the header unmounts the canvas; expanding it mounts a fresh one. In a view without LiteGraph
(embedded in Studio), or when the skill references unregistered node types, nothing can be mounted and the
workflow area falls back to a read-only flowchart (red frame = node not installed / model missing, blue
frame = contains `{{template variables}}`). That fallback is pre-rendered with the current settings, so every
field a setting filled keeps its variable name on the line, written `field: {{TOKEN}} = value` (the name leads,
so column-width truncation cuts the value and never the variable), and the summary counts them
("🟦 N variables filled from the skill's settings") with one `{{TOKEN}}` chip per variable: hovering names the
node, the field, the filled value and what that widget accepts (a combo lists its options, a number its min / max),
and 📋 copies the variable name. The source line leads with the two settings the skill really stores — the size is
"base resolution × default ratio" — so `{{MEGAPIXELS}}` is spelled out as the number those two settings' width and
height give divided by 1024² (neither the skill nor the canvas has a megapixels setting), and `{{ASPECT_RATIO}}`
points at "default ratio". Size variables also state that each generation recomputes them from its own width and
height, so the number on the graph is only the preview at the skill's default size.

The embedded canvas carries `tabindex=1` and is focused on mount. ComfyUI's litegraph patch runs canvas
shortcuts against `app.canvas` (the main canvas), so the embedded canvas grabs a capture listener before
litegraph binds its events and redirects Delete / Ctrl+A / Ctrl+M / Ctrl+B / Alt+C / Ctrl+Shift+V / `.`
(fit view) onto the embedded sub-graph; space-panning and Esc for the node panel stay litegraph-native.
While a popup is open, the global shortcuts that would hit the main canvas are intercepted (Ctrl+Enter queue
/ Ctrl+S save / Ctrl+O open / Ctrl+G group / Ctrl+, settings / Ctrl+` log / Esc exit sub-graph / r refresh
nodes / w n m a sidebar / Alt+M); keys typed in inputs and Esc on the embedded canvas pass through. The
embedded sub-graph has no undo stack — Ctrl+Z undoes the main canvas, and structural changes are reverted
with "reload".

## Skill ⇄ canvas

The workflow area carries "⤒ Import to canvas" and "💾 Write back to skill": the first pre-renders the
skill's `workflow.json` with the current settings and injects it into the canvas, re-laying the nodes with
the same flowchart layout (reference loaders LoadImage/LoadVideo/LoadAudio move to the leftmost column top
to bottom instead of squeezing into the model-loading column; column widths are applied first and positions
are computed a second time at the new size, so a preview node whose height grew after widening does not land
on another node); `{{REF_IMAGE_N}}` / `{{CONTROL_IMAGE}}` are replaced by the actual images from the
LoadImage list according to the `config.json` slots (`control_ref`), leaving no placeholder on the canvas. The
success toast lists every template variable it baked into a number — the node and field it landed in and which
setting produced it (size is spelled "base resolution × default ratio", megapixels as the number computed from
that size, recomputed from each request's width and height) — because the canvas keeps no `{{variables}}`: the
number on the canvas is what the skill's settings compute, not a value stored in the skill.
The second writes the whole canvas into that skill's `workflow.json` (preset skills never edit the preset
itself: model values go to the local override, structural changes copy the skill as custom and write the
copy, and the pending-writeback state moves to the copy).
Reference video / audio slots (`{{REF_VIDEO_N}}` / `{{REF_AUDIO_N}}`) carry `mode: 4` in exports and presets
(bypass, magenta background — more visible than mute), so importing them into the canvas leaves them skipped
by default (the placeholder files usually are not in the `input` directory, and pushing them into a combo
turns the whole node red); writeback and "📋 From canvas" export temporarily enable them before reading the
prompt and restore them afterwards, so no slot is lost.

"📋 From canvas" starts with a variable-substitution list: model / text encoder / VAE / seed / count / output
prefix / reference images / prompt encoding are replaced by the fixed rules, and the canvas offers its extra
candidates checked by default — the hardcoded prompt text node (`PrimitiveString` / `PrimitiveStringMultiline`
/ `StringLiteral`, found by walking links through pass-through nodes such as previews and switches) and
`ResolutionSelector`'s `megapixels` / `aspect_ratio` (counted as the size source only when its width and
height feed a latent). Each row shows `node #id · field → {{TOKEN}} = current value`; unchecking a row keeps
the value baked in the canvas, and the checked ones are written into `workflow.json` as `{{PROMPT}}` /
`{{MEGAPIXELS}}` / `{{ASPECT_RATIO}}`, and the two settings the skill really stores are `config.json`'s
`default_ratio` / `base_resolution` (seeded by the same export): megapixels is no setting of its own, it is the
number those two settings' width and height give divided by 1024². At generation the size follows the requested
output, `{{MEGAPIXELS}}` is the megapixels recomputed from it (clamped to the node's 0.1–16), and `{{ASPECT_RATIO}}`
resolves to the option the `ResolutionSelector` combo accepts (a ratio the combo
has no entry for raises an error instead of submitting a bare ratio). A checked size row freezes no canvas value,
and the dialog says so next to the checkboxes, so the saved template is not readable as the canvas width and
height. Writeback restores the same selection from the placeholder in the same field of the stored template; the
selection itself is not stored in `config.json`.

After a successful import the skill window closes by itself (the full manager window closes, a standalone
detail popup collapses, nothing covers the canvas any more); the only canvas-side hint is the green dot on the
🅝 button, meaning "a skill is pending writeback". The entry that writes it is "💾 Write back to skill" in the
🅝 menu (the entry carries a green dot when the menu opens).

## Studio hands over to the main canvas

Studio has no canvas, so the skill detail's workflow area mounts "⤒ Edit on main canvas": it opens the main
UI at `/?neo_wf_edit=<skill id>`, and the main UI consumes that parameter (the URL parameter is cleared
first, so a refresh does not import twice), pre-renders the skill's `config.json` with the auto-suggested
models and injects it into the canvas, initializing node widgets from the skill's saved configuration
(overwriting the stale hard-coded steps / seed / size values inside `workflow.json`; values the skill does
not control are kept as they are). In the Studio desktop this handover happens inside the desktop window
(`OPEN_EXTERNAL_LINKS_IN_BROWSER = False`), and the main UI's "🎬 New Studio" returns to Studio in the same
window.

"💾 Write back to skill" in the top menu writes the whole canvas into that skill's `workflow.json`,
and syncs the canvas' model / LoRA / size / count (`batch_size` → `count`) / prefix into `config.json`, keeping the
settings area's base-resolution, prompt-enhancement and similar keys (presets stay read-only); the main-chain
LoRA nodes injected programmatically at import are stripped by count (they do not count towards the template
structure, their values only land in `config.json`).

The pending-writeback state is bound to the canvas the skill was injected into: the green dot collapses when
you switch to another canvas tab and comes back when you return, and a skill imported later into the same
canvas replaces the earlier one.

## Writeback confirmation & change history

### Writeback confirmation

- **Confirmation preview** - before a writeback or an embedded save is written, a confirmation preview opens:
  the change list against that skill (`config.json` keys, LoRA, node count, wire count, `requires_ref`, with
  old values struck through and new values alongside) plus the backend `warnings`; only "💾 Confirm save"
  writes. Cancelling, or a preview that fails, sends no save request.
- **Change baseline** - the baseline is the effective configuration at the moment of injection (global
  defaults ⊕ skill `config.json` ⊕ auto-suggested models for empty model names); defaults pushed into widgets
  and auto-suggested models do not count as changes. Ratios compare numerically (`1296:736` and `16:9` are
  the same ratio).
- **LoRA stripping** - the main-chain LoRA nodes injected from `config.loras` at import (count = number of
  LoRA entries − template slots) do not count towards the template structure: changing LoRA values reports a
  single `loras` line and writes the values into `config.json`, and the template's own `{{LORA_i_NAME}}` slots
  stay untouched.
- **Workflow only** - a writeback saves the API workflow (nodes, wires, widget values) and the synced
  `config.json`; canvas node positions / colors / groups / collapsed states are not written, and the
  `skill.md` body is preserved.

### Change history

Every confirmed save records one entry in a local per-skill history (`localStorage`, last 50 per skill,
newest first): "🕘 Change history" in the skill detail's workflow area shows that skill, the 🅝 menu's
"📜 Change history" shows all skills grouped by skill; both can be cleared. Records stay on this machine and
do not touch the skill files.

## Language variants & on-demand reading

- When generating a prompt, only one main file is loaded per language (`skill.md` for English /
  `skill.cn.md` for Chinese, mutually exclusive); by default the input language decides which, and the remote
  configuration can pin it to `en` / `cn`.
- Reference files in subdirectories (`references/*.md`, `*.txt`) are not merged into the prompt up front; the
  model reads them on demand through tools. Workflow reference image pixels are fetched on demand as well,
  matching progressive disclosure and cutting token use. Local and remote modes behave the same, and only when
  there are no reference files and no workflow context does it fall back to single-turn generation.
- The body may contain `<!-- @if TOKENS -->…<!-- @end -->` conditional blocks (comma-separated, several
  allowed): a token is a generation mode (T2VA / I2VA / FL2VA / L2VA / Reference) or a reference media type
  (PICTURES / VIDEOS / AUDIOS). When the workflow context contains an H3 node, only the blocks whose tokens
  matched are injected and the markers are stripped; with no H3 context, no markers, or no intersection, the
  full text is kept. `minimax_h3_base` saves roughly 33%~40% of tokens by mode-based trimming,
  `minimax_h3_full_ref` roughly 20% by reference-type trimming.

## H3 format audit

Skills that declare `audit: h3` in their frontmatter (`minimax_h3_base`, `minimax_h3_full_ref`,
`minimax_h3_image_ref`) pass a pure-rule structural audit after generation, costing no tokens: the six-block /
three-field structural order, timestamp format and duration limits, consistency between reference tags and
workflow wires, speaker ids in dialogue, and leaked internal representation terms.

- When violations are found, one narrow-fix LLM call is issued that repairs only the listed violations; the
  result is adopted only if it passes the re-audit and the reference-tag set and the dialogue lines are
  unchanged line by line, otherwise the original output is kept (at most one repair round).
- The UI shows the whole process: the answer keeps streaming as usual, and after generation a "📋 H3
  pipeline" panel above the prompt box accumulates the stages (auditing / passed / N issues found /
  auto-fixing / fixed / repair rejected, original kept), and stays after the stream ends for review.
- Paths that use the tool loop (the skill has reference files, or the workflow's H3 node has reference images
  wired) first show "⏳ generating (reading skill reference files on demand / inspecting N wired
  references)…" and then stream the final result.
- A final grounding constraint decided by the mode is appended at the end of the workflow context, cutting
  the structural error rate at the source.

---

Backend implementation: [architecture.md](architecture.md) (`skill.py` / `web/skill.js`),
API routes: [api-routes.md](api-routes.md), tests: [testing.md](testing.md).
