// Neo Studio 导演页：上内嵌导演编辑器（标题行左端 = 配方 / 素材库入口）+ 竖向分隔条 + 右侧整片生成面板；
// 编辑器收起时整栏退成引导页（入口按钮跟着搬回引导页）；分段勾选条（一格一段，勾选只跑其中几段）、
// 生成中实时预览（载荷按 task_id 路由、终态定格）、分隔条偏好。
// studio-app.js 顶层会取 #ns-view 并连 WebSocket，导入前必须先备好 DOM 与 WS 桩。
import test from "node:test";
import assert from "node:assert/strict";
import { mockRoute, jsonResponse, sleep, click, inputText, fetchLog } from "./setup.mjs";
import { appState, app as mockApp } from "./mocks/comfy-app.mjs";

const wsInstances = [];
globalThis.WebSocket = class {
    constructor(url) { wsInstances.push(this); this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

document.body.innerHTML = `<div id="ns-view"></div>`;
mockRoute("/neo_studio/version", jsonResponse({
    success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: ["R1"],
}));
// 分段数按配方名给：R1 两段、R2 三段，切配方时断言分段格子跟着编辑器走
const SPEC_BY_RECIPE = {
    R1: { segments: [{ prompt: "段一", duration_sec: 3, ref_input: "" }, { prompt: "段二", duration_sec: 4, ref_input: "" }], defaults: { width: 640, height: 384, steps: 20 } },
    R2: { segments: [{ prompt: "甲", duration_sec: 2, ref_input: "" }, { prompt: "乙", duration_sec: 2, ref_input: "" }, { prompt: "丙", duration_sec: 2, ref_input: "" }], defaults: { width: 1344, height: 768, steps: 8 } },
};
mockRoute("/rs_recipes/director_spec", (b, call) => jsonResponse({
    success: true,
    ...(SPEC_BY_RECIPE[call.query.get("name")] || SPEC_BY_RECIPE.R1),
}));
mockRoute("/neo_video_gen/director_progress", jsonResponse({
    active: false, segment_index: -1, total_segments: 0, step: 0, total_steps: 0,
}));
mockRoute("/neo_studio/director/generate", jsonResponse({
    success: true, task_id: "task-1", prompt_id: "p1", status: "queued", recipe: "R1", seed: -1,
    filename: null, subfolder: null, progress: null, error: "", created: 0, updated: 0,
}));
mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "R1" }));
// 任务快照路由：响应由 statusState 动态驱动（模拟 WS 事件丢失、终态只能靠轮询兜底拿到）
const statusState = { status: "queued", progress: null, filename: null };
const statusRoute = () => jsonResponse({
    success: true, task_id: "task-1", prompt_id: "p1", recipe: "R1", seed: -1,
    subfolder: "", error: "", created: 0, updated: 0, ...statusState,
});
mockRoute("/neo_studio/director/task-1", statusRoute);
mockRoute("/userdata/neo_recipes_data.json", jsonResponse({}));
mockRoute("/rs_recipes/list", jsonResponse([
    { name: "R1", type: "video_director", shared: { mode: "f2v" }, segments: [
        { skill_id: "sk-a", prompt: "段一", duration_sec: 3 },
        { skill_id: "sk-a", prompt: "段二", duration_sec: 4 },
    ]},
    { name: "R2", type: "video_director", shared: { mode: "f2v" }, segments: [
        { skill_id: "sk-a", prompt: "甲", duration_sec: 2 },
        { skill_id: "sk-a", prompt: "乙", duration_sec: 2 },
        { skill_id: "sk-a", prompt: "丙", duration_sec: 2 },
    ]},
])); // listRecipes 直接返回数组
mockRoute("/rs_prompts/skills", jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

const frame = (name) => `data:image/jpeg;base64,${name}`;
function wsSend(type, data) {
    wsInstances[0].onmessage({ data: JSON.stringify({ type, data }) });
}
async function until(fn, what) {
    for (let i = 0; i < 50; i++) {
        if (fn()) return;
        await sleep(20);
    }
    assert.fail(`等待超时：${what}`);
}

test("开机落首页：导演配方列表落地不自动铺编辑器，窗口不被拽到导演页", async () => {
    await import("../../web/studio/studio-app.js");
    await until(() => document.querySelector(".ns-director-recipes .neo-recipes-panel"), "开机建好的配方面板");
    await sleep(300);   // 自动选中 → 铺编辑器 → 跳页这条链跑完还不跳，才算断了
    assert.ok(document.querySelector(".ns-home:not(.ns-hidden)"), "落地页是首页");
    assert.notEqual(location.hash, "#/director", "开机不跳导演页");
    assert.equal(document.querySelector(".ns-director-editor .neo-director-panel"), null, "开机不把首个导演配方铺进编辑器");
    assert.ok(document.querySelector(".ns-director-empty"), "导演页停在引导页");
    location.hash = "#/director";   // 本文件每条用例都从这一行起头：这里落回导演页，下一条照旧
});

test("Studio 导演页：分段勾选条 + 生成中实时预览", async () => {
    await import("../../web/studio/studio-app.js");
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 编辑器内无媒体候选
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-gen-panel"), "生成面板挂载");

    // 分段勾选条挂进生成面板：配方未选中时还没有分段格子
    assert.equal(document.querySelectorAll(".ns-gen-seg-chip").length, 0, "未选配方时无分段格子");

    // 首个配方自动选中（下方配方面板）：拉 director_spec 刷出分段格子 + 尺寸/步数只读回显
    await until(() => {
        const sel = document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span");
        return sel && sel.textContent === "R1";
    }, "配方自动选中");
    await until(() => document.querySelectorAll(".ns-gen-seg-chip").length === 2, "一格一段（mock spec 2 段）");
    // 落地在首页时不铺编辑器：点这张已选中的卡才把它铺进左栏宿主
    assert.equal(document.querySelector(".ns-director-editor .neo-director-panel"), null, "进页不自动铺编辑器");
    click(document.querySelector(".ns-director-recipes .neo-recipes-card-selected"));
    await until(() => document.querySelectorAll(".ns-director-editor .neo-director-seg").length === 2, "点卡打开编辑器");
    assert.ok(document.querySelector(".ns-director-editor").classList.contains("ns-editor-open"), "编辑器挂上后收起占位提示");
    assert.equal(document.querySelector(".ns-gen-seg-chip").textContent, "1", "格内只有段号");
    // 参数不在面板上：尺寸 / 步数只读回显来自配方 defaults
    assert.equal(document.querySelector(".ns-gen-spec").textContent, "640×384 · 20 步", "回显配方尺寸与步数");
    assert.equal(document.querySelector(".ns-gen-panel input"), null, "生成面板不再有参数输入控件");
    assert.ok(fetchLog.some((c) => c.path === "/rs_recipes/director_spec"), "应拉取配方 spec");

    // 提交生成：排队中状态 + 实时预览面板初始隐藏
    click(document.querySelector(".ns-gen-run"));
    await until(() => (document.querySelector(".ns-gen-status").textContent || "").includes("排队中"), "排队中状态");
    const liveBox = document.querySelector(".ns-gen-live");
    assert.equal(liveBox.style.display, "none", "首个载荷到达前预览面板不占位");

    // 预览载荷按 task_id 过滤：别的任务不显示
    wsSend("rs.h3.preview", { node_id: "other-task", frames: [frame("x")], fps: 8, w: 512, h: 288 });
    assert.equal(liveBox.style.display, "none", "非本任务的载荷被过滤");

    // 本任务载荷：面板显示并播第一帧（高度清空交给 CSS，随面板高度伸缩）
    wsSend("rs.h3.preview", { node_id: "task-1", frames: [frame("a"), frame("b")], fps: 8, w: 512, h: 288 });
    assert.equal(liveBox.style.display, "");
    assert.equal(liveBox.style.height, "", "高度交给 CSS：结果区随面板高度伸缩");
    assert.equal(liveBox.querySelector(".neo-dtl-live-img").src, frame("a"));

    // 成功：成片就地替换实时预览（播放器 + 打开链接）
    wsSend("rs.director.status", {
        task_id: "task-1", prompt_id: "p1", status: "succeeded", recipe: "R1", seed: -1,
        filename: "NeoDirector/R1.mp4", subfolder: "", progress: null, error: "", created: 0, updated: 0,
    });
    await until(() => document.querySelector("video.ns-gen-final"), "成片播放器出现");
    assert.equal(document.querySelector(".ns-gen-live"), null, "成片替换实时预览面板");
    assert.equal(document.querySelectorAll(".ns-gen-final").length, 2, "播放器 + 打开链接");
});

test("Studio 导演页：点配方卡内嵌打开编辑器 + 「保存并生成整片」提交", async () => {
    await import("../../web/studio/studio-app.js");
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 编辑器内无媒体候选
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-gen-panel"), "生成面板挂载");

    // 首个配方自动选中（配方弹窗宿主）
    await until(() => {
        const sel = document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span");
        return sel && sel.textContent === "R1";
    }, "配方自动选中");
    assert.ok(document.querySelector(".ns-director-recipes .neo-recipes-list"), "配方列表挂在配方弹窗宿主里");
    // 进页时自动选中的配方已经在右上宿主编好：不用先点一张卡才出编辑器
    const autoPanel = document.querySelector(".ns-director-editor .neo-director-panel");
    assert.ok(autoPanel, "进页即有内嵌编辑器");
    assert.ok(document.querySelector(".ns-director-editor").classList.contains("ns-editor-open"), "有编辑器时占位提示收起");

    // 点配方卡 → 在同一个内嵌宿主里打开（分段格子只管勾选，不再负责开编辑器）
    click(document.querySelector(".ns-director-recipes .neo-recipes-card"));

    // 编辑器内嵌进右上宿主（不建浮层窗口）
    await until(() => document.querySelector(".ns-director-editor .neo-director-panel"), "编辑器内嵌出现");
    assert.equal(document.querySelector(".ns-director-editor .neo-director-panel"), autoPanel, "点同一张卡不重载编辑器");
    assert.equal(document.querySelector(".neo-director-overlay"), null, "内嵌模式不建浮层窗口");
    assert.equal(document.querySelector(".neo-director-resize"), null, "内嵌模式无右下角缩放手柄");
    assert.equal(document.querySelector(".neo-director-maximize"), null, "内嵌模式无 ⛶ 放大按钮");
    assert.ok(document.querySelector(".ns-director-editor .neo-director-panel").classList.contains("neo-director-embedded"));
    assert.ok(document.querySelector(".ns-director-editor").classList.contains("ns-editor-open"), "编辑器挂上后收起占位提示");

    // 「保存并生成整片」：走完整保存路径，成功后由宿主提交整片生成
    const before = fetchLog.length;
    const panel = document.querySelector(".ns-director-editor .neo-director-panel");
    click(document.querySelector(".neo-director-save-run"));
    await until(() => fetchLog.slice(before).some((c) => c.path === "/neo_studio/director/generate"), "保存后提交生成");
    const call = fetchLog.slice(before).find((c) => c.path === "/neo_studio/director/generate");
    assert.equal(call.body.recipe, "R1", "生成用刚保存的配方");
    // 内嵌编辑器保存后留在原地：生成在下方面板跑，编辑界面不被抽走
    await sleep(60);
    assert.equal(document.querySelector(".ns-director-editor .neo-director-panel"), panel, "内嵌保存后编辑器不关闭");
    assert.ok(document.querySelector(".ns-director-editor").classList.contains("ns-editor-open"), "保存后仍是编辑态");
    // 保存已清脏态：标题栏 ✕ 直接关掉，不出未保存确认条
    click(document.querySelector(".neo-director-close"));
    await until(() => !document.querySelector(".ns-director-editor .neo-director-panel"), "✕ 关闭编辑器");
    assert.ok(!document.querySelector(".ns-director-editor").classList.contains("ns-editor-open"), "关闭后回到占位提示");
    await sleep(20);
});

test("Studio 导演页：点配方卡直接在内嵌宿主里打开编辑器（重复点击不重载）", async () => {
    await import("../../web/studio/studio-app.js");
    appState.graph = { _nodes: [] };
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-director-recipes .neo-recipes-card"), "配方卡片挂载");
    assert.equal(document.querySelector(".ns-director-editor .neo-director-panel"), null, "上一用例关掉编辑器后不自动重开");

    const card = document.querySelector(".ns-director-recipes .neo-recipes-card");
    click(card);
    click(card);   // 构建中（异步扫描未落地）的重复点击：忽略，不叠出第二个编辑器
    await until(() => document.querySelector(".ns-director-editor .neo-director-panel"), "点卡片即内嵌打开编辑器");
    await until(() => document.querySelectorAll(".neo-director-seg").length === 2, "分段构建完成");
    assert.equal(document.querySelectorAll(".neo-director-panel").length, 1, "连点同一配方只有一个编辑器");
    assert.equal(document.querySelector(".neo-director-overlay"), null, "内嵌模式不建浮层窗口");
    assert.ok(card.classList.contains("neo-recipes-card-selected"), "同一次点击同时选中配方");
    assert.ok(document.querySelector(".neo-director-save-run"), "内嵌编辑器带「保存并生成整片」");
    assert.ok(document.querySelector(".neo-director-title .ns-director-libbtns"), "入口按钮挂进编辑器标题行");

    // 构建完成后重复点同一张卡：单例只切段，编辑器 DOM 不重载（未保存改动不丢）
    const panel = document.querySelector(".ns-director-editor .neo-director-panel");
    click(card);
    await sleep(60);
    assert.equal(document.querySelector(".ns-director-editor .neo-director-panel"), panel, "重复点击同一配方不重载编辑器");

    click(document.querySelector(".neo-director-close"));
    await until(() => !document.querySelector(".ns-director-editor .neo-director-panel"), "关闭编辑器");
    assert.ok(document.querySelector(".ns-director").classList.contains("ns-director-editorless"), "关闭后整栏退成引导页");
    assert.ok([...document.querySelectorAll(".ns-director-empty-actions button")].some((b) => b.textContent.includes("配方")), "「配方」入口搬回引导页");
    await sleep(20);
});

test("Studio 导演页：轮询拿到终态 → 停轮询 + 成片只替换一次", async () => {
    localStorage.removeItem("neo_studio_director_closed");
    await import("../../web/studio/studio-app.js");
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-gen-panel"), "生成面板挂载");
    // 首个配方自动选中（下方配方面板）
    await until(() => {
        const sel = document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span");
        return sel && sel.textContent === "R1";
    }, "配方自动选中");

    // 快照路由先返回 running，再返回 succeeded（模拟 WS 终态事件丢失，只能靠轮询拿到）
    statusState.status = "running";
    statusState.progress = { value: 5, max: 20 };
    statusState.filename = null;
    click(document.querySelector(".ns-gen-run"));
    await until(() => (document.querySelector(".ns-gen-status").textContent || "").includes("生成中"), "轮询驱动生成中状态");

    statusState.status = "succeeded";
    statusState.progress = null;
    statusState.filename = "NeoDirector/R1.mp4";
    await until(() => document.querySelector("video.ns-gen-final"), "轮询兜底出现成片播放器");
    const video = document.querySelector("video.ns-gen-final");
    const callsAtDone = fetchLog.filter((c) => c.path === "/neo_studio/director/task-1").length;

    // 再等两个多轮询周期：轮询必须已停、成片元素不得被重建（旧行为是每 2 秒重放一次视频）
    await sleep(200);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_studio/director/task-1").length, callsAtDone, "终态后轮询停止");
    assert.equal(document.querySelector("video.ns-gen-final"), video, "成片只替换一次");
});

test("Studio 导演页：终态落地后在途轮询的旧 running 载荷不得把界面拉回生成中", async () => {
    localStorage.removeItem("neo_studio_director_closed");   // 这几例要「没关过」的起手态：前序用例的 ✕ 会留下关闭偏好，自动选中就不跑了
    await import("../../web/studio/studio-app.js");
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-gen-panel"), "生成面板挂载");
    await until(() => document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span")?.textContent === "R1", "配方自动选中");

    // 快照路由慢 300ms 落地，且按请求时刻取状态：响应回来时 WS 终态早已落地，载荷是过期的 running
    statusState.status = "running";
    statusState.progress = { value: 20, max: 20 };
    statusState.filename = null;
    mockRoute("/neo_studio/director/task-1", async () => {
        const stale = { ...statusState };
        await sleep(300);
        return jsonResponse({ success: true, task_id: "task-1", prompt_id: "p1", recipe: "R1", seed: -1, subfolder: "", error: "", created: 0, updated: 0, ...stale });
    });
    click(document.querySelector(".ns-gen-run"));
    await until(() => (document.querySelector(".ns-gen-status").textContent || "").includes("生成中"), "轮询驱动生成中状态");
    assert.equal(document.querySelector(".ns-gen-cancel").style.display, "", "生成中取消按钮可见");

    // WS 终态先到：成片定格、停轮询
    statusState.status = "succeeded";
    statusState.progress = null;
    statusState.filename = "NeoDirector/R1.mp4";
    wsSend("rs.director.status", {
        task_id: "task-1", prompt_id: "p1", recipe: "R1", seed: -1, subfolder: "",
        filename: "NeoDirector/R1.mp4", status: "succeeded", progress: null, error: "", created: 0, updated: 0,
    });
    await until(() => document.querySelector("video.ns-gen-final"), "WS 终态出现成片播放器");

    // 此刻在途的轮询（含 interval 已触发未响应的轮次）陆续带着旧的 running 落地：界面必须停在终态
    await sleep(700);
    assert.ok(document.querySelector("video.ns-gen-final"), "成片播放器留在原位");
    assert.ok((document.querySelector(".ns-gen-status").textContent || "").includes("已完成"), "状态停在已完成");
    assert.equal(document.querySelector(".ns-gen-cancel").style.display, "none", "取消按钮不得复活（复活后点下去只会拿到「任务已结束，无法取消」）");
    assert.equal(document.querySelector(".ns-gen-progress").style.display, "none", "进度条不得复活");
    mockRoute("/neo_studio/director/task-1", statusRoute);   // 慢路由只服务本用例，别拖慢后面的用例
});

test("Studio 导演页：WS 断档期间轮询 latest_preview 补帧（旧步号忽略）", async () => {
    localStorage.removeItem("neo_studio_director_closed");
    await import("../../web/studio/studio-app.js");
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-gen-panel"), "生成面板挂载");
    // 首个配方自动选中（下方配方面板）
    await until(() => {
        const sel = document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span");
        return sel && sel.textContent === "R1";
    }, "配方自动选中");

    statusState.status = "running";
    statusState.progress = null;
    statusState.filename = null;
    delete statusState.latest_preview;
    click(document.querySelector(".ns-gen-run"));
    await until(() => (document.querySelector(".ns-gen-status").textContent || "").includes("生成中"), "轮询驱动生成中状态");

    const liveBox = document.querySelector(".ns-gen-live");
    // WS 断档：没有 rs.h3.preview；轮询快照带最新帧（step 3）→ 面板显示
    statusState.latest_preview = { step: 3, frames: [frame("p3a"), frame("p3b")], fps: 8, w: 512, h: 288 };
    await until(() => liveBox.style.display === "", "轮询兜底显示预览");
    assert.equal(liveBox.querySelector(".neo-dtl-live-img").src, frame("p3a"));

    // WS 迟到的旧步号（step 2）不得覆盖新帧
    wsSend("rs.h3.preview", { node_id: "task-1", step: 2, frames: [frame("old")], fps: 8, w: 512, h: 288 });
    assert.equal(liveBox.querySelector(".neo-dtl-live-img").src, frame("p3a"), "旧步号被忽略");

    // WS 恢复后的新步号（step 4）继续推进
    wsSend("rs.h3.preview", { node_id: "task-1", step: 4, frames: [frame("p4")], fps: 8, w: 512, h: 288 });
    assert.equal(liveBox.querySelector(".neo-dtl-live-img").src, frame("p4"));

    // 收尾：轮询拿到终态停掉定时器，避免干扰后续用例
    delete statusState.latest_preview;
    statusState.status = "cancelled";
    await until(() => (document.querySelector(".ns-gen-status").textContent || "").includes("已取消"), "轮询驱动已取消状态");
});

test("Studio 导演页：勾选段后只提交勾选的段（运行期临时状态）", async () => {
    localStorage.removeItem("neo_studio_director_closed");
    await import("../../web/studio/studio-app.js");
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-gen-panel"), "生成面板挂载");
    await until(() => document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span")?.textContent === "R1", "配方自动选中");
    await until(() => document.querySelectorAll(".ns-gen-seg-chip").length === 2, "分段格子就位");

    const hint = () => document.querySelector(".ns-gen-segs-hint").textContent;
    const chip = (i) => document.querySelectorAll(".ns-gen-seg-chip")[i];
    assert.match(hint(), /未勾选/, "默认未勾选 = 整片");

    click(chip(0));
    await until(() => hint().includes("勾选"), "提示反映勾选");
    assert.equal(hint(), "仅运行勾选的 1 段：[1]");
    assert.equal(chip(0).getAttribute("aria-pressed"), "true", "格子按下态");
    assert.equal(document.querySelector(".neo-director-overlay"), null, "点格子不应打开编辑器");

    const before = fetchLog.length;
    click(document.querySelector(".ns-gen-run"));
    await until(() => fetchLog.slice(before).some((c) => c.path === "/neo_studio/director/generate"), "提交生成");
    const call = fetchLog.slice(before).find((c) => c.path === "/neo_studio/director/generate");
    assert.equal(call.body.only_segments, "1", "只提交勾选的段（1 基逗号串）");
    assert.equal(call.body.recipe, "R1");
    assert.equal(Object.keys(call.body).sort().join(","), "only_segments,recipe", "生成参数不进请求（参数在配方里）");

    // 全选 / 清空：清空后回到整片（only_segments 空串）
    click(document.querySelector(".ns-gen-segs-all"));
    assert.equal(hint(), "仅运行勾选的 2 段：[1,2]", "全选 = 全部段");
    click(document.querySelector(".ns-gen-segs-clear"));
    assert.match(hint(), /未勾选/, "清空 = 整片");
    const cleared = fetchLog.length;
    click(document.querySelector(".ns-gen-run"));
    await until(() => fetchLog.slice(cleared).some((c) => c.path === "/neo_studio/director/generate"), "提交生成");
    assert.equal(fetchLog.slice(cleared).find((c) => c.path === "/neo_studio/director/generate").body.only_segments, "", "未勾选 = 整片");

    // 分段换掉（重选配方 → 重拉 spec）→ 勾选作废：勾选是运行期临时状态，不跨配方保留
    click(chip(1));
    assert.equal(chip(1).getAttribute("aria-pressed"), "true");
    click(document.querySelector(".ns-director-recipes .neo-recipes-card"));
    await until(() => hint().includes("未勾选"), "重选配方后勾选作废");
    await until(() => document.querySelector(".ns-director-editor .neo-director-panel"), "重选配方同时打开编辑器");
    click(document.querySelector(".neo-director-close"));
    await until(() => !document.querySelector(".ns-director-editor .neo-director-panel"), "关掉重选时打开的编辑器");
});

test("Studio 导演页：分隔条调宽、拖过下限关闭、向外拖出展开（偏好落盘）", async () => {
    await import("../../web/studio/studio-app.js");
    // 用例自带干净起点：清掉上一次落盘的偏好；收起态先进回来，起点固定是展开
    localStorage.removeItem("neo_studio_director_split");
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-director-split"), "分隔条挂载");
    const main = () => document.querySelector(".ns-director-main");
    const split = () => document.querySelector(".ns-director-split");
    const panel = () => document.querySelector(".ns-gen-panel");
    const closed = () => main().classList.contains("ns-director-collapsed");
    const label = () => split().querySelector(".ns-director-split-label").textContent;
    const pref = () => JSON.parse(localStorage.getItem("neo_studio_director_split") || "{}");
    const mouse = (type, x) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
    const key = (k) => new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });

    // 拖动：面板宽度写进内联样式并落盘（jsdom 无布局，clientWidth / offsetWidth 均 0 → 钳到下限）
    split().dispatchEvent(mouse("mousedown", 400));
    assert.ok(main().classList.contains("ns-split-drag") && split().classList.contains("ns-split-drag"), "拖动中关掉过渡");
    window.dispatchEvent(mouse("mousemove", 100));
    window.dispatchEvent(mouse("mouseup", 100));
    assert.ok(!main().classList.contains("ns-split-drag") && !split().classList.contains("ns-split-drag"), "松手恢复过渡");
    assert.equal(panel().style.width, "200px", "拖动写入面板宽度");
    assert.ok(!main().classList.contains("ns-director-collapsed"), "拖到下限没拖过多不关闭面板");
    assert.ok("width" in pref() && "collapsed" in pref(), "宽度与收起状态落盘");
    assert.equal(label(), "", "展开时条上不留字");

    // 拖过下限再多拖一点：这条拖动到此为止，当作把面板拖到关闭
    split().dispatchEvent(mouse("mousedown", 100));
    window.dispatchEvent(mouse("mousemove", 1000));
    assert.ok(main().classList.contains("ns-director-collapsed"), "拖过下限关闭生成面板");
    assert.equal(panel().style.display, "none", "关闭时整块隐藏");
    assert.equal(label(), "◂ 生成面板", "关闭后条上给出向外拖出的入口");
    assert.ok(!main().classList.contains("ns-split-drag"), "关闭即结束拖动");
    window.dispatchEvent(mouse("mouseup", 1000));
    assert.equal(pref().collapsed, true, "关闭状态落盘");

    // 收起 / 展开全靠拖（照 VSCode）：向内拖不动它，向外拖出一点面板就回来，接着按拖出的宽度继续走
    split().dispatchEvent(mouse("mousedown", 100));
    window.dispatchEvent(mouse("mousemove", 100));
    assert.ok(main().classList.contains("ns-director-collapsed"), "向内拖不展开收起的面板");
    window.dispatchEvent(mouse("mousemove", 20));
    assert.ok(!main().classList.contains("ns-director-collapsed"), "向外拖出展开生成面板");
    assert.equal(panel().style.display, "", "展开后面板回到可见");
    assert.equal(panel().style.width, "200px", "展开后从下限接着拖");
    assert.equal(label(), "", "展开时条上不留字");
    window.dispatchEvent(mouse("mouseup", 20));
    assert.equal(pref().collapsed, false, "展开状态落盘");

    // 键盘：← 加宽走钳制，Enter 收起
    split().dispatchEvent(key("ArrowLeft"));
    assert.equal(panel().style.width, "200px", "键盘调宽写入面板宽度");
    split().dispatchEvent(key("Enter"));
    assert.ok(main().classList.contains("ns-director-collapsed"), "Enter 收起生成面板");
    assert.equal(pref().collapsed, true, "Enter 收起状态落盘");
    // 收起后点条上那行字也认（向外拖是主路，点一下给拖不动的人）：上一次拖动的落点先吃掉守卫，第二下才展开
    split().dispatchEvent(mouse("click", 60));
    assert.ok(main().classList.contains("ns-director-collapsed"), "拖动落点那一下点击不展开面板");
    split().dispatchEvent(mouse("click", 60));
    assert.ok(!main().classList.contains("ns-director-collapsed"), "点击收起的分隔条展开生成面板");
    assert.equal(label(), "", "点击展开后条上不留字");

    localStorage.removeItem("neo_studio_director_split");
});

test("Studio 导演页：编辑器「素材库」按钮开合素材库弹窗（画廊随宿主搬移）", async () => {
    await import("../../web/studio/studio-app.js");
    appState.graph = { _nodes: [] };
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-director-recipes .neo-recipes-card"), "配方卡片挂载");
    click(document.querySelector(".ns-director-recipes .neo-recipes-card"));
    await until(() => document.querySelector(".ns-director-editor .neo-director-panel"), "编辑器内嵌出现");

    const modal = () => document.querySelector(".ns-libmodal:not(.ns-hidden)");
    const galleryIn = (root) => !!root?.querySelector(".neo-gallery-panel");
    assert.ok(!modal(), "进入导演页不自动开素材库弹窗");

    // Studio 页面里 scripts/app.js 就是 shim（同一份 sidebarTab / sidebarTabs）；测试钩子把 scripts/app.js
    // 指到 mock，这里把 shim 侧栏写入接回 mock 的调用方，并给 shim 注册素材 tab 的替身
    const { app: shimApp } = await import("../../web/studio/shim/app.js");
    mockApp.extensionManager.sidebarTab = {
        get activeSidebarTabId() { return shimApp.extensionManager.sidebarTab.activeSidebarTabId; },
        set activeSidebarTabId(id) { shimApp.extensionManager.sidebarTab.activeSidebarTabId = id; },
    };
    const galleryEl = document.createElement("div");
    galleryEl.className = "neo-gallery-panel";
    shimApp.extensionManager.registerSidebarTab({
        id: "neo.gallery",
        render: async (el) => { el.innerHTML = ""; el.appendChild(galleryEl); },
    });

    // 素材库按钮在「故事板分镜」页：点它 → 素材库弹窗打开，Neo Gallery 挂进弹窗宿主（Studio 没有 ComfyUI 侧栏）
    click(document.querySelector(".neo-director-tab"));
    const btn = document.querySelector(".neo-director-ff-lib");
    click(btn);
    await until(() => !!modal(), "点素材库开弹窗");
    assert.ok(galleryIn(modal().querySelector(".ns-gallery-host")), "弹窗宿主挂上 Neo Gallery");

    // 再点同一按钮 = 收起：画廊离开弹窗宿主
    click(btn);
    await until(() => !modal(), "再点收起弹窗");
    assert.ok(!galleryIn(document.querySelector(".ns-libmodal .ns-gallery-host")), "收起后画廊离开弹窗宿主");

    // 顶部工具条「配方」：配方面板在配方弹窗里，选卡直接关窗
    const recipesBtn = document.querySelector(".ns-director-libbtns button");
    click(recipesBtn);
    assert.ok(modal(), "配方按钮打开配方弹窗");
    click(document.querySelector(".ns-director-recipes .neo-recipes-card"));
    await sleep(20);
    assert.ok(!modal(), "点配方卡关窗并进编辑器");

    // 切到素材页：弹窗收起，画廊回到素材页宿主
    location.hash = "#/gallery";
    await until(() => galleryIn(document.querySelector(".ns-page:not(.ns-hidden) .ns-gallery-host")), "素材页挂上画廊");
    assert.ok(!modal(), "离开导演页收起弹窗");
    await sleep(20);
});

test("Studio 导演页：配方弹窗开着刷新列表不关窗（当前配方只恢复高亮）", async () => {
    await import("../../web/studio/studio-app.js");
    appState.graph = { _nodes: [] };
    location.hash = "#/director";
    // 上一用例排在队列里的 #/gallery 导航先落地：它落地的 showView 会把本用例刚打开的窗关掉
    await until(() => !!document.querySelector(".ns-page:not(.ns-hidden) .ns-director-libbtns"), "导演页就位");
    await sleep(20);
    await until(() => document.querySelector(".ns-director-recipes .neo-recipes-card-selected"), "首屏自动选中配方");

    const box = () => document.querySelector(".ns-libmodal[data-lib-scope='recipes']");
    const isOpen = () => !!box() && !box().classList.contains("ns-hidden");
    click(document.querySelector(".ns-director-libbtns button"));
    assert.ok(isOpen(), "配方按钮打开配方弹窗");
    // 列表取数落地那一下：旧实现自动选中会重放 onSelect，而 onSelect 第一句就是关窗 → 一打开就关闭
    await until(() => document.querySelectorAll(".ns-director-recipes .neo-recipes-card").length >= 2, "配方列表加载完");
    await sleep(20);
    assert.ok(isOpen(), "列表加载完弹窗还开着");
    assert.ok(document.querySelector(".ns-director-recipes .neo-recipes-card-selected"), "当前配方卡保持高亮");
    click(box().querySelector(".ns-libmodal-close"));
    assert.ok(!isOpen(), "✕ 关窗");
});


test("Studio 导演页：切配方撞上未保存修改 → 确认条处理完才切过去（选中与分段格子不提前跑）", async () => {
    await import("../../web/studio/studio-app.js");
    appState.graph = { _nodes: [] };
    location.hash = "#/director";
    await until(() => document.querySelectorAll(".ns-gen-seg-chip").length === 2, "R1 选中并铺出两段格子");
    await until(() => document.querySelectorAll(".ns-director-editor .neo-director-seg").length === 2, "R1 编辑器挂载");

    const cardName = () => document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span")?.textContent;
    const editorName = () => document.querySelector(".ns-director-editor .neo-director-name-view")?.textContent?.trim();
    assert.equal(cardName(), "R1", "首屏自动选中 R1");

    inputText(document.querySelector(".ns-director-editor .neo-director-prompt"), "改过的段一");
    const r2Card = [...document.querySelectorAll(".ns-director-recipes .neo-recipes-card")]
        .find((c) => c.querySelector(".neo-recipes-card-name span")?.textContent === "R2");
    assert.ok(r2Card, "列表里有第二份导演配方");
    click(r2Card);

    await until(() => document.querySelector(".neo-director-dirty-confirm")?.hidden === false, "弹出未保存确认条");
    assert.equal(editorName(), "R1", "编辑器仍停在 R1");
    assert.equal(cardName(), "R1", "卡片高亮不提前跑");
    assert.equal(document.querySelectorAll(".ns-gen-seg-chip").length, 2, "分段格子不提前切");
    assert.equal(document.querySelector(".ns-gen-spec").textContent, "640×384 · 20 步", "回显仍是 R1 的尺寸/步数");

    click(document.querySelector(".neo-director-dirty-discard"));   // 「放弃修改」→ 旧编辑器关闭，随即打开 R2
    await until(() => document.querySelectorAll(".ns-gen-seg-chip").length === 3, "R2 三段格子");
    await until(() => document.querySelectorAll(".ns-director-editor .neo-director-seg").length === 3, "R2 编辑器挂载");
    assert.equal(editorName(), "R2", "编辑器切到 R2");
    assert.equal(cardName(), "R2", "卡片高亮跟着编辑器落定");
    assert.equal(document.querySelector(".ns-gen-spec").textContent, "1344×768 · 8 步", "回显切到 R2 的尺寸/步数");

    // 干净切换（编辑器不脏）→ 一次点击直接切过去
    click([...document.querySelectorAll(".ns-director-recipes .neo-recipes-card")]
        .find((c) => c.querySelector(".neo-recipes-card-name span")?.textContent === "R1"));
    await until(() => document.querySelectorAll(".ns-gen-seg-chip").length === 2, "切回 R1 两段格子");
    assert.equal(editorName(), "R1", "无未保存修改时直接切换");
});

test("Studio 导演页：配方弹窗里「新增导演配方」关窗让位，空白配方内嵌进本页", async () => {
    await import("../../web/studio/studio-app.js");
    appState.graph = { _nodes: [] };
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-director-libbtns"), "导演页就位");
    const box = () => document.querySelector(".ns-libmodal[data-lib-scope='recipes']");
    const isOpen = () => !!box() && !box().classList.contains("ns-hidden");
    const panelBtn = (label) => [...box().querySelectorAll("button")].find((b) => b.textContent.includes(label));
    const editorName = () => document.querySelector(".ns-director-editor .neo-director-name-view")?.textContent?.trim();
    click(document.querySelector(".ns-director-libbtns button"));   // 配方
    assert.ok(isOpen(), "配方按钮打开配方弹窗");
    await until(() => document.querySelectorAll(".ns-director-recipes .neo-recipes-card").length >= 2, "配方列表加载完");
    click(panelBtn("新增导演配方"));
    assert.ok(!isOpen(), "新增配方照点卡那条路：关窗让位");
    await until(() => document.querySelector(".ns-director-editor .neo-director-panel"), "空白配方挂进本页");
    assert.notEqual(editorName(), "R1", "编辑器不再是旧配方");
    assert.ok(!!document.querySelector(".neo-director-title-left .ns-director-libbtns"), "入口回到标题行");
});

test("Studio 导演页：编辑器关闭 → 生成面板同栏退场，整栏回到引导页", async () => {
    await import("../../web/studio/studio-app.js");
    appState.graph = { _nodes: [] };
    location.hash = "#/director";
    await until(() => document.querySelector(".ns-director-editor .neo-director-panel"), "编辑器内嵌出现");
    const page = document.querySelector(".ns-director");
    const guideBtns = () => [...document.querySelectorAll(".ns-director-empty-actions button")]
        .map((b) => b.textContent.trim());
    const titleBtns = () => [...document.querySelectorAll(".neo-director-title-left .ns-director-libbtns button")]
        .map((b) => b.textContent.trim());
    assert.ok(!page.classList.contains("ns-director-editorless"), "编辑器开着时不是引导页");
    assert.deepEqual(titleBtns(), ["配方", "素材库"], "入口按钮挂进编辑器标题行");
    assert.deepEqual(guideBtns(), ["新建配方"], "编辑器开着时引导页里只剩「新建配方」");

    click(document.querySelector(".neo-director-close"));   // 标题栏 ✕ = 关闭编辑
    await until(() => page.classList.contains("ns-director-editorless"), "关闭后整栏退成引导页");
    assert.equal(document.querySelector(".ns-director-editor .neo-director-panel"), null, "编辑器已卸载");
    assert.deepEqual(guideBtns(), ["配方", "新建配方"], "引导页只留配方与新建配方，素材库不在引导页");
    assert.ok(document.querySelector(".ns-director-empty .neo-gallery-gm-idle-title"), "引导页有起手主行");
    assert.ok(document.querySelector(".ns-director-empty .neo-gallery-gm-idle-sub"), "引导页有起手细注");
    assert.equal(document.querySelectorAll(".ns-director-empty .ns-video-corner").length, 4, "起手说明带四角括号");
    assert.equal(document.querySelector(".ns-director-bar"), null, "入口没有独立一行");

    click([...document.querySelectorAll(".ns-director-empty-actions button")]
        .find((b) => b.textContent.includes("新建配方")));
    await until(() => document.querySelector(".ns-director-editor .neo-director-panel"), "引导页新建配方挂进本页");
    assert.ok(!page.classList.contains("ns-director-editorless"), "编辑器开着不再是引导页");
    assert.deepEqual(titleBtns(), ["配方", "素材库"], "入口回到标题行");
});

test("Studio 导演页：关掉配方后不再自动打开上次的配方（关闭记进偏好）", async () => {
    localStorage.removeItem("neo_studio_director_closed");
    await import("../../web/studio/studio-app.js");
    appState.graph = { _nodes: [] };
    location.hash = "#/director";
    const page = () => document.querySelector(".ns-director");
    const editor = () => document.querySelector(".ns-director-editor .neo-director-panel");
    const guideBtn = (label) => [...document.querySelectorAll(".ns-director-empty-actions button")]
        .find((b) => b.textContent.includes(label));
    const card = (name) => [...document.querySelectorAll(".ns-director-recipes .neo-recipes-card")]
        .find((c) => c.querySelector(".neo-recipes-card-name span")?.textContent === name);

    await until(editor, "编辑器内嵌出现");
    assert.equal(localStorage.getItem("neo_studio_director_closed"), null, "开着编辑器没有关闭偏好");
    click(document.querySelector(".neo-director-close"));
    await until(() => page().classList.contains("ns-director-editorless"), "关闭后整栏退成引导页");
    assert.equal(localStorage.getItem("neo_studio_director_closed"), "1", "关闭记进偏好");

    // 下一次进页 = 配方面板重建：有「关过」的偏好就不再自动把首位那份铺进宿主
    click(guideBtn("配方"));
    await until(() => document.querySelectorAll(".ns-director-recipes .neo-recipes-card").length >= 2, "配方列表重建完");
    for (let i = 0; i < 10; i++) {   // 重建里自动选中一跑就会把编辑器铺进宿主：一出现就断，不靠等满窗口
        await sleep(20);
        assert.equal(editor(), null, "关过的配方不再自动重开");
    }
    assert.ok(page().classList.contains("ns-director-editorless"), "整栏停在引导页");

    click(card("R2"));   // 点卡片是显式要打开 → 偏好丢掉
    await until(editor, "点卡片打开编辑器");
    assert.equal(localStorage.getItem("neo_studio_director_closed"), null, "重新打开就丢掉关闭偏好");
});
