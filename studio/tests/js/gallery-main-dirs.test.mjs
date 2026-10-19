// Neo Gallery 主目录（StoryBoard / CharacterSheet）：只读云端预设卡、素材库按钮导航。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, jsonResponse, flush } from "./setup.mjs";
import { app, appState, resetSidebarTab } from "./mocks/comfy-app.mjs";

let NeoGallery;
async function loadNeoGallery() {
    if (!NeoGallery) ({ NeoGallery } = await import("../../web/gallery.js"));
    return NeoGallery;
}

function makeGallery() {
    const gallery = new NeoGallery({ extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } });
    document.body.appendChild(gallery.element);
    return gallery;
}

test("只读判定：云端预设目录与 presets 缓存不可删除", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();

    assert.equal(gallery.isDeletableItem("a.png", "StoryBoard/2026-09-24"), true);
    assert.equal(gallery.isDeletableItem("a.png", "CharacterSheet/2026-09-24"), true);
    assert.equal(gallery.isDeletableItem("a.png", "Cloud Presets/风格", "oss"), false);
    assert.equal(gallery.isDeletableItem("a.png", "presets/风格"), false);
    assert.equal(gallery.isDeletableItem("a.png", "presets"), false);
});

test("Cloud Presets 卡片按 path 导航到主目录的预设分支", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    const visits = [];
    gallery.showDirectoryStructure = (source, path) => { visits.push([source, path]); return Promise.resolve(); };

    gallery.currentView = { mode: "directory", source: "StoryBoard", categoryPath: [] };
    gallery.accordion.innerHTML = "";
    const structure = { subdirs: { "Cloud Presets": { image_count: 2, path: "presets", read_only: true, source: "oss" } }, items: [] };
    // 与 renderDirectoryStructure 一致的子目录列表（带 path / source）
    const subdirs = [{ name: "Cloud Presets", path: "presets", image_count: 2, source: "oss", read_only: true }];
    await gallery.list.renderSubdirCards(structure, "StoryBoard", [], subdirs);

    const card = document.querySelector(".neo-gallery-category-card");
    assert.ok(card, "应渲染 Cloud Presets 卡片");
    assert.equal(card.querySelector(".neo-gallery-card-name").textContent, "Cloud Presets");
    card.click();
    await flush();
    assert.deepEqual(visits, [["StoryBoard", ["presets"]]], "点击走 path=presets，而不是显示名");
});

test("中间目录卡片：按「主目录/相对路径」取出封面缩略图", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    gallery.maxThumbnailSize = 240;
    // 后端 /neo_gallery/list 返回的 covers key 与卡片导航路径一致
    gallery._dirCovers = {
        "CharacterSheet/2026-09-24": [{ filename: "sheet.png", subfolder: "CharacterSheet/2026-09-24" }],
    };
    gallery.accordion.innerHTML = "";
    const structure = { subdirs: { "2026-09-24": { image_count: 1 } }, items: [] };
    await gallery.list.renderSubdirCards(structure, "CharacterSheet", [], [{ name: "2026-09-24", image_count: 1 }]);

    const card = document.querySelector(".neo-gallery-category-card");
    assert.ok(card, "应渲染日期子目录卡片");
    const img = card.querySelector("img");
    assert.ok(img, "中间目录卡片应显示缩略图而不是空占位");
    assert.match(img.src, /filename=sheet\.png/);
    assert.match(img.src, /subfolder=CharacterSheet%2F2026-09-24/);
    assert.equal(card.querySelector(".neo-gallery-card-placeholder"), null);
});

test("素材库按钮：带目标主目录时打开侧栏并导航", async () => {
    resetEnv();
    clearRoutes();
    resetSidebarTab();
    const { toggleGallerySidebar } = await import("../../web/media-transfer.js");

    const visits = [];
    app.neoGallery = { showDirectoryStructure: (source, path) => { visits.push([source, path]); } };

    toggleGallerySidebar("CharacterSheet", []);
    assert.equal(app.extensionManager.sidebarTab.activeSidebarTabId, "neo.gallery", "打开素材面板");
    assert.deepEqual(visits, [["CharacterSheet", []]], "导航到 CharacterSheet 主目录");

    // 带目标再点一次 → 收起（开/关切换，不再重复导航）
    toggleGallerySidebar("CharacterSheet", []);
    assert.equal(app.extensionManager.sidebarTab.activeSidebarTabId, null, "带目标再点一次收起面板");
    assert.deepEqual(visits, [["CharacterSheet", []]], "收起时不重复导航");

    // 无目标：保持原有开/关切换
    toggleGallerySidebar();
    assert.equal(app.extensionManager.sidebarTab.activeSidebarTabId, "neo.gallery", "重新打开");
    toggleGallerySidebar();
    assert.equal(app.extensionManager.sidebarTab.activeSidebarTabId, null, "再次点击收起面板");

    delete app.neoGallery;
});

test("openGallerySidebar：总是打开侧栏并导航，已打开时不收起", async () => {
    resetEnv();
    clearRoutes();
    resetSidebarTab();
    const { openGallerySidebar } = await import("../../web/media-transfer.js");

    const visits = [];
    app.neoGallery = { showDirectoryStructure: (source, path) => { visits.push([source, path]); } };

    openGallerySidebar("Output", ["NeoAgent"]);
    assert.equal(app.extensionManager.sidebarTab.activeSidebarTabId, "neo.gallery", "打开素材面板");
    assert.deepEqual(visits, [["Output", ["NeoAgent"]]], "导航到目标目录");

    // 已打开时再调一次 → 保持打开并再次导航（不像 toggle 那样收起）
    openGallerySidebar("Output", []);
    assert.equal(app.extensionManager.sidebarTab.activeSidebarTabId, "neo.gallery", "保持打开");
    assert.deepEqual(visits, [["Output", ["NeoAgent"]], ["Output", []]], "再次导航");

    delete app.neoGallery;
});

test("civitaiBadge：缺 KEY / 连不上 / 未命中 / 仍在获取", async () => {
    const { civitaiBadge } = await import("../../web/gallery-card.js");

    // 既有语义不变：缺 KEY / 连不上 / 未命中 / 仍在获取
    assert.equal(civitaiBadge({ needs_api_key: true }).text, "需要配置 C 站 API KEY");
    assert.equal(civitaiBadge({ status: "failed", error: "Civitai HTTP 0" }).text, "C 站无法连接");
    assert.equal(civitaiBadge({ status: "not_found" }).text, "Not on Civitai");
    assert.equal(civitaiBadge({}).text, "Fetching from Civitai...");
    assert.equal(civitaiBadge({}).cls, "status-loading");
});

test("子目录卡与图片卡共用同一瀑布流容器：目录卡在前，衔接处不留空", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    gallery.maxThumbnailSize = 240;
    gallery.accordion.innerHTML = "";
    const structure = {
        subdirs: { "2026-09-24": { image_count: 1 } },
        items: [{ filename: "a.png", name: "a.png" }],
    };
    await gallery.list.renderSubdirCards(structure, "CharacterSheet", [], [{ name: "2026-09-24", image_count: 1 }]);

    const dirCard = document.querySelector(".neo-gallery-category-card");
    const imgCard = document.querySelector(".neo-gallery-thumb-container");
    assert.ok(dirCard, "应渲染子目录卡片");
    assert.ok(imgCard, "应渲染图片卡片");
    assert.equal(dirCard.parentElement, imgCard.parentElement, "目录卡与图片卡应共用同一瀑布流容器");
    assert.ok(dirCard.parentElement.classList.contains("neo-gallery-category-grid"));
    assert.equal(document.querySelector(".neo-gallery-image-grid"), null, "不应再创建独立图片网格容器");
});

