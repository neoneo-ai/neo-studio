// 素材库视频卡片：进视口才发预览请求、并发上限 2、出视口停回第一帧、15 秒封顶只作用于卡片预览。
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

test("并发上限 2：一屏进 5 条只播 2 条，停掉一条才补下一条", async () => {
    resetEnv();
    installManualObserver();
    const { registerLazyVideo, releaseLazyVideos } = await loadUtils();
    const videos = [];
    for (let i = 0; i < 5; i++) {
        const v = makeVideo();
        registerLazyVideo(v, `http://test.local/neo_gallery/preview?filename=v${i}.mp4`);
        videos.push(v);
    }
    videos.forEach(enterView);
    assert.equal(playedCount(videos), 2, "同时最多 2 条在播");

    const playing = videos.find(v => v.__play);
    leaveView(playing);
    assert.equal(playedCount(videos), 3, "腾出的一格立刻补上排队里下一条");
    releaseLazyVideos(document.body);   // 并发计数是模块级的：不把在播的格子留给后面的用例
});

test("15 秒封顶只作用在卡片预览：到点回到第一帧", async () => {
    resetEnv();
    installManualObserver();
    const { registerLazyVideo, releaseLazyVideos } = await loadUtils();
    const v = makeVideo();
    registerLazyVideo(v, "http://test.local/neo_gallery/preview?filename=long.mp4");
    enterView(v);

    // 云端预设带的是发布时压好的整片：卡片这一刀按 timeupdate 补齐，本地片永远到不了这一档
    v.currentTime = 16;
    v.dispatchEvent(new Event("timeupdate"));
    assert.equal(v.currentTime, 0, "超过 15 秒回到第一帧循环");

    v.currentTime = 9;
    v.dispatchEvent(new Event("timeupdate"));
    assert.equal(v.currentTime, 9, "15 秒以内不动它");

    // 并发计数是模块级的：用例结尾把这张释放掉，不把在播的那一格留给后面的用例
    releaseLazyVideos(document.body);
});

test("releaseLazyVideos 释放容器：排队里的卡片不再起播", async () => {
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
    assert.equal(playedCount(videos), 2, "两条在播，三条排队");

    releaseLazyVideos(grid);
    grid.innerHTML = "";
    await flush(30);
    assert.equal(playedCount(videos), 2, "释放后排队任务作废，不给已移除的卡片起播");
    videos.forEach((v) => assert.ok(v.__pause >= 1, "释放时在播的全部停下"));
});
