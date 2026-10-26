// L2：关键交互流基线（随机取词、Enter 生成、skill 路由、缺图提示、运行时随机菜单）。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import {
    assertGolden,
    click,
    inputText,
    keydown,
    sleep,
    resetEnv,
    mockRoute,
    clearRoutes,
    jsonResponse,
    sseResponse,
    fetchLog,
    missingRoutes,
    dialogs,
} from "./setup.mjs";
import { SKILLS, createAgentNode, uiRoot, widgetValue } from "./helpers/node-ui.mjs";
import { dispatchApiEvent } from "./mocks/comfy-api.mjs";

const CHUNKS = ['data: {"text":"a cat "}', 'data: {"text":"in the rain"}', "data: [DONE]"];

beforeEach(() => {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_prompts/skills", () => jsonResponse(SKILLS));
    localStorage.removeItem("neo.prompt_agent.quick_history");
});

function flowTrace() {
    const calls = fetchLog.map((c) => `${c.method} ${c.path}${c.body ? " " + JSON.stringify(c.body) : ""}`);
    return [
        ...calls,
        ...dialogs.alerts.map((m) => `alert: ${m}`),
        ...(missingRoutes.length ? missingRoutes.map((m) => `MISSING ROUTE: ${m}`) : []),
    ].join("\n");
}

async function makeNode(id) {
    await import("../../web/prompts.js");
    const node = await createAgentNode(id);
    await sleep(250);
    return node;
}

function parts(node) {
    const root = uiRoot(node);
    return {
        root,
        quickInput: root.querySelector("textarea.rs-quick-input"),
        promptArea: root.querySelector("textarea.comfy-multiline-input"),
        generateBtn: root.querySelector(".rs-generate-btn"),
        randomBtn: root.querySelector(".rs-random-wrap .rs-random-btn"),
        selector: root.querySelector("select.rs-tpl-selector"),
    };
}

function state(node, el) {
    return JSON.stringify(
        {
            promptArea: el.promptArea.value,
            quickInput: el.quickInput.value,
            widgets: {
                prompt: widgetValue(node, "prompt"),
                quick_input: widgetValue(node, "quick_input"),
                quick_input_used: widgetValue(node, "quick_input_used"),
            },
            properties: node.properties,
        },
        null,
        2,
    );
}

test("随机按钮：取 preset 列表并写入提示词", async () => {
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse([{ name: "cats" }]));
    mockRoute("/rs_prompts/load_prompt", (body) => jsonResponse({ text: `preset-text:${body.name}` }));

    const node = await makeNode(11);
    const el = parts(node);
    click(el.randomBtn);
    await sleep(60);

    assertGolden("flow.random", flowTrace());
    assert.equal(el.promptArea.value, "preset-text:cats");
    assert.equal(widgetValue(node, "prompt"), "preset-text:cats");
});

test("快捷输入 Enter：无 skill 时走流式生成并回填", async () => {
    mockRoute("/rs_prompts/classify_skill", () => jsonResponse({ skill: null }));   // LAYA 无匹配：保持默认（不选 skill）
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse(CHUNKS));

    const node = await makeNode(12);
    const el = parts(node);
    inputText(el.quickInput, "a cat");
    keydown(el.quickInput, "Enter");
    await sleep(60);

    assertGolden("flow.generate-stream", flowTrace());
    // onDone 取消待执行的合并帧前先把 accumulated 写回 textarea，saveTextToStorage 才能读到最新文本。
    // golden 记录当前行为；若行为有意变化，需 npm run update-goldens。
    assertGolden("flow.generate-stream.state", state(node, el));
});

test("快捷输入历史：↑ 召回预置条目，Enter 生成后所发输入记入历史（localStorage 持久化）", async () => {
    mockRoute("/rs_prompts/classify_skill", () => jsonResponse({ skill: null }));
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse(CHUNKS));

    // 预置一条历史，验证节点快捷输入已接上共享历史模块
    localStorage.setItem("neo.prompt_agent.quick_history", JSON.stringify(["seeded prompt"]));

    const node = await makeNode(31);
    const el = parts(node);
    keydown(el.quickInput, "ArrowUp");
    assert.equal(el.quickInput.value, "seeded prompt", "↑ 应召回预置历史条目");

    inputText(el.quickInput, "a cat in the rain");
    keydown(el.quickInput, "Enter");
    await sleep(60);

    const hist = JSON.parse(localStorage.getItem("neo.prompt_agent.quick_history"));
    assert.equal(hist[0], "a cat in the rain", "真正发出的快捷输入应记入历史首位");
    assert.equal(hist[1], "seeded prompt");
});

test("H3 审计事件：status 累计显示阶段、replace 整段替换正文、结束后保留结果", async () => {
    const H3_CHUNKS = [
        'data: {"text":"draft ","kind":"content"}',
        'data: {"text":"prompt","kind":"content"}',
        'data: {"text":"格式自检中…","kind":"status"}',
        'data: {"text":"自检发现 1 处格式问题：缺少镜头编号","kind":"status"}',
        'data: {"text":"✏自动修复中…","kind":"status"}',
        'data: {"text":"✏已自动修复格式（1 处问题）","kind":"status"}',
        'data: {"text":"repaired final prompt","kind":"replace"}',
        "data: [DONE]",
    ];
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse(H3_CHUNKS));

    const node = await makeNode(21);
    const el = parts(node);
    inputText(el.quickInput, "h3 video");
    keydown(el.quickInput, "Enter");
    await sleep(60);

    // replace 事件整段替换已透传的草稿，最终落盘的是修复后文本
    assert.equal(el.promptArea.value, "repaired final prompt");
    assert.equal(widgetValue(node, "prompt"), "repaired final prompt");
    // 流结束后保留 H3 流程面板：自检违规项与修复结果可回看（节点 UI 挂在 domWidget 上，非 document.body）
    const statusPanel = el.root.querySelector(".rs-thinking");
    assert.ok(statusPanel, "流结束后应保留 H3 流程面板");
    assert.match(statusPanel.textContent, /自检发现 1 处格式问题：缺少镜头编号/);
    assert.match(statusPanel.textContent, /已自动修复格式（1 处问题）/);
});

test("选中 skill：请求体带 skillId 与拼接后的 text", async () => {
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse(CHUNKS));

    const node = await makeNode(13);
    const el = parts(node);
    el.selector.value = "anime_style";
    inputText(el.quickInput, "more detail");
    click(el.generateBtn);
    await sleep(60);

    assertGolden("flow.skill-generate", flowTrace());
});

test("@ 图片选择器：无可用图片时给占位提示，不叠加弹层且可关闭后重开", async () => {
    const node = await makeNode(20);
    const el = parts(node);

    inputText(el.quickInput, "@");
    await sleep(60);
    const picker = document.querySelector(".rs-at-picker");
    assert.ok(picker);
    assert.ok(picker.textContent.includes("没有可用的 Load Image"));

    // 已有弹层时再输入 @ 不再叠加第二个
    inputText(el.quickInput, "@@");
    await sleep(60);
    assert.equal(document.querySelectorAll(".rs-at-picker").length, 1);

    keydown(picker, "Escape");
    await sleep(50);
    assert.equal(document.querySelectorAll(".rs-at-picker").length, 0);

    // 关闭后同一节点仍可再次打开
    inputText(el.quickInput, "x@");
    await sleep(60);
    assert.equal(document.querySelectorAll(".rs-at-picker").length, 1);
});

test("输入 / 唤起 skill 快捷菜单：实时过滤 + Enter 提交写入下拉", async () => {
    const node = await makeNode(21);
    const el = parts(node);

    // 打 / 打开弹层（4 个 skill；task 分类已隐藏）
    inputText(el.quickInput, "/");
    await sleep(60);
    let picker = document.querySelector(".rs-slash-picker");
    assert.ok(picker, "应出现 slash 菜单");
    assert.strictEqual(picker.querySelectorAll(".rs-slash-picker-row").length, 4, "可见 skill 4 行（task 隐藏）");

    // 继续输入过滤：/ani → anime_style（id 命中）
    inputText(el.quickInput, "/ani");
    await sleep(60);
    picker = document.querySelector(".rs-slash-picker");
    assert.strictEqual(picker.querySelectorAll(".rs-slash-picker-row").length, 1, "过滤后剩 1 行");
    // 副标题显示类别名称（image_enhance → 图像提示词增强），不再是 id
    assert.strictEqual(picker.querySelector(".rs-slash-picker-meta").textContent, "图像提示词增强", "meta 显示类别名称");

    // Enter 提交：写入下拉、清除 /query、关闭弹层
    keydown(picker, "Enter");
    await sleep(50);
    assert.strictEqual(document.querySelector(".rs-slash-picker"), null, "提交后弹层应移除");
    assert.strictEqual(el.selector.value, "anime_style", "skill 下拉应为 anime_style");
    assert.strictEqual(el.quickInput.value, "", "/query 应被清除");
});

test("输入 / 后 Esc 关闭菜单且不改变 skill 选择", async () => {
    const node = await makeNode(22);
    const el = parts(node);

    inputText(el.quickInput, "/");
    await sleep(60);
    const picker = document.querySelector(".rs-slash-picker");
    assert.ok(picker, "应出现 slash 菜单");
    keydown(picker, "Escape");
    await sleep(50);
    assert.strictEqual(document.querySelector(".rs-slash-picker"), null, "Esc 后弹层应移除");
    assert.strictEqual(el.quickInput.value, "/", "输入内容不应被改动");
});

test("输入 / 后按中文拼音（tags）匹配 skill", async () => {
    const node = await makeNode(23);
    const el = parts(node);

    inputText(el.quickInput, "/");
    await sleep(60);
    // 首字母缩写 dmfg 命中「动漫风格」的拼音标签
    inputText(el.quickInput, "/dm");
    await sleep(60);
    const picker = document.querySelector(".rs-slash-picker");
    assert.ok(picker, "应出现 slash 菜单");
    assert.strictEqual(picker.querySelectorAll(".rs-slash-picker-row").length, 1, "拼音 dm 命中 1 行");
    assert.ok(picker.textContent.includes("动漫风格"), "命中的应是动漫风格");
});

test("运行时随机菜单：+/- 调整条数并写回隐藏控件", async () => {
    const node = await makeNode(15);
    const rt = parts(node).randomBtn._rsRuntime;
    click(rt.plusBtn);
    click(rt.plusBtn);
    click(rt.minusBtn);

    assertGolden(
        "flow.runtime-random",
        JSON.stringify(
            {
                checked: rt.checkbox.checked,
                count: rt.valueSpan.textContent,
                widgets: {
                    random_enabled: widgetValue(node, "random_enabled"),
                    random_count: widgetValue(node, "random_count"),
                },
                properties: node.properties.rs_runtime_random,
            },
            null,
            2,
        ),
    );
});

test("流式更新事件：写回提示词并同帧切到 Markdown 预览，复选框可回写", async () => {
    const node = await makeNode(16);
    const el = parts(node);

    dispatchApiEvent("rs.prompt.auto_generate_update", {
        instance_uid: node.properties?.rs_instance_uid,
        prompt: "## 大纲\n- [ ] 开场",
    });

    assert.equal(el.promptArea.value, "## 大纲\n- [ ] 开场");
    assert.equal(widgetValue(node, "prompt"), "## 大纲\n- [ ] 开场");

    const preview = uiRoot(node).querySelector(".rs-md-preview.rs-prompt-md-preview");
    assert.equal(preview.style.display, "block");
    assert.ok(
        uiRoot(node).querySelector(".rs-md-preview-btn").classList.contains("rs-md-preview-active"),
    );
    assert.equal(preview.querySelectorAll('input[type="checkbox"]').length, 1);

    // 预览里的任务复选框放开给点击：勾选状态写回 textarea 源码并经 input 事件同步 widget
    // DOM 规范对复选框是 pre-click activation，派发时 checked 已是新值，直接 click 即模拟真实勾选
    const box = preview.querySelectorAll('input[type="checkbox"]')[0];
    assert.equal(box.disabled, false);
    click(box);
    assert.equal(box.checked, true);
    assert.match(el.promptArea.value, /- \[[xX]\] 开场/);
    assert.equal(widgetValue(node, "prompt"), el.promptArea.value);
});

test("流式更新事件按 instance_uid 隔离，不跨节点写入", async () => {
    const a = await makeNode(17);
    const b = await makeNode(18);
    const beforeB = parts(b).promptArea.value;

    dispatchApiEvent("rs.prompt.auto_generate_update", {
        instance_uid: a.properties.rs_instance_uid,
        prompt: "只给 A 的内容",
    });

    assert.equal(parts(a).promptArea.value, "只给 A 的内容");
    assert.equal(parts(b).promptArea.value, beforeB);
});

test("后端流失败 [ERROR]：写回输入框的同时弹统一 action toast，同一失败只弹一次", async () => {
    const node = await makeNode(20);
    const el = parts(node);
    // 确定性桩下每个用例的首个节点都拿到同一个 uid，先前用例残留的监听会一起命中；
    // 换成唯一 uid 等价于真实环境（每节点各自 uuid），也让计数只反映本次分发
    const uid = "rs_inst_toast_case";
    node.properties.rs_instance_uid = uid;
    const before = document.querySelectorAll(".neo-at").length;

    // accumulated 逐块推送，同一失败会多次带上 [ERROR]，只弹一个 toast
    for (let i = 0; i < 2; i++) {
        dispatchApiEvent("rs.prompt.auto_generate_update", {
            instance_uid: uid,
            prompt: "[ERROR] Remote LLM HTTP 502: Error code: 502",
        });
    }

    assert.equal(el.promptArea.value, "[ERROR] Remote LLM HTTP 502: Error code: 502");
    assert.equal(document.querySelectorAll(".neo-at").length, before + 1);
    const toast = [...document.querySelectorAll(".neo-at")].at(-1);
    assert.equal(toast.querySelector(".neo-at-summary").textContent, "LLM 处理失败");
    assert.equal(toast.querySelector(".neo-at-detail").textContent, "Remote LLM HTTP 502: Error code: 502");
    assert.equal(toast.querySelector(".neo-at-action").textContent, "打开 LLM 设置");

    // 新一次生成（正常正文）之后再次失败 → 再弹一个新 toast
    dispatchApiEvent("rs.prompt.auto_generate_update", { instance_uid: uid, prompt: "正常正文" });
    dispatchApiEvent("rs.prompt.auto_generate_update", {
        instance_uid: uid,
        prompt: "[ERROR] Remote LLM timeout: read timeout",
    });
    assert.equal(document.querySelectorAll(".neo-at").length, before + 2);
});

test("流式 [ERROR] 帧：按错误上报并弹 action toast，错误文本不写进输入框", async () => {
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse([
        'data: {"text":"半截正文"}',
        "data: [ERROR] Remote LLM HTTP 502: Error code: 502",
        "data: [DONE]",
    ]));

    const node = await makeNode(22);
    const el = parts(node);
    inputText(el.quickInput, "a cat");
    keydown(el.quickInput, "Enter");
    await sleep(60);

    assert.ok(!el.promptArea.value.includes("[ERROR]"), "错误文本不进提示词输入框");
    const toast = [...document.querySelectorAll(".neo-at")].find((t) =>
        (t.querySelector(".neo-at-detail")?.textContent || "").includes("502"),
    );
    assert.ok(toast, "失败应弹 action toast");
    assert.equal(toast.querySelector(".neo-at-summary").textContent, "LLM 处理失败");
    assert.equal(toast.querySelector(".neo-at-detail").textContent, "Remote LLM HTTP 502: Error code: 502");
    assert.equal(toast.querySelector(".neo-at-action").textContent, "打开 LLM 设置");
});

test("选中 skill 时失败按来源分流：LLM 异常 → LLM 设置，skill 自身错误 → 技能详情", async () => {
    // 端点/密钥类失败（Remote LLM HTTP …）：即使选了 skill 也给 LLM 设置入口
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse([
        "data: [ERROR] Remote LLM HTTP 502: Error code: 502",
        "data: [DONE]",
    ]));
    const llmNode = await makeNode(23);
    const llmEl = parts(llmNode);
    llmEl.selector.value = "anime_style";
    inputText(llmEl.quickInput, "more detail");
    click(llmEl.generateBtn);
    await sleep(60);

    let toast = [...document.querySelectorAll(".neo-at")].at(-1);
    assert.equal(toast.querySelector(".neo-at-summary").textContent, "LLM 处理失败");
    assert.equal(toast.querySelector(".neo-at-action").textContent, "打开 LLM 设置");

    // skill 自身错误（模板为空等）：给技能详情入口
    clearRoutes();
    mockRoute("/rs_prompts/skills", () => jsonResponse(SKILLS));
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse([
        "data: [ERROR] 技能内容为空，无法执行",
        "data: [DONE]",
    ]));
    const skillNode = await makeNode(24);
    const skillEl = parts(skillNode);
    skillEl.selector.value = "anime_style";
    inputText(skillEl.quickInput, "more detail");
    click(skillEl.generateBtn);
    await sleep(60);

    toast = [...document.querySelectorAll(".neo-at")].at(-1);
    assert.equal(toast.querySelector(".neo-at-summary").textContent, "技能执行失败");
    assert.equal(toast.querySelector(".neo-at-action").textContent, "打开技能详情");
});

test("流式正文块 [ERROR]（JSON 帧）：按错误上报并弹 toast，错误文本不写进输入框", async () => {
    // 真实链路：llm.py / skill.py / image_gen.py 生成器内部 catch 后 yield 正文块 [ERROR]
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse([
        'data: {"text":"半截正文","kind":"content"}',
        'data: {"text":"[ERROR] Remote LLM HTTP 502: Error code: 502","kind":"content"}',
        "data: [DONE]",
    ]));

    const node = await makeNode(25);
    const el = parts(node);
    inputText(el.quickInput, "a cat");
    keydown(el.quickInput, "Enter");
    await sleep(60);

    assert.ok(!el.promptArea.value.includes("[ERROR]"), "错误文本不进提示词输入框");
    const toast = [...document.querySelectorAll(".neo-at")].find((t) =>
        (t.querySelector(".neo-at-detail")?.textContent || "").includes("502"),
    );
    assert.ok(toast, "失败应弹 action toast");
    assert.equal(toast.querySelector(".neo-at-summary").textContent, "LLM 处理失败");
    assert.equal(toast.querySelector(".neo-at-action").textContent, "打开 LLM 设置");
});

test("节点移除后注销全局监听并清掉挂 body 的浮层", async () => {
    const node = await makeNode(19);
    dispatchApiEvent("rs.prompt.auto_generate_update", {
        instance_uid: node.properties.rs_instance_uid,
        prompt: "移除前",
    });
    assert.equal(parts(node).promptArea.value, "移除前");
    // 骰子菜单与自动增强菜单都挂在 body，各节点一份
    assert.equal(document.querySelectorAll(".rs-runtime-menu").length, 2);

    node.onRemoved();

    assert.equal(document.querySelectorAll(".rs-runtime-menu").length, 0);
    dispatchApiEvent("rs.prompt.auto_generate_update", {
        instance_uid: node.properties.rs_instance_uid,
        prompt: "移除后不应写入",
    });
    assert.equal(parts(node).promptArea.value, "移除前");
});

test("自动增强菜单：右上角 ✕ 关闭；有未保存修改时先出确认条", async () => {
    mockRoute("/neo_image_gen/settings", () => jsonResponse({ output_prefix: "" }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));

    const node = await makeNode(21);
    const caret = uiRoot(node).querySelector(".rs-auto-wrap .rs-random-caret");
    const menu = document.querySelector(".rs-auto-config");
    const closeBtn = menu.querySelector(".rs-auto-close");
    assert.ok(closeBtn, "设置菜单右上角应有 ✕ 关闭按钮");

    click(caret); // 打开
    await sleep(300); // 等两表单 load 落定（放行脏检查）
    assert.equal(menu.style.display, "block");

    click(closeBtn); // 无修改：直接关
    assert.equal(menu.style.display, "none");

    click(caret); // 重开并改生图设置输出前缀 → 脏
    await sleep(300);
    const genPanel = menu.querySelectorAll(".rs-auto-panel")[1];
    // 输出前缀是文本输入框（目标像素数是 number，不看它）：改它让表单变脏
    genPanel.querySelector("input[type=text].rs-form-input:not(.rs-combo-input)").value = "out-";
    click(closeBtn); // 有未保存修改：不关，出确认条
    assert.equal(menu.style.display, "block");
    assert.equal(menu.querySelector(".rs-gen-dirty-confirm").hidden, false);

    click(menu.querySelector(".rs-gen-dirty-discard")); // 放弃修改 → 关
    assert.equal(menu.style.display, "none");
});
