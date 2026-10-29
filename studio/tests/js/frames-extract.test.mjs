// 「视频抽帧」页（studio/web/frames/frames.js）：时间戳表、播放器取帧、帧存进素材库。
// 抽帧在浏览器里做，后端只有两条文件层接口（studio/frames.py），这里把播放器与画布桩掉。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, click, changeValue, flush, sleep, window } from "./setup.mjs";
import { $el } from "../../web/studio/shim/ui.js";
import {
    createFramesView, captureFrames, frameStamp, frameTimes, framesVideoUrl, isVideoName,
    FRAMES_MAX_FRAMES,
} from "../../web/frames/frames.js";

const api = { fetchApi: (path, opts) => fetch(path, opts) };

/** 一批抽帧要跑完 帧数 × 每次 seeked 与取帧 的微任务，12 轮 flush 不够：给足轮数（不是轮询） */
const settle = async () => { await flush(40); await sleep(0); await flush(40); };

/** jsdom 的播放器不解码：时长、尺寸与 seek 桩成可预测的那一份 —— currentTime 一落就发 seeked */
function stubPlayer(el, { duration = 10, width = 1280, height = 720 } = {}) {
    let current = 0;
    let paused = true;
    const define = (name, get) => Object.defineProperty(el, name, { get, configurable: true });
    define("duration", () => duration);
    define("videoWidth", () => width);
    define("videoHeight", () => height);
    define("readyState", () => 4);
    define("paused", () => paused);
    Object.defineProperty(el, "currentTime", {
        configurable: true,
        get: () => current,
        set: (value) => {
            current = value;
            el.dispatchEvent(new window.Event("seeked"));
        },
    });
    el.load = () => {};
    el.play = () => { paused = false; el.dispatchEvent(new window.Event("play")); return Promise.resolve(); };
    el.pause = () => { paused = true; el.dispatchEvent(new window.Event("pause")); };
    return el;
}

/** jsdom 的 canvas 没有 2d 上下文：drawImage 与 toDataURL 桩成固定那一份 */
function stubCanvas() {
    Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
        value: () => ({ drawImage() {} }), configurable: true, writable: true,
    });
    Object.defineProperty(window.HTMLCanvasElement.prototype, "toDataURL", {
        value: () => "data:image/png;base64,FRAME", configurable: true, writable: true,
    });
}

function mounted() {
    clearRoutes();
    mockRoute("/neo_frames/save", (body) => jsonResponse({
        success: true, filename: `frame-${String(body?.name || "").replace(/[^A-Za-z0-9]/g, "_")}.png`,
        subfolder: "Frames", size: 4,
    }));
    const host = $el("div");
    document.body.appendChild(host);
    const toasts = [];
    let pickCb = null;
    const build = createFramesView({
        api, $el,
        toast: (m) => toasts.push(m),
        openMaterial: (cb) => { pickCb = cb; },
    });
    const env = {
        host, toasts,
        pick: (item) => {
            click(env.button("从素材库选视频"));   // 弹窗由宿主开：用例只把弹窗交回来的那一项喂进回调
            pickCb?.(item);
        },
        button: (label) => [...host.querySelectorAll(".ns-frames-btn")].find((b) => b.textContent.includes(label)),
        card: (i) => [...host.querySelectorAll(".ns-frames-card")][i],
        num: (i) => [...host.querySelectorAll(".ns-frames-num")][i],
        video: () => host.querySelector(".ns-frames-video"),
        count: () => host.querySelector(".ns-frames-head .ns-frames-pill").textContent,
    };
    return build(host).then(() => env);
}

test("时间戳表：起点按间隔铺开，越过片尾就停", () => {
    assert.deepEqual(frameTimes({ start: 1, count: 3, gapMs: 250, duration: 10 }), [1, 1.25, 1.5]);
    assert.deepEqual(frameTimes({ start: 9.5, count: 4, gapMs: 1000, duration: 10 }), [9.5],
        "起点已经在片尾附近：越界的那几个不许排进来");
    assert.equal(frameTimes({ start: 0, count: 999, gapMs: 1000, duration: 1000 }).length,
        FRAMES_MAX_FRAMES, "帧数被收到页面上限");
    assert.deepEqual(frameTimes({ start: 0, count: 2, gapMs: 999999, duration: 60 }).length, 2,
        "间隔被收到上限，不会一眼溢出");
});

test("帧的时间戳格式与视频名判断", () => {
    assert.equal(frameStamp(7.125), "00:07.125");
    assert.equal(frameStamp(75), "01:15.000");
    assert.equal(frameStamp(-1), "00:00.000");
    assert.ok(isVideoName("Clip.MP4"));
    assert.ok(!isVideoName("shot.png"), "素材库里混着的图片不是视频");
    assert.equal(framesVideoUrl({ filename: "clip.mp4", subfolder: "Output" }),
        "/neo_frames/video?filename=clip.mp4&subfolder=Output");
    assert.equal(framesVideoUrl(null), "");
});

test("逐帧 seek 取图：抽完把播放位置还回去", async () => {
    const video = {
        currentTime: 7, paused: false, videoWidth: 1280, videoHeight: 720,
        addEventListener: (type, fn) => fn(),
        pause() { this.paused = true; },
        play() { this.paused = false; },
    };
    const canvas = {
        width: 0, height: 0,
        getContext: () => ({ drawImage() {} }),
        toDataURL: () => "data:image/png;base64,F",
    };
    const frames = await captureFrames(video, [1, 1.25, 1.5], () => canvas);
    assert.deepEqual(frames.map((f) => f.timestamp), [1, 1.25, 1.5]);
    assert.equal(frames[0].url, "data:image/png;base64,F");
    assert.equal(canvas.width, 1280);
    assert.equal(video.currentTime, 7, "抽帧前看的位置要还回去：连抽两批不该跳回片头");
    assert.equal(video.paused, false, "抽完把原来是否在播的状态还回去");
});

test("没选视频时只有起手卡片：抽帧与存帧的控件不出现在页面上", async () => {
    resetEnv();
    const env = await mounted();
    assert.ok(env.host.querySelector(".ns-frames-empty"), "起手卡片要告诉用户从哪儿起手");
    assert.equal(env.video().src, "", "没源时播放器连自己都不该去加载");
    assert.ok(env.button("抽帧").disabled, "能力用不到就不出可点的按钮");
    assert.ok(env.button("全部存进素材库").disabled);
});

test("素材库点来的视频进播放器：走的是分段视频源，非视频被挡下", async () => {
    resetEnv();
    const env = await mounted();
    env.pick({ filename: "shot.png", subfolder: "Output" });
    await settle();
    assert.match(env.toasts.join("|"), /抽帧只支持视频/);
    assert.equal(env.video().src, "", "图片不该被塞进播放器");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_frames/save").length, 0);

    env.pick({ filename: "clip.mp4", subfolder: "Output" });
    await settle();
    assert.match(env.video().src, /\/neo_frames\/video/);
    assert.ok(env.host.querySelector(".ns-frames-empty").hidden, "有源了就该收起手卡片");
    assert.ok(!env.host.querySelector(".ns-frames-stage").hidden);
    assert.equal(env.host.querySelector(".ns-frames-pill").textContent, "clip.mp4");
    assert.ok(!env.button("抽帧").disabled);
});

test("抽帧按起点与间隔落卡片，逐帧存进素材库的落点是 Frames", async () => {
    resetEnv();
    stubCanvas();
    const env = await mounted();
    stubPlayer(env.video());
    env.pick({ filename: "clip.mp4", subfolder: "" });
    await settle();
    changeValue(env.num(0), "1");
    changeValue(env.num(1), "3");
    changeValue(env.num(2), "250");
    click(env.button("抽帧"));
    await settle();
    const stamps = [...env.host.querySelectorAll(".ns-frames-stamp")].map((e) => e.textContent);
    assert.deepEqual(stamps, ["00:01.000", "00:01.250", "00:01.500"]);
    assert.match(env.toasts.join("|"), /抽了 3 帧/);
    assert.equal(env.count(), "3 帧");
    assert.equal(env.host.querySelectorAll(".ns-frames-card img").length, 3);

    click(env.card(0).querySelector(".ns-frames-btn"));
    await settle();
    const post = fetchLog.filter((c) => c.path === "/neo_frames/save");
    assert.equal(post.length, 1);
    assert.equal(post[0].body.data, "data:image/png;base64,FRAME");
    assert.equal(post[0].body.name, "frame-00:01.000", "落点上的名字带着这一帧的时间戳");
    assert.match(env.card(0).textContent, /已存/, "存过的那一帧要说清，别再存第二遍");

    click(env.button("全部存进素材库"));
    await settle();
    assert.equal(fetchLog.filter((c) => c.path === "/neo_frames/save").length, 3, "存过的不再重发");
    assert.match(env.toasts.join("|"), /已存 2 帧到素材库的 Frames 目录/);
    assert.ok(env.button("全部存进素材库").disabled, "全都存完了就该收起这个按钮");
});

test("进度条拖到哪儿，起抽点就到哪儿：按下的落点那一秒也起抽，不是当前那一帧", async () => {
    resetEnv();
    const env = await mounted();
    stubPlayer(env.video());
    env.pick({ filename: "clip.mp4", subfolder: "" });
    await settle();
    const track = env.host.querySelector(".ns-frames-track");
    const marker = env.host.querySelector(".ns-frames-marker");
    // 桩里的进度条是 0..120：拖的位置就是那条视频的相对秒数（duration 10）
    const pointer = (type, clientX) => track.dispatchEvent(new window.MouseEvent(type, {
        clientX, bubbles: true, cancelable: true,
    }));
    pointer("pointerdown", 40);
    assert.equal(env.num(0).value, "3.333", "按下那一下也要起抽：拖之前那一下就是落点");
    assert.equal(env.video().currentTime, 40 / 120 * 10, "按下的位置先落进播放器，抽的才是那一秒而不是当前帧");
    pointer("pointermove", 60);
    assert.equal(env.num(0).value, "5", "拖过去，起点跟着手走");
    assert.equal(marker.style.left, "50%", "黄线的位置就是起点");
    pointer("pointerup", 60);
    assert.ok(!track.classList.contains("dragging"), "松手要收掉拖中的样式，鼠标回到常态");
});

