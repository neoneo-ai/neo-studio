/**
 * frames.js — 「视频抽帧」页宿主（Studio 视图）：一条视频、一个播放器、一批帧存进素材库。
 *
 * 抽帧在浏览器里做：播放器 seek 到每个时间戳，canvas 画那一帧转 PNG，逐条交后端写进
 * output/Frames（素材库浏览 output 就是它的落点）。后端只负责文件层的两件事，理由见 studio/frames.py。
 *
 * 抽帧参数照 ArtCraft 的 PageVideoFrameExtractor：起点 + 帧数 + 间隔（毫秒）算出时间戳表，
 * 越过片尾就停；抽完把播放位置还回去 —— 抽帧前看的位置不会丢。
 */
import { t, tf } from "../js/core/i18n.js";
import { icon, setIconLabel } from "../js/core/icons.js";

// 组件样式在第一次建视图时注入（幂等）：本模块也会被主画布页的扩展图加载，
// 放在模块顶层会让画布为一份用不上的样式表发一次请求。
function ensureCss() {
    if (document.getElementById("neo-frames-css")) return;
    const link = document.createElement("link");
    link.id = "neo-frames-css";
    link.rel = "stylesheet";
    link.href = "/extensions/comfyui-neo-studio/frames/frames.css";
    document.head.appendChild(link);
}

export const FRAMES_MAX_FRAMES = 50;   // 一次抽多少帧的天花板：抽完一张卡片一行，50 张已经够滚
export const FRAMES_MAX_GAP_MS = 10000;
export const FRAMES_SUBFOLDER = "Frames";   // 与 studio/gallery.py 的 FRAMES_DIR_NAME 同值
// 与 studio/util.py 的 VIDEO_EXTENSIONS 同值：素材库与本机文件里混着的图片与音频点进播放器时，
// 播放器只会空着，不报错也没人说得出为什么
export const FRAMES_VIDEO_EXT = [".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv"];

/** 素材库选中项 → 播放器的视频源：后端回的是分段响应，seek 才有帧定位 */
export function framesVideoUrl(item) {
    if (!item?.filename) return "";
    const q = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder || "" });
    return `/neo_frames/video?${q}`;
}

export function isVideoName(name) {
    return FRAMES_VIDEO_EXT.some((ext) => String(name || "").toLowerCase().endsWith(ext));
}

/** mm:ss.mmm —— 界面读数与帧的落点名同一条时间格式（文件名里不吃冒号，后端换成下划线） */
export function frameStamp(sec) {
    const ms = Math.max(0, Number(sec) || 0);
    const m = Math.floor(ms / 60);
    const s = Math.floor(ms % 60);
    const milli = Math.floor((ms % 1) * 1000);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

/**
 * 时间戳表：起点 + i*间隔，越过片尾就停。seek 越界的浏览器会把最后一帧重复交回来 ——
 * 不挡住的话用户看见的是同一帧占满整批，还以为间隔设错了。
 */
export function frameTimes({ start, count, gapMs, duration }) {
    const n = Math.max(1, Math.min(FRAMES_MAX_FRAMES, Number(count) || 1));
    const gap = Math.max(1, Math.min(FRAMES_MAX_GAP_MS, Number(gapMs) || 1)) / 1000;
    const from = Math.max(0, Number(start) || 0);
    const out = [];
    for (let i = 0; i < n; i++) {
        const ts = from + i * gap;
        if (duration && ts > duration) break;
        out.push(ts);
    }
    return out;
}

const onSeeked = (video) => new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));

/** 播放器 metadata 还没落地就抽：videoWidth 是 0，canvas 跟着空，抽出来的全是空图 */
const waitMetadata = (video) => new Promise((resolve, reject) => {
    if (video.readyState >= 2 && video.videoWidth) return resolve();
    const timer = setTimeout(() => {
        video.removeEventListener("loadeddata", hit);
        reject(new Error(t("视频信息没读到")));
    }, 5000);
    const hit = () => { clearTimeout(timer); resolve(); };
    video.addEventListener("loadeddata", hit, { once: true });
});

/**
 * seek 到每个时间戳、把那一帧画进 canvas 转 PNG。makeCanvas 留给用例与非画布环境：
 * 真实浏览器就是 document.createElement("canvas")。
 */
export async function captureFrames(video, times, makeCanvas = () => document.createElement("canvas")) {
    const canvas = makeCanvas();
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(t("浏览器不支持画布取帧"));
    canvas.width = video.videoWidth || 0;
    canvas.height = video.videoHeight || 0;
    const wasPlaying = !video.paused;
    if (wasPlaying) video.pause();
    const back = video.currentTime;
    const frames = [];
    try {
        for (const ts of times) {
            // 监听挂在 seek 之前：缓存过的视频里某些浏览器会把 seeked 发在同一个任务里，
            // 挂在后面就永远等不到那一帧，整批抽帧停在第一条上不动
            const seeked = onSeeked(video);
            video.currentTime = ts;
            await seeked;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            frames.push({ url: canvas.toDataURL("image/png"), timestamp: ts, saved: "" });
        }
    } finally {
        video.currentTime = back;   // 抽帧前看的位置还回去：连抽两批也不会跳回片头
        if (wasPlaying && video.play) video.play();
    }
    return frames;
}

/**
 * 建「视频抽帧」视图。依赖由宿主注入：api 走 shim（离线与在线同一条路），
 * openMaterial 打开素材库弹窗并把选中项交回来。
 */
export function createFramesView({ api, $el, toast, openMaterial }) {
    return async function buildFrames(el) {
        ensureCss();
        el.classList.add("ns-frames");
        let source = null;   // {url, label} —— null 时整页是起手卡片
        let frames = [];
        let blobUrl = "";    // 本机那一份：换视频时收回，页面离开前也收（浏览器攥着整段解码）

        const json = async (path, payload) => {
            const resp = await api.fetchApi(path, payload ? {
                method: "POST",
                body: JSON.stringify(payload),
                headers: { "Content-Type": "application/json" },
            } : undefined);
            const data = await resp.json().catch(() => null);
            if (!resp.ok || !data?.success) throw new Error(data?.error || t("操作失败"));
            return data;
        };

        const btn = (label, iconKey, extra = "") => {
            const b = $el("button", { className: "ns-frames-btn" + extra, type: "button" });
            setIconLabel(b, iconKey, t(label));
            return b;
        };
        const num = (label, value, min, max) => $el("input", {
            className: "ns-frames-num", type: "number", title: t(label),
            min: String(min), max: String(max), step: "any", value: String(value),
        });
        const field = (label, input) => $el("label", { className: "ns-frames-field" }, [
            $el("span", { textContent: t(label) }), input,
        ]);

        const video = $el("video", { className: "ns-frames-video", preload: "metadata" });
        video.setAttribute("playsinline", "");
        const played = $el("div", { className: "ns-frames-played" });
        const marker = $el("div", { className: "ns-frames-marker" });
        const track = $el("div", { className: "ns-frames-track", title: t("按住拖：起抽点跟着手走") },
            [played, marker]);
        const timeText = $el("span", { className: "ns-frames-time", textContent: "00:00.000 / 00:00.000" });
        const infoText = $el("span", { className: "ns-frames-info", textContent: t("尺寸未知") });
        const startNum = num("起点（秒）", 0, 0, 600);
        const countNum = num("帧数", 10, 1, FRAMES_MAX_FRAMES);
        const gapNum = num("间隔（毫秒）", 100, 1, FRAMES_MAX_GAP_MS);
        const playBtn = btn("播放", "play");
        const muteBtn = btn("静音", "volume");
        const firstBtn = btn("跳到首帧", "skip-back");
        const lastBtn = btn("跳到末帧", "skip-forward");
        const pickBtn = btn("从素材库选视频", "folder", " ns-frames-btn-primary");
        const localBtn = btn("本机视频", "image");
        const switchBtn = btn("换视频", "cross");
        const extractBtn = btn("抽帧", "sparkles", " ns-frames-btn-primary");
        const saveAllBtn = btn("全部存进素材库", "folder");
        const sourcePill = $el("span", { className: "ns-frames-pill", textContent: t("没有视频") });
        const countPill = $el("span", { className: "ns-frames-pill", textContent: tf("{n} 帧", { n: 0 }) });
        const grid = $el("div", { className: "ns-frames-grid" });
        const fileInput = $el("input", { className: "ns-frames-file", type: "file", accept: "video/*" });

        const bar = $el("div", { className: "ns-frames-bar" }, [
            $el("span", { className: "ns-frames-bar-title" }, [icon("film", 18), t("视频抽帧")]),
            sourcePill,
            $el("span", { className: "ns-frames-sep" }),
            switchBtn,
            saveAllBtn,
            extractBtn,
        ]);
        const controls = $el("div", { className: "ns-frames-controls" }, [
            track, firstBtn, playBtn, lastBtn, muteBtn, timeText,
        ]);
        const stage = $el("div", { className: "ns-frames-stage" }, [video, controls]);
        const settings = $el("div", { className: "ns-frames-settings" }, [
            field("起点（秒）", startNum), field("帧数", countNum), field("间隔（毫秒）", gapNum), infoText,
        ]);
        const frameBox = $el("section", { className: "ns-frames-out" }, [
            $el("div", { className: "ns-frames-head" }, [t("抽出来的帧"), countPill]),
            grid,
        ]);
        const empty = $el("div", { className: "ns-frames-empty" }, [
            $el("h3", { textContent: t("视频抽帧") }),
            $el("p", { textContent: t("挑一条视频，从它里面抽帧存进素材库：抽出来的帧落在素材库的 Frames 目录，浏览 output 就看得见") }),
            $el("div", { className: "ns-frames-row" }, [pickBtn, localBtn]),
        ]);
        const main = $el("div", { className: "ns-frames-main" }, [empty, stage, settings, frameBox]);
        el.append(bar, main, fileInput);

        const duration = () => video.duration || 0;
        const pct = (sec) => `${duration() ? Math.max(0, Math.min(1, sec / duration())) * 100 : 0}%`;

        const paintChrome = () => {
            stage.hidden = !source;
            settings.hidden = !source;
            frameBox.hidden = !source;
            empty.hidden = !!source;
            sourcePill.textContent = source ? source.label : t("没有视频");
            switchBtn.disabled = !source;
            extractBtn.disabled = !source;
            saveAllBtn.disabled = !frames.length || frames.every((f) => f.saved);
        };
        const paintTime = () => {
            timeText.textContent = `${frameStamp(video.currentTime)} / ${frameStamp(duration())}`;
            played.style.width = pct(video.currentTime);
        };
        const paintStart = () => { marker.style.left = pct(Number(startNum.value) || 0); };

        const paintFrames = () => {
            countPill.textContent = tf("{n} 帧", { n: frames.length });
            grid.replaceChildren(...frames.map((frame) => {
                const save = $el("button", { className: "ns-frames-btn", type: "button" });
                const label = () => setIconLabel(save, frame.saved ? "check" : "folder",
                    frame.saved ? t("已存") : t("存进素材库"));
                label();
                save.onclick = () => run(async () => {
                    frame.saved = await saveFrame(frame);
                    label();
                    paintChrome();
                });
                return $el("div", { className: "ns-frames-card" }, [
                    $el("img", { src: frame.url, alt: frameStamp(frame.timestamp) }),
                    $el("span", { className: "ns-frames-stamp", textContent: frameStamp(frame.timestamp) }),
                    save,
                ]);
            }));
            paintChrome();
        };

        /** 一条一帧：逐帧存与「全部存进素材库」是同一条接口，批量只是页面连着发 */
        const saveFrame = async (frame) => {
            const data = await json("/neo_frames/save", {
                data: frame.url, name: `frame-${frameStamp(frame.timestamp)}`,
            });
            return data.filename;
        };

        // 抽帧与存帧期间锁住控件：seek 是一串异步事件，连点会让播放器排在时间戳队列上，
        // 用户看见的是「按了抽帧但帧一直不动」；跑完解锁
        const run = async (fn) => {
            extractBtn.disabled = saveAllBtn.disabled = true;
            try {
                await fn();
            } catch (e) {
                toast(tf("失败：{msg}", { msg: e.message }));
            }
            paintChrome();
        };

        const setSource = (url, label) => {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            blobUrl = url.startsWith("blob:") ? url : "";
            source = url ? { url, label } : null;
            frames = [];
            video.src = url || "";
            if (url) video.load();
            infoText.textContent = t("尺寸未知");
            paintFrames();
            paintTime();
            paintStart();
        };

        const useVideo = (item) => {
            if (!item?.filename) { toast(t("没取到视频")); return; }
            if (!isVideoName(item.filename)) { toast(tf("抽帧只支持视频：{name}", { name: item.filename })); return; }
            setSource(framesVideoUrl(item), item.filename);
        };

        pickBtn.onclick = () => openMaterial((picked) => useVideo(Array.isArray(picked) ? picked[0] : picked));
        localBtn.onclick = () => { fileInput.value = ""; fileInput.click(); };
        fileInput.onchange = () => {
            const file = fileInput.files && fileInput.files[0];
            fileInput.value = "";
            if (!file) return;
            if (!isVideoName(file.name)) { toast(tf("抽帧只支持视频：{name}", { name: file.name })); return; }
            setSource(URL.createObjectURL(file), file.name);
        };
        switchBtn.onclick = () => setSource("", "");

        const seekTo = (sec) => {
            if (!duration()) return;
            const at = Math.max(0, Math.min(duration(), sec));
            video.currentTime = at;
            startNum.value = String(Number(at.toFixed(3)));
            paintTime();
            paintStart();
        };
        // 进度条靠拖：按住它，起抽点跟着手走，松手定下来。用不上 click 的那一半 ——
        // 用户要「从一秒前起抽」时 click 只落在原地，抽出来还是当前那一帧
        const pointerAt = (ev) => {
            const box = track.getBoundingClientRect();
            if (!box.width || !duration()) return null;
            return Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width) * duration());
        };
        const scrub = (ev) => {
            const at = pointerAt(ev);
            if (at !== null) seekTo(at);
        };
        // jsdom 与老浏览器里没有 pointerId：统一收到一个 id 上，拖与松手配对得起来
        const dragId = (ev) => (ev.pointerId === undefined ? 1 : ev.pointerId);
        let dragging = 0;
        track.onpointerdown = (ev) => {
            dragging = dragId(ev);
            track.classList.add("dragging");
            if (ev.pointerId !== undefined) track.setPointerCapture?.(ev.pointerId);
            scrub(ev);
        };
        track.onpointermove = (ev) => { if (dragging === dragId(ev)) scrub(ev); };
        track.onpointerup = (ev) => {
            if (dragging !== dragId(ev)) return;
            dragging = 0;
            if (ev.pointerId !== undefined) track.releasePointerCapture?.(ev.pointerId);
            track.classList.remove("dragging");
        };
        track.onpointercancel = track.onpointerup;
        playBtn.onclick = () => {
            if (video.paused) video.play?.().catch(() => toast(t("播放器起不来")));
            else video.pause();
        };
        muteBtn.onclick = () => {
            video.muted = !video.muted;
            setIconLabel(muteBtn, video.muted ? "volume-mute" : "volume",
                         video.muted ? t("没出声") : t("静音"));
        };
        firstBtn.onclick = () => seekTo(0);
        lastBtn.onclick = () => seekTo(duration());
        startNum.onchange = () => { startNum.value = String(Math.max(0, Number(startNum.value) || 0)); paintStart(); };

        video.addEventListener("timeupdate", () => {
            paintTime();
            // 播起来之后起点跟着播放位置走：停在哪儿就从哪儿抽，抽一批不用调一次数字框
            if (!video.paused) { startNum.value = String(Number(video.currentTime.toFixed(3))); paintStart(); }
        });
        video.addEventListener("play", () => setIconLabel(playBtn, "pause", t("暂停")));
        video.addEventListener("pause", () => setIconLabel(playBtn, "play", t("播放")));
        video.addEventListener("loadedmetadata", () => {
            infoText.textContent = tf("{w}×{h} · {label}", {
                w: video.videoWidth, h: video.videoHeight, label: frameStamp(duration()),
            });
            paintTime();
            paintStart();
        });

        extractBtn.onclick = () => run(async () => {
            if (!source) { toast(t("先选一条视频")); return; }
            await waitMetadata(video);
            const times = frameTimes({
                start: Number(startNum.value), count: Number(countNum.value),
                gapMs: Number(gapNum.value), duration: duration(),
            });
            if (!times.length) { toast(t("起点越过片尾了：把起点调回视频里面再抽")); return; }
            frames = await captureFrames(video, times);
            paintFrames();
            toast(tf("抽了 {n} 帧：存进素材库才算落盘", { n: frames.length }));
        });

        saveAllBtn.onclick = () => run(async () => {
            let n = 0;
            for (const frame of frames) {
                if (frame.saved) continue;
                frame.saved = await saveFrame(frame);
                n += 1;
            }
            paintFrames();
            toast(tf("已存 {n} 帧到素材库的 Frames 目录", { n }));
        });

        paintFrames();
        // 视图建好后常驻（切页只是显隐）：本机那份 blob 别留在页面上，窗口关掉前收掉
        window.addEventListener("pagehide", () => {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            blobUrl = "";
        });
    };
}

