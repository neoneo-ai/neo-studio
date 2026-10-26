// 桌面端 Studio 的界面语言：设置页「界面语言」栏（即选即落盘并整页刷新）+ 顶栏静态壳按当前语言重画。
// 桌面端页面自有文案（顶栏 / 导演面板 / 启动设置 / 状态位）走 t()；素材 / 技能 / 各设置表单是共享模块，保持原文。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, mockRoute, jsonResponse, click, fire } from "./setup.mjs";
import { setLang } from "../../web/js/core/i18n.js";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

const LANG_KEY = "neo_studio_lang";
let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?lang=${seq++}`);

function mountStudio() {
    resetEnv();
    localStorage.removeItem(LANG_KEY);
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
    }));
}

// jsdom 的 location.reload 不可重定义（且真导航会炸），整块换成桩：刷新动作可观测
function stubReload() {
    const reloads = [];
    const realLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", {
        value: { hash: "#/settings", reload: () => reloads.push(1) },
        configurable: true, writable: true,
    });
    return { reloads, restore: () => Object.defineProperty(globalThis, "location", { value: realLocation, configurable: true, writable: true }) };
}

async function openSettings() {
    window.location.hash = "#/settings";
    await importApp();
    await flush();
}

test("中文基线：设置页有「界面语言」栏，当前语言选中", async () => {
    setLang("zh");
    mountStudio();
    await openSettings();

    const tab = document.querySelector('.ns-settings-tab[data-key="lang"]');
    assert.ok(tab, "设置页应有「界面语言」tab");
    assert.equal(tab.textContent, "界面语言");
    click(tab);
    await flush();

    const rows = [...document.querySelectorAll(".ns-lang .ns-lang-row input")];
    assert.deepEqual(rows.map((r) => r.value), ["zh", "en"]);
    assert.equal(rows.find((r) => r.checked)?.value, "zh", "当前语言应选中");
});

test("选 English：落盘 localStorage 并整页刷新", async () => {
    setLang("zh");
    mountStudio();
    await openSettings();
    click(document.querySelector('.ns-settings-tab[data-key="lang"]'));
    await flush();

    const { reloads, restore } = stubReload();
    try {
        const en = document.querySelector('.ns-lang input[value="en"]');
        en.checked = true;
        fire(en, "change");
        await flush();
        assert.deepEqual(reloads, [1], "选语言应整页刷新");
        assert.equal(localStorage.getItem(LANG_KEY), "en", "语言应落盘");
    } finally {
        restore();
    }
});

test("英文模式：顶栏静态壳、设置页 tab、语言提示都出英文", async () => {
    mountStudio();
    setLang("en");
    await openSettings();

    assert.equal(document.title, "Neo Studio", "窗口标题应换英文");
    assert.deepEqual([...document.querySelectorAll(".ns-tabs a")].map((a) => a.textContent),
        ["Home", "Assets", "Paint", "Director", "Skills", "Settings"]);
    assert.equal(document.querySelector(".ns-logo").textContent, "Neo Studio");
    assert.equal(document.querySelector(".ns-logo").title, "Back to home");
    assert.equal(document.querySelector('.ns-settings-tab[data-key="lang"]').textContent, "Language");
    assert.equal(document.querySelector('.ns-settings-tab[data-key="about"]').textContent, "About");

    click(document.querySelector('.ns-settings-tab[data-key="lang"]'));
    await flush();
    assert.equal(document.querySelector(".ns-lang-hint").textContent,
        "Picking a language saves it and reloads the page, rebuilding the interface in the new language.");
    // 语言栏的选项名是语言本名，不随界面语言翻译
    assert.deepEqual([...document.querySelectorAll(".ns-lang .ns-lang-row span")].map((s) => s.textContent),
        ["中文", "English"]);
});

test("英文模式：启动设置面板的标签、按钮、状态行出英文", async () => {
    mountStudio();
    setLang("en");
    window.pywebview = {
        api: {
            launcher_state: async () => ({
                root: "D:/ComfyUI", python: "D:/py/python.exe", port: 8188, state: "ok", error: "",
            }),
        },
    };
    await openSettings();

    const labels = [...document.querySelectorAll(".ns-launch-label")].map((e) => e.firstChild.textContent.trim());
    assert.ok(labels.includes("ComfyUI root folder"), `根目录标签应换英文（实际 ${labels.join(" / ")}）`);
    assert.ok(labels.includes("Port") && labels.includes("LAN listening"));
    assert.equal(document.querySelector(".ns-launch-apply").textContent, "Save & restart ComfyUI");
    assert.equal(document.querySelector(".ns-kernel-start").textContent, "▶ Start kernel");
    assert.equal(document.querySelector(".ns-launch-status").textContent, "Ready");
    assert.match(document.querySelector(".ns-launch-info").textContent, /^Localhost only: http:\/\/127\.0\.0\.1:8188\/neo-studio$/);
    assert.match(document.querySelectorAll(".ns-launch-info")[1].textContent, /in-plugin mode/);
});

test("中文模式：语言栏与启动设置保持原文", async () => {
    setLang("zh");
    mountStudio();
    window.pywebview = {
        api: { launcher_state: async () => ({ root: "D:/ComfyUI", python: "p", port: 8188, state: "ok", error: "" }) },
    };
    await openSettings();

    assert.equal(document.querySelector(".ns-launch-apply").textContent, "保存并重启 ComfyUI");
    assert.equal(document.querySelector(".ns-launch-status").textContent, "就绪");
    click(document.querySelector('.ns-settings-tab[data-key="lang"]'));
    await flush();
    assert.equal(document.querySelector(".ns-lang-hint").textContent,
        "选择后立即落盘并整页刷新，界面文案按新语言重建。");
});
