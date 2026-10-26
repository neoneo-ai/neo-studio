/**
 * workflow-graph.js
 * 技能工作流模板（API prompt 格式）的只读 SVG 流程图渲染：
 * - layoutWorkflow：拓扑分层 → 从左到右自动布局（列号取最右可行、列宽按内容自适应、
 *   每列内按上下游重心迭代排布并按连线交叉数局部改进；节点高度随参数行数自适应；纯函数，无 DOM 依赖）
 * - canvasLayout：同一套列号与重心排布，位置按画布节点真实尺寸推导，同列宽度拉齐、模型加载
 *   节点按模型名加长（返回应设宽度），供「导入到画布」后重排画布
 * - applyWorkflowParams：按已知参数（设置 + 自动建议模型）预替换模板变量，运行时变量保留
 * - injectRuntimeLoras：配置 LoRA 超出模板槽位时镜像后端 _apply_loras 动态插入 LoraLoaderModelOnly，
 *   使流程图与运行时实际提交的图一致；未配置或槽位够用时原样返回
 * - validateWorkflow / checkWorkflow：对照节点定义与 /models/{folder}
 *   标记 节点未安装 / 模型未找到 / {{模板变量}}（请求失败时跳过对应检查，不误报）
 *   checkWorkflow 只按工作流用到的 class 拉 /object_info/{class}（走 js/core/object-info.js 缓存）
 * - renderWorkflowGraph：画 SVG（节点框 + 参数行 + 贝塞尔连线 + 徽标 + tooltip）+ 问题摘要到容器
 *   （摘要含缺失节点/模型的名称芯片与复制按钮，方便一键复制去安装/下载；含被设置填掉值的
 *   {{变量}}芯片 —— 值被填走后图上只剩数字，芯片说清这一格是哪个变量、目标控件能填什么
 *   （combo 选项 / 数值上下限，取 /object_info 定义）、这个数由哪项技能设置算出、生成时会不会重算）
 */
import { getNodeDefs, getModelList } from "./js/core/object-info.js";
import { t, tf } from "./js/core/i18n.js";

const GAP_X = 36, GAP_Y = 12, PAD = 12;
// 列宽按该列节点实际内容推导：短列收窄省横向空间，长列最多 NODE_W_MAX 减少截断；
// 含模型加载类节点的列放宽到 NODE_W_MODEL_MAX，让模型名尽量完整显示
const NODE_W_MIN = 108, NODE_W_MAX = 205, NODE_W_MODEL_MAX = 360;
// 模型加载类节点：widget 上显示模型名，宽度按模型名放宽
const MODEL_LOADER_CLASSES = new Set([
    "CheckpointLoader", "CheckpointLoaderSimple", "CheckpointLoaderAdvanced",
    "UNETLoader", "CLIPLoader", "DualCLIPLoader", "TripleCLIPLoader",
    "VAELoader", "CLIPVisionLoader", "LoraLoader", "LoraLoaderModelOnly",
    "ControlNetLoader", "StyleModelLoader", "T2IAdapterLoader", "GLIGENLoader",
    "UpscaleModelLoader", "InstantIDModelLoader", "IpAdapterModelLoader",
]);
// 字符宽度估算：参数行 10px 字号约 5.5px/字符，类名 11px 加粗约 6.2px/字符
const TYPE_CHAR_W = 6.2, LINE_CHAR_W = 5.5, NODE_PAD_X = 20;
function lineMaxChars(w) { return Math.floor((w - NODE_PAD_X) / LINE_CHAR_W); }
const TEMPLATE_RE = /\{\{.*?\}\}/;

// combo 输入类型 → /models/{folder} 目录；未知类型跳过（宁缺勿误报）
const MODEL_INPUT_TYPE_TO_FOLDER = {
    CHECKPOINT_NAME: "checkpoints",
    LORA_NAME: "loras",
    VAE_NAME: "vae",
    CLIP_NAME: "clip",
    CLIP_VISION_NAME: "clip_vision",
    UNET_NAME: "diffusion_models",
    DIFFUSION_MODEL_NAME: "diffusion_models",
    DUALCONV_NAME: "dual_convolution",
    STYLE_MODEL_NAME: "style_model",
    UPSCALE_MODEL_NAME: "upscale_models",
    EMBEDDING_NAME: "embeddings",
    LOADER: "controlnet",
};

function _sortNodeIds(a, b) {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
}

/** 拓扑分层（最长路径，环回边忽略）+ 同层按上游重心排序（3 轮收敛，无上游的保持 id 序）。 */
function graphOrdering(wf) {
    const ids = Object.keys(wf);
    const idSet = new Set(ids);
    const preds = {}, succ = {};
    for (const id of ids) { preds[id] = []; succ[id] = []; }
    for (const id of ids) {
        const inputs = (wf[id] && wf[id].inputs) || {};
        for (const v of Object.values(inputs)) {
            if (Array.isArray(v) && typeof v[0] === "string" && v[0] !== id && idSet.has(v[0])) {
                preds[id].push(v[0]);
                succ[v[0]].push(id);
            }
        }
    }

    const layer = {};
    const state = {}; // 1=进行中 2=完成
    function assign(id) {
        if (state[id] === 2) return layer[id];
        if (state[id] === 1) return 0; // 环回边，忽略
        state[id] = 1;
        let l = 0;
        for (const p of preds[id]) l = Math.max(l, assign(p) + 1);
        state[id] = 2;
        layer[id] = l;
        return l;
    }
    ids.forEach(assign);

    const byLayer = {};
    for (const id of ids) (byLayer[layer[id]] ||= []).push(id);
    const layers = Object.keys(byLayer).map(Number).sort((a, b) => a - b);

    const order = {};
    for (const L of layers) order[L] = byLayer[L].slice().sort(_sortNodeIds);
    for (let pass = 0; pass < 3; pass++) {
        const rank = {};
        for (const L of layers) order[L].forEach((id, i) => { rank[id] = i; });
        for (const L of layers) {
            const bary = {};
            for (const id of order[L]) {
                const ps = preds[id];
                bary[id] = ps.length ? ps.reduce((s, p) => s + rank[p], 0) / ps.length : rank[id];
            }
            order[L].sort((a, b) => (bary[a] - bary[b]) || _sortNodeIds(a, b));
        }
    }
    return { ids, layer, layers, order, preds, succ };
}

/** 参考加载器源节点（LoadImage/LoadVideo/LoadAudio，含流程图里合并出的 ×N 合成节点）。 */
const REF_LOADER_RE = /^(LoadImage|LoadVideo|LoadAudio)( ×\d+)?$/;
function isRefLoader(node) {
    if (!node || !REF_LOADER_RE.test(String(node.class_type || ""))) return false;
    for (const v of Object.values(node.inputs || {})) {
        if (Array.isArray(v) && typeof v[0] === "string") return false; // 有上游连线的不算参考源
    }
    return true;
}

/**
 * 列号取「最右可行」：节点紧贴其下游，源节点不再挤在首列，图更紧凑、连线更短。
 * 按层从右到左处理（下游列已确定），环回边忽略；没有下游的节点保持自身层号。
 * 参考加载器统一钉到最左列（所有参考图/视频/音频在同一列自上而下），再沿连线把下游
 * 推到上游右侧，保证每条连线都满足 col[上游] < col[下游]。
 */
function columnOf(layer, layers, order, preds, succ, wf) {
    const col = {};
    for (let i = layers.length - 1; i >= 0; i--) {
        for (const id of order[layers[i]]) {
            let c = -1;
            for (const s of succ[id]) {
                if (layer[s] <= layer[id]) continue; // 环回边
                const sc = col[s] - 1;
                if (c < 0 || sc < c) c = sc;
            }
            col[id] = c < 0 ? layer[id] : c;
        }
    }
    for (const L of layers) {
        for (const id of order[L]) {
            if (isRefLoader(wf[id])) col[id] = 0;
            for (const p of preds[id]) if (layer[p] < layer[id]) col[id] = Math.max(col[id], col[p] + 1);
        }
    }
    return col;
}

/**
 * 每列内的垂直位置按上下游重心迭代收敛：同列顺序按当前重心，间距不小于 gapY，
 * 用加权等距回归（PAV）求最贴近重心的解 — 连线平直、同列不重叠。
 * nbr[id] = [[邻居, 连线在 id 一侧的理想中心偏移]]，偏移来自目标节点的参数行位置。
 */
function packColumn(ids, h, gapY, center, nbr) {
    // base[i] = 第 i 个节点在「刚好紧贴上一个」时的中心偏移，t[i] = center - base[i] 需非递减
    const base = [0];
    for (let i = 1; i < ids.length; i++)
        base.push(base[i - 1] + (h[ids[i]] + h[ids[i - 1]]) / 2 + gapY);
    const blocks = []; // [权重和, 加权重心和, 起, 止]
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i], nb = nbr[id];
        const w = nb.length || 1;
        const d = nb.length ? nb.reduce((s, p) => s + center[p[0]] + p[1], 0) / nb.length : center[id];
        blocks.push([w, w * (d - base[i]), i, i]);
        while (blocks.length > 1) {
            const a = blocks[blocks.length - 2], b = blocks[blocks.length - 1];
            if (a[1] / a[0] <= b[1] / b[0]) break;
            blocks.pop(); blocks.pop();
            blocks.push([a[0] + b[0], a[1] + b[1], a[2], b[3]]);
        }
    }
    for (const [sw, sv, a, b] of blocks) {
        const t = sv / sw;
        for (let i = a; i <= b; i++) center[ids[i]] = t + base[i];
    }
}

/**
 * 重心排布是局部最优，仍可能留下交叉：在每列内尝试相邻两节点上下交换，
 * 全局交叉数下降（或相同但连线更平直）就接受，扫描到不再改进为止。
 * 位置仍由 PAV 重算，同列不重叠。
 * 连线为 [源, 目标, 源端偏移, 目标端偏移]，偏移相对各自节点中心（画布上端点是参数行中心）。
 */
function reduceCrossings(colNodes, cols, h, gapY, nbr, center, edges, colX, colW) {
    const colOf = {};
    for (const c of cols) for (const id of colNodes[c]) colOf[id] = c;
    // 连线按跨越的列间隙分组：只有 x 区间重叠的连线才可能交叉
    const gapEdges = {};
    for (const e of edges)
        for (let k = colOf[e[0]]; k < colOf[e[1]]; k++) (gapEdges[k] ||= []).push(e);
    // 连线在列间隙内是直线，用间隙两端的 y 判断交叉，与渲染几何一致
    const yAt = (e, x) => {
        const a = e[0], b = e[1], ca = colOf[a], cb = colOf[b];
        const x1 = colX[ca] + colW[ca], y1 = center[a] + (e[2] || 0);
        const y2 = center[b] + (e[3] || 0);
        return y1 + (y2 - y1) * (x - x1) / (colX[cb] - x1);
    };
    const gapCross = (k) => {
        const es = gapEdges[k];
        if (!es || es.length < 2) return 0;
        const xl = colX[k] + colW[k], xr = colX[k + 1];
        const ys = es.map(e => [yAt(e, xl), yAt(e, xr)]);
        ys.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
        let n = 0;
        for (let i = 0; i < ys.length; i++)
            for (let j = i + 1; j < ys.length; j++) if (ys[i][1] > ys[j][1]) n++;
        return n;
    };
    const gapKeys = Object.keys(gapEdges);
    // 重心迭代逐列进行，跨列重心可能漂移；先结算一轮再优化
    for (let i = 0; i < 3; i++)
        for (const c of cols) packColumn(colNodes[c], h, gapY, center, nbr);
    // 交换会重排本列节点，邻居列的中心也随之变化，所以每次都按全局交叉/平直度判定
    const totalCross = () => gapKeys.reduce((s, k) => s + gapCross(Number(k)), 0);
    const totalBend = () => edges.reduce((s, e) => s + Math.abs(center[e[1]] + (e[3] || 0) - center[e[0]] - (e[2] || 0)), 0);

    for (let pass = 0; pass < 6; pass++) {
        let improved = false;
        for (const c of cols) {
            const ids = colNodes[c];
            if (ids.length < 2) continue;
            let cross = totalCross(), bend = totalBend();
            for (let i = 0; i + 1 < ids.length; i++) {
                const a = ids[i], b = ids[i + 1];
                ids[i] = b; ids[i + 1] = a;
                packColumn(ids, h, gapY, center, nbr);
                const nc = totalCross(), nb = totalBend();
                if (nc < cross || (nc === cross && nb < bend)) {
                    cross = nc; bend = nb; improved = true;
                    // 本列重排会漂移邻居列的重心，结算后再评估下一个交换
                    for (const c2 of cols) packColumn(colNodes[c2], h, gapY, center, nbr);
                } else {
                    ids[i] = a; ids[i + 1] = b;
                    packColumn(ids, h, gapY, center, nbr); // 邻居中心未变，重算即回到原位置
                }
            }
        }
        if (!improved) break;
    }
}

function barycenterCenters(colNodes, cols, h, gapY, preds, succ, edges, colX, colW) {
    const center = {};
    for (const c of cols) {
        let y = 0;
        for (const id of colNodes[c]) { center[id] = y + h[id] / 2; y += h[id] + gapY; }
    }
    const linkEdges = edges || Object.values(colNodes).flatMap(ids =>
        ids.flatMap(id => preds[id].map(p => [p, id])));
    // 理想中心偏移按连线两端的参数行位置：端点落在第 i 行文字中心，所以源端理想 center =
    // 目标中心 + 目标行偏移 - 源行偏移，目标端对称
    const nbr = {};
    for (const c of cols) for (const id of colNodes[c]) nbr[id] = [];
    for (const [a, b, so, to] of linkEdges) {
        const o = (to || 0) - (so || 0);
        nbr[a].push([b, o]);
        nbr[b].push([a, -o]);
    }
    for (let pass = 0; pass < 4; pass++) {
        const seq = pass % 2 ? cols.slice().reverse() : cols;
        for (const c of seq) {
            const ids = colNodes[c].sort((a, b) => (center[a] - center[b]) || _sortNodeIds(a, b));
            packColumn(ids, h, gapY, center, nbr);
            colNodes[c] = ids;
        }
    }
    reduceCrossings(colNodes, cols, h, gapY, nbr, center, linkEdges, colX, colW);
    return center;
}

/** API prompt → { nodes, edges, width, height }。inputs 里 ["srcId", slot] 视为连线；环安全（回边忽略）。 */
export function layoutWorkflow(workflow) {
    const wf = collapseRefLoaders(workflow || {});
    const { ids, layer, layers, order, preds, succ } = graphOrdering(wf);
    const col = columnOf(layer, layers, order, preds, succ, wf);
    const colNodes = {};
    for (const L of layers) for (const id of order[L]) (colNodes[col[id]] ||= []).push(id);
    const cols = Object.keys(colNodes).map(Number).sort((a, b) => a - b);

    // 列宽按该列节点实际内容推导（先取不截断的原始行宽），再按列宽截断参数行；
    // 同列节点统一取列宽，含模型加载类节点的列上限放宽以显示模型名
    const colW = {};
    for (const c of cols) {
        let need = 0, cap = NODE_W_MAX;
        for (const id of colNodes[c]) {
            const cls = (wf[id] && wf[id].class_type) || "?";
            need = Math.max(need, cls.length * TYPE_CHAR_W + NODE_PAD_X);
            if (MODEL_LOADER_CLASSES.has(cls)) cap = NODE_W_MODEL_MAX;
            for (const line of nodeInputLines(wf, id, Infinity))
                need = Math.max(need, line.length * LINE_CHAR_W + NODE_PAD_X);
        }
        colW[c] = Math.min(cap, Math.max(NODE_W_MIN, Math.ceil(need)));
    }
    const lines = {}, h = {};
    for (const id of ids) {
        lines[id] = nodeInputLines(wf, id, lineMaxChars(colW[col[id]]));
        h[id] = nodeH(lines[id].length, id);
    }

    // 连线终点 = 目标节点对应参数行的文字中心（相对节点中心，行被折叠时为 0）；排布时按真实端点算交叉
    const linkEdges = [];
    for (const id of ids) {
        const inputs = (wf[id] && wf[id].inputs) || {};
        for (const [k, v] of Object.entries(inputs)) {
            if (Array.isArray(v) && typeof v[0] === "string" && wf[v[0]] && v[0] !== id) {
                const idx = lines[id].indexOf(k);
                linkEdges.push([v[0], id, 0, idx >= 0 ? inputFirstY(id) + idx * INPUT_LINE_H - 3.5 - h[id] / 2 : 0]);
            }
        }
    }

    const colX = {};
    let x = PAD;
    for (const c of cols) { colX[c] = x; x += colW[c] + GAP_X; }

    // 每列内的垂直位置按上下游重心迭代排布，再按连线交叉数局部改进（同列不重叠）
    const center = barycenterCenters(colNodes, cols, h, GAP_Y, preds, succ, linkEdges, colX, colW);
    const top = ids.length ? Math.min(...ids.map(id => center[id] - h[id] / 2)) : 0;
    const bottom = ids.length ? Math.max(...ids.map(id => center[id] + h[id] / 2)) : 0;
    const pos = {};
    for (const id of ids) pos[id] = { x: colX[col[id]], y: Math.round(PAD + center[id] - h[id] / 2 - top) };
    const width = cols.length ? x - GAP_X + PAD : PAD * 2;
    const height = PAD * 2 + Math.round(bottom - top);

    const nodes = ids.map(id => ({
        id,
        classType: (wf[id] && wf[id].class_type) || "?",
        x: pos[id].x, y: pos[id].y, w: colW[col[id]], h: h[id], layer: layer[id],
        lines: lines[id],
    }));
    // 连线精确指向目标节点上对应参数行的文字中心（text y 是基线，字高 10px → 中心在基线上方约 3.5px）；该行被折叠时退回节点垂直中心
    const edges = linkEdges.map(([from, to, , tgtOff]) => ({ from, to, targetY: pos[to].y + h[to] / 2 + tgtOff }));
    return { nodes, edges, width, height };
}

// 画布重排（「导入到画布」后）用的间距与兜底尺寸：画布节点宽度由前端算好，取不到时按常见尺寸兜底
const CANVAS_PAD = 60, CANVAS_GAP_X = 96, CANVAS_GAP_Y = 48;
const CANVAS_NODE_W = 240, CANVAS_NODE_H = 120;
// 带图像/视频预览 widget 的节点：兜底高度需包含预览区（默认 preview_size 128 + header 40 + 1 行 24）
const PREVIEW_CLASSES = new Set(["LoadImage", "LoadVideo", "LoadAudio"]);
const CANVAS_PREVIEW_H = 192;
// 画布 widget 文字「key: value」约 7px/字符；模型加载类节点按模型名加长的上限
const CANVAS_CHAR_W = 7, CANVAS_W_MAX = 420;
// 画布节点：头部之下每行一个参数（连线行先于 widget 行），连线端点落在第 i 行中心
const CANVAS_HEADER = 40, CANVAS_ROW = 24;

/** 模型加载类节点显示完整模型名所需的画布宽度；非加载类返回 0。 */
function modelLoaderW(node) {
    if (!node || !MODEL_LOADER_CLASSES.has(node.class_type)) return 0;
    let need = 0;
    for (const [k, v] of Object.entries(node.inputs || {})) {
        if (typeof v === "string") need = Math.max(need, (k.length + 2 + v.length) * CANVAS_CHAR_W + CANVAS_PAD);
    }
    return Math.min(CANVAS_W_MAX, need);
}

function canvasRowOff(id, i, h, rows) {
    const body = Math.max(CANVAS_ROW, h[id] - CANVAS_HEADER);
    return CANVAS_HEADER + (i + 0.5) * body / Math.max(1, rows[id]) - h[id] / 2;
}

/**
 * 与预览同一套列号与重心排布，位置按画布节点真实尺寸推导：拓扑分层 → 列号取最右可行 →
 * 每列内按上下游重心迭代排布（同列不重叠、连线尽量平直）。sizeOf(id) 返回画布节点 [w, h]
 * （拿不到用兜底尺寸）。同列宽度拉齐到该列最宽节点，模型加载类节点按模型名加长。
 * 返回 [{ id, x, y, w }]，id 为 workflow 的键，w 为该节点应设的宽度（调用方 setSize 应用）。
 */
export function canvasLayout(workflow, sizeOf) {
    const wf = workflow || {};
    const { ids, layer, layers, order, preds, succ } = graphOrdering(wf);
    const w = {}, h = {};
    for (const id of ids) {
        const s = sizeOf(id) || null;
        w[id] = Math.max(s && s[0] > 0 ? s[0] : CANVAS_NODE_W, modelLoaderW(wf[id]));
        h[id] = s && s[1] > 0 ? s[1] : (PREVIEW_CLASSES.has((wf[id] || {}).class_type) ? CANVAS_PREVIEW_H : CANVAS_NODE_H);
    }
    const col = columnOf(layer, layers, order, preds, succ, wf);
    const colNodes = {};
    for (const L of layers) for (const id of order[L]) (colNodes[col[id]] ||= []).push(id);
    const cols = Object.keys(colNodes).map(Number).sort((a, b) => a - b);
    const colW = {};
    for (const c of cols) colW[c] = colNodes[c].reduce((m, id) => Math.max(m, w[id]), 0);

    const colX = {};
    let x = CANVAS_PAD;
    for (const c of cols) { colX[c] = x; x += colW[c] + CANVAS_GAP_X; }

    // 连线端点按画布参数行位置：源端是输出槽位行，目标端是第 i 个连线行（widget 行在其后）
    const rows = {};
    for (const id of ids) rows[id] = Math.max(1, Object.keys((wf[id] && wf[id].inputs) || {}).length);
    const linkEdges = [];
    for (const id of ids) {
        const inputs = (wf[id] && wf[id].inputs) || {};
        let i = 0;
        for (const v of Object.values(inputs)) {
            if (Array.isArray(v) && typeof v[0] === "string" && wf[v[0]] && v[0] !== id) {
                linkEdges.push([v[0], id, canvasRowOff(v[0], Number(v[1]) || 0, h, rows), canvasRowOff(id, i, h, rows)]);
                i++;
            }
        }
    }

    const center = barycenterCenters(colNodes, cols, h, CANVAS_GAP_Y, preds, succ, linkEdges, colX, colW);
    const top = ids.length ? Math.min(...ids.map(id => center[id] - h[id] / 2)) : 0;
    const out = [];
    for (const c of cols)
        for (const id of colNodes[c])
            out.push({ id, x: colX[c], y: Math.round(CANVAS_PAD + center[id] - h[id] / 2 - top), w: colW[c] });
    return out;
}

// 合并同类参考加载器：autogrow 槽位（ref_images.ref_image_0..8）的专属源节点（LoadImage/LoadVideo/LoadAudio 等）
// 按 (目标节点, 槽位族) 分组，2+ 个成员时替换为单个合成节点 "ClassName ×N"，大幅减少图的高度
const AUTOGROW_SLOT_RE = /\.\w+_\d+$/;
function collapseRefLoaders(workflow) {
    const ids = Object.keys(workflow);
    // 收集 autogrow 槽位的连线：targetId → slotFamily → [sourceIds]
    const slotGroups = {};
    for (const id of ids) {
        const inputs = workflow[id].inputs || {};
        for (const [k, v] of Object.entries(inputs)) {
            if (Array.isArray(v) && typeof v[0] === "string" && AUTOGROW_SLOT_RE.test(k)) {
                const family = k.replace(/_\d+$/, "");
                const key = `${id}|${family}`;
                (slotGroups[key] ||= []).push(v[0]);
            }
        }
    }
    // 对每个 2+ 源的组，扩展收集专属上游节点（如 LoadVideo → GetVideoComponents → H3），生成合成节点
    const removeSet = new Set();
    const synthMap = {}; // removedId → syntheticId
    const synthNodes = {};

    // 反向邻接：sourceId → Set<targetId>（谁连出到谁）
    const outTo = {};
    for (const id of ids) {
        const inputs = workflow[id].inputs || {};
        for (const v of Object.values(inputs)) {
            if (Array.isArray(v) && typeof v[0] === "string") {
                (outTo[v[0]] ||= new Set()).add(id);
            }
        }
    }

    for (const [key, sourceIds] of Object.entries(slotGroups)) {
        // 只保留实际存在于 workflow 中的源节点（外部引用/未定义节点不参与合并）
        const uniqueSources = [...new Set(sourceIds)].filter(s => workflow[s]);
        if (uniqueSources.length < 2) continue;
        const targetId = key.split("|")[0];

        // 扩展：把输出只连向本组成员的上游节点也纳入（如 LoadVideo → GetVideoComponents）
        const members = new Set(uniqueSources);
        let changed = true;
        while (changed) {
            changed = false;
            for (const id of ids) {
                if (members.has(id)) continue;
                const targets = outTo[id];
                if (targets && targets.size > 0 && [...targets].every(t => members.has(t))) {
                    members.add(id);
                    changed = true;
                }
            }
        }

        const synthId = `__grp_${targetId}_${key.split("|")[1]}`;
        for (const m of members) { removeSet.add(m); synthMap[m] = synthId; }

        // 合成节点：优先取叶子源节点（无数组连线输入的）的 class_type，如 LoadVideo 而非 GetVideoComponents
        const leafSrc = uniqueSources.find(s => {
            const ins = workflow[s].inputs || {};
            return !Object.values(ins).some(v => Array.isArray(v) && typeof v[0] === "string");
        }) || [...members].find(m => {
            const ins = workflow[m].inputs || {};
            return !Object.values(ins).some(v => Array.isArray(v) && typeof v[0] === "string");
        }) || uniqueSources[0];
        synthNodes[synthId] = { class_type: `${workflow[leafSrc].class_type} ×${uniqueSources.length}`, inputs: {} };
    }

    if (removeSet.size === 0) return workflow;

    // 构建新 workflow：移除被合并节点，添加合成节点，重定向边
    const result = {};
    for (const id of ids) {
        if (removeSet.has(id)) continue;
        const node = workflow[id];
        result[id] = { ...node, inputs: { ...node.inputs } };
    }
    Object.assign(result, synthNodes);

    // 重定向：指向被移除节点的连线改为指向对应合成节点（去重）
    for (const id of Object.keys(result)) {
        const inputs = result[id].inputs || {};
        for (const k of Object.keys(inputs)) {
            const v = inputs[k];
            if (Array.isArray(v) && typeof v[0] === "string" && removeSet.has(v[0])) {
                inputs[k] = [synthMap[v[0]], v[1]];
            }
        }
    }
    return result;
}


/**
 * 按已知参数预渲染模板：替换 {{MODEL}} / {{LORA_1_NAME}} / {{STEPS}} 等可由设置确定的占位符，
 * 运行时变量（{{PROMPT}} / {{SEED}} / {{REF_*}} 等）保持原样。返回新对象，不改原模板。
 * 被替换掉的字段记进节点的 tpl_filled（field → "{{TOKEN}}"）：预览里这一格只剩一个填好的值，
 * 不记下来就看不出它是哪个变量填的（{{MEGAPIXELS}} 尤其如此，值由 base_resolution × 比例算出）。
 */
export function applyWorkflowParams(workflow, values) {
    const map = {};
    for (const [k, v] of Object.entries(values || {})) {
        if (v !== undefined && v !== null && String(v) !== "") map["{{" + k + "}}"] = String(v);
    }
    if (!Object.keys(map).length) return workflow;
    const out = {};
    for (const [id, node] of Object.entries(workflow || {})) {
        if (!node || typeof node !== "object") { out[id] = node; continue; }
        const inputs = {}, filled = {};
        for (const [k, v] of Object.entries(node.inputs || {})) {
            if (typeof v === "string") {
                let s = v;
                const toks = [];
                for (const [tok, rep] of Object.entries(map)) {
                    if (!s.includes(tok)) continue;
                    s = s.split(tok).join(rep);
                    toks.push(tok);
                }
                inputs[k] = s;
                if (toks.length) filled[k] = toks.join(" ");
            } else {
                inputs[k] = v;
            }
        }
        out[id] = Object.keys(filled).length ? { ...node, inputs, tpl_filled: filled } : { ...node, inputs };
    }
    return out;
}


// LoRA 运行时动态注入（镜像 image_gen.py _apply_loras）：配置 LoRA 超出模板 {{LORA_i_*}} 槽位时，
// 在主链末端串联插入 LoraLoaderModelOnly（id = max_id+1...），使流程图与运行时实际提交的图一致。
// 未配置或槽位够用时原样返回；返回新对象不改原模板。注入节点带 runtime_injected 标记（tooltip 标注）。
const LORA_SLOT_RE = /^\{\{LORA_(\d+)_NAME\}\}$/;

function _loraModelConsumer(wf, srcId) {
    let best = null;
    for (const [id, node] of Object.entries(wf)) {
        if (!node || node.class_type !== "LoraLoaderModelOnly") continue;
        const v = (node.inputs || {}).model;
        if (Array.isArray(v) && typeof v[0] === "string" && v[0] === String(srcId)) {
            if (best === null || _sortNodeIds(id, best) < 0) best = id;
        }
    }
    return best;
}

function _anyModelConsumer(wf, srcId) {
    let best = null;
    for (const [id, node] of Object.entries(wf)) {
        if (id === srcId || !node) continue;
        const v = (node.inputs || {}).model;
        if (Array.isArray(v) && typeof v[0] === "string" && v[0] === String(srcId)) {
            if (best === null || _sortNodeIds(id, best) < 0) best = id;
        }
    }
    return best;
}

export function injectRuntimeLoras(workflow, loras) {
    const entries = (loras || [])
        .map(l => (typeof l === "string" ? { name: l, strength: 1.0 } : l))
        .filter(l => l && l.name);
    if (!entries.length) return workflow;
    const slots = {};
    for (const [id, node] of Object.entries(workflow || {})) {
        if (!node || node.class_type !== "LoraLoaderModelOnly") continue;
        const m = LORA_SLOT_RE.exec(String((node.inputs || {}).lora_name || ""));
        if (m) slots[Number(m[1])] = id;
    }
    const ordered = Object.keys(slots).map(Number).sort((a, b) => a - b).map(i => slots[i]);
    if (entries.length <= ordered.length) return workflow;

    // 锚点：最后一个槽位节点；无槽位时取第一个 UNETLoader，模板手写过 LoRA 链则推到链尾（与后端一致）
    let anchor = ordered[ordered.length - 1];
    if (!anchor) {
        const unets = Object.entries(workflow).filter(([, n]) => n && n.class_type === "UNETLoader").map(([id]) => id);
        if (!unets.length) return workflow;
        anchor = unets.sort(_sortNodeIds)[0];
        for (;;) {
            const nxt = _loraModelConsumer(workflow, anchor);
            if (!nxt) break;
            anchor = nxt;
        }
    }
    const consumer = _anyModelConsumer(workflow, anchor);
    if (!consumer) return workflow;

    let maxId = 0;
    for (const id of Object.keys(workflow)) {
        const n = Number(id);
        if (Number.isInteger(n) && n > maxId) maxId = n;
    }
    const out = {};
    for (const [id, node] of Object.entries(workflow)) out[id] = { ...node, inputs: { ...(node.inputs || {}) } };
    let prev = anchor;
    entries.slice(ordered.length).forEach((entry, i) => {
        const nid = String(maxId + i + 1);
        out[nid] = { class_type: "LoraLoaderModelOnly", runtime_injected: true,
                     inputs: { model: [prev, 0], lora_name: entry.name, strength_model: entry.strength ?? 1.0 } };
        prev = nid;
    });
    out[consumer].inputs.model = [prev, 0];
    return out;
}


/**
 * 校验 workflow：objectInfo（/object_info）与 modelLists（folder→文件名列表）任一为 null/缺项时跳过对应检查。
 * 返回 { issues: nodeId → [{kind, message}], counts: {missingNodes, missingModels, templates} }。
 */
export function validateWorkflow(workflow, objectInfo, modelLists) {
    const issues = {};
    const counts = { missingNodes: 0, missingModels: 0, templates: 0 };
    for (const [id, node] of Object.entries(workflow || {})) {
        const list = (issues[id] ||= []);
        const cls = node && node.class_type;
        if (objectInfo && cls && !objectInfo[cls]) {
            list.push({ kind: "missing_node", message: tf("节点未安装：{cls}", { cls }), value: cls });
            counts.missingNodes++;
            continue; // 节点不存在则查不到输入类型，跳过后续检查
        }
        const inputs = (node && node.inputs) || {};
        const def = objectInfo && cls ? objectInfo[cls].input : null;
        for (const [name, value] of Object.entries(inputs)) {
            if (typeof value === "string" && TEMPLATE_RE.test(value)) {
                list.push({ kind: "template", message: tf("{name} 为模板变量：{value}", { name, value }) });
                counts.templates++;
                continue; // 待替换值不做存在性判断
            }
            if (!def || typeof value !== "string" || !value) continue;
            const entry = [...Object.entries(def.required || {}), ...Object.entries(def.optional || {})]
                .find(([n]) => n === name);
            if (!entry) continue;
            // 有效模型列表有两个来源：
            //  1) object_info 直接内联的解析后 combo 列表（本环境）：spec = [["a.safetensors", ...]]
            //  2) 标准类型名 spec = ["UNET_NAME"] → 用 checkWorkflow 拉取的 modelLists[folder]
            let files = null, label = "";
            if (Array.isArray(entry[1]) && Array.isArray(entry[1][0]) && entry[1][0].length > 0
                && entry[1][0].every((x) => typeof x === "string")) {
                files = entry[1][0];
                label = name;
            } else {
                const typeList = Array.isArray(entry[1]) ? entry[1] : [entry[1]];
                const folder = MODEL_INPUT_TYPE_TO_FOLDER[typeList[0]];
                if (folder) { files = (modelLists || {})[folder]; label = folder; }
            }
            if (!files) continue; // 列表不可用 → 跳过，不误报
            // config 与模型列表的分隔符可能不一致（Windows 后端返回反斜杠）→ 两边归一化后精确比对
            const normList = files.map((f) => String(f).replace(/\\/g, "/"));
            const v = value.replace(/\\/g, "/");
            if (!normList.includes(v) && !normList.includes(v + ".safetensors") && !normList.includes(v + ".ckpt")) {
                list.push({ kind: "missing_model", message: tf("模型未找到：{value}（{label}）", { value, label }), value, label });
                counts.missingModels++;
            }
        }
    }
    return { issues, counts };
}

/** 只拉本工作流用到的 class 定义 + /models/{folder} 后执行校验；请求失败按「跳过检查」处理。
 *  全量 /object_info 十几 MB、服务端逐节点构建近 1 秒，逐次拉会把开图 / 内嵌编辑 / 导入画布卡成秒级。 */
export async function checkWorkflow(workflow) {
    const classes = [...new Set(Object.values(workflow || {}).map((n) => n && n.class_type).filter(Boolean))];
    const defs = await getNodeDefs(classes);
    // 未注册（定义为空对象）= 缺节点（不进表，由 validateWorkflow 报出）；
    // 拉取失败（null）进空壳表按「跳过检查」处理，不把网络失败当成缺节点
    const objectInfo = {};
    for (const [cls, def] of Object.entries(defs)) {
        if (def === null) objectInfo[cls] = { input: {} };
        else if (Object.keys(def).length) objectInfo[cls] = def;
    }
    // definitions 随校验结果带出去：只读流程图的变量芯片要说清「填进哪个控件、能填什么」
    // （combo 的选项、数值的上下限），拿不到定义时芯片只写控件名。

    const folders = new Set();
    for (const cls of classes) {
        const input = (defs[cls] || {}).input;
        if (!input) continue;
        for (const group of [input.required || {}, input.optional || {}]) {
            for (const t of Object.values(group)) {
                const typeList = Array.isArray(t) ? t : [t];
                const folder = MODEL_INPUT_TYPE_TO_FOLDER[typeList[0]];
                if (folder) folders.add(folder);
            }
        }
    }
    const modelLists = {};
    await Promise.all([...folders].map(async (f) => { const list = await getModelList(f); if (list) modelLists[f] = list; }));
    return { ...validateWorkflow(workflow, objectInfo, modelLists), definitions: objectInfo };
}


function svgEl(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    return el;
}

// 参数在节点上的展示：最多 N 行 + 按框宽截断，超出部分由 tooltip 补全
const MAX_INPUT_LINES = 6, INPUT_LINE_H = 13, INPUT_FIRST_Y = 47;
// 连线调色板大小（与 prompts.css 里 .rs-wf-edge-cN 一一对应）
const EDGE_COLORS = 6;

function _fmtVal(v, max = 60) {
    if (Array.isArray(v) && typeof v[0] === "string") return `← #${v[0]}`;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// 节点上展示的参数行：`key: value`（截断到 maxChars）；连线输入只显示参数名（连线直接指向该行），超过 MAX_INPUT_LINES 行 → 「+N 项」
// autogrow 同类输入（如 ref_images.ref_image_0..8）合并为一行摘要 "base ×N"，减少可选槽位的视觉噪音
function nodeInputLines(workflow, id, maxChars) {
    const inputs = (workflow[id] && workflow[id].inputs) || {};
    // 按 base name 分组带数字后缀的输入（如 ref_images.ref_image_0 → base "ref_images.ref_image"）
    const groups = {};
    const regular = [];
    for (const [k, v] of Object.entries(inputs)) {
        const m = k.match(/^(.+)_\d+$/);
        if (m) (groups[m[1]] ||= []).push(k);
        else regular.push([k, v]);
    }
    // 仅对 2+ 个同 base 的输入做合并；单个保留原名
    const groupLines = [];
    for (const [base, names] of Object.entries(groups)) {
        if (names.length >= 2) groupLines.push(`${base} ×${names.length}`);
        else regular.push([names[0], inputs[names[0]]]);
    }
    const filled = (workflow[id] && workflow[id].tpl_filled) || {};
    const all = [
        ...regular.map(([k, v]) => {
            if (Array.isArray(v) && typeof v[0] === "string") return k;
            // 变量名写在值前面：按列宽截断时截掉的是尾巴，被设置填走的值是靠尾巴认不出来的
            const l = `${k}: ${filled[k] ? filled[k] + " = " : ""}${_fmtVal(v, 60)}`;
            return l.length > maxChars ? l.slice(0, maxChars - 1) + "…" : l;
        }),
        ...groupLines,
    ];
    if (all.length > MAX_INPUT_LINES) {
        return [...all.slice(0, MAX_INPUT_LINES), tf("… +{n} 项", { n: all.length - MAX_INPUT_LINES })];
    }
    return all;
}

// 节点高度：头部（类型，可选 #id）固定，参数行每行 INPUT_LINE_H
function inputFirstY(id) { return INPUT_FIRST_Y - (nodeIdLabel(id) ? 0 : INPUT_LINE_H); }

function nodeH(nLines, id) {
    const firstY = inputFirstY(id);
    return nLines === 0 ? firstY - 1 : firstY + (nLines - 1) * INPUT_LINE_H + 6;
}

// 合成节点（autogrow 槽位合并）没有真实节点 id，图上与 tooltip 不显示内部 "#__grp_…"
function nodeIdLabel(id) { return String(id).startsWith("__grp") ? "" : `#${id}`; }

// tooltip 里引用上游：合成节点没有真实 id，用 "ClassName ×N" 代替内部 "__grp_…"
function nodeRefLabel(id, workflow) {
    const label = nodeIdLabel(id);
    return label || ((workflow[id] && workflow[id].class_type) || "?");
}

function nodeTooltip(id, workflow, issues) {
    const node = workflow[id];
    const injected = node && node.runtime_injected ? t("（运行时动态注入）") : "";
    const label = (node && node.class_type) || "?";
    const idLabel = nodeIdLabel(id);
    const lines = [label + (idLabel ? ` ${idLabel}` : "") + injected];
    const inputs = (node && node.inputs) || {};
    const filled = (node && node.tpl_filled) || {};
    for (const [k, v] of Object.entries(inputs)) {
        if (Array.isArray(v) && typeof v[0] === "string") lines.push(`${k}: ← ${nodeRefLabel(v[0], workflow)}`);
        else lines.push(`${k}: ${_fmtVal(v)}${filled[k] ? ` ← ${filled[k]}` : ""}`);
    }
    for (const i of issues || []) lines.push(i.message);
    return lines.join("\n");
}

// 拖拽平移（同画布体验）：滚动区内按住拖动 → 平移 scrollLeft/Top；内容未超出时自然无效。
// pointer 事件优先，环境无 PointerEvent（老浏览器）回落 mouse 事件
function attachDragPan(svg, scroller) {
    const hasPointer = typeof window.PointerEvent !== "undefined";
    const downT = hasPointer ? "pointerdown" : "mousedown";
    const moveT = hasPointer ? "pointermove" : "mousemove";
    const upT = hasPointer ? "pointerup" : "mouseup";
    let drag = null;
    svg.addEventListener(downT, (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        drag = { x: e.clientX, y: e.clientY, sl: scroller.scrollLeft, st: scroller.scrollTop };
        try { if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId); } catch (err) { /* mouse 事件无 pointerId */ }
        e.preventDefault();
    });
    window.addEventListener(moveT, (e) => {
        if (!drag) return;
        scroller.scrollLeft = drag.sl - (e.clientX - drag.x);
        scroller.scrollTop = drag.st - (e.clientY - drag.y);
    }, { passive: false });
    const end = () => { drag = null; };
    window.addEventListener(upT, end);
    svg.addEventListener("pointercancel", end);
}

// 复制缺失项名称：优先异步 Clipboard API；不可用（非安全上下文等）回落 execCommand。按钮上即时反馈 /✗。
function copyName(text, btn) {
    const feedback = (ok) => {
        btn.textContent = ok ? "" : "✗";
        setTimeout(() => { btn.textContent = ""; }, 1000);
    };
    if (typeof navigator.clipboard?.writeText === "function") {
        navigator.clipboard.writeText(text).then(() => feedback(true), () => feedback(false));
        return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:absolute;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { /* 环境不支持按失败处理 */ }
    ta.remove();
    feedback(ok);
}

// 尺寸类变量的值由本次请求的宽高算出，预览里显示的是按技能默认尺寸算的那一份
const SIZE_TOKEN_RE = /\{\{(MEGAPIXELS|ASPECT_RATIO|WIDTH|HEIGHT)\}\}/;

/** 被技能设置填掉值的 {{变量}}：图上这一格只剩一个值，芯片把变量名、目标控件与来源设置列出来 */
function filledTokenChips(wf, definitions) {
    const byToken = {};
    for (const id of Object.keys(wf || {}).sort(_sortNodeIds)) {
        const node = wf[id] || {};
        const inputs = node.inputs || {};
        for (const [k, toks] of Object.entries(node.tpl_filled || {})) {
            const rec = (byToken[toks] ||= { token: toks, where: [] });
            const note = widgetTargetNote(definitions, node.class_type, k);
            rec.where.push(tf("{cls} #{id} · {field} = {value}{note}",
                { cls: node.class_type || "?", id, field: k, value: _fmtVal(inputs[k]), note: note ? `（${note}）` : "" }));
        }
    }
    return Object.values(byToken);
}

// /object_info 的 widget 类型名 → 中文控件名（未知类型原样显示）
const WIDGET_TYPE_LABEL = {
    COMBO: "下拉", STRING: "文本", INT: "整数", FLOAT: "数值", FLOAT64: "数值",
    BOOLEAN: "开关", IMAGE: "图片", MASK: "遮罩", LATENT: "Latent", CONDITIONING: "Conditioning",
};

/** 目标控件说明：这个字段能填什么。combo 列前几项、数值与整数带上下限；定义取不到（无 ComfyUI、
 *  拉取失败、该字段是连线输入）返回空串，芯片只写节点与字段名。 */
function widgetTargetNote(definitions, cls, field) {
    const input = definitions && cls && definitions[cls] ? definitions[cls].input : null;
    const spec = input ? ((input.required || {})[field] || (input.optional || {})[field]) : null;
    if (!Array.isArray(spec)) return "";
    const rule = (typeof spec[1] === "object" && spec[1]) || {};
    const range = (kind) => (rule.min !== undefined && rule.max !== undefined)
        ? tf("{kind} {min}–{max}", { kind, min: rule.min, max: rule.max }) : kind;
    if (Array.isArray(spec[0])) {   // combo：首项是选项数组
        const opts = spec[0].filter((o) => typeof o === "string");
        const head = opts.slice(0, 5).join(" / ");
        return opts.length > 5
            ? tf("下拉 {n} 项：{opts} …", { n: opts.length, opts: head })
            : tf("下拉 {n} 项：{opts}", { n: opts.length, opts: head });
    }
    if (typeof spec[0] === "number") {   // 数值 widget：首项是默认值，第二项带 min / max / step
        return range(Number.isInteger(spec[0]) && Number.isInteger(rule.step ?? 1) ? "整数" : "数值");
    }
    if (typeof spec[0] === "string") {
        if (spec[0] === "INT" || spec[0].startsWith("FLOAT")) return range(spec[0] === "INT" ? "整数" : "数值");
        return WIDGET_TYPE_LABEL[spec[0]] || spec[0];
    }
    return "";
}

// 变量 → 对应的技能设置项名：tooltip 说清去哪儿改这个值
const TOKEN_SETTING_LABEL = {
    MODEL: "主模型", TEXT_ENCODER: "Text Encoder", VAE: "VAE", LORA: "LoRA",
    COUNT: "生图张数", PREFIX: "输出前缀", STEPS: "步数", SEED: "种子（每次随机）",
};

/** 这个值从哪项技能设置算出来（芯片 tooltip 与导入说明的「来源」行）。values 是灌进模板的那份设置值。
 *  尺寸一律以「长边尺寸 × 默认比例」为主语——技能里真正要写的就这两项，设置面板也是这两个词；
 *  megapixels 是这两项算出来的派生值（技能 config 与画布 widget 都没有它自己的设置项），所以它只作为算式结果出现。
 *  非尺寸类变量只指设置项名。 */
function tokenSourceNote(token, values) {
    if (!values) return "";
    // 生视频的宽高是设置里的直接值，没有「长边尺寸 × 比例」这层算式，不编一个来源出来
    const base = Number(values.base_resolution) > 0 ? Number(values.base_resolution) : 0;
    if (!base) return "";
    const ratio = String(values._ratio_text || values.ASPECT_RATIO || "1:1").trim();
    if (token === "{{MEGAPIXELS}}" && values.WIDTH && values.HEIGHT)
        return tf("长边尺寸 {base} × 比例 {ratio} → {w}×{h} ÷ 1024² 算出 {v} MP（生成时按本次宽高重算）",
            { base, ratio, w: values.WIDTH, h: values.HEIGHT, v: values.MEGAPIXELS });
    if (token === "{{ASPECT_RATIO}}") return tf("来源：技能设置「默认比例」{ratio}", { ratio });
    if (token === "{{WIDTH}}" || token === "{{HEIGHT}}")
        return tf("长边尺寸 {base} × 比例 {ratio}", { base, ratio });
    const label = TOKEN_SETTING_LABEL[token.slice(2, -2)];
    return label ? tf("来源：技能设置「{label}」", { label: t(label) }) : "";
}

/** 导入画布那一刻要交代的话：画布上没有 {{变量}}，技能模板里的变量被设置灌成了写死值。
 *  一行一个变量，主语是「长边尺寸 × 比例」这两项真设置，megapixels 写成算出来的结果。 */
export function filledTokenNotes(wf, values, definitions) {
    const notes = filledTokenChips(wf, definitions).map((tk) => {
        const where = tk.where.length === 1 ? tk.where[0]
            : tf("{n} 处：{where}", { n: tk.where.length, where: tk.where.join(" / ") });
        const src = tokenSourceNote(tk.token, values);
        const runtime = SIZE_TOKEN_RE.test(tk.token)
            ? t("生成时按本次宽高重算")
            : t("生成时按本次技能设置填入");
        return [tk.token, where, src, runtime].filter(Boolean).join(" · ");
    });
    return notes.length > 6 ? [...notes.slice(0, 6), tf("… 共 {n} 个变量", { n: notes.length })] : notes;
}

/** 把流程图画进 container（先清空旧内容）；summaryTarget 提供时摘要行画到滚动区外，
 *  filledValues 是灌进模板的那份设置值（变量芯片靠它写「来源」：哪项设置、怎么算出这个数）。
 *  返回 { svg, summary }。 */
export function renderWorkflowGraph(container, workflow, validation, summaryTarget, filledValues) {
    container.innerHTML = "";
    // 合成节点（autogrow 合并）不在原始 workflow 里，tooltip 需要合并后的图
    const wf = collapseRefLoaders(workflow || {});
    const layout = layoutWorkflow(wf);
    const issues = (validation && validation.issues) || {};

    const svg = svgEl("svg", {
        class: "rs-wf-svg", width: layout.width, height: layout.height,
        viewBox: `0 0 ${layout.width} ${layout.height}`,
    });
    const byId = Object.fromEntries(layout.nodes.map(n => [n.id, n]));

    // 连线在下层：终点精确落在目标节点对应参数行上（小圆点标记落点）；不同连线用不同颜色便于区分
    for (let i = 0; i < layout.edges.length; i++) {
        const e = layout.edges[i];
        const a = byId[e.from], b = byId[e.to];
        const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = e.targetY ?? b.y + b.h / 2;
        const mx = (x1 + x2) / 2;
        const g = svgEl("g", { class: `rs-wf-edge-c${i % EDGE_COLORS}` });
        g.appendChild(svgEl("path", {
            class: "rs-wf-edge", d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
        }));
        g.appendChild(svgEl("circle", { class: "rs-wf-edge-dot", cx: x2, cy: y2, r: 2.5 }));
        svg.appendChild(g);
    }

    for (const n of layout.nodes) {
        const list = issues[n.id] || [];
        const hasError = list.some(i => i.kind === "missing_node" || i.kind === "missing_model");
        const hasTpl = list.some(i => i.kind === "template");
        const cls = ["rs-wf-node"];
        if (hasError) cls.push("rs-wf-node-bad");
        else if (hasTpl) cls.push("rs-wf-node-tpl");
        const g = svgEl("g", { class: cls.join(" "), transform: `translate(${n.x} ${n.y})` });
        // tooltip：渲染后的输入值（连线/模板变量/问题行）
        const title = svgEl("title");
        title.textContent = nodeTooltip(n.id, wf, list);
        g.appendChild(title);
        g.appendChild(svgEl("rect", { class: "rs-wf-node-box", width: n.w, height: n.h, rx: 8 }));
        const labelMax = Math.floor((n.w - NODE_PAD_X) / TYPE_CHAR_W);
        const label = n.classType.length > labelMax ? n.classType.slice(0, labelMax - 1) + "…" : n.classType;
        const t1 = svgEl("text", { class: "rs-wf-node-type", x: 10, y: 19 });
        t1.textContent = label;
        g.appendChild(t1);
        const idLabel = nodeIdLabel(n.id);
        if (idLabel) {
            const t2 = svgEl("text", { class: "rs-wf-node-id", x: 10, y: 35 });
            t2.textContent = idLabel;
            g.appendChild(t2);
        }
        // 参数行直接画在节点上（截断/折叠），完整值由 tooltip 补全
        let ty = inputFirstY(n.id);
        for (const line of n.lines) {
            const ti = svgEl("text", { class: "rs-wf-node-input", x: 10, y: ty });
            ti.textContent = line;
            g.appendChild(ti);
            ty += INPUT_LINE_H;
        }
        if (hasError || hasTpl) {
            g.appendChild(svgEl("circle", {
                class: hasError ? "rs-wf-badge rs-wf-badge-error" : "rs-wf-badge rs-wf-badge-tpl",
                cx: n.w - 12, cy: 12, r: 7,
            }));
        }
        svg.appendChild(g);
    }
    container.appendChild(svg);
    attachDragPan(svg, container); // 内容超出滚动区时可按住拖拽平移（同画布体验）

    // 问题摘要（无问题时隐藏）：计数行 + 缺失项芯片（节点/模型名称 + 复制按钮，同名去重按节点 id 排序）
    const summary = document.createElement("div");
    summary.className = "rs-wf-summary";
    const c = (validation && validation.counts) || { missingNodes: 0, missingModels: 0, templates: 0 };
    const tokenChips = filledTokenChips(wf, validation && validation.definitions);
    const parts = [];
    if (c.missingNodes) parts.push(tf("{n} 个节点未安装", { n: c.missingNodes }));
    if (c.missingModels) parts.push(tf("{n} 个模型缺失", { n: c.missingModels }));
    if (c.templates) parts.push(tf("{n} 个模板变量运行时填入", { n: c.templates }));
    if (tokenChips.length) parts.push(tf("{n} 个变量由技能设置填入", { n: tokenChips.length }));
    const countLine = document.createElement("div");
    countLine.className = "rs-wf-summary-count";
    countLine.textContent = parts.join(" · ");
    summary.appendChild(countLine);
    const missingItems = [];
    const seenMissing = new Set();
    for (const id of Object.keys(issues).sort(_sortNodeIds)) {
        for (const i of issues[id] || []) {
            if (i.kind !== "missing_node" && i.kind !== "missing_model") continue;
            const key = `${i.kind}\u0000${i.value}`;
            if (!i.value || seenMissing.has(key)) continue;
            seenMissing.add(key);
            missingItems.push(i);
        }
    }
    if (missingItems.length) {
        const chipsRow = document.createElement("div");
        chipsRow.className = "rs-wf-missing";
        for (const i of missingItems) {
            const chip = document.createElement("span");
            chip.className = `rs-wf-missing-item${i.kind === "missing_node" ? " rs-wf-missing-node" : ""}`;
            chip.title = i.message;
            const name = document.createElement("span");
            name.className = "rs-wf-missing-name";
            name.textContent = i.value;
            const btn = document.createElement("button");
            btn.className = "rs-wf-copy";
            btn.type = "button";
            btn.textContent = "";
            btn.title = t("复制名称");
            btn.onclick = () => copyName(i.value, btn);
            chip.append(name, btn);
            chipsRow.appendChild(chip);
        }
        summary.appendChild(chipsRow);
    }
    // 变量芯片：值被设置填走后图上只剩数字，这里把 {{变量名}} 列出来并可复制
    // （标题三段：目标 = 填进哪个节点哪个控件、能填什么；来源 = 由哪项技能设置算出；生成时 = 会不会重算）
    if (tokenChips.length) {
        const tokenRow = document.createElement("div");
        tokenRow.className = "rs-wf-tokens";
        for (const tk of tokenChips) {
            const chip = document.createElement("span");
            chip.className = "rs-wf-token-item";
            const sizeVar = SIZE_TOKEN_RE.test(tk.token);
            const lines = [t("目标："), ...tk.where];
            const source = tokenSourceNote(tk.token, filledValues);
            if (source) lines.push(source);
            lines.push(sizeVar
                ? t("生成时按本次请求的宽高重算，图上这个值只是按技能默认尺寸的预览值")
                : t("生成时按本次技能设置填入"));
            chip.title = lines.join("\n");
            const name = document.createElement("span");
            name.className = "rs-wf-missing-name";
            name.textContent = tk.token;
            const btn = document.createElement("button");
            btn.className = "rs-wf-copy";
            btn.type = "button";
            btn.textContent = "";
            btn.title = t("复制变量");
            btn.onclick = () => copyName(tk.token, btn);
            chip.append(name, btn);
            tokenRow.appendChild(chip);
        }
        summary.appendChild(tokenRow);
    }
    // 分阶段渲染会多次调用本函数，summaryTarget 是外部持久元素，必须整体替换而不是追加
    if (summaryTarget) summaryTarget.replaceChildren(summary);
    else container.appendChild(summary);
    return { svg, summary };
}
