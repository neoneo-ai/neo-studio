// Neo Gallery 卡片「图片反推」：弹窗展示参考图，调用 /rs_prompts/reverse_prompt 反推提示词，
// 后端把结果存成与图片同目录的 .txt。仅可写来源的图片显示该菜单项。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sseResponse, sleep, click } from "./setup.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

function itemByLabel(label) {
    return [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes(label));
}

// gallery 桩：只实现本次流程真正用到的成员（toast / 删除）
function makeGallery() {
    return {
        gallery: {
            app: { extensionManager: { toast: { add: () => {} } } },
            maxThumbnailSize: 320,
            displayLabels: true,
            deleteItem() {},
        },
    };
}

function openMenu(card, gallery, image, subfolder, source) {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, image, subfolder, source, anchor);
}

test("卡片 ⋯ 菜单：可写来源的图片显示「图片反推」", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery();
    const card = new GalleryCard(gallery);
    openMenu(card, gallery, { name: "shot", filename: "shot.png" }, "美女", "Output");
    assert.ok(itemByLabel("图片反推"), "可写来源的图片应有「图片反推」菜单项");
});

test("卡片 ⋯ 菜单：只读来源（presets）不显示「图片反推」", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery();
    const card = new GalleryCard(gallery);
    openMenu(card, gallery, { name: "shot", filename: "shot.png" }, "presets", "presets");
    assert.equal(itemByLabel("图片反推"), undefined, "只读来源不应有「图片反推」菜单项");
});

test("卡片 ⋯ 菜单：非图片文件不显示「图片反推」", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery();
    const card = new GalleryCard(gallery);
    openMenu(card, gallery, { name: "vid", filename: "vid.mp4" }, "美女", "Output");
    assert.equal(itemByLabel("图片反推"), undefined, "视频文件不应有「图片反推」菜单项");
});

test("点「图片反推」：弹窗展示参考图，点「反推」调 /rs_prompts/reverse_prompt 并显示结果", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery();
    const card = new GalleryCard(gallery);
    openMenu(card, gallery, { name: "shot", filename: "shot.png" }, "美女", "Output");
    click(itemByLabel("图片反推"));

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    assert.ok(overlay, "应弹出反推弹窗");
    assert.match(overlay.querySelector(".neo-gallery-story-title").textContent, /图片反推/);
    assert.ok(overlay.querySelector(".neo-gallery-story-ref-img"), "弹窗应有参考图预览");

    let body = null;
    mockRoute("/rs_prompts/reverse_prompt", (b) => {
        body = b;
        return sseResponse([
            'data: {"text":"一个红发","kind":"content"}',
            'data: {"text":"女孩，蓝色眼睛，站在水边。","kind":"content"}',
            'data: {"meta":{"status":"success","txt_file":"shot.txt","language":"zh"}}',
            "data: [DONE]",
        ]);
    });

    const runBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")]
        .find((b) => b.textContent === "反推");
    click(runBtn);
    await sleep(50);

    assert.ok(body, "应调用 /rs_prompts/reverse_prompt");
    assert.equal(body.filename, "shot.png", "传图片文件名");
    assert.equal(body.subfolder, "美女", "传卡片 subfolder");
    assert.equal(body.language, "zh", "默认中文");
    const result = overlay.querySelector(".neo-gallery-rp-result");
    assert.ok(result, "成功状态应显示结果文本框");
    assert.match(result.textContent, /红发女孩/);

    // 一键复制：成功态出现「复制提示词」按钮，点击后写入剪贴板
    const copied = [];
    navigator.clipboard = { writeText: async (t) => { copied.push(t); } };
    const copyBtn = overlay.querySelector(".neo-gallery-rp-copy");
    assert.ok(copyBtn, "成功状态应有「复制提示词」按钮");
    click(copyBtn);
    await sleep(50);
    assert.deepEqual(copied, ["一个红发女孩，蓝色眼睛，站在水边。"], "点击复制应把提示词写入剪贴板");
});

test("反推语言选择：默认中文，选英文后请求带 language=en", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery();
    const card = new GalleryCard(gallery);
    openMenu(card, gallery, { name: "shot", filename: "shot.png" }, "", "Output");
    click(itemByLabel("图片反推"));

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    const zhRadio = overlay.querySelector('input[name="rpLang"][value="zh"]');
    assert.ok(zhRadio && zhRadio.checked, "默认应选中中文 radio");
    const enRadio = overlay.querySelector('input[name="rpLang"][value="en"]');
    assert.ok(enRadio, "应有英文 radio 选项");
    enRadio.checked = true;

    let body = null;
    mockRoute("/rs_prompts/reverse_prompt", (b) => {
        body = b;
        return sseResponse([
            'data: {"text":"a red-haired girl","kind":"content"}',
            "data: [DONE]",
        ]);
    });

    const runBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "反推");
    click(runBtn);
    await sleep(50);

    assert.equal(body.language, "en", "选英文后 language=en");
});

test("反推失败：弹窗显示错误信息", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery();
    const card = new GalleryCard(gallery);
    openMenu(card, gallery, { name: "shot", filename: "shot.png" }, "", "Output");
    click(itemByLabel("图片反推"));

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    mockRoute("/rs_prompts/reverse_prompt", () => jsonResponse({ error: "LLM 未配置" }, 422));

    const runBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")]
        .find((b) => b.textContent === "反推");
    click(runBtn);
    await sleep(50);

    assert.match(overlay.querySelector(".neo-gallery-story-hint-error").textContent, /LLM 未配置/);
});
