// Neo Gallery 目录卡「LoRA 打标」：可写叶子图片目录卡显示 ⋯ 按钮，点开弹窗（触发词 + 自动标准化），
// 调 /neo_gallery/tag_dir 批量生成标签 .txt。仅可写来源且含图片的目录卡显示该入口。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sseResponse, sleep, click, window } from "./setup.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

function itemByLabel(label) {
    return [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes(label));
}

// gallery 桩：只实现本次流程真正用到的成员（toast / 重显目录）
function makeGallery() {
    return {
        gallery: {
            app: { extensionManager: { toast: { add: () => {} } } },
            maxThumbnailSize: 320,
            displayLabels: true,
            deleteItem() {},
            jumps: [],
            showDirectoryStructure(source, path) { this.jumps.push([source, path]); return Promise.resolve(); },
        },
    };
}

async function makeCard(gallery, subdirName, parentDir, fullPath, subdirData) {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const card = new GalleryCard(gallery);
    return card.createSubdirCard(gallery, subdirName, parentDir, fullPath, subdirData);
}

test("目录卡：可写叶子图片目录显示 ⋯ 按钮", async () => {
    const { gallery } = makeGallery();
    const card = await makeCard(gallery, "关晓彤", "Input", ["stars", "关晓彤"], { image_count: 12 });
    assert.ok(card.querySelector(".neo-gallery-card-dir-menu-btn"), "应有 ⋯ 按钮");
});

test("目录卡：只读来源（presets）不显示 ⋯ 按钮", async () => {
    const { gallery } = makeGallery();
    const card = await makeCard(gallery, "a", "Output", ["presets", "a"], { image_count: 3 });
    assert.equal(card.querySelector(".neo-gallery-card-dir-menu-btn"), null);
});

test("目录卡：无图片的目录（image_count=0）不显示 ⋯ 按钮", async () => {
    const { gallery } = makeGallery();
    const card = await makeCard(gallery, "empty", "Input", ["empty"], { image_count: 0 });
    assert.equal(card.querySelector(".neo-gallery-card-dir-menu-btn"), null);
});

test("点 ⋯：菜单显示「LoRA 打标」与目录路径", async () => {
    const { gallery } = makeGallery();
    const card = await makeCard(gallery, "关晓彤", "Input", ["stars", "关晓彤"], { image_count: 12 });
    click(card.querySelector(".neo-gallery-card-dir-menu-btn"));
    assert.ok(itemByLabel("LoRA 打标"), "应有「LoRA 打标」菜单项");
    const pathEl = document.querySelector(".neo-gallery-collect-path");
    assert.equal(pathEl.textContent, "Input/stars/关晓彤");
});

test("点「LoRA 打标」：弹窗 preflight 填建议触发词，点「开始打标」调 /neo_gallery/tag_dir 并显示结果", async () => {
    const { gallery } = makeGallery();
    const card = await makeCard(gallery, "关晓彤", "Input", ["stars", "关晓彤"], { image_count: 12 });

    mockRoute("/neo_gallery/tag_preflight", () => jsonResponse({
        image_count: 12, suggested_trigger: "gxt", has_heif: false, heif_available: true,
    }));
    click(card.querySelector(".neo-gallery-card-dir-menu-btn"));
    click(itemByLabel("LoRA 打标"));

    const overlay = document.querySelector(".neo-gallery-lt-modal-overlay");
    assert.ok(overlay, "应弹出打标弹窗");
    assert.match(overlay.querySelector(".neo-gallery-story-title").textContent, /LoRA 打标/);
    await sleep(50);
    const triggerInput = overlay.querySelector(".neo-gallery-lt-trigger");
    assert.equal(triggerInput.value, "gxt", "preflight 应填入建议触发词");

    let body = null;
    mockRoute("/neo_gallery/tag_dir", (b) => {
        body = b;
        return sseResponse([
            'data: {"progress":{"phase":"standardize","converted":[],"renamed":["a.png → 001.png"]}}',
            'data: {"progress":{"index":1,"total":2,"file":"001.png","status":"ok","caption":"gxt, 1girl"}}',
            'data: {"progress":{"index":2,"total":2,"file":"002.jpg","status":"ok","caption":"gxt, 1girl, red dress"}}',
            'data: {"meta":{"status":"success","done":2,"total":2,"failed":[]}}',
            "data: [DONE]",
        ]);
    });

    const runBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "开始打标");
    click(runBtn);
    await sleep(100);

    assert.ok(body, "应调用 /neo_gallery/tag_dir");
    assert.equal(body.dir, "Input/stars/关晓彤", "传目录路径");
    assert.equal(body.trigger_word, "gxt", "传触发词");
    assert.equal(body.standardize, true, "默认勾选自动标准化");
    const result = overlay.querySelector(".neo-gallery-rp-result");
    assert.ok(result, "成功状态应显示结果文本框");
    assert.match(result.textContent, /打标完成 2\/2/);
    const prevImg = overlay.querySelector(".neo-gallery-lt-preview-img");
    assert.ok(prevImg.src.includes("filename=002.jpg"), "预览应切换到最后一张图片");
    assert.equal(overlay.querySelector(".neo-gallery-lt-preview-caption").textContent,
        "gxt, 1girl, red dress", "预览应显示最后一张的标签结果");
});

test("部分失败：弹窗显示失败张数与文件名", async () => {
    const { gallery } = makeGallery();
    const card = await makeCard(gallery, "关晓彤", "Input", ["stars", "关晓彤"], { image_count: 12 });

    mockRoute("/neo_gallery/tag_preflight", () => jsonResponse({ image_count: 12, suggested_trigger: "gxt" }));
    click(card.querySelector(".neo-gallery-card-dir-menu-btn"));
    click(itemByLabel("LoRA 打标"));
    const overlay = document.querySelector(".neo-gallery-lt-modal-overlay");
    await sleep(50);

    mockRoute("/neo_gallery/tag_dir", () => sseResponse([
        'data: {"progress":{"index":1,"total":2,"file":"001.png","status":"ok","caption":"gxt, 1girl"}}',
        'data: {"progress":{"index":2,"total":2,"file":"002.jpg","status":"error","error":"boom"}}',
        'data: {"meta":{"status":"partial","done":1,"total":2,"failed":[{"file":"002.jpg","error":"boom"}]}}',
        "data: [DONE]",
    ]));

    const runBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "开始打标");
    click(runBtn);
    await sleep(100);

    const errEl = overlay.querySelector(".neo-gallery-story-hint-error");
    assert.ok(errEl, "部分失败应显示错误状态");
    assert.match(errEl.textContent, /1 张失败/);
    assert.match(errEl.textContent, /002\.jpg/);
    const prevImg = overlay.querySelector(".neo-gallery-lt-preview-img");
    assert.ok(prevImg.src.includes("filename=002.jpg"), "预览应停在失败的图片");
    assert.match(overlay.querySelector(".neo-gallery-lt-preview-caption").textContent, /打标失败/);
});

test("打标失败：弹窗显示错误信息", async () => {
    const { gallery } = makeGallery();
    const card = await makeCard(gallery, "关晓彤", "Input", ["stars", "关晓彤"], { image_count: 12 });

    mockRoute("/neo_gallery/tag_preflight", () => jsonResponse({ image_count: 12, suggested_trigger: "gxt" }));
    click(card.querySelector(".neo-gallery-card-dir-menu-btn"));
    click(itemByLabel("LoRA 打标"));
    const overlay = document.querySelector(".neo-gallery-lt-modal-overlay");
    await sleep(50);

    mockRoute("/neo_gallery/tag_dir", () => sseResponse([
        "data: [ERROR] LLM 未配置",
        "data: [DONE]",
    ]));

    const runBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "开始打标");
    click(runBtn);
    await sleep(100);

    assert.match(overlay.querySelector(".neo-gallery-story-hint-error").textContent, /LLM 未配置/);
});

test("打标窗不遮罩：overlay 不吞点击，标题栏可拖窗口", async () => {
    const { gallery } = makeGallery();
    const card = await makeCard(gallery, "关晓彤", "Input", ["stars", "关晓彤"], { image_count: 12 });
    mockRoute("/neo_gallery/tag_preflight", () => jsonResponse({ image_count: 12, suggested_trigger: "gxt" }));
    click(card.querySelector(".neo-gallery-card-dir-menu-btn"));
    click(itemByLabel("LoRA 打标"));
    const overlay = document.querySelector(".neo-gallery-lt-modal-overlay");
    const modal = overlay.querySelector(".neo-gallery-story-modal");

    assert.equal(overlay.onclick, null, "不应整屏点击关闭（窗口外可继续浏览画廊）");
    const titlebar = modal.querySelector(".neo-gallery-story-titlebar");
    titlebar.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    assert.equal(modal.style.position, "absolute", "标题栏按下应切到绝对定位以便拖动");
});

test("打标中可中止：按钮变「中止打标」，点击后关窗", async () => {
    const { gallery } = makeGallery();
    const card = await makeCard(gallery, "关晓彤", "Input", ["stars", "关晓彤"], { image_count: 12 });
    mockRoute("/neo_gallery/tag_preflight", () => jsonResponse({ image_count: 12, suggested_trigger: "gxt" }));
    click(card.querySelector(".neo-gallery-card-dir-menu-btn"));
    click(itemByLabel("LoRA 打标"));
    const overlay = document.querySelector(".neo-gallery-lt-modal-overlay");
    await sleep(50);

    // 只挂起不结束的流：模拟打标进行中
    mockRoute("/neo_gallery/tag_dir", () => ({
        ok: true,
        status: 200,
        body: { getReader: () => ({ read: () => new Promise(() => {}), releaseLock() {} }) },
    }));

    const runBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "开始打标");
    click(runBtn);
    await sleep(50);

    const cancelBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "中止打标");
    assert.ok(cancelBtn, "打标中「取消」应变成「中止打标」");
    assert.equal(runBtn.disabled, true, "打标中禁止重复开始");
    click(cancelBtn);
    assert.equal(document.querySelector(".neo-gallery-lt-modal-overlay"), null, "中止后应关闭打标窗");
});

