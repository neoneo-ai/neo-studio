// Neo Studio 离线模式（桌面端服务）：能力门控 —— 文件类功能照常，生成类不发假请求。
// 桌面端对 COMFY_ONLY 接口回 409 {offline:true}，Studio 必须提示并引导启动 ComfyUI。
import test from "node:test";
import assert from "node:assert/strict";
import { mockRoute, jsonResponse, sleep, click, flush, fetchLog, resetEnv } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

const wsInstances = [];
globalThis.WebSocket = class {
    constructor(url) { wsInstances.push(this); this.url = url; this.onopen = null; this.onmessage = null; this.onclose = null; }
    close() {}
};

const studioBody = `<div class="ns-header"></div><div id="ns-view"></div><span class="ns-comfy-status" id="ns-comfy-status" hidden></span>`;

const OFFLINE_CAPS = {
    image_gen: false, storyboard: false, voice: false, segment: false,
    director: false, grid_split: true, memory: false, repair: false,
};

function mockOfflineDesktop() {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "ComfyUI 未运行",
        offline: true, caps: OFFLINE_CAPS, recipes: [],
    }));
    mockRoute("/rs_recipes/list", jsonResponse([]));
    mockRoute("/rs_prompts/skills", jsonResponse([]));
    mockRoute("/userdata/neo_recipes_data.json", jsonResponse({}));
    mockRoute("/neo_video_gen/director_progress", jsonResponse({
        active: false, segment_index: -1, total_segments: 0, step: 0, total_steps: 0,
    }));
    mockRoute("/neo_studio/director/generate", jsonResponse(
        { success: false, offline: true, error: "ComfyUI 未运行" }, 409));
    mockRoute("/neo_image_gen/generate", jsonResponse(
        { success: false, offline: true, error: "ComfyUI 未运行" }, 409));
}

function mockDesktopApi(starts) {
    const state = { port: 8188, pid: 0, mine: true, running: false, ready: false };
    window.pywebview = {
        api: {
            comfy_state: async () => ({ ...state }),
            comfy_start: async () => { starts.push(1); state.running = true; return { ...state }; },
        },
    };
    return state;
}

test("离线页带离线标记，不叠横幅", async () => {
    mockOfflineDesktop();
    await import("../../web/studio/studio-app.js?offMark=1");
    await flush();
    assert.ok(document.body.classList.contains("ns-offline"), "桌面端的离线页应带离线标记");
    assert.equal(document.getElementById("ns-offline"), null, "离线页不叠横幅");
    assert.equal(document.getElementById("ns-version"), null, "版本位不在顶栏");
});

test("版本号在设置的「关于」里", async () => {
    mockOfflineDesktop();
    window.pywebview = { api: { launcher_state: async () => ({ ...LAUNCHER_SNAPSHOT }) } };
    window.location.hash = "#/settings";
    await import("../../web/studio/studio-app.js?offAbout=1");
    await flush();
    click(document.querySelector('.ns-settings-tab[data-key="about"]'));
    await flush();
    assert.match(document.getElementById("ns-about-version").textContent, /Neo Studio 9\.9\.9 · 离线模式/);
});

// 「设置 → 关于」的路径行：值全部来自版本快照（桌面端与内核报同一份键），空值那行不出
const ABOUT_PATHS = {
    data_root: "F:\\neo-data", comfy_local: "F:\\ComfyUI", remote: "http://192.168.0.20:8188",
};

function mockAboutPaths(extra = {}) {
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "ComfyUI 未运行",
        offline: true, caps: OFFLINE_CAPS, recipes: [], ...ABOUT_PATHS, ...extra,
    }));
}

async function openAboutTab(tag) {
    window.location.hash = "#/settings";
    await import(`../../web/studio/studio-app.js?${tag}`);
    await flush();
    click(document.querySelector('.ns-settings-tab[data-key="about"]'));
    await flush();
    return [...document.querySelectorAll("#ns-about-rows .ns-about-row")];
}

// 启动设置面板读不到快照就在 3 秒后摘自己的 tab：不给桥的用例，那个摘除正落在后面用例身上
const LAUNCHER_SNAPSHOT = {
    root: "F:/ComfyUI", python: "F:/ComfyUI/python/python.exe", port: 8188,
    plugin_dir: "F:/ComfyUI/custom_nodes/comfyui-neo-studio",
    state_dir: "F:/neo-data", portable: true, state: "ok", error: "",
};

test("关于页：仓库 / 数据根 / ComfyUI 根 / 远程地址逐行列出，打开与复制都走得通", async () => {
    mockOfflineDesktop();
    mockAboutPaths();
    const viaBridge = [], viaOpen = [], copied = [];
    const rawOpen = window.open;
    Object.defineProperty(navigator, "clipboard", {
        value: { writeText: async (text) => { copied.push(text); } }, configurable: true,
    });
    window.pywebview = {
        api: {
            open_url: async (url) => { viaBridge.push(url); return { ok: true }; },
            launcher_state: async () => ({ ...LAUNCHER_SNAPSHOT }),
        },
    };
    try {
        const rows = await openAboutTab("aboutRows=1");
        assert.equal(rows.length, 4, `仓库 + 数据根 + 本地根 + 远程地址：${rows.map((r) => r.textContent)}`);
        assert.match(rows[1].textContent, /数据目录/);
        assert.equal(rows[1].querySelector(".ns-about-value").textContent, "F:\\neo-data");
        assert.equal(rows[2].querySelector(".ns-about-value").textContent, "F:\\ComfyUI");
        assert.equal(rows[3].querySelector(".ns-about-value").textContent, "http://192.168.0.20:8188");
        assert.ok(rows[0].querySelector(".ns-about-open"), "仓库行要能打开");
        assert.equal(rows[1].querySelector(".ns-about-open"), null, "本地路径行不给打开按钮");

        // 桌面端窗口没有标签页可开：打开交给桥
        click(rows[3].querySelector(".ns-about-open"));
        await flush();
        assert.deepEqual(viaBridge, ["http://192.168.0.20:8188"], "远程地址交给桌面端的桥");

        click(rows[1].querySelector(".ns-about-copy"));
        await flush();
        assert.deepEqual(copied, ["F:\\neo-data"]);
        assert.equal(document.getElementById("ns-toast").textContent, "已复制");

        // 浏览器标签页：没有桥就开新标签
        delete window.pywebview;
        window.open = (url, target) => viaOpen.push([url, target]);
        click(rows[0].querySelector(".ns-about-open"));
        await flush();
        assert.deepEqual(viaOpen, [["https://github.com/neoneo-ai/neo-studio", "_blank"]]);

        Object.defineProperty(navigator, "clipboard", {
            value: { writeText: async () => { throw new Error("NotAllowedError"); } }, configurable: true,
        });
        click(rows[2].querySelector(".ns-about-copy"));
        await flush();
        assert.equal(document.getElementById("ns-toast").textContent, "复制失败");
    } finally {
        window.open = rawOpen;   // 开新标签的桩挂在 window 上，留着会让后面的用例当成已开过标签页
        delete navigator.clipboard;   // 桩挂在全局 navigator 上，留着会让后面的用例当剪贴板可用
    }
});

test("关于页：快照没有路径时只出仓库行", async () => {
    mockOfflineDesktop();
    window.pywebview = { api: { launcher_state: async () => ({ ...LAUNCHER_SNAPSHOT }) } };
    const rows = await openAboutTab("aboutBare=1");
    assert.equal(rows.length, 1, "旧版快照没有路径键，路径行整块不出");
    assert.match(rows[0].textContent, /github\.com/);
});

test("离线导演页：生成按钮不发请求，点一下交给桌面端拉起 ComfyUI", async () => {
    mockOfflineDesktop();
    const starts = [];
    mockDesktopApi(starts);
    window.location.hash = "#/director";
    await import("../../web/studio/studio-app.js?offDirector=1");
    await flush();
    const run = document.querySelector(".ns-gen-run");
    assert.ok(run, "导演页应已挂载");
    assert.match(run.textContent, /需要 ComfyUI/);
    assert.match(run.title, /需要 ComfyUI 执行队列/);

    click(run);
    await flush();
    assert.ok(starts.length >= 1, "点一下应直接拉起 ComfyUI");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_studio/director/generate").length, 0,
                 "离线页不该发整片生成请求");
});

test("桌面端回 409 offline：api shim 广播事件，Studio 提示需要 ComfyUI", async () => {
    mockOfflineDesktop();
    mockDesktopApi([]);
    await import("../../web/studio/studio-app.js?offToast=1");
    const apiMod = await import("../../web/studio/shim/api.js");
    await flush();

    const resp = await apiMod.api.fetchApi("/neo_image_gen/generate", { method: "POST", body: "{}" });
    assert.equal(resp.status, 409);
    await flush();
    const toast = document.getElementById("ns-toast");
    assert.ok(toast, "应出现提示条");
    assert.match(toast.textContent, /需要 ComfyUI/);
    assert.ok(toast.classList.contains("show"));
    await sleep(100);
});

test("共享模块用原生 fetch 撞 409：同样提示需要 ComfyUI", async () => {
    mockOfflineDesktop();
    mockRoute("/neo_video_gen/storyboard_generate", jsonResponse(
        { success: false, offline: true, error: "ComfyUI 未运行" }, 409));
    await import("../../web/studio/studio-app.js?offFetch=1");
    await flush();

    const res = await fetch("/neo_video_gen/storyboard_generate", { method: "POST", body: "{}" });
    assert.equal(res.status, 409);
    await flush();
    assert.match(document.getElementById("ns-toast").textContent, /需要 ComfyUI/);
    await sleep(100);
});

test("离线素材页：「🖼️ 生成素材」不发请求，点一下交给桌面端拉起 ComfyUI", async () => {
    mockOfflineDesktop();
    const starts = [];
    mockDesktopApi(starts);
    document.body.insertAdjacentHTML("beforeend",
        '<button class="neo-gallery-gm-btn" type="button">🖼️ 生成素材</button>');
    await import("../../web/studio/studio-app.js?offGallery=1");
    await flush();

    click(document.querySelector(".neo-gallery-gm-btn"));
    await flush();
    assert.ok(starts.length >= 1, "点生成入口应直接拉起 ComfyUI");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_image_gen/generate").length, 0,
                 "离线页不该发生图请求");
});

test("离线导演页不轮询显存：不出显存块，不发 mem_stats 请求", async () => {
    mockOfflineDesktop();
    window.location.hash = "#/director";
    await import("../../web/studio/studio-app.js?offMem=1");
    await flush();
    await sleep(50);
    assert.equal(document.querySelector(".ns-gen-panel .ns-mem"), null, "离线导演页不应出显存块");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_studio/mem_stats").length, 0,
                 "离线时显存轮询应停掉，不每 3s 撞 409");
});

test("离线配方编辑器：运行按钮交给桌面端启动 ComfyUI，不发运行请求", async () => {
    mockOfflineDesktop();
    const starts = [];
    mockDesktopApi(starts);
    document.body.insertAdjacentHTML("beforeend",
        '<button class="neo-director-regen-run" type="button">生成这一段</button>' +
        '<button class="neo-director-merge-run" type="button">拼回成片</button>');
    await import("../../web/studio/studio-app.js?offRun=1");
    await flush();

    for (const sel of [".neo-director-regen-run", ".neo-director-merge-run"]) {
        click(document.querySelector(sel));
        await flush();
    }
    assert.ok(starts.length >= 1, "运行按钮应交给桌面端拉起 ComfyUI（启动中不重复拉起）");
    for (const p of ["/neo_video_gen/run_segment", "/neo_video_gen/assemble_segments"]) {
        assert.equal(fetchLog.filter((c) => c.path === p).length, 0, `离线不该发 ${p}`);
    }
});

test("离线配方编辑器：编辑类按钮不被门控，逐格生成提示词照常打到桌面端", async () => {
    mockOfflineDesktop();
    mockDesktopApi([]);
    mockRoute("/rs_recipes/director_describe_panel", jsonResponse({ success: true }));
    document.body.insertAdjacentHTML("beforeend",
        '<button class="neo-director-gen-seg-prompts" type="button">📝 逐格生成提示词</button>');
    document.querySelector(".neo-director-gen-seg-prompts").addEventListener("click", () => {
        fetch("/rs_recipes/director_describe_panel", { method: "POST", body: "{}" });
    });
    await import("../../web/studio/studio-app.js?offEdit=1");
    await flush();

    click(document.querySelector(".neo-director-gen-seg-prompts"));
    await flush();
    assert.equal(fetchLog.filter((c) => c.path === "/rs_recipes/director_describe_panel").length, 1,
                 "逐格描述只依赖 8080 LLM：门控不该拦掉");
});

test("启动设置：完整 Studio 页里走桌面端的 js_api 读快照并保存", async () => {
    mockOfflineDesktop();
    // 就绪后桌面端整页跳到 ComfyUI 端口：同源没有 /neo_studio/launcher，快照只能问桌面端
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.33.1", offline: false,
        caps: { image_gen: true, storyboard: true, voice: true, segment: true,
                director: true, grid_split: true, memory: true, repair: true },
        recipes: [],
    }));
    mockRoute("/neo_studio/launcher", jsonResponse({ error: "no such route" }, 404));
    const saved = [];
    window.pywebview = {
        api: {
            comfy_state: async () => ({ port: 8188, pid: 42204, mine: true, running: true, ready: true }),
            launcher_state: async () => ({
                root: "D:/ComfyUI", python: "D:/py/python.exe", port: 8188,
                plugin_dir: "D:/ComfyUI/custom_nodes/comfyui-neo-studio",
                state_dir: "D:/studio/data", portable: true, state: "ok", error: "",
            }),
            apply_launcher: async (root, python, port) => {
                saved.push([root, python, port]);
                return { ok: true, state: "ok" };
            },
        },
    };
    window.location.hash = "#/settings";
    await import("../../web/studio/studio-app.js?offBridge=1");
    await flush();

    const tab = document.querySelector('.ns-settings-tab[data-key="launch"]');
    assert.ok(tab, "跳到 ComfyUI 页之后桌面端窗口仍应有「启动设置」tab");
    click(tab);
    await flush();
    const inputs = [...document.querySelectorAll(".ns-launch-row input")].map(i => i.value);
    assert.deepEqual(inputs.slice(0, 3), ["D:/ComfyUI", "D:/py/python.exe", "8188"], "输入框应填桌面端给的快照");

    click(document.querySelector(".ns-launch-apply"));
    await flush();
    assert.deepEqual(saved, [["D:/ComfyUI", "D:/py/python.exe", "8188"]], "保存应直接交给桌面端的 apply_launcher");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_studio/launcher").length, 0,
                 "桌面端窗口里不该去撞 ComfyUI 的同源路由");
});

test("启动设置：根目录与解释器都带原生选择按钮，选完写回输入框", async () => {

    mockOfflineDesktop();
    mockRoute("/neo_studio/launcher", jsonResponse({
        root: "D:/ComfyUI", python: "D:/ComfyUI/python/python.exe", port: 8188,
        plugin_dir: "D:/ComfyUI/custom_nodes/comfyui-neo-studio",
        state_dir: "D:/ComfyUI/custom_nodes/comfyui-neo-studio/configs",
        portable: true, state: "ok", error: "",
    }));
    const picks = [];
    window.pywebview = {
        api: {
            comfy_state: async () => ({ port: 8188, pid: 0, mine: true, running: false, ready: false }),
            pick_root: async () => { picks.push("root"); return "E:/ComfyUI"; },
            pick_python: async () => { picks.push("py"); return "E:/py/python.exe"; },
        },
    };
    window.location.hash = "#/settings";
    await import("../../web/studio/studio-app.js?offLauncher=1");
    await flush();

    click(document.querySelector('.ns-settings-tab[data-key="launch"]'));
    await flush();
    const rowOf = (label) => [...document.querySelectorAll(".ns-launch-row")]
        .find((r) => r.querySelector(".ns-launch-label")?.textContent.startsWith(label));
    for (const [label, key, value] of [["ComfyUI 根目录", "root", "E:/ComfyUI"], ["Python", "py", "E:/py/python.exe"]]) {
        const row = rowOf(label);
        assert.ok(row, `启动设置应有「${label}」行`);
        const btn = row.querySelector("button");
        assert.ok(btn, `「${label}」行应带「浏览…」按钮`);
        click(btn);
        await flush();
        assert.deepEqual(picks.at(-1), key, `点「${label}」的浏览应调桌面端的 pick_${key}`);
        assert.equal(row.querySelector("input").value, value, "选中的路径应写回输入框");
    }
});

test("离线页点「⤒ 主画布编辑」：不开桌面端根路径的死页，提示需要 ComfyUI", async () => {
    mockOfflineDesktop();
    appState.toasts.length = 0;
    await import("../../web/studio/studio-app.js?offCanvas=1");
    await flush();
    const opened = [];
    window.open = (url) => { opened.push(url); return null; };
    const { openSkillWorkflowInMainUi } = await import("../../web/skill/skill-writeback.js?offCanvas=1");
    openSkillWorkflowInMainUi("image_gen");
    assert.equal(opened.length, 0, "离线页的 \"/\" 是桌面端只读服务，根路径没有画布页");
    assert.match(appState.toasts.at(-1).detail, /该功能需要 ComfyUI/);
});

test("ComfyUI 页里「⤒ 主画布编辑」照常交接：开 /?neo_wf_edit=<id>", async () => {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.33.1", offline: false,
        caps: { image_gen: true, storyboard: true, voice: true, segment: true,
                director: true, grid_split: true, memory: true, repair: true },
        recipes: [],
    }));
    mockRoute("/neo_studio/launcher", jsonResponse({ error: "no such route" }, 404));
    mockRoute("/rs_recipes/list", jsonResponse([]));
    mockRoute("/rs_prompts/skills", jsonResponse([]));
    mockRoute("/userdata/neo_recipes_data.json", jsonResponse({}));
    mockRoute("/neo_video_gen/director_progress", jsonResponse({
        active: false, segment_index: -1, total_segments: 0, step: 0, total_steps: 0,
    }));
    appState.toasts.length = 0;
    await import("../../web/studio/studio-app.js?onCanvas=1");
    await flush();
    assert.ok(!document.body.classList.contains("ns-offline"), "ComfyUI 页不该有离线标记");

    const opened = [];
    window.open = (url) => { opened.push(url); return null; };
    const { openSkillWorkflowInMainUi } = await import("../../web/skill/skill-writeback.js?onCanvas=1");
    openSkillWorkflowInMainUi("image_gen");
    assert.deepEqual(opened, ["/?neo_wf_edit=image_gen"]);
    assert.equal(appState.toasts.length, 0, "就绪页不该出「需要 ComfyUI」提示");
});

