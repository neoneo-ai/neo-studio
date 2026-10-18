// 右栏智能体：没有技能下拉，主按钮在顶上（生成 / 暂停 / 继续），界面当前状态随请求体交后端；
// 出图与出片一律走后端 /neo_agent/run 的 SSE 时间线，面板自己不发 /neo_image_gen/generate，
// 也不发流式提示词请求。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, jsonResponse, sseResponse, click, inputText, fetchLog, dropFiles, makeFile } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?skill=${seq++}`);

const SKILLS = [
    { id: "sk_cat", name: "cat_prompt", cn_name: "橘猫技能", category: "image_enhance", tags: [] },
    { id: "sk_dog", name: "dog_prompt", cn_name: "柴犬技能", category: "image_enhance", tags: [] },
    { id: "sk_gen", name: "krea2_gen", cn_name: "Krea2 出图", category: "image_gen", gen_image: true, has_workflow: true, tags: [] },
];

function mountStudio() {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
    }));
    mockRoute("/rs_prompts/skills", jsonResponse(SKILLS));
    mockRoute("/rs_prompts/stream_generate_prompt", () => ({
        __spec: true, status: 200,
        sse: ['data: {"text":"生成正文","kind":"content"}', "data: [DONE]"],
    }));
    mockRoute("/neo_mcp/servers", jsonResponse({ success: true, servers: [], connected: [] }));
    mockRoute("/neo_mcp/tools", jsonResponse({ success: true, tools: [] }));
}

async function openStudio(hash, open = true) {
    window.location.hash = hash;
    await importApp();
    await flush(40);
    // 右栏默认收起：栏内用例先按顶栏按钮展开（技能表在展开时才拉）
    if (open) {
        click(document.getElementById("ns-agent-toggle"));
        await flush(20);
    }
}

const dock = () => document.querySelector("#ns-agent-dock");
const ctxBar = () => dock().querySelector(".neo-agent-ctx");
const runBtn = () => dock().querySelector(".neo-agent-run");
const stopBtn = () => dock().querySelector(".neo-agent-stop");
const meta = () => dock().querySelector(".neo-agent-meta");
const finalRow = () => dock().querySelector(".neo-agent-answer-body");  // 智能体时间线的最终回答
const toolCard = () => dock().querySelector(".neo-agent-tool");
const statusLine = () => dock().querySelector(".neo-agent-tool-status");
const streamCalls = () => fetchLog.filter((c) => c.path === "/rs_prompts/stream_generate_prompt");
const agentCalls = () => fetchLog.filter((c) => c.path === "/neo_agent/run");
const genCalls = () => fetchLog.filter((c) => c.path === "/neo_image_gen/generate");
const cancelCalls = () => fetchLog.filter((c) => c.path === "/neo_agent/cancel");
const pauseCalls = () => fetchLog.filter((c) => c.path === "/neo_agent/pause");
const resumeCalls = () => fetchLog.filter((c) => c.path === "/neo_agent/resume");

/** 后端时间线的帧：逐条包成 SSE 行，末尾补 [DONE]。 */
function mockAgentStream(frames) {
    const lines = frames.map((f) => `data: ${JSON.stringify(f)}`);
    mockRoute("/neo_agent/run", () => sseResponse(lines.concat("data: [DONE]")));
}

/** 后端整帧原文（含 [ERROR] 这种非 JSON 帧）。 */
function mockAgentRaw(lines) {
    mockRoute("/neo_agent/run", () => sseResponse(lines.concat("data: [DONE]")));
}

const IMAGE_RESULT = {
    kind: "tool_result", tool: "generate_image", text: '{"status":"succeeded"}',
    media: [{ kind: "image", title: "cat_0001.png", url: "/view?filename=cat_0001.png&type=output" }],
};
const FILM_RESULT = {
    kind: "tool_result", tool: "director_run", text: '{"status":"succeeded","filename":"cat_walk.mp4"}',
    media: [{ kind: "video", title: "cat_walk.mp4", url: "/view?filename=cat_walk.mp4&subfolder=NeoDirector%2Fcat_walk&type=output" }],
};

test("右栏没有技能下拉：主按钮在顶上，上下文条画出宿主交来的界面状态", async () => {
    mountStudio();
    await openStudio("#/gallery");

    assert.equal(dock().querySelector(".neo-agent-skill"), null, "右栏不该再有技能下拉");
    const composer = dock().querySelector(".neo-agent-composer");
    assert.equal(composer.children[0], runBtn(), "主按钮应是输入区第一个元素");
    assert.equal(runBtn().textContent, "✨ 生成", "空闲时主按钮是生成");
    assert.ok(ctxBar().textContent.includes("素材库"), `上下文条应画出当前页：${ctxBar().textContent}`);
    assert.equal(stopBtn().disabled, true, "空闲时停止键锁着");
});

test("点生成：请求带界面上下文，出计划行与最终回答，面板不发流式提示词", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([
        { kind: "plan", text: "先扩写提示词再出图" },
        { kind: "content", text: "已按素材库现状出图" },
    ]);

    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await flush(40);

    const calls = agentCalls();
    assert.equal(calls.length, 1, "应发出一次智能体请求");
    assert.equal(calls[0].body.skill_id, undefined, "请求体不再带技能");
    assert.equal(calls[0].body.context.page, "gallery", "请求应带上宿主交来的当前页");
    assert.equal(calls[0].body.text, "一只橘猫", "智能体请求应带上输入文本");
    assert.equal(streamCalls().length, 0, "右栏不该发流式提示词请求");
    assert.equal(dock().querySelector(".neo-agent-step").textContent, "🧭 先扩写提示词再出图", "应渲染计划行");
    assert.equal(finalRow().textContent.trim(), "已按素材库现状出图", "应渲染最终回答");
    assert.ok(meta().textContent.includes("素材库"), `回合头应写明这一轮的上下文：${meta().textContent}`);
    assert.equal(runBtn().disabled, false, "收尾后应解禁主按钮");
});

test("MCP 入口只做跳转：点入口不发智能体请求", async () => {
    mountStudio();
    await openStudio("#/gallery");

    click(dock().querySelector(".neo-agent-entry"));
    await flush(40);

    assert.equal(window.location.hash, "#/settings?tab=mcp", "入口应深链到设置页 MCP 栏");
    assert.equal(agentCalls().length, 0, "入口不应触发智能体请求");
});

test("点生成走后端智能体出图：工具卡 / 状态 / 产物缩略图 / 最终回答，面板不自己发出图请求", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([
        { kind: "plan", text: "用出图技能生成白猫" },
        { kind: "tool_call", tool: "generate_image", text: '{"skill_id":"sk_gen","prompt":"生成一个白猫坐窗台的图片"}' },
        { kind: "status", tool: "task_status", task_id: "ag1", text: "running 10/20" },
        IMAGE_RESULT,
        { kind: "content", text: "完成：1 张 · 1280×720" },
    ]);

    inputText(dock().querySelector(".neo-agent-input"), "生成一个白猫坐窗台的图片");
    click(runBtn());
    await flush(40);

    const calls = agentCalls();
    assert.equal(calls.length, 1, "应发出一次智能体请求");
    assert.equal(calls[0].body.skill_id, undefined, "请求体不再带技能，用哪个技能由后端 LLM 定");
    assert.equal(genCalls().length, 0, "出图由后端 MCP 工具发起，面板不该自己打 /neo_image_gen/generate");
    assert.equal(streamCalls().length, 0, "右栏不再发流式提示词请求");
    assert.equal(toolCard().querySelector(".neo-agent-tool-title").textContent, "🔧 generate_image", "应渲染工具卡");
    assert.ok(statusLine().textContent.includes("running 10/20"), "状态行应显示采样进度");
    const img = toolCard().querySelector("img");
    assert.ok(img, "应在工具卡里渲染出图缩略图");
    assert.equal(img.getAttribute("src"), "/view?filename=cat_0001.png&type=output", "缩略图应指向产物地址");
    assert.equal(finalRow().textContent.trim(), "完成：1 张 · 1280×720", "应渲染最终回答");
    assert.equal(runBtn().disabled, false, "出图收尾后应解禁主按钮");
    assert.equal(runBtn().textContent, "✨ 生成", "收场后主按钮回到生成");
});

test("出片任务：状态行显示段进度，任务卡给取消按钮，点它按 task_id 取消", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockRoute("/neo_agent/cancel", () => jsonResponse({ success: true, kind: "director", task_id: "f-1" }));
    mockAgentStream([
        { kind: "plan", text: "跑整片配方 cat_walk" },
        { kind: "tool_call", tool: "director_run", text: '{"recipe":"cat_walk"}' },
        { kind: "status", tool: "task_status", task_id: "f-1", text: "running 段 1/2 3/10" },
    ]);

    inputText(dock().querySelector(".neo-agent-input"), "把猫走街景的配方出成片");
    click(runBtn());
    await flush(40);

    assert.equal(agentCalls()[0].body.skill_id, undefined, "出片走 LLM 规划路径，请求体不带技能");
    assert.equal(toolCard().querySelector(".neo-agent-tool-title").textContent, "🔧 director_run", "应渲染出片工具卡");
    assert.ok(statusLine().textContent.includes("running 段 1/2 3/10"), "状态行应显示段进度");
    const btn = statusLine().querySelector(".neo-agent-cancel");
    assert.ok(btn, "任务卡应给取消按钮");
    click(btn);
    await flush(20);
    const calls = cancelCalls();
    assert.equal(calls.length, 1, "点取消应发一次 /neo_agent/cancel");
    assert.equal(calls[0].body.task_id, "f-1", "取消请求应带上任务 id");
    assert.equal(statusLine().querySelector(".neo-agent-cancel").disabled, true, "已发出的取消应锁住");
});

// ====== 产物查看：缩略图与最终回答里的链接一律进弹出窗口，整扇窗口不导航 ======
const lightbox = () => document.querySelector(".neo-lightbox");
const lbClose = () => lightbox().querySelector(".neo-lightbox-close").click();
const opens = [];
window.open = (url, target) => { opens.push({ url, target }); return null; };
const clickLink = (a) => {
    const ev = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    return ev;
};

test("出图与出片缩略图进弹出窗口：卡片收小、成片可播，页面不导航", async () => {
    mountStudio();
    await openStudio("#/gallery");
    const before = window.location.href;
    mockAgentStream([
        { kind: "tool_call", tool: "generate_image", text: "{}" },
        IMAGE_RESULT,
        { kind: "tool_call", tool: "director_run", text: "{}" },
        FILM_RESULT,
        { kind: "content", text: "完成" },
    ]);

    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await flush(40);

    const cards = [...dock().querySelectorAll(".neo-agent-tool")];
    const img = cards[0].querySelector(".neo-agent-media img");
    const film = cards[1].querySelector(".neo-agent-media video");
    assert.ok(img, "出图应给图片缩略");
    assert.ok(film, "出片应给视频缩略");
    assert.ok(film.muted, "成片缩略静音：右栏不自动播声");

    click(img);
    await flush(10);
    assert.ok(lightbox(), "点缩略图应弹出灯箱");
    assert.ok(lightbox().classList.contains("neo-lightbox-compact"), "右栏产物用弹出窗口形态，不铺满整扇窗口");
    assert.match(String(lightbox().querySelector(".neo-lightbox-media").src), /cat_0001\.png/);
    lbClose();
    await flush(10);
    assert.equal(lightbox(), null, "灯箱应正常关闭");

    click(film);
    await flush(10);
    assert.match(String(lightbox().querySelector(".neo-lightbox-media").src), /cat_walk\.mp4/, "点成片进灯箱播放");
    lbClose();
    await flush(10);
    assert.equal(window.location.href, before, "看产物不许翻走整扇窗口");
});

test("最终回答里的产物链接进弹出窗口，外部链接交新窗口，页面不导航", async () => {
    mountStudio();
    await openStudio("#/gallery");
    const before = window.location.href;
    mockAgentStream([
        { kind: "content", text: "成片见 [cat_walk.mp4](/view?filename=cat_walk.mp4&subfolder=NeoDirector%2Fcat_walk&type=output)，模型在 [C 站](https://civitai.com/models/1)" },
    ]);

    inputText(dock().querySelector(".neo-agent-input"), "把猫走街景的配方出成片");
    click(runBtn());
    await flush(40);

    const links = [...finalRow().querySelectorAll("a")];
    assert.equal(links.length, 2, "Markdown 链接应渲染成可点的 <a>");

    const mediaEv = clickLink(links[0]);
    await flush(10);
    assert.ok(mediaEv.defaultPrevented, "产物链接不能走默认导航：整扇窗口翻到图片页，回来时启动状态与时间线一起没了");
    assert.ok(lightbox()?.classList.contains("neo-lightbox-compact"), "产物链接应进弹出窗口");
    assert.match(String(lightbox().querySelector(".neo-lightbox-media").src), /cat_walk\.mp4/);
    lbClose();
    await flush(10);

    clickLink(links[1]);
    await flush(10);
    assert.equal(lightbox(), null, "外部链接不该开灯箱");
    assert.deepEqual(opens, [{ url: "https://civitai.com/models/1", target: "_blank" }], "外部链接交新窗口");
    assert.equal(window.location.href, before, "Studio 页自己不导航");
});

const RUN_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** 首帧报 run_id 之后停住的流：运行态留在页面上，「⏹ 取消」才有得点；顺带把 signal 交回用例。 */
function mockPendingRunStream(takeSignal) {
    mockRoute("/neo_agent/run", (body, call) => {
        takeSignal(call.signal);
        const chunk = `data: ${JSON.stringify({ kind: "run", run_id: RUN_ID })}\n\n`;
        let sent = false;
        return {
            ok: true,
            status: 200,
            body: {
                getReader: () => ({
                    async read() {
                        if (!sent) {
                            sent = true;
                            return { done: false, value: new TextEncoder().encode(chunk) };
                        }
                        return new Promise(() => {});   // 永不结束：取消之前这条流就是挂着
                    },
                    releaseLock() {},
                }),
            },
        };
    });
}

test("运行中主按钮是暂停态、可点：第二击发暂停，不断流也不发取消", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockRoute("/neo_agent/pause", () => jsonResponse({ success: true, run_id: RUN_ID, task_id: "" }));
    mockPendingRunStream(() => {});

    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await flush(40);

    assert.equal(runBtn().disabled, false, "运行中按钮必须可点：锁掉等于把暂停键从界面上摘掉");
    assert.equal(runBtn().textContent, "⏸ 暂停", "运行中主按钮应是暂停");
    assert.equal(stopBtn().disabled, false, "运行中停止键要能按");
    assert.equal(cancelCalls().length, 0, "没点第二击不该发取消请求");

    click(runBtn());
    await flush(20);

    assert.equal(pauseCalls().length, 1, "点暂停应发一次 /neo_agent/pause");
    assert.deepEqual(pauseCalls()[0].body, { run_id: RUN_ID }, "暂停请求应带上首帧给的 run_id");
    assert.equal(runBtn().textContent, "▶ 继续", "暂停后主按钮应翻成继续");
    assert.equal(cancelCalls().length, 0, "暂停不是取消，不该发取消请求");
});

test("暂停后点继续：按 run_id 发 /neo_agent/resume，主按钮回到暂停", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockRoute("/neo_agent/pause", () => jsonResponse({ success: true, run_id: RUN_ID, task_id: "" }));
    mockRoute("/neo_agent/resume", () => jsonResponse({ success: true, run_id: RUN_ID }));
    mockPendingRunStream(() => {});

    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await flush(40);
    click(runBtn());
    await flush(20);
    click(runBtn());
    await flush(20);

    assert.equal(resumeCalls().length, 1, "点继续应发一次 /neo_agent/resume");
    assert.deepEqual(resumeCalls()[0].body, { run_id: RUN_ID }, "继续请求应带上首帧给的 run_id");
    assert.equal(runBtn().textContent, "⏸ 暂停", "继续后运行还在跑，主按钮回到暂停");
});

test("后端 paused / resumed 帧：时间线各落一行，主按钮跟着翻态", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([
        { kind: "run", run_id: RUN_ID },
        { kind: "paused", text: "已暂停：在跑的任务已取消，点「继续」接着跑" },
        { kind: "resumed", text: "已继续" },
        { kind: "content", text: "重跑完成" },
    ]);

    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await flush(40);

    const rows = [...dock().querySelectorAll(".neo-agent-step")].map((e) => e.textContent);
    assert.ok(rows.some((x) => x.includes("已暂停")), `应有已暂停行：${rows.join(" | ")}`);
    assert.ok(rows.some((x) => x.includes("已继续")), `应有已继续行：${rows.join(" | ")}`);
    assert.ok(dock().querySelector(".neo-agent-step-paused"), "已暂停行应带暂停样式");
    assert.equal(runBtn().textContent, "✨ 生成", "收场后主按钮回到生成");
});

test("点停止键断流并按 run_id 取消，时间线补一行已取消", async () => {
    mountStudio();
    await openStudio("#/gallery");
    let signal = null;
    mockPendingRunStream((s) => { signal = s; });
    mockRoute("/neo_agent/cancel", () => jsonResponse({ success: true, run_id: RUN_ID, task_id: "" }));

    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await flush(40);
    assert.ok(!signal.aborted, "没点取消时这条流不能被断");

    click(stopBtn());
    await flush(40);

    assert.ok(signal.aborted, "停止必须断掉 SSE 流");
    const calls = cancelCalls();
    assert.equal(calls.length, 1, "点停止键应发一次 /neo_agent/cancel");
    assert.deepEqual(calls[0].body, { run_id: RUN_ID }, "取消请求应带上后端首帧给的 run_id");
    const rows = [...dock().querySelectorAll(".neo-agent-step")].map((e) => e.textContent);
    assert.ok(rows.some((x) => x.includes("已取消")), `应有已取消行：${rows.join(" | ")}`);
    assert.equal(dock().querySelector(".neo-agent-answer-error"), null, "断流是预期收场，不该报生成失败");
    assert.equal(runBtn().disabled, true, "取消中不许再开一路");
});

test("取消请求失败：时间线写明取消失败，不演成一直在取消", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockPendingRunStream(() => {});
    mockRoute("/neo_agent/cancel", () => jsonResponse({ success: false, error: "这次运行已经收场" }, 404));

    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await flush(40);
    click(stopBtn());
    await flush(40);

    const rows = [...dock().querySelectorAll(".neo-agent-step")].map((e) => e.textContent);
    assert.ok(rows.some((x) => x.includes("已取消") && x.includes("取消失败")),
        `取消请求失败要留在时间线上：${rows.join(" | ")}`);
});

test("后端发出取消帧：时间线收场，生成键回到✨ 生成", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([
        { kind: "run", run_id: RUN_ID },
        { kind: "content", text: "已取消：智能体循环与在跑的任务已停止" },
    ]);

    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await flush(40);

    assert.equal(finalRow().textContent.trim(), "已取消：智能体循环与在跑的任务已停止");
    assert.equal(runBtn().textContent, "✨ 生成");
    assert.equal(runBtn().disabled, false);
    assert.ok(!runBtn().classList.contains("neo-agent-paused"), "收场后应去掉暂停态样式");
    assert.equal(stopBtn().disabled, true, "收场后停止键锁回去");
});

test("后端报错帧：时间线显示错误原文，不留缩略图，解禁生成按钮", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentRaw(["data: [ERROR] 技能 sk_gen 没有工作流模板（workflow.json）"]);

    inputText(dock().querySelector(".neo-agent-input"), "一只柴犬");
    click(runBtn());
    await flush(40);

    assert.ok(finalRow().textContent.includes("技能 sk_gen 没有工作流模板（workflow.json）"), "应显示后端错误原文");
    assert.ok(finalRow().classList.contains("neo-agent-answer-error"), "错误行应标红");
    assert.equal(finalRow().querySelector("img"), null, "失败时不应有缩略图");
    assert.equal(runBtn().disabled, false, "失败后应解禁生成按钮");
});

// ====== 栏子本体：默认收起、开合与宽度落盘、分隔条拖动（样式与左栏那条共用） ======
const body = () => document.querySelector(".ns-body");
const split = () => document.querySelector(".ns-body > .ns-director-colsplit");
const toggleBtn = () => document.getElementById("ns-agent-toggle");
const pref = () => JSON.parse(localStorage.getItem("neo_studio_agent_dock") || "{}");
const widthVar = () => body().style.getPropertyValue("--ns-agent-w");
const mouse = (type, x = 0) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 0 });
const key = (k) => split().dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

test("右栏默认收起：顶栏按钮开合，开合状态落盘", async () => {
    mountStudio();
    localStorage.removeItem("neo_studio_agent_dock");
    await openStudio("#/gallery", false);

    assert.ok(dock().classList.contains("ns-hidden"), "默认不展开右栏");
    assert.ok(!toggleBtn().classList.contains("ns-agent-toggle-on"), "收起时顶栏按钮不高亮");
    assert.ok(split(), "右栏分隔条存在");
    const at = (el) => [...body().children].indexOf(el);
    assert.ok(at(split()) > at(document.getElementById("ns-view")), "分隔条在页面视图右侧");
    assert.ok(at(split()) < at(dock()), "分隔条在栏子左侧");

    click(toggleBtn());
    assert.ok(!dock().classList.contains("ns-hidden"), "点顶栏按钮展开右栏");
    assert.ok(toggleBtn().classList.contains("ns-agent-toggle-on"), "展开时按钮高亮");
    assert.equal(pref().closed, false, "展开状态落盘");
    click(toggleBtn());
    assert.ok(dock().classList.contains("ns-hidden"), "再点一次收起整栏");
    assert.equal(pref().closed, true, "收起状态落盘");
});

test("存过展开与宽度：开局按存盘展开并回灌栏宽", async () => {
    mountStudio();
    localStorage.setItem("neo_studio_agent_dock", JSON.stringify({ w: 420, closed: false }));
    await openStudio("#/gallery", false);

    assert.ok(!dock().classList.contains("ns-hidden"), "存过展开就开局展开");
    assert.equal(widthVar(), "420px", "回灌存盘宽度");
});

test("右栏分隔条：拖动调宽落盘，拖过收起阈值关栏，方向键 / 双击展开落回原宽度", async () => {
    mountStudio();
    localStorage.removeItem("neo_studio_agent_dock");
    await openStudio("#/gallery", false);
    click(toggleBtn());

    // 拖动：宽度写进内联样式并落盘（jsdom 无布局，clientWidth=0 → 钳到下限 260）
    split().dispatchEvent(mouse("mousedown", 900));
    assert.ok(body().classList.contains("ns-colsplit-drag"), "拖动中关掉宽度过渡");
    window.dispatchEvent(mouse("mousemove", 700));   // 往左拖 200px
    assert.equal(widthVar(), "260px", "拖动写入右栏宽度");
    window.dispatchEvent(mouse("mouseup", 700));
    assert.ok(!body().classList.contains("ns-colsplit-drag") && !split().classList.contains("ns-colsplit-drag"), "松手恢复过渡");
    assert.equal(pref().w, 260, "宽度落盘");
    assert.equal(pref().closed, false, "下限之上不算收起");

    // 键盘微调走同一套收起阈值：jsdom 无布局（栏子 offsetWidth=0），按方向键落进阈值即收起
    key("ArrowLeft");
    assert.ok(body().classList.contains("ns-agent-closed"), "键盘微调过收起阈值就关掉整栏");
    assert.equal(pref().closed, true, "收起状态落盘");
    assert.equal(pref().w, 260, "收起不抹掉宽度");
    key("ArrowLeft");
    assert.ok(!body().classList.contains("ns-agent-closed"), "收起态按方向键展开");
    assert.equal(widthVar(), "260px", "展开落回收起前那一档宽度");

    split().dispatchEvent(mouse("dblclick"));
    assert.ok(body().classList.contains("ns-agent-closed"), "双击收起整栏");
    split().dispatchEvent(mouse("dblclick"));
    assert.ok(!body().classList.contains("ns-agent-closed"), "再双击展开");
    assert.equal(widthVar(), "260px", "展开仍是收起前那一档宽度");
});

const ASK_ID = "ab".repeat(16);
const modeBtns = () => [...dock().querySelectorAll(".neo-agent-mode-btn")];
const answerCalls = () => fetchLog.filter((c) => c.path === "/neo_agent/answer");

/** 发完这批帧就挂住的流：后端在 ask_user 上等用户点选时，这条 SSE 就是开着的，
 *  run_id 也才留在页面上——回答请求要拿它认这次运行。 */
function mockPendingRunFrames(frames) {
    mockRoute("/neo_agent/run", () => ({
        ok: true,
        status: 200,
        body: {
            getReader: () => {
                const chunks = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`);
                let i = 0;
                return {
                    async read() {
                        if (i < chunks.length) return { done: false, value: new TextEncoder().encode(chunks[i++]) };
                        return new Promise(() => {});   // 等用户点选，这条流不收场
                    },
                    releaseLock() {},
                };
            },
        },
    }));
}

test("输入区：主按钮在顶、上下文条只读、底栏有附件图 / 停止 / 模式开关，默认停在执行", async () => {
    mountStudio();
    await openStudio("#/gallery");

    const composer = dock().querySelector(".neo-agent-composer");
    assert.equal(composer.children[0], runBtn(), "主按钮应铺在输入区顶上");
    assert.equal(composer.children[1], ctxBar(), "主按钮下面应是只读上下文条");
    assert.deepEqual(modeBtns().map((b) => b.dataset.mode), ["plan", "act"], "应有计划与执行两档");
    assert.ok(modeBtns()[1].classList.contains("active"), "默认应停在执行模式");
    assert.ok(dock().querySelector(".neo-agent-attach"), "应有附件图入口");
    assert.ok(stopBtn(), "底栏应有停止键");
    assert.equal(stopBtn().disabled, true, "空闲时停止键锁着");
    const file = dock().querySelector(".neo-agent-file");
    assert.equal(file.type, "file", "附件入口应挂在文件选择上");
    assert.equal(file.accept, "image/*", "附件只收图片");
    assert.ok(dock().querySelector(".neo-agent-chips"), "应有附件缩略图容器");
});

test("切页与切绘画模式：上下文条跟着宿主走，请求带的是切过之后的状态", async () => {
    mountStudio();
    await openStudio("#/gallery");
    assert.ok(ctxBar().textContent.includes("素材库"), `素材页应报素材库：${ctxBar().textContent}`);

    click(document.querySelector('.ns-tabs a[data-tab="paint"]'));
    await flush(40);
    assert.ok(ctxBar().textContent.includes("绘画页"), `切页后应报绘画页：${ctxBar().textContent}`);
    assert.ok(ctxBar().textContent.includes("文生图"), `绘画页应报出当前模式：${ctxBar().textContent}`);

    click([...document.querySelectorAll(".ns-paint-mode-btn")][1]);
    await flush(20);
    assert.ok(ctxBar().textContent.includes("图片编辑"), `切模式后应报图片编辑：${ctxBar().textContent}`);

    mockAgentStream([{ kind: "content", text: "好" }]);
    inputText(dock().querySelector(".neo-agent-input"), "把这张图改成夜景");
    click(runBtn());
    await flush(40);
    assert.equal(agentCalls()[0].body.context.page, "paint", "请求应带上切过之后的页");
    assert.equal(agentCalls()[0].body.context.paint_mode, "edit", "请求应带上切过之后的绘画模式");
});

test("点计划模式：请求带 mode=plan，回合头写明计划，收尾解禁模式按钮", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([
        { kind: "plan", text: "计划：先扩写提示词再出图" },
        { kind: "content", text: "计划已给出" },
    ]);

    click(modeBtns()[0]);
    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await flush(40);

    const calls = agentCalls();
    assert.equal(calls.length, 1, "应发出一次智能体请求");
    assert.equal(calls[0].body.mode, "plan", "请求应带上计划模式");
    assert.ok(meta().textContent.includes("计划"), "回合头应写明这一轮是计划");
    assert.equal(modeBtns()[0].disabled, false, "收尾后应解禁模式按钮");
});

test("选项确认卡：点选项按 run_id 与 ask_id 回答，答完锁住选项", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockRoute("/neo_agent/answer", () => jsonResponse({ success: true }));
    mockPendingRunFrames([
        { kind: "run", run_id: RUN_ID },
        { kind: "tool_call", tool: "ask_user", text: "{\"question\":\"要哪种结尾？\"}" },
        { kind: "ask", ask_id: ASK_ID, text: "要哪种结尾？", options: ["淡出", "定格"] },
    ]);

    inputText(dock().querySelector(".neo-agent-input"), "出个片");
    click(runBtn());
    await flush(40);

    const card = dock().querySelector(".neo-agent-choice");
    assert.ok(card, "应渲染选项确认卡");
    const opts = [...card.querySelectorAll(".neo-agent-choice-opt")];
    assert.deepEqual(opts.map((b) => b.textContent), ["淡出", "定格"], "应列出后端给的选项");

    click(opts[0]);
    await flush(20);
    const calls = answerCalls();
    assert.equal(calls.length, 1, "点选项应发一次 /neo_agent/answer");
    assert.deepEqual(calls[0].body, { run_id: RUN_ID, ask_id: ASK_ID, text: "淡出" },
                     "回答应带上首帧的 run_id 与 ask 帧的 ask_id");
    assert.equal(card.querySelector(".neo-agent-choice-chosen").textContent, "✔ 淡出", "应留下所选方向");
    assert.ok(opts.every((b) => b.disabled), "答完要锁住选项，不给第二次改口");
});

test("选项确认卡：自由输入走同一个回答请求", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockRoute("/neo_agent/answer", () => jsonResponse({ success: true }));
    mockPendingRunFrames([
        { kind: "run", run_id: RUN_ID },
        { kind: "ask", ask_id: ASK_ID, text: "要哪种结尾？", options: ["淡出"] },
    ]);

    inputText(dock().querySelector(".neo-agent-input"), "出个片");
    click(runBtn());
    await flush(40);

    const card = dock().querySelector(".neo-agent-choice");
    inputText(card.querySelector(".neo-agent-choice-free"), "定格三秒再淡出");
    click(card.querySelector(".neo-agent-choice-send"));
    await flush(20);

    const calls = answerCalls();
    assert.equal(calls.length, 1, "自由输入应发一次回答");
    assert.equal(calls[0].body.text, "定格三秒再淡出", "应把用户自己写的方向交回去");
});

test("拖入图片：进附件缩略图，发送时随请求体走并清空", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "图里是一只橘猫" }]);

    dropFiles(dock().querySelector(".neo-agent-composer"), [makeFile("cat.png", "image/png")]);
    await sleep(40);
    assert.ok(dock().querySelector(".neo-agent-chip img"), "拖入的图片应进附件缩略图");

    inputText(dock().querySelector(".neo-agent-input"), "这张图能做什么");
    click(runBtn());
    await flush(40);

    const calls = agentCalls();
    assert.equal(calls[0].body.images.length, 1, "请求应带上附件图");
    assert.ok(calls[0].body.images[0].data.startsWith("data:image/"), "附件图应带 data URI");
    assert.equal(calls[0].body.images[0].kind, "data", "附件图按图片源口径给后端");
    assert.equal(dock().querySelector(".neo-agent-chip"), null, "发送后附件应清空，不串到下一轮");
    assert.ok(dock().querySelector(".neo-agent-ask-media img"), "回合里应留下附件缩略图");
});

// 素材库卡片只带自定义 MIME，dataTransfer 里没有文件（与画廊拖放用例同一载荷）
function dropGalleryCard(el, payload) {
    const ev = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", {
        value: { files: [], getData: (m) => (m === "application/x-neo-gallery" ? JSON.stringify(payload) : "") },
        configurable: true,
    });
    el.dispatchEvent(ev);
}

test("素材库卡片拖入：copy_to_input 落盘后进附件，发送时按 input 文件名给后端", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "g1.png" }));
    mockAgentStream([{ kind: "content", text: "图里是一只橘猫" }]);

    dropGalleryCard(dock().querySelector(".neo-agent-composer"), { filename: "橘猫.png", subfolder: "角色" });
    await sleep(40);

    const chip = dock().querySelector(".neo-agent-chip img");
    assert.ok(chip, "素材库拖入的图片应进附件缩略图");
    assert.ok(chip.src.includes("/view?filename=g1.png&type=input"), `缩略图应指向 input 目录：${chip.src}`);
    const copied = fetchLog.find((c) => c.path === "/neo_gallery/copy_to_input");
    assert.equal(copied?.query.get("filename"), "橘猫.png", "应按卡片给的素材名复制");
    assert.equal(copied?.query.get("subfolder"), "角色", "应按卡片给的相对子路径复制");

    inputText(dock().querySelector(".neo-agent-input"), "这张图能做什么");
    click(runBtn());
    await flush(40);

    const calls = agentCalls();
    assert.equal(calls.length, 1, "应发出一次智能体请求");
    assert.equal(calls[0].body.images.length, 1, "请求应带上附件图");
    assert.deepEqual(calls[0].body.images[0], { kind: "input", value: "g1.png" },
                     "素材库图按 input 目录文件名给后端，不再灌 base64");
    assert.ok(dock().querySelector(".neo-agent-ask-media img"), "回合里应留下附件缩略图");
});

test("素材库拖入视频卡片：拒绝并提示，不进附件也不带进请求", async () => {
    mountStudio();
    await openStudio("#/gallery");
    appState.toasts.length = 0;
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "clip.mp4" }));
    mockAgentStream([{ kind: "content", text: "好" }]);

    dropGalleryCard(dock().querySelector(".neo-agent-composer"), { filename: "clip.mp4", subfolder: "" });
    await flush(20);

    assert.equal(dock().querySelector(".neo-agent-chip"), null, "视频不该进附件");
    assert.ok(appState.toasts.some((x) => x.detail.includes("视频")),
              `应写明不能当参考图：${JSON.stringify(appState.toasts)}`);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_gallery/copy_to_input").length, 0,
                 "拒绝的素材不该被复制进 input");

    inputText(dock().querySelector(".neo-agent-input"), "出个片");
    click(runBtn());
    await flush(40);
    assert.equal(agentCalls()[0].body.images.length, 0, "被拒绝的拖入不该带进请求");
});

test("拖进来的是文字不是素材卡片：静默放过，不进附件也不提示", async () => {
    mountStudio();
    await openStudio("#/gallery");
    appState.toasts.length = 0;

    const ev = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", {
        value: { files: [], getData: (m) => (m === "application/x-neo-gallery" ? "" : "一段拖出来的文字") },
        configurable: true,
    });
    dock().querySelector(".neo-agent-composer").dispatchEvent(ev);
    await flush(20);

    assert.equal(dock().querySelector(".neo-agent-chip"), null, "文字不该变成附件");
    assert.equal(appState.toasts.length, 0, "拖文字不是失败，不该弹提示");
});

