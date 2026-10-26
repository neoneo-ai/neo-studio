// 主画布离线闸门（canvas-lock.js）：ComfyUI 掉线锁画布、恢复解锁、WS 抖动不误锁、不抢用户的锁定
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearBody, mockRoute, jsonResponse, flush, sleep, resetEnv } from "./setup.mjs";
import { app, resetAppState, getExtension } from "./mocks/comfy-app.mjs";
import { dispatchApiEvent, resetApiState, listenerCount } from "./mocks/comfy-api.mjs";
import { setLang } from "../../web/js/core/i18n.js";

const DEAD = () => jsonResponse({ offline: true }, 503);
const ALIVE = () => jsonResponse({ system: { comptime: 0 } });

// 模块级状态（offline / 复探定时器）跨用例串味：每个用例取一份新实例
async function fresh(id) {
    resetEnv();
    resetAppState();
    resetApiState();
    clearBody();
    app.canvas = { read_only: false };
    await import(`../../web/canvas-lock.js?case=${id}`);
    const ext = getExtension("comfy.neo.canvasLock");
    ext.setup();
    return ext;
}

const banner = () => document.getElementById("neo-canvas-offline");

beforeEach(() => setLang("zh"));

test("注册离线闸门扩展并注入横幅样式", async () => {
    const ext = await fresh("register");
    assert.ok(ext, "扩展 comfy.neo.canvasLock 未注册");
    assert.ok(document.getElementById("neo-canvas-offline-style"), "横幅样式未注入");
    assert.equal(listenerCount("status"), 1, "status 监听应只挂一份");
    assert.equal(listenerCount("reconnecting"), 1, "reconnecting 监听应只挂一份");
    assert.equal(listenerCount("reconnected"), 1, "reconnected 监听应只挂一份");
    assert.equal(banner(), null, "未掉线时不该有横幅");
    assert.equal(app.canvas.read_only, false, "未掉线时不该锁画布");
});

test("socket 断开且 HTTP 不可达：锁画布并出横幅", async () => {
    const ext = await fresh("lock");
    mockRoute("/system_stats", DEAD);
    dispatchApiEvent("reconnecting");
    await flush();
    assert.equal(app.canvas.read_only, true, "ComfyUI 掉线后画布应锁上");
    assert.match(banner()?.textContent ?? "", /ComfyUI 未运行/);
    // 轮询探活的 status(null) 同样走确认路径，不重复锁
    dispatchApiEvent("status", null);
    await flush();
    assert.equal(app.canvas.read_only, true);
});

test("WS 抖动但 HTTP 答话：不误锁", async () => {
    const ext = await fresh("blip");
    mockRoute("/system_stats", ALIVE);
    dispatchApiEvent("reconnecting");
    dispatchApiEvent("status", null);
    await flush();
    assert.equal(app.canvas.read_only, false, "HTTP 还答话时不该锁画布");
    assert.equal(banner(), null, "不该出横幅");
});

test("恢复：解锁、撤横幅、停复探", async () => {
    const ext = await fresh("recover");
    mockRoute("/system_stats", DEAD);
    dispatchApiEvent("reconnecting");
    await flush();
    assert.equal(app.canvas.read_only, true);
    mockRoute("/system_stats", ALIVE);
    dispatchApiEvent("reconnected");
    assert.equal(app.canvas.read_only, false, "reconnected 后应解锁");
    assert.equal(banner(), null, "横幅应撤掉");
});

test("离线期间复探自动解锁（reconnected 不来也能恢复）", async () => {
    const ext = await fresh("retry");
    mockRoute("/system_stats", DEAD);
    dispatchApiEvent("status", null);
    await flush();
    assert.equal(app.canvas.read_only, true);
    mockRoute("/system_stats", ALIVE);
    await sleep(60);   // 复探间隔被测试环境压到 40ms
    assert.equal(app.canvas.read_only, false, "复探成功后应解锁");
    assert.equal(banner(), null);
});

test("用户自己锁的画布：解锁后还原锁定，不抢用户的锁定", async () => {
    const ext = await fresh("userLock");
    app.canvas.read_only = true;   // 用户自己按了 Comfy.Canvas.Lock
    mockRoute("/system_stats", DEAD);
    dispatchApiEvent("reconnecting");
    await flush();
    assert.equal(app.canvas.read_only, true);
    mockRoute("/system_stats", ALIVE);
    dispatchApiEvent("reconnected");
    assert.equal(app.canvas.read_only, true, "恢复后仍是用户自己的锁定");
});

test("横幅文案跟随界面语言", async () => {
    const ext = await fresh("lang");
    setLang("en");
    mockRoute("/system_stats", DEAD);
    dispatchApiEvent("reconnecting");
    await flush();
    assert.equal(banner()?.textContent, "ComfyUI is not running · canvas is read-only");
});
