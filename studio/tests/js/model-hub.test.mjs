// 模型库弹窗（model-hub.js）：仓库分组 / 文件清单归类 / 落盘子目录列表与默认探查 /
// 下载启动与进度轮询（running → done）/ 取消保留断点 / 设置保存 / 源切换 / 失败提示。
import test from "node:test";
import assert from "node:assert/strict";
import {
    resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, missingRoutes,
    click, changeValue, inputText, keydown, sleep, clearBody,
} from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

const hub = await import("../../web/model-hub.js");   // setup.mjs 副作用先行

const SETTINGS = {
    source: "modelscope", hf_endpoint: "", hf_token: "", ms_token: "ms-token",
    llm_subdir: "LLM", timeout_total: 3600, sock_read: 120,
};
const REPOS = [
    { repo: "Comfy-Org/z_image", on_hf: true, on_ms: true, downloads: 1234 },
    { repo: "Comfy-Org/ltx-2", on_hf: true, on_ms: false },
    { repo: "Comfy-Org/SomeNew", on_hf: false, on_ms: false },
];
const REGISTRY = { groups: [{ name: "生图", repos: ["Comfy-Org/z_image"] }], bundles: [] };
const FILES = [
    { path: "split_files/diffusion_models/z_image_bfp.safetensors", filename: "z_image_bfp.safetensors", category: "diffusion_models", size: 12 * 1024 ** 3, exists: true, exists_sub: "Flux2-Klein" },
    { path: "split_files/text_encoders/qwen3_8b.safetensors", filename: "qwen3_8b.safetensors", category: "text_encoders", size: 8.2 * 1024 ** 3, exists: false },
    { path: "qwen3_8b_q4_k_m.gguf", filename: "qwen3_8b_q4_k_m.gguf", category: "llm", size: 5 * 1024 ** 3, exists: true, exists_sub: "z_image" },
];
const READY_ALL = {
    family_count: 2, preset_count: 3, blocking_count: 1,
    families: [
        {
            family: "qwen_image_21", label: "Qwen-Image 2.1", kind: "image",
            skills: [{ skill_id: "qwen_image_21_body_swap", cn_name: "身体替换" }],
            files: [], preset_count: 1, file_count: 4, total_gb: 30.5,
            missing_count: 2, missing_gb: 18.2, blocked: true,
        },
        {
            family: "ltx2", label: "LTX-2", kind: "video",
            skills: [{ skill_id: "ltx2_t2v", cn_name: "文生视频" }, { skill_id: "ltx2_i2v", cn_name: "图生视频" }],
            files: [], preset_count: 2, file_count: 3, total_gb: 21,
            missing_count: 0, missing_gb: 0, blocked: false,
        },
    ],
};
const READY_PLAN_FILES = [
    {
        field: "model", category: "diffusion_models", filename: "qwen_image_bfp.safetensors",
        base_name: "qwen_image_bfp.safetensors", label: "基座", gb: 11.4, sources: [], subfolder: "Qwen",
        on_source: true, reason: "", source: "modelscope", gated: false,
        payload: { source: "modelscope", repo: "Comfy-Org/Qwen-Image_ComfyUI",
            path: "split_files/diffusion_models/qwen_image_bfp.safetensors",
            category: "diffusion_models", subfolder: "Qwen", filename: "qwen_image_bfp.safetensors" },
    },
    {
        field: "vae", category: "vae", filename: "vae.safetensors", base_name: "vae.safetensors",
        label: "VAE", gb: 0.3, sources: [], subfolder: "", on_source: true, reason: "",
        source: "modelscope", gated: false,
        note: "仓库文件落盘名 qwen_image_vae.safetensors 与配置名 vae.safetensors 不同名，就位检查按 qwen_image_vae.safetensors 算",
        payload: { source: "modelscope", repo: "Comfy-Org/Qwen-Image_ComfyUI",
            path: "split_files/vae/qwen_image_vae.safetensors",
            category: "vae", subfolder: "", filename: "qwen_image_vae.safetensors" },
    },
    {
        field: "text_encoder", category: "text_encoders", filename: "qwen3_8b.safetensors",
        base_name: "qwen3_8b.safetensors", label: "文本编码器", gb: 8.2, sources: [], subfolder: "",
        on_source: false, reason: "not_on_source", other_source: "huggingface",
    },
];
const READY_PLAN = {
    skill_id: "qwen_image_21_body_swap", has_manifest: true, family: "qwen_image_21",
    label: "Qwen-Image 2.1", kind: "image", notes: ["权重为 Apache-2.0 许可，可商用"],
    source: "modelscope", source_label: "MS", needs_token: false, has_token: true,
    files: READY_PLAN_FILES, missing: ["文本编码器（text_encoders · 8.2 GB）"],
    missing_gb: 8.2, total_gb: 11.7,
};

function mockHub(progress = () => jsonResponse({ download: { state: "idle" } })) {
    mockRoute("/neo_model_hub/settings", (body, call) => jsonResponse(
        call.method === "GET"
            ? { settings: SETTINGS, registry: REGISTRY, categories: ["diffusion_models", "text_encoders", "llm"], sources: ["modelscope", "huggingface"] }
            : { success: true, settings: { ...SETTINGS, ...body } }));
    mockRoute("/neo_model_hub/repos", () => jsonResponse({ repos: REPOS }));
    mockRoute("/neo_model_hub/files", () => jsonResponse({ files: FILES, categories: ["diffusion_models", "text_encoders", "llm"] }));
    mockRoute("/neo_model_hub/subfolders", (body) => jsonResponse({
        subfolders: body.category === "llm" ? ["Qwen", "Flux"] : [],
        default: body.category === "llm" ? "Qwen" : "",
    }));
    mockRoute("/neo_model_hub/download", () => jsonResponse({ success: true, download: { state: "running" } }));
    mockRoute("/neo_model_hub/cancel", () => jsonResponse({ success: true, download: { state: "cancelling" } }));
    mockRoute("/neo_model_hub/progress", progress);
}

async function openHub(opts = {}) {
    hub.closeModelHub();
    const overlay = hub.openModelHub(opts);
    await sleep(60);
    return overlay;
}

test("模型库：打开弹窗注入样式并拉取设置与仓库列表", async () => {
    resetEnv();
    clearRoutes();
    mockHub();
    const overlay = await openHub();

    assert.equal(document.getElementById("neo-hub-css")?.getAttribute("href"),
        "/extensions/comfyui-neo-studio/model-hub.css", "样式未注入");
    assert.ok(overlay.querySelector(".neo-hub-title")?.textContent.includes("模型库"), "标题缺失");
    assert.deepEqual(missingRoutes.filter((r) => r.includes("/neo_model_hub/")), [], "有未覆盖的模型库请求");

    // 仓库下拉：注册表分组在前，未收录的落「其他」，带源标记与下载数
    const groups = [...overlay.querySelectorAll(".neo-hub-repo optgroup")];
    assert.deepEqual(groups.map((g) => g.label), ["生图", "其他"], "分组未按注册表生成");
    assert.deepEqual([...groups[0].querySelectorAll("option")].map((o) => o.textContent),
        ["Comfy-Org/z_image · 1234 · 双源"], "分组内条目缺失下载数 / 源标记");
    assert.deepEqual([...groups[1].querySelectorAll("option")].map((o) => o.textContent),
        ["Comfy-Org/ltx-2 · HF", "Comfy-Org/SomeNew · 未探测"], "「其他」分组内容不符");

    // 默认源同步到源按钮
    const active = [...overlay.querySelectorAll(".neo-hub-src-btn")]
        .filter((b) => b.classList.contains("neo-hub-src-active")).map((b) => b.dataset.source);
    assert.deepEqual(active, ["modelscope"], "默认源未同步到源按钮");
    hub.closeModelHub();
});

test("模型库：HF 源不可达时列表照常出，列表行写明被跳过的源", async () => {
    resetEnv();
    clearRoutes();
    mockHub();
    mockRoute("/neo_model_hub/repos", () => jsonResponse({ repos: REPOS, skipped: ["huggingface"] }));
    const overlay = await openHub();

    assert.equal(overlay.querySelector(".neo-hub-info").textContent,
        "3 个仓库 · Hugging Face 列表不可达", "被跳过的源未写明");
    assert.equal(overlay.querySelectorAll(".neo-hub-repo option").length, REPOS.length, "仓库列表未照常出");
    assert.equal(overlay.querySelectorAll(".neo-hub-files option").length, FILES.length, "文件清单未照常出");
    hub.closeModelHub();
});


test("模型库：文件清单归类与已存在标记，选文件带出落盘目标", async () => {
    resetEnv();
    clearRoutes();
    mockHub();
    const overlay = await openHub();

    const opts = [...overlay.querySelectorAll(".neo-hub-files option")];
    assert.deepEqual(opts.map((o) => o.textContent), [
        "z_image_bfp.safetensors  [diffusion_models]  12.00 GB  已存在 (Flux2-Klein)",
        "qwen3_8b.safetensors  [text_encoders]  8.20 GB",
        "qwen3_8b_q4_k_m.gguf  [llm]  5.00 GB  已存在 (z_image)",
    ], "文件清单条目不符");

    // 选 GGUF → 落盘类别自动带出，子目录按已有目录重拉并自动探查默认，LLM 预览含强制仓库目录
    changeValue(overlay.querySelector(".neo-hub-files"), "qwen3_8b_q4_k_m.gguf");
    await sleep(40);
    assert.equal(overlay.querySelector(".neo-hub-cat").value, "llm", "类别未随文件带出");
    assert.equal(overlay.querySelector(".neo-hub-sub").value, "Qwen", "默认子目录未自动探查");
    assert.equal(overlay.querySelector(".neo-hub-dest").textContent,
        "→ models/llm/Qwen/z_image/qwen3_8b_q4_k_m.gguf", "落盘目标预览不符");

    // 搜索：回车按当前源带 query 拉仓库
    inputText(overlay.querySelector(".neo-hub-search"), "z_image");
    keydown(overlay.querySelector(".neo-hub-search"), "Enter");
    await sleep(40);
    const repoReq = fetchLog.filter((c) => c.path === "/neo_model_hub/repos").at(-1);
    assert.equal(repoReq.body.query, "z_image", "搜索词未带上");
    assert.equal(repoReq.body.source, "modelscope", "仓库请求未带当前源");
    hub.closeModelHub();
});

test("模型库：文件清单失败行不可作为文件选中，落盘目标不被污染", async () => {
    resetEnv();
    clearRoutes();
    mockHub();
    mockRoute("/neo_model_hub/files", () => jsonResponse({
        success: false, source: "modelscope", repo: "Comfy-Org/ghost_repo",
        error: "文件清单加载失败：ModelScope 连不通，检查本机网络与代理后点 ⟳ 重试，或把源切到 Hugging Face",
    }, 502));
    const overlay = await openHub();

    const opts = [...overlay.querySelectorAll(".neo-hub-files option")];
    assert.equal(opts.length, 1, "应只剩失败行");
    assert.ok(opts[0].textContent.includes("ModelScope 连不通"), "失败行未写明出路");
    assert.ok(opts[0].dataset.hubError, "失败行未标记为不可选");

    // 报错行没有 value 属性，浏览器会把文案文本当 value —— 这正是要防的污染点
    assert.equal(opts[0].value, opts[0].textContent, "报错行的 value 就是文案本身");
    changeValue(overlay.querySelector(".neo-hub-files"), opts[0].value);
    await sleep(40);
    assert.equal(overlay.querySelector(".neo-hub-dest").textContent, "", "落盘预览被错误行污染");
    hub.closeModelHub();
});


test("模型库：子目录成列表且默认自动探查，可选新建子目录落盘", async () => {
    resetEnv();
    clearRoutes();
    mockHub();
    const overlay = await openHub();

    const subSel = overlay.querySelector(".neo-hub-sub");
    assert.deepEqual([...subSel.querySelectorAll("option")].map((o) => o.textContent),
        ["（根目录）", "＋ 新建子目录…"], "无已有子目录时应只有根目录与新建两项");
    assert.equal(subSel.value, "", "无已有子目录时默认落根目录");
    assert.equal(overlay.querySelector(".neo-hub-sub-new").style.display, "none", "新建输入框应隐藏");

    // 切类别 → 按新类别重拉子目录，默认自动探查选中
    changeValue(overlay.querySelector(".neo-hub-cat"), "llm");
    await sleep(40);
    assert.deepEqual([...subSel.querySelectorAll("option")].map((o) => o.textContent),
        ["（根目录）", "Qwen", "Flux", "＋ 新建子目录…"], "已有子目录未成列表");
    assert.equal(subSel.value, "Qwen", "默认子目录未自动探查");

    // 新建子目录 → 出现输入框，输入参与目标预览与下载请求
    changeValue(subSel, "__new__");
    const subNew = overlay.querySelector(".neo-hub-sub-new");
    assert.equal(subNew.style.display, "", "新建子目录输入框未出现");
    inputText(subNew, "My/Team");
    changeValue(overlay.querySelector(".neo-hub-files"), "qwen3_8b_q4_k_m.gguf");
    assert.equal(overlay.querySelector(".neo-hub-dest").textContent,
        "→ models/llm/My/Team/z_image/qwen3_8b_q4_k_m.gguf", "新建子目录未参与预览");

    click(overlay.querySelector(".neo-hub-dl"));
    await sleep(40);
    const dlReq = fetchLog.filter((c) => c.path === "/neo_model_hub/download").at(-1);
    assert.equal(dlReq.body.subfolder, "My/Team", "新建子目录未提交");
    hub.closeModelHub();
});

test("模型库：点已存在文件自动跟随其所在子目录并用于落盘", async () => {
    resetEnv();
    clearRoutes();
    mockHub();
    const overlay = await openHub();
    const subSel = overlay.querySelector(".neo-hub-sub");
    assert.equal(subSel.value, "", "初始应落根目录");

    // 已存在文件位于 Flux2-Klein 子目录 → 点文件即跟随（该目录不在服务端列表里也要补上）
    changeValue(overlay.querySelector(".neo-hub-files"), "split_files/diffusion_models/z_image_bfp.safetensors");
    await sleep(40);
    assert.ok([...subSel.querySelectorAll("option")].some((o) => o.value === "Flux2-Klein"), "已存在子目录未进下拉");
    assert.equal(subSel.value, "Flux2-Klein", "未跟随已存在文件所在子目录");
    assert.equal(overlay.querySelector(".neo-hub-dest").textContent,
        "→ models/diffusion_models/Flux2-Klein/z_image_bfp.safetensors", "落盘目标未跟随子目录");

    click(overlay.querySelector(".neo-hub-dl"));
    await sleep(40);
    const dlReq = fetchLog.filter((c) => c.path === "/neo_model_hub/download").at(-1);
    assert.equal(dlReq.body.subfolder, "Flux2-Klein", "已存在子目录未提交");

    // LLM：已存在位置就是强制的仓库目录时不重复叠加，回落到探查默认
    changeValue(overlay.querySelector(".neo-hub-files"), "qwen3_8b_q4_k_m.gguf");
    await sleep(40);
    assert.equal(overlay.querySelector(".neo-hub-dest").textContent,
        "→ models/llm/Qwen/z_image/qwen3_8b_q4_k_m.gguf", "LLM 已存在位置不应叠加仓库目录");
    hub.closeModelHub();
});


test("模型库：下载启动后轮询进度，完成时提示并刷新文件清单", async () => {
    resetEnv();
    clearRoutes();
    let prog = { state: "running", total: 1000, done: 250, speed: 500, filename: "qwen3_8b.safetensors" };
    mockHub(() => jsonResponse({ download: prog }));
    const overlay = await openHub();

    changeValue(overlay.querySelector(".neo-hub-files"), "split_files/text_encoders/qwen3_8b.safetensors");
    click(overlay.querySelector(".neo-hub-dl"));
    await sleep(60);

    const dlReq = fetchLog.filter((c) => c.path === "/neo_model_hub/download").at(-1);
    assert.deepEqual(dlReq.body, {
        source: "modelscope", repo: "Comfy-Org/z_image",
        path: "split_files/text_encoders/qwen3_8b.safetensors",
        category: "text_encoders", subfolder: "", filename: "qwen3_8b.safetensors",
    }, "下载请求体不符");
    assert.equal(overlay.querySelector(".neo-hub-dl").disabled, true, "下载中应禁用下载按钮");

    await sleep(200);
    assert.equal(overlay.querySelector(".neo-hub-cancel").disabled, false, "running 后取消按钮应可用");
    assert.equal(overlay.querySelector(".neo-hub-bar i").style.width, "25%", "进度条宽度不符");
    assert.equal(overlay.querySelector(".neo-hub-prog").textContent,
        "25.0% · 250 B / 1000 B · 500 B/s", "进度文案不符");

    prog = { state: "done", total: 1000, done: 1000, speed: 0, filename: "qwen3_8b.safetensors", category: "text_encoders" };
    const filesBefore = fetchLog.filter((c) => c.path === "/neo_model_hub/files").length;
    await sleep(200);
    assert.ok(appState.toasts.some((t) => t.summary === "下载完成"), "完成未提示");
    assert.equal(overlay.querySelector(".neo-hub-dl").disabled, false, "完成后应恢复下载按钮");
    assert.ok(fetchLog.filter((c) => c.path === "/neo_model_hub/files").length > filesBefore, "完成后未刷新文件清单");
    hub.closeModelHub();
});


test("模型库：取消保留断点，切源与保存设置后重拉仓库", async () => {
    resetEnv();
    clearRoutes();
    let prog = { state: "running", total: 1000, done: 100, speed: 100, filename: "a.safetensors" };
    mockHub(() => jsonResponse({ download: prog }));
    const overlay = await openHub();

    changeValue(overlay.querySelector(".neo-hub-files"), "split_files/diffusion_models/z_image_bfp.safetensors");
    click(overlay.querySelector(".neo-hub-dl"));
    await sleep(200);
    click(overlay.querySelector(".neo-hub-cancel"));
    await sleep(40);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_model_hub/cancel").length, 1, "取消未发请求");

    prog = { state: "paused", total: 1000, done: 100, speed: 0, error: "已取消（断点保留）" };
    await sleep(200);
    assert.equal(overlay.querySelector(".neo-hub-status").textContent, "已取消（断点保留）", "断点提示不符");
    assert.ok(appState.toasts.some((t) => t.summary === "已取消"), "取消未提示");
    assert.equal(overlay.querySelector(".neo-hub-cancel").disabled, true, "取消后应禁用取消按钮");

    // 切源 → 按新源重拉仓库
    const hfBtn = [...overlay.querySelectorAll(".neo-hub-src-btn")].find((b) => b.dataset.source === "huggingface");
    click(hfBtn);
    await sleep(40);
    assert.deepEqual(fetchLog.filter((c) => c.path === "/neo_model_hub/repos").map((c) => c.body.source),
        ["modelscope", "huggingface"], "切换源未重拉仓库");

    // 设置面板：展开 → 改 LLM 子目录 → 保存（POST 表单值）→ 重拉仓库
    click(overlay.querySelector('.neo-hub-icon-btn[title^="模型库设置"]'));
    const panel = overlay.querySelector(".neo-hub-settings");
    assert.equal(panel.style.display, "block", "设置面板未展开");
    inputText(panel.querySelectorAll("input")[3], "LLM1");
    click(panel.querySelector(".neo-hub-save"));
    await sleep(60);
    const saved = fetchLog.filter((c) => c.path === "/neo_model_hub/settings" && c.method === "POST").at(-1);
    assert.equal(saved.body.llm_subdir, "LLM1", "LLM 子目录未提交");
    assert.ok(appState.toasts.some((t) => t.summary === "模型库设置已保存"), "保存未提示");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_model_hub/repos").length, 3, "保存后未重拉仓库");
    hub.closeModelHub();
});

test("模型库：接口失败给出可读提示且弹窗保持可用", async () => {
    resetEnv();
    clearRoutes();
    mockRoute("/neo_model_hub/settings", () => jsonResponse({ settings: SETTINGS, registry: REGISTRY, categories: ["diffusion_models"] }));
    mockRoute("/neo_model_hub/repos", () => jsonResponse({ repos: REPOS }));
    mockRoute("/neo_model_hub/files", () => jsonResponse({ error: "仓库不存在该文件" }, 404));
    const overlay = await openHub();

    assert.match(overlay.querySelector(".neo-hub-files").textContent, /文件清单加载失败：仓库不存在该文件/, "清单失败未提示");
    assert.ok(appState.toasts.some((t) => t.summary === "文件清单加载失败"), "清单失败未 toast");
    assert.match(overlay.querySelector(".neo-hub-repo").nextSibling.textContent, /个仓库/, "仓库计数未显示");
    assert.equal(overlay.querySelector(".neo-hub-dest").textContent, "", "清单报错条目被当成文件拼进了落盘路径");

    click(overlay.querySelector(".neo-hub-head .neo-hub-icon-btn:last-of-type"));
    assert.equal(document.querySelector(".neo-hub-overlay"), null, "关闭后弹窗未移除");
    hub.closeModelHub();
    clearBody();
});

// ---------------------------------------------------------------------------
// Civitai 第三源：过滤行 / 搜索参数 / 底模下拉 / 权重清单 / 签名端点下载 / 设置回显
// ---------------------------------------------------------------------------

const CIVI_SETTINGS = {
    source: "civitai", hf_endpoint: "", hf_token: "", ms_token: "",
    llm_subdir: "LLM", timeout_total: 3600, sock_read: 120,
};
const CIVI_MODELS = {
    items: [
        { id: 123, name: "MyLoRA", base_models: ["SDXL"], type: "LORA", downloads: 4200, creator: "Tom" },
        { id: 456, name: "Dark", base_models: [], type: "LoCon", downloads: 12, nsfw: true },
    ],
    page: 1,
    base_models: ["SDXL", "Pony"],
};
const CIVI_FILES = {
    files: [{
        path: "/api/download/models/1?token=t", filename: "mylora.safetensors", category: "loras",
        size: 140 * 1024 * 1024, version_name: "v2", base_model: "SDXL", trained_words: ["kw"], exists: false,
    }],
};

function mockCivitai(source = "civitai") {
    mockRoute("/neo_model_hub/settings", () => jsonResponse({
        settings: { ...CIVI_SETTINGS, source }, registry: { groups: [], bundles: [] },
        categories: ["loras", "diffusion_models"],
        sources: ["modelscope", "huggingface", "civitai"],
        civitai: { api_key_set: true, proxy: "http://127.0.0.1:7890" },
    }));
    mockRoute("/neo_model_hub/repos", () => jsonResponse({ repos: [] }));
    mockRoute("/neo_model_hub/files", () => jsonResponse({ files: [] }));
    mockRoute("/neo_model_hub/civitai/search", () => jsonResponse(CIVI_MODELS));
    mockRoute("/neo_model_hub/civitai/files", () => jsonResponse(CIVI_FILES));
    mockRoute("/neo_model_hub/subfolders", () => jsonResponse({ subfolders: [], default: "" }));
    mockRoute("/neo_model_hub/download", () => jsonResponse({ success: true, download: { state: "running" } }));
    mockRoute("/neo_model_hub/progress", () => jsonResponse({ download: { state: "idle" } }));
}

test("模型库：C 站源显示过滤行，搜索参数与模型/权重清单按 C 站结构渲染", async () => {
    resetEnv();
    clearRoutes();
    mockCivitai();
    const overlay = await openHub({ source: "civitai" });

    // 源按钮 / 过滤行 / 搜索提示随源切换
    const active = [...overlay.querySelectorAll(".neo-hub-src-btn")]
        .filter((b) => b.classList.contains("neo-hub-src-active")).map((b) => b.dataset.source);
    assert.deepEqual(active, ["civitai"], "C 站源未激活");
    assert.equal(overlay.querySelector(".neo-hub-civi").style.display, "", "C 站过滤行未显示");
    assert.match(overlay.querySelector(".neo-hub-search").placeholder, /C 站/, "搜索提示未随源切换");
    assert.deepEqual(missingRoutes.filter((r) => r.includes("/neo_model_hub/")), [], "有未覆盖的模型库请求");

    // 搜索请求：类型 / 底模 / 排序 / NSFW / 页码 / 关键词 / 游标
    assert.deepEqual(fetchLog.filter((c) => c.path === "/neo_model_hub/civitai/search").at(-1).body, {
        query: "", types: ["LORA"], base_models: [], sort: "Most Downloaded", nsfw: false,
        page: 1, cursor: "",
    }, "C 站搜索参数不符");

    // 底模下拉：保留「全部底模」再补响应里的底模
    assert.deepEqual([...overlay.querySelectorAll(".neo-hub-civi-base option")].map((o) => o.value),
        ["", "SDXL", "Pony"], "底模下拉未由响应填充");

    // 模型下拉：名称 · 底模（缺则类型）· 下载数 · NSFW · 作者
    assert.deepEqual([...overlay.querySelectorAll(".neo-hub-repo option")].map((o) => o.textContent),
        ["MyLoRA · SDXL · 4200 · Tom", "Dark · LoCon · 12 · NSFW"], "C 站模型条目不符");
    assert.equal(overlay.querySelector(".neo-hub-info").textContent, "2 个模型 · 第 1 页", "模型计数不符");

    // 权重清单带版本名；点文件后落盘预览用 C 站类别
    assert.deepEqual([...overlay.querySelectorAll(".neo-hub-files option")].map((o) => o.textContent),
        ["mylora.safetensors  [loras]  140.0 MB  〈v2〉"], "C 站文件清单不符");
    changeValue(overlay.querySelector(".neo-hub-files"), "/api/download/models/1?token=t");
    await sleep(40);
    assert.equal(overlay.querySelector(".neo-hub-dest").textContent,
        "→ models/loras/mylora.safetensors", "C 站落盘预览不符");
    hub.closeModelHub();
    clearBody();
});


test("模型库：C 站下载走签名端点，设置面板回显 KEY 状态与代理", async () => {
    resetEnv();
    clearRoutes();
    mockCivitai();
    const overlay = await openHub({ source: "civitai" });

    // 设置回显：只报 KEY 是否已设置与代理地址，不回明文
    const note = overlay.querySelector(".neo-hub-civi-note").textContent;
    assert.match(note, /API KEY 已设置/, "C 站 KEY 状态未回显");
    assert.match(note, /http:\/\/127\.0\.0\.1:7890/, "C 站代理未回显");

    // 类别与表单由设置响应填充，C 站源不被默认源覆盖
    assert.deepEqual([...overlay.querySelectorAll(".neo-hub-cat option")].map((o) => o.value),
        ["loras", "diffusion_models"], "类别未按设置填充");
    assert.equal(overlay.querySelector(".neo-hub-settings").style.display, "none", "设置面板应默认收起");

    changeValue(overlay.querySelector(".neo-hub-files"), "/api/download/models/1?token=t");
    await sleep(40);
    click(overlay.querySelector(".neo-hub-dl"));
    await sleep(40);
    assert.deepEqual(fetchLog.filter((c) => c.path === "/neo_model_hub/download").at(-1).body, {
        source: "civitai", repo: "civitai/123", path: "/api/download/models/1?token=t",
        category: "loras", subfolder: "", filename: "mylora.safetensors",
    }, "C 站下载请求体不符");
    hub.closeModelHub();
    clearBody();
});

test("模型库：切到 C 站源后按过滤条件重搜，不拉 HF/MS 仓库列表", async () => {
    resetEnv();
    clearRoutes();
    mockCivitai("modelscope");
    const overlay = await openHub();
    assert.equal(overlay.querySelector(".neo-hub-civi").style.display, "none", "非 C 站源不应显示过滤行");

    const civiBtn = [...overlay.querySelectorAll(".neo-hub-src-btn")].find((b) => b.dataset.source === "civitai");
    click(civiBtn);
    await sleep(60);
    assert.equal(overlay.querySelector(".neo-hub-civi").style.display, "", "切源后过滤行未显示");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_model_hub/repos").length, 1, "C 站源不应拉仓库列表");

    // 类型变更 → 按新类型重搜（refresh 保持当前页）
    inputText(overlay.querySelector(".neo-hub-search"), "anime");
    changeValue(overlay.querySelector(".neo-hub-civi-type"), "LoCon");
    await sleep(60);
    assert.deepEqual(fetchLog.filter((c) => c.path === "/neo_model_hub/civitai/search").at(-1).body, {
        query: "anime", types: ["LoCon"], base_models: [], sort: "Most Downloaded", nsfw: false,
        page: 1, cursor: "",
    }, "类型变更未重搜");

    // 底模 + NSFW → 进参数
    changeValue(overlay.querySelector(".neo-hub-civi-base"), "Pony");
    const nsfwInput = overlay.querySelector(".neo-hub-civi input[type=\"checkbox\"]");
    nsfwInput.checked = true;
    changeValue(nsfwInput, "on");
    await sleep(60);
    const last = fetchLog.filter((c) => c.path === "/neo_model_hub/civitai/search").at(-1).body;
    assert.deepEqual([last.base_models, last.nsfw], [["Pony"], true], "底模 / NSFW 未进参数");

    // 搜索框回车 → 回到第 1 页
    keydown(overlay.querySelector(".neo-hub-search"), "Enter");
    await sleep(60);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_model_hub/civitai/search").at(-1).body.page, 1,
        "回车搜索应回到第 1 页");
    hub.closeModelHub();
    clearBody();
});

test("模型库：C 站下一页按 next_cursor 翻页，上一页回退，过滤变更作废游标", async () => {
    resetEnv();
    clearRoutes();
    mockCivitai();
    const searchBodies = [];
    mockRoute("/neo_model_hub/civitai/search", (body) => {
        searchBodies.push(body);
        return jsonResponse(body.page === 2
            ? { ...CIVI_MODELS, page: 2, items: [CIVI_MODELS.items[0]] }
            : { ...CIVI_MODELS, next_cursor: "CURSOR-2" });
    });
    const overlay = await openHub({ source: "civitai" });

    const nextBtn = overlay.querySelector(".neo-hub-civi-next");
    const prevBtn = overlay.querySelector(".neo-hub-civi-prev");
    assert.equal(prevBtn.disabled, true, "第 1 页上一页应禁用");
    assert.equal(nextBtn.disabled, false, "有 next_cursor 时下一页应可用");

    click(nextBtn);
    await sleep(60);
    assert.deepEqual([searchBodies.at(-1).page, searchBodies.at(-1).cursor], [2, "CURSOR-2"],
        "下一页未按游标请求");
    assert.equal(overlay.querySelector(".neo-hub-info").textContent, "1 个模型 · 第 2 页", "翻页计数不符");
    assert.equal(prevBtn.disabled, false, "第 2 页上一页应可用");
    assert.equal(nextBtn.disabled, true, "无 next_cursor 时下一页应禁用");

    click(prevBtn);
    await sleep(60);
    assert.deepEqual([searchBodies.at(-1).page, searchBodies.at(-1).cursor], [1, ""],
        "上一页未回到第 1 页");

    // 排序变更 → 旧游标作废，回到第 1 页
    changeValue(overlay.querySelector(".neo-hub-civi-sort"), "Newest");
    await sleep(60);
    assert.deepEqual([searchBodies.at(-1).page, searchBodies.at(-1).cursor, searchBodies.at(-1).sort],
        [1, "", "Newest"], "过滤变更未回到第 1 页");
    hub.closeModelHub();
    clearBody();
});


// ---------------------------------------------------------------------------
// 预设就绪面板（/neo_skill_models/*）：总览 → 计划 → 计划队列下完刷新就位
// ---------------------------------------------------------------------------

test("模型库 · 预设就绪：总览按族系出缺项徽标与预设入口", async () => {
    resetEnv();
    clearRoutes();
    mockHub();
    mockReady();
    const overlay = await openHub();
    assert.equal(overlay.querySelector(".neo-hub-ready").style.display, "none", "默认应收起就绪面板");

    click(overlay.querySelector(".neo-hub-ready-toggle"));
    await sleep(60);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_skill_models/all").length, 1, "未拉取族系总览");
    assert.equal(overlay.querySelector(".neo-hub-ready").style.display, "", "面板未展开");
    assert.equal(overlay.querySelector(".neo-hub-ready-summary").textContent,
        "3 个预设 · 2 个族系 · 需要补模型的族系 1 个", "总览计数不符");

    const fams = [...overlay.querySelectorAll(".neo-hub-ready-family")];
    assert.equal(fams.length, 2, "族系行数不符");
    assert.equal(fams[0].querySelector(".neo-hub-ready-badge").textContent, "缺 2 项 · 18.2 GB", "缺项徽标不符");
    assert.equal(fams[1].querySelector(".neo-hub-ready-badge").textContent, "已就绪", "就绪徽标不符");
    assert.equal(fams[0].querySelector(".neo-hub-ready-name").textContent,
        "Qwen-Image 2.1（生图 · 1 预设 · 4 文件 · 30.5 GB）", "族系行文案不符");
    assert.deepEqual([...fams[1].querySelectorAll(".neo-hub-ready-skill")].map((b) => b.textContent),
        ["文生视频", "图生视频"], "族系内预设入口不符");
    assert.deepEqual(missingRoutes.filter((r) => r.includes("/neo_skill_models/")), [], "有未覆盖的就绪请求");
    hub.closeModelHub();
    clearBody();
});

test("模型库 · 预设就绪：点预设出计划，条目按当前源给下载按钮与缺源提示", async () => {
    resetEnv();
    clearRoutes();
    mockHub();
    mockReady();
    const overlay = await openHub();
    click(overlay.querySelector(".neo-hub-ready-toggle"));
    await sleep(60);
    click(overlay.querySelector(".neo-hub-ready-skill"));
    await sleep(60);

    assert.deepEqual(fetchLog.filter((c) => c.path === "/neo_skill_models/plan").at(-1).body,
        { skill_id: "qwen_image_21_body_swap", source: "modelscope", include_optional: false, effect: "" },
        "计划请求体不符");   // effect 空串 = 这份清单没有特效表，按技能默认口径出计划
    const rows = [...overlay.querySelectorAll(".neo-hub-ready-item")];
    assert.equal(rows.length, 3, "计划行数不符");
    assert.equal(rows[0].querySelector(".neo-hub-ready-name").textContent,
        "基座 · diffusion_models/Qwen/qwen_image_bfp.safetensors", "条目落盘目标文案不符");
    assert.equal(rows[0].querySelector(".neo-hub-ready-dl").disabled, false, "可下载条目按钮应可用");
    assert.ok(rows[1].querySelector(".neo-hub-ready-item-note").textContent.includes("就位检查按 qwen_image_vae.safetensors 算"),
        "异名落盘的条目 note 未展示");
    assert.equal(rows[2].querySelector(".neo-hub-ready-dl").disabled, true, "当前源没有的条目不应可点");
    assert.ok(rows[2].querySelector(".neo-hub-ready-item-note").textContent.includes("Hugging Face 有，切到该源后重新出计划"),
        "缺源提示不符");
    const notes = [...overlay.querySelectorAll(".neo-hub-ready-note")].map((n) => n.textContent);
    assert.ok(notes.some((n) => n.includes("权重为 Apache-2.0 许可，可商用")), "清单 notes 未展示");
    assert.ok(notes.some((n) => n.includes("待下载 2 项 · 11.7 GB")), "待下载合计不符");
    assert.equal(overlay.querySelector(".neo-hub-ready-summary").textContent,
        "3 个预设 · 2 个族系 · 需要补模型的族系 1 个", "出完计划应回到计数行");

    // 勾选「计划含可选文件」→ 按 include_optional 重出计划
    const optional = overlay.querySelector(".neo-hub-ready input[type=\"checkbox\"]");
    optional.checked = true;
    changeValue(optional, "on");
    await sleep(60);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_skill_models/plan").at(-1).body.include_optional, true,
        "勾选可选项未重出计划");

    // 切到需要 Token 的源 → 按新源重出计划并说明前置
    click([...overlay.querySelectorAll(".neo-hub-src-btn")].find((b) => b.dataset.source === "huggingface"));
    await sleep(60);
    const last = fetchLog.filter((c) => c.path === "/neo_skill_models/plan").at(-1).body;
    assert.deepEqual([last.source, last.skill_id], ["huggingface", "qwen_image_21_body_swap"], "换源未按当前源重出计划");
    assert.equal(overlay.querySelector(".neo-hub-ready-warn").textContent,
        "该源需要先在模型库设置里填 HF Token", "缺 Token 前置未提示");
    hub.closeModelHub();
    clearBody();
});


test("模型库 · 预设就绪：全部下载按计划逐条排队，下完重读就位", async () => {
    resetEnv();
    clearRoutes();
    const downloads = [];
    let prog = { state: "running", total: 1000, done: 100, speed: 100, filename: "qwen_image_bfp.safetensors" };
    mockHub(() => jsonResponse({ download: prog }));
    mockReady();
    mockRoute("/neo_model_hub/download", (body) => {
        downloads.push(body);
        return jsonResponse({ success: true, download: { state: "running" } });
    });
    const overlay = await openHub();
    click(overlay.querySelector(".neo-hub-ready-toggle"));
    await sleep(60);
    click(overlay.querySelector(".neo-hub-ready-skill"));
    await sleep(60);
    const allBefore = fetchLog.filter((c) => c.path === "/neo_skill_models/all").length;
    const planBefore = fetchLog.filter((c) => c.path === "/neo_skill_models/plan").length;

    click(overlay.querySelector(".neo-hub-ready-all"));
    await sleep(60);
    assert.deepEqual(downloads.map((b) => b.filename), ["qwen_image_bfp.safetensors"], "第一条未按 payload 提交");
    assert.deepEqual(downloads[0], READY_PLAN_FILES[0].payload, "第一条提交体与计划 payload 不符");
    assert.equal(overlay.querySelector(".neo-hub-dl").disabled, true, "队列占用下载按钮");

    prog = { state: "done", total: 1000, done: 1000, speed: 0, filename: "qwen_image_bfp.safetensors", category: "diffusion_models" };
    await sleep(300);
    assert.deepEqual(downloads.map((b) => b.filename),
        ["qwen_image_bfp.safetensors", "qwen_image_vae.safetensors"], "上一条完成后未接下一条");

    prog = { state: "done", total: 1000, done: 1000, speed: 0, filename: "qwen_image_vae.safetensors", category: "vae" };
    await sleep(300);
    assert.equal(downloads.length, 2, "队列不应超出计划条目数");
    assert.equal(overlay.querySelector(".neo-hub-dl").disabled, false, "队列结束后应恢复下载按钮");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_skill_models/all").length, allBefore + 1, "队列结束未重读就位总览");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_skill_models/plan").length, planBefore + 1, "队列结束未重出计划");
    hub.closeModelHub();
    clearBody();
});

test("模型库 · 预设就绪：取消即断队列，不自动续下一条", async () => {
    resetEnv();
    clearRoutes();
    const downloads = [];
    let prog = { state: "running", total: 1000, done: 100, speed: 100, filename: "qwen_image_bfp.safetensors" };
    mockHub(() => jsonResponse({ download: prog }));
    mockReady();
    mockRoute("/neo_model_hub/download", (body) => {
        downloads.push(body);
        return jsonResponse({ success: true, download: { state: "running" } });
    });
    const overlay = await openHub();
    click(overlay.querySelector(".neo-hub-ready-toggle"));
    await sleep(60);
    click(overlay.querySelector(".neo-hub-ready-skill"));
    await sleep(60);

    click(overlay.querySelector(".neo-hub-ready-all"));
    await sleep(60);
    click(overlay.querySelector(".neo-hub-cancel"));
    await sleep(60);
    prog = { state: "paused", total: 1000, done: 100, speed: 0, error: "已取消（断点保留）" };
    await sleep(200);
    assert.equal(downloads.length, 1, "取消后不应自动续下一条");
    assert.equal(overlay.querySelector(".neo-hub-status").textContent, "已取消（断点保留）", "断点提示不符");
    hub.closeModelHub();
    clearBody();
});

/** 就绪接口桩：总览固定，计划按请求体回显当前源与可选项口径（HF 源标成缺 Token）。 */
function mockReady() {
    mockRoute("/neo_skill_models/all", () => jsonResponse(READY_ALL));
    mockRoute("/neo_skill_models/plan", (body) => {
        const gated = body.source === "huggingface";
        return jsonResponse({
            success: true,
            plan: {
                ...READY_PLAN, source: body.source, include_optional: body.include_optional,
                source_label: gated ? "HF" : "MS", needs_token: gated, has_token: !gated,
            },
        });
    });
}

