# Model Hub

> 🇨🇳 中文: [../model-hub.md](../model-hub.md)

🅝 menu → **📥 Model Hub**: search and download models from the Comfy-Org area with two selectable
sources (ModelScope / Hugging Face); downloads land straight in ComfyUI's model folders.

## Flow

1. Pick a source → the Comfy-Org repository list is fetched (grouped by the curated registry, order
   inside a group = ModelScope relevance ranking; searchable, ⟳ refetches bypassing the cache).
2. Pick a repository → its model files are listed (non-model files filtered out), each row as
   `file name [landing category] size`, with `✓ present (subfolder)` on files that already exist on disk.
3. Pick a file → the landing category is filled in automatically; **the subfolder is a dropdown** built
   from the subfolders that already exist under that category folder (auto-probed by default: an
   existing directory named after the repository or prefixed with it, otherwise the root), plus
   "＋ New subfolder…" to type a fresh name. Clicking an existing file selects the subfolder that file
   actually lives in (files of the same model and category usually share a directory), which wins over
   the probed default. Preview: `→ models/<category>/<subfolder>/<file>` (the LLM category preview
   includes the mandatory `<repo name>/` segment; it is not stacked twice when the existing location
   already is that segment).
4. ⬇ Download → progress bar with percentage / downloaded / speed, cancellable; on completion you get
   a notice and the file list refreshes.

## Landing categories

- A `split_files/<category>/...` prefix inside the repository maps straight onto a ComfyUI model
  category (`transformer` / `unet` → `diffusion_models`, `clip` → `text_encoders`, and so on).
- Without that prefix, file-name keywords take over (`vae` / `lora` / `esrgan` / `clip` / `t5` / `qwen`
  …); nothing matched → `diffusion_models`.
- `.gguf` goes to the **LLM category**: `models/<LLM subfolder>/<repo name>/`, the same directory the
  built-in local inference (llama-cpp) uses.
- The landing root comes from the `folder_paths` registered directories (including the external ones
  from `extra_model_paths.yaml`): the directory whose name matches the category wins (with `unet` /
  `diffusion_models` in the same group it picks the right one), otherwise the first existing one.
  The `✓ present` marker scans **all** registered directories of that category and their subfolders.

## Resumable downloads

A download writes `<file>.part`, with `<file>.part.meta.json` next to it recording source / repository
/ path / total size / bytes downloaded:

- "Cancel" keeps the breakpoint and the status reads "cancelled (breakpoint kept)"; downloading the
  same file again resumes over an HTTP Range.
- When the `.part` does not match the source / repository / file of the current request, it errors out
  and tells you to delete the `.part` — a broken file is never silently stitched together.
- On completion the `.part` is renamed to the real file and the metadata is deleted.
- One task at a time: only a single download runs at once, a second request returns
  "a download is already in progress".

## Settings (⚙)

| Setting | Description |
|----|------|
| Default source | `modelscope` / `huggingface` |
| HF endpoint | Mirror root URL (only absolute http/https URLs are accepted; an invalid value falls back to the official endpoint) |
| HF Token | Required for gated repositories |
| ModelScope Token | Optional, only needed to download gated repository files (listing and search work anonymously) |
| LLM subfolder | Directory name under `models/` where GGUF files land (default `LLM`) |
| Total timeout / read timeout | Seconds, minimum 10 |

Settings are stored in `configs/model_hub.json`. Subfolder and file names are sanitized before landing
(directory parts stripped, illegal characters removed, `..` rejected), and the landing path must stay
inside the model folders.

**The ModelScope Token may stay empty**: both the organization listing and the cross-organization
search use the site's own `dolphin/models` endpoint (relevance ordering `SortBy=Default`, anonymous
access). When that endpoint is down, missing repositories are filled in from Hugging Face results plus
a per-repository existence probe against the registry (probe results cached for a day). A token is only
needed to serve gated repository files, so a wrong token does not affect listing or search.

## Curated registry

`configs/model_registry.json` keeps the groups and recommended combinations (repository names and notes
only, no metadata) and drives the grouping and the fill-in of the repository list. Repositories inside a
group follow the **relevance order** of the ModelScope organization page (the order returned by
`SortBy=Default`); repositories ModelScope does not list go at the end of their group.

## Preset model manifests (models.json)

`skills/presets/<id>/models.json` declares the model files a preset needs and drives the Model Hub's Preset
readiness panel (below) and the download plan (routes: [api-routes.md](api-routes.md)). The manifest describes the
file layer only: it does not check the ComfyUI version, VRAM, the queue, and it does not predict generation.

- Top level: `family` / `label` / `kind` (`image` / `video`) / `license` / `notes` (the notes shown in the UI).
  `extends` points at the family base preset so the preset's own manifest lists only its additions (LoRA etc.);
  extends resolves one level deep and a cycle stops there.
- `files[]`: `field` (the key in the image / video generation config, `loras` marks a LoRA entry),
  `filename` (the preset-relative name, subfolders included), `category` (the drop-in category), `gb`, `label`,
  `optional` (an optional entry, never counted as missing), `alt` (family variant names, so a file that landed
  under a different name is still recognized), `sources[]` (`source` = `modelscope` / `huggingface` / `civitai`
  + `repo` + `path`, `gated` marks entries that need authorization on HF first; `sources[0]` is the recommended one).
- Readiness follows the generation side: a config with a pinned model name is looked up by that exact relative
  name; an empty name matches the recommended name plus `alt` anywhere in the category tree (case and slash
  insensitive). A `loras` entry only counts when that LoRA is in the preset / global LoRA list.
- The download plan emits entries for the hub's current source and each entry's `payload` is exactly what
  `/neo_model_hub/download` takes; a file the current source does not carry is marked `not_on_source` with the
  other source named, and there is no automatic switch; an illegal source entry is marked `bad_source`.
  A civitai source must be a `/api/download/models/<id>?…` endpoint.
- Presets that need no local model files ship no manifest: `translate` / `translate_to_chinese` /
  `translate_to_english` / `cosyvoice_voice`; readiness returns `has_manifest: false` for them, and a missing or
  broken manifest degrades the same way instead of raising.

## The readiness panel (Model Hub → Preset readiness)

The "Preset readiness" button in the Model Hub header expands a panel that turns the readiness check and the
download plan above into one clickable path:

1. Expanding reads `GET /neo_skill_models/all`: one row per family with its preset count, file count, total size
   and a "missing N · X GB" badge (a family with no gap reads "Ready"); the header counts
   "P presets · F families · B families need models".
2. Clicking a preset in a family sends `POST /neo_skill_models/plan` (carrying the hub's current source and the
   "Plan includes optional files" tick) and renders the plan: each row reads `label · category/subfolder/landed
   name` with its source and size, and the row's `payload` is what `/neo_model_hub/download` takes. A file the
   current source does not carry has its button disabled with the other source named; an illegal source entry says
   why; a source that needs an HF token or a Civitai key says where to fill it in, in the plan header.
3. "Download" on one row, or "Download all", feeds the plan into the hub's single download slot one item at a time
   (finishing the previous item starts the next); the progress bar and "Cancel" are the download area's own.
   Cancelling breaks the queue — the breakpoint stays on the current file.
4. When the plan finishes, the overview and that preset's plan are re-read: the files that just landed leave the
   missing list and every preset of the family turns "Ready" together.

## Link with generation (the missing-model download entries)

The readiness check is not used by the readiness panel alone - the three generation-side entries read the same
manifest through `skillModelCheck` / `manifestGap` / `manifestHubTarget` in `web/image-gen.js`:

- **Preflight before generating**: a preset with a manifest is checked against
  `GET /neo_skill_models/check` before `/neo_image_gen/generate` is posted. When a file the run needs has not
  landed, the task is not queued, the failure names the missing files and their size, and the notification
  offers "Open Model Hub" → `openModelHub({ readySkill })`, which expands the readiness panel and builds that
  preset's download plan. Details: [image-gen.md](image-gen.md).
- **The model rows of the generation settings**: the row whose field the manifest marks missing gains a
  "⬇ Model Hub" button that opens the hub with the manifest's source / repository / drop-in category / file
  name prefilled (`openModelHub({ source, repo, category, query })`), its tooltip carrying the size and the
  gated authorization note. A ready row gets no button, and a preset with no manifest gets none either
  (only the "(missing)" mark in the dropdown stays).
- **The skill repair dialog**: a missing entry opens the hub on the manifest's source and repository, and a
  custom skill with no manifest falls back to the stale file name plus the field's category
  (`openModelHub({ query, category })`).

---

Backend `model_hub.py` (routes: [api-routes.md](api-routes.md)); frontend `web/model-hub.js` + `web/model-hub.css`.
