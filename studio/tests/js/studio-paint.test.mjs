// 绘画页回归：右栏两块面板进页就铺好（文生图可直接写提示词，图片编辑空面板等拖图），
// 入口只做模式切换、复用现成面板（重建会把写了一半的提示词清掉）。素材库走弹窗：
// 模式行右端入口开弹窗，点卡片 = 取用该图进图片编辑并关窗。
// 一、画廊是单例，素材库弹窗与素材页共用同一个实例：弹窗开着挂到弹窗宿主，关窗交还，
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
// 素材页宿主 = 直接挂在 .ns-page 下的那个（绘画页没有常驻画廊宿主，素材库走弹窗宿主）
const galleryHost = () => [...document.querySelectorAll(".ns-gallery-host")].find((h) => h.parentElement.classList.contains("ns-page"));
const paintText = () => document.querySelector(".ns-paint .ns-paint-text");
const paintEdit = () => document.querySelector(".ns-paint .ns-paint-edit");
const libBtn = () => document.querySelector(".ns-paint .ns-paint-lib-btn");
const libModal = () => document.querySelector(".ns-libmodal:not(.ns-hidden)");
const galleryCard = () => document.querySelector(".neo-gallery-thumb-container[data-filename]");
const gmBtn = () => galleryHost()?.querySelector(".neo-gallery-gm-btn");
const overlay = () => document.querySelector(".neo-gallery-story-modal-overlay");
const btnTexts = (root) => [...root.querySelectorAll(".neo-gallery-story-btn")].map((b) => b.textContent.trim());
const textPanel = () => paintText()?.querySelector(".neo-gallery-gen-panel");
const editPanel = () => paintEdit()?.querySelector(".neo-gallery-gen-panel");
const modeChip = (panel) => panel.querySelector(".neo-gallery-edit-mode-select").parentElement;
const modeChipBtn = (panel) => modeChip(panel).querySelector(".neo-gallery-gm-chip-btn");
const hintOf = (panel) => panel.querySelector(".neo-gallery-story-hint").textContent;
const paintStageHost = () => document.querySelector(".ns-paint .ns-paint-stage");


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
    // 先注册替身 tab，再导入 studio-app：studio-app 首次挂载画廊时就缓存它拿到的 tab，
    // 晚注册的话本用例挂进宿主的是上一条用例那份替身（元素对不上本用例的 DOM）
    const shim = await import("../../web/studio/shim/app.js");
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");
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
    // 否则它会排在测试的点击后面，把刚切过去的绘画页又拽回素材页
    await settle();
    await settle();
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
    assert.ok(libBtn(), "绘画页模式行右端应有素材库入口");
    assert.ok(!document.querySelector(".ns-paint .ns-gallery-host"), "绘画页不应再有常驻左栏素材库");
    assert.equal(document.querySelectorAll(".ns-paint .ns-paint-mode-btn").length, 2, "右栏应有文生图 / 图片编辑两个模式按钮");
    assert.ok(gmBtn(), "进绘画页画廊单例应留在收留宿主，绘画页自己不养画廊");
    assert.ok(!overlay(), "内嵌模式不应建浮层遮罩");

    // 文生图：进页即就绪，写提示词就能生成（不必先点「生成素材」）
    const panel = textPanel();
    assert.ok(panel, "进页应铺好文生图面板");
    assert.ok(panel.querySelector(".neo-gallery-story-modal--embedded"), "内嵌面板应带内嵌标记（样式去窗壳靠它）");
    assert.ok(btnTexts(panel).includes("生成"), "idle 应有「生成」");
    assert.ok(!btnTexts(panel).includes("取消"), "页内面板不应有「取消」：收起 = 切到另一个模式");
    assert.ok(panel.querySelector(".neo-gallery-gm-quick-input"), "idle 直接给输入框：写一句就生成");
    assert.equal(panel.querySelectorAll("textarea").length, 1, "文生图只有一个提示词框：两个框会让人不知道往哪写");
    assert.ok(panel.querySelector(".neo-gallery-gm-composer-bar")?.querySelector(".neo-gallery-gm-gen-btn"), "「生成」在输入卡的控件行里");
    assert.ok(!panel.querySelector(".neo-gallery-gm-hero"), "idle 不铺空画布占位");
    assert.ok(panel.querySelector(".neo-gallery-gm-idle"), "idle 在结果区给一句起手提示（结果区在输入卡上方）");
    const bar = panel.querySelector(".neo-gallery-gm-composer-bar");
    assert.equal(bar.querySelectorAll(".neo-gallery-gm-chip-btn").length, 4, "技能 / 比例 / 最长边 / 自定参数是真 chip 按钮");
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
    assert.ok(paintStageHost().classList.contains("ns-hidden"), "空轮时舞台宿主收起，不在面板底下留一块空框");

    assert.ok(!paintText().classList.contains("ns-hidden"), "默认模式应是文生图");

    // 图片编辑：空面板同样在位，预览区就是拖放落点（拖进来才解锁各编辑模式）
    const ep = editPanel();
    assert.ok(ep, "进页应铺好图片编辑面板");
    assert.ok(ep.querySelector(".neo-gallery-story-modal--embedded"), "内嵌面板应带内嵌标记");
    assert.ok(ep.querySelector(".neo-gallery-edit-empty"), "无原图时预览区应是拖放落点");
    assert.ok(modeChipBtn(ep).disabled, "无原图时编辑模式 chip 先禁用");
    assert.ok(modeChip(ep).querySelector(".neo-gallery-gm-chip-label").textContent.trim(), "模式 chip 显示当前模式名");
    assert.match(modeChipBtn(ep).title, /先拖入原图/, "禁用态的提示说明缺的是原图");
    assert.ok(btnTexts(ep).includes("生成"), "idle 应有「生成」");
    assert.ok(!btnTexts(ep).includes("取消"), "页内面板不应有「取消」");
    assert.match(hintOf(ep), /把素材拖进预览区当原图/, "空面板说明先拖原图");
    // 编辑控件与文生图同一组：一个输入卡 + 底行 chips（技能 / 模式 / 尺寸 / 自定参数）
    const ebar = ep.querySelector(".neo-gallery-gm-composer-bar");
    assert.ok(ebar && ebar.querySelector(".neo-gallery-gm-gen-btn"), "「生成」在编辑输入卡的 chips 行里");
    assert.equal(ebar.querySelectorAll(".neo-gallery-gm-chip-btn").length, 4, "技能 / 模式 / 尺寸 / 自定参数是真 chip 按钮");
    const editParamsPanel = ebar.querySelector(".neo-gallery-gm-chip-panel");
    const visibleEditSelects = [...ebar.querySelectorAll("select")].filter((s) => !s.hidden && !editParamsPanel.contains(s));
    assert.equal(visibleEditSelects.length, 0, "编辑控件行里没有浏览器下拉框");
    assert.ok(ebar.querySelector(".neo-gallery-edit-size-chip"), "出图尺寸收成一枚 chip");
    assert.ok(editParamsPanel?.contains(ep.querySelector(".neo-gallery-edit-model-box")),
        "编辑自定参数默认不显示：面板挂在自定参数 chip 的浮层里");
    assert.ok(ep.querySelector(".neo-gallery-story-actions").children.length === 0,
        "页内 idle 操作区是空的（样式让空块不占位）");
    assert.ok(paintEdit().classList.contains("ns-hidden"), "编辑宿主应随模式收起");

    // 素材库弹窗：画廊单例挂进弹窗宿主；弹窗里的「生成素材」入口复用现成面板，提示词不被清掉
    click(libBtn());
    await settle();
    const modal = libModal();
    assert.ok(modal, "素材库按钮应打开弹窗");
    assert.ok(modal.querySelector(".neo-gallery-gm-btn"), "开弹窗应把画廊单例挂进弹窗宿主");
    assert.ok(!gmBtn(), "画廊单例一次只挂一处：素材页宿主此时应是空的");
    panel.querySelector(".neo-gallery-gm-quick-input").value = "红色陶瓷杯的白底产品图";
    click(modal.querySelector(".neo-gallery-gm-btn"));
    await settle();
    assert.equal(textPanel(), panel, "入口应复用现成面板，不重建");
    assert.equal(textPanel().querySelector(".neo-gallery-gm-quick-input").value, "红色陶瓷杯的白底产品图", "复用不能清掉已写的提示词");
    assert.equal(location.hash, "#/paint", "弹窗入口不应跳页，hash 留在绘画页");
    assert.ok(!libModal(), "入口把面板铺好后弹窗应让位给绘画页（同页 go 不触发收起）");
    click(libBtn());
    await settle();
    click(libModal().querySelector(".ns-libmodal-close"));
    await settle();
    assert.ok(!libModal(), "标题栏 ✕ 应关闭弹窗");

    await clickTab("gallery");
    assert.ok(!pageOf(galleryHost()).classList.contains("ns-hidden"), "点顶栏「素材」应回到素材页");
    assert.ok(pageOf(paintText()).classList.contains("ns-hidden"), "绘画页应收起");
    assert.ok(gmBtn(), "关弹窗离开绘画页应把画廊单例交还素材页宿主");

    click(gmBtn());
    await settle();
    assert.equal(textPanel(), panel, "素材页入口同样复用绘画页面板（面板随页面常驻）");
    assert.ok(!pageOf(paintText()).classList.contains("ns-hidden"), "点生成素材应切到绘画页");
    assert.equal(location.hash, "#/paint", "切页应走 hash，顶栏 tab 与路由同步");
    assert.ok(!overlay(), "内嵌模式不应建浮层遮罩");
});

test("绘画页：素材库弹窗单点卡片 = 取用该图进图片编辑并关窗", async () => {
    await boot();
    await clickTab("paint");
    const ep = editPanel();
    assert.ok(ep.querySelector(".neo-gallery-edit-empty"), "进页时编辑面板应是空原图状态");

    click(libBtn());
    await settle();
    assert.ok(libModal()?.contains(galleryCard()), "弹窗里应能看到素材卡片");
    click(galleryCard());
    await settle();
    assert.ok(!libModal(), "单点取用应关窗");
    assert.equal(editPanel(), ep, "取用应复用现成编辑面板，不重建");
    assert.ok(!ep.querySelector(".neo-gallery-edit-empty"), "原图到位后拖放落点应收起");
    assert.match(ep.querySelector(".neo-gallery-edit-compare-img").getAttribute("src"), /pick\.png/, "预览区应换成这张原图");
    assert.ok(!paintEdit().classList.contains("ns-hidden"), "模式应切到图片编辑");
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
    assert.ok(!modeChipBtn(ep).disabled, "原图到位应解锁编辑模式 chip");
    assert.equal(modeChip(ep).querySelectorAll("option").length, 6, "模式 chip 列全六种模式");
    assert.match(hintOf(ep), /生成结果与原图左右对比/, "有原图后说明换回编辑说明");
    assert.ok(!document.querySelector(".neo-gallery-edit-modal-overlay"), "内嵌模式不应建图片编辑浮层遮罩");
    assert.ok(!paintEdit().classList.contains("ns-hidden"), "编辑宿主应切到可见");
    assert.ok(paintText().classList.contains("ns-hidden"), "文生图宿主应随模式切换收起");
    assert.equal(location.hash, "#/paint", "绘画页内入口不应跳页");
});


