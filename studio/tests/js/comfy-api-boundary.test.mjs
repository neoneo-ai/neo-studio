// 前端导入契约（issue #12）：ComfyUI 前端把 `scripts/ui.js` 标为废弃的 legacy 入口，插件导入它
// 会在浏览器控制台打出 deprecation 警告；$el 一律从官方入口 window.comfyAPI.ui 取。
// 独立 Studio 页面没有 ComfyUI 文档，window.comfyAPI 由 studio/shim/comfy-api.js 装配，
// 装配必须排在页面第一个模块之前——模块顶层读不到值就是整页白屏。
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));
const INDEX_HTML = fileURLToPath(new URL("../../web/studio/index.html", import.meta.url));

const LEGACY_UI_IMPORT = /from\s+["'][^"']*scripts\/ui\.js["']/;

function jsModules(dir, found = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) jsModules(full, found);
        else if (entry.name.endsWith(".js")) found.push(full);
    }
    return found;
}

test("studio/web 没有任何模块导入废弃的 scripts/ui.js", () => {
    const offenders = jsModules(WEB_ROOT)
        .filter((f) => LEGACY_UI_IMPORT.test(readFileSync(f, "utf8")))
        .map((f) => f.slice(WEB_ROOT.length + 1).replace(/\\/g, "/"));
    assert.deepEqual(offenders, []);
});

test("独立页面在第一个模块之前装配 window.comfyAPI", () => {
    const html = readFileSync(INDEX_HTML, "utf8");
    const shimAt = html.indexOf("shim/comfy-api.js");
    const appAt = html.indexOf("studio/studio-app.js");
    assert.ok(shimAt >= 0, "studio/index.html 缺少 shim/comfy-api.js 装配");
    assert.ok(shimAt < appAt, "shim/comfy-api.js 必须排在 studio-app.js 之前");
});
