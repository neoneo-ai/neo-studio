// Neo Gallery 首页顺序表：内置板块（Output/Input/收藏/Lora）与自定义目录同表排序、同表隐藏。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, jsonResponse, flush, fetchLog } from "./setup.mjs";

let NeoGallery;
async function loadNeoGallery() {
    if (!NeoGallery) ({ NeoGallery } = await import("../../web/gallery.js"));
    return NeoGallery;
}

const STARS = { name: "stars", path: "F:/data/stars", subdirs: { a: { image_count: 1 } }, root_count: 0 };
const BEAUTY = { name: "beauty", path: "F:/data/beauty", subdirs: { b: { image_count: 1 } }, root_count: 0 };
const LORA = { name: "Lora", path: "Lora", subdirs: { krea2: { image_count: 1 } }, root_count: 0 };
const DEFAULT_ORDER = ["Output", "Input", "local_bookmarks", "civitai_bookmarks", "F:/data/stars", "F:/data/beauty", "Lora"];

// 设置是服务端状态：保存即改写，重读即取回，列表按隐藏/开关过滤，和真实后端一致。
function setup({ order = DEFAULT_ORDER, hidden = [], lora = true, bookmark = true, dirs = [STARS, BEAUTY, LORA] } = {}) {
    const state = { order: [...order], hidden: [...hidden], lora, bookmark, dirs: [...dirs] };
    resetEnv();
    clearRoutes();
    mockRoute("/neo_gallery/get_settings", () => jsonResponse({
        custom_directories: ["F:/data/stars", "F:/data/beauty"],
        home_order: state.order,
        hidden_directories: state.hidden,
        civitai_lora_enabled: state.lora,
        civitai_bookmark_enabled: state.bookmark,
    }));
    mockRoute("/neo_gallery/save_settings", (body) => {
        if (body?.action === "set_hidden") {
            const key = String(body.path).toLowerCase();
            state.hidden = state.hidden.filter((h) => String(h).toLowerCase() !== key);
            if (body.hidden) state.hidden.push(body.path);
        }
        if (body?.action === "reorder") state.order = [...(body.paths || [])];
        return jsonResponse({ success: true });
    });
    mockRoute("/neo_gallery/list", () => {
        const hiddenKeys = state.hidden.map((h) => String(h).toLowerCase());
        const kept = state.dirs.filter((d) => {
            const key = d.name.toLowerCase();
            if (hiddenKeys.includes(key)) return false;
            if (key === "lora" && !state.lora) return false;
            return true;
        });
        return jsonResponse({ directories: kept, total: 0 });
    });
    mockRoute("/neo_bookmark/local", () => jsonResponse({ items: [] }));
    mockRoute("/neo_bookmark/civitai/list", () => jsonResponse({ success: false, disabled: true }));
    mockRoute("/neo_gallery/lora_dirs", () => jsonResponse({ dirs: [{ path: "krea2" }] }));
    return state;
}

async function makeGallery() {
    await loadNeoGallery();
    const gallery = new NeoGallery({ extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } });
    document.body.appendChild(gallery.element);
    await gallery.loadGallerySettings();
    await gallery.loadGallery();
    return gallery;
}

function homeCardNames() {
    return [...document.querySelectorAll(".neo-gallery-category-card .neo-gallery-card-name")].map((el) => el.textContent);
}

function rowByLabel(label) {
    return [...document.querySelectorAll(".neo-gallery-dir-item")].find(
        (item) => item.querySelector(".neo-gallery-dir-path")?.textContent === label);
}

function hideButtonOf(label) {
    return rowByLabel(label).querySelector(".neo-gallery-dir-ctl-btn:not(.neo-gallery-dir-settings-btn):not(.neo-gallery-dir-char-btn)");
}

function setHiddenCalls() {
    return fetchLog.filter((c) => c.path === "/neo_gallery/save_settings" && c.body?.action === "set_hidden");
}

test("顺序表决定首页卡片顺序：Lora 排在自定义目录之前", async () => {
    setup({ order: ["Output", "Input", "local_bookmarks", "civitai_bookmarks", "Lora", "F:/data/stars", "F:/data/beauty"] });
    const gallery = await makeGallery();
    await gallery.list.sortAndDisplayImages();
    assert.deepEqual(homeCardNames(), ["本地收藏", "C站收藏", "Lora", "stars", "beauty"]);
});

test("隐藏 Lora 行：保存 set_hidden Lora，首页 Lora 卡消失", async () => {
    const state = setup();
    const gallery = await makeGallery();
    await gallery.list.sortAndDisplayImages();
    assert.ok(homeCardNames().includes("Lora"), "初始首页有 Lora 卡");

    await gallery.settings.buildDirModal(gallery);
    const loraRow = rowByLabel("Lora");
    assert.ok(loraRow, "顺序表里应有 Lora 行");
    hideButtonOf("Lora").click();
    await flush(40);

    const calls = setHiddenCalls();
    assert.equal(calls.length, 1, "应保存隐藏状态");
    assert.equal(calls[0].body.path, "Lora");
    assert.equal(calls[0].body.hidden, true);
    assert.ok(state.hidden.includes("Lora"), "服务端已记录隐藏");
    assert.ok(rowByLabel("Lora").classList.contains("is-hidden"), "行应标记已隐藏");
    assert.ok(rowByLabel("Lora").querySelector(".neo-gallery-dir-hidden-badge"), "应显示已隐藏徽标");
    assert.ok(!rowByLabel("Output").classList.contains("is-hidden"), "未隐藏的行不应带隐藏样式");

    await gallery.list.sortAndDisplayImages();
    assert.ok(!homeCardNames().includes("Lora"), "首页不应再出现 Lora 卡");
});

test("隐藏 C站收藏行：该卡消失，本地收藏卡保留", async () => {
    const state = setup();
    const gallery = await makeGallery();
    await gallery.list.sortAndDisplayImages();
    assert.ok(document.querySelector(".neo-gallery-civitai-home"), "初始有 C站收藏卡");

    await gallery.settings.buildDirModal(gallery);
    hideButtonOf("C站收藏").click();
    await flush(40);

    assert.ok(state.hidden.includes("civitai_bookmarks"), "服务端已记录隐藏");
    assert.ok(document.querySelector(".neo-gallery-local-home"), "本地收藏卡不受影响");
    assert.equal(document.querySelector(".neo-gallery-civitai-home"), null, "C站收藏卡应移除");
});

test("Lora 行的 展开 C 站设置区与同步目录，再点一次收起", async () => {
    setup();
    const gallery = await makeGallery();
    await gallery.settings.buildDirModal(gallery);
    const btn = rowByLabel("Lora").querySelector(".neo-gallery-dir-settings-btn");
    assert.ok(btn, "Lora 行应有设置按钮");
    const area = document.querySelector(".neo-gallery-civitai-area");
    const list = document.querySelector(".neo-gallery-lora-dirs");
    assert.equal(area.style.display, "none", "C 站设置区默认隐藏");
    assert.equal(list.style.display, "none", "同步目录初始折叠");

    btn.click();
    await flush(40);
    assert.notEqual(area.style.display, "none", "点击后 C 站设置区应显示");
    assert.notEqual(list.style.display, "none", "点击后应展开");
    assert.ok(fetchLog.some((c) => c.path === "/neo_gallery/lora_dirs"), "应拉取同步目录");

    btn.click();
    assert.equal(area.style.display, "none", "再次点击应收起");
});

test("C站收藏行的 展开 C 站设置区并聚焦 API KEY，再点一次收起", async () => {
    setup();
    const gallery = await makeGallery();
    await gallery.settings.buildDirModal(gallery);
    const btn = rowByLabel("C站收藏").querySelector(".neo-gallery-dir-settings-btn");
    assert.ok(btn, "C站收藏行应有设置按钮");
    const area = document.querySelector(".neo-gallery-civitai-area");
    assert.equal(area.style.display, "none", "C 站设置区默认隐藏");

    btn.click();
    assert.notEqual(area.style.display, "none", "点击后 C 站设置区应显示");
    assert.equal(document.activeElement, document.querySelector(".neo-gallery-civitai-key-row .neo-gallery-dir-input"),
        "应聚焦 API KEY 输入框");

    btn.click();
    assert.equal(area.style.display, "none", "再次点击应收起");
});

test("内置行没有删除按钮，自定义目录行有删除按钮", async () => {
    setup();
    const gallery = await makeGallery();
    await gallery.settings.buildDirModal(gallery);
    assert.equal(rowByLabel("Lora").querySelector(".neo-gallery-dir-remove-btn"), null);
    assert.equal(rowByLabel("Output").querySelector(".neo-gallery-dir-remove-btn"), null);
    assert.ok(rowByLabel("F:/data/stars").querySelector(".neo-gallery-dir-remove-btn"));
});
