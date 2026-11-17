// Studio「提示词增强」页（web/prompt-enhance/prompt-enhance.js）：整页聊天舞台（输入气泡 + 回话气泡）→ 请求体
// → SSE 逐字上屏 → 停止（运行中就翻面成「停止」的同一枚钮）/ 会话历史 / 新增会话 / 复制 / 随机 / 存预设。
// 会话攒在这一页的闭包里，下一发默认把已返回的回话垫在正文前面交给模型（historyBlock + joinPromptText）。
// 增强链全程只认数据根与 LLM 服务（/rs_prompts/stream_generate_prompt 注册在 studio/llm.py 的 routes 上，
// 桌面端离线服务挂载同一份）；本页不发任何要 ComfyUI 运行时的请求，只有「保存为预设」按能力表门控。
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, sseResponse, jsonResponse, fetchLog, click, keydown, flush, sleep, changeValue } from "./setup.mjs";
import { $el } from "../../web/studio/shim/ui.js";
// prompt-enhance.js 顶层导入 skill.js / gallery-utils.js（它们要 scripts/* 的 shim），
// 必须等 setup.mjs 装好钩子再动态取
const { createPromptEnhanceView, enhancePayload, joinPromptText, historyBlock, galleryImageSource,
        ENHANCE_API, MAX_ENHANCE_REFS, HISTORY_PAIRS, HISTORY_CHAR_CAP } = await import("../../web/prompt-enhance/prompt-enhance.js");
const { closePresetPicker } = await import("../../web/js/core/preset-picker.js");

beforeEach(() => {
    clearRoutes();
    localStorage.removeItem("rs.thinking_depth");
    localStorage.removeItem("rs.enhance.media");
});

const settle = async () => { await flush(20); await sleep(0); await flush(20); };

const SKILLS = [
    { id: "general_enhance", name: "General Enhance", cn_name: "通用增强", category: "image_enhance" },
    { id: "anime_style", name: "Anime Style", cn_name: "动漫风格", category: "image_enhance" },
    { id: "skill_gen", name: "Gen Skill", cn_name: "生图技能", category: "image_gen", gen_image: true },
    { id: "skill_wf", name: "Wf Skill", cn_name: "工作流技能", category: "image_enhance", has_workflow: true },
    { id: "text_to_video", name: "Text To Video", cn_name: "WAN文生视频", category: "video_enhance" },
    { id: "minimax_h3_full_ref", name: "H3 Full Ref", cn_name: "全参考", category: "video_enhance", needs_image: true },
];

/** 增强流的帧形与后端一致：正文是 text 帧，thinking / status 是旁路面板，replace 整段替换正文 */
function mockEnhanceStream(frames) {
    mockRoute(ENHANCE_API, () => sseResponse([
        ...frames,
        "data: [DONE]",
    ]));
}

function content(text) { return "data: " + JSON.stringify({ text, kind: "content" }); }

function mounted({ caps = {}, skills = SKILLS } = {}) {
    const host = $el("div");
    document.body.appendChild(host);
    const toasts = [];
    const gated = [];
    const copied = [];
    const applied = [];
    let pickCb = null;
    const build = createPromptEnhanceView({
        $el,
        toast: (m) => toasts.push(m),
        can: (feature) => caps[feature] !== false,
        openMaterial: (cb) => { pickCb = cb; },
        gateRun: (btn, feature, label) => { gated.push({ btn, feature, label }); },
        applyToPage: (mode, text) => { applied.push({ mode, text }); },
    });
    mockRoute("/rs_prompts/skills", () => jsonResponse(skills));
    // jsdom 没有剪贴板：桩一枚，复制这条路径才测得到「写进去的是哪一段」
    Object.defineProperty(window.navigator, "clipboard", {
        value: { writeText: async (text) => { copied.push(text); } },
        configurable: true, writable: true,
    });
    const pickItem = (word) => [...host.querySelectorAll(".neo-gallery-edit-refpick")]
        .find((b) => b.textContent.includes(word));
    const env = {
        host, toasts, gated, copied, applied,
        // 参考图是编辑页那一副方块 + 取图浮层：「素材库取用」那一项开宿主注入的弹窗，
        // 用例只把取到的那一项喂回回调；「本地上传」那一项点开的是隐藏的 file input
        pick: (item) => { click(env.libPick()); pickCb?.(item); },
        libPick: () => pickItem("素材库"),
        localPick: () => pickItem("本地上传"),
        // 胶囊钮写文字、方块与骰子只有图标 + title；文字匹配只认本页那组钮——
        // 技能 chip 显示的是技能名（「通用增强▾」），松匹配会把「增强」点到 chip 上
        button: (label) => [...host.querySelectorAll("button")]
            .find((b) => b.classList.contains("ns-enhance-btn") && b.textContent.includes(label))
            || [...host.querySelectorAll("button")].find((b) => (b.title || "").includes(label)),
        skillSel: () => host.querySelector(".ns-enhance-skill"),
        depthSel: () => host.querySelector(".ns-enhance-depth"),
        // 右上角那枚「图像 / 视频」开关与提示词入口：按类取，不靠文案在整页里找
        modeBtn: (label) => [...host.querySelectorAll(".ns-enhance-mode-btn")].find((b) => b.textContent.includes(label)),
        activeMode: () => host.querySelector(".ns-enhance-mode-btn.active")?.textContent,
        presetBtn: () => host.querySelector(".ns-enhance-preset-btn"),
        dice: () => host.querySelector(".ns-enhance-dice"),
        // 空舞台那块引导（共享的 .neo-gallery-gm-idle 起手提示：一行大字一句细注）
        guide: () => host.querySelector(".ns-enhance-guide"),
        input: () => host.querySelector(".ns-enhance-input"),
        // 在途时这枚钮就改写成了「停止」，断言按类取，不靠文案在页面上找它
        runBtn: () => host.querySelector(".ns-enhance-run"),
        out: () => [...host.querySelectorAll(".ns-enhance-out")].pop(),
        outs: () => [...host.querySelectorAll(".ns-enhance-out")],
        // 输入卡上方那一行独立的思考/流程状态位（思考中… / 流程阶段），紧凑版面上它是唯一的旁路输出
        line: () => host.querySelector(".ns-enhance-line"),
        // 每一条回话自带「复制 / 落页 / 存预设」三枚图标钮（正文落定之后才出现）：断言永远落在最新那条上
        aiCopy: () => [...host.querySelectorAll(".ns-enhance-msg-acts")].pop()?.querySelector(".ns-enhance-copy"),
        aiGo: () => [...host.querySelectorAll(".ns-enhance-msg-acts")].pop()?.querySelector(".ns-enhance-go"),
        aiSave: () => [...host.querySelectorAll(".ns-enhance-msg-acts")].pop()?.querySelector(".ns-enhance-save"),
        acts: () => [...host.querySelectorAll(".ns-enhance-msg-acts")].pop(),
        status: () => host.querySelector(".ns-enhance-status"),
        tiles: () => [...host.querySelectorAll(".ns-enhance-refrow .neo-gallery-edit-refdrop.has-img")],
        emptySlot: () => host.querySelector(".ns-enhance-refrow .neo-gallery-edit-refdrop:not(.has-img)"),
        refRow: () => host.querySelector(".ns-enhance-refrow"),
        refPicks: () => host.querySelector(".neo-gallery-edit-refpicks"),
        cap: () => host.querySelector(".ns-enhance-refrow .neo-gallery-edit-refcount-num"),
        userMsg: () => host.querySelector(".ns-enhance-msg-user"),
        userMsgs: () => [...host.querySelectorAll(".ns-enhance-msg-user")],
        aiMsg: () => host.querySelector(".ns-enhance-msg-ai"),
        lastAiMsg: () => [...host.querySelectorAll(".ns-enhance-msg-ai")].pop(),
        runs: () => fetchLog.filter((c) => c.path === ENHANCE_API),
        calls: (path) => fetchLog.filter((c) => c.path === path),
    };
    return build(host).then(() => env);
}


test("请求体形状：技能留空不发 skillId；思考深度 off 走 enable_thinking，余下走 reasoning_effort", () => {
    assert.deepEqual(enhancePayload({ text: "一只橘猫" }), { text: "一只橘猫", reasoning_effort: "medium" },
        "默认（智能判断 + 标准思考）只带文本与档位");
    assert.deepEqual(enhancePayload({ text: "猫", skillId: "general_enhance", depth: "high" }),
        { text: "猫", skillId: "general_enhance", reasoning_effort: "xhigh" });
    assert.deepEqual(enhancePayload({ text: "猫", depth: "off" }),
        { text: "猫", enable_thinking: false },
        "不思考不发档位，只发 enable_thinking:false");
    assert.deepEqual(enhancePayload({ text: "猫", depth: "low" }), { text: "猫", reasoning_effort: "low" });
    assert.deepEqual(enhancePayload({ text: "", images: [{ kind: "input", value: "a.png[output]" }] }),
        { text: "", images: [{ kind: "input", value: "a.png[output]" }], reasoning_effort: "medium" },
        "带图才发 images 键");
});

test("拼接与素材库图片源：骰子与历史都走那条分隔线，素材库那一发带 [output] 标注", () => {
    assert.equal(joinPromptText("一座灯塔", "改成黄昏"), "一座灯塔\n\n---\n\n改成黄昏");
    assert.equal(joinPromptText("", "只有下半段"), "只有下半段");
    assert.equal(joinPromptText("只有上半段", ""), "只有上半段");
    assert.deepEqual(galleryImageSource({ filename: "hero.png", subfolder: "Output/2026-10-10" }),
        { src: { kind: "input", value: "Output/2026-10-10/hero.png[output]" }, label: "Output/2026-10-10/hero.png" });
    assert.equal(galleryImageSource({ filename: "hero.png" }).src.value, "hero.png[output]");
    assert.equal(galleryImageSource({ filename: "" }), null, "没有文件名就不是一发可用的图片源");
});

test("历史块：标行分角色、只留最近 8 对、单条裁到 4000 字、参考图只留一句引用", () => {
    assert.equal(historyBlock([]), "", "空会话不垫历史");
    assert.equal(historyBlock([
        { role: "user", text: "一座灯塔", refs: 2 },
        { role: "assistant", text: "黄昏下的灯塔" },
    ]), "上一轮我说的（附 2 张参考图）：\n一座灯塔\n\n上一轮模型回的：\n黄昏下的灯塔",
        "参考图在历史里就是一句引用，图字节只跟当前这一发");
    const many = Array.from({ length: HISTORY_PAIRS * 2 + 4 },
        (_, i) => ({ role: "user", text: `第${String(i).padStart(2, "0")}条` }));
    const block = historyBlock(many);
    assert.ok(!block.includes("第03条") && block.includes(`第${String(4).padStart(2, "0")}条`),
        `只交最近 ${HISTORY_PAIRS} 对（${HISTORY_PAIRS * 2} 条）`);
    assert.equal(historyBlock([{ role: "assistant", text: "长".repeat(HISTORY_CHAR_CAP + 500) }]),
        "上一轮模型回的：\n" + "长".repeat(HISTORY_CHAR_CAP), "单条裁到字数上限");
});

test("技能下拉：顶部一项是智能判断（空值），生图技能与工作流技能不进这一页", async () => {
    resetEnv();
    const env = await mounted();
    const sel = env.skillSel();
    assert.equal(sel.value, "", "默认落在智能判断：不指定技能");
    assert.equal(sel.options[0].textContent, "智能判断");
    const values = [...sel.querySelectorAll("option")].map((o) => o.value);
    assert.deepEqual(values, ["", "general_enhance", "anime_style"],
        "生图技能与带 workflow.json 的技能只走出图链路，不在提示词增强里出现");
    assert.deepEqual([...env.depthSel().options].map((o) => o.value), ["off", "low", "medium", "high"]);
    assert.equal(env.depthSel().value, "medium", "默认标准思考");
    assert.deepEqual(env.gated.map((g) => [g.feature, g.label]), [["prompt_enhance", "增强"]],
        "运行按钮交宿主闸门：能力缺时点它引导启动内核");
});

test("技能清单分图像与视频两池：切到视频只列视频增强技能，落在第一条，没有「智能判断」", async () => {
    resetEnv();
    const env = await mounted();
    const sel = env.skillSel();
    assert.deepEqual([...sel.querySelectorAll("option")].map((o) => o.value),
        ["", "general_enhance", "anime_style"],
        "图像池：智能判断 + 图像增强技能，视频那一池不混进来");
    assert.equal(env.activeMode(), "图像", "默认在图像那一池");

    click(env.modeBtn("视频"));
    await settle();
    assert.equal(env.activeMode(), "视频");
    assert.equal(sel.dataset.follow, "选择技能", "视频模式没有后端自选那一发，chip 不写「智能判断」");
    assert.deepEqual([...sel.querySelectorAll("option")].map((o) => o.value),
        ["text_to_video", "minimax_h3_full_ref"], "视频池只列视频增强技能，没有空值那一项");
    assert.equal(sel.value, "text_to_video", "落在列表第一条：chip 上写的就是它");
    assert.ok(env.input().placeholder.includes("这一镜"), "占位符跟着这一池换");

    click(env.modeBtn("图像"));
    await settle();
    assert.deepEqual([...sel.querySelectorAll("option")].map((o) => o.value),
        ["", "general_enhance", "anime_style"], "切回来重填图像那一池");
    assert.equal(sel.value, "", "跨池的选中不留：落回智能判断");
});

test("模式落进提示词池与请求体：骰子抽视频那一池、存预设落 video/ 前缀、增强带视频技能", async () => {
    resetEnv();
    mockEnhanceStream([content("镜头缓缓推进")]);
    mockRoute("/rs_prompts/random_prompts", () => jsonResponse({ texts: ["抽来的一条视频词"] }));
    mockRoute("/rs_prompts/extract_title", () => jsonResponse({ status: "success", title: "推进镜头" }));
    mockRoute("/rs_prompts/save_prompt", () => jsonResponse("OK"));
    const env = await mounted({ caps: { prompt_library_write: true } });
    click(env.modeBtn("视频"));
    await settle();

    click(env.button("随机灵感"));
    await settle();
    assert.deepEqual(env.calls("/rs_prompts/random_prompts")[0].body, { count: 1, kind: "video" },
        "骰子抽的是视频那一池");

    env.input().value = "黄昏，女子走向街边的出租车";
    click(env.runBtn());
    await settle();
    assert.equal(env.runs()[0].body.skillId, "text_to_video", "发出去的是选中的那条视频增强技能");

    click(env.aiSave());
    await settle();
    assert.equal(env.calls("/rs_prompts/save_prompt")[0].body.name, "video/推进镜头",
        "存进的是视频那一池（video/ 前缀就是池子标记）");
    assert.equal(localStorage.getItem("rs.enhance.media"), "video", "模式要留得下来");
});

test("模式持久化：切到视频后重建页面还落在视频那一池", async () => {
    resetEnv();
    const first = await mounted();
    click(first.modeBtn("视频"));
    await settle();
    const second = await mounted();
    assert.equal(second.activeMode(), "视频", "重建页面读回同一池");
    assert.equal(second.skillSel().value, "text_to_video");
    assert.equal(second.input().placeholder.includes("这一镜"), true);
});

test("空舞台立引导：一条大字一句细注，第一条气泡落下来就收，「新增会话」清空舞台再回来", async () => {
    resetEnv();
    mockEnhanceStream([content("一只橘猫")]);
    const env = await mounted();
    const guide = env.guide();
    assert.ok(guide && !guide.hidden, "舞台空着时引导写在中间，不是一片黑");
    assert.ok(guide.classList.contains("neo-gallery-gm-idle"), "起手提示吃绘画页与视频页那一份共享样式");
    assert.equal(guide.querySelectorAll(".neo-gallery-gm-idle-title").length, 1, "一行大字");
    assert.equal(guide.querySelectorAll(".neo-gallery-gm-idle-sub").length, 1, "一句细注，不铺一堆字");
    assert.equal(guide.querySelectorAll("button").length, 0, "引导里不放第二套钮：抽词、取图、选技能都在输入卡上");

    env.input().value = "一只橘猫";
    click(env.runBtn());
    await settle();
    assert.equal(guide.hidden, true, "第一条气泡落下来，引导收掉");
    assert.ok(env.userMsg() && env.aiMsg(), "舞台上落的是输入与回话这一对气泡");

    click(env.button("新增会话"));
    assert.equal(guide.hidden, false, "清空舞台引导回到中间");
});

test("右上角「提示词」浮层跟着模式换池：视频模式只列视频那一池的条目", async () => {
    resetEnv();
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse([
        { name: "古风女孩", source: "presets" },
        { name: "video/地铁通勤", source: "custom" },
    ]));
    const env = await mounted();
    click(env.modeBtn("视频"));
    await settle();
    click(env.presetBtn());
    await settle();
    assert.equal(document.querySelector(".neo-preset-picker-scope")?.textContent, "视频提示词");
    assert.deepEqual([...document.querySelectorAll(".neo-preset-picker .rs-preset-item")].map((r) => r.dataset.name),
        ["video/地铁通勤"], "图像那一池的条目不进浮层");
    closePresetPicker();
});

test("视频模式没有可用的视频增强技能：点增强只说清楚，不发增强请求", async () => {
    resetEnv();
    mockEnhanceStream([content("不该发出的一发")]);
    const env = await mounted({ skills: [
        { id: "general_enhance", name: "General Enhance", cn_name: "通用增强", category: "image_enhance" },
    ] });
    click(env.modeBtn("视频"));
    await settle();
    env.input().value = "黄昏，女子走向街边的出租车";
    click(env.runBtn());
    await settle();
    assert.equal(env.runs().length, 0, "空 skillId 在视频模式没有后端自选那一发，这一发不发");
    assert.ok(env.toasts.some((m) => m.includes("视频提示词增强技能")), "要到技能管理新建哪一分类要说清楚");
});

test("增强发出的是这一发的输入：默认不指定技能，正文逐字落进结果框，收场钮回到「增强」", async () => {
    resetEnv();
    mockEnhanceStream([content("一座"), content("红色灯塔"), content("立在悬崖上")]);
    const env = await mounted();
    env.input().value = "一座灯塔";
    click(env.runBtn());
    await settle();
    assert.deepEqual(env.runs()[0].body,
        { text: "一座灯塔", reasoning_effort: "medium" },
        "空会话的第一发不垫历史");
    assert.equal(env.out().value, "一座红色灯塔立在悬崖上");
    assert.match(env.status().textContent, /已生成，可复制或存为预设/);
    assert.match(env.runBtn().textContent, /增强/, "流收场后这枚钮回到「增强」");
});

test("舞台是逐轮对话：输入与回话各一条气泡，输入那条带着参考图缩略", async () => {
    resetEnv();
    mockEnhanceStream([content("一只橘猫")]);
    const env = await mounted();
    env.input().value = "一只猫";
    env.pick({ filename: "cat.png", subfolder: "Output" });
    await settle();
    click(env.button("增强"));
    await settle();
    assert.ok(env.userMsg(), "输入那条气泡落在舞台上");
    assert.match(env.userMsg().textContent, /一只猫/);
    assert.equal(env.userMsg().querySelectorAll(".ns-enhance-ref-img").length, 1,
        "参考图缩略留在输入那条里");
    assert.equal(env.aiMsg().querySelector(".ns-enhance-out").value, "一只橘猫", "回话那条就是正文框");
    assert.equal(env.input().value, "一只猫", "输入卡不清场：下一发在原处直接改");
});

test("空输入不发：一句描述或一张参考图都没有就把这一发挡在原地", async () => {
    resetEnv();
    mockEnhanceStream([content("不该出现")]);
    const env = await mounted();
    click(env.button("增强"));
    await settle();
    assert.equal(env.runs().length, 0, "没有输入就不发请求");
    assert.ok(env.toasts.some((m) => m.includes("先写一句描述")));
    assert.equal(env.userMsg(), null, "没发出去的这一发不在舞台上留气泡");
});

test("选了技能、调了不思考、带了参考图：三条都落进请求体", async () => {
    resetEnv();
    mockEnhanceStream([content("一只橘猫坐在窗台上")]);
    const env = await mounted();
    changeValue(env.skillSel(), "general_enhance");
    changeValue(env.depthSel(), "off");
    env.pick({ filename: "cat.png", subfolder: "Output" });
    await settle();
    assert.equal(env.tiles().length, 1, "参考图方块铺了一枚");
    assert.equal(env.cap().textContent, `1/${MAX_ENHANCE_REFS}`, "方块角标写的是收到第几张");
    click(env.button("增强"));
    await settle();
    assert.deepEqual(env.runs()[0].body, {
        text: "",
        skillId: "general_enhance",
        images: [{ kind: "input", value: "Output/cat.png[output]" }],
        enable_thinking: false,
    }, "带图不写文本也发得出去：图片反推那一发吃的就是这一份");
    assert.equal(env.out().value, "一只橘猫坐在窗台上");
});

test("参考图收进编辑页那一副方块：底行没有「上传图片」，取图浮层里两项取图", async () => {
    resetEnv();
    const env = await mounted();
    assert.ok(![...env.host.querySelectorAll("button")].some((b) => b.textContent.includes("上传图片")),
        "输入卡底行不再铺「上传图片」胶囊——取用收在方块上的浮层里");
    assert.equal(env.refPicks().querySelectorAll(".neo-gallery-edit-refpick").length, 2,
        "浮层里就是「本地上传」与「素材库取用」两项");
    assert.equal(env.refPicks().querySelector(".neo-gallery-edit-refcount-num").textContent,
        `0/${MAX_ENHANCE_REFS}`, "浮层头部写着收到第几张");
    assert.equal(env.refRow().querySelectorAll(".neo-gallery-edit-refdrop").length, 1, "空图位铺一枚「＋参考」");
    assert.match(env.emptySlot().textContent, /参考/);
});

test("空格点击就是素材库取用；「本地上传」那一项点开隐藏的文件框", async () => {
    resetEnv();
    const env = await mounted();
    click(env.emptySlot());
    env.pick({ filename: "cat.png", subfolder: "Output" });
    await settle();
    assert.equal(env.tiles().length, 1, "空格的取用落进图位");
    assert.equal(env.cap().textContent, `1/${MAX_ENHANCE_REFS}`);
    const fileEl = env.refRow().querySelector(".ns-enhance-file");
    let opened = 0;
    fileEl.click = () => { opened++; };   // jsdom 开不了系统文件框：认「点的是这枚 input」
    click(env.localPick());
    assert.equal(opened, 1, "「本地上传」那一项开的就是这枚文件框");
});

test("取图浮层带关闭宽限：鼠标跨过方块与浮层之间的间隙点得中两项", async () => {
    resetEnv();
    const env = await mounted();
    const enter = (el) => el.dispatchEvent(new Event("mouseenter"));
    const leave = (el) => el.dispatchEvent(new Event("mouseleave"));
    enter(env.refRow());
    assert.ok(env.refRow().classList.contains("picks-open"), "移入方块行应打开取图浮层");
    // 离开方块去够上方浮层：宽限期内浮层不能立刻收起（纯 :hover 在这里就消失了，两项点不中）
    leave(env.refRow());
    assert.ok(env.refRow().classList.contains("picks-open"), "离开方块进入关闭宽限期，浮层不立刻收起");
    enter(env.refPicks());   // 宽限内移入浮层 → 取消关闭
    await sleep(300);
    assert.ok(env.refRow().classList.contains("picks-open"), "宽限内移入浮层应取消关闭，浮层保持打开");
    leave(env.refPicks());
    await sleep(300);
    assert.ok(!env.refRow().classList.contains("picks-open"), "移开浮层且宽限过后应收起");
});

test("图位只吃图片、收满就挡住：视频不进图位，多出来的报上限", async () => {
    resetEnv();
    const env = await mounted();
    env.pick({ filename: "clip.mp4" });
    await settle();
    assert.equal(env.tiles().length, 0, "视频不进图位");
    assert.ok(env.toasts.some((m) => m.includes("参考图只吃图片")), "不进图位要说清为什么");
    env.pick(["a.png", "b.png", "c.png", "d.png", "e.png"].map((f) => ({ filename: f })));
    await settle();
    assert.equal(env.tiles().length, MAX_ENHANCE_REFS, "图位只收到 MAX_ENHANCE_REFS 张");
    assert.equal(env.emptySlot(), null, "满位不长空位");
    assert.ok(env.toasts.some((m) => m.includes(`参考图最多 ${MAX_ENHANCE_REFS} 张`)), "多出来的那批报的是上限");
});

test("摘掉图位上的一枚：后面的补位，请求体里少那一张", async () => {
    resetEnv();
    mockEnhanceStream([content("一只橘猫")]);
    const env = await mounted();
    env.pick([{ filename: "a.png" }, { filename: "b.png" }]);
    await settle();
    click(env.tiles()[0].querySelector(".neo-gallery-edit-refchip-x"));
    await settle();
    assert.equal(env.tiles().length, 1, "摘掉那一张，后面的补位");
    assert.equal(env.cap().textContent, `1/${MAX_ENHANCE_REFS}`, "浮层上的计数跟着改写");
    click(env.button("增强"));
    await settle();
    assert.deepEqual(env.runs()[0].body.images, [{ kind: "input", value: "b.png[output]" }],
        "发出去的就是留着的那一张");
});

test("思考与流程状态只占输入卡上方那一行：思考正文不上屏，流结束连那一行也收走", async () => {
    resetEnv();
    mockEnhanceStream([
        "data: " + JSON.stringify({ text: "先想一句", kind: "thinking" }),
        "data: " + JSON.stringify({ text: "格式自检", kind: "status" }),
        content("半截正文"),
        "data: " + JSON.stringify({ text: "采纳自检后的整段正文", kind: "replace" }),
    ]);
    const env = await mounted();
    env.input().value = "写一段";
    click(env.button("增强"));
    await settle();
    assert.equal(env.out().value, "采纳自检后的整段正文", "replace 帧整段替换已透传的正文");
    assert.equal(env.host.querySelectorAll(".rs-thinking").length, 0, "这一页不铺思考面板与状态块");
    assert.ok(env.line().hidden, "流结束那一行状态位收走，留供回看的就是正文本身");
    assert.equal(env.lastAiMsg().querySelector(".ns-enhance-line"), null,
        "那一行不在回话里：舞台上留给回看的就是正文本身");
});

test("在途那一发只有一句状态：思考逐字到达也不上屏，正文不落进结果框", async () => {
    resetEnv();
    // 40 帧思考 + 正文：flush 两轮微任务只够读掉前面几帧，断言落在「还在途中」那一刻
    mockEnhanceStream([
        ...Array.from({ length: 40 }, (_unused, i) =>
            "data: " + JSON.stringify({ text: `思考第 ${i} 段`, kind: "thinking" })),
        content("一只橘猫"),
    ]);
    const env = await mounted();
    env.input().value = "写一段";
    click(env.button("增强"));
    await flush(2);
    assert.equal(env.line().hidden, false, "在途中那一行状态位是可见的");
    assert.equal(env.line().textContent, "思考中…", "思考过程只给这一句状态");
    assert.equal(env.host.querySelectorAll(".rs-thinking").length, 0, "思考不铺面板");
    assert.equal(env.out().value, "", "思考正文一个字也不落进结果框");
    await settle();
    assert.equal(env.out().value, "一只橘猫", "正文照常逐字落框");
    assert.ok(env.line().hidden, "正文开始后那一行收走");
});

test("后端把失败写进流里：状态句说清失败，选了技能就给技能详情页那一发", async () => {
    resetEnv();
    mockEnhanceStream([content("半"), "data: [ERROR] Skill agent error: 缺节点"]);
    const env = await mounted();
    env.input().value = "写一段";
    changeValue(env.skillSel(), "anime_style");
    click(env.button("增强"));
    await settle();
    assert.match(env.status().textContent, /Skill agent error/);
    const summaries = [...document.querySelectorAll(".neo-at-summary")].map((e) => e.textContent);
    assert.ok(summaries.some((s) => s.includes("技能执行失败")),
        "选了技能就引导去技能详情页修，不给一个空结果框");
    assert.ok(!env.button("增强").disabled, "这一发结束了，按钮要回到能再发一次的状态");
});

test("复制与随机灵感：复制的是这条回话的正文，随机抽来的一条拼在已有输入后面", async () => {
    resetEnv();
    mockEnhanceStream([content("一座红色灯塔")]);
    mockRoute("/rs_prompts/random_prompts", () => jsonResponse({ texts: ["抽来的一条提示词"] }));
    const env = await mounted();
    // 空流那一发：气泡铺出来了，正文框是空的 → 复制要说清楚，不写剪贴板
    mockRoute(ENHANCE_API, () => sseResponse(["data: [DONE]"]));
    env.input().value = "写一句";
    click(env.button("增强"));
    await settle();
    click(env.aiCopy());
    await settle();
    assert.deepEqual(env.copied, [], "没有正文就不写剪贴板");
    assert.ok(env.toasts.some((m) => m.includes("还没有可复制的提示词")));
    mockEnhanceStream([content("一座红色灯塔")]);

    env.input().value = "我自己的输入";
    click(env.button("随机灵感"));
    await settle();
    assert.equal(env.input().value, "我自己的输入\n\n---\n\n抽来的一条提示词",
        "已有输入不冲掉：抽来的那条拼在后面");
    assert.deepEqual(env.calls("/rs_prompts/random_prompts")[0].body, { count: 1, kind: "image" });

    click(env.button("增强"));
    await settle();
    click(env.aiCopy());
    await settle();
    assert.deepEqual(env.copied, ["一座红色灯塔"]);
    assert.match(env.aiCopy().title, /已复制/, "图标钮的反馈写在悬停提示里");
});

test("保存为预设：操作行三枚都是图标钮，标题由后端从正文自动生成", async () => {
    resetEnv();
    mockEnhanceStream([content("一座红色灯塔立在悬崖上")]);
    mockRoute("/rs_prompts/extract_title", () => jsonResponse({ status: "success", title: "悬崖灯塔" }));
    mockRoute("/rs_prompts/save_prompt", () => jsonResponse("OK"));
    const env = await mounted({ caps: { prompt_library_write: true } });
    env.input().value = "灯塔";
    click(env.runBtn());
    await settle();
    assert.equal(env.aiCopy().textContent.trim(), "", "复制只剩图标，文字在悬停提示里");
    assert.equal(env.aiGo().textContent.trim(), "", "落页钮同样只剩图标，落点写在悬停提示里");
    assert.equal(env.aiSave().textContent.trim(), "", "保存只剩图标，页面上没有名字框");
    click(env.aiSave());
    await settle();
    const saved = env.calls("/rs_prompts/save_prompt")[0];
    assert.equal(saved.body.name, "悬崖灯塔", "标题由后端从正文取");
    assert.equal(saved.body.text, "一座红色灯塔立在悬崖上");
    assert.ok(env.toasts.some((m) => m.includes("悬崖灯塔")), "存成哪一条要说给用户");
});

test("回话上那枚落页钮把正文交对应那页：图像落绘画页，切到视频档就落视频页", async () => {
    resetEnv();
    mockEnhanceStream([content("一座红色灯塔立在悬崖上")]);
    const env = await mounted();
    env.input().value = "灯塔";
    click(env.runBtn());
    await settle();
    assert.match(env.aiGo().title, /绘画页/, "图像档那一发落在绘画页");
    click(env.aiGo());
    assert.deepEqual(env.applied, [{ mode: "image", text: "一座红色灯塔立在悬崖上" }],
        "交出去的就是这一条回话的正文");
    click(env.modeBtn("视频"));
    await settle();
    env.input().value = "灯塔在黄昏里转";
    click(env.runBtn());
    await settle();
    assert.match(env.aiGo().title, /视频页/, "视频档那一发落在视频页");
    click(env.aiGo());
    assert.deepEqual(env.applied[1], { mode: "video", text: "一座红色灯塔立在悬崖上" },
        "中途切了档位，前一条正文仍落它发出时那一侧的页");
});

test("标题兜底：后端那一发没给标题就用正文首行，保存不发空名", async () => {
    resetEnv();
    mockEnhanceStream([content("黄昏的港口，起重机剪影\n第二行")]);
    mockRoute("/rs_prompts/extract_title", () => jsonResponse({ status: "error", error: "LLM 没给标题" }));
    mockRoute("/rs_prompts/save_prompt", () => jsonResponse("OK"));
    const env = await mounted({ caps: { prompt_library_write: true } });
    env.input().value = "港口";
    click(env.runBtn());
    await settle();
    click(env.aiSave());
    await settle();
    assert.equal(env.calls("/rs_prompts/save_prompt")[0].body.name, "黄昏的港口起重机剪影",
        "取名那一发没给标题就用正文首行（写侧的名字清洗会去掉标点），savePromptTo 不许空名");
});

test("操作行在正文落定之后才出现：途中没有钮，空产出也不出现", async () => {
    resetEnv();
    mockEnhanceStream([content("一座红色灯塔")]);
    const env = await mounted({ caps: { prompt_library_write: true } });
    env.input().value = "写一句";
    click(env.runBtn());
    await settle();
    assert.equal(env.acts().hidden, false, "正文落定之后操作行出现");
    // 在途那一发（最后一次性读会挂住，正文因此在路上）：正文没落定就没有钮
    const encoder = new TextEncoder();
    const frames = Array.from({ length: 6 }, (_, i) => encoder.encode(content(`第${i}段`) + "\n"));
    let i = 0;
    mockRoute(ENHANCE_API, () => ({
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: () => new Promise((resolve) => {
                    if (i < frames.length) resolve({ done: false, value: frames[i++] });
                }),
                releaseLock() {},
            }),
        },
    }));
    env.input().value = "写一段长文";
    click(env.runBtn());
    await sleep(20);   // 正文靠 rAF 落框：走一轮真实帧才看得见半截正文
    assert.ok(env.out().value.length > 0, "正文已经在长");
    assert.equal(env.acts().hidden, true, "正文还在长的途中，复制与保存不出现");
    click(env.runBtn());   // 停止：已落的正文当场就是落定的正文
    await sleep(10);
    assert.equal(env.acts().hidden, false, "停止后已落正文也能复制与保存");
    // 空产出：那一发没有可复制与可存的东西，这一行留空
    mockRoute(ENHANCE_API, () => sseResponse(["data: [DONE]"]));
    env.input().value = "再来一发";
    click(env.runBtn());
    await settle();
    assert.equal(env.acts().hidden, true, "空产出的回话不铺钮");
});

test("提示词库写侧归内核：离线点保存只说清楚，不发保存请求", async () => {
    resetEnv();
    mockEnhanceStream([content("一座红色灯塔")]);
    mockRoute("/rs_prompts/save_prompt", () => jsonResponse({ offline: true }, 409));
    const env = await mounted({ caps: { prompt_library_write: false } });
    env.input().value = "灯塔";
    click(env.runBtn());
    await settle();
    click(env.aiSave());
    await settle();
    assert.ok(env.toasts.some((m) => m.includes("保存提示词需要 ComfyUI 运行")));
    assert.equal(env.calls("/rs_prompts/save_prompt").length, 0, "离线点保存不发保存请求");
    assert.equal(env.calls("/rs_prompts/extract_title").length, 0, "门在取名之前，离线不白跑一次 LLM");
});

test("跑到一半时同一枚钮就是停止：断流后已落正文连着输入进会话，钮回到「增强」且不发灰", async () => {
    resetEnv();
    // 停在「还没写完」那一发的流：最后一次性读会挂住，这一发因此在停止前一直在途
    const encoder = new TextEncoder();
    const frames = Array.from({ length: 6 }, (_, i) => encoder.encode(content(`第${i}段`) + "\n"));
    let i = 0;
    mockRoute(ENHANCE_API, () => ({
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: () => new Promise((resolve) => {
                    if (i < frames.length) resolve({ done: false, value: frames[i++] });
                }),
                releaseLock() {},
            }),
        },
    }));
    const env = await mounted();
    env.input().value = "写一段长文";
    click(env.runBtn());
    await sleep(40);   // 正文靠 rAF 落框：走一轮真实帧才看得见半截正文
    assert.ok(env.out().value.length > 0, "停止前已经落了一部分正文");
    assert.match(env.runBtn().textContent, /停止/, "在途时「增强」就是这枚停止，不另铺一枚钮");
    click(env.runBtn());
    await sleep(10);
    assert.equal(env.status().textContent, "已停止");
    assert.match(env.runBtn().textContent, /增强/, "收场后同一枚钮回到「增强」");
    assert.ok(!env.runBtn().disabled, "停止后立刻能再发，钮不发灰");
    assert.equal(env.acts().hidden, false, "已落的正文当场就能复制与保存");
    const landed = env.outs()[0].value;
    env.input().value = "接着写";
    click(env.runBtn());
    await settle();
    assert.ok(env.runs()[1].body.text.includes("写一段长文")
        && env.runs()[1].body.text.includes(landed.slice(0, 3)),
        "停止那一发的输入与已落正文一起进会话，下一发垫着它继续");
});

test("会话默认带上已返回的回话：第二发的正文垫着第一发的输入与产出，元信息行说清垫了几条", async () => {
    resetEnv();
    mockEnhanceStream([content("一座红色灯塔")]);
    const env = await mounted();
    env.input().value = "一座灯塔";
    click(env.runBtn());
    await settle();
    env.input().value = "改成黄昏";
    click(env.runBtn());
    await settle();
    assert.equal(env.runs().length, 2);
    assert.deepEqual(env.runs()[1].body, {
        text: "上一轮我说的：\n一座灯塔\n\n上一轮模型回的：\n一座红色灯塔\n\n---\n\n改成黄昏",
        reasoning_effort: "medium",
    }, "历史垫在正文前，那条分隔线把这一发与上一轮分开");
    assert.match(env.lastAiMsg().querySelector(".ns-enhance-msg-meta").textContent, /带 2 条历史/);
    assert.equal(env.userMsgs().length, 2, "舞台上每发各留一条输入气泡");
});

test("空产出不留空回话：那一发的输入单独进会话", async () => {
    resetEnv();
    mockRoute(ENHANCE_API, () => sseResponse(["data: [DONE]"]));
    const env = await mounted();
    env.input().value = "写一句";
    click(env.runBtn());
    await settle();
    assert.match(env.status().textContent, /这一发没有产出内容/);
    click(env.runBtn());
    await settle();
    assert.deepEqual(env.runs()[1].body, { text: "上一轮我说的：\n写一句\n\n---\n\n写一句", reasoning_effort: "medium" },
        "会话里没有一条空的模型回话");
});

test("新增会话：舞台清场、下一发不垫旧正文，输入卡上的草稿留着", async () => {
    resetEnv();
    mockEnhanceStream([content("一座红色灯塔")]);
    const env = await mounted();
    env.input().value = "一座灯塔";
    click(env.runBtn());
    await settle();
    assert.equal(env.userMsgs().length, 1);
    click(env.button("新增会话"));
    await settle();
    assert.equal(env.userMsgs().length, 0, "舞台清场");
    assert.equal(env.status().textContent, "", "状态行跟着收掉");
    assert.ok(env.toasts.some((m) => m.includes("已开新会话")), "清场要说给用户");
    env.input().value = "一只猫";
    click(env.runBtn());
    await settle();
    assert.equal(env.runs().length, 2);
    assert.equal(env.runs()[1].body.text, "一只猫", "新会话的第一发不垫旧正文");
});

test("Enter 发送、Shift+Enter 换行：输入框里的回车不送流", async () => {
    resetEnv();
    mockEnhanceStream([content("一只橘猫")]);
    const env = await mounted();
    env.input().value = "一只猫";
    keydown(env.input(), "Enter", { shiftKey: true });
    await settle();
    assert.equal(env.runs().length, 0, "Shift+Enter 只换行");
    keydown(env.input(), "Enter");
    await settle();
    assert.equal(env.runs().length, 1, "Enter 就是发送");
});
