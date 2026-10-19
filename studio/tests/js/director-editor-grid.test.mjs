// 导演编辑器「宫格分镜图 / Lightbox / LLM 配置 / 比例告警」：拆分卡片、缩略预览、保存前比例校验。
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

test("导演编辑器：👤 角色参考图缩略点击打开 Lightbox（←/→ 切换各张，✕ 移除不触发）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const existing = {
        name: "T-Char-LB",
        shared: { width: 1344, height: 768 },
        story: { characters: [{ filename: "char_a.png" }, { filename: "char_b.png" }] },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const tabStory = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabStory.click();
    await sleep(20);
    const charCard = document.querySelector(".neo-director-setup-char");
    assert.ok(!charCard.classList.contains("neo-director-setup-char-collapsed"), "已有角色图时默认展开");
    const tiles = Array.from(charCard.querySelectorAll(".neo-director-refpick-item"));
    assert.equal(tiles.length, 2, "两张角色参考图回显");

    // 点第 2 张缩略图 → 打开 Lightbox，各张在同一列表、从所点开始
    tiles[1].querySelector("img").click();
    await sleep(30);
    const lb = document.querySelector(".neo-lightbox");
    assert.ok(lb, "点击角色参考图打开 Lightbox");
    assert.equal(lb.querySelector(".neo-lightbox-counter").textContent, "2 / 2", "两张图在同一列表，从第 2 张开始");
    assert.match(String(lb.querySelector("img.neo-lightbox-media").src), /char_b\.png/, "当前显示所点图片");

    // ← 上一页 → 第 1 张
    lb.querySelector(".neo-lightbox-prev").click();
    await sleep(30);
    assert.equal(lb.querySelector(".neo-lightbox-counter").textContent, "1 / 2", "上一页回到第 1 张");
    assert.match(String(lb.querySelector("img.neo-lightbox-media").src), /char_a\.png/, "上一页显示第 1 张");

    lb.querySelector(".neo-lightbox-close").click();
    await sleep(20);
    assert.equal(document.querySelector(".neo-lightbox"), null, "Lightbox 正常关闭");

    // ✕ 移除按钮只移除素材，不触发 Lightbox
    tiles[0].querySelector(".neo-director-refpick-del").click();
    await sleep(20);
    assert.equal(document.querySelector(".neo-lightbox"), null, "✕ 未打开 Lightbox");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});


test("导演编辑器：🧩 宫格分镜图拆分卡片——自动/手动行列，拆分替换分段并回填首帧与分镜图，逐格 LLM 描述", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/upload/image", () => jsonResponse({ name: "grid_src.png", subfolder: "", type: "input" }));
    let splitBody = null;
    const panelNames = ["p0.png", "p1.png", "p2.png", "p3.png", "p4.png", "p5.png"];
    mockRoute("/rs_recipes/grid_split", (body) => {
        splitBody = body;
        return jsonResponse({
            success: true, rows: 2, cols: 3,
            panels: panelNames.map((n) => ({ filename: n, width: 160, height: 120 })),
            prompts: ["原宫格提示词一"],
        });
    });
    const descBodies = [];
    mockRoute("/rs_recipes/director_describe_panel", (body) => {
        descBodies.push(body);
        return sseResponse(['data: ' + JSON.stringify({ text: `描述 ${body.panel}` }), "data: [DONE]"]);
    });

    await openDirectorEditor({
        name: "GRID", shared: { mode: "t2v" },
        segments: [{ skill_id: "sk-a", prompt: "旧段", duration_sec: 5 }],
    });
    await sleep(60);
    Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜")).click();
    await sleep(20);

    const srcGroup = document.querySelector(".neo-director-src");
    const card = document.querySelector(".neo-director-src-card-grid");
    assert.ok(card, "宫格拆分卡片在「📖 故事板分镜」页");

    // 来源二选一：本配方有文字拆分段 → 默认逐段图片分镜（🎨 显示、宫格卡隐藏）；radio 行横排可切
    const sbCard = document.querySelector(".neo-director-setup-sb");
    assert.equal(sbCard.style.display, "", "默认逐段图片分镜：🎨 卡片显示");
    assert.equal(card.style.display, "none", "默认 🧩 宫格卡片隐藏");
    srcGroup.querySelector('input[value="grid"]').click();
    await sleep(20);
    assert.equal(card.style.display, "", "切到宫格：🧩 卡片显示");
    assert.equal(sbCard.style.display, "none", "切到宫格：🎨 卡片隐藏");

    assert.equal(card.querySelector(".neo-director-grid-manual").style.display, "none", "手动行列默认隐藏");
    const modeSel = card.querySelector(".neo-director-grid-mode");
    modeSel.value = "manual";
    modeSel.dispatchEvent(new Event("change"));
    assert.equal(card.querySelector(".neo-director-grid-manual").style.display, "flex", "手动模式显示行列输入");

    // 本地上传宫格图（file input 已融入图片输入区）→ 缩略回显
    const fileInput = card.querySelector(".neo-director-grid-src input[type=file]");
    assert.ok(fileInput, "宫格图片输入区内含隐藏 file input");
    Object.defineProperty(fileInput, "files", { value: [new File(["fake"], "grid_src.png", { type: "image/png" })], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    await sleep(40);
    assert.ok(card.querySelector(".neo-director-grid-src img")?.src.includes("grid_src.png"), "宫格图缩略回显");

    // 拆分（confirm 桩默认 true）→ 替换分段、各格回填首帧与分镜图记录，frame source 自动切到 grid
    card.querySelector(".neo-director-grid-split").click();
    await sleep(60);
    assert.deepEqual(splitBody, { filename: "grid_src.png", rows: 2, cols: 3 }, "手动模式带行列参数");
    const rows = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(rows.length, 6, "旧段被替换为 6 格");
    rows.forEach((row, i) => {
        const img = row.querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb img");
        assert.ok(img && img.src.includes(panelNames[i]), `第 ${i + 1} 格回填为首帧`);
        assert.equal(row.dataset.storyboard, panelNames[i], "分镜图记录为本格");
    });
    assert.equal(card.style.display, "", "拆分后保持宫格图来源（各格已作首帧/分镜图）");
    assert.ok(!card.querySelector(".neo-director-grid-desc"), "独立的「逐格描述」按钮已移除（并入生成所有分段提示词）");
    // 卡标题行右上角是本步动作组：切分方式（先定怎么切）+ 状态 + 「拆分到各段」，切分方式排在拆分按钮之前
    const srcDrop2 = card.querySelector(".neo-director-grid-src");
    const gridAct = card.querySelector(".neo-director-src-head .neo-director-step-act");
    assert.ok(gridAct && gridAct.contains(card.querySelector(".neo-director-grid-split")),
        "拆分按钮在卡标题行右上角（本步唯一动作）");
    assert.ok(gridAct.contains(card.querySelector(".neo-director-grid-mode")), "切分方式也在标题行动作组内");
    assert.deepEqual(Array.from(gridAct.querySelectorAll(".neo-director-grid-mode, .neo-director-grid-split"))
        .map((el) => (el.classList.contains("neo-director-grid-mode") ? "切分方式" : "拆分按钮")),
        ["切分方式", "拆分按钮"], "切分方式排在拆分按钮之前");
    assert.ok(!srcDrop2.contains(card.querySelector(".neo-director-grid-mode")), "切分方式不再留在源图区");
    assert.ok(!srcDrop2.contains(card.querySelector(".neo-director-grid-split")), "拆分按钮不在源图区里重复");
    // 拆分结果缩略条已移除（各段分镜图在「各段对照」逐格显示）；改为在「全局故事参考」处展示元信息里的提示词
    assert.equal(card.querySelector(".neo-director-grid-panels"), null, "不再重复列格子缩略条");
    const promptBox = card.querySelector(".neo-director-grid-prompts");
    assert.equal(promptBox.value, "原宫格提示词一", "默认是原宫格提示词（原宫格图元信息里的提示词）");
    // 全局故事参考可手动改写：改写内容随逐格描述请求下发
    promptBox.value = "改写后的全局故事参考";

    // 逐格 LLM 描述已并入「生成所有分段的提示词」：宫格空原文段按该段分镜图逐格描述（每格单独一次请求）
    document.querySelector(".neo-director-optimize").click();
    await sleep(150);
    assert.equal(descBodies.length, 6, "逐格循环：每格单独发一次单格描述请求");
    descBodies.forEach((b, i) => assert.equal(b.panel, panelNames[i], `第 ${i + 1} 次请求对应本格`));
    rows.forEach((row, i) => assert.equal(row.querySelector(".neo-director-prompt").value, `描述 ${panelNames[i]}`, `第 ${i + 1} 段提示词回填`));
    // 宫格上下文：每格带全片位置（第 i/6 段、2×3 行列）+ 原宫格提示词作故事上下文；承接上一段本轮结果
    descBodies.forEach((b, i) => {
        assert.equal(b.panel_index, i + 1, `第 ${i + 1} 次请求 panel_index`);
        assert.equal(b.panel_total, 6, "panel_total = 格子数");
        assert.equal(b.rows, 2, "宫格行数随请求下发");
        assert.equal(b.cols, 3, "宫格列数随请求下发");
        assert.deepEqual(b.grid_prompts, ["改写后的全局故事参考"], "手动改写的全局故事参考随请求下发");
    });
    assert.equal(descBodies[0].prev_prompt, "", "第 1 段无上一段承接");
    assert.equal(descBodies[1].prev_prompt, "描述 p0.png", "第 2 段承接第 1 段本轮结果");

    // 宫格分镜图拆分：各段无「优化前」原文，对照表降为两栏（分镜图 / 提示词），不显示空的「优化前」列
    const setupItems = Array.from(document.querySelectorAll(".neo-director-setup-segs .neo-director-story-seg-item"));
    assert.equal(setupItems.length, 6, "本页回显 6 段");
    const gridCells = setupItems[0].querySelectorAll(".neo-director-setup-seg-cols > div");
    assert.equal(gridCells.length, 2, "宫格方式两列：分镜图 / 提示词");
    assert.equal(gridCells[1].textContent, `描述 ${panelNames[0]}`, "第二列为该段提示词，无空「优化前」占位");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

test("导演编辑器：宫格分镜图可直接拖入/上传到各段（跳过拆分），多张自动建段，无图段生成提示词时跳过", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    let upCount = 0;
    mockRoute("/upload/image", () => jsonResponse({ name: `frame_${upCount++}.png`, subfolder: "", type: "input" }));
    const descBodies = [];
    mockRoute("/rs_recipes/director_describe_panel", (body) => {
        descBodies.push(body);
        return sseResponse(['data: ' + JSON.stringify({ text: `描述 ${body.panel}` }), "data: [DONE]"]);
    });

    await openDirectorEditor(null); // 新建：1 个空段
    await sleep(60);
    Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜")).click();
    await sleep(20);

    // 新建配方默认宫格来源：对照表两栏（分镜图 / 提示词）
    const thumbs = Array.from(document.querySelectorAll(".neo-director-setup-segs .neo-director-setup-seg-thumb"));
    assert.ok(thumbs.length >= 1, "对照表有分镜图缩略位");
    assert.ok(thumbs[0].classList.contains("neo-director-setup-seg-thumb-empty"), "空段显示上传占位");

    // 拖入两张已拆分的分镜图到第 1 段 → 第 1 段绑定第 1 张，自动新增第 2 段绑定第 2 张
    const dt = { files: [new File(["a"], "a.png", { type: "image/png" }), new File(["b"], "b.png", { type: "image/png" })], getData: () => "" };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });
    thumbs[0].dispatchEvent(dropEv);
    await sleep(60);

    const rows = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(rows.length, 2, "拖入两张 → 自动新增一段（共 2 段）");
    assert.equal(rows[0].dataset.storyboard, "frame_0.png", "第 1 段分镜图 = 第 1 张");
    const img0 = rows[0].querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb img");
    assert.ok(img0 && img0.src.includes("frame_0.png"), "第 1 张回填为首帧");
    assert.equal(rows[1].dataset.storyboard, "frame_1.png", "自动新增段分镜图 = 第 2 张");

    // 清除第 2 段分镜图（悬停 ✕）→ 该段无图，生成提示词时应被跳过
    const items = Array.from(document.querySelectorAll(".neo-director-setup-segs .neo-director-story-seg-item"));
    items[1].querySelector(".neo-director-setup-seg-sb-clear").click();
    await sleep(40);
    const rows2 = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.ok(!rows2[1].dataset.storyboard, "第 2 段分镜图已清除");

    // 生成所有分段提示词：只对有分镜图的第 1 段逐格描述，跳过无图的第 2 段
    document.querySelector(".neo-director-optimize").click();
    await sleep(150);
    assert.equal(descBodies.length, 1, "只对有分镜图的第 1 段发描述请求，跳过无图段");
    rows2.forEach((row, i) => {
        const p = row.querySelector(".neo-director-prompt").value;
        if (i === 0) assert.equal(p, `描述 ${row.dataset.storyboard}`, "第 1 段提示词回填");
        else assert.equal(p, "", "无图段提示词保持为空");
    });

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：band-2 末尾常驻空段（纯 UI、不保存），拖入分镜图才真实建段", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/upload/image", () => jsonResponse({ name: "ghost_drop.png", subfolder: "", type: "input" }));

    await openDirectorEditor(null); // 新建：1 个空段
    await sleep(60);
    Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜")).click();
    await sleep(20);

    const container = document.querySelector(".neo-director-setup-segs");
    // 第一段还没有输入 → 不出现幻影行（常驻空段）
    assert.equal(container.querySelector(".neo-director-story-seg-ghost"), null, "第一段未输入时无常驻空段");

    // 给第一段输入提示词 → 常驻空段出现在末尾，且不是真实段（不进 segsWrap、无拖拽手柄）
    inputText(document.querySelector(".neo-director-seg .neo-director-prompt"), "第一段画面描述");
    const ghost = container.querySelector(".neo-director-story-seg-ghost");
    assert.ok(ghost, "第一段有输入后 band-2 末尾出现常驻空段");
    assert.equal(container.querySelectorAll(".neo-director-story-seg-ghost").length, 1, "只有一个常驻空段");
    assert.ok(!ghost.classList.contains("neo-director-seg"), "空段不是真实分段");
    assert.ok(!ghost.querySelector(".neo-director-story-seg-grip"), "空段无拖拽手柄（不参与排序）");
    const ghostThumb = ghost.querySelector(".neo-director-setup-seg-thumb");
    assert.ok(ghostThumb, "空段有分镜图缩略位（可拖入目标）");

    // 拖入一张分镜图到空段 → 真实新建一段并绑定该图
    const dt = { files: [new File(["a"], "a.png", { type: "image/png" })], getData: () => "" };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });
    ghostThumb.dispatchEvent(dropEv);
    await sleep(60);

    const rows = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(rows.length, 2, "拖入后真实段从 1 → 2");
    assert.equal(rows[1].dataset.storyboard, "ghost_drop.png", "新建段分镜图 = 拖入的图");
    // 刷新后空段仍在末尾，对照表只有 2 个真实段项
    assert.ok(container.querySelector(".neo-director-story-seg-ghost"), "刷新后空段仍在末尾");
    assert.equal(container.querySelectorAll(".neo-director-story-seg-item").length, 2, "对照表 2 个真实段项");

    // 点击上传（本地文件选择器）同样真实建段：对刷新后新出现的空段缩略位模拟 file input 上传
    const ghost2 = container.querySelector(".neo-director-story-seg-ghost");
    const ghostFileInput = ghost2.querySelector("input[type=file]");
    assert.ok(ghostFileInput, "空段缩略位含隐藏 file input（点击本地上传）");
    Object.defineProperty(ghostFileInput, "files", { value: [new File(["b"], "b.png", { type: "image/png" })], configurable: true });
    ghostFileInput.dispatchEvent(new Event("change"));
    await sleep(60);
    const rows2 = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(rows2.length, 3, "点击上传后真实段从 2 → 3");
    assert.equal(rows2[2].dataset.storyboard, "ghost_drop.png", "上传新建段绑定该图（upload 桩固定返回 ghost_drop.png）");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("宫格分镜图拆分：图片输入区支持本地上传 + 素材库/本地文件拖入", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/upload/image", () => jsonResponse({ name: "local_uploaded.png", subfolder: "", type: "input" }));
    mockRoute("/neo_gallery/copy_to_input", (body, call) => jsonResponse({ success: true, filename: `copied_${call.query.get("filename")}` }));

    await openDirectorEditor({ name: "GRID2", shared: { mode: "t2v" }, segments: [{ skill_id: "sk-a", prompt: "旧段", duration_sec: 5 }] });
    await sleep(60);
    Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜")).click();
    await sleep(20);

    const card = document.querySelector(".neo-director-src-card-grid");
    const drop = card.querySelector(".neo-director-grid-src");
    assert.ok(drop, "宫格图片输入区存在");
    assert.ok(drop.querySelector(".neo-director-grid-src-hint"), "空区显示上传提示");
    assert.ok(drop.querySelector("input[type=file]"), "输入区内含隐藏 file input（点击本地上传）");
    assert.equal(card.querySelector(".neo-director-local-add"), null, "宫格卡片不再单列「本地」按钮");
    assert.ok(!drop.classList.contains("has-src"), "无图时输入区无 has-src（操作条常显）");

    // 右下角操作条：「宫格素材库」在前、「+」在后；点素材库只切换侧栏、不触发输入区「本地上传」
    const actions = card.querySelector(".neo-director-grid-src-actions");
    assert.ok(actions, "输入区右下角有操作条");
    const kids = Array.from(actions.children);
    const libBtn = actions.querySelector(".neo-director-ff-lib");
    const plusBtn = actions.querySelector(".neo-director-storyboard-btn");
    assert.equal(kids[0], libBtn, "操作条第一个是「宫格素材库」");
    assert.equal(kids[1], plusBtn, "操作条第二个是「+」");

    // 「+」随角色参考图可用性联动：无图禁用，拖入角色图后启用
    assert.equal(plusBtn.disabled, true, "无角色参考图时「+」禁用");
    const charGrid = document.querySelector(".neo-director-story-refs .neo-director-refpick-grid");
    const charDt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"char_a.png","subfolder":""}' : "") };
    const charDropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(charDropEv, "dataTransfer", { value: charDt, configurable: true });
    charGrid.dispatchEvent(charDropEv);
    await sleep(40);
    assert.equal(plusBtn.disabled, false, "有角色参考图时「+」可用");

    const fileInput = drop.querySelector("input[type=file]");
    let fileClicks = 0;
    const origClick = fileInput.click.bind(fileInput);
    fileInput.click = () => { fileClicks++; };
    const tab = app.extensionManager.sidebarTab;
    libBtn.click();
    assert.equal(fileClicks, 0, "点「宫格素材库」不触发本地上传");
    assert.equal(tab.activeSidebarTabId, "neo.gallery", "点「宫格素材库」打开侧栏");
    fileInput.click = origClick;

    // 源图（左列）与提示词 textarea（右列）是卡 grid 的同一行，与上方标题行共享两列
    const promptBox = card.querySelector(".neo-director-grid-prompts");
    assert.ok(promptBox, "原宫格提示词文本框存在");
    assert.equal(drop.parentElement, card, "宫格图片输入区是卡 grid 左列");
    assert.equal(promptBox.readOnly, false, "可编辑为全局故事参考（默认原宫格提示词）");
    assert.equal(promptBox.value, "", "未拆分时不展示提示词");
    assert.equal(promptBox.closest("details"), null, "提示词常显（不再折叠，拆分提取后自动就地显示）");
    const headLabels = Array.from(card.querySelectorAll(".neo-director-src-head .neo-director-field-label")).map((el) => el.textContent);
    assert.ok(!headLabels.includes("分镜图"), "标题行不再有「分镜图」label");
    const heads = Array.from(card.querySelectorAll(".neo-director-src-head"));
    assert.equal(heads.length, 2, "标题行拆成两列");
    assert.ok(heads[0].textContent.includes("拆成分镜，分镜作首帧"), "左列是说明文字");
    assert.ok(heads[1].textContent.includes("全局故事参考（默认为原宫格提示词）"), "右列是「全局故事参考」label（与下方 textarea 同列对齐）");
    assert.equal(card.querySelector(".neo-director-grid-panels"), null, "格子缩略条已移除");
    assert.equal(card.querySelector(".neo-director-grid-pager"), null, "‹ / › 翻页按钮已随缩略条移除");
    assert.ok(card.querySelector(".neo-director-src-head .neo-director-grid-pt-copy"), "标题行 label 旁有复制按钮");

    // 换图（素材库拖入 / 本地拖入）后，上一张图提取到的提示词作废清空
    const copyBtn = card.querySelector(".neo-director-grid-pt-copy");
    promptBox.value = "上一张图的提示词";
    copyBtn.click();
    assert.ok(copyBtn.querySelector("svg path"), "复制按钮点击后换成图标反馈");

    // 素材库（Neo Gallery）拖入 → copy_to_input 落盘后回显（换图即清掉上一张图提取到的提示词）
    const dt = { files: [], getData: (t) => (t === "application/x-neo-gallery" ? JSON.stringify({ filename: "g.png", subfolder: "" }) : "") };
    const ev = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
    drop.dispatchEvent(ev);
    await sleep(40);
    assert.ok(drop.querySelector("img")?.src.includes("copied_g.png"), "素材库拖入回显");
    assert.equal(promptBox.value, "", "换图后提示词清空");
    assert.ok(drop.classList.contains("has-src"), "有图时输入区带 has-src（操作条 hover 才显示）");

    // OS 本地文件拖入 → upload 后回显（覆盖原图）
    dropFiles(drop, [makeFile("local_drop.png", "image/png")]);
    await sleep(40);
    assert.ok(drop.querySelector("img")?.src.includes("local_uploaded.png"), "本地文件拖入回显");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

test("标题栏右侧「🤖 LLM 配置」按钮：打开弹窗复用 LLM 表单，✕/Esc 关闭，脏改动出确认条", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_prompts/remote_llm_config", (body, call) =>
        call.method === "POST" ? jsonResponse({ success: true }) : jsonResponse({
            enabled: false,
            active_provider: "local",
            auto_unload_local: false,
            provider_list: [{ id: "local", name: "Local GGUF (llama.cpp)", type: "local" }],
            providers: { local: { models_dir: "" } },
        }));
    mockRoute("/rs_prompts/get_models", () => jsonResponse({ current_model: "", models: [] }));

    const existing = {
        name: "T",
        shared: { width: 1344, height: 768, seed: 0 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(40);

    // 🤖 按钮在标题栏右侧按钮组最左（⛶/✕ 之前）
    const titleBtns = Array.from(document.querySelector(".neo-director-title-btns").children);
    assert.ok(titleBtns[0].classList.contains("neo-director-llm-config"), "🤖 按钮在最左");

    // 点击打开弹窗：复用 LLM 表单（provider 下拉已填充）
    document.querySelector(".neo-director-llm-config").click();
    await sleep(40); // 等 load() 回填落定
    let overlay = document.querySelector(".neo-director-llm-overlay");
    assert.ok(overlay, "打开 LLM 配置弹窗");
    assert.ok(overlay.querySelector(".neo-director-llm-head"), "弹窗含标题栏");
    assert.ok(overlay.querySelector("#rs-remote-provider"), "复用 LLM 表单（provider 下拉）");

    // 重复点击不叠加
    document.querySelector(".neo-director-llm-config").click();
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-llm-overlay").length, 1, "重复点击不叠加");

    // 无改动：✕ 直接关、Esc 也能关
    overlay.querySelector(".neo-director-llm-close").click();
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-llm-overlay").length, 0, "无改动 ✕ 直接关");

    document.querySelector(".neo-director-llm-config").click();
    await sleep(40);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-llm-overlay").length, 0, "无改动 Esc 关闭");

    // 有未保存修改：✕ 出确认条；「放弃修改」关闭、不写盘
    document.querySelector(".neo-director-llm-config").click();
    await sleep(40);
    overlay = document.querySelector(".neo-director-llm-overlay");
    const unloadChk = overlay.querySelector("#rs-local-auto-unload");
    assert.ok(unloadChk, "本地 provider 显示自动卸载复选框");
    unloadChk.checked = true;   // 改一处（不触发异步）→ 脏
    overlay.querySelector(".neo-director-llm-close").click();
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-llm-overlay").length, 1, "有改动 ✕ 不关");
    const confirm = overlay.querySelector(".neo-director-llm-dirty");
    assert.equal(confirm.hidden, false, "确认条出现");
    overlay.querySelector(".neo-director-llm-btn-discard").click();
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-llm-overlay").length, 0, "放弃修改后关闭");

    // 清理：关编辑器
    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});




test("firstFrameAspectWarning：首帧比例一致返回 null，混用比例点名提示", async () => {
    const { firstFrameAspectWarning } = await import("../../web/director.js");
    // 全 1:1 → null
    assert.equal(
        firstFrameAspectWarning(
            [{ first_frame: "a.png" }, { first_frame: "b.png" }],
            [{ filename: "a.png", width: 800, height: 800 }, { filename: "b.png", width: 736, height: 736 }],
        ),
        null,
    );
    // 1:1 与 16:9 混用 → 点名两段；无首帧的段不计入
    const msg = firstFrameAspectWarning(
        [{ first_frame: "a.png" }, { first_frame: "b.png" }, { prompt: "无首帧" }],
        [{ filename: "a.png", width: 800, height: 800 }, { filename: "b.png", width: 1280, height: 720 }],
    );
    assert.ok(msg.includes("首帧图比例不一致"), msg);
    assert.ok(msg.includes("1:1 (方形)"), msg);
    assert.ok(msg.includes("16:9 (宽屏)"), msg);
    // sizes 缺某段尺寸 → 只算一组 → null
    assert.equal(
        firstFrameAspectWarning(
            [{ first_frame: "a.png" }, { first_frame: "b.png" }],
            [{ filename: "a.png", width: 800, height: 800 }],
        ),
        null,
    );
});

test("导演编辑器：宫格拆分后共享比例吸附到首帧最近预设（160×120 面板 → 4:3）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/upload/image", () => jsonResponse({ name: "grid_src.png", subfolder: "", type: "input" }));
    mockRoute("/rs_recipes/grid_split", () => jsonResponse({
        success: true, rows: 2, cols: 3,
        panels: ["p0.png", "p1.png", "p2.png", "p3.png", "p4.png", "p5.png"].map((n) => ({ filename: n, width: 160, height: 120 })),
    }));

    await openDirectorEditor({ name: "GRID-AR", shared: { mode: "t2v" }, segments: [{ skill_id: "sk-a", prompt: "旧段", duration_sec: 5 }] });
    await sleep(60);
    Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜")).click();
    await sleep(20);

    const card = document.querySelector(".neo-director-src-card-grid");
    const fileInput = card.querySelector(".neo-director-grid-src input[type=file]");
    Object.defineProperty(fileInput, "files", { value: [new File(["fake"], "grid_src.png", { type: "image/png" })], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    await sleep(40);

    const aspectSel = document.querySelector(".neo-director-aspect");
    assert.equal(aspectSel.value, "16:9 (宽屏)", "拆分前默认 16:9");
    card.querySelector(".neo-director-grid-split").click();
    await sleep(60);

    assert.equal(aspectSel.value, "4:3 (标准)", "共享比例跟随 160×120 面板（4:3）");
    assert.equal(document.querySelector(".neo-director-mp").value, "0.5", "百万像素不因拆分改动");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

test("导演编辑器：保存时多段首帧比例不一致 → 调 image_sizes 并给出拉伸告警", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    let sizesBody = null;
    mockRoute("/rs_recipes/image_sizes", (body) => {
        sizesBody = body;
        return jsonResponse({ success: true, sizes: [
            { filename: "a.png", width: 800, height: 800 },
            { filename: "b.png", width: 1280, height: 720 },
        ] });
    });
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "MIX" }));

    await openDirectorEditor({
        name: "MIX", shared: { width: 1344, height: 768 },
        segments: [
            { skill_id: "sk-a", prompt: "p1", duration_sec: 5, first_frame: "a.png" },
            { skill_id: "sk-a", prompt: "p2", duration_sec: 5, first_frame: "b.png" },
        ],
    });
    await sleep(60);

    document.querySelector(".neo-director-save").click();
    await sleep(80);

    assert.ok(sizesBody, "保存时请求了 image_sizes");
    assert.deepEqual([...sizesBody.filenames].sort(), ["a.png", "b.png"], "请求带两段不同首帧名");
    const warn = appState.toasts.find((t) => t.severity === "warning" && (t.detail || "").includes("首帧图比例不一致"));
    assert.ok(warn, "给出首帧比例不一致告警");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

test("导演编辑器：分块秒数仅在统一技能支持多帧时显示", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-norm", name: "普通技能", gen_video: true, mode: "t2v" },
        { id: "sk-mf", name: "多帧技能", gen_video: true, mode: "t2v", multi_frame: true },
    ]));

    const existing = {
        name: "T",
        shared: { mode: "t2v", width: 1344, height: 768, seed: 0 },
        segments: [
            { skill_id: "sk-norm", prompt: "第一段", duration_sec: 5 },
            { skill_id: "sk-norm", prompt: "第二段", duration_sec: 5 },
        ],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const gSkillSel = document.querySelector(".neo-director-global-skill");
    assert.ok(gSkillSel, "统一技能选择器存在");
    const chunkInp = document.querySelector(".neo-director-chunk-sec");
    assert.ok(chunkInp, "分块秒数输入框存在");
    const chunkLabel = Array.from(document.querySelectorAll(".neo-director-shared label"))
        .find((l) => l.textContent === "分块秒数");
    assert.ok(chunkLabel, "分块秒数标签存在");

    // 默认（普通技能）→ 隐藏：用户不该看到突然出现的分块秒数
    assert.equal(gSkillSel.value, "sk-norm", "初始统一技能为普通技能");
    assert.equal(chunkInp.style.display, "none", "非多帧技能：分块秒数输入框隐藏");
    assert.equal(chunkLabel.style.display, "none", "非多帧技能：分块秒数标签隐藏");

    // 切到多帧技能 → 显示
    gSkillSel.value = "sk-mf";
    gSkillSel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(20);
    assert.equal(chunkInp.style.display, "", "多帧技能：分块秒数输入框显示");
    assert.equal(chunkLabel.style.display, "", "多帧技能：分块秒数标签显示");

    // 再切回普通技能 → 重新隐藏
    gSkillSel.value = "sk-norm";
    gSkillSel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(20);
    assert.equal(chunkInp.style.display, "none", "切回非多帧技能：分块秒数重新隐藏");

    // 单段不分块：没有可合并的第二段，多帧技能也不出现（单段配方只留「一段的时间线」）
    gSkillSel.value = "sk-mf";
    gSkillSel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(20);
    [...document.querySelectorAll(".neo-director-seg-del")].pop().click();   // 删掉第二段
    await sleep(20);
    assert.equal(chunkInp.style.display, "none", "单段：多帧技能也不显示分块秒数");
    assert.equal(chunkLabel.style.display, "none", "单段：标签一并隐藏");
    document.querySelector(".neo-director-add").click();                     // 加回一段
    await sleep(20);
    assert.equal(chunkInp.style.display, "", "回到多段：分块秒数重新出现");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

test("导演编辑器：r2v 多帧技能不泄漏进 f2v 候选池，切 r2v 模式后可选", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-t2v", name: "文生", gen_video: true, mode: "t2v" },
        { id: "sk-mf", name: "多帧(帧)", gen_video: true, mode: "t2v", multi_frame: true },
        { id: "sk-r2v", name: "参考生", gen_video: true, mode: "r2v", multi_frame: true },
    ]));

    const existing = {
        name: "T",
        shared: { mode: "t2v", width: 1344, height: 768, seed: 0 },
        segments: [{ skill_id: "sk-t2v", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const gSkillSel = document.querySelector(".neo-director-global-skill");
    const modeSel = document.querySelector(".neo-director-mode");
    assert.ok(gSkillSel && modeSel, "统一技能与模式选择器存在");
    const opts = () => Array.from(gSkillSel.options).map((o) => o.value);

    // t2v 模式：帧技能 + 帧多帧技能，不含 r2v 技能（避免把参考生视频塞进文生段）
    assert.deepEqual(opts().sort(), ["sk-mf", "sk-t2v"].sort(), "t2v 候选池不含 r2v 技能");

    // 切到 r2v → 只有 r2v 技能
    modeSel.value = "r2v";
    modeSel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(30);
    assert.deepEqual(opts(), ["sk-r2v"], "r2v 候选池只含 r2v 技能");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});
