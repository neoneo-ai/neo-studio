# Changelog

Notable changes for Neo Studio. Versions are tagged `vX.Y.Z` and published to the ComfyUI Registry.

## [Unreleased]

### Added
- **The Studio home scales with the window.** The content column grows from 1020px up to 1560px as the window
  widens instead of staying pinned at 1020px in a sea of empty side margins, and the hero title and card type
  scale up with it. In windows 1400px and wider, the section labels (开始创作 / 编辑 / 素材与配置) move from
  the top-left of the centered column - where they floated half a screen away from the cards - into a left
  rail that sits level with the first card row, each joined to its grid by a short rule. Covered by the home
  layout cases in `studio/tests/js/studio-desktop.test.mjs`.
- **The Studio home compacts in shorter windows.** In windows under ~1150px tall (widths above 720px) the
  hero, section gaps and cards shrink together, so the full card grid fits the viewport and no scrollbar
  shows by default; wide-window windows keep the roomier layout.
- **You lay out the home page on the home page itself.** 编辑首页 standing in the top-right corner of the home page -
  it scrolls away with the page instead of staying pinned on the window - switches that page into
  edit mode, and that page is now the editor: the whole card is the drag gesture, so its corner tool row is just the
  hide/show eye (custom cards also get a pencil and delete), the hero title lines are edited by clicking the text,
  hidden cards stay in the grid as ghost
  tiles so you can bring each one back where it sits, and the grid ends with an "添加卡片" placeholder tile that opens the
  card's edit dialog — fields in three rows (jump type + jump target, title + subtitle, icon + section), the cells you
  have not touched auto-filled from that jump type and target, and the same dialog the pencil opens with the card's
  current values; only its 保存 puts the card
  into the draft. Sections carry no controls of their own: their order and collapsed state are only read from a layout an
  older build saved, a section left collapsed is laid back out with its cards while you edit, and that save writes it back
  expanded. The 编辑 bar is one compact group pinned to the home page's top-right corner (`width: fit-content` +
  `margin-left: auto`) that owns the grid column count, the hero switches, 恢复默认 and the 完成 button at the end of
  its row, so it stays pinned with the bar while the page scrolls without stretching across the page.
  Custom cards can be dragged into another section; built-in cards
  reorder inside their own section and say so. Every change redraws the page at once without sending a request;
  while editing the entry button is 完成, so one click saves the layout, says it on screen and leaves edit mode - and a
  save that fails keeps the draft on the page with the button clickable again. 恢复默认 hands back the registry layout,
  and Esc / leaving the
  home page discards the draft so the home falls back to what is on disk. The layout stays one file in the data root
  (`configs/home_layout.json`), so the plugin page, the desktop window and the paired phone page open the same home.
  The 首页 tab is gone from the settings sidebar, and an old `#/settings?tab=home` bookmark lands on the default panel
  instead of a blank page. Covered by `studio/tests/js/home-layout.test.mjs`, `studio/tests/test_home_layout.py` and
  the layout cases in `app/tests/test_studio_server.py`.

### Changed
- **A new home card picks its icon from the icons themselves.** In the custom-card dialog the icon is a grid of icons
  (`.ns-home-f-icons` with one `.ns-home-icon-swatch` per candidate, 24 of them) instead of a dropdown of English icon
  names: the picked swatch lights up its border, the icon name stays in the tooltip, and the row spans both dialog
  columns so the icons line up. An icon a saved layout carries that is outside that grid shows as the first swatch and
  stays picked — the dialog never pretends the card has no icon. Covered by the icon cases in
  `studio/tests/js/home-layout.test.mjs`.
- **Dragging a home card now feels like carrying a card.** The home page's reorder gesture is a vendored SortableJS
  (MIT 1.15.7, `studio/web/vendor/sortable.min.js`, pulled in with `import "../vendor/sortable.min.js"` the way marked/purify are,
  nothing fetched at runtime): the card you carry rides under the pointer as Sortable's clone (`.sortable-fallback`
  carrying `.is-dragging`), the card in the slot it left stays marked (`.sortable-chosen`), and every card that changes
  slot slides there in 150 ms. The landing slot is the slot the pointer is over — dropping past the last card puts the
  card at the end — and the sliding preview can no longer move the drop point out from under the pointer, which is what
  made the hand-written HTML5 drag bounce back and forth. Custom cards still move between sections; a built-in card
  dropped into another section returns to its slot with the hint in the bar. Dragging on a phone works now: the old
  gesture did not. Covered by the drop cases in `studio/tests/js/home-layout.test.mjs` and the real-browser gesture in
  `studio/tests/e2e/home-card-drag.e2e.mjs`.
- **A 再来一发 is never blocked by "the video page is not ready".** A video card's 再来一发 and a home-page video skill
  card stopped with 「出视频页尚未就绪」 whenever the Video page had never been opened in that window, so the run you asked
  for never reached the composer. The desktop shell now hands the gallery a page-jump hook (`setVideoPageJump`): the
  first click builds the Video page and prefills that run in the same gesture. The canvas page (no shell layer) keeps
  the honest "not ready" notice. A run whose skill is no longer in that page's dropdown names the skill and points to
  the Skills page, and fills everything else as before.

- **Every 编辑 mode has its own home card, and a card you create no longer offers 页面直连.** The home 编辑 section carries
  **局部** and **删除** next to 图片编辑 / 扩图 / 机位 / 融合 / 姿势, so all seven modes of the 图片编辑 panel have a card that
  lands on the 编辑 page already in that mode. A custom card picks between 编辑模式 / 导演配方 / 技能 / 外部链接; jumping
  straight to a page is off that list — a layout saved earlier keeps its 页面直连 card readable and jumping, and the pencil
  shows that type only for a card that already uses it. A 配方 card with no recipe chosen opens the 导演页, a 技能 card with
  no skill chosen opens the 技能页. A 技能 card opens the page that applies that skill: a 生视频 skill opens 出视频页 with it
  selected, a 生图 skill opens 输入页 with it selected, and a skill with no slot in either page's skill list (enhancement /
  template skills) says it has no page to land on and opens the 技能页. Covered by the new cases in
  `studio/tests/js/home-layout.test.mjs`, `studio/tests/js/studio-desktop.test.mjs` and `studio/tests/test_home_layout.py`.

### Fixed
- **The 编辑首页 entry answers the click.** The entry was handed to the page builder with `disabled: false`, and a false
  there is written as the attribute `disabled="false"`; HTML takes the mere presence of that attribute as disabled, so the
  entry showed, hovered, took focus, and stayed inert - neither 编辑首页 nor 完成 did anything when clicked. The flag is
  now set as the button's own property, so the entry is disabled only while a save is in flight, and in edit mode the
  entry lays itself into the slim sticky bar's row at its right end instead of sitting behind that bar, so 完成 is the
  whole control and stays pinned where you can reach it. Covered by a case in `studio/tests/js/home-layout.test.mjs`.




## [1.6.1] - 2026-11-08

### Added
- **The 3D 姿势 export panel gains a separate 送进图片编辑 button: pose sets go to the library, and one click
  sends the control image to the editor.** Exporting stays what it always was - the set lands in the library's
  `Pose` folder, the toast names only that, and the page is not switched. The new button does the whole handoff in
  one click: with nothing exported yet it exports this set first, then carries its first usable control image
  (skeleton → depth → normal → lineart → silhouette, in that order) into 图片编辑's **姿势** mode - the output size is
  the exported edge length, the direct detent is on, and the prompt is the lock sentence for that format (skeleton
  keeps the skill's own default sentence); a batch already exported goes through without rendering again. It is grey
  for one case only, a batch of `shaded` renders - a lit render is not a control image - and the greyed tooltip names
  the reason. Add the 原图 in the editor and the shot locks that pose onto it. Covered by the export / send cases in
  `studio/tests/js/pose-bridge.test.mjs`.
- **The Studio home splits into create and edit sections, and the edit modes become direct cards.** The home page now
  reads **开始创作** (生成图片 / 生成视频 / 导演视频 / 3D 姿势 / 智能体), **编辑** (图片编辑 / 扩图 / 机位 / 融合 / 姿势 /
  视频抽帧) and **素材与配置** (素材库 / 技能 / 设置). An edit card jumps to the 编辑 page and switches the panel it lands in
  to that mode on arrival - the panel is the one the 编辑 page builds when you enter it, so the card switches the mode
  (`openImageEditMode` → the host's `__neoSetMode`) instead of rebuilding it, which would clear a half-written prompt.
  The mode is set even with no 原图 in the panel and the mode chip stays clickable, so an empty panel already shows what
  this shot will do and the empty-state hint names it (「已选「扩图」：点预览区的「原图」方块选原图」). **Only the user
  switches the mode** - picking the 原图, swapping it for another and clearing it all leave the picked mode as it is;
  clearing the source only tears down the layer that sat on it. What a mode drives on the 原图 (the outpaint box, the paint
  layer, the click-to-remove markers, the 机位 ball with its three sliders) stays folded away until the 原图 is in and lays
  itself on it at that moment (a swapped source gets a fresh outpaint box), so an empty panel shows only the 「＋ 原图」 box
  - the 机位 card on an empty 原图 leaves the input card as just the bottom chip row, since 机位 folds the 参考 slot and
    the prompt box away by design - and clicking an empty preview no longer opens a compare lightbox that has no
    原图 to show (the click used to crash with `Cannot read properties of null (reading 'filename')`).
  **局部** and **删除** stay in the panel's mode menu: they need you to paint / click on the source, so a home card for
  them is an entry that can only fail. Covered by the new case in `studio/tests/js/studio-paint.test.mjs`, the direct-card
  cases in `studio/tests/js/gallery-image-edit.test.mjs` and the home-layout case in `studio/tests/js/studio-desktop.test.mjs`.
- **The 编辑 page takes its 原图 from the preview area.** An empty 图片编辑 preview now carries a fixed-size
  「＋ 原图」 box in its centre (220×140 on a dashed outline, no filled background, so it never reads as disabled):
  clicking it opens the asset library, hovering it floats a two-item menu — **🖼 素材库取图** / **⬆ 本地上传**
  (a chosen file is copied into `input/` and set as the source) — and dropping a file onto the box lands the same
  way; the box folds away once a 原图 is in place and returns when the source is cleared. The 原图 now scales up to
  fill the preview area (centered, `object-fit: contain`, nothing cropped) instead of sitting at its natural size in
  a fixed box, and the 编辑 page's page padding and the input card's padding give their strips to it. The 绘画 page
  keeps its own page padding and input card: the two pages' styles hang on their own hosts (`.ns-paint-edit` /
  `.ns-paint-text`), so a layout change on one never restyles the other. Covered by
  `studio/tests/js/gallery-image-edit.test.mjs` and `studio/tests/js/studio-paint.test.mjs`.
- **Camera-angle image-edit mode with a Canvas2D angle orb.** The image-edit panel's mode chip gains
  **机位**: the edit area reveals a 160px angle orb (`studio/web/angle/angle-orb.js` + `angle-orb.css`, Canvas2D
  wireframe sphere with a perspective camera drawn solid — back faces culled, so the camera reads as a camera,
  no new dependency). Drag the sphere to move the camera around the
  subject and the release snaps to the discrete detents; the four arrows at the midpoints of the sides step through detents (up/down tilt, left/right rotation), the three
  sliders (rotation 8 detents / tilt -30°..60° in 4 detents / zoom wide-medium-close) stay synced with the orb, and
  the keyboard arrows walk the same steps. Selecting 机位 switches to the new 「Qwen Image 2.1 机位编辑」 preset
  (`studio/skills/presets/qwen_image_21_camera_angle/`) and prefills its default trigger words - the three square
  brackets are filled from the current detents and refresh with the angle, never overwriting a prompt you wrote.
  The mode uses the source image only, so the reference slot and the prompt box both fold away (the orb and the
  three sliders set the words), and the 编辑 page's panel now stays inside the window: the preview shrinks with
  the viewport instead of pushing a page scrollbar, and the idle hint line under it is gone.
  The request carries `angle = {rotation, tilt, zoom}`, the sidecar records `angle=rotation/tilt/zoom`, and
  再来一发 restores the mode, skill, prompt and the orb together. Covered by
  `studio/tests/js/angle-orb.test.mjs`, the new cases in `studio/tests/js/gallery-image-edit.test.mjs` and the
  sidecar cases in `studio/tests/test_image_gen.py` / `studio/tests/test_gallery_copy_to_input.py`.
- **Gallery cards carry a Regenerate action, edited images included.** The image card's 「⋯」 menu gains
  **再来一发**: it reads the image's same-named `.txt` sidecar (`image_gen` writes the prompt on line 1 and the
  parameter summary on line 2) through `GET /neo_gallery/media_meta` - served offline too - and prefills the panel
  that fits. A plain generated image fills the 生成素材 composer: the prompt, the 宽高比 (only when the size lands
  within 2 % of a chip ratio), the 最长边 (only when that pixel value is a chip option), the skill it was made with,
  and that run's main model + LoRA. An edited image opens the 图片编辑 panel with its source image, its extra
  reference images copied into `input/`, the edit mode, the output size, the skill and its pinned model + LoRA; the
  paint mask and the outpaint margins are drawn on the source image, so they stay yours to redraw. The summary
  records what that run actually used - `skill=`, `mode=`, `src=`, `refs=` added behind the existing
  `seed=… WxH model=… loras=…`, with paths percent-encoded - so editing a skill's config afterwards does not move
  the rerun. Only what the panel can still run with gets filled: a model or LoRA no longer in the model list, a main
  model from another skill family (it falls back to the one that skill pins), a skill missing from that panel's list
  and a reference file the user deleted are dropped item by item, and the toast names exactly what was reused. A
  sidecar that is the workflow JSON ComfyUI's `SaveImage` wrote first stays on the 「导入工作流」 path, a Civitai
  sample sidecar fills the prompt only, and a card with no readable prompt in its sidecar shows no such item - audio
  cards never carry it. Covered by `studio/tests/test_gallery_media_types.py`,
  `studio/tests/test_image_gen.py`, `studio/tests/js/gallery-card-reuse.test.mjs`,
  `studio/tests/js/gallery-image-edit.test.mjs` and the new cases in `studio/tests/js/gallery-gen-material.test.mjs`.
- **Video cards carry 再来一发 (Regenerate) too - the whole run lands back on the video page.** A finished simple video now
  gets its own sidecar: `simple_video` writes the same-named `.txt` beside the saved `.mp4` (the existing
  「already written, leave it alone」 rule applies), recording the run's effective values - seed, size, model, LoRA,
  skill, first / last frame, reference images, steps, text encoder, video VAE, audio VAE, frame count and the
  requested duration, paths percent-encoded, reference videos / audios left out (the panel has no slot for them).
  Clicking the item on an `.mp4` card switches to the Video page and swaps the composer to that run in place - the
  panel is not rebuilt, so the dock keeps its state; the skill, the first / last frame or the reference images, the
  seed, the output size, the duration, the prompt and the 自定参数 (that run's values merged over the skill config)
  are filled item by item. What the panel cannot run with is dropped: a skill outside the video list, a model / LoRA
  / encoder / VAE no longer in the model list (the main model falls back to the one the skill pins), a duration that
  is not 3 / 5 / 8 / 10 / 15 s (derived from the frame count at the fixed 24 fps), a size outside the panel's
  choices, and a random seed. The 「已复用 …」 toast names exactly what was filled; with the video page never opened
  the reuse says 「出视频页尚未就绪」 instead of failing. Covered by `studio/tests/test_simple_video.py`,
  `studio/tests/test_gallery_media_types.py`, `studio/tests/js/video-reuse.test.mjs` and
  `studio/tests/js/gallery-card-reuse.test.mjs`.
- **The header queue panel keeps its history across restarts, offline included.** The six generation task kinds
  (image, voice, single-shot video, whole film, single segment, merge) now land in
  `<data root>/configs/studio_tasks.sqlite` as they start and as they finish, and the panel reads them back through
  the new `GET /neo_studio/tasks`: 200 rows kept with a 7-day TTL, the latest 48 listed, the ones still running on
  top. A row is named for what it was - the prompt text for image / voice / single-shot, 「配方名 第 N 段」for a single
  segment, 「配方名 拼接 N 段」for a merge, the recipe name for a whole film - and a finished row names its output
  (「图片 1 张 · 已输出 output/xxx.png」, 「音频 …」, 「视频 · 已输出 …」), where a video row carries a
  「🎞 成片名.mp4」 link that opens the file on the desktop port, so it works with ComfyUI stopped. Offline the panel no
  longer reports 「当前离线 · 没有可展示的队列条目」: it lists that history with generation, cancel and the memory
  readout disabled. Online the six live tables take over and a task keeps its progress bar through the merge, and a
  row never drops back from 已完成 / 已失败. On desktop startup the rows left queued / running from the previous
  session move to 「已失败 · 服务重启，任务状态已中断」, since the ComfyUI queue they belonged to is gone. Covered by
  `studio/tests/test_task_center.py` and `studio/tests/js/studio-queue.test.mjs`.
- **The Studio director guide page opens a recipe from under its buttons.** With the editor closed the whole column is
  the guide page (the idle card plus **📋 Recipes** / **📝 New recipe**). The three most recent director recipes now sit
  below those buttons, one per row - source tag (「预设」/「我的」), segment count, recipe name - taken in the backend's
  modification-time order, and the block is absent when there is no director recipe. Clicking a row takes the same path
  as clicking that recipe's card: the recipe opens embedded in the left pane and the film pane switches to it, with no
  recipe modal in between. The block refetches when the editor closes, so the recipe just saved is back on top. Covered
  by `studio/tests/js/studio-director.test.mjs`.
- **Downloads in mainland China.** The 整合包 (the ComfyUI integration pack) and the model files are shared on
  Quark Pan, [https://pan.quark.cn/s/4028d4e655e3](https://pan.quark.cn/s/4028d4e655e3), linked from the top of
  [README_ZH.md](README_ZH.md) / [README.md](README.md) and from the docs index.

### Fixed
- **The 整合包 updater's `-DryRun` no longer updates the package.** `Neo-Studio\tools\update_neo_studio.ps1 -DryRun`
  printed the plan, then extracted the update piece, backed up the files it names and overwrote `Neo-Studio\` and
  `ComfyUI\custom_nodes\comfyui-neo-studio\` anyway, printing 「未写文件」 as the last line. The guard now sits where
  the plan print ends, so a dry run touches nothing - no `updates\` folder, no backup, no overwritten code. A real run
  (no `-DryRun`) behaves exactly as before: 1.6.0 → 1.6.1, the plugin copy's `configs\data_root.json` pointer kept,
  every overwritten file first copied into `updates\backup-1.6.0\`.
- **The 图片编辑 原图 stops arriving broken, and the 素材库 pick dialog stops offering what the panel cannot use.**
  素材库 lists videos and audio next to the images (the 视频抽帧 page and the 出片 reference grid eat them), and the
  编辑 page opened that same dialog for its 原图 and 参考 slots: picking a video card dropped an `.mp4` into the
  `<img>` and the preview showed a broken image, while dragging a card onto a slot copied a video into `input/` for
  nothing. The dialog now filters by what the caller can take - 编辑 picks images only (clicking a video card there
  just opens the lightbox), 视频抽帧 picks videos only, 出片 keeps every media kind - and the 原图 / 参考 landing
  points refuse a non-image arriving by drag or by the 「取用已选」 batch, naming the way that works (take a frame out
  of the video first and use that frame as the image). A source copied into `input/` renders at last too: the 原图
  preview, its size probe and the lightbox now address it as `input/`, where the empty subfolder used to resolve as
  `presets/` and 404. Covered by `studio/tests/js/lib-modal-pick-accept.test.mjs` and the pick / addressing case in
  `studio/tests/js/gallery-image-edit.test.mjs`.

- **Switching an 编辑 mode swaps the prompt box with it.** 机位 folds its prompt box away by design, so its prefilled
  camera line sat in the box unseen; coming out of 机位 onto 扩图 (a home direct card, a mode-chip pick) left that
  sentence in the 扩图 box, and the shot sent 「Move the camera of <image1> …」 to the outpaint skill instead of the
  outpaint trigger - no added border. The box now follows every mode switch: an empty box and the line a mode filled
  by code both become the picked mode's own default (扩图 / 删除 / 融合 / 姿势 get theirs, 常规 / 局部 clear the box
  for you to write), and a sentence you typed yourself survives every switch (the 机位 slider refresh keeps the same
  rule). Covered by the new case in `studio/tests/js/gallery-image-edit.test.mjs`.
- **The 编辑 page's 素材库取用 fills the reference slots, not the source image.** The 「＋参考」 menu hands the
  asset-library modal the callback that appends picked cards to the 参考图 slots; the Studio host ignored it on this
  page and always ran its own source-image pick, so a card picked from the reference menu replaced the 原图 being
  edited while 参考图 stayed 0/9. The host now runs the callback the panel sent and consumes it when the modal opens,
  so the floating 🖼 素材库 button keeps filling the 原图 and 「素材库取用」 keeps filling references. Covered by
  `studio/tests/js/studio-paint.test.mjs`.
- **The 3D Pose 「姿势库」 filter chips no longer go grey when the library source switches.** Switching source
  repainted the chips while the pane's action lock was closed, so each switch drew the whole chip row disabled -
  the lock releases only the controls registered on it, and a chip is not one of them, so they stayed grey until a
  search or base filter click repainted them. Flipping the gate now repaints all four filter chip rows (a modal
  opened before the page reported ready kept them grey for the same reason), and switching source is no longer
  wrapped in the lock: the local index is a static read and the cloud index the host's own REST read. Covered by
  `studio/tests/js/pose-bridge.test.mjs`.

### Changed
- **Pose lock keeps a single control image: the 参考图区 shows one slot in 姿势 mode.** That mode eats exactly one
  control image, so the slot row now offers just that slot (its count reads 「参考图 N/1」) and no auto-grown empty
  「＋ 参考」 box. References carried over from a multi-reference mode are trimmed to the first when the shot switches
  into 姿势, and a prefilled batch - the asset library's 复制到参考图区, the 姿势 page's 送进图片编辑 - keeps only its
  first control image, so the request sends 原图 plus one control image. Covered by
  `studio/tests/js/gallery-image-edit.test.mjs`.
- **The 姿势 edit mode is a ControlNet shot now, and the `qwen_image_21_pose_edit` preset is gone.** Picking 姿势 in
  the image-edit panel selects **Qwen Image 2.1 ControlNet**: the 原图 supplies content and face, and the image in the
  first reference slot locks pose and composition through the model patch. Two images are required, and the mode row
  says so. The new **控制图免检测直连** detent is on by default - a skeleton / depth / normal / lineart / silhouette
  image goes straight to the patch, because running a skeleton through Openpose detects it twice and a depth map
  reaches a body detector that finds no body; uncheck it when the control image is a photo of a person, which keeps the
  Openpose path. The detent travels in the request (`control_direct`) and in the sidecar (`direct=1`), so 再来一发
  replays the same path. The old text pose-transfer preset is removed - it never locked the shape - and the home card
  reads 「骨架图锁姿势，重出这一张」. Covered by the pose-mode case in `studio/tests/js/gallery-image-edit.test.mjs`,
  the direct-chain cases in `studio/tests/test_image_gen.py` and the sidecar case in `studio/tests/test_gallery_copy_to_input.py`.
- **The 绘画 and 视频 prompt boxes shrink to the 编辑 page's scale.** The 绘画 page's composer box no longer opens
  110–150px tall: it floors at two lines (64px, `max-height: 26vh`) and grows by dragging its bottom edge, so the freed
  strip goes to the result area above it. The 视频 page's composer capsule docks at 980px centred (was 1120px) with the
  same two-line box, and the box no longer stretches to the height of the 首帧 / 尾帧 / 参考图 squares next to it. Phones
  keep the taller three-line box (88px floor) for touch. Covered by the new composer width/height cases in
  `studio/tests/e2e/paint-panel-layout.e2e.mjs` and `studio/tests/e2e/studio-mobile-layout.e2e.mjs`.
- **The Studio window opens on the 输入 page: 绘画 is text-to-image only, 编辑 is image editing only.** The
  former 绘画 tab held the text-to-image composer with the 图片编辑 panel hidden inside it; the tab is now two
  pages - **输入** (the prompt composer, `#/paint`) and **编辑** (image editing, `#/edit`) - so the bar reads
  首页 / 画廊 / 输入 / 编辑 / 视频 / 导演 / 姿势, and the window starts on 输入. What used to route into the
  painting page now routes into 编辑: the 「编辑」 button on a gallery image card, `openImageEditor()` from the
  global-search and asset-picker callbacks, and the 「编辑」 action in the 画廊 guide page. 编辑 carries its own
  guide card (「拖入图片开始编辑」, 图片编辑 / 素材库 / 打开文件夹 buttons, the 拖拽编辑与对比 tip) on the same
  `/neo-studio/edit-guide` snapshot as before. The agent's page-context line reports the page by its own name
  (`编辑页`) instead of a 绘画 + 图片编辑 mode label. Covered by the tab list, deep-link and agent-context cases
  in `studio/tests/js/studio-paint.test.mjs`.
- **The 输入 page is a prompt-first composer.** The 参考图 boxes above the prompt are half the panel width and a
  drag onto them uploads straight into the first free slot; the 生成 button sits under the prompt at full width
  next to 随机, and the generated image appears below the prompt, centered. Under it one row carries
  重新生成 / 随机 / 保存 / 存到画廊, so a run's follow-up actions are all on the same screen as its result.
- **The 编辑 page keeps its input card on screen.** The preview fills the space above the card and the card is
  pinned to the panel's bottom edge, so a tall source image shrinks the preview instead of pushing the 生成
  button below the fold; the empty drop stage fills the preview area too. The 「原图 / 编辑结果」 label row and
  the 看大图 zoom button are gone - a click on the source follows the curtain / divider rule in every mode, and
  the lightbox opens from the source image, so 蒙版 / 点击 modes paint and mark instead of opening it. The 素材库
  button floats over the top-right of the page, above the 素材库 drop zone it opens. In 机位 the prompt box
  folds away (the orb, the arrows and the three sliders already set the words), and the 出图尺寸 width/height
  inputs open above the chip row instead of under it, where the page edge cut them off. On this page the prompt
  box is two lines tall - a 40px floor against the 110px composer height, with one step of card padding - because
  an edit instruction is one sentence, and the taller box was a fifth of the window for nothing.

- **The 3D Pose 「姿势库」 and 「道具」 windows search from the title bar and filter entirely by chips.** The
  search box of both windows moved out of the crowded filter row into the right side of the window's title bar (the
  asset-library shell grew a titlebar slot for it), and the pose window's remaining dropdowns are gone: the filters
  are one block of chips - the library source (「本机库」, plus 「云端库」 only when the cloud is configured),
  the base (「全部基座」plus the panel's two CC0 bases, defaulting
  to the figure on the canvas), the origin (「全部来源 / 预设（N）/ 本地（N）」, the group hidden for the cloud, whose
  `charKey` is outside the panel's base whitelist so switching to it falls back to 「全部基座」) and the groups
  (「全部分组」plus one chip per group with its count). Source, base and origin share one line with a hairline
  between them and the group chips wrap onto the next - four full-width rows stacked the header five deep and left
  the card grid two rows. One click filters the card grid; counts come from the rows
  the filter above each group leaves. The props window gained the same shape - 「全部分类（N）」/「程序化」/「注册表」/
  「云端」 chips above the cards, counted from the whole prop table, a chip filtering the cards and returning to
  page 1. A bucket with no prop shows no chip, and a pose package whose prop entries carry no source field shows no
  chip row at all. Covered by `studio/tests/js/pose-bridge.test.mjs`.
- **The 3D Pose 「姿势库」 header stops repeating its own counts.** The line above the card grid read
  「746 个姿势（预设 100 · 本地 646）· 显示 18」 while the origin chips already carry the preset / local counts and
  「加载更多（还有 N 条）」 says what is left, so the line is gone and the card grid gets the row back. The
  「本机姿势文件…」 button - the path you take when the library has nothing you want - is now pinned to the modal
  titlebar next to the search box instead of taking a slot at the right end of the filter block, where it also
  scrolled away with the cards. Covered by `studio/tests/js/pose-bridge.test.mjs`.

- **The 3D Pose page opens clean: no more blue 「网格引擎不可用 → 已回落到骨架·MediaPipe」 toast.** The packaged
  pose page ships with its 照片 → 3D engine set to a mesh engine and probes the local point-estimation service at
  page boot; that endpoint only exists in the pose repo's dev/preview server, so on the plugin and in the desktop
  window the probe always failed and the page toasted its fallback on every single entry. The host now pins that
  page preference to 「骨架·MediaPipe」 before mounting the frame - the only photo→3D path that works without the
  sidecar, and with the page's own toolbar folded away the mesh engines have no entry point on the canvas. The
  page's own toasts for what the user does (shortcuts, undo, scene validation) are untouched. Covered by
  `studio/tests/js/pose-bridge.test.mjs`, and `tools\test_pose_package.ps1` now checks the shipped bundle still
  carries that preference key so the pin cannot go silently stale.
- **The 3D Pose 「姿势库」 and 「道具」 windows close on the second click of their own toolbar button.**
  Both buttons opened a full-window browser, and every later click only repainted the same page of
  cards, so getting rid of that window meant Esc, the backdrop or the title-bar ✕. The same button now
  closes its own window - the rule the four small popups already had - and it stays lit while that
  window is open: Esc, the backdrop, the ✕, the window yielding to the other modal and the close after
  applying a pose all return it to the unlit state. Covered by `studio/tests/js/pose-bridge.test.mjs`.
- **Prop previews are white clay renders.** The prop grid mixed official render sources (Poly Haven photos,
  BlenderKit renders, our own clay renders) with black photo backdrops and colored objects, so a page of cards
  read as a color mosaic where the silhouette was hard to see. `tools\pose_prop_clay.mjs` now renders every
  prop with the packaged pose page itself (headless Chromium, `window.__poseDebug`): the prop is staged alone
  on a neutral backdrop, its textures are stripped down to a white clay material, and a 3/4 camera is fitted
  from its own bounding box - one 512 square per prop. `--apply` writes the images back into
  `models/props/preview/`, so every local card is now the same gray backdrop with a white model; the card style
  keeps a `grayscale(1)` pass for images that have not been re-rendered yet (the old cloud set).
- **The 3D Pose page is a canvas-first workspace: transparent toolbars over the canvas, popups on top of it, a
  pager in the props window, and no stray 「选择文件」.** The fixed side panels are gone; 「姿势库」「角色与外观」
  「道具」 sit on the left and 「保存姿势」「导出图组」「画布状态」 on the right. 「姿势库」 and 「道具」 open a
  full-window browser (the asset-library shell), 「保存姿势」 saves into `pose/scenes/` from its own popup, and the
  remaining three open a small popup - one at a time, closed by Esc, a click outside or the same button again. The
  props window lists the prop registry 120 cards per page behind a pager whose page index survives a reopen, and
  clicking a card adds that prop in one step: there is no 「添加道具」 button and no select-then-confirm step, and
  Enter in the search box or the name box adds the same way. The host's local pose-file picker no longer renders
  as a native 「选择文件」 widget in the canvas's bottom-left corner, and the page's own file inputs are hidden
  inside the iframe. Covered by `studio/tests/js/pose-bridge.test.mjs` and `studio/tests/test_pose_bridge.py`.
- **Cloud prop cards now carry previews.** The cloud pose manifest listed 24 props whose registry rows named
  no `preview`, and the bucket had no `props/preview/` files at all, so every card badged 「云端」 in the 3D
  Pose prop grid read 「无预览」. `tools\pose_prop_previews.py` fills that layer: for each prop it takes the
  official render from the source page its own registry row names (Poly Haven's `thumbnail_url`, BlenderKit's
  largest asset thumbnail, the shipped render for the self-made props), writes `preview/<id>.png` and adds
  `preview` to that manifest row - `hidden` cards publish nothing, `--apply` is what touches the cloud, and
  the pre-change manifest is kept in `<out>/index.before.json`. `tools\pose_deploy_oss.py` now matches the
  conventional `preview/<glb stem>.png` when a registry row names no preview, so the upload list and
  `tools\pose_prune_oss.py`'s allow-set keep publishing and keeping the same previews. Covered by
  `studio/tests/test_pose_prop_previews.py` and `studio/tests/test_pose_deploy.py`.
- **The 3D Pose panel lists only the poses saved on this machine, and the character list is the two standard
  bodies.** The left column is now the machine's own `pose/scenes/` archives, each row badged 「本地」- the
  preset poses are already in the pose library, so the left column no longer lines them up a second time and a row
  click loads a pose through the same path the 「载入姿势」 button uses. 「浏览姿势库…」 is a preset's only
  entry: the modal keeps the library's entries grouped by the index's own groups with 「预设」/「本地」 origin
  badges, and applies a row's own scene file in one click. There is no separate 「预设姿势」 section, no
  「套用预设」 button and no preset dropdown in the right column. The search box above the list filters the
  archives by name, 120 rows per page behind 「加载更多」, and an empty result says so. The character dropdown
  offers only the standard bodies the package reports (`bodyMale` / `bodyFemale`), so Mixamo, the SMPL-derived
  bodies and any user-supplied GLB
  no longer show as options that only fail; 「导入自备素体」 is gone and the host's `/neo_pose/import_model`
  route is not registered anymore - registering those bodies stays in the pose page's own local import area.
  The ControlNet export view defaults to 「当前视角」, exporting from the camera the user already framed.
  Covered by `studio/tests/js/pose-bridge.test.mjs`, `studio/tests/test_pose_bridge.py` and
  `app/tests/test_studio_server.py::PoseBridgeTests`.
- **The 3D Pose left column's search box is one row, not the column's height.** The column's pose list grows to
  fill the column, and the search box sat under two grow rules at once - the list's own `flex: 1 1 auto` and the
  pose-library modal's `flex: 1` search-field rule, which the box shared a class with: with nothing saved the
  placeholder floated in the middle of the column with 「没有匹配的姿势」 on its own level. The search box is now a
  fixed row above the list, the modal's search-field rule is scoped to `.ns-pose-libpane`, rows and the no-match
  line start at the top of the column, and the no-match line reads as a plain line without a row frame. Covered
  by `studio/tests/js/pose-bridge.test.mjs`.
- **「摆姿」在界面上统一叫「姿势」.** 顶栏 tab、姿势页控件、姿势库弹窗、启动设置与文档里的中文文案全部改成
  「姿势」（`摆姿模式` → `姿势模式`、`摆姿仓库` → `姿势仓库`、`进入摆姿模式` → `进入姿势模式`），动词语法保持成句
  （`摆姿势`、`可摆姿势`、`纯摆姿势`）；英文文案仍是 Pose / Pose 3D，路由、节点名与配置键不变。
  姿势仓库与随包姿势包同批改名，页面读到的文案一致。
- **The cloud pose upload publishes only the shipped preset library.** `tools\pose_deploy_oss.py` takes the
  pose repo's `pose-lib/` as `--source` and refuses the merged `<data root>/pose/lib` (its entries carry an
  `origin`): `pose-lab` is the author's experimental set and never belongs on the public bucket.
  `tools\pose_prune_oss.py` deletes every cloud key the manifest does not name. Credentials are read with
  the key names `studio/backyard.py` uses (`bucket`, not `bucket_name`), precedence command line >
  `OSS_*` environment > `<data root>/configs/backyard_oss.json`, so a stale `OSS_ENDPOINT` in the shell no
  longer silently redirects the upload.
- **Cloud props are gated by licence, not by the two-prop shipped whitelist.** `tools\pose_deploy_oss.py`
  reads each prop's licensing row in the pose repo's `public/models/ATTRIBUTION.md` and publishes only rows
  that grant redistribution: the CC0 props (Poly Haven, BlenderKit `cc_zero`) and the self-made `stick` /
  `sword` publish, while Royalty Free rows, unconfirmed local imports (`arrow`, `sting-sword`, the gun
  meshes), Mixamo personal-use files and the repo's own test bench boxes never do. Each published prop
  carries its prop-registry row (`scale` plus the grip metadata) in the cloud index, and serving
  `/models/props/index.json` adds those rows to the registry the pose page reads, marked `hidden` so the
  pose page's own panel never lists a prop it has not fetched. The prop cards now offer the cloud CC0 weapon
  and furniture set at the sizes the pose repo measured (a 0.28 m service pistol, a 2 m quarter-staff) beside
  the two bundled props; the shipped plugin package still ships only the self-made pair.

- **The 3D Pose prop picker is a grid of preview cards, and bone attach left the panel.** The pose page's
  道具 group lists one card per prop with its preview image - read locally from
  `/models/props/preview/<name>.png`, straight from OSS for a cloud prop, and from the pose repo's
  conventional `preview/builtin-<id>.png` for a procedural prop; a prop with no image reads 「无预览」
  instead of showing a broken thumbnail. A search box filters the cards by name, the count line names the
  selected prop, and 「添加道具」 sends the selected card's prop key (a name typed by hand resolves through
  the same lookup). The panel's 「挂到骨点」 button and 「挂点骨」 dropdown are gone: bone attach stays in the
  pose page's own panel and the page's `prop/attach` command is untouched, a prop added from the panel lands
  in a free spot the page picks, and each row of the on-stage list says where it landed - 「挂在 手部_右」
  for a prop carried by a bone, X/Z coordinates for a free prop. Prop preview PNGs ship with the pose package
  only for a prop whose registry row names them: `tools\build_pose_package.ps1` strips a `preview` the build
  does not have, and `tools\test_pose_package.ps1` refuses a preview PNG outside the shipped prop whitelist
  and a registry row that names a preview the package does not ship.

### Added
- **The 3D Pose scene library gained a cloud source.** With `pose_index_url` in
  `<data root>/configs/oss_presets.json`, the 「浏览场景库…」modal grows a "source: Local Library /
  Cloud Library" selector and lists the pose tree that lives in OSS: cloud cards carry a 「云端」 badge,
  their thumbnails load straight from the bucket, the group and search dropdowns work on the cloud entries
  on the same rules as the local ones, and clicking a card applies the whole scene after the host reads it
  through `/neo_pose/cloud_file` and keeps it under `<data root>/pose/oss_cache/`. Cloud props named by the
  cloud index show up as prop cards behind the local ones (badge 「云端」): adding one fetches the GLB into
  `models/props/` first and then travels the page's existing prop path, so the pose page itself needs no
  change. Without that config line the cloud option is not in the selector, the modal and the prop cards
  behave exactly as they did, and the modal shows the deployment hint (`tools\pose_deploy_oss.py` uploads
  the tree and prints the index URL to paste in) instead of an empty list. The cloud cache is an ordinary
  cache - delete `<data root>/pose/oss_cache/` and it rebuilds - and opening the pose page never contacts OSS:
  only the scene and prop files a click really needs are downloaded, once.
- 新增预设模型清单文档 [docs/preset-models.md](docs/preset-models.md)（英文 [docs/en/preset-models.md](docs/en/preset-models.md)）：把 37 个预设技能自带的 `models.json` 逐条摊开——族系与基座分组、文件名、模型类别、GB 体积、可点击即下载的 ModelScope / Hugging Face 直链与 Civitai 模型页链接；另附同样带直链的 CosyVoice3 语音合成必需文件表（该技能不读 `models.json`，权重走 `models/cosyvoice/Fun-CosyVoice3-0.5B/`）。

- **The desktop app now keeps the 3D Pose assets in sync by itself.** "Startup settings → Pose repo" takes a
  3d-pose-art repo root (with a folder picker, validated as a pose repo before it is saved), and every
  desktop start tops the pose assets up in the data root from it: the full pose build (`pose/dist`, so the
  pose page never stays on an older build) and the merged scene library (`pose/lib`, so the library modal's
  thumbnails never stay blank), the merged index rebuilt through the pose repo when the index is missing, a
  referenced preview is absent, or no entry carries the base-body (`charKey`) field yet. Saving the row
  starts one sync round on the spot. The sync only acts when the pose data is newer than the data root -
  relaunching an unchanged repo copies nothing - it refills files deleted by hand, and it never touches the
  scenes in `pose/scenes/` or the own figures imported into `pose/dist/models/`. Leaving the row empty keeps
  auto-sync off, and the shipped pose page hints now point at this setting beside the sync scripts.

- **The 3D Pose scene library now syncs the pose repo's preset set together with the local set.** The pose
  repo split its library into a read-only preset library (`pose-lib/`) and a writable local library
  (`pose-lab/`); `tools\sync_pose_lib.ps1` merges both into the single `<data root>/pose/lib/` copy the
  「浏览场景库…」modal lists - a local pose wins over a preset one of the same id, the preset set only
  fills gaps and never overwrites what the machine already has, and the merged index (with a per-entry
  `origin` tag) is computed by the pose repo's `npm run lib -- merged`. `ATTRIBUTION.md` of the preset set
  lands beside the library, and a local `categories.json` replaces the preset registry when it exists.
  The modal names the two origins 「预设」/「本地」 (English "Preset" / "Local").

- **The 3D Pose page now opens on the standard body.** The bundled pose package ships the project's own
  standard male / female base bodies `bodyMale.glb` / `bodyFemale.glb` (CC0 base meshes from MakeHuman
  Community's MPFB2) - `bodyMale` is the page's default base - and drops `ybot.glb`, so a fresh install
  opens on the preset body with the full character list, and the bundled package goes from 4.2 MB to 3.0 MB.

- **The Neo Studio integration package updates itself.** `Neo-Studio\tools\update_neo_studio.ps1` inside
  `NeoStudio-Minimal` fetches the update piece `Neo-Studio-<version>-package-update.zip` from the latest GitHub
  Release and refreshes only the Neo Studio code in the package - the app source, the plugin code copy under
  `ComfyUI\custom_nodes\comfyui-neo-studio\`, the `tools` scripts and the launch scripts - then tops up the
  dependencies in the package Python and runs the package self-check; a self-check item that fails
  only because you put models in the package is reported as a note, not as an update failure. The
  ComfyUI core, the required plugins, the package Python, the models and your data are left alone,
  and the update deletes nothing: every file it overwrites is copied first into
  `updates\backup-<old version>\` in the package root, and the plugin copy's `data_root.json`
  data-root pointer is excluded from the overwrite. A machine that cannot reach GitHub runs
  the same script with `-Zip <update piece.zip>` and a piece downloaded elsewhere; `-Version 1.6.1` pins the
  target version and `-DryRun` prints the plan. The piece itself comes from `tools\build_studio_update.ps1`
  and is published with each Release.

## [1.6.0] - 2026-11-04

- **The Model Hub list loads without Hugging Face.** The Model Hub list used to fail as a whole when
  `huggingface.co` is unreachable - the default endpoint does not resolve on mainland China networks, so
  the ModelScope tab opened with an empty repository list and a raw `getaddrinfo` error naming a host the
  user never picked. Now a Hugging Face list that cannot be fetched only skips Hugging Face when
  ModelScope is the source: the repositories, files and downloads on the ModelScope side work as before,
  and the list line reads "N repos · the Hugging Face list is unreachable". With Hugging Face as the
  source the failure is still reported, and the message (and a stalled HF download) names the remedy -
  set the mirror root URL as the HF endpoint in the hub's ⚙ settings. Covered by
  `test_list_repos_modelscope_survives_unreachable_hf`,
  `test_repos_route_modelscope_survives_unreachable_hf` and
  `test_repos_route_hf_failure_names_endpoint_fix` in `studio/tests/test_model_hub.py`, and the
  unreachable-source case in `studio/tests/js/model-hub.test.mjs`. The rule runs the other way too: with
   ModelScope as the source a ModelScope list that cannot be fetched skips ModelScope, the list line names
   every skipped source, and an existence probe that fails on the network is no longer cached as "this
   repository is on ModelScope" - a list pinned as ModelScope that then blew up on the file-list step was
   the failure this closes.

- **The Model Hub reaches the hubs through the system proxy.** Hugging Face and ModelScope requests now go
  through the proxy the browser uses, read from the registry, and fall back to a direct connection when that
  proxy port is not listening. A proxy client that takes over DNS leaves a direct connection unable to
  resolve any of these hosts, `hf-mirror.com` included; only the Civitai requests used a proxy before, so
  such a machine could not list, search or download from the hub at all. The file-list failure row names the
  network-and-proxy check as the way out, and it can no longer be picked as a file - picking it used to
  splice the error text into the landing path.

- **The skill list shows skill names only.** The 技能 + 自定参数 panel's left column no longer prints each skill's
  pinned main model as a second line under its name - a long model path in 11px type made every row two lines tall, so
  a dozen skills read as a wall of model names. Rows carry the name alone; the cross-family warning, which lived in
  that line with a `↻` prefix, stays in the row's hover title, where it was already being read. Covered by
  `studio/tests/js/gallery-gen-material.test.mjs`, `studio/tests/e2e/studio.e2e.mjs`, and both chip panel layout e2e
  fixtures.

- **Startup settings opens ComfyUI with one click.** The 设置 → 启动设置 kernel row carries a third button,
  「打开 ComfyUI」: once the kernel is ready it sends that kernel's address to the system default browser — the
  frameless window has no new tab to open, so the link goes through the desktop's `open_url` bridge and the window
  stays on the page it is on. The address is the live one: with the configured port taken the desktop starts ComfyUI
  on the next free port and the button opens that one, and in remote mode it opens the remote ComfyUI from the startup
  settings. Stopped and starting hide the button — opening a ComfyUI nobody is listening on is only a browser error
  page. Covered by `studio/tests/js/studio-kernel-open.test.mjs` and the remote-mode case in
  `studio/tests/js/studio-desktop.test.mjs`.

- **Startup log shows Neo Studio's own trace too.** In the desktop window, Studio 设置 → 启动日志 now carries two
  blocks in one panel: the ComfyUI console (`data/comfy_run.log`, as before) and the desktop's own startup trace
  (`data/studio_desktop.log` — startup state, service port, kernel ready / down, page jumps, `[web]` frontend errors),
  each with its own heading and filtered as a whole by source (全部 / 桌面端 / 内核), so reading the
  desktop side no longer means opening a file. Window drag-step lines stay out of the panel (one line per drag would
  push the startup lines off the tail); the file keeps them. A browser tab has no desktop trace to show, so it keeps
  the single kernel block with no headings and no filter. Covered by
  `test_offline_log_merges_comfy_run_and_desktop_log` in `app/tests/test_studio_server.py`,
  `studio/tests/js/studio-log-panel.test.mjs` and both Studio e2e log cases.

- **Settings are in the same order everywhere.** The Studio settings sidebar now runs 启动与连接 (启动设置 / 启动日志 /
  手机连接) → 生成 (LLM / 生图 / 生视频) → 智能体 (智能体偏好 / MCP 服务) → 语言与关于 (界面语言 / 关于), split by a
  text-free hairline (`.ns-settings-sep`) instead of group headings, so the sidebar shows one row per setting. The long
  panels are sectioned inside with their own small headings: 启动设置 into ComfyUI 位置 / 网络与端口 / 桌面窗口 (the start /
  stop buttons stay on top), LLM 设置 into 服务商与模型 / 远程连接 / 本地模型 (the last two hide their heading together with
  their rows, so switching to a local provider leaves no heading over an empty section), 生图设置 into 模型 / 输出. The 🅝
  settings popup in the ComfyUI top bar keeps the same order — the three generate tabs first, 界面语言 last, one line
  between them. Every tab, deep link (`#/settings?tab=..`), saved setting and save button works exactly as before.
  Covered by `studio/tests/js/studio-settings-groups.test.mjs`.

- **The desktop window never leaves the page you are on.** The Studio page now stays on the desktop port for the whole
  session: when ComfyUI gets ready the same page turns online in place — the capability table flips, the header queue
  entry and the VRAM readout appear, generation and the event stream reach the kernel through the desktop's own proxy —
  and stopping the kernel turns the same page back offline. Nothing navigates, so the tab you are on, the director
  script you were editing and the settings form you were filling all survive. 局域网监听, a ComfyUI you started
  yourself and a remote kernel behave the same: no full-page jump, no tab pulled back to 首页 twenty seconds after
  launch. The 「⤒ 主画布编辑」 entry opens ComfyUI's own page (a local kernel on this machine's address with the
  kernel port, a remote kernel on the address in 启动设置), since the canvas only exists there. Covered by
  `test_start_ready_flags_the_kernel_without_navigating`,
  `test_state_poll_flags_a_kernel_that_gets_ready_after_the_budget` and
  `test_attach_path_flags_the_kernel_without_a_page_jump` in `app/tests/test_studio_desktop.py`, the proxy / `409` gate
  / `/ws` relay cases in `app/tests/test_studio_server.py`, and `studio/tests/js/studio-flip.test.mjs`.
  The desktop answers `404` for a path it has no route for; `409 {"offline": true}` — the page's offline signal — comes
  only from a route that belongs to the kernel when no kernel is up, so a generated image no longer arrives together with
  a "This feature needs ComfyUI" prompt. The queue panel's 内存 readout reads the kernel's `/system_stats`, which is now
  in the forward list.

- **The tag chips count the whole library.** The 图片 / 视频 / 音频 / 角色图 / 姿势图 / 帧图 / 分镜图 counts cover every
  configured directory. Hiding a card on the home page only hides it there: with Output hidden the 视频, 姿势图, 帧图 and
  分镜图 chips stay lit, and a custom directory you hid keeps feeding its counts. A Cloud Presets directory lights the chips
  from its local cache - no index download, no network call - and the 角色图 chip counts it when the directory carries the
  👤 character mark; the thumbnail cache and `_index.json` are not counted, and the entries keep the `Cloud Presets/<目录>`
  addressing the lightbox and 送到节点 path use. Marking a parent character directory now also counts the images inside its
  subdirectories. Covered by `studio/tests/test_gallery_kind_filter.py`.

- **Both pose-page side panels collapse.** The scene library (left) and the control panel (right) each carry a
  sidebar-icon button in their head — a two-pane glyph whose filled pane is the panel itself, and that pane shrinks
  to a sliver once the panel is collapsed. A collapsed panel drops to a 34 px rail — the panel name written
  vertically, the button being the way back out — and the 3D canvas takes the freed column width, the whole width
  when both are collapsed. On a phone each panel collapses to a 34 px strip that spans the full width and the
  canvas takes the freed height and keeps the full width.
  The layout is remembered across page switches and window restarts, and the two buttons are not gated: with a
  missing package or an old pose package whose controls are all disabled, the panels still collapse. Covered by the
  「左右栏收起」 case in `studio/tests/js/pose-bridge.test.mjs` and the collapsed rail / row assertions in
  `studio/tests/e2e/studio-mobile-layout.e2e.mjs`.

- **The paint composer stays docked at the panel bottom in a short window.** Windows display scaling reports a
  physically 800px-tall window as 640 / 533 CSS px, and the 「矮窗口收成内容高」 rule hung on `max-height: 620px`, so in an
  ordinary scaled window the text-to-image panel shrank to its content height: the prompt box and the 生成 button floated
  in the middle of the window with the whole lower half empty. The collapse step is gone — the panel fills the column at
  every window height, the result area scrolls on its own when the window is short, and the page never scrolls
  vertically. Covered by the new 「输入卡钉在面板底边（窗口高 900 / 620 / 560 / 460）」 cases in
  `studio/tests/e2e/paint-panel-layout.e2e.mjs`, and the live 「面板铺满宿主净高」 assertions in
  `studio/tests/e2e/studio.e2e.mjs` (the assertions compared the panel with the host including its 12px padding, and the
  paint page no longer carries its own 显存条 — those stale readings moved into the header queue panel).

- **The pairing address is a NIC the phone can actually reach.** On a machine with Hyper-V / WSL adapters the QR carried
  `172.24.80.1` — the virtual adapter hostname resolution reports first — and the pairing page lived on a port bound to
  127.0.0.1 only, so opening the link on the phone reached nothing. The address now comes from the adapter list ranked
  192.168 → 10 → 172.16/12 with adapters named `vEthernet` / `Hyper-WSL` / `Loopback` pushed last: the NIC picked under
  启动设置 → 局域网监听 wins, then the last scanned address while it is still a physical adapter, then the top of that
  list. Opening up LAN listening now binds the desktop service to the picked NICs too, so the page and the pairing
  page answer on the LAN, and a private-range device uses this machine as a second screen: the gallery, the pose page,
  the recipes and the skills data routes work from the phone (with the gate set to the pair page only, the phone's
  gallery was empty and the pose page read 「后端未就绪」). The desktop-management surface - MCP, the launcher
  settings, restart / shutdown / log / memory, the 启动设置 page, the QR data on `pair/info` - and `/userdata/configs/`
  (where `remote_llm_config.json` / `backyard_oss.json` / `model_hub.json` live) stay loopback-only; public and
  link-local peers get nothing. Covered by `LanAddressTests` in `app/tests/test_mobile_pair.py`, `LanSurfaceTests` and
  `LanSurfaceMiddlewareTest` in `app/tests/test_studio_server.py`, and the new `lan_bind_hosts` cases in
  `app/tests/test_studio_desktop.py`.

- **The header status reading is never blank, and the right-side icons stay put.** The chip now paints a neutral
  「状态读取中」 while the desktop is still assembling (window just opened, F5, the pywebview bridge landing after the page
  script, the desktop service still binding), and swaps in the real reading as soon as it arrives; a page served directly
  by a running ComfyUI says 「运行中」, and the offline page invents nothing. The chip is a permanent flex slot with a fixed
  width that hides only its text, so 队列 / 设置 / the window controls no longer slide left and right when a reading comes
  and goes. A cold desktop service that answers the first status requests with `409`/`404` no longer kills the HTTP
  status source - three consecutive misses end it, so a real reading still lands.
- **Phone pairing from Settings works after the header moves the window onto ComfyUI's page.** There the page's relative
  requests hit the ComfyUI origin, where the pair routes do not exist, so the panel used to stop at 「读不到桌面端服务的
  配对信息」. Inside the desktop window it now reads the snapshot and rotates the token over the pywebview bridge
  (`pair_info` / `pair_rotate`), while a page pinned on the desktop-service port and a page in a browser tab keep using
  the desktop service; both channels yield the same address and the same QR. The bridge has no request `Host` header to
  read the phone-facing address from (the service side does), so it reuses the persisted `pair_host` and, the first time
  the panel is opened, the NIC address chosen under 启动设置 → 局域网监听, persisting it as the pair address. The code
  itself is now drawn from the encoder's module matrix (`qrMatrix` → `qrSvg`): the panel passed the URL text to the SVG
  formatter, which renders a square with no scannable modules, so the countdown ticked with the QR area blank.

- **Phone pairing from Settings (Wi-Fi only).** "Settings → Phone pairing" now shows a QR code and a pairing link when
  LAN listening is on. A phone on the same Wi-Fi scans the code, its browser verifies a one-time token at
  `/neo-studio/pair`, and the page hands back the `http://<LAN IP>:<port>/neo-studio` entry - nothing is installed on
  the phone. The token is valid 5 minutes, the panel counts it down, the QR regenerates at zero, and "refresh now"
  rotates it on demand; the panel is reachable from the LAN-listening hint too. With LAN listening off the panel names
  that setting instead of showing a code that could only fail, and the copy box and refresh button are hidden in every
  state where they could not work - they come back when there is a link to copy, or when a refresh is what produces one.
  The QR is drawn by a self-contained encoder
  (`studio/web/js/core/qrcode-lite.js`, inline SVG, no dependency), the pair page and token check answer LAN hosts only,
  and every pair reply is `Cache-Control: no-store`. Covered by `app/tests/test_mobile_pair.py`,
  `MobilePairServiceTests` in `app/tests/test_studio_server.py`, `studio/tests/js/qrcode-lite.test.mjs` (round-trip
  through its own decoder) and `studio/tests/js/pair-access.test.mjs`.
- **The header carries six tabs, and 队列 / 设置 are icon slots.** The 技能 tab and the 智能体 button left the header: 技能 and
  智能体 are entered from their Home cards (技能 under 素材与配置, 智能体 under 开始创作), and 设置 is now a gear slot at the
  header's right end sitting right after the 队列 slot - the tab strip keeps its width for the pages you create in, and neither
  right-end slot carries text. The 队列 count badge moved onto the icon's top-right corner inside the button, so a 44px
  touch-tier button clips none of it, and the touch tier gives both slots the same 44px target as the tabs. Covered by
  `studio/tests/js/studio-desktop.test.mjs` (header structure: 6 tabs, 队列 before 设置, no agent entry),
  `studio/tests/js/studio-language.test.mjs` (icon-slot titles translate), `studio/tests/js/studio-queue.test.mjs` (badge
  placement + injected icon), `studio/tests/js/studio-agent-skill.test.mjs` (the Home card is the only agent entry) and
  `studio/tests/e2e/studio-mobile-layout.e2e.mjs` (fixed-width slots, one header row at 390 and at 1440).

- **The painting page fills the window in a narrow desktop window, and the header tab strip stops stacking.** A 900×1200
  Studio window folded the painting page down to content height - the 文生图 / 图片编辑 composer floated in the middle of the
  window with its bottom half left as window background - because the phone tier's `height: auto` rode on `max-width: 900px`,
  so a window narrower than 900px was treated as a phone. That rule keys on window height (`max-height: 620px`), the shape it
  was solving for: above it the painting page fills the viewport and its composer sits on the panel's bottom edge the way the
  video page dock does (measured 29px above the window bottom at 950×700, 1265×1225 and 1440×900). The header tab strip is one
  row at every width - tabs no longer break into 3-line slivers between 720 and 900px - and it sits flush against the 队列
  slot when the tabs fit, switching to left-packed scrolling when they do not: `showView` measures the tab widths plus the
  gap, because a right-packed overflow lies left of the scroll origin, where `scrollWidth` and a swipe both read zero. In the
  phone painting composer the 技能 / 尺寸 / 自定参数 chips now give their width to 生成, so 生成 is reachable without scrolling
  the bar, and a `[hidden]` window-control group no longer reserves its 154px of the header. Covered by
  `studio/tests/e2e/studio-mobile-layout.e2e.mjs`, whose tab-strip probe now scrolls the strip and reads `scrollLeft` back
  (the app's own width measurement, replicated the way the file already replicates `scrollIntoView`) instead of comparing
  `scrollWidth` with `clientWidth`.

- **The standalone Studio page now fits a phone.** Opening `http://<LAN IP>:8188/neo-studio` in a phone browser
  (390×844) used to open the desktop layout: the page min-widths pushed the whole page into horizontal scrolling, the
  Director / Skills / Settings / Pose pages kept their side-by-side columns as two unreadable slivers, the video
  composer pill stayed a 430px capsule floating over the clips, and the gallery's six hover-only controls (thumbnail
  button bar, bookmark star, directory row's 隐藏/删除/设置, card-corner LoRA 取用 / 目录菜单 / 收藏保存) never
  appeared because a finger leaves no hover state. Two media queries now carry the phone tier: `max-width: 720px` for
  the layout (single column everywhere, tabs in one scrollable row with the selected tab scrolled into view, pages
  flush to the viewport, the composer pill full-width and clear of the bottom gesture bar, the 620px director
  min-width and the split-bar's inline widths released) and `hover: none and pointer: coarse` for touch behaviour
  (those six controls permanently visible, long-press callout off, inputs at 16px so iOS focus no longer zooms the
  page and stays zoomed). `index.html`'s viewport meta gains `viewport-fit=cover` and the safe-area insets are spent
  on the header and the composer pill. Desktop wide-window and ComfyUI sidebar layout are untouched, and the same
  shapes are asserted in reverse at 1440×900. Covered by `studio/tests/e2e/studio-mobile-layout.e2e.mjs`.

- **Picking a model in the 自定参数 panel no longer closes the panel - 完成 is the only way out.** The
  技能 + 自定参数 panel on the video page collapsed the moment a 主模型 / VAE / LoRA row was picked. The combobox
  closes its body-mounted list inside the list item's `mousedown`, so the release lands on the page element under the
  closed list and the browser fires `click` on the nearest common inclusive ancestor of the press and release points -
  `document.body` on that page - which the page's document-level "close the chip on an outside click" loop read as a
  click outside the panel. The three chip close loops (`studio/web/studio/studio-app.js` video page, two in
  `studio/web/gallery-gen.js`) now close on the press (`pointerdown`, capture) the way the top menu, the collect menu
  and the chat auto-menu already do: the press's target is the list item itself, which `inOpenComboList()` already
  counts as an inside click. Covered by `studio/tests/js/studio-video.test.mjs` (picking a VAE keeps the panel open and
  writes the value, 完成 closes it, an outside press closes it).

- **A preset that pins a custom mix your machine does not have now runs on the family's base model - and tells you.**
  With `configs/image_gen.json` pinning `Krea2\Moody\moodyKrea2Mix_v40INT8CONVROT.safetensors`, every generation of
  that preset was refused with 「缺 1 项 · 13.49 GB」 while the family's `krea2_turbo_int8_convrot.safetensors` sat on
  disk: readiness demanded the exact pinned path and `resolve_model` rejected it at generate time. A pinned name that
  is not on disk now falls back to the default model the generation side picks - image generation only, video keeps
  its all-or-nothing recipe: the 自定参数 banner reads 「配置里的 X 本机没有，已回退默认模型 Y」 with no download
  button and generation submits, and the same sentence arrives as a toast with the submitted task. A manifest file
  with no family file on disk still blocks, and a file that is already on disk is still never planned.
  Covered by `studio/tests/test_skill_models.py`, `studio/tests/test_image_gen.py` and
  `studio/tests/js/skill-models-preflight.test.mjs`.

- **A preset weight now lands in its family folder, and a file you already have is never offered again.**
  Preset downloads from the 自定参数 gap banner used to land in `models/diffusion_models/diffusion_models/`
  (the repo path's own category segment became the subfolder) and were planned even when the file was already
  on disk: the banner blamed a 13.49 GB file you had just downloaded, and pressing 下载 was answered by the
  Model Hub with 已存在 - a dead loop. Plans now drop the repo's category segment and land in the preset's
  family folder (`models/diffusion_models/krea2_image/<file>`, like the `QwenImage2.1/`, `MiniMaxH3/` folders
  on disk), a file whose name the category tree already answers is left out of the plan, and the banner stops
  promising a download: it names the model your config pins that is not in the model root
  (「配置写死的 X（类别 · 不在模型根里）」) and its button is ⬇ 去模型库, where picking a real model is the way out.
  Covered by `studio/tests/test_skill_models.py` and `studio/tests/js/skill-models-preflight.test.mjs`.

- **Choosing a skill with unpicked models now says so inside the popup - and fixes it there.** The manifest check
  used to bite only at the moment you pressed Generate. Pick the preset in the skill picker's left column or in the
  自定参数 panel and the panel itself writes "missing N model files (about X GB): \<files\>" on top of the model rows.
  The banner's one button repairs it in place: it builds that preset's download plan, feeds it to the Model Hub
  download, writes the live progress (percent · downloaded / total · speed) on the banner - the button is 取消 while
  it runs - then re-reads the manifest, collapses the banner and posts a 预设模型已补齐 toast once the files land.
  With two or more gaps each gap row also lights its own ⬇ 模型库 link for precise positioning; with a single missing
  file the banner is the only entry, so one gap never shows two buttons for the same target. When the plan needs a
  token first nothing is downloaded: the banner names the precondition and its button becomes ⬇ 去模型库 (a muted
  模型库 text link always offers the full plan, sources and token settings). Custom skills with no manifest and ready
  presets show nothing. The panel's own clicks now stop inside the panel (the 自定参数 chip closes the panel, and the
  dialog with it, on any click its document-level loop reads as an outside click — the banner's download, a LoRA row
  and the row hub buttons all used to read that way). Covered by
  `studio/tests/js/skill-models-preflight.test.mjs` and `studio/tests/js/gallery-gen-material.test.mjs`.

- **The auto model pick no longer grabs a weight out of the video-model tree.** A Krea2 mix stored under
  `MiniMaxH3\` matched the image name clue, so with the Krea2 folder deleted the 生图模型 row filled itself
  with `MiniMaxH3\NSW\moodyKrea2Mix_...` and the run died in the loader nodes. The auto pick now reads only
  the image weight directories: when the only name-clue hit lives in a video-model directory, the row stays
  「自动」 with no model name and submitting reports 没有找到可用的默认模型 instead of queueing a model that
  cannot run. Tests: `studio/tests/test_image_gen.py` (`SuggestTests`).

- **A missing model now says where to get it, and a blocked generation never reaches the queue.** The model rows
  of the image-generation settings (the skill detail's left column, and the gallery's 生成素材 / 图片编辑 custom
  parameters) gained a **⬇ 模型库** button on the row whose field the preset's `models.json` marks missing: clicking
  it opens the Model Hub with that file's source, repository, drop-in category and file name already picked, and the
  tooltip carries the size plus the Hugging Face authorization note when the recommended source is gated. A
  generation submitted for a preset with a manifest is checked first (`GET /neo_skill_models/check`): when a file
  the run needs is not in the local model root, the task is not posted, the failure reads
  "{preset} is missing N model files (about X GB): …" and the notification offers **去模型库 (Open Model Hub)**,
  which opens the hub straight on that preset's download plan. A preset with no manifest, a request with no skill
  attached, and an unavailable manifest route all keep generating as before - the preflight and the row buttons stay
  hidden rather than advertise a target that cannot be resolved, and a stale path keeps its "(缺失)" mark in the
  dropdown. The skill repair dialog reads the manifest as well: a missing entry opens the hub on the manifest's
  source and repository, falling back to the stale file name plus category for custom skills. Details:
  [docs/image-gen.md](docs/image-gen.md), [docs/model-hub.md](docs/model-hub.md). Tests:
  `studio/tests/js/skill-models-preflight.test.mjs` (blocking and fail-open paths, the hub deep link, the row
  buttons and their manifest targets).

- **Every built-in preset now declares the models it needs, and the backend reports what is missing.** Each
  preset under `studio/skills/presets/` that uses local model files ships a `models.json`: drop-in category,
  preset-relative file name, size, and the ModelScope / Hugging Face / Civitai sources it can come from
  (`gated` marks the entries that need authorization on HF first). Family presets share one base manifest
  through `extends`, so the same file is never counted twice. New routes `GET /neo_skill_models/check`,
  `GET /neo_skill_models/all` and `POST /neo_skill_models/plan` (`studio/skill_models.py`) report per-file
  readiness for one preset, the family-grouped overview of the 37 manifest presets, and a download plan whose
  entries post straight to the Model Hub's existing `/neo_model_hub/download` - the plan follows the hub's
  current source, marks a file `not_on_source` when it lives only on the other source, and reports
  `needs_token` / `has_token` so a source that needs an HF token or a Civitai key says so. Readiness follows
  the generation side: a pinned config name is looked up by that exact relative name, an empty name matches the
  recommended name and the family variant names anywhere in the category tree, and a LoRA counts only when it
  is in the preset's LoRA list. All three routes read files and hub settings only, so the desktop window
  answers them offline; generation itself is unchanged, and the four presets with no local model files
  (`translate`, `translate_to_chinese`, `translate_to_english`, `cosyvoice_voice`) ship no manifest and report
  `has_manifest: false`. The Model Hub window (🅝 → 模型库) gained a **预设就绪 (Preset readiness)** panel that
  turns that into one clickable path: the family overview with a "missing N · X GB" badge per family, a per-preset
  plan on the hub's current source (optional files included by a tick), "Download all" feeding the plan into the
  hub's single download slot item by item with the existing progress bar and cancel, and a readiness re-read when
  the plan finishes - a missing model goes from a red badge to a landed file inside the same window. Details:
  [docs/model-hub.md](docs/model-hub.md), routes in
  [docs/api-routes.md](docs/api-routes.md). Tests: `studio/tests/test_skill_models.py` (manifest degradation,
  extends merge, readiness rules, plan payloads through the hub's own validators, and a static check of all 37
  shipped manifests) plus `studio/tests/js/model-hub.test.mjs` (overview, plan request shape per source,
  sequential plan queue, readiness refresh after the queue, cancel breaking the queue).

- **The 参考图编辑 preset is gone, together with the plugin it needed.** `image_gen_image` was the only built-in
  preset whose graph called `Krea2EditModelPatch` / `Krea2EditGroundedEncode`, and those two nodes only exist when
  `comfyui-krea2edit` is installed - a plugin the minimal ComfyUI package does not ship, that fails to import on
  ComfyUI 0.42.5 (core `nodes` no longer exposes the `List` typing member it patches in), and that owns the Krea2
  Edit model download path. The preset is removed from `studio/skills/presets/`, so a fresh data root no longer
  seeds it and the skill picker no longer lists it; the reference-image edit path in 图片生成 (the inline
  `{{REF_IMAGE}}` canvas + LoRA slot chain in `studio/image_gen.py`) is unchanged and keeps its tests.
  `tools/minimal_plugins.json` records the plugin as excluded, `studio/tests/test_minimal_package.py` fails if any
  shipped preset asks for its nodes, and `tools/check_minimal_package.py` fails a package that carries a trace of it.

- **A minimal ComfyUI + Neo Studio package now builds from this repo.** `tools\build_minimal_package.ps1` assembles
  a portable folder - ComfyUI core, the plugins the built-in presets actually need (pinned to commits in
  `tools\minimal_plugins.json`), the Neo Studio app plus its installed plugin copy, portable Python, an empty
  `ComfyUI\models\` tree and relative-path launchers (`NeoStudio.bat` → `NeoStudio.vbs`): no models, no
  plugin-bundled weights, no `.git`, no caches, no user data, no API keys and no development drive-letter paths.
  Every dependency (torch + CUDA, ComfyUI's, the plugin's, the desktop app's) is installed into the package's own
  `python\` at build time, so the target machine only double-clicks `NeoStudio.bat`; `setup_runtime.bat` and
  `setup_app.bat` stay as the repair path after `python\` is replaced. `组件清单.md` inside the package says which
  model goes where. Two checkers back it:
  `tools\check_minimal_package.py` (source mode compares the nodes every preset needs with what ComfyUI core,
  `comfy_extras` and the installed plugins register; package mode also audits layout, empty models, drive-letter
  paths, secret files, excluded plugins, and that each manifest `import_smoke` dependency imports inside the
  package Python) and `tools\verify_minimal_package.ps1` (manifest plugin set, shipped
  preset set, setup scripts, size). Details: [docs/release.md](docs/release.md).


- **The 3D Pose page's left panel is one 场景库 (Scene Library) now.** Its pose half - 姿态名, 存为姿态,
  载入姿态, 删姿态 and 浏览姿势库… - drove the old single-body pose folder
  (`<data root>/pose/presets/`), and that is exactly the thing the SceneFile migration replaced: every card the
  library holds is a whole scene (people + props + camera). The panel keeps 场景名, 存为场景, 载入场景 and
  浏览场景库…; clicking a saved scene loads it in one click, and the browse dialog is a single grid of library
  cards that apply through `scene/apply`, with 本机场景文件… for a file off the library. The four
  `/neo_pose/preset*` routes go with it: the library stays read-only, and a scene is the only file this page writes.
  A card hands its own file to the pose page's `scene/apply` command over `pose:call` - the page stages every person
  in that scene (adding the missing figures) and applies the scene's own camera, so a two- or three-person card
  arrives as the whole scene instead of the one figure already on the canvas. When the page cannot stage it, the
  panel reports the page's own reason and keeps the dialog open. Card subtitles read `N人 · M道具`, so the headcount
  is visible before picking, and the thumbnail carries a `参考图` (reference render) badge: a library preview is
  rendered from the scene file itself - the pose repo clears the stage to one figure per rig, empties the props
  and switches off everything outside those subjects before the shot - so the picture's headcount is the file's,
  and the toast reports what the page staged.

- **Pose library entries carry hands, multiple people and props.** The importer now reads 21 MediaPipe hand landmarks
  for every detected person and writes the finger bones from them, so a card keeps an open hand, a fist or a grip
  instead of the flat bind pose; `derived.openpose` gains `hand_keypoints_2d` / `hand_keypoints_3d` (21 × 3 per hand,
  `hand_order` names the sides). Photos with two side-by-side people become one whole-scene card
  (`3dpose.scene/1`, `kind: "scene"`) that stages both skeletons and, for the weapon reference folders, a prop
  attached to the weapon hand - `glb:stick.glb` for 功夫姿势, `glb:sword.glb` for 剑攻击姿势, `builtin:bow` for the
  bow and archery folders. Both prop GLBs are generated from the procedural parts table
  (`node scripts/makePropGlb.mjs --builtin <key>`), so they are self-authored and ship with the plugin package; the
  bundled prop registry lists exactly those two. The pose library dialog badges a scene card with `N人 · M道具`,
  applies it through the new `scene/apply` action (which tops up the skeleton count, lays them out left to right and
  restores props by id), and the 3D Pose page's bundled build is regenerated so the hand panel is available offline.

- **The pose importer skips a photo it cannot trust instead of saving a half body.** `--persons` now keeps only
  people whose legs are visible; a photo whose every detection box fails the phantom check is reported as a failure
  and nothing is written, and an entry that used to be a single-person pose is replaced in place when it becomes a
  scene (same id, the other file is pruned, so the library never shows two cards for one photo).

## [1.5.0] - 2026-10-31

- **The MCP tab works while the window sits on the ComfyUI port.** With LAN listen, or when the desktop attaches to a
  ComfyUI it did not spawn, the window lands on the ComfyUI port, where `/neo_mcp/*` does not exist: Settings →
  MCP 服务 answered "the desktop service is not ready" and the registry never listed. The desktop now appends
  `?neo_desktop=http://127.0.0.1:<desktop port>` to that navigation target, the page routes the MCP family back to the
  desktop port, and the desktop service answers CORS for loopback origins only (preflight `204`, a non-loopback
  origin's preflight `403`). Direct mode is unchanged — that page already sits on the desktop port — and a remote
  ComfyUI page keeps the offline note, since its origin is not loopback.

- **The asset library got quick-filter chips for virtual kinds.** A row under the home toolbar aggregates the whole
  library by type and purpose: 图片 / 视频 / 音频 / 角色图 / 姿势图 / 分镜图 / 帧图, each chip carrying its own count.
  Clicking a chip opens the aggregated waterfall of exactly that kind - sorted by modification time, covers
  lazy-loading, and drag-into-node, multi-select, delete and the lightbox behaving exactly as in a directory view;
  the breadcrumb shows the chip name, back and 返回上级 follow the same browsing trail, and Esc leaves the view.
  Nothing moves on disk: a chip is a virtual filter over `GET /neo_gallery/kind_items`, which scans the directories
  the home page shows (three levels deep at most, hidden entries skipped, cloud presets excluded) and returns the
  counts plus the first 400 items of that kind. 角色图 covers `output/CharacterSheet` and the directories marked as
  character images in directory management (a marked parent marks its children); 姿势图 and 帧图 also match the
  `pose_` / `frame-` filename prefixes exported before those directories existed. A kind with nothing in it gets no
  chip, and the row hides itself when the library holds fewer than two kinds.

- **The Pose page has no 导入素材 (Import Asset) bar any more.** The pose view's top row - the 3D Pose
  title, the bridge state pill and the 导入素材 button - is gone, so the page opens straight on the pose
  library, the canvas and the control panel. Picking an asset-library card as a reference plane went
  with it: `/neo_pose/import_image`, `/neo_pose/refs/{name}` and `<data root>/pose/refs/` no longer exist
  and the host no longer sends `neo:import-image`. Nothing else moved - poses, scenes, ControlNet exports,
  canvas snapshots and 导入自备素体 (Import Own Character) all stay.

- **The 3D Pose page browses the pose library in a dialog.** 载入姿态 (Load Pose) knew only a name typed into the
  field and 载入场景 (Load Scene) only the flat list of saved scenes, so the library 3d-pose-art accumulates -
  hundreds of poses with their `clay` / `skeleton` / `silhouette` / `depth` previews - had no way in. Two buttons
  beside them, **浏览姿势库…** (Browse Pose Library) and **浏览场景…** (Browse Scenes), open one dialog on the asset
  library's shell: the pose pane lists the synced library with a search box, a group filter, preview thumbnails and
  a 200-card window that grows on demand, the scene pane lists the scenes in the data root, and both panes carry a
  local-file picker, so a `.pose.json` or a scene `.json` from anywhere loads without being copied in first. A
  library entry is a plain PoseFile, so it goes through the same `pose/apply` and `pose:open-scene` the typed path
  uses. The library lands in `<data root>/pose/lib/` through
  `pwsh tools\sync_pose_lib.ps1 -Source <3d-pose-art repo root>` (`-Light` / `-All` pick the preview tiers); until
  it is synced the dialog shows that command instead of an empty list, and the page itself keeps working.

- **The "Generate material" dialog no longer asks for a skill config before a skill is selected.** Opening the dialog
  when the model list answered before the skill list fired `GET /neo_image_gen/skill_config?skill_id=`, which the
  backend rejects with `400` and the browser logged a red failed request on every open. The dialog now applies the
  skill config only after the skill list lands, then replays the selected skill's own defaults
  (main model / LoRA / ratio / longest edge).

- **The Studio desktop page keeps loading on older WebKit browsers.** Some macOS WebKit
  builds expose `crypto` without `crypto.randomUUID`, which crashed Studio shell startup
  with only the top bar visible. The client id generator now falls back to
  `crypto.getRandomValues`, and node instance UID generation uses the same fallback.

- **The desktop launcher now runs on macOS.** Windows remains the full local desktop path
  (ComfyUI spawning, Job Object cleanup, WebView2 window controls and `%APPDATA%` fallback).
  macOS v1 ships the remote ComfyUI path, uses the native title bar by default, and splits the
  platform-specific plumbing through a shared child-spawn helper: Windows uses the named mutex
  singleton, `NO_WINDOW` child spawning, Win32 alerts and `%APPDATA%`; macOS uses `flock`,
  `start_new_session`, `osascript`, `~/Library/Application Support` and Cocoa. Settings now expose
  `remote_ok` / `remote_down`, hide the frameless toggle on macOS, and desktop tests skip
  Windows-only behavior on macOS while covering POSIX process behavior. macOS remote-only `.app`
  packaging lives in `tools/build_studio_mac.sh` and produces `tools/Neo-Studio.app`.

- **The asset library toolbar has a rescan control.** Files written by an external run, a model download, or a
  hand-copied folder did not show up without a full page reload: the toolbar now carries a **⟳** (Rescan) button
  beside back / forward. It re-reads the listing on the spot - the current folder is re-opened in place, the home
  and bookmark views redraw from a fresh directory tree - and the click does not add a navigation entry, so back
  still returns to where you were before.

- **The Paint page's result sits against the prompt card.** The text-to-image result area grew only from its own
  content while the card was pinned to the panel bottom, so a finished image left a full blank band between it and
  the prompt box. The result area now fills the space above the card and anchors its content to the bottom edge,
  so progress and finished images grow upward from the card; the start hint still centres itself.

- **The LoRA dropdown keeps the whole column in the chip's parameter panel.** The 技能 / 自定参数 popup capped each
  column at 320px, so a single column squeezed the LoRA model dropdown to roughly 250px - long model names were
  truncated and the strength field plus the ✕ wrapped onto their own line. Columns now follow the panel width, the
  **+ 添加 LoRA** button takes its own line under the list instead of eating the row's width, and a popup under
  720px wide stacks its two columns into one.

- **The pose panel applies a pose in one click.** Picking a preset used to be a two-step act: the dropdown only
  filled itself, and the pose had to be applied with a separate **套用预设** (Apply Preset) button - the same second
  step the pose library had, where clicking an entry only marked it selected and **载入姿态** (Load Pose) did the
  work. The preset dropdown now sends `preset/apply` as soon as the value changes, and a pose-library entry reads
  that file back and sends `pose/apply` on the click. The Apply Preset button is gone; Load Pose stays for a name
  typed into the field.

- **The Pose page's 导入素材 puts the picked card on the tracing plane.** Clicking it used to hand the pose page a
  `/view` URL built from the card's filename and subfolder: `/view` reads only ComfyUI's output and input trees, so a
  card from a custom directory, a bookmark, or the OSS preset cache resolved to an address the page could not fetch,
  and the click drew nothing while the toast claimed it had been sent. The picked card now goes through
  `/neo_pose/import_image`, which resolves the library's own coordinates, copies the image into
  `<data root>/pose/refs/`, and replies with the address the pose backend serves itself; an asset that is missing or
  is not an image now reports the reason in the toast instead of doing nothing at all.

- **Video frame extraction gets its own Studio page.** Opening a video in the library and wanting a frame out of
  it used to have no path: the only way was to hand the clip to ComfyUI and load the result back. The home card
  **视频抽帧** (Video Frame Extraction) opens a page that plays the clip and drags the start point along the
  progress bar, queues the timestamps after it by the frame count and gap, and shows every captured frame as a
  card. Frames are
  captured in the browser - seeking the player and drawing it onto a canvas - and each PNG is saved on its own
  request into `output/Frames`, so the library browses them like any other generated asset; a frame name carries
  its timestamp (`frame-00_07_125.png`). The backend adds only two routes: `/neo_frames/video` serves the chosen
  clip with range support, which is what makes a seek land on that timestamp instead of the first frame, and
  `/neo_frames/save` writes one PNG. Both are answered by the desktop service without a ComfyUI runtime, so
  extraction works in the window with the kernel switched off. Picking a local file stays in the browser and never
  uploads. The page ships with its own view (`studio/web/frames/frames.js`) and does not share code with the Pose
  page or the gallery.

- **Prompts now name the references they attach.** A reference on an H3 reference-to-video skill conditions the model
  on its own; the `<Picture N>` / `<Video N>` / `<Audio N>` tag says what that reference is for, and a prompt written
  without those tags left every attached reference without a stated role. The video page, the director's segments and
  the multi-frame chunks now append the missing binding line for every supplied reference kind, using the same
  per-kind 1-based numbering the prompt audit applies, and leave prompts that already name their references as they
  are. First frames of the image and first-last-frame skills keep getting no tag: they bind through the first-frame
  anchor, not a reference slot.

- **The 3D pose page no longer flashes the standalone 3d-pose-art editor before the host layout.** Opening the Pose
  tab used to draw the pose package's own demo chrome - the six-row toolbar, the aside panels and the bottom hint,
  all of it static in the entry page - and fold it away only after the default figure GLB (3 MB) had loaded, the page
  had posted `pose:ready` and the host had answered `pose:theme`. The entry page now sets the host-mode marker in an
  inline head script whenever it runs inside an iframe (the same `parent !== window` predicate the bridge uses), so
  the first paint is already the host layout; standalone runs (`npm run dev`, GitHub Pages, a static site) are
  unchanged, and an old host that never sends `caps.hostUi` still gets the full demo controls back. Run
  `pwsh tools\sync_pose_dist.ps1 -Source <3d-pose-art repo>` and `pwsh tools\build_pose_package.ps1` to carry the
  rebuilt page into the data root and the bundled copy.

- **The Skills page opens on a guide page with an import path.** Landing on Skills no longer drops straight into the
  manager: the page starts on the same blank-state card as Paint / Video / Director and offers **Import workflow**,
  **New template skill** and **Skill list**. Import takes the API-format `.json` ComfyUI writes with "Export (API)",
  previews the bindable variables, asks for a name, and lands the result as a custom generation skill with the new
  entry selected; an interface workflow is refused with a hint to re-export it as API format instead of being written
  into the skill folder. New template skill opens the blank `skill.md` form, and Skill list opens the manager with a
  **← Guide** entry in its title bar that returns to the guide (unsaved changes are confirmed first). Covered by
  `studio/tests/js/studio-skills.test.mjs`.

- **A gallery folder on an unreachable network share no longer freezes the desktop window.** The desktop service read
  the configured gallery folders on its request loop, and every hidden entry and every folder went through
  `Path.resolve()` - a realpath round trip on an SMB share. With a NAS folder in `custom_directories` /
  `hidden_directories` and that share offline, the first `/neo_gallery/list` blocked inside the OS filesystem call and
  the whole service stopped answering: the material library stayed empty, the recipe list showed no entries, and the
  3D pose page sat on "读取摆姿状态…" without its stylesheet, every request queued behind the same block. UNC entries
  now keep their lowercase string as the directory key (no realpath on a share), a hidden folder is matched before
  anything touches the disk, and the folder scan runs off the request loop, so a slow share costs one gallery request
  instead of the window. Covered by `studio/tests/test_gallery_dir_manage.py` (`UncDirTests`: a hidden UNC folder is
  never resolved or stat'ed).

- **Closing the window now stops the ComfyUI an earlier session left behind.** A ComfyUI the desktop app had spawned
  could survive a close that never reached its teardown (a crash, "End task", a signed-out session). The next window
  found the port taken and attached to that orphan, which kept running the plugin code it had imported hours earlier:
  disk syncs put the new files in `custom_nodes`, but the process never re-imported them, so a pose export still
  landed in the old place no matter how current the files were. The app now records the pid and port of every
  ComfyUI it spawns in `data/comfy_child.json` and, when it had to attach, takes that process down on close after
  checking the port still belongs to the recorded pid. A ComfyUI started by the user has no marker and is still
  never touched.

- **The window opens on the home page, and nothing jumps it away.** The Studio page reads its tab from the URL
  fragment. An unrecognised tab - a bookmarked tab link, a deep link saved from an older build - hid every view and
  left a window with nothing but the top bar, and the director page was pulling the window off home by itself: the
  recipe list lands during launch, auto-selects its first director recipe, opens that recipe in the embedded editor,
  and the editor host then switches to its own page. The first recipe is still auto-selected - the film generate pane
  and the agent context read it - but the editor is only opened by clicking the card, so a launch stays on **首页**
  and the director page starts on its guide page. An unrecognised tab now falls back to **首页** as well. Covered by
  `studio/tests/js/studio-starting.test.mjs` and `studio/tests/js/studio-director.test.mjs`; the js harness resets the
  URL fragment between cases, so a case no longer inherits the tab the previous case left in the shared window.

- **3D Pose (3D 摆姿) is a page in the window, and its scenes, poses and exports are yours on disk.** The top bar
  gains a Pose tab and the home page a 3D Pose card; the page runs the 3d-pose-art build in a sandboxed iframe, and
  the window supplies the controls: a left column for the pose library and scenes (save the current pose, load one,
  delete one; save a scene, load a saved scene), a right control panel for the canvas state, figures, pose-mode
  switches, props and the ControlNet export, and a bar button that imports an asset from the library as a reference
  plane. Posing happens in the page through the `pose:call` channel and the canvas state mirrors back into the panel,
  so the page's own demo toolbar steps aside while the window panel is driving. Exported images - a canvas snapshot
  or a whole ControlNet set (skeleton / depth / silhouette per view) - land in `output/Pose`, a subfolder of the
  normal ComfyUI output directory, so the material library browses them exactly like any other output, and
  previews, drag-into-node and per-item delete work on them unchanged; a set is validated as a batch, so a
  rejected file leaves no half group behind, and the export toast names the Pose folder. Poses are written atomically under `<data root>/pose/presets/<name>.pose.json`
  and scenes under `<data root>/pose/scenes/`, and the short path `/neo-pose` redirects into the package
  prefix `/pose-dist/` so the vite build's relative imports resolve. The pose package is installed separately:
  `pwsh tools\sync_pose_dist.ps1 -Source <3d-pose-art repo>` puts the build under `<data root>/pose/dist/`, and until
  anything is installed the page says so with the install hint instead of showing a blank frame; with an older pose
  package that has no host command layer
  the panel states what to run instead of showing controls that do nothing. Photo point estimation, mesh generation,
  pano and library writes need the pose project's Python sidecar and stay greyed out in the desktop
  window. The bridge accepts messages only from its own iframe and only from the page's own origin, and one request's
  reply is only accepted on its own reply port. Covered by
  `studio/tests/test_pose_bridge.py` (path containment and symlinks, the scene and pose name whitelists, wasm MIME,
  hashed vs unhashed caching, atomic scene and pose writes, the ControlNet group validated as a batch into the
  library, the redirect), `app/tests/test_studio_server.py`
  (`PoseBridgeTests`: served offline, no escaping the package, scene round trip, capability flags, route ownership) and
  `studio/tests/js/pose-bridge.test.mjs` (not-installed form, iframe sandbox, source/origin gate, the `pose:call`
  round trip and reply-port isolation, the panel gate, the state mirror, the library and export routes);
  docs: `docs/studio-pose.md` / `docs/en/studio-pose.md`, `docs/api-routes.md` / `docs/en/api-routes.md`,
  `docs/architecture.md` / `docs/en/architecture.md`. The pose page answers the bridge on its own side
  (`src/neoBridge.js` in 3d-pose-art): it serializes the whole scene for a save, hands over the same
  clean canvas snapshot the Download screenshot button makes, takes a library asset as a reference
  plane, and puts a stored scene back on the stage - and it attaches no listener at all when the page
  runs standalone. Typing the package prefix `/pose-dist/` in the address bar opens the page. Covered
  by `tests/neoBridge.node.test.mjs` in 3d-pose-art (when the bridge exists, the source and origin
  gates, the reply-port answers, how a failure is voiced).

  Two fixes on the installed page. The build's own GLB assets (`/models/ybot.glb` and the prop registry)
  are now addressed from the page's own directory, so under the `/pose-dist/` prefix the figures load
  instead of falling back to the armless procedural skeleton - a root deployment (GitHub Pages,
  `npm run dev`) keeps requesting the exact same URLs. The page's six-row toolbar also collapses: the
  bottom-left 面板 button and the `T` key keep only its first row, the state is remembered across reloads,
  and the first row stays clickable. Covered by `tests/appBase.node.test.mjs` (root deployment unchanged,
  prefix deployment folds asset URLs into the prefix) and the 3d-pose-art browser suite (the default
  figure GLB is fetched through the deployment root; collapsing keeps one row and persists).

- **The 3D Pose page installs with the plugin, and the figures the licence allows ship inside it.** The pose build now
  has two landing paths: the package you sync into `<data root>/pose/dist/` (the full build, `*.map` included) and a
  minimal licensed copy that ships in `studio/pose_dist/` — the code plus the CC0 figure `ybot.glb`, `LICENSE`,
  `THIRD-PARTY.md`, `models/ATTRIBUTION.md` and a `MANIFEST.json` with a sha256 per file, 3.9 MB in total. Requests look
  through the data root first, so a fresh build and your own imported figures take precedence, and with no sync at all
  the page still opens — the left column then says plainly that the page runs on the bundled copy and that only the CC0
  figure ships with it. Both prefixes the build asks for are answered: the page and its scripts come through `/pose-dist/`,
  the prop registry and the GLBs through the origin-root `/models/` the build bakes in (`/models/props/index.json`,
  `/models/<file>.glb`), one static handler under two names with the same two-level lookup and the same in-root check.
  With only `/pose-dist/` mounted the registry request landed as a 404, so the page read it as empty and reported every
  "add prop" and every GLB body as a failure while the page itself ran fine. What ships is decided by the licence rows
  in the pose project's `models/ATTRIBUTION.md`, not by
  size: Mixamo and the SMPL-derived bodies, the prop GLBs and the source maps stay out, and the prop registry ships
  empty (the procedural props stay available). The panel's **导入自备素体** button takes a `.glb` you own — a Mixamo
  download, your own rig — writes it to `<data root>/pose/dist/models/<key>.glb` through `/neo_pose/import_model`
  (key whitelist, 35 MB cap - the size that fits the 48 MB request-body cap after base64 - `glTF` header, all
  checked before anything is written; the standalone service raises its own request-body cap above that line, since
  aiohttp's 1 MB default rejected a 2.9 MB figure before the handler ever ran) and reports the key you register in
  the pose page's own local import area; re-syncing the pose package no longer deletes those imported figures, because
  `tools\sync_pose_dist.ps1` keeps the files the source build does not have. `/neo_pose/status` reports which landing
  path is live (`dist_source`), the shipped manifest and the GLBs present, and `caps.body_import` is now `true`. Covered
  by `studio/tests/test_pose_bridge.py` (the bundled copy as fallback, the data root shadowing same-named files, the
  prop-registry prefix resolving in both levels, the manifest inside status, the import landing path with its five
  checks), `app/tests/test_studio_server.py`
  (`PoseBridgeTests`: the bundled-copy fallback offline, the `/models` prefix answering the registry and the prop GLBs,
  importing a figure offline with the 35 MB cap and the request-body cap above it, the pose route table checked one by
  one), `studio/tests/js/pose-bridge.test.mjs` (the bundled-copy note, the base64 upload, the key and file-type checks)
  and `tools\test_pose_package.ps1` (manifest hashes and size cap, the GLB whitelist, the forbidden shapes); docs:
  `docs/studio-pose.md` / `docs/en/studio-pose.md`, `docs/api-routes.md` / `docs/en/api-routes.md`,
  `docs/release.md` / `docs/en/release.md`, `tools/AGENTS.md`.

- **3D Pose: the panel adds a prop by the name you type.** The prop dropdown carries the page's own prop key
  (`builtin:chair`, `glb:arrow.glb`) as its value, so picking 椅子 now adds the chair instead of answering
  "prop definition not found: 椅子" - the panel used to send the displayed label, which is not a key the page
  owns. A name box sits next to the dropdown: 椅子, chair, builtin:chair, 箭, arrow.glb and glb:arrow.glb all
  resolve to the same entry against the prop list the page sends, a registry label with a bracket suffix
  (细剑（Sting）) resolves by the name in front of the bracket, and a name that is not in the prop table is
  answered with what you can type and how many props there are, with no request sent. Covered by
  `studio/tests/js/pose-bridge.test.mjs` (the fixture now mirrors the page's `{propKey, label, source}` shape,
  the dropdown values, the typed-name round trips, the name that never leaves the panel); docs:
  `docs/studio-pose.md` / `docs/en/studio-pose.md`.
- **3D Pose: the control panel is smaller, and the canvas opens dark.** The 摆姿模式 / 吸附 / 轮廓线 /
  主体层 checkboxes are gone - clicking the figure on the canvas enters pose mode by itself, the page
  already starts with snap and outline off, and the figure stays visible, so the state line now mirrors
  only the character, its count and the prop count. The appearance dropdown opens on 暗色 (the page itself
  opens grey), and a pose package without that look gets no request. Covered by
  `studio/tests/js/pose-bridge.test.mjs` (the three state rows with no checkbox rows, the dark look sent on
  open, the old package left alone); docs: `docs/studio-pose.md` / `docs/en/studio-pose.md`.
- **VRAM / RAM monitoring and 清理 now live in the top-bar 队列 panel.** The readout used to sit once per generation
  page (director, paint, video, agent) and polled every 3 seconds while you were on one of them. It is now a single
  strip under the panel header — `显存 12.0G/16.0G` and `内存 20.1G/32.0G`, orange above 60% and red above 85% — with
  the **🧹 清理** button at its right end, reporting `释放 2.0G` where it freed. Opening the panel starts the refresh and
  closing it stops it, so a window that flips back to the offline form no longer keeps hitting
  `/neo_studio/mem_stats` for nothing, and the four generation pages no longer carry their own bar. Covered by
  `studio/tests/js/studio-queue.test.mjs` (readout renders from `/neo_studio/mem_stats` + `/system_stats`, warn / crit
  colour, 清理 POSTs `/neo_studio/clear_memory`, closing the panel stops the fetches, `caps.memory = false` ships no
  strip) and `studio/tests/js/studio-offline.test.mjs` (offline form: no strip, no `mem_stats` request); docs:
  `docs/studio-desktop.md` / `docs/en/studio-desktop.md`, `docs/api-routes.md` / `docs/en/api-routes.md`.

- **Queue panel rows now carry thumbnails, submit time and duration, like ComfyUI's own task list.** Every row is a
  46px thumbnail tile (images scaled by the gallery thumbnail route, videos by ffmpeg's first frame, audio rows keep an
  empty tile), then the kind + label line, and a meta line with the submit clock (`14:32`), the elapsed seconds —
  `12.10s`, settled on terminal rows and advancing with every progress event — plus the result count (`3 张`). Rows are
  grouped under `今天` / `昨天` / date headers, and clicking a tile opens the Lightbox: the image viewer for images, the
  in-page video player (`/neo_gallery/video`) for the four video kinds. Covered by
  `studio/tests/js/studio-queue.test.mjs` (thumbnail src on `/neo_gallery/thumbnail?...&size=96`, no thumbnail for audio
  rows, `HH:MM` + `12.00s` + `3 张` meta, `今天` group header, video tile opening the player) and
  `studio/tests/test_studio.py` (rows carry the `created` / `updated` / `count` and first-`result` fields the panel
  reads); docs: `docs/api-routes.md` / `docs/en/api-routes.md`.

- **The top-bar 队列 panel opens only when you click it.** The panel's own `display: flex` rule overrode the browser's
  `[hidden] { display: none }`, so the queue dropdown floated open on every page the moment Studio came online, before
  any task was submitted — and clicking **队列** only flipped an attribute the CSS ignored. `queue-panel.css` now pins
  `.ns-queue[hidden] { display: none }`; the panel starts collapsed, the badge stays as the counter, and the click is
  what seeds and shows the rows. Covered by `studio/tests/js/studio-queue.test.mjs` (panel `hidden` right after an
  online boot, visible only after the toggle click, `/neo_studio/queue` fetched on that click) and the static case that
  keeps the CSS rule in the file.

- **Closing a director recipe stops it from reopening itself.** The recipe list sorts by modification time, so the
  recipe just edited is the top card, and the page auto-opened the top card on entry: close a recipe with **✕** /
  **Cancel** and the next visit showed it open again. The editor mount/unmount observer now records the close in a
  local preference (`neo_studio_director_closed`) and the recipe panel is built with `autoSelectFirst` off while it
  stands, so entry and every panel rebuild (modal refresh, post-save refresh) land on the guide page. Clicking a
  card, **New recipe** and the modal's "新增导演配方" are explicit opens and clear the preference. Covered by
  `studio/tests/js/studio-director.test.mjs` (close records the preference, a panel rebuild with it set opens no
  editor, an explicit open clears it); docs: `docs/studio-desktop.md` / `docs/en/studio-desktop.md`.

- **The director page has no toolbar row, and closing the editor closes the panel with it.** **📋 Recipes** /
  **🖼 Asset library** were a row of their own above the split; they are now one set of buttons with one home, the
  editor's title row at its left end — assets are what you use while editing, so they leave with the editor. Closing
  the editor with **✕** / **Cancel** no longer leaves a lone generation panel filling the column: the main column
  (editor, sash, panel) steps out — `ns-director-editorless` on `.ns-director`, driven by the same observer that
  mounts the editor — and the column shows a guide page in the same idle style as the paint and video pages (title +
  fine note + four corner marks) with **📋 Recipes** and **📝 New recipe**. **New recipe** mounts a blank recipe
  through the embedded host, and the recipe modal's "新增导演配方" now closes the modal and does the same, instead of
  an editor stacked behind an open modal. Covered by `studio/tests/js/studio-director.test.mjs` (title-row entries
  while the editor is open, guide entries and the idle card after **✕**, the modal closing on new recipe) and the
  `studio/tests/e2e/studio.e2e.mjs` layout case (no bar row, exactly one entry home);
  docs: `docs/studio-desktop.md` / `docs/en/studio-desktop.md`.

- **The director page is a left/right split: editor on the left, the film on the right.** The main column was a
  stack — editor on top, a horizontal sash, the film generation panel underneath — so the run results shared the
  window's height with the editor: dragging the panel taller took height away from the timeline being edited, and
  the result box was as wide as the whole window while the film is 16:9. `.ns-director-main` is now a row: the
  editor fills the left pane, the sash is vertical (`ew-resize`, a 1px vertical hairline, keyboard `←`/`→`), and
  inside the panel the two blocks stack — the one-row control bar on top, the result area below it sized off the
  panel width at the recipe's own `width × height` ratio (`--ns-gen-ratio` / `--ns-gen-ar` under
  `container-type: size`, so a portrait recipe stays a narrow strip; the `--ns-gen-h` custom property and its
  `calc()` width cap are gone). Floors: editor 360px, panel 200px — a panel that narrow wraps the control row onto
  extra lines instead of scrolling sideways, dragging 90px past the floor closes the panel, and reopening is a drag
  outward from the sash: the vertical **◂ Generate panel** caption is the affordance, clicking it works too for
  anyone who can't get the drag going, and the click that trails a released drag is ignored (the VS Code sash —
  collapse and expand are drags, and an expanded sash carries no caption); the
  saved preference is `{width, collapsed}`, an old `{height, collapsed}` keeps its collapsed flag and falls back to
  the default width, and `.ns-director` carries a 620px min-width so a narrow window scrolls
  sideways instead of squeezing both panes into unreadable strips. Closing the editor takes the panel out with it
  (see the guide-page entry above).
  Covered by `studio/tests/js/studio-director.test.mjs` (the sash case drags to resize, drags past the floor to
  close, drags outward to reopen, key-resizes, `Enter`-collapses, and clicks the caption to reopen after a drag) and the
  `studio/tests/e2e/studio.e2e.mjs` layout case (`flexDirection: row`, the control row stays one line);
  docs: `docs/studio-desktop.md` / `docs/en/studio-desktop.md`, `docs/recipes.md` / `docs/en/recipes.md`.

- **The agent page dropped the center stage; results show enlarged in the panel itself.** The page was a two-column
  grid — panel left, an enlarged stage right, and a draggable sash between them that collapsed, reopened, persisted
  its width and acted as a drop band. The stage duplicated what the panel's timeline already draws, so it is gone:
  `studio/web/agent-stage.js`, `buildAgentSplit()`, the `.ns-agent-cols` grid, the `.ns-agent-stage*` /
  `.ns-agent-split` / `.ns-agent-collapsed` rules and the 中间舞台 switch in the Agent preferences section are
  deleted, the two old localStorage keys (`neo_studio_agent_stage`, `neo_studio_agent_split`) are removed at startup,
  and the panel is a single centered column capped at 1280px. Enlarging the result follows: the sampling preview asks
  for the 1024 tier (renamed `STAGE_PREVIEW_SIDE` → `AGENT_PREVIEW_SIDE` in `studio/web/live-preview.js`), and the
  panel's result images — `.neo-agent-media img/video` and the markdown answer images — cap at 460px tall over full
  column width (was 240px) with the popup viewer for the full picture. Covered by `studio-agent-title.test.mjs`
  (the stage-head title case deleted with the module) and the remaining agent suites (`studio-agent-frames`,
  `studio-agent-skill`, `studio-agent-mention`); `studio-agent-split.test.mjs`, `studio-agent-stage.test.mjs` and
  `live-preview.test.mjs` are deleted with the code they covered.

- **The `f2v` mode is named for what it consumes: 关键帧生视频 / "Keyframe → video".** The old word 分镜生视频 /
  "Storyboard → video" named the director's 分镜 board instead of the input the mode takes — f2v eats the first / last
  frame slots, while the 分镜 board (grid storyboard, per-segment comparison, timeline) keeps its own name.
  `SEG_MODES` / `MODE_LABELS` in `studio/web/director.js` is the single source, so the director's global and
  per-segment mode dropdowns, the Video page's skill group headers, the recipe overview line and the card summary
  lines all read the one label; the English wording is the `studio/web/js/core/i18n.js` pair.

- **Chip popups open above the chip and stay inside the window.** A popup's `top` / `left` are relative to its
  containing block while the placement math computed viewport numbers: the story composer sits in a draggable modal
  whose top is at the window top, so the 技能 panel looked right there, while the Video page's composer card is pinned
  to the window bottom — the same numbers buried the whole panel below the window, leaving only the group header row
  reachable with 主模型 / 步数 / 「完成」 out of reach. `placeChipPanel()` in `studio/web/gallery-gen.js` is shared by
  `chipButton()`'s menu and `skillParamsChip()`'s panel: prefer 6px above the chip, drop below only when the space
  above is too small, clamp inside the window, subtract the containing block's viewport position, then measure the
  real rect and push the whole popup back in. Covered by `studio/tests/js/studio-video.test.mjs` (opens above the
  chip, clamps at the window bottom, the story composer's numbers byte-identical, the 分辨率 menu opens above and
  stays clickable).

- **A standalone simple video page (`#/video`): one line plus a first frame, straight to one clip.** The only video
  entry was the director — a multi-segment recipe you edit, save, then generate as a whole, which is more than someone
  wants who just has a line and a first frame. The new Studio `#/video` page is one editor like the ArtCraft create-video
  screen: the page is a stage, and while it is empty the Paint page's idle hint sits centered on it — the same 19px muted
  title plus a small note line, not a poster headline — with a rounded composer card floating at
  the bottom edge — first / last frame and reference squares, a prompt box with a character counter, a chips row
  (技能 / 分辨率 / 时长 / 种子) and a generate button at the card's right end; the finished clip lands as a card on the
  stage and the hint fades out. The card, the squares, the prompt box, the chips and the generate button are the
  story composer's own pieces, not a second copy of them: `.neo-gallery-gm-composer` / `.neo-gallery-edit-refdrop` /
  `.neo-gallery-gm-quick-input` / `.neo-gallery-story-btn` carry the look, and 技能 / 分辨率 / 时长 are the same
  `chipButton()` pill the Paint page's composer uses (hidden select, menu floats up, chip shows the effective value).
  It touches nothing in the director flow. The backend `studio/simple_video.py` reuses the director's own parameter
  chain (`_resolve_skill_id` / `load_skill_workflow` / `get_skill_gen_config` / `resolve_video_params` / `render_template`)
  to turn the request into a skill template, attaches a `SaveVideo` to the terminal VIDEO output, and submits the graph
  to the execution queue (VRAM, step progress and cancellation come from the executor) — the output lands in
  `output/NeoSimple/`, is played back via `/view?type=output`, and is not recorded into any recipe. Duration arrives in
  seconds and is mapped onto the H3 17k+5 frame grid; a seed of -1 randomizes. The page is a Home card and a nav tab peer
  to Home / Paint / Director; the generate button is gated by the `simple_video` capability so the offline desktop
  directs the user to launch ComfyUI. Covered by `studio/tests/js/studio-video.test.mjs` (stage, idle hint and floating composer render, skill
  dropdown lists only `gen_video` skills, the generate payload shape, poll running → succeeded swaps in the `<video>`,
  cancel hits the cancel route) and `studio/tests/test_simple_video.py` (`_video_terminal` finds the unconsumed VIDEO
  output / skips `SaveVideo` / raises with none, `_run_prompt` attaches `SaveVideo` and maps `duration_sec` → frames
  and a negative seed → a resolved one, generate / cancel routes). `app/studio_caps.py` registers `simple_video` as a
  ComfyUI-only feature, asserted by `app/tests/test_studio_server.py`.

- **The image-edit composer pairs the references with the prompt box, Nano Banana Pro style.** The reference row sat
  as its own row above the composer, so the panel read as two stacked focus boxes, and picking from the library meant
  dragging from the ComfyUI sidebar. The composer is now one rounded card whose top row pairs a 56px 「＋参考」 slot with
  the prompt textarea on its right, and a chips row (技能 / 模式 / 目标分辨率 / 生成) sits below. Hovering the 「＋参考」
  slot floats open a pick menu — a 「参考图 N/9」 header, 「⬆ 本地上传」 (a multi-select file input through the existing
  `uploadLocalFiles()` path), and 「🖼 素材库取用」 (dispatches `neo:media-pick` so the Studio asset-library modal hands
  picked cards back to `addRefImages()`; ComfyUI has no listener and keeps the sidebar drag). The menu is hidden until
  hover / focus, and clicking an empty slot still fills just that slot. Covered by `studio/tests/js/gallery-image-edit.test.mjs`
  (one composer, one textarea, the reference row is not a direct child of the form, library pick lands a reference that
  reaches the generate payload, local multi-select appends two slots).
- **The composer prompt box integrates into the card.** The textarea carried the story-input border inside the card, so the composer read as a frame with a second focus box drawn around the text. That inner border, background, corner radius, and resize handle are dropped in the composer — the card outline is the single focus frame, the prompt text flows straight into the card, and the 「＋参考」 square stays as the reference slot. Covered by `studio/tests/e2e/gallery-edit-layout.e2e.mjs`.
- **The 技能与自定参数 panel keeps 完成 on screen.** The panel's first grid row was auto-height, so the skills column grew to the full shell (62vh) and the 完成 foot row landed below the fold - reaching it meant scrolling the whole panel. The rows are now `minmax(0, 1fr) auto`: the skill / model row shrinks to the space above 完成 and scrolls on its own, so 完成 stays pinned at the panel bottom with no panel scroll. Covered by `studio/tests/e2e/gallery-edit-layout.e2e.mjs` (panel self-overflow, 完成 inside the viewport at 1600×950 / 1280×620 / 1280×520).
- **The 参考图 pick menu is clickable.** The menu opens 6px above the 「＋参考」 slot, and a pure `:hover` reveal can't be crossed: the mouse leaves the slot row, the row loses `:hover`, the menu drops to `pointer-events: none`, and it vanishes before the cursor reaches it - the 「本地上传」 / 「素材库取用」 buttons were unhittable. The reveal is now JS-driven with a 250ms close grace (`mouseenter` / `mouseleave` on the row and the menu): leaving the slot starts a timer, moving into the menu cancels it, so the cursor crosses the gap and lands on a button; clicking a pick closes the menu. Covered by `studio/tests/js/gallery-image-edit.test.mjs` (row enter opens, leave keeps it open through the grace, re-entering the menu cancels the close, leaving it collapses after the grace).

- **The composer drops to three chips: 技能 and 自定参数 are one chip, and MOSS joins the family list.** Four chips
  in one row (技能 / 宽高比 / 最长边 / 自定参数, plus 模式 in the edit panel) kept the skill picker and the model
  override as two unrelated controls, so nothing connected a skill's pinned main model with the model used to
  override it: pick a Qwen skill, set a MOSS model in 自定参数, and the LoRAs and weight shapes do not match - the
  failure only shows up in the backend. `skillParamsChip()` in `studio/web/gallery-gen.js` merges them into one chip
  that opens a two-column panel above the composer: the left column lists the page's skills grouped by main-model
  family (`Qwen Image` / `Krea2` / `MOSS`, unrecognized skills under 「其他」) with that skill's own pinned model as a
  subtitle (`shortModelName(row.gen_config.model)`), the right column keeps the existing 生图模型 / LoRA controls and
  the native selects as state containers. Skills of a foreign family stay selectable: picking a skill replays that
  skill's own pinned model, which replaces the override, so the cross-family pair cannot survive the click - the row
  only carries a `↻` before its subtitle and a hover title naming the model the selection switches to. The pair that
  does survive a click is the one the backend rejects: a manual main model whose family differs from the current
  skill's family is taken back to 「自动」 by `guardMainModelFamily()` with a toast naming the conditioning match, the
  same rule `studio/mcp_server.py` enforces on the payload, whose `MODEL_FAMILY_HINTS["image"]` gains `moss` to match
  `LORA_FAMILY_HINTS` in `studio/web/image-gen.js`; an empty main model follows each skill's own config, so the
  default state blocks nothing. `skillFamily()` in
  `studio/web/skill/skill-core.js` reads the family from the skill id and display name first and the pinned model
  path second, and returns empty when neither matches: grouping never guesses a family. The panel writes
  `display: grid` inline when opening, because the `.rs-runtime-menu` base in `prompts.css` loads after
  `gallery.css` and no stylesheet order wins that contest. Covered by `studio/tests/js/gallery-gen-material.test.mjs`
  (family groups, subtitles, auto state, cross-family rows selectable with the `↻` mark, the manual family clash
  taken back to auto with a toast, chip label), `gallery-image-edit.test.mjs` and
  `studio-paint.test.mjs` (three chips, panel ownership), and the layout e2e
  `studio/tests/e2e/gallery-edit-layout.e2e.mjs` (panel fully inside the viewport at 1600×950 / 1280×620 / 1280×520,
  skills column scrolling on its own).

- **The skill panel closes on 完成, and long model names read on one line.** Picking a skill closed the
  技能与自定参数 panel, so the main model and LoRAs that skill pins only became visible after reopening the chip,
  and the model / LoRA dropdown lists were exactly as wide as their input box - `MOSS/xxx_int8_convrot.safetensors`
  showed as a clipped tail. A skill row click now stops propagating, the panel stays open with the right column
  showing what the selection pins, and a 完成 footer button closes the panel; the combobox list takes
  `listMinWidth: 520` through the existing viewport clamp in `studio/web/combo-box.js`, and the exported
  `inOpenComboList()` lets the chip panel count a click inside a body-mounted dropdown list as an inside click.
  Covered by `studio/tests/js/gallery-gen-material.test.mjs` (row click keeps the panel open, 完成 closes it,
  chip label replay after the switch).

- **The paint composer docks to the bottom, and its controls become real chips.** The text-to-image panel filled the
  top of the column with the input card and left a strip of empty page under it, and its 技能 / 宽高比 / 最长边
  controls were native `<select>` dropdowns wrapped in a rounded shell — a 240px clip of a model path
  (`Krea2 RedCraft2-Krea2RedMix2.1-Int8-Conv…`) with a painted ▾, which reads as a broken field, not a control.
  The panel now fills the column height and the composer is pinned to the panel bottom
  (`.ns-paint-text .neo-gallery-gm-composer { margin-top: auto }`, the old `flex: none` panel override is gone):
  progress and finished images stack from the top above the composer, idle leaves only a start hint
  (`.neo-gallery-gm-idle`) in the result area, and the 自定参数 drawer moved above the composer so opening it pushes
  nothing off screen. The three controls are real chips (`chipButton()`): a pill button with an icon, the value in
  effect, and a caret, that floats an option menu open upward (the composer sits at the bottom, so menus open
  upward); the native select stays inside the chip as the state container and is hidden, so skill switching,
  「保存为新技能」 and the payload builders read the same values as before. A chip shows the effective value, not a
  field name — `16:9 (宽屏)` / `2048` when it follows the skill config, the chosen option when overriding, 「默认」
  when nothing is configured — and the ratio chip's rectangle is shaped by the ratio (9:16 tall, 16:9 wide), so the
  two labels `比例 默认` / `边长 默认` and their i18n keys are gone. Covered by `studio/tests/js/gallery-gen-material.test.mjs`
  (chip click → menu → payload, chip labels follow skill config replay), `studio-paint.test.mjs` (result area above
  the composer, three chips, no visible select) and the paint-page e2e layout case, which now measures
  composer-at-bottom / hint-above-composer geometry.

- **The paint page composer is one box, and 增强 stops reading as the default.** The text-to-image panel spread the
  same choices over five rows — a labelled skill row, a 随机填入/▾/☰ float group, a 自定参数 box, an enhance toolbar,
  and an output box sitting above a description box, so nobody could tell which box the prompt goes in. The panel is
  now one card: a single prompt textarea over a bottom row of chips (技能 / 宽高比 / 最长边 / 自定参数 … ⋯ 生成), and
  what is in that box is the final prompt — generation sends `skip_enhance: true`. 随机填入 / 运行时随机 / 预设列表
  and the whole enhance row (增强方式 + 增强) live in the `⋯` menu, so the default view is the box and the 生成
  button; an enhance streams into the same box and restores the pre-enhance text when the LLM returns nothing, which
  leaves one text history (the prompts actually generated, newest first) and no second box to keep in sync. The idle
  preview area drew a dashed empty canvas (`.neo-gallery-gm-hero`) and the bottom agent stage `.ns-paint-stage` sat
  under the panel with one idle line: with both removed the text panel stopped being stretched to the full column and
  the stage host takes `ns-hidden` whenever the current round has nothing to show — `createAgentStage({ onContent })`
  reports that, and `createAgentStage()` has no idle row left. The five image-edit mode buttons are disabled without
  a source image, which read as broken controls in icon-only mode: they carry their labels, `cursor: not-allowed`, and
  a title naming the missing piece
  (「先拖入原图（从素材库取一张，或把图片文件拖进来）」). Covered by `studio/tests/js/studio-paint.test.mjs`
  (idle empty-state, enhance inside the ⋯ menu, disabled affordance), `studio-agent-stage.test.mjs` (host hidden when
  the round is empty), `gallery-gen-material.test.mjs` (single box, menu contents, enhance write-back, chip labels)
  and the paint-page e2e layout case.

- **Panel handover closes the asset modal, and glyph buttons become real icons.** On the paint page, `生成素材` /
  `图片编辑` clicked while the page is already open left the asset library modal covering the panel: `go()` on the
  same page skips the `showView()` close, so the entry closes the modal itself after switching mode. The five
  image-edit mode buttons and the frameless window controls (minimize / maximize / fullscreen / close) draw through
  `setIcon()` in `studio/web/js/core/icons.js` instead of the characters they used to carry, which shifted with the
  font and dropped into colored emoji in WebView2; each mode button keeps its short label beside the icon. The cold-start toast key
  `ComfyUI 启动中…就绪后自动接上生成` has its English entry. Covered by `studio-paint.test.mjs`,
  `studio-desktop.test.mjs` and `studio-window-chrome.e2e.mjs`.

- **The image-edit panel takes the same composer shape.** The skill is a chip, 扩图 / 局部 / 删除 / 融合 / 姿势 are
  icon buttons with their short label beside the icon, and the size is a chip reading 「目标分辨率 1024×1024」 that
  opens the `#img-edit-width` / `#img-edit-height` inputs, collapsed in the modes that size themselves. Covered by
  `studio/tests/js/gallery-image-edit.test.mjs` (icon mode switches, size chip), `studio-paint.test.mjs` (mode
  buttons) and the paint-page e2e cases, whose asset-library selector was refreshed to `.ns-paint-lib-btn`.

- **The director and paint pages hand their left column back to the editor; recipes and the asset library open in a window modal.**
  The director page's 360px recipe column (with its recipe / asset switch and its own splitter) and the paint page's
  left column with the image-recipe list took width from the editor while the user was editing. The director page is
  now a top bar (**📋 配方** / **🖼 素材库** + the VRAM bar) above a full-width editor / generation stack, and the paint
  page is a top bar (mode bar + asset library + VRAM) above one full-width panel. Both lists open in the shared window
  modal `studio/web/js/core/lib-modal.js`: it covers the window by default, dragging the title bar turns it into a
  floating window, the maximize button / right-edge handle / `Esc` / backdrop / **✕** behave like the other Studio
  windows, and geometry lives in `localStorage["neo_studio_libmodal_recipes"]` and
  `localStorage["neo_studio_libmodal_assets"]`. The gallery stays one element with three hosts (gallery page / modal /
  standby), and the host record is written on **mount**, so opening the library lands on the directory you were
  browsing and a reopen lands on that same directory — writing it only when the panel is pulled away is what made the
  library alternate home / directory. Clicking an asset card now goes to the page that opened the modal: the director
  editor fills the slot its **🖼 素材库** button announced (`setDirectorAssetTarget` names first / last / reference n),
  the paint page loads the image-edit source preview, and the modal closes on the pick; clicks nobody claims keep the
  lightbox, and multi-select uses the footer **📥 N selected**. The paint page's image-recipe list is gone. Covered by
  `studio/tests/js/studio-director.test.mjs` (modal open, pick, host handoff), `studio-paint.test.mjs` (single-column
  layout, modal pick), `studio-gallery-host.test.mjs` (directory memory across open / close) and
  `studio/tests/e2e/studio.e2e.mjs` (maximize, title-bar drag, `Esc`).

- **Opening the recipes modal no longer closes it again.** The **📋 配方** button refreshes the list on open, and the rebuilt
  panel auto-selects its `initialSelection` — the recipe the page already had selected — and replayed `onSelect`, whose
  first statement closes the modal, so the window vanished the moment the list arrived. A refresh that lands on the host's
  current recipe now only restores the card highlight (`selectRecipe(r, false)`: no `onSelect`, no editor re-open, so
  unsaved edits survive); the segment chips and size/steps echo that used to ride on that replay are refreshed by the
  recipe-saved event in `studio-app.js`. Covered by `studio/tests/js/recipes-panel.test.mjs` (restore replays nothing) and
  `studio/tests/js/studio-director.test.mjs` (open modal, list lands, modal still open).

- **Dragging the library / recipes window no longer sticks to the mouse.** The title-bar drag and the right-edge
  resize handle collected `pointermove` / `pointerup` on themselves, so the moment the cursor left that 8px-wide strip
  the release event never passed through the element that started the gesture: the gesture never ended and the window
  kept following the mouse (same for releasing outside the pywebview window). Moves and releases are collected on
  `window` now, the start element takes pointer capture, and closing the modal mid-drag (`Esc` / backdrop / **✕**)
  ends the gesture and unbinds the listeners. Covered by `studio/tests/js/lib-modal-geometry.test.mjs` (release over
  the content area, release outside the resize strip, `Esc` while dragging).

- **The `@` picker's prompt candidates answer on the desktop port, and the popup stops re-laying a thousand rows.**
  With the page pinned to the desktop port the six candidate categories come from four routes, and
  `/rs_prompts/list_prompt_names` was not in `app/studio_caps.py` — that request answered `409 offline`, so the
  image / video prompt rows stayed empty until ComfyUI finished booting while skills, models, LoRAs and recipes were
  already there. The name-and-tag read side now lives in `studio/prompt_names.py` (two directory listings plus one
  tag index per source, no `PromptServer`, no per-file stat) and the desktop service mounts it like the other leaf
  modules; the write side (tag index updates from `save_prompt` / `delete_prompt`) stays in `prompts.py`.
  The other half of the lag was in the popup: with ~740 LoRAs registered it laid every filtered row and re-sorted
  the whole filtered set on each keystroke. Candidates are now sorted once per arriving batch, at most 120 rows are
  laid, and the rest collapses into one「…其余 N 条未显示，继续输入缩小范围」line above them — `End` and `Enter`
  act on the laid rows, so the highlighted row is the row that gets committed. The popup also stopped floating: it
  measured a fixed 220px of height and a fixed 340px of width, so with the composer near the window bottom the
  「doesn't fit below」branch always fired and a three-row popup sat 224px above the input, narrower than it. The
  position is now recomputed per render from the laid rows' real height and the input's own width, the list box
  shrinks to the space actually available, and the popup keeps the input's left edge. Covered by
  `app/tests/test_studio_server.py` (`test_prompt_names_served_offline`) and
  `studio/tests/js/studio-agent-mention.test.mjs` (row cap, hint count, `End` + `Enter` on the last laid row).

- **An `@`-mention skips the discovery step it already settled, and skips it visibly.** A named main model, LoRA,
  recipe, skill, or prompt body decides "which one" for this turn, yet a weak model still ran the discovery step after
  naming it — `list_models` after `@model`, `search_loras` after `@lora`, `list_recipes` after `@recipe`,
  `list_skills` after `@skill`, and `generate_prompt` re-writing a named prompt body — leaving a "🔧 tool ran" card in
  the timeline for a step that was already decided. The gate now intercepts that call **before** the `tool_call` frame:
  the step is skipped, MCP is never reached, and the timeline lands a dim「⤷ 已跳过」line (`tool_skipped` frame,
  `studio/web/agent-panel.js` / `agent-stage.js`), not a tool card. The note tells the model to write the named value
  verbatim into the generation tool. The gate fires once per tool per run, so a named value the machine rejects
  (model not installed, recipe missing) lets the model run the discovery step on the next call instead of looping.
  Covered by `studio/tests/test_agent.py` (`TestMentions`: each category skips, stubborn model not stuck, user-idea
  `generate_prompt` and empty-body mentions run).

- **MCP stdio servers run with UTF-8 pipes.** A python MCP server writes stdout and stderr in the locale code page, so on a
  Chinese Windows the JSON-RPC body and the "缺依赖，请先 pip install mcp" tail came out as mojibake once the desktop
  process ran in UTF-8 mode. The spawn now pins `PYTHONUTF8=1` in the child environment (`app/mcp_client.py`), a
  configured `env` still overrides it, and the existing UTF-8 decode of both pipes is then always correct.

- **A named body-only skill reports its step list once, and its gates are clickable.** The per-run gates above were
  per-run state only, so every follow-up message in the same conversation re-ran the same opening: the first
  `generate_prompt` was refused again, the model re-listed the whole flow, and the first gate was asked again from
  step 1. Two session-level facts now ride the focus chain (`gate_answers`, `intro_skills`, emitted on the `focus`
  frame and saved with the conversation): the skills whose numbered step list was already reported — the intro gate
  runs straight through for them — and the gates the user already answered (question → answer), which
  `_focus_block` prints so the run continues from the current step instead of re-asking step 1. Gates the model
  writes as answer text (`A. B. C.` lines plus a question) leave the user typing an answer — only `ask_user` renders
  clickable options — so a final answer of that shape is nagged into an `ask_user` call, twice at most per run (the
  second nag demands that single tool call; a model that keeps answering in prose still finishes). A gate also counts
  when its options hang under numbered sub-headings (`1. 画面比例：` then `A. B. C.`) and when the question is written
  as a statement (`现在需要确认两个关键参数：`) — the shape a 14B model actually produces. Covered by
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

- **The 3D Pose dark look shows its floor grid.** The dark appearance drew its grid lines at `0x2a2f3a` over a
  `0x1b1e24` floor at 55% opacity, so the stage read as empty space with nothing but the two blue axis lines — the
  grid a pose is set against is the point of the dark look. The shipped pose package draws it at `0x6d7786` fully
  opaque now: the desktop window renders at `devicePixelRatio` 1, where a 1px grid line is anti-aliased to about half
  coverage, so the colour carries the contrast on its own and the web page and the window show the same floor. The
  fix is in the pose project (`src/core/scene.js`); `pwsh tools\sync_pose_dist.ps1 -Source <3d-pose-art repo>` and
  `pwsh tools\build_pose_package.ps1` carry it into the data-root build and into the bundled copy.


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
