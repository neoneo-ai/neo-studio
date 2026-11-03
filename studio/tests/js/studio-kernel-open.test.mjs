// 启动设置顶栏那枚「打开 ComfyUI」：内核在跑才有，点了把这一路的地址交系统默认浏览器。
// 地址取 comfy_state 报的那一份 —— 本机端口被占用时桌面端会换到下一个空闲端口，配置里那个端口不一定在听；
// 远程模式开的是启动设置里那台远端地址。无边框窗口里没有新标签可开，链接走 js_api 的 open_url。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, mockRoute, jsonResponse, click } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];
const LAUNCHER = {
    root: "D:/ComfyUI", python: "D:/py/python.exe", port: 8188,
    listen: "", remote: "", state: "ok", error: "",
};

// 桌面端窗口里的完整 Studio 页：顶栏状态位与启动设置的启停行共用同一份 comfy_state
function mountDesktop(comfyState, opened) {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
    }));
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...comfyState }),
            launcher_state: async () => ({ ...LAUNCHER, remote: comfyState.remote || "" }),
            open_url: async (url) => { opened.push(url); return { ok: true }; },
            comfy_stop: async () => ({ ...comfyState, running: false, ready: false, pid: 0 }),
        },
    };
    window.location.hash = "#/settings";
}

async function openLaunchTab(moduleTag) {
    await import(`../../web/studio/studio-app.js?${moduleTag}=1`);
    await flush();
    click(document.querySelector('.ns-settings-tab[data-key="launch"]'));
    await flush();
    return document.querySelector(".ns-kernel-open");
}

test("内核运行中才有这枚：点了交桌面端的桥开系统浏览器，窗口自己不动", async () => {
    const opened = [];
    mountDesktop({ port: 8188, pid: 4321, mine: true, running: true, ready: true }, opened);
    const open = await openLaunchTab("openRun");
    assert.ok(open, "启停行上应有「打开 ComfyUI」");
    assert.match(open.title, /http:\/\/127\.0\.0\.1:8188/, "提示里报要点开的那一路地址");
    click(open);
    await flush();
    assert.deepEqual(opened, ["http://127.0.0.1:8188"]);
});

test("地址跟着桌面端报的端口走：端口被占用换了端口，开的就是换后的那个", async () => {
    const opened = [];
    // 启动设置里存的是 8188，桌面端探测后换到 8190 拉起
    mountDesktop({ port: 8190, pid: 4321, mine: true, running: true, ready: true }, opened);
    const open = await openLaunchTab("openPort");
    click(open);
    await flush();
    assert.deepEqual(opened, ["http://127.0.0.1:8190"], "不取启动设置里那个端口");
});

test("端口上没人在听就收起这枚：启动中与已停止都不给一台打不开的 ComfyUI", async () => {
    const opened = [];
    mountDesktop({ port: 8188, pid: 4321, mine: true, running: true, ready: false, starting: true }, opened);
    const booting = await openLaunchTab("openBoot");
    assert.match(document.querySelector(".ns-kernel-state").textContent, /启动中/, "进程活着、端口还没就绪");
    assert.equal(booting.style.display, "none", "启动中点了就是浏览器报错页");

    mountDesktop({ port: 8188, pid: 4321, mine: true, running: false, ready: false }, opened);
    const stopped = await openLaunchTab("openStop");
    assert.equal(stopped.style.display, "none", "已停止同样收起");
    assert.deepEqual(opened, [], "收起的这枚一次都没打开过地址");
});

test("远程模式：开的是启动设置里那台远端地址，不是本机端口", async () => {
    const opened = [];
    mountDesktop({
        port: 8188, pid: 0, mine: false, running: true, ready: true,
        remote: "http://192.168.0.20:8188",
    }, opened);
    const open = await openLaunchTab("openRemote");
    assert.match(open.title, /http:\/\/192\.168\.0\.20:8188/, "提示里报远端地址");
    click(open);
    await flush();
    assert.deepEqual(opened, ["http://192.168.0.20:8188"]);
});
