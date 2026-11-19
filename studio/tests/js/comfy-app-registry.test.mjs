// 注册口径（ComfyUI 画布页侧栏与顶栏整片消失的那次故障）：官方前端把 app 单体装在 comfyAPI.app.app，
// 装到那一句要等 app chunk 整个跑完，而 comfyAPI 是逐键增量装配的。`import { app } from
// "scripts/app.js"` 是那份 shim 求值那一刻的一次性快照，装配晚到就是永久 undefined，顶层
// app.registerExtension(...) 当场抛，整条模块图标成失败。注册因此走 comfy-app.js 的调用时刻取值。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));
const core = await import(new URL("../../web/js/core/comfy-app.js", import.meta.url).href + "?case=1");

function jsModules(dir, found = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) jsModules(full, found);
        else if (entry.name.endsWith(".js")) found.push(full);
    }
    return found;
}
const rel = (f) => f.slice(WEB_ROOT.length + 1).replace(/\\/g, "/");
// 一个模块到 web/ 顶层的目录深度：gallery.js 是 0，skill/skill-core.js 是 1
const depth = (f) => rel(f).split("/").length - 1;

const TOP_LEVEL_REGISTER = /(^|\r?\n)[ \t]*app\.registerExtension\(/;
const FRONTEND_IMPORT = /from\s+["'](\.[^"']*)["']/g;
const FRONTEND_UPS = /(^|\/)scripts\/(app|api)\.js$/;
// 整行注释与字符串里的文件名不算导入（prompts.js 的注释里就写着一份）。
const strip = (s) => s
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'[^'\n]*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");

/** 驱动 registerExtension 的等待循环：只跑它自己排的轮询，用例里不跑真计时器。 */
function drive(register, times, onTake) {
    const real = globalThis.setTimeout;
    const queue = [];
    globalThis.setTimeout = (fn) => { queue.push(fn); return 0; };
    const take = () => queue.splice(0, queue.length).forEach((fn) => fn());
    try {
        register();
        for (let i = 0; i < times; i += 1) { take(); onTake?.(i); }
    } finally {
        globalThis.setTimeout = real;
    }
    return queue.length;
}

test("web/ 没有任何模块在顶层调 app.registerExtension", () => {
    const offenders = jsModules(WEB_ROOT)
        .filter((f) => TOP_LEVEL_REGISTER.test(readFileSync(f, "utf8")))
        .map(rel);
    assert.deepEqual(offenders, [],
        "顶层注册读的是 import 求值那一刻的一次性快照：app 没装到就是当场抛，整条模块图一起没");
});

// 扩展文件在浏览器里的地址是 /extensions/<模块>/<web 内的相对路径>，而 scripts/ 在前端顶层：
// 到顶层要的 ../ 层数 = web 内目录深度 + /extensions/<模块>/ 这两段。../ 走到根就截断，多写不伤，
// 少写一层不会报错，只会静默解析出 /extensions/.../scripts/app.js——那条 404 让整条模块图失败。
test("scripts/app.js 与 scripts/api.js 的导入解析到前端顶层的 /scripts/", () => {
    const offenders = [];
    for (const f of jsModules(WEB_ROOT)) {
        const src = strip(readFileSync(f, "utf8"));
        for (const imp of src.matchAll(FRONTEND_IMPORT)) {
            if (!FRONTEND_UPS.test(imp[1])) continue;
            const ups = (imp[1].match(/\.\.\//g) || []).length;
            const needed = depth(f) + 2;   // web 内的目录深度 + /extensions/<模块>/ 这两段
            if (ups < needed) offenders.push(`${rel(f)} → ${imp[1]}：../ 只有 ${ups} 层，${needed} 层才到前端顶层`);

        }
    }
    assert.deepEqual(offenders, [], "../ 少写时浏览器按页面地址解析出 /extensions/.../scripts/app.js，那条 404 让整条模块图失败");
});

test("app 装配晚到：注册等它落地，落地后不留定时器", async () => {
    await import("./setup.mjs");
    delete window.comfyAPI;
    const installed = [];
    const left = drive(
        () => core.registerExtension({ name: "test.late" }),
        3,
        (i) => { if (i === 1) window.comfyAPI = { app: { app: { registerExtension: (e) => installed.push(e) } } }; },
    );
    assert.deepEqual(installed.map((e) => e.name), ["test.late"], "装配落地那一刻要把注册补上");
    assert.equal(left, 0, "注册落地后不许留轮询定时器");
});

test("app 始终没装配：等满上限就停并说明入口不可用", async () => {
    await import("./setup.mjs");
    delete window.comfyAPI;
    const warns = [];
    const realWarn = console.warn;
    console.warn = (m) => warns.push(String(m));
    let left = 0;
    try { left = drive(() => core.registerExtension({ name: "test.dead" }), 60); }
    finally { console.warn = realWarn; }
    assert.equal(warns.length, 1, "等满上限要有一次说明，不是静默不注册");
    assert.match(warns[0], /test\.dead/);
    assert.equal(left, 0, "到上限就停，不留无限轮询");
});

test("门面 extensionManager 没有 registerExtension：不算注册完成，继续等下一次装配", async () => {
    await import("./setup.mjs");
    window.comfyAPI = { app: { app: { extensionManager: { sidebarTab: {}, toast: {}, registerSidebarTab() {} } } } };
    const left = drive(() => core.registerExtension({ name: "test.facade" }), 2);
    assert.equal(left, 1, "没把注册收下去就继续轮询，不许静默当成功");
});


// 越界的另一半：ComfyUI 的扩展加载器把 web/ 下每个 .js 都列进扩展表，
// studio/shim/comfy-api.js 顶层那句无条件赋值在画布页执行就是把官方装配整份换掉——
// comfyAPI.app.app 从此是 undefined，每个插件顶层的注册一起抛。这一发只许发生在独立页上
// （`#ns-view` 在场），所以扫整棵 web/，不在守卫之后的赋值一律算越界。
test("web/ 顶层不许整份重写 window.comfyAPI（独立页守卫装配除外）", () => {
    const offenders = [];
    for (const file of jsModules(WEB_ROOT)) {
        const src = strip(readFileSync(file, "utf8"));
        const at = src.search(/(?<!window\.)comfyAPI\s*=(?!=)/);
        if (at < 0) continue;
        if (src.slice(Math.max(0, at - 200), at).includes("ns-view")) continue;
        offenders.push(file.slice(WEB_ROOT.length + 1).replace(/\\/g, "/"));
    }
    assert.deepEqual(offenders, []);
});


test("官方形状与独立页 shim 形状都走同步注册：扩展收下列表就不轮询", async () => {
    await import("./setup.mjs");
    const list = [];
    window.comfyAPI = { app: { app: { extensionManager: { extensions: list, registerExtension: (e) => list.push(e) } } } };
    const left = drive(() => core.registerExtension({ name: "test.official" }), 1);
    assert.deepEqual(list.map((e) => e.name), ["test.official"]);
    assert.equal(left, 0, "注册成功不留轮询");

    const shimInstalled = [];
    window.comfyAPI = { app: { registerExtension: (e) => shimInstalled.push(e) } };   // shim/app.js 的形状
    drive(() => core.registerExtension({ name: "test.shim" }), 0);
    assert.deepEqual(shimInstalled.map((e) => e.name), ["test.shim"], "app 本体装在 comfyAPI.app 上也要能注册");
});

test("registerExtension 是吞调用的空壳：以扩展列表收下为准", async () => {
    await import("./setup.mjs");
    const list = [];
    window.comfyAPI = { app: { app: { extensionManager: { extensions: list, registerExtension: () => {} } } } };
    const left = drive(() => core.registerExtension({ name: "test.shell" }), 2);
    assert.equal(list.length, 0, "空壳没收下扩展");
    assert.equal(left, 1, "列表里没有就是没注册成功，继续等");
});


