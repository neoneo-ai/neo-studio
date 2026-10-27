// Neo Studio 外桌面端：hash 路由（#/home #/gallery #/paint #/director #/skills #/settings）+ 各视图挂载。
// 功能全部复用 web/ 现有模块（import-map 把 scripts/* 指到 shim）：
// - 素材：NeoGallery（gallery.js 注册的扩展，侧栏 tab 的 render 直接挂进主区）
// - 导演：配方面板（recipes.js）+ 整片生成面板（POST /neo_studio/director/generate）
// - 技能：统一技能管理（skill.js createSkillManager，与顶栏「技能管理」同组件，直接展开无弹窗）
// - 设置：生图/生视频/LLM 设置表单（内嵌，无弹窗）
import { app, initExtensions, getSidebarTab, onSidebarTabChange } from "./shim/app.js";
import { api, reconnectSocket } from "./shim/api.js";
import { configure as configureRoutes, resolve as resolvePath } from "./shim/route.js";
import { $el } from "./shim/ui.js";

import "../gallery.js";   // 注册 comfy.neo.gallery 扩展（NeoGallery + 侧栏 tab 定义）
import { setDirectorEditorHost, DIRECTOR_RECIPE_SAVED_EVENT, SEG_MODES, MODE_LABELS, LEGACY_MODE_MAP } from "../director.js";
import { setPaintHost, openGenMaterialDialog, openImageEditDialog, chipButton, skillParamsChip } from "../gallery-gen.js";
import { createFramePlayer, DOCK_PREVIEW_SIDE, AGENT_PREVIEW_SIDE } from "../live-preview.js";
import { createRecipesPanel } from "../recipes.js";
import { listVideoSkills } from "../recipes.js";
import { skillDisplayName } from "../skill.js";
import { createImageGenSettingsForm, createVideoGenSettingsForm, createVideoModelConfigSection, listVideoGenModels, getSkillGenConfig, modelFamily } from "../image-gen.js";
import { createModelConfigForm } from "../llm-setting.js";
import { createSkillManager } from "../skill.js";
import { createAgentPanel, createMcpPanel, createAgentPrefsForm } from "../agent-panel.js";
import { t, tf, getLang, applyLang, LANGS } from "../js/core/i18n.js";
import { icon, setIcon, setIconLabel } from "../js/core/icons.js";
import { createLibraryModal } from "../js/core/lib-modal.js";

const view = document.getElementById("ns-view");
const REPO_URL = "https://github.com/neoneo-ai/neo-studio";   // 设置「关于」里的仓库行，与顶栏「关于插件」同一地址
let directorPanelOpts = null;   // 导演页配方面板选项（buildDirector 设置；含 onSelect 回传选中配方）
let onDirectorShown = null;     // 进导演页时补拉的活：隐藏期间跳过的 director_spec 在进本页时补一次

// ====== 智能体的界面上下文：宿主只交事实，面板画进上下文条并随请求体交后端进系统提示词 ======
// 只交当前选中页签自己那一栏：导演页的配方、绘画页的模式、素材页的目录各留自己那页，切到技能 / 设置页
// 就只剩页面本身——在技能页还带着「当前配方 X」出片，就是拿没在看的页签干扰这一轮。
// 素材库目录在取用时现读画廊：画廊导航没有对外事件，读一次现值比在 gallery.js 里插监听便宜
const agentCtx = { page: "gallery", recipe: "", segments: 0, paint_mode: "text" };
let agentCtxRefresh = null;     // 智能体页建好时挂上的重画回调，页面没建过就没有面板可通知
let agentEntryBtn = null;       // 顶栏那颗入口按钮：showView 靠它标出当前在不在智能体页

function notifyAgentCtx() { if (agentCtxRefresh) agentCtxRefresh(); }

function agentContext() {
    const view = app.neoGallery?.currentView;
    const lib = (view?.mode === "directory" && view.source)
        ? [view.source, ...(view.categoryPath || [])].join("/") : "";
    // 素材库目录带 角色图标记时一并报出去：智能体基于这些附件图建导演配方
    // 要照画廊 ⋯ 菜单那条口径走全参考，它自己没有目录标记这份数据
    const withLib = (ctx) => {
        if (!lib) return ctx;
        ctx.gallery_path = lib;
        if (app.neoGallery?.isCharacterDir?.(view)) ctx.character_dir = true;
        return ctx;
    };
    const page = agentCtx.page;
    if (page === "director") {
        // 弹窗开着时素材库是导演页自己上屏的；关掉时画廊交还收留宿主，报它就是串到素材页那一份目录
        const ctx = { page, recipe: agentCtx.recipe, segments: agentCtx.segments };
        return (lib && libModal?.isOpen() && libScope === "director") ? withLib(ctx) : ctx;
    }
    if (page === "paint") {
        const ctx = { page, paint_mode: agentCtx.paint_mode };
        return (lib && libModal?.isOpen() && libScope === "paint") ? withLib(ctx) : ctx;
    }
    if (page === "gallery") return withLib({ page });
    return { page };
}

// ====== 视图缓存：每个 tab 只挂载一次，切换时显隐（保留画廊滚动/编辑状态） ======
const views = new Map();

function ensureView(name, build) {
    if (views.has(name)) return views.get(name);
    const el = $el("div", { className: "ns-page ns-hidden" });
    view.appendChild(el);
    views.set(name, el);
    const p = build(el);
    if (p && typeof p.catch === "function") p.catch(e => console.error(`[Neo Studio] view ${name} build failed:`, e));
    return el;
}

function showView(name) {
    for (const [key, el] of views) el.classList.toggle("ns-hidden", key !== name);
    document.querySelectorAll(".ns-tabs a").forEach(a =>
        a.classList.toggle("active", a.dataset.tab === name));
    if (name !== currentView) {
        libModal?.close();      // 离开该页收起素材库弹窗（close 自己把画廊交还宿主）
        recipesModal?.close();  // 配方弹窗同一条路
        // 离开素材页：侧栏替身归位。素材页挂载画廊时把 activeSidebarTabId 写成 neo.gallery，
        // 不归位的话导演页 / 绘画页的「素材库」按钮再写同一个 id 会被去重吃掉，弹窗打不开
        const tab = app.extensionManager.sidebarTab;
        if (tab && name !== "gallery") tab.activeSidebarTabId = null;
    }
    currentView = name;
    if (name !== "agent") agentCtx.page = name;   // 智能体页不抢上下文：条上继续报上一个生成页（配方 / 绘画模式还在用）
    notifyAgentCtx();
    agentEntryBtn?.classList.toggle("ns-agent-toggle-on", name === "agent");
    setMemActive(name === "director" || name === "paint" || name === "video" || name === "agent");   // 显存读数只在生成页（导演 / 绘画 / 视频 / 智能体）轮询
    if (name === "director" && onDirectorShown) onDirectorShown();
    // 画廊单例的宿主跟着视图走：素材页 = 整片宿主；弹窗开着 = 弹窗宿主；其余页 = 交还素材页 / 收留宿主
    // 一次只挂一处：切页时不会两次 render 抢同一个元素（后落的那次会把画廊拽回上一页）
    if (name === "gallery") {
        if (galleryMountHost !== galleryPageHost) mountGallery(galleryPageHost);
    } else if (!libModal?.isOpen()) {
        const host = galleryStandby();
        if (galleryMountHost !== host) mountGallery(host);
    }
}
// 内嵌宿主（绘画面板 / 导演编辑器）的「打开时切到本页」入口一律走这里：直接 showView 会把
// location.hash 留在上一页，之后点顶栏那一页的 tab（href 与 hash 相同）不动，页面就再也切不回去
// （素材页「生成素材」→ 绘画页 → 点「素材」无反应）
function go(name) {
    if (location.hash === `#/${name}`) {
        showView(name);
        return;
    }
    // 换页用 pushState，不赋 location.hash：fragment 导航在 Chromium 里同样派发 popstate，
    // 画廊的 popstate 监听把它读成「浏览器后退」，切一次页就顺手把画廊的目录退掉。
    history.pushState(null, "", `#/${name}`);
    route();   // 视图可能还没建（技能 / 设置按需建），交给和 hashchange 同一条路径
}

// 顶栏 logo / tab 是 <a href="#/xxx">：锚点按 href 重新解析 URL，把画廊写在 ?gallery= 里的
// 目录丢掉，浏览器还会为这次同文档导航派发 popstate（画廊的 popstate 监听把它当「后退」）。
// 于是每点一次「素材」就在首页和目录之间来回跳。交给路由：只换视图，不做导航。
function bindHeaderNav() {
    for (const a of document.querySelectorAll(".ns-header a[href^='#/']")) {
        a.addEventListener("click", (e) => {
            e.preventDefault();
            go(a.dataset.tab || a.getAttribute("href").slice(2));
        });
    }
}

// ====== 素材宿主：NeoGallery 元素是单例，素材页与素材库弹窗共用，挂载点随宿主切换 ======
let galleryTab = null;
let galleryPageHost = null;     // 素材页宿主
let galleryMountHost = null;    // gallery.element 当前所在宿主
let galleryStandbyHost = null;  // 素材页还没建时的收留宿主（游离节点，建页时再换）
let currentView = "gallery";    // 当前显示的视图名（弹窗与生成入口按视图归属）
let libModal = null;            // 素材库弹窗（导演页 / 绘画页共用同一个画廊单例）
let libModalHost = null;        // 弹窗里的画廊宿主：libScope 记它此刻替哪一页上屏
let libScope = "director";
let recipesModal = null;        // 导演页配方弹窗
let libPendingPick = null;      // director.js 的 neo:media-pick 交来的取用回调（弹窗打开时消费）

function mountGallery(host) {
    galleryTab = galleryTab || getSidebarTab("neo.gallery");
    if (!galleryTab) {
        host.textContent = t("Neo Gallery 未加载");
        return Promise.resolve(false);
    }
    galleryMountHost = host;
    return galleryTab.render(host).catch(e => {
        console.error("[Neo Studio] gallery render failed:", e);
        host.textContent = t("Neo Gallery 加载失败");
    });
}

// 画廊元素不能悬空：从素材库弹窗摘下来时先寄这里（画廊页宿主已建就直接交还）
function galleryStandby() {
    return galleryPageHost || (galleryStandbyHost ||= $el("div", { className: "ns-gallery-host" }));
}

function buildGallery(el) {
    const host = $el("div", { className: "ns-gallery-host", dataset: { libScope: "page" } });
    el.appendChild(host);
    galleryPageHost = host;
    mountGallery(host);
}

// 编辑器「素材库」→ media-transfer 写 sidebarTab.activeSidebarTabId；Studio 没有 ComfyUI 侧栏，
// 写入落到素材库弹窗（取用回调由 director.js 抢跑一步经 neo:media-pick 送来）
function ensureLibModal() {
    if (libModal) return libModal;
    libModalHost = $el("div", { className: "ns-gallery-host", dataset: { libScope: "director" } });
    const modal = createLibraryModal({ storageKey: "neo_studio_libmodal_assets", scope: "assets" });
    modal.setContent(libModalHost);
    document.body.appendChild(modal.el);
    modal.setOnClose(() => {
        const g = app.neoGallery;
        if (g) { g.onSelectionChange = null; g.clearSelection(); }   // 勾选不能带出弹窗
        app.extensionManager.sidebarTab.activeSidebarTabId = null;   // 替身侧栏归位，下次写同一 id 不被去重吃掉
        mountGallery(galleryStandby()).then(notifyAgentCtx);         // 弹窗关了：素材库不在本页上屏，画廊交还
    });
    libModal = modal;
    return modal;
}

/** 打开素材库弹窗。onPick = 点卡片 / 批量取用回调（null = 纯浏览：卡片照旧开灯箱）. */
function openLibModal(scope, onPick) {
    const modal = ensureLibModal();
    const g = app.neoGallery;
    libScope = scope;
    libModalHost.dataset.libScope = scope;
    if (g) g.onSelectionChange = (n) => modal.setPickCount(n);
    modal.setPickMode({
        onPick: onPick || null,
        onBulk: onPick && g ? () => {
            const keys = [...g._selectedItems];
            g.clearSelection();
            onPick(keys.map((key) => {
                const at = key.indexOf("\u0000");
                return { subfolder: key.slice(0, at), filename: key.slice(at + 1) };
            }));
        } : null,
        onClear: () => g?.clearSelection(),
    });
    modal.open(t("素材库"));
    if (galleryMountHost !== libModalHost) mountGallery(libModalHost).then(notifyAgentCtx);
    else notifyAgentCtx();
}

// 绘画页取用：弹窗点卡片 = 把这张图喂进图片编辑面板当原图（openImageEditDialog 自己切到编辑模式）
function paintPickImage(images) {
    const img = images[0];
    if (!img) return;
    openImageEditDialog(app.neoGallery, { filename: img.filename }, img.subfolder);
}

onSidebarTabChange((id) => {
    if (currentView !== "director" && currentView !== "paint") return;
    if (id === "neo.gallery") openLibModal(currentView, currentView === "paint" ? paintPickImage : libPendingPick);
    else libModal?.close();
});
// 导演编辑器各素材库按钮把取用回调随侧栏写入一起交来；ComfyUI 模式没有这条监听
window.addEventListener("neo:media-pick", (e) => { libPendingPick = e.detail?.onPick || null; });

// ====== 导演页：整片生成面板 + 配方列表 ======
let genState = null;   // 当前整片任务 {task_id, statusEl, barEl, runBtn, cancelBtn}
const GEN_TERMINAL = ["succeeded", "failed", "cancelled"];

function updateGenStatus(task) {
    if (!genState || task.task_id !== genState.task_id) return;
    // 终态之后落地的旧载荷（在途轮询 / 迟到 WS）不得把界面拉回生成中：进度条与取消按钮会复活，
    // 用户点下去只会拿到「任务已结束，无法取消」
    if (genState.terminal && !GEN_TERMINAL.includes(task.status)) return;
    const { statusEl, barEl, fillEl } = genState;
    // 终态：定格预览 / 时间轴清掉段状态（停轮询在 WS / 轮询两条事件路径里做，闭包可见 stopPolling）
    if (GEN_TERMINAL.includes(task.status)) {
        genState.terminal = true;   // 界面就此定格，后续旧载荷一律作废
        genState.livePlayer?.pause();
        genState.onTerminal?.();
    }
    barEl.style.display = task.status === "running" ? "block" : "none";
    if (task.status === "queued") {
        statusEl.textContent = tf("排队中…（{recipe}）", { recipe: task.recipe });
    } else if (task.status === "running") {
        const p = task.progress;
        statusEl.textContent = p ? tf("生成中… {value}/{max}", { value: p.value, max: p.max }) : t("生成中…");
        if (p) fillEl.style.width = `${Math.round(100 * p.value / p.max)}%`;
    } else if (task.status === "succeeded" && !genState.done) {
        genState.done = true;   // 终态可能经 WS + 在途轮询重复到达：成片只替换一次
        statusEl.textContent = tf("已完成：{filename}", { filename: task.filename });
        const url = `/view?filename=${encodeURIComponent(task.filename)}`
            + `&subfolder=${encodeURIComponent(task.subfolder || "")}&type=output`;
        // 成片就地替换实时预览（定格帧一并清掉）；也可在浏览器单独打开
        genState.mediaRight.replaceChildren(
            $el("video", { className: "ns-gen-preview ns-gen-final", controls: true, src: url }),
            $el("a", { className: "ns-gen-final", href: url, textContent: tf("{filename}（在浏览器中打开）", { filename: task.filename }) })
        );
        refreshRecipesPanel();
    } else if (task.status === "failed") {
        statusEl.textContent = tf("失败：{error}", { error: task.error || t("未知错误") });
    } else if (task.status === "cancelled") {
        statusEl.textContent = t("已取消");
    }
    genState.runBtn.disabled = task.status === "queued" || task.status === "running";
    genState.cancelBtn.style.display = (task.status === "queued" || task.status === "running") ? "" : "none";
}

let recipesPanelEl = null;
async function refreshRecipesPanel() {
    if (!recipesPanelEl || !directorPanelOpts) return;
    const parent = recipesPanelEl.parentNode;
    // 先建好再换：先摘掉旧面板的话，弹窗打开那一下列表是空的（异步取数期间整块空白闪一下）
    const next = await createRecipesPanel(directorPanelOpts());   // 导演页只列多段导演配方；点选回传 onSelect
    parent?.replaceChild(next, recipesPanelEl);
    recipesPanelEl = next;
}


let recipesHost = null;   // 配方弹窗里的配方面板宿主（buildDirector 建）

// ====== 导演页：上导演编辑器 + 分隔条 + 下整片生成面板（配方与素材库走弹窗） ======
const SPLIT_KEY = "neo_studio_director_split";
const SPLIT_PANEL_MIN = 90;   // 生成面板下限：一行控制 + 进度 + 状态行还能用
const SPLIT_EDITOR_MIN = 240;  // 编辑器下限：编辑器内部自带滚动，再小就没法编辑了

function buildDirectorSplit(main, genPanel) {
    const label = $el("span", { className: "ns-director-split-label" });
    const split = $el("div", {
        className: "ns-director-split", role: "separator", "aria-orientation": "horizontal", tabindex: "0",
        title: t("拖动调整高度 · 双击收起 / 展开生成面板"),
    }, [label]);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SPLIT_KEY) || "null"); } catch { /* 偏好读不到就用默认 */ }
    let collapsed = !!saved?.collapsed;

    const clamp = (h) => {
        const max = Math.max(SPLIT_PANEL_MIN, main.clientHeight - split.offsetHeight - SPLIT_EDITOR_MIN);
        return Math.max(SPLIT_PANEL_MIN, Math.min(h, max));
    };
    const setHeight = (h) => {
        const v = Math.round(clamp(h)) + "px";
        genPanel.style.height = v;
        genPanel.style.setProperty("--ns-gen-h", v);   // 结果区（实时预览 / 成片）按面板高度伸缩
    };
    const persist = () => localStorage.setItem(SPLIT_KEY, JSON.stringify({ height: genPanel.offsetHeight, collapsed }));
    const apply = () => {
        main.classList.toggle("ns-director-collapsed", collapsed);
        genPanel.style.display = collapsed ? "none" : "";
        label.textContent = collapsed ? t("▸ 生成面板") : "";
    };
    const restore = () => {
        if (collapsed || !saved || !(Number(saved.height) > 0) || main.clientHeight <= 0) return;
        setHeight(saved.height);
        saved = null;   // 只在首次布局量得到高度时回灌一次
    };
    apply();
    restore();
    requestAnimationFrame(restore);

    split.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || collapsed) return;
        e.preventDefault();
        const startY = e.clientY, startH = genPanel.offsetHeight;
        const move = (ev) => setHeight(startH + (startY - ev.clientY));
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            split.classList.remove("ns-split-drag");
            main.classList.remove("ns-split-drag");
            persist();
        };
        split.classList.add("ns-split-drag");
        main.classList.add("ns-split-drag");
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    });
    split.addEventListener("dblclick", () => { collapsed = !collapsed; apply(); persist(); });
    split.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            if (collapsed) return;
            e.preventDefault();
            setHeight(genPanel.offsetHeight + (e.key === "ArrowUp" ? 24 : -24));
            persist();
        } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            collapsed = !collapsed; apply(); persist();
        }
    });
    return split;
}

// ====== 导演页左栏已移除：配方面板与素材库改为弹窗（js/core/lib-modal.js） ======
async function buildDirector(el) {
    const page = $el("div", { className: "ns-director" });
    el.appendChild(page);
    // 顶部工具条：配方列表与素材库都在弹窗里打开，整幅宽度留给编辑器与生成面板
    recipesHost = $el("div", { className: "ns-director-recipes" });
    recipesModal = createLibraryModal({ storageKey: "neo_studio_libmodal_recipes", scope: "recipes" });
    recipesModal.setContent(recipesHost);
    document.body.appendChild(recipesModal.el);
    const recipesBtn = $el("button", { className: "ns-btn", type: "button", title: t("打开配方列表，点卡片选中并进编辑器") });
    setIconLabel(recipesBtn, "list", t("配方"));
    recipesBtn.onclick = () => { recipesModal.open(t("导演配方")); refreshRecipesPanel(); };
    const libBtn = $el("button", { className: "ns-btn", type: "button", title: t("打开素材库：点卡片取用并关窗，素材卡片直接拖进右侧编辑器") });
    setIconLabel(libBtn, "folder", t("素材库"));
    libBtn.onclick = () => openLibModal("director");
    page.appendChild($el("div", { className: "ns-director-bar" }, [recipesBtn, libBtn]));
    const main = $el("div", { className: "ns-director-main" });
    const editorHost = $el("div", { className: "ns-director-editor" }, [
        $el("div", { className: "ns-director-editor-hint", textContent: t("点「配方」弹窗选卡即在此编辑整片脚本") }),
    ]);
    page.appendChild(main);
    main.appendChild(editorHost);
    // 编辑器挂进宿主 / 关闭后收起占位提示
    new MutationObserver(() => editorHost.classList.toggle("ns-editor-open", !!editorHost.querySelector(".neo-director-panel")))
        .observe(editorHost, { childList: true });
    // 导演编辑器内嵌进本视图（含素材页「新建导演配方」入口 → 切到导演页）；
    // 编辑器底部的「保存并生成整片」保存成功后直接提交整片生成
    setDirectorEditorHost(editorHost, () => go("director"), () => submitGenerate());
    let currentRecipeName = null;   // 当前选中的导演配方（由配方弹窗点选回传，直接喂给整片生成区）

    const onSelect = (r) => {
        recipesModal?.close();       // 点卡片 = 选中并进编辑器，弹窗让位
        currentRecipeName = r.name;
        agentCtx.recipe = r.name;      // 智能体上下文：默认围绕这一份配方出片
        notifyAgentCtx();
        applyRecipe(r.name);   // 刷新分段格子 + 尺寸/步数回显
    };
    const panelOpts = () => ({ directorOnly: true, autoSelectFirst: true, initialSelection: currentRecipeName, openEditorOnSelect: true, onSelect });
    directorPanelOpts = panelOpts;
    onDirectorShown = () => { if (currentRecipeName) applyRecipe(currentRecipeName); };

    // --- 整片生成面板 ---
    // 生成参数（分辨率 / 步数 / 种子 / 连续性 / 上下文帧）全部在上方导演编辑器里保存进配方，
    // 本面板只做「跑哪几段 + 看结果」，不再重复一套控件。
    const runBtn = $el("button", { className: "rs-btn ns-gen-run", type: "button", textContent: t("生成整片") });
    gateRunButton(runBtn, "director", t("生成整片"));

    const cancelBtn = $el("button", { className: "rs-btn ns-gen-cancel", type: "button", textContent: t("取消"), style: { display: "none" } });
    const statusEl = $el("div", { className: "ns-gen-status" });
    const barEl = $el("div", { className: "ns-gen-progress" }, [$el("div")]);

    // --- 分段勾选条：一格一段，格内只有段号。点格子 = 勾选要跑的段（未勾选 = 整片），悬停看该段画面描述；
    // 运行中由 director_progress 高亮当前段。勾选是运行期临时状态：换配方即清空，不写进配方。
    let tlSegments = [];
    let tlProgress = { active: false, segment_index: -1, total_segments: 0 };
    let checkedSegments = [];
    const segsBox = $el("div", { className: "ns-gen-segs" });
    const segsAllBtn = $el("button", { className: "rs-btn ns-gen-segs-all", type: "button", textContent: t("全选") });
    const segsClearBtn = $el("button", { className: "rs-btn ns-gen-segs-clear", type: "button", textContent: t("清空") });
    const segsHint = $el("span", { className: "ns-gen-segs-hint" });
    const specEl = $el("span", { className: "ns-gen-spec" });   // 只读回显：本次整片的尺寸 / 步数（值来自配方，要改去编辑器）

    const renderSegs = () => {
        segsBox.textContent = "";
        tlSegments.forEach((s, i) => {
            const chip = $el("button", {
                className: "ns-gen-seg-chip", type: "button", title: s.prompt || "",
                "aria-pressed": checkedSegments.includes(i) ? "true" : "false",
                textContent: String(i + 1),
            });
            chip.onclick = () => setChecked(checkedSegments.includes(i)
                ? checkedSegments.filter((x) => x !== i)
                : [...checkedSegments, i].sort((a, b) => a - b));
            segsBox.appendChild(chip);
        });
        // 运行中高亮当前段：segment_index 是 0 基原始段序号，与勾选段号同源
        if (tlProgress.active && tlProgress.segment_index >= 0) {
            segsBox.children[tlProgress.segment_index]?.classList.add("ns-gen-seg-running");
        }
        const hasSegs = tlSegments.length > 0;
        segsAllBtn.style.display = segsClearBtn.style.display = hasSegs ? "" : "none";
    };
    const setChecked = (list) => {
        checkedSegments = list || [];
        segsHint.textContent = checkedSegments.length
            ? tf("仅运行勾选的 {n} 段：[{list}]", { n: checkedSegments.length, list: checkedSegments.map((i) => i + 1).join(",") })
            : t("未勾选 = 生成整片");
        segsHint.title = t("点分段格子勾选要跑的段；未勾选 = 生成整片");
        renderSegs();
    };
    segsAllBtn.onclick = () => setChecked(tlSegments.map((_, i) => i));
    segsClearBtn.onclick = () => setChecked([]);
    setChecked([]);

    // --- 实时预览：与节点内同款帧播放器；载荷按 task_id（后端 unique_id）过滤，尺寸由结果区随面板高度定 ---
    const mediaRight = $el("div", { className: "ns-gen-media-right" });
    const liveBox = $el("div", { className: "ns-gen-live neo-dtl-live" });
    const livePlayer = createFramePlayer(liveBox, () => {
        liveBox.style.height = "";                       // 高度交给 CSS：结果区随面板高度伸缩
        genBody.classList.remove("ns-gen-empty");   // 预览一有画面就占住右栏
    });
    mediaRight.appendChild(liveBox);

    // 选中配方：拉 director_spec 刷新分段格子，并把配方的尺寸 / 步数只读回显出来（参数本体在编辑器里改）
    const specCache = new Map();
    async function applyRecipe(name) {
        name = String(name || "").trim();
        if (!name) return;
        let spec = specCache.get(name);
        if (!spec) {
            // 启动时导演页是隐藏的，配方面板的自动选中也会走到这里。director_spec
            // 会把配方素材复制进 input/，在桌面端那一个事件循环上把首页 list 挤到几秒后，
            // 所以隐藏期间只记名字，进本页由 onDirectorShown 补拉。
            if (currentView !== "director") return;
            try {
                const r = await api.fetchApi(`/rs_recipes/director_spec?name=${encodeURIComponent(name)}`);
                const data = r.ok ? await r.json() : null;
                if (data?.success) spec = data;
            } catch { /* ComfyUI 未就绪时保持默认 */ }
            if (spec) specCache.set(name, spec);
        }
        tlSegments = spec?.segments || [];
        if (genState && !genState.terminal) tlProgress = { active: false, segment_index: -1, total_segments: 0 };   // 生成中切配方：进度高亮属于正在跑的那份配方，不许打到新配方的格子上
        agentCtx.segments = tlSegments.length;   // 智能体上下文要报得出这份配方有几段
        notifyAgentCtx();
        setChecked([]);   // 分段已换（切配方 / 配方内容变更）→ 勾选作废
        const d = spec?.defaults;
        specEl.textContent = d ? tf("{w}×{h} · {steps} 步", { w: d.width, h: d.height, steps: d.steps }) : "";
    }

    function stopPolling() {
        if (genState && genState.pollTimer) clearInterval(genState.pollTimer);
        api.removeEventListener("rs.director.status", onStatusEvent);
        if (genState?.previewListener) {
            api.removeEventListener("rs.h3.preview", genState.previewListener);
            genState.previewListener = null;
        }
    }

    function onStatusEvent({ detail }) {
        if (!detail || !detail.task_id) return;
        updateGenStatus(detail);
        // 终态即停轮询（WS 与下方轮询兜底两条路都覆盖，否则轮询拿到终态后会永远跑下去）
        if (GEN_TERMINAL.includes(detail.status)) stopPolling();
    }

    // 提交整片生成：「生成整片」按钮与编辑器底部「保存并生成整片」共用同一份参数组装。
    // 参数本体（分辨率/步数/种子/连续性/上下文帧）都在配方里，这里只发配方名 + 勾选的段。
    async function submitGenerate() {
        const recipe = currentRecipeName;
        if (!recipe) { statusEl.textContent = t("请先在下方选择一个配方"); return; }
        const body = {
            recipe,
            only_segments: checkedSegments.map((i) => i + 1).join(","),   // 勾选的段（空 = 整片）
        };

        stopPolling();
        runBtn.disabled = true;
        statusEl.textContent = t("提交中…");
        barEl.style.display = "none";
        mediaRight.querySelectorAll(".ns-gen-final").forEach(el => el.remove()); // 清掉上次的成片
        mediaRight.appendChild(liveBox);   // 恢复实时预览面板（成功后被成片替换掉了）
        livePlayer.reset();
        let resp;
        try {
            resp = await api.fetchApi("/neo_studio/director/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        } catch (e) {
            runBtn.disabled = false;
            statusEl.textContent = tf("提交失败：{msg}", { msg: e.message });
            return;
        }
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data?.success) {
            runBtn.disabled = false;
            statusEl.textContent = tf("提交失败：{msg}", { msg: data?.error || resp.status });
            return;
        }
        genState = {
            task_id: data.task_id, statusEl, barEl, fillEl: barEl.firstElementChild,
            runBtn, cancelBtn, mediaRight, pollTimer: null, previewListener: null,
            done: false, terminal: false, lastPreviewStep: 0,   // done：成片只替换一次；terminal：终态已落地，旧载荷一律作废；lastPreviewStep：预览帧按步号单调推进（WS / 轮询同源）
            livePlayer,   // 终态时定格在最后一帧
            onTerminal: () => { tlProgress = { active: false, segment_index: -1, total_segments: 0 }; renderSegs(); },
        };
        api.addEventListener("rs.director.status", onStatusEvent);
        // 预览帧只按步号向前推进：WS 为主、轮询 latest_preview 兜底，旧帧不得覆盖新帧
        const applyPreview = (p) => {
            if (!p || !Array.isArray(p.frames) || !p.frames.length) return;
            const st = Number(p.step);
            if (Number.isFinite(st) && st <= genState.lastPreviewStep) return;
            if (Number.isFinite(st)) genState.lastPreviewStep = st;
            livePlayer.apply(p);
        };
        // 实时预览载荷（后端广播，按 task_id 过滤到本次任务）
        const onPreviewEvent = ({ detail }) => {
            if (!detail || String(detail.node_id) !== data.task_id) return;
            applyPreview(detail);
        };
        api.addEventListener("rs.h3.preview", onPreviewEvent);
        genState.previewListener = onPreviewEvent;
        updateGenStatus(data);
        // WS 事件为主，轮询兜底（页面晚于任务打开 / 断线重连窗口）
        const poll = async () => {
            try {
                const r = await api.fetchApi(`/neo_studio/director/${data.task_id}`);
                const t = await r.json();
                // 终态由 WS 先到时，这次在途轮询的旧载荷不得把界面拉回生成中（进度条 / 取消按钮 / 段高亮会复活）
                if (!genState || genState.terminal) return;
                if (t?.success) {
                    updateGenStatus(t);
                    if (GEN_TERMINAL.includes(t.status)) stopPolling();
                    applyPreview(t.latest_preview);   // 轮询兜底：WS 断档期间没有帧，取后端最新一帧
                }
                // 分段进度：与画布节点同源，高亮分段勾选条上正在跑的段
                const p = await api.fetchApi("/neo_video_gen/director_progress");
                const d = await p.json();
                if (d && typeof d.active === "boolean") { tlProgress = d; renderSegs(); }
            } catch { /* 网络抖动忽略，下一轮再试 */ }
        };
        genState.pollTimer = setInterval(poll, 2000);
    }
    runBtn.addEventListener("click", () => submitGenerate());

    cancelBtn.addEventListener("click", async () => {
        if (!genState) return;
        cancelBtn.disabled = true;
        try {
            const r = await api.fetchApi(`/neo_studio/director/${genState.task_id}/cancel`, { method: "POST" });
            const data = await r.json().catch(() => null);
            if (!r.ok) statusEl.textContent = tf("取消失败：{msg}", { msg: data?.error || r.status });
        } catch (e) {
            statusEl.textContent = tf("取消失败：{msg}", { msg: e.message });
        }
        cancelBtn.disabled = false;
    });

    // 面板布局压成一行：全选 / 清空 / 分段格子 / 勾选提示 / 尺寸回显 + 生成 / 取消 同占一行，
    // 段数多时格子条自己横向滚，竖向空间整块留给结果区。
    const runGroup = $el("div", { className: "ns-gen-run-group" }, [cancelBtn, runBtn]);
    const ctrlRow = $el("div", { className: "ns-gen-row" }, [segsAllBtn, segsClearBtn, segsBox, segsHint, specEl, runGroup]);
    const emptyHint = $el("div", { className: "ns-gen-empty-hint", textContent: t("生成后在此显示实时预览") });
    const genLeft = $el("div", { className: "ns-gen-left" }, [ctrlRow, emptyHint]);
    // 右栏没有画面时整块收起，分段格子与预览占位共用整幅宽度
    const genBody = $el("div", { className: "ns-gen-body ns-gen-empty" }, [genLeft, mediaRight]);
    // 面板底部一行：状态文字 + 显存/内存读数（只有导演生成吃显存，监控跟着生成面板走）
    const foot = $el("div", { className: "ns-gen-foot" }, [statusEl]);
    const memBar = buildMemBar();
    if (memBar) foot.appendChild(memBar);
    const genPanel = $el("div", { className: "ns-gen-panel" }, [
        genBody,
        barEl, foot,
    ]);
    main.appendChild(buildDirectorSplit(main, genPanel));
    main.appendChild(genPanel);

    // --- 配方面板（左栏常驻：点卡片 = 选中喂给下方生成区 + 直接进右上编辑器；只列多段导演配方） ---
    recipesPanelEl = await createRecipesPanel(panelOpts());
    recipesHost.appendChild(recipesPanelEl);
    // 编辑器保存后：刷新配方列表、清 spec 缓存、同步默认值与时间轴分段（新建配方直接选中，其余保持当前选中）
    window.addEventListener(DIRECTOR_RECIPE_SAVED_EVENT, async (e) => {
        specCache.clear();
        if (e?.detail?.created) currentRecipeName = e.detail.name;
        agentCtx.recipe = currentRecipeName || "";   // 保存会换配方名，智能体上下文跟着走
        notifyAgentCtx();
        await refreshRecipesPanel();
        // 刷新只恢复卡片高亮（不重放 onSelect），分段格子与尺寸/步数回显在这里跟着新配方重取
        if (currentRecipeName) applyRecipe(currentRecipeName);
    });
}




// ====== 绘画页：满幅 = 文生图 / 图片编辑面板（模式切换，一次铺满整栏）；素材库走弹窗取用 ======
const PAINT_MODE_KEY = "neo_studio_paint_mode";
let paintModeCtl = null;    // buildPaint 建页时交出的模式切换入口：首页卡片直达文生图 / 图片编辑

function buildPaint(el) {
    const page = $el("div", { className: "ns-paint" });
    el.appendChild(page);
    const main = $el("div", { className: "ns-paint-main" });
    page.appendChild(main);

    // 模式切换：文生图与图片编辑各占满整栏，一次只看一个（不像导演页那样编辑 + 生成同屏抢高度）
    const modeBtns = {
        text: $el("button", { className: "ns-paint-mode-btn", type: "button", textContent: t("文生图"), onclick: () => setMode("text") }),
        edit: $el("button", { className: "ns-paint-mode-btn", type: "button", textContent: t("图片编辑"), onclick: () => setMode("edit") }),
    };
    const textHost = $el("div", { className: "ns-paint-panel ns-paint-text" });
    const editHost = $el("div", { className: "ns-paint-panel ns-paint-edit" });
    // 素材库按钮在模式行右端：弹窗点卡片 = 图片编辑取用该图，拖进预览区 = 投放当原图
    const paintLibBtn = $el("button", { className: "ns-btn ns-paint-lib-btn", type: "button", title: t("打开素材库：点卡片取用进图片编辑，拖进预览区投放") });
    setIconLabel(paintLibBtn, "folder", t("素材库"));
    paintLibBtn.onclick = () => openLibModal("paint", paintPickImage);
    main.appendChild($el("div", { className: "ns-paint-modes" }, [modeBtns.text, modeBtns.edit, paintLibBtn]));
    main.appendChild(textHost);
    main.appendChild(editHost);
    const memBar = buildMemBar();   // 显存 / 内存读数 + 清理：绘画页同样是生成页
    if (memBar) main.appendChild(memBar);

    let mode = "text";
    const setMode = (m) => {
        mode = m;
        modeBtns.text.classList.toggle("ns-paint-mode-on", mode === "text");
        modeBtns.edit.classList.toggle("ns-paint-mode-on", mode === "edit");
        textHost.classList.toggle("ns-hidden", mode !== "text");
        editHost.classList.toggle("ns-hidden", mode !== "edit");
        agentCtx.paint_mode = mode;   // 智能体上下文：知道绘画页现在是文生图还是图片编辑
        notifyAgentCtx();
        try { localStorage.setItem(PAINT_MODE_KEY, mode); } catch { /* 偏好写不进不影响用 */ }
    };
    paintModeCtl = setMode;
    try { setMode(localStorage.getItem(PAINT_MODE_KEY) === "edit" ? "edit" : "text"); } catch { setMode("text"); }

    // 绘画面板内嵌进本视图（同导演编辑器 setDirectorEditorHost 语义）：两块面板进页就铺好，
    // 左栏素材库的「生成素材」与图片卡菜单「图片编辑」只做模式切换（面板复用，不重建）；
    // 素材页的同类入口由 onOpen 先跳到本页再铺面板。ComfyUI 插件模式没有宿主，照旧弹浮层窗。
    let ready = false;
    setPaintHost({
        text: textHost,
        edit: editHost,
        // 已在绘画页时 go() 是同页空转，showView 里「离开该页收起弹窗」那段不触发：
        // 交还给本页面板后弹窗会盖在面板上，所以入口自己收
        onOpen: (kind) => { if (!ready) return; go("paint"); setMode(kind); libModal?.close(); },
    });
    // 文生图直接写提示词就能生成；图片编辑铺空面板，从左栏把素材拖进预览区当原图即可
    openGenMaterialDialog(app.neoGallery, { container: textHost });
    openImageEditDialog(app.neoGallery, null, "", { container: editHost });
    ready = true;
}

// ====== 首页：意图卡片 —— 大字标题 + 创造五卡 + 素材三卡，点卡直达对应页 ======
function openPaintMode(mode) {
    paintModeCtl?.(mode);   // 绘画页常驻：先把面板切到卡片承诺的模式，再跳页
    go("paint");
}

function homeCard(iconName, title, sub, onClick) {
    return $el("button", { className: "ns-home-card", type: "button", onclick: onClick }, [
        $el("span", { className: "ns-home-card-icon" }, [icon(iconName, 22)]),
        $el("span", { className: "ns-home-card-text" }, [
            $el("span", { className: "ns-home-card-title", textContent: t(title) }),
            $el("span", { className: "ns-home-card-sub", textContent: t(sub) }),
        ]),
        icon("chevron", 16),
    ]);
}

function buildHome(el) {
    el.classList.add("ns-home");
    el.append(
        $el("div", { className: "ns-home-hero" }, [
            $el("h1", {}, [t("今天想"), $el("span", { className: "ns-home-accent", textContent: t("创作") }), t("什么？")]),
            $el("p", { textContent: t("一句话到一段成片，全部在你自己的电脑上完成") }),
            $el("button", { className: "ns-home-cta", type: "button", textContent: t("一句话出图"), onclick: () => openPaintMode("text") }),
        ]),
        $el("h2", { className: "ns-home-section", textContent: t("开始创作") }),
        $el("div", { className: "ns-home-grid" }, [
            homeCard("sparkles", "生成图片", "描述画面，直接出图", () => openPaintMode("text")),
            homeCard("film", "生成视频", "一句话加首帧，出一段视频", () => go("video")),
            homeCard("pencil", "图片编辑", "拖入素材，写下要改成什么样", () => openPaintMode("edit")),
            homeCard("play", "导演视频", "多段配方，生成整片视频", () => go("director")),
            homeCard("target", "智能体", "说出目标，工具链多轮跑完", () => go("agent")),
        ]),
        $el("h2", { className: "ns-home-section", textContent: t("素材与配置") }),
        $el("div", { className: "ns-home-grid" }, [
            homeCard("folder", "素材库", "浏览与管理全部生成素材", () => go("gallery")),
            homeCard("wand", "技能", "管理预设与技能包", () => go("skills")),
            homeCard("gear", "设置", "生成默认值与界面语言", () => go("settings")),
        ]),
    );
}

// ====== 视频页：一句话 + 首帧（可选尾帧 / 参考图）直接出一段视频 ======
// 独立于导演多段流程：不建配方、不读配方，参数在本页 composer 里现填，提交后端简单视频接口。
// 版面照 ArtCraft 的 Create Video：整页是舞台，空着时正中盖一句起手提示（版式同绘画页 idle），
// 底部浮一张胶囊 composer（素材方块 + 提示词 + 芯片行 + 生成钮）；出片后提示淡出，成片卡片进舞台滚动。
const VIDEO_SIZE_CHOICES = [
    [624, 352, "352p 横屏"], [768, 432, "432p 横屏"], [1024, 576, "576p 横屏"],
    [1280, 720, "720p 横屏"], [1344, 768, "768p 横屏"], [1920, 1080, "1080p 横屏"],
];
const VIDEO_DUR_CHOICES = [3, 5, 8, 10, 15];
const VIDEO_MAX_REF = 9;   // 参考图上限（与 H3 参考节点 image 槽一致）
const VIDEO_TERMINAL = ["succeeded", "failed", "cancelled"];
// 技能分组 = 导演页那套生成模式：组头名与组序直接取 director 的 SEG_MODES，两处模式词永远一致。
// 技能的 mode 经 LEGACY_MODE_MAP 归并（t2v / i2v / fl2v → 关键帧生视频，r2v 留全参考生视频），
// 没标 mode 的旧视频技能落关键帧生视频——首帧留空就是文生视频，本来就是这一家族里的一发
const VIDEO_GROUP_LABELS = Object.fromEntries(SEG_MODES.map(([key]) => [key, MODE_LABELS.get(key)]));
const VIDEO_LAST_SKILL_KEY = "neo.video.skill";
const videoModeGroup = (meta) => LEGACY_MODE_MAP.get(meta?.mode) || meta?.mode || "f2v";
const videoSkillSteps = (s) => Number((s.gen_config || {}).steps) || 20;

// 默认技能 = 关键帧生视频家族里步数最少的可用技能（后端 _default_video_skill 同口径，先进页就能直接出片）
function defaultVideoSkill(list) {
    const usable = list.filter((s) => s.available !== false);
    const pool = usable.filter((s) => videoModeGroup(s) === "f2v");
    const by = pool.length ? pool : usable;
    if (!by.length) return "";
    return by.reduce((a, b) => (videoSkillSteps(b) < videoSkillSteps(a) ? b : a)).id;
}

// 素材库弹窗点卡片 → copy_to_input 落进 input 根目录，返回加载节点可用的文件名
async function copyPickedToInput(img) {
    const query = "filename=" + encodeURIComponent(img.filename || "")
        + (img.subfolder ? "&subfolder=" + encodeURIComponent(img.subfolder) : "");
    const resp = await api.fetchApi("/neo_gallery/copy_to_input?" + query);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.success) throw new Error(data?.error || t("无法读取该图片"));
    return data.filename;
}

function buildVideo(el) {
    el.classList.add("ns-video");
    const page = $el("div", { className: "ns-video-page" });
    el.appendChild(page);

    const stage = $el("div", { className: "ns-video-stage" });
    const hero = $el("section", { className: "ns-video-hero" }, [
        // 文案样式直接借绘画页的页内 idle（.neo-gallery-gm-idle 那三级类），两页起手提示长一个样
        $el("div", { className: "ns-video-hero-card neo-gallery-gm-idle" }, [
            $el("div", { className: "neo-gallery-gm-idle-title", textContent: t("创建视频") }),
            $el("div", { className: "neo-gallery-gm-idle-sub", textContent: t("选一张图，写一句话，然后生成") }),
            $el("i", { className: "ns-video-corner c-tl" }),
            $el("i", { className: "ns-video-corner c-tr" }),
            $el("i", { className: "ns-video-corner c-bl" }),
            $el("i", { className: "ns-video-corner c-br" }),
        ]),
    ]);

    // 素材方块工厂：方块壳直接借会话页的参考位 .neo-gallery-edit-refdrop（虚线方块 + 底部角标 +
    // 填满转实心），点它开素材库弹窗；填上后铺缩略图 + ✕。multiple=true 收多张（参考图），单槽一张。
    function mediaSlot(label, multiple, maxN) {
        const items = [];   // {value}：input 目录里的相对文件名
        const thumbs = $el("div", { className: "ns-video-thumbs" + (multiple ? " ns-video-thumbs-multi" : "") });
        const add = $el("button", { className: "ns-video-slot-add", type: "button" });
        setIcon(add, "plus", 18);
        const cap = $el("span", { className: "neo-gallery-edit-refdrop-cap" });
        const slot = $el("div", { className: "ns-video-slot neo-gallery-edit-refdrop" }, [thumbs, add, cap]);
        const render = () => {
            thumbs.textContent = "";
            for (const it of items.slice()) {
                const wrap = $el("span", { className: "ns-video-thumb" }, [
                    $el("img", {
                        alt: it.value,
                        src: `/view?filename=${encodeURIComponent(it.value)}&subfolder=&type=input`,
                    }),
                ]);
                const del = $el("button", { className: "neo-gallery-edit-refchip-x", type: "button", title: t("移除"), textContent: "✕" });
                del.onclick = () => { items.splice(items.indexOf(it), 1); render(); };
                wrap.appendChild(del);
                thumbs.appendChild(wrap);
            }
            add.style.display = (multiple && items.length >= maxN) ? "none" : "";
            cap.textContent = items.length && !multiple ? t("换图") : t(label);
            slot.classList.toggle("has-img", items.length > 0);
        };
        add.onclick = () => openLibModal("video", async (picked) => {
            for (const p of picked) {
                if (multiple && items.length >= maxN) break;
                try {
                    const value = await copyPickedToInput(p);
                    if (multiple) items.push({ value });
                    else { items.length = 0; items.push({ value }); }
                } catch (e) { toast(tf("取用素材失败：{msg}", { msg: e.message })); }
            }
            render();
            if (!multiple) libModal?.close();   // 首帧 / 尾帧取一张即收窗；参考图留着弹窗好连选
        });
        render();
        return { el: slot, get: () => items.map((it) => ({ value: it.value })), first: () => items[0] || null };
    }

    const firstSlot = mediaSlot("首帧", false, 1);
    const lastSlot = mediaSlot("尾帧", false, 1);
    const refSlot = mediaSlot("参考图", true, VIDEO_MAX_REF);

    const promptIn = $el("textarea", {
        className: "ns-video-prompt neo-gallery-gm-quick-input", rows: "2", spellcheck: "false",
        placeholder: t("描述这段视频要拍成什么样…"),
    });
    const promptCount = $el("span", { className: "ns-video-count", textContent: "0 / ∞" });
    promptIn.addEventListener("input", () => { promptCount.textContent = `${promptIn.value.length} / ∞`; });

    const skillSel = $el("select", { className: "ns-video-skill", title: t("技能与自定参数：主模型 / LoRA 留空 = 跟随该技能配置与全局生视频设置") });
    skillSel.appendChild($el("option", { value: "", textContent: t("（加载视频技能…）") }));
    // 自定参数（本次临时换主模型 / 编码器 / VAE / 步数 / LoRA，空值 = 跟随该技能配置与全局生视频设置）：
    // 与技能同一枚 chip，点开从上方浮出双栏面板——左栏技能按生成模式分组，右栏生视频模型 / 步数 / LoRA
    const videoCfg = createVideoModelConfigSection();
    const videoParamsBox = $el("div", { className: "neo-gallery-gm-model-box" });
    videoParamsBox.appendChild(videoCfg.el);
    const skillChip = skillParamsChip(skillSel, videoParamsBox, {
        icon: "film",
        groupOf: videoModeGroup,
        groupLabels: VIDEO_GROUP_LABELS,
        getOverride: () => videoCfg.collect(),
    });
    videoParamsBox.addEventListener("change", () => skillChip.sync());

    const selectedMeta = () => skillSel.options[skillSel.selectedIndex]?.__skillMeta || null;
    const selectedGroup = () => videoModeGroup(selectedMeta());
    let videoModels = null;   // 自定参数面板的模型列表：没拉到就整块不发覆盖值，技能配置照常生效

    // 素材槽位随技能家族显隐：关键帧生视频给首帧 / 尾帧，全参考生视频给参考图。
    // 隐藏的槽位不进 payload——留着上一家族的首帧去跑 r2v，后端按资产推模式就会推错
    const applyVideoSlots = () => {
        const f2v = selectedGroup() === "f2v";
        firstSlot.el.classList.toggle("ns-hidden", !f2v);
        lastSlot.el.classList.toggle("ns-hidden", !f2v);
        refSlot.el.classList.toggle("ns-hidden", f2v);
    };

    // 换技能 = 把自定参数整块换成该技能 config 里钉的那一套（与绘画页同一语义）
    const applySkillConfig = async (skillId) => {
        if (!skillId || !videoModels) return;
        const cfg = await getSkillGenConfig(skillId);
        videoCfg.load(cfg || {}, videoModels);
        skillChip.sync();   // 程序改 value 不触发 change：chip 标签自己跟上
    };

    skillSel.addEventListener("change", () => {
        applyVideoSlots();
        applySkillConfig(skillSel.value);
        try { localStorage.setItem(VIDEO_LAST_SKILL_KEY, skillSel.value); } catch { /* 隐私模式下记不住就算了，不挡生成 */ }
    });
    applyVideoSlots();

    listVideoSkills().then((list) => {
        skillSel.textContent = "";
        for (const s of list) {
            const opt = $el("option", { value: s.id, textContent: skillDisplayName(s) });
            opt.__skillMeta = s;   // 分组与主模型副标题取这份元数据（会话页技能面板同一约定）
            skillSel.appendChild(opt);
        }
        if (!list.length) skillSel.appendChild($el("option", { value: "", textContent: t("（无可用视频技能）") }));
        let last = "";
        try { last = localStorage.getItem(VIDEO_LAST_SKILL_KEY) || ""; } catch { last = ""; }
        skillSel.value = list.some((s) => s.id === last) ? last : defaultVideoSkill(list);
        skillChip.sync();   // 技能是异步填进 select 的，chip 显示的生效值得跟着重读
        applyVideoSlots();
        applySkillConfig(skillSel.value);
    }).catch(() => {
        skillSel.textContent = "";
        skillSel.appendChild($el("option", { value: "", textContent: t("（无可用视频技能）") }));
        skillChip.sync();
    });

    // 模型列表拉一次：先按「自动」渲染覆盖区，再覆盖成当前技能配置；拉不到保持空下拉（等效跟随设置，不挡生成）
    listVideoGenModels().then((models) => {
        videoModels = models || {};
        videoCfg.load({}, videoModels);
        applySkillConfig(skillSel.value);
    }).catch(() => {});

    const sizeSel = $el("select", { className: "ns-video-size" });
    for (const [w, h, label] of VIDEO_SIZE_CHOICES)
        sizeSel.appendChild($el("option", { value: `${w},${h}`, textContent: tf("{w}×{h} · {label}", { w, h, label: t(label) }) }));
    sizeSel.value = "1344,768";

    const durSel = $el("select", { className: "ns-video-dur" });
    for (const sec of VIDEO_DUR_CHOICES)
        durSel.appendChild($el("option", { value: String(sec), textContent: tf("{n} 秒", { n: sec }) }));
    durSel.value = "5";

    const seedIn = $el("input", { className: "ns-video-seed neo-gallery-gm-chip-btn", type: "number", min: "-1", placeholder: t("随机") });
    const seedRoll = $el("button", { className: "ns-video-seed-roll", type: "button", title: t("换一个随机种子") });
    setIcon(seedRoll, "sparkles", 13);
    seedRoll.onclick = () => { seedIn.value = String(Math.floor(Math.random() * 1e15)); };

    // 芯片行就是会话页那枚工厂的产物：胶囊 chip + 从上方浮出的选项菜单，原生 select 收在壳里当状态容器
    const sizeChip = chipButton(sizeSel, { icon: "ratio" });
    const durChip = chipButton(durSel, { icon: "clock" });
    const chips = [skillChip, sizeChip, durChip];
    for (const c of chips) c.el.classList.add("ns-video-chip");
    const seedChip = $el("label", { className: "ns-video-chip neo-gallery-gm-chip-group", title: t("种子") }, [icon("sparkles", 12), seedIn, seedRoll]);
    // 菜单开着的 chip 要点外面才收；换页会重建这一页，页面离场时把监听摘掉，别一次次堆在 document 上
    const onDocClick = (e) => {
        if (!document.body.contains(page)) { document.removeEventListener("click", onDocClick); return; }
        for (const c of chips) c.closeOnOutside(e.target);
    };
    document.addEventListener("click", onDocClick);

    const runBtn = $el("button", { className: "ns-video-run neo-gallery-story-btn neo-gallery-story-btn-primary neo-gallery-gm-gen-btn", type: "button", textContent: t("生成") });
    gateRunButton(runBtn, "simple_video", t("生成视频"));
    const cancelBtn = $el("button", { className: "ns-video-cancel neo-gallery-story-btn", type: "button", textContent: t("取消"), style: { display: "none" } });

    const statusEl = $el("div", { className: "ns-video-status" });
    const barEl = $el("div", { className: "ns-gen-progress ns-video-progress" }, [$el("div")]);

    const dock = $el("div", { className: "ns-video-dock" }, [
        $el("div", { className: "ns-video-card neo-gallery-gm-composer" }, [
            $el("div", { className: "ns-video-head" }, [statusEl, barEl]),
            $el("div", { className: "ns-video-top" }, [
                $el("div", { className: "ns-video-deck" }, [firstSlot.el, lastSlot.el, refSlot.el]),
                $el("div", { className: "ns-video-input" }, [promptIn, promptCount]),
            ]),
            $el("div", { className: "ns-video-chips neo-gallery-gm-composer-bar neo-gallery-gm-chips" }, [
                skillChip.el,
                sizeChip.el,
                durChip.el,
                seedChip,
                $el("div", { className: "neo-gallery-gm-composer-gap" }),
                cancelBtn,
                runBtn,
            ]),
        ]),
    ]);
    page.appendChild(stage);
    page.appendChild(hero);
    page.appendChild(dock);
    const memBar = buildMemBar();   // 视频页同样是生成页：显存 / 内存读数，浮在舞台右上角
    if (memBar) page.appendChild(memBar);


    // --- 生成 + 轮询 + 取消（无画布、无采样实时预览：只有排队 / 进度条 / 成片） ---
    let state = null;   // {task_id, pollTimer, terminal, done}
    const stopPolling = () => { if (state?.pollTimer) clearInterval(state.pollTimer); };

    // 成片进舞台：新卡插到最前，hero 标题淡出（淡出后 pointer-events 本就关着，卡片照常可点）
    const addClip = (task) => {
        const url = `/view?filename=${encodeURIComponent(task.filename)}&subfolder=${encodeURIComponent(task.subfolder || "")}&type=output`;
        stage.prepend($el("div", { className: "ns-video-clip" }, [
            $el("video", { className: "ns-video-player", controls: true, autoplay: true, src: url }),
            $el("div", { className: "ns-video-clip-meta" }, [
                $el("span", { className: "ns-video-clip-name", textContent: task.filename }),
                $el("a", { className: "ns-video-open", href: url, target: "_blank", rel: "noreferrer", textContent: t("在浏览器中打开") }),
            ]),
        ]));
        hero.classList.add("ns-video-hero-off");
    };

    const renderTask = (task) => {
        if (!state || task.task_id !== state.task_id) return;
        if (state.terminal && !VIDEO_TERMINAL.includes(task.status)) return;   // 终态后在途旧载荷不得复活进度条 / 取消
        if (VIDEO_TERMINAL.includes(task.status)) {
            state.terminal = true;
            cancelBtn.style.display = "none";
        }
        barEl.style.display = task.status === "running" ? "block" : "none";
        if (task.status === "queued") {
            statusEl.textContent = t("排队中…");
        } else if (task.status === "running") {
            const p = task.progress;
            statusEl.textContent = p ? tf("生成中… {value}/{max}", { value: p.value, max: p.max }) : t("生成中…");
            if (p) barEl.firstElementChild.style.width = `${Math.round(100 * p.value / p.max)}%`;
        } else if (task.status === "succeeded" && !state.done) {
            state.done = true;   // 终态可能在途轮询重复到达：成片卡片只挂一次
            statusEl.textContent = tf("已完成：{filename}", { filename: task.filename });
            addClip(task);
        } else if (task.status === "failed") {
            statusEl.textContent = tf("失败：{error}", { error: task.error || t("未知错误") });
        } else if (task.status === "cancelled") {
            statusEl.textContent = t("已取消");
        }
        runBtn.disabled = task.status === "queued" || task.status === "running";
        cancelBtn.style.display = (task.status === "queued" || task.status === "running") ? "" : "none";
    };

    const startPolling = (task) => {
        state = { task_id: task.task_id, pollTimer: null, terminal: false, done: false };
        renderTask(task);
        const poll = async () => {
            try {
                const r = await api.fetchApi(`/neo_video_gen/simple/${task.task_id}`);
                const d = await r.json();
                if (!state || state.terminal) return;
                if (d?.success) { renderTask(d); if (VIDEO_TERMINAL.includes(d.status)) stopPolling(); }
            } catch { /* 网络抖动忽略，下一轮再试 */ }
        };
        state.pollTimer = setInterval(poll, 2000);
    };

    async function submitVideo() {
        const meta = selectedMeta();
        // 只发当前家族用得上的槽位：切过家族留下的旧素材混进这一发，就是让它替模式说话
        const f2v = selectedGroup() === "f2v";
        const first = f2v ? firstSlot.first() : null;
        const last = f2v ? lastSlot.first() : null;
        const refs = f2v ? [] : refSlot.get();
        if (meta?.requires_ref && !first && !last && !refs.length) {
            // 后端对这批技能是硬要求（无帧的 fl2v / 无参考的 r2v 必败），在这里说清楚比跑完再报错省一整发
            statusEl.textContent = f2v
                ? t("该技能需要参考素材：首帧 / 尾帧至少选一张")
                : t("该技能需要参考素材：至少选一张参考图");
            return;
        }
        const [w, h] = (sizeSel.value || "1344,768").split(",").map(Number);
        const body = {
            prompt: promptIn.value.trim(),
            skill_id: skillSel.value,
            references: first ? [first, ...refs] : refs,
            last_frame: last || null,
            width: w, height: h,
            duration_sec: Number(durSel.value),
            seed: seedIn.value === "" ? -1 : Number(seedIn.value),
        };
        // 自定参数只带非空项：空 = 这一发跟着技能配置与全局生视频设置走（与生图覆盖同一口径）
        if (videoModels) {
            const ov = videoCfg.collect();
            if (ov.model) body.model = ov.model;
            if (ov.text_encoder) body.text_encoder = ov.text_encoder;
            if (ov.vae) body.vae = ov.vae;
            if (ov.audio_vae) body.audio_vae = ov.audio_vae;
            if (ov.steps) body.steps = ov.steps;
            if (ov.loras.length) body.loras = ov.loras;
        }
        runBtn.disabled = true;
        try {
            const r = await api.fetchApi("/neo_video_gen/simple", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            const data = await r.json().catch(() => null);
            if (!r.ok || !data?.success) {
                statusEl.textContent = tf("生成失败：{msg}", { msg: data?.error || r.status });
                runBtn.disabled = false;
                return;
            }
            startPolling(data);
        } catch (e) {
            statusEl.textContent = tf("生成失败：{msg}", { msg: e.message });
            runBtn.disabled = false;
        }
    }

    runBtn.addEventListener("click", () => submitVideo());
    cancelBtn.addEventListener("click", async () => {
        if (!state) return;
        cancelBtn.disabled = true;
        try {
            const r = await api.fetchApi(`/neo_video_gen/simple/${state.task_id}/cancel`, { method: "POST" });
            const data = await r.json().catch(() => null);
            if (!r.ok) statusEl.textContent = tf("取消失败：{msg}", { msg: data?.error || r.status });
        } catch (e) {
            statusEl.textContent = tf("取消失败：{msg}", { msg: e.message });
        }
        cancelBtn.disabled = false;
    });
}


// ====== 技能页：统一技能管理（与顶栏「技能管理」同组件）直接挂满主区，无弹窗外桌面端 ======
function buildSkills(el) {
    el.classList.add("ns-skills");
    // Studio 无画布：不显示 ✕ 与「从画布」导出按钮
    createSkillManager(el, { showClose: false, showCanvasBtn: false });
}

// ====== 启动设置：便携 exe 的 ComfyUI 根目录 / 解释器 / 端口 ======
// 这份数据归桌面端：桌面端窗口里走 js_api，页面在桌面端端口还是 ComfyUI 端口都读得到（就绪后整页跳到 ComfyUI，
// 同源就没有 /neo_studio/launcher 了）；浏览器标签页没有桥，只剩桌面端服务那条路由，读不到就收起 tab。
function createLauncherPanel() {
    const input = (ph) => $el("input", { className: "ns-launch-input", placeholder: ph, spellcheck: "false" });
    const rootIn = input(t("ComfyUI 根目录"));
    const pyIn = input(t("python.exe 路径"));
    const portIn = input("8188");
    const remoteIn = input("http://192.168.0.20:8188");
    remoteIn.classList.add("ns-launch-remote");
    const listenSel = $el("select", { className: "ns-launch-input ns-launch-listen" });
    const status = $el("div", { className: "ns-launch-status" });
    const info = $el("div", { className: "ns-launch-info" });
    const lanHint = $el("div", { className: "ns-launch-info" });
    const browseBtn = $el("button", { className: "ns-btn", textContent: t("浏览…") });
    const pyBrowseBtn = $el("button", { className: "ns-btn", textContent: t("浏览…") });
    const applyBtn = $el("button", { className: "ns-btn ns-launch-apply", textContent: t("保存并重启 ComfyUI") });
    const depsBtn = $el("button", { className: "ns-btn", textContent: t("安装依赖") });
    const fixBtn = $el("button", { className: "ns-btn", textContent: t("重试安装插件") });
    const framelessIn = $el("input", { type: "checkbox", className: "ns-launch-frameless" });
    const devIn = $el("input", { type: "checkbox", className: "ns-launch-dev" });
    const kernelState = $el("div", { className: "ns-kernel-state" });
    const startBtn = $el("button", { className: "ns-btn ns-kernel-start", textContent: t("▶ 启动内核") });
    const stopBtn = $el("button", { className: "ns-btn ns-kernel-stop", textContent: t("■ 停止内核") });
    // 标签旁的 ⓘ：悬停给出前提条件与生效方式 —— 面板里这几项的规矩各不相同（保存并重启 / 重启窗口 / 归远端管）
    const TIPS = {
        root: "ComfyUI 安装目录，要有 main.py。\n"
            + "改完点「保存并重启 ComfyUI」：桌面端停掉旧进程，按新配置重新拉起。",
        python: "跑 ComfyUI 的 python.exe，要已装好 ComfyUI 的依赖（缺依赖时下方出「安装依赖」按钮）。\n"
            + "改完点「保存并重启 ComfyUI」。",
        port: "本机 ComfyUI 的端口，窗口与探活都打在 127.0.0.1:该端口。\n"
            + "端口被占用时桌面端自动换到下一个空闲端口。改完点「保存并重启 ComfyUI」。",
        listen: "ComfyUI 的 --listen，默认「仅本机」= 只监听 127.0.0.1，局域网访问不到。\n"
            + "填网卡地址时会自动带上 127.0.0.1，否则窗口自己打不开。\n"
            + "ComfyUI 没有鉴权：防火墙放行该端口，只在你信任的网段开。改完点「保存并重启 ComfyUI」。",
        remote: "连远端那台 ComfyUI：http(s)://主机[:端口]，留空 = 连本机。\n"
            + "前提：远端已装 comfyui-neo-studio 插件，并在远端自己的「启动设置 → 局域网监听」放开监听。\n"
            + "远程模式本机不启动也不停止 ComfyUI：「启动内核」= 重连远端，「停止内核」禁用，"
            + "根目录 / 解释器 / 端口 / 局域网监听归远端管。\n"
            + "改完点「保存并重启 ComfyUI」，窗口直接开在远端页面。",
        frameless: "桌面端窗口自绘标题栏（最小化 / 最大化 / 全屏 / 关闭），勾掉回系统标题栏。\n"
            + "立刻生效并写进启动配置，下次开机沿用。",
        dev: "打开刷新键 / 右键菜单 / 开发者工具，排查窗口白屏与前端问题用。\n"
            + "pywebview 在建窗口时定值：勾完要重启桌面端窗口才生效。",
    };
    const infoDot = (tip) => $el("span", { className: "ns-info", textContent: "i", tabindex: "0", "data-tip": tip });
    const row = (label, tip, ...kids) => $el("div", { className: "ns-launch-row" },
        [$el("span", { className: "ns-launch-label" }, [label, infoDot(tip)]), ...kids]);
    const rootRow = row(t("ComfyUI 根目录"), t(TIPS.root), rootIn, browseBtn);
    const pyRow = row("Python", t(TIPS.python), pyIn, pyBrowseBtn);
    const portRow = row(t("端口"), t(TIPS.port), portIn);
    const listenRow = row(t("局域网监听"), t(TIPS.listen), listenSel);
    const remoteRow = row(t("远程 ComfyUI"), t(TIPS.remote), remoteIn);
    // 远程模式下这几项归远端那台机器管：灰掉，别让本机设置看起来能影响远端
    const localRows = [rootRow, pyRow, portRow, listenRow];
    const localInputs = [rootIn, pyIn, portIn, listenSel, browseBtn, pyBrowseBtn];

    const STATE_TEXT = {
        ok: "就绪",
        bad_root: "根目录无效",
        missing_python: "找不到 Python",
        deps_missing: "缺少插件依赖",
        install_failed: "插件安装失败",
    };

    // 局域网监听做成下拉：手输 IP 容易错，可选项就是「仅本机 / 全部网卡 / 本机各网卡」
    const LAN_CHOICES = [["", "仅本机（默认）"], ["0.0.0.0", "全部网卡（0.0.0.0）"]];
    let lanIps = [];

    // 桌面端存的是规范化值（127.0.0.1,192.168.0.165）：去掉补出来的回环才是下拉项
    const lanKey = (listen) => (listen || "").split(",")
        .map((x) => x.trim()).filter((x) => x && x !== "127.0.0.1").join(",");

    function renderLanHint() {
        const remote = remoteIn.value.trim();
        if (remote) {
            lanHint.textContent = tf("远程 ComfyUI：{remote}/neo-studio · 远端要已开监听并装好 Neo Studio 插件，起停与端口都在远端那台机器上设", { remote });
            return;
        }
        const v = listenSel.value;
        const port = portIn.value || "8188";
        if (!v) {
            lanHint.textContent = tf("仅本机访问：http://127.0.0.1:{port}/neo-studio", { port });
            return;
        }
        const urls = v === "0.0.0.0"
            ? lanIps.map((ip) => `http://${ip}:${port}/neo-studio`)
            : [`http://${v}:${port}/neo-studio`];
        lanHint.textContent = t("局域网可访问（ComfyUI 没有鉴权，只在你信任的网段开）：")
            + (urls.join("  ·  ") || tf("http://<本机 IP>:{port}/neo-studio", { port }));
    }

    // 远程模式灰掉本机启动项：远端的根目录 / 解释器 / 端口 / 监听由远端自己配
    function renderLocalMode(remote) {
        for (const el of localInputs) el.disabled = remote;
        for (const r of localRows) r.classList.toggle("ns-launch-remote-off", remote);
    }

    function render(s) {
        rootIn.value = s.root || "";
        pyIn.value = s.python || "";
        portIn.value = s.port || "";
        remoteIn.value = s.remote || "";
        renderLocalMode(!!s.remote);
        lanIps = s.lan_ips || [];
        const opts = LAN_CHOICES.concat(lanIps.map((ip) => [ip, tf("本机网卡 {ip}", { ip })]));
        const key = lanKey(s.listen);
        if (!opts.some(([v]) => v === key)) opts.push([key, tf("已保存：{key}", { key })]);
        listenSel.replaceChildren(...opts.map(([v, label]) => $el("option", { value: v, textContent: t(label) })));
        listenSel.value = key;
        renderLanHint();
        status.textContent = t(STATE_TEXT[s.state] || s.state || "") + (s.error ? ` · ${s.error}` : "");
        status.classList.toggle("ns-launch-bad", !!s.state && s.state !== "ok");
        info.textContent = tf("插件 {plugin} · 状态 {state} · {mode}", {
            plugin: s.plugin_dir, state: s.state_dir, mode: t(s.portable ? "便携模式" : "插件内运行"),
        });
        depsBtn.style.display = s.state === "deps_missing" ? "" : "none";
        fixBtn.style.display = s.state === "install_failed" ? "" : "none";
        framelessIn.checked = !!s.frameless;
        devIn.checked = !!s.dev_mode;
    }

    // 动作 → 桌面端 js_api 上的方法名：桥在就直接问桌面端，不在才走桌面端服务的 HTTP 路由
    const BRIDGE_FN = { apply: "apply_launcher", install_plugin: "install_plugin", install_deps: "install_deps", set_frameless: "set_frameless", set_dev_mode: "set_dev_mode" };
    const bridge = () => (window.pywebview?.api?.launcher_state ? window.pywebview.api : null);

    async function refresh() {
        const desktop = bridge();
        if (desktop) {
            render(await desktop.launcher_state());
            return;
        }
        const resp = await api.fetchApi("/neo_studio/launcher");
        if (!resp.ok) throw new Error(tf("读取启动设置失败：{status}", { status: resp.status }));
        render(await resp.json());
    }

    async function post(payload) {
        applyBtn.disabled = depsBtn.disabled = fixBtn.disabled = true;
        try {
            const action = payload.action || "apply";
            const fn = bridge()?.[BRIDGE_FN[action]];
            let data;
            if (fn) {
                data = action === "apply"
                    ? await fn(payload.root, payload.python, payload.port, payload.listen, payload.remote)
                    : action === "set_frameless"
                        ? await fn(payload.frameless)
                        : action === "set_dev_mode"
                            ? await fn(payload.dev_mode)
                            : await fn();
            } else {
                const resp = await api.fetchApi("/neo_studio/launcher", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                data = await resp.json();
            }
            const failed = data.ok === false;   // 重试安装插件回的是内核状态，没有 ok 字段也算成功
            toast(failed ? (data.error || t("操作失败")) : (data.msg || t("已保存，ComfyUI 重启中…")));
            if (!failed) await refresh();
        } catch (e) {
            toast(tf("启动设置保存失败：{msg}", { msg: e.message }));
        } finally {
            applyBtn.disabled = depsBtn.disabled = fixBtn.disabled = false;
        }
    }

    browseBtn.addEventListener("click", async () => {
        const picked = await window.pywebview?.api?.pick_root?.();
        if (picked) rootIn.value = picked;
    });
    pyBrowseBtn.addEventListener("click", async () => {
        const picked = await window.pywebview?.api?.pick_python?.();
        if (picked) pyIn.value = picked;
    });
    applyBtn.addEventListener("click", () => post({
        root: rootIn.value, python: pyIn.value, port: portIn.value,
        listen: listenSel.value, remote: remoteIn.value.trim(),
    }));
    depsBtn.addEventListener("click", () => post({ action: "install_deps" }));
    fixBtn.addEventListener("click", () => post({ action: "install_plugin" }));
    framelessIn.addEventListener("change", () => post({ action: "set_frameless", frameless: framelessIn.checked }));
    devIn.addEventListener("change", () => post({ action: "set_dev_mode", dev_mode: devIn.checked }));
    // 提示行跟着选中项与端口实时变，点「保存并重启 ComfyUI」才落盘
    listenSel.addEventListener("change", renderLanHint);
    portIn.addEventListener("input", renderLanHint);
    remoteIn.addEventListener("input", renderLanHint);

    // 内核启停在面板顶部：状态一行 + 启动 / 停止两枚按钮，此刻做不了的那枚禁用
    // 内核状态行：远程模式没有本机端口 / 谁启动 / PID 可报，只报远端地址；停止内核管不到远端进程，禁用
    function renderKernel(s) {
        const booting = (userStarting || s.starting) && !s.ready;
        const running = s.running && !booting;
        kernelState.textContent = `ComfyUI ${booting ? t("启动中…") : (s.running ? t("运行中") : t("已停止"))}`
            + (s.remote ? tf(" · 远程 {remote}", { remote: s.remote })
                : tf(" · 端口 {port} · {by}", { port: s.port, by: t(s.mine ? "桌面端启动" : "外部启动") }))
            + (s.pid ? ` · PID ${s.pid}` : "");
        kernelState.classList.toggle("ns-kernel-run", running);
        startBtn.textContent = booting ? t("启动中…") : (s.remote ? t("重连远端") : t("▶ 启动内核"));
        startBtn.disabled = booting || s.running;
        stopBtn.disabled = booting || !s.running || !!s.remote;
    }
    onComfyState(renderKernel);
    startBtn.addEventListener("click", () => { startBtn.disabled = true; startKernel(); });
    stopBtn.addEventListener("click", () => { stopBtn.disabled = true; stopKernel(); });

    const el = $el("div", { className: "ns-settings-section" }, [
        $el("h3", { textContent: t("启动设置") }),
        $el("div", { className: "ns-kernel" }, [
            kernelState,
            $el("div", { className: "ns-kernel-actions" }, [startBtn, stopBtn]),
        ]),
        status,
        rootRow,
        pyRow,
        portRow,
        listenRow,
        remoteRow,
        row(t("无边框窗口"), t(TIPS.frameless), framelessIn),
        row(t("开发模式"), t(TIPS.dev), devIn),
        $el("div", { className: "ns-launch-actions" }, [applyBtn, depsBtn, fixBtn]),
        lanHint,
        info,
    ]);
    return { el, refresh };
}

// ====== 界面语言：桌面端设置页的一栏，单选即选即落盘并整页刷新 ======
// 语言只影响桌面端自有文案（顶栏、导演面板、启动设置、状态位）；素材 / 技能 / 各设置表单沿用共享模块原文。
function createLangPanel() {
    const current = getLang();
    const rows = LANGS.map((l) => {
        const input = $el("input", { type: "radio", name: "ns-lang", value: l.value });
        input.checked = l.value === current;
        input.addEventListener("change", () => applyLang(l.value));
        return $el("label", { className: "ns-lang-row" }, [input, $el("span", { textContent: l.label })]);
    });
    return $el("div", { className: "ns-lang" },
        [...rows, $el("div", { className: "ns-lang-hint", textContent: t("选择后立即落盘并整页刷新，界面文案按新语言重建。") })]);
}

// ====== 设置页：左侧 tab 切换（LLM / 生图 / 生视频 / 智能体偏好 / MCP 服务 / 界面语言 / 日志 / 启动设置 / 关于），默认 LLM ======
let settingsShow = null;   // 设置页的 tab 切换函数：深链 #/settings?tab=mcp 要用它落到那一栏

let agentPrefs = null;   // 设置页那张偏好表单：深链 #/settings?tab=agent&skill=.. 的预填要走它

function buildSettings(el) {
    // 三个表单工厂均返回 { el, load, save, isDirty }，挂 .el、后台 load（保存按钮在表单内部）
    const genForm = createImageGenSettingsForm();
    const videoForm = createVideoGenSettingsForm();
    const llmForm = createModelConfigForm();

    // 日志面板：ComfyUI 控制台环形缓冲（app.logger 300 条），tab 激活时轮询
    const logBody = $el("pre", { className: "ns-log" });
    let logTimer = null;
    let logStick = true;   // 贴底才自动滚；用户往上翻看时停住，翻回底部恢复

    const logAtBottom = () =>
        logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight <= 40;
    logBody.addEventListener("scroll", () => { logStick = logAtBottom(); });

    // 每 2 秒整段重写 <pre> 会把拖到一半的选区抹掉；选区落在日志里就跳过这一轮刷新
    const logSelected = () => {
        const sel = window.getSelection();
        return !!sel && !sel.isCollapsed && logBody.contains(sel.anchorNode);
    };

    async function refreshLog() {
        if (logSelected()) return;
        try {
            const data = await (await api.fetchApi("/neo_studio/log")).json();
            // 条目是原始 stdout，自带换行与 ANSI 色码；色码在网页里是乱码，剥掉
            logBody.textContent = (data.entries || []).map(e => String(e.m).replace(/\x1b\[[0-9;]*m/g, "")).join("");
            if (logStick) logBody.scrollTop = logBody.scrollHeight;
        } catch { /* ComfyUI 未就绪时保留上次内容 */ }
    }

    // 整段取走日志：非 dev 模式的桌面窗口里 WebView2 关掉了右键菜单与 Ctrl+C，
    // 页内按钮是不依赖这两条通道就能拿到日志的路径
    // 按钮的 mousedown 默认动作会清掉页面选区，click 时已经读不到 —— 下按时先把选区取走
    let logSelText = "";
    const copyLogBtn = $el("button", {
        className: "ns-btn ns-log-copy",
        title: t("有选区复制选区，没有选区复制全部日志"),
        onclick: async () => {
            const picked = !!logSelText;
            const text = logSelText || logBody.textContent;
            logSelText = "";
            if (!text) { toast(t("日志为空")); return; }
            const lines = text.split("\n").length;
            try {
                await navigator.clipboard.writeText(text);
                toast(picked ? tf("已复制选中内容（{n} 行）", { n: lines })
                             : tf("日志已复制（{n} 行）", { n: lines }));
            } catch (e) {
                toast(tf("复制失败：{msg}", { msg: String(e) }));
            }
        },
    }, [icon("copy"), " " + t("复制日志")]);
    copyLogBtn.addEventListener("mousedown", () => {
        const sel = window.getSelection();
        logSelText = sel && !sel.isCollapsed && logBody.contains(sel.anchorNode) ? sel.toString() : "";
    });

    // tab 顺序：LLM 设置 → 生图设置 → 生视频设置 → 智能体偏好 → 界面语言 → 日志 → 启动设置 → 关于；每个 tab 只显示对应设置区
    const launcher = createLauncherPanel();
    const mcp = createMcpPanel();
    const prefs = createAgentPrefsForm({
        previewMode: () => previewOn, setPreviewMode: applyPreviewMode,
    });
    agentPrefs = prefs;   // 深链带预填参数进来时，route() 要把焦点链那份值交给这张表单

    const section = (title) => $el("h3", { textContent: t(title) });
    const sections = [
        { key: "llm", label: t("LLM 设置"), body: $el("div", { className: "ns-settings-section" }, [section("LLM 设置"), llmForm.el]) },
        { key: "gen", label: t("生图设置"), body: $el("div", { className: "ns-settings-section" }, [section("生图设置"), genForm.el]) },
        { key: "video", label: t("生视频设置"), body: $el("div", { className: "ns-settings-section" }, [section("生视频设置"), videoForm.el]) },
        { key: "agent", label: t("智能体偏好"), body: $el("div", { className: "ns-settings-section" }, [section("智能体偏好"), prefs.el]) },
        { key: "mcp", label: t("MCP 服务"), body: $el("div", { className: "ns-settings-section ns-mcp-section" }, [section("MCP 服务"), mcp.root]) },
        { key: "lang", label: t("界面语言"), body: $el("div", { className: "ns-settings-section" }, [section("界面语言"), createLangPanel()]) },
        { key: "log", label: t("日志"), body: $el("div", { className: "ns-settings-section ns-log-section" }, [$el("div", { className: "ns-log-head" }, [section("日志"), copyLogBtn]), logBody]) },
        { key: "launch", label: t("启动设置"), body: launcher.el },
        { key: "about", label: t("关于"), body: $el("div", { className: "ns-settings-section ns-about-section" }, [section("关于"), $el("div", { className: "ns-about-version", id: "ns-about-version", textContent: versionText() }), $el("div", { className: "ns-about-rows", id: "ns-about-rows" })]) },
    ];

    const tabs = $el("div", { className: "ns-settings-tabs" });
    const content = $el("div", { className: "ns-settings-content" });
    const showSection = (key) => {
        for (const s of sections) s.body.style.display = s.key === key ? "" : "none";
        for (const btn of tabs.children) btn.classList.toggle("active", btn.dataset.key === key);
        if (key === "log") {
            logStick = true;   // 重新进 tab 回到最新，之后按用户滚动位置决定
            refreshLog();
            logTimer = setInterval(refreshLog, 2000);
        } else if (key === "mcp") {
            mcp.refresh().catch(e => console.error("[Neo Studio] mcp panel refresh failed:", e));
        } else if (key === "agent") {
            prefs.load().catch(e => console.error("[Neo Studio] agent prefs load failed:", e));
        } else if (logTimer) {
            clearInterval(logTimer);
            logTimer = null;
        }
    };
    settingsShow = showSection;
    for (const s of sections) {
        const btn = $el("button", { className: "ns-settings-tab", textContent: s.label });
        btn.dataset.key = s.key;
        btn.addEventListener("click", () => showSection(s.key));
        tabs.appendChild(btn);
        content.appendChild(s.body);
    }

    el.appendChild($el("div", { className: "ns-settings" }, [tabs, content]));
    showSection("llm");  // 默认 LLM 设置
    renderAboutRows();   // 版本快照早于本页建成：路径行在 DOM 齐了之后补一次
    Promise.all([genForm.load(), videoForm.load(), llmForm.load()])
        .catch(e => console.error("[Neo Studio] settings load failed:", e));
    // 桥由 pywebview 在导航完成后才注入、方法还要晚一步填：桥在长就等它长完，别把桌面端窗口判成浏览器
    (async () => {
        for (let tries = 0; tries < 10; tries++) {
            try {
                await launcher.refresh();
                return;
            } catch {
                if (!window.pywebview) break;
                await new Promise(r => setTimeout(r, 300));
            }
        }
        launcher.el.remove();
        tabs.querySelector('[data-key="launch"]')?.remove();
    })();
}

// ====== 启动：版本信息 + 扩展初始化 + 路由 ======
let offline = false;   // 页面跑在桌面端的服务上：文件类功能可用，生成类请求由桌面端回 409
let starting = false;  // 桌面端已拉起 ComfyUI 还没就绪：这段时间只出「启动中」，其余离线提示一律收起
let caps = {};         // 桌面端能力表（/neo_studio/version 下发）；ComfyUI 页里缺省即全可用
let comfyBase = "";    // 生成类请求的直连目标；空 = 这路 ComfyUI 不认桌面端 origin（未就绪 / 附着 / 远程）
let versionInfo = { plugin: "", comfy: "", offline: false, dataRoot: "", comfyLocal: "", remote: "" };   // 版本号与路径行只在设置「关于」里显示

function can(feature) { return caps[feature] !== false; }

// ComfyUI 内核状态：顶栏只显状态，启停在「设置 → 启动设置」顶部。
// 一份 comfy_state 轮询下发给所有看它的人（顶栏状态位 + 启动设置的启停按钮）。
let comfyState = null;      // 最近一次快照；浏览器标签页里没有桌面端的桥，永远是 null
let userStarting = false;   // 已点下启动内核，等端口就绪
let flipStarted = false;    // 就绪后的原地翻面只发一次
const comfyViewers = new Set();

function publishComfyState(s) {
    comfyState = s;
    for (const fn of comfyViewers) fn(s);
}

function onComfyState(fn) {
    comfyViewers.add(fn);
    if (comfyState) fn(comfyState);
}

function toast(text) {
    let el = document.getElementById("ns-toast");
    if (!el) {
        el = $el("div", { id: "ns-toast", className: "ns-toast" });
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove("show"), 4200);
}

// 前端错误上报桌面端日志（data/studio_desktop.log）：白屏这类问题只有 DevTools 能看太晚。
// pywebview 桥脚本注入晚于页面加载，整页刷新时实测晚到页面脚本之后十几秒（日志里 before_load 与
// loaded 隔 13 秒），报错正撞在这个空档 —— 没就绪就接着重试，3 秒就放弃的话刷新那一下的报错全丢；
// 浏览器标签页里永远没有桌面端 api，送满一分钟静默放弃。
function desktopLog(text) {
    let tries = 0;
    const send = () => {
        const api = window.pywebview?.api;
        if (api?.log) {
            api.log(text);
            return;
        }
        if (tries++ < 200) setTimeout(send, 300);
    };
    send();
}

// 内核启停：「启动设置」顶部的两枚按钮与生成入口共用；状态由 comfy_state 轮询下发
function startKernel() {
    const desktop = window.pywebview?.api;
    if (!desktop?.comfy_start) {
        toast(t("请在 Neo Studio 窗口里启动 ComfyUI"));
        return;
    }
    if (starting || userStarting) return;   // 启动中：不重复拉起
    userStarting = true;
    desktop.comfy_start().then(publishComfyState).catch(() => { userStarting = false; });
}

function stopKernel() {
    const desktop = window.pywebview?.api;
    if (!desktop?.comfy_stop) return;
    desktop.comfy_stop().then(publishComfyState).catch(() => {});
}

function startComfy() {
    if (starting) return;   // 启动中：不重复拉起，也不出提示
    const inDesktop = !!window.pywebview?.api?.comfy_start;
    startKernel();
    if (inDesktop) toast(comfyState?.remote ? t("重连远端 ComfyUI…") : t("ComfyUI 启动中…就绪后自动接上生成"));
}

// 生成类请求打到桌面端上必 409：统一提示并指向「设置 → 启动设置」，不给前端假成功
window.addEventListener("neo-offline-request", () => {
    if (starting) return;   // 启动中不提示：就绪后页面自己接上生成
    toast(t("该功能需要 ComfyUI · 在「设置 → 启动设置」点「启动内核」"));
    document.getElementById("ns-comfy-status")?.classList.add("ns-comfy-hint");
});

// 运行类按钮 → 所需 ComfyUI 运行时能力：能力缺失时点它交给桌面端拉起 ComfyUI，不发假请求。
// 编辑类不在表里（保存 / 重写提示词 / 逐格描述 / 宫格拆分 / 技能编辑 / 设置 / LLM 配置）：
// 那些接口只读写文件与 8080 服务，桌面端自己就能服务。
const RUN_GATES = [
    [".neo-gallery-gm-btn", "image_gen", t("生成素材")],
    [".neo-agent-run", "agent", t("生成")],
    [".ns-gen-run", "director", t("生成整片")],
    [".ns-video-run", "simple_video", t("生成视频")],
    [".neo-director-regen-run", "segment", t("生成这一段")],
    [".neo-director-merge-run", "segment", t("拼回成片")],
    [".ns-paint .neo-gallery-story-btn-primary", "image_gen", t("生成")],   // 绘画页文生图 / 图片编辑面板的生成
];

// 生成按钮改写成「需要 ComfyUI」：不发请求，点一下引导启动（须在原 handler 之前注册）
// 登记下来：就绪翻面时摘监听、还原文案，按钮回到原 handler 上。
const gatedButtons = [];

function gateRunButton(btn, feature, label) {
    if (can(feature)) return;
    const original = btn.textContent;
    const originalTitle = btn.title;
    btn.textContent = runLabel();
    btn.title = tf("{label} 需要 ComfyUI 执行队列 · 点一下启动", { label });
    btn.classList.add("ns-gen-off");
    const block = (e) => {
        e.stopImmediatePropagation();
        startComfy();
    };
    btn.addEventListener("click", block);
    gatedButtons.push({ btn, block, original, originalTitle, label });
}

function ungateRunButtons() {
    for (const g of gatedButtons) {
        g.btn.removeEventListener("click", g.block);
        g.btn.textContent = g.original;
        g.btn.title = g.originalTitle || g.label;
        g.btn.classList.remove("ns-gen-off");
    }
    gatedButtons.length = 0;
}

function runLabel() { return starting ? t("ComfyUI 启动中") : t("需要 ComfyUI"); }

// 共享模块（gallery / director / voice）大量直接用原生 fetch 打接口，不经 api shim：
// 这里同样按归属表改写目标 —— 就绪后生成类请求直连 ComfyUI，离线时打桌面端拿 409，
// 让各生成路径统一出「需要 ComfyUI」提示，不静默吞掉。
// 共享模块注册的运行按钮（生成素材 / 生成这一段 / 拼回成片 / 生成图片分镜）在捕获阶段拦掉。
function initOfflineGate() {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => nativeFetch(resolvePath(input, init), init).then((res) => {
        if (res.status !== 409) return res;
        res.clone().json()
            .then((data) => {
                if (data && data.offline) {
                    window.dispatchEvent(new CustomEvent("neo-offline-request", { detail: { path: String(input) } }));
                }
            })
            .catch(() => {});
        return res;
    });

    document.addEventListener("click", (e) => {
        for (const [selector, feature] of RUN_GATES) {
            if (can(feature)) continue;
            const btn = e.target?.closest?.(selector);
            if (!btn) continue;
            e.preventDefault();
            e.stopPropagation();
            startComfy();
            return;
        }
    }, true);
}

// 离线标记：body 上的 .ns-offline 让生成入口压暗、显存条收起。离线页不叠横幅 ——
// 顶栏胶囊的「● 已停止」已经报了状态并把入口指向「设置 → 启动设置」，横幅只是把同一句话画两遍。
// 状态在 loadVersion 里就从桌面端的快照拿到了：js_api 注入晚于页面加载，冷启动不能等它。
function setOfflineMark(on) {
    document.body.classList.toggle("ns-offline", on);
}

function versionText() {
    if (!versionInfo.plugin) return "";
    if (versionInfo.offline) return `Neo Studio ${versionInfo.plugin} · ${starting ? t("ComfyUI 启动中") : t("离线模式")}`;
    return `Neo Studio ${versionInfo.plugin} · ComfyUI ${versionInfo.comfy}`;
}

async function copyAboutValue(value) {
    if (typeof navigator.clipboard?.writeText === "function") {
        try { await navigator.clipboard.writeText(value); return true; } catch { /* 非安全上下文 / 权限拒绝：落 execCommand 兜底 */ }
    }
    const ta = $el("textarea", { value });
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }   // jsdom 与老浏览器没有 execCommand
    ta.remove();
    return ok;
}

function openExternalUrl(url) {
    // 无边框窗口里没有新标签可开：外链交桌面端的桥（它再校验一遍 scheme）；浏览器标签页里照常开新标签
    if (window.pywebview?.api?.open_url) { window.pywebview.api.open_url(url); return; }
    window.open(url, "_blank", "noopener");
}

function aboutRow(label, value, withOpen) {
    const copy = $el("button", { className: "ns-about-copy", type: "button", title: t("复制"), textContent: "⧉" });
    copy.onclick = async () => {
        toast(await copyAboutValue(value) ? t("已复制") : t("复制失败"));
    };
    const kids = [$el("span", { className: "ns-about-label", textContent: label }),
                  $el("code", { className: "ns-about-value", textContent: value, title: value }), copy];
    if (withOpen) {
        const open = $el("button", { className: "ns-about-open", type: "button", textContent: t("打开") });
        open.onclick = () => openExternalUrl(value);
        kids.push(open);
    }
    return $el("div", { className: "ns-about-row" }, kids);
}

// 「关于」里的路径行：值全来自版本快照（桌面端与内核两侧都报同一份键），空值那行不出
function renderAboutRows() {
    const box = document.getElementById("ns-about-rows");
    if (!box) return;
    const rows = [aboutRow(t("GitHub 仓库"), REPO_URL, true)];
    if (versionInfo.dataRoot) rows.push(aboutRow(t("数据目录"), versionInfo.dataRoot, false));
    if (versionInfo.comfyLocal) rows.push(aboutRow(t("ComfyUI 本地目录"), versionInfo.comfyLocal, false));
    if (versionInfo.remote) rows.push(aboutRow(t("远程 ComfyUI"), versionInfo.remote, true));
    box.replaceChildren(...rows);
}

function renderVersionInfo() {
    const el = document.getElementById("ns-about-version");
    if (el) el.textContent = versionText();
    renderAboutRows();
}

function setStarting(on) {
    if (starting === on) return;
    starting = on;
    if (offline) renderVersionInfo();
    for (const b of document.querySelectorAll(".ns-gen-off")) b.textContent = runLabel();   // 门控按钮文案跟着「启动中 / 需要 ComfyUI」收
}

async function loadVersion() {
    try {
        const r = await api.fetchApi("/neo_studio/version");
        const data = await r.json();
        if (data?.success) {
            offline = !!data.offline;
            starting = !!data.starting;   // 桌面端已拉起 ComfyUI：页面第一份状态就是「启动中」
            caps = data.caps || {};
            comfyBase = String(data.comfy_base || "");
            configureRoutes({ desktopRoutes: data.routes, comfyBase });
            versionInfo = {
                plugin: data.plugin_version || "", comfy: data.comfyui_version || "", offline,
                dataRoot: String(data.data_root || ""), comfyLocal: String(data.comfy_local || ""),
                remote: String(data.remote || ""),
            };
            renderVersionInfo();
            setOfflineMark(offline);
        }
    } catch { /* ComfyUI 未就绪时保持空白 */ }
}

// 就绪后原地接上生成：页面不换地址、不刷新，只把路由目标 / 能力表 / 门控 / 显存条 / 事件流翻面。
// 整页跳转与刷新都会清掉导演编辑器和表单里未保存的内容，跨源跳转更是全丢 —— 这里一样都不发生。
// 五步必须一次做完：只解禁按钮不换事件流，用户点「生成整片」会拿到任务拿不到进度。
// 直连目标由桌面端快照报（comfy_base），ComfyUI 答话之前整块不翻 —— 翻一半就是按钮能点、进度不来。
async function flipOnline() {
    if (!offline) return;
    try {
        const desk = await (await api.fetchApi("/neo_studio/version")).json();
        if (!desk?.success) return;
        const base = String(desk.comfy_base || "");
        if (!base) return;   // 这路不认桌面端 origin（附着 / 远程）：整页跳转交给桌面端，页面留在离线形态
        const comfy = await (await api.fetchApi(`${base}/neo_studio/version`)).json();
        if (!comfy?.success) { flipStarted = false; return; }   // 刚就绪还没答话：下一轮 5 秒探活再来
        configureRoutes({ desktopRoutes: desk.routes, comfyBase: base });
        comfyBase = base;
        caps = comfy.caps || {};
        offline = false;
        starting = false;
        userStarting = false;   // 内核已就绪：这轮「等端口」到此为止，顶栏状态位交回正常渲染
        versionInfo = {
            plugin: comfy.plugin_version || versionInfo.plugin, comfy: comfy.comfyui_version || "", offline: false,
            dataRoot: String(comfy.data_root || desk.data_root || ""), comfyLocal: String(comfy.comfy_local || desk.comfy_local || ""),
            remote: String(desk.remote || ""),   // 远程地址只有桌面端知道；空 = 连的本机
        };
        renderVersionInfo();
        setOfflineMark(false);
        ungateRunButtons();
        mountMemBars();
        reconnectSocket();
        desktopLog("FLIP online in-place");
    } catch {
        flipStarted = false;
    }
}

// 翻面后停掉内核：页面要翻回离线形态。不翻的话按钮解禁着、生成请求打到已关掉的端口上，
// 拿不到 409 也拿不到离线提示，比今天「窗口退回离线页」更糟。
async function flipOffline() {
    if (offline) return;
    offline = true;
    flipStarted = false;   // 下次就绪还能再翻过来
    configureRoutes({ comfyBase: "" });   // 先把直连目标收掉：下面这份快照必须打到桌面端上
    comfyBase = "";
    await loadVersion();   // 桌面端快照：comfy_base 已空，能力表与离线标记回到离线形态
    reGateRunButtons();
    reconnectSocket();     // 事件流切回桌面端的桩，别对着死端口重连
}

function reGateRunButtons() {
    for (const [selector, feature, label] of RUN_GATES) {
        for (const btn of document.querySelectorAll(selector)) {
            if (!gatedButtons.some((g) => g.btn === btn)) gateRunButton(btn, feature, label);
        }
    }
}

// 显存条在视图 build 期按能力决定出不出（离线整块不出）：翻面后补挂到生成面板原来的位置。
// 不重建视图 —— 重建会把设置页表单与导演编辑器里未保存的内容清掉，那正是本轮要保的东西。
const MEM_BAR_HOSTS = [".ns-gen-foot", ".ns-paint-main"];

function mountMemBars() {
    for (const sel of MEM_BAR_HOSTS) {
        for (const host of document.querySelectorAll(sel)) {
            if (host.querySelector(":scope > .ns-mem")) continue;
            const bar = buildMemBar();
            if (bar) host.appendChild(bar);
        }
    }
}

// ====== 无边框窗口：系统标题栏被桌面端摘掉后，最小化 / 最大化 / 全屏 / 关闭由顶栏自己画 ======
// 只有桌面端窗口有 pywebview 桥；浏览器标签页里桥不存在，控件整块不出现，顶栏照旧。
function initWindowChrome() {
    const btn = (id) => document.getElementById(id);
    const set = (id, ico, title) => {
        const b = btn(id);
        if (b) { setIcon(b, ico); b.title = title; }
    };
    let state = { frameless: false, maximized: false, fullscreen: false };
    const render = (s) => {
        state = s;
        document.body.classList.toggle("ns-frameless", !!s.frameless);
        btn("ns-wctl").hidden = !s.frameless;
        // 钮面只出图标：字形（▢ ❐ ⛶ – ✕）随字体变样，WebView2 里还会掉色成 emoji
        set("ns-win-min", "minimize", t("最小化"));
        set("ns-win-max", s.maximized ? "restore" : "maximize", s.maximized ? t("还原") : t("最大化"));
        set("ns-win-fs", s.fullscreen ? "restore" : "fullscreen", s.fullscreen ? t("退出全屏") : t("全屏"));
        set("ns-win-close", "cross", t("关闭"));
    };
    const wire = (bridge) => {
        bridge.window_state().then((s) => {
            render(s);
            if (!s.frameless) return;
            btn("ns-win-min").addEventListener("click", () => bridge.win_minimize());
            btn("ns-win-max").addEventListener("click", () => bridge.win_maximize().then(render));
            btn("ns-win-fs").addEventListener("click", () => bridge.win_fullscreen().then(render));
            btn("ns-win-close").addEventListener("click", () => bridge.win_close());
            // 顶栏空白处按下交给桌面端：桌面端在窗口线程上跟住光标搬窗口，JS 自己算位移只会抖
            const header = document.querySelector(".ns-header");
            const blank = (e) => e.button === 0 && !e.target.closest("a,button,input,select,textarea");
            header.addEventListener("mousedown", (e) => {
                if (!blank(e)) return;
                // 拖动期间鼠标捕获在桌面端窗口上，页面收不到 mouseup：拖动收尾时补一发，页面别停在按下态；
                // 桌面端在拖动途中可能顺手还原了最大化 / 退掉了全屏，图标按桌面端的状态重画一遍
                const up = () => document.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
                Promise.resolve(bridge.win_start_drag()).finally(() => {
                    up();
                    bridge.window_state().then(render).catch(() => {});
                });
            });
            // 双击顶栏空白 = 原生标题栏语义：最大化 / 还原来回切；全屏时先退回窗口态
            header.addEventListener("dblclick", (e) => {
                if (!blank(e)) return;
                const done = state.fullscreen ? bridge.win_fullscreen() : bridge.win_maximize();
                Promise.resolve(done).then(render).catch(() => {});
            });
        }).catch(() => { /* 桥未就绪：顶栏不出控件 */ });
    };
    // 桥脚本在导航完成之后才注入且分两步：window.pywebview 先到（api 是空的），方法由 finish.js
    // 调 _createApi 后填；整页刷新时实测晚到页面脚本之后好几秒。放弃一次就是刷新一次顶栏少一块，
    // 控件与拖动永久消失，所以探桥不封顶。
    let wired = false;
    const attach = () => {
        if (wired) return;
        const bridge = window.pywebview?.api;
        if (!bridge?.window_state) return;
        wired = true;
        wire(bridge);
    };
    attach();
    // finish.js 填完方法就派发这一件，桥可用正是这一刻：拖动挂在它上面，注入完即生效。
    // 冷启动窗口停在桌面端页上，顶栏拖不动的那一会就夹在这条注入与下面的轮询之间
    window.addEventListener("pywebviewready", attach);
    setInterval(attach, 5000);   // 桥在本模块脚本之前注入完时事件已经过去，补一轮；浏览器标签页里桥永不来
}

// ====== 刷新快捷键 ======
// pywebview 把 WebView2 的浏览器加速器键整个绑在 debug 上（platforms/edgechromium.py 里
// AreBrowserAcceleratorKeysEnabled = debug）：不带 --debug 启动时 F5 / Ctrl+F5 / Ctrl+R
// 全被 WebView2 吞掉，热同步完前端在窗口里按刷新没反应。加速器键关掉后按键原样落到网页内容，
// 这里自己接管。JS 走 no-store（studio_server.py 的 no_store 中间件），整页刷新必取新文件。
function initReloadHotkey() {
    document.addEventListener("keydown", (e) => {
        if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === "KeyR")) {
            e.preventDefault();
            location.reload();
        }
    }, true);
}


// ====== 复制粘贴按键放行 ======
// 非 debug 窗口里 pywebview 注入的 customize.js 在 window 上挂了一个只放过 F12 与 DevTools 三键的
// keydown，其余按键全部 preventDefault：Ctrl+C 划词复制、Ctrl+V 粘参考图、Ctrl+A 全选一起没了。
// 在 capture 相位把这几个键摘走，customize.js 收不到事件就不会吞默认动作；刷新键不在放行名单里，
// 仍由 initReloadHotkey 接管
function initClipboardKeys() {
    const CLIP_KEYS = new Set(["KeyC", "KeyV", "KeyX", "KeyA", "KeyZ", "KeyY"]);
    document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && CLIP_KEYS.has(e.code)) e.stopImmediatePropagation();
    }, true);
}

// ====== 显存/内存监控（导演页生成面板底部） ======
// 只有导演生成会把显存吃满：读数挂在导演页，进导演页才轮询，离开即停
function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return "--";
    const gb = n / (1024 * 1024 * 1024);
    return gb >= 1 ? `${gb.toFixed(1)}G` : `${Math.round(n / (1024 * 1024))}M`;
}

function setMemItem(el, used, total, label) {
    if (!Number.isFinite(total) || total <= 0) { el.textContent = `${label} --`; return; }
    const pct = used / total;
    el.textContent = `${label} ${fmtBytes(used)}/${fmtBytes(total)}`;
    el.classList.toggle("warn", pct >= 0.6 && pct < 0.85);
    el.classList.toggle("crit", pct >= 0.85);
}

async function pollMemStats() {
    const bars = document.querySelectorAll(".ns-mem");   // 导演页 / 绘画页各一条读数条
    if (!bars.length) return;
    let vram = null, ram = null;
    try {
        // 驱动级显存占用（含全部进程）；/system_stats 的 vram_free 把 torch reserved 空闲重复计入，不准
        const r = await api.fetchApi("/neo_studio/mem_stats");
        const data = await r.json();
        if (data?.success) vram = data;
    } catch { /* 网络抖动忽略 */ }
    try {
        const r = await api.fetchApi("/system_stats");
        const data = await r.json();
        if (data?.system) ram = data.system;
    } catch { /* 网络抖动忽略 */ }
    for (const bar of bars) {
        if (vram) setMemItem(bar.querySelector(".ns-vram"), vram.vram_used, vram.vram_total, t("显存"));
        if (ram) setMemItem(bar.querySelector(".ns-ram"), (ram.ram_total || 0) - (ram.ram_free || 0), ram.ram_total, t("内存"));
    }
}

// 读数 + 清理按钮：导演页生成面板底部那一行；离线（无 memory 能力）整块不出
function buildMemBar() {
    if (!can("memory")) return null;
    const bar = $el("div", { className: "ns-mem" }, [
        $el("span", { className: "ns-mem-item ns-vram", title: t("GPU 显存占用（含全部进程）"), textContent: `${t("显存")} --` }),
        $el("span", { className: "ns-mem-item ns-ram", title: t("系统内存占用"), textContent: `${t("内存")} --` }),
    ]);
    const btn = $el("button", {
        className: "ns-mem-clear", type: "button",
        title: t("卸载空闲模型并释放显存缓存 · 生成后显存迟迟不降时用"), textContent: t("清理"),
    });
    btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = t("清理中…");
        try {
            const r = await api.fetchApi("/neo_studio/clear_memory", { method: "POST" });
            const data = await r.json().catch(() => null);
            btn.textContent = data?.success ? tf("释放 {n} ", { n: fmtBytes(data.freed_bytes) }) : t("清理失败");
        } catch {
            btn.textContent = t("清理失败");
        }
        setTimeout(() => { btn.disabled = false; btn.textContent = t("清理"); }, 2500);
        pollMemStats();   // 立即刷新一次
    });
    bar.appendChild(btn);
    return bar;
}

let memTimer = null;

function setMemActive(on) {
    if (!on) {
        if (memTimer) { clearInterval(memTimer); memTimer = null; }
        return;
    }
    if (memTimer || !can("memory")) return;   // 离线：显存与清理都要 ComfyUI，别每 3s 撞 409
    pollMemStats();
    memTimer = setInterval(pollMemStats, 3000);
}

// ====== 顶栏 ComfyUI 状态位（桌面端窗口里才有：状态由 js_api 的 comfy_state 与桌面端服务的
// /neo_studio/comfy_state 两条来源送） ======
// 只报状态，不带动作 —— 启停在「设置 → 启动设置」顶部；端口 / 谁启动 / 进程号收在提示里。
function initComfyStatus() {
    const el = document.getElementById("ns-comfy-status");
    if (!el) return;
    const runTitle = (s) => s.remote
        ? (s.running ? tf("远程 ComfyUI 运行中 · {remote} · 起停由远端机器管", { remote: s.remote })
                     : tf("远程 ComfyUI 不可达 · {remote}", { remote: s.remote }))
        : (s.running
            ? tf("ComfyUI 运行中 · 端口 {port} · {by} · PID {pid}", { port: s.port, by: t(s.mine ? "桌面端启动" : "外部启动"), pid: s.pid })
            : t("ComfyUI 已停止 · 在「设置 → 启动设置」点「启动内核」"));
    const render = (s) => {
        el.hidden = false;   // 状态到了才出字：出字前它是空的，浏览器标签页里没人送状态就一直是空的
        setStarting(!!s.starting);   // 桌面端拉起的启动中：生成按钮文案跟着收
        // 就绪就翻面，不看是谁拉起内核。桌面端在 ready 这同一份快照里才清掉 starting（_jump_when_ready），
        // 5 秒轮询只会看到「启动中·未就绪」紧跟「已就绪·不再启动中」；拿 starting 当翻面条件的话，
        // 桌面端自己拉起内核的冷启动（userStarting 为假）永远进不来，顶栏出「运行中」而页面钉在离线形态。
        if (s.ready && offline) {
            setStatus("run", t("运行中"), runTitle(s));   // 翻面是异步的：这一轮先把字挂上，翻完之前顶栏不许是空的
            if (!flipStarted) { flipStarted = true; flipOnline(); }   // 原地接上生成：不刷新，未保存的编辑留着
            return;
        }
        if (userStarting || s.starting) {
            setStatus("starting", t("启动中"), t("ComfyUI 启动中…就绪后自动接上生成"));
            return;
        }
        setStatus(s.running ? "run" : null, s.running ? t("运行中") : t("已停止"), runTitle(s));
        if (!s.ready && !offline) flipOffline();
    };

    onComfyState(render);

    // 两条来源同轮并发，谁先落地用谁，一条都不许等死。桥的返回要窗口线程把 resolve 脚本打回页面
    // （pywebview 的 js_bridge_call 在 worker 线程算完结果，靠 evaluate_js 的 Invoke + 信号量送回），
    // 而拖动循环就跑在窗口线程上、每步 sleep 不泵消息（app/studio_app.py 的 win_start_drag）：
    // 这段拖动里桥的 promise 整段不落地，只认桥就是刷新后状态位不回来的现场（日志里刷新后紧接
    // 一串 drag 199 steps，页面到不了 ready，[web] FLIP 一行不出）。HTTP 那条由桌面端服务的线程答，
    // 与窗口线程无关。它是桌面端自己的一层（与 /neo_studio/version 同路，不在归属表里），所以打
    // 绝对地址问页面自己的 origin：页面钉在桌面端端口上，翻面之后归属表把表外路径送去 ComfyUI
    // 也管不到它。origin 不答这条路由（浏览器标签页 / 远程那路）就停问，别每 5 秒撞一次 404。
    let httpAsks = true;
    const pollHttp = () => fetch(`${location.origin}/neo_studio/comfy_state`)
        .then((r) => (r.ok ? r.json() : (httpAsks = false, null)))
        .then((d) => { if (d?.success) publishComfyState(d); })
        .catch(() => {});
    const poll = () => {
        const api = window.pywebview?.api;
        if (api?.comfy_state) api.comfy_state().then(publishComfyState).catch(() => {});
        if (httpAsks) pollHttp();
    };
    poll();
    setInterval(poll, 5000);
}

function setStatus(kind, text, title) {
    const el = document.getElementById("ns-comfy-status");
    el.textContent = `● ${text}`;
    el.classList.remove("ns-comfy-run", "ns-comfy-starting");
    if (kind) el.classList.add(`ns-comfy-${kind}`);
    el.title = title;
}

// ====== 顶栏静态壳：index.html 里的中文是原文，按当前语言重画（切语言走整页刷新，不做运行中热替换） ======
function localizeShell() {
    document.title = t("新影工坊 · Neo Studio");
    const logo = document.querySelector(".ns-logo");
    if (logo) { logo.textContent = t("新影工坊"); logo.title = t("返回首页"); }
    for (const a of document.querySelectorAll(".ns-tabs a")) a.textContent = t(a.textContent.trim());
    for (const id of ["ns-win-min", "ns-win-max", "ns-win-fs", "ns-win-close", "ns-agent-toggle"]) {
        const b = document.getElementById(id);
        if (b) b.title = t(b.title);
    }
}

// ====== 采样预览：这一轮要不要逐采样步的动画帧 ======
// 界面就是面板本身，没有第二块舞台。这一项是本机界面偏好，存 localStorage，不进 configs/agent_prefs.json
// （那六个字段会进系统提示词，界面布局不该进去）
const AGENT_PREVIEW_KEY = "neo_studio_agent_preview";
let previewOn = true;     // 关掉就是这一轮不给后端要采样帧（preview_side 0），SSE 里不再有 base64 帧
try { previewOn = localStorage.getItem(AGENT_PREVIEW_KEY) !== "0"; } catch { /* 偏好读不到就用默认 */ }
// 中间舞台与可拖分隔条已删掉：清掉旧版留下的那两份本机开关，不留死键
try { localStorage.removeItem("neo_studio_agent_stage"); localStorage.removeItem("neo_studio_agent_split"); } catch { /* 写不进就不清 */ }

function applyPreviewMode(on) {
    previewOn = !!on;
    try { localStorage.setItem(AGENT_PREVIEW_KEY, previewOn ? "1" : "0"); } catch { /* 偏好写不进不影响用 */ }
}

// ====== 智能体页：独占整页，面板是界面本身、结果就铺在面板里；入口是顶栏那颗星形按钮与首页创造区的卡 ======
// 导航栏不给它留位：页面靠 go("agent") 进，与其余页同一条路由，视图常驻不重建（会话时间线不丢）

function buildAgentPage(el) {
    el.classList.add("ns-agent-page");
    const chatHost = $el("div", { className: "ns-agent-chat" });
    el.appendChild(chatHost);
    const memBar = buildMemBar();   // 智能体页的出片走同一条执行队列：显存 / 内存读数照给
    if (memBar) el.appendChild(memBar);
    const panel = createAgentPanel(chatHost, {
        // MCP 注册表在设置页那一栏，面板入口只做跳转（pushState 与 go() 同一理由：不碰 location.hash）
        onOpenMcp: () => {
            history.pushState(null, "", "#/settings?tab=mcp");
            route();
        },
        // 用户级偏好的表单在设置页那一栏，面板只跳过去（pushState 与 MCP 入口同一理由：不碰 location.hash）；
        // 焦点链上的「设为偏好」把这一发的技能、宽高与主模型家族带进表单，用户不用自己抄——
        // 家族取的是这一发用的主模型命中家族线索的那一个（导演配方名是中文，过不了后端家族名的形态）
        onOpenPrefs: (fact) => {
            const q = new URLSearchParams({ tab: "agent" });
            if (fact?.skill_id) q.set("skill", fact.skill_id);
            if (fact?.width && fact?.height) q.set("size", `${fact.width}x${fact.height}`);
            const family = fact?.model ? modelFamily(fact.model) : "";
            if (family) q.set("family", family);
            history.pushState(null, "", `#/settings?${q}`);
            route();
        },
        // 界面当前状态由宿主交：面板把它画进上下文条，并把同一份值随请求体交后端进系统提示词
        getContext: agentContext,
        // 采样预览要哪一档由开关定：关掉这一轮就不要采样帧（0 = 后端不读预览表）；
        // 结果与动画都铺在面板里，要 1024 那一档才铺得开
        previewSide: () => (previewOn ? AGENT_PREVIEW_SIDE : 0),
    });
    agentCtxRefresh = () => panel.refresh();   // 切页 / 选配方 / 切绘画模式时重画面板上的上下文条
}

// 顶栏入口：字形走中央图标层（与首页「生成图片」卡同款），title 走 i18n，字形不占文案
function initAgentEntry() {
    const toggle = document.getElementById("ns-agent-toggle");
    if (!toggle) return;
    toggle.replaceChildren(icon("sparkles", 15));
    toggle.onclick = () => go("agent");
    toggle.hidden = false;
    agentEntryBtn = toggle;
}

function route() {
    const name = (location.hash || "#/home").replace(/^#\//, "").split("?")[0] || "home";
    // 首页 / 导演页 / 绘画页视图常驻：首页卡片直达后两页，内嵌宿主要在第一次点
    // 「新建导演配方 / 生成素材 / 图片编辑」之前就要注册好
    ensureView("home", buildHome);
    ensureView("director", buildDirector);
    ensureView("paint", buildPaint);
    if (name === "skills") ensureView("skills", buildSkills);
    else if (name === "video") ensureView("video", buildVideo);
    else if (name === "agent") ensureView("agent", buildAgentPage);
    else if (name === "settings") {
        ensureView("settings", buildSettings);
        // 深链 #/settings?tab=mcp：智能体页「MCP」入口跳来这，视图常驻时也要落到那一栏
        const query = new URLSearchParams(location.hash.split("?")[1] || "");
        const tab = query.get("tab");
        if (tab && settingsShow) {
            settingsShow(tab);
            if (tab === "agent") agentPrefs.prefill(query);   // 焦点链的技能与宽高照深链落进表单
        }
    }
    else if (name !== "home") ensureView("gallery", buildGallery);
    showView(name);
}

// 仅 Studio 独立页启动：本文件也会作为扩展模块被主画布页加载（WEB_DIRECTORY），那里没有 #ns-view
if (view) {
    localizeShell();
    bindHeaderNav();
    // 顶栏控件与拖动只吃 index.html 的静态顶栏，不等扩展 setup 与版本快照：那两次请求都打在刚装配、
    // 正拉起 ComfyUI 的桌面端服务上，排在它们后面就是「窗口开出来要过一会才能拖动」
    initWindowChrome();
    // 未捕获错误与启动失败一并写进桌面端日志：窗口白屏时日志里至少留下证据
    window.addEventListener("error", (e) => desktopLog(`ERROR ${e.message} @ ${e.filename}:${e.lineno}`));
    window.addEventListener("unhandledrejection", (e) => desktopLog(`REJECT ${e.reason?.stack || String(e.reason)}`));
    window.addEventListener("hashchange", route);
    window.addEventListener("popstate", route);   // 换页走 pushState 后，浏览器 Back 只派发 popstate
    initExtensions().then(async () => {
        await loadVersion();   // 先拿到离线标记与能力表，再建视图（生成按钮要按能力门控）
        initOfflineGate();
        route();   // 视图先挂上：桌面端附件（顶栏状态位）失败不能连坐，窗口不至于停在只出顶栏的空白页
        initComfyStatus();
        initClipboardKeys();
        initReloadHotkey();
        initAgentEntry();
    }).catch(e => {
        console.error("[Neo Studio] startup failed:", e);
        desktopLog(`STARTUP FAILED ${e?.stack || e}`);
    });
}
