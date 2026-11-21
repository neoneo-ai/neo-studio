// Neo Studio「画布」页：图片节点与提示词节点铺在一张无限画布上，连线串起生成顺序。
//
// 这一页管装配与生命周期：工具条、视口、页面自己的 state 与落盘，以及装配层交来的三样。
// 几何在 geometry.js，数据契约与 /neo_canvas/* 读写在 store.js，节点 DOM 在 nodes.js，
// 连线画在 connections.js，平移/拖动/框选/拉线这些手势在 interactions.js（手势状态不在这一页），
// 撤销重做栈在 history.js（只记节点与连线，视口与背景不进栈）。
// 引擎层的出处与上游对应关系写在 geometry.js 头上，LICENSES/infinite-canvas.txt 是那份授权全文。
import { t, tf } from "../../../js/core/i18n.js";
import { setIcon, setIconLabel } from "../../../js/core/icons.js";
import { addConnection, gridGeometry, MAX_SCALE, MIN_SCALE, nodeBounds, placeGrid, removeNodes, screenToCanvas, zoomViewportAt } from "./geometry.js";
import { BACKGROUND_MODES, createCanvasNode, createCanvasStore, duplicateNodes, fitImageSize, NODE_SPECS, readCanvas } from "./store.js";
import { createHistory, snapshotCanvas } from "./history.js";
import { applyNodeGeometry as paintNodeGeometry, renderNodes as renderNodeLayer, paintSelection as paintNodeSelection } from "./nodes.js";
import { ADD_MENU, VIDEO_GEN_TITLE } from "./node-types.js";
import { renderConnections as renderLinkLayer, renderActiveConnection as paintActiveLine } from "./connections.js";
import { attachCanvasInteractions } from "./interactions.js";
import { createCanvasGen, readRecipeParams } from "./gen.js";
import { thumbUrl } from "../../../recipes.js";
import { mediaKindOf } from "../../../js/core/media-href.js";
import { openPresetPicker } from "../../../js/core/preset-picker.js";

const SAVE_DEBOUNCE_MS = 900;

// 节点类型 → 素材库那扇弹窗收哪一类：图片节点只收图，视频 / 音频输入节点各收各的
const MATERIAL_ACCEPT = { image: "image", video_in: "video", audio_in: "audio" };
// 拖放的更换表：素材输入节点照弹窗那一份，出片落点收一段片，提示词节点收一段正文
const DROP_ACCEPT = { ...MATERIAL_ACCEPT, video: "video", text: "text" };
// 拖进来的素材落哪一类节点：出片落点只当更换落点，凭空铺一张空位给出片没有好处
const DROP_NODE = { image: "image", video: "video_in", audio: "audio_in", text: "text" };
const ACCEPT_LABEL = { image: "图片", video: "视频", audio: "音频", text: "正文" };
const DROP_TEXT_EXT = /\.(txt|md|markdown|csv)(?=&|#|$)/i;
const DROP_TEXT_MAX_CHARS = 20000;   // 正文要进 textarea 又跟着整张画布的 JSON 落盘，长过这一截就是自杀式保存

/** 画布页工厂：openMaterial(onPick, accept) 由装配层交下来（素材库弹窗，一次收窗，accept 说这一扇
 *  收图 / 视频 / 音频里的哪一类）；没有它时「加图片 / 加视频输入 / 加音频输入」与节点上那一枚
 *  回到建一张空节点 —— ComfyUI 侧没有这扇弹窗。
 *  can 是能力表读法（app/studio_caps.py 的能力名）：出图、出片与增强 / 反推四条链的闸门与钮上的提示
 *  全按节点自己那一发要的那一位问（见 node-types.js 的 gateOf）；不交时生成节点照样能铺能存、照样放行。
 *  modeGroup(meta) / groupLabels 是出视频页那一份生成模式分组（studio-app.js）：画布上选技能的面按它分组，
 *  「全参考生视频」那一组的出片口径（三桶参考、不吃锚点）也由它判定。 */
export function createCanvasPage({ $el, api, toast, openMaterial, can, modeGroup, groupLabels }) {
    let state = readCanvas({});
    let selectedNodeIds = new Set();
    let selectedConnectionId = null;
    let dirty = false;
    let saveTimer = 0;
    let projects = [];
    let view = null;               // build 之后才有：DOM 引用与每帧要改的那几层
    let ready = null;              // 首次进页把上一张画布读进来的那条 promise
    const store = createCanvasStore({ api });
    const history = createHistory();
    let textRun = null;            // 正在连打正文的那张节点 id：同一段连打只压一次栈
    let clipboard = null;          // Ctrl+C / Ctrl+X 收下来的那一批（含它们内部的连线）：切到别的画布也能粘回来
    let pasteStep = 0;             // 连按 Ctrl+V 时一批比一批偏开，不在同一处叠成一叠
    let gen = null;                // 生成节点那一套（gen.js）：host 装配好之后建起来

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
        // 生成节点上胶囊的菜单浮这一层：世界层带 scale、节点裁剪自己的内容，菜单进那一层会跟着缩放并被节点切掉
        const menus = $el("div", { className: "ns-canvas-gen-menus" });
        world.append(links, active, nodeLayer);
        stage.append(grid, world, active, hint);
        page.append(bar.root, stage, menus);
        el.appendChild(page);
        view = { el, page, stage, grid, world, links, nodeLayer, active, hint, menus, save: bar.save, zoom: bar.zoom,
            project: bar.project, undo: bar.undo, redo: bar.redo };
        attachCanvasInteractions({ stage, view, host });
        applyViewport();
        renderNodes();
        renderConnections();
        refreshHistory();
        gen?.prime();     // 节点上那行技能名要有来源：技能列表与首张画布一起读
        gen?.primeVideo();     // 「加视频生成节点」的技能胶囊与出片预检读这一份
        gen?.primeRecipes();   // 「添加配方」弹窗的卡与车厢上那行配方概览读这一份
        ready = loadProjects();
        return ready;
    }

    function buildBar() {
        const mk = (label, name, fn) => {
            const btn = $el("button", { className: "ns-canvas-tool", type: "button", title: label, "aria-label": label, onclick: fn });
            setIcon(btn, name);
            return btn;
        };
        const zoom = $el("span", { className: "ns-canvas-zoom", textContent: "100%" });
        const save = $el("span", { className: "ns-canvas-save", textContent: t("已保存") });
        // 工具条只放图标钮：名字与组合键都写在悬停提示与 aria-label 里，一行放得下
        const mkHint = (label, hint, name, fn) => {
            const btn = mk(label, name, fn);
            btn.title = `${label}（${hint}）`;
            return btn;
        };
        // 画布切换自绘面板：条上只有当前画布名与箭头，点开是一列画布，改名与删除在每一行右端 ——
        //   原生 select 的弹层里装不下这两枚钮，切换这一层只能自己画（样式在 style.css，触屏档两枚常显）
        const projectName = $el("span", { className: "ns-canvas-project-name" });
        const projectCaret = $el("span", { className: "ns-canvas-project-caret" });
        setIcon(projectCaret, "chevron");
        const projectPanel = $el("div", { className: "ns-canvas-project-panel" });
        const projectBtn = $el("button", { className: "ns-canvas-project-btn", type: "button",
            "aria-label": t("画布"), "aria-expanded": "false",
            onclick: () => (projectPanel.classList.contains("ns-canvas-project-panel-open")
                ? closeProjectPanel() : openProjectPanel()) }, [projectName, projectCaret]);
        function closeProjectPanel() {
            projectPanel.classList.remove("ns-canvas-project-panel-open");
            projectBtn.setAttribute("aria-expanded", "false");
            document.removeEventListener("pointerdown", projectOutside, true);
            document.removeEventListener("keydown", projectEscape, true);
        }
        function openProjectPanel() {
            renderProjectPanel();
            const rect = projectBtn.getBoundingClientRect();
            projectPanel.style.left = `${Math.max(8, rect.left)}px`;
            projectPanel.style.top = `${rect.bottom + 6}px`;
            projectPanel.classList.add("ns-canvas-project-panel-open");
            projectBtn.setAttribute("aria-expanded", "true");
            document.addEventListener("pointerdown", projectOutside, true);
            document.addEventListener("keydown", projectEscape, true);
        }
        const projectOutside = (e) => { if (!projectPanel.contains(e.target) && !projectBtn.contains(e.target)) closeProjectPanel(); };
        const projectEscape = (e) => { if (e.key === "Escape") closeProjectPanel(); };
        const undo = mkHint(t("撤销"), "Ctrl+Z", "undo", () => undoEdit());
        const redo = mkHint(t("重做"), "Ctrl+Shift+Z", "redo", () => redoEdit());
        const group = (...kids) => $el("span", { className: "ns-canvas-bar-group" }, kids);
        const sep = () => $el("span", { className: "ns-canvas-bar-sep" });
        // 加节点收成菜单里的八行：顺序、图标与名字都在 node-types.js 的那一列里。菜单钉在钮下方，
        // position: fixed 让它不占条内的行位、也不被条的横向滚动裁剪；行面上是图标 + 名字 —— 只有图标时
        // 「加图像生成节点」与「加视频生成节点」落在同一类节点的两个档上，行面上只有图标时更分不出来
        const inMenu = (btn) => {
            btn.classList.add("ns-canvas-add-item");
            btn.appendChild($el("span", { className: "ns-canvas-add-label",
                textContent: btn.getAttribute("aria-label") }));
            return btn;
        };
        const addAction = (fn) => () => { closeAddMenu(); fn(); };
        function closeAddMenu() {
            addMenu.classList.remove("ns-canvas-add-menu-open");
            addBtn.classList.remove("ns-canvas-tool-on");
            document.removeEventListener("pointerdown", addOutside, true);
            document.removeEventListener("keydown", addEscape, true);
        }
        function openAddMenu() {
            const rect = addBtn.getBoundingClientRect();
            addMenu.style.left = `${Math.max(8, rect.left)}px`;
            addMenu.style.top = `${rect.bottom + 6}px`;
            addMenu.classList.add("ns-canvas-add-menu-open");
            addBtn.classList.add("ns-canvas-tool-on");
            document.addEventListener("pointerdown", addOutside, true);
            document.addEventListener("keydown", addEscape, true);
        }
        const addOutside = (e) => { if (!addMenu.contains(e.target) && !addBtn.contains(e.target)) closeAddMenu(); };
        const addEscape = (e) => { if (e.key === "Escape") closeAddMenu(); };
        const addMenu = $el("div", { className: "ns-canvas-add-menu" },
            ADD_MENU.map((row) => inMenu(mk(t(row.label), row.icon, addAction(() => addTypedNode(row))))));
        const addBtn = mk(t("加节点"), "plus-square", () => (
            addMenu.classList.contains("ns-canvas-add-menu-open") ? closeAddMenu() : openAddMenu()));
        const root = $el("div", { className: "ns-canvas-bar" }, [
            // 三组：画布本身 / 加节点与撤销重做 / 视图。整条不换行，窗口不够宽就在条内横向滚
            group(projectBtn, projectPanel),
            sep(),
            group(addBtn, addMenu, sep(), undo, redo),
            $el("span", { className: "ns-canvas-bar-gap" }),
            group(mk(t("缩小"), "zoom-out", () => zoomStep(-1)), zoom,
                mk(t("放大"), "zoom-in", () => zoomStep(1)),
                sep(),
                mk(t("适应内容"), "target", () => fitView()),
                mk(t("背景"), "eye", () => cycleBackground()),
                save),
        ]);
        return { root, project: { btn: projectBtn, panel: projectPanel, name: projectName, close: closeProjectPanel },
            zoom, save, undo, redo };
    }

    /** 视口落到 DOM：世界层一整层 transform，缩放与平移只改这一句（上游同一形状） */
    function applyViewport() {
        if (!view) return;
        view.world.style.transform = `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${state.viewport.k})`;
        // 浮出栏与徽标住在世界层里，按 1/zoom 反缩放才不在缩小时缩成按不中的小点
        view.world.style.setProperty("--ns-canvas-inv", String(1 / state.viewport.k));
        const grid = gridGeometry(state.viewport);
        view.grid.style.backgroundSize = grid.backgroundSize;
        view.grid.style.backgroundPosition = grid.backgroundPosition;
        view.grid.className = "ns-canvas-grid"
            + (state.backgroundMode === "lines" ? (grid.fine ? " ns-canvas-grid-lines-fine" : " ns-canvas-grid-lines")
                : state.backgroundMode === "blank" ? " ns-canvas-grid-blank" : "");
        view.zoom.textContent = `${Math.round(state.viewport.k * 100)}%`;
        view.hint.style.display = state.nodes.length ? "none" : "";
    }

    function renderNodes() {
        if (!view) return;
        view.menus.textContent = "";   // 控件整份重建，挂在浮层里的菜单跟着作废
        renderNodeLayer({ nodeLayer: view.nodeLayer, links: view.links, hint: view.hint, nodes: state.nodes,
            selectedNodeIds, selectedConnectionId, $el, onText,
            onPick: pickInto, onPickPrompt: pickPromptInto, onHero: (node) => toggleHero(node.id), onDelete: (node) => deleteNode(node.id),
            onCopy: (node) => duplicateIds([node.id]),
            onToggleDisabled: (node) => setNodeMetadata(node.id, { disabled: node.metadata?.disabled !== true }),
            genControls: (node) => gen?.controls(node), genState: (node) => gen?.stateOf(node),
            genModel: (node) => gen?.modelText(node),
            editControls: (node) => gen?.editControls(node),
            llmControls: (node) => gen?.llmControls(node),
            carView: (node) => gen?.carView(node),
            onMediaSize: fitMediaNode });
    }

    /** 提示词节点上那一枚「提示词」：浮层挂在按钮下方，点中一条把整段全文填进这一格。正文照走 onText
     *  那一条（撤销一次退掉整段、跟着标脏落盘），填完重画一次节点层，不然正文框里还是用户原来写的那一段。
     *  词库要 ComfyUI 在跑：离线那一发由浮层自己说，这一层不加第二条判断 */
    function pickPromptInto(node, btn) {
        openPresetPicker({ kind: "image", anchor: btn, onPick: (text) => { onText(node, text); renderNodes(); } });
    }

    /** 图片与视频输入按素材自己的比例落那一格：横的压矮、竖的收窄，永远不超出这一类节点默认那一档
     *  （超出就会压到 placeGrid 的步长与串联的行距算出来的邻居）。
     *  只动还停在默认尺寸的节点 —— 用户拉过尺寸的、串联素材那种小卡（240×160）一律不重铺；
     *  没素材坐标的占位图与空视频位不算比例。只落几何与连线，不重建节点（重建会打断正在加载的那一张） */
    function fitMediaNode(node, naturalWidth, naturalHeight) {
        const cur = state.nodes.find((n) => n.id === node.id);
        if (!cur || (cur.type !== "image" && cur.type !== "video_in")) return;
        if (!cur.metadata.filename && !cur.metadata.asset) return;
        const spec = NODE_SPECS[cur.type];
        if (cur.width !== spec.width || cur.height !== spec.height) return;
        const size = fitImageSize(naturalWidth, naturalHeight, spec);
        if (!size || (size.width === cur.width && size.height === cur.height)) return;
        cur.width = size.width;
        cur.height = size.height;
        paintNodeGeometry(view.nodeLayer, cur);
        renderConnections();
        markDirty();
    }

    function renderConnections() {
        if (!view) return;
        renderLinkLayer({ links: view.links, connections: state.connections, nodes: state.nodes, selectedConnectionId });
    }

    function paintSelection() {
        if (!view) return;
        paintNodeSelection({ nodeLayer: view.nodeLayer, links: view.links, selectedNodeIds, selectedConnectionId });
    }

    function paintActive(connecting) {
        if (!view) return;
        paintActiveLine({ active: view.active, nodeLayer: view.nodeLayer, connecting, nodes: state.nodes });
    }

    function paintNode(node) {
        if (!view) return;
        paintNodeGeometry(view.nodeLayer, node);
    }

    /** 提示词节点正文改一下：正文存在 metadata.content，改完就要落盘。同一段连打只压一次栈 ——
     *  撤销一次退掉整段，不是逐字退 */
    function onText(node, content) {
        if (textRun !== node.id) {
            history.push(snapshotCanvas(state));
            textRun = node.id;
        }
        node.metadata = { ...node.metadata, content };
        markDirty();
    }

    function isPageActive() {
        return !!view && view.el.isConnected && !view.el.classList.contains("ns-hidden");
    }

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
    // ====== 手势层交下来的读写面 ======
    // 手势只改 state 与画，DOM 与落盘都在这一侧；页面换 state 形状（{...state}）由这几条回调自己管
    const host = {
        $el,
        toast,
        getState: () => state,
        getSelection: () => ({ ids: selectedNodeIds, connectionId: selectedConnectionId }),
        setSelection: (ids, connectionId) => {
            selectedNodeIds = new Set(ids);
            selectedConnectionId = connectionId;
            paintSelection();
        },
        setViewport,
        centerWorld,   // 拖放那一发两手都拿不到坐标时的落点（视口中心）
        paintNode,
        paintConnections: renderConnections,
        paintActive,
        markDirty,
        isPageActive,
        addNode,
        dropMedia,
        deleteSelection,
        setNodePositions,
        moveSelected,
        applyResize,
        connect,
        beginEdit,
        duplicateSelection,
        copySelection,
        pasteClipboard,
        cutSelection,
        selectAllNodes,
        undoEdit,
        redoEdit,
        // 生成节点那一套（gen.js）要的几条：整层重画、查节点、量舞台、改 metadata、落结果
        paintNodes: renderNodes,
        hasNode: (id) => state.nodes.some((node) => node.id === id),
        stageRect: () => view.stage.getBoundingClientRect(),
        patchMeta: setNodeMetadata,
        applyResult: applyGenResult,
        applyText: applyLlmText,
        genMenus: () => view.menus,
        pageEl: () => view.el,
    };

    gen = createCanvasGen({
        $el,
        toast,
        api,
        canFeature: can || (() => true),
        host,
        modeGroup,
        groupLabels,
    });

    // ====== 撤销 / 重做 / 复制 ======
    /** 一次改动落笔之前压一份栈：拖动与缩放在真正动起来那一帧由手势层交这一条，正文由 onText 管运行边界 */
    function beginEdit() {
        history.push(snapshotCanvas(state));
        textRun = null;
        refreshHistory();
    }

    function refreshHistory() {
        if (!view) return;
        view.undo.disabled = !history.canUndo();
        view.redo.disabled = !history.canRedo();
    }

    /** 整份节点与连线换回去：视口与背景不动。选中里被回退删掉的那几张要一起收掉 */
    function restoreCanvas(snap) {
        state = { ...state, nodes: snap.nodes, connections: snap.connections };
        const ids = new Set(snap.nodes.map((node) => node.id));
        const connIds = new Set(snap.connections.map((conn) => conn.id));
        selectedNodeIds = new Set([...selectedNodeIds].filter((id) => ids.has(id)));
        if (!connIds.has(selectedConnectionId)) selectedConnectionId = null;
        textRun = null;
        renderNodes();
        renderConnections();
        markDirty();   // 回退也是一次改动：要落盘，否则刷新页面又回原样
    }

    function undoEdit() {
        const before = history.undo(snapshotCanvas(state));
        if (before) restoreCanvas(before);
    }

    function redoEdit() {
        const after = history.redo(snapshotCanvas(state));
        if (after) restoreCanvas(after);
    }

    /** 复制选中的那批（Ctrl+D 与工具条那枚同一条）：没选中要先说清楚，不静默什么都不做 */
    function duplicateSelection() {
        if (!selectedNodeIds.size) { toast(t("先选中要复制的节点"), "info"); return; }
        duplicateIds([...selectedNodeIds]);
    }

    /** 复制那一批节点：副本偏移 36 落在旁边，选中落到副本上（操作栏上的复制钮就是单张这一条） */
    function duplicateIds(ids) {
        beginEdit();
        const dup = duplicateNodes(state.nodes, state.connections, ids);
        state = { ...state, nodes: [...state.nodes, ...dup.nodes], connections: [...state.connections, ...dup.connections] };
        selectedNodeIds = new Set(dup.ids);
        selectedConnectionId = null;
        renderNodes();
        renderConnections();
        markDirty();
        toast(t("已复制选中的节点"), "success");
    }

    /** Ctrl+C / Ctrl+X 共用那一条：选中那批连它们内部的连线一起收进剪贴板。深拷贝一份，
     *  之后原节点怎么改都不影响这一份；切到另一张画布按 Ctrl+V 就是把它搬过去 */
    function snapshotSelection() {
        if (!selectedNodeIds.size) { toast(t("先选中要复制的节点"), "info"); return 0; }
        const ids = [...selectedNodeIds];
        clipboard = {
            nodes: structuredClone(state.nodes.filter((node) => ids.includes(node.id))),
            connections: structuredClone(state.connections
                .filter((c) => ids.includes(c.fromNodeId) && ids.includes(c.toNodeId))),
        };
        pasteStep = 0;
        return ids.length;
    }

    function copySelection() {
        const n = snapshotSelection();
        if (n) toast(tf("已复制 {n} 个节点", { n }), "success");
    }

    /** Ctrl+X：进了剪贴板再把选中那批从这张画布上摘掉（连带两端接上的线） */
    function cutSelection() {
        const n = snapshotSelection();
        if (!n) return;
        const ids = [...selectedNodeIds];
        beginEdit();
        state = { ...state, ...removeNodes(state.nodes, state.connections, ids) };
        selectedNodeIds = new Set();
        renderNodes();
        renderConnections();
        markDirty();
        toast(tf("已剪切 {n} 个节点", { n }), "success");
    }

    /** Ctrl+V：剪贴板那一批以新 id 落在看得见那一片的中心，连按一次比一批偏开 36px */
    function pasteClipboard() {
        if (!clipboard?.nodes.length) { toast(t("剪贴板是空的"), "info"); return; }
        beginEdit();
        const out = duplicateNodes(clipboard.nodes, clipboard.connections,
            clipboard.nodes.map((node) => node.id));
        const bounds = nodeBounds(out.nodes);
        const center = centerWorld();
        const cascade = 36 * (pasteStep++ % 5);   // 第一份正对中心，往后每份往右下让一格
        const anchorX = center.x - (bounds.left + bounds.right) / 2 + cascade;
        const anchorY = center.y - (bounds.top + bounds.bottom) / 2 + cascade;
        for (const node of out.nodes) {
            node.position = { x: node.position.x + anchorX, y: node.position.y + anchorY };
        }
        state = { ...state, nodes: [...state.nodes, ...out.nodes], connections: [...state.connections, ...out.connections] };
        selectedNodeIds = new Set(out.ids);
        selectedConnectionId = null;
        renderNodes();
        renderConnections();
        markDirty();
        toast(tf("已粘贴 {n} 个节点", { n: out.ids.length }), "success");
    }

    /** Ctrl+A：全选这一张画布上的节点（正文框里那一条归浏览器，见 interactions.js 的 typing 闸门） */
    function selectAllNodes() {
        if (!state.nodes.length) return;
        host.setSelection(state.nodes.map((node) => node.id), null);
    }

    /** 加一个节点：落点走 placeGrid，不压已有节点（拖放与「摆到画布」都从这一条进） */
    function addNode(type, at = null, metadata = {}) {
        beginEdit();
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

    /** 菜单那一行的默认 metadata 里，只有「上一次在这页选过的技能」是页面这一层才知道的取值
     *  （技能列表与默认技能都在 gen.js 读到手）；写死的默认值在注册表那一行的 defaults 里 */
    const ADD_SEEDS = {
        skill: () => ({ skill_id: gen?.defaultSkillId() || "" }),
        // 「加图像生成节点」的默认技能带上一次在这页选过的（技能列表还没读到时先空着，双击开浮层再选）
        editSkill: () => ({ skill_id: gen?.defaultEditSkillId() || "" }),
        // 视频档记在 metadata.kind 里：出片走简单视频那条链，成片落进下游视频节点；卡上的名字跟着档走
        videoSkill: () => ({ title: VIDEO_GEN_TITLE, kind: "video", skill_id: gen?.defaultVideoSkillId() || "" }),
    };

    /** 「加节点」菜单的一行落一张节点：先把这一行要用的清单读到手（技能列表 / 出视频技能 / 配方——胶囊里列的
     *  就是那一份），默认 metadata 看注册表那一行。菜单里那两发不落一张空节点：加图片开素材库取图铺，
     *  添加配方开配方弹窗铺一列 */
    function addTypedNode(row) {
        if (row.act === "material") return pickImage(row);
        if (row.act === "recipe") { gen?.primeRecipes(); return openRecipePicker(); }
        if (row.prime) gen?.[row.prime]?.();
        return addNode(row.type, null, row.seed ? ADD_SEEDS[row.seed]() : { ...row.defaults });
    }

    // ====== 一列车厢与「添加配方」弹窗 ======
    // 一段一厢：车厢首尾相接接到车尾那台生成节点，链序就是段序（第 1 厢在最前，接进车尾的是最后一段）。
    // 铺一列只造车厢与车厢上方那几张参考素材节点，按连线接进厢；不造文本节点 —— 车厢自己显示配方那一段的正文，
    // 要改这一发的正文就在车厢上方连一条文本线过来，连了就是覆盖（见 genInputs 与出片载荷）。
    // 出片与整列共用的视频技能 / 锚点 / 连续性 / 上下文帧 / 步数 / 种子都在车尾那一张上，车厢只带配方名与段号。
    const TRAIN_SEG_MAX = 24;         // 一列最多铺 24 厢：几十张一起铺时撤销与摆位都不可控
    const TRAIN_GAP = 40;
    const TRAIN_CARS_PER_ROW = 3;     // 3 厢一行：9 段就是 3×3、6 段就是两行三列，与出视频页铺的九宫格 / 六宫格一行一行对得上
    const TRAIN_REFS_MAX = 5;         // 每一厢上方最多铺 5 张参考素材：一次铺几十张时摆位与连线都不可控
    const TRAIN_ROW_PITCH = NODE_SPECS.image.height + TRAIN_GAP + NODE_SPECS.recipe.height + 80;   // 参考素材行 + 行距 + 车厢 + 行与行之间那一格

    /** 每一厢占多宽：铺几张参考素材就占几张的宽，车厢永远比它铺出来的那一行窄 */
    function trainColWidth(seg) {
        const n = Math.min((gen?.segmentRefs(seg) || []).filter((name) => mediaKindOf(name) === "image").length,
            TRAIN_REFS_MAX);
        return Math.max(NODE_SPECS.recipe.width, n * NODE_SPECS.image.width + (n - 1) * TRAIN_GAP);
    }

    /** 把一份配方铺成一列火车：每一厢带自己那一段，厢上方铺这一段用的参考素材节点并按连线接进厢，
     *  厢首尾相接接到车尾；不造文本节点 —— 车厢自己显示配方那一段的正文，连了文本线就是这一发的覆盖 */
    function layTrain(recipe) {
        const segs = gen?.recipeSegments(recipe) || [];
        if (!segs.length) { toast(t("配方列表读不到：先在导演页保存这份配方"), "error"); return; }
        if (segs.length > TRAIN_SEG_MAX) {
            toast(tf("段数太多（{n} 段），一列上限 {max} 段", { n: segs.length, max: TRAIN_SEG_MAX }), "info");
            return;
        }
        beginEdit();
        const car = NODE_SPECS.recipe;
        const genSpec = NODE_SPECS.gen;
        const refSpec = NODE_SPECS.image;
        const carY = refSpec.height + TRAIN_GAP;   // 车厢在参考素材行下面这一格
        const cols = segs.map(trainColWidth);
        const carsInRow = (row) => Math.min(segs.length - row * TRAIN_CARS_PER_ROW, TRAIN_CARS_PER_ROW);
        // 一列厢的 x 累的是「这一行里它左边那几厢」的宽与间距：按行号算会把同一行的厢全落在同一处
        const slotX = (row, idx) => origin.x + cols
            .slice(row * TRAIN_CARS_PER_ROW, row * TRAIN_CARS_PER_ROW + idx)
            .reduce((sum, w) => sum + w + TRAIN_GAP, 0);
        const rowWidth = (row) => cols
            .slice(row * TRAIN_CARS_PER_ROW, row * TRAIN_CARS_PER_ROW + carsInRow(row))
            .reduce((sum, w) => sum + w + TRAIN_GAP, 0) - TRAIN_GAP;
        const carRows = Math.ceil(segs.length / TRAIN_CARS_PER_ROW);
        const tailRow = segs.length % TRAIN_CARS_PER_ROW ? carRows - 1 : carRows;   // 最后一行铺满就换下一行行首
        const tailIdx = tailRow === carRows - 1 ? carsInRow(tailRow) : 0;           // 车尾紧跟最后一厢右边那一格
        const rows = tailRow + 1;
        // 整块落在视口中心：一次铺几十张要铺在看得见的地方
        const at = centerWorld();
        const widest = Array.from({ length: rows }, (_x, row) =>
            (row < carRows ? rowWidth(row) : 0) + (row === tailRow ? TRAIN_GAP + genSpec.width : 0))
            .reduce((max, w) => Math.max(max, w), 0);
        const origin = {
            x: at.x - widest / 2,
            y: at.y - ((rows - 1) * TRAIN_ROW_PITCH + carY + Math.max(car.height, genSpec.height)) / 2,
        };
        const created = [];
        const connections = [];
        let prev = null;
        for (let i = 0; i < segs.length; i += 1) {
            const row = Math.floor(i / TRAIN_CARS_PER_ROW);
            const carAt = { x: slotX(row, i % TRAIN_CARS_PER_ROW) + Math.round((cols[i] - car.width) / 2),
                y: origin.y + row * TRAIN_ROW_PITCH + carY };
            const segNode = createCanvasNode("recipe", carAt, { recipe, segment: i });
            created.push(segNode);
            // 参考素材落在厢的正上方，按连线接进厢：素材节点带 recipe/asset，出片那一发由后端从配方 assets 取
            const names = gen.segmentRefs(segs[i])
                .filter((name) => mediaKindOf(name) === "image").slice(0, TRAIN_REFS_MAX);
            const refRow = names.length * refSpec.width + (names.length - 1) * TRAIN_GAP;
            names.forEach((name, k) => {
                const refNode = createCanvasNode("image",
                    { x: carAt.x + Math.round((car.width - refRow) / 2) + k * (refSpec.width + TRAIN_GAP),
                        y: origin.y + row * TRAIN_ROW_PITCH },
                    { asset: name, recipe });
                created.push(refNode);
                connections.push({ id: `conn-${refNode.id}-${segNode.id}`, fromNodeId: refNode.id, toNodeId: segNode.id });
            });
            if (prev) connections.push({ id: `conn-${prev.id}-${segNode.id}`, fromNodeId: prev.id, toNodeId: segNode.id });
            prev = segNode;
        }
        // 车尾只带整列共用的那一份：技能与锚点 / 连续性 / 上下文帧 / 步数 / 种子（配方名与段号在每一厢上）
        const { recipe: _r, segment: _s, skill_id: _k, ...shared } = readRecipeParams({});
        const tail = createCanvasNode("gen",
            { x: slotX(tailRow, tailIdx), y: origin.y + tailRow * TRAIN_ROW_PITCH + carY + Math.round((car.height - genSpec.height) / 2) },
            { ...shared, title: VIDEO_GEN_TITLE, kind: "video", chain: "train", skill_id: "" });
        connections.push({ id: `conn-${prev.id}-${tail.id}`, fromNodeId: prev.id, toNodeId: tail.id });
        created.push(tail);
        state = { ...state, nodes: [...state.nodes, ...created], connections: [...state.connections, ...connections] };
        selectedNodeIds = new Set(created.filter((n) => n.type === "recipe").map((n) => n.id));
        selectedConnectionId = null;
        renderNodes();
        renderConnections();
        markDirty();
        fitView();   // 一次铺几十张时画面要自己拉回来，否则铺在看不见的地方
        toast(tf("已铺好 {n} 段：参考素材按连线接进每一厢，出片与整列共用的技能在车尾", { n: segs.length }), "success");
    }

    /** 「添加配方」弹窗：列导演页自己存的那份配方（gen 里已滤掉内置预设与没有段的），一张卡一份配方，
     *  点一张就直接串成一列。搜索框按名字过滤；Esc 与点卡片外头收窗 —— 收法与画布切换那扇面板同一套 */
    function openRecipePicker() {
        if (view.picker) return;
        const search = $el("input", { className: "ns-canvas-picker-search", type: "search",
            placeholder: t("搜配方名"), oninput: () => renderCards() });
        const list = $el("div", { className: "ns-canvas-picker-list" });
        const box = $el("div", { className: "ns-canvas-picker", role: "dialog", "aria-label": t("添加配方") }, [
            $el("div", { className: "ns-canvas-picker-head" }, [
                $el("span", { className: "ns-canvas-picker-title", textContent: t("添加配方") }),
                search,
            ]),
            list,
        ]);
        const mask = $el("div", { className: "ns-canvas-picker-mask",
            onclick: (e) => { if (e.target === mask) close(); } }, [box]);
        function close() {
            mask.remove();
            view.picker = null;
            document.removeEventListener("keydown", escape, true);
        }
        function escape(e) {
            if (e.key === "Escape") close();
        }
        function renderCards() {
            const word = search.value.trim().toLowerCase();
            const rows = (gen?.recipeCards() || []).filter((r) => !word || String(r.name).toLowerCase().includes(word));
            list.replaceChildren(...rows.map((row) => {
                // 封面沿用配方卡片那一条：各段首帧里的第一张（导演配方常只存提示词，没有就是文字位）
                const frame = (row.segments || []).map((s) => String(s.first_frame || "")).find(Boolean) || "";
                return $el("button", { className: "ns-canvas-picker-card", type: "button",
                    title: tf("串开 {n} 段：一段一厢接到车尾", { n: (row.segments || []).length }),
                    onclick: () => { close(); layTrain(row.name); } }, [
                    frame
                        ? $el("img", { className: "ns-canvas-picker-cover", alt: "", draggable: "false",
                            src: thumbUrl(row.name, frame, "", 192) })
                        : $el("span", { className: "ns-canvas-picker-cover", textContent: t("无封面") }),
                    $el("span", { className: "ns-canvas-picker-name", textContent: row.name }),
                    $el("span", { className: "ns-canvas-picker-meta", textContent: gen?.recipeCardText(row.name) || "" }),
                ]);
            }));
            if (!rows.length) {
                list.append($el("div", { className: "ns-canvas-picker-empty",
                    textContent: word ? t("没有对得上的配方") : t("没有可串的配方：先在导演页保存一份") }));
            }
        }
        view.el.appendChild(mask);
        view.picker = mask;
        renderCards();
        document.addEventListener("keydown", escape, true);
        search.focus();
    }

    /** 删选中的东西：选中一条线先删线，否则删选中那批节点连带两端接上的线 */
    function deleteSelection() {
        if (!selectedConnectionId && !selectedNodeIds.size) return;   // 没选中就不压一份空栈：撤销不该出现按了没反应的一步
        beginEdit();
        if (selectedConnectionId) {
            state = { ...state, connections: state.connections.filter((c) => c.id !== selectedConnectionId) };
            selectedConnectionId = null;
            renderNodes();   // 断开一条线，这一端节点上的输入行也回到没有它的样子
            renderConnections();
            paintSelection();
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

    /** 「加图片 / 加视频输入 / 加音频输入」：从素材库取素材铺上画布（一次收窗）。图那一批按不重叠网格
     *  铺，片与声音一份落一张输入节点。装配层没交弹窗时回到建一张空节点 —— 节点上那一枚就是它的后路 */
    function pickImage(row = {}) {
        const type = row.type || "image";
        const accept = row.accept || MATERIAL_ACCEPT.image;
        if (!openMaterial) return addNode(type);
        openMaterial((picked) => {
            const list = (Array.isArray(picked) ? picked : [picked]).filter((p) => p?.filename);
            if (!list.length) { toast(t(accept === "image" ? "没有选中的图" : "没有选中的素材"), "info"); return; }
            if (type === "image") {
                placeItems(list.map((p) => ({ filename: p.filename, subfolder: p.subfolder || "" })));
                return;
            }
            for (const p of list) addNode(type, null, { filename: p.filename, subfolder: p.subfolder || "" });
        }, accept);
    }

    /** 节点上那一枚（选图 / 换图 / 取用素材 / 换素材）：开素材库，只收这一类节点吃的那一类，
     *  取到的那一份填进这一张节点 */
    function pickInto(node) {
        if (!openMaterial) return;
        openMaterial((picked) => {
            const item = (Array.isArray(picked) ? picked : [picked]).find((p) => p?.filename);
            if (!item) return;
            applyMediaPick(node, item);
        }, MATERIAL_ACCEPT[node.type] || MATERIAL_ACCEPT.image);
    }

    /** 素材换进一张节点：素材库选图与拖放更换共用这一份 patch。串联铺出来的配方素材节点换成了素材库的一张，
     *  配方那一份出处要一起收掉 —— 留着它，卡上播的还是配方 assets/ 里那一张，出片带的却是新取的这一张，两头对不上 */
    function applyMediaPick(node, item) {
        const patch = { filename: item.filename, subfolder: item.subfolder || "" };
        if (node.metadata.asset) {
            // 串联铺出来的那一张：框子留给它那一格（网格步长与串联行距按它算），只收配方出处
            patch.asset = null;
            patch.recipe = null;
        } else if (node.type === "image" || node.type === "video_in") {
            resetMediaBox(node);
        }
        setNodeMetadata(node.id, patch);
    }

    /** 换素材这一发先把框收回默认那一档：比例落位只发生在还停在默认尺寸的节点上（fitMediaNode 不砸用户拉过的框），
     *  旧框里那道横竖比例因此会一直跟着这张节点活到下一次换素材。收回默认档之后，新那一张的宽高读出来就按它自己
     *  的比例重铺 —— 横框里换一张竖片不再剩一圈黑边，横框里的竖图也不再被 object-fit 裁掉一截 */
    function resetMediaBox(node) {
        const spec = NODE_SPECS[node.type] || NODE_SPECS.image;
        if (node.width === spec.width && node.height === spec.height) return;
        node.width = spec.width;
        node.height = spec.height;
    }

    /** 改一张节点的 metadata（选图与主图都走这一条）：整层重画把 <img> 与徽标落出来 */
    function setNodeMetadata(id, patch) {
        const node = state.nodes.find((n) => n.id === id);
        if (!node) return;
        beginEdit();
        node.metadata = { ...node.metadata, ...patch };
        renderNodes();
        renderConnections();
        markDirty();
    }

    /** 主图整片只留一枚（与结果板同一口径）：点已为主图的那一枚就是取消 */
    function toggleHero(id) {
        const on = !(state.nodes.find((n) => n.id === id)?.metadata.hero);
        beginEdit();
        state = { ...state, nodes: state.nodes.map((n) => ({ ...n, metadata: { ...n.metadata, hero: n.id === id ? on : false } })) };
        renderNodes();
        markDirty();
    }

    /** 附加操作栏里的删除：只删这一张，连带两端接上的线 */
    function deleteNode(id) {
        beginEdit();
        state = { ...state, ...removeNodes(state.nodes, state.connections, [id]) };
        selectedNodeIds = new Set([...selectedNodeIds].filter((x) => x !== id));
        renderNodes();
        renderConnections();
        markDirty();
    }

    /** 拖动每一帧落的位置：位置写回那一个节点对象（节点身份不变，正文那类元素闭包才不会写到旧对象上），
     *  只改几何不重建节点；收笔由手势层交 markDirty */
    function setNodePositions(entries) {
        for (const [id, pos] of entries) {
            const node = state.nodes.find((n) => n.id === id);
            if (!node) continue;
            node.position = { x: pos.x, y: pos.y };
            paintNode(node);
        }
        renderConnections();
    }

    /** 方向键 nudge：一步一段世界位移，落在选中的那批节点上 */
    function moveSelected(ids, dx, dy) {
        setNodePositions(state.nodes.filter((n) => ids.includes(n.id))
            .map((n) => [n.id, { x: n.position.x + dx, y: n.position.y + dy }]));
    }

    /** 尺寸柄的每一帧：位置与尺寸落到那一个节点上 */
    function applyResize(nodeId, out) {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (!node) return;
        node.width = out.width;
        node.height = out.height;
        node.position = { x: out.x, y: out.y };
        paintNode(node);
        renderConnections();
    }

    function connect(fromNodeId, toNodeId) {
        const next = addConnection(state.connections, state.nodes, fromNodeId, toNodeId);
        if (next.length === state.connections.length) return;   // 同方向已有这条线：静默沿用，不叠第二条
        beginEdit();
        state = { ...state, connections: next };
        renderNodes();   // 生成节点与配方卡的输入行读的就是这一批连线，线变了卡要跟着重画
        renderConnections();
        markDirty();
    }

    // ====== 落盘：改一下就存一次，攒 900ms ======
    function markDirty() {
        dirty = true;
        view.save.textContent = t("未保存");
        refreshHistory();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveProject, SAVE_DEBOUNCE_MS);
    }

    async function saveProject() {
        clearTimeout(saveTimer);
        if (!dirty) return;
        dirty = false;
        view.save.textContent = t("保存中");
        try {
            const data = await store.save(state);
            state = { ...state, id: data.id, title: data.title };
            view.save.textContent = t("已保存");
            // 新建的那张要自己进列表：不补这一条的话下拉里永远找不到它
            const at = projects.findIndex((p) => p.id === data.id);
            const meta = { id: data.id, title: data.title,
                node_count: state.nodes.length, connection_count: state.connections.length };
            if (at >= 0) projects[at] = { ...projects[at], ...meta };
            else projects.push(meta);
            renderProjectPanel();
        } catch (err) {
            dirty = true;   // 没写进去的改动留着：下一次去保存还会再来一发
            view.save.textContent = t("保存失败");
            toast(`${t("保存失败")}：${err.message}`, "error");
        }
    }

    /** 切页与关窗前调用：攒着的改动不能只留在内存里 */
    function flush() {
        clearTimeout(saveTimer);
        gen?.stopAll();   // 切页与切画布都是脱手：跑着的那一发不再写回这一张
        if (dirty) saveProject();
    }

    /** 画布面板：一画布一行，行名切过去；改名与删除收在每一行右端，末行是新建画布。条上那枚名字跟着这一张走 */
    function renderProjectPanel() {
        if (!view) return;
        const rows = projects.map((p) => $el("div", {
            className: "ns-canvas-project-row" + (p.id === state.id ? " ns-canvas-project-row-on" : ""),
            "data-canvas": p.id,
        }, [
            $el("button", { className: "ns-canvas-project-row-name", type: "button", textContent: p.title,
                onclick: () => { view.project.close(); loadProject(p.id); } }),
            rowAct(t("重命名"), "pencil", () => renameProject(p.id)),
            rowAct(t("删除画布"), "trash", () => deleteProject(p.id)),
        ]));
        const createRow = $el("button", { className: "ns-canvas-tool ns-canvas-project-new", type: "button",
            title: t("新建画布"), "aria-label": t("新建画布"),
            onclick: () => { view.project.close(); createProject(); } });
        setIconLabel(createRow, "plus", t("新建画布"));
        view.project.panel.replaceChildren(...rows, createRow);
        view.project.name.textContent = state.title || t("画布");
    }

    /** 面板行右端那两枚钮：样式默认收着，指针或键盘落到那一行才亮（style.css） */
    function rowAct(label, name, fn) {
        const btn = $el("button", { className: "ns-canvas-tool ns-canvas-project-row-act", type: "button",
            title: label, "aria-label": label, onclick: fn });
        setIcon(btn, name);
        return btn;
    }

    async function loadProjects() {
        projects = await store.list();
        renderProjectPanel();
        if (projects.length) await loadProject(projects[0].id);
    }

    async function loadProject(id) {
        flush();
        let project;
        try {
            project = await store.get(id);
        } catch (err) {
            toast(`${t("画布读不出来")}：${err.message}`, "error");
            return;
        }
        state = readCanvas(project);
        selectedNodeIds = new Set();
        selectedConnectionId = null;
        history.clear();         // 上一张的改动不能撤销到这一张上来
        refreshHistory();
        dirty = false;
        view.save.textContent = t("已保存");
        renderProjectPanel();
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
        history.clear();
        refreshHistory();
        renderNodes();
        renderConnections();
        dirty = true;
        await saveProject();
    }

    /** 改名面板里那一行的画布：prompt 预填那一行自己的名字；改的是别的画布就不动这一张 */
    async function renameProject(id) {
        const meta = projects.find((p) => p.id === id);
        const name = window.prompt(t("重命名画布"), meta ? meta.title : state.title);
        if (!name) return;
        try {
            const data = await store.rename(id, name);
            if (id === state.id) state = { ...state, title: data.title };
            // 面板里那一行也要跟着改名：只改 state.title 的话列表还挂着旧名字
            if (meta) meta.title = data.title;
            renderProjectPanel();
        } catch (err) {
            toast(`${t("重命名失败")}：${err.message}`, "error");
        }
    }

    /** 删面板里那一行的画布：删的正是正在画的这一张才换到下一张，删别的画布这一张不动 */
    async function deleteProject(id) {
        const meta = projects.find((p) => p.id === id);
        if (!window.confirm(`${t("删除画布")}「${meta ? meta.title : state.title}」：${t("节点与连线一起删掉，删完不能撤销")}`)) return;
        try {
            await store.remove(id);
        } catch (err) {
            toast(`${t("删除失败")}：${err.message}`, "error");
            return;
        }
        if (id !== state.id) { projects = await store.list(); renderProjectPanel(); return; }
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
        beginEdit();
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

    // ====== 拖放落点（本地文件 + 素材卡片） ======
    /** 一次拖放交过来的一批素材落画布：落到节点上就是换它，落在画布空白就是加一张。图按不重叠网格铺开，
     *  片 / 声音 / 正文一份一张。本地文件先落进 ComfyUI 的 input/（画布的预览与出片只认这个目录里的文件），
     *  正文类文件不上传 —— 提示词节点吃的就是 metadata.content。
     *  类型对不上的那张节点不动：把一段片换进图片节点，卡上是一张读不出来的占位图，出片也吃不到它 */
    async function dropMedia({ files = [], picked = null, at = null, nodeId = null }) {
        const items = [];
        for (const file of files) {
            const kind = dropKindOf(file.name);
            if (!kind) { toast(tf("画布不吃这个文件：{name}", { name: file.name }), "info"); continue; }
            if (kind === "text") {
                const text = await readDroppedText(file);
                if (text.length > DROP_TEXT_MAX_CHARS) toast(tf("正文太长，已截断到 {n} 字", { n: DROP_TEXT_MAX_CHARS }), "info");
                items.push({ kind, content: text.slice(0, DROP_TEXT_MAX_CHARS) });
                continue;
            }
            const media = await uploadDropped(file);
            if (media.filename) { items.push({ kind, ...media }); continue; }
            toast(media.error, "error");   // 一份文件一句：超体积那一张与旁边那一张无关
        }
        if (picked) items.push({ kind: mediaKindOf(picked.filename), ...picked });
        if (!items.length) return;
        const target = nodeId ? state.nodes.find((node) => node.id === nodeId) : null;
        const want = target ? DROP_ACCEPT[target.type] : null;
        const swapAt = want ? items.findIndex((item) => item.kind === want) : -1;
        if (swapAt >= 0) {
            applyDropPick(target, items[swapAt]);
            items.splice(swapAt, 1);
        } else if (want) {
            toast(tf("这一张节点吃的是{accept} · 已另建一张{node}",
                { accept: t(ACCEPT_LABEL[want]), node: t(NODE_SPECS[DROP_NODE[items[0].kind]].title) }), "info");
        }
        const images = items.filter((item) => item.kind === "image");
        if (images.length) placeDropImages(images, at);
        for (const item of items.filter((it) => it.kind !== "image")) {
            addNode(DROP_NODE[item.kind], at, item.kind === "text"
                ? { content: item.content }
                : { filename: item.filename, subfolder: item.subfolder || "" });
        }
    }

    /** 拖进来的文件是哪一类素材：扩展名说了算，认不出给 null。heic 这类浏览器与 LoadImage 都吃不动的收在外面，
     *  落一张永远读不出来的节点不如把话说清楚 */
    function dropKindOf(name) {
        return DROP_TEXT_EXT.test(name) ? "text" : mediaKindOf(name, true);
    }

    /** 本地正文文件读进内存：FileReader 是这一发的唯一读法（浏览器、桌面窗口与 jsdom 都只有它稳） */
    function readDroppedText(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => resolve("");
            reader.readAsText(file);
        });
    }

    /** 本地文件落进 ComfyUI 的 input/：画布自己那条文件写入（studio/canvas.py 的 /neo_canvas/upload）。
     *  拖放要的是文件落地，桌面端离线服务照 app/studio_caps.py 的 _CANVAS 自己答 —— 内核在不在跑
     *  与这一放无关；节点上的预览走的也是 /neo_gallery/image 这一族离线读得到的路由 */
    async function uploadDropped(file) {
        try {
            const query = `?name=${encodeURIComponent(file.name)}`;
            const resp = await api.fetchApi(`/neo_canvas/upload${query}`, { method: "POST", body: file });
            const data = await resp.json().catch(() => null);
            // 状态码带在话里：超体积那条（studio/canvas.py 的 MAX_UPLOAD_BYTES）与这条路由本身不通
            // 是两回事，光一句「上传失败」分不开
            if (!resp.ok || !data?.filename) {
                return { error: tf("上传失败（{code}）：{name}", { code: resp.status, name: file.name }) };
            }
            return { filename: data.filename, subfolder: data.subfolder || "" };
        } catch {
            return { error: tf("上传失败：{name}", { name: file.name }) };
        }
    }

    /** 更换落点的那一发：正文换正文，素材走素材库选图那一条同一份 patch（换上去的框跟着新素材的比例重落） */
    function applyDropPick(node, item) {
        if (node.type === "text") { setNodeMetadata(node.id, { content: item.content }); return; }
        applyMediaPick(node, item);
    }

    /** 一次拖进来的那一批图铺开：格心就是落点（与结果板「摆到画布」共用 placeGrid，只把格心从视口中心换成落点），
     *  整批一次压栈 —— 撤销一次退掉这一放 */
    function placeDropImages(items, at) {
        const spec = NODE_SPECS.image;
        const start = { x: (at?.x ?? 0) - spec.width / 2, y: (at?.y ?? 0) - spec.height / 2 };
        const pool = [...state.nodes];
        const created = [];
        for (const item of items) {
            const node = createCanvasNode("image", placeGrid(pool, spec, start),
                { filename: item.filename, subfolder: item.subfolder || "" });
            pool.push(node);
            created.push(node);
        }
        beginEdit();
        state = { ...state, nodes: [...state.nodes, ...created] };
        selectedNodeIds = new Set(created.map((node) => node.id));
        selectedConnectionId = null;
        renderNodes();
        renderConnections();
        markDirty();
    }

    /** LLM 链（增强 / 反推）的成文写回画布：按连线顺序找这台节点下游第一张空的提示词节点填进去，
     *  下游没有空位就在它右下方新建一张接上。整发一次压栈 —— 撤销一次退掉这一发落下的改动 */
    function applyLlmText(genId, text) {
        const gen = state.nodes.find((n) => n.id === genId);
        if (!gen) return;
        beginEdit();
        const slot = state.connections
            .filter((conn) => conn.fromNodeId === genId)
            .map((conn) => state.nodes.find((n) => n.id === conn.toNodeId))
            .find((n) => n?.type === "text" && n.metadata.disabled !== true
                && !String(n.metadata.content || "").trim());
        if (slot) {
            slot.metadata = { ...slot.metadata, content: text };
            renderNodes();
            markDirty();
            return;
        }
        const spec = NODE_SPECS.text;
        const node = createCanvasNode("text", placeGrid(state.nodes, spec,
            { x: gen.position.x + gen.width + 32, y: gen.position.y }), { content: text });
        state = {
            ...state,
            nodes: [...state.nodes, node],
            connections: [...state.connections,
                { id: `conn-${genId}-${node.id}`, fromNodeId: genId, toNodeId: node.id }],
        };
        renderNodes();
        renderConnections();
        markDirty();
    }

    /** 出片结果写回画布：先按连线顺序填这台节点下游那几张空节点（出图填图片节点，出片填视频节点），
     *  多出来的在右侧新建同类节点接上。整发一次压栈 —— 撤销一次退掉这一发落下的全部节点；
     *  节点已经不在这一张画布上（切走了）就一个不写 */
    function applyGenResult(genId, files, type = "image") {
        const left = (files || []).filter((img) => img?.filename);
        const gen = state.nodes.find((n) => n.id === genId);
        if (!gen || !left.length) return;
        beginEdit();
        for (const conn of state.connections) {
            if (conn.fromNodeId !== genId || !left.length) continue;
            const slot = state.nodes.find((n) => n.id === conn.toNodeId);
            // 停用的那一张不是落点：整列出片跳过它，成片也不该铺到它身上，往下找空位新开
            if (!slot || slot.type !== type || slot.metadata.filename || slot.metadata.disabled === true) continue;
            const img = left.shift();
            slot.metadata = { ...slot.metadata, filename: img.filename, subfolder: img.subfolder || "" };
        }
        const spec = NODE_SPECS[type] || NODE_SPECS.image;
        const pool = [...state.nodes];
        const base = { x: gen.position.x + gen.width + 32, y: gen.position.y };
        const created = [];
        for (const img of left) {
            const node = createCanvasNode(type, placeGrid(pool, spec, base), {
                filename: img.filename,
                subfolder: img.subfolder || "",
            });
            pool.push(node);
            created.push(node);
        }
        state = {
            ...state,
            nodes: [...state.nodes, ...created],
            connections: [...state.connections,
                ...created.map((n) => ({ id: `conn-${genId}-${n.id}`, fromNodeId: genId, toNodeId: n.id }))],
        };
        renderNodes();
        renderConnections();
        markDirty();
    }

    return { build: buildCanvas, flush, placeItems, current: () => state };
}
