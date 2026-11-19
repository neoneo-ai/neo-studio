# Prompt Library

The 「提示词库」 card in the Studio home 「Assets & Setup」 section opens `#/prompts`
(`studio/web/prompt-library/prompt-library.js`). The header has no tab for it: that home card is the only
way in, and removing the card from the home layout (adding it back in "add card") removes access to the page.
One prompt per card: its cover when it has one, then the prompt's own body preview and tag chips, with the
origin and the actions on the card's bottom row. The grid shows 24 cards per page and the page bar stays
pinned to the bottom of the page.

## What the page looks like

1. **Title row and filter row**: the title row carries the page name, the entry count and reload; the filter
   row carries the search box (matches the display name and tags), the image/video pool filter
   (`All / Image / Video`; the pool comes from the scan name's first segment, the same rule the prompt picker
   uses) and the origin filter (`All origins / Presets / Custom`). Sorting is fixed to "newest first", using the
   file time each list entry carries.
2. **Card**: the cover band — an `<img>` only when the entry carries `cover`, `loading="lazy"`, its URL built by
   `promptCoverUrl(name, v)` where `v` is exactly the cover mtime on that entry; the title row (display name plus
   two badges: preset / custom, image / video); the body-preview block (the first 220 characters of that prompt
   collapsed onto one line, monospace on a raised fill — when it cannot be read the block collapses entirely and
   the card never says "read failed"); up to three tag chips; and the bottom row (origin and "how long ago" on
   the left, the actions on the right).
3. **Pagination**: 24 cards per page, the page bar pinned to the bottom of the page — the edge arrows honour the
   bounds and "第 N / M 页" is the readout. Body previews go out once per page as
   `POST /rs_prompts/prompt_previews`, at most 32 names per call, cached per page under "scan name + file time"
   and refetched only when reloading the list changes that file time.
4. **Card actions**: "fill the paint page", "fill the video page", "copy", "set as cover", "delete". Preset cards
   only carry the first three — the preset tree is a code directory, so the UI never ships a button that must fail.
5. **Filling a page**: the full text is read by scan name first (`POST /rs_prompts/load_prompt`), then handed to
   the assembly layer's existing chain `applyToPage(mode, text)` — `paint` switches to the paint page and fills its
   prompt box, `video` goes through the video page's reuse fill; it is the same landing the enhance page uses for
   its reply. An empty body reports "This prompt is empty" and sends nothing.
6. **Set as cover**: opens the host's asset pick modal (one pick and it closes); which kind it accepts follows the
   current pool — the image pool takes images, the video pool takes videos (the backend takes the first frame).
   The pick is sent as `{name, filename, subfolder}` to `POST /rs_prompts/set_prompt_cover`; on success the list
   reloads, so the card and its new cover swap together.
7. **Delete takes two presses**: the first only rewrites that button to "Confirm delete" and re-titles it
   "press again to delete this prompt and its cover"; the second sends `POST /rs_prompts/delete_prompt`. Redrawing
   the grid disarms, so an armed press never rides over onto another card.

## The cover itself

- A cover is the sidecar next to the text: `prompts/custom/<scan name>.jpg`, written as a 512 px longest-side
  JPEG (first frame for video). There is no thumbnail cache directory to clear.
- Only the press the user names writes it: "set as prompt cover" in the gallery card's ⋯ menu (which first names
  the prompt to receive it) and "set as cover" on this page's card. Nothing generates covers, nothing batch-applies them.
- The preset tree is a read-only code directory: the write side answers 403 ("Factory presets carry no covers") and
  the UI ships neither of those two buttons there.
- The read side `GET /rs_prompts/prompt_cover?name=&v=` answers that JPEG directly with
  `Cache-Control: public, max-age=31536000, immutable`; a name with no cover is 404 and the card takes the text slot.
- Deleting the text deletes its cover (`delete_prompt` clears the `.jpg` in the same pass), so the prompt tree never
  keeps a cover without a prompt.

## The offline window

The seven read-side routes (`list_prompts` / `list_prompt_names` / `load_prompt` / `prompt_previews` /
`list_prompt_lines` / `random_prompts` / `prompt_cover`) are all in the desktop capability table — `_PROMPTS` in
`app/studio_caps.py` — so an offline window answers the list, the covers and the body previews. The two write
routes (`set_prompt_cover` / `delete_prompt`)
are not in the table; on the capability table they are the `prompt_library_write` flag: offline, those two buttons
go to the run gate and pressing one starts the kernel instead of firing a request that can only 409.

## Landing and test cases

- One registry descriptor (`prompts` in `app-registry.js`, section `material`, icon `list`) derives the home card
  (named in `home-layout.js`) and the route; the page's build is named in `PAGE_BUILDERS` in `studio-app.js`, its
  factory lives in `studio/web/studio/pages/leaf-pages.js`, and the skill landing list (`SKILL_LANDINGS` in
  `studio/skill.py`) accepts the same name — `studio/tests/js/app-registry.test.mjs` pins those places onto one table.
- Styles: `studio/web/prompt-library/prompt-library.css`, colors taken only from the `--ns-*` variables in
  `studio/style.css`.
- Cases: `studio/tests/js/prompt-library.test.mjs` (cards and covers, body previews, pagination, filters, filling a
  page, setting a cover, two-press delete, the offline state), `studio/tests/js/preset-picker.test.mjs` (the
  picker's thumbnail slot), `studio/tests/test_prompt_covers.py` (sidecar write / read / delete, 403 on presets,
  404 on a missing source, traversal names), `studio/tests/test_prompts_tags_scan.py` (the preview collapses onto
  one line, truncates, and drops names without a body).

The prompt pools and the node-side chain: [prompts.md](prompts.md); route by route: [api-routes.md](api-routes.md).
