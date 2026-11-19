# 提示词库

Studio 首页「素材与配置」板块的卡片「提示词库」进 `#/prompts`（`studio/web/prompt-library/prompt-library.js`）。
顶栏没有这一枚页签：首页那张卡是这页唯一的来路，首页版式把这张卡删掉（在「添加卡片」里加回来），这一页也就进不去。
一条提示词一张卡，卡片上铺的就是它的封面；没有封面的卡片落正文摘要位（名字 + 前四条标签），网格密度因此一致。

## 这一页的形状

1. **顶部条**：搜索框（吃显示名与标签）、「图像 / 视频」池子筛子（`全部 / 图像 / 视频`，池子按扫描名首段判，
   与提示词选择浮层同一份规则）、「来源」筛子（`全部来源 / 预设 / 自定义`）、条数、重新读取列表。
   排序固定「最新的排前面」，用列表条目自带的文件时间。
2. **卡片**：上半是封面（条目带 `cover` 才铺 `<img>`，`loading="lazy"`，地址由 `promptCoverUrl(name, v)`
   拼，`v=` 就是条目上那份封面 mtime），没封面就是文本位。下半是名字、两枚徽标（预设 / 自定义、图像 / 视频）
   与前三个标签。
3. **卡上的动作**：`填入绘画页`、`填入视频页`、`复制`、`设为封面`、`删除`。预设卡只有前三枚——
   预设池是代码目录，界面上不给一颗必败的钮。
4. **填入对应页**：先按扫描名读全文（`POST /rs_prompts/load_prompt`），再交装配层那条现成链
   `applyToPage(mode, text)`——`paint` 切绘画页填提示词框，`video` 走出视频页的复用填框，与增强页把回话
   填回页面是同一发落点。空正文报「这条提示词是空的」，不发那一发。
5. **设为封面**：开宿主的素材库取用弹窗（一次就收窗），收哪一类由当前那一池定：图像池取图，视频池取视频
   （后端取首帧成图）。选定就把 `{name, filename, subfolder}` 交 `POST /rs_prompts/set_prompt_cover`，
   成功后重读列表，卡片与新封面一起换。
6. **删除要按两次**：第一发只把那颗钮换成「确认删除」并把 title 改写成「再按一次…」，第二发才发
   `POST /rs_prompts/delete_prompt`；重画网格即 disarm，armed 的那一发不会挂到别的卡上。

## 封面那一发

- 封面是正文旁边的 sidecar：`prompts/custom/<扫描名>.jpg`，写下去就是 512px 长边的 JPEG（视频取首帧），
  没有要清的缩略图缓存目录。
- 只有用户点名那一发才写：素材卡「⋯」菜单的「设为提示词封面」（先点名要给的那条提示词）与本页卡上的
  「设为封面」两处，都不自动生成、不批量铺。
- 预设池是代码目录、出厂只读：写侧挡 403「出厂预设不带封面」，界面上也不铺那两枚钮。
- 读侧 `GET /rs_prompts/prompt_cover?name=&v=` 直接回那张 JPEG，`Cache-Control: public, max-age=31536000, immutable`；
  名字解析不到封面就是 404，卡片落文本位。
- 删正文连带删它旁边的封面（`delete_prompt` 里一并清），提示词树里不留没有主人的封面。

## 离线窗口

读侧六发（`list_prompts` / `list_prompt_names` / `load_prompt` / `list_prompt_lines` / `random_prompts` /
`prompt_cover`）都在桌面端能力表 `app/studio_caps.py` 的 `_PROMPTS` 里，离线窗口列表与封面照出。
写侧两发（`set_prompt_cover` / `delete_prompt`）不在表内，能力表上是 `prompt_library_write` 那一位：
离线时那两枚钮交运行闸门，点下去引导启动内核，不留一颗只会 409 的钮。

## 落点与用例

- 注册表一条描述符（`app-registry.js` 的 `prompts`，板块 `material`，图标 `list`）派生首页卡
  （`home-layout.js` 点名）与路由；页的 build 在 `studio-app.js` 的 `PAGE_BUILDERS` 里点名，
  工厂在 `studio/web/studio/pages/leaf-pages.js`，技能落地页清单（`studio/skill.py` 的 `SKILL_LANDINGS`）
  同认这一名——`studio/tests/js/app-registry.test.mjs` 把这几处钉在同一张表上。
- 样式：`studio/web/prompt-library/prompt-library.css`，颜色只取 `studio/style.css` 的 `--ns-*` 变量。
- 用例：`studio/tests/js/prompt-library.test.mjs`（卡片与封面、筛选、填页、设封面、两次确认删除、离线态）、
  `studio/tests/js/preset-picker.test.mjs`（浮层缩略位）、`studio/tests/test_prompt_covers.py`（sidecar 写 / 读 / 删、
  预设 403、源缺失 404、越界名字）。

提示词池与节点侧的链见 [prompts.md](prompts.md)，接口逐条见 [api-routes.md](api-routes.md)。
