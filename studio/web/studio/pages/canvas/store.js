// 画布的数据契约与落盘：节点规格、建节点、存盘/读盘形状，以及 /neo_canvas/* 五条路由的请求。
// 从 canvas-page.js 拆出：页面只留自己那份 state，读写全走这里的 createCanvasStore。
// 落盘形状（serializeCanvas）与读盘兜底（readCanvas）是页面与 studio/canvas.py 之间唯一的契约：
// 旧版页面写的文件与新版页面写的文件都要打得开，缺字段回默认值、未知键整份忽略。
import { t } from "../../../js/core/i18n.js";
import { MAX_SCALE, MIN_SCALE } from "./geometry.js";

/** @typedef {{x: number, y: number}} Position */
/** @typedef {{id: string, type: "image" | "text" | "gen", title: string, position: Position, width: number, height: number, metadata: Object}} CanvasNodeData */
/** @typedef {{id: string, fromNodeId: string, toNodeId: string}} CanvasConnection */
/** @typedef {{id: string, title: string, nodes: CanvasNodeData[], connections: CanvasConnection[], viewport: {x: number, y: number, k: number}, backgroundMode: string}} CanvasState */

export const BACKGROUND_MODES = ["dots", "lines", "blank"];
export const NODE_SPECS = {
    image: { width: 340, height: 240, title: "图片" },
    text: { width: 340, height: 240, title: "提示词" },
    gen: { width: 320, height: 208, title: "生成" },
};

/** 建一个节点（上游 createCanvasNode）：图片节点带素材坐标，文本节点带正文 */
export function createCanvasNode(type, position, metadata = {}) {
    const spec = NODE_SPECS[type] || NODE_SPECS.text;
    return {
        id: `node-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 7)}`,
        type: NODE_SPECS[type] ? type : "text",
        title: metadata.title || spec.title,
        position,
        width: metadata.width || spec.width,
        height: metadata.height || spec.height,
        metadata,
    };
}

/** 复制选中的那批：新 id、偏移落位、metadata 整份带上。两端都在选中集里的连线跟着复制，
 *  跨出选中集的连线不跟 —— 复制出去的那一张不该凭空接上原节点 */
export function duplicateNodes(nodes, connections, ids, offset = { x: 36, y: 36 }) {
    const picked = nodes.filter((node) => ids.includes(node.id));
    const clones = picked.map((node) => ({
        ...createCanvasNode(node.type, { x: node.position.x + offset.x, y: node.position.y + offset.y }, { ...node.metadata }),
        title: node.title, width: node.width, height: node.height,
    }));
    const copyId = new Map(picked.map((node, at) => [node.id, clones[at].id]));
    return {
        nodes: clones,
        connections: connections.filter((conn) => copyId.has(conn.fromNodeId) && copyId.has(conn.toNodeId))
            .map((conn) => ({ id: `conn-${copyId.get(conn.fromNodeId)}-${copyId.get(conn.toNodeId)}`,
                fromNodeId: copyId.get(conn.fromNodeId), toNodeId: copyId.get(conn.toNodeId) })),
        ids: clones.map((node) => node.id),
    };
}

/** 存盘形状（studio/canvas.py 收的那一份） */
export function serializeCanvas(state) {
    return {
        id: state.id,
        title: state.title,
        nodes: state.nodes,
        connections: state.connections,
        viewport: state.viewport,
        background_mode: state.backgroundMode,
    };
}

/** 读盘形状：缺字段回默认值、未知键整份忽略 —— 旧版页面写的文件与新版页面写的文件都要打得开。
 *  生成节点（type: "gen"）落在旧版页面里会回落成提示词节点，metadata 整份留着，写回不丢参数 */
export function readCanvas(data) {
    const payload = data && typeof data === "object" ? data : {};
    const nodes = [];
    for (const raw of (Array.isArray(payload.nodes) ? payload.nodes : [])) {
        if (!raw || typeof raw !== "object" || !raw.id) continue;
        const spec = NODE_SPECS[raw.type] || NODE_SPECS.text;
        nodes.push({
            id: String(raw.id),
            type: NODE_SPECS[raw.type] ? raw.type : "text",
            title: raw.title ? String(raw.title) : spec.title,
            position: { x: Number((raw.position || {}).x) || 0, y: Number((raw.position || {}).y) || 0 },
            width: Number(raw.width) > 0 ? Number(raw.width) : spec.width,
            height: Number(raw.height) > 0 ? Number(raw.height) : spec.height,
            metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {},
        });
    }
    const ids = new Set(nodes.map((node) => node.id));
    // 端点不在表上、以及自己连自己的连线都画不出路径，读进来就丢
    const connections = (Array.isArray(payload.connections) ? payload.connections : [])
        .filter((conn) => conn && conn.fromNodeId !== conn.toNodeId
            && ids.has(conn.fromNodeId) && ids.has(conn.toNodeId))
        .map((conn) => ({ id: String(conn.id || `conn-${conn.fromNodeId}-${conn.toNodeId}`),
            fromNodeId: conn.fromNodeId, toNodeId: conn.toNodeId }));
    const viewport = payload.viewport && typeof payload.viewport === "object" ? payload.viewport : {};
    const k = Number(viewport.k) > 0 ? Number(viewport.k) : 1;
    return {
        id: payload.id ? String(payload.id) : "",
        title: payload.title ? String(payload.title) : t("未命名画布"),
        nodes,
        connections,
        viewport: { x: Number(viewport.x) || 0, y: Number(viewport.y) || 0, k: Math.min(Math.max(k, MIN_SCALE), MAX_SCALE) },
        backgroundMode: BACKGROUND_MODES.includes(payload.background_mode) ? payload.background_mode : "dots",
    };
}

/** 画布项目的读写：请求形状与返回解析都在这一处，成功回解析好的 data，失败抛真原因（页面把话报给用户）。
 *  list 是唯一不抛的：列表读不出来就当空，页面照样能铺，保存会把真原因报出来。 */
export function createCanvasStore({ api }) {
    const post = async (path, payload) => {
        const resp = await api.fetchApi(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data?.success) throw new Error(data?.error || resp.statusText);
        return data;
    };
    return {
        async list() {
            try {
                const resp = await api.fetchApi("/neo_canvas/list");
                const data = await resp.json().catch(() => null);
                return data?.success ? data.projects : [];
            } catch {
                return [];
            }
        },
        async get(id) {
            const resp = await api.fetchApi(`/neo_canvas/project?id=${encodeURIComponent(id)}`);
            const data = await resp.json().catch(() => null);
            if (!resp.ok || !data?.success) throw new Error(data?.error || resp.statusText);
            return data.project;
        },
        save(state) { return post("/neo_canvas/project", serializeCanvas(state)); },
        rename(id, title) { return post("/neo_canvas/rename", { id, title: String(title).trim() }); },
        remove(id) { return post("/neo_canvas/delete", { id }); },
    };
}
