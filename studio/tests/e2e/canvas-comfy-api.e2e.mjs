// E2E：ComfyUI 画布页上的扩展装配（需 ComfyUI 运行中）。
// 用法：npm run e2e
// 前置：ComfyUI 在 http://127.0.0.1:8188/ 运行且已加载 Neo Studio 插件。
// jsdom 覆盖不到这一发：本插件的模块被画布页 import 之后，官方 comfyAPI 装配与全部插件注册还在不在。
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.COMFY_BASE_URL || "http://127.0.0.1:8188";

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

// 独立页的 shim 形状带 canvas 键，官方装配不带：canvas 出现在画布页上就是被整份换掉的形态。
test("画布页上官方 comfyAPI 与 Neo Studio 扩展注册同时成立", async (t) => {
    if (!guard(t)) return;
    const page = await browser.newPage();
    const broken = [];
    page.on("console", (msg) => { if (msg.text().includes("registerExtension")) broken.push(msg.text()); });
    page.on("pageerror", (e) => broken.push(e.message));
    try {
        await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
        assert.ok(await page.evaluate(() => !!window.comfyAPI?.app?.app),
            "画布页必须装配出 comfyAPI.app.app——全部插件的注册入口");
        assert.ok(!(await page.evaluate(() => !!window.comfyAPI?.canvas)),
            "画布页上的 comfyAPI 是独立页 shim 的形状，官方装配被整份换掉了");
        // 侧栏 tab 的可见形态就是侧栏上那两枚钮：这版前端的 extensionManager 是 Pinia store，没有
        // sidebarTabs 可取，注册落点只在 DOM。扩展的 init() 晚于模块图，所以等它出现，等不到才是断了。
        // 返回 undefined 才算「还没好」——空数组是真值，会让 waitForFunction 立刻放行。
        const tabs = await page.waitForFunction(
            () => {
                const labels = [...document.querySelectorAll('button[aria-label^="Neo"]')]
                    .map((b) => b.getAttribute("aria-label"));
                return labels.length >= 2 ? labels : undefined;
            },
            null, { timeout: 60000 },
        ).then((h) => h.jsonValue());

        assert.ok(tabs.length >= 2, `Neo Studio 的侧栏 tab 要出现在画布页上（实得 ${JSON.stringify(tabs)}）`);

        assert.deepEqual(broken, [], "画布页不许留下注册失败的报错");
    } finally {
        await page.close();
    }
});

