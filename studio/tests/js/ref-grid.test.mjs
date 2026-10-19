// L1：NeoRefGrid 参考图宫格节点前端测试：autogrow 目标数、宫格增删/上限/重排、
// refs 隐藏 widget 同步、拖放搬运（画廊 /neo_gallery/copy_to_input、本地 /upload/image）、
// _neoRg API、配方收集/还原集成（纯宫格子图）。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, fetchLog, jsonResponse, flush, makeFile } from "./setup.mjs";
import * as g from "./helpers/fake-graph.mjs";
import { appState, getExtension } from "./mocks/comfy-app.mjs";

// 插件模块必须在 setup.mjs（安装 app.js shim hooks）求值后动态 import，否则 app.js 解析不到 mock。
const rg = await import("../../web/ref-grid.js");
const recipes = await import("../../web/recipes.js");

function createGridNode() {
    const ext = getExtension("NeoRefGrid.Grid");
    assert.ok(ext, "NeoRefGrid.Grid 扩展未注册");
    const nodeType = class {};
    ext.beforeRegisterNodeDef(nodeType, { name: "NeoRefGrid" });
    const base = g.makeNode({
        type: "NeoRefGrid",
        widgets: [g.makeWidget("refs", ""), g.makeWidget("prompt_text", "")],
        outputs: [g.outSlot("prompt"), g.outSlot("BUNDLE"), g.outSlot("image_1", "IMAGE")],
    });
    const node = Object.assign(Object.create(nodeType.prototype), base);
    node.addOutput = (name, type) => { node.outputs.push(g.outSlot(name, type)); };
    node.removeOutput = (i) => { node.outputs.splice(i, 1); };
    node.onNodeCreated();
    return node;
}

function viewEl(node) {
    const w = node.widgets.find((x) => x.name === "ref_grid_view");
    assert.ok(w?.el, "宫格 DOM widget 未创建");
    return w.el;
}

// ---- autogrow 目标数（槽 0 prompt、槽 1 BUNDLE、槽 2..13 image_1..12）----

function outputs(connectedImageIndices) {
    return Array.from({ length: 14 }, (_, i) => ({
        name: i < 2 ? (i === 0 ? "prompt" : "BUNDLE") : `image_${i - 1}`,
        links: connectedImageIndices.includes(i) ? [1] : [],
    }));
}

test("autogrow：默认显示 prompt/BUNDLE/image_1 三个槽", () => {
    resetEnv();
    assert.equal(rg.computeAutogrowTarget(outputs([])), 3);
});

test("autogrow：连接 image_2 后露出到 image_3", () => {
    resetEnv();
    assert.equal(rg.computeAutogrowTarget(outputs([3])), 5);
});

test("autogrow：image_12 已连接时封顶在全部 14 个输出", () => {
    resetEnv();
    assert.equal(rg.computeAutogrowTarget(outputs([13])), 14);
});

// ---- 宫格 UI 与 refs widget 同步 ----

test("节点创建：宫格 UI + setAssets 同步 refs widget", () => {
    resetEnv(); appState.toasts.length = 0;
    const node = createGridNode();
    assert.ok(node._neoRg, "_neoRg API 未挂载");
    const el = viewEl(node);
    assert.equal(el.querySelectorAll(".neo-rg-cell").length, 9);
    assert.equal(el.querySelectorAll(".neo-rg-thumb").length, 0);

    node._neoRg.setAssets(["a.png", "b.png"]);
    assert.deepEqual(node._neoRg.getAssets(), ["a.png", "b.png"]);
    const refsW = node.widgets.find((w) => w.name === "refs");
    assert.equal(refsW.value, JSON.stringify(["a.png", "b.png"]));
    assert.equal(el.querySelector(".neo-rg-count").textContent, "2/9");
    assert.equal(el.querySelectorAll(".neo-rg-thumb").length, 2);
});

test("上限：setAssets 只保留前 12 张", () => {
    resetEnv(); appState.toasts.length = 0;
    const node = createGridNode();
    const names = Array.from({ length: 15 }, (_, i) => `f${i}.png`);
    node._neoRg.setAssets(names);
    assert.equal(node._neoRg.getAssets().length, 12);
    assert.deepEqual(node._neoRg.getAssets(), names.slice(0, 12));
});

test("提示词：setPrompt/getPrompt 同步 prompt_text widget", () => {
    resetEnv(); appState.toasts.length = 0;
    const node = createGridNode();
    node._neoRg.setPrompt("一只猫");
    assert.equal(node.widgets.find((w) => w.name === "prompt_text").value, "一只猫");
    assert.equal(node._neoRg.getPrompt(), "一只猫");
});

// ---- 拖放搬运 ----

test("画廊素材拖入：/neo_gallery/copy_to_input 落盘后入格", async () => {
    resetEnv(); appState.toasts.length = 0;
    mockRoute("/neo_gallery/copy_to_input", jsonResponse({ success: true, filename: "g1.png" }));
    const node = createGridNode();
    const gridEl = viewEl(node).querySelector(".neo-rg-grid");
    const evt = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "dataTransfer", {
        value: {
            files: [],
            getData: (t) => (t === "application/x-neo-gallery" ? JSON.stringify({ filename: "gallery_src.png" }) : ""),
        },
        configurable: true,
    });
    gridEl.dispatchEvent(evt);
    await flush();
    assert.deepEqual(node._neoRg.getAssets(), ["g1.png"]);
    const call = fetchLog.find((c) => c.path === "/neo_gallery/copy_to_input");
    assert.equal(call?.query.get("filename"), "gallery_src.png");
});

test("本地文件拖入：/upload/image 批量上传后入格", async () => {
    resetEnv(); appState.toasts.length = 0;
    mockRoute("/upload/image", jsonResponse({ name: "up1.png" }));
    const node = createGridNode();
    const gridEl = viewEl(node).querySelector(".neo-rg-grid");
    const evt = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "dataTransfer", {
        value: { files: [makeFile("local.png")], getData: () => "" },
        configurable: true,
    });
    gridEl.dispatchEvent(evt);
    await flush();
    assert.deepEqual(node._neoRg.getAssets(), ["up1.png"]);
    const call = fetchLog.find((c) => c.path === "/upload/image");
    assert.equal(call?.method, "POST");
});

test("上限：满 12 张后再拖入被拒绝并提示", async () => {
    resetEnv(); appState.toasts.length = 0;
    mockRoute("/neo_gallery/copy_to_input", jsonResponse({ success: true, filename: "g2.png" }));
    const node = createGridNode();
    node._neoRg.setAssets(Array.from({ length: 12 }, (_, i) => `f${i}.png`));
    const gridEl = viewEl(node).querySelector(".neo-rg-grid");
    const evt = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "dataTransfer", {
        value: {
            files: [],
            getData: (t) => (t === "application/x-neo-gallery" ? JSON.stringify({ filename: "x.png" }) : ""),
        },
        configurable: true,
    });
    gridEl.dispatchEvent(evt);
    await flush();
    assert.equal(node._neoRg.getAssets().length, 12);
    assert.ok(appState.toasts.some((t) => t.detail.includes("最多 12")), "应弹出上限提示");
});

test("槽位数：工具条 −/+ 在 1~12 间调整，图更多时自动扩", () => {
    resetEnv(); appState.toasts.length = 0;
    const node = createGridNode();
    const el = viewEl(node);
    const btns = el.querySelectorAll(".neo-rg-btn");
    const byTitle = t => Array.from(btns).find(b => b.title.startsWith(t));
    const minus = byTitle("减少宫格数"), plus = byTitle("增加宫格数");
    assert.equal(el.querySelectorAll(".neo-rg-cell").length, 9);   // 默认 9 槽
    for (let i = 0; i < 3; i++) plus.click();
    assert.equal(el.querySelectorAll(".neo-rg-cell").length, 12);
    assert.ok(plus.disabled, "到上限 12 后 + 禁用");
    minus.click();
    assert.equal(el.querySelectorAll(".neo-rg-cell").length, 11);
    for (let i = 0; i < 10; i++) minus.click();   // 11 → 1
    assert.equal(el.querySelectorAll(".neo-rg-cell").length, 1);
    assert.ok(minus.disabled, "到下限 1 后 − 禁用");
    // 槽位缩到 1 后再填入 3 张图 → 自动扩到 3
    node._neoRg.setAssets(["a.png", "b.png", "c.png"]);
    assert.equal(el.querySelectorAll(".neo-rg-cell").length, 3);
});

test("瓷砖拖放重排：refs widget 顺序同步", async () => {
    resetEnv(); appState.toasts.length = 0;
    const node = createGridNode();
    node._neoRg.setAssets(["a.png", "b.png", "c.png"]);
    const el = viewEl(node);
    const cells = el.querySelectorAll(".neo-rg-cell");
    const ds = new window.Event("dragstart", { bubbles: true });
    Object.defineProperty(ds, "dataTransfer", { value: { effectAllowed: "", setData() {} }, configurable: true });
    cells[0].dispatchEvent(ds);   // 拖起第 1 张（a）
    const drop = new window.Event("drop", { bubbles: true, cancelable: true });
    drop.clientX = 100;   // 默认矩形 center=60，越过所有格中线 → 落到末尾
    Object.defineProperty(drop, "dataTransfer", { value: { files: [], getData: () => "" }, configurable: true });
    el.querySelector(".neo-rg-grid").dispatchEvent(drop);   // clientX 越过全部格中线 → 落到末尾
    await flush();
    assert.deepEqual(node._neoRg.getAssets(), ["b.png", "c.png", "a.png"]);
});

// ---- 配方集成 ----

test("配方收集：宫格图作为主图片资产排在最前", async () => {
    resetEnv(); appState.toasts.length = 0;
    const node = createGridNode();
    node._neoRg.setAssets(["a.png", "b.png"]);
    const graph = g.makeGraph();
    graph.add(node);
    appState.graph = graph;
    const assets = await recipes.collectWorkflowAssets(node);
    assert.deepEqual(assets, [
        { filename: "a.png", subfolder: "", type: "input", kind: "image" },
        { filename: "b.png", subfolder: "", type: "input", kind: "image" },
    ]);
});

test("配方收集：无宫格节点时行为不变（不产资产）", async () => {
    resetEnv(); appState.toasts.length = 0;
    const node = g.makeNode({ type: "LoadImage" });
    const graph = g.makeGraph();
    graph.add(node);
    appState.graph = graph;
    const assets = await recipes.collectWorkflowAssets(node);
    assert.deepEqual(assets, []);
});

test("配方还原：纯宫格子图先填宫格 + 提示词兜底写入", async () => {
    resetEnv(); appState.toasts.length = 0;
    mockRoute("/rs_recipes/send_to_workflow", jsonResponse({
        success: true,
        assets: [{ kind: "image", file: "r1.png" }, { kind: "image", file: "r2.png" }],
    }));
    const node = createGridNode();
    const graph = g.makeGraph();
    graph.add(node);
    appState.graph = graph;
    const ok = await recipes.applyRecipeToWorkflow({ name: "t", prompt: "P" });
    assert.equal(ok, true);
    assert.deepEqual(node._neoRg.getAssets(), ["r1.png", "r2.png"]);
    assert.equal(node._neoRg.getPrompt(), "P");
});

test("工具条：图标与顺序（清空/保存紧随 +，素材组在右且用 PrimeIcons）", async () => {
    resetEnv(); appState.toasts.length = 0;
    const node = createGridNode();
    const btns = Array.from(viewEl(node).querySelectorAll(".neo-rg-toolbar .neo-rg-btn"));
    const byTitle = t => btns.find(b => b.title.startsWith(t));
    // 顺序：− + 清空 保存 | 素材面板 本地添加 加载配方（计数在 −/+ 之间、非按钮）
    assert.equal(btns[0].title, "减少宫格数（最少 1）");
    assert.ok(btns[1].title.startsWith("增加宫格数"));
    assert.ok(byTitle("清空宫格").querySelector("svg path"), "清空宫格应是 core/icons.js 的垃圾桶图标");
    const save = byTitle("保存配方");
    assert.ok(save.querySelector("i.pi-save"), "保存配方应为 pi-save 图标");
    const gallery = byTitle("打开素材面板");
    assert.ok(gallery.classList.contains("neo-rg-right"), "素材组首个按钮应带右推类");
    assert.ok(gallery.querySelector("i.pi-images"), "素材面板应与 Neo Gallery 一致用 pi-images 图标");
    const load = byTitle("加载配方");
    assert.ok(load.querySelector("i.pi-list"), "加载配方应为 pi-list 图标");
    // 清空与保存位于「增加宫格数」按钮右侧
    const plusIdx = btns.indexOf(byTitle("增加宫格数"));
    assert.equal(btns[plusIdx + 1], byTitle("清空宫格"));
    assert.equal(btns[plusIdx + 2], save);
});

// ---- 加载配方选择窗 ----

function mockRecipeList() {
    mockRoute("/rs_recipes/list", jsonResponse([
        {
            name: "img3", source: "custom", prompt: "三只猫", mtime: 3, asset_count: 4, cover: "c1.png",
            assets: [
                { file: "c1.png", kind: "image" }, { file: "c2.png", kind: "image" },
                { file: "c3.png", kind: "image" }, { file: "v.mp4", kind: "video" },
            ],
        },
        {
            name: "director1", source: "custom", prompt: "", mtime: 2, asset_count: 2, cover: "d1.png",
            type: "video_director",
            assets: [{ file: "d1.png", kind: "image" }, { file: "d2.png", kind: "image" }],
        },
        { name: "textonly", source: "preset", prompt: "无图配方", mtime: 1, asset_count: 0, cover: null, assets: [] },
    ]));
}

function openPicker(node) {
    const btn = viewEl(node).querySelector('button[title="加载配方（提示词 + 图片入宫格）"]');
    assert.ok(btn, "工具条缺少「加载配方」按钮");
    btn.click();
}

test("加载配方：选择窗只列普通含图配方（排除多段导演与无图配方）", async () => {
    resetEnv(); appState.toasts.length = 0;
    mockRecipeList();
    const node = createGridNode();
    openPicker(node);
    await flush();
    const overlay = document.querySelector(".neo-rg-overlay");
    assert.ok(overlay, "选择窗未弹出");
    const rows = overlay.querySelectorAll(".neo-rg-picker-row");
    assert.equal(rows.length, 1, "应只列出 img3 一条");
    assert.equal(rows[0].querySelector(".neo-rg-picker-name").textContent, "img3");
    assert.ok(rows[0].querySelector(".neo-rg-picker-sub").textContent.includes("图片×3"));
    // 预览区随首行聚焦渲染：封面 + 3 张图片条
    assert.ok(overlay.querySelector(".neo-rg-picker-cover"), "预览封面缺失");
    assert.equal(overlay.querySelectorAll(".neo-rg-picker-strip img").length, 3);
});

test("加载配方：点击行载入图片与提示词并关窗", async () => {
    resetEnv(); appState.toasts.length = 0;
    mockRecipeList();
    const node = createGridNode();
    node._neoRg.setAssets(["old.png"]);
    openPicker(node);
    await flush();
    document.querySelector(".neo-rg-picker-row").click();
    await flush();
    assert.deepEqual(node._neoRg.getAssets(), ["c1.png", "c2.png", "c3.png"], "视频资产不入宫格");
    assert.equal(node._neoRg.getPrompt(), "三只猫");
    assert.equal(document.querySelector(".neo-rg-overlay"), null, "载入后选择窗应关闭");
    const t = appState.toasts.at(-1);
    assert.ok(t.detail.includes("img3") && t.detail.includes("非图片资产未载入"), `提示不符：${t?.detail}`);
});

test("加载配方：搜索过滤与无匹配提示", async () => {
    resetEnv(); appState.toasts.length = 0;
    mockRecipeList();
    const node = createGridNode();
    openPicker(node);
    await flush();
    const search = document.querySelector(".neo-rg-picker-search");
    search.value = "img";
    search.dispatchEvent(new window.Event("input"));
    assert.equal(document.querySelectorAll(".neo-rg-picker-row").length, 1);
    search.value = "不存在";
    search.dispatchEvent(new window.Event("input"));
    assert.equal(document.querySelectorAll(".neo-rg-picker-row").length, 0);
    assert.ok(document.querySelector(".neo-rg-picker-list .neo-rg-picker-empty").textContent.includes("无匹配配方"));
});

test("加载配方：图片超过 12 张时只载入前 12 并提示", async () => {
    resetEnv(); appState.toasts.length = 0;
    const files = Array.from({ length: 15 }, (_, i) => ({ file: `m${i}.png`, kind: "image" }));
    mockRoute("/rs_recipes/list", jsonResponse([
        { name: "many", source: "custom", prompt: "", mtime: 1, asset_count: files.length, cover: "m0.png", assets: files },
    ]));
    const node = createGridNode();
    openPicker(node);
    await flush();
    document.querySelector(".neo-rg-picker-row").click();
    await flush();
    assert.equal(node._neoRg.getAssets().length, 12);
    assert.deepEqual(node._neoRg.getAssets(), files.slice(0, 12).map(f => f.file));
    assert.ok(appState.toasts.at(-1).detail.includes("仅载入前 12 张"));
});