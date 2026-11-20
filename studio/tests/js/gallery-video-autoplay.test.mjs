// 素材库视频卡片：进视口才发预览请求、视口里有几条播几条、出视口停回第一帧、10 秒封顶只作用于卡片预览、
// 一发 404 之后回到视口能重来。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, flush } from "./setup.mjs";

let utils;
async function loadUtils() {
    if (!utils) utils = await import("../../web/gallery-utils.js");
    return utils;
}

let NeoGallery;
async function loadNeoGallery() {
    if (!NeoGallery) ({ NeoGallery } = await import("../../web/gallery.js"));
    return NeoGallery;
}

// 共享的 IntersectionObserver 只在首次注册时创建一次，可控桩必须在本文件第一个用例里装好。
const observed = new Map();
function installManualObserver() {
    globalThis.IntersectionObserver = class {
        constructor(cb) { this._cb = cb; }
        observe(el) { observed.set(el, this); }
        unobserve(el) { observed.delete(el); }
        disconnect() { }
        fire(el, isIntersecting) { this._cb([{ target: el, isIntersecting }], this); }
    };
}
function enterView(el) {
    observed.get(el).fire(el, true);
}
function leaveView(el) {
    observed.get(el).fire(el, false);
}

/** jsdom 没有媒体后端：play/pause/currentTime 用可断言的桩替掉，元素自己记次数。 */
function stubPlayback(v) {
    v.play = () => { v.__play = (v.__play || 0) + 1; return Promise.resolve(); };
    v.pause = () => { v.__pause = (v.__pause || 0) + 1; };
    Object.defineProperty(v, "currentTime", { value: 0, writable: true, configurable: true });
    return v;
}
function makeVideo() {
    const v = stubPlayback(document.createElement("video"));
    document.body.appendChild(v);
    return v;
}
function playedCount(list) {
    return list.reduce((sum, v) => sum + (v.__play || 0), 0);
}

test("视频卡片在封面上叠一格静音预览：渲染时不发预览请求", async () => {
    resetEnv();
    clearRoutes();
    installManualObserver();
    const Neo = await loadNeoGallery();
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const gallery = new Neo({ extensionManager: { toast: { added: [], add() { } } } });
    document.body.appendChild(gallery.element);
    const card = new GalleryCard({}).createImageElement(
        gallery, { name: "clip", filename: "clip.mp4", mtime: 100 }, "Output", "Output");
    document.body.appendChild(card);

    const preview = card.querySelector("video.neo-gallery-thumb-video-preview");
    const cover = card.querySelector(".neo-gallery-thumb-img-wrapper img");
    assert.ok(preview, "视频卡片要有预览层");
    assert.equal(preview.muted, true, "卡片预览静音：有声本体留给灯箱");
    assert.equal(preview.loop, true, "循环播");
    assert.equal(preview.playsInline, true, "内联播，不弹全屏层");
    assert.equal(preview.preload, "none", "没有 src 之前不预载");
    assert.equal(preview.getAttribute("src"), null, "渲染阶段不发预览请求");
    assert.match(preview.dataset.previewSrc, /neo_gallery\/preview\?filename=clip\.mp4/, "预览走 preview 那条地址");
    assert.match(cover.dataset.thumbnailSrc, /neo_gallery\/thumbnail/, "封面照旧是懒加载缩略图，当预览的 poster");
});

test("进视口才挂 src 起播；出视口暂停并回到第一帧", async () => {
    resetEnv();
    installManualObserver();
    const { registerLazyVideo } = await loadUtils();
    const v = makeVideo();
    registerLazyVideo(v, "http://test.local/neo_gallery/preview?filename=clip.mp4");
    assert.equal(v.getAttribute("src"), null, "没进视口之前不发请求");

    enterView(v);
    assert.match(v.src, /neo_gallery\/preview/, "进视口才挂 src");
    assert.equal(v.__play, 1, "进视口起播");

    v.currentTime = 7.5;
    leaveView(v);
    assert.equal(v.__pause, 1, "出视口暂停");
    assert.equal(v.currentTime, 0, "回到第一帧：再进视口是从头播，不是从半路接上");
});

test("视口里有几条播几条：进视口的各自起播，出视口只停自己那一格", async () => {
    resetEnv();
    installManualObserver();
    const { registerLazyVideo, releaseLazyVideos } = await loadUtils();
    const videos = [];
    for (let i = 0; i < 5; i++) {
        const v = makeVideo();
        registerLazyVideo(v, `http://test.local/neo_gallery/preview?filename=v${i}.mp4`);
        videos.push(v);
    }
    videos.slice(0, 4).forEach(enterView);
    assert.deepEqual(videos.map((v) => v.__play || 0), [1, 1, 1, 1, 0],
        "进视口的四条各自起播，没进视口的那条一条都不发");

    leaveView(videos[1]);
    assert.equal(videos[1].__pause, 1, "出视口只停自己那一格");
    assert.equal(videos[0].__pause, undefined, "留在视口里的一格不跟着停");
    assert.equal(playedCount(videos), 4, "腾出来的一格不给别的格子补播");
    releaseLazyVideos(document.body);
});

test("预览发过 404 的卡片再进视口重挂 src：一次失败不把它判死到页面关闭", async () => {
    resetEnv();
    clearRoutes();
    installManualObserver();
    const Neo = await loadNeoGallery();
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { releaseLazyVideos } = await loadUtils();
    const gallery = new Neo({ extensionManager: { toast: { added: [], add() { } } } });
    document.body.appendChild(gallery.element);
    const card = new GalleryCard({}).createImageElement(
        gallery, { name: "clip", filename: "clip.mp4", mtime: 100 }, "Output", "Output");
    document.body.appendChild(card);
    const preview = card.querySelector("video.neo-gallery-thumb-video-preview");
    stubPlayback(preview);

    enterView(preview);
    assert.match(preview.src, /neo_gallery\/preview/, "进视口挂上预览");

    // 后端压不出预览（这台机器没有 ffmpeg / 这一发在队列里等满了）就是 404：媒体元素进 error 状态
    preview.dispatchEvent(new Event("error"));
    assert.equal(preview._previewFailed, true, "卡片记下这一发没拿到预览");
    assert.ok(preview.classList.contains("neo-gallery-thumb-video-preview--failed"), "先停在封面上");

    // 这一格在观察者们眼里始终存在（--failed 不能 display:none），出视口再进就有这一次重挂
    leaveView(preview);
    enterView(preview);
    assert.match(preview.src, /neo_gallery\/preview/, "再进视口重新挂 src：元素进了 error 不换 src 不再加载");
    assert.equal(preview.__play, 2, "重新起播");
    assert.equal(preview._previewFailed, false, "失败标记随重挂摘掉");
    assert.ok(!preview.classList.contains("neo-gallery-thumb-video-preview--failed"), "失败样式一并摘掉");

    releaseLazyVideos(document.body);
});

test("10 秒封顶只作用在卡片预览：到点回到第一帧", async () => {
    resetEnv();
    installManualObserver();
    const { registerLazyVideo, releaseLazyVideos } = await loadUtils();
    const v = makeVideo();
    registerLazyVideo(v, "http://test.local/neo_gallery/preview?filename=long.mp4");
    enterView(v);

    // 云端预设带的是发布时压好的整片：卡片这一刀按 timeupdate 补齐，本地片永远到不了这一档
    v.currentTime = 11;
    v.dispatchEvent(new Event("timeupdate"));
    assert.equal(v.currentTime, 0, "超过 10 秒回到第一帧循环");

    v.currentTime = 9;
    v.dispatchEvent(new Event("timeupdate"));
    assert.equal(v.currentTime, 9, "10 秒以内不动它");

    releaseLazyVideos(document.body);   // 共享观察者活到本文件结束：不把这张卡片留给后面的用例
});

test("releaseLazyVideos 释放容器：在播的全部停下，释放之后不再有起播", async () => {
    resetEnv();
    installManualObserver();
    const { registerLazyVideo, releaseLazyVideos } = await loadUtils();
    const grid = document.createElement("div");
    document.body.appendChild(grid);
    const videos = [];
    for (let i = 0; i < 5; i++) {
        const v = stubPlayback(document.createElement("video"));
        grid.appendChild(v);
        registerLazyVideo(v, `http://test.local/neo_gallery/preview?filename=g${i}.mp4`);
        videos.push(v);
    }
    videos.forEach(enterView);
    assert.equal(playedCount(videos), 5, "五条都在视口里就五条都播");

    releaseLazyVideos(grid);
    grid.innerHTML = "";
    await flush(30);
    assert.equal(playedCount(videos), 5, "释放之后不给已移除的卡片起播");
    videos.forEach((v) => assert.ok(v.__pause >= 1, "释放时在播的全部停下"));
});
