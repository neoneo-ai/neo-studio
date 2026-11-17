// 首页两张卡直达的两页（#/reverse 与 #/voice）在装配层的样子：路由挂页、离线闸门。
// 这里每发用例各自 import 一份 studio-app 实例，模块图与本文件之外的用例互不相干：
// 换页要改 location.hash，排在别人的文件里就是替别人重画现场。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, clearRoutes, jsonResponse, sseResponse, fetchLog, click } from "./setup.mjs";

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
// 提示词增强页：默认上首页的卡 + 深链挂页 + 离线照用（增强链归桌面端自服，只有写侧门控）
test("首页「提示词增强」卡默认就在「创作」板块上，点卡与深链都落 #/enhance", async () => {
    mockShell({ prompt_enhance: true, prompt_library_write: true, image_gen: true }, false);
    window.location.hash = "#/home";
    await import("../../web/studio/studio-app.js?homePages4=1");
    await settle();
    const card = document.querySelector('.ns-home-card[data-card-id="prompt-enhance"]');
    assert.ok(card, "空版式（默认首页）就出这张卡：内置卡不带 defaultHidden");
    click(card);
    await settle(); await settle(); await settle();
    assert.equal(location.hash, "#/enhance", "点卡落自己那一页");
    const page = document.querySelector(".ns-enhance");
    assert.ok(page && !page.classList.contains("ns-hidden"), "显示的是提示词增强页视图");
    assert.ok(page.querySelector(".ns-enhance-skill"), "页上有技能下拉（顶部一项是智能判断）");
    assert.ok(page.querySelector(".ns-enhance-run"), "工具条上是那枚增强钮");

    const html = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8");
    assert.ok(!html.includes('data-tab="enhance"'), "顶栏不给提示词增强页页签：入口只有首页那一发");
});

test("离线形态：增强链桌面端自服，运行钮不门控；保存为预设那一发说清楚要 ComfyUI", async () => {
    mockShell({ prompt_enhance: true, prompt_library_write: false, prompt_reverse: false,
                voice: false, image_gen: false, queue: false, task_history: true }, true);
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse([
        "data: " + JSON.stringify({ text: "一段增强出来的提示词", kind: "content" }),
        "data: [DONE]",
    ]));
    window.location.hash = "#/enhance";
    await import("../../web/studio/studio-app.js?homePages5=1");
    await settle();
    const run = document.querySelector(".ns-enhance-run");
    assert.ok(run, "增强页在离线形态也挂得出来");
    assert.ok(!run.classList.contains("ns-gen-off"),
              "增强走 LLM 链与数据根技能文件：离线不需要内核，运行钮不写成「需要 ComfyUI」");

    // 正文框长在回话那条气泡里：先跑一发，舞台上有回话了才谈得上「保存为预设」
    document.querySelector(".ns-enhance-input").value = "写一句";
    click(run);
    await settle();
    assert.equal(document.querySelector(".ns-enhance-out")?.value, "一段增强出来的提示词",
                 "离线那一发正文照落进气泡");
    // 写侧离线：宿主闸门把这颗钮改写成「需要 ComfyUI」（同绘画页那一套），点它只引导启动内核
    const save = [...document.querySelectorAll(".ns-enhance-msg-ai button")]
        .find((b) => b.textContent.includes("需要 ComfyUI"));
    assert.ok(save?.classList.contains("ns-gen-off"),
              "提示词库写侧离线：保存钮写成需要 ComfyUI，不给一颗只会失败的钮");
    click(save);
    await settle();
    assert.equal(fetchLog.filter((c) => c.path === "/rs_prompts/save_prompt").length, 0,
                 "离线点保存不发保存请求");
});


// 宫格图分镜在装配层就是首页那张卡的落点：内嵌的一页，无顶栏页签、无弹窗。
test("首页「宫格图分镜」卡：落自己那一页——页上是内嵌的宿主，顶栏不给它页签", async () => {
    mockShell({ director: true, grid_split: true, queue: true, task_history: true }, false);
    mockRoute("/neo_home/layout", jsonResponse({ order: { create: ["storyboard"] } }));
    window.location.hash = "#/home";
    await import("../../web/studio/studio-app.js?homePages3=1");
    await settle();
    const card = document.querySelector('.ns-home-card[data-card-id="storyboard"]');
    assert.ok(card, "版式排过这张卡，首页就出这一发");
    click(card);
    await settle(); await settle(); await settle();
    assert.equal(location.hash, "#/storyboard", "点卡落自己那一页：入口不再是一发弹窗");
    const page = document.querySelector(".ns-storyboard");
    assert.ok(page && !page.classList.contains("ns-hidden"), "显示的是故事板页视图");
    assert.ok(page.querySelector(".ns-storyboard-host"), "页上给内嵌的故事板留出整栏宿主");
    assert.ok(page.querySelector(".ns-storyboard-placeholder"), "编辑器被关掉后给的是那一行「打开宫格图分镜」占位");
    assert.ok(!document.querySelector(".neo-director-overlay"), "没有弹窗：这一页不靠浮层摆内容");
    const html = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8");
    assert.ok(!html.includes('data-tab="storyboard"'), "顶栏不给宫格图分镜页签：入口只有首页那一发");
});

// 视频反推是独立的一页（web/reverse-video/）：首页「编辑」板块的卡直达 #/reverse_video，图片那一发的能力不顶它。
test("首页「视频反推」卡：点卡与深链都落 #/reverse_video，运行钮吃 prompt_reverse_video", async () => {
    mockShell({ prompt_reverse: true, prompt_reverse_video: false, voice: true, image_gen: true }, false);
    window.location.hash = "#/home";
    await import("../../web/studio/studio-app.js?homePages6=1");
    await settle();
    const card = document.querySelector('.ns-home-card[data-card-id="reverse-video"]');
    assert.ok(card, "默认版式就出这张内置卡");
    click(card);
    await settle(); await settle(); await settle();
    assert.equal(location.hash, "#/reverse_video", "点卡落自己那一页");
    const page = document.querySelector(".ns-revvid");
    assert.ok(page && !page.classList.contains("ns-hidden"), "显示的是视频反推页视图");
    assert.ok(page.querySelector(".ns-revvid-empty"), "没选视频时给的是起手卡片");
    const run = page.querySelector(".ns-revvid-run");
    assert.ok(run, "工具条上就是那枚反推钮");
    assert.match(run.textContent, /需要 ComfyUI/,
                 "这一页的能力缺时写成需要 ComfyUI：图片反推那一项能力不顶这一页");
    const html = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8");
    assert.ok(!html.includes('data-tab="reverse_video"'), "顶栏不给视频反推页页签：入口只有首页那一发");
});





test("故事板页标题行的列数：没有页签栏时 ✕ 落在行尾，不落在整行中间", () => {
    const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
    const row = css.match(/\.ns-storyboard-host \.neo-director-embedded \.neo-director-title\s*\{[^}]*\}/);
    assert.ok(row && /grid-template-columns:\s*1fr auto;/.test(row[0]),
        "这一页的标题行只排左右两块：按钮组不被网格排进中间那列，✕ 回到行尾");
    const editor = fs.readFileSync(path.join(webDir, "recipes.css"), "utf8");
    assert.match(editor, /\.neo-director-title\s*\{[^}]*grid-template-columns:\s*1fr auto 1fr/,
        "导演页的标题行照旧三列：页签严格居中不跟着这一页改");
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


test("视频反推从素材库弹窗取一条视频：点卡片即换进播放器，图片卡不取用", async () => {
    mockShell({ prompt_reverse_video: true, prompt_reverse: true }, false);
    // 素材库替身：取用闸认卡片上的 data-filename，视频与图片各给一枚
    const shim = await import("../../web/studio/shim/app.js");
    shim.app.extensionManager.registerSidebarTab({
        id: "neo.gallery",
        render: async (el) => {
            el.innerHTML = "";
            for (const name of ["clip.mp4", "a.png"]) {
                const card = document.createElement("div");
                card.className = "neo-gallery-thumb-container";
                card.dataset.filename = name;
                card.dataset.subfolder = "";
                el.appendChild(card);
            }
        },
    });
    document.body.innerHTML = studioBody;
    window.location.hash = "#/home";
    await import("../../web/studio/studio-app.js?homePages7=1");
    await settle();
    window.location.hash = "#/reverse_video";
    await settle();

    const page = () => document.querySelector(".ns-revvid");
    const sourcePill = () => page().querySelector(".ns-revvid-source");
    // 弹窗遮罩带着 scope:"assets" 出生就不动了，换页改的是里头画廊宿主的 data-lib-scope（见 openLibModal）
    const libModal = () => document.querySelector('.ns-libmodal:not(.ns-hidden) .ns-gallery-host[data-lib-scope="reverse_video"]')
        ?.closest(".ns-libmodal");
    const modalCard = (name) => [...libModal().querySelectorAll(".neo-gallery-thumb-container")].find((c) => c.dataset.filename === name);

    click(page().querySelector(".ns-revvid-empty .ns-revvid-btn"));
    await settle();
    assert.ok(libModal() && !libModal().classList.contains("ns-hidden"), "起手卡片那颗钮要开得出素材库弹窗");

    // 关窗后画廊宿主被交还给寄留处（setOnClose 里 mountGallery(standby)），断言要攥着开窗那一刻的引用
    click(modalCard("a.png"));
    await settle();
    assert.ok(libModal(), "图片卡过不了视频那道闸：弹窗留着给灯箱浏览");
    assert.equal(sourcePill().textContent, "没有视频", "图片卡不得落进播放器");

    const picked = libModal();
    click(modalCard("clip.mp4"));
    await settle();
    assert.ok(picked.classList.contains("ns-hidden"), "取到视频就关窗");
    assert.equal(sourcePill().textContent, "clip.mp4", "视频名要落进工具条那一格");
    const video = page().querySelector("video.ns-revvid-video");
    assert.ok(video.getAttribute("src")?.includes("/neo_frames/video"), "播放器要吃 /neo_frames/video 那条分段路由");
    assert.ok(video.getAttribute("src")?.includes("clip.mp4"), "播放器带着选中的那条视频");
    assert.ok(page().querySelector(".ns-revvid-main") && !page().querySelector(".ns-revvid-main").hidden, "起手卡片让位给播放器");
    assert.ok(page().querySelector(".ns-revvid-empty").hidden, "起手卡片收起");

    // 取用后换视频走工具条那颗「换视频」：同一条取用路
    click(page().querySelector(".ns-revvid-bar .ns-revvid-btn"));
    await settle();
    assert.ok(!libModal().classList.contains("ns-hidden"), "「换视频」也开得出素材库弹窗");
});
