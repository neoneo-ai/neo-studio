# MCP 服务（外部智能体接入）

`studio/mcp_server.py` 是一个独立的 MCP 服务器（stdio 传输）。MCP 客户端（Claude Desktop / Cursor /
自建客户端）把它作为子进程启动，外部智能体由此调用 Neo Studio 的生图与导演（整片 / 单段 / 拼接）能力。

它不随 ComfyUI 启动，也不参与节点注册：零相对导入、只用标准库，一切能力经本机 ComfyUI 的 HTTP 接口完成。
`stdout` 只跑 JSON-RPC，日志一律走 `stderr`。

## 前提

1. ComfyUI 正在运行且已装 Neo Studio 插件（MCP 用的就是插件的 HTTP 接口，需 v1.2.0 及以上）。桌面端启动的
   ComfyUI 默认 `http://127.0.0.1:8188`（桌面端自身的服务在 8191，与 MCP 无关）。
2. Python 3.10+，用跑 ComfyUI 的那个 Python 即可，无额外依赖。
3. 用到 `generate_prompt` / `director_plan` 时，Neo Studio 设置里需已配置 LLM。

## 接入步骤

### 1. 自检（不连 ComfyUI）

```powershell
python studio\mcp_server.py --selftest
# Neo Studio MCP Server v1.3.0 · 21 工具：neo_status, list_skills, ...
```

### 2. 写进 MCP 客户端

`tools\mcp_setup.ps1` 打印下面两段配置；加 `-Write` 直接合并进 Claude Desktop 与 Cursor 的配置文件
（只增改 `neo-studio` 一项，其余条目保留）。

Claude Desktop（`%APPDATA%\Claude\claude_desktop_config.json`，改完重启 Claude）：

```json
{
  "mcpServers": {
    "neo-studio": {
      "command": "<ComfyUI 根目录>\\python\\python.exe",
      "args": ["<Neo-Studio 根目录>\\studio\\mcp_server.py"],
      "env": { "NEO_MCP_COMFY_URL": "http://127.0.0.1:8188" }
    }
  }
}
```

两个路径换成你机器上的实际路径；`tools\mcp_setup.ps1` 会按仓库当前位置打印填好的配置。

Cursor（项目根 `.cursor/mcp.json`，内容同上）。已有其他 MCP 服务时只加 `neo-studio` 这一项，别覆盖整个文件。

### 3. 在客户端里确认

对智能体说「列出 Neo Studio 的 MCP 工具」，能看到 `neo_status` 等 21 个工具说明接入成功；再让它调
`neo_status`，返回版本号与队列长度说明 ComfyUI 连上了。

## Studio 设置页的 MCP 服务（内置 MCP 客户端）

桌面端「设置 → MCP 服务」栏自带一个 MCP 客户端：注册表、连接 / 断开、工具调用都在这一栏，注册表文件是
`data/configs/mcp_servers.json`。右栏「智能体」的「✨ 生成」下面有「🔌 MCP」入口，点它直接跳到这一栏。工具卡的参数框默认填的是服务端给的示例参数
（`tools/list` 里的 `_meta.example`）：只读工具点开就能执行，带必填参数的工具只要把尖括号里的占位换成上一步返回的
id 就能跑通。
注册表文件不存在时，这一栏直接给出内置的 `neo-studio` 一项：`command` 用启动设置里的 Python，脚本用已安装
插件目录里的 `mcp_server.py`，`--comfy-url` 指向桌面端启动的 ComfyUI 端口，点「连接」即可，不用手填路径。
右栏「智能体」的「✨ 生成」是同一套口径的另一个客户端：`studio/agent.py` 在进程内逐行走 `mcp_server.serve`
的 JSON-RPC，工具表就是 MCP 全集（出片链路在内），面板不直接调 handler，见 [api-routes.md](api-routes.md)。
保存过一次注册表之后一切以文件内容为准——存了空清单就是空清单，删掉内置项不会再冒出来；文件存在但内容损坏
时按空清单处理，内置项不会覆盖用户写坏的 JSON。远程 ComfyUI 模式下没有内置项，这一栏提示去外部 MCP 客户端接入。

## 参数与环境变量

| 参数 | 环境变量 | 说明 |
|------|----------|------|
| `--comfy-url` | `NEO_MCP_COMFY_URL` | ComfyUI 地址，必须是本机回环（`127.0.0.1` / `localhost` / `::1`），非回环直接拒绝启动；默认 `http://127.0.0.1:8188` |
| `--tools` | `NEO_MCP_TOOLS` | 逗号分隔的工具白名单，留空启用全部 |
| `--image-base64` | `NEO_MCP_IMAGE_BASE64=1` | `get_media` 对图片默认附带 base64 字节 |
| `--timeout` | `NEO_MCP_TIMEOUT` | 普通请求超时秒数（默认 30） |
| `--selftest` | — | 打印启用工具后退出（不连 ComfyUI） |

例：只开放生图相关工具

```json
"env": {
  "NEO_MCP_COMFY_URL": "http://127.0.0.1:8188",
  "NEO_MCP_TOOLS": "neo_status,list_skills,generate_image,task_status,get_media"
}
```

## 工具

| 工具 | 说明 |
|------|------|
| `neo_status` | 版本 / 队列 / 导演配方数，先调它确认服务在线 |
| `list_skills` `list_models` | 生图技能 id、可选模型与建议值 |
| `generate_prompt` | 简短想法 → 成品提示词（走 LLM，需已配置模型） |
| `generate_image` | 提交生图，立即返回 `task_id` |
| `task_status` `list_tasks` `cancel_task` | 任务快照 / 列表 / 取消（五套任务表共用 `task_id`：生图 / 整片 / 单段 / 拼接 / 图片分镜） |
| `get_media` | 取产物文件：图片（png）与视频（mp4）都给 `/view` 地址；图片可 `base64=true` 回字节，视频与音频只给 URL |
| `list_gallery` `list_recipes` `load_recipe` | 素材库目录、配方清单、单配方元数据（`results` 是历史产物，含成片 mp4） |
| `director_recipes` `director_spec` | 导演配方清单、`shared` + 分段清单 |
| `director_plan` | 故事板规划：`plan` 主题/脚本 → 分段；`optimize` 单段按 H3 格式重写；`modify` 按指令改单段 |
| `director_keyframes` | 图片分镜：按段给配方出关键帧，落进配方 `assets/`；返回 `segments` / `shared` / `story`，原样喂回 `director_save` 才记进配方 |
| `director_copy` `director_save` | 复制配方（解锁预设只读）、写分段到 custom 配方（`story` 带主题 / 角色参考 / 分镜设置） |
| `director_run` `segment_run` `assemble_run` | 整片 / 单段 / 拼接，均立即返回 `task_id`，产物是 mp4 视频 |

## 典型流程

**生图闭环（产物 png）**

```
neo_status → list_skills(取 skill_id) → generate_image → task_status 轮询到 succeeded
→ get_media(取 png：给 URL，需要字节时 base64=true)
```

**导演闭环（产物 mp4 视频）**

```
director_recipes → director_spec(读分段) → director_plan(故事 → 分段，需 LLM)
→ director_copy → director_save(写进 custom 配方)
→ director_run → task_status 轮询（多段长任务）→ succeeded 后 filename / subfolder 是产物落盘位置、url 是播放链接
→ get_media(取 mp4 的 /view 地址，浏览器或播放器直接播)
→ 修片：segment_run(单段重生成) → assemble_run(拼回成片)
```

**文字故事板闭环（一句话或脚本 → 分段 → 关键帧 → 分段成片）**

```
director_plan(mode=plan, idea|script, segment_seconds[, characters])    → 分段（prompt / duration_sec / storyboard_prompt）
→ director_save(name, segments, story{idea|story, characters, segment_seconds, image_mode, image_skill})
→ director_keyframes(recipe[, segments, skill_id, mode, force])        → 关键帧落进配方 assets/（逐段串行跑图）
→ director_save(segments / shared / story 原样回传)                     → storyboard 记图名、非全参考段设首帧
→ segment_run / director_run → task_status 轮询 → get_media
```

这条链与导演页 📖 故事板分镜页是同一套后端。`director_keyframes` 返回的 `segments` / `shared` / `story`
必须原样喂回 `director_save` 才生效——保存是整份覆盖，漏带 `story` 会把主题与角色参考一起清掉。
非全参考段的关键帧直接设成首帧（i2v / fl2v 吃这张图），全参考（r2v）段进参考图池；只写 `storyboard`
时后端只把它当多帧分块锚点，段还是纯文生视频。

整片由 `SaveVideo` 落在 `output/NeoDirector/<配方名>/`，单段重生成落在 `output/neo_director_regen/`，
拼接成片落在 `output/neo_director_merge/`；`task_status` 的 succeeded 快照带 `filename`、`subfolder` 与
后端拼好的 `url`，`/view` 按 `video/mp4` 返回，可直接下载或播放；MCP 不回传视频字节。

**对智能体怎么说**（工具描述与 `initialize.instructions` 已写明约定，一般不用重复交代）

生图那句要跑得通，前提是本机存在带 `workflow.json` 的生图技能（`list_skills` 里 `has_workflow=true`）。

- 「用 Neo Studio 生成一张 1024×1024 的橘猫图，生成好把图给我」
- 「列出导演配方，读《红毯》的分段，把第 3 段重生成后拼回成片，给我成片地址」
- 「按这个故事脚本分 6 段做短片，跑完把成片文件名给我」

## 用法约定

- **异步任务**：`generate_image` `director_run` `segment_run` `assemble_run` 只返回 `task_id`，
  用 `task_status` 轮询到 `succeeded` 再取产物；整片是多段长任务，不要同步等待。
- **出片默认口径是一段 5 秒**：智能体出片默认只规划一段、5 秒、VDN 技能（`minimax_h3_vdn_*`，技能
  config 里 8 步）走 `segment_run`；多段整片要用户点名才跑。`director_plan` 的 `segment_seconds` 缺省 5，
  非 VDN 的 `minimax_h3_*` 是 20 步、慢一倍。
- **生图技能必须带模板**：`generate_image` 的 `skill_id` 必须是 `list_skills` 里 `has_workflow=true` 的技能。
  没有这种技能时先在前端技能管理里保存一个工作流模板；MCP 层不会替你挑，空 `skill_id` 在发出请求之前就报错。
- **带 `references` 的那一发是编辑那张图**：`skill_id` 要选收得了参考图的技能——`list_skills` 行里的 `mode` 是
  `edit / t2i_edit`（画布导入的技能没有 `mode` 时看 `requires_ref=true`）。`mode=t2i` 的模板没有参考图槽位，
  参考图挂上去会被静默丢掉，这一发在发出请求之前就报错点名要换的技能，与绘画页技能列表的过滤是同一份判法。
- **段序号一律 1 起**（第 1 段 = 时间轴第一段）。`segment_run` 的 `segment`、`assemble_run` 与
  `director_run.only_segments` 的列表都是 1 基，内部换算成端点的 0 基。
- **写操作只有两个**：配方元数据的写路是 `rs_recipes/save` 与 `rs_recipes/copy`。不暴露删除端点；读文件只经
  ComfyUI 的 `/view`，MCP 层不碰本地路径。内置预设配方只读，先 `director_copy` 再 `director_save`。
  `director_keyframes` 生成的关键帧按导演页同一条路径落进配方 `assets/`（只增不删），段级引用仍由
  `director_save` 写回。
- **LLM 依赖**：`generate_prompt` 与 `director_plan` 需要 Neo Studio 设置里已配置 LLM；未配置时返回
  指向设置的短错误，不返回假成功。

## 故障排查

| 现象 | 处理 |
|------|------|
| 客户端里看不到工具 | 检查 `command` 指向的 Python 与脚本路径；看客户端的 MCP 日志（服务器日志走 stderr） |
| 启动即退出 | ComfyUI 地址不是本机回环会被拒绝，改 `--comfy-url` |
| `neo_status` 报连不上 | ComfyUI 未启动或端口不对 |
| `generate_prompt` / `director_plan` 报错 | LLM 未配置或远程通道不健康，按返回的错误去 Neo Studio 设置里处理 |
| `task_status` 说任务不存在 | 任务结束后快照会被清理，产物名请在 `succeeded` 时立刻取走 |
| 分镜某段是 `skipped` | 该段没有分镜提示词（`storyboard_prompt`），后端回退视频提示词生图；补上分镜描述或重新 `director_plan` 拆分 |
| `director_keyframes` 很久才返回 | 关键帧逐段串行跑图，耗时随段数与分辨率走；超时会带着 `running` 与 `task_id` 返回，用 `task_status` 续查，别重复提交 |
| 右栏 / 📖 页看不到分镜图 | 关键帧生成完还要把返回的 `segments` 原样喂回 `director_save`：段级 `storyboard` / `first_frame` 是保存时写进配方的 |
| 返回被截断 | 文本上限 12000 字符；`list_skills` 用 `q` 过滤，`all=true` 会很长 |

## 局域网接入（不走 MCP）

MCP 这一层是 stdio + 本机回环，没有网络监听口，也不做跨机分发。局域网上的其它机器要用 Neo Studio 的能力，
直接走 ComfyUI 的 HTTP API：在「启动设置 → 局域网监听」填 `0.0.0.0` 或本机网卡 IP（见
[studio-desktop.md](studio-desktop.md) 的「局域网访问」），远端机器访问 `http://<本机 IP>:8188` 的
`/neo_studio/*`、`/rs_*`、`/neo_*` 与 `/view`。ComfyUI 没有鉴权，能连到端口的机器都能提交与读取任务，
只在信任的网段开，并在防火墙里限到需要的地址。

桌面端也可以反过来把窗口开在远端那台 ComfyUI 上（「启动设置 → 远程 ComfyUI」，见
[studio-desktop.md](studio-desktop.md) 的「远程 ComfyUI」）：远端要装好本插件并放开监听。MCP 这一层不参与，
仍是 stdio + 本机回环，`--comfy-url` 只认回环。

## 已知限制

- 单段提示词的逐段改写（`director_plan` 的 `optimize` / `modify`）一次一段，多段需逐次调用。
- `director_keyframes` 逐段串行跑图，与导演页同时点「生成分镜」会抢显存。
- base64 图片单次最多 4 张、单张 1.5MB 以内，超出只给 `/view` 地址；视频与音频不回传字节。
- 文本返回上限 12000 字符，超出截断。
- 宫格拆分、配音、配音字幕等前端编排能力未开放为工具。

## 自测

```powershell
# 协议与工具层单测（假 HTTP，不连 ComfyUI）
python -m pytest studio\tests\test_mcp_server.py -q

# 真机冒烟（需 ComfyUI 在跑）：生图闭环 + 导演读写 + 成片取件
python tests\mcp_smoke.py --director
```
