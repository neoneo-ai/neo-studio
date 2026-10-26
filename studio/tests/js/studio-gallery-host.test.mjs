// Studio 页里的画廊宿主：素材页进入目录 → 导演页素材库抽屉 → 反复开合，目录必须一路跟着走。
// 开合一次落首页、再开一次落目录这种交替，就是宿主记录只在摘走时写造成的（抽屉里刚浏览的
// 目录要等下次才生效）。这里用真实 studio-app.js 的切页与抽屉开合驱动，画廊也是真模块。
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
            subdirs: { "子目录": { name: "子目录", path: "子目录", image_count: 1 } },
        }],
        items: [{ filename: `i-${dir}-${path}.png`, subfolder: path, basename: `i-${dir}-${path}.png` }],
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

// 面包屑形如「>Output↩」，判目录只看它是否指向 Output
const atOutput = () => assert.ok(galleryState().crumb.includes("Output"), `应停在 Output：${galleryState().crumb}`);

let gallery;
const sideTab = (label) => [...document.querySelectorAll(".ns-side-tabs .ns-side-tab")]
    .find((b) => b.textContent.includes(label));

test("素材页进入目录 → 导演页素材库抽屉：目录跟着进抽屉，反复开合不落首页", async () => {
    document.body.innerHTML = `<div class="ns-header"><nav class="ns-tabs"><a href="#/gallery" data-tab="gallery">素材</a><a href="#/director" data-tab="director">导演</a><a href="#/skills" data-tab="skills">技能</a></nav></div><div id="ns-view"></div>`;
    await import("../../web/gallery.js");
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

    // 切到导演页开抽屉：抽屉里就是刚浏览的那个目录，不是首页
    location.hash = "#/director";
    await until(() => sideTab("素材"), "导演页素材库入口");
    click(sideTab("素材"));
    await until(() => galleryState().host === "director", "画廊挂进导演页抽屉");
    assert.equal(galleryState().dir, true, "开抽屉应停在刚浏览的目录");
    assert.equal(galleryState().home, false, "开抽屉不落首页");
    atOutput();

    // 关抽屉再开：还是那个目录（旧实现这里一次首页、一次目录）
    click(sideTab("配方"));
    await flush(3);
    click(sideTab("素材"));
    await flush(3);
    assert.equal(galleryState().host, "director");
    assert.equal(galleryState().dir, true, "重开抽屉仍是目录");
    atOutput();

    // 同一 tab 连点：不重挂、不刷新视图
    click(sideTab("素材"));
    await flush(3);
    assert.equal(galleryState().dir, true, "重复点同一 tab 不落首页");
    atOutput();

    // 回素材页，在目录里连点顶栏「素材」tab：锚点不能交给浏览器导航
    // （锚点按 href 重解析 URL 会丢掉 ?gallery=，浏览器还派发 popstate，画廊把它当「后退」，
    //   于是一次首页一次目录地交替）
    location.hash = "#/gallery";
    await until(() => galleryState().host === "page", "回到素材页");
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
    await until(() => sideTab("素材"), "导演页");
    assert.equal(location.hash, "#/director");
    assert.match(location.search, /gallery=/, "切页不该清掉 gallery 参数");
    click(navTab);
    await until(() => galleryState().host === "page", "切回素材页");
    assert.equal(galleryState().dir, true, `切页回来仍是目录：${galleryState().crumb}`);
    atOutput();

    // 顶栏换页也走同一条路由：没建过的视图（技能 / 设置按需建）照样要建出来
    click(document.querySelector('a[data-tab="skills"]'));
    await flush(3);
    assert.equal(location.hash, "#/skills");
    const shown = document.querySelector("#ns-view .ns-page:not(.ns-hidden)");
    assert.ok(shown && !shown.classList.contains("ns-director"), "技能页应作为新视图挂上");
});
