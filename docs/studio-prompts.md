# 提示词库

Studio 首页「素材与配置」板块的卡片「提示词库」进 `#/prompts`（`studio/web/prompt-library/prompt-library.js`）。
顶栏没有这一枚页签：首页那张卡是这页唯一的来路，首页版式把这张卡删掉（在「添加卡片」里加回来），这一页也就进不去。
一条提示词一张卡：有封面就铺封面，卡上是那条提示词的正文摘要与标签 chip，卡底是来源与动作；
一屏 24 张卡，页码条常驻页面底沿。

## 这一页的形状

1. **标题行与筛子条**：标题行是页名、条数与「重新读取列表」；筛子条是搜索框（吃显示名与标签）、
   「图像 / 视频」池子筛子（`全部 / 图像 / 视频`，池子按扫描名首段判，与提示词选择浮层同一份规则）与
   「来源」筛子（`全部来源 / 预设 / 自定义`）。排序固定「最新的排前面」，用列表条目自带的文件时间。
2. **卡片**：封面那一档（条目带 `cover` 才铺 `<img>`，`loading="lazy"`，地址由 `promptCoverUrl(name, v)`
   拼，`v=` 就是条目上那份封面 mtime）、标题行（显示名 + 两枚徽标：预设 / 自定义、图像 / 视频）、
   正文摘要位（那条正文压成一行后的前 220 字，等宽字、灰底；读不到就整位收掉，卡片不铺「读取失败」）、
   标签 chip（最长三条）、卡底那一行（来源与「多久前」在左，动作排右）。
3. **分页**：一屏 24 张卡，页码条常驻页面底沿——首末箭头吃边界，「第 N / M 页」是那句读数。
   正文摘要按页发一次 `POST /rs_prompts/prompt_previews`，名字那一发最多 32 条，摘要按
   「扫描名 + 文件时间」记在这一页身上，重读列表换了文件时间才重取。
4. **卡上的动作**：`填入绘画页`、`填入视频页`、`复制`、`设为封面`、`删除`。预设卡只有前三枚——
   预设池是代码目录，界面上不给一颗必败的钮。
5. **填入对应页**：先按扫描名读全文（`POST /rs_prompts/load_prompt`），再交装配层那条现成链
   `applyToPage(mode, text)`——`paint` 切绘画页填提示词框，`video` 走出视频页的复用填框，与增强页把回话
   填回页面是同一发落点。空正文报「这条提示词是空的」，不发那一发。
6. **设为封面**：开宿主的素材库取用弹窗（一次就收窗），开窗先把这条的正文首行铺进素材库的搜索框——产物旁车的
   首行就是生成时那句提示词，窗里落的正是用它生成过的那几张，清空那一格才看全部素材。收哪一类由当前那一池定：
   图像池取图，视频池取视频（后端取首帧成图）。选定就把 `{name, filename, subfolder}` 交
   `POST /rs_prompts/set_prompt_cover`，成功后重读列表，卡片与新封面一起换。正文读不到不开窗，提示条说的是
   「封面设置失败」。
7. **删除要按两次**：第一发只把那颗钮换成「确认删除」并把 title 改写成「再按一次…」，第二发才发
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

## 封面回填脚本

已有大量出图时不必一条条手动挑：数据初始化脚本 `tools\fill_prompt_covers.py` 把产物对回提示词——
图旁的同名 .txt 旁车与图、视频内嵌的 ComfyUI 元数据里都写着那句提示词，脚本按整行相等挑出
「就是用它生成的那一条」，给没有封面的条按上面同一口径写 sidecar（512px 长边的 JPEG，视频取首帧）。
默认只出报告，`--apply` 才落盘；已有封面的条不动，`--overwrite` 才重写。图像提示词只收图、
`video/` 目录下的只收视频；正文首行太短的条没有判别力，不参与比对。`--loose` 把「首行出现在元数据
文本里」也算匹配——多段片的元数据是整篇正文，整行相等对不上时才用它。产物目录默认是 ComfyUI 的
`output` 与数据根的 `gallery/custom`，`--output-dir` 可再加，`--limit` 先试一小批。

```powershell
python tools\fill_prompt_covers.py                              # 只看报告
python tools\fill_prompt_covers.py --apply                      # 写缺的封面
python tools\fill_prompt_covers.py "<ComfyUI 根>" --loose       # 指定产物根并放宽匹配
python tools\fill_prompt_covers.py --apply --loose --limit 20   # 先写一小批
```

预设池是代码目录，脚本只扫 `prompts/custom`，与写侧同一道：出厂文件永不回填。

## 离线窗口

读侧七发（`list_prompts` / `list_prompt_names` / `load_prompt` / `prompt_previews` / `list_prompt_lines` /
`random_prompts` / `prompt_cover`）都在桌面端能力表 `app/studio_caps.py` 的 `_PROMPTS` 里，离线窗口列表、封面与摘要照出。
写侧两发（`set_prompt_cover` / `delete_prompt`）不在表内，能力表上是 `prompt_library_write` 那一位：
离线时那两枚钮交运行闸门，点下去引导启动内核，不留一颗只会 409 的钮。

## 落点与用例

- 注册表一条描述符（`app-registry.js` 的 `prompts`，板块 `material`，图标 `list`）派生首页卡
  （`home-layout.js` 点名）与路由；页的 build 在 `studio-app.js` 的 `PAGE_BUILDERS` 里点名，
  工厂在 `studio/web/studio/pages/leaf-pages.js`，技能落地页清单（`studio/skill.py` 的 `SKILL_LANDINGS`）
  同认这一名——`studio/tests/js/app-registry.test.mjs` 把这几处钉在同一张表上。
- 样式：`studio/web/prompt-library/prompt-library.css`，颜色只取 `studio/style.css` 的 `--ns-*` 变量。
- 用例：`studio/tests/js/prompt-library.test.mjs`（卡片与封面、正文摘要、分页、筛选、填页、设封面、两次确认删除、离线态）、
  `studio/tests/js/preset-picker.test.mjs`（浮层缩略位）、`studio/tests/test_prompt_covers.py`（sidecar 写 / 读 / 删、
  预设 403、源缺失 404、越界名字）、`studio/tests/test_prompts_tags_scan.py`（摘要压成一行与截断、解析不到不落键）。

提示词池与节点侧的链见 [prompts.md](prompts.md)，接口逐条见 [api-routes.md](api-routes.md)。
