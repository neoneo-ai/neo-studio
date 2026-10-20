// 导演编辑器「技能过滤 / 图片分镜卡片 / 生成提示词循环」：技能步数排序、分镜模式与回显、逐段 LLM 生成。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sseResponse, sleep, fetchLog, inputText, changeValue, dropFiles, makeFile } from "./setup.mjs";
import { app, appState, resetSidebarTab } from "./mocks/comfy-app.mjs";

beforeEach(async () => {
    resetEnv();
    clearRoutes();
    resetSidebarTab();
    const { resetDirectorTabMemory } = await import("../../web/director.js");
    resetDirectorTabMemory();   // 页签记忆是模块级会话状态，逐用例清零避免跨用例串味
});

test("导演编辑器：视频技能按段有效模式过滤（f2v 池=全部帧模式技能，无匹配回退全量）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-t2v", name: "文生", gen_video: true, mode: "t2v" },
        { id: "sk-i2v", name: "图生", gen_video: true, mode: "i2v" },
        { id: "sk-r2v", name: "全参考", gen_video: true, mode: "r2v" },
    ]));

    const existing = {
        name: "MODE-SKILL",
        shared: { mode: "t2v" },
        segments: [{ skill_id: "sk-t2v", prompt: "p", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const seg = document.querySelector(".neo-director-seg");
    const skillSel = seg.querySelector(".neo-director-skill");
    assert.deepEqual(Array.from(skillSel.options).map((o) => o.value), ["sk-t2v", "sk-i2v"], "旧 t2v 重映射为 f2v，池含全部帧模式技能");

    // 全局切到 r2v → 该段技能列表刷新为 r2v 技能
    const modeSel = document.querySelector(".neo-director-mode");
    modeSel.value = "r2v";
    modeSel.dispatchEvent(new Event("change"));
    assert.deepEqual(Array.from(skillSel.options).map((o) => o.value), ["sk-r2v"], "切 r2v 后仅列 r2v 技能");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：非混合模式统一选择技能（紧邻生成模式，各段行不再显示技能下拉）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-t2v", name: "文生", gen_video: true, mode: "t2v" },
        { id: "sk-t2v2", name: "文生二", gen_video: true, mode: "t2v" },
    ]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "UNI" }));

    await openDirectorEditor({
        name: "UNI", shared: { mode: "t2v", width: 960, height: 544 },
        segments: [
            { skill_id: "sk-t2v", prompt: "第一段", duration_sec: 5 },
            { skill_id: "sk-t2v2", prompt: "第二段", duration_sec: 5 },
        ],
    });
    await sleep(60);

    // 位置：🎞️ 分镜时间线页首行「生成模式」之后（生成设置归时间线页，故事板分镜与生成模式无关）
    const stRow = document.querySelector(".neo-director-pane-timeline .neo-director-shared");
    const kids = Array.from(stRow.children);
    const gSkillSel = stRow.querySelector(".neo-director-global-skill");
    assert.ok(gSkillSel, "非混合模式显示统一技能框");
    const gSkillLabel = stRow.querySelector(".neo-director-global-skill-label");
    assert.equal(kids.indexOf(gSkillLabel), kids.indexOf(stRow.querySelector(".neo-director-mode")) + 1, "技能标签紧邻生成模式之后");
    assert.equal(kids.indexOf(gSkillSel), kids.indexOf(gSkillLabel) + 1, "技能下拉紧随其标签");
    assert.equal(document.querySelector(".neo-director-pane-story .neo-director-global-skill"), null, "故事板分镜页没有统一技能框（生成设置只在时间轴页）");
    assert.equal(gSkillSel.value, "sk-t2v", "初始取首段技能");
    assert.equal(gSkillLabel.style.display, "", "标签可见");

    // 各段行的技能下拉与标签隐藏（技能由统一框决定）
    for (const row of document.querySelectorAll(".neo-director-seg")) {
        assert.equal(row.querySelector(".neo-director-skill").style.display, "none", "段内技能下拉隐藏");
        assert.equal(row.querySelector(".neo-director-skill-label").style.display, "none", "段内技能标签隐藏");
    }
    assert.deepEqual(Array.from(document.querySelectorAll(".neo-director-seg .neo-director-skill")).map((s) => s.value),
        ["sk-t2v", "sk-t2v"], "打开即按统一技能归一各段");

    // 时间轴页统一技能改选 → 各段跟随（故事板分镜页没有重复的技能框）
    gSkillSel.value = "sk-t2v2";
    gSkillSel.dispatchEvent(new window.Event("change"));
    assert.equal(document.querySelector(".neo-director-pane-story .neo-director-global-skill"), null, "故事板分镜页不重复统一技能框");
    assert.deepEqual(Array.from(document.querySelectorAll(".neo-director-seg .neo-director-skill")).map((s) => s.value),
        ["sk-t2v2", "sk-t2v2"], "统一技能同步到各段");

    // 保存：每一段都写统一技能
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "发出保存请求");
    assert.deepEqual(saveCall.body.segments.map((s) => s.skill_id), ["sk-t2v2", "sk-t2v2"], "统一技能写入每一段");
});

test("导演编辑器：混合模式隐藏统一技能框，技能回到逐段选择", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-t2v", name: "文生", gen_video: true, mode: "t2v" },
        { id: "sk-i2v", name: "图生", gen_video: true, mode: "i2v" },
        { id: "sk-r2v", name: "全参考", gen_video: true, mode: "r2v" },
    ]));

    await openDirectorEditor({
        name: "MIX", shared: { mode: "mixed", width: 960, height: 544 },
        segments: [{ skill_id: "sk-t2v", prompt: "第一段", duration_sec: 5, mode: "t2v" }],
    });
    await sleep(60);

    const stRow = document.querySelector(".neo-director-pane-timeline .neo-director-shared");
    assert.equal(stRow.querySelector(".neo-director-global-skill").style.display, "none", "混合模式隐藏统一技能框");
    assert.equal(stRow.querySelector(".neo-director-global-skill-label").style.display, "none", "标签一并隐藏");
    const segSkill = document.querySelector(".neo-director-seg .neo-director-skill");
    assert.equal(segSkill.style.display, "", "混合模式段内技能下拉恢复显示");
    assert.equal(document.querySelector(".neo-director-seg .neo-director-skill-label").style.display, "");
    assert.deepEqual(Array.from(segSkill.options).map((o) => o.value), ["sk-t2v", "sk-i2v"], "段内技能池按该段有效模式（旧 t2v → f2v）过滤");

    // 切回非混合模式：统一框显示、段内隐藏，且技能池按新全局模式过滤
    const modeSel = stRow.querySelector(".neo-director-mode");
    modeSel.value = "r2v";
    modeSel.dispatchEvent(new window.Event("change"));
    assert.equal(stRow.querySelector(".neo-director-global-skill").style.display, "", "非混合模式恢复显示统一技能框");
    assert.equal(segSkill.style.display, "none", "段内技能下拉重新隐藏");
    assert.deepEqual(Array.from(stRow.querySelector(".neo-director-global-skill").options).map((o) => o.value),
        ["sk-r2v"], "统一技能池按全局模式过滤");
    assert.equal(segSkill.value, "sk-r2v", "各段跟随统一技能");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：技能下拉按步数排序，新建配方默认取步数最少的（图库卡片菜单路径同样生效）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    // 真实形状：presets 按目录名排序（'-' 在前），步数来自各自 config.json（未配置 = 后端缺省 20）
    const REAL = [
        { id: "minimax-h3-r2v", name: "全参考", gen_video: true, mode: "r2v", gen_config: { steps: 20 } },
        { id: "minimax-h3-vdn-r2v", name: "全参考 VDN", gen_video: true, mode: "r2v", gen_config: { steps: 8 } },
        { id: "minimax_h3_fl2v", name: "首尾帧", gen_video: true, mode: "fl2v", gen_config: { steps: 20 } },
        { id: "minimax_h3_i2v", name: "图生", gen_video: true, mode: "i2v", gen_config: { steps: 20 } },
        { id: "minimax_h3_multiframe", name: "连续多段合成", gen_video: true, mode: "t2v", multi_frame: true, gen_config: { steps: 20 } },
        { id: "minimax_h3_nostep", name: "未配置步数", gen_video: true, mode: "t2v" },
        { id: "minimax_h3_vdn_t2v", name: "文生 VDN", gen_video: true, mode: "t2v", gen_config: { steps: 8 } },
        { id: "minimax_h3_vdn_multiframe", name: "连续多段合成 VDN", gen_video: true, mode: "t2v", multi_frame: true, gen_config: { steps: 8 } },
    ];
    let pool = REAL;
    mockRoute("/rs_prompts/skills", () => jsonResponse(pool));
    const gSel = () => document.querySelector(".neo-director-global-skill");
    const openWith = async (arg) => {
        await openDirectorEditor(arg);
        await sleep(60);
        const opts = Array.from(gSel().options).map((o) => o.value);
        const steps = new Map(REAL.map((s) => [s.id, Number(s.gen_config && s.gen_config.steps) || 20]));
        const out = { value: gSel().value, opts, stepOrder: opts.map((id) => steps.get(id)) };
        document.querySelector(".neo-director-close").click();
        await sleep(20);
        return out;
    };

    // 新建配方（节点 ✎ 新建按钮路径）
    const node = await openWith(null);
    assert.deepEqual(node.stepOrder, node.stepOrder.slice().sort((a, b) => a - b), "下拉按步数从少到多排序");
    assert.equal(node.opts[0], "minimax_h3_vdn_multiframe", "8 步的排在最前（同分偏好连续多段合成）");
    assert.equal(node.opts[node.opts.length - 1], "minimax_h3_nostep", "未配置步数按缺省 20 计，排 8 步之后");
    assert.equal(node.value, "minimax_h3_vdn_multiframe", "默认技能 = 步数最少的");

    // 图库卡片菜单路径：传的是 { name: '' }（对象非 null），同样算新建 → 默认与排序都要生效
    const card = await openWith({ name: "", shared: { mode: "f2v" }, segments: [{ first_frame: "a.png", duration_sec: 5 }] });
    assert.equal(card.value, "minimax_h3_vdn_multiframe", "卡片「🎬 新建导演配方」默认也是步数最少的");
    assert.equal(card.opts[0], card.value, "默认即列表首项");

    // r2v 新建：池内只有两种 r2v，取 8 步的 VDN
    const r2v = await openWith({ name: "", shared: { mode: "r2v" }, segments: [{ duration_sec: 5 }] });
    assert.deepEqual(r2v.opts, ["minimax-h3-vdn-r2v", "minimax-h3-r2v"], "r2v 池按步数排序");
    assert.equal(r2v.value, "minimax-h3-vdn-r2v");

    // 编辑已有配方：沿用落盘的段技能，不被默认覆盖
    const edit = await openWith({ name: "E", shared: { mode: "f2v" }, segments: [{ skill_id: "minimax_h3_i2v", duration_sec: 5 }] });
    assert.equal(edit.value, "minimax_h3_i2v", "编辑已有配方不改技能");

    // VDN 插件未装：8 步的 VDN 全部不可用 → 回落到 20 步里偏好优先的连续多段合成
    pool = REAL.map((s) => (s.id.includes("_vdn_") ? Object.assign({}, s, { available: false }) : s));
    const noVdn = await openWith({ name: "", shared: { mode: "f2v" }, segments: [{ first_frame: "a.png", duration_sec: 5 }] });
    assert.equal(noVdn.value, "minimax_h3_multiframe", "VDN 不可用时不选它，仍取可用的最少步数");
});

test("导演编辑器：参考素材区标题行「素材库」按钮打开/收起左侧素材面板", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true, mode: "r2v" }]));

    await openDirectorEditor({
        name: "REF-LIB", shared: { mode: "r2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "r2v" }],
    }, null);
    await sleep(60);

    const refsLib = document.querySelector(".neo-director-seg .neo-director-refs-head .neo-director-ff-lib");
    assert.ok(refsLib, "参考素材区标题行存在素材库按钮");

    const tab = app.extensionManager.sidebarTab;
    refsLib.click();
    assert.equal(tab.activeSidebarTabId, "neo.gallery", "点击打开素材面板");
    refsLib.click();
    assert.equal(tab.activeSidebarTabId, null, "再次点击收起素材面板");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});


test("导演编辑器：「📖 故事板分镜」页签——时间轴页生成模式联动本页素材区", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "SETUP", shared: { mode: "t2v" },
        segments: [
            { skill_id: "sk-a", prompt: "第一段", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "第二段", duration_sec: 5 },
        ],
    });
    await sleep(60);

    // 标题栏：🎬 分镜视频导演 + 两个页签：📖 故事板分镜 / 🎞️ 分镜时间线
    assert.equal(document.querySelector(".neo-director-title-left > span").textContent, "🎬 分镜视频导演", "弹窗标题 = 分镜视频导演");
    const tabs = Array.from(document.querySelectorAll(".neo-director-tab"));
    assert.equal(tabs.length, 2, "标题栏共两个页签");
    const tabStory = tabs.find((t) => t.textContent.includes("故事板分镜"));
    assert.ok(tabStory, "含「📖 故事板分镜」页签");
    assert.ok(tabs.find((t) => t.textContent.includes("分镜时间线")), "含「🎞️ 分镜时间线」页签");

    // 切到故事板分镜页：story 面板显示，时间轴隐藏
    tabStory.click();
    await sleep(20);
    assert.ok(tabStory.classList.contains("active"), "故事板分镜页签激活");
    assert.equal(document.querySelector(".neo-director-pane-story").style.display, "");
    assert.equal(document.querySelector(".neo-director-pane-timeline").style.display, "none");

    // 生成模式 / 统一技能在「🎞️ 分镜时间线」页首行（故事板分镜与生成模式无关，本页不重复）
    const setupPane = document.querySelector(".neo-director-pane-story");
    const tlRow = document.querySelector(".neo-director-pane-timeline .neo-director-shared");
    assert.ok(tlRow.querySelector(".neo-director-mode"), "生成模式下拉在时间轴页");
    assert.equal(setupPane.querySelector(".neo-director-mode"), null, "故事板分镜页没有生成模式下拉（生成设置只在时间轴页）");
    assert.equal(setupPane.querySelector(".neo-director-setup-refs"), null, "统一参考素材区已移除（参考素材到时间轴页逐段设置）");
    assert.ok(setupPane.querySelector(".neo-director-optimize"), "提示词优化按钮");

    // 改时间轴页生成模式 → 本页素材区跟随显隐
    const stModeSel = tlRow.querySelector(".neo-director-mode");
    assert.equal(stModeSel.value, "f2v", "初始与 shared.mode 一致（旧 t2v 重映射为 f2v）");
    stModeSel.value = "r2v";
    stModeSel.dispatchEvent(new Event("change"));
    assert.ok(Array.from(document.querySelectorAll(".neo-director-seg .neo-director-refs-block"))
        .every((b) => b.style.display !== "none"), "r2v 下各段参考素材区显示");
    const hints = Array.from(setupPane.querySelectorAll(".neo-director-setup-hint"));
    const r2vHint = hints.find((h) => h.textContent.includes("全参考模式"));
    assert.ok(r2vHint && r2vHint.style.display !== "none", "r2v 显示「到时间轴页逐段设置」说明");
    assert.ok(hints.every((h) => h === r2vHint || h.style.display === "none"), "r2v 隐藏其余说明文字");

    stModeSel.value = "f2v";
    stModeSel.dispatchEvent(new Event("change"));
    assert.equal(r2vHint.style.display, "none", "切回 f2v 隐藏全参考说明");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：「生成所有分段的提示词」逐段循环生成、即时显示进展", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    // 逐段请求：每次只处理一段，返回该段的成品提示词（optMode 控制成功/失败）
    const optBodies = [];
    let optMode = { success: false, error: "模拟生成失败" };
    mockRoute("/rs_recipes/director_optimize_prompts", (body) => {
        optBodies.push(body);
        return optMode.success
            ? sseResponse(['data: ' + JSON.stringify({ text: optMode.prompt }), "data: [DONE]"])
            : sseResponse(["data: [ERROR] " + optMode.error, "data: [DONE]"]);
    });

    await openDirectorEditor({
        name: "OPT", shared: { mode: "t2v" },
        segments: [
            { skill_id: "sk-a", prompt: "第一段原始", duration_sec: 5, storyboard: "p0.png" },
            { skill_id: "sk-a", prompt: "第二段原始", duration_sec: 8, storyboard: "p1.png" },
        ],
    });
    await sleep(60);

    Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜")).click();
    await sleep(20);

    // 失败路径：两段都失败 → 逐段两次请求、原文写回该段、状态显示失败段号、action toast 给处理入口（不自动弹弹窗）
    document.querySelector(".neo-director-optimize").click();
    await sleep(100);
    assert.equal(optBodies.length, 2, "逐段循环：每段单独一次请求");
    assert.deepEqual(optBodies[0], { prompt: "第一段原始", duration_sec: 5, mode: "f2v" }, "第 1 段请求体（旧 t2v 重映射为 f2v）");
    assert.deepEqual(optBodies[1], { prompt: "第二段原始", duration_sec: 8, mode: "f2v" }, "第 2 段请求体（单段）");
    const tas = Array.from(document.querySelectorAll(".neo-director-prompt"));
    assert.equal(tas[0].value, "第一段原始", "失败时该段按原文恢复");
    assert.ok(document.querySelector(".neo-director-opt-status").textContent.includes("1、2 段生成失败"), "状态显示失败的段号");
    assert.ok(!document.querySelector(".neo-director-llm-overlay"), "失败不自动弹出 LLM 配置弹窗");
    const atAction = document.querySelector(".neo-at .neo-at-action");
    assert.equal(atAction?.textContent, "打开 LLM 设置", "action toast 给出「打开 LLM 设置」入口");
    atAction.click();
    await sleep(20);
    assert.ok(document.querySelector(".neo-director-llm-overlay"), "点 action 才打开 LLM 配置弹窗");
    document.querySelector(".neo-director-llm-close").click();   // 关闭以保持后续断言干净
    await sleep(20);

    // 成功路径：逐段返回 → 每生成一段立即写回并刷新对照表（能看到进展）
    optMode = { success: true, prompt: "integrated_multimodal_description: [Shot 1] 段一…" };
    document.querySelector(".neo-director-optimize").click();
    await sleep(100);
    const tas2 = Array.from(document.querySelectorAll(".neo-director-prompt"));
    assert.equal(tas2[0].value, "integrated_multimodal_description: [Shot 1] 段一…", "第 1 段写回");
    assert.equal(tas2[1].value, "integrated_multimodal_description: [Shot 1] 段一…", "第 2 段写回（同一 mock）");
    assert.ok(document.querySelector(".neo-director-opt-status").textContent.includes("已生成 2 段"), "状态显示完成段数");

    // 「📖 故事板分镜」页两栏对照：左 = 该段分镜图（宫格各格），右 = 该段提示词
    const setupItems = Array.from(document.querySelectorAll(".neo-director-setup-segs .neo-director-story-seg-item"));
    assert.equal(setupItems.length, 2, "本页显示 2 段");
    let cells = setupItems[0].querySelectorAll(".neo-director-setup-seg-cols > div");
    assert.equal(cells.length, 2, "两列：分镜图 / 提示词");
    assert.ok(cells[0].querySelector("img")?.src.includes("p0.png"), "左列是该段分镜图");
    assert.equal(cells[1].textContent, "integrated_multimodal_description: [Shot 1] 段一…", "右列是该段提示词");

    // 「各段对照」标题行：优化按钮与标题同行（不独占一行）
    const optRow = document.querySelector(".neo-director-pane-story .neo-director-setup-opt");
    assert.ok(optRow.querySelector(".neo-director-optimize"), "优化按钮在「各段对照」标题行内");
    assert.ok(optRow.querySelector(".neo-director-story-segs-title"), "标题行内保留「各段对照」标题");

    // 重新点生成：请求仍基于首次快照的原文；提示词列更新为最新结果
    optMode = { success: true, prompt: "第二次生成 段一" };
    const reOptLen = optBodies.length;
    document.querySelector(".neo-director-optimize").click();
    await sleep(100);
    assert.deepEqual(optBodies[reOptLen], { prompt: "第一段原始", duration_sec: 5, mode: "f2v" }, "重新生成基于原文快照");
    cells = Array.from(document.querySelectorAll(".neo-director-setup-segs .neo-director-story-seg-item"))[0].querySelectorAll(".neo-director-setup-seg-cols > div");
    assert.equal(cells[1].textContent, "第二次生成 段一", "提示词列更新为最新结果");

    // r2v 模式：请求体携带各段自己的参考素材（单段 refs）
    const tlModeSel = document.querySelector(".neo-director-pane-timeline .neo-director-mode");
    tlModeSel.value = "r2v";
    tlModeSel.dispatchEvent(new Event("change"));
    await sleep(20);
    mockRoute("/upload/image", () => jsonResponse({ name: "opt_ref.png", subfolder: "", type: "input" }));
    const segRefImgRow = document.querySelectorAll(".neo-director-seg .neo-director-segref-row")[0];   // 第 1 段参考图组
    const refFileInput = segRefImgRow.querySelector("input[type=file]");
    refFileInput.click = () => {};   // 拦截 jsdom 文件选择器
    Object.defineProperty(refFileInput, "files", { value: [new File(["fake"], "opt.png", { type: "image/png" })], configurable: true });
    refFileInput.dispatchEvent(new Event("change"));
    await sleep(50);
    optMode = { success: true, prompt: "第三次 段一" };
    const r2vLen = optBodies.length;
    document.querySelector(".neo-director-optimize").click();
    await sleep(100);
    assert.deepEqual(optBodies[r2vLen], { prompt: "第一段原始", duration_sec: 5, mode: "r2v", refs: { images: ["opt_ref.png"] } }, "第 1 段携带自己的参考图");
    assert.deepEqual(optBodies[r2vLen + 1], { prompt: "第二段原始", duration_sec: 8, mode: "r2v" }, "第 2 段无参考素材不带 refs");

    // 保存：原文快照写入 setup.orig_prompts，重开后逐格生成仍基于它再试
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "OPT" }));
    document.querySelector(".neo-director-save").click();
    await sleep(60);
    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "发出保存请求");
    assert.deepEqual(saveCall.body.setup.orig_prompts, ["第一段原始", "第二段原始"], "原文快照写入 setup");
    assert.equal(saveCall.body.setup.opt_prompts, undefined, "优化结果不再单独落盘（提示词随段落落盘）");
    });

test("导演编辑器：打开旧配方回显各段对照（分镜图 / 提示词），旧 setup 快照不回显", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true, mode: "r2v" }]));

    await openDirectorEditor({
        name: "ECHO", shared: { mode: "r2v" },
        segments: [
            { skill_id: "sk-a", prompt: "场景A", duration_sec: 5, storyboard: "sb_a.png" },
            { skill_id: "sk-a", prompt: "场景B", duration_sec: 10, storyboard: "sb_b.png" },
        ],
        setup: { refs: { images: ["u1.png"] }, orig_prompts: ["场景A原文", "场景B原文"], opt_prompts: ["优化结果A", "优化结果B"] },
    });
    await sleep(60);

    // 「📖 故事板分镜」页两栏对照：左 = 该段落盘的分镜图，右 = 该段当前提示词
    Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜")).click();
    await sleep(20);
    const setupItems = Array.from(document.querySelectorAll(".neo-director-setup-segs .neo-director-story-seg-item"));
    assert.equal(setupItems.length, 2, "本页回显 2 段");
    const cells = setupItems[0].querySelectorAll(".neo-director-setup-seg-cols > div");
    assert.equal(cells.length, 2, "两列：分镜图 / 提示词");
    assert.ok(cells[0].querySelector("img")?.src.includes("sb_a.png"), "左列回显落盘的分镜图");
    assert.equal(cells[1].textContent, "场景A", "右列回显该段当前提示词");
    assert.ok(!setupItems[1].querySelectorAll(".neo-director-setup-seg-cols > div")[1].textContent.includes("优化结果B"), "旧 opt_prompts 不回显");

    // 统一参考素材区已移除：旧配方的 setup.refs 不再回显（参考素材到时间轴页逐段设置）
    assert.equal(document.querySelectorAll(".neo-director-pane-story .neo-director-refpick-item").length, 0, "本页无统一参考网格，旧 setup.refs 不回显");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：对照表分镜图列回退显示时间轴选的首帧（f2v），✕ 清首帧，非 f2v 不回退", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "FFFB", shared: { mode: "f2v" },
        segments: [
            { skill_id: "sk-a", prompt: "段一", duration_sec: 5, first_frame: "ff_a.png" },
            { skill_id: "sk-a", prompt: "段二", duration_sec: 5, first_frame: "ff_b.png" },
        ],
    });
    await sleep(60);

    const tabStory = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabStory.click();
    await sleep(20);

    // f2v：无关键帧但有首帧 → 分镜图列回退显示时间轴页选的首帧（切页即同步）
    const items = Array.from(document.querySelectorAll(".neo-director-setup-segs .neo-director-story-seg-item"));
    assert.equal(items.length, 2, "本页显示 2 段");
    const img0 = items[0].querySelector(".neo-director-setup-seg-thumb img");
    assert.ok(img0 && img0.src.includes("ff_a.png"), "第 1 段分镜图列回退显示首帧");
    assert.ok(items[1].querySelector(".neo-director-setup-seg-thumb img").src.includes("ff_b.png"), "第 2 段分镜图列回退显示首帧");

    // 悬停 ✕：显示的是首帧回退 → 点它清该段首帧（时间轴页槽位回空态），对照表列同步清空
    items[0].querySelector(".neo-director-setup-seg-sb-clear").click();
    await sleep(20);
    const ffSlot = document.querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb");
    assert.ok(ffSlot.classList.contains("neo-director-setup-seg-thumb-empty"), "清除后时间轴页首帧槽位回空态");
    const items2 = Array.from(document.querySelectorAll(".neo-director-setup-segs .neo-director-story-seg-item"));
    assert.ok(items2[0].querySelector(".neo-director-setup-seg-thumb").classList.contains("neo-director-setup-seg-thumb-empty"), "第 1 段对照表列回空态");

    // 全局切 r2v：首帧栏隐藏，残留首帧不再当分镜图显示（切走再切回故事页重渲）
    const modeSel = document.querySelector(".neo-director-pane-timeline .neo-director-mode");
    modeSel.value = "r2v";
    modeSel.dispatchEvent(new Event("change"));
    await sleep(20);
    const tabTl = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("分镜时间线"));
    tabTl.click();
    tabStory.click();
    await sleep(20);
    const items3 = Array.from(document.querySelectorAll(".neo-director-setup-segs .neo-director-story-seg-item"));
    assert.ok(!items3[1].querySelector(".neo-director-setup-seg-thumb img"), "r2v 模式下首帧不当分镜图显示");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

