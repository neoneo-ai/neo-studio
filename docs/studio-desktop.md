# 桌面端（Studio Desktop）

桌面端把 Studio 页面装进本地窗口：自己拉起 ComfyUI，并在 ComfyUI 端口 +3 起一个本机 Studio 服务
（`app/studio_server.py`，进程里没有 ComfyUI 运行时；文件读写类接口照常在它上面服务），ComfyUI 不在跑时页面
照样能浏览素材、编辑配方与技能。源码运行与打包 exe 走同一条 `app/studio_app.py`。

## 组成

| 文件                   | 职责                                                                                                                                                                                                                                   |
| ------                 | ------                                                                                                                                                                                                                                 |
| `app/studio_app.py`    | 窗口、自检、拉起 / 停止 ComfyUI、无边框窗口、关窗收尾、启动设置                                                                                                                                                                        |
| `app/studio_server.py` | 桌面端 aiohttp 服务（ComfyUI 端口 +3，`DESKTOP_PORT_OFFSET`），按目录加载插件模块挂在各自 `RouteTableDef` 上的 handler                                                                                                                 |
| `app/studio_caps.py`   | 能力表：哪些路由归桌面端自服、表外的哪一撮由桌面端转发给内核，其余一律 `409 offline`                                                                                                                                                   |
| `app/studio_pose.py`   | 姿势资产自动同步：「启动设置 → 姿势仓库」指向 3d-pose-art 仓库根时，把 dist 姿势包与 pose-lib 姿势库按时间戳对账补进数据根                                               |
| `data/`                | 状态目录：`studio_window.json`（几何）、`studio_profile`（Windows 的 WebView2 profile / localStorage）、`launcher_config.json`（root / python / port / frameless / dev_mode / listen / remote / pose_repo）、`studio_desktop.log`、`comfy_run.log` |

源码运行的状态目录是仓库根的 `data/`；Windows exe 优先 exe 旁的 `data/`，落在不可写目录时退回
`%APPDATA%\Neo Studio`；macOS v1 走远程模式时优先项目或用户目录旁的 `data/`，不可写时退回
`~/Library/Application Support/Neo Studio`。

## 离线门控

判定标准是「只做文件读写 / 本地检索 / 远程下载 / 打 8080 LLM 服务」；需要执行队列、显存、节点定义的归 ComfyUI。
功能开关表随 `/neo_studio/version` 下发，Studio 只门控运行类按钮（生成 / 跑段 / 拼接），配方编辑、技能编辑、
设置、LLM 配置都不需要 ComfyUI 运行时。顶栏队列面板在离线形态列任务中心的历史（`GET /neo_studio/tasks`，
`<数据根>/configs/studio_tasks.sqlite`），生成与取消按钮禁用、显存读数不建。路由清单见 [api-routes.md](api-routes.md)。

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

- 桌面端在 `/neo_studio/version` 里下发 `caps`（功能可用性表，`studio_caps.features(kernel_ready)`）与内核落点
  `kernel_ready` / `kernel_port` / `kernel_origin`。生成面随 `kernel_ready` 翻面；页面不判请求归属，也不留第二份清单。
- 表外的路径由同一层的 `studio_caps.forwardable()` 决定去留：清单内的由 `app/studio_server.py` 的 `proxy_forward`
  转给内核；清单外是桌面端没有这条接口，答 `404`。带 `offline` 的 `409` 只从「这条归内核、这一轮没有内核」的
  路径发出，走统一的「需要 ComfyUI」提示 —— 它是页面的离线信号，内核在跑时任何路径都不发它。桌面端口不是一台
  谁都能打的转发器，插件族按前缀收，ComfyUI 自己的路由逐族点名（队列面板的内存读数读内核的 `/system_stats`）。
- 转发是桌面端进程替页面发这一发：请求体与响应体都流式过手（出图与整片视频是分钟级响应、上传是几十 MB 的体，
  两份都不进内存），逐跳头与浏览器身份头（Origin / Referer / Sec-Fetch-*）剥掉、Host 改写成内核地址，ComfyUI 的
  origin_only 中间件因此照旧生效 —— 桌面端从不给 `--enable-cors-header`，浏览器直接打 ComfyUI 端口仍然 403，
  这道 CSRF 防线不在代理上让位。局域网监听（`--listen`）与远程模式同样不给 flag，页面同样钉在桌面端口上：
  那两路从前靠整页跳转，现在翻面与代理都一样。
- 内核那份版本快照与内核侧能力表走 `/neo_studio/kernel_version` 专用入口转手：两端都有同名的一条
  `/neo_studio/version`，桌面端这份必须自己答（页面靠它认桌面端的能力表与就绪形态）。
- `/ws` 由桌面端接力（`studio_ws`）：内核在跑时双向搬到内核的事件流，没在跑时接住挂着（不接的话离线页每 2 秒
  刷一次连接错误）；内核以 4000 断开「服务重启，请重连」时这个码原样交给页面，页面 2 秒后重连，桌面端每条连接
  现开一条上行，内核回来隧道跟着回来。
- 主画布那一发仍要去 ComfyUI 自己的页面：本机内核用「页面自己的主机名 + 内核端口」（局域网对端的主机名就是它
  那台机器看得到的本机地址），远程内核直接用启动设置里那台地址。桌面端口上没有画布页，代理也不代理画布。
- MCP 注册表与 stdio 会话只活在桌面端进程里，页面同源，`/neo_mcp/*` 就在桌面端口上；这一族从不回 CORS 头，
  外站（含 DNS 重绑到回环的）读不到它。
- 翻面一次做完，ComfyUI 答话之前整块不翻：能力表换成就绪的那份、门控按钮摘监听并还原文案、`body.ns-offline`
  离线标记摘掉、顶栏队列入口浮出并按六张表补种一次（面板并入任务中心的历史，进行中行的进度由实时表接管、完成与失败
  状态不回退；显存 / 内存读数条随之补建）、`/ws` 从桌面端的桩换到内核的
  真事件流。只解禁按钮不换事件流就是
  「任务交得出去、进度拿不回来」的半在线态。
- 翻面由 `ready` 驱动，不看是谁拉起内核：桌面端在就绪这同一份快照里才清掉 `starting`，拿 `starting` 当翻面条件时，
  桌面端自己拉起内核的冷启动永远翻不过来 —— 顶栏报「运行中」，页面钉在离线形态，生成请求全 `409`。
- 离线页不叠横幅：顶栏状态位报「● 已停止」并把入口指向「设置 → 启动设置」，生成入口按能力门控压暗，
  `body.ns-offline` 就是各模块认离线形态的那份标记。
- 停掉内核后页面翻回离线形态：代理目标清空、生成按钮重新门控、事件流换回桩，窗口导航不动；队列面板退回任务中心的
  历史，生成与取消钮禁用。

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
  按钮下面一排是最近三条导演配方，一行一条（**来源标签 + 段数 + 配方名**，取后端按修改时间排的前三条，没有导演配方就整排不出）。
  点一行 = 与点那张配方卡同一条路：该配方直接内嵌铺进左栏，右侧整片区跟着换成这一份，中间不开配方弹窗；关掉编辑器回到引导页时这一排重拉一次配方列表，刚保存的那份回到首位。
  点配方卡或「新建配方」重新打开编辑器，就回到左右分栏。
- **📋 配方** 开配方弹窗（`.ns-libmodal[data-lib-scope="recipes"]`，只列多段导演配方），**🖼 素材库** 开
  素材库弹窗（`data-lib-scope="assets"`，编辑页共用同一个实例）。导演编辑器里的 **🖼 素材库** 按钮是同一个入口
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

## 输入页 / 编辑页布局

输入页 = 整幅一块文生图面板，编辑页 = 整幅一块图片编辑面板，右上浮一枚 **🖼 素材库** 入口（绝对定位在预览区上，
不为它空出一行）。一次只铺满一块 —— 不像导演页那样编辑器与生成面板同屏分一块宽度。
素材库弹窗、滚动条与窄窗口规则全部与导演页共用同一套样式（同一个弹窗实例、同一份几何
`localStorage["neo_studio_libmodal_assets"]`）。

- 两块面板在 Studio 里是内嵌的（`setPaintHost` 注册宿主）：铺满整幅，不建浮层窗口，标题栏拖动与 ✕ 都不出现。
  主画布（ComfyUI 页面）没注册宿主，「🖼️ 生成素材」与「🖼️ 图片编辑」在那里仍是浮层弹窗。
- 素材页顶栏的「🖼️ 生成素材」与「🖼️ 新增图片配方」切到输入页，图片卡菜单的「🖼️ 图片编辑」切到编辑页。
  两页各自一块面板、各只管一件事：输入页出文生图，编辑页改图；没有一条「文生图 / 图片编辑」模式条，
  也没有图片配方列表。
- 首页「编辑」板块的直达卡（图片编辑 / 扩图 / 局部 / 删除 / 机位 / 融合 / 姿势）把这一发的模式带进编辑页那块现成面板（`openImageEditMode`
  经宿主的 `__neoSetMode`）：面板由编辑页进页铺好，点卡只换模式、不重建（重建会把用户写了一半的提示词清掉）。模式一进面板就切过去，
  没有原图也切，空态提示点名它；模式 chip 一直可点，**模式只由用户切**——`applySource` 换原图、`clearSource` 删原图都不碰它，
  删原图只拆铺在原图上的那一层（扩图框 / 涂抹层 / 标记点）。要在原图上动手的控件（扩图框 / 涂抹行 / 点选行 / 机位球与三条滑杆）没有原图时整块收着，
  机位的参考位与词框跟着模式当场收起，`applySource` 把原图落定才由 `setupModeLayer` 铺出来；空面板点预览区不开对比灯箱
  ——那口灯箱没有原图可看。
- 文生图面板是「一格提示词框 + 底行 chips（技能与自定参数 / 宽高比 / 最长边 … ⋯ 生成）」的输入卡，钉在面板底部
  （输入条样式参考 ArtCraft 的 promptbox）：框里写一句就生成，三枚 chips 是胶囊按钮 + 向上浮出的面板（原生下拉
  只当状态容器，不露在界面上；技能清单与主模型 / LoRA 在同一枚 chip 的双栏面板里），随机填入 / 提示词增强 /
  运行时随机 / 预设列表收在 `⋯` 菜单里。面板铺满栏高：生成中的进度与成品图在输入卡上方从顶部往下排，idle 只在结果区给一句起手提示
  （「写一句提示词，点生成」），不铺空画布（控件清单见 [gallery.md](gallery.md)「生成素材」与「图片编辑」）。
  铺满与钉底和窗口多矮无关：Windows 显示缩放把 800px 高的窗口报成 640 / 533 CSS px，输入卡照旧收在面板底边，
  矮出来的空间由结果区自己纵向滚，整页不整页滚 —— 输入卡不会飘在窗口中间、下面留一大片空。
  宽窗口里输入卡 980px 居中（gallery.css 给内嵌弹窗的 `width: min(92vw,980px)` 在宽窗口顶到这一档，窗口窄下来跟着收），
  提示词框两行 64px 起、上限 26vh，要写更多拖框底边拉高；视频页 composer 胶囊吃同一档宽（980px 居中），
  提示词框同一档高，且不再被旁边的首帧 / 尾帧 / 参考图方块顶高。
- 编辑页输入卡同样钉底，图片编辑区吃满输入卡上方的余隙：原图放大铺满这块余隙（`object-fit: contain` 居中、不裁切，
  连同删除遮罩与标记点一起收，遮罩不会盖到卡外面），空预览正中是一块固定大小的「＋ 原图」方块（点选开素材库、悬停出
  上传菜单，见 [gallery.md](gallery.md)「图片编辑」）。编辑页页边上下与输入卡内衬各收一截，省下的余隙全给预览；
  绘画页页边与输入卡照旧 —— 两页样式各挂各的宿主类（`.ns-paint-edit` / `.ns-paint-text`），改一边不动另一边。
  提示词框只两行高（40px 起，机位模式整框收起），
  出图宽/高输入排在 chip 行**上方**——钉底的卡里向上浮出的浮层排在底行会被页面底边截断。
  「原图 / 编辑结果」标签行与「看大图」按钮在 Studio 里不出现：原图直接点开大图，画笔 / 标记模式下点图是画与标记。

- 已在输入页 / 编辑页时点弹窗里的「生成素材」或图片卡菜单的「图片编辑」：面板铺好后弹窗自己关掉 ——
  同页 `go()` 不触发 `showView()` 的切页收起，否则弹窗盖在面板上。跳页只由顶层 `paintArmed` / `editArmed`
  放行：面板建完才置位，启动与空画布自种 storyboard 时的那一发不会把页面从首页 / 设置页深链拽走。
- 素材库弹窗里的画廊与素材页、导演页是同一个元素：`media-transfer` 写入只开当前页的弹窗，切走本页自动关闭。
  离开素材页时把 `sidebarTab.activeSidebarTabId` 归位 —— 素材页挂载画廊会把它写成
  `neo.gallery`，不归位的话本页「素材库」按钮再写同一个 id 会被去重吃掉，弹窗打不开。
  弹窗的取用落点由谁开窗决定：悬浮「🖼 素材库」点卡片 = 填进图片编辑的原图预览并关窗；参考图菜单的
  「🖼 素材库取用」点卡片 = 追加进参考位、原图不动。底部 **📥 已选 N 项** 收齐多张后一次铺到同一个落点。
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
- 引导页态不显示「🗂 技能管理」标题条（引导页自己就是页名，顶栏不给技能页留页签位）；列表态才露出，标题写「技能列表」并带返回引导页的入口。
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
- 「设置 → 启动设置」顶栏的启停行带第三枚「打开 ComfyUI」：内核就绪后出现，点了把这一路的地址交系统默认浏览器
  （无边框窗口里没有新标签可开，走 js_api 的 `open_url`，窗口自己不动）。地址取 `comfy_state` 报的那一份——本机端口
  被占用时桌面端换到下一个空闲端口，启动设置里那个端口不一定在听；远程模式开的是启动设置里那台远端地址。端口上没人
  在听（已停止 / 启动中）时这枚不上页面：打开一台打不开的 ComfyUI 只是给浏览器一张报错页。

## 引导页（首次设置）

根目录推不出、或同级与内部都找不到 `python.exe` 时，窗口开在引导页（`guide_html`，`load_html` + js_api）：那时
`build_app` 连 `folder_paths` 都 import 不了，桌面端服务本来就起不来，页面只能不依赖 HTTP 服务。校验与拉起全走
js_api（`check_setup` / `pick_root` / `pick_python` / `start_setup`），根目录补完了服务才起得来。

## 无边框窗口与拖动

- 无边框是启动设置里的一项，存 `launcher_config.json` 的 `frameless`：Windows 缺省开，macOS v1 缺省关并
  用原生标题栏；macOS 的窗口控件由原生标题栏承担，设置页不展示无边框开关。Windows 下建窗时喂
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

## 首页版式（首页原地编辑）

- 外壳页的滚动条收在页容器一处：`.ns-page` 定 `scrollbar-width: thin` + `scrollbar-color: transparent transparent`，
  `:hover` 才落 `#555`（`::-webkit-scrollbar` 同宽 8px、槽透明），与素材库 / 配方弹窗滚动条同一套——首页 / 素材页 /
  导演页可见的那根条都是这一层（画廊宿主 `height: 100%` 不滚，导演页 `.ns-director` 的 `min-height` / `min-width`
  在矮窗窄窗也是这一层出滚）。`scrollbar-width` 与 `scrollbar-color` 是继承属性，画廊的 Civitai 栏、技能与自定参数
  面板、归类列表与导演编辑器面板这些自滚容器跟着收，不逐容器补规则；时间轴放大态 `.neo-dtl-scroll.neo-dtl-zoomed`
  那条可见横条是刻意的拖动把手，自身声明压过继承。首页另定 `scrollbar-gutter: stable` 钉住槽位——进编辑态多出那条
  细栏、卡片显隐改掉页高时溢出开关随之起落，居中内容列不左右跳。
- 浏览态的首页右上角「编辑首页」（`.ns-home-edit-entry`，`position: absolute` 站在 `.ns-home` 自己的右上角，跟着页面一起滚，滚出首屏就不见，不常驻在窗口上压住卡片）把这一页切进编辑态，这一页自己就是编辑器：整张卡就是拖动手势
  （不设手柄与 ↑↓ 箭头），卡片右上角的控件条只一枚显隐眼睛（自建卡多一枚「编辑这张卡」的铅笔与一枚删除），标题区五行文案点字直接改（`contenteditable`，失焦落进草稿），顶端一条细栏
  （`.ns-home-edit-bar`，`position: sticky` + `width: fit-content` + `margin: 0 0 14px auto`）整块收成一条小组、贴在首页右上角，管网格列数、标题区与出图按钮开关、恢复默认；那一枚「完成」就是入口本身，坐在栏里这一行的末尾，栏钉在哪一屏它就跟着钉在哪一屏，滚到哪一屏都点得着。板块不给控件：板块顺序与整块收起是旧版式里读到的状态，这一版不在首页上排它们。
- 编辑吃的是本地草稿：每一次改动经 `host.onDraft` 交回 `renderHome()` 实时重画这一页，全程不发请求。编辑态的卡面打断点击（`.ns-home-editing .ns-home-card` 定 `cursor: default`、
  内层 `pointer-events: none`，`homeCard` / hero CTA 的 onclick 也认这个态），跳屏带不走未保存的草稿。
- 编辑态这一页铺全：隐藏的卡以幽灵位（`.ns-home-card.is-hidden-card`）留在网格原位，眼睛一点就排回来；旧版式里收起的板块连卡一起铺回来并标暗（`.ns-home-section.is-off` 加「已收起」角标）；
  网格末尾一张「添加卡片」占位卡（`.ns-home-add-tile`）开一张自建卡的编辑弹窗（`.ns-home-card-dialog`，借素材库弹窗那套遮罩与盒子），字段排三行：跳转类型 + 跳转目标、标题 + 副标题、图标 + 板块，
  图标那一格横跨两列，铺的是图标本身（`.ns-home-f-icons` 里一格一枚 `.ns-home-icon-swatch`，34px 一格排满换行，选中的那枚描边点亮，图标名只在 tooltip 上——下拉里排 `pencil` / `maximize` 这类标识没人认得出来），旧版式里存的图标不在候选里时铺在格子最前并照旧选着；
  换了跳转类型或目标，没动过的格子就按那一发填好（内置卡表同一条目的标题 / 副标题 / 图标 / 板块，配方与技能用名字，外部链接用域名），打过字的那一格不覆盖；
  已有自建卡的铅笔开同一个弹窗并带着现值进来——弹窗的「保存」才把这张卡写进草稿，「取消」与 Esc 丢掉这一次，页面上不存在「这一块的开关不在这页上」。
- 自建卡的跳转类型只有编辑模式 / 导演配方 / 技能 / 外部链接四种：编辑模式给全编辑页那一发的 7 个模式（与面板的模式 chip 同源同序），配方与技能的目标留「不指定」就是只进导演页 / 只进技能页。旧版式里存的直连卡（`target: "page"`）照读照跳，铅笔开弹窗时这一项只在这张卡已经用它时出现，新卡配不出这一项；后端 `CUSTOM_TARGETS` 里留着 `page` 只为这一张旧卡读得回来。
- 技能卡的落点是技能应用的那一页：`openHomeCard` 拿 `listVideoSkills()` 认这张技能，生视频技能走 `openVideoReuse({ skill })` 进出视频页并把技能选中（视频页还没建过时由应用层启动时注册的 `setVideoPageJump` 先把页建起来再交这一发；画布页没有这层应用层，才说一句「出视频页尚未就绪」）；生图技能进输入页，由 `paintTextHost.__neoSetPrompt({ skill })` 选中它；两页的技能下拉都没有位置的技能（增强类 / 模板类）在界面上说清楚没有可直达的应用页，再落技能页。
- 落位手势是 vendored 的 SortableJS（`studio/web/vendor/sortable.min.js`，1.15.7，MIT，`home-layout.js` 里 `import "../vendor/sortable.min.js"` 引进来，与 marked/purify 同一份路子（三个第三方库都在 `studio/web/vendor/`），运行时不联网）：`decorateGrid` 给编辑态每条网格建一个实例——`group: "ns-home"` 让三条网格互相接得住卡，`draggable: ".ns-home-card"` 只认卡（「添加卡片」占位与板块不参与），`ignore` 让卡上的按钮不算拖起点，`animation: 150` 就是其余卡让位的滑行；`forceFallback: true` 加 `fallbackOnBody: true` 意味着指针上那张卡是 Sortable 克隆出来钉在 `body` 上的影子卡（`.sortable-fallback`，吃 `.ns-home-card.is-dragging` 这一条），原位的卡带着 `.sortable-chosen` 留在格子里——forceFallback 下 Sortable 不应用 `ghostClass`，传它就是不生效的选项，这里只传 `dragClass`。整张卡就是手势，卡本身不再挂原生 `draggable`（两套手势不能同时开），触摸端的拖动同样由它接住。
  落位只读 `onEnd` 交出来的 `oldDraggableIndex` / `newDraggableIndex`（落下去自己是第几格，末尾就是排到最后）：同板块走 `moveCard`，自建卡跨板块把 `custom[].section` 改过去并插进那一格，内置卡落进别的板块就 `cancel()` 退回原位、细栏写一句「内置卡只能在本板块内排序，自建卡能搬去别的板块」，不让人试。
  重画一次首页就换一批网格元素：`renderHome` 在网格挂上文档之后才交 `decorateGrid`——实例建在脱离文档的网格上只认得「拖起来」，认不出落点（真浏览器实测：`dragStarted` / `emulateDragOver` / `onDragOver` 都跑，就是不换行），这一轮没挂载的网格不建实例，交给下一轮装饰。上一轮那批实例由 `render()` 在递增轮次（`gridEpoch`）时收掉——那一刻旧网格还挂在文档里（首页要等 `onDraft` 之后才 `replaceChildren`），而 Sortable 的实例绑在 `document` 上的那批事件（`dragover` / `drop` / `keydown` / `visibilitychange`）不跟着网格走，等旧网格被摘掉再收就漏在页上；离屏的实例放手不管（Sortable 的 `destroy()` 要写 `el.parentNode`，离屏元素上直接抛）。同一轮里同一条网格被重复装饰时先收掉旧实例，不留两套手势。
- 编辑态的入口就是「完成」，它坐在收成右上角小组的那条细栏末尾：它发一次 `POST /neo_home/layout` 并广播 `neo:home-layout`，首页按落盘回来的形状重画、退出编辑态，界面上给一句已保存的提示；保存落回来时把 `hidden_sections`
  写成空表——旧版式里的整块收起随这一次落盘展开。「恢复默认」发 `POST /neo_home/layout/reset` 删掉版式文件，同样只广播一次并给出提示。
- Esc 与切到别的页（`route()` 里落点不是 home 时 `stopHomeEdit()`）是弃草稿退出：首页落回已落盘的版式，不发请求、不写文件。「完成」的 POST 没成时留在编辑态，页面上这份草稿原样留着，
  入口回到可点的。「完成」在飞的这一次入口禁用（`homeSaving`），连点不成两次请求。版式不落 localStorage——插件页、桌面窗口与手机页共用数据根里那一份 `configs/home_layout.json`。
- 卡表、版式形状与编辑器的装饰钩子（`decorateHero` / `decorateCard` / `decorateGrid` / `addTile`）只在 `studio/web/studio/home-layout.js` 一份，`studio-app.js`
  只管建 DOM 并把建好的 hero 与卡片交给钩子、把细栏右端那枚「完成」接到编辑器的 `save()` 上；「跳到哪一屏」是卡上的 target / value 这份数据，由 `studio-app.js` 的 `openHomeCard` 落地。设置页不再单列「首页」栏。
  用例：`studio/tests/js/home-layout.test.mjs`、`studio/tests/test_home_layout.py`、`app/tests/test_studio_server.py` 的版式用例。
- 「开始创作」的「声音克隆」与「编辑」的「图片反推」是两张 `target: "page"` 的直连卡（`value: "voice"` / `"reverse"`），
  落进 `route()` 的两条分支，挂出 `#/voice` 与 `#/reverse` 两页（`studio/web/voice-clone/voice-clone.js`、
  `studio/web/reverse-prompt/reverse-prompt.js`）：顶栏那七枚页签不给它们位置，首页把卡收起，这一页就进不去；
  两页与其余页同一条「视图常驻、切页显隐」的路由。两页的运行钮交 `RUN_GATES`（`voice` / `prompt_reverse`），
  离线形态点它是拉起内核，不是发一条注定 409 的请求。
  用例：`studio/tests/js/studio-home-pages.test.mjs`、`studio/tests/js/reverse-prompt.test.mjs`、
  `studio/tests/js/voice-clone.test.mjs`。

## 设置页分组

- 设置页左栏十项自上而下按 `启动与连接`（启动设置 / 启动日志 / 手机连接）· `生成`（LLM 设置 / 生图设置 / 生视频设置）·
  `智能体`（智能体偏好 / MCP 服务）· `语言与关于`（界面语言 / 关于）四段排下来，段与段之间只有一条无文字的分割线
  `.ns-settings-sep`（与 tab 平级挂在 `.ns-settings-tabs` 里，线里不写字，界面上的行数就等于设定项的数目）。
  tab 的 `data-key` 与深链 `#/settings?tab=..` 全不变；摘掉一枚 tab 时线跟着剩下的内容走，浏览器标签页没有启动设置面板
  就只摘那一枚 tab，条首不悬一条多余的线。「首页」栏随首页原地编辑一起摘掉之后，旧书签里的 `?tab=home` 由
  `showSection` 落回默认栏（LLM 设置），设置页不会因为认不出的 tab 名开成一片空白。
- 栏内长表单的小标题分区不变：启动设置分 `ComfyUI 位置`（根目录 / 解释器）、`网络与端口`（端口 / 局域网监听 / 远程 ComfyUI）、
  `桌面窗口`（无边框窗口 / 开发模式），启停与状态行始终在面板顶部；LLM 设置分 `服务商与模型` / `远程连接`（API Key 与
  自定义端点）/ `本地模型`（模型目录与两个自动卸载），后两组连小标题一起随整组显隐收起，切到本地 GGUF 时不空挂在没内容的
  组上（`.rs-form-group`）；生图设置分 `模型`（生图模型 / Text Encoder / VAE）与 `输出`（目标像素数 / 输出前缀）。
- 顶栏 🅝 设置弹窗左栏是同一套顺序：`生成` 三项（LLM 设置 / 生图默认设置 / 生视频模型）在前，`界面语言` 在后，中间一条
  `.neo-settings-sep`。
- 段名不是界面文案，只落成分割线；tab 名与栏内小标题是 `studio/web/js/core/i18n.js` 的中文原文 key，
  共享表单（LLM / 生图 / 生视频）保持中文原文。

## 启动设置的 ⓘ 说明

- 「启动设置」每一行标签旁有一个 ⓘ，悬停（键盘 Tab 聚焦同样出）给出这一行的前提条件与生效方式：根目录 /
  解释器 / 端口 / 局域网监听 / 远程 ComfyUI 走「保存并重启 ComfyUI」，无边框窗口立刻生效并写进配置，
  开发模式要重启桌面端窗口，姿势仓库保存即生效并立刻在后台起一轮同步。文案在 `studio/web/studio/studio-app.js` 的 `TIPS` 里。

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
- 局域网监听放开时桌面端服务把自己也绑到选中的网卡上（`lan_bind_hosts`：填 `0.0.0.0` 时只绑全监听，同一端口上
  重复绑回环会撞）——Studio 页与配对页只活在桌面端端口上，只绑 127.0.0.1 的话手机连不到那个口。非回环对端由
  `lan_surface` 中间件按对端地址收口：私段上的设备把这台机器当另一块屏幕用，页面、素材库、姿势页、配方、技能
  这些数据路由照开（只放一张配对页的话，手机上的素材库是空的、姿势页报「后端未就绪」）。`lan_path_open` 挡的是
  桌面管理那一面——`/neo_mcp*`、`/neo_studio/launcher`、重启 / 关机 / 日志 / 显存、`/neo-studio/settings`、出码用的
  `pair/info` 与桥上的对应口——和 `/userdata/configs/`（`remote_llm_config.json` / `backyard_oss.json` /
  `model_hub.json` 都在这底下）；公网与链路本地对端全关。监听没放开时桌面端服务只绑回环。
- 手机 / 平板浏览器直连 `http://<局域网 IP>:<端口>/neo-studio` 走的是同一条路，版式由两档媒体查询自己收：
  `max-width: 720px` 收版式（八页全单列，页内不出横向滚动），`(hover: none) and (pointer: coarse)` 收触摸行为
  （44px 触摸目标、输入框 16px、平时靠悬停显形的控件在触摸设备上常驻）。两档都只在窄屏 / 触摸档生效，
  桌面端窗口与 ComfyUI 侧栏一条都不吃。
- 顶栏右端是队列与设置两枚图标位（队列在前，徽标是图标右上角那枚计数），页签只有六枚：窄屏里这六枚是一条可横滚的页签条，
  选中那枚由 `studio-app.js` 的 `showView` 用
  `scrollIntoView` 带进可视区；刘海与圆角走 `viewport-fit=cover` + `env(safe-area-inset-*)`，
  钉在页底的「生成」与视频页 composer 胶囊不被手势条压住。姿势页只收外壳的三栏（姿势库 / 画布 /
  控制面板上下堆叠），iframe 内的 3D 控件不动。

## 手机配对（扫码进 Studio）

- 「设置 → 手机连接」在局域网监听放开时给出二维码与配对链接：链接形如
  `http://<局域网 IP>:<端口>/neo-studio/pair?token=<一次性令牌>`，手机扫码即在浏览器里验证令牌，成功后给出
  `http://<局域网 IP>:<端口>/neo-studio` 入口。手机侧不安装任何东西，走的就是上一节的局域网直连。
- 令牌由桌面端生成，落盘在 `launcher_config.json` 的 `pair_token` / `pair_expires_at` / `pair_host`，5 分钟过期；
  面板上的倒计时到零自动换码，「立即刷新」按钮换新码，落盘只带这三个字段，不碰启动项。
- 面板取数据有两条通道，语义同一份：桌面窗口里优先走 pywebview 桥的 `pair_info` / `pair_rotate`（桥注入晚于页面
  脚本，整页刷新后靠它补上），页面里走 `GET /neo-studio/pair/info` 与 `pair_rotate` 动作 —— 页面钉在桌面端端口上，
  配对那三条路由就在同一个 origin 上。桥与桌面端服务共用同一份 `launcher` 与同一份落盘入口（`app/studio_app.py`），
  两条通道出的是同一个地址、同一张码。
- 二维码由 `studio/web/js/core/qrcode-lite.js` 现场生成（QR Model 2 字节模式 + 纠错 L + 八种掩码选优 + 版本自适应），
  以 inline SVG 上屏，不引第三方库。
- 三条路由 `/neo-studio/pair`、`/neo-studio/pair/check`、`/neo-studio/pair/info` 由桌面端服务自己注册
  （`app/mobile_pair.py` + `app/studio_server.py`），归属表在 `app/studio_caps.py`。配对页与 `pair/check` 只答局域网
  Host：回环、`localhost` 与公网 Host 一律 403。出码地址由 `pair.pick_lan_host` 挑：「局域网监听」选中的网卡 →
  上次扫过、现在还是实体网卡的那个地址 → 排好序的第一块实体网卡。排序在 `private_addrs()`：按 192.168 → 10 →
  172.16/12 档位排，名字带 `vEthernet` / `Hyper-WSL` / `Loopback` 字样的虚拟网卡压到最后，169.254 链路本地与公网
  地址不出码（Hyper-WSL 的 `172.24.80.1` 在主机名解析里经常排第一，照它出码就是一张扫开连不上的码）。挑中的地址
  落盘成 `pair_host`。桥这条通道没有 Host 头可认，出码认的是落盘的 `pair_host`；`pair/info` 这条按请求的 Host
  认对端。三条回复都带 `Cache-Control: no-store`，配对页对令牌只回「有效 / 无效」两种状态，不区分过期与令牌不符。
- 局域网监听没放开时这一栏不摆码，直接说明去「启动设置 → 局域网监听」放开——不摆只会失败的控件：链接框、复制与刷新按钮
  一并收起，只有「靠刷新出码」那一状态留着刷新按钮。
- 测试：`app/tests/test_mobile_pair.py`（令牌生命周期 / 局域网前缀 / Host 门 / 落盘合并 / 桥那份快照 / 出码选卡排序）、
  `app/tests/test_studio_server.py` 的 `MobilePairServiceTests`（三条路由的 Host 门与令牌校验）与 `LanSurfaceTests`
  （绑上网卡后的对端收口）、`app/tests/test_studio_desktop.py` 的 `lan_bind_hosts`（监听放开时桌面端服务绑哪些地址）、
  `studio/tests/js/qrcode-lite.test.mjs`（自带解码器往返 + 标准几何）、
  `studio/tests/js/pair-access.test.mjs`（面板出码 / 复制 / 刷新 / 切走停轮询）。

## 远程 ComfyUI

- 「启动设置 → 远程 ComfyUI」填 `http://主机[:端口]`（`https` 同样收；path / query / 锚点 / 凭据不收），存
  `launcher_config.json` 的 `remote`。非空时窗口直接开在 `http://<远端>/neo-studio`，探活与就绪跳转都打在远端上
  （`probe` 收的是目标 base，本机模式是 `http://127.0.0.1:端口`）；留空 = 连本机，也是默认。
- 远程模式下本机不拉进程：`port_busy`、`free_comfy_port`、`start_comfy`、`port_owner`、`kill_pid` 全不参与。
  「启动内核」变成重连远端，「停止内核」禁用 —— 远端进程由远端那台机器自己起停。
- macOS v1 只走远程模式：`python app/studio_app.py --remote <http://主机:端口>` 或配置里的
  `remote` 都指向远端；本机启动项（根目录 / 解释器 / 端口 / 局域网监听）保持灰掉。桌面端状态快照会带上
  `remote_ok` / `remote_down`，顶栏显示「远程就绪 / 远程不可达」。远程不可达时窗口停在远程引导页，只让人
  重新填远程地址并重连，不会启动本机 ComfyUI，也不会开本机离线桌面服务。
- macOS remote-only `.app` 用 `bash tools/build_studio_mac.sh` 打包，产物在 `tools/Neo-Studio.app`；启动用
  `open tools/Neo-Studio.app --args --remote <http://主机:端口>`，也可以从 Finder 双击。本地产物是未签名
  ad-hoc 构建，首次运行可能遇到 Gatekeeper 提示。
- macOS 单实例锁使用 `data/.studio.lock` 的 `flock`，远程告警改用 `osascript`，解释器选择器收
  `.app` / `.command` 而不是 `python.exe`；远程模式的数据读写都交给远端那台机器。
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

## 姿势资产自动同步

- 「启动设置 → 姿势仓库」是单独一行，存 `launcher_config.json` 的 `pose_repo`。校验在 `app/studio_pose.py`：
  带 `pose-lib/` 容器加 `package.json` 的目录才算姿势仓库根，校验不过保留已存的那一份；保存这一行不等
  「保存并重启 ComfyUI」，落盘的同一轮就在后台起一次同步。仓库解析按三档找：配置里的 `pose_repo` →
  环境变量 `NEO_POSE_REPO` → ComfyUI 根同级的 `3d-pose-art`；留空 = 不自动同步。
- 启动序列在桌面端服务起后由后台守护线程跑一轮同步（`app/studio_pose.py` 的 `auto_sync`），
  `studio_desktop.log` 落一行 `pose auto-sync` 报 dist / lib / index 三项计数与耗时，解析不到仓库整步不打日志。
  姿势页与姿势库逐请求读数据根，资产落进数据根不需要重启窗口。
- 判据与 `tools\sync_pose_dist.ps1` / `tools\sync_pose_lib.ps1` 同口径：只在「源比数据根新」时动手
  （重复启动、没构建过的仓库跑不出文件复制），手动删过的文件下一轮原样补回。dist 走 robocopy 镜像；
  pose-lib 镜像本地集、预设集只补空，预览按默认档落地、清掉 `*depth.png` 残留，合并索引走姿势仓库自己的
  `node scripts\poseLib.mjs merged --out` —— 索引缺失、清单引用的预览文件没落地、条目全都没有 `charKey`
  （姿势库弹窗的基座筛选没有落点）任一条都重建一次。`pose/dist/models/` 里源构建没有的 GLB 先存后还，
  `pose/scenes/` 不在镜像范围内。

## 静态资源与缓存

桌面端 `/extensions/` 静态响应带 `no-store`（与 ComfyUI 的 `/extensions` 一致），并在开窗口前清掉
`data/studio_profile/EBWebView/Default/Cache`：缓存里的旧插件 JS 会被直接端出来用（不发请求），和新模块拼进同一张
ES 模块图后，链接错误发生在 `studio-app.js` 执行之前、JS 捕获不到，整页只剩顶栏 —— 视图不挂、
顶栏状态位永远 `hidden`。

## 日志

- `data/studio_desktop.log`：启动 / 跳转 / 关窗 / 拖动步数（`drag N steps`，0 = 按下没走出拖动阈值或左键已经不
  在），以及页面上报的
  前端未捕获错误（`[web]` 前缀，页面走 js_api 的 `log()`），只留尾部 200KB。
- `data/comfy_run.log`：桌面端拉起 ComfyUI 的完整 stdout / stderr（端口冲突与导入报错都在里面）。
- Studio「设置 → 启动日志」把这两份拼在同一块面板里（桌面端自服的 `GET /neo_studio/log`，条目带 `src`）：内核那块
  在前、桌面端那块在后，页面上的来源筛选按 `src` 整块显隐。拖动步数行不进面板——一次拖动落一行，会把启动轨迹顶出
  尾部——文件里原样留着。浏览器标签页里没有桌面端那一路，面板只有内核那一块，块标题与「桌面端」筛选钮都不上页面。

## 相关测试

设置页的分组层级在 `studio-settings-groups.test.mjs`，启动日志的来源分块与筛选在 `studio-log-panel.test.mjs`，
启动设置顶栏的一键打开 ComfyUI 在 `studio-kernel-open.test.mjs`，姿势资产自动同步的同步判据与镜像口径在
`app/tests/test_studio_pose.py`，启动设置栏内的行与 ⓘ 在 `studio-desktop.test.mjs`，
`app/tests/test_studio_desktop.py`、`app/tests/test_studio_server.py` 与 `studio-app.e2e.mjs`，
窄屏与触摸档的版式不变量在 `studio-mobile-layout.e2e.mjs`（390×844 与 1440×900 两个视口），
见 [testing.md](testing.md)。

