// 绘画页 / 编辑页回归：一页一块面板，进页就铺好（绘画页只有文生图，可直接写提示词；编辑页只有图片编辑，
// 空面板等拖图）。入口只跳页并复用现成面板（重建会把写了一半的提示词清掉）。素材库走弹窗，只在编辑页：
// 悬浮「素材库」点卡片 = 取用该图当原图；参考图菜单的「素材库取用」点卡片 = 进参考位。
// 一、画廊是单例，素材库弹窗与素材页共用同一个实例：弹窗开着挂到弹窗宿主，关窗交还，
// 一次只挂一处（两次 render 抢同一个元素时，后落的那次会把画廊拽回上一页）。
// 二、内嵌宿主的 onOpen 直接 showView 会把 location.hash 留在素材页：之后点顶栏「素材」（href 与
// hash 相同）不触发 hashchange，页面切不回去，生成素材按钮再也点不动。入口一律走 hash 才不会这样。
// 三、页内面板是页面的一段，不是弹窗：不建遮罩、无「取消」「关闭」。
// 四、两页各注册自己的宿主（setPaintHost 合并写入）：覆盖式写入会让后建的那一页把前一页的宿主丢掉，
// 素材页的「图片编辑」入口就此静默落回浮层窗。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, mockRoute, clearRoutes, jsonResponse, sleep, click } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

// 顶栏状态位 / 队列面板连的是 WebSocket，jsdom 没有真 WS：桩掉，只留构造与 close
globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?paint=${seq++}`);

const pageOf = (el) => el?.closest(".ns-page");
// 素材页宿主 = 直接挂在 .ns-page 下的那个（绘画页与编辑页都没有常驻画廊宿主，素材库走弹窗宿主）
const galleryHost = () => [...document.querySelectorAll(".ns-gallery-host")].find((h) => h.parentElement.classList.contains("ns-page"));
const tabsLink = (name) => document.querySelector(`.ns-tabs a[data-tab="${name}"]`);
const paintPage = () => pageOf(document.querySelector(".ns-paint-text"));
const editPage = () => pageOf(document.querySelector(".ns-paint-edit"));
const libBtn = () => editPage()?.querySelector(".ns-paint-lib-btn");
const libModal = () => document.querySelector(".ns-libmodal:not(.ns-hidden)");
const galleryCard = () => document.querySelector(".neo-gallery-thumb-container[data-filename]");
const gmBtn = () => galleryHost()?.querySelector(".neo-gallery-gm-btn");
const overlay = () => document.querySelector(".neo-gallery-story-modal-overlay");
const btnTexts = (root) => [...root.querySelectorAll(".neo-gallery-story-btn")].map((b) => b.textContent.trim());
const textPanel = () => document.querySelector(".ns-paint-text .neo-gallery-gen-panel");
const editPanel = () => document.querySelector(".ns-paint-edit .neo-gallery-gen-panel");
const modeChip = (panel) => panel.querySelector(".neo-gallery-edit-mode-select").parentElement;
const modeChipBtn = (panel) => modeChip(panel).querySelector(".neo-gallery-gm-chip-btn");
const hintOf = (panel) => panel.querySelector(".neo-gallery-story-hint").textContent;
// 空预览那枚「原图」方块在不在：面板不重建，取用 / 移除靠 display 收起铺回同一块空预览
const emptyShown = (panel) => {
    const el = panel.querySelector(".neo-gallery-edit-empty");
    return !!el && el.style.display !== "none";
};

// hashchange 由 jsdom 作为宏任务派发：微任务 flush 不够，等一轮事件循环
const settle = async () => { await sleep(0); await flush(); };

async function boot() {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_studio/version", jsonResponse({ success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [] }));
    mockRoute("/rs_prompts/skills", jsonResponse([{ id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true }]));
    mockRoute("/rs_recipes/list", jsonResponse([]));
    mockRoute("/neo_image_gen/settings", jsonResponse({ target_megapixels: 1.5 }));
    document.body.innerHTML = studioBody;
    window.location.hash = "#/gallery";
    // 先注册替身 tab，再导入 studio-app：studio-app 首次挂载画廊时就缓存它拿到的 tab，
    // 晚注册的话本用例挂进宿主的是上一条用例那份替身（元素对不上本用例的 DOM）
    const shim = await import("../../web/studio/shim/app.js");
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");
    // Studio 页面里 scripts/app.js 就是 shim（同一份 sidebarTab）；测试钩子把它指到 mock，
    // 这里把 shim 侧栏写入接回 mock 的调用方，面板里的「素材库取用」（media-transfer 写侧栏）才落进弹窗
    const { app: mockApp } = await import("./mocks/comfy-app.mjs");
    mockApp.extensionManager.sidebarTab = {
        get activeSidebarTabId() { return shim.app.extensionManager.sidebarTab.activeSidebarTabId; },
        set activeSidebarTabId(id) { shim.app.extensionManager.sidebarTab.activeSidebarTabId = id; },
    };
    // 素材页宿主里放一枚顶栏「生成素材」按钮（onclick 与真素材页同款），省掉整页画廊的取数。
    // 真画廊是单例元素、render 时整体搬进宿主，这里照搬这个语义：换宿主时上一页的宿主会空掉
    const galleryEl = document.createElement("div");
    galleryEl.className = "neo-gallery";
    const gm = document.createElement("button");
    gm.className = "neo-gallery-gm-btn";
    gm.onclick = () => openGenMaterialDialog({});
    galleryEl.appendChild(gm);
    // 一枚真卡片形体的素材卡（data 属性与真卡片同款），供弹窗单点取用
    const card = document.createElement("div");
    card.className = "neo-gallery-thumb-container";
    card.dataset.filename = "pick.png";
    card.dataset.subfolder = "";
    galleryEl.appendChild(card);
    shim.app.extensionManager.registerSidebarTab({
        id: "neo.gallery",
        render: async (el) => {
            el.innerHTML = "";
            el.appendChild(galleryEl);
        },
    });
    await importApp();
    // jsdom 的 session history 会把设 hash 的 hashchange 延后派发：先让它落地，
    // 否则它会排在测试的点击后面，把刚切过去的页面又拽回素材页
    await settle();
    await settle();
}

// 顶栏 tab 是 <a href="#/xxx">：jsdom 不跳转 fragment 链接，hash 没变时补一刀模拟浏览器行为
async function clickTab(name) {
    click(tabsLink(name));
    await settle();
    if (location.hash !== `#/${name}`) location.hash = `#/${name}`;
    await settle();
}

test("绘画页：进页就铺好文生图面板，页内没有模式切换也没有素材库入口", async () => {
    await boot();
    assert.ok(gmBtn(), "素材页顶栏应有生成素材按钮");
    assert.ok(tabsLink("edit"), "顶栏应有独立的「编辑」页签");

    await clickTab("paint");
    assert.ok(paintPage(), "文生图宿主应挂在「绘画」这一页里");
    assert.equal(document.querySelectorAll(".ns-paint-mode-btn").length, 0, "页内不该再有文生图 / 图片编辑模式按钮");
    assert.ok(!paintPage().querySelector(".ns-paint-lib-btn"), "素材库入口只在编辑页，绘画页不该有");
    assert.ok(!paintPage().querySelector(".ns-paint-edit"), "绘画页不该有图片编辑宿主");
    assert.ok(!paintPage().querySelector(".ns-gallery-host"), "绘画页不应再有常驻左栏素材库");
    assert.ok(gmBtn(), "进绘画页画廊单例应留在收留宿主，绘画页自己不养画廊");
    assert.ok(!overlay(), "内嵌模式不应建浮层遮罩");
    assert.ok(!paintPage().classList.contains("ns-hidden"), "点顶栏「绘画」应停在绘画页");

    // 文生图：进页即就绪，写提示词就能生成（不必先点「生成素材」）
    const panel = textPanel();
    assert.ok(panel, "进页应铺好文生图面板");
    assert.ok(panel.querySelector(".neo-gallery-story-modal--embedded"), "内嵌面板应带内嵌标记（样式去窗壳靠它）");
    assert.ok(btnTexts(panel).includes("生成"), "idle 应有「生成」");
    assert.ok(!btnTexts(panel).includes("取消"), "页内面板不应有「取消」");
    assert.ok(panel.querySelector(".neo-gallery-gm-quick-input"), "idle 直接给输入框：写一句就生成");
    assert.equal(panel.querySelectorAll("textarea").length, 1, "文生图只有一个提示词框：两个框会让人不知道往哪写");
    assert.ok(panel.querySelector(".neo-gallery-gm-composer-bar")?.querySelector(".neo-gallery-gm-gen-btn"), "「生成」在输入卡的控件行里");
    assert.ok(!panel.querySelector(".neo-gallery-gm-hero"), "idle 不铺空画布占位");
    assert.ok(panel.querySelector(".neo-gallery-gm-idle"), "idle 在结果区给一句起手提示（结果区在输入卡上方）");
    const bar = panel.querySelector(".neo-gallery-gm-composer-bar");
    assert.equal(bar.querySelectorAll(".neo-gallery-gm-chip-btn").length, 3, "技能与自定参数 / 比例 / 最长边是真 chip 按钮");
    const gmPanel = bar.querySelector(".neo-gallery-gm-chip-panel");
    const visibleSelects = [...bar.querySelectorAll("select")].filter((s) => !s.hidden && !gmPanel.contains(s));
    assert.equal(visibleSelects.length, 0, "控件行里没有浏览器下拉框：原生 select 只当状态容器");
    const modalKids = [...panel.querySelector(".neo-gallery-story-modal--embedded").children];
    assert.ok(modalKids.indexOf(panel.querySelector(".neo-gallery-cs-status")) < modalKids.indexOf(panel.querySelector(".neo-gallery-gm-composer")),
        "结果区排在上、输入卡排最后一块（样式把它钉在面板底部）");
    const gmModelBox = panel.querySelector(".neo-gallery-gm-model-box");
    const enhanceGroup = panel.querySelector(".neo-gallery-gm-enhance-group");
    assert.ok(enhanceGroup && panel.querySelector(".neo-gallery-gm-more-menu").contains(enhanceGroup),
        "增强收在 ⋯ 菜单里（默认视野只剩输入框 = 写一句直接生成）");
    assert.ok(gmPanel?.contains(gmModelBox), "自定参数默认不显示：面板挂在自定参数 chip 的浮层里");
});

test("编辑页：进页铺好空图片编辑面板，顶部右侧是素材库入口", async () => {
    await boot();
    await clickTab("edit");
    const ep = editPanel();
    assert.ok(ep, "进页应铺好图片编辑面板");
    assert.ok(!editPage().querySelector(".ns-paint-text"), "编辑页不该有文生图宿主");
    assert.ok(libBtn(), "编辑页顶部右侧应有素材库入口");
    assert.ok(!editPage().querySelector(".ns-gallery-host"), "编辑页不应有常驻左栏素材库");
    assert.ok(ep.querySelector(".neo-gallery-story-modal--embedded"), "内嵌面板应带内嵌标记");
    assert.ok(ep.querySelector(".neo-gallery-edit-empty .neo-gallery-edit-srcbox"), "无原图时预览区应铺好「＋ 原图」方块");
    assert.ok(modeChipBtn(ep).disabled, "无原图时编辑模式 chip 先禁用");
    assert.ok(modeChip(ep).querySelector(".neo-gallery-gm-chip-label").textContent.trim(), "模式 chip 显示当前模式名");
    assert.match(modeChipBtn(ep).title, /先选一张原图/, "禁用态的提示说明缺的是原图");
    assert.ok(btnTexts(ep).includes("生成"), "idle 应有「生成」");
    assert.ok(!btnTexts(ep).includes("取消"), "页内面板不应有「取消」");
    assert.match(hintOf(ep), /「原图」方块选原图/, "空面板说明先点方块选原图");
    // 编辑控件与文生图同一组：一个输入卡 + 底行 chips（技能 / 模式 / 尺寸 / 自定参数）
    const ebar = ep.querySelector(".neo-gallery-gm-composer-bar");
    assert.ok(ebar && ebar.querySelector(".neo-gallery-gm-gen-btn"), "「生成」在编辑输入卡的 chips 行里");
    assert.equal(ebar.querySelectorAll(".neo-gallery-gm-chip-btn").length, 3, "技能与自定参数 / 模式 / 尺寸是真 chip 按钮");
    const editParamsPanel = ebar.querySelector(".neo-gallery-gm-chip-panel");
    const visibleEditSelects = [...ebar.querySelectorAll("select")].filter((s) => !s.hidden && !editParamsPanel.contains(s));
    assert.equal(visibleEditSelects.length, 0, "编辑控件行里没有浏览器下拉框");
    assert.ok(ebar.querySelector(".neo-gallery-edit-size-chip"), "出图尺寸收成一枚 chip");
    assert.ok(editParamsPanel?.contains(ep.querySelector(".neo-gallery-edit-model-box")),
        "编辑自定参数默认不显示：面板挂在自定参数 chip 的浮层里");
    assert.ok(ep.querySelector(".neo-gallery-story-actions").children.length === 0,
        "页内 idle 操作区是空的（样式让空块不占位）");
});

// 两页共用同一副骨架，样式各挂各的宿主类：这条守的是「编辑页收高不再动到绘画页」——
// 上一版页边与主栏的收高挂在共用的 .ns-paint 上，绘画页的输入卡与底部操作行被一起顶到窗口底边裁切
test("两页样式独立：编辑页的收高只挂 .ns-paint-edit，绘画页照旧吃满页边", () => {
    const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
    assert.match(css, /\.ns-page:has\(\.ns-paint-edit\)\s*\{[^}]*padding-top: 4px/,
        "页边收高只挂在编辑页宿主上");
    assert.ok(!css.includes(".ns-page:has(.ns-paint) "), "不再有把两页一起收高的页边规则");
    const editBlock = css.slice(css.indexOf("===== 编辑页（图片编辑）专有用样式"), css.indexOf("/* 手机：面板内衬收到 8px"));
    assert.ok(editBlock.length > 400, "应存在编辑页专有用样式块");
    assert.ok(!editBlock.includes(".ns-paint-panel"), "编辑页专用样式不挂两页共用的面板宿主");
});

// 素材库弹窗：画廊单例挂进弹窗宿主；「生成素材」入口复用现成文生图面板，提示词不被清掉
test("编辑页素材库：点卡片取用进图片编辑；弹窗里的「生成素材」跳到绘画页", async () => {
    await boot();
    await clickTab("edit");
    const ep = editPanel();
    const panel = textPanel();
    panel.querySelector(".neo-gallery-gm-quick-input").value = "红色陶瓷杯的白底产品图";

    click(libBtn());
    await settle();
    const modal = libModal();
    assert.ok(modal, "素材库按钮应打开弹窗");
    assert.ok(modal.contains(galleryCard()), "弹窗里应能看到素材卡片");
    assert.ok(modal.querySelector(".neo-gallery-gm-btn"), "开弹窗应把画廊单例挂进弹窗宿主");
    assert.ok(!gmBtn(), "画廊单例一次只挂一处：素材页宿主此时应是空的");
    click(galleryCard());
    await settle();
    assert.ok(!libModal(), "单点取用应关窗");
    assert.equal(editPanel(), ep, "取用应复用现成编辑面板，不重建");
    assert.ok(!emptyShown(ep), "原图到位后原图方块应收起");
    assert.match(ep.querySelector(".neo-gallery-edit-compare-img").getAttribute("src"), /pick\.png/, "预览区应换成这张原图");
    assert.equal(location.hash, "#/edit", "编辑页内的取用不应跳页");

    click(libBtn());
    await settle();
    click(libModal().querySelector(".neo-gallery-gm-btn"));
    await settle();
    assert.equal(textPanel(), panel, "入口应复用现成文生图面板，不重建");
    assert.equal(textPanel().querySelector(".neo-gallery-gm-quick-input").value, "红色陶瓷杯的白底产品图", "复用不能清掉已写的提示词");
    assert.equal(location.hash, "#/paint", "文生图入口应跳到绘画页");
    assert.ok(!libModal(), "入口把面板铺好后弹窗应让位（同页 go 不触发收起）");
    assert.ok(!overlay(), "内嵌模式不应建浮层遮罩");

    await clickTab("gallery");
    assert.ok(!pageOf(galleryHost()).classList.contains("ns-hidden"), "点顶栏「素材」应回到素材页");
    assert.ok(pageOf(paintPage()).classList.contains("ns-hidden"), "离开时绘画页应收起");
    assert.ok(gmBtn(), "离开绘画页应把画廊单例交还素材页宿主");

    click(gmBtn());
    await settle();
    assert.equal(textPanel(), panel, "素材页入口同样复用绘画页面板（面板随页面常驻）");
    assert.ok(!pageOf(paintPage()).classList.contains("ns-hidden"), "点生成素材应切到绘画页");
    assert.equal(location.hash, "#/paint", "切页应走 hash，顶栏 tab 与路由同步");
});

// 参考图菜单与悬浮按钮是两个取用落点：宿主把面板交来的参考回调记成「取原图」，参考菜单就变成换主图
test("编辑页素材库取用：参考菜单的取用进参考位不换原图，悬浮按钮的取用才是原图", async () => {
    await boot();
    await clickTab("edit");
    const ep = editPanel();

    const refLib = [...ep.querySelectorAll(".neo-gallery-edit-refpick")].find((b) => b.textContent.includes("素材库"));
    assert.ok(refLib, "参考行应有「素材库取用」");
    click(refLib);
    await settle();
    assert.ok(libModal(), "参考菜单的「素材库取用」应开素材库弹窗");
    click(galleryCard());
    await settle();
    assert.ok(!libModal(), "单点取用应关窗");
    const refs = ep.querySelectorAll(".neo-gallery-edit-refchip-img");
    assert.equal(refs.length, 1, "取用的素材应落进参考位");
    assert.match(refs[0].getAttribute("src"), /pick\.png/, "参考位应是这张素材");
    assert.ok(emptyShown(ep), "参考取用不该换掉原图（原图方块应还在）");

    // 参考那条回调不能留到下一次取用：悬浮「素材库」按钮取的是原图
    click(libBtn());
    await settle();
    click(galleryCard());
    await settle();
    assert.ok(!emptyShown(ep), "悬浮按钮的取用应把这张图设成原图");
    assert.match(ep.querySelector(".neo-gallery-edit-compare-img").getAttribute("src"), /pick\.png/);
    assert.equal(ep.querySelectorAll(".neo-gallery-edit-refchip-img").length, 1, "取原图不该多出一张参考");
});

test("素材页入口：图片卡菜单「图片编辑」跳到编辑页并复用现成面板", async () => {
    await boot();
    const ep = editPanel();

    const { openImageEditDialog } = await import("../../web/gallery-gen.js");
    openImageEditDialog({}, { name: "portrait", filename: "portrait.png" }, "");
    await sleep(20);

    assert.equal(editPanel(), ep, "卡片菜单入口应复用现成面板，不重建");
    assert.ok(!emptyShown(ep), "原图到位后原图方块应收起");
    assert.match(ep.querySelector(".neo-gallery-edit-compare-img").getAttribute("src"), /portrait\.png/, "预览区应换成这张原图");
    assert.ok(!modeChipBtn(ep).disabled, "原图到位应解锁编辑模式 chip");
    assert.equal(modeChip(ep).querySelectorAll("option").length, 7, "模式 chip 列全七种模式");
    assert.equal(ep.querySelector(".neo-gallery-story-hint"), null, "有原图后不挂说明行（面板贴着预览，纵向没有余量）");
    assert.ok(!document.querySelector(".neo-gallery-edit-modal-overlay"), "内嵌模式不应建图片编辑浮层遮罩");
    assert.equal(location.hash, "#/edit", "图片编辑入口应跳到编辑页");
    assert.ok(tabsLink("edit").classList.contains("active"), "顶栏选中的应是「编辑」");
});


