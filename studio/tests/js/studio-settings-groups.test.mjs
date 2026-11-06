// 设置页分段：左栏十项 tab 按 启动与连接 / 生成 / 智能体 / 语言与关于 排下来，段与段之间一条无文字的分割线；
// 栏内长表单的小标题分区保留
// · 启动设置：ComfyUI 位置 · 网络与端口 · 桌面窗口
// · LLM 设置：服务商与模型 · 远程连接 · 本地模型
// · 生图设置：模型 · 输出
// tab 的 data-key、深链 #/settings?tab=.. 与保存逻辑全不变。用例钉的是分段独有的两条失效现场：
// 摘掉整组 tab（浏览器标签页的启动设置）之后条首不悬一条多余的线；LLM 切到本地 GGUF 收起整组后，小标题不空挂在没内容的组上。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, mockRoute, clearRoutes, jsonResponse, click } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

const LAUNCHER_STATE = {
    root: "D:/ComfyUI", python: "D:/py/python.exe", port: 8188, listen: "", remote: "",
    state: "ok", error: "", frameless: true, dev_mode: false, lan_ips: [],
};
const LLM_PROVIDERS = [
    { id: "local", name: "Local GGUF (llama.cpp)", type: "local" },
    { id: "deepseek", name: "DeepSeek 深度求索", type: "remote", default_base_url: "https://api.deepseek.com/v1", append_v1: true, show_api_key: true, requires_api_key: true, model_mode: "hybrid" },
    { id: "lmstudio", name: "LM Studio", type: "remote", default_base_url: "http://localhost:1234/v1", append_v1: true, show_api_key: false, model_mode: "dropdown" },
];
const llmConfig = (active) => ({
    enabled: true, active_provider: active, auto_unload_local: false,
    provider_list: LLM_PROVIDERS,
    providers: {
        local: { models_dir: "" },
        deepseek: { api_key: "", base_url: "", model: "" },
        lmstudio: { api_key: "", base_url: "http://localhost:1234/v1", model: "" },
    },
});

function mockSettingsRoutes() {
    mockRoute("/neo_studio/version", jsonResponse({ success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [] }));
    mockRoute("/neo_image_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    mockRoute("/neo_video_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_video_gen/models", () => jsonResponse({}));
    mockRoute("/rs_prompts/remote_llm_config", (body, call) =>
        call.method === "POST" ? jsonResponse({ success: true }) : jsonResponse(llmConfig("lmstudio")));
    mockRoute("/rs_prompts/fetch_remote_models", () => jsonResponse({ success: true, models: [] }));
    mockRoute("/rs_prompts/get_models", () => jsonResponse({ current_model: "", models: [] }));
}

// 开在设置页。desktop=true 时装上桌面端的桥：启动设置面板靠桥的 launcher_state 才留在左栏
async function openSettings(tag, desktop) {
    resetEnv();
    clearRoutes();
    mockSettingsRoutes();
    document.body.innerHTML = studioBody;
    if (desktop) {
        window.pywebview = {
            api: {
                comfy_state: async () => ({ port: 8188, pid: 4321, mine: true, running: true, ready: true, starting: false }),
                launcher_state: async () => ({ ...LAUNCHER_STATE }),
            },
        };
    }
    window.location.hash = "#/settings";
    await import(`../../web/studio/studio-app.js?groups=${tag}`);
    await flush();
}

// 左栏一行行的落位：段间线记成 | ，tab 记成自己的文本
const strip = () => [...document.querySelector(".ns-settings-tabs").children]
    .map((n) => (n.classList.contains("ns-settings-sep") ? "|" : n.textContent.trim()));
const tabKeys = () => [...document.querySelectorAll(".ns-settings-tab")].map((b) => b.dataset.key);

const START_TABS = ["启动设置", "启动日志", "手机连接"];
const GEN_TABS = ["LLM 设置", "生图设置", "生视频设置"];
const AGENT_TABS = ["智能体偏好", "MCP 服务"];
const UI_TABS = ["界面语言", "关于"];

test("设置页左栏：启动与连接排在最上，段之间只有分割线，tab 顺序与 data-key 全不变", async () => {
    await openSettings("desktop", true);
    assert.deepEqual(strip(), [...START_TABS, "|", ...GEN_TABS, "|", ...AGENT_TABS, "|", ...UI_TABS],
        "四段之间三条线、线里不写字：界面上的行数就等于设定项的数目");
    assert.deepEqual(tabKeys(), ["launch", "log", "pair", "llm", "gen", "video", "agent", "mcp", "lang", "about"],
        "分段只加左栏层级：深链 #/settings?tab=.. 靠这些 key 定位，一项都不该动");
});

test("浏览器标签页摘掉启动设置：首段剩启动日志与手机连接，条首不悬一条多余的线", async () => {
    await openSettings("browser", false);
    assert.equal(document.querySelector('.ns-settings-tab[data-key="launch"]'), null, "浏览器标签页里没有启动设置");
    assert.deepEqual(strip(), ["启动日志", "手机连接", "|", ...GEN_TABS, "|", ...AGENT_TABS, "|", ...UI_TABS],
        "摘掉一项 tab 之后线跟着剩下的内容落位：首段不空、条首不落线");
});

// 面板里一行行的落位：组标题前缀 >> ，行取自己的标签
const panelLines = (panel) => [...panel.children].map((n) => {
    if (n.classList.contains("ns-launch-group")) return ">> " + n.textContent.trim();
    const label = n.querySelector(".ns-launch-label");
    return label ? label.firstChild.textContent.trim() : null;
}).filter(Boolean);

test("启动设置栏内分区：位置、网络与端口、桌面窗口、姿势资产四类，启停与状态行仍留在顶部", async () => {
    await openSettings("launch", true);
    click(document.querySelector('.ns-settings-tab[data-key="launch"]'));
    await flush();
    const panel = document.querySelector(".ns-kernel").closest(".ns-settings-section");
    assert.deepEqual(panelLines(panel), [
        ">> ComfyUI 位置", "ComfyUI 根目录", "Python",
        ">> 网络与端口", "端口", "局域网监听", "远程 ComfyUI",
        ">> 桌面窗口", "无边框窗口", "开发模式",
        ">> 姿势资产", "姿势仓库",
    ], "启停与状态行留在面板顶部，栏内十一行按位置 / 网络与端口 / 桌面窗口 / 姿势资产四类落位");
});

test("生图设置分区：三条模型行在模型组下，目标像素数与输出前缀在输出组下", async () => {
    const { createImageGenSettingsForm } = await import("../../web/image-gen.js?genGroups=1");
    const form = createImageGenSettingsForm();
    document.body.appendChild(form.el);
    await form.load();
    const lines = [...form.el.children].map((n) => {
        if (n.classList.contains("rs-form-group-title")) return ">> " + n.textContent.trim();
        const label = n.querySelector(".rs-form-label");
        return label ? label.textContent.trim() : null;
    }).filter(Boolean);
    assert.deepEqual(lines, [">> 模型", "生图模型", "Text Encoder", "VAE", ">> 输出", "目标像素数 (MP)", "输出前缀"]);
    assert.ok(lines.indexOf(">> 输出") < lines.indexOf("目标像素数 (MP)"), "MP 输入应落在输出组里");
});

let llmForm = null;

async function openLlmForm(active) {
    resetEnv();
    clearRoutes();
    mockRoute("/rs_prompts/remote_llm_config", (body, call) =>
        call.method === "POST" ? jsonResponse({ success: true }) : jsonResponse(llmConfig(active)));
    mockRoute("/rs_prompts/fetch_remote_models", () => jsonResponse({ success: true, models: ["m1"] }));
    mockRoute("/rs_prompts/get_models", () => jsonResponse({ current_model: "", models: [] }));
    const { createModelConfigForm } = await import("../../web/llm-setting.js?llmGroups=1");
    llmForm = createModelConfigForm();
    document.body.appendChild(llmForm.el);
    await llmForm.load();
    await flush();
}

const llmGroups = () => [...llmForm.el.querySelectorAll(".rs-form-group")]
    .map((g) => g.querySelector(".rs-form-group-title").textContent + "=" + (g.style.display || "show"));

const pickProvider = async (id) => {
    const sel = llmForm.el.querySelector("#rs-remote-provider");
    sel.value = id;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
};

test("LLM 设置分组：服务商与模型在最上，切到本地 GGUF 时远程连接整组连标题一起收起", async () => {
    await openLlmForm("deepseek");
    assert.deepEqual(llmGroups(), ["服务商与模型=show", "远程连接=flex", "本地模型=none"],
        "云端服务商：API Key 与自定义端点在远程连接组里，本地模型整组收起");

    await pickProvider("local");
    assert.deepEqual(llmGroups(), ["服务商与模型=show", "远程连接=none", "本地模型=flex"],
        "本地 GGUF：远程连接组里两样都收起了，标题不该空挂在没内容的组上");

    await pickProvider("lmstudio");
    assert.deepEqual(llmGroups(), ["服务商与模型=show", "远程连接=flex", "本地模型=none"],
        "回到云端预设服务：组标题随行一起回来");
});