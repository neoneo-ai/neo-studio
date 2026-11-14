// 素材库 / 配方弹窗外壳的窗体行为：默认尺寸开、最大化铺满、拖标题栏转浮窗、右缘调宽，
// 摆位与最大化状态都要落盘（js/core/lib-modal.js）。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, click, window } from "./setup.mjs";

// lib-modal.js 顶层导入 scripts/ui.js，必须等 setup.mjs 装好 shim 钩子再动态取
const { createLibraryModal } = await import("../../web/js/core/lib-modal.js");

const KEY = "neo_test_libmodal_geo";
const geo = () => JSON.parse(localStorage.getItem(KEY) || "{}");
const pt = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });

// 本文件通篇是窗体几何：视口钉在 1920×1200（jsdom 默认的 1024×768 装不下用例里那口 1180×860 的盒子，
// 夹紧要按视口算，视口就得是真实桌面窗口的量级）
Object.defineProperty(window, "innerWidth", { value: 1920, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 1200, configurable: true });

function makeModal() {
    const m = createLibraryModal({ storageKey: KEY, scope: "assets" });
    document.body.appendChild(m.el);
    return m;
}


test("弹窗窗体：默认开 → 最大化铺满并落盘 → 重开照旧铺满", () => {
    resetEnv();
    localStorage.removeItem(KEY);
    const m = makeModal();
    m.open("素材库");
    assert.equal(m.el.dataset.libScope, "assets", "弹窗带 data-lib-scope，页面按它定位这扇窗");
    assert.equal(geo().max, false, "首次打开记为非最大化");
    assert.ok(!m.el.classList.contains("ns-libmodal-maximized"), "默认不铺满");
    click(m.el.querySelector(".ns-libmodal-max"));
    assert.ok(m.el.classList.contains("ns-libmodal-maximized"), "最大化铺满整窗");
    assert.equal(geo().max, true, "最大化状态落盘");
    m.close();
    m.open("素材库");
    assert.ok(m.el.classList.contains("ns-libmodal-maximized"), "重开照旧铺满整窗");
});

test("弹窗窗体：拖标题栏转浮窗，摆位落盘，max 偏好不动", () => {
    resetEnv();
    localStorage.removeItem(KEY);
    const m = makeModal();
    m.open("素材库");
    const box = m.el.querySelector(".ns-libmodal-box");
    box.__rect = { x: 40, y: 20, left: 40, top: 20, right: 1220, bottom: 880, width: 1180, height: 860 };
    const head = m.el.querySelector(".ns-libmodal-titlebar");
    head.dispatchEvent(pt("pointerdown", 100, 30));
    head.dispatchEvent(pt("pointermove", 190, 110));
    head.dispatchEvent(pt("pointerup", 190, 110));
    assert.ok(m.el.classList.contains("ns-libmodal-floated"), "拖过标题栏后是浮窗");
    const g = geo();
    assert.equal(g.x, 130, "left 落盘");
    assert.equal(g.y, 100, "top 落盘");
    assert.equal(g.w, 1180, "拖窗不改尺寸");
    assert.equal(g.max, false, "没点最大化不落 max");
});

test("弹窗窗体：右缘调整条调宽，下限 640px", () => {
    resetEnv();
    localStorage.removeItem(KEY);
    const m = makeModal();
    m.open("素材库");
    const box = m.el.querySelector(".ns-libmodal-box");
    box.__rect = { x: 0, y: 0, left: 0, top: 0, right: 1180, bottom: 860, width: 1180, height: 860 };
    const rz = m.el.querySelector(".ns-libmodal-resize");
    rz.dispatchEvent(pt("pointerdown", 1180, 400));
    rz.dispatchEvent(pt("pointermove", 300, 400));
    rz.dispatchEvent(pt("pointerup", 300, 400));
    assert.equal(box.style.width, "640px", `收到底只剩下限：${box.style.width}`);
    rz.dispatchEvent(pt("pointerdown", 1180, 400));
    rz.dispatchEvent(pt("pointermove", 900, 400));
    rz.dispatchEvent(pt("pointerup", 900, 400));
    assert.equal(box.style.width, "900px", "拖宽写进盒子里");
    assert.equal(geo().w, 900, "宽度落盘");
});

test("弹窗窗体：Esc 关掉，遮罩空白点掉", () => {
    resetEnv();
    localStorage.removeItem(KEY);
    const m = makeModal();
    m.open("素材库");
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.ok(m.el.classList.contains("ns-hidden"), "Esc 关窗");
    m.open("素材库");
    m.el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.ok(m.el.classList.contains("ns-hidden"), "点遮罩空白关窗");
});


// 拖动 / 调宽的收尾：松手那一发按鼠标所在位置派发。真实拖动里鼠标几乎必然已经离开起点那条
// 标题栏 / 调宽条 —— 只认起点元素的旧实现收不到它，手势永不结束，窗体就一直跟鼠标跑
test("弹窗窗体：拖窗松手在内容区也收尾，之后鼠标移动不再带着窗跑", () => {
    resetEnv();
    localStorage.removeItem(KEY);
    const m = makeModal();
    m.open("素材库");
    const box = m.el.querySelector(".ns-libmodal-box");
    box.__rect = { x: 40, y: 20, left: 40, top: 20, right: 1220, bottom: 880, width: 1180, height: 860 };
    const head = m.el.querySelector(".ns-libmodal-titlebar");
    const content = m.el.querySelector(".ns-libmodal-content");
    head.dispatchEvent(pt("pointerdown", 100, 30));
    head.dispatchEvent(pt("pointermove", 160, 90));
    content.dispatchEvent(pt("pointerup", 500, 400));   // 松手点在内容区
    const left = box.style.left;
    assert.equal(left, "100px", "拖过之后落在新摆位");
    head.dispatchEvent(pt("pointermove", 900, 500));   // 松手后光标再扫过标题栏（没按键）
    assert.equal(box.style.left, left, "松手后鼠标移动不再带着窗跑");
    assert.equal(geo().x, 100, "收尾时落盘");
});

test("弹窗窗体：调宽松手在调整条外也收尾，宽度不再跟鼠标", () => {
    resetEnv();
    localStorage.removeItem(KEY);
    const m = makeModal();
    m.open("素材库");
    const box = m.el.querySelector(".ns-libmodal-box");
    box.__rect = { x: 0, y: 0, left: 0, top: 0, right: 1180, bottom: 860, width: 1180, height: 860 };
    const rz = m.el.querySelector(".ns-libmodal-resize");
    const content = m.el.querySelector(".ns-libmodal-content");
    rz.dispatchEvent(pt("pointerdown", 1180, 400));
    rz.dispatchEvent(pt("pointermove", 1000, 400));
    content.dispatchEvent(pt("pointerup", 600, 500));
    const width = box.style.width;
    assert.equal(width, "1000px", "拖宽写进盒子里");
    rz.dispatchEvent(pt("pointermove", 300, 500));   // 松手后光标再扫过调宽条（没按键）
    assert.equal(box.style.width, width, "松手后鼠标移动不再改宽度");
    assert.equal(geo().w, 1000, "收尾时落盘");
});

test("弹窗窗体：拖到一半按 Esc 关窗，重开不带着鼠标跑", () => {
    resetEnv();
    localStorage.removeItem(KEY);
    const m = makeModal();
    m.open("素材库");
    const box = m.el.querySelector(".ns-libmodal-box");
    box.__rect = { x: 40, y: 20, left: 40, top: 20, right: 1220, bottom: 880, width: 1180, height: 860 };
    const head = m.el.querySelector(".ns-libmodal-titlebar");
    head.dispatchEvent(pt("pointerdown", 100, 30));
    head.dispatchEvent(pt("pointermove", 400, 300));
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.ok(m.el.classList.contains("ns-hidden"), "拖到一半 Esc 关窗");
    m.open("素材库");
    const left = box.style.left;
    window.dispatchEvent(pt("pointermove", 900, 700));
    assert.equal(box.style.left, left, "重开后鼠标移动不带着窗跑");
});

// 视口夹紧（fitGeo）：落盘的摆位来自上一扇更大的窗（换过分辨率、之前在带外框的桌面窗里拖宽过）时，
// 盒子比视口还宽、顶边掉到视口外，标题栏右端那排 ✕ 就在屏幕上够不着 —— 开窗这一发就得夹回来
test("弹窗窗体：越界摆位开窗即夹进视口，✕ 那排钮回到窗内", () => {
    resetEnv();
    localStorage.setItem(KEY, JSON.stringify({ x: 0, y: 60, w: 1780, h: 1420, max: false, float: true }));
    const m = makeModal();
    m.open("素材库");
    const box = m.el.querySelector(".ns-libmodal-box");
    assert.ok(m.el.classList.contains("ns-libmodal-floated"), "存档是浮窗摆位就按浮窗开");
    assert.equal(box.style.width, "1780px", "宽度在视口里合法就不动");
    assert.equal(box.style.height, "1200px", `高度收进视口：${box.style.height}`);
    assert.equal(box.style.top, "0px", "底边要出界就把顶边钳回 0");
    const g = geo();
    assert.equal(g.h, 1200, "夹过的值落盘，下次开就是干净摆位");
    assert.ok(g.x + g.w <= 1920 && g.y + g.h <= 1200, `整盒不出界，标题栏右端的 ✕ 就在窗内：${JSON.stringify(g)}`);
});

test("弹窗窗体：拖出屏幕外被钳回，摆位停在视口内", () => {
    resetEnv();
    localStorage.removeItem(KEY);
    const m = makeModal();
    m.open("素材库");
    const box = m.el.querySelector(".ns-libmodal-box");
    box.__rect = { x: 40, y: 20, left: 40, top: 20, right: 1220, bottom: 880, width: 1180, height: 860 };
    const head = m.el.querySelector(".ns-libmodal-titlebar");
    head.dispatchEvent(pt("pointerdown", 100, 30));
    head.dispatchEvent(pt("pointermove", 1400, 1000));
    head.dispatchEvent(pt("pointerup", 1400, 1000));
    assert.equal(box.style.left, "740px", `右缘顶到视口边上就停：${box.style.left}`);
    assert.equal(box.style.top, "340px", `底边顶到视口边上就停：${box.style.top}`);
    assert.equal(geo().x, 740, "钳过的 left 落盘");
});

test("弹窗窗体：铺满整窗时拖窗，先还原成上一次的浮窗摆位再挪", () => {
    resetEnv();
    localStorage.removeItem(KEY);
    const m = makeModal();
    m.open("素材库");
    const box = m.el.querySelector(".ns-libmodal-box");
    const head = m.el.querySelector(".ns-libmodal-titlebar");
    // 先拖出一段浮窗摆位（1180×860 落在 130,100），它是「上一次浮窗」的基线
    box.__rect = { x: 40, y: 20, left: 40, top: 20, right: 1220, bottom: 880, width: 1180, height: 860 };
    head.dispatchEvent(pt("pointerdown", 100, 30));
    head.dispatchEvent(pt("pointermove", 190, 110));
    head.dispatchEvent(pt("pointerup", 190, 110));
    assert.equal(geo().x, 130, "基线摆位落盘");
    // 铺满整窗后拖窗：这一档正好等于视口，钳位会把它钉在 0,0 —— 不还原的话「拖一下变浮窗」就成「拖了拖不动」
    click(m.el.querySelector(".ns-libmodal-max"));
    assert.ok(m.el.classList.contains("ns-libmodal-maximized"), "铺满整窗");
    box.__rect = { x: 0, y: 0, left: 0, top: 0, right: 1920, bottom: 1200, width: 1920, height: 1200 };
    head.dispatchEvent(pt("pointerdown", 100, 30));
    head.dispatchEvent(pt("pointermove", 180, 90));
    head.dispatchEvent(pt("pointerup", 180, 90));
    assert.ok(m.el.classList.contains("ns-libmodal-floated"), "铺满的窗拖一下就是浮窗");
    assert.equal(box.style.width, "1180px", `交还上一次浮窗宽度而不是整屏宽：${box.style.width}`);
    assert.equal(geo().x, 210, "从上一次浮窗摆位起算位移");
    assert.equal(geo().y, 160, "顶边同样从上一次摆位起算");
    assert.equal(geo().max, true, "max 偏好不动，下次开照旧铺满");
});

