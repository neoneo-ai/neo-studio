// 设置面板初始化回归：异步回填（含模型列表晚到、下拉默认落首项）不得触发任何
// 配置写请求/本地模型切换，也不得把表单判为未保存修改；load 全部落定后才放行脏检查。
// LLM 侧已改为显式 保存：用户改动只标脏不落盘，点按钮才保存并切换本地常驻模型
// （单模型下拉永不触发 change 的场景靠显式保存 + 后端单模型回落覆盖）。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import {
    resetEnv,
    mockRoute,
    clearRoutes,
    jsonResponse,
    fetchLog,
    flush,
    sleep,
} from "./setup.mjs";

let llmForm = null;

const localConfig = () => ({
    enabled: false,
    active_provider: "local",
    auto_unload_local: false,
    provider_list: [
        { id: "local", name: "Local GGUF (llama.cpp)", type: "local" },
        { id: "openai", name: "OpenAI Compatible", type: "remote", default_base_url: "", append_v1: true, show_api_key: true, model_mode: "hybrid" },
        { id: "lmstudio", name: "LM Studio", type: "remote", default_base_url: "http://localhost:1234/v1", append_v1: true, show_api_key: false, model_mode: "dropdown" },
        { id: "ollama", name: "Ollama", type: "remote", default_base_url: "http://localhost:11430/v1", append_v1: true, show_api_key: false, model_mode: "dropdown" },
        { id: "openrouter", name: "OpenRouter", type: "remote", default_base_url: "https://openrouter.ai/api/v1", append_v1: true, show_api_key: true, model_mode: "dropdown" },
    ],
    providers: {
        local: { models_dir: "D:/gguf" },
        openai: { api_key: "", base_url: "", model: "gpt-4o-mini" },
        lmstudio: { api_key: "", base_url: "http://localhost:1234/v1", model: "" },
        ollama: { api_key: "", base_url: "http://localhost:11430/v1", model: "" },
        openrouter: { api_key: "", base_url: "https://openrouter.ai/api/v1", model: "" },
    },
});

// 已保存模型 current_model 故意不在新列表里 → 列表加载后原生 select 会落在首项
const MODELS = {
    current_model: "old-model.gguf",
    models: [
        { key: "a.gguf", name: "a.gguf", file_size: 1024 },
        { key: "b.gguf", name: "b.gguf", file_size: 2048 },
    ],
};

const saveLlmCalls = () =>
    fetchLog.filter((c) => c.method === "POST" && c.path === "/rs_prompts/remote_llm_config");
const setModelCalls = () =>
    fetchLog.filter((c) => c.method === "POST" && c.path === "/rs_prompts/set_model");
const localSelect = () => document.querySelector("#rs-local-model-select");

beforeEach(async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_prompts/remote_llm_config", (body, call) =>
        call.method === "POST" ? jsonResponse({ success: true }) : jsonResponse(localConfig()));
    mockRoute("/rs_prompts/get_models", () => jsonResponse(MODELS));
    mockRoute("/rs_prompts/set_model", () => jsonResponse({ success: true, current_model: "a.gguf" }));
    const { createModelConfigForm } = await import("../../web/llm-setting.js");
    llmForm = createModelConfigForm();
    document.body.appendChild(llmForm.el);
});

test("LLM 初始化：模型列表晚到时（load 未完成）的 change 不落盘、不切模型；load 等列表填完才结束", async () => {
    // 模型列表延迟返回，模拟慢磁盘扫描
    let releaseModels = null;
    mockRoute("/rs_prompts/get_models", () => new Promise((resolve) => {
        releaseModels = () => resolve(jsonResponse(MODELS));
    }));

    const loading = llmForm.load(); // 不 await：模拟菜单打开即后台回填
    let settled = false;
    loading.then(() => { settled = true; });
    await flush(60); // 推进到“等待 get_models”挂起点

    assert.equal(settled, false, "load 应等模型列表填充完成，而非配置读完就结束");

    // 列表未回、下拉仍停在加载项时派发 change（模拟程序化/环境副作用）
    localSelect().dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    assert.equal(llmForm.isDirty(), false, "加载窗口内不算 dirty");
    assert.equal(setModelCalls().length, 0, "加载窗口内不得切换到本地模型");

    releaseModels();
    await loading;
    await sleep(400); // 留足窗口确认没有残留的延迟写请求
    await flush();

    const keys = [...localSelect().options].map((o) => o.value).filter((v) => v && v !== "__loading__");
    assert.deepEqual(keys, ["a.gguf", "b.gguf"], "load resolve 时模型列表已填充（含首项回落）");
    assert.equal(llmForm.isDirty(), false, "初始化完成后仍不算 dirty");
    assert.equal(setModelCalls().length, 0, "整个初始化期间不切换本地模型");
    assert.equal(saveLlmCalls().length, 0, "整个初始化期间不触发自动保存写请求");
});

test("LLM 用户改动只标脏不落盘，点 才保存并切换本地模型", async () => {
    await llmForm.load();
    await flush();
    assert.equal(llmForm.isDirty(), false, "无改动不算 dirty");

    localSelect().value = "b.gguf";
    localSelect().dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(400); // 确认没有残留的延迟自动保存
    await flush();

    assert.equal(llmForm.isDirty(), true, "改动未点保存即 dirty");
    assert.equal(saveLlmCalls().length, 0, "不点 不触发写请求");
    assert.equal(setModelCalls().length, 0, "不点 不切换本地模型");

    llmForm.el.querySelector(".rs-gen-save").click();
    await sleep(400);
    await flush();

    assert.equal(setModelCalls().length, 1, "点保存应切换本地常驻模型");
    assert.equal(setModelCalls()[0].body.model_key, "b.gguf");
    const saves = saveLlmCalls();
    assert.equal(saves.length, 1, "点保存应落盘一次");
    assert.equal(saves[0].body.provider, "local");
    assert.equal(saves[0].body.model, "b.gguf");
    assert.equal(llmForm.isDirty(), false, "保存成功后不再 dirty");
});

test("单模型目录：change 永不触发，点 显式保存即落盘并设为当前模型", async () => {
    mockRoute("/rs_prompts/get_models", () => jsonResponse({
        current_model: "",
        models: [{ key: "only.gguf", name: "only.gguf", file_size: 1024 }],
    }));
    await llmForm.load();
    await flush();

    // 只有一个选项：原生 select 默认选中首项，用户根本无法触发 change
    assert.equal(localSelect().value, "only.gguf");
    assert.equal(saveLlmCalls().length, 0, "初始化不落盘");
    assert.equal(setModelCalls().length, 0, "初始化不切换模型");

    llmForm.el.querySelector(".rs-gen-save").click();
    await sleep(400);
    await flush();

    const saves = saveLlmCalls();
    assert.equal(saves.length, 1, "显式保存应落盘一次");
    assert.equal(saves[0].body.provider, "local");
    assert.equal(saves[0].body.model, "only.gguf", "唯一模型应被持久化为当前模型");
    assert.equal(saves[0].body.base_url, undefined, "本地模式保存不应写入 base_url 等隐藏字段残留值");
    assert.equal(saves[0].body.api_key, undefined, "本地模式保存不应写入 api_key");
    assert.equal(setModelCalls().length, 1, "显式保存应把唯一模型设为当前模型");
    assert.equal(setModelCalls()[0].body.model_key, "only.gguf");
    assert.equal(llmForm.isDirty(), false, "保存成功后不再 dirty");
});

test("出图设置：load 落定前 dirty 恒 false，load 后仅改动触发 dirty", async () => {
    let releaseSettings = null;
    mockRoute("/neo_image_gen/settings", (body, call) => {
        if (call.method === "POST") return jsonResponse({ success: true });
        return new Promise((resolve) => {
            releaseSettings = () => resolve(jsonResponse({
                model: "saved-m", text_encoder: "", vae: "", loras: [],
                count: 1, base_resolution: 1280, default_ratio: "1:1",
            }));
        });
    });
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: ["m1", "m2"], text_encoders: [], vae: [], loras: [],
    }));

    const { createImageGenSettingsForm } = await import("../../web/image-gen.js");
    const genForm = createImageGenSettingsForm();
    document.body.appendChild(genForm.el);

    const p = genForm.load();
    await flush(60);
    assert.equal(genForm.isDirty(), false, "加载窗口内不算 dirty");
    releaseSettings();
    await p;
    await flush();
    assert.equal(genForm.isDirty(), false, "load 完成、无改动不算 dirty");

    // 已保存值不在模型列表 → load 回落为「自动」；显式改选后应 dirty
    const modelSelect = genForm.el.querySelector("select"); // 表单第一个 select = 出图模型
    modelSelect.value = "m1";
    assert.equal(genForm.isDirty(), true, "改动模型值应 dirty");

    await genForm.save();
    assert.equal(genForm.isDirty(), false, "保存成功后不 dirty");
    const saved = fetchLog.filter((c) => c.method === "POST" && c.path === "/neo_image_gen/settings");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].body.model, "m1");
});
