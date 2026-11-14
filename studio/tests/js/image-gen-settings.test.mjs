// 生图设置：全局「生图默认设置」表单含 生图模型区 + 生视频模型区（MiniMax H3）+ 输出前缀（LoRA/张数/比例只在每技能设置）；
// 每技能模型区 createModelConfigSection 的 LoRA 行：名称 + 强度，collect 输出 {name, strength}。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep } from "./setup.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

// 构造每技能模型区并 load（同步）；LoRA 由 collect() 的输出断言
async function formLoras(settingsLoras, modelLoras) {
    const { createModelConfigSection } = await import("../../web/image-gen.js");
    const section = createModelConfigSection();
    document.body.appendChild(section.el);
    section.load({ loras: settingsLoras }, { loras: modelLoras });
    return { el: section.el, collect: () => section.collect() };
}

// ============ 全局「生图默认设置」：目标像素数（MP）读写 ============

test("全局生图默认设置：目标像素数 (MP) 读到表单并随保存提交（默认 1.5）", async () => {
    const patches = [];
    mockRoute("/neo_image_gen/settings", (body) => {
        if (body) patches.push(body);
        return jsonResponse({
            target_megapixels: 2.5, model: "", text_encoder: "", vae: "", output_prefix: "NeoAgent",
        });
    });
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: [], text_encoders: [], vae: [] }));
    const { createImageGenSettingsForm } = await import("../../web/image-gen.js");
    const form = createImageGenSettingsForm();
    document.body.appendChild(form.el);
    await form.load();
    const mp = form.el.querySelector("input[type=number]");
    assert.equal(mp.value, "2.5", "设置里的 MP 应回填到表单");
    mp.value = "2";
    await form.save();
    assert.equal(patches.pop().target_megapixels, 2, "保存时带上 MP");
});

test("LoRA collect 输出 {name, strength}", async () => {
    const name = "krea2/Edit/SomeStyle.safetensors";
    const { collect } = await formLoras([{ name, strength: 0.8 }], [name]);
    assert.deepEqual(collect().loras, [{ name, strength: 0.8 }]);
});

test("新增 LoRA 行后 collect 收集（空名跳过）", async () => {
    const QV = "krea2/Edit/Krea2-QuadView_krea2_v1.safetensors";
    const { el, collect } = await formLoras([], [QV]);
    assert.equal(el.querySelectorAll(".rs-gen-lora-row").length, 0, "空设置无 LoRA 行");
    el.querySelector(".rs-gen-lora-add").click();
    el.querySelector(".rs-gen-lora-row select").value = QV;
    assert.deepEqual(collect().loras, [{ name: QV, strength: 1.0 }]);
});
// ============ LoRA 下拉排序：与当前主模型同级者靠前（Qwen 主模型不必在数百个 krea2 LoRA 里翻找）============

const QWEN_MODEL = "QwenImage2.1\\qwen_image_2.1_int8_convrot.safetensors";
// 后端 /neo_image_gen/models 顺序（krea2 靠前，其余按名称）：排序只调顺序、不改内容
const LORA_FILES = [
    "krea2/Character/krea2_杨幂.safetensors",
    "SDXL/Style/xl_more_art-full_v1.safetensors",
    "QwenImage2511/Anime2Real_V4-25.safetensors",
    "QwenImage2.1/Qwen-Image-2.1-viggle-turbo-v0.2.1.safetensors",
    "stars/girlslikeqweni_ym1_杨幂.safetensors",
];
const loraOptions = (el) =>
    [...el.querySelector(".rs-gen-lora-row select").options].slice(1).map((o) => o.value);   // 首项是「自动」

async function loraSection(settings, models) {
    const { createModelConfigSection } = await import("../../web/image-gen.js");
    const section = createModelConfigSection();
    document.body.appendChild(section.el);
    section.load(settings, models);
    return section;
}

test("LoRA 下拉按主模型排序：同目录最前、同家族线索次之，其余保持后端顺序", async () => {
    const section = await loraSection({ model: QWEN_MODEL, loras: [{ name: LORA_FILES[0], strength: 1.0 }] },
        { diffusion_models: [QWEN_MODEL], loras: LORA_FILES, suggested_diffusion_models: QWEN_MODEL });
    assert.deepEqual(loraOptions(section.el), [
        "QwenImage2.1/Qwen-Image-2.1-viggle-turbo-v0.2.1.safetensors",   // 与主模型同目录
        "QwenImage2511/Anime2Real_V4-25.safetensors",                     // 名字含 qwen → 次之（内部保持后端顺序）
        "stars/girlslikeqweni_ym1_杨幂.safetensors",
        "krea2/Character/krea2_杨幂.safetensors",                          // 其余保持后端顺序
        "SDXL/Style/xl_more_art-full_v1.safetensors",
    ]);
});

test("LoRA 下拉排序：Krea2 主模型 krea2 相关靠前，无线索的模型名保持后端顺序", async () => {
    const krea = await loraSection({ model: "Krea2\\krea2_turbo_fp8.safetensors", loras: [{ name: LORA_FILES[1], strength: 1.0 }] },
        { diffusion_models: ["Krea2\\krea2_turbo_fp8.safetensors"], loras: LORA_FILES });
    assert.deepEqual(loraOptions(krea.el), [
        "krea2/Character/krea2_杨幂.safetensors",
        "SDXL/Style/xl_more_art-full_v1.safetensors",
        "QwenImage2511/Anime2Real_V4-25.safetensors",
        "QwenImage2.1/Qwen-Image-2.1-viggle-turbo-v0.2.1.safetensors",
        "stars/girlslikeqweni_ym1_杨幂.safetensors",
    ]);
    const plain = await loraSection({ model: "some_model.safetensors", loras: [{ name: LORA_FILES[0], strength: 1.0 }] },
        { diffusion_models: ["some_model.safetensors"], loras: LORA_FILES });
    assert.deepEqual(loraOptions(plain.el), LORA_FILES, "无目录 / 无家族线索 → 原样");
});

test("切换主模型后 LoRA 下拉重排，各行已选值保留", async () => {
    const section = await loraSection(
        { model: QWEN_MODEL, loras: [{ name: "stars/girlslikeqweni_ym1_杨幂.safetensors", strength: 0.8 }] },
        { diffusion_models: [QWEN_MODEL, "Krea2\\krea2_turbo_fp8.safetensors"], loras: LORA_FILES, suggested_diffusion_models: QWEN_MODEL });
    const [modelSelect, loraSelect] = [section.el.querySelector("select"), section.el.querySelector(".rs-gen-lora-row select")];
    assert.equal(loraOptions(section.el)[0], "QwenImage2.1/Qwen-Image-2.1-viggle-turbo-v0.2.1.safetensors", "Qwen 主模型 → Qwen LoRA 在最前");
    modelSelect.value = "Krea2\\krea2_turbo_fp8.safetensors";
    modelSelect.dispatchEvent(new Event("change"));
    assert.equal(loraOptions(section.el)[0], "krea2/Character/krea2_杨幂.safetensors", "切到 Krea2 主模型 → krea2 LoRA 在最前");
    assert.equal(loraSelect.value, "stars/girlslikeqweni_ym1_杨幂.safetensors", "各行已选值不受重排影响");
    assert.equal(section.collect().loras[0].name, "stars/girlslikeqweni_ym1_杨幂.safetensors");
});
// ============ 下拉项带文件更新时间（后端 mtimes_* 给 epoch 秒；取不到时间的模型不带后缀）============

test("模型下拉带更新日期：mtimes 里的模型名称后追加日期，缺时间的模型原样显示", async () => {
    const NEW = "QwenImage2.1/qwen_image_2.1_int8_convrot.safetensors";
    const OLD = "krea2/krea2_turbo_fp8.safetensors";
    // 用本地时间构造 epoch，断言只看日期部分，不受跑测试机器时区影响
    const epoch = new Date(2026, 8, 12, 12, 0, 0).getTime() / 1000;
    const section = await loraSection({ model: NEW, loras: [] },
        { diffusion_models: [NEW, OLD], mtimes_diffusion_models: { [NEW]: epoch } });
    const labels = [...section.el.querySelector("select").options].slice(1).map((o) => o.textContent);
    assert.deepEqual(labels, ["qwen_image_2.1_int8_convrot · 2026-09-12", "krea2_turbo_fp8"]);
    assert.deepEqual([...section.el.querySelector("select").options].slice(1).map((o) => o.value),
        [NEW, OLD], "带日期只改显示文本，选中值仍是模型路径");
});

test("LoRA 下拉带更新日期：mtimes_loras 随行重建保留", async () => {
    const lora = "QwenImage2.1/Qwen-Image-2.1-viggle-turbo-v0.2.1.safetensors";
    const epoch = new Date(2026, 0, 5, 12, 0, 0).getTime() / 1000;
    const section = await loraSection({ model: QWEN_MODEL, loras: [{ name: lora, strength: 1.0 }] },
        { diffusion_models: [QWEN_MODEL], loras: [lora], mtimes_loras: { [lora]: epoch } });
    const labels = [...section.el.querySelector(".rs-gen-lora-row select").options].slice(1).map((o) => o.textContent);
    assert.deepEqual(labels, ["Qwen-Image-2.1-viggle-turbo-v0.2.1 · 2026-01-05"]);
});


// ============ 生图模型 / Text Encoder / VAE 下拉同样按主模型家族排序（后端统一 krea2 优先，Qwen 主模型会埋到很后面）============

const MODEL_FIXTURE = {
    diffusion_models: [
        "Krea2\\krea2_turbo_fp8.safetensors",
        "QwenImage2511\\qwen_image_edit_2511_fp8.safetensors",
        "QwenImage2.1\\qwen_image_2.1_int8_convrot.safetensors",
        "SDXL\\anima-base-v1.0.safetensors",
    ],
    text_encoders: ["t5xxl_fp8_e4m3fn_scaled.safetensors", "qwen3vl_8b_int8_convrot.safetensors", "clip_l.safetensors"],
    vae: ["Krea2-HD-vae.safetensors", "qwen_image_2.1_vae_bf16.safetensors", "wan2.1_vae.safetensors"],
    loras: LORA_FILES,
    suggested_diffusion_models: "Krea2\\krea2_turbo_fp8.safetensors",
    suggested_text_encoders: "qwen3vl_4b_fp8_scaled.safetensors",
    suggested_vae: "qwen_image_vae.safetensors",
};
const selectOptions = (sel) => [...sel.options].slice(1).map((o) => o.value);   // 首项是「自动」
const sectionSelects = (el) => el.querySelectorAll("select");                   // 主模型 / Encoder / VAE / LoRA

test("生图模型 / Encoder / VAE 下拉按主模型家族排序：同目录最前、同家族线索次之", async () => {
    const section = await loraSection({ model: QWEN_MODEL, loras: [{ name: LORA_FILES[0], strength: 1.0 }] }, MODEL_FIXTURE);
    const [model, encoder, vae] = sectionSelects(section.el);
    assert.deepEqual(selectOptions(model), [
        "QwenImage2.1\\qwen_image_2.1_int8_convrot.safetensors",   // 与主模型同目录
        "QwenImage2511\\qwen_image_edit_2511_fp8.safetensors",     // 名字含 qwen → 次之
        "Krea2\\krea2_turbo_fp8.safetensors",                      // 其余保持后端顺序
        "SDXL\\anima-base-v1.0.safetensors",
    ]);
    assert.deepEqual(selectOptions(encoder),
        ["qwen3vl_8b_int8_convrot.safetensors", "t5xxl_fp8_e4m3fn_scaled.safetensors", "clip_l.safetensors"]);
    assert.deepEqual(selectOptions(vae),
        ["qwen_image_2.1_vae_bf16.safetensors", "Krea2-HD-vae.safetensors", "wan2.1_vae.safetensors"]);
    assert.equal(model.value, QWEN_MODEL, "排序不影响 config 值的回填");
});

test("切换主模型后三个模型下拉也重排（选中值保留，切回 Krea2 恢复后端顺序）", async () => {
    const section = await loraSection({ model: QWEN_MODEL, loras: [] }, MODEL_FIXTURE);
    const [model, encoder] = sectionSelects(section.el);
    assert.equal(selectOptions(model)[0], "QwenImage2.1\\qwen_image_2.1_int8_convrot.safetensors");
    assert.equal(selectOptions(encoder)[0], "qwen3vl_8b_int8_convrot.safetensors");

    model.value = "Krea2\\krea2_turbo_fp8.safetensors";
    model.dispatchEvent(new Event("change"));
    assert.equal(selectOptions(model)[0], "Krea2\\krea2_turbo_fp8.safetensors", "Krea2 主模型 → Krea2 组最前");
    assert.equal(model.value, "Krea2\\krea2_turbo_fp8.safetensors", "重排后选中值保留");
    assert.deepEqual(selectOptions(encoder), MODEL_FIXTURE.text_encoders, "Krea2 主模型 → Encoder 回到后端顺序");
});





test("createModelConfigSection：config 反斜杠模型名匹配正斜杠列表（不回落自动）", async () => {
    const { createModelConfigSection } = await import("../../web/image-gen.js");
    const section = createModelConfigSection();
    document.body.appendChild(section.el);
    // config.json 存反斜杠（工作流导出），模型列表用正斜杠（scan_models）；应归一化后匹配并回填真实选项
    section.load(
        { model: "Krea2\\krea2_turbo_fp8_scaled.safetensors",
          text_encoder: "Qwen\\qwen_2.5_vl_7b_fp8_scaled.safetensors", vae: "sdxl_vae.safetensors" },
        { diffusion_models: ["Krea2/krea2_turbo_fp8_scaled.safetensors"],
          text_encoders: ["Qwen/qwen_2.5_vl_7b_fp8_scaled.safetensors"], vae: ["sdxl_vae.safetensors"] },
    );
    const collected = section.collect();
    assert.equal(collected.model, "Krea2/krea2_turbo_fp8_scaled.safetensors", "反斜杠 config 应匹配正斜杠列表并回填");
    assert.equal(collected.text_encoder, "Qwen/qwen_2.5_vl_7b_fp8_scaled.safetensors");
    assert.equal(collected.vae, "sdxl_vae.safetensors", "无分隔符值仍正常匹配");
    // 不存在的模型名（换分隔符也匹配不上）→ 如实保留原值并标缺失，不再回落「自动」
    section.load({ model: "Krea2\\nonexistent.safetensors" }, { diffusion_models: ["Krea2/krea2_turbo_fp8_scaled.safetensors"] });
    assert.equal(section.collect().model, "Krea2\\nonexistent.safetensors", "未匹配值应如实保留原值（标缺失），不回落自动");
});

test("全局生图默认设置表单只含 生图模型区 + 目标像素数 + 输出前缀（不含 LoRA/张数/比例/视频）", async () => {
    const { createImageGenSettingsForm } = await import("../../web/image-gen.js");
    mockRoute("/neo_image_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    const form = createImageGenSettingsForm();
    document.body.appendChild(form.el);
    await form.load();
    const labels = [...form.el.querySelectorAll(".rs-form-label")].map((el) => el.textContent);
    assert.deepEqual(labels, ["生图模型", "Text Encoder", "VAE", "目标像素数 (MP)", "输出前缀"]);
    assert.equal(form.el.querySelector(".rs-gen-lora-list"), null, "全局表单不应有 LoRA 列表");
    // 唯一的数字框是「目标像素数 (MP)」；张数/步数/强度等仍在每技能设置里
    const numbers = [...form.el.querySelectorAll("input[type=number]")];
    assert.equal(numbers.length, 1, "全局表单只应有目标像素数一个数字框");
    assert.equal(numbers[0].value, "1.5", "目标像素数默认 1.5");
    assert.ok(form.el.querySelector(".rs-gen-save"), "应保留保存按钮");
});

test("全局生视频默认设置表单含 视频模型 / Text Encoder (视频) / VAE (视频) / VAE (音频)", async () => {
    const { createVideoGenSettingsForm } = await import("../../web/image-gen.js");
    mockRoute("/neo_video_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_video_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    const form = createVideoGenSettingsForm();
    document.body.appendChild(form.el);
    await form.load();
    const labels = [...form.el.querySelectorAll(".rs-form-label")].map((el) => el.textContent);
    assert.deepEqual(labels, ["视频模型", "Text Encoder (视频)", "VAE (视频)", "VAE (音频)"]);
    assert.ok(form.el.querySelector(".rs-gen-save"), "应保留保存按钮");
});

test("createVideoModelConfigSection：load 填充四个模型下拉、collect 返回 model/text_encoder/vae/audio_vae", async () => {
    const { createVideoModelConfigSection } = await import("../../web/image-gen.js");
    const section = createVideoModelConfigSection();
    document.body.appendChild(section.el);
    section.load(
        { model: "h3/model.safetensors", text_encoder: "h3/te.safetensors",
          vae: "h3/video_vae.safetensors", audio_vae: "h3/audio_vae.safetensors" },
        { diffusion_models: ["h3/model.safetensors"],
          text_encoders: ["h3/te.safetensors"],
          vae: ["h3/video_vae.safetensors", "h3/audio_vae.safetensors"] });
    const selects = [...section.el.querySelectorAll("select")];
    assert.equal(selects.length, 4, "应有 4 个模型下拉");
    assert.equal(selects[0].value, "h3/model.safetensors");
    assert.equal(selects[1].value, "h3/te.safetensors");
    assert.equal(selects[2].value, "h3/video_vae.safetensors");
    assert.equal(selects[3].value, "h3/audio_vae.safetensors");
    // 「自动」项标注客户端建议名（videoSuggestion 挑首个含 h3/minimax，shortModelName 取末段去扩展名）
    assert.equal(selects[0].options[0].textContent, "自动（model）");
    assert.deepEqual(section.collect(), { model: "h3/model.safetensors", text_encoder: "h3/te.safetensors",
        vae: "h3/video_vae.safetensors", audio_vae: "h3/audio_vae.safetensors", steps: 20, loras: [] });
});

test("createVideoModelConfigSection：步数 load 回填 / 缺省 20 / collect 返回 int", async () => {
    const { createVideoModelConfigSection } = await import("../../web/image-gen.js");
    const section = createVideoModelConfigSection();
    document.body.appendChild(section.el);
    // 显式 steps=35 → 回填输入框并 collect 出 35
    section.load({ model: "h3/model.safetensors", steps: 35 }, { diffusion_models: ["h3/model.safetensors"] });
    const stepsInput = section.el.querySelector("input.rs-form-input:not(.rs-combo-input)");
    assert.ok(stepsInput, "应有步数数字输入框");
    assert.equal(parseInt(stepsInput.value, 10), 35, "load 应回填已保存步数");
    assert.equal(section.collect().steps, 35);
    // 未保存 steps → 缺省 20（与后端 resolve_video_params 默认一致）
    section.load({ model: "h3/model.safetensors" }, { diffusion_models: ["h3/model.safetensors"] });
    assert.equal(parseInt(stepsInput.value, 10), 20, "缺省应为 20");
    assert.equal(section.collect().steps, 20);
    // 用户改值 → collect 反映新值
    stepsInput.value = "32";
    assert.equal(section.collect().steps, 32);
});

test("createGenSizeRows：步数 load 回填 / 缺省 20 / collect 返回 int", async () => {
    const { createGenSizeRows } = await import("../../web/image-gen.js");
    const section = createGenSizeRows();
    document.body.appendChild(section.el);
    // 显式 steps=35 → 回填输入框并 collect 出 35
    section.load({ count: 2, base_resolution: "1024", default_ratio: "16:9", steps: 35 });
    const stepsRow = [...section.el.querySelectorAll(".rs-config-row")]
        .find((r) => r.querySelector("label")?.textContent === "步数");
    assert.ok(stepsRow, "应有「步数」行");
    const stepsInput = stepsRow.querySelector("input.rs-form-input");
    assert.ok(stepsInput, "应有步数数字输入框");
    assert.equal(parseInt(stepsInput.value, 10), 35, "load 应回填已保存步数");
    assert.equal(section.collect().steps, 35);
    // 未保存 steps → 缺省 20（与后端 resolve_request 默认一致）
    section.load({});
    assert.equal(parseInt(stepsInput.value, 10), 20, "缺省应为 20");
    assert.equal(section.collect().steps, 20);
    // 用户改值 → collect 反映新值
    stepsInput.value = "32";
    assert.equal(section.collect().steps, 32);
});

test("createVideoModelConfigSection：视频 LoRA 行 load/collect 往返", async () => {
    const { createVideoModelConfigSection } = await import("../../web/image-gen.js");
    const section = createVideoModelConfigSection();
    document.body.appendChild(section.el);
    section.load(
        { model: "h3/model.safetensors", loras: [
            { name: "h3/style_a.safetensors", strength: 0.8 },
            { name: "h3/style_b.safetensors", strength: -0.5 },
        ] },
        { diffusion_models: ["h3/model.safetensors"], loras: [
            "h3/style_a.safetensors", "h3/style_b.safetensors" ] });
    const rows = section.el.querySelectorAll(".rs-gen-lora-row");
    assert.equal(rows.length, 2, "应有 2 个 LoRA 行");
    const strengthInputs = [...section.el.querySelectorAll(".rs-gen-lora-strength")];
    assert.equal(parseFloat(strengthInputs[0].value), 0.8);
    assert.equal(parseFloat(strengthInputs[1].value), -0.5);
    const collected = section.collect();
    assert.deepEqual(collected.loras, [
        { name: "h3/style_a.safetensors", strength: 0.8 },
        { name: "h3/style_b.safetensors", strength: -0.5 },
    ]);
});

test("createVideoModelConfigSection：新增 LoRA 行后 collect 收集（空名跳过）", async () => {
    const { createVideoModelConfigSection } = await import("../../web/image-gen.js");
    const section = createVideoModelConfigSection();
    document.body.appendChild(section.el);
    section.load({}, { loras: ["h3/style_a.safetensors"] });
    assert.equal(section.el.querySelectorAll(".rs-gen-lora-row").length, 0, "空设置无 LoRA 行");
    section.el.querySelector(".rs-gen-lora-add").click();   // 空名行，collect 应跳过
    section.el.querySelector(".rs-gen-lora-add").click();
    const rows = section.el.querySelectorAll(".rs-gen-lora-row");
    rows[1].querySelector("select").value = "h3/style_a.safetensors";
    rows[1].querySelector(".rs-gen-lora-strength").value = "0.6";
    assert.deepEqual(section.collect().loras, [{ name: "h3/style_a.safetensors", strength: 0.6 }]);
});

test("createModelConfigSection：config 存旧目录路径（模型挪进子目录）时如实标缺失，不自愈回填", async () => {
    const { createModelConfigSection } = await import("../../web/image-gen.js");
    const section = createModelConfigSection();
    document.body.appendChild(section.el);
    // config 里是旧路径 MiniMaxH3/xxx（缺 Speed 层），实际文件在 MiniMaxH3/Speed/xxx → 全路径未命中，
    // 不再按文件名静默回填（会误导用户以为已修好，而运行时仍读失效的 config 原值）；如实保留原值并标缺失
    section.load(
        { model: "MiniMaxH3\\Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors" },
        { diffusion_models: ["MiniMaxH3/Speed/Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors"] },
    );
    assert.equal(section.collect().model, "MiniMaxH3\\Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors", "旧目录路径应如实保留原值（标缺失），不静默回填");
});

test("createModelConfigSection：同名文件在多个子目录时仍如实标缺失（不自愈）", async () => {
    const { createModelConfigSection } = await import("../../web/image-gen.js");
    const section = createModelConfigSection();
    document.body.appendChild(section.el);
    // config 存 C/model.safetensors（C 不在列表），列表里 A/、B/ 各有一个同名文件 → 文件名不唯一，
    // 同样如实保留原值并标缺失（旧行为回落「自动」会掩盖失效路径）
    section.load(
        { model: "C/model.safetensors" },
        { diffusion_models: ["A/model.safetensors", "B/model.safetensors"] },
    );
    assert.equal(section.collect().model, "C/model.safetensors", "失效路径应如实保留原值（标缺失），不回落自动");
});

// ============ 模型下拉家族作用域：主模型行只列当前技能家族，TE / VAE 剔视频 / 音频 / 3D，LoRA 行不作用域 ============

const SCOPE_DIFFUSION = [
    "krea2/krea2_mix_t2i.safetensors",
    "QwenImage2.1/qwen_image_2.1_int8_convrot.safetensors",
    "MiniMaxH3/Speed/h3.safetensors",
    "Wanderlust/Wanderlust.safetensors",
    "MOSS/moss_image_base_bf16.safetensors",
    "Music/minimax_music3_base.safetensors",
];
const SCOPE_LORAS = ["krea2/Edit/SomeStyle.safetensors", "MiniMaxH3/Lora/h3_style.safetensors"];
// 后端一次扫描的响应形状：类别全表 + image_* 作用域表 + LoRA 全表
const SCOPE_MODELS = {
    diffusion_models: SCOPE_DIFFUSION,
    image_diffusion_models: SCOPE_DIFFUSION.filter((f) => !f.startsWith("MiniMaxH3/") && !f.startsWith("Music/")),
    text_encoders: ["krea2/Qwen-Image-2.0_text_encoder.safetensors", "nsfw_wan_umt5.safetensors", "Music/minimax_music_te.safetensors"],
    image_text_encoders: ["krea2/Qwen-Image-2.0_text_encoder.safetensors"],
    vae: ["krea2/flux1-krea2-related-vae.safetensors", "MiniMaxH3/minimax_h3_video_vae.safetensors", "MiniMaxH3/minimax_h3_audio_vae.safetensors"],
    image_vae: ["krea2/flux1-krea2-related-vae.safetensors"],
    loras: SCOPE_LORAS,
};
const optionValues = (select) => [...select.options].map((o) => o.value);   // 首项是「自动」（空值）

/** 该技能的就位清单一发：family 就是主模型行的家族口径；has_manifest=false = 自建技能没有家族 */
function mockSkillCheck(family) {
    mockRoute("/neo_skill_models/check", () => jsonResponse({
        success: true,
        check: { skill_id: "sk", has_manifest: true, family, label: "", kind: "image", files: [],
                 notes: [], missing: [], missing_count: 0, missing_gb: 0, blocked: false },
    }));
}

async function scopeSection(family, settings = {}) {
    mockSkillCheck(family);
    const { createModelConfigSection } = await import("../../web/image-gen.js");
    const section = createModelConfigSection({ getSkillId: () => "sk" });
    document.body.appendChild(section.el);
    section.load(settings, SCOPE_MODELS);
    await sleep(0);   // 就位检查是异步的：家族落到主模型行上要等它落地
    return section;
}

test("生图主模型行按技能家族过滤：Qwen 技能只列 Qwen 家族的权重", async () => {
    const section = await scopeSection("qwen_image_21");
    assert.deepEqual(optionValues(section.modelSelect),
        ["", "QwenImage2.1/qwen_image_2.1_int8_convrot.safetensors"]);

// ============ 生视频四行默认 MiniMax H3 家族，「显示全部模型」回到类别全表 ============

const VIDEO_FULL = {
    diffusion_models: ["MiniMaxH3/h3.safetensors", "MiniMaxH3/Speed/fasth3_omniref_8step.safetensors",
                       "krea2/krea2_mix_t2i.safetensors", "Music/minimax_music3_base.safetensors"],
    video_diffusion_models: ["MiniMaxH3/h3.safetensors", "MiniMaxH3/Speed/fasth3_omniref_8step.safetensors"],
    text_encoders: ["MiniMaxH3/minimax_h3_te.safetensors", "krea2/Qwen-Image-2.0_text_encoder.safetensors",
                    "Music/minimax_music_te.safetensors"],
    video_text_encoders: ["MiniMaxH3/minimax_h3_te.safetensors"],
    vae: ["MiniMaxH3/minimax_h3_video_vae.safetensors", "MiniMaxH3/minimax_h3_audio_vae.safetensors",
          "krea2/flux1-krea2-related-vae.safetensors"],
    video_vae: ["MiniMaxH3/minimax_h3_video_vae.safetensors"],
    video_audio_vae: ["MiniMaxH3/minimax_h3_audio_vae.safetensors", "Music/minimax_music_vae.safetensors"],
    loras: ["MiniMaxH3/Lora/h3_style.safetensors", "krea2/Edit/SomeStyle.safetensors"],
};

test("生视频四行默认只列 MiniMax H3 家族，音频行带 Music 家族，LoRA 行全表", async () => {
    const { createVideoModelConfigSection } = await import("../../web/image-gen.js");
    const section = createVideoModelConfigSection();
    document.body.appendChild(section.el);
    section.load({}, VIDEO_FULL);
    const selects = [...section.el.querySelectorAll("select")];
    assert.deepEqual(optionValues(selects[0]), ["", ...VIDEO_FULL.video_diffusion_models], "视频模型行");
    assert.deepEqual(optionValues(selects[1]), ["", ...VIDEO_FULL.video_text_encoders], "Text Encoder 行");
    assert.deepEqual(optionValues(selects[2]), ["", ...VIDEO_FULL.video_vae], "视频 VAE 行");
    assert.deepEqual(optionValues(selects[3]), ["", ...VIDEO_FULL.video_audio_vae], "音频 VAE 行");
    section.el.querySelector(".rs-gen-lora-add").click();
    assert.deepEqual(optionValues(section.el.querySelector(".rs-gen-lora-row select")),
        ["", ...VIDEO_FULL.loras], "LoRA 行不作用域");
});

test("生视频「显示全部模型」：四行回到类别全表（LoRA 行本来就是全表）", async () => {
    const { createVideoModelConfigSection } = await import("../../web/image-gen.js");
    const section = createVideoModelConfigSection();
    document.body.appendChild(section.el);
    section.load({}, VIDEO_FULL);
    section.el.querySelector(".rs-model-scope-toggle").click();
    const selects = [...section.el.querySelectorAll("select")];
    assert.deepEqual(optionValues(selects[0]), ["", ...VIDEO_FULL.diffusion_models]);
    assert.deepEqual(optionValues(selects[1]), ["", ...VIDEO_FULL.text_encoders]);
    assert.deepEqual(optionValues(selects[2]), ["", ...VIDEO_FULL.vae]);
    assert.deepEqual(optionValues(selects[3]), ["", ...VIDEO_FULL.vae]);
});

test("生视频钉住的跨家族值（技能 config 存的 Krea2 权重）仍可选、不标缺失", async () => {
    const { createVideoModelConfigSection } = await import("../../web/image-gen.js");
    const section = createVideoModelConfigSection();
    document.body.appendChild(section.el);
    section.load({ model: "krea2/krea2_mix_t2i.safetensors" }, VIDEO_FULL);
    const modelSelect = section.el.querySelector("select");
    assert.ok(optionValues(modelSelect).includes("krea2/krea2_mix_t2i.safetensors"));
    assert.equal(section.collect().model, "krea2/krea2_mix_t2i.safetensors");
    assert.equal(section.el.querySelector(".rs-model-select-box.rs-model-missing"), null);
});

// ============ 全局默认设置表单（没有技能家族上下文）：走 image_* / video_* 作用域表 ============

test("全局生图默认设置：三条模型行走 image_* 作用域表，开关回到类别全表", async () => {
    mockRoute("/neo_image_gen/settings", () => jsonResponse({ model: "", text_encoder: "", vae: "" }));
    mockRoute("/neo_image_gen/models", () => jsonResponse(SCOPE_MODELS));
    const { createImageGenSettingsForm } = await import("../../web/image-gen.js");
    const form = createImageGenSettingsForm();
    document.body.appendChild(form.el);
    await form.load();
    const selects = [...form.el.querySelectorAll("select")];
    assert.deepEqual(optionValues(selects[0]), ["", ...SCOPE_MODELS.image_diffusion_models]);
    assert.deepEqual(optionValues(selects[1]), ["", ...SCOPE_MODELS.image_text_encoders]);
    assert.deepEqual(optionValues(selects[2]), ["", ...SCOPE_MODELS.image_vae]);
    form.el.querySelector(".rs-model-scope-toggle").click();
    assert.deepEqual(optionValues(form.el.querySelectorAll("select")[0]), ["", ...SCOPE_DIFFUSION]);
});

test("全局生视频默认设置：四行走 video_* 作用域表，开关回到类别全表", async () => {
    mockRoute("/neo_video_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_video_gen/models", () => jsonResponse(VIDEO_FULL));
    const { createVideoGenSettingsForm } = await import("../../web/image-gen.js");
    const form = createVideoGenSettingsForm();
    document.body.appendChild(form.el);
    await form.load();
    const selects = [...form.el.querySelectorAll("select")];
    assert.deepEqual(optionValues(selects[0]), ["", ...VIDEO_FULL.video_diffusion_models]);
    assert.deepEqual(optionValues(selects[1]), ["", ...VIDEO_FULL.video_text_encoders]);
    assert.deepEqual(optionValues(selects[2]), ["", ...VIDEO_FULL.video_vae]);
    assert.deepEqual(optionValues(selects[3]), ["", ...VIDEO_FULL.video_audio_vae]);
    form.el.querySelector(".rs-model-scope-toggle").click();
    assert.deepEqual(optionValues(form.el.querySelectorAll("select")[0]), ["", ...VIDEO_FULL.diffusion_models]);
});

});

test("技能没有家族（自建技能）：主模型行退回生图作用域表，视频 / 音乐家族不进下拉", async () => {
    const section = await scopeSection("");
    assert.deepEqual(optionValues(section.modelSelect), ["", ...SCOPE_MODELS.image_diffusion_models]);
});

test("「显示全部模型」开关：主模型行回到类别全表，再点一次回到家族表", async () => {
    const section = await scopeSection("qwen_image_21");
    const btn = section.el.querySelector(".rs-model-scope-toggle");
    btn.click();
    assert.deepEqual(optionValues(section.modelSelect), ["", ...SCOPE_DIFFUSION], "打开后列出该目录全部模型");
    assert.equal(btn.textContent, "只看本家族");
    btn.click();
    assert.deepEqual(optionValues(section.modelSelect),
        ["", "QwenImage2.1/qwen_image_2.1_int8_convrot.safetensors"], "再点一次回到家族表");
    assert.equal(btn.textContent, "显示全部模型");
});

test("钉住的跨家族值仍可选：家族过滤把它挡在表外时不标缺失（文件在盘上）", async () => {
    const pinned = "MiniMaxH3/Speed/h3.safetensors";
    const section = await scopeSection("qwen_image_21", { model: pinned });
    assert.ok(optionValues(section.modelSelect).includes(pinned), "钉住的值要出现在下拉里");
    assert.equal(section.collect().model, pinned, "collect 保持原值");
    assert.equal(section.el.querySelector(".rs-model-select-box.rs-model-missing"), null, "盘上有的值不是缺失");
});

test("config 钉的值在盘上真没了：不并入候选，照旧如实标缺失", async () => {
    const section = await scopeSection("qwen_image_21", { model: "Gone/qwen_gone.safetensors" });
    const opt = [...section.modelSelect.options].find((o) => o.value === "Gone/qwen_gone.safetensors");
    assert.ok(opt.textContent.includes("(缺失)"), "失效路径要写明缺失");
});

test("Text Encoder / VAE 行走 image_* 作用域表：视频与音频家族的 TE / VAE 不进生图下拉", async () => {
    const section = await scopeSection("krea2_image");
    const selects = [...section.el.querySelectorAll("select")];
    assert.deepEqual(optionValues(selects[1]), ["", "krea2/Qwen-Image-2.0_text_encoder.safetensors"]);
    assert.deepEqual(optionValues(selects[2]), ["", "krea2/flux1-krea2-related-vae.safetensors"]);
});

test("LoRA 行不作用域：跨家族 LoRA 照旧全表列出", async () => {
    const section = await scopeSection("qwen_image_21");
    section.el.querySelector(".rs-gen-lora-add").click();
    assert.deepEqual(optionValues(section.el.querySelector(".rs-gen-lora-row select")), ["", ...SCOPE_LORAS]);
});

