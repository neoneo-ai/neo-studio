/**
 * 顶栏「队列」面板：Studio 各页提交进 ComfyUI 执行队列的生成任务，一处看进度、取消与产物。
 *
 * 六张任务表（生图 / 语音 / 整片 / 简单视频 / 单段 / 拼接）各有一条 rs.*.status 事件，面板吃这六条
 * 事件实时推进；打开面板与 WS 重连时补一次 GET /neo_studio/queue 播种，除此之外不轮询。
 * 页面提交成功后调 queueTrack 登记这一发并把编辑区交回用户，进度落在这里。
 * 队列是 ComfyUI 运行时功能：桌面端离线时 initQueuePanel 把顶栏入口整块收掉。
 */
import { $el } from "../../../../scripts/ui.js";
import { api } from "../../../../scripts/api.js";
import { Lightbox } from "./lightbox.js";
import { t, tf } from "./js/core/i18n.js";
import { setIcon } from "./js/core/icons.js";

// 类别 → 后端各模块的任务快照事件（image_gen / voice_gen / studio / simple_video / h3_segment / h3_assemble）
const STATUS_EVENTS = {
    image: "rs.image_gen.status",
    voice: "rs.voice_gen.status",
    film: "rs.director.status",
    simple: "rs.simple_video.status",
    segment: "rs.segment.status",
    assemble: "rs.assemble.status",
};
// 类别 → 取消路由：沿用各页已有的取消接口，队列不另立第二条
const CANCEL_ROUTES = {
    image: (id) => `/neo_image_gen/cancel/${id}`,
    voice: (id) => `/neo_voice/cancel/${id}`,
    film: (id) => `/neo_studio/director/${id}/cancel`,
    simple: (id) => `/neo_video_gen/simple/${id}/cancel`,
    segment: (id) => `/neo_video_gen/run_segment/${id}/cancel`,
    assemble: (id) => `/neo_video_gen/assemble_segments/${id}/cancel`,
};
const KIND_LABEL = { image: "生图", voice: "语音", film: "整片", simple: "视频", segment: "单段", assemble: "拼接" };
const STATUS_LABEL = { queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败", cancelled: "已取消" };
const ACTIVE = ["queued", "running"];
const LIMIT = 48;   // 与后端 /neo_studio/queue 的行数上限同一份
const MEM_POLL_MS = 3000;   // 显存 / 内存读数的刷新节拍（面板展开时才有这一条）

const rows = new Map();   // task_id -> 行：面板与各页共用这一份
let renderPanel = null;   // createQueuePanel 挂上的重画回调
let toast = null;         // 宿主提示（Studio 顶栏的 toast）
let goPage = null;        // 宿主换页（面板「到该页」）
let canQueue = () => false;
let canMem = () => false;
let toggleEl = null;
let panelEl = null;
let memStrip = null;      // 显存 / 内存读数 + 清理：只在面板展开时轮询
let memTimer = null;

function labelOf(kind, snap) {
    if (kind === "film") return String(snap.recipe || "");
    if (kind === "segment") return `${snap.recipe || ""} ${tf("第 {n} 段", { n: Number(snap.segment) + 1 })}`;
    if (kind === "assemble") return `${snap.recipe || ""} ${tf("拼接 {n} 段", { n: (snap.use || []).length })}`;
    return String(snap.prompt || "").slice(0, 40);
}

function resultOf(kind, snap) {
    const list = kind === "image" ? (snap.images || []) : kind === "voice" ? (snap.audios || []) : [];
    const entry = list[0] || (snap.filename ? { filename: snap.filename, subfolder: snap.subfolder } : null);
    if (!entry?.filename) return null;
    return { filename: entry.filename, subfolder: entry.subfolder || "", url: entry.url || "", count: list.length || 1 };
}

function rowOf(kind, snap, label) {
    return {
        kind,
        task_id: snap.task_id,
        status: snap.status,
        label: label || snap.label || labelOf(kind, snap),
        progress: snap.progress || null,
        created: Number(snap.created) || 0,
        updated: Number(snap.updated) || 0,
        page: snap.page || "",
        result: resultOf(kind, snap),
    };
}

function prune() {
    if (rows.size <= LIMIT) return;
    const idle = [...rows.values()].filter((r) => !ACTIVE.includes(r.status)).sort((a, b) => a.updated - b.updated);
    for (const row of idle) {
        if (rows.size <= LIMIT) break;
        rows.delete(row.task_id);
    }
}

function publish() {
    prune();
    if (renderPanel) renderPanel();
    renderBadge();
}

/** 页面提交成功后登记这一发：kind 是类别，snap 是提交返回的任务快照，
 *  opts.label 覆盖面板上的标签（提示词 / 配方名），opts.page 指定「到该页」的落点。 */
export function queueTrack(kind, snap, opts = {}) {
    if (!snap?.task_id) return null;
    const row = rowOf(kind, snap, opts.label);
    if (opts.page) row.page = opts.page;
    rows.set(row.task_id, row);
    publish();
    return row;
}

function merge(kind, snap) {
    if (!snap?.task_id) return;
    const row = rows.get(snap.task_id);
    if (row) {
        row.status = snap.status || row.status;
        row.progress = snap.progress || null;
        row.updated = Number(snap.updated) || row.updated;
        const result = resultOf(kind, snap);
        if (result) row.result = result;
    } else {
        rows.set(snap.task_id, rowOf(kind, snap));   // 别的窗口提交的任务：状态事件先到就先建出行
    }
    publish();
}

// 播种：进面板与 WS 重连各补一次，把断档期间结束的与别的窗口提交的任务补齐
async function seed() {
    if (!canQueue()) return;
    try {
        const r = await api.fetchApi("/neo_studio/queue");
        const data = await r.json();
        if (!data?.success) return;
        for (const row of data.rows || []) {
            const kept = rows.get(row.task_id);
            rows.set(row.task_id, { ...row, label: row.label || kept?.label || "" });
        }
        publish();
    } catch { /* 播种失败就停在已知的那几行：六条状态事件照样能建行 */ }
}

function renderBadge() {
    const badge = document.getElementById("ns-queue-badge");
    if (!badge) return;
    const n = [...rows.values()].filter((r) => ACTIVE.includes(r.status)).length;
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.hidden = n === 0;
}

function viewUrl(result) {
    if (result.url) return result.url;
    return `/view?filename=${encodeURIComponent(result.filename)}`
        + `&subfolder=${encodeURIComponent(result.subfolder || "")}&type=output`;
}

// 缩略图走素材库那条缓存路由：图片 Pillow 缩放、视频 ffmpeg 取首帧，按 路径+mtime+尺寸 落盘缓存。
// 音频不出图（后端 _thumbnail_payload 对音频返回 None），所以语音行不铺缩略格。
const THUMB_SIZE = 96;
const VIDEO_KINDS = ["film", "simple", "segment", "assemble"];

function thumbUrl(result) {
    return `/neo_gallery/thumbnail?filename=${encodeURIComponent(result.filename)}`
        + `&subfolder=${encodeURIComponent(result.subfolder || "")}&size=${THUMB_SIZE}`;
}

/** 播放器 URL：视频行点开走 Lightbox 的 video 槽，与视频页预览同源。 */
function playUrl(result) {
    return `${window.location.protocol}//${window.location.host}/neo_gallery/video`
        + `?filename=${encodeURIComponent(result.filename)}&subfolder=${encodeURIComponent(result.subfolder || "")}`;
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 提交时刻：列表按天分组，行内只给本地的时:分（ComfyUI 任务队列同款读法）。 */
function clockOf(epochSec) {
    const d = new Date(epochSec * 1000);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 时长：终态行是 updated-created 的落定值，进行中的行跟着最近一次状态事件走。 */
function durOf(from, to) {
    return `${Math.max(0, to - from).toFixed(2)}s`;
}

/** 行分组标签：今天 / 昨天 / 年月日，按提交时刻落在哪一天。 */
function dayOf(epochSec) {
    const day = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    const days = Math.round((day(Date.now()) - day(epochSec * 1000)) / 86400000);
    if (days === 0) return t("今天");
    if (days === 1) return t("昨天");
    const d = new Date(epochSec * 1000);
    return tf("{y}年{m}月{d}日", { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
}

async function cancelRow(row) {
    const route = CANCEL_ROUTES[row.kind];
    if (!route) return;
    try {
        const r = await api.fetchApi(route(row.task_id), { method: "POST" });
        const data = await r.json().catch(() => null);
        if (!r.ok) { toast?.(tf("取消失败：{msg}", { msg: data?.error || r.status })); return; }
        row.status = "cancelled";   // 后端终态随后经状态事件落地，这里先把面板落到已取消
        publish();
    } catch (e) {
        toast?.(tf("取消失败：{msg}", { msg: e.message }));
    }
}

function openResult(row) {
    const result = row.result;
    if (!result) return;
    if (row.kind === "image") {
        Lightbox.open({ items: [{ kind: "image", url: viewUrl(result), title: result.filename }], index: 0 });
    } else if (VIDEO_KINDS.includes(row.kind)) {
        Lightbox.open({ items: [{ kind: "video", url: playUrl(result), title: result.filename }], index: 0 });
    }
}

/** 缩略格：有产物就铺图（图片缩放 / 视频首帧），出图失败留空格，行本身照常推进度。 */
function thumbEl(row) {
    const box = $el("div", { className: "ns-queue-thumb" });
    if (!row.result || row.kind === "voice") return box;
    const img = $el("img", { src: thumbUrl(row.result), alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => img.remove());   // 缺 ffmpeg 时首帧出不来：留空格，不摆碎图
    box.appendChild(img);
    box.title = `${row.result.filename}（${t("点开预览")}）`;
    box.onclick = () => openResult(row);
    return box;
}

function rowEl(row) {
    const p = row.progress;
    const count = row.count || (row.result && row.result.count) || 1;
    const status = $el("span", {
        className: "ns-queue-status",
        textContent: row.status === "running" && p && p.max
            ? tf("生成中 {value}/{max}", { value: p.value, max: p.max })
            : t(STATUS_LABEL[row.status] || row.status),
    });
    if (row.status === "succeeded") status.classList.add("ns-queue-status-done");
    else if (row.status === "failed" || row.status === "cancelled") status.classList.add("ns-queue-status-failed");
    const bar = $el("div", { className: "ns-queue-bar" }, [
        $el("div", { style: { width: p && p.max ? `${Math.min(100, Math.round(100 * p.value / p.max))}%` : "0%" } }),
    ]);
    bar.hidden = !(row.status === "running" && p && p.max > 0);
    // 第二行：提交时刻 · 时长 · 产物张数。排队中的行还没有时长，跑起来的行随每次状态事件刷新。
    const metaBits = [$el("span", { className: "ns-queue-time", textContent: clockOf(row.created), title: t("提交时间") })];
    if (row.status !== "queued") {
        metaBits.push($el("span", {
            className: "ns-queue-dur", textContent: durOf(row.created, row.updated),
            title: row.status === "running" ? t("已用时长") : t("生成耗时"),
        }));
    }
    if (count > 1) {
        metaBits.push($el("span", {
            className: "ns-queue-cnt", title: t("产物数量"),
            textContent: row.kind === "image" ? tf("{n} 张", { n: count }) : tf("{n} 个", { n: count }),
        }));
    }
    const actions = $el("span", { className: "ns-queue-actions" });
    if (ACTIVE.includes(row.status)) {
        actions.appendChild($el("button", {
            className: "ns-queue-act", type: "button", textContent: t("取消"), onclick: () => cancelRow(row),
        }));
    } else if (row.kind === "image" && row.result) {
        actions.appendChild($el("button", {
            className: "ns-queue-act",
            type: "button",
            textContent: count > 1 ? tf("{n} 张", { n: count }) : t("看图"),
            title: row.result.filename,
            onclick: () => openResult(row),
        }));
    } else if (row.result) {
        actions.appendChild($el("a", {
            className: "ns-queue-act",
            href: viewUrl(row.result),
            target: "_blank",
            rel: "noreferrer",
            textContent: count > 1 ? tf("{n} 个", { n: count }) : t("打开"),
            title: row.result.filename,
        }));
    }
    if (row.page) {
        actions.appendChild($el("button", {
            className: "ns-queue-act", type: "button", textContent: t("到该页"),
            title: t("跳到提交这一发的页面"), onclick: () => goPage?.(row.page),
        }));
    }
    if (!ACTIVE.includes(row.status)) {
        const drop = $el("button", { className: "ns-queue-act ns-queue-drop", type: "button", title: t("从列表移除") });
        setIcon(drop, "cross");
        drop.onclick = () => { rows.delete(row.task_id); publish(); };
        actions.appendChild(drop);
    }
    return $el("div", { className: "ns-queue-row" }, [
        thumbEl(row),
        $el("div", { className: "ns-queue-main" }, [
            $el("div", { className: "ns-queue-top" }, [
                $el("span", { className: "ns-queue-kind", textContent: t(KIND_LABEL[row.kind] || row.kind) }),
                $el("span", { className: "ns-queue-label", title: row.label, textContent: row.label }),
            ]),
            $el("div", { className: "ns-queue-meta" }, metaBits),
            bar,
        ]),
        $el("div", { className: "ns-queue-side" }, [status, actions]),
    ]);
}

/** 面板 DOM：挂在顶栏入口下方，由 initQueuePanel 建好并摆进顶栏。 */
function createQueuePanel() {
    setMemPolling(false);   // 旧面板连同读数条随上一次 boot 的 DOM 一起废掉，别留一张对着死节点的表
    memStrip = null;
    const list = $el("div", { className: "ns-queue-list" });
    const empty = $el("div", { className: "ns-queue-empty", textContent: t("没有生成任务") });
    const el = $el("div", { className: "ns-queue", hidden: true }, [
        $el("div", { className: "ns-queue-head" }, [
            $el("span", { className: "ns-queue-title", textContent: t("队列") }),
            $el("span", { className: "ns-queue-note", textContent: t("任务由 ComfyUI 执行队列排队执行") }),
        ]),
        list, empty,
    ]);
    renderPanel = () => {
        const sorted = [...rows.values()].sort((a, b) => b.created - a.created);
        const active = sorted.filter((r) => ACTIVE.includes(r.status));
        list.textContent = "";
        // 按提交日分组，组首挂一条日期分隔（ComfyUI 任务队列的读法）。
        let day = "";
        for (const row of [...active, ...sorted.filter((r) => !ACTIVE.includes(r.status))]) {
            const label = dayOf(row.created);
            if (label !== day) {
                day = label;
                list.appendChild($el("div", { className: "ns-queue-day", textContent: label }));
            }
            list.appendChild(rowEl(row));
        }
        empty.hidden = sorted.length > 0;
        renderBadge();
    };
    panelEl = el;   // 翻面接上内核后补建读数条要用到它
    return el;
}

// 显存 / 内存读数 + 清理：四条生成页各铺一条的日子结束了，统一在面板头部下面这条，
// 面板展开时才轮询（收起即停表；能力表没有 memory 时整块不出）。
function buildMemStrip() {
    const strip = $el("div", { className: "ns-queue-mem" }, [
        $el("span", { className: "ns-queue-mem-item ns-queue-mem-vram", title: t("GPU 显存占用（含全部进程）"), textContent: `${t("显存")} --` }),
        $el("span", { className: "ns-queue-mem-item ns-queue-mem-ram", title: t("系统内存占用"), textContent: `${t("内存")} --` }),
    ]);
    const btn = $el("button", {
        className: "ns-queue-mem-clear", type: "button",
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
    strip.appendChild(btn);
    return strip;
}

/** 能力翻面补建：离线形态起的面板没有这块，接上 ComfyUI 后开面板才有读数。 */
function ensureMemStrip() {
    if (memStrip || !canMem() || !panelEl) return memStrip;
    memStrip = buildMemStrip();
    panelEl.insertBefore(memStrip, panelEl.querySelector(".ns-queue-list"));
    return memStrip;
}

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
    if (!memStrip) return;
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
    if (vram) setMemItem(memStrip.querySelector(".ns-queue-mem-vram"), vram.vram_used, vram.vram_total, t("显存"));
    if (ram) setMemItem(memStrip.querySelector(".ns-queue-mem-ram"), (ram.ram_total || 0) - (ram.ram_free || 0), ram.ram_total, t("内存"));
}

/** 面板展开即开表、收起即停表：收起后没人看读数，别每 3s 空跑两次请求。 */
function setMemPolling(on) {
    if (!on) {
        if (memTimer) { clearInterval(memTimer); memTimer = null; }
        return;
    }
    if (memTimer || !ensureMemStrip()) return;
    pollMemStats();
    memTimer = setInterval(pollMemStats, MEM_POLL_MS);
}

/**
 * 顶栏入口 + 事件流接线，由 Studio 页在拿到能力表后调用（画布页没有顶栏入口，返回 null）。
 * opts：toast 提示、go 换页、can 能力门控。
 */
export function initQueuePanel(opts = {}) {
    toggleEl = document.getElementById("ns-queue-toggle");
    if (!toggleEl) return null;
    toast = opts.toast || null;
    goPage = opts.go || null;
    const can = opts.can || (() => true);
    canQueue = () => can("queue");
    canMem = () => can("memory");
    panelEl = createQueuePanel();
    document.querySelector(".ns-header")?.appendChild(panelEl);
    toggleEl.onclick = () => {
        panelEl.hidden = !panelEl.hidden;
        if (panelEl.hidden) { setMemPolling(false); return; }
        seed();
        setMemPolling(true);
    };
    for (const [kind, event] of Object.entries(STATUS_EVENTS)) {
        api.addEventListener(event, ({ detail }) => merge(kind, detail));
    }
    api.addEventListener("reconnected", () => seed());
    renderBadge();
    setQueueOnline(canQueue());
    return { refresh: seed, setOnline: setQueueOnline };
}

/** 能力翻面：离线收掉顶栏入口（队列要吃执行队列），就绪后补种一次。 */
export function setQueueOnline(on) {
    if (!toggleEl) return;
    toggleEl.hidden = !on;
    if (!on) {
        panelEl.hidden = true;
        setMemPolling(false);   // 内核停了就读不到数：停表，别每 3s 撞 409
        return;
    }
    ensureMemStrip();   // 离线形态起的面板没有读数这块，接上内核后补建
    seed();
}
