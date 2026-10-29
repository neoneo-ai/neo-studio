// 出图技能工作流导出与每技能设置 UI：
// 技能下拉「From Canvas」把画布 API prompt 导出为出图技能（空画布不发请求）；
// 详情弹窗对 gen_image 技能显示 config.json 覆盖区（自定义可编辑保存 / 预设可编辑存本地覆盖+一键恢复默认 / 非出图技能隐藏）。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, mockRoute, mockObjectInfo, clearRoutes, jsonResponse, flush, sleep, inputText, click } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

// combo 列表（含底部工具栏）挂在 document.body 上，按钮从 body 里找
function canvasBtn() {
    return Array.from(document.querySelectorAll(".rs-skill-footer-btn"))
        .find((b) => b.textContent === "From Canvas");
}

test("From Canvas：单标题对话框导出画布 API prompt 为技能", async () => {
    const { createSkillDropdown } = await import("../../web/skill.js");
    appState.promptGraph = { output: { "10": { class_type: "KSampler", inputs: {} } }, workflow: null };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/neo_image_gen/plan_workflow_skill", () => jsonResponse({ success: true, gen_video: false, warnings: [], candidates: [] }));
    let body = null;
    mockRoute("/neo_image_gen/save_workflow_skill", (b) => {
        body = b;
        return jsonResponse({ success: true, id: "my-skill", warnings: [], gen_video: false });
    });

    const { combo } = createSkillDropdown();
    document.body.appendChild(combo.box);
    canvasBtn().click();
    await sleep(60);

    // 单标题对话框：填入名称后点「创建」（不再问描述/标签）
    const dlg = document.querySelector(".rs-skill-title-dialog");
    assert.ok(dlg, "应弹出标题对话框");
    assert.ok(dlg.querySelector(".rs-skill-title-binds"), "应显示变量替换清单");
    const plainNotes = Array.from(dlg.querySelectorAll(".rs-skill-title-binds-note")).map((n) => n.textContent).join("\n");
    assert.ok(plainNotes.includes("没有可额外勾选的替换项"), "没有候选时给出说明");
    assert.ok(!plainNotes.includes("本次宽高重算"), "没有尺寸候选就不显示重算说明");
    inputText(dlg.querySelector("input.rs-tpl-name"), "My Skill");
    click(Array.from(dlg.querySelectorAll("button")).find((b) => b.textContent === "创建"));
    await sleep(60);

    assert.ok(body, "应发出 /neo_image_gen/save_workflow_skill");
    assert.equal(body.name, "My Skill");
    assert.deepEqual(body.workflow, { "10": { class_type: "KSampler", inputs: {} } });
    assert.deepEqual(body.tags, []);
    assert.equal(body.description, "");
    assert.deepEqual(body.bindings, []);
});

test("From Canvas：候选变量默认全勾，取消勾选的不进 bindings", async () => {
    const { createSkillDropdown } = await import("../../web/skill.js");
    appState.promptGraph = { output: {
        "25": { class_type: "PrimitiveStringMultiline", inputs: { value: "一只红狐狸" } },
        "19": { class_type: "ResolutionSelector", inputs: { aspect_ratio: "1:1 (Square)", megapixels: 1.05 } },
    }, workflow: null };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/neo_image_gen/plan_workflow_skill", () => jsonResponse({
        success: true, gen_video: false, warnings: ["工作流没有 CLIPTextEncode 节点，运行时无法注入提示词"],
        candidates: [
            { node: "25", field: "value", token: "PROMPT", class_type: "PrimitiveStringMultiline", value: "一只红狐狸" },
            { node: "19", field: "megapixels", token: "MEGAPIXELS", class_type: "ResolutionSelector", value: 1.05,
                setting: { key: "base_resolution", value: 1056 } },
            { node: "19", field: "aspect_ratio", token: "ASPECT_RATIO", class_type: "ResolutionSelector", value: "1:1 (Square)",
                setting: { key: "default_ratio", value: "1:1" } },
        ],
    }));
    let body = null;
    mockRoute("/neo_image_gen/save_workflow_skill", (b) => {
        body = b;
        return jsonResponse({ success: true, id: "moss", warnings: [], gen_video: false });
    });

    const { combo } = createSkillDropdown();
    document.body.appendChild(combo.box);
    canvasBtn().click();
    await sleep(80);

    const dlg = document.querySelector(".rs-skill-title-dialog");
    assert.ok(dlg, "应弹出标题对话框");
    const rows = Array.from(dlg.querySelectorAll(".rs-skill-title-bind"));
    assert.equal(rows.length, 3, "三条候选都要列出来");
    assert.ok(rows[0].textContent.includes("{{PROMPT}}"), "候选行显示替换后的变量");
    assert.ok(rows[1].textContent.includes("技能设置「长边尺寸」1056 → {{MEGAPIXELS}}"),
        "尺寸行的主语是技能里真存的设置，不是画布上的 megapixels：" + rows[1].textContent);
    assert.ok(rows[2].textContent.includes("技能设置「默认比例」1:1 → {{ASPECT_RATIO}}"),
        "比例行的主语是默认比例这项真设置，不是画布上的 aspect_ratio 控件：" + rows[2].textContent);
    const sizeValue = rows[1].querySelector(".rs-skill-title-bind-value");
    assert.ok(sizeValue.textContent.includes("当前值 1.05"),
        "来源里的数字只作为「当前值」参考：" + sizeValue.textContent);
    assert.ok(rows[1].querySelector("input").checked, "候选默认勾上");
    const notes = Array.from(dlg.querySelectorAll(".rs-skill-title-binds-note")).map((n) => n.textContent).join("\n");
    assert.ok(notes.includes("长边尺寸 × 默认比例"), "尺寸候选要写明尺寸由「长边尺寸 × 默认比例」按本次宽高算，megapixels 是算出来的");
    assert.ok(notes.includes("megapixels 不是技能设置项"), "要点明 megapixels 不是技能里的设置项");
    assert.ok(notes.includes("0.1–16"), "尺寸候选要写明 megapixels 的取值范围");
    assert.ok(notes.includes("工作流没有 CLIPTextEncode"), "后端 warning 列在清单里");
    rows[1].querySelector("input").checked = false;   // 取消「长边尺寸」
    rows[2].querySelector("input").checked = false;   // 取消「默认比例」
    inputText(dlg.querySelector("input.rs-tpl-name"), "Moss T2I");
    click(Array.from(dlg.querySelectorAll("button")).find((b) => b.textContent === "创建"));
    await sleep(60);

    assert.ok(body, "应发出 /neo_image_gen/save_workflow_skill");
    assert.deepEqual(body.bindings, [{ node: "25", field: "value", token: "PROMPT" }]);
});

test("From Canvas：画布无有效工作流时不发请求并 toast 提示", async () => {
    const { createSkillDropdown } = await import("../../web/skill.js");
    appState.promptGraph = null; // mock 回落 { output: {}, workflow: null }
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    let called = false;
    mockRoute("/neo_image_gen/save_workflow_skill", (b) => {
        called = true;
        return jsonResponse({ success: true, id: "x" });
    });

    const { combo } = createSkillDropdown();
    document.body.appendChild(combo.box);
    canvasBtn().click();
    await sleep(60);

    assert.equal(called, false, "output 为空不应发请求");
    assert.ok(appState.toasts.some((t) => (t.summary || "").includes("无法导出")), "应 toast 提示无法导出");
});

// 详情弹窗出图设置区：mock 一条 load_skill + skill_config（GET/POST 分流）+ models
async function openGenPopup({ id, source, genImage = true, genVideo = false, config = {}, category = "", mode = "", requiresRef = false, overridden = false, fileContent = "body", available = undefined, models = null }) {
    const { createSkillDetailPopup } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "Gen Skill", content: fileContent, files: [{ name: "skill.md", size: 5 }],
        gen_image: genImage, gen_video: genVideo, requires_ref: requiresRef, multi_turn: false, tags: [], category, mode,
        config_overridden: overridden,
        ...(available === undefined ? {} : { available }),
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: fileContent }));
    let saved = null;
    mockRoute("/neo_image_gen/skill_config", (b, call) => {
        if (call.method === "GET") return jsonResponse(config);
        saved = b;
        return jsonResponse({ success: true });
    });
    mockRoute("/neo_image_gen/models", () => jsonResponse(models || {
        diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: ["q.safetensors"],
    }));

    const popup = createSkillDetailPopup();
    await popup.openExisting(id, source);
    return {
        wrap: document.querySelector(".rs-skill-gen-settings"),
        banner: popup.overlay.querySelector(".rs-skill-unavailable-banner"),
        get saved() { return saved; },
    };
}

test("详情弹窗：不可用视频技能（VDN 插件未装）顶部显示说明，可用/非视频技能不显示", async () => {
    const r1 = await openGenPopup({ id: "vdn-off", source: "custom", genImage: false, genVideo: true, category: "video_gen", available: false });
    assert.ok(r1.banner, "横幅元素应存在");
    assert.equal(r1.banner.style.display, "block", "不可用视频技能应显示说明");
    assert.ok(r1.banner.textContent.includes("VDN"), "说明应点明 VDN 依赖");

    const r2 = await openGenPopup({ id: "vdn-on", source: "custom", genImage: false, genVideo: true, category: "video_gen", available: true });
    assert.equal(r2.banner.style.display, "none", "可用视频技能不应显示说明");

    const r3 = await openGenPopup({ id: "plain", source: "custom" });
    assert.equal(r3.banner.style.display, "none", "非视频技能不应显示说明");
});

test("详情弹窗：gen_image 技能显示设置区，回填 config 并可保存覆盖", async () => {
    const r = await openGenPopup({
        id: "image_gen_text", source: "custom",
        config: { default_ratio: "9:16", loras: [{ name: "q.safetensors", strength: 0.8 }] },
    });
    const wrap = r.wrap;

    assert.ok(wrap, "应渲染出图设置区");
    assert.notEqual(wrap.style.display, "none", "gen_image 技能应显示设置区");
    // config 回填：默认比例 + LoRA 行强度（尺寸区两个原生 select：长边 / 默认比例）
    const sizeSelects = wrap.querySelectorAll(".rs-gen-size-section select");
    assert.equal(sizeSelects.length, 2);
    assert.equal(sizeSelects[1].value, "9:16");
    const loraStrength = wrap.querySelector(".rs-gen-lora-strength");
    assert.ok(loraStrength, "应回填 LoRA 行");
    assert.equal(parseFloat(loraStrength.value), 0.8);
    assert.equal(loraStrength.disabled, false, "自定义技能 LoRA 行可编辑");
    assert.equal(wrap.querySelector(".rs-gen-readonly-hint").style.display, "none", "自定义技能不显示只读提示");

    // 修改张数后点底部 Save → 先写正文（/rs_prompts/save_skill）再 POST skill_config（{ skill_id, config }）
    let savedSkill = null;
    mockRoute("/rs_prompts/save_skill", (b) => { savedSkill = b; return jsonResponse({ success: true }); });
    const countInput = wrap.querySelector(".rs-gen-advanced input[type=number]");
    countInput.value = "3";
    document.querySelector(".rs-tpl-save-btn").click();
    await sleep(80);

    assert.ok(savedSkill, "应发出 /rs_prompts/save_skill（正文）");
    assert.ok(r.saved, "应发出 /neo_image_gen/skill_config POST");
    assert.equal(r.saved.skill_id, "image_gen_text");
    assert.equal(r.saved.config.count, 3);
    assert.equal(r.saved.config.default_ratio, "9:16");
});

test("详情弹窗：预设 gen_image 技能设置区可编辑（本地覆盖保存 / 一键恢复默认）", async () => {
    let resetBody = null;
    mockRoute("/rs_prompts/reset_skill_config", (b) => { resetBody = b; return jsonResponse({ success: true }); });
    const r = await openGenPopup({
        id: "image_gen", source: "presets",
        config: { loras: [{ name: "q.safetensors", strength: 0.5 }] },
    });
    const wrap = r.wrap;

    assert.ok(wrap);
    assert.notEqual(wrap.style.display, "none");
    // 预设设置区可编辑（改动存本地覆盖），不再只读禁用
    const controls = wrap.querySelectorAll("select, input");
    assert.ok(controls.length > 0, "应有可展示的控件");
    for (const el of controls) assert.equal(el.disabled, false, "预设技能设置控件应可编辑");
    // load 动态新建的 LoRA 行同样可编辑
    const loraStrength = wrap.querySelector(".rs-gen-lora-strength");
    assert.ok(loraStrength, "预设 config 的 LoRA 行应回填");
    assert.equal(loraStrength.disabled, false);
    // 设置区头部：独立 Save（底部主 Save 仍隐藏）；无覆盖时不显示「↺ 恢复默认」
    const cfgBtns = wrap.querySelector(".rs-gen-cfg-btns");
    assert.ok(cfgBtns && cfgBtns.style.display === "flex", "预设设置区应显示保存按钮行");
    const sectionSave = Array.from(cfgBtns.querySelectorAll("button")).find((b) => b.textContent === "保存");
    assert.ok(sectionSave, "设置区应有独立保存按钮");
    let restoreBtn = Array.from(cfgBtns.querySelectorAll("button")).find((b) => b.textContent.includes("恢复默认"));
    assert.ok(restoreBtn && restoreBtn.style.display === "none", "无覆盖时不应显示「恢复默认」");
    const footerSave = document.querySelector(".rs-tpl-save-btn");
    assert.ok(footerSave && footerSave.style.display === "none", "预设技能底部 Save 应隐藏");

    // 点设置区 Save → POST skill_config（本地覆盖），不写正文
    loraStrength.value = "0.9";
    sectionSave.click();
    await sleep(80);
    assert.ok(r.saved, "应发出 /neo_image_gen/skill_config POST");
    assert.equal(r.saved.skill_id, "image_gen");
    assert.equal(r.saved.config.loras[0].strength, 0.9);
    // 保存后存在覆盖 → 「↺ 恢复默认」出现
    restoreBtn = Array.from(cfgBtns.querySelectorAll("button")).find((b) => b.textContent.includes("恢复默认"));
    assert.equal(restoreBtn.style.display, "inline-block", "保存后应显示「恢复默认」");

    // 点「↺ 恢复默认」→ POST /rs_prompts/reset_skill_config（confirm 默认 true）
    restoreBtn.click();
    await sleep(80);
    assert.deepEqual(resetBody, { id: "image_gen" });
});

test("详情弹窗：非 gen_image 技能不显示设置区", async () => {
    const { wrap } = await openGenPopup({ id: "some_style", source: "custom", genImage: false });

    assert.ok(wrap);
    assert.equal(wrap.style.display, "none");
});

test("复制为自定义：出图技能保留 category/gen_image/requires_ref", async () => {
    let savedSkill = null;
    mockRoute("/rs_prompts/save_skill", (b) => { savedSkill = b; return jsonResponse({ success: true }); });
    mockRoute("/neo_image_gen/copy_skill_files", () => jsonResponse({ success: true }));
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    await openGenPopup({ id: "image_gen", source: "presets", category: "image_gen" });

    const copyBtn = Array.from(document.querySelectorAll(".rs-skill-detail button"))
        .find((b) => b.textContent.includes("复制为自定义"));
    assert.ok(copyBtn, "预设技能应显示复制按钮");
    copyBtn.click();
    await sleep(60);

    assert.ok(savedSkill, "应发出 /rs_prompts/save_skill 请求");
    assert.equal(savedSkill.source, "custom");
    assert.equal(savedSkill.category, "image_gen", "复制后应保留出图分类");
    assert.equal(savedSkill.gen_image, true, "复制后 gen_image 应保留");
    assert.equal(savedSkill.requires_ref, false);
});

test("复制为自定义：视频技能保留 mode（导演分段技能下拉按它过滤）", async () => {
    let savedSkill = null;
    mockRoute("/rs_prompts/save_skill", (b) => { savedSkill = b; return jsonResponse({ success: true }); });
    mockRoute("/neo_image_gen/copy_skill_files", () => jsonResponse({ success: true }));
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    await openGenPopup({
        id: "minimax_h3_i2v", source: "presets",
        genImage: false, genVideo: true, category: "video_gen", mode: "i2v", requiresRef: true,
    });

    const copyBtn = Array.from(document.querySelectorAll(".rs-skill-detail button"))
        .find((b) => b.textContent.includes("复制为自定义"));
    assert.ok(copyBtn, "预设技能应显示复制按钮");
    copyBtn.click();
    await sleep(60);

    assert.ok(savedSkill, "应发出 /rs_prompts/save_skill 请求");
    assert.equal(savedSkill.category, "video_gen", "复制后应保留生视频分类");
    assert.equal(savedSkill.gen_video, true, "复制后 gen_video 应保留");
    assert.equal(savedSkill.mode, "i2v", "复制后视频模式应保留");
    assert.equal(savedSkill.requires_ref, true, "复制后参考图要求应保留");
});

test("复制为自定义：name 与已有 skill 冲突时递增序号", async () => {
    let savedSkill = null;
    mockRoute("/rs_prompts/save_skill", (b) => { savedSkill = b; return jsonResponse({ success: true }); });
    mockRoute("/neo_image_gen/copy_skill_files", () => jsonResponse({ success: true }));
    // 已有两个同名副本 → 第三次复制应得 "Gen Skill (Copy) 3"
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "a", name: "Gen Skill (Copy)" },
        { id: "b", name: "Gen Skill (Copy) 2" },
    ]));
    await openGenPopup({ id: "image_gen", source: "presets", category: "image_gen" });

    const copyBtn = Array.from(document.querySelectorAll(".rs-skill-detail button"))
        .find((b) => b.textContent.includes("复制为自定义"));
    assert.ok(copyBtn, "预设技能应显示复制按钮");
    copyBtn.click();
    await sleep(60);

    assert.ok(savedSkill, "应发出 /rs_prompts/save_skill");
    assert.equal(savedSkill.name, "Gen Skill (Copy) 3", "冲突时 name 递增序号");
});


// ============ 技能详情弹窗：工作流流程图（只读 SVG + 校验高亮）============

const WF_SAMPLE = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "no_such_model.safetensors" } }, // 模型缺失
    "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: "{{PROMPT}}" } },  // 模板变量
    "3": { class_type: "KSampler", inputs: { model: ["1", 0], seed: 1 } },
    "4": { class_type: "SaveImage", inputs: { images: ["3", 0] } },                          // 节点未安装（object_info 未注册）
};

test("layoutWorkflow：拓扑分层、连线收集、环安全", async () => {
    const { layoutWorkflow } = await import("../../web/workflow-graph.js");
    const lay = layoutWorkflow({
        "1": { class_type: "A", inputs: {} },
        "2": { class_type: "B", inputs: { a: ["1", 0] } },
        "3": { class_type: "C", inputs: { a: ["1", 0], b: ["2", 0] } },
    });
    const byId = Object.fromEntries(lay.nodes.map(n => [n.id, n]));
    assert.ok(byId["1"].layer < byId["2"].layer && byId["2"].layer < byId["3"].layer, "分层应随拓扑顺序递增");
    assert.equal(lay.edges.length, 3);
    // 环：4→5→4 不死循环
    const cyc = layoutWorkflow({
        "4": { class_type: "A", inputs: { x: ["5", 0] } },
        "5": { class_type: "B", inputs: { x: ["4", 0] } },
    });
    assert.equal(cyc.nodes.length, 2);
});

test("validateWorkflow：objectInfo 缺失跳过检查；模板变量不算模型缺失", async () => {
    const { validateWorkflow } = await import("../../web/workflow-graph.js");
    // objectInfo=null → 跳过存在性检查，只报模板变量
    const r1 = validateWorkflow(WF_SAMPLE, null, null);
    assert.equal(r1.counts.missingNodes, 0);
    assert.equal(r1.counts.missingModels, 0);
    assert.equal(r1.counts.templates, 1);
    // 完整 objectInfo + 模型列表 → 报缺节点 / 缺模型
    const info = {
        UNETLoader: { input: { required: { unet_name: ["UNET_NAME"] }, optional: {} } },
        CLIPTextEncode: { input: { required: { clip: ["CLIP"], text: ["STRING"] }, optional: {} } },
        KSampler: { input: { required: { model: ["MODEL"], seed: ["INT"] }, optional: {} } },
    };
    const r2 = validateWorkflow(WF_SAMPLE, info, { diffusion_models: ["real.safetensors"] });
    assert.equal(r2.counts.missingNodes, 1);   // SaveImage
    assert.equal(r2.counts.missingModels, 1);  // no_such_model.safetensors
    assert.ok(r2.issues["4"].some(i => i.kind === "missing_node"));
    assert.ok(r2.issues["1"].some(i => i.kind === "missing_model"));
});

test("validateWorkflow：模型名与列表分隔符不一致时两边归一化，真缺失仍标红", async () => {
    const { validateWorkflow } = await import("../../web/workflow-graph.js");
    const info = { UNETLoader: { input: { required: { unet_name: ["UNET_NAME"] }, optional: {} } } };
    // Windows 后端 /models 返回反斜杠、config 存正斜杠 → 两边归一化后命中，不误报缺失
    const ok = validateWorkflow(
        { "1": { class_type: "UNETLoader", inputs: { unet_name: "MiniMaxH3/Speed/foo.safetensors" } } },
        info, { diffusion_models: ["MiniMaxH3\\Speed\\foo.safetensors"] });
    assert.equal(ok.counts.missingModels, 0, "config 正斜杠 vs 列表反斜杠应归一化后匹配");
    // 反向：config 存反斜杠、列表正斜杠 → 同样命中
    const ok2 = validateWorkflow(
        { "1": { class_type: "UNETLoader", inputs: { unet_name: "MiniMaxH3\\Speed\\foo.safetensors" } } },
        info, { diffusion_models: ["MiniMaxH3/Speed/foo.safetensors"] });
    assert.equal(ok2.counts.missingModels, 0);
    // 文件挪进别的子目录、config 仍是旧路径 → 报 missing_model（红标）
    const miss = validateWorkflow(
        { "1": { class_type: "UNETLoader", inputs: { unet_name: "MiniMaxH3/Speed/foo.safetensors" } } },
        info, { diffusion_models: ["MiniMaxH3\\Other\\foo.safetensors"] });
    assert.equal(miss.counts.missingModels, 1, "路径失效（文件挪走）应报缺失");
    assert.ok(miss.issues["1"].some(i => i.kind === "missing_model"));
});

test("validateWorkflow：object_info 内联解析后的 combo 列表时也能判定模型缺失", async () => {
    const { validateWorkflow } = await import("../../web/workflow-graph.js");
    // 本环境 /object_info 把 unet_name 直接内联成路径列表（非 "UNET_NAME" 类型名），
    // 且 Windows 后端返回反斜杠；此时 checkWorkflow 不会拉 /models，需直接用内联列表判定。
    const info = { UNETLoader: { input: { required: { unet_name: [["MiniMaxH3\\Speed\\foo.safetensors", "MiniMaxH3\\top_pruned.safetensors"]] }, optional: {} } } };
    // config 存的是失效旧路径（列表里没有）→ 报 missing_model（红标），不受类型名检测失败影响
    const miss = validateWorkflow(
        { "1": { class_type: "UNETLoader", inputs: { unet_name: "MiniMaxH3/Speed/foo_pruned.safetensors" } } },
        info, {}); // modelLists 为空（未拉取）也应能判定
    assert.equal(miss.counts.missingModels, 1, "内联列表里查不到 config 路径应报缺失");
    assert.ok(miss.issues["1"].some(i => i.kind === "missing_model"));
    // config 存正斜杠、内联列表反斜杠 → 归一化后命中，不误报
    const ok = validateWorkflow(
        { "1": { class_type: "UNETLoader", inputs: { unet_name: "MiniMaxH3/top_pruned.safetensors" } } },
        info, {});
    assert.equal(ok.counts.missingModels, 0, "内联列表应归一化分隔符后匹配");
});

test("详情弹窗：gen_image 技能渲染工作流流程图，高亮缺节点/缺模型/模板变量", async () => {
    mockRoute("/neo_image_gen/skill_workflow", (b, call) => jsonResponse({ skill_id: "x", workflow: WF_SAMPLE }));
    mockObjectInfo({
        UNETLoader: { input: { required: { unet_name: ["UNET_NAME"] }, optional: {} } },
        CLIPTextEncode: { input: { required: { clip: ["CLIP"], text: ["STRING"] }, optional: {} } },
        KSampler: { input: { required: { model: ["MODEL"], seed: ["INT"] }, optional: {} } },
    });
    mockRoute("/models/diffusion_models", () => jsonResponse(["real.safetensors"]));

    await openGenPopup({ id: "image_gen_text", source: "custom" });
    const wfWrap = document.querySelector(".rs-skill-workflow");
    assert.ok(wfWrap && wfWrap.style.display !== "none", "应渲染工作流区");
    assert.equal(wfWrap.querySelectorAll(".rs-wf-node").length, 4, "每个工作流节点一个组");
    assert.equal(wfWrap.querySelectorAll(".rs-wf-edge").length, 3, "三条连线");
    assert.equal(wfWrap.querySelectorAll(".rs-wf-edge-dot").length, 3, "每条连线一个落点标记");
    const edgeColors = Array.from(wfWrap.querySelectorAll("[class^='rs-wf-edge-c']")).map(g => g.getAttribute("class"));
    assert.equal(new Set(edgeColors).size, 3, "不同连线应使用不同颜色便于区分");
    assert.ok(wfWrap.querySelector(".rs-wf-node-bad"), "缺节点/缺模型应红框高亮");
    assert.ok(wfWrap.querySelector(".rs-wf-node-tpl"), "模板变量应蓝框标记");
    const summary = wfWrap.querySelector(".rs-wf-summary").textContent;
    assert.ok(summary.includes("节点未安装") && summary.includes("模型缺失") && summary.includes("模板变量"), "摘要应含三类问题");
});

test("详情弹窗：缺失节点/模型摘要给出名称芯片与复制按钮，点击写入剪贴板且同名去重", async () => {
    // SaveImage 出现两个节点、缺失模型同名出现两处 → 计数各 +2，但芯片各只一个（去重）
    const WF_DUP = {
        ...WF_SAMPLE,
        "5": { class_type: "SaveImage", inputs: {} },
        "6": { class_type: "UNETLoader", inputs: { unet_name: "no_such_model.safetensors" } },
    };
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "x", workflow: WF_DUP }));
    mockObjectInfo({
        UNETLoader: { input: { required: { unet_name: ["UNET_NAME"] }, optional: {} } },
        CLIPTextEncode: { input: { required: { clip: ["CLIP"], text: ["STRING"] }, optional: {} } },
        KSampler: { input: { required: { model: ["MODEL"], seed: ["INT"] }, optional: {} } },
    });
    mockRoute("/models/diffusion_models", () => jsonResponse(["real.safetensors"]));
    const copied = [];
    navigator.clipboard = { writeText: async (t) => { copied.push(t); } };

    await openGenPopup({ id: "image_gen_text", source: "custom" });
    const wfWrap = document.querySelector(".rs-skill-workflow");
    const chips = Array.from(wfWrap.querySelectorAll(".rs-wf-missing-item"));
    assert.equal(chips.length, 2, "同名缺失项应去重为两个芯片");
    const names = chips.map((c) => c.querySelector(".rs-wf-missing-name").textContent);
    assert.deepEqual(names.sort(), ["SaveImage", "no_such_model.safetensors"], "芯片显示节点类名/模型文件名");
    assert.ok(chips.some((c) => (c.title || "").includes("节点未安装：SaveImage")), "节点芯片 title 说明类型");

    for (const c of chips) { c.querySelector(".rs-wf-copy").click(); }
    await sleep(30);
    assert.deepEqual(copied.sort(), ["SaveImage", "no_such_model.safetensors"], "点击复制按钮把名称写入剪贴板");
    assert.ok(chips.every((c) => c.querySelector(".rs-wf-copy").textContent === ""), "复制成功按钮短暂显示 ");
});

test("详情弹窗：非生图技能不渲染工作流区、不发请求", async () => {
    let wfCalled = false;
    mockRoute("/neo_image_gen/skill_workflow", () => { wfCalled = true; return jsonResponse({ workflow: WF_SAMPLE }); });
    await openGenPopup({ id: "text_skill", source: "custom", genImage: false });
    assert.equal(document.querySelector(".rs-skill-workflow").style.display, "none");
    assert.equal(wfCalled, false, "不应请求 workflow.json");
});

test("详情弹窗：带工作流的技能正文区搬进 ? 徽标弹出的文档浮窗", async () => {
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "x", workflow: WF_RENDER }));
    mockObjectInfo({});
    await openGenPopup({ id: "image_gen_text", source: "custom" });

    const row = document.querySelector(".rs-tpl-content").closest(".rs-config-row");
    const docBody = document.querySelector(".rs-skill-doc-body");
    const docOverlay = document.querySelector(".rs-skill-doc-overlay");
    const docBtn = document.querySelector(".rs-skill-doc-btn");
    assert.ok(docBtn, "标题栏应有 ? 徽标");
    assert.notEqual(docBtn.style.display, "none", "带工作流的技能应显示 ? 徽标");
    assert.equal(docOverlay.style.display, "none", "默认不弹出文档浮窗");
    assert.equal(row.parentElement, docBody, "正文区应搬进文档浮窗（不在主区）");

    click(docBtn);
    assert.equal(docOverlay.style.display, "flex", "点 ? 应弹出文档浮窗");

    click(docOverlay.querySelector(".rs-skill-modal-close"));
    assert.equal(docOverlay.style.display, "none", "点 ✕ 应收起浮窗");

    // 徽标与浮窗类名必须与 prompts.css 选择器一致（曾因命名漂移导致规则不生效）
    const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/prompts.css"), "utf8");
    for (const cls of ["rs-skill-doc-overlay", "rs-skill-doc-modal", "rs-skill-doc-body", "rs-skill-doc-btn"]) {
        assert.ok(css.includes("." + cls), `prompts.css 应含 .${cls} 选择器`);
    }
});

test("详情弹窗：无工作流的技能不显示 ? 徽标，正文区留在主区", async () => {
    await openGenPopup({ id: "text_skill", source: "custom", genImage: false });
    const row = document.querySelector(".rs-tpl-content").closest(".rs-config-row");
    assert.equal(document.querySelector(".rs-skill-doc-btn").style.display, "none", "无 workflow.json 时不显示 ? 徽标");
    assert.equal(row.parentElement, document.querySelector(".rs-skill-detail-main"), "正文区留在主区（参与生成）");
});

test("详情弹窗：生图技能无 workflow.json 时隐藏流程图", async () => {
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ error: "missing" }, 404));
    await openGenPopup({ id: "image_gen_text", source: "custom" });
    assert.equal(document.querySelector(".rs-skill-workflow").style.display, "none");
});


// ============ 模板变量按已有参数预渲染（设置值 / 自动建议模型替换，运行时变量保留）============

test("applyWorkflowParams：替换已知参数、保留运行时变量、不改原对象", async () => {
    const { applyWorkflowParams } = await import("../../web/workflow-graph.js");
    const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" } },
        "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "{{LORA_1_NAME}}", strength_model: "{{LORA_1_STRENGTH}}" } },
        "3": { class_type: "CLIPTextEncode", inputs: { text: "{{PROMPT}}", filename: "out/{{PREFIX}}/x" } },
    };
    const out = applyWorkflowParams(wf, { MODEL: "m.safetensors", LORA_1_NAME: "q.safetensors", LORA_1_STRENGTH: 0.6, PREFIX: "NeoAgent" });
    assert.equal(out["1"].inputs.unet_name, "m.safetensors");
    assert.equal(out["2"].inputs.lora_name, "q.safetensors");
    assert.equal(out["2"].inputs.strength_model, "0.6", "数值参数转字符串填入");
    assert.equal(out["3"].inputs.text, "{{PROMPT}}", "运行时变量保留");
    assert.equal(out["3"].inputs.filename, "out/NeoAgent/x", "内嵌占位符同样替换");
    assert.equal(wf["1"].inputs.unet_name, "{{MODEL}}", "原模板不被修改");
    // 空值不替换；无任何有效参数时原样返回
    assert.equal(applyWorkflowParams(wf, { MODEL: "" }), wf);
});

test("applyWorkflowParams：被填走的值记下来源变量 tpl_filled", async () => {
    const { applyWorkflowParams } = await import("../../web/workflow-graph.js");
    const wf = {
        "19": { class_type: "ResolutionSelector", inputs: { resolution: "source", aspect_ratio: "{{ASPECT_RATIO}}", megapixels: "{{MEGAPIXELS}}" } },
        "3": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: "{{PROMPT}}" } },
    };
    const out = applyWorkflowParams(wf, { ASPECT_RATIO: "1:1 (Square)", MEGAPIXELS: 1 });
    assert.deepEqual(out["19"].tpl_filled, { aspect_ratio: "{{ASPECT_RATIO}}", megapixels: "{{MEGAPIXELS}}" });
    assert.equal(out["19"].inputs.megapixels, "1", "数值变量转字符串填入");
    assert.ok(!("tpl_filled" in out["3"]), "运行时变量没被填走，不记来源");
});

test("filledTokenNotes：导入画布时逐条说明变量被灌成什么值（尺寸 = 长边尺寸 × 比例 算出来的）", async () => {
    const { applyWorkflowParams, filledTokenNotes } = await import("../../web/workflow-graph.js");
    const wf = applyWorkflowParams({
        "19": { class_type: "ResolutionSelector", inputs: { resolution: "source", aspect_ratio: "{{ASPECT_RATIO}}", megapixels: "{{MEGAPIXELS}}" } },
    }, { ASPECT_RATIO: "1:1 (Square)", MEGAPIXELS: 1, WIDTH: 1024, HEIGHT: 1024 });
    const definitions = {
        ResolutionSelector: { input: { required: {
            aspect_ratio: [["1:1 (Square)", "16:9 (Widescreen)", "3:2", "2:3", "4:3", "9:16"], {}],
            megapixels: [1.0, { min: 0.1, max: 16, step: 0.01 }],
        } } },
    };
    const notes = filledTokenNotes(wf, { base_resolution: 1024, _ratio_text: "1:1", WIDTH: 1024, HEIGHT: 1024, MEGAPIXELS: 1, ASPECT_RATIO: "1:1 (Square)" }, definitions);
    assert.equal(notes.length, 2, "两个被灌成数值的变量各一条");
    const mp = notes.find((n) => n.includes("{{MEGAPIXELS}}"));
    assert.ok(mp.includes("ResolutionSelector #19 · megapixels = 1"), "目标写明灌进哪一格：" + mp);
    assert.ok(mp.includes("数值 0.1–16"), "megapixels 是数值 widget，带上下限：" + mp);
    assert.ok(mp.includes("长边尺寸 1024 × 比例 1:1 → 1024×1024 ÷ 1024² 算出 1 MP"), "主语是长边尺寸 × 比例：" + mp);
    assert.ok(mp.includes("生成时按本次宽高重算"), "写明生成时重算：" + mp);
    const ar = notes.find((n) => n.includes("{{ASPECT_RATIO}}"));
    assert.ok(ar.includes("下拉 6 项：1:1 (Square)"), "比例是 combo，列出可选项：" + ar);
    assert.ok(ar.includes("来源：技能设置「默认比例」1:1"), "比例的来源指到默认比例：" + ar);
});

// ============ LoRA 运行时动态注入（镜像后端 _apply_loras：流程图与真实执行一致）============

test("injectRuntimeLoras：无槽位 → UNETLoader 后串联插入并重接下游", async () => {
    const { injectRuntimeLoras } = await import("../../web/workflow-graph.js");
    const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" } },
        "2": { class_type: "KSampler", inputs: { model: ["1", 0], seed: 1 } },
    };
    const out = injectRuntimeLoras(wf, [{ name: "a.safetensors", strength: 0.8 }, "b.safetensors"]);
    assert.notEqual(out, wf, "返回新对象");
    assert.equal(Object.keys(out).length, 4);
    assert.deepEqual(out["3"], { class_type: "LoraLoaderModelOnly", runtime_injected: true, inputs: { model: ["1", 0], lora_name: "a.safetensors", strength_model: 0.8 } });
    assert.equal(out["4"].inputs.lora_name, "b.safetensors");
    assert.equal(out["4"].inputs.strength_model, 1.0, "字符串形式 LoRA 默认强度 1.0");
    assert.deepEqual(out["2"].inputs.model, ["4", 0], "下游节点重接到新链尾");
    assert.deepEqual(wf["2"].inputs.model, ["1", 0], "原模板不被修改");
});

test("injectRuntimeLoras：槽位不足 → 最后一个槽位后插入；未配置/槽位够用 → 原样返回", async () => {
    const { injectRuntimeLoras } = await import("../../web/workflow-graph.js");
    const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" } },
        "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "{{LORA_1_NAME}}", strength_model: 1.0 } },
        "3": { class_type: "KSampler", inputs: { model: ["2", 0], seed: 1 } },
    };
    assert.equal(injectRuntimeLoras(wf, []), wf, "未配置 LoRA → 原样返回");
    assert.equal(injectRuntimeLoras(wf, [{ name: "a.safetensors" }]), wf, "槽位够用 → 原样返回（槽位由 applyWorkflowParams 预填）");
    const out = injectRuntimeLoras(wf, [
        { name: "a.safetensors", strength: 1.0 }, { name: "b.safetensors", strength: 0.5 }, { name: "c.safetensors", strength: 0.3 },
    ]);
    assert.equal(Object.keys(out).length, 5);
    assert.deepEqual(out["4"].inputs.model, ["2", 0], "插入点接在最后一个槽位节点后");
    assert.equal(out["4"].inputs.lora_name, "b.safetensors");
    assert.deepEqual(out["5"].inputs.model, ["4", 0]);
    assert.equal(out["5"].inputs.lora_name, "c.safetensors");
    assert.deepEqual(out["3"].inputs.model, ["5", 0], "KSampler 重接到新链尾");
});

test("injectRuntimeLoras：无槽位且有手写 LoRA 链 → 锚点推到链尾；无 UNETLoader/无下游 → 跳过", async () => {
    const { injectRuntimeLoras } = await import("../../web/workflow-graph.js");
    const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" } },
        "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "hand.safetensors", strength_model: 1.0 } },
        "3": { class_type: "KSampler", inputs: { model: ["2", 0], seed: 1 } },
    };
    const out = injectRuntimeLoras(wf, [{ name: "a.safetensors" }]);
    assert.equal(out["4"].inputs.lora_name, "a.safetensors");
    assert.deepEqual(out["4"].inputs.model, ["2", 0], "插入在手写 LoRA 链之后");
    assert.deepEqual(out["3"].inputs.model, ["4", 0]);

    const noUnet = { "1": { class_type: "KSampler", inputs: { seed: 1 } } };
    assert.equal(injectRuntimeLoras(noUnet, [{ name: "a.safetensors" }]), noUnet, "无 UNETLoader → 跳过");
    const noConsumer = { "1": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" } } };
    assert.equal(injectRuntimeLoras(noConsumer, [{ name: "a.safetensors" }]), noConsumer, "无下游节点 → 跳过");
});

test("详情弹窗：超出模板槽位的 LoRA 动态注入流程图（与运行时一致）", async () => {
    const WF_INJECT = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" } },
        "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "{{LORA_1_NAME}}", strength_model: "{{LORA_1_STRENGTH}}" } },
        "3": { class_type: "KSampler", inputs: { model: ["2", 0], seed: 1 } },
    };
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "x", workflow: WF_INJECT }));
    mockObjectInfo({
        UNETLoader: { input: { required: { unet_name: ["UNET_NAME"] }, optional: {} } },
        LoraLoaderModelOnly: { input: { required: { model: ["MODEL"], lora_name: ["LORA_NAME"] }, optional: { strength_model: ["FLOAT"] } } },
        KSampler: { input: { required: { model: ["MODEL"], seed: ["INT"] }, optional: {} } },
    });
    mockRoute("/models/diffusion_models", () => jsonResponse(["m.safetensors"]));
    mockRoute("/models/loras", () => jsonResponse(["q.safetensors", "r.safetensors"]));

    await openGenPopup({
        id: "image_gen_text", source: "custom",
        config: { model: "m.safetensors", loras: [{ name: "q.safetensors", strength: 0.6 }, { name: "r.safetensors", strength: 0.4 }] },
    });
    const wfWrap = document.querySelector(".rs-skill-workflow");
    assert.ok(wfWrap && wfWrap.style.display !== "none", "应渲染工作流区");
    const nodes = wfWrap.querySelectorAll(".rs-wf-body .rs-wf-node");
    assert.equal(nodes.length, 4, "1 个超出槽位的 LoRA → 图里多一个 LoraLoaderModelOnly");
    const loraNodes = Array.from(nodes).filter(g => g.textContent.includes("LoraLoaderModelOnly"));
    assert.equal(loraNodes.length, 2);
    assert.ok(loraNodes.some(g => g.textContent.includes("#4")), "注入节点 id = max_id+1（与后端一致）");
    const summary = wfWrap.querySelector(".rs-wf-summary").textContent;
    assert.ok(!summary.includes("模型缺失"), "配置的 LoRA 都在列表中，不应报缺失：" + summary);
});

const WF_RENDER = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "{{LORA_1_NAME}}", strength_model: "{{LORA_1_STRENGTH}}" } },
    "3": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "{{PROMPT}}" } },
};

test("详情弹窗：生图工作流模板变量按 config 预替换，缺失模型按真实文件名判定", async () => {
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "x", workflow: WF_RENDER }));
    mockObjectInfo({
        UNETLoader: { input: { required: { unet_name: ["UNET_NAME"] }, optional: {} } },
        LoraLoaderModelOnly: { input: { required: { model: ["MODEL"], lora_name: ["LORA_NAME"] }, optional: { strength_model: ["FLOAT"] } } },
        CLIPTextEncode: { input: { required: { clip: ["CLIP"], text: ["STRING"] }, optional: {} } },
    });
    mockRoute("/models/diffusion_models", () => jsonResponse(["m.safetensors"]));
    mockRoute("/models/loras", () => jsonResponse(["q.safetensors"]));

    await openGenPopup({
        id: "image_gen_text", source: "custom",
        config: { model: "m.safetensors", loras: [{ name: "q.safetensors", strength: 0.6 }] },
    });
    const wfWrap = document.querySelector(".rs-skill-workflow");
    assert.ok(wfWrap && wfWrap.style.display !== "none", "应渲染工作流区");
    const summary = wfWrap.querySelector(".rs-wf-summary").textContent;
    assert.ok(!summary.includes("模型缺失"), "config 里的模型/LoRA 都在列表中，不应报缺失：" + summary);
    assert.equal(wfWrap.querySelectorAll(".rs-wf-node-tpl").length, 1, "仅 {{PROMPT}} 节点保留模板变量标记");
    assert.ok(summary.includes("模板变量运行时填入"), "摘要应说明剩余变量运行时填入：" + summary);
    // tooltip 显示渲染后的输入值：替换后的模型名 / 连线来源 / 运行时变量原样
    const nodeTitles = Array.from(wfWrap.querySelectorAll(".rs-wf-node title")).map(t => t.textContent);
    assert.ok(nodeTitles.some(t => t.includes("unet_name: m.safetensors")), "UNETLoader tooltip 应显示替换后模型名");
    assert.ok(nodeTitles.some(t => t.includes("model: ← #1") && t.includes("lora_name: q.safetensors")), "LoRA 节点 tooltip 应显示连线来源与 LoRA 名");
    assert.ok(nodeTitles.some(t => t.includes("text: {{PROMPT}}")), "运行时变量在 tooltip 中原样显示");
});

// 尺寸变量的值是按 base_resolution × 比例算出来后填进模板的，图上只剩一串数字 → 参数行与变量芯片必须把 {{MEGAPIXELS}} / {{ASPECT_RATIO}} 显出来
const WF_SIZE = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" } },
    "19": { class_type: "ResolutionSelector", inputs: { resolution: "source", aspect_ratio: "{{ASPECT_RATIO}}", megapixels: "{{MEGAPIXELS}}" } },
    "20": { class_type: "EmptySD3LatentImage", inputs: { width: ["19", 0], height: ["19", 1], batch_size: "{{COUNT}}" } },
    "3": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: "{{PROMPT}}" } },
};

test("详情弹窗：尺寸变量被算出的值填走后，参数行与变量芯片仍显示 {{MEGAPIXELS}} / {{ASPECT_RATIO}}", async () => {
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "x", workflow: WF_SIZE }));
    mockObjectInfo({});
    const copied = [];
    navigator.clipboard = { writeText: async (v) => { copied.push(v); } };

    await openGenPopup({
        id: "image_gen_text", source: "custom",
        config: { model: "m.safetensors", base_resolution: 1024, default_ratio: "1:1", count: 2 },
    });
    const wfWrap = document.querySelector(".rs-skill-workflow");
    const lines = Array.from(wfWrap.querySelectorAll(".rs-wf-node-input")).map((el) => el.textContent);
    assert.ok(lines.some((l) => l.startsWith("megapixels: {{MEGAPIXELS}} =")), "百万像素行应带来源变量：" + JSON.stringify(lines));
    assert.ok(lines.some((l) => l.startsWith("aspect_ratio: {{ASPECT_RATIO}} =")), "比例行应带来源变量（截断也留得住）：" + JSON.stringify(lines));

    const chips = Array.from(wfWrap.querySelectorAll(".rs-wf-token-item"));
    assert.deepEqual(chips.map((c) => c.querySelector(".rs-wf-missing-name").textContent).sort(),
        ["{{ASPECT_RATIO}}", "{{COUNT}}", "{{MEGAPIXELS}}", "{{MODEL}}"], "被设置填走的变量逐个成芯片");
    const mp = chips.find((c) => c.textContent.includes("{{MEGAPIXELS}}"));
    assert.ok(mp.title.includes("ResolutionSelector #19 · megapixels = 1"), "芯片 title 写明填在哪格、值多少：" + mp.title);
    assert.ok(mp.title.startsWith("目标："), "芯片 title 第一段是目标：" + mp.title);
    assert.ok(mp.title.includes("长边尺寸 1024 × 比例 1:1 → 1024×1024 ÷ 1024² 算出 1 MP"),
        "来源以长边尺寸 × 默认比例为主语，megapixels 写成算出来的数：" + mp.title);
    assert.ok(mp.title.includes("生成时按本次请求的宽高重算"), "尺寸变量芯片说明值是运行时重算的");
    mp.querySelector(".rs-wf-copy").click();
    await sleep(30);
    assert.deepEqual(copied, ["{{MEGAPIXELS}}"], "点复制写入 {{MEGAPIXELS}}");

    const summary = wfWrap.querySelector(".rs-wf-summary").textContent;
    assert.ok(summary.includes("个变量由技能设置填入"), "摘要给出设置填入计数：" + summary);
    const nodeTitles = Array.from(wfWrap.querySelectorAll(".rs-wf-node title")).map((ti) => ti.textContent);
    assert.ok(nodeTitles.some((ti) => ti.includes("megapixels: 1 ← {{MEGAPIXELS}}")), "tooltip 标出来源变量");
});

test("详情弹窗：工作流区默认折叠，点头部展开、再点折叠", async () => {
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "x", workflow: WF_RENDER }));
    mockObjectInfo({
        UNETLoader: { input: { required: { unet_name: ["UNET_NAME"] }, optional: {} } },
        LoraLoaderModelOnly: { input: { required: { model: ["MODEL"], lora_name: ["LORA_NAME"] }, optional: { strength_model: ["FLOAT"] } } },
        CLIPTextEncode: { input: { required: { clip: ["CLIP"], text: ["STRING"] }, optional: {} } },
    });
    mockRoute("/models/diffusion_models", () => jsonResponse(["m.safetensors"]));
    mockRoute("/models/loras", () => jsonResponse(["q.safetensors"]));

    await openGenPopup({ id: "image_gen_text", source: "custom", config: { model: "m.safetensors" } });
    const wfWrap = document.querySelector(".rs-skill-workflow");
    assert.ok(wfWrap && wfWrap.style.display !== "none", "应渲染工作流区");
    assert.equal(wfWrap.classList.contains("rs-wf-collapsed"), true, "默认折叠");
    assert.equal(wfWrap.querySelector(".rs-wf-caret").textContent, "▸");

    // 点头部 → 展开，再点一次 → 折叠
    click(wfWrap.querySelector(".rs-skill-workflow-head"));
    assert.equal(wfWrap.classList.contains("rs-wf-collapsed"), false, "点头部应展开工作流区");
    click(wfWrap.querySelector(".rs-skill-workflow-head"));
    assert.equal(wfWrap.classList.contains("rs-wf-collapsed"), true);
});

const WF_VIDEO = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" } },
    "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: "{{PROMPT}}" } },
    "3": { class_type: "KSampler", inputs: { model: ["1", 0], steps: "{{STEPS}}", width: "{{WIDTH}}", height: "{{HEIGHT}}" } },
};

test("详情弹窗：生视频工作流模板变量按 config + H3 缺省预替换", async () => {
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "v", workflow: WF_VIDEO }));
    mockObjectInfo({
        UNETLoader: { input: { required: { unet_name: ["UNET_NAME"] }, optional: {} } },
        CLIPTextEncode: { input: { required: { clip: ["CLIP"], text: ["STRING"] }, optional: {} } },
        KSampler: { input: { required: { model: ["MODEL"], steps: ["INT"], width: ["INT"], height: ["INT"] }, optional: {} } },
    });
    mockRoute("/models/diffusion_models", () => jsonResponse(["h3.safetensors"]));

    await openGenPopup({
        id: "h3_t2v", source: "custom", genImage: false, genVideo: true,
        config: { model: "h3.safetensors" },
    });
    const wfWrap = document.querySelector(".rs-skill-workflow");
    assert.ok(wfWrap && wfWrap.style.display !== "none", "生视频技能应渲染工作流区");
    const summary = wfWrap.querySelector(".rs-wf-summary").textContent;
    assert.ok(!summary.includes("模型缺失"), "{{MODEL}} 已替换为 config 值，不应报缺失：" + summary);
    assert.equal(wfWrap.querySelectorAll(".rs-wf-node-tpl").length, 1, "仅 {{PROMPT}} 节点保留模板变量标记");
    const unet = wfWrap.querySelector("g.rs-wf-node");
    assert.ok(unet.textContent.includes("unet_name: h3.safetensors"), "替换后的模型名直接显示在节点上");
});

test("工作流图：参数行直接画在节点上，列宽按内容自适应（短列收窄、长列封顶），超 6 行折叠「+N 项」、高度随行数增长", async () => {
    const { layoutWorkflow } = await import("../../web/workflow-graph.js");
    const inputs = { long: "x".repeat(80) };
    for (let i = 0; i < 8; i++) inputs[`k${i}`] = `v${i}`;
    const lay = layoutWorkflow({
        "1": { class_type: "Big", inputs },
        "2": { class_type: "Next", inputs: { a: ["1", 0], long: "y".repeat(80) } },
    });
    const byId = Object.fromEntries(lay.nodes.map(n => [n.id, n]));
    assert.equal(byId["1"].w, 205, "长内容列宽到上限 205（不再固定 196/150）");
    assert.equal(byId["2"].w, 205, "同列内容长则同宽");
    assert.ok(byId["2"].x > byId["1"].x + byId["1"].w, "后续列按第一列实际宽度偏移");
    assert.equal(byId["1"].lines.length, 7, "9 个输入 → 6 行 + 1 行「+N 项」");
    assert.ok(byId["1"].lines[6].includes("+3 项"), "折叠行应标注剩余数量：" + byId["1"].lines[6]);
    assert.ok(byId["1"].lines.every(l => l.length <= 33), "单行上限按列宽推导（205 → 33 字符）");
    assert.ok(byId["1"].lines.find(l => l.startsWith("long")).endsWith("…"), "超长值截断并以省略号结尾");
    assert.ok(byId["2"].lines.find(l => l.startsWith("long")).length <= 33, "其余列单行上限按列宽推导");
    assert.ok(byId["2"].lines.includes("a"), "连线输入只显示参数名（不再显示 ← #N）");
    assert.ok(!byId["2"].lines.some(l => l.includes("←")), "节点上不再出现 ← 编号");
    const aIdx = byId["2"].lines.indexOf("a");
    assert.equal(lay.edges[0].targetY, byId["2"].y + 47 + aIdx * 13 - 3.5, "连线终点对准对应参数行文字中心（INPUT_FIRST_Y=47、LINE_H=13、基线上方 3.5px）");
    assert.ok(byId["1"].h > 46, "高度随参数行数增长");
    // 内容短（类名 + 短参数）→ 列宽收窄到下限，省横向空间
    const narrow = layoutWorkflow({ "1": { class_type: "KSampler", inputs: { seed: 1 } } });
    assert.equal(narrow.nodes[0].w, 108, "短内容列收窄到下限 108");
    // 同层两节点：无输入 vs 多输入 → 高度不同、y 依次堆叠
    const lay2 = layoutWorkflow({
        "1": { class_type: "A", inputs: {} },
        "2": { class_type: "B", inputs: { a: 1, b: 2, c: 3 } },
    });
    const byId2 = Object.fromEntries(lay2.nodes.map(x => [x.id, x]));
    assert.equal(byId2["1"].h, 46);
    assert.ok(byId2["2"].h > 46);
    assert.ok(byId2["2"].y >= byId2["1"].y + byId2["1"].h, "同层节点按各自高度堆叠不重叠");
});

test("工作流图：同列同宽，模型加载类节点列放宽到 360 以显示模型名", async () => {
    const { layoutWorkflow } = await import("../../web/workflow-graph.js");
    const lay = layoutWorkflow({
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "Krea2-MuseByStable_v15Turbo_fp8-krea2_.safetensors" } },
        "2": { class_type: "KSampler", inputs: { seed: 1 } },
        "3": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: "a prompt" } },
    });
    const byId = Object.fromEntries(lay.nodes.map(n => [n.id, n]));
    assert.ok(byId["1"].w > 205, `模型加载节点列应超过普通上限 205（实际 ${byId["1"].w}）`);
    assert.ok(byId["1"].w <= 360, `放宽后仍封顶 360（实际 ${byId["1"].w}）`);
    assert.equal(byId["2"].w, byId["1"].w, "同列拉齐到最宽节点");
    assert.ok(byId["3"].w < byId["1"].w, "无加载节点的下游列不受影响");
    const line = byId["1"].lines.find(l => l.startsWith("ckpt_name:"));
    assert.ok(!line.endsWith("…"), `模型名应完整显示不被截断：${line}`);
});

test("画布重排：返回同列统一宽度，模型加载节点按模型名加长", async () => {
    const { canvasLayout } = await import("../../web/workflow-graph.js");
    const wf = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "Krea2-MuseByStable_v15Turbo_fp8-krea2_.safetensors" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: "clip.safetensors" } },
        "3": { class_type: "KSampler", inputs: { model: ["1", 0], clip: ["2", 0] } },
    };
    const byId = Object.fromEntries(canvasLayout(wf, () => [240, 120]).map(c => [c.id, c]));
    assert.ok(byId["1"].w > 240, `模型名长的加载节点应加长（实际 ${byId["1"].w}）`);
    assert.ok(byId["1"].w <= 420, `加长封顶 420（实际 ${byId["1"].w}）`);
    assert.equal(byId["2"].w, byId["1"].w, "同列拉齐到最宽节点");
    assert.equal(byId["3"].w, 240, "无加载节点的列保持原宽");
    assert.ok(byId["3"].x > byId["1"].x + byId["1"].w, "后续列按拉齐后的列宽偏移");
});

test("工作流图排版：同层按上游重心排序减少交叉，短列相对最高列垂直居中", async () => {
    const { layoutWorkflow } = await import("../../web/workflow-graph.js");
    // 上游 1→4、2→3：按 id 序 [3,4] 会让两条连线交叉，重心排序应排成 [4,3]
    const lay = layoutWorkflow({
        "1": { class_type: "A", inputs: {} },
        "2": { class_type: "B", inputs: {} },
        "3": { class_type: "C", inputs: { m: ["2", 0] } },
        "4": { class_type: "D", inputs: { m: ["1", 0] } },
    });
    const col = lay.nodes.filter(n => n.layer === 1).sort((a, b) => a.y - b.y).map(n => n.id);
    assert.deepEqual(col, ["4", "3"], "同层按上游重心排序（上游 1 在前 → 4 在前）");
    // 单节点列相对两节点列居中：y 大于 PAD（不再顶对齐）
    const lay2 = layoutWorkflow({
        "1": { class_type: "A", inputs: {} },
        "2": { class_type: "B", inputs: {} },
        "3": { class_type: "C", inputs: { a: ["1", 0], b: ["2", 0] } },
    });
    const byId = Object.fromEntries(lay2.nodes.map(n => [n.id, n]));
    assert.ok(byId["3"].y > 12, "短列垂直居中，连线更平");
    assert.ok(byId["3"].y + byId["3"].h <= lay2.height - 12 + 1, "居中后仍落在图高范围内");
});

test("工作流图：autogrow 同类输入合并为一行摘要（ref_images.ref_image ×9）", async () => {
    const { layoutWorkflow } = await import("../../web/workflow-graph.js");
    // 模拟 MiniMaxH3ReferenceToVideo + 9 LoadImage + 3 LoadVideo/GetVideoComponents + 3 LoadAudio
    const wf = {
        "5": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { clip: ["2", 0], vae: ["3", 0], prompt: "{{PROMPT}}" } },
        "2": { class_type: "CLIPLoader", inputs: {} },
        "3": { class_type: "VAELoader", inputs: {} },
    };
    for (let i = 0; i < 9; i++) {
        wf[String(20 + i)] = { class_type: "LoadImage", inputs: { image: `{{REF_IMAGE_${i + 1}}}` } };
        wf["5"].inputs[`ref_images.ref_image_${i}`] = [String(20 + i), 0];
    }
    for (let i = 0; i < 3; i++) {
        const vid = String(30 + i), comp = String(40 + i);
        wf[vid] = { class_type: "LoadVideo", inputs: { file: `{{REF_VIDEO_${i + 1}}}` } };
        wf[comp] = { class_type: "GetVideoComponents", inputs: { video: [vid, 0] } };
        wf["5"].inputs[`ref_videos.ref_video_${i}`] = [comp, 0];
    }
    for (let i = 0; i < 3; i++) {
        const aid = String(50 + i);
        wf[aid] = { class_type: "LoadAudio", inputs: { audio: `{{REF_AUDIO_${i + 1}}}` } };
        wf["5"].inputs[`ref_audios.ref_audio_${i}`] = [aid, 0];
    }
    const lay = layoutWorkflow(wf);
    // 合并后节点数：H3(1) + CLIP(1) + VAE(1) + LoadImage×9(1合成) + LoadVideo+GetVideoComponents×3(1合成) + LoadAudio×3(1合成) = 6
    assert.equal(lay.nodes.length, 6, `合并后应有 6 个节点（实际 ${lay.nodes.length}）`);
    // 合成节点显示 "ClassName ×N"
    const byType = Object.fromEntries(lay.nodes.map(n => [n.classType, n]));
    assert.ok(byType["LoadImage ×9"], "9 个 LoadImage 应合并为 'LoadImage ×9'");
    assert.ok(byType["LoadVideo ×3"], "3 个 LoadVideo(+GetVideoComponents) 应合并为 'LoadVideo ×3'");
    assert.ok(byType["LoadAudio ×3"], "3 个 LoadAudio 应合并为 'LoadAudio ×3'");
    // H3 节点的参数行：autogrow 输入合并显示
    const h3 = lay.nodes.find(n => n.id === "5");
    assert.ok(h3.lines.includes("ref_images.ref_image ×9"), "H3 节点应显示 ref_images 组合并");
    assert.ok(h3.lines.includes("ref_videos.ref_video ×3"), "H3 节点应显示 ref_videos 组合并");
    assert.ok(h3.lines.includes("ref_audios.ref_audio ×3"), "H3 节点应显示 ref_audios 组合并");
    // 合成节点没有真实节点 id，图上不显示 "#__grp_…" 行，因此更矮
    assert.equal(byType["LoadImage ×9"].h, 33, "合成节点无 #id 行，高度比真实节点矮 13");
});

test("工作流图：合成节点图上与 tooltip 不显示内部 #__grp_… id", async () => {
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({
        skill_id: "x",
        workflow: {
            "1": { class_type: "KSampler", inputs: { "images.image_0": ["2", 0], "images.image_1": ["3", 0] } },
            "2": { class_type: "LoadImage", inputs: { image: "a.png" } },
            "3": { class_type: "LoadImage", inputs: { image: "b.png" } },
        },
    }));
    mockObjectInfo({});
    await openGenPopup({ id: "image_gen_text", source: "custom" });
    const svg = document.querySelector(".rs-wf-body svg.rs-wf-svg");
    assert.ok(svg.textContent.includes("LoadImage ×2"), "两个 LoadImage 应合并为合成节点");
    assert.ok(!svg.textContent.includes("__grp"), "图上与 tooltip 不应出现内部合成 id");
    const synthTitle = [...svg.querySelectorAll("g.rs-wf-node title")].map(t => t.textContent).find(t => t.startsWith("LoadImage ×2"));
    assert.ok(synthTitle, "合成节点应有 tooltip");
    assert.ok(!synthTitle.includes("__grp"), "tooltip 首行不带内部 id：" + synthTitle);
    assert.ok(![...svg.querySelectorAll(".rs-wf-node-id")].some(t => t.textContent.includes("__grp")), "图上不显示合成节点内部 id");
});

test("工作流图：滚动区内拖拽平移 scrollLeft/Top（同画布体验），松开后停止", async () => {
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "x", workflow: WF_RENDER }));
    mockObjectInfo({});
    await openGenPopup({ id: "image_gen_text", source: "custom" });
    const body = document.querySelector(".rs-wf-body");
    const svg = body.querySelector("svg.rs-wf-svg");
    assert.ok(svg, "应渲染 SVG 流程图");
    body.scrollLeft = 10;
    body.scrollTop = 5;
    svg.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 0, clientY: 0 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: -30, clientY: 12 }));
    assert.equal(body.scrollLeft, 40, "左拖 → scrollLeft 增大");
    assert.equal(body.scrollTop, -7, "下拖 → scrollTop 减小（jsdom 不裁剪，浏览器内自动夹取）");
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: -60, clientY: 24 }));
    assert.equal(body.scrollLeft, 40, "松开后不再跟随拖动");
});

test("详情弹窗：工作流区先骨架占位（默认折叠），加载完成后原地渲染不跳布局", async () => {
    const { createSkillDetailPopup } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "Gen Skill", content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: true, gen_video: false, requires_ref: false, multi_turn: false, tags: [], category: "", config_overridden: false,
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => jsonResponse(call.method === "GET" ? {} : { success: true }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: [] }));

    // skill_workflow 延迟响应 → 可断言加载中的占位中间态
    let resolveWf;
    mockRoute("/neo_image_gen/skill_workflow", () => new Promise((res) => {
        resolveWf = () => res(jsonResponse({ skill_id: "x", workflow: WF_RENDER }));
    }));

    const popup = createSkillDetailPopup();
    const opened = popup.openExisting("image_gen_text", "custom");
    await sleep(80);

    // 占位态：工作流区已显示 + 骨架
    const wrap = document.querySelector(".rs-skill-workflow");
    assert.ok(wrap && wrap.style.display !== "none", "加载中工作流区应先显示占位");
    assert.ok(document.querySelector(".rs-wf-skeleton"), "应显示骨架占位（加载提示）");

    resolveWf();
    await opened;
    assert.equal(document.querySelector(".rs-wf-skeleton"), null, "加载完成后骨架应被替换");
    assert.ok(document.querySelector(".rs-wf-node"), "流程图应原地渲染出来");
});

test("工作流图分步渲染：校验请求未回先出图（蓝框），/object_info 返回后原地补红框", async () => {
    const { createSkillDetailPopup } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "Gen Skill", content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: true, gen_video: false, requires_ref: false, multi_turn: false, tags: [], category: "", config_overridden: false,
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => jsonResponse(call.method === "GET" ? {} : { success: true }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [], loras: [] }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "x", workflow: WF_SAMPLE }));

    // 节点定义延迟响应 → 可断言「图已画出但校验未完成」的中间态；返回未注册 → 全部节点判为未安装
    const pendingInfo = [];
    mockRoute("/object_info/*", () => new Promise((res) => { pendingInfo.push(() => res(jsonResponse({}))); }));
    const resolveInfo = () => pendingInfo.forEach((resolve) => resolve());

    const popup = createSkillDetailPopup();
    const opened = popup.openExisting("image_gen_text", "custom");
    await sleep(80);

    assert.equal(document.querySelector(".rs-wf-skeleton"), null, "骨架应已被流程图替换（不等校验请求）");
    assert.ok(document.querySelector(".rs-wf-node"), "校验请求未回也应先画出流程图");
    assert.ok(document.querySelector(".rs-wf-node-tpl"), "模板变量蓝框来自同步预检，应立即出现");
    assert.equal(document.querySelector(".rs-wf-node-bad"), null, "/object_info 未返回前不应有红框");

    resolveInfo();
    await opened;
    assert.ok(document.querySelector(".rs-wf-node-bad"), "校验完成后应原地补上缺失节点红框");
    const wfSummarySlot = document.querySelector(".rs-skill-workflow > .rs-wf-summary");
    assert.equal(wfSummarySlot.querySelectorAll(":scope > .rs-wf-summary").length, 1, "分步重渲染不应重复追加摘要行");
});

test("详情弹窗关闭保护：正文有未保存修改时 ✕ 先出确认条（继续编辑 / 放弃 / 保存并关闭）", async () => {
    const { createSkillDetailPopup } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "My Skill", content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: false, gen_video: false, requires_ref: false, multi_turn: false, tags: [], category: "", config_overridden: false,
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
    let savedSkill = null;
    mockRoute("/rs_prompts/save_skill", (b) => { savedSkill = b; return jsonResponse({ success: true }); });

    const popup = createSkillDetailPopup();
    const overlay = document.querySelector(".rs-skill-modal-overlay");
    const closeX = () => click(document.querySelector(".rs-skill-detail .rs-skill-modal-close"));
    const bar = () => document.querySelector(".rs-skill-detail .rs-gen-dirty-confirm");
    const barBtn = (label) => click(Array.from(bar().querySelectorAll("button")).find((b) => b.textContent === label));

    // 无修改 → ✕ 直接关闭
    await popup.openExisting("my-skill", "custom");
    closeX();
    assert.equal(overlay.style.display, "none", "无修改应直接关闭");

    // 正文改动 → ✕ 暂停关闭并出确认条
    await popup.openExisting("my-skill", "custom");
    document.querySelector(".rs-skill-detail textarea").value = "body edited";
    closeX();
    assert.equal(overlay.style.display, "flex", "有未保存修改不应关闭");
    assert.ok(!bar().hidden, "应显示未保存修改确认条");

    // 继续编辑 → 隐藏确认条，弹窗保持打开；再点 ✕ 重新出现
    barBtn("继续编辑");
    assert.ok(bar().hidden, "继续编辑应隐藏确认条");
    closeX();
    assert.ok(!bar().hidden, "再点 ✕ 应重新显示确认条");

    // 放弃修改 → 直接关闭，不发保存请求
    barBtn("放弃修改");
    assert.equal(overlay.style.display, "none", "放弃修改应关闭");
    assert.equal(savedSkill, null, "放弃修改不应发保存请求");

    // 保存并关闭 → 发出 save_skill 且携带新正文，成功后关闭
    await popup.openExisting("my-skill", "custom");
    document.querySelector(".rs-skill-detail textarea").value = "body v2";
    closeX();
    barBtn("保存并关闭");
    await sleep(80);
    assert.ok(savedSkill, "应发出 /rs_prompts/save_skill");
    assert.equal(savedSkill.content, "body v2");
    assert.equal(overlay.style.display, "none", "保存成功后应关闭");
});

test("详情弹窗关闭保护：预设技能设置区未保存时，保存并关闭写本地覆盖后关闭", async () => {
    const r = await openGenPopup({ id: "image_gen_text", source: "presets", config: {} });
    // 改生图张数 → 设置区脏（正文只读不参与）
    document.querySelector(".rs-gen-advanced input[type=number]").value = "3";
    click(document.querySelector(".rs-skill-detail .rs-skill-modal-close"));
    await sleep(20);

    const overlay = document.querySelector(".rs-skill-modal-overlay");
    assert.equal(overlay.style.display, "flex", "设置区有未保存修改不应关闭");
    const bar = document.querySelector(".rs-skill-detail .rs-gen-dirty-confirm");
    assert.ok(!bar.hidden, "应显示未保存修改确认条");

    click(Array.from(bar.querySelectorAll("button")).find((b) => b.textContent === "保存并关闭"));
    await sleep(80);
    assert.ok(r.saved, "应 POST /neo_image_gen/skill_config（本地覆盖）");
    assert.equal(r.saved.config.count, 3);
    assert.equal(overlay.style.display, "none", "保存成功后应关闭");
});

