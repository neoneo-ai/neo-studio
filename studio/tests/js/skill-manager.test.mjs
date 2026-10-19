// 统一技能管理窗口（顶栏 🅝 菜单「🗂 技能管理」）：左侧技能列表（搜索 + 分类分组）+ 右侧内嵌详情。
// 覆盖：开窗布局 / 点击切换详情 / 搜索过滤 / 关闭整窗 / rs.skills.updated 刷新 / 未保存修改切换确认。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { resetEnv, mockRoute, mockObjectInfo, clearRoutes, jsonResponse, flush, sleep, click, inputText, fire, keydown, setConfirmAnswer, dialogs, window, fetchLog } from "./setup.mjs";
import { appState, app } from "./mocks/comfy-app.mjs";

const LEFT_W_KEY = "neo.skillManagerLeftWidth";

let skills;
beforeEach(() => {
    resetEnv();
    clearRoutes();
    skills = [
        { id: "preset_img", name: "Preset Image", cn_name: "预设生图", source: "presets", category: "image_gen" },
        { id: "custom_a", name: "Custom A", source: "custom", category: "" },
    ];
});

function mockSkills() {
    mockRoute("/rs_prompts/skills", () => jsonResponse(skills));
}
function mockLoadSkill() {
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "Preset Image", content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: false, gen_video: false, multi_turn: false, tags: [],
        category: skills.find((s) => s.id === b.id)?.category || "",
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
}

async function openMgr() {
    const { openSkillManager } = await import("../../web/skill.js");
    mockSkills();
    mockLoadSkill();
    openSkillManager();
    await flush();
    await sleep(50);
    return document.querySelector(".rs-skill-manager");
}
function closeMgr(box) {
    click(box.querySelector(".rs-skill-manager-head .rs-skill-modal-close"));
}

test("打开技能管理窗口：左侧列表按分类分组，右侧内嵌详情并默认选中默认展开分类的第一项", async () => {
    const box = await openMgr();
    assert.ok(box, "应创建 .rs-skill-manager 窗口");
    // 左侧列表：两条技能行 + 分类分组头
    const items = Array.from(box.querySelectorAll(".rs-skill-picker-item"));
    assert.equal(items.length, 2, "左侧应有 2 条技能行");
    assert.ok(box.querySelector(".rs-combo-category"), "应渲染分类分组头");
    // 右侧内嵌详情：.rs-skill-modal 挂在右面板内（非独立 overlay）
    const right = box.querySelector(".rs-skill-manager-right");
    const modal = right.querySelector(".rs-skill-modal");
    assert.ok(modal, "右侧应内嵌 .rs-skill-modal");
    assert.notEqual(modal.style.display, "none", "详情应可见（默认选中第一项）");
    // 默认选中「🖼️ 直接生图或编辑」分类（默认展开）的第一项，而非按分组名排序的列表首项
    const sel = box.querySelector(".rs-skill-picker-item.is-selected");
    assert.ok(sel && sel.textContent.includes("预设生图"), "默认应选中展开分类的第一项（预设生图）");
    const openCat = box.querySelector(".rs-skill-manager-cat.is-open");
    assert.ok(openCat && openCat.textContent.includes("直接生图或编辑"), "默认展开「直接生图或编辑」分类");
    closeMgr(box);
    await flush();
    assert.equal(document.querySelector(".rs-skill-manager"), null, "关闭后窗口移除");
});

test("点击列表项切换右侧详情（按 skill id 加载）", async () => {
    const { openSkillManager } = await import("../../web/skill.js");
    mockSkills();
    let loadedId = null;
    mockRoute("/rs_prompts/load_skill", (b) => {
        loadedId = b.id;
        return jsonResponse({ id: b.id, name: "Custom A", content: "body-a", files: [{ name: "skill.md", size: 6 }], gen_image: false, multi_turn: false, tags: [], category: "" });
    });
    openSkillManager();
    await flush();
    await sleep(50);

    const box = document.querySelector(".rs-skill-manager");
    const target = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes("Custom A"));
    assert.ok(target, "应找到 Custom A 行");
    click(target);
    await flush();
    await sleep(50);

    assert.equal(loadedId, "custom_a", "应按 skill id 加载详情");
    const sel = box.querySelector(".rs-skill-picker-item.is-selected");
    assert.ok(sel && sel.textContent.includes("Custom A"), "选中行应切到 Custom A");
    closeMgr(box);
});

test("搜索框过滤左侧列表", async () => {
    const box = await openMgr();
    const search = box.querySelector(".rs-skill-picker-search");
    inputText(search, "Custom");
    await flush();
    const items = Array.from(box.querySelectorAll(".rs-skill-picker-item"));
    assert.equal(items.length, 1, "搜索后应只剩 1 条");
    assert.ok(items[0].textContent.includes("Custom A"), "应命中 Custom A");
    closeMgr(box);
});

test("关闭整窗（✕）移除 overlay", async () => {
    const box = await openMgr();
    assert.ok(box, "窗口应已打开");
    closeMgr(box);
    await flush();
    assert.equal(document.querySelector(".rs-skill-manager"), null, "关闭后应移除窗口");
});

test("技能增删改广播 rs.skills.updated 自动刷新列表", async () => {
    const box = await openMgr();
    skills.push({ id: "custom_b", name: "Custom B", source: "custom", category: "" });
    document.dispatchEvent(new CustomEvent("rs.skills.updated"));
    await flush();
    await sleep(50);
    const items = Array.from(box.querySelectorAll(".rs-skill-picker-item"));
    assert.equal(items.length, 3, "广播后列表应刷新为 3 条");
    closeMgr(box);
});

test("有未保存修改时切换先出确认（取消则保持当前项）", async () => {
    const box = await openMgr();
    // 编辑正文 → 详情变脏
    const ta = box.querySelector(".rs-skill-modal .rs-tpl-content");
    assert.ok(ta, "应找到正文输入框");
    inputText(ta, "edited");
    setConfirmAnswer(false);   // 用户选择「继续编辑」
    const before = box.querySelector(".rs-skill-picker-item.is-selected").textContent;
    const target = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => !r.classList.contains("is-selected"));
    assert.ok(target, "应找到未选中的行");
    click(target);
    await flush();
    await sleep(50);
    assert.ok(dialogs.confirms.length > 0, "应弹出未保存确认");
    const after = box.querySelector(".rs-skill-picker-item.is-selected").textContent;
    assert.equal(after, before, "取消后选中项不变");
    closeMgr(box);
});

test("分类头点击折叠/展开其下技能", async () => {
    // 两个同分类（image_gen）+ 一个未分组，验证折叠只影响本组
    skills = [
        { id: "p1", name: "P1", source: "preset", category: "image_gen" },
        { id: "p2", name: "P2", source: "preset", category: "image_gen" },
        { id: "c1", name: "C1", source: "custom", category: "" },
    ];
    const box = await openMgr();
    const list = box.querySelector(".rs-skill-picker-list");
    assert.equal(list.querySelectorAll(".rs-skill-picker-item").length, 3, "初始应有 3 条技能行");
    const cat = list.querySelector(".rs-combo-category");
    assert.ok(cat, "应渲染分类分组头");
    click(cat);
    await flush();
    assert.equal(list.querySelectorAll(".rs-skill-picker-item").length, 1, "折叠后只剩未分组的 C1");
    click(cat);
    await flush();
    assert.equal(list.querySelectorAll(".rs-skill-picker-item").length, 3, "展开后恢复 3 条");
    closeMgr(box);
});
test("分类手风琴：默认只展开「生图」，展开别的分类自动收起前一个", async () => {
    skills = [
        { id: "g1", name: "Gen 1", source: "preset", category: "image_gen" },
        { id: "v1", name: "Vid 1", source: "preset", category: "video_gen" },
        { id: "e1", name: "Enh 1", source: "preset", category: "image_enhance" },
        { id: "c1", name: "C1", source: "custom", category: "" },
    ];
    const box = await openMgr();
    const list = box.querySelector(".rs-skill-picker-list");
    const labels = () => Array.from(list.querySelectorAll(".rs-skill-picker-item .rs-skill-picker-label")).map((r) => r.textContent.trim());
    const catOf = (text) => Array.from(list.querySelectorAll(".rs-combo-category")).find((c) => c.textContent.includes(text));
    const openCats = () => Array.from(list.querySelectorAll(".rs-combo-category.is-open"));

    assert.deepEqual(labels().sort(), ["C1", "Gen 1"], "首屏只展开「生图」，其余分类收起（未分组项无分类头，常显）");
    assert.equal(openCats().length, 1, "同时只有一个分类被标记为展开态");
    assert.ok(openCats()[0].textContent.includes("直接生图或编辑"), "展开态高亮在「生图」");

    click(catOf("生视频 (H3)"));
    await flush();
    assert.deepEqual(labels().sort(), ["C1", "Vid 1"], "展开生视频后「生图」被收起");
    assert.ok(openCats()[0].textContent.includes("生视频 (H3)"), "高亮随展开的分类一起切换");

    click(catOf("直接生图或编辑"));
    await flush();
    assert.deepEqual(labels().sort(), ["C1", "Gen 1"], "回到生图，生视频被收起");

    click(catOf("直接生图或编辑"));
    await flush();
    assert.deepEqual(labels().sort(), ["C1"], "点当前分类头收起它自己");
    assert.equal(openCats().length, 0, "全部收起后没有分类处于高亮态");

    click(catOf("图像提示词增强"));
    await flush();
    assert.deepEqual(labels().sort(), ["C1", "Enh 1"], "全部收起后点其它分类直接展开它");
    closeMgr(box);
});

test("task 分类技能在管理窗口隐藏，video_gen / custom 保持可见", async () => {
    skills = [
        { id: "task_a", name: "Task A", source: "tasks", category: "task" },
        { id: "video_a", name: "Video A", source: "presets", category: "video_gen" },
        { id: "custom_a", name: "Custom A", source: "custom", category: "" },
    ];
    const box = await openMgr();
    const labels = Array.from(box.querySelectorAll(".rs-skill-picker-item")).map((r) => r.textContent);
    assert.ok(!labels.some((t) => t.includes("Task A")), "task 技能应隐藏");
    assert.ok(labels.some((t) => t.includes("Video A")), "video_gen 技能应保持可见");
    assert.ok(labels.some((t) => t.includes("Custom A")), "custom 技能应保持可见");
    closeMgr(box);
});

test("左侧列表行内操作：预设行只有复制图标，自定义行有复制 + 删除图标", async () => {
    const box = await openMgr();
    const rowOf = (text) => Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes(text));
    const presetRow = rowOf("预设生图");
    const customRow = rowOf("Custom A");
    assert.equal(presetRow.querySelectorAll(".rs-skill-row-btn").length, 1, "预设行只给复制按钮（预设不可删）");
    assert.equal(customRow.querySelectorAll(".rs-skill-row-btn").length, 2, "自定义行给复制 + 删除");
    assert.ok(customRow.querySelector(".rs-skill-row-del"), "删除按钮带 .rs-skill-row-del（hover 淡入样式）");
    closeMgr(box);
});

test("行内复制图标：写为自定义副本并刷新列表、切到副本详情", async () => {
    const box = await openMgr();
    let saved = null;
    mockRoute("/rs_prompts/save_skill", (b) => {
        saved = b;
        skills.push({ id: b.id, name: b.name, source: "custom", category: "" });
        return jsonResponse({ success: true, id: b.id });
    });
    mockRoute("/neo_image_gen/copy_skill_files", () => jsonResponse({ success: true }));
    const row = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes("预设生图"));
    click(row.querySelector(".rs-skill-row-btn"));
    await flush();
    await sleep(50);

    assert.equal(saved.source, "custom", "副本写为自定义技能");
    assert.equal(saved.category, "image_gen", "保留源技能分类");
    assert.ok(saved.name.includes("(Copy)"), "副本名称加 (Copy) 后缀");
    const items = box.querySelectorAll(".rs-skill-picker-item");
    assert.equal(items.length, 3, "广播后列表刷新为 3 条");
    assert.ok(box.querySelector(".rs-skill-picker-item.is-selected").textContent.includes("(Copy)"), "右侧详情切到副本");
    closeMgr(box);
});

test("行内删除图标：确认后删除自定义技能并刷新列表", async () => {
    const box = await openMgr();
    let deleted = null;
    mockRoute("/rs_prompts/delete_skill", (b) => {
        deleted = b.id;
        skills = skills.filter((s) => s.id !== b.id);
        return jsonResponse({ success: true });
    });
    const row = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes("Custom A"));
    click(row.querySelector(".rs-skill-row-del"));
    await flush();
    await sleep(50);

    assert.equal(deleted, "custom_a", "按 skill id 删除");
    assert.equal(box.querySelectorAll(".rs-skill-picker-item").length, 1, "列表刷新为 1 条");
    closeMgr(box);
});

test("行内删除图标删除当前选中技能：右侧详情收起为占位提示", async () => {
    const box = await openMgr();
    mockRoute("/rs_prompts/delete_skill", (b) => {
        skills = skills.filter((s) => s.id !== b.id);
        return jsonResponse({ success: true });
    });
    const row = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes("Custom A"));
    click(row);                       // 先选中 Custom A，右侧显示其详情
    await flush();
    await sleep(50);
    assert.notEqual(box.querySelector(".rs-skill-manager-right .rs-skill-modal").style.display, "none", "详情已打开");

    click(row.querySelector(".rs-skill-row-del"));
    await flush();
    await sleep(50);
    assert.equal(box.querySelector(".rs-skill-manager-right .rs-skill-modal").style.display, "none", "被删技能的详情收起");
    assert.ok(!box.querySelector(".rs-skill-manager-empty").hidden, "占位提示恢复显示");
    closeMgr(box);
});

test("行内删除图标取消确认时不发请求", async () => {
    const box = await openMgr();
    setConfirmAnswer(false);
    mockRoute("/rs_prompts/delete_skill", () => jsonResponse({ success: true }));
    const row = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes("Custom A"));
    click(row.querySelector(".rs-skill-row-del"));
    await flush();
    await sleep(50);
    assert.ok(dialogs.confirms.some((m) => m.includes("Custom A")), "应弹出删除确认");
    assert.equal(box.querySelectorAll(".rs-skill-picker-item").length, 2, "取消后列表不变");
    closeMgr(box);
});

test("内嵌模式（Studio 技能页）：无 ✕ / 无「从画布」按钮，close() 移除根节点并清监听", async () => {
    const { createSkillManager } = await import("../../web/skill.js");
    mockSkills();
    mockLoadSkill();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const mgr = createSkillManager(host, { showClose: false, showCanvasBtn: false });
    await flush();
    await sleep(50);

    assert.ok(mgr.el.classList.contains("rs-skill-manager"), "根节点应为 .rs-skill-manager");
    assert.equal(mgr.closeBtn, null, "内嵌模式不应有 ✕");
    const btns = Array.from(mgr.el.querySelectorAll(".rs-skill-footer-btn")).map((b) => b.textContent);
    assert.ok(btns.some((t) => t.includes("新建")), "应保留「新建」按钮");
    assert.ok(!btns.some((t) => t.includes("从画布")), "内嵌模式不应有「从画布」按钮");
    assert.equal(mgr.el.querySelectorAll(".rs-skill-picker-item").length, 2, "列表应加载");

    // rs.skills.updated 仍刷新列表；close() 后清监听并移除根节点
    skills.push({ id: "custom_b", name: "Custom B", source: "custom", category: "" });
    document.dispatchEvent(new CustomEvent("rs.skills.updated"));
    await flush();
    await sleep(50);
    assert.equal(mgr.el.querySelectorAll(".rs-skill-picker-item").length, 3, "广播后列表应刷新为 3 条");
    mgr.close();
    assert.equal(host.querySelector(".rs-skill-manager"), null, "close() 应移除根节点");
});

// 拖拽分隔条改左栏宽度：jsdom 无布局，用 __rect 给出主体/左栏的可预测宽度
function dragSplit(split, fromX, toX, { bodyW = 1200, leftW = 300 } = {}) {
    const rect = (w) => ({ x: 0, y: 0, top: 0, left: 0, right: w, bottom: 800, width: w, height: 800 });
    split.parentElement.__rect = rect(bodyW);
    split.parentElement.querySelector(".rs-skill-manager-left").__rect = rect(leftW);
    split.dispatchEvent(new window.PointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: fromX, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 1, clientX: toX, bubbles: true }));
    document.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
}

test("左栏分隔条：拖拽调整宽度，松手记忆到 localStorage 并在重开窗口时沿用", async () => {
    localStorage.removeItem(LEFT_W_KEY);
    const box = await openMgr();
    const split = box.querySelector(".rs-skill-manager-split");
    const left = box.querySelector(".rs-skill-manager-left");
    assert.ok(split, "左右面板之间应有可拖拽分隔条");
    assert.equal(left.style.width, "", "首次开窗使用 CSS 默认宽度");

    dragSplit(split, 300, 420);
    assert.equal(left.style.width, "420px", "拖拽后左栏宽度跟随光标");
    assert.equal(localStorage.getItem(LEFT_W_KEY), "420px", "松手写入宽度记忆");

    closeMgr(box);
    const box2 = await openMgr();
    assert.equal(box2.querySelector(".rs-skill-manager-left").style.width, "420px", "重开窗口沿用上次宽度");
    closeMgr(box2);
    localStorage.removeItem(LEFT_W_KEY);
});

test("左栏宽度钳制在上下限之间；双击分隔条清除记忆回到默认宽度", async () => {
    localStorage.removeItem(LEFT_W_KEY);
    const box = await openMgr();
    const split = box.querySelector(".rs-skill-manager-split");
    const left = box.querySelector(".rs-skill-manager-left");

    dragSplit(split, 300, 40);
    assert.equal(left.style.width, "180px", "向左拖到底钳到左栏下限");
    dragSplit(split, 300, 1200, { bodyW: 1200, leftW: 180 });
    assert.equal(left.style.width, "880px", "向右拖到底钳到主体宽 - 右栏下限");
    assert.equal(localStorage.getItem(LEFT_W_KEY), "880px", "两次拖拽均落盘");

    fire(split, "dblclick");
    assert.equal(left.style.width, "", "双击回到 CSS 默认宽度");
    assert.equal(localStorage.getItem(LEFT_W_KEY), null, "双击清除宽度记忆");
    closeMgr(box);
});


// ================= 独立窗口控件（Director 风格）=================
// 无遮罩（透明 + 指针穿透）+ 标题栏拖动 + ⛶ 放大/还原 + 双击标题栏 + 右下角把手
const cssText = readFileSync(new URL("../../web/prompts.css", import.meta.url), "utf8");

function mouseAt(el, type, init = {}) {
    const Ctor = type.startsWith("pointer") ? window.PointerEvent : window.MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, ...init }));
}

async function openMgrWindow() {
    const { openSkillManager } = await import("../../web/skill.js");
    mockSkills();
    mockLoadSkill();
    openSkillManager();
    await flush();
    await sleep(50);
    const overlay = document.querySelector(".rs-skill-manager-overlay");
    return {
        overlay,
        box: overlay.querySelector(".rs-skill-manager"),
        head: overlay.querySelector(".rs-skill-manager-head"),
    };
}

test("独立窗口无遮罩：overlay 透明穿透，点窗口外不关闭；Esc 不关整窗，✕ 才关闭", async () => {
    const { overlay, box } = await openMgrWindow();
    assert.ok(overlay.classList.contains("rs-skill-manager-overlay"), "整窗 overlay 带独立窗口类");
    assert.ok(box, "窗口挂在 overlay 内");
    mouseAt(overlay, "pointerdown");
    assert.ok(document.body.contains(overlay), "点窗口外不应关闭");

    const seen = [];
    const keybind = (e) => seen.push(e.key);   // 模拟挂在 window 冒泡的 ComfyUI keybindHandler
    window.addEventListener("keydown", keybind);
    keydown(box, "Escape");
    assert.ok(document.body.contains(overlay), "Esc 不应关闭整窗");
    assert.deepEqual(seen, [], "窗口内的 Esc 不应打到主画布的退出子图");
    window.removeEventListener("keydown", keybind);

    closeMgr(box);
    assert.ok(!document.body.contains(overlay), "「✕」关闭整窗");
});

test("技能管理窗口 CSS：透明穿透 overlay、最小尺寸、标题栏与把手样式齐备", () => {
    assert.match(cssText, /\.rs-skill-modal-overlay\.rs-skill-manager-overlay\s*\{[^}]*background:\s*transparent;[^}]*pointer-events:\s*none;/);
    assert.match(cssText, /\.rs-skill-manager\s*\{[^}]*min-width:\s*640px;[^}]*min-height:\s*420px;/);
    assert.match(cssText, /\.rs-skill-manager-head\s*\{[^}]*cursor:\s*move;/);
    assert.match(cssText, /\.rs-skill-manager-resize\s*\{[^}]*cursor:\s*nwse-resize;/);
    assert.match(cssText, /\.rs-wf-editor-canvas-box\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;/);
});

test("标题栏 ⛶ 放大铺满视口（留 8px 边距），再点还原回放大前几何", async () => {
    const { box, head } = await openMgrWindow();
    const maxBtn = head.querySelector(".rs-skill-manager-maximize");
    assert.ok(maxBtn, "标题栏应有放大按钮");
    assert.equal(maxBtn.textContent, "⛶");
    click(maxBtn);
    assert.equal(box.style.width, "calc(100vw - 16px)");
    assert.equal(box.style.height, "calc(100vh - 16px)");
    assert.equal(box.style.left, "8px");
    assert.equal(maxBtn.textContent, "🗗");
    click(maxBtn);
    assert.equal(box.style.width, "", "还原回放大前宽度");
    assert.equal(box.style.height, "");
    assert.equal(maxBtn.textContent, "⛶");
    closeMgr(box);
});

test("双击标题栏放大 / 再双击还原（点按钮不触发）", async () => {
    const { box, head } = await openMgrWindow();
    mouseAt(head, "dblclick");
    assert.equal(box.style.height, "calc(100vh - 16px)", "双击标题栏应放大");
    mouseAt(head.querySelector(".rs-skill-manager-maximize"), "dblclick");
    assert.equal(box.style.height, "calc(100vh - 16px)", "双击按钮不应触发放大/还原");
    mouseAt(head, "dblclick");
    assert.equal(box.style.height, "", "再双击应还原");
    closeMgr(box);
});

test("标题栏拖动移动窗口，位置钳制在视口内", async () => {
    const { box, head } = await openMgrWindow();
    mouseAt(head, "pointerdown", { clientX: 100, clientY: 100 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 300, clientY: 200 }));
    assert.equal(box.style.left, "200px");
    assert.equal(box.style.top, "100px");
    window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 1 }));
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 900, clientY: 700 }));
    assert.equal(box.style.left, "200px", "松手后拖动应失效");

    mouseAt(head, "pointerdown", { clientX: 0, clientY: 0 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 4000, clientY: 4000 }));
    assert.equal(box.style.left, `${window.innerWidth - 80}px`, "向右拖到底钳到视口右缘");
    assert.equal(box.style.top, `${window.innerHeight - 44}px`, "向下拖到底钳到视口下缘");
    closeMgr(box);
});

test("标题栏按钮不触发拖动；放大态下标题栏拖动无效", async () => {
    const { box, head } = await openMgrWindow();
    mouseAt(head.querySelector(".rs-skill-manager-maximize"), "pointerdown", { clientX: 10, clientY: 10 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 300, clientY: 300 }));
    assert.equal(box.style.left, "", "从按钮按下不应开始拖动");

    click(head.querySelector(".rs-skill-manager-maximize"));
    mouseAt(head, "pointerdown", { clientX: 10, clientY: 10 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 300, clientY: 300 }));
    assert.equal(box.style.left, "8px", "放大态不应被拖动改位置");
    closeMgr(box);
});

test("右下角把手拖拽调整窗口尺寸，钳制最小尺寸", async () => {
    const { box } = await openMgrWindow();
    const grip = box.querySelector(".rs-skill-manager-resize");
    assert.ok(grip, "窗口应有右下角把手");
    mouseAt(grip, "pointerdown", { clientX: 500, clientY: 500 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 700, clientY: 620 }));
    assert.equal(box.style.width, "640px", "小于最小宽应钳到 640");
    assert.equal(box.style.height, "420px", "小于最小高应钳到 420");
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 1200, clientY: 1120 }));
    assert.equal(box.style.width, "700px");
    assert.equal(box.style.height, "620px");
    window.dispatchEvent(new window.PointerEvent("pointerup", { pointerId: 1 }));
    closeMgr(box);
});

// 手势被取消（pointercancel）或在页面外松手（页面收不到 pointerup）时，
// 拖拽监听器必须失效：否则窗口 / 左栏会在无按键状态下继续跟着鼠标跑
test("拖拽收尾：pointercancel 与缺失 pointerup 后不再跟随鼠标", async () => {
    const { box, head } = await openMgrWindow();
    const grip = box.querySelector(".rs-skill-manager-resize");

    mouseAt(grip, "pointerdown", { clientX: 500, clientY: 500 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 700, clientY: 620 }));
    window.dispatchEvent(new window.PointerEvent("pointercancel", { pointerId: 1 }));
    const size = [box.style.width, box.style.height];
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 1200, clientY: 1120 }));
    assert.deepEqual([box.style.width, box.style.height], size, "把手手势取消后尺寸应冻结");

    mouseAt(head, "pointerdown", { clientX: 100, clientY: 100 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 300, clientY: 200 }));
    window.dispatchEvent(new window.PointerEvent("pointercancel", { pointerId: 1 }));
    const pos = [box.style.left, box.style.top];
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 900, clientY: 700 }));
    assert.deepEqual([box.style.left, box.style.top], pos, "标题栏手势取消后位置应冻结");
    closeMgr(box);

    localStorage.removeItem(LEFT_W_KEY);
    const mgr = await openMgr();
    const split = mgr.querySelector(".rs-skill-manager-split");
    const left = mgr.querySelector(".rs-skill-manager-left");
    const rect = (w) => ({ x: 0, y: 0, top: 0, left: 0, right: w, bottom: 800, width: w, height: 800 });
    split.parentElement.__rect = rect(1200);
    left.__rect = rect(300);
    split.dispatchEvent(new window.PointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 300, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 1, clientX: 420, bubbles: true }));
    assert.equal(left.style.width, "420px");
    // 松手发生在页面外：页面只收到 pointercancel（无 pointerup），宽度必须停住
    document.dispatchEvent(new window.PointerEvent("pointercancel", { pointerId: 1 }));
    document.dispatchEvent(new window.PointerEvent("pointermove", { pointerId: 1, clientX: 700, bubbles: true }));
    assert.equal(left.style.width, "420px", "分隔条手势取消后宽度应冻结");
    assert.equal(document.body.classList.contains("rs-skill-resizing"), false, "取消后应清除拖拽光标");
    assert.equal(split.classList.contains("is-dragging"), false, "取消后应清除分隔条拖拽态");
    closeMgr(mgr);
    localStorage.removeItem(LEFT_W_KEY);
});

test("Studio 内嵌模式：不加放大按钮 / 把手 / 拖动，保持内嵌布局", async () => {
    const { createSkillManager } = await import("../../web/skill.js");
    mockSkills();
    mockLoadSkill();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const mgr = createSkillManager(host, { showClose: false, showCanvasBtn: false });
    await flush();
    await sleep(50);

    assert.equal(mgr.el.querySelector(".rs-skill-manager-maximize"), null, "内嵌模式不应有放大按钮");
    assert.equal(mgr.el.querySelector(".rs-skill-manager-resize"), null, "内嵌模式不应有把手");
    mouseAt(mgr.head, "pointerdown", { clientX: 10, clientY: 10 });
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 300, clientY: 300 }));
    assert.equal(mgr.el.style.left, "", "内嵌模式标题栏不应可拖动");
    assert.equal(mgr.el.parentNode, host, "根节点仍内嵌在宿主里");
    mgr.close();
});


// ================= 工作流区：内嵌 litegraph 编辑（无 LiteGraph 回落只读流程图） =================
const WF_TEMPLATE = {
    "1": { class_type: "NeoPromptAgent", inputs: { prompt: "{{PROMPT}}" }, _meta: { title: "Prompt" } },
    "2": { class_type: "KSampler", inputs: { seed: "{{SEED}}" }, _meta: { title: "Sampler" } },
};

// 内嵌编辑走真实 litegraph 加载路径（API prompt → litegraph 序列化 → configure / start / LGraphCanvas），
// 这里给最小可断言桩：LiteGraph.createNode 返回带 widget/槽位顺序的节点模板
function stubLiteGraph({ unregistered = [], byType = {} } = {}) {
    const created = { graphs: [], canvases: [], lite: [], searchBoxes: [] };
    class FakeGraph {
        constructor() { this._nodes = []; created.graphs.push(this); }
        configure(lite) {
            created.lite.push(lite);
            this._nodes = (lite.nodes || []).map((n) => ({ id: n.id, type: n.type, size: n.size, pos: n.pos, widgets_values: n.widgets_values, removed: false }));
        }
        removeNode(n) { n.removed = true; this._nodes = this._nodes.filter((x) => x !== n); }
        getNodeById(id) { return this._nodes.find((n) => String(n.id) === String(id)) || null; }
        start() { this.started = true; }
        clear() { this.cleared = true; }
    }
    class FakeCanvas {
        constructor(el, graph) {
            this.el = el;
            this.canvas = el;   // 真实 litegraph：canvas 元素挂在 .canvas 上
            this.graph = graph;
            this.ds = { scale: 1, offset: [0, 0] };
            this.ctx = { setTransform: (a) => { this.transform = a; } };
            this.selected_nodes = {};
            this.selectedItems = new Set();
            this.empty = false;
            this.viewport = [0, 0, 800, 600];
            FakeCanvas.active_canvas = this;   // 真实 litegraph 在 pointerdown 时抢 active_canvas
            created.canvases.push(this);
        }
        resize(w, h) { this.size = [w, h]; }
        setDirty() {}
        draw() { this.drawn = (this.drawn || 0) + 1; }
        stopRendering() { this.stopped = true; }
        unbindEvents() { this.unbound = true; }
        deleteSelected() {
            for (const n of [...this.selectedItems]) this.graph.removeNode(n);
            this.selectedItems.clear();
            this.selected_nodes = {};
        }
        selectItems() {
            for (const n of this.graph._nodes) { this.selectedItems.add(n); this.selected_nodes[n.id] = n; }
        }
        fitViewToSelectionAnimated() { this.fitted = (this.fitted || 0) + 1; }
        pasteFromClipboard() { this.pasted = (this.pasted || 0) + 1; }
        // 同前端 litegraph：showSearchBox(e, options)，选项由调用方传入，记录以断言内嵌画布的覆盖
        showSearchBox(e, options) {
            this.search_options = options;
            created.searchBoxes.push({ canvas: this, options });
        }
        // 同前端 litegraph：弹窗挂 canvas.parentNode，按「clientX - canvas 左上角」定位
        prompt(name, value, callback, event) {
            const dlg = document.createElement("div");
            dlg.className = "graphdialog";
            this.el.parentNode.appendChild(dlg);
            const rect = this.el.getBoundingClientRect();
            dlg.style.left = `${(event ? event.clientX : this.el.width * 0.5) - rect.left - 20}px`;
            dlg.style.top = `${(event ? event.clientY : 0) - rect.top - 20}px`;
            this.prompt_box = dlg;
        }
    }
    const LiteGraph = {
        NEVER: 2, ALWAYS: 0,
        createNode(type) {
            if (unregistered.includes(type)) return null;
            const tpl = byType[type] || {};
            const defaults = tpl.widgets_values || ["", 0];
            return {
                type, size: [210, 90], mode: 0, flags: {},
                // 真实 litegraph：createNode 只给出带默认值的 widgets，widgets_values 要 configure / serialize 才填
                widgets: (tpl.widgets || [{ name: "prompt" }, { name: "seed" }]).map((w, i) => ({ ...w, value: defaults[i] })),
                widgets_values: [],
                inputs: tpl.inputs || [{ name: "prompt", type: "STRING" }, { name: "seed", type: "INT" }],
                outputs: tpl.outputs || [{ name: "MODEL", type: "MODEL" }],
            };
        },
    };
    globalThis.LGraph = FakeGraph;
    globalThis.LGraphCanvas = FakeCanvas;
    globalThis.LiteGraph = LiteGraph;
    window.LGraph = FakeGraph;
    window.LGraphCanvas = FakeCanvas;
    window.LiteGraph = LiteGraph;
    return created;
}

function mockWfSkill({ id = "wf_demo", source = "custom", workflow = WF_TEMPLATE, config = {} } = {}) {
    skills = [{ id, name: "WF Skill", source, category: "image_gen", gen_image: true, gen_video: false }];
    mockRoute("/rs_prompts/skills", () => jsonResponse(skills));
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id, name: "WF Skill", content: "正文", source: b.source || source,
        files: [{ name: "skill.md", size: 4 }, ...(workflow ? [{ name: "workflow.json", size: 9 }] : [])],
        gen_image: true, gen_video: false, requires_ref: false, multi_turn: false, tags: [], category: "image_gen",
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "正文" }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ workflow }));
    mockRoute("/neo_image_gen/skill_config", () => jsonResponse(config));
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: ["m.safetensors"], suggested_diffusion_models: "m.safetensors",
        text_encoders: ["t.safetensors"], suggested_text_encoders: "t.safetensors",
        vae: ["v.safetensors"], suggested_vae: "v.safetensors", loras: [],
    }));
    mockObjectInfo({});
}

// 工作流区默认折叠：expand=true 时点头部展开（内嵌画布只在展开后挂载）
async function openMgrWf(opts, expand = true) {
    const { openSkillManager } = await import("../../web/skill.js");
    mockWfSkill(opts);
    openSkillManager();
    await flush();
    await sleep(120);
    await flush();
    const box = document.querySelector(".rs-skill-manager");
    const wf = box.querySelector(".rs-skill-workflow");
    if (expand) {
        click(wf.querySelector(".rs-skill-workflow-head"));
        await flush();
        await sleep(50);
    }
    return { box, wf };
}

const wfBarBtn = (wf, text) => Array.from(wf.querySelectorAll(".rs-wf-editor-bar button")).find((b) => b.textContent.includes(text));
// 保存工作流走「变更确认弹窗」：预览 mock + 点「💾 确认保存」
function mockWfPreview({ preset = false, structural = false } = {}) {
    mockRoute("/neo_image_gen/update_workflow_skill_preview", () =>
        jsonResponse({ success: true, id: "wf_demo", changes: [], warnings: [], gen_video: false, preset, structural }));
}
function clickWriteConfirm() {
    const dlg = document.querySelector(".rs-wf-write-confirm");
    const btn = dlg ? [...dlg.querySelectorAll(".rs-repair-foot button")].find((b) => b.textContent.includes("确认保存")) : null;
    if (btn) click(btn);
    return !!btn;
}

test("工作流区：无 LiteGraph 时回落只读流程图，无流程图/编辑切换按钮", async () => {
    const { box, wf } = await openMgrWf();
    assert.ok(wf, "带 workflow.json 的技能应渲染工作流区");
    assert.equal(wf.querySelectorAll(".rs-wf-mode-btns").length, 0, "不应有流程图 / 编辑切换按钮");
    assert.equal(wf.querySelector(".rs-wf-editor").style.display, "none", "无 LiteGraph 应回落只读流程图");
    closeMgr(box);
});

test("无 LiteGraph：默认折叠，展开回落只读流程图，折叠再展开重绘", async () => {
    const { box, wf } = await openMgrWf(undefined, false);
    const head = wf.querySelector(".rs-skill-workflow-head");
    assert.ok(wf.classList.contains("rs-wf-collapsed"), "无 LiteGraph 挂不上画布 → 工作流区应默认折叠");

    click(head);
    await flush();
    await sleep(50);
    assert.ok(!wf.classList.contains("rs-wf-collapsed"), "点标题应展开工作流区");
    assert.equal(wf.querySelector(".rs-wf-editor").style.display, "none", "无 LiteGraph 不应进编辑");
    assert.notEqual(wf.querySelector(".rs-wf-body").style.display, "none", "只读流程图区应可见");

    click(head);
    await flush();
    await sleep(50);
    assert.ok(wf.classList.contains("rs-wf-collapsed"), "再点标题应折叠工作流区");

    click(head);
    await flush();
    await sleep(50);
    assert.ok(wf.querySelector(".rs-wf-body").children.length > 0, "重新展开应重绘只读流程图");

    closeMgr(box);
});

test("内嵌编辑：打开默认折叠不挂画布，展开头部才挂 LGraphCanvas 并收起只读流程图", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf(undefined, false);
    assert.ok(wf.classList.contains("rs-wf-collapsed"), "打开技能不应展开工作流区");
    assert.equal(created.graphs.length, 0, "折叠态不应预挂内嵌画布");

    click(wf.querySelector(".rs-skill-workflow-head"));
    await flush();
    await sleep(50);

    assert.equal(created.graphs.length, 1, "展开应创建独立 LGraph 子图");
    assert.equal(created.canvases.length, 1, "应创建 LGraphCanvas");
    const lite = created.lite[0];
    assert.equal(lite.nodes.length, 2, "API prompt 应转成 litegraph 节点");
    assert.deepEqual(lite.nodes.map((n) => n.widgets_values), [["{{PROMPT}}", 0], ["", "{{SEED}}"]], "widget 值按名对齐模板顺序");
    // converter 默认把每个节点写成 pos [0,0]，必须按 canvasLayout 排开，否则内嵌画布上全叠在原点
    assert.equal(new Set(lite.nodes.map((n) => n.pos.join(","))).size, lite.nodes.length, "节点应按布局排开，不叠在同一位置");
    assert.equal(created.graphs[0].started, true, "子图应 start()");
    assert.equal(wf.querySelector(".rs-wf-editor").style.display, "flex", "编辑区应显示");
    assert.ok(wf.querySelector(".rs-wf-editor-canvas-box canvas.rs-wf-editor-canvas"), "canvas 应挂进盒子");
    assert.equal(wf.querySelector(".rs-wf-body").style.display, "none", "内嵌编辑收起只读流程图");
    assert.notEqual(wfBarBtn(wf, "保存工作流").style.display, "none", "自定义技能应显示保存按钮");
    closeMgr(box);
});

const WF_LORA_TEMPLATE = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" }, _meta: { title: "UNet" } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "{{LORA_1_NAME}}", strength_model: "{{LORA_1_STRENGTH}}" }, _meta: { title: "LoRA" } },
    "3": { class_type: "KSampler", inputs: { model: ["2", 0], seed: "{{SEED}}" }, _meta: { title: "Sampler" } },
};

test("内嵌编辑：LoRA 槽位 widget 按 config.loras 灌入（与只读预览 / 导入到画布同一套预渲染）", async () => {
    const created = stubLiteGraph({
        byType: { LoraLoaderModelOnly: { widgets: [{ name: "lora_name" }, { name: "strength_model" }], widgets_values: ["", 1] } },
    });
    const { box, wf } = await openMgrWf({
        workflow: WF_LORA_TEMPLATE,
        config: { model: "m.safetensors", loras: [{ name: "sub\\a.safetensors", strength: 0.66 }] },
    });
    const lora = created.lite[0].nodes.find((n) => n.type === "LoraLoaderModelOnly");
    assert.deepEqual(lora.widgets_values, ["sub\\a.safetensors", "0.66"],
        "LoRA 槽位应显示 config 里的路径与强度，不能留 {{LORA_i_*}} 原串");
    assert.equal(created.lite[0].nodes.find((n) => n.type === "KSampler").widgets_values[1], "{{SEED}}",
        "运行时变量仍原样保留（回写时后端重新占位符化）");
    closeMgr(box);
});

test("内嵌编辑：按 dpr 下发后备缓冲并重设前层变换（高分屏画布不被缩成一小块）", async () => {
    window.devicePixelRatio = 1.25;
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf();
    await flush();
    await sleep(50);
    // jsdom 无布局：盒子 clientWidth/Height 为 0，refit 走 800x420 兜底尺寸
    assert.deepEqual(created.canvases[0].size, [1000, 525], "resize 应收到 CSS 尺寸 × dpr");
    assert.equal(created.canvases[0].transform, 1.25, "前层 ctx 应按 dpr 重设变换");
    closeMgr(box);
    window.devicePixelRatio = 1;
});

test("内嵌编辑：widget 弹窗按视口坐标落点（画布在窗口里偏移时不飞到左上角）", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf();
    await flush();
    await sleep(50);
    const canvas = created.canvases[0];
    canvas.el.getBoundingClientRect = () => ({ left: 391, top: 415, width: 1119, height: 465, right: 1510, bottom: 880, x: 391, y: 415 });
    canvas.prompt("seed", 1, null, { clientX: 678, clientY: 684 });
    const dlg = canvas.prompt_box;
    assert.ok(dlg, "prompt 应生成弹窗");
    assert.equal(dlg.style.left, "658px", "弹窗应贴着鼠标（视口坐标），不应再减画布左上角偏移");
    assert.equal(dlg.style.top, "664px");
    closeMgr(box);
});


const WF_LINK_TEMPLATE = {
    "1": { class_type: "NeoPromptAgent", inputs: { prompt: "hi" }, _meta: { title: "A" } },
    "2": { class_type: "KSampler", inputs: { prompt: ["1", 0, "STRING"] }, _meta: { title: "B" } },
};

test("内嵌编辑：API 连线按槽位名转成 litegraph links", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf({ workflow: WF_LINK_TEMPLATE });
    await flush();
    await sleep(50);
    const lite = created.lite[0];
    assert.deepEqual(lite.links, [[1, 1, 0, 2, 0, "STRING"]], "连线应带 origin/slot/type");
    assert.equal(lite.nodes[1].inputs[0].link, 1, "目标输入槽应挂 link");
    assert.deepEqual(lite.nodes[0].outputs[0].links, [1], "源输出槽应登记 link");
    closeMgr(box);
});
// 画布导出 / 回写的模板节点 id 是 "193_82" 这类非数字串：Number() 出 NaN 会把所有节点挤成同一个 id
// （连线全接错），last_node_id = NaN 更会让 LiteGraph.configure 死循环卡死整页
const WF_TEXT_ID_TEMPLATE = {
    "193_16": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" } },
    "193_18": { class_type: "CLIPLoader", inputs: { clip_name: "{{TEXT_ENCODER}}" } },
    "193_51": { class_type: "CLIPTextEncode", inputs: { text: "{{PROMPT}}", clip: ["193_18", 0] } },
    "193_7": { class_type: "CLIPTextEncode", inputs: { text: "{{NEGATIVE}}", clip: ["193_18", 0] } },
    "193_86": { class_type: "KSampler", inputs: { seed: 1, model: ["193_16", 0], positive: ["193_51", 0], negative: ["193_7", 0] } },
};
const WF_TEXT_ID_SLOTS = {
    UNETLoader: { widgets: [{ name: "unet_name" }], inputs: [], outputs: [{ name: "MODEL", type: "MODEL" }] },
    CLIPLoader: { widgets: [{ name: "clip_name" }], inputs: [], outputs: [{ name: "CLIP", type: "CLIP" }] },
    CLIPTextEncode: { widgets: [{ name: "text" }], inputs: [{ name: "clip", type: "CLIP" }], outputs: [{ name: "CONDITIONING", type: "CONDITIONING" }] },
    KSampler: { widgets: [{ name: "seed" }], inputs: [{ name: "model", type: "MODEL" }, { name: "positive", type: "CONDITIONING" }, { name: "negative", type: "CONDITIONING" }], outputs: [{ name: "LATENT", type: "LATENT" }] },
};

test("内嵌编辑：非数字节点 id 模板映射成有限整数，连线按真实节点落位", async () => {
    const created = stubLiteGraph({ byType: WF_TEXT_ID_SLOTS });
    const { box, wf } = await openMgrWf({ workflow: WF_TEXT_ID_TEMPLATE });
    await flush();
    await sleep(50);
    const lite = created.lite[0];
    assert.ok(Number.isFinite(lite.last_node_id), "last_node_id 必须是有限数（NaN 会让 LiteGraph.configure 死循环）");
    const ids = lite.nodes.map((n) => n.id);
    assert.ok(ids.every((i) => Number.isInteger(i) && i > 0), "LiteGraph 节点 id 必须是正整数");
    assert.equal(new Set(ids).size, ids.length, "非数字模板 id 不能挤成同一个 id");
    assert.equal(lite.links.length, 5, "5 条连线应全部建立");
    const idSet = new Set(ids);
    assert.ok(lite.links.every((l) => idSet.has(l[1]) && idSet.has(l[3])), "连线两端必须指向真实节点");
    const sampler = lite.nodes.find((n) => n.type === "KSampler");
    const originOf = (name) => lite.links.find((l) => l[3] === sampler.id && l[4] === sampler.inputs.findIndex((s) => s.name === name))[1];
    assert.notEqual(originOf("positive"), originOf("negative"), "positive / negative 不能都接到同一个节点");
    closeMgr(box);
});



test("内嵌编辑：节点类型未注册时拒绝进编辑（保存会丢节点）", async () => {
    const created = stubLiteGraph({ unregistered: ["KSampler"] });
    const { box, wf } = await openMgrWf();
    await flush();
    await sleep(50);
    assert.equal(created.graphs.length, 0, "未注册节点不应挂载子图");
    assert.equal(wf.querySelector(".rs-wf-editor").style.display, "none", "应留在只读模式");
    closeMgr(box);
});


test("内嵌编辑保存：graphToPrompt(子图) → update_workflow_skill → 按新模板重挂画布", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf();
    let saved = null;
    mockWfPreview();
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        saved = b;
        return jsonResponse({ success: true, id: "wf_demo", warnings: [] });
    });
    appState.promptGraph = { output: { "1": { class_type: "KSampler", inputs: { seed: 7 } } }, workflow: { "1": {} } };

    await flush();
    await sleep(50);
    click(wfBarBtn(wf, "保存工作流"));
    await flush();
    await sleep(120);
    await flush();

    assert.equal(saved, null, "确认前不应落盘");
    assert.ok(clickWriteConfirm(), "保存工作流应弹变更确认弹窗");
    await flush();
    await sleep(120);
    await flush();

    assert.ok(saved, "应发出 /neo_image_gen/update_workflow_skill");
    assert.equal(saved.skill_id, "wf_demo");
    assert.deepEqual(saved.workflow, appState.promptGraph.output);
    assert.equal(appState.promptGraphArg, created.graphs[0], "graphToPrompt 应收到内嵌子图");
    assert.equal(created.canvases[0].stopped, true, "旧画布应停止渲染并解绑事件");
    assert.equal(created.canvases[0].unbound, true, "旧画布应解绑事件");
    assert.equal(created.graphs[0]._nodes.length, 0, "旧子图节点应逐个 removeNode 卸载");
    assert.equal(created.graphs[0].cleared, true, "旧子图应 clear()");
    assert.equal(created.canvases.length, 2, "保存后应按新模板重挂画布");
    assert.equal(wf.querySelector(".rs-wf-editor").style.display, "flex", "保存后仍是内嵌编辑");
    assert.ok(wf.querySelector(".rs-wf-editor-canvas-box canvas.rs-wf-editor-canvas"), "新画布应挂进盒子");
    closeMgr(box);
});

// 内嵌编辑按 config 初始化：模板里写死的旧值 / {{STEPS}} 由技能 config 覆盖，seed 等运行时变量不动，
// LoRA 槽位按 config.loras 灌路径与强度，超出模板槽位的 LoRA 动态注入
const WF_CFG_TEMPLATE = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "old.safetensors", weight_dtype: "default" }, _meta: { title: "M" } },
    "5": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0, "MODEL"], lora_name: "{{LORA_1_NAME}}", strength_model: "{{LORA_1_STRENGTH}}" }, _meta: { title: "LoRA" } },
    "2": { class_type: "EmptyLatentImage", inputs: { width: "1024", height: "1024", batch_size: "1" }, _meta: { title: "Latent" } },
    "3": { class_type: "KSampler", inputs: { model: ["5", 0, "MODEL"], seed: "{{SEED}}", steps: "{{STEPS}}", cfg: 7.0 }, _meta: { title: "Sampler" } },
    "4": { class_type: "SaveImage", inputs: { filename_prefix: "old_prefix" }, _meta: { title: "Save" } },
};
const WF_CFG_WIDGETS = {
    UNETLoader: { widgets: [{ name: "unet_name" }, { name: "weight_dtype" }], widgets_values: ["", "default"], outputs: [{ name: "MODEL", type: "MODEL" }] },
    LoraLoaderModelOnly: {
        widgets: [{ name: "lora_name" }, { name: "strength_model" }], widgets_values: ["", 1.0],
        inputs: [{ name: "model", type: "MODEL" }, { name: "lora_name", type: "STRING" }], outputs: [{ name: "MODEL", type: "MODEL" }],
    },
    EmptyLatentImage: { widgets: [{ name: "width" }, { name: "height" }, { name: "batch_size" }], widgets_values: [0, 0, 1] },
    KSampler: {
        widgets: [{ name: "seed" }, { name: "steps" }, { name: "cfg" }], widgets_values: [0, 20, 7],
        inputs: [{ name: "model", type: "MODEL" }, { name: "seed", type: "INT" }, { name: "steps", type: "INT" }, { name: "cfg", type: "FLOAT" }],
    },
    SaveImage: { widgets: [{ name: "filename_prefix" }], widgets_values: [""] },
};

test("内嵌编辑：widget 按技能 config 初始化（模型 / 尺寸 / 张数 / 步数 / 前缀），运行时 {{变量}} 保留、超槽位 LoRA 注入", async () => {
    const created = stubLiteGraph({ byType: WF_CFG_WIDGETS });
    const { box, wf } = await openMgrWf({
        workflow: WF_CFG_TEMPLATE,
        config: {
            model: "new.safetensors", steps: 30, count: 4, output_prefix: "neo_x",
            base_resolution: 1280, default_ratio: "1:1",
            loras: [{ name: "l1.safetensors", strength: 0.8 }, { name: "l2.safetensors", strength: 0.5 }],
        },
    });
    await flush();
    await sleep(50);

    const nodes = created.lite[0].nodes;
    const [model, latent, sampler, save, slot, extra] = nodes.map((n) => n.widgets_values);
    assert.equal(nodes.length, 6, "config 里超出模板槽位的 LoRA 应注入画布");
    assert.deepEqual(model, ["new.safetensors", "default"], "主模型灌 config.model，非 config 键位保持模板值");
    assert.deepEqual(latent, [1296, 1296, 4], "宽高按 base_resolution + 比例对齐 16，batch_size 灌 config.count");
    assert.deepEqual(sampler, ["{{SEED}}", 30, 7], "seed 属运行时变量保留，steps 灌 config.steps");
    assert.deepEqual(save, ["neo_x"], "输出前缀灌 config.output_prefix");
    assert.deepEqual(slot, ["l1.safetensors", "0.8"], "模板 LoRA 槽位灌 config.loras 的路径与强度");
    assert.deepEqual(extra, ["l2.safetensors", 0.5], "注入节点带 config 里超出槽位的 LoRA 名与强度");
    const samplerModelLink = created.lite[0].links.find((l) => l[3] === 3);
    assert.equal(samplerModelLink[1], 6, "KSampler 的 model 应改接到注入的 LoRA 节点");
    closeMgr(box);
});

test("内嵌编辑保存：回写后按新 config 重载设置区", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf();
    // 模拟后端回写：保存工作流后 config.json 变成画布落盘的新值，之后的读取返回新 config
    let cfg = { model: "a.safetensors", steps: 20 };
    mockRoute("/neo_image_gen/skill_config", () => jsonResponse(cfg));
    mockWfPreview();
    mockRoute("/neo_image_gen/update_workflow_skill", () => {
        cfg = { model: "b.safetensors", steps: 44 };
        return jsonResponse({ success: true, id: "wf_demo", warnings: [] });
    });
    appState.promptGraph = { output: { "1": { class_type: "KSampler", inputs: { seed: 7 } } }, workflow: { "1": {} } };

    await flush();
    await sleep(50);
    assert.equal(created.graphs.length, 1, "编辑模式应已挂载子图");
    click(wfBarBtn(wf, "保存工作流"));
    await flush();
    await sleep(120);
    await flush();
    assert.ok(clickWriteConfirm(), "保存工作流应弹变更确认弹窗");
    await flush();
    await sleep(120);
    await flush();

    const cfgCalls = fetchLog.filter((c) => c.path === "/neo_image_gen/skill_config").length;
    assert.ok(cfgCalls >= 2, `保存后应重新拉取 config.json（实际 ${cfgCalls} 次）`);
    const modal = box.querySelector(".rs-skill-modal");
    assert.equal(modal.querySelector(".rs-gen-model-section select").value, "b.safetensors", "主模型下拉应显示回写后的 config.model");
    assert.equal(modal.querySelector(".rs-gen-size-section input[type=number]").value, "44", "步数应显示回写后的 config.steps");
    closeMgr(box);
});

// 预设技能不可写 workflow.json：内嵌编辑改了结构 → 自动复制成自定义技能，工作流写进副本，详情切到副本
test("内嵌编辑保存：预设结构变更自动复制为自定义技能并切到副本", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf({ id: "preset_wf", source: "presets" });
    mockWfPreview({ preset: true, structural: true });
    const savedIds = [];
    mockRoute("/neo_image_gen/update_workflow_skill", (b) => {
        savedIds.push(b.skill_id);
        return jsonResponse({ success: true, id: b.skill_id, warnings: [] });
    });
    mockRoute("/rs_prompts/save_skill", (b) => jsonResponse({ success: true, id: b.id }));
    appState.promptGraph = { output: { "1": { class_type: "KSampler", inputs: { seed: 7 } } }, workflow: { "1": {} } };

    await flush();
    await sleep(50);
    click(wfBarBtn(wf, "保存工作流"));
    await flush();
    await sleep(120);
    assert.ok(clickWriteConfirm(), "保存工作流应弹变更确认弹窗");
    await flush();
    await sleep(200);
    await flush();

    assert.equal(savedIds.length, 2, `预设值写本地覆盖 + 结构写副本，共两次写入（实际 ${savedIds.length}）`);
    assert.equal(savedIds[0], "preset_wf", "第一写为预设的值覆盖");
    assert.ok(/^preset_wf_copy_\d+$/.test(savedIds[1]), `结构应写进新建副本：${savedIds[1]}`);
    assert.equal(box.querySelector(".rs-skill-modal .rs-skill-detail-badge").textContent, "USR", "详情应切到新建的自定义副本");
    assert.equal(created.canvases[0].stopped, true, "切到副本后应卸载内嵌画布");
    closeMgr(box);
});

test("内嵌编辑：预设技能保存按钮可用（结构变更自动复制）；重新载入重建子图；适配视图重绘画布", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf({ id: "preset_wf", source: "presets" });
    await flush();
    await sleep(50);
    const saveBtn = wfBarBtn(wf, "保存工作流");
    assert.notEqual(saveBtn.style.display, "none", "预设技能应显示保存按钮");
    assert.ok(saveBtn.title.includes("自动复制为自定义技能"), `预设保存按钮应说明结构变更自动复制：${saveBtn.title}`);

    click(wfBarBtn(wf, "重新载入"));
    await flush();
    await sleep(50);
    assert.equal(created.graphs.length, 2, "重新载入应重建子图");
    assert.equal(created.canvases.length, 2, "重新载入应重建画布");
    assert.equal(created.canvases[0].stopped, true, "旧画布应卸载");

    click(wfBarBtn(wf, "适配视图"));
    assert.ok(created.canvases[1].drawn > 0, "适配视图应触发重绘");
    closeMgr(box);
});

test("内嵌编辑：折叠工作流区 / 切换技能 / 关闭窗口均卸载画布", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf();
    await flush();
    await sleep(50);
    assert.equal(created.canvases.length, 1);

    click(wf.querySelector(".rs-skill-workflow-head"));
    await flush();
    await sleep(50);
    assert.equal(created.canvases[0].stopped, true, "折叠工作流区应卸载画布");
    assert.equal(wf.querySelector(".rs-wf-editor").style.display, "none");

    // 切到无工作流的技能：旧画布不残留，工作流区收起
    skills = [{ id: "other", name: "Other", source: "custom", category: "image_gen" }];
    mockRoute("/rs_prompts/load_skill", () => jsonResponse({
        id: "other", name: "Other", content: "正文", source: "custom",
        files: [{ name: "skill.md", size: 4 }], gen_image: false, gen_video: false,
        requires_ref: false, multi_turn: false, tags: [], category: "image_gen",
    }));
    click(box.querySelector(".rs-skill-picker-item"));
    await flush();
    await sleep(80);
    assert.equal(created.canvases.length, 1, "切换技能不应残留画布");
    assert.equal(created.canvases[0].stopped, true, "切换技能应卸载旧画布");

    closeMgr(box);
    assert.ok(!document.querySelector(".rs-skill-manager-overlay"), "关闭窗口应移除整窗");
});
test("内嵌编辑：折叠后展开重挂画布（卸载旧画布 → 新画布进编辑区）", async () => {
    const created = stubLiteGraph();
    const { box, wf } = await openMgrWf();
    await flush();
    await sleep(50);
    const head = wf.querySelector(".rs-skill-workflow-head");

    click(head);
    await flush();
    await sleep(50);
    assert.equal(created.canvases[0].stopped, true, "折叠应卸载画布");

    click(head);
    await flush();
    await sleep(50);
    assert.equal(created.canvases.length, 2, "展开应重挂画布");
    assert.equal(wf.querySelector(".rs-wf-editor").style.display, "flex", "展开应回到内嵌编辑");
    assert.equal(wf.querySelector(".rs-wf-body").style.display, "none", "重挂后收起只读流程图");

    closeMgr(box);
});

test("导入到画布：成功后关闭整个技能管理窗口（不遮挡画布），回写入口留在顶菜单", async () => {
    const menuBtn = document.createElement("button");
    menuBtn.className = "neo-n-menu-btn";
    document.body.appendChild(menuBtn);
    const { box, wf } = await openMgrWf();
    assert.ok(document.querySelector(".rs-skill-manager-overlay"), "导入前整窗应在场");
    const importBtn = wf.querySelector(".rs-wf-canvas-import-btn");
    assert.ok(importBtn, "内嵌详情应挂「⤒ 导入到画布」");
    click(importBtn);
    await flush();
    await sleep(120);
    await flush();
    assert.ok(!document.querySelector(".rs-skill-manager-overlay"), "导入成功后应关闭整个技能管理窗口");
    assert.ok(menuBtn.classList.contains("neo-writeback-hint"), "整窗关闭后 🅝 绿点仍在（顶菜单回写入口可用）");
});

test("技能名称在标题栏内行内编辑：点文字进入编辑，Enter 提交、Esc 还原为已保存名，只读技能不可改名", async () => {
    const { openSkillManager } = await import("../../web/skill.js");
    mockSkills();
    mockRoute("/rs_prompts/load_skill", (b) => jsonResponse({
        id: b.id,
        name: skills.find((s) => s.id === b.id)?.name || b.id,
        content: "body",
        files: [{ name: "skill.md", size: 5 }],
        gen_image: false, gen_video: false, multi_turn: false, tags: [],
        category: skills.find((s) => s.id === b.id)?.category || "",
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
    openSkillManager();
    await flush();
    await sleep(50);

    const box = document.querySelector(".rs-skill-manager");
    const wrap = box.querySelector(".rs-skill-modal .rs-skill-modal-header .rs-skill-name-wrap");
    assert.ok(wrap, "技能名称应在标题栏内（同导演编辑器配方名）");
    assert.equal(box.querySelectorAll(".rs-skill-modal .rs-tpl-name").length, 1, "名称输入框唯一（内容区不再单独一行）");
    const view = wrap.querySelector(".rs-skill-name-view");
    const inp = wrap.querySelector(".rs-skill-name-input");
    assert.equal(view.textContent, "Preset Image", "显示态回显当前技能名");
    assert.ok(!wrap.classList.contains("rs-skill-name-editing"), "默认非编辑态");

    // 预设（SYS）只读：点击不进入编辑
    click(view);
    assert.ok(!wrap.classList.contains("rs-skill-name-editing"), "只读技能不应进入编辑态");

    // 自定义技能：点文字进入编辑，Enter 提交
    const row = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => r.textContent.includes("Custom A"));
    click(row);
    await flush();
    await sleep(50);
    assert.equal(view.textContent, "Custom A", "切换后回显新技能名");
    click(view);
    assert.ok(wrap.classList.contains("rs-skill-name-editing"), "点击进入编辑态");
    inputText(inp, "Custom A2");
    keydown(inp, "Enter");
    assert.ok(!wrap.classList.contains("rs-skill-name-editing"), "Enter 提交后退出编辑态");
    assert.equal(view.textContent, "Custom A2", "提交后显示态更新为改名");

    // 未保存改名算脏：切换技能先出确认
    setConfirmAnswer(false);
    const other = Array.from(box.querySelectorAll(".rs-skill-picker-item")).find((r) => !r.classList.contains("is-selected"));
    click(other);
    await flush();
    await sleep(50);
    assert.ok(dialogs.confirms.length > 0, "改名未保存 → 切换先出确认");
    assert.ok(box.querySelector(".rs-skill-picker-item.is-selected").textContent.includes("Custom A"), "取消后仍停在改名中的技能");

    // Esc：还原为已保存名，且不顺带关闭整窗
    click(view);
    inputText(inp, "临时名");
    keydown(inp, "Escape");
    await flush();
    assert.ok(!wrap.classList.contains("rs-skill-name-editing"), "Esc 退出编辑态");
    assert.equal(view.textContent, "Custom A", "Esc 还原为已保存名");
    assert.ok(document.querySelector(".rs-skill-manager"), "名称输入框内的 Esc 不应关闭整窗");

    closeMgr(box);
});

// ================= 内嵌编辑键盘：复用主画布快捷键 + 拦住打到主画布的全局键 =================

test("内嵌编辑：canvas 可聚焦（tabindex=1），挂载后拿到焦点；关整窗后 active_canvas 还原给主画布", async () => {
    const created = stubLiteGraph();
    const mainCanvas = { name: "main-canvas" };
    app.canvas = mainCanvas;
    const { box, wf } = await openMgrWf(undefined, false);

    click(wf.querySelector(".rs-skill-workflow-head"));
    await flush();
    await sleep(50);

    const canvasEl = wf.querySelector(".rs-wf-editor-canvas-box canvas.rs-wf-editor-canvas");
    assert.equal(canvasEl.tabIndex, 1, "litegraph 把 keydown 绑在 canvas 元素上，canvas 必须可聚焦");
    assert.equal(document.activeElement, canvasEl, "挂载后内嵌画布应拿到焦点");
    assert.equal(window.LGraphCanvas.active_canvas, created.canvases[0], "内嵌画布挂载后是 active_canvas");

    closeMgr(box);
    await flush();
    await sleep(50);
    assert.equal(window.LGraphCanvas.active_canvas, mainCanvas, "关整窗必须卸载内嵌画布并还原 active_canvas");
    app.canvas = null;
});

test("内嵌编辑：画布快捷键作用在内嵌子图上，不打到主画布", async () => {
    const created = stubLiteGraph();
    const mainGraph = {
        _nodes: [{ id: 11, type: "LoadImage" }, { id: 12, type: "KSampler" }],
        removeNode(n) { this._nodes = this._nodes.filter((x) => x !== n); },
    };
    app.canvas = { graph: mainGraph, name: "main-canvas" };
    const { box, wf } = await openMgrWf(undefined, false);
    click(wf.querySelector(".rs-skill-workflow-head"));
    await flush();
    await sleep(50);

    const canvasEl = wf.querySelector(".rs-wf-editor-canvas-box canvas.rs-wf-editor-canvas");
    const wfCanvas = created.canvases[0];
    const wfGraph = created.graphs[created.graphs.length - 1];
    const target = wfGraph._nodes[0];

    // 选中内嵌图的节点后按 Delete：删的是内嵌子图，不是主画布（走全局命令会打到空主画布并提示「未选中任何内容」）
    wfCanvas.selectedItems.add(target);
    wfCanvas.selected_nodes[target.id] = target;
    keydown(canvasEl, "Delete");
    assert(!wfGraph._nodes.includes(target), "Delete 应删掉内嵌子图选中的节点");
    assert.equal(mainGraph._nodes.length, 2, "主画布节点不受影响");

    wfCanvas.selectItems();
    keydown(canvasEl, "m", { ctrlKey: true });
    assert.ok(wfGraph._nodes.every((n) => n.mode === window.LiteGraph.NEVER), "Ctrl+M 静音内嵌子图全部节点");
    keydown(canvasEl, "b", { ctrlKey: true });
    assert.ok(wfGraph._nodes.every((n) => n.mode === 4), "Ctrl+B 跳过内嵌子图全部节点");

    closeMgr(box);
    app.canvas = null;
});

test("弹窗打开时拦住会打到主画布的全局快捷键，画布类命令放行给内嵌画布", async () => {
    stubLiteGraph();
    const { createSkillDetailPopup } = await import("../../web/skill.js");
    mockWfSkill();
    const popup = createSkillDetailPopup();
    await popup.openExisting("wf_demo", "custom");
    await flush();
    await sleep(120);

    const modal = popup.overlay.querySelector(".rs-skill-detail");
    click(modal.querySelector(".rs-skill-workflow-head"));
    await flush();
    await sleep(50);
    const canvasEl = modal.querySelector(".rs-wf-editor-canvas-box canvas.rs-wf-editor-canvas");
    const ta = document.querySelector("textarea");   // 带 workflow.json 的技能正文区整体搬进文档浮窗，textarea 不在 modal 里

    const seen = [];
    const keybind = (e) => seen.push((e.ctrlKey ? "C" : "") + (e.altKey ? "A" : "") + e.key);   // 模拟挂在 window 冒泡的 ComfyUI keybindHandler
    window.addEventListener("keydown", keybind);

    for (const [key, init] of [["Enter", { ctrlKey: true }], ["s", { ctrlKey: true }], ["r", {}], ["w", {}], ["m", { altKey: true }]]) {
        keydown(modal, key, init);
    }
    assert.equal(seen.length, 0, "Ctrl+Enter / Ctrl+S / r / w / Alt+M 不应到达 window 上的 keybindHandler");

    for (const [key, init] of [["m", { ctrlKey: true }], ["Delete", {}], [".", {}], ["Escape", {}]]) {
        keydown(canvasEl, key, init);
    }
    keydown(ta, "Enter", { ctrlKey: true });
    assert.deepEqual(seen, ["Escape", "CEnter"], "画布类命令由内嵌画布就地消费，不应到达 window；画布上的 Esc 与输入框里的 Ctrl+Enter 必须放行");

    keydown(modal, "Escape");
    assert.deepEqual(seen, ["Escape", "CEnter"], "弹窗里的 Esc 不应打到主画布的退出子图");
    assert.equal(popup.overlay.style.display, "none", "Esc 关闭详情弹窗");

    window.removeEventListener("keydown", keybind);
});


test("内嵌编辑：搜索框关掉鼠标离开自动关闭（中文 IME 候选窗触发 pointerleave 会误关），主画布保持原设置", async () => {
    const created = stubLiteGraph();
    const { box } = await openMgrWf();
    const wfCanvas = created.canvases[0];

    // 前端 litegraph 把设置项合进选项交给 showSearchBox(e, options)：内嵌画布必须压掉鼠标离开自动关闭
    wfCanvas.showSearchBox(null, { hide_on_mouse_leave: true, show_all_on_open: true });
    assert.equal(wfCanvas.search_options.hide_on_mouse_leave, false, "内嵌画布搜索框不应因鼠标离开自动关闭");
    assert.equal(wfCanvas.search_options.show_all_on_open, true, "其余搜索框选项应原样保留");

    const mainCanvas = new window.LGraphCanvas(document.createElement("canvas"), new window.LGraph());
    mainCanvas.showSearchBox(null, { hide_on_mouse_leave: true });
    assert.equal(mainCanvas.search_options.hide_on_mouse_leave, true, "主画布搜索框的鼠标离开自动关闭不应被改动");

    closeMgr(box);
});

