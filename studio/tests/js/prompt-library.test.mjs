// Studio「提示词库」页（web/prompt-library/prompt-library.js）：卡片网格与封面、正文摘要、分页、筛选、
// 「填入对应页」、设封面与删除那条链，全在 jsdom 里验。列表 / 封面 / 摘要三条读侧走 fetch mock，
// 写侧两发认接口交回来的形状；桌面端离线那一发（列表 409 的 {offline:true}）要落在这页上说得清的一句话。
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, click, flush, sleep } from "./setup.mjs";
import { $el } from "../../web/studio/shim/ui.js";

const { createPromptLibraryView, filterPromptCards, cardBadges, pageWindow, agoText, coverSearchTerm,
        cloudPreviewMedia, cardCoverSrc, COVER_SEARCH_CHARS, PAGE_SIZE } =
    await import("../../web/prompt-library/prompt-library.js");
const { promptCoverUrl, cloudPreviewUrl, cloudDirCoverUrl } = await import("../../web/prompt-service.js");

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
    mockRoute("/rs_prompts/prompt_previews", (body) => jsonResponse({
        previews: Object.fromEntries(body.names.map((n) => [n, `摘要:${n}`])),
    }));
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
        terms: [],
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
        openMaterial: (accept, cb, term) => { env.picks.push(accept); env.terms.push(term); env.pickCb = cb; },
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
        "搜索吃带目录段的全名");
    assert.deepEqual(cardBadges(ITEMS[0]), ["自定义", "图像"]);
    assert.deepEqual(cardBadges(ITEMS[2]), ["自定义", "视频"]);
});

test("卡片网格：有封面落 <img>（带 v= 换缓存），没封面不铺封面那一档", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    assert.deepEqual(titles(env.host), ["红杯", "古风女孩", "镜头推进"], "标题只写名字本身，目录段不进标题");
    const cover = env.card("红杯").querySelector(".ns-pl-cover");
    assert.ok(cover, "有封面的卡片铺封面图");
    assert.match(cover.getAttribute("src"), /name=%E7%BA%A2%E6%9D%AF&v=111$/);
    assert.equal(cover.getAttribute("loading"), "lazy", "整池卡片一次进来，封面按视野逐张取");
    assert.equal(env.card("古风女孩").querySelector(".ns-pl-media"), null, "没有封面就不占封面那一档");
    assert.equal(env.card("古风女孩").querySelector(".ns-pl-cover"), null);
    assert.deepEqual([...env.card("红杯").querySelectorAll(".ns-pl-tag")].map((e) => e.textContent),
        ["产品", "白底"], "标签排成 chip，最长三条");
    assert.equal(env.host.querySelector(".ns-pl-count").textContent, "3 条");
});

test("卡片封面取不到：先换一个缓存键重取，第二次仍失败才收掉这一档", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    const cover = env.card("红杯").querySelector(".ns-pl-cover");
    const first = cover.getAttribute("src");
    cover.dispatchEvent(new Event("error"));
    const retry = env.card("红杯").querySelector(".ns-pl-cover").getAttribute("src");
    assert.equal(retry.startsWith(`${first}&r=`), true, "失败那一次就换查询参数，逼浏览器重新取图");
    env.card("红杯").querySelector(".ns-pl-cover").dispatchEvent(new Event("error"));
    assert.equal(env.card("红杯").querySelector(".ns-pl-cover"), null, "重取也失败就收掉封面那一档");
    assert.equal(env.card("红杯").querySelector(".ns-pl-media"), null, "图位一起收掉，卡片不留 150px 空档");
    assert.ok(env.card("红杯").querySelector(".ns-pl-name"), "卡片留下名字与摘要");
});

/** 云端目录里那两条预设：一条带预览键，一条是发布预览之前的旧索引条目 */
const CLOUD_ITEMS = [
    { name: "video/prompts.chat/01_Remotion", source: "presets", tags: [], _mtime: 500, cover: 333,
        media: { filename: "01_Remotion.mp4", subfolder: "Cloud Presets/prompts.chat", type: "video", preview: true } },
    { name: "video/prompts.chat/02_Legacy", source: "presets", tags: [], _mtime: 400, cover: 444,
        media: { filename: "02_Legacy.mp4", subfolder: "Cloud Presets/prompts.chat", type: "video", preview: false } },
];

/** 随包预设池根层那一条：扫描名就是池名，正文旁边没有封面 sidecar，条目带云端目录那张封面 */
const DIR_COVER_ITEM = {
    name: "仙侠玄幻人物", source: "presets", tags: [], _mtime: 600,
    dir_cover: { filename: "01_仙侠.mp4", subfolder: "Cloud Presets/仙侠玄幻人物" },
};

test("预览判定：视频池 + 带预览的云端媒体 + 有封面，缺一就落封面图", () => {
    const media = CLOUD_ITEMS[0].media;
    assert.deepEqual(cloudPreviewMedia(CLOUD_ITEMS[0]), media, "三条都齐就交那一条媒体");
    assert.equal(cloudPreviewMedia(CLOUD_ITEMS[1]), null, "索引条目没有预览键就不铺");
    assert.equal(cloudPreviewMedia({ ...CLOUD_ITEMS[0], media: { ...media, type: "image" } }), null,
        "云端那条是图就不播");
    assert.equal(cloudPreviewMedia({ ...CLOUD_ITEMS[0], name: "prompts.chat/01_Remotion" }), null,
        "图像池的条目不铺视频预览");
    assert.equal(cloudPreviewMedia({ ...CLOUD_ITEMS[0], cover: undefined }), null,
        "没有封面就没有 poster，落回文字卡");
    assert.equal(cloudPreviewMedia({ name: "video/自存的一条", source: "custom", _mtime: 1, cover: 1 }), null,
        "没配上云端媒体的条目不铺预览");
});

test("预览地址：素材库那条媒体路由带 preview=1 那一发", () => {
    const url = cloudPreviewUrl(CLOUD_ITEMS[0].media);
    assert.match(url, /\/neo_gallery\/video\?/);
    assert.match(url, /filename=01_Remotion\.mp4/);
    assert.match(url, /subfolder=Cloud%20Presets%2Fprompts\.chat/);
    assert.match(url, /preview=1$/);
});

test("卡片预览位：<video> 只带 poster 与待挂的 src，进视野那一发才要文件", async () => {
    resetEnv();
    mockPromptRoutes();
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse(CLOUD_ITEMS));
    const env = await mounted();
    const cardEl = env.card("video/prompts.chat/01_Remotion");
    const video = cardEl.querySelector(".ns-pl-preview");
    assert.ok(video, "配上云端预览的卡片铺视频预览位");
    assert.equal(video.tagName, "VIDEO");
    assert.equal(video.muted, true, "预览是静音的：原片的声音留给素材页的灯箱");
    assert.equal(video.loop, true);
    assert.equal(video.playsInline, true);
    assert.equal(video.getAttribute("preload"), "none", "卡片一进来不发媒体");
    assert.match(video.getAttribute("poster"), /name=video%2Fprompts\.chat%2F01_Remotion&v=333$/,
        "poster 用那张封面 sidecar");
    assert.equal(video.getAttribute("src"), null, "src 由视野观察者挂，建卡时不发请求");
    assert.match(video.dataset.src, /preview=1$/, "待挂的地址就是预览那一发");
    const legacy = env.card("video/prompts.chat/02_Legacy");
    assert.equal(legacy.querySelector(".ns-pl-preview"), null, "旧索引条目没有预览就落封面图");
    assert.ok(legacy.querySelector("img.ns-pl-cover"));
});

/** 导入的提示词：正文配置上云端那张真图，旁边那张 sidecar 是排版占位 */
const IMAGE_MEDIA_ITEM = {
    name: "prompts.chat/American Comic", source: "presets", tags: [], _mtime: 700, cover: 777,
    media: { filename: "03_AmericanComic.jpg", subfolder: "Cloud Presets/prompts.chat", type: "image", preview: false },
};

test("卡片图来源：封面 sidecar 优先，随包预设那条拿云端目录封面补图，两样都没有是文字卡", () => {
    assert.match(cardCoverSrc(ITEMS[0]), /\/rs_prompts\/prompt_cover\?name=%E7%BA%A2%E6%9D%AF&v=111$/);
    assert.match(cardCoverSrc(DIR_COVER_ITEM), /\/neo_gallery\/thumbnail\?/,
        "没有 sidecar 封面的预设条目用目录封面那一发");
    assert.equal(cardCoverSrc(ITEMS[1]), null, "没有封面也没有目录封面的条目不铺图位");
    assert.match(cardCoverSrc(IMAGE_MEDIA_ITEM), /\/neo_gallery\/thumbnail\?filename=03_AmericanComic\.jpg/,
        "配上云端真图的条目铺那张图，本机那张排版占位 sidecar 让位");
});

test("卡片铺云端真图：图像媒体走缩略图代理，不建预览位", async () => {
    resetEnv();
    mockPromptRoutes();
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse([...ITEMS, IMAGE_MEDIA_ITEM]));
    const env = await mounted();
    const cardEl = env.card("prompts.chat/American Comic");
    const img = cardEl.querySelector("img.ns-pl-cover");
    assert.ok(img, "图像媒体的条目铺 <img>");
    assert.match(img.getAttribute("src"), /\/neo_gallery\/thumbnail\?/);
    assert.match(img.getAttribute("src"), /subfolder=Cloud\+?Presets%2Fprompts\.chat/);
    assert.equal(img.getAttribute("loading"), "lazy");
    assert.equal(cardEl.querySelector(".ns-pl-preview"), null, "图不建视频位");
});

test("目录封面地址：素材库缩略图代理带目录 subfolder 与 512 那一档尺寸", () => {
    const url = cloudDirCoverUrl(DIR_COVER_ITEM.dir_cover);
    assert.match(url, /\/neo_gallery\/thumbnail\?/);
    assert.match(url, /filename=01_%E4%BB%99%E4%BE%A0\.mp4/);
    assert.match(url, /subfolder=Cloud\+?Presets%2F%E4%BB%99%E4%BE%A0%E7%8E%84%E5%B9%BB%E4%BA%BA%E7%89%A9/);
    assert.match(url, /size=512$/);
});

test("卡片铺目录封面：随包预设没有 sidecar 的那一条补上那张图，有 sidecar 的卡片不变", async () => {
    resetEnv();
    mockPromptRoutes();
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse([...ITEMS, DIR_COVER_ITEM]));
    const env = await mounted();
    const dirCover = env.card("仙侠玄幻人物").querySelector(".ns-pl-cover");
    assert.ok(dirCover, "带 dir_cover 的卡片铺云端目录封面");
    assert.match(dirCover.getAttribute("src"), /\/neo_gallery\/thumbnail\?/);
    assert.equal(dirCover.getAttribute("loading"), "lazy", "目录封面同样按视野逐张取");
    assert.match(env.card("红杯").querySelector(".ns-pl-cover").getAttribute("src"),
        /name=%E7%BA%A2%E6%9D%AF&v=111$/, "sidecar 封面优先，卡片地址不变");
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
    assert.deepEqual(env.terms, ["全文:红杯"], "开窗先把这条的出图搜索词铺进素材库");
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

test("出图搜索词：取正文首行前缀，长度夹在素材库读得到副文件前 500 字里", () => {
    assert.equal(coverSearchTerm("白底产品照，柔光\n第二段不要"), "白底产品照，柔光",
        "旁车首行就是正文的第一行，后面的段落不进搜索词");
    assert.equal(coverSearchTerm("  带空格的正文  "), "带空格的正文", "首行两端空白不进搜索词");
    assert.equal(coverSearchTerm(""), "", "空正文给空词：开窗就是整池素材库");
    assert.equal(coverSearchTerm("长".repeat(COVER_SEARCH_CHARS + 40)).length, COVER_SEARCH_CHARS,
        "整段长正文不进搜索框：副文件读端只吃前 500 字，前缀落得进去才筛得到");
});

test("正文读不到不开窗：空正文那一发落「封面设置失败」的提示，不发素材库取用", async () => {
    resetEnv();
    mockPromptRoutes();
    mockRoute("/rs_prompts/load_prompt", (body) =>
        jsonResponse({ text: body.name === "红杯" ? "   " : `全文:${body.name}` }));
    const env = await mounted();
    click(env.btn(env.card("红杯"), "设为封面"));
    await settle();
    assert.equal(env.picks.length, 0, "空正文不开素材库窗：开出去也筛不到这一条的出图");
    assert.ok(env.toasts.some((s) => s.startsWith("封面设置失败")), "空正文说的是这一句");
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


test("分页：一屏 24 张卡，页码那一排换页就重画网格并滚回顶", async () => {
    resetEnv();
    const many = Array.from({ length: 30 }, (_, i) =>
        ({ name: `提示词${i + 1}`, source: "presets", tags: [], _mtime: 1000 - i }));
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse(many));
    mockRoute("/rs_prompts/prompt_previews", () => jsonResponse({ previews: {} }));
    const env = await mounted();
    assert.equal(cards(env.host).length, PAGE_SIZE, "第一条就只铺一屏");
    assert.deepEqual([...env.host.querySelectorAll(".ns-pl-page:not(.is-edge)")].map((b) => b.textContent), ["1", "2"]);
    assert.equal(env.host.querySelector(".ns-pl-pages").textContent, "第 1 / 2 页");
    click(env.host.querySelector('.ns-pl-page.is-edge[aria-label="下一页"]'));
    await settle();
    assert.equal(cards(env.host).length, 30 - PAGE_SIZE, "第二页铺剩下的那几条");
    assert.equal(env.host.querySelector(".ns-pl-pages").textContent, "第 2 / 2 页");
    assert.equal(env.host.querySelector('.ns-pl-page.is-edge[aria-label="下一页"]').disabled, true,
        "末页的下一枚箭头吃边界，不给一颗点了没反应的钮");
});

test("正文摘要按页取一次：卡上的摘要位铺服务端那句", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    const call = fetchLog.find((c) => c.path === "/rs_prompts/prompt_previews");
    assert.deepEqual(call.body.names, ["红杯", "古风女孩", "video/镜头推进"], "一次请求吃这一页的名字");
    assert.deepEqual([...env.host.querySelectorAll(".ns-pl-excerpt")].map((e) => e.textContent),
        ["摘要:红杯", "摘要:古风女孩", "摘要:video/镜头推进"]);
});

test("摘要读不回来（离线 409）：卡片照铺，摘要位空着，不铺一句读取失败", async () => {
    resetEnv();
    mockPromptRoutes();
    mockRoute("/rs_prompts/prompt_previews", () => jsonResponse({ offline: true }, 409));
    const env = await mounted();
    assert.equal(cards(env.host).length, 3);
    assert.deepEqual([...env.host.querySelectorAll(".ns-pl-excerpt")].map((e) => e.textContent), ["", "", ""]);
    assert.equal(env.host.querySelector(".ns-pl-note"), null);
});

test("页码窗口与「多久前」：出界补首页与末页，时间只到月这一档", () => {
    assert.deepEqual(pageWindow(1, 2), [1, 2]);
    assert.deepEqual(pageWindow(4, 10), [1, "…", 2, 3, 4, 5, 6, "…", 10]);
    assert.deepEqual(pageWindow(10, 10), [1, "…", 6, 7, 8, 9, 10]);
    const day = 86400;
    assert.equal(agoText(Date.now() / 1000), "今天");
    assert.equal(agoText(Date.now() / 1000 - 3 * day), "3 天前");
    assert.equal(agoText(Date.now() / 1000 - 40 * day), "1 个月前");
});