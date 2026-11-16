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
import { setPaintHost, openGenMaterialDialog, openImageEditDialog, openImageEditMode, setVideoReuseOpen, setVideoPageJump, openVideoReuse, reuseModelOverlay, chipButton, ratioGlyph, skillParamsChip } from "../gallery-gen.js";
import { createFramePlayer, DOCK_PREVIEW_SIDE, AGENT_PREVIEW_SIDE } from "../live-preview.js";
import { createRecipesPanel, listRecipes } from "../recipes.js";
import { listVideoSkills } from "../recipes.js";
import { DirectorTimeline } from "../director-timeline.js";
import { skillDisplayName, importWorkflowSkill, listSkills } from "../skill.js";
import { createImageGenSettingsForm, createVideoGenSettingsForm, createVideoModelConfigSection, listVideoGenModels, getSkillGenConfig, blockingMissingModels, modelFamily } from "../image-gen.js";
import { createModelConfigForm } from "../llm-setting.js";
import { createSkillManager } from "../skill.js";
import { createAgentPanel, createMcpPanel, createAgentPrefsForm } from "../agent-panel.js";
import { t, tf, getLang, applyLang, LANGS } from "../js/core/i18n.js";
import { icon, setIcon, setIconLabel } from "../js/core/icons.js";
import { createLibraryModal, acceptsPick } from "../js/core/lib-modal.js";
import { mediaKindOf } from "../gallery-utils.js";
import { openPresetPicker, randomPromptText, savePromptTo } from "../js/core/preset-picker.js";
import { reusePaintPanel } from "../gen-utils.js";
import { createPairPanel } from "../js/core/pair-access.js";
import { createMediaSlot } from "../js/core/media-slot.js";
import { initQueuePanel, setQueueOnline, queueTrack } from "../queue-panel.js";
import { createPoseView } from "../pose/pose.js";
import { createFramesView } from "../frames/frames.js";
import { createReverseView } from "../reverse-prompt/reverse-prompt.js";
import { createVoiceCloneView } from "../voice-clone/voice-clone.js";
import { HOME_SECTIONS, createHomeInlineEditor, heroText, layoutSections, loadHomeLayout, normalizeLayout, sectionOrder, visibleCards } from "./home-layout.js";

const view = document.getElementById("ns-view");
const REPO_URL = "https://github.com/neoneo-ai/neo-studio";   // 设置「关于」里的仓库行，与顶栏「关于插件」同一地址
let directorPanelOpts = null;   // 导演页配方面板选项（buildDirector 设置；含 onSelect 回传选中配方）
let onDirectorShown = null;     // 进导演页时补拉的活：隐藏期间跳过的 director_spec 在进本页时补一次
let directorOpenRecipe = null;  // 导演页建好时挂上的「按名字开编辑器」：首页配方卡的 ?recipe= 深链走这条路

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

// 悬浮「素材库」的取用：弹窗点卡片 = 把这张图喂进图片编辑面板当原图（参考图菜单自己交回调，不经这里）
function editPickImage(images) {
    const img = images[0];
    if (!img) return;
    openImageEditDialog(app.neoGallery, { filename: img.filename }, img.subfolder);
}

// 姿势视图的依赖在这汇聚：api 走 shim（离线/在线同一条路）；导出图组的控制图交图片编辑面板预填
const buildPose = createPoseView({
    api, $el, toast,
    openEdit: (prefill) => openImageEditDialog(app.neoGallery, null, "", { prefill }),
});

/** 抽帧页取视频：点卡片取一条换进播放器（一次只看一条视频） */
function openFramesMaterial(onPick) {
    openLibModal("frames", (picked) => {
        onPick(picked);
        libModal?.close();
    }, "video");
}

// 抽帧页与姿势页不共享任何东西：取用同一套弹窗，抽帧自己在浏览器里做（见 studio/web/frames/frames.js）
const buildFrames = createFramesView({ api, $el, toast, openMaterial: openFramesMaterial });

/** 素材库取用一次就收窗：反推页要的是图，声音克隆页要的是音频，各自认各自那一类 */
function openMaterialOnce(scope, accept, onPick) {
    openLibModal(scope, (picked) => {
        onPick(picked);
        libModal?.close();
    }, accept);
}

// 两页都只从首页的卡进（顶栏没有这两枚页签）：运行按钮交 gateRunButton，能力缺时点它引导启动内核
const buildReverse = createReverseView({
    api, $el, toast,
    openMaterial: (onPick) => openMaterialOnce("reverse", "image", onPick),
    gateRun: gateRunButton,
});
const buildVoiceClone = createVoiceCloneView({
    $el,
    openMaterial: (onPick) => openMaterialOnce("voice", "audio", onPick),
    gateRun: gateRunButton,
});

onSidebarTabChange((id) => {
    if (currentView !== "director" && currentView !== "edit") return;
    if (id !== "neo.gallery") { libModal?.close(); return; }
    // 编辑页两个取用落点：参考图菜单的「素材库取用」把 addRefImages 经 neo:media-pick 交来（取的是参考图），
    // 悬浮「素材库」按钮自己交来 editPickImage（取的是原图）。回调一次一清：留着它，下一次从悬浮按钮开的
    // 弹窗会把该当原图的那张塞进参考位
    const onPick = libPendingPick || (currentView === "edit" ? editPickImage : null);
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
const NEW_RECIPE_BASE = "未命名配方";   // 顶栏「新建配方」的起手名：盘上同名配方（含预设）就往后排数字，不盖它的卡
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

    // --- 顶部条：配方（下拉快切）· 配方管理（卡片弹窗）· 新建配方 · 素材库 · 高级模式（整片编辑器浮层） ---
    recipesHost = $el("div", { className: "ns-director-recipes" });
    recipesModal = createLibraryModal({ storageKey: "neo_studio_libmodal_recipes", scope: "recipes" });
    recipesModal.setContent(recipesHost);
    document.body.appendChild(recipesModal.el);
    const recipeSel = $el("select", { className: "ns-director-recipe", title: t("选一份导演配方：时间轴与该段控件跟着换") });
    const recipeChip = chipButton(recipeSel, { icon: "list" });
    // 顶栏这颗只管管理（弹窗里点卡片选中 / 复制 / 删除 / 新增）；快速换配方就是上方那名下拉，两边不再同名
    const recipesBtn = $el("button", { className: "ns-btn", type: "button", title: t("打开配方管理：点卡片选中，含复制 / 删除 / 新增") });
    setIconLabel(recipesBtn, "list", t("配方管理"));
    recipesBtn.onclick = () => { recipesModal.open(t("导演配方")); refreshRecipesPanel(); };
    const newBtn = $el("button", { className: "ns-btn", type: "button", title: t("新建一份分镜视频导演配方：就在本页落一段，写完「保存该段」写回") });
    setIconLabel(newBtn, "film", t("新建配方"));
    newBtn.onclick = () => startNewRecipe();
    const libBtn = $el("button", { className: "ns-btn", type: "button", title: t("打开素材库：看大图与取用") });
    setIconLabel(libBtn, "folder", t("素材库"));
    libBtn.onclick = () => openLibModal("director");
    const editorBtn = $el("button", { className: "ns-btn", type: "button", title: t("高级模式：整片编辑器浮层（分段增删、生成模式与分辨率、故事板与提示词工具）") });
    setIconLabel(editorBtn, "film", t("高级模式"));
    editorBtn.onclick = () => openEditor();
    recipeSel.addEventListener("change", () => openRecipe(recipeSel.value));
    page.appendChild($el("div", { className: "ns-director-bar" }, [recipeChip.el, recipesBtn, newBtn, libBtn, editorBtn]));

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
        recipeChip.closeOnOutside(e.target);
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
    const renderRecipeSelect = () => {
        recipeSel.textContent = "";
        for (const r of recipeItems) {
            recipeSel.appendChild($el("option", { value: r.name, textContent: r.source === "preset" ? tf("{name}（预设）", { name: r.name }) : r.name }));
        }
        if (!recipeItems.length) recipeSel.appendChild($el("option", { value: "", textContent: t("（没有导演配方）") }));
        recipeSel.value = currentName;
        recipeChip.sync();
    };
    async function refreshRecipeItems() {
        try { recipeItems = (await listRecipes()).filter((r) => r.type === "video_director"); }
        catch { recipeItems = []; }   // 离线模式 / ComfyUI 未就绪：列表拿不到就留着现有那一份
        renderRecipeSelect();
    }

    function openEditor() {
        if (!currentName) { toast(t("先选一份导演配方")); return; }
        // 编辑器是浮层（桌面端不再内嵌宿主）：底部「保存并生成整片」保存成功后交本页直接提交
        openDirectorEditor(findItem(currentName) || { name: currentName }, afterEditorSaved, selected, { onSaveAndRun: () => submitGenerate() });
    }
    async function afterEditorSaved() {
        await refreshRecipeItems();
        await openRecipe(currentName);
    }

    // 顶栏「新建配方」与配方管理里的「新增导演配方」都在本页落：一段空段起手，整片参数取本页那张表单的
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
            renderRecipeSelect();
            await loadSpec();   // 尺寸胶囊 / 时间轴 / 该段槽位一起回空白
            return;
        }
        statusEl.textContent = tf("已新建配方 {name}：写提示词、取首帧，「保存该段」写回", { name });
        await refreshRecipesPanel();   // 保存链只刷下拉与本页，管理弹窗里那份面板得单独长出新卡
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
        renderRecipeSelect();
        recipesPanelEl?.__neoRecipesPanel?.select(currentName);   // 卡片高亮跟着本页的选中配方挪（下拉快切 / 保存后重读）
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




// ====== 绘画页（文生图）与编辑页（图片编辑）：一页一块面板铺满整栏；素材库走弹窗取用，只挂在编辑页 ======
// 面板内嵌进这两页（同导演编辑器 setDirectorEditorHost 语义）：面板进页就铺好，素材库的「生成素材」与
// 图片卡菜单「图片编辑」只负责跳到那一页（面板复用，不重建）。ComfyUI 插件模式没有宿主，照旧弹浮层窗。
function openPaintTarget(kind) {
    // 已在目标页时 go() 是同页空转，showView 里「离开该页收起弹窗」那段不触发：
    // 交还给本页面板后弹窗会盖在面板上，所以入口自己收
    go(kind === "edit" ? "edit" : "paint");
    libModal?.close();
}

// 宿主 onOpen 是一份合并表（setPaintHost 后写覆盖前写），两页共用这一个按 kind 分流的入口。
// 面板构造时宿主也会发一次（空画布自己种 storyboard 也发）：那一下不是用户要点素材，
// 建完面板才放开跳页——启动时这一发就不会把页面从首页 / 设置页深链拽走
let paintArmed = false;
let paintTextHost = null;   // 输入页那块生图面板的宿主：技能卡直达时按它的 __neoSetPrompt 选中这张技能
let editArmed = false;
function paintHostOpen(kind) {
    if (kind === "text" ? paintArmed : editArmed) openPaintTarget(kind);
}

function buildPaint(el) {
    const page = $el("div", { className: "ns-paint" });
    el.appendChild(page);
    const main = $el("div", { className: "ns-paint-main" });
    const textHost = $el("div", { className: "ns-paint-panel ns-paint-text" });
    page.appendChild(main);
    main.appendChild(textHost);

    setPaintHost({ text: textHost, onOpen: paintHostOpen });
    paintTextHost = textHost;
    // 文生图直接写提示词就能生成
    openGenMaterialDialog(app.neoGallery, { container: textHost });
    // 右上角浮一枚提示词入口（绝对定位在预览区上，不为它们空出一行）
    page.appendChild(paintPromptBar(textHost, "text"));
    paintArmed = true;
}

/** 绘画页 / 编辑页右上角那排提示词入口：一颗组合钮——左半「提示词」在按钮下方开提示词浮层，
 *  右半骰子抽一条图像提示词，两条都落进这一页现成面板的提示词框（面板不在了就重建一块带预填的）。
 *  extra 是这一页原本就有的入口（编辑页的「素材库」），排在最前 */
function paintPromptBar(host, kind, extra = []) {
    const fill = (text) => {
        if (reusePaintPanel(host, kind, null, null, { prompt: text })) return;
        if (kind === "edit") openImageEditDialog(app.neoGallery, null, "", { container: host, prefill: { prompt: text } });
        else openGenMaterialDialog(app.neoGallery, { container: host, prefill: { prompt: text } });
    };
    const presetBtn = $el("button", { className: "ns-btn ns-paint-preset-btn", type: "button", textContent: t("提示词"), title: t("从图像提示词列表里挑一条填进提示词") });
    const randomBtn = $el("button", { className: "ns-btn ns-paint-random-btn", type: "button", title: t("随机填入一条图像提示词") });
    setIcon(randomBtn, "dice");
    presetBtn.onclick = () => openPresetPicker({ kind: "image", onPick: fill, anchor: presetBtn });
    randomBtn.onclick = async () => {
        try {
            const text = await randomPromptText("image");
            if (!text.trim()) { toast(t("提示词库为空，抽不到图像提示词")); return; }
            fill(text);
        } catch (e) { toast(String(e?.message || e)); }   // 桌面端离线那一发要说出需要 ComfyUI，不能报词库为空
    };
    return $el("div", { className: "ns-paint-bar" }, [...extra, $el("div", { className: "neo-split-btn" }, [presetBtn, randomBtn])]);
}

function buildEdit(el) {
    const page = $el("div", { className: "ns-paint" });
    el.appendChild(page);
    const main = $el("div", { className: "ns-paint-main" });
    const editHost = $el("div", { className: "ns-paint-panel ns-paint-edit" });
    page.appendChild(main);
    main.appendChild(editHost);
    // 素材库入口浮在页面右上角（绝对定位在 .ns-paint 上），不为它空出一行；
    // 弹窗点卡片 = 取用该图当原图，拖进预览区 = 投放当原图
    const libBtn = $el("button", { className: "ns-btn ns-paint-lib-btn", type: "button", title: t("打开素材库：点卡片取用进图片编辑，拖进预览区投放") });
    setIconLabel(libBtn, "folder", t("素材库"));
    libBtn.onclick = () => openLibModal("edit", editPickImage, "image");
    page.appendChild(paintPromptBar(editHost, "edit", [libBtn]));

    setPaintHost({ edit: editHost, onOpen: paintHostOpen });
    // 空面板铺好，从素材库把图拖进预览区当原图即可
    openImageEditDialog(app.neoGallery, null, "", { container: editHost });
    editArmed = true;
}

// ====== 首页：意图卡片 —— 大字标题 + 板块卡片，点卡直达对应页；右上角入口把这一页切进原地编辑 ======
// 卡表、板块表与版式形状在 web/studio/home-layout.js；这一块只管 DOM 与「这张卡跳到哪一屏」，
// 编辑态长在这份 DOM 上：每张卡长出一枚删除，板块末尾一枚「添加卡片」开预设卡与自建卡表单，
// 标题区直接点字改，细栏只管列数与开关；落盘在细栏右端那枚「完成」。
// 版式是数据根里的一份文件（configs/home_layout.json）：插件页、桌面窗口、手机页打开同一份首页。
let homeViewEl = null;                    // 首页视图元素；版式到达后重画这一块
let homeLayout = normalizeLayout({});     // 首页按这一份画：编辑期间是草稿，平时是已落盘的版式
let homeStored = homeLayout;              // 已落盘的版式：退出编辑落回它，页面上未保存的草稿不留
let homeEditing = false;
let homeSaving = false;               // 「完成」在飞的这一发：不让人连点成两次 POST
let homeEditor = null;

function buildHome(el) {
    el.classList.add("ns-home");
    homeViewEl = el;
    homeEditor = createHomeInlineEditor({
        listRecipes, listSkills, skillLabel: skillDisplayName, toast,
        onDraft: (draft) => { if (!homeEditing) return; homeLayout = draft; renderHome(); },
    });
    renderHome();
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && homeEditing) stopHomeEdit();   // Esc 弃草稿退出：落盘只有「完成」这一条路，切页也一样丢草稿
    });
}

function startHomeEdit() {
    homeStored = homeLayout;
    homeEditing = true;
    renderHome();
    homeEditor.load().catch(e => console.error("[Neo Studio] home layout load failed:", e));
}

function stopHomeEdit() {
    if (!homeEditing) return;
    homeEditing = false;
    homeEditor?.closeDialog();   // 添加卡片这一面浮在页上：退出编辑态不能留一块遮罩
    homeLayout = homeStored;
    renderHome();
}

/** 「完成」= 保存版式并退出：保存收口在这枚入口上，细栏不再管落盘。
 *  保存没成就留在编辑态——页面上这份草稿不能随着一次失败的 POST 消失 */
async function finishHomeEdit() {
    if (homeSaving) return;
    homeSaving = true;
    renderHome();
    try {
        await homeEditor.save();
        toast(t("已保存：插件页、桌面窗口与手机页的首页同步生效"));
    } catch (e) {
        toast(tf("保存失败：{msg}", { msg: String(e?.message || e) }));
    } finally {
        homeSaving = false;
        renderHome();
    }
}

function renderHome() {
    if (!homeViewEl) return;   // 首页还没建：buildHome 建的时候直接按当前版式铺
    const kids = [];
    if (homeEditing) kids.push(homeEditor.bar);
    if (homeEditing || !homeLayout.hero.off) {
        const hero = homeHeroEl();
        if (homeEditing) homeEditor.decorateHero(hero);   // 编辑态连收起的标题区一起出：不出就点不回来
        kids.push(hero);
    }
    const blocks = [];
    for (const section of homeSections()) {
        const part = homeSectionBlock(section);
        if (part) blocks.push(...part);
    }
    kids.push($el("div", { className: "ns-home-inner" }, blocks.length ? blocks : [
        $el("p", { className: "ns-home-empty", textContent: t("首页卡片已全部移除，在「编辑首页」的添加卡片里加回来。") }),
    ]));
    // disabled 走属性：$el 认不出的键一律 setAttribute，disabled:false 写出来就是 disabled="false"，
    // 属性一在就是禁用 —— 这颗钮在窗口里点了没反应就是这么来的
    const entry = $el("button", {
        className: "ns-btn ns-home-edit-entry", type: "button",
        title: homeEditing ? t("完成首页编辑：保存版式并退出")
            : t("编辑首页：卡片顺序、删除与添加卡片、标题区文案、网格列数"),
        onclick: () => (homeEditing ? finishHomeEdit() : startHomeEdit()),
    }, homeEditing
        ? [icon("save", 14), " " + t("完成")]
        : [icon("gear", 14), " " + t("编辑首页")]);
    entry.disabled = homeSaving;
    // 编辑态的「完成」交进细栏右端：细栏钉在首页顶缘，滚到哪一屏都点得着完成；
    // 浏览态入口自己站在首页右上角，跟着页面滚
    if (homeEditing) homeEditor.setEntry(entry);
    else kids.push(entry);
    homeViewEl.replaceChildren(...kids);
    homeViewEl.classList.toggle("ns-home-editing", homeEditing);
    // 落位手势要交在已挂载的网格上：Sortable 的实例建在脱离文档的元素上只认得「拖起来」，认不出落点
    // （真浏览器实测：拖起、emulateDragOver、onDragOver 都跑，就是不换行）。replaceChildren 之后才在文档里。
    if (homeEditing) {
        for (const grid of homeViewEl.querySelectorAll(".ns-home-grid")) {
            homeEditor.decorateGrid(grid, grid.dataset.section || "");
        }
    }
}

// 旧版式里收起的板块在编辑态连卡一起铺回来：这一版不给收起开关，收起状态在「完成」落盘时被清成展开
function homeSections() {
    const ids = homeEditing ? sectionOrder(homeLayout) : layoutSections(homeLayout).map((s) => s.id);
    return ids.map((id) => HOME_SECTIONS.find((s) => s.id === id)).filter(Boolean);
}

function homeSectionBlock(section) {
    const off = homeLayout.hidden_sections.includes(section.id);
    const cards = visibleCards(section.id, homeLayout);   // 编辑态铺的也是这一叠：移出首页的卡在添加卡片弹窗里等着
    if (!homeEditing && (off || !cards.length)) return null;   // 收起的板块与没有卡的板块整块不出，不留空标题
    const title = $el("h2", { className: "ns-home-section" + (off ? " is-off" : "") }, [t(section.label)]);
    if (off) title.appendChild($el("span", { className: "ns-home-off-tag", textContent: t("已收起") }));
    return [title, homeGrid(cards, section.id)];
}

function homeHeroEl() {
    const hero = heroText(homeLayout);
    const off = homeLayout.hero.off;
    const kids = [
        $el("h1", {}, [
            $el("span", { dataset: { heroKey: "title" } }, [t(hero.title)]),
            $el("span", { className: "ns-home-accent", dataset: { heroKey: "accent" } }, [t(hero.accent)]),
            $el("span", { dataset: { heroKey: "suffix" } }, [t(hero.suffix)]),
        ]),
        $el("p", { dataset: { heroKey: "sub" } }, [t(hero.sub)]),
    ];
    if (homeEditing || !homeLayout.hero.cta_off) {
        kids.push($el("button", {
            className: "ns-home-cta", type: "button", dataset: { heroKey: "cta" }, textContent: t(hero.cta),
            onclick: () => { if (!homeEditing) go("paint"); },
        }));
    }
    return $el("div", { className: "ns-home-hero" + (off ? " is-off" : "") }, kids);
}

function homeGrid(cards, sectionId) {
    const grid = $el("div", { className: "ns-home-grid", dataset: { section: sectionId } });
    cards.forEach((card, index) => {
        const el = homeCard(card);
        grid.appendChild(el);
        if (homeEditing) homeEditor.decorateCard(el, { section: sectionId, card, index });
    });
    if (homeEditing) grid.appendChild(homeEditor.addTile(sectionId));
    // 落位手势不在这里交：这一会儿网格还没挂上文档，renderHome 挂载完再交（见 renderHome 末尾）
    if (homeLayout.cols) grid.style.setProperty("--ns-home-cols", String(homeLayout.cols));
    return grid;
}

function homeCard(card) {
    // 编辑期间这张卡上的控件改的是草稿：卡面本身不跳屏——跳到别的页，页面上这份未保存的草稿就没了
    // data-card-id 是给拖拽落位认卡用的：预览与落位都按这张卡的 id 找位置
    return $el("button", {
        className: "ns-home-card", type: "button", dataset: { cardId: card.id },
        onclick: () => { if (!homeEditing) openHomeCard(card); },
    }, [
        $el("span", { className: "ns-home-card-icon" }, [icon(card.icon || "sparkles", 22)]),
        $el("span", { className: "ns-home-card-text" }, [
            $el("span", { className: "ns-home-card-title", textContent: t(card.title) }),
            $el("span", { className: "ns-home-card-sub", textContent: t(card.sub) }),
        ]),
        icon("chevron", 16),
    ]);
}

// 一张卡的落地：内置卡与自建卡同一条路，跳转全按卡上的 target / value 这份数据走
function openHomeCard(card) {
    if (card.target === "url") { if (card.url) openExternalUrl(card.url); return; }
    if (card.target === "edit") { goEditMode(card.value || "normal"); return; }
    if (card.target === "recipe") { goDirectorRecipe(card.value); return; }
    if (card.target === "skill") { goSkillApply(card.value); return; }
    go(card.value || "home");
}

// 「编辑」板块的直达卡：先确保编辑页那块面板已铺好（go 走 route，视图没建就建），再把这一发的模式带进去
function goEditMode(mode) {
    go("edit");
    openImageEditMode(mode);
}

// 配方卡与技能卡靠深链进那一页：导演页与技能页各自把「按名字打开」那一条路交给这里
function goDirectorRecipe(name) {
    if (!name) { go("director"); return; }
    history.pushState(null, "", `#/director?recipe=${encodeURIComponent(name)}`);
    route();
}

// 技能卡的落点是这张技能的应用页：视频技能进视频页选中它，生图技能进输入页选中它。
// 增强类、模板类技能在这两页的技能下拉里都没有位置：没有可直达的应用页就说清楚再落技能页，不装能跳。
async function goSkillApply(id) {
    if (!id) { go("skills"); return; }
    const [videoSkills, skills] = await Promise.all([
        listVideoSkills().catch(() => []),
        listSkills().catch(() => []),
    ]);
    if (videoSkills.some((s) => s.id === id)) { openVideoReuse({ skill: id }); return; }
    const meta = skills.find((s) => s.id === id);
    if (meta?.gen_image) {
        go("paint");
        paintTextHost?.__neoSetPrompt?.({ skill: id });   // 技能不在本页候选里时面板自己就不填
        return;
    }
    toast(t("这张技能没有可直达的应用页（不是生图 / 生视频技能），先进技能页"));
    go("skills");
}

// 启动读一次版式（不挡启动链：先出默认版式，版式到了再重画）；编辑控件落盘后同一条事件重画并退出编辑
function initHomeLayout() {
    loadHomeLayout().then((stored) => {
        if (!stored) return;   // 比这版插件老的构建没有这条接口：首页停在注册表默认版式
        homeStored = stored;
        if (homeEditing) return;   // 编辑期间晚到的这一份读回不能盖掉页面上那份草稿
        homeLayout = stored;
        renderHome();
    });
    window.addEventListener("neo:home-layout", (e) => {
        homeLayout = normalizeLayout(e.detail);
        homeStored = homeLayout;   // 保存与恢复默认交回来的就是已落盘的版式：编辑态到此结束
        homeEditing = false;
        renderHome();
    });
}


// ====== 视频页：一句话 + 首帧（可选尾帧 / 参考图）直接出一段视频 ======
// 独立于导演多段流程：不建配方、不读配方，参数在本页 composer 里现填，提交后端简单视频接口。
// 版面照 ArtCraft 的 Create Video：整页是舞台，空着时正中盖一句起手提示（版式同绘画页 idle），
// 底部浮一张胶囊 composer（素材方块 + 提示词 + 芯片行 + 生成钮）；出片后提示淡出，成片卡片进舞台滚动。
// 分辨率档就是 MiniMax H3 的画布档（短边 768、面积上限 768×1344，官方节点按轴 32 对齐）：每一档横竖
// 成对排在一起，竖屏就是同一档宽高对调——像素量与对齐要求同档同值，模型侧不需要第二条解析路
const VIDEO_SIZE_CHOICES = [
    [624, 352, "352p 横屏"], [352, 624, "352p 竖屏"],
    [768, 432, "432p 横屏"], [432, 768, "432p 竖屏"],
    [1024, 576, "576p 横屏"], [576, 1024, "576p 竖屏"],
    [1280, 720, "720p 横屏"], [720, 1280, "720p 竖屏"],
    [1344, 768, "768p 横屏"], [768, 1344, "768p 竖屏"],
    [1920, 1080, "1080p 横屏"], [1080, 1920, "1080p 竖屏"],
];
const VIDEO_DUR_CHOICES = [3, 5, 8, 10, 15];
// 参考素材那一行的三类上限（与后端 _MAX_REF 同档）：一行混收，各类各收各的，总数 = 三者之和
const VIDEO_REF_MAX = { image: 9, video: 3, audio: 3 };
const VIDEO_REF_TOTAL = Object.values(VIDEO_REF_MAX).reduce((a, b) => a + b, 0);
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

    // 素材方块走共用组件 js/core/media-slot.js：这一页的落点是「取用即 copy_to_input 落进 input 根目录」，
    // 缩略图就是 input 的 /view。kindMax 给了就是混收那一行：素材库媒体全收，取用的按扩展名归入
    // 图 / 视频 / 音频，各类按各自上限收——上限、类型归类与技能槽位门控都写在组件里。
    function mediaSlot(label, multiple, maxN, kindMax = null) {
        return createMediaSlot({
            label, multiple, maxN, kindMax,
            thumbSrc: inputThumbSrc,
            toast,
            refKinds: () => (kindMax ? (selectedMeta()?.gen_config?.ref_kinds || null) : null),
            pick: ({ accept, multiple: keepOpen, gate, add }) => openLibModal("video", async (picked) => {
                const ok = gate(picked);   // 先过闸：挡下的不 copy_to_input，input 目录不留用不上的文件
                const filled = [];
                for (const a of ok) {
                    try { filled.push({ ...a, value: await copyPickedToInput(a.src) }); }
                    catch (e) { toast(tf("取用素材失败：{msg}", { msg: e.message })); }
                }
                add(filled);
                if (!keepOpen) libModal?.close();   // 首帧 / 尾帧取一张即收窗；参考素材留着弹窗好连选
            }, accept),
        });
    }

    const firstSlot = mediaSlot("首帧", false, 1);
    const lastSlot = mediaSlot("尾帧", false, 1);
    const refSlot = mediaSlot("参考素材", true, VIDEO_REF_TOTAL, VIDEO_REF_MAX);

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

    // 素材槽位随技能家族显隐：关键帧生视频给首帧 / 尾帧，全参考生视频给参考素材那一行。
    // 隐藏的槽位不进 payload——留着上一家族的首帧去跑 r2v，后端按资产推模式就会推错
    const applyVideoSlots = () => {
        const f2v = selectedGroup() === "f2v";
        firstSlot.el.classList.toggle("ns-hidden", !f2v);
        lastSlot.el.classList.toggle("ns-hidden", !f2v);
        refSlot.el.classList.toggle("ns-hidden", f2v);
    };

    // 换技能 = 把自定参数整块换成该技能 config 里钉的那一套（与绘画页同一语义）；
    // 「再来一发」带 reuseOverlay = 在技能配置上盖那一发的生效值，面板显示的就是重放要用的那一套
    const applySkillConfig = async (skillId, reuseOverlay = null) => {
        if (!skillId || !videoModels) return;
        const cfg = await getSkillGenConfig(skillId);
        // 「再来一发」带进来的步数是那一发的显式值（重放要照发）；技能配置铺的不算这一发的覆盖
        videoCfg.load({ ...(cfg || {}), ...(reuseOverlay || {}) }, videoModels,
            { stepsFromRun: Number(reuseOverlay?.steps) >= 1 });
        skillChip.sync();   // 程序改 value 不触发 change：chip 标签自己跟上
    };

    skillSel.addEventListener("change", () => {
        applyVideoSlots();
        applyEffectOptions();
        applySkillConfig(skillSel.value);
        try { localStorage.setItem(VIDEO_LAST_SKILL_KEY, skillSel.value); } catch { /* 隐私模式下记不住就算了，不挡生成 */ }
    });
    applyVideoSlots();

    const skillsReady = listVideoSkills().then((list) => {
        skillSel.textContent = "";
        for (const s of list) {
            // 特效技能缺 LoRA 时后端把 available 判成 false（skill._video_skill_available），下拉里要说出来
            const opt = $el("option", { value: s.id, textContent: skillDisplayName(s) + (s.available === false ? t("（不可用）") : "") });
            opt.__skillMeta = s;   // 分组与主模型副标题取这份元数据（会话页技能面板同一约定）
            skillSel.appendChild(opt);
        }
        if (!list.length) skillSel.appendChild($el("option", { value: "", textContent: t("（无可用视频技能）") }));
        let last = "";
        try { last = localStorage.getItem(VIDEO_LAST_SKILL_KEY) || ""; } catch { last = ""; }
        skillSel.value = list.some((s) => s.id === last) ? last : defaultVideoSkill(list);
        skillChip.sync();   // 技能是异步填进 select 的，chip 显示的生效值得跟着重读
        applyVideoSlots();
        applyEffectOptions();
        applySkillConfig(skillSel.value);
    }).catch(() => {
        skillSel.textContent = "";
        skillSel.appendChild($el("option", { value: "", textContent: t("（无可用视频技能）") }));
        skillChip.sync();
    }).then(() => { });   // 预填要等技能落进下拉才动技能行：与绘画页的 skillsReady 同一约定

    // 模型列表拉一次：先按「自动」渲染覆盖区，再覆盖成当前技能配置；拉不到保持空下拉（等效跟随设置，不挡生成）
    const modelsReady = listVideoGenModels().then((models) => {
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

    // 特效表技能（config.json 的 effects，后端 skill._attach_video_effects 发的那一份）才有这一枚；
    // 技能没有特效表时整枚收起——页面不摆一个只会跑默认特效的下拉
    const effectSel = $el("select", { className: "ns-video-effect", title: t("特效本体是技能钉着的嵌入文件：缺文件的特效标不可用，选了也进不了队列") });
    const effectChip = chipButton(effectSel, { icon: "sparkles" });
    const skillEffects = () => selectedMeta()?.effects || [];
    const effectEntry = (id) => skillEffects().find((e) => e.id === id) || null;
    const applyEffectPrompt = () => {
        // 示例提示词进占位符：这一发该写什么样的画面，技能比页面懂
        promptIn.placeholder = effectEntry(effectSel.value)?.prompt_default || t("描述这段视频要拍成什么样…");
    };
    const applyEffectOptions = () => {
        const list = skillEffects();
        effectSel.textContent = "";
        for (const e of list) {
            // 缺本体的特效照样列出来：说清它现在跑不了，去模型库补完回来就能选
            effectSel.appendChild($el("option", { value: e.id, textContent: e.label + (e.ready === false ? t("（不可用）") : "") }));
        }
        effectChip.el.style.display = list.length ? "" : "none";
        const def = effectEntry((selectedMeta() || {}).effect) || list.find((e) => e.ready !== false) || list[0];
        effectSel.value = def ? def.id : "";
        applyEffectPrompt();
        effectChip.sync();
    };
    effectSel.addEventListener("change", applyEffectPrompt);

    const seedIn = $el("input", { className: "ns-video-seed neo-gallery-gm-chip-btn", type: "number", min: "-1", placeholder: t("随机") });
    const seedRoll = $el("button", { className: "ns-video-seed-roll", type: "button", title: t("换一个随机种子") });
    setIcon(seedRoll, "sparkles", 13);
    seedRoll.onclick = () => { seedIn.value = String(Math.floor(Math.random() * 1e15)); };

    // 芯片行就是会话页那枚工厂的产物：胶囊 chip + 从上方浮出的选项菜单，原生 select 收在壳里当状态容器
    // 分辨率 chip 用比例 glyph（与绘画页比例 chip 同一枚）：选中竖屏档时方框立起来，不看字也知道是竖屏
    const sizeChip = chipButton(sizeSel, { glyph: ratioGlyph() });
    const durChip = chipButton(durSel, { icon: "clock" });
    const chips = [skillChip, sizeChip, effectChip, durChip];
    for (const c of chips) c.el.classList.add("ns-video-chip");
    const seedChip = $el("label", { className: "ns-video-chip neo-gallery-gm-chip-group", title: t("种子") }, [icon("sparkles", 12), seedIn, seedRoll]);
    // 菜单开着的 chip 要点外面才收；换页会重建这一页，页面离场时把监听摘掉，别一次次堆在 document 上。
    // 收在 pointerdown 这一发上而不是 click：combo 在列表项的 mousedown 里就收起了挂在 body 上的列表，
    // 松手落在浮层底下的页面元素上，浏览器按规范把 click 发在按下点与松手点的共同祖先（这一页里就是
    // document.body）上——照 click 收菜单的话，自定参数面板里选一次 VAE 就成了「点面板外」，
    // 整块面板连技能列一起收掉。按下点的 target 才是用户真正指的那 element，列表项在 inOpenComboList 里。
    const onDocPress = (e) => {
        if (!document.body.contains(page)) { document.removeEventListener("pointerdown", onDocPress, true); return; }
        for (const c of chips) c.closeOnOutside(e.target);
        if (videoMoreOpen && !videoMoreMenu.contains(e.target)) closeVideoMore();
    };
    document.addEventListener("pointerdown", onDocPress, true);

    // ⋯ 菜单（复用生成素材面板那枚 ⋯ 与运行时菜单样式）：保存当前提示词落视频池
    // （custom/video/，名字带 video/ 前缀，与本页「提示词」「随机」同一池）
    let videoMoreOpen = false;
    const videoMoreBtn = $el("button", { className: "neo-gallery-gm-tool-btn ns-video-more", type: "button", textContent: "⋯", title: t("更多：保存当前提示词") });
    const videoMoreMenu = $el("div", { className: "rs-runtime-menu ns-video-more-menu" });
    const videoSaveName = $el("input", { className: "neo-gallery-gm-menu-input", type: "text", placeholder: t("起个名字") });
    const videoSaveBtn = $el("button", { className: "neo-gallery-story-btn", type: "button", textContent: t("保存") });
    const closeVideoMore = () => { videoMoreOpen = false; videoMoreMenu.style.display = "none"; };
    videoMoreMenu.append($el("div", { className: "neo-gallery-gm-enhance-group" }, [
        $el("div", { className: "neo-director-field-label", textContent: t("保存当前提示词（视频池）") }),
        $el("div", { className: "rs-runtime-row" }, [videoSaveName, videoSaveBtn]),
    ]));
    videoMoreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (videoMoreOpen) { closeVideoMore(); return; }
        videoMoreMenu.style.display = "block";
        videoMoreOpen = true;
        const r = videoMoreBtn.getBoundingClientRect();
        videoMoreMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - videoMoreMenu.offsetWidth - 8))}px`;
        const above = r.top - videoMoreMenu.offsetHeight - 6;
        videoMoreMenu.style.top = `${above > 8 ? above : r.bottom + 6}px`;
    });
    videoSaveBtn.addEventListener("click", async () => {
        const text = promptIn.value.trim();
        if (!text) { toast(t("提示词是空的，没有可保存的提示词")); promptIn.focus(); return; }
        videoSaveBtn.disabled = true;
        try {
            const saved = await savePromptTo("video", videoSaveName.value, text);
            toast(tf("已存入视频提示词库：{name}", { name: saved }));
            videoSaveName.value = "";
            closeVideoMore();
        } catch (e) {
            toast(String(e?.message || e));   // 离线那一发是「保存提示词需要 ComfyUI 运行」，由 savePromptTo 说清楚
        } finally {
            videoSaveBtn.disabled = false;
        }
    });

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
                effectChip.el,
                durChip.el,
                seedChip,
                $el("div", { className: "neo-gallery-gm-composer-gap" }),
                videoMoreBtn,
                cancelBtn,
                runBtn,
            ]),
        ]),
    ]);
    page.appendChild(stage);
    page.appendChild(hero);
    page.appendChild(dock);

    // 右上浮一枚入口列（绝对定位同绘画页那一列，不为它们空出一行）：组合钮左半挑一条词、右半骰子抽一条视频提示词
    const fillVideoPrompt = (text) => {
        promptIn.value = text;
        promptCount.textContent = `${promptIn.value.length} / ∞`;
        promptIn.focus();
    };
    const videoPresetBtn = $el("button", { type: "button", className: "ns-btn ns-video-preset-btn", textContent: t("提示词"), title: t("从视频提示词列表里挑一条填进提示词") });
    const videoRandomBtn = $el("button", { type: "button", className: "ns-btn ns-video-random-btn", title: t("随机填入一条视频提示词") });
    setIcon(videoRandomBtn, "dice");
    const videoBar = $el("div", { className: "ns-video-bar ns-paint-bar" }, [
        $el("div", { className: "neo-split-btn" }, [videoPresetBtn, videoRandomBtn]),
    ]);
    videoPresetBtn.addEventListener("click", () => openPresetPicker({ kind: "video", onPick: fillVideoPrompt, anchor: videoPresetBtn }));
    videoRandomBtn.addEventListener("click", async () => {
        try {
            const text = await randomPromptText("video");
            if (!text.trim()) { toast(t("提示词库为空，抽不到视频提示词")); return; }
            fillVideoPrompt(text);
        } catch (e) { toast(String(e?.message || e)); }   // 同上：离线那一发的原因由 randomPromptText 说清楚
    });
    page.appendChild(videoBar);
    // ⋯ 菜单挂在页面上（.rs-runtime-menu 是 fixed 定位，随页面离场由 onDocPress 摘监听）
    page.appendChild(videoMoreMenu);


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
            statusEl.textContent = t("排队中…· 顶栏「队列」看进度");
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
                : t("该技能需要参考素材：至少选一张图 / 视频 / 音频");
            return;
        }
        // 特效技能缺本体的文件就不进队列：缺嵌入的那一发跑完也只是「没有特效的片」（ComfyUI 读不到
        // embedding: 段只 warning 后忽略），预检自带「去模型库」直达，与生图的生成前预检同一条
        const effect = skillEffects().length ? effectSel.value : "";
        const blocked = await blockingMissingModels(skillSel.value, effect);
        if (blocked) {
            statusEl.textContent = blocked;
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
        if (effect) body.effect = effect;   // 特效表技能交特效 id；后端认这个 id 拼嵌入段与特效契约
        // 自定参数只带非空项：空 = 这一发跟着技能配置与全局生视频设置走（与生图覆盖同一口径）
        if (videoModels) {
            const ov = videoCfg.collect();
            if (ov.model) body.model = ov.model;
            if (ov.text_encoder) body.text_encoder = ov.text_encoder;
            if (ov.vae) body.vae = ov.vae;
            if (ov.audio_vae) body.audio_vae = ov.audio_vae;
            // 步数只在用户改过面板时才发：特效技能把步数钉在特效项上，发了就把那一发契约改了
            if (ov.steps && !videoCfg.stepsFollowSkill()) body.steps = ov.steps;
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
            queueTrack("simple", data, { label: body.prompt });
            toast(tf("已加入队列：{label} · 顶栏「队列」看进度", { label: body.prompt.slice(0, 40) }));
            runBtn.disabled = false;   // 提交成功就把按钮交回：这一发在顶栏队列里跑，用户能接着排下一发
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

    // 素材卡「再来一发」：这一发的生效参数（副文件记的）填回本页 composer。面板常驻不重建，
    // 只换内容；逐项校验，面板认不出的（技能不在下拉、模型不在清单与家族判定内、时长不在档位、
    // 随机种子）整项不填，填完的清单交给复用提示。
    const prefillVideo = async (reuse) => {
        await skillsReady;
        const filled = [];
        const skillId = String(reuse?.skill || "");
        const hasSkill = skillId && [...skillSel.options].some((o) => o.value === skillId);
        if (hasSkill) {
            skillSel.value = skillId;
            skillChip.sync();
            applyVideoSlots();
            applyEffectOptions();
            try { localStorage.setItem(VIDEO_LAST_SKILL_KEY, skillId); } catch { /* 隐私模式记不住就算了 */ }
            filled.push(t("技能与自定参数"));
        } else if (skillId) {
            // 技能被删了或换了类：下拉里没有这一项就填不进去，说清是哪一张、去哪改，其余项照填
            toast(tf("技能「{skill}」在这页没有位置：技能项没填，到技能页改这张技能再回来", { skill: skillId }));
        }
        // 特效项认这一发记的那个特效 id：认得才填，认不出就停在技能默认那一个（不写假承诺）
        const effectId = String(reuse?.effect || "");
        if (effectId && [...effectSel.options].some((o) => o.value === effectId)) {
            effectSel.value = effectId;
            applyEffectPrompt();
            effectChip.sync();
            filled.push(t("特效"));
        }
        const f2v = hasSkill && videoModeGroup(selectedMeta()) === "f2v";
        const src = reuse?.src?.filename ? reuse.src : null;
        const last = reuse?.last?.filename ? reuse.last : null;
        const refs = (reuse?.refs || []).filter((r) => r?.filename);
        firstSlot.fill(f2v && src ? [src] : []);
        lastSlot.fill(f2v && last ? [last] : []);
        refSlot.fill(f2v ? [] : [src, ...refs].filter(Boolean));
        const mediaNames = [];
        if (f2v) {
            if (src) mediaNames.push(t("首帧"));
            if (last) mediaNames.push(t("尾帧"));
        } else if (src || refs.length) {
            mediaNames.push(t("参考素材"));
        }
        if (mediaNames.length) filled.push(mediaNames.join("、"));
        const seed = Number(reuse?.seed);
        if (Number.isFinite(seed) && seed >= 0) {
            seedIn.value = String(seed);
            filled.push(t("种子"));
        }
        if (reuse?.width && reuse?.height) {
            const value = `${reuse.width},${reuse.height}`;
            if ([...sizeSel.options].some((o) => o.value === value)) {
                sizeSel.value = value;
                filled.push(t("出片尺寸"));
            }
        }
        if (reuse?.duration && VIDEO_DUR_CHOICES.includes(Number(reuse.duration))) {
            durSel.value = String(Number(reuse.duration));
            filled.push(t("时长"));
        }
        if (String(reuse?.prompt || "").trim()) {
            promptIn.value = String(reuse.prompt).trim();
            promptCount.textContent = `${promptIn.value.length} / ∞`;
            filled.push(t("提示词"));
        }
        // 自定参数整块 = 那一发的生效值盖在技能配置上；主模型与 LoRA 只留清单里还在盘上的
        await modelsReady;
        if (hasSkill && videoModels) {
            const ov = reuseModelOverlay(reuse, videoModels, selectedMeta());
            const cfgOv = { ...ov };
            for (const key of ["text_encoder", "vae", "audio_vae"]) {
                const name = reuse?.[key];
                const pool = key === "text_encoder" ? videoModels.text_encoders : videoModels.vae;
                if (name && (pool || []).includes(name)) cfgOv[key] = name;
            }
            if (Number(reuse?.steps) >= 1) cfgOv.steps = Number(reuse.steps);
            await applySkillConfig(skillId, cfgOv);
        }
        return filled;
    };
    setVideoReuseOpen((reuse) => {
        go("video");   // 走 hash 换页（与绘画页入口同一约定），本页在位时只显隐
        return prefillVideo(reuse);
    });
}


// ====== 技能页：引导页（默认）+ 统一技能管理（技能列表 / 新建模板技能 / 导入工作流）======
// 起手版式照导演页 / 绘画页 / 视频页的空白态（.neo-gallery-gm-idle 主行 + 细注行 + 四角括号）；
// 管理组件点了入口才装配：落地在引导页时不拉技能列表，也不铺一块空列表出来。
function buildSkills(el) {
    el.classList.add("ns-skills");
    const page = $el("div", { className: "ns-skills-page" });
    el.appendChild(page);

    const managerHost = $el("div", { className: "ns-skills-manager" });
    let mgr = null;
    let building = null;   // 装配中的管理者：连点入口不会叠出两份

    // 返回引导页：内嵌详情有未保存修改时先确认，再卸掉整个管理组件（下次进列表重新装配）
    const showGuide = () => {
        if (mgr?.isDirty() && !confirm(t("当前技能有未保存的修改，返回引导页将丢弃这些修改。"))) return;
        mgr?.close();
        mgr = null;
        page.classList.remove("ns-skills-editing");
    };

    const ensureManager = () => {
        if (mgr) return Promise.resolve(mgr);
        if (building) return building;
        building = Promise.resolve().then(() => {
            const m = createSkillManager(managerHost, { showClose: false, showCanvasBtn: false, autoSelect: false });
            // 列表态的标题条兼作返回引导页的入口；页里没有可拖的窗，标题就写这一块的名字
            m.head.querySelector(".rs-skill-manager-title").textContent = t("技能列表");
            const back = $el("button", { className: "ns-skills-back", type: "button", textContent: t("← 引导页"), title: t("返回技能引导页") });
            back.addEventListener("click", showGuide);
            m.head.prepend(back);
            mgr = m;
            return m;
        }).finally(() => { building = null; });
        return building;
    };

    // 进列表：list = 选中默认展开分类的第一项，new = 直接开新建表单，不传 = 只铺列表（导入后按 id 定位）
    const showManager = async (mode) => {
        const m = await ensureManager();
        page.classList.add("ns-skills-editing");
        await m.ready;
        if (mgr !== m) return m;   // 装配途中已经回到引导页：别再把详情铺进已卸掉的面板
        if (mode === "new") await m.openNew();
        else if (mode === "list") await m.selectFirst();
        return m;
    };

    const importBtn = $el("button", { className: "ns-btn", type: "button", title: t("选择 ComfyUI 导出的 API 工作流（.json），新建一份带工作流的生成技能") });
    setIconLabel(importBtn, "folder", t("导入工作流"));
    const newBtn = $el("button", { className: "ns-btn", type: "button", title: t("写一份 skill.md 模板技能，不绑定工作流") });
    setIconLabel(newBtn, "pencil", t("新建模板技能"));
    const listBtn = $el("button", { className: "ns-btn", type: "button", title: t("浏览、编辑和删除已有技能") });
    setIconLabel(listBtn, "list", t("技能列表"));
    newBtn.onclick = () => showManager("new");
    listBtn.onclick = () => showManager("list");

    const fileInput = $el("input", { type: "file", accept: ".json,application/json", className: "ns-skills-file" });
    fileInput.hidden = true;
    importBtn.onclick = () => { fileInput.value = ""; fileInput.click(); };
    fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        fileInput.value = "";   // 同一个文件再选一次也要触发 change
        if (!file) return;
        let text;
        try { text = await file.text(); }
        catch { toast(t("导入失败：无法读取文件")); return; }
        let data;
        try { data = JSON.parse(text); }
        catch { toast(t("导入失败：文件不是合法的 JSON")); return; }
        const problem = workflowImportProblem(data);
        if (problem) { toast(t("导入失败：") + problem); return; }
        let saved;
        try {
            saved = await importWorkflowSkill(data, file.name.replace(/\.json$/i, "") || "my-workflow");
        } catch (e) {
            toast(tf("导入失败：{msg}", { msg: e.message }));
            return;
        }
        if (!saved) return;   // 命名对话框取消
        const m = await showManager();
        if (mgr !== m) return;   // 列表铺开前已经回到引导页
        await m.openSkill(saved.id);
    });

    const guide = $el("div", { className: "ns-skills-guide" }, [
        $el("div", { className: "ns-skills-guide-card neo-gallery-gm-idle" }, [
            $el("div", { className: "neo-gallery-gm-idle-title", textContent: t("技能") }),
            $el("div", { className: "neo-gallery-gm-idle-sub", textContent: t("导入工作流，或从模板新建技能") }),
            $el("i", { className: "ns-video-corner c-tl" }),
            $el("i", { className: "ns-video-corner c-tr" }),
            $el("i", { className: "ns-video-corner c-bl" }),
            $el("i", { className: "ns-video-corner c-br" }),
        ]),
        $el("div", { className: "ns-skills-guide-actions" }, [importBtn, newBtn, listBtn]),
    ]);
    page.append(guide, managerHost, fileInput);
}

// 导入只收 API 工作流（扁平的 node_id → { class_type, inputs }）：ComfyUI 直接点「保存」给出的是
// 界面工作流（nodes / links），塞进技能目录后渲染不出能提交的 API prompt。返回空串 = 可以导入。
function workflowImportProblem(data) {
    if (!data || typeof data !== "object" || Array.isArray(data) || !Object.keys(data).length)
        return t("文件里没有工作流");
    if (Array.isArray(data.nodes) || Array.isArray(data.links))
        return t("这是 ComfyUI 的界面工作流，请在 ComfyUI 里用「导出（API）」保存后再导入");
    for (const node of Object.values(data)) {
        if (!node || typeof node !== "object" || typeof node.class_type !== "string"
            || !node.inputs || typeof node.inputs !== "object")
            return t("文件不是 API 工作流（节点缺少 class_type / inputs）");
    }
    return "";
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
    const poseIn = input(t("3d-pose-art 仓库根（留空 = 不自动同步）"));
    poseIn.classList.add("ns-launch-pose");
    const listenSel = $el("select", { className: "ns-launch-input ns-launch-listen" });
    const status = $el("div", { className: "ns-launch-status" });
    const info = $el("div", { className: "ns-launch-info" });
    const lanHint = $el("div", { className: "ns-launch-info" });
    const browseBtn = $el("button", { className: "ns-btn", textContent: t("浏览…") });
    const pyBrowseBtn = $el("button", { className: "ns-btn", textContent: t("浏览…") });
    const poseBrowseBtn = $el("button", { className: "ns-btn", textContent: t("浏览…") });
    const applyBtn = $el("button", { className: "ns-btn ns-launch-apply", textContent: t("保存并重启 ComfyUI") });
    const depsBtn = $el("button", { className: "ns-btn", textContent: t("安装依赖") });
    const fixBtn = $el("button", { className: "ns-btn", textContent: t("重试安装插件") });
    const framelessIn = $el("input", { type: "checkbox", className: "ns-launch-frameless" });
    const devIn = $el("input", { type: "checkbox", className: "ns-launch-dev" });
    const kernelState = $el("div", { className: "ns-kernel-state" });
    const startBtn = $el("button", { className: "ns-btn ns-kernel-start", textContent: t("▶ 启动内核") });
    const stopBtn = $el("button", { className: "ns-btn ns-kernel-stop", textContent: t("■ 停止内核") });
    // 一键打开这一路 ComfyUI 的地址：无边框窗口里没有新标签可开，点了交桌面端的桥开系统浏览器
    const openBtn = $el("button", { className: "ns-btn ns-kernel-open", textContent: t("打开 ComfyUI") });
    let kernelUrl = "";
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
            + "ComfyUI 没有鉴权：防火墙放行该端口，只在你信任的网段开。改完点「保存并重启 ComfyUI」。\n"
            + "放开后「设置 → 手机连接」才会出手机扫码用的二维码。",
        remote: "连远端那台 ComfyUI：http(s)://主机[:端口]，留空 = 连本机。\n"
            + "前提：远端已装 comfyui-neo-studio 插件，并在远端自己的「启动设置 → 局域网监听」放开监听。\n"
            + "远程模式本机不启动也不停止 ComfyUI：「启动内核」= 重连远端，「停止内核」禁用，"
            + "根目录 / 解释器 / 端口 / 局域网监听归远端管。\n"
            + "改完点「保存并重启 ComfyUI」，窗口直接开在远端页面。",
        frameless: "桌面端窗口自绘标题栏（最小化 / 最大化 / 全屏 / 关闭），勾掉回系统标题栏。\n"
            + "立刻生效并写进启动配置，下次开机沿用。",
        dev: "打开刷新键 / 右键菜单 / 开发者工具，排查窗口白屏与前端问题用。\n"
            + "pywebview 在建窗口时定值：勾完要重启桌面端窗口才生效。",
        poseRepo: "3d-pose-art 仓库根（带 pose-lib 那一层目录）：填上后桌面端每次启动自动把 dist 姿势包与 "
            + "pose-lib 姿势库补进数据根，pose 数据更新后姿势页不会停在旧构建与空白缩略图上。\n"
            + "保存这一行会立刻在后台同步一次；留空 = 不自动同步，姿势页停在数据根现有那份与随包副本上。",
    };
    const infoDot = (tip) => $el("span", { className: "ns-info", textContent: "i", tabindex: "0", "data-tip": tip });
    const row = (label, tip, ...kids) => $el("div", { className: "ns-launch-row" },
        [$el("span", { className: "ns-launch-label" }, [label, infoDot(tip)]), ...kids]);
    const rootRow = row(t("ComfyUI 根目录"), t(TIPS.root), rootIn, browseBtn);
    const pyRow = row("Python", t(TIPS.python), pyIn, pyBrowseBtn);
    const portRow = row(t("端口"), t(TIPS.port), portIn);
    const listenRow = row(t("局域网监听"), t(TIPS.listen), listenSel);
    const remoteRow = row(t("远程 ComfyUI"), t(TIPS.remote), remoteIn);
    const poseRow = row(t("姿势仓库"), t(TIPS.poseRepo), poseIn, poseBrowseBtn);
    // 远程模式下这几项归远端那台机器管：灰掉，别让本机设置看起来能影响远端
    const localRows = [rootRow, pyRow, portRow, listenRow, poseRow];
    const localInputs = [rootIn, pyIn, portIn, listenSel, browseBtn, pyBrowseBtn, poseIn, poseBrowseBtn];

    const STATE_TEXT = {
        ok: "就绪",
        remote_ok: "远程就绪",
        remote_down: "远程不可达",
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
        poseIn.value = s.pose_repo || "";
        renderLocalMode(!!s.remote);
        lanIps = s.lan_ips || [];
        const opts = LAN_CHOICES.concat(lanIps.map((ip) => [ip, tf("本机网卡 {ip}", { ip })]));
        const key = lanKey(s.listen);
        if (!opts.some(([v]) => v === key)) opts.push([key, tf("已保存：{key}", { key })]);
        listenSel.replaceChildren(...opts.map(([v, label]) => $el("option", { value: v, textContent: t(label) })));
        listenSel.value = key;
        renderLanHint();
        status.textContent = t(STATE_TEXT[s.state] || s.state || "") + (s.error ? ` · ${s.error}` : "");
        status.classList.toggle("ns-launch-bad", !!s.state && s.state !== "ok" && s.state !== "remote_ok");
        info.textContent = tf("插件 {plugin} · 状态 {state} · {mode}", {
            plugin: s.plugin_dir, state: s.state_dir, mode: t(s.portable ? "便携模式" : "插件内运行"),
        });
        depsBtn.style.display = s.state === "deps_missing" ? "" : "none";
        fixBtn.style.display = s.state === "install_failed" ? "" : "none";
        framelessIn.checked = !!s.frameless;
        devIn.checked = !!s.dev_mode;
        framelessRow.style.display = s.platform === "mac" ? "none" : "";
    }

    // 动作 → 桌面端 js_api 上的方法名：桥在就直接问桌面端，不在才走桌面端服务的 HTTP 路由
    const BRIDGE_FN = { apply: "apply_launcher", install_plugin: "install_plugin", install_deps: "install_deps", set_frameless: "set_frameless", set_dev_mode: "set_dev_mode", set_pose_repo: "set_pose_repo" };
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
                            : action === "set_pose_repo"
                                ? await fn(payload.pose_repo)
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
    poseBrowseBtn.addEventListener("click", async () => {
        const picked = await window.pywebview?.api?.pick_pose_repo?.();
        if (picked) poseIn.value = picked;
    });
    poseIn.addEventListener("change", () => post({ action: "set_pose_repo", pose_repo: poseIn.value.trim() }));
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

    // 内核启停在面板顶部：状态一行 + 启动 / 停止 / 打开地址三枚按钮，此刻做不了的那枚禁用、上不了页面的收起
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
        // 地址取桌面端报的那一份：本机端口被占用时它会换到下一个空闲端口，配置里那个端口不一定在听
        kernelUrl = s.remote || `http://127.0.0.1:${s.port || 8188}`;
        openBtn.title = tf("在浏览器打开 {url}", { url: kernelUrl });
        openBtn.style.display = running ? "" : "none";   // 端口没人在听时打开就是浏览器报错页
    }
    onComfyState(renderKernel);
    startBtn.addEventListener("click", () => { startBtn.disabled = true; startKernel(); });
    stopBtn.addEventListener("click", () => { stopBtn.disabled = true; stopKernel(); });
    openBtn.addEventListener("click", () => openExternalUrl(kernelUrl));

    const framelessRow = row(t("无边框窗口"), t(TIPS.frameless), framelessIn);
    const devRow = row(t("开发模式"), t(TIPS.dev), devIn);

    const el = $el("div", { className: "ns-settings-section" }, [
        $el("h3", { textContent: t("启动设置") }),
        $el("div", { className: "ns-kernel" }, [
            kernelState,
            $el("div", { className: "ns-kernel-actions" }, [startBtn, stopBtn, openBtn]),
        ]),
        status,
        // 栏内九行分三类：这台机器上的 ComfyUI 在哪、这个端口谁连得到、桌面窗口自己的样子。平铺时「局域网监听」与「远程 ComfyUI」
        // 看不出是一回事，无边框 / 开发模式又混在 ComfyUI 设置里。启停与状态行始终在顶部，保存按钮管前三类
        $el("div", { className: "ns-launch-group", textContent: t("ComfyUI 位置") }),
        rootRow,
        pyRow,
        $el("div", { className: "ns-launch-group", textContent: t("网络与端口") }),
        portRow,
        listenRow,
        remoteRow,
        $el("div", { className: "ns-launch-group", textContent: t("桌面窗口") }),
        framelessRow,
        devRow,
        $el("div", { className: "ns-launch-group", textContent: t("姿势资产") }),
        poseRow,
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

// ====== 设置页：左侧 tab 切换（LLM / 生图 / 生视频 / 智能体偏好 / MCP 服务 / 首页 / 界面语言 / 日志 / 启动设置 / 关于），默认 LLM ======
let settingsShow = null;   // 设置页的 tab 切换函数：深链 #/settings?tab=mcp 要用它落到那一栏

let agentPrefs = null;   // 设置页那张偏好表单：深链 #/settings?tab=agent&skill=.. 的预填要走它

function buildSettings(el) {
    // 三个表单工厂均返回 { el, load, save, isDirty }，挂 .el、后台 load（保存按钮在表单内部）
    const genForm = createImageGenSettingsForm();
    const videoForm = createVideoGenSettingsForm();
    const llmForm = createModelConfigForm();

    // 日志面板：tab 激活时轮询。桌面端里两份日志分块 —— 内核那块是桌面端拉起 ComfyUI 的输出，
    // 桌面端那块是自身的启动 / 跳转 / 前端错误轨迹；浏览器标签页只有内核那一块，来源筛选不上页面
    const logBody = $el("pre", { className: "ns-log" });
    let logTimer = null;
    let logStick = true;   // 贴底才自动滚；用户往上翻看时停住，翻回底部恢复
    let logEntries = [];   // 最近一轮的条目：切来源只重渲染这一份，不为此多发一次请求
    let logSrc = "all";

    const logAtBottom = () =>
        logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight <= 40;
    logBody.addEventListener("scroll", () => { logStick = logAtBottom(); });

    // 每 2 秒整段重写 <pre> 会把拖到一半的选区抹掉；选区落在日志里就跳过这一轮刷新
    const logSelected = () => {
        const sel = window.getSelection();
        return !!sel && !sel.isCollapsed && logBody.contains(sel.anchorNode);
    };

    // 按钮只给短标签（390 宽的手机上整行放不下全称），完整来源名留在鼠标提示与块标题里
    const SRC_BTN = { all: "全部", studio: "桌面端", comfy: "内核" };
    const SRC_TITLE = {
        all: "按来源筛选日志",
        studio: "只看 Neo Studio 桌面端日志",
        comfy: "只看 ComfyUI 内核日志",
    };
    const SRC_HEAD = { studio: "Neo Studio 桌面端", comfy: "ComfyUI 内核" };
    const srcBtns = {};
    const logSrcBar = $el("div", { className: "ns-log-srcs" });
    for (const key of ["all", "studio", "comfy"]) {
        srcBtns[key] = $el("button", {
            className: "ns-btn ns-log-src-btn",
            title: t(SRC_TITLE[key]),
            textContent: t(SRC_BTN[key]),
            onclick: () => {
                logSrc = key;
                paintLog();
                paintSrcBar();
                if (logStick) logBody.scrollTop = logBody.scrollHeight;
            },
        });
        logSrcBar.appendChild(srcBtns[key]);
    }

    // 只有一块时不分块：浏览器标签页里没有桌面端那一路，块标题与「桌面端」筛选钮都是多余控件
    const logSplit = () => logEntries.some((e) => e.src === "studio");

    function paintSrcBar() {
        const split = logSplit();
        for (const key of Object.keys(srcBtns)) {
            srcBtns[key].classList.toggle("is-on", key === logSrc);
            srcBtns[key].style.display = key === "studio" && !split ? "none" : "";
        }
    }

    function paintLog() {
        // 条目是原始 stdout，自带换行与 ANSI 色码；色码在网页里是乱码，剥掉
        const split = logSplit();
        const nodes = [];
        let shown = null;
        for (const e of logEntries) {
            const src = e.src || "comfy";
            if (logSrc !== "all" && src !== logSrc) continue;
            if (split && src !== shown) {
                nodes.push($el("span", { className: "ns-log-src", textContent: `—— ${t(SRC_HEAD[src])} ——\n` }));
                shown = src;
            }
            nodes.push(String(e.m).replace(/\x1b\[[0-9;]*m/g, ""));
        }
        logBody.replaceChildren(...nodes);
    }

    async function refreshLog() {
        if (logSelected()) return;
        try {
            const data = await (await api.fetchApi("/neo_studio/log")).json();
            logEntries = data.entries || [];
            paintLog();
            paintSrcBar();
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
    const launcher = createLauncherPanel();
    const mcp = createMcpPanel();
    const pairPanel = createPairPanel({ api, t, tf, toast });
    const prefs = createAgentPrefsForm({
        previewMode: () => previewOn, setPreviewMode: applyPreviewMode,
    });
    agentPrefs = prefs;   // 深链带预填参数进来时，route() 要把焦点链那份值交给这张表单

    const section = (title) => $el("h3", { textContent: t(title) });
    // 左栏自上而下四段：启动与连接（启动设置 / 启动日志 / 手机连接）· 生成（LLM / 生图 / 生视频）·
    // 智能体（偏好 / MCP）· 语言与关于（界面语言 / 关于）。十项平铺时找「生图默认值」要逐条扫，
    // 段之间只落一条无文字的细线，界面上的行数就等于设定项的数目；tab 的 key 与深链 #/settings?tab=.. 全不变
    // （首页版式不在这里排——它由首页右上角「编辑首页」原地改，见 web/studio/home-layout.js）
    const sections = [
        { key: "launch", group: "startup", label: t("启动设置"), body: launcher.el },
        { key: "log", group: "startup", label: t("启动日志"), body: $el("div", { className: "ns-settings-section ns-log-section" }, [$el("div", { className: "ns-log-head" }, [section("启动日志"), logSrcBar, copyLogBtn]), logBody]) },
        { key: "pair", group: "startup", label: t("手机连接"), body: pairPanel.el },
        { key: "llm", group: "generate", label: t("LLM 设置"), body: $el("div", { className: "ns-settings-section" }, [section("LLM 设置"), llmForm.el]) },
        { key: "gen", group: "generate", label: t("生图设置"), body: $el("div", { className: "ns-settings-section" }, [section("生图设置"), genForm.el]) },
        { key: "video", group: "generate", label: t("生视频设置"), body: $el("div", { className: "ns-settings-section" }, [section("生视频设置"), videoForm.el]) },
        { key: "agent", group: "agent", label: t("智能体偏好"), body: $el("div", { className: "ns-settings-section" }, [section("智能体偏好"), prefs.el]) },
        { key: "mcp", group: "agent", label: t("MCP 服务"), body: $el("div", { className: "ns-settings-section ns-mcp-section" }, [section("MCP 服务"), mcp.root]) },
        { key: "lang", group: "ui", label: t("界面语言"), body: $el("div", { className: "ns-settings-section" }, [section("界面语言"), createLangPanel()]) },
        { key: "about", group: "ui", label: t("关于"), body: $el("div", { className: "ns-settings-section ns-about-section" }, [section("关于"), $el("div", { className: "ns-about-version", id: "ns-about-version", textContent: versionText() }), $el("div", { className: "ns-about-rows", id: "ns-about-rows" })]) },
    ];

    const tabs = $el("div", { className: "ns-settings-tabs" });
    const content = $el("div", { className: "ns-settings-content" });
    const showSection = (key) => {
        // 认不出的 tab 名落回默认栏：旧书签里的 #/settings?tab=home（首页版式已并到首页原地编辑）
        // 走进原来那套循环会让每一块 body 都 display:none，设置页开成一片空白
        if (!sections.some((s) => s.key === key)) key = "llm";
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
        } else if (key === "pair") {
            pairPanel.refresh();   // 二维码倒计时要跟着秒走，离开这栏就停轮询
        } else {
            pairPanel.stop();
            if (logTimer) {
                clearInterval(logTimer);
                logTimer = null;
            }
        }
    };
    settingsShow = showSection;
    let lastGroup = null;
    for (const s of sections) {
        if (s.group !== lastGroup) {   // 段间线与 tab 平级放在左栏里：测试与深链都按 [data-key] 取 tab，线只做切段
            if (tabs.children.length) tabs.appendChild($el("div", { className: "ns-settings-sep" }));
            lastGroup = s.group;   // 首组顶部不落线，摘掉整组 tab（浏览器形态的启动设置）之后条首不悬空线
        }
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
    [".ns-reverse-run", "prompt_reverse", t("反推")],
    [".ns-voice-run", "voice", t("生成")],
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

function route() {
    let name = (location.hash || "#/home").replace(/^#\//, "").split("?")[0] || "home";
    if (name !== "home") stopHomeEdit();   // 离开首页即弃草稿：首页视图是常驻显隐的，编辑态不能跟着页签留到下一页回来
    // 首页 / 导演页 / 绘画页 / 编辑页视图常驻：首页卡片直达后三页，内嵌宿主要在第一次点
    // 「新建导演配方 / 生成素材 / 图片编辑」之前就要注册好
    ensureView("home", buildHome);
    ensureView("director", buildDirector);
    ensureView("paint", buildPaint);
    ensureView("edit", buildEdit);
    if (name === "skills") ensureView("skills", buildSkills);
    else if (name === "video") ensureView("video", buildVideo);
    else if (name === "agent") ensureView("agent", buildAgentPage);
    else if (name === "pose") ensureView("pose", buildPose);
    else if (name === "frames") ensureView("frames", buildFrames);
    else if (name === "reverse") ensureView("reverse", buildReverse);
    else if (name === "voice") ensureView("voice", buildVoiceClone);
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
    // 认不出的 tab 名（深链、别的构建里已删掉的页）没有视图可显：showView 会把全部视图一起隐掉，
    // 窗口停在只剩顶栏的空白页
    if (!views.has(name)) name = "home";
    // 深链带的那一个目标要落到刚建好的页上：#/?recipe= 开那一份导演配方
    const deep = new URLSearchParams(location.hash.split("?")[1] || "");
    if (name === "director" && deep.get("recipe")) directorOpenRecipe?.(deep.get("recipe"));
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
