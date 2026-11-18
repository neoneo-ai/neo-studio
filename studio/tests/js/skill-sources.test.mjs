// 技能页云端订阅源：源未配置就不出入口；清单成行带状态与动作；「本地已修改」要用户确认才发覆盖那一发。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, jsonResponse, flush, click, fetchLog, dialogs, setConfirmAnswer } from "./setup.mjs";
import { $el } from "../../web/studio/shim/ui.js";

const SOURCES = "/rs_prompts/skill_sources";
const INSTALL = "/rs_prompts/install_skill_source";

let createSkillsPage;
async function pageFactory() {
    if (!createSkillsPage) ({ createSkillsPage } = await import("../../web/studio/pages/skills-page.js"));
    return createSkillsPage;
}

async function build() {
    const toasts = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const page = await pageFactory();
    page({ $el, toast: (msg) => toasts.push(msg) }).buildSkills(host);
    await flush();
    return { host, toasts };
}

function row(id, state, extra = {}) {
    return { id, name: id, version: "1.1.0", description: "", updated_at: "",
             state, installed_version: "", ...extra };
}

function catalog(skills, extra = {}) {
    return { enabled: true, index_url: "https://cdn.example/neo/skills/index.json", source: "cache",
             reason: "ok", hint: "", ttl_hours: 24, age_hours: 2,
             updated_at: "2026-11-18T00:00:00Z", skills, ...extra };
}

function cloudEntry(host) {
    return [...host.querySelectorAll(".ns-skills-guide-actions button")]
        .find((b) => b.textContent.includes("云端技能"));
}

function calls(path) {
    return fetchLog.filter((c) => c.path === path);
}

function setup(skills, extra = {}, installResponder = null) {
    resetEnv();
    clearRoutes();
    mockRoute(SOURCES, () => jsonResponse(catalog(skills, extra)));
    mockRoute(INSTALL, installResponder ||
        (() => jsonResponse({ success: true, code: "installed", id: skills[0]?.id || "", version: "1.1.0" })));
}

async function openCloud(host) {
    click(cloudEntry(host));
    await flush();
    return host.querySelector(".ns-skills-cloud-panel");
}

test("源未配置：技能页不出「云端技能」入口", async () => {
    resetEnv();
    clearRoutes();
    mockRoute(SOURCES, () => jsonResponse({ enabled: false, source: "none", reason: "not_configured",
                                           hint: "云端技能源未配置", skills: [] }));
    const { host } = await build();
    const entry = cloudEntry(host);
    assert.ok(entry, "入口应存在（隐藏与否由源决定）");
    assert.ok(entry.hidden, "源未配置时入口应整条收掉");
});

test("清单成行：状态标签、动作钮与最近刷新时间", async () => {
    setup([row("story_board", "not_installed"),
           row("film_lut", "installed", { installed_version: "1.1.0" }),
           row("clay_view", "upgrade", { installed_version: "1.0.0" })]);
    const { host } = await build();
    const panel = await openCloud(host);
    assert.ok(host.querySelector(".ns-skills-page.ns-skills-cloud"), "打开云端要切到云端面板的页状态");
    assert.equal(host.querySelectorAll(".ns-skills-cloud-row").length, 3);
    assert.equal(panel.querySelector(".ns-skills-cloud-status").textContent, "共 3 条 · 最近刷新 2 小时前");
    const labels = [...panel.querySelectorAll(".ns-skills-cloud-state")].map((el) => el.textContent);
    assert.deepEqual(labels, ["未安装", "已安装", "可更新"]);
    const actions = [...panel.querySelectorAll(".ns-skills-cloud-row .ns-btn")].map((b) => b.textContent);
    assert.deepEqual(actions, ["安装", "更新"], "已安装那行不给动作");
    assert.ok([...panel.querySelectorAll(".ns-skills-cloud-meta")].some((el) => el.textContent === "1.0.0 → 1.1.0"));
});

test("点「安装」：按 id 发一发安装，装完刷新清单并广播技能变更", async () => {
    setup([row("story_board", "not_installed")]);
    const { host, toasts } = await build();
    const events = [];
    document.addEventListener("rs.skills.updated", () => events.push(1));
    const panel = await openCloud(host);
    const before = calls(SOURCES).length;
    click(panel.querySelector(".ns-skills-cloud-row .ns-btn"));
    await flush();
    assert.deepEqual(calls(INSTALL)[0].body, { id: "story_board", allow_modified: false });
    assert.equal(calls(INSTALL).length, 1);
    assert.equal(calls(SOURCES).length, before + 1, "装完要重读一次清单");
    assert.ok(toasts.some((m) => m.includes("已安装")), `提示条要说装好了：${toasts}`);
    assert.equal(events.length, 1, "已装列表要收到技能变更");
});

test("本地已修改：确认才覆盖，取消就一动不动", async () => {
    // 后端第一发不带覆盖旗标就回 local_modified（409），给了旗标才动文件
    setup([row("story_board", "local_modified", { installed_version: "1.0.0" })], {},
          (body) => (body?.allow_modified
              ? jsonResponse({ success: true, code: "installed", id: "story_board", version: "1.1.0" })
              : jsonResponse({ success: false, code: "local_modified", message: "本地技能已修改" }, 409)));
    const { host } = await build();
    const panel = await openCloud(host);
    setConfirmAnswer(false);
    click(panel.querySelector(".ns-skills-cloud-row .ns-btn"));
    await flush();
    assert.equal(calls(INSTALL).length, 1, "取消就到此为止：只发第一发（不带覆盖旗标）");
    assert.equal(calls(INSTALL)[0].body.allow_modified, false);
    assert.equal(dialogs.confirms.length, 1, "要问一次用户");
    setConfirmAnswer(true);
    click(panel.querySelector(".ns-skills-cloud-row .ns-btn"));
    await flush();
    assert.equal(calls(INSTALL).length, 3, "第二发仍是先不带旗标，确认后才发覆盖那一发");
    assert.equal(dialogs.confirms.length, 2);
    assert.equal(calls(INSTALL)[2].body.allow_modified, true, "确认后才给覆盖旗标");
});

test("拉取失败：状态行说清是上次成功的清单，已装技能不受影响", async () => {
    setup([row("story_board", "installed", { installed_version: "1.0.0" })],
          { source: "cache", reason: "fetch_failed" });
    const { host } = await build();
    const panel = await openCloud(host);
    assert.equal(panel.querySelector(".ns-skills-cloud-status").textContent,
                 "清单拉取失败，下面是上次成功的清单（2 小时前）");
    assert.deepEqual([...panel.querySelectorAll(".ns-skills-cloud-state")].map((el) => el.textContent), ["已安装"]);
    assert.equal(panel.querySelectorAll(".ns-skills-cloud-row .ns-btn").length, 0, "已装且一致就不给动作");
});
