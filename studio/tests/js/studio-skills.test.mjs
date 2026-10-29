// Neo Studio 技能页：默认停在引导页（导入工作流 / 新建模板技能 / 技能列表），
// 点了入口才装配统一技能管理；导入走「导出预览 → 命名 → 落盘」同一条链路。
// studio-app.js 顶层会取 #ns-view 并连 WebSocket，导入前必须先备好 DOM 与 WS 桩。
import test from "node:test";
import assert from "node:assert/strict";
import { mockRoute, jsonResponse, sleep, click, inputText, fetchLog } from "./setup.mjs";

const wsInstances = [];
globalThis.WebSocket = class {
    constructor(url) { wsInstances.push(this); this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

document.body.innerHTML = `<div id="ns-view"></div>`;
mockRoute("/neo_studio/version", jsonResponse({
    success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
}));

const skills = [
    { id: "preset_img", name: "Preset Image", cn_name: "预设生图", source: "presets", category: "image_gen" },
];
mockRoute("/rs_prompts/skills", () => jsonResponse(skills));
mockRoute("/rs_prompts/load_skill", (b) => {
    const meta = skills.find((s) => s.id === b.id) || {};
    return jsonResponse({
        id: b.id, name: meta.name || "Preset Image", content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: false, gen_video: false, multi_turn: false, tags: [], category: meta.category || "image_gen",
    });
});
mockRoute("/neo_image_gen/plan_workflow_skill", jsonResponse({
    success: true, gen_video: false, warnings: [], candidates: [],
}));
mockRoute("/neo_image_gen/save_workflow_skill", () => {
    // 落盘后列表要能取到这份新技能：保存路由在回应前把它加进列表
    if (!skills.some((s) => s.id === "imported-flow"))
        skills.push({ id: "imported-flow", name: "导入工作流", cn_name: "导入工作流", source: "custom", category: "image_gen" });
    return jsonResponse({ success: true, id: "imported-flow", warnings: [], gen_video: false });
});

async function until(fn, what) {
    for (let i = 0; i < 50; i++) {
        if (fn()) return;
        await sleep(20);
    }
    assert.fail(`等待超时：${what}`);
}

function guideBtn(label) {
    return [...document.querySelectorAll(".ns-skills-guide-actions .ns-btn")]
        .find((b) => b.textContent.includes(label));
}

test("技能页默认停在引导页：不装配技能管理，也不拉技能详情", async () => {
    await import("../../web/studio/studio-app.js");
    location.hash = "#/skills";
    await until(() => document.querySelector(".ns-skills-guide"), "技能引导页");
    assert.ok(document.querySelector(".ns-skills-guide-actions"), "引导页带三个入口");
    assert.equal(document.querySelector(".rs-skill-manager"), null, "引导页态不装配管理组件");
    assert.ok(!fetchLog.some((c) => c.path === "/rs_prompts/load_skill"), "落地引导页不拉技能详情");
});

test("技能列表入口：装配管理组件并选中第一项，← 引导页卸载回引导页", async () => {
    const before = fetchLog.filter((c) => c.path === "/rs_prompts/skills").length;
    click(guideBtn("技能列表"));
    await until(() => document.querySelector(".rs-skill-manager .rs-skill-picker-item"), "技能列表");
    assert.ok(document.querySelector(".ns-skills-page").classList.contains("ns-skills-editing"), "切到列表态");
    assert.ok(fetchLog.filter((c) => c.path === "/rs_prompts/skills").length > before, "点入口才拉技能列表");
    const selected = document.querySelector(".rs-skill-manager .rs-skill-picker-item.is-selected");
    assert.ok(selected && selected.textContent.includes("预设生图"), "默认选中展开分类的第一项");

    click(document.querySelector(".ns-skills-back"));
    await until(() => !document.querySelector(".rs-skill-manager"), "返回引导页");
    assert.ok(!document.querySelector(".ns-skills-page").classList.contains("ns-skills-editing"), "回到引导页态");
});

test("新建模板技能：直接开新建表单（名称、正文都是空态）", async () => {
    click(guideBtn("新建模板技能"));
    await until(() => document.querySelector(".rs-skill-manager .rs-skill-modal-title"), "技能详情表单");
    assert.equal(document.querySelector(".rs-skill-modal-title").textContent, "新建技能");
    assert.equal(document.querySelector(".rs-skill-name-input").value, "");
    assert.ok(document.querySelector(".ns-skills-page").classList.contains("ns-skills-editing"));

    click(document.querySelector(".ns-skills-back"));
    await until(() => !document.querySelector(".rs-skill-manager"), "返回引导页");
});

test("导入工作流：API 工作流先预览再命名，落盘后进列表并选中新技能", async () => {
    const workflow = {
        "1": { class_type: "CLIPTextEncode", inputs: { text: "a cat" } },
        "2": { class_type: "SaveImage", inputs: { filename_prefix: "neo" } },
    };
    click(guideBtn("导入工作流"));
    const input = document.querySelector(".ns-skills-file");
    assert.ok(input, "引导页带隐藏的文件选择框");
    Object.defineProperty(input, "files", {
        value: [{ name: "my-flow.json", text: async () => JSON.stringify(workflow) }],
        configurable: true,
    });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));

    await until(() => document.querySelector(".rs-skill-title-dialog"), "命名对话框");
    assert.equal(document.querySelector(".rs-skill-title-dialog .rs-skill-modal-title").textContent,
        "导入工作流创建技能");
    inputText(document.querySelector(".rs-skill-title-dialog .rs-tpl-name"), "导入工作流");
    const createBtn = [...document.querySelectorAll(".rs-skill-title-dialog .rs-modal-btns .rs-btn")]
        .find((b) => b.textContent === "创建");
    click(createBtn);

    // 落盘后列表要能取到这份新技能（保存路由已经把它加进列表）
    await until(() => fetchLog.some((c) => c.path === "/neo_image_gen/save_workflow_skill"), "保存请求");
    const saved = fetchLog.find((c) => c.path === "/neo_image_gen/save_workflow_skill");
    assert.deepEqual(saved.body.workflow, workflow, "保存的是导入的 API 工作流");

    await until(() => document.querySelector(".rs-skill-manager .rs-skill-picker-item.is-selected"), "导入后进列表");
    assert.ok(document.querySelector(".rs-skill-manager .rs-skill-picker-item.is-selected").textContent.includes("导入工作流"),
        "列表停在刚导入的技能上");
});

test("导入工作流：界面工作流被挡下并提示另存 API 格式", async () => {
    click(document.querySelector(".ns-skills-back"));
    await until(() => !document.querySelector(".rs-skill-manager"), "返回引导页");

    const before = fetchLog.filter((c) => c.path === "/neo_image_gen/plan_workflow_skill").length;
    click(guideBtn("导入工作流"));
    const input = document.querySelector(".ns-skills-file");
    Object.defineProperty(input, "files", {
        value: [{ name: "ui-flow.json", text: async () => JSON.stringify({ nodes: [], links: [] }) }],
        configurable: true,
    });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));

    await until(() => (document.querySelector("#ns-toast")?.textContent || "").includes("界面工作流"), "界面工作流提示");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_image_gen/plan_workflow_skill").length, before,
        "界面工作流不发预览请求，也不落进技能目录");
    assert.equal(document.querySelector(".rs-skill-title-dialog"), null, "被挡下时不弹命名对话框");
});
