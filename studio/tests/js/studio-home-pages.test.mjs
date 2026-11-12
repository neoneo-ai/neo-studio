// 首页两张卡直达的两页（#/reverse 与 #/voice）在装配层的样子：路由挂页、离线闸门。
// 这里每发用例各自 import 一份 studio-app 实例，模块图与本文件之外的用例互不相干：
// 换页要改 location.hash，排在别人的文件里就是替别人重画现场。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, clearRoutes, jsonResponse, fetchLog, click } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = '<header class="ns-header"><nav class="ns-tabs"></nav></header>'
    + '<div id="ns-view"></div><span class="ns-comfy-status" id="ns-comfy-status"></span>';

// jsdom 没有真 WebSocket：studio-app 顶层连事件流，桩掉构造与 close 就够
globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

const settle = async () => { await sleep(0); await flush(); };

/** 版本快照是启动链的第一发：能力表与离线标记从这一份下发，页面据此门控运行钮 */
function mockShell(caps, offline) {
    resetEnv();
    clearRoutes();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9",
        comfyui_version: offline ? "ComfyUI 未运行" : "0.33.1",
        offline, caps, recipes: [],
    }));
    mockRoute("/neo_home/layout", jsonResponse({}));
    mockRoute("/rs_recipes/list", jsonResponse([]));
    mockRoute("/rs_prompts/skills", jsonResponse([]));
    mockRoute("/neo_studio/launcher", jsonResponse({ error: "no such route" }, 404));
}

test("深链 #/reverse 与 #/voice 挂出两页：起手卡片在页上，顶栏不给它们页签", async () => {
    mockShell({ prompt_reverse: true, voice: true, image_gen: true }, false);
    window.location.hash = "#/reverse";
    await import("../../web/studio/studio-app.js?homePages1=1");
    await settle();
    const reverse = document.querySelector(".ns-reverse");
    assert.ok(reverse, "深链 #/reverse 应挂出图片反推页");
    assert.ok(!reverse.classList.contains("ns-hidden"), "深链那一页就是当前显示的视图");
    assert.ok(reverse.querySelector(".ns-reverse-empty"), "没选图时给的是起手卡片");
    assert.ok(reverse.querySelector(".ns-reverse-bar .ns-reverse-run"), "工具条上就是那枚反推钮");

    window.location.hash = "#/voice";
    await settle();   // jsdom 把 hashchange 排成一条 task：微任务先走一轮才轮到路由
    const voice = document.querySelector(".ns-voice");
    assert.ok(voice, "深链 #/voice 应挂出声音克隆页");
    assert.ok(voice.querySelector(".ns-voice-empty"), "没选音频时给的是起手卡片");
    assert.ok(reverse.classList.contains("ns-hidden"), "两页与其余页同一条路由：常驻显隐，不重建");
    assert.ok(voice.querySelector(".ns-voice-bar .ns-voice-run"), "工具条上就是那枚生成钮");

    const html = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8");
    assert.ok(!html.includes('data-tab="voice"') && !html.includes('data-tab="reverse"'),
              "顶栏不给这两页页签：首页那两张卡是唯一的入口");
});

test("离线形态：两页的运行钮写成「需要 ComfyUI」，点一下拉起内核，不发请求", async () => {
    mockShell({ prompt_reverse: false, voice: false, image_gen: false, director: false,
                segment: false, simple_video: false, grid_split: true, queue: false,
                task_history: true, memory: false, repair: false, mcp: true, pose: true, agent: false }, true);
    const starts = [];
    const state = { port: 8188, pid: 0, mine: true, running: false, ready: false };
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            comfy_start: async () => { starts.push(1); return { ...state }; },
        },
    };
    window.location.hash = "#/reverse";
    await import("../../web/studio/studio-app.js?homePages2=1");
    await settle();

    const reverseRun = document.querySelector(".ns-reverse-run");
    assert.ok(reverseRun, "反推页该挂出来");
    assert.match(reverseRun.textContent, /需要 ComfyUI/);
    assert.match(reverseRun.title, /反推 需要 ComfyUI 执行队列/);
    click(reverseRun);   // 桩里的 click 走派发：真实页面上这颗钮没选图时本就禁用
    await settle();
    assert.ok(starts.length >= 1, "点一下应直接拉起 ComfyUI");
    assert.equal(fetchLog.filter((c) => c.path === "/rs_prompts/reverse_prompt").length, 0,
                 "离线页不该发反推请求");

    window.location.hash = "#/voice";
    await settle();
    const voiceRun = document.querySelector(".ns-voice-run");
    assert.ok(voiceRun, "声音克隆页该挂出来");
    assert.match(voiceRun.textContent, /需要 ComfyUI/);
    click(voiceRun);
    await settle();
    assert.equal(fetchLog.filter((c) => c.path === "/neo_voice/generate").length, 0,
                 "离线页不该发语音生成请求");
});
