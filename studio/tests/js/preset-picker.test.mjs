// 提示词选择浮层（js/core/preset-picker.js）：作用域过滤（图像 / 视频）、点一条填框、
// Esc 只关浮层不关面板、「随机」按作用域发请求 —— 全在 jsdom 里验，接口走 fetch mock。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, click, mockRoute, jsonResponse, fetchLog, keydown, flush } from "./setup.mjs";

const { openPresetPicker, closePresetPicker, isVideoPromptName, promptDisplayName, randomPromptText, savePromptTo } =
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
const rowKeys = () => [...document.querySelectorAll(".neo-preset-picker .rs-preset-item")].map((e) => e.dataset.name);
const picker = () => document.querySelector(".neo-preset-picker");

test("提示词归属：扫描名首段是 video 才归视频", () => {
    assert.equal(isVideoPromptName("video/镜头推进"), true);
    assert.equal(isVideoPromptName("video/子目录/雨夜窗边"), true);
    assert.equal(isVideoPromptName("红杯"), false);
    assert.equal(isVideoPromptName("collections/video/一批镜头"), false, "collections 前缀落在图像一侧，与后端口径同一份");
});

// 浮层与列表已经按池子分了，行上的名字不需要再写一遍池子前缀
test("显示名：只去 video/ 池子段，子目录与 collections 段留着", () => {
    assert.equal(promptDisplayName("video/镜头推进"), "镜头推进");
    assert.equal(promptDisplayName("video/子目录/雨夜窗边"), "子目录/雨夜窗边");
    assert.equal(promptDisplayName("红杯"), "红杯");
    assert.equal(promptDisplayName("精美图像提示词/古风女孩"), "精美图像提示词/古风女孩", "图像池的子目录段是位置，不是池子标记");
    assert.equal(promptDisplayName("collections/portraits-1"), "collections/portraits-1", "集合前缀标的是多行集合，留着");
});

test("提示词浮层：kind=image 只列图像条目，配方不入池，点一条把全文交回调用方", async () => {
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

test("提示词浮层：kind=video 只列视频池条目，行上不带 video/ 前缀，点一条按扫描名全名读正文", async () => {
    resetEnv();
    mockPromptRoutes();
    const picked = [];
    openPresetPicker({ kind: "video", onPick: (text) => picked.push(text) });
    await flush();
    assert.deepEqual(rows(), ["镜头推进", "子目录/雨夜窗边"], "行上只去池子前缀，子目录段留着");
    assert.deepEqual(rowKeys(), ["video/镜头推进", "video/子目录/雨夜窗边"], "键留扫描名全名，池子与标签索引认的是它");
    const search = picker().querySelector(".rs-preset-search-input");
    search.value = "雨夜";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.deepEqual(rows(), ["子目录/雨夜窗边"], "搜索框打的就是行上那串名字");
    click(document.querySelectorAll(".neo-preset-picker .rs-preset-item")[0]);
    await flush();
    assert.deepEqual(picked, ["全文:video/子目录/雨夜窗边"], "行上打的是裸名字，读正文发出去的是扫描名全名");
    closePresetPicker();
    assert.equal(picker(), null, "closePresetPicker 拆掉浮层");
});

test("提示词浮层：搜索框按名字过滤，空结果显示空态", async () => {
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
    assert.equal(picker().querySelector(".neo-preset-picker-empty").textContent, "无匹配提示词");
    closePresetPicker();
});

// 面板自己的「Esc 关窗」监听也在 document 上：浮层开着时这一发只该关浮层
test("提示词浮层：Esc 只关浮层，调用方面板不被一起关掉", async () => {
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

test("提示词浮层：遮罩空白与 × 都关窗", async () => {
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

// 桌面端离线时 list_prompts 归内核，回来的是 409 的 {offline:true}：空态要点明是要 ComfyUI 在跑
test("提示词浮层：桌面端离线说清楚是要 ComfyUI 在跑，不报词库为空", async () => {
    resetEnv();
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse({ success: false, offline: true, error: "需要 ComfyUI" }, 409));
    openPresetPicker({ kind: "image", onPick: () => {} });
    await flush();
    assert.equal(picker().querySelector(".neo-preset-picker-empty").textContent, "提示词列表需要 ComfyUI 运行");
    closePresetPicker();
});

test("提示词浮层：词库真空与读取失败分开讲，不留一扇空窗", async () => {
    resetEnv();
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse([]));
    openPresetPicker({ kind: "video", onPick: () => {} });
    await flush();
    assert.equal(picker().querySelector(".neo-preset-picker-empty").textContent, "暂无可用提示词", "词库真空才说没有提示词");
    closePresetPicker();
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse({ status: "error", error: "数据根不可用" }));
    openPresetPicker({ kind: "video", onPick: () => {} });
    await flush();
    assert.equal(picker().querySelector(".neo-preset-picker-empty").textContent, "提示词列表读取失败", "后端报错不能被一句「暂无可用提示词」盖过去");
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

test("随机一条：桌面端离线抛「需要 ComfyUI 运行」，调用方不会报词库为空", async () => {
    resetEnv();
    mockRoute("/rs_prompts/random_prompts", () => jsonResponse({ success: false, offline: true, error: "需要 ComfyUI" }, 409));
    await assert.rejects(() => randomPromptText("video"), (e) => e.message === "提示词与随机需要 ComfyUI 运行");
});

test("提示词浮层挂在 body 上、展开，层位压得住生成素材窗", async () => {
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

// 存当前提示词：池子由 kind 定，返回的名字就是提示词管理页与读侧那条扫描名
test("存当前提示词：图像池发裸名字，视频池发 video/ 前缀", async () => {
    resetEnv();
    mockRoute("/rs_prompts/save_prompt", (body) => jsonResponse({ status: "success", name: body.name }));
    assert.equal(await savePromptTo("image", "红杯 特写", "一张红杯"), "红杯 特写");
    assert.equal(await savePromptTo("video", "镜头推进", "镜头缓缓推进"), "video/镜头推进");
    assert.deepEqual(
        fetchLog.filter((c) => c.path === "/rs_prompts/save_prompt").map((c) => c.body.name),
        ["红杯 特写", "video/镜头推进"],
        "视频那一发的名字带前缀，后端才落得进 custom/video/");
});

test("存当前提示词：用户打头的前缀先剥掉，池子只由 kind 定", async () => {
    resetEnv();
    mockRoute("/rs_prompts/save_prompt", (body) => jsonResponse({ status: "success", name: body.name }));
    assert.equal(await savePromptTo("image", "video/镜头推进", "x"), "镜头推进", "在图像面板存就落图像池");
    assert.equal(await savePromptTo("video", "presets/旧名", "x"), "video/旧名", "视频面板不往出厂预设里写");
});

test("存当前提示词：名字按后端同一套清洗，清洗完为空就不发请求", async () => {
    resetEnv();
    mockRoute("/rs_prompts/save_prompt", (body) => jsonResponse({ status: "success", name: body.name }));
    assert.equal(await savePromptTo("image", "  带非法字符<>/\\ 的名字  ", "x"), "带非法字符 的名字",
        "空格与下划线留着可用，尖括号与斜杠这类会被后端拒的字符先清掉");
    await assert.rejects(() => savePromptTo("video", "///", "x"), (e) => e.message === "要先给这条提示词起个名字");
    assert.equal(fetchLog.filter((c) => c.path === "/rs_prompts/save_prompt" && c.body.name === "video/").length, 0,
        "名字不合法不该把空名字发出去");
});

test("存当前提示词：桌面端离线那一发说清楚是要 ComfyUI 在跑", async () => {
    resetEnv();
    mockRoute("/rs_prompts/save_prompt", () => jsonResponse({ success: false, offline: true, error: "需要 ComfyUI" }, 409));
    await assert.rejects(() => savePromptTo("image", "红杯", "x"), (e) => e.message === "保存提示词需要 ComfyUI 运行");
});

test("存当前提示词：后端报错不算保存成功", async () => {
    resetEnv();
    mockRoute("/rs_prompts/save_prompt", () => jsonResponse({ status: "error", error: "数据根不可用" }, 500));
    await assert.rejects(() => savePromptTo("video", "镜头", "x"), (e) => e.message === "提示词保存失败");
});

