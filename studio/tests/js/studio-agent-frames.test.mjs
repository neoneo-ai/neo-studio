// 智能体页的几类帧：执行清单 / 焦点链 / 上下文与 token 统计 / finish 收场，
// 外加旧会话的「从这条消息重新开始」与用户级偏好：表单在设置页「智能体偏好」栏（configs/agent_prefs.json
// 读写），面板只留齿轮与焦点链「设为偏好」两个入口，点了跳过去并把这一发的技能 / 宽高 / 配方带进表单。
// 共同口径是「整份重发就地重写」——后端每划掉一条清单、每累加一次 token 都发整张，
// 界面逐帧追加就是刷屏。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, jsonResponse, sseResponse, click, inputText, fetchLog } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?frames=${seq++}`);

const SKILLS = [{ id: "sk_cat", name: "cat_prompt", cn_name: "橘猫技能", category: "image_gen", gen_image: true, has_workflow: true, tags: [] }];
const RUN_ID = "0123456789abcdef0123456789abcdef";

// 后端 _clean_prefs 的形态收口：技能名与尺寸不合规就丢回默认值，测试里照同一口径演它
const PREFS_RE = { skill: /^[A-Za-z0-9_.\-]{1,64}$/, size: /^\d{3,4}x\d{3,4}$|^\d{1,2}:\d{1,2}$/ };
let SAVED_PREFS = { preferred_skill: "", preferred_size: "", preferred_family: "", style_notes: "", avoid: "", confirm_films: false };
function cleanPrefs(raw) {
    const out = {};
    for (const key of ["preferred_skill", "preferred_family"]) {
        const v = String(raw?.[key] || "").trim();
        out[key] = PREFS_RE.skill.test(v) ? v : "";
    }
    const size = String(raw?.preferred_size || "").trim();
    out.preferred_size = PREFS_RE.size.test(size) ? size : "";
    for (const key of ["style_notes", "avoid"]) out[key] = String(raw?.[key] || "").trim();
    out.confirm_films = !!raw?.confirm_films;
    SAVED_PREFS = out;
    return out;
}

function mountStudio() {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
    }));
    mockRoute("/rs_prompts/skills", jsonResponse(SKILLS));
    mockRoute("/neo_image_gen/models", jsonResponse({ diffusion_models: ["krea2/krea2_turbo.safetensors"] }));
    mockRoute("/neo_mcp/servers", jsonResponse({ success: true, servers: [], connected: [] }));
    mockRoute("/neo_mcp/tools", jsonResponse({ success: true, tools: [] }));
    mockRoute("/neo_agent/prefs", (body, call) => jsonResponse(
        call.method === "POST" ? { ok: true, prefs: cleanPrefs(body) } : { ok: true, prefs: SAVED_PREFS }));
}

// hashchange 在 jsdom 里是宏任务：设完 hash 要等一轮事件循环，路由才把智能体页切过去
const settle = async () => { await sleep(0); await flush(); };

async function openStudio() {
    window.location.hash = "#/gallery";
    await importApp();
    await settle();
    window.location.hash = "#/agent";   // 面板住在智能体页：进页才建得出面板
    await settle();
}

const dock = () => document.querySelector(".ns-agent-chat");
const runBtn = () => dock().querySelector(".neo-agent-run");
const input = () => dock().querySelector(".neo-agent-input");
const finalRow = () => dock().querySelector(".neo-agent-answer-body");
const planBoxes = () => [...dock().querySelectorAll(".neo-agent-plan")];
const metaRows = () => [...dock().querySelectorAll(".neo-agent-runmeta")];
const focusChips = () => [...dock().querySelectorAll(".neo-agent-focus-chip")];
const prefsForm = () => document.querySelector(".ns-agent-prefs");
const prefsField = (key) => prefsForm().querySelector(`[name="${key}"]`);
const prefsOptions = (key) => [...prefsField(key).options].map((o) => o.value);
const prefsTab = () => [...document.querySelectorAll(".ns-settings-tab")].find((b) => b.textContent.includes("智能体偏好"));
const gear = () => headBtns().find((b) => b.title.includes("智能体偏好"));
const hashQuery = () => new URLSearchParams(window.location.hash.split("?")[1] || "");
const restartRows = () => [...dock().querySelectorAll(".neo-agent-restart-row")];
const resumeBar = () => dock().querySelector(".neo-agent-resumebar");
const headBtns = () => [...dock().querySelectorAll(".neo-agent-head-btn")];
const agentCalls = () => fetchLog.filter((c) => c.path === "/neo_agent/run");
const prefsCalls = () => fetchLog.filter((c) => c.path === "/neo_agent/prefs");

/** 后端时间线的帧：逐条包成 SSE 行，末尾补 [DONE]。 */
function mockAgentStream(frames) {
    mockRoute("/neo_agent/run", () => sseResponse(
        frames.map((f) => `data: ${JSON.stringify(f)}`).concat("data: [DONE]")));
}

const FOCUS_FRAME = { kind: "focus", focus: { skill_id: "sk_cat", model: "krea2", width: 1280, height: 720,
    seed: 7, recipe: "我的片子", loras: ["a.safetensors", "b.safetensors"], prompt: "橘猫" } };

async function run(frames, text = "画一只橘猫") {
    mockAgentStream(frames);
    inputText(input(), text);
    click(runBtn());
    await flush(40);
}

async function openSavedSession(record) {
    mountStudio();
    mockRoute("/neo_agent/sessions", jsonResponse({ success: true, sessions: [record.summary] }));
    mockRoute("/neo_agent/session", jsonResponse({ success: true, session: record.session }));
    await openStudio();
    click(dock().querySelector(".neo-agent-recent-row"));
    await flush(40);
}

const TWO_TURN = {
    summary: { run_id: RUN_ID, created: 1700000000, mode: "act", status: "succeeded", resume_of: "",
               resume_from: 0, text: "画一只橘猫", images: 0, tools: 2, tokens: 12000, focus_skill: "sk_cat" },
    session: { run_id: RUN_ID, created: 1700000000, mode: "act", status: "succeeded", resume_of: "",
               resume_from: 0, focus: { skill_id: "sk_cat" }, usage: { total_tokens: 12000 }, plan_steps: [],
               input: { text: "画一只橘猫", images: [], context: "" },
               frames: [
                   { kind: "plan_steps", steps: [{ tool: "generate_image", key_args: "1 张", note: "出图", done: true }] },
                   { kind: "finish", text: "出好了：1 张", media: [], options: [] },
               ],
               messages: [{ role: "user", content: "画一只橘猫" },
                          { role: "assistant", content: "出一张橘猫" },
                          { role: "user", content: "再来一张，换 16:9" }] },
};

// ====== 执行清单：后端每划掉一条重发整张，界面只留一块清单原地打勾 ======
test("plan_steps 帧：一块清单原地重铺，划掉的行按整张算进度", async () => {
    mountStudio();
    await openStudio();
    const PLAN = [{ tool: "director_plan", key_args: "3 段", note: "排片", done: false },
                  { tool: "generate_image", key_args: "封面", note: "", done: false }];
    await run([
        { kind: "plan_steps", steps: PLAN },
        { kind: "tool_call", tool: "generate_image", text: "{}" },
        { kind: "plan_steps", steps: [{ ...PLAN[0], done: true }, PLAN[1]] },
        { kind: "content", text: "跑完" },
    ]);

    const plans = planBoxes();
    assert.equal(plans.length, 1, "两次整张帧只该有一块清单，逐帧追加就是刷屏");
    assert.equal(plans[0].querySelectorAll(".neo-agent-plan-row").length, 2, "清单按整张重铺");
    const foot = plans[0].querySelector(".neo-agent-plan-foot").textContent;
    assert.ok(foot.includes("1/2"), `页脚应写明已完成几条：${foot}`);
    assert.ok(plans[0].querySelector(".neo-agent-plan-done"), "划掉的行要有划掉的样子");
    assert.ok(plans[0].querySelector(".neo-agent-plan-row").textContent.includes("director_plan"),
        "行内要写出工具名");
});

// ====== 上下文与 token 统计：同一行两段，逐轮重写 ======
test("context 与 usage 帧共用一行元信息，逐轮重写的只有数字", async () => {
    mountStudio();
    await openStudio();
    await run([
        { kind: "context", approx_tokens: 7000, ratio: 0.29 },
        { kind: "usage", prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, turns: 1 },
        { kind: "context", approx_tokens: 9000, ratio: 0.38 },
        { kind: "usage", prompt_tokens: 2400, completion_tokens: 600, total_tokens: 3000, turns: 2 },
        { kind: "content", text: "好了" },
    ]);

    const rows = metaRows();
    assert.equal(rows.length, 1, "两帧都是当前整份，只该占一行");
    const text = rows[0].textContent;
    assert.ok(text.includes("9.0k"), `应显示最近一次的上下文量级：${text}`);
    assert.ok(text.includes("38%"), `应显示占预算的百分比：${text}`);
    assert.ok(text.includes("3.0k"), `应显示累计 token：${text}`);
    assert.ok(text.includes("2 轮"), `应显示累计轮次：${text}`);
});

// ====== 焦点链：铺成 chip，「设为偏好」跳设置页并把这一发填进表单 ======
test("focus 帧铺焦点链，点「设为偏好」跳设置页并把这一发填进表单", async () => {
    mountStudio();
    await openStudio();
    await run([FOCUS_FRAME, { kind: "content", text: "出好了" }]);

    const labels = focusChips().map((c) => c.textContent);
    assert.ok(labels.some((s) => s.includes("sk_cat")), `chip 应铺出技能：${JSON.stringify(labels)}`);
    assert.ok(labels.some((s) => s.includes("1280")), `chip 应铺出宽度：${JSON.stringify(labels)}`);
    assert.ok(labels.some((s) => s.includes("a.safetensors / b.safetensors")),
        `LoRA 列表合并成一条 chip：${JSON.stringify(labels)}`);
    assert.ok(!labels.some((s) => s.includes("橘猫")), "提示词不进 chip（工具卡上本来就看得见）");
    assert.equal(dock().querySelector(".neo-agent-prefs"), null, "面板不嵌整份偏好表单，只留入口");

    click(dock().querySelector(".neo-agent-focus-prefs"));
    await flush(20);
    const q = hashQuery();
    assert.equal(q.get("tab"), "agent", "入口要把人送到设置页那一栏");
    assert.equal(q.get("skill"), "sk_cat", "技能随深链走");
    assert.equal(q.get("size"), "1280x720", "尺寸按宽高拼出来随深链走");
    assert.equal(q.get("family"), "krea2", "家族按这一发的主模型走，导演配方名是中文，进不了家族那格");
    assert.equal(prefsField("preferred_skill").value, "sk_cat", "技能照焦点链落表单");
    assert.equal(prefsField("preferred_size").value, "1280x720", "尺寸照焦点链落表单");
    assert.ok(prefsOptions("preferred_size").includes("1280x720"),
        `档位里的固定档之外要有这一发的宽高：${JSON.stringify(prefsOptions("preferred_size"))}`);
    assert.equal(prefsField("preferred_family").value, "krea2", "主模型家族照这一发的模型落表单");
});

// ====== 偏好保存：POST 后按后端收净的返回值回填表单 ======
test("保存偏好：下拉提交档位值，档位外的焦点链值按后端收净的这份回填", async () => {
    mountStudio();
    await openStudio();
    await run([FOCUS_FRAME, { kind: "content", text: "出好了" }]);
    click(dock().querySelector(".neo-agent-focus-prefs"));
    await flush(20);

    prefsField("style_notes").value = "暖色逆光";
    prefsField("confirm_films").checked = true;
    click(prefsForm().querySelector(".ns-prefs-save"));
    await flush(20);

    const posts = prefsCalls().filter((c) => c.method === "POST");
    assert.equal(posts.length, 1, "保存只发一次");
    assert.deepEqual(posts[0].body, { preferred_skill: "sk_cat", preferred_size: "1280x720",
        preferred_family: "krea2", style_notes: "暖色逆光", avoid: "", confirm_films: true },
    "下拉提交的是档位值本身（技能 id 与家族名），不是界面上的中文标签");
    assert.equal(prefsField("preferred_size").value, "1280x720",
        "档位外的焦点链宽高合规，后端留着它，界面回填的也就是后端那份");
    assert.ok([...prefsField("preferred_size").options].some((o) => o.textContent.includes("焦点链")),
        "档位外的值在表单上是明写着它是焦点链带的，不混进固定档");
    assert.equal(prefsField("style_notes").value, "暖色逆光", "合规值原样回填");
    assert.equal(prefsField("confirm_films").checked, true, "开关按落盘的这份显示");
    assert.ok(appState.toasts.some((x) => (x.detail || "").includes("偏好")), "保存要给出提示");
});

// ====== 栏头 跳设置页那一栏：枚举三项是固定下拉，当前偏好只读一次 ======
test("栏头 跳「智能体偏好」栏：枚举三项是下拉，档位来自技能与已装主模型", async () => {
    SAVED_PREFS = { preferred_skill: "sk_cat", preferred_size: "16:9", preferred_family: "krea2",
        style_notes: "夜戏冷色", avoid: "旁白", confirm_films: true };
    mountStudio();
    await openStudio();
    click(gear());
    await flush(20);

    assert.equal(hashQuery().get("tab"), "agent", "齿轮只做跳转，面板不展开表单");
    assert.ok(prefsTab().classList.contains("active"), "设置页要落在「智能体偏好」这一栏");
    assert.deepEqual(["preferred_skill", "preferred_size", "preferred_family"].map((k) => prefsField(k).tagName),
        ["SELECT", "SELECT", "SELECT"], "枚举三项给下拉，不让用户手打 1024x1024");
    assert.deepEqual(prefsOptions("preferred_skill"), ["", "sk_cat"],
        "技能档位首项是「不设」，其余是技能 id（标签是中文名）");
    assert.ok(prefsField("preferred_skill").options[1].textContent.includes("橘猫"),
        `技能项的标签用中文名：${prefsField("preferred_skill").options[1].textContent}`);
    const sizes = prefsOptions("preferred_size");
    assert.equal(sizes[0], "", "尺寸首项是不设");
    for (const v of ["1:1", "16:9", "9:16", "21:9", "1024x1024", "1280x1280", "2048x2048"])
        assert.ok(sizes.includes(v), `尺寸档位里要有 ${v}：${JSON.stringify(sizes)}`);
    assert.deepEqual(prefsOptions("preferred_family"), ["", "krea2"],
        "家族档位只列已装主模型命中的家族线索，没装的 qwen 不列");
    assert.equal(prefsField("style_notes").tagName, "TEXTAREA", "长文本要落 textarea");
    assert.equal(prefsField("avoid").tagName, "TEXTAREA", "长文本要落 textarea");
    assert.equal(prefsField("confirm_films").type, "checkbox", "开关要落 checkbox");
    assert.equal(prefsField("preferred_skill").value, "sk_cat", "要回填当前偏好");
    assert.equal(prefsField("preferred_size").value, "16:9", "要回填当前偏好");
    assert.equal(prefsField("preferred_family").value, "krea2", "要回填当前偏好");
    assert.equal(prefsField("avoid").value, "旁白", "要回填当前偏好");
    assert.equal(prefsField("confirm_films").checked, true, "开关要回填当前偏好");
    const gets = prefsCalls().filter((c) => c.method !== "POST");
    assert.equal(gets.length, 1, `当前偏好只该读一次：${JSON.stringify(gets.map((c) => c.method))}`);
    SAVED_PREFS = { preferred_skill: "", preferred_size: "", preferred_family: "",
        style_notes: "", avoid: "", confirm_films: false };
});

// ====== finish 帧：正文 + 产物 + 下一步方向，走这条收场时后端不发 content 帧 ======
test("finish 帧落最终回答：正文、产物缩略图与可点的下一步方向", async () => {
    mountStudio();
    await openStudio();
    await run([{ kind: "finish", text: "出好了：1 张 · 1280×720",
        media: [{ kind: "image", title: "cat_0001.png", url: "/view?filename=cat_0001.png&type=output" }],
        options: ["再来一张同风格的", "换成柴犬试一张"] }]);

    assert.equal(finalRow().querySelector(".neo-agent-media img").getAttribute("src"),
        "/view?filename=cat_0001.png&type=output", "产物缩略图落在最终回答里");
    const opts = [...finalRow().querySelectorAll(".neo-agent-answer-opt")].map((b) => b.textContent);
    assert.deepEqual(opts, ["1. 再来一张同风格的", "2. 换成柴犬试一张"], "结构化方向铺成编号按钮");
    assert.ok(finalRow().textContent.includes("出好了"), "正文落在最终回答");

    click(finalRow().querySelector(".neo-agent-answer-opt"));
    await flush(40);
    const calls = agentCalls();
    assert.equal(calls.length, 2, "点方向就是把它当下一句输入发出去");
    assert.equal(calls[1].body.text, "再来一张同风格的");
});
// 产物在面板里只铺一遍：generate_image 的产物铺在卡下，finish_task 交的是同一批清单，
// 收场那一栏只补卡下没铺过的，同一张图不在面板里出现两次
test("产物不在面板里铺两遍：卡下铺过的图，收场栏只补新产物", async () => {
    mountStudio();
    await openStudio();
    await run([
        { kind: "tool_call", tool: "generate_image", text: "{}" },
        { kind: "tool_result", tool: "generate_image", text: "出了 1 张", media:
            [{ kind: "image", title: "cat_0001.png", url: "/view?filename=cat_0001.png&type=output" }] },
        { kind: "finish", text: "出好了：2 张", media: [
            { kind: "image", title: "cat_0001.png", url: "/view?filename=cat_0001.png&type=output" },
            { kind: "image", title: "cat_0002.png", url: "/view?filename=cat_0002.png&type=output" }],
          options: [] }]);

    const cardImgs = [...dock().querySelectorAll(".neo-agent-tool .neo-agent-media img")]
        .map((n) => n.getAttribute("src"));
    const finalImgs = [...finalRow().querySelectorAll(":scope > .neo-agent-media img")]
        .map((n) => n.getAttribute("src"));
    assert.deepEqual(cardImgs, ["/view?filename=cat_0001.png&type=output"], "generate_image 卡下铺这一张");
    assert.deepEqual(finalImgs, ["/view?filename=cat_0002.png&type=output"],
        "收场栏只补卡下没铺过的 cat_0002");
});


// ====== 旧会话的「从这条消息重新开始」 ======
test("旧会话里每条用户消息一个重开入口，点它之后生成带 from 序号", async () => {
    await openSavedSession(TWO_TURN);

    const rows = restartRows();
    assert.equal(rows.length, 2, "两条用户消息铺两行");
    assert.ok(rows[1].textContent.includes("再来一张"), `行上写出那句话：${rows[1].textContent}`);

    click(rows[1]);
    await flush(10);
    assert.ok(rows[1].classList.contains("neo-agent-restart-on"), "点选的那条描边");
    assert.ok(resumeBar().textContent.includes("从第 2 条消息重开"),
        `续聊条要写明从第几条重开：${resumeBar().textContent}`);

    mockAgentStream([{ kind: "content", text: "接上重跑" }]);
    inputText(input(), "这一段重来");
    click(runBtn());
    await flush(40);

    const calls = agentCalls();
    const body = calls[calls.length - 1].body;
    assert.equal(body.resume, RUN_ID, "重开接的是那条会话");
    assert.equal(body.from, 2, "from 按界面上的序号（1 起）交后端");
});

test("只有一条用户消息的会话不铺重开排：从它重开等于开一条新会话", async () => {
    await openSavedSession({
        summary: { ...TWO_TURN.summary, tokens: 0, focus_skill: "" },
        session: { ...TWO_TURN.session, messages: [{ role: "user", content: "画一只橘猫" }] },
    });
    assert.equal(restartRows().length, 0, "只有一条用户消息时那一排不铺");
});

test("打开旧会话回放 plan_steps 与 finish 帧：清单与最终回答铺出来", async () => {
    await openSavedSession(TWO_TURN);
    assert.equal(planBoxes().length, 1, "回放里的执行清单要铺出来");
    assert.ok(finalRow().textContent.includes("出好了"), "回放里的收场文本落在最终回答");
    assert.ok(resumeBar().textContent.includes("↩"), "打开旧会话后续聊条出现");
});

// ====== 历史列表摘要带 token 量级与焦点技能 ======
test("历史列表摘要写明这条会话烧掉多少 token、最后用的哪个技能", async () => {
    mountStudio();
    mockRoute("/neo_agent/sessions", jsonResponse({ success: true, sessions: [TWO_TURN.summary] }));
    await openStudio();
    click(headBtns().find((b) => b.title.includes("会话历史")));
    await flush(20);

    const note = dock().querySelector(".neo-agent-session-row .neo-agent-session-note").textContent;
    assert.ok(note.includes("12.0k tokens"), `摘要应带 token 量级：${note}`);
    assert.ok(note.includes("sk_cat"), `摘要应带焦点技能：${note}`);
});


