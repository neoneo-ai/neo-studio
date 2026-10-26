// 就绪翻面：页面钉在桌面端端口上原地接上生成 —— 不换地址、不刷新、不整页跳转。
// 单独成文件：每个 studio-app.js 实例都往共享 document 挂捕获监听，还带着 5s（测试里 40ms）的
// comfy_state 轮询；flipOffline 里的 reGateRunButtons 走全局 querySelectorAll，setStatus 每次重查
// 同一个 #ns-comfy-status —— 同文件里活着的实例会把本用例的生成按钮重新门控、把顶栏文案改写，
// 翻面断言就成了串味现场。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, click } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        FakeWebSocket.instances.push(this);
    }
}
FakeWebSocket.instances = [];
globalThis.WebSocket = FakeWebSocket;

const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

test("已停止后在启动设置点「启动内核」，就绪后页面原地接上生成", async () => {
    resetEnv();
    document.body.innerHTML = studioBody;
    // 桌面端快照：离线形态 + 归属表；就绪后桌面端在同一个快照里报出直连目标（comfy_base）
    let snap = {
        success: true, plugin_version: "9.9.9", comfyui_version: "ComfyUI 未运行", offline: true,
        caps: { image_gen: false, director: false, segment: false, storyboard: false, memory: false },
        routes: ["GET /neo_gallery/list"], comfy_base: "", recipes: [],
    };
    mockRoute("/neo_studio/version", () => snap);
    const status = document.getElementById("ns-comfy-status");
    const starts = [];
    const reloads = [];

    const state = { port: 8190, pid: 0, mine: true, running: false, ready: false };
    // jsdom 的 location.reload 不可重定义（且真导航会炸），整块换成桩：刷新动作可观测
    const realLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", {
        value: { hash: "#/settings", origin: "http://127.0.0.1:8191", reload: () => reloads.push(1) },
        configurable: true, writable: true,
    });
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            launcher_state: async () => ({
                root: "D:/ComfyUI", python: "D:/py/python.exe", port: 8190, state: "ok", error: "",
            }),
            comfy_start: async () => {
                starts.push(1);
                state.running = true;   // 进程已拉起，端口还没就绪
                return { ...state };
            },
        },
    };
    try {
        await import("../../web/studio/studio-app.js?flip=1");
        await flush();
        click(document.querySelector('.ns-settings-tab[data-key="launch"]'));
        await flush();
        const start = document.querySelector(".ns-kernel-start");
        assert.ok(start, "启动设置顶部应有「启动内核」按钮");
        assert.equal(start.disabled, false, "已停止时可启动");
        assert.equal(status.textContent, "● 已停止", "离线页顶栏报已停止，入口指向启动设置");
        assert.match(status.title, /启动设置/);

        click(start);
        await flush();
        assert.deepEqual(starts, [1], "已停止时点一下直接拉起，不需要二次确认");
        assert.equal(status.textContent, "● 启动中");
        assert.ok(document.body.classList.contains("ns-offline"), "离线标记应在");
        const run = document.querySelector(".ns-gen-run");
        assert.ok(run.classList.contains("ns-gen-off"), "生成按钮应被门控");

        // 进程活着但端口未就绪：继续显示启动中，不重复拉起、不刷新
        await sleep(120);
        assert.deepEqual(starts, [1], "启动中不该重复拉起");
        assert.deepEqual(reloads, [], "未就绪不该刷新");

        // 端口就绪：页面原地翻面 —— 不刷新、离线标记摘掉、按钮还回原功能、事件流换到 ComfyUI
        state.ready = true;
        snap = { success: true, plugin_version: "9.9.9", comfyui_version: "0.1",
                 comfy_base: "http://127.0.0.1:8190", recipes: [] };
        await sleep(120);
        assert.deepEqual(reloads, [], "就绪刷新会清掉未保存的编辑，不许刷新");
        assert.equal(document.body.classList.contains("ns-offline"), false, "离线标记应随翻面摘掉");
        assert.equal(run.classList.contains("ns-gen-off"), false, "生成按钮应还回原功能");
        assert.equal(run.textContent, "生成整片", "按钮文案要还原");
        assert.match(FakeWebSocket.instances.at(-1).url, /^ws:\/\/127\.0\.0\.1:8190\/ws\?clientId=/,
                     "事件流要换到 ComfyUI 的真流");
        assert.equal(status.textContent, "● 运行中");
    } finally {
        Object.defineProperty(globalThis, "location", { value: realLocation, configurable: true, writable: true });
    }
});


// 冷启动：内核是桌面端自己拉起的，用户从没点过「启动内核」，userStarting 恒假；桌面端在 ready
// 这同一份快照里才清掉 starting（app/studio_app.py 的 _jump_when_ready）。翻面条件挂在 starting 上时
// 这条路径永远进不来：顶栏出「运行中」，页面钉在离线形态，生成请求全 409。
test("冷启动：桌面端自己拉起内核，就绪后页面自己翻面（没人点过启动）", async () => {
    resetEnv();
    document.body.innerHTML = studioBody;
    let snap = {
        success: true, plugin_version: "9.9.9", comfyui_version: "ComfyUI 未运行", offline: true, starting: true,
        caps: { image_gen: false, director: false, segment: false, storyboard: false, memory: false },
        routes: ["GET /neo_gallery/list"], comfy_base: "", recipes: [],
    };
    mockRoute("/neo_studio/version", () => snap);
    const reloads = [];
    const realLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", {
        value: { hash: "#/settings", origin: "http://127.0.0.1:8191", reload: () => reloads.push(1) },
        configurable: true, writable: true,
    });
    const state = { port: 8190, pid: 42204, mine: true, running: true, ready: false, starting: true };
    // 没有 comfy_start：这条路径上前端一次都不会去拉起内核，全靠快照翻面
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            launcher_state: async () => ({
                root: "D:/ComfyUI", python: "D:/py/python.exe", port: 8190, state: "ok", error: "",
            }),
        },
    };
    try {
        await import("../../web/studio/studio-app.js?coldFlip=1");
        await sleep(120);   // 视图与状态位挂在 initExtensions 之后，微任务 flush 追不上
        assert.ok(document.body.classList.contains("ns-offline"), "启动中页面还是离线形态");

        state.ready = true;
        state.starting = false;
        snap = { success: true, plugin_version: "9.9.9", comfyui_version: "0.1",
                 comfy_base: "http://127.0.0.1:8190", recipes: [] };
        await sleep(120);
        assert.equal(document.body.classList.contains("ns-offline"), false, "就绪后离线标记应随翻面摘掉");
        assert.deepEqual(reloads, [], "就绪刷新会清掉未保存的编辑，不许刷新");
        assert.match(FakeWebSocket.instances.at(-1).url, /^ws:\/\/127\.0\.0\.1:8190\/ws\?clientId=/,
                     "事件流要换到 ComfyUI 的真流");
    } finally {
        Object.defineProperty(globalThis, "location", { value: realLocation, configurable: true, writable: true });
    }
});