// 画布上的节点类型注册表：每一类节点在这张页面上长什么样、跑起来说什么话，全在这张静态表里一份。
// 新增一类节点只要动这五处：这张表加一行、gen.js 加一条请求构造、style.css 加一段卡面、docs/canvas.md
// 与 docs/en/canvas.md 各加一行、canvas 用例加一段 —— 卡面分支、附加栏、闸门、运行文案、加节点菜单、
// 手势层认的那一片控件全从这张表读，不再各写一份。
// 表里没有运行期注册，也不持有页面状态：它是纯数据，只放类型自己的取值。节点运行态在 gen.js（running /
// llmRuns / chains），画布 state 在 page.js。
// 表里的 type 就是画布落盘 JSON 与 studio/canvas.py 里那一个字符串（canvas._KNOWN_TYPES 与它同口径），
// 不进 ComfyUI 的 NODE_CLASS_MAPPINGS：画布节点是这一页自己的东西，内核不认识它。
import { t } from "../../../js/core/i18n.js";

/** @typedef {"image" | "text" | "gen" | "video" | "video_in" | "audio_in" | "recipe" | "edit" | "enhance" | "reverse"} CanvasNodeType */

/** 视频档的生成节点（出片卡）的名字：菜单「加视频生成节点」与「添加配方」铺的车尾共用这一份（见 page.js 的 ADD_SEEDS 与 layTrain） */
export const VIDEO_GEN_TITLE = "视频生成";

/** 每一类节点一行：title / w / h 是建节点与读盘兜底的默认框；css 是卡面类名（空 = 这一类没有独立卡面框，
 *  走 .ns-canvas-gen 那一套）；body 是卡面内容走哪一个渲染器；bar 是附加操作栏多出来的那枚；
 *  run 是 RUN_LABELS 里那一发说的话（这一发要的能力位与缺了说什么话都在那一行里）；add 是「加节点」菜单那一行；
 *  doc 是这一类在 docs/canvas.md 与 docs/en/canvas.md 节点表里的那几行名字（两份都要有，缺一边的用例就红）。
 *  手势层认的控件面不在这里：那是共享的一份清单，按类型拆会让卡面几乎按不到（见 interactions.js） */
export const NODE_TYPES = {
    // 默认框是竖友好那一档（340×360）：节点按素材自己的比例落位且永不超出默认框（store.js 的 fitImageSize），
    // 框是横的那一档时 9:16 的竖图只能落到 135×240 —— 竖屏素材永远比横屏小一圈，素材页拖进来就是这一发
    image: { title: "图片", w: 340, h: 360, css: "ns-canvas-node-image", body: "image", bar: "hero",
        doc: { zh: ["图片节点"], en: ["Image node"] },
        add: { label: "加图片", icon: "image", act: "material" } },
    text: { title: "提示词", w: 340, h: 240, css: "ns-canvas-node-text", body: "text", bar: "prompt",
        doc: { zh: ["提示词节点"], en: ["Prompt node"] },
        add: { label: "加提示词", icon: "list" } },
    gen: { title: "图像生成", w: 320, h: 208, css: "ns-canvas-node-gen", body: "gen", run: "image",
        doc: { zh: ["图像生成节点", "视频生成节点"], en: ["Image-gen node", "Video-gen node"] },
        add: { label: "加图像生成节点", icon: "sparkles", prime: "prime", seed: "skill" } },
    // 图像编辑节点：图与提示词都从连过来的节点取，这一张只管选技能与出图 —— 卡面与图像生成节点同一档（接法见 gen.js 的 runEdit）
    edit: { title: "图像编辑", w: 320, h: 208, css: "", body: "edit", run: "edit",
        doc: { zh: ["图像编辑节点"], en: ["Image-edit node"] },
        add: { label: "加图像编辑节点", icon: "pencil", prime: "prime", seed: "editSkill" } },
    // 文本增强节点：要重写的正文从连过来的提示词节点取，成文写进下游空的提示词节点（见 gen.js 的 runEnhance）
    enhance: { title: "文本增强", w: 320, h: 168, css: "", body: "llm", run: "enhance",
        doc: { zh: ["文本增强节点"], en: ["Text-enhance node"] },
        add: { label: "加文本增强节点", icon: "refresh", prime: "prime", defaults: { skill_id: "" } } },
    // 图片反推节点：要反推的那一张从连过来的图片节点取，成文同样写进下游空的提示词节点（见 gen.js 的 runReverse）
    reverse: { title: "图片反推", w: 320, h: 168, css: "", body: "llm", run: "reverse",
        doc: { zh: ["图片反推节点"], en: ["Image-to-prompt node"] },
        add: { label: "加图片反推节点", icon: "camera", defaults: { language: "zh" } } },
    // 这一行落的是图像生成节点那一类的视频档（metadata.kind = "video"，见 gen.js 的 runVideo）；表里 type = "video" 那一类是成片的落点，菜单里没有它
    video: { title: "视频", w: 340, h: 240, css: "ns-canvas-node-video", body: "video",
        doc: { zh: ["视频节点"], en: ["Video node"] },
        add: { label: "加视频生成节点", icon: "film", type: "gen", prime: "primeVideo", seed: "videoSkill" } },
    // 素材输入节点：从素材库取一段片 / 一段声音铺上画布，连进生成节点就是那一路的参考视频 / 参考音频
    // （分桶与槽位上限见 gen.js 的 genInputs 与 videoRefs）。栏上那一枚开素材库，按类型只收那一类
    video_in: { title: "视频输入", w: 340, h: 360, css: "ns-canvas-node-video", body: "video", bar: "media",
        doc: { zh: ["视频输入节点"], en: ["Video-input node"] },
        add: { label: "加视频输入", icon: "film", act: "material", accept: "video" } },
    audio_in: { title: "音频输入", w: 340, h: 104, css: "ns-canvas-node-audio", body: "audio", bar: "media",
        doc: { zh: ["音频输入节点"], en: ["Audio-input node"] },
        add: { label: "加音频输入", icon: "volume", act: "material", accept: "audio" } },
    // 车厢一张一段：段号、这一段自己写的提示词与素材覆盖都在这一张上，整列共用的参数在车尾。
    // 「添加配方」铺的是一整列（见 page.js 的铺一列），菜单那一行不落一张空车厢
    recipe: { title: "车厢", w: 360, h: 176, css: "ns-canvas-node-recipe", body: "car", run: "car",
        doc: { zh: ["车厢"], en: ["车厢"] },
        add: { label: "添加配方", icon: "wand", prime: "primeRecipes", act: "recipe" } },
};

/** store.js 建节点与读盘兜底用的那一份规格（形状不变，值从注册表来） */
export const NODE_SPECS = Object.fromEntries(Object.entries(NODE_TYPES)
    .map(([type, d]) => [type, { width: d.w, height: d.h, title: d.title }]));

/** 「加节点」菜单：顺序就是上面这一列的顺序。图标与名字、这一行落哪一类节点（加视频生成节点落的是图像生成节点的视频档）
 *  视频档）、建之前要先读到手的那一份清单（prime 是 gen.js 交下来的那个读法）、默认 metadata（defaults
 *  写死在类型那一行，seed 是页面那一层才知道的默认技能）都在这一行里。
 *  act 是菜单里不落一张空节点的那两发：加图片开素材库，添加配方开配方弹窗 */
export const ADD_MENU = Object.entries(NODE_TYPES)
    .filter(([, d]) => d.add)
    .map(([type, d]) => ({ ...d.add, type: d.add.type || type }));

/** 卡上那一发说的话：运行钮、悬停提示与状态行的取值。状态行三条链形状各不一样 —— 出图与编辑数张数、
 *  增强与反推数字数（字数每 40 字才报一次：逐 token 整层重画会把节点上的打字与拖动全卡住） */
/** 每一发要的能力位（名字就是 app/studio_caps.py 的 FEATURE_ROUTES 里那一个）与能力位缺了要说的话：
 *  出图与出片明说要执行队列（拉起它是顶栏那一位的事，页面不替用户拉），LLM 两条链只说这一项功能需要
 *  ComfyUI —— 两条链在桌面端自服表上，离线窗口答得出，要的是本机配好 LLM */
export const RUN_LABELS = {
    image: { btn: "出图", tip: "提交这一发生图任务", queued: "排队中", running: "生成中",
        progress: "生成中 {done}/{total}", fail: "出图失败", failToast: "出图失败", doneN: "已出图 {n} 张",
        cancelled: "已取消出图", fell: "图已存进 Output 目录", offline: "出图需要 ComfyUI 执行队列",
        cap: "image_gen", gateNote: "出图需要 ComfyUI 执行队列：点顶栏 ComfyUI 胶囊启动，好了再按一次" },
    // 生成节点的视频档：状态行与生图共用同一份字（状态机与 style.css 都共用这一套），只有钮与提示条是出片那一份
    video: { btn: "生成视频", tip: "提交这一发生成视频任务", queued: "排队中", running: "生成中",
        progress: "生成中 {done}/{total}", fail: "出图失败", failToast: "出片失败", done: "已出片",
        cancelled: "已取消出片", fell: "视频已存进 Output 目录", offline: "生成视频需要 ComfyUI 执行队列",
        cap: "simple_video", gateNote: "出片需要 ComfyUI 执行队列：点顶栏 ComfyUI 胶囊启动，好了再按一次" },
    // 串联的车尾：那一行数的是链上的段数不是某一发的步数；出片是按链序把启用的那几段依次入队（跑的是分段那条链）
    chain: { btn: "生成视频", tip: "按链序跑启用的那几段", queued: "排队中", running: "生成中",
        progress: "串联出片 {done}/{total}", fail: "出片失败", failToast: "出片失败", done: "已出片",
        cancelled: "已取消出片", fell: "视频已存进 Output 目录", offline: "生成视频需要 ComfyUI 执行队列",
        cap: "segment", gateNote: "出片需要 ComfyUI 执行队列：点顶栏 ComfyUI 胶囊启动，好了再按一次" },
    edit: { btn: "出图", tip: "提交这一发图像编辑任务", queued: "排队中", running: "编辑中",
        progress: "编辑中 {done}/{total}", fail: "出图失败", failToast: "出图失败", doneN: "已出图 {n} 张",
        cancelled: "已取消出图", fell: "图已存进 Output 目录", offline: "出图需要 ComfyUI 执行队列",
        cap: "image_gen", gateNote: "出图需要 ComfyUI 执行队列：点顶栏 ComfyUI 胶囊启动，好了再按一次" },
    enhance: { kind: "enhance", btn: "增强", tip: "把连过来的正文交给 LLM 重写", running: "增强中",
        chars: "增强中 · {n} 字", fail: "增强失败", failToast: "增强失败", done: "已增强出提示词", cancelled: "已取消增强",
        cap: "prompt_enhance", gateNote: "该功能需要 ComfyUI：点顶栏 ComfyUI 胶囊启动，好了再按一次" },
    reverse: { kind: "reverse", btn: "反推", tip: "把连过来的那张图写成一段提示词", running: "反推中",
        chars: "反推中 · {n} 字", fail: "反推失败", failToast: "反推失败", done: "已反推出提示词", cancelled: "已取消反推",
        cap: "prompt_reverse", gateNote: "该功能需要 ComfyUI：点顶栏 ComfyUI 胶囊启动，好了再按一次" },
    // 车厢：卡上那一行只说这一段跑到哪了（整列共用的段数与参数在车尾），车厢自己不跑出片，收摊的是它那一发的轮询
    // —— 车厢卡上没有运行钮，这一行没有钮字，也没有要的能力位（出片那一位在车尾那一发身上）
    car: { queued: "排队中", running: "生成中", progress: "生成中 {done}/{total}", fail: "出片失败",
        failToast: "出片失败", done: "已出片", cancelled: "已取消出片", fell: "视频已存进 Output 目录" },
};

/** 这一张节点跑哪一条链：生成节点看它自己的档 —— 串联的车尾按链序跑，视频档走出片；其余类型看表里那一行 */
export function runKind(node) {
    const d = NODE_TYPES[node.type] || NODE_TYPES.text;
    if (d.run !== "image") return d.run;
    if (node.metadata?.chain === "train") return "chain";
    return node.metadata?.kind === "video" ? "video" : "image";
}

/** 运行钮的闸门（三条链共用）：交回 null = 放行；交回 { msg, level } = 拦下，调用方把 msg 说给用户
 *  （msg 为空 = 这一发已经在跑，不出声）。这一发要哪个能力位、缺了说什么话都在 RUN_LABELS 那一行里，
 *  闸门自己按节点查——调用方只交运行态与能力表读法，不传能力位名字（宿主那个 canGen 是无参闭包，
 *  传进去的名字会被默默忽略，出片与出图就靠侥幸一致）。停用的那一张先说已停用 —— 这句排在「这一发在跑」
 *  之前，跑着的那一发不该把它吃掉；能力位缺了只说去哪儿启，页面不替用户拉内核（拉一次就是收回在跑的
 *  内核正在用的代理目标）。运行态由 gen.js 交出：注册表不持有节点状态 */
export function gateOf(node, { running = false, canFeature } = {}) {
    if (node.metadata?.disabled === true) {
        return { msg: t("这台节点已停用：在节点上方的浮出栏里启用"), level: "info" };
    }
    if (running) return { msg: "", level: "info" };
    const labels = RUN_LABELS[runKind(node)];
    if (labels?.cap && canFeature?.(labels.cap) === false) {
        return { msg: t(labels.gateNote), level: "warn" };
    }
    return null;
}

/** 连线顺序里直接连过来的那一层中的某一类上游节点：顺序就是 connections 的书写顺序，后端吃进去的参考
 *  顺序与正文拼接顺序都是它（gen.js 取正文、取参考、取反推那一张、取素材共用这一条）。只看直连这一层，
 *  不沿链往上回溯 —— 上游的上游连过来的是那一条链，不是这一发的输入。
 *  disableOk 为假时跳过停用的那一张：停用的节点的正文与素材既不进这一发也不当落点 */
export function upstreamNodes(state, from, types, disableOk = false) {
    const byType = new Set(types);
    const out = [];
    for (const conn of (state.connections || [])) {
        if (conn.toNodeId !== from) continue;
        const node = (state.nodes || []).find((n) => n.id === conn.fromNodeId);
        if (!node || !byType.has(node.type)) continue;
        if (node.metadata?.disabled === true && !disableOk) continue;
        out.push(node);
    }
    return out;
}

