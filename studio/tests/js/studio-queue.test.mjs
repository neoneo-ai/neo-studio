// 顶栏「队列」面板：入口显隐、GET /neo_studio/queue 播种、六条 rs.*.status 按 task_id 合并、
// 徽标只数活跃行、取消打各自类别的取消路由、图像行开 Lightbox、非图像行给 /view 链接、
// 「到该页」跳页、终态行移除；能力表关掉 queue 时收起入口。显存 / 内存读数与清理也在这块面板里，
// 面板展开时才轮询。页面提交这一发由 queueTrack 即时登记，不等播种。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mockRoute, jsonResponse, click, inputText, fetchLog, resetEnv, clearRoutes, sleep, flush } from "./setup.mjs";
import { dispatchApiEvent, resetApiState } from "./mocks/comfy-api.mjs";
import { appState } from "./mocks/comfy-app.mjs";
import { t, tf, setLang } from "../../web/js/core/i18n.js";

// studio-app.js 顶层会取 #ns-view 并连 WebSocket，导入前必须先备好 DOM 与 WS 桩
const wsInstances = [];
globalThis.WebSocket = class {
    constructor(url) { wsInstances.push(this); this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

// 每次 boot 换 query 重导入：顶栏「队列」挂在启动链尾，复用缓存模块的话面板会留在上一次的 DOM 里
let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?queue=${seq++}`);

const studioHtml = readFileSync(
    fileURLToPath(new URL("../../web/studio/index.html", import.meta.url)),
    "utf8",
);
const bodyMarkup = studioHtml
    .match(/<body[^>]*>([\s\S]*)<\/body>/)[1]
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");

// 后端聚合行 fixture：字段与 queue_route 的行同名；每次 boot 重播同一份，行在面板里按标签定位
const SEED_ROWS = [
    { task_id: "img-1", kind: "image", status: "succeeded", label: "猫娘立绘", progress: null,
      created: 100, updated: 101, result: { filename: "neo_paint_1.png", subfolder: "Neo/Paint" },
      count: 1, page: "paint" },
    { task_id: "vid-1", kind: "simple", status: "running", label: "开场镜头",
      progress: { value: 3, max: 20 }, created: 99, updated: 99, result: null, page: "video" },
    { task_id: "film-1", kind: "film", status: "queued", label: "R1", progress: null,
      created: 98, updated: 98, result: null, page: "director" },
];

// 显存 / 内存读数 fixture：mem_stats 与 system_stats 的回包，用例里换值就是换占用率
const GB = 1024 ** 3;
let memStats = { success: true, vram_used: 12 * GB, vram_total: 16 * GB };
let memRam = { ram_total: 32 * GB, ram_free: 12 * GB };

async function until(fn, what) {
    for (let i = 0; i < 50; i++) {
        if (fn()) return;
        await sleep(20);
    }
    assert.fail(`等待超时：${what}`);
}

async function boot({ caps = null, rows = SEED_ROWS } = {}) {
    resetEnv();
    resetApiState();
    clearRoutes();
    delete window.pywebview;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: ["R1"], caps,
    }));
    // 配方列表由 recipes-panel 在首次导入时拉一次并缓存在模块里：boot 就把导演配方铺好，后续 boot 换 mock 也不会重取
    mockRoute("/rs_recipes/list", jsonResponse([
        { name: "全片A", type: "video_director", shared: { mode: "f2v" }, segments: [
            { skill_id: "sk-a", prompt: "段一", duration_sec: 3 },
            { skill_id: "sk-a", prompt: "段二", duration_sec: 4 },
        ] },
    ]));
    mockRoute("/rs_prompts/skills", jsonResponse([
        { id: "sk-a", cn_name: "技能 A", category: "gen_video", gen_video: true, mode: "t2v" },
    ]));
    mockRoute("/userdata/neo_recipes_data.json", jsonResponse({}));
    mockRoute("/neo_video_gen/director_progress", jsonResponse({
        active: false, segment_index: -1, total_segments: 0, step: 0, total_steps: 0,
    }));
    mockRoute("/neo_video_gen/models", jsonResponse({ success: true, models: ["ltx-video-2v-2b.safetensors"] }));
    mockRoute("/neo_image_gen/settings", jsonResponse({ success: true }));
    mockRoute("/neo_studio/queue", () => jsonResponse({ success: true, rows }));
    mockRoute("/neo_video_gen/simple/vid-1/cancel", () => jsonResponse({ success: true, dequeued: true }));
    mockRoute("/neo_studio/mem_stats", () => jsonResponse(memStats));
    mockRoute("/system_stats", () => jsonResponse({ system: memRam }));
    mockRoute("/neo_studio/clear_memory", () => jsonResponse({ success: true, freed_bytes: 2 * GB }));
    document.body.innerHTML = bodyMarkup;
    window.location.hash = "#/home";
    await importApp();
    // 面板挂在启动链尾、播种是 init 里的异步 GET：两样都落地再进断言
    await until(() => document.querySelector(".ns-queue"), "队列面板挂载");
    await until(() => document.querySelectorAll(".ns-queue-row").length >= rows.length, "聚合行落地");
}

const toggle = () => document.querySelector("#ns-queue-toggle");
const panel = () => document.querySelector(".ns-queue");
const rows = () => [...document.querySelectorAll(".ns-queue-row")];
test("队列：导演页提交整片即时登记，终态事件给成片链接（必须排在本文件最前：编辑器面板与配方面板的模块缓存落进本页）", async () => {
    await boot({ rows: [] });
    appState.graph = { _nodes: [] };   // 无 Load* 节点 → 编辑器内无媒体候选
    mockRoute("/rs_recipes/director_spec", jsonResponse({
        success: true,
        segments: [{ prompt: "段一", duration_sec: 3, ref_input: "" },
            { prompt: "段二", duration_sec: 4, ref_input: "" }],
        defaults: { width: 640, height: 384, steps: 20 },
    }));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "全片A" }));
    mockRoute("/neo_studio/director/generate", () => jsonResponse({
        success: true, task_id: "dir-1", prompt_id: "p1", status: "queued", recipe: "全片A", seed: -1,
        filename: null, subfolder: null, progress: null, error: "", created: 120, updated: 120,
    }));
    mockRoute("/neo_studio/director/dir-1", () => jsonResponse({
        success: true, task_id: "dir-1", prompt_id: "p1", recipe: "全片A", seed: -1, subfolder: "",
        error: "", status: "queued", progress: null, filename: null, created: 120, updated: 120,
    }));
    window.location.hash = "#/director";
    await until(() => document.querySelector(".ns-director-recipes .neo-recipes-card-selected"), "首个导演配方自动选中");
    click(document.querySelector(".ns-director-recipes .neo-recipes-card-selected"));
    await until(() => document.querySelectorAll(".ns-director-editor .neo-director-seg").length === 2,
        "点卡打开编辑器");
    click(document.querySelector(".ns-gen-run"));
    await until(() => rowBy("全片A"), "整片行登记");
    assert.equal(rowBy("全片A").querySelector(".ns-queue-kind").textContent, "整片");
    const post = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_studio/director/generate");
    assert.equal(post.body.recipe, "全片A");
    dispatchApiEvent("rs.director.status", {
        task_id: "dir-1", prompt_id: "p1", status: "succeeded", recipe: "全片A", seed: -1,
        filename: "全片A.mp4", subfolder: "NeoDirector", progress: null, error: "", created: 120, updated: 131,
    });
    const open = rowBy("全片A").querySelector("a.ns-queue-act");
    assert.ok(open, "整片终态给成片链接");
    assert.ok(decodeURIComponent(open.href).includes("全片A.mp4"), open.href);
    await sleep(40);   // 导演页自己也在轮询这一发：收掉它的在飞请求再收尾
});


// 行上没有 data 属性：行内标签就是用例里的定位键
const rowBy = (label) => rows().find((r) => r.querySelector(".ns-queue-label")?.textContent === label);
// 导演用例登记过一整片行，会留在共享的行集合里进后续 boot：计数类断言按标签把它隔出去
const rowsExcept = (label) => rows().filter((r) => r.querySelector(".ns-queue-label")?.textContent !== label);
const act = (row, text) => [...row.querySelectorAll(".ns-queue-act")].find((b) => b.textContent === text);
const badge = () => document.querySelector(".ns-queue-badge");
const openPanel = () => click(toggle());


test("队列：能力表关掉 queue 时收起顶栏入口（首跑必须是最早的 boot：面板挂在模块导入时）", async () => {
    await boot({ caps: { queue: false }, rows: [] });
    assert.equal(toggle().hidden, true, "能力表关 queue 时顶栏入口收起");
    assert.equal(panel().hidden, true, "入口收起时面板不浮出");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_studio/queue").length, 0, "收起后不发播种请求");
});

test("队列：在线形态顶栏出现入口，面板打开时播种后端聚合行", async () => {
    await boot();
    assert.equal(toggle().hidden, false, "在线形态顶栏入口可见");
    assert.equal(badge().hidden, false, "有活跃行时徽标可见");
    assert.equal(badge().textContent, "2", "徽标只数排队中 + 生成中");
    assert.equal(panel().hidden, true, "面板默认收起");
    openPanel();
    assert.equal(panel().hidden, false, "点击展开面板");
    assert.ok(fetchLog.some((c) => c.path === "/neo_studio/queue"), "应拉取 /neo_studio/queue");
    assert.equal(rowsExcept("全片A").length, 3);
    assert.equal(rowBy("开场镜头").querySelector(".ns-queue-kind").textContent, "视频");
    assert.equal(rowBy("开场镜头").querySelector(".ns-queue-status").textContent, "生成中 3/20");
    assert.equal(rowBy("R1").querySelector(".ns-queue-status").textContent, "排队中");
    assert.equal(rowBy("猫娘立绘").querySelector(".ns-queue-status").textContent, "已完成");
    // 进度条只给生成中的行：排队中与终态行不铺条
    assert.equal(rowBy("开场镜头").querySelector(".ns-queue-bar").hidden, false);
    assert.equal(rowBy("R1").querySelector(".ns-queue-bar").hidden, true);
    // 活跃行排前：running / queued 在 succeeded 之前
    assert.deepEqual(rowsExcept("全片A").map((r) => r.querySelector(".ns-queue-label").textContent),
        ["开场镜头", "R1", "猫娘立绘"]);
});

test("队列：图像结果开 Lightbox，视频结果给链接，进行中无结果", async () => {
    await boot();
    openPanel();
    const view = act(rowBy("猫娘立绘"), "看图");
    click(view);
    const lb = document.querySelector(".neo-lightbox");
    assert.ok(lb, "图像行「看图」打开 Lightbox");
    assert.ok(lb.querySelector("img").src.includes("neo_paint_1.png"));
    // 进行中的行只有取消钮，没有结果链接
    assert.equal(rowBy("开场镜头").querySelector("a.ns-queue-act"), null);
    // WS 报成功：同一行补上「打开」链接（非图像走 /view 链接）
    dispatchApiEvent("rs.simple_video.status", {
        task_id: "vid-1", kind: "simple", status: "succeeded", progress: null,
        filename: "simple_1.mp4", subfolder: "Neo", created: 99, updated: 102,
    });
    const open = rowBy("开场镜头").querySelector("a.ns-queue-act");
    assert.ok(open, "视频结果给 <a> 链接");
    assert.ok(open.href.includes("/view"), open.href);
    assert.ok(open.href.includes("simple_1.mp4"));
    assert.equal(badge().textContent, "1", "视频终态后只剩整片排队中");
});

test("队列：状态事件按 task_id 合并到同一行，新任务追加到最前", async () => {
    await boot();
    openPanel();
    dispatchApiEvent("rs.simple_video.status", {
        task_id: "vid-1", kind: "simple", status: "running",
        progress: { value: 11, max: 20 }, created: 99, updated: 105,
    });
    assert.equal(rowsExcept("全片A").length, 3, "同 task_id 只更新已有行");
    const row = rowBy("开场镜头");
    assert.equal(row.querySelector(".ns-queue-status").textContent, "生成中 11/20");
    assert.equal(row.querySelector(".ns-queue-bar").hidden, false, "进度条随事件铺开");
    dispatchApiEvent("rs.simple_video.status", {
        task_id: "vid-2", kind: "simple", status: "queued", label: "第二发",
        created: 110, updated: 110,
    });
    assert.equal(rowsExcept("全片A").length, 4);
    assert.equal(rows()[0].querySelector(".ns-queue-label").textContent, "第二发", "新行插到最前");
    assert.equal(badge().textContent, "3", "新增排队中后徽标计数跟上");
});

test("队列：取消打到该类别的取消路由，行先落到已取消再交后端收尾", async () => {
    await boot();
    // 不开面板：init 的播种已把行铺好，点开面板会再起一次播种把本地取消盖掉
    click(act(rowBy("开场镜头"), "取消"));
    await until(() => fetchLog.some((c) => c.path === "/neo_video_gen/simple/vid-1/cancel"),
        "POST simple 取消");
    await until(() => rowBy("开场镜头")?.querySelector(".ns-queue-status")?.textContent === "已取消",
        "行先落到已取消");
    assert.ok(rowBy("开场镜头"), "取消点击本身不删行");
});

test("队列：到该页跳到对应页面，终态行可移除", async () => {
    await boot();
    openPanel();
    click(act(rowBy("猫娘立绘"), "到该页"));
    assert.equal(window.location.hash, "#/paint");
    assert.equal(rowBy("开场镜头").querySelector(".ns-queue-drop"), null, "进行中的行不给移除钮");
    click(rowBy("猫娘立绘").querySelector(".ns-queue-drop"));
    assert.equal(rowBy("猫娘立绘"), undefined, "移除只动本地行");
});

test("队列：提交这一发即时登记，视频页生成钮交回用户", async () => {
    await boot();
    window.location.hash = "#/video";
    await until(() => document.querySelector(".ns-video .ns-video-run"), "视频页挂载");
    mockRoute("/neo_video_gen/simple", () => jsonResponse({
        success: true, task_id: "sv-1", prompt_id: "p9", status: "queued",
        filename: null, subfolder: "", progress: null, error: "", created: 110, updated: 110,
    }));
    mockRoute("/neo_video_gen/simple/sv-1", () => jsonResponse({
        success: true, task_id: "sv-1", prompt_id: "p9", status: "queued",
        filename: null, subfolder: "", progress: null, error: "", created: 110, updated: 110,
    }));
    const run = document.querySelector(".ns-video .ns-video-run");
    inputText(document.querySelector(".ns-video .ns-video-prompt"), "镜头提示");
    const before = Number(badge().textContent);
    click(run);
    await until(() => badge().textContent === String(before + 1), "徽标登记这一发");
    assert.equal(run.disabled, false, "提交成功后生成钮交回用户：进度在顶栏队列里跟");
    openPanel();
    const row = rowBy("镜头提示");
    assert.ok(row, "提交即登记行，不等播种");
    assert.equal(row.querySelector(".ns-queue-kind").textContent, "视频");
    const post = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_video_gen/simple");
    assert.equal(post.body.prompt, "镜头提示");
    // 收掉这一发的页内轮询：终态事件落地，页面 stopPolling，别让 0ms 桩轮询拖到文件尾
    mockRoute("/neo_video_gen/simple/sv-1", () => jsonResponse({
        success: true, task_id: "sv-1", prompt_id: "p9", status: "succeeded",
        filename: "sv_1.mp4", subfolder: "Neo", progress: null, error: "", created: 110, updated: 121,
    }));
    dispatchApiEvent("rs.simple_video.status", {
        task_id: "sv-1", kind: "simple", status: "succeeded", progress: null,
        filename: "sv_1.mp4", subfolder: "Neo", created: 110, updated: 121,
    });
    await until(() => document.querySelector(".ns-video .ns-video-cancel")?.style.display === "none",
        "页面轮询收尾");
});


// 行的 Map 是模块级共享的：本用例新播种的 4 行会留在集合里，所以排在所有按绝对计数断言的用例之后
test("队列：行内缩略图走素材库缓存路由，配提交时刻 / 时长 / 张数与按天分组", async () => {
    const nowSec = Date.now() / 1000;
    await boot({
        rows: [
            { task_id: "im-9", kind: "image", status: "succeeded", label: "三张图", progress: null,
              created: nowSec - 40, updated: nowSec - 28, result: { filename: "neo_a_1.png", subfolder: "" },
              count: 3, page: "paint" },
            { task_id: "vv-9", kind: "simple", status: "succeeded", label: "成片行", progress: null,
              created: nowSec - 90, updated: nowSec - 34, result: { filename: "clip_9.mp4", subfolder: "Neo/Simple" },
              count: 1, page: "video" },
            { task_id: "vo-9", kind: "voice", status: "succeeded", label: "语音行", progress: null,
              created: nowSec - 70, updated: nowSec - 66, result: { filename: "say_1.mp3", subfolder: "Neo" },
              count: 2, page: "gallery" },
            { task_id: "q-9", kind: "film", status: "queued", label: "排队片", progress: null,
              created: nowSec, updated: nowSec, result: null, page: "director" },
        ],
    });
    openPanel();
    // 缩略图：图片与视频都吃 /neo_gallery/thumbnail（音频后端不出图，格子留空）
    const img = rowBy("三张图").querySelector(".ns-queue-thumb img");
    assert.ok(img, "图像行铺缩略格");
    assert.ok(img.src.includes("/neo_gallery/thumbnail"), img.src);
    assert.ok(decodeURIComponent(img.src).includes("neo_a_1.png"), img.src);
    assert.ok(img.src.includes("size=96"), img.src);
    assert.ok(decodeURIComponent(rowBy("成片行").querySelector(".ns-queue-thumb img").src).includes("clip_9.mp4"));
    assert.equal(rowBy("语音行").querySelector(".ns-queue-thumb img"), null, "音频行不铺缩略图");
    assert.equal(rowBy("排队片").querySelector(".ns-queue-thumb img"), null, "无产物的行留空格");
    // 时间三件：提交时刻 HH:MM、终态行落定耗时、多产物张数；排队中的行没有时长
    const d = new Date((nowSec - 40) * 1000);
    const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    assert.equal(rowBy("三张图").querySelector(".ns-queue-time").textContent, clock);
    assert.equal(rowBy("三张图").querySelector(".ns-queue-dur").textContent, "12.00s");
    assert.equal(rowBy("三张图").querySelector(".ns-queue-cnt").textContent, "3 张");
    assert.equal(rowBy("语音行").querySelector(".ns-queue-cnt").textContent, "2 个", "语音按「个」计数");
    assert.equal(act(rowBy("语音行"), "2 个").textContent, "2 个", "多产物行的结果钮直接给数量");
    assert.equal(act(rowBy("三张图"), "3 张").textContent, "3 张", "多图行的结果钮直接给张数");
    assert.equal(rowBy("成片行").querySelector(".ns-queue-dur").textContent, "56.00s");
    assert.equal(rowBy("排队片").querySelector(".ns-queue-dur"), null, "排队中的行还没有时长");
    assert.equal(rowBy("语音行").querySelector(".ns-queue-dur").textContent, "4.00s");
    // 按提交日分组：今天的行组首挂「今天」
    assert.equal(document.querySelector(".ns-queue-day").textContent, t("今天"));
    // 点缩略格：视频行开同页播放器灯箱
    click(rowBy("成片行").querySelector(".ns-queue-thumb"));
    const lb = document.querySelector(".neo-lightbox");
    assert.ok(lb, "缩略图点开进 Lightbox");
    assert.ok(lb.querySelector("video"), "视频行开播放器");
    assert.ok(lb.querySelector("video").src.includes("/neo_gallery/video"), lb.querySelector("video").src);
    assert.ok(decodeURIComponent(lb.querySelector("video").src).includes("clip_9.mp4"));
    lb.querySelector("[data-action=close]")?.click();
});


test("队列：显存 / 内存读数与清理在面板里，收起面板即停表", async () => {
    await boot();
    const strip = document.querySelector(".ns-queue-mem");
    assert.ok(strip, "在线形态面板里铺显存 / 内存读数条");
    assert.equal(strip.querySelector(".ns-queue-mem-vram").textContent, `${t("显存")} --`);
    const memFetches = () => fetchLog.filter((c) => c.path === "/neo_studio/mem_stats").length;
    assert.equal(memFetches(), 0, "面板收起时不轮询显存");
    openPanel();
    await until(() => strip.querySelector(".ns-queue-mem-vram").textContent.includes("12.0G"), "显存读数刷新");
    assert.equal(strip.querySelector(".ns-queue-mem-vram").textContent, "显存 12.0G/16.0G");
    assert.equal(strip.querySelector(".ns-queue-mem-ram").textContent, "内存 20.0G/32.0G");
    assert.ok(strip.querySelector(".ns-queue-mem-vram").classList.contains("warn"), "75% 占用落 warn");
    assert.ok(!strip.querySelector(".ns-queue-mem-vram").classList.contains("crit"), "75% 不落 crit");
    const clear = strip.querySelector(".ns-queue-mem-clear");
    click(clear);
    await until(() => clear.textContent.includes("释放"), "清理钮回报释放量");
    assert.ok(fetchLog.some((c) => c.method === "POST" && c.path === "/neo_studio/clear_memory"),
        "清理打 /neo_studio/clear_memory");
    click(toggle());   // 收起面板
    assert.equal(panel().hidden, true, "点一下收起面板");
    await flush();
    await flush();
    const settled = memFetches();
    dispatchApiEvent("rs.simple_video.status", {
        task_id: "vid-1", kind: "simple", status: "running",
        progress: { value: 12, max: 20 }, created: 99, updated: 106,
    });
    assert.equal(memFetches(), settled, "面板收起后不再打读数请求");
});

test("队列：显存读数按占用比例变色", async () => {
    memStats = { success: true, vram_used: 15 * GB, vram_total: 16 * GB };
    try {
        await boot();
        openPanel();
        await until(() => document.querySelector(".ns-queue-mem-vram").textContent.includes("15.0G"), "高占用读数刷新");
        assert.ok(document.querySelector(".ns-queue-mem-vram").classList.contains("crit"), "94% 占用落 crit");
    } finally {
        memStats = { success: true, vram_used: 12 * GB, vram_total: 16 * GB };
    }
});

test("队列：能力表关掉 memory 时面板不出读数条，不发 mem_stats 请求", async () => {
    await boot({ caps: { memory: false } });
    assert.equal(document.querySelector(".ns-queue-mem"), null, "无 memory 能力时不铺读数条");
    openPanel();
    assert.ok(rows().length >= 3, "队列行照常铺出");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_studio/mem_stats").length, 0,
                 "面板展开也不发显存读数请求");
});


test("队列静态完整性：顶栏入口、面板类名、Lightbox 图标与英文文案各就各位", async () => {
    assert.match(studioHtml, /class="ns-queue-toggle" id="ns-queue-toggle"[^>]*hidden/);
    assert.match(studioHtml, /class="ns-queue-badge" id="ns-queue-badge"/);
    const css = readFileSync(fileURLToPath(new URL("../../web/queue-panel.css", import.meta.url)), "utf8");
    for (const cls of [".ns-queue", ".ns-queue[hidden]", ".ns-queue-row", ".ns-queue-kind", ".ns-queue-label",
        ".ns-queue-status", ".ns-queue-bar", ".ns-queue-actions", ".ns-queue-act",
        ".ns-queue-badge", ".ns-queue-thumb", ".ns-queue-main", ".ns-queue-side",
        ".ns-queue-meta", ".ns-queue-time", ".ns-queue-dur", ".ns-queue-cnt", ".ns-queue-day",
        ".ns-queue-mem", ".ns-queue-mem-item", ".ns-queue-mem-clear"]) {
        assert.ok(css.includes(cls), `queue-panel.css 缺 ${cls}`);
    }
    // .ns-queue 显式 display:flex 会盖掉 [hidden] 的 UA display:none：缺这条面板就默认展开
    const panelSrc = readFileSync(fileURLToPath(new URL("../../web/queue-panel.js", import.meta.url)), "utf8");
    assert.match(panelSrc, /Lightbox\.open\(/, "图像行结果走 Lightbox");
    assert.match(panelSrc, /setIcon\(drop, "cross"\)/, "移除钮是 Lightbox 同源图标");
    // 缩略图必须走素材库那条带缓存的缩略路由，不能整图拉 /view
    assert.match(panelSrc, /\/neo_gallery\/thumbnail\?/, "缩略图走 /neo_gallery/thumbnail");
    assert.match(panelSrc, /size=\$\{THUMB_SIZE\}/, "缩略图按固定尺寸取缓存");
    // 显存 / 内存读数与清理统一在面板里：读 mem_stats、打 clear_memory
    assert.match(panelSrc, /\/neo_studio\/mem_stats/, "读数打 /neo_studio/mem_stats");
    assert.match(panelSrc, /\/neo_studio\/clear_memory/, "清理打 /neo_studio/clear_memory");
    // 生成页上的读数条已经搬空：Studio 页与页面样式里不该再留 ns-mem 那一套
    const appSrc = readFileSync(fileURLToPath(new URL("../../web/studio/studio-app.js", import.meta.url)), "utf8");
    const appCss = readFileSync(fileURLToPath(new URL("../../web/studio/style.css", import.meta.url)), "utf8");
    for (const dead of ["ns-mem", "buildMemBar", "setMemActive", "mountMemBars"]) {
        assert.ok(!appSrc.includes(dead), `studio-app.js 还留着 ${dead}`);
        assert.ok(!appCss.includes(dead), `studio/style.css 还留着 ${dead}`);
    }
    setLang("en");
    assert.equal(t("到该页"), "Go to page");
    assert.equal(t("排队中"), "Queued");
    assert.equal(t("今天"), "Today");
    assert.equal(t("昨天"), "Yesterday");
    assert.equal(tf("生成中 {value}/{max}", { value: 3, max: 20 }), "Generating 3/20");
    setLang("zh");
});

