# Changelog

Notable changes for Neo Studio. Versions are tagged `vX.Y.Z` and published to the ComfyUI Registry.

## [Unreleased]

- **A named body-only skill reports its step list once, and its gates are clickable.** The per-run gates above were
  per-run state only, so every follow-up message in the same conversation re-ran the same opening: the first
  `generate_prompt` was refused again, the model re-listed the whole flow, and the first gate was asked again from
  step 1. Two session-level facts now ride the focus chain (`gate_answers`, `intro_skills`, emitted on the `focus`
  frame and saved with the conversation): the skills whose numbered step list was already reported — the intro gate
  runs straight through for them — and the gates the user already answered (question → answer), which
  `_focus_block` prints so the run continues from the current step instead of re-asking step 1. Gates the model
  writes as answer text (`A. B. C.` lines plus a question) leave the user typing an answer — only `ask_user` renders
  clickable options — so a final answer of that shape is nagged into an `ask_user` call, twice at most per run (the
  second nag demands that single tool call; a model that keeps answering in prose still finishes). Covered by
  `studio/tests/test_agent.py` (`TestSkillProcessGates`); docs in `docs/skills.md` and its `docs/en/` mirror.

- **The body-only skill's step list, gates and recipe delivery are enforced by the backend.** Four end-to-end runs of a
  named video-prompt skill against a local 27B model showed the prompt-only contract does not hold there: every run
  called `generate_prompt` as its first action and announced the steps only after the skill body came back, one run
  re-asked the same confirm gate fifteen times until the 20-turn budget was gone with nothing delivered, and the
  closing `finish_task` was refused because the recipe it had just saved was not in the accepted product names. Three
  gates now live in the loop (`studio/agent.py`): a designated body-only skill that calls `generate_prompt` before the
  turn has said anything visible to the user gets refused once (`[error]` naming the numbered step list it must send
  first — one nag only, so a silent model still reaches the delivery path), `ask_user` past the run's gate cap is
  refused with the default-spec delivery path, and re-asking a gate the user already answered is refused without
  parking on a new question (the question is compared with whitespace and punctuation stripped). `finish_task` accepts
  the recipe name this run's `director_save` saved — its receipt is `{success, name}` with no media items — as a product
  in `media`, reported as `{"kind": "recipe", "title": …, "url": ""}` so the dock's product row skips it and the recipe
  name reaches the user through `result`. The wording is in `_skill_block` and `studio/prompts/agent/system_prompt.md`.
  Covered by `studio/tests/test_agent.py` (`TestSkillProcessGates`); docs in `docs/skills.md` and its `docs/en/` mirror.

- **A long body-only skill announces its steps, and its prompts land as a director recipe.** Naming a video-prompt
  skill (the `SKILL.md` + `references/` kind with several confirm gates and output produced in passes) started the flow
  with no shape: the dock's first card was the first `generate_prompt` call, and the user learned how many gates were
  still coming only when one of them asked. The designated-skill block the backend injects for that turn
  (`_skill_block` in `studio/agent.py`, and the same rules in `studio/prompts/agent/system_prompt.md` for a skill the
  model picks itself) now requires the first sentence of the turn to list the steps — one line per step, saying which
  step asks the user and which step produces what — before the first tool call; that list lands on the timeline's
  existing plan line, and the recipe-saved toast is unchanged, so no new UI is involved. The produced text is now
  named as the content of the turn's deliverable: the film-shaped one (script / storyboard / shot list / per-segment
  finished prompts) is written up as a new director recipe — `director_plan` splits it, `director_save` lands it with
  the segment prompts copied from that output and a `story` carrying the idea and character references, the recipe
  name is reported, and the film runs from that recipe instead of naked `segment_run` / `director_run` calls per
  segment; the image-shaped one generates images by the skill's own rules. `finish_task`'s `result` names the recipe
  and its segment count. Covered by `studio/tests/test_agent.py` (`TestNamedSkillRouting`); docs in `docs/skills.md`
  and its `docs/en/` mirror.

- **An attached image is in a turn only when it reached the request.** Pasting, dropping and library-dropping an image
  read it asynchronously, so **✨ 生成** right after a paste took `attachments` while the read was still in flight: the
  turn went out with zero images, the model saw the text alone, and a brand film with no logo or UI screenshot was built
  out of the words and ran for minutes before the user noticed. The composer now keeps every read in flight in a panel-
  owned set and `generate` settles it before taking the attachments — the chips on screen and the images in the request
  body are one set, and a paste never sends by itself (sending stays the user's click); a read that fails says so in a
  toast instead of vanishing. The turn header names 「附件图 N 张 / N attached image(s)」 and writes 「不带附件图 / no
  attached images」 on a turn with none, and an Act run that ends with no attachments and no produced media lays a
  「这一发没有附件图，也没有产物」 reminder row on the timeline (plan mode, an `[ERROR]` ending, a user **⏹ Cancel** and a
  turn that carried images never show it). The backend gets the same fact: the system prompt carries
  「本轮输入素材：附件图 N 张」 every turn, and a designated skill with no source image (attachments empty, focus chain
  carrying no produced image or film) opens a material card on the first call of the four film tools — 「⏹ 先不跑」
  keeps the call out of the queue as a `[skipped]` result, 「✅ 跑这一发」 runs it as written, and the card opens once
  per run, separate from the `confirm_films` scale card. Each saved session records its produced-media count `media`
  and closing `reason` (`finish` / `answer` / `turns_exhausted` / `cancelled`, the run's terminal status when the loop
  never reached a closing branch), and `GET /neo_agent/sessions` carries the same pair, so a zero-media
  `turns_exhausted` session reads that way in the list. Covered by `studio/tests/test_agent.py` (`TestMediaFacts`) and
  `studio/tests/js/studio-agent-skill.test.mjs`. Docs in `docs/prompts.md`, `docs/api-routes.md` and their `docs/en/`
  mirrors.

- **A designated skill that has no template now runs its own flow.** The dock's `@` picker only offered the
  template-backed generation skills (`workflow.json`), so naming one of the body-only skills — the
  `SKILL.md` + `references/` kind that writes a script, a storyboard or a finished prompt — was impossible, and
  naming it through MCP `generate_image` produced nothing at all. The picker now offers both kinds
  (generation skills first, body-only skills after them; `task` skills stay out, they produce no artifact):
  a template skill keeps going as the `skill_id` of `generate_image` / video, and a body-only skill runs as
  `generate_prompt(skill_id=…)`, where the server reads the skill body and its `references/` on demand inside
  that call. The dock fetches the named skill's summary once per run (`/rs_prompts/load_skill`: category,
  description, template flag, reference-file list) and never sends the skill body into its own context; a skill
  deleted mid-run falls back to the id-only block. A body-only run gets its own turn cap (20 instead of 12) and
  its own ask cap (6, one `ask_user` per confirm gate in the skill body) while ordinary runs keep asking once.
  `list_skills` rows now carry
  `category` and a 300-character `description` (the only self-introduction a body-only skill has) and `q`
  matches them, so an external client can find one; `has_workflow` was added to the `load_skill` payload.
  Covered by `studio/tests/test_agent.py` (`TestNamedSkillRouting`), the `list_skills` case in
  `studio/tests/test_mcp_server.py` and `studio/tests/js/studio-agent-skill.test.mjs`. Docs in `docs/skills.md`,
  `docs/mcp.md`, `docs/api-routes.md` and their `docs/en/` mirrors.

## [1.4.0] - 2026-10-20

- **Switching director recipes is one atomic move.** With the embedded editor holding unsaved changes, clicking a
  recipe card moved the card highlight, the segment chips and the size / steps echo to the clicked recipe while the
  editor stayed on the old one behind the dirty bar — **🎬 生成整片** then ran a recipe the user was not looking at and
  the edits on screen were skipped. The blocked target is remembered on the editor singleton: the dirty bar's
  "保存并关闭" / "放弃修改" closes the old editor and opens the recipe that was clicked, "继续编辑" cancels the switch,
  and the selection lands through `opts.onAdopt`, so highlight, segment chips, size echo and the agent context never
  move ahead of the editor. A film run keeps its segment highlight on its own recipe: switching clears it instead of
  painting a running index onto another recipe's chips. Covered by `studio/tests/js/studio-director.test.mjs`
  ("切配方撞上未保存修改") and the singleton cases in `studio/tests/js/director-editor-queue.test.mjs` and
  `director-editor-segment.test.mjs`. Docs in `docs/recipes.md`, `docs/studio-desktop.md` and their `docs/en/` mirrors.

- **A finished generation is a fact the agent keeps.** `image_gen` records the `skill_id` it ran on in the task row,
  the task snapshot returns it, and the MCP `generate_image` response, every `list_tasks` row and the image
  `task_status` snapshot pass it through, so the caller knows which skill produced the picture in its hands. The dock's
  agent writes the last successful generation — skill, main model, LoRAs, width / height, seed, recipe, prompt and the
  artifact filenames — into the session's focus chain, re-injects that block into the system prompt before every LLM
  request, and restores it from the session file on resume, so "one more image" continues on the last run's skill
  instead of re-listing skills and models every turn. A failed, cancelled or timed-out call records nothing; a session
  saved before the focus chain exists resumes as an empty one; and an external MCP client sees `skill_id` on its own
  calls only — the image task table is in memory (32 rows, terminal rows pruned after 30 minutes), so a batch sent
  before a restart stays unqueryable. Covered by `studio/tests/test_image_gen.py`, `studio/tests/test_mcp_server.py`
  and `studio/tests/test_agent.py` (`TestFocusChain`). Docs in `docs/api-routes.md`, `docs/mcp.md` and
  `studio/prompts/agent/system_prompt.md`.

- **The skill workflow preview names the variable behind every value it filled in.** The read-only flowchart
  pre-renders `workflow.json` with the skill's settings, so the `{{MEGAPIXELS}}` / `{{ASPECT_RATIO}}` the export
  just bound came back as `megapixels: 1` and `aspect_ratio: 1:1 (Square)` with no trace of the variable — the
  row the export dialog warns about was invisible in the graph. `applyWorkflowParams` records the source token
  per field (`tpl_filled`): the node line reads `megapixels: {{MEGAPIXELS}} = 1` with the name first so column
  truncation cuts the value and not the variable, the tooltip appends `← {{MEGAPIXELS}}`, and the summary counts
  the filled variables and lists one copyable chip per variable. Each chip spells out the target (node, field, value
  and what that widget accepts — a combo's options or a number's min / max), the source in the two settings the skill
  really stores (the size is "base resolution × default ratio"; megapixels is that width × height ÷ 1024², it is no
  setting of its own), and whether generation recomputes it. The same preview path also computed the default
  size with `Math.round(v / 16 + 0.5) * 16`, which lifts every exact multiple of 16 one step (1024 → 1040,
  1280 → 1296), so the previewed width / height and the megapixels derived from them never matched
  `resolve_dimensions`; it is `Math.floor` now, the same truncation as the backend's `int(v / 16 + 0.5)`.
  Covered by `studio/tests/js/skill-workflow.test.mjs` (line, chips, tooltip, `tpl_filled`, `filledTokenNotes`) and
  the size expectations in `skill-canvas-sync.test.mjs`, `skill-canvas-import-refs.test.mjs` and `skill-manager.test.mjs`.

- **"📋 From canvas" offers the canvas prompt node and the `ResolutionSelector` as skill variables.** The export
  replaced only its fixed list, so a canvas that wrote the prompt in a `PrimitiveStringMultiline` and took its size
  from a `ResolutionSelector` saved a skill with the prompt and the size baked into `workflow.json` — the skill's own
  settings had nothing to fill. `plan_workflow_skill` walks each `CLIPTextEncode`'s text link through the pass-through
  nodes to the hardcoded text node, and counts `ResolutionSelector`'s `megapixels` / `aspect_ratio` only when its width
  and height feed a latent; the new `POST /neo_image_gen/plan_workflow_skill` returns those candidates and the title
  dialog lists every row checked by default. Checked rows are written as `{{PROMPT}}` / `{{MEGAPIXELS}}` /
  `{{ASPECT_RATIO}}`, the runtime fills the megapixels from the requested output size and the ratio with the
  `ResolutionSelector` combo option for it (a ratio the combo has no entry for is an error, not a bare string in a
  combo widget), and writeback restores the same selection from the stored template. The megapixels row shows the
  canvas number, so the dialog states next to the checkboxes that the size comes from the skill's "base resolution ×
  default ratio" recomputed for each request and megapixels is derived from that size. Importing a skill to the
  canvas carries the same disclosure in the success toast (`filledTokenNotes`): one line per template variable it
  baked into a literal, naming the node and field it landed in and the setting that computed it — the imported
  `workflow.json` on the canvas keeps no `{{variables}}` of its own. Covered by
  `studio/tests/test_skills.py` (`TestCanvasBindCandidates`), `studio/tests/test_image_gen.py` (the two placeholder
  fills plus the invalid-ratio error), `studio/tests/js/skill-workflow.test.mjs` and
  `skill-canvas-sync.test.mjs` (import toast). Docs in `docs/skills.md`,
  `docs/api-routes.md` and their `docs/en/` mirrors.

- **A named main model now says which skills it can run.** `list_models` returned only `{name, dir}` for
  `diffusion_models`, so an agent told to generate with a model whose name carries the family word (`BSSDesirexKrea2`)
  had nothing in the tool output naming the skill template that model fits, and picked a Qwen skill
  (`data/agent_sessions/20261019-141620_*.json`). `list_models` now builds a per-call family index from
  `GET /rs_prompts/skills` — the family word of a skill's id / Chinese name, falling back to the model pinned in that
  skill's `gen_config` — and every `diffusion_models` item of the image scope carries `skills`, an empty list when the
  `krea2` / `qwen` word list does not recognize the family (`studio/mcp_server.py` `skill_family_index` /
  `model_item`). `generate_image` checks a named `model` against the image scan's `diffusion_models` before the request
  goes out and answers with the closest filenames plus the "leave it empty and the backend picks per the skill" hint —
  the same shape as the LoRA name check (`check_main_model`); a model name the word list does not recognize is still
  sent. The system prompt searches main models with `group=diffusion_models` inside the LoRA two-keyword budget and
  takes the skill from that item's `skills` (`studio/prompts/agent/system_prompt.md`). Covered by
  `studio/tests/test_mcp_server.py` (`ModelLookupTests.test_main_models_carry_the_skills_their_family_can_run`,
  `MainModelNameTests`) and `studio/tests/test_agent.py`
  (`test_main_model_search_rule_lands_in_the_prompt_and_the_tool_specs`). Docs in `docs/mcp.md`, `docs/prompts.md`,
  `docs/api-routes.md` and their `docs/en/` mirrors.

- **The agent answer carries one icon-only copy button.** The Q&A card rendered two `⧉ 复制` text buttons
  (`studio/web/agent-panel.js` `mkCopyBtn` — one in the turn meta row copying the ask, one after the answer body),
  so it was unreadable which text each one copied. The meta-row button is gone; the answer button stays, pinned
  after the final answer body, and is now Cline's overlapping-squares glyph as an inline SVG with no label, no
  tooltip and no `aria-label` — success swaps in a check, failure swaps in a cross, and the glyph returns after
  1.5 seconds, so a selection over the answer can never sweep the button label up with it.
  `studio/web/js/core/i18n.js` drops the `⧉ 复制` / `✓ 已复制` / `✗ 复制失败` keys the agent block re-added over the
  director block's copy. Covered by `studio/tests/js/studio-agent-skill.test.mjs` (one button per turn, icon-only
  face, clipboard success and failure icon swap). Docs in `docs/studio-desktop.md` + `docs/en/studio-desktop.md`.
- **Copy and delete icons are one shared glyph set app-wide.** Every copy button drew a `⧉` and every delete a
  `🗑` text character: WebView2 renders those as color emoji and the web fonts reflow them, so the same action
  looked different on the skill rows, the recipe cards, the director segment row, the grid toolbar, the lightbox
  toolbar and the gallery menus. `studio/web/js/core/icons.js` now owns the copy / trash / check / cross paths as
  inline SVG with a `currentColor` stroke, so each button keeps its own color and hover and no module carries a
  glyph of its own. Icon-only buttons take the icon alone (`studio/web/agent-panel.js`, `skill.js`, `ref-grid.js`,
  `director.js`, `recipes.js`, `skill/skill-detail-popup.js`); labeled buttons put the icon before the label
  (`skill/skill-detail-popup.js`, `recipes.js`, `gallery-gen.js`, `gallery-card.js`, `studio/studio-app.js`, and
  the new `icon` field of a `lightbox.js` action). The glyph prefixes leave the matching
  `studio/web/js/core/i18n.js` keys, and the director grid copy swaps a check / cross instead of a copied /
  failed label. Covered by `studio/tests/js/ref-grid.test.mjs`, `skill-manager.test.mjs`,
  `director-editor-grid.test.mjs`, `studio-agent-skill.test.mjs`. Docs in `docs/gallery.md`,
  `docs/h3-video-gen.md`, `docs/prompts.md`, `docs/recipes.md`, `docs/skills.md`, `docs/studio-desktop.md`
  and their `docs/en/` mirrors.



- **A text-to-image request stops landing on an editing skill.** Session `20261019-125206` ("生成一张刘亦菲的图片", no
  attached image) spent 12 tool rounds and produced nothing. `list_skills(q="t2i_edit")` hit 0 because `q` only matched
  id / name / cn_name, so the batch the earlier `q="edit"` returned set the pick; `qwen_image_21_local_edit`
  (`mode=edit`, `requires_ref=true`) with an empty `references` ran its required reference slot as plain text-to-image,
  and the trio copied out of the scan's `suggested_*` (`Krea2\krea2_turbo_fp8` + `qwen3vl_4b_fp8_scaled` +
  `qwen_image_vae`) into a Qwen template killed all three runs with "Krea2 expects conditioning with 12x2560 features
  (a 12-layer Qwen3-VL stack) but got 2560". `studio/mcp_server.py` now checks the skill row in the place the reference
  check already ran: an empty `references` on an `edit`-only skill fails naming the text-accepting skill to use, a main
  model whose family word (`krea2` / `qwen` — the same list `near` and the frontend `sortByModelFamily` use) disagrees
  with the skill's fails with the conditioning reason, and a LoRA of a foreign family fails with the same-family lookup
  `list_skills(q=<family word>)`; a skill the table does not list is left to the backend, `list_skills`'s `q` matches the
  `mode` value too, and the tool descriptions carry all three rules. `studio/prompts/agent/system_prompt.md` adds the
  matching pick rule, "the scan's `suggested_*` are the machine-wide defaults, not parameters for this request",
  "family mismatch — tell the user, do not swap the skill or the main model yourself", and stop once the same arguments
  failed twice (a node hint inside an error message is a loading mode, not a model filename to search for). Covered by
  `studio/tests/test_mcp_server.py`; docs in `docs/mcp.md` + `docs/en/mcp.md` and `docs/prompts.md` + `docs/en/prompts.md`.

- **An MCP child's UTF-8 stderr reaches the user.** `app/mcp_client.py` decoded the child's stderr with
  `locale.getpreferredencoding(False)`; a child that inherited `PYTHONIOENCODING` / `PYTHONUTF8` writes UTF-8, so the
  reason line 「缺依赖」 arrived as 「缂轰緷璧栵」 — the tail that exists to tell the user what to install said nothing.
  `decode_stderr()` decodes UTF-8 first and falls back to the machine code page, which is what a plain console child
  writes; stdout stays UTF-8 per JSON-RPC over stdio. Covered by `app/tests/test_mcp_client.py` (a child that writes its
  stderr bytes as UTF-8 explicitly).

- **The agent dock plays the sampling preview, not just a step counter.** The film's live preview existed all along
  (`studio/h3_preview.py`: 8 taeh3 frames per sampling step) and reached the director node panel and the Studio director
  page, while the right dock only read "running 3/8 段 1/3 2/8": `task_status` stripped `preview` / `latest_preview`, the
  poll loop emitted a text-only `status` frame, and a route-submitted segment keyed its payload by the graph node id
  "1", so an agent-run segment was not addressable by task at all. `h3_preview.py` now stores the same decoded frames a
  second time at a 384 longest side; `_task_and_wait` in `studio/agent.py` reads it in process and attaches it to the
  `status` frame once per advance (image generation attaches the captured progress image the same way); the tool card in
  `studio/web/agent-panel.js` mounts the shared `createFramePlayer` to loop that step and freezes on the last frame at
  the terminal state. The frame bytes stay out of the LLM — `tool_result` text, the MCP payload and the saved session
  file carry none of them. `h3_segment.py` keys the payload by task id when the request carries no node. The dock's
  result images are capped (`max-height` + `object-fit: contain`, click opens the compact Lightbox): a Markdown body
  image at its intrinsic 1536x864 filled the whole panel and pushed a horizontal scrollbar. Covered by
  `studio/tests/test_agent.py` (in-process read, attach-once, session file free of base64),
  `studio/tests/test_studio.py` (channel split, shared cap, terminal clear) and
  `studio/tests/test_h3_video_director.py` (compact frames stored, WS payload untouched). A preview read that cannot
  import returns no preview and keeps polling to the terminal state — `h3_preview` pulls `server`, `comfy.taesd.taesd`
  and `torch` at module scope, which the offline service and the test process do not have, so a UI-only read must not
  decide whether a film task gets delivered. Docs in
  `docs/h3-video-gen.md` + `docs/en/h3-video-gen.md` and `docs/api-routes.md` + `docs/en/api-routes.md`.

- **A style word in the prompt now looks for a LoRA on the machine.** The agent only ever attached a LoRA when the user
  named one, so "水墨仕女" and "赛璐璐少女" generated on the plain skill even with the matching LoRA sitting in
  `models/loras`. The system prompt (`studio/prompts/agent/system_prompt.md`) now runs one search when the description
  carries a proper noun — a character, an art style, a work, an artist: `list_models(group=loras, q=<keyword>)`, at most
  two keywords per description. One hit attaches to that `generate_image` call and the answer names which LoRA ran;
  several hits open the choice card with the filenames verbatim and 「不用 LoRA」 fixed last (that question uses the
  turn's single ask); no hit generates as asked and the search is not mentioned. `mcp_server.py` spells the same rule in
  the `list_models` / `loras` tool descriptions, so an external MCP client behaves the same. Video stays as it was —
  request-level LoRA applies to image generation only. Docs in `docs/prompts.md` + `docs/en/prompts.md`
  and `docs/mcp.md` + `docs/en/mcp.md`.

- **A narrow dock keeps its main Generate button on screen.** `📎 添加图片`, `🔌 MCP`, `📝 计划`, `⚡ 执行` and
  `✨ 生成` are flex items in one nowrap row inside a dock whose drag floor is 260px, so under ~316px the row
  overflowed and `overflow: hidden` on `.ns-agent-dock` clipped the accent button in the bottom-right corner.
  `studio/web/agent-panel.js` now builds each label as an icon span plus a text span, the row in
  `studio/web/agent-panel.css` wraps, and `@container (max-width: 300px)` on `.neo-agent-composer` (composer inner
  width = dock width minus its 16px padding) drops the text span and tightens the Generate button's padding. The
  full label stays in the DOM: `textContent` per button is byte-identical, the same string is the button's
  `aria-label`, and the main button carries it as its tooltip, so an icon-only button is still named. Covered by
  `studio/tests/js/studio-agent-skill.test.mjs` (button structure, `aria-label`, the CSS rule). Docs in
  `docs/prompts.md` + `docs/en/prompts.md`.

- **MCP model lookup answers "which LoRA goes with this checkpoint", and a LoRA override stays in one request.**
  `list_models` forwarded the raw `/neo_image_gen/models` scan — a flat list of everything on the machine cut at
  40 items — so an agent picking a LoRA for `Krea2\Moody\krea2_Moody-Krea-Mix-v2G_int8.safetensors` had no
  directory in front of it and no way to ask for one. `studio/mcp_server.py` now takes `q` (directory + filename
  substring), `group` (one group only), `scope=video` (the H3 scan at `/neo_video_gen/models`), `near=<main model>`
  (same-directory entries first, then the family keywords the frontend `sortByModelFamily` uses, scan order kept
  inside each tier) and `limit`, every item carries its `dir`, and the `suggested_*` auto-picks still come back.
  `generate_image` gained `loras` (`[{name,strength}]`, bare filenames accepted): names are normalized against the
  `models/loras` scan, a name that is not there fails with the closest filenames instead of a doomed backend 404,
  `strength` clamps to 0-2 and a repeated name is attached once. Nothing writes a skill `config.json` — the
  override lives in that request body, and video runs keep taking their model and LoRAs from the segment skill.
  Covered by `studio/tests/test_mcp_server.py` (group, q, near ordering, video scope, limit truncation, bad
  arguments, request body shape, missing-name refusal); docs in `docs/mcp.md` + `docs/en/mcp.md`,
  `docs/prompts.md` + `docs/en/prompts.md`, `docs/api-routes.md` + `docs/en/api-routes.md` and
  `studio/prompts/agent/system_prompt.md`.

- **A character directory makes the agent's new recipe full-reference, like the card menu.** The 👤 mark only drove the
  two frontend entries — the card ⋯ menu and the multi-select bar — while the agent dock built its recipe from the same
  images with whatever mode the model wrote: `load_director_spec` derives frame modes from the first / last frame assets
  and needs an explicit `r2v` for image references, so a recipe with `refs.images` and no mode quietly became `t2v` and
  dropped the sheets. The mark is now a fact the host reports: `isCharacterDir(view)` answers about the view a host asks
  for, `agentContext()` in `studio/web/studio/studio-app.js` adds `character_dir`, the context bar shows
  「目录名（角色图）」, and `_context_block` in `studio/agent.py` puts it in the system prompt. `_apply_references` fills
  `shared.mode=r2v` on the recipe this run creates in a character directory — an existing recipe is left untouched, and a
  mode the model wrote itself (`i2v`, `mixed`) stays its own. Covered by `studio/tests/test_agent.py` (context marker,
  fill / respect / skip on injection, one `/neo_agent/run` end to end) and
  `studio/tests/js/studio-agent-skill.test.mjs` + `studio/tests/js/gallery-main-dirs.test.mjs`; docs in
  `docs/gallery.md` + `docs/en/gallery.md` and `docs/prompts.md` + `docs/en/prompts.md`.

- **Cloud presets have one home: every index directory is a Cloud Presets card.** The index's `categories` mapping used
  to host preset directories inside the `StoryBoard` / `CharacterSheet` output roots, so `_get_oss_cache_dir` cached the
  same cloud files a second and third time under `output/StoryBoard/presets/` and `output/CharacterSheet/presets/` —
  plugin cache written into the user's output tree. The published index only ever carried the `presets` key, and the
  `--category grid|character` publishing options wrote a key no reader matched, which pulled the scanned directories out
  of Cloud Presets and hid the cards. `studio/gallery_oss.py` now reads every index directory as one preset card
  (`_oss_index_dirs`), caches downloads only in `gallery/oss_cache/`, and drops `OSS_CATEGORY_GRID` /
  `OSS_CATEGORY_CHARACTER` / `_OSS_CATEGORY_PATH_PREFIX` / `_oss_index_categories` together with the `category`
  pass-through parameter on `_find_in_oss_index`, `_find_thumbnail_in_oss_index`, `_download_oss_file`,
  `_fetch_oss_dir_index`, `_oss_dir_cards`, `_oss_dir_items` and `_oss_directories_to_gallery_dirs`.
  `studio/gallery.py` collapses the per-route prefix ladders (list, copy-to-input, thumbnail, sidecar txt, media) into
  `_oss_dir_from_subfolder()`, so `Cloud Presets/<dir>`, `StoryBoard/presets/<dir>` and `CharacterSheet/presets/<dir>`
  keep their navigation shape and resolve against the same index; the two main dirs stay generation targets only, and
  a leftover `presets/` cache directory stays read-only and out of the "recently updated" counts.
  `tools/gallery_preprocess.py` drops `--category`: scanned and published entries land under `presets`, the index shape
  and the tag pass are unchanged, so no index republish is needed and old indexes with a `categories` mapping keep
  working (their directories surface as Cloud Presets cards). Covered by `studio/tests/test_gallery_main_dirs.py`
  (mapping ignored, single cache dir, three nav prefixes resolve to one index directory, main-dir preset card lists
  every index directory, tag tokens carry the Cloud
  Presets prefix) with the `gallery_oss` stubs aligned in `test_gallery_media_types.py`,
  `test_gallery_image_route.py`, `test_gallery_copy_to_input.py` and `test_gallery_dir_manage.py`; docs in
  `docs/gallery.md` + `docs/en/gallery.md` and `docs/release.md` + `docs/en/release.md`.

- **Cloud preset directories carry their character-dir default in the index.** Every cloud preset directory had to be
  clicked with 👤 on each machine before its cards behaved as character sheets, so a publisher who released nothing but
  sheet art left every user marking the same directories by hand. The master index gains a per-directory `tags` list:
  `character-sheet` marks a directory as a character directory for everyone who downloads the index, and `tags` is a
  directory attribute — a directory can carry several, tags never move the Cloud Presets card, and an index
  without the field is untagged, so old indexes keep working (`_oss_dir_tags` / `_oss_tagged_dir_tokens` in
  `studio/gallery_oss.py`). The effective list is marked ∪ tagged − `character_dirs_off`, served as `character_dirs`
  from `/neo_gallery/get_settings`; turning 👤 off on a tagged directory records it in `character_dirs_off` so the
  default cannot push it back, re-marking drops the entry, and removing a directory purges both lists. Publishing
  stays tag-only: `--tag-dirs dir1 dir2 --tag character-sheet` (and `--clear-tags`) edits the master index entries with
  no media rescan and no move of any directory. Covered by `studio/tests/test_gallery_main_dirs.py` (3 new cases) and
  `studio/tests/test_gallery_dir_manage.py` (5 new cases); docs in `docs/gallery.md` + `docs/en/gallery.md` and
  `docs/release.md` + `docs/en/release.md`.

- **The dock context is the selected tab's own, and one click drops it for a turn.** The context bar and the request's
  `context` carried every tab at once: the director recipe stayed reported after leaving the director page, and the
  gallery directory came from whichever library host was last mounted — a turn started on the skills page generated
  around a recipe and a directory the user was not looking at. `agentContext()` in `studio/web/studio/studio-app.js`
  now reports only what the selected page owns (director: the recipe, plus the directory while the library drawer is
  open; paint: mode and directory; gallery: the directory; skills / settings: the page alone), and `_context_block` in
  `studio/agent.py` gates each field on the same page, so a stale payload cannot leak across tabs. The bar gains a
  「✕」: that turn sends `context: null` and the bar reads「已取消上下文」, clicking the bar restores it, and any host
  refresh (page switch, recipe select, paint-mode switch, drawer open / close) restores it. Covered by
  `studio/tests/js/studio-agent-skill.test.mjs` (1 new case) and `studio/tests/test_agent.py` (1 new case); docs in
  `docs/prompts.md` + `docs/en/prompts.md`.

- **Dock attachments are the references the agent generates with.** Pasting or dropping an image into the composer only fed
  the multimodal turn: `generate_image` ran plain text-to-image, so the picture the user attached had no effect on the
  result. `_apply_references` in `studio/agent.py` resolves the turn's attachments to `input/` names through
  `image_gen._reference_name` (pasted data URIs land in `input/NeoAgent/`, deduplicated by content hash, resolved once per
  run) and fills `generate_image`'s `references` before the tool card is emitted, so the timeline shows what was really
  used — an explicit `references` wins, `references: []` stays plain text-to-image, and plan mode injects nothing. Film
  references belong to the recipe, so they land on the recipe this turn creates (`director_plan` characters, per-segment
  `refs.images`) and an existing recipe is never modified. A reference is an edit of that image, and a template with no
  reference slot drops it in silence — the paint page skill list already hides those skills from its edit panel, the tools
  had no such rule: `generate_image` with `references` now refuses a `mode=t2i` skill before the request reaches the
  backend and names the skill to switch to, using the same `mode` / `requires_ref` rule as `studio/web/skill/skill-core.js`,
  and `list_skills` rows carry both fields so a caller can pick one knowingly. Covered by
  `studio/tests/test_mcp_server.py` (4 new cases) on top of `studio/tests/test_agent.py` (8 injection cases);
  `studio/prompts/agent/system_prompt.md`, docs in `docs/prompts.md` + `docs/en/prompts.md` and `docs/mcp.md` +
  `docs/en/mcp.md`.

- **The agent's full session list closes, and deleting a session asks first.** 「View all ›」and「🗂」filled the dock with
  the list and left no exit but the「🗂」header button. The list now carries its own head with a「✕」back to the timeline,
  the row delete is a 🗑 (「✕」read as close, not delete), and the row delete and the replay header's delete both land
  behind a confirm before `POST /neo_agent/session/delete`. Frontend-only: `studio/web/agent-panel.js`,
  `studio/web/agent-panel.css`, `studio/web/js/core/i18n.js` + `studio/tests/js/studio-agent-skill.test.mjs` (2 new cases).

- **The agent can run the 📖 text-storyboard pipeline now, keyframes included.** `director_plan` and the editor's
  「生成分镜分段」 already hit the same split route, but the rest of that page had no tool: `director_save` dropped
  `story`, so an agent-built recipe opened without its idea / character references / storyboard settings (and r2i
  keyframes lost the character images), and nothing could render keyframes at all. `director_keyframes` renders them
  into the recipe's `assets/` through the same storyboard route the page calls, returns `segments` / `shared` / `story`
  with `storyboard` recorded and a first frame set on non-r2v segments (r2v segments get it in their reference pool),
  and the second `director_save` writes them back. `storyboard_status` / `storyboard_cancel` joined the task tables
  `task_status` / `cancel_task` probe, `director_spec` reports `storyboard` / `storyboard_prompt` / `first_frame`, and
  plan mode blocks the new tool. Covered by `studio/tests/test_mcp_server.py` (6 new cases); docs in `docs/mcp.md` +
  `docs/en/mcp.md` and `docs/prompts.md` + `docs/en/prompts.md`.

- **The dock's recent-sessions list survives a restart.** Session history is local files under `agent_sessions/`, but the four
  session routes were owner `comfy`, so the offline desktop service answered `409` to the summary fetch the dock makes at page
  load — before a cold-started ComfyUI answers — and the home list stayed empty (「🗂」worked because it fetches on click).
  `GET /neo_agent/sessions`, `GET /neo_agent/session` and the two delete routes are desktop-owned now: `agent` joins the
  desktop module set and `_AGENT` in `app/studio_caps.py`, so listing, opening and deleting sessions work with ComfyUI stopped,
  while `/neo_agent/run` still reports offline. Covered by `app/tests/test_studio_server.py` (the four routes are in the
  manifest, and a session file written under the data root lists back).

- **The Studio director page opens the selected recipe's editor on entry.** The page auto-selected the first director
  recipe for the generation panel, but `createRecipesPanel` only opened the editor from a card click
  (`openEditorOnSelect` lived in `pick()`), so the top-right pane sat on its dashed placeholder and the only way in was
  a second click on a recipe card. The `autoSelectFirst` path now takes the same open step as a click, so the editor is
  built as soon as the list lands; a card click still just switches segments on the open recipe, and an editor closed
  with ✕ is not reopened by simply returning to the tab (the next selection — a card click or a list refresh after a
  save — opens it again). Frontend-only: `studio/web/recipes.js` + `studio/tests/js/studio-director.test.mjs` (the
  first-entry case now asserts the editor is up without a click).
- **Neo Agent: the empty chat dock lists the most recent sessions by default, Cline-style.** The empty composer showed
  only its hint line, so the last conversations stayed hidden behind the「🗂」button. It now lays out the three newest
  sessions by default (the same `GET /neo_agent/sessions` summary the 🗂 list uses: one row per session, first line +
  date); clicking a row replays that session read-only and arms the「↩ 接上次会话」bar, and「View all ›」opens the full
  list. Clearing the conversation or deleting a session empties the list, and offline (the desktop service answers `409`)
  the composer keeps only its hint line. Frontend-only: `studio/web/agent-panel.js`, `studio/web/agent-panel.css`,
  `studio/web/js/core/i18n.js` + `studio/tests/js/studio-agent-skill.test.mjs` (2 new cases: the default 3-row list with
  click-to-replay, and the list emptying after Clear Chat).
- **The dock header gains a「＋」new-session button, Cline's New Task.** Reading a saved session back arms the「↩ 接上次会话」
  bar with no way back to a fresh conversation short of「🗑」, which deletes the whole saved history.「＋」rolls the timeline
  back to the empty recent-sessions state, drops the resume bar, and leaves every saved session on the backend untouched —
  the next message starts a new session. Clear Chat reuses the same reset before its delete. Frontend-only:
  `studio/web/agent-panel.js`, `studio/web/js/core/i18n.js` + `studio/tests/js/studio-agent-skill.test.mjs` (+1 case).
- **A recipe the agent saves is editable and reusable the moment it lands.** Act mode already let the dock's loop call
  `director_save` / `director_copy` (the system prompt tells it to build a one-segment recipe for a film request), and the
  recipe is a normal user recipe under `recipes/custom/`. Nothing told the UI: the director page's left recipe list only
  rebuilds on `DIRECTOR_RECIPE_SAVED_EVENT`, which the director editor dispatches on its own save path, so an
  agent-saved recipe stayed out of the list — and out of the editor — until the page was rebuilt. The dock now reads the
  saved name out of the tool result and broadcasts that same event with `{name, created:true}` plus a toast naming the
  recipe, so the list refreshes, the new recipe is selected, opening the card is the editor, and the film / segment runs
  reuse it. Replaying a saved session never broadcasts, so reading history leaves the UI alone, and plan mode keeps both
  write tools out of the tool list. `studio/prompts/agent/system_prompt.md` tells the model to pick an unused name
  (`director_recipes` first) and report it. Covered by `studio/tests/js/studio-agent-skill.test.mjs`.

- **The agent dock saves every run and continues from one.** Each run lands as one JSON in `agent_sessions/` under the data
  root (`<created>-<run_id>.json`, atomic write, 100 sessions / 400 KB per file / 7-day pruning) with the timeline `frames`
  and the `messages` a resume needs — no system prompt and no image bytes stored. `GET /neo_agent/sessions` lists
  summaries, `GET /neo_agent/session` reads one back, `POST /neo_agent/session/delete` and `.../delete_all` remove them, and
  `POST /neo_agent/run` takes `resume`. The「🗂」header button lists sessions; opening one replays its timeline
  **read-only** (a finished loop has no task to cancel, its choice card is disabled) and puts a「↩ 接上次会话」bar over the
  composer, so the next「✨ 生成」continues that conversation after a freshly built system prompt;「🗑」clears the transcript
  and the saved sessions together behind one confirm. `run_id` is validated to the shape the backend issued, so no session
  path is reachable from a request body. `studio/tests/test_agent.py` covers the store, the routes and the resume guards;
  `studio/tests/js/studio-agent-skill.test.mjs` covers the list, the read-only replay and the resume bar.

- **A page refresh no longer wipes the header's ComfyUI status.** The status chip and the frameless window controls
  were driven only by the pywebview `js_api` bridge. Two separate failures hid them after an F5: pywebview re-injects
  that bridge on navigation completion, measured 13 seconds after the page script runs
  (`data/studio_desktop.log`, `before_load` vs `loaded`), and both waited 10 × 300 ms for it and then gave up for good;
  and a bridge result is delivered back to the page by the window thread (pywebview computes it on a worker thread and
  hands it over through `evaluate_js`'s `Invoke` plus a semaphore), which the borderless-window drag loop occupies with
  a `sleep` per step and no message pumping — so bridge promises do not land at all while the window is being dragged.
  One F5 left the header with no「● 运行中」and no min / max / close buttons, and the in-place ready flip never ran
  after a reload either. Both now poll on a 5-second cadence with no give-up, the chip asks the bridge and
  `GET /neo_studio/comfy_state` in the same round and takes whichever lands first (the desktop-side service answers the
  same `StudioDesktop.comfy_state` on its own thread — `app/studio_server.py` runs it off-loop, the probe is a 1-second
  HTTP probe plus a port-to-PID scan), and the chip is painted on the ready round itself instead of only after the flip.
  `app/tests/test_studio_server.py` covers the route (409 while no kernel is assembled, the full state snapshot once it
  is); `studio/tests/js/studio-desktop.test.mjs` covers the chip coming up from the service with no bridge at all, and
  with a bridge whose result never lands.

- **The agent dock's final answer renders its「下一步选项」as clickable rows.** The `ask_user` choice card only exists
  while the loop is parked on the question, so a turn that ended with the model listing the next directions inside its
  answer left them as plain numbered text — the user had to copy a line into the composer and press ✨ 生成 again. The dock
  now splits a trailing options block off the final answer: a one-line heading naming it (「下一步 / 接下来 / 后续」with
  「选项 / 方向 / 建议 / 操作」, or English Options / Choices / Next options) followed by 2-6 numbered items, numbered
  samples inside a code fence ignored and the last such heading in the answer winning. The rest of the answer renders as
  Markdown, and the directions become one full-width row per item that wraps instead of clipping at the dock's 260px
  floor; a click fills the composer and posts `POST /neo_agent/run` with that sentence — the same path as typing it — the
  picked group locks with a「✔ …」line, and the rows left by earlier turns stay locked while a run is in flight and come
  back once it ends. A numbered list with no such heading stays text, so plan mode's numbered steps are never copied into
  a row of buttons. `studio/tests/js/studio-agent-skill.test.mjs` covers the rendered rows, the click as the next turn,
  the lock and the rows coming back, and the plan-mode list staying plain text.

- **The agent dock stops guessing which recipe and which mode the request is about.** The dock had a skill dropdown
  and the backend generated straight from a picked skill, so a picked skill bypassed the LLM entirely, and the LLM had
  no idea what was on screen: with the director page open it planned a one-segment film, and with the paint page in
  image-edit mode it planned a text-to-image run. The dropdown is gone — every turn is planned by the LLM through
  `list_skills` — and the host now hands the dock the current UI state (page, selected recipe and its segment count,
  paint mode, gallery directory) as the body's `context`. `studio/agent.py` sanitizes it at the boundary (`page` and
  `paint_mode` against a table, names and paths clipped to 120 characters, non-objects dropped whole, `paint_mode`
  counted only on the paint page) and appends it to the system prompt as facts, never as instructions; the dock shows
  the same state in a read-only context bar on top of the composer, refreshed on page switch, recipe selection and
  paint-mode switch. The main button sits in the bottom-right corner of the composer's bottom row and is three-state —
  **✨ 生成** idle, **⏸ 暂停** while running, **▶ 继续** while paused — and a full-width **⏹ 取消** row appears above
  the textarea only while a run is active: Cline's rule is that with nothing running there is no cancel button, so the
  row takes no space when idle. Pressing it aborts the stream and posts `POST /neo_agent/cancel` with the `run_id`, the
  timeline lands a「⏹ 已取消」row, and a cancel request that itself fails is written into that row instead of leaving
  the button stuck on「⏳ 取消中」. The composer and the transcript sit 8px
  inside the dock — at 4px the generate button and the textarea pressed the dock's border. Pause posts `POST /neo_agent/pause`
  and parks the loop
  at the next turn / poll boundary with the stream open; an in-flight ComfyUI task has no paused state, so the boundary
  cancels it and the resumed loop does not resend it, and 30 minutes without a resume ends the run as a paused
  timeout. Resume posts `POST /neo_agent/resume` and is a no-op when nothing is paused, so repeated clicks never push a
  run past the checkpoint; cancel releases `resume` too, so a parked loop exits. `studio/tests/test_agent.py` covers the
  context block (whitelists, clipping, non-dict input, paint-mode suppression off the paint page), the turn-boundary
  and poll-boundary pause checkpoints, the resume and cancel handoff, and the pause / resume route validation;
  `studio/tests/js/studio-agent-skill.test.mjs` covers the context bar through page and paint-mode switches, the
  three-state button as the rightmost control of the composer row, the cancel row that exists only while running
  (stream abort, the `run_id` cancel request, the「已取消」row, and a failed cancel request), the pause / resume
  requests, and the `paused` / `resumed` timeline rows.

- **The agent dock works like Cline: image attachments, Plan / Act, and mid-run choices.** The composer only took
  text, the dock always ran whatever the LLM planned, and a request with several viable directions had to be typed out
  by hand after the run ended. The composer now takes attachments — 📎, paste, or drag a file in, up to 6, with
  removable thumbnails — and sends them in the body's `images` in the same image-source shape the prompt panel uses;
  the backend resolves them through `prompts.resolve_image_bytes` and puts them in the first user message as
  multimodal content, so a bare image with no text is a valid turn. A card dragged in from the asset library rides
  the channel the director's reference grid already uses: `/neo_gallery/copy_to_input` copies it into `input/` and
  the attachment carries `kind: "input"` with that filename instead of a second base64 payload, with the thumbnail
  read back through `/view?type=input`; only the image suffixes the backend decodes pass, so a video or audio card
  is refused at the drop with the reason on a toast. The **📝 计划 / ⚡ 执行** switch picks the mode:
  in plan mode `generate_image` / `director_run` / `segment_run` / `assemble_run` / `director_save` / `director_copy` /
  `cancel_task` stay out of the LLM's tool list, a call that arrives anyway is refused with the reason, and the system
  prompt asks for a step-by-step plan naming the tools and parameters instead of a finished claim. `ask_user` is a
  dock-only pseudo tool (absent from the MCP registry): the loop emits an `ask` frame with the question and 2-5
  options, parks on it, and the timeline's choice card answers through `POST /neo_agent/answer` with the `run_id` and
  `ask_id`; the card locks after the answer, a 30-minute wait ends the park noting the user never replied, and
  cancelling by `run_id` settles a parked question so the loop never hangs on it.
  `studio/tests/test_agent.py` covers the plan-mode tool filter and refusal, the ask park and answer route, the
  cancel handoff and the attachment message shape; `studio/tests/js/studio-agent-skill.test.mjs` covers the mode in
  the request body, the choice card answering and locking, the attachment chips through the request, the library
  card drop through `copy_to_input` and the refused video card.

- **Agent results open in a popup viewer, and the window stops navigating.** Clicking an agent result took over the
  whole window: the dock's thumbnails opened the full-viewport lightbox (92vw / 88vh over a 0.72 backdrop), and a
  result URL in the final answer is a Markdown `<a href="/view?...">` whose click navigates the window to the bare
  image / video page — coming back reloads the Studio page, so the startup status and the whole transcript are gone.
  The shared Lightbox gained a `compact` popup form (thin backdrop, card capped at 72vw / 74vh) and the dock opens
  its results in it; the dock also intercepts every link in the timeline, so a result link opens the popup viewer,
  an external link opens a new window, and the Studio page never navigates. Film tasks ship a thumbnail now too:
  `tool_result` carries a `media` list of `{kind, url, title}` built from the image task's `images` and from a
  finished film's filename, so a director / segment / assemble run lays out a muted clip that plays in the popup.
  `studio/tests/test_agent.py` covers the media items; `studio/tests/js/studio-agent-skill.test.mjs` covers the
  popup form, the film thumbnail and the link interception.

- **A run can be stopped, and a closed page stops it.** A film polls for up to 2400 seconds, so a dock with no way
  out left the loop burning turns. The run's first SSE frame carries a `run_id`; a running task card keeps a
  **取消任务** button that posts `/neo_agent/cancel` with that `task_id`, and a stream cut by navigating away or
  closing the page cancels the worker on the consumer-disconnect path and kills the in-flight ComfyUI task there,
  so no loop keeps burning turns and no poller keeps hitting the queue after the page is gone.
  `studio/tests/test_agent.py` covers the poll-boundary task cancel, the `run_id` validation and the worker cancel;
  `studio/tests/js/studio-agent-skill.test.mjs` covers the task-card cancel request.

- **The right agent dock always failed with a remote LLM.** The agent sent the MCP `tools/list` payload to the
  provider untouched (`name` / `inputSchema` / `_meta`), llama-server looks for a `type` key on every entry and
  rejected the whole request with `HTTP 500 Failed to parse tools: Missing tool type`, leaving one red line in
  the chat. The tool table is now converted to the OpenAI
  `{"type":"function","function":{name,description,parameters}}` shape before it reaches the LLM, and the `_meta`
  example arguments the tool cards prefill with stay out of the request. The skill path builds its own tool
  table in `skill.py` and was never affected.

- **The agent dock starts closed, and you can drag it to width.** The dock opened on every window start at a fixed
  360px, so the page view lost that width on every launch and closing the dock was the only way to get it back.
  The dock now starts closed, the header **✨** button opens it, and a sash between the page view and the dock drags
  it wider or narrower (260px floor for the dock, the page view keeps 420px): dragging past 150px closes the column,
  double-click and the arrow keys collapse and reopen it, and reopening lands back on the width it had. Open state
  and width are stored in `localStorage["neo_studio_agent_dock"]`, and the sash is the left column's sash style.
  `studio/tests/js/studio-agent-skill.test.mjs` covers the closed default, the restored preference, the drag, the
  collapse threshold and the reopen width.

- **The agent dock runs a backend agent, and it can render film.** The dock's **✨ Generate** used to call the
  generation route itself, so the dock could only ever produce an image and only for a picked image skill, while
  the MCP server had the whole film chain for external agents. The dock is now a thin client of one backend route:
  `POST /neo_agent/run` streams an SSE timeline (`plan` / `tool_call` / `status` / `tool_result` / `content`), and
  the backend loop calls tools as an in-process MCP client through `mcp_server.serve` with the full registry —
  `director_run` / `segment_run` / `assemble_run` included, so 出片 works from the dock. A picked image skill skips
  the LLM and runs `generate_image` → `task_status` straight; the empty **智能判断** entry lets the LLM plan.
  Async tools are polled to a terminal state (600s for an image, 2400s for a whole film) with segment progress on
  the status line, a running task card carries **取消任务** (`POST /neo_agent/cancel`, which validates the
  `task_id` shape), and the loop stops at the model's final answer instead of burning the remaining turns.
  `studio/tests/test_agent.py` and `studio/tests/js/studio-agent-skill.test.mjs` cover the tool surface, the skill
  path, the plan/call/poll loop, the film progress line, the cancel call, and that the dock sends no
  `/neo_image_gen/generate` request of its own.

- **The agent dock generates without a skill, and MCP settings moved to Settings.** The right-side dock's skill
  dropdown had no empty option, so its first skill was selected by default and every **✨ Generate** run forced
  that skill's template. The dropdown now starts with the empty **智能判断 / Auto** entry, the same rule as the
  main panel's **默认**: with nothing selected the backend's smart-prompt path decides whether a template applies,
  an image with no skill routes to captioning, and picking a skill sends its `skillId` as before. MCP server
  management moved out of the dock into the Settings **🔌 MCP** tab; the dock keeps a **🔌 MCP** entry under
  **✨ Generate** that deep-links to `#/settings?tab=mcp`. `studio/tests/js/studio-agent-skill.test.mjs` and
  `studio/tests/js/studio-mcp-settings.test.mjs` cover the default option, the empty `skillId` payload and the deep link.

- **The MCP tab redraws its server rows and tool cards instead of stacking them.** The rows and the tool cards
  are appended to the panel body, and `load()` runs on every entry — tab activation, the ⟳ button, saving the
  registry, and the click on **连接 / 断开** itself. So the first **连接** left the pre-connect row on screen and
  added a second row for the same server: the tab showed `neo-studio` twice, once grey with **Connect** and once
  green with **Disconnect**, and every later refresh stacked another full set of tool cards. An empty
  `tools/list` after a **断开** kept the disconnected server's cards visible as if they were still callable.
  `load()` now clears the body before rendering, and the tool list is removed on every redraw so an empty list
  leaves nothing behind. `studio/tests/js/studio-mcp-settings.test.mjs` asserts one row per server across a
  connect / disconnect cycle and that the cards disappear with the session.

- **MCP tool cards open with runnable example arguments.** The Settings **MCP 服务** tab prefilled a tool's
  argument box with an empty string per required parameter, so the first **执行** click always failed:
  `generate_prompt` answered `缺少参数：text`, and `generate_image` reached the backend and came back with the
  Studio-only wording `请先在技能下拉里选择一个生图技能`. Every tool with required parameters now carries an
  example payload in `tools/list` under `_meta.example` (the spec's slot for extra data, so external agents
  ignore it), the desktop client passes it through in `/neo_mcp/tools`, and the card fills its box with it —
  read-only tools run on the first click, and the ids that come from a previous call stay as
  `<angle-bracket>` placeholders. `initialize.instructions` now states that `generate_image`'s `skill_id` must
  be a `list_skills` entry with `has_workflow=true`, and an empty `skill_id` fails on that pointer in the MCP
  layer instead of forwarding the UI wording. `studio/tests/test_mcp_server.py`,
  `app/tests/test_mcp_client.py` and `studio/tests/js/studio-mcp-settings.test.mjs` cover the example payload,
  the pass-through and the prefill.

- **The asset library keeps the directory you entered — per tab.** The gallery sidebar tab redrew the home page
  on every remount, so switching to the recipes tab and back, or closing and reopening the director page's
  asset-library drawer, dropped the user out of the subdirectory they had browsed into. A remount now redraws
  the live view — directory, bookmarks page, or home — and does it with the nav-restore flag set, so toggling
  the drawer no longer pushes a duplicate entry into browser history for the same directory. Each host keeps
  its own record (asset page / paint page's left column / director drawer, keyed by `data-lib-scope`), so
  browsing into a subdirectory in one no longer drags the others along. The record is written on every view
  change, not only when the gallery is carried off a host — a record written only on detach makes the next
  mount apply the target host's previous record, which is how toggling the drawer alternated between the
  home page and the remembered directory.
  `studio/tests/js/gallery-nav-history.test.mjs` covers the remount landing on the entered directory and the
  per-host records; `studio/tests/js/studio-gallery-host.test.mjs` drives the real Studio page: asset page →
  director drawer → open / close / same tab again, and a repeated click on the current top-nav tab.

- **A click on the top-bar tab no longer drops the asset library back to the home page.** The Studio header's
  logo and tabs are plain `<a href="#/gallery">` links, so clicking the tab of the page you were already on
  re-resolved the URL from that href: the `?gallery=` parameter the gallery writes was dropped and Chromium
  dispatched `popstate` for the navigation, which the gallery's listener read as a browser Back. One click
  went home, the next went back into the directory — an alternation reachable by clicking the tab you were
  already on. The header links now go through the page router (`go()`), which swaps views with `pushState`
  instead of navigating, so the query string survives and no `popstate` fires; browser Back re-routes through
  a `popstate` listener. `studio/tests/js/studio-gallery-host.test.mjs` asserts the click is intercepted, the
  `gallery` parameter survives a tab switch, and the gallery stays in the directory it was left in.

- **A single-segment recipe now opens on the timeline and hides the multi-segment controls.** A new director recipe
  opened on the **📖 Storyboard** page, which is the multi-segment planning surface (source / theme / granularity /
  per-segment comparison), even when the recipe held a single clip; the timeline row also showed **chunk seconds**,
  which only merges consecutive segments. A new recipe now opens on **🎞️ Storyboard timeline**, a blank one shows a
  one-line guide to the Storyboard page that disappears once a second segment exists, and with a single segment
  "chunk seconds" is hidden while the Storyboard page replaces its per-segment comparison table and batch-optimize
  button with a one-line hint. Adding a second segment brings both back. The segment card itself is flat now —
  transparent background, 1px border, 4px radius, a fixed-height (≤168px) frame thumbnail instead of a
  full-height drop area, and VS Code-style inputs (2px radius, blue focus border, and a fill clearly darker than
  the panel so a field reads as something you can type into). The recipe list on the left and the film-generation
  panel under the editor follow the same flat treatment (transparent fill, 1px `#2d2d2d` border, 4px radius;
  segment chips are outline-only and readouts use a darker placeholder fill), so the list, the editor and the
  output panel no longer look like three different designs.
  `studio/tests/js/director-editor-single.test.mjs` covers the landing tab, the guide, and both single/multi states.

- **A character-image directory now defaults to full reference when you build a director recipe from it.** In the
  asset library, multi-selecting images and clicking **🎬 New director recipe** always built one keyframe segment
  per image, so a three-view character sheet became a first frame and the video opened on the sheet. A directory
  can be marked **👤 Character** in "Manage Directories" (blue `Character` badge on the row). Both entry points now
  honour the mark — **🎬 New director recipe (full reference)** in a card's ⋯ menu and the same item on the
  multi-select bar build **one full-reference segment**: the images go into that segment's reference images (first
  9) and into **👤 Character references** (first 6, image storyboard defaults to r2i) instead of becoming
  keyframes. Unmarked directories keep the old behavior, and a mark covers the directory's subdirectories.
  Cloud preset directories are read-only and normally hide the select checkbox; marking one as a character
  directory brings it back, so a cloud 角色图 directory works too (the
  images are downloaded to `input/` on demand through `copy_to_input`, and bulk delete still skips read-only
  items). The flag is stored in `character_dirs` in `gallery_settings.json` and is cleaned up when the directory
  is removed.
  `studio/tests/js/gallery-director-recipe.test.mjs` covers the local and cloud recipe shapes,
  `studio/tests/js/gallery-dir-character.test.mjs` covers the row toggle and the subdirectory inheritance,
  `studio/tests/js/gallery-multi-select.test.mjs` covers the checkbox on read-only sources, and
  `studio/tests/test_gallery_dir_manage.py` covers the setting route.

- **The director page's left column switches between recipes and assets.** The asset library could only be opened
  from the **asset library** button inside the director editor, and closing it was a ✕ in its header — with no
  switch on the column itself, dragging an asset into the editor meant hunting for that button. The left column
  now carries a **📋 Recipes / 🖼 Assets** switch bar on top: "🖼 Assets" flips the column to the library,
  "📋 Recipes" flips it back, and the bar stays highlighted when the editor's button opens or closes it. The
  library header with its ✕ is gone — the switch bar is the one switch. `studio/tests/js/studio-director.test.mjs`
  covers the bar opening and closing the library and following the editor button.

- **The embedded director editor stays open after saving, and a finished film stays finished.** Saving on the
  Studio director page (including "🎬 Save & Generate Film") closed the editor, so the pane the user was just
  editing collapsed into the placeholder hint while the film ran below. Embedded saves now leave the editor in
  place — closing is the title-bar **✕**, the footer **Cancel**, the dirty bar's "Save & close", or switching to
  another recipe — and a successful save clears the unsaved mark, so **✕** closes without a confirm. The
  generation panel status also flipped back to "Generating…" after the film finished: a poll request issued
  before the terminal event landed after it carrying the stale running payload, so the progress bar and the
  **Cancel** button came back, and clicking Cancel answered "任务已结束，无法取消". The panel now freezes on the
  first terminal status (succeeded / failed / cancelled) and drops every non-terminal payload that lands later,
  in both the status handler and the in-flight poll. Closing the editor left the dashed placeholder pane
  holding the top half of the column, so the generation panel stayed at its splitter height under a strip of
  empty dashed box; an empty editor host now collapses to zero and the panel fills the column (splitter
  included), and reopening the editor restores the two-pane split. `studio/tests/js/studio-director.test.mjs`
  covers the editor staying open after save and the terminal status surviving a late poll.

- **Resizing the desktop window no longer flashes white.** Dragging a window edge runs the system size/move loop,
  where the WinForms Form and the `Dock=Fill` WebView2 control are resized together and the newly exposed client area
  is painted by their own backgrounds before the page composites. pywebview's `background_color` defaults to
  `#FFFFFF` and sets both `Form.BackColor` and the WebView2 `DefaultBackgroundColor`, so that surface was white — the
  window flashed white, and the restored `WS_THICKFRAME` edge flashed with it because DWM paints that ring in the
  system theme color. The window is now created with `background_color = #17171b`, the Studio page's body background,
  and `set_window_frame` pins `DWMWA_BORDER_COLOR` / `DWMWA_CAPTION_COLOR` to the same color with the style bits
  (Windows 10 ignores both attributes). `app/tests/test_studio_desktop.py` covers the color reaching `create_window`
  and the DWM colors being pinned.

- **Two more cloud preset packs, published at a quarter of the source size.** `3D风格修仙人物` and
  `3D风古代人物` (200 character sheets each) are now in the Cloud Presets index (14 directories, 2335 items).
  The 3D three-view sources are 8-10 MB PNGs, so `tools/build_gallery_presets.py --compress 0.25` writes each
  sheet as a JPEG at a quarter of its source bytes (quality ladder, then downscale). The incremental
  `--dirs` republish also keeps the sidecar `.txt`: `tools/gallery_preprocess.py` built its prune set from
  media filenames only, so the prune deleted the sidecars from the output before upload and the cloud lightbox
  was left with the index preview instead of the full prompt. `现代西方人物` and `中世纪-平民` were republished
  through the same `--compress 0.25` path: their cloud sheets are now a quarter of the source PNG bytes and
  carry the full `.txt` sidecar, which the first publish of those two directories did not. `角色杂图` (91
  sheets) joined the index as well, published with every sheet under 2 MB: the oversized sheets are re-encoded
  to JPEG at that cap and the ones already under it ship untouched.

- **Lightbox prompt sidebar is readable.** A preset's prompt rendered as one wall of text: the section label sat
  inline so the body hung at the label's tail indent, sentences never broke, and a 40-item negative prompt was one
  comma paragraph. Preset txt labels also use a half-width colon (`画面右侧区域:`), which the section parser only
  accepted as full-width, so those sections lost their label entirely. Labels are now block-level with a divider
  between sections, long values break at commas into lines, comma lists of short items (the negative prompt)
  render as chips, and the parser accepts `:` plus `？!?;` as boundaries. Copy 提示词 still copies the raw full
  text — the layout never rewrites what gets copied.

- **Cloud preset directories hide one by one, and the cloud index refreshes by hand.** Every cloud preset
  directory is a home-page card of its own, and the cached `oss_cache/_index.json` was stamped fresh on every
  launch (`_load_oss_index_from_disk()` resets the fetch clock), so directories published after the last sync
  stayed invisible until `sync_interval_hours` expired. The Manage Directories dialog now lists each cloud
  preset directory as a ☁ row with the same 👁 switch as the built-in sections — hidden by its card path
  `Cloud Presets/<dir>`, which then answers its deep link with nothing — and the title-bar ⟳ 刷新索引 button
  posts `/neo_gallery/sync_oss` to force re-download the index, so new cloud directories show up on the home
  page and in the dialog without a restart. The local Presets card is not a hideable home entry.

- **Cloud preset prompts copy the full text, not the preview.** The OSS preset index stores `txt_content` as a
  500-character preview (`parse_txt_preview(max_chars=500)` in `tools/gallery_preprocess.py`), so the lightbox
  提示词 panel and 复制提示词 of a cloud item stopped mid-sentence — `095_叛宗剑修` copied 500 of its 2044
  characters. New `GET /neo_gallery/txt` returns the sidecar `.txt` in full (local read through the shared media
  resolver, cloud download into the existing category cache — the download keeps the index's POSIX relative path,
  a Windows separator in the URL is a 404 and the panel silently keeps the preview); the lightbox renders the
  preview at once and swaps in the full text when it arrives, and the grid ⋯ menu 复制提示词 copies the full text
  too. The index preview stays a preview: widening it would double the index every gallery page downloads and
  force re-uploading the published sidecars.

- **Contributor entry docs.** `CONTRIBUTING.md` / `CONTRIBUTING_ZH.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md` / `CODE_OF_CONDUCT_ZH.md` and a pull request template, plus a CI gate that runs
  `studio/tests` and `npm test` on every pull request. No plugin code changed.

- **Director timeline segments are a pale identity tint, not a color slab.** Each block was filled at
  `hsla(hue,55%,58%,0.45)`, and at 70% lightness with 0.75 alpha while selected or hovered, so a segment with no first
  frame read as a solid saturated slab and the tiled first-frame strip lost its own colors under the overlay. The fill
  is `hsla(hue,32%,50%,0.2)` at rest, `…,58%,0.32` selected, `…,62%,0.55` for the drag ghost and 0.09 for an unchecked
  block; the hue stays position-based (`_segHue`), so a segment keeps its identity through a reorder, and the selected
  block is still told apart by the brighter `#8cf` border plus the alpha step, with the drag ghost keeping its shadow
  and thick outline. Covered by `studio/tests/js/director-timeline.test.mjs` (rest < selected < ghost in alpha,
  saturation capped, hue unchanged).

- **Director page buttons wear the shell palette.** The Studio director page was the one place where a solid
  `#2f6fed` fill sat on the `#17171b` shell: 「🎬 生成整片」(`.ns-gen-run`) and 「🎬 保存并生成整片」
  (`.neo-director-save-run`) were two saturated blue slabs, and every other button in the embedded editor and the
  generation row (取消 / 保存 / ✦ 生成修改 / ＋ 添加段 / ✨ 生成所有分段的提示词 / 生成这一段 / 拼回成片 / 全选 / 清空)
  inherited the node-side `.rs-btn` blue (`#1a3a5a` fill, `#60a5fa` text), so a full-width row of blue left no
  primary action standing out. The two film-generation buttons now use the shell's translucent primary —
  `rgba(47,111,237,0.18)` fill with the saturated `#2f6fed` border, `#cfe0ff` label, deepening to 0.3 on hover — the
  same treatment the skills page's Save and the startup 「保存并重启 ComfyUI」 already use, and the rest of the
  director-page buttons take the shell gray `#2a2a2e / #444 / #ddd`. Scoped to `.ns-director` and `.ns-gen-panel`, so
  the node-side editor keeps its blue buttons, and written as a `:is()` whitelist — the unsaved-changes bar keeps its
  blue 「💾 保存并关闭」/ red 「放弃修改」/ gray 「继续编辑」 semantics, the 取消 red outline is untouched, and
  `.rs-btn:disabled` keeps its dimmed state. Covered by `studio/tests/js/studio-desktop.test.mjs`; CSS only.

- **Two main-branch CI cases stop depending on wall-clock.** The agent attachment case waited a fixed
  `sleep(40)` for the dropped file to come back through `FileReader` — real async I/O, so on a loaded runner
  the read had not resolved when the assertion ran, and the case failed on `main` while passing locally. It
  now waits for the chip thumbnail to appear, bounded at 1 s. The `ResolveDir` case asserted
  `_resolve_dir("D:/presets") == Path("D:/presets").resolve()`, which holds on Windows only: a drive-letter
  string is a relative path on Linux, so `_resolve_dir` prefixes the data root and the compare is
  `/tmp/…/D:/presets` against the checkout root. The absolute-path case now uses a path under the test data
  root, which is the pass-through `_resolve_dir` documents.

## [1.3.0] - 2026-10-17

- **Upgrading from `comfyui-neo-nodes`: disable the old folder yourself.** Nothing in this release touches
  `custom_nodes/ComfyUI-Neo-Nodes` — the plugin sync only writes `custom_nodes/comfyui-neo-studio`, and the old
  package keeps loading next to it, so every Neo node registers twice and shows up twice in the node menu.
  Delete the old folder, or rename it to `ComfyUI-Neo-Nodes.disabled` (ComfyUI skips `*.disabled`). Data: the
  pre-1.2.0 plugin kept `configs/`, `gallery/`, `prompts/`, `recipes/`, `skills/` and `locals/` inside its own
  directory, and there is no migration code — copy those folders into the new data root (`data/` in the repo for
  a source run, `data/` next to the exe) before deleting the old folder, or the old data goes with it. Installs
  from 1.2.0 on already keep user data outside the plugin directory, so deleting the old folder touches nothing.

- **Backyard OSS config save round-trips.** The config form threw `inputs[key].select is not a function` on load
  and saved nothing: field type was probed with `typeof inputs[key] === "object"`, and every `HTMLInputElement`
  carries a `select()` method, so the plain text fields matched as combo objects and the directory combos matched
  as plain fields. Directory fields now live in their own `dirInputs` map, the save body carries every field, and
  a secret field left empty keeps the saved value. Server side, a submitted value containing `*` was dropped as
  long as the field name appeared in the masked response — editing a masked key into a real key was thrown away.
  It is dropped only when it equals the current mask exactly. Covered by `studio/tests/test_backyard_config.py`.

- **`HTMLCollection` spread removed from the frontend.** `[...collection]` in director, gallery-gen,
  gallery-masonry, llm-chat, prompts, skill, slash-picker and `js/core/dom-utils.js` is now `Array.from(...)`:
  WebView2's `HTMLCollection` is not iterable, so one empty container became a page-wide TypeError.

- **Skills page now wears the shell palette.** The page mounts the shared skill manager, which is modal-born:
  `prompts.css` gives it a `#1a1a2a` panel, a `#1a2a3a` title bar, `#5090cc` blue highlights and `#1a3a5a`
  small blue buttons, so next to the grey Assets / Paint / Director / Settings pages it read as a dropped-in
  dialog. The shell remaps it onto shell tokens inside the `.ns-skills` scope (`#17171b` page, `#202024`
  title bars, `#2a2a2e` + `#444` inputs and buttons, the settings tab's translucent blue for the selected
  list row) and hides the modal's "🗂 Skill Management" title bar — the header tab already names the page and
  nothing on the page is a draggable window. The skill modal and the node skill picker in ComfyUI keep the
  modal palette. Covered by a `studio/tests/js/studio-desktop.test.mjs` case that reads the `.ns-skills` rules.

- **Model dropdowns show the model file's update date.** `scan_models()` and `scan_video_models()` now answer
  `mtimes_<folder>` — a `{model path: epoch seconds}` map built from `folder_paths.get_full_path` plus one
  `os.path.getmtime` per file (940 files cost ~28 ms) — and `fillComboSelect` appends `· 2026-09-12` to the
  option label. The selected value stays the model path, so saved configs, the family sort and the
  "(missing)" check are untouched; a file whose time cannot be read is simply left without a date. Covers the
  generation model / Text Encoder / VAE / LoRA dropdowns in the global settings, the per-skill settings and the
  H3 video settings.

- **Model lists on the offline page read the kernel's extra model paths.** `extra_model_paths.yaml` is loaded
  by ComfyUI's `main.py` only, and the desktop process never ran that path: `folder_paths.get_filename_list`
  scanned nothing but `<root>/models/`, so on a machine whose models live in an extra path (this pack ships
  `base_path: F:\`, models under `F:\models\`) `GET /neo_image_gen/models` answered empty lists and every
  model path saved in a skill showed as "(missing)" — the red combo in the screenshot, with "Repair broken
  paths" left with no candidates to match. `build_app()` in `app/studio_server.py` now loads the root's yaml
  through ComfyUI's own `utils.extra_config.load_extra_path_config`, so the desktop service and the kernel it
  launches read the same model directories. Covered by
  `app/tests/test_studio_server.py::OfflineServiceTests::test_model_lists_see_extra_model_paths`.

- **Offline banner removed, and the flip it was hiding fixed.** The Studio offline page no longer draws a
  "ComfyUI not running" bar under the header: the header status pill already reports "● Stopped" and points the start
  entry at "Settings → Startup settings", generation entries stay dimmed by the capability gate, and `body.ns-offline`
  stays as the offline mark the shared modules read (`skill-writeback.js` gates the main-canvas handoff on it). The bar
  was also the visible symptom of a flip that never ran: the in-place flip was gated on `starting || userStarting`, and
  the desktop clears `starting` in the same snapshot that reports readiness (`_jump_when_ready` in
  `app/studio_app.py`), so a cold start where the desktop launched ComfyUI itself — nobody ever clicked "Start kernel" —
  showed "Running" in the pill while the page stayed pinned to the offline form and every generation request answered
  `409`. The flip is now gated on `ready` alone. `npm test`: 733 cases, including a new cold-start case that flips with
  no `comfy_start` call at all.

- The **素材库 / asset library** buttons inside the director editor now open the asset library on the Studio
  director page. They used to do nothing there: every button calls `toggleGallerySidebar()`, which only flips
  `extensionManager.sidebarTab.activeSidebarTabId`, and the Studio page runs on the `scripts/app.js` shim whose
  `sidebarTab` was a bare field with no sidebar behind it — the director page had no asset sidebar at all. The
  shim now forwards those writes through `onSidebarTabChange()`, and the director page answers them by
  **switching the left column from the recipe list to the asset library** (`.ns-director-lib`): the column widens
  to 380px through the grid, so the editor gives way instead of being covered by an overlay. The library is the
  same Neo Gallery the gallery page uses — `mountGallery(host)` moves the single gallery element between the
  gallery-page host and the left column, so breadcrumbs, directory navigation and the draggable cards all work in
  place, and a card drops straight onto the editor's first-frame / reference slots. Clicking the same button
  again, the library's ✕, or leaving the director page switches back and hands the gallery back to the gallery
  page. The ComfyUI canvas keeps using the real sidebar. Inside the left column the gallery toolbar sticks flush
  to the top of the column (host padding 0, toolbar uses the sidebar's own `-10px` negative margin), and the
  column scrollbar is transparent until the pointer enters the column, so it stops sitting there permanently.
  The left column and the editor are now separated by a **visible vertical divider that doubles as a drag
  handle**: drag it to resize the column (`←`/`→` to nudge, double-click restores the default width), the recipe
  list and the asset library each remember their own width in `localStorage["neo_studio_director_side_col"]`,
  and the divider disappears when a narrow window stacks the page vertically. Both splitters — this one and the
  editor / generation-panel one — are an 18px-wide grab zone with a 1px hairline that thickens to 4px and turns
  accent blue on hover, keyboard focus and while dragging (VSCode sash style); dragging also disables the
  grid transition so the resize tracks the pointer. The generation panel's result column (live preview / final
  film) now stretches with the height the splitter writes into `--ns-gen-h` — drag the panel taller and the
  preview grows, drag it shorter and it shrinks, instead of leaving a dead strip under a fixed 640×360 box.
  Tests: `studio/tests/js/studio-director.test.mjs`.
- Clicking a recipe card on the Studio director page now opens it. The click only used to select the recipe for
  the generation panel, so editing meant hunting for the small ✎ on the card. `createRecipesPanel` gains
  `openEditorOnSelect`: the same click selects the recipe **and** opens it in the embedded editor host, and the
  editor singleton turns a repeat click on the same card into a segment switch, so unsaved edits survive. A
  click that lands while an editor is still building is now ignored (`_directorOpening` covers the async media /
  skill scan, where the singleton state is not registered yet), so clicking through recipes never stacks two
  editors. The card's ✎, the timeline segment blocks and the gallery's "🎬 New director recipe" entry are
  unchanged; the placeholder hint now reads "Click a recipe card on the left to edit its film script here".
  Tests: `studio/tests/js/studio-director.test.mjs`.

- The Studio director page is now an inline editor. The tab used to stack the film generation panel above the
  recipe list and open the director editor as an overlay window on top of everything. It is now a
  **280px recipe list** in the left column plus a right main column: **director editor on top**, **generation
  panel on the bottom**, with a **draggable splitter** between them (drag to resize, double-click to collapse /
  expand the panel, `↑`/`↓` and `Enter` on the keyboard, height and collapsed state persisted in
  `localStorage["neo_studio_director_split"]`). `director.js` gains `setDirectorEditorHost(host, onOpen,
  onSaveAndRun)`:
  Studio registers the host and the editor lays out inside it (`.neo-director-embedded`, no overlay, no
  title-bar dragging, no ⛶ maximize, no resize handle); the ComfyUI canvas registers nothing, so the canvas
  keeps the overlay window. The embedded footer gains **🎬 Save & Generate Film**, which runs the full save path
  and then submits the film through the same builder as the panel's **🎬 Generate Film**
  (`submitGenerate()`). Docs: `docs/studio-desktop.md` / `docs/recipes.md` and the `docs/en/` mirrors.
  Tests: `studio/tests/js/studio-director.test.mjs`, `studio/tests/e2e/studio.e2e.mjs`.

- Closing the desktop window now always takes the ComfyUI it started with it. The teardown chain
  (`on_closing` → `close_out` → `comfy_close`) only runs when the desktop process reaches its own exit code, so
  Ctrl+C, "End task", signing out or a crash left ComfyUI on port 8188 as an orphan; the next desktop run found the
  port taken, attached (`self.comfy` is `None`) and from then on every close killed nothing — which reads as
  "closing the window no longer closes ComfyUI". The spawned ComfyUI is now assigned to a Job Object with
  `KILL_ON_JOB_CLOSE` inside `start_comfy()`, so the OS kills it (and its own children) when the desktop process
  dies, however it dies. `close_out()` kills the process before the "stopping ComfyUI" notice, since
  `evaluate_js` needs the UI thread back in its message loop and must not delay the kill. ComfyUI started by the
  user is still never touched. Tests: `app/tests/test_studio_desktop.py` (`ComfyJobTests`, real process + real job).

- "⤒ 主画布编辑" no longer opens a missing page during startup. The skill detail's main-canvas handoff opens
  `/?neo_wf_edit=<id>` on the current origin, and on the desktop offline page that origin is the read-only desktop
  service, which has no canvas page — clicking it while ComfyUI is starting only landed on "page not found".
  `openSkillWorkflowInMainUi()` now checks the run state the header pill already reports: "ComfyUI is starting… edit
  the main canvas once it is ready" while booting, "This feature needs ComfyUI · click “Start kernel” in Settings →
  Launcher Settings" when it is stopped. The handoff is unchanged on the ComfyUI page. Tests:
  `studio/tests/js/studio-starting.test.mjs`, `studio/tests/js/studio-offline.test.mjs`.

- Main canvas lock when ComfyUI is not running. The ComfyUI page is an SPA, so the canvas stays editable after the
  process stops and every edit lands on a backend that is gone. `studio/web/canvas-lock.js` reads the frontend's own
  connection events (`status` with no payload / `reconnecting` = backend gone, `reconnected` / a `status` payload =
  back) and confirms with a `/system_stats` probe before locking, so a websocket blip never locks the canvas. A
  confirmed loss applies the frontend's own canvas lock (`LGraphCanvas.read_only`, the same flag
  `Comfy.Canvas.Lock` uses) — panning keeps working, node dragging, resizing, widget editing and the right-click
  add-node menu stop — plus a bottom bar "🔒 ComfyUI 未运行 · 画布只读". Recovery unlocks and restores the lock
  state the user had set. Docs: `docs/studio-desktop.md` / `docs/en/studio-desktop.md`.

- UI language for the top-bar 🅝 menu and the Studio desktop app. `studio/web/js/core/i18n.js` translates with the
  Chinese source strings as dictionary keys, so a missing English entry falls back to Chinese instead of showing a
  key. The choice is stored in `localStorage["neo_studio_lang"]` and defaults to the browser language. The unified
  settings dialog gains a "🌐 Interface Language" tab, and the desktop settings page gains a "界面语言 / Language"
  tab that applies as soon as a language is picked; both reload the page, which is what rebuilds the labels in the
  new language. On the desktop side the app's own strings are translated (header and window controls, the
  director generation panel, launcher settings including the ⓘ notes, the status pill, the offline banner, the VRAM
  bar); the shared asset / skill views and the LLM / image / video forms keep their Chinese source text.
- Docs: split the Studio desktop out of the developer quick tour into `docs/studio-desktop.md` /
  `docs/en/studio-desktop.md`; the desktop module names in `docs/api-routes.md` and `docs/en/api-routes.md` follow the
  `app/` rename, and the
  install example uses `<ComfyUI root>` / `<data root>` placeholders instead of fixed drive paths. The MCP config
  snippets use the same placeholders, and `docs/en/api-routes.md` gets the MCP section the Chinese page already had.
- Naming: the desktop app stopped calling itself a "shell", which reads like a terminal shell. `StudioShell` →
  `StudioDesktop`, `ShellServer` → `DesktopServer`, `SHELL_PORT_OFFSET` → `DESKTOP_PORT_OFFSET`,
  `SHELL_LOG` → `DESKTOP_LOG`, `caps.owner()` answers `desktop`, and the desktop trace log is
  `data/studio_desktop.log` (an existing `data/studio_shell.log` is left where it is). Docs say 桌面端 / desktop
  throughout. Windows-owned names stay untouched: `shell32`, `WScript.Shell`, `IShellItem`, "PowerShell".
- MCP server for external agents. `studio/mcp_server.py` is a standalone stdio MCP server
  (JSON-RPC, standard library only, no relative imports, no ComfyUI node imports): an MCP client
  (Claude Desktop / Cursor / custom) launches it as a subprocess and the agent calls Neo Studio's
  image and director capabilities through 20 tools — status, skills, models, prompt expansion,
  image generation, task polling/cancel, output fetch (`get_media`: png images and mp4 films as `/view`
  URLs), gallery, recipes, and the director loop (recipes, spec, plan, copy, save, run, segment run, assemble
  run). Generation is async: submit returns a `task_id`, `task_status` polls it; director, segment and assembly
  outputs are mp4 videos. Segment numbers are 1-based for callers and converted
  to the endpoints' 0-based indices internally. The ComfyUI URL is loopback-only, `stdout` carries
  protocol only (logs go to `stderr`), no delete endpoints are exposed, the only writes are
  `rs_recipes/save` and `rs_recipes/copy`, outputs are returned as `/view` URLs with base64 opt-in for images,
  and `NEO_MCP_TOOLS` narrows the tool list. `tools\mcp_setup.ps1` prints the client config snippets;
  `--selftest` verifies the install. Docs: `docs/mcp.md` / `docs/en/mcp.md`.
- Fixed the desktop shell failing to open its window on machines where .NET Framework hosting is broken
  (`Failed to resolve Python.Runtime.Loader.Initialize`). The shell now bootstraps clr before
  `webview.start()` and, when netfx hosting fails, overrides `pythonnet`'s runtime with coreclr — pywebview's
  own coreclr fallback never engages because the netfx runtime object already occupies `pythonnet._RUNTIME`.
  coreclr needs the desktop runtime for `System.Windows.Forms`, so the bundle ships
  `tools/coreclr.runtimeconfig.json` (`Microsoft.WindowsDesktop.App`, `LatestMajor`) into `_internal/runtime/`.
  `release-app.yml` now builds on Python 3.12, matching the locally verified build.
- `.github/workflows/release-app.yml`: pushing a `v*` tag (or a manual dispatch) runs
  `tools\build_studio_exe.ps1` on `windows-latest` and attaches both distribution forms to that tag's
  GitHub Release — the onefile exe and the onedir build zipped whole (`mode` defaults to `both`) — so
  the recommended form now has a prebuilt download. Assets are unsigned; signing and notarization stay
  local (`-Sign` / `-Notarize`), and the Registry publish stays in `publish.yaml`. The README
  Installation entry for the portable app now points at Releases.
- English documentation mirror. `docs/en/` is a one-to-one English copy of every module doc; each English page
  links back to its Chinese original and each Chinese doc links to its English counterpart, and English pages only
  link to English pages. The root `README.md` (English) points at `docs/en/*` while `README_ZH.md` keeps pointing
  at the Chinese docs; the developer entry points are `Developer.md` (中文) and `Developer_EN.md` (English).
  `studio/README.md` is now English with `README_ZH.md` beside it, so the Registry package ships the
  English readme.
- Root `README.md` and `README_ZH.md` slimmed (225 → 165 and 285 → 232 lines). The Features / 模块一览 rows now
  link to the module doc that owns the detail, Installation leads with the desktop app and keeps the
  plugin routes collapsed, Quick Start is six short steps, the standalone-app section
  keeps the entry-point table plus the shell-behavior bullets, and the doc index table is replaced by a link to
  the docs index. The detail that moved out is not lost: the rebuild-after-change rule, the source sync and the
  window & taskbar icon are in `docs/release.md` / `docs/en/release.md`, and the two canvas screenshots now live
  in `prompts.md` (reference grid) and `h3-video-gen.md` (video nodes).
- Installation now leads with the **Neo Studio desktop app** (portable exe built by
  `tools\build_studio_exe.ps1`, and the source form `neo-studio-app.vbs` / `.bat`) and states that the
  app installs the plugin into `custom_nodes` by itself. The ComfyUI plugin routes (Manager, comfy CLI,
  clone, `install_plugin.ps1`, old-package upgrade note) moved into a collapsed `<details>` block, and
  Quick Start step 1 opens the app.
- The `nine_grid_storyboard` preset's `skill.md` no longer links to `../../docs/gallery.md`: `docs/` is not
  shipped in the Registry package, so that relative link was unreachable in every installed copy. It now names
  the gallery doc as plain text.
- The desktop shell syncs the plugin into `custom_nodes` by itself. Running from source (`neo-studio-app.vbs`)
  copies `studio/` over `ComfyUI/custom_nodes/comfyui-neo-studio` on every launch and before every
  "▶ Start kernel": same-name files only, files whose size and mtime already match are skipped, a file the
  running ComfyUI holds open is skipped and picked up on the next launch, and nothing in the target is ever
  deleted — user configs, the data-root pointer and installed dependencies stay put. Git checkouts are left
  alone; the exe keeps its version-gated bundled update.
- Studio header is status-only. `#ns-comfy-status` shows "● Running" / "● Stopped" / "● Starting" and keeps the
  port, the PID and who launched ComfyUI in the tooltip. The actions moved to the top of the shell-only
  `启动设置` tab: one state line plus "▶ Start kernel" (`▶ 启动内核`) and "■ Stop kernel" (`■ 停止内核`), the one
  that cannot run right now disabled. One `comfy_state` poll feeds both, so the header and the panel can no
  longer disagree, and a start that is already running is not spawned twice.

- Renamed Neo Nodes to Neo Studio. The Registry package is `comfyui-neo-studio` with `DisplayName` "Neo Studio";
  the plugin installs as `custom_nodes/comfyui-neo-studio` and every frontend asset URL is
  `/extensions/comfyui-neo-studio/...` — ComfyUI serves extension files under the install folder name, so the
  package name, the install folder and the URL literals have to be one spelling. Node class names and all route
  paths (`/neo-studio`, `/neo_studio/*`, `/neo_nodes/*`, `/neo_gallery/*`, …) are unchanged; only the node
  category label moved from `Neo-Nodes` to `Neo Studio`, so existing workflows keep loading.
  Upgraders need to delete `custom_nodes/ComfyUI-Neo-Nodes` before installing the new package: the package
  name changed, so Manager installs it next to the old folder and the same nodes register twice. User data
  lives outside the plugin directory, so removing the old folder touches no data.

- Packaging and publishing: `tools/install_plugin.ps1` installs the kernel plugin from source into
  `custom_nodes/comfyui-neo-studio` — code and built-in presets only, writes the `configs/data_root.json`
  pointer, and never deletes anything already in the target. `tools/build_studio_exe.ps1` gained `-Sign`
  (signtool via `-CertThumbprint` or `-Pfx`/`-PfxPass`, verified with `signtool verify /pa`), `-Notarize`
  (macOS `notarytool` + `stapler` + `spctl`) and `-Publish` (`comfy node publish`); all three are off by
  default, so a plain build is unchanged. Plugin dependency installs now pass `--no-warn-script-location`.
  `.github/workflows/publish.yaml` now runs `comfy node publish` inside `studio/` itself: the shared
  `comfy-org/publish-node-action` only publishes the repository root, and the root `pyproject.toml` is the
  desktop shell's own manifest, not the Registry package.

- Neo Studio desktop shell: `neo-studio-app.vbs` opens the Studio page in a WebView2 window with no console
  window (`neo_studio_app.py`, optional `pywebview` extra); the shell runs under `pythonw`, its startup trace
  goes to `tmp/studio_shell.log` (which also keeps the pywebview logger off the missing `stderr` that aborts
  window creation); messages go to a system dialog, ComfyUI is spawned
  without a child console, window geometry is persisted in `configs/studio_window.json` (a position saved while the window was minimized
  is off-screen and is dropped, so the window is not restored invisible), Studio `localStorage`
  survives restarts, links navigate inside the shell window (`OPEN_EXTERNAL_LINKS_IN_BROWSER = False`, so the
  skill canvas handoff and the top-menu Studio link stay in-window), blob downloads are allowed, and a second launch
  exits instead of opening a second window. The window is created before any startup work: the dependency
  self-check, the shell-side read-only service and the ComfyUI spawn run on a background thread, and the window
  is pointed at the offline gallery (full Studio when ComfyUI already answers, first-setup page when the root
  and interpreter are unresolved) once they finish — the window appears immediately instead of after the
  cold-start wait, and a window closed exactly while the shell is spawning ComfyUI closes that process
  immediately instead of leaving an orphan kernel. The shell is a launcher: closing the window saves geometry only and leaves
  ComfyUI running. The shell `js_api` methods `comfy_state` / `comfy_stop` / `comfy_start` are polled every 5s
  and shared by the header status and the `启动设置` kernel controls: stopping goes through `terminate()`, then
  `port_owner()` + `kill_pid()` repeated until nobody listens — `kill_pid()` needs `PROCESS_TERMINATE` and an
  explicit `OpenProcess` restype, otherwise the 64-bit handle is truncated and nothing is killed. Starting the
  kernel from the offline page reloads nothing — the shell jumps the whole window back to the full Studio once
  the port answers. The header status stays hidden in a browser tab (no `pywebview.api`).
  The window and taskbar icon is the clapperboard `web/neo-studio.ico` (`tools/make_studio_icon.py`), passed to
  `webview.start(icon=...)` with an explicit `AppUserModelID` so the taskbar button is not merged into the generic
  Python icon that `pythonw` falls back to. `tools/build_studio_exe.ps1` packages the shell with an embedded
  icon, so Explorer and shortcuts show it too, in two distribution forms: `-Mode onefile` (default) emits the
  single-file `tools/neo-studio.exe`, `-Mode onedir` emits the folder build `tools/neo-studio/Neo-Studio.exe`
  that skips the startup unpacking (window ~0.7s sooner), `-Mode both` emits both. Under a frozen build
  `resolve_root()` walks up from the exe's own location, so the window geometry, browser profile and logs stay
  in the shell state dir next to the exe (`data/`, `%APPDATA%/Neo Studio` when that folder is not writable).
  The exe is a local build artifact (`pyinstaller` is a build-time dep, not in
  `requirements.txt`) and never ships in the Registry; `neo-studio-app.vbs` stays the plugin entry point.
- Portable launcher settings: a `启动设置` tab (Studio view `launcher`) served by the shell-side
  `/neo_studio/launcher` route — GET reads the snapshot, POST runs the shell's `apply_launcher` /
  `install_plugin` / `install_deps`, the two path rows' browse buttons call the `js_api` methods `pick_root` /
  `pick_python` — so it works in
  the desktop shell only, and the tab stays hidden in a browser tab. It edits the ComfyUI root, the python
  interpreter and the port, validates them server-side (a root without `main.py` is rejected instead of launching a
  kernel that cannot start) and persists them to `launcher_config.json` in the shell state dir, which falls back to
  `%APPDATA%/NeoStudio` when the plugin folder is not writable. `tools/build_studio_exe.ps1` now embeds a copy of
  the plugin (`git ls-files -z` minus dev-only dirs, so user configs and API keys never ship) under
  `_MEIPASS/bundled/comfyui-neo-studio`; `ensure_plugin()` installs it into `custom_nodes` when the plugin is
  missing, requirements included. The tab shows the self-check state
  (ok / bad root / missing python / missing dependencies / plugin install failed), with `安装依赖` when the
  target python lacks the plugin dependencies and `重试安装插件` when the bundled copy could not be installed.
- First-run setup page: when the ComfyUI root cannot be inferred (or has no `main.py`), or no `python.exe` is
  found next to the root, the window opens on a `guide_html` page built with `load_html` + `js_api` instead of
  exiting. The shell-side service cannot be assembled without a valid root (`build_app` imports `folder_paths`
  from it), so this page must not depend on HTTP: it prefills whatever was auto-detected, validates live through
  `check_setup`, takes values from the native `pick_root` / `pick_python` dialogs, and `start_setup` starts the
  shell service and reuses `apply_launcher` to save and launch. Auto-detection that succeeds goes straight to
  Studio as before, and the pre-window root picker is gone. `start_setup` runs the same self-check as a normal
  start, so a root whose `custom_nodes` has no plugin gets the bundled copy installed before the shell service is
  assembled — pointing the service at the missing folder used to fail assembly with `FileNotFoundError` and leave
  only "service won't start" on the page. Empty path input no longer resolves to the relative `.`, which counts as
  a valid root when the shell runs from inside the ComfyUI folder.
- Launcher tab in the full Studio page: the `启动设置` panel now reads and writes through the shell `js_api`
  (`launcher_state` / `apply_launcher` / `install_plugin` / `install_deps`) instead of only the shell-side
  `/neo_studio/launcher` route. That route is same-origin only on the shell service, so the tab used to vanish as
  soon as ComfyUI was ready and the window jumped to the ComfyUI port. It stays hidden in a browser tab (no
  bridge, no route). The bundled plugin copy now keeps `pyproject.toml`, so a plugin the exe installed reports
  its version instead of `Neo Studio unknown`.
- Bundled plugin update: `ensure_plugin()` now compares the bundled `pyproject.toml` version with the installed
  copy's and replaces it when the bundled release is newer. The new copy is assembled in the shell state dir first,
  the user data dirs (`configs/`, `data/`, `gallery/`, `locals/`, `prompts/`, `recipes/`, `skills/`, `tmp/`) are
  merged into it, and only then is the installed folder swapped out — a locked folder (ComfyUI running) fails the
  swap and keeps the old copy for the next launch. An installed copy without a version counts as oldest, so an
  install from an older exe gets the version file. Source (dev) runs and git checkouts are never overwritten.

- Shell-embedded read-only gallery service (`neo_studio_server.py`, ComfyUI port + 3): the gallery modules now
  carry their own `web.RouteTableDef` and `__init__.py` mounts them into `PromptServer.instance.routes`, so the
  same browsing handlers run with no ComfyUI runtime — the shell serves `/neo-studio`, the extension static files,
  the read-only gallery subset (`list` / `subdirs` / `thumbnail` / `image` / `video` / `audio` / `waveform` /
  `media_meta` / `css` / `get_settings` / `lora_dirs` / `dir_cover_images`), `userdata/neo_gallery_data.json`
  (atomic write) and a `/ws` stub, and answers every write or generation route with `409 {"offline": true}`.
  The window opens on that offline library at startup, jumps to the full Studio when ComfyUI is ready, and is
  pulled back when ComfyUI stops; Studio shows a "ComfyUI not running" banner, hides the VRAM panel, and the
  restart button on the offline banner leaves the jump to the shell instead of reloading the offline page. `Neo-Studio.spec` now
  `collect_all`s `aiohttp` and `PIL` so the packaged exe keeps browsing offline.

- Studio header title is a link back to the main canvas (`<a class="ns-logo" href="/">`), and the shell injects a
  floating "🎬 返回 Studio" pill on every non-Studio page load, so returning from the full-page main canvas reload
  works in the same window. `/neo-studio` is served with `Cache-Control: no-cache` so shell header edits reach the
  window. The shell `js_api` carries only `url` and the `load_url` bound method: holding the pywebview window object
  makes `create_proxy` recurse through `window.native.AccessibilityObject...` and blow the stack.
- Fixed the plugin package failing to import in ComfyUI: `__init__.py` read `gallery.gallery_lora`, but a submodule
  attribute lands on the parent package, so the import died on `AttributeError` and every `/neo_*` route and node
  disappeared silently — the shell then never detected a ready ComfyUI and kept respawning it.
- The shell spawns ComfyUI with `CREATE_NO_WINDOW` and now redirects its output to `tmp/comfy_run.log`: without the
  redirect a failed startup left no trace anywhere. When 8188 is held by a leftover process it picks a free port
  (`free_comfy_port`, skipping the shell's own service port) instead of spawning an instance that dies on the
  port conflict.
- Studio Settings gains a Log tab (`GET /neo_studio/log` reads the `app.logger` ring buffer), so the ComfyUI
  console is visible without a console window. The panel fills the main area, and auto-scrolls only while pinned
  to the bottom, so scrolling up to read survives the 2s poll.
- Skills support video and audio reference slots.
- Qwen Image 2.1 pose editing with ControlNet.
- Skill manager: `workflow.json` is edited directly in the canvas; preset writeback through overrides with auto-copy; workflow skills are excluded from prompt enhancement; skill detail UI reworked.
- Canvas import maps control refs and pins reference loaders.
- Skill manager search box stays open under IME input and closes via ✕.
- README rewritten: hero demo, zero-config section, feature highlights; gallery screenshots compressed.
- README default language is now English: `README.md` is the English doc, the Chinese text lives in `README_ZH.md`.
  The standalone-app section is condensed to the user-facing facts; shell internals stay in `Developer.md`.
- Plugin source directory renamed `kernel-plugin/` to `studio/`. The Registry package name, the installed
  `custom_nodes/comfyui-neo-studio` directory, node names and the data root are untouched; only repo paths,
  tooling and docs moved. `conftest.py` keeps a placeholder `studio` package so pytest collection no longer
  runs the plugin entry point.
- Repo root `__init__.py` entry for the git-clone install form: cloning the repo straight into
  `custom_nodes/comfyui-neo-studio` registers through `studio/` again. It only registers when loaded from
  `custom_nodes`, so tooling that imports the repo root as a package stays inert.
- Repository renamed `ComfyUI-Neo-Nodes` → `neo-studio`; the app history merged onto the plugin history so
  `v1.0.0`..`v1.2.0` are ancestors of `main`. All `github.com/neoneo-ai` links point at the new name.
- Skill canvas import no longer pins a persistent writeback toast in the top-right corner. The pending skill is
  signalled by the green dot on the 🅝 button, and "💾 Write back to skill" in the 🅝 menu is the only entry that
  writes the canvas back.

## [1.2.0] - 2026-10-08

- **Native LLM provider**: safetensors text-generation models (e.g. Qwen3.5 BF16) run inside the ComfyUI process with no extra dependency; models auto-unload to free VRAM on switch and unload.
- **Model Hub**: Comfy-Org hub with dual-source (ModelScope / Hugging Face) search, ModelScope subfolder support, Civitai downloads, bookmark pagination.
- **Gallery**: LoRA safetensors metadata badges with refresh, image lightbox, stable outpaint ratio presets.
- **Skill manager**: embedded litegraph workflow editor, writeback preview with local history, canvas↔skill config sync, flowchart layout for imported skill workflows.
- **Image Gen & Edit**: `max_refs` config with auto-grow reference slots; Qwen Image 2.1 identity-swap preset.
- **Registry and metadata**: `.comfyignore`, Registry metadata, node manifest and version banner at plugin load, node search aliases, tooltips, metadata contract test.
- Cancellable LoRA directory tagging with tag formatting; top-menu behavior and node placement refined; workflow repair skips unhashable widget heads.

## [1.1.0] - 2026-10-04

- Qwen Image 2.1 outpaint mode; masked local edit with crop and feathering; SAM3 mask feathering.
- Skill workflow import/export with update endpoint; skill manager UI refresh.
- Batch LoRA tagging in the gallery (missing LoRA directories are skipped); Backyard gallery preprocessing with OSS upload.
- Outpaint pipeline aligned with the reference workflow (1MP / 1.5MP scaling); removal prompt prefill contract in the image edit dialog.
- English README added; vendored Krea2 edit node registration and quadview LoRA handling removed.

## [1.0.1] - 2026-10-02

- Manual publish flow documented; version bumped for the first Registry release.

## [1.0.0] - 2026-10-02

- Initial release: Neo Prompt Encoder, Neo Prompt Agent, Neo Image Gen & Edit, H3 Video Director with director recipes, Neo Gallery with bookmarks, Neo Reference Grid, Neo Grid Split, Neo Bundle Expand, workflow repair, skill presets, and Neo Studio.
