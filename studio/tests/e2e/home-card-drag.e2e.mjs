// E2E：首页编辑态的卡片落位（vendored Sortable 的手势）。jsdom 没有 layout，让位与落点只能在真浏览器里验。
// 需 ComfyUI 运行中。用法：npm run e2e
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.COMFY_BASE_URL || "http://127.0.0.1:8188";
const STUDIO_URL = `${BASE}/neo-studio`;

let browser;
let skipReason;

test.before(async () => {
    try {
        const resp = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (e) {
        skipReason = `ComfyUI 不可达 (${BASE}): ${e.message}`;
        return;
    }
    browser = await chromium.launch({ headless: true });
});

test.after(async () => {
    if (browser) await browser.close();
});

function guard(t) {
    if (!browser) { t.skip(skipReason || "前置条件不满足"); return false; }
    return true;
}

// 断言写的是中文文案：Playwright 的 navigator.language 是 en-US，不钉住语言页面会跑成英文界面
const pinZh = (page) => page.addInitScript(() => localStorage.setItem("neo_studio_lang", "zh"));

/** 「开始创作」那一条网格里的卡片标题序（首条网格就是它：三个板块按注册表序出） */
const orderOf = (page) => page.evaluate(() =>
    [...(document.querySelectorAll(".ns-home-grid")[0]?.querySelectorAll(".ns-home-card") || [])]
        .map((el) => el.querySelector(".ns-home-card-title")?.textContent || ""));

/** 首条网格里第 n 张卡的中心 */
const cardCenter = (page, n) => page
    .locator(".ns-home-grid").first().locator(".ns-home-card").nth(n).boundingBox()
    .then((b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }));

test("首页编辑态：鼠标把第一张卡拖到第三张那一格，卡片当场让位、落位后顺序生效", async (t) => {
    if (!guard(t)) return;
    const page = await browser.newPage();
    await pinZh(page);
    try {
        await page.goto(STUDIO_URL, { waitUntil: "networkidle", timeout: 30000 });
        await page.evaluate(() => { location.hash = "#/home"; });
        await page.waitForSelector(".ns-home .ns-home-card", { timeout: 15000 });
        await page.click(".ns-home-edit-entry");
        await page.waitForSelector(".ns-home-editing", { timeout: 15000 });
        // 进编辑态后应用还会异步重画一次首页（设置与版式那几发拉完才铺定）：等这一轮落定、网格上的
        // Sortable 实例就位再落手。落在被换掉的实例上只认得「拖起来」，认不出落点——拖得起、落不下。
        await page.waitForFunction(() => {
            const g = document.querySelector(".ns-home-grid");
            return !!(window.Sortable && window.Sortable.get && window.Sortable.get(g));
        }, null, { timeout: 10000 });
        await page.waitForTimeout(600);

        const before = await orderOf(page);
        assert.deepEqual(before.slice(0, 3), ["生成图片", "生成视频", "导演视频"], "默认版式「开始创作」前三张");

        const { x: x0, y: y0 } = await cardCenter(page, 0);
        const { x: x1, y: y1 } = await cardCenter(page, 2);
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let i = 1; i <= 14; i++) {
            await page.mouse.move(x0 + (x1 - x0) * i / 14, y0 + (y1 - y0) * i / 14);
            await page.waitForTimeout(16);
        }
        assert.equal(await page.locator(".ns-home-card.is-dragging").count(), 1,
            "拖动中指针上那张卡带着 dragClass");
        const mid = await page.evaluate(() => {
            const fb = document.querySelector(".sortable-fallback");
            const r = fb?.getBoundingClientRect();
            return { clone: !!fb, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 };
        });
        assert.ok(mid.clone && mid.w > 0 && mid.h > 0,
            "forceFallback 的影子克隆挂在页上：让位动画与跟指针的那张卡都由 Sortable 排");

        await page.mouse.up();
        await page.waitForTimeout(240);
        const after = await orderOf(page);
        assert.deepEqual(after.slice(0, 3), ["生成视频", "导演视频", "生成图片"],
            "落在第三张那一格就占住它的位置，其余卡往后挪一格");
        assert.equal(after.length, before.length, "落位不吞卡：卡片张数不变");
        assert.equal(await page.locator(".ns-home-card.is-dragging, .ns-home-card.is-drag-ghost").count(), 0,
            "落位收口：拖动标记与影子不留在页面上");

        // 弃草稿退出：这条 e2e 不动用户已落盘的版式（编辑态是同一个元素上的类，等它摘掉）
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector(".ns-home-editing"), null, { timeout: 10000 });
    } finally {
        await page.close();
    }
});