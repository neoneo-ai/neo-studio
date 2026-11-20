// Neo Gallery 灯箱提示词侧栏：分节标签独占一行、长句按逗号断行、负面词清单拆成 chip。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, jsonResponse, flush, fetchLog, click } from "./setup.mjs";

const NEGATIVE = "二次元，插画，漫画，卡通，CG，数字人，仿真人，塑料感，假皮肤，磨皮过度，油光满面，面部变形";
const PREVIEW = "画面中间区域：正视图面部特写(完整呈现五官轮廓、眼瞳细节、睫毛纹理)。";
const FULL = PREVIEW
    + "画面右侧区域:横向排列两幅超高清细节影视级面部特写肖像，与左侧上排全身视图精准对齐，严格遵循固定顺序。"
    + "负面提示词：" + NEGATIVE;
const LABELS = ["画面中间区域：", "画面右侧区域：", "负面提示词："];

async function openPanel({ fullText = FULL } = {}) {
    resetEnv();
    clearRoutes();
    if (fullText !== null) mockRoute("/neo_gallery/txt", () => jsonResponse({ success: true, content: fullText }));
    mockRoute("/neo_gallery/media_meta", () => jsonResponse({ has: false }));
    const { NeoGallery } = await import("../../web/gallery.js");
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const gallery = new NeoGallery({ extensionManager: { toast: { add: () => {} } } });
    const card = new GalleryCard(gallery);
    const copied = [];
    card.copyToClipboard = (_name, text) => { copied.push(text); };
    const inner = card._lightboxPromptPanel(gallery, { name: "095_叛宗剑修", filename: "095.jpg", txt_content: PREVIEW }, "仙侠玄幻人物");
    document.body.appendChild(inner);
    await flush();
    return { card, gallery, inner, copied };
}

const texts = (sel) => [...document.querySelectorAll(sel)].map((el) => el.textContent);

test("分节标签独占一行，半角冒号的标签也识别", async () => {
    await openPanel();
    assert.deepEqual(texts(".neo-lightbox-panel-label"), LABELS);
});

test("长句按逗号断行，短句保持一行", async () => {
    await openPanel();
    const items = [...document.querySelectorAll(".neo-lightbox-panel-item")];
    assert.equal(items.length, LABELS.length);
    assert.deepEqual(
        [...items[0].querySelectorAll(".neo-lightbox-panel-line")].map((el) => el.textContent),
        ["正视图面部特写(完整呈现五官轮廓、眼瞳细节、睫毛纹理)"],
        "短句不应被拆碎");
    assert.deepEqual(
        [...items[1].querySelectorAll(".neo-lightbox-panel-line")].map((el) => el.textContent),
        ["横向排列两幅超高清细节影视级面部特写肖像", "与左侧上排全身视图精准对齐", "严格遵循固定顺序"]);
});

test("负面词清单拆成 chip，不再是一整段逗号墙", async () => {
    await openPanel();
    const tags = [...document.querySelectorAll(".neo-lightbox-panel-tag")];
    assert.deepEqual(tags.map((el) => el.textContent), NEGATIVE.split("，"));
    assert.equal(document.querySelectorAll(".neo-lightbox-panel-item")[2]
        .querySelector(".neo-lightbox-panel-line"), null, "chip 段不再重复渲染整行正文");
});

test("复制提示词取全文原文，排版不改复制内容", async () => {
    const { copied } = await openPanel();
    click(document.querySelector(".neo-lightbox-panel-btn"));
    assert.deepEqual(copied, [FULL]);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_gallery/txt").length, 1, "全文只取一次");
});

test("全文取不到时保留预览渲染，面板不空", async () => {
    await openPanel({ fullText: null });
    assert.deepEqual(texts(".neo-lightbox-panel-label"), ["画面中间区域："]);
    assert.equal(texts(".neo-lightbox-panel-line").length, 1);
});

const WORKFLOW = { "1": { class_type: "SaveVideo", inputs: { filename_prefix: "AnimateDiff_00011" } } };

/** 无同名 .txt 的视频卡：侧栏全靠 /neo_gallery/media_meta 的内嵌元数据 */
async function embeddedPanel(meta) {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_gallery/media_meta", () => jsonResponse(meta));
    const { NeoGallery } = await import("../../web/gallery.js");
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const gallery = new NeoGallery({ extensionManager: { toast: { add: () => {} } } });
    const card = new GalleryCard(gallery);
    const inner = await card._buildLightboxPanel(gallery, {
        raw: { name: "video_00001_.mp4", filename: "video_00001_.mp4" },
        subfolder: "NeoSimple",
    });
    if (inner) document.body.appendChild(inner);
    await flush();
    return inner;
}

test("内嵌元数据解出提示词：正向分节 + 导入工作流按钮", async () => {
    const inner = await embeddedPanel({
        has: true, workflow: WORKFLOW, prompt: null,
        texts: { positive: ["雨夜街角的女孩回头"], negative: [], params: { seed: 12345 } },
    });
    assert.notEqual(inner, null);
    assert.deepEqual(texts(".neo-lightbox-panel-label"), ["正向："]);
    assert.deepEqual(texts(".neo-lightbox-panel-line"), ["雨夜街角的女孩回头"]);
    assert.deepEqual(texts(".neo-lightbox-panel-btn"), ["导入工作流"]);
});

test("内嵌元数据解不出提示词：空正文那一盒不出现，导入工作流照留", async () => {
    const inner = await embeddedPanel({
        has: true, workflow: WORKFLOW, prompt: null,
        texts: { positive: [], negative: [], params: {} },
    });
    assert.notEqual(inner, null);
    assert.equal(inner.querySelector(".neo-lightbox-panel-body"), null, "没有正文就不铺那一盒");
    assert.deepEqual(texts(".neo-lightbox-panel-btn"), ["导入工作流"]);
});

test("内嵌元数据既无提示词又无工作流：侧栏整块不出现", async () => {
    const inner = await embeddedPanel({
        has: true, workflow: null, prompt: null,
        texts: { positive: [], negative: [], params: {} },
    });
    assert.equal(inner, null);
});
