// E2E：无边框桌面端窗口的顶栏窗口控件（需 ComfyUI 运行中）。
// 用法：npm run e2e
// 浏览器里没有 pywebview 桥，控件整块不出现；这里注入一枚假桥，按桌面端的 window_state 契约喂状态。
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.COMFY_BASE_URL || "http://127.0.0.1:8188";
const STUDIO_URL = `${BASE}/neo-studio`;

let browser;
let skipReason;

test.before(async () => {
    try {
        const resp = await fetch(`${BASE}/neo_studio/version`, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (e) {
        skipReason = `ComfyUI / Neo Studio 不可达 (${BASE}): ${e.message}`;
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

// 桌面端的 js_api 契约：window_state 返回三个状态，win_* 改状态后把新状态回给前端重画
function fakeBridge(frameless) {
    const state = { frameless, maximized: false, fullscreen: false };
    window.__calls = [];
    const call = (name, next) => {
        window.__calls.push(name);
        return Promise.resolve(next ? { ...next } : state);
    };
    window.pywebview = {
        api: {
            window_state: () => Promise.resolve({ ...state }),
            win_minimize: () => call("win_minimize"),
            win_maximize: () => call("win_maximize", Object.assign(state, { maximized: !state.maximized })),
            win_fullscreen: () => call("win_fullscreen", Object.assign(state, { fullscreen: !state.fullscreen })),
            win_close: () => call("win_close"),
            win_start_drag: () => call("win_start_drag"),
        },
    };
}

async function openStudio(frameless) {
    const page = await browser.newPage();
    // 断言写的是中文文案（还原 / 退出全屏）：Playwright 的 navigator.language 是 en-US，钉住中文基线
    await page.addInitScript(() => localStorage.setItem("neo_studio_lang", "zh"));
    await page.addInitScript(fakeBridge, frameless);
    await page.goto(STUDIO_URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector(".ns-header");
    return page;
}

test("无边框桌面端窗口：顶栏出最小化 / 最大化 / 全屏 / 关闭，点击走 js_api", async (t) => {
    if (!guard(t)) return;
    const page = await openStudio(true);
    try {
        await page.waitForSelector("#ns-wctl:not([hidden])", { timeout: 10000 });
        assert.equal(await page.locator("#ns-wctl .ns-wctl-btn").count(), 4);
        assert.ok(await page.evaluate(() => document.body.classList.contains("ns-frameless")),
            "无边框要给 body 挂 ns-frameless，顶栏空白处才能拖窗");

        await page.click("#ns-win-max");
        await page.waitForFunction(() => window.__calls.includes("win_maximize"), null, { timeout: 5000 });
        assert.equal(await page.getAttribute("#ns-win-max", "title"), "还原", "最大化后按钮变还原");
        assert.equal((await page.textContent("#ns-win-max")).trim(), "");

        await page.click("#ns-win-fs");
        await page.waitForFunction(() => window.__calls.includes("win_fullscreen"), null, { timeout: 5000 });
        assert.equal(await page.getAttribute("#ns-win-fs", "title"), "退出全屏");

        // 顶栏空白处按下交给桌面端拖动；点在链接 / 按钮上不抢窗口拖动
        // 取窗口控件右侧那段真空白：顶栏内容宽度会变，写死坐标会点到窗口按钮上
        const blank = await page.evaluate(() => {
            const h = document.querySelector(".ns-header").getBoundingClientRect();
            const w = document.getElementById("ns-wctl").getBoundingClientRect();
            return { x: Math.round(w.right + 40), y: Math.round(h.top + h.height / 2) };
        });
        const callsBefore = await page.evaluate(() => window.__calls.length);
        await page.mouse.move(blank.x, blank.y);
        await page.mouse.down();
        await page.mouse.up();
        const drag = await page.evaluate((n) => window.__calls.slice(n), callsBefore);
        assert.deepEqual(drag, ["win_start_drag"], "顶栏空白处按下应只发一次窗口拖动");
        const tabCalls = await page.evaluate(() => window.__calls.length);
        await page.click(".ns-tabs a[data-tab='director']");
        assert.equal(await page.evaluate(() => window.__calls.filter((c) => c === "win_start_drag").length), 1,
            "点标签链接不应触发窗口拖动");
        assert.ok(tabCalls >= 0);

        await page.click("#ns-win-close");
        await page.waitForFunction(() => window.__calls.includes("win_close"), null, { timeout: 5000 });
    } finally {
        await page.close();
    }
});

test("有系统标题栏时顶栏不出窗口控件", async (t) => {
    if (!guard(t)) return;
    const page = await openStudio(false);
    try {
        await page.waitForFunction(() => document.getElementById("ns-wctl").hidden, null, { timeout: 10000 });
        assert.ok(!(await page.evaluate(() => document.body.classList.contains("ns-frameless"))));
    } finally {
        await page.close();
    }
});
