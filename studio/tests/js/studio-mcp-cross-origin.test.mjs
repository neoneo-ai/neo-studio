// MCP 族跨源回桌面端：局域网监听 / 附着那路整页跳到 ComfyUI 端口时，桌面端把自己的 origin
// 挂在 ?neo_desktop= 上（app/studio_app.py 的 studio_target）。route.js 在模块加载时读这个
// 参数，所以每条用例都要 pushState 之后用新的查询串重新 import 一份，别让上一条的 URL 串进来。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv } from "./setup.mjs";

const DESKTOP = "http://127.0.0.1:8191";
let seq = 0;

async function resolveAt(search, path) {
    window.history.pushState(null, "", `/${search}`);
    const { resolve } = await import(`../../web/studio/shim/route.js?neo=${seq++}`);
    return resolve(path);
}

test("带桌面端标记：MCP 族打回桌面端口，其余路径照旧同源", async () => {
    resetEnv();
    const search = `?neo_desktop=${encodeURIComponent(DESKTOP)}`;
    assert.equal(await resolveAt(search, "/neo_mcp/servers"), `${DESKTOP}/neo_mcp/servers`);
    assert.equal(await resolveAt(search, "/neo_mcp/tools/call"), `${DESKTOP}/neo_mcp/tools/call`);
    assert.equal(await resolveAt(search, "/neo_gallery/list"), "/neo_gallery/list",
        "只有 MCP 这一族跨源，素材库这类桌面端归属的路由还在页面自己的 origin 上");
});

test("没有标记 / 标记不是本机回环：MCP 族留在同源", async () => {
    resetEnv();
    assert.equal(await resolveAt("", "/neo_mcp/servers"), "/neo_mcp/servers");
    assert.equal(await resolveAt("?neo_desktop=http%3A%2F%2Fevil.example%3A8191", "/neo_mcp/servers"),
        "/neo_mcp/servers", "只认本机回环的 origin，外部站点写在 URL 上也不跟");
});
