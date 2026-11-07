// 图片卡「⋯」菜单「复用参数重跑」：素材旁同名 .txt 读得到提示词才上线，点开把提示词与
// 出图尺寸填进「生成素材」输入卡。探测走 /neo_gallery/media_meta 的 reuse，一次探测与
// 「导入工作流」共用（同一张卡片不该为菜单发两次请求）。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, jsonResponse, fetchLog, sleep, click } from "./setup.mjs";

function toastApp() {
    return { extensionManager: { toast: { added: [], add(t) { this.added.push(t); } } } };
}

async function loadModules() {
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true }]));
    const [{ GalleryCard }, { NeoGallery }] = await Promise.all([
        import("../../web/gallery-card.js"),
        import("../../web/gallery.js"),
    ]);
    return { GalleryCard, NeoGallery };
}

const itemOf = (label) => [...document.querySelectorAll(".neo-gallery-collect-item")]
    .find((el) => el.textContent.includes(label));

test("卡片菜单「复用参数重跑」：.txt 有提示词才显示，点开填进生成素材输入卡", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard, NeoGallery } = await loadModules();
    mockRoute("/neo_gallery/media_meta", () => jsonResponse({
        has: false,
        reuse: { prompt: "一只橘猫的白底图", seed: 7, width: 1536, height: 864, model: "krea2.safetensors" },
    }));

    const card = new GalleryCard({});
    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "cat", filename: "cat.png" }, "NeoAgent/2026-10-01", "local", anchor);
    await sleep(40);

    const item = itemOf("复用参数重跑");
    assert.ok(item, "图片卡应挂出「复用参数重跑」");
    assert.equal(item.style.display, "", "探测到提示词后才放开这一项");
    click(item);
    await sleep(60);

    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    assert.ok(overlay, "点开应打开「生成素材」面板");
    assert.equal(overlay.querySelector(".neo-gallery-gm-quick-input").value, "一只橘猫的白底图", "提示词填进输入框");
    const [ratioSel, edgeSel] = overlay.querySelector(".neo-gallery-gm-size-row").querySelectorAll("select");
    assert.equal(ratioSel.value, "16:9", "宽高比按副文件尺寸选中");
    assert.equal(edgeSel.value, "1536", "最长边按副文件尺寸选中");
    assert.equal(fetchLog.filter(c => c.path === "/neo_gallery/media_meta").length, 1, "一次探测两处共用（按文件缓存）");
});

test("卡片菜单「复用参数重跑」：.txt 读不到提示词就不出这一项，「导入工作流」照旧", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard, NeoGallery } = await loadModules();
    mockRoute("/neo_gallery/media_meta", () => jsonResponse({
        has: true, workflow: { nodes: [] }, prompt: null, reuse: null,
    }));

    const card = new GalleryCard({});
    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "cat", filename: "cat.png" }, "NeoAgent/2026-10-01", "local", anchor);
    await sleep(40);

    assert.equal(itemOf("导入工作流")?.style.display, "", "内嵌工作流照旧放开「导入工作流」");
    assert.equal(itemOf("复用参数重跑")?.style.display, "none", "没有可复用提示词就不放开这一项");
});

test("卡片菜单「复用参数重跑」：视频卡挂出这一项，点开交给出视频页（页没就绪就 info 说清）", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard, NeoGallery } = await loadModules();
    mockRoute("/neo_gallery/media_meta", () => jsonResponse({
        has: false, reuse: { video: true, prompt: "一段视频的提示词", width: 1280, height: 720, seed: 9 },
    }));

    const card = new GalleryCard({});
    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "clip", filename: "clip.mp4" }, "NeoAgent/2026-10-01", "local", anchor);
    await sleep(40);

    const item = itemOf("复用参数重跑");
    assert.ok(item, "视频卡也挂得出「复用参数重跑」");
    assert.equal(item.style.display, "", "探测到可复用参数才放开这一项");
    click(item);
    await sleep(40);
    // 这条 jsdom 环境没挂载出视频页：复用交不出去的兜底是一句 info，不是报错，也不开任何面板
    const notice = [...document.querySelectorAll("#neo-action-toast-stack .neo-at")].map((el) => el.textContent);
    assert.ok(notice.some((s) => s.includes("出视频页尚未就绪")), "视频页没就绪时 info 说清");
    assert.equal(document.querySelector(".neo-gallery-gm-modal-overlay"), null, "视频复用不开「生成素材」面板");
});
test("卡片菜单「复用参数重跑」：副文件带原图与参考图的编辑图，点开交给图片编辑面板", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard, NeoGallery } = await loadModules();
    mockRoute("/neo_gallery/media_meta", () => jsonResponse({
        has: false,
        reuse: {
            prompt: "把背景换成海边日落", seed: 9, width: 1152, height: 1152, skill: "qwen_image_21",
            mode: "blend", src: { filename: "src.png", subfolder: "NeoAgent/2026-10-01" },
            refs: [{ filename: "face.png", subfolder: "NeoAgent/2026-10-01" }],
        },
    }));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "copied.png" }));
    mockRoute("/neo_image_gen/settings", () => jsonResponse({ target_megapixels: 1.5 }));

    const card = new GalleryCard({});
    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "edit", filename: "edit.png" }, "NeoAgent/2026-10-01", "local", anchor);
    await sleep(40);

    const item = itemOf("复用参数重跑");
    assert.ok(item && item.style.display === "", "编辑图同样挂出这一项");
    click(item);
    await sleep(80);

    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    assert.ok(overlay, "带原图的复用把这一发交给图片编辑面板");
    assert.equal(document.querySelector(".neo-gallery-gm-modal-overlay"), null, "同一发只开一块面板");
    assert.match(overlay.querySelector(".neo-gallery-story-input").value, /把背景换成海边日落/);
    assert.match(overlay.querySelector(".neo-gallery-edit-compare-img")?.getAttribute("src") || "", /filename=src\.png/);
});

test("卡片菜单「复用参数重跑」：只有提示词与尺寸的旧版副文件照走「生成素材」面板", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard, NeoGallery } = await loadModules();
    mockRoute("/neo_gallery/media_meta", () => jsonResponse({
        has: false, reuse: { prompt: "旧版副文件的提示词", seed: 3, width: 1024, height: 1024 },
    }));

    const card = new GalleryCard({});
    const gallery = new NeoGallery(toastApp());
    document.body.appendChild(gallery.element);
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "old", filename: "old.png" }, "NeoAgent/2026-10-01", "local", anchor);
    await sleep(40);

    click(itemOf("复用参数重跑"));
    await sleep(60);

    assert.ok(document.querySelector(".neo-gallery-gm-modal-overlay"), "旧版副文件降级回「生成素材」面板");
    assert.equal(document.querySelector(".neo-gallery-edit-modal-overlay"), null, "没有原图就不开编辑面板");
});


