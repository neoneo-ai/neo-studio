// Studio 页面配色（js/core/theme.js）：页面只认 <html data-neo-theme> 一个开关，深浅值写进 CSS 令牌。
// 用例钉四条失效现场：跟随系统时系统改配色要实时跟上；非法存档回落跟随系统而不是把界面卡在一个
// 没有 CSS 定义的深浅上；换配色要落盘（下次开机同色）；有桌面端桥时换色要回报（标题栏跟页面同色）。
// 首帧不闪白靠 index.html <head> 的内联脚本（早于 style.css 执行），jsdom 只取 <body>，靠手工验收。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, flush, click } from "./setup.mjs";
import { t } from "../../web/js/core/i18n.js";

const rootTheme = () => document.documentElement.dataset.neoTheme;
const resolvedTheme = () => document.documentElement.dataset.neoThemeResolved;

// 系统的深浅：jsdom 的 matchMedia 恒为 false（浅色），断言"跟随系统"要把 MediaQueryList 换成可驱动的桩
function stubSystemTheme(dark) {
    const listeners = [];
    const mq = {
        media: "(prefers-color-scheme: dark)",
        _matches: dark,
        get matches() { return mq._matches; },
        set matches(v) { mq._matches = v; },
        addEventListener: (_type, fn) => { listeners.push(fn); },
        removeEventListener: () => {},
        fire: () => listeners.forEach((fn) => fn()),
    };
    window.matchMedia = () => mq;
    return mq;
}

test("首帧配色：存档的选择写进 <html>，没有存档时按系统上色", async () => {
    resetEnv();
    stubSystemTheme(true);
    const { applyTheme, setTheme, getTheme } = await import("../../web/js/core/theme.js?首帧=1");
    assert.equal(getTheme(), "auto", "没有存档的默认选择不是跟随系统");
    applyTheme();
    assert.equal(rootTheme(), "dark", "系统深色时跟随系统没上深色");
    assert.equal(resolvedTheme(), "dark", "生效值标记没落");
    localStorage.setItem("neo_studio_theme", "light");
    applyTheme();
    assert.equal(rootTheme(), "light", "存档的浅色没上屏");
    assert.equal(resolvedTheme(), "light", "生效值标记停在旧值");
    setTheme("dark");
    assert.equal(rootTheme(), "dark", "setTheme 未立刻上色");
    assert.equal(localStorage.getItem("neo_studio_theme"), "dark", "setTheme 未落盘");
});

test("非法存档回落跟随系统：不把界面留在没有 CSS 定义的深浅上", async () => {
    resetEnv();
    stubSystemTheme(true);
    const { getTheme, applyTheme } = await import("../../web/js/core/theme.js?非法=1");
    localStorage.setItem("neo_studio_theme", "sepia");
    assert.equal(getTheme(), "auto", "非法值未回落跟随系统");
    applyTheme();
    assert.equal(rootTheme(), "dark", "非法值落盘后页面按系统上色失败");
    assert.equal(resolvedTheme(), "dark");
});

test("跟随系统：系统改配色实时跟上，存的选择不被改成具体深浅", async () => {
    resetEnv();
    const mq = stubSystemTheme(true);
    const { applyTheme, watchSystemTheme, getTheme } = await import("../../web/js/core/theme.js?跟随=1");
    applyTheme();
    watchSystemTheme();
    assert.equal(rootTheme(), "dark", "系统深色时页面没跟上");
    mq.matches = false;
    mq.fire();
    assert.equal(rootTheme(), "light", "系统切到浅色后页面没跟上");
    assert.equal(resolvedTheme(), "light", "生效值标记没跟着换");
    assert.equal(getTheme(), "auto", "系统配色被写进用户的选择");
    mq.matches = true;
    mq.fire();
    assert.equal(rootTheme(), "dark", "系统切回深色后页面没跟上");
    // 存成具体深浅之后系统变化不再动页面
    const { setTheme } = await import("../../web/js/core/theme.js?跟随=1");
    setTheme("dark");
    mq.matches = false;
    mq.fire();
    assert.equal(rootTheme(), "dark", "存了深色还被系统拉走");
});

test("换配色回报桌面端同步标题栏：有桥就报生效深浅，没桥（浏览器标签页）不抛", async () => {
    resetEnv();
    stubSystemTheme(true);
    const { setTheme } = await import("../../web/js/core/theme.js?桥=1");
    const calls = [];
    window.pywebview = { api: { set_theme: async (v) => { calls.push(v); return { ok: true }; } } };
    setTheme("light");
    await flush();
    assert.deepEqual(calls, ["light"], "换浅色未回报桌面端");
    setTheme("auto");
    await flush();
    assert.deepEqual(calls, ["light", "dark"], "跟随系统时回报的应是生效深浅");
    delete window.pywebview;
    setTheme("light");
    await flush();
    assert.deepEqual(calls, ["light", "dark"], "没有桥时不该有回报");
    assert.equal(document.documentElement.dataset.neoTheme, "light", "没有桥时页面配色也要换");
});

test("设置控件：三个单选加生效值提示，点选立刻上色并落盘", async () => {
    resetEnv();
    stubSystemTheme(true);
    const { initThemeControl, getTheme } = await import("../../web/js/core/theme.js?控件=1");
    const wrap = document.createElement("div");
    document.body.appendChild(wrap);
    const ctl = initThemeControl(t, (key, ...a) => key + (a.length ? ":" + a.join(",") : ""));
    wrap.appendChild(ctl.el);
    const radios = [...wrap.querySelectorAll("input[name=\"ns-theme\"]")];
    assert.deepEqual(radios.map((el) => el.value), ["auto", "light", "dark"], "单选项与配色选项不符");
    assert.ok(radios[0].checked, "默认应选中跟随系统");
    assert.match(wrap.querySelector(".ns-theme-status").textContent, /当前生效/);
    click(radios[1]);
    assert.equal(document.documentElement.dataset.neoTheme, "light", "点浅色未上色");
    assert.equal(localStorage.getItem("neo_studio_theme"), "light", "点选未落盘");
    assert.equal(getTheme(), "light");
    assert.equal(wrap.querySelectorAll("input[name=\"ns-theme\"]").length, 3, "控件被重复装配");
});
