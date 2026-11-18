// 节点层：节点 DOM、几何落位与选中描边。节点上的动作（改正文、以后要加的「选图」「设为主图」「删除」）
// 都从这里的元素上出发，回调交给页面；手势不在这一层（在 interactions.js）。
import { t } from "../../../js/core/i18n.js";
import { NODE_SPECS } from "./store.js";

/** 节点 DOM（上游 canvas-node.tsx 的 vanilla 版）：左右两个接线点、四个角上的尺寸柄。
 *  图片节点是 <img>（走 Gallery 缩略图，取不到落占位图），提示词节点是 <textarea>，
 *  正文存在 metadata.content —— 图片节点上的坐标就是 Gallery 的 filename + subfolder */
export function nodeElement(node, { $el, onText }) {
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
            oninput: (e) => onText(node, e.target.value),
            // 正文区要把指针留给打字：从 textarea 上起手不能把节点拖走
            onpointerdown: (e) => e.stopPropagation(),
        }));
    }
    for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
        nodeEl.appendChild($el("div", { className: `ns-canvas-resize ns-canvas-resize-${corner}`, dataset: { corner } }));
    }
    return nodeEl;
}

/** 整层节点重画：拖动与缩放不走这一条（走 applyNodeGeometry），换画布、增删节点才走 */
export function renderNodes({ nodeLayer, links, hint, nodes, selectedNodeIds, selectedConnectionId, $el, onText }) {
    nodeLayer.replaceChildren(...nodes.map((node) => nodeElement(node, { $el, onText })));
    // 几何要在元素挂上世界层之后再落：nodeElement 里查不到还没挂上的元素
    for (const node of nodes) applyNodeGeometry(nodeLayer, node);
    hint.style.display = nodes.length ? "none" : "";
    paintSelection({ nodeLayer, links, selectedNodeIds, selectedConnectionId });
}

/** 一个节点的位置与尺寸落到元素上：拖动与缩放每帧走这一条，不重建节点 */
export function applyNodeGeometry(nodeLayer, node) {
    const nodeEl = nodeLayer?.querySelector(`[data-node-id="${cssEscape(node.id)}"]`);
    if (!nodeEl) return;
    nodeEl.style.left = `${node.position.x}px`;
    nodeEl.style.top = `${node.position.y}px`;
    nodeEl.style.width = `${node.width}px`;
    nodeEl.style.height = `${node.height}px`;
}

/** 选中描边：节点一层 class，连线一层 class（换选中与删完东西之后都要重扫一遍） */
export function paintSelection({ nodeLayer, links, selectedNodeIds, selectedConnectionId }) {
    for (const nodeEl of nodeLayer.children) {
        nodeEl.classList.toggle("ns-canvas-node-on", selectedNodeIds.has(nodeEl.dataset.nodeId));
    }
    for (const path of links.children) {
        path.classList.toggle("ns-canvas-line-on", path.dataset.connectionId === selectedConnectionId);
    }
}

function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
}
