// 预设模型清单的前端消费（后端 studio/skill_models.py 的 GET /neo_skill_models/check）：
// ① 生成前硬拦——清单要用的模型文件没落盘就不提交任务，通知给「去模型库」；
// ② 生图设置里缺失模型行的「⬇ 模型库」按清单精确落点（源 / 仓库 / 落盘类别 / 文件名）；
// ③ 无清单、技能 id 为空、清单接口不可用时整条降级：放行生成，也不承诺定位不了的下载点。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import {
    resetEnv, clearRoutes, mockRoute, jsonResponse, click, sleep, fetchLog, missingRoutes,
} from "./setup.mjs";

const {
    requestGeneration, skillModelCheck, manifestGap, manifestHubTarget, manifestHubNote,
} = await import("../../web/image-gen.js");
const { closeModelHub } = await import("../../web/model-hub.js");

const SKILL_ID = "qwen_image_21_body_swap";
const MODEL_FILE = "qwen21/qwen_image_2.1_fp8.safetensors";
const ENCODER_FILE = "qwen3vl_8b_int8_convrot.safetensors";
const LORA_FILE = "girlslikeqweni_ym1.safetensors";
const HUB_REPO = "Comfy-Org/Qwen-Image_ComfyUI";

// 一份真实形状的就位结果：主模型已落盘，Text Encoder 缺，LoRA 缺且推荐源是 gated 的 Hugging Face
const CHECK = {
    skill_id: SKILL_ID, has_manifest: true, family: "qwen_image_21", label: "Qwen-Image 2.1", kind: "image",
    files: [
        { field: "model", category: "diffusion_models", filename: MODEL_FILE, label: "基座", gb: 11.4,
            sources: [{ source: "modelscope", repo: HUB_REPO, path: `split_files/diffusion_models/${MODEL_FILE}`, gated: false, is_primary: true }],
            alt: [], pinned: false, wanted: "", found: MODEL_FILE, ready: true, active: true, optional: false, notes: [] },
        { field: "text_encoder", category: "text_encoders", filename: ENCODER_FILE, label: "文本编码器", gb: 4.7,
            sources: [{ source: "modelscope", repo: HUB_REPO, path: `split_files/text_encoders/${ENCODER_FILE}`, gated: false, is_primary: true }],
            alt: [], pinned: false, wanted: "", found: "", ready: false, active: true, optional: false, notes: [] },
        { field: "loras", category: "loras", filename: LORA_FILE, label: "换脸 LoRA", gb: 0.9,
            sources: [{ source: "huggingface", repo: "comfyanonymous/girlslikeqweni", path: LORA_FILE, gated: true, is_primary: true }],
            alt: [], pinned: true, wanted: LORA_FILE, found: "", ready: false, active: true, optional: false, notes: [] },
    ],
    notes: [],
    missing: ["文本编码器（text_encoders · 4.7 GB）", "换脸 LoRA（loras · 0.9 GB）"],
    missing_count: 2, missing_gb: 5.6, blocked: true,
};
// 自建技能：没有 models.json，就位检查只报 has_manifest=false
const NO_MANIFEST = {
    skill_id: SKILL_ID, has_manifest: false, family: "", label: "", kind: "image",
    files: [], notes: [], missing: [], missing_count: 0, missing_gb: 0, blocked: false,
};
const READY_ALL = {
    family_count: 1, preset_count: 1, blocking_count: 1,
    families: [{
        family: "qwen_image_21", label: "Qwen-Image 2.1", kind: "image",
        skills: [{ skill_id: SKILL_ID, cn_name: "身体替换" }], files: [],
        preset_count: 1, file_count: 3, total_gb: 17.0, missing_count: 2, missing_gb: 5.6, blocked: true,
    }],
};
const PLAN_ITEM = {
    field: "text_encoder", category: "text_encoders", filename: ENCODER_FILE, base_name: ENCODER_FILE,
    label: "文本编码器", gb: 4.7, sources: [], subfolder: "Qwen", on_source: true, reason: "",
    source: "modelscope", gated: false,
    payload: {
        source: "modelscope", repo: HUB_REPO, path: `split_files/text_encoders/${ENCODER_FILE}`,
        category: "text_encoders", subfolder: "Qwen", filename: ENCODER_FILE,
    },
};
const GEN_SETTINGS = { model: MODEL_FILE, text_encoder: ENCODER_FILE, vae: "", loras: [{ name: LORA_FILE, strength: 1 }] };
const GEN_MODELS = { diffusion_models: [MODEL_FILE], text_encoders: [], vae: [], loras: [LORA_FILE] };

/** 就位检查的响应形状就是路由的形状：{success, check} 信封（裸 check 会让前端读不到就位数据） */
function mockCheck(check) { mockRoute("/neo_skill_models/check", () => jsonResponse({ success: true, check })); }

function mockGenerate() { mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "t1", status: "queued" })); }

function mockHubRoutes() {
    mockRoute("/neo_model_hub/settings", () => jsonResponse({
        settings: { source: "modelscope", hf_endpoint: "", hf_token: "", ms_token: "", llm_subdir: "LLM", timeout_total: 3600, sock_read: 120 },
        registry: { groups: [], bundles: [] }, categories: ["text_encoders", "loras"], sources: ["modelscope", "huggingface"],
    }));
    mockRoute("/neo_model_hub/repos", () => jsonResponse({ repos: [{ repo: HUB_REPO, on_hf: true, on_ms: true, downloads: 1 }] }));
    mockRoute("/neo_model_hub/files", () => jsonResponse({ files: [], categories: ["text_encoders", "loras"] }));
    mockRoute("/neo_skill_models/all", () => jsonResponse(READY_ALL));
    mockRoute("/neo_skill_models/plan", (body) => jsonResponse({
        success: true,
        plan: {
            skill_id: body.skill_id, label: "Qwen-Image 2.1", source: body.source, source_label: "MS",
            has_manifest: true, total_gb: 4.7, include_optional: !!body.include_optional,
            needs_token: false, has_token: true, notes: [], files: [PLAN_ITEM],
        },
    }));
}

const genCalls = () => fetchLog.filter((c) => c.path === "/neo_image_gen/generate");

/** 当前挂在页面上的通知条数（actionToast 的桩渲染 .neo-at） */
const countActionToasts = () => document.querySelectorAll(".neo-at").length;

/** 生图设置的模型区：load 会按 getSkillId 读一遍清单，行内入口随清单结果点亮 */
async function modelSection(check, settings = GEN_SETTINGS) {
    const { createModelConfigSection } = await import("../../web/image-gen.js");
    const section = createModelConfigSection({ getSkillId: () => SKILL_ID });
    document.body.appendChild(section.el);
    mockCheck(check);
    section.load(settings, GEN_MODELS);
    await sleep(60);
    return section;
}

/** 按行标签取该行的「⬇ 模型库」入口 */
function hubBtnOf(section, labelText) {
    const row = [...section.el.querySelectorAll(".rs-config-row")]
        .find((r) => r.querySelector(".rs-form-label")?.textContent === labelText);
    return row?.querySelector(".rs-model-hub-btn");
}

const visible = (btn) => !!btn && btn.style.display !== "none";

beforeEach(() => {
    resetEnv();
    clearRoutes();
    closeModelHub();
});

// ============ 生成前硬拦 ============

test("清单缺要用的模型文件：不提交生成任务，报错带文件名与体积", async () => {
    mockCheck(CHECK);
    mockGenerate();
    let err = null;
    await requestGeneration({ skill_id: SKILL_ID, prompt: "x" }).catch((e) => { err = e; });
    assert.ok(err, "缺模型时生成请求应被拒");
    assert.match(err.message, /Qwen-Image 2\.1 缺 2 项模型文件（约 5\.6 GB）/);
    assert.match(err.message, /文本编码器（text_encoders · 4\.7 GB）/);
    assert.match(err.message, /到模型库补齐后即可生成/, "报错要说清去哪补，而不是 ComfyUI 加载节点的堆栈");
    assert.equal(genCalls().length, 0, "缺模型时不得提交 POST /neo_image_gen/generate");
});

test("生成被拦下时的通知带「去模型库」动作", async () => {
    mockCheck(CHECK);
    mockGenerate();
    await assert.rejects(() => requestGeneration({ skill_id: SKILL_ID, prompt: "x" }));
    const card = document.querySelector(".neo-at");
    assert.ok(card, "应给出需用户处理的模型缺失通知");
    assert.match(card.querySelector(".neo-at-summary").textContent, /Qwen-Image 2\.1 缺 2 项模型文件/);
    assert.match(card.querySelector(".neo-at-detail").textContent, /5\.6 GB/);
    assert.equal(card.querySelector(".neo-at-action")?.textContent, "去模型库");
});

test("点「去模型库」：模型库直接展开就绪面板并出该预设的下载计划", async () => {
    mockCheck(CHECK);
    mockGenerate();
    mockHubRoutes();
    await assert.rejects(() => requestGeneration({ skill_id: SKILL_ID, prompt: "x" }));
    click(document.querySelector(".neo-at-action"));
    await sleep(120);
    const overlay = document.querySelector(".neo-hub-overlay");
    assert.ok(overlay, "模型库未打开");
    assert.notEqual(overlay.querySelector(".neo-hub-ready").style.display, "none", "就绪面板应替用户展开");
    const plan = overlay.querySelector(".neo-hub-ready-plan");
    assert.ok(plan, "未出该预设的下载计划");
    assert.match(plan.textContent, /Qwen-Image 2\.1/);
    assert.match(plan.textContent, /qwen3vl_8b_int8_convrot/);
    closeModelHub();
});

test("清单已就位：预检不拦，任务照常提交", async () => {
    mockCheck({ ...CHECK, files: CHECK.files.map((f) => ({ ...f, ready: true })), missing: [], missing_count: 0, missing_gb: 0, blocked: false });
    mockGenerate();
    const snap = await requestGeneration({ skill_id: SKILL_ID, prompt: "x" });
    assert.equal(snap.task_id, "t1");
    assert.equal(genCalls().length, 1, "已就位时生成不该被拦");
    assert.equal(document.querySelector(".neo-at"), null, "已就位不该弹模型缺失通知");
});

test("无清单的预设（自建技能）不拦生成", async () => {
    mockCheck(NO_MANIFEST);
    mockGenerate();
    await requestGeneration({ skill_id: SKILL_ID, prompt: "x" });
    assert.equal(genCalls().length, 1);
});

test("清单接口不可用时预检整条降级：放行生成，检查按无清单处理", async () => {
    mockGenerate();   // 故意不 mock /neo_skill_models/check → 桩回 501
    assert.equal(await skillModelCheck(SKILL_ID), null, "清单读不到就按无清单处理");
    await requestGeneration({ skill_id: SKILL_ID, prompt: "x" });
    assert.ok(missingRoutes.includes("GET /neo_skill_models/check"), "未 mock 的路由应由桩记为缺失路由");
    assert.equal(genCalls().length, 1, "清单接口不可用不该拦下生成");
});

test("技能 id 为空（全局生图设置）不查清单", async () => {
    mockGenerate();
    assert.equal(await skillModelCheck(""), null);
    await requestGeneration({ skill_id: "", prompt: "x" });
    assert.equal(genCalls().length, 1);
    assert.ok(!fetchLog.some((c) => c.path === "/neo_skill_models/check"), "无技能归属时不该发清单请求");
});

// ============ 缺失模型行的「⬇ 模型库」 ============

test("清单缺哪项就在哪一行给「⬇ 模型库」，已就位的行不给", async () => {
    const section = await modelSection(CHECK);
    assert.equal(visible(hubBtnOf(section, "生图模型")), false, "主模型已落盘，不该给下载入口");
    const encoder = hubBtnOf(section, "Text Encoder");
    assert.equal(visible(encoder), true, "清单缺 Text Encoder → 该行给下载入口");
    assert.match(encoder.title, /qwen3vl_8b_int8_convrot\.safetensors/);
    assert.match(encoder.title, /4\.7 GB/);
    assert.match(encoder.title, /Comfy-Org\/Qwen-Image_ComfyUI/, "提示里要写明去哪个源与仓库下载");
    const lora = section.el.querySelector(".rs-gen-lora-row .rs-model-hub-btn");
    assert.equal(visible(lora), true, "清单缺这条 LoRA → LoRA 行给下载入口");
    assert.match(lora.title, /需先在 Hugging Face 接受授权/, "gated 出处要写进提示");
});

test("点缺失行的「⬇ 模型库」：按清单预选源、仓库、落盘类别与搜索词", async () => {
    mockHubRoutes();
    const section = await modelSection(CHECK);
    click(hubBtnOf(section, "Text Encoder"));
    await sleep(120);
    const overlay = document.querySelector(".neo-hub-overlay");
    assert.ok(overlay, "模型库未打开");
    assert.equal(overlay.querySelector(".neo-hub-search").value, "qwen3vl_8b_int8_convrot", "搜索词取清单上的文件名");
    assert.equal(overlay.querySelector(".neo-hub-cat").value, "text_encoders", "落盘类别按清单预选");
    assert.equal(overlay.querySelector(".neo-hub-repo").value, HUB_REPO, "仓库按清单预选");
    closeModelHub();
});

test("无清单的预设不承诺下载点：只标缺失，不出「⬇ 模型库」", async () => {
    const section = await modelSection(NO_MANIFEST);
    assert.ok(section.el.querySelector(".rs-model-select-box.rs-model-missing"), "失效路径仍要如实标缺失");
    const btns = [...section.el.querySelectorAll(".rs-model-hub-btn")];
    assert.ok(btns.length, "每行都应预置下载入口按钮（默认收起）");
    assert.ok(btns.every((b) => !visible(b)), "无清单时不得点亮定位不了的下载点");
});

// ============ 清单项 → 模型库落点（修复弹窗共用同一口径） ============

test("清单项命中：定位到源与仓库；无清单：回落到失效文件名 + 字段类别", () => {
    const gap = manifestGap(CHECK, "text_encoder", "");
    assert.equal(gap.filename, ENCODER_FILE);
    assert.deepEqual(manifestHubTarget(gap, ""), {
        source: "modelscope", repo: HUB_REPO, category: "text_encoders", query: "qwen3vl_8b_int8_convrot",
    });
    // 无清单（自建技能的修复弹窗）：失效文件名去目录与后缀当搜索词，类别取字段对应的落盘类别
    assert.deepEqual(manifestHubTarget(null, "sub/dir/gone.safetensors", "text_encoders"),
        { query: "gone", category: "text_encoders" });
});

test("LoRA 缺失项按当前选名配对：选了别的 LoRA 不点亮", () => {
    assert.equal(manifestGap(CHECK, "loras", LORA_FILE).label, "换脸 LoRA");
    assert.equal(manifestGap(CHECK, "loras", "qwen21/other_lora.safetensors"), null, "选了别的 LoRA 时不该点亮清单项");
    assert.equal(manifestGap(CHECK, "vae", ""), null, "清单里没有缺失的 VAE 项");
    assert.match(manifestHubNote(manifestGap(CHECK, "loras", LORA_FILE)), /Hugging Face · comfyanonymous\/girlslikeqweni/);
});

// ============ 选中技能那一刻就在面板里提示（不走通知条） ============

test("自定参数里选到缺模型的预设：面板内直接写出缺几项多少 GB，次要入口「模型库」带它进就绪面板", async () => {
    mockGenerate();
    mockHubRoutes();
    const section = await modelSection(CHECK);
    const bar = section.el.querySelector(".rs-model-gap");
    assert.ok(bar && bar.style.display !== "none", "选到缺模型的预设要在当前界面出提示条");
    assert.match(bar.textContent, /Qwen-Image 2\.1 缺 2 项模型文件（约 5\.6 GB）/);
    assert.match(bar.textContent, /文本编码器（text_encoders · 4\.7 GB）/, "要写清缺的是哪几项");
    assert.equal(countActionToasts(), 0, "面板内的提示不该走通知条");
    assert.equal(genCalls().length, 0, "提示本身不提交生成任务");
    click(bar.querySelector(".rs-model-gap-alt"));
    await sleep(120);
    const overlay = document.querySelector(".neo-hub-overlay");
    assert.ok(overlay, "点「模型库」应打开模型库");
    assert.notEqual(overlay.querySelector(".neo-hub-ready").style.display, "none", "应带该预设展开就绪面板");
    closeModelHub();
});

test("无清单的技能（自建）在面板里不打扰：提示条收起", async () => {
    mockGenerate();
    const section = await modelSection(NO_MANIFEST);
    const bar = section.el.querySelector(".rs-model-gap");
    assert.ok(bar, "提示条应预置在面板里（默认收起）");
    assert.equal(bar.style.display, "none", "无清单不该出现缺模型提示");
    assert.equal(countActionToasts(), 0);
});

test("清单项已就位：提示条收起，生成照常", async () => {
    mockGenerate();
    const ready = { ...CHECK, files: CHECK.files.map((f) => ({ ...f, ready: true })), missing: [], missing_count: 0, missing_gb: 0, blocked: false };
    const section = await modelSection(ready);
    assert.equal(section.el.querySelector(".rs-model-gap").style.display, "none", "已就位不该提示");
    assert.equal(countActionToasts(), 0);
});

test("只缺一项：提示条那一个是唯一入口，行内不再给同一目标的第二个按钮", async () => {
    mockGenerate();
    mockHubRoutes();
    const one = {
        ...CHECK,
        files: CHECK.files.map((f) => ({ ...f, ready: f.field !== "text_encoder" })),
        missing: ["文本编码器（text_encoders · 4.7 GB）"], missing_count: 1, missing_gb: 4.7, blocked: true,
    };
    const section = await modelSection(one);
    const bar = section.el.querySelector(".rs-model-gap");
    assert.notEqual(bar.style.display, "none", "缺模型仍要写进面板");
    assert.equal([...section.el.querySelectorAll(".rs-model-hub-btn")].filter(visible).length, 0,
        "只缺一项时行内不该出现第二个下载入口");
    assert.match(bar.querySelector(".rs-model-gap-btn").textContent, /⬇ 下载 4\.7 GB/, "那一个按钮就地补齐");
    click(bar.querySelector(".rs-model-gap-alt"));
    await sleep(120);
    assert.notEqual(document.querySelector(".neo-hub-overlay")?.querySelector(".neo-hub-ready").style.display,
        "none", "次要入口「模型库」带该预设展开就绪面板");
    closeModelHub();
});

// ============ 面板顶部就地补齐：出计划 → 走模型库下载 → 进度写在提示条上 ============

const DL_RUNNING = { state: "running", filename: ENCODER_FILE, category: "text_encoders", total: 3e9, done: 1.5e9, speed: 5e6 };
const DL_DONE = { state: "done", filename: ENCODER_FILE, category: "text_encoders", total: 3e9, done: 3e9, speed: 0 };
const CHECK_READY = { ...CHECK, files: CHECK.files.map((f) => ({ ...f, ready: true })), missing: [], missing_count: 0, missing_gb: 0, blocked: false };

function mockPlan(overrides = {}) {
    mockRoute("/neo_skill_models/plan", (body) => jsonResponse({
        success: true,
        plan: {
            skill_id: body.skill_id, label: "Qwen-Image 2.1", source: "modelscope", source_label: "MS",
            has_manifest: true, total_gb: 4.7, include_optional: false, needs_token: false, has_token: true,
            notes: [], files: [PLAN_ITEM], ...overrides,
        },
    }));
}

/** 模型库下载接口桩：/download 启动，/progress 按给定的状态序列回（用完重复最后一个） */
function mockHubDownload(...states) {
    mockRoute("/neo_model_hub/download", () => jsonResponse({ success: true, download: { state: "running" } }));
    mockRoute("/neo_model_hub/cancel", () => jsonResponse({ success: true }));
    let i = 0;
    mockRoute("/neo_model_hub/progress", () => jsonResponse({
        success: true, download: states[Math.min(i++, states.length - 1)],
    }));
}

const progressCalls = () => fetchLog.filter((c) => c.path === "/neo_model_hub/progress").length;

test("主按钮就地补齐：直接出计划并开下，进度写在这条提示上，按钮换成取消", async () => {
    mockGenerate();
    mockHubRoutes();
    mockPlan();
    mockHubDownload(DL_RUNNING);
    const section = await modelSection(CHECK);
    const bar = section.el.querySelector(".rs-model-gap");
    const btn = bar.querySelector(".rs-model-gap-btn");
    assert.match(btn.textContent, /⬇ 下载 5\.6 GB/);
    click(btn);
    await sleep(60);
    const dl = fetchLog.filter((c) => c.path === "/neo_model_hub/download");
    assert.equal(dl.length, 1, "补齐应直接调用模型库的下载接口，不该先把用户赶去模型库");
    assert.equal(dl[0].body.filename, ENCODER_FILE, "下载的应是计划里那条缺失文件");
    assert.match(bar.textContent, /下载中/);
    assert.match(bar.textContent, /50\.0%/);
    assert.equal(btn.textContent, "✕ 取消", "正在下载时那一个按钮就是取消");
    click(btn);
    await sleep(40);
    assert.ok(fetchLog.some((c) => c.path === "/neo_model_hub/cancel"), "点取消要断掉模型库那次下载");
    const seen = progressCalls();
    await sleep(80);
    assert.equal(progressCalls(), seen, "取消后轮询必须停，不留后台定时器");
});

test("补齐下完：重读就位清单，提示条自己收起并给一条「已补齐」通知", async () => {
    mockGenerate();
    mockHubRoutes();
    mockPlan();
    mockHubDownload(DL_DONE);
    let served = CHECK;
    const section = await modelSection(CHECK);
    mockRoute("/neo_skill_models/check", () => jsonResponse({ success: true, check: served }));
    click(section.el.querySelector(".rs-model-gap-btn"));
    served = CHECK_READY;
    await sleep(60);
    assert.equal(section.el.querySelector(".rs-model-gap").style.display, "none", "文件落盘后提示条该收起");
    assert.match(document.querySelector(".neo-at")?.textContent || "", /预设模型已补齐/);
    assert.equal([...section.el.querySelectorAll(".rs-model-hub-btn")].filter(visible).length, 0,
        "就位后行内入口一并收起");
    assert.equal(genCalls().length, 0, "补齐本身不提交生成任务");
});

test("下载失败：提示条写明原因并给出「⬇ 重试」与「模型库」，不留在取消态", async () => {
    mockGenerate();
    mockHubRoutes();
    mockPlan();
    mockHubDownload({ state: "error", filename: ENCODER_FILE, category: "text_encoders", total: 3e9, done: 0, speed: 0, error: "连接被重置" });
    const section = await modelSection(CHECK);
    const bar = section.el.querySelector(".rs-model-gap");
    const btn = bar.querySelector(".rs-model-gap-btn");
    click(btn);
    await sleep(60);
    assert.match(bar.textContent, /补齐失败：连接被重置/);
    assert.equal(btn.textContent, "⬇ 重试");
    assert.notEqual(bar.querySelector(".rs-model-gap-alt").style.display, "none", "失败后要能改用模型库");
});

test("计划要先填 Token 时不硬下：写明原因，那一个按钮改成「去模型库」", async () => {
    mockGenerate();
    mockHubRoutes();
    mockPlan({ needs_token: true, has_token: false });
    mockHubDownload(DL_DONE);
    const section = await modelSection(CHECK);
    const bar = section.el.querySelector(".rs-model-gap");
    const btn = bar.querySelector(".rs-model-gap-btn");
    click(btn);
    await sleep(60);
    assert.match(bar.textContent, /该源需要先在模型库设置里填 HF Token/, "要先做什么写在提示条上");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_model_hub/download").length, 0, "填 Token 前不该发起下载");
    assert.equal(btn.textContent, "⬇ 去模型库");
    click(btn);
    await sleep(120);
    assert.ok(document.querySelector(".neo-hub-overlay"), "降级后点它应打开模型库就绪面板");
    closeModelHub();
});


test("本机已有同名文件（计划里没有可下条目）：主按钮直接是「去模型库」，不发起那次必被「已存在」顶回的下载", async () => {
    mockGenerate();
    mockHubRoutes();
    mockPlan({ total_gb: 0, files: [{ ...PLAN_ITEM, payload: undefined }] });
    mockHubDownload(DL_DONE);
    const section = await modelSection(CHECK);
    const bar = section.el.querySelector(".rs-model-gap");
    const btn = bar.querySelector(".rs-model-gap-btn");
    assert.equal(btn.textContent, "⬇ 去模型库", "本机已有的文件不该再承诺一次下载");
    click(btn);
    await sleep(120);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_model_hub/download").length, 0, "不该发起下载");
    assert.ok(document.querySelector(".neo-hub-overlay"), "点它应把用户带到模型库换模型");
    closeModelHub();
});


test("自定义模型名不在盘上、族系基础模型在：提示条写明「已回退默认模型」，生成不拦、不发起下载", async () => {
    const PINNED_NAME = "Krea2\\Moody\\moodyKrea2Mix_v40INT8CONVROT.safetensors";
    const BASE_NAME = "Krea2/krea2_turbo_int8_convrot.safetensors";
    const FALLBACK = {
        ...CHECK,
        files: CHECK.files.map((f) => (f.field === "model"
            ? { ...f, ready: true, found: BASE_NAME, fallback_of: PINNED_NAME,
                notes: [`配置里的 ${PINNED_NAME} 本机没有，已回退默认模型 ${BASE_NAME}`] }
            : { ...f, ready: true })),
        missing: [], missing_count: 0, missing_gb: 0, blocked: false,
    };
    mockGenerate();
    mockHubRoutes();
    mockHubDownload(DL_DONE);
    const section = await modelSection(FALLBACK);
    const bar = section.el.querySelector(".rs-model-gap");
    assert.notEqual(bar.style.display, "none", "回退提醒要写在面板里，不能让用户以为跑的是自己挑的那个模型");
    assert.match(bar.textContent, /已回退默认模型/);
    assert.match(bar.textContent, /moodyKrea2Mix_v40INT8CONVROT/);
    assert.equal(bar.querySelector(".rs-model-gap-btn").style.display, "none", "跑得起来就不该给下载按钮");
    assert.equal([...section.el.querySelectorAll(".rs-model-hub-btn")].filter(visible).length, 0,
        "没有要下载的东西，行内入口不该点亮");
    await requestGeneration({ skill_id: SKILL_ID, prompt: "x" });
    assert.equal(genCalls().length, 1, "基础模型在盘上不该拦生成");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_model_hub/download").length, 0, "不该发起那次下载");
});

