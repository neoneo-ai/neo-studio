// Neo Studio 导演页：配方条（下拉快切 / 配方管理弹窗 / 新建 / 素材库 / 整片编辑器）+ 出片区（实时预览舞台 + 状态行）
// + 生成坞（紧凑时间轴 + 该段行 + 首帧 / 尾帧 / 参考三块素材槽 + 模型链覆盖 + 种子 + 保存该段 + 生成整片）。
// 本页只发「配方名 + 勾选段 + 种子 + 模型链覆盖」：分辨率 / 每段技能与素材都在配方里，由整片编辑器与后端 owns。
// studio-app.js 顶层会取 #ns-view 并连 WebSocket，导入前必须先备好 DOM 与 WS 桩。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, mockRoute, clearRoutes, jsonResponse, sleep, click, fire, fetchLog } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

const wsInstances = [];
globalThis.WebSocket = class {
    constructor(url) { wsInstances.push(this); this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    send() {}
    close() {}
};

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?director=${seq++}`);
const settle = async () => { await sleep(0); await flush(); };

const pageEl = () => document.querySelector(".ns-director");
const recipeSel = () => document.querySelector(".ns-director-recipe");
const barBtn = (label) => [...document.querySelectorAll(".ns-director-bar .ns-btn")].find((b) => b.textContent.includes(label));
const runBtn = () => document.querySelector(".ns-director-run");
const cancelBtn = () => document.querySelector(".ns-director .ns-gen-cancel");
const saveBtn = () => document.querySelector(".ns-director-save");
const statusEl = () => document.querySelector(".ns-director-status");
const barEl = () => document.querySelector(".ns-director-progress");
const mediaEl = () => document.querySelector(".ns-director-media");
const liveBox = () => document.querySelector(".ns-director-live");
const promptIn = () => document.querySelector(".ns-director-prompt");
const durIn = () => document.querySelector(".ns-director-duration");
const segLabel = () => document.querySelector(".ns-director-seg-label");
const checkHint = () => document.querySelector(".ns-director-checkhint");
const sizeLabel = () => document.querySelector(".ns-director-size .neo-gallery-gm-chip-label");
const seedIn = () => document.querySelector(".ns-director-seed");
const slots = () => [...document.querySelectorAll(".ns-director-slots .ns-slot")];
const slotAdd = () => [...document.querySelectorAll(".ns-director-slots .ns-slot-add")];
const cfgBtn = () => document.querySelector(".ns-director-cfg");
const tlHost = () => document.querySelector(".ns-director-timeline");
const tl = () => tlHost().__neoDirectorTimeline;
const recipesModal = () => document.querySelector('.ns-libmodal[data-lib-scope="recipes"]');
const libModal = () => document.querySelector('.ns-libmodal[data-lib-scope="director"]');
const modalCard = (name) => [...document.querySelectorAll(".ns-libmodal .neo-gallery-thumb-container")].find((c) => c.dataset.filename === name);
const isHidden = (el) => el.classList.contains("ns-hidden");
const posts = (p) => fetchLog.filter((c) => c.method === "POST" && c.path === p);
// copy_to_input 是 GET 路由（后端 @routes.get）：素材取用落盘只认这条路径，不看方法
const copies = () => fetchLog.filter((c) => c.path === "/neo_gallery/copy_to_input");
const genBody = () => (posts("/neo_studio/director/generate").at(-1) || { body: {} }).body;
// load 是 POST，配方名在 body 里：重读次数就是它被重新取回的次数
const loads = (name) => fetchLog.filter((c) => c.path === "/rs_recipes/load" && c.body?.name === name).length;

function wsSend(type, data) {
    const ws = wsInstances[wsInstances.length - 1];
    ws.onmessage({ data: JSON.stringify({ type, data }) });
}
async function until(fn, what) {
    for (let i = 0; i < 60; i++) { if (fn()) return; await sleep(10); }
    assert.fail(`等待超时：${what}`);
}
async function pickRecipe(name) {
    recipeSel().value = name;
    fire(recipeSel(), "change");
    await settle();
    await settle();
}
// 时间轴画在 canvas 上：jsdom 无布局，命中坐标全部由组件自己算（_layout / _hitsCheck / _blockAt）。
// 画布矩形由 helpers/env.mjs 的 installRectStub 认 canvas.__rect，本地坐标 = client 坐标（rect 从 0 起）。
const CANVAS_W = 600;
function setCanvasRect() {
    tl().canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: CANVAS_W, bottom: 120, width: CANVAS_W, height: 120 };
}
function mouseAt(type, x, y) {
    return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
}
// 勾选框命中点：块左上角那一小格，逐点问组件「这点算不算勾」——热区尺寸与位置都在组件里，测试不复制常量
function findCheckPoint(i) {
    const b = tl()._layout().blocks[i];
    for (let y = 0; y <= 60; y += 2) {
        for (let x = b.x; x <= b.x + 60; x += 2) {
            // 命中点必须落在「这块本身」：块边界两端都算命中，_blockAt 取先匹配的那块
            if (tl()._blockAt(x) === i && tl()._hitsCheck(x, y, i)) return { x, y };
        }
    }
    assert.fail(`第 ${i + 1} 段找不到勾选框命中点`);
}
async function clickCheck(i) {
    setCanvasRect();
    const { x, y } = findCheckPoint(i);
    tl().canvas.dispatchEvent(mouseAt("mousedown", x, y));
    await settle();
}
async function clickSeg(i) {
    setCanvasRect();
    const b = tl()._layout().blocks[i];
    const x = b.x + 10, y = 90;   // 块内偏下：躲开左上角勾选框与右缘调时长热区
    tl().canvas.dispatchEvent(mouseAt("mousedown", x, y));
    window.dispatchEvent(mouseAt("mouseup", x, y));
    await settle();
}
// 该段取用：点方块的取用钮开素材库弹窗 → 点卡片（先过技能闸，过了才 copy_to_input）
async function pickIntoSlot(idx, name) {
    click(slotAdd()[idx]);
    await settle();
    click(modalCard(name));
    await settle();
}

// 配方 = 后端给的形状（顶层平铺：segments / shared / assets / source）；spec 是解析进 input/ 的每段素材名
const SKILL = { id: "sk-a", cn_name: "技能 A", gen_video: true, mode: "f2v", gen_config: { ref_kinds: ["image"] } };
const RECIPE_BY_NAME = {
    R1: { name: "R1", type: "video_director", source: "user", shared: { mode: "f2v" }, assets: [], loras: [],
        segments: [{ skill_id: "sk-a", prompt: "段一", duration_sec: 3, first_frame: "seed1.png" },
            { skill_id: "sk-a", prompt: "段二", duration_sec: 4 }] },
    R2: { name: "R2", type: "video_director", source: "user", shared: { mode: "f2v" }, assets: [], loras: [],
        segments: [{ skill_id: "sk-a", prompt: "甲", duration_sec: 2 },
            { skill_id: "sk-a", prompt: "乙", duration_sec: 2, mode: "r2v" },
            { skill_id: "sk-a", prompt: "丙", duration_sec: 2 }] },
    预设片: { name: "预设片", type: "video_director", source: "preset", shared: { mode: "r2v" }, assets: [], loras: [],
        segments: [{ skill_id: "sk-a", prompt: "预设段", duration_sec: 4, refs: { images: ["p1.png"] } }] },
};
const SPEC_BY_RECIPE = {
    R1: { segments: [{ ref_input: "seed1.png", last_input: "" }], defaults: { width: 640, height: 384, steps: 20 } },
    R2: { segments: [{}, {}, {}], defaults: { width: 1344, height: 768, steps: 8 } },
    预设片: { segments: [{ refs: { images: ["p1.png"] } }], defaults: { width: 512, height: 896, steps: 8 } },
};
const GALLERY_FILES = ["a.png", "b.png", "c.png", "d.png", "e.png", "clip.mp4", "voice.wav"];

let statusState = null;   // 快照路由按请求时刻取这份状态：在途轮询拿到的就是那一刻的载荷
let saveBodies = [];
let cancelHits = 0;

function bootMocks() {
    statusState = { task_id: "task-1", prompt_id: "p1", recipe: "R1", seed: -1, subfolder: "", filename: "",
        status: "queued", progress: null, error: "", created: 0, updated: 0 };
    saveBodies = [];
    cancelHits = 0;
    appState.toasts.length = 0;
    mockRoute("/neo_studio/version", jsonResponse({ success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [] }));
    mockRoute("/rs_recipes/list", jsonResponse(Object.values(RECIPE_BY_NAME)));
    mockRoute("/rs_recipes/load", (body) => jsonResponse({ success: true, recipe: RECIPE_BY_NAME[body.name] || null }));
    mockRoute("/rs_recipes/director_spec", (b, call) => jsonResponse({ success: true, ...(SPEC_BY_RECIPE[call.query.get("name")] || SPEC_BY_RECIPE.R1) }));
    mockRoute("/rs_recipes/save", (body) => { saveBodies.push(body); return jsonResponse({ success: true, name: body.name }); });
    mockRoute("/rs_prompts/skills", jsonResponse([SKILL]));
    mockRoute("/neo_video_gen/director_progress", jsonResponse({ active: false, segment_index: -1, total_segments: 0, step: 0, total_steps: 0 }));
    mockRoute("/neo_video_gen/models", jsonResponse({
        diffusion_models: ["h3/model_a.safetensors", "h3/model_b.safetensors"],
        text_encoders: ["qwen3vl.safetensors"], vae: ["vae.safetensors"], loras: ["h3/style_lora.safetensors"],
    }));
    mockRoute("/neo_image_gen/skill_config", () => jsonResponse({}));
    mockRoute("/neo_image_gen/settings", jsonResponse({ success: true, target_mp: 8 }));
    mockRoute("/neo_video_gen/settings", jsonResponse({ success: true, models: {} }));
    mockRoute("/neo_studio/queue", jsonResponse({ success: true, online: true, image: 0, segment: 0, film: 0, simple: 0, voice: 0, total: 0, rows: [] }));
    mockRoute("/neo_studio/queue_track", jsonResponse({ success: true, tracking: [] }));
    mockRoute("/neo_skill_models/check", () => jsonResponse({ success: true, check: { has_manifest: true, blocked: false, missing: [], missing_count: 0, missing_gb: 0 } }));
    mockRoute("/neo_gallery/copy_to_input", (b, call) => jsonResponse({ success: true, filename: `copied_${call.query.get("filename")}` }));
    mockRoute("/neo_studio/director/generate", (body) => jsonResponse({
        success: true, task_id: "task-1", prompt_id: "p1", recipe: body.recipe, seed: body.seed,
        subfolder: "", filename: "", error: "", created: 0, updated: 0, status: "queued", progress: null,
    }));
    mockRoute("/neo_studio/director/task-1", () => jsonResponse({ success: true, ...statusState }));
    mockRoute("/neo_studio/director/task-1/cancel", () => {
        cancelHits++;
        statusState = { ...statusState, status: "cancelled" };
        return jsonResponse({ success: true, dequeued: true });
    });
    mockRoute("/userdata/neo_recipes_data.json", jsonResponse({}));
}

async function boot() {
    resetEnv();
    clearRoutes();
    bootMocks();
    document.body.innerHTML = studioBody;
    window.location.hash = "#/home";
    const shim = await import("../../web/studio/shim/app.js");
    // 素材库替身：lib-modal 的取用逻辑认的就是卡片上的 data-filename
    shim.app.extensionManager.registerSidebarTab({
        id: "neo.gallery",
        render: async (el) => {
            el.innerHTML = "";
            for (const name of GALLERY_FILES) {
                const card = document.createElement("div");
                card.className = "neo-gallery-thumb-container";
                card.dataset.filename = name;
                card.dataset.subfolder = "";
                el.appendChild(card);
            }
        },
    });
    await importApp();
    await settle();
    await settle();
}
// 进导演页并等首份配方自动选中（非预设在前 → R1）：页面建好后所有用例都从「已选中 R1」起
async function openDirector(what = "导演页挂载") {
    await clickTab("director");
    await until(() => pageEl() && tlHost().__neoDirectorTimeline, what);
    await until(() => recipeSel().value === "R1", "配方自动选中");
}
async function clickTab(name) {
    click(document.querySelector(`.ns-tabs a[data-tab="${name}"]`));
    await settle();
    if (location.hash !== `#/${name}`) location.hash = `#/${name}`;
    await settle();
}


const statusPayload = (over = {}) => ({ success: true, ...statusState, ...over });
function setRunning() {
    statusState = { ...statusState, status: "running", progress: { value: 5, max: 20 }, filename: "" };
}
function setSucceeded() {
    statusState = { ...statusState, status: "succeeded", progress: null, filename: "NeoDirector/R1.mp4" };
}
async function startRun() {
    click(runBtn());
    await settle();
    await settle();
}

test("导演页：生成整片 payload = 配方名 + 种子 + 模型链覆盖（顶层键）；起手卡先占位", async () => {
    await boot();
    await openDirector();
    click(cfgBtn());
    await settle();
    const modelSel = document.querySelector(".ns-director-cfg-panel select");
    modelSel.value = "h3/model_b.safetensors";
    fire(modelSel, "change");
    seedIn().value = "8888";
    fire(seedIn(), "change");
    await startRun();
    assert.equal(posts("/neo_studio/director/generate").length, 1, `生成整片提交一次（状态：${statusEl()?.textContent}；命中 ${posts("/neo_studio/director/generate").length}；POST 路径 ${fetchLog.filter((c) => c.method === "POST").map((c) => c.path).join("|")}）`);
    assert.equal(genBody().recipe, "R1", "整片 = 当前配方名（后端按名从盘上读）");
    assert.equal(genBody().seed, 8888, "种子随本发走");
    assert.equal(genBody().model, "h3/model_b.safetensors", "模型覆盖是顶层键");
    assert.ok(!("only_segments" in genBody()), "未勾选就不发这个键");
    assert.ok(statusEl().textContent.includes("排队中"), `排队中要说清去顶栏队列看：${statusEl().textContent}`);
    assert.equal(cancelBtn().style.display, "", "取消按钮可见");
    assert.ok(mediaEl().classList.contains("ns-director-idle") && mediaEl().querySelector(".ns-director-idle-card"), "画面没来之前起手卡占位");
    assert.equal(getComputedStyle(liveBox()).display, "none", "预览容器在帧到达前隐藏");
    assert.equal(barEl().style.display, "none", "排队中不铺进度条");
    assert.ok(!runBtn().disabled, "生成钮不锁：这一发的进度在顶栏队列里跟");
});

test("导演页：WS 驱动生成中 / 实时预览；预览按 task_id 订阅，非本发的载荷不进播放器", async () => {
    await boot();
    await openDirector();
    await startRun();
    setRunning();
    wsSend("rs.director.status", { ...statusState });
    await settle();
    assert.equal(barEl().style.display, "block", "运行中铺进度条");
    assert.equal(barEl().firstElementChild.style.width, "25%", "进度宽度按步数算");
    assert.ok(statusEl().textContent.includes("生成中"), "状态行显示生成中");
    const frame = `data:image/jpeg;base64,${Buffer.from("f1").toString("base64")}`;
    wsSend("rs.h3.preview", { node_id: "task-1", frames: [frame], fps: 10, w: 20, h: 10 });
    await until(() => liveBox().querySelectorAll("img").length === 1, "实时预览帧上屏");
    assert.ok(liveBox().querySelector("img").src.startsWith("data:image/jpeg"), "预览帧直接当 src");
    assert.notEqual(getComputedStyle(liveBox()).display, "none", "预览帧到达即显形");
    assert.ok(!mediaEl().classList.contains("ns-director-idle"), "预览帧到达收起手卡");
    wsSend("rs.h3.preview", { node_id: "not-this-task", frames: [`data:image/jpeg;base64,${Buffer.from("zz").toString("base64")}`], fps: 10, w: 20, h: 10 });
    await settle();
    assert.equal(liveBox().querySelectorAll("img").length, 1, "非本发的预览帧不得进这一发的播放器");
});


test("导演页：进页铺好配方条 + 自动选中配方 + 时间轴 + 三方块 + 底部胶囊", async () => {
    await boot();
    await openDirector();
    assert.ok(pageEl(), "应切到导演页");
    assert.ok(barBtn("配方") && barBtn("新建配方") && barBtn("素材库") && barBtn("整片编辑器"), "配方条四枚按钮齐");
    assert.equal(tl().opts.getSegments().length, 2, "R1 两段画在时间轴上");
    assert.equal(segLabel().textContent, "第 1 段", "该段行落在第 1 段");
    assert.equal(durIn().value, "3", "时长回显该段配方值");
    assert.equal(promptIn().value, "段一", "提示词回显该段配方值");
    assert.equal(slots().length, 3, "首帧 / 尾帧 / 参考三方块");
    const mainKids = [...document.querySelector(".ns-director-main").children];
    assert.ok(mainKids[1] === promptIn(), "提示词直接吃方块列剩下的宽度");
    assert.ok(mainKids[0].children[1].classList.contains("ns-director-segtop"), "第N段与时长落在方块底下的空带里");
    assert.ok(!slots()[0].classList.contains("ns-hidden") && !slots()[1].classList.contains("ns-hidden"), "f2v 段显首帧 / 尾帧");
    assert.ok(slots()[2].classList.contains("ns-hidden"), "f2v 段藏参考那一行");
    assert.ok(slots()[0].querySelector("img").src.includes("seed1.png"), "首帧画面用 spec 解析进 input/ 的那张");
    assert.equal(sizeLabel().textContent, "640×384 · 20 步", "尺寸只回显 spec defaults");
    assert.ok(mediaEl().classList.contains("ns-director-idle") && mediaEl().querySelector(".ns-director-idle-card"), "没跑着时起手卡占位");
    assert.equal(getComputedStyle(liveBox()).display, "none", "预览容器起手隐藏");
    assert.ok((runBtn().textContent || "").includes("生成整片"), "生成钮文案");
    assert.equal(cancelBtn().style.display, "none", "取消按钮起手隐藏");
});

test("导演页：顶栏切配方 → 段数 / 该段行 / 尺寸回显跟着换", async () => {
    await boot();
    await openDirector();
    await pickRecipe("R2");
    assert.equal(tl().opts.getSegments().length, 3, "R2 三段换到时间轴");
    assert.equal(segLabel().textContent, "第 1 段", "切配方回到第 1 段");
    assert.equal(promptIn().value, "甲", "该段行换成新配方的第 1 段");
    assert.equal(sizeLabel().textContent, "1344×768 · 8 步", "尺寸回显新配方 defaults");
});

test("导演页：时间轴点第 2 段 → 该段行与素材槽家族跟着换", async () => {
    await boot();
    await openDirector();
    await pickRecipe("R2");
    await clickSeg(1);
    assert.equal(segLabel().textContent, "第 2 段", "选中落到第 2 段");
    assert.equal(promptIn().value, "乙", "提示词换成第 2 段");
    assert.ok(slots()[2].classList.contains("ns-hidden") === false, "r2v 段显参考那一行");
    assert.ok(slots()[0].classList.contains("ns-hidden"), "r2v 段藏首帧方块");
    assert.ok(slots()[1].classList.contains("ns-hidden"), "r2v 段藏尾帧方块");
    assert.equal(tl()._selected, 1, "时间轴选中同一块");
});

test("导演页：预设配方只读 —— 该段控件停用、方块不画取用钮、生成整片点了不发", async () => {
    await boot();
    await openDirector();
    await pickRecipe("预设片");
    assert.ok(saveBtn().disabled, "预设配方禁用保存该段");
    assert.ok(durIn().disabled && promptIn().disabled, "预设配方停用时长与提示词");
    assert.equal(slots()[2].querySelector(".ns-slot-add"), null, "预设配方不画取用钮");
    assert.ok(statusEl().textContent.includes("只读"), "状态行给出只读说法");
    click(runBtn());
    await settle();
    await settle();
    assert.equal(posts("/neo_studio/director/generate").length, 0, "预设配方点了不发整片");
});

test("导演页：勾选只跑勾选的段（payload only_segments）+ 勾选提示", async () => {
    await boot();
    await openDirector();
    await pickRecipe("R2");
    assert.ok(checkHint().textContent.includes("未勾选"), "起手未勾选 = 整片");
    await clickCheck(0);
    await clickCheck(2);
    assert.ok(checkHint().textContent.includes("[1,3]"), `勾选提示列出勾选段：${checkHint().textContent}`);
    assert.deepEqual(tl().getChecked(), [0, 2], "勾选态落在时间轴上");
    click(runBtn());
    await settle();
    await settle();
    assert.equal(posts("/neo_studio/director/generate").length, 1, `生成整片提交一次（状态：${statusEl()?.textContent}）`);
    assert.equal(genBody().only_segments, "1,3", "只带勾选的 1、3 段");
    assert.equal(genBody().recipe, "R2", "整片 = 当前配方");
});

test("导演页：方块取用先过闸 —— 技能不收的类型不落盘，过了闸的 copy_to_input 进槽", async () => {
    await boot();
    await openDirector();
    await pickRecipe("R2");
    await clickSeg(1);
    await pickIntoSlot(2, "clip.mp4");
    assert.equal(copies().length, 0, "被挡下的不 copy_to_input，input 目录不留用不上的文件");
    assert.ok((document.getElementById("ns-toast")?.textContent || "").includes("该技能模板没有参考视频槽位"), `挡下要说清楚：${document.getElementById("ns-toast")?.textContent}`);
    assert.equal(slots()[2].querySelectorAll(".ns-slot-tile.has-img").length, 0, "被挡下的不进槽（行里那枚添图方块不算内容）");
    await pickIntoSlot(2, "a.png");
    await until(() => copies().length === 1, "参考图过闸才落盘");
    assert.ok(String(copies()[0].query).includes("a.png"), "copy_to_input 带原文件名");
    assert.ok(slots()[2].querySelector(".ns-slot-tile img").src.includes("copied_a.png"), "槽里显示 copy 后的文件名");
    assert.ok(saveBtn().classList.contains("ns-director-dirty"), "槽位改动标脏，由用户决定写回配方");
});

test("导演页：保存该段写回配方 —— refs 进段、新素材进 assets、不新增段", async () => {
    await boot();
    await openDirector();
    await pickRecipe("R2");
    await clickSeg(1);
    await pickIntoSlot(2, "a.png");
    click(saveBtn());
    await settle();
    await settle();
    assert.equal(posts("/rs_recipes/save").length, 1, "保存走 /rs_recipes/save");
    const body = saveBodies.at(-1);
    assert.equal(body.name, "R2", "保存写回当前配方");
    assert.equal(body.type, "video_director", "保存声明这一份是导演配方");
    assert.equal(body.segments.length, 3, "保存该段不新增段");
    assert.deepEqual(body.segments[1].refs?.images, ["copied_a.png"], "该段 refs 写的是解析进 input/ 的名");
    assert.ok(["copied_a.png", { filename: "copied_a.png", subfolder: "", type: "input", kind: "image" }].some((a) => JSON.stringify(body.assets).includes(JSON.stringify(a))), "新素材进配方 assets/");
    assert.equal(body.segments[0].prompt, "甲", "没动的段原样带回去");
    assert.ok(statusEl().textContent.includes("已保存"), "状态行确认已保存");
    assert.ok(!saveBtn().classList.contains("ns-director-dirty"), "写回后清脏标记");
});


test("导演页：成片替换预览只发生一次，进度与取消收起", async () => {
    await boot();
    await openDirector();
    await startRun();
    setRunning();
    wsSend("rs.director.status", { ...statusState });
    await settle();
    const frame = `data:image/jpeg;base64,${Buffer.from("f1").toString("base64")}`;
    wsSend("rs.h3.preview", { node_id: "task-1", frames: [frame], fps: 10, w: 20, h: 10 });
    await until(() => liveBox().querySelector("img"), "预览帧先上屏");
    setSucceeded();
    wsSend("rs.director.status", { ...statusState });
    await until(() => document.querySelector("video.ns-gen-final"), "成片替换实时预览");
    const video = document.querySelector("video.ns-gen-final");
    assert.ok(video.src.includes("/view"), "成片走 /view 直链播放");
    assert.equal(barEl().style.display, "none", "完成后收起进度条");
    assert.equal(cancelBtn().style.display, "none", "完成后收起取消按钮");
    assert.ok(statusEl().textContent.includes("已完成"), "状态行确认完成");
    wsSend("rs.director.status", { ...statusState });   // 终态可能经 WS 与在途轮询重复到达
    await settle();
    assert.equal(document.querySelectorAll("video.ns-gen-final").length, 1, "成片只替换一次");
    assert.equal(document.querySelector("video.ns-gen-final"), video, "成片播放器留在原位");
});

test("导演页：轮询拿到终态 → 停轮询；终态落地后在途轮询的旧 running 不得复活界面", async () => {
    await boot();
    await openDirector();
    // 快照路由按请求时刻取状态：在途轮询落地时 WS 终态早已落地，载荷是过期的 running
    setRunning();
    mockRoute("/neo_studio/director/task-1", async () => {
        const stale = { ...statusState };
        await sleep(60);
        return statusPayload(stale);
    });
    await startRun();
    await until(() => statusEl().textContent.includes("生成中"), "轮询驱动生成中状态");
    assert.equal(cancelBtn().style.display, "", "生成中取消按钮可见");
    setSucceeded();
    wsSend("rs.director.status", { ...statusState });
    await until(() => document.querySelector("video.ns-gen-final"), "WS 终态出现成片播放器");
    await sleep(120);   // 在途轮询与已触发的轮次带着旧 running 陆续落地
    assert.ok(document.querySelector("video.ns-gen-final"), "成片播放器留在原位");
    assert.ok(statusEl().textContent.includes("已完成"), "状态停在已完成");
    assert.equal(barEl().style.display, "none", "进度条不得复活");
    assert.equal(cancelBtn().style.display, "none", "取消按钮不得复活（点下去只会拿到「任务已结束」）");
});

test("导演页：取消 = POST 取消路由 + 乐观落「已取消」", async () => {
    await boot();
    await openDirector();
    await startRun();
    assert.equal(cancelBtn().style.display, "", "排队中取消按钮可见");
    click(cancelBtn());
    await settle();
    assert.equal(posts("/neo_studio/director/task-1/cancel").length, 1, "取消打本页的取消路由");
    assert.equal(cancelHits, 1, "取消只打一次");
    assert.ok(statusEl().textContent.includes("已取消"), "取消先乐观落状态：入队前的取消没有 WS 事件可等");
    assert.equal(cancelBtn().style.display, "none", "取消后收起取消钮");
});

test("导演页：配方管理弹窗（卡片铺好 / 列表刷新不自动关 / ✕ 收起）", async () => {
    await boot();
    await openDirector();
    click(barBtn("配方"));
    await until(() => recipesModal() && recipesModal().querySelector(".neo-recipes-card"), "弹窗里铺好配方卡片");
    assert.notEqual(getComputedStyle(recipesModal()).display, "none", "弹窗打开");
    assert.equal(recipesModal().querySelectorAll(".neo-recipes-card").length, 3, "三张导演配方卡（含预设）");
    await sleep(60);
    assert.notEqual(getComputedStyle(recipesModal()).display, "none", "列表刷新后弹窗不得自己关掉");
    click(recipesModal().querySelector(".ns-libmodal-close"));
    await settle();
    assert.ok(recipesModal().classList.contains("ns-hidden"), "✕ 收起弹窗（关窗是 ns-hidden，jsdom 里没有样式表可比 display）");
});

test("导演页：整片编辑器保存后重读该配方并选中它", async () => {
    await boot();
    await openDirector();
    const loadsBefore = loads("R1");
    click(barBtn("整片编辑器"));
    await settle();
    await settle();
    assert.ok(document.querySelector(".neo-director-overlay"), "编辑器以浮层打开（页面顶栏不再有整片按钮）");
    await until(() => document.querySelector(".neo-director-overlay .neo-director-save"), "编辑器铺好底部保存钮");
    click(document.querySelector(".neo-director-overlay .neo-director-save"));
    await settle();
    await settle();
    assert.equal(posts("/rs_recipes/save").length, 1, "编辑器底部保存走 /rs_recipes/save");
    await until(() => loads("R1") > loadsBefore, "保存后本页重读该配方");
    assert.equal(recipeSel().value, "R1", "保存后顶栏下拉选中这一份");
    assert.ok(!document.querySelector(".neo-director-overlay"), "保存后关掉编辑器");
});

test.afterEach(() => {
    document.body.innerHTML = "";
});
test.afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
});


