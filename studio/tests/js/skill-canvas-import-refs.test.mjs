// 画布导入的参考槽与画布尺寸：ImageScale 的 number widget 不能收到 "{{CANVAS_*}}" 串（NaN），
// 参考槽位只留模板声明的演示槽（容量在 config.json 的 max_refs，运行时才扩展）。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, mockObjectInfo, clearRoutes, jsonResponse, sleep, click } from "./setup.mjs";
import { app, appState } from "./mocks/comfy-app.mjs";

const QWEN_TEMPLATE = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "{{TEXT_ENCODER}}" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "{{VAE}}" } },
    "4": { class_type: "TextEncodeQwenImage21", inputs: {
        clip: ["2", 0], prompt: "{{PROMPT}}", negative_prompt: "{{NEGATIVE}}", vae: ["3", 0],
        "images.image_1": ["30", 0], "images.image_2": ["12", 0] } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: "{{WIDTH}}", height: "{{HEIGHT}}", batch_size: "{{COUNT}}" } },
    "6": { class_type: "KSampler", inputs: { model: ["1", 0], seed: "{{SEED}}", steps: "{{STEPS}}",
        positive: ["4", 0], negative: ["4", 1], latent_image: ["5", 0] } },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["3", 0] } },
    "8": { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: "{{PREFIX}}" } },
    "10": { class_type: "LoadImage", inputs: { image: "{{REF_IMAGE_1}}" } },
    "12": { class_type: "LoadImage", inputs: { image: "{{REF_IMAGE_2}}" } },
    "30": { class_type: "ImageScale", inputs: { image: ["10", 0], upscale_method: "lanczos",
        width: "{{CANVAS_WIDTH}}", height: "{{CANVAS_HEIGHT}}", crop: "disabled" } },
};

const CONFIG = { model: "m.safetensors", default_ratio: "16:9", base_resolution: 1024, steps: 25, max_refs: 10 };

beforeEach(() => {
    resetEnv();
    clearRoutes();
    appState.promptGraph = null;
});

async function openPopup() {
    const { createSkillDetailPopup } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/load_skill", () => jsonResponse({
        id: "qwen_image_21", name: "Qwen Image 2.1", content: "body", files: [{ name: "skill.md", size: 5 }],
        gen_image: true, gen_video: false, requires_ref: false, multi_turn: false, tags: [], category: "image_gen",
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "qwen_image_21", workflow: QWEN_TEMPLATE }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: [] }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => call.method === "GET" ? jsonResponse(CONFIG) : jsonResponse({ success: true }));
    mockObjectInfo({ LoadImage: { input: { required: { image: [["example.png", "other.png"], { image_upload: true }] } } } });
    const popup = createSkillDetailPopup();
    await popup.openExisting("qwen_image_21", "preset");
    await sleep(80);
    return popup;
}

const CONTROL_TEMPLATE = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" } },
    "2": { class_type: "ModelPatchLoader", inputs: { name: "fun_controlnet.safetensors" } },
    "3": { class_type: "AIO_Preprocessor", inputs: { image: ["12", 0], preprocessor: "OpenposePreprocessor", resolution: "{{CANVAS_HEIGHT}}" } },
    "4": { class_type: "ZImageFunControlnet", inputs: { model: ["1", 0], model_patch: ["2", 0], image: ["3", 0] } },
    "10": { class_type: "LoadImage", inputs: { image: "{{REF_IMAGE_1}}" } },
    "12": { class_type: "LoadImage", inputs: { image: "{{CONTROL_IMAGE}}" } },
};
const CONTROL_CONFIG = { model: "m.safetensors", default_ratio: "16:9", base_resolution: 1024, steps: 30, min_refs: 2, control_ref: 2 };

async function openControlPopup() {
    const { createSkillDetailPopup } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/load_skill", () => jsonResponse({
        id: "qwen_image_21_controlnet", name: "Qwen ControlNet", content: "body",
        files: [{ name: "skill.md", size: 5 }], gen_image: true, gen_video: false,
        requires_ref: true, multi_turn: false, tags: [], category: "image_gen",
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "qwen_image_21_controlnet", workflow: CONTROL_TEMPLATE }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: [] }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => call.method === "GET" ? jsonResponse(CONTROL_CONFIG) : jsonResponse({ success: true }));
    mockObjectInfo({ LoadImage: { input: { required: { image: [["example.png", "other.png"], { image_upload: true }] } } } });
    const popup = createSkillDetailPopup();
    await popup.openExisting("qwen_image_21_controlnet", "preset");
    await sleep(80);
    return popup;
}

function importBtn() {
    const all = document.querySelectorAll(".rs-wf-canvas-btns button.rs-wf-canvas-import-btn");
    return all.length ? all[all.length - 1] : null;
}

async function importToCanvas() {
    const loadedAt = appState.loaded.length;
    click(importBtn());
    await sleep(80);
    const api = appState.loaded.slice(loadedAt).filter((l) => l.kind === "api");
    assert.equal(api.length, 1, "应调 app.loadApiJson 一次");
    return api[0].data;
}

test("导入到画布：ImageScale 的画布宽高灌成数字（不残留 {{CANVAS_*}} 串 → 无 NaN）", async () => {
    await openPopup();
    const wf = await importToCanvas();
    const scale = wf["30"].inputs;
    assert.strictEqual(wf["5"].inputs.width, 1024, "长边 1024 按 16 对齐（与后端 _round_multiple 同口径，整数倍不抬高）");
    assert.strictEqual(wf["5"].inputs.height, 576, "16:9 短边 576 按 16 对齐");
    assert.strictEqual(scale.width, 1024, "画布尺寸按 32 对齐（后端 _edit_canvas_size 口径）");
    assert.strictEqual(scale.height, 576);
    assert.ok(Number.isFinite(scale.width) && Number.isFinite(scale.height), "number widget 必须是有限数字");
});

test("导入到画布：参考槽位只留模板声明的槽（占串替换为默认图片避免红框）", async () => {
    await openPopup();
    const wf = await importToCanvas();
    const loads = Object.values(wf).filter((n) => n.class_type === "LoadImage");
    assert.equal(loads.length, 2, "画布只显示模板的 2 个演示槽");
    assert.deepEqual(loads.map((n) => n.inputs.image), ["example.png", "other.png"],
        "槽位 N 取 combo[N-1]，两槽不共用同一张图");
    assert.ok(!Object.keys(wf["4"].inputs).some((k) => /^images\.image_[3-9]$/.test(k)),
        "导入不预造空槽位连线");
});

test("导入到画布：{{CONTROL_IMAGE}} 按 config 的 control_ref 换成实际图片（不残留占串）", async () => {
    await openControlPopup();
    const wf = await importToCanvas();
    assert.equal(wf["10"].inputs.image, "example.png", "内容参考取 combo 第 1 张");
    assert.equal(wf["12"].inputs.image, "other.png", "control_ref=2 → 控制图取 combo 第 2 张");
    for (const node of Object.values(wf)) {
        const v = node.inputs.image;
        assert.ok(typeof v !== "string" || !v.includes("{{"), "LoadImage 不应残留 {{占位符}}");
    }
});

// minimax r2v 演示模板：2 图 / 1 视频 / 1 音频槽，视频与音频槽导出即默认禁用（mode 2 = NEVER）
const MINIMAX_TEMPLATE = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "{{MODEL}}" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "{{TEXT_ENCODER}}" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "{{VAE}}" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: "{{AUDIO_VAE}}" } },
    "5": { class_type: "MiniMaxH3ReferenceToVideo", inputs: {
        clip: ["2", 0], vae: ["3", 0], audio_vae: ["4", 0], prompt: "{{PROMPT}}",
        width: "{{WIDTH}}", height: "{{HEIGHT}}", length: "{{LENGTH}}",
        "ref_images.ref_image_0": ["21", 0], "ref_images.ref_image_1": ["22", 0],
        "ref_videos.ref_video_0": ["41", 0], "ref_audios.ref_audio_0": ["51", 0] } },
    "7": { class_type: "KSampler", inputs: { model: ["1", 0], seed: "{{SEED}}", steps: "{{STEPS}}",
        positive: ["5", 0], negative: ["5", 0], latent_image: ["5", 1] } },
    "8": { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["7", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "VAEDecodeAudio", inputs: { samples: ["8", 1], vae: ["4", 0] } },
    "11": { class_type: "CreateVideo", inputs: { images: ["9", 0], fps: 24, audio: ["10", 0] } },
    "21": { class_type: "LoadImage", inputs: { image: "{{REF_IMAGE_1}}" } },
    "22": { class_type: "LoadImage", inputs: { image: "{{REF_IMAGE_2}}" } },
    "31": { class_type: "LoadVideo", mode: 4, inputs: { file: "{{REF_VIDEO_1}}" } },
    "41": { class_type: "GetVideoComponents", inputs: { video: ["31", 0] } },
    "51": { class_type: "LoadAudio", mode: 4, inputs: { audio: "{{REF_AUDIO_1}}" } },
};
const MINIMAX_CONFIG = { model: "m.safetensors", text_encoder: "clip.safetensors",
    vae: "vvae.safetensors", audio_vae: "avae.safetensors",
    default_ratio: "16:9", base_resolution: 1024, steps: 20, max_refs: 9 };

async function openVideoPopup() {
    const { createSkillDetailPopup } = await import("../../web/skill.js");
    mockRoute("/rs_prompts/load_skill", () => jsonResponse({
        id: "minimax_h3_r2v", name: "MiniMax H3 R2V", content: "body",
        files: [{ name: "skill.md", size: 5 }], gen_image: false, gen_video: true,
        requires_ref: true, multi_turn: false, tags: [], category: "video_gen",
    }));
    mockRoute("/rs_prompts/load_skill_file", () => jsonResponse({ file: "skill.md", content: "body" }));
    mockRoute("/neo_image_gen/skill_workflow", () => jsonResponse({ skill_id: "minimax_h3_r2v", workflow: MINIMAX_TEMPLATE }));
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: ["m.safetensors"], text_encoders: ["clip.safetensors"], vae: ["vvae.safetensors"], loras: [] }));
    mockRoute("/neo_video_gen/settings", () => jsonResponse({ video_model: "m.safetensors", video_text_encoder: "clip.safetensors", video_vae: "vvae.safetensors" }));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: ["m.safetensors"], text_encoders: [], vae: [], loras: [] }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => call.method === "GET" ? jsonResponse(MINIMAX_CONFIG) : jsonResponse({ success: true }));
    mockObjectInfo({ LoadImage: { input: { required: { image: [["example.png", "other.png"], { image_upload: true }] } } } });
    const popup = createSkillDetailPopup();
    await popup.openExisting("minimax_h3_r2v", "preset");
    await sleep(80);
    return popup;
}

test("导入到画布：参考视频/音频槽位带 mode 4（bypass 跳过，占位文件缺失不红框）", async () => {
    await openVideoPopup();
    const wf = await importToCanvas();
    assert.equal(wf["31"].mode, 4, "LoadVideo 参考槽应默认跳过");
    assert.equal(wf["51"].mode, 4, "LoadAudio 参考槽应默认跳过");
    assert.equal(wf["21"].mode, undefined, "LoadImage 参考槽不跳过（已换成实际图片）");
    assert.equal(wf["31"].inputs.file, "{{REF_VIDEO_1}}", "跳过节点保留占位串，回写时还原槽位");
});

test("导入到画布：模板的 mode 灌上画布节点（loadApiJson 不读 mode，重排前补上）", async () => {
    const nodes = Object.keys(MINIMAX_TEMPLATE).map((id) => ({
        id: Number(id), type: MINIMAX_TEMPLATE[id].class_type, mode: 0,
        size: [240, 120], pos: [0, 0],
        setPos(x, y) { this.pos = [x, y]; },
        setSize(s) { this.size = s; },
    }));
    appState.graph = { _nodes: nodes, setDirtyCanvas() {} };
    app.canvas = { fitViewToSelectionAnimated() {} };
    try {
        await openVideoPopup();
        await importToCanvas();
        const modeOf = (id) => nodes.find((n) => String(n.id) === id).mode;
        assert.equal(modeOf("31"), 4, "LoadVideo 槽位灌成跳过（不渲染红框）");
        assert.equal(modeOf("51"), 4, "LoadAudio 槽位灌成跳过");
        assert.equal(modeOf("21"), 0, "模板无 mode 的节点保持启用");
    } finally {
        appState.graph = null;
        app.canvas = null;
    }
});
