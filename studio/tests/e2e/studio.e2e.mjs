// E2E：Neo Studio 独立页面（需 ComfyUI 运行中）。
// 用法：npm run e2e
// 前置：ComfyUI 在 http://127.0.0.1:8188/ 运行且已加载 Neo Studio 插件。
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

// 断言写的是中文文案：Playwright 的 navigator.language 是 en-US，不钉住语言页面会跑成英文界面
const pinZh = (page) => page.addInitScript(() => localStorage.setItem("neo_studio_lang", "zh"));

// 顶栏标题回首页：站内跳到默认素材页，不离开 Studio
test("Studio 顶栏标题点击后回首页", async (t) => {
    if (!guard(t)) return;
    const page = await browser.newPage();
    await pinZh(page);
    try {
        await page.goto(STUDIO_URL, { waitUntil: "networkidle", timeout: 30000 });
        await page.evaluate(() => { location.hash = "#/director"; });
        await page.click(".ns-logo");
        await page.waitForFunction(() => location.hash === "#/home", null, { timeout: 15000 });
        assert.ok(page.url().includes("neo-studio"), `回首页不应离开 Studio（${page.url()}）`);
    } finally {
        await page.close();
    }
});

test("Studio 页面：四视图加载、版本信息、导演生成面板", async (t) => {
    if (!guard(t)) return;
    const page = await browser.newPage();
    await pinZh(page);
    try {
        await page.goto(STUDIO_URL, { waitUntil: "networkidle", timeout: 30000 });

        // 版本号不在顶栏（只在下面设置「关于」里查）
        assert.equal(await page.locator("#ns-version").count(), 0, "顶栏不应再显示版本号");

        // 落地页从首页进素材页，NeoGallery 挂载（首配方自动选中会打开编辑器跳导演页，落地不断言，显式导航）
        await page.evaluate(() => { location.hash = "#/home"; });
        await page.waitForSelector(".ns-home .ns-home-card", { timeout: 15000 });
        await page.evaluate(() => { location.hash = "#/gallery"; });
        await page.waitForSelector("#ns-view .neo-gallery-panel", { timeout: 15000 });

        // 导演视图：整片生成面板 + 配方面板
        await page.evaluate(() => { location.hash = "#/director"; });
        await page.waitForSelector(".ns-gen-panel .rs-btn.ns-gen-run", { timeout: 15000 });
        await page.waitForSelector(".neo-recipes-panel", { timeout: 15000 });
        // .rs-btn 基础样式 flex:1；满幅主区里不应拉伸成长条
        const runFlex = await page.evaluate(() =>
            getComputedStyle(document.querySelector(".ns-gen-panel .rs-btn.ns-gen-run")).flexGrow);
        assert.equal(runFlex, "0", "生成整片按钮不应被 flex 拉伸");
        // 导演页 = 左配方列表 + 右主栏（上导演编辑器 / 分隔条 / 下整片生成面板）
        const layout = await page.evaluate(() => {
            const cs = (s) => getComputedStyle(document.querySelector(s));
            return {
                page: cs(".ns-director").gridTemplateColumns,
                list: cs(".ns-director .neo-recipes-list").gridTemplateColumns,
                main: cs(".ns-director-main").flexDirection,
                editor: !!document.querySelector(".ns-director-editor"),
                split: !!document.querySelector(".ns-director-split"),
            };
        });
        assert.match(layout.page, /^360px /, "导演页应为左配方列表 + 右主栏两列");
        assert.ok(!layout.list.includes("px "), "左栏配方列表单列排布");
        assert.equal(layout.main, "column", "右主栏上下排布（编辑器在上、生成面板在下）");
        assert.ok(layout.editor, "右上编辑器宿主就位");
        assert.ok(layout.split, "编辑器与生成面板之间有分隔条");

        // 首个配方自动选中：对应卡片高亮，分段格子按 director_spec 分段刷出，尺寸/步数只读回显（参数在编辑器里）
        const spec = await page.evaluate(async () => {
            const v = await (await fetch("/neo_studio/version")).json();
            const name = (v.recipes || [])[0];
            if (!name) return null;
            const s = await (await fetch(`/rs_recipes/director_spec?name=${encodeURIComponent(name)}`)).json();
            return { name, defaults: s.defaults, segments: (s.segments || []).length };
        });
        if (spec) {
            const selectedName = await page.evaluate(() =>
                document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span")?.textContent);
            assert.equal(selectedName, spec.name, "首个配方应被自动选中");
            await page.waitForFunction((d) =>
                document.querySelectorAll(".ns-gen-seg-chip").length === d.segments
                && document.querySelector(".ns-gen-spec").textContent.includes(`${d.width}×${d.height}`)
                && document.querySelector(".ns-gen-spec").textContent.includes(`${d.steps} 步`),
            { ...spec.defaults, segments: spec.segments }, { timeout: 5000 });
            // 控制行压成一行：分段格子与控制项同占一行、生成按钮贴行右端，整行只占一行高（竖向空间留给结果区）
            // （勾选条没内容时是零高度空盒，Playwright 视作不可见，只能等格子出来再量）
            const line = await page.evaluate(() => {
                const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom }; };
                return { row: box(".ns-gen-panel .ns-gen-row"), segs: box(".ns-gen-segs"), btn: box(".ns-gen-panel .ns-gen-run-group") };
            });
            assert.ok(line.segs.top >= line.row.top - 1 && line.segs.bottom <= line.row.bottom + 1,
                `分段格子与控制项同一行（格子 ${Math.round(line.segs.top)}-${Math.round(line.segs.bottom)}，行 ${Math.round(line.row.top)}-${Math.round(line.row.bottom)}）`);
            assert.ok(line.row.bottom - line.row.top <= 40, `控制行只占一行（实测 ${Math.round(line.row.bottom - line.row.top)}px）`);
            assert.ok(Math.abs(line.btn.right - line.row.right) <= 1, `生成按钮贴行右端（差 ${Math.round(line.btn.right - line.row.right)}px）`);
            // 生成面板不再带参数控件：分辨率 / 步数 / 种子都在导演编辑器里
            assert.equal(await page.locator(".ns-gen-panel input").count(), 0, "生成面板不应有参数输入控件");

            // 点另一张卡片 → 高亮切换（选中直接喂生成区，不再用顶部下拉）
            const cardCount = await page.locator(".neo-recipes-card").count();
            if (cardCount >= 2) {
                await page.evaluate(() => {
                    const cards = [...document.querySelectorAll(".neo-recipes-card")];
                    cards.find(c => !c.classList.contains("neo-recipes-card-selected")).click();
                });
                await page.waitForFunction((first) => {
                    const sel = document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span");
                    return sel && sel.textContent !== first;
                }, spec.name, { timeout: 5000 });
            }
        }

        // 技能视图：统一技能管理直接挂满主区（无弹窗外壳，无 ✕ / 无「从画布」）
        await page.evaluate(() => { location.hash = "#/skills"; });
        await page.waitForSelector(".ns-skills .rs-skill-manager", { timeout: 15000 });
        await page.waitForSelector(".ns-skills .rs-skill-picker-item", { timeout: 15000 });
        assert.equal(await page.locator(".ns-skills .rs-skill-manager-head .rs-skill-modal-close").count(), 0, "技能页不应有 ✕");
        const footerBtns = await page.locator(".ns-skills .rs-skill-footer-btn").allTextContents();
        assert.ok(!footerBtns.some((t) => t.includes("从画布")), "技能页不应有「从画布」按钮");

        // 设置视图：默认停在 LLM tab，切到生图 tab 后表单（.rs-gen-settings）才可见
        await page.evaluate(() => { location.hash = "#/settings"; });
        await page.waitForSelector(".ns-settings-section .rs-btn, .ns-settings-section button", { timeout: 15000 });
        // 浏览器里没有桌面端桥，启动设置那一栏是异步摘掉的：等它摘完再数，否则数到 7
        await page.waitForFunction(() => !document.querySelector('[data-key="launch"]'), null, { timeout: 10000 });
        const sections = await page.locator(".ns-settings-section").count();
        assert.equal(sections, 6);
        // 版本号只在设置「关于」里显示
        assert.match(await page.textContent("#ns-about-version"), /Neo Studio .+ · ComfyUI .+/);
        await page.click(".ns-settings-tab[data-key='gen']");
        await page.waitForSelector(".ns-settings .rs-gen-settings", { timeout: 15000 });
        assert.equal(await page.locator(".ns-settings .rs-gen-settings").count(), 2);
        assert.ok(!((await page.locator(".ns-settings").textContent()) || "").includes("[object Object]"));

        // 日志 tab：轮询 /neo_studio/log 渲染 ComfyUI 控制台，ANSI 色码应被剥掉
        await page.click(".ns-settings-tab[data-key='log']");
        await page.waitForFunction(() => document.querySelector(".ns-log").textContent.trim().length > 0,
            null, { timeout: 15000 });
        assert.ok(!(await page.locator(".ns-log").textContent()).includes("\x1b["), "日志不应带 ANSI 色码");

        // 手动往上翻看时，2 秒轮询不应把滚动条拉回底部
        await page.evaluate(() => { document.querySelector(".ns-log").scrollTop = 0; });
        await page.waitForTimeout(2500);
        assert.ok((await page.evaluate(() => document.querySelector(".ns-log").scrollTop)) < 40,
            "翻看时不应被轮询拉回底部");

        // 切回素材：视图缓存保留
        await page.evaluate(() => { location.hash = "#/gallery"; });
        await page.waitForTimeout(300);
        assert.ok(await page.locator("#ns-view .neo-gallery-panel").count(), "切回后 gallery 应保留");
    } finally {
        await page.close();
    }
});

test("Studio 绘画页：左素材库 + 右模式条，文生图铺满右栏", async (t) => {
    if (!guard(t)) return;
    const page = await browser.newPage();
    await pinZh(page);
    try {
        await page.goto(STUDIO_URL, { waitUntil: "networkidle", timeout: 30000 });
        await page.evaluate(() => { location.hash = "#/paint"; });
        await page.waitForSelector(".ns-paint .ns-paint-mode-btn", { timeout: 15000 });
        await page.waitForSelector(".ns-paint .ns-gallery-host .neo-gallery-topbar", { timeout: 15000 });

        const layout = await page.evaluate(() => {
            const cs = (s) => getComputedStyle(document.querySelector(s));
            const box = (s) => document.querySelector(s).getBoundingClientRect();
            return {
                page: cs(".ns-paint").gridTemplateColumns,
                modes: [...document.querySelectorAll(".ns-paint-mode-btn")].map((b) => b.textContent),
                main: box(".ns-paint-main"),
                panel: box(".ns-paint-text"),
                editHidden: cs(".ns-paint-edit").display,
                lib: !!document.querySelector(".ns-paint .ns-gallery-host .neo-gallery-topbar"),
                recipes: !!document.querySelector(".ns-paint-recipes"),
                split: !!document.querySelector(".ns-paint-side + .ns-director-colsplit"),
            };
        });
        assert.match(layout.page, /^380px /, "绘画页应为左素材库 + 右主栏两列");
        assert.deepEqual(layout.modes, ["文生图", "图片编辑"], "模式条两枚按钮");
        assert.equal(layout.editHidden, "none", "默认图片编辑收起（一次只铺满一块）");
        assert.ok(Math.abs(layout.panel.width - layout.main.width) <= 1, "文生图铺满右栏宽度");
        assert.ok(layout.panel.height > layout.main.height * 0.8, "文生图铺满右栏高度");
        assert.ok(layout.lib, "左栏素材库就位（与素材页同一个画廊）");
        assert.ok(!layout.recipes, "绘画页不再有图片配方列表");
        assert.ok(layout.split, "左栏与右栏之间有分隔条");

        // 进页即就绪：文生图可直接写提示词，图片编辑铺着空面板等拖图（都不必先点入口）
        const eager = await page.evaluate(() => {
            const vis = (s) => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== "none"; };
            return {
                textPanel: vis(".ns-paint-text .neo-gallery-gen-panel"),
                textBtns: [...document.querySelectorAll(".ns-paint-text .neo-gallery-story-btn")].map((b) => b.textContent.trim()),
                editPanel: !!document.querySelector(".ns-paint-edit .neo-gallery-gen-panel"),
                editEmpty: !!document.querySelector(".ns-paint-edit .neo-gallery-edit-empty"),
                overlays: document.querySelectorAll(".neo-gallery-story-modal-overlay").length,
            };
        });
        assert.ok(eager.textPanel, "进页就铺好文生图面板：不必先点「生成素材」");
        assert.ok(eager.textBtns.includes("生成") && !eager.textBtns.includes("取消"), "页内面板只有「生成」，没有「取消」");
        assert.ok(eager.editPanel, "进页就铺好图片编辑面板：不必先进图片卡菜单");
        assert.ok(eager.editEmpty, "无原图时预览区是拖放落点（从左栏拖图进来即可）");
        assert.equal(eager.overlays, 0, "页内面板不建浮层遮罩");

        // 切到图片编辑：编辑铺满、文生图收起，偏好落盘
        await page.click(".ns-paint-mode-btn:has-text('图片编辑')");
        await page.waitForFunction(() => getComputedStyle(document.querySelector(".ns-paint-edit")).display !== "none",
            null, { timeout: 5000 });
        const after = await page.evaluate(() => ({
            mode: localStorage.getItem("neo_studio_paint_mode"),
            textHidden: getComputedStyle(document.querySelector(".ns-paint-text")).display,
            on: document.querySelector(".ns-paint-mode-on")?.textContent,
            w: document.querySelector(".ns-paint-edit").getBoundingClientRect().width,
            main: document.querySelector(".ns-paint-main").getBoundingClientRect().width,
        }));
        assert.equal(after.mode, "edit", "模式偏好落盘");
        assert.equal(after.textHidden, "none", "文生图收起");
        assert.ok(after.on.includes("图片编辑"), "模式条高亮切到的一边");
        assert.ok(Math.abs(after.w - after.main) <= 1, "图片编辑同样铺满右栏");

        // 拖到最窄 = 收起左栏：素材库不占宽，右栏吃满，分隔条上的三点抓手还在（靠它拖回来）
        const sp = await page.locator(".ns-paint-side + .ns-director-colsplit").boundingBox();
        await page.mouse.move(sp.x + 9, sp.y + 80);
        await page.mouse.down();
        await page.mouse.move(sp.x - 300, sp.y + 80, { steps: 10 });
        await page.mouse.up();
        // grid 列宽有 .16s 过渡，等它落到收起那一格再量
        await page.waitForFunction(() => document.querySelector(".ns-paint").classList.contains("ns-side-collapsed")
            && document.querySelector(".ns-paint-main").getBoundingClientRect().width > 700, null, { timeout: 5000 });
        const closed = await page.evaluate(() => ({
            side: document.querySelector(".ns-paint-side").getBoundingClientRect().width,
            main: document.querySelector(".ns-paint-main").getBoundingClientRect().width,
            grip: getComputedStyle(document.querySelector(".ns-paint-side + .ns-director-colsplit"), "::before").opacity,
        }));
        assert.equal(closed.side, 0, "收起后左栏不占宽");
        assert.ok(closed.main > 700, "收起后右栏吃满整幅");
        assert.equal(closed.grip, "1", "收起后分隔条上的三点抓手常驻");

        // 双击展开：左栏回到存下来的宽度
        await page.dblclick(".ns-paint-side + .ns-director-colsplit");
        await page.waitForFunction(() => !document.querySelector(".ns-paint").classList.contains("ns-side-collapsed")
            && document.querySelector(".ns-paint-side").getBoundingClientRect().width >= 340, null, { timeout: 5000 });
        const back = await page.evaluate(() => ({
            side: document.querySelector(".ns-paint-side").getBoundingClientRect().width,
            pref: JSON.parse(localStorage.getItem("neo_studio_paint_side_col") || "{}"),
        }));
        assert.ok(back.side >= 340, `展开回到左栏宽度（${back.side}）`);
        assert.equal(back.pref.side_closed, false, "展开状态落盘");
        await page.evaluate(() => localStorage.removeItem("neo_studio_paint_side_col"));
    } finally {
        await page.close();
    }
});

test("Studio 绘画页：素材页「生成素材」→ 绘画页 → 回素材页 → 再点生成素材", async (t) => {
    if (!guard(t)) return;
    const page = await browser.newPage();
    await pinZh(page);
    try {
        await page.goto(STUDIO_URL, { waitUntil: "networkidle", timeout: 30000 });
        await page.evaluate(() => { location.hash = "#/gallery"; });
        await page.waitForSelector(".neo-gallery-gm-btn", { timeout: 15000 });

        // 第一次：素材页顶栏「生成素材」→ 面板铺进绘画页并切到绘画页
        await page.click(".neo-gallery-gm-btn");
        await page.waitForSelector(".ns-paint:not(.ns-hidden) .ns-paint-text .neo-gallery-gen-panel", { timeout: 15000 });
        assert.equal(await page.evaluate(() => location.hash), "#/paint", "切页走 hash：顶栏 tab 与路由同步（hash 停在素材页时点「素材」不触发 hashchange）");

        // 回素材页
        await page.click('.ns-tabs a[data-tab="gallery"]');
        await page.waitForSelector(".ns-page:not(.ns-hidden) .neo-gallery-gm-btn", { timeout: 15000 });

        // 第二次：同一个入口照旧生效（曾经点了没反应）
        await page.click(".neo-gallery-gm-btn");
        await page.waitForSelector(".ns-paint:not(.ns-hidden) .ns-paint-text .neo-gallery-gen-panel", { timeout: 15000 });
        const state = await page.evaluate(() => ({
            panels: document.querySelectorAll(".ns-paint-text .neo-gallery-gen-panel").length,
            overlays: document.querySelectorAll(".neo-gallery-story-modal-overlay").length,
            titlebar: getComputedStyle(document.querySelector(".ns-paint-text .neo-gallery-story-titlebar")).display,
            btns: [...document.querySelectorAll(".ns-paint-text .neo-gallery-story-btn")].map((b) => b.textContent.trim()),
            lib: !!document.querySelector(".ns-paint .ns-gallery-host .neo-gallery-topbar"),
            prompt: document.querySelector(".ns-paint-text .neo-gallery-gen-panel textarea")?.value,
        }));
        assert.equal(state.panels, 1, "宿主里只有一块文生图面板");
        assert.equal(state.overlays, 0, "页内面板不建浮层遮罩");
        assert.equal(state.titlebar, "none", "页内面板收起标题栏（标题由上方模式条承担）");
        assert.ok(state.btns.includes("生成") && !state.btns.includes("取消"), "页内面板只有「生成」，没有「取消」");
        assert.ok(state.lib, "离开再回绘画页，左栏素材库仍在");
    } finally {
        await page.close();
    }
});

test("Studio 绘画页：左栏素材库「生成素材」面板留在本页", async (t) => {
    if (!guard(t)) return;
    const page = await browser.newPage();
    await pinZh(page);
    try {
        await page.goto(STUDIO_URL, { waitUntil: "networkidle", timeout: 30000 });
        await page.evaluate(() => { location.hash = "#/paint"; });
        await page.waitForSelector(".ns-paint .ns-gallery-host .neo-gallery-gm-btn", { timeout: 15000 });

        await page.click(".ns-paint .ns-gallery-host .neo-gallery-gm-btn");
        await page.waitForSelector(".ns-paint:not(.ns-hidden) .ns-paint-text .neo-gallery-gen-panel", { timeout: 15000 });
        const state = await page.evaluate(() => ({
            hash: location.hash,
            overlays: document.querySelectorAll(".neo-gallery-story-modal-overlay").length,
            panels: document.querySelectorAll(".ns-paint-text .neo-gallery-gen-panel").length,
            panel: document.querySelector(".ns-paint-text .neo-gallery-gen-panel").getBoundingClientRect(),
            host: document.querySelector(".ns-paint-text").getBoundingClientRect(),
            gen: [...document.querySelectorAll(".ns-paint-text .neo-gallery-story-btn")]
                .map((b) => b.textContent.trim()).includes("生成"),
        }));
        assert.equal(state.hash, "#/paint", "左栏入口不跳页：本页解决");
        assert.equal(state.overlays, 0, "不建浮层遮罩");
        assert.equal(state.panels, 1, "只有一块内嵌面板");
        assert.ok(Math.abs(state.panel.height - state.host.height) <= 2, "面板铺满宿主，不留空白");
        assert.ok(state.gen, "idle 有「生成」");
    } finally {
        await page.close();
    }
});

test("Studio 绘画页：图片编辑面板进页就绪，拖放落点与「生成」都在折叠线内", async (t) => {
    if (!guard(t)) return;
    const page = await browser.newPage();
    await pinZh(page);
    try {
        await page.goto(STUDIO_URL, { waitUntil: "networkidle", timeout: 30000 });
        await page.evaluate(() => { location.hash = "#/paint"; });
        await page.waitForSelector(".ns-paint .ns-paint-mode-btn", { timeout: 15000 });
        await page.click(".ns-paint-mode-btn:has-text('图片编辑')");
        await page.waitForFunction(() => getComputedStyle(document.querySelector(".ns-paint-edit")).display !== "none",
            null, { timeout: 5000 });

        const geo = await page.evaluate(() => {
            const box = (s) => document.querySelector(s)?.getBoundingClientRect();
            const inFold = (b) => !!b && b.top >= 0 && b.bottom <= window.innerHeight && b.width > 0 && b.height > 0;
            const gen = [...document.querySelectorAll(".ns-paint-edit .neo-gallery-story-btn")]
                .find((b) => b.textContent.trim() === "生成");
            const form = box(".ns-paint-edit .neo-gallery-edit-form");
            const panel = box(".ns-paint-edit .neo-gallery-gen-panel");
            const host = box(".ns-paint-edit");
            const btns = [...document.querySelectorAll(".ns-paint-mode-btn")];
            const look = (b) => {
                const cs = getComputedStyle(b);
                return { bg: cs.backgroundColor, border: cs.borderTopColor };
            };
            const bar = box(".ns-paint-modes");
            const main = box(".ns-paint-main");
            const stage = box(".ns-paint-edit .neo-gallery-edit-compare-stage");
            const empty = box(".ns-paint-edit .neo-gallery-edit-empty");
            // 显存条整块被右栏拉成整行，居中要看里面那几枚读数的跨度
            const memParts = [...document.querySelectorAll(".ns-paint-main .ns-mem > *")].map((e) => e.getBoundingClientRect());
            const memOffCenter = memParts.length
                ? Math.abs((Math.min(...memParts.map((b) => b.left)) + Math.max(...memParts.map((b) => b.right))) / 2 - (main.left + main.right) / 2)
                : 999;
            return {
                emptyInFold: inFold(empty),
                emptyFillW: empty && stage ? empty.width / stage.width : 0,
                emptyFillH: empty && stage ? empty.height / stage.height : 0,
                emptyH: empty ? empty.height : 0,
                genInFold: inFold(gen?.getBoundingClientRect()),
                formInFold: !!form && form.bottom <= window.innerHeight,
                heightGap: Math.abs(panel.height - host.height),
                overlays: document.querySelectorAll(".neo-gallery-story-modal-overlay").length,
                titlebar: getComputedStyle(document.querySelector(".ns-paint-edit .neo-gallery-story-titlebar")).display,
                disabled: [...document.querySelectorAll(".ns-paint-edit .neo-gallery-edit-outpaint-btn")].every((b) => b.disabled),
                on: look(btns.find((b) => b.classList.contains("ns-paint-mode-on"))),
                off: look(btns.find((b) => !b.classList.contains("ns-paint-mode-on"))),
                barOffCenter: Math.abs((bar.left + bar.right) / 2 - (main.left + main.right) / 2),
                barTopGap: bar.top - main.top,
                memOffCenter,
            };
        });
        assert.ok(geo.emptyInFold, "拖放落点整块在折叠线内（预览区没被挤到屏幕外）");
        assert.ok(geo.genInFold, "「生成」按钮可见可点，不被显存条切掉");
        assert.ok(geo.formInFold, "编辑表单收尾在视口内");
        assert.ok(geo.disabled, "无原图时扩图 / 局部 / 点选删除 / 融合 / 姿势先收起");
        assert.equal(geo.titlebar, "none", "页内面板收起标题栏（标题由上方模式条承担）");
        assert.equal(geo.overlays, 0, "不建浮层遮罩");
        assert.ok(geo.heightGap <= 2, "面板铺满宿主，不留大片空白");
        // 模式条 = 导演编辑页签同款：选中落底出边框，未选中只剩文字，整排居中
        assert.equal(geo.on.bg, "rgb(42, 45, 51)", "选中页签落底 #2a2d33");
        assert.equal(geo.on.border, "rgb(74, 77, 85)", "选中页签出边框 #4a4d55");
        assert.equal(geo.off.bg, "rgba(0, 0, 0, 0)", "未选中页签无底");
        assert.equal(geo.off.border, "rgba(0, 0, 0, 0)", "未选中页签无边框");
        assert.ok(geo.barOffCenter <= 2, "模式条在右栏里居中");
        assert.ok(geo.barTopGap >= 10, "模式条不贴窗口顶边");
        assert.ok(geo.memOffCenter <= 2, `显存条与模式条同轴居中（偏 ${geo.memOffCenter.toFixed(1)}px）`);
        // 拖入框铺满预览区，并随窗口伸缩
        assert.ok(geo.emptyFillW > 0.95, `拖入框铺满预览区宽度（${geo.emptyFillW.toFixed(2)}）`);
        assert.ok(geo.emptyFillH > 0.9, `拖入框铺满预览区高度（${geo.emptyFillH.toFixed(2)}）`);
        await page.setViewportSize({ width: 1440, height: 520 });
        await page.waitForTimeout(150);
        const shrunk = await page.evaluate(() => document.querySelector(".ns-paint-edit .neo-gallery-edit-empty")?.getBoundingClientRect().height || 0);
        assert.ok(shrunk > 0 && shrunk < geo.emptyH - 40, `窗口变矮时拖入框跟着缩（${geo.emptyH.toFixed(0)} → ${shrunk.toFixed(0)}）`);
    } finally {
        await page.close();
    }
});
