// 右栏智能体：技能下拉首项是空值「智能判断」；出图与出片一律走后端 /neo_agent/run 的 SSE 时间线，
// 面板自己不发 /neo_image_gen/generate；增强类技能照旧只出提示词。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, mockRoute, jsonResponse, sseResponse, click, inputText, fetchLog } from "./setup.mjs";

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
const skillSel = () => dock().querySelector(".neo-agent-skill");
const runBtn = () => dock().querySelector(".neo-agent-run");
const meta = () => dock().querySelector(".neo-agent-meta");
const turnAnswer = () => dock().querySelector(".neo-agent-answer");     // 增强类技能的正文
const finalRow = () => dock().querySelector(".neo-agent-answer-body");  // 智能体时间线的最终回答
const toolCard = () => dock().querySelector(".neo-agent-tool");
const statusLine = () => dock().querySelector(".neo-agent-tool-status");
const streamCalls = () => fetchLog.filter((c) => c.path === "/rs_prompts/stream_generate_prompt");
const agentCalls = () => fetchLog.filter((c) => c.path === "/neo_agent/run");
const genCalls = () => fetchLog.filter((c) => c.path === "/neo_image_gen/generate");
const cancelCalls = () => fetchLog.filter((c) => c.path === "/neo_agent/cancel");

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

test("技能下拉首项是空值「智能判断」，技能照常列出", async () => {
    mountStudio();
    await openStudio("#/gallery");

    const sel = skillSel();
    assert.ok(sel, "右栏应有技能下拉");
    const first = sel.options[0];
    assert.equal(first.value, "", "首项应为空值");
    assert.equal(first.textContent, "智能判断", "首项应写明智能判断");
    assert.equal(sel.value, "", "默认应停在智能判断，不强制套第一个技能");
    assert.ok([...sel.options].some((o) => o.value === "sk_cat"), "技能应照常列出");
});

test("不选技能点生成：走后端智能体，skill_id 为空，出计划行与最终回答", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([
        { kind: "plan", text: "先扩写提示词再出图" },
        { kind: "content", text: "需要你先选一个技能" },
    ]);

    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await flush(40);

    const calls = agentCalls();
    assert.equal(calls.length, 1, "应发出一次智能体请求");
    assert.equal(calls[0].body.skill_id, "", "未选技能时 skill_id 应为空");
    assert.equal(calls[0].body.text, "一只橘猫", "智能体请求应带上输入文本");
    assert.equal(streamCalls().length, 0, "空技能不应发流式提示词请求");
    assert.equal(dock().querySelector(".neo-agent-step").textContent, "🧭 先扩写提示词再出图", "应渲染计划行");
    assert.equal(finalRow().textContent.trim(), "需要你先选一个技能", "应渲染最终回答");
    assert.equal(meta().textContent, "智能判断", "回合头应显示智能判断");
    assert.equal(runBtn().disabled, false, "收尾后应解禁生成按钮");
});

test("增强类技能照旧只出提示词，不发智能体请求也不发出图请求", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "ag2", status: "queued" }));

    skillSel().value = "sk_cat";
    inputText(dock().querySelector(".neo-agent-input"), "写一段橘猫提示词");
    click(runBtn());
    await flush(40);

    assert.equal(streamCalls().length, 1, "增强类技能应走流式提示词");
    assert.equal(agentCalls().length, 0, "增强类技能不应发智能体请求");
    assert.equal(genCalls().length, 0, "增强类技能不应发出生图请求");
    assert.equal(turnAnswer().textContent.trim(), "生成正文");
});

test("MCP 入口与技能选择无关：点入口不改技能值、不发智能体请求", async () => {
    mountStudio();
    await openStudio("#/gallery");

    const sel = skillSel();
    sel.value = "sk_cat";
    click(dock().querySelector(".neo-agent-entry"));
    await flush(40);

    assert.equal(window.location.hash, "#/settings?tab=mcp", "入口应深链到设置页 MCP 栏");
    assert.equal(skillSel().value, "sk_cat", "技能选择不应被入口改动");
    assert.equal(agentCalls().length, 0, "入口不应触发智能体请求");
});

test("选生图技能点生成：发 /neo_agent/run 带 skill_id，面板不自己发出图请求", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([
        { kind: "plan", text: "按技能 sk_gen 直接出图" },
        { kind: "tool_call", tool: "generate_image", text: '{"skill_id":"sk_gen","prompt":"生成一个白猫坐窗台的图片"}' },
        { kind: "status", tool: "task_status", task_id: "ag1", text: "running 10/20" },
        IMAGE_RESULT,
        { kind: "content", text: "完成：1 张 · 1280×720" },
    ]);

    skillSel().value = "sk_gen";
    inputText(dock().querySelector(".neo-agent-input"), "生成一个白猫坐窗台的图片");
    click(runBtn());
    await flush(40);

    const calls = agentCalls();
    assert.equal(calls.length, 1, "应发出一次智能体请求");
    assert.equal(calls[0].body.skill_id, "sk_gen", "智能体请求应带上所选技能");
    assert.equal(genCalls().length, 0, "出图由后端 MCP 工具发起，面板不该自己打 /neo_image_gen/generate");
    assert.equal(streamCalls().length, 0, "生图技能不应发流式提示词请求");
    assert.equal(toolCard().querySelector(".neo-agent-tool-title").textContent, "🔧 generate_image", "应渲染工具卡");
    assert.ok(statusLine().textContent.includes("running 10/20"), "状态行应显示采样进度");
    const img = toolCard().querySelector("img");
    assert.ok(img, "应在工具卡里渲染出图缩略图");
    assert.equal(img.getAttribute("src"), "/view?filename=cat_0001.png&type=output", "缩略图应指向产物地址");
    assert.equal(finalRow().textContent.trim(), "完成：1 张 · 1280×720", "应渲染最终回答");
    assert.equal(meta().textContent, "Krea2 出图", "回合头应显示所选技能名");
    assert.equal(runBtn().disabled, false, "出图收尾后应解禁生成按钮");
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

    assert.equal(agentCalls()[0].body.skill_id, "", "出片走 LLM 规划路径，不带技能");
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

    skillSel().value = "sk_gen";
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

test("运行中生成键不禁用、带停止态样式，第二击才发取消", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockPendingRunStream(() => {});

    inputText(dock().querySelector(".neo-agent-input"), "一只橘猫");
    click(runBtn());
    await flush(40);

    assert.equal(runBtn().disabled, false, "运行中按钮必须可点：禁用等于把停止键从界面上摘掉");
    assert.ok(runBtn().classList.contains("ns-agent-stop"), "运行中应带停止态样式");
    assert.equal(cancelCalls().length, 0, "没点第二击不该发取消请求");
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

    click(runBtn());
    await flush(40);

    assert.ok(signal.aborted, "取消必须断掉 SSE 流");
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
    click(runBtn());
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
    assert.ok(!runBtn().classList.contains("ns-agent-stop"), "收场后应去掉停止态样式");
});

test("后端报错帧：时间线显示错误原文，不留缩略图，解禁生成按钮", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentRaw(["data: [ERROR] 技能 sk_gen 没有工作流模板（workflow.json）"]);

    skillSel().value = "sk_gen";
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

