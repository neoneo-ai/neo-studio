// Studio「视频反推」页（web/reverse-video/reverse-video.js）：取视频 → 区间抽帧 → 一次请求吃整批 → SSE 上屏。
// 接口是 POST /rs_prompts/reverse_video_prompt，落点是视频同名的 .rp.txt —— 视频同名 .txt 是「视频再来一发」
// 读进去的生效参数旁车，反推结果不能落在那里。运行按钮交宿主的 gateRun（能力缺时点它引导启动内核）。
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, sseResponse, fetchLog, click, flush, sleep, window } from "./setup.mjs";
import { $el } from "../../web/studio/shim/ui.js";
// reverse-video.js 顶层导入 frames.js（它要 scripts/* 的 shim），必须等 setup.mjs 装好钩子再动态取
const {
    createReverseVideoView, REVERSE_LANGS, REVERSE_MAX_FRAMES, REVERSE_MAX_SIDE,
    REVERSE_VIDEO_API, videoReverseRequestBody, grabOnTrack,
} = await import("../../web/reverse-video/reverse-video.js");

// 用例的 mock 在建视图之前就注册，先清掉上一条用例留下的路由表
beforeEach(() => clearRoutes());

const settle = async () => { await flush(20); await sleep(0); await flush(20); };

/** 反推流的帧形与后端一致：meta 头帧不进正文，text 帧是增量，[DONE] 收尾 */
function mockVideoReverse(lines) {
    mockRoute(REVERSE_VIDEO_API, () => sseResponse([
        'data: {"meta":{"status":"start","language":"zh"}}',
        ...lines.map((line) => line.startsWith("data:") ? line : "data: " + JSON.stringify({ text: line })),
        "data: [DONE]",
    ]));
}

/** jsdom 的播放器不解码：时长、尺寸与 seek 桩成可预测的那一份 —— currentTime 一落就发 seeked */
function stubPlayer(el, { duration = 10, width = 1280, height = 720 } = {}) {
    let current = 0;
    Object.defineProperty(el, "duration", { get: () => duration, configurable: true });
    Object.defineProperty(el, "videoWidth", { get: () => width, configurable: true });
    Object.defineProperty(el, "videoHeight", { get: () => height, configurable: true });
    Object.defineProperty(el, "readyState", { get: () => 4, configurable: true });
    Object.defineProperty(el, "currentTime", {
        configurable: true,
        get: () => current,
        set: (value) => { current = value; el.dispatchEvent(new window.Event("seeked")); },
    });
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
    const api = { fetchApi: (path, opts) => fetch(path, opts) };
    const host = $el("div");
    document.body.appendChild(host);
    const toasts = [];
    const copied = [];
    const gated = [];
    let pickCb = null;
    const build = createReverseVideoView({
        api, $el,
        toast: (m) => toasts.push(m),
        openMaterial: (cb) => { pickCb = cb; },
        gateRun: (btn, feature, label) => { gated.push({ btn, feature, label }); },
    });
    // jsdom 没有剪贴板：桩一枚，复制这条路径才测得到「写进去的是哪一段」
    Object.defineProperty(window.navigator, "clipboard", {
        value: { writeText: async (text) => { copied.push(text); } },
        configurable: true, writable: true,
    });
    const env = {
        host, toasts, copied, gated,
        // 弹窗由宿主开：用例把交回来的那几条喂进回调（真弹窗单点也交长度为 1 的数组）
        pick: (items) => { click(env.button("从素材库选视频")); pickCb?.(items); },
        button: (label) => [...host.querySelectorAll(".ns-revvid-btn")].find((b) => b.textContent.includes(label)),
        // 复制钮按落点取，不按字取：复制成功那一刻它改口成「已复制」，按字就找不着了
        copy: () => host.querySelector(".ns-revvid-out-head .ns-revvid-btn"),
        chip: (label) => [...host.querySelectorAll(".ns-revvid-chip")].find((c) => c.textContent.includes(label)),
        out: () => host.querySelector(".ns-revvid-out"),
        outBox: () => host.querySelector(".ns-revvid-out-box"),
        status: () => host.querySelector(".ns-revvid-status"),
        run: () => host.querySelector(".ns-revvid-run"),
        video: () => host.querySelector(".ns-revvid-video"),
        track: () => host.querySelector(".ns-revvid-track"),
        rangeText: () => host.querySelector(".ns-revvid-timeline .ns-revvid-range"),
        stamps: () => [...host.querySelectorAll(".ns-revvid-frame figcaption")].map((e) => e.textContent),
        calls: () => fetchLog.filter((c) => c.path === REVERSE_VIDEO_API),
    };
    return build(host).then(() => env);
}

/** 桩里的片长是 10、滑轨宽 0..120px：拖的 clientX 除以 12 就是那一秒 */
function dragTimeline(env, clientX) {
    const track = env.track();
    const at = (type, x) => track.dispatchEvent(new window.MouseEvent(type, {
        clientX: x, bubbles: true, cancelable: true,
    }));
    return {
        down: () => at("pointerdown", clientX),
        move: () => at("pointermove", clientX),
        up: () => at("pointerup", clientX),
    };
}

/** 桩不解码：换片后手动补一发 loadedmetadata，时间窗才知道片长 */
function loadMeta(env) {
    env.video().dispatchEvent(new window.Event("loadedmetadata"));
}

test("视频反推请求体：每帧带自己在片中的秒数，区间带整片时长", () => {
    const body = videoReverseRequestBody(
        { filename: "clip.mp4", subfolder: "Video" }, "en",
        [{ t: 6.9, data: "data:image/png;base64,A" }, { t: 13.8, data: "data:image/png;base64,B" }],
        { start: 6.9, end: 13.8, duration: 30 });
    assert.equal(body.filename, "clip.mp4");
    assert.equal(body.subfolder, "Video");
    assert.equal(body.language, "en");
    assert.deepEqual(body.frames,
        [{ t: 6.9, data: "data:image/png;base64,A" }, { t: 13.8, data: "data:image/png;base64,B" }]);
    assert.deepEqual(body.range, { start: 6.9, end: 13.8, duration: 30 });
    assert.equal(REVERSE_MAX_FRAMES, 12, "帧数闸门与后端 REVERSE_VIDEO_MAX_FRAMES 同值");
    assert.ok(REVERSE_MAX_SIDE < 1280, "进模型的帧是缩过的，不是素材库那档原尺寸");
    assert.deepEqual(REVERSE_LANGS.map((l) => l.value), ["zh", "en"], "与后端认的那对取值同源");
});

test("拖轨落点钳位：拖离手最近的柄，窗口不交叉、端点不出片尾", () => {
    assert.deepEqual(grabOnTrack({ pos: 3, start: 0, end: 10, duration: 10 }), { start: 3, end: 10 });
    assert.deepEqual(grabOnTrack({ pos: 7, start: 0, end: 10, duration: 10 }), { start: 0, end: 7 });
    // 终点柄拖过头只到片尾；起点柄拖过界只到 0
    assert.deepEqual(grabOnTrack({ pos: 40, start: 2, end: 8, duration: 10 }), { start: 2, end: 10 });
    assert.deepEqual(grabOnTrack({ pos: -5, start: 2, end: 8, duration: 10 }), { start: 0, end: 8 });
    // 落点离哪个柄近就拖哪个：越过另一个柄时把它顶到最小窗口，窗口不许倒挂
    assert.deepEqual(grabOnTrack({ pos: 9.6, start: 2, end: 9.8, duration: 10 }), { start: 2, end: 9.6 });
    assert.deepEqual(grabOnTrack({ pos: 9.6, start: 9, end: 9.8, duration: 10 }), { start: 9, end: 9.6 });
    // 最小窗口顶位：起点柄拖过终点柄，起点停在终点 - 0.5
    assert.deepEqual(grabOnTrack({ pos: 9.6, start: 9.8, end: 9.9, duration: 10 }), { start: 9.4, end: 9.9 });
    assert.deepEqual(grabOnTrack({ pos: 1, start: 4, end: 6, duration: 10 }), { start: 1, end: 6 });
    assert.deepEqual(grabOnTrack({ pos: 2, start: 4, end: 6, duration: 10 }), { start: 2, end: 6 });
});

test("没选视频时只有起手卡片：抽帧与反推不出可点的控件", async () => {
    resetEnv();
    const env = await mounted();
    assert.ok(env.host.querySelector(".ns-revvid-empty"), "起手卡片要告诉用户从哪儿起手");
    assert.ok(env.host.querySelector(".ns-revvid-main").hidden, "没有视频就不铺播放器与结果框");
    assert.ok(env.run().disabled, "一批帧都没抽，反推就不该发得出去");
    assert.ok(env.button("从素材库选视频"), "起手卡片上就是那枚选片钮");
    assert.deepEqual(env.gated.map((g) => [g.feature, g.label]), [["prompt_reverse_video", "反推"]],
        "运行按钮交宿主闸门：离线时点它引导启动内核");
    assert.equal(env.calls().length, 0, "建页不发请求");
});

test("选上片：播放器走分段视频源，抽帧之前反推点不动", async () => {
    resetEnv();
    const env = await mounted();
    env.pick([{ filename: "clip.mp4", subfolder: "Output" }]);
    await settle();
    assert.match(env.video().src, /\/neo_frames\/video\?filename=clip\.mp4/, "seek 要分段响应");
    assert.match(env.host.querySelector(".ns-revvid-source").textContent, /Output\/clip\.mp4/);
    assert.ok(env.host.querySelector(".ns-revvid-empty").hidden, "选上片就收起手卡片");
    assert.ok(env.host.querySelector(".ns-revvid-main").hidden === false);
    assert.ok(env.run().disabled, "没抽帧就没有这一发可发");
    assert.equal(env.calls().length, 0, "选片本身不发反推");
});

test("拖时间窗抽帧铺成帧条，反推一发带时间戳与区间，落点写进 .rp.txt", async () => {
    resetEnv();
    stubCanvas();
    mockVideoReverse(["一座", "红色灯塔", "缓慢推近"]);
    const env = await mounted();
    stubPlayer(env.video());
    env.pick([{  filename: "clip.mp4", subfolder: "" }]);
    await settle();
    loadMeta(env);
    click(env.chip("4 帧"));
    dragTimeline(env, 24).down();     // 起点柄拖到 2s
    dragTimeline(env, 24).up();
    dragTimeline(env, 96).down();     // 终点柄拖到 8s
    dragTimeline(env, 96).up();
    click(env.button("抽帧"));
    await settle();
    assert.deepEqual(env.stamps(), ["00:02.000", "00:04.000", "00:06.000", "00:08.000"],
        "帧条上的标签就是这一帧在片中的那一秒");
    assert.match(env.toasts.join("|"), /抽了 4 帧/);
    assert.ok(!env.run().disabled, "抽好了帧，这一发就该发得出去");

    assert.ok(env.outBox().hidden && env.out().textContent === "", "没有正文：结果框整块收着");
    const scrolled = [];
    env.outBox().scrollIntoView = (opts) => scrolled.push(opts);   // 整页跟随滚动的落点与方式
    click(env.run());
    await settle();
    assert.equal(env.out().textContent, "一座红色灯塔缓慢推近");
    assert.ok(!env.outBox().hidden, "正文落屏，结果框才现身");
    assert.equal(scrolled.length, 3, "正文每落一块，整页跟一次到底");
    assert.ok(scrolled.every((o) => o.block === "end"), "跟随的是整页滚动，滚到结果框底沿");
    assert.match(env.status().textContent, /已生成，结果写进视频同名的 \.rp\.txt/);
    const calls = env.calls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.filename, "clip.mp4");
    assert.equal(calls[0].body.language, "zh");
    assert.deepEqual(calls[0].body.frames.map((f) => f.t), [2, 4, 6, 8]);
    assert.equal(calls[0].body.frames[0].data, "data:image/png;base64,FRAME", "发出去的是 canvas 的 PNG");
    assert.deepEqual(calls[0].body.range, { start: 2, end: 8, duration: 10 });
});

test("结果框收着等正文：抽帧时不出现，出结果才出现，换片收回去", async () => {
    resetEnv();
    stubCanvas();
    mockVideoReverse(["灯塔"]);
    const env = await mounted();
    stubPlayer(env.video());
    env.pick([{ filename: "clip.mp4", subfolder: "" }]);
    await settle();
    assert.ok(env.outBox().hidden, "选上片也没有正文：结果框不占地方");
    click(env.button("抽帧"));
    await settle();
    assert.ok(env.outBox().hidden, "抽完帧还是没有正文：框不提前亮");
    click(env.run());
    await settle();
    assert.ok(!env.outBox().hidden, "正文回来，结果框亮了");
    env.pick([{ filename: "clip-b.mp4", subfolder: "" }]);
    await settle();
    assert.ok(env.outBox().hidden, "换片把上一条的结果一起收走");
});

test("时间窗拖起来：播放器跳到那一帧预览，读数与刻度跟着手走，全片一键铺满", async () => {
    resetEnv();
    const env = await mounted();
    stubPlayer(env.video());
    env.pick([{ filename: "clip.mp4", subfolder: "" }]);
    await settle();
    loadMeta(env);
    assert.ok(env.rangeText().textContent.includes("片尾"), "片长一落地窗口铺满全片：不拖抽的就是整片");
    assert.equal(env.track().querySelectorAll(".ns-revvid-tick").length, 4,
        "默认 4 帧的刻度标出这一批落在哪几秒");
    const drag = dragTimeline(env, 24);
    drag.down();
    assert.equal(env.video().currentTime, 2, "起点柄拖到 2s，播放器就播那一帧");
    assert.ok(env.rangeText().textContent.includes("起点 00:02.000"), "读数当场跟着手走");
    drag.up();
    assert.ok(!env.track().classList.contains("dragging"), "松手收掉拖中样式");
    click(env.button("全片"));
    assert.equal(env.video().currentTime, 2, "一键全片只动窗口，不翻播放器");
    assert.ok(env.rangeText().textContent.includes("片尾"), "全片把窗口铺回去");
});

test("拖轨的键盘替代：聚焦滑轨 ←→ 动近侧柄，Shift 五倍档，Home 铺满全片", async () => {
    resetEnv();
    const env = await mounted();
    stubPlayer(env.video());
    env.pick([{ filename: "clip.mp4", subfolder: "" }]);
    await settle();
    loadMeta(env);
    const track = env.track();
    assert.equal(track.tabIndex, 0, "滑轨进 Tab 走查：键盘读者够得着这枚控件");
    const drag = dragTimeline(env, 24);   // 起点柄拖到 2s：窗口 2..10，之后键盘动的就是终点那侧
    drag.down(); drag.move(); drag.up();
    const key = (k, shift = false) => {
        const ev = new window.KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true });
        track.dispatchEvent(ev);
        return ev.defaultPrevented;
    };
    assert.ok(key("ArrowLeft"), "方向键被滑轨吃掉，不连带滚页");
    assert.ok(env.rangeText().textContent.includes("终点 00:09.500"), "← 把近侧柄挪 0.5s");
    key("ArrowLeft", true);
    assert.ok(env.rangeText().textContent.includes("终点 00:04.500"), "Shift← 五倍档挪 5s");
    key("Home");
    assert.ok(env.rangeText().textContent.includes("片尾"), "Home 铺回全片");
});



test("中途换片：上一批帧收干净，反推回到禁用", async () => {
    resetEnv();
    stubCanvas();
    mockVideoReverse(["这一段"]);
    const env = await mounted();
    stubPlayer(env.video());
    env.pick([{  filename: "clip-a.mp4", subfolder: "" }]);
    await settle();
    click(env.button("抽帧"));
    await settle();
    assert.equal(env.stamps().length, 4, "默认 4 帧");
    env.pick([{  filename: "clip-b.mp4", subfolder: "" }]);
    await settle();
    assert.deepEqual(env.stamps(), [], "换片就是把上一批帧收掉：那一批属于上一条视频");
    assert.equal(env.out().textContent, "", "上一条视频的反推正文不留在这一条的结果框里");
    assert.ok(env.outBox().hidden, "结果框随上一条片一起收起");
    assert.ok(env.run().disabled);
    assert.match(env.video().src, /clip-b\.mp4/);
});

test("语言切英文：请求体吃 en（后端把语言与帧数一起写进 .rp-lang 标记）", async () => {
    resetEnv();
    stubCanvas();
    mockVideoReverse(["a lighthouse"]);
    const env = await mounted();
    stubPlayer(env.video());
    env.pick([{  filename: "clip.mp4", subfolder: "" }]);
    await settle();
    click(env.chip("英文"));
    click(env.button("抽帧"));
    await settle();
    click(env.run());
    await settle();
    assert.equal(env.calls()[0].body.language, "en");
    assert.equal(env.calls()[0].body.frames.length, 4);
    assert.equal(env.out().textContent, "a lighthouse");
});

test("流里的 [ERROR]：状态句写失败原因，结果框不留假成功", async () => {
    resetEnv();
    stubCanvas();
    mockVideoReverse(["data: [ERROR] 视觉模型没有配上视觉档"]);
    const env = await mounted();
    stubPlayer(env.video());
    env.pick([{  filename: "clip.mp4", subfolder: "" }]);
    await settle();
    click(env.button("抽帧"));
    await settle();
    click(env.run());
    await settle();
    assert.match(env.status().textContent, /视觉模型没有配上视觉档/);
    assert.equal(env.out().textContent, "");
    assert.ok(env.outBox().hidden, "失败了就没有结果框：不拿空框摆出「有结果」的样子");
    assert.ok(!env.run().disabled, "这一发失败了，钮要回到能点的状态");
});

test("复制提示词送进去的是结果框正文；空结果只说清楚", async () => {
    resetEnv();
    stubCanvas();
    mockVideoReverse(["一座红色灯塔"]);
    const env = await mounted();
    stubPlayer(env.video());
    env.pick([{  filename: "clip.mp4", subfolder: "" }]);
    await settle();
    click(env.copy());
    await settle();
    assert.match(env.toasts.join("|"), /还没有可复制的提示词/);
    assert.deepEqual(env.copied, []);
    assert.ok(env.outBox().hidden, "空结果时没有那一只空框");
    click(env.button("抽帧"));
    await settle();
    click(env.run());
    await settle();
    click(env.copy());
    await settle();
    assert.deepEqual(env.copied, ["一座红色灯塔"]);
});
