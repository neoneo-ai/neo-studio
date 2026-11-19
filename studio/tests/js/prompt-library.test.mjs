// Studio「提示词库」页（web/prompt-library/prompt-library.js）：卡片网格与封面、筛选、「填入对应页」、
// 设封面与删除那条链，全在 jsdom 里验。列表与封面读侧走 fetch mock，写侧两发认接口交回来的形状；
// 桌面端离线那一发（列表 409 的 {offline:true}）要落在这页上说得清的一句话。
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, click, flush, sleep } from "./setup.mjs";
import { $el } from "../../web/studio/shim/ui.js";

const { createPromptLibraryView, filterPromptCards, cardBadges } =
    await import("../../web/prompt-library/prompt-library.js");
const { promptCoverUrl } = await import("../../web/prompt-service.js");

beforeEach(() => clearRoutes());

const settle = async () => { await flush(20); await sleep(0); await flush(20); };

const ITEMS = [
    { name: "红杯", source: "custom", tags: ["产品", "白底"], _mtime: 300, cover: 111 },
    { name: "古风女孩", source: "presets", tags: ["古风"], _mtime: 200 },
    { name: "video/镜头推进", source: "custom", tags: ["运镜"], _mtime: 100, cover: 222 },
    { name: "整片配方", source: "presets", tags: [], _mtime: 400, isRecipe: true },
];

function mockPromptRoutes() {
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse(ITEMS));
    mockRoute("/rs_prompts/load_prompt", (body) => jsonResponse({ text: `全文:${body.name}` }));
    mockRoute("/rs_prompts/delete_prompt", () => jsonResponse({ status: "success" }));
    mockRoute("/rs_prompts/set_prompt_cover", () => jsonResponse({ status: "success", cover: 999 }));
}

/** 建页并把宿主那几样收进 env：toast / 闸门 / 素材库取用 / 填页各攒一份调用记录 */
async function mounted({ caps = { prompt_library_write: true } } = {}) {
    const host = $el("div");
    document.body.appendChild(host);
    const env = {
        host,
        toasts: [],
        gated: [],
        applied: [],
        picks: [],
        writeOn: caps.prompt_library_write !== false,
        pickCb: null,
        card(name) { return [...host.querySelectorAll(".ns-pl-card")].find((c) => c.dataset.name === name); },
        btn(cardEl, title) { return [...cardEl.querySelectorAll(".ns-pl-btn")].find((b) => b.title === title); },
        useMaterial(item) { env.pickCb?.(item); },
    };
    const build = createPromptLibraryView({
        $el,
        toast: (text) => env.toasts.push(text),
        can: (feature) => (feature === "prompt_library_write" ? env.writeOn : true),
        gateRun: (btn, feature, label) => { if (!env.writeOn) env.gated.push({ btn, feature, label }); },
        openMaterial: (accept, cb) => { env.picks.push(accept); env.pickCb = cb; },
        applyToPage: (mode, text) => env.applied.push({ mode, text }),
    });
    await build(host);
    await settle();
    return env;
}

const cards = (host) => [...host.querySelectorAll(".ns-pl-card")].map((c) => c.dataset.name);
const titles = (host) => [...host.querySelectorAll(".ns-pl-name")].map((e) => e.textContent);

test("封面地址：sidecar 的读取带名字与封面 mtime 那一位", () => {
    assert.equal(promptCoverUrl("红杯", 111), "/rs_prompts/prompt_cover?name=%E7%BA%A2%E6%9D%AF&v=111");
    assert.equal(promptCoverUrl("红杯"), "/rs_prompts/prompt_cover?name=%E7%BA%A2%E6%9D%AF",
        "没有封面 mtime 就不写 v 那一位");
});

test("筛选：池子与来源各筛一发，配方不入池，最新的排前面", () => {
    const all = filterPromptCards(ITEMS).map((it) => it.name);
    assert.deepEqual(all, ["红杯", "古风女孩", "video/镜头推进"], "配方条目不入池，_mtime 大的在前");
    assert.deepEqual(filterPromptCards(ITEMS, { pool: "video" }).map((it) => it.name), ["video/镜头推进"]);
    assert.deepEqual(filterPromptCards(ITEMS, { source: "presets" }).map((it) => it.name), ["古风女孩"]);
    assert.deepEqual(filterPromptCards(ITEMS, { query: "产品" }).map((it) => it.name), ["红杯"], "搜索吃标签");
    assert.deepEqual(filterPromptCards(ITEMS, { query: "镜头" }).map((it) => it.name), ["video/镜头推进"],
        "搜索吃行上那串去池子段的显示名");
    assert.deepEqual(cardBadges(ITEMS[0]), ["自定义", "图像"]);
    assert.deepEqual(cardBadges(ITEMS[2]), ["自定义", "视频"]);
});

test("卡片网格：有封面落 <img>（带 v= 换缓存），没封面落文本位", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    assert.deepEqual(titles(env.host), ["红杯", "古风女孩", "镜头推进"], "行上只去 video/ 池子段");
    const cover = env.card("红杯").querySelector(".ns-pl-cover");
    assert.ok(cover, "有封面的卡片铺封面图");
    assert.match(cover.getAttribute("src"), /name=%E7%BA%A2%E6%9D%AF&v=111$/);
    assert.equal(cover.getAttribute("loading"), "lazy", "整池卡片一次进来，封面按视野逐张取");
    assert.ok(env.card("古风女孩").querySelector(".ns-pl-media.is-text"), "没有封面的卡片落正文摘要位");
    assert.equal(env.card("古风女孩").querySelector(".ns-pl-cover"), null);
    assert.equal(env.host.querySelector(".ns-pl-count").textContent, "3 条");
});

test("填入对应页：读那条全文再交装配层那条现成链（绘画页 / 视频页）", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    click(env.btn(env.card("红杯"), "填入绘画页"));
    await settle();
    click(env.btn(env.card("video/镜头推进"), "填入视频页"));
    await settle();
    assert.deepEqual(env.applied, [
        { mode: "paint", text: "全文:红杯" },
        { mode: "video", text: "全文:video/镜头推进" },
    ], "填页吃扫描名全名，落点由 applyToPage 定");
});

test("预设卡不铺写侧那两枚钮：预设池是代码目录，界面上不给一颗必败的钮", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    const preset = env.card("古风女孩");
    assert.equal(env.btn(preset, "设为封面"), undefined);
    assert.equal(env.btn(preset, "删除"), undefined);
    assert.ok(env.btn(env.card("红杯"), "设为封面"), "自定义提示词才有设封面");
    assert.equal(env.gated.length, 0, "写侧可用时闸门不动这两枚钮");
});

test("设封面：素材库取回来的那张产物交后端，成功后重读列表换封面", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    click(env.btn(env.card("红杯"), "设为封面"));
    await settle();
    assert.deepEqual(env.picks, ["image"], "图像池这一发只收图");
    env.useMaterial([{ filename: "Neo_0001.png", subfolder: "NeoStudio" }]);
    await settle();
    const call = fetchLog.find((c) => c.path === "/rs_prompts/set_prompt_cover");
    assert.equal(call.body.name, "红杯");
    assert.equal(call.body.filename, "Neo_0001.png");
    assert.equal(call.body.subfolder, "NeoStudio");
    assert.ok(env.toasts.includes("已设为提示词封面"));
    assert.ok(fetchLog.filter((c) => c.path === "/rs_prompts/list_prompts").length >= 2,
        "写完重读列表，卡片上的封面才换得过来");
});

test("删除要按两次：第一发只把那一颗钮换成确认删除，第二发才发请求", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    const del = env.btn(env.card("红杯"), "删除");
    click(del);
    await settle();
    assert.equal(fetchLog.some((c) => c.path === "/rs_prompts/delete_prompt"), false,
        "第一发不发删除请求");
    assert.equal(del.textContent, "确认删除");
    click(del);
    await settle();
    assert.ok(fetchLog.some((c) => c.path === "/rs_prompts/delete_prompt" && c.body.name === "红杯"));
    assert.ok(env.toasts.includes("已删除提示词"));
});

test("搜索与池子筛子：卡片网格跟着筛子收，计数跟着走", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    const search = env.host.querySelector(".ns-pl-search");
    search.value = "古风";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.deepEqual(titles(env.host), ["古风女孩"]);
    assert.equal(env.host.querySelector(".ns-pl-count").textContent, "1 条");
    search.value = "没有这个词";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(env.host.querySelector(".ns-pl-note").textContent, "无匹配提示词");
    search.value = "";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    const videoChip = [...env.host.querySelectorAll(".ns-pl-chip")].find((c) => c.textContent === "视频");
    click(videoChip);
    assert.deepEqual(cards(env.host), ["video/镜头推进"]);
    env.useMaterial([]);   // 没有取用落点被点开：不发设封面请求
    assert.equal(fetchLog.some((c) => c.path === "/rs_prompts/set_prompt_cover"), false);
});

test("列表读不回来：离线那一发说「需要 ComfyUI 运行」，不是空库", async () => {
    resetEnv();
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse({ offline: true }, 409));
    const env = await mounted();
    assert.equal(env.host.querySelector(".ns-pl-note").textContent, "提示词列表需要 ComfyUI 运行");
    assert.equal(cards(env.host).length, 0);
});

test("写侧离线：闸门收着那两枚钮，点下去不发请求", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted({ caps: { prompt_library_write: false } });
    const gated = env.gated.find((g) => g.feature === "prompt_library_write");
    assert.equal(env.gated.length, 4, "离线时两条自定义提示词的设封面与删除都交闸门");
    click(gated.btn);
    await settle();
    assert.equal(fetchLog.some((c) => c.path === "/rs_prompts/set_prompt_cover"), false,
        "离线时那一发由闸门接走，不给一条必败的请求");
});

