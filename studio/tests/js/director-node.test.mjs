// L1：NeoH3VideoDirector 节点内时间轴的最小尺寸钳制。
// LiteGraph 核心的 setSize 只替换 size 并触发 onResize，不检查 minWidth/minHeight，
// 拖拽缩小节点会把固定高度的时间轴裁掉——扩展必须在 onResize 里补钳制（最小高度含时间轴）。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, mockObjectInfo, clearRoutes, jsonResponse, sleep, click } from "./setup.mjs";
import { getExtension, appState } from "./mocks/comfy-app.mjs";
import { dispatchApiEvent } from "./mocks/comfy-api.mjs";

const TL_H = 120; // 与 web/director-node.js 的 TL_H 保持一致
const ACT_H = 28; // 与 web/director-node.js 的 ACT_H（时间轴下方操作条）保持一致
const PREVIEW_H = 300; // 与 web/director-node.js 的 PREVIEW_H（预览面板默认高度）保持一致
const PREVIEW_H_MAX = 560; // 与 web/director-node.js 的 PREVIEW_H_MAX（竖屏面板高度上限）保持一致
const PREVIEW_EVENT = "rs.h3.preview"; // 与 web/director-node.js 的 PREVIEW_EVENT（后端 h3_preview 推载荷）保持一致
const PREVIEW_FPS = 8; // 载荷自带的播放帧率
const FRAME_MS = 1000 / PREVIEW_FPS; // 一帧的毫秒数（tick 的推进阈值）
const BASE_W = 340;
const BASE_H = 220;

function makeDirectorNode(recipeValue = "", extraWidgets = []) {
    const node = {
        id: 1,
        type: "NeoH3VideoDirector",
        properties: {},
        widgets: [{ name: "recipe", value: recipeValue }, ...extraWidgets.map((w) => ({ ...w }))],
        inputs: [],
        outputs: [],
        size: [BASE_W, BASE_H],
        minWidth: 0,
        minHeight: 0,
        domWidgets: [],
        addDOMWidget(name, type, el) {
            const w = { name, type, el };
            node.widgets.push(w);
            node.domWidgets.push(w);
            return w;
        },
        // 与前端核心 setSize 同语义：替换 size 后触发 onResize，不做 min 钳制
        setSize(size) {
            node.size = [...size];
            node.onResize?.(node.size);
        },
        // 模拟 ComfyUI computeSize：基础高度 + DOM widget（TL_H）
        computeSize() {
            return [node.size[0], BASE_H + TL_H];
        },
    };
    return node;
}

async function createDirectorNode(recipeValue = "", extraWidgets = []) {
    await import("../../web/director-node.js");
    const ext = getExtension("NeoH3VideoDirector.Timeline");
    assert.ok(ext, "director 时间轴扩展未注册");
    const nodeType = { prototype: {} };
    await ext.beforeRegisterNodeDef(nodeType, { name: "NeoH3VideoDirector" });
    const node = makeDirectorNode(recipeValue, extraWidgets);
    nodeType.prototype.onNodeCreated.call(node);
    node._neoDtNodeType = nodeType; // 测试清理用：可调 onRemoved 注销面板/计时器
    return node;
}

// 测试收尾：清掉 500ms 进度轮询，并按节点移除路径注销预览面板（从事件路由表里摘掉）
function destroyNode(node) {
    clearInterval(node._neoDtProgressTimer);
    node._neoDtNodeType.prototype.onRemoved.call(node);
}

test("创建后节点高度与最小高度都包含时间轴", async () => {
    resetEnv();
    const node = await createDirectorNode();
    assert.equal(node.size[0], BASE_W);
    assert.equal(node.size[1], BASE_H + TL_H + ACT_H);
    assert.equal(node.minWidth, BASE_W);
    assert.equal(node.minHeight, BASE_H + TL_H + ACT_H);
});

test("bundle 连接时隐藏 recipe、显示视频 skill 选择器与时长；断开恢复", async () => {
    resetEnv();
    const node = await createDirectorNode("", [{ name: "skill", value: "minimax_h3_t2v" }, { name: "duration_sec", value: 5 }]);
    const recipe = node.widgets.find((w) => w.name === "recipe");
    const skillId = node.widgets.find((w) => w.name === "skill");
    const duration = node.widgets.find((w) => w.name === "duration_sec");
    assert.ok(!recipe.hidden, "默认（无 bundle）显示 recipe");
    assert.equal(skillId.hidden, true, "默认隐藏视频 skill 选择器");
    assert.equal(duration.hidden, true, "默认隐藏时长（配方模式各段自带时长）");

    node._neoDtApplyBundleLock(true);   // 连上 BUNDLE：单段模式
    assert.equal(recipe.hidden, true, "bundle 模式隐藏 recipe");
    assert.equal(skillId.hidden, false, "bundle 模式显示视频 skill 选择器");
    assert.equal(duration.hidden, false, "bundle 模式显示时长（秒）");

    node._neoDtApplyBundleLock(false);  // 断开：恢复配方模式
    assert.ok(!recipe.hidden, "断开后恢复 recipe");
    assert.equal(skillId.hidden, true, "断开后隐藏视频 skill 选择器");
    assert.equal(duration.hidden, true, "断开后隐藏时长");
    destroyNode(node);
});

test("bundle 模式时长（秒）跟随所选 skill config 的 length", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "sk-a" }, { id: "sk-b", name: "sk-b" }]));
    mockRoute("/neo_image_gen/skill_config", () => jsonResponse({ length: 124, width: 512, height: 288 }));
    const node = await createDirectorNode("", [{ name: "skill", value: "sk-a" }, { name: "duration_sec", value: 5 }]);
    const duration = node.widgets.find((w) => w.name === "duration_sec");
    await sleep(60); // 初始按 skill config 填充：124 帧 / 24fps → 5 秒
    assert.equal(duration.value, 5, "124 帧 → 5 秒");

    // bundle 模式里切换 skill：按新 skill config 重填（240 帧 → 10 秒）
    mockRoute("/neo_image_gen/skill_config", () => jsonResponse({ length: 240 }));
    const skillId = node.widgets.find((w) => w.name === "skill");
    skillId.value = "sk-b";
    skillId.callback?.("sk-b");
    await sleep(60);
    assert.equal(duration.value, 10, "240 帧 → 10 秒");
    destroyNode(node);
});

test("旧工作流遗留的 duration_sec=-1 载入即修复为 5 秒（同步，不依赖请求）", async () => {
    resetEnv();
    clearRoutes(); // 不 mock 技能/配置接口：修复必须是同步的，不依赖任何请求结果
    const node = await createDirectorNode("", [{ name: "skill", value: "sk-a" }, { name: "duration_sec", value: 5 }]);
    const duration = node.widgets.find((w) => w.name === "duration_sec");
    duration.value = -1; // 模拟旧版默认写回 widgets_values
    node.onConfigure?.(); // 载入工作流：configure 后同步修复，不等任何请求
    assert.equal(duration.value, 5, "-1 就地改回 5 秒");
    destroyNode(node);

    // 已存实值不被覆盖
    const node2 = await createDirectorNode("", [{ name: "skill", value: "sk-a" }, { name: "duration_sec", value: 8 }]);
    const duration2 = node2.widgets.find((w) => w.name === "duration_sec");
    node2.onConfigure?.();
    assert.equal(duration2.value, 8, "已存实值保持不变");
    destroyNode(node2);
});

test("continuity / context_frames 暂不开放：创建后即隐藏，值保持默认", async () => {
    resetEnv();
    const node = await createDirectorNode("recipe-a", [{ name: "continuity", value: true }, { name: "context_frames", value: 22 }]);
    const continuity = node.widgets.find((w) => w.name === "continuity");
    const contextFrames = node.widgets.find((w) => w.name === "context_frames");
    assert.equal(continuity.hidden, true, "隐藏 continuity");
    assert.equal(contextFrames.hidden, true, "隐藏 context_frames");
    // 隐藏不等于清空：值仍随工作流保存、仍随 prompt 发给后端（旧工作流里存的值照旧生效）
    assert.equal(continuity.value, true);
    assert.equal(contextFrames.value, 22);
    destroyNode(node);
});

test("拖拽缩小被钳制在最小尺寸，时间轴不被裁切", async () => {
    resetEnv();
    const node = await createDirectorNode();
    node.setSize([200, 150]);
    assert.equal(node.size[0], BASE_W, "宽度应钳制到 minWidth");
    assert.equal(node.size[1], BASE_H + TL_H + ACT_H, "高度应钳制到含时间轴+操作条的 minHeight");
});

test("拖拽放大不受影响，且时间轴宽度随节点同步", async () => {
    resetEnv();
    const node = await createDirectorNode();
    node.setSize([500, 420]);
    assert.deepEqual(node.size, [500, 420]);
    const tl = node.domWidgets.find((w) => w.name === "director_timeline");
    assert.ok(tl, "时间轴 DOM widget 缺失");
    assert.equal(tl.width, 500);
});

test("点击节点时间轴上的分段块直接打开配方编辑器", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 编辑器无媒体候选
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({
        success: true,
        segments: [{ prompt: "第一段", duration_sec: 5 }],
    }));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "dir-recipe", type: "video_director" },
    ]));
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const node = await createDirectorNode("dir-recipe");
    await sleep(60); // 等 loadSpec 把段数据填进时间轴

    const canvas = node._neoDtTimeline.canvas;
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 112, width: 320, height: 112 };

    // 单段块占满 [8,312]，点中间命中块0 → readOnly select → onSelect → openEditor
    canvas.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 160, clientY: 40 }));

    await sleep(120); // openEditor：listRecipes → openDirectorEditor 建浮层
    assert.ok(document.querySelector(".neo-director-overlay"), "点击时间轴块打开编辑器");
});

test("节点时间轴勾选段 → 写入隐藏输入 only_segments；重载配方后清空", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({
        success: true,
        segments: [{ prompt: "第一段", duration_sec: 5 }, { prompt: "第二段", duration_sec: 5 }],
    }));
    mockRoute("/rs_recipes/list", () => jsonResponse([{ name: "dir-recipe", type: "video_director" }]));
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const node = await createDirectorNode("dir-recipe", [{ name: "only_segments", value: "" }]);
    await sleep(60); // 等 loadSpec 把段数据填进时间轴
    const widget = node.widgets.find((w) => w.name === "only_segments");
    const hint = () => node.domWidgets.find((w) => w.name === "director_timeline").el.querySelector(".neo-dtl-runhint");
    assert.equal(widget.hidden, true, "运行期参数输入不占节点版面");
    assert.equal(widget.value, "", "默认空 = 跑整条配方");
    assert.match(hint().textContent, /未勾选/);

    // 点第 2 段块左上角勾选框（块序 [8,160]/[160,312]；勾选框中心 = x+5+6 / 刻度尺18+间距4+偏移4+半高6）
    const canvas = node._neoDtTimeline.canvas;
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 112, width: 320, height: 112 };
    const clickAt = (x, y = 32) => {
        canvas.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
        canvas.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    };
    clickAt(160 + 11);   // 第 2 段（块 x=160）
    assert.equal(widget.value, "2", "勾选写回 1 基段号文本（供执行时读取）");
    assert.equal(hint().textContent, "仅运行勾选的 1 段：[2]");
    assert.equal(document.querySelector(".neo-director-overlay"), null, "点勾选不应打开编辑器");
    clickAt(8 + 11);     // 第 1 段（块 x=8）
    assert.equal(widget.value, "1,2");
    assert.equal(document.querySelector(".neo-director-overlay"), null, "点勾选不应打开编辑器");
    assert.deepEqual(node._neoDtTimeline.getChecked(), [0, 1]);

    // 换配方 / 工作流还原 / 配方保存后重载 → 勾选是运行期临时状态，不保留
    node.widgets.find((w) => w.name === "recipe").callback?.();
    await sleep(60);
    assert.equal(widget.value, "", "重载后勾选清空");
    assert.deepEqual(node._neoDtTimeline.getChecked(), []);
    assert.match(hint().textContent, /未勾选/);
    destroyNode(node);
});

test("recipe 选择窗预览卡：焦点配方显示概览行 + 只读时间轴（节点内嵌同款组件）", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({
        success: true,
        shared: { mode: "i2v", width: 960, height: 544 },
        segments: [
            { skill_id: "sk-a", prompt: "a", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "b", duration_sec: 10 },
            { skill_id: "sk-a", prompt: "c", duration_sec: 5 },
        ],
    }));
    mockRoute("/rs_recipes/list", () => jsonResponse([{ name: "pv-recipe", type: "video_director" }]));
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    const node = await createDirectorNode("pv-recipe");
    const recipe = node.widgets.find((w) => w.name === "recipe");
    assert.equal(typeof recipe.onPointerDown, "function", "recipe combo 应挂选择窗拦截");
    recipe.onPointerDown();
    await sleep(200); // listRecipes → openSkillPickerModal → fetchRecipeSpec → 挂载时间轴 + 概览行

    const preview = document.querySelector(".rs-skill-picker-preview");
    assert.ok(preview, "预览卡应渲染");
    const meta = preview.querySelector(".rs-skill-preview-meta");
    assert.equal(meta?.textContent, "3 段 · 关键帧生视频 · 技能 A ×3 · 960×544 · 总时长 20s", "预览卡显示概览行（旧 i2v 显示为 f2v）");
    assert.ok(preview.querySelector(".neo-dtl-canvas"), "预览卡内嵌只读时间轴 canvas");
    assert.ok(!preview.textContent.includes("加载中"), "预览卡不应停留在加载态");

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(30); // Esc 关窗：onClose 应销毁预览卡时间轴实例
    assert.equal(document.querySelector(".rs-skill-modal-overlay"), null, "Esc 关闭选择窗");
    destroyNode(node);
});

test("轮询 /neo_video_gen/director_progress 后时间轴读到各段生成状态", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({
        success: true,
        segments: [
            { prompt: "a", duration_sec: 5 },
            { prompt: "b", duration_sec: 5 },
            { prompt: "c", duration_sec: 5 },
        ],
    }));
    mockRoute("/neo_video_gen/director_progress", () => jsonResponse({ active: true, segment_index: 1, total_segments: 3 }));

    const node = await createDirectorNode("dir-recipe");
    clearInterval(node._neoDtProgressTimer); // 手动驱动一次，停止自动轮询
    await node._neoDtProgressTick();

    assert.deepEqual(
        node._neoDtTimeline.opts.getProgress(),
        { active: true, segment_index: 1, total_segments: 3, step: 0, total_steps: 0 },
        "进度应写入时间轴 getProgress()",
    );
});

test("取消按钮：运行中显示、点击 POST /neo_video_gen/director/cancel，结束隐藏", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({ success: true, segments: [] }));
    const state = { active: false, segment_index: -1, total_segments: 0 };
    mockRoute("/neo_video_gen/director_progress", () => jsonResponse(state));

    const node = await createDirectorNode("dir-recipe");
    clearInterval(node._neoDtProgressTimer); // 手动驱动，停止自动轮询
    const btn = node._neoDtCancelBtn;
    assert.ok(btn, "实时预览面板带取消按钮");
    assert.equal(btn.style.display, "none", "空闲时隐藏");

    state.active = true; state.segment_index = 0; state.total_segments = 2;
    const cancelBodies = [];
    mockRoute("/neo_video_gen/director/cancel", (body) => { cancelBodies.push(body); return jsonResponse({ success: true, interrupted: true }); });
    await node._neoDtProgressTick();
    assert.equal(btn.style.display, "", "运行中显示");

    btn.click();
    await sleep(60); // 等 POST 落账
    assert.equal(cancelBodies.length, 1, "点击后调了取消端点");

    state.active = false; state.segment_index = -1;
    await node._neoDtProgressTick();
    assert.equal(btn.style.display, "none", "运行结束隐藏");
    destroyNode(node);
});

test("运行时节点加高预留采样预览空间，没有预览内容时结束还原自然高度", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({ success: true, segments: [] }));
    const payload = { active: false, segment_index: -1, total_segments: 0 };
    mockRoute("/neo_video_gen/director_progress", () => jsonResponse(payload));

    const node = await createDirectorNode("dir-recipe");
    clearInterval(node._neoDtProgressTimer); // 手动驱动，停止自动轮询
    const baseH = BASE_H + TL_H + ACT_H;
    assert.equal(node.size[1], baseH, "初始为自然高度（含时间轴+操作条）");

    payload.active = true; payload.segment_index = 0; payload.total_segments = 3;
    await node._neoDtProgressTick();
    assert.equal(node.size[1], baseH + PREVIEW_H, "运行时加高预留采样预览空间");

    payload.active = false; payload.segment_index = -1;
    await node._neoDtProgressTick();
    assert.equal(node.size[1], baseH, "没收到任何预览载荷 → 结束后还原自然高度，不留空位");
});

test("时间轴按进度状态给各段标 done/current，非活动时不显示", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({ success: true, segments: [] }));
    const node = await createDirectorNode("dir-recipe");
    clearInterval(node._neoDtProgressTimer);

    const tl = node._neoDtTimeline;
    tl._progress = { active: true, segment_index: 1, total_segments: 3, step: 2, total_steps: 8 };
    assert.deepEqual(tl._segProgressState(0), ["done", 1], "已完成段标 done");
    assert.deepEqual(tl._segProgressState(1), ["current", 0.25], "当前段标 current + 步数比例");
    assert.deepEqual(tl._segProgressState(2), ["", 0], "待处理段不显示");

    tl._progress = { active: false, segment_index: -1, total_segments: 3 };
    assert.deepEqual(tl._segProgressState(0), ["", 0], "非活动时全部不显示");
});

test("时间轴显示区外右下角「＋ 新增导演配方」按钮打开新建编辑器", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 编辑器无媒体候选
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({ success: true, segments: [] }));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "dir-recipe", type: "video_director" },
    ]));
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const node = await createDirectorNode("dir-recipe");
    const root = node.domWidgets.find((w) => w.name === "director_timeline").el;
    const newBtn = root.querySelector(".neo-dtl-new");
    assert.ok(newBtn, "新增导演配方按钮存在");
    // 按钮在时间轴显示区之外（下方操作条内），而非时间轴行内
    assert.ok(root.querySelector(".neo-dtl-actbar .neo-dtl-new"), "按钮位于时间轴下方操作条");
    assert.ok(!root.querySelector(".neo-dtl-tlrow .neo-dtl-new"), "按钮不在时间轴显示区内");

    newBtn.click();
    await sleep(120); // 直接 openDirectorEditor(null) 建浮层
    assert.ok(document.querySelector(".neo-director-overlay"), "点击后打开新建编辑器");
});

test("配方保存广播（新建）：节点刷新下拉候选并自动选中刚保存的配方", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    let listResp = [{ name: "old-recipe", type: "video_director" }];
    mockRoute("/rs_recipes/list", () => jsonResponse(listResp));
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({ success: true, segments: [] }));

    const node = await createDirectorNode("old-recipe");
    // 模拟真实 combo widget：下拉候选随 INPUT_TYPES 预填
    const recipeWidget = node.widgets.find((w) => w.name === "recipe");
    recipeWidget.options = { values: ["old-recipe"] };

    // 侧栏「新增导演配方」保存成功 → director.js 广播 created=true
    listResp = [{ name: "old-recipe", type: "video_director" }, { name: "new-recipe", type: "video_director" }];
    window.dispatchEvent(new CustomEvent("neo-director-recipe-saved", { detail: { name: "new-recipe", created: true } }));
    await sleep(120); // 等 handler：listRecipes + loadSpec

    assert.ok(recipeWidget.options.values.includes("new-recipe"), "新配方应出现在下拉候选");
    assert.equal(recipeWidget.value, "new-recipe", "新建后自动选中刚保存的配方");
    destroyNode(node);
});

test("配方保存广播（编辑重命名）：当前值失效时回落到第一个有效项", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "renamed-recipe", type: "video_director" },
    ]));
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({ success: true, segments: [] }));

    // 节点当前选中已被重命名的旧名（created=false，不强制选中广播里的 name）
    const node = await createDirectorNode("old-name");
    const recipeWidget = node.widgets.find((w) => w.name === "recipe");
    recipeWidget.options = { values: ["old-name"] };

    window.dispatchEvent(new CustomEvent("neo-director-recipe-saved", { detail: { name: "renamed-recipe", created: false } }));
    await sleep(120);

    assert.deepEqual(recipeWidget.options.values, ["renamed-recipe"], "下拉候选刷新为最新列表");
    assert.equal(recipeWidget.value, "renamed-recipe", "旧值失效后回落到第一个有效项");
    destroyNode(node);
});

test("运行进度跳到后段时节点时间轴自动把该段滚进可视区", async () => {
    resetEnv();
    clearRoutes();
    const payload = { active: true, segment_index: 0, total_segments: 8 };
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({
        success: true,
        segments: Array.from({ length: 8 }, (_, i) => ({ prompt: "seg" + i, duration_sec: 5 })),
    }));
    mockRoute("/neo_video_gen/director_progress", () => jsonResponse(payload));

    const node = await createDirectorNode("dir-recipe");
    clearInterval(node._neoDtProgressTimer);
    await sleep(60); // 等 loadSpec 把 8 段填进时间轴

    const tl = node._neoDtTimeline;
    Object.defineProperty(tl.canvas, "clientWidth", { value: 320, configurable: true });
    const view = tl._visibleWidth();
    assert.ok(tl._width() > view, "8 段内容宽于可视区（可滚动）");
    assert.equal(tl.scroll.scrollLeft, 0);

    payload.segment_index = 6;          // 后端推进到第 7 段
    await node._neoDtProgressTick();
    assert.ok(tl.scroll.scrollLeft > 0, "自动滚动跟随当前生成段");
    const b = tl._layout().blocks[6];
    assert.ok(b.x >= tl.scroll.scrollLeft && b.x + b.w <= tl.scroll.scrollLeft + view, "当前段整体落在可视区内");

    const settled = tl.scroll.scrollLeft;
    await node._neoDtProgressTick();    // 同一段再轮询：不重复滚动
    assert.equal(tl.scroll.scrollLeft, settled, "同一段重复轮询不再滚动");
});


test("点击节点时间轴第 3 块：编辑器打开即定位到该段", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({
        success: true,
        segments: [
            { prompt: "a", duration_sec: 5 },
            { prompt: "b", duration_sec: 5 },
            { prompt: "c", duration_sec: 5 },
        ],
    }));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "dir-recipe", type: "video_director", shared: {}, segments: [
            { skill_id: "sk-a", prompt: "a", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "b", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "c", duration_sec: 5 },
        ] },
    ]));
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const node = await createDirectorNode("dir-recipe");
    await sleep(60); // 等 loadSpec 把 3 段填进节点时间轴

    const canvas = node._neoDtTimeline.canvas;
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 112, width: 320, height: 112 };

    // 内容宽按块净高 84×16/9 取默认基准：3 段 ≈ 464，每段 149.3；第 3 块 [306.7,456]，点中点 381
    canvas.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 381, clientY: 40 }));
    await sleep(140); // openEditor：listRecipes → openDirectorEditor(meta, cb, 2)

    const segs = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(segs.length, 3, "编辑器载入全部 3 段");
    assert.equal(segs.findIndex((s) => s.classList.contains("neo-director-seg-current")), 2, "定位到点击的第 3 段");
    assert.equal(segs[2].querySelector(".neo-director-prompt").value, "c", "显示的是被点段的内容");
});

test("切换 recipe 下拉后节点时间轴重新拉取并更新", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };

    // mock 按「当前」recipe widget 值返回不同 spec，验证 loadSpec 读到的是切换后的新值
    let recipeWidgetRef = null;
    mockRoute("/rs_recipes/director_spec", async () => {
        const name = recipeWidgetRef ? String(recipeWidgetRef.value || "") : "";
        if (name === "recipe-b") {
            return jsonResponse({ success: true, segments: [
                { prompt: "B1", duration_sec: 5 },
                { prompt: "B2", duration_sec: 5 },
            ] });
        }
        return jsonResponse({ success: true, segments: [{ prompt: "A1", duration_sec: 5 }] });
    });

    const node = await createDirectorNode("recipe-a");
    recipeWidgetRef = node.widgets.find((w) => w.name === "recipe");
    await sleep(60); // 初始 loadSpec：recipe-a → 1 段
    const tl = node._neoDtTimeline;
    assert.equal(tl._segs.length, 1, "初始载入 recipe-a 的 1 段");

    // 模拟 LiteGraph combo 变化：先更新 value，再触发 callback（本版本 combo 用 callback 而非 onchange）
    recipeWidgetRef.value = "recipe-b";
    recipeWidgetRef.callback("recipe-b");
    await sleep(60); // loadSpec 重新拉取 recipe-b → 2 段

    assert.equal(tl._segs.length, 2, "切换后时间轴更新为 recipe-b 的 2 段");
});

test("工作流还原：configure 直写 recipe 不触发回调，时间轴按还原值重拉且保留已存尺寸", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    let recipeWidgetRef = null;
    mockRoute("/rs_recipes/director_spec", async () => {
        const name = recipeWidgetRef ? String(recipeWidgetRef.value || "") : "";
        if (name === "recipe-b") {
            return jsonResponse({ success: true, segments: [
                { prompt: "B1", duration_sec: 5 },
                { prompt: "B2", duration_sec: 5 },
            ], defaults: { width: 960, height: 544, steps: 8 } });
        }
        return jsonResponse({ success: true, segments: [{ prompt: "A1", duration_sec: 5 }],
            defaults: { width: 1344, height: 768, steps: 20 } });
    });

    // 工作流已存的尺寸（steps=-1 表示按配方默认填充）
    const node = await createDirectorNode("recipe-a", [
        { name: "width", value: 1280 },
        { name: "height", value: 544 },
        { name: "steps", value: -1 },
    ]);
    recipeWidgetRef = node.widgets.find((w) => w.name === "recipe");
    clearInterval(node._neoDtProgressTimer);
    await sleep(60); // onNodeCreated 的首次拉取用的是还原前的值
    assert.equal(node._neoDtTimeline._segs.length, 1, "初始拉取为还原前 recipe-a 的 1 段");

    // 模拟 LiteGraph configure：按 widgets_values 直写 value（不触发 callback），随后调 onConfigure
    recipeWidgetRef.value = "recipe-b";
    node.widgets.find((w) => w.name === "width").value = 1280;
    node.widgets.find((w) => w.name === "height").value = 544;
    node.widgets.find((w) => w.name === "steps").value = -1; // 工作流里存的就是 -1
    node.onConfigure({});
    await sleep(60); // onConfigure 补拉的 loadSpec 按还原值重取

    assert.equal(node._neoDtTimeline._segs.length, 2, "还原后时间轴与选中的 recipe-b 对应");
    const dims = () => ["width", "height", "steps"].map((n) => node.widgets.find((w) => w.name === n).value);
    assert.deepEqual(dims(), [1280, 544, 8], "已存尺寸保留，-1 按还原配方的默认填充");
});

const DIM_WIDGETS = [
    { name: "width", value: -1 },
    { name: "height", value: -1 },
    { name: "steps", value: -1 },
];

// 按配方名返回不同的首段默认尺寸/步数（recipe-b 用 turbo 的低步数）
function mockDimDefaults(getRecipeWidget) {
    mockRoute("/rs_recipes/director_spec", () => {
        const name = getRecipeWidget() ? String(getRecipeWidget().value || "") : "";
        const defaults = name === "recipe-b"
            ? { width: 960, height: 544, steps: 8 }
            : { width: 1344, height: 768, steps: 20 };
        return jsonResponse({ success: true, segments: [{ prompt: "s", duration_sec: 5 }], defaults });
    });
}

test("重新载入配方时 width/height/steps 按新配方要求初始化（手改值也不保留）", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    let recipeWidgetRef = null;
    mockDimDefaults(() => recipeWidgetRef);

    const node = await createDirectorNode("recipe-a", DIM_WIDGETS);
    recipeWidgetRef = node.widgets.find((w) => w.name === "recipe");
    clearInterval(node._neoDtProgressTimer);
    await sleep(60); // 初始 loadSpec

    const dims = () => DIM_WIDGETS.map((d) => node.widgets.find((w) => w.name === d.name).value);
    assert.deepEqual(dims(), [1344, 768, 20], "初始按配方 A 首段填充");

    node.widgets.find((w) => w.name === "steps").value = 15; // 用户手改

    recipeWidgetRef.value = "recipe-b";
    recipeWidgetRef.callback("recipe-b");
    await sleep(60);

    assert.deepEqual(dims(), [960, 544, 8], "切换配方后按新配方要求重新初始化，手改的 steps 也不保留");
});

test("创建时保留工作流已存值，切换配方后按新配方要求初始化", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    let recipeWidgetRef = null;
    mockDimDefaults(() => recipeWidgetRef);

    // 工作流还原出的实值（非 -1）：首次载入不得被配方默认覆盖
    const node = await createDirectorNode("recipe-a", [
        { name: "width", value: 1280 },
        { name: "height", value: 544 },
        { name: "steps", value: 15 },
    ]);
    recipeWidgetRef = node.widgets.find((w) => w.name === "recipe");
    clearInterval(node._neoDtProgressTimer);
    await sleep(60);

    const dims = () => DIM_WIDGETS.map((d) => node.widgets.find((w) => w.name === d.name).value);
    assert.deepEqual(dims(), [1280, 544, 15], "创建工作流时保留已存值");

    recipeWidgetRef.value = "recipe-b";
    recipeWidgetRef.callback("recipe-b");
    await sleep(60);

    assert.deepEqual(dims(), [960, 544, 8], "切换配方后按新配方要求初始化");
});

// 节点内实时预览开关：与 preview 输入同一份状态（widget.value 随工作流保存），
// 点「」= 改输入值 + 触发回调；输入被别处改动 / 工作流还原后按钮态同步。
test("「」实时预览开关与 preview 输入双向同步", async () => {
    resetEnv();
    const seen = [];
    const node = await createDirectorNode("", [
        { name: "preview", value: true, callback: (v) => seen.push(v) },
    ]);
    clearInterval(node._neoDtProgressTimer);

    const previewWidget = node.widgets.find((w) => w.name === "preview");
    const root = node.domWidgets.find((w) => w.name === "director_timeline").el;
    const btn = root.querySelector(".neo-dtl-preview");
    assert.ok(btn, "时间轴左侧缺少「」预览开关");
    assert.equal(root.querySelector(".neo-dtl-tlrow").firstElementChild, btn, "开关应在时间轴左侧");
    assert.ok(btn.classList.contains("neo-dtl-preview-on"), "默认开：与后端 preview 默认值一致");

    click(btn);
    assert.equal(previewWidget.value, false, "点开关应写入 preview 输入");
    assert.deepEqual(seen, [false], "点开关应触发输入回调（后端起效 + 随工作流保存）");
    assert.equal(btn.classList.contains("neo-dtl-preview-on"), false, "关闭后按钮变灰");
    assert.match(btn.title, /关/);

    click(btn);
    assert.equal(previewWidget.value, true);
    assert.deepEqual(seen, [false, true]);
    assert.match(btn.title, /开/);

    // 节点自带的 preview 开关 / 别的代码改 value 后触发回调 → 按钮跟随
    previewWidget.value = false;
    previewWidget.callback(false);
    assert.equal(btn.classList.contains("neo-dtl-preview-on"), false);
    assert.deepEqual(seen, [false, true, false]);

    // 工作流还原按 widgets_values 直写 value、不触发回调 → configure 后补同步
    previewWidget.value = true;
    node.onConfigure({});
    assert.ok(btn.classList.contains("neo-dtl-preview-on"), "还原工作流后按钮态与 preview 输入一致");
});

// 节点内实时预览面板：后端（h3_preview.py）每步抽多帧经自有事件 rs.h3.preview 推来，
// 前端自动循环播放该步动画，支持暂停/逐帧/逐采样步回看；运行结束或换段清空（每段各自从第 1 步计数）。
const frame = (name) => `data:image/jpeg;base64,${name}`;

function payload(nodeId, names, fps = PREVIEW_FPS, w = 512, h = 288) {
    return { node_id: nodeId, frames: names.map(frame), fps, w, h };
}

async function createPreviewNode() {
    const node = await createDirectorNode();
    clearInterval(node._neoDtProgressTimer);
    const box = node._neoDtPreviewBox;
    return {
        node,
        box,
        img: box.querySelector(".neo-dtl-live-img"),
        labels: () => [...box.querySelectorAll(".neo-dtl-live-label")].map((e) => e.textContent),
    };
}

test("实时预览：载荷到达立即显示面板、加高节点并播第一帧", async () => {
    resetEnv();
    const { node, box, img, labels } = await createPreviewNode();
    assert.equal(box.style.display, "none", "空闲时不占位");
    assert.equal(node.size[1], BASE_H + TL_H + ACT_H);

    assert.equal(dispatchApiEvent(PREVIEW_EVENT, payload(1, ["a", "b", "c"])), 1, "预览事件应有监听者");
    assert.equal(box.style.display, "");
    assert.equal(box.style.height, PREVIEW_H + "px");
    assert.equal(img.src, frame("a"));
    assert.equal(labels()[0], "第 1/1 步");
    assert.equal(labels()[1], "1/3 帧");
    assert.equal(node.size[1], BASE_H + TL_H + ACT_H + PREVIEW_H, "首个载荷不等 500ms 轮询就先加高");
    destroyNode(node);
});

test("实时预览：面板高度按画面比例自适应，手动拉高节点时面板跟着长高", async () => {
    resetEnv();
    const { node, box } = await createPreviewNode();
    const baseH = BASE_H + TL_H + ACT_H;

    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["a"], PREVIEW_FPS, 288, 512)); // 竖屏：按比例要高于默认高度
    assert.equal(box.style.height, PREVIEW_H_MAX + "px", "竖屏载荷面板按比例放大（封顶 PREVIEW_H_MAX）");
    assert.equal(node.size[1], baseH + PREVIEW_H_MAX, "节点加高到装得下面板");

    node.setSize([node.size[0], baseH + PREVIEW_H_MAX + 160]); // 手动拉高节点
    assert.equal(node.size[1], baseH + PREVIEW_H_MAX + 160);
    assert.equal(box.style.height, PREVIEW_H_MAX + 160 + "px", "拉高后预览面板吃满多出来的高度，下方不留空白");

    node.setSize([node.size[0], baseH]); // 压回基础高度
    assert.equal(node.size[1], baseH, "压到基础高度由 minHeight 兜住");
    assert.equal(box.style.height, PREVIEW_H + "px", "面板停在默认高度，不缩到装不下");

    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["b"])); // 横向 512×288
    assert.equal(box.style.height, PREVIEW_H + "px", "横向载荷保持默认高度");
    assert.equal(node.size[1], baseH + PREVIEW_H, "换横向载荷后按默认高度加高节点");
    destroyNode(node);
});


test("实时预览：事件按 node_id 过滤，别的节点不显示面板", async () => {
    resetEnv();
    const { node, box } = await createPreviewNode();
    dispatchApiEvent(PREVIEW_EVENT, payload(99, ["x"]));
    assert.equal(box.style.display, "none");
    assert.equal(node.size[1], BASE_H + TL_H + ACT_H);
    destroyNode(node);
});

test("实时预览：自动循环播放，可暂停/继续", async () => {
    resetEnv();
    const { node, box, img } = await createPreviewNode();
    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["a", "b", "c"]));

    node._neoDtLive.tick(1000);                       // 第一次 tick 只对时
    node._neoDtLive.tick(1000 + FRAME_MS);
    assert.equal(img.src, frame("b"));
    node._neoDtLive.tick(1000 + 2 * FRAME_MS);
    assert.equal(img.src, frame("c"));
    node._neoDtLive.tick(1000 + 3 * FRAME_MS);
    assert.equal(img.src, frame("a"), "到尾自动循环回第一帧");

    click(box.querySelector(".neo-dtl-live-play"));
    assert.match(box.querySelector(".neo-dtl-live-play").title, /继续/);
    node._neoDtLive.tick(2000);
    node._neoDtLive.tick(4000);
    assert.equal(img.src, frame("a"), "暂停后不再换帧");

    click(box.querySelector(".neo-dtl-live-play"));
    node._neoDtLive.tick(5000);                       // 继续播放：先对时，不立刻跳帧
    assert.equal(img.src, frame("a"));
    node._neoDtLive.tick(5000 + FRAME_MS);
    assert.equal(img.src, frame("b"));
    destroyNode(node);
});

test("实时预览：逐采样步回看，新载荷不把画面拽走", async () => {
    resetEnv();
    const { node, box, img, labels } = await createPreviewNode();
    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["s1a", "s1b"]));
    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["s2a"]));
    assert.equal(img.src, frame("s2a"), "默认跟随最新步");
    assert.equal(labels()[0], "第 2/2 步");

    click(box.querySelector(".neo-dtl-live-step-prev"));
    assert.equal(img.src, frame("s1a"));
    assert.equal(labels()[0], "第 1/2 步");
    assert.equal(labels()[1], "1/2 帧");

    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["s3a"]));
    assert.equal(img.src, frame("s1a"), "回看旧步时新载荷不改画面");
    assert.equal(labels()[0], "第 1/3 步");

    click(box.querySelector(".neo-dtl-live-step-next"));
    assert.equal(labels()[0], "第 2/3 步");
    click(box.querySelector(".neo-dtl-live-step-next"));
    assert.equal(labels()[0], "第 3/3 步");
    assert.equal(img.src, frame("s3a"), "回到最新步后播放它的动画");
    destroyNode(node);
});

test("实时预览：逐帧按钮自动暂停并循环取帧", async () => {
    resetEnv();
    const { node, box, img } = await createPreviewNode();
    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["a", "b", "c"]));

    click(box.querySelector(".neo-dtl-live-frame-next"));
    assert.equal(img.src, frame("b"));
    assert.match(box.querySelector(".neo-dtl-live-play").title, /继续/, "逐帧即暂停");
    click(box.querySelector(".neo-dtl-live-frame-next"));
    assert.equal(img.src, frame("c"));
    click(box.querySelector(".neo-dtl-live-frame-prev"));
    assert.equal(img.src, frame("b"));
    click(box.querySelector(".neo-dtl-live-frame-prev"));
    assert.equal(img.src, frame("a"));
    click(box.querySelector(".neo-dtl-live-frame-prev"));
    assert.equal(img.src, frame("c"), "第一帧往前回头到尾帧");
    destroyNode(node);
});

test("实时预览：换段清空重来；运行结束停在最后一帧暂停并保持加高，下一轮才清空", async () => {
    resetEnv();
    clearRoutes();
    let state = { active: true, segment_index: 0, total_segments: 2 };
    mockRoute("/neo_video_gen/director_progress", () => jsonResponse(state));

    const { node, box, img, labels } = await createPreviewNode();
    const playTitle = () => box.querySelector(".neo-dtl-live-play").title;
    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["a"]));
    assert.equal(box.style.display, "");

    state = { active: true, segment_index: 1, total_segments: 2 }; // 换段：仍在运行
    await node._neoDtProgressTick();
    assert.equal(box.style.display, "none");
    assert.equal(node.size[1], BASE_H + TL_H + ACT_H + PREVIEW_H, "运行中保留加高");

    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["b"]));
    assert.equal(labels()[0], "第 1/1 步", "新段从第 1 步重新计数");

    state = { active: false, segment_index: -1, total_segments: 0 }; // 本次运行结束
    await node._neoDtProgressTick();
    assert.equal(box.style.display, "", "结束后面板保留，停在最后一帧");
    assert.equal(img.src, frame("b"), "画面停在最后一帧");
    assert.match(playTitle(), /继续/, "结束后动画暂停");
    assert.equal(node.size[1], BASE_H + TL_H + ACT_H + PREVIEW_H, "面板还在 → 节点保持加高");

    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["迟到"])); // 结束后迟到的载荷
    assert.equal(img.src, frame("b"), "迟到载荷不得把画面拽走");
    assert.match(playTitle(), /继续/, "迟到载荷不得重新自动播放");
    assert.equal(box.style.display, "");

    state = { active: true, segment_index: 0, total_segments: 1 }; // 下一轮运行：这时才清空
    await node._neoDtProgressTick();
    assert.equal(box.style.display, "none", "新一轮运行清空面板");
    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["c"]));
    assert.equal(img.src, frame("c"));
    assert.match(playTitle(), /暂停/, "新一轮恢复自动播放");
    destroyNode(node);
});

test("实时预览：节点移除后载荷不再驱动面板", async () => {
    resetEnv();
    const { node, box, img } = await createPreviewNode();
    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["a"]));
    destroyNode(node);

    dispatchApiEvent(PREVIEW_EVENT, payload(1, ["b"]));
    assert.equal(box.style.display, "none");
    assert.equal(img.hasAttribute("src"), false);
});
test("运行结束：本次产物路径自动记进所选配方（只记路径，不复制文件）", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [{ id: 2, type: "SaveVideo", comfyClass: "SaveVideo" }], links: [] };
    appState.nodeOutputs = { "2": { images: [{ filename: "h3_00001.mp4", subfolder: "", type: "output" }] } };
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({
        success: true, segments: [{ skill_id: "s", prompt: "a", duration_sec: 5 }],
    }));
    let state = { active: true, segment_index: 0, total_segments: 1 };
    mockRoute("/neo_video_gen/director_progress", () => jsonResponse(state));
    let recorded = null;
    mockRoute("/rs_recipes/add_results", (body) => {
        recorded = body;
        return jsonResponse({ success: true, added: 1, skipped: 0 });
    });

    const node = await createDirectorNode("res-recipe");
    clearInterval(node._neoDtProgressTimer);
    await node._neoDtProgressTick();   // 本轮开始
    assert.equal(recorded, null, "运行中不记录");

    state = { active: false, segment_index: -1, total_segments: 0 };
    await node._neoDtProgressTick();   // 运行结束
    await sleep(40);
    assert.deepEqual(recorded, {
        name: "res-recipe",
        results: [{ filename: "h3_00001.mp4", subfolder: "", type: "output", kind: "video" }],
    }, "把执行产物路径记进所选配方");
    destroyNode(node);

    // bundle 单段模式（没有配方）不记录
    appState.nodeOutputs = { "2": { images: [{ filename: "h3_00002.mp4", subfolder: "", type: "output" }] } };
    recorded = null;
    state = { active: true, segment_index: 0, total_segments: 1 };
    const bundleNode = await createDirectorNode("");
    clearInterval(bundleNode._neoDtProgressTimer);
    await bundleNode._neoDtProgressTick();   // 本轮开始
    state = { active: false, segment_index: -1, total_segments: 0 };
    await bundleNode._neoDtProgressTick();
    await sleep(40);
    assert.equal(recorded, null, "没有配方时不记录");
    destroyNode(bundleNode);
});

test("节点底部挂 skill 状态条：配方各段 skill 缺模型时告警，移除节点即销毁", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    let workflow = { "1": { class_type: "UNETLoader", inputs: { unet_name: "no_such.safetensors" } } };
    const ready = { "1": { class_type: "UNETLoader", inputs: { unet_name: "real.safetensors" } } };
    mockRoute("/rs_recipes/director_spec", () => jsonResponse({
        success: true,
        segments: [{ skill_id: "vid-bad", prompt: "a", duration_sec: 5 }],
    }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ workflow }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => jsonResponse(call.method === "GET" ? {} : { success: true }));
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: ["real.safetensors"], text_encoders: [], vae: [], loras: [] }));
    mockObjectInfo({ UNETLoader: { input: { required: { unet_name: ["UNET_NAME"] }, optional: {} } } });
    mockRoute("/models/diffusion_models", () => jsonResponse(["real.safetensors"]));

    const node = await createDirectorNode("dir-recipe", [{ name: "skill", value: "" }]);
    await sleep(80); // 等 loadSpec 把段（含 skill_id）填进来后重检

    const row = node._neoDtStatusRow;
    assert.ok(row, "节点应持有 skill 状态条实例");
    const root = node.domWidgets.find((w) => w.name === "director_timeline").el;
    assert.ok(root.contains(row.el), "状态条应挂在节点 DOM 根部");
    assert.notEqual(row.el.style.display, "none", "配方段 skill 缺模型应显示告警");
    assert.ok(row.el.querySelector(".neo-skill-status-label").textContent.includes("1 个模型缺失"));

    // 移除节点：状态条销毁并注销事件监听 → 之后的事件不再驱动它
    workflow = ready;
    destroyNode(node);
    assert.equal(node._neoDtStatusRow, null, "onRemoved 应释放状态条");
    window.dispatchEvent(new window.CustomEvent("neo.skillChanged", { detail: { skillId: "vid-bad" } }));
    await sleep(80);
    assert.notEqual(row.el.style.display, "none", "移除后事件不应再驱动检测");
});

test("bundle 模式：预选视频技能缺模型即告警，手动切换 skill 后按新技能重检收起", async () => {
    resetEnv();
    clearRoutes();
    appState.graph = { _nodes: [] };
    const { invalidateSkillValidation } = await import("../../web/skill.js");
    invalidateSkillValidation(); // 前面用例的 mock 技能列表会建出旧名称反查表，清掉避免按旧表兜底成原值
    const badWf = { "1": { class_type: "UNETLoader", inputs: { unet_name: "no_such.safetensors" } } };
    const okWf = { "1": { class_type: "UNETLoader", inputs: { unet_name: "real.safetensors" } } };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "dbad", name: "坏视频技能", gen_image: false, gen_video: true },
        { id: "dok", name: "好视频技能", gen_image: false, gen_video: true },
    ]));
    mockRoute("/neo_image_gen/skill_workflow", (b, call) => jsonResponse({ workflow: String(call.query?.get("skill_id")) === "dbad" ? badWf : okWf }));
    mockRoute("/neo_image_gen/skill_config", () => jsonResponse({}));
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: ["real.safetensors"], text_encoders: [], vae: [], loras: [] }));
    mockRoute("/models/diffusion_models", () => jsonResponse(["real.safetensors"]));
    mockObjectInfo({ UNETLoader: { input: { required: { unet_name: ["UNET_NAME"] }, optional: {} } } });

    const node = await createDirectorNode("", [{ name: "skill", value: "坏视频技能" }, { name: "duration_sec", value: 5 }]);
    node._neoDtApplyBundleLock(true);
    await sleep(80); // 初始检测：预选的 skill 缺模型 → 告警

    const row = node._neoDtStatusRow;
    assert.ok(row, "节点应持有 skill 状态条实例");
    assert.notEqual(row.el.style.display, "none", "预选技能缺模型应显示告警");

    // 手动切换到工作流齐备的技能 → widget callback 触发按新技能重检 → 收起告警
    const skillId = node.widgets.find((w) => w.name === "skill");
    skillId.value = "好视频技能";
    skillId.callback?.("好视频技能");
    await sleep(80);
    assert.equal(row.el.style.display, "none", "切换 skill 后应按新技能重检并收起告警");

    destroyNode(node);
});


