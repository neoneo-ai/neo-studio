// 右栏智能体：没有技能下拉，主按钮在顶上（生成 / 暂停 / 继续），界面当前状态随请求体交后端；
// 出图与出片一律走后端 /neo_agent/run 的 SSE 时间线，面板自己不发 /neo_image_gen/generate，
// 也不发流式提示词请求。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, jsonResponse, sseResponse, click, keydown, inputText, fetchLog, dropFiles, makeFile, pasteClipboard, setConfirmAnswer, dialogs } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";
import { app as studioApp } from "../../web/studio/shim/app.js";
import { setLang } from "../../web/js/core/i18n.js";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];
const cssText = fs.readFileSync(path.join(webDir, "agent-panel.css"), "utf8");

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?skill=${seq++}`);

const SKILLS = [
    { id: "sk_cat", name: "cat_prompt", cn_name: "橘猫技能", category: "image_enhance", tags: [] },
    { id: "sk_dog", name: "dog_prompt", cn_name: "柴犬技能", category: "image_enhance", tags: [] },
    { id: "sk_gen", name: "krea2_gen", cn_name: "Krea2 出图", category: "image_gen", gen_image: true, has_workflow: true, tags: [] },
];

function mountStudio() {
    resetEnv();
    localStorage.removeItem("neo_studio_agent_ctx_on");   // 这条开关跨用例串味：每条用例从默认不带你开始
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
const cancelBar = () => dock().querySelector(".neo-agent-cancelbar");
const meta = () => dock().querySelector(".neo-agent-meta");
const metaLines = () => [...dock().querySelectorAll(".neo-agent-meta")];
const ctxOffBtn = () => dock().querySelector(".neo-agent-ctx-off-btn");
const ctxEnabled = () => !ctxBar().classList.contains("neo-agent-ctx-off");
// 界面上下文默认不带：要把宿主界面状态交进请求的用例先点条启用
const enableCtx = () => { if (!ctxEnabled()) click(ctxBar()); };
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

test("右栏没有技能下拉：主按钮在底栏右下角，上下文条画出宿主交来的界面状态", async () => {
    mountStudio();
    await openStudio("#/gallery");

    assert.equal(dock().querySelector(".neo-agent-composer select"), null, "右栏不该再有技能下拉");
    assert.ok(dock().querySelector(".neo-agent-skill").hidden, "没点名技能时那颗 chip 不占位");
    const toolbar = dock().querySelector(".neo-agent-toolbar");
    assert.equal(toolbar.lastElementChild, runBtn(), "主按钮应是底栏最右一个");
    assert.equal(runBtn().textContent, "✨ 生成", "空闲时主按钮是生成");
    assert.ok(cancelBar().hidden, "没跑起来就没有取消键：空闲时那一行不占位");
    assert.ok(!ctxEnabled() && ctxBar().textContent.includes("点此启用"),
        `界面上下文默认不带：${ctxBar().textContent}`);
    enableCtx();
    assert.ok(ctxBar().textContent.includes("素材库"), `上下文条应画出当前页：${ctxBar().textContent}`);
});

test("点生成：请求带界面上下文，出计划行与最终回答，面板不发流式提示词", async () => {
    mountStudio();
    await openStudio("#/gallery");
    enableCtx();
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

const askBox = () => dock().querySelector(".neo-agent-input");
// keydown 走 helpers 的 keydown() 拿不到 defaultPrevented，用例要断言「这一下有没有被抢」，自己发事件
const pressKey = (el, k) => {
    const ev = new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
};

test("输入框上下箭头翻历史输入：光标贴边进历史，连按一路翻，草稿腾开还在", async () => {
    localStorage.removeItem("neo_studio_agent_history");
    mountStudio();
    await openStudio("#/gallery");
    const send = async (text) => {
        mockAgentStream([{ kind: "content", text: "好了" }]);
        inputText(askBox(), text);
        click(runBtn());
        await flush(40);
    };
    await send("第一条需求");
    await send("第二条需求");

    inputText(askBox(), "写了一半的草稿");
    askBox().setSelectionRange(0, 0);
    assert.ok(pressKey(askBox(), "ArrowUp"), "光标贴在最前按 ↑ 应进历史");
    assert.equal(askBox().value, "第二条需求", "↑ 先翻到最近发出去的那一条");
    pressKey(askBox(), "ArrowUp");
    assert.equal(askBox().value, "第一条需求", "进了历史之后连按 ↑ 一路往更早翻");
    pressKey(askBox(), "ArrowUp");
    assert.equal(askBox().value, "第一条需求", "翻到最早一条就停住，不换文本");
    pressKey(askBox(), "ArrowDown");
    assert.equal(askBox().value, "第二条需求", "↓ 往回走到更新的上一条");
    pressKey(askBox(), "ArrowDown");
    assert.equal(askBox().value, "写了一半的草稿", "翻过最新一条应回到自己写了一半的草稿");
    assert.equal(pressKey(askBox(), "ArrowDown"), false, "回到草稿之后再按 ↓ 不该抢键");

    // 多行提示词：光标落在中间，那一下归光标自己，文本不该被历史顶替
    inputText(askBox(), "第一行\n第二行");
    askBox().setSelectionRange(4, 4);
    assert.equal(pressKey(askBox(), "ArrowUp"), false, "光标在中间按 ↑ 不该抢键");
    assert.equal(askBox().value, "第一行\n第二行", "光标在中间时不许把文本换成历史");

    // 写了一句新话、光标停在句尾：↑ 顶成最近发出去的那一条，自己那句腾开成草稿（bash 句尾口径）
    inputText(askBox(), "新写的一句");
    askBox().setSelectionRange(5, 5);
    assert.ok(pressKey(askBox(), "ArrowUp"), "光标贴在句尾按 ↑ 应顶成历史");
    assert.equal(askBox().value, "第二条需求", "句尾的 ↑ 先翻到最近发出去的那一条");
    pressKey(askBox(), "ArrowDown");
    assert.equal(askBox().value, "新写的一句", "↓ 走过最新一条交回自己写的那句");

    // 共享工厂的口径：光标落在第一行（哪怕带着选区）按 ↑ 就顶历史；多行文本里光标到第二行才交回光标
    askBox().setSelectionRange(0, 4);
    assert.ok(pressKey(askBox(), "ArrowUp"), "光标在第一行带选区按 ↑ 同绘画页口径顶历史");
    assert.equal(askBox().value, "第二条需求", "第一行按 ↑ 顶成最近发出去的那一条");

    assert.deepEqual(JSON.parse(localStorage.getItem("neo_studio_agent_history")), ["第二条需求", "第一条需求"],
        "发出去的原文按最近在前存进本机历史");
});

test("工具卡的参数与返回：JSON 展开成缩进多行，长载荷在块内滚动而不是截断", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([
        { kind: "tool_call", tool: "list_models", text: '{"q":"刘亦菲","group":"loras","limit":120}' },
        {
            kind: "tool_result", tool: "list_models",
            text: '{"loras":[{"name":"krea2_刘亦菲.safetensors","dir":"krea2/"},{"name":"zi_lyf.safetensors","dir":"stars/"}],"matched":2,"truncated":false}',
        },
        { kind: "tool_call", tool: "generate_prompt", text: '{"text":"古装美女"}' },
        { kind: "tool_result", tool: "generate_prompt", text: "一位身着华丽繁复古装的绝世美女，眼神神秘而高贵。" },
        { kind: "content", text: "好" },
    ]);
    inputText(dock().querySelector(".neo-agent-input"), "找刘亦菲的 LoRA");
    click(runBtn());
    await flush(40);

    const cards = [...dock().querySelectorAll(".neo-agent-tool")];
    assert.equal(cards.length, 2, "应有两张工具卡");
    const args = cards[0].querySelector(".neo-agent-tool-args");
    const out = cards[0].querySelector(".neo-agent-tool-out");
    assert.ok(args.textContent.includes("\n  \"q\""), `参数要展开成缩进多行：${args.textContent}`);
    assert.deepEqual(JSON.parse(args.textContent), { q: "刘亦菲", group: "loras", limit: 120 },
        "展开后的参数解析回来要原样相等");
    assert.ok(out.textContent.split("\n").length > 4, `长返回要铺成多行：${out.textContent}`);
    assert.equal(JSON.parse(out.textContent).loras.length, 2, "展开后的返回解析回来要原样相等");
    // 解析不动的原文（人话回答）一个字都不动
    assert.equal(cards[1].querySelector(".neo-agent-tool-out").textContent,
        "一位身着华丽繁复古装的绝世美女，眼神神秘而高贵。", "非 JSON 的返回照原文铺");

    assert.match(cssText, /\.neo-agent-tool-args,\s*\.neo-agent-tool-out\s*\{[^}]*overflow:\s*auto;/,
        "参数与返回要块内滚动");
    assert.doesNotMatch(cssText, /\.neo-agent-tool-args,\s*\.neo-agent-tool-out\s*\{[^}]*overflow:\s*hidden;/,
        "定高配 hidden 会把 JSON 尾巴吃掉");
    assert.match(cssText, /\.neo-agent-tool-out::-webkit-scrollbar\s*\{/);
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
    assert.deepEqual([...runBtn().children].map((s) => s.textContent), ["⏸ ", "暂停"],
        "翻态要重建图标与文字两段，图标 span 带尾随空格");
    assert.ok(!cancelBar().hidden, "跑起来了取消键就要在：Cline 只在运行中给一行取消");
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

test("点整行取消：断流并按 run_id 发取消，时间线补一行已取消，取消行收掉", async () => {
    mountStudio();
    await openStudio("#/gallery");
    let signal = null;
    mockPendingRunStream((s) => { signal = s; });
    mockRoute("/neo_agent/cancel", () => jsonResponse({ success: true, run_id: RUN_ID, task_id: "" }));

    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await flush(40);
    assert.ok(!signal.aborted, "没点取消时这条流不能被断");

    click(cancelBar());
    await flush(40);

    assert.ok(signal.aborted, "取消必须断掉 SSE 流");
    const calls = cancelCalls();
    assert.equal(calls.length, 1, "点取消应发一次 /neo_agent/cancel");
    assert.deepEqual(calls[0].body, { run_id: RUN_ID }, "取消请求应带上后端首帧给的 run_id");
    const rows = [...dock().querySelectorAll(".neo-agent-step")].map((e) => e.textContent);
    assert.ok(rows.some((x) => x.includes("已取消")), `应有已取消行：${rows.join(" | ")}`);
    assert.equal(dock().querySelector(".neo-agent-answer-error"), null, "断流是预期收场，不该报生成失败");
    assert.ok(cancelBar().hidden, "取消已按下，那一行不该留在收场后的输入区");
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
    click(cancelBar());
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

test("输入区：一块深底输入卡收整排控件，上下文条只读、取消行只在运行中出现、底栏一行有附件图 / MCP 入口 / 模式开关 / 主按钮，默认停在执行", async () => {
    mountStudio();
    await openStudio("#/gallery");

    const composer = dock().querySelector(".neo-agent-composer");
    const field = composer.querySelector(".neo-agent-field");
    const resumeBar = dock().querySelector(".neo-agent-resumebar");
    assert.equal(field, composer.lastElementChild, "输入区里只该有一块输入卡");
    assert.equal(field.children[0], ctxBar(), "卡顶上应是只读上下文条");
    assert.deepEqual([...ctxBar().children].map((el) => el.className),
        ["neo-agent-skill", "neo-agent-ctx-text", "neo-agent-ctx-off-btn"],
        "点名那颗排在这行最左，界面状态与它的 ✕ 收在右侧：界面状态优先级低于技能");
    assert.equal(field.children[1], resumeBar, "续聊条铺在取消行上面");
    assert.equal(field.children[2], cancelBar(), "取消行应铺在文本框上面");
    const retryBar = dock().querySelector(".neo-agent-retrybar");
    assert.equal(field.children[3], retryBar, "失败重发那一行铺在文本框上面");
    assert.ok(retryBar.hidden, "空闲时没有失败可重发，那一行不占位");
    assert.equal(field.children[4], dock().querySelector(".neo-agent-input"), "重发行下面应是文本框");
    assert.equal(field.children[5], dock().querySelector(".neo-agent-chips"), "附件缩略图铺在文本框下面");
    assert.equal(field.lastElementChild, field.querySelector(".neo-agent-toolbar"),
        "附件缩略图下面只该有底栏这一行");
    assert.deepEqual(modeBtns().map((b) => b.dataset.mode), ["plan", "act"], "应有计划与执行两档");
    assert.ok(modeBtns()[1].classList.contains("active"), "默认应停在执行模式");
    assert.ok(dock().querySelector(".neo-agent-attach"), "应有附件图入口");
    assert.ok(dock().querySelector(".neo-agent-entry"), "应有 MCP 入口");
    assert.ok(cancelBar().hidden, "空闲时没有取消键");
    assert.ok(resumeBar.hidden, "没打开过旧会话时续聊条不占位");
    const file = dock().querySelector(".neo-agent-file");
    assert.equal(file.type, "file", "附件入口应挂在文件选择上");
    assert.equal(file.accept, "image/*", "附件只收图片");
    assert.ok(dock().querySelector(".neo-agent-chips"), "应有附件缩略图容器");

    // 底栏标签拆成图标 + 文字两段：整串 textContent 逐字不变，文字收掉后靠 aria-label 认钮
    assert.deepEqual([...runBtn().children].map((s) => s.className),
        ["neo-agent-btn-icon", "neo-agent-btn-text"], "主按钮应拆成图标与文字两段");
    assert.equal(runBtn().getAttribute("aria-label"), "✨ 生成", "整串标签要进 aria-label");
    assert.ok(runBtn().title, "主按钮要有悬停说明：只剩字形时靠它读全名");
    assert.deepEqual([...dock().querySelectorAll(".neo-agent-toolbar .neo-agent-btn-text")].map((s) => s.textContent),
        ["点名", "添加图片", "MCP", "计划", "执行", "生成"], "底栏每颗钮的文字段应各自独立成 span");
    assert.deepEqual([...dock().querySelectorAll(".neo-agent-toolbar .neo-agent-attach, .neo-agent-toolbar .neo-agent-entry, .neo-agent-toolbar .neo-agent-mode-btn")].map((b) => b.getAttribute("aria-label")),
        ["📎 添加图片", "🔌 MCP", "📝 计划", "⚡ 执行"], "每颗钮都要带上整串可访问名");
});

test("窄栏底栏的 CSS：composer 是容器、输入卡深底、焦点框只归整卡一条、底栏可换行、334px 以下只收文字段", () => {
    assert.match(cssText, /\.neo-agent-composer\s*\{[^}]*container-type:\s*inline-size;/);
    assert.match(cssText, /\.neo-agent-field\s*\{[^}]*background:\s*var\(--neo-vsc-bg\);/);
    assert.match(cssText, /\.neo-agent-field:has\(\.neo-agent-input:focus\)\s*\{[^}]*border-color:\s*var\(--neo-vsc-accent\);/);
    assert.ok(!/^\.neo-agent-field:focus-within/m.test(cssText), "整卡 :focus-within 会让底栏每颗钮都亮卡，焦点框就多了");
    assert.ok(!/^\.neo-agent-input:focus-visible/m.test(cssText), "文本框自己不再画焦点框：那一条归整卡");
    assert.match(cssText, /\.neo-agent-input\s*\{[^}]*background:\s*none;[^}]*border:\s*0;/);
    assert.match(cssText, /\.neo-agent-toolbar\s*\{[^}]*flex-wrap:\s*wrap;/);
    assert.match(cssText, /@container \(max-width: 334px\)\s*\{[^}]*\.neo-agent-toolbar \.neo-agent-btn-text\s*\{[^}]*display: none;/);
    assert.match(cssText, /\.neo-agent-ctx-off\s*\{[^}]*opacity:\s*\.45;[^}]*font-size:\s*10px;/,
        "默认不带的上下文条要收成淡小字，不跟正文抢视线");
    assert.match(cssText, /\.neo-agent-input::placeholder\s*\{[^}]*--neo-vsc-fg-faint\);[^}]*font-size:\s*12px;/,
        "占位提示压到 faint 一档：空框里的提示不跟正文同强度");
    assert.match(cssText, /\.neo-agent-run\s*\{[^}]*background:\s*var\(--neo-vsc-primary-soft\);[^}]*border:\s*0;/,
        "发送钮扁平：淡蓝底加主色字，实心胶囊加白字会把整排底栏顶起来");
    assert.match(cssText, /\.neo-agent-attach,\s*\.neo-agent-entry\s*\{[^}]*background:\s*none;[^}]*border:\s*0;/,
        "附件与 MCP 入口是同一条扁平文字钮规则");
    assert.match(cssText, /\.neo-agent-modes\s*\{[^}]*margin-left:\s*auto;\s*\}/,
        "模式开关没有胶囊壳：多一圈描边就是这一排多出来的重量");
    assert.ok(!/\.neo-agent-mode-btn\.active\s*\{[^}]*box-shadow/.test(cssText),
              "选中态只吃一层淡蓝底，内描边环会把它顶成一颗实心钮");
    assert.match(cssText, /\.neo-agent-skill\s*\{[^}]*background:\s*none;[^}]*border:\s*0;[^}]*color:\s*var\(--neo-vsc-accent\);/,
        "点名那颗是无底无框的一行浅蓝字：带底就成了一只按钮，清除完看着还剩一颗");
    assert.match(cssText, /\.neo-agent-skill\[hidden\]\s*\{\s*display:\s*none/,
        "清除后整颗必须消失：[hidden] 要压过 chip 自己的 inline-flex");
    assert.match(cssText, /@container \(max-width: 334px\)\s*\{[\s\S]*?\.neo-agent-skill-name,\s*\.neo-agent-skill-del\s*\{\s*display:\s*none/,
        "窄栏里收得只剩图标：图标加 ✕ 并排就是一只没名字的按钮");
    assert.match(cssText, /\.neo-agent-skill\s*\{[^}]*flex:\s*0 0 auto/,
        "点名那颗不许收缩：栏子一窄先没的该是右侧界面状态，技能被挤没就是优先级排反了");
    assert.match(cssText, /\.neo-agent-ctx-text\s*\{[^}]*flex:\s*0 1 auto;[^}]*margin-left:\s*auto;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/,
        "界面状态只吃自己那点内容宽度、贴右、单行省略：flex:1 会把它铺满整行，压过点名的技能");
    assert.ok(!/\.neo-agent-ctx\s*\{[^}]*background:\s*var\(--neo-vsc-bg-alt\)/.test(cssText),
        "上下文条这一行不铺实底：一层实底就是一只横条，比它要报的状态本身显眼");
    assert.match(cssText, /\.neo-agent-picker\s*\{[^}]*var\(--ns-panel/,
        "技能弹层挂 body 上，颜色吃 :root 的 --ns-*：吃 .neo-agent 的局部变量就是一路回落值");
});

test("切页与切绘画模式：上下文条跟着宿主走，请求带的是切过之后的状态", async () => {
    mountStudio();
    await openStudio("#/gallery");
    enableCtx();
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

test("界面上下文默认不带：点条启用后才带、条上的 ✕ 再关掉，这条选择存本机", async () => {
    mountStudio();
    await openStudio("#/gallery");
    click(document.querySelector('.ns-tabs a[data-tab="paint"]'));
    await flush(40);
    assert.ok(!ctxEnabled(), "默认不该带界面上下文");

    enableCtx();
    const modeLabel = ctxBar().textContent.includes("文生图") ? "文生图" : "图片编辑";
    assert.ok(ctxBar().textContent.includes("绘画页 · " + modeLabel),
        `启用后应报自己那一栏（模式存过就落回存过的那档）：${ctxBar().textContent}`);

    click(document.querySelector('.ns-tabs a[data-tab="skills"]'));
    await flush(40);
    assert.ok(ctxBar().textContent.includes("技能页"), `技能页应报技能页：${ctxBar().textContent}`);
    assert.ok(!ctxBar().textContent.includes("文生图") && !ctxBar().textContent.includes("图片编辑"),
        `离开绘画页不该再带它的模式：${ctxBar().textContent}`);

    mockAgentStream([{ kind: "content", text: "好" }]);
    click(ctxOffBtn());
    assert.ok(ctxBar().textContent.includes("不带界面上下文 · 点此启用") && !ctxBar().textContent.includes("📍"),
        `关掉要写明不带上下文，且不画那枚图钉：${ctxBar().textContent}`);
    inputText(dock().querySelector(".neo-agent-input"), "照我写的做，别管界面");
    click(runBtn());
    await flush(40);
    assert.equal(agentCalls()[0].body.context, null, "不带的轮次请求不带界面上下文");
    assert.ok(metaLines()[0].textContent.includes("不带界面上下文"),
        `回合头要写明这一轮没有上下文：${metaLines()[0].textContent}`);

    click(ctxBar());
    assert.ok(ctxBar().textContent.includes("技能页"), `点条把界面上下文点回来：${ctxBar().textContent}`);
    inputText(dock().querySelector(".neo-agent-input"), "接着来");
    click(runBtn());
    await flush(40);
    assert.equal(agentCalls()[1].body.context.page, "skills", "启用后请求重新带上当前页");
    assert.equal(localStorage.getItem("neo_studio_agent_ctx_on"), "1", "启用态写进本机存储");

    mountStudio();
    localStorage.setItem("neo_studio_agent_ctx_on", "1");   // 本机存过启用态：重载后沿用
    await openStudio("#/gallery");
    assert.ok(ctxEnabled(), "换页重载后沿用本机存的启用态");
});

test("素材库目录标了 👤 角色图：上下文带上这个标记，未标记的目录不带", async () => {
    mountStudio();
    await openStudio("#/gallery");
    // 画廊的标记判定在 gallery-main-dirs.test.mjs 里验；这里验宿主把这份事实交进请求体
    const view = { mode: "directory", source: "Cloud Presets", categoryPath: ["明朝人物"] };
    let marked = true;
    studioApp.neoGallery = { currentView: view, isCharacterDir: () => marked };
    enableCtx();
    mockAgentStream([{ kind: "content", text: "好" }]);
    inputText(dock().querySelector(".neo-agent-input"), "照这批设定图出个片");
    click(runBtn());
    await flush(40);
    assert.equal(agentCalls()[0].body.context.gallery_path, "Cloud Presets/明朝人物");
    assert.equal(agentCalls()[0].body.context.character_dir, true,
                 "角色图目录要带标记，右栏据此把新建配方出成全参考");
    assert.ok(metaLines()[0].textContent.includes("角色图"),
              `回合头应写明这是角色图目录：${metaLines()[0].textContent}`);

    marked = false;
    inputText(dock().querySelector(".neo-agent-input"), "这批不当角色图用");
    click(runBtn());
    await flush(40);
    assert.equal(agentCalls()[1].body.context.character_dir, undefined,
                 "未标记的目录不带这一栏（每图一段、图作首帧）");
    delete studioApp.neoGallery;   // 这一份替身只属于本用例：后面用例的上下文里没有素材库目录
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

// 最终回答末尾的「下一步选项」：模型在收场那段里自己列的方向
const OPT_ANSWER = [
    "第 1 段已按红色性感旗袍风格出片，产物是 cat_walk_seg1.mp4。",
    "",
    "### 下一步选项",
    "1. **继续生成第 2 段**（正面半身特写，同样应用“红色性感旗袍”风格）。",
    "2. 继续生成第 3 段（背影全景，同样应用“红色性感旗袍”风格）。",
    "3. 直接拼接已生成的片段（如果只想要这一段）。",
    "",
    "请告诉我您希望如何继续！",
].join("\n");
const OPT_ROWS = [
    "1. 继续生成第 2 段（正面半身特写，同样应用“红色性感旗袍”风格）。",
    "2. 继续生成第 3 段（背影全景，同样应用“红色性感旗袍”风格）。",
    "3. 直接拼接已生成的片段（如果只想要这一段）。",
];
const optRows = () => [...dock().querySelectorAll(".neo-agent-answer-opt")];

test("最终回答的下一步选项铺成一排可点方向：点一下就是把它当下一轮输入，选过的那组锁住", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: OPT_ANSWER }]);

    inputText(dock().querySelector(".neo-agent-input"), "先出第 1 段");
    click(runBtn());
    await flush(40);

    assert.deepEqual(optRows().map((b) => b.textContent), OPT_ROWS, `应把编号方向铺成可点的行：${optRows().map((b) => b.textContent).join(" | ")}`);
    assert.equal(finalRow().querySelector("ol"), null, "编号文本要换成按钮，不留一份重复的列表");
    assert.ok(finalRow().textContent.includes("请告诉我您希望如何继续"), "方向块之外的正文应照原样留下");
    assert.equal(dock().querySelector(".neo-agent-answer-opts-title").textContent, "▶ 下一步选项", "应带出回答里的标题");

    click(optRows()[1]);
    await flush(40);

    const picked = OPT_ROWS[1].slice(3);
    const calls = agentCalls();
    assert.equal(calls.length, 2, "点方向应直接发出下一轮请求");
    assert.equal(calls[1].body.text, picked, "请求文本应是所点的那一句方向");
    const first = dock().querySelector(".neo-agent-answer-opts");
    assert.equal(first.querySelector(".neo-agent-answer-chosen").textContent, "✔ " + picked, "应留下所选方向");
    assert.ok([...first.querySelectorAll(".neo-agent-answer-opt")].every((b) => b.disabled), "选过的那组锁住，不给第二次改口");
    assert.equal(optRows().length, OPT_ROWS.length * 2, "两轮各留一组方向");
    assert.ok(optRows().slice(OPT_ROWS.length).every((b) => !b.disabled), "收场后新一轮的方向按钮要可用");
});

test("没有方向标题的编号列表不铺成按钮：计划模式的步骤与正文里的编号照原文渲染", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([
        { kind: "plan", text: "分三步出片" },
        { kind: "content", text: ["计划如下：", "1. generate_prompt 扩写提示词", "2. generate_image 出图", "3. 产物入素材库"].join("\n") },
    ]);

    inputText(dock().querySelector(".neo-agent-input"), "出个片");
    click(runBtn());
    await flush(40);

    assert.equal(dock().querySelector(".neo-agent-answer-opts"), null, "无方向标题的编号列表不该铺成方向按钮");
    assert.ok(finalRow().querySelector("ol"), "编号列表应照原样渲染成文本");
});

test("拖入图片：进附件缩略图，发送时随请求体走并清空", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "图里是一只橘猫" }]);

    dropFiles(dock().querySelector(".neo-agent-composer"), [makeFile("cat.png", "image/png")]);
    // 附件图是 FileReader 真异步读出来的，CI 满载 runner 上固定 40ms 读不完，等到缩略图出现
    for (let i = 0; i < 50 && !dock().querySelector(".neo-agent-chip img"); i += 1) await sleep(20);
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

// ====== 附件图竞态与缺素材可见性 ======
// 用户以为「粘进输入框就是给了素材」：界面上的缩略图与请求体里的图必须同一份口径——粘贴 / 拖入 /
// 素材库拖入都是异步读出来的，生成这一步要等在飞读图上（不自动补发，发送始终是用户那一击）。
// 零素材那一发要在时间线上写明没带图；出片那一侧的闸门在后端（studio/agent.py 的缺素材闸）。
test("粘贴后立刻点生成：读图先落地，图进请求体，只发一次请求", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "图里是一只橘猫" }]);

    pasteClipboard(dock().querySelector(".neo-agent-input"), [makeFile("cat.png", "image/png")]);
    inputText(dock().querySelector(".neo-agent-input"), "这张图能做什么");
    click(runBtn());
    await until(() => agentCalls().length === 1, "生成这一步要等在飞读图，读完就发这一发");
    await flush(40);

    const calls = agentCalls();
    assert.equal(calls[0].body.images.length, 1, "粘贴的图要进请求体，不能停在零附件那一发");
    assert.ok(calls[0].body.images[0].data.startsWith("data:image/"), "附件图按 data URI 给后端");
    assert.equal(dock().querySelector(".neo-agent-chip"), null, "发送后附件清空");
    // 收场才离开这条用例：跑到最终回答再等流跑完，不把在飞的运行漏给下一条
    await until(() => dock().querySelector(".neo-agent-answer-body"), "这一发应跑到最终回答");
    await flush(40);
});

test("回合头写明这一发带几张图、零图那一发写明不带", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "两张都是橘猫" }]);

    pasteClipboard(dock().querySelector(".neo-agent-input"),
                   [makeFile("a.png", "image/png"), makeFile("b.png", "image/png")]);
    inputText(dock().querySelector(".neo-agent-input"), "看这两张图");
    click(runBtn());
    await until(() => agentCalls().length === 1, "两张图读完后应发出这一发");
    await flush(40);
    assert.ok(metaLines()[0].textContent.includes("附件图 2 张"),
              `回合头应写明图数：${metaLines()[0].textContent}`);
    assert.equal(agentCalls()[0].body.images.length, 2, "两张图都要进请求体");

    mockAgentStream([{ kind: "content", text: "换个说法" }]);
    inputText(dock().querySelector(".neo-agent-input"), "换个说法");
    click(runBtn());
    await until(() => agentCalls().length === 2, "第二发应发出");
    await flush(40);
    assert.ok(metaLines()[1].textContent.includes("不带附件图"),
              `零图那一发要写明不带：${metaLines()[1].textContent}`);
    assert.equal(agentCalls()[1].body.images.length, 0);
    await until(() => dock().querySelectorAll(".neo-agent-answer-body").length === 2, "第二发应跑到最终回答");
    await flush(40);
});

test("零附件零产物那一发：时间线上铺一行补素材的提醒", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "缺素材，先问方向" }]);

    inputText(dock().querySelector(".neo-agent-input"), "做个品牌宣传片，参考我们的 logo 和 APP 界面");
    click(runBtn());
    await until(() => dock().querySelector(".neo-agent-no-media"), "零附件零产物应铺出补素材提醒");
    assert.ok(dock().querySelector(".neo-agent-no-media").textContent.includes("没有附件图"),
              `提醒行应写明缺什么：${dock().querySelector(".neo-agent-no-media").textContent}`);
    await flush(20);
});

test("产物到了、带了图、计划模式收场：都不铺补素材提醒行", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([IMAGE_RESULT, { kind: "content", text: "出好了" }]);
    inputText(dock().querySelector(".neo-agent-input"), "画一只橘猫");
    click(runBtn());
    await until(() => agentCalls().length === 1 && finalRow(), "第一发应跑到最终回答");
    await flush(40);
    assert.equal(dock().querySelector(".neo-agent-no-media"), null, "有产物就不该提醒缺素材");

    mockAgentStream([{ kind: "content", text: "图里是一只橘猫" }]);
    dropFiles(dock().querySelector(".neo-agent-composer"), [makeFile("cat.png", "image/png")]);
    for (let i = 0; i < 50 && !dock().querySelector(".neo-agent-chip img"); i += 1) await sleep(20);
    inputText(dock().querySelector(".neo-agent-input"), "这张图能做什么");
    click(runBtn());
    await until(() => agentCalls().length === 2 && dock().querySelector(".neo-agent-ask-media img"),
                "带了图的第二发应跑到时间线上");
    await flush(40);
    assert.equal(dock().querySelector(".neo-agent-no-media"), null, "带了图的零产物不是缺素材");

    mockAgentStream([{ kind: "content", text: "计划已给出" }]);
    click(modeBtns().find((b) => b.dataset.mode === "plan"));
    inputText(dock().querySelector(".neo-agent-input"), "先规划一下");
    click(runBtn());
    await until(() => agentCalls().length === 3, "计划模式那一发应发出");
    await flush(40);
    assert.equal(agentCalls()[2].body.mode, "plan", "这一发是计划模式");
    assert.equal(dock().querySelector(".neo-agent-no-media"), null, "计划模式本就不出产物，不该提醒");
    await until(() => dock().querySelectorAll(".neo-agent-answer-body").length === 3, "计划那一发应跑到最终回答");
    await flush(40);
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

// ====== 智能体写配方 → 导演页配方列表：只有活回合的 tool_result 才广播保存事件 ======
// 后端把 director_save / director_copy 写进 recipes/custom/，界面这一侧唯一的刷新入口就是导演页
// 监听的那条事件：收不到就得等下一次建页。历史回放与计划模式都没有落盘，不该惊动配方列表。
const RECIPE_SAVED = { kind: "tool_result", tool: "director_save", text: '{"success":true,"name":"我的片子"}' };
const RECIPE_COPIED = { kind: "tool_result", tool: "director_copy", text: '{"success":true,"name":"我的片子·副本"}' };
const PLAN_REFUSED = { kind: "tool_result", tool: "director_save", text: "计划模式不执行 director_save" };

// director.js 一进来要连走 scripts/app.js 那一串的宿主桩，放在这一段才不拖累前面的用例；
// 配方列表与这条事件同源，监听方就是导演页左栏
const { DIRECTOR_RECIPE_SAVED_EVENT } = await import("../../web/director.js");
const savedEvents = [];
window.addEventListener(DIRECTOR_RECIPE_SAVED_EVENT, (e) => savedEvents.push(e.detail));
const savedToastTexts = () => appState.toasts.map((x) => x.detail || "");

async function until(fn, what) {
    for (let i = 0; i < 60; i++) {
        if (fn()) return;
        await sleep(10);
    }
    assert.fail(`等待超时：${what}`);
}

test("执行模式存配方：结果一落地就广播刚写的配方名，一次落盘只广播一次", async () => {
    mountStudio();
    await openStudio("#/gallery");
    appState.toasts.length = 0;
    savedEvents.length = 0;
    mockAgentStream([
        { kind: "tool_call", tool: "director_save", text: '{"name":"我的片子","segments":[1,2]}' },
        RECIPE_SAVED,
        { kind: "tool_result", tool: "director_run", text: '{"status":"succeeded","filename":"cat_walk.mp4"}' },
        { kind: "content", text: "配方已保存并出片" },
    ]);

    inputText(dock().querySelector(".neo-agent-input"), "把这一版存成配方");
    click(runBtn());
    await until(() => savedEvents.length, "director_save 的结果一落地就该广播配方名");
    await flush(20);

    assert.deepEqual(savedEvents, [{ name: "我的片子", created: true }],
        "只该按 director_save 的结果广播一次，出片结果不再报配方");
    assert.ok(savedToastTexts().some((s) => s.includes("我的片子")),
        `提示应写明刚存的配方名：${JSON.stringify(savedToastTexts())}`);
});

test("执行模式复制配方：副本按新名字广播", async () => {
    mountStudio();
    await openStudio("#/gallery");
    appState.toasts.length = 0;
    savedEvents.length = 0;
    mockAgentStream([RECIPE_COPIED, { kind: "content", text: "已复制一份" }]);

    inputText(dock().querySelector(".neo-agent-input"), "复制一份这个配方");
    click(runBtn());
    await until(() => savedEvents.length, "副本落盘就该广播副本名");
    await flush(20);

    assert.deepEqual(savedEvents, [{ name: "我的片子·副本", created: true }], "副本应按副本名广播");
});

test("计划模式：后端拒回的那一发不写文件，不广播保存事件也不弹提示", async () => {
    mountStudio();
    await openStudio("#/gallery");
    appState.toasts.length = 0;
    savedEvents.length = 0;
    mockAgentStream([
        { kind: "plan", text: "计划：director_plan → director_save → segment_run" },
        { kind: "tool_call", tool: "director_save", text: '{"name":"我的片子"}' },
        PLAN_REFUSED,
        { kind: "content", text: "已给出计划，未写任何配方" },
    ]);

    click(modeBtns()[0]);
    inputText(dock().querySelector(".neo-agent-input"), "出个片");
    click(runBtn());
    await until(() => toolCard(), "这一发的工具卡应铺进时间线");
    await flush(20);

    assert.equal(agentCalls()[0].body.mode, "plan", "请求应带计划模式");
    assert.ok(toolCard(), "时间线里应留下这一发的工具卡");
    assert.deepEqual(savedEvents, [], "计划模式没有落盘，不该广播保存事件");
    assert.equal(appState.toasts.length, 0, `拒回不是落盘，不该弹保存提示：${JSON.stringify(savedToastTexts())}`);
});

test("只读回放历史会话：会话里的配方落盘帧不广播保存事件、不弹提示、不发请求", async () => {
    mountStudio();
    await openStudio("#/gallery");
    appState.toasts.length = 0;
    savedEvents.length = 0;
    mockRoute("/neo_agent/sessions", jsonResponse({
        success: true,
        sessions: [{ run_id: "r-old", created: 111, mode: "act", status: "succeeded", text: "把这一版存成配方", tools: 1 }],
    }));
    mockRoute("/neo_agent/session", jsonResponse({
        success: true,
        session: {
            run_id: "r-old", created: 111, mode: "act", status: "succeeded", text: "把这一版存成配方",
            frames: [
                { kind: "run", run_id: "r-old" },
                { kind: "tool_call", tool: "director_save", text: '{"name":"我的片子"}' },
                RECIPE_SAVED,
                { kind: "content", text: "配方已保存" },
            ],
        },
    }));

    click(dock().querySelector('.neo-agent-head-btn[title="会话历史"]'));
    await until(() => dock().querySelector('.neo-agent-head-btn[title="读回这条会话的完整时间线"]'), "会话行铺出「打开」按钮");
    click(dock().querySelector('.neo-agent-head-btn[title="读回这条会话的完整时间线"]'));
    await until(() => finalRow(), "会话里的回答铺回时间线");

    assert.ok(toolCard(), "会话里的工具卡应照原样铺回时间线");
    assert.equal(finalRow().textContent.trim(), "配方已保存", "会话里的回答应照原文铺出来");
    assert.equal(agentCalls().length, 0, "读回旧会话不该发智能体请求");
    assert.deepEqual(savedEvents, [], "旧会话里的落盘帧不是刚发生的落盘，不该广播保存事件");
    assert.equal(appState.toasts.length, 0, `读回会话不该弹保存提示：${JSON.stringify(savedToastTexts())}`);
    assert.equal(dock().querySelector(".neo-agent-resumebar").hidden, false, "读回后应给出「接上次会话」条");
});

const recentRows = () => [...dock().querySelectorAll(".neo-agent-recent-row")];
const historyDelBtns = () => [...dock().querySelectorAll('.neo-agent-head-btn[title="删除这条会话"]')];
const historyDelBtn = () => historyDelBtns()[0];
const historyCloseBtn = () => dock().querySelector('.neo-agent-head-btn[title="关闭会话列表"]');
const sessionDeleteCalls = () => fetchLog.filter((c) => c.path === "/neo_agent/session/delete");
const RECENT_SESSIONS = [0, 1, 2, 3, 4].map((i) => ({
    run_id: `r${i}`, created: 1000 + i, mode: "act", status: "succeeded", text: `第 ${i} 次`, tools: i,
}));

test("空态默认铺最近会话：五条只铺最近三条，点一行直接读回那条会话并挂出续聊条", async () => {
    mountStudio();
    mockRoute("/neo_agent/sessions", jsonResponse({ success: true, sessions: RECENT_SESSIONS }));
    mockRoute("/neo_agent/session", jsonResponse({
        success: true,
        session: {
            run_id: "r0", created: 1000, mode: "act", status: "succeeded", text: "第 0 次",
            frames: [{ kind: "run", run_id: "r0" }, { kind: "content", text: "上一轮的回答" }],
        },
    }));
    await openStudio("#/gallery");
    await until(() => recentRows().length === 3, "空态默认只铺最近 3 条");

    const rows = recentRows();
    assert.ok(rows[0].textContent.includes("第 0 次"), `第一行应是最新会话：${rows[0].textContent}`);
    assert.ok(dock().querySelector(".neo-agent-recent-all"), "空态应给出「查看全部」入口");

    click(rows[0]);
    await until(() => finalRow(), "点最近行应把那条会话的时间线铺回右栏");
    assert.equal(finalRow().textContent.trim(), "上一轮的回答", "应照原文铺出会话里的回答");
    assert.equal(dock().querySelector(".neo-agent-resumebar").hidden, false, "读回后应给出「接上次会话」条");
});

test("「查看全部」的整页列表带栏头：铺得开也收得回时间线", async () => {
    mountStudio();
    mockRoute("/neo_agent/sessions", jsonResponse({ success: true, sessions: RECENT_SESSIONS.slice(0, 2) }));
    await openStudio("#/gallery");
    await until(() => dock().querySelector(".neo-agent-recent-all"), "空态应先铺出「查看全部」入口");

    click(dock().querySelector(".neo-agent-recent-all"));
    await until(() => historyCloseBtn() && historyDelBtn(), "整页列表应铺出栏头关闭钮与会话行删除钮");
    assert.equal(dock().querySelector(".neo-agent-history").hidden, false, "列表应铺在右栏");
    assert.equal(dock().querySelector(".neo-agent-transcript").hidden, true, "列表铺开时时间线收起");

    click(historyCloseBtn());
    await until(() => dock().querySelector(".neo-agent-history").hidden
        && !dock().querySelector(".neo-agent-transcript").hidden, "关闭钮应把列表收回时间线");
    assert.ok(dock().querySelector(".neo-agent-history").contains(historyCloseBtn()),
        "关闭钮该藏在收回的列表里，下一次「🗂」重铺列表");
    assert.equal(recentRows().length, 2, "收回应落回带最近列表的空态");
});

test("列表里删除会话要二次确认：确认否掉不发删除请求，确认后删一条并重列", async () => {
    mountStudio();
    let deleted = 0;
    mockRoute("/neo_agent/sessions", () => jsonResponse({
        success: true, sessions: RECENT_SESSIONS.slice(deleted ? 1 : 0, 2),
    }));
    mockRoute("/neo_agent/session/delete", () => {
        deleted += 1;
        return jsonResponse({ success: true, deleted: 1 });
    });
    await openStudio("#/gallery");
    await until(() => dock().querySelector(".neo-agent-recent-all"), "空态应先铺出「查看全部」入口");

    click(dock().querySelector(".neo-agent-recent-all"));
    await until(() => historyDelBtn(), "会话行应给出删除钮");
    assert.ok(historyDelBtn().querySelector("svg path"), "删除钮应是 core/icons.js 的垃圾桶图标");

    setConfirmAnswer(false);
    click(historyDelBtn());
    await flush(20);
    assert.deepEqual(sessionDeleteCalls(), [], "确认框否掉时不该发删除请求");
    assert.ok(historyDelBtn(), "会话应还留在列表里");

    setConfirmAnswer(true);
    click(historyDelBtn());
    await until(() => sessionDeleteCalls().length === 1, "确认后应发出一次删除请求");
    assert.equal(dialogs.confirms.length, 2, "两次点击各问一次");
    await until(() => historyDelBtns().length === 1, "重列后列表里该只剩剩下那条会话");
});

test("新增会话：铺开的会话收回空态，续聊条断开，后端历史原样留着", async () => {
    mountStudio();
    mockRoute("/neo_agent/sessions", jsonResponse({ success: true, sessions: RECENT_SESSIONS.slice(0, 2) }));
    mockRoute("/neo_agent/session", jsonResponse({
        success: true,
        session: {
            run_id: "r0", created: 1000, mode: "act", status: "succeeded", text: "第 0 次",
            frames: [{ kind: "run", run_id: "r0" }, { kind: "content", text: "上一轮的回答" }],
        },
    }));
    await openStudio("#/gallery");
    await until(() => recentRows().length === 2, "开局空态应铺出两条最近会话");

    click(recentRows()[0]);
    await until(() => finalRow(), "点最近行应把会话铺回右栏");
    assert.equal(dock().querySelector(".neo-agent-resumebar").hidden, false, "读回后应挂出「接上次会话」条");

    click(dock().querySelector('.neo-agent-head-btn[title="新增会话"]'));
    await until(() => !finalRow() && recentRows().length === 2 && dock().querySelector(".neo-agent-resumebar").hidden,
        "新增会话应把时间线收回带最近列表的空态");

    const dels = fetchLog.filter((c) => String(c.path).startsWith("/neo_agent/session/delete"));
    assert.deepEqual(dels, [], "新增会话不该删后端任何会话");
});

// 导演页 fixture 与 studio-director.test.mjs 同一套。列表路由按「保存事件到过没有」决定新配方
// 可见不可见——后端写完文件列表才看得见，于是列表数量本身就是刷新发生在落盘之后的证据
const DIR_R1 = { name: "R1", type: "video_director", shared: { mode: "f2v" }, segments: [
    { skill_id: "sk-a", prompt: "段一", duration_sec: 3 },
    { skill_id: "sk-a", prompt: "段二", duration_sec: 4 }] };
const DIR_NEW = { name: "我的片子", type: "video_director", shared: { mode: "f2v" }, segments: [
    { skill_id: "sk-a", prompt: "雨夜街道", duration_sec: 5 }] };

function mockDirectorRoutes() {
    mockRoute("/rs_prompts/skills", jsonResponse([{ id: "sk-a", name: "技能 A", gen_video: true }]));
    mockRoute("/rs_recipes/list", () => jsonResponse(savedEvents.length ? [DIR_R1, DIR_NEW] : [DIR_R1]));
    mockRoute("/rs_recipes/director_spec", jsonResponse({
        success: true,
        segments: [
            { prompt: "段一", duration_sec: 3, ref_input: "" },
            { prompt: "段二", duration_sec: 4, ref_input: "" },
        ],
        defaults: { width: 640, height: 384, steps: 20 },
    }));
    mockRoute("/neo_video_gen/director_progress", jsonResponse({ active: false, segment_index: -1, total_segments: 0 }));
    mockRoute("/userdata/neo_recipes_data.json", jsonResponse({}));
    localStorage.setItem("neo_studio_director_side_col", JSON.stringify({ side: 240, lib: 420 }));
}

const dirCards = () => document.querySelectorAll(".ns-director-side .neo-recipes-card");
const dirSelected = () => document.querySelector(".neo-recipes-card-selected .neo-recipes-card-name span")?.textContent;

test("导演页在用时存配方：左栏立刻长出新配方并选中，右栏上下文跟着换配方", async () => {
    mountStudio();
    mockDirectorRoutes();
    appState.graph = { _nodes: [] };   // 无 Load* 节点 → 编辑器内无媒体候选
    appState.toasts.length = 0;
    savedEvents.length = 0;
    await openStudio("#/director");
    await until(() => dirCards().length === 1 && dirSelected() === "R1", "进页时左栏只有 R1 且自动选中");
    assert.ok(document.querySelector(".ns-gen-panel"), "下方生成面板已铺好");

    mockAgentStream([{ kind: "tool_call", tool: "director_save", text: '{"name":"我的片子"}' }, RECIPE_SAVED,
                     { kind: "content", text: "配方已保存" }]);
    enableCtx();
    inputText(dock().querySelector(".neo-agent-input"), "把这一版存成配方");
    click(runBtn());

    await until(() => dirCards().length === 2, "保存后左栏长出新配方");
    assert.deepEqual(savedEvents, [{ name: "我的片子", created: true }], "广播的是刚写的配方名");
    await until(() => dirSelected() === "我的片子", "新配方直接选中，下方生成面板跟着是它");
    await until(() => ctxBar().textContent.includes("我的片子"), "右栏上下文条跟着换配方");
    assert.ok(savedToastTexts().some((s) => s.includes("我的片子")),
        `应弹带配方名的保存提示：${JSON.stringify(savedToastTexts())}`);
});

test("导演页在用时切计划模式：不写配方就不重建配方列表，选中配方保持不动", async () => {
    mountStudio();
    mockDirectorRoutes();
    appState.graph = { _nodes: [] };
    appState.toasts.length = 0;
    savedEvents.length = 0;
    await openStudio("#/director");
    await until(() => dirCards().length === 1 && dirSelected() === "R1", "进页时左栏只有 R1 且自动选中");
    // 数 fetch 分不清谁发的：发送后输入框交回焦点会预热 @ 候选，配方那一条也在预热里。
    // 这条用例要拦的是左栏那一份列表被重建，认 DOM 那一块就行
    const cardBefore = dirCards()[0];

    mockAgentStream([{ kind: "plan", text: "计划：director_plan → director_save → segment_run" },
                     PLAN_REFUSED,
                     { kind: "content", text: "已给出计划，未写任何配方" }]);
    click(modeBtns()[0]);
    inputText(dock().querySelector(".neo-agent-input"), "出个片");
    click(runBtn());
    await flush(60);

    assert.equal(savedEvents.length, 0, "计划模式没有落盘，不该广播保存事件");
    assert.equal(dirCards()[0], cardBefore, "没有落盘就不重建左栏那一份列表");
    assert.equal(dirSelected(), "R1", "选中的配方照旧");
    assert.equal(dirCards().length, 1, "左栏列表照旧只有 R1");
});



test("发送后输入框清空并交回焦点，撑开的框高收回封顶值", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "已按素材库现状出图" }]);

    const input = dock().querySelector(".neo-agent-input");
    // jsdom 不排版：fitInput 读的就剩这一个数，撑开的高度要自己报
    Object.defineProperty(input, "scrollHeight", { get: () => 300, configurable: true });
    inputText(input, "一只橘猫\n".repeat(40));
    input.style.height = "480px";   // 长文本撑开（或用户拖过）的框高
    click(runBtn());
    await flush(40);

    assert.equal(input.value, "", "发送后输入框要清空，一条长提示词不留框");
    assert.equal(document.activeElement, input, "焦点要交回输入框，下一句直接写");
    assert.equal(input.style.height, "108px", "框高应收回封顶值，不留撑开的高度");
});

test("Esc 收掉写了一半的输入：框清空、框高收回，不发请求", async () => {
    mountStudio();
    await openStudio("#/gallery");
    const input = dock().querySelector(".neo-agent-input");
    Object.defineProperty(input, "scrollHeight", { get: () => 300, configurable: true });
    inputText(input, "写到一半的长提示词\n".repeat(30));
    input.style.height = "480px";
    keydown(input, "Escape");

    assert.equal(input.value, "", "Esc 应清空输入框");
    assert.equal(input.style.height, "108px", "Esc 后框高收回封顶值");
    assert.equal(agentCalls().length, 0, "Esc 不该发出请求");
});

test("一轮问答只有一枚图标复制钮：钉在最终回答之后，回合头不留第二枚", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "已按素材库现状出图" }]);
    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await until(() => dock().querySelector(".neo-agent-answer > .neo-agent-copy"), "最终回答要带复制按钮");

    const btn = dock().querySelector(".neo-agent-answer > .neo-agent-copy");
    assert.equal(dock().querySelectorAll(".neo-agent-copy").length, 1, "一枚就够，同一张卡片不并排两枚");
    assert.equal(dock().querySelector(".neo-agent-meta .neo-agent-copy"), null, "回合头右端不留复制钮");
    assert.ok(btn.querySelector("svg rect"), "钮面是 Cline 那枚叠角方块");
    assert.equal(btn.textContent, "", "钮面不写文案");
    assert.equal(btn.title, "", "不给 tooltip，提示全交给图标");
    assert.equal(btn.getAttribute("aria-label"), null, "连 aria-label 都不带");
});

test("复制钮只看图标：成功换对勾，两条路都不通换叉", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "已按素材库现状出图" }]);
    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await until(() => dock().querySelector(".neo-agent-answer > .neo-agent-copy"), "最终回答要带复制按钮");

    const btn = dock().querySelector(".neo-agent-answer > .neo-agent-copy");

    // 非安全上下文里 navigator.clipboard 缺席是常态：没有文案，成功与失败只能靠图标写出结果
    Object.defineProperty(window.navigator, "clipboard",
        { value: { writeText: async () => {} }, configurable: true });
    click(btn);
    await flush(1);
    assert.equal(btn.querySelector("svg path").getAttribute("d"), "M20 6 9 17l-5-5", "写入成功换对勾");

    const nativeCopy = document.execCommand;
    Object.defineProperty(window.navigator, "clipboard", {
        value: { writeText: async () => { throw new Error("clipboard denied"); } },
        configurable: true,
    });
    document.execCommand = () => false;   // navigator.clipboard 不可用时的原生退路，一并掐掉
    click(btn);
    await flush(1);
    assert.equal(btn.querySelector("svg path").getAttribute("d"), "M18 6 6 18", "两条路都不通换叉，不能演成对勾");
    document.execCommand = nativeCopy;
});

test("复制键在 capture 相位摘走，宿主注入的吞键 handler 接不到", async () => {
    mountStudio();
    await openStudio("#/gallery");
    const seen = [];
    document.addEventListener("keydown", (e) => seen.push(e.code), true);   // 挂在放行之后，模拟注入的那一套
    const input = dock().querySelector(".neo-agent-input");
    for (const [key, code] of [["c", "KeyC"], ["v", "KeyV"], ["x", "KeyX"], ["a", "KeyA"],
                               ["z", "KeyZ"], ["y", "KeyY"], ["l", "KeyL"]]) {
        keydown(input, key, { code, ctrlKey: true });
    }
    assert.deepEqual(seen, ["KeyL"], `放行名单内的键不该再往下传：${seen.join(" ")}`);
});

// ---------- 输入框 @ 点名（技能 / 主模型 / LoRA / 图像与视频提示词 / 配方；选择器与提示词页的 / 同一套工厂）----------
const pickerRows = () => [...document.querySelectorAll(".neo-agent-picker-row")];
const skillChip = () => dock().querySelector(".neo-agent-skill");

test("输入 @ 列出生成技能与正文型技能：生成在前、文案在后，选中随请求体交后端并留在上下文条", async () => {
    mountStudio();
    mockRoute("/rs_prompts/skills", jsonResponse([
        ...SKILLS,
        { id: "sk_film", name: "h3_film", cn_name: "H3 出片", gen_video: true, has_workflow: true, tags: [] },
        { id: "sk_nowf", name: "no_workflow", cn_name: "没有工作流", gen_image: true, tags: [] },
        { id: "sk_task", name: "task", cn_name: "任务技能", category: "task", tags: [] },
        { id: "sk_unavail", name: "unavail", cn_name: "缺插件的出片", gen_video: true, has_workflow: true, available: false, tags: [] },
    ]));
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "已出图" }]);

    const input = dock().querySelector(".neo-agent-input");
    inputText(input, "@");
    await sleep(20);   // 候选要过一次 fetch：微任务冲刷追不上这条链
    assert.deepEqual(pickerRows().map((r) => r.querySelector(".neo-agent-picker-name").textContent),
        ["🖼️ Krea2 出图", "🎬 H3 出片", "🧩 柴犬技能", "🧩 橘猫技能", "📚 R1"],
        "带 workflow 的生成技能在前，正文型技能（没有 workflow.json 的提示词 / 文案技能）排在后面，"
        + "本机有的配方也点得到——没有工作流的生图技能三条生成工具都跑不动，task 类点了没有产出");
    assert.deepEqual(pickerRows().map((r) => r.querySelector(".neo-agent-picker-meta").textContent),
        ["生图", "出片", "文案 / 分镜", "文案 / 分镜", "配方"], "行右侧标出这一发是哪一类");

    keydown(input, "Enter");
    await flush(5);
    assert.equal(pickerRows().length, 0, "提交后弹层要收掉");
    assert.equal(input.value, "@skill:Krea2_出图", "选中之后正文里留一个 @category:name 的记号，@ 与 query 那一段换掉");
    assert.ok(!skillChip().hidden && skillChip().textContent.includes("Krea2 出图"),
        `点名的技能要留在上下文条那一颗上：${skillChip().textContent}`);

    inputText(input, "@skill:Krea2_出图 一只橘猫");
    click(runBtn());
    await sleep(20); await flush(40);   // 整条 SSE 要过宏任务：冲刷不够的话下一条用例点第二发时还在「跑着」
    assert.equal(agentCalls()[0].body.skill_id, "sk_gen", "请求体带点名技能");
    assert.deepEqual(agentCalls()[0].body.mentions,
        [{ category: "skill", id: "sk_gen", name: "Krea2 出图", source: "" }],
        "记号在正文里，点名的那一项就随请求体交后端");
    assert.equal(localStorage.getItem("neo_studio_agent_skill"), null,
        "点名的技能不落本机：会话一没它就该没，不该在机器上留一份粘到下一条会话");

    click(skillChip().querySelector(".neo-agent-skill-del"));
    await flush(2);
    assert.ok(skillChip().hidden, "✕ 点完那颗收回");
    inputText(input, "再来一张");
    click(runBtn());
    await sleep(20); await flush(40);
    assert.equal(agentCalls()[1].body.skill_id, undefined, "取消之后不该再发这个字段");
    assert.equal(agentCalls()[1].body.mentions, undefined,
        "正文里的记号被换掉，交后端的那一项跟着掉，不留一个正文里已经没有了的点名");
});

test("@ 选中正文型技能：请求体带它的 id，那颗上写的是按它的流程走，不是「生成默认用它」", async () => {
    mountStudio();
    mockRoute("/rs_prompts/skills", jsonResponse(SKILLS));
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "脚本交回来了" }]);

    const input = dock().querySelector(".neo-agent-input");
    inputText(input, "@");
    await sleep(20);   // 弹层在 @ 那一下开，之后随输入过滤
    inputText(input, "@dog");
    await flush(5);
    assert.deepEqual(pickerRows().map((r) => r.querySelector(".neo-agent-picker-name").textContent),
        ["🧩 柴犬技能"], "没有 workflow.json 的提示词技能要在 @ 的候选里");
    keydown(input, "Enter");
    await flush(5);
    assert.ok(!skillChip().hidden && skillChip().textContent.includes("柴犬技能"),
        `点名的正文型技能要留在上下文条那一颗上：${skillChip().textContent}`);
    assert.ok(skillChip().title.includes("本会话点名技能") && skillChip().title.includes("每一轮按它的流程走"),
        `这一颗要说的是本会话点名、每一轮按它的流程走：${skillChip().title}`);

    inputText(input, "写一段动画短片的脚本");
    click(runBtn());
    await sleep(20); await flush(40);
    assert.equal(agentCalls()[0].body.skill_id, "sk_dog", "正文型技能的 id 要照原样交后端");
});

test("@ 点名的技能不跨重载：重载回到空态时那颗收回，请求体不带 skill_id", async () => {
    mountStudio();
    // 早先那一版把它写进本机、建页时粘回上下文条；会话没了那颗就不该再出现
    localStorage.setItem("neo_studio_agent_skill", JSON.stringify({ id: "sk_film", name: "H3 出片" }));
    await openStudio("#/gallery");
    assert.ok(skillChip().hidden, "开局没有会话：不该把机器上存过的那一份粘回来");
    mockAgentStream([{ kind: "content", text: "已出片" }]);
    inputText(dock().querySelector(".neo-agent-input"), "走一段");
    click(runBtn());
    await flush(40);
    assert.equal(agentCalls()[0].body.skill_id, undefined, "机器上存过的技能不该再交后端");
});

test("新增会话收回上一条会话点名的技能：新开的这一条不带 skill_id", async () => {
    mountStudio();
    mockRoute("/neo_agent/sessions", jsonResponse({ success: true, sessions: RECENT_SESSIONS.slice(0, 2) }));
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "已出图" }]);
    const input = dock().querySelector(".neo-agent-input");
    inputText(input, "@");
    await sleep(20);
    keydown(input, "Enter");
    await flush(5);
    assert.ok(!skillChip().hidden, "开局点名的技能应落在上下文条上");
    inputText(input, "一只橘猫");
    click(runBtn());
    await sleep(20); await flush(40);
    assert.equal(agentCalls()[0].body.skill_id, "sk_gen", "这条会话的第一发带着点名的技能");

    click(dock().querySelector('.neo-agent-head-btn[title="新增会话"]'));
    await until(() => skillChip().hidden, "新增会话应把上一条会话点名的技能收回");
    inputText(input, "再来一张");
    click(runBtn());
    await sleep(20); await flush(40);
    assert.equal(agentCalls()[1].body.skill_id, undefined, "新开的会话不该接着用上一条会话的技能");
});

test("读回另一条会话与断开续聊都收回点名技能：那条会话归那条会话", async () => {
    mountStudio();
    mockRoute("/neo_agent/sessions", jsonResponse({ success: true, sessions: RECENT_SESSIONS.slice(0, 2) }));
    mockRoute("/neo_agent/session", jsonResponse({
        success: true,
        session: {
            run_id: "r0", created: 1000, mode: "act", status: "succeeded", text: "第 0 次",
            frames: [{ kind: "run", run_id: "r0" }, { kind: "content", text: "上一轮的回答" }],
        },
    }));
    await openStudio("#/gallery");
    const input = dock().querySelector(".neo-agent-input");
    inputText(input, "@");
    await sleep(20);
    keydown(input, "Enter");
    await flush(5);
    assert.ok(!skillChip().hidden, "开局点名的技能应落在上下文条上");

    click(recentRows()[0]);
    await until(() => finalRow(), "点最近行应把那条会话铺回右栏");
    assert.ok(skillChip().hidden, "上一条会话点的那个不属于这一条：那颗收回");
    mockAgentStream([{ kind: "content", text: "接上了" }]);
    inputText(input, "接着改一句");
    click(runBtn());
    await sleep(20); await flush(40);
    assert.equal(agentCalls()[0].body.skill_id, undefined, "续聊这一发不带上一条会话的技能");
    assert.equal(agentCalls()[0].body.resume, "r0", "续聊带的应是这一条会话的 run_id");

    // 这条会话里再点一个，断开续聊就是离开它：那颗跟着收回，下一条开一条干净的会话
    inputText(input, "@");
    await sleep(20);
    keydown(input, "Enter");
    await flush(5);
    assert.ok(!skillChip().hidden, "这条会话里点的技能应落在上下文条上");
    click(dock().querySelector(".neo-agent-resumebar"));
    await flush(2);
    assert.ok(skillChip().hidden, "断开续聊就是离开这条会话：它点名的技能跟着收回");
    inputText(input, "开一条新的");
    click(runBtn());
    await sleep(20); await flush(40);
    assert.equal(agentCalls()[1].body.skill_id, undefined, "断开之后新开的会话不带技能");
    assert.equal(agentCalls()[1].body.resume, undefined, "断开之后不带 resume");
});

test("候选接口回 409：@ 的弹层只给那一句无匹配，请求里没有 skill_id", async () => {
    mountStudio();
    mockRoute("/rs_prompts/skills", () => ({ __spec: true, status: 409, body: "offline" }));
    mockRoute("/rs_recipes/list", () => ({ __spec: true, status: 409, body: "offline" }));
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "好的" }]);

    const input = dock().querySelector(".neo-agent-input");
    inputText(input, "@");
    await sleep(20);   // 同上一条用例：这一次 fetch 会走到 409
    assert.equal(pickerRows().length, 0, "离线服务给不了候选，弹层里不许铺假候选");
    assert.ok(document.querySelector(".neo-agent-picker-empty"), "空弹层只给那一句无匹配");
    keydown(input, "Escape");
    await flush(2);
    assert.equal(document.querySelector(".neo-agent-picker"), null, "Esc 收掉弹层");
    assert.equal(input.value, "@", "没选中就不动正文");

    inputText(input, "写一句提示词");
    click(runBtn());
    await flush(40);
    assert.equal(agentCalls()[0].body.skill_id, undefined, "没点名就不给这个字段");
});
