// Neo Gallery「新建导演配方」（卡片菜单 + 多选操作条）：子文件夹里的图必须先经 copy_to_input
// 落到 input/ 根目录再建配方——导演编辑器的帧一律按 /view?subfolder=（空）解析。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, fetchLog, flush, sleep, click, jsonResponse } from "./setup.mjs";

function toastApp() {
    return { extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } };
}

async function loadModules() {
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    const [{ GalleryCard }, { NeoGallery }] = await Promise.all([
        import("../../web/gallery-card.js"),
        import("../../web/gallery.js"),
    ]);
    return { GalleryCard, NeoGallery };
}

function ffImgs() {
    // 只取时间轴各段行的首帧槽位（统一设置区有同构镜像槽位，不算）
    return [...document.querySelectorAll(".neo-director-segs .neo-director-seg")]
        .map((row) => row.querySelector(".neo-director-setup-seg-thumb img")?.getAttribute("src"))
        .filter(Boolean);
}

// 各段参考图网格里的瓷砖（参考视频 / 音频格为空，不会混进来）
function segRefImgs() {
    return [...document.querySelectorAll(".neo-director-segs .neo-director-seg .neo-director-refpick-item")]
        .map((tile) => tile.dataset.file);
}

// 配方级 角色参考图
function charRefs() {
    return [...document.querySelectorAll(".neo-director-setup-char .neo-director-refpick-item")]
        .map((tile) => tile.dataset.file);
}

test("卡片菜单「新建导演配方」：子文件夹图先经 copy_to_input 落盘，编辑器首帧用落盘后文件名", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard, NeoGallery } = await loadModules();
    const copies = [];
    mockRoute("/neo_gallery/copy_to_input", (body, call) => {
        copies.push({ filename: call.query.get("filename"), subfolder: call.query.get("subfolder") });
        return jsonResponse({ success: true, filename: "photo_in.png" });
    });

    const card = new GalleryCard({});
    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "photo", filename: "photo_2026-09-09_00-43-40.jpg" }, "2026-09-09", "local", anchor);

    const item = [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes("新建导演配方"));
    assert.ok(item, "图片卡片应显示「新建导演配方」菜单项");
    click(item);
    await flush();
    await sleep(60);

    assert.deepEqual(copies, [{ filename: "photo_2026-09-09_00-43-40.jpg", subfolder: "2026-09-09" }], "应带 filename+subfolder 先拷贝到 input/");
    assert.deepEqual(ffImgs(), ["/view?filename=photo_in.png&subfolder=&type=input"], "首帧缩略图应指向落盘后的文件名（subfolder 为空）");
});

test("卡片菜单「新建导演配方」：input 根目录图不拷贝，直接用原文件名", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard, NeoGallery } = await loadModules();

    const card = new GalleryCard({});
    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "root", filename: "root.jpg" }, "", "local", anchor);

    const item = [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes("新建导演配方"));
    click(item);
    await flush();
    await sleep(60);

    assert.equal(fetchLog.filter((c) => c.path === "/neo_gallery/copy_to_input").length, 0, "根目录图无需拷贝");
    assert.deepEqual(ffImgs(), ["/view?filename=root.jpg&subfolder=&type=input"]);
});

test("卡片菜单「新建导演配方」：角色图目录里单图也走全参考（图进参考图与 角色参考图）", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard, NeoGallery } = await loadModules();
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "sheet_in.png" }));

    const card = new GalleryCard({});
    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    gallery.characterDirs.add("cloud presets/明朝人物");
    gallery.currentView = { mode: "directory", source: "Cloud Presets/明朝人物", categoryPath: [] };
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "001", filename: "001_寒门新科举子.png" }, "Cloud Presets/明朝人物", "oss", anchor);

    const item = [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes("新建导演配方"));
    assert.equal(item.textContent, "新建导演配方（全参考）", "菜单项在角色图目录里标出全参考");
    click(item);
    await flush();
    await sleep(60);

    assert.equal(document.querySelector(".neo-director-mode").value, "r2v");
    assert.equal(document.querySelectorAll(".neo-director-segs .neo-director-seg").length, 1);
    assert.deepEqual(segRefImgs(), ["sheet_in.png"], "图进该段参考图");
    assert.deepEqual(ffImgs(), [], "不当首帧");
    assert.deepEqual(charRefs(), ["sheet_in.png"], "同时进 角色参考图");
});

test("多选操作条「新建导演配方」：仅子文件夹图被拷贝，各段首帧按落盘名建配方并清空选中", async () => {
    resetEnv();
    clearRoutes();
    const { NeoGallery } = await loadModules();
    const copies = [];
    mockRoute("/neo_gallery/copy_to_input", (body, call) => {
        copies.push({ filename: call.query.get("filename"), subfolder: call.query.get("subfolder") });
        return jsonResponse({ success: true, filename: "a_in.png" });
    });

    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    gallery.toggleSelection("a.png", "2026-09-09");
    gallery.toggleSelection("b.png", "");

    await gallery.createDirectorFromSelection();
    await flush();
    await sleep(60);

    assert.deepEqual(copies, [{ filename: "a.png", subfolder: "2026-09-09" }], "只拷贝子文件夹里的图");
    assert.deepEqual(ffImgs(), [
        "/view?filename=a_in.png&subfolder=&type=input",
        "/view?filename=b.png&subfolder=&type=input",
    ]);
    assert.equal(document.querySelector(".neo-director-mode").value, "f2v", "普通目录仍按分镜生视频（图作首帧）");
    assert.equal(gallery._selectedItems.size, 0, "建配方后选中集合清空");
});

test("角色图目录多选「新建导演配方」：整批合成一段全参考，图进参考图与 角色参考图", async () => {
    resetEnv();
    clearRoutes();
    const { NeoGallery } = await loadModules();

    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    gallery.characterDirs.add("charactersheet");   // 目录设置里标记过的 token（小写）
    gallery.currentView = { mode: "directory", source: "CharacterSheet", categoryPath: [] };
    gallery.toggleSelection("a.png", "");
    gallery.toggleSelection("b.png", "");
    gallery.toggleSelection("c.png", "");

    await gallery.createDirectorFromSelection();
    await flush();
    await sleep(60);

    assert.equal(document.querySelectorAll(".neo-director-segs .neo-director-seg").length, 1, "整批只建一段");
    assert.equal(document.querySelector(".neo-director-mode").value, "r2v", "默认全参考生视频");
    assert.deepEqual(segRefImgs(), ["a.png", "b.png", "c.png"], "图按选中顺序进该段参考图");
    assert.deepEqual(ffImgs(), [], "三视图不再当关键帧");
    assert.deepEqual(charRefs(), ["a.png", "b.png", "c.png"], "同时进 角色参考图");
    assert.equal(gallery._selectedItems.size, 0, "建配方后选中集合清空");
});

test("角色图目录里的云端预设图：多选后由 copy_to_input 现下到 input，再按全参考建一段", async () => {
    resetEnv();
    clearRoutes();
    const { NeoGallery } = await loadModules();
    const copies = [];
    mockRoute("/neo_gallery/copy_to_input", (body, call) => {
        copies.push({ filename: call.query.get("filename"), subfolder: call.query.get("subfolder") });
        return jsonResponse({ success: true, filename: `in_${copies.length}.png` });
    });

    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    gallery.characterDirs.add("cloud presets/明朝人物");
    gallery.currentView = { mode: "directory", source: "Cloud Presets/明朝人物", categoryPath: [] };
    gallery.toggleSelection("001_寒门新科举子.png", "Cloud Presets/明朝人物");
    gallery.toggleSelection("002_忠臣首辅.png", "Cloud Presets/明朝人物");

    await gallery.createDirectorFromSelection();
    await flush();
    await sleep(60);

    assert.deepEqual(copies, [
        { filename: "001_寒门新科举子.png", subfolder: "Cloud Presets/明朝人物" },
        { filename: "002_忠臣首辅.png", subfolder: "Cloud Presets/明朝人物" },
    ], "云端图走 copy_to_input（后端从 OSS 缓存下载）");
    assert.equal(document.querySelector(".neo-director-mode").value, "r2v");
    assert.equal(document.querySelectorAll(".neo-director-segs .neo-director-seg").length, 1);
    assert.deepEqual(segRefImgs(), ["in_1.png", "in_2.png"]);
    assert.deepEqual(ffImgs(), [], "云端三视图同样不当关键帧");
});

test("多选操作条「新建导演配方」：拷贝失败时报错且不打开编辑器", async () => {
    resetEnv();
    clearRoutes();
    const { NeoGallery } = await loadModules();
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: false, error: "Image not found" }, 404));

    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    gallery.toggleSelection("a.png", "2026-09-09");

    await gallery.createDirectorFromSelection();
    await flush();

    assert.equal(document.querySelector(".neo-director-segs"), null, "拷贝失败不应打开编辑器");
    const toasts = gallery.app.extensionManager.toast.added;
    assert.ok(toasts.some((t) => t.severity === "error" && /无法读取 a\.png/.test(t.detail)), "应提示读取失败");
});
