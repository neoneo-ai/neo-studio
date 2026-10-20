// 文件说明：会话标题的四处显示 —— 右栏时间线顶上常驻（生成中一直在）、第二发不换、
// 历史列表与读回的旧会话、中间舞台页眉。标题 = 整条对话的第一句话，后端落盘时定下来
// （agent.py 的 title 字段），前端只做四处显示。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, mockRoute, jsonResponse, sseResponse, click, inputText } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?title=${seq++}`);

const RUN_ID = "b".repeat(32);

function mountStudio() {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
    }));
    mockRoute("/rs_prompts/skills", jsonResponse([]));
    mockRoute("/neo_mcp/servers", jsonResponse({ success: true, servers: [], connected: [] }));
    mockRoute("/neo_mcp/tools", jsonResponse({ success: true, tools: [] }));
}

async function openStudio(hash) {
    window.location.hash = hash;
    await importApp();
    await flush(40);
    click(document.getElementById("ns-agent-toggle"));   // 右栏默认收起
    await flush(20);
}

const dock = () => document.querySelector("#ns-agent-dock");
const askBox = () => dock().querySelector(".neo-agent-input");
const runBtn = () => dock().querySelector(".neo-agent-run");
const titleBar = () => dock().querySelector(".neo-agent-titlebar");
const transcript = () => dock().querySelector(".neo-agent-transcript");
const headBtn = (label) => [...dock().querySelectorAll(".neo-agent-head-btn")].find((b) => b.textContent === label);
const historyTexts = () => [...document.querySelectorAll(".neo-agent-session-text")].map((x) => x.textContent);

function mockAgentStream(frames) {
    mockRoute("/neo_agent/run", () => sseResponse(frames.map((f) => `data: ${JSON.stringify(f)}`).concat("data: [DONE]")));
}

async function send(text) {
    mockAgentStream([{ kind: "content", text: "好了" }]);
    inputText(askBox(), text);
    click(runBtn());
    await flush(40);
}

test("会话标题钉在第一句话上：第二发不换，新增会话才收回", async () => {
    mountStudio();
    await openStudio("#/gallery");
    await send("画一只橘猫在窗台上");
    assert.equal(titleBar().textContent, "💬 画一只橘猫在窗台上");
    await send("换成蓝色");
    assert.equal(titleBar().textContent, "💬 画一只橘猫在窗台上", "第二发不该把整条对话的标题换掉");
    // 生成中的这一路标题一直吸在时间线顶上：它是时间线的第一个子节点
    assert.equal([...transcript().children][0], titleBar());
    click(headBtn("＋"));
    await flush(20);
    assert.equal(titleBar().hidden, true, "新增会话要把标题行收回");
});

test("历史列表与读回的旧会话都显示整条对话的标题，不是续聊那一发自己那句", async () => {
    mountStudio();
    mockRoute("/neo_agent/sessions", jsonResponse({
        ok: true,
        sessions: [{
            run_id: RUN_ID, created: 1, mode: "act", status: "succeeded",
            title: "画一只橘猫在窗台上", text: "换蓝色", tools: 1,
        }],
    }));
    mockRoute("/neo_agent/session", jsonResponse({
        ok: true,
        session: {
            run_id: RUN_ID, created: 1, mode: "act", status: "succeeded",
            title: "画一只橘猫在窗台上", text: "换蓝色",
            frames: [{ kind: "content", text: "好了" }], options: [],
        },
    }));
    await openStudio("#/gallery");
    click(headBtn("🗂"));
    await flush(20);
    assert.ok(historyTexts().includes("画一只橘猫在窗台上"), `列表行要显示标题：${historyTexts()}`);
    click([...document.querySelectorAll(".neo-agent-session-row .neo-agent-head-btn")]
        .find((b) => b.textContent === "打开"));
    await flush(20);
    assert.equal(titleBar().textContent, "💬 画一只橘猫在窗台上");
});

test("中间舞台页眉挂会话标题：整场生成同一句，清空回默认", async () => {
    resetEnv();
    const { createAgentStage } = await import("../../web/agent-stage.js");
    const stage = createAgentStage();
    document.body.appendChild(stage.el);
    stage.setEnabled(true);
    const head = () => stage.el.querySelector(".ns-agent-stage-title").textContent;
    assert.equal(head(), "✨ 智能体");
    stage.onFrame({ kind: "title", text: "画一只橘猫在窗台上" });
    assert.equal(head(), "💬 画一只橘猫在窗台上");
    stage.onFrame({ kind: "run", run_id: "a".repeat(32) });
    stage.onFrame({ kind: "finish", text: "出好了", options: [] });
    assert.equal(head(), "💬 画一只橘猫在窗台上", "新一轮清场与收尾都不摘页眉上的标题");
    stage.onFrame({ kind: "title", text: "" });
    assert.equal(head(), "✨ 智能体");
    stage.el.remove();
});
