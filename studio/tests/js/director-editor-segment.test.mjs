// 导演编辑器「只显示当前段」：默认显示第 1 段，点击时间轴块切换到对应段。
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

function mouse(type, x) {
    return new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });
}

test("导演编辑器：默认仅第 1 段有 current 标记，点击时间轴块切换当前段", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 无媒体候选
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
        { id: "sk-b", name: "技能 B", gen_video: true },
    ]));

    const existing = {
        name: "T",
        shared: { width: 1344, height: 768, seed: 0 },
        segments: [
            { skill_id: "sk-a", prompt: "第一段", duration_sec: 5 },
            { skill_id: "sk-b", prompt: "第二段", duration_sec: 5 },
        ],
    };
    await openDirectorEditor(existing);
    await sleep(60); // 等 rAF：时间轴拿到段数据

    const segs = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(segs.length, 2);
    const currentSegs = segs.filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(currentSegs.length, 1, "只显示当前一段");
    assert.equal(currentSegs[0], segs[0], "默认显示第 1 段");
    assert.equal(segs[0].querySelector(".neo-director-seg-title").textContent, "段 1");

    // 时间轴点击第 2 块 → current 切换到第 2 段
    const canvas = document.querySelector("canvas.neo-dtl-canvas");
    assert.ok(canvas, "时间轴 canvas 已创建");
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 92, width: 320, height: 92 };

    canvas.dispatchEvent(mouse("mousedown", 450)); // 块1（最小宽溢出后 [335,662]）内
    window.dispatchEvent(mouse("mouseup", 450));

    const after = Array.from(document.querySelectorAll(".neo-director-seg"));
    const currentAfter = after.filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(currentAfter.length, 1);
    assert.equal(currentAfter[0], after[1], "点击第 2 块后切换显示第 2 段");

    // 再点回第 1 块 → current 回到第 1 段
    canvas.dispatchEvent(mouse("mousedown", 100)); // 块0 [8,160] 内
    window.dispatchEvent(mouse("mouseup", 100));
    const currentBack = Array.from(document.querySelectorAll(".neo-director-seg"))
        .filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(currentBack.length, 1);
    assert.equal(currentBack[0], segs[0], "点击第 1 块后切回第 1 段");

    // 关闭编辑器：销毁时间轴（取消 rAF），避免测试结束后残留异步绘制
    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
    // eslint-disable-next-line no-unused-vars
    void segs;
});

test("时间轴说明行最右侧「拉伸」控制条：点按钮/拖滑块驱动 timeline.setZoom", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    const existing = {
        name: "T",
        shared: { width: 1344, height: 768, seed: 0 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    // 说明行：左侧文字 span + 最右侧「拉伸」控制条（↔ 拉伸 按钮 + 滑块）
    const label = document.querySelector(".neo-director-tl-label");
    assert.ok(label, "时间轴说明行存在");
    assert.ok(label.querySelector("span"), "说明行含文字 span");
    const zoomGroup = label.querySelector(".neo-director-zoom");
    assert.ok(zoomGroup, "说明行最右侧有「拉伸」控制条");
    const toggle = zoomGroup.querySelector(".neo-director-zoom-toggle");
    const slider = zoomGroup.querySelector(".neo-director-zoom-slider");
    assert.ok(toggle && toggle.textContent.includes("拉伸"), "🔍 拉伸按钮");
    assert.ok(slider && slider.type === "range", "滑块存在");

    // canvas 可视宽 320（供 setZoom 后按像素宽断言）
    const canvas = document.querySelector("canvas.neo-dtl-canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 92, width: 320, height: 92 };

    // 点「↔ 拉伸」→ zoom 1→2：滑块同步、canvas 按像素宽（自然宽 = max(可视宽, 默认总宽) = 326，×2）
    toggle.click();
    await sleep(60);
    assert.equal(slider.value, "2", "点按钮后滑块同步到 2");
    assert.equal(canvas.style.width, "652px", "zoom=2 canvas 按像素宽（自然宽 326×2）");

    // 拖滑块到 4 → zoom 跟随：canvas 自然宽 326×4
    slider.value = "4";
    slider.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(60);
    assert.equal(canvas.style.width, "1304px", "拖滑块到 4 → canvas 自然宽 326×4");

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("导演编辑器：添加段后自动切换到新段，删除当前段后切回前一段", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    await openDirectorEditor(null); // 新建：默认 1 个空段
    await sleep(60);

    const addBtn = document.querySelector(".neo-director-add");
    assert.ok(addBtn, "添加段按钮存在");
    addBtn.click();
    await sleep(20); // 添加后同步切换到新段（无异步，但时间轴 rAF 需让步）

    const segs = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(segs.length, 2);
    let current = segs.filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(current.length, 1);
    assert.equal(current[0], segs[1], "添加段后自动切换到新段");

    // 删除当前段（第 2 段）→ 切回第 1 段
    segs[1].querySelector(".neo-director-seg-del").click();
    const segsAfter = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(segsAfter.length, 1);
    current = segsAfter.filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(current.length, 1);
    assert.equal(current[0], segsAfter[0], "删除当前段后切回前一段");

    // 关闭编辑器：销毁时间轴（取消 rAF），避免测试结束后残留异步绘制
    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("首帧槽位：拖入素材设为首帧，悬停 ✕ 清除回空态", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    let copied = false;
    mockRoute("/neo_gallery/copy_to_input", (req) => {
        copied = true;
        return jsonResponse({ success: true, filename: "dragged.png" });
    });
    await openDirectorEditor(null); // 新建：默认 f2v，段行两栏帧行可见
    await sleep(60);

    const slot = document.querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb");
    assert.ok(slot, "首帧槽位存在");
    assert.ok(slot.classList.contains("neo-director-setup-seg-thumb-empty"), "初始为空态");

    // 拖入素材（gallery MIME）→ 设为首帧
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"dragged.png","subfolder":""}' : "") };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });
    slot.dispatchEvent(dropEv);
    await sleep(30);

    assert.ok(copied, "素材已请求 copy_to_input");
    const img = slot.querySelector("img");
    assert.ok(img && img.src.includes("dragged.png"), "首帧槽位显示拖入的素材");

    // 悬停 ✕ 清除 → 回空态
    slot.querySelector(".neo-director-setup-seg-sb-clear").click();
    await sleep(10);
    assert.ok(slot.classList.contains("neo-director-setup-seg-thumb-empty"), "清除后回到空态");

    // 清理
    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("素材直接拖到时间轴段块：落地并设为该段首帧（覆盖非当前段）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    let copied = false;
    mockRoute("/neo_gallery/copy_to_input", (req) => {
        copied = true;
        return jsonResponse({ success: true, filename: "dragged.png" });
    });

    const existing = {
        name: "T2",
        shared: { width: 1344, height: 768, seed: 0 },
        segments: [
            { skill_id: "sk-a", prompt: "第一段", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "第二段", duration_sec: 5 },
        ],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const canvas = document.querySelector("canvas.neo-dtl-canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 92, width: 320, height: 92 };

    // 拖到第 2 块（x=450，最小宽溢出后块1=[335,662]）；素材 MIME 携带 dragged.png
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"dragged.png","subfolder":""}' : "") };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "clientX", { value: 450, configurable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });
    canvas.dispatchEvent(dropEv);
    await sleep(30);

    assert.ok(copied, "素材已请求 copy_to_input");
    // 自动切换到第 2 段，且 dragged.png 成为该段首帧（槽位显示缩略图）
    const segRows = Array.from(document.querySelectorAll(".neo-director-seg"));
    const current = segRows.filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(current.length, 1);
    assert.equal(current[0], segRows[1], "拖放后切到第 2 段");
    const img = current[0].querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb img");
    assert.ok(img && img.src.includes("dragged.png"), "拖入的素材成为该段首帧");

    // 清理
    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("共享分辨率：旧配方 W/H 反推宽高比+百万像素；改 MP 更新显示；自定义切手输", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    const existing = {
        name: "T3",
        shared: { width: 1344, height: 768 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const aspectSel = document.querySelector(".neo-director-aspect");
    const mpInp = document.querySelector(".neo-director-mp");
    const resOut = document.querySelector(".neo-director-res");
    assert.ok(aspectSel && mpInp && resOut, "宽高比/百万像素/分辨率显示控件存在");
    // 1344×768 → 命中 16:9（±2%），反推百万像素取一位小数 ≈1.0，显示按 32 对齐重算
    assert.equal(aspectSel.value, "16:9 (宽屏)");
    assert.equal(mpInp.value, "1");
    assert.equal(resOut.textContent, "1376×768");

    // 改百万像素 → 显示按 32 对齐重算（16:9 @ 0.4 = 864×480）
    mpInp.value = "0.4";
    mpInp.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(resOut.textContent, "864×480");

    // 超出上限按一位小数钳制（3.57 → 2）
    mpInp.value = "3.57";
    mpInp.dispatchEvent(new window.Event("input", { bubbles: true }));
    // 16:9 @ 2.0：scale=sqrt(2*1048576/144)≈120.69 → 1920×1088
    assert.equal(resOut.textContent, "1920×1088");

    // 切「自定义」→ 显示清空、手输 W/H 行出现
    aspectSel.value = "自定义";
    aspectSel.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(resOut.textContent, "");
    const customRow = Array.from(document.querySelectorAll(".neo-director-shared"))
        .find(el => el.querySelector('input[placeholder="宽"]'));
    assert.ok(customRow, "自定义行存在");
    assert.notEqual(customRow.style.display, "none", "自定义行可见");

    // 种子输入框已移除
    assert.equal(document.querySelector(".neo-director-shared input[placeholder='种子']"), null);

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("共享分辨率：新建配方初始为 16:9 @ 百万像素 0.5（默认 960×544）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    await openDirectorEditor(null); // 新建：无 existing → 走默认分支
    await sleep(60);

    assert.equal(document.querySelector(".neo-director-aspect").value, "16:9 (宽屏)");
    assert.equal(document.querySelector(".neo-director-mp").value, "0.5", "新建配方百万像素初始 0.5");
    assert.equal(document.querySelector(".neo-director-res").textContent, "960×544", "按 32 对齐的默认分辨率");

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("共享分辨率：新建配方首帧预填时宽高比吸附到首帧最近预设（异步查询，像素不动）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    let sizesBody = null;
    mockRoute("/rs_recipes/image_sizes", (body) => {
        sizesBody = body;
        return jsonResponse({ success: true, sizes: [{ filename: "ff.png", width: 768, height: 1344 }] });
    });

    // 图库「新建导演配方」路径：未命名 + 首帧预填（竖屏 9:16）
    await openDirectorEditor({ name: "", shared: { mode: "f2v" }, segments: [{ first_frame: "ff.png", duration_sec: 5 }] });
    await sleep(80); // 等异步尺寸查询到达并应用

    assert.ok(sizesBody, "查了预填首帧的尺寸");
    assert.deepEqual(sizesBody.filenames, ["ff.png"]);
    assert.equal(document.querySelector(".neo-director-aspect").value, "9:16 (竖屏)", "比例吸附到首帧（竖屏图不落到横版）");
    assert.equal(document.querySelector(".neo-director-mp").value, "0.5", "百万像素保持默认，不按首帧面积改");
    assert.equal(document.querySelector(".neo-director-res").textContent, "544×960", "分辨率按新比例重算");

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("共享分辨率：非预设比例图片吸附到最近预设（1024×640 → 3:2，1000×1600 → 2:3）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    const SIZES = { "wide.png": { width: 1024, height: 640 }, "tall.png": { width: 1000, height: 1600 } };
    mockRoute("/rs_recipes/image_sizes", (body) => {
        const s = SIZES[body.filenames[0]];
        return jsonResponse({ success: true, sizes: [Object.assign({ filename: body.filenames[0] }, s)] });
    });

    for (const [file, label] of [["wide.png", "3:2 (横版照片)"], ["tall.png", "2:3 (竖版照片)"]]) {
        await openDirectorEditor({ name: "", shared: { mode: "f2v" }, segments: [{ first_frame: file, duration_sec: 5 }] });
        await sleep(60);
        assert.equal(document.querySelector(".neo-director-aspect").value, label, `${file} 吸附到最近预设 ${label}`);
        assert.equal(document.querySelector(".neo-director-mp").value, "0.5", `${file}：百万像素不动`);
        // 切「自定义」行不出现：绝不回落到自定义像素
        const customRow = Array.from(document.querySelectorAll(".neo-director-shared"))
            .find(el => el.querySelector('input[placeholder="宽"]'));
        assert.equal(customRow.style.display, "none", `${file}：仍在预设比例模式（未回落自定义）`);
        document.querySelector(".neo-director-close").click();
        await sleep(20);
    }
});


test("时间轴尾部 ＋ 直接添加新段并切换到该段", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    const existing = {
        name: "T4",
        shared: { width: 864, height: 480, aspect_ratio: "16:9 (宽屏)", megapixels: 0.4 },
        segments: [
            { skill_id: "sk-a", prompt: "第一段", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "第二段", duration_sec: 5 },
        ],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const canvas = document.querySelector("canvas.neo-dtl-canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
    canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 184, width: 320, height: 184 };

    // 默认总宽溢出后 W≈603：「＋」在 x∈[571,595]、y∈[88,112]（时间轴高度 184）
    const click = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    canvas.dispatchEvent(click("mousedown", 583, 100));

    const segs = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(segs.length, 3, "点击 ＋ 后新增一段");
    const current = segs.filter((s) => s.classList.contains("neo-director-seg-current"));
    assert.equal(current.length, 1);
    assert.equal(current[0], segs[2], "自动切换到新段");

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("标题栏拖动：mousedown 切绝对定位，mousemove 平移面板，mouseup 后停止；✕ 不触发", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    const existing = {
        name: "T-drag",
        shared: { width: 864, height: 480, aspect_ratio: "16:9 (宽屏)", megapixels: 0.4 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const titleBar = document.querySelector(".neo-director-title");
    const panel = document.querySelector(".neo-director-panel");
    assert.ok(titleBar && panel, "标题栏与面板已创建");

    // jsdom 无布局：桩一个可预测的居中矩形，供首次 mousedown 读取起点
    panel.__rect = { x: 100, y: 100, top: 100, left: 100, right: 880, bottom: 500, width: 780, height: 400 };
    const evt = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });

    // 在标题栏空白处按下（非 ✕）→ 切绝对定位并记录当前居中位置为起点
    titleBar.dispatchEvent(evt("mousedown", 300, 120));
    assert.equal(panel.style.position, "absolute", "首次拖动切到绝对定位");
    assert.equal(panel.style.left, "100px", "起点取当前 left");
    assert.equal(panel.style.top, "100px", "起点取当前 top");

    // 拖动：mousemove 按位移平移面板
    window.dispatchEvent(evt("mousemove", 350, 140));
    assert.equal(panel.style.left, "150px", "left 随位移更新");
    assert.equal(panel.style.top, "120px", "top 随位移更新");

    // 继续拖动：相对起点累计，不回跳
    window.dispatchEvent(evt("mousemove", 380, 150));
    assert.equal(panel.style.left, "180px", "left 相对起点累计");
    assert.equal(panel.style.top, "130px", "top 相对起点累计");

    // mouseup 结束：之后 mousemove 不再跟随
    window.dispatchEvent(evt("mouseup", 380, 150));
    window.dispatchEvent(evt("mousemove", 500, 200));
    assert.equal(panel.style.left, "180px", "松开后停止跟随（left）");
    assert.equal(panel.style.top, "130px", "松开后停止跟随（top）");

    // ✕ 按钮上的 mousedown 不触发拖动
    const closeBtn = document.querySelector(".neo-director-close");
    const beforeLeft = panel.style.left;
    closeBtn.dispatchEvent(evt("mousedown", 380, 150));
    window.dispatchEvent(evt("mousemove", 420, 190));
    assert.equal(panel.style.left, beforeLeft, "✕ 按钮不触发拖动");

    closeBtn.click();
    await sleep(20);
});

test("导演编辑器：右下角手柄拖拽缩放窗口，越界钳制在视口内", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    const existing = {
        name: "T-resize",
        shared: { width: 864, height: 480, aspect_ratio: "16:9 (宽屏)", megapixels: 0.4 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const panel = document.querySelector(".neo-director-panel");
    const handle = document.querySelector(".neo-director-resize");
    assert.ok(panel && handle, "面板与右下角缩放手柄已创建");

    // jsdom 无布局：桩出可预测的矩形 + 初始宽高，供 mousedown 读取起点(780×500)
    panel.__rect = { x: 100, y: 100, top: 100, left: 100, right: 880, bottom: 600, width: 780, height: 500 };
    Object.defineProperty(panel, "offsetWidth", { value: 780, configurable: true });
    Object.defineProperty(panel, "offsetHeight", { value: 500, configurable: true });

    const evt = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });

    // 在手柄按下 → 切绝对定位并记录起点
    handle.dispatchEvent(evt("mousedown", 860, 580));
    assert.equal(panel.style.position, "absolute", "首次缩放切到绝对定位");

    // 拖拽放大：width/height 随位移增长
    window.dispatchEvent(evt("mousemove", 960, 620));
    assert.equal(panel.style.width, "880px", "宽度随 dx=+100 增大");
    assert.equal(panel.style.height, "540px", "高度随 dy=+40 增大");

    // 继续拖：相对起点累计，不回跳
    window.dispatchEvent(evt("mousemove", 900, 600));
    assert.equal(panel.style.width, "820px", "宽度相对起点累计 (dx=+40)");
    assert.equal(panel.style.height, "520px", "高度相对起点累计 (dy=+20)");

    // mouseup 结束：之后 mousemove 不再跟随
    window.dispatchEvent(evt("mouseup", 900, 600));
    window.dispatchEvent(evt("mousemove", 1200, 900));
    assert.equal(panel.style.width, "820px", "松开后停止跟随（width）");
    assert.equal(panel.style.height, "520px", "松开后停止跟随（height）");

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("导演编辑器：标题栏 ⛶ 放大到最大，双击标题栏还原", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    await openDirectorEditor(null);
    await sleep(60);

    const titleBar = document.querySelector(".neo-director-title");
    const panel = document.querySelector(".neo-director-panel");
    const maxBtn = document.querySelector(".neo-director-maximize");
    assert.ok(titleBar && panel && maxBtn, "标题栏/面板/⛶ 按钮已创建");
    assert.equal(maxBtn.textContent, "⛶");

    // 放大：记录当前几何（桩矩形）→ 绝对定位铺满视口（留 8px 边距）
    panel.__rect = { x: 100, y: 80, top: 80, left: 100, right: 600, bottom: 480, width: 500, height: 400 };
    maxBtn.click();
    assert.equal(panel.style.position, "absolute", "放大时切到绝对定位");
    assert.equal(panel.style.left, "8px");
    assert.equal(panel.style.top, "8px");
    assert.equal(panel.style.width, (window.innerWidth - 16) + "px");
    assert.equal(panel.style.height, (window.innerHeight - 16) + "px");
    assert.ok(maxBtn.classList.contains("neo-director-maximized"), "放大态标记");

    // 双击标题栏 → 还原到放大前几何
    titleBar.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    assert.equal(panel.style.left, "100px");
    assert.equal(panel.style.top, "80px");
    assert.equal(panel.style.width, "500px");
    assert.equal(panel.style.height, "400px");
    assert.ok(!maxBtn.classList.contains("neo-director-maximized"), "还原后取消放大态");

    // 再点按钮 → 再次放大；双击按钮自身不触发切换
    maxBtn.click();
    assert.equal(panel.style.left, "8px", "按钮再点重新放大");
    maxBtn.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    assert.equal(panel.style.left, "8px", "双击按钮本体不切换（忽略按钮目标）");

    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);
});

test("标题栏配方名：默认直显文本、点击行内编辑（Enter/失焦提交、Esc 还原），名称区不触发拖动/最大化", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "T-renamed" }));

    const existing = {
        name: "T-name",
        shared: { width: 1344, height: 768 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const titleBar = document.querySelector(".neo-director-title");
    const wrap = titleBar.querySelector(".neo-director-name-wrap");
    assert.ok(wrap, "配方名在标题栏内");
    assert.equal(document.querySelectorAll(".neo-director-name").length, 1, "配方名输入框唯一（内容区不再重复一份）");
    const view = wrap.querySelector(".neo-director-name-view");
    const inp = wrap.querySelector(".neo-director-name");
    assert.equal(view.textContent, "T-name", "默认直接显示配方名");

    // 点击进入编辑：输入框出现并聚焦
    view.click();
    assert.ok(wrap.classList.contains("neo-director-name-editing"), "点击后进入编辑态");
    assert.equal(document.activeElement, inp, "编辑态自动聚焦输入框");

    // Enter 提交 → 退出编辑态并更新显示文本
    inp.value = "T-renamed";
    inp.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.ok(!wrap.classList.contains("neo-director-name-editing"), "Enter 后退出编辑态");
    assert.equal(view.textContent, "T-renamed", "显示文本随提交更新");

    // Esc 还原为打开时的配方名
    view.click();
    inp.value = "临时改的名";
    inp.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(inp.value, "T-name", "Esc 还原原配方名");
    assert.equal(view.textContent, "T-name", "Esc 后显示文本不变");

    // 失焦同样提交
    view.click();
    inp.value = "T-renamed";
    inp.dispatchEvent(new window.Event("blur"));
    assert.ok(!wrap.classList.contains("neo-director-name-editing"), "失焦后退出编辑态");
    assert.equal(view.textContent, "T-renamed", "失焦提交后更新显示文本");

    // 名称区按下 / 双击不触发标题栏拖动与最大化切换
    const panel = document.querySelector(".neo-director-panel");
    panel.__rect = { x: 100, y: 100, top: 100, left: 100, right: 880, bottom: 500, width: 780, height: 400 };
    const evt = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    view.dispatchEvent(evt("mousedown", 400, 120));
    window.dispatchEvent(evt("mousemove", 500, 160));
    assert.notEqual(panel.style.position, "absolute", "名称区按下不触发拖动");
    view.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    assert.notEqual(panel.style.left, "8px", "名称区双击不触发最大化");

    // 标题栏空白处仍可拖动
    titleBar.dispatchEvent(evt("mousedown", 120, 120));
    assert.equal(panel.style.position, "absolute", "标题栏空白处仍可拖动");
    window.dispatchEvent(evt("mouseup", 120, 120));

    // 保存取行内编辑后的名称
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "发出保存请求");
    assert.equal(saveCall.body.name, "T-renamed", "保存使用行内编辑后的名称");
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 0, "保存成功后窗口关闭");
});

test("标题栏配方名：新建（无名称）时显示占位文本，输入后去除占位样式", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor(null);
    await sleep(60);

    const view = document.querySelector(".neo-director-name-view");
    assert.equal(view.textContent, "未命名配方", "新建时显示占位名");
    assert.ok(view.classList.contains("neo-director-name-empty"), "占位名标记为空态");

    const wrap = document.querySelector(".neo-director-name-wrap");
    const inp = wrap.querySelector(".neo-director-name");
    view.click();
    inp.value = "  我的导演  ";
    inp.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(view.textContent, "我的导演", "提交时去掉首尾空格");
    assert.ok(!view.classList.contains("neo-director-name-empty"), "有名称后取消空态标记");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});


test("导演编辑器单例：同一配方重复点击忽略，另一配方重新加载，关闭后可重开", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    const existing = {
        name: "T-single",
        shared: { width: 1344, height: 768, seed: 0 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "首次打开创建浮层");

    // 同一配方重复点击 → 忽略，仍只有一个浮层、内容不变
    await openDirectorEditor(existing);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "同一配方重复点击不叠加");
    assert.equal(document.querySelector(".neo-director-name").value, "T-single", "内容保持原配方");

    // 另一配方 → 重新加载为该配方，仍只有一个浮层
    await openDirectorEditor({ name: "T-other", shared: {}, segments: [{ skill_id: "sk-a", prompt: "x", duration_sec: 5 }] });
    await sleep(20); // 等重载：关旧窗 + 重建新窗
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "重载后仍只有一个浮层");
    assert.equal(document.querySelector(".neo-director-name").value, "T-other", "重载为点击的配方");

    // 关闭后可再次打开
    document.querySelector(".neo-director-close").click();
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 0, "关闭后浮层移除");
    await openDirectorEditor(existing);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "关闭后可重新打开");
});

test("导演编辑器单例：新建（未命名）编辑器开着时再开新配方要重载，不被同名校验静默吞掉", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));

    // 首次新建（1 段）
    await openDirectorEditor({ name: "", shared: { mode: "f2v" }, segments: [{ first_frame: "a.png", duration_sec: 5 }] });
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "首次打开创建浮层");

    // 新建编辑器未关时再开另一个新配方（2 段）→ 重载为新内容，而不是被 name==='' 同名校验吞掉
    await openDirectorEditor({ name: "", shared: { mode: "f2v" }, segments: [
        { first_frame: "b.png", duration_sec: 5 },
        { first_frame: "c.png", duration_sec: 5 },
    ] });
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "重载后仍只有一个浮层");
    assert.equal(document.querySelectorAll(".neo-director-segs .neo-director-seg").length, 2, "重载为新配方的 2 段");

    // 新建编辑器有未保存修改时再开新配方 → 出确认条拦截，内容不变
    const promptTa = document.querySelector(".neo-director-prompt");
    promptTa.value = "未保存的改动";
    promptTa.dispatchEvent(new window.Event("input", { bubbles: true }));
    await openDirectorEditor({ name: "", shared: { mode: "f2v" }, segments: [{ first_frame: "d.png", duration_sec: 5 }] });
    await sleep(20);
    assert.equal(document.querySelector(".neo-director-dirty-confirm").hidden, false, "脏的新建编辑器被确认条拦截");
    assert.equal(document.querySelectorAll(".neo-director-segs .neo-director-seg").length, 2, "拦截后内容不变");

    document.querySelector(".neo-director-dirty-discard").click();
    await sleep(60);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "放弃修改后自动打开刚点的那份");
    assert.equal(document.querySelectorAll(".neo-director-segs .neo-director-seg").length, 1, "重载为刚点的 1 段配方");
});

test("导演编辑器：故事板分镜页两步徽标（① 宫格拆分 → ② 提示词）与动作按前置置灰", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor(null);   // 新建：1 个空段、无宫格图
    await sleep(60);
    Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜")).click();
    await sleep(20);
    const story = document.querySelector(".neo-director-pane-story");

    const badges = Array.from(story.querySelectorAll(".neo-director-step-badge"));
    assert.deepEqual(badges.map((b) => b.textContent), ["①", "②"], "两步徽标齐全且按序号排布");
    assert.equal(story.querySelector(".neo-director-src-card-grid .neo-director-src-head .neo-director-step-badge"), badges[0],
        "① 徽标在宫格卡标题行");
    assert.equal(story.querySelector(".neo-director-setup-opt > .neo-director-step-badge"), badges[1],
        "② 徽标在「各段对照」标题行");

    const states = () => badges.map((b) => (b.classList.contains("neo-director-step-done") ? "done"
        : b.classList.contains("neo-director-step-current") ? "current" : "todo"));
    const splitBtn = story.querySelector(".neo-director-grid-split");
    const optBtn = story.querySelector(".neo-director-optimize");

    // 还没选宫格图 → 两步都变淡（前置未完成）；两个动作都点不动，缺什么写在 title
    assert.deepEqual(states(), ["todo", "todo"], "新建无宫格图：两步都未就绪");
    assert.equal(splitBtn.disabled, true, "未选宫格图：拆分到各段置灰");
    assert.match(splitBtn.title, /宫格图/, "置灰原因写在 title");
    assert.equal(optBtn.disabled, true, "没有分镜图：生成所有分段的提示词置灰");
    splitBtn.click();   // 置灰按钮点不动（不报错、不发请求）
    await sleep(20);
    assert.ok(!fetchLog.some((c) => c.path === "/rs_recipes/grid_split"), "置灰的拆分按钮不发请求");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：宫格来源的分步状态——选图后 ① 当前、拆分后 ① 完成 ② 当前", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "grid.png" }));
    mockRoute("/rs_recipes/grid_split", () => jsonResponse({
        success: true, rows: 1, cols: 2,
        panels: [
            { filename: "p0.png", width: 512, height: 288 },
            { filename: "p1.png", width: 512, height: 288 },
        ],
        prompts: [],
    }));

    await openDirectorEditor(null); // 新建：宫格图是唯一来源
    await sleep(60);

    const story = document.querySelector(".neo-director-pane-story");
    const badges = Array.from(story.querySelectorAll(".neo-director-step-badge"));
    const states = () => badges.map((b) => (b.classList.contains("neo-director-step-done") ? "done"
        : b.classList.contains("neo-director-step-current") ? "current" : "todo"));
    const splitBtn = story.querySelector(".neo-director-grid-split");

    // 从素材库拖入宫格图 → ① 轮到拆分（当前），② 还要等分镜图
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"grid.png","subfolder":""}' : "") };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });
    story.querySelector(".neo-director-grid-src").dispatchEvent(dropEv);
    await sleep(40);
    assert.deepEqual(states(), ["current", "todo"], "选图后 ① 当前、② 仍等分镜图");
    assert.equal(splitBtn.disabled, false, "有宫格图 → 拆分到各段可用");

    // 拆分 → 各格都有分镜图：① 完成（✓）、② 轮到生成提示词
    splitBtn.click();
    await sleep(60);
    assert.equal(badges[0].textContent, "✓", "拆分完成显示对勾");
    assert.deepEqual(states(), ["done", "current"], "拆分后 ① 完成、② 当前");
    assert.equal(story.querySelector(".neo-director-optimize").disabled, false, "各格有分镜图 → 生成所有分段的提示词可用");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：尾帧走扩展按钮——展开出槽位、拖入设尾帧、按钮显示缩略指示", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "lastframe.png" }));

    await openDirectorEditor(null); // 新建：默认 f2v，尾帧扩展行可见
    await sleep(60);

    const lfRow = document.querySelector(".neo-director-seg .neo-director-lf-row");
    assert.ok(lfRow, "尾帧扩展行存在");
    const btn = lfRow.querySelector(".neo-director-lf-toggle");
    assert.ok(btn.textContent.includes("＋ 尾帧"), "默认收起态（＋ 尾帧）");
    const wrap = lfRow.querySelector(".neo-director-lf-slot-wrap");
    assert.equal(wrap.style.display, "none", "槽位默认隐藏");

    // 展开 → 槽位出现
    btn.click();
    await sleep(10);
    assert.notEqual(wrap.style.display, "none", "展开后槽位可见");
    const slot = wrap.querySelector(".neo-director-setup-seg-thumb");
    assert.ok(slot.classList.contains("neo-director-setup-seg-thumb-empty"), "尾帧槽位空态");

    // 拖入 → 设尾帧，按钮显示缩略指示
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"lastframe.png","subfolder":""}' : "") };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });
    slot.dispatchEvent(dropEv);
    await sleep(30);
    assert.ok(slot.querySelector("img"), "尾帧槽位显示素材");
    assert.ok(btn.querySelector(".neo-director-lf-chip"), "按钮显示缩略指示");
    assert.ok(!btn.textContent.includes("＋"), "按钮文案不再带 ＋");

    // ✕ 清除 → 回空态
    slot.querySelector(".neo-director-setup-seg-sb-clear").click();
    await sleep(10);
    assert.ok(slot.classList.contains("neo-director-setup-seg-thumb-empty"), "清除后回空态");
    assert.ok(btn.textContent.includes("＋ 尾帧"), "按钮回到 ＋ 尾帧");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：两栏帧行——f2v 首帧槽位 | 提示词；r2v 参考素材区在左栏、提示词在右", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true, mode: "t2v" },
        { id: "sk-r", name: "技能 R", gen_video: true, mode: "r2v" },
    ]));

    await openDirectorEditor(null);
    await sleep(60);

    const row = document.querySelector(".neo-director-seg");
    const cols = row.querySelector(".neo-director-frames-cols:not(.neo-director-frames-labels)");
    assert.ok(cols, "两栏帧行存在");
    assert.ok(cols.querySelector(".neo-director-frame-col .neo-director-setup-seg-thumb"), "左栏首帧槽位");
    assert.ok(cols.querySelector(".neo-director-frame-col .neo-director-lf-row"), "尾帧扩展行位于左栏内");
    assert.ok(cols.querySelector("textarea.neo-director-prompt"), "右栏提示词");
    assert.equal(row.querySelector(".neo-director-frames-labels > span").textContent, "首帧", "左栏标签 = 首帧");

    // 切 r2v → 帧槽位隐藏、参考素材区移入左栏（资源输入在左、提示词在右），标签跟随
    const modeSel = document.querySelector(".neo-director-mode");
    modeSel.value = "r2v";
    modeSel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(10);
    assert.ok(cols.classList.contains("neo-director-frames-noframe"), "r2v 隐藏帧槽位");
    assert.notEqual(row.querySelector(".neo-director-refs-block").style.display, "none", "参考素材区显示");
    assert.ok(cols.querySelector(".neo-director-frame-col .neo-director-refs-block"), "参考素材区在左栏内");
    assert.equal(row.querySelector(".neo-director-frames-labels > span").textContent, "参考素材", "左栏标签 = 参考素材");

    // 切回 f2v → 帧槽位恢复、资源区隐藏（仍留在左栏内），标签复原
    modeSel.value = "f2v";
    modeSel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(10);
    assert.ok(!cols.classList.contains("neo-director-frames-noframe"), "f2v 显示帧槽位");
    assert.equal(row.querySelector(".neo-director-refs-block").style.display, "none", "f2v 隐藏参考素材区");
    assert.equal(row.querySelector(".neo-director-frames-labels > span").textContent, "首帧", "左栏标签复原为首帧");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：打开旧配方只回显宫格拆分字段，文字故事板遗留字段不回显也不落盘", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] }; // 画布无素材
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "旧配方" }));

    const existing = {
        name: "旧配方",
        type: "video_director",
        shared: { width: 1344, height: 768 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
        story: {
            idea: "旧主题",                 // 文字故事板遗留字段：无控件回显、保存时丢弃
            story: "旧故事正文",
            segment_seconds: 15,
            frame_source: "unified",
            image_mode: "t2i",
            grid_prompts: "旧全局故事参考",
            characters: [{ filename: "char.png" }],
            backgrounds: [{ filename: "bg.png" }],
        },
    };
    await openDirectorEditor(existing, null);
    await sleep(60);

    Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜")).click();
    await sleep(20);

    // 宫格拆分字段回显：全局故事参考 + 角色参考图；切分方式回到默认自动
    const card = document.querySelector(".neo-director-src-card-grid");
    assert.equal(card.querySelector(".neo-director-grid-prompts").value, "旧全局故事参考", "回显全局故事参考");
    assert.equal(card.querySelector(".neo-director-grid-mode").value, "auto", "切分方式默认自动检测");
    const charTiles = Array.from(document.querySelectorAll(".neo-director-setup-char .neo-director-refpick-item")).map((it) => it.dataset.file);
    assert.deepEqual(charTiles, ["char.png"], "角色参考图回显");

    // 主题输入 / 分段粒度 / 来源选择 / 图片分镜卡都已移除；遗留 backgrounds 不回显
    assert.equal(document.querySelector(".neo-director-story-idea"), null, "主题输入框已移除");
    assert.equal(document.querySelector(".neo-director-seglen"), null, "分段粒度选择器已移除");
    assert.equal(document.querySelector(".neo-director-setup-sb"), null, "图片分镜卡片已移除");
    assert.ok(!Array.from(document.querySelectorAll(".neo-director-refpick-grid"))
        .some((g) => g.querySelector(".neo-director-refpick-item")?.dataset.file === "bg.png"),
        "旧配方 backgrounds 不再回显");

    // 未改动直接保存：story 只带全局故事参考与角色参考，遗留字段丢弃；未生成过不落 setup
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "发出保存请求");
    assert.equal(saveCall.body.story.grid_prompts, "旧全局故事参考", "全局故事参考落盘");
    assert.deepEqual(saveCall.body.story.characters, [{ filename: "char.png" }], "角色参考图落盘");
    assert.equal(saveCall.body.story.idea, undefined, "主题不再落盘");
    assert.equal(saveCall.body.story.segment_seconds, undefined, "分段粒度不再落盘");
    assert.equal(saveCall.body.story.frame_source, undefined, "来源选择不再落盘");
    assert.equal(saveCall.body.story.backgrounds, undefined, "遗留 backgrounds 不再回传");
    assert.equal(saveCall.body.setup, undefined, "未点过生成提示词时不落 setup");
});

test("导演编辑器：新建配方保存时 story 只有切分方式与空全局故事参考", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "新配方" }));

    await openDirectorEditor(null, null);
    await sleep(60);
    assert.equal(document.querySelector(".neo-director-src-card-grid .neo-director-grid-mode").value, "auto", "新建默认自动检测行列");

    document.querySelector(".neo-director-name").value = "新配方";
    document.querySelector(".neo-director-seg .neo-director-skill").value = "sk-a";
    document.querySelector(".neo-director-seg .neo-director-prompt").value = "提示词";
    document.querySelector(".neo-director-save").click();
    await sleep(50);

    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "发出保存请求");
    assert.equal(saveCall.body.story.grid_prompts, null, "无全局故事参考时落 null（由后端判空不落盘）");
    assert.equal(saveCall.body.story.characters, undefined, "未设置角色参考图时不回传 characters");
    assert.equal(saveCall.body.story.idea, undefined, "主题输入已移除，不落盘");
});
test("导演编辑器：新建时直接在时间轴输入段提示词，标题未命名则截取生成（超 20 字截断），手动命名后不再覆盖", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor(null);
    await sleep(60);

    const promptTa = document.querySelector(".neo-director-prompt");
    const nameInp = document.querySelector(".neo-director-name");
    const nameView = document.querySelector(".neo-director-name-view");
    assert.ok(promptTa, "新建默认含一个空段提示词输入框");
    assert.equal(nameInp.value, "", "初始标题为空");

    // ① 在时间轴直接输入提示词 → 标题实时同步（未超 20 字）
    promptTa.value = "一只机器猫在雨夜找家";
    promptTa.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(20);
    assert.equal(nameInp.value, "一只机器猫在雨夜找家", "标题同步提示词");
    assert.equal(nameView.textContent, "一只机器猫在雨夜找家", "标题视图更新");

    // ② 超过 20 字 → 截断加 …（长度 = 20 + 省略号）
    promptTa.value = "这是一个非常非常长的段提示词用来测试标题截断逻辑是否正常工作啊";
    promptTa.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(20);
    assert.equal(nameInp.value.length, 21, "20 字 + 省略号");
    assert.ok(nameInp.value.endsWith("…"), "超长截断加省略号");

    // ③ 手动命名后，再改提示词不再覆盖标题
    nameInp.value = "我手动的名字";
    nameInp.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(20);
    promptTa.value = "又改了提示词内容";
    promptTa.dispatchEvent(new window.Event("input", { bubbles: true }));
    await sleep(20);
    assert.equal(nameInp.value, "我手动的名字", "手动命名后不再被提示词覆盖");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：编辑已有配方默认落在分镜时间线页", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const existing = {
        name: "旧配方",
        type: "video_director",
        shared: { width: 1344, height: 768 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing, null);
    await sleep(60);

    const tabTimeline = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("分镜时间线"));
    assert.ok(tabTimeline.classList.contains("active"), "编辑默认激活分镜时间线页");
    assert.equal(document.querySelector(".neo-director-pane-story").style.display, "none", "故事板页默认隐藏");
    assert.equal(document.querySelector(".neo-director-name").value, "旧配方", "编辑时保留已有配方名");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：记住上次打开时停的页签（未保存直接关掉，再开仍在原页）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const existing = {
        name: "记页签配方",
        type: "video_director",
        shared: { width: 1344, height: 768 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    await openDirectorEditor(existing, null);
    await sleep(60);

    const tabStory = Array.from(document.querySelectorAll(".neo-director-tab"))
        .find((t) => t.textContent.includes("故事板分镜"));
    tabStory.click();   // 编辑到一半切到故事板分镜页，不保存直接关
    await sleep(20);
    document.querySelector(".neo-director-close").click();
    await sleep(20);

    await openDirectorEditor(existing, null);
    await sleep(60);
    const tabs = Array.from(document.querySelectorAll(".neo-director-tab"));
    const story2 = tabs.find((t) => t.textContent.includes("故事板分镜"));
    const timeline2 = tabs.find((t) => t.textContent.includes("分镜时间线"));
    assert.ok(story2.classList.contains("active"), "重开落回上次停的故事板分镜页");
    assert.equal(timeline2.classList.contains("active"), false, "分镜时间线页不激活");
});



test("导演编辑器：打开时按 focusSeg 定位到指定段（节点上点的那块）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const existing = {
        name: "T-focus",
        shared: { width: 1344, height: 768 },
        segments: [
            { skill_id: "sk-a", prompt: "第一段", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "第二段", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "第三段", duration_sec: 5 },
        ],
    };
    const currentIdx = () => Array.from(document.querySelectorAll(".neo-director-seg"))
        .findIndex((s) => s.classList.contains("neo-director-seg-current"));

    await openDirectorEditor(existing, null, 2); // 节点上点了第 3 块
    assert.equal(currentIdx(), 2, "打开即定位到指定段");

    // 同一配方、窗口已打开：再点第 1 块 → 复用窗口并切换当前段（不叠加、不重建）
    await openDirectorEditor(existing, null, 0);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "同一配方不叠加浮层");
    assert.equal(currentIdx(), 0, "已打开的窗口切换到所点段");

    // 不带索引（列表 / ✎ 进入）→ 保持当前段不变
    await openDirectorEditor(existing);
    assert.equal(currentIdx(), 0, "未指定段时不改变当前段");

    // 索引超出段数 → 钳到最后一段（节点与编辑器段数不一致时不至于空窗）
    await openDirectorEditor(existing, null, 9);
    assert.equal(currentIdx(), 2, "越界索引钳到最后一段");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});


test("导演编辑器：切换当前段时编辑器时间轴自动把该段滚进可视区", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    // 可视区宽度要在打开前就固定（组件首次绘制/定位滚动按它算块坐标）；jsdom 无布局，只能如此
    const CANVAS_VW = 600;
    Object.defineProperty(window.HTMLCanvasElement.prototype, "clientWidth", { value: CANVAS_VW, configurable: true });

    const existing = {
        name: "T-reveal",
        shared: { width: 1344, height: 768 },
        segments: Array.from({ length: 12 }, (_, i) => ({ skill_id: "sk-a", prompt: "p" + i, duration_sec: 5 })),
    };
    const currentIdx = () => Array.from(document.querySelectorAll(".neo-director-seg"))
        .findIndex((s) => s.classList.contains("neo-director-seg-current"));

    try {
        await openDirectorEditor(existing, null, 10); // 打开即定位第 11 段
        await sleep(80);
        const scroll = document.querySelector(".neo-director-timeline .neo-dtl-scroll");
        assert.ok(scroll, "编辑器时间轴存在");
        assert.equal(currentIdx(), 10, "定位到第 11 段");

        // 12 段 × 5s、面板时间轴高 184 → 块净高 156 → 每块 16:9 ≈277.3px（内容远超 600px 可视区）
        const blockW = (184 - 18 - 4 - 6) * 16 / 9;
        const contentW = Math.ceil(12 * blockW + 8 * 2 + 32); // padX*2 + 尾部「＋」
        const want = Math.min(contentW - CANVAS_VW, 8 + 10 * blockW + blockW - CANVAS_VW + 12);
        assert.ok(Math.abs(scroll.scrollLeft - want) < 3, `滚动到第 11 块（期望≈${Math.round(want)}，实际 ${Math.round(scroll.scrollLeft)}）`);

        // 同一窗口内切回第 1 段 → 滚回最左
        await openDirectorEditor(existing, null, 0);
        assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "复用同一窗口");
        assert.equal(currentIdx(), 0, "当前段切到第 1 段");
        assert.equal(scroll.scrollLeft, 0, "时间轴滚回最左");

        // 再切回第 11 段 → 再次滚到该段
        await openDirectorEditor(existing, null, 10);
        assert.equal(currentIdx(), 10);
        assert.ok(Math.abs(scroll.scrollLeft - want) < 3, "再次滚动到第 11 块");
    } finally {
        delete window.HTMLCanvasElement.prototype.clientWidth; // 还原 jsdom 原型，避免影响同文件其它用例
    }

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：图生视频段三组参考网格回显，保存写入 refs 并把参考视频/音频带进 assets", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };   // 画布无素材 → 参考靠已存名回填
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "R2V" }));

    const existing = {
        name: "R2V",
        type: "video_director",
        shared: { mode: "i2v", width: 960, height: 544 },
        segments: [{
            skill_id: "sk-a", prompt: "p0", duration_sec: 5, mode: "i2v", first_frame: "ff.png",
            refs: { images: ["a.png"], videos: ["v.mp4"], audios: ["s.wav"] },
        }],
    };
    await openDirectorEditor(existing, null);
    await sleep(60);

    const rows = Array.from(document.querySelectorAll(".neo-director-seg .neo-director-segref-row"));
    assert.equal(rows.length, 3, "参考图 / 参考视频 / 参考音频三组网格");
    assert.deepEqual(rows.map((r) => r.querySelector(".neo-director-refpick-count").textContent),
        ["1/9", "1/3", "1/3"], "各自上限：图 9 / 视频 3 / 音频 3");
    const hasTile = (row, name) =>
        Array.from(row.querySelectorAll(".neo-director-refpick-item")).some((it) => it.dataset.file === name);
    assert.ok(hasTile(rows[0], "a.png"), "参考图回显");
    assert.ok(hasTile(rows[1], "v.mp4"), "参考视频回显");
    assert.ok(hasTile(rows[2], "s.wav"), "参考音频回显");

    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "发出保存请求");
    assert.deepEqual(saveCall.body.segments[0].refs,
        { images: ["a.png"], videos: ["v.mp4"], audios: ["s.wav"] });
    assert.equal(saveCall.body.shared.mode, "f2v", "旧 i2v 全局模式静默重映射为 f2v");
    const assets = saveCall.body.assets.map((a) => `${a.filename}:${a.kind}`);
    assert.ok(assets.includes("v.mp4:video"), "参考视频进配方 assets");
    assert.ok(assets.includes("s.wav:audio"), "参考音频进配方 assets");
});

test("导演编辑器：r2v 参考素材为已用列表——拖放排序、✕ 移除、拖入超限拒绝，保存按顺序写 refs", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };   // 无连线素材：只靠已存名回显
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "R2V" }));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "d.mp4" }));

    const existing = {
        name: "R2V", type: "video_director", shared: { mode: "r2v", width: 960, height: 544 },
        segments: [{ skill_id: "sk-a", prompt: "p0", duration_sec: 5, mode: "r2v",
                     refs: { images: ["a.png", "b.png", "c.png"], videos: ["v1.mp4", "v2.mp4", "v3.mp4"] } }],
    };
    await openDirectorEditor(existing, null);
    await sleep(60);

    const imgGrid = document.querySelector(".neo-director-seg .neo-director-refpick-grid");
    assert.ok(imgGrid, "参考图列表存在");
    const tilesOf = (grid) => Array.from(grid.querySelectorAll(".neo-director-refpick-item"));
    const orderOf = (grid) => tilesOf(grid).map((it) => it.dataset.file);
    // 模拟 HTML5 拖放重排：给瓷砖受控横向矩形（宽 50、间隔 10），按 clientX 命中某砖中线前/后触发 dragstart+drop
    const simulateDrag = (grid, fromFile, clientX) => {
        const tiles = Array.from(grid.querySelectorAll(".neo-director-refpick-item"));
        tiles.forEach((t, k) => { t.getBoundingClientRect = () => ({ left: k * 60, right: k * 60 + 50, width: 50, top: 0, bottom: 0, height: 0 }); });
        const src = tiles.find((t) => t.dataset.file === fromFile);
        assert.ok(src, `瓷砖 ${fromFile} 存在`);
        const dt = { effectAllowed: "", setData() {}, getData: () => "" };
        const startEv = new window.Event("dragstart", { bubbles: true, cancelable: true });
        Object.defineProperty(startEv, "dataTransfer", { value: dt, configurable: true });
        src.dispatchEvent(startEv);
        const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(dropEv, "clientX", { value: clientX, configurable: true });
        Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });
        grid.dispatchEvent(dropEv);
    };

    assert.deepEqual(orderOf(imgGrid), ["a.png", "b.png", "c.png"], "回显顺序即已存顺序");

    // 拖放重排：把 c 拖到最前 → [c,a,b]；再把 a 拖到最后 → [c,b,a]
    simulateDrag(imgGrid, "c.png", 5);      // clientX<首砖中线 → 插入位 0
    assert.deepEqual(orderOf(imgGrid), ["c.png", "a.png", "b.png"], "拖 c 到最前");
    simulateDrag(imgGrid, "a.png", 10000);   // clientX 超末砖 → 追加到末尾
    assert.deepEqual(orderOf(imgGrid), ["c.png", "b.png", "a.png"], "拖 a 到最后");

    // ✕ 移除 c（现居首）→ [b,a]，计数 2/9
    tilesOf(imgGrid).find((it) => it.dataset.file === "c.png").querySelector(".neo-director-refpick-del").click();
    assert.deepEqual(orderOf(imgGrid), ["b.png", "a.png"], "✕ 移除后剩两项");
    assert.equal(imgGrid.parentElement.querySelector(".neo-director-refpick-count").textContent, "2/9", "计数更新为 2/9");

    // 视频组已满 3：拖入第 4 个被拒，保持 3/3 与顺序（按瓷砖内容定位，不依赖行序）
    const allGrids = Array.from(document.querySelectorAll(".neo-director-seg .neo-director-refpick-grid"));
    assert.equal(allGrids.length, 3, "三组参考列表都在");
    const vidGrid = allGrids.find((g) => Array.from(g.querySelectorAll(".neo-director-refpick-item")).some((it) => it.dataset.file === "v1.mp4"));
    assert.ok(vidGrid, "视频组列表存在");
    assert.equal(vidGrid.parentElement.querySelector(".neo-director-refpick-count").textContent, "3/3", "视频组初始 3/3");
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"d.mp4","subfolder":""}' : "") };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });
    vidGrid.dispatchEvent(dropEv);
    await sleep(30);
    assert.deepEqual(orderOf(vidGrid), ["v1.mp4", "v2.mp4", "v3.mp4"], "超限拖入被拒，顺序不变");
    assert.equal(vidGrid.parentElement.querySelector(".neo-director-refpick-count").textContent, "3/3", "计数保持 3/3");

    // 最后保存（成功即关闭编辑器，故 DOM 断言都放在此之前）：refs 按当前排序写入
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "发出保存请求");
    assert.deepEqual(saveCall.body.segments[0].refs.images, ["b.png", "a.png"], "图 refs 按排序后顺序写入");
    assert.deepEqual(saveCall.body.segments[0].refs.videos, ["v1.mp4", "v2.mp4", "v3.mp4"], "视频 refs 保持顺序");
});

test("导演编辑器：「同步到所有分段」把当前段参考素材一键覆盖式复制到其余各段", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };   // 无连线素材：只靠已存名回显
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const existing = {
        name: "SYNC", type: "video_director", shared: { mode: "r2v", width: 960, height: 544 },
        segments: [
            { skill_id: "sk-a", prompt: "p0", duration_sec: 5, mode: "r2v",
              refs: { images: ["a.png", "b.png"], videos: ["v1.mp4"] } },
            { skill_id: "sk-a", prompt: "p1", duration_sec: 5, mode: "r2v",
              refs: { images: ["x.png"], audios: ["m1.mp3"] } },
        ],
    };
    await openDirectorEditor(existing, null);
    await sleep(60);

    const segs = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(segs.length, 2);
    const orderOf = (grid) => Array.from(grid.querySelectorAll(".neo-director-refpick-item")).map((it) => it.dataset.file);
    const gridsOf = (seg) => Array.from(seg.querySelectorAll(".neo-director-refpick-grid")); // DOM 序：图 / 视频 / 音频

    assert.deepEqual(orderOf(gridsOf(segs[0])[0]), ["a.png", "b.png"], "第1段参考图回显");
    assert.deepEqual(orderOf(gridsOf(segs[1])[0]), ["x.png"], "第2段参考图初始不同");
    assert.deepEqual(orderOf(gridsOf(segs[1])[2]), ["m1.mp3"], "第2段音频初始存在");

    // 点第1段的「同步到所有分段」→ 其余各段覆盖为第1段三组素材（含清空第2段独有音频）
    const syncBtn = segs[0].querySelector(".neo-director-segref-sync");
    assert.ok(syncBtn, "参考素材区标题行有同步按钮");
    syncBtn.click();
    await sleep(30);

    for (const seg of segs) {
        const g = gridsOf(seg);
        assert.deepEqual(orderOf(g[0]), ["a.png", "b.png"], "各段参考图与第1段一致");
        assert.deepEqual(orderOf(g[1]), ["v1.mp4"], "各段参考视频与第1段一致");
        assert.deepEqual(orderOf(g[2]), [], "第1段无音频 → 其余段音频被清空");
    }

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：参考素材区仅图生视频段显示（文生段隐藏）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "T2V", shared: { mode: "t2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5 }],
    });
    await sleep(60);
    const block = document.querySelector(".neo-director-seg .neo-director-refs-block");
    assert.ok(block, "参考素材区容器存在");
    assert.equal(block.style.display, "none", "文生段隐藏参考素材区");
    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：切换段模式/全局模式即时刷新参考素材区显隐", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "MODE", shared: { mode: "t2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5 }],
    });
    await sleep(60);
    const block = document.querySelector(".neo-director-seg .neo-director-refs-block");
    assert.equal(block.style.display, "none", "初始文生模式隐藏");

    const modeSel = document.querySelector(".neo-director-mode");
    modeSel.value = "r2v";
    modeSel.dispatchEvent(new Event("change"));
    await sleep(10);
    assert.equal(block.style.display, "", "切到参考主体模式后显示参考素材区");
    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：f2v 显示首帧槽位+尾帧扩展，保存写入 last_frame（旧 fl2v 配方静默重映射）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "FL2V" }));

    await openDirectorEditor({
        name: "FL2V", shared: { mode: "fl2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "fl2v",
                     first_frame: "a.png", last_frame: "z.png" }],
    }, null);
    await sleep(60);

    const row = document.querySelector(".neo-director-seg");
    const ffSlot = row.querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb");
    assert.ok(ffSlot.querySelector("img"), "首帧槽位回显 a.png");
    // 尾帧已设：扩展按钮显示缩略指示（z.png）
    const lfBtn = row.querySelector(".neo-director-lf-toggle");
    assert.ok(lfBtn.querySelector(".neo-director-lf-chip"), "尾帧按钮显示缩略指示");
    assert.equal(row.querySelector(".neo-director-refs-block").style.display, "none", "f2v 隐藏参考素材区");

    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const saved = fetchLog.find((c) => c.path === "/rs_recipes/save").body.segments[0];
    assert.equal(saved.first_frame, "a.png");
    assert.equal(saved.last_frame, "z.png");
    assert.equal(fetchLog.find((c) => c.path === "/rs_recipes/save").body.shared.mode, "f2v", "旧 fl2v 重映射为 f2v");
});

test("导演编辑器：预填首/尾帧（图库多选新建路径）保存时登记进 assets，不报「未保存的资产」", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "MS" }));

    // 多选新建路径：existing 无 assets，帧为 input/ 根目录文件（copy_to_input 落盘名）；两段共用一帧验证去重
    await openDirectorEditor({
        name: "", shared: { mode: "f2v" },
        segments: [
            { first_frame: "photo_1.jpg", duration_sec: 5 },
            { first_frame: "photo_2.jpg", last_frame: "photo_1.jpg", duration_sec: 5 },
        ],
    });
    await sleep(60);

    // 新建配方先命名（保存要求非空名）
    const wrap = document.querySelector(".neo-director-name-wrap");
    wrap.querySelector(".neo-director-name-view").click();
    const inp = wrap.querySelector(".neo-director-name");
    inp.value = "MS";
    inp.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const body = fetchLog.find((c) => c.path === "/rs_recipes/save").body;
    const assetNames = body.assets.map((a) => a.filename);
    assert.ok(assetNames.includes("photo_1.jpg"), "首帧登记进 assets");
    assert.ok(assetNames.includes("photo_2.jpg"), "第二段首帧登记进 assets");
    assert.equal(assetNames.filter((n) => n === "photo_1.jpg").length, 1, "跨段共用帧只登记一次");
    const a1 = body.assets.find((a) => a.filename === "photo_1.jpg");
    assert.equal(a1.subfolder, "", "帧在 input/ 根目录，subfolder 为空");
    assert.equal(a1.kind, "image");
});


test("导演编辑器：首帧槽位点 ✕ 只清除、不弹本地上传选择窗", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "CLR", shared: { mode: "f2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "f2v", first_frame: "a.png" }],
    }, null);
    await sleep(60);

    const row = document.querySelector(".neo-director-seg");
    const ffSlot = row.querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb");
    assert.ok(ffSlot.querySelector("img"), "首帧槽位回显 a.png");

    // 监控槽位内隐藏 file input：picker.open() 即 input.click()，✕ 不应触发
    const fileInp = ffSlot.querySelector("input[type=file]");
    let pickerOpened = 0;
    fileInp.click = () => { pickerOpened++; };

    ffSlot.querySelector(".neo-director-setup-seg-sb-clear").click();
    await sleep(10);

    assert.equal(pickerOpened, 0, "点 ✕ 未弹本地上传选择窗（事件不再冒泡到槽位点击上传）");
    assert.ok(ffSlot.classList.contains("neo-director-setup-seg-thumb-empty"), "首帧槽位回到空态");
    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：首尾帧模式缺尾帧时仅提示、仍按当前内容保存", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "FL2V-x" }));

    await openDirectorEditor({
        name: "FL2V-x", shared: { mode: "fl2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "fl2v", first_frame: "a.png" }],
    }, null);
    await sleep(60);
    document.querySelector(".neo-director-save").click();
    await sleep(40);
    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "缺尾帧仍发保存请求（只提示、不阻止）");
    assert.equal(saveCall.body.segments[0].last_frame, undefined, "缺尾帧则不带 last_frame 字段");
});

test("导演编辑器：参考主体模式显示参考素材区、隐藏首尾帧区", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "R2V", shared: { mode: "r2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "r2v",
                     refs: { images: ["a.png"] } }],
    }, null);
    await sleep(60);

    const row = document.querySelector(".neo-director-seg");
    assert.ok(row.querySelector(".neo-director-frames-cols:not(.neo-director-frames-labels)").classList.contains("neo-director-frames-noframe"), "参考主体模式隐藏首帧槽位（左栏）");
    assert.ok(row.querySelector(".neo-director-frame-col .neo-director-lf-row"), "尾帧扩展行收在左栏内（随左栏隐藏）");
    assert.equal(row.querySelector(".neo-director-refs-block").style.display, "", "参考主体模式显示参考素材区");
    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：旧 v2v 配方静默重映射为全参考，source_video 并入参考视频首位", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "V2V" }));

    await openDirectorEditor({
        name: "V2V", shared: { mode: "v2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "v2v", source_video: "src.mp4" }],
    }, null);
    await sleep(60);

    assert.equal(document.querySelector(".neo-director-mode").value, "r2v", "旧 v2v 重映射为 r2v");
    const row = document.querySelector(".neo-director-seg");
    assert.ok(row.querySelector(".neo-director-frames-cols:not(.neo-director-frames-labels)").classList.contains("neo-director-frames-noframe"), "隐藏首帧槽位（左栏）");
    assert.equal(row.querySelector(".neo-director-refs-block").style.display, "", "显示参考素材区");

    document.querySelector(".neo-director-save").click();
    await sleep(40);
    const saved = fetchLog.find((c) => c.path === "/rs_recipes/save").body.segments[0];
    assert.deepStrictEqual(saved.refs.videos, ["src.mp4"], "source_video 并入参考视频首位");
    assert.equal("source_video" in saved, false, "保存不再携带 source_video");
    assert.equal(fetchLog.find((c) => c.path === "/rs_recipes/save").body.shared.mode, "r2v");
});

test("导演编辑器：旧 rv2v 配方静默重映射为全参考，source_video 并入参考视频首位", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "RV2V", shared: { mode: "rv2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "rv2v",
                     source_video: "src.mp4", refs: { images: ["a.png"] } }],
    }, null);
    await sleep(60);

    assert.equal(document.querySelector(".neo-director-mode").value, "r2v", "旧 rv2v 重映射为 r2v");
    const row = document.querySelector(".neo-director-seg");
    assert.equal(row.querySelector(".neo-director-refs-block").style.display, "", "显示参考素材区");
    assert.ok(row.querySelector(".neo-director-frames-cols:not(.neo-director-frames-labels)").classList.contains("neo-director-frames-noframe"), "隐藏首帧槽位（左栏）");
    document.querySelector(".neo-director-close").click();
    await sleep(20);
});


test("导演编辑器：混合模式下每段可选 f2v/r2v，切换后即时刷新分区显隐", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "MIX", shared: { mode: "mixed" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "t2v" }],
    }, null);
    await sleep(60);

    const row = document.querySelector(".neo-director-seg");
    const segMode = row.querySelector(".neo-director-segmode");
    assert.deepEqual(Array.from(segMode.options).map((o) => o.value), ["f2v", "r2v"]);

    segMode.value = "f2v";
    segMode.dispatchEvent(new Event("change"));
    await sleep(10);
    assert.ok(!row.querySelector(".neo-director-frames-cols:not(.neo-director-frames-labels)").classList.contains("neo-director-frames-noframe"), "f2v 显示首帧槽位");
    assert.ok(row.querySelector(".neo-director-frame-col .neo-director-lf-row"), "f2v 尾帧扩展行位于左栏内");

    segMode.value = "r2v";
    segMode.dispatchEvent(new Event("change"));
    await sleep(10);
    assert.ok(row.querySelector(".neo-director-frames-cols:not(.neo-director-frames-labels)").classList.contains("neo-director-frames-noframe"), "r2v 隐藏首帧槽位");
    assert.equal(row.querySelector(".neo-director-refs-block").style.display, "", "r2v 显示参考素材区");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：首/尾帧槽位点击上传（隐藏 file input），参考组网格点击上传（无按钮）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "LOCAL", shared: { mode: "f2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "f2v" }],
    }, null);
    await sleep(60);

    // 首帧槽位、尾帧槽位各含隐藏 file input（点击空态上传）
    const ffSlot = document.querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb");
    assert.ok(ffSlot.querySelector("input[type=file]"), "首帧槽位含隐藏 file input");
    const lfSlot = document.querySelector(".neo-director-lf-slot-wrap .neo-director-setup-seg-thumb");
    assert.ok(lfSlot.querySelector("input[type=file]"), "尾帧槽位含隐藏 file input");

    // 参考素材区三组网格：无「本地」按钮，点击黑色空区上传（行内含隐藏 file input）
    const refRows = Array.from(document.querySelectorAll(".neo-director-seg .neo-director-segref-row"));
    assert.equal(refRows.length, 3, "参考图/视频/音频三组");
    for (const row of refRows) {
        const label = row.querySelector(".neo-director-field-label").textContent;
        assert.ok(!row.querySelector(".neo-director-local-add"), `参考组无「本地」按钮: ${label}`);
        assert.ok(row.querySelector("input[type=file]"), `参考组含隐藏 file input（点击网格上传）: ${label}`);
    }

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：参考组网格点击黑色空区触发本地上传并加入该组", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/upload/image", () => jsonResponse({ name: "ref_up.png", subfolder: "", type: "input" }));

    await openDirectorEditor({
        name: "REFUP", shared: { mode: "r2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "r2v" }],
    }, null);
    await sleep(60);

    const imgRow = Array.from(document.querySelectorAll(".neo-director-seg .neo-director-segref-row"))
        .find((r) => r.querySelector(".neo-director-field-label").textContent.includes("参考图"));
    const grid = imgRow.querySelector(".neo-director-refpick-grid");
    assert.ok(grid, "参考图网格存在");

    // 点击黑色空区（非瓷砖）→ 触发隐藏 file input.click()
    const fileInput = imgRow.querySelector("input[type=file]");
    let openCalls = 0;
    fileInput.click = () => { openCalls++; };   // 拦截：jsdom 无文件选择器
    grid.click();
    assert.equal(openCalls, 1, "点击空区触发 file input.click()");

    // 模拟选择文件 → 上传并加入参考图组
    const fakeFile = new File(["fake"], "ref.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [fakeFile], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    await sleep(50);

    const uploadCall = fetchLog.find((c) => c.path === "/upload/image");
    assert.ok(uploadCall, "调用了 /upload/image");
    const tile = Array.from(grid.querySelectorAll(".neo-director-refpick-item")).find((it) => it.dataset.file === "ref_up.png");
    assert.ok(tile, "上传文件加入参考图组");

    // 点瓷砖不额外触发上传
    const before = openCalls;
    grid.querySelector(".neo-director-refpick-item").click();
    assert.equal(openCalls, before, "点瓷砖不触发上传");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：首帧槽位点击上传文件后设为首帧", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/upload/image", () => jsonResponse({ name: "uploaded_local.png", subfolder: "", type: "input" }));

    await openDirectorEditor(null);
    await sleep(60);

    // 首帧槽位内的隐藏 file input
    const ffSlot = document.querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb");
    const fileInput = ffSlot.querySelector("input[type=file]");
    assert.ok(fileInput, "首帧槽位含隐藏 file input");
    assert.equal(fileInput.accept, "image/*", "file input accept=image/*");

    // 点击空态 → 触发 file input.click()
    let openCalls = 0;
    fileInput.click = () => { openCalls++; };   // 拦截：jsdom 无文件选择器
    ffSlot.click();
    assert.equal(openCalls, 1, "点击空态触发 file input.click()");

    // 模拟选择文件 → 上传并设为首帧
    const fakeFile = new File(["fake"], "local.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [fakeFile], configurable: true });
    fileInput.dispatchEvent(new Event("change"));
    await sleep(50);

    const uploadCall = fetchLog.find((c) => c.path === "/upload/image");
    assert.ok(uploadCall, "调用了 /upload/image");
    assert.equal(uploadCall.method, "POST");
    assert.ok(ffSlot.querySelector("img"), "上传的文件设为首帧");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：参考视频/音频的「本地」按钮 accept 正确过滤", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    await openDirectorEditor({
        name: "REF", shared: { mode: "r2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "r2v" }],
    }, null);
    await sleep(60);

    const refRows = Array.from(document.querySelectorAll(".neo-director-seg .neo-director-segref-row"));
    const labels = refRows.map((r) => r.querySelector(".neo-director-field-label").textContent);
    // 参考图/参考视频/参考音频
    const imgRow = refRows.find((r) => r.querySelector(".neo-director-field-label").textContent.includes("参考图"));
    const vidRow = refRows.find((r) => r.querySelector(".neo-director-field-label").textContent.includes("参考视频"));
    const audRow = refRows.find((r) => r.querySelector(".neo-director-field-label").textContent.includes("参考音频"));
    assert.ok(imgRow && vidRow && audRow, "三组参考网格都存在");

    assert.equal(imgRow.querySelector("input[type=file]").accept, "image/*", "参考图 accept=image/*");
    assert.equal(vidRow.querySelector("input[type=file]").accept, "video/*", "参考视频 accept=video/*");
    assert.equal(audRow.querySelector("input[type=file]").accept, "audio/*", "参考音频 accept=audio/*");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：参考素材组只收本组类型（拖入与本地上传都校验，图片不能进视频/音频组）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/neo_gallery/copy_to_input", (body, call) =>
        jsonResponse({ success: true, filename: `copied_${call.query.get("filename")}` }));
    mockRoute("/upload/image", () => jsonResponse({ name: "picked.mp4", subfolder: "", type: "input" }));

    await openDirectorEditor({
        name: "KIND", shared: { mode: "r2v" },
        segments: [{ skill_id: "sk-a", prompt: "p", duration_sec: 5, mode: "r2v",
                     refs: { images: ["a.png"], videos: ["v.mp4"], audios: ["s.wav"] } }],
    }, null);
    await sleep(60);

    const refRows = Array.from(document.querySelectorAll(".neo-director-seg .neo-director-segref-row"));
    const rowOf = (label) => refRows.find((r) => r.querySelector(".neo-director-field-label").textContent.includes(label));
    const imgRow = rowOf("参考图"), vidRow = rowOf("参考视频"), audRow = rowOf("参考音频");
    assert.ok(imgRow && vidRow && audRow, "三组参考网格都在");
    const gridOf = (row) => row.querySelector(".neo-director-refpick-grid");
    const filesOf = (row) => Array.from(row.querySelectorAll(".neo-director-refpick-item")).map((it) => it.dataset.file);
    const countOf = (row) => row.querySelector(".neo-director-refpick-count").textContent;
    const warned = (label) => appState.toasts.some((t) => t.severity === "warning" && (t.detail || "").includes(`${label}只接受`));
    const dragInto = async (row, filename) => {
        const dt = { getData: (m) => (m === "application/x-neo-gallery" ? JSON.stringify({ filename, subfolder: "" }) : "") };
        const ev = new window.Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
        gridOf(row).dispatchEvent(ev);
        await sleep(30);
    };
    const pickInto = async (row, file) => {
        const input = row.querySelector("input[type=file]");
        Object.defineProperty(input, "files", { value: [file], configurable: true });
        input.dispatchEvent(new Event("change"));
        await sleep(50);
    };

    // 画廊拖入类型不符：图片进视频组 / 音频进视频组 / 视频进音频组 / 视频进图片组 → 一律拒绝且不落盘
    await dragInto(vidRow, "pic.png");
    assert.deepEqual(filesOf(vidRow), ["v.mp4"], "图片拖进参考视频组被拒");
    assert.equal(countOf(vidRow), "1/3", "视频组计数不变");
    assert.ok(warned("参考视频"), "提示「参考视频只接受视频素材」");
    assert.ok(!fetchLog.some((c) => c.path === "/neo_gallery/copy_to_input"), "类型不符时不落盘");

    await dragInto(vidRow, "music.mp3");
    assert.deepEqual(filesOf(vidRow), ["v.mp4"], "音频拖进参考视频组被拒");
    await dragInto(audRow, "clip.mp4");
    assert.deepEqual(filesOf(audRow), ["s.wav"], "视频拖进参考音频组被拒");
    assert.ok(warned("参考音频"), "提示「参考音频只接受音频素材」");
    await dragInto(imgRow, "clip.mp4");
    assert.deepEqual(filesOf(imgRow), ["a.png"], "视频拖进参考图组被拒");

    // 同类型拖入正常接收（落盘后按返回名入格）
    await dragInto(vidRow, "new.mp4");
    assert.deepEqual(filesOf(vidRow), ["v.mp4", "copied_new.mp4"], "视频拖进参考视频组正常接收");
    assert.equal(countOf(vidRow), "2/3", "计数更新为 2/3");
    await dragInto(audRow, "new.wav");
    assert.deepEqual(filesOf(audRow), ["s.wav", "copied_new.wav"], "音频拖进参考音频组正常接收");

    // 本地上传（accept 只是选择器过滤建议，可切「全部文件」）同样按类型校验
    mockRoute("/upload/image", () => jsonResponse({ name: "picked.png", subfolder: "", type: "input" }));
    await pickInto(vidRow, makeFile("os.png", "image/png"));
    assert.deepEqual(filesOf(vidRow), ["v.mp4", "copied_new.mp4"], "本地上传图片进视频组被拒");

    // OS 文件拖入（非画廊载荷）：不入格、不报错
    dropFiles(gridOf(vidRow), [makeFile("os2.png", "image/png")]);
    await sleep(30);
    assert.deepEqual(filesOf(vidRow), ["v.mp4", "copied_new.mp4"], "OS 文件拖入不改变列表");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：整片运行参数（种子 / 步数 / 连续性 / 上下文帧）在时间线页回显并落进 shared", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "RUN" }));

    await openDirectorEditor({
        name: "RUN",
        shared: { mode: "f2v", seed: 1234, steps: 8, continuity: false, context_frames: 40 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    });
    await sleep(60);

    const tl = document.querySelector(".neo-director-pane-timeline");
    const adv = tl.querySelector(".neo-director-adv");
    const seedInp = tl.querySelector(".neo-director-seed");
    const stepsInp = tl.querySelector(".neo-director-steps");
    const ctxInp = tl.querySelector(".neo-director-ctx");
    const chkBox = tl.querySelector(".neo-director-check input[type=checkbox]");
    // 整片运行参数收在「高级参数」组里，与生成模式 / 分辨率同占一行，默认收起
    assert.ok(adv.querySelector(".neo-director-seed"), "整片运行参数收进高级参数组");
    assert.equal(adv.querySelector(".neo-director-adv-check").checked, false, "高级参数默认收起");
    assert.equal(adv.parentElement, tl.querySelector(".neo-director-row.neo-director-shared"), "高级参数与生成模式同占一行");
    assert.equal(seedInp.value, "1234", "回显配方种子");
    assert.equal(stepsInp.value, "8", "回显配方步数");
    assert.equal(ctxInp.value, "40", "回显上下文帧");
    assert.equal(chkBox.checked, false, "回显连续性关掉");
    assert.equal(ctxInp.parentElement.style.display, "none", "连续性关掉时不显示上下文帧");

    // 种子留空 = 随机（落 -1）；步数改 12；连续性开 → 上下文帧可见
    changeValue(seedInp, "");
    changeValue(stepsInp, "12");
    chkBox.click();
    await sleep(10);
    assert.notEqual(ctxInp.parentElement.style.display, "none", "连续性开 → 上下文帧可见");
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const shared = fetchLog.filter((c) => c.path === "/rs_recipes/save").pop().body.shared;
    assert.equal(shared.seed, -1, "种子留空落 -1 = 每次运行随机换种子");
    assert.equal(shared.steps, 12, "步数落进配方");
    assert.equal(shared.continuity, true, "连续性落进配方");
    assert.equal(shared.context_frames, 40, "上下文帧落进配方");
    assert.equal(document.querySelector(".neo-director-panel"), null, "保存成功后编辑器自动关闭");
});


