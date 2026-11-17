// Neo Studio 外桌面端：hash 路由（#/home #/gallery #/paint #/director #/skills #/settings）+ 各视图挂载。
// 功能全部复用 web/ 现有模块（import-map 把 scripts/* 指到 shim）：
// - 素材：NeoGallery（gallery.js 注册的扩展，侧栏 tab 的 render 直接挂进主区）
// - 导演：配方面板（recipes.js）+ 整片生成面板（POST /neo_studio/director/generate）
// - 技能：统一技能管理（skill.js createSkillManager，与顶栏「技能管理」同组件，直接展开无弹窗）
// - 设置：生图/生视频/LLM 设置表单（内嵌，无弹窗）
import { app, initExtensions, getSidebarTab, onSidebarTabChange } from "./shim/app.js";
import { api, reconnectSocket } from "./shim/api.js";
import { $el } from "./shim/ui.js";
import { configureCanvasOrigin } from "../js/core/canvas-origin.js";

import "../gallery.js";   // 注册 comfy.neo.gallery 扩展（NeoGallery + 侧栏 tab 定义）
import { openDirectorEditor, createSegmentOps, createSharedConfigSection, DIRECTOR_RECIPE_SAVED_EVENT, SEG_MODES, MODE_LABELS, LEGACY_MODE_MAP } from "../director.js";
import { openImageEditDialog, setVideoPageJump, ratioGlyph, skillParamsChip } from "../gallery-gen.js";
import { createFramePlayer, AGENT_PREVIEW_SIDE } from "../live-preview.js";
import { createRecipesPanel, listRecipes } from "../recipes.js";
import { listVideoSkills } from "../recipes.js";
import { DirectorTimeline } from "../director-timeline.js";
import { skillDisplayName } from "../skill.js";
import { createVideoModelConfigSection, listVideoGenModels, getSkillGenConfig, modelFamily } from "../image-gen.js";
import { createAgentPanel } from "../agent-panel.js";
import { t, tf } from "../js/core/i18n.js";
import { icon, setIcon, setIconLabel } from "../js/core/icons.js";
import { createLibraryModal, acceptsPick } from "../js/core/lib-modal.js";
import { createMediaSlot } from "../js/core/media-slot.js";
import { initQueuePanel, setQueueOnline, queueTrack } from "../queue-panel.js";
import { createLeafPages } from "./pages/leaf-pages.js";
import { createStoryboardPage } from "./pages/storyboard-page.js";
import { createPaintEditPage } from "./pages/paint-edit-page.js";
import { createHomePage } from "./pages/home-page.js";
import { createVideoPage } from "./pages/video-page.js";
import { createSkillsPage } from "./pages/skills-page.js";
import { createSettingsPage } from "./pages/settings-page.js";
import { STUDIO_APPS, appById } from "./app-registry.js";


const view = document.getElementById("ns-view");
const REPO_URL = "https://github.com/neoneo-ai/neo-studio";   // 设置「关于」里的仓库行，与顶栏「关于插件」同一地址
let directorPanelOpts = null;   // 导演页配方面板选项（buildDirector 设置；含 onSelect 回传选中配方）
let onDirectorShown = null;     // 进导演页时补拉的活：隐藏期间跳过的 director_spec 在进本页时补一次
let directorOpenRecipe = null;  // 导演页建好时挂上的「按名字开编辑器」：首页配方卡的 ?recipe= 深链走这条路
let storyboardReleaseEditor = null;   // 故事板页建好时挂上的「让位」：导演页开全量编辑器前先收回内嵌在故事板页那一份
let onStoryboardShown = null;    // 进故事板页时补拉的活：视图常驻显隐，回到本页要把内嵌编辑器补铺好

// ====== 智能体的界面上下文：宿主只交事实，面板画进上下文条并随请求体交后端进系统提示词 ======
// 只交当前选中页签自己那一栏：导演页的配方、素材页的目录各留自己那页，切到技能 / 设置页
// 就只剩页面本身——在技能页还带着「当前配方 X」出片，就是拿没在看的页签干扰这一轮。
// 素材库目录在取用时现读画廊：画廊导航没有对外事件，读一次现值比在 gallery.js 里插监听便宜
const agentCtx = { page: "gallery", recipe: "", segments: 0 };
let agentCtxRefresh = null;     // 智能体页建好时挂上的重画回调，页面没建过就没有面板可通知

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
    // 绘画页只有文生图、编辑页只有图片编辑：页面名本身就是这两件事，没有模式要报
    if (page === "paint") return { page };
    if (page === "edit") {
        return (lib && libModal?.isOpen() && libScope === "edit") ? withLib({ page }) : { page };
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
    // 页签条装得下就贴右（右侧那一截让给状态位 / 队列图标 / 设置图标 / 窗口控件），装不下回到左起。
    // 溢出只量条本身不行：贴右排布时溢出长在可视区左边的滚动区里，scrollWidth 不计这一段，
    // 挤到只剩几十像素的条照旧报「装得下」，首页就此滚出可视区。页签是 flex:none，
    // 自身宽度就是排版要占的真实宽度，按「页签宽之和 + 行距」判
    const tabsBar = document.querySelector(".ns-tabs");
    if (tabsBar) {
        const links = [...tabsBar.querySelectorAll("a")];
        const gap = parseFloat(getComputedStyle(tabsBar).columnGap) || 0;
        const need = links.reduce((sum, a) => sum + a.offsetWidth, 0) + gap * Math.max(0, links.length - 1);
        tabsBar.classList.toggle("ns-tabs-scroll", need > tabsBar.clientWidth + 1);
    }
    document.querySelectorAll(".ns-tabs a").forEach(a => {
        const on = a.dataset.tab === name;
        a.classList.toggle("active", on);
        // 窄窗口里顶栏是一条可横滚的页签条：选中那枚必须在可视区里，
        // 否则深链进「导演」时页签滚在右边，用户看不见自己在哪一页
        if (on) a.scrollIntoView({ inline: "center", block: "nearest" });
    });
    if (name !== currentView) {
        closeHomeQuick();       // 切页收起悬浮快速入口：它钉的是上一屏的落点，留着就压在别人那一页上
        libModal?.close();      // 离开该页收起素材库弹窗（close 自己把画廊交还宿主）
        recipesModal?.close();  // 配方弹窗同一条路
        // 离开素材页：侧栏替身归位。素材页挂载画廊时把 activeSidebarTabId 写成 neo.gallery，
        // 不归位的话导演页 / 编辑页的「素材库」按钮再写同一个 id 会被去重吃掉，弹窗打不开
        const tab = app.extensionManager.sidebarTab;
        if (tab && name !== "gallery") tab.activeSidebarTabId = null;
    }
    currentView = name;
    if (name !== "agent") agentCtx.page = name;   // 智能体页不抢上下文：条上继续报上一个生成页（配方 / 绘画模式还在用）
    notifyAgentCtx();
    document.getElementById("ns-settings-btn")?.classList.toggle("ns-head-btn-on", name === "settings");
    if (name === "director" && onDirectorShown) onDirectorShown();
    if (name === "storyboard" && onStoryboardShown) onStoryboardShown();   // 内嵌编辑器在隐藏期间被单例重载路径关过：回本页补铺一次
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
        if (a.dataset.tab === "home") bindHomeQuickHover(a);
    }
}

/** 悬浮快速入口的触发就是顶栏那一格本身：鼠标落上、键盘 Tab 落上都浮出，离开与点走收起 */
function bindHomeQuickHover(tab) {
    tab.addEventListener("pointerenter", openHomeQuick);
    tab.addEventListener("pointerleave", scheduleHomeQuickClose);
    tab.addEventListener("focus", openHomeQuick);
    tab.addEventListener("blur", scheduleHomeQuickClose);
    tab.addEventListener("click", closeHomeQuick);
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
let libPendingPick = null;      // 面板经 neo:media-pick 交来的取用回调（开弹窗时消费，一次一清）
let libPendingAccept = null;    // 该回调收哪一类素材（"image" / "video"，null = 媒体全收）

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
// 写入落到素材库弹窗（取用回调由面板抢跑一步经 neo:media-pick 送来：导演的首帧 / 参考区、编辑页的参考图菜单）
function ensureLibModal() {
    if (libModal) return libModal;
    libModalHost = $el("div", { className: "ns-gallery-host", dataset: { libScope: "director" } });
    const modal = createLibraryModal({ storageKey: "neo_studio_libmodal_assets", scope: "assets" });
    modal.setContent(libModalHost);
    document.body.appendChild(modal.el);
    modal.setOnClose(() => {
        const g = app.neoGallery;
        if (g) { g.isPickMode = false; g.onSelectionChange = null; g.clearSelection(); }   // 勾选与取用模式不能带出弹窗
        app.extensionManager.sidebarTab.activeSidebarTabId = null;   // 替身侧栏归位，下次写同一 id 不被去重吃掉
        mountGallery(galleryStandby()).then(notifyAgentCtx);         // 弹窗关了：素材库不在本页上屏，画廊交还
    });
    libModal = modal;
    return modal;
}

/** 打开素材库弹窗。onPick = 点卡片 / 批量取用回调（null = 纯浏览：卡片照旧开灯箱）.
 *  accept 声明这一扇收哪一类素材（"image" / "video"，不传 = 媒体全收）：类别对不上的卡片点下去不取用。 */
function openLibModal(scope, onPick, accept) {
    const modal = ensureLibModal();
    const g = app.neoGallery;
    libScope = scope;
    libModalHost.dataset.libScope = scope;
    if (g) g.isPickMode = !!onPick;   // 取用模式：点卡片即选中，不开灯箱，不出 ⋯ 菜单；纯浏览则照旧
    if (g) g.onSelectionChange = (n) => modal.setPickCount(n);
    modal.setPickMode({
        onPick: onPick || null,
        onBulk: onPick && g ? () => {
            const keys = [...g._selectedItems];
            g.clearSelection();
            const picked = keys.map((key) => {
                const at = key.indexOf("\u0000");
                return { subfolder: key.slice(0, at), filename: key.slice(at + 1) };
            });
            // accept 那道闸只挡单点卡片这一条路，「取用已选」直连宿主自己的多选集合：批量照同一口径筛，
            // 只吃图像的槽位不会被批量塞进视频与音频
            onPick(picked.filter((p) => acceptsPick(accept || null, p.filename)));
        } : null,
        onClear: () => g?.clearSelection(),
        accept: accept || null,
    });
    modal.open(t("素材库"));
    if (galleryMountHost !== libModalHost) mountGallery(libModalHost).then(notifyAgentCtx);
    else notifyAgentCtx();
}

/** 素材库取用一次就收窗：薄页要的是那一张——抽帧与视频反推取视频，声音克隆取音频，图片反推与增强取图 */
function openMaterial(scope, accept, onPick) {
    openLibModal(scope, (picked) => {
        onPick(picked);
        libModal?.close();
    }, accept);
}

// 六张薄页的工厂在 pages/leaf-pages.js：这一处只把宿主交下去——运行闸门交 gateRunButton，
// 姿势页导出的控制图与增强页的「填入对应页」是装配层自己的两条现成链
const { buildPose, buildFrames, buildReverse, buildReverseVideo, buildVoiceClone, buildPromptEnhance } = createLeafPages({
    api, $el, toast, can,
    gateRun: gateRunButton,
    openMaterial,
    openEdit: (prefill) => openImageEditDialog(app.neoGallery, null, "", { prefill }),
    applyToPage: (mode, text) => paintEdit.applyEnhanced(mode, text),
});

onSidebarTabChange((id) => {
    // 把「侧栏写入」当开素材库弹窗用的就这三页：导演页、图片编辑页，还有故事板页——它铺的正是导演编辑器
    // 那一面，角色素材库 / 宫格图素材库走的是同一条写入，门里少了这一页，那两颗钮就是点下去没反应。
    // 生成素材页的内嵌面板自己接 neo:media-pick，不经这一条。
    if (currentView !== "director" && currentView !== "edit" && currentView !== "storyboard") return;
    if (id !== "neo.gallery") { libModal?.close(); return; }
    // 编辑页两个取用落点：参考图菜单的「素材库取用」把 addRefImages 经 neo:media-pick 交来（取的是参考图），
    // 悬浮「素材库」按钮自己交来 editPickImage（取的是原图）。回调一次一清：留着它，下一次从悬浮按钮开的
    // 弹窗会把该当原图的那张塞进参考位
    const onPick = libPendingPick || (currentView === "edit" ? paintEdit.pickImage : null);
    // 编辑页两个落点都是 <img>，视频与音频落进去就是破图；导演页照旧媒体全收（出片的参考区吃的正是视频）
    const accept = libPendingAccept || (currentView === "edit" ? "image" : null);
    libPendingPick = null;
    libPendingAccept = null;
    openLibModal(currentView, onPick, accept);
});
// 参考图菜单与导演编辑器各素材库按钮把取用回调随侧栏写入一起交来；ComfyUI 模式没有这条监听
window.addEventListener("neo:media-pick", (e) => {
    libPendingPick = e.detail?.onPick || null;
    libPendingAccept = e.detail?.accept || null;
});

// ====== 导演页：顶部条 + 上结果舞台 + 下生成坞（时间轴 / 该段 / 素材槽 / 参数行） ======
let genState = null;   // 当前整片任务 {task_id, statusEl, barEl, fillEl, runBtn, cancelBtn, media, livePlayer}
const GEN_TERMINAL = ["succeeded", "failed", "cancelled"];
const DIRECTOR_TIMELINE_H = 68;   // 时间轴净高：16px 秒刻度尺 + 4px 间距 + 42px 段块（勾选框 + 序号时长一行 + 提示词一行，两行之间露出缩略图层）+ 6px 底部留白
const DIRECTOR_ZOOM_KEY = "neo_studio.director_zoom";   // 时间轴缩放档位：跨页面重开记住（同一浏览器档位是常态）
const DIRECTOR_REF_MAX = { images: 9, videos: 3, audios: 3 };   // 与后端 _DIRECTOR_REF_CAPS 同一份
const DIRECTOR_REF_TOTAL = DIRECTOR_REF_MAX.images + DIRECTOR_REF_MAX.videos + DIRECTOR_REF_MAX.audios;
const NEW_RECIPE_BASE = "未命名配方";   // 顶栏「＋」的起手名：盘上同名配方（含预设）就往后排数字，不盖它的卡
// 全参考家族（含旧 v2v / rv2v）用参考素材那一行，帧模式（t2v / i2v / l2v / fl2v）用首帧 / 尾帧两枚：
// 判据与后端 director_spec 那条优先序同一份——整片生成模式（shared.mode）是全参考时每一段都走 ref2va，
// 其余档按这一段自己的显式模式逐段切。混配方逐段切时，隐藏的槽位不写进配方——留着上一家族的素材就是让它替模式说话
const DIRECTOR_REF_MODES = new Set(["r2v", "v2v", "rv2v"]);
const segFamily = (seg, sharedMode) => (
    DIRECTOR_REF_MODES.has(sharedMode) || DIRECTOR_REF_MODES.has(String(seg?.mode || "").trim()) ? "ref" : "frame"
);

// 实时预览落点：顶栏队列放开并发后，切配方 / 再提交都不许把正在跑那一发的预览帧掐掉，
// 所以整页只挂一条订阅，按 task_id 分发给当前这一发的播放器（node_id 就是提交时的 task_id）。
let activeLive = null;   // { task_id, apply(payload) }
api.addEventListener("rs.h3.preview", ({ detail }) => {
    if (!detail || !activeLive || String(detail.node_id) !== activeLive.task_id) return;
    activeLive.apply(detail);
});

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
        activeLive = null;   // 这一发跑完：预览帧不再往播放器上送
    }
    // 页内进度留一条紧凑状态行，生成钮不锁：这一发的进度在顶栏「队列」里跟
    barEl.style.display = task.status === "running" ? "block" : "none";
    if (task.status === "queued") {
        statusEl.textContent = tf("排队中…（{recipe}）· 顶栏「队列」看进度", { recipe: task.recipe });
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
        genState.media.replaceChildren(
            $el("video", { className: "ns-gen-preview ns-gen-final", controls: true, src: url }),
            $el("a", { className: "ns-gen-final", href: url, textContent: tf("{filename}（在浏览器中打开）", { filename: task.filename }) })
        );
        refreshRecipesPanel();
    } else if (task.status === "failed") {
        statusEl.textContent = tf("失败：{error}", { error: task.error || t("未知错误") });
    } else if (task.status === "cancelled") {
        statusEl.textContent = t("已取消");
    }
    genState.cancelBtn.style.display = (task.status === "queued" || task.status === "running") ? "" : "none";
}

let recipesPanelEl = null;
async function refreshRecipesPanel() {
    if (!recipesPanelEl || !directorPanelOpts) return;
    const parent = recipesPanelEl.parentNode;
    // 先建好再换：先摘掉旧面板的话，弹窗打开那一下列表是空的（异步取数期间整块空白闪一下）
    const next = await createRecipesPanel(directorPanelOpts());   // 导演页只列多段导演配方；点卡片 = 选中
    parent?.replaceChild(next, recipesPanelEl);
    recipesPanelEl = next;
}

let recipesHost = null;   // 配方弹窗里的配方面板宿主（buildDirector 建）

async function buildDirector(el) {
    const page = $el("div", { className: "ns-director" });
    el.appendChild(page);

    let recipeItems = [];    // 导演配方列表（listRecipes 条目：含 segments / shared / story / setup / assets / source）
    let recipe = null;       // 当前配方的整份数据：保存时把没动的字段原样带回去
    let spec = null;         // director_spec：每段有效模式，与解析进 input/ 的首帧 / 尾帧 / 参考素材名
    let currentName = "";
    let selected = 0;
    let tlProgress = { active: false, segment_index: -1, total_segments: 0 };
    let checkedSegments = [];
    let directorSkills = [];   // 视频技能列表：每段「模板收哪几类参考素材」与技能胶囊那一列都读它
    let skillPick = null;      // 本次动过的统一技能：没动过就一段都不写、shared.mode 也不动
    const segs = () => recipe?.segments || [];
    const isPreset = () => recipe?.source === "preset";
    const skillMeta = (id) => directorSkills.find((s) => s.id === id) || null;
    // 整片生成模式：本次选过技能就以它所属那一组为准，没选就回落到配方里钉的 shared.mode（旧值静默重映射）。
    // 旧混配方留在这页的 mixed 落在这一步：素材槽与分块秒数照旧逐段按该段自己钉的模式切。
    const sharedGenMode = () => {
        if (skillPick !== null) return videoModeGroup(skillMeta(skillPick));
        const m = recipe?.shared?.mode;
        return LEGACY_MODE_MAP.get(m) || m || "";
    };
    // 段落的增删改与「保存该段」走 director.js 那份共享实现（出片视图后面要嵌进画布，同一套语义）：
    // 脏标记记在 ops 里，页面上「未保存」只有保存钮这一处要亮
    const ops = createSegmentOps(() => recipe, {
        onChange: () => saveBtn.classList.add("ns-director-dirty"),
        readOnly: isPreset,
    });

    // --- 顶部条：左端 配方管理（卡片弹窗）· ＋（本页落一份新配方），右端 素材库 · 高级模式（整片编辑器浮层） ---
    recipesHost = $el("div", { className: "ns-director-recipes" });
    recipesModal = createLibraryModal({ storageKey: "neo_studio_libmodal_recipes", scope: "recipes" });
    recipesModal.setContent(recipesHost);
    document.body.appendChild(recipesModal.el);
    // 换配方只有这一颗：弹窗里点卡片 = 选中喂给本页。顶栏不再挂一份同样的配方下拉——同一页两个入口选同一件事
    const recipesBtn = $el("button", { className: "ns-btn", type: "button", title: t("打开配方管理：点卡片选中，含复制 / 删除 / 新增") });
    setIconLabel(recipesBtn, "list", t("配方管理"));
    recipesBtn.onclick = () => { recipesModal.open(t("导演配方")); refreshRecipesPanel(); };
    const newBtn = $el("button", { className: "ns-btn ns-director-new", type: "button", title: t("新建一份分镜视频导演配方：就在本页落一段，写完「保存该段」写回") });
    setIcon(newBtn, "plus", 15);
    newBtn.onclick = () => startNewRecipe();
    const libBtn = $el("button", { className: "ns-btn", type: "button", title: t("打开素材库：看大图与取用") });
    setIconLabel(libBtn, "folder", t("素材库"));
    libBtn.onclick = () => openLibModal("director");
    const editorBtn = $el("button", { className: "ns-btn", type: "button", title: t("高级模式：整片编辑器浮层（分段增删、生成模式与分辨率、故事板与提示词工具）") });
    setIconLabel(editorBtn, "film", t("高级模式"));
    editorBtn.onclick = () => openEditor();
    page.appendChild($el("div", { className: "ns-director-bar" }, [
        recipesBtn, newBtn, $el("span", { className: "ns-director-bar-space" }), libBtn, editorBtn,
    ]));

    // --- 结果舞台：idle 起手卡 / 实时预览 / 成片，下面一条状态行 + 进度 ---
    const idleCard = $el("div", { className: "ns-director-idle-card neo-gallery-gm-idle" }, [
        $el("div", { className: "neo-gallery-gm-idle-title", textContent: t("导演视频") }),
        $el("div", { className: "neo-gallery-gm-idle-sub", textContent: t("选一份配方，勾要跑的段，然后生成整片") }),
        $el("i", { className: "ns-video-corner c-tl" }),
        $el("i", { className: "ns-video-corner c-tr" }),
        $el("i", { className: "ns-video-corner c-bl" }),
        $el("i", { className: "ns-video-corner c-br" }),
    ]);
    const liveBox = $el("div", { className: "ns-director-live neo-dtl-live" });
    const media = $el("div", { className: "ns-director-media ns-director-idle" }, [idleCard, liveBox]);
    const livePlayer = createFramePlayer(liveBox, () => {
        liveBox.style.height = "";                       // 高度交给 CSS：结果区按配方的画面比例贴
        media.classList.remove("ns-director-idle");      // 预览一有画面就占住结果区，idle 卡让位
    });
    const statusEl = $el("div", { className: "ns-director-status" });
    const barEl = $el("div", { className: "ns-gen-progress ns-director-progress" }, [$el("div")]);
    const statusRow = $el("div", { className: "ns-director-statusrow" }, [statusEl, barEl]);
    // 舞台只剩画面一块：状态行搬进生成坞卡顶，起手的空带不再由它顶出来
    page.appendChild($el("div", { className: "ns-director-stage" }, [media]));

    // --- 生成坞：紧凑时间轴（勾选 = 本次跑哪几段）+ 该段（时长 / 提示词）+ 素材槽 + 参数行 ---
    const timelineHost = $el("div", { className: "ns-director-timeline" });
    const checkHint = $el("span", { className: "ns-director-checkhint" });
    const promptIn = $el("textarea", { className: "ns-director-prompt neo-gallery-gm-quick-input", rows: "1", spellcheck: "false", placeholder: t("这一段要拍成什么样…") });
    const firstSlot = createMediaSlot({ label: "首帧", thumbSrc: inputThumbSrc, toast, pick: slotPick, refKinds: () => segRefKinds(selected), onChange: slotChanged });
    const lastSlot = createMediaSlot({ label: "尾帧", thumbSrc: inputThumbSrc, toast, pick: slotPick, refKinds: () => segRefKinds(selected), onChange: slotChanged });
    const refSlot = createMediaSlot({ label: "参考素材", multiple: true, maxN: DIRECTOR_REF_TOTAL, kindMax: DIRECTOR_REF_MAX, thumbSrc: inputThumbSrc, toast, pick: slotPick, refKinds: () => segRefKinds(selected), onChange: slotChanged });

    // 「技能」胶囊就是视频页那一枚 skillParamsChip：左栏技能按生成模式分组（关键帧生视频 / 全参考生视频），
    // 右栏是本次整片的模型链覆盖（主模型 / Text Encoder / VAE / 音频 VAE / LoRA / 步数，留空 = 该段跟随自己的技能配置）。
    // 选中的技能是整片要统一成的那一个，它所属那一组就是生成模式。
    // 配方里每段本就自带技能，本页选的是要把它们统一成哪一个——所以改动只记在页面上，落盘走「保存该段」那一条链。
    const skillSel = $el("select", { className: "ns-director-skill", title: t("技能与自定参数：左栏选整片统一的技能（它所属那一组就是生成模式），点它就把右栏铺成该技能钉的模型链；右栏主模型 / LoRA 留空 = 各段跟随自己的技能配置") });
    skillSel.appendChild($el("option", { value: "", textContent: t("（加载视频技能…）") }));
    const videoCfg = createVideoModelConfigSection();
    let videoModels = null;   // 模型清单：没拉到就整块不发覆盖值，各段技能配置照常生效
    const videoParamsBox = $el("div", { className: "neo-gallery-gm-model-box" }, [videoCfg.el]);
    const skillChip = skillParamsChip(skillSel, videoParamsBox, {
        icon: "film",
        groupOf: videoModeGroup,
        groupLabels: VIDEO_GROUP_LABELS,
        getOverride: () => videoModels ? videoCfg.collect() : {},
        panelClass: "ns-director-compact-form ns-director-skill-panel",
    });
    videoParamsBox.addEventListener("change", () => skillChip.sync());
    // 换技能 = 右栏整份换成该技能 config 钉的那一套（与视频页、绘画页同一语义）：面板里看到的就是这一发真要跑的模型链。
    // 技能没钉配置（config 是空的）就是清空回「自动」：这一发跟着各段自己的技能配置跑。
    async function applySkillParams(skillId) {
        if (!videoModels) return;
        if (!skillId) {
            videoCfg.load({}, videoModels);
            skillChip.sync();
            return;
        }
        videoCfg.load(await getSkillGenConfig(skillId), videoModels);
        skillChip.sync();   // 程序改 value 不触发 change：chip 上那行生效值要跟着重读
    }
    skillSel.addEventListener("change", () => {
        applySkillParams(skillSel.value);
        if (skillSel.value === skillPick) return;
        skillPick = skillSel.value;
        markDirty();
        renderSegment();   // 生成模式跟着换：该段素材槽那一行与分辨率胶囊上的模式名都要翻面
    });

    // 技能那一列 = 本页的视频技能清单；选中值回落到配方首段钉的技能，各段钉的不是同一个也落首段那一枚。
    // 本页只有一条统一口径：不动这一列就一直不写段，各段照跑自己钉的技能；要点一行技能再「保存该段」才铺满每一段
    function syncSkillChip() {
        const list = directorSkills;
        const first = segs()[0]?.skill_id || "";
        skillSel.textContent = "";
        for (const s of list) {
            // 特效技能缺 LoRA 时后端把 available 判成 false（skill._video_skill_available），列里要说出来
            const opt = $el("option", { value: s.id, textContent: skillDisplayName(s) + (s.available === false ? t("（不可用）") : "") });
            opt.__skillMeta = s;   // 分组与 chip 标签取这份元数据（视频页技能面板同一约定）
            skillSel.appendChild(opt);
        }
        skillPick = null;
        skillSel.value = list.some((s) => s.id === first) ? first : (list[0]?.id || "");
        skillChip.sync();   // 技能与选中态都是程序改的，chip 显示的生效值要跟着重读
        applySkillParams(skillSel.value);   // 程序铺的选中值同样铺该技能钉的模型链：清单没到就整块不动，下面 modelsReady 那一路补
    }

    // 该段「⋯」菜单：重生成 / 复制 / 前移 / 后移 / 删除。增删改本身在 director.js 那份共享实现里，页面只出这一条入口
    const segMenuItem = (label, tip, fn) => $el("button", { className: "ns-btn", type: "button", textContent: t(label), title: t(tip), onclick: () => { segMenuClose(); fn(); } });
    // 重生成该段：段菜单直接进编辑器展开该段的重生成面板。那枚 ♻ 画在高级模式的段行里，
    // 时间轴上看到哪段想重跑，不该让用户先点高级模式、再在整片编辑器里找那一行
    const regenItem = segMenuItem("重生成该段", "打开高级模式编辑器并展开该段的重生成面板：锚点取成片里该段前后的真实帧，换种子单跑这一段", () => {
        if (!currentName) { toast(t("先选一份导演配方")); return; }
        openDirectorEditor(findItem(currentName) || { name: currentName }, afterEditorSaved, selected,
            { onSaveAndRun: () => submitGenerate(), openRegen: true });
    });
    regenItem.classList.add("ns-director-segmenu-regen");   // RUN_GATES 认这个类：窗口翻回离线形态时这一项跟着收口
    gateRunButton(regenItem, "segment", t("重生成该段"));
    // 基座 .rs-runtime-menu 给 fixed 定位：.neo-gallery-gm-chip-menu / -panel 只出宽度与滚动，
    // 少了基座这块就是页面流里的一块，下面按 ⋯ 的 rect 算出的 left/top 全部无效（菜单落在页面最左、压住首帧方块）
    const segMenuPanel = $el("div", { className: "rs-runtime-menu neo-gallery-gm-chip-menu neo-gallery-gm-chip-panel ns-director-segmenu" }, [
        regenItem,
        segMenuItem("复制该段", "把该段的提示词 / 时长 / 素材整份复制到下面一段", () => {
            const at = ops.duplicate(selected);
            if (at < 0) return;
            dropStaleTails();
            timeline.refresh();
            selectSegment(at);
        }),
        segMenuItem("前移一段", "该段往前挪一位", () => {
            if (!ops.move(selected, -1)) return;
            dropStaleTails();
            timeline.refresh();
            selectSegment(selected - 1);
        }),
        segMenuItem("后移一段", "该段往后挪一位", () => {
            if (!ops.move(selected, 1)) return;
            dropStaleTails();
            timeline.refresh();
            selectSegment(selected + 1);
        }),
        segMenuItem("删除该段", "删除该段（素材文件留在配方里，不删文件）", () => {
            const n = segs().length;
            if (n <= 1) { toast(t("最后一段不能删：整片至少留一段")); return; }
            if (!confirm(tf("删除第 {n} 段？该段的素材文件留在配方里，不删文件。", { n: selected + 1 }))) return;
            ops.remove(selected);
            dropStaleTails();
            checkedSegments = [];
            timeline.clearChecked();
            renderCheckHint();
            timeline.refresh();
            selectSegment(Math.min(selected, n - 2));
        }),
    ]);
    page.appendChild(segMenuPanel);
    let segMenuOpen = false;
    const segMenuClose = () => { segMenuOpen = false; segMenuPanel.style.display = "none"; };
    // 时间轴段块右上角那枚「⋯」点出来的菜单：弹在那枚 glyph 旁边（上方放得下就朝上，否则朝下，右边夹进窗口）。
    // 菜单五项都作用在「选中那段」上，所以先把点的那块选中——这一页只有段块右上角这一条段操作入口
    function openSegMenu(i, rect) {
        if (!rect) return;
        selectSegment(i);
        segMenuOpen = true;
        segMenuPanel.style.display = "block";
        const pw = segMenuPanel.offsetWidth || 190;
        const ph = segMenuPanel.offsetHeight || 130;
        segMenuPanel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8))}px`;
        const above = rect.top - ph - 6;
        segMenuPanel.style.top = `${above > 8 ? above : rect.bottom + 6}px`;
    }

    // 「分辨率」胶囊弹的是共享的整片参数表单（createSharedConfigSection）：页内改分辨率与运行参数 + 分块秒数，
    // 保存走「保存该段」同一条 ops 链。生成模式不在表单里（它是技能胶囊那一列的事）；分块秒数要看当前生效技能
    // 支不支持多帧，技能由本页交进来——表单不自己拉技能清单
    const sharedCfg = createSharedConfigSection(() => (sharedGenMode() === "mixed" ? null : skillMeta(skillPick ?? segs()[0]?.skill_id)));
    const sizeSaveBtn = $el("button", { className: "rs-btn ns-director-size-save", type: "button", textContent: t("保存整片参数") });
    const sizePanel = $el("div", { className: "rs-runtime-menu neo-gallery-gm-chip-menu neo-gallery-gm-chip-panel ns-director-compact-form ns-director-size-panel" }, [sharedCfg.el, sizeSaveBtn]);
    page.appendChild(sizePanel);
    let sizeOpen = false;
    const sizeClose = () => { sizeOpen = false; sizePanel.style.display = "none"; };
    const sizePos = () => {
        const r = sizeBtn.getBoundingClientRect();
        sizePanel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - sizePanel.offsetWidth - 8))}px`;
        const above = r.top - sizePanel.offsetHeight - 6;
        sizePanel.style.top = `${above > 8 ? above : r.bottom + 6}px`;
    };
    sizeSaveBtn.onclick = async () => {
        if (!currentName || isPreset()) { statusEl.textContent = t("内置预设配方只读：先「复制配方」才能改"); return; }
        recipe.shared = { ...(recipe.shared || {}), ...sharedCfg.collect() };
        markDirty();
        sizeClose();
        await saveRecipeNow();
    };


    const sizeGlyph = ratioGlyph();
    const sizeLabel = $el("span", { className: "neo-gallery-gm-chip-label" });
    const sizeBtn = $el("button", { className: "neo-gallery-gm-chip-btn ns-director-size", type: "button", title: t("整片参数（宽高比 / 百万像素 / 种子 / 连续性 / 上下文帧 / 角色身份参考 / 分块秒数）：页内改，保存写回配方") }, [sizeGlyph.el, sizeLabel]);
    sizeBtn.onclick = () => {
        if (!currentName) { toast(t("先选一份导演配方")); return; }
        sizeOpen = !sizeOpen;
        sizePanel.style.display = sizeOpen ? "block" : "none";
        if (!sizeOpen) return;
        sharedCfg.load(recipe.shared || {}, segs());   // 段数决定「分块秒数」露不露，首段的技能是统一技能的起手选中
        sizePos();
    };
    const saveBtn = $el("button", { className: "ns-btn ns-director-save", type: "button", textContent: t("保存该段"), title: t("把该段的提示词 / 时长 / 素材槽改动写回配方（不新增段，也不动故事板与分辨率）") });
    // 主行动就写「生成」：跑哪几段是时间轴勾选取与下面那条提示行的事，按钮上不替它说那句长文案
    const runBtn = $el("button", { className: "rs-btn ns-gen-run ns-director-run", type: "button", textContent: t("生成") });
    gateRunButton(runBtn, "director", t("生成"));
    const cancelBtn = $el("button", { className: "rs-btn ns-gen-cancel", type: "button", textContent: t("取消"), style: { display: "none" } });
    // 时间轴缩放：一屏放不下多段时的唯一压缩手段（块宽按时长分配，缩一档就能多看几段）。
    // 档位存在 localStorage——每次进导演页都回到上次那一档
    const zoomBtn = (label, tip, fn) => {
        const b = $el("button", { className: "ns-director-zoom", type: "button", textContent: label, title: t(tip) });
        b.onclick = fn;
        return b;
    };
    const zoomRow = $el("div", { className: "ns-director-zoomrow" }, [
        zoomBtn(t("适应"), "时间轴铺满一屏，缩放回到 1 倍", () => directorZoom(1)),
        zoomBtn("−", "缩小时间轴：一屏看更多段", () => directorZoom(timeline.getZoom() - 0.25)),
        zoomBtn("＋", "放大时间轴：横向滚动看细节", () => directorZoom(timeline.getZoom() + 0.25)),
    ]);
    const hintRow = $el("div", { className: "ns-director-hintrow" }, [checkHint, zoomRow]);
    page.appendChild($el("div", { className: "ns-director-dock" }, [
        $el("div", { className: "ns-director-card neo-gallery-gm-composer" }, [
            statusRow,
            timelineHost,
            hintRow,
            // 方块在左、该段的提示词吃剩下的宽度：段号与秒数不再在这块重复一遍，时间轴块左上就是「第 N 段 · Xs」
            $el("div", { className: "ns-director-main" }, [
                $el("div", { className: "ns-director-segrow" }, [
                    $el("div", { className: "ns-director-slots" }, [firstSlot.el, lastSlot.el, refSlot.el]),
                ]),
                promptIn,
            ]),
            $el("div", { className: "ns-director-controls neo-gallery-gm-composer-bar neo-gallery-gm-chips" }, [
                skillChip.el, sizeBtn, saveBtn,
                $el("div", { className: "neo-gallery-gm-composer-gap" }),
                cancelBtn, runBtn,
            ]),
        ]),
    ]));

    const timeline = new DirectorTimeline(timelineHost, {
        height: DIRECTOR_TIMELINE_H,
        checkable: true,
        getSegments: () => segs().map((s, i) => ({
            duration: Number(s.duration_sec) || 5,
            prompt: s.prompt || "",
            thumbUrl: specThumb(i),
        })),
        onSelect: (i) => { selected = i; renderSegment(); },   // 画布点块：画布自己已落选中态，这里只刷该段面板（不得回调 select，会成环）
        onCheckChange: (list) => { checkedSegments = list; renderCheckHint(); },
        onSegMenu: (i, rect) => openSegMenu(i, rect),   // 块右上角「⋯」→ 该段操作菜单弹在那枚 glyph 旁边
        onReorder: (order) => reorderSegs(order),
        onResize: (i, sec) => {
            const s = segs()[i];
            if (!s) return;
            s.duration_sec = sec;
            markDirty();
            timeline.refresh();
            renderSegment();
        },
        onAdd: () => addSeg(),
        getProgress: () => tlProgress,
    });
    function directorZoom(z) {
        const v = Math.max(0.25, Math.min(4, Math.round(z * 100) / 100));
        localStorage.setItem(DIRECTOR_ZOOM_KEY, String(v));
        segMenuClose();
        timeline.setZoom(v);
    }
    timeline.setZoom(Number(localStorage.getItem(DIRECTOR_ZOOM_KEY)) || 1);
    // 横向滚动与换档位都会把段块连同那枚 ⋯ 挪走：菜单弹在 glyph 旁边，跟着一起收，不许脱离它
    timeline.scroll.addEventListener("scroll", segMenuClose);
    // 提示词框一行起步、随内容长到 20vh 上限（与 CSS 的 max-height 同一档）。
    // 无布局引擎的环境（jsdom）里 scrollHeight 恒为 0，这时不写内联高度，留给 CSS 的 min-height。
    // 框是 border-box 且带 1px 描边：scrollHeight 只量到内容加内衬，边框那 2px 要在这一发补给框高，
    // 否则最后一行的下沿被描边裁进框内自滚的竖线里
    function growPrompt() {
        promptIn.style.height = "auto";
        if (promptIn.scrollHeight > 0) {
            promptIn.style.height = Math.min(promptIn.scrollHeight + 4, Math.round(window.innerHeight * 0.2)) + "px";
        }
    }
    const onDocPress = (e) => {
        if (!document.body.contains(page)) { document.removeEventListener("pointerdown", onDocPress, true); return; }
        skillChip.closeOnOutside(e.target);
        if (segMenuOpen && !segMenuPanel.contains(e.target)) segMenuClose();
        if (sizeOpen && !sizePanel.contains(e.target) && !sizeBtn.contains(e.target)) sizeClose();
    };
    document.addEventListener("pointerdown", onDocPress, true);


    function specThumb(i) {
        const s = spec?.segments?.[i];
        const name = s?.keyframe || s?.ref_input || (s?.refs?.images || [])[0] || "";
        return name ? inputThumbSrc(name) : "";
    }
    const renderCheckHint = () => {
        checkHint.textContent = checkedSegments.length
            ? tf("仅运行勾选的 {n} 段：[{list}]", { n: checkedSegments.length, list: checkedSegments.map((i) => i + 1).join(",") })
            : t("未勾选 = 生成整片 · 点时间轴块左上角勾选");
    };
    function markDirty() { ops.markDirty(); }
    function clearDirty() { ops.clearDirty(); saveBtn.classList.remove("ns-director-dirty"); }
    function selectSegment(i) { timeline.select(i); }   // 走画布：落选中态后由 onSelect 刷该段面板

    // 该段控件：模式决定素材槽显哪一组，隐藏的槽位不写进配方（后端按资产推模式，留旧素材就是推错）
    function renderSegment() {
        const s = segs()[selected];
        const fam = segFamily(s, sharedGenMode());
        skillChip.chip.disabled = !s || isPreset();   // 预设只读与没有配方：统一技能这枚胶囊不给动
        // 段号与秒数不在这里重复：时间轴块左上就是「第 N 段 · Xs」，右缘一拖就改时长
        promptIn.value = s?.prompt || "";
        promptIn.disabled = !s || isPreset();
        growPrompt();
        firstSlot.el.classList.toggle("ns-hidden", fam !== "frame");
        // 尾帧只给最后一段：中间段钉一张尾帧，接的是下一段的开头，接不上（整片模式 renumberSegs 同一条规矩）
        lastSlot.el.classList.toggle("ns-hidden", fam !== "frame" || !isLastSeg());
        refSlot.el.classList.toggle("ns-hidden", fam === "frame");
        firstSlot.setReadOnly(isPreset());
        lastSlot.setReadOnly(isPreset());
        refSlot.setReadOnly(isPreset());
        fillSlots(s);
    }

    // 「最后一段」这一身份会随增删与重排移动，所以它是个问句不是一份状态
    const isLastSeg = () => selected >= segs().length - 1;

    // 段从最后位置下来，它那份尾帧必须跟着清：后端是按素材推生成模式的，留着就推成首尾帧，
    // 跑的却是一个界面上再也改不到的框。增删改顺序五个入口共用这一发
    function dropStaleTails() {
        let stale = false;
        for (const s of segs().slice(0, -1)) {
            if (s && s.last_frame) { delete s.last_frame; stale = true; }
        }
        if (stale) markDirty();
    }

    // 槽位里的画面用 director_spec 那份（素材已从配方 assets/ 解析进 input/）；spec 没到就退回配方里记的名
    function fillSlots(s) {
        const sp = spec?.segments?.[segs().indexOf(s)];
        firstSlot.fill(sp ? [sp.ref_input] : [s?.first_frame]);
        lastSlot.fill(sp ? [sp.last_input] : [s?.last_frame]);
        const rf = sp?.refs || s?.refs || {};
        refSlot.fill([...(rf.images || []), ...(rf.videos || []), ...(rf.audios || [])]);
    }

    function slotChanged() {
        const s = segs()[selected];
        if (!s) return;
        if (segFamily(s, sharedGenMode()) === "frame") {
            const f = firstSlot.first()?.value;
            // 非最后一段不认尾帧：那一格是藏着的，旧值也不许从槽里写回配方（藏着的槽不许写进配方）
            const l = isLastSeg() ? lastSlot.first()?.value : null;
            if (f) s.first_frame = f; else delete s.first_frame;
            if (l) s.last_frame = l; else delete s.last_frame;
        } else {
            const picked = refSlot.get();
            const refs = {};
            for (const [media, key] of [["image", "images"], ["video", "videos"], ["audio", "audios"]]) {
                const vals = picked.filter((x) => x.media === media).map((x) => x.value);
                if (vals.length) refs[key] = vals;
            }
            if (Object.keys(refs).length) s.refs = refs; else delete s.refs;
        }
        markDirty();
        timeline.refresh();
    }

    // 素材方块取用与视频页同一条路：素材库弹窗点卡片 → copy_to_input 落进 input 根目录，
    // 返回加载节点可用的文件名；保存时这份名字进配方 assets/，重开时 spec 又把它解析回 input/
    function slotPick({ accept, multiple: keepOpen, gate, add }) {
        openLibModal("director", async (picked) => {
            const ok = gate(picked);   // 先过闸：挡下的不 copy_to_input，input 目录不留用不上的文件
            const filled = [];
            for (const a of ok) {
                try { filled.push({ ...a, value: await copyPickedToInput(a.src) }); }
                catch (e) { toast(tf("取用素材失败：{msg}", { msg: e.message })); }
            }
            add(filled);
            if (!keepOpen) libModal?.close();   // 首帧 / 尾帧取一张即收窗；参考素材留着弹窗好连选
        }, accept);
    }

    function segRefKinds(i) { return skillMeta(segs()[i]?.skill_id)?.gen_config?.ref_kinds || null; }

    function addSeg() {
        const at = ops.add();
        if (at < 0) return;
        dropStaleTails();   // 新段成了最后一段：原来那段不再是最后，它的尾帧要跟着清
        timeline.refresh();
        selectSegment(at);
    }

    function reorderSegs(order) {
        if (!ops.reorder(order)) return;   // 顺序表不完整时 ops 不动配方：这次拖拽丢掉，不留少一段的配方
        dropStaleTails();
        checkedSegments = [];
        timeline.clearChecked();
        renderCheckHint();
        timeline.refresh();
        selectSegment(Math.min(selected, Math.max(0, segs().length - 1)));
    }


    const findItem = (name) => recipeItems.find((r) => r.name === name) || null;
    async function refreshRecipeItems() {
        try { recipeItems = (await listRecipes()).filter((r) => r.type === "video_director"); }
        catch { recipeItems = []; }   // 离线模式 / ComfyUI 未就绪：列表拿不到就留着现有那一份
    }

    function openEditor(opts = null) {
        if (!currentName) { toast(t("先选一份导演配方")); return; }
        // 编辑器全窗口只有一份：故事板页把同一份配方内嵌在自己那一页时，先让它让位再开浮层。
        // 那一面有未保存修改时让位失败（确认条长在隐藏的视图里点不到，静默关窗就是丢改动），这一发就此收住。
        if (storyboardReleaseEditor?.() === false) return;
        // 编辑器是浮层（桌面端不再内嵌宿主）：底部「保存并生成整片」保存成功后交本页直接提交
        openDirectorEditor(findItem(currentName) || { name: currentName }, afterEditorSaved, selected, { onSaveAndRun: () => submitGenerate(), ...opts });
    }
    async function afterEditorSaved() {
        await refreshRecipeItems();
        await openRecipe(currentName);
    }

    // 顶栏「＋」与配方管理里的「新增导演配方」都在本页落：一段空段起手，整片参数取本页那张表单的
    // 默认口径，一次 ops.save 落盘——生成整片、素材槽取用、director_spec 回显从这一刻起全部可用，
    // 页上也因此只有「已落盘的配方」这一种状态，不给未落盘的草稿开第二条写路径。
    // 不想要就在配方管理里用那张卡自己的「删除」删掉（单件入口，页上不铺清空动作）。
    async function startNewRecipe() {
        const name = newRecipeName();
        recipe = {
            name, type: "video_director", source: "user", prompt: "", assets: [], loras: [],
            // 首段钉默认技能（关键帧家族里步数最少的可用技能，与后端 _default_video_skill 同口径）；
            // 技能清单还没到就是空串——后端认段级 skill_id，起手不靠整片生成模式替它说话
            segments: [{ skill_id: defaultVideoSkill(directorSkills), prompt: "", duration_sec: 5 }],
        };
        sharedCfg.load({}, segs());   // 整片参数从表单默认起，不带上一份配方刚落盘的那一份
        recipe.shared = sharedCfg.collect();
        currentName = name;
        selected = 0;
        checkedSegments = [];
        timeline.clearChecked();
        renderCheckHint();
        syncSkillChip();   // 胶囊回显首段钉的那一枚：清单没到就整块不动，listVideoSkills 那一路到了会补一次
        markDirty();
        if (!await saveRecipeNow()) {
            // 落盘失败（离线 409 / 后端报错）：页上不许钉着一份盘上不存在的配方，退回「没有配方」那一面
            recipe = null;
            currentName = "";
            checkedSegments = [];
            clearDirty();
            await loadSpec();   // 尺寸胶囊 / 时间轴 / 该段槽位一起回空白
            return;
        }
        statusEl.textContent = tf("已新建配方 {name}：写提示词、取首帧，「保存该段」写回", { name });
        await refreshRecipesPanel();   // 保存链只刷本页；管理弹窗里那份面板得单独长出新卡
        promptIn.focus();
    }

    // 起手名往后排数字，不盖盘上的同名配方：配方管理里那张同名卡不该被一次新建悄悄改掉（预设同名后端 409 挡）
    function newRecipeName() {
        const taken = new Set(recipeItems.map((r) => r.name));
        let name = NEW_RECIPE_BASE;
        for (let i = 2; taken.has(name); i++) name = `${NEW_RECIPE_BASE}${i}`;
        return name;
    }

    // 每段的有效模式与素材名要 director_spec 那份（配方 assets/ 里的文件已复制进 input/）。
    // 启动时导演页是隐藏的：spec 逐文件同步复制，桌面端一个事件循环上会把首页 list 挤到几秒后，
    // 所以隐藏期间不拉，进本页由 onDirectorShown 补一次
    async function loadSpec() {
        spec = null;
        if (currentName && currentView === "director") {
            try {
                const r = await api.fetchApi(`/rs_recipes/director_spec?name=${encodeURIComponent(currentName)}`);
                const d = r.ok ? await r.json() : null;
                if (d?.success) spec = d;
            } catch { /* ComfyUI 未就绪时保持空白：槽位退回配方里记的名 */ }
        }
        applySpec();
    }
    function applySpec() {
        const d = spec?.defaults;
        sizeLabel.textContent = d ? `${d.width}×${d.height}` : "";
        if (d) sizeGlyph.sync(`${d.width}:${d.height}`);
        media.style.setProperty("--ns-gen-ratio", d ? `${d.width} / ${d.height}` : "");
        media.style.setProperty("--ns-gen-ar", d ? String(d.width / d.height) : "");
        timeline.refresh();
        renderSegment();
    }

    async function openRecipe(name, opts = {}) {
        name = String(name || "").trim();
        if (!name) return;
        let d = null;
        try {
            const r = await api.fetchApi("/rs_recipes/load", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
            });
            d = await r.json().catch(() => null);
            if (!r.ok || !d?.success) throw new Error(String(d?.error || r.status));
        } catch (e) {
            statusEl.textContent = tf("配方读取失败：{msg}", { msg: e.message });
            return;
        }
        recipe = d.recipe || null;
        currentName = recipe?.name || name;
        selected = 0;
        checkedSegments = [];
        timeline.clearChecked();
        renderCheckHint();
        clearDirty();
        timeline.opts.readOnly = isPreset();   // 预设配方：时间轴不能加段 / 拖时长 / 重排
        saveBtn.disabled = isPreset();
        timeline.setSegMenuOps(isPreset() ? null : openSegMenu);   // 预设只读：段菜单四项没有一项能用，块右上角不出 ⋯
        saveBtn.title = isPreset() ? t("内置预设配方只读：先「复制配方」才能改") : t("把该段的提示词 / 时长 / 素材槽改动写回配方（不新增段，也不动故事板与分辨率）");
        recipesPanelEl?.__neoRecipesPanel?.select(currentName);   // 卡片高亮跟着本页的选中配方挪（配方管理里点卡片 / 保存后重读）
        // 「保存该段」后的重读要留着那句「已保存」：重读是把刚落盘的结果刷回界面，不是开一份新配方
        const presetNote = isPreset() ? t("内置预设配方只读：想改这一片就先「复制配方」") : "";
        statusEl.textContent = presetNote || (opts.keepStatus ? statusEl.textContent : "");
        syncSkillChip();   // 技能胶囊回到这份配方钉的技能：各段钉的不是同一个就落首段那一枚
        await loadSpec();
        selectSegment(0);
        agentCtx.recipe = currentName;      // 智能体上下文：默认围绕这一份配方出片
        agentCtx.segments = segs().length;  // 要报得出这份配方有几段
        notifyAgentCtx();
    }

    // 保存只发本次新取用的素材与改动后的段：既有资产与结果历史由后端按盘上现状保留
    // 「保存该段」与「保存整片参数」共用这一条链：ops.save 落盘，重读把刚落盘的结果刷回界面
    async function saveRecipeNow() {
        if (!currentName) { statusEl.textContent = t("请先选一份导演配方"); return false; }
        if (isPreset()) { statusEl.textContent = t("内置预设配方只读：先「复制配方」再改"); return false; }
        // 技能胶囊动了才写段：整片生成模式落 shared.mode，选中的技能经 applySkill 写进每一段 skill_id
        if (skillPick !== null) {
            recipe.shared = { ...(recipe.shared || {}), mode: videoModeGroup(skillMeta(skillPick)) };
            ops.applySkill(skillPick);
        }
        saveBtn.disabled = true;
        try {
            const res = await ops.save(currentName);
            if (!res?.success) { statusEl.textContent = tf("保存失败：{msg}", { msg: res?.error || t("未知错误") }); return false; }
            clearDirty();
            statusEl.textContent = tf("已保存：{name}（{n} 段）", { name: currentName, n: segs().length });
            await refreshRecipeItems();
            // 落盘后素材名可能被后端改名（重名让位）：重读配方与 spec，槽位与时间轴缩略图跟着换
            await openRecipe(currentName, { keepStatus: true });
            return true;
        } catch (e) {
            statusEl.textContent = tf("保存失败：{msg}", { msg: e.message });
            return false;
        } finally {
            saveBtn.disabled = isPreset();
        }
    }
    saveBtn.addEventListener("click", () => saveRecipeNow());


    // setGen 只在「提交成功」之后调用：WS 事件为主、轮询兜底。提交失败不挂订阅也不起轮询——
    // 那会在每次重开本页时按盘上的旧 task_id 白白发请求
    function setGen(task) {
        genState = {
            task_id: task.task_id, statusEl, barEl, fillEl: barEl.firstElementChild,
            runBtn, cancelBtn, media, pollTimer: null,
            done: false, terminal: false, lastPreviewStep: 0,   // done：成片只替换一次；terminal：终态已落地，旧载荷一律作废；lastPreviewStep：预览帧按步号单调推进（WS / 轮询同源）
            livePlayer,   // 终态时定格在最后一帧
            onTerminal: () => { tlProgress = { active: false, segment_index: -1, total_segments: 0 }; timeline.refresh(); },
        };
        api.addEventListener("rs.director.status", onStatusEvent);
        activeLive = { task_id: task.task_id, apply: applyPreview };   // 这一发的预览帧从此刻起进这个播放器
        // WS 事件为主，轮询兜底（页面晚于任务打开 / 断线重连窗口）
        const poll = async () => {
            try {
                const r = await api.fetchApi(`/neo_studio/director/${task.task_id}`);
                const st = await r.json();
                // 终态由 WS 先到时，这次在途轮询的旧载荷不得把界面拉回生成中（进度条 / 取消按钮 / 段高亮会复活）
                if (!genState || genState.terminal) return;
                if (st?.success) {
                    updateGenStatus(st);
                    if (GEN_TERMINAL.includes(st.status)) stopPolling();
                    applyPreview(st.latest_preview);   // 轮询兜底：WS 断档期间没有帧，取后端最新一帧
                }
                // 分段进度：与画布节点同源，时间轴据此高亮正在跑的段并跟到那一格
                const p = await api.fetchApi("/neo_video_gen/director_progress");
                const d = await p.json();
                if (d && typeof d.active === "boolean") {
                    tlProgress = d;
                    timeline.refresh();
                    timeline.revealSeg(d.segment_index);
                }
            } catch { /* 网络抖动忽略，下一轮再试 */ }
        };
        genState.pollTimer = setInterval(poll, 2000);
        updateGenStatus(task);
    }


    function stopPolling() {
        if (genState && genState.pollTimer) clearInterval(genState.pollTimer);
        api.removeEventListener("rs.director.status", onStatusEvent);
    }
    function onStatusEvent({ detail }) {
        if (!detail || !detail.task_id) return;
        updateGenStatus(detail);
        // 终态即停轮询（WS 与下方轮询兜底两条路都覆盖，否则轮询拿到终态后会永远跑下去）
        if (GEN_TERMINAL.includes(detail.status)) stopPolling();
    }
    // 实时预览按 task_id 订阅：顶栏队列放开并发后，切配方 / 再提交都不许把正在跑那一发的
    // 预览订阅摘掉，所以整页只挂一条订阅，由 activeLive 决定当前这一发的帧落在哪个播放器上。
    function applyPreview(p) {
        if (!p || !Array.isArray(p.frames) || !p.frames.length) return;
        const st = Number(p.step);
        if (Number.isFinite(st) && st <= genState.lastPreviewStep) return;
        if (Number.isFinite(st)) genState.lastPreviewStep = st;
        livePlayer.apply(p);
    }
    activeLive = null;

    // 提交整片生成：配方名 + 勾选的段 + 配方记着的种子 + 技能面板那套模型链覆盖。
    // 后端按配方名从盘上读整片（分辨率 / 连续性 / 上下文帧 / 每段的技能与素材都在配方里）——本页不发这些，
    // 页面上改过的段必须先「保存该段」写回配方，这一发才带得走。
    async function submitGenerate() {
        if (!currentName) { statusEl.textContent = t("请先选一份导演配方"); return; }
        if (isPreset()) { statusEl.textContent = t("内置预设配方只读：先「复制配方」再生成整片"); return; }
        if (ops.isDirty()) { statusEl.textContent = t("该段有未保存的改动：先点「保存该段」，改动进配方后再生成"); return; }
        const body = { recipe: currentName };
        // 勾选按 1 起的段号发（后端 parse_segment_selection 认段号，越界与坏号整发 400 拒收）：不发 = 跑全部段
        if (checkedSegments.length) body.only_segments = checkedSegments.map((i) => i + 1).join(",");
        // 种子只在整片参数表单里（生成坞不留第二枚种子输入）：这一发带的就是配方落过盘的那一个，-1 = 随机换
        const filmSeed = Math.trunc(Number(recipe?.shared?.seed));
        body.seed = Number.isFinite(filmSeed) ? filmSeed : -1;
        const ovBits = [];
        if (videoModels) {
            const c = videoCfg.collect();
            const push = (key, label) => {
                if (!c[key]) return;
                body[key] = c[key];   // 与视频页自定参数同一批顶层键：空值不进覆盖，该段跟随自己的 skill config
                ovBits.push(tf("{label} {name}", { label, name: String(c[key]).split("/").pop() }));
            };
            push("model", t("模型"));
            push("text_encoder", t("编码器"));
            push("vae", t("VAE"));
            push("audio_vae", t("音频 VAE"));
            if (c.loras?.length) { body.loras = c.loras; ovBits.push(tf("{n} 个 LoRA", { n: c.loras.length })); }
            // 步数只在用户改过面板时才发：各段技能钉着的步数不该被整片覆盖掉
            if (c.steps && !videoCfg.stepsFollowSkill()) { body.steps = c.steps; ovBits.push(tf("{n} 步", { n: c.steps })); }
        }

        stopPolling();
        statusEl.textContent = t("提交中…");
        barEl.style.display = "none";
        media.classList.add("ns-director-idle");   // 这一发的画面没来之前起手卡先站着
        media.replaceChildren(idleCard, liveBox);   // 上一发的成片与定格帧让位：这一发从起手卡开始
        livePlayer.reset();
        let data = null;
        try {
            const r = await api.fetchApi("/neo_studio/director/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            data = await r.json().catch(() => null);
            if (!r.ok || !data?.success) throw new Error(String(data?.error || r.status));
        } catch (e) {
            statusEl.textContent = tf("提交失败：{msg}", { msg: e.message });
            return;
        }
        // 提交成功才把界面交给这一发：WS 事件与轮询兜底都在 setGen 里挂。
        // 按钮不锁——这一发在顶栏队列里跑，用户能接着排下一发
        setGen(data);
        queueTrack("film", data, { label: currentName });
        // 覆盖值要在队列提示里说出来：整片每一段都被这一份模型链盖着，跑完才发现「和配方里钉的不一样」就晚了
        toast(tf("已加入队列：{label}{ov} · 顶栏「队列」看进度", {
            label: currentName,
            ov: ovBits.length ? tf(" · 本次每段临时换：{list}", { list: ovBits.join(" · ") }) : "",
        }));
    }
    runBtn.addEventListener("click", () => submitGenerate());

    cancelBtn.addEventListener("click", async () => {
        if (!genState) return;
        // 中断不可逆：这一发出不了成片，先把「这一发要丢什么」说清楚再动手（与删段同一套 confirm 口径）
        if (!confirm(t("取消这一发生成？排队中的这一发直接出队，已经在跑的立即中断，这一发不出成片。"))) return;
        // 乐观先落「已取消」并收起取消钮：入队前的取消连 prompt_id 都没有，队列项的 cancel 会直接吃灰
        statusEl.textContent = t("已取消");
        cancelBtn.style.display = "none";
        cancelBtn.disabled = true;
        try {
            const r = await api.fetchApi(`/neo_studio/director/${genState.task_id}/cancel`, { method: "POST" });
            const data = await r.json().catch(() => null);
            if (!r.ok) throw new Error(String(data?.error || r.status));
        } catch (e) {
            statusEl.textContent = tf("取消任务失败：{msg}", { msg: e.message });
            cancelBtn.style.display = "";
        }
        cancelBtn.disabled = false;
    });

    promptIn.addEventListener("input", () => {
        const s = segs()[selected];
        if (!s) return;
        s.prompt = promptIn.value;
        markDirty();
        growPrompt();
        timeline.refresh();
    });

    // 配方面板（弹窗里：点卡片 = 选中喂给本页，含复制 / 删除 / 新增；只列多段导演配方）
    directorPanelOpts = () => ({
        directorOnly: true,
        hideTitle: true,            // 弹窗顶栏就是标题（导演配方），面板不再重复一行「📦 配方」
        autoSelectFirst: true,      // 进页就选中首份导演配方：整片生成区与时间轴不用先点一次卡片
        initialSelection: currentName,
        onSelect: (r) => { recipesModal?.close(); openRecipe(r.name); },
        onNewRecipe: () => { recipesModal?.close(); startNewRecipe(); },
    });
    // 编辑器保存 / 新建保存后：重建配方面板（新配方立刻长出一张卡）并把那份配方选中，时间轴与该段控件跟着换
    window.addEventListener(DIRECTOR_RECIPE_SAVED_EVENT, async (e) => {
        await refreshRecipeItems();
        await refreshRecipesPanel();
        const name = e?.detail?.name;
        if (name) await openRecipe(name);
    });
    listVideoSkills().then((list) => { directorSkills = list || []; syncSkillChip(); }).catch(() => {});
    listVideoGenModels().then((models) => {
        videoModels = models || {};
        videoCfg.load({}, videoModels);   // 先按「自动」铺一遍：右栏四行要有清单可挑
        applySkillParams(skillSel.value);   // 再铺当前技能钉的那一套（清单拿不到就整块不发覆盖值，各段技能配置照常生效）
    }).catch(() => { /* 清单拿不到：覆盖面板整块不发值，各段技能配置照常生效 */ });
    recipesPanelEl = await createRecipesPanel(directorPanelOpts());
    recipesHost.appendChild(recipesPanelEl);
    onDirectorShown = () => { refreshRecipeItems(); if (currentName) loadSpec(); };
    // 首页的配方卡带 ?recipe= 深链进来：按名字选中那一份导演配方
    directorOpenRecipe = async (name) => {
        await refreshRecipeItems();
        if (findItem(name)) await openRecipe(name);
    };
    await refreshRecipeItems();
}


// 故事板页的工厂在 pages/storyboard-page.js：内嵌编辑器与让位/补铺那一发都在页自己那一份里，
// 这一处只把宿主交下去，并把导演页要用的两条钩子接回装配层
const storyboardPage = createStoryboardPage({ $el, toast, go });
storyboardReleaseEditor = () => storyboardPage.releaseEditor();
onStoryboardShown = () => storyboardPage.shown();
const buildStoryboard = storyboardPage.build;




// 绘画页与编辑页的工厂在 pages/paint-edit-page.js：面板宿主、armed 门与提示词入口都在那一页自己那一份里，
// 这一处只把宿主交下去，再把三条跨页落点接回来（增强页落页、技能卡选技能、侧栏取原图）
const paintEdit = createPaintEditPage({
    $el, toast, go,
    openLibModal,
    closeMaterialModal: () => libModal?.close(),
    gallery: () => app.neoGallery,
});
const buildPaint = paintEdit.buildPaint;
const buildEdit = paintEdit.buildEdit;

// 技能分组 = 导演页那套生成模式：组头名与组序直接取 director 的 SEG_MODES，两处模式词永远一致。
// 技能的 mode 经 LEGACY_MODE_MAP 归并（t2v / i2v / fl2v → 关键帧生视频，r2v 留全参考生视频），
// 没标 mode 的旧视频技能落关键帧生视频——首帧留空就是文生视频，本来就是这一家族里的一发
// 这一套模式词汇导演页与出视频页共用，写在装配层，由宿主交给出视频页
const VIDEO_GROUP_LABELS = Object.fromEntries(SEG_MODES.map(([key]) => [key, MODE_LABELS.get(key)]));
const videoModeGroup = (meta) => LEGACY_MODE_MAP.get(meta?.mode) || meta?.mode || "f2v";
const videoSkillSteps = (s) => Number((s.gen_config || {}).steps) || 20;

// 默认技能 = 关键帧生视频家族里步数最少的可用技能（后端 _default_video_skill 同口径）：
// 出视频页的默认技能与导演页新建配方钉的首段技能都按这一份口径选
function defaultVideoSkill(list) {
    const usable = list.filter((s) => s.available !== false);
    const pool = usable.filter((s) => videoModeGroup(s) === "f2v");
    const by = pool.length ? pool : usable;
    if (!by.length) return "";
    return by.reduce((a, b) => (videoSkillSteps(b) < videoSkillSteps(a) ? b : a)).id;
}

// 素材方块的缩略图：input/ 里的文件（视频页与导演页的素材方块共用这一份 URL）
const inputThumbSrc = (value) => `/view?filename=${encodeURIComponent(value)}&subfolder=&type=input`;

// 素材库弹窗点卡片 → copy_to_input 落进 input 根目录，返回加载节点可用的文件名
async function copyPickedToInput(img) {
    const query = "filename=" + encodeURIComponent(img.filename || "")
        + (img.subfolder ? "&subfolder=" + encodeURIComponent(img.subfolder) : "");
    const resp = await api.fetchApi("/neo_gallery/copy_to_input?" + query);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.success) throw new Error(data?.error || t("无法读取该图片"));
    return data.filename;
}

// 出视频页工厂在 pages/video-page.js：composer、生成与轮询、复用预填都在那一页自己那份里，
// 这一处把素材库弹窗、生成能力门与 input/ 那两条落点交下去
const { buildVideo } = createVideoPage({
    $el, toast, go,
    openLibModal,
    closeLibModal: () => libModal?.close(),
    gateRunButton,
    thumbSrc: inputThumbSrc,
    copyPickedToInput,
    modeGroup: videoModeGroup,
    defaultSkill: defaultVideoSkill,
    groupLabels: VIDEO_GROUP_LABELS,
});

// 首页工厂在 pages/home-page.js：卡表与版式在 home-layout.js，落点页在 app-registry.js，
// 这一处只交装配层独有的那几样（当前视图、切页、深链重路由、桌面外链、编辑页与生图面板的落点）
const homePage = createHomePage({
    $el, toast, go, route,
    currentView: () => currentView,
    openExternalUrl,
    paintEdit,
});
const { buildHome, stopHomeEdit, openHomeQuick, closeHomeQuick, scheduleHomeQuickClose, initHomeLayout } = homePage;


// 技能页工厂在 pages/skills-page.js：引导页、管理组件的装配与卸载、导入工作流都在那一页自己那份里，
// 这一处只交建元素与提示条两样
const { buildSkills } = createSkillsPage({ $el, toast });


// 设置页工厂在 pages/settings-page.js：四段十栏的壳、tab 切换、启动日志轮询、启动设置面板与语言栏都在
// 那一页自己那份里；版本快照、内核启停与采样帧偏好是装配层的状态，这一处把它们交下去
const settingsPage = createSettingsPage({
    $el, api, toast, openExternalUrl,
    versionText, renderAboutRows,
    previewMode: () => previewOn,
    setPreviewMode: applyPreviewMode,
    userStarting: () => userStarting,
    onComfyState, startKernel, stopKernel,
});
const { buildSettings, showSettingsTab, prefillAgentPrefs } = settingsPage;

// ====== 启动：版本信息 + 扩展初始化 + 路由 ======
let offline = false;   // 内核没就绪：生成类请求由桌面端回 409
let starting = false;  // 桌面端已拉起 ComfyUI 还没就绪：这段时间只出「启动中」，其余离线提示一律收起
let caps = {};         // 桌面端能力表（/neo_studio/version 下发）；ComfyUI 页里缺省即全可用
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
    [".ns-director-run", "director", t("生成")],
    [".ns-video-run", "simple_video", t("生成视频")],
    [".neo-director-regen-run", "segment", t("生成这一段")],
    [".neo-director-merge-run", "segment", t("拼回成片")],
    [".ns-director-segmenu-regen", "segment", t("重生成该段")],   // 段菜单那一项目前只做一件事：进编辑器展开上面那块面板
    [".ns-paint .neo-gallery-story-btn-primary", "image_gen", t("生成")],   // 绘画页文生图与编辑页图片编辑面板的生成
    // 反推两页各一枚运行钮：图片页吃 prompt_reverse，视频页吃 prompt_reverse_video
    [".ns-reverse-run", "prompt_reverse", t("反推")],
    [".ns-revvid-run", "prompt_reverse_video", t("反推")],
    [".ns-voice-run", "voice", t("生成")],
];

// 生成按钮改写成「需要 ComfyUI」：不发请求，点一下引导启动（须在原 handler 之前注册）
// 登记下来：就绪翻面时摘监听、还原文案，按钮回到原 handler 上。
const gatedButtons = [];

function gateRunButton(btn, feature, label) {
    if (can(feature)) return;
    // 原文案按节点存：图标钮里的那枚 svg 用文本存不住，就绪翻面时会把图标抹成空钮
    const original = [...btn.childNodes];
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
        g.btn.replaceChildren(...g.original);
        g.btn.title = g.originalTitle || g.label;
        g.btn.classList.remove("ns-gen-off");
    }
    gatedButtons.length = 0;
}

function runLabel() { return starting ? t("ComfyUI 启动中") : t("需要 ComfyUI"); }

// 共享模块（gallery / director / voice）大量直接用原生 fetch 打接口，不经 api shim：
// 这里给它们补上同一份 409 处理 —— 内核没就绪时出统一的「需要 ComfyUI」提示，不静默吞掉。
// 共享模块注册的运行按钮（生成素材 / 生成这一段 / 拼回成片 / 生成图片分镜）在捕获阶段拦掉。
function initOfflineGate() {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => nativeFetch(input, init).then((res) => {
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
            configureCanvasOrigin({ port: data.kernel_port, origin: data.kernel_origin });
            versionInfo = {
                plugin: data.plugin_version || "", comfy: data.comfyui_version || "", offline,
                dataRoot: String(data.data_root || ""), comfyLocal: String(data.comfy_local || ""),
                remote: String(data.remote || ""),
            };
            renderVersionInfo();
            setOfflineMark(offline);
            paintStatusFallback();   // 快照知道这一路是谁服务的了：没有状态来源时顶栏补一句中性读数
        }
    } catch { /* ComfyUI 未就绪时保持空白 */ }
}

// 就绪后原地接上生成：页面不换地址、不刷新，只把能力表 / 门控 / 显存条 / 事件流翻面。
// 整页跳转与刷新都会清掉导演编辑器和表单里未保存的内容 —— 这里一样都不发生：请求本来就
// 打在桌面端端口上，内核的路由由桌面端转发过去（app/studio_server.py 的 proxy_forward）。
// 五步必须一次做完：只解禁按钮不换事件流，用户点「生成整片」会拿到任务拿不到进度。
// 内核答话之前整块不翻 —— 翻一半就是按钮能点、进度不来。
async function flipOnline() {
    if (!offline) return;
    try {
        const desk = await (await api.fetchApi("/neo_studio/version")).json();
        if (!desk?.success || !desk.kernel_ready) return;   // 桌面端还没认下这路内核：下一轮 5 秒探活再来
        const comfy = await (await api.fetchApi("/neo_studio/kernel_version")).json();
        if (!comfy?.success) { flipStarted = false; return; }   // 刚就绪还没答话：下一轮 5 秒探活再来
        caps = { ...(desk.caps || {}), ...(comfy.caps || {}) };   // 内核报的那份是这 12 位的权威
        configureCanvasOrigin({ port: desk.kernel_port, origin: desk.kernel_origin });
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
        reconnectSocket();
        setQueueOnline(true, true);   // 事件流刚换到内核隧道：顶栏入口浮出、面板照持久历史 + 六张表的现值重播、读数条补建
        desktopLog("FLIP online in-place");
    } catch {
        flipStarted = false;
    }
}

// 翻面后停掉内核：页面要翻回离线形态。不翻的话按钮解禁着、生成请求打到没有内核的代理上，
// 拿不到 409 也拿不到离线提示，比今天「窗口退回离线页」更糟。
async function flipOffline() {
    if (offline) return;
    offline = true;
    flipStarted = false;   // 下次就绪还能再翻过来
    await loadVersion();   // 桌面端快照：kernel_ready 已收，能力表与离线标记回到离线形态
    configureCanvasOrigin({});   // 画布链接随能力表一起收：「主画布编辑」的离线闸门认它
    reGateRunButtons();
    reconnectSocket();     // 事件流切回桌面端的桩，别对着死端口重连
    setQueueOnline(false, can("task_history"));   // 队列要吃执行队列：离线形态只留持久历史入口
}

function reGateRunButtons() {
    for (const [selector, feature, label] of RUN_GATES) {
        for (const btn of document.querySelectorAll(selector)) {
            if (!gatedButtons.some((g) => g.btn === btn)) gateRunButton(btn, feature, label);
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

// 顶栏「设置」图标位：字形走中央图标层（与首页「设置」卡同一枚），换页交给 bindHeaderNav
// 接管的那条锚点路由。挂在静态壳那一步（与窗口控件同一轮），不等扩展模块图 —— 顶栏先空一格、
// 过几秒才长出齿轮，就是「刚开窗口少一个入口」
function initSettingsEntry() {
    const btn = document.getElementById("ns-settings-btn");
    if (btn) setIcon(btn, "gear", 15);
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
        headerFallback = false;   // 真快照落地：顶栏这一位交回真状态，占位句不再补
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
    // 也管不到它。origin 不答这条路由（浏览器标签页 / 远程那路）就停问 —— 桌面端服务冷启动那阵
    // 也会先回一发非 200，第一发就停就是把这段窗口永远留在没有状态的顶栏上，连错三发才停。
    let httpMiss = 0;
    const pollHttp = () => fetch(`${location.origin}/neo_studio/comfy_state`)
        .then((r) => {
            if (!r.ok) { httpMiss += 1; return null; }
            httpMiss = 0;
            return r.json();
        })
        .then((d) => { if (d?.success) publishComfyState(d); })
        .catch(() => { httpMiss += 1; });
    const poll = () => {
        const api = window.pywebview?.api;
        if (api?.comfy_state) api.comfy_state().then(publishComfyState).catch(() => {});
        if (httpMiss < 3) pollHttp();
    };
    poll();
    paintStatusFallback();   // 第一轮问话落地之前先出占位读数：右端那一排图标不跟着往左滑
    setInterval(poll, 5000);
}

function setStatus(kind, text, title) {
    const el = document.getElementById("ns-comfy-status");
    el.textContent = `● ${text}`;
    el.classList.remove("ns-comfy-run", "ns-comfy-starting", "ns-comfy-pending");
    if (kind) el.classList.add(`ns-comfy-${kind}`);
    el.title = title;
}

// 顶栏状态位的占位句：状态来源（桥 / 桌面端服务的 comfy_state）都没落地时顶栏读的那一句。
// 只给顶栏看，不进 comfyState —— 启动设置的启停按钮认的是真快照，占位句不许驱动它们。
let headerFallback = false;

function paintStatusFallback() {
    if (headerFallback || comfyState) return;
    if (window.pywebview) {
        // 桌面端窗口：桥晚到（F5 之后实测晚十几秒）、桥被拖动循环饿死、桌面端服务还没开始答话，
        // 这段时间顶栏不能空着 —— 空着那一块是 flex 位，队列 / 设置 / 窗口控件整排往左滑。
        setStatus("pending", t("状态读取中"), t("桌面端窗口正在回报内核状态 · 启停在「设置 → 启动设置」"));
    } else if (!offline) {
        // ComfyUI 直接服务的那一路（浏览器标签页 / 手机 / 局域网整页跳转）：这一页就是内核发的，
        // 运行中是页面自己确认得到的事实；桌面端服务的离线页（offline 为真）没有这条依据，不编。
        setStatus("run", t("运行中"), t("本页由运行中的 ComfyUI 直接服务 · 启停在桌面端「设置 → 启动设置」"));
    } else {
        return;
    }
    headerFallback = true;
}

// ====== 顶栏静态壳：index.html 里的中文是原文，按当前语言重画（切语言走整页刷新，不做运行中热替换） ======
function localizeShell() {
    document.title = t("新影工坊 · Neo Studio");
    const logo = document.querySelector(".ns-logo");
    if (logo) { logo.textContent = t("新影工坊"); logo.title = t("返回首页"); }
    for (const a of document.querySelectorAll(".ns-tabs a")) a.textContent = t(a.textContent.trim());
    // 「首页」那一格是悬浮快速入口的落点：tooltip 说出这一发（切语言走整页刷新，标题在这一轮里重画）
    document.querySelector('.ns-tabs a[data-tab="home"]')?.setAttribute("title", t("悬浮快速入口：鼠标落在这里就浮出首页的直达卡片"));
    for (const id of ["ns-win-min", "ns-win-max", "ns-win-fs", "ns-win-close", "ns-settings-btn", "ns-queue-toggle"]) {
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

// ====== 智能体页：独占整页，面板是界面本身、结果就铺在面板里；入口只有首页创造区的卡 ======
// 导航栏不给它留位：页面靠 go("agent") 进，与其余页同一条路由，视图常驻不重建（会话时间线不丢）

function buildAgentPage(el) {
    el.classList.add("ns-agent-page");
    const chatHost = $el("div", { className: "ns-agent-chat" });
    el.appendChild(chatHost);
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
    agentCtxRefresh = () => panel.refresh();   // 切页 / 选配方时重画面板上的上下文条
}

// 注册表 id → 页的 build：注册表说清这一页「是什么」（首页卡、页签、深链参数、常驻与否），
// build 认识 #ns-view、桌面桥与能力表，只有装配层给得出这一句。注册表有一条、这里缺点名，
// 那一页点下去就是空白页——由 studio/tests/js/app-registry.test.mjs 说，不在运行时兜
const PAGE_BUILDERS = {
    home: buildHome, director: buildDirector, paint: buildPaint, edit: buildEdit,
    gallery: buildGallery, video: buildVideo, pose: buildPose, skills: buildSkills,
    settings: buildSettings, agent: buildAgentPage, frames: buildFrames, reverse: buildReverse,
    reverse_video: buildReverseVideo, voice: buildVoiceClone, enhance: buildPromptEnhance,
    storyboard: buildStoryboard,
};

function route() {
    let name = (location.hash || "#/home").replace(/^#\//, "").split("?")[0] || "home";
    if (name !== "home") stopHomeEdit();   // 离开首页即弃草稿：首页视图是常驻显隐的，编辑态不能跟着页签留到下一页回来
    // 注册表里 eager 那几条（首页 / 导演 / 绘画 / 编辑）每次导航都注册：首页卡片直达后三页，
    // 内嵌宿主要在第一次点「新建导演配方 / 生成素材 / 图片编辑」之前就要挂好
    for (const app of STUDIO_APPS) {
        if (app.eager) ensureView(app.id, PAGE_BUILDERS[app.id]);
    }
    const app = appById(name);
    if (app) ensureView(app.id, PAGE_BUILDERS[app.id]);
    else if (name !== "home") ensureView("gallery", buildGallery);   // 认不出的名字：画廊预热，视图落回首页
    // 认不出的 tab 名（深链、别的构建里已删掉的页）没有视图可显：showView 会把全部视图一起隐掉，
    // 窗口停在只剩顶栏的空白页
    if (!views.has(name)) name = "home";
    // 深链带的那一个目标要落到刚建好的页上：注册表那一条上的 deep 说的就是这一页认哪一个参数
    const query = new URLSearchParams(location.hash.split("?")[1] || "");
    if (app?.deep === "recipe" && query.get("recipe")) directorOpenRecipe?.(query.get("recipe"));
    if (app?.deep === "tab" && query.get("tab")) {
        showSettingsTab(query.get("tab"));
        if (query.get("tab") === "agent") prefillAgentPrefs(query);   // 焦点链的技能与宽高照深链落进表单
    }
    showView(name);
}

// 仅 Studio 独立页启动：本文件也会作为扩展模块被主画布页加载（WEB_DIRECTORY），那里没有 #ns-view
if (view) {
    localizeShell();
    bindHeaderNav();
    // 出视频页没建过时，素材卡的「再来一发」与技能卡要把这一发交出去，得先把页建起来（route 同步建视图）
    setVideoPageJump(() => go("video"));
    // 顶栏控件与拖动只吃 index.html 的静态顶栏，不等扩展 setup 与版本快照：那两次请求都打在刚装配、
    // 正拉起 ComfyUI 的桌面端服务上，排在它们后面就是「窗口开出来要过一会才能拖动」
    initWindowChrome();
    initSettingsEntry();    // 顶栏「设置」图标位：与窗口控件同一轮上屏，不等扩展模块图
    // 未捕获错误与启动失败一并写进桌面端日志：窗口白屏时日志里至少留下证据
    window.addEventListener("error", (e) => desktopLog(`ERROR ${e.message} @ ${e.filename}:${e.lineno}`));
    window.addEventListener("unhandledrejection", (e) => desktopLog(`REJECT ${e.reason?.stack || String(e.reason)}`));
    window.addEventListener("hashchange", route);
    window.addEventListener("popstate", route);   // 换页走 pushState 后，浏览器 Back 只派发 popstate
    initExtensions().then(async () => {
        await loadVersion();   // 先拿到离线标记与能力表，再建视图（生成按钮要按能力门控）
        initOfflineGate();
        route();   // 视图先挂上：桌面端附件（顶栏状态位）失败不能连坐，窗口不至于停在只出顶栏的空白页
        initHomeLayout();   // 首页版式读回来再重画：不排在启动链上，默认版式先站着
        initComfyStatus();
        initClipboardKeys();
        initReloadHotkey();
        initQueuePanel({ toast, go, can });   // 顶栏「队列」：离线收掉入口，就绪后播种；显存 / 内存读数与清理在面板里
    }).catch(e => {
        console.error("[Neo Studio] startup failed:", e);
        desktopLog(`STARTUP FAILED ${e?.stack || e}`);
    });
}
