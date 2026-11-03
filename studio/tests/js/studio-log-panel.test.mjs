// 设置页「启动日志」面板：桌面端把内核输出（data/comfy_run.log）与桌面端自身轨迹
// （data/studio_desktop.log）拼成两块，条目带 src；来源筛选按 src 显隐整块。
// 浏览器标签页里插件那条路由只回内核那块、不带 src：单块不分块，「桌面端」筛选钮收起。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, mockRoute, clearRoutes, jsonResponse, click } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

const LLM_PROVIDERS = [
    { id: "lmstudio", name: "LM Studio", type: "remote", default_base_url: "http://localhost:1234/v1", append_v1: true, show_api_key: false, model_mode: "dropdown" },
];
// 桌面端那份响应：两块都在，内核条目带 ANSI 色码（网页里是乱码，渲染时要剥掉）
const DESKTOP_LOG = {
    success: true,
    entries: [
        { m: "\u001b[32m[INFO]\u001b[0m Starting server\n", src: "comfy" },
        { m: "[INFO] Import times for custom nodes: 12.3 seconds\n", src: "comfy" },
        { m: "[12:00:01] start port=8188 state=D:/ComfyUI/data\n", src: "studio" },
        { m: "[12:00:03] desktop service port=8083\n", src: "studio" },
    ],
};
// 浏览器标签页那份：插件路由的条目没有 src
const KERNEL_LOG = {
    success: true,
    entries: [
        { m: "[INFO] Starting server\n" },
        { m: "[INFO] To see the GUI go to: http://127.0.0.1:8188\n" },
    ],
};

async function openLogTab(tag, log) {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_studio/version", jsonResponse({ success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [] }));
    mockRoute("/neo_studio/log", () => jsonResponse(log));
    mockRoute("/neo_image_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_image_gen/models", () => jsonResponse({ diffusion_models: [], text_encoders: [], vae: [] }));
    mockRoute("/neo_video_gen/settings", () => jsonResponse({}));
    mockRoute("/neo_video_gen/models", () => jsonResponse({}));
    mockRoute("/rs_prompts/remote_llm_config", (body, call) => call.method === "POST"
        ? jsonResponse({ success: true })
        : jsonResponse({ enabled: true, active_provider: "lmstudio", auto_unload_local: false,
                         provider_list: LLM_PROVIDERS, providers: { lmstudio: { api_key: "", base_url: "http://localhost:1234/v1", model: "" } } }));
    mockRoute("/rs_prompts/fetch_remote_models", () => jsonResponse({ success: true, models: [] }));
    mockRoute("/rs_prompts/get_models", () => jsonResponse({ current_model: "", models: [] }));
    document.body.innerHTML = studioBody;
    window.location.hash = "#/settings";
    await import(`../../web/studio/studio-app.js?logPanel=${tag}`);
    await flush(40);
    click(document.querySelector('.ns-settings-tab[data-key="log"]'));
    await flush(40);
}

const logText = () => document.querySelector(".ns-log").textContent;
const srcBtn = (label) => [...document.querySelectorAll(".ns-log-src-btn")].find((b) => b.textContent === label);

test("桌面端启动日志：内核那块在前、桌面端那块在后，ANSI 色码剥掉", async () => {
    await openLogTab("merge", DESKTOP_LOG);
    const text = logText();
    assert.ok(text.includes("—— ComfyUI 内核 ——"), "内核那块要有标题");
    assert.ok(text.includes("—— Neo Studio 桌面端 ——"), "桌面端自身轨迹要拼进同一块面板");
    assert.ok(text.indexOf("Starting server") < text.indexOf("desktop service port="),
        "两块按内核 → 桌面端落位，贴底自动滚时看到的是最新那块");
    assert.ok(!text.includes("\u001b["), "日志不应带 ANSI 色码");
    assert.equal(document.querySelectorAll(".ns-log-src").length, 2, "两块两块标题各一条");
});

test("来源筛选：只看桌面端时内核整块收起，切回全部恢复两块", async () => {
    await openLogTab("filter", DESKTOP_LOG);
    assert.ok(srcBtn("全部").classList.contains("is-on"), "默认全部");

    click(srcBtn("桌面端"));
    await flush(40);
    let text = logText();
    assert.ok(text.includes("desktop service port="), "桌面端那块留着");
    assert.ok(!text.includes("Starting server"), "只看桌面端时内核那块收起");
    assert.ok(!text.includes("ComfyUI 内核"), "收起的块不留标题");
    assert.ok(srcBtn("桌面端").classList.contains("is-on"), "筛选钮要亮在选中的那个上");

    click(srcBtn("内核"));
    await flush(40);
    text = logText();
    assert.ok(!text.includes("desktop service port="), "只看内核时桌面端那块收起");

    click(srcBtn("全部"));
    await flush(40);
    text = logText();
    assert.ok(text.includes("Starting server") && text.includes("desktop service port="), "切回全部恢复两块");
});

test("浏览器标签页：只有内核那一块，块标题与桌面端筛选钮不上页面", async () => {
    await openLogTab("browser", KERNEL_LOG);
    const text = logText();
    assert.ok(text.includes("[INFO] Starting server"), "内核日志照常显示");
    assert.ok(!text.includes("——"), "单块不分块：只有一份日志时块标题是多余控件");
    assert.equal(srcBtn("桌面端").style.display, "none", "没有桌面端那一路就不把筛选钮交出去");
    assert.ok(srcBtn("内核").style.display !== "none", "内核筛选照常可用");
});
