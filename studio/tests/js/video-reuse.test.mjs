// 视频卡「复用参数重跑」：副文件记的那一发生效值（gallery 读端 reuse.video）交回出视频页，
// 面板在位就只换内容不重建，逐项校验——技能不在下拉、模型不在清单、时长不在档位、随机种子
// 整项不填；填完的清单落进「已复用 …」提示。链路走真实 buildVideo：boot 桌面端 → 注册钩子 →
// openVideoReuse 导航 + 预填 → 点「生成」验证填进面板的值原样进 payload。
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
const importApp = () => import(`../../web/studio/studio-app.js?videoreuse=${seq++}`);
// gallery-gen 必须 setup 之后动态导入（scripts/* 靠导入钩子指到 shim）；
// 照 studio-app 的 specifier 导入拿同一份模块实例——复用钩子注册在它的模块态里，
// 带查询参数重导会让 _videoReuseOpen 落在另一份模块态上，钩子永远「未就绪」

const settle = async () => { await sleep(0); await flush(); await flush(); };
const videoPage = () => document.querySelector(".ns-video");
const promptBox = () => document.querySelector(".ns-video .ns-video-prompt");
const skillSel = () => document.querySelector(".ns-video .ns-video-skill");
const sizeSel = () => document.querySelector(".ns-video .ns-video-size");
const durSel = () => document.querySelector(".ns-video .ns-video-dur");
const seedBox = () => document.querySelector(".ns-video .ns-video-seed");
const runBtn = () => document.querySelector(".ns-video .ns-video-run");
const deckSlots = () => [...document.querySelectorAll(".ns-video .ns-video-deck .ns-video-slot")];
// 方块上的缩略图 src 就是槽位值（/view?filename=<编码值>&…），解码回来与 payload 的 value 同形
const thumbPaths = (idx) => [...(deckSlots()[idx]?.querySelectorAll("img") || [])]
    .map((i) => decodeURIComponent(new URL(i.getAttribute("src"), "http://test.local").searchParams.get("filename") || ""));
const toastTexts = () => [...document.querySelectorAll("#neo-action-toast-stack .neo-at")].map((el) => el.textContent);
const videoPosts = () => fetchLog.filter((c) => c.method === "POST" && c.path === "/neo_video_gen/simple");

async function boot() {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_studio/version", jsonResponse({ success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [] }));
    mockRoute("/rs_prompts/skills", jsonResponse([
        { id: "minimax_h3_i2v", cn_name: "H3 图生视频", category: "gen_video", gen_video: true, mode: "i2v", requires_ref: true },
        { id: "minimax_h3_t2v", cn_name: "H3 文生视频", category: "gen_video", gen_video: true, mode: "t2v", gen_config: { steps: 8 } },
        { id: "minimax_h3_r2v", cn_name: "H3 全参考", category: "gen_video", gen_video: true, mode: "r2v", requires_ref: true },
        { id: "image_gen", cn_name: "Krea2 文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_video_gen/models", jsonResponse({
        diffusion_models: ["minimax_h3_fl2va_pruned_int8_convrot.safetensors", "minimax_h3/model_b.safetensors"],
        text_encoders: ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
        vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae.safetensors"],
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
    mockRoute("/neo_video_gen/simple", () =>
        jsonResponse({ success: true, task_id: "T1", status: "queued", progress: null, filename: null }));
    mockRoute("/neo_video_gen/simple/*", () =>
        jsonResponse({ success: true, task_id: "T1", status: "running", progress: null, filename: null }));
    document.body.innerHTML = studioBody;
    window.location.hash = "#/home";
    const shim = await import("../../web/studio/shim/app.js");
    // 素材库替身：出视频页的方块取用认卡片上的 data-filename（与 studio-video 同一套）
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

/** 先进一次视频页让钩子注册（与用户先开过一次视频页同形），再跑复用链路 */
async function gotoVideo() {
    window.location.hash = "#/video";
    await settle();
    assert.ok(videoPage(), "视频页应已挂载");
}

/** 视频页挂载（复用钩子注册）后跑一次复用：openVideoReuse → go("video") → 预填，等异步链跑完 */
async function reuse(reusePayload) {
    const { openVideoReuse } = await import("../../web/gallery-gen.js");
    const filled = await openVideoReuse(reusePayload);
    await settle();
    return filled;
}

test("视频复用：首尾帧技能整发填回面板，值原样进 payload，提示列出填了的项", async () => {
    await boot();
    await gotoVideo();
    const filled = await reuse({
        video: true, skill: "minimax_h3_i2v", prompt: "镜头推进，雪夜城市",
        seed: 777, width: 1344, height: 768, duration: 8, frames: 192, steps: 21,
        model: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        loras: [{ name: "h3/style_lora.safetensors", strength: 0.8 }],
        text_encoder: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        vae: "minimax_h3_video_vae_fp16.safetensors",
        audio_vae: "minimax_h3_audio_vae.safetensors",
        src: { subfolder: "NeoSimple", filename: "first.png" },
        last: { subfolder: "NeoSimple", filename: "last.png" },
    });
    assert.equal(skillSel().value, "minimax_h3_i2v", "技能按副文件选中");
    assert.deepEqual(deckSlots().map((s) => s.classList.contains("ns-hidden")), [false, false, true],
        "首尾帧家族铺首帧 / 尾帧方块，收起参考图方块");
    assert.deepEqual(thumbPaths(0), ["NeoSimple/first.png"], "首帧槽填上副文件记的首帧");
    assert.deepEqual(thumbPaths(1), ["NeoSimple/last.png"], "尾帧槽填上副文件记的尾帧");
    assert.equal(seedBox().value, "777", "种子填回生效值");
    assert.equal(sizeSel().value, "1344,768", "出片尺寸按副文件选中");
    assert.equal(durSel().value, "8", "时长按副文件选中");
    assert.equal(promptBox().value, "镜头推进，雪夜城市", "提示词填回");
    assert.deepEqual(filled, ["技能与自定参数", "首帧、尾帧", "种子", "出片尺寸", "时长", "提示词"],
        "清单只列真填进去的项，顺序与面板一致");
    const notice = toastTexts().find((s) => s.includes("已复用"));
    assert.ok(notice, "复用提示应落 actionToast");
    assert.match(notice, /已复用 技能与自定参数、首帧、尾帧、种子、出片尺寸、时长、提示词/);

    click(runBtn());
    await settle();
    const body = videoPosts().at(-1).body;
    assert.equal(body.skill_id, "minimax_h3_i2v");
    assert.equal(body.seed, 777);
    assert.equal(body.duration_sec, 8);
    assert.deepEqual([body.width, body.height], [1344, 768]);
    assert.equal(body.model, "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "那一发的主模型盖过技能配置进 payload");
    assert.deepEqual(body.loras, [{ name: "h3/style_lora.safetensors", strength: 0.8 }], "LoRA 与强度按那一发进 payload");
    assert.equal(body.steps, 21, "步数按那一发进 payload");
    assert.equal(body.text_encoder, "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors");
    assert.equal(body.vae, "minimax_h3_video_vae_fp16.safetensors");
    assert.equal(body.audio_vae, "minimax_h3_audio_vae.safetensors");
    assert.deepEqual(body.references.map((r) => r.value), ["NeoSimple/first.png"], "references 首帧在首位");
    assert.equal(body.last_frame.value, "NeoSimple/last.png", "last_frame 填回尾帧");
});

test("视频复用：面板在位只换内容不重建——写了一半的提示词被复用接管，页不换", async () => {
    await boot();
    // 先进视频页并手写一半提示词（面板在位）
    await gotoVideo();
    const dockBefore = document.querySelector(".ns-video .ns-video-dock");
    promptBox().value = "写到一半的句子";
    const filled = await reuse({
        video: true, skill: "minimax_h3_t2v", prompt: "复用带来的句子", seed: 5, duration: 3,
    });
    assert.equal(document.querySelector(".ns-video .ns-video-dock"), dockBefore, "面板不重建——同一块 dock 换内容");
    assert.equal(promptBox().value, "复用带来的句子", "提示词被那一发接管");
    assert.deepEqual(filled, ["技能与自定参数", "种子", "时长", "提示词"], "没带的项不进清单");
});

test("视频复用：认不出的整项丢掉——技能 / 模型 / 时长 / 随机种子只丢那一项", async () => {
    await boot();
    await gotoVideo();
    const filled = await reuse({
        video: true, skill: "minimax_h3_r2v", prompt: "按这几张角色图出一段",
        seed: -1, width: 999, height: 999, duration: 7, steps: 0,
        model: "not_on_disk/model_x.safetensors",
        loras: [{ name: "gone/style_x.safetensors", strength: 0.9 }],
        src: { subfolder: "NeoSimple", filename: "frame.png" },
        refs: [{ subfolder: "NeoSimple", filename: "a.png" }],
    });
    assert.deepEqual(filled, ["技能与自定参数", "参考图", "提示词"], "丢掉的不进清单");
    assert.deepEqual(thumbPaths(2), ["NeoSimple/frame.png", "NeoSimple/a.png"],
        "全参考技能把首帧记的 src 并进参考图");
    assert.equal(seedBox().value, "", "随机种子不填");
    assert.equal(sizeSel().value, "1344,768", "面板没有的尺寸整项不填");
    assert.equal(durSel().value, "5", "对不上档位的时长整项不填");

    click(runBtn());
    await settle();
    const body = videoPosts().at(-1).body;
    assert.equal(body.model, "minimax_h3/model_b.safetensors", "清单外的主模型不填 = 落回该技能 config 钉的那颗");
    assert.deepEqual(body.loras, [{ name: "h3/style_lora.safetensors", strength: 0.5 }],
        "清单外的 LoRA 丢掉 = 落回技能 config 的 LoRA");
    assert.ok(!("text_encoder" in body) && !("vae" in body) && !("audio_vae" in body), "副文件没记的编码器 / VAE 不发覆盖");
    assert.equal(body.steps, 12, "步数跟着技能 config");
    assert.equal(body.seed, -1, "随机种子进 payload");
    assert.deepEqual([body.width, body.height], [1344, 768], "尺寸落回面板默认");
    assert.equal(body.duration_sec, 5, "时长落回面板默认");
    assert.deepEqual(body.references.map((r) => r.value), ["NeoSimple/frame.png", "NeoSimple/a.png"]);
    const notice = toastTexts().find((s) => s.includes("已复用"));
    assert.match(notice, /已复用 技能与自定参数、参考图、提示词/);
});

test("视频复用：技能不在下拉——技能不动，素材按面板现家族填、种子照填", async () => {
    await boot();
    await gotoVideo();
    const before = skillSel().value;
    const filled = await reuse({
        video: true, skill: "gone_skill", prompt: "一段没有对口技能的话",
        seed: 42, src: { subfolder: "NeoSimple", filename: "frame.png" },
    });
    assert.ok(videoPage(), "页面停在视频页");
    assert.equal(skillSel().value, before, "认不出的技能不改面板选中");
    assert.deepEqual(filled, ["参考图", "种子", "提示词"], "认不出的只有技能：素材与种子照填进面板现家族");
    assert.deepEqual(thumbPaths(2), ["NeoSimple/frame.png"],
        "面板停在参考家族：src 落进参考槽，首帧 / 尾帧方块不动");
});
