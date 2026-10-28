// 冷启动：桌面端已拉起 ComfyUI 但端口未就绪。这段时间「启动中」只出顶栏胶囊，
// 「需要 ComfyUI」按钮文案与提示条都不得出现。
// 启动中状态来自桌面端 /neo_studio/version 快照：pywebview 的 js_api 注入晚于页面加载，
// 冷启动那几秒页面里没有 api，只靠 api 轮询就会先闪一遍「未运行」与「需要 ComfyUI」提示。
// 单独成文件：每个 studio-app.js 实例都往 document 挂捕获监听，同进程里多用例互相触发启动。
import test from "node:test";
import assert from "node:assert/strict";
import { mockRoute, jsonResponse, click, flush, resetEnv } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

const studioBody = `<div class="ns-header"></div><div id="ns-view"></div><span class="ns-comfy-status" id="ns-comfy-status" hidden></span>`;

// 带 tab 条的那份 fixture：落在哪一页就断言 active 落在哪个 tab 上
const tabsBody = `<div class="ns-header"></div>` +
    `<div class="ns-tabs"><a href="#/home" data-tab="home">首页</a><a href="#/director" data-tab="director">导演</a></div>` +
    `<div id="ns-view"></div><span class="ns-comfy-status" id="ns-comfy-status" hidden></span>`;

const OFFLINE_CAPS = {
    image_gen: false, storyboard: false, voice: false, segment: false,
    director: false, grid_split: true, memory: false, repair: false,
};

function mockStartingDesktop() {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "ComfyUI 未运行",
        offline: true, starting: true, caps: OFFLINE_CAPS, recipes: [],
    }));
    mockRoute("/rs_recipes/list", jsonResponse([]));
    mockRoute("/rs_prompts/skills", jsonResponse([]));
    mockRoute("/userdata/neo_recipes_data.json", jsonResponse({}));
    mockRoute("/neo_video_gen/director_progress", jsonResponse({
        active: false, segment_index: -1, total_segments: 0, step: 0, total_steps: 0,
    }));
    mockRoute("/neo_studio/director/generate", jsonResponse(
        { success: false, offline: true, error: "ComfyUI 未运行" }, 409));
}

test("桌面端拉起 ComfyUI 期间：「启动中」只出顶栏胶囊，不出「需要 ComfyUI」提示", async () => {
    mockStartingDesktop();
    window.location.hash = "#/director";
    await import("../../web/studio/studio-app.js?starting=1");
    await flush();

    assert.ok(document.body.classList.contains("ns-offline"), "启动中页面还是离线形态");
    assert.equal(document.getElementById("ns-offline"), null, "启动中不叠横幅，顶栏胶囊已经报了「● 启动中」");
    assert.equal(document.getElementById("ns-version"), null, "版本位不在顶栏");
    assert.ok(document.getElementById("ns-comfy-status").hidden, "js_api 未注入前顶栏状态位不出");
    const run = document.querySelector(".ns-gen-run");
    assert.ok(run, "导演页应已挂载");
    assert.match(run.textContent, /ComfyUI 启动中/);

    click(run);
    await flush();
    assert.equal(document.getElementById("ns-toast"), null, "启动中点生成入口不出提示条");

    // 启动中撞到的 409 同样收起：就绪后桌面端整页跳回完整 Studio
    await fetch("/neo_studio/director/generate", { method: "POST", body: "{}" });
    await flush();
    assert.equal(document.getElementById("ns-toast"), null, "启动中不出「需要 ComfyUI」提示条");

    // 版本号只在设置「关于」里，且跟着启动中状态走
    window.location.hash = "#/settings";
    window.dispatchEvent(new Event("hashchange"));
    await flush();
    click(document.querySelector('.ns-settings-tab[data-key="about"]'));
    await flush();
    assert.match(document.getElementById("ns-about-version").textContent, /Neo Studio 9\.9\.9 · ComfyUI 启动中/);
});

test("启动中点「⤒ 主画布编辑」：不开桌面端根路径的死页，只报「启动中」", async () => {
    mockStartingDesktop();
    window.pywebview = {
        api: { comfy_state: async () => ({ port: 8188, pid: 42204, mine: true, running: false, ready: false, starting: true }) },
    };
    window.location.hash = "#/director";
    await import("../../web/studio/studio-app.js?startingCanvas=1");
    await flush();
    assert.ok(document.getElementById("ns-comfy-status").classList.contains("ns-comfy-starting"),
              "顶栏应已报「● 启动中」");

    const opened = [];
    window.open = (url) => { opened.push(url); return null; };
    const { openSkillWorkflowInMainUi } = await import("../../web/skill/skill-writeback.js?startingCanvas=1");
    openSkillWorkflowInMainUi("image_gen");
    assert.equal(opened.length, 0, "启动中不该开主画布页 —— 离线页的 \"/\" 是桌面端只读服务，根路径没有画布页");
    assert.match(appState.toasts.at(-1).detail, /ComfyUI 启动中/);
});

test("开机落首页：不带 hash 与认不出的 tab 名都落首页，窗口不停在只剩顶栏的空白页", async () => {
    mockStartingDesktop();
    document.body.innerHTML = tabsBody;
    await import("../../web/studio/studio-app.js?landing=1");
    await flush();
    const active = () => document.querySelector(".ns-tabs a.active")?.dataset.tab;
    assert.equal(active(), "home", "开机不带 hash 落首页");
    assert.equal(document.querySelectorAll(".ns-page:not(.ns-hidden)").length, 1, "开机只有一页可见");

    window.location.hash = "#/director";
    window.dispatchEvent(new Event("hashchange"));
    await flush();
    assert.equal(active(), "director", "导演页照常切得过去");

    window.location.hash = "#/no-such-tab";
    window.dispatchEvent(new Event("hashchange"));
    await flush();
    assert.equal(active(), "home", "认不出的 tab 名落回首页");
    assert.equal(document.querySelectorAll(".ns-page:not(.ns-hidden)").length, 1, "认不出的 tab 名不停在空白页");
});

