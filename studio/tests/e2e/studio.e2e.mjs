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
        // 配方库在窗口弹窗里（顶栏「配方」开窗）：关着时面板挂在 DOM 里但不可见，按可见等会超时
        await page.waitForSelector(".neo-recipes-panel", { state: "attached", timeout: 15000 });
        // .rs-btn 基础样式 flex:1；满幅主区里不应拉伸成长条
        const runFlex = await page.evaluate(() =>
            getComputedStyle(document.querySelector(".ns-gen-panel .rs-btn.ns-gen-run")).flexGrow);
        assert.equal(runFlex, "0", "生成整片按钮不应被 flex 拉伸");
        // 导演页 = 顶栏（配方 / 素材库入口）+ 主栏（上编辑器 / 分隔条 / 下整片生成面板）；配方列表在弹窗里
        const layout = await page.evaluate(() => {
            const cs = (s) => getComputedStyle(document.querySelector(s));
            return {
                page: cs(".ns-director").display,
                bar: !!document.querySelector(".ns-director-bar"),
                list: cs('.ns-libmodal[data-lib-scope="recipes"] .neo-recipes-list').gridTemplateColumns,
                main: cs(".ns-director-main").flexDirection,
                editor: !!document.querySelector(".ns-director-editor"),
                split: !!document.querySelector(".ns-director-split"),
            };
        });
        assert.equal(layout.page, "flex", "导演页是顶栏 + 主栏的纵向排布（配方库进弹窗后没有常驻 360px 左列）");
        assert.ok(layout.bar, "顶栏有配方 / 素材库入口");
        assert.ok(!layout.list.includes("px "), "配方列表单列排布");
        assert.equal(layout.main, "column", "主栏上下排布（编辑器在上、生成面板在下）");
        assert.ok(layout.editor, "编辑器宿主就位");
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
        // 9 栏里只有「启动设置」不带 .ns-settings-section 外壳
        assert.equal(sections, 8);
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

test("Studio 导演页：配方弹窗开着刷新列表不关窗（当前配方只恢复高亮）", async (t) => {
    if (!guard(t)) return;
    const page = await browser.newPage();
    await pinZh(page);
    try {
        await page.goto(STUDIO_URL, { waitUntil: "networkidle", timeout: 30000 });
        await page.evaluate(() => { location.hash = "#/director"; });
        await page.waitForSelector(".ns-director-bar button:has-text('配方')", { timeout: 15000 });
        await page.click(".ns-director-bar button:has-text('配方')");
        await page.waitForSelector('.ns-libmodal[data-lib-scope="recipes"]:not(.ns-hidden)', { timeout: 15000 });
        // 列表取数落地那一下：旧实现自动选中会重放 onSelect，而 onSelect 第一句就是关窗 → 弹窗一打开就关闭
        await page.waitForSelector('.ns-libmodal[data-lib-scope="recipes"] .neo-recipes-card', { timeout: 15000 });
        await page.waitForTimeout(600);
        const st = await page.evaluate(() => {
            const m = document.querySelector('.ns-libmodal[data-lib-scope="recipes"]');
            return {
                open: !!m && !m.classList.contains("ns-hidden"),
                hi: document.querySelectorAll(".ns-director-recipes .neo-recipes-card-selected").length,
            };
        });
        assert.ok(st.open, "列表加载完配方弹窗还开着");
        assert.equal(st.hi, 1, "当前配方卡保持高亮");
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector('.ns-libmodal[data-lib-scope="recipes"]:not(.ns-hidden)'),
            null, { timeout: 5000 });
    } finally {
        await page.close();
    }
});

test("Studio 绘画页：顶栏模式条 + 素材库弹窗，文生图输入卡贴底、结果区在上方", async (t) => {
    if (!guard(t)) return;
    const page = await browser.newPage();
    await pinZh(page);
    try {
        await page.goto(STUDIO_URL, { waitUntil: "networkidle", timeout: 30000 });
        await page.evaluate(() => { location.hash = "#/paint"; });
        await page.waitForSelector(".ns-paint .ns-paint-mode-btn", { timeout: 15000 });

        const layout = await page.evaluate(() => {
            const cs = (s) => getComputedStyle(document.querySelector(s));
            const box = (s) => document.querySelector(s).getBoundingClientRect();
            return {
                modes: [...document.querySelectorAll(".ns-paint-mode-btn")].map((b) => b.textContent),
                main: box(".ns-paint-main"),
                panel: box(".ns-paint-text"),
                composer: box(".ns-paint-text .neo-gallery-gm-composer"),
                // 空轮舞台与空画布都不该在页里占位；输入区只能有一个框，增强不在默认视野
                stageVisible: !!document.querySelector(".ns-paint-stage:not(.ns-hidden)"),
                hero: !!document.querySelector(".neo-gallery-gm-hero"),
                boxes: document.querySelectorAll(".ns-paint-text textarea").length,
                genInComposer: !!document.querySelector(".neo-gallery-gm-composer .neo-gallery-gm-gen-btn"),
                enhanceInMenu: !!document.querySelector(".neo-gallery-gm-more-menu .neo-gallery-gm-enhance-group"),
                enhanceInComposer: !!document.querySelector(".neo-gallery-gm-composer .neo-gallery-gm-enhance-group"),
                // 控件行是胶囊 chip（按钮 + 向上菜单），不露原生下拉
                chipBtns: [...document.querySelectorAll(".ns-paint-text .neo-gallery-gm-composer-bar .neo-gallery-gm-chip-btn")]
                    .map((b) => [b.textContent.trim(), b.title]),
                visibleSelects: [...document.querySelectorAll(".ns-paint-text .neo-gallery-gm-composer-bar select")]
                    .filter((s) => !s.hidden && !s.closest(".neo-gallery-gm-chip-panel")).length,
                idleInComposer: !!document.querySelector(".neo-gallery-gm-composer .neo-gallery-gm-idle"),
                idleTop: document.querySelector(".ns-paint-text .neo-gallery-gm-idle")?.getBoundingClientRect().top ?? null,
                // 无原图时模式 chip 是禁用的：标签要读得到，提示要说出缺什么
                modeChip: (() => {
                    const b = document.querySelector(".ns-paint-edit .neo-gallery-edit-mode-select").parentElement.querySelector(".neo-gallery-gm-chip-btn");
                    return [b.textContent.trim(), b.disabled, b.title];
                })(),
                editHidden: cs(".ns-paint-edit").display,
                sideCol: !!document.querySelector(".ns-paint-side"),
                recipes: !!document.querySelector(".ns-paint-recipes"),
                libInPage: !!document.querySelector(".ns-paint .ns-gallery-host"),
                libBtn: !!document.querySelector(".ns-paint-lib-btn"),

            };
        });
        assert.deepEqual(layout.modes, ["文生图", "图片编辑"], "模式条两枚按钮");
        assert.equal(layout.editHidden, "none", "默认图片编辑收起（一次只铺满一块）");
        assert.ok(Math.abs(layout.panel.width - layout.main.width) <= 1, "文生图铺满整幅宽度");
        assert.ok(!layout.hero, "idle 不铺一块空画布");
        assert.equal(layout.boxes, 1, "文生图只有一个提示词框");
        assert.ok(layout.genInComposer, "「生成」在输入卡的控件行里");
        assert.ok(layout.enhanceInMenu && !layout.enhanceInComposer, "增强收在 ⋯ 菜单里，不在输入卡默认视野（默认 = 写一句直接生成）");
        assert.ok(!layout.stageVisible, "空轮时舞台整块收起：面板底下不留一片空框");
        assert.equal(layout.chipBtns.length, 4, "技能 / 比例 / 最长边 / 自定参数是四枚真 chip 按钮");
        assert.ok(layout.chipBtns.every(([text, title]) => text.length > 0 && title.length > 0),
            "chip 有文字标签与悬停提示（说清这一枚在改什么）");
        assert.equal(layout.visibleSelects, 0, "控件行里没有浏览器下拉框：原生 select 只当状态容器");
        assert.ok(layout.idleTop !== null && !layout.idleInComposer, "idle 起手提示挂在结果区，不塞进输入卡");
        assert.ok(layout.idleTop < layout.composer.top, "起手提示在输入卡上方（结果区在上方）");
        // 面板铺满主栏、输入卡钉在面板底边（ArtCraft 式输入条），中间空的一段是页面背景
        assert.ok(layout.panel.top - layout.main.top < layout.main.height * 0.4,
            `文生图面板从主栏上部铺起（偏移 ${Math.round(layout.panel.top - layout.main.top)}）`);
        assert.ok(layout.panel.height >= 200, `文生图面板自身可用高度 ${Math.round(layout.panel.height)}`);
        assert.ok(layout.panel.bottom <= layout.main.bottom + 2, "面板不溢出主栏");
        assert.ok(layout.composer.top > layout.panel.top + layout.panel.height * 0.5, "输入卡贴在面板下半（钉在底部）");
        assert.ok(layout.panel.bottom - layout.composer.bottom < 60,
            `输入卡收到面板底边（间距 ${Math.round(layout.panel.bottom - layout.composer.bottom)}）`);
        assert.ok(layout.modeChip[0].startsWith("常规"), "编辑模式收在一枚 chip 里，chip 显示当前模式");
        assert.ok(layout.modeChip[1] && /先拖入原图/.test(layout.modeChip[2]),
            "无原图时模式 chip 禁用，提示说明缺的是原图");
        assert.ok(!layout.sideCol, "绘画页不再有常驻左栏");
        assert.ok(!layout.libInPage, "素材库不常驻在页里（顶栏按钮开弹窗）");
        assert.ok(layout.libBtn, "顶栏有素材库入口");
        assert.ok(!layout.recipes, "绘画页不再有图片配方列表");

        // 自定参数卡片：展开后贴在输入卡正上方（与输入卡一组钉底），字段是生图模型 + LoRA
        const drawer = await page.evaluate(() => {
            const box = (s) => document.querySelector(s).getBoundingClientRect();
            const panelEl = document.querySelector(".ns-paint-text .neo-gallery-gm-chip-panel");
            const toggle = panelEl.parentElement.querySelector(".neo-gallery-gm-chip-btn");
            const hiddenBefore = getComputedStyle(panelEl).display;
            toggle.click();
            const d = box(".ns-paint-text .neo-gallery-gm-chip-panel");
            const c = box(".ns-paint-text .neo-gallery-gm-composer");
            const p = box(".ns-paint-text");
            const labels = [...document.querySelectorAll(".ns-paint-text .neo-gallery-gm-model-box .rs-form-label")]
                .map(l => l.textContent.trim());
            const searchable = document.querySelectorAll(".ns-paint-text .neo-gallery-gm-model-box .rs-model-select-box").length;
            toggle.click();
            return { d, c, p, labels, searchable, hiddenBefore, closedAfter: getComputedStyle(panelEl).display };
        });
        assert.equal(drawer.hiddenBefore, "none", "自定参数默认不显示");
        assert.ok(drawer.d.height > 40, `点开后是一块浮层面板（高 ${Math.round(drawer.d.height)}）`);
        assert.ok(drawer.d.bottom <= drawer.c.bottom && drawer.d.top >= drawer.p.top - 1,
            "面板从 chip 上方浮出，不超出文生图面板");
        assert.deepEqual(drawer.labels, ["生图模型", "LoRA"], "面板只露生图模型与 LoRA（Text Encoder / VAE 不露出）");
        assert.ok(drawer.searchable >= 1, "模型与 LoRA 用可搜索下拉壳（模型列表长，纯菜单翻不动）");
        assert.equal(drawer.closedAfter, "none", "再点一次「自定参数」应收起");

        // 矮窗口（缩小的窗口）：输入卡与显存条必须仍在视口内，页面不产生裁切
        await page.setViewportSize({ width: 1280, height: 660 });
        const short = await page.evaluate(() => {
            const box = (s) => document.querySelector(s).getBoundingClientRect();
            const view = document.querySelector(".ns-view");
            return {
                composer: box(".ns-paint-text .neo-gallery-gm-composer"),
                gen: box(".ns-paint-text .neo-gallery-gm-gen-btn"),
                mem: box(".ns-paint-main .ns-mem"),
                view: box(".ns-view"),
                clipped: view.scrollHeight - view.clientHeight,
                ta: box(".ns-paint-text .neo-gallery-gm-quick-input").height,
            };
        });
        assert.ok(short.composer.bottom <= short.view.bottom + 2,
            `矮窗口里输入卡落在视口内（底边 ${Math.round(short.composer.bottom)} / 视口底 ${Math.round(short.view.bottom)}）`);
        assert.ok(short.mem.bottom <= short.view.bottom + 2, "矮窗口里显存条不被裁掉");
        assert.ok(short.clipped <= 2, `矮窗口里文生图不溢出视口（溢出 ${short.clipped}px）`);
        assert.ok(short.ta < short.view.height * 0.35, `输入框高度跟着窗口收（${Math.round(short.ta)}px）`);
        assert.ok(short.gen.width > 40 && short.gen.height > 18, "「生成」钮在矮窗口里没被挤扁");
        await page.setViewportSize({ width: 1600, height: 950 });

        // 开弹窗 = 同一个画廊挂进弹窗宿主；点卡片填进图片编辑预览后关弹窗
        await page.click(".ns-paint-lib-btn");

        await page.waitForSelector(".ns-libmodal:not(.ns-hidden) .ns-gallery-host .neo-gallery-topbar", { timeout: 15000 });
        const inModal = await page.evaluate(() => {
            const modal = document.querySelector(".ns-libmodal:not(.ns-hidden)");
            return {
                inHost: !!modal.querySelector(".ns-gallery-host .neo-gallery-panel"),
                pick: !!modal.querySelector(".ns-libmodal-pick"),
            };
        });
        assert.ok(inModal.inHost, "画廊挂进素材库弹窗宿主");
        assert.ok(inModal.pick, "弹窗底部有多选收集条");
        await page.click('.ns-libmodal[data-lib-scope="assets"]:not(.ns-hidden) .ns-libmodal-close');
        await page.waitForFunction(() => !document.querySelector(".ns-libmodal:not(.ns-hidden)"), null, { timeout: 5000 });
        assert.equal(await page.evaluate(() => document.querySelectorAll(".ns-paint .ns-gallery-host").length), 0,
            "关弹窗后绘画页不养画廊");

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
        assert.ok(eager.editEmpty, "无原图时预览区是拖放落点（从素材库弹窗拖图进来即可）");
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
        assert.ok(Math.abs(after.w - after.main) <= 1, "图片编辑同样铺满整幅");

        // 弹窗默认铺满 → 最大化落盘 → 拖标题栏转浮窗 → Esc 关闭
        await page.click(".ns-paint-lib-btn");

        await page.waitForSelector('.ns-libmodal[data-lib-scope="assets"]:not(.ns-hidden)', { timeout: 5000 });
        const geo = await page.evaluate(() => JSON.parse(localStorage.getItem("neo_studio_libmodal_assets") || "{}"));
        assert.equal(geo.max, false, "首次打开记为非最大化");
        await page.click('.ns-libmodal[data-lib-scope="assets"]:not(.ns-hidden) .ns-libmodal-max');
        await page.waitForFunction(() => document.querySelector('.ns-libmodal[data-lib-scope="assets"]').classList.contains("ns-libmodal-maximized"),
            null, { timeout: 5000 });
        const tb = await page.locator('.ns-libmodal[data-lib-scope="assets"]:not(.ns-hidden) .ns-libmodal-titlebar').boundingBox();
        await page.mouse.move(tb.x + 60, tb.y + 12);
        await page.mouse.down();
        await page.mouse.move(tb.x + 180, tb.y + 90, { steps: 8 });
        await page.mouse.up();
        const moved = await page.evaluate(() => ({
            geo: JSON.parse(localStorage.getItem("neo_studio_libmodal_assets") || "{}"),
            floated: document.querySelector('.ns-libmodal[data-lib-scope="assets"]').classList.contains("ns-libmodal-floated"),
        }));
        assert.ok(moved.floated, "拖过标题栏后变浮窗");
        assert.ok(moved.geo.x > geo.x, `拖标题栏挪窗后 left 应离开 0：${JSON.stringify(moved.geo)}`);
        assert.equal(moved.geo.max, true, "最大化状态落盘");
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector('.ns-libmodal[data-lib-scope="assets"]:not(.ns-hidden)'),
            null, { timeout: 5000 });
        await page.evaluate(() => localStorage.removeItem("neo_studio_libmodal_assets"));
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
            modeBar: !!document.querySelector(".ns-paint .ns-paint-mode-btn"),
            prompt: document.querySelector(".ns-paint-text .neo-gallery-gen-panel textarea")?.value,
        }));
        assert.equal(state.panels, 1, "宿主里只有一块文生图面板");
        assert.equal(state.overlays, 0, "页内面板不建浮层遮罩");
        assert.equal(state.titlebar, "none", "页内面板收起标题栏（标题由上方模式条承担）");
        assert.ok(state.btns.includes("生成") && !state.btns.includes("取消"), "页内面板只有「生成」，没有「取消」");
        assert.ok(state.modeBar, "离开再回绘画页，模式条与面板照旧");
    } finally {
        await page.close();
    }
});

test("Studio 绘画页：素材库弹窗里「生成素材」面板留在本页", async (t) => {
    if (!guard(t)) return;
    const page = await browser.newPage();
    await pinZh(page);
    try {
        await page.goto(STUDIO_URL, { waitUntil: "networkidle", timeout: 30000 });
        await page.evaluate(() => { location.hash = "#/paint"; });
        await page.waitForSelector(".ns-paint .ns-paint-mode-btn", { timeout: 15000 });
        await page.click(".ns-paint-lib-btn");
        await page.waitForSelector(".ns-libmodal:not(.ns-hidden) .neo-gallery-gm-btn", { timeout: 15000 });


        await page.click(".ns-libmodal:not(.ns-hidden) .neo-gallery-gm-btn");
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
        assert.equal(state.hash, "#/paint", "弹窗入口不跳页：本页解决");
        assert.equal(state.overlays, 0, "不建浮层遮罩");
        assert.equal(state.panels, 1, "只有一块内嵌面板");
        assert.ok(Math.abs(state.panel.height - state.host.height) <= 2, "面板铺满宿主，不留空白");
        assert.ok(state.gen, "idle 有「生成」");
        assert.ok(await page.evaluate(() => !document.querySelector('.ns-libmodal[data-lib-scope="assets"]:not(.ns-hidden)')),
            "进绘画页时素材库弹窗关掉");
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
            const composer = box(".ns-paint-edit .neo-gallery-gm-composer");
            const composerBar = document.querySelector(".ns-paint-edit .neo-gallery-gm-composer-bar");
            // 显存条整块被顶栏拉成整行，居中要看里面那几枚读数的跨度
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
                modeChipDisabled: document.querySelector(".ns-paint-edit .neo-gallery-edit-mode-select").parentElement.querySelector(".neo-gallery-gm-chip-btn").disabled,
                // 编辑控件与文生图同一组贴底控件：一个输入卡 + 底行 chips
                chips: [...composerBar.querySelectorAll(".neo-gallery-gm-chip-btn")].map((b) => b.textContent.trim()),
                genInComposer: !!composerBar.querySelector(".neo-gallery-gm-gen-btn"),
                visibleSelects: [...composerBar.querySelectorAll("select")].filter((s) => !s.hidden && !s.closest(".neo-gallery-gm-chip-panel")).length,
                composerInFold: inFold(composer),
                paramsInBar: composerBar.contains(document.querySelector(".ns-paint-edit .neo-gallery-gm-chip-panel")),
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
        assert.ok(geo.modeChipDisabled, "无原图时模式 chip 先禁用（扩图 / 局部 / 删除 / 融合 / 姿势都藏在 chip 里）");
        assert.ok(geo.genInComposer, "「生成」在编辑输入卡的 chips 行里");
        assert.equal(geo.chips.length, 4, "编辑输入卡底行 = 技能 chip + 模式 chip + 尺寸 chip + 自定参数 chip");
        assert.equal(geo.visibleSelects, 0, "编辑控件行里没有浏览器下拉框：原生 select 只当状态容器");
        assert.ok(geo.composerInFold, "输入卡整块在折叠线内");
        assert.ok(geo.paramsInBar, "自定参数面板挂在底行 chip 上（不占输入卡上方空间）");
        assert.equal(geo.titlebar, "none", "页内面板收起标题栏（标题由上方模式条承担）");
        assert.equal(geo.overlays, 0, "不建浮层遮罩");
        assert.ok(geo.heightGap <= 2, "面板铺满宿主，不留大片空白");
        // 模式条 = 导演编辑页签同款：选中落底出边框，未选中只剩文字，整排居中
        assert.equal(geo.on.bg, "rgb(42, 45, 51)", "选中页签落底 #2a2d33");
        assert.equal(geo.on.border, "rgb(74, 77, 85)", "选中页签出边框 #4a4d55");
        assert.equal(geo.off.bg, "rgba(0, 0, 0, 0)", "未选中页签无底");
        assert.equal(geo.off.border, "rgba(0, 0, 0, 0)", "未选中页签无边框");
        assert.ok(geo.barOffCenter <= 2, "模式条在顶栏里居中");
        assert.ok(geo.barTopGap >= 10, "模式条不贴窗口顶边");
        assert.ok(geo.memOffCenter <= 2, `显存条与模式条同轴居中（偏 ${geo.memOffCenter.toFixed(1)}px）`);
        // 拖入框铺满预览区，并随窗口伸缩
        assert.ok(geo.emptyFillW > 0.95, `拖入框铺满预览区宽度（${geo.emptyFillW.toFixed(2)}）`);
        assert.ok(geo.emptyFillH > 0.9, `拖入框铺满预览区高度（${geo.emptyFillH.toFixed(2)}）`);
        await page.setViewportSize({ width: 1440, height: 520 });
        await page.waitForTimeout(150);
        const shrunk = await page.evaluate(() => document.querySelector(".ns-paint-edit .neo-gallery-edit-empty")?.getBoundingClientRect().height || 0);
        assert.ok(shrunk > 0 && shrunk < geo.emptyH - 40, `窗口变矮时拖入框跟着缩（${geo.emptyH.toFixed(0)} → ${shrunk.toFixed(0)}）`);

        // 矮窗口：输入卡钉底不被显存条切掉，自定参数展开也不把输入卡顶出视口
        await page.setViewportSize({ width: 1280, height: 660 });
        await page.waitForTimeout(200);
        const short = await page.evaluate(() => {
            const box = (s) => document.querySelector(s)?.getBoundingClientRect();
            const inFold = (b) => !!b && b.top >= 0 && b.bottom <= window.innerHeight && b.height > 0;
            const panelEl = document.querySelector(".ns-paint-edit .neo-gallery-gm-chip-panel");
            const chip = panelEl.parentElement.querySelector(".neo-gallery-gm-chip-btn");
            const panelHidden = getComputedStyle(panelEl).display;
            chip.click();
            const p = box(".ns-paint-edit .neo-gallery-gm-chip-panel");
            const c = box(".ns-paint-edit .neo-gallery-gm-composer");
            const bar = box(".ns-paint-edit .neo-gallery-gm-composer-bar");
            const ta = box(".ns-paint-edit .neo-gallery-gm-quick-input");
            chip.click();
            return {
                panelHidden,
                panelInFold: inFold(p),
                panelAboveChip: p && chip.getBoundingClientRect().top > p.bottom,
                composerInFold: inFold(c),
                barInFold: inFold(bar),
                taHeight: Math.round(ta.height),
            };
        });
        assert.equal(short.panelHidden, "none", "自定参数默认不显示");
        assert.ok(short.panelInFold, "矮窗口里自定参数展开后在折叠线内");
        assert.ok(short.panelAboveChip, "自定参数面板从 chip 上方浮出（输入卡钉在底边，只能朝上开）");
        assert.ok(short.composerInFold, "矮窗口里输入卡整块在折叠线内（没被顶出视口）");
        assert.ok(short.barInFold, "矮窗口里底行 chips 与「生成」不被切掉");
        assert.ok(short.taHeight < 200, `矮窗口里指令框压矮（${short.taHeight}px），给预览区留位置`);
    } finally {
        await page.close();
    }
});
