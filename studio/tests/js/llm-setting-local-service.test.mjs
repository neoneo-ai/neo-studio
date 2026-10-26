// 本地服务模型列表回归：LM Studio / Ollama 的原生端点给出「是否已加载」，
// 未加载的模型也要进下拉且可选（服务端收到请求时按需加载，同 Cline），
// 只有服务不可达才显示失败态。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, flush } from "./setup.mjs";

let llmForm = null;

const config = () => ({
    enabled: true,
    active_provider: "lmstudio",
    auto_unload_local: false,
    provider_list: [
        { id: "local", name: "Local GGUF (llama.cpp)", type: "local" },
        { id: "lmstudio", name: "LM Studio", type: "remote", default_base_url: "http://localhost:1234/v1", append_v1: true, show_api_key: false, model_mode: "dropdown" },
    ],
    providers: {
        local: { models_dir: "" },
        lmstudio: { api_key: "", base_url: "http://localhost:1234/v1", model: "" },
    },
});

beforeEach(async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_prompts/remote_llm_config", (body, call) =>
        call.method === "POST" ? jsonResponse({ success: true }) : jsonResponse(config()));
    mockRoute("/rs_prompts/get_models", () => jsonResponse({ current_model: "", models: [] }));
    const { createModelConfigForm } = await import("../../web/llm-setting.js");
    llmForm = createModelConfigForm();
    document.body.appendChild(llmForm.el);
});

const modelSelect = () => llmForm.el.querySelector("#rs-remote-model-select");
const optionTexts = () => Array.from(modelSelect().options).map((o) => o.textContent);

test("本地服务模型列表：未加载的模型也可选，并标注状态与大小", async () => {
    mockRoute("/rs_prompts/fetch_remote_models", () => jsonResponse({
        success: true,
        source: "lmstudio",
        models: [
            { id: "google/gemma-4-26b-a4b", name: "Gemma 4 26B A4B", size: 17990911801, loaded: false, vision: true },
            { id: "deepseek-r1", name: "DeepSeek R1", size: 40492610355, loaded: true },
        ],
    }));

    await llmForm.load();
    await flush(60);

    const texts = optionTexts();
    assert.equal(texts.length, 2, "应列出服务端全部可用模型");
    assert.match(texts[0], /○ 未加载/, "未加载模型应标注状态");
    assert.match(texts[0], /16\.8GB/, "应显示文件大小");
    assert.match(texts[0], /视觉/, "视觉能力应标注");
    assert.match(texts[1], /● 已加载/);
    assert.equal(modelSelect().value, "google/gemma-4-26b-a4b", "未加载也照常参与回填选择");
});

test("通用 OpenAI 兼容端点：不谎报加载状态", async () => {
    mockRoute("/rs_prompts/fetch_remote_models", () => jsonResponse({
        success: true, source: "openai", models: [{ id: "gpt-oss-20b", name: "gpt-oss-20b" }],
    }));

    await llmForm.load();
    await flush(60);

    assert.deepEqual(optionTexts(), ["gpt-oss-20b"], "无 loaded 字段时不加状态标注");
});

test("服务不可达：显示连接失败态", async () => {
    mockRoute("/rs_prompts/fetch_remote_models", () => jsonResponse({ success: false, error: "Timeout" }, 504));

    await llmForm.load();
    await flush(60);

    assert.deepEqual(optionTexts(), ["无法连接服务"]);
    assert.equal(modelSelect().value, "");
});
