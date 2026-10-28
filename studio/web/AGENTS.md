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
- Vendored third-party files (`marked.min.js`, `purify.min.js`)
  stay vendored. Do not replace them with npm dependencies,
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
