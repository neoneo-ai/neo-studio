# 3D 姿势

「3D 姿势」页把 3d-pose-art 的浏览器姿势装进 Neo Studio：页面在 iframe 里跑 three.js，宿主只负责
伺服产物、承载页面与桥接口。姿势、时间轴、导出全在浏览器里完成，本机服务只提供文件读写。

## 姿势包

产物有两级落点，逐请求按这个顺序找，**数据根那份压住随包那份的同名文件**（用户同步的全量产物因此优先）：

| 落点                  | 内容                                                   | 怎么来                                                      |
|-----------------------|--------------------------------------------------------|-------------------------------------------------------------|
| `<数据根>/pose/dist/` | 全量产物，含 `*.map`，约 16MB                          | `tools\sync_pose_dist.ps1`；「启动设置 → 姿势仓库」自动同步 |
| `studio/pose_dist/`   | 最小授权副本，代码 + CC0 标准素体 + 自制道具，约 3.0MB | `tools\build_pose_package.ps1`，随 Registry 包与 exe 分发   |

随包那份按**授权口径**取舍，不按体积：`models/ATTRIBUTION.md` 里页面默认基座的 `bodyMale.glb` /
`bodyFemale.glb`（本项目生成链产的标准男 / 标准女，基网格是 MakeHuman Community 的 MPFB2，CC0）
与自制的 `props/stick.glb` / `props/sword.glb`（`scripts/makePropGlb.mjs` 从 `propKit` 零件清单生成）
写明可自由再分发，所以它们随包；`ybot.glb`（CC0，PixelMannen 的 Y Bot）页面已不默认它，2.8MB 不再随包；
Mixamo（`soldier` / `ch38` / `ch07`）、SMPL 派生（`body1391` 与三份缩略图）
与本地导入的道具（`arrow` / `sting-sword` / 枪械，来源待确认）全都不入库。面板的素体下拉只发
`bodyMale` / `bodyFemale` 这两具 CC0 基座（`studio/web/pose/pose.js` 的白名单）：Mixamo、SMPL 派生与
用户自备的 GLB 都不出现在面板上 —— 那几份的授权条款不在本项目手里，面板不发货；要它们的人在姿势页
自己那侧的本地导入区登记。道具注册表
`models/props/index.json` 只留随包发了的那两条 —— 注册表里列一个包里没发的 GLB，等于发一条点了只会失败的
控件，清表与清文件是同一件事，程序化道具（`builtin:*`）照旧可用。道具的预览图（`models/props/preview/*.png`，
姿势仓库 `npm run prop:preview` 逐件渲染）只带注册表写了 `preview` 且 dist 里真有那张图的件；注册表写了
`preview` 而图不在 dist 里时，打包脚本把这一行的 `preview` 去掉再发货，面板上出的是「无预览」而不是一张坏图。
`*.map` 不进包：产物只有一条 `sourceMappingURL`，
浏览器只在 devtools 打开时取它，发出去只让每个用户多下载 4.4MB。包里另带 `LICENSE`、
`THIRD-PARTY.md`（terser 删掉的上游许可横幅补在这里）与 `MANIFEST.json`（逐文件 `bytes` + `sha256`）。
产物里烘进的开发机绝对路径（素体注册表的 `sourceImage`）在打包时清掉，随包发不出去。

```
pwsh tools\build_pose_package.ps1                                      # 取 <数据根>/pose/dist 的现成产物
pwsh tools\build_pose_package.ps1 -Source <3d-pose-art 仓库根> -Build  # 先 npm run build 再打包
pwsh tools\test_pose_package.ps1                                       # 复查包：清单哈希、体积上限、不该发货的形态
pwsh tools\sync_pose_dist.ps1 -Source <3d-pose-art 仓库根>            # 全量产物同步进数据根（优先那一级）
```

`robocopy /MIR` 只镜像 `dist/`：`<数据根>/pose/scenes/` 里用户写的场景不在镜像
范围内；`pose/dist/models/` 里随包副本之外的那几份 GLB（用户在姿势页自己那侧导入的）也不在源产物里，同步脚本先把这些
「源里没有的文件」存进临时目录、镜像完原样搬回，一次重装姿势包不会无声清掉它们在着的那几份。源仓库根的
`LICENSE` / `NOTICE` 一并落进产物目录（姿势包是 MIT 作品，装机副本必须带着它的许可证与致谢）。
装完刷新页面就生效：装没装是逐请求判断的，不必重启窗口。

「启动设置 → 姿势仓库」填上 3d-pose-art 仓库根后，桌面端每次启动都按同一口径把这一级补进数据根：
只在「源比数据根新」时动手（重复启动跑不出文件复制），手动删过的产物下一轮原样补回，
`pose/dist/models/` 里随包之外的那几份 GLB 先存后还，镜像不动它们。判据与落点写在
[studio-desktop.md](studio-desktop.md) 的「姿势资产自动同步」。

## 姿势库（pose-lib）

库里是姿势仓库攒下来的那批整场与它们的预览图。姿势仓库那边库拆成两根 —— `pose-lib/` 预设库（只读、
随仓库分发）与 `pose-lab/` 本地库（作者自己写的姿态，可写），同步到 Neo Studio 时合并成一份，落点仍只有
一级：`<数据根>/pose/lib/`，同 id 以本地为准。库不进随包副本 —— 授权口径与姿势包不同，
`tools\build_pose_package.ps1` 不打包它 —— 只由同步脚本落地。整目录当缓存看待：随时可删可重同步。
`pose/` 下的 `scenes/` 是用户写的东西，不在镜像范围内。

| 落点                               | 内容                                                                               | 怎么来                             |
|------------------------------------|------------------------------------------------------------------------------------|------------------------------------|
| `<数据根>/pose/lib/poses/`         | 一条一张 `.scene.json`（`3dpose.scene/1`：多人 + 道具 + 视角），预设集 + 本地集    | `tools\sync_pose_lib.ps1`          |
| `<数据根>/pose/lib/preview/`       | `<id>.<档位>.png`：`clay` / `skeleton` / `silhouette` / `depth`                    | 同上                               |
| `<数据根>/pose/lib/index.json`     | 逐条 `id / label / groups / categories / tags / path / preview / origin / charKey` | 姿势仓库的 `npm run lib -- merged` |
| `<数据根>/pose/lib/ATTRIBUTION.md` | 预设集的逐条作者 / 授权 / 原帖                                                     | 同上（源在 `pose-lib/`）           |

清单不在同步脚本里算：由姿势仓库把预设与本地两份索引合并（同 id 本地胜出、每条带 `origin`）后交给
`--out` 落进库根。`-Source` 指姿势仓库根，缺预设库的 `index.json` 与 `poses\` 时脚本直接退出并把该跑的
那条 `npm run lib -- shipped` 报出来。合并条目自带 `charKey`：姿势仓库 `npm run lib:bodies` 的分派结果，
弹窗的基座筛选按它过滤，默认落在画布当前那具素体（姿势页开局是 `bodyMale`，素体下拉改档筛选跟着走），
没有分派结果的条目不带这个字段、只在「全部基座」那一档可见。「启动设置 → 姿势仓库」填上仓库根后
这一级同样由桌面端每次启动自动同步，口径见 [studio-desktop.md](studio-desktop.md) 的「姿势资产自动同步」。
预览按档位同步：

```
pwsh tools\sync_pose_lib.ps1 -Source <3d-pose-art 仓库根>        # 默认档：clay + skeleton + silhouette
pwsh tools\sync_pose_lib.ps1 -Source <3d-pose-art 仓库根> -Light # 只 skeleton + silhouette：弹窗缩略图最省的一版
pwsh tools\sync_pose_lib.ps1 -Source <3d-pose-art 仓库根> -All   # 四档全带，含 depth 预览
```

`/MIR` 镜像 `preview/` 时按档位 `/XF` 排除；被排除的那一档在上一轮宽档里可能已经落进库里，`/MIR`
不清排除项，脚本随后按 `*depth.png` / `*clay.png` 把这类残留摘掉 —— 宽档跑过一轮再跑窄档，库里留不下
两套档位混着的样子。

`poses/` 与 `preview/` 都是两遍：本地库先 `/MIR` 进目标（顺手清掉上一轮的多余文件），预设集再补进来。
预设集那一遍带 `/E /XC /XN /XO`：`/E` 必给 —— 库文件全在 `poses/<分组>/` 子目录里，robocopy 默认不
下钻子目录，少了它就是「预设集一条都没补上」；`/XO` 让预设集永不压过同名文件，预设条目因此只补空、
不改本机已有那份，与合并索引的「同 id 本地胜出」是同一件事的两个面。

后端读接口只有 `/pose-lib/{path}`：`index.json`、`poses/**`、`preview/*.png`、`categories.json`、
`ATTRIBUTION.md`。分类登记两库里各一份，本地库改过就以它同步过来，预设那份只兜底。
落点锁在 `<数据根>/pose/lib`，路径逐条过 `inside_dir` 的包含检查（带 `..`、盘符、绝对路径一律 `400`），
空路径与前缀指到的目录都落到 `index.json`，文件不在回 `404` —— 库没同步与库里缺文件是同一个答案，
弹窗按清单读不读得到判断（`index.json` 读不成就是没同步），不让用户翻进一个空库。库里每次同步都重写
文件，整条前缀因此回 `Cache-Control: no-cache`：长缓存会把重同步之后的清单与预览图停在上一版，
`index.json` 与场景文件都不许带 `immutable`。库里全程只读，Neo Studio 这边往库里写文件的路一条都没有，
写落点只有场景那一条 `/neo_pose/scene`。

`/pose-lib` 与 `/pose-dist` 同一条路子：两端各自直接注册的静态前缀，不进能力归属表，离线桌面服务
自己答它。`/neo_pose/status` 报库里那一级的状态：`lib_dir`（落点）、`lib_installed`（清单读得到且
条目非空）、`lib_entries`（清单里的条目数）、`lib_bytes`（整目录体积）。

## 云端姿势库（pose-cloud）

云端库是 OSS 上的另一棵姿势树：预设库攒出来的那批整场与它们的预览图。条目形状与 `pose-lib` 同源，
云端清单格式是 `neo-pose-cloud/1`，弹窗的卡片、分组、搜索与门禁两条来源共用同一段代码 —— 换来源只
换数据源，卡片的形状、副标题的人数与道具数、点卡片套整场那一路都不变。

配置只有一条：`<数据根>/configs/oss_presets.json` 里的 `pose_index_url`，指向云端那棵树的
`<前缀>/index.json`。它是 OSS 预设配置里的第三个字段，与 `presets` / `default_oss` 各管各的，缺这条
就是「未配置」：「3D 云端姿势」整片关，本机库照常工作。云端道具由那份索引的 `props` 数组点名，逐件读姿势仓库
`public/models/ATTRIBUTION.md` 的授权行才进索引：那一行给「可再分发」的才发（CC0 与本项目自制），Royalty Free、
来源授权待确认与 Mixamo 仅个人使用都不发。随包白名单管的是 4.5MB 的包里发哪两件 GLB，管不着云端那一棵。

| 落点                                     | 内容                              | 怎么来                                 |
|------------------------------------------|-----------------------------------|----------------------------------------|
| `<数据根>/configs/oss_presets.json`      | `pose_index_url`（云端索引地址）  | 手工写一次，指向上传脚本落成的那棵树   |
| `<数据根>/pose/oss_cache/_index.json`    | 上次取回的云端清单                | 读侧取回索引时落盘                     |
| `<数据根>/pose/oss_cache/poses/**`       | 取回过的整场 `.scene.json`        | 点云端卡片套整场时按需取回             |
| `<数据根>/pose/oss_cache/preview/**`     | 取回过的预览图                    | 「刷新缩略图」逐张取回                 |
| `<数据根>/pose/oss_cache/models/props/`  | 取回过的云端道具 GLB 与道具预览图 | 添加云端道具时按需取回                 |

`pose/oss_cache/` 整棵镜像云端目录树，与 `pose/lib` 一样当缓存看待：随时可删可重建，路径就是云端相对
路径。索引与预览图只读缓存 —— 缓存里没有就是没有，读侧不在请求里拉远端：打开姿势页、打开弹窗都不会
先打一次 OSS，云端没部署过时页面出的是部署指引而不是一片空列表。场景文件与道具 GLB 是缓存未命中才取
OSS，取回落盘再伺服，重开弹窗不再重传。

三条读接口都在 `studio/pose_cloud.py`，插件端与桌面离线服务共用同一份函数体，逐条登记在
`/neo_pose` 的接口归属里：

| 方法 | 路由                         | 说明                                                                     |
|------|------------------------------|--------------------------------------------------------------------------|
| GET  | `/neo_pose/cloud_status`     | 配没配、云端索引地址与根前缀、缓存在不在、缓存目录                       |
| GET  | `/neo_pose/cloud_index`      | 读缓存里那份云端清单（只读缓存，回 `{index, cached}`）                   |
| GET  | `/neo_pose/cloud_file?path=` | 取一份云端文件：整场 JSON、预览图、`models/props/**`（GLB 与道具预览图） |

云端文件只认云端清单里的相对路径：`poses/<组>/<id>.scene.json`、`preview/<...>.png` 与
`models/props/<file>.glb`（道具与道具预览图写成 `props/<file>.glb`、`props/preview/<name>.png` 是同一条落点的两侧名字，
代读时整段换前缀）。带 `..`、盘符、绝对路径与
以 `/` 或 `\` 开头的路径在配置检查之前就被拒成 `400`，落点永远锁在缓存目录内 —— 坏路径不会答成
「未配置」。未配置时清单与文件都回带部署指引的 `400`，云端没有那份文件回 `404`，上游取回失败回
`502`。道具 GLB 落缓存前先验文件头是 `glTF`：上游把错误页当文件发时，那份不落进道具目录。
`/neo_pose/cloud_status` 任何状态下都回 `200` 并说 `enabled: false`，弹窗按这个开关出控件。

云端条目与随包条目在同一条下发路上：卡片套整场读 `/neo_pose/cloud_file` 再交 `scene/apply`；云端道具
取回落进 `models/props/` 后走页面既有的取件地址（`models/props/<file>.glb`），与随包道具同一条
`prop/add` —— 页面侧不为云端改一行。道具注册表那条伺服（`/models/props/index.json`）把云端清单点名的
道具补成注册表行：只读缓存里那份清单，一次网络都不发，行标 `hidden`（姿势页自己的面板没有「先取文件
再加具」那一步，不列没缓存的道具）。页面对 GLB 先归一成 1 单位高、再乘注册表行的 `scale`，握点照那一行
还原成米，注册表里没这一行的云端道具就是一把 1 米长的手枪。云端缩略图直读 OSS 的绝对地址（ossutil 的桶端点本就公开读），
卡片左上角标「云端」说清它不在本机库里。

云端那棵树由 `tools\pose_deploy_oss.py` 上传：读侧认的形状它产，清单里只留文件真在着的那批条目；
道具逐件读姿势仓库的授权行（`public/models/ATTRIBUTION.md`）—— 那一行给「可再分发」才发：CC0
（Poly Haven、BlenderKit `cc_zero`）与本项目自制给，BlenderKit Royalty Free 只写可商用、来源授权待确认、
Mixamo 仅个人使用都不给，注册表标签是「测试箱体」「单测箱体」的基准件也不发；发的每一件带着道具注册表
（`dist/models/props/index.json`）里的原行进索引。凭据从 `<数据根>/configs/backyard_oss.json` 读（bucket / endpoint /
access_key_id / access_key_secret 四项，键名与 `studio/backyard.py` 读的同一条）。优先级是命令行 >
`OSS_*` 环境变量 > 配置文件：shell 里残留的一条 `OSS_ENDPOINT` 会盖掉配置文件里的 endpoint，
连不上桶时就在命令行显式传 `--endpoint` 与 `--bucket`。默认不动云端，先跑一遍看清单，加 `--apply` 才上传：

`--source` 只指姿势仓库的随包预设库 `pose-lib/`（`npm run lib -- shipped` 那一棵）。数据根的
`<数据根>/pose/lib/` 是 `pose-lib` + `pose-lab` 的合并结果，条目带 `origin`：`pose-lab` 是作者自己
的实验姿态，不发布 —— 脚本见到带 `origin` 的索引整棵拒传，道具的授权行只挡道具、挡不住场景树。
云端上已经多出来的那批用 `tools\pose_prune_oss.py` 清：允许集直接复用上传脚本的清单，
索引没点名的键整批删掉。注册表行没写 `preview` 时，上传脚本按仓库的约定名 `preview/<GLB 同名>.png` 认
道具目录里真在着的那张 —— 图发上云就跟着条目一起进清单，`pose_prune_oss.py` 的允许集吃同一份清单，
下一轮清理不会把发出去的预览图摘掉；图没渲染过就不发这一行，面板出「无预览」而不是一条必坏的缩略图。

云端道具的预览图由 `tools\pose_prop_previews.py` 补：逐件从注册表行自己登记的来源页取那张官方渲染
（Poly Haven 用 `api.polyhaven.com/info/<slug>` 的 `thumbnail_url`，BlenderKit 用 `assetUrl` 那行里最大的
thumbnail，自制件取 `studio/pose_dist/models/props/preview/` 那张），落成 `preview/<id>.png` 并把
`preview` 写回索引行。这条只给已在索引里的件补图，不开第二条上云的门，`hidden` 行不发图；默认不动云端，
`--apply` 才传 `props/preview/*.png` 与索引，改前的那份索引存在 `<out>/index.before.json`。

```
python tools\pose_deploy_oss.py --source "<pose repo>\pose-lib"                      # 只列清单 + 生成索引
python tools\pose_deploy_oss.py --source "<pose repo>\pose-lib" --props stick.glb katana.glb --apply
python tools\pose_prune_oss.py  --source "<pose repo>\pose-lib" --apply              # 删索引没点名的键
python tools\pose_prop_previews.py                                                   # 出预览图 + 写回索引行
python tools\pose_prop_previews.py --apply                                           # 传预览图与索引
```

索引 URL 落点由脚本自己报出来，写进 `oss_presets.json` 的 `pose_index_url` 就接通读侧。

## 页面与静态前缀

| 方法   | 路由                               | 说明                                                       |
|--------|------------------------------------|------------------------------------------------------------|
| GET    | `/neo-pose`                        | 短路径：装了包 302 到入口页，没装回 404 与安装提示         |
| GET    | `/pose-dist/{path}`                | 姿势包的子资源（`index.html`、`assets/**`、GLB、wasm）     |
| GET    | `/pose-lib/{path}`                 | 姿势库的只读伺服（清单、场景文件与预览图）                 |
| GET    | `/models/{path}`                   | 产物按站点根部署写死的那条前缀：道具注册表、GLB 与预览图   |

产物是 `base: './'` 的相对 import，页面必须落在有目录深度的 URL 上，`./assets/x.js` 才会解析成
`/pose-dist/assets/x.js`；页面直接挂在根级 `/neo-pose` 时子资源全解析成 `/assets/*`，姿势页连自己的
模块都取不到，所以短路径只做跳转。前缀不进 `/neo` 命名空间（能力归属表只逐条登记 `/neo` 下的接口），
也不进 `/extensions`（桌面端那条中间件把整段按 `no-store` 下发，带哈希的 wasm 每次刷新都要重传）。
`assets/` 里文件名带内容哈希，长缓存 `immutable`；未哈希的入口与资源每次校验。前缀本身
（`/pose-dist/`，空路径）落到入口页：地址栏直接敲前缀也要进页面，与静态服务器的目录口径一致。
逐请求按两级落点找文件（数据根 → 随包副本），第一级缺的那份由第二级接住，两边都穿 `inside_dir` 的
路径包含检查，所以「跑在随包副本上」与「跑在数据根那份上」在 URL 上没有任何区别。

`.wasm` 的 MIME 由后端强制成 `application/wasm`：Windows 的 `mimetypes` 读注册表给出
`application/octet-stream` 时 `WebAssembly.instantiateStreaming` 直接拒收，Draco 解不出 GLB，姿势页
连人物都加载不出来。

产物里的 GLB 与注册表是 `public/` 原样拷进 `dist/models/` 的文件，页面按自己所在目录拼这些地址
（`src/core/appBase.js`）：站点根部署算出 `/`，宿主前缀部署算出 `/pose-dist/`。vite 的 `base: './'`
只改写构建期的模块引用，改写不到运行期字符串 —— 页面写死的 `/models/bodyMale.glb` 在前缀下会打到站点根，
素体整批 404、画面上只剩程序化骨架。装机产物因此必须整目录挂在 `/pose-dist/` 下，`models/` 不能只留
`assets/`。

宿主两条前缀都接住：`appBase.js` 认 URL 的第一段，是 `pose-dist` 就用相对前缀取 `/pose-dist/models/`，
不是就用站点根那条 `/models/`。道具注册表与 GLB 因此挂在同一条静态伺服的两个名字上，同一套两级落点与
根内校验。宿主只挂 `/pose-dist` 时，站点根那条 `/models/props/index.json` 落到 404，页面把注册表读成
空的，「添加道具」与 GLB 素体逐条报失败，而页面本身一切正常 —— 注册表读空不是用户的问题，是宿主少挂
一条前缀。

ComfyUI 自己占了 `/models`（模型类型清单）与单段的 `/models/<name>`（按模型类型列文件），单段那条在
插件宿主上归它，注册表与道具这种带目录的那条才归姿势伺服；页面在 `/pose-dist/` 下走前缀那条，两侧都
没有这个先后问题。

## 桥接口

| 方法 | 路由                         | 说明                                                                     |
|------|------------------------------|--------------------------------------------------------------------------|
| GET  | `/neo_pose/status`           | 装没装、生效的那一级、随包清单、在着的 GLB、能力位、场景存档、桥消息名单 |
| GET  | `/neo_pose/scenes`           | 场景列表（`name` / `size` / `mtime`，按修改时间倒序）                    |
| GET  | `/neo_pose/scene?name=`      | 读一份场景                                                               |
| POST | `/neo_pose/scene`            | 写场景（`{name, scene}`，`.tmp` + replace 原子落盘）                     |
| POST | `/neo_pose/export_image`     | 页面画布导出（`{data: dataURL, name}`）落进素材库                        |
| POST | `/neo_pose/export_set`       | ControlNet 图组（`{files: [{name, data}]}`，≤12 张）落素材库             |
| GET  | `/neo_pose/cloud_status`     | 云端配没配、云端索引地址、缓存目录与缓存在不在                           |
| GET  | `/neo_pose/cloud_index`      | 上次取回的云端清单（只读缓存，不在请求里拉 OSS）                         |
| GET  | `/neo_pose/cloud_file?path=` | 取一份云端文件（整场 JSON、预览图、云端道具 GLB）                        |

`/neo_pose/status` 报的落点与随包信息：`installed`（两级里有没有入口页）、`dist_dir` 与
`dist_source`（生效那一级 = `data_root` / `package`）、`package_installed` 与 `package_dir`、
`models_present`（两级里在着的 GLB 文件名）、`manifest_version` / `manifest_built` /
`manifest_files` / `manifest_bytes`（随包 `MANIFEST.json` 的内容，缺清单时为空与 0）。

素体没有导入接口：面板只发 `meta/list` 报到的 `bodyMale` / `bodyFemale` 两档，标签用页面那份，
白名单外的基座不出选项（一条点了只会失败的控件不发货）。自备 GLB 归姿势页自己那侧的本地导入区，
宿主既没有那条入口也没有对应的接口 —— `/neo_pose/import_model` 随控件一起删掉了。

页面名与场景名都要过白名单：首个字符是字母数字、总长 ≤ 64、只允许 `A-Za-z0-9_.-`；子资源路径逐条解析符号链接并强制落在两级落点之一内，带 `..`、盘符、绝对路径
的 URL 一律 `400`。导出的
图落进 `output/Pose`（素材库 Output 卡里的一个子目录），单张去重后回
`{filename, subfolder, size}`，`subfolder` 就是 `Pose`；图组整批逐张校验通过才落盘、回 `{saved, count}`，任何一张不合法就整批不写。
导出项与 ComfyUI 自己的输出项同址同口径：缩略图、大图、拖放进节点与「⋯ → 删除」都按相对
subfolder `Pose` 寻址，面板的导出提示点名 Pose 目录。

场景写进 `<数据根>/pose/scenes/<名字>.json`，用户导入的素体 GLB 落进 `<数据根>/pose/dist/models/`，两处都不在
`tools\sync_pose_dist.ps1` 与 `tools\build_pose_package.ps1` 的镜像结果里（同步脚本把「源里没有的文件」
先存后还），重装姿势包不动它们。

这七条接口只做文件读写，桌面端离线服务全部自己答（`app/studio_caps.py` 的 `_POSE`）；`/pose-dist`
与 `/pose-lib` 是两端各自直接注册的静态前缀，不进能力表。

## 宿主视图与消息方向

桌面端顶栏「姿势」页签与首页卡片「3D 姿势」进 `#/pose`；宿主模块是 `studio/web/pose/pose.js`。
宿主面板分四组：素体（换当前素体、加素体、删当前素体、重置姿态）、外观、道具（一张卡一件）、
ControlNet 导出（勾格式、导出图组、画布截图）、画布状态（只读一行）；左栏自上而下是搜索框、
一列本机保存的姿势存档（预设不在这一列里，走「浏览姿势库…」弹窗）、写名保存与「浏览姿势库…」/「载入姿势」
两颗钮。道具一栏是一件件带预览图的卡片（口径见「道具卡片」）。
面板控件在 `pose:ready` 之前全部禁用，
面板随 `pose:ready` 出现；桥随 `pose:dispose` 拆掉，离开页面时不留监听器。姿势页被嵌进 iframe 时，
入口页 `<head>` 的内联脚本在首帧之前就落 `data-host-ui`（判据同 `src/neoBridge.js` 的
`parent !== window`）—— 打开姿势页不会先画出整套 3d-pose-art 单机 demo 控件再折成宿主版；
`caps.hostUi` 不是 `true` 的旧宿主仍回落成 demo 全量控件。

左栏那一列只列本机保存的姿势存档（`pose/scenes/`，行末标「本地」）：预设姿势都在「浏览姿势库…」弹窗里，
这一列不把它们再排一遍 —— 库里有的东西不在这里重复一份。点一行就是装载那一场（读 `/neo_pose/scene`
再下发 `pose:open-scene`），`载入姿势` 按钮留着给手写的名字，两条走同一条装载路。这一列吃栏里剩下的高度，
搜索框是栏里排在列表上面的那一行（只带 `.ns-pose-list-search` 那一条固定行的样式；弹窗搜索框的
`flex: 1` 与 `min-width` 收在 `.ns-pose-libpane` 那一条里，只作用在弹窗那一横行，这一栏共用它就会把
输入框纵向拉成整块），按名字过滤这一列；
一屏 120 行，剩下的走「加载更多（还有 N 条）」—— 存档攒多了全塞进 DOM，首屏与滚动
都撑不住。右栏没有预设下拉，面板上也没有「套用预设」这一步：预设的入口只有「浏览姿势库…」弹窗那一个。

「浏览姿势库…」开一扇弹窗（素材库的那套外壳），里面就是 `pose-lib` 的整场库。卡片按
`clay → skeleton → silhouette → depth` 挑预览图（口径同姿势页 `src/ui/libraryPanel.js` 的 `thumbOf`），
四档都没有的卡片显示「无预览」，副标题报「N人 · M道具」。预览图是姿势仓库清场后套用自己的场景文件拍的那一张
（一个 rig 一个素体、物体清空，角色与道具子树之外的可见对象整批关掉），卡片角上标「参考图」说明它是渲染图不是照片：
图上的人数就是场景文件里的人数，套用后报的也是页面真正套上的数量。旧库里对着画布拍的预览重画一次就是新样子 ——
在姿势仓库里 `npm run build` 后 `npm run lib -- preview --all`，再跑一次同步。分组下拉按所选来源过滤后的合并条目数出来并带条数
（清单 `groups` 自带那份 `count` 是预设集自己算的，本机 `pose-lab` 新写的姿态不在里面），重建选项后落回原选择、来源一换原分组
不存在就回到「全部分组」；来源下拉是「全部来源 / 预设（只读）/ 本地（可写）」，卡片左上角标「预设」或「本地」（悬停说清是哪根库），
条数行写「N 个姿势（预设 X · 本地 Y）· 显示 Z」—— 清单没有 `origin` 字段的旧条目记作本地；搜索按 `label / 分类 / 标签 / id / source` 过滤（口径同姿势仓库 `poseLibrary.js`
的 `filterIndex`）。一场可以挂多个组，卡片只落在排最前的那个组里 —— 弹窗里出现两张同 id 的卡，点击会串。
卡片每 200 条一屏（库里 640+ 条全塞进 DOM，首屏与滚动都撑不住），剩下的走「加载更多（还有 N 条）」。
点卡片读它自己那份文件并下发一次 `scene/apply`，报「N 副骨架 · M 物体」，套成就收起弹窗 —— 整场那一路
就是左栏「载入姿势」与页面「读场景」的实现：按人数补素体、按画面左右排开、物体按 id 覆盖。弹窗里的搜索、
组下拉、来源下拉与「加载更多」在左栏同一把门禁里（`libGate`）：`pose:ready` 之前不可点，套完一条后整片锁住到结果
回来 —— 连点两条会下发两次套发，后一条无声盖掉前一条。库没同步时弹窗显示同步命令与一句提示，不是一片
空列表：一个空浏览器不是库的样子。弹窗里另有一个「本机姿势文件…」入口，从本机挑一份 JSON 交
`pose:open-scene` —— 不在库里的文件一样装得进。

弹窗顶部第一条是「来源：本机库 / 云端库」，与库内那份「全部来源 / 预设（只读）/ 本地（可写）」的
条目来源是两个维度：本机库读 `<数据根>/pose/lib`，云端库读 OSS 那棵树。云端那一档只在
`/neo_pose/cloud_status` 报 `enabled: true` 时出现在选项里 —— 没配置的来源列进下拉就是给用户一条
点了只会失败的控件。切到云端库时标题行提示「云端库：OSS 上那棵树，取回的文件缓存在本机」，卡片左上角
标「云端」（悬停说清它在云端那棵树里），条数行写「N 个云端姿势 · 显示 Z」，分组与搜索两条下拉按云端
条目重建、口径与本机库同一条。云端卡片缩略图直读 OSS 的绝对地址（桶端点公开读），本机库的预览图走
`/pose-lib/preview/` 那条伺服。「刷新缩略图」在云端档逐张取回预览图落缓存（每张一份，250 张是 60MB+，
绝不全量拉）。点云端卡片读 `/neo_pose/cloud_file?path=<云端相对路径>` 再下发同一次 `scene/apply`，
本机姿势文件那条装载路与门禁都不变。云端没配置时弹窗显示部署指引（`oss_presets.json` 的
`pose_index_url` + `tools\pose_deploy_oss.py`），缓存里没有云端清单时同样出这句指引并 toast 报
`/neo_pose/cloud_index` 的错，不出假卡片。

云端道具进的是「添加道具」那条注册表路：道具卡片在云端配置开着时合并一份云端道具卡（角标「云端」，与程序化
道具的「程序化」/ 随包道具的「随包姿势包」同一条角标口径），key 走
`glb:<裸文件名>`；选中它时面板先取 `/neo_pose/cloud_file?path=models/props/<file>.glb` 落进
`models/props/`，再交页面既有的 `prop/add` 取件地址 `models/props/<file>.glb` —— 页面侧不为云端改一行，
道具取件只有那一条路。云端那批的中文标签、注册表 `scale`、握点与预览图路径来自云端索引里那份注册表原行（授权与来源页
随条目一起上云，CC0 的署名口径读得出）：伺服 `/models/props/index.json` 时它们作为 `hidden` 行补进页面读的
那份注册表，页面加具时按那一行把道具摆成姿势仓库里量出来的尺寸 —— 一把制式手枪 0.28 米、一根齐眉棍 2 米。
云端卡片上的预览图直读 OSS 绝对地址，取件那条路不变（面板不许把 OSS 地址塞给页面，页面的取件地址只能站内相对）。

## 道具卡片与场上落点

道具一栏是一张张带预览图的卡片，一件一张，条目来自 `meta/list` 的道具项：随包 GLB 与程序化道具在前，云端
道具带「云端」角标排在后。预览图两条地址：注册表行的 `preview` 是道具目录里的相对路径，本机读
`/models/props/preview/<name>.png`，云端直读 `<OSS 基址>/props/preview/<name>.png`；内置程序化道具没有注册表行，
按仓库的约定名 `preview/builtin-<id>.png` 取。两处都没有图就在卡片里写「无预览」—— 挂一张必坏的 `<img>`
不是没图的样子；云端那一行的 `preview` 不在这里生成，由 `tools\pose_prop_previews.py` 把来源页的官方渲染
写进索引行（口径见「云端姿势库（pose-cloud）」那节）。搜索框按 `label / key` 过滤卡片，计数行写「N 件道具 · 选中 X」，
过滤后选中项不在结果里就落到结果的第一张。

「添加道具」吃的就是选中那张卡的 key；自由填写的道具名走同一条「名字 → 清单里那一项」查找（内置 `builtin:chair`、
注册表 `glb:arrow.glb`）。面板不发 `prop/attach`：挂点骨与「挂到骨点」在姿势页自己那侧的面板上，宿主不复制一份，
页面命令表里的 `prop/attach` 照旧在。「落地」与「删道具」吃场上列表里选中的那件自由道具，场上每一行把自己的落点
报清：挂在骨上的写「挂在 手部_右」，自由道具写 X/Z 坐标。

面板不设姿势模式 / 吸附 / 轮廓线 / 主体层四个勾选：姿势靠直接点人物（页面在点中人物时自己进姿势模式，
点空白退出），吸附与轮廓线在页面侧默认就是关，人物常显，「画布状态」因此只镜像素体、素体数与道具数三行。
导出图组不受这条影响：线稿那一路导出自己临时开轮廓壳再关回去。外观两档来自页面（摄影棚灰 / 暗色），
页面开局是摄影棚灰，面板在 `meta/list` 到位后把外观定在暗色档并下发 `look/set`；清单里没有暗色档的旧姿势包
不发这条动作。随包姿势包的暗色档带看得见的地板网格：暗档网格线是 `0x6d7786` 全不透明 —— 桌面窗口跑在
`devicePixelRatio`=1，1px 网格线被抗锯齿摊成约半覆盖率，颜色自己扛住对比度，网页与窗口读出同一片地板。

ControlNet 导出的视角默认落在「当前视角」：页面 `EXPORT_VIEWS.current` 是 `null`，出图口径就是沿用现场
相机，面板不动用户调好的机位就能出图。`meta/list` 的 `views` 里没有这一档的旧姿势包，下拉停在「视角」上，
由页面自己落它那份默认，面板不写一个下拉里没有的值。

素体面板不发导入：随包只发授权干净的 CC0 两具基座，Mixamo / SMPL 派生与用户自备的 GLB 由页面自己的本地
导入区登记，宿主这边既没有入口也没有接口。桌面端服务的请求体上限仍抬在
48MB 之上（aiohttp 默认只收 1MB，ControlNet 图组一次 12 张 PNG 走 base64 就会先被 transport 挡成 413），插件端那条
本来就走在 ComfyUI 自己的 100MB 上限里，两边体积口径一致。

页面自身的六行工具条是 `fixed` 盖在画布上的，矮窗口里它会挡住姿势要的画布：左下角「面板：展开」钮与
`T` 键收起它，只留第一行（行高现量，窄屏换行时第一行内容随宽度变），状态写进页面 localStorage，与宿主
工具条无关。

宿主两侧栏（左姿势库 / 右控制面板）的栏首各有一枚收起钮，钮面是一只两栏框图标 —— 本栏那一格填实，
收起后那一格缩成一条，左栏的格在左、右栏镜像在右。收起后那一栏只剩一条 34px 的竖栏 —— 栏名竖排，
钮就是展开入口，让出来的栏宽整块给画布，两侧都收起时画布吃满整幅。手机上两栏各收成一条 34px 横条
（横条占整幅宽度），腾出来的高度整块给画布，画布始终占整幅宽，两侧都收起时画布吃满整屏。收起是布局偏好，写进 localStorage 的
`neo_studio_pose_sides`，切走再回来与重开窗口都停在上次的位置；它不吃 `pose:ready` 与 `caps.hostUi`
门禁 —— 缺包与旧姿势包把控件整片关掉时，两栏照样收得回去。

| 消息                | 方向        | 载荷                                     | 说明                                        |
|---------------------|-------------|------------------------------------------|---------------------------------------------|
| `pose:ready`        | 页面 → 宿主 | 无                                       | 页面装配完，宿主立刻回一份 `pose:theme`     |
| `pose:theme`        | 宿主 → 页面 | `{caps, lang}`                           | 能力位与语言，页面据此置灰不可用的控件      |
| `pose:export-image` | 宿主 → 页面 | 回复端口 `{data, name}`                  | 请求导出画布，页面从回复端口交回 dataURL    |
| `pose:save-scene`   | 宿主 → 页面 | 回复端口 `{name, scene}`                 | 请求序列化场景，页面从回复端口交回场景 JSON |
| `pose:open-scene`   | 宿主 → 页面 | `{scene}`                                | 把已存场景装回页面                          |
| `pose:call`         | 宿主 → 页面 | `{action, args}` + 回复端口 `{ok, data}` | 面板动作走页面自己的命令，见下节命令表      |
| `pose:state`        | 页面 → 宿主 | `{state}`                                | 画布状态快照，只进「画布状态」一行          |

请求类消息带 `MessageChannel` 回复端口，一次请求的回复只落在这条端口上；入站通知只认本页这张 iframe
（`event.source`）与同源 `origin`，名单外的消息名一律丢弃。iframe 的 sandbox 是
`allow-scripts allow-same-origin allow-downloads`，不给 `allow-popups` / `allow-forms` /
`allow-top-navigation`。

页面侧的桥在姿势仓库的 `src/neoBridge.js`：只在页面真被装进同源 iframe 时存在，单机部署
（`npm run dev`、静态站）一个监听器都不挂。桥不新造能力，只复用页面已有的通路 —— 整场序列化
（存场景）、干净截图（关节球 / gizmo / 参考图层整层隐藏后才读画布，与「下载截图」按钮同一条），
以及页面自己的命令（套姿态、ControlNet 出图、画布快照），面板上的动作走
`pose:call` 那一行。序列化失败时页面不回包，让宿主超时后报「姿势页未响应」，绝不让宿主把一份
错误对象当场景写进它的场景目录。口径与失败路径见姿势仓库的 `docs/neo-studio-bridge.md`。

道具那一栏给的是「下拉 + 名字框」两件事：下拉显示道具的中文名，发给页面的 value 必须是页面认的 propKey
（内置 `builtin:chair`、注册表 `glb:<file>`）；名字框允许直接写名字，宿主在 `meta/list` 下发的道具清单里把它
解析成 propKey —— 中文名（椅子 / 凳子 / 桌子 / 木箱 / 木桶 / 大球 / 小球 / 圆柱 / 斜坡 / 单杠 / 台座 / 垫子 /
剑 / 短剑 / 长矛 / 弓 / 盾，以及注册表里的 label）、裸 id（`chair`、`arrow.glb`、`arrow`）与全 key 三种写法
同一条落点，label 的全角括号后缀（细剑（Sting））按括号前的名字认。名字不在这份清单里时面板直接说「道具表里
没有『X』」并报出可输入的名字与项数，不发 `pose:call`：道具定义只有那一份，在姿势包里，宿主不猜定义。

## 桌面端不可用的能力

`/neo_pose/status` 的能力位里 `photo3d`、`mesh`、`pano`、`lib_write` 恒为 `false`：照片估点、网格生成、
pano 与库写入要 3d-pose-art 那套 Python sidecar（`pose_server.py`），桌面端进程不拉起它。页面按这几位置灰
对应控件，宿主不给它们出接口。这几条面板本来靠自己的服务探针（`/__pose3d/ping`、`/__pose-lib/ping`）降级
—— 它们只在 vite dev/preview 挂载，静态伺服的宿主上探针必然失败，面板按既有的「应答方不是估点服务」口径
自己关；`caps` 是宿主下发的同一份口径确认，不是第二处开关。`lib_write` 关的只是写库：读库不需要 sidecar，
清单与文件由宿主自己伺服（`/pose-lib`），弹窗照旧列库、照旧套姿态。

`body_import` 为 `true`，它是姿势页自己那侧的能力：随包只发授权干净的 CC0 素体（标准男 / 标准女），
Mixamo 与 SMPL 派生的那几份由用户在页面自己的本地导入区按 key 登记，写文件与登记都不需要 sidecar。
宿主面板只发 `meta/list` 报到的这两具基座，白名单外的基座不出选项，也就没有一条点了只会失败的档位；
页面内置注册表引用了六个 GLB 素体，跑在随包副本上时其余几项在页面侧取不到文件，那是姿势页的事，
面板的素体下拉里根本不会出现它们。

`hostUi` 恒为 `true`：宿主带着自己的面板（姿势库、ControlNet 导出、画布状态），
随 `pose:theme` 交下去，姿势页据此收起面向独立部署的那套 demo 工具条 —— 场上同一时刻只留一套控件。
页面对旧姿势包（没有宿主命令层）的兜底在宿主这边：`caps.hostUi` 不为 `true` 时面板整片禁用并说明要
重装姿势包，不给用户留一条点了只会空转的按钮。

## 未安装的形态

两级落点里都没有 `index.html` 时（数据根没同步、`studio/pose_dist` 被删）：`/neo-pose` 回 404 与一句
安装提示，`/neo_pose/status` 报 `installed: false` 与 `dist_source: ""`，宿主页面显示「3D 姿势未安装」
加两条装包路子（`tools\sync_pose_dist.ps1` 同步全量产物、随包的 `studio/pose_dist`）与一个「重新检查」钮，
不出 iframe、不出工具条。

页面开得来、模型一栏正常、只有「添加道具」逐条报失败时不是未安装：那条注册表请求
（`/models/props/index.json`）在宿主上落成 404，页面把注册表读成空的。浏览器 Network 面板按这条路径看
状态码，`/neo_pose/status` 的 `dist_source` 告诉你生效的是哪一级；随包副本本来就不带道具（授权口径），
要道具就 `tools\sync_pose_dist.ps1` 同步全量产物。

库没同步是另一件事，姿势页本身照常用：`/pose-lib` 整条前缀回 `404`，`/neo_pose/status` 报
`lib_installed: false` 与 `lib_entries: 0`，「浏览姿势库…」弹窗显示那句同步命令与一句提示，
而不是一个空列表 —— 库里缺一份文件与库没同步是同一个 `404`，弹窗判据是那份清单读不读得到。
两句指引都给出第二条路：「启动设置 → 姿势仓库」填上仓库根，桌面端每次启动自动把两级都补进数据根。

## 测试

- `app/tests/test_studio_pose.py`：姿势资产自动同步的仓库解析（配置 → 环境变量 → ComfyUI 根同级）、
  只在新于数据根时动手（重复启动零复制）、dist 镜像的补回与 `models/` 里额外 GLB 的先存后还、pose-lib 合并的同 id 本地胜出、
  预览默认档与 `*depth.png` 残留清理、旧版清单（没有 `charKey`）触发一次索引重建、源缺级整级跳过。
- `studio/tests/test_pose_bridge.py`：路径包含与场景名白名单、wasm MIME、哈希/未哈希缓存、场景
  原子写、场景往返、单张导出与 ControlNet 图组落素材库、整批拒绝
  且不留半个文件、短路径 302；两级落点（随包副本兜底、数据根压同名文件、两级都缺的提示）、道具注册表
  那条根前缀在两级都取得到、随包清单进 status；素体面板的白名单（`/neo_pose/import_model` 不再注册，
  `routes` 里没有它）；姿势库的清单与场景文件与预览图伺服、目录落到
  `index.json`、出根 `400`、未同步 `404`、整条前缀 `no-cache`、清单坏 JSON 不炸 status、status 的
  `lib_dir` / `lib_installed` / `lib_entries` / `lib_bytes` 四项；云端读接口的未配置说成不可用（不拉
  OSS）、缓存里没有清单时不拉 OSS（只读缓存）、云端相对路径落进缓存树、道具写成
  `props/<file>.glb` 与 `models/props/<file>.glb` 同一条落点、缓存未命中取回落盘后二次命中不再请求、
  前导 `/` 与 `..` 出根一律 `400`（云端未配置时同样先过路径检查）、上游取回失败 `502` 且不落缓存、
  道具 GLB 文件头不是 `glTF` 时不落缓存并 `502`、`/neo_pose/cloud_status` 报的 `enabled` /
  `available` / 场景数 / 道具数 / 缓存目录；道具注册表那条伺服的合并（云端行带 `scale` 与握点与 `preview` 进来并标
  `hidden`、本机注册表点名的道具不补第二条、那条路上一次网络都不发、旧版上传脚本的条目照样落成一行）、
  云端道具预览图落进页面读的那条本机道具目录（`props/preview/x.png` 写成 `models/props/preview/x.png` 也接住）。
- `studio/tests/test_pose_deploy.py`：云端上传脚本的清单构建 —— 云端清单只收文件真在着的条目、预览档位
  同样验文件在着、条目字段与卡片同名；道具只在授权行给「可再分发」时发，发的那条带着注册表原行（`scale`、
  握点、体积、授权与来源页），Royalty Free、来源待确认、Mixamo 仅个人使用、注册表没有授权行的与仓库自己的
  基准件全部拒发，授权干净但 GLB 不在的不登记，`--props` 只在授权干净的那批里再挑、越不过授权门禁，
  读不到注册表时整批不发，上传清单里道具落 `props/` 前缀、道具预览图随道具一起落 `props/preview/`、注册表行写了
  `preview` 而图不在时说明并跳过、索引登记过的道具文件不在时不进上传清单。
- `app/tests/test_studio_server.py::PoseBridgeTests`：离线服务里的页面跳转、子资源伺服与越界拒绝、
  `/models` 前缀答出注册表与道具 GLB（含随包 CC0 素体与数据根压随包那份）、场景往返、能力位与
  归属（逐条核对姿势模块注册的那张路由表）、随包副本兜底那一层、`/neo_pose/import_model` 随控件删掉后
  在归属表里落回内核那一级且独立窗口回 `409`、数据根不写出素体；`/pose-lib` 前缀在离线服务里答出清单与场景文件、status 的 `lib_*` 四项、
  `/pose-lib` 不进能力归属表；云端三条接口在离线服务里答得了（未配置说不可用、`../..` 与前导 `/` 与盘符
  一律 `400`），且在归属检查里逐条归桌面端自服。
- `studio/tests/js/pose-bridge.test.mjs`：宿主视图的缺包形态、iframe 属性、桥的来源与同源校验、
  `hostUi` 门、导出 / 场景 / 图组三条路径落到的接口；素体面板的白名单（只发 `bodyMale` / `bodyFemale`、
  标签取 `meta/list`、白名单外不出选项、没有「导入自备素体」那一行也不打那条接口）、旧姿势包没有标准基座时
  下拉停在「选择素体…」且「加素体」交回空参数、默认素体落在 `bodyMale` 时「加素体」与基座筛选跟着这一档；
  左栏那一列本机姿势存档（只列 `pose/scenes/` 的存档、行末带「本地」角标、点一行与「载入姿势」共用
  同一次 `pose:open-scene`；预设不进这一列，套用只有「浏览姿势库…」弹窗那一条路，右栏没有预设下拉；
  搜索按名字过滤、搜不到说清、一屏 120 行走「加载更多」，搜索框是栏里与列表并排的固定一行
  （弹窗搜索框那条 `flex: 1` 收在 `.ns-pose-libpane` 里，只作用在弹窗那一横行，左栏不共用它，
  不被列表的 grow 规则拉高）；
  ControlNet 导出的视角默认「当前视角」；姿势库弹窗的清单渲染与分组 / 搜索 / 来源筛选 / 加载更多、点卡片套整场
  落到的动作与弹窗收起、库没同步的指引、门禁锁住弹窗那一片、本机姿势文件那条装载路；
  左右栏收起（收起钮不吃门禁、收起后栏首留作展开入口、钮面图标随收起状态变宽窄、偏好落盘并在重建视图时回灌）；
  道具卡片（一张卡一个 `propKey` 与一张预览图、点卡片选中、「添加道具」发的就是那一项）、道具面板没有挂骨点
  （没有「挂到骨点」按钮、没有骨点下拉、加具不发 `prop/attach`）、自由填写的道具名解析成 `propKey`（全 key /
  裸 id / 中文名三种写法同一个，清单里没有的名字不发请求）、云端道具卡片接在本机那批后面带「云端」角标与直连预览、
  添加时先把 GLB 落进本机缓存。
- `tools\test_pose_package.ps1`：随包姿势包的自检 —— 必需文件、产物形状、不该发货的形态（`*.map`、
  白名单外的 GLB、白名单外的道具 GLB、白名单外的道具预览图、散 JSON）、逐文件 sha256 与体积核对、道具注册表只列
  随包那两条、注册表写了 `preview` 的行必须发货那张图、开发机绝对路径、
  体积上限。
- 姿势仓库侧的页面桥：`tests/neoBridge.node.test.mjs`（桥的存在判定、来源与 origin、回复端口回包、
  失败怎么出声）。
- 姿势仓库侧的部署根：`tests/appBase.node.test.mjs`（站点根逐字不变、前缀部署折进前缀），页面套件
  `tests/unit.mjs` 里锁「默认素体 GLB 按部署根取到」与「收起工具条只留第一行」。

姿势包自身的实现与页面文案在 3d-pose-art 仓库（MIT），本仓库只伺服它的产物并给桥接口，不 fork 其源码。
