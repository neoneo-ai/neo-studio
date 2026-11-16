// 导演编辑器「单段 vs 多段」的界面收敛：新建落时间线页；只有一段时收掉多段专属控件（分块秒数 /
// 各段对照），换成一行单段引导；加段后全部恢复。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

beforeEach(async () => {
    resetEnv();
    clearRoutes();
    const { resetDirectorTabMemory } = await import("../../web/director.js");
    resetDirectorTabMemory();
});

const skills = () => mockRoute("/rs_prompts/skills", () => jsonResponse([
    { id: "sk-a", name: "技能 A", gen_video: true },
    { id: "sk-mf", name: "多帧技能", gen_video: true, multi_frame: true },
]));

const guide = () => document.querySelector(".neo-director-single-guide");
const storyHint = () => document.querySelector(".neo-director-single-story-hint");
const storyOptRow = () => document.querySelector(".neo-director-pane-story .neo-director-setup-opt");
const storyPreview = () => document.querySelector(".neo-director-pane-story .neo-director-setup-segs");
const tab = (label) => [...document.querySelectorAll(".neo-director-tab")].find((t) => t.textContent.includes(label));

test("新建配方落时间线页 + 单段引导；点引导切到宫格图分镜页，那里只留一行单段提示", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    skills();

    await openDirectorEditor(null);
    await sleep(60);

    // ① 新建：时间线页 + 一段 + 引导可见
    assert.ok(tab("分镜时间线").classList.contains("active"), "新建默认激活时间线页");
    assert.equal(document.querySelectorAll(".neo-director-segs .neo-director-seg").length, 1, "空白新建只有一个段");
    assert.equal(guide().style.display, "", "单段新建时显示「要拆多段去哪」的引导");

    // ② 点引导里的按钮 → 宫格图分镜页
    guide().querySelector(".neo-director-single-guide-btn").click();
    await sleep(20);
    assert.ok(tab("宫格图分镜").classList.contains("active"), "引导按钮把用户带到宫格图分镜页");

    // ③ 故事板页：单段不收「各段对照 + 批量优化」，换成一行提示
    assert.equal(storyOptRow().style.display, "none", "单段隐藏各段对照标题行（含批量优化按钮）");
    assert.equal(storyPreview().style.display, "none", "单段隐藏对照表");
    assert.equal(storyHint().style.display, "", "单段显示提示");

    // ④ 回到时间线页加一段 → 单段那套全部反转
    tab("分镜时间线").click();
    await sleep(20);
    assert.equal(guide().style.display, "", "加段前引导仍在（此时仍是一段）");
    document.querySelector(".neo-director-add").click();
    await sleep(20);
    assert.equal(document.querySelectorAll(".neo-director-segs .neo-director-seg").length, 2, "加段成功");
    assert.equal(guide().style.display, "none", "多段后收起引导");

    tab("宫格图分镜").click();
    await sleep(20);
    assert.equal(storyOptRow().style.display, "", "多段恢复各段对照标题行");
    assert.equal(storyPreview().style.display, "", "多段恢复对照表");
    assert.equal(storyHint().style.display, "none", "多段收起单段提示");
});

test("编辑已有单段配方：不显示「拆多段」引导，但仍收掉多段专属控件", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    skills();

    await openDirectorEditor({
        name: "SOLO",
        shared: { mode: "f2v" },
        segments: [{ skill_id: "sk-a", prompt: "一个镜头", duration_sec: 5 }],
    });
    await sleep(60);

    assert.equal(guide().style.display, "none", "编辑已有配方不给「拆多段」引导");
    assert.equal(document.querySelector(".neo-director-chunk-sec").style.display, "none",
        "单段 + 多帧技能也不显示分块秒数");
});
