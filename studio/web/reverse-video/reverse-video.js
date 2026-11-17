/**
 * reverse-video.js — 「视频反推」页宿主（Studio 视图）：一条视频、一段区间、一批帧 → 一段提示词。
 *
 * 帧在浏览器里抽：复用「视频抽帧」页那套 canvas 取帧（studio/web/frames/frames.js），在起点到终点之间
 * 均匀取 N 帧、缩到 REVERSE_MAX_SIDE 边长，一次请求把整批帧交进 POST /rs_prompts/reverse_video_prompt。
 * 每帧带自己的时间戳进正文——没有时间标签的多张图在模型眼里互不相关，写不出运镜、节奏与先后。
 * 落点是视频同名的 <视频>.rp.txt：视频同名 .txt 是「视频再来一发」读进去的生效参数旁车
 * （studio/gallery.py 的 _read_sidecar），反推结果落进去等于一发把用户的生成参数覆盖掉。
 * 与「图片反推」页各写各的落点，互不牵扯。首页「编辑」板块的入口卡是这页唯一的来路（顶栏没有页签）。
 */
import { t, tf } from "../js/core/i18n.js";
import { icon, setIconLabel } from "../js/core/icons.js";
import { captureFrames, framesVideoUrl, frameStamp, rangeTimes, waitMetadata } from "../frames/frames.js";

export const REVERSE_VIDEO_API = "/rs_prompts/reverse_video_prompt";
// 与后端 prompts.REVERSE_VIDEO_MAX_FRAMES 同值：一次进模型的帧数就是这一发的体积闸门
export const REVERSE_MAX_FRAMES = 12;
// 发给视觉模型的帧边长：存进素材库的帧是原尺寸，反推只要够看清画面（后端按 PNG 直送，不再缩放）
export const REVERSE_MAX_SIDE = 768;
export const REVERSE_FRAME_COUNTS = [1, 2, 4, 6, 8, 12];
// 与素材卡反推弹窗同一对取值：后端认 zh / en，界面上的「中文 / 英文」只是字
export const REVERSE_LANGS = [
    { value: "zh", label: "中文" },
    { value: "en", label: "英文" },
];

// 组件样式在第一次建视图时注入（幂等）：放在模块顶层会让画布为一份用不上的样式表发一次请求
function ensureCss() {
    if (document.getElementById("neo-reverse-video-css")) return;
    const link = document.createElement("link");
    link.id = "neo-reverse-video-css";
    link.rel = "stylesheet";
    link.href = "/extensions/comfyui-neo-studio/reverse-video/reverse-video.css";
    document.head.appendChild(link);
}

/**
 * 反推请求体：每帧带自己在片中的秒数，range 给模型一个全片参照。帧数也进请求体——后端把它写进
 * .rp-lang 标记（zh|N），换语言或换帧数都不再命中上一次的反推。
 */
export function videoReverseRequestBody(item, language, frames, range) {
    return {
        filename: item?.filename || "",
        subfolder: item?.subfolder || "",
        language: language || "zh",
        frames: (frames || []).map((f) => ({ t: f.t, data: f.data })),
        range: {
            start: Number(range?.start) || 0,
            end: Number(range?.end) || 0,
            duration: Number(range?.duration) || 0,
        },
    };
}

/**
 * 拖轨落点 → 新窗口：拖「离手最近」的那个柄，两柄不许交叉、最少留 MIN_WINDOW 秒，
 * 端点钳进片长。终点等于片长就是「到片尾」（rangeTimes 认这个约定，后端也照 0 收）。
 */
export function grabOnTrack({ pos, start, end, duration }) {
    const dur = Number(duration) || 0;
    const at = Math.max(0, Math.min(dur, Number(pos) || 0));
    const MIN_WINDOW = 0.5;
    const s = Math.max(0, Math.min(Number(start) || 0, dur));
    const e = Math.max(0, Math.min(Number(end) || 0, dur));
    // 拖离手最近的那个柄；越过另一个柄时把它顶到最小窗口，窗口不许倒挂
    let lo = s, hi = e;
    if (at - s <= e - at) lo = Math.min(at, Math.max(0, e - MIN_WINDOW));
    else hi = Math.max(at, Math.min(dur, s + MIN_WINDOW));
    return {
        start: Math.round(lo * 1000) / 1000,
        end: Math.round(hi * 1000) / 1000,
    };
}

/**
 * SSE 帧 → 文本增量。帧形与素材卡反推弹窗同一套：meta 帧只带 status / txt_file，正文在 text 帧，
 * [DONE] 收尾，[ERROR] 是后端把失败写进流里 —— 流没有状态码可查，不在这里抛就只剩一个空结果框。
 */
async function readVideoStream(resp, onText) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") return;
            if (data.startsWith("[ERROR]")) throw new Error(data.slice(7).trim() || t("反推失败"));
            try {
                const parsed = JSON.parse(data);
                if (typeof parsed.text === "string") onText(parsed.text);
            } catch { /* 非 JSON 帧（心跳）照收不下屏 */ }
        }
    }
}

/**
 * 建「视频反推」视图。依赖由宿主注入：api 走 shim（离线与在线同一条路），openMaterial 打开素材库
 * 弹窗并把选中的那条视频交回来，gateRun 把「反推」交运行闸门。
 */
export function createReverseVideoView({ api, $el, toast, openMaterial, gateRun }) {
    return async function buildReverseVideo(el) {
        ensureCss();
        el.classList.add("ns-revvid");
        let source = null;    // {filename, subfolder, label} —— null 时整页是起手卡片
        let frames = [];      // [{t, data}] —— 「抽帧」刚抽出来的那一批，反推吃的就是这一批
        let language = "zh";
        let frameCount = 4;
        let range = null;       // 时间窗拖出来的 {start, end}：null 是片长还没落地，铺满全片后才有值
        let runSeq = 0;       // 在途那一发的编号：换视频、重抽帧、再点反推都要作废上一发

        const bar = $el("div", { className: "ns-revvid-bar" });
        const title = $el("b", { className: "ns-revvid-title", textContent: t("视频反推") });
        const sourcePill = $el("span", { className: "ns-revvid-source ns-revvid-dim", textContent: t("没有视频") });
        const pickBtn = $el("button", { className: "ns-revvid-btn", type: "button", textContent: t("换视频") });
        const runBtn = $el("button", { className: "ns-revvid-btn ns-revvid-run", type: "button", textContent: t("反推") });
        bar.append(title, sourcePill, pickBtn, runBtn);

        const main = $el("div", { className: "ns-revvid-main", hidden: true });
        const video = $el("video", {
            className: "ns-revvid-video", controls: true, preload: "metadata", muted: true, playsInline: true,
        });
        // 时间窗滑轨：两个手柄拖出采样区间，拖的时候播放器跳到那一帧预览 —— 起终点的秒不许人打字
        const trackWin = $el("div", { className: "ns-revvid-window" });
        const handleStart = $el("div", { className: "ns-revvid-handle", "aria-hidden": "true" });
        const handleEnd = $el("div", { className: "ns-revvid-handle", "aria-hidden": "true" });
        const ticks = $el("div", { className: "ns-revvid-ticks" });
        const track = $el("div", {
            className: "ns-revvid-track", tabIndex: 0,
            "aria-label": t("时间窗滑轨"),
            title: t("按住手柄拖：区间跟着手走，播放器跳到那一帧；聚焦后 ←→ 微调近侧手柄，Shift 加档，Home 铺满全片"),
        }, [trackWin, handleStart, handleEnd, ticks]);
        const rangeText = $el("div", { className: "ns-revvid-range" });
        const counts = $el("div", { className: "ns-revvid-counts" });
        const countChips = REVERSE_FRAME_COUNTS.map((n) => {
            const chip = $el("button", {
                className: "ns-revvid-chip ns-revvid-count", type: "button", textContent: tf("{n} 帧", { n }),
            });
            chip.onclick = () => { frameCount = n; paintCounts(); paintTicks(); };
            counts.appendChild(chip);
            return chip;
        });
        const paintCounts = () => {
            for (const [i, chip] of countChips.entries()) {
                const on = REVERSE_FRAME_COUNTS[i] === frameCount;
                chip.classList.toggle("is-on", on);
                chip.setAttribute("aria-pressed", on ? "true" : "false");
            }
        };
        const fullBtn = $el("button", { className: "ns-revvid-btn", type: "button", textContent: t("全片") });
        const sampleBtn = $el("button", { className: "ns-revvid-btn", type: "button", textContent: t("抽帧") });
        const timeline = $el("div", { className: "ns-revvid-timeline" }, [track, rangeText]);
        const controlRow = $el("div", { className: "ns-revvid-range" }, [counts, fullBtn, sampleBtn]);
        const frameStrip = $el("div", { className: "ns-revvid-frames", hidden: true });
        const videoBox = $el("div", { className: "ns-revvid-video-box" }, [video, timeline, controlRow, frameStrip]);
        main.append(videoBox);


        const outBox = $el("div", { className: "ns-revvid-out-box", hidden: true });
        const langRow = $el("div", { className: "ns-revvid-langs" });
        const langChips = REVERSE_LANGS.map((opt) => {
            const chip = $el("button", { className: "ns-revvid-chip", type: "button", textContent: opt.label });
            chip.onclick = () => { language = opt.value; paintLangs(); };
            langRow.appendChild(chip);
            return chip;
        });
        const paintLangs = () => {
            for (const [i, chip] of langChips.entries()) {
                const on = REVERSE_LANGS[i].value === language;
                chip.classList.toggle("is-on", on);
                chip.setAttribute("aria-pressed", on ? "true" : "false");
            }
        };
        const copyBtn = $el("button", {
            className: "ns-revvid-btn ns-revvid-icon", type: "button", title: t("复制提示词"),
            "aria-label": t("复制提示词"),
        }, [icon("copy", 15)]);
        const outHead = $el("div", { className: "ns-revvid-out-head" }, [
            $el("b", { textContent: t("反推出的提示词") }),
            langRow,
            copyBtn,
        ]);
        const outText = $el("pre", { className: "ns-revvid-out" });
        const status = $el("div", { className: "ns-revvid-status ns-revvid-dim" });
        outBox.append(outHead, outText);

        const empty = $el("div", { className: "ns-revvid-empty" }, [
            $el("div", { className: "ns-revvid-empty-icon", textContent: "🎬", "aria-hidden": "true" }),
            $el("p", { textContent: t("挑一条视频，在时间窗上拖出要看的段落，抽一批帧，一次请求把这段画面写成提示词，结果写进视频同名的 .rp.txt") }),
            $el("button", { className: "ns-revvid-btn", type: "button", textContent: t("从素材库选视频") }),
        ]);
        const emptyBtn = empty.querySelector(".ns-revvid-btn");
        // 状态句在结果框外面：结果框出结果之前是收着的，反推中 / 失败的这一句得看得见
        el.append(bar, main, outBox, status, empty);

        const paintFrames = () => {
            frameStrip.replaceChildren();
            for (const f of frames) {
                frameStrip.append($el("figure", { className: "ns-revvid-frame" }, [
                    $el("img", { src: f.data, alt: "", loading: "lazy" }),
                    $el("figcaption", { textContent: frameStamp(f.t) }),
                ]));
            }
            frameStrip.hidden = !frames.length;
        };

        /** 控件的可用态永远跟着「选没选视频、抽没抽帧」走：用户不需要猜哪一颗钮现在能点 */
        const paintChrome = () => {
            const hasVideo = !!source;
            main.hidden = !hasVideo;
            empty.hidden = hasVideo;
            pickBtn.hidden = !hasVideo;
            runBtn.disabled = !frames.length;
            runBtn.title = frames.length
                ? t("已抽帧，点一下把这一批写进 .rp.txt")
                : t("先抽帧，再点「反推」：结果写进视频同名的 .rp.txt");
            sourcePill.textContent = source ? source.label : t("没有视频");
            sourcePill.title = source ? `${source.subfolder}/${source.filename}` : "";
        };

        // 素材库取用永远交来数组（单点一条也是长度为 1 的数组，与抽帧页 / 图片反推页同一份契约）：
        // 直接当单条读的话 item.filename 落在数组上取不到，整页就是「点了没反应」。
        const pick = () => openMaterial((picked) => {
            const item = Array.isArray(picked) ? picked[0] : picked;
            if (!item?.filename) return;
            source = {
                filename: item.filename,
                subfolder: item.subfolder || "",
                label: (item.subfolder ? `${item.subfolder}/` : "") + item.filename,
            };
            frames = [];
            range = null;   // 上一条视频拖出的窗口不跟着换片跑：新片 metadata 落地后铺满全片
            runSeq++;   // 上一发在途的流到此为止：它的字不该落进这一条视频的结果框
            paintFrames();
            paintRange();
            outText.textContent = "";
            outBox.hidden = true;     // 上一条视频的结果随片一起收走
            status.textContent = "";
            video.src = framesVideoUrl(source);   // 后端回分段响应：seek 才有帧定位
            paintChrome();
        });
        pickBtn.onclick = pick;
        emptyBtn.onclick = pick;

        // 时间窗的画与拖都走这一对：pct 是唯一的落位出口，刻度只反映「这一批会抽在哪几秒」
        const pct = (sec) => `${video.duration ? Math.max(0, Math.min(1, sec / video.duration)) * 100 : 0}%`;
        const paintTicks = () => {
            ticks.replaceChildren();
            if (!range || !video.duration || frameCount <= 1) return;
            for (const ts of rangeTimes({
                start: range.start, end: range.end, count: frameCount, duration: video.duration,
            })) {
                const tick = $el("div", { className: "ns-revvid-tick" });
                tick.style.left = pct(ts);
                ticks.appendChild(tick);
            }
        };
        const paintRange = () => {
            const dur = video.duration || 0;
            rangeText.textContent = !range || !dur
                ? "—"
                : tf("起点 {a} · 终点 {b} · 窗口 {c}s", {
                    a: frameStamp(range.start),
                    b: range.end >= dur - 0.01 ? t("片尾") : frameStamp(range.end),
                    c: Math.round((range.end - range.start) * 100) / 100,
                });
            handleStart.style.left = range ? pct(range.start) : "0%";
            handleEnd.style.left = range ? pct(range.end) : "0%";
            trackWin.style.left = range ? pct(range.start) : "0%";
            trackWin.style.width = range ? pct(Math.max(0, range.end - range.start)) : "0%";
            paintTicks();
        };

        // 拖轨就是选区间：按下与拖动都让播放器跳到那一秒预览，拖的是离手最近的柄（grabOnTrack 钳位）
        const dragId = (ev) => (ev.pointerId === undefined ? 1 : ev.pointerId);
        let dragging = 0;
        const atTrack = (ev) => {
            const box = track.getBoundingClientRect();
            if (!box.width || !video.duration) return null;
            return Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width)) * video.duration;
        };
        const scrub = (ev) => {
            const at = atTrack(ev);
            if (at === null || !range) return;
            const next = grabOnTrack({ pos: at, start: range.start, end: range.end, duration: video.duration });
            range = next;
            paintRange();
            video.currentTime = grabKey === "start" ? next.start : Math.min(next.end, Math.max(0, video.duration - 0.05));
        };
        let grabKey = "start";
        track.onpointerdown = (ev) => {
            const at = atTrack(ev);
            if (at === null || !range) return;
            grabKey = at - range.start <= range.end - at ? "start" : "end";
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

        // 拖轨的键盘替代：聚焦滑轨后 ←→ 动离窗口中心近的那侧柄（平手动终点侧），Shift 五倍档，Home 铺满全片。
        // 不走 grabOnTrack —— 那套按「落点离哪端近」选柄，正对窗口中心时按键会拖到对面那端，方向反着走。
        track.onkeydown = (ev) => {
            if (!range || !video.duration) return;
            const key = ev.key;
            if (key === "Home") {
                ev.preventDefault();
                range = { start: 0, end: video.duration };
                paintRange();
                return;
            }
            if (key !== "ArrowLeft" && key !== "ArrowRight") return;
            ev.preventDefault();
            const step = (key === "ArrowLeft" ? -1 : 1) * (ev.shiftKey ? 5 : 0.5);
            const dur = video.duration;
            const center = (range.start + range.end) / 2;
            grabKey = center - range.start < range.end - center ? "start" : "end";
            const roundms = (x) => Math.round(x * 1000) / 1000;
            if (grabKey === "start") {
                range = { start: roundms(Math.max(0, Math.min(range.start + step, range.end - 0.5))), end: range.end };
            } else {
                range = { start: range.start, end: roundms(Math.min(dur, Math.max(range.end + step, range.start + 0.5))) };
            }
            paintRange();
            video.currentTime = grabKey === "start" ? range.start : Math.min(range.end, Math.max(0, dur - 0.05));
        };

        fullBtn.onclick = () => {
            if (!video.duration) return;
            range = { start: 0, end: video.duration };
            paintRange();
        };

        // 片长一落地就把窗口铺满全片：不拖直接「抽帧」吃的就是整片均分（与旧「0 到片尾」同义）。
        // 抽帧是逐帧 seek 的：每一帧落地都重画刻度，帧条在抽完那一刻正好对上拖出的窗口
        video.addEventListener("loadedmetadata", () => {
            range = { start: 0, end: video.duration || 0 };
            paintRange();
        });
        video.addEventListener("seeked", () => paintTicks());

        // 抽帧在浏览器里做：区间均分 N 帧、缩到 REVERSE_MAX_SIDE 边长，一次请求吃整批
        sampleBtn.onclick = async () => {
            if (!source) { toast(t("先选一条视频")); return; }
            sampleBtn.disabled = true;
            try {
                await waitMetadata(video);
                const times = rangeTimes({
                    start: range?.start || 0, end: range?.end || 0,
                    count: frameCount, duration: video.duration || 0,
                });
                if (!times.length) { toast(t("起点在终点之后：把区间调回视频里面")); return; }
                const shot = await captureFrames(video, times, undefined, REVERSE_MAX_SIDE);
                frames = shot.map((f) => ({ t: f.timestamp, data: f.url }));
                paintFrames();
                toast(tf("抽了 {n} 帧，点反推就吃这一批", { n: frames.length }));
            } catch (e) {
                toast(tf("抽帧失败：{msg}", { msg: String(e?.message || e) }));
            } finally {
                sampleBtn.disabled = false;
                paintChrome();
            }
        };

        const run = async () => {
            if (!source || !frames.length) return;
            const seq = ++runSeq;
            outText.textContent = "";
            outBox.hidden = true;     // 正文回来的一刻才现身：空结果框不占地方
            status.textContent = t("反推中…");
            runBtn.disabled = true;
            try {
                const resp = await api.fetchApi(REVERSE_VIDEO_API, {
                    method: "POST",
                    body: JSON.stringify(videoReverseRequestBody(source, language, frames, {
                        start: range?.start || 0,
                        end: range?.end || 0,
                        duration: video.duration || 0,
                    })),
                    headers: { "Content-Type": "application/json" },
                });
                if (!resp.ok) {
                    const data = await resp.json().catch(() => ({}));
                    throw new Error(data?.error || `HTTP ${resp.status}`);
                }
                await readVideoStream(resp, (piece) => {
                    if (seq !== runSeq) return;
                    outText.textContent += piece;
                    if (outBox.hidden) outBox.hidden = false;   // 第一块正文落屏，结果框就现身
                    followStream();
                });
                status.textContent = outText.textContent.trim()
                    ? t("已生成，结果写进视频同名的 .rp.txt") : t("(空提示词)");
            } catch (e) {
                if (seq === runSeq) status.textContent = String(e?.message || e);
            } finally {
                if (seq === runSeq) paintChrome();
            }
        };
        runBtn.onclick = run;

        // 正文流回来时把整页（外层 .ns-page 那根条）滚到结果框底沿：跟的是正文，框内的文字不许自己滚
        const followStream = () => outBox.scrollIntoView({ behavior: "smooth", block: "end" });

        copyBtn.onclick = async () => {
            const text = outText.textContent.trim();
            if (!text) { toast(t("还没有可复制的提示词")); return; }
            try {
                await navigator.clipboard.writeText(text);
                setIconLabel(copyBtn, "check", t("已复制"));
                setTimeout(() => { setIconLabel(copyBtn, "copy", t("复制提示词")); }, 1500);
            } catch (e) {
                toast(t("复制失败，选中结果框自己复制"));
            }
        };

        gateRun(runBtn, "prompt_reverse_video", t("反推"));
        paintLangs();
        paintCounts();
        paintChrome();
    };
}


