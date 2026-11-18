// 画布的手势层：平移 / 缩放 / 拖节点 / 尺寸柄 / 拉线 / 框选 / 删除与方向键 nudge，
// 以及素材卡片从 Gallery 拖进来那一发。
//
// 手势状态（pan / drag / marquee / resizing / connecting / spaceDown）留在这一个闭包里，
// 画布内容本身是页面的：一律经 host.getState() 读、经 host 交下来的回调写，改完由页面重画。
import { t } from "../../../js/core/i18n.js";
import { getConnectionDropTarget, marqueeSelect, panViewport, resizeNode, screenToCanvas, zoomViewportAt } from "./geometry.js";

const NUDGE = 8, NUDGE_BIG = 40;
const TEXT_DRAG_GATE = 8;   // 正文框整张铺满节点：起手先让浏览器选字，拖过这一截才算拖节点
const CLICK_GATE = 3;   // 空白起手拖过这一截才算框选 / 平移，没拖过就是点空白（点空白要收走选中）
const CLIP_NODE_KEYS = new Set(["c", "v", "x", "a"]);   // 节点那四键：光标在正文里时按了要说一句怎么走回节点
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
        if (!host.isPageActive() || e.target.closest(".ns-canvas-bar, .ns-canvas-gen-ctl input, .ns-canvas-node-video-el")) return;
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
    // 键盘手势挂在 window 的 capture 相位：装配层 initClipboardKeys 在 document 的 capture 上把
    // Ctrl+C/V/X/A/Z/Y 用 stopImmediatePropagation 摘走（为的是让注入的吞键 handler 收不到），挂在
    // window 冒泡相位的这条排在那之后，事件一路到不了这儿 —— 画布的撤销与剪贴板键按下去没反应就是这条
    window.addEventListener("keydown", onKeyDown, true);
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
        // 节点头上的动作钮与生成节点上的控件交浏览器发 click：起手不拖、也不 preventDefault（拦了 pointerdown 就没有 click 了）
        // 视频那一段同理：播控（进度条 / 全屏 / 音量）交浏览器，拖节点从节点那一圈黑框进来
        if (e.target.closest(".ns-canvas-node-act, .ns-canvas-node-pick, .ns-canvas-gen-ctl, .ns-canvas-node-video-el")) return;
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
                pushed: false,
                startNode: { ...node, position: { ...node.position } },
                // 图片节点锁比例（上游 keepRatio），提示词节点自由缩放
                keepRatio: node.type === "image" && !node.metadata.freeResize,
            };
            e.preventDefault();
            return;
        }
        const nodeEl = e.target.closest(".ns-canvas-node");
        if (nodeEl) {
            // 正文框整张铺满节点：起手算选中，光标与选字留给浏览器（preventDefault 会把光标拦掉），
            // 拖过 TEXT_DRAG_GATE 那一截才把节点挪走
            const fromText = e.target.classList.contains("ns-canvas-node-textarea");
            selectNode(nodeEl.dataset.nodeId, e);
            startNodeDrag(e, fromText);
            if (!fromText) e.preventDefault();
            return;
        }
        const lineEl = e.target.closest(LINE_SELECTOR);
        if (lineEl) {
            host.setSelection([], lineEl.dataset.connectionId);
            e.preventDefault();
            return;
        }
        // 触屏没有空格与中键可按：空白那一拖留给平移，框选只给鼠标与笔
        if (e.pointerType === "touch") {
            pan = { startX: e.clientX, startY: e.clientY, viewport: { ...state().viewport } };
            stage.classList.add("ns-canvas-grabbing");
            e.preventDefault();
            return;
        }
        // 空白处起手 = 框选（ComfyUI / Figma 口径）：松手时框罩到的那一批就是选中集
        // Shift 起手 = 加选框选：起点那一刻的选中集当基准，罩到的并进去
        const world = worldPoint(e.clientX, e.clientY);
        marquee = { startWorldX: world.x, startWorldY: world.y,
            currentWorldX: world.x, currentWorldY: world.y,
            startX: e.clientX, startY: e.clientY, moved: false,
            additive: e.shiftKey, base: e.shiftKey ? [...ids] : [] };
        stage.classList.add("ns-canvas-marqueeing");
        e.preventDefault();
    }

    function startNodeDrag(e, fromText = false) {
        const ids = [...host.getSelection().ids];
        drag = { startX: e.clientX, startY: e.clientY, moved: false, fromText,
            initial: new Map(state().nodes.filter((n) => ids.includes(n.id)).map((n) => [n.id, { ...n.position }])) };
    }

    function onPointerMove(e) {
        if (pan) {
            host.setViewport(panViewport(pan.viewport, pan.startX, pan.startY, e.clientX, e.clientY));
            return;
        }
        if (drag) {
            const sx = e.clientX - drag.startX, sy = e.clientY - drag.startY;
            // 正文框里起手：短距离是选字，不动节点
            if (drag.fromText && !drag.moved && Math.max(Math.abs(sx), Math.abs(sy)) < TEXT_DRAG_GATE) return;
            // 真拖起来了才压撤销栈：点一下节点不算一次改动
            if (!drag.moved && (Math.abs(sx) > 3 || Math.abs(sy) > 3)) {
                drag.moved = true;
                host.beginEdit();
                if (drag.fromText) document.activeElement?.blur?.();   // 拖起来了就收走光标，浏览器别跟着选字
            }
            // 屏幕位移除以 k 才是世界位移：缩到 50% 时鼠标走 100px，节点在世界上要走 200px
            const dx = sx / state().viewport.k;
            const dy = sy / state().viewport.k;
            // 落点一律从起手那一份快照算：每帧交的是绝对位置，帧与帧之间不累加位移
            host.setNodePositions([...drag.initial].map(([id, pos]) => [id, { x: pos.x + dx, y: pos.y + dy }]));
            return;
        }
        if (resizing) {
            if (!resizing.pushed) { resizing.pushed = true; host.beginEdit(); }
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
            // 框起手先跟手画框，拖过那一格才动选中集：点空白那一下不该被一像素的抖清掉选中
            if (!marquee.moved && Math.max(Math.abs(e.clientX - marquee.startX),
                Math.abs(e.clientY - marquee.startY)) > CLICK_GATE) marquee.moved = true;
            const world = worldPoint(e.clientX, e.clientY);
            marquee.currentWorldX = world.x;
            marquee.currentWorldY = world.y;
            if (marquee.moved) {
                const box = { left: Math.min(marquee.startWorldX, world.x), top: Math.min(marquee.startWorldY, world.y),
                    width: Math.abs(world.x - marquee.startWorldX), height: Math.abs(world.y - marquee.startWorldY) };
                host.setSelection(marqueeSelect(state().nodes, box, marquee.base), null);
            }
            paintMarquee();
        }
    }

    function onPointerUp() {
        if (pan) {
            // 平移只从中键与临时抓手（空格 / Ctrl）来：这一发从来不收选中
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
            // 空白处按下没拖开就是点空白：收笔收走选中；Shift 那一发是加选，点空白不动选中集
            const clearSelection = !marquee.moved && !marquee.additive;
            marquee = null;
            stage.classList.remove("ns-canvas-marqueeing");
            paintMarquee();
            if (clearSelection) host.setSelection([], null);
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
        if (!host.isPageActive() || e.target.closest(".ns-canvas-bar, .ns-canvas-gen-ctl")) return;
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
        // Ctrl/Cmd 编辑命令：正文框里打字时不抢（那一段是浏览器自己的文本撤销与复制粘贴）
        if ((e.ctrlKey || e.metaKey) && !typing) {
            const key = (e.key || "").toLowerCase();
            if (key === "z") { e.preventDefault(); (e.shiftKey ? host.redoEdit : host.undoEdit)(); return; }
            if (key === "y") { e.preventDefault(); host.redoEdit(); return; }
            if (key === "d") { e.preventDefault(); host.duplicateSelection(); return; }
            if (key === "c") { e.preventDefault(); host.copySelection(); return; }
            if (key === "v") { e.preventDefault(); host.pasteClipboard(); return; }
            if (key === "x") { e.preventDefault(); host.cutSelection(); return; }
            if (key === "a") { e.preventDefault(); host.selectAllNodes(); return; }   // 正文框里那一条是浏览器全选文字
        }
        // 光标在正文里时那四键是浏览器自己的文字动作，节点剪不动：按键不拦（拦了连划词复制一起没了），
        // 只说一句怎么走回节点；Esc 先把光标从正文里收出来，收出来之后就是节点的一套
        if (typing) {
            if ((e.ctrlKey || e.metaKey) && CLIP_NODE_KEYS.has((e.key || "").toLowerCase())) {
                host.toast(t("光标在正文里 · Esc 出编辑后再剪节点"), "info");
                return;
            }
            if (e.key === "Escape") document.activeElement?.blur?.();
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "Escape") { host.setSelection([], null); return; }
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); host.deleteSelection(); return; }
        const step = e.shiftKey ? NUDGE_BIG : NUDGE;
        const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!by || !ids.size) return;
        e.preventDefault();
        host.beginEdit();   // 方向键一步一个落点：每步都可撤销
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


