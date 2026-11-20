# 提示词库

Studio 首页「素材与配置」板块的卡片「提示词库」进 `#/prompts`（`studio/web/prompt-library/prompt-library.js`）。
顶栏没有这一枚页签：首页那张卡是这页唯一的来路，首页版式把这张卡删掉（在「添加卡片」里加回来），这一页也就进不去。
一条提示词一张卡，卡片按瀑布流排（素材页那一份装箱，`web/gallery-masonry.js`）：上面那一档是媒体位，宽度吃满卡片、
高度认画面朝向（横版裁到 3/4 卡宽，竖版整宽、最长 2 倍卡宽）——正文旁的封面 sidecar 优先，随包预设没有 sidecar 时铺
云端目录那张封面；取不到画面的卡把标题行放在最上方，正文摘要那一格文字位落在它下面，不铺假缩略图。媒体位下面是名字与标签 chip，
卡底是来源与动作；有画面的卡片整张点开灯箱（素材页那一份 `web/lightbox.js`）；一屏 24 张卡，滚到底那一发才追加下一屏。

## 这一页的形状

1. **标题行与筛子条**：标题行是页名、条数与「刷新」——那一发先把云端预设索引整片强制重拉（主索引 + 逐目录索引：卡片上的云端图
   与预览配对只读 `gallery/oss_cache/` 里那份目录索引缓存，主索引在进程里按 24 小时缓存），拉回来才重读列表；带
   `prompts` 标签的每个云端目录都是提示词池的镜像源，这一发把云端有、池子里没有的条补进 `presets/<目录>/` 与
   `presets/video/<目录>/`（正文旁边一并落一张封面 sidecar——卡片那格图位与视频的预览都从它起步），云端删掉的
   条一并从这两处收掉（目录索引没刷到主索引当前 rev 时不删，一次断网不清池）；toast 报出补进与收掉的条数。
   没配云端预设与内核没跑这两发各说清是哪一发，本地列表照重读。筛子条是搜索框（吃带目录段的扫描名与标签）、
   「图像 / 视频」池子筛子（`全部 / 图像 / 视频`，池子按扫描名首段判，与提示词选择浮层同一份规则）、「来源」筛子
   （`全部来源 / 预设 / 自定义`）、排序筛子（`最新 / 最早 / 名称`——最新与最早吃列表条目自带的文件时间，名称吃去掉
   目录段的显示名）与标签筛子（词表由这一份列表的标签按出现次数排出，最多 14 颗，第一颗是「全部标签」；词表不足两颗
   就不铺这一排，一颗筛子筛不出任何东西）—— chip 与素材库类型 chip 同一份样式：透底胶囊 + 浅描边、
   11px 字、hover 描边走强调橙、选中整颗填强调橙。热度、作者、点赞那一排在 [prompts.chat](https://prompts.chat/prompts)
   靠云端数据，这一页的条目只有文件时间与标签，界面上就不铺没有数据的控件。
2. **卡片**：卡片列宽固定 230px、列数由页宽排出，长短不一的卡片由 `gallery-masonry.js` 逐个放进当前最矮的一列
   （与素材页同一份装箱）。媒体位那一档宽度吃满卡片，取图按「云端图像媒体 → 封面 sidecar → 云端目录封面」——图像媒体与目录封面都由
   `cloudDirCoverUrl` 拼（缩略图代理），封面 sidecar 由 `promptCoverUrl(name, v)` 拼、`v=` 就是条目上那份
   mtime，`<img>` 一律 `loading="lazy"`；三样都没有就把标题行落在卡片最上方、正文摘要那一格文字位放在它下面，不留空档。
   媒体位的高度认画面朝向：尺寸先认写封面那一步记在指针里的 `w` / `h`（卡片落位就定高，瀑布流不在画面到位之后
   整页重排），云端那条媒体与出厂目录封面没这份记录才退回探测——图在 `load` 认、视频在 `loadedmetadata` 认，预览
   位先探它那张 poster（poster 就是这条的封面，比例与成片一致，等 metadata 的话竖版卡会先以 4:3 落位再重排）。
   横版裁到 3/4 卡宽，竖版整宽、最长 2 倍卡宽，画面到位卡片便长高，装箱跟着重排。两条自动播链都认——
   配上云端媒体的那一条播 480p 静音预览（见「云端预览那一发」，只认视频池），自定义那条播封面指针指的本地成片
   （见「本地成片那一发」，图像池与视频池都认——指针记的就是这张封面的来路），`poster` 都是这条的封面，
   卡角带一枚播放角标。接着是标题行（名字本身，不带目录段——这一页顶上有池子筛子，
   标题再写一遍目录是白占一行；整条扫描名在这张卡的悬停提示里，搜索照旧吃带目录段的全名 + 两枚徽标：预设 / 自定义、图像 / 视频；没有画面的卡这一行是卡片的第一行，正文那一格落在它下面，
   池子标签只在这两枚徽标里出现一次，卡上不铺第二枚同样的标签）、
   正文摘要位（那条正文压成一行后的前 220 字，等宽字、灰底、最长三行；读不到就整位收掉，卡片不铺「读取失败」）、
   标签 chip（最长三条）、卡底那一行（来源与「多久前」在左，动作排右）。hover 把描边推到强调橙、画面推近 1.05 一档，
   系统开了「减少动态效果」时这一档全收。
   有画面的卡整张点开灯箱（`web/lightbox.js`，素材页那一份）：放进去的都是本体，不是卡片那一格那一发——图像卡里
   配上云端图像媒体的那条放云端目录里那张整图（`GET /neo_gallery/image?filename=&subfolder=`：卡片那一格吃的是
   同一张的 512 缩略图，云端目录那条在缩略图路由上回的是发布时预生成的那张小图，放大它就是糊的），封面指针
   是图的那条放指针那条产物，只有 sidecar 封面的那条放 sidecar；视频卡播的是原片——云端那条
   走同一条视频代理去掉 `preview=1` 那一发，自定义那条就是封面指针那条本地成片本体，带播放控件、不静音；
   卡片那一格照旧是发布时压的 480p 静音预览，进视野才要文件。光标在这张卡上是放大那一发；←/→ 只在当前
   筛子那叠有画面的卡之间翻，文字位卡片没有可放的画面、点下去不开窗。灯箱侧栏是这条的标签与全文（正文走
   `POST /rs_prompts/load_prompt` 那一发，读不到就只铺标签，全空不占位），底栏动作与卡上同一口径、认这条的池子。

3. **滚动加载**：一屏 24 张卡，滚到底那一发才追加下一屏——底部那一行（`.ns-pl-more`）进视野就补一屏，
   铺完落一句「已全部 N 条」，页面没有页码条。列表读回来之前网格
   先铺 24 张骨架卡（卡形占位加微光，瀑布流先有一屏形状；系统开了「减少动态效果」就不闪），列表到位就整片换成真卡。
   搜索与筛子一动就重装首屏那一屏，并把这一页的滚动位拉回顶——滚在下面的视口留在新一叠的空档上。
   正文摘要按屏发一次 `POST /rs_prompts/prompt_previews`，名字那一发最多 32 条，摘要按
   「扫描名 + 文件时间」记在这一页身上，重读列表换了文件时间才重取。
4. **卡上的动作**：填页那一发认池子——视频条只铺 `填入视频页`，图像条只铺 `填入绘画页`，卡上不留一颗用不上的钮；
   接着是 `复制`、`设为封面`、`删除`。预设卡只有填页与复制两枚——预设池是代码目录，界面上不给一颗必败的钮。
5. **填入对应页**：先按扫描名读全文（`POST /rs_prompts/load_prompt`），再交装配层那条现成链
   `applyToPage(mode, text)`——`paint` 切绘画页填提示词框，`video` 走出视频页的复用填框，与增强页把回话
   填回页面是同一发落点。空正文报「这条提示词是空的」，不发那一发。
6. **设为封面**：开宿主的素材库取用弹窗（一次就收窗），开窗先把这条的正文首行铺进素材库的搜索框——产物旁车的
   首行就是生成时那句提示词，窗里落的正是用它生成过的那几张，清空那一格才看全部素材。收哪一类跟着筛子走：
   筛「图像」取图、筛「视频」取视频（后端按产物类型取首帧成图）、筛「全部」两类都取——图像池的提示词也能钉一条
   成片当封面，卡片照播那条指针指的本地成片。选定就把 `{name, filename, subfolder}` 交
   `POST /rs_prompts/set_prompt_cover`，成功后重读列表，卡片与新封面一起换。正文读不到不开窗，提示条说的是
   「封面设置失败」。
7. **删除要按两次**：第一发只把那颗钮换成「确认删除」并把 title 改写成「再按一次…」，第二发才发
   `POST /rs_prompts/delete_prompt`；重画网格即 disarm，armed 的那一发不会挂到别的卡上。

## 封面那一发

- 封面是正文旁边的 sidecar：`prompts/custom/<扫描名>.jpg`，写下去就是 512px 长边的 JPEG（视频取首帧），
  没有要清的缩略图缓存目录。
- 只有用户点名那一发才写：素材卡「⋯」菜单的「设为提示词封面」（先点名要给的那条提示词）与本页卡上的
  「设为封面」两处，都不自动生成、不批量铺。
- 预设池是代码目录、出厂只读：写侧挡 403「出厂预设不带封面」，界面上也不铺那两枚钮；随包预设没有封面 sidecar，
  池名对上云端目录的条目铺那张云端目录封面（见「云端目录封面那一发」），其余不铺图位，卡片落名字与摘要。
  导入的提示词根本不进预设池（见下节），用户封面永远不进预设池。
- 读侧 `GET /rs_prompts/prompt_cover?name=&v=` 用 `FileResponse` 直接回那张 JPEG，`Cache-Control: public, max-age=0, must-revalidate`：
  每次进页面都带条件请求，响应带 `Last-Modified`，文件没变回 304。一年期 `immutable` 会把 ComfyUI 重启窗口里那一次失败响应钉死在封面 URL 上，
  浏览器连硬刷都不发请求，卡片便永久空白，因此不发这一位。名字解析不到封面就是 404，卡片不铺图位，落名字与摘要；
  取图失败时卡片先换一个查询参数重取一次（新缓存键，必须重新发请求），再失败才收掉这一档。
- 封面旁边还有一条指针 `<扫描名>.cover.json`（`filename` / `subfolder` / `kind`，外加封面自己的像素尺寸 `w` / `h`）：
  只有「设封面」那一发与封面回填脚本写它，`list_prompts` 据此给条目多带一个 `cover_media` 键——卡片只认
  这一发认得出「这张封面是素材库哪一条产物播出来的」，瀑布流的卡片也按 `w` / `h` 在落位那一发就定高。这条写法
  之前写的指针没有 `w` / `h`，读侧照出、不带这一位，卡片退回探测那张封面。指针读不出（被外部编辑器写坏、没有
  filename）时列表不带这一位，卡片落一张静封面。
- 删正文连带删它旁边的封面与那条指针（`delete_prompt` 里一并清），提示词树里不留没有主人的封面，也不留一条指向空封面的指针。

## 云端预览那一发

- 云端预设目录里的视频提示词，卡上那一档播发布时 `--preview` 压的 480p 静音片：`poster` 是这条的封面 sidecar，
  `muted / loop / playsinline / preload="none"`，`src` 由 IntersectionObserver 在卡片进视野那一发才挂上，出视野就停。
- 配对先认正文首行：本地正文的首行与云端目录索引里那条预览的 `提示词：` 首行整行相等才算命中，
  索引里被 500 字截断的那一条按前缀比；整篇正文没有 `提示词：` 那一行时（导入的提示词）取正文首行。
  撞出两条以上退到文件名：池里的条目名与发布时的文件名去序号与标点后相等（云端名被截断的按前缀比）。
  两条路都撞、都空就不钉。没有 OSS 配置、目录索引没缓存到本地、正文没配上的条目都落封面图，配对这一发不碰网络。
- 图位顺序：云端那条图像媒体 → 正文旁的封面 sidecar → 云端目录封面（`dir_cover`）。图像媒体铺云端那张真图
  （缩略图代理 512px），池里那张排版占位 sidecar 让位；视频池配上对的那一条仍是 480p 预览，poster 用封面 sidecar。
- 灯箱放的是同一来路的本体，不是卡片那一格：图像媒体那条走 `GET /neo_gallery/image?filename=&subfolder=`（素材页
  灯箱那一条），封面指针是图的那条走指针那条产物，目录封面那条只有是图才换本体——视频目录的封面本来就是索引里
  那一帧，没有图本体可放大
- 预览位的 `poster` 只认这条的封面 sidecar：只带云端目录封面（`dir_cover`）的条目铺那张目录封面图，不铺预览视频。
- 地址是 `GET /neo_gallery/video?filename=&subfolder=&preview=1`：预览从 `neo/presets/previews/<目录>/` 进
  `gallery/oss_cache/previews/<目录>/`，之后重播读本地缓存（响应带 `Cache-Control: public, max-age=86400`）。
  不带 `preview` 的那一发取的是原片，落 `oss_cache/<目录>/`，素材页灯箱播的仍是原片。
- 离线窗口里这一发 409，卡片停在封面上；系统开了「减少动态效果」（`prefers-reduced-motion`）时不铺预览视频。

## 本地成片那一发

- 带 `cover_media` 且指针 `kind` 是 `video` 的那一条（封面旁边那条指针记着 `filename` / `subfolder` / `kind`），
  卡上那一档播素材库里那条成片本尊，图像池与视频池都认——池子筛子只筛列表，不决定一张封面的来路：
  `GET /neo_gallery/video?filename=&subfolder=`，不带 `preview` 那一发——与素材方块、素材库灯箱同一
  口径，这条路由在桌面端离线能力表内。`poster` 是那张封面，`muted / loop / playsinline / preload="none"`，`src` 同样
  由 IntersectionObserver 在卡片进视野那一发才挂、出视野就停，声音永远留给素材页的灯箱。
- 指针那条是图（`kind: image`）、这条没有封面、指针读不出——任一条都退成静封面，不铺预览位，
  不发一条必败的请求；云端预览优先，配上云端媒体的那一条照播 480p 预览。
- 指针由 `prompt_names.write_cover_source` 写：界面上是 `set_prompt_cover` 写封面之后补一条（kind 按 gallery 的视频
  后缀判），回填脚本 `--apply` 写完封面补一条（subfolder 按产物根目录算，落在已知根之外的留空，卡片落静封面）；
  已有封面、对得上视频、旁边没有指针的条只补那条指针，那张封面 JPEG 不动——旧版本设的封面就此会动了。
  来路整行对不上的那种走 `--frame-match` 的首帧签名：一条视频只抽一次首帧（宽度 64 保比例，灰度缩到
  16x16 按整幅均值归一），第一名 ≤ 0.02 且赢第二名 4 倍才认，比例差过 8% 的首帧不进排名，同样只写指针。
  指针写失败不动封面——设封面那一发已经成功了，卡片落一张静封面比一次半途失败的设封面便宜。

## 云端目录封面那一发

- 随包预设池只发 `.txt`，池名就是发布时那个云端目录名：`list_prompts` 给这种条目多带一个 `dir_cover` 键
  （`{filename, subfolder}`），卡片拿它补上那张图。已有封面 sidecar 的条目、已按正文配上媒体（`media`）的条目
  与子目录条目（`video/<目录>/<条>`）都不带这一位——图位归封面 sidecar 与那条媒体管。
- 封面候选取自主索引里该目录的 `covers`，按发布顺序取第一份带缩略图的（音频那条在素材页是装饰波形位，没有图可铺）；
  只读磁盘上的索引缓存，这一发不碰网络，目录没有封面候选时不铺图位，卡片落名字与摘要。
- 地址是 `GET /neo_gallery/thumbnail?filename=&subfolder=&size=512`：`filename` 是那条媒体名，索引里它的 `thumbnail`
  从 `neo/presets/thumbnails/<目录>/` 进 `gallery/oss_cache/thumbnails/<目录>/`，之后读本地缓存
  （响应带 `Cache-Control: public, max-age=86400`）。
- 离线窗口里这一发 409，卡片收掉图位，名字与摘要照出。

## 封面回填脚本

已有大量出图时不必一条条手动挑：数据初始化脚本 `tools\fill_prompt_covers.py` 把产物对回提示词——
图旁的同名 .txt 旁车与图、视频内嵌的 ComfyUI 元数据里都写着那句提示词，脚本按整行相等挑出
「就是用它生成的那一条」，给没有封面的条按上面同一口径写 sidecar（512px 长边的 JPEG，视频取首帧）与它旁边那条
封面指针（`<扫描名>.cover.json`，卡片据此自动播这条成片）。
默认只出报告，`--apply` 才落盘；已有封面的条不动，`--overwrite` 才重写，已有封面、旁边没有指针、
对得上视频产物的条只补那条指针（不动那张 JPEG，卡片从一张静封面落回那条成片）。图像提示词只收图、
`video/` 目录下的只收视频；正文首行太短的条没有判别力，不参与比对。`--loose` 把「首行出现在元数据
文本里」也算匹配——多段片的元数据是整篇正文，整行相等对不上时才用它。首行对不上来路的条留一张静封面，
那条成片在界面上「设为封面」自己挑。产物目录默认是 ComfyUI 的
`output` 与数据根的 `gallery/custom`，`--output-dir` 可再加，`--limit` 先试一小批。

```powershell
python tools\fill_prompt_covers.py                              # 只看报告
python tools\fill_prompt_covers.py --apply                      # 写缺的封面、补缺的指针
python tools\fill_prompt_covers.py "<ComfyUI 根>" --loose       # 指定产物根并放宽匹配
python tools\fill_prompt_covers.py --apply --loose --limit 20   # 先写一小批
```

预设池是代码目录，脚本只扫 `prompts/custom`，与写侧同一道：出厂文件永不回填。

## 导入的提示词走云端预设（prompts.chat）

prompts.chat 的提示词文本是 CC0 1.0 公有领域（站上的 LICENSE 写明：提示词内容与数据进公有领域，站的代码是 MIT），
正文可以逐字带走。每条自带的 `mediaUrl` 不在那条措辞里：它是站上作者上传的示例产物，托管在站外第三方
（DigitalOcean Spaces、pbs.twimg.com、wiro.ai、fal.media）。所以 `tools\import_prompts_chat.py` 产的是**云端图库预设
的构建目录**，代码目录一个文件都不写：`--build` 把 `IMAGE` / `VIDEO` 两型按 upvotes 落进
`tmp\gallery_pack\prompts.chat\`（在 `.gitignore` 里），一条一个 stem 一对文件——`NN_<名称>.<媒体>` + 同名 `.txt`
旁车，旁车按图库的「标签：值」版式写（首两行是标题与正文，卡片预览取前两行，灯箱走 `/neo_gallery/txt` 读全文）。

图位优先是站上那份示例产物；拉不动、类型不认识、超 24MB、落地短于 `Content-Length`（断流）的条落本地排版的预览图，
没有 `mediaUrl` 的条同样排一张预览占住图位——`gallery_preprocess.py` 对只有 `.txt` 的条目直接跳过，云端卡没有图位就不出卡。排版预览底色按标题取色，
重跑字节一致，它不是任何真实产物，因此只活在云上。`--skip-preview` 把这条口径立成硬门槛：没有示例产物的条整条
不要，旁车与清单都不记它——云端卡片不该拿纯文字排版当图位。

上云与素材预设同一条链（[gallery.md](gallery.md)）：

```powershell
python tools\import_prompts_chat.py --top 20 --pages 2 --build --skip-preview --out tmp\gallery_pack
python tools\gallery_preprocess.py --presets tmp\gallery_pack --output tmp\gallery_pack --dirs prompts.chat --tag prompts --preview
python tools\gallery_deploy_oss.py --source tmp\gallery_pack --bucket <bucket> --prefix neo/presets/ --endpoint <endpoint>   # 先看 --dry-run
```

`gallery_preprocess.py` 把合并基准拉成线上主索引（`configs/oss_presets.json` 的 `index_url`），产
`prompts.chat\index.json` 与 `thumbnails\prompts.chat\`，主索引挂一张 `prompts.chat` 卡。视频条的缩略图要 ffmpeg
出首帧，解析链与素材页同一道（PATH 里的 ffmpeg，其次 imageio-ffmpeg 自带的二进制），两者都没有时那张卡没有预览。
`--preview` 在同一发里给每条视频压一版 480p 静音预览落 `previews\prompts.chat\`（crf 30、码率上限 700k、faststart），
目录索引条目带 `preview` 键，提示词库的卡片就播这一发；ffmpeg 缺席时只跳过预览，原片照发。
首次发布要在同一次 preprocess 里带 `--tag prompts`：`--tag-dirs` 只给主索引里已有的目录补标签。
`gallery_deploy_oss.py` 的 endpoint 取 `OSS_ENDPOINT` 环境变量，那里不是 endpoint 时要点名
`--endpoint https://oss-<region>.aliyuncs.com`——`--dry-run` 不连桶，照不出这个坑。

逐条来源记在 `<out>\prompts.chat.manifest.json`：来源接口、许可说明、逐条的 url / 作者 / 标签与正文和媒体的 sha256。
清单刻意写在 `prompts.chat\` 之外——`gallery_deploy_oss.py` 把 `--source` 目录里每个文件都当对象上传，落在目录里的
那份会被插件读成卡里的条目。

用户侧是素材库里那张 `prompts.chat` 云端预设卡：点开、用「复制提示词」把正文贴进生成器（[gallery.md](gallery.md)）。

边界：`--build` 才产文件，同名旁车不重写，`--overwrite` 是唯一重写旁车的开关，`--skip-preview` 把没有示例产物的条
整条丢掉；`--type IMAGE` 与 `--type VIDEO` 分开跑，
序号按排名写——站上的票一变排名就漂，所以清单记过 slug 的条只认它第一次落的 stem，漂到别名下水会把同一条发成两张卡。
用例在 `studio/tests/test_import_prompts_chat.py`，接口层与媒体下载都是替身——跑用例不发一个网络请求。

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
- 用例：`studio/tests/js/prompt-library.test.mjs`（卡片与封面、正文摘要、滚动加载、筛选、排序与标签筛子、骨架卡、
  填页、设封面、两次确认删除、离线态，以及媒体位朝向、文字卡、两条自动播链）、
  `studio/tests/js/preset-picker.test.mjs`（浮层缩略位）、`studio/tests/test_prompt_covers.py`（sidecar 写 / 读 / 删、
  封面指针写 / 读 / 删与坏指针退静封面、预设 403、源缺失 404、越界名字）、
  `studio/tests/test_prompts_tags_scan.py`（摘要压成一行与截断、解析不到不落键）。

提示词池与节点侧的链见 [prompts.md](prompts.md)，接口逐条见 [api-routes.md](api-routes.md)。
