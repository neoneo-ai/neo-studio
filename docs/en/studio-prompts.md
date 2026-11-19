# Prompt Library

The 「提示词库」 card in the Studio home 「Assets & Setup」 section opens `#/prompts`
(`studio/web/prompt-library/prompt-library.js`). The header has no tab for it: that home card is the only
way in, and removing the card from the home layout (adding it back in "add card") removes access to the page.
One prompt per card: its image when it has one — the cover sidecar next to the text wins, and a shipped preset with no
sidecar takes its cloud directory's cover — then the prompt's own body preview and tag chips, with the
origin and the actions on the card's bottom row. The grid shows 24 cards per page and the page bar stays
pinned to the bottom of the page.

## What the page looks like

1. **Title row and filter row**: the title row carries the page name, the entry count and reload; the filter
   row carries the search box (matches the full scan name, directory segment included, plus tags), the image/video pool filter
   (`All / Image / Video`; the pool comes from the scan name's first segment, the same rule the prompt picker
   uses) and the origin filter (`All origins / Presets / Custom`). Sorting is fixed to "newest first", using the
   file time each list entry carries.
2. **Card**: the image band takes one picture in the order "cloud image media → cover sidecar → cloud directory
   cover" — the media and the directory cover both come from `cloudDirCoverUrl` (the thumbnail proxy), the sidecar
   from `promptCoverUrl(name, v)` where `v` is exactly its mtime on the entry, and every `<img>` is `loading="lazy"`;
   a video-pool card paired with its cloud media plays the 480p silent preview in this band instead — see
   "The cloud preview" and "The cloud directory cover". Then the title row (the name alone, without its directory
   segment — the pool chips sit on top of this page, so repeating the directory in the title buys nothing; the full scan
   name lives in the card's hover title, and search keeps matching the full name with that segment, plus two badges:
   preset / custom, image / video); the body-preview block (the first 220 characters of that prompt
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
6. **Set as cover**: opens the host's asset pick modal (one pick and it closes) with the asset search box prefilled
   with this prompt's first text line — the sidecar's first line is the prompt that generated the asset, so the modal
   lands on the outputs made with it, and clearing that box is what browses everything. Which kind it accepts follows
   the current pool — the image pool takes images, the video pool takes videos (the backend takes the first frame).
   The pick is sent as `{name, filename, subfolder}` to `POST /rs_prompts/set_prompt_cover`; on success the list
   reloads, so the card and its new cover swap together. When the text cannot be read the modal never opens and the
   toast says "Failed to set the cover".
7. **Delete takes two presses**: the first only rewrites that button to "Confirm delete" and re-titles it
   "press again to delete this prompt and its cover"; the second sends `POST /rs_prompts/delete_prompt`. Redrawing
   the grid disarms, so an armed press never rides over onto another card.

## The cover itself

- A cover is the sidecar next to the text: `prompts/custom/<scan name>.jpg`, written as a 512 px longest-side
  JPEG (first frame for video). There is no thumbnail cache directory to clear.
- Only the press the user names writes it: "set as prompt cover" in the gallery card's ⋯ menu (which first names
  the prompt to receive it) and "set as cover" on this page's card. Nothing generates covers, nothing batch-applies them.
- The preset tree is a read-only code directory: the write side answers 403 ("Factory presets carry no covers") and
  the UI ships neither of those two buttons there. Shipped presets carry no cover sidecar; an entry whose pool name is
  a cloud directory takes that directory's cover (see "The cloud directory cover") and the rest carry no image band,
  landing on the name and the body preview, and imported prompts never enter the preset tree at all (the section
  below); a user cover never lands there.
- The read side `GET /rs_prompts/prompt_cover?name=&v=` serves that JPEG through `FileResponse` with
  `Cache-Control: public, max-age=0, must-revalidate`: every page open sends a conditional request, the response carries
  `Last-Modified`, and an unchanged file answers 304. The one-year `immutable` is not sent — it pins a single failed
  response (the ComfyUI restart window) to that cover URL, after which a hard reload issues no request and the card
  stays blank forever. A name with no cover is 404 and the card carries no image band — name and body preview only.
  When the image fails to load the card retries once under a new cache key (a fresh query parameter forces a real
  request), and when that fails too the band is dropped, leaving a 150px empty block out of the card.
- Deleting the text deletes its cover (`delete_prompt` clears the `.jpg` in the same pass), so the prompt tree never
  keeps a cover without a prompt.

## The cloud preview

- A video prompt of a cloud preset directory plays the 480p silent preview that `--preview` published, in that same
  band: the cover sidecar is the `poster`, the element is `muted / loop / playsinline / preload="none"`, and the `src`
  is attached by an IntersectionObserver only when the card enters the viewport; leaving the viewport pauses it.
- Pairing keys on the first body line: the local body's first line must equal the `提示词：` first line stored for that
  item in the cloud directory index — an index preview truncated at 500 characters pairs on that prefix — and an
  imported body with no `提示词：` label pairs on its own first line. A body that still matches more than one item
  falls back to the filename: the pool entry's name and the published filename agree once the ordinal and
  punctuation are dropped, with a truncated cloud name matching on its prefix. Two matches on both routes pin
  nothing. No OSS config, a directory index never cached on this machine, and an unpaired body all leave the card
  on its cover, and pairing never touches the network.
- The image band in that order: the cloud image media, then the cover sidecar beside the text, then the cloud
  directory cover (`dir_cover`). Image media shows the real cloud image through the 512 px thumbnail proxy, so the
  typeset placeholder sidecar in the pool gives way; a paired video still plays the 480p preview with the sidecar
  as its poster.
- The preview band takes only that entry's cover sidecar as its `poster`: an entry carrying just the cloud directory
  cover (`dir_cover`) shows that cover as the card image and plays no preview.
- The URL is `GET /neo_gallery/video?filename=&subfolder=&preview=1`: the preview downloads from
  `neo/presets/previews/<dir>/` into `gallery/oss_cache/previews/<dir>/`, and every later play reads that cache
  (`Cache-Control: public, max-age=86400`). The same route without `preview` serves the original into
  `oss_cache/<dir>/`, and the material page lightbox keeps playing the original.
- In the offline window this request answers 409 and the card stays on its poster; when the system asks to
  "reduce motion" (`prefers-reduced-motion`), no preview video is built at all.

## The cloud directory cover

- A shipped preset pool ships `.txt` only, and its pool name is the cloud directory name it was published under:
  `list_prompts` gives such an entry a `dir_cover` key (`{filename, subfolder}`) and the card takes its image from
  there. An entry that already carries a cover sidecar, one that paired with a cloud item (`media`), and any entry
  nested in a subdirectory (`video/<dir>/<item>`) never carry it — that band belongs to the sidecar and to the media.
- The candidate is the first entry of that directory's `covers` in the master index that has a thumbnail, in publish
  order (an audio item is a decorative waveform tile on the material page, so it has no image to show). It reads the
  index cache on disk only, never touches the network, and a directory with no candidate leaves the card with no image
  band — the name and the body preview stay.
- The URL is `GET /neo_gallery/thumbnail?filename=&subfolder=&size=512`: `filename` is that media's own name, and its
  index `thumbnail` downloads from `neo/presets/thumbnails/<dir>/` into `gallery/oss_cache/thumbnails/<dir>/`, and
  every later read takes that cache (`Cache-Control: public, max-age=86400`).
- In the offline window this request answers 409 and the card drops the image band, keeping the name and the body preview.

## The cover backfill script

With a shelf full of outputs there is no need to pick one card at a time: the data-initialization
script `tools/fill_prompt_covers.py` matches media back onto the prompts — the same-name `.txt`
sidecar next to an image and the ComfyUI metadata embedded in an image or video both carry the
prompt line. The script takes a whole-line match as "this is what generated it" and writes the
sidecar for every custom prompt left without a cover, on the same rule as above (a JPEG with a
512px long side, a video gives its first frame). The default is a report; `--apply` is what writes.
Prompts that already have a cover are left alone and `--overwrite` rewrites them. Image prompts
take images only, entries under `video/` take videos only, and a body whose first line is too
short has no discriminating power, so it is skipped. `--loose` also counts "the first line appears
inside the metadata text" — a multi-segment film stores the whole body, where a whole-line match
cannot land. The scanned roots are ComfyUI's `output` and the data root's `gallery/custom` by
default, with `--output-dir` to add more and `--limit` to try a small batch first.

```powershell
python tools/fill_prompt_covers.py                              # report only
python tools/fill_prompt_covers.py --apply                      # write the missing covers
python tools/fill_prompt_covers.py "<ComfyUI root>" --loose     # a media root, looser matching
python tools/fill_prompt_covers.py --apply --loose --limit 20   # a small batch first
```

The preset pool is code: the script scans `prompts/custom` only, the same boundary the write side
keeps, so shipped files are never backfilled.

## Imported prompts ship as cloud presets (prompts.chat)

The prompt text on prompts.chat is CC0 1.0 public-domain data — its LICENSE puts the prompt content and data in the
public domain and the site code under MIT — so the body travels verbatim. The `mediaUrl` each entry carries is not in
that wording: it is an example output uploaded by a site author, hosted off-site on third parties (DigitalOcean Spaces,
pbs.twimg.com, wiro.ai, fal.media). `tools/import_prompts_chat.py` therefore builds a **gallery preset build directory**
and writes no file into the code tree: `--build` drops the `IMAGE` / `VIDEO` rows, in upvotes order, into
`tmp/gallery_pack/prompts.chat/` (inside `.gitignore`), one stem per row with a pair of files — `NN_<name>.<media>` plus
the same-stem `.txt` sidecar written in the gallery "label: value" layout (the first two lines are the title and the
body; the card preview reads exactly those, the lightbox reads the full text through `/neo_gallery/txt`).

The media slot is the site's own example output first; a row that will not download, whose type is not recognized, or
that exceeds 24 MB falls back to a locally typeset preview, and a row with no `mediaUrl` gets a preview for the same
reason — `gallery_preprocess.py` skips entries that are `.txt` only, and a cloud card with no media slot is not a card.
The preview's base color comes from the title's sha256, a rerun yields the same bytes, and since it is no real output it
lives on OSS only.

Uploading runs the same chain as the material presets ([gallery.md](gallery.md)):

```powershell
python tools/import_prompts_chat.py --top 20 --pages 2 --build --out tmp\gallery_pack
python tools/gallery_preprocess.py --presets tmp\gallery_pack --output tmp\gallery_pack --dirs prompts.chat --tag prompts-chat --preview
python tools/gallery_deploy_oss.py --source tmp\gallery_pack --bucket <bucket> --prefix neo/presets/ --endpoint <endpoint>   # check --dry-run first
```

`gallery_preprocess.py` fetches the live master index as the merge base (`configs/oss_presets.json` → `index_url`),
writes `prompts.chat/index.json` and `thumbnails/prompts.chat/`, and the master index carries one `prompts.chat` card.
Video thumbnails need ffmpeg for the first frame, resolved the way the material page resolves it (ffmpeg on PATH,
then the imageio-ffmpeg binary), and a machine with neither publishes that card without a preview. `--preview` uses
that same run to transcode a 480p muted mp4 per video into `previews/prompts.chat/` (crf 30, 700k cap, faststart) and
writes the item's `preview` key — that is what the prompt-library card autoplays, and when ffmpeg is missing only the
preview is skipped, the originals still publish. The first
publication carries `--tag prompts-chat` in that same run — `--tag-dirs` only relabels a directory the live master
index already knows. `gallery_deploy_oss.py` takes its endpoint from `OSS_ENDPOINT`; when that variable holds
anything else, name `--endpoint https://oss-<region>.aliyuncs.com`, and a `--dry-run` never connects, so it cannot
catch that.

Per-row provenance is `<out>/prompts.chat.manifest.json`: the endpoint, the license note, and per row its url, author,
tags and the sha256 of the body and of the media. The manifest sits outside `prompts.chat/` on purpose —
`gallery_deploy_oss.py` uploads every file under `--source` as an object, and a manifest inside the directory would be
read by the plugin as an item of the card.

On the user side this is one `prompts.chat` cloud preset card in the material gallery: open it, paste the body into the
generator with "Copy prompt" ([gallery.md](gallery.md)).

Boundaries: `--build` is what writes files, an existing sidecar is left alone, and `--overwrite` is the only switch that
rewrites one; `--type IMAGE` and `--type VIDEO` run separately and the serial follows the ranking. The cases live in
`studio/tests/test_import_prompts_chat.py` against stand-ins for the endpoint and for the media download — running them
issues no network request.

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
