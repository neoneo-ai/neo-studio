// 画布上的节点类型注册表：每一类节点在这张页面上长什么样、跑起来说什么话，全在这张静态表里一份。
// 新增一类节点只要动这五处：这张表加一行、gen.js 加一条请求构造、style.css 加一段卡面、docs/canvas.md
// 与 docs/en/canvas.md 各加一行、canvas 用例加一段 —— 卡面分支、附加栏、闸门、运行文案、加节点菜单、
// 手势层认的那一片控件全从这张表读，不再各写一份。
// 表里没有运行期注册，也不持有页面状态：它是纯数据，只放类型自己的取值。节点运行态在 gen.js（running /
// llmRuns / chains），画布 state 在 page.js。
// 表里的 type 就是画布落盘 JSON 与 studio/canvas.py 里那一个字符串（canvas._KNOWN_TYPES 与它同口径），
// 不进 ComfyUI 的 NODE_CLASS_MAPPINGS：画布节点是这一页自己的东西，内核不认识它。
import { t } from "../../../js/core/i18n.js";

/** @typedef {"image" | "text" | "gen" | "video" | "recipe" | "edit" | "enhance" | "reverse"} CanvasNodeType */

/** 每一类节点一行：title / w / h 是建节点与读盘兜底的默认框；css 是卡面类名（空 = 这一类没有独立卡面框，
 *  走 .ns-canvas-gen 那一套）；body 是卡面内容走哪一个渲染器；bar 是附加操作栏多出来的那枚；
 *  gate 是这一发要的能力位；run 是 RUN_LABELS 里那一发说的话；add 是「加节点」菜单那一行。
 *  手势层认的控件面不在这里：那是共享的一份清单，按类型拆会让卡面几乎按不到（见 interactions.js） */
export const NODE_TYPES = {
    image: { title: "图片", w: 340, h: 240, css: "ns-canvas-node-image", body: "image", bar: "hero",
        add: { label: "加图片", icon: "image" } },
    text: { title: "提示词", w: 340, h: 240, css: "ns-canvas-node-text", body: "text", bar: "prompt",
        add: { label: "加提示词", icon: "list" } },
    gen: { title: "生成", w: 320, h: 208, css: "ns-canvas-node-gen", body: "gen", gate: "image_gen",
        run: "image", add: { label: "加生成节点", icon: "sparkles" } },
    // 图像编辑节点：图与提示词都从连过来的节点取，这一张只管选技能与出图 —— 卡面与生成节点同一档（接法见 gen.js 的 runEdit）
    edit: { title: "图像编辑", w: 320, h: 208, css: "", body: "edit", gate: "image_gen", run: "edit",
        add: { label: "加编辑节点", icon: "pencil" } },
    // 增强节点：要重写的正文从连过来的提示词节点取，成文写进下游空的提示词节点（见 gen.js 的 runEnhance）
    enhance: { title: "增强", w: 320, h: 168, css: "", body: "llm", gate: "prompt_enhance", run: "enhance",
        add: { label: "加增强节点", icon: "refresh" } },
    // 反推节点：要反推的那一张从连过来的图片节点取，成文同样写进下游空的提示词节点（见 gen.js 的 runReverse）
    reverse: { title: "反推", w: 320, h: 168, css: "", body: "llm", gate: "prompt_reverse", run: "reverse",
        add: { label: "加反推节点", icon: "camera" } },
    video: { title: "视频", w: 340, h: 240, css: "ns-canvas-node-video", body: "video",
        add: { label: "加视频节点", icon: "film" } },
    // 车厢一张一段：段号、这一段自己写的提示词与素材覆盖都在这一张上，整列共用的参数在车尾
    recipe: { title: "车厢", w: 360, h: 176, css: "ns-canvas-node-recipe", body: "car", gate: "video_gen",
        run: "car", add: { label: "添加配方", icon: "wand" } },
};

/** store.js 建节点与读盘兜底用的那一份规格（形状不变，值从注册表来） */
export const NODE_SPECS = Object.fromEntries(Object.entries(NODE_TYPES)
    .map(([type, d]) => [type, { width: d.w, height: d.h, title: d.title }]));

/** 「加节点」菜单：顺序就是上面这一列的顺序，图标与名字都在类型那一行里 */
export const ADD_MENU = Object.entries(NODE_TYPES)
    .filter(([, d]) => d.add).map(([type, d]) => ({ type, ...d.add }));

/** 卡上那一发说的话：运行钮、悬停提示与状态行的取值。状态行三条链形状各不一样 —— 出图与编辑数张数、
 *  增强与反推数字数（字数每 40 字才报一次：逐 token 整层重画会把节点上的打字与拖动全卡住） */
export const RUN_LABELS = {
    image: { btn: "出图", tip: "提交这一发生图任务", queued: "排队中", running: "生成中",
        progress: "生成中 {done}/{total}", fail: "出图失败", doneN: "已出图 {n} 张",
        cancelled: "已取消出图", fell: "图已存进 Output 目录", offline: "出图需要 ComfyUI 执行队列" },
    // 生成节点的视频档：状态行与生图共用同一份字（状态机与 style.css 都共用这一套），只有钮是「生成视频」
    video: { btn: "生成视频", tip: "提交这一发生成视频任务", queued: "排队中", running: "生成中",
        progress: "生成中 {done}/{total}", fail: "出图失败", done: "已出片", cancelled: "已取消出片",
        fell: "视频已存进 Output 目录", offline: "生成视频需要 ComfyUI 执行队列" },
    // 串联的车尾：那一行数的是链上的段数不是某一发的步数；出片是按链序把启用的那几段依次入队
    chain: { btn: "生成视频", tip: "按链序跑启用的那几段", queued: "排队中", running: "生成中",
        progress: "串联出片 {done}/{total}", fail: "出片失败", done: "已出片", cancelled: "已取消出片",
        fell: "视频已存进 Output 目录", offline: "生成视频需要 ComfyUI 执行队列" },
    edit: { btn: "出图", tip: "提交这一发生成任务", queued: "排队中", running: "编辑中",
        progress: "编辑中 {done}/{total}", fail: "出图失败", doneN: "已出图 {n} 张",
        cancelled: "已取消出图", fell: "图已存进 Output 目录", offline: "出图需要 ComfyUI 执行队列" },
    enhance: { btn: "增强", tip: "把连过来的正文交给 LLM 重写", running: "增强中",
        chars: "增强中 · {n} 字", fail: "增强失败", done: "已增强出提示词", cancelled: "已取消增强" },
    reverse: { btn: "反推", tip: "把连过来的那张图写成一段提示词", running: "反推中",
        chars: "反推中 · {n} 字", fail: "反推失败", done: "已反推出提示词", cancelled: "已取消反推" },
    // 车厢：卡上那一行只说这一段跑到哪了（整列共用的段数与参数在车尾），车厢自己不跑出片
    car: { queued: "排队中", running: "生成中", progress: "生成中 {done}/{total}", fail: "出片失败" },
};

/** 这一张节点跑哪一条链：生成节点看它自己的档 —— 串联的车尾按链序跑，视频档走出片；其余类型看表里那一行 */
export function runKind(node) {
    const d = NODE_TYPES[node.type] || NODE_TYPES.text;
    if (d.run !== "image") return d.run;
    if (node.metadata?.chain === "train") return "chain";
    return node.metadata?.kind === "video" ? "video" : "image";
}

/** 运行钮的闸门（三条链共用，交回要说的那一句，空串 = 放行）：停用的那一张先说已停用 —— 这句排在
 *  「这一发在跑」之前，跑着的那一发不该把它吃掉；这一发在跑就不重复提交；能力位缺了只说去哪儿启，页面不替
 *  用户拉内核（拉一次就是收回在跑的内核正在用的代理目标）。运行态由 gen.js 交出，注册表不持有节点状态 */
export function gateOf(node, { running = false, gate = "", canFeature } = {}) {
    if (node.metadata?.disabled === true) return t("这台节点已停用：在节点上方的浮出栏里启用");
    if (running) return "";
    if (gate && canFeature?.(gate) === false) {
        return gate === "image_gen" ? t("出图需要 ComfyUI 执行队列：点顶栏 ComfyUI 胶囊启动，好了再按一次")
            : gate === "video_gen" ? t("出片需要 ComfyUI 执行队列：点顶栏 ComfyUI 胶囊启动，好了再按一次")
            : t("该功能需要 ComfyUI：点顶栏 ComfyUI 胶囊启动，好了再按一次");
    }
    return "";
}

/** 沿连线往回溯到某一类上游节点：从起点按连线顺序广度走，回来的顺序就是连线顺序（gen.js 取正文、取参考、
 *  取反推那一张、取素材共用这一条）。seen 只挡画布上成环的连线；disableOk 为假时跳过停用的那一张 ——
 *  停用的节点的正文与素材既不进这一发也不当落点 */
export function upstreamNodes(state, from, types, disableOk = false) {
    const byType = new Set(types);
    const nodes = state.nodes || [];
    const connections = state.connections || [];
    const out = [], seen = new Set([from]), queue = [from];
    while (queue.length) {
        const id = queue.shift();
        for (const conn of connections) {
            if (conn.toNodeId !== id || seen.has(conn.fromNodeId)) continue;
            const node = nodes.find((n) => n.id === conn.fromNodeId);
            if (!node) continue;
            seen.add(node.id);
            if (node.metadata?.disabled === true && !disableOk) { queue.push(node.id); continue; }
            if (byType.has(node.type)) out.push(node);
            queue.push(node.id);
        }
    }
    return out;
}

