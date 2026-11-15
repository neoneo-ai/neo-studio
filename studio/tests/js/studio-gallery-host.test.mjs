// Studio 页里的画廊宿主：素材页进入目录 → 导演页素材库弹窗 → 反复开合，目录必须一路跟着走。
// 开合一次落首页、再开一次落目录这种交替，就是宿主记录只在摘走时写造成的（弹窗里刚浏览的
// 目录要等下次才生效）。这里用真实 studio-app.js 的切页与弹窗开合驱动，画廊也是真模块。
import test from "node:test";
import assert from "node:assert/strict";
import { mockRoute, jsonResponse, sleep, click, flush, missingRoutes } from "./setup.mjs";
import { app as mockApp, appState as mockAppState } from "./mocks/comfy-app.mjs";
// 真替身侧栏：studio-app.js 用的就是它，注册 tab 后 getSidebarTab / onSidebarTabChange 都走同一份状态
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
    home_entries: ["Output", "Input"],
    home_dir_index: { Output: { path: "", type: "output" }, Input: { path: "", type: "input" } },
}));
mockRoute("/neo_gallery/list", (body, call) => {
    const dir = call.query.get("dir_name") || "";
    const path = call.query.get("path") || "";
    if (!dir) {
        return jsonResponse({
            success: true, total: 3,
            directories: [{
                name: "Output", path: "", root_count: 3,
                subdirs: { "子目录": { name: "子目录", path: "子目录", image_count: 1 } },
            }],
        });
    }
    return jsonResponse({
        success: true, total: 1,
        directories: [{
            name: dir, path, root_count: 1,
            subdirs: {},
            items: [{ filename: `i-${dir}-${path}.png`, name: `i-${dir}-${path}.png`, subfolder: path, basename: `i-${dir}-${path}.png` }],
        }],
        items: [{ filename: `i-${dir}-${path}.png`, name: `i-${dir}-${path}.png`, subfolder: path, basename: `i-${dir}-${path}.png` }],
    });
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

/** 当前可见宿主里的画廊状态：目录页面包屑可见，首页有分类卡片。 */
function galleryState() {
    const host = [...document.querySelectorAll(".ns-gallery-host")].find((h) => h.contains(gallery.element));
    if (!host) return { host: null };
    const crumb = host.querySelector("#neo-gallery-breadcrumb");
    return {
        host: host.dataset.libScope || "?",
        dir: !!crumb && crumb.style.display !== "none",
        home: !!host.querySelector(".neo-gallery-category-card"),
        crumb: crumb ? crumb.textContent.trim() : "",
    };
}

const homeCard = (name) => [...document.querySelectorAll(".neo-gallery-category-card")]
    .find((c) => c.querySelector(".neo-gallery-card-name")?.textContent === name);

// 卡片边长看宿主：素材库弹窗钉最小档（滑杆在弹窗里收掉了），素材页照旧跟 Size 滑杆
let minCardSize = 0;   // 最小档常量在 gallery-utils 里，桩钩子装好才认得它（见 setup.mjs 第一行）
const modalCards = () => [...document.querySelectorAll(".ns-libmodal .neo-gallery-thumb-container")];
const pageCards = () => [...document.querySelectorAll(".ns-gallery-host[data-lib-scope='page'] .neo-gallery-thumb-container")];
const widthsOf = (cards) => cards.map((c) => c.style.width).join(",");

// 面包屑形如「>Output↩」，判目录只看它是否指向 Output
const atOutput = () => assert.ok(galleryState().crumb.includes("Output"), `应停在 Output：${galleryState().crumb}`);

let gallery;
const barBtn = (label) => [...document.querySelectorAll(".ns-director-bar button")]
    .find((b) => b.textContent.includes(label));
const libModal = () => document.querySelector(".ns-libmodal:not(.ns-hidden)");
// 素材库入口就在本页配方条右端：进页铺好配方条就能开弹窗，不再要先起一份配方挂编辑器
async function openEditorForLib() {
    await until(() => document.querySelector(".ns-director-bar"), "配方条就位");
}

test("素材页进入目录 → 导演页素材库弹窗：目录跟着进弹窗，反复开合不落首页", async () => {
    document.body.innerHTML = `<div class="ns-header"><nav class="ns-tabs"><a href="#/gallery" data-tab="gallery">素材</a><a href="#/director" data-tab="director">导演</a></nav><a class="ns-head-btn" id="ns-settings-btn" href="#/settings" title="设置"></a></div><div id="ns-view"></div>`;
    await import("../../web/gallery.js");
    minCardSize = (await import("../../web/gallery-utils.js")).THUMBNAIL_SIZE_MIN;
    // 跑 gallery 扩展的 setup：真 NeoGallery 实例与真 tab 定义都在里面，交给替身侧栏
    for (const ext of mockAppState.extensions) await ext.setup?.();
    for (const tab of mockAppState.sidebarTabs) shimApp.extensionManager.registerSidebarTab(tab);
    gallery = mockApp.neoGallery;   // setup 里建好的真实例
    await import("../../web/studio/studio-app.js");

    // 素材页：进入 Output
    location.hash = "#/gallery";
    await until(() => homeCard("Output"), "素材页首页目录卡片");
    click(homeCard("Output"));
    await until(() => galleryState().dir, "进入 Output 目录");
    assert.ok(galleryState().crumb.includes("Output"), `面包屑应指向 Output：${galleryState().crumb}`);

    // 切到导演页开弹窗：弹窗里就是刚浏览的那个目录，不是首页
    location.hash = "#/director";
    // 路由落定才算就位：导演的页子建得早（常驻），顶栏那枚 active 是 showView 落完才点亮的，
    // 用它等就不抢在 hashchange 之前开弹窗——弹窗会被那次切页关掉，卡片永远铺不出来
    await until(() => document.querySelector('a[data-tab="director"].active'), "导演页路由落定");
    await openEditorForLib();
    click(barBtn("素材库"));
    await until(() => galleryState().host === "director", "画廊挂进素材库弹窗");
    assert.equal(galleryState().dir, true, "开弹窗应停在刚浏览的目录");
    assert.equal(galleryState().home, false, "开弹窗不落首页");
    atOutput();

    // 弹窗里的卡片不吃 Size 滑杆：滑杆管素材页密度，弹窗只挑图，卡片固定最小档
    await until(() => modalCards().length > 0, "弹窗里铺出卡片");
    assert.ok(modalCards().every((c) => c.style.width === `${minCardSize}px`),
        `弹窗卡片应是最小档 ${minCardSize}px：${widthsOf(modalCards())}`);

    // 关弹窗再开：还是那个目录（旧实现这里一次首页、一次目录）
    click(libModal().querySelector(".ns-libmodal-close"));
    await flush(3);
    click(barBtn("素材库"));
    await flush(3);
    assert.equal(galleryState().host, "director");
    assert.equal(galleryState().dir, true, "重开弹窗仍是目录");
    atOutput();

    // 弹窗开着时连点同一按钮：不重挂、不刷新视图
    click(barBtn("素材库"));
    await flush(3);
    assert.ok(libModal(), "连点同一按钮弹窗保持打开");
    assert.equal(galleryState().dir, true, "重复点同一按钮不落首页");
    atOutput();

    // 回素材页，在目录里连点顶栏「素材」tab：锚点不能交给浏览器导航
    // （锚点按 href 重解析 URL 会丢掉 ?gallery=，浏览器还派发 popstate，画廊把它当「后退」，
    //   于是一次首页一次目录地交替）
    location.hash = "#/gallery";
    await until(() => galleryState().host === "page", "回到素材页");
    await until(() => pageCards().length > 0, "素材页铺出卡片");
    assert.ok(pageCards().every((c) => c.style.width === `${gallery.maxThumbnailSize}px`),
        `素材页卡片跟 Size 滑杆（${gallery.maxThumbnailSize}px）：${widthsOf(pageCards())}`);
    assert.match(location.search, /gallery=/, "进过目录，URL 里带着 gallery 参数");
    const navTab = document.querySelector('a[data-tab="gallery"]');
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    navTab.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, "顶栏 tab 的点击由 Studio 路由接管");
    await flush(3);
    assert.equal(galleryState().dir, true, `连点当前 tab 不落首页：${galleryState().crumb}`);
    atOutput();
    assert.match(location.search, /gallery=/, "点当前 tab 不该清掉 gallery 参数");

    // 切导演页再切回：路由接管后 URL 参数原样保留，画廊仍停在目录
    click(document.querySelector('a[data-tab="director"]'));
    await until(() => document.querySelector('a[data-tab="director"].active'), "导演页路由落定");
    assert.equal(location.hash, "#/director");
    assert.match(location.search, /gallery=/, "切页不该清掉 gallery 参数");
    click(navTab);
    await until(() => galleryState().host === "page", "切回素材页");
    assert.equal(galleryState().dir, true, `切页回来仍是目录：${galleryState().crumb}`);
    atOutput();

    // 深链进没建过的视图：技能页不占顶栏位（入口是首页那张卡），按需建视图这条路由照样走得通
    location.hash = "#/skills";
    await until(() => document.querySelector("#ns-view .ns-page:not(.ns-hidden)"), "技能页挂上");
    assert.equal(location.hash, "#/skills");
    const shown = document.querySelector("#ns-view .ns-page:not(.ns-hidden)");
    assert.ok(shown && !shown.classList.contains("ns-director"), "技能页应作为新视图挂上");
});
