// 技能 ⇄ 画布同步：详情弹窗工作流区带「⤒ 导入到画布」/「💾 回写入技能」
// 导入把技能 workflow.json 按当前设置预渲染后 app.loadApiJson 落画布；回写把画布 API prompt 落盘该技能 workflow.json。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, mockObjectInfo, clearRoutes, jsonResponse, sleep, click } from "./setup.mjs";
import { app, appState, installWorkflowStore, clearWorkflowStore } from "./mocks/comfy-app.mjs";

const WF_TEMPLATE = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" } },
    "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: "{{PROMPT}}" } },
    "3": { class_type: "EmptyLatentImage", inputs: { width: "{{WIDTH}}", height: "{{HEIGHT}}", batch_size: "{{COUNT}}" } },
    "4": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], latent_image: ["3", 0], seed: "{{SEED}}", steps: "{{STEPS}}" } },
    "5": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "{{PREFIX}}" } },
    "9": { class_type: "LoadImage", inputs: { image: "{{REF_IMAGE}}" } },
};

beforeEach(() => {
    resetEnv();
    clearRoutes();
    appState.promptGraph = null;
});


async function openPopup({ id = "custom_a", source = "custom", canvasBtns = true, config = { model: "m.safetensors", default_ratio: "16:9" } } = {}) {
    const { createSkillDetailPopup } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "Gen Skill", content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: true, gen_video: false, requires_ref: false, multi_turn: false, tags: [], category: "image_gen",
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: id, workflow: WF_TEMPLATE }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: [] }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => call.method === "GET" ? jsonResponse(config) : jsonResponse({ success: true }));
    mockObjectInfo({});
    const popup = canvasBtns === false
        ? createSkillDetailPopup(document.body.appendChild(document.createElement("div")), false)
        : createSkillDetailPopup();
    await popup.openExisting(id, source);
    await sleep(80);
    return popup;
}

function importBtn() {
    const all = document.querySelectorAll(".rs-wf-canvas-btns button.rs-wf-canvas-import-btn");
    return all.length ? all[all.length - 1] : null;
}
function writeBtn() {
    const all = document.querySelectorAll(".rs-wf-canvas-btns button.rs-wf-canvas-write-btn");
    return all.length ? all[all.length - 1] : null;
}
// 导入后的待回写提示：🅝 顶菜单按钮绿点。画布上没有回写卡片，落盘走顶菜单「💾 回写入技能」
function menuBtnEl() {
    let btn = document.querySelector(".neo-n-menu-btn");
    if (!btn) {
        btn = document.createElement("button");
        btn.className = "neo-n-menu-btn";
        document.body.appendChild(btn);
    }
    return btn;
}
function writebackArmed() {
    return menuBtnEl().classList.contains("neo-writeback-hint");
}
function toastCards() {
    return document.querySelectorAll("#neo-action-toast-stack .neo-at:not(.neo-at-out)").length;
}
// 回写确认弹窗（后端预览的变更清单 + 「💾 确认保存」）
function writeConfirmDialog() {
    return document.querySelector(".rs-wf-write-confirm");
}
function footBtn(dialog, label) {
    return dialog ? [...dialog.querySelectorAll(".rs-repair-foot button")].find((b) => b.textContent.includes(label)) : null;
}
function logBtn() {
    const all = document.querySelectorAll(".rs-wf-write-log-btn");
    return all.length ? all[all.length - 1] : null;
}
function mockPreview(changes = [], warnings = [], genVideo = false, extra = {}) {
    mockRoute("/neo_image_gen/update_workflow_skill_preview", () =>
        jsonResponse({ success: true, id: "custom_a", changes, warnings, gen_video: genVideo, ...extra }));
}

test("详情弹窗：带 workflow 技能挂「⤒ 导入到画布」「💾 回写入技能」在工作流区头部", async () => {
    await openPopup({ id: "custom_a", source: "custom" });
    const btns = document.querySelector(".rs-wf-canvas-btns");
    assert.ok(btns, "工作流区头部应挂画布按钮行");
    assert.ok(btns.parentElement.classList.contains("rs-skill-workflow-head"), "按钮应在工作流区头部");
    assert.deepEqual(Array.from(btns.querySelectorAll("button")).map((b) => b.textContent),
        ["⤒ 导入到画布", "💾 回写入技能", "🕘 变更记录"]);
});

test("导入到画布：按设置预渲染后 app.loadApiJson（number widget 归 number、参考图留占串）", async () => {
    menuBtnEl();
    await openPopup({ id: "custom_a", source: "custom" });
    const loadedAt = appState.loaded.length;
    click(importBtn());
    await sleep(80);

    const api = appState.loaded.slice(loadedAt).filter((l) => l.kind === "api");
    assert.equal(api.length, 1, "应调 app.loadApiJson 一次");
    assert.equal(api[0].name, "custom_a", "技能名作为画布 meta 名");
    const wf = api[0].data;
    assert.equal(wf["1"].inputs.unet_name, "m.safetensors", "{{MODEL}} 按设置预渲染");
    assert.equal(wf["2"].inputs.text, "", "{{PROMPT}} 归空（画里提示后回写）");
    assert.strictEqual(wf["3"].inputs.width, 1280, "number widget 的纯数字串归 number（长边 1280 对齐 16）");
    assert.strictEqual(wf["3"].inputs.height, 720, "16:9 高 720 对齐 16");
    assert.strictEqual(wf["3"].inputs.batch_size, 1);
    assert.strictEqual(wf["4"].inputs.seed, 0, "SEED 归 0（画布随机后回写落 0）");
    assert.strictEqual(wf["4"].inputs.steps, 20);
    assert.equal(wf["5"].inputs.filename_prefix, "NeoAgent", "非 number widget 保持字符串");
    assert.equal(wf["9"].inputs.image, "{{REF_IMAGE}}", "参考图槽位留占串（画布里选图后回写）");
    assert.ok(writebackArmed(), "导入后应点亮 🅝 绿点（画布上有技能待回写）");
});

test("导入到画布：toast 逐条说明哪些模板变量被灌成写死值（画布上没有 {{变量}}）", async () => {
    menuBtnEl();
    await openPopup({ id: "custom_a", source: "custom" });
    const toastAt = appState.toasts.length;
    click(importBtn());
    await sleep(80);

    const note = appState.toasts.slice(toastAt).find((x) => (x.summary || "").includes("灌入"));
    assert.ok(note, "导入成功应 toast 说明灌入的模板变量");
    assert.ok((note.detail || "").includes("{{WIDTH}}"), "逐条列出被灌成数值的变量：" + note.detail);
    assert.ok((note.detail || "").includes("长边尺寸 1280 × 比例 16:9"), "尺寸写明由长边尺寸 × 默认比例算出：" + note.detail);
    assert.ok((note.detail || "").includes("生成时按本次宽高重算"), "写明生成时按本次宽高重算：" + note.detail);
    assert.ok((note.detail || "").includes("画布上只剩算出来的数值"), "说明画布上不再保留这些变量");
});

test("导入到画布：成功后自动收起技能窗口，回写入口留在顶菜单", async () => {
    menuBtnEl();
    const popup = await openPopup({ id: "custom_a", source: "custom" });
    assert.notEqual(popup.overlay.style.display, "none", "导入前技能窗口应在场");
    click(importBtn());
    await sleep(80);
    assert.equal(popup.overlay.style.display, "none", "导入成功后技能窗口应自动关闭");
    assert.ok(writebackArmed(), "技能窗口关闭后绿点仍在（顶菜单回写入口可用）");
});

test("导入到画布：按流程图同一套布局重排画布节点（分层左到右、列内堆叠、短列居中、适配视图）", async () => {
    const heights = { 1: 120, 2: 100, 3: 80, 4: 100, 5: 100, 9: 60 };
    const nodes = Object.keys(WF_TEMPLATE).map((id) => ({
        id: Number(id),
        size: [240, heights[id]],
        pos: [0, 0],
        setPos(x, y) { this.pos = [x, y]; },
        setSize(s) { this.size = s; },
    }));
    let dirty = 0, fitted = 0;
    appState.graph = { _nodes: nodes, setDirtyCanvas() { dirty++; } };
    app.canvas = { fitViewToSelectionAnimated() { fitted++; } };
    try {
        await openPopup({ id: "custom_a", source: "custom" });
        click(importBtn());
        await sleep(80);

        const at = (id) => nodes.find((n) => String(n.id) === id).pos;
        assert.deepEqual(at("1"), [60, 60], "首列首节点落在边距起点");
        assert.ok(at("2")[0] > at("1")[0] && at("4")[0] > at("2")[0] && at("5")[0] > at("4")[0],
            "依赖链 UNETLoader → CLIPTextEncode → KSampler → SaveImage 逐列右移");
        // 无下游的 9 与 UNETLoader 同列，按各自高度依次下移：60 → 60+120+48
        assert.deepEqual(at("9"), [60, 228], "同列节点按各自高度依次下移");
        // 同列（2/3）按连线落在 KSampler 的参数行顺序排布：positive 行（第 2 行）在 latent_image 行（第 3 行）之上
        assert.ok(at("2")[1] < at("3")[1], "列内按目标参数行位置上下排布，连线不交叉");
        assert.deepEqual(at("2"), [396, 105], "列间距按节点宽度、列内按重心排布");
        assert.deepEqual(at("3"), [396, 253], "latent_image 行靠下，EmptyLatent 排其后");
        assert.deepEqual(at("4"), [732, 176], "KSampler 列按上游重心垂直位置");
        assert.ok(at("5")[1] > 100, "末列相对最高列垂直居中");
        const sz = (id) => nodes.find((n) => String(n.id) === id).size[0];
        assert.equal(sz("1"), 240, "短模型名（m.safetensors）不足原宽，加载节点不加长");
        assert.equal(sz("9"), 240, "同列最宽即原宽，非加载节点不被拉齐缩小");
        assert.ok(dirty >= 1, "重排后应 setDirtyCanvas");
        assert.equal(fitted, 1, "重排后适配视图");
    } finally {
        appState.graph = null;
        app.canvas = null;
    }
});

test("导入到画布：点亮 🅝 绿点，顶菜单「💾 回写入技能」确认变更后把画布落盘该技能", async () => {
    let posted = null;
    mockPreview([{ field: "model", from: "old.safetensors", to: "m.safetensors" }]);
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        posted = b;
        return jsonResponse({ success: true, id: "custom_a", warnings: ["工作流没有 CLIPTextEncode 节点，运行时无法注入提示词"], gen_video: false });
    });
    appState.promptGraph = {
        output: { "10": { class_type: "KSampler", inputs: { model: ["1", 0] } }, "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } } },
        workflow: "{\"nodes\":[]}",
    };
    menuBtnEl();
    await openPopup({ id: "custom_a", source: "custom" });
    click(importBtn());
    await sleep(80);

    assert.ok(writebackArmed(), "导入后 🅝 按钮应点亮绿点（画布上有技能待回写）");
    assert.equal(toastCards(), 0, "画布上不应有常驻回写卡片");
    appState.toasts.length = 0;
    const { runCanvasSkillWriteback } = await import("../../web/skill.js");
    const savedP = runCanvasSkillWriteback();
    await sleep(80);

    assert.equal(posted, null, "未确认前不应落盘");
    const dlg = writeConfirmDialog();
    assert.ok(dlg, "点回写应出变更确认弹窗");
    assert.ok(dlg.textContent.includes("model"), "弹窗应列出预览的变更项");
    assert.ok(dlg.textContent.includes("仅保存 API 工作流"), "弹窗应提示仅保存 API 工作流");
    click(footBtn(dlg, "确认保存"));
    const saved = await savedP;
    await sleep(80);
    assert.equal(saved, true, "确认保存后应返回已保存");
    assert.equal(posted && posted.skill_id, "custom_a", "确认后应把画布落盘该技能");
    assert.deepEqual(Object.keys(posted.workflow), ["10", "11"], "画布 output 原样落盘");
    assert.ok(appState.toasts.some((t) => (t.detail || "").includes("CLIPTextEncode")), "后端 warnings 应 toast 落");
    assert.equal(writebackArmed(), false, "落盘后应清绿点");
});

test("导入到画布：待回写绑定灌入的工作流 tab，切走收起绿点、切回恢复", async () => {
    mockPreview([]);
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => jsonResponse({ success: true, id: b.skill_id, warnings: [], gen_video: false }));
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    const skillWf = { path: "workflows/skill.json" };
    const otherWf = { path: "workflows/other.json" };
    const { setActive, listenerCount } = installWorkflowStore(skillWf);
    try {
        menuBtnEl();
        await openPopup({ id: "custom_a", source: "custom" });
        click(importBtn());
        await sleep(80);

        assert.ok(writebackArmed(), "技能 tab 在场时绿点亮");
        setActive(otherWf);
        assert.equal(writebackArmed(), false, "切到其他画布 tab 应收起绿点");
        setActive(skillWf);
        assert.ok(writebackArmed(), "切回技能 tab 应恢复绿点");

        const { runCanvasSkillWriteback } = await import("../../web/skill.js");
        const savedP = runCanvasSkillWriteback();
        await sleep(80);
        assert.equal(listenerCount(), 1, "未落盘：待回写状态在，tab 监听应保持");
        click(footBtn(writeConfirmDialog(), "确认保存"));
        await savedP;
        await sleep(80);
        assert.equal(listenerCount(), 0, "落盘后应解绑 tab 监听");
    } finally {
        clearWorkflowStore();
    }
});

test("回写入技能：先弹变更确认，确认后 POST update_workflow_skill 落盘 + 后端 warnings toast", async () => {
    let posted = null;
    mockPreview([{ field: "count", from: 1, to: 2 }]);
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        posted = b;
        return jsonResponse({ success: true, id: "custom_a", warnings: ["工作流没有 CLIPTextEncode 节点，运行时无法注入提示词"], gen_video: false });
    });
    appState.promptGraph = {
        output: { "10": { class_type: "KSampler", inputs: { model: ["1", 0] } }, "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } } },
        workflow: "{\"nodes\":[]}",
    };
    await openPopup({ id: "custom_a", source: "custom" });
    const toastAt = appState.toasts.length;
    click(writeBtn());
    await sleep(80);

    const dlg = writeConfirmDialog();
    assert.ok(dlg, "点回写应出变更确认弹窗");
    assert.ok(dlg.textContent.includes("1 处变更"), "标题应给出变更条数");
    click(footBtn(dlg, "确认保存"));
    await sleep(80);

    assert.ok(posted, "应发出 /neo_image_gen/update_workflow_skill");
    assert.equal(posted.skill_id, "custom_a");
    assert.deepEqual(Object.keys(posted.workflow), ["10", "11"], "画布 output 原样落盘");
    assert.ok(appState.toasts.slice(toastAt).some((t) => (t.detail || "").includes("CLIPTextEncode")), "后端 warnings 应 toast 落");
});

test("回写入技能：空画布时不发请求并 toast 提示", async () => {
    let called = false;
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => { called = true; return jsonResponse({ success: true, id: "x" }); });

    appState.promptGraph = null; // mock 回落 { output: {}, workflow: null }
    await openPopup({ id: "custom_a", source: "custom" });
    const toastAt = appState.toasts.length;
    click(writeBtn());
    await sleep(60);
    assert.equal(called, false, "空画布不应回写");
    assert.ok(appState.toasts.slice(toastAt).some((t) => (t.summary || "").includes("无法回写")), "应 toast 无有效工作流");
});

test("Studio 内嵌详情（无画布）：工作流区只挂「⤒ 主画布编辑」，点击带技能 id 开主界面", async () => {
    const opened = [];
    window.open = (url, target) => { opened.push({ url, target }); return null; };
    try {
        await openPopup({ id: "custom_a", source: "custom", canvasBtns: false });
        assert.ok(document.querySelector(".rs-skill-workflow"), "工作流区仍渲染");
        const btns = document.querySelectorAll(".rs-wf-canvas-btns button");
        assert.deepEqual(Array.from(btns).map((b) => b.textContent), ["⤒ 主画布编辑", "🕘 变更记录"], "内嵌只挂交接与记录按钮");
        click(btns[0]);
        await sleep(20);
        assert.deepEqual(opened, [{ url: "/?neo_wf_edit=custom_a", target: "_blank" }], "应带技能 id 打开主界面");
    } finally {
        delete window.open;
    }
});

// Studio 交接：主界面侧灌画布 + toast 动作回写（技能详情弹窗不在场）
function mockSkillRoutes({ id = "custom_a", source = "custom", workflow = WF_TEMPLATE, genVideo = false, config = { model: "m.safetensors", default_ratio: "16:9" } } = {}) {
    // 本文件的 beforeEach 只 resetEnv()：appState 跨用例累积、neo 设置模块级缓存 → 交接用例自己清态、钉死基准尺寸
    appState.toasts.length = 0;
    appState.loaded.length = 0;
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "Gen Skill", cn_name: b.id, source, content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: !genVideo, gen_video: genVideo, requires_ref: false, multi_turn: false, tags: [], category: "image_gen",
    }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: id, workflow }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: [] }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => call.method === "GET" ? jsonResponse(config) : jsonResponse({ success: true }));
    mockObjectInfo({});
}

test("交接导入：按技能 config.json 预渲染灌画布并点亮绿点，顶菜单入口落盘该技能", async () => {
    mockSkillRoutes();
    mockPreview([{ field: "model", from: "old.safetensors", to: "m.safetensors" }]);
    let posted = null;
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        posted = b;
        return jsonResponse({ success: true, id: "custom_a", warnings: ["工作流没有 CLIPTextEncode 节点，运行时无法注入提示词"], gen_video: false });
    });
    appState.promptGraph = {
        output: { "10": { class_type: "KSampler", inputs: { model: ["1", 0] } }, "11": { class_type: "SaveImage", inputs: { images: ["10", 0] } } },
        workflow: "{\"nodes\":[]}",
    };
    const { openSkillWorkflowOnCanvas, runCanvasSkillWriteback } = await import("../../web/skill.js");
    menuBtnEl();
    await openSkillWorkflowOnCanvas("custom_a");
    await sleep(80);

    const api = appState.loaded.filter((l) => l.kind === "api").pop();
    assert.ok(api, "应 app.loadApiJson 灌画布");
    assert.equal(api.name, "custom_a", "loadApiJson 带技能名");
    assert.equal(api.data["1"].inputs.unet_name, "m.safetensors", "MODEL 按 config 预渲染");
    const { width, height, batch_size } = api.data["3"].inputs;
    assert.ok(Number.isInteger(width) && Number.isInteger(height), `WIDTH/HEIGHT 归 number（${width}x${height}）`);
    assert.ok(Math.abs(width / height - 16 / 9) < 0.02, `按技能 default_ratio 16:9 预渲染（${width}x${height}）`);
    assert.equal(batch_size, 1, "COUNT 归 number");
    assert.equal(api.data["4"].inputs.seed, 0, "SEED 归 0");
    assert.equal(api.data["9"].inputs.image, "{{REF_IMAGE}}", "参考图槽位留占串");

    assert.ok(writebackArmed(), "导入后 🅝 按钮应点亮绿点");
    assert.equal(toastCards(), 0, "画布上不应有常驻回写卡片");
    appState.toasts.length = 0;
    const savedP = runCanvasSkillWriteback();
    await sleep(80);
    assert.equal(posted, null, "未确认前不应落盘");
    click(footBtn(writeConfirmDialog(), "确认保存"));
    const saved = await savedP;
    await sleep(80);
    assert.equal(saved, true, "确认保存后应返回已保存");
    assert.equal(posted && posted.skill_id, "custom_a", "确认后应把画布落盘该技能");
    assert.deepEqual(Object.keys(posted.workflow), ["10", "11"]);
    assert.ok(appState.toasts.some((t) => (t.detail || "").includes("CLIPTextEncode")), "后端 warnings 应 toast 落");
    assert.equal(writebackArmed(), false, "落盘后应清绿点");
});

test("交接回写：预设技能只写模型值到本地覆盖，不改 workflow.json、不复制副本", async () => {
    mockSkillRoutes({ id: "image_gen", source: "presets" });
    mockPreview([{ field: "model", from: "old.safetensors", to: "m.safetensors" }], [], false,
        { preset: true, structural: false });
    const posted = [];
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        posted.push(b.skill_id);
        return jsonResponse({ success: true, id: b.skill_id, warnings: [], gen_video: false, preset: true, structural: false });
    });
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    const { openSkillWorkflowOnCanvas, getPendingWriteback, runCanvasSkillWriteback } = await import("../../web/skill.js");
    const btn = menuBtnEl();
    await openSkillWorkflowOnCanvas("image_gen");
    await sleep(80);
    assert.ok(btn.classList.contains("neo-writeback-hint"), "预设导入后同样点亮绿点");

    const savedP = runCanvasSkillWriteback();
    await sleep(80);
    const dlg = writeConfirmDialog();
    assert.ok(dlg.textContent.includes("预设技能：模型值写入预设本地覆盖"), "弹窗应说明预设只写本地覆盖");
    click(footBtn(dlg, "确认保存"));
    await savedP;
    await sleep(80);
    assert.deepEqual(posted, ["image_gen"], "只写预设一次，不应触发复制");
    assert.equal(getPendingWriteback(), null, "落盘后清绿点");
});

test("交接回写：预设结构变更自动复制为自定义技能写入，绿点跟着搬到副本", async () => {
    mockSkillRoutes({ id: "image_gen", source: "presets" });
    mockPreview([{ field: "model", from: "old.safetensors", to: "m.safetensors" }], [], false,
        { preset: true, structural: true });
    const posted = [];
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        posted.push(b.skill_id);
        return jsonResponse({ success: true, id: b.skill_id, warnings: [], gen_video: false });
    });
    mockRoute("/rs_prompts/copy_skill_files", () => jsonResponse({ success: true }));
    mockRoute("/rs_prompts/save_skill", (b) => jsonResponse({ success: true, id: b.id }));
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    const { openSkillWorkflowOnCanvas, getPendingWriteback, runCanvasSkillWriteback } = await import("../../web/skill.js");
    await openSkillWorkflowOnCanvas("image_gen");
    await sleep(80);

    const savedP = runCanvasSkillWriteback();
    await sleep(80);
    const dlg = writeConfirmDialog();
    assert.ok(dlg.textContent.includes("结构变更会自动复制为自定义技能"), "弹窗应说明结构变更的去向");
    click(footBtn(dlg, "确认保存"));
    await savedP;
    await sleep(400);

    assert.equal(posted.length, 2, "先写预设本地覆盖，再把结构写进新建副本");
    assert.equal(posted[0], "image_gen");
    assert.match(posted[1], /^image_gen_copy_/, "第二笔写的是自动新建的自定义副本");
    assert.ok(appState.toasts.some((t) => (t.summary || "").includes("复制为自定义技能")), "应 toast 新副本名");
    assert.equal(getPendingWriteback().id, posted[1], "待回写状态搬到副本（绿点跟着走）");
});

test("交接导入的待回写绑定灌入的工作流 tab：切走 tab 收起绿点、切回来恢复", async () => {
    mockSkillRoutes();
    mockPreview([]);
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => jsonResponse({ success: true, id: b.skill_id, warnings: [], gen_video: false }));
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    const skillWf = { path: "workflows/skill.json" };
    const otherWf = { path: "workflows/other.json" };
    const { setActive, listenerCount } = installWorkflowStore(skillWf);
    try {
        const { openSkillWorkflowOnCanvas, runCanvasSkillWriteback } = await import("../../web/skill.js");
        menuBtnEl();
        await openSkillWorkflowOnCanvas("custom_a");
        await sleep(80);

        assert.ok(writebackArmed(), "技能 tab 在场时绿点亮");
        setActive(otherWf);
        assert.equal(writebackArmed(), false, "切到其他画布 tab 应收起绿点");
        setActive(skillWf);
        assert.ok(writebackArmed(), "切回技能 tab 应恢复绿点");

        const savedP = runCanvasSkillWriteback();
        await sleep(80);
        assert.equal(listenerCount(), 1, "未落盘：待回写状态在，tab 监听应保持");
        click(footBtn(writeConfirmDialog(), "确认保存"));
        await savedP;
        await sleep(80);
        assert.equal(listenerCount(), 0, "落盘后应解绑 tab 监听");
    } finally {
        clearWorkflowStore();
    }
});

test("同画布只认最后导入的技能：再导入顶掉前一个，回写落最后导入的技能", async () => {
    let posted = null;
    mockPreview();
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        posted = b;
        return jsonResponse({ success: true, id: b.skill_id, warnings: [], gen_video: false });
    });
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    const { openSkillWorkflowOnCanvas, getPendingWriteback, runCanvasSkillWriteback } = await import("../../web/skill.js");
    mockSkillRoutes({ id: "custom_a" });
    await openSkillWorkflowOnCanvas("custom_a");
    await sleep(80);
    mockSkillRoutes({ id: "custom_b" });
    await openSkillWorkflowOnCanvas("custom_b");
    await sleep(80);

    assert.equal(getPendingWriteback().id, "custom_b", "待回写顶掉为后导入的技能");
    assert.equal(toastCards(), 0, "画布上不应有常驻回写卡片");
    const savedP = runCanvasSkillWriteback();
    await sleep(80);
    click(footBtn(writeConfirmDialog(), "确认保存"));
    await savedP;
    await sleep(80);
    assert.equal(posted && posted.skill_id, "custom_b", "回写落最后打开的技能");
});

test("主界面启动消费 ?neo_wf_edit：清掉参数后灌画布（等 litegraph:set-graph，避开初始工作流覆盖）", async () => {
    mockSkillRoutes();
    const { runSkillWorkflowHandoff } = await import("../../web/skill.js");
    const canvasEl = document.createElement("canvas");
    app.canvas = { canvas: canvasEl, fitViewToSelectionAnimated() {} };
    window.history.replaceState(null, "", "/?neo_wf_edit=custom_a");
    try {
        runSkillWorkflowHandoff();
        assert.ok(!window.location.search.includes("neo_wf_edit"), "参数应被清掉，刷新不重复导入");
        const loadedAt = appState.loaded.length;
        canvasEl.dispatchEvent(new window.CustomEvent("litegraph:set-graph"));
        await sleep(80);
        assert.ok(appState.loaded.slice(loadedAt).some((l) => l.kind === "api" && l.name === "custom_a"),
            "前端换图落地后灌入技能工作流");
    } finally {
        app.canvas = null;
        window.history.replaceState(null, "", "/");
    }
});

// 画布导出成技能时只有主链值被占位符化，steps / SeedNode.seed / 尺寸等写死留在 workflow.json 里
const BAKED_IMAGE_WF = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "old.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "baked prompt" } },
    "3": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 4 } },
    "4": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["2", 0], latent_image: ["3", 0], seed: 1234567, steps: 8, cfg: 3.5, sampler_name: "euler", scheduler: "normal" } },
    "5": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "old_prefix" } },
    "6": { class_type: "SeedNode", inputs: { seed: 1062097207049416 } },
};

test("交接导入：workflow.json 里写死的 widget 按技能 config.json 覆盖，非技能 widget 原样保留", async () => {
    mockSkillRoutes({
        workflow: BAKED_IMAGE_WF,
        config: { model: "m.safetensors", default_ratio: "16:9", steps: 12, count: 2, output_prefix: "SkillPrefix" },
    });
    const { openSkillWorkflowOnCanvas } = await import("../../web/skill.js");
    await openSkillWorkflowOnCanvas("custom_a");
    await sleep(80);

    const api = appState.loaded.filter((l) => l.kind === "api").pop();
    assert.ok(api, "应 app.loadApiJson 灌画布");
    const wf = api.data;
    assert.strictEqual(wf["4"].inputs.steps, 12, "写死的 steps 按技能 config 覆盖");
    assert.strictEqual(wf["4"].inputs.seed, 0, "写死的 seed 归 0");
    assert.strictEqual(wf["6"].inputs.seed, 0, "SeedNode.seed 同样覆盖");
    assert.strictEqual(wf["3"].inputs.width, 1280, "写死 512 按 default_ratio 16:9 重算");
    assert.strictEqual(wf["3"].inputs.height, 720);
    assert.strictEqual(wf["3"].inputs.batch_size, 2, "COUNT 按 config.count");
    assert.equal(wf["5"].inputs.filename_prefix, "SkillPrefix", "PREFIX 按 config.output_prefix");
    assert.equal(wf["1"].inputs.ckpt_name, "old.safetensors", "checkpoint 名非技能 widget，不动");
    assert.equal(wf["2"].inputs.text, "baked prompt", "提示词节点原样保留");
    assert.strictEqual(wf["4"].inputs.cfg, 3.5, "cfg / sampler_name / scheduler 保留");
    assert.equal(wf["4"].inputs.sampler_name, "euler");
});

const BAKED_VIDEO_WF = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "old_dit.safetensors" } },
    "2": { class_type: "MiniMaxH3Video", inputs: { model: ["1", 0], prompt: "old prompt", width: 640, height: 640, length: 30 } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "old_video_vae.safetensors" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: "old_audio_vae.safetensors" } },
    "5": { class_type: "VAEDecodeAudio", inputs: { samples: ["2", 1], vae: ["4", 0] } },
    "6": { class_type: "KSampler", inputs: { model: ["1", 0], seed: 999, steps: 4 } },
};

test("交接导入（生视频）：MiniMaxH3 写死尺寸/时长与 steps 按 config 覆盖，喂 VAEDecodeAudio 的 VAELoader 灌 AUDIO_VAE", async () => {
    mockSkillRoutes({
        workflow: BAKED_VIDEO_WF, genVideo: true,
        config: { model: "d.safetensors", text_encoder: "t.safetensors", vae: "v.safetensors", audio_vae: "a.safetensors", steps: 30, width: 1024, height: 576, length: 8 },
    });
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: ["d.safetensors"], text_encoders: ["t.safetensors"], vae: ["v.safetensors", "a.safetensors"] }));
    const { openSkillWorkflowOnCanvas } = await import("../../web/skill.js");
    await openSkillWorkflowOnCanvas("custom_a");
    await sleep(80);

    const api = appState.loaded.filter((l) => l.kind === "api").pop();
    assert.ok(api, "应 app.loadApiJson 灌画布");
    const wf = api.data;
    assert.equal(wf["1"].inputs.unet_name, "d.safetensors", "MODEL 覆盖写死值");
    assert.strictEqual(wf["2"].inputs.width, 1024, "MiniMaxH3 写死 width 覆盖");
    assert.strictEqual(wf["2"].inputs.height, 576);
    assert.strictEqual(wf["2"].inputs.length, 8, "LENGTH 覆盖写死时长");
    assert.strictEqual(wf["6"].inputs.steps, 30, "steps 覆盖");
    assert.strictEqual(wf["6"].inputs.seed, 0);
    assert.equal(wf["3"].inputs.vae_name, "v.safetensors", "视频 VAE");
    assert.equal(wf["4"].inputs.vae_name, "a.safetensors", "音频 VAE 不灌视频 VAE");
    assert.equal(wf["2"].inputs.prompt, "old prompt", "提示词交接期不注入，原样保留");
});

// ---- 回写变更确认与变更记录 ----

test("回写确认：取消不发回写请求、不写变更记录", async () => {
    localStorage.removeItem("neo.skillWriteLog");
    let posted = false;
    mockPreview([{ field: "count", from: 1, to: 2 }]);
    mockRoute("/neo_image_gen/update_workflow_skill", () => { posted = true; return jsonResponse({ success: true, id: "custom_a" }); });
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    await openPopup({ id: "custom_a", source: "custom" });
    click(writeBtn());
    await sleep(80);

    const dlg = writeConfirmDialog();
    assert.ok(dlg, "应出变更确认弹窗");
    click(footBtn(dlg, "取消"));
    await sleep(60);
    assert.equal(posted, false, "取消不应发回写请求");
    assert.equal(document.querySelector(".rs-wf-write-confirm"), null, "取消后弹窗应关闭");
    assert.equal(localStorage.getItem("neo.skillWriteLog"), null, "取消不应写变更记录");
});

test("回写确认：预览失败时不发回写请求并 toast 提示", async () => {
    let posted = false;
    mockRoute("/neo_image_gen/update_workflow_skill_preview", () => jsonResponse({ error: "Preset skill is read-only" }, 403));
    mockRoute("/neo_image_gen/update_workflow_skill", () => { posted = true; return jsonResponse({ success: true, id: "custom_a" }); });
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    await openPopup({ id: "custom_a", source: "custom" });
    const toastAt = appState.toasts.length;
    click(writeBtn());
    await sleep(80);
    assert.equal(posted, false, "预览失败不应回写");
    assert.equal(writeConfirmDialog(), null, "预览失败不应出确认弹窗");
    assert.ok(appState.toasts.slice(toastAt).some((t) => (t.summary || "").includes("回写入失败")), "应 toast 预览失败");
});


// ---- 待回写状态：顶菜单入口与 🅝 绿点（状态在 skill-writeback.js，绿点是唯一画布侧提示）----

test("导入后待回写状态：绿点在场，切走 tab 收起、切回恢复", async () => {
    mockSkillRoutes();
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    const skillWf = { path: "workflows/skill.json" };
    const otherWf = { path: "workflows/other.json" };
    const { setActive, listenerCount } = installWorkflowStore(skillWf);
    const btn = menuBtnEl();
    try {
        const { openSkillWorkflowOnCanvas, getPendingWriteback } = await import("../../web/skill.js");
        await openSkillWorkflowOnCanvas("custom_a");
        await sleep(80);
        assert.equal(toastCards(), 0, "画布上不应有常驻回写卡片");
        const pending = getPendingWriteback();
        assert.ok(pending && pending.id === "custom_a", "导入后应登记待回写（顶菜单入口靠它）");
        assert.ok(btn.classList.contains("neo-writeback-hint"), "待回写时 🅝 按钮应挂绿点");

        setActive(otherWf);
        assert.equal(btn.classList.contains("neo-writeback-hint"), false, "切走技能 tab 应收起绿点");
        assert.equal(getPendingWriteback(), null, "切走后当前画布无待回写");
        setActive(skillWf);
        assert.ok(btn.classList.contains("neo-writeback-hint"), "切回应恢复绿点");
        assert.equal(listenerCount(), 1, "待回写期间应保持一个 tab 监听");
    } finally {
        clearWorkflowStore();
    }
});

test("顶菜单入口落盘：确认后清待回写、清绿点并解绑 tab 监听", async () => {
    mockSkillRoutes();
    mockPreview([{ field: "model", from: "old.safetensors", to: "m.safetensors" }]);
    let posted = null;
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        posted = b;
        return jsonResponse({ success: true, id: b.skill_id, warnings: [], gen_video: false });
    });
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    const { listenerCount } = installWorkflowStore({ path: "workflows/skill.json" });
    const btn = menuBtnEl();
    try {
        const { openSkillWorkflowOnCanvas, getPendingWriteback, runCanvasSkillWriteback } = await import("../../web/skill.js");
        await openSkillWorkflowOnCanvas("custom_a");
        await sleep(80);

        const savedP = runCanvasSkillWriteback();
        await sleep(80);
        const dlg = writeConfirmDialog();
        assert.ok(dlg, "顶菜单入口应出变更确认弹窗");
        click(footBtn(dlg, "确认保存"));
        const saved = await savedP;
        await sleep(80);

        assert.equal(saved, true, "确认保存后应返回已保存");
        assert.equal(posted && posted.skill_id, "custom_a", "应落盘该技能");
        assert.equal(getPendingWriteback(), null, "落盘后待回写应清空");
        assert.equal(btn.classList.contains("neo-writeback-hint"), false, "落盘后应清绿点");
        assert.equal(listenerCount(), 0, "落盘后应解绑 tab 监听");
    } finally {
        clearWorkflowStore();
    }
});

test("变更记录：确认回写后按技能记录变更清单，详情弹窗「🕘 变更记录」可查并可清空", async () => {
    localStorage.removeItem("neo.skillWriteLog");
    mockPreview([
        { field: "model", from: "old.safetensors", to: "m.safetensors" },
        { field: "节点 LoadImage", from: "0 个", to: "1 个" },
    ], ["工作流没有 SaveImage 节点，将无法收集输出图片"]);
    mockRoute("/neo_image_gen/update_workflow_skill", () => jsonResponse({ success: true, id: "custom_a", warnings: ["工作流没有 SaveImage 节点，将无法收集输出图片"], gen_video: false }));
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    await openPopup({ id: "custom_a", source: "custom" });
    click(writeBtn());
    await sleep(80);
    click(footBtn(writeConfirmDialog(), "确认保存"));
    await sleep(80);

    const log = JSON.parse(localStorage.getItem("neo.skillWriteLog"));
    assert.equal(log.length, 1, "应写入 1 条变更记录");
    assert.equal(log[0].skillId, "custom_a", "记录按技能关联");
    assert.equal(log[0].source, "editor", "记录标出回写来源（内嵌编辑）");
    assert.deepEqual(log[0].changes.map((c) => c.field), ["model", "节点 LoadImage"], "记录保存后端预览的变更清单");

    click(logBtn());
    await sleep(40);
    const dlg = document.querySelector(".rs-skill-write-log-overlay");
    assert.ok(dlg, "应出变更记录弹窗");
    assert.ok(dlg.textContent.includes("变更记录 · custom_a（1）"), "标题应带技能与条数");
    assert.ok(dlg.textContent.includes("m.safetensors"), "应列出变更新值");
    assert.ok(dlg.textContent.includes("内嵌编辑"), "应标出回写来源");
    assert.ok(dlg.textContent.includes("SaveImage"), "应带出当次 warnings");

    [...dlg.querySelectorAll(".rs-repair-foot button")].find((b) => b.textContent.includes("清空记录")).click();
    await sleep(40);
    assert.equal(localStorage.getItem("neo.skillWriteLog"), "[]", "清空记录应清掉本技能记录");
    assert.equal(document.querySelector(".rs-skill-write-log-overlay"), null, "清空后弹窗应关闭");
});

test("变更记录：每技能上限 50 条，超出后丢最旧", async () => {
    localStorage.removeItem("neo.skillWriteLog");
    mockPreview([{ field: "count", from: 1, to: 2 }]);
    mockRoute("/neo_image_gen/update_workflow_skill", () => jsonResponse({ success: true, id: "custom_a", warnings: [], gen_video: false }));
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    await openPopup({ id: "custom_a", source: "custom" });
    for (let i = 0; i < 52; i++) {
        click(writeBtn());
        await sleep(20);
        click(footBtn(writeConfirmDialog(), "确认保存"));
        await sleep(20);
    }
    const log = JSON.parse(localStorage.getItem("neo.skillWriteLog"));
    assert.equal(log.length, 50, "每技能最多保留 50 条");
});

test("canvasLayout：LoadImage 兜底高度包含预览区（192 > 120）", async () => {
    const { canvasLayout } = await import("../../web/workflow-graph.js");
    const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" } },
        "2": { class_type: "LoadImage", inputs: { image: "example.png" } },
        "3": { class_type: "KSampler", inputs: { model: ["1", 0], image: ["2", 0] } },
    };
    // sizeOf 返回 null → 兜底：LoadImage 用 CANVAS_PREVIEW_H(192)，其余用 CANVAS_NODE_H(120)
    const layout = canvasLayout(wf, () => null);
    const byId = Object.fromEntries(layout.map(c => [c.id, c]));
    // LoadImage 在首列（无上游），UNETLoader 也在首列；LoadImage 高度 192 应把 KSampler 推得更远
    // 同列按高度堆叠：UNETLoader y=60, LoadImage y=60+120+48=228（UNETLoader 高 120）
    // KSampler 在第二列，重心按上游（UNETLoader center=120, LoadImage center=324）
    assert.ok(byId["2"].y > byId["1"].y, "LoadImage 排在 UNETLoader 之后");
    // LoadImage 兜底高度 192：同列堆叠间距 = 120/2 + 192/2 + 48 = 156（中心距）
    const gap = byId["2"].y - byId["1"].y;
    assert.ok(gap >= 156, `LoadImage 预览高度应拉大同列间距（实际 ${gap}）`);
});

test("canvasLayout：参考加载器统一排到最左列，不挤进模型加载列", async () => {
    const { canvasLayout } = await import("../../web/workflow-graph.js");
    const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "QwenImage2.1/qwen_image_2.1_int8_convrot.safetensors" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors" } },
        "3": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["2", 0], "images.image_1": ["10", 0] } },
        "4": { class_type: "AIO_Preprocessor", inputs: { image: ["11", 0], preprocessor: "OpenposePreprocessor" } },
        "5": { class_type: "ZImageFunControlnet", inputs: { model: ["1", 0], image: ["4", 0] } },
        "6": { class_type: "KSampler", inputs: { model: ["5", 0], positive: ["3", 0] } },
        "10": { class_type: "LoadImage", inputs: { image: "a.png" } },
        "11": { class_type: "LoadImage", inputs: { image: "b.png" } },
    };
    const H = { 1: 120, 2: 120, 3: 150, 4: 120, 5: 130, 6: 170, 10: 192, 11: 192 };
    const layout = canvasLayout(wf, (id) => [210, H[id]]);
    const byId = Object.fromEntries(layout.map(c => [c.id, c]));
    const minX = Math.min(...layout.map(c => c.x));
    assert.equal(byId["10"].x, minX, "参考图 1 在最左列");
    assert.equal(byId["11"].x, minX, "参考图 2 与参考图 1 同列（不挤进模型加载列）");
    const gap = Math.abs(byId["10"].y - byId["11"].y);
    assert.ok(gap >= 192 + 48, `同列两张参考图必须不重叠（实际间距 ${gap}）`);
    assert.ok(byId["1"].x > minX, "模型加载列排在参考列右侧");
});

test("回写入技能：默认跳过（bypass）的参考视频/音频槽位取 prompt 时临时启用，取完还原（槽位不丢）", async () => {
    mockPreview([]);
    let posted = null;
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        posted = b;
        return jsonResponse({ success: true, id: b.skill_id, warnings: [], gen_video: false });
    });
    const slots = [{ id: 31, type: "LoadVideo", mode: 4 }, { id: 51, type: "LoadAudio", mode: 4 }];
    const nodes = [...slots, { id: 10, type: "SaveImage", mode: 0 }];
    appState.graph = { _nodes: nodes, setDirtyCanvas() {} };
    const modesAtSerialize = [];
    const orig = app.graphToPrompt;
    app.graphToPrompt = async () => {
        modesAtSerialize.push(nodes.map((n) => n.mode));
        return appState.promptGraph;
    };
    try {
        appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
        await openPopup({ id: "custom_a", source: "custom" });
        click(writeBtn());
        await sleep(80);
        click(footBtn(writeConfirmDialog(), "确认保存"));
        await sleep(80);

        assert.deepEqual(modesAtSerialize[0], [0, 0, 0], "graphToPrompt 跳过 mode 4 节点 → 取 prompt 前槽位应临时启用");
        assert.deepEqual(nodes.map((n) => n.mode), [4, 4, 0], "取完 prompt 后槽位还原跳过");
        assert.ok(posted, "确认后应落盘该技能");
    } finally {
        app.graphToPrompt = orig;
        appState.graph = null;
    }
});

