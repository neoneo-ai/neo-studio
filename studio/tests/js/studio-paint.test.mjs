// 绘画页回归：左栏常驻素材库 + 右栏两块面板进页就铺好（文生图可直接写提示词，图片编辑空面板等拖图），
// 入口只做模式切换、复用现成面板（重建会把写了一半的提示词清掉）。
// 一、画廊是单例，绘画页左栏素材库与素材页共用同一个实例：进绘画页挂到左栏，离页交还素材页，
// 一次只挂一处（两次 render 抢同一个元素时，后落的那次会把画廊拽回上一页）。
// 二、内嵌宿主的 onOpen 直接 showView 会把 location.hash 留在素材页：之后点顶栏「素材」（href 与
// hash 相同）不触发 hashchange，页面切不回去，生成素材按钮再也点不动。入口一律走 hash 才不会这样。
// 三、页内面板是页面的一段，不是弹窗：不建遮罩、无「取消」「关闭」（收起 = 切到另一个模式）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, mockRoute, clearRoutes, jsonResponse, sleep, click } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

// 显存读数 / 状态位连的是 WebSocket，jsdom 没有真 WS：桩掉，只留构造与 close
globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?paint=${seq++}`);

const pageOf = (el) => el?.closest(".ns-page");
// 素材页宿主 = 直接挂在 .ns-page 下的那个（绘画页左栏的常驻素材库宿主挂在 .ns-paint-side 下）
const galleryHost = () => [...document.querySelectorAll(".ns-gallery-host")].find((h) => h.parentElement.classList.contains("ns-page"));
const paintText = () => document.querySelector(".ns-paint .ns-paint-text");
const paintEdit = () => document.querySelector(".ns-paint .ns-paint-edit");
const paintLib = () => document.querySelector(".ns-paint .ns-gallery-host");
const gmBtn = () => galleryHost()?.querySelector(".neo-gallery-gm-btn");
const overlay = () => document.querySelector(".neo-gallery-story-modal-overlay");
const btnTexts = (root) => [...root.querySelectorAll(".neo-gallery-story-btn")].map((b) => b.textContent.trim());
const textPanel = () => paintText()?.querySelector(".neo-gallery-gen-panel");
const editPanel = () => paintEdit()?.querySelector(".neo-gallery-gen-panel");
const modeBtns = (panel) => [...panel.querySelectorAll(".neo-gallery-edit-outpaint-btn")];
const hintOf = (panel) => panel.querySelector(".neo-gallery-story-hint").textContent;

// hashchange 由 jsdom 作为宏任务派发：微任务 flush 不够，等一轮事件循环
const settle = async () => { await sleep(0); await flush(); };

async function boot() {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_studio/version", jsonResponse({ success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [] }));
    mockRoute("/rs_prompts/skills", jsonResponse([{ id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true }]));
    mockRoute("/rs_recipes/list", jsonResponse([]));
    mockRoute("/neo_studio/mem_stats", jsonResponse({}));
    mockRoute("/neo_image_gen/settings", jsonResponse({ target_megapixels: 1.5 }));
    document.body.innerHTML = studioBody;
    window.location.hash = "#/gallery";
    await importApp();
    // jsdom 的 session history 会把设 hash 的 hashchange 延后派发：先让它落地，
    // 否则它会排在测试的点击后面，把刚切过去的绘画页又拽回素材页
    await settle();
    await settle();
    // 素材页宿主换成顶栏「生成素材」按钮（onclick 与真素材页同款），省掉整页画廊的取数
    const shim = await import("../../web/studio/shim/app.js");
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");
    // 素材页宿主换成顶栏「生成素材」按钮（onclick 与真素材页同款），省掉整页画廊的取数。
    // 真画廊是单例元素、render 时整体搬进宿主，这里照搬这个语义：换宿主时上一页的宿主会空掉
    const galleryEl = document.createElement("div");
    galleryEl.className = "neo-gallery";
    const gm = document.createElement("button");
    gm.className = "neo-gallery-gm-btn";
    gm.onclick = () => openGenMaterialDialog({});
    galleryEl.appendChild(gm);
    shim.app.extensionManager.registerSidebarTab({
        id: "neo.gallery",
        render: async (el) => {
            el.innerHTML = "";
            el.appendChild(galleryEl);
        },
    });
    await shim.getSidebarTab("neo.gallery").render(galleryHost());
}

// 顶栏 tab 是 <a href="#/xxx">：jsdom 不跳转 fragment 链接，hash 没变时补一刀模拟浏览器行为
async function clickTab(name) {
    click(document.querySelector(`.ns-tabs a[data-tab="${name}"]`));
    await settle();
    if (location.hash !== `#/${name}`) location.hash = `#/${name}`;
    await settle();
}

test("绘画页：进页就铺好文生图面板与空图片编辑面板，入口只切模式不重建", async () => {
    await boot();
    assert.ok(gmBtn(), "素材页顶栏应有生成素材按钮");

    await clickTab("paint");
    assert.ok(paintLib(), "绘画页左栏应有常驻素材库宿主");
    assert.ok(!document.querySelector(".ns-paint-recipes"), "绘画页不应再有图片配方列表");
    assert.equal(document.querySelectorAll(".ns-paint .ns-paint-mode-btn").length, 2, "右栏应有文生图 / 图片编辑两个模式按钮");
    assert.ok(paintLib()?.querySelector(".neo-gallery-gm-btn"), "进绘画页应把画廊单例挂进左栏素材库");
    assert.ok(!gmBtn(), "画廊单例一次只挂一处：素材页宿主此时应是空的");
    assert.ok(!overlay(), "内嵌模式不应建浮层遮罩");

    // 文生图：进页即就绪，写提示词就能生成（不必先点「生成素材」）
    const panel = textPanel();
    assert.ok(panel, "进页应铺好文生图面板");
    assert.ok(panel.querySelector(".neo-gallery-story-modal--embedded"), "内嵌面板应带内嵌标记（样式去窗壳靠它）");
    assert.ok(btnTexts(panel).includes("生成"), "idle 应有「生成」");
    assert.ok(!btnTexts(panel).includes("取消"), "页内面板不应有「取消」：收起 = 切到另一个模式");
    assert.match(hintOf(panel), /左栏素材库直接可见/, "页内面板走短句说明");
    assert.ok(!paintText().classList.contains("ns-hidden"), "默认模式应是文生图");

    // 图片编辑：空面板同样在位，预览区就是拖放落点（拖进来才解锁各编辑模式）
    const ep = editPanel();
    assert.ok(ep, "进页应铺好图片编辑面板");
    assert.ok(ep.querySelector(".neo-gallery-story-modal--embedded"), "内嵌面板应带内嵌标记");
    assert.ok(ep.querySelector(".neo-gallery-edit-empty"), "无原图时预览区应是拖放落点");
    assert.ok(modeBtns(ep).length && modeBtns(ep).every((b) => b.disabled), "无原图时扩图 / 局部 / 点选删除 / 融合 / 姿势先收起");
    assert.ok(btnTexts(ep).includes("生成"), "idle 应有「生成」");
    assert.ok(!btnTexts(ep).includes("取消"), "页内面板不应有「取消」");
    assert.match(hintOf(ep), /把左栏素材拖进预览区当原图/, "空面板说明先拖原图");
    assert.ok(paintEdit().classList.contains("ns-hidden"), "编辑宿主应随模式收起");

    // 左栏「生成素材」：面板已在位，点它只切模式，已写的提示词不能被清掉
    panel.querySelector(".neo-gallery-gm-quick-input").value = "红色陶瓷杯的白底产品图";
    click(paintLib().querySelector(".neo-gallery-gm-btn"));
    await settle();
    assert.equal(textPanel(), panel, "入口应复用现成面板，不重建");
    assert.equal(textPanel().querySelector(".neo-gallery-gm-quick-input").value, "红色陶瓷杯的白底产品图", "复用不能清掉已写的提示词");
    assert.equal(location.hash, "#/paint", "左栏入口不应跳页，hash 留在绘画页");

    await clickTab("gallery");
    assert.ok(!pageOf(galleryHost()).classList.contains("ns-hidden"), "点顶栏「素材」应回到素材页");
    assert.ok(pageOf(paintText()).classList.contains("ns-hidden"), "绘画页应收起");
    assert.ok(gmBtn(), "离开绘画页应把画廊单例交还素材页宿主");
    assert.ok(!paintLib()?.querySelector(".neo-gallery-gm-btn"), "绘画页左栏此时应是空的");

    click(gmBtn());
    await settle();
    assert.equal(textPanel(), panel, "素材页入口同样复用绘画页面板（面板随页面常驻）");
    assert.ok(!pageOf(paintText()).classList.contains("ns-hidden"), "点生成素材应切到绘画页");
    assert.equal(location.hash, "#/paint", "切页应走 hash，顶栏 tab 与路由同步");
    assert.ok(!overlay(), "内嵌模式不应建浮层遮罩");
});

test("绘画页：图片卡菜单「图片编辑」把这张图换进现成面板当原图", async () => {
    await boot();
    await clickTab("paint");
    const ep = editPanel();
    assert.ok(ep.querySelector(".neo-gallery-edit-empty"), "进页时编辑面板应是空原图状态");

    const { openImageEditDialog } = await import("../../web/gallery-gen.js");
    openImageEditDialog({}, { name: "portrait", filename: "portrait.png" }, "");
    await sleep(20);

    assert.equal(editPanel(), ep, "卡片菜单入口应复用现成面板，不重建");
    assert.ok(!ep.querySelector(".neo-gallery-edit-empty"), "原图到位后拖放落点应收起");
    assert.match(ep.querySelector(".neo-gallery-edit-compare-img").getAttribute("src"), /portrait\.png/, "预览区应换成这张原图");
    assert.ok(modeBtns(ep).every((b) => !b.disabled), "原图到位应解锁扩图 / 局部 / 点选删除 / 融合 / 姿势");
    assert.match(hintOf(ep), /生成结果与原图左右对比/, "有原图后说明换回编辑说明");
    assert.ok(!document.querySelector(".neo-gallery-edit-modal-overlay"), "内嵌模式不应建图片编辑浮层遮罩");
    assert.ok(!paintEdit().classList.contains("ns-hidden"), "编辑宿主应切到可见");
    assert.ok(paintText().classList.contains("ns-hidden"), "文生图宿主应随模式切换收起");
    assert.equal(location.hash, "#/paint", "绘画页内入口不应跳页");
});

test("绘画页：左栏拖到最窄收起整栏，双击展开回收起前的宽度", async () => {
    await boot();
    await clickTab("paint");
    const page = document.querySelector(".ns-paint");
    const split = document.querySelector(".ns-paint-side + .ns-director-colsplit");
    const mouse = (type, x) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 0 });
    const pref = () => JSON.parse(localStorage.getItem("neo_studio_paint_side_col") || "{}");

    assert.ok(split, "绘画页左栏与右栏之间有分隔条");
    assert.equal(page.style.getPropertyValue("--ns-side-w"), "", "没拖过的绘画页用样式默认宽度");

    // 拖过收起阈值：整栏宽度写 0，收起状态落在绘画页自己那份偏好里
    split.dispatchEvent(mouse("mousedown", 380));
    window.dispatchEvent(mouse("mousemove", 120));
    assert.ok(page.classList.contains("ns-side-collapsed"), "拖到最窄收起左栏");
    assert.equal(page.style.getPropertyValue("--ns-side-w"), "0px", "收起写 0 宽");
    assert.equal(split.getAttribute("aria-expanded"), "false", "分隔条播报收起状态");
    window.dispatchEvent(mouse("mouseup", 120));
    assert.equal(pref().side_closed, true, "绘画页收起状态落盘");
    assert.ok(!document.querySelector(".ns-director")?.classList.contains("ns-side-collapsed"), "绘画页收起不牵连导演页");

    // 双击展开：宽度交回样式默认（绘画页没存过宽度）
    split.dispatchEvent(mouse("dblclick", 0));
    assert.ok(!page.classList.contains("ns-side-collapsed"), "双击展开左栏");
    assert.equal(page.style.getPropertyValue("--ns-side-w"), "", "展开后回到样式默认宽度");
    assert.equal(pref().side_closed, false, "展开状态落盘");
});
