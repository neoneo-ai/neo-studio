// 预设提示词选择浮层（js/core/preset-picker.js）：作用域过滤（图像 / 视频）、点一条填框、
// Esc 只关浮层不关面板、「随机」按作用域发请求 —— 全在 jsdom 里验，接口走 fetch mock。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, click, mockRoute, jsonResponse, fetchLog, keydown, flush } from "./setup.mjs";

const { openPresetPicker, closePresetPicker, isVideoPromptName, randomPromptText } =
    await import("../../web/js/core/preset-picker.js");

const ITEMS = [
    { name: "红杯", source: "presets" },
    { name: "精美图像提示词/古风女孩", source: "custom" },
    { name: "video/镜头推进", source: "presets" },
    { name: "video/子目录/雨夜窗边", source: "custom" },
    { name: "整片配方", source: "presets", isRecipe: true },
];

/** 列表与读取两条接口：读取按名字回一句可辨认的文本，好在断言里认出填进框的是哪一条 */
function mockPromptRoutes() {
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse(ITEMS));
    mockRoute("/rs_prompts/load_prompt", (body) => jsonResponse({ text: `全文:${body.name}` }));
}

const rows = () => [...document.querySelectorAll(".neo-preset-picker .rs-preset-item .rs-preset-content")].map((e) => e.textContent);
const picker = () => document.querySelector(".neo-preset-picker");

test("预设归属：扫描名首段是 video 才归视频", () => {
    assert.equal(isVideoPromptName("video/镜头推进"), true);
    assert.equal(isVideoPromptName("video/子目录/雨夜窗边"), true);
    assert.equal(isVideoPromptName("红杯"), false);
    assert.equal(isVideoPromptName("collections/video/一批镜头"), false, "collections 前缀落在图像一侧，与后端口径同一份");
});

test("预设浮层：kind=image 只列图像条目，配方不入池，点一条把全文交回调用方", async () => {
    resetEnv();
    mockPromptRoutes();
    const picked = [];
    openPresetPicker({ kind: "image", onPick: (text) => picked.push(text) });
    await flush();
    assert.deepEqual(rows(), ["红杯", "精美图像提示词/古风女孩"], "视频条目与配方都不在图像浮层里");
    click(document.querySelectorAll(".neo-preset-picker .rs-preset-item")[1]);
    await flush();
    assert.deepEqual(picked, ["全文:精美图像提示词/古风女孩"], "点中那一条的全文交回调用方");
    assert.equal(picker(), null, "选完就收摊，浮层不留在页面上");
});

test("预设浮层：kind=video 只列 video/ 条目", async () => {
    resetEnv();
    mockPromptRoutes();
    openPresetPicker({ kind: "video", onPick: () => {} });
    await flush();
    assert.deepEqual(rows(), ["video/镜头推进", "video/子目录/雨夜窗边"]);
    closePresetPicker();
    assert.equal(picker(), null, "closePresetPicker 拆掉浮层");
});

test("预设浮层：搜索框按名字过滤，空结果显示空态", async () => {
    resetEnv();
    mockPromptRoutes();
    openPresetPicker({ kind: "image", onPick: () => {} });
    await flush();
    const search = picker().querySelector(".rs-preset-search-input");
    search.value = "古风";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.deepEqual(rows(), ["精美图像提示词/古风女孩"]);
    search.value = "没有这个词";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(picker().querySelector(".neo-preset-picker-empty").textContent, "无匹配预设");
    closePresetPicker();
});

// 面板自己的「Esc 关窗」监听也在 document 上：浮层开着时这一发只该关浮层
test("预设浮层：Esc 只关浮层，调用方面板不被一起关掉", async () => {
    resetEnv();
    mockPromptRoutes();
    let panelEsc = 0;
    const onPanelEsc = (e) => { if (e.key === "Escape") panelEsc++; };
    document.addEventListener("keydown", onPanelEsc);
    openPresetPicker({ kind: "image", onPick: () => {} });
    await flush();
    keydown(document, "Escape");
    await flush();
    assert.equal(picker(), null, "浮层收下这一发 Esc");
    assert.equal(panelEsc, 0, "面板的「Esc 关窗」没被带着跑");
    document.removeEventListener("keydown", onPanelEsc);
});

test("预设浮层：遮罩空白与 × 都关窗", async () => {
    resetEnv();
    mockPromptRoutes();
    openPresetPicker({ kind: "image", onPick: () => {} });
    await flush();
    picker().dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.equal(picker(), null, "点遮罩空白关窗");
    openPresetPicker({ kind: "image", onPick: () => {} });
    await flush();
    click(picker().querySelector(".rs-preset-close"));
    assert.equal(picker(), null, "× 关窗");
});

test("预设浮层：列表读不到就说清楚，不留一扇空窗", async () => {
    resetEnv();
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse({ status: "error", error: "数据根不可用" }));
    openPresetPicker({ kind: "video", onPick: () => {} });
    await flush();
    assert.equal(picker().querySelector(".neo-preset-picker-empty").textContent, "暂无可用提示词");
    closePresetPicker();
});

test("随机一条：kind 发进接口，抽到的文本原样交回", async () => {
    resetEnv();
    mockRoute("/rs_prompts/random_prompts", () => jsonResponse({ texts: ["镜头缓缓推进"] }));
    const text = await randomPromptText("video");
    assert.equal(text, "镜头缓缓推进");
    const call = fetchLog.find((c) => c.path === "/rs_prompts/random_prompts");
    assert.equal(call.body.kind, "video", "作用域跟着请求出去，后端照它筛池子");
});

test("随机一条：池子为空交回空串，由调用方把「词库为空」说给用户", async () => {
    resetEnv();
    mockRoute("/rs_prompts/random_prompts", () => jsonResponse({ texts: [] }));
    assert.equal(await randomPromptText("image"), "");
});

test("预设浮层挂在 body 上、展开，层位压得住生成素材窗", async () => {
    resetEnv();
    mockPromptRoutes();
    openPresetPicker({ kind: "image", onPick: () => {} });
    await flush();
    const overlay = picker();
    assert.equal(overlay.parentElement, document.body, "浮层自挂在 body 上，不依赖页面结构");
    // prompts.css 的 .rs-preset-list-overlay 骨架自带 display:none（提示词管理页自己管显隐）：
    // 浮层不自己展开就是「点了没窗口」；层位要压得住生成素材 / 图片编辑那两层浮窗（9845）
    assert.equal(overlay.style.display, "flex", "骨架的 display:none 由浮层自己展开");
    assert.equal(Number(overlay.style.zIndex) > 9845, true, "浮层层位高于生成类浮窗");
    closePresetPicker();
});

// 旧版调用方与 NeoPromptAgent 节点不传作用域：空 kind = 混池语义由后端守着，这里验请求形状
test("运行时随机不传 kind：请求体里 kind 是空串，混池语义留给后端", async () => {
    resetEnv();
    const { randomPrompts } = await import("../../web/prompt-service.js");
    mockRoute("/rs_prompts/random_prompts", () => jsonResponse({ texts: ["混池一条"] }));
    const res = await randomPrompts(1);
    assert.deepEqual(res.texts, ["混池一条"]);
    assert.equal(fetchLog.find((c) => c.path === "/rs_prompts/random_prompts").body.kind, "");
});
