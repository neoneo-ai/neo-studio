// 连线层：贝塞尔路径画进世界层那张 svg，加上拉线中的虚线与候选节点高亮。
// 命中靠那条透明宽描边（.ns-canvas-line-hit），细的那条只负责看得见。
import { activeConnectionPathD, connectionPathD } from "./geometry.js";

/** 连线画进世界层那一张 svg：世界坐标直接落在 path 上，缩放靠世界层的 transform */
export function renderConnections({ links, connections, nodes, selectedConnectionId }) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const paths = [];
    for (const conn of connections) {
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
    links.replaceChildren(...paths);
}

/** 拉线中的那一条虚线 + 候选节点高亮：connecting 是手势层那份拉线状态（handle/mouseWorld/targetId） */
export function renderActiveConnection({ active, nodeLayer, connecting, nodes }) {
    if (!connecting) {
        active.setAttribute("d", "");
        for (const nodeEl of nodeLayer.children) nodeEl.classList.remove("ns-canvas-node-drop");
        return;
    }
    const node = nodes.find((n) => n.id === connecting.handle.nodeId) || null;
    const target = connecting.targetId ? nodes.find((n) => n.id === connecting.targetId) : null;
    active.setAttribute("d", activeConnectionPathD(node, connecting.handle, connecting.mouseWorld, target || null));
    for (const nodeEl of nodeLayer.children) {
        nodeEl.classList.toggle("ns-canvas-node-drop", nodeEl.dataset.nodeId === connecting.targetId);
    }
}

function $svg(tag, opts) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(opts || {})) {
        if (key === "dataset") Object.assign(node.dataset, value);
        else node.setAttribute(key, value);
    }
    return node;
}
