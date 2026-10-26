// 折叠区回归：有预设 Base URL 的供应商（云端厂商 / 本地预设服务）默认收起「自定义端点」，
// 点标题可展开改写，收起状态下回填与保存照常；无预设的 OpenAI Compatible 端点必须手填，
// 保持常显且不提供收起入口（否则用户会看不到必填项）。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, flush, sleep } from "./setup.mjs";

let llmForm = null;

// 已存密钥的脱敏形态：固定星号串（llm.API_KEY_MASK，40 位）
const MASKED_KEY = "*".repeat(40);

const config = () => ({
    enabled: true,
    active_provider: "lmstudio",
    auto_unload_local: false,
    provider_list: [
        { id: "local", name: "Local GGUF (llama.cpp)", type: "local" },
        { id: "openai", name: "OpenAI Compatible", type: "remote", default_base_url: "", append_v1: true, show_api_key: true, model_mode: "hybrid" },
        { id: "deepseek", name: "DeepSeek 深度求索", type: "remote", default_base_url: "https://api.deepseek.com/v1", append_v1: true, show_api_key: true, requires_api_key: true, model_mode: "hybrid" },
        { id: "moonshot", name: "月之暗面 Kimi", type: "remote", default_base_url: "https://api.moonshot.cn/v1", append_v1: true, show_api_key: true, requires_api_key: true, model_mode: "hybrid" },
        { id: "lmstudio", name: "LM Studio", type: "remote", default_base_url: "http://localhost:1234/v1", append_v1: true, show_api_key: false, model_mode: "dropdown" },
    ],
    providers: {
        local: { models_dir: "" },
        openai: { api_key: "", base_url: "", model: "" },
        deepseek: { api_key: "", base_url: "", model: "" },
        // 已改过端点（如百炼业务空间专属域名）+ 已存密钥：端点应自动展开、密钥显示为掩码串
        moonshot: { api_key: MASKED_KEY, base_url: "https://my-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", model: "" },
        lmstudio: { api_key: "", base_url: "http://localhost:1234/v1", model: "" },
    },
});

beforeEach(async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_prompts/remote_llm_config", (body, call) =>
        call.method === "POST" ? jsonResponse({ success: true }) : jsonResponse(config()));
    mockRoute("/rs_prompts/fetch_remote_models", () => jsonResponse({ success: true, models: ["a-model"] }));
    mockRoute("/rs_prompts/get_models", () => jsonResponse({ current_model: "", models: [] }));
    const { createModelConfigForm } = await import("../../web/llm-setting.js");
    llmForm = createModelConfigForm();
    document.body.appendChild(llmForm.el);
});

const advanced = () => llmForm.el.querySelector(".rs-remote-advanced");
const summary = () => llmForm.el.querySelector(".rs-remote-advanced-summary");
const baseUrlInput = () => llmForm.el.querySelector("#rs-remote-base-url");
const apiKeyInput = () => llmForm.el.querySelector("#rs-remote-api-key");
const providerSelect = () => llmForm.el.querySelector("#rs-remote-provider");
const saveLlmCalls = () =>
    fetchLog.filter((c) => c.method === "POST" && c.path === "/rs_prompts/remote_llm_config");

const switchProvider = async (id) => {
    providerSelect().value = id;
    providerSelect().dispatchEvent(new Event("change", { bubbles: true }));
    await flush(60);
};

test("有预设 Base URL 的供应商：端点默认收起，展开后可改写并保存", async () => {
    await llmForm.load();
    await flush();

    assert.equal(advanced().style.display, "flex", "折叠区应显示");
    assert.equal(advanced().open, false, "有预设端点时默认收起");
    assert.equal(summary().style.display, "", "收起入口应可见");
    assert.ok(advanced().contains(baseUrlInput()), "Base URL 应在折叠区内");
    assert.equal(baseUrlInput().value, "http://localhost:1234/v1", "收起时仍回填预设端点");

    advanced().open = true; // 展开改写
    baseUrlInput().value = "http://192.168.0.9:1234/v1";
    llmForm.el.querySelector(".rs-gen-save").click();
    await sleep(400);
    await flush();

    const saves = saveLlmCalls();
    assert.equal(saves.length, 1, "点保存应落盘一次");
    assert.equal(saves[0].body.base_url, "http://192.168.0.9:1234/v1", "折叠区内的改写应被保存");
});

test("国产云供应商（hybrid）：同样默认收起，展开后可见预设端点", async () => {
    await llmForm.load();
    await flush();
    await switchProvider("deepseek");

    assert.equal(advanced().style.display, "flex");
    assert.equal(advanced().open, false, "hybrid 预设端点同样默认收起");
    assert.equal(baseUrlInput().value, "https://api.deepseek.com/v1");
});

test("无预设 Base URL 的 OpenAI Compatible：端点常显且无收起入口", async () => {
    await llmForm.load();
    await flush();
    await switchProvider("openai");

    assert.equal(advanced().style.display, "flex");
    assert.equal(advanced().open, true, "无预设端点时必须常显，不能收起");
    assert.equal(summary().style.display, "none", "不提供收起入口");
});

test("Local GGUF：折叠区整体隐藏（端点与本地模式无关）", async () => {
    await llmForm.load();
    await flush();
    await switchProvider("local");

    assert.equal(advanced().style.display, "none");
});

test("已存端点与预设不一致：自动展开（自定义端点不被藏起来），仍可手动收起", async () => {
    await llmForm.load();
    await flush();
    await switchProvider("moonshot");

    assert.equal(advanced().style.display, "flex");
    assert.equal(advanced().open, true, "与预设不一致的端点应自动展开");
    assert.equal(baseUrlInput().value, "https://my-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    assert.equal(summary().style.display, "", "仍保留收起入口");
});

test("API Key 提示：云厂商标必填，OpenAI Compatible 标可选，已存密钥改提示已保存", async () => {
    await llmForm.load();
    await flush();

    await switchProvider("deepseek");
    assert.match(apiKeyInput().placeholder, /必填/, "云厂商未存密钥时应提示必填");

    await switchProvider("openai");
    assert.match(apiKeyInput().placeholder, /可选/, "自建/本地兼容端点可留空");

    await switchProvider("moonshot");
    assert.equal(apiKeyInput().value, MASKED_KEY, "已存密钥应显示为固定星号掩码而非空框");
    assert.equal(apiKeyInput().placeholder, "已保存（留空沿用）", "清空后提示沿用而非重填");
});

test("云厂商未填 API Key 就保存：给出必填提示；服务端已存密钥则不提示", async () => {
    await llmForm.load();
    await flush();
    const status = () => llmForm.el.querySelector(".rs-provider-save-status");

    await switchProvider("deepseek");
    llmForm.el.querySelector(".rs-gen-save").click();
    await sleep(400);
    await flush();
    assert.match(status().textContent, /必填/, "未填且未存过密钥应提示");
    assert.equal(status().style.display, "block");

    await switchProvider("moonshot");
    status().textContent = "";
    llmForm.el.querySelector(".rs-gen-save").click();
    await sleep(400);
    await flush();
    assert.doesNotMatch(status().textContent, /必填/, "已存密钥（掩码未改动）不应误报");
    const moonshotSaves = saveLlmCalls();
    assert.equal(moonshotSaves[moonshotSaves.length - 1].body.api_key, "", "掩码串不得当新密钥落盘");
});

test("模型列表拉取请求带 provider；已存密钥且掩码未改动时不发送 api_key", async () => {
    await llmForm.load();
    await flush();
    await switchProvider("moonshot"); // 已存密钥，输入框显示掩码串
    const calls = fetchLog.filter((c) => c.method === "POST" && c.path === "/rs_prompts/fetch_remote_models");
    assert.ok(calls.length > 0, "切换云厂商应触发模型列表拉取");
    const last = calls[calls.length - 1];
    assert.equal(last.body.provider, "moonshot", "应带 provider 供服务端回退已存密钥");
    assert.ok(!last.body.api_key, "掩码串按未改动处理，不发送 api_key，由服务端用已存密钥");
});

test("填入 API Key 后自动重拉模型列表并携带新密钥", async () => {
    await llmForm.load();
    await flush();
    await switchProvider("deepseek"); // 未存过密钥
    const before = fetchLog.filter((c) => c.path === "/rs_prompts/fetch_remote_models").length;
    apiKeyInput().value = "sk-new";
    apiKeyInput().dispatchEvent(new Event("change", { bubbles: true }));
    await flush(60);
    const calls = fetchLog.filter((c) => c.path === "/rs_prompts/fetch_remote_models");
    assert.equal(calls.length, before + 1, "填入密钥后应多触发一次拉取");
    assert.equal(calls[calls.length - 1].body.api_key, "sk-new", "新填密钥应随请求发送");
});

test("连接测试：远程 provider 点「测试连接」发当前表单值并回显回复", async () => {
    await llmForm.load();
    await flush();
    mockRoute("/rs_prompts/llm_connection_test", () => jsonResponse({ success: true, reply: "你好！" }));
    const status = () => llmForm.el.querySelector(".rs-provider-save-status");

    await switchProvider("deepseek"); // 远程 provider
    apiKeyInput().value = "sk-test";   // 显式填密钥，避开掩码分支
    llmForm.el.querySelector(".rs-gen-test").click();
    await sleep(200);
    await flush();

    const calls = fetchLog.filter((c) => c.method === "POST" && c.path === "/rs_prompts/llm_connection_test");
    assert.equal(calls.length, 1, "点测试应发一次连接测试请求");
    assert.equal(calls[0].body.provider, "deepseek", "应携带当前 provider");
    assert.equal(calls[0].body.api_key, "sk-test", "显式填写的密钥应随请求发送");
    assert.match(status().textContent, /连接正常/, "成功时应显示连接正常");
    assert.match(status().textContent, /你好/, "应回显模型回复摘要");
});

test("连接测试：本地 provider 点按钮不发请求并提示不适用", async () => {
    await llmForm.load();
    await flush();
    const status = () => llmForm.el.querySelector(".rs-provider-save-status");

    await switchProvider("local");
    llmForm.el.querySelector(".rs-gen-test").click();
    await sleep(100);
    await flush();

    const calls = fetchLog.filter((c) => c.path === "/rs_prompts/llm_connection_test");
    assert.equal(calls.length, 0, "本地模型不应发连接测试请求");
    assert.match(status().textContent, /无需连接测试/, "应提示本地模型无需连接测试");
});
