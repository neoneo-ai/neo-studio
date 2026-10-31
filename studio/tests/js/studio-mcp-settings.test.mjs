// MCP 注册表在设置页「MCP 服务」栏：tab 激活时拉注册表；智能体页「生成」下面只留一个入口，点它深链 #/settings?tab=mcp。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, jsonResponse, click } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?mcp=${seq++}`);

function mountStudio() {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
    }));
    mockRoute("/neo_mcp/servers", jsonResponse({
        success: true, servers: [{ name: "neo-studio", transport: "stdio" }], connected: ["neo-studio"],
    }));
    mockRoute("/neo_mcp/tools", jsonResponse({
        success: true, tools: [
            { server: "neo-studio", name: "neo_status", description: "版本 / 队列", enabled: true, required: [] },
            { server: "neo-studio", name: "generate_image", description: "生图", enabled: true,
              required: ["skill_id", "prompt"], example: { skill_id: "sd", prompt: "橘猫" } },
        ],
    }));
}

// hashchange 在 jsdom 里是宏任务：设完 hash 要等一轮事件循环，路由才把页面切过去
const settle = async () => { await sleep(0); await flush(); };

async function openStudio(hash) {
    window.location.hash = hash;
    await importApp();
    await settle();
}

const mcpTab = () => document.querySelector('.ns-settings-tab[data-key="mcp"]');
const mcpSection = () => document.querySelector(".ns-mcp-section");

test("智能体页：输入框底栏有 MCP 入口，栏内不再有 MCP 区", async () => {
    mountStudio();
    await openStudio("#/agent");

    const chat = document.querySelector(".ns-agent-chat");
    assert.ok(chat.querySelector(".neo-agent-chat"), "智能体页应有面板");
    assert.ok(!chat.querySelector(".neo-agent-mcp"), "面板不应再有 MCP 区");

    const entry = chat.querySelector(".neo-agent-entry");
    assert.ok(entry, "底栏应有 MCP 入口");
    const row = entry.closest(".neo-agent-toolbar");
    const run = chat.querySelector(".neo-agent-run");
    const kids = [...row.children];
    assert.ok(kids.includes(entry) && kids.includes(run), "MCP 入口与生成按钮应在底栏同一行");
    assert.ok(kids.indexOf(entry) < kids.indexOf(run), "生成按钮应是底栏最右一个");
});

test("设置页「MCP 服务」栏：tab 激活时拉注册表并列出服务", async () => {
    mountStudio();
    await openStudio("#/settings");

    const tab = mcpTab();
    assert.ok(tab, "设置页应有「MCP 服务」tab");
    assert.equal(tab.textContent, "MCP 服务");
    assert.equal(mcpSection().style.display, "none", "未激活的 tab 不应显示");

    click(tab);
    await flush(40);
    assert.equal(mcpSection().style.display, "", "激活后应显示 MCP 栏");
    assert.ok(mcpSection().querySelector(".neo-agent-name")?.textContent.includes("neo-studio"),
        "应列出注册表里的服务");
    assert.ok(mcpSection().querySelector(".neo-agent-tool-name")?.textContent.includes("neo_status"),
        "应列出已连服务的工具");
});

test("深链 #/settings?tab=mcp：进设置页直接落到 MCP 栏", async () => {
    mountStudio();
    await openStudio("#/settings?tab=mcp");

    assert.ok(mcpTab().classList.contains("active"), "MCP tab 应激活");
    assert.equal(mcpSection().style.display, "", "MCP 栏应可见");
});

test("智能体页入口：跳到设置页并落到 MCP 栏", async () => {
    mountStudio();
    await openStudio("#/agent");

    click(document.querySelector(".ns-agent-chat .neo-agent-entry"));
    await flush();

    assert.equal(window.location.hash, "#/settings?tab=mcp", "入口应深链到设置页 MCP 栏");
    assert.ok(mcpTab().classList.contains("active"), "MCP tab 应激活");
    assert.equal(mcpSection().style.display, "", "MCP 栏应可见");
});

test("工具卡：默认参数用服务端示例预填，无示例时才是空壳", async () => {
    mountStudio();
    await openStudio("#/settings");
    click(mcpTab());
    await flush(40);

    const cards = [...document.querySelectorAll(".neo-agent-tool")];
    const sample = cards.find((c) => c.querySelector(".neo-agent-tool-name").textContent.includes("generate_image"));
    const bare = cards.find((c) => c.querySelector(".neo-agent-tool-name").textContent.includes("neo_status"));
    click(sample.querySelector(".neo-agent-row-btn"));
    click(bare.querySelector(".neo-agent-row-btn"));
    await flush();

    assert.deepEqual(JSON.parse(sample.querySelector(".neo-agent-tool-args").value),
        { skill_id: "sd", prompt: "橘猫" }, "带必填参数的工具要预填服务端示例");
    assert.deepEqual(JSON.parse(bare.querySelector(".neo-agent-tool-args").value), {},
        "无必填参数的只读工具预填空参数");
});

test("连接 / 断开重画：服务行不叠加，断开后旧工具卡清空", async () => {
    mountStudio();
    let connected = ["neo-studio"];
    const toolCards = [
        { server: "neo-studio", name: "neo_status", description: "版本 / 队列", enabled: true, required: [] },
        { server: "neo-studio", name: "list_skills", description: "列技能", enabled: true, required: [] },
    ];
    mockRoute("/neo_mcp/servers", () => jsonResponse({
        success: true, servers: [{ name: "neo-studio", transport: "stdio" }], connected,
    }));
    // 工具表是已连会话的 tools/list 快照：断开之后服务端就只能回空表
    mockRoute("/neo_mcp/tools", () => jsonResponse({
        success: true, tools: connected.length ? toolCards : [], connected,
    }));
    mockRoute("/neo_mcp/connect", () => { connected = ["neo-studio"]; return jsonResponse({ success: true }); });
    mockRoute("/neo_mcp/disconnect", () => { connected = []; return jsonResponse({ success: true }); });
    await openStudio("#/settings");
    click(mcpTab());
    await flush(40);

    const rows = () => [...document.querySelectorAll(".neo-agent-row")];
    const cards = () => [...document.querySelectorAll(".neo-agent-tool")];
    assert.equal(rows().length, 1, "服务行不能叠加");
    assert.equal(cards().length, 2, "已连服务应列出工具卡");

    click(rows()[0].querySelector(".neo-agent-row-btn"));   // 断开
    await flush(40);
    assert.equal(rows().length, 1, "断开重画后仍应只有一行");
    assert.equal(cards().length, 0, "断开后不能留下旧工具卡");

    click(rows()[0].querySelector(".neo-agent-row-btn"));   // 连接
    await flush(40);
    assert.equal(rows().length, 1, "连接重画后仍应只有一行");
    assert.equal(cards().length, 2, "连接后应重新列出工具卡");
});
