# 3D 摆姿

「3D 摆姿」页把 3d-pose-art 的浏览器摆姿装进 Neo Studio：页面在 iframe 里跑 three.js，宿主只负责
伺服产物、承载页面与桥接口。摆姿、时间轴、导出全在浏览器里完成，本机服务只提供文件读写。

## 摆姿包

产物有两级落点，逐请求按这个顺序找，**数据根那份压住随包那份的同名文件**（新构建与自备素体因此优先）：

| 落点 | 内容 | 怎么来 |
|------|------|--------|
| `<数据根>/pose/dist/` | 全量产物，含 `*.map`，约 16MB | `tools\sync_pose_dist.ps1` |
| `studio/pose_dist/` | 最小授权副本，代码 + CC0 素体，3.9MB | `tools\build_pose_package.ps1`，随 Registry 包与 exe 分发 |

随包那份按**授权口径**取舍，不按体积：`models/ATTRIBUTION.md` 里只有 `ybot.glb`（CC0，PixelMannen 的
Y Bot）写明可自由再分发，所以它是唯一随包的 GLB；Mixamo（`soldier` / `ch38` / `ch07`）与 SMPL 派生
（`body1391` 与三份缩略图）各自条款仅限个人使用，道具 GLB 来源待确认，全都不入库。道具注册表
`models/props/index.json` 清空 `props` 数组 —— 注册表里列一个包里没发的 GLB，等于发一条点了只会失败的
控件，清表与清文件是同一件事，程序化道具照旧可用。`*.map` 不进包：产物只有一条 `sourceMappingURL`，
浏览器只在 devtools 打开时取它，发出去只让每个用户多下载 4.4MB。包里另带 `LICENSE`、
`THIRD-PARTY.md`（terser 删掉的上游许可横幅补在这里）与 `MANIFEST.json`（逐文件 `bytes` + `sha256`）。
产物里烘进的开发机绝对路径（素体注册表的 `sourceImage`）在打包时清掉，随包发不出去。

```
pwsh tools\build_pose_package.ps1                                      # 取 <数据根>/pose/dist 的现成产物
pwsh tools\build_pose_package.ps1 -Source <3d-pose-art 仓库根> -Build  # 先 npm run build 再打包
pwsh tools\test_pose_package.ps1                                       # 复查包：清单哈希、体积上限、不该发货的形态
pwsh tools\sync_pose_dist.ps1 -Source <3d-pose-art 仓库根>            # 全量产物同步进数据根（优先那一级）
```

`robocopy /MIR` 只镜像 `dist/`：`<数据根>/pose/scenes/` 与 `pose/refs/` 里用户写的场景与素材不在镜像
范围内；用户经面板「导入自备素体」写进 `pose/dist/models/` 的 GLB 也不在源产物里，同步脚本先把这些
「源里没有的文件」存进临时目录、镜像完原样搬回，一次重装摆姿包不会无声清掉用户导入的素体。源仓库根的
`LICENSE` / `NOTICE` 一并落进产物目录（摆姿包是 MIT 作品，装机副本必须带着它的许可证与致谢）。
装完刷新页面就生效：装没装是逐请求判断的，不必重启窗口。

## 页面与静态前缀

| 方法 | 路由                             | 说明                                                     |
|------|----------------------------------|----------------------------------------------------------|
| GET  | `/neo-pose`                      | 短路径：装了包 302 到入口页，没装回 404 与安装提示        |
| GET  | `/pose-dist/{path}`              | 摆姿包的子资源（`index.html`、`assets/**`、GLB、wasm）    |
| GET  | `/models/{path}`                 | 产物按站点根部署时写死的那条前缀：道具注册表与 GLB        |

产物是 `base: './'` 的相对 import，页面必须落在有目录深度的 URL 上，`./assets/x.js` 才会解析成
`/pose-dist/assets/x.js`；页面直接挂在根级 `/neo-pose` 时子资源全解析成 `/assets/*`，摆姿页连自己的
模块都取不到，所以短路径只做跳转。前缀不进 `/neo` 命名空间（能力归属表只逐条登记 `/neo` 下的接口），
也不进 `/extensions`（桌面端那条中间件把整段按 `no-store` 下发，带哈希的 wasm 每次刷新都要重传）。
`assets/` 里文件名带内容哈希，长缓存 `immutable`；未哈希的入口与资源每次校验。前缀本身
（`/pose-dist/`，空路径）落到入口页：地址栏直接敲前缀也要进页面，与静态服务器的目录口径一致。
逐请求按两级落点找文件（数据根 → 随包副本），第一级缺的那份由第二级接住，两边都穿 `inside_dir` 的
路径包含检查，所以「跑在随包副本上」与「跑在数据根那份上」在 URL 上没有任何区别。

`.wasm` 的 MIME 由后端强制成 `application/wasm`：Windows 的 `mimetypes` 读注册表给出
`application/octet-stream` 时 `WebAssembly.instantiateStreaming` 直接拒收，Draco 解不出 GLB，摆姿页
连人物都加载不出来。

产物里的 GLB 与注册表是 `public/` 原样拷进 `dist/models/` 的文件，页面按自己所在目录拼这些地址
（`src/core/appBase.js`）：站点根部署算出 `/`，宿主前缀部署算出 `/pose-dist/`。vite 的 `base: './'`
只改写构建期的模块引用，改写不到运行期字符串 —— 页面写死的 `/models/ybot.glb` 在前缀下会打到站点根，
素体整批 404、画面上只剩程序化骨架。装机产物因此必须整目录挂在 `/pose-dist/` 下，`models/` 不能只留
`assets/`。

宿主两条前缀都接住：`appBase.js` 认 URL 的第一段，是 `pose-dist` 就用相对前缀取 `/pose-dist/models/`，
不是就用站点根那条 `/models/`。道具注册表与 GLB 因此挂在同一条静态伺服的两个名字上，同一套两级落点与
根内校验。宿主只挂 `/pose-dist` 时，站点根那条 `/models/props/index.json` 落到 404，页面把注册表读成
空的，「添加道具」与 GLB 素体逐条报失败，而页面本身一切正常 —— 注册表读空不是用户的问题，是宿主少挂
一条前缀。

ComfyUI 自己占了 `/models`（模型类型清单）与单段的 `/models/<name>`（按模型类型列文件），单段那条在
插件宿主上归它，注册表与道具这种带目录的那条才归摆姿伺服；页面在 `/pose-dist/` 下走前缀那条，两侧都
没有这个先后问题。

## 桥接口

| 方法     | 路由                          | 说明                                                            |
|----------|-------------------------------|-----------------------------------------------------------------|
| GET      | `/neo_pose/status`            | 装没装、生效的那一级、随包清单、在着的 GLB、能力位、场景与姿态、桥消息名单 |
| GET      | `/neo_pose/scenes`            | 场景列表（`name` / `size` / `mtime`，按修改时间倒序）           |
| GET      | `/neo_pose/scene?name=`       | 读一份场景                                                      |
| POST     | `/neo_pose/scene`             | 写场景（`{name, scene}`，`.tmp` + replace 原子落盘）            |
| GET      | `/neo_pose/presets`           | 姿势库列表（`name` / `size` / `mtime`，按修改时间倒序）         |
| GET      | `/neo_pose/preset?name=`      | 读一份姿态（PoseFile v1 原样交回，宿主不改一个字段）            |
| POST     | `/neo_pose/preset`            | 写姿态（`{name, pose}`，`.tmp` + replace 原子落盘）             |
| POST     | `/neo_pose/preset/delete`     | 删一份姿态（单条，名字过同一套白名单）                          |
| POST     | `/neo_pose/import_image`      | 取一张素材进页面（`{filename, subfolder, type}`）               |
| POST     | `/neo_pose/import_model`      | 自备素体 GLB 写进 `pose/dist/models/<key>.glb`                  |
| GET      | `/neo_pose/refs/{name}`       | 伺服交进页面的那张参考图（页面与宿主同源，直接取）              |
| POST     | `/neo_pose/export_image`      | 页面画布导出（`{data: dataURL, name}`）落进素材库               |
| POST     | `/neo_pose/export_set`        | ControlNet 图组（`{files: [{name, data}]}`，≤12 张）落素材库    |

`/neo_pose/status` 报的落点与随包信息：`installed`（两级里有没有入口页）、`dist_dir` 与
`dist_source`（生效那一级 = `data_root` / `package`）、`package_installed` 与 `package_dir`、
`models_present`（两级里在着的 GLB 文件名）、`manifest_version` / `manifest_built` /
`manifest_files` / `manifest_bytes`（随包 `MANIFEST.json` 的内容，缺清单时为空与 0）。

`/neo_pose/import_model` 收 `{key, data}`（base64 一份 GLB）或 `{key, filename, subfolder, type}`
（素材库里的一个文件，复用 Gallery 的解析器）。四道校验全在写盘之前：`key` 过场景名那套白名单、来源
二选一、字节数 ≤ 35MB（base64 进 JSON 后仍装得进 48MB 请求体上限的那一档）、文件头必须是 `glTF`，落点只有 `<数据根>/pose/dist/models/<key>.glb`
（`.tmp` + replace 原子写，同名导入就是换掉那份模型，不出第二个 key），回 `{key, name, url, size, from}`。
面板上的「导入自备素体」走本机文件选择器 —— 素材库列表只列图片，用户从 Mixamo 下来的那份 GLB 从文件
选择器进；登记动作在页面侧（摆姿页自己的本地导入区按 key 认它），宿主只把 key 报给用户。

页面名与场景名都要过白名单：首个字符是字母数字、总长 ≤ 64、只允许 `A-Za-z0-9_.-`；素体 key 过同一套
（文件名就是 `<key>.glb`）；子资源路径逐条解析符号链接并强制落在两级落点之一内，带 `..`、盘符、绝对路径
的 URL 一律 `400`。姿态文件名就是 `<数据根>/pose/presets/<名字>.pose.json`，名字过同一套白名单。导出的
图落进素材库的「我的上传」目录（与 `gallery/list` 与拖放进节点共用同一处），单张去重后回
`{filename, subfolder, size}`，图组整批逐张校验通过才落盘、回 `{saved, count}`，任何一张不合法就整批不写。

场景写进 `<数据根>/pose/scenes/<名字>.json`，姿势库写进 `<数据根>/pose/presets/`，参考图落进
`<数据根>/pose/refs/`，自备素体 GLB 落进 `<数据根>/pose/dist/models/`，四处都不在
`tools\sync_pose_dist.ps1` 与 `tools\build_pose_package.ps1` 的镜像结果里（同步脚本把「源里没有的文件」
先存后还），重装摆姿包不动它们。

这十三条接口只做文件读写，桌面端离线服务全部自己答（`app/studio_caps.py` 的 `_POSE`）；`/pose-dist`
是两端各自直接注册的静态前缀，不进能力表。

## 宿主视图与消息方向

桌面端顶栏「摆姿」页签与首页卡片「3D 摆姿」进 `#/pose`；宿主模块是 `studio/web/pose/pose.js`。
宿主面板分五组：摆姿（导入素材、画布截图）、姿势库（存、套、删）、场景（写名保存、选场景载入）、
ControlNet 导出（勾格式、导出图组）、画布状态（只读一行）；素体一栏带着「导入自备素体」与一个 key
输入框，左栏底部在跑随包副本时出「随包只有 CC0 素体」的说明。工具条控件与 `pose:ready` 之前全部禁用，
面板随 `pose:ready` 出现；桥随 `pose:dispose` 拆掉，离开页面时不留监听器。

「导入自备素体」不依赖摆姿页的命令层（走宿主自己的 `/neo_pose/import_model`），旧摆姿包（`caps.hostUi`
为假、面板整片禁用）下它照旧可点 —— 导入的是文件，不是页面动作。桌面端服务的请求体上限按这条接口抬到
48MB 之上（aiohttp 默认只收 1MB，一份 2.9MB 的 GLB 走 base64 就会先被 transport 挡成 413），插件端那条
本来就走在 ComfyUI 自己的 100MB 上限里，两边体积口径一致。

页面自身的六行工具条是 `fixed` 盖在画布上的，矮窗口里它会挡住摆姿要的画布：左下角「面板：展开」钮与
`T` 键收起它，只留第一行（行高现量，窄屏换行时第一行内容随宽度变），状态写进页面 localStorage，与宿主
工具条无关。

| 消息                | 方向       | 载荷                        | 说明                                       |
|---------------------|------------|-----------------------------|--------------------------------------------|
| `pose:ready`        | 页面 → 宿主 | 无                          | 页面装配完，宿主立刻回一份 `pose:theme`    |
| `pose:theme`        | 宿主 → 页面 | `{caps, lang}`              | 能力位与语言，页面据此置灰不可用的控件     |
| `neo:import-image`  | 宿主 → 页面 | `{url, name}`               | 素材库里选中的一张图                       |
| `pose:export-image` | 宿主 → 页面 | 回复端口 `{data, name}`     | 请求导出画布，页面从回复端口交回 dataURL   |
| `pose:save-scene`   | 宿主 → 页面 | 回复端口 `{name, scene}`    | 请求序列化场景，页面从回复端口交回场景 JSON |
| `pose:open-scene`   | 宿主 → 页面 | `{scene}`                   | 把已存场景装回页面                         |
| `pose:call`         | 宿主 → 页面 | `{action, args}` + 回复端口 `{ok, data}` | 面板动作走页面自己的命令，见下节命令表 |
| `pose:state`        | 页面 → 宿主 | `{state}`                   | 画布状态快照，只进「画布状态」一行        |

请求类消息带 `MessageChannel` 回复端口，一次请求的回复只落在这条端口上；入站通知只认本页这张 iframe
（`event.source`）与同源 `origin`，名单外的消息名一律丢弃。iframe 的 sandbox 是
`allow-scripts allow-same-origin allow-downloads`，不给 `allow-popups` / `allow-forms` /
`allow-top-navigation`。

页面侧的桥在摆姿仓库的 `src/neoBridge.js`：只在页面真被装进同源 iframe 时存在，单机部署
（`npm run dev`、静态站）一个监听器都不挂。桥不新造能力，只复用页面已有的通路 —— 整场序列化
（存场景）、干净截图（关节球 / gizmo / 参考图层整层隐藏后才读画布，与「下载截图」按钮同一条）、
参考图层贴上（导入素材），以及页面自己的命令（套姿态、ControlNet 出图、画布快照），面板上的动作走
`pose:call` 那一行。序列化失败时页面不回包，让宿主超时后报「摆姿页未响应」，绝不让宿主把一份
错误对象当场景写进它的场景目录。口径与失败路径见摆姿仓库的 `docs/neo-studio-bridge.md`。

道具那一栏给的是「下拉 + 名字框」两件事：下拉显示道具的中文名，发给页面的 value 必须是页面认的 propKey
（内置 `builtin:chair`、注册表 `glb:<file>`）；名字框允许直接写名字，宿主在 `meta/list` 下发的道具清单里把它
解析成 propKey —— 中文名（椅子 / 凳子 / 桌子 / 木箱 / 木桶 / 大球 / 小球 / 圆柱 / 斜坡 / 单杠 / 台座 / 垫子 /
剑 / 短剑 / 长矛 / 弓 / 盾，以及注册表里的 label）、裸 id（`chair`、`arrow.glb`、`arrow`）与全 key 三种写法
同一条落点，label 的全角括号后缀（细剑（Sting））按括号前的名字认。名字不在这份清单里时面板直接说「道具表里
没有『X』」并报出可输入的名字与项数，不发 `pose:call`：道具定义只有那一份，在摆姿包里，宿主不猜定义。

## 桌面端不可用的能力

`/neo_pose/status` 的能力位里 `photo3d`、`mesh`、`pano`、`lib_write` 恒为 `false`：照片估点、网格生成、
pano 与库写入要 3d-pose-art 那套 Python sidecar（`pose_server.py`），桌面端进程不拉起它。页面按这几位置灰
对应控件，宿主不给它们出接口。这几条面板本来靠自己的服务探针（`/__pose3d/ping`、`/__pose-lib/ping`）降级
—— 它们只在 vite dev/preview 挂载，静态伺服的宿主上探针必然失败，面板按既有的「应答方不是估点服务」口径
自己关；`caps` 是宿主下发的同一份口径确认，不是第二处开关。

`body_import` 为 `true`，它是宿主自己那条路：随包只发授权干净的 CC0 素体，其余素体由用户自备 GLB 经
`/neo_pose/import_model` 写进数据根，页面在自己的本地导入区按 key 登记它 —— 写文件与登记都不需要 sidecar。
页面内置注册表引用了六个 GLB 素体，随包只发其中一个，跑在随包副本上时列表里其余几项点了会取不到文件，
所以左栏要把「跑在随包副本上」说明白，别让人以为素体列表坏了。

`hostUi` 恒为 `true`：宿主带着自己的面板（导入素材、姿势库、场景、ControlNet 导出、画布状态），
随 `pose:theme` 交下去，摆姿页据此收起面向独立部署的那套 demo 工具条 —— 场上同一时刻只留一套控件。
页面对旧摆姿包（没有宿主命令层）的兜底在宿主这边：`caps.hostUi` 不为 `true` 时面板整片禁用并说明要
重装摆姿包，不给用户留一条点了只会空转的按钮。

## 未安装的形态

两级落点里都没有 `index.html` 时（数据根没同步、`studio/pose_dist` 被删）：`/neo-pose` 回 404 与一句
安装提示，`/neo_pose/status` 报 `installed: false` 与 `dist_source: ""`，宿主页面显示「3D 摆姿未安装」
加两条装包路子（`tools\sync_pose_dist.ps1` 同步全量产物、随包的 `studio/pose_dist`）与一个「重新检查」钮，
不出 iframe、不出工具条。

页面开得来、模型一栏正常、只有「添加道具」逐条报失败时不是未安装：那条注册表请求
（`/models/props/index.json`）在宿主上落成 404，页面把注册表读成空的。浏览器 Network 面板按这条路径看
状态码，`/neo_pose/status` 的 `dist_source` 告诉你生效的是哪一级；随包副本本来就不带道具（授权口径），
要道具就 `tools\sync_pose_dist.ps1` 同步全量产物。

## 测试

- `studio/tests/test_pose_bridge.py`：路径包含与场景名白名单、wasm MIME、哈希/未哈希缓存、场景与姿态
  原子写、姿态往返、删姿态、参考图落 refs 与页面侧结果、单张导出与 ControlNet 图组落素材库、整批拒绝
  且不留半个文件、短路径 302；两级落点（随包副本兜底、数据根压同名文件、两级都缺的提示）、道具注册表
  那条根前缀在两级都取得到、随包清单进 status、自备素体落点与五条校验（key / 来源 / 体积 / 文件头 /
  素材库体积）、素材库来源解析、挡下的请求不留痕迹。
- `app/tests/test_studio_server.py::PoseBridgeTests`：离线服务里的页面跳转、子资源伺服与越界拒绝、
  `/models` 前缀答出注册表与道具 GLB（含自备素体与数据根压随包那份）、场景往返、姿态往返、能力位与
  归属（逐条核对摆姿模块注册的那张路由表）、随包副本兜底那一层、离线导入自备素体与 35MB 上限、
  请求体上限落在导入接口之上。
- `studio/tests/js/pose-bridge.test.mjs`：宿主视图的缺包形态、iframe 属性、桥的来源与同源校验、
  `hostUi` 门、导入 / 导出 / 套姿态 / 场景 / 图组五条路径落到的接口、跑在随包副本上的说明、
  自备素体导入（base64 上报与 key 校验）。
- `tools\test_pose_package.ps1`：随包摆姿包的自检 —— 必需文件、产物形状、不该发货的形态（`*.map`、
  白名单外的 GLB、道具 GLB、散 JSON）、逐文件 sha256 与体积核对、道具注册表为空、开发机绝对路径、
  体积上限。
- 摆姿仓库侧的页面桥：`tests/neoBridge.node.test.mjs`（桥的存在判定、来源与 origin、回复端口回包、
  失败怎么出声）。
- 摆姿仓库侧的部署根：`tests/appBase.node.test.mjs`（站点根逐字不变、前缀部署折进前缀），页面套件
  `tests/unit.mjs` 里锁「默认素体 GLB 按部署根取到」与「收起工具条只留第一行」。

摆姿包自身的实现与页面文案在 3d-pose-art 仓库（MIT），本仓库只伺服它的产物并给桥接口，不 fork 其源码。
