// 文件说明：会话标题的四处显示 —— 钉在右栏栏头那一行（生成中一直在）、第二发不换、
// 历史列表与读回的旧会话、中间舞台页眉。标题 = 整条对话的第一句话，后端落盘时定下来
// （agent.py 的 title 字段），前端只做四处显示。
// 同一次落盘还带用户自己那一发（in 帧）：读回旧会话时时间线里要看得见自己问过什么。
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
const headTitle = () => dock().querySelector(".neo-agent-head-title");
const transcript = () => dock().querySelector(".neo-agent-transcript");
const askedLines = () => [...transcript().querySelectorAll(".neo-agent-ask")].map((x) => x.textContent);
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

test("会话标题钉在栏头那一行：第二发不换，新增会话才收回", async () => {
    mountStudio();
    await openStudio("#/gallery");
    assert.equal(headTitle().textContent, "智能体", "空态栏头就是「智能体」");
    await send("画一只橘猫在窗台上");
    assert.equal(headTitle().textContent, "画一只橘猫在窗台上");
    await send("换成蓝色");
    assert.equal(headTitle().textContent, "画一只橘猫在窗台上", "第二发不该把整条对话的标题换掉");
    // 标题不再占时间线里单独一行：那条空标题条整块删掉了，栏头是它唯一的位置
    assert.equal(dock().querySelector(".neo-agent-titlebar"), null);
    click(headBtn("＋"));
    await flush(20);
    assert.equal(headTitle().textContent, "智能体", "新增会话要把栏头收回默认");
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
            title: "画一只橘猫在窗台上",
            input: { text: "换蓝色", images: [] },
            frames: [{ kind: "in", text: "换蓝色", attachments: [] },
                     { kind: "content", text: "好了" }],
        },
    }));
    await openStudio("#/gallery");
    click(headBtn(""));
    await flush(20);
    assert.ok(historyTexts().includes("画一只橘猫在窗台上"), `列表行要显示标题：${historyTexts()}`);
    click([...document.querySelectorAll(".neo-agent-session-row .neo-agent-head-btn")]
        .find((b) => b.textContent === "打开"));
    await flush(20);
    assert.equal(headTitle().textContent, "画一只橘猫在窗台上");
});

test("读回旧会话时用户自己那一发在时间线里：原文与附件图都看得见", async () => {
    mountStudio();
    mockRoute("/neo_agent/sessions", jsonResponse({
        ok: true,
        sessions: [{ run_id: RUN_ID, created: 1, mode: "act", status: "succeeded", title: "画一只橘猫", text: "画一只橘猫", tools: 1 }],
    }));
    mockRoute("/neo_agent/session", jsonResponse({
        ok: true,
        session: {
            run_id: RUN_ID, created: 1, mode: "act", status: "succeeded", title: "画一只橘猫",
            input: { text: "画一只橘猫", images: ["cat.png"] },
            frames: [{ kind: "in", text: "画一只橘猫", attachments: ["cat.png"] },
                     { kind: "tool_call", tool: "generate_image", text: "{}" },
                     { kind: "finish", text: "出好了", media: [], options: [] }],
        },
    }));
    await openStudio("#/gallery");
    click(headBtn(""));
    await flush(20);
    click([...document.querySelectorAll(".neo-agent-session-row .neo-agent-head-btn")]
        .find((b) => b.textContent === "打开"));
    await flush(20);
    assert.ok(askedLines().includes("画一只橘猫"), `时间线里要有自己问过的那句：${askedLines()}`);
    const thumb = transcript().querySelector(".neo-agent-ask-media img");
    assert.ok(thumb && thumb.getAttribute("src").includes("/view?filename=cat.png"), "附件图按落盘的名字铺缩略图");
});

test("早于 in 帧的老会话从 input 补一句自己问的话；只给附件图的那一发落占位句", async () => {
    mountStudio();
    mockRoute("/neo_agent/sessions", jsonResponse({
        ok: true,
        sessions: [{ run_id: RUN_ID, created: 1, mode: "act", status: "succeeded", title: "老会话第一句", text: "老会话第一句", tools: 0 }],
    }));
    mockRoute("/neo_agent/session", jsonResponse({
        ok: true,
        session: {
            run_id: RUN_ID, created: 1, mode: "act", status: "succeeded",
            input: { text: "老会话第一句", images: ["a.png"] },
            frames: [{ kind: "content", text: "好了" }],
        },
    }));
    await openStudio("#/gallery");
    click(headBtn(""));
    await flush(20);
    click([...document.querySelectorAll(".neo-agent-session-row .neo-agent-head-btn")]
        .find((b) => b.textContent === "打开"));
    await flush(20);
    assert.equal(headTitle().textContent, "老会话第一句");
    assert.ok(askedLines().includes("老会话第一句"), `老会话也要补上自己那句：${askedLines()}`);
});

test("中间舞台页眉挂会话标题：整场生成同一句，清空回默认", async () => {
    resetEnv();
    const { createAgentStage } = await import("../../web/agent-stage.js");
    const stage = createAgentStage();
    document.body.appendChild(stage.el);
    stage.setEnabled(true);
    const head = () => stage.el.querySelector(".ns-agent-stage-title").textContent;
    assert.equal(head(), "智能体");
    stage.onFrame({ kind: "title", text: "画一只橘猫在窗台上" });
    assert.equal(head(), "画一只橘猫在窗台上");
    stage.onFrame({ kind: "run", run_id: "a".repeat(32) });
    stage.onFrame({ kind: "in", text: "换成蓝色", attachments: [] });
    stage.onFrame({ kind: "finish", text: "出好了", options: [] });
    assert.equal(head(), "画一只橘猫在窗台上", "新一轮清场与收尾都不摘页眉上的标题");
    stage.onFrame({ kind: "title", text: "" });
    assert.equal(head(), "智能体");
    stage.el.remove();
});
