// Neo Gallery LoRA 目录卡「⋯」刷新：重读 safetensors 头部元数据（本地，不重新下载示例图）。
// LoRA 目录卡显示刷新按钮，菜单项调 /neo_gallery/lora_refresh_dir 后重显当前目录。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep, click } from "./setup.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

function itemByLabel(label) {
    return [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes(label));
}

function makeGallery() {
    return {
        app: { extensionManager: { toast: { add: () => {} } } },
        maxThumbnailSize: 320,
        displayLabels: true,
        deleteItem() {},
        jumps: [],
        currentView: { source: "Lora", categoryPath: ["SDXL"] },
        showDirectoryStructure(source, path) { this.jumps.push([source, path]); return Promise.resolve(); },
    };
}

async function makeCard(gallery, subdirName, parentDir, fullPath, subdirData) {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const card = new GalleryCard(gallery);
    return card.createSubdirCard(gallery, subdirName, parentDir, fullPath, subdirData);
}

test("LoRA 目录卡：显示刷新 ⋯ 按钮", async () => {
    const gallery = makeGallery();
    const card = await makeCard(gallery, "SDXL", "Lora", ["SDXL"], { image_count: 0 });
    assert.ok(card.querySelector(".neo-gallery-card-dir-menu-btn"), "LoRA 目录卡应有 ⋯ 刷新按钮");
});

test("非 LoRA 目录卡：不显示刷新按钮", async () => {
    const gallery = makeGallery();
    const card = await makeCard(gallery, "empty", "Input", ["empty"], { image_count: 0 });
    assert.equal(card.querySelector(".neo-gallery-card-dir-menu-btn"), null, "非 LoRA 空目录无 ⋯ 按钮");
});

test("点 ⋯：菜单显示「刷新元数据」与目录路径", async () => {
    const gallery = makeGallery();
    const card = await makeCard(gallery, "SDXL", "Lora", ["SDXL"], { image_count: 0 });
    click(card.querySelector(".neo-gallery-card-dir-menu-btn"));
    assert.ok(itemByLabel("刷新元数据"), "应有「刷新元数据」菜单项");
    assert.equal(document.querySelector(".neo-gallery-collect-path").textContent, "SDXL",
        "路径应为 models/loras 相对目录");
});

test("点「刷新元数据」：POST lora_refresh_dir 传目录并重显当前视图", async () => {
    const gallery = makeGallery();
    const card = await makeCard(gallery, "SDXL", "Lora", ["SDXL"], { image_count: 0 });

    let body = null;
    mockRoute("/neo_gallery/lora_refresh_dir", (b) => {
        body = b;
        return jsonResponse({ success: true, updated: 3 });
    });

    click(card.querySelector(".neo-gallery-card-dir-menu-btn"));
    click(itemByLabel("刷新元数据"));
    await sleep(50);

    assert.deepEqual(body, { dir: "SDXL" }, "应 POST 目录路径");
    assert.deepEqual(gallery.jumps.at(-1), ["Lora", ["SDXL"]], "刷新后应重显当前目录");
});

test("刷新失败：不重显目录", async () => {
    const gallery = makeGallery();
    const card = await makeCard(gallery, "SDXL", "Lora", ["SDXL"], { image_count: 0 });

    mockRoute("/neo_gallery/lora_refresh_dir", () => jsonResponse({ success: false, error: "目录不存在" }, 400));

    click(card.querySelector(".neo-gallery-card-dir-menu-btn"));
    click(itemByLabel("刷新元数据"));
    await sleep(50);

    assert.equal(gallery.jumps.length, 0, "失败不应重显目录");
});
