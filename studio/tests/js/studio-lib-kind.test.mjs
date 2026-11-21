// 素材库弹窗开窗落在哪一类上：画布「加视频输入」「加音频输入」与抽帧 / 视频反推 / 声音克隆开的那一扇，
// 开窗就在 视频 / 音频 / 图片 那一类标签里，不用在混合列表里挑。导演页出片参考区媒体全收，开窗不动现落位。
// 驱动用真 studio-app.js 的弹窗开合，画廊也是真模块——标签栏与归类视图照生产那份跑。
import test from "node:test";
import assert from "node:assert/strict";
import { mockRoute, jsonResponse, sleep, click, flush } from "./setup.mjs";
import { app as mockApp, appState as mockAppState } from "./mocks/comfy-app.mjs";
// 真替身侧栏：写 activeSidebarTabId 就是导演页那颗「素材库」钮的开弹窗路径
import { app as shimApp } from "../../web/studio/shim/app.js";

// studio-app.js 顶层连 WebSocket 取 #ns-view，导入前必须先备好这两样
globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

mockRoute("/neo_studio/version", jsonResponse({
    success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
}));
mockRoute("/neo_gallery/home_config", () => jsonResponse({
    home_entries: ["Output"],
    home_dir_index: { Output: { path: "", type: "output" } },
}));
mockRoute("/neo_gallery/list", (body, call) => {
    const dir = call.query.get("dir_name") || "";
    return jsonResponse({
        success: true, total: 1,
        directories: [{ name: "Output", path: "", root_count: dir ? 1 : 2, subdirs: {} }],
    });
});
// 归类标签：kind 为空只回条数（标签栏要显示数量），给了 kind 带回那一类的条目。
// 音频那一类全库为空是这一份 fixture 的固定形状——开窗落在哪一类的断言不能被计数刷新抢跑
const KIND_COUNTS = { image: 4, video: 2, audio: 0, character: 0, pose: 0, storyboard: 0, frames: 0 };
const KIND_VIDEOS = [
    { name: "clip-a.mp4", filename: "clip-a.mp4", type: "video", dir_name: "Output", subfolder: "Output", custom_source: "Output", mtime: 2 },
    { name: "clip-b.mp4", filename: "clip-b.mp4", type: "video", dir_name: "Output", subfolder: "Output", custom_source: "Output", mtime: 1 },
];
mockRoute("/neo_gallery/kind_items", (body, call) => {
    const kind = call.query.get("kind") || "";
    return jsonResponse(kind
        ? { counts: KIND_COUNTS, kind, truncated: false, items: KIND_VIDEOS }
        : { counts: KIND_COUNTS });
});
mockRoute("/neo_gallery/*", () => jsonResponse({}));
mockRoute("/neo_bookmark/local", () => jsonResponse({ bookmarks: [] }));
mockRoute("/neo_bookmark/civitai/list", () => jsonResponse({ bookmarks: [] }));
mockRoute("/neo_bookmark/*", () => jsonResponse({ bookmarks: [] }));
mockRoute("/neo_image_gen/*", () => jsonResponse({ success: true }));
mockRoute("/neo_studio/*", () => jsonResponse({ success: true }));
mockRoute("/rs_recipes/*", () => jsonResponse([]));
mockRoute("/rs_prompts/*", () => jsonResponse([]));
mockRoute("/userdata/*", () => jsonResponse({}));

async function until(fn, what) {
    for (let i = 0; i < 60; i++) {
        if (fn()) return;
        await sleep(20);
    }
    assert.fail(`等待超时：${what}`);
}

const libModal = () => document.querySelector(".ns-libmodal:not(.ns-hidden)");
const kindChips = () => [...document.querySelectorAll(".ns-libmodal .neo-gallery-kind-chip")];
const activeChipText = () => kindChips().filter((c) => c.classList.contains("active")).map((c) => c.textContent).join("|");
const modalCards = () => [...document.querySelectorAll(".ns-libmodal .neo-gallery-thumb-container")];

/** 开窗一次：面板抢跑一步经 neo:media-pick 交来取用回调与这一扇收的那一类，写侧栏 id 落地开弹窗 */
function openLib(accept) {
    window.dispatchEvent(new CustomEvent("neo:media-pick", { detail: { target: null, onPick: () => { }, accept } }));
    shimApp.extensionManager.sidebarTab.activeSidebarTabId = "neo.gallery";
}
async function closeLib() {
    click(libModal().querySelector(".ns-libmodal-close"));
    await flush(3);
}

test("素材库弹窗开窗落在取用类别那一类标签上", async () => {
    document.body.innerHTML = `<div class="ns-header"><nav class="ns-tabs"><a href="#/gallery" data-tab="gallery">素材</a><a href="#/director" data-tab="director">导演</a></nav><a class="ns-head-btn" id="ns-settings-btn" href="#/settings" title="设置"></a></div><div id="ns-view"></div>`;
    await import("../../web/gallery.js");
    for (const ext of mockAppState.extensions) await ext.setup?.();
    for (const tab of mockAppState.sidebarTabs) shimApp.extensionManager.registerSidebarTab(tab);
    const gallery = mockApp.neoGallery;   // setup 里建好的真实例
    // 生产里 importmap 把 scripts/app.js 指到这层 shim，画廊实例就挂在同一个 app 上；
    // 测试环境两条 app 各一份，宿主读 app.neoGallery 要把同一个实例接上
    shimApp.neoGallery = gallery;
    await import("../../web/studio/studio-app.js");
    location.hash = "#/director";
    // 路由落定才算就位：导演的页子建得早（常驻），顶栏那枚 active 是 showView 落完才点亮的，
    // 拿页面里的元素当闸门会把开窗抢在切页之前——弹窗会被那次切页关掉
    await until(() => document.querySelector('a[data-tab="director"].active'), "导演页路由落定");

    // 媒体全收的那一扇（导演页出片的参考区）：开窗停在原落位，不切归类
    openLib(null);
    await until(() => libModal(), "素材库弹窗开窗");
    await flush(3);
    assert.notEqual(gallery.currentView.mode, "kind", `媒体全收不该切归类：${activeChipText()}`);
    await closeLib();

    // 只收视频的那一扇（画布「加视频输入」、抽帧页、视频反推）：开窗直接落在 视频 标签
    openLib("video");
    await until(() => gallery.currentView.mode === "kind" && gallery.currentView.source === "video", "开窗落在视频归类");
    assert.match(activeChipText(), /视频/, `标签栏应点亮 视频：${kindChips().map((c) => c.textContent).join("|")}`);
    await until(() => modalCards().length > 0, "视频归类铺出卡片");
    assert.deepEqual(modalCards().map((c) => c.dataset.filename), ["clip-a.mp4", "clip-b.mp4"],
        "窗里只铺视频那一类");
    await closeLib();

    // 这一类在全库里是空的（音频一条没有）：不切——标签栏自己也是不足两枚就撤，
    // 切过去等于把用户关在一页没有素材、没有出口标签的列表里
    openLib("audio");
    await until(() => libModal(), "第二扇弹窗开窗");
    await flush(8);
    assert.notEqual(gallery.currentView.source, "audio",
        `音频那一类是空的就不落音频归类：${activeChipText()}`);
});
