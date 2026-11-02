// 「设置 → 手机连接」面板：二维码与配对链接的渲染、监听未放开的提示、复制与立即刷新，
// 以及停掉轮询不留后台定时器。数据只来自桌面端服务的 /neo-studio/pair/info。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, mockRoute, clearRoutes, jsonResponse, click, fetchLog } from "./setup.mjs";
import { createPairPanel } from "../../web/js/core/pair-access.js";
import { t, tf } from "../../web/js/core/i18n.js";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];
const pairHtml = fs.readFileSync(path.join(webDir, "studio", "pair.html"), "utf8");

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?pair=${seq++}`);
const api = { fetchApi: (p, opts) => fetch(p, opts) };   // 走 setup 装好的 fetch 桩（window.fetch 是 jsdom 自己的）

const OK_INFO = {
    success: true, mode: "lan", lan_open: true, port: 43130,
    host: "192.168.0.165", token: "Tqk3AbCdEfGhIjKlMnOpQ",
    url: "http://192.168.0.165:43130/neo-studio/pair?token=Tqk3AbCdEfGhIjKlMnOpQ",
    seconds_left: 293, ttl_seconds: 300,
};

function mountPanel(info) {
    resetEnv();
    document.body.innerHTML = "";
    const toasts = [];
    mockRoute("/neo-studio/pair/info", jsonResponse(info));
    const panel = createPairPanel({ api, t, tf, toast: (m) => toasts.push(m) });
    document.body.appendChild(panel.el);
    return { panel, toasts };
}

test("出码：二维码 SVG、配对链接与剩余秒数一起上屏", async () => {
    const { panel } = mountPanel(OK_INFO);
    panel.refresh();
    await flush(6);
    const svg = panel.el.querySelector(".ns-pair-qr svg");
    assert.ok(svg, "二维码要画成内联 SVG");
    assert.match(svg.getAttribute("viewBox"), /^0 0 \d+ \d+$/, "SVG 用模块坐标 + 静区边长");
    const url = panel.el.querySelector(".ns-pair-url");
    assert.equal(url.value, OK_INFO.url);
    assert.equal(panel.el.querySelector(".ns-pair-row").hidden, false);
    assert.equal(panel.el.querySelector(".ns-pair-refresh").hidden, false);
    assert.match(panel.el.querySelector(".ns-pair-status").textContent, /293/);
    panel.stop();
});

test("监听未放开：不摆二维码，直接说明去哪一项放开", async () => {
    const { panel } = mountPanel({ ...OK_INFO, lan_open: false });
    panel.refresh();
    await flush(6);
    assert.equal(panel.el.querySelector(".ns-pair-qr").innerHTML, "");
    assert.equal(panel.el.querySelector(".ns-pair-url").value, "");
    assert.equal(panel.el.querySelector(".ns-pair-row").hidden, true, "没有可复制的链接就不摆复制框");
    assert.equal(panel.el.querySelector(".ns-pair-refresh").hidden, true, "监听没放开时刷新点了也不会通");
    assert.match(panel.el.querySelector(".ns-pair-status").textContent, /局域网监听/);
    panel.stop();
});

test("桌面端服务读不到：说清只在桌面端窗口里可用", async () => {
    const { panel } = mountPanel({ success: false });
    panel.refresh();
    await flush(6);
    assert.match(panel.el.querySelector(".ns-pair-status").textContent, /桌面端/);
    assert.equal(panel.el.querySelector(".ns-pair-row").hidden, true);
    assert.equal(panel.el.querySelector(".ns-pair-refresh").hidden, true);
    panel.stop();
});

test("监听放开但还没有局域网地址：留刷新按钮，收掉链接框", async () => {
    const { panel } = mountPanel({ ...OK_INFO, url: "" });
    panel.refresh();
    await flush(6);
    assert.equal(panel.el.querySelector(".ns-pair-qr").innerHTML, "");
    assert.equal(panel.el.querySelector(".ns-pair-row").hidden, true);
    assert.equal(panel.el.querySelector(".ns-pair-refresh").hidden, false, "这一状态就是靠刷新出码的");
    assert.match(panel.el.querySelector(".ns-pair-status").textContent, /立即刷新二维码/);
    panel.stop();
});

test("复制：写进剪贴板的是二维码里那条配对链接", async () => {
    const written = [];
    Object.defineProperty(window.navigator, "clipboard", {
        configurable: true, value: { writeText: async (text) => { written.push(text); } },
    });
    const { panel, toasts } = mountPanel(OK_INFO);
    panel.refresh();
    await flush(6);
    click(panel.el.querySelector(".ns-pair-row button"));
    await flush(3);
    assert.deepEqual(written, [OK_INFO.url]);
    assert.match(toasts.join("|"), /已复制/);
    panel.stop();
});

test("立即刷新：走桌面端的 pair_rotate 动作并重开倒计时", async () => {
    const { panel } = mountPanel(OK_INFO);
    mockRoute("/neo_studio/launcher", jsonResponse({ ok: true, token: "x", seconds_left: 300 }));
    panel.refresh();
    await flush(6);
    click(panel.el.querySelector(".ns-pair-refresh"));
    await flush(14);   // 刷新动作后面还跟着一次重读信息，链路要走完
    const body = fetchLog.filter((f) => f.path === "/neo_studio/launcher").map((f) => f.body);
    assert.ok(body.length, "要点一次桌面端动作");
    const sent = body[body.length - 1];
    assert.equal((typeof sent === "string" ? JSON.parse(sent) : sent).action, "pair_rotate");
    panel.stop();
});

test("切走 tab：停掉轮询，不留后台定时器", async () => {
    const { panel } = mountPanel(OK_INFO);
    panel.refresh();
    await flush(6);
    panel.stop();
    const before = fetchLog.filter((f) => f.path === "/neo-studio/pair/info").length;
    await flush(40);
    const after = fetchLog.filter((f) => f.path === "/neo-studio/pair/info").length;
    assert.equal(after, before, "停掉之后不能再有轮询");
});

test("样式表里 native hidden 真能收起控件：author 的 display 规则不能压过它", async () => {
    const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
    const { panel } = mountPanel({ ...OK_INFO, lan_open: false });
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    panel.refresh();
    await flush(6);
    assert.equal(getComputedStyle(panel.el.querySelector(".ns-pair-row")).display, "none",
                 "链接行收起后浏览器里要真的不可见");
    assert.equal(getComputedStyle(panel.el.querySelector(".ns-pair-refresh")).display, "none");
    panel.renderInfo(OK_INFO);
    assert.equal(getComputedStyle(panel.el.querySelector(".ns-pair-row")).display, "flex",
                 "可用状态要把链接行放回来");
    panel.stop();
});

test("配对页：把令牌交给 pair/check 验，成功后给出 Studio 入口", () => {
    assert.match(pairHtml, /\/neo-studio\/pair\/check\?token=/);
    assert.match(pairHtml, /进入 Neo Studio|Open Neo Studio/);
    assert.match(pairHtml, /二维码已过期|has expired/);
});

// 整页装配：手机连接要作为设置页的一栏出现，点开设到二维码
async function openSettings() {
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
    }));
    mockRoute("/neo-studio/pair/info", jsonResponse(OK_INFO));
    window.location.hash = "#/settings";
    await importApp();
    await flush();
}

test("设置页有「手机连接」栏，点开就是二维码与配对链接", async () => {
    resetEnv();
    document.body.innerHTML = studioBody;
    await openSettings();

    const tab = document.querySelector('.ns-settings-tab[data-key="pair"]');
    assert.ok(tab, "设置页应有「手机连接」tab");
    assert.equal(tab.textContent, "手机连接");
    click(tab);
    await flush(6);

    const section = document.querySelector(".ns-pair-section");
    assert.equal(section.style.display, "", "点开这栏要显示出来");
    assert.ok(section.querySelector(".ns-pair-qr svg"), "栏里要画二维码");
    assert.equal(section.querySelector(".ns-pair-url").value, OK_INFO.url);
});
