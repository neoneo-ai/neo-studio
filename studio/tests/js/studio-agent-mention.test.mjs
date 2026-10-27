// 智能体页输入框的 @ 点名：底栏最左那颗把 @ 写进光标处，弹层汇六类候选（技能 / 主模型 / LoRA /
// 图像提示词 / 视频提示词 / 配方，候选源见 web/mention-picker.js）。选中往正文写一个
// @category:name 的可见记号，随请求体交后端的是结构化那一份 mentions；正文里删掉记号，
// 交后端的那一项跟着掉。提示词页的 / 走同一套工厂，不给 tokenOf 就只写下拉、正文不留记号。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, jsonResponse, sseResponse, click, keydown, inputText, fire, fetchLog } from "./setup.mjs";
import { createSlashSkillPicker } from "../../web/slash-picker.js";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?mention=${seq++}`);

const SKILLS = [
    { id: "sk_gen", name: "krea2_gen", cn_name: "Krea2 出图", category: "image_gen", gen_image: true, has_workflow: true, tags: [] },
    { id: "sk_dog", name: "dog_prompt", cn_name: "柴犬技能", category: "image_enhance", tags: [] },
];
const MODELS = {
    diffusion_models: ["Krea2\\krea2_turbo_fp8.safetensors", "qwen\\qwen_img_edit.safetensors"],
    loras: ["krea2\\mood_lora.safetensors"],
    text_encoders: [], vae: [],
    suggested_diffusion_models: "Krea2\\krea2_turbo_fp8.safetensors",
};
const PROMPTS = [
    { name: "精美图像提示词/红杯", source: "presets", tags: ["杯子"] },
    { name: "video/片头三段", source: "presets", tags: [] },
];
const RECIPES = [{ name: "cat_walk", source: "preset", type: "video_director", asset_count: 3 }];

function mountStudio() {
    resetEnv();
    localStorage.removeItem("neo_studio_agent_ctx_on");
    document.body.innerHTML = studioBody;
}

// resetEnv 会清掉已注册的桩（clearRoutes），fixture 要在它之后、模块导入之前挂上
function mockMentions() {
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
    }));
    mockRoute("/rs_prompts/skills", jsonResponse(SKILLS));
    mockRoute("/neo_image_gen/models", jsonResponse(MODELS));
    // @ 弹层只要名字与标签（list_prompt_names 只从目录列表取名字）；提示词页那份带正文的 list_prompts 是另一条
    mockRoute("/rs_prompts/list_prompt_names", jsonResponse(PROMPTS));
    mockRoute("/rs_prompts/list_prompts", jsonResponse(PROMPTS));
    mockRoute("/rs_recipes/list", jsonResponse(RECIPES));
    mockRoute("/rs_prompts/load_prompt", (body) => jsonResponse({ text: `正文:${body.name}` }));
    mockRoute("/neo_mcp/servers", jsonResponse({ success: true, servers: [], connected: [] }));
    mockRoute("/neo_mcp/tools", jsonResponse({ success: true, tools: [] }));
}

// hashchange 在 jsdom 里是宏任务：设完 hash 要等一轮事件循环，路由才把智能体页切过去
const settle = async () => { await sleep(0); await flush(); };

async function openStudio(hash) {
    mockMentions();
    window.location.hash = hash;
    await importApp();
    await settle();
    window.location.hash = "#/agent";   // 面板住在智能体页：进页才建得出面板
    await settle();
}

const dock = () => document.querySelector(".ns-agent-chat");
const inputBox = () => dock().querySelector(".neo-agent-input");
const runBtn = () => dock().querySelector(".neo-agent-run");
const mentionBtn = () => dock().querySelector(".neo-agent-mention");
const meta = () => dock().querySelector(".neo-agent-meta");
const pickerRows = () => [...document.querySelectorAll(".neo-agent-picker-row")];
const rowNames = () => pickerRows().map((r) => r.querySelector(".neo-agent-picker-name").textContent);
const agentCalls = () => fetchLog.filter((c) => c.path === "/neo_agent/run");
const loadPromptCalls = () => fetchLog.filter((c) => c.path === "/rs_prompts/load_prompt");

function mockAgentStream(frames) {
    const lines = frames.map((f) => `data: ${JSON.stringify(f)}`);
    mockRoute("/neo_agent/run", () => sseResponse(lines.concat("data: [DONE]")));
}

async function openPicker(query) {
    // 与真人逐字打字同一条路径：光标处落一个 @（弹层按 caret-1 认 @），再逐字补 query
    const box = inputBox();
    const at = box.selectionStart || 0;
    box.value = box.value.slice(0, at) + "@" + box.value.slice(at);
    box.setSelectionRange(at + 1, at + 1);
    fire(box, "input");
    await sleep(10);
    for (const ch of query.replace(/^@/, "")) {
        const caret = box.selectionStart || 0;
        box.value = box.value.slice(0, caret) + ch + box.value.slice(caret);
        box.setSelectionRange(caret + 1, caret + 1);
        fire(box, "input");
    }
    // 候选要过四条 fetch（技能 / 模型扫描 / 提示词 / 配方），微任务冲刷追不上这条链
    await sleep(20); await flush(40);
    assert.ok(pickerRows().length > 0, `弹层该开着：value=${JSON.stringify(box.value)}`);
}

test("@ 点名按钮在底栏最左：点一下把 @ 写进光标处，弹层汇出六类候选", async () => {
    mountStudio();
    await openStudio("#/gallery");

    assert.equal(dock().querySelector(".neo-agent-toolbar").firstElementChild, mentionBtn(),
        "底栏最左那颗就是 @ 点名");
    click(mentionBtn());
    await sleep(20);
    assert.equal(inputBox().value, "@", "点一下只写一个 @，弹层接着收 query");
    assert.deepEqual(rowNames(), [
        "Krea2 出图", "柴犬技能", "krea2_turbo_fp8", "qwen_img_edit",
        "mood_lora", "精美图像提示词/红杯", "video/片头三段", "cat_walk",
    ], "技能在前，主模型、LoRA、图像与视频提示词、配方按类排后面");
    keydown(inputBox(), "Escape");
    await flush(2);
});

test("@ 的过滤跨类：同一份 query 里技能与模型与 LoRA 一起筛出来", async () => {
    mountStudio();
    await openStudio("#/gallery");
    await openPicker("@krea");
    assert.deepEqual(rowNames(), ["Krea2 出图", "krea2_turbo_fp8", "mood_lora"],
        `按名字子串筛：${rowNames().join(" | ")}`);
});

test("选中 LoRA：正文写 @lora:name，请求体带那一项（id 是扫描表里的路径）", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "已出图" }]);
    await openPicker("@mood");
    keydown(inputBox(), "Enter");
    await flush(5);
    assert.equal(inputBox().value, "@lora:mood_lora", "记号进正文，光标落在记号之后");

    inputText(inputBox(), "@lora:mood_lora 出张图");
    click(runBtn());
    await sleep(20); await flush(40);
    assert.deepEqual(agentCalls()[0].body.mentions,
        [{ category: "lora", id: "krea2\\mood_lora.safetensors", name: "mood_lora", source: "" }],
        "LoRA 那一项交的是扫描表里的路径，后端照名字写进 generate_image 的 loras");
    assert.ok(meta().textContent.includes("mood_lora"), `回合头要写明这一发点名了：${meta().textContent}`);
});

test("选中图像提示词：选中那一发取回正文，随那一项交后端", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "已出图" }]);
    await openPicker("@红杯");
    keydown(inputBox(), "Enter");
    await flush(10);   // 取正文那条 fetch 在选中之后发
    assert.deepEqual(loadPromptCalls().map((c) => c.body.name), ["精美图像提示词/红杯"],
        "预设没有按名字取正文的工具，正文在选中那一发取回来");

    inputText(inputBox(), "@image_prompt:精美图像提示词/红杯 出张图");
    click(runBtn());
    await sleep(20); await flush(40);
    const item = agentCalls()[0].body.mentions[0];
    assert.equal(item.category, "image_prompt");
    assert.equal(item.source, "presets");
    assert.equal(item.text, "正文:精美图像提示词/红杯", "正文随点名交后端");
});

test("手打图像提示词记号不经过弹层：发送前也要把正文取回来随 mentions 交后端", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "已出图" }]);
    // 故意让 load_prompt 慢一点：若发送前不等正文取回，text 就会丢成空，@image_prompt 就成了空壳占位
    mockRoute("/rs_prompts/load_prompt", async (body) => {
        await new Promise((r) => setTimeout(r, 120));
        return jsonResponse({ text: `正文:${body.name}` });
    });
    inputText(inputBox(), "@image_prompt:精美图像提示词/红杯 出张图");
    await sleep(20); await flush(60);
    click(runBtn());
    // load_prompt 被模拟成 120ms 才回来：发送前必须等 mentionTextSettled，否则 text 会丢；
    // 这里多等一点，把请求发完再断言，不留未完成的异步串到下一条用例。
    await sleep(300);
    assert.deepEqual(loadPromptCalls().map((c) => c.body.name), ["精美图像提示词/红杯"],
        "手打的记号也会按名字去取那条预设的正文");
    const item = agentCalls()[0].body.mentions[0];
    assert.equal(item.category, "image_prompt");
    assert.equal(item.name, "精美图像提示词/红杯");
    assert.equal(item.source, "presets");
    assert.equal(item.text, "正文:精美图像提示词/红杯", "正文取回来了才随 mentions 交后端");
});

test("斜杠预设名：取回正文非名字才交后端，名字不进 prompt", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "已出片" }]);
    // 真实预设是带斜杠的子目录名；取正文要按整条斜杠名发，回来的必须是正文而不是名字本身
    const SLASHED = [{ name: "精美图像提示词/女孩衬衫正面", source: "presets", tags: [] }];
    mockRoute("/rs_prompts/list_prompt_names", jsonResponse(SLASHED));
    mockRoute("/rs_prompts/list_prompts", jsonResponse(SLASHED));
    mockRoute("/rs_prompts/load_prompt", (body) => jsonResponse({
        text: `正文:${body.name}`,
    }));
    inputText(inputBox(), "使用 @image_prompt:精美图像提示词/女孩衬衫正面 生成一张图片");
    await sleep(20); await flush(60);
    click(runBtn());
    await sleep(300);
    const calls = loadPromptCalls().map((c) => c.body.name);
    assert.deepEqual(calls, ["精美图像提示词/女孩衬衫正面"],
        "带斜杠的预设名要整条原样去取正文，不能被截断成 '女孩衬衫正面'");
    const item = agentCalls()[0].body.mentions[0];
    assert.equal(item.category, "image_prompt");
    assert.equal(item.name, "精美图像提示词/女孩衬衫正面");
    assert.equal(item.source, "presets");
    assert.equal(item.text, "正文:精美图像提示词/女孩衬衫正面", "交后端的是取回的正文，不是名字");
    assert.notEqual(item.text, item.name, "正文不能等于名字——等于名字就是没取到正文");
});

test("记号删掉就不再交那一项：同一项点两次也只交一份", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "已出片" }]);
    await openPicker("@cat_walk");
    keydown(inputBox(), "Enter");
    await flush(5);
    assert.equal(inputBox().value, "@recipe:cat_walk");

    // 同一项再点一次：交后端的那一份不该铺两遍
    await openPicker("@cat_walk");
    keydown(inputBox(), "Enter");
    await flush(5);
    assert.equal(inputBox().value, "@recipe:cat_walk@recipe:cat_walk", "正文里是两处记号，连着写不吃掉任何一处");

    inputText(inputBox(), "出个片");     // 记号全没了
    click(runBtn());
    await sleep(20); await flush(40);
    assert.equal(agentCalls()[0].body.mentions, undefined, "正文里没有记号就不发这个字段");

    inputText(inputBox(), "@recipe:cat_walk 跑第一段");
    click(runBtn());
    await sleep(20); await flush(40);
    assert.deepEqual(agentCalls()[1].body.mentions,
        [{ category: "recipe", id: "cat_walk", name: "cat_walk", source: "preset" }],
        "一处记号只交一份，重复点名不加第二份");
});

test("新增会话收回点名的那几项：新开的这一条不带上一条会话的点名", async () => {
    mountStudio();
    mockRoute("/neo_agent/sessions", jsonResponse({ success: true, sessions: [] }));
    await openStudio("#/gallery");
    mockAgentStream([{ kind: "content", text: "已出片" }]);
    await openPicker("@mood");
    keydown(inputBox(), "Enter");
    await flush(5);
    inputText(inputBox(), "@lora:mood_lora 出张图");
    click(runBtn());
    await sleep(20); await flush(40);
    assert.equal(agentCalls()[0].body.mentions.length, 1, "这一发带着点名的 LoRA");

    click(dock().querySelector('.neo-agent-head-btn[title="新增会话"]'));
    await flush(5);
    inputText(inputBox(), "再来一张");
    click(runBtn());
    await sleep(20); await flush(40);
    assert.equal(agentCalls()[1].body.mentions, undefined,
        "新开的会话接着用上一条会话的点名就是串味");
});

test("提示词页的 / 不给 tokenOf：提交只写下拉，正文里不留记号", async () => {
    resetEnv();
    const box = document.createElement("textarea");
    box.value = "/";
    document.body.appendChild(box);
    box.focus();
    box.setSelectionRange(1, 1);
    const selector = document.createElement("select");
    const option = document.createElement("option");
    option.value = "sk_cat";
    selector.appendChild(option);
    document.body.appendChild(selector);

    const open = createSlashSkillPicker({
        quickInput: box,
        listSkills: async () => [{ id: "sk_cat", name: "cat_prompt", cn_name: "橘猫技能" }],
        skillSelector: selector,
    });
    await open();
    await sleep(20);
    keydown(box, "Enter");
    await flush(5);
    assert.equal(selector.value, "sk_cat", "/ 选技能照旧写下拉");
    assert.equal(box.value, "", "不给 tokenOf 就只吃掉触发字符那一段，正文里不写记号");
});


const MENTION_PATHS = ["/rs_prompts/skills", "/neo_image_gen/models",
                       "/rs_prompts/list_prompt_names", "/rs_recipes/list"];
const mentionFetches = () => fetchLog.filter((c) => MENTION_PATHS.includes(c.path));
const pickerBox = () => document.querySelector(".neo-agent-picker");
const emptyTip = () => document.querySelector(".neo-agent-picker-empty");

// openPicker 那条要等四类候选全落袋才断言，这几条看的是候选还在路上的那一段
async function typeOut(text) {
    const box = inputBox();
    for (const ch of text) {
        const caret = box.selectionStart || 0;
        box.value = box.value.slice(0, caret) + ch + box.value.slice(caret);
        box.setSelectionRange(caret + 1, caret + 1);
        fire(box, "input");
    }
}

test("输入框一聚焦就把候选捞起来：@ 那一下落在缓存上，四条接口不再重发", async () => {
    mountStudio();
    await openStudio("#/gallery");
    const before = mentionFetches().length;
    assert.equal(pickerBox(), null, "没打字不开弹层");

    fire(inputBox(), "focus");
    await sleep(20); await flush(40);
    const warmed = mentionFetches().length;
    assert.equal(warmed - before, 4, "预热把四类候选各捞一次");

    await typeOut("@krea2");
    await sleep(20); await flush(40);
    assert.deepEqual(rowNames(), ["Krea2 出图", "krea2_turbo_fp8", "mood_lora"]);
    assert.equal(mentionFetches().length, warmed,
        "开弹层与逐字过滤都吃缓存：@ 那一下不等模型目录扫描");
});

test("@ 弹层不等最慢的那条：先回来的候选先画行，模型目录晚到补进同一份列表", async () => {
    mountStudio();
    await openStudio("#/gallery");
    mockRoute("/neo_image_gen/models", async () => { await sleep(40); return jsonResponse(MODELS); });

    await typeOut("@");
    await sleep(10); await flush(20);
    assert.ok(pickerBox(), "候选还在路上，弹层已经开着");
    assert.ok(rowNames().includes("柴犬技能"), "技能与提示词先到手就先画行");
    assert.ok(rowNames().includes("精美图像提示词/红杯"));
    assert.ok(!rowNames().some((n) => n.includes("krea2_turbo_fp8")), "没到手的模型不铺假候选");

    await sleep(60); await flush(20);
    assert.ok(rowNames().some((n) => n.includes("krea2_turbo_fp8")), "晚到的模型补进同一份列表");
});

test("候选上千时弹层只铺 120 行：余下的收成一行提示，Enter 取的是高亮那一行", async () => {
    mountStudio();
    await openStudio("#/gallery");
    const loras = Array.from({ length: 400 }, (_, i) => `bulk\\lora_${String(i).padStart(3, "0")}.safetensors`);
    mockRoute("/neo_image_gen/models", jsonResponse({
        diffusion_models: [], loras, text_encoders: [], vae: [],
    }));

    await typeOut("@lora_");
    await sleep(30); await flush(40);
    const rows = pickerRows();
    assert.equal(rows.length, 120, "一次弹层最多铺 120 行，400 个 LoRA 不整棵铺进 DOM");
    assert.equal(emptyTip().textContent.includes("280"), true,
                 `提示行报没铺出来的条数：${emptyTip().textContent}`);
    keydown(inputBox(), "End");
    await flush(3);
    assert.ok(rows[119].classList.contains("rs-picker-row-active"), "End 落在最后铺出来的那一行");
    keydown(inputBox(), "Enter");
    await flush(5);
    assert.ok(inputBox().value.includes("@lora:lora_119"),
              `Enter 交的是高亮那一项：${inputBox().value}`);
});

test("候选一条都没到手时弹层空着：那一句无匹配要等四类都落袋", async () => {
    mountStudio();
    await openStudio("#/gallery");
    for (const path of MENTION_PATHS)
        mockRoute(path, async () => { await sleep(50); return jsonResponse([]); });

    await typeOut("@zzz");
    await sleep(10); await flush(20);
    assert.ok(pickerBox(), "弹层开着");
    assert.equal(pickerRows().length, 0);
    assert.equal(emptyTip(), null, "候选没到齐就报无匹配，是把慢当成了没有");

    await sleep(60);
    assert.ok(emptyTip(), "四类都落袋、名字真的对不上，才报无匹配");
});

test("@ 弹层贴住输入框：宽度吃输入框自己的宽度，位置按铺出来的真实高度算", async () => {
    mountStudio();
    await openStudio("#/gallery");
    const box = inputBox();
    // jsdom 不铺布局：输入框的位置与弹层的真实高度得交进去，量出来的那两条才有数可依
    box.getBoundingClientRect = () => ({ left: 40, top: 640, bottom: 656, right: 540, width: 500, height: 16 });
    await typeOut("@krea2");
    await sleep(20); await flush(40);
    const picker = pickerBox();
    Object.defineProperty(picker, "offsetHeight", { value: 300, configurable: true });
    fire(box, "input");   // 一次重画即一次重新定位：候选数变了，弹层高度跟着变
    await flush(5);

    assert.equal(picker.style.width, "500px", "弹层与输入框同宽：窄一截的弹层看着像掉出来的");
    assert.equal(picker.style.left, "40px", "左沿贴输入框左沿");
    assert.equal(picker.style.top, "336px",
        "输入框下方只剩 100px，300px 高的弹层翻到输入框上方，贴着它，不是悬在两百度外");
    assert.equal(picker.querySelector(".neo-agent-picker-list").style.maxHeight, "220px",
                 "列表盒收在上下两侧里装得下的那点");
});

