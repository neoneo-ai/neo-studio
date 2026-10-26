// Neo Gallery 目录管理：角色图目录标记（）——提交 set_character，行内亮起「角色图」徽标，画廊据此把
// 多选建配方切成全参考（见 gallery-director-recipe.test.mjs）。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, jsonResponse, flush, fetchLog, click } from "./setup.mjs";

let NeoGallery;
async function loadNeoGallery() {
    if (!NeoGallery) ({ NeoGallery } = await import("../../web/gallery.js"));
    return NeoGallery;
}

const BASE = ["Output", "Input", "local_bookmarks", "civitai_bookmarks", "Lora"];
const CLOUD = "Cloud Presets/角色杂图";

async function makeGallery() {
    await loadNeoGallery();
    const gallery = new NeoGallery({ extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } });
    document.body.appendChild(gallery.element);
    gallery.loadGallery = async () => {};
    gallery.list.sortAndDisplayImages = () => {};
    return gallery;
}

function rowByLabel(label) {
    return [...document.querySelectorAll(".neo-gallery-dir-item")].find(
        (item) => item.querySelector(".neo-gallery-dir-path")?.textContent === label);
}

function calls(action) {
    return fetchLog.filter((c) => c.path === "/neo_gallery/save_settings" && c.body?.action === action);
}

function setup(characterDirs = [], customDirs = []) {
    resetEnv();
    clearRoutes();
    const state = { character_dirs: [...characterDirs] };
    mockRoute("/neo_gallery/get_settings", () => jsonResponse({
        custom_directories: [...customDirs], home_order: [...BASE, ...customDirs, CLOUD],
        hidden_directories: [], character_dirs: state.character_dirs,
    }));
    // 真后端会回写配置：这里照做，否则标记后的重读会把画廊侧状态打回旧值
    mockRoute("/neo_gallery/save_settings", (body) => {
        if (body?.action === "set_character") {
            const key = String(body.path).toLowerCase();
            if (body.character) { if (!state.character_dirs.includes(key)) state.character_dirs.push(key); }
            else state.character_dirs = state.character_dirs.filter((c) => c !== key);
        }
        return jsonResponse({ success: true });
    });
    return state;
}

test("标记角色图目录：提交小写无关的 token，行内亮起徽标与常亮按钮", async () => {
    setup();
    const gallery = await makeGallery();
    await gallery.settings.buildDirModal(gallery);

    const row = rowByLabel("☁ 角色杂图");
    assert.equal(row.querySelector(".neo-gallery-dir-char-badge"), null, "未标记时不显示徽标");
    assert.ok(!row.querySelector(".neo-gallery-dir-char-btn").classList.contains("is-on"));

    click(row.querySelector(".neo-gallery-dir-char-btn"));
    await flush();

    assert.deepEqual(calls("set_character")[0].body, { action: "set_character", path: CLOUD, character: true });
    const marked = rowByLabel("☁ 角色杂图");
    assert.equal(marked.querySelector(".neo-gallery-dir-char-badge")?.textContent, "角色图", "标记后行内显示徽标");
    assert.ok(marked.querySelector(".neo-gallery-dir-char-btn").classList.contains("is-on"), "按钮保持点亮");
    assert.ok(gallery.characterDirs.has("cloud presets/角色杂图"), "画廊侧同步，建配方立即按全参考走");

    click(marked.querySelector(".neo-gallery-dir-char-btn"));
    await flush();
    assert.deepEqual(calls("set_character")[1].body, { action: "set_character", path: CLOUD, character: false });
    assert.equal(rowByLabel("☁ 角色杂图").querySelector(".neo-gallery-dir-char-badge"), null, "取消后徽标消失");
    assert.ok(!gallery.characterDirs.has("cloud presets/角色杂图"));
});

test("已标记目录：打开弹窗就带徽标（设置里读到的 character_dirs 回显）", async () => {
    setup(["cloud presets/角色杂图"]);
    const gallery = await makeGallery();
    await gallery.settings.buildDirModal(gallery);

    const row = rowByLabel("☁ 角色杂图");
    assert.equal(row.querySelector(".neo-gallery-dir-char-badge")?.textContent, "角色图");
    assert.ok(row.querySelector(".neo-gallery-dir-char-btn").classList.contains("is-on"));
    assert.equal(calls("set_character").length, 0, "只是回显，不该重复提交");
});

test("标记对子目录生效：父目录标了角色图，子目录里的多选也按全参考建配方", async () => {
    // 自定义目录：画廊按目录名寻址（source = stars），设置里存绝对路径 —— 两边要能对上
    setup(["f:\\lib\\stars"], ["F:\\lib\\stars"]);
    const gallery = await makeGallery();
    await gallery.loadGallerySettings();

    gallery.currentView = { mode: "directory", source: "stars", categoryPath: ["孟子义"] };
    assert.equal(gallery.isCharacterDir(), true, "子目录继承父目录标记");
    gallery.currentView = { mode: "directory", source: "beauty", categoryPath: [] };
    assert.equal(gallery.isCharacterDir(), false, "没标记的目录不受影响");
    gallery.currentView = { mode: "categories" };
    assert.equal(gallery.isCharacterDir(), false, "首页视图不算目录");
});
