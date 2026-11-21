// 画布的手势层：平移 / 缩放 / 拖节点 / 尺寸柄 / 拉线 / 框选 / 删除与方向键 nudge，
// 以及素材卡片从 Gallery 拖进来那一发。
//
// 手势状态（pan / drag / marquee / resizing / connecting / spaceDown）留在这一个闭包里，
// 画布内容本身是页面的：一律经 host.getState() 读、经 host 交下来的回调写，改完由页面重画。
import { t } from "../../../js/core/i18n.js";
import { canvasToScreen, getConnectionDropTarget, marqueeSelect, panViewport, resizeNode, screenToCanvas, zoomViewportAt } from "./geometry.js";
import { NODE_TYPES } from "./node-types.js";

const NUDGE = 8, NUDGE_BIG = 40;
const CONTENT_DRAG_GATE = 8;   // 铺满整张卡的那两片内容面（正文框与视频）：起手交浏览器选字与翻播放，拖过这一截才算拖节点
const NATIVE_MEDIA_BAR_PX = 36;   // 浏览器在 video 上自绘的那一条播控（进度条 / 音量 / 全屏）有多高
const CLICK_GATE = 3;   // 空白起手拖过这一截才算框选 / 平移，没拖过就是点空白（点空白要收走选中）
const CLIP_NODE_KEYS = new Set(["c", "v", "x", "a"]);   // 节点那四键：光标在正文里时按了要说一句怎么走回节点
const NEO_GALLERY_MIME = "application/x-neo-gallery";
// 光标坐在画布的哪一格可写里：节点上的正文框与数框，加上浮出栏里那两块（参数浮层与选图菜单住在
// .ns-canvas-gen-menus 那一层，不在节点里）。这一位决定「这一按要把焦点交出去」与「键盘那一套要让给浏览器」：
// 拦下 pointerdown 连着把焦点交给下一个元素那一发一起拦了，blur 不来就出不了编辑；数框里按 Backspace
// 删的是那一格里的字，不是选中的节点
const CARET_SELECTOR = ".ns-canvas-node textarea, .ns-canvas-node input, .ns-canvas-gen-menus textarea, .ns-canvas-gen-menus input";
const CARET_IN_BODY = () => Boolean(document.activeElement?.closest?.(CARET_SELECTOR));
// 一条连线是两个 path（宽命中描边 + 可见细线），点哪一条都算点这条线
const LINE_SELECTOR = ".ns-canvas-line, .ns-canvas-line-hit";
// 节点上真正吃这一按的控件：浮出栏的动作钮与选图钮、生成卡上的胶囊 / 按钮 / 段钮 / 种子输入、车厢顶行那一枚时长框、视频那一段片 ——
// 起手交浏览器发 click，按下去是选中这张节点。整列控件行（.ns-canvas-gen-ctl）认成控件的代价是卡上几乎按不到；
// 浮出栏首那枚固定抓手（.ns-canvas-node-drag）是 span，不在这一列里，按下就是拖节点
const NODE_CTL_SELECTOR = ".ns-canvas-node-act, .ns-canvas-node-pick, .ns-canvas-node-video-el, "
    + ".ns-canvas-node-audio-el, .neo-gallery-gm-chip-btn, .ns-canvas-gen-btn, .ns-canvas-gen-ctl input, "
    + ".ns-canvas-car-dur, .ns-canvas-storyboard-sec";

/** 把手势挂到舞台上：stage 是那一页的舞台元素，view 交出要画手势层（world 上画框选框），
 *  host 是页面交下来的读写面（见 createCanvasPage 里那一份 host）。 */
export function attachCanvasInteractions({ stage, view, host }) {
    let pan = null, drag = null, marquee = null, resizing = null, connecting = null;
    let spaceDown = false;

    const state = () => host.getState();
    const worldPoint = (clientX, clientY) => screenToCanvas(state().viewport, clientX, clientY, stage.getBoundingClientRect());

    // 滚轮缩放锚在指针上（passive: false 才拦得住 preventDefault，否则浏览器连页面一起滚）
    stage.addEventListener("wheel", (e) => {
        if (!host.isPageActive() || e.target.closest(".ns-canvas-bar, .ns-canvas-gen-ctl input, .ns-canvas-car-dur, "
            + ".ns-canvas-storyboard-sec, .ns-canvas-node-video-el, .ns-canvas-node-audio-el, .ns-canvas-car-text, "
            + ".ns-canvas-storyboard-text")) return;
        e.preventDefault();
        const rect = stage.getBoundingClientRect();
        host.setViewport(zoomViewportAt(state().viewport, e.clientX - rect.left, e.clientY - rect.top, e.deltaY));
    }, { passive: false });
    stage.addEventListener("pointerdown", (e) => onPointerDown(e));
    stage.addEventListener("dblclick", (e) => onDoubleClick(e));
    stage.addEventListener("dragover", (e) => {
        if (!host.isPageActive() || (!galleryPayload(e) && !hasLocalFiles(e))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        // 从资源管理器拖进来时这一发的坐标是系统拖放循环给的，Chromium / WebView2 在原生文件拖放上
        // 会交出 (0,0)（crbug 那一条老问题）：把这一发的指针位置与指针下那枚节点留着，drop 那一发
        // 不带坐标时用它。坐标没带就不要存，存了一枚假节点比没有更坏
        if (e.clientX || e.clientY) lastDragPoint = { x: e.clientX, y: e.clientY, nodeEl: dropTargetNode(e) };
        paintDropHalo(dropTargetNode(e));
    });
    stage.addEventListener("dragleave", (e) => { if (!stage.contains(e.relatedTarget)) paintDropHalo(null); });
    stage.addEventListener("drop", (e) => onDrop(e));
    // 拖动与拉线要跑到容器外还在跟手，收笔统一交给 window（上游同一形状）
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    // 收笔不止 pointerup 这一条：浏览器把这一发接走（正文里拖出文本、触屏那一按被系统手势拿走）只发
    // pointercancel，桌面窗口拖到一半失焦（拖出窗口、切走窗口、原生菜单挡在中间）只发 blur。这两发不来，
    // drag 就挂在窗口上跟着光栅跑，舞台上的 ns-canvas-grabbing / ns-canvas-marqueeing 也留在身上 —— 那两层是
    // pointer-events: none，整张画布从此按不动任何东西，节点选中了也拖不动
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", abortGestures);
    document.addEventListener("dragstart", onDragStart, true);
    // 键盘手势挂在 window 的 capture 相位：装配层 initClipboardKeys 在 document 的 capture 上把
    // Ctrl+C/V/X/A/Z/Y 用 stopImmediatePropagation 摘走（为的是让注入的吞键 handler 收不到），挂在
    // window 冒泡相位的这条排在那之后，事件一路到不了这儿 —— 画布的撤销与剪贴板键按下去没反应就是这条
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", (e) => { if (e.code === "Space") spaceDown = false; });

    function onPointerDown(e) {
        if (!host.isPageActive()) return;
        const { ids } = host.getSelection();
        const isBackground = !e.target.closest(`.ns-canvas-node, ${LINE_SELECTOR}`);
        // 中键直接平移；空格是临时抓手（ComfyUI 口径：空白那一拖默认就是拖动画面）
        if (e.button === 1 || (spaceDown && isBackground)) {
            e.preventDefault();
            pan = { startX: e.clientX, startY: e.clientY, viewport: { ...state().viewport } };
            stage.classList.add("ns-canvas-grabbing");
            return;
        }
        if (e.button !== 0) return;
        // 节点头上的动作钮与生成卡上的胶囊 / 按钮 / 种子输入交浏览器发 click：起手不拖、也不 preventDefault（拦了 pointerdown 就没有 click 了）
        // 生成卡与串联车厢整张铺的都是控件，按完不选就看不出按的是哪一张 —— ComfyUI 口径：点在控件上就是点这张节点
        const ctlEl = e.target.closest(NODE_CTL_SELECTOR);
        if (ctlEl) {
            const ctlNodeEl = ctlEl.closest(".ns-canvas-node");
            if (!ctlNodeEl) return;
            selectNode(ctlNodeEl.dataset.nodeId, e);
            // 视频整张是那一段片，点一下是浏览器在翻播放：起手照拖这一张节点，没拖过那一截就把这一发整个交回浏览器。
            // 底部那一条是浏览器自绘的播控（拖进度条是 seek），那一发起手不拖节点，不然 seek 一刀把整张卡搬走
            if (ctlEl.classList.contains("ns-canvas-node-video-el") && !onNativeMediaBar(e, ctlNodeEl.dataset.nodeId)) {
                startNodeDrag(e, CONTENT_DRAG_GATE);
            }
            return;
        }
        const handleEl = e.target.closest(".ns-canvas-handle");
        if (handleEl) {
            const sourceEl = handleEl.closest(".ns-canvas-node");
            const nodeId = sourceEl.dataset.nodeId;
            // side 是这一枚接线点在节点的哪一面：拉线中的虚线与落点锚都从那一面出发
            connecting = { handle: { handleType: handleEl.dataset.handle, side: handleEl.dataset.side, nodeId },
                mouseWorld: worldPoint(e.clientX, e.clientY), targetId: null, isNearNode: false, linkEl: sourceEl };
            // 起手这一张挂 ns-canvas-node-linking：四枚接线点亮着（style.css），节点里的正文与图片让位
            sourceEl.classList.add("ns-canvas-node-linking");
            e.preventDefault();
            host.paintActive(connecting);
            return;
        }
        const cornerEl = e.target.closest(".ns-canvas-resize");
        if (cornerEl) {
            const node = state().nodes.find((n) => n.id === cornerEl.closest(".ns-canvas-node").dataset.nodeId);
            if (!node) return;
            const nodeEl = cornerEl.closest(".ns-canvas-node");
            resizing = {
                nodeId: node.id,
                nodeEl,
                corner: cornerEl.dataset.corner,
                startX: e.clientX, startY: e.clientY,
                pushed: false,
                startNode: { ...node, position: { ...node.position } },
                // 图片节点锁比例（上游 keepRatio），提示词节点自由缩放
                keepRatio: node.type === "image" && !node.metadata.freeResize,
            };
            // 缩放中的节点挂 ns-canvas-node-resizing：里面的正文框与图片要让位，不然拖到一半焦点被文本框吃掉
            nodeEl.classList.add("ns-canvas-node-resizing");
            e.preventDefault();
            return;
        }
        const nodeEl = e.target.closest(".ns-canvas-node");
        if (nodeEl) {
            // 正文框整张铺满节点：起手算选中，光标与选字留给浏览器（preventDefault 会把光标拦掉），
            // 拖过 CONTENT_DRAG_GATE 那一截才把节点挪走
            const fromText = e.target.classList.contains("ns-canvas-node-textarea");
            selectNode(nodeEl.dataset.nodeId, e);
            startNodeDrag(e, fromText ? CONTENT_DRAG_GATE : 0);
            // 光标在正文里时这一按交浏览器：焦点从正文框换走才发得出 blur，编辑才出得来
            if (!fromText && !CARET_IN_BODY()) e.preventDefault();
            return;
        }
        const lineEl = e.target.closest(LINE_SELECTOR);
        if (lineEl) {
            host.setSelection([], lineEl.dataset.connectionId);
            e.preventDefault();
            return;
        }
        // 触屏没有空格与 Ctrl 可按：空白那一拖留给平移，框选只给鼠标与笔
        if (e.pointerType === "touch") {
            pan = { startX: e.clientX, startY: e.clientY, viewport: { ...state().viewport } };
            stage.classList.add("ns-canvas-grabbing");
            e.preventDefault();
            return;
        }
        // 空白处起手：Ctrl / Shift 是框选（Shift 在起点那一刻的选中集上加选），其余就是平移那一拖
        // （ComfyUI 口径：默认那一拖是拖动画面，框选要按住 Ctrl）
        if (!e.ctrlKey && !e.shiftKey) {
            pan = { startX: e.clientX, startY: e.clientY, viewport: { ...state().viewport }, blank: true };
            stage.classList.add("ns-canvas-grabbing");
            if (!CARET_IN_BODY()) e.preventDefault();
            return;
        }
        const world = worldPoint(e.clientX, e.clientY);
        marquee = { startWorldX: world.x, startWorldY: world.y,
            currentWorldX: world.x, currentWorldY: world.y,
            startX: e.clientX, startY: e.clientY, moved: false,
            additive: e.shiftKey, base: e.shiftKey ? [...ids] : [] };
        stage.classList.add("ns-canvas-marqueeing");
        if (!CARET_IN_BODY()) e.preventDefault();
    }

    /** gate 是「让给浏览器的那一截」：0 = 起手就拖；正文框与视频面上手是选字与翻播放，拖过 gate 才算拖节点 */
    function startNodeDrag(e, gate = 0) {
        const ids = [...host.getSelection().ids];
        drag = { startX: e.clientX, startY: e.clientY, moved: false, gate,
            initial: new Map(state().nodes.filter((n) => ids.includes(n.id)).map((n) => [n.id, { ...n.position }])) };
        // 让位类要等真拖起来那一帧才挂（在 onPointerMove 里挂）：起手就挂的话，style.css 那条 pointer-events
        // 落在正文框与视频上，这一发的 click 就落不到它们身上 —— 点一下选字与翻播放全没了
        if (!gate) stage.classList.add("ns-canvas-dragging");
    }

    /** 落在浏览器自绘的那一条 video 播控上（进度条 / 音量 / 全屏）：这一发起手交浏览器，不拖节点。
     *  播控子控件住在 video 自己那一层里，页面只拿得到 .ns-canvas-node-video-el 这一个落点，只能按几何认那一条 ——
     *  片面的底（style.css 的 inset: 6px）往上 NATIVE_MEDIA_BAR_PX 乘当前缩放 k。走 canvasToScreen 不查
     *  getBoundingClientRect：世界层的平移与缩放本来就在 state.viewport 上，节点几何也是 */
    function onNativeMediaBar(e, nodeId) {
        const node = state().nodes.find((n) => n.id === nodeId);
        if (!node) return false;
        const viewport = state().viewport;
        const videoBottom = canvasToScreen(viewport, node.position.x,
            node.position.y + node.height - 6, stage.getBoundingClientRect()).y;
        return e.clientY > videoBottom - NATIVE_MEDIA_BAR_PX * viewport.k;
    }

    function onPointerMove(e) {
        if (pan) {
            // 起手过 CLICK_GATE 那一截才算平移：点空白那一下不该被一像素的抖挪走画面
            if (!pan.moved && Math.max(Math.abs(e.clientX - pan.startX),
                Math.abs(e.clientY - pan.startY)) > CLICK_GATE) pan.moved = true;
            if (pan.moved) host.setViewport(panViewport(pan.viewport, pan.startX, pan.startY, e.clientX, e.clientY));
            return;
        }
        if (drag) {
            const sx = e.clientX - drag.startX, sy = e.clientY - drag.startY;
            // 铺满卡面的那两片（正文框 / 视频）起手交浏览器：这一截之内是选字与翻播放，不动节点
            if (drag.gate && !drag.moved && Math.max(Math.abs(sx), Math.abs(sy)) < drag.gate) return;
            // 真拖起来了才压撤销栈：点一下节点不算一次改动
            if (!drag.moved && (Math.abs(sx) > 3 || Math.abs(sy) > 3)) {
                drag.moved = true;
                host.beginEdit();
                stage.classList.add("ns-canvas-dragging");   // 到这一帧内容面才让位（含带 gate 的那两片）
                if (drag.gate) document.activeElement?.blur?.();   // 拖起来了就收走光标，浏览器别跟着选字
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
            // 空白那一拖没挪开就是点空白：收笔收走选中；中键与空格那发是抓手，从来不动选中集
            const clearSelection = pan.blank && !pan.moved;
            pan = null;
            stage.classList.remove("ns-canvas-grabbing");
            if (clearSelection) host.setSelection([], null);
        }
        if (drag) {
            if (drag.moved) host.markDirty();
            drag = null;
            stage.classList.remove("ns-canvas-dragging");
        }
        if (resizing) {
            resizing.nodeEl?.classList.remove("ns-canvas-node-resizing");
            resizing = null;
            host.markDirty();
        }
        if (connecting) {
            connecting.linkEl?.classList.remove("ns-canvas-node-linking");
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

    /** 这一发被浏览器接走（正文文本拖出去、系统手势拿走那一按）或窗口中途失焦：pointerup 不会来了。
     *  已经挪出去的落点收下（跟正常收笔一样标脏），其余状态全丢掉 —— 不连线、不清选中，
     *  舞台与节点上那几层 pointer-events: none 的类一并摘掉，画布不能因为一次没收到收笔就再也拖不动 */
    function abortGestures() {
        const movedNode = !!drag?.moved || !!resizing;
        if (resizing) resizing.nodeEl?.classList.remove("ns-canvas-node-resizing");
        if (connecting) {
            connecting.linkEl?.classList.remove("ns-canvas-node-linking");
            host.paintActive(null);
        }
        const hadMarquee = !!marquee;
        pan = drag = marquee = resizing = connecting = null;
        stage.classList.remove("ns-canvas-grabbing", "ns-canvas-marqueeing", "ns-canvas-dragging");
        if (hadMarquee) paintMarquee();   // 状态清了再画一次：框选框跟着收掉
        if (movedNode) host.markDirty();
    }

    /** 原生拖拽起来了就是这一发的收笔：节点拖动的 pointer 会话被拖拽接管，往后没有 pointerup，
     *  不收笔的话 drag 会挂在窗口上，之后每一下裸移动都把节点按旧起点搬走 */
    function onDragStart() {
        if (!host.isPageActive()) return;
        if (!pan && !drag && !marquee && !resizing && !connecting) return;
        abortGestures();
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
        if (!host.isPageActive()) return;
        const nodeEl = e.target.closest(".ns-canvas-node");
        if (nodeEl) {
            const node = state().nodes.find((n) => n.id === nodeEl.dataset.nodeId);
            if (!node) return;
            // 重画之后手上那一个元素已经不在层里，焦点要落给重画出来的那一块正文框。带正文框的卡写在注册表
            // 那一行（bodyText）：故事板那一块住在控件层里，控件层整行不早退才进得了编辑
            if ((NODE_TYPES[node.type] || NODE_TYPES.text).bodyText) {
                stage.querySelector(`[data-node-id="${node.id}"]`)?.querySelector("textarea")?.focus();
            }
            return;
        }
        // 空白处双击 = 就地挑要加的节点（ComfyUI 那一条）：「加节点」菜单钉在指针上，选完就在这一点铺一张
        host.openAddMenu({ world: worldPoint(e.clientX, e.clientY), screen: { x: e.clientX, y: e.clientY } });
    }

    function onKeyDown(e) {
        if (!host.isPageActive()) return;
        const { ids } = host.getSelection();
        const typing = CARET_IN_BODY();
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

    // ====== 拖放落点（素材卡片 + 本地文件） ======
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

    /** 这一放带的是不是本地文件：dragover 阶段浏览器不交出 files（安全边界），只交出 types */
    function hasLocalFiles(e) {
        const dt = e.dataTransfer;
        if (!dt) return false;
        if (dt.files && dt.files.length) return true;
        return Array.from(dt.types || []).includes("Files");
    }

    /** 指针下那一枚节点就是更换落点；落在节点外就是添加 */
    function dropTargetNode(e) {
        return e.target?.closest?.(".ns-canvas-node") || null;
    }

    /** 更换落点的描边：用户要看得见这一放是换它，不是往它身上叠一张 */
    let dropHalo = null;
    let lastDragPoint = null;   // 最后一次 dragover 的指针位置与指针下那枚节点（见上面那条 dragover）
    function paintDropHalo(el) {
        if (dropHalo === el) return;
        dropHalo?.classList.remove("ns-canvas-node-dropon");
        dropHalo = el;
        dropHalo?.classList.add("ns-canvas-node-dropon");
    }

    function onDrop(e) {
        if (!host.isPageActive()) return;
        const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
        const picked = galleryPayload(e);
        if (!files.length && !picked) return;
        e.preventDefault();
        // 整发收在这里：ComfyUI 壳在 document 上有一份全局文件导入（把文件当节点写进它自己的工作流），
        // 桌面端没有处理器时浏览器会把窗口导航到 file:///，两条都在这一发之后
        e.stopPropagation();
        const painted = Boolean(e.clientX || e.clientY);
        const at = painted ? worldPoint(e.clientX, e.clientY)
            : (lastDragPoint ? worldPoint(lastDragPoint.x, lastDragPoint.y) : host.centerWorld());
        // 更换落点跟着落点走：坐标没带过来的那一发，事件 target 是 (0,0) 那头的元素，指针下那枚节点
        // 只可能在 dragover 里拿到
        const targetEl = painted ? dropTargetNode(e) : lastDragPoint?.nodeEl;
        paintDropHalo(null);
        host.dropMedia({
            files,
            picked,
            at,
            nodeId: targetEl?.dataset?.nodeId || null,
        });
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


