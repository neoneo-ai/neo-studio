/**
 * Neo Studio 桌面端 E2E（pywebview + WebView2）：桌面端拉起 ComfyUI，经 WebView2 远程调试端口连 CDP，
 * 断言窗口里加载的是 Studio 页面（四视图渲染）与 localStorage 持久化。
 *
 * 会真的弹窗口，默认跳过；显式开启：NEO_STUDIO_APP=1 node tests/e2e/studio-app.e2e.mjs
 * 前置：整合包 python 已装 pywebview（可选依赖 desktop），WebView2 Runtime 已安装。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const APP_PY = join(REPO_ROOT, "app", "studio_app.py");
const GEOMETRY = join(REPO_ROOT, "data", "studio_window.json");
// 内核（ComfyUI）与仓库并排摆放：exe 里推不出根目录时显式给 --root
const KERNEL_ROOT = join(dirname(REPO_ROOT), "ComfyUI");
const PORT = Number(process.env.NEO_STUDIO_PORT || 8188);
const CDP_PORT = Number(process.env.NEO_STUDIO_CDP || 9223);
const PYTHON = process.env.NEO_STUDIO_PYTHON || "F:/comfy/Comfyui-WF-2026.8.8/python/python.exe";
// 用打包产物跑（复现用户双击的实际环境）：设 NEO_STUDIO_EXE 后桌面端由 exe 起
const EXE = process.env.NEO_STUDIO_EXE || "";

function desktop(port) {
    const args = ["--port", String(port), "--cdp", String(CDP_PORT)];
    // exe 可以放在任意目录，根目录推不出来（首跑弹目录选择器）：跑打包产物时显式给根目录与解释器
    if (EXE) args.push("--root", KERNEL_ROOT, "--python", PYTHON);
    return EXE ? spawn(EXE, args, { stdio: "inherit" }) : spawn(PYTHON, [APP_PY, ...args], { stdio: "inherit" });
}

// 单实例锁由内核在进程退出后释放，exit 事件早于它；PyInstaller onefile 里 spawn 到的是引导器，
// 真桌面端是它的子进程。必须先按引导器 PID 杀树（proc.kill() 会让该 PID 消失，之后 /T 就找不到树了）
async function killDesktop(proc) {
    const exited = new Promise((r) => proc.once("exit", r));
    await execFileAsync("taskkill", ["/F", "/T", "/PID", String(proc.pid)]).catch(() => {});
    await exited;
    await new Promise((r) => setTimeout(r, 3000));
}

async function probe(port = PORT) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/neo_studio/version`);
        return res.ok;
    } catch {
        return false;
    }
}

async function portOwner(port = PORT) {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"]);
    for (const line of stdout.split("\n")) {
        const f = line.trim().split(/\s+/);   // 行首空格会让索引右移，先 trim
        if (f[3] === "LISTENING" && f[1].split(":").pop() === String(port)) return f[4];
    }
    return "0";
}

async function cdpReady() {
    try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        return res.ok;
    } catch {
        return false;
    }
}

async function waitFor(fn, seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
        if (await fn()) return true;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}

// 上一个桌面端被杀后 WebView2 的 CDP 端点会残留一小段时间，连上就 socket hang up：重试到连上为止
async function connectCDP(seconds = 30) {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
        try {
            return await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
        } catch {
            if (Date.now() > deadline) return null;
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
}

// 冷启动时窗口先挂启动页（html=splash），就绪后桌面端才 load_url：连上 CDP 时页面常是 about:blank，重试到出现
async function findPage(browser, seconds = 40) {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
        const pages = browser.contexts().flatMap((c) => c.pages());
        const page = pages.find((p) => p.url().includes("/neo-studio"));
        if (page) return page;
        if (Date.now() > deadline) {
            assert.ok(false, `CDP 里找不到 Studio 页面（当前 ${pages.map((p) => p.url()).join(", ") || "无页面"}）`);
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
}

// 断言写的是中文文案：桌面端窗口的界面语言跟随系统，跑在英文系统上界面是英文 —— 钉成中文基线再断言
async function pinZh(page) {
    if (await page.evaluate(() => localStorage.getItem("neo_studio_lang")) === "zh") return;
    await page.evaluate(() => {
        localStorage.setItem("neo_studio_lang", "zh");
        setTimeout(() => location.reload(), 0);
    });
    await page.waitForTimeout(2000);
}

test("桌面端窗口加载 Neo Studio 四视图", async () => {
    if (process.env.NEO_STUDIO_APP !== "1") {
        console.log("跳过桌面端 E2E（设 NEO_STUDIO_APP=1 启用，会弹真实窗口）");
        return;
    }
    if (!existsSync(APP_PY) || !existsSync(PYTHON)) {
        console.log(`跳过：缺 ${APP_PY} 或 ${PYTHON}`);
        return;
    }
    // 几何持久化：预置存档尺寸，窗口应按存档打开
    mkdirSync(dirname(GEOMETRY), { recursive: true });
    writeFileSync(GEOMETRY, JSON.stringify({ width: 1200, height: 800, x: 120, y: 60 }));
    const proc = desktop(PORT);
    try {
        assert.ok(await waitFor(cdpReady, 120), "WebView2 远程调试端口未就绪");
        const browser = await connectCDP();
        assert.ok(browser, "连不上 WebView2 CDP");
        const page = await findPage(browser);

        await pinZh(page);
        await page.waitForSelector("#ns-version", { timeout: 20000 });
        assert.match(await page.evaluate(() => document.querySelector("#ns-version").textContent),
            /Neo Studio\s+\d+\.\d+\.\d+/, "窗口标题栏应显示插件版本");

        // 顶栏 ComfyUI 状态位：桌面端里可见，只报状态；端口 / PID 收在提示里，启停在「设置 → 启动设置」
        await page.waitForSelector("#ns-comfy-status:not([hidden])", { timeout: 20000 });
        await page.waitForFunction(() => /● 运行中/.test(document.querySelector("#ns-comfy-status").textContent),
            null, { timeout: 20000 });
        const status = await page.evaluate(() => {
            const el = document.querySelector("#ns-comfy-status");
            return { text: el.textContent, title: el.title, run: el.classList.contains("ns-comfy-run") };
        });
        assert.match(status.title, /端口 \d+/, "提示应说明端口");
        assert.match(status.title, /PID \d+/, "提示应说明 PID");
        assert.ok(status.run, "运行中状态位应是绿色");

        // 四视图渲染（与浏览器版 studio.e2e.mjs 同一组断言的桌面端子集）
        await page.waitForSelector("#ns-view .neo-gallery-panel", { timeout: 15000 });
        assert.ok(await page.locator("#ns-view .neo-gallery-panel").count(), "素材视图应渲染");

        await page.evaluate(() => { location.hash = "#/director"; });
        await page.waitForSelector(".ns-director .neo-recipes-card", { timeout: 15000 });

        await page.evaluate(() => { location.hash = "#/skills"; });
        await page.waitForSelector(".ns-skills-guide", { timeout: 15000 });
        await page.click(".ns-skills-guide-actions .ns-btn:has-text('技能列表')");
        await page.waitForSelector(".ns-skills .rs-skill-manager", { timeout: 15000 });

        await page.evaluate(() => { location.hash = "#/settings"; });
        await page.waitForSelector(".ns-settings-section", { timeout: 15000 });

        // 日志 tab：桌面端里同样能读到 ComfyUI 控制台
        await page.click(".ns-settings-tab[data-key='log']");
        await page.waitForFunction(() => document.querySelector(".ns-log").textContent.trim().length > 0,
            null, { timeout: 15000 });

        // 手动往上翻看时，2 秒轮询不应把滚动条拉回底部
        await page.evaluate(() => { document.querySelector(".ns-log").scrollTop = 0; });
        await page.waitForTimeout(2500);
        assert.ok((await page.evaluate(() => document.querySelector(".ns-log").scrollTop)) < 40,
            "翻看时不应被轮询拉回底部");

        // localStorage 落在 data/studio_profile（private_mode=False）：重开页面后仍在
        await page.evaluate(() => localStorage.setItem("ns_e2e_desktop", "ok"));
        // WebView2 下 page.reload 的导航事件不可靠（带 hash 的 URL 被判同文档导航，domcontentloaded 不触发）
        // 让页面自己 reload，再等首屏元素出现
        await page.evaluate(() => setTimeout(() => location.reload(), 0));
        await page.waitForTimeout(2000);
        await page.waitForSelector("#ns-version", { timeout: 20000 });
        assert.equal(await page.evaluate(() => localStorage.getItem("ns_e2e_desktop")), "ok",
            "窗口重开后 localStorage 应保留");

        // 按存档尺寸打开（configs/studio_window.json → create_window）
        const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
        assert.ok(Math.abs(size.w - 1200) <= 40 && Math.abs(size.h - 800) <= 40,
            `窗口应按存档 1200×800 打开（实际 ${size.w}×${size.h}）`);

        await browser.close();
    } finally {
        await killDesktop(proc);
    }
});

test("ComfyUI 停止时页面翻回离线形态：浏览可用、生成类请求 409", async () => {
    if (process.env.NEO_STUDIO_APP !== "1") {
        console.log("跳过桌面端 E2E（设 NEO_STUDIO_APP=1 启用，会弹真实窗口）");
        return;
    }
    const port = Number(process.env.NEO_STUDIO_STOP_PORT || 8190);
    const offlinePort = port + 3;   // 桌面端只读服务：app/studio_app.py 的 DESKTOP_PORT_OFFSET
    if (await probe(port)) {
        console.log(`跳过：${port} 上已有 ComfyUI，不杀用户的服务`);
        return;
    }
    const proc = desktop(port);
    const errors = [];
    try {
        assert.ok(await waitFor(cdpReady, 30), "WebView2 远程调试端口未就绪");
        const browser = await connectCDP();
        assert.ok(browser, "连不上 WebView2 CDP");
        const page = await findPage(browser);
        page.on("pageerror", (e) => errors.push(String(e)));
        await pinZh(page);

        // 冷启动窗口直接进桌面端的离线素材页：ComfyUI 还在拉起，「启动中」只出顶栏胶囊
        assert.ok(await waitFor(() => page.evaluate(() => document.body.classList.contains("ns-offline")), 60),
            "离线页应带离线标记");
        await page.waitForSelector("#ns-view .neo-gallery-panel", { timeout: 60000 });
        const offline = await page.evaluate(async () => ({
            banner: !!document.getElementById("ns-offline"),
            version: document.getElementById("ns-version").textContent,
            mem: !!document.querySelector(".ns-mem"),
            toast: !!document.getElementById("ns-toast"),
            // 必须 ComfyUI 运行时的写接口：桌面端不认，明确 409（/neo_gallery/delete 归桌面端服务，不在这里）
            del: (await fetch("/neo_image_gen/generate", { method: "POST", body: "{}" })).status,
        }));
        assert.equal(offline.banner, false, "离线页不叠横幅：顶栏胶囊报状态，入口在「设置 → 启动设置」");
        assert.match(offline.version, /ComfyUI 启动中/);
        assert.equal(offline.mem, false, "显存监控在导演页，离线页不应出显存块");
        assert.equal(offline.toast, false, "启动中不出「需要 ComfyUI」提示条");
        assert.equal(offline.del, 409, "写操作必须回 409 offline");
        // 目录结构要扫全部素材目录，缩略图是逐卡懒加载：出页面不等于出图，等到出图为止
        assert.ok(await waitFor(() => page.evaluate(() =>
            document.querySelectorAll("#ns-view .neo-gallery-panel img").length > 0), 60),
            "离线页应出缩略图");

        // ComfyUI 就绪 → 页面原地接上生成：地址不变、离线标记摘掉、显存条补挂、生成类目标认下桌面端 origin
        assert.ok(await waitFor(() => probe(port), 180), "桌面端拉起的 ComfyUI 未就绪");
        assert.ok(await waitFor(() => page.evaluate(() => !document.body.classList.contains("ns-offline")), 60),
            "就绪后离线标记应随翻面摘掉");
        assert.equal(new URL(page.url()).port, String(offlinePort),
                     "页面必须钉在桌面端端口上，整页跳转会把未保存的编辑清掉");
        assert.ok(await waitFor(() => page.evaluate(() =>
            !!document.querySelector(".ns-gen-foot .ns-mem")), 60), "翻面后显存条要补挂到生成面板");
        const direct = await page.evaluate(async (p) =>
            (await fetch(`http://127.0.0.1:${p}/neo_studio/version`)).status, port);
        assert.equal(direct, 200, "桌面端放行的 origin 必须被 ComfyUI 认下（--enable-cors-header）");

        // 停掉 ComfyUI → 页面翻回离线形态，浏览继续可用（启停在「设置 → 启动设置」顶部）
        await page.evaluate(() => { location.hash = "#/settings"; });
        await page.waitForSelector(".ns-settings-tab[data-key='launch']", { timeout: 30000 });
        await page.click(".ns-settings-tab[data-key='launch']");
        await page.waitForSelector(".ns-kernel-stop:not([disabled])", { timeout: 30000 });
        await page.click(".ns-kernel-stop");
        assert.ok(await waitFor(() => page.evaluate(() => document.body.classList.contains("ns-offline")), 120),
            "停掉内核后页面应翻回离线形态");
        assert.equal(new URL(page.url()).port, String(offlinePort), "停完页面还在原端口，不整页刷新");
        assert.ok(await waitFor(() => page.evaluate(() =>
            document.querySelectorAll("#ns-view .neo-gallery-panel img").length > 0), 60),
            "回到离线形态仍应出缩略图");
        // 停止后启动中标记要收掉：顶栏回到「已停止」，入口在「设置 → 启动设置」，不卡在启动中
        assert.match(await page.evaluate(() => document.getElementById("ns-comfy-status").textContent),
            /已停止/);
        assert.deepEqual(errors, [], "离线页不应有未捕获错误");

        await browser.close();
    } finally {
        await killDesktop(proc);
    }
});

test("启动设置点一下停掉桌面端拉起的 ComfyUI，再点一下重新拉起后页面原地接上生成", async () => {
    if (process.env.NEO_STUDIO_APP !== "1") {
        console.log("跳过桌面端 E2E（设 NEO_STUDIO_APP=1 启用，会弹真实窗口）");
        return;
    }
    // 冷启动专用端口：8188 上用户自己的 ComfyUI 绝不动
    const port = Number(process.env.NEO_STUDIO_STOP_PORT || 8190);

    if (await probe(port)) {
        console.log(`跳过：${port} 上已有 ComfyUI，不杀用户的服务`);
        return;
    }
    const proc = desktop(port);
    try {
        assert.ok(await waitFor(() => probe(port), 120),
            "桌面端拉起的 ComfyUI 未就绪（桌面端秒退多半是 singleton busy，看 data/studio_desktop.log）");
        assert.ok(await waitFor(cdpReady, 30), "WebView2 远程调试端口未就绪");
        const browser = await connectCDP();
        assert.ok(browser, "连不上 WebView2 CDP");
        const page = await findPage(browser);

        await page.waitForSelector("#ns-comfy-status:not([hidden])", { timeout: 60000 });
        await page.waitForFunction(() => /● 运行中/.test(document.querySelector("#ns-comfy-status").textContent),
            null, { timeout: 60000 });

        // 启停在「设置 → 启动设置」顶部：运行中「停止内核」可点
        await page.evaluate(() => { location.hash = "#/settings"; });
        await page.waitForSelector(".ns-settings-tab[data-key='launch']", { timeout: 30000 });
        await page.click(".ns-settings-tab[data-key='launch']");
        await page.waitForSelector(".ns-kernel-stop:not([disabled])", { timeout: 30000 });

        // 点一下真停：端口探活失败，页面翻回离线形态，状态位回到已停止
        await page.click(".ns-kernel-stop");
        const t0 = Date.now();
        let down = false;
        while (Date.now() - t0 < 120000) {
            const up = await probe(port);
            console.log(`t=${((Date.now() - t0) / 1000).toFixed(1)} probe=${up} owner=${await portOwner(port)} `
                + `status=${(await page.evaluate(() => document.querySelector("#ns-comfy-status")?.textContent || "").trim())}`);
            if (!up) { down = true; break; }
            await new Promise((r) => setTimeout(r, 5000));
        }
        assert.ok(down, `桌面端拉起的 ComfyUI 应被停掉（端口仍被 PID ${await portOwner(port)} 占着）`);
        await page.waitForFunction(() => /● 已停止/.test(document.querySelector("#ns-comfy-status")?.textContent || ""),
            null, { timeout: 30000 });

        // 点一下重新拉起：显示启动中，就绪后页面原地接上生成（同一份文档，标记 __e2e_reload 留在页上）
        await page.evaluate(() => { location.hash = "#/settings"; });
        await page.waitForSelector(".ns-settings-tab[data-key='launch']", { timeout: 30000 });
        await page.click(".ns-settings-tab[data-key='launch']");
        await page.waitForSelector(".ns-kernel-start:not([disabled])", { timeout: 30000 });
        assert.equal(await page.evaluate(() => document.querySelector(".ns-kernel-stop").disabled), true,
            "停止后「停止内核」应禁用（没进程可停）");

        await page.evaluate(() => { window.__e2e_reload = 1; });
        await page.click(".ns-kernel-start");
        await page.waitForFunction(() => /● 启动中/.test(document.querySelector("#ns-comfy-status").textContent),
            null, { timeout: 10000 });
        assert.ok(await waitFor(() => probe(port), 150), "重新拉起的 ComfyUI 未就绪");
        await page.waitForFunction(() => /● 运行中/.test(document.querySelector("#ns-comfy-status").textContent),
            null, { timeout: 30000 });
        assert.equal(await page.evaluate(() => window.__e2e_reload), 1,
            "就绪不许换页：刷新与跳转都会清掉未保存的编辑");

        await browser.close();
    } finally {
        await killDesktop(proc);
    }
});
