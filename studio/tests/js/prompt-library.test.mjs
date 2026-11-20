// Studio「提示词库」页（web/prompt-library/prompt-library.js）：卡片网格与封面、正文摘要、分页、筛选、
// 「填入对应页」、设封面与删除那条链，全在 jsdom 里验。列表 / 封面 / 摘要三条读侧走 fetch mock，
// 写侧两发认接口交回来的形状；桌面端离线那一发（列表 409 的 {offline:true}）要落在这页上说得清的一句话。
// 标题行那枚刷新钮：先重拉云端索引再重读列表，云端够不着的那几发各说各的话。
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, click, flush, sleep } from "./setup.mjs";
import { $el } from "../../web/studio/shim/ui.js";

const { createPromptLibraryView, filterPromptCards, sortPromptCards, topTags, cardBadges, agoText,
    coverSearchTerm, cloudPreviewMedia, cardPreviewMedia, cardCoverSrc, cardOriginalSrc, COVER_SEARCH_CHARS, PAGE_SIZE } =
    await import("../../web/prompt-library/prompt-library.js");
const { promptCoverUrl, cloudPreviewUrl, cloudMediaUrl, cloudDirCoverUrl, galleryImageUrl, coverMediaSrc } = await import("../../web/prompt-service.js");

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
// 灯箱是全站一份的单例（web/lightbox.js），断言完就收，不留到下一个用例
const lightbox = () => document.querySelector(".neo-lightbox");
const closeLightbox = () => document.querySelector(".neo-lightbox-close")?.click();
const lightboxActions = () => [...document.querySelectorAll(".neo-lightbox-action")].map((b) => b.title);

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

test("排序与标签筛子：三档排序各走自己那一发，标签词表按出现次数排", () => {
    const rows = ITEMS.filter((it) => !it.isRecipe);
    assert.deepEqual(sortPromptCards(rows, "old").map((it) => it.name),
        ["video/镜头推进", "古风女孩", "红杯"], "最早在前就是 _mtime 小的在前");
    assert.deepEqual(sortPromptCards(rows, "name").map((it) => it.name),
        ["古风女孩", "红杯", "video/镜头推进"], "名称按显示名的中文拼音排，目录段不进排序");
    assert.deepEqual(rows.map((it) => it.name), ["红杯", "古风女孩", "video/镜头推进"], "排完不改来表");
    // 出现次数相同就保持条目里的先后：红杯 的两个标签排在 古风 与 运镜 之前
    assert.deepEqual(topTags(ITEMS), ["产品", "白底", "古风", "运镜"]);
    assert.deepEqual(topTags(ITEMS, 2), ["产品", "白底"], "词表只铺前 limit 颗");
    assert.deepEqual(topTags([]), [], "空列表没有词表");
    assert.deepEqual(filterPromptCards(ITEMS, { tag: "白底" }).map((it) => it.name), ["红杯"]);
    assert.deepEqual(filterPromptCards(ITEMS, { pool: "video", tag: "运镜" }).map((it) => it.name),
        ["video/镜头推进"], "标签与池子叠着筛");
    assert.deepEqual(filterPromptCards(ITEMS, { tag: "白底", query: "古风" }), [], "标签与搜索同时命中才留");
    assert.deepEqual(filterPromptCards(ITEMS, { sort: "old" }).map((it) => it.name),
        ["video/镜头推进", "古风女孩", "红杯"], "筛完就吃排序那一发");
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

test("标签筛子与排序 chips：点一颗就重排这一叠", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    const tagChips = () => [...env.host.querySelectorAll(".ns-pl-tagbox .ns-pl-chip")];
    assert.deepEqual(tagChips().map((c) => c.textContent), ["全部标签", "产品", "白底", "古风", "运镜"],
        "词表按出现次数铺，第一颗是全部标签");
    click(tagChips().find((c) => c.textContent === "白底"));
    assert.deepEqual(cards(env.host), ["红杯"], "点标签只留带那一发的卡片");
    assert.equal(tagChips().find((c) => c.textContent === "白底").classList.contains("is-on"), true);
    const chip = (text) => [...env.host.querySelectorAll(".ns-pl-chip")].find((c) => c.textContent === text);
    click(tagChips()[0]);
    click(chip("最早"));
    assert.deepEqual(titles(env.host), ["镜头推进", "古风女孩", "红杯"]);
    click(chip("名称"));
    assert.deepEqual(titles(env.host), ["古风女孩", "红杯", "镜头推进"]);
    click(chip("最新"));
    assert.deepEqual(titles(env.host), ["红杯", "古风女孩", "镜头推进"]);
});

test("加载那一段网格铺骨架卡，列表到位就换成真卡", async () => {
    resetEnv();
    mockPromptRoutes();
    const host = $el("div");
    document.body.appendChild(host);
    const build = createPromptLibraryView({
        $el, toast: () => { }, can: () => true, gateRun: () => { }, openMaterial: () => { }, applyToPage: () => { },
    });
    const done = build(host);
    assert.equal(host.querySelectorAll(".ns-pl-skel").length, PAGE_SIZE, "列表没到位之前铺一屏骨架卡");
    assert.equal(host.querySelectorAll(".ns-pl-name").length, 0, "骨架卡不铺真名字");
    await done;
    await settle();
    assert.equal(host.querySelectorAll(".ns-pl-skel").length, 0, "列表到位即换成真卡");
    assert.equal(host.querySelectorAll(".ns-pl-name").length, 3);
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

test("预览地址：卡片那一发带 preview=1，灯箱那一发是同一条路由的本体", () => {
    const url = cloudPreviewUrl(CLOUD_ITEMS[0].media);
    assert.match(url, /\/neo_gallery\/video\?/);
    assert.match(url, /filename=01_Remotion\.mp4/);
    assert.match(url, /subfolder=Cloud%20Presets%2Fprompts\.chat/);
    assert.match(url, /preview=1$/);
    const original = cloudMediaUrl(CLOUD_ITEMS[0].media);
    assert.equal(original.includes("preview=1"), false, "去掉预览键就是原片：480p 那一档只属于卡片那一格");
    assert.match(original, /filename=01_Remotion\.mp4/, "同一条视频代理、同一个文件名");
    assert.match(original, /subfolder=Cloud%20Presets%2Fprompts\.chat/);
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

/** 自定义那条带封面指针的：卡上的视频位播的就是素材库里那条成片（指针由设封面那一发写入） */
const LOCAL_VIDEO_ITEM = {
    name: "video/镜头推进", source: "custom", tags: [], _mtime: 800, cover: 888,
    cover_media: { filename: "镜头推进 0001.mp4", subfolder: "NeoStudio/3 期", kind: "video" },
};

/** 指针是图的那一条：封面是从素材库那张产物缩出来的，灯箱要放的是那张产物 */
const LOCAL_IMAGE_COVER_ITEM = {
    name: "红杯外拍", source: "custom", tags: [], _mtime: 900, cover: 999,
    cover_media: { filename: "外拍 0002.png", subfolder: "NeoStudio/3 期", kind: "image" },
};

test("灯箱那一张：来路与卡片一一相对，缩着的那一份换成本体", () => {
    const cloud = cardOriginalSrc(IMAGE_MEDIA_ITEM);
    assert.equal(cloud, galleryImageUrl(IMAGE_MEDIA_ITEM.media), "灯箱那一张就是媒体本体那一发，与素材页灯箱同一口径");
    assert.match(cloud, /filename=03_AmericanComic\.jpg/, "文件名与卡片那一发同一份");
    assert.equal(cloud.includes("size="), false, "本体那一发没有尺寸档");
    assert.equal(cloud.includes("/neo_gallery/thumbnail"), false, "卡片那一格的缩略图代理不进灯箱");
    assert.match(cardOriginalSrc(LOCAL_IMAGE_COVER_ITEM), /\/neo_gallery\/image\?filename=%E5%A4%96%E6%8B%8D%200002\.png/,
        "指针是图就放大那张产物，正文旁边那张 sidecar 不进灯箱");
    assert.match(cardOriginalSrc(ITEMS[0]), /\/rs_prompts\/prompt_cover\?name=%E7%BA%A2%E6%9D%AF&v=111$/,
        "只有 sidecar 封面的条照放 sidecar");
    assert.match(cardOriginalSrc(DIR_COVER_ITEM), /\/neo_gallery\/thumbnail\?/,
        "视频目录的封面是索引里那一帧，没有图本体可放大");
    assert.match(cardOriginalSrc({ ...DIR_COVER_ITEM, dir_cover: { filename: "10_池封面.jpg", subfolder: "Cloud Presets/仙侠玄幻人物" } }),
        /\/neo_gallery\/image\?/, "目录封面是图就放那张整图");
    assert.equal(cardOriginalSrc(ITEMS[1]), null, "三条来路都没有就不占灯箱位");
});

test("预览判定两条链：云端预览优先，自定义认封面指针那条 video，其余落静封面", () => {
    const src = cardPreviewMedia(LOCAL_VIDEO_ITEM).src;
    assert.match(src, /\/neo_gallery\/video\?/, "地址走素材库那条视频代理");
    assert.match(src, /filename=%E9%95%9C%E5%A4%B4%E6%8E%A8%E8%BF%9B%200001\.mp4/);
    assert.match(src, /subfolder=NeoStudio%2F3%20%E6%9C%9F/);
    assert.equal(src.includes("preview=1"), false, "本地成片播原片：预览键那一发是云端 OSS 的口径");
    assert.match(cardPreviewMedia(CLOUD_ITEMS[0]).src, /preview=1$/, "云端预设照旧走 480p 预览");
    assert.match(cardPreviewMedia(CLOUD_ITEMS[0]).original, /filename=01_Remotion\.mp4/,
        "云端那条的本体在同一发路由上，灯箱播它");
    assert.equal(cardPreviewMedia(CLOUD_ITEMS[0]).original.includes("preview=1"), false,
        "本体不带预览键：480p 那一档只属于卡片那一格");
    assert.equal(cardPreviewMedia(LOCAL_VIDEO_ITEM).original, src, "本地成片本体就是它自己");
    assert.equal(cardPreviewMedia({ ...LOCAL_VIDEO_ITEM,
        cover_media: { ...LOCAL_VIDEO_ITEM.cover_media, kind: "image" } }), null, "指针那条是图就不建视频位");
    assert.equal(cardPreviewMedia({ ...LOCAL_VIDEO_ITEM, name: "镜头推进" }).src, src,
        "图像池的条目照播：指针说封面来自那条成片，池子筛子不决定封面的来路");
    assert.equal(cardPreviewMedia({ ...LOCAL_VIDEO_ITEM, cover: undefined }), null, "没有封面就没有 poster");
    assert.equal(cardPreviewMedia({ name: "video/旧封面", source: "custom", _mtime: 1, cover: 1 }), null,
        "回填指针之前写的封面落静图，不发一条指向不明的请求");
});

test("本地成片卡：预览位带 poster 与播放角标，src 是素材库那条片的地址", async () => {
    resetEnv();
    mockPromptRoutes();
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse([LOCAL_VIDEO_ITEM, IMAGE_MEDIA_ITEM]));
    const env = await mounted();
    const cardEl = env.card("video/镜头推进");
    const video = cardEl.querySelector(".ns-pl-preview");
    assert.ok(video, "封面指针那条本地成片铺预览位");
    assert.equal(video.muted, true, "卡片自动播是静音的：原片的声音留给素材页的灯箱");
    assert.equal(video.loop, true);
    assert.equal(video.getAttribute("preload"), "none", "卡片一进来不发媒体");
    assert.match(video.dataset.src, /\/neo_gallery\/video\?/);
    assert.match(video.getAttribute("poster"), /name=video%2F%E9%95%9C%E5%A4%B4%E6%8E%A8%E8%BF%9B&v=888$/,
        "poster 用那张封面");
    assert.ok(cardEl.querySelector(".ns-pl-kind"), "视频卡带播放角标");
    assert.equal(env.card("prompts.chat/American Comic").querySelector(".ns-pl-kind"), null,
        "只有铺了预览位的卡带这枚角标");
});

test("文字位：没有画面的卡标题行在最上方，摘要那一格在它下面，不铺假缩略图", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    const cardEl = env.card("古风女孩");
    assert.equal(cardEl.querySelector(".ns-pl-media"), null, "文字位不是媒体位");
    assert.equal(cardEl.children[0].className, "ns-pl-head", "没有画面时名字与徽标是卡片的第一行");
    assert.equal([...cardEl.querySelectorAll("span")].filter((e) => e.textContent === "图像").length, 1,
        "池子标签只有徽标那一枚，一张卡不铺两枚同样的标签");
    assert.ok(cardEl.querySelector(".ns-pl-tile .ns-pl-excerpt"), "摘要那一格落在文字位里");
    assert.equal(env.host.querySelectorAll(".ns-pl-excerpt").length, 3,
        "三条摘要位都在，按页那一发照同一发回填");
});

test("卡片点开灯箱：封面放大，←/→ 只在有画面的卡之间翻，侧栏铺这条的全文", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    click(env.card("红杯"));
    await settle();
    const lb = lightbox();
    assert.ok(lb, "有画面的卡片整张点开灯箱");
    assert.match(String(lb.querySelector("img.neo-lightbox-media").src), /name=%E7%BA%A2%E6%9D%AF&v=111$/,
        "灯箱放大的是这张卡上那份封面");
    assert.equal(lb.querySelector(".neo-lightbox-counter").textContent, "1 / 2",
        "翻页那一叠只收有画面的两条卡，文字位卡片不在里面");
    assert.equal(lb.querySelector(".neo-lightbox-prev").disabled, true, "第一张没有上一页");
    assert.deepEqual([...lb.querySelectorAll(".neo-lightbox-panel-tag")].map((e) => e.textContent),
        ["产品", "白底"], "侧栏铺这条的标签");
    assert.ok(lb.querySelector(".neo-lightbox-panel").textContent.includes("全文:红杯"), "侧栏铺这条的全文");
    assert.deepEqual(lightboxActions(), ["填入绘画页", "复制这条提示词全文", "设为封面"],
        "灯箱底栏与卡上同一口径，图像条只给填入绘画页");
    click(lb.querySelector(".neo-lightbox-next"));
    await settle();
    assert.equal(lb.querySelector(".neo-lightbox-caption").textContent, "镜头推进", "→ 落到下一条有画面的卡");
    assert.deepEqual(lightboxActions(), ["填入视频页", "复制这条提示词全文", "设为封面"],
        "翻到视频条，底栏换成填入视频页");
    closeLightbox();
    assert.equal(lightbox(), null, "灯箱收干净，不留到下一个用例");
});

test("视频卡点开灯箱：播的是原片，卡片那一格的 480p 预览、静音与 preload 都不进灯箱", async () => {
    resetEnv();
    mockPromptRoutes();
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse([LOCAL_VIDEO_ITEM, CLOUD_ITEMS[0]]));
    const env = await mounted();
    click(env.card("video/镜头推进"));
    await settle();
    const media = lightbox().querySelector("video.neo-lightbox-media");
    assert.ok(media, "视频卡播的是画面，不是静封面");
    assert.match(String(media.src), /\/neo_gallery\/video\?/, "地址是素材库那条视频代理");
    assert.equal(String(media.src).includes("preview=1"), false, "本地成片播本体");
    assert.equal(media.muted, false, "卡片那格的静音不进灯箱");
    assert.equal(media.getAttribute("controls"), "", "灯箱里那条片带播放控件");
    click(lightbox().querySelector(".neo-lightbox-next"));
    await settle();
    const cloud = lightbox().querySelector("video.neo-lightbox-media");
    assert.match(String(cloud.src), /filename=01_Remotion\.mp4/, "云端预设那条落进同一条视频代理");
    assert.equal(String(cloud.src).includes("preview=1"), false,
        "云端预设那条在灯箱里播原片，不是卡片在播的那一档 480p");
    assert.equal(cloud.autoplay, true, "灯箱里那一条直接播起来，卡片那一格的 preload=none 不进这一发");
    closeLightbox();
});

test("图像卡点开灯箱：放的是目录里那张整图，卡片那一格的缩略图不进灯箱", async () => {
    resetEnv();
    mockPromptRoutes();
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse([IMAGE_MEDIA_ITEM, LOCAL_IMAGE_COVER_ITEM]));
    const env = await mounted();
    click(env.card("prompts.chat/American Comic"));
    await settle();
    const img = lightbox().querySelector("img.neo-lightbox-media");
    assert.ok(img, "图像卡进灯箱铺画面");
    assert.match(String(img.src), /\/neo_gallery\/image\?filename=03_AmericanComic\.jpg/, "灯箱放云端目录里那张整图");
    click(lightbox().querySelector(".neo-lightbox-prev"));
    await settle();
    assert.match(String(lightbox().querySelector("img.neo-lightbox-media").src),
        /\/neo_gallery\/image\?filename=%E5%A4%96%E6%8B%8D%200002\.png/,
        "← 翻到指针是图的那一条，放的是指针那条产物，不是 512 的 sidecar");
    closeLightbox();
});

test("文字位卡片点开不开窗：没有可放的画面，卡片上也不铺放大光标", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    assert.equal(env.card("红杯").classList.contains("is-viewable"), true, "有封面的卡认这一发是放大");
    assert.equal(env.card("古风女孩").classList.contains("is-viewable"), false, "文字位卡不铺这一位");
    click(env.card("古风女孩"));
    await settle();
    assert.equal(lightbox(), null, "点开文字位卡片不开灯箱");
});

test("卡上的动作排不拽开灯箱：点复制那一发只走复制", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    click(env.btn(env.card("红杯"), "复制这条提示词全文"));
    await settle();
    assert.equal(lightbox(), null, "动作排那一发不冒到卡片上");
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

test("填页那一发认池子：视频条只有填入视频页，图像条只有填入绘画页", async () => {
    resetEnv();
    mockPromptRoutes();
    const env = await mounted();
    const video = env.card("video/镜头推进");
    assert.ok(env.btn(video, "填入视频页"), "视频提示词给填入视频页那枚钮");
    assert.equal(env.btn(video, "填入绘画页"), undefined, "视频提示词不给填入绘画页那枚钮");
    const image = env.card("红杯");
    assert.ok(env.btn(image, "填入绘画页"), "图像提示词给填入绘画页那枚钮");
    assert.equal(env.btn(image, "填入视频页"), undefined, "图像提示词不给填入视频页那枚钮");
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
    assert.deepEqual(env.picks, [null], "筛子是「全部」时两类素材都收——图像池的提示词也能钉一条成片当封面");
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
    click([...env.host.querySelectorAll(".ns-pl-chip")].find((c) => c.textContent === "视频"));
    click(env.btn(env.card("video/镜头推进"), "设为封面"));
    await settle();
    assert.deepEqual(env.picks, [null, "video"], "筛子切到视频就只收视频");
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


/* 标题行行尾那枚「刷新」：先把云端索引（主索引 + 逐目录索引）整片强制重拉、云端提示词目录镜像进提示词池，
   再重读列表；云端那一发够不着的两种情况各说各的话，本地列表照重读。 */

const SYNC_OK = { success: true, directories: 16, items: 2506, refreshed: 16 };
const LOCAL_CARDS = ITEMS.filter((i) => !i.isRecipe).length;   // 配方不入这一页的卡片池
const paths = () => fetchLog.map((c) => c.path);
const listed = () => fetchLog.filter((c) => c.path === "/rs_prompts/list_prompts").length;

test("刷新钮认得：图标是 refresh 那两道弧，钮上有「刷新」那一个字", async () => {
    resetEnv();
    mockPromptRoutes();
    mockRoute("/neo_gallery/sync_oss", () => jsonResponse(SYNC_OK));
    const env = await mounted();
    const btn = env.host.querySelector(".ns-pl-refresh");
    assert.ok(btn, "标题行行尾应有刷新钮");
    assert.equal(btn.textContent.trim(), "刷新", "纯图标在顶栏行尾读成列表控件，钮上要有字");
    assert.ok(btn.querySelector("svg")?.innerHTML.includes("9.75 9.75 0 0 1 6.74 2.74"),
        "图标要认得出是刷新，不是那一排横线");
});

test("刷新那一发：先重拉云端索引，索引到位才重读列表，成功报云端那两个数", async () => {
    resetEnv();
    mockPromptRoutes();
    mockRoute("/neo_gallery/sync_oss", () => jsonResponse(SYNC_OK));
    const env = await mounted();
    const btn = env.host.querySelector(".ns-pl-refresh");
    const firstList = listed();
    click(btn);
    await settle();
    const syncs = fetchLog.filter((c) => c.path === "/neo_gallery/sync_oss");
    assert.equal(syncs.length, 1, "一发刷新只重拉一次云端索引");
    assert.equal(syncs[0].method, "POST");
    assert.ok(listed() > firstList, "云端索引回来要重读列表");
    assert.ok(paths().indexOf("/neo_gallery/sync_oss") < paths().lastIndexOf("/rs_prompts/list_prompts"),
        "列表要在云端索引之后重读——卡片上的云端图吃的是那份目录索引缓存");
    assert.ok(env.toasts.some((s) => s.includes("2506")), `刷新成功要报云端条数：${env.toasts}`);
    assert.equal(btn.disabled, false, "在飞那一发结束要把钮放开");
    assert.ok(!btn.classList.contains("is-busy"), "在飞标记要收掉");
});
test("刷新报了云端提示词那一步：补进来的与收掉的都说得出数", async () => {
    resetEnv();
    mockPromptRoutes();
    mockRoute("/neo_gallery/sync_oss", () => jsonResponse(
        { ...SYNC_OK, mirror: { directories: 1, imported: 56, pruned: 1 } }));
    const env = await mounted();
    click(env.host.querySelector(".ns-pl-refresh"));
    await settle();
    assert.ok(env.toasts.some((s) => s.includes("+56") && s.includes("-1")),
        `镜像那一步要报补进与收掉的条数：${env.toasts}`);

    mockRoute("/neo_gallery/sync_oss", () => jsonResponse(
        { ...SYNC_OK, mirror: { directories: 1, imported: 0, pruned: 0 } }));
    const quiet = await mounted();
    click(quiet.host.querySelector(".ns-pl-refresh"));
    await settle();
    assert.ok(!quiet.toasts.some((s) => s.includes("+")), `一条没动就不报这一步：${quiet.toasts}`);
});


test("云端那一发够不着：说清是哪一发，本地列表照重读", async () => {
    resetEnv();
    mockPromptRoutes();
    mockRoute("/neo_gallery/sync_oss", () => jsonResponse(
        { success: false, error: "OSS not configured", reason: "not_configured" }, 400));
    const env = await mounted();
    click(env.host.querySelector(".ns-pl-refresh"));
    await settle();
    assert.ok(env.toasts.some((s) => s.includes("未配置云端预设")), `未配置要这么说：${env.toasts}`);
    assert.ok(!env.toasts.some((s) => s.includes("失败")), "这一页没有云端预设可刷，不是刷失败了");
    assert.equal(env.host.querySelectorAll(".ns-pl-card").length, LOCAL_CARDS, "本地列表照重读");

    mockRoute("/neo_gallery/sync_oss", () => jsonResponse(
        { offline: true, error: "ComfyUI server not detected", routes: [] }, 409));
    const offline = await mounted();
    click(offline.host.querySelector(".ns-pl-refresh"));
    await settle();
    assert.ok(offline.toasts.some((s) => s.includes("ComfyUI")), `离线要说内核在跑：${offline.toasts}`);
    assert.equal(offline.host.querySelectorAll(".ns-pl-card").length, LOCAL_CARDS, "离线时本地列表照重读");
});


test("滚动加载：首屏 24 张卡，滚到底追加下一屏，铺完落一句「已全部 N 条」", async () => {
    resetEnv();
    const many = Array.from({ length: 30 }, (_, i) =>
        ({ name: `提示词${i + 1}`, source: "presets", tags: [], _mtime: 1000 - i }));
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse(many));
    mockRoute("/rs_prompts/prompt_previews", () => jsonResponse({ previews: {} }));
    const env = await mounted();
    const hooks = env.host.__neoStudioPromptLibraryPageTestHooks;
    assert.equal(cards(env.host).length, PAGE_SIZE, "第一条就只铺一屏");
    assert.equal(env.host.querySelector(".ns-pl-more").textContent, "载入更多…");
    hooks.appendMore();
    await settle();
    assert.equal(cards(env.host).length, 30, "滚到底把剩下的那几条接在同一叠后面");
    assert.equal(hooks.shown(), 30);
    assert.equal(env.host.querySelector(".ns-pl-more").textContent, "已全部 30 条");
    hooks.appendMore();
    assert.equal(cards(env.host).length, 30, "铺完之后滚到底不再追加");
});

test("滚动加载跟着筛子走：换筛子重装首屏并把滚动位拉回顶", async () => {
    resetEnv();
    const many = Array.from({ length: 80 }, (_, i) =>
        ({ name: i % 2 ? `video/镜头${i}` : `提示词${i}`, source: "custom", tags: [], _mtime: 1000 - i }));
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse(many));
    mockRoute("/rs_prompts/prompt_previews", () => jsonResponse({ previews: {} }));
    const env = await mounted();
    const hooks = env.host.__neoStudioPromptLibraryPageTestHooks;
    hooks.appendMore();
    assert.equal(cards(env.host).length, 48, "滚到底把这一叠接下一屏");
    const body = env.host.querySelector(".ns-pl-body");
    body.scrollTop = 300;
    click([...env.host.querySelectorAll(".ns-pl-chip")].find((c) => c.textContent === "视频"));
    assert.equal(cards(env.host).length, PAGE_SIZE, "换筛子只重装首屏那一屏");
    assert.equal(hooks.shown(), PAGE_SIZE, "已铺的条数跟着新一叠归零");
    assert.equal(body.scrollTop, 0, "滚在下面的视口回顶，不留在新一叠的空档上");
    assert.equal(body.querySelector(".ns-pl-more").textContent, "载入更多…", "新一叠还没铺完");
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
    assert.equal(env.host.querySelector(".ns-pl-note").textContent, "", "卡片照铺时那句话整位收掉");
});

test("「多久前」：只到月这一档，分钟级对这一页没有意义", () => {
    const day = 86400;
    assert.equal(agoText(Date.now() / 1000), "今天");
    assert.equal(agoText(Date.now() / 1000 - 3 * day), "3 天前");
    assert.equal(agoText(Date.now() / 1000 - 40 * day), "1 个月前");
});