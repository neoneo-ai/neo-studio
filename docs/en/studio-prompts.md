# Prompt Library

The 「提示词库」 card in the Studio home 「Assets & Setup」 section opens `#/prompts`
(`studio/web/prompt-library/prompt-library.js`). The header has no tab for it: that home card is the only
way in, and removing the card from the home layout (adding it back in "add card") removes access to the page.
One prompt per card, the cards laid out as a waterfall (the same column packing the asset library uses,
`studio/web/gallery-masonry.js`). The top band is a media tile that spans the card's full width and takes its height
from the picture's orientation — a landscape crops to 3/4 of the card width, a portrait runs full width up to twice
it; its image when it has one — the cover sidecar next to the text wins, and a shipped preset with no sidecar takes
its cloud directory's cover. A card with no picture has the title row as its first row, with the body preview in a
text tile under it instead of a fake thumbnail. Under the band sit the name and the tag chips, with the origin
and the actions on the card's bottom
row. A card with a picture opens the asset library's lightbox (`studio/web/lightbox.js`) when it is clicked. The grid
shows 24 cards per screen and the next screen is appended when the list is scrolled to its end.

## What the page looks like

1. **Title row and filter row**: the title row carries the page name, the entry count and 「刷新」 (Refresh) — that button
   force-refetches the whole cloud preset index (the master index plus every directory index: the cloud card image and
   preview pairing on this page reads only the per-directory cache under `gallery/oss_cache/`, and the master index is
   cached in-process for 24 hours), then reloads the list. Every cloud directory tagged `prompts` is a mirror source
   for the prompt pools: the rows the cloud has and the pools do not land in `presets/<dir>/` and
   `presets/video/<dir>/` (each with a cover sidecar beside its text — the card's media tile and the video
   preview both start from that file), and the rows the cloud dropped are pruned from both (nothing is pruned while a
   directory index is not at the master index's current `rev`, so an offline click never empties the pool); the toast
   reports the imported and pruned counts. When no cloud presets are configured, or the kernel is not
   running, it says which of the two it is and the local list reloads anyway. The filter
   row carries the search box (matches the full scan name, directory segment included, plus tags), the image/video pool filter
   (`All / Image / Video`; the pool comes from the scan name's first segment, the same rule the prompt picker
   uses), the origin filter (`All origins / Presets / Custom`), the sort filter (`Newest / Oldest / Name` — newest and
   oldest use the file time each list entry carries, name uses the display name without its directory segment) and the
   tag filter (its vocabulary is the tags of this loaded list ranked by how often each appears, at most 14 chips with
   "All tags" first; the row is skipped when the vocabulary holds fewer than two tags, since one chip filters nothing)
   — every chip group follows the asset library's type-chip style: a transparent pill with a light border, 11px text,
   the accent-orange border on hover and a solid accent-orange fill when selected. Trending, author and like controls, as
   [prompts.chat](https://prompts.chat/prompts) ships them, live on cloud data; these entries carry only a file time and
   tags, so a control with no data behind it is not shipped.
2. **Card**: the column width has a 280px floor and the column count follows the page width, capped at 7 columns — past
   that cap the leftover width is shared out across the columns instead of leaving a blank band along the page's right
   edge; cards of unequal height are packed by `gallery-masonry.js`, each into whichever column is shortest right now
   (the asset library's packing).
   The media band spans the full card width, and it takes its picture in the order
   "cloud image media → cover sidecar → cloud directory cover" — the media and the directory cover both come from
   `cloudDirCoverUrl` (the thumbnail proxy), the sidecar from `promptCoverUrl(name, v)` where `v` is exactly its mtime
   on the entry, and every `<img>` is `loading="lazy"`; with none of the three the title row is the card's first row and
   the body-preview block fills the text tile under it, so no empty slot is left. The band's height follows the
   size first comes from the `w` / `h` the cover write recorded in the pointer (the card lands at its final height, so
   the packing never re-runs once the pictures arrive), and only a cloud media row or a factory directory cover, which
   carry no such record, falls back to probing: the image reports it on `load`, the video on `loadedmetadata`, and a
   preview band probes its own `poster` first (the poster is that card's cover, so its ratio is the film's — waiting
   for metadata would land a portrait card at 4:3 and re-pack on every card's first frame) — a landscape crops to 3/4
   of the card width, a portrait runs full width up to twice it, and the packing re-runs as cards grow. Both autoplay
   chains count — a card paired with its cloud media plays the 480p silent preview
   (see "The cloud preview"; the video pool only), and a custom card with a cover pointer plays that local output
   (see "The local cover video"; the image and the video pool both count — the pointer is what records where this
   cover came from); the cover is the
   `poster` of both, and the band carries a play badge. Then the title row (the name alone, without its directory
   segment — the pool chips sit on top of this page, so repeating the directory in the title buys nothing; the full scan
   name lives in the card's hover title, and search keeps matching the full name with that segment, plus two badges:
   preset / custom, image / video — on a card with no picture this row is the card's first row and the pool label
   appears in those two badges only); the body-preview block (the first 220 characters of that prompt
   collapsed onto one line, monospace on a raised fill, at most three lines — when it cannot be read the block collapses
   entirely and the card never says "read failed"); up to three tag chips; and the bottom row (origin and "how long ago"
   on the left, the actions on the right). Hover pushes the border to the accent orange and zooms the picture by 1.05,
   and a system asking to "reduce motion" drops that whole layer.
   A card with a picture opens the asset library's lightbox (`studio/web/lightbox.js`), and what it opens is the full
   file behind the tile, never the tile itself: an image card paired with cloud image media enlarges the image that
   cloud directory published (`GET /neo_gallery/image?filename=&subfolder=` — the card tile shows a 512 px thumbnail of
   the same file, and on a cloud directory the thumbnail route hands back the small cover the publisher generated,
   which blurs once enlarged), an image card whose cover pointer names an image enlarges that output, and one with
   nothing but a sidecar cover enlarges the sidecar. A video card plays the original video — a cloud preset its own
   file on the same video route with the
   `preview=1` flag dropped, a custom prompt the local output its cover pointer names — with playback controls and
   its sound, while the card tile keeps the published 480p muted preview and asks for the file only in view. The
   cursor on such a card is the zoom one; ←/→ pages only the cards the current filter shows with a picture, and a
   text tile has nothing to show, so clicking it opens nothing. The lightbox panel is that prompt's tags plus its
   full text (read through `POST /rs_prompts/load_prompt`; with nothing readable it lays out the tags alone, and an
   empty body takes no slot), and its toolbar carries the card's own actions, pool included.

3. **Scroll loading**: 24 cards per screen; the bottom row (`.ns-pl-more`) is watched by an IntersectionObserver on
   this page's own scroll container, and entering its view appends the next screen until every match is on the grid,
   where the row reads "All {n} loaded". There is no page bar. Until the list arrives the grid shows 24 skeleton cards (card-shaped
   placeholders with a shimmer, so the packing has a screen shape to show; a system asking to "reduce motion" drops the
   shimmer), and they are replaced wholesale once the list lands. Search and every filter chip rebuild the first screen
   and pull this page's scroll position back to the top, so a viewport scrolled into the old stack never sits in the gap
   of the new one.
   Body previews go out per screen as
   `POST /rs_prompts/prompt_previews`, at most 32 names per call, cached per page under "scan name + file time"
   and refetched only when reloading the list changes that file time.
4. **Card actions**: the fill button follows the pool — a video-pool prompt carries only 「填入视频页」
   ("fill the video page") and an image-pool prompt only 「填入绘画页」 ("fill the paint page"), so a card never
   ships a button it has no use for; then "copy", "set as cover" and "delete". Preset cards
   only carry the fill button and "copy" — the preset tree is a code directory, so the UI never ships a button that must fail.
5. **Filling a page**: the full text is read by scan name first (`POST /rs_prompts/load_prompt`), then handed to
   the assembly layer's existing chain `applyToPage(mode, text)` — `paint` switches to the paint page and fills its
   prompt box, `video` goes through the video page's reuse fill; it is the same landing the enhance page uses for
   its reply. An empty body reports "This prompt is empty" and sends nothing.
6. **Set as cover**: opens the host's asset pick modal (one pick and it closes) with the asset search box prefilled
   with this prompt's first text line — the sidecar's first line is the prompt that generated the asset, so the modal
   lands on the outputs made with it, and clearing that box is what browses everything. Which kind it accepts follows
   the filter chip — "Image" takes images, "Video" takes videos (the backend takes the first frame), and "All" takes
   both, so a prompt of the image pool can pin an output as its cover and the card plays it.
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
- A pointer sits next to the cover: `<scan name>.cover.json` (`filename` / `subfolder` / `kind`, plus the cover's own
  pixel size `w` / `h`). Only the "set as cover" press and the cover backfill script write it, and `list_prompts`
  gives such an entry a `cover_media` key from it — that is the only thing telling a card "this cover was
  played out of that output", and it is what lets a waterfall card take its final height the moment it lands. A
  pointer written before sizes were recorded reads without `w` / `h` and the card falls back to probing that cover.
  A pointer that cannot be read (broken by an external editor, no `filename`) leaves the key off the entry and the
  card on a still cover.
- Deleting the text deletes its cover and that pointer (`delete_prompt` clears them in the same pass), so the prompt
  tree never keeps a cover without a prompt, nor a pointer aimed at a cover that is gone.

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
- The lightbox takes the full file of that same origin, not the tile's copy: image media through
  `GET /neo_gallery/image?filename=&subfolder=` (the route the material page lightbox uses), a cover pointer naming an
  image through that output, and a directory cover only when it is an image — a video directory's cover is a frame the
  index already stores small, so there is no full image behind it.
- The preview band takes only that entry's cover sidecar as its `poster`: an entry carrying just the cloud directory
  cover (`dir_cover`) shows that cover as the card image and plays no preview.
- The URL is `GET /neo_gallery/video?filename=&subfolder=&preview=1`: the preview downloads from
  `neo/presets/previews/<dir>/` into `gallery/oss_cache/previews/<dir>/`, and every later play reads that cache
  (`Cache-Control: public, max-age=86400`). The same route without `preview` serves the original into
  `oss_cache/<dir>/`, and the material page lightbox keeps playing the original.
- In the offline window this request answers 409 and the card stays on its poster; when the system asks to
  "reduce motion" (`prefers-reduced-motion`), no preview video is built at all.

## The local cover video

- An entry that carries `cover_media` whose `kind` is `video` — the pointer beside its cover, holding `filename`,
  `subfolder` and `kind` — plays that very output in the same band, in the image pool exactly as in the video pool:
  the pool chip filters the list, it does not decide where a cover came from. The URL is
  `GET /neo_gallery/video?filename=&subfolder=`, the request without
  the `preview` flag — the same route the material square and the gallery lightbox use, and it is in the desktop
  capability table, so an offline window plays it too. The cover is the `poster`, the element is
  `muted / loop / playsinline / preload="none"`, and the `src` is attached by the same IntersectionObserver only when
  the card enters the viewport; leaving the viewport pauses it, and the sound stays with the material page's lightbox.
- A pointer whose `kind` is `image`, an entry with no cover, and a pointer that cannot be
  read each drop the card to a still cover — no preview element, and no request that can only fail. The cloud preview
  wins: an entry paired with cloud media keeps playing its 480p preview.
- The pointer is written by `prompt_names.write_cover_source`: the UI writes it right after `set_prompt_cover` lands
  the cover (the kind comes from the gallery video suffix list), and the backfill script writes it after `--apply`
  lands one (the subfolder is computed against the media roots; an output outside every known root leaves it empty and
  the card stays on a still cover). A prompt that already has a cover, a matching video and no pointer next to it gets
  just that pointer, with its JPEG untouched — a cover set by an older build starts playing the film it was cut from.
  `--frame-match` adds a first-frame tier for covers whose text left no trace: each output's first frame is decoded
  once into a 16×16 luminance vector, and a cover regains its film only when the leading match sits under 0.02 and
  wins by 4× over the runner-up (frames whose aspect is more than 8% off never enter the ranking). That tier writes
  the pointer too, never the JPEG.
  A pointer write that fails never touches the cover — that press already succeeded,
  and a card on a still cover is cheaper than a half-written "set as cover".

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
512px long side, a video gives its first frame), together with the cover pointer beside it
(`<scan name>.cover.json`, what the card autoplays that output from). The default is a report; `--apply` is what writes.
Prompts that already have a cover are left alone and `--overwrite` rewrites them; a prompt that has a cover,
has no pointer beside it, and matches a video output gets only that pointer filled — the JPEG is never touched,
so the card drops back from a still cover onto that very output. Image prompts
take images only, entries under `video/` take videos only, and a body whose first line is too
short has no discriminating power, so it is skipped. `--loose` also counts "the first line appears
inside the metadata text" — a multi-segment film stores the whole body, where a whole-line match
cannot land. A body whose first line matches nothing keeps a still cover: the backfill never picks a film
for the user, so pin that film with "set as cover" in the UI. The scanned roots are ComfyUI's `output` and
the data root's `gallery/custom` by
default, with `--output-dir` to add more and `--limit` to try a small batch first.

```powershell
python tools/fill_prompt_covers.py                              # report only
python tools/fill_prompt_covers.py --apply                      # write missing covers, fill missing pointers
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

The media slot is the site's own example output first; a row that will not download, whose type is not recognized, that
exceeds 24 MB, or that lands shorter than its declared `Content-Length` (a cut-off stream) falls back to a locally typeset
preview, and a row with no `mediaUrl` gets a preview for the same
reason — `gallery_preprocess.py` skips entries that are `.txt` only, and a cloud card with no media slot is not a card.
The preview's base color comes from the title's sha256, a rerun yields the same bytes, and since it is no real output it
lives on OSS only. `--skip-preview` makes that a hard gate: a row with no example output is dropped whole — no sidecar,
no manifest row — because a cloud card must not carry a typeset text block as its media slot.

Uploading runs the same chain as the material presets ([gallery.md](gallery.md)):

```powershell
python tools/import_prompts_chat.py --top 20 --pages 2 --build --skip-preview --out tmp\gallery_pack
python tools/gallery_preprocess.py --presets tmp\gallery_pack --output tmp\gallery_pack --dirs prompts.chat --tag prompts --preview
python tools/gallery_deploy_oss.py --source tmp\gallery_pack --bucket <bucket> --prefix neo/presets/ --endpoint <endpoint>   # check --dry-run first
python tools/gallery_prune_oss.py --dir prompts.chat --stems doomed.txt                # retire rows: lists the keys, deletes only with --apply
```

`gallery_preprocess.py` fetches the live master index as the merge base (`configs/oss_presets.json` → `index_url`),
writes `prompts.chat/index.json` and `thumbnails/prompts.chat/`, and the master index carries one `prompts.chat` card.
Video thumbnails need ffmpeg for the first frame, resolved the way the material page resolves it (ffmpeg on PATH,
then the imageio-ffmpeg binary), and a machine with neither publishes that card without a preview. `--preview` uses
that same run to transcode a 480p muted mp4 per video into `previews/prompts.chat/` (crf 30, 700k cap, faststart) and
writes the item's `preview` key — that is what the prompt-library card autoplays, and when ffmpeg is missing only the
preview is skipped, the originals still publish. The first
publication carries `--tag prompts` in that same run — `--tag-dirs` only relabels a directory the live master
index already knows. `gallery_deploy_oss.py` takes its endpoint from `OSS_ENDPOINT`; when that variable holds
anything else, name `--endpoint https://oss-<region>.aliyuncs.com`, and a `--dry-run` never connects, so it cannot
catch that.

Per-row provenance is `<out>/prompts.chat.manifest.json`: the endpoint, the license note, and per row its url, author,
tags and the sha256 of the body and of the media. The manifest sits outside `prompts.chat/` on purpose —
`gallery_deploy_oss.py` uploads every file under `--source` as an object, and a manifest inside the directory would be
read by the plugin as an item of the card.

Retiring a row runs `tools/gallery_prune_oss.py`: `--dir` and `--stems` name the cards, and the media and sidecar under
`prompts.chat/`, the thumbnail under `thumbnails/prompts.chat/` and the preview under `previews/prompts.chat/` go
together. It lists by default and deletes only with `--apply`; a name whose files are still in the build directory
refuses the whole batch, because a cloud delete with the index and the media disagreeing leaves the card on a media slot
that can never load. The refresh that fills a card's media tile fetches past `gallery/oss_cache/`: that cache hits on the
path and knows nothing about the bytes, so once a directory is re-published under the same keys the cover has to be the
one the cloud holds now.

On the user side this is one `prompts.chat` cloud preset card in the material gallery: open it, paste the body into the
generator with "Copy prompt" ([gallery.md](gallery.md)).

Boundaries: `--build` is what writes files, an existing sidecar is left alone, `--overwrite` is the only switch that
rewrites one, and `--skip-preview` drops a row that has no example output; `--type IMAGE` and `--type VIDEO` run
separately and the serial follows the ranking — the ranking moves when
votes move, so a slug the manifest already records keeps the stem it first landed on, and re-issuing it under the drifted
rank would book the same prompt twice. The cases live in
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
- Cases: `studio/tests/js/prompt-library.test.mjs` (cards and covers, body previews, scroll loading, filters, sorting and
  the tag filter, the skeleton cards, filling a
  page, setting a cover, two-press delete, the offline state, plus the band's orientation, the text tile and the two
  autoplay chains), `studio/tests/js/preset-picker.test.mjs` (the
  picker's thumbnail slot), `studio/tests/test_prompt_covers.py` (sidecar write / read / delete, cover-pointer
  write / read / delete and a broken pointer dropping to a still cover, 403 on presets,
  404 on a missing source, traversal names), `studio/tests/test_prompts_tags_scan.py` (the preview collapses onto
  one line, truncates, and drops names without a body).

The prompt pools and the node-side chain: [prompts.md](prompts.md); route by route: [api-routes.md](api-routes.md).
