// 节点层：节点 DOM、几何落位与选中描边。节点不铺标题栏 —— 图与正文撑满整张节点，附加操作
// （选图 / 设为主图 / 复制 / 删除）是右上角那一排，只在该节点被选中时浮出来（CSS 认 .ns-canvas-node-on）。
// 节点上的动作都从这里的元素出发，回调交给页面；手势不在这一层（在 interactions.js）。
import { t } from "../../../js/core/i18n.js";
import { setIcon, setIconLabel } from "../../../js/core/icons.js";

/** 节点 DOM（上游 canvas-node.tsx 的 vanilla 版）：内容铺满整张，右上角是附加操作栏，左上角是「主图」徽标，
 *  左右两个接线点、四个角上的尺寸柄。图片节点是 <img>（走 Gallery 缩略图，取不到落占位图），提示词节点是
 *  <textarea>，正文存在 metadata.content —— 图片节点上的坐标就是 Gallery 的 filename + subfolder */
export function nodeElement(node, { $el, onText, onPick, onHero, onDelete, onCopy }) {
    const nodeEl = $el("div", {
        className: "ns-canvas-node " + (node.type === "image" ? "ns-canvas-node-image" : "ns-canvas-node-text"),
        dataset: { nodeId: node.id },
    });
    nodeEl.append(
        node.type === "image" ? nodeImage(node, $el) : nodeText(node, $el, onText),
        nodeBar(node, { $el, onPick, onHero, onDelete, onCopy }),
        $el("div", { className: "ns-canvas-handle ns-canvas-handle-left", dataset: { handle: "target" } }),
        $el("div", { className: "ns-canvas-handle ns-canvas-handle-right", dataset: { handle: "source" } }),
    );
    if (node.metadata.hero) {
        nodeEl.appendChild($el("span", { className: "ns-canvas-node-tag", textContent: t("主图") }));
    }
    for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
        nodeEl.appendChild($el("div", { className: `ns-canvas-resize ns-canvas-resize-${corner}`, dataset: { corner } }));
    }
    return nodeEl;
}

/** 图片节点的内容：整张就是那张图，缩略图缓存不在（刚生成、桌面端离线、素材被移走）时回原图那一条，
 *  原图也没有才落占位图 */
function nodeImage(node, $el) {
    const filename = node.metadata.filename || "";
    return $el("img", {
        className: "ns-canvas-node-img",
        src: filename
            ? `/neo_gallery/thumbnail?filename=${encodeURIComponent(filename)}`
                + `&subfolder=${encodeURIComponent(node.metadata.subfolder || "")}&size=640`
            : "/neo_gallery/placeholder.png",
        alt: filename || t("图片"),
        draggable: "false",
        onerror: (e) => {
            e.target.src = filename && !e.target.dataset.fallback
                ? (e.target.dataset.fallback = "1",
                    `/neo_gallery/image?filename=${encodeURIComponent(filename)}`
                    + `&subfolder=${encodeURIComponent(node.metadata.subfolder || "")}&type=output`)
                : "/neo_gallery/placeholder.png";
        },
    });
}

/** 提示词节点的内容：整张就是那块正文。单击不落焦点 —— 浏览器在 mousedown 上默认把焦点交给 textarea，
 *  焦点在里面时 Ctrl+C/V/X/A 全归浏览器自己，节点就再也剪不动了。进编辑是双击（interactions.js 的
 *  onDoubleClick 给焦点），落了焦点之后不拦 —— 划词与光标动作照旧（拖过一截才挪节点，见 TEXT_DRAG_GATE） */
function nodeText(node, $el, onText) {
    return $el("textarea", {
        className: "ns-canvas-node-textarea",
        value: node.metadata.content || "",
        placeholder: t("写提示词"),
        spellcheck: "false",
        onmousedown: (e) => { if (document.activeElement !== e.target) e.preventDefault(); },
        oninput: (e) => onText(node, e.target.value),
    });
}

/** 附加操作栏：图片节点多一枚主图钮（整片只留一枚），没填上图的多一枚「选图」，复制与删除每类节点都有。
 *  这一排默认不出现，节点被选中时才浮出来；点了算 click，起手不拖（见 interactions.js） */
function nodeBar(node, { $el, onPick, onHero, onDelete, onCopy }) {
    const act = (name, label, fn) => {
        const btn = $el("button", { className: "ns-canvas-node-act", type: "button",
            title: label, "aria-label": label, dataset: { nodeAct: name }, onclick: fn });
        setIcon(btn, name === "delete" ? "circle-x" : name === "copy" ? "copy" : "circle-check");
        return btn;
    };
    const kids = [];
    if (node.type === "image") {
        const heroLabel = node.metadata.hero ? t("取消主图") : t("设为主图");
        const hero = act("hero", heroLabel, () => onHero(node));
        if (node.metadata.hero) hero.classList.add("ns-canvas-node-act-on");
        kids.push(hero);
        if (!node.metadata.filename) {
            const pick = $el("button", { className: "ns-canvas-node-pick", type: "button",
                title: t("选图"), "aria-label": t("选图"), dataset: { nodeAct: "pick" }, onclick: () => onPick(node) });
            setIconLabel(pick, "image", t("选图"));
            kids.push(pick);
        }
    }
    kids.push(act("copy", t("复制节点"), () => onCopy(node)));
    kids.push(act("delete", t("删除节点"), () => onDelete(node)));
    return $el("div", { className: "ns-canvas-node-bar" }, kids);
}

/** 整层节点重画：拖动与缩放不走这一条（走 applyNodeGeometry），换画布、增删节点才走 */
export function renderNodes({ nodeLayer, links, hint, nodes, selectedNodeIds, selectedConnectionId, $el, onText, onPick, onHero, onDelete, onCopy }) {
    nodeLayer.replaceChildren(...nodes.map((node) => nodeElement(node, { $el, onText, onPick, onHero, onDelete, onCopy })));
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
