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

