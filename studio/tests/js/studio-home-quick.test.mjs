// 悬浮快速入口：鼠标落在顶栏「首页」那一格上（当前不在首页时）浮出的直达面板（一块板块一列、固定两列，落点在顶栏那一行之下，不滚）。
// 站在首页上浮出没有意义，所以这一列只在别的页上被那一格唤出。
// 每条用例各自 import 一份 studio-app 实例：换页要改 location.hash，排在别人的文件里就是替别人重画现场。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, clearRoutes, jsonResponse, click, fire } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const ALL_BUILTIN_CARDS = [
    "paint", "video", "director", "pose", "canvas", "agent", "voice", "prompt-enhance",
    "edit-normal", "edit-outpaint", "edit-local", "edit-remove", "edit-angle", "edit-blend", "edit-pose",
    "frames", "reverse", "reverse-video", "gallery", "skills", "settings",
];
const studioBody = '<header class="ns-header"><nav class="ns-tabs">'
    + '<a href="#/home" data-tab="home">首页</a>'
    + '<a href="#/gallery" data-tab="gallery">素材</a>'
    + '</nav></header><div id="ns-view"></div><span class="ns-comfy-status" id="ns-comfy-status"></span>';
// jsdom 无布局：那一格与顶栏整条按这一份矩形排版，浮窗的落点就是可断言的固定值
const HOME_TAB_RECT = { x: 120, y: 8, top: 8, left: 120, right: 168, bottom: 32, width: 48, height: 24 };
const HEADER_RECT = { x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 40, width: 640, height: 40 };
// 与 studio-app.js 的 HOME_QUICK_SKIP_SECTIONS 同一份：「素材与配置」整块不进这一列（首页本身照旧铺这三张卡）
const QUICK_SKIP_SECTIONS = ["素材与配置"];
const MATERIAL_CARDS = ["gallery", "skills", "settings"];

// jsdom 没有真 WebSocket：studio-app 顶层连事件流，桩掉构造与 close 就够
globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

const settle = async () => { await sleep(0); await flush(); };
// jsdom 的 matchMedia 对任何查询都报 false，「这台机器有 hover」这条门在用例里永远关着：钉成可读全局的桩
globalThis.__hasHover = true;
window.matchMedia = (query) => ({
    matches: query.includes("hover") ? globalThis.__hasHover : false,
    media: query, addEventListener() {}, removeEventListener() {},
});
const homeTab = () => document.querySelector('.ns-tabs a[data-tab="home"]');
const quickEl = () => document.querySelector(".ns-home-quick");
const isOpen = () => !!quickEl() && !quickEl().classList.contains("ns-hidden");
const quickItems = () => [...quickEl().querySelectorAll(".ns-home-quick-item")].map((el) => el.dataset.cardId);
const quickLabels = () => [...quickEl().querySelectorAll(".ns-home-quick-label")].map((el) => el.textContent);

/** 起一份 studio-app 实例并落到 page 那一页；顶栏那一格钉上固定矩形供浮窗定位 */
async function boot(tag, page, layout = {}) {
    resetEnv();
    clearRoutes();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.33.1",
        offline: false, caps: { image_gen: true, prompt_enhance: true, queue: true, task_history: true },
        recipes: [],
    }));
    mockRoute("/neo_home/layout", jsonResponse(layout));
    mockRoute("/rs_recipes/list", jsonResponse([]));
    mockRoute("/rs_prompts/skills", jsonResponse([]));
    mockRoute("/neo_studio/launcher", jsonResponse({ error: "no such route" }, 404));
    window.location.hash = `#/${page}`;
    await import(`../../web/studio/studio-app.js?homeQuick${tag}=1`);
    await settle();
    homeTab().__rect = HOME_TAB_RECT;
    document.querySelector(".ns-header").__rect = HEADER_RECT;
}

test("不在首页时鼠标落在「首页」那一格上浮出：条目与首页那一叠同一份版式，落点在顶栏那一行之下", async () => {
    await boot("1", "gallery");
    assert.equal(quickEl(), null, "没落上鼠标之前不铺这一块");
    fire(homeTab(), "pointerenter");
    const quick = quickEl();
    assert.ok(quick, "落上鼠标就浮出");
    assert.ok(!quick.classList.contains("ns-hidden"), "浮出态");
    assert.ok(quick.querySelector(".ns-home-quick-panel"), "浮出的是面板本体");
    const cols = [...quick.querySelectorAll(".ns-home-quick-col")];
    assert.equal(cols.length, 2, "固定两块：创作一列、编辑一列，列数不看窗口高度");
    assert.equal(quick.style.getPropertyValue("--ns-home-quick-cols"), String(cols.length), "列数交给 CSS 的 grid");
    assert.equal(quick.style.left, "120px", "左沿贴那一格的左沿");
    assert.equal(quick.style.top, "50px", "顶沿在顶栏整条底沿之下 10px：不压在页签那一行上");
    assert.equal(quick.querySelector(".ns-home-quick-panel").style.maxHeight, `${window.innerHeight - 50 - 8}px`,
                 "面板按顶沿以下的剩余高度封顶：整块进窗口，装不下的尾部裁在面板里");
    assert.match(homeTab().title, /快速入口/, "那一格自己说出这一发");

    const items = quickItems();
    const labels = quickLabels();
    assert.ok(!items.includes("effect") && !items.includes("storyboard"),
              "默认不上首页的卡（特效视频 / 宫格图分镜）不在这一列里冒出来");
    assert.equal(new Set(labels).size, labels.length, "板块不劈开：一个板块在这块面板里只有一枚列头");
    const first = quick.querySelector(".ns-home-quick-item");
    assert.ok(first.querySelector(".ns-home-quick-icon svg"), "条目上是首页那枚图标");
    assert.ok(first.querySelector(".ns-home-quick-name").textContent, "条目有标题");
    assert.ok(first.querySelector(".ns-home-quick-sub").textContent, "条目有副标题");

    click(homeTab());   // 走首页：把那一叠卡摆出来，好和这一列的条目、板块标签对表
    await settle(); await settle();
    const sectionEls = [...document.querySelectorAll(".ns-page.ns-home .ns-home-section")];
    const cards = sectionEls.flatMap((labelEl) => {
        if (QUICK_SKIP_SECTIONS.includes(labelEl.textContent.trim())) return [];
        let grid = labelEl.nextElementSibling;   // 板块标题后面紧跟的就是它那条网格
        while (grid && !grid.classList.contains("ns-home-grid")) grid = grid.nextElementSibling;
        return [...(grid ? grid.querySelectorAll(".ns-home-card") : [])].map((el) => el.dataset.cardId);
    });
    assert.deepEqual(items, cards, "条目 = 首页里创作与编辑那两板块的卡，顺序一致：「素材与配置」整块不进这一列");
    assert.ok(!items.some((id) => MATERIAL_CARDS.includes(id)),
              "素材库 / 技能 / 设置都不进这一列：顶栏那一格、首页那张卡与顶栏右端齿轮里都有直达");
    const sections = sectionEls.map((el) => el.textContent.trim());
    assert.ok(!sections.includes("开始创作"), "首页板块名就是「创作」，不留旧文案");
    assert.deepEqual(labels, sections.filter((s) => !QUICK_SKIP_SECTIONS.includes(s)),
                    "列头 = 首页板块名减去不进这一列的那一块");
    assert.ok(!labels.includes("素材与配置"), "「素材与配置」的板块名不出现在列头里");
    assert.ok(!isOpen(), "跳到首页就收起：这一页不缺这一列");
});

test("窗口高矮不改列数：面板固定两块，矮窗口里整块夹进窗口高度内，不靠滚", async () => {
    await boot("7", "gallery");
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 420, configurable: true });
    try {
        fire(homeTab(), "pointerenter");
        const cols = [...quickEl().querySelectorAll(".ns-home-quick-col")];
        assert.equal(cols.length, 2, "列数不随窗口高度起落：宽窗口里不拉出一条一路伸出屏外的长条");
        assert.equal(quickEl().style.top, "50px", "顶沿不跟着窗口矮上去：窗口再矮也不压在页签那一行上");
        assert.equal(quickEl().querySelector(".ns-home-quick-panel").style.maxHeight, `${420 - 50 - 8}px`,
                     "面板按顶沿以下的剩余高度封顶：整块进窗口，尾部裁在面板里，不靠滚");
        assert.equal(quickEl().style.getPropertyValue("--ns-home-quick-cols"), String(cols.length), "列数交给 CSS 的 grid");
        const labels = quickLabels();
        assert.equal(new Set(labels).size, labels.length, "一块板块一列：一个板块在这块面板里只有一枚列头");
        assert.ok(cols.every((c) => c.querySelector(".ns-home-quick-label")), "每一列自带列头");
    } finally {
        Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true });
    }
});

test("站在首页上鼠标落在「首页」那一格不浮出：这一页不缺这一列", async () => {
    await boot("2", "home");
    assert.ok(document.querySelector(".ns-page.ns-home"), "起手就在首页");
    fire(homeTab(), "pointerenter");
    assert.equal(quickEl(), null, "首页上不铺这一列");
});

test("点条目跳到那一页并收起", async () => {
    await boot("3", "gallery");
    fire(homeTab(), "pointerenter");
    click(quickEl().querySelector('.ns-home-quick-item[data-card-id="prompt-enhance"]'));
    await settle(); await settle();
    assert.equal(location.hash, "#/enhance", "条目走的就是 openHomeCard 那条现成的路");
    assert.ok(!isOpen(), "跳走时收起，不压在别人那一页上");
});

test("离开那一格就收起；指针从格跨进面板这一段宽限不算离开", async (t) => {
    await boot("4", "gallery");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
        fire(homeTab(), "pointerenter");
        assert.ok(isOpen(), "落上就浮出");
        fire(homeTab(), "pointerleave");
        t.mock.timers.tick(120);
        assert.ok(isOpen(), "宽限之内不收起：指针正在跨过去那几步里");
        fire(quickEl().querySelector(".ns-home-quick-item"), "pointerenter");   // 跨进面板里的条目
        t.mock.timers.tick(1000);
        assert.ok(isOpen(), "指针落在条目上就不收：面板本体不吃指针事件");
        fire(quickEl().querySelector(".ns-home-quick-item"), "pointerleave");
        t.mock.timers.tick(1000);
        assert.ok(!isOpen(), "离开条目才收起");
    } finally {
        t.mock.timers.reset();
    }
});

test("首页卡片全部移出后鼠标落上也不浮出：没有可用条目就不出这块控件", async () => {
    await boot("5", "gallery", { hidden: ALL_BUILTIN_CARDS });
    fire(homeTab(), "pointerenter");
    assert.equal(quickEl(), null, "没有条目可浮就不铺这一块：根是浮出那一刻才建的");
});

test("只剩「素材与配置」那板块的卡也不浮出：整块排除干净就没有条目可浮", async () => {
    await boot("8", "gallery", { hidden: ALL_BUILTIN_CARDS.filter((id) => !MATERIAL_CARDS.includes(id)) });
    fire(homeTab(), "pointerenter");
    assert.equal(quickEl(), null, "「素材与配置」整块不进这一列：只剩它就没有条目，不铺这一块");
});

test("触屏档没有 hover：鼠标落上也不浮出，那一格照旧是点它进首页", async () => {
    globalThis.__hasHover = false;
    try {
        await boot("6", "gallery");
        fire(homeTab(), "pointerenter");
        assert.equal(quickEl(), null, "没有 hover 的机器上不铺这一列");
        click(homeTab());
        await settle(); await settle();
        assert.equal(location.hash, "#/home", "点那一格就是进首页");
    } finally {
        globalThis.__hasHover = true;
    }
});

test("CSS 契约：钉在窗口上、压在页面内容之上弹窗之下、多列铺开不滚、窄档收一档", () => {
    const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
    const base = css.match(/\.ns-home-quick \{[^}]*\}/)?.[0] || "";
    assert.match(base, /position:\s*fixed/, "钉在窗口上，不跟着页面滚");
    assert.match(base, /z-index:\s*9650/, "压在页面内容素材浮层之上（队列面板 9690 / 素材弹窗 9700 / 灯箱在其上）");
    assert.match(base, /pointer-events:\s*none/, "面板本体不吃指针事件：浮窗展开时不许吃掉底下那一页的点击");
    const item = css.match(/\.ns-home-quick-item \{[^}]*\}/)?.[0] || "";
    assert.match(item, /pointer-events:\s*auto/, "这一列里只有条目吃事件");
    const panel = css.match(/\.ns-home-quick-panel \{[^}]*\}/)?.[0] || "";
    assert.match(panel, /display:\s*grid/, "多列铺开");
    assert.match(panel, /grid-template-columns:\s*repeat\(var\(--ns-home-quick-cols/, "列数由 JS 定好传进来（固定两块）");
    assert.match(panel, /max-height:\s*calc\(100vh - 16px\)/, "矮窗口里整块夹进窗口高度内：裁在面板里，不出滚动条");
    assert.match(panel, /width:\s*min\([^;]*var\(--ns-home-quick-cols[^;]*var\(--ns-home-quick-colw/,
        "宽度 = 列数 × 单列宽，窗口窄时吃满幅减去边距");
    assert.doesNotMatch(panel, /overflow-y:\s*(auto|scroll)/, "面板不滚：要滚起来的菜单不算快捷入口");
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.ns-home-quick-panel \{ animation: none/,
              "系统减少动画时浮出动画收掉");
    assert.match(css, /@media \(max-width: 720px\) \{\s*\.ns-home-quick-panel \{[^}]*--ns-home-quick-colw:\s*240px/,
              "窄档单列宽收一档：这一列不许比屏宽");
});

