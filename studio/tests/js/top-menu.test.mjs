// 顶栏 菜单（top-menu.js）：单按钮注册、下拉条目、节点子菜单过滤、关于弹窗、界面语言
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearBody, mockRoute, mockObjectInfo, jsonResponse, flush, sleep } from "./setup.mjs";
import { app, appState, getExtension } from "./mocks/comfy-app.mjs";
import { makeGraph, makeNode } from "./helpers/fake-graph.mjs";
import { setLang } from "../../web/js/core/i18n.js";

const topMenu = await import("../../web/top-menu.js");   // setup.mjs 副作用先行，再导入被测模块

beforeEach(() => {
    clearBody();
    topMenu.resetTopMenu();   // 收起残留菜单（模块级 menuEl 会挡住再次展开）
    setLang("zh");            // jsdom 的 navigator.language 是 en-US，用例基线固定为中文
});

test("top-menu.js 注册单个 菜单按钮", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    assert.ok(ext, "扩展 comfy.neo.topMenu 未注册");
    assert.equal(ext.actionBarButtons.length, 1);
    const btn = ext.actionBarButtons[0];
    assert.match(btn.icon, /neo-n-menu-icon/);
    assert.match(btn.class ?? "", /neo-n-menu-btn/);
    // setup 注入样式 + 右键绑定，jsdom 下不抛异常
    ext.setup();
    assert.ok(document.getElementById("neo-n-menu-style"), "样式未注入");
});

test("点击按钮展开菜单且包含全部条目", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    const menu = document.querySelector(".neo-n-menu");
    assert.ok(menu, "菜单未展开");
    const labels = [...menu.querySelectorAll(".neo-n-menu-item")].map((el) => el.textContent);
    for (const want of ["新影工坊", "生成素材", "新建导演配方", "创建节点", "修复工作流", "回写入技能", "修复记录", "变更记录", "关于插件"]) {
        assert.ok(labels.some((l) => l.includes(want)), `缺少条目: ${want}`);
    }
    // 再点一次收起
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    assert.equal(document.querySelector(".neo-n-menu"), null, "菜单未收起");
});

test("菜单条目顺序：设置 / 模型库 / 技能管理 分割在修复工具之后", () => {
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    const menu = document.querySelector(".neo-n-menu");
    assert.ok(menu, "菜单未展开");
    const kids = [...menu.children];
    const labels = kids
        .filter((el) => !el.classList.contains("neo-n-menu-sep") && !el.classList.contains("neo-n-submenu"))
        .map((el) => el.textContent.trim());
    assert.deepEqual(labels, [
        "新影工坊", "生成素材", "新建导演配方",
        "创建节点▸",
        "修复工作流", "回写入技能", "修复记录", "变更记录",
        "设置", "模型库", "技能管理",
        "关于插件",
    ], "条目顺序不符");
    assert.equal(kids.filter((el) => el.classList.contains("neo-n-menu-sep")).length, 3, "分组分隔线数量不符");
});

test("生成素材：点击打开生成素材弹窗", async () => {
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    const item = [...document.querySelectorAll(".neo-n-menu-item")]
        .find((el) => el.textContent.includes("生成素材"));
    assert.ok(item, "菜单缺少 生成素材条目");
    item.click();
    assert.equal(document.querySelector(".neo-n-menu"), null, "点菜单项后菜单未收起");
    assert.ok(document.querySelector(".neo-gallery-gm-modal-overlay"), "生成素材弹窗未打开");
});

test("创建节点子菜单按 LiteGraph.registeredNodes 过滤", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    globalThis.LiteGraph = { registeredNodes: { NeoPromptAgent: true } };
    try {
        ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
        const row = document.querySelector(".neo-n-node-row");
        assert.ok(row, "创建节点行缺失");
        row.click();
        const items = [...document.querySelectorAll(".neo-n-submenu .neo-n-menu-item")];
        assert.equal(items.length, 1, "只应列出已注册节点");
        assert.match(items[0].textContent, /Neo Prompt Agent/);
    } finally {
        delete globalThis.LiteGraph;
    }
});

test("点菜单外（document pointerdown）收起菜单", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    assert.ok(document.querySelector(".neo-n-menu"), "菜单未展开");
    // jsdom 无 PointerEvent 构造器，用 MouseEvent 冒泡到 document 捕获层即可触发
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    assert.equal(document.querySelector(".neo-n-menu"), null, "点外部后菜单未收起");
});

test("点菜单内部不收起", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    const menu = document.querySelector(".neo-n-menu");
    assert.ok(menu, "菜单未展开");
    menu.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    assert.ok(document.querySelector(".neo-n-menu"), "点菜单内部不应收起");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });   // 清理
});

test("关于插件弹窗显示源码与 License", async () => {
    mockRoute("/neo_studio/version", jsonResponse({ success: true, plugin_version: "9.9.9", comfyui_version: "1.33" }));
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    const aboutItem = [...document.querySelectorAll(".neo-n-menu-item")]
        .find((el) => el.textContent.includes("关于插件"));
    aboutItem.click();
    const dialog = document.querySelector(".neo-n-about-dialog");
    assert.ok(dialog, "关于弹窗未打开");
    assert.match(dialog.textContent, /github\.com\/neoneo-ai\/neo-studio/);
    assert.match(dialog.textContent, /Apache-2\.0/);
    await flush();   // 等版本 fetch 承诺链落定
    assert.match(dialog.textContent, /v9\.9\.9/);
    assert.equal(document.querySelector(".neo-n-menu"), null, "点菜单项后菜单未收起");
});

test("设置打开统一设置弹窗（四 tab，切 tab 显隐同步）", async () => {
    mockRoute("/neo_image_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    mockRoute("/neo_video_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    const settingsItem = [...document.querySelectorAll(".neo-n-menu-item")]
        .find((el) => el.textContent.includes("设置"));
    assert.ok(settingsItem, "菜单缺少 设置条目");
    settingsItem.click();
    assert.equal(document.querySelector(".neo-n-menu"), null, "点菜单项后菜单未收起");

    const overlay = document.querySelector(".neo-director-llm-overlay");
    assert.ok(overlay, "设置弹窗未打开");
    const tabs = [...overlay.querySelectorAll(".neo-settings-tab")].map((el) => el.textContent);
    assert.deepEqual(tabs, ["LLM 设置", "生图默认设置", "生视频模型", "界面语言"], "tab 顺序/文案不符");
    const panels = [...overlay.querySelectorAll(".neo-settings-panel")];
    assert.equal(panels.length, 4, "四个设置面板缺失");
    assert.equal(panels.filter((p) => p.style.display !== "none").length, 1, "默认只显示一个面板");
    assert.ok(panels[0].style.display !== "none", "默认应显示 LLM tab");

    // 切到生视频 tab：只有第三个面板可见
    overlay.querySelectorAll(".neo-settings-tab")[2].click();
    assert.equal(panels.filter((p) => p.style.display !== "none").length, 1, "切 tab 后应只有一个面板可见");
    assert.ok(panels[2].style.display !== "none", "生视频面板未显示");
    assert.ok(overlay.querySelectorAll(".neo-settings-tab")[2].classList.contains("neo-settings-tab-active"), "tab 高亮未跟随");

    // 无改动：✕ 直接关
    await flush();   // 等三个表单 load 落定（ready）
    overlay.querySelector(".neo-director-llm-close").click();
    assert.equal(document.querySelector(".neo-director-llm-overlay"), null, "无改动 ✕ 未直接关闭");
});

test("设置有未保存修改时先出确认条，放弃修改后关闭", async () => {
    mockRoute("/neo_image_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["diffusion/krea2.safetensors"], text_encoders: [], vae: [] }));
    mockRoute("/neo_video_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    [...document.querySelectorAll(".neo-n-menu-item")]
        .find((el) => el.textContent.includes("设置")).click();
    const overlay = document.querySelector(".neo-director-llm-overlay");
    assert.ok(overlay, "设置弹窗未打开");
    await flush();   // 等 load 落定，脏检查基线就绪

    // 选中生图表单的生图模型 → 脏
    const modelSelect = overlay.querySelector(".rs-gen-settings select");
    modelSelect.value = "diffusion/krea2.safetensors";
    overlay.querySelector(".neo-director-llm-close").click();
    assert.ok(overlay, "有改动 ✕ 不应直接关");
    const confirm = overlay.querySelector(".neo-director-llm-dirty");
    assert.equal(confirm.hidden, false, "确认条未出现");

    // 继续编辑：确认条收起、弹窗保留
    overlay.querySelector(".neo-director-llm-btn-keep").click();
    assert.equal(confirm.hidden, true, "继续编辑后确认条未收起");
    assert.ok(overlay, "继续编辑不应关闭弹窗");

    // 再点 ✕ → 确认条重现 → 放弃修改关闭
    overlay.querySelector(".neo-director-llm-close").click();
    assert.equal(confirm.hidden, false, "二次 ✕ 确认条未出现");
    overlay.querySelector(".neo-director-llm-btn-discard").click();
    assert.equal(document.querySelector(".neo-director-llm-overlay"), null, "放弃修改后未关闭");
});


test("悬停 按钮自动展开，指针在菜单内不收起，离开热区自动收起", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    ext.setup();
    const btn = document.createElement("button");
    btn.className = "neo-n-menu-btn";
    document.body.appendChild(btn);

    btn.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    assert.equal(document.querySelector(".neo-n-menu"), null, "未达悬停时长不应展开");
    await sleep(360);
    const menu = document.querySelector(".neo-n-menu");
    assert.ok(menu, "悬停未自动展开菜单");

    menu.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await sleep(560);
    assert.ok(document.querySelector(".neo-n-menu"), "指针在菜单内时不应收起");

    menu.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    await sleep(560);
    assert.equal(document.querySelector(".neo-n-menu"), null, "离开热区后未自动收起");
});

test("悬停时长内离开按钮不展开菜单", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    ext.setup();
    const btn = document.createElement("button");
    btn.className = "neo-n-menu-btn";
    document.body.appendChild(btn);
    btn.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    await sleep(400);
    assert.equal(document.querySelector(".neo-n-menu"), null, "扫过按钮不应展开菜单");
});

test("创建节点行悬停不展开子菜单，点击才展开", async () => {
    globalThis.LiteGraph = { registeredNodes: { NeoPromptAgent: true } };
    try {
        const ext = getExtension("comfy.neo.topMenu");
        ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
        const row = document.querySelector(".neo-n-node-row");
        assert.ok(row, "创建节点行缺失");
        const sub = row.nextElementSibling;
        assert.equal(sub.style.display, "none", "子菜单默认应收起");

        row.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
        await sleep(300);
        assert.equal(sub.style.display, "none", "悬停不应展开子菜单");
        assert.equal(row.classList.contains("open"), false, "悬停不应点亮展开标记");

        row.click();
        assert.notEqual(sub.style.display, "none", "点击未展开子菜单");
        assert.ok(row.classList.contains("open"), "展开标记未同步");
    } finally {
        delete globalThis.LiteGraph;
        topMenu.resetTopMenu();
    }
});


test("创建节点二级菜单飞出到行右侧，不在原位撑开父菜单", async () => {
    globalThis.LiteGraph = { registeredNodes: { NeoPromptAgent: true } };
    try {
        const ext = getExtension("comfy.neo.topMenu");
        ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
        const row = document.querySelector(".neo-n-node-row");
        const sub = document.querySelector(".neo-n-submenu");

        // 父菜单撑不开：子菜单 fixed 脱离文档流，父菜单高度只由主条目决定
        const menuHeightBefore = document.querySelector(".neo-n-menu").offsetHeight;
        row.__rect = { top: 200, left: 100, right: 340, bottom: 228, width: 240, height: 28 };
        sub.__rect = { top: 0, left: 0, right: 250, bottom: 200, width: 250, height: 200 };

        row.click();

        assert.notEqual(sub.style.display, "none", "点击未展开子菜单");
        assert.equal(sub.style.left, "344px", "应贴在行右缘外侧（right 340 + 4 间距）");
        assert.equal(sub.style.top, "200px", "应与行顶对齐");
        assert.equal(document.querySelector(".neo-n-menu").offsetHeight, menuHeightBefore, "展开子菜单不应撑高父菜单");
    } finally {
        delete globalThis.LiteGraph;
        topMenu.resetTopMenu();
    }
});

test("二级菜单右侧空间不足时翻到左侧", async () => {
    globalThis.LiteGraph = { registeredNodes: { NeoPromptAgent: true } };
    try {
        const ext = getExtension("comfy.neo.topMenu");
        ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
        const row = document.querySelector(".neo-n-node-row");
        const sub = document.querySelector(".neo-n-submenu");

        // 菜单贴近视口右缘：行右侧放不下 250px 宽的子菜单
        const rowLeft = window.innerWidth - 250;
        row.__rect = { top: 200, left: rowLeft, right: window.innerWidth - 10, bottom: 228, width: 240, height: 28 };
        sub.__rect = { top: 0, left: 0, right: 250, bottom: 200, width: 250, height: 200 };

        row.click();

        assert.equal(sub.style.left, `${rowLeft - 250 - 4}px`, "右侧放不下应翻到行左侧");
    } finally {
        delete globalThis.LiteGraph;
        topMenu.resetTopMenu();
    }
});


test("悬停刚展开的宽限期内点击不收起，宽限期过后点击收起", async () => {
    const ext = getExtension("comfy.neo.topMenu");
    ext.setup();
    const btn = document.createElement("button");
    btn.className = "neo-n-menu-btn";
    document.body.appendChild(btn);

    btn.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await sleep(360);
    assert.ok(document.querySelector(".neo-n-menu"), "悬停未自动展开菜单");

    // 宽限期内（悬停刚展开 0.5 秒内）：点击算同一次手势，菜单保持展开
    ext.actionBarButtons[0].onClick({ currentTarget: btn });
    assert.ok(document.querySelector(".neo-n-menu"), "宽限期内的点击不应收起");

    // 宽限期过后：点击就是正常收起，一次生效
    await sleep(600);
    ext.actionBarButtons[0].onClick({ currentTarget: btn });
    assert.equal(document.querySelector(".neo-n-menu"), null, "宽限期过后点击应收起菜单");
});

test("二级菜单点击行切换展开 / 收起", async () => {
    globalThis.LiteGraph = { registeredNodes: { NeoPromptAgent: true } };
    try {
        const ext = getExtension("comfy.neo.topMenu");
        ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
        const row = document.querySelector(".neo-n-node-row");
        const sub = row.nextElementSibling;

        row.click();
        assert.notEqual(sub.style.display, "none", "首次点击应展开");
        assert.ok(row.classList.contains("open"), "展开标记未同步");

        row.click();
        assert.equal(sub.style.display, "none", "再次点击应收起");
        assert.equal(row.classList.contains("open"), false, "收起后标记应清掉");

        row.click();
        assert.notEqual(sub.style.display, "none", "收起后可再次展开");
    } finally {
        delete globalThis.LiteGraph;
        topMenu.resetTopMenu();
    }
});


// ── 创建节点落点 ─────────────────────────────────────────────
// 画布替身：screen=(graph+offset)*scale，可见区 = 图坐标 [200,100] ~ [700,461.1]
const SCALE = 1.8, OX = -200, OY = -100;
const CANVAS_RECT = { left: 100, top: 50, width: 900, height: 650 };
const VIS = [-OX, -OY, CANVAS_RECT.width / SCALE - OX, CANVAS_RECT.height / SCALE - OY];

function setupCanvas(nodeSize) {
    const focused = [];
    app.canvas = {
        canvas: { getBoundingClientRect: () => CANVAS_RECT },
        ds: { scale: SCALE, offset: [OX, OY] },
        canvasPosToGraph: ([x, y]) => [x / SCALE - OX, y / SCALE - OY],
        focusNode: (n) => focused.push(n.id),
        select: () => {},
    };
    const graph = makeGraph();
    graph.nodes = graph._nodes;
    appState.graph = graph;
    globalThis.LiteGraph = {
        registeredNodes: { NeoPromptAgent: true },
        createNode: (type) => Object.assign(makeNode({ id: 91, type }), { pos: [0, 0], size: nodeSize }),
    };
    return { graph, focused };
}

function cleanupCanvas() {
    delete globalThis.LiteGraph;
    app.canvas = null;
    appState.graph = null;
    topMenu.resetTopMenu();
}

function clickCreateNodeItem() {
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    document.querySelector(".neo-n-node-row").click();
    document.querySelector(".neo-n-submenu .neo-n-menu-item").click();
}

test("创建节点：空画布落在当前可见区正中", () => {
    const { graph } = setupCanvas([200, 100]);
    try {
        clickCreateNodeItem();
        const node = graph._nodes[0];
        assert.ok(node, "节点未加入画布");
        const cx = (VIS[0] + VIS[2]) / 2 - 100;
        const cy = (VIS[1] + VIS[3]) / 2 - 50;
        assert.ok(Math.abs(node.pos[0] - cx) < 1e-6, `落点 x 应为可见区中心 ${cx.toFixed(1)}，实际 ${node.pos[0].toFixed(1)}`);
        assert.ok(Math.abs(node.pos[1] - cy) < 1e-6, `落点 y 应为可见区中心 ${cy.toFixed(1)}，实际 ${node.pos[1].toFixed(1)}`);
    } finally {
        cleanupCanvas();
    }
});

// ---- 画布技能待回写：顶菜单「回写入技能」入口 + 绿点（状态由 skill.js 持有）----
const WF_MIN = { "1": { class_type: "SaveImage", inputs: { images: ["2", 0] } } };

function mockHandoffRoutes(id = "custom_a", source = "custom") {
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "Gen Skill", source, content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: true, gen_video: false, requires_ref: false, multi_turn: false, tags: [], category: "image_gen",
    }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: id, workflow: WF_MIN }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: [] }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => call.method === "GET" ? jsonResponse({ model: "m.safetensors" }) : jsonResponse({ success: true }));
    mockRoute("/neo_image_gen/update_workflow_skill_preview", () =>
        jsonResponse({ success: true, id, changes: [{ field: "model", from: "old.safetensors", to: "m.safetensors" }], warnings: [], gen_video: false }));
    mockObjectInfo({});
}

function writebackItem() {
    return [...document.querySelectorAll(".neo-n-menu-item")].find((el) => el.textContent.includes("回写入技能"));
}

test("顶菜单「回写入技能」：画布无待回写技能时置灰", () => {
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
    const item = writebackItem();
    assert.ok(item, "菜单缺少「回写入技能」条目");
    assert.equal(item.disabled, true, "无待回写技能应置灰");
    assert.match(item.title, /导入到画布/);
    ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
});

test("顶菜单「回写入技能」：导入到画布后绿点亮、条目可用，确认后落盘并清绿点", async () => {
    mockHandoffRoutes();
    let posted = null;
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        posted = b;
        return jsonResponse({ success: true, id: b.skill_id, warnings: [], gen_video: false });
    });
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    const btn = document.createElement("button");
    btn.className = "neo-n-menu-btn";
    document.body.appendChild(btn);

    const { openSkillWorkflowOnCanvas } = await import("../../web/skill.js");
    await openSkillWorkflowOnCanvas("custom_a");
    await sleep(80);
    assert.ok(btn.classList.contains("neo-writeback-hint"), "导入后 按钮应挂绿点（绿色 = 有可保存的变更）");

    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: btn });
    const item = writebackItem();
    assert.equal(item.disabled, false, "有技能待回写时条目应可用");
    assert.match(item.title, /custom_a/, "条目 title 应给出目标技能");
    assert.ok(item.querySelector(".neo-n-menu-dot-green"), "按钮绿点 → 「回写入技能」条目应带绿点引导");
    item.click();
    await sleep(80);

    const dlg = document.querySelector(".rs-wf-write-confirm");
    assert.ok(dlg, "点顶菜单回写应出变更确认弹窗");
    assert.ok(dlg.textContent.includes("model"), "弹窗应列出预览的变更项");
    [...dlg.querySelectorAll(".rs-repair-foot button")].find((b) => b.textContent.includes("确认保存")).click();
    await sleep(80);
    assert.equal(posted && posted.skill_id, "custom_a", "确认后应把画布落盘该技能");
    assert.equal(btn.classList.contains("neo-writeback-hint"), false, "落盘后应清绿点");
});

test("顶菜单「回写入技能」：预设技能待回写时点亮绿点、条目可用", async () => {
    mockHandoffRoutes("image_gen", "presets");
    appState.promptGraph = { output: { "10": { class_type: "SaveImage", inputs: {} } }, workflow: "{}" };
    const btn = document.createElement("button");
    btn.className = "neo-n-menu-btn";
    document.body.appendChild(btn);
    const { openSkillWorkflowOnCanvas } = await import("../../web/skill.js");
    await openSkillWorkflowOnCanvas("image_gen");
    await sleep(80);
    assert.ok(btn.classList.contains("neo-writeback-hint"), "预设导入后应点亮绿点（模型值可写本地覆盖）");

    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: btn });
    const item = writebackItem();
    assert.equal(item.disabled, false, "预设技能条目应可用（值写本地覆盖，结构自动复制副本）");
    assert.match(item.title, /预设/);
    assert.ok(item.querySelector(".neo-n-menu-dot-green"), "预设待回写同样带绿点引导");
});

function repairItem() {
    return [...document.querySelectorAll(".neo-n-menu-item")].find((el) => el.textContent.includes("修复工作流"));
}

test("顶菜单引导点：按钮红点 →「修复工作流」带红点、「回写入技能」无绿点", () => {
    const btn = document.createElement("button");
    btn.className = "neo-n-menu-btn neo-repair-hint";
    document.body.appendChild(btn);
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: btn });
    assert.ok(repairItem().querySelector(".neo-n-menu-dot-red"), "按钮红点 →「修复工作流」应带红点引导");
    assert.equal(writebackItem().querySelector(".neo-n-menu-dot-green"), null, "无绿点时回写条目不应带绿点");
});

test("顶菜单引导点：无提示点时菜单条目不带引导点", () => {
    const btn = document.createElement("button");
    btn.className = "neo-n-menu-btn";
    document.body.appendChild(btn);
    const ext = getExtension("comfy.neo.topMenu");
    ext.actionBarButtons[0].onClick({ currentTarget: btn });
    assert.equal(repairItem().querySelector(".neo-n-menu-dot-red"), null, "无红点时修复条目不应带红点");
    assert.equal(writebackItem().querySelector(".neo-n-menu-dot-green"), null, "无绿点时回写条目不应带绿点");
});

test("创建节点：中心被已有节点占据时落在可见区内空位", () => {
    const { graph } = setupCanvas([200, 100]);
    const blocker = makeNode({ id: 5, type: "KSampler" });
    blocker.pos = [300, 200];
    blocker.size = [200, 100];
    graph.add(blocker);
    try {
        clickCreateNodeItem();
        const node = graph._nodes.find((n) => n.id === 91);
        const [x, y] = node.pos;
        const fmt = `${x.toFixed(1)},${y.toFixed(1)}`;
        assert.ok(
            x >= VIS[0] - 1e-9 && y >= VIS[1] - 1e-9 && x + 200 <= VIS[2] + 1e-9 && y + 100 <= VIS[3] + 1e-9,
            `落点 ${fmt} 应完整落在可见区 [${VIS.map((v) => v.toFixed(0)).join(",")}] 内`
        );
        assert.ok(!(x < 500 && x + 200 > 300 && y < 300 && y + 100 > 200), `落点 ${fmt} 不应与已有节点重叠`);
    } finally {
        cleanupCanvas();
    }
});

test("创建节点：可见区里挤不下时落在中心并把视图挪到节点上", () => {
    const { graph, focused } = setupCanvas([900, 500]);
    try {
        clickCreateNodeItem();
        const node = graph._nodes[0];
        const cx = (VIS[0] + VIS[2]) / 2 - 450;
        const cy = (VIS[1] + VIS[3]) / 2 - 250;
        assert.ok(Math.abs(node.pos[0] - cx) < 1e-6 && Math.abs(node.pos[1] - cy) < 1e-6,
            `挤不下时应落在可见区中心，实际 ${node.pos.map((v) => v.toFixed(1))}`);
        assert.deepEqual(focused, [91], "应调用 focusNode 把视图挪到新节点");
    } finally {
        cleanupCanvas();
    }
});

test("创建节点：无画布缩放信息时兜底落点不抛异常", () => {
    const { graph } = setupCanvas([200, 100]);
    app.canvas = null;
    try {
        clickCreateNodeItem();
        assert.equal(graph._nodes.length, 1, "节点应加入画布");
        assert.deepEqual(graph._nodes[0].pos, [200, 200]);
    } finally {
        cleanupCanvas();
    }
});


// ── 界面语言（js/core/i18n.js）─────────────────────────────────
test("切到英文：菜单条目、节点子菜单、回写提示为英文", () => {
    globalThis.LiteGraph = { registeredNodes: { NeoPromptAgent: true } };
    setLang("en");
    try {
        const ext = getExtension("comfy.neo.topMenu");
        ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
        const labels = [...document.querySelectorAll(".neo-n-menu-item")].map((el) => el.textContent);
        for (const want of ["Settings", "Generate Assets", "Write Back to Skill", "About Plugin"]) {
            assert.ok(labels.some((l) => l.includes(want)), `缺少英文条目: ${want}`);
        }
        const writeback = [...document.querySelectorAll(".neo-n-menu-item")]
            .find((el) => el.textContent.includes("Write Back to Skill"));
        assert.ok(!/[\u4e00-\u9fff]/.test(writeback.title), `回写条目提示未翻译: ${writeback.title}`);
        document.querySelector(".neo-n-node-row").click();
        assert.equal(document.querySelector(".neo-n-submenu .neo-n-menu-item").textContent,
            "Neo Prompt Agent", "英文下应去掉中文括号注释");
    } finally {
        delete globalThis.LiteGraph;
        setLang("zh");
        topMenu.resetTopMenu();
    }
});

test("设置弹窗「界面语言」：单选当前语言，保存落盘并整页刷新", async () => {
    mockRoute("/neo_image_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    mockRoute("/neo_video_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    const reloads = [];
    const realLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", { value: { reload: () => reloads.push(1) }, configurable: true, writable: true });
    const ext = getExtension("comfy.neo.topMenu");
    const openSettings = () => {
        ext.actionBarButtons[0].onClick({ currentTarget: document.createElement("button") });
        [...document.querySelectorAll(".neo-n-menu-item")].find((el) => el.textContent.includes("设置")).click();
        return document.querySelector(".neo-director-llm-overlay");
    };
    try {
        const overlay = openSettings();
        overlay.querySelectorAll(".neo-settings-tab")[3].click();
        assert.ok(overlay.querySelectorAll(".neo-settings-tab")[3].classList.contains("neo-settings-tab-active"), "语言 tab 未高亮");
        const radios = [...overlay.querySelectorAll(".neo-settings-panel")[3].querySelectorAll("input[name=\"neo-lang\"]")];
        assert.equal(radios.length, 2, "语言单选项数量不符");
        assert.ok(radios[0].checked, "默认应选中当前语言（中文）");

        // 无改动：✕ 直接关，不刷新
        await flush();
        overlay.querySelector(".neo-director-llm-close").click();
        assert.equal(document.querySelector(".neo-director-llm-overlay"), null, "无改动 ✕ 未直接关闭");
        assert.deepEqual(reloads, [], "无改动不应刷新");

        // 选英文 → 判脏 → 保存并关闭 = 落盘 + 刷新
        const overlay2 = openSettings();
        overlay2.querySelectorAll(".neo-settings-tab")[3].click();
        await flush();
        overlay2.querySelectorAll("input[name=\"neo-lang\"]")[1].click();
        overlay2.querySelector(".neo-director-llm-close").click();
        assert.equal(overlay2.querySelector(".neo-director-llm-dirty").hidden, false, "切换语言应判脏");
        overlay2.querySelector(".neo-director-llm-btn-save").click();
        await flush();
        assert.deepEqual(reloads, [1], "保存语言应整页刷新");
        assert.equal(localStorage.getItem("neo_studio_lang"), "en", "语言未落盘");
    } finally {
        Object.defineProperty(globalThis, "location", { value: realLocation, configurable: true, writable: true });
        localStorage.removeItem("neo_studio_lang");
        setLang("zh");
        topMenu.resetTopMenu();
    }
});

