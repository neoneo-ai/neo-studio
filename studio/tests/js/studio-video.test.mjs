// 视频页回归：一句话 + 首帧（可选尾帧 / 参考图）出一段视频，独立于导演多段流程。
// 一、进页就铺好整页舞台：空舞台盖一句起手提示（版式类同绘画页 idle），底部浮一张胶囊 composer（首帧 / 尾帧 / 参考
//     三方块、提示词框 + 字数计数、技能 / 分辨率 / 时长 / 种子芯片、生成钮）。
// 二、生成把 composer 现填的参数打成 payload 打 /neo_video_gen/simple，轮询 /simple/{id} 出进度，
//     终态用 /view?type=output 换出成片播放；首帧缺省时 references 为空（t2v 路径）。
// 三、queued / running 时取消钮可见，点它打 /simple/{id}/cancel；终态后取消钮收起。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, mockRoute, clearRoutes, jsonResponse, sleep, click, fetchLog } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?video=${seq++}`);

const settle = async () => { await sleep(0); await flush(); };
const videoPage = () => document.querySelector(".ns-video");
const promptBox = () => document.querySelector(".ns-video .ns-video-prompt");
const skillSel = () => document.querySelector(".ns-video .ns-video-skill");
const sizeSel = () => document.querySelector(".ns-video .ns-video-size");
const sizeMenu = () => sizeSel().parentElement.querySelector(".neo-gallery-gm-chip-menu");
const durSel = () => document.querySelector(".ns-video .ns-video-dur");
const seedBox = () => document.querySelector(".ns-video .ns-video-seed");
const runBtn = () => document.querySelector(".ns-video .ns-video-run");
const cancelBtn = () => document.querySelector(".ns-video .ns-video-cancel");
const statusEl = () => document.querySelector(".ns-video .ns-video-status");
const barEl = () => document.querySelector(".ns-video .ns-video-progress");
const player = () => document.querySelector(".ns-video .ns-video-player");
const slotAdd = () => [...document.querySelectorAll(".ns-video .ns-video-slot-add")];
const deckSlots = () => [...document.querySelectorAll(".ns-video .ns-video-deck .ns-video-slot")];
const isHidden = (el) => el.classList.contains("ns-hidden");
const skillChipBtn = () => document.querySelector(".ns-video .ns-video-chip .neo-gallery-gm-chip-btn");
const skillChipLabel = () => document.querySelector(".ns-video .ns-video-chip .neo-gallery-gm-chip-label");
const skillPanel = () => document.querySelector(".ns-video .neo-gallery-gm-chip-panel");
const videoCfgSel = () => document.querySelector(".ns-video .rs-gen-model-section select");
const videoPosts = () => fetchLog.filter((c) => c.method === "POST" && c.path === "/neo_video_gen/simple");
const pickSkill = (id) => {
    skillSel().value = id;
    skillSel().dispatchEvent(new Event("change", { bubbles: true }));
};
// chip 面板落在哪：面板坐标相对 chip 壳（壳 position:relative），打开时按 chip 的视口矩形算落点，
// 再量面板自己的真实矩形把它推回窗内。jsdom 无布局，落点由注入的 __rect 决定（helpers/env.mjs 的
// installRectStub 认 el.__rect），所以这两枚矩形就是用例里的几何输入。
const rectBox = (top, bottom, left, right) => ({
    x: left, y: top, top, bottom, left, right, width: right - left, height: bottom - top,
});
function withViewport(w, h, fn) {
    const dW = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const dH = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
    try { return fn(); } finally {
        Object.defineProperty(window, "innerWidth", dW);
        Object.defineProperty(window, "innerHeight", dH);
    }
}
// 落点算法读 offsetWidth/offsetHeight 决定「上方放得下吗」，jsdom 恒为 0（无布局）。
// 在元素上盖一层同名自有属性当量好的盒子，出块删掉，落回 jsdom 的 0。
function withBox(el, w, h, fn) {
    Object.defineProperty(el, "offsetWidth", { value: w, configurable: true });
    Object.defineProperty(el, "offsetHeight", { value: h, configurable: true });
    try { return fn(); } finally { delete el.offsetWidth; delete el.offsetHeight; }
}
// 素材方块取用：点取用钮开素材库弹窗，点卡片 = copy_to_input 落盘进方块（首帧 / 尾帧取一张即收窗）
async function pickIntoSlot(slotIdx, name) {
    click(slotAdd()[slotIdx]);
    await settle();
    const card = [...document.querySelectorAll(".ns-libmodal .neo-gallery-thumb-container")]
        .find((c) => c.dataset.filename === name);
    click(card);
    await settle();
    await settle();
}

async function clickTab(name) {
    click(document.querySelector(`.ns-tabs a[data-tab="${name}"]`));
    await settle();
    if (location.hash !== `#/${name}`) location.hash = `#/${name}`;
    await settle();
}

// 轮询响应脚本：queued（生成响应）→ running → succeeded；cancel 命中单独计数
let pollScript, pollIdx, cancelHits;
async function boot() {
    resetEnv();
    clearRoutes();
    pollScript = [
        { success: true, task_id: "T1", status: "running", progress: { value: 3, max: 20 } },
        { success: true, task_id: "T1", status: "succeeded", filename: "clip_00001_.mp4", subfolder: "NeoSimple" },
    ];
    pollIdx = 0;
    cancelHits = 0;
    mockRoute("/neo_studio/version", jsonResponse({ success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [] }));
    mockRoute("/rs_prompts/skills", jsonResponse([
        { id: "minimax_h3_i2v", cn_name: "H3 图生视频", category: "gen_video", gen_video: true, mode: "i2v", requires_ref: true },
        { id: "minimax_h3_t2v", cn_name: "H3 文生视频", category: "gen_video", gen_video: true, mode: "t2v", gen_config: { steps: 8 } },
        { id: "minimax_h3_r2v", cn_name: "H3 全参考", category: "gen_video", gen_video: true, mode: "r2v", requires_ref: true },
        { id: "image_gen", cn_name: "Krea2 文生图", category: "image_gen", gen_image: true },
    ]));
    // 生视频模型列表 + 技能自定参数：面板只有这两样都到位才发覆盖值
    mockRoute("/neo_video_gen/models", jsonResponse({
        diffusion_models: ["minimax_h3_fl2va_pruned_int8_convrot.safetensors", "minimax_h3/model_b.safetensors"],
        text_encoders: ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
        vae: ["minimax_h3_video_vae_fp16.safetensors"],
        loras: ["h3/style_lora.safetensors"],
    }));
    const skillCfg = {
        minimax_h3_t2v: { steps: 8 },
        minimax_h3_r2v: { model: "minimax_h3/model_b.safetensors", steps: 12, loras: [{ name: "h3/style_lora.safetensors", strength: 0.5 }] },
    };
    mockRoute("/neo_image_gen/skill_config", (body, call) =>
        jsonResponse(skillCfg[call.query.get("skill_id")] || {}));
    mockRoute("/neo_gallery/copy_to_input", (body, call) =>
        jsonResponse({ success: true, filename: `copied_${call.query.get("filename")}` }));
    mockRoute("/rs_recipes/list", jsonResponse([]));
    mockRoute("/neo_video_gen/simple", (body) => {
        boot.lastBody = body;
        return jsonResponse({ success: true, task_id: "T1", status: "queued", progress: null, filename: null });
    });
    mockRoute("/neo_video_gen/simple/*", (body, call, params) => {
        const rest = params.rest || "";
        if (rest.endsWith("/cancel")) { cancelHits++; return jsonResponse({ success: true, dequeued: true }); }
        const next = pollScript[pollIdx] || pollScript[pollScript.length - 1];
        pollIdx++;
        return jsonResponse(next);
    });
    document.body.innerHTML = studioBody;
    window.location.hash = "#/home";
    const shim = await import("../../web/studio/shim/app.js");
    // 素材库替身：渲染三张可取用卡片（lib-modal 的取用逻辑认的就是卡片上的 data-filename）
    shim.app.extensionManager.registerSidebarTab({
        id: "neo.gallery",
        render: async (el) => {
            el.innerHTML = "";
            for (const name of ["frame.png", "a.png", "b.png"]) {
                const card = document.createElement("div");
                card.className = "neo-gallery-thumb-container";
                card.dataset.filename = name;
                card.dataset.subfolder = "";
                el.appendChild(card);
            }
        },
    });
    await importApp();
    await settle();
    await settle();
}

test("视频页：进页铺好舞台 + 起手提示 + 底部胶囊（三方块 / 提示词 / 芯片行 / 生成钮）", async () => {
    await boot();
    await clickTab("video");
    assert.ok(videoPage(), "进页应铺好视频页");
    assert.equal(location.hash === "#/video", true, "应切到视频页");
    assert.ok(document.querySelector(".ns-video .ns-video-stage"), "应有整页舞台");
    assert.equal(document.querySelectorAll(".ns-video .ns-video-slot").length, 3, "应有首帧 / 尾帧 / 参考三方块");
    assert.equal(slotAdd().length, 3, "每方块各带一枚取用钮");
    assert.match(document.querySelector(".ns-video-hero-card .neo-gallery-gm-idle-title").textContent, /创建视频/, "空舞台应盖起手提示主行");
    assert.match(document.querySelector(".ns-video-hero-card .neo-gallery-gm-idle-sub").textContent, /选一张图/, "提示应带副行");
    assert.ok(document.querySelector(".ns-video-hero-card").classList.contains("neo-gallery-gm-idle"), "hero 文案应复用绘画页 idle 版式");
    assert.ok(document.querySelector(".ns-video .ns-video-dock"), "应有底部浮动胶囊");
    assert.ok(promptBox(), "应有提示词框");
    assert.equal(document.querySelector(".ns-video .ns-video-count").textContent, "0 / ∞", "字数计数应从 0 起");
    assert.equal(document.querySelectorAll(".ns-video .ns-video-chip").length, 4, "芯片行应有技能 / 分辨率 / 时长 / 种子四颗");
    assert.ok(sizeSel() && durSel(), "应有分辨率与时长下拉");
    assert.ok(seedBox(), "应有种子输入");
    assert.ok(runBtn(), "应有生成钮");
    assert.ok(statusEl(), "应有状态行");

    // 技能下拉只列 gen_video 技能：Krea2 文生图（gen_image）不该进来
    await settle();
    const opts = [...skillSel().options].map((o) => o.value);
    assert.ok(opts.includes("minimax_h3_i2v"), "技能下拉应列出 H3 图生视频");
    assert.ok(!opts.includes("image_gen"), "生图技能不应进视频技能下拉");
});

test("视频页：技能 chip 就是会话页那枚「技能 + 自定参数」面板——select 藏壳里，点开双栏、点技能行写回生效值", async () => {
    await boot();
    await clickTab("video");
    await settle();                       // 技能是异步填进 select 的
    assert.equal(skillSel().hidden, true, "技能 select 收在 chip 壳里当状态容器");
    assert.equal(sizeSel().hidden, true, "分辨率 select 同样收进 chip");
    const opts = [...skillSel().options];
    click(skillChipBtn());
    const panel = skillPanel();
    assert.equal(panel.style.display, "grid", "点技能 chip 应浮出技能 + 自定参数双栏面板");
    assert.ok(panel.querySelector(".neo-gallery-gm-model-box"), "右栏是自定参数（生视频模型 / 步数 / LoRA）");
    const items = [...panel.querySelectorAll(".neo-gallery-gm-skill-item")];
    assert.equal(items.length, opts.length, "左栏技能行取自 select 的 options");
    const last = opts[opts.length - 1];
    click(items[items.length - 1]);
    assert.equal(skillSel().value, last.value, "点技能行写回 select.value（生成 payload 读的就是它）");
    assert.equal(panel.style.display, "grid", "点技能行不关面板——右栏还要看该技能钉的主模型");
    click(panel.querySelector(".neo-gallery-gm-panel-done"));
    assert.equal(panel.style.display, "none", "点「完成」才收起面板");
    assert.equal(skillChipLabel().textContent, last.textContent, "chip 显示生效值，说明 change 有接上 sync");
});

test("视频页：chip 浮层优先弹在 chip 上方并整块落在窗内（会话页那套数值逐字不变）", async () => {
    await boot();
    await clickTab("video");
    await settle();
    const chip = skillChipBtn();
    const panel = skillPanel();
    // ① 视频页 dock 贴窗口底（chip 顶 700 / 窗高 900 / 面板高 520）：上方放得下就弹在上方——
    //    top = 700 − 520 − 6 = 174，面板底 694 离 chip 顶 6px；left = min(300, 1200−640−8) = 300。
    withViewport(1200, 900, () => withBox(panel, 640, 520, () => {
        chip.__rect = rectBox(700, 724, 300, 420);
        panel.__rect = rectBox(174, 694, 300, 940);
        click(chip);
        assert.equal(panel.style.display, "grid");
        assert.equal(parseFloat(panel.style.top), 174, "上方放得下应弹在 chip 上方 6px");
        assert.equal(parseFloat(panel.style.left), 300, "left 不该动");
        click(panel.querySelector(".neo-gallery-gm-panel-done"));
    }));
    // ② 上方放不下（chip 顶 400 − 520 − 6 < 8）：落 chip 下方 430，再夹到窗底内 8px → 372
    //   （372 + 520 = 892 = 900 − 8）。真实矩形 500..1020 越窗 128px → 兜底整块上移。
    withViewport(1200, 900, () => withBox(panel, 640, 520, () => {
        chip.__rect = rectBox(400, 424, 100, 220);
        panel.__rect = rectBox(500, 1020, 100, 740);
        click(chip);
        assert.equal(parseFloat(panel.style.top), 372 - 128, "夹位 + 越窗 128px 兜底上移");
        assert.equal(parseFloat(panel.style.left), 100, "右缘 740 没越窗，left 不该动");
        click(panel.querySelector(".neo-gallery-gm-panel-done"));
        assert.equal(panel.style.display, "none", "「完成」应随面板一起落在窗口内");
    }));
    // ③ 会话页那枚 chip 的处境（composer 在弹层里、弹层顶贴近窗口顶 → 换算量 0；chip 顶 632、
    //    面板 550 高 810 宽、窗 1200×768）：落点必须与今天同值——632−550−6 = 76、min(120, 382) = 120。
    withViewport(1200, 768, () => withBox(panel, 810, 550, () => {
        chip.__rect = rectBox(632, 656, 120, 240);
        panel.__rect = rectBox(76, 626, 120, 930);
        click(chip);
        assert.equal(parseFloat(panel.style.top), 76, "会话页弹法应与今天同值");
        assert.equal(parseFloat(panel.style.left), 120, "会话页 left 应与今天同值");
        click(panel.querySelector(".neo-gallery-gm-panel-done"));
    }));
    // ④ 分辨率 chip 的菜单（chipButton 共用同一套落点）：chip 顶 760、菜单 320 高 → 弹在上方
    //    top = 760 − 320 − 6 = 434（菜单底 754 离 chip 顶 6px）；右缘 860 没越窗 → left 700 原样。
    withViewport(1200, 900, () => {
        const sizeChip = sizeSel().parentElement.querySelector(".neo-gallery-gm-chip-btn");
        const menu = sizeMenu();
        withBox(menu, 160, 320, () => {
            sizeChip.__rect = rectBox(760, 784, 700, 860);
            menu.__rect = rectBox(434, 754, 700, 860);
            click(sizeChip);
            assert.equal(menu.style.display, "block", "点分辨率 chip 应浮出选项菜单");
            assert.equal(parseFloat(menu.style.top), 434, "菜单应弹在 chip 上方 6px");
            assert.equal(parseFloat(menu.style.left), 700);
            const opt = menu.querySelector(".neo-gallery-gm-menu-item");
            const first = [...sizeSel().options][0];
            assert.equal(opt.textContent, first.textContent, "菜单第一项应就是下拉第一项");
            click(opt);
            assert.equal(sizeSel().value, first.value, "落窗内的菜单要点得着选项");
            assert.equal(menu.style.display, "none", "选完菜单应收起");
        });
    });
});

test("视频页：生成打 payload → 轮询出进度 → 终态换出成片并隐藏取消钮", async () => {
    await boot();
    await clickTab("video");
    await settle();
    promptBox().value = "一只陶瓷杯在木桌上慢慢转起来";
    pickSkill("minimax_h3_t2v");
    seedBox().value = "123";
    click(runBtn());
    await settle();

    const post = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_video_gen/simple");
    assert.ok(post, "生成应打 POST /neo_video_gen/simple");
    assert.equal(post.body.prompt, "一只陶瓷杯在木桌上慢慢转起来", "payload 带提示词");
    assert.equal(post.body.skill_id, "minimax_h3_t2v", "payload 带技能 id");
    assert.equal(post.body.width, 1344, "payload 带宽");
    assert.equal(post.body.height, 768, "payload 带高");
    assert.equal(post.body.duration_sec, 5, "payload 带时长秒");
    assert.equal(post.body.seed, 123, "payload 带种子");
    assert.deepEqual(post.body.references, [], "无首帧时 references 为空");
    assert.equal(post.body.last_frame, null, "无尾帧时 last_frame 为 null");

    // 轮询 setInterval 被压到 40ms，等一轮真实时间让 running 落地
    await sleep(60);
    await flush();
    assert.ok(barEl().style.display === "block", "running 时进度条应显示");
    assert.match(statusEl().textContent, /生成中/);

    // 再等一轮 succeeded：成片卡片进舞台，src 指向 output 目录的 /view，hero 标题淡出，取消钮收起
    await sleep(60);
    await flush();
    const v = player();
    assert.ok(v, "终态应在舞台挂出 <video> 播放成片");
    assert.ok(v.closest(".ns-video-clip"), "成片应装在舞台卡片里");
    assert.match(v.getAttribute("src"), /\/view\?filename=clip_00001_\.mp4/);
    assert.match(v.getAttribute("src"), /subfolder=NeoSimple/);
    assert.match(v.getAttribute("src"), /type=output/);
    assert.match(statusEl().textContent, /已完成/);
    assert.ok(document.querySelector(".ns-video-hero").classList.contains("ns-video-hero-off"), "出片后 hero 标题应淡出");
    assert.ok(cancelBtn().style.display === "none", "成片后取消钮应收起");
});

test("视频页：queued 时取消钮可见，点它打 cancel 接口", async () => {
    await boot();
    await clickTab("video");
    await settle();
    promptBox().value = "霓虹街头的雨夜";
    pickSkill("minimax_h3_t2v");
    click(runBtn());
    await settle();
    assert.notEqual(cancelBtn().style.display, "none", "queued 时取消钮应可见");
    click(cancelBtn());
    await settle();
    assert.equal(cancelHits, 1, "取消应打一次 /neo_video_gen/simple/{id}/cancel");
});
test("视频页：技能按生成模式分组，组头就是导演页那两个模式词（关键帧生视频在前）", async () => {
    await boot();
    await clickTab("video");
    await settle();
    click(skillChipBtn());
    const groups = [...skillPanel().querySelectorAll(".neo-gallery-gm-skill-group")].map((g) => g.textContent);
    assert.deepEqual(groups, ["关键帧生视频", "全参考生视频"], "组头沿用导演页的模式名与模式序");
});

test("视频页：素材方块随技能家族换——首尾帧 ↔ 参考图，切回去原样", async () => {
    await boot();
    await clickTab("video");
    await settle();
    pickSkill("minimax_h3_t2v");
    await settle();
    assert.deepEqual(deckSlots().map(isHidden), [false, false, true], "首尾帧家族给首帧 / 尾帧，收起参考图方块");
    pickSkill("minimax_h3_r2v");
    await settle();
    assert.deepEqual(deckSlots().map(isHidden), [true, true, false], "全参考家族收起首帧 / 尾帧，露出参考图");
    pickSkill("minimax_h3_t2v");
    await settle();
    assert.deepEqual(deckSlots().map(isHidden), [false, false, true], "换回首尾帧家族，方块复原");
});

test("视频页：隐藏的方块不进 payload——首帧带着走全参考技能，参考里只剩参考图", async () => {
    await boot();
    await clickTab("video");
    await settle();
    promptBox().value = "把这几张图连成一段";
    pickSkill("minimax_h3_t2v");
    await settle();
    await pickIntoSlot(0, "frame.png");      // 首帧先填上（首尾帧家族），再切家族看它是否被排除
    pickSkill("minimax_h3_r2v");
    await settle();
    await pickIntoSlot(2, "a.png");
    await pickIntoSlot(2, "b.png");
    click(runBtn());
    await settle();
    const body = videoPosts().at(-1).body;
    assert.deepEqual(body.references.map((r) => r.value), ["copied_a.png", "copied_b.png"],
        "payload 只带参考图——收着的首帧不替模式说话");
    assert.equal(body.last_frame, null, "全参考这一发不发 last_frame");
});

test("视频页：自定参数全空时请求体不带覆盖项（跟随技能配置与全局生视频设置）", async () => {
    await boot();
    await clickTab("video");
    await settle();
    promptBox().value = "一只陶瓷杯在木桌上慢慢转起来";
    pickSkill("minimax_h3_t2v");   // 该技能 config 只钉步数，模型与 LoRA 全空
    await settle();
    click(runBtn());
    await settle();
    const body = videoPosts().at(-1).body;
    assert.ok(!("model" in body), "主模型留空 = 不发 model 覆盖");
    assert.ok(!("loras" in body), "无 LoRA 行 = 不发 loras 覆盖");
    assert.ok(!("text_encoder" in body) && !("vae" in body) && !("audio_vae" in body), "编码器 / VAE 留空同样不发");
    assert.equal(body.steps, 8, "步数跟着该技能 config 走");
});

test("视频页：换技能重放该技能自定参数，填进面板的覆盖跟着进 payload", async () => {
    await boot();
    await clickTab("video");
    await settle();
    promptBox().value = "按这几张角色图出一段";
    pickSkill("minimax_h3_r2v");   // 该技能 config 钉了主模型 / 步数 / LoRA
    await settle();
    await settle();
    await pickIntoSlot(2, "a.png");
    assert.equal(videoCfgSel().value, "minimax_h3/model_b.safetensors", "面板主模型换成该技能钉的那一颗");
    click(runBtn());
    await settle();
    const body = videoPosts().at(-1).body;
    assert.equal(body.model, "minimax_h3/model_b.safetensors", "payload 带该技能钉的主模型");
    assert.equal(body.steps, 12, "payload 带该技能钉的步数");
    assert.deepEqual(body.loras, [{ name: "h3/style_lora.safetensors", strength: 0.5 }], "payload 带该技能钉的 LoRA 与强度");
    videoCfgSel().value = "minimax_h3_fl2va_pruned_int8_convrot.safetensors";
    videoCfgSel().dispatchEvent(new Event("change", { bubbles: true }));
    click(runBtn());
    await settle();
    assert.equal(videoPosts().at(-1).body.model, "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "手填的主模型跟着进 payload");
});

test("视频页：技能要参考素材时缺素材不发请求，状态行说清缺哪一样", async () => {
    await boot();
    await clickTab("video");
    await settle();
    promptBox().value = "把这张图动起来";
    pickSkill("minimax_h3_i2v");   // requires_ref：要首帧 / 尾帧
    await settle();
    click(runBtn());
    await settle();
    assert.equal(videoPosts().length, 0, "缺首帧 / 尾帧不发请求");
    assert.match(statusEl().textContent, /首帧 \/ 尾帧至少选一张/, "状态行说清缺哪样");
    pickSkill("minimax_h3_r2v");   // requires_ref：要参考图
    await settle();
    click(runBtn());
    await settle();
    assert.equal(videoPosts().length, 0, "缺参考图不发请求");
    assert.match(statusEl().textContent, /至少选一张参考图/);
});

