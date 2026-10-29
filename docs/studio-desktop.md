# 桌面端（Studio Desktop）

桌面端把 Studio 页面装进本地窗口：自己拉起 ComfyUI，并在 ComfyUI 端口 +3 起一个本机 Studio 服务
（`app/studio_server.py`，进程里没有 ComfyUI 运行时；文件读写类接口照常在它上面服务），ComfyUI 不在跑时页面
照样能浏览素材、编辑配方与技能。源码运行与打包 exe 走同一条 `app/studio_app.py`。

## 组成

| 文件 | 职责 |
|------|------|
| `app/studio_app.py` | 窗口、自检、拉起 / 停止 ComfyUI、无边框窗口、关窗收尾、启动设置 |
| `app/studio_server.py` | 桌面端 aiohttp 服务（ComfyUI 端口 +3，`DESKTOP_PORT_OFFSET`），按目录加载插件模块挂在各自 `RouteTableDef` 上的 handler |
| `app/studio_caps.py` | 能力表：哪些路由归桌面端服务，表外一律 `409 offline` |
| `data/` | 状态目录：`studio_window.json`（几何）、`studio_profile`（WebView2 profile / localStorage）、`launcher_config.json`（root / python / port / frameless / dev_mode / listen / remote）、`studio_desktop.log`、`comfy_run.log` |

源码运行的状态目录是仓库根的 `data/`；exe 优先 exe 旁的 `data/`，落在不可写目录时退回 `%APPDATA%\Neo Studio`。

## 离线门控

判定标准是「只做文件读写 / 本地检索 / 远程下载 / 打 8080 LLM 服务」；需要执行队列、显存、节点定义的归 ComfyUI。
功能开关表随 `/neo_studio/version` 下发，Studio 只门控运行类按钮（生成 / 跑段 / 拼接），配方编辑、技能编辑、
设置、LLM 配置都不需要 ComfyUI 运行时。路由清单见 [api-routes.md](api-routes.md)。

桌面端服务读模型目录时要自己加载内核那份 `extra_model_paths.yaml`（`build_app()` 调 ComfyUI 的
`utils.extra_config.load_extra_path_config`）：这份 yaml 只有 ComfyUI 的 `main.py` 会读，桌面端进程不加载
的话 `get_filename_list` 只扫 `<root>/models/`，模型放在 extra 路径的机器上（整合包是 `base_path: F:\`，
模型在 `F:\models\`），离线页的模型下拉就是空表，技能里已存的模型路径全标「(缺失)」。

主画布（ComfyUI 页面）是 SPA，进程停了页面还活着、画布照常能拖能改，改完的东西落不进任何执行。
`studio/web/canvas-lock.js` 读前端自己的连接事件当判据：`status` 空 / `reconnecting` = 后端没了，
`reconnected` / `status` 带数据 = 回来了；锁之前先打一次 `/system_stats` 确认，WS 抖动不误锁。确认掉线就走
前端自带的画布锁（`LGraphCanvas.read_only`，与 `Comfy.Canvas.Lock` 同一份）：平移照常，节点拖动 / 缩放 /
widget 编辑 / 右键加节点全停，底部出「🔒 ComfyUI 未运行 · 画布只读」。离线期间每 3 秒复探一次，
恢复后解锁并还原用户自己的锁定状态。

离线页跑在桌面端服务上，技能详情的「⤒ 主画布编辑」开的是当前源的根路径 —— 桌面端根路径没有画布页，
ComfyUI 没就绪时点它只会得到「页面不存在」。`openSkillWorkflowInMainUi()` 照顶栏那份运行状态拦一下：启动中
报「ComfyUI 启动中…就绪后再编辑主画布」，未运行报「该功能需要 ComfyUI · 在「设置 → 启动设置」点「启动内核」」。

## 就绪后原地接上生成

冷启动的窗口停在桌面端服务的 Studio 页上，ComfyUI 就绪后页面**原地接上生成**：不换地址、不刷新、不整页跳转。
整页跳转与刷新都会清掉导演编辑器和设置表单里未保存的内容，跨源跳转更是全丢。

- 桌面端在 `/neo_studio/version` 里下发 `routes`（归属表，`studio_caps.route_list()`）与 `comfy_base`
  （生成类请求的直连目标）。前端按归属表判定每条请求打桌面端还是打 ComfyUI；`comfy_base` 为空时表外的请求
  照旧打桌面端拿 `409`，走统一的「需要 ComfyUI」提示。
- 直连只在「桌面端自己拉起的那路 + 只监听本机 + 桌面端服务已绑定端口」时开启（`StudioDesktop.direct`）。
  这条判定必须与 `comfy_cors()` 的取值条件同源：ComfyUI 的 `--enable-cors-header` 与它的 origin_only 中间件互斥
  （`ComfyUI/server.py`），不给 flag 时从桌面端口 origin 发往 ComfyUI 的请求会因 Host/Origin 不等直接 403，
  页面直连就是全红。
- 代价是这路 ComfyUI 的 origin_only 这道 CSRF 防线让位，所以局域网监听（`--listen`）与远程模式一律不给 flag，
  那两路保留整页跳转：暴露到网卡的实例不在防线上让位换体验。
- 翻面一次做完，ComfyUI 答话之前整块不翻：能力表换成 ComfyUI 的、门控按钮摘监听并还原文案、`body.ns-offline`
  离线标记摘掉、顶栏队列入口浮出并按六张表补种一次（显存 / 内存读数条随之补建）、`/ws` 从桌面端的桩换到 ComfyUI 的
  真事件流。只解禁按钮不换事件流就是
  「任务交得出去、进度拿不回来」的半在线态。
- 翻面由 `ready` 驱动，不看是谁拉起内核：桌面端在就绪这同一份快照里才清掉 `starting`，拿 `starting` 当翻面条件时，
  桌面端自己拉起内核的冷启动永远翻不过来 —— 顶栏报「运行中」，页面钉在离线形态，生成请求全 `409`。
- 离线页不叠横幅：顶栏状态位报「● 已停止」并把入口指向「设置 → 启动设置」，生成入口按能力门控压暗，
  `body.ns-offline` 就是各模块认离线形态的那份标记。
- 停掉内核后页面翻回离线形态：直连目标清空、生成按钮重新门控、事件流换回桩，窗口导航不动。

## 导演页布局

导演页 = 整幅主栏左右两块：**左 = 导演编辑器**、**右 = 整片生成面板**，中间一条**竖向分隔条**。**📋 配方** /
**🖼 素材库** 两个入口不占独立一行：编辑器开着时它们就在编辑器标题行的左端（素材是编辑要用的东西，编辑器收起时标题行
连同入口一起消失）。配方列表与素材库都在弹窗里打开（`js/core/lib-modal.js`），主栏的宽度全留给编辑与生成这两块。

- 导演编辑器在 Studio 里是内嵌的（`setDirectorEditorHost` 注册宿主）：铺满左栏，不建浮层窗口，
  标题栏拖动 / ⛶ 放大 / 右下角缩放都不出现。主画布（ComfyUI 页面）没注册宿主，编辑器仍是浮层弹窗。
  内嵌保存（含 **🎬 保存并生成整片**）成功后编辑器**留在原地**——生成在右侧进行，刚编辑的界面不被抽走；
  关闭只由标题栏 **✕** / 底部 **取消** / 确认条「保存并关闭」触发，切到别的配方时由单例重载关掉。
- **开机固定落在首页，编辑器只由人点开**：配方列表落地时首个导演配方自动选中（上方整片生成区与智能体上下文认它），
  但不铺进左栏宿主——铺编辑器会经宿主的「打开时切到本页」回调，把窗口从首页切到导演页。
  导演页因此停在引导页，点「配方」选一份或「新建配方」才进编辑器。关掉一次编辑器记进本机偏好（`neo_studio_director_closed`），
  之后配方面板不再自动选中——列表默认按修改时间排，刚编辑的那份总在首位，不记这一笔的话每次开机都是「选中上次的配方」。
  **点配方卡 = 选中配方 + 内嵌打开该配方 + 关掉配方弹窗**（重复点同一张卡只切段、不重载，未保存的改动不丢；构建中的点击直接忽略，连点不会叠出两个编辑器），素材页的「🎬 新建导演配方」会切到导演页并内嵌打开，配方弹窗里的「新增导演配方」也照这条路关窗让位 —— 空白配方直接铺进本页，不在弹窗后面叠一层。
  编辑器有未保存修改时点另一张卡被确认条挡下：**卡片高亮、分段格子与尺寸回显全留在旧配方上**，确认条里「保存并关闭」/「放弃修改」关掉旧编辑器后自动打开刚点的那份，「继续编辑」取消这次切换。
  用 **✕** / 取消关掉编辑器后**生成面板跟着一起退场**：主栏整块收起，整栏只剩一块引导页 —— 起手说明照绘画页 / 视频页的空白态版式
  （主行 + 细注 + 四角括号），文案就是首页那张入口卡的同一句（**导演视频** / 多段配方，生成整片视频），下面两个入口是
  **📋 配方** / **📝 新建配方**（「配方」那一个按钮实例从标题行搬来这里，页面上同时只有一处；素材库不在引导页）；
  点配方卡或「新建配方」重新打开编辑器，就回到左右分栏。
- **📋 配方** 开配方弹窗（`.ns-libmodal[data-lib-scope="recipes"]`，只列多段导演配方），**🖼 素材库** 开
  素材库弹窗（`data-lib-scope="assets"`，绘画页共用同一个实例）。导演编辑器里的 **🖼 素材库** 按钮是同一个入口
  （Studio 没有 ComfyUI 左栏，`media-transfer` 写 `sidebarTab.activeSidebarTabId`、经 shim 转交给弹窗落地），
  按钮开合时入口按钮跟着点亮。素材库就是素材页那套
  Neo Gallery（同一个元素在素材页宿主、弹窗宿主与 standby 宿主之间搬移，宽版样式），面包屑与目录导航照用，
  切走的宿主一律停在**刚浏览的那个目录**（不落首页），素材卡直接拖进编辑器的首帧 / 参考位。
  **在弹窗里点卡片 = 直接填进刚点的那个槽位并关弹窗**；多选后走底部 **📥 已选 N 项**，整批按编辑器给的起始段号铺开。
- 弹窗几何：默认铺满整窗，拖标题栏即变浮窗（位置与尺寸自己记，跨页共用一份），最大化 / 还原、拖动右缘改宽
  （下限 640px）、Esc / 点遮罩 / **✕** 关闭；宽度、位置与最大化状态存
  `localStorage["neo_studio_libmodal_recipes"]` 与 `localStorage["neo_studio_libmodal_assets"]`。
  切页与离开本页时对应弹窗自动关闭，画廊回到 standby 宿主。
- 分隔条：编辑器与生成面板之间一条竖线，兼作拖动热区 —— 拖动调生成面板宽度（编辑器下限 360px、面板下限 200px，
  拖过下限再多拖 90px 就当作把面板拖到关闭；收起与展开都靠拖，照 VSCode 的 sash）。收起后条上竖排出现
  **◂ 生成面板**，向外拖出一点面板就回来；拖不动的人点一下那行字也认，拖动松手跟来的那一下点击不吃展开。
  展开时条上不留字。键盘 `←`/`→` 调宽、`Enter` 收起 / 展开。宽度与收起状态存 `localStorage["neo_studio_director_split"]`。
  面板拖宽拖窄，面板内的结果区（实时预览 / 成片）按配方 `宽×高` 的比例伸缩（竖屏配方就是一条窄的），不再在固定预览框下面留一片空白。
  热区是 18px 宽里一条 1px 竖细线，悬停 / 键盘聚焦 / 拖动时加粗到 4px 并变蓝；收起那行字只在收起态给 pointer 指针。
- 生成面板只做「跑哪几段 + 看结果」，不带参数控件，内部两块：**顶部一行控制** —— **全选** / **清空** / **分段勾选条**
  （一格一段，格内只有段号）/ 勾选提示 / 只读回显（本次整片的 `宽×高 · 步数`，值来自配方）/
  **🎬 生成整片** / **⏹ 取消** 同占一行，段数多时格子条自己横向滚，面板拖窄到装不下这一行时这一行自己换行（不横向滚）；
  **下方整块是结果区**（实时预览 / 成片）。
  **点格子 = 勾选要跑的段，未勾选 = 生成整片**；**全选** / **清空** 一键整条，格子悬停提示该段画面描述。
  勾选是运行期临时状态：换配方即清空，不写进配方。运行中当前段格子高亮。
- 整片的运行参数（分辨率 / 步数 / 种子 / 连续性 / 上下文帧）只在导演编辑器里设置并保存进配方 `shared`，
  面板与请求都不重复一套控件。编辑器「🎞️ 分镜时间线」页首行只放生成模式 / 技能 / 分块秒数 / 分辨率，
  种子 / 步数 / 连续性 / 上下文帧收进行尾的 **高级参数**、默认收起（收起不影响生效，保存照读值）。
- 编辑器底部 **🎬 保存并生成整片** 与生成面板的 **🎬 生成整片** 共用同一份提交：保存成功后
  按配方里刚存的参数 + 面板勾选的段提交整片生成，编辑器保持打开。
- 生成状态到终态（已完成 / 失败 / 已取消）即定格：终态之前发出、终态之后才回来的旧进度载荷一律作废，
  进度条与 **⏹ 取消** 不会复活（点已结束的取消只会拿到「任务已结束，无法取消」）。
- 主栏左右两块，窗口窄到两部并排不下时整页出横向滚动（编辑区与生成面板都不被压成读不了的窄条）；
  配方与素材库弹窗铺满整窗，最小宽度 640px。

## 绘画页布局

绘画页 = 顶部一条工具条（**文生图 / 图片编辑** 模式条 + **🖼 素材库** 入口）+ 整幅一块面板，
一次只铺满一块 —— 不像导演页那样编辑器与生成面板同屏分一块宽度。素材库弹窗、滚动条与窄窗口规则全部与导演页
共用同一套样式（同一个弹窗实例、同一份几何 `localStorage["neo_studio_libmodal_assets"]`）。

- 绘画面板在 Studio 里是内嵌的（`setPaintHost` 注册宿主）：铺满整幅，不建浮层窗口，标题栏拖动与 ✕ 都不出现。
  主画布（ComfyUI 页面）没注册宿主，「🖼️ 生成素材」与「🖼️ 图片编辑」在那里仍是浮层弹窗。
- 素材页顶栏的「🖼️ 生成素材」与图片卡菜单的「🖼️ 图片编辑」在 Studio 里一律切到绘画页并铺进对应面板；
  「🖼️ 新增图片配方」开一张空白文生图面板。绘画页不再有图片配方列表。
- 文生图面板是「一格提示词框 + 底行 chips（技能与自定参数 / 宽高比 / 最长边 … ⋯ 生成）」的输入卡，钉在面板底部
  （输入条样式参考 ArtCraft 的 promptbox）：框里写一句就生成，三枚 chips 是胶囊按钮 + 向上浮出的面板（原生下拉
  只当状态容器，不露在界面上；技能清单与主模型 / LoRA 在同一枚 chip 的双栏面板里），随机填入 / 提示词增强 /
  运行时随机 / 预设列表收在 `⋯` 菜单里。面板铺满栏高：生成中的进度与成品图在输入卡上方从顶部往下排，idle 只在结果区给一句起手提示
  （「写一句提示词，点生成」），不铺空画布（控件清单见 [gallery.md](gallery.md)「生成素材」与「图片编辑」）。

- 绘画页已在本页时点弹窗里的「生成素材」或图片卡菜单的「图片编辑」：面板铺好后弹窗自己关掉 ——
  同页 `go()` 不触发 `showView()` 的切页收起，否则弹窗盖在面板上。
- 模式选择存 `localStorage["neo_studio_paint_mode"]`。
- 素材库弹窗里的画廊与素材页、导演页是同一个元素：`media-transfer` 写入只开当前页的弹窗，切走本页自动关闭。
  离开素材页时把 `sidebarTab.activeSidebarTabId` 归位 —— 素材页挂载画廊会把它写成
  `neo.gallery`，不归位的话本页「素材库」按钮再写同一个 id 会被去重吃掉，弹窗打不开。
  在弹窗里**点一下卡片**就直接填进图片编辑的原图预览并关弹窗；底部 **📥 已选 N 项** 收齐多张后一次铺开。
- 显存 / 内存读数与「清理」钮在顶栏队列面板里：面板展开时才轮询，收起即停表；生成页不再各铺一条读数条。

## 技能页布局

技能页默认停在**引导页**：起手说明照绘画页 / 视频页 / 导演页的空白态（主行 + 细注 + 四角括号），下面一排三个入口：
**📂 导入工作流** / **✏ 新建模板技能** / **🗂 技能列表**。管理组件点了入口才装配，落在引导页时不拉技能列表。

- **导入工作流** 只收 ComfyUI「导出（API）」那份 `.json`（扁平的 `node_id → class_type / inputs`）：选完文件先走
  `plan_workflow_skill` 预览可替换的变量，再在「导入工作流创建技能」对话框里填名称、勾选变量，由
  `save_workflow_skill` 落成一份自定义生成技能；导入完成后直接进技能列表并选中刚建好的那份。ComfyUI 直接点
  「保存」给出的界面工作流（`nodes` / `links`）会提示回 ComfyUI 另存 API 格式，不写进技能目录。
- **新建模板技能** 打开统一技能管理的新建表单：只写 `skill.md`，不绑定 `workflow.json`。
- **技能列表** 打开统一技能管理（`createSkillManager(host, { showClose: false, showCanvasBtn: false, autoSelect: false })`）：
  左列表 + 分隔条 + 右详情，不建浮层窗口，✕ 与「从画布」导出按钮不出现；默认选中展开分类的第一项。
  列表态标题条上的 **← 引导页** 回到引导页；详情有未保存修改时先确认，确认后卸掉整个管理组件，下次进列表重新装配。
- 组件是弹窗出身：`prompts.css` 给的是 `#1a1a2a` 面板底、`#1a2a3a` 标题条、`#5090cc` 蓝高亮、`#1a3a5a` 小蓝按钮，
  与外壳的灰底 + `#7aa2ff` 差一整套色。外壳在 `.ns-skills` 作用域里把这一套换成外壳色（`#17171b` 页底、
  `#202024` 标题条、`#2a2a2e` + `#444` 输入与按钮、选中行用设置页 tab 的半透明蓝），首页 / 素材 / 绘画 / 导演 /
  设置 / 技能六页落在同一套色上。ComfyUI 里的技能弹窗与节点技能选择窗仍是弹窗那套色。
- 引导页态不显示「🗂 技能管理」标题条（顶栏 tab 已给页名）；列表态才露出，标题写「技能列表」并带返回引导页的入口。
- 左栏宽度拖拽与记忆（`localStorage["neo.skillManagerLeftWidth"]`）、分类手风琴、行内复制 / 删除图标、
  底部 + New / ⬆ ZIP / ⬆ Folder 与独立窗口同一套行为。
- 复制与删除的图标统一取 `studio/web/js/core/icons.js`：纯图标钮只有图标，带文案的钮是图标加文案，
  字形不随字体与 emoji 字体回退变样。


## 启动序列

- 窗口先出：开窗只做解包与建窗口（启动页 / 引导页），自检、桌面端服务、拉起 ComfyUI 都在后台线程跑完。
- 桌面端拉起 ComfyUI 期间的 `starting` 是 `StudioDesktop` 与桌面端服务共用的一份 dict，`comfy_state` 与
  `/neo_studio/version` 同时下发。pywebview 的 js_api 注入晚于页面加载，且 `window.pywebview` 先出现、方法由
  `finish.js` 后填：桌面端 api 一律等到要用的方法出现才接管，前端只靠版本快照就知道在启动中。这段时间只出
  「ComfyUI 启动中…」，不出「需要 ComfyUI」提示与启动入口。
- 桥在整页刷新（F5 热键）之后由 pywebview 在导航完成时重新注入，实测晚到页面脚本之后十几秒（`data/studio_desktop.log`
  里 `before_load` 与 `loaded` 隔 13 秒）。顶栏窗口控件与拖动挂在 `pywebviewready`（`finish.js` 填完方法那一刻派发）
  上，注入完即生效，5 秒一轮的探桥只作桥先于模块脚本注入完、事件已经过去时的补刀。顶栏状态位仍挂在 5 秒一轮上，
  不在几轮之后放弃：放弃一次就是刷新一次顶栏少一块，就绪后的原地翻面也断在这里。状态位还不认桥一条来源：桥的返回值
  要窗口线程把 resolve 脚本打回页面（pywebview 在 worker 线程算完结果，靠 `evaluate_js` 的 `Invoke` 加信号量送回），
  而拖动循环就跑在窗口线程上、每步 `sleep` 不泵消息，这段拖动里桥的 promise 整段不落地。顶栏每轮同时问桥与桌面端
  服务的 `GET /neo_studio/comfy_state`
  （同一份 `comfy_state`，由服务线程答，与窗口线程无关），谁先落地用谁；页面 origin 不答这条路由（浏览器标签页、远程
  那路）就停问。
- 启动桌面端时「有没有 ComfyUI」只看端口有没有人监听：`/neo_studio/version` 探不到（那路插件没加载、还在导入自定义
  节点）也只附着，不在旁边端口拉第二路，启动设置的「启动内核」按钮同样只附着。

## 引导页（首次设置）

根目录推不出、或同级与内部都找不到 `python.exe` 时，窗口开在引导页（`guide_html`，`load_html` + js_api）：那时
`build_app` 连 `folder_paths` 都 import 不了，桌面端服务本来就起不来，页面只能不依赖 HTTP 服务。校验与拉起全走
js_api（`check_setup` / `pick_root` / `pick_python` / `start_setup`），根目录补完了服务才起得来。

## 无边框窗口与拖动

- 无边框是启动设置里的一项，存 `launcher_config.json` 的 `frameless`（缺省开，勾掉回系统标题栏）：建窗时喂
  pywebview，运行中改样式位（只摘 `WS_CAPTION`，`WS_THICKFRAME` 恒置 —— pywebview 的 frameless 走
  `FormBorderStyle=None`，拖边缩放会一起被摘掉，窗口 Shown 之后由 `ensure_resizable_frame` 补回；原生窗口在
  `start()` 里才建出来，建窗时拿不到 hwnd）。
- 窗口底色在建窗时显式给成页面底色（`WINDOW_BG` = `#17171b`，与 `studio/web/studio/style.css` 的 body 同色）：
  pywebview 的 `background_color` 默认 `#FFFFFF`，同时定 WinForms 的 `Form.BackColor` 与 WebView2 控件的
  `DefaultBackgroundColor`。拖边框缩放走系统缩放模态循环，循环里 Form 与 `Dock=Fill` 的 WebView2 子控件被一起改
  尺寸，新暴露的客户区先由这两个底色刷出来 —— 底色是白的就是白窗闪一下。补回的 `WS_THICKFRAME` 那一圈由 DWM 按
  系统主题色画，浅色主题下缩放时那条边框线本身就是白的：`set_window_frame` 重贴样式位时顺带把
  `DWMWA_BORDER_COLOR` / `DWMWA_CAPTION_COLOR` 钉成同一底色（Win10 不认这两个属性，只回非零 HRESULT）。
- `easy_drag` 必须关掉 —— pywebview 的简易拖动是全局 mousedown，无边框时点任何卡片都会拖着窗口跑。拖动由顶栏
  空白处按下调 `win_start_drag`，桌面端在窗口线程上自己循环跟光标（`SetWindowPos` + `GetAsyncKeyState(VK_LBUTTON)`），
  左键一松就停 —— 交回系统走 `WM_NCLBUTTONDOWN + HTCAPTION` 或 `WM_SYSCOMMAND·SC_MOUSEMOVE` 都起不来，WinForms
  的 Form 把非客户区按下吞掉了。
- 顶栏按下这条监听的挂法决定冷启动那一段拖不拖得动：`initWindowChrome` 在启动链之前跑，按下挂在 `pywebviewready`
  （桥的方法由 `finish.js` 填完时派发）上，不等扩展 setup 与版本快照 —— 那两次请求打在刚装配、正拉起 ComfyUI 的
  桌面端服务上，窗口停在冷启动页时它们可以卡几十秒，排在后面就是「开出来要过一会才能拖动」。
- 按下没走出系统拖动阈值（`SM_CXDRAG`）不算拖动：窗口一动不动，最大化 / 全屏也留到走出阈值那一刻才退 ——
  最大化下 `SetWindowPos` 会把窗口打回还原态，单击顶栏就跟着还原不是原生标题栏的语义。双击顶栏空白调
  `win_maximize` 来回切最大化 / 还原，全屏时先退回窗口态。
- 最小化 / 最大化 / 全屏 / 关闭走 `window_state` + `win_*` 一组 js_api 方法，控件出不出由 `frameless` 决定。
  最大化与全屏状态由桌面端自己记（pywebview 的 `Window.maximized` / `.fullscreen` 是建窗初值）：无边框下最大化铺
  工作区（系统 maximize 给整屏矩形，任务栏会被盖住）；全屏退出时 pywebview 把 `FormBorderStyle` 写回建窗时的值、
  标题栏跟着回来，样式按桌面端的状态重贴；全屏时关窗不存几何（存的是整屏矩形，下次开机窗口铺满屏幕）。

## 划词复制

- 正文要划得起来：建窗时显式给 `text_select=True` —— pywebview 默认 False，注入页面的 `customize.js` 给非表单元素
  `preventDefault selectstart`，聊天正文一个字都选不动。对话正文这一层在 `studio/web/agent-panel.css` 里把
  `user-select` 交回 `text`，按钮与输入控件不在其列。
- 原生复制按键在窗口显示后补开：`enable_copy_keys` 把 CoreWebView2 的 `AreBrowserAcceleratorKeysEnabled` 置真，
  Ctrl+C / Ctrl+V / Ctrl+X / Ctrl+A / Ctrl+Z / Ctrl+Y 不靠开发模式就能用。这几键在页面侧由
  `initClipboardKeys`（`studio/web/studio/studio-app.js`）在 capture 相位摘走，注入的那一套吞键 handler 收不到事件；
  刷新键不在放行名单里，仍由 `initReloadHotkey` 接管。
- `http://127.0.0.1` 不是安全上下文，`navigator.clipboard` 不存在。智能体对话页一轮只放一枚复制钮
  （`mkCopyBtn`），钉在最终回答正文之后：钮面只有 Cline 那枚叠角方块图标（inline SVG），一句文案都不写、
  连 tooltip 都没有；点击走 `navigator.clipboard`，没有就退到 `execCommand`，成功换对勾、两条路都不通换叉，
  1.5 秒收回图标。一枚就够——同一张问答卡片里并排两枚，分不出各复制哪一段。按钮落在正文文本之外，
  划词与取文本带不走按钮。
- 输入框随内容长到 108px 封顶（`fitInput`）：发送即清空并把焦点交回输入框，空闲时按 Esc 清掉写了一半的一段。

## 开发模式

- 开发模式是启动设置里的一项，存 `launcher_config.json` 的 `dev_mode`（缺省关）：勾上下次开机走
  `webview.start(debug=True)`，设置页的开关是 `set_dev_mode`。DevTools 不自动弹（`OPEN_DEVTOOLS_IN_DEBUG`
  关掉，pywebview 在 debug 时会 `OpenDevToolsWindow`），按 F12 或右键「检查」手动开。
- pywebview 在 CoreWebView2 建环境时把 `AreBrowserAcceleratorKeysEnabled`、`AreDefaultContextMenusEnabled`、
  `AreDevToolsEnabled` 全等于 debug：不带开发模式时，F5 / Ctrl+F5 / Ctrl+R 与 WebView2 右键菜单在窗口里都不出。
  右键菜单与 DevTools 建环境时定值，运行中的窗口改不了，勾完要重启窗口；原生复制按键不在这个限制里，窗口
  Shown 之后由 `enable_copy_keys` 补开（见「划词复制」）。
- 刷新入口不依赖开发模式：Studio 页自己接管 F5 / Ctrl+F5 / Ctrl+R（`studio/web/studio/studio-app.js` 的
  `initReloadHotkey`），前端热同步（`tools/watch_web.py`）之后按一次就是新代码。

## 启动设置的 ⓘ 说明

- 「启动设置」每一行标签旁有一个 ⓘ，悬停（键盘 Tab 聚焦同样出）给出这一行的前提条件与生效方式：根目录 /
  解释器 / 端口 / 局域网监听 / 远程 ComfyUI 走「保存并重启 ComfyUI」，无边框窗口立刻生效并写进配置，
  开发模式要重启桌面端窗口。文案在 `studio/web/studio/studio-app.js` 的 `TIPS` 里。

## 界面语言

- 设置页有「界面语言」一栏（`中文` / `English` 单选）：选完立刻落盘并整页刷新，没有「保存」这一步。
- 语言存 `localStorage["neo_studio_lang"]`，默认跟随系统浏览器语言。桌面端窗口与浏览器标签页是不同 origin，
  两边各存各的语言选择。
- 翻译覆盖桌面端自有文案：顶栏与窗口控件、导演页生成面板、启动设置（含 ⓘ 提示）、顶栏状态位、队列面板的显存 / 内存读数。
  素材 / 技能视图与 LLM / 生图 / 生视频表单是共享模块，保持中文原文。
- 词条在 `studio/web/js/core/i18n.js`：中文原文作 key，英文缺项回落中文，漏译只会退回中文，不会露出占位符。

## 局域网访问

- 「启动设置 → 局域网监听」是下拉框，选项由桌面端给的本机网卡列表拼出来（仅本机 / 全部网卡 `0.0.0.0` / 各块网卡
  IP），存 `launcher_config.json` 的 `listen`（默认「仅本机」= 不传 `--listen`，ComfyUI 只监听 127.0.0.1）。
  选完点「保存并重启 ComfyUI」生效，提示行实时给出局域网地址；手改配置写进非 IP 的值时桌面端报错，不会喂给 `--listen`。
- 只监听某块网卡时桌面端把 `127.0.0.1` 一起带上（`comfy_listen`）：窗口跳的是 `http://127.0.0.1:端口/neo-studio`，
  端口探测 `port_busy` 也认回环 —— 回环上没人听的话窗口打不开，在跑的那路还会被读成空位再拉一路。
- ComfyUI 没有鉴权：开了监听，`/api/*`、`/neo_studio/*`、`/view` 对局域网上的机器全部敞开，只在信任的网段开，
  用完清空这一项。MCP 服务不参与这条网络口（stdio + 回环，见 [mcp.md](mcp.md)）。

## 远程 ComfyUI

- 「启动设置 → 远程 ComfyUI」填 `http://主机[:端口]`（`https` 同样收；path / query / 锚点 / 凭据不收），存
  `launcher_config.json` 的 `remote`。非空时窗口直接开在 `http://<远端>/neo-studio`，探活与就绪跳转都打在远端上
  （`probe` 收的是目标 base，本机模式是 `http://127.0.0.1:端口`）；留空 = 连本机，也是默认。
- 远程模式下本机不拉进程：`port_busy`、`free_comfy_port`、`start_comfy`、`port_owner`、`kill_pid` 全不参与。
  「启动内核」变成重连远端，「停止内核」禁用 —— 远端进程由远端那台机器自己起停。
- 远端要自己装好 `comfyui-neo-studio` 插件，并在它自己的「启动设置 → 局域网监听」里放开监听；探活打不通时窗口停在
  离线页并提示「远程 ComfyUI 不可达：<地址>」。
- 远程模式读写的是远端的插件数据（配方 / 技能 / 设置都在远端那台机器上）；离线页仍是本机的桌面端服务，浏览本机素材目录。
- 本机启动项（根目录 / 解释器 / 端口 / 局域网监听）在远程模式里灰掉：那几项归远端配置，本机改了影响不到远端。
- 窗口地址换了就是另一个 origin，Studio 页存在 `localStorage` 里的设置不跟着过去。

## 关窗与进程回收

只带走桌面端自己拉起的那路：这一轮拉起的用 `Popen` 句柄，上一轮拉起的用 `data/comfy_child.json` 标记认领；
用户自己启动的 ComfyUI 没有标记，完全不碰。

- 拉起的那路一出生就挂进 Job Object（`KILL_ON_JOB_CLOSE`）：桌面端进程一死，OS 关句柄连带杀掉作业里的进程
  （含 ComfyUI 自己起的子进程）。收尾链只在桌面端自己走到退出代码时才跑，Ctrl+C、任务管理器结束进程、注销、
  崩溃都把它掐在收尾之前 —— 没有这层内核约束，ComfyUI 就留在端口上成了孤儿，下一轮桌面端探到端口有人监听只能
  附着（`self.comfy` 是 `None`），之后每次关窗都不杀它。
- 附着模式下（`self.comfy` 是 `None`）关窗按 `data/comfy_child.json` 认领孤儿：`spawn_comfy()` 拉起那一路时
  记下 pid + port，收尾时端口仍在监听、监听者仍是这个 pid 才杀。上一轮桌面端拉起、在收尾跑到之前活下来的
  ComfyUI 因此在下次关窗时被带走 —— 它的内存里是几小时前导入的插件代码，磁盘上的文件同步得再新也不会重新
  导入，放它活着下一次导出依旧落在旧路径上。`comfy_stop` 与 `comfy_close` 收尾后都清掉标记。
- 第一次 `closing` 只存几何 + 放行关闭（返回 `False`），收尾（杀进程 → 挂「正在停止 ComfyUI」→ 收桌面端服务 →
  `destroy`）全在后台线程走完 —— 杀进程排在挂提示前面，`evaluate_js` 卡住也拖不住带走内核；`closing` 同步跑在
  UI 线程，收尾睡多久窗口就冻多久（桌面端服务正忙时 `join` 吃满 5 秒），`evaluate_js` 更要等 UI 线程回消息循环
  才执行，在处理器里调直接死锁。
- 几何必须在窗口销毁前读走（销毁后读属性会抛，收尾链断在半路、进程变孤儿）；`closed` 与进程退出前各兜一次
  （`destroy` 路径可能根本没有 `closing`），退出前 join 收尾线程，不等完就退进程等于留孤儿。
- 判活按 PID 问 `OpenProcess`，不用 `Popen.poll()`（子进程句柄被回收后它会谎报「已退出」）。
- `terminate` 之后必须 `reap`（`Popen.wait`）回收子进程 —— 不回收的话进程只剩一个内核对象，`pid_alive` 永远报
  「还活着」：关窗固定睡满等待上限（就是那几秒卡顿），按 PID 的兜底强杀与「启动设置」停止内核的端口扫荡也必然失败
  （那行「没有权限终止该进程」）。回收超时才兜底强杀，不做那套按端口扫荡。

## 单实例锁

命名互斥体 `Local\Neo.Studio.SingleInstance`，不占端口：占 8189 监听在 netstat 里像第二路 ComfyUI，会被读成「起了
8188 和 8189 两个端口，关窗只掉一个」。「已存在」的信号问 `kernel32.GetLastError()`，`ctypes.get_last_error()`
在这条调用上拿不到 183。

## 插件同步

源码运行时每次启动把 `studio/` 同步进 `custom_nodes` 那份（`sync_plugin`：只覆盖同名代码，大小与 mtime 对得上的
跳过，ComfyUI 正占用那一个跳过、下次启动再补，目标目录里的东西一样不删）。桌面端服务与 ComfyUI 页面都从
`custom_nodes` 取前端文件，同步完窗口一开就是新 UI；exe 只按内置副本版本换目录，git 检出的那份不碰。
**改完 `app/studio_app.py` 必须重新打包**，见 [release.md](release.md)。

## 静态资源与缓存

桌面端 `/extensions/` 静态响应带 `no-store`（与 ComfyUI 的 `/extensions` 一致），并在开窗口前清掉
`data/studio_profile/EBWebView/Default/Cache`：缓存里的旧插件 JS 会被直接端出来用（不发请求），和新模块拼进同一张
ES 模块图后，链接错误发生在 `studio-app.js` 执行之前、JS 捕获不到，整页只剩顶栏 —— 视图不挂、
顶栏状态位永远 `hidden`。

## 日志

- `data/studio_desktop.log`：启动 / 跳转 / 关窗 / 拖动步数（`drag N steps`，0 = 按下没走出拖动阈值或左键已经不
  在），以及页面上报的
  前端未捕获错误（`[web]` 前缀，页面走 js_api 的 `log()`），只留尾部 200KB。
- `data/comfy_run.log`：桌面端拉起 ComfyUI 的完整 stdout / stderr（端口冲突与导入报错都在里面，Studio「设置 → 日志」读它）。

## 相关测试

`app/tests/test_studio_desktop.py`、`app/tests/test_studio_server.py` 与 `studio-app.e2e.mjs`，
见 [testing.md](testing.md)。

