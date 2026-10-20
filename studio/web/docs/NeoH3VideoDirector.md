# Neo H3 Video Director

**节点键**：`NeoH3VideoDirector` · **显示名**：Neo H3 Video Director

## 用途
分镜视频导演：以 `video_director` 配方为参数逐段生成并拼接成单个含音频 VIDEO；
开启连续性时用跨段上下文窗口与身份继承保住段与段之间的人物与场景。

## 输入
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `recipe` | Combo | `video_director` 配方名：多段整片模式逐段生成的配方；接了 `bundle` 时忽略配方。 |
| `skill` | Combo | 仅 BUNDLE 单段模式用的视频 skill；配方多段模式忽略（各段自带 skill）。 |
| `bundle` | STRING | 可选。Neo Prompt Agent 的 BUNDLE：提供时走单段生成，提示词与参考来自 bundle。 |
| `seed` | INT | `-1` = 用配方 `shared.seed`（配方存 `-1` = 每次运行随机种子）；`≥0` = 本次整片覆盖该种子。 |
| `width` / `height` | INT | `-1` = 优先配方 shared 分辨率，缺省回退各段 skill config。 |
| `continuity` | BOOLEAN | 跨段连续性总开关：开 = 上下文窗口 + 身份继承。 |
| `context_frames` | INT | 取上段尾部多少帧做上下文。 |
| `steps` | INT | `-1` = 优先配方 `shared.steps`，缺省用各段 preset/config 的 steps。 |

节点内嵌只读时间轴：点击分段块打开配方编辑器；采样期间自动播放实时预览。
配方的「分镜时间线」页首行行尾的「高级参数」里保存整片运行参数（种子 / 步数 / 连续性 / 上下文帧，默认收起），Studio 生成面板只发配方名与勾选段。

## 输出
| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `video` | VIDEO | 整片拼接后的 VIDEO（含音频，24fps），接 SaveVideo / 预览；可接 Neo H3 Segment Run 的 `film`。 |

## 典型接法
- 顶部菜单 / 节点「＋」新建导演配方 → 选配方 → 运行 → `video → SaveVideo`。
- 配方「结果」区保存整片后，用 Neo H3 Segment Run 单段重生成。

## 常见问题
- 段与段之间人物变了：确认 `continuity` 为开。
- 分辨率与配方不一致：把 `width`/`height` 设回 `-1`。

## 整条流程
顶部菜单「新建导演配方」→ 导演台写分镜（可挂宫格自动拆分、逐格 LLM 描述）→ 选配方运行
→ 逐段生成并拼接 → `video` 接 SaveVideo；成片自动记进配方「结果」区，供单段重生成取锚点。

## 相关节点
- **Neo H3 Segment Run**：只重跑其中一段。
- **Neo H3 Add Context**：导演节点内部注入的跨段连续性实现。
- **新影工坊（Neo Studio）**：脱离画布的整片生成面板。

