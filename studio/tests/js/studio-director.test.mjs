// Neo Studio 导演页：配方条（下拉快切 / 配方管理弹窗 / 新建 / 素材库 / 高级模式）+ 出片区（实时预览舞台 + 状态行）
// + 生成坞（紧凑时间轴 + 该段行 + 首帧 / 尾帧 / 参考三块素材槽 + 模型链覆盖 + 保存该段 + 生成）。
// 页内写路径只有一条：段写 director.js 的 createSegmentOps，落盘走同一条 ops.save；整片参数在「分辨率」胶囊弹的表单里改。
// studio-app.js 顶层会取 #ns-view 并连 WebSocket，导入前必须先备好 DOM 与 WS 桩。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, mockRoute, clearRoutes, jsonResponse, sleep, click, fire, fetchLog, setConfirmAnswer } from "./setup.mjs";
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
const selSeg = () => tl()._selected;   // 该段面板落在哪一段：时间轴组件的选中态就是这一页的 selected
const checkHint = () => document.querySelector(".ns-director-checkhint");
const sizeLabel = () => document.querySelector(".ns-director-size .neo-gallery-gm-chip-label");
const sizeBtn = () => document.querySelector(".ns-director-size");
const sizePanel = () => document.querySelector(".ns-director-size-panel");
const sizeSaveBtn = () => document.querySelector(".ns-director-size-save");
const sharedField = (cls) => sizePanel().querySelector(cls);
const slots = () => [...document.querySelectorAll(".ns-director-slots .ns-slot")];
const slotAdd = () => [...document.querySelectorAll(".ns-director-slots .ns-slot-add")];
const skillSel = () => document.querySelector(".ns-director-skill");
const skillBtn = () => document.querySelector(".ns-director-skill").closest(".neo-gallery-gm-chip-wrap").querySelector(".neo-gallery-gm-chip-btn");
const skillPanel = () => document.querySelector(".ns-director .neo-gallery-gm-skills-panel");
const skillItem = (name) => [...skillPanel().querySelectorAll(".neo-gallery-gm-skill-item")].find((b) => b.textContent.includes(name));
const skillGroups = () => [...skillPanel().querySelectorAll(".neo-gallery-gm-skill-group")].map((g) => g.textContent.trim());
const skillModelSel = () => skillPanel().querySelector(".rs-gen-model-section select");   // 右栏第一行 = 生视频模型
const skillStepsIn = () => skillPanel().querySelector("input.rs-gen-steps");
const skillLoraRows = () => [...skillPanel().querySelectorAll(".rs-gen-lora-row")];
const segMenu = () => document.querySelector(".ns-director-segmenu");
const segMenuItem = (label) => [...segMenu().querySelectorAll(".ns-btn")].find((b) => b.textContent.includes(label));
const tlHost = () => document.querySelector(".ns-director-timeline");
const tl = () => tlHost().__neoDirectorTimeline;
// 段操作的入口是时间轴段块右上角画在画布上的那枚 ⋯：用例走组件交给宿主的回调（无布局引擎里点不出画布上的点），
// rect 就是组件算好的 glyph 视口矩形，菜单要弹在它旁边
const openSegMenu = async (i) => { tl().opts.onSegMenu(i, { left: 120, top: 60, right: 138, bottom: 71 }); await settle(); };
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
// 技能的 mode 是后端 frontmatter 那一档细值（t2v / i2v / … / r2v），生成模式 f2v 的池收全部帧模式技能
const SKILL = { id: "sk-a", name: "技能 A", cn_name: "技能 A", gen_video: true, mode: "t2v", gen_config: { ref_kinds: ["image"] } };
const SKILL_R2V = { id: "sk-r", name: "技能 R", cn_name: "技能 R", gen_video: true, mode: "r2v", gen_config: { ref_kinds: ["image", "video", "audio"] } };
const SKILL_MF = { id: "sk-mf", name: "多帧技能", cn_name: "多帧技能", gen_video: true, mode: "t2v", multi_frame: true, gen_config: { ref_kinds: ["image"] } };
// 技能 config 钉的模型链：导演页点一列里的技能就把右栏整份铺成这一套（与视频页同一语义）
const SKILL_CFG = {
    "sk-r": { model: "h3/model_b.safetensors", steps: 12, loras: [{ name: "h3/style_lora.safetensors", strength: 0.5 }] },
    "sk-mf": { steps: 8 },
};
const RECIPE_BY_NAME = {
    R1: { name: "R1", type: "video_director", source: "user", shared: { mode: "f2v", seed: 4242 }, assets: [], loras: [],
        segments: [{ skill_id: "sk-a", prompt: "段一", duration_sec: 3, first_frame: "seed1.png" },
            { skill_id: "sk-a", prompt: "段二", duration_sec: 4 }] },
    R2: { name: "R2", type: "video_director", source: "user", shared: { mode: "f2v" }, assets: [], loras: [],
        segments: [{ skill_id: "sk-a", prompt: "甲", duration_sec: 2 },
            { skill_id: "sk-a", prompt: "乙", duration_sec: 2, mode: "r2v" },
            { skill_id: "sk-a", prompt: "丙", duration_sec: 2 }] },
    // 整片全参考（shared.mode = r2v）+ 分块关掉：每一段都走参考那一行，槽位不再露首帧 / 尾帧
    R3: { name: "R3", type: "video_director", source: "user", shared: { mode: "r2v", chunk_sec: 0 }, assets: [], loras: [],
        segments: [{ skill_id: "sk-r", prompt: "参考甲", duration_sec: 2, refs: { images: ["a.png"] } },
            { skill_id: "sk-r", prompt: "参考乙", duration_sec: 3, refs: { videos: ["clip.mp4"] } }] },
    预设片: { name: "预设片", type: "video_director", source: "preset", shared: { mode: "r2v" }, assets: [], loras: [],
        segments: [{ skill_id: "sk-a", prompt: "预设段", duration_sec: 4, refs: { images: ["p1.png"] } }] },
    // 混配方（旧版整片编辑器的写法：整片钉 mixed，各段钉各自的技能）：本页落首段那一枚，逐段槽位跟着该段模式切
    RM: { name: "RM", type: "video_director", source: "user", shared: { mode: "mixed" }, assets: [], loras: [],
        segments: [{ skill_id: "sk-a", prompt: "混甲", duration_sec: 2, first_frame: "seed1.png" },
            { skill_id: "sk-r", prompt: "混乙", duration_sec: 2, mode: "r2v", refs: { images: ["a.png"] } }] },
    // 旧版整片编辑器留下的写法：每段都记了一张尾帧（含中间段）。本页只认最后一段那张
    尾帧片: { name: "尾帧片", type: "video_director", source: "user", shared: { mode: "f2v" }, assets: [], loras: [],
        segments: [{ skill_id: "sk-a", prompt: "甲段", duration_sec: 2, first_frame: "seed1.png", last_frame: "tail_a.png" },
            { skill_id: "sk-a", prompt: "乙段", duration_sec: 2, first_frame: "seed2.png", last_frame: "tail_b.png" }] },
};
const SPEC_BY_RECIPE = {
    R1: { segments: [{ ref_input: "seed1.png", last_input: "" }], defaults: { width: 640, height: 384, steps: 20 } },
    R2: { segments: [{}, {}, {}], defaults: { width: 1344, height: 768, steps: 8 } },
    R3: { segments: [{ refs: { images: ["a.png"] } }, { refs: { videos: ["clip.mp4"] } }], defaults: { width: 1024, height: 576, steps: 12 } },
    预设片: { segments: [{ refs: { images: ["p1.png"] } }], defaults: { width: 512, height: 896, steps: 8 } },
    RM: { segments: [{ ref_input: "seed1.png", last_input: "" }, { refs: { images: ["a.png"] } }], defaults: { width: 1024, height: 576, steps: 12 } },
    尾帧片: { segments: [{ ref_input: "seed1.png", last_input: "tail_a.png" }, { ref_input: "seed2.png", last_input: "tail_b.png" }], defaults: { width: 1024, height: 576, steps: 12 } },
};
const RECIPE_FIXTURE = structuredClone(RECIPE_BY_NAME);
const SPEC_FIXTURE = structuredClone(SPEC_BY_RECIPE);
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
    // 新建用例会在桩里的配方表长出真配方（save 桩认新名字 = 后端在 CUSTOM_DIR 建一份）：逐用例复位回 fixture，
    // 不落进后面的用例（「六张导演配方卡」那类断言认的就是 fixture 的份数）
    for (const k of Object.keys(RECIPE_BY_NAME)) delete RECIPE_BY_NAME[k];
    Object.assign(RECIPE_BY_NAME, structuredClone(RECIPE_FIXTURE));
    for (const k of Object.keys(SPEC_BY_RECIPE)) delete SPEC_BY_RECIPE[k];
    Object.assign(SPEC_BY_RECIPE, structuredClone(SPEC_FIXTURE));
    mockRoute("/neo_studio/version", jsonResponse({ success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [] }));
    mockRoute("/rs_recipes/list", () => jsonResponse(Object.values(RECIPE_BY_NAME)));
    mockRoute("/rs_recipes/load", (body) => jsonResponse({ success: true, recipe: RECIPE_BY_NAME[body.name] || null }));
    mockRoute("/rs_recipes/director_spec", (b, call) => jsonResponse({ success: true, ...(SPEC_BY_RECIPE[call.query.get("name")] || SPEC_BY_RECIPE.R1) }));
    mockRoute("/rs_recipes/save", (body) => {
        saveBodies.push(body);
        // 新名字 = 后端在 CUSTOM_DIR 里建一份：桩里的配方表跟着长，本页新建后 openRecipe / 列表才读得回刚落盘的那一份。
        // 已有名字只记请求体——种子数据不动，后面的用例照旧从 fixture 起
        if (body.type === "video_director" && !RECIPE_BY_NAME[body.name]) {
            RECIPE_BY_NAME[body.name] = {
                name: body.name, type: "video_director", source: "user", assets: [], loras: [],
                shared: { seed: 0, ...(body.shared || {}) },
                segments: (body.segments || []).map((s) => ({ ...s })),
            };
            SPEC_BY_RECIPE[body.name] = { segments: (body.segments || []).map(() => ({})), defaults: { width: 960, height: 544, steps: 20 } };
        }
        return jsonResponse({ success: true, name: body.name });
    });
    mockRoute("/rs_prompts/skills", jsonResponse([SKILL, SKILL_R2V, SKILL_MF]));
    mockRoute("/neo_video_gen/director_progress", jsonResponse({ active: false, segment_index: -1, total_segments: 0, step: 0, total_steps: 0 }));
    mockRoute("/neo_video_gen/models", jsonResponse({
        diffusion_models: ["h3/model_a.safetensors", "h3/model_b.safetensors"],
        text_encoders: ["qwen3vl.safetensors"], vae: ["vae.safetensors"], loras: ["h3/style_lora.safetensors"],
    }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => jsonResponse(SKILL_CFG[call.query.get("skill_id")] || {}));
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

async function boot(layout = null, noRecipes = false) {
    resetEnv();
    clearRoutes();
    bootMocks();
    // 首页版式桩：传了就让「添加卡片」里那张预设卡排上首页（宫格图分镜卡的直达用例要它出格）
    if (layout) mockRoute("/neo_home/layout", jsonResponse(layout));
    // 盘上一份导演配方都没有：清空桩里的配方表再建页（save 桩认新名字，新建之后列表与 load 才读得回落盘的那一份）
    if (noRecipes) {
        for (const k of Object.keys(RECIPE_BY_NAME)) delete RECIPE_BY_NAME[k];
        for (const k of Object.keys(SPEC_BY_RECIPE)) delete SPEC_BY_RECIPE[k];
    }
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

test("导演页：生成整片 payload = 配方名 + 配方记的种子 + 模型链覆盖（顶层键）；起手卡先占位", async () => {
    await boot();
    await openDirector();
    click(skillBtn());
    await settle();
    const modelSel = document.querySelector(".ns-director-skill-panel select");
    modelSel.value = "h3/model_b.safetensors";
    fire(modelSel, "change");
    await startRun();
    assert.equal(posts("/neo_studio/director/generate").length, 1, `生成整片提交一次（状态：${statusEl()?.textContent}；命中 ${posts("/neo_studio/director/generate").length}；POST 路径 ${fetchLog.filter((c) => c.method === "POST").map((c) => c.path).join("|")}）`);
    assert.equal(genBody().recipe, "R1", "整片 = 当前配方名（后端按名从盘上读）");
    assert.equal(genBody().seed, 4242, "生成整片带的种子就是配方记的那一个：种子只在整片参数表单里，生成坞没有第二枚");
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
    assert.ok(barBtn("配方管理") && barBtn("新建配方") && barBtn("素材库") && barBtn("高级模式"), "配方条四枚按钮齐");
    assert.equal(barBtn("配方管理").textContent.trim(), "配方管理",
        "顶栏那枚叫「配方管理」：快速换配方是上方那名下拉，两枚不同名");
    assert.ok(!document.querySelector(".neo-director-overlay"), "进页不出整片编辑器浮层：高级模式要用户自己点");
    assert.equal(tl().opts.getSegments().length, 2, "R1 两段画在时间轴上");
    assert.equal(selSeg(), 0, "该段面板落在第 1 段");
    assert.equal(promptIn().value, "段一", "提示词回显该段配方值");
    assert.equal(slots().length, 3, "首帧 / 尾帧 / 参考三方块");
    const mainKids = [...document.querySelector(".ns-director-main").children];
    assert.ok(mainKids[1] === promptIn(), "提示词直接吃方块列剩下的宽度");
    assert.ok(!document.querySelector(".ns-director-seg-label") && !document.querySelector(".ns-director-duration"),
        "段号与秒数不在该段行重复一遍：只在时间轴块上显示、拖右缘调");
    assert.ok(!slots()[0].classList.contains("ns-hidden"), "f2v 段显首帧");
    assert.ok(slots()[1].classList.contains("ns-hidden"), "尾帧只给最后一段：共 2 段时该段行落在第 1 段，尾帧方块不露");
    assert.ok(slots()[2].classList.contains("ns-hidden"), "f2v 段藏参考那一行");
    assert.ok(slots()[0].querySelector("img").src.includes("seed1.png"), "首帧画面用 spec 解析进 input/ 的那张");
    assert.equal(sizeLabel().textContent, "640×384", "尺寸回显 = spec defaults 的宽×高（步数与生成模式都在技能那一列，不进尺寸名）");
    assert.ok(mediaEl().classList.contains("ns-director-idle") && mediaEl().querySelector(".ns-director-idle-card"), "没跑着时起手卡占位");
    assert.equal(getComputedStyle(liveBox()).display, "none", "预览容器起手隐藏");
    assert.equal(runBtn().textContent.trim(), "生成", "生成钮文案：跑哪几段写在提示行上，按钮不重复那句长文案");
    assert.equal(cancelBtn().style.display, "none", "取消按钮起手隐藏");
});
test("导演页新建配方：顶栏「新建配方」在本页落一份一段配方，不开整片编辑器浮层", async () => {
    await boot();
    await openDirector();
    click(barBtn("新建配方"));
    await until(() => recipeSel().value === "未命名配方", "新配方落在本页的配方下拉上");
    assert.ok(!document.querySelector(".neo-director-overlay"), "不开整片编辑器浮层：配方就在本页长出来");
    const saves = posts("/rs_recipes/save");
    assert.equal(saves.length, 1, "新建就落盘一次：页内写路径就是 ops.save 那一条");
    const body = saves[0].body;
    assert.equal(body.type, "video_director", "落盘声明这一份是导演配方");
    assert.equal(body.segments.length, 1, "新建起一段，不铺一张空段落表");
    assert.equal(body.segments[0].skill_id, "sk-a", "首段钉默认技能（关键帧家族里步数最少的可用技能，同后端 _default_video_skill）");
    assert.equal(body.seed, undefined, "页上不带种子：整片参数表单里那一格才是这一发的种子");
    assert.equal(body.shared.seed, -1, "起手种子是随机（-1），不是上一份配方里那个 4242");
    assert.equal(body.shared.width, 960, "整片参数取本页默认口径（16:9 @ 0.5 百万像素）的宽");
    assert.equal(body.shared.height, 544, "...那一份的高");
    assert.ok(loads("未命名配方") >= 1, "落盘后本页重读这份：生成整片与素材槽从这一刻起可用");
    assert.equal(tl().opts.getSegments().length, 1, "时间轴上就是刚落盘那一段");
    assert.equal(selSeg(), 0, "该段面板落在第 1 段");
    assert.equal(promptIn().disabled, false, "该段提示词框可写");
    assert.equal(document.activeElement, promptIn(), "焦点交给提示词框：新建完就是接着写");
    assert.equal(saveBtn().disabled, false, "「保存该段」可点");
    assert.equal(sizeLabel().textContent, "960×544", "尺寸胶囊回显这份新配方的 defaults");
    assert.ok(statusEl().textContent.includes("已新建配方"), `状态行说出新建的是哪一份：${statusEl().textContent}`);
});

test("导演页新建配方：顶栏与配方管理里的新增连着点，名字往后排数字、不盖盘上那份", async () => {
    await boot();
    await openDirector();
    click(barBtn("新建配方"));
    await until(() => recipeSel().value === "未命名配方", "顶栏新建落在本页");
    click(barBtn("配方管理"));
    await until(() => recipesModal() && recipesModal().querySelector(".neo-recipes-director"), "弹窗里铺好配方卡与「新增导演配方」");
    click(recipesModal().querySelector(".neo-recipes-director"));
    await until(() => recipeSel().value === "未命名配方2", "弹窗里的「新增导演配方」同样落在本页，名字让开刚落盘的那一份");
    assert.ok(!document.querySelector(".neo-director-overlay"), "两处新增都不开整片编辑器");
    assert.ok(recipesModal().classList.contains("ns-hidden"), "新增先收弹窗：配方就在本页编辑，不在弹窗里");
    assert.deepEqual(posts("/rs_recipes/save").map((c) => c.body.name), ["未命名配方", "未命名配方2"], "两次新增各落盘一次，名字不撞");
});



test("导演页：顶栏切配方 → 段数 / 该段行 / 尺寸回显跟着换", async () => {
    await boot();
    await openDirector();
    await pickRecipe("R2");
    assert.equal(tl().opts.getSegments().length, 3, "R2 三段换到时间轴");
    assert.equal(selSeg(), 0, "切配方回到第 1 段");
    assert.equal(promptIn().value, "甲", "该段行换成新配方的第 1 段");
    assert.equal(sizeLabel().textContent, "1344×768", "尺寸回显新配方 defaults");
});

test("导演页：时间轴点第 2 段 → 该段行与素材槽家族跟着换", async () => {
    await boot();
    await openDirector();
    await pickRecipe("R2");
    await clickSeg(1);
    assert.equal(selSeg(), 1, "选中落到第 2 段");
    assert.equal(promptIn().value, "乙", "提示词换成第 2 段");
    assert.ok(slots()[2].classList.contains("ns-hidden") === false, "r2v 段显参考那一行");
    assert.ok(slots()[0].classList.contains("ns-hidden"), "r2v 段藏首帧方块");
    assert.ok(slots()[1].classList.contains("ns-hidden"), "r2v 段藏尾帧方块");
    assert.equal(tl()._selected, 1, "时间轴选中同一块");
});

test("导演页：尾帧只给最后一段 —— 方块只露在最后一段，配方里非最后一段的尾帧起手就清掉", async () => {
    await boot();
    await openDirector();
    await pickRecipe("尾帧片");   // 旧版整片编辑器留下的写法：两段各记了一张尾帧
    assert.ok(slots()[1].classList.contains("ns-hidden"), "该段行落在第 1 段（共 2 段）：尾帧方块不露");
    await clickSeg(1);
    assert.ok(!slots()[1].classList.contains("ns-hidden"), "该段行落在最后一段：尾帧方块露出来");
    await clickSeg(0);
    assert.ok(slots()[1].classList.contains("ns-hidden"), "回到第 1 段：尾帧方块又收起来");
    // 后端是按素材推生成模式的：中间段留一张尾帧就推成首尾帧，跑的却是一个界面上改不到的框
    assert.equal(tl().opts.getSegments()[0].last_frame, undefined, "第 1 段那张旧尾帧不在配方里了");
    assert.equal(tl().opts.getSegments()[1].last_frame, undefined, "末段那张也清掉了：段列一落地就把非最后一段的尾帧收干净");
    tl().opts.onAdd();   // 新增一段：原末段挪到中间
    await settle();
    await settle();
    assert.equal(tl().opts.getSegments().length, 3, "新增一段进配方");
    assert.ok(!slots()[1].classList.contains("ns-hidden"), "该段行落在新增的末段：尾帧方块露出来");
});

test("导演页：预设配方只读 —— 该段控件停用、方块不画取用钮、生成整片点了不发", async () => {
    await boot();
    await openDirector();
    await pickRecipe("预设片");
    assert.ok(saveBtn().disabled, "预设配方禁用保存该段");
    assert.ok(promptIn().disabled, "预设配方停用提示词");
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

test("导演页：取消先过确认 —— 挡下不动队列，确认后 POST 取消路由 + 乐观落「已取消」", async () => {
    await boot();
    await openDirector();
    await startRun();
    assert.equal(cancelBtn().style.display, "", "排队中取消按钮可见");
    setConfirmAnswer(false);
    click(cancelBtn());
    await settle();
    assert.equal(posts("/neo_studio/director/task-1/cancel").length, 0, "确认前不打取消路由");
    assert.equal(cancelBtn().style.display, "", "挡下时取消钮留在原位，用户接着能真取消");
    assert.ok(!statusEl().textContent.includes("已取消"), "挡下时不落「已取消」");
    setConfirmAnswer(true);
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
    click(barBtn("配方管理"));
    await until(() => recipesModal() && recipesModal().querySelector(".neo-recipes-card"), "弹窗里铺好配方卡片");
    assert.notEqual(getComputedStyle(recipesModal()).display, "none", "弹窗打开");
    assert.ok(recipesModal().querySelector(".ns-libmodal-title")?.textContent.includes("导演配方"), "弹窗顶栏就是那一个标题");
    assert.equal(recipesModal().querySelector(".neo-recipes-title"), null, "面板里不再重复一行「配方」标题");
    assert.equal(recipesModal().querySelectorAll(".neo-recipes-card").length, 6, "六张导演配方卡（含预设、混配方与带尾帧那份）");
    await sleep(60);
    assert.notEqual(getComputedStyle(recipesModal()).display, "none", "列表刷新后弹窗不得自己关掉");
    click(recipesModal().querySelector(".ns-libmodal-close"));
    await settle();
    assert.ok(recipesModal().classList.contains("ns-hidden"), "✕ 收起弹窗（关窗是 ns-hidden，jsdom 里没有样式表可比 display）");
});

test("导演页整片参数面板：分辨率胶囊弹出回显配方值，保存走同一条写回链并重读", async () => {
    await boot();
    await openDirector();
    const loadsBefore = loads("R1");
    click(sizeBtn());
    await settle();
    assert.notEqual(sizePanel().style.display, "none", "点分辨率胶囊弹整片参数表单");
    assert.equal(sharedField(".ns-director-shared-seed").value, "4242", "配方记的种子回显在表单里：本页只有这一处种子");
    assert.equal(sharedField(".ns-director-shared-steps"), null, "表单里没有步数：整片每一段跑自己技能钉的那一套");
    assert.equal(sharedField(".ns-director-shared-ctx").value, "", "上下文帧留空 = 22 那一档");
    assert.ok(sharedField(".ns-director-shared-cont").checked, "连续性起手勾着");
    assert.ok(sharedField(".ns-director-shared-ident").checked, "配方没写身份参考 = 角色参考图照常注入每一段");
    assert.match(sharedField(".ns-director-shared-res").textContent, /×/, "非自定义档直接把算好的宽高写在表单里");
    assert.equal(sharedField(".ns-director-shared-chunk-row").style.display, "none", "首段钉的是普通技能：分块秒数不出现");
    sharedField(".ns-director-shared-seed").value = "777";
    sharedField(".ns-director-shared-mp").value = "1";
    fire(sharedField(".ns-director-shared-mp"), "input");
    sharedField(".ns-director-shared-ident").checked = false;
    await settle();
    click(sizeSaveBtn());
    await settle(); await settle();
    const body = saveBodies.at(-1);
    assert.equal(posts("/rs_recipes/save").length, 1, "保存整片参数走「保存该段」同一条 /rs_recipes/save");
    assert.equal(body.shared.seed, 777, "种子写进 shared：本页只有这一处种子");
    assert.ok(!("steps" in body.shared), "保存整片参数不写步数：配方里本来没有就留无");
    assert.equal(body.shared.megapixels, 1, "百万像素写进 shared");
    assert.equal(body.shared.identity_refs, false, "关掉身份参考落进 shared：这份配方不再注入角色参考图");
    assert.equal(body.shared.width % 32, 0, "宽高比 + 百万像素算出的宽按 32 对齐落盘");
    assert.equal(body.shared.height % 32, 0, "高按 32 对齐落盘");
    assert.equal(body.shared.mode, "f2v", "生成模式回显什么就落什么，不被这次保存改掉");
    assert.equal(body.shared.chunk_sec, 15, "分块秒数收起也照落默认那一档：收起不等于不生效（与编辑器收起高级参数同一条口径）");
    assert.equal(body.segments.length, 2, "段表一起交，落盘不留少一段的配方");
    assert.equal(sizePanel().style.display, "none", "保存后收起表单");
    await until(() => loads("R1") > loadsBefore, "落盘后本页重读该配方");
    assert.ok(!saveBtn().classList.contains("ns-director-dirty"), "写回后清脏标记");
    await startRun();
    assert.equal(genBody().seed, 4242, "生成整片只带本页读到的那份配方种子：整片参数表单是唯一一处种子");
});

test("导演页技能胶囊：技能按生成模式分组，选全参考就统一每一段并把该段翻成参考素材那一行", async () => {
    await boot();
    await openDirector();
    assert.ok(skillBtn().textContent.includes("技能 A"), "胶囊标签说出首段钉着的那一个技能");
    click(skillBtn());
    await settle();
    assert.deepEqual(skillGroups(), ["关键帧生视频", "全参考生视频"], "左栏按生成模式分组，分组就是那两档生成模式");
    assert.equal(skillItem("每段用自己的技能"), undefined, "左栏没有「每段用自己的技能」那一行，也没有混合那一组");
    click(skillItem("技能 R"));
    await settle();
    assert.ok(saveBtn().classList.contains("ns-director-dirty"), "换统一技能算未保存的改动");
    assert.ok(!isHidden(slots()[2]), "全参考：该段素材槽翻成参考素材那一行");
    assert.ok(isHidden(slots()[0]) && isHidden(slots()[1]), "全参考：首帧 / 尾帧方块收起来");
    click(saveBtn());
    await settle(); await settle();
    const body = saveBodies.at(-1);
    assert.equal(body.shared.mode, "r2v", "生成模式跟着所选技能那一组落盘");
    assert.deepEqual(body.segments.map((s) => s.skill_id), ["sk-r", "sk-r"], "统一技能写进每一段（走的还是段写那一条）");
});

test("导演页混配方：技能胶囊落首段那一枚，不动它保存就一段都不写", async () => {
    await boot();
    await openDirector();
    await pickRecipe("RM");   // 首段钉 sk-a、第二段钉 sk-r，整片钉的是旧版的 mixed
    assert.ok(skillBtn().textContent.includes("技能 A"), "各段钉的不是同一个：胶囊落首段那一枚技能");
    assert.equal(skillSel().value, "sk-a", "选中值同样落首段那一枚：没有「每段用自己的技能」可落");
    click(saveBtn());
    await settle(); await settle();
    const body = saveBodies.at(-1);
    assert.deepEqual(body.segments.map((s) => s.skill_id), ["sk-a", "sk-r"], "没动技能胶囊就一段都不写：各段照跑自己钉的技能");
    assert.equal(body.shared.mode, "mixed", "旧混配方的 mixed 原样留在 shared：本页不写这一档也不动它");
    await clickSeg(1);
    assert.ok(!isHidden(slots()[2]) && isHidden(slots()[0]) && isHidden(slots()[1]),
        "该段素材槽逐段跟着该段自己钉的模式切：第二段是全参考那一行");
});

test("导演页技能胶囊：选多帧技能后整片参数表单里露出分块秒数，保存一起落盘", async () => {
    await boot();
    await openDirector();
    click(sizeBtn());
    await settle();
    assert.equal(sharedField(".ns-director-shared-chunk-row").style.display, "none", "首段钉的是普通技能：分块秒数不出现");
    click(skillBtn());
    await settle();
    click(skillItem("多帧技能"));
    await settle();
    click(sizeBtn());   // 收起再弹：整片参数表单在弹开那一刻按「当前生效技能」重算分块秒数的显隐
    await settle();
    click(sizeBtn());
    await settle();
    assert.notEqual(sharedField(".ns-director-shared-chunk-row").style.display, "none", "多段 + 多帧技能：分块秒数露出来");
    sharedField(".ns-director-shared-chunk").value = "20";
    click(sizeSaveBtn());
    await settle(); await settle();
    const body = saveBodies.at(-1);
    assert.equal(body.shared.chunk_sec, 20, "分块秒数进 shared");
    assert.equal(body.shared.mode, "f2v", "关键帧那一组落 shared.mode");
    assert.deepEqual(body.segments.map((s) => s.skill_id), ["sk-mf", "sk-mf"], "统一技能写进每一段");
});

test("导演页技能胶囊：右栏铺该技能钉的模型链，切到没钉配置的技能清空回自动", async () => {
    await boot();
    await openDirector();
    click(skillBtn());
    await settle();
    click(skillItem("技能 R"));
    await settle(); await settle();   // 该技能 config 要过一次 skill_config 才铺进右栏
    assert.equal(skillModelSel().value, "h3/model_b.safetensors", "主模型铺成该技能钉的那一颗");
    assert.equal(skillStepsIn().value, "12", "步数铺该技能钉的那一发");
    assert.equal(skillLoraRows().length, 1, "LoRA 行铺该技能钉的那一条");
    assert.ok(skillBtn().textContent.includes("model_b"), "胶囊标签说出这一发生效的主模型");
    click(skillItem("技能 A"));
    await settle(); await settle();   // 技能 A 的 config 是空的：右栏要跟着换成这一发真正要跑的那一套
    assert.equal(skillModelSel().value, "", "没钉主模型的技能：右栏清空回自动，这一发跟着各段自己的技能配置跑");
    assert.equal(skillStepsIn().value, "20", "步数回到默认，不留上一枚技能钉的 12");
    assert.equal(skillLoraRows().length, 0, "上一枚技能钉的 LoRA 行不留");
    assert.ok(!skillBtn().textContent.includes("model_b"), "胶囊标签收回这一发不生效的主模型");
});

test("导演页打开配方就把右栏铺成首段钉技能的模型链，这一套走同一条覆盖链进 payload", async () => {
    await boot();
    await openDirector();
    await pickRecipe("R3");   // 两段都钉 sk-r：该技能 config 钉了主模型 / 步数 / LoRA
    await until(() => skillModelSel().value === "h3/model_b.safetensors", "打开配方后右栏铺首段钉技能的主模型");
    assert.equal(skillStepsIn().value, "12", "步数铺该技能钉的那一发");
    await startRun();
    assert.equal(genBody().model, "h3/model_b.safetensors", "铺出来的主模型进 payload（与视频页同一批顶层键）");
    assert.ok(!("steps" in genBody()), "面板没改步数就不发这一项——该技能钉的 12 步在后端跑");
    assert.deepEqual(genBody().loras, [{ name: "h3/style_lora.safetensors", strength: 0.5 }], "铺出来的 LoRA 与强度进 payload");
});

test("导演页整片全参考配方：胶囊回显全参考技能，每一段都走参考素材那一行", async () => {
    await boot();
    await openDirector();
    await pickRecipe("R3");
    assert.ok(skillBtn().textContent.includes("技能 R"), "胶囊标签 = 首段钉的全参考技能");
    assert.ok(isHidden(slots()[0]) && isHidden(slots()[1]), "整片全参考：首帧 / 尾帧方块不露");
    assert.ok(!isHidden(slots()[2]), "参考素材那一行在");
    click(sizeBtn());
    await settle();
    assert.equal(sharedField(".ns-director-shared-chunk").value, "0", "配方落过 0：纯逐段生成回显 0");
});

test("导演页高级模式：整片编辑器以浮层打开，保存后本页重读并选中它", async () => {
    await boot();
    await openDirector();
    const loadsBefore = loads("R1");
    click(barBtn("高级模式"));
    await settle();
    await settle();
    assert.ok(document.querySelector(".neo-director-overlay"), "高级模式开的是整片编辑器浮层");
    await until(() => document.querySelector(".neo-director-overlay .neo-director-save"), "编辑器铺好底部保存钮");
    click(document.querySelector(".neo-director-overlay .neo-director-save"));
    await settle();
    await settle();
    assert.equal(posts("/rs_recipes/save").length, 1, "编辑器底部保存走同一条 /rs_recipes/save");
    await until(() => loads("R1") > loadsBefore, "保存后本页重读该配方");
    assert.equal(recipeSel().value, "R1", "保存后顶栏下拉选中这一份");
    assert.ok(!document.querySelector(".neo-director-overlay"), "保存后关掉编辑器");
});

// 首页「宫格图分镜」卡的落点：装配层给它自己那一页（无顶栏页签），页上只铺编辑器现成的那一面
// （角色参考图 → 宫格拆分 → 逐格提示词 → 各段对照），不新建页面内容、不新建第二套拆分链
test("首页「宫格图分镜」卡：落自己那一页，编辑器内嵌铺好——无浮层、无页签、时间线那一面收起", async () => {
    await boot({ order: { create: ["storyboard"] } });
    const card = document.querySelector('.ns-home-card[data-card-id="storyboard"]');
    assert.ok(card, "版式排过这张卡，首页才出这一发：默认首页上不给它占格");
    click(card);
    await settle(); await settle();
    assert.equal(location.hash, "#/storyboard", "卡片落自己那一页：不是一发弹窗");
    const page = document.querySelector(".ns-storyboard");
    assert.ok(page && !isHidden(page), "显示的就是故事板页视图");
    assert.ok(!document.querySelector('nav .ns-tab[data-tab="storyboard"]'), "顶栏不给这一页页签：入口只有首页那一发");
    assert.ok(!document.querySelector(".neo-director-overlay"), "没有弹窗");
    await until(() => document.querySelector(".ns-storyboard-host .neo-director-embedded"), "编辑器铺进故事板页的宿主");
    const panel = document.querySelector(".ns-storyboard-host .neo-director-embedded");
    assert.equal(panel.querySelector(".neo-director-name").value, "", "铺的是空白新配方：不认导演页下拉里显示的那一份");
    assert.ok(panel.querySelector(".neo-director-name-empty"), "标题行落「未命名配方」占位：这一页起手就是没名字的新配方");
    assert.equal(recipeSel().value, "R1", "导演页的选中态不动：进这一页不替用户换配方");
    assert.equal(posts("/rs_recipes/save").length, 0, "点卡这一发不落盘：没写完的草稿不预先长出一张卡");
    assert.ok(!panel.querySelector(".neo-director-tabs"), "没有页签栏：这一页只有故事板那一面");
    assert.equal(panel.querySelector(".neo-director-pane-story").style.display, "", "故事板那一面铺满整栏");
    assert.equal(panel.querySelector(".neo-director-pane-timeline").style.display, "none", "时间线那一面收起：这一页不出时间线");
    assert.ok(panel.querySelector(".neo-director-grid-split"), "页上就是现成的宫格拆分那一块：入口不新建第二套拆分");
    assert.ok(panel.querySelector(".neo-director-setup-segs"), "宫格拆分写出来的各段对照块在页上");
    assert.ok(panel.querySelector(".neo-director-name"), "标题行留着配方名：这一页编辑的就是这份配方");
    assert.equal(panel.querySelectorAll(".neo-director-foot .neo-director-save").length, 1, "底部只留「保存」这一发");
    assert.ok(!panel.querySelector(".neo-director-cancel"), "不给「取消」：这一页没有要取消的窗口");
});

test("故事板页：空盘进页铺的也是空白编辑器，一发不落盘；第二下点卡不重建", async () => {
    await boot({ order: { create: ["storyboard"] } }, true);   // 盘上一份导演配方都没有
    const card = document.querySelector('.ns-home-card[data-card-id="storyboard"]');
    click(card);
    await until(() => document.querySelector(".ns-storyboard-host .neo-director-embedded"), "空盘进故事板页也铺好那一面");
    assert.equal(posts("/rs_recipes/save").length, 0,
        `空盘进页一发不落盘：写完点「保存」才建卡（状态：${statusEl()?.textContent}）`);
    assert.equal(recipeSel().value, "", "导演页没有配方时也不替它新建一份：这一页不动那一页的选中态");
    clickTab("home");
    click(card);
    await settle(); await settle();
    assert.equal(document.querySelectorAll(".ns-storyboard-host .neo-director-embedded").length, 1,
        "连点两次只有一套内嵌：回到本页不重建");
});

test("故事板页的素材库按钮：侧栏写入开本页那扇弹窗，不是点下去没反应", async () => {
    await boot({ order: { create: ["storyboard"] } });
    click(document.querySelector('.ns-home-card[data-card-id="storyboard"]'));
    await until(() => document.querySelector(".ns-storyboard-host .neo-director-embedded"), "故事板页铺好内嵌的那一套");
    const panel = document.querySelector(".ns-storyboard-host .neo-director-embedded");
    const opened = () => document.querySelector(".ns-libmodal:not(.ns-hidden)");
    click(panel.querySelector(".neo-director-grid-src-actions .neo-director-ff-lib"));   // 抢跑一步：取用回调经 neo:media-pick 交来
    const shim = await import("../../web/studio/shim/app.js");
    shim.app.extensionManager.sidebarTab.activeSidebarTabId = "neo.gallery";   // media-transfer 那条写入（单测里 scripts/app.js 是通用替身，转交落在 shim 这一层）
    await settle(); await settle();
    assert.ok(opened(), "宫格图素材库开的是现成那扇素材库弹窗：这一页在侧栏写入的门里");
    assert.ok(document.querySelector('.ns-gallery-host[data-lib-scope="storyboard"]'),
        "画廊替这一页上屏，目录浏览记录记在本页那一格：不与导演页串一份");
    click(opened().querySelector(".ns-libmodal-close"));
    await settle();
    assert.ok(!opened(), "✕ 收窗：不留第二套状态");
});


test("故事板页那份空白内嵌是干净的：导演页开全量编辑器时这一页让位", async () => {
    await boot({ order: { create: ["storyboard"] } });
    click(document.querySelector('.ns-home-card[data-card-id="storyboard"]'));
    await until(() => document.querySelector(".ns-storyboard-host .neo-director-embedded"), "故事板页铺好内嵌的那一套");
    await openDirector();   // 进导演页并等首份配方自动选中（R1）
    // 导演页「高级模式」要的是全量编辑器（含时间线那一面）：全窗口只有一份编辑器，这一页那份干净就收回让位
    click(barBtn("高级模式"));
    await settle(); await settle();
    await until(() => document.querySelector(".neo-director-overlay"), "浮层编辑器开在导演页");
    assert.ok(!document.querySelector(".ns-storyboard-host .neo-director-embedded"),
        "故事板页那份内嵌让位：同一份配方不在两处同时钉着");
});

test("导演页该段 ⋯：入口在段块右上角，复制到下面一段、前移改顺序（写回同一条保存链）", async () => {
    await boot();
    await openDirector();                                   // R1 = 段一 / 段二
    assert.ok(!document.querySelector(".ns-director-seg-menu"), "该段行里没有 ⋯ 那枚钮：段操作入口只有时间轴块右上角那一枚");
    await openSegMenu(0);
    assert.notEqual(segMenu().style.display, "none", "点块右上角的 ⋯ 出菜单");
    // fixed 基座由 prompts.css 的 .rs-runtime-menu 给：缺了它 left/top 不生效，菜单变成页面流里的一块、落在页面最左。
    // left/top 取的是组件交来的 glyph 视口矩形（下沿 71 + 6 落在下面），不是鼠标点
    assert.ok(segMenu().classList.contains("rs-runtime-menu"), "⋯ 菜单是 fixed 浮层，位置跟着那枚 glyph");
    assert.equal(parseFloat(segMenu().style.top), 77, "菜单弹在 glyph 矩形下沿");
    click(segMenuItem("复制该段"));
    await settle();
    assert.equal(tl().opts.getSegments().length, 3, "复制多出段三");
    assert.equal(selSeg(), 1, "选中跟着落在复制出来的那一段");
    assert.equal(promptIn().value, "段一", "复制带走该段的提示词");
    assert.ok(saveBtn().classList.contains("ns-director-dirty"), "增段算未保存的改动");
    click(saveBtn());
    await settle(); await settle();
    assert.equal(saveBodies.at(-1).segments.length, 3, "保存交三段（同一条 /rs_recipes/save 链）");
    assert.ok(!saveBtn().classList.contains("ns-director-dirty"), "写回后清脏标记");
    await openSegMenu(1);
    click(segMenuItem("前移一段")); await settle();
    assert.equal(selSeg(), 0, "前移后选中跟着挪");
    click(saveBtn()); await settle(); await settle();
    const order = saveBodies.at(-1).segments.map((s) => s.prompt);
    assert.equal(order.join(" → "), "段二 → 段一", "前移把该段挪到最前，写回同一条保存载荷");
    assert.equal(new Set(order).size, 2, "两段都在，没有丢段");
});

test("导演页该段 ⋯：最后一段删不掉；预设配方撤掉块右上角那枚 ⋯", async () => {
    await boot();
    await openDirector();
    await openSegMenu(0);
    click(segMenuItem("删除该段")); await settle(); await settle();
    assert.equal(tl().opts.getSegments().length, 1, "确认删除后少一段");
    await openSegMenu(0);
    click(segMenuItem("删除该段")); await settle();
    assert.equal(tl().opts.getSegments().length, 1, "最后一段删不掉");
    assert.ok((document.getElementById("ns-toast")?.textContent || "").includes("最后一段"), "挡下时说得出来");
    await pickRecipe("预设片");
    assert.equal(tl().opts.onSegMenu, null, "内置预设只读：菜单五项没有一项能用，段块右上角那枚 ⋯ 跟着撤掉");
});

test("导演页该段 ⋯：重生成该段排第一项，点它进整片编辑器并展开该段那一行的重生成面板", async () => {
    await boot();
    await openDirector();
    await openSegMenu(1);   // 在第 2 段的块右上角点的 ⋯
    const labels = [...segMenu().querySelectorAll(".ns-btn")].map((b) => b.textContent.trim());
    assert.equal(labels.join(" / "), "重生成该段 / 复制该段 / 前移一段 / 后移一段 / 删除该段", "段菜单五项与顺序");
    click(segMenuItem("重生成该段"));
    await settle(); await settle();
    assert.equal(segMenu().style.display, "none", "点完菜单自己收起");
    await until(() => document.querySelector(".neo-director-overlay .neo-director-seg-regen-panel"), "编辑器展开该段的重生成面板");
    const rows = [...document.querySelectorAll(".neo-director-overlay .neo-director-seg")];
    const panel = document.querySelector(".neo-director-overlay .neo-director-seg-regen-panel");
    assert.equal(rows.length, 2, "打开的是本页当前那份配方，没有多开一份编辑器");
    assert.ok(rows[1].contains(panel), "面板落在第 2 段那一行：从第 2 段的块上点的 ⋯，重生成就是那一段");
    assert.ok(rows[1].classList.contains("neo-director-seg-current"), "编辑器同时定位到该段（不是默认第 1 段）");
    assert.ok(panel.querySelector(".neo-director-regen-run"), "展开的是高级模式那一行的同一块重生成面板，页里没有第二份实现");
    click(document.querySelector(".neo-director-overlay .neo-director-close"));
    await settle();
    assert.ok(!document.querySelector(".neo-director-overlay"), "用例收尾关掉浮层：director.js 的编辑器单例不留活窗口");
});

test("共享段操作（director.js createSegmentOps）：新段跟上一段、重排只认全长顺序表、只读挡写", async () => {
    const { createSegmentOps, directorAssetRefs } = await import(`../../web/director.js?ops=${seq++}`);
    const recipe = { name: "X", source: "user", assets: [{ file: "seed1.png" }], loras: [],
        segments: [{ skill_id: "sk-a", mode: "r2v", prompt: "甲", duration_sec: 2, refs: { images: ["seed1.png"] } }] };
    let changed = 0;
    const ops = createSegmentOps(() => recipe, { onChange: () => { changed++; } });
    assert.equal(ops.add(), 1, "追加一段返回新段下标");
    assert.equal(recipe.segments[1].mode, "r2v", "新段跟上一段的模式：混配方不突然换家族");
    assert.equal(ops.duplicate(0), 1, "复制落在该段下面");
    assert.deepEqual(recipe.segments[1].refs.images, ["seed1.png"], "复制带走参考素材");
    recipe.segments[1].refs.images.push("copied_b.png");
    assert.deepEqual(recipe.segments[0].refs.images, ["seed1.png"], "两段各一份素材表，互不影响");
    assert.ok(ops.move(1, -1), "前移一位");
    assert.ok(!ops.move(0, -1), "越界的前移不动配方");
    assert.equal(ops.remove(0)?.prompt, "甲", "删除返回删掉的那段");
    assert.ok(!ops.reorder([2, 0]), "缺号的顺序表不动配方");
    assert.ok(ops.reorder([1, 0]), "覆盖全部段的顺序表生效");
    assert.ok(ops.isDirty(), "每一步改动都算未保存");
    assert.equal(changed, 5, "改动逐条报给宿主重画");
    ops.clearDirty();
    assert.ok(!ops.isDirty(), "宿主清脏后干净");
    assert.equal(ops.applySkill("sk-b"), 2, "统一技能写满每一段");
    assert.equal(recipe.segments[1].skill_id, "sk-b", "每段换的是 skill_id，提示词与素材不动");
    assert.equal(ops.applySkill(""), 0, "空技能 id 一段都不写");
    assert.ok(ops.isDirty(), "统一技能算未保存");
    ops.clearDirty();
    const preset = createSegmentOps(() => recipe, { readOnly: () => true });
    assert.equal(preset.add(), -1, "只读配方加不了段");
    assert.equal(preset.remove(0), null, "只读配方删不了段");
    assert.ok(!preset.reorder([0]), "只读配方重排不动配方");
    assert.equal(preset.applySkill("sk-b"), 0, "只读配方不统一技能");
    recipe.segments[0].refs = { images: ["seed1.png", "new_b.png"] };
    assert.deepEqual(directorAssetRefs(recipe).map((a) => a.filename), ["new_b.png"], "配方记过的名不重发，只报新增");
    assert.deepEqual(directorAssetRefs(recipe)[0], { filename: "new_b.png", subfolder: "", type: "input", kind: "image" }, "新增引用是后端认的形状");
});

test("共享整片参数表单（director.js createSharedConfigSection）：回显、留空口径、越界收口", async () => {
    const { createSharedConfigSection, DIRECTOR_CUSTOM } = await import(`../../web/director.js?sharedcfg=${seq++}`);
    const cfg = createSharedConfigSection();
    cfg.load({ width: 1344, height: 768, seed: 12345, steps: 20, context_frames: 17, continuity: false });
    const kept = cfg.collect();
    assert.equal(kept.seed, 12345, "种子原样收回");
    assert.ok(!("steps" in kept), "表单不产 steps 键：宿主并进现有 shared 时配方里的片级步数原样留着，本表单改不到它");
    assert.equal(kept.context_frames, 17, "上下文帧原样收回");
    assert.equal(kept.continuity, false, "连续性取消勾选收回 false");
    assert.equal(kept.aspect_ratio, "16:9 (宽屏)", "1344×768 认回 16:9，不落到自定义");
    assert.equal(kept.megapixels, 1, "百万像素按画面面积回填");
    assert.equal(kept.identity_refs, true, "配方没写身份参考：表单默认注入");
    cfg.load({ identity_refs: false });
    assert.ok(!cfg.el.querySelector(".ns-director-shared-ident").checked, "落过盘的身份参考关着要回显成关着");
    cfg.el.querySelector(".ns-director-shared-ident").checked = true;
    assert.equal(cfg.collect().identity_refs, true, "再勾上要把 true 交出去：宿主并进现有 shared，省掉这个键会让上次的 false 留下");
    cfg.load({});
    const blank = cfg.collect();
    assert.equal(blank.seed, -1, "种子留空 = 每次运行随机换种子");
    assert.equal(blank.context_frames, 22, "上下文帧留空 = 22 那一档");
    assert.equal(blank.aspect_ratio, "16:9 (宽屏)", "配方没写过宽高时落默认宽高比");
    assert.equal(blank.width % 32, 0, "宽按 MiniMax H3 画布步长 32 对齐");
    assert.equal(blank.height % 32, 0, "高按 32 对齐");
    cfg.load({ width: 1344, height: 768 });
    cfg.el.querySelector(".ns-director-shared-ctx").value = "999";
    cfg.el.querySelector(".ns-director-shared-mp").value = "9";
    const clamped = cfg.collect();
    assert.equal(clamped.context_frames, 362, "上下文帧收在 362 以内");
    assert.equal(clamped.megapixels, 2, "百万像素收在上限，超限的宽高不落盘");
    cfg.el.querySelector(".ns-director-shared-aspect").value = DIRECTOR_CUSTOM;
    const custom = cfg.collect();
    assert.equal(custom.aspect_ratio, DIRECTOR_CUSTOM, "自定义档原样落盘");
    assert.equal(custom.width, 1344, "自定义宽高是手输的那两个数");
    assert.equal(custom.height, 768, "高同上");
    assert.ok(!("megapixels" in custom), "自定义档不发百万像素：后端只认手输宽高");
    cfg.load({});
    assert.equal(cfg.collect().chunk_sec, 15, "配方没写过分块秒数：默认 15 那一档");
    cfg.load({ chunk_sec: 0 });
    assert.equal(cfg.el.querySelector(".ns-director-shared-chunk").value, "0", "落过 0 的配方回显 0 = 纯逐段生成");
    assert.equal(cfg.collect().chunk_sec, 0, "0 原样收回，不被默认档顶回去");
    // 分块秒数的显隐读宿主交来的「当前生效技能」：单段没有可合并的对象，普通技能永远不会分块
    const mf = createSharedConfigSection(() => ({ multi_frame: true }));
    mf.load({}, [{}, {}]);
    assert.notEqual(mf.el.querySelector(".ns-director-shared-chunk-row").style.display, "none", "多段 + 多帧技能：分块秒数露出来");
    mf.load({}, [{}]);
    assert.equal(mf.el.querySelector(".ns-director-shared-chunk-row").style.display, "none", "单段：没有可合并的对象就不出现");
    const plain = createSharedConfigSection();
    plain.load({}, [{}, {}]);
    assert.equal(plain.el.querySelector(".ns-director-shared-chunk-row").style.display, "none", "普通技能永不分块：不出现");
});

test.afterEach(() => {
    document.body.innerHTML = "";
});
test.afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
});


