// 画布几何层：视口变换、网格、节点矩形、连线路径与命中测试。纯计算，不碰 DOM，也不 import 兄弟模块。
// 「摆到画布」要找的不重叠落位、拉线时的候选节点、缩到 5% 还点得中的连线，全从这一层出。
//
// 引擎层移植自 infinite-canvas（MIT License, Copyright (c) 2026 basketikun），上游 commit
// 9cd3deacbcc598361807afc16c059a80dd18b6f9（2026-10-25），全文见仓库 LICENSES/infinite-canvas.txt。
// 移植的是纯几何部分，函数名与算法保持与上游一一对应：screenToCanvas / zoomViewportAt（上游
// handleWheel）/ gridGeometry（上游 CanvasGrid）/ nodeBounds / getConnectionTargetAnchor /
// normalizeConnection / getConnectionDropTarget（上游 project.tsx 同名 useCallback）/
// connectionPathD 与 activeConnectionPathD（上游 canvas-connections.tsx 的 ConnectionPath /
// ActiveConnectionPath）/ resizeNode（上游 canvas-node.tsx handleResizeMove）/ placeGrid 与 connectionAxis
// 是本仓库自己加的（上游是逐个鼠标落点，结果板一次几十张要的是网格；上游只有左右两枚接线点，
// 上下叠放那一列要竖轴的线）。
/** @typedef {{x: number, y: number}} Position */
/** @typedef {{x: number, y: number, k: number}} Viewport 世界层变换：translate(x,y) scale(k) */
/** @typedef {{x: number, y: number}} Rect 画布容器在屏幕上的矩形（getBoundingClientRect 那一份） */
/** @typedef {{handleType: "source" | "target", nodeId: string}} ConnectionHandle */

export const GRID_SIZE = 48;
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 5;
// 连线命中半径（上游 project.tsx）：屏幕像素，落到世界里要除以 k，缩到多远都点得中
export const CONNECTION_HANDLE_HIT_RADIUS = 40;
export const CONNECTION_NODE_HIT_PADDING = 32;
export const CONNECTION_HIT_WIDTH = 16;
export const MIN_NODE_WIDTH = 220;
export const MIN_NODE_HEIGHT = 160;

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

/** 连线的三次贝塞尔（上游 ConnectionPath）：出在源节点的出接线点、落在目标节点的入接线点，
 *  曲率沿两点那根轴取 max(轴上距离 * 0.5, 50) —— 两个节点贴在一起时也要弯出一段看得清的弧 */
export function connectionPathD(from, to) {
    const { start, end, curvature } = connectionEnds(from, to);
    const { c1, c2 } = bezierControls(start, end, curvature, connectionAxis(from, to));
    return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
}

/** 贝塞尔两端与曲率（命中采样与浮层定位都要真实端点） */
export function connectionEnds(from, to) {
    const sides = linkSides(from, to);
    const start = sidePoint(from, sides.from);
    const end = sidePoint(to, sides.to);
    const span = sides.from === "top" || sides.from === "bottom"
        ? Math.abs(end.y - start.y) : Math.abs(end.x - start.x);
    return { start, end, curvature: Math.max(span * 0.5, 50) };
}

/** 连线走横轴还是竖轴（串联展开把正文铺在车厢正上方、参考素材铺在正下方）：两节点在横向上有交
 *  就是上下叠放，线从上下两面进出，不再绕着节点画一个大弧；正好贴边不算叠放，照旧走左右 */
export function connectionAxis(from, to) {
    const overlap = Math.min(from.position.x + from.width, to.position.x + to.width)
        - Math.max(from.position.x, to.position.x);
    return overlap > 0 ? "y" : "x";
}

/** 拉线中的那一条虚线（上游 ActiveConnectionPath）：源端钉在起手那一枚接线点上、悬空那头跟手；
 *  落到候选节点上时把悬空那头吸到候选节点迎过来的那一面 */
export function activeConnectionPathD(node, handle, mouseWorld, target) {
    if (!node) return "";
    const isSource = handle.handleType === "source";
    const own = sidePoint(node, handle.side || (isSource ? "right" : "left"));
    const src = isSource ? own : (target ? sidePoint(target, linkSides(target, node).from) : mouseWorld);
    const dst = isSource ? (target ? sidePoint(target, linkSides(node, target).to) : mouseWorld) : own;
    const axis = target ? connectionAxis(node, target)
        : (handle.side === "top" || handle.side === "bottom" ? "y" : "x");
    const { c1, c2 } = bezierControls(src, dst,
        Math.max(Math.abs(axis === "y" ? dst.y - src.y : dst.x - src.x) * 0.5, 50), axis);
    return `M ${src.x} ${src.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${dst.x} ${dst.y}`;
}

/** 世界点落在那一段连线上吗（上游是 pointerEvents:stroke 的 16px 透明描边，
 *  vanilla 侧按同一宽度采样同一条贝塞尔）：命中阈值除以 k，缩多远都点得中 */
export function hitConnection(world, from, to, scale) {
    const { start, end, curvature } = connectionEnds(from, to);
    const { c1, c2 } = bezierControls(start, end, curvature, connectionAxis(from, to));
    const limit = (CONNECTION_HIT_WIDTH / 2) / Math.max(scale, MIN_SCALE);
    for (let i = 0; i <= 24; i += 1) {
        const t = i / 24;
        const a = (1 - t) * (1 - t) * (1 - t), b = 3 * (1 - t) * (1 - t) * t;
        const c = 3 * (1 - t) * t * t, d = t * t * t;
        const px = a * start.x + b * c1.x + c * c2.x + d * end.x;
        const py = a * start.y + b * c1.y + c * c2.y + d * end.y;
        if (Math.hypot(world.x - px, world.y - py) <= limit) return true;
    }
    return false;
}

/** 拖线时候选节点的落点锚（上游 getConnectionTargetAnchor）：横着并排时从右侧拖出要落在目标的左中、
 *  从左侧拖出要落在目标的右中 —— 方向反过来的话线会在节点上绕一圈。知道起手那台节点（origin）时按
 *  上下叠放落顶边 / 底边中点：串联的正文在车厢正上方，就近落车厢顶边，不必绕到左中 */
export function getConnectionTargetAnchor(node, handle, origin = null) {
    const isSource = handle.handleType === "source";
    if (origin && origin.id !== node.id) {
        const sides = isSource ? linkSides(origin, node) : linkSides(node, origin);
        return sidePoint(node, isSource ? sides.to : sides.from);
    }
    return { x: isSource ? node.position.x : node.position.x + node.width, y: node.position.y + node.height / 2 };
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
    const origin = nodes.find((node) => node.id === handle.nodeId) || null;
    let isNearNode = false;
    let bestNodeId = null;
    let bestPriority = Number.POSITIVE_INFINITY;
    for (const node of [...nodes].reverse()) {
        const anchor = getConnectionTargetAnchor(node, handle, origin);
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

/** 连线两端各走节点的哪一面：横轴固定右出左入（ComfyUI 的口径，目标在源左边那一条照旧绕出去）；
 *  竖轴按谁在谁下方 —— 在下方的一台收线，上面那一台出线 */
function linkSides(from, to) {
    if (connectionAxis(from, to) !== "y") return { from: "right", to: "left" };
    const down = (to.position.y + to.height / 2) >= (from.position.y + from.height / 2);
    return { from: down ? "bottom" : "top", to: down ? "top" : "bottom" };
}

/** 节点某一面的接线点（四枚接线点与连线端点共用这一份算法） */
function sidePoint(node, side) {
    const midX = node.position.x + node.width / 2, midY = node.position.y + node.height / 2;
    if (side === "left") return { x: node.position.x, y: midY };
    if (side === "top") return { x: midX, y: node.position.y };
    if (side === "bottom") return { x: midX, y: node.position.y + node.height };
    return { x: node.position.x + node.width, y: midY };
}

/** 贝塞尔的两个控制点：曲率沿两点那根轴外扩，横轴左右弯、竖轴上下弯（画线与命中采样同一套） */
function bezierControls(start, end, curvature, axis) {
    if (axis === "y") {
        const sign = end.y >= start.y ? 1 : -1;
        return { c1: { x: start.x, y: start.y + sign * curvature }, c2: { x: end.x, y: end.y - sign * curvature } };
    }
    return { c1: { x: start.x + curvature, y: start.y }, c2: { x: end.x - curvature, y: end.y } };
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
