# Prompt Enhance

> 🇨🇳 中文: [../studio-prompt-enhance.md](../studio-prompt-enhance.md)

The "提示词增强" card in the **Create** section of the Studio home opens `#/enhance`
(`studio/web/prompt-enhance/prompt-enhance.js`). The top bar has no tab for it: that home card is the only way in, and
removing the card on the home page closes the page off (add it back from Add a card). The page is one chat stage — the
run's input is a bubble on the right, the model's reply is a bubble on the left, and the composer is pinned to the
bottom edge with the paint page's flat card — a translucent dark fill with a light border, no drop shadow.
The 图像 / 视频 switch in the top-right corner is the page's own scope: the skill list shows only that family's enhance
skills, and picking a prompt, the dice and saving a preset all land in that pool
(`localStorage["rs.enhance.media"]`, image by default).
An empty stage carries one start hint in the middle (`.ns-enhance-guide`, sized and colored by the shared
`.neo-gallery-gm-idle` the paint and video pages use): a large 写一句，点增强 line with one short note under it. It hides
when the first bubble lands, returns to the middle after 新增会话 clears the stage, and clicking it focuses the input box.
The hint carries no second set of controls - drawing a prompt, picking a reference and choosing the skill all stay on the
composer below.

## The shape of a run

1. **Write a line, paste a prompt**: the main box is the page's only chat input — write the scene description or paste
   an existing prompt in, Enter sends and Shift+Enter adds a line break. The dice half appends a random prompt after
   what is already written (`joinPromptText`'s separator).
2. **Reference images**: the same `＋参考` slot row with the hover pick menu the edit page uses (the
   `.neo-gallery-edit-refdrop` family in `gallery.css` — one copy of that styling for both pages), up to 4 of them
   (`MAX_ENHANCE_REFS` = `MAX_REF_IMAGES` in `studio/llm.py`). Clicking an empty slot runs 素材库取用 (the asset-library
   modal); hovering the row floats the menu out — a 参考图 N/4 header, ⬆ 本地上传 (several local files at once) and
   🖼 素材库取用 — with a 250 ms close grace so the cursor crosses the 6 px gap and hits an item. Local files and gallery
   cards drop straight onto a slot, pasting works too, the ✕ on a tile removes that image and the rest close up, and
   video/audio never enter a slot (a full row reports the cap). The chip row has no 上传图片 button — local upload lives
   in the menu. A library pick goes out as `{kind:"input", value:"<relative name>[output]"}`, a local upload or paste
   as `{kind:"data", data:<data URI>}`.
3. **Skill**: the list carries only the current pool's category — `image_enhance` in image mode, `video_enhance` in video
   mode; skills with a `workflow.json` and `gen_image` skills are not listed here, they belong to the generation chain.
   In image mode the top chip entry is "智能判断" — an empty value, so the body carries no `skillId` and the backend picks
   reverse-prompting when images come along and the default enhance task otherwise. Video mode has no such entry: an empty
   `skillId` is image-side only in `studio/llm.py`, so the list lands on the first video skill and the chip names it, and
   with no video enhance skill available 增强 explains that a skill has to be created under the 视频提示词增强 category
   instead of sending a run that cannot work.
4. **Thinking depth**: `off` sends `enable_thinking:false`; `low / medium / high` send `reasoning_effort` (`high` is the
   template's `xhigh` step, mapped by `THINKING_EFFORTS` in `prompt-service.js`). The setting is stored under
   `localStorage["rs.thinking_depth"]` — the same key the NeoPromptAgent node uses.
5. **Fill the box**: the split button in the top-right corner — 提示词 opens the prompt library and fills the box, the
   dice half appends a random prompt after what is already written. Which pool they read is the mode: `preset-picker.js`'s
   `kind` is the same rule the prompt-management page's 图像 / 视频 tabs use (a scan name whose first segment is `video/`
   is a video prompt), and 保存为预设 writes into that same pool (a video run is stored under the `video/` prefix).
6. **The reply**: nothing is boxed — the reply bubble carries no shell and the text itself is not a bordered box; the
   meta line, the one-line status, the text and the 复制 / 存预设 row sit directly on the stage. The text grows as tall as
   it needs (`field-sizing: content`, scrolling inside after 40vh, 12px); thinking and pipeline status are a single dim
   line above it — `createStreamOutputHandlers` is given a `lineEl` — the reasoning text never reaches the screen, and the
   line clears when the text starts and when the stream ends. A `replace` frame swaps the text that was already streamed.
   The NeoPromptAgent node panel and the skill-execution dialog keep the `.rs-thinking` panel (no `lineEl`, the old behavior).
7. **The conversation**: each run's input and its landed reply stay in the page's own closure (`{role, text, refs}`),
   and the next run puts them in front of the text it sends — the enhance chain is single-turn
   (`studio/llm.py` builds a `[system, user]` message pair), so history travels as body text and the request shape
   stays as it was. Only the latest 8 exchanges (16 entries, `HISTORY_PAIRS * 2`) go, each trimmed to `HISTORY_CHAR_CAP`
   (4000) characters; reference images are a one-line "（附 N 张参考图）" note in history, the image bytes travel with the
   current run only. The reply's meta line says how much was attached ("带 N 条历史"), and an empty reply is not kept.
   新增会话 drops a stream in flight, clears the stage and the conversation and the status line, and leaves the input
   draft alone; the conversation is not persisted, and it is still there after switching pages.
8. **Stop / copy / save**: while a run streams, the 增强 button *is* 停止 — pressing it aborts the stream, voids that
   run's late frames, and pushes what already landed into the conversation together with its input; the button returns
   to 增强 and never goes grey. Once the text lands (done, failed or stopped) the reply shows its two icon buttons —
   复制提示词 and 保存为预设, with the words in the tooltip and no name field on the page: the title comes from the
   text through the backend (`/rs_prompts/extract_title`), and when that call gives none the first line of the text is
   used. What gets saved is that reply's text, and a reply that produced nothing shows no buttons at all.

With neither a description nor a reference image the page sends nothing and leaves no bubble on the stage. When the
backend writes a failure into the stream (an `[ERROR]` frame), the status line shows the backend's own reason: a picked
skill comes with a "查看技能详情" action, and with no skill picked the action opens the LLM settings.

## Offline

The whole chain only touches the skill files in the data root (`GET /rs_prompts/skills`), the 8080 / remote-LLM stream
(`POST /rs_prompts/stream_generate_prompt`) and reference images under `input/`, so the desktop window enhances with
ComfyUI stopped (`prompt_enhance` in `app/studio_caps.py` is a desktop-side route). Only 保存为预设 is the prompt-library
write side: `prompt_library_write` is not in the desktop table, so the offline window labels that button "需要 ComfyUI" and
clicking it hands the desktop app the job of starting the kernel — the gate sits before the title call, so the page
never sends a write request that can only answer 409.
