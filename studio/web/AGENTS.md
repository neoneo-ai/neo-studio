# studio/web/ 规则（前端）

本层独有的规则。跨层规则与产品不变量在 [../../AGENTS.md](../../AGENTS.md)，本文件不复述它；
「能力不可用就不出控件」这条产品面不变量在根文件，用户可见文案的中文优先与 ⓘ 提示行归本文件。

## User-Visible Copy

- 桌面端窗口的文案走 `js/core/i18n.js`，以中文原文为键：缺英文条目时回落中文，不会把裸键显示给用户。
  只翻译桌面端自有的文案：顶栏与窗口控件、导演生成面板、启动设置、顶栏状态位、显存条。
  共用的素材库、技能、LLM、生图、生视频模块保持原样的中文。
- 每一行启动设置都带一个 ⓘ 提示（`studio/studio-app.js` 里的 `TIPS`），写明它的前置条件与生效时机：
  立即生效、需要重启窗口、还是需要「保存并重启 ComfyUI」。新设置少了这条提示就是没做完。

## Frontend Style

- No build step. `studio/web/` ships plain ES modules that ComfyUI loads
  directly; do not add a bundler, a transpiler, a package-managed runtime
  dependency, or a source tree that has to be compiled before it works.
- Vendored third-party files (`marked.min.js`, `purify.min.js`, `sortable.min.js`)
  stay vendored in `studio/web/vendor/`, one directory for all of them.
  Do not replace them with npm dependencies,
  and do not render untrusted text without sanitization.
- Shared tools go in `studio/web/js/core/` once more than one
  module needs them. Module-private helpers stay in the module.
- The standalone Studio page reaches ComfyUI-shaped APIs
  through `studio/web/studio/shim/`. Keep the shim as the
  boundary: page modules do not learn which process served them.
- Frameless window chrome, dragging, maximize/restore, and Esc
  handling stay in the window layer instead of being duplicated per page.
- CSS goes in the module's same-named stylesheet. Do not
  inline styles for structure a stylesheet already owns.

## Node Panel UI

- Frontend extensions load as `extensions/**/*.js` and only
  `.js` is recognized. Subdirectories are fine; renaming a
  module to `.mjs` makes the whole frontend fail to load.
- Node panel UI lives in the matching `studio/web/<node>.js`
  with a same-named `.css`. Shared DOM factories go in
  `dom-utils.js`, dropdowns in `combo-box.js`, toasts in `toast.js`.

## State Ownership

- Frontend caches follow the same rule: anything a user can edit goes through
  `studio/web/js/core/cache.js`, with the TTL as a backstop and an explicit clear
  on the save event. A cache keyed only by path that never invalidates is a bug.

## 导演页 = 唯一编辑面（整片编辑器冻结中）

- Studio 的导演页（`studio/studio-app.js` 的 director 视图）是全站唯一的编辑面：段的增删改、素材槽、整片参数
  的新行为只落这一页。
- `director.js` 的整片编辑器浮层（`openDirectorEditor`）现在是顶栏的**高级模式**，处于冻结期：不新增能力、不改交互、
  不修样式，只用来与导演页做功能对比。功能补齐后由「全站入口跳 `/neo-studio#/director?recipe=…` + 删掉浮层」收口，
  届时本节作废。
- 页内写路径只有一条：段写 `createSegmentOps()`（技能胶囊选出的统一技能落各段走它的 `applySkill`，生成模式落 `shared.mode`），
  落盘 `ops.save()` 配 `directorAssetRefs()`，整片参数经 `createSharedConfigSection().collect()` 并进现有 `shared`（表单没有的键原样留着；
  分块秒数的显隐要技能，由宿主交进来，表单不自己拉清单；步数不在这一列——整片每一段跑自己技能钉的那一套，本发覆盖在技能胶囊
  右栏，种子是本页唯一一处，生成坞没有第二枚）。页面自己不再写第二套保存形状。
- 技能与自定参数在导演页是同一枚胶囊：走 `js/core` 侧的 `skillParamsChip`（视频页同一枚，左栏按生成模式分组），宿主只交
  分组规则与 `panelClass` 密度类，不在页内重写第二枚技能选择器，也不在两处各留一套密度规则。
- 高级模式的脏状态不干预本页：本页靠 `DIRECTOR_RECIPE_SAVED_EVENT` 重读该配方并选中它。
- `director.js` 只维护共享层（常量与分辨率算法、事件、`createSegmentOps`、`directorAssetRefs`、`createSharedConfigSection`）。
  共享层要挪去中立层（`js/core/`）时整层一起挪，不在两处各留一份。
- 导演页两块弹层（技能 / 整片参数）共用 `.ns-director-compact-form` 这一处密度定义，新弹层挂同一套，不再开一档。宽度按窗口夹
  （单栏 `min(380px, 100vw − 16px)`，技能面板双栏 `min(660px, 100vw − 16px)`），净高按技能面板右栏那条模型链给足
  （`min(78vh, 480px)`：右栏不许自己滚，左栏技能清单自滚），行是「标签 84px + 控件吃余宽」的素材库弹窗档。规则写在
  `.ns-director` 这一层里：桌面端 `gallery.css` 比 `style.css` 后注入，它那条共享 chip-panel（720px / 62vh）同特异会盖过
  不带宿主的这条，弹层就宽过窗口了。
- 段操作入口只有时间轴块右上角那枚 ⋯（画在画布上的 glyph，不是 DOM 钮）：`director-timeline.js` 出 `onSegMenu(index, viewportRect)`
  回调与 `setSegMenuOps(fn)`（预设只读传 `null` 就不画 glyph），画布 hit 测试把它排在选中与拖拽之前——点 ⋯ 不选中该段、不拖块，
  块上头部文案让开它。菜单弹在组件交来的视口矩形旁，宿主 clamp 进窗口；面板就在 `.ns-director` 这块宿主里，宽度两条都带
  `.ns-director` 前缀（`.rs-runtime-menu` 基座 `min-width: 210px`、`gallery.css` 那条 94vw 同特异后注入，不带前缀就顶成整窗宽）。段号与秒数不在
  该段行重复一遍：块上就是「第 N 段 · Xs」，拖块右缘改时长。

## Testing

- JS regression tests are golden snapshots: `npm test` compares
  `studio/tests/js/golden/*.txt` and `npm run update-goldens` rewrites them.
  Run the suite before refactoring `prompt-manager.js` or `node-behavior.js`,
  and rewrite a golden only when the behavior change is intended.

## Validation

```
npm test                       # golden 快照；重构 prompt-manager.js / node-behavior.js 之前先跑
npm run update-goldens         # 只有行为改动是有意的时候才重写 golden
npm run e2e                    # 打本机 8188 的真 ComfyUI，连不上自动跳过
python tools\watch_web.py      # 热同步 studio/web/，前端改动刷新页面就生效
```
