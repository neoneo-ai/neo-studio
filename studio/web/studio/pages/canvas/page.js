// Neo Studio「画布」页：图片节点与提示词节点铺在一张无限画布上，连线串起生成顺序。
//
// 这一页管装配与生命周期：工具条、视口、页面自己的 state 与落盘，以及装配层交来的三样。
// 几何在 geometry.js，数据契约与 /neo_canvas/* 读写在 store.js，节点 DOM 在 nodes.js，
// 连线画在 connections.js，平移/拖动/框选/拉线这些手势在 interactions.js（手势状态不在这一页）。
// 引擎层的出处与上游对应关系写在 geometry.js 头上，LICENSES/infinite-canvas.txt 是那份授权全文。
import { t } from "../../../js/core/i18n.js";
import { setIcon, setIconLabel } from "../../../js/core/icons.js";
import { addConnection, gridGeometry, MAX_SCALE, MIN_SCALE, nodeBounds, placeGrid, removeNodes, screenToCanvas, zoomViewportAt } from "./geometry.js";
import { BACKGROUND_MODES, createCanvasNode, createCanvasStore, NODE_SPECS, readCanvas } from "./store.js";
import { applyNodeGeometry as paintNodeGeometry, renderNodes as renderNodeLayer, paintSelection as paintNodeSelection } from "./nodes.js";
import { renderConnections as renderLinkLayer, renderActiveConnection as paintActiveLine } from "./connections.js";
import { attachCanvasInteractions } from "./interactions.js";

const SAVE_DEBOUNCE_MS = 900;

/** 画布页工厂：openMaterial 由装配层交下来（素材库弹窗，一次收窗）；没有它时「加图片」
 *  与「选图」回到建空图片节点 —— ComfyUI 侧没有这扇弹窗。 */
export function createCanvasPage({ $el, api, toast, openMaterial }) {
    let state = readCanvas({});
    let selectedNodeIds = new Set();
    let selectedConnectionId = null;
    let dirty = false;
    let saveTimer = 0;
    let projects = [];
    let view = null;               // build 之后才有：DOM 引用与每帧要改的那几层
    let ready = null;              // 首次进页把上一张画布读进来的那条 promise
    const store = createCanvasStore({ api });

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
        attachCanvasInteractions({ stage, view, host });
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
            mkLabel(t("加图片"), "image", () => pickImage()),
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

    function renderNodes() {
        if (!view) return;
        renderNodeLayer({ nodeLayer: view.nodeLayer, links: view.links, hint: view.hint, nodes: state.nodes,
            selectedNodeIds, selectedConnectionId, $el, onText,
            onPick: pickInto, onHero: (node) => toggleHero(node.id), onDelete: (node) => deleteNode(node.id) });
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

    /** 提示词节点正文改一下：正文存在 metadata.content，改完就要落盘 */
    function onText(node, content) {
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
        paintNode,
        paintConnections: renderConnections,
        paintActive,
        markDirty,
        isPageActive,
        addNode,
        deleteSelection,
        setNodePositions,
        moveSelected,
        applyResize,
        connect,
    };

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

    /** 删选中的东西：选中一条线先删线，否则删选中那批节点连带两端接上的线 */
    function deleteSelection() {
        if (selectedConnectionId) {
            state = { ...state, connections: state.connections.filter((c) => c.id !== selectedConnectionId) };
            selectedConnectionId = null;
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

    /** 「加图片」：从素材库取图铺上画布（一次收窗，一批按不重叠网格铺）。装配层没交弹窗时
     *  回到建一个空图片节点 —— 节点上的「选图」就是它的后路 */
    function pickImage() {
        if (!openMaterial) return addNode("image");
        openMaterial((picked) => {
            const list = (Array.isArray(picked) ? picked : [picked]).filter((p) => p?.filename);
            if (!list.length) { toast(t("没有选中的图"), "info"); return; }
            placeItems(list.map((p) => ({ filename: p.filename, subfolder: p.subfolder || "" })));
        });
    }

    /** 空图片节点上的「选图」：取到的那一张填进这一张节点 */
    function pickInto(node) {
        if (!openMaterial) return;
        openMaterial((picked) => {
            const item = (Array.isArray(picked) ? picked : [picked]).find((p) => p?.filename);
            if (!item) return;
            setNodeMetadata(node.id, { filename: item.filename, subfolder: item.subfolder || "" });
        });
    }

    /** 改一张节点的 metadata（选图与主图都走这一条）：整层重画把 <img> 与徽标落出来 */
    function setNodeMetadata(id, patch) {
        const node = state.nodes.find((n) => n.id === id);
        if (!node) return;
        node.metadata = { ...node.metadata, ...patch };
        renderNodes();
        renderConnections();
        markDirty();
    }

    /** 主图整片只留一枚（与结果板同一口径）：点已为主图的那一枚就是取消 */
    function toggleHero(id) {
        const on = !(state.nodes.find((n) => n.id === id)?.metadata.hero);
        state = { ...state, nodes: state.nodes.map((n) => ({ ...n, metadata: { ...n.metadata, hero: n.id === id ? on : false } })) };
        renderNodes();
        markDirty();
    }

    /** 节点头上的删除：只删这一张，连带两端接上的线 */
    function deleteNode(id) {
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
        state = { ...state, connections: next };
        renderConnections();
        markDirty();
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
            const data = await store.save(state);
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
        projects = await store.list();
        fillProjectSelect();
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
            const data = await store.rename(state.id, name);
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
            await store.remove(state.id);
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
