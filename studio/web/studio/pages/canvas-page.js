// Neo Studio「画布」页：图片节点与提示词节点铺在一张无限画布上，连线串起生成顺序。
//
// 引擎层移植自 infinite-canvas（MIT License, Copyright (c) 2026 basketikun），上游 commit
// 9cd3deacbcc598361807afc16c059a80dd18b6f9（2026-10-25），全文见仓库 LICENSES/infinite-canvas.txt。
// 移植的是纯几何部分，函数名与算法保持与上游一一对应：screenToCanvas / zoomViewportAt（上游
// handleWheel）/ gridGeometry（上游 CanvasGrid）/ nodeBounds / getConnectionTargetAnchor /
// normalizeConnection / getConnectionDropTarget（上游 project.tsx 同名 useCallback）/
// connectionPathD 与 activeConnectionPathD（上游 canvas-connections.tsx 的 ConnectionPath /
// ActiveConnectionPath）/ resizeNode（上游 canvas-node.tsx handleResizeMove）。
// 上游的 React 组件层、useCanvasState 持久化 hooks、dnd-kit 拖拽层、富文本节点编辑器、minimap、
// 分组缩放与 Config 节点都不在这一次移植里：本页是 vanilla 页，持久化走 studio/canvas.py 的
// /neo_canvas/*，节点只有 image 与 text 两类，normalizeConnection 因此没有上游那几条 Config
// 分支，方向就是「拖出的一端 → 落下的一端」。
import { t } from "../../js/core/i18n.js";
import { setIcon, setIconLabel } from "../../js/core/icons.js";

/** @typedef {{x: number, y: number}} Position */
/** @typedef {{x: number, y: number, k: number}} Viewport 世界层变换：translate(x,y) scale(k) */
/** @typedef {{x: number, y: number}} Rect 画布容器在屏幕上的矩形（getBoundingClientRect 那一份） */
/** @typedef {{handleType: "source" | "target", nodeId: string}} ConnectionHandle */
/** @typedef {{id: string, type: "image" | "text", title: string, position: Position, width: number, height: number, metadata: Object}} CanvasNodeData */
/** @typedef {{id: string, fromNodeId: string, toNodeId: string}} CanvasConnection */
/** @typedef {{id: string, title: string, nodes: CanvasNodeData[], connections: CanvasConnection[], viewport: Viewport, backgroundMode: string}} CanvasState */

export const GRID_SIZE = 48;
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 5;
// 连线命中半径（上游 project.tsx）：屏幕像素，落到世界里要除以 k，缩到多远都点得中
export const CONNECTION_HANDLE_HIT_RADIUS = 40;
export const CONNECTION_NODE_HIT_PADDING = 32;
export const CONNECTION_HIT_WIDTH = 16;
export const MIN_NODE_WIDTH = 220;
export const MIN_NODE_HEIGHT = 160;
export const BACKGROUND_MODES = ["dots", "lines", "blank"];
export const NODE_SPECS = {
    image: { width: 340, height: 240, title: "图片" },
    text: { width: 340, height: 240, title: "提示词" },
};

/** 屏幕点 → 世界点（上游 screenToCanvas：先减容器原点，再除以 k） */
export function screenToCanvas(viewport, clientX, clientY, rect) {
    return {
        x: (clientX - (rect?.left || 0) - viewport.x) / viewport.k,
        y: (clientY - (rect?.top || 0) - viewport.y) / viewport.k,
    };
}

/** 世界点 → 屏幕点（浮层要钉在节点上方时用它） */
export function canvasToScreen(viewport, x, y, rect) {
    return { x: x * viewport.k + (rect?.left || 0) + viewport.x, y: y * viewport.k + (rect?.top || 0) + viewport.y };
}

/** 滚轮缩放，锚在指针上（上游 handleWheel：1.1^(delta/100)，缩到 5%–500%；
 *  传进来的是容器内坐标）：锚点那一格缩放前后必须是同一个世界点，
 *  否则每滚一格画面就往指针那一侧滑走 */
export function zoomViewportAt(viewport, localX, localY, deltaY) {
    const k = Math.min(Math.max(viewport.k * Math.pow(1.1, -deltaY / 100), MIN_SCALE), MAX_SCALE);
    return {
        x: localX - ((localX - viewport.x) / viewport.k) * k,
        y: localY - ((localY - viewport.y) / viewport.k) * k,
        k,
    };
}

/** 平移（上游 handlePointerMove：起始视口 + 屏幕位移，k 不动） */
export function panViewport(viewport, startX, startY, clientX, clientY) {
    return { x: viewport.x + (clientX - startX), y: viewport.y + (clientY - startY), k: viewport.k };
}

/** 网格几何（上游 CanvasGrid）：格距 48 * k，视口原点取模让格子跟着画面走；
 *  缩到 0.12 以下点要变小，否则整片糊成灰 */
export function gridGeometry(viewport) {
    const gridSize = GRID_SIZE * viewport.k;
    return {
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${viewport.x % gridSize}px ${viewport.y % gridSize}px`,
        fine: viewport.k < 0.12,
    };
}

/** 一叠节点的外接矩形（上游 nodeBounds）：空表回 null，「适应内容」在空画布上不该把画面甩飞 */
export function nodeBounds(nodes) {
    const box = nodes.reduce((acc, node) => ({
        left: Math.min(acc.left, node.position.x),
        top: Math.min(acc.top, node.position.y),
        right: Math.max(acc.right, node.position.x + node.width),
        bottom: Math.max(acc.bottom, node.position.y + node.height),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    return Number.isFinite(box.left) ? box : null;
}

/** 连线的三次贝塞尔（上游 ConnectionPath）：出在源节点右中、落在目标节点左中，曲率取
 *  max(水平距离 * 0.5, 50) —— 两个节点贴在一起时也要弯出一段看得清的弧 */
export function connectionPathD(from, to) {
    const ends = connectionEnds(from, to);
    return `M ${ends.start.x} ${ends.start.y} C ${ends.start.x + ends.curvature} ${ends.start.y},`
        + ` ${ends.end.x - ends.curvature} ${ends.end.y}, ${ends.end.x} ${ends.end.y}`;
}

/** 贝塞尔两端与曲率（命中采样与浮层定位都要真实端点） */
export function connectionEnds(from, to) {
    const start = { x: from.position.x + from.width, y: from.position.y + from.height / 2 };
    const end = { x: to.position.x, y: to.position.y + to.height / 2 };
    return { start, end, curvature: Math.max(Math.abs(end.x - start.x) * 0.5, 50) };
}

/** 拉线中的那一条虚线（上游 ActiveConnectionPath）：源端钉在节点上、悬空那头跟手；
 *  落到候选节点上时把悬空那头吸到候选节点的锚点 */
export function activeConnectionPathD(node, handle, mouseWorld, target) {
    if (!node) return "";
    const isSource = handle.handleType === "source";
    const fromNode = isSource ? node : target;
    const toNode = isSource ? target : node;
    const from = fromNode ? { x: fromNode.position.x + fromNode.width, y: fromNode.position.y + fromNode.height / 2 }
        : { x: mouseWorld.x, y: mouseWorld.y };
    const to = toNode ? { x: toNode.position.x, y: toNode.position.y + toNode.height / 2 }
        : { x: mouseWorld.x, y: mouseWorld.y };
    const distance = Math.abs(to.x - from.x);
    return `M ${from.x} ${from.y} C ${from.x + distance * 0.5} ${from.y},`
        + ` ${to.x - distance * 0.5} ${to.y}, ${to.x} ${to.y}`;
}

/** 世界点落在那一段连线上吗（上游是 pointerEvents:stroke 的 16px 透明描边，
 *  vanilla 侧按同一宽度采样同一条贝塞尔）：命中阈值除以 k，缩多远都点得中 */
export function hitConnection(world, from, to, scale) {
    const { start, end, curvature } = connectionEnds(from, to);
    const limit = (CONNECTION_HIT_WIDTH / 2) / Math.max(scale, MIN_SCALE);
    for (let i = 0; i <= 24; i += 1) {
        const t = i / 24;
        const a = (1 - t) * (1 - t) * (1 - t), b = 3 * (1 - t) * (1 - t) * t;
        const c = 3 * (1 - t) * t * t, d = t * t * t;
        const px = a * start.x + b * (start.x + curvature) + c * (end.x - curvature) + d * end.x;
        const py = a * start.y + b * start.y + c * end.y + d * end.y;
        if (Math.hypot(world.x - px, world.y - py) <= limit) return true;
    }
    return false;
}

/** 拖线时候选节点的落点锚（上游 getConnectionTargetAnchor）：从右侧拖出要落在目标的左中，
 *  从左侧拖出要落在目标的右中 —— 方向反过来的话线会在节点上绕一圈 */
export function getConnectionTargetAnchor(node, handle) {
    return {
        x: handle.handleType === "source" ? node.position.x : node.position.x + node.width,
        y: node.position.y + node.height / 2,
    };
}

/** 连线方向归一化（上游 normalizeConnection，去掉 Config 与分组的分支）：拖出的那一端是源、
 *  落下那一端是目标；自己连自己与节点不在表上时谈不拢，回 null */
export function normalizeConnection(firstNodeId, secondNodeId, nodes) {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second || first.id === second.id) return null;
    return { fromNodeId: first.id, toNodeId: second.id };
}


/** 拉线松手时落在哪儿（上游 getConnectionDropTarget）：后画的节点优先，
 *  命中顺序是「节点内 > 锚点半径内 > 节点外扩 32/k」，半径全都除以 k */
export function getConnectionDropTarget(world, nodes, handle, scale) {
    const padding = CONNECTION_NODE_HIT_PADDING / Math.max(scale, MIN_SCALE);
    const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / Math.max(scale, MIN_SCALE);
    let isNearNode = false;
    let bestNodeId = null;
    let bestPriority = Number.POSITIVE_INFINITY;
    for (const node of [...nodes].reverse()) {
        const anchor = getConnectionTargetAnchor(node, handle);
        const hitsHandle = Math.hypot(world.x - anchor.x, world.y - anchor.y) <= handleRadius;
        const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width
            && world.y >= node.position.y && world.y <= node.position.y + node.height;
        const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding
            && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;
        if (!hitsHandle && !hitsInside && !hitsExpanded) continue;
        isNearNode = true;
        if (node.id === handle.nodeId || !normalizeConnection(handle.nodeId, node.id, nodes)) continue;
        const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
        if (priority < bestPriority) {
            bestNodeId = node.id;
            bestPriority = priority;
        }
    }
    return { nodeId: bestNodeId, isNearNode };
}

/** 加一条连线：谈不拢（自己连自己、节点不在表上）原样返回，同方向已存在也不重复画（上游 exists 检查） */
export function addConnection(connections, nodes, firstNodeId, secondNodeId) {
    const normalized = normalizeConnection(firstNodeId, secondNodeId, nodes);
    if (!normalized) return connections;
    if (connections.some((conn) => conn.fromNodeId === normalized.fromNodeId
        && conn.toNodeId === normalized.toNodeId)) return connections;
    return [...connections, { id: `conn-${normalized.fromNodeId}-${normalized.toNodeId}`, ...normalized }];
}

/** 删节点连带删掉两端接在它上面的连线（上游 deleteNodes） */
export function removeNodes(nodes, connections, nodeIds) {
    const ids = new Set(nodeIds);
    return {
        nodes: nodes.filter((node) => !ids.has(node.id)),
        connections: connections.filter((conn) => !ids.has(conn.fromNodeId) && !ids.has(conn.toNodeId)),
    };
}

/** 整体搬一叠节点：吃的是世界位移（上游在调用处把屏幕位移除以 k 再进来） */
export function moveNodes(nodes, nodeIds, dx, dy) {
    const ids = new Set(nodeIds);
    return nodes.map((node) => (ids.has(node.id)
        ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node));
}

/** 框选命中（上游 handleGlobalPointerMove 的 intersects）：AABB 相交即选中；
 *  baseIds 是框前那一批（Shift 框选加选时把旧 selection 传进来） */
export function marqueeSelect(nodes, box, baseIds = []) {
    const picked = new Set(baseIds);
    for (const node of nodes) {
        if (box.left < node.position.x + node.width && box.left + box.width > node.position.x
            && box.top < node.position.y + node.height && box.top + box.height > node.position.y) {
            picked.add(node.id);
        }
    }
    return [...picked];
}

/** 拖角上的尺寸柄（上游 handleResizeMove）：位移是世界位移，最小 220×160；
 *  锁比例时按拖动的主轴算另一边，撑到最小值再按比例补回来；
 *  左/上的柄要把节点原点往回挪，否则右下的角在动、左上角跟着跑 */
export function resizeNode(node, corner, dx, dy, keepRatio) {
    const fromLeft = corner.includes("left");
    const fromTop = corner.includes("top");
    const startRight = node.position.x + node.width;
    const startBottom = node.position.y + node.height;
    let width = Math.max(MIN_NODE_WIDTH, node.width + (fromLeft ? -dx : dx));
    let height = Math.max(MIN_NODE_HEIGHT, node.height + (fromTop ? -dy : dy));
    if (keepRatio) {
        const ratio = node.width / node.height;
        if (Math.abs(dx) >= Math.abs(dy)) height = width / ratio;
        else width = height * ratio;
        if (height < MIN_NODE_HEIGHT) { height = MIN_NODE_HEIGHT; width = height * ratio; }
        if (width < MIN_NODE_WIDTH) { width = MIN_NODE_WIDTH; height = width / ratio; }
    }
    return {
        width,
        height,
        x: fromLeft ? startRight - width : node.position.x,
        y: fromTop ? startBottom - height : node.position.y,
    };
}

/** 节点是否压着另一节点（placeGrid 找空位用） */
export function overlaps(a, b) {
    return a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x
        && a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y;
}

/** 建一个节点（上游 createCanvasNode）：图片节点带素材坐标，文本节点带正文 */
export function createCanvasNode(type, position, metadata = {}) {
    const spec = NODE_SPECS[type] || NODE_SPECS.text;
    return {
        id: `node-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 7)}`,
        type: NODE_SPECS[type] ? type : "text",
        title: metadata.title || spec.title,
        position: { x: position.x, y: position.y },
        width: metadata.width || spec.width,
        height: metadata.height || spec.height,
        metadata,
    };
}

/** 往画布上铺一批节点的落点（上游没有这一层，它是逐个鼠标落点；结果板一次几十张，
 *  要的是不重叠的网格）：从 start 起一行最多 4 个，跳过压着已有节点的格子 */
export function placeGrid(nodes, size, start = { x: 0, y: 0 }, gap = 32, columns = 4) {
    const stepX = size.width + gap, stepY = size.height + gap;
    const probe = { position: { x: 0, y: 0 }, width: size.width, height: size.height };
    for (let row = 0; row < 64; row += 1) {
        for (let col = 0; col < columns; col += 1) {
            probe.position = { x: start.x + col * stepX, y: start.y + row * stepY };
            if (!nodes.some((node) => overlaps(probe, node))) return { ...probe.position };
        }
    }
    return { ...start };
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

/** 读盘形状：缺字段回默认值、未知键整份忽略 —— 旧版页面写的文件与新版页面写的文件都要打得开 */
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

/** 画布页工厂：$el 建元素、api 走 /neo_canvas/*、toast 报话，都由装配层交下来。 */
export function createCanvasPage({ $el, api, toast }) {
    let state = readCanvas({});
    let selectedNodeIds = new Set();
    let selectedConnectionId = null;
    let dirty = false;
    let saveTimer = 0;
    let projects = [];
    let spaceDown = false;
    let pan = null, drag = null, marquee = null, resizing = null, connecting = null;
    let view = null;               // build 之后才有：DOM 引用与每帧要改的那几层
    let ready = null;              // 首次进页把上一张画布读进来的那条 promise

    const SAVE_DEBOUNCE_MS = 900;
    const NUDGE = 8, NUDGE_BIG = 40;
    const NEO_GALLERY_MIME = "application/x-neo-gallery";
    // 一条连线是两个 path（宽命中描边 + 可见细线），点哪一条都算点这条线
    const LINE_SELECTOR = ".ns-canvas-line, .ns-canvas-line-hit";

    // ====== 视图 ======
    function buildCanvas(el) {
        el.classList.add("ns-canvas");
        const page = $el("div", { className: "ns-canvas-page" });
        const bar = buildBar();
        const stage = $el("div", { className: "ns-canvas-stage", tabindex: "0" });
        const grid = $el("div", { className: "ns-canvas-grid" });
        const world = $el("div", { className: "ns-canvas-world" });
        const links = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        links.setAttribute("class", "ns-canvas-links");
        const nodeLayer = $el("div", { className: "ns-canvas-nodes" });
        const active = document.createElementNS("http://www.w3.org/2000/svg", "path");
        active.setAttribute("class", "ns-canvas-active-line");
        const hint = $el("div", { className: "ns-canvas-hint", textContent: t("把图拖进来，或加一个提示词节点") });
        world.append(links, active, nodeLayer);
        stage.append(grid, world, active, hint);
        page.append(bar.root, stage);
        el.appendChild(page);
        view = { el, page, stage, grid, world, links, nodeLayer, active, hint, save: bar.save, zoom: bar.zoom, select: bar.select };
        bindStage(stage);
        applyViewport();
        renderNodes();
        renderConnections();
        ready = loadProjects();
        return ready;
    }

    function buildBar() {
        const select = $el("select", { className: "ns-canvas-select", "aria-label": t("画布") });
        select.addEventListener("change", () => loadProject(select.value));
        const mk = (label, name, fn) => {
            const btn = $el("button", { className: "ns-canvas-tool", type: "button", title: label, "aria-label": label, onclick: fn });
            setIcon(btn, name);
            return btn;
        };
        const mkLabel = (label, name, fn) => {
            const btn = $el("button", { className: "ns-canvas-tool ns-canvas-tool-text", type: "button", title: label, "aria-label": label, onclick: fn });
            setIconLabel(btn, name, label);
            return btn;
        };
        const zoom = $el("span", { className: "ns-canvas-zoom", textContent: "100%" });
        const save = $el("span", { className: "ns-canvas-save", textContent: t("已保存") });
        const root = $el("div", { className: "ns-canvas-bar" }, [
            select,
            mk(t("新建画布"), "plus", () => createProject()),
            mk(t("重命名"), "pencil", () => renameProject()),
            mk(t("删除画布"), "trash", () => deleteProject()),
            $el("span", { className: "ns-canvas-bar-gap" }),
            mkLabel(t("加图片"), "image", () => addNode("image")),
            mkLabel(t("加提示词"), "list", () => addNode("text")),
            $el("span", { className: "ns-canvas-bar-gap" }),
            mk(t("缩小"), "minimize", () => zoomStep(-1)),
            zoom,
            mk(t("放大"), "maximize", () => zoomStep(1)),
            mkLabel(t("适应内容"), "target", () => fitView()),
            mkLabel(t("背景"), "eye", () => cycleBackground()),
            save,
        ]);
        return { root, select, zoom, save };
    }

    /** 视口落到 DOM：世界层一整层 transform，缩放与平移只改这一句（上游同一形状） */
    function applyViewport() {
        if (!view) return;
        view.world.style.transform = `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${state.viewport.k})`;
        const grid = gridGeometry(state.viewport);
        view.grid.style.backgroundSize = grid.backgroundSize;
        view.grid.style.backgroundPosition = grid.backgroundPosition;
        view.grid.className = "ns-canvas-grid"
            + (state.backgroundMode === "lines" ? (grid.fine ? " ns-canvas-grid-lines-fine" : " ns-canvas-grid-lines")
                : state.backgroundMode === "blank" ? " ns-canvas-grid-blank" : "");
        view.zoom.textContent = `${Math.round(state.viewport.k * 100)}%`;
        view.hint.style.display = state.nodes.length ? "none" : "";
    }

    function cssEscape(value) {
        return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
    }

    /** 一个节点的位置与尺寸落到元素上：拖动与缩放每帧走这一条，不重建节点 */
    function applyNodeGeometry(node) {
        const nodeEl = view?.nodeLayer.querySelector(`[data-node-id="${cssEscape(node.id)}"]`);
        if (!nodeEl) return;
        nodeEl.style.left = `${node.position.x}px`;
        nodeEl.style.top = `${node.position.y}px`;
        nodeEl.style.width = `${node.width}px`;
        nodeEl.style.height = `${node.height}px`;
    }

    function renderNodes() {
        if (!view) return;
        view.nodeLayer.replaceChildren(...state.nodes.map((node) => nodeElement(node)));
        // 几何要在元素挂上世界层之后再落：nodeElement 里查不到还没挂上的元素
        for (const node of state.nodes) applyNodeGeometry(node);
        view.hint.style.display = state.nodes.length ? "none" : "";
        renderSelection();
    }

    /** 节点 DOM（上游 canvas-node.tsx 的 vanilla 版）：左右两个接线点、四个角上的尺寸柄。
     *  图片节点是 <img>（走 Gallery 缩略图，取不到落占位图），提示词节点是 <textarea>，
     *  正文存在 metadata.content —— 图片节点上的坐标就是 Gallery 的 filename + subfolder */
    function nodeElement(node) {
        const nodeEl = $el("div", {
            className: "ns-canvas-node " + (node.type === "image" ? "ns-canvas-node-image" : "ns-canvas-node-text"),
            dataset: { nodeId: node.id },
        });
        nodeEl.append(
            $el("div", { className: "ns-canvas-node-head" }, [
                $el("span", { className: "ns-canvas-node-title", textContent: node.title || NODE_SPECS[node.type].title }),
                $el("span", { className: "ns-canvas-node-tag", textContent: node.metadata.hero ? t("主图") : "" }),
            ]),
            $el("div", { className: "ns-canvas-handle ns-canvas-handle-left", dataset: { handle: "target" } }),
            $el("div", { className: "ns-canvas-handle ns-canvas-handle-right", dataset: { handle: "source" } }),
        );
        if (node.type === "image") {
            const filename = node.metadata.filename || "";
            nodeEl.appendChild($el("img", {
                className: "ns-canvas-node-img",
                src: filename
                    ? `/neo_gallery/thumbnail?filename=${encodeURIComponent(filename)}`
                        + `&subfolder=${encodeURIComponent(node.metadata.subfolder || "")}&size=640`
                    : "/neo_gallery/placeholder.png",
                alt: filename || t("图片"),
                draggable: "false",
                // 缩略图缓存不在（刚生成、桌面端离线、素材被移走）时回原图那一条，原图也没有才落占位图
                onerror: (e) => {
                    e.target.src = filename && !e.target.dataset.fallback
                        ? (e.target.dataset.fallback = "1",
                            `/neo_gallery/image?filename=${encodeURIComponent(filename)}`
                            + `&subfolder=${encodeURIComponent(node.metadata.subfolder || "")}&type=output`)
                        : "/neo_gallery/placeholder.png";
                },
            }));
        } else {
            nodeEl.appendChild($el("textarea", {
                className: "ns-canvas-node-textarea",
                value: node.metadata.content || "",
                placeholder: t("写提示词"),
                spellcheck: "false",
                oninput: (e) => { node.metadata = { ...node.metadata, content: e.target.value }; markDirty(); },
                // 正文区要把指针留给打字：从 textarea 上起手不能把节点拖走
                onpointerdown: (e) => e.stopPropagation(),
            }));
        }
        for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
            nodeEl.appendChild($el("div", { className: `ns-canvas-resize ns-canvas-resize-${corner}`, dataset: { corner } }));
        }
        return nodeEl;
    }

    /** 连线画进世界层那一张 svg：世界坐标直接落在 path 上，缩放靠世界层的 transform */
    function renderConnections() {
        if (!view) return;
        const byId = new Map(state.nodes.map((node) => [node.id, node]));
        const paths = [];
        for (const conn of state.connections) {
            const from = byId.get(conn.fromNodeId), to = byId.get(conn.toNodeId);
            if (!from || !to) continue;
            const d = connectionPathD(from, to);
            // 一条透明宽描边负责命中（上游 16px 透明描边同一形状），细的那条只画线
            paths.push($svg("path", { d, class: "ns-canvas-line-hit", dataset: { connectionId: conn.id } }));
            paths.push($svg("path", {
                d,
                class: "ns-canvas-line" + (conn.id === selectedConnectionId ? " ns-canvas-line-on" : ""),
                dataset: { connectionId: conn.id },
            }));
        }
        view.links.replaceChildren(...paths);
    }

    function $svg(tag, opts) {
        const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [key, value] of Object.entries(opts || {})) {
            if (key === "dataset") Object.assign(node.dataset, value);
            else node.setAttribute(key, value);
        }
        return node;
    }

    function renderSelection() {
        if (!view) return;
        for (const nodeEl of view.nodeLayer.children) {
            nodeEl.classList.toggle("ns-canvas-node-on", selectedNodeIds.has(nodeEl.dataset.nodeId));
        }
        for (const path of view.links.children) {
            path.classList.toggle("ns-canvas-line-on", path.dataset.connectionId === selectedConnectionId);
        }
    }

    /** 拉线中的那一条虚线 + 候选节点高亮 */
    function renderActiveConnection() {
        if (!view) return;
        if (!connecting) {
            view.active.setAttribute("d", "");
            for (const nodeEl of view.nodeLayer.children) nodeEl.classList.remove("ns-canvas-node-drop");
            return;
        }
        const node = state.nodes.find((n) => n.id === connecting.handle.nodeId) || null;
        const target = connecting.targetId ? state.nodes.find((n) => n.id === connecting.targetId) : null;
        view.active.setAttribute("d", activeConnectionPathD(node, connecting.handle, connecting.mouseWorld, target || null));
        for (const nodeEl of view.nodeLayer.children) {
            nodeEl.classList.toggle("ns-canvas-node-drop", nodeEl.dataset.nodeId === connecting.targetId);
        }
    }

    function renderMarquee() {
        if (!view) return;
        const box = view.world.querySelector(".ns-canvas-marquee");
        if (!marquee) { box?.remove(); return; }
        const x = Math.min(marquee.startWorldX, marquee.currentWorldX);
        const y = Math.min(marquee.startWorldY, marquee.currentWorldY);
        const w = Math.abs(marquee.currentWorldX - marquee.startWorldX);
        const h = Math.abs(marquee.currentWorldY - marquee.startWorldY);
        const css = { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` };
        if (box) Object.assign(box.style, css);
        else view.world.appendChild($el("div", { className: "ns-canvas-marquee", style: css }));
    }

    // ====== 交互：平移 / 缩放 / 拖动 / 框选 / 拉线 ======
    function pageActive() {
        return !!view && view.el.isConnected && !view.el.classList.contains("ns-hidden");
    }

    function worldPoint(clientX, clientY) {
        const rect = view.stage.getBoundingClientRect();
        return screenToCanvas(state.viewport, clientX, clientY, rect);
    }

    function bindStage(stage) {
        // 滚轮缩放锚在指针上（passive: false 才拦得住 preventDefault，否则浏览器连页面一起滚）
        stage.addEventListener("wheel", (e) => {
            if (!pageActive() || e.target.closest(".ns-canvas-bar")) return;
            e.preventDefault();
            const rect = stage.getBoundingClientRect();
            setViewport(zoomViewportAt(state.viewport, e.clientX - rect.left, e.clientY - rect.top, e.deltaY));
        }, { passive: false });
        stage.addEventListener("pointerdown", (e) => onPointerDown(e));
        stage.addEventListener("dblclick", (e) => onDoubleClick(e));
        stage.addEventListener("dragover", (e) => {
            if (!pageActive() || !galleryPayload(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
        });
        stage.addEventListener("drop", (e) => onDrop(e));
        // 拖动与拉线要跑到容器外还在跟手，收笔统一交给 window（上游同一形状）
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", (e) => { if (e.code === "Space") spaceDown = false; });
    }

    function onPointerDown(e) {
        if (!pageActive()) return;
        const isBackground = !e.target.closest(`.ns-canvas-node, ${LINE_SELECTOR}`);
        // 中键直接平移；空格 / Ctrl 是临时抓手（上游 temporaryTool 那一条）
        if (e.button === 1 || ((spaceDown || e.ctrlKey) && isBackground)) {
            e.preventDefault();
            pan = { startX: e.clientX, startY: e.clientY, viewport: { ...state.viewport } };
            view.stage.classList.add("ns-canvas-grabbing");
            return;
        }
        if (e.button !== 0) return;
        const handleEl = e.target.closest(".ns-canvas-handle");
        if (handleEl) {
            const nodeId = handleEl.closest(".ns-canvas-node").dataset.nodeId;
            connecting = { handle: { handleType: handleEl.dataset.handle, nodeId },
                mouseWorld: worldPoint(e.clientX, e.clientY), targetId: null, isNearNode: false };
            e.preventDefault();
            renderActiveConnection();
            return;
        }
        const cornerEl = e.target.closest(".ns-canvas-resize");
        if (cornerEl) {
            const node = state.nodes.find((n) => n.id === cornerEl.closest(".ns-canvas-node").dataset.nodeId);
            if (!node) return;
            resizing = {
                nodeId: node.id,
                corner: cornerEl.dataset.corner,
                startX: e.clientX, startY: e.clientY,
                startNode: { ...node, position: { ...node.position } },
                // 图片节点锁比例（上游 keepRatio），提示词节点自由缩放
                keepRatio: node.type === "image" && !node.metadata.freeResize,
            };
            e.preventDefault();
            return;
        }
        const nodeEl = e.target.closest(".ns-canvas-node");
        if (nodeEl) {
            selectNode(nodeEl.dataset.nodeId, e);
            startNodeDrag(e);
            e.preventDefault();
            return;
        }
        const lineEl = e.target.closest(LINE_SELECTOR);
        if (lineEl) {
            selectedConnectionId = lineEl.dataset.connectionId;
            selectedNodeIds = new Set();
            renderSelection();
            e.preventDefault();
            return;
        }
        // 空白处起手 = 框选（Shift 加选：起点那一刻的选中集当基准）
        const world = worldPoint(e.clientX, e.clientY);
        marquee = { startWorldX: world.x, startWorldY: world.y, currentWorldX: world.x, currentWorldY: world.y,
            additive: e.shiftKey, base: e.shiftKey ? [...selectedNodeIds] : [] };
        if (!e.shiftKey) { selectedNodeIds = new Set(); selectedConnectionId = null; renderSelection(); }
    }

    function startNodeDrag(e) {
        const ids = [...selectedNodeIds];
        drag = { startX: e.clientX, startY: e.clientY, moved: false,
            initial: new Map(state.nodes.filter((n) => ids.includes(n.id)).map((n) => [n.id, { ...n.position }])) };
    }

    function onPointerMove(e) {
        if (pan) {
            setViewport(panViewport(pan.viewport, pan.startX, pan.startY, e.clientX, e.clientY));
            return;
        }
        if (drag) {
            // 屏幕位移除以 k 才是世界位移：缩到 50% 时鼠标走 100px，节点在世界上要走 200px
            const dx = (e.clientX - drag.startX) / state.viewport.k;
            const dy = (e.clientY - drag.startY) / state.viewport.k;
            if (Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
            for (const [id, pos] of drag.initial) {
                const node = state.nodes.find((n) => n.id === id);
                if (!node) continue;
                node.position = { x: pos.x + dx, y: pos.y + dy };
                applyNodeGeometry(node);
            }
            renderConnections();
            return;
        }
        if (resizing) {
            const node = state.nodes.find((n) => n.id === resizing.nodeId);
            if (!node) return;
            const out = resizeNode(resizing.startNode, resizing.corner,
                (e.clientX - resizing.startX) / state.viewport.k,
                (e.clientY - resizing.startY) / state.viewport.k, resizing.keepRatio);
            node.width = out.width;
            node.height = out.height;
            node.position = { x: out.x, y: out.y };
            applyNodeGeometry(node);
            renderConnections();
            return;
        }
        if (connecting) {
            const world = worldPoint(e.clientX, e.clientY);
            const drop = getConnectionDropTarget(world, state.nodes, connecting.handle, state.viewport.k);
            connecting = { ...connecting, mouseWorld: world, targetId: drop.nodeId, isNearNode: drop.isNearNode };
            renderActiveConnection();
            return;
        }
        if (marquee) {
            const world = worldPoint(e.clientX, e.clientY);
            marquee.currentWorldX = world.x;
            marquee.currentWorldY = world.y;
            const box = { left: Math.min(marquee.startWorldX, world.x), top: Math.min(marquee.startWorldY, world.y),
                width: Math.abs(world.x - marquee.startWorldX), height: Math.abs(world.y - marquee.startWorldY) };
            selectedNodeIds = new Set(marqueeSelect(state.nodes, box, marquee.base));
            renderSelection();
            renderMarquee();
        }
    }

    function onPointerUp() {
        if (pan) {
            pan = null;
            view?.stage.classList.remove("ns-canvas-grabbing");
        }
        if (drag) {
            if (drag.moved) markDirty();
            drag = null;
        }
        if (resizing) {
            resizing = null;
            markDirty();
        }
        if (connecting) {
            if (connecting.targetId) connectNodes(connecting.handle, connecting.targetId);
            else toast(t("连线要落在一个节点上"), "info");   // 落在空白处要说话，不能松手就没声
            connecting = null;
            renderActiveConnection();
        }
        if (marquee) {
            marquee = null;
            renderMarquee();
        }
    }

    /** 点节点选它（上游 selectNodeByEvent）：Shift / Ctrl / Cmd 加选或减选；
     *  点在已选中的一组里时不动选中集，整组照拖 */
    function selectNode(id, e) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
            const next = new Set(selectedNodeIds);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            selectedNodeIds = next;
        } else if (!selectedNodeIds.has(id)) {
            selectedNodeIds = new Set([id]);
        }
        selectedConnectionId = null;
        renderSelection();
    }

    function connectNodes(handle, targetNodeId) {
        const next = addConnection(state.connections, state.nodes, handle.nodeId, targetNodeId);
        if (next.length === state.connections.length) return;   // 同方向已有这条线：静默沿用，不叠第二条
        state = { ...state, connections: next };
        renderConnections();
        markDirty();
    }

    function onDoubleClick(e) {
        if (!pageActive() || e.target.closest(".ns-canvas-bar")) return;
        const nodeEl = e.target.closest(".ns-canvas-node");
        if (nodeEl) {
            const node = state.nodes.find((n) => n.id === nodeEl.dataset.nodeId);
            if (node?.type === "text") nodeEl.querySelector("textarea")?.focus();   // 双击正文 = 进编辑
            return;
        }
        addNode("text", worldPoint(e.clientX, e.clientY));   // 空白处双击 = 就地写一句提示词
    }

    function onKeyDown(e) {
        if (!pageActive()) return;
        const typing = document.activeElement?.classList?.contains("ns-canvas-node-textarea");
        if (e.code === "Space" && !typing) { spaceDown = true; e.preventDefault(); return; }
        if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "Escape") {
            selectedNodeIds = new Set();
            selectedConnectionId = null;
            renderSelection();
            return;
        }
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); return; }
        const step = e.shiftKey ? NUDGE_BIG : NUDGE;
        const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!by || !selectedNodeIds.size) return;
        e.preventDefault();
        state = { ...state, nodes: moveNodes(state.nodes, [...selectedNodeIds], by[0], by[1]) };
        for (const node of state.nodes) if (selectedNodeIds.has(node.id)) applyNodeGeometry(node);
        renderConnections();
        markDirty();
    }

    /** 删选中的东西：选中一条线先删线，否则删选中那批节点连带两端接上的线 */
    function deleteSelection() {
        if (selectedConnectionId) {
            state = { ...state, connections: state.connections.filter((c) => c.id !== selectedConnectionId) };
            selectedConnectionId = null;
            renderConnections();
            renderSelection();
            markDirty();
            return;
        }
        if (!selectedNodeIds.size) return;
        state = { ...state, ...removeNodes(state.nodes, state.connections, [...selectedNodeIds]) };
        selectedNodeIds = new Set();
        renderNodes();
        renderConnections();
        markDirty();
    }

    // ====== 视口动作 ======
    function setViewport(next) {
        state = { ...state, viewport: next };
        applyViewport();
        markDirty();   // 视口也要落盘：回页时看到的必须是上次离开时的那一片
    }

    function centerWorld() {
        const rect = view.stage.getBoundingClientRect();
        return screenToCanvas(state.viewport, rect.left + rect.width / 2, rect.top + rect.height / 2, rect);
    }

    function zoomStep(dir) {
        const rect = view.stage.getBoundingClientRect();
        setViewport(zoomViewportAt(state.viewport, rect.width / 2, rect.height / 2, dir * -120));
    }

    /** 适应内容：整叠节点装进视口居中（空画布回到原点 100%，不把画面甩到无穷远） */
    function fitView() {
        const rect = view.stage.getBoundingClientRect();
        const bounds = nodeBounds(state.nodes);
        if (!bounds) { setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 }); return; }
        const pad = 80;
        const k = Math.min(Math.max(Math.min(
            (rect.width - pad * 2) / Math.max(bounds.right - bounds.left, 1),
            (rect.height - pad * 2) / Math.max(bounds.bottom - bounds.top, 1),
        ), MIN_SCALE), MAX_SCALE);
        setViewport({
            x: (rect.width - (bounds.right - bounds.left) * k) / 2 - bounds.left * k,
            y: (rect.height - (bounds.bottom - bounds.top) * k) / 2 - bounds.top * k,
            k,
        });
    }

    function cycleBackground() {
        const next = BACKGROUND_MODES[(BACKGROUND_MODES.indexOf(state.backgroundMode) + 1) % BACKGROUND_MODES.length];
        state = { ...state, backgroundMode: next };
        applyViewport();
        markDirty();
    }

    /** 加一个节点：落点走 placeGrid，不压已有节点（拖放与「摆到画布」都从这一条进） */
    function addNode(type, at = null, metadata = {}) {
        const spec = NODE_SPECS[type] || NODE_SPECS.text;
        const start = at ? { x: at.x - spec.width / 2, y: at.y - spec.height / 2 } : centerWorld();
        const node = createCanvasNode(type, placeGrid(state.nodes, spec, start), metadata);
        state = { ...state, nodes: [...state.nodes, node] };
        selectedNodeIds = new Set([node.id]);
        selectedConnectionId = null;
        renderNodes();
        renderConnections();
        markDirty();
        return node;
    }

    // ====== Gallery 拖放 ======
    /** 素材卡片的载荷（gallery-card.js 写的 application/x-neo-gallery）；回退 text/plain 的文件名 */
    function galleryPayload(e) {
        const dt = e.dataTransfer;
        if (!dt || typeof dt.getData !== "function") return null;
        const raw = dt.getData(NEO_GALLERY_MIME) || dt.getData("text/plain");
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            return parsed?.filename ? { filename: parsed.filename, subfolder: parsed.subfolder || "" } : null;
        } catch {
            // 素材卡片在 iframe 边界外传不进自定义 mime，只剩 text/plain 的文件名
            return /^[^\s/\\]+\.[A-Za-z0-9]{1,5}$/.test(raw.trim())
                ? { filename: raw.trim(), subfolder: "" } : null;
        }
    }

    function onDrop(e) {
        if (!pageActive()) return;
        const picked = galleryPayload(e);
        if (!picked) return;
        e.preventDefault();
        addNode("image", worldPoint(e.clientX, e.clientY), picked);
    }

    // ====== 落盘：改一下就存一次，攒 900ms ======
    function markDirty() {
        dirty = true;
        view.save.textContent = t("未保存");
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveProject, SAVE_DEBOUNCE_MS);
    }

    async function saveProject() {
        clearTimeout(saveTimer);
        if (!dirty) return;
        dirty = false;
        view.save.textContent = t("保存中");
        try {
            const resp = await api.fetchApi("/neo_canvas/project", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(serializeCanvas(state)),
            });
            const data = await resp.json().catch(() => null);
            if (!resp.ok || !data?.success) throw new Error(data?.error || resp.statusText);
            state = { ...state, id: data.id, title: data.title };
            view.save.textContent = t("已保存");
            // 新建的那张要自己进列表：不补这一条的话下拉里永远找不到它
            const at = projects.findIndex((p) => p.id === data.id);
            const meta = { id: data.id, title: data.title,
                node_count: state.nodes.length, connection_count: state.connections.length };
            if (at >= 0) projects[at] = { ...projects[at], ...meta };
            else projects.push(meta);
            fillProjectSelect();
        } catch (err) {
            dirty = true;   // 没写进去的改动留着：下一次去保存还会再来一发
            view.save.textContent = t("保存失败");
            toast(`${t("保存失败")}：${err.message}`, "error");
        }
    }

    /** 切页与关窗前调用：攒着的改动不能只留在内存里 */
    function flush() {
        clearTimeout(saveTimer);
        if (dirty) saveProject();
    }

    function fillProjectSelect() {
        view.select.replaceChildren(...projects.map((p) => $el("option", { value: p.id, textContent: p.title })));
        view.select.value = state.id || "";
    }

    async function loadProjects() {
        try {
            const resp = await api.fetchApi("/neo_canvas/list");
            const data = await resp.json().catch(() => null);
            projects = data?.success ? data.projects : [];
        } catch {
            projects = [];   // 列表读不出来就当空：页面照样能铺，保存会把真原因报出来
        }
        fillProjectSelect();
        if (projects.length) await loadProject(projects[0].id);
    }

    async function loadProject(id) {
        flush();
        let data;
        try {
            const resp = await api.fetchApi(`/neo_canvas/project?id=${encodeURIComponent(id)}`);
            data = await resp.json().catch(() => null);
            if (!resp.ok || !data?.success) throw new Error(data?.error || resp.statusText);
        } catch (err) {
            toast(`${t("画布读不出来")}：${err.message}`, "error");
            return;
        }
        state = readCanvas(data.project);
        selectedNodeIds = new Set();
        selectedConnectionId = null;
        dirty = false;
        view.save.textContent = t("已保存");
        view.select.value = state.id;
        renderNodes();
        renderConnections();
        applyViewport();
    }

    async function createProject() {
        const name = window.prompt(t("新建画布"), t("未命名画布"));
        if (name === null) return;
        flush();
        state = readCanvas({ title: name.trim() || t("未命名画布"),
            viewport: state.viewport, background_mode: state.backgroundMode });
        selectedNodeIds = new Set();
        selectedConnectionId = null;
        renderNodes();
        renderConnections();
        dirty = true;
        await saveProject();
    }

    async function renameProject() {
        if (!state.id) { toast(t("这张画布还没存过，先加一个节点"), "info"); return; }
        const name = window.prompt(t("重命名画布"), state.title);
        if (!name) return;
        try {
            const resp = await api.fetchApi("/neo_canvas/rename", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: state.id, title: name.trim() }),
            });
            const data = await resp.json().catch(() => null);
            if (!resp.ok || !data?.success) throw new Error(data?.error || resp.statusText);
            state = { ...state, title: data.title };
            // 下拉里那条也要跟着改名：只改 state.title 的话列表还挂着旧名字
            const at = projects.findIndex((p) => p.id === data.id);
            if (at >= 0) projects[at] = { ...projects[at], title: data.title };
            fillProjectSelect();
        } catch (err) {
            toast(`${t("重命名失败")}：${err.message}`, "error");
        }
    }

    async function deleteProject() {
        if (!state.id) { toast(t("这张画布还没存过，没有可删的"), "info"); return; }
        if (!window.confirm(`${t("删除画布")}「${state.title}」：${t("节点与连线一起删掉，删完不能撤销")}`)) return;
        try {
            const resp = await api.fetchApi("/neo_canvas/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: state.id }),
            });
            const data = await resp.json().catch(() => null);
            if (!resp.ok || !data?.success) throw new Error(data?.error || resp.statusText);
        } catch (err) {
            toast(`${t("删除失败")}：${err.message}`, "error");
            return;
        }
        dirty = false;
        await loadProjects();
    }

    /** 结果板与绘画页的「摆到画布」落点：主图排最前，其余按不重叠网格铺在视口中心 */
    async function placeItems(items) {
        await ready;
        const list = (items || []).filter((item) => item?.filename);
        if (!list.length) { toast(t("没有可摆放的图"), "info"); return false; }
        const spec = NODE_SPECS.image;
        const ordered = [...list].sort((a, b) => Number(b.hero === true) - Number(a.hero === true));
        const base = centerWorld();
        const start = { x: base.x - spec.width, y: base.y - spec.height / 2 };
        const pool = [...state.nodes];
        const placed = [];
        for (const item of ordered) {
            const node = createCanvasNode("image", placeGrid(pool, spec, start), {
                filename: item.filename,
                subfolder: item.subfolder || "",
                hero: item.hero === true,
            });
            pool.push(node);
            placed.push(node);
        }
        state = { ...state, nodes: [...state.nodes, ...placed] };
        selectedNodeIds = new Set(placed.map((node) => node.id));
        selectedConnectionId = null;
        renderNodes();
        renderConnections();
        markDirty();
        fitView();   // 一次摆几十张时画面要自己拉回来，否则铺在看不见的地方
        toast(t("已摆到画布"), "success");
        return true;
    }

    return { build: buildCanvas, flush, placeItems, current: () => state };
}
