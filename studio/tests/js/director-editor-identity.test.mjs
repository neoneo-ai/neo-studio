// 导演编辑器「角色身份参考开关」：默认启用、关掉随 shared.identity_refs 落盘并重开回显。
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

test("导演编辑器：身份参考开关默认开，关掉后随 shared 落盘并可回显（对比测试用）", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "ID-ON" }));

    // ① 新建/旧配方（无该键）：开关默认勾选，保存时不写该键
    await openDirectorEditor({
        name: "ID-ON",
        shared: { mode: "i2v" },
        segments: [{ skill_id: "sk-a", prompt: "p0", duration_sec: 5 }],
    });
    await sleep(60);
    const tabSetup = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabSetup.click();
    await sleep(30);
    const setupPane = document.querySelector(".neo-director-pane-story");
    const chk = setupPane.querySelector(".neo-director-identity-refs");
    assert.ok(chk, "故事板分镜页有身份参考开关");
    assert.equal(chk.checked, true, "默认启用");
    assert.ok(setupPane.querySelector(".neo-director-setup-char .neo-director-identity-refs"),
        "开关集成在「角色参考图」盒标题行内");
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    const onCall = fetchLog.filter((c) => c.path === "/rs_recipes/save").pop();
    assert.equal(onCall.body.shared.identity_refs, undefined, "默认开不落盘该键");
});

test("导演编辑器：身份参考开关关掉 → shared.identity_refs=false，重开回显未勾选", async () => {
    const { openDirectorEditor } = await import("../../web/director.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/save", () => jsonResponse({ success: true, name: "ID-OFF" }));

    // ① 旧配方里已关掉 → 回显未勾选
    await openDirectorEditor({
        name: "ID-OFF",
        shared: { mode: "i2v", identity_refs: false },
        segments: [{ skill_id: "sk-a", prompt: "p0", duration_sec: 5 }],
    });
    await sleep(60);
    const tabSetup = Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜"));
    tabSetup.click();
    await sleep(30);
    const chk = document.querySelector(".neo-director-pane-story .neo-director-identity-refs");
    assert.equal(chk.checked, false, "回显未勾选");

    // ② 勾回来 → 保存不再带该键（恢复默认；保存后编辑器自动关闭）
    chk.checked = true;
    chk.dispatchEvent(new Event("change"));
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    let saveCall = fetchLog.filter((c) => c.path === "/rs_recipes/save").pop();
    assert.equal(saveCall.body.shared.identity_refs, undefined, "勾回启用后不再落盘该键");

    // ③ 再关掉一次并保存 → 写 false
    fetchLog.length = 0;
    await openDirectorEditor({
        name: "ID-OFF",
        shared: { mode: "i2v" },
        segments: [{ skill_id: "sk-a", prompt: "p0", duration_sec: 5 }],
    });
    await sleep(60);
    Array.from(document.querySelectorAll(".neo-director-tab")).find((t) => t.textContent.includes("故事板分镜")).click();
    await sleep(30);
    const chk2 = document.querySelector(".neo-director-pane-story .neo-director-identity-refs");
    chk2.checked = false;
    chk2.dispatchEvent(new Event("change"));
    document.querySelector(".neo-director-save").click();
    await sleep(50);
    saveCall = fetchLog.filter((c) => c.path === "/rs_recipes/save").pop();
    assert.equal(saveCall.body.shared.identity_refs, false, "关掉时落盘 false");
});

