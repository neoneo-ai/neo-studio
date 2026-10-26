// 导演编辑器「关闭保护 / 单例拦截 / 技能选择窗 / 段行 ♻ 单段生成 / 比例告警 / 对照表重排」。
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
test("导演编辑器关闭保护：无修改直接关；有未保存修改先出确认条（保存并关闭 / 放弃修改 / 继续编辑）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true }));

    const existing = {
        name: "T-dirty",
        shared: { width: 1344, height: 768 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };

    // ① 无修改：✕ 直接关闭；仅动拉伸滑块（视图状态）也不算修改
    await openDirectorEditor(existing);
    await sleep(60);
    const slider = document.querySelector(".neo-director-zoom-slider");
    slider.value = "2";
    slider.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(document.querySelector(".neo-director-dirty-confirm").hidden, true, "初始确认条隐藏");
    document.querySelector(".neo-director-close").click();
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 0, "无修改直接关闭（滑块不算修改）");

    // ② 改提示词后 ✕ → 不关，出确认条；「继续编辑」收起确认条、窗口仍在
    await openDirectorEditor(existing);
    await sleep(60);
    const promptTa = document.querySelector(".neo-director-prompt");
    promptTa.value = "改过的提示词";
    promptTa.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector(".neo-director-close").click();
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "有未保存修改：✕ 不关闭");
    const confirm = document.querySelector(".neo-director-dirty-confirm");
    assert.equal(confirm.hidden, false, "确认条出现");
    document.querySelector(".neo-director-dirty-keep").click();
    await sleep(20);
    assert.equal(confirm.hidden, true, "「继续编辑」收起确认条");
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "窗口仍在");

    // ③ 再点底部「取消」→ 确认条再次出现；「放弃修改」直接关闭
    // 底部「取消 / 保存」同处一行（页签共用，紧凑靠右，不各占半行）
    const foot = document.querySelector(".neo-director-foot");
    assert.equal(document.querySelector(".neo-director-save").parentElement, foot, "「保存」在底部按钮行内");
    assert.equal(document.querySelector(".neo-director-cancel").parentElement, foot, "「取消」在底部按钮行内");
    document.querySelector(".neo-director-cancel").click();
    await sleep(20);
    assert.equal(confirm.hidden, false, "「取消」同样走确认条");
    document.querySelector(".neo-director-dirty-discard").click();
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 0, "「放弃修改」关闭且不发保存请求");
    assert.equal(fetchLog.find((c) => c.path === "/rs_recipes/save"), undefined, "放弃修改不保存");

    // ④ 「保存并关闭」：发保存请求并关闭窗口
    await openDirectorEditor(existing);
    await sleep(60);
    const promptTa2 = document.querySelector(".neo-director-prompt");
    promptTa2.value = "又改了";
    promptTa2.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector(".neo-director-close").click();
    await sleep(20);
    assert.equal(document.querySelector(".neo-director-dirty-confirm").hidden, false, "再次出现确认条");
    document.querySelector(".neo-director-dirty-save").click();
    await sleep(60);
    const saveCall = fetchLog.find((c) => c.path === "/rs_recipes/save");
    assert.ok(saveCall, "「保存并关闭」发出保存请求");
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 0, "保存成功后窗口关闭");
});

test("导演编辑器单例：有未保存修改时切另一配方先出确认条，处理完自动切过去", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const recipeA = {
        name: "T-keep",
        shared: { width: 1344, height: 768 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 }],
    };
    const recipeB = {
        name: "T-other",
        shared: {},
        segments: [{ skill_id: "sk-a", prompt: "x", duration_sec: 5 }],
    };
    await openDirectorEditor(recipeA);
    await sleep(60);

    // 改提示词 → 点另一配方：不重载，仍显示 A，且弹出确认条
    const promptTa = document.querySelector(".neo-director-prompt");
    promptTa.value = "未保存的改动";
    promptTa.dispatchEvent(new window.Event("input", { bubbles: true }));
    await openDirectorEditor(recipeB);
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "仍只有一个浮层");
    assert.equal(document.querySelector(".neo-director-name").value, "T-keep", "未重载为另一配方");
    assert.equal(document.querySelector(".neo-director-dirty-confirm").hidden, false, "切配方被拦截并出确认条");

    // 「放弃修改」→ 旧窗口关闭并自动打开刚点的 B（切配方那一下记着的）
    document.querySelector(".neo-director-dirty-discard").click();
    await sleep(60);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 1, "放弃后自动打开刚点的配方");
    assert.equal(document.querySelector(".neo-director-name").value, "T-other", "确认条处理完切到 B");

    // 「继续编辑」取消这次切换：带未保存修改关窗口后不补开
    const bTa = document.querySelector(".neo-director-prompt");
    bTa.value = "B 的未保存改动";
    bTa.dispatchEvent(new window.Event("input", { bubbles: true }));
    await openDirectorEditor(recipeA);
    await sleep(20);
    document.querySelector(".neo-director-dirty-keep").click();
    await sleep(20);
    assert.equal(document.querySelector(".neo-director-dirty-confirm").hidden, true, "继续编辑收起确认条");
    assert.equal(document.querySelector(".neo-director-name").value, "T-other", "继续编辑 = 留在 B");
    document.querySelector(".neo-director-close").click();
    await sleep(20);
    assert.equal(document.querySelector(".neo-director-dirty-confirm").hidden, false, "带未保存修改关窗口仍出确认条");
    document.querySelector(".neo-director-dirty-discard").click();
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-overlay").length, 0, "这次切换已取消：放弃后不补开");

    // 无修改时切配方仍直接重载（原行为不变）
    await openDirectorEditor(recipeA);
    await sleep(20);
    assert.equal(document.querySelector(".neo-director-name").value, "T-keep", "无修改直接切换");
});

test("导演编辑器：段技能选择窗带浮动预览卡，点击按 skill id 打开详情（行内查看按钮已移除）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-p", name: "预设技能", gen_video: true, mode: "t2v", source: "preset" },
        { id: "sk-c", name: "自定义技能", gen_video: true, mode: "t2v", source: "custom" },
    ]));
    let loadedId = null;
    mockRoute("/rs_prompts/load_skill", (b) => {
        loadedId = b && b.id;
        return jsonResponse({ id: b.id, name: "Loaded", content: "", files: [], gen_image: false, requires_ref: false, multi_turn: false, tags: [], category: "task" });
    });

    await openDirectorEditor({
        name: "T-view",
        shared: { mode: "t2v" },
        segments: [{ skill_id: "sk-c", prompt: "p", duration_sec: 5 }],
    });
    await sleep(60);

    const skillSel = document.querySelector(".neo-director-seg .neo-director-skill");
    assert.equal(skillSel.selectedOptions[0].dataset.source, "custom", "option 携带 data-source");

    // 点击下拉 → 搜索窗出现：行内查看按钮已移除，右侧渲染预览卡（生视频技能显示配置）
    skillSel.dispatchEvent(mouse("mousedown", 10));
    await sleep(30);
    const overlay = document.querySelector(".rs-skill-modal-overlay");
    assert.ok(overlay, "点击技能下拉弹出搜索窗");
    assert.equal(overlay.querySelectorAll(".rs-skill-row-action").length, 0, "行内查看按钮已移除");
    const preview = document.querySelector(".rs-skill-picker-preview");
    assert.ok(preview, "生视频技能列表渲染预览卡");

    // hover 自定义技能行 → 预览卡跟随；点击预览卡按 id 打开详情（自定义可编辑）
    const customRow = Array.from(overlay.querySelectorAll(".rs-skill-picker-item"))
        .find((r) => r.textContent.includes("自定义技能"));
    customRow.dispatchEvent(new window.Event("mouseenter"));
    await sleep(30);
    assert.equal(preview.querySelector(".rs-skill-preview-name").textContent, "自定义技能", "预览卡跟随焦点行");
    preview.click();
    await sleep(40);
    assert.equal(loadedId, "sk-c", "按 skill id 打开详情");
    assert.equal(document.querySelectorAll(".rs-skill-modal-overlay").length, 1, "搜索窗关闭，详情弹窗打开");

    // 关闭详情弹窗（详情弹窗 close 为 display:none，不移除节点）
    const detailOverlay = document.querySelector(".rs-skill-modal-overlay");
    document.querySelector(".rs-skill-modal-close").click();
    await sleep(20);
    assert.equal(detailOverlay.style.display, "none", "详情弹窗可关闭");

    document.querySelector(".neo-director-close").click();
    await sleep(20);
});

test("导演编辑器：段行 ♻ 单段生成 → 提交队列 + 轮询进度 + 取消 + 完成提示", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    let submitted = null;
    mockRoute("/neo_video_gen/run_segment", (body) => {
        submitted = body;
        return jsonResponse({ success: true, task_id: "t1", prompt_id: "p1", status: "queued", segment: 1, seed: 123 });
    });
    let statusCalls = 0;
    let cancelled = 0;
    mockRoute("/neo_video_gen/run_segment/t1", () => {
        statusCalls += 1;
        if (cancelled) {
            return jsonResponse({ success: true, task_id: "t1", status: "cancelled", segment: 1, seed: 123 });
        }
        if (statusCalls === 1) {
            return jsonResponse({ success: true, task_id: "t1", status: "running", segment: 1, seed: 123,
                                  progress: { value: 5, max: 20 }, warnings: [] });
        }
        if (statusCalls === 2) {
            return jsonResponse({ success: true, task_id: "t1", status: "succeeded", segment: 1, seed: 123,
                                  filename: "T_s2_20260920-120000.mp4", film: "film-old.mp4",
                                  warnings: ["该段没有可用的尾帧锚点（末段）：只用首帧锚点"] });
        }
        return jsonResponse({ success: true, task_id: "t1", status: "running", segment: 1, seed: 123,
                              progress: { value: 12, max: 20 }, warnings: [] });
    });
    mockRoute("/neo_video_gen/run_segment/t1/cancel", () => { cancelled += 1; return jsonResponse({ success: true }); });

    const existing = {
        name: "T",
        // 两个成片结果 → 面板要能看出（并能切换）锚点基于哪个视频
        results: [{ filename: "film-old.mp4", subfolder: "", kind: "video", at: "2026-09-19 10:00:00" },
                  { filename: "film-new.mp4", subfolder: "", kind: "video", at: "2026-09-20 10:00:00" }],
        shared: { width: 1344, height: 768, seed: 5 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 },
                   { skill_id: "sk-a", prompt: "第二段", duration_sec: 5 }],
    };
    const node = { id: 7, widgets: [
        { name: "seed", value: 99 }, { name: "continuity", value: true }, { name: "context_frames", value: 22 }] };
    await openDirectorEditor(existing, null, -1, { node });
    await sleep(60);

    const row = Array.from(document.querySelectorAll(".neo-director-seg"))[1];
    const regenBtn = row.querySelector(".neo-director-seg-regen");
    assert.ok(regenBtn, "段标题行有 ♻ 按钮");
    regenBtn.click();
    let panel = row.querySelector(".neo-director-seg-regen-panel");
    assert.ok(panel, "点击 ♻ 出现参数面板");
    // 多个成片结果：默认写明用最新的那个，并能切换来源
    const filmSel = panel.querySelector(".neo-director-regen-film");
    assert.ok(filmSel, "多个成片结果时出现「锚点来源」下拉");
    assert.match(panel.querySelector(".neo-director-regen-status").textContent, /film-new\.mp4/);
    assert.match(panel.querySelector(".neo-director-regen-status").textContent, /2 个成片结果/);
    changeValue(filmSel, "film-old.mp4");
    assert.match(panel.querySelector(".neo-director-regen-status").textContent, /film-old\.mp4/);
    // ② 后续步骤「拼回成片」：这一段还没有片段 → 按钮禁用并提示先生成
    const mergeBtn = panel.querySelector(".neo-director-merge-run");
    assert.ok(mergeBtn, "面板里有「拼回成片」按钮");
    assert.equal(mergeBtn.disabled, true, "还没有片段时不能拼回");
    assert.match(panel.querySelector(".neo-director-merge-status").textContent, /先生成这一段/);

    panel.querySelector(".neo-director-regen-run").click();
    await sleep(20);   // 提交落定即可，轮询已压到 40ms：等 60ms 会撞上第二拍（succeeded 收起取消按钮）
    assert.deepEqual(submitted, { recipe: "T", segment: 1, anchors: "both", seed: -1, node_id: 7,
                                  continuity: true, context_frames: 22, film: "film-old.mp4" },
                     "提交到队列（换种子 + 节点参数 + 指定锚点来源成片）");
    assert.equal(panel.querySelector(".neo-director-regen-cancel").style.display, "", "提交后出现取消按钮");

    await sleep(150);   // 轮询间隔已压到 40ms：running（带进度）→ succeeded
    assert.ok(statusCalls >= 2, "轮询任务状态");
    const done = appState.toasts.find((t) => t.summary === "该段已生成");
    assert.ok(done, "完成后提示产物");
    assert.match(done.detail, /film-old\.mp4/, "完成提示里写明锚点基于哪个成片");
    assert.ok(appState.toasts.some((t) => t.summary === "生成提示"), "降级/警告逐条提示");
    assert.match(panel.querySelector(".neo-director-regen-status").textContent, /已完成/);

    // ② 生成成功 → 可以拼回成片：只替换这一段，其余段沿用原成片
    assert.equal(mergeBtn.disabled, false, "生成成功后可以拼回成片");
    assert.match(panel.querySelector(".neo-director-merge-status").textContent, /已生成/);
    let mergeBody = null;
    mockRoute("/neo_video_gen/assemble_segments", (body) => {
        mergeBody = body;
        return jsonResponse({ success: true, task_id: "m1", status: "running",
                              stage: "读取第 2 段新片段（119 帧）", progress: { value: 0, max: 362 } });
    });
    let mergePoll = 0;
    mockRoute("/neo_video_gen/assemble_segments/m1", () => {
        mergePoll += 1;
        if (mergePoll === 1) {
            return jsonResponse({ success: true, task_id: "m1", status: "running",
                                  stage: "沿用原成片第 1..1 段（124 帧）", progress: { value: 119, max: 362 } });
        }
        return jsonResponse({ success: true, task_id: "m1", status: "succeeded",
                              filename: "T_merged_20260920-130000.mp4", frames: 362, warnings: [] });
    });
    mergeBtn.click();
    await sleep(20);
    assert.deepEqual(mergeBody, { recipe: "T", use: [1], blend: 0, film: "film-old.mp4",
                                 continuity: true, context_frames: 22 },
                     "拼接请求：只替换第 2 段（硬切、不做接缝交叉淡化）+ 与锚点来源同一份成片");
    assert.equal(panel.querySelector(".neo-director-merge-cancel").style.display, "", "拼接中可取消");
    await sleep(150);
    const merged = appState.toasts.find((t) => t.summary === "已拼回成片");
    assert.ok(merged, "完成后提示已拼回成片");
    assert.match(merged.detail, /T_merged_20260920-130000\.mp4/);
    assert.match(panel.querySelector(".neo-director-merge-status").textContent, /已拼成新成片：T_merged_20260920-130000\.mp4/);

    // 提交失败：后端 400 → 错误 toast，按钮恢复可重试
    mockRoute("/neo_video_gen/run_segment", () => jsonResponse({ success: false, error: "成片帧数不一致" }, 400));
    panel.querySelector(".neo-director-regen-run").click();
    await sleep(60);
    const failed = appState.toasts.find((t) => t.summary === "提交失败");
    assert.ok(failed, "提交失败弹错误 toast");
    assert.match(failed.detail, /成片帧数不一致/);
    assert.equal(panel.querySelector(".neo-director-regen-run").disabled, false, "失败后可重试");

    // 取消任务：调 cancel 接口
    mockRoute("/neo_video_gen/run_segment", () => jsonResponse({ success: true, task_id: "t1", status: "queued", segment: 1 }));
    panel.querySelector(".neo-director-regen-run").click();
    await sleep(20);
    assert.equal(panel.querySelector(".neo-director-regen-cancel").style.display, "", "新任务再次出现取消按钮");
    panel.querySelector(".neo-director-regen-cancel").click();
    await sleep(20);
    assert.equal(cancelled, 1, "点取消调 /cancel");
    // 「已取消」要等下一拍轮询取到 cancelled 才写：20ms 时本机已落定、CI 上还是「已请求取消…」，只断言落定态
    await sleep(400);
    assert.match(panel.querySelector(".neo-director-regen-status").textContent, /已取消/);

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});



test("导演编辑器：只有一个成片时 ♻ 面板不出「锚点来源」下拉，也不出现 null", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    const existing = {
        name: "T",
        results: [{ filename: "only-film.mp4", subfolder: "", kind: "video", type: "output" }],
        shared: { width: 1344, height: 768, seed: 5 },
        segments: [{ skill_id: "sk-a", prompt: "第一段", duration_sec: 5 },
                   { skill_id: "sk-a", prompt: "第二段", duration_sec: 5 }],
    };
    const node = { id: 7, widgets: [
        { name: "seed", value: 99 }, { name: "continuity", value: true }, { name: "context_frames", value: 22 }] };
    await openDirectorEditor(existing, null, -1, { node });
    await sleep(60);

    const row = Array.from(document.querySelectorAll(".neo-director-seg"))[1];
    row.querySelector(".neo-director-seg-regen").click();
    const panel = row.querySelector(".neo-director-seg-regen-panel");
    assert.ok(panel, "点 ♻ 出现面板");
    assert.equal(panel.querySelector(".neo-director-regen-film"), null, "单成片不给来源下拉");
    assert.doesNotMatch(panel.textContent, /null/, "面板不出现 null 字样");
    assert.match(panel.querySelector(".neo-director-regen-status").textContent, /only-film\.mp4/,
                 "提示行写明基于哪个成片");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

test("导演编辑器：打开带分镜图的旧配方 → 不报 TDZ，段行记录分镜图、对照表分镜图列显示", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const existing = {
        name: "T-SB",
        shared: { width: 1344, height: 768 },
        segments: [
            { skill_id: "sk-a", prompt: "第一段", duration_sec: 5, storyboard: "sb_0_ab12cd.png", storyboard_prompt: "一只机器猫", first_frame: "sb_0_ab12cd.png" },
            { skill_id: "sk-a", prompt: "第二段", duration_sec: 5 },   // 无分镜图
        ],
    };
    await openDirectorEditor(existing);   // 修复前：seg.storyboard 触发 row TDZ，此处会 reject
    await sleep(60);

    // 时间轴段行：不再有「分镜图」缩略行（分镜图只在「故事板分镜」页对照表第一列展示），
    // 但 dataset 仍记录已存分镜图与提示词快照（保存时随 storyboard 落盘）
    const rows = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector(".neo-director-seg-sb"), null, "段行不再有「分镜图」缩略行");
    assert.equal(rows[1].querySelector(".neo-director-seg-sb"), null, "段行不再有「分镜图」缩略行");
    assert.equal(rows[0].dataset.storyboard, "sb_0_ab12cd.png", "dataset 记录已存分镜图（保存时随 storyboard 落盘）");
    assert.equal(rows[0].dataset.storyboardPrompt, "一只机器猫", "dataset 记录分镜提示词快照");

    // 「故事板分镜」页对照表：第一列 = 分镜图（逐段图片分镜方式 → 该段关键帧）
    const tabSetup = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabSetup.click();
    await sleep(20);
    const setupItems = Array.from(document.querySelectorAll(".neo-director-setup-segs .neo-director-story-seg-item"));
    assert.equal(setupItems.length, 2);
    const sThumb0 = setupItems[0].querySelector(".neo-director-setup-seg-thumb img");
    assert.ok(sThumb0, "对照表第 1 段回显分镜图");
    assert.match(String(sThumb0.src), /sb_0_ab12cd\.png/, "分镜图列指向已存分镜图文件");
    assert.equal(setupItems[1].querySelector(".neo-director-setup-seg-thumb").textContent, "＋ 拖入 / 上传分镜图", "第 2 段无分镜图显示上传占位");

    // 对照表第一列缩略图悬停 ✕：清除该段分镜图记录（第 2 段无记录 → 不给 ✕）
    const sbClear = setupItems[0].querySelector(".neo-director-setup-seg-sb-clear");
    assert.ok(sbClear, "第 1 段缩略图带 ✕ 清除按钮");
    assert.equal(setupItems[1].querySelector(".neo-director-setup-seg-sb-clear"), null, "第 2 段无分镜图不给 ✕");
    sbClear.click();
    await sleep(20);
    assert.equal(rows[0].dataset.storyboard, undefined, "✕ 清除段行分镜图记录（保存时不再带 storyboard）");
    assert.equal(rows[0].dataset.storyboardPrompt, "一只机器猫", "✕ 保留分镜提示词快照，便于重新生成");
    const ffImg = rows[0].querySelector(".neo-director-frames-cols .neo-director-setup-seg-thumb img");
    assert.ok(!ffImg, "首帧正是该分镜图 → ✕ 一并清除首帧");
    const afterItems = Array.from(document.querySelectorAll(".neo-director-setup-segs .neo-director-story-seg-item"));
    assert.equal(afterItems[0].querySelector(".neo-director-setup-seg-thumb").textContent, "＋ 拖入 / 上传分镜图", "清除后第一列回到上传占位");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

test("导演编辑器：故事板分镜对照表拖拽手柄重排各段（回写 segsWrap 并刷新）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const existing = {
        name: "T-SB-REORDER",
        shared: { width: 1344, height: 768 },
        segments: [
            { skill_id: "sk-a", prompt: "第一段", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "第二段", duration_sec: 5 },
            { skill_id: "sk-a", prompt: "第三段", duration_sec: 5 },
        ],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const tabSetup = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabSetup.click();
    await sleep(20);

    const container = document.querySelector(".neo-director-setup-segs");
    let items = Array.from(container.querySelectorAll(".neo-director-story-seg-item"));
    assert.equal(items.length, 3, "对照表显示 3 段");
    items.forEach((it) => assert.ok(it.querySelector(".neo-director-story-seg-grip"), "每项带拖拽手柄"));

    // 模拟把第 2 项拖到最前（实时换位后的 DOM 顺序），松手 → commitSegReorder
    const moved = items[1];
    container.insertBefore(moved, items[0]);
    moved.dispatchEvent(new Event("dragend", { bubbles: true }));
    await sleep(20);

    // segsWrap（唯一事实来源）行顺序已变：原第 2 段排到第 1
    const rows = Array.from(document.querySelectorAll(".neo-director-seg"));
    assert.equal(rows[0].querySelector(".neo-director-prompt").value, "第二段", "重排后 segsWrap 首行是原第 2 段");
    assert.equal(rows[1].querySelector(".neo-director-prompt").value, "第一段", "重排后 segsWrap 次行是原第 1 段");
    assert.equal(rows[2].querySelector(".neo-director-prompt").value, "第三段", "重排后 segsWrap 末行是原第 3 段");

    // band-2 重新渲染，顺序与 segsWrap 一致、序号刷新
    items = Array.from(container.querySelectorAll(".neo-director-story-seg-item"));
    assert.equal(items[0].querySelector(".neo-director-story-seg-head span:nth-child(2)").textContent, "#1", "重排后首项序号 #1");
    const cols0 = Array.from(items[0].querySelectorAll(".neo-director-setup-seg-cols > div"));
    assert.ok(cols0.some((c) => c.textContent.includes("第二段")), "重排后首项内容对应原第 2 段");

    // 顺序未变时不触发重排（无位移的 dragend → 无副作用）
    items[0].dispatchEvent(new Event("dragend", { bubbles: true }));
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-seg").length, 3, "无位移的 dragend 不改变段数");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

test("导演编辑器：对照表分镜图缩略点击打开 Lightbox（←/→ 切换各段，✕ 不触发）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));

    const existing = {
        name: "T-SB-LB",
        shared: { width: 1344, height: 768 },
        segments: [
            { skill_id: "sk-a", prompt: "第一段", duration_sec: 5, storyboard: "sb_0_aaa.png" },
            { skill_id: "sk-a", prompt: "第二段", duration_sec: 5, storyboard: "sb_1_bbb.png" },
        ],
    };
    await openDirectorEditor(existing);
    await sleep(60);

    const tabSetup = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabSetup.click();
    await sleep(20);
    const setupItems = Array.from(document.querySelectorAll(".neo-director-setup-segs .neo-director-story-seg-item"));
    assert.equal(setupItems.length, 2);

    // 点第 2 段缩略图 → 打开 Lightbox（不再新开标签），各段分镜图在同一列表、从该段开始
    setupItems[1].querySelector(".neo-director-setup-seg-thumb a").click();
    await sleep(30);
    let lb = document.querySelector(".neo-lightbox");
    assert.ok(lb, "点击缩略图打开 Lightbox（不再新开标签）");
    assert.equal(lb.querySelector(".neo-lightbox-counter").textContent, "2 / 2", "两段分镜图在同一列表，从第 2 段开始");
    assert.match(String(lb.querySelector("img.neo-lightbox-media").src), /sb_1_bbb\.png/, "当前显示所点段的分镜图");

    // ← 上一页 → 第 1 段分镜图
    lb.querySelector(".neo-lightbox-prev").click();
    await sleep(30);
    assert.equal(lb.querySelector(".neo-lightbox-counter").textContent, "1 / 2", "上一页回到第 1 段");
    assert.match(String(lb.querySelector("img.neo-lightbox-media").src), /sb_0_aaa\.png/, "上一页显示第 1 段分镜图");

    lb.querySelector(".neo-lightbox-close").click();
    await sleep(20);
    assert.equal(document.querySelector(".neo-lightbox"), null, "Lightbox 正常关闭");

    // ✕ 清除按钮只清记录，不触发 Lightbox
    setupItems[0].querySelector(".neo-director-setup-seg-sb-clear").click();
    await sleep(20);
    assert.equal(document.querySelector(".neo-lightbox"), null, "✕ 未打开 Lightbox");

    document.querySelector(".neo-director-close")?.click();
    await sleep(20);
});

