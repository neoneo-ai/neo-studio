// 画布的手势层：平移 / 缩放 / 拖节点 / 尺寸柄 / 拉线 / 框选 / 删除与方向键 nudge，
// 以及素材卡片从 Gallery 拖进来那一发。
//
// 手势状态（pan / drag / marquee / resizing / connecting / spaceDown）留在这一个闭包里，
// 画布内容本身是页面的：一律经 host.getState() 读、经 host 交下来的回调写，改完由页面重画。
import { t } from "../../../js/core/i18n.js";
import { getConnectionDropTarget, marqueeSelect, panViewport, resizeNode, screenToCanvas, zoomViewportAt } from "./geometry.js";

const NUDGE = 8, NUDGE_BIG = 40;
const NEO_GALLERY_MIME = "application/x-neo-gallery";
// 一条连线是两个 path（宽命中描边 + 可见细线），点哪一条都算点这条线
const LINE_SELECTOR = ".ns-canvas-line, .ns-canvas-line-hit";

/** 把手势挂到舞台上：stage 是那一页的舞台元素，view 交出要画手势层（world 上画框选框），
 *  host 是页面交下来的读写面（见 createCanvasPage 里那一份 host）。 */
export function attachCanvasInteractions({ stage, view, host }) {
    let pan = null, drag = null, marquee = null, resizing = null, connecting = null;
    let spaceDown = false;

    const state = () => host.getState();
    const worldPoint = (clientX, clientY) => screenToCanvas(state().viewport, clientX, clientY, stage.getBoundingClientRect());

    // 滚轮缩放锚在指针上（passive: false 才拦得住 preventDefault，否则浏览器连页面一起滚）
    stage.addEventListener("wheel", (e) => {
        if (!host.isPageActive() || e.target.closest(".ns-canvas-bar")) return;
        e.preventDefault();
        const rect = stage.getBoundingClientRect();
        host.setViewport(zoomViewportAt(state().viewport, e.clientX - rect.left, e.clientY - rect.top, e.deltaY));
    }, { passive: false });
    stage.addEventListener("pointerdown", (e) => onPointerDown(e));
    stage.addEventListener("dblclick", (e) => onDoubleClick(e));
    stage.addEventListener("dragover", (e) => {
        if (!host.isPageActive() || !galleryPayload(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    });
    stage.addEventListener("drop", (e) => onDrop(e));
    // 拖动与拉线要跑到容器外还在跟手，收笔统一交给 window（上游同一形状）
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", (e) => { if (e.code === "Space") spaceDown = false; });

    function onPointerDown(e) {
        if (!host.isPageActive()) return;
        const { ids } = host.getSelection();
        const isBackground = !e.target.closest(`.ns-canvas-node, ${LINE_SELECTOR}`);
        // 中键直接平移；空格 / Ctrl 是临时抓手（上游 temporaryTool 那一条）
        if (e.button === 1 || ((spaceDown || e.ctrlKey) && isBackground)) {
            e.preventDefault();
            pan = { startX: e.clientX, startY: e.clientY, viewport: { ...state().viewport } };
            stage.classList.add("ns-canvas-grabbing");
            return;
        }
        if (e.button !== 0) return;
        const handleEl = e.target.closest(".ns-canvas-handle");
        if (handleEl) {
            const nodeId = handleEl.closest(".ns-canvas-node").dataset.nodeId;
            connecting = { handle: { handleType: handleEl.dataset.handle, nodeId },
                mouseWorld: worldPoint(e.clientX, e.clientY), targetId: null, isNearNode: false };
            e.preventDefault();
            host.paintActive(connecting);
            return;
        }
        const cornerEl = e.target.closest(".ns-canvas-resize");
        if (cornerEl) {
            const node = state().nodes.find((n) => n.id === cornerEl.closest(".ns-canvas-node").dataset.nodeId);
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
            host.setSelection([], lineEl.dataset.connectionId);
            e.preventDefault();
            return;
        }
        // 空白处起手 = 框选（Shift 加选：起点那一刻的选中集当基准）
        const world = worldPoint(e.clientX, e.clientY);
        marquee = { startWorldX: world.x, startWorldY: world.y, currentWorldX: world.x, currentWorldY: world.y,
            additive: e.shiftKey, base: e.shiftKey ? [...ids] : [] };
        if (!e.shiftKey) host.setSelection([], null);
    }

    function startNodeDrag(e) {
        const ids = [...host.getSelection().ids];
        drag = { startX: e.clientX, startY: e.clientY, moved: false,
            initial: new Map(state().nodes.filter((n) => ids.includes(n.id)).map((n) => [n.id, { ...n.position }])) };
    }

    function onPointerMove(e) {
        if (pan) {
            host.setViewport(panViewport(pan.viewport, pan.startX, pan.startY, e.clientX, e.clientY));
            return;
        }
        if (drag) {
            // 屏幕位移除以 k 才是世界位移：缩到 50% 时鼠标走 100px，节点在世界上要走 200px
            const dx = (e.clientX - drag.startX) / state().viewport.k;
            const dy = (e.clientY - drag.startY) / state().viewport.k;
            if (Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
            // 落点一律从起手那一份快照算：每帧交的是绝对位置，帧与帧之间不累加位移
            host.setNodePositions([...drag.initial].map(([id, pos]) => [id, { x: pos.x + dx, y: pos.y + dy }]));
            return;
        }
        if (resizing) {
            const out = resizeNode(resizing.startNode, resizing.corner,
                (e.clientX - resizing.startX) / state().viewport.k,
                (e.clientY - resizing.startY) / state().viewport.k, resizing.keepRatio);
            host.applyResize(resizing.nodeId, out);
            return;
        }
        if (connecting) {
            const world = worldPoint(e.clientX, e.clientY);
            const drop = getConnectionDropTarget(world, state().nodes, connecting.handle, state().viewport.k);
            connecting = { ...connecting, mouseWorld: world, targetId: drop.nodeId, isNearNode: drop.isNearNode };
            host.paintActive(connecting);
            return;
        }
        if (marquee) {
            const world = worldPoint(e.clientX, e.clientY);
            marquee.currentWorldX = world.x;
            marquee.currentWorldY = world.y;
            const box = { left: Math.min(marquee.startWorldX, world.x), top: Math.min(marquee.startWorldY, world.y),
                width: Math.abs(world.x - marquee.startWorldX), height: Math.abs(world.y - marquee.startWorldY) };
            host.setSelection(marqueeSelect(state().nodes, box, marquee.base), null);
            paintMarquee();
        }
    }

    function onPointerUp() {
        if (pan) {
            pan = null;
            stage.classList.remove("ns-canvas-grabbing");
        }
        if (drag) {
            if (drag.moved) host.markDirty();
            drag = null;
        }
        if (resizing) {
            resizing = null;
            host.markDirty();
        }
        if (connecting) {
            if (connecting.targetId) host.connect(connecting.handle.nodeId, connecting.targetId);
            else host.toast(t("连线要落在一个节点上"), "info");   // 落在空白处要说话，不能松手就没声
            connecting = null;
            host.paintActive(null);
        }
        if (marquee) {
            marquee = null;
            paintMarquee();
        }
    }

    /** 点节点选它（上游 selectNodeByEvent）：Shift / Ctrl / Cmd 加选或减选；
     *  点在已选中的一组里时不动选中集，整组照拖 */
    function selectNode(id, e) {
        const { ids } = host.getSelection();
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
            const next = new Set(ids);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            host.setSelection([...next], null);
        } else {
            // 点在已选中的一组里时不动选中集，整组照拖
            host.setSelection(ids.has(id) ? [...ids] : [id], null);
        }
    }

    function onDoubleClick(e) {
        if (!host.isPageActive() || e.target.closest(".ns-canvas-bar")) return;
        const nodeEl = e.target.closest(".ns-canvas-node");
        if (nodeEl) {
            const node = state().nodes.find((n) => n.id === nodeEl.dataset.nodeId);
            if (node?.type === "text") nodeEl.querySelector("textarea")?.focus();   // 双击正文 = 进编辑
            return;
        }
        host.addNode("text", worldPoint(e.clientX, e.clientY));   // 空白处双击 = 就地写一句提示词
    }

    function onKeyDown(e) {
        if (!host.isPageActive()) return;
        const { ids } = host.getSelection();
        const typing = document.activeElement?.classList?.contains("ns-canvas-node-textarea");
        if (e.code === "Space" && !typing) { spaceDown = true; e.preventDefault(); return; }
        if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "Escape") { host.setSelection([], null); return; }
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); host.deleteSelection(); return; }
        const step = e.shiftKey ? NUDGE_BIG : NUDGE;
        const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!by || !ids.size) return;
        e.preventDefault();
        host.moveSelected([...ids], by[0], by[1]);
        host.markDirty();   // 方向键那一步没有收笔可等，落点在键盘上
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
        if (!host.isPageActive()) return;
        const picked = galleryPayload(e);
        if (!picked) return;
        e.preventDefault();
        host.addNode("image", worldPoint(e.clientX, e.clientY), picked);
    }

    function paintMarquee() {
        const box = view.world.querySelector(".ns-canvas-marquee");
        if (!marquee) { box?.remove(); return; }
        const x = Math.min(marquee.startWorldX, marquee.currentWorldX);
        const y = Math.min(marquee.startWorldY, marquee.currentWorldY);
        const w = Math.abs(marquee.currentWorldX - marquee.startWorldX);
        const h = Math.abs(marquee.currentWorldY - marquee.startWorldY);
        const css = { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` };
        if (box) Object.assign(box.style, css);
        else view.world.appendChild(host.$el("div", { className: "ns-canvas-marquee", style: css }));
    }
}


