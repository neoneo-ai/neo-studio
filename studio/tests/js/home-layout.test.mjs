// 首页版式：web/studio/home-layout.js 的注册表读版式、形状清洗、首页原地编辑与落盘。
// 版式文件 configs/home_layout.json 由 studio/home_layout.py 写：落点用例按后端同一份实现读回，
// 两侧对同一份形状的理解必须对得上（数据根顶到临时目录，用例绝不碰真实 data/）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, jsonResponse, click, fetchLog } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const STUDIO_DIR = path.resolve(webDir, "..");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "neo-home-layout-"));
process.env.NEO_STUDIO_DATA = DATA_ROOT;
const LAYOUT_FILE = path.join(DATA_ROOT, "configs", "home_layout.json");
after(() => fs.rmSync(DATA_ROOT, { recursive: true, force: true }));

const hl = await import("../../web/studio/home-layout.js");

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?hl=${seq++}`);
const settle = async () => { await sleep(0); await flush(); };

function mountStudio() {
    resetEnv();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({
        success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [],
    }));
}

async function openStudio(hash) {
    window.location.hash = hash;
    await importApp();
    await settle();
}

/** 版式的三条接口按方法分岔，并按后端一样留下写过的那一份：POST 写进去，GET 读回来 */
function mockLayout(stored = {}) {
    let current = stored;
    mockRoute("/neo_home/layout", (body, call) => call.method === "POST"
        ? jsonResponse({ success: true, layout: (current = body) })
        : jsonResponse(current));
    mockRoute("/neo_home/layout/reset", () => {
        current = {};
        return jsonResponse({ success: true, layout: {} });
    });
}

const lastCall = (path, method) =>
    [...fetchLog].reverse().find((c) => c.path === path && c.method === method);

const POSTS = () => fetchLog.filter((c) => c.path === "/neo_home/layout" && c.method === "POST").length;

/** 首页这一页就是编辑器：用例点的是卡上的控件、板块标题上的控件与顶端那条细栏 */
const homeOf = () => document.querySelector(".ns-page.ns-home");
const bar = (home) => home.querySelector(".ns-home-edit-bar");
const colChip = (home, n) => bar(home).querySelector(`.ns-home-edit-col[data-cols="${n}"]`);
const barBtn = (home, cls) => bar(home).querySelector(`.ns-home-edit-${cls}`);
const cardOf = (home, title) => [...home.querySelectorAll(".ns-home-card")]
    .find((c) => c.querySelector(".ns-home-card-title")?.textContent === title);
const chip = (card, title) => [...card.querySelectorAll(".ns-home-card-tools .ns-btn")]
    .find((b) => b.title === title);
const sectionTitle = (home, label) => [...home.querySelectorAll(".ns-home-section")]
    .find((s) => s.firstChild?.textContent === label);
const fieldIn = (card, label) => [...card.querySelectorAll(".ns-home-f-field")]
    .find((f) => f.querySelector(".ns-home-f-label")?.textContent === label);
const moveChip = (host, title) => [...host.querySelectorAll(".ns-btn")].find((b) => b.title === title);
const titlesIn = (host) => [...host.querySelectorAll(".ns-home-card-title")].map((e) => e.textContent);
const gridOf = (home, label) => sectionTitle(home, label).nextElementSibling;
/** 添加卡片这一面：上半铺这一板块的预设卡，下半是自建卡表单，两条都只改草稿 */
const dlg = () => document.querySelector(".ns-home-card-dialog");
const dlgBtn = (cls) => dlg().querySelector(`.ns-home-card-dialog-${cls}`);
const dlgClose = () => document.querySelector(".ns-home-card-dialog .ns-libmodal-close");
const presetIn = (host, title) => [...host.querySelectorAll(".ns-home-preset-card")]
    .find((c) => c.querySelector(".ns-home-card-title")?.textContent === title);
const presetTitles = (host) => [...host.querySelectorAll(".ns-home-preset-card .ns-home-card-title")]
    .map((e) => e.textContent);
/** 图标格子里现在选着的那一枚：图标格铺的是图标本身，图标名只是这枚的标识 */
const iconPick = () => dlg().querySelector('.ns-home-f-icons [aria-pressed="true"]')?.dataset.icon;
/** 跳转类型那一排 radio 里的某一颗：三种跳转铺成一排，点一颗就换整张卡的去向 */
const radioIn = (label) => [...dlg().querySelectorAll(".ns-home-f-radio")].find((b) => b.textContent === label);
/** 自建卡那一张预览：铺的就是这张卡在首页上的样子，标题与副标题点字直接改，图标点一下才展开候选 */
const formCard = () => dlg().querySelector(".ns-home-form-card");
const lineIn = (cls) => dlg().querySelector(`.ns-home-form-card .${cls}`);
const iconTile = () => dlg().querySelector(".ns-home-form-icon");
/** 就地改一行字：写进这一行再喊失焦——首页标题区那五行用的就是这一套走法 */
function typeLine(node, text) {
    node.textContent = text;
    node.dispatchEvent(new Event("blur"));
}
/** 首页上真出现的那一叠卡名：移出首页的卡不在网格上，这一叠就是页面上看得见的卡 */
const cardTitles = (root) =>
    [...root.querySelectorAll(".ns-home-card .ns-home-card-title")].map((e) => e.textContent);

/** 落位手势是 vendored 的 Sortable（web/vendor/sortable.min.js）：jsdom 没有 layout，手势本身归 npm run e2e。
 *  用例替它记下每条网格收到的参数与回调——落位 → 草稿这一段是我们的代码，照测。 */
const sortables = [];
function mockSortable() {
    sortables.length = 0;
    globalThis.Sortable = {
        create: (el, opts) => {
            const inst = { el, opts, cancels: 0, destroys: 0 };
            inst.cancel = () => { inst.cancels++; };
            inst.destroy = () => { inst.destroys++; };
            sortables.push(inst);
            return inst;
        },
    };
}
mockSortable();

const sortableFor = (grid) => sortables.find((s) => s.el === grid);

/** 一次落位：按 Sortable 在浏览器里交出来的那一份事件形状喊 onEnd；跨板块就换 to 那条网格 */
function dropAt(item, at, to = item.parentElement) {
    const grid = item.parentElement;
    const inst = sortableFor(grid);
    inst.opts.onEnd.call(inst, {
        item, from: grid, to,
        oldDraggableIndex: [...grid.querySelectorAll(".ns-home-card")].indexOf(item),
        newDraggableIndex: at,
    });
    return inst;
}

const pick = (sel, value) => {
    sel.value = value;
    sel.dispatchEvent(new Event("change"));
};

/** 右上角入口把这一页切进原地编辑：入口之后 load() 读一次已落盘的版式 */
async function enterEdit(home) {
    click(home.querySelector(".ns-home-edit-entry"));
    await flush(40);
    assert.ok(home.classList.contains("ns-home-editing"), "首页应在这页上进入编辑态");
    assert.ok(bar(home), "编辑态应有那条管列数与落盘的细栏");
}

/** 后端那一侧跑一段表达式：版式文件的写与读全按 studio/home_layout.py 实现 */
function pyBridge(expr, payload = {}) {
    const code = [
        "import importlib.machinery, json, sys, types",
        "pkg = types.ModuleType('studio')",
        `pkg.__path__ = [${JSON.stringify(STUDIO_DIR)}]`,
        "pkg.__spec__ = importlib.machinery.ModuleSpec('studio', None, is_package=True)",
        "sys.modules['studio'] = pkg",
        "from studio import home_layout as h",
        "payload = json.load(sys.stdin)",
        `print(json.dumps(${expr}))`,
    ].join("; ");
    // payload 走 stdin 进 Python：JS 的 true/false 不是合法的 Python 字面量
    return JSON.parse(execFileSync("python", ["-X", "utf8", "-c", code], {
        encoding: "utf8",
        input: JSON.stringify(payload),
        env: { ...process.env, NEO_STUDIO_DATA: DATA_ROOT },
    }).trim());
}

test("首页注册表：板块与卡一一对齐，卡表只此一份", () => {
    assert.deepEqual(hl.HOME_SECTIONS.map((s) => s.id), ["create", "edit", "material"]);
    const ids = hl.HOME_CARDS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, "卡 id 不能重复");
    assert.ok(ids.length >= 14, "首页至少 14 张意图卡");
    assert.deepEqual(hl.HOME_TARGETS, ["edit", "recipe", "skill", "url"],
        "自建卡能配的跳转类型只有这四种，页面直连不在其上");
    assert.deepEqual(hl.HOME_EDIT_MODES, ["normal", "outpaint", "local", "remove", "blend", "pose", "angle"],
        "编辑模式清单与图片编辑面板的模式 chip 同源同序：少一个首页就少一张直达卡");
    for (const card of hl.HOME_CARDS) {
        assert.ok(card.title && card.sub && card.icon, `卡 ${card.id} 缺标题 / 副标题 / 图标`);
        assert.ok(hl.HOME_SECTIONS.some((s) => s.id === card.section), `卡 ${card.id} 的板块认不出`);
        assert.ok(card.target === hl.LEGACY_TARGET || hl.HOME_TARGETS.includes(card.target),
            `卡 ${card.id} 的跳转类型认不出`);
    }
    const editModes = hl.HOME_CARDS.filter((c) => c.target === "edit").map((c) => c.value);
    assert.deepEqual(hl.HOME_EDIT_MODES.filter((m) => !editModes.includes(m)), [],
        "编辑页那一发模式都要有预设直达卡");
    assert.equal(new Set(editModes).size, editModes.length, "编辑模式卡不发重复");
    const effect = hl.HOME_CARDS.find((c) => c.id === "effect");
    assert.equal(effect?.target, "skill", "特效卡走技能落点：特效是 effect_h3 这张技能的能力，不是一页自己的功能");
    assert.equal(effect?.value, "effect_h3", "特效卡钉在 effect_h3 技能上：技能改名要跟着改这张卡");
    assert.equal(effect?.defaultHidden, true, "特效卡默认不上首页：新能力不进默认首页，在添加卡片里等着加");
    const board = hl.HOME_CARDS.find((c) => c.id === "storyboard");
    assert.equal(board?.value, "storyboard", "宫格图分镜卡按 value 落自己那一页 #/storyboard");
    assert.equal(board?.defaultHidden, true, "宫格图分镜卡默认不上首页：版式排过它才上首页，不在默认首页上多占一格");
    assert.ok(!hl.HOME_TARGETS.includes("page") && board?.target === hl.LEGACY_TARGET,
        "直连落点走旧版式那一类：新加的发不挤进自建卡能配的跳转类型里");
});


test("空版式 = 注册表默认：板块与卡全出，标题区落默认文案", () => {
    const layout = hl.normalizeLayout({});
    assert.deepEqual(hl.layoutSections(layout).map((s) => s.id), ["create", "edit", "material"]);
    assert.deepEqual(hl.visibleCards("create", layout).map((c) => c.id),
        ["paint", "video", "director", "pose", "agent", "voice", "prompt-enhance"]);
    assert.deepEqual(hl.heroText(layout), hl.HOME_HERO);
    assert.equal(layout.cols, 0, "默认列数是跟随窗口档位");
});

test("形状清洗：认不出的板块与卡丢，越界列数与坏 hero 落默认", () => {
    const layout = hl.normalizeLayout({
        sections: ["create", "create", "ghost", "edit", 1],
        hidden_sections: ["material", "ghost"],
        order: { create: ["paint", "paint", "ghost_card", "video"], ghostsec: ["paint"] },
        hidden: ["video", "gone"],
        cols: 99,
        hero: { title: "标题\n第二行", sub: "s".repeat(80), cta: "   " },
    });
    assert.deepEqual(layout.sections, ["create", "edit"], "板块只收注册表里的 id");
    assert.deepEqual(layout.hidden_sections, ["material"]);
    assert.deepEqual(layout.order.create, ["paint", "video", "director", "pose", "agent", "voice", "prompt-enhance"],
        "重复与认不出的卡 id 丢，版式没排的内置卡补在末尾");
    assert.equal(layout.order.ghostsec, undefined, "认不出的板块不留 order 键");
    assert.deepEqual(layout.hidden, ["video"], "认不出的卡不能靠隐藏键留在版式里");
    assert.equal(layout.cols, 0);
    assert.equal(layout.hero.title, "标题 第二行", "hero 文案压成一行");
    assert.equal(layout.hero.sub.length, 60, "副标题按上限截断");
    assert.equal(layout.hero.cta, undefined, "空白文案不落进版式");
});

test("板块顺序读写：版式排的序生效，收起的板块整块不出", () => {
    const layout = hl.normalizeLayout({ sections: ["material", "edit", "create"], hidden_sections: ["edit"] });
    assert.deepEqual(hl.sectionOrder(layout), ["material", "edit", "create"]);
    assert.deepEqual(hl.layoutSections(layout).map((s) => s.id), ["material", "create"]);
});

test("卡片顺序读写：认不出的卡丢，新卡补末尾，隐藏的卡不出首页", () => {
    const layout = hl.normalizeLayout({
        order: { create: ["video", "ghost", "paint"] },
        hidden: ["paint"],
        custom: [{ id: "custom_a", section: "create", title: "我的入口", target: "page", value: "settings" }],
    });
    assert.deepEqual(hl.sectionCards("create", layout).map((c) => c.id),
        ["video", "paint", "director", "pose", "agent", "voice", "prompt-enhance", "custom_a"],
        "版式没排到的卡补在末尾，表单才排得回原位");
    assert.deepEqual(hl.visibleCards("create", layout).map((c) => c.id),
        ["video", "director", "pose", "agent", "voice", "prompt-enhance", "custom_a"]);
});

test("自建卡过同一条门：缺标题与跳转类型的卡丢，非 http(s) 的链接丢", () => {
    const layout = hl.normalizeLayout({
        custom: [
            { id: "custom_ok", section: "edit", title: "好卡", target: "url", url: "HTTPS://EX.COM/a", icon: "nope" },
            { id: "custom_no_title", title: "   ", target: "page" },
            { id: "custom_no_target", title: "无跳转", target: "magic" },
            { id: "bad id!", title: "坏 id", target: "page" },
            { id: "custom_no_url", title: "空链接", target: "url", url: "javascript:alert(1)" },
        ],
    });
    assert.deepEqual(layout.custom.map((c) => c.id), ["custom_ok", "custom_no_url"]);
    assert.equal(layout.custom[0].url, "HTTPS://EX.COM/a", "scheme 大小写都认");
    assert.equal(layout.custom[0].icon, "", "认不出的图标不落进版式");
    assert.equal(layout.custom[1].url, "", "js: 与 data: 这类 scheme 不落进文件");
});

test("版式读写走后端接口：非 200 与请求崩都落默认版式", async () => {
    resetEnv();
    mockRoute("/neo_home/layout", () => jsonResponse({ sections: ["edit", "create"], cols: 3 }));
    const stored = await hl.loadHomeLayout();
    assert.deepEqual(stored.sections, ["edit", "create"]);
    assert.equal(stored.cols, 3);
    mockRoute("/neo_home/layout", () => jsonResponse({}, 500));
    assert.equal(await hl.loadHomeLayout(), null, "比这版插件老的构建没有这条接口");
    mockRoute("/neo_home/layout", () => { throw new Error("net down"); });
    assert.equal(await hl.loadHomeLayout(), null, "请求崩了首页也要停在默认版式");
});

test("保存与恢复默认：POST 交形状，success 门挡住坏响应", async () => {
    resetEnv();
    mockLayout();
    const saved = await hl.saveHomeLayout({ sections: ["edit"], cols: 4, hero: { title: "标题" } });
    assert.deepEqual(saved.sections, ["edit"]);
    assert.equal(saved.cols, 4);
    assert.equal(lastCall("/neo_home/layout", "POST").method, "POST", "保存要走 POST");
    mockRoute("/neo_home/layout", () => jsonResponse({ success: false, error: "磁盘满了" }, 500));
    await assert.rejects(() => hl.saveHomeLayout({}), /磁盘满了/);
    const back = await hl.resetHomeLayout();
    assert.deepEqual(back.sections, []);
    assert.equal(lastCall("/neo_home/layout/reset", "POST").path, "/neo_home/layout/reset");
});

test("设置页不再单列「首页」栏：旧深链 #/settings?tab=home 落回默认栏不空白", async () => {
    mountStudio();
    mockLayout();
    await openStudio("#/settings?tab=home");
    await flush(40);
    assert.equal(document.querySelectorAll('.ns-settings-tab[data-key="home"]').length, 0,
        "首页版式不在设置页排");
    assert.equal(document.querySelector(".ns-settings-tab.active")?.textContent, "LLM 设置",
        "认不出的 tab 名落回默认栏");
    const open = [...document.querySelectorAll(".ns-settings-section")].filter((s) => s.style.display !== "none");
    assert.equal(open.length, 1, "每一块 body 都 display:none 的设置页就是一片空白");
});

test("首页按版式出卡：板块序、隐藏卡、自建卡与列数全生效", async () => {
    mountStudio();
    mockLayout({
        sections: ["material", "create"],
        order: { create: ["video", "paint"] },
        hidden: ["agent"],
        cols: 4,
        custom: [{ id: "custom_live", section: "create", title: "自建卡", sub: "直达设置页", target: "page", value: "settings" }],
        hero: { title: "我的首页", accent: "排版", sub: "一句副标题", cta: "开工" },
    });
    await importApp();
    await settle();
    const home = homeOf();
    assert.ok(home, "首页视图应挂载");
    assert.ok(!bar(home), "非编辑态没有那条细栏");
    assert.deepEqual([...home.querySelectorAll(".ns-home-section")].map((e) => e.textContent),
        ["素材与配置", "创作", "编辑"], "版式排到的板块在前，没排的板块按默认序补在末尾");
    assert.deepEqual(cardTitles(home), [
        "素材库", "技能", "设置",
        "生成视频", "生成图片", "导演视频", "3D 姿势", "声音克隆", "提示词增强", "自建卡",
        "图片编辑", "扩图", "机位", "融合", "姿势", "视频抽帧", "图片反推", "视频反推",
    ], "板块序、卡序、隐藏卡与自建卡全按版式出：默认不上首页的局部与删除不铺进网格");
    assert.equal(home.querySelector(".ns-home-hero h1").textContent, "我的首页排版什么？",
        "版式改掉的标题行换掉默认，没改的后缀留默认");
    assert.equal(home.querySelector(".ns-home-hero p").textContent, "一句副标题");
    assert.equal(home.querySelector(".ns-home-cta").textContent, "开工");
    assert.equal(home.querySelector(".ns-home-grid").style.getPropertyValue("--ns-home-cols"), "4",
        "自定义列数要写进网格");

    await enterEdit(home);
    assert.ok(home.querySelector(".ns-home-add-tile"), "网格末尾给出「添加卡片」占位卡");
    assert.ok(cardOf(home, "生成图片").querySelector(".ns-home-card-tools"), "每张卡上长出控件条");
    assert.equal(home.querySelectorAll(".ns-home-section .ns-home-grip").length, 0,
        "板块标题上不长控件：拖动手柄与上下移一起收掉了");
    assert.equal(home.querySelectorAll(".ns-home-section .ns-btn").length, 0,
        "板块标题行里没有钮：整块的移动与收起不在首页上给");
    assert.ok(home.querySelector(".ns-home-edit-entry").textContent.includes("完成"),
        "入口在编辑态就是「完成」：保存与退出收在同一枚钮上");
    assert.ok(bar(home)?.contains(home.querySelector(".ns-home-edit-entry")),
        "「完成」落进细栏这一行：细栏钉在顶缘，滚到哪一屏都点得着");
    assert.equal(window.location.hash, "", "编辑首页留在首页");

    click(colChip(home, 5));
    await flush();
    assert.equal(home.querySelector(".ns-home-grid").style.getPropertyValue("--ns-home-cols"), "5",
        "列数改动实时落在这页上");
    assert.ok(!cardOf(home, "智能体"), "移出首页的内置卡连编辑态也不铺进网格：它在添加卡片这一面等着");
    click(chip(cardOf(home, "生成视频"), "从首页移除这张卡"));
    await flush();
    assert.ok(!dlg(), "删一张内置卡不自动弹「添加卡片」这一面：连删几张卡不是一弹一弹");
    assert.ok(document.getElementById("ns-toast")?.textContent.includes("已移出首页"),
        "移出首页在界面上说一句，指明去哪儿加回来");
    assert.ok(!cardOf(home, "生成视频"), "移出首页的卡不留格子，也不在网格上排回来");
    assert.ok(!cardTitles(home).includes("生成视频"), "首页上不再有这张卡");
    click(gridOf(home, "创作").querySelector(".ns-home-add-tile"));
    await flush();
    assert.ok(presetIn(dlg(), "生成视频"), "自己点开所在板块的「添加卡片」：删掉的那一张就在这面等着加回来");
    click(dlgClose());
    await flush();
    assert.equal(POSTS(), 0, "在页面上排版的这一路不落盘");

    click(cardOf(home, "图片编辑"));
    await settle();
    assert.equal(window.location.hash, "", "编辑态点卡面不跳屏，页面上这份草稿不丢");

    click(home.querySelector(".ns-home-edit-entry"));   // 细栏右端那枚「完成」
    await flush(40);
    assert.equal(lastCall("/neo_home/layout", "POST").method, "POST", "完成一按走一次 POST");
    const sent = lastCall("/neo_home/layout", "POST").body;
    assert.equal(sent.cols, 5, "POST 交的是草稿当前的形状");
    assert.ok(sent.hidden.includes("video"), "草稿里藏掉的卡落进 hidden");
    assert.ok(document.getElementById("ns-toast")?.textContent.includes("已保存"),
        "保存成功要说在界面上：退出之后页面上没有状态行留着");
    assert.ok(!home.classList.contains("ns-home-editing"), "落盘之后编辑态结束");
    assert.ok(!bar(home), "退出编辑那条细栏跟着收掉");
    assert.equal(home.querySelector(".ns-home-grid").style.getPropertyValue("--ns-home-cols"), "5",
        "已保存的排法留在首页上");
});

test("入口全程可点：浏览态、编辑态与保存失败之后都不带 disabled 属性", async () => {
    mountStudio();
    mockLayout({ cols: 4 });
    await importApp();
    await settle();
    const home = homeOf();
    const entry = () => home.querySelector(".ns-home-edit-entry");
    // $el 把白名单外的键一律 setAttribute，disabled:false 写出来就是 disabled="false"：
    // HTML 只看属性在不在 —— 真实浏览器里这颗钮点了没反应，用例的 dispatchEvent 照发不误
    assert.ok(!entry().hasAttribute("disabled"), "浏览态的入口不能带 disabled 属性");
    assert.equal(entry().disabled, false);
    assert.equal(entry().parentElement, home, "浏览态的入口是首页自己的右上角那一颗，跟着页面滚");

    await enterEdit(home);
    assert.ok(!entry().hasAttribute("disabled"), "编辑态那枚「完成」同样不能带 disabled 属性");
    assert.equal(entry().parentElement, bar(home), "编辑态的「完成」在钉住的细栏里：滚到哪一屏都点得着");

    mockRoute("/neo_home/layout", (body, call) => call.method === "POST"
        ? jsonResponse({ success: false, error: "磁盘满了" }, 500)
        : jsonResponse({ cols: 4 }));
    click(entry());
    await flush(40);
    assert.ok(document.getElementById("ns-toast")?.textContent.includes("磁盘满了"), "保存失败要说在界面上");
    assert.ok(home.classList.contains("ns-home-editing"), "保存失败：页面上这份草稿留着");
    assert.ok(!entry().hasAttribute("disabled"), "保存失败之后「完成」要能再点");

    mockLayout({ cols: 4 });   // 盘写得动了：再点一次就落盘退出
    click(entry());
    await flush(40);
    assert.ok(!home.classList.contains("ns-home-editing"), "失败之后照旧保存得下来并退出编辑");
});

test("卡片全移除与板块全收起：首页给出编辑入口的提示，编辑态铺出板块，预设全在添加卡片这一面", async () => {
    mountStudio();
    mockLayout({ hidden: hl.HOME_CARDS.map((c) => c.id), hidden_sections: ["edit"] });
    await importApp();
    await settle();
    const home = homeOf();
    assert.equal(home.querySelectorAll(".ns-home-section").length, 0, "没有卡的板块不留标题");
    assert.ok(home.querySelector(".ns-home-empty")?.textContent.includes("编辑首页"));
    assert.ok(home.querySelector(".ns-home-hero"), "卡片全移除时标题区照出");

    await enterEdit(home);
    assert.equal(home.querySelectorAll(".ns-home-section").length, 3,
        "编辑态铺出全部板块：卡全移出了也要在这页上加回来");
    assert.ok(sectionTitle(home, "编辑").classList.contains("is-off"), "收起的板块标暗留在原位");
    assert.equal(home.querySelectorAll(".ns-home-card").length, 0, "移出首页的卡一张不铺进网格");
    click(gridOf(home, "创作").querySelector(".ns-home-add-tile"));
    await flush();
    assert.deepEqual(presetTitles(dlg()),
        ["生成图片", "生成视频", "导演视频", "3D 姿势", "智能体", "声音克隆", "提示词增强", "特效视频", "宫格图分镜"],
        "这一板块的预设一张不缺：卡全移出时添加卡片就是唯一的来路");
    click(presetIn(dlg(), "生成图片"));
    await flush();
    assert.ok(cardOf(home, "生成图片"), "预设点一下就进首页");
    assert.ok(!presetIn(dlg(), "生成图片"), "加进首页的预设当场从这一面消失：预设不与首页上的卡重复");
    assert.equal(POSTS(), 0, "把卡加回来这一段也不落盘");
    click(dlgClose());
    await flush();
});

test("弃草稿的两条路（Esc / 切页）：首页落回已保存的版式，全程不落盘", async () => {
    mountStudio();
    mockLayout({ sections: ["material", "create"], cols: 4 });
    await importApp();
    await settle();
    const home = homeOf();
    const cols = () => home.querySelector(".ns-home-grid").style.getPropertyValue("--ns-home-cols");

    await enterEdit(home);
    click(colChip(home, 2));
    await flush();
    assert.equal(cols(), "2", "先让草稿的改动在这页上看得见");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    assert.ok(!home.classList.contains("ns-home-editing"), "Esc 退出首页编辑");
    assert.equal(cols(), "4", "首页落回已保存的那一份，页面上那份草稿丢了");

    await enterEdit(home);
    click(colChip(home, 2));
    await flush();
    click(document.querySelector('.ns-tabs a[href="#/paint"]'));
    await settle();
    assert.ok(!home.classList.contains("ns-home-editing"), "切到别的页把编辑态收掉");
    click(document.querySelector('.ns-tabs a[href="#/home"]'));
    await settle();
    assert.ok(!home.classList.contains("ns-home-editing"), "切走再回来不在编辑态：草稿不跨页留着");
    assert.ok(home.querySelector('.ns-home-edit-entry[title^="编辑首页"]'), "切页之后入口回到「编辑首页」");
    assert.equal(cols(), "4", "回到首页看到的是已保存的那一份");
    assert.equal(POSTS(), 0, "Esc 与切页两条弃草稿的路都没落盘");
});

test("就地排版：整张卡拖着排；板块不给控件，旧版式收起的板块在编辑态铺回来、落盘清成展开", async () => {
    mountStudio();
    mockLayout({ hidden_sections: ["edit"] });
    await importApp();
    await settle();
    const home = homeOf();
    assert.ok(![...home.querySelectorAll(".ns-home-section")].some((e) => e.firstChild.textContent === "编辑"),
        "旧版式里收起的板块在首页整块不出");

    await enterEdit(home);

    const paint = cardOf(home, "生成图片");
    assert.equal(paint.querySelectorAll(".ns-home-edit-move").length, 0,
        "卡上不设上下移箭头：卡片排序只有整张卡拖动这一条路");
    assert.equal(paint.draggable, false, "整张卡由 Sortable 拖起来：原生 draggable 关掉，两套手势不能同时开");
    assert.ok(sortableFor(gridOf(home, "创作")), "编辑态的网格接上了 Sortable");
    assert.equal(home.querySelectorAll(".ns-home-section .ns-btn").length, 0,
        "板块标题上没有钮：整块的上下移与收起都不在这页上");
    assert.equal([...home.querySelectorAll(".ns-home-section")].filter((e) => e.draggable).length, 0,
        "板块标题不可拖：拖的只有卡");
    assert.ok(sectionTitle(home, "编辑").classList.contains("is-off"),
        "收起的板块在编辑态铺回来并标暗：这一块的卡照样排得动");
    assert.ok(gridOf(home, "编辑").querySelector(".ns-home-card"), "铺回来的板块里卡一张不少");

    dropAt(cardOf(home, "生成图片"), 1);   // 落位后自己是第 2 格：拖到「导演视频」身上就是这一格
    await flush();
    assert.deepEqual(titlesIn(gridOf(home, "创作")).slice(0, 3), ["生成视频", "生成图片", "导演视频"],
        "整张卡落在第三张那一格就占住它的位置，那张卡往后挪一格");

    click(home.querySelector(".ns-home-edit-entry"));   // 细栏右端那枚「完成」
    await flush(40);
    const sent = lastCall("/neo_home/layout", "POST").body;
    assert.deepEqual(sent.sections, [], "板块不给开关：没动过板块序就交空序，首页按注册表默认序出");
    assert.deepEqual(sent.order.create.slice(0, 3), ["video", "paint", "director"], "卡序落进版式");
    assert.deepEqual(sent.hidden_sections, [], "落盘把旧版式留下的收起状态清成展开");
    assert.deepEqual([...home.querySelectorAll(".ns-home-section")].map((e) => e.firstChild.textContent),
        ["创作", "编辑", "素材与配置"], "落回首页：板块按注册表默认序出，编辑那块又露出来了");
    assert.ok(!home.querySelector(".ns-home-off-tag"), "落回首页：板块不再标「已收起」");
});

test("自动填的形状跟着跳转类型与目标：技能用显示名，配方用名字，链接用域名", () => {
    assert.deepEqual(hl.cardShapeForTarget("skill", "skill_a", "画一张"),
        { title: "画一张", sub: "打开这一发技能的应用页", icon: "wand" });
    assert.deepEqual(hl.cardShapeForTarget("skill", ""),
        { title: "技能", sub: "打开这一发技能的应用页", icon: "wand" },
        "技能是弹窗开局的落点：没选技能时给一张只进技能页的卡");
    assert.deepEqual(hl.cardShapeForTarget("recipe", "我的配方", "我的配方"),
        { title: "我的配方", sub: "多段配方，生成整片视频", icon: "play" });
    assert.deepEqual(hl.cardShapeForTarget("recipe", ""),
        { title: "导演配方", sub: "多段配方，生成整片视频", icon: "play" });
    assert.deepEqual(hl.cardShapeForTarget("url", "https://www.example.com/neo"),
        { title: "example.com", sub: "打开外部链接", icon: "plug" });
    assert.deepEqual(hl.cardShapeForTarget("url", ""),
        { title: "", sub: "打开外部链接", icon: "plug" },
        "地址没填就不编一个标题：空标题由保存门去说");
});

test("自建卡走添加卡片这一面：表单保存才落卡，取消不动草稿，删卡清干净", async () => {
    mountStudio();
    mockLayout({});
    await importApp();
    await settle();
    const home = homeOf();
    const events = [];
    window.addEventListener("neo:home-layout", (e) => events.push(e.detail));
    await enterEdit(home);

    click(home.querySelector(".ns-home-add-tile"));
    await flush();
    assert.ok(dlg(), "占位卡开的是这一面弹窗");
    assert.deepEqual(presetTitles(dlg()), ["特效视频", "宫格图分镜"],
        "创作板块默认不上首页的那两张就在这一面等着加：编辑板块的预设不挤进这一面");
    assert.ok(!dlg().querySelector(".ns-home-preset-empty"), "有预设可加时不给那一句空态");
    assert.equal(home.querySelectorAll(".ns-home-card.is-custom").length, 0, "没保存就不落卡");
    assert.ok(formCard() && fieldIn(dlg(), "跳转类型") && fieldIn(dlg(), "跳转目标"),
        "下半就是这张卡的样子加两行跳转配置：标题与副标题在卡上点字改");

    const url = "https://example.com/neo";
    typeLine(lineIn("ns-home-card-title"), "我的入口");
    click(radioIn("外部链接"));
    await flush();
    const urlInput = fieldIn(dlg(), "链接地址").querySelector("input");
    assert.ok(urlInput, "跳转类型是链接时给地址输入框");
    urlInput.value = url;
    urlInput.dispatchEvent(new Event("change"));
    await flush();
    assert.ok(!dlgBtn("save").disabled, "保存门只把空表单留在页面上");

    click(dlgBtn("save"));
    await flush();
    assert.ok(!dlg(), "保存之后弹窗关掉");
    const tile = cardOf(home, "我的入口");
    assert.ok(tile && tile.classList.contains("is-custom"), "保存之后这张自建卡落进网格");

    click(home.querySelector(".ns-home-add-tile"));
    await flush();
    typeLine(lineIn("ns-home-card-title"), "不要这张");
    click(dlgBtn("cancel"));
    await flush();
    assert.ok(!dlg(), "取消关掉弹窗");
    assert.ok(!cardOf(home, "不要这张"), "取消的这一次不进草稿");
    assert.equal(home.querySelectorAll(".ns-home-card.is-custom").length, 1, "弹窗之前保存的那一张还在");

    assert.equal(cardOf(home, "我的入口").querySelectorAll(".ns-home-card-tools .ns-btn").length, 1,
        "卡上的控件就一枚删除：这张卡没有第二个入口");

    click(home.querySelector(".ns-home-edit-entry"));
    await flush(40);
    const sent = lastCall("/neo_home/layout", "POST").body;
    assert.deepEqual(sent.custom.map((c) => [c.title, c.target, c.url]),
        [["我的入口", "url", url]], "POST 交的是草稿当前的形状");
    assert.equal(events.length, 1, "落盘后广播一次，首页据此重画");
    assert.ok(!home.querySelector(".ns-home-card.is-custom"), "落盘之后编辑态结束，卡面按已保存的版式出");
    assert.ok(cardOf(home, "我的入口"), "已保存的自建卡留在首页上");

    await enterEdit(home);
    click(chip(cardOf(home, "我的入口"), "删除这张卡"));
    await flush();
    assert.equal(home.querySelectorAll(".ns-home-card.is-custom").length, 0, "删自建卡之后卡与草稿一起清干净");
    assert.ok(!dlg(), "删自建卡不开添加卡片这一面：自建卡没有预设可加回来");
    click(home.querySelector(".ns-home-edit-entry"));
    await flush(40);
    assert.deepEqual(lastCall("/neo_home/layout", "POST").body.custom, [],
        "删掉的自建卡从 custom 与 order 里一起清干净");
});

test("跳转类型铺成三颗 radio：开局落在技能，编辑模式与页面直连归预设卡，目标可留不指定", async () => {
    mountStudio();
    mockLayout({});
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "skill_a", cn_name: "画一张" },
    ]));
    await importApp();
    await settle();
    const home = homeOf();
    await enterEdit(home);

    click(home.querySelector(".ns-home-add-tile"));
    await flush();
    const radios = [...fieldIn(dlg(), "跳转类型").querySelectorAll(".ns-home-f-radio")];
    assert.deepEqual(radios.map((b) => b.textContent), ["技能", "导演配方", "外部链接"],
        "自建卡能配的跳转类型铺成三颗：编辑模式与页面直连不在其上——那一发由预设卡给");
    assert.deepEqual(radios.map((b) => b.dataset.value), ["skill", "recipe", "url"]);
    assert.equal(dlg().querySelector(".ns-home-f-radios")?.getAttribute("role"), "radiogroup",
        "三颗是一组 radio：换跳转类型点一下就成，不用先点开下拉再看");
    assert.equal(fieldIn(dlg(), "跳转类型").querySelector('[aria-checked="true"]')?.dataset.value, "skill",
        "开局落在技能：这张页上最常加的就是技能卡，一排里第一颗就是它");
    const targetSel = () => fieldIn(dlg(), "跳转目标").querySelector("select");
    assert.equal(targetSel().options[0].value, "", "开局就是技能：给得出「不指定」，只进技能页的那一张卡");
    assert.equal(targetSel().options[0].textContent, "不指定（只进技能页）");
    assert.ok([...targetSel().options].map((o) => o.textContent).includes("画一张"),
        "技能候选来自技能清单，名字用技能页上的那一份，不自造第二套叫法");

    click(radioIn("导演配方"));
    await flush();
    assert.equal(targetSel().options[0].textContent, "不指定（只进导演页）",
        "配方也给得出「不指定」：只进导演页的那一张卡");
    assert.ok(![...targetSel().options].some((o) => o.value === "skill_a"),
        "配方态的候选里排不出技能项：候选跟着跳转类型走");
    assert.equal(fieldIn(dlg(), "跳转类型").querySelector('[aria-checked="true"]')?.dataset.value, "recipe",
        "一组里只有一颗点实：点过的这颗才是选中的");
    click(radioIn("技能"));
    await flush();

    typeLine(lineIn("ns-home-card-title"), "技能入口");
    pick(targetSel(), "");
    click(dlgBtn("save"));
    await flush();
    assert.ok(!dlg(), "「不指定」的技能卡保存得下来，保存门不拦空目标");
    assert.equal(POSTS(), 0, "弹窗里的保存只改草稿");
    click(home.querySelector(".ns-home-edit-entry"));
    await flush(40);
    assert.deepEqual(lastCall("/neo_home/layout", "POST").body.custom[0].target, "skill");
    assert.equal(lastCall("/neo_home/layout", "POST").body.custom[0].value, "",
        "卡上存的就是「技能 · 不指定」");
});

test("添加卡片这一面铺成一张卡：跳转类型是一排 radio，标题与副标题在卡上点字改", async () => {
    mountStudio();
    mockLayout({});
    await importApp();
    await settle();
    const home = homeOf();
    await enterEdit(home);

    click(gridOf(home, "编辑").querySelector(".ns-home-add-tile"));
    await flush();
    assert.ok(dlg(), "「添加卡片」占位卡开的是这一面弹窗");
    assert.deepEqual(presetTitles(dlg()), ["局部", "删除"],
        "这一板块默认不上首页的那两张就在这一面等着加：默认版式的编辑板块没有空态");
    assert.ok(!dlg().querySelector(".ns-home-preset-empty"), "有预设可加时不给那一句空态");
    assert.deepEqual([...dlg().querySelectorAll(".ns-home-card-dialog-fields > .ns-home-f-field")]
        .map((f) => f.querySelector(".ns-home-f-label")?.textContent), ["跳转类型", "跳转目标"],
        "字段只剩跳转类型与跳转目标这两行：标题、副标题与图标都在卡上改");
    assert.ok(!fieldIn(dlg(), "板块"),
        "板块不给下拉：卡落在点开的那张占位卡的板块，要换板块就在这页上把卡拖过去");

    const title = lineIn("ns-home-card-title");
    const sub = lineIn("ns-home-card-sub");
    assert.equal(title.getAttribute("contenteditable"), "plaintext-only",
        "标题与副标题就长在卡上点字直接改：与首页标题区那一套同一走法");
    assert.equal(sub.getAttribute("contenteditable"), "plaintext-only");
    assert.equal(title.textContent, "技能", "新建开局按这一发落点（技能 · 不指定）填好标题");
    assert.equal(sub.textContent, "打开这一发技能的应用页");
    assert.equal(iconPick(), "wand", "新建开局挑着的就是这一发的那一枚图标");
    assert.equal(iconTile().dataset.icon, "wand", "卡上那枚图标就是当前挑着的这一枚");
    assert.ok(!dlg().querySelector(".ns-home-form-preview.is-open"),
        "图标候选默认收起：这一面开局不铺一整排图标格");

    click(radioIn("外部链接"));
    await flush();
    assert.equal(lineIn("ns-home-card-title").textContent, "",
        "换了跳转类型：地址没填就不编一个标题，空标题由保存门去说");
    assert.equal(iconTile().dataset.icon, "plug", "换了跳转类型：卡上那枚图标跟着这一发换");

    typeLine(lineIn("ns-home-card-sub"), "我的格子副标题");
    click(radioIn("导演配方"));
    await flush();
    assert.equal(lineIn("ns-home-card-sub").textContent, "我的格子副标题", "点字改过的副标题自动填不覆盖");
    assert.equal(iconPick(), "play", "没碰过的图标换成这一发的");

    click(dlgBtn("cancel"));
    await flush();
    assert.ok(!dlg(), "取消关掉这一面，自动填的那些没进草稿");
    assert.equal(home.querySelectorAll(".ns-home-card.is-custom").length, 0, "没保存就不落卡");
});

test("图标候选收在卡上那枚图标后面：点一下才展开，挑完收起且不覆盖点过的", async () => {
    mountStudio();
    mockLayout({});
    await importApp();
    await settle();
    const home = homeOf();
    await enterEdit(home);
    click(gridOf(home, "编辑").querySelector(".ns-home-add-tile"));
    await flush();

    const swatches = [...dlg().querySelectorAll(".ns-home-f-icons .ns-home-icon-swatch")];
    assert.ok(swatches.length >= 20, "候选是一格一格的图标，不是一行文字");
    assert.ok(swatches.every((b) => b.querySelector("svg")), "格子里是图标本身：图标名只在 tooltip 上");
    assert.ok(!dlg().querySelector(".ns-home-form-preview.is-open"), "默认收起：这一面不常驻一整排图标格");

    click(iconTile());
    await flush();
    assert.ok(dlg().querySelector(".ns-home-form-preview.is-open"), "点卡上那枚图标才展开候选");
    click(swatches.find((b) => b.dataset.icon === "camera"));
    await flush();
    assert.equal(iconPick(), "camera", "点一下就把这一枚选上");
    assert.equal(dlg().querySelectorAll('.ns-home-f-icons [aria-pressed="true"]').length, 1,
        "图标格子里只有一枚是选中的");
    assert.equal(iconTile().dataset.icon, "camera", "收起之后卡上那枚就是挑中的这一枚");
    assert.ok(!dlg().querySelector(".ns-home-form-preview.is-open"), "挑完自动收起：这一面回到一张卡的样子");

    click(radioIn("导演配方"));
    await flush();
    assert.equal(iconPick(), "camera", "点过的图标自动填不覆盖");
    click(dlgBtn("cancel"));   // 用例收尾把弹窗关掉：弹窗的 Esc 绑在 document 上，带着开着弹窗的实例会吃掉下一个用例的 Esc
    await flush();
});

test("自动填落下的图标都在图标格子那把候选里：落点填的那一枚必定点得着", () => {
    for (const card of hl.HOME_CARDS) {
        assert.ok(hl.CARD_ICONS.includes(card.icon), `内置卡的图标不在候选里：${card.icon}`);
    }
    for (const shape of [hl.cardShapeForTarget("recipe", "我的配方", "我的配方"),
        hl.cardShapeForTarget("skill", "s_a", "画一张"),
        hl.cardShapeForTarget("url", "https://ex.com/a")]) {
        assert.ok(hl.CARD_ICONS.includes(shape.icon), `自动填落下的图标不在候选里：${shape.icon}`);
    }
});

test("旧版式里的直连卡与编辑模式卡：照读照跳照删，弹窗不再产出这一类", async () => {
    mountStudio();
    mockLayout({ custom: [
        { id: "custom_legacy", section: "create", title: "旧直连卡", target: "page", value: "settings" },
        { id: "custom_edit", section: "create", title: "旧编辑卡", target: "edit", value: "angle" },
    ] });
    await importApp();
    await settle();
    const home = homeOf();
    assert.ok(cardOf(home, "旧直连卡") && cardOf(home, "旧编辑卡"),
        "旧版式里 target=page / target=edit 的自建卡照旧出在首页上：一次保存不能静默丢掉它们");

    click(cardOf(home, "旧直连卡"));
    await settle();
    assert.equal(window.location.hash, "#/settings", "直连卡照旧跳到那一页");
    click(document.querySelector('.ns-tabs a[href="#/home"]'));
    await settle();

    await enterEdit(home);
    click(chip(cardOf(home, "旧直连卡"), "删除这张卡"));
    await flush();
    click(chip(cardOf(home, "旧编辑卡"), "删除这张卡"));
    await flush();
    assert.equal(home.querySelectorAll(".ns-home-card.is-custom").length, 0,
        "旧卡照样删得掉：删一张就是清掉 custom 与 order 里那一条");
    assert.ok(!dlg(), "删自建卡不开添加卡片这一面：自建卡没有预设可加回来");
    click(home.querySelector(".ns-home-edit-entry"));
    await flush(40);
    assert.deepEqual(lastCall("/neo_home/layout", "POST").body.custom, [], "落盘的形状里没有这两张旧卡");
});

test("技能卡的落点是应用页：生图技能进输入页，视频技能进出视频页那一发，增强技能进提示词增强页，任务技能落技能页；声明了落地页就落那一页", async () => {
    mountStudio();
    mockLayout({ custom: [
        { id: "custom_img", section: "create", title: "生图技能卡", sub: "打开这一发技能的应用页", target: "skill", value: "skill_img" },
        { id: "custom_video", section: "create", title: "视频技能卡", sub: "打开这一发技能的应用页", target: "skill", value: "skill_video" },
        { id: "custom_none", section: "create", title: "增强技能卡", sub: "打开这一发技能的应用页", target: "skill", value: "skill_none" },
        { id: "custom_task", section: "create", title: "任务技能卡", sub: "打开这一发技能的应用页", target: "skill", value: "skill_task" },
        { id: "custom_land", section: "create", title: "声明落地页的卡", sub: "打开这一发技能的应用页", target: "skill", value: "skill_land" },
        { id: "custom_badland", section: "create", title: "落地页写歪的卡", sub: "打开这一发技能的应用页", target: "skill", value: "skill_badland" },
        { id: "custom_lv", section: "create", title: "声明视频页的卡", sub: "打开这一发技能的应用页", target: "skill", value: "skill_lv" },
        { id: "custom_lp", section: "create", title: "声明绘画页的卡", sub: "打开这一发技能的应用页", target: "skill", value: "skill_lp" },
        { id: "custom_le", section: "create", title: "声明增强页的卡", sub: "打开这一发技能的应用页", target: "skill", value: "skill_le" },
        { id: "custom_out", section: "create", title: "扩图技能卡", sub: "打开这一发技能的应用页", target: "skill", value: "qwen_image_21_outpaint" },
        { id: "custom_edit", section: "create", title: "编辑技能卡", sub: "打开这一发技能的应用页", target: "skill", value: "skill_edit_plain" },
        { id: "custom_voice", section: "create", title: "声明语音页的卡", sub: "打开这一发技能的应用页", target: "skill", value: "skill_voice" },
        { id: "custom_written", section: "create", title: "自己写过副标题的卡", sub: "我自己写的一句话", target: "skill", value: "skill_img" },
    ] });
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "skill_img", gen_image: true },
        { id: "skill_video", gen_video: true, mode: "t2v" },
        { id: "skill_none" },
        { id: "skill_task", category: "task" },
        { id: "skill_land", landing: "storyboard" },
        { id: "skill_badland", landing: "not_a_page", gen_image: true },
        { id: "skill_lv", landing: "video", gen_video: true, mode: "t2v" },
        { id: "skill_lp", landing: "paint", gen_image: true },
        { id: "skill_le", landing: "enhance" },
        { id: "qwen_image_21_outpaint", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
        { id: "skill_edit_plain", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
        { id: "skill_voice", landing: "voice" },
        { id: "add_img", category: "image_gen", gen_image: true },
        { id: "add_video", gen_video: true, mode: "t2v" },
        { id: "add_none", gen_text: true },
        { id: "add_task", category: "task", task: true },
        { id: "add_land_voice", landing: "voice" },
        { id: "add_land_page", landing: "storyboard" },
        { id: "qwen_image_21_local_edit", category: "image_gen", gen_image: true, mode: "local", requires_ref: true },
        { id: "add_edit_plain", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
    ]));
    mockRoute("/neo_video_gen/models", () => jsonResponse({
        diffusion_models: [], text_encoders: [], vae: [], loras: [],
    }));
    mockRoute("/neo_image_gen/skill_config", () => jsonResponse({}));
    await openStudio("");
    const home = homeOf();
    const goHome = async () => {
        click(document.querySelector('.ns-tabs a[href="#/home"]'));
        await settle();
    };

    click(cardOf(home, "视频技能卡"));
    await settle();
    assert.equal(window.location.hash, "#/video",
        "视频技能卡直接跳到出视频页：这一版页没建过也照跳，不被「未就绪」卡住");
    assert.equal(document.querySelector(".ns-video .ns-video-skill")?.value, "skill_video",
        "那一发要把技能选中在视频页里");
    assert.ok(![...document.querySelectorAll(".neo-at-summary")].some((e) => e.textContent.includes("出视频页尚未就绪")),
        "交得出去就不说「出视频页尚未就绪」");

    click(cardOf(home, "生图技能卡"));
    await settle();
    assert.equal(window.location.hash, "#/paint", "生图技能卡进的是输入页那一发");
    await goHome();

    // 只能带参考图的编辑技能在输入页那块面板的候选里没有位置：落图片编辑页，对得上一发模式的连模式一起切
    click(cardOf(home, "扩图技能卡"));
    await settle();
    await sleep(120);   // 技能下拉是异步填的：切模式那一下赋的技能值要等列表落位
    assert.equal(window.location.hash, "#/edit", "只能带参考图的编辑技能落图片编辑页");
    assert.equal(document.querySelector(".ns-paint-edit .neo-gallery-edit-mode-select")?.value, "outpaint",
        "扩图技能要把页面切在扩图那一发");
    assert.equal(document.querySelector(".ns-paint-edit .neo-gallery-gm-skill-sel")?.value, "qwen_image_21_outpaint",
        "那一发要把这张技能选中");
    await goHome();

    click(cardOf(home, "编辑技能卡"));
    await settle();
    await sleep(120);
    assert.equal(window.location.hash, "#/edit", "对不上一发模式的编辑技能也落图片编辑页");
    assert.equal(document.querySelector(".ns-paint-edit .neo-gallery-edit-mode-select")?.value, "outpaint",
        "落点只把技能填进面板，不动用户那一发的模式");
    assert.equal(document.querySelector(".ns-paint-edit .neo-gallery-gm-skill-sel")?.value, "skill_edit_plain",
        "技能选中在这块面板上");
    await goHome();

    click(cardOf(home, "增强技能卡"));
    await settle();
    assert.equal(window.location.hash, "#/enhance",
        "增强类技能（含没写分类的那一类）落提示词增强页：这一页的技能 chip 就收这一池");
    assert.ok(document.querySelector(".ns-enhance-stage"), "增强落点那一页要真挂在面前");

    const taskToastBefore = document.getElementById("ns-toast")?.textContent;
    click(cardOf(home, "任务技能卡"));
    await settle();
    assert.equal(window.location.hash, "#/skills", "任务类技能三处落点都没有位置，落技能页");
    assert.notEqual(document.getElementById("ns-toast")?.textContent, taskToastBefore,
        "没有可直达的应用页这件事要在界面上说出来");

    // 技能 frontmatter 里的 landing 说了算：这张技能声明落宫格图分镜页，就不走那两条启发
    const toastTextBefore = document.getElementById("ns-toast")?.textContent;
    click(cardOf(home, "声明落地页的卡"));
    await settle();
    assert.equal(window.location.hash, "#/storyboard", "技能写了 landing 就落它声明的那一页");
    assert.ok(document.querySelector(".ns-storyboard"), "落点那一页要真挂在面前");
    assert.equal(document.getElementById("ns-toast")?.textContent, toastTextBefore,
        "落到了声明的那一页，就不报「没有可直达的应用页」");
    await goHome();

    click(cardOf(home, "落地页写歪的卡"));
    await settle();
    assert.equal(window.location.hash, "#/paint",
        "landing 写了注册表认不出的一名就当没写：生图技能照旧进输入页");
    await goHome();

    // 三发真实落点：声明视频页走的就是出视频那一发（技能选中在页里），声明绘画页进输入页，
    // 声明增强页进提示词增强页——落点与启发同页时也照声明走
    click(cardOf(home, "声明视频页的卡"));
    await settle();
    assert.equal(window.location.hash, "#/video", "landing=video 进出视频页");
    assert.equal(document.querySelector(".ns-video .ns-video-skill")?.value, "skill_lv",
        "声明的落点是视频页时，那一发把这张技能选中在页里");
    await goHome();

    click(cardOf(home, "声明绘画页的卡"));
    await settle();
    assert.equal(window.location.hash, "#/paint", "landing=paint 进输入页那一发");
    await goHome();

    const toastBeforeEnh = document.getElementById("ns-toast")?.textContent;
    click(cardOf(home, "声明增强页的卡"));
    await settle();
    assert.equal(window.location.hash, "#/enhance",
        "增强技能声明了 enhance 就落增强页：落点与启发同页时也照声明走");
    assert.ok(document.querySelector(".ns-enhance-stage"), "落点那一页要真挂在面前");
    assert.equal(document.getElementById("ns-toast")?.textContent, toastBeforeEnh,
        "落到了声明的那一页，就不报「没有可直达的应用页」");

    // 声明语音页的技能落语音页：语音页写死用 cosyvoice_voice，落过去就是点即用
    click(cardOf(home, "声明语音页的卡"));
    await settle();
    assert.equal(window.location.hash, "#/voice", "landing=voice 进语音页那一发");
    await goHome();

    // 卡上那一句在「添加卡片」落盘那一步就按落点写好，首页渲染只读版式里存的这一句：
    // 表单里选上技能，卡预览落的就是那一页的那句话；人在预览里点字写过的，落盘也还是他写的那一句
    await enterEdit(home);
    click(gridOf(home, "创作").querySelector(".ns-home-add-tile"));
    await flush();
    const addSel = () => fieldIn(dlg(), "跳转目标").querySelector("select");
    const addSub = () => lineIn("ns-home-card-sub").textContent;
    const pickAdd = async (id) => { pick(addSel(), id); await flush(); };
    await pickAdd("add_video");
    assert.equal(addSub(), "进出视频页，这一发直接排成片子", "落视频页的技能写进出视频页这一发");
    await pickAdd("add_land_voice");
    assert.equal(addSub(), "进语音页，用克隆出的音色念这段字", "声明语音页的写克隆音色念这段字");
    await pickAdd("add_land_page");
    assert.equal(addSub(), "进「宫格图分镜」那一页", "落点是别的注册表页时报那一页的页名");
    await pickAdd("qwen_image_21_local_edit");
    assert.equal(addSub(), "进图片编辑 · 局部那一发", "对得上一发模式的编辑技能写那一发");
    await pickAdd("add_edit_plain");
    assert.equal(addSub(), "进图片编辑，带一张参考图改这一张", "对不上一发模式的编辑技能只说落图片编辑");
    await pickAdd("add_none");
    assert.equal(addSub(), "进提示词增强页，先把这一发润色到位", "落增强页的卡写先把这一发润色");
    await pickAdd("add_task");
    assert.equal(addSub(), "先进技能页，在这一叠里挑着用它", "没有可直达应用页的技能写先进技能页");
    await pickAdd("add_img");
    assert.equal(addSub(), "进输入页，写下画面就出图", "落输入页的卡写写下画面就出图");
    typeLine(lineIn("ns-home-card-sub"), "我自己写的一句话");
    await pickAdd("add_land_voice");
    assert.equal(addSub(), "我自己写的一句话", "点字写过的副标题自动填换不掉");
    click(dlgBtn("save"));
    await flush();
    click(home.querySelector(".ns-home-edit-entry"));
    await flush(40);
    const savedAdd = lastCall("/neo_home/layout", "POST").body.custom.at(-1);
    assert.deepEqual([savedAdd.value, savedAdd.sub], ["add_land_voice", "我自己写的一句话"],
        "落盘的就是这一张卡：跳转目标写它落的那一页，人写过的那一句副标题原样落盘");
});

test("落位搬运：同板块按格子落位，自建卡能落进别的板块，内置卡落不出板块", async () => {
    mountStudio();
    mockLayout({ custom: [{ id: "custom_move", section: "create", title: "搬运卡", target: "page", value: "settings" }] });
    await importApp();
    await settle();
    const home = homeOf();
    await enterEdit(home);

    const create = gridOf(home, "创作");
    assert.ok(sortableFor(create), "编辑态的网格接上 Sortable：让位动画与跨板块搬运都是它的内建");
    assert.equal(new Set(sortables.map((s) => s.opts.group)).size, 1, "三条网格同一个组：自建卡能在板块之间搬");
    assert.equal(sortableFor(create).opts.animation, 150, "让位动画由 Sortable 排：一格 150ms 的滑");
    assert.equal(sortableFor(create).opts.draggable, ".ns-home-card", "只有卡能拖：「添加卡片」占位与板块不参与");
    assert.match(sortableFor(create).opts.ignore, /ns-home-card-tools/,
        "只挡卡上那排控件：卡面本身是 button，ignore 里写 button 会把整张卡的拖动一起挡掉");
    assert.equal(sortableFor(create).opts.forceFallback, true,
        "落位走 Sortable 自己的鼠标兜底：影子与让位动画归它，桌面窗口与自动化里同一套走法");

    sortableFor(create).opts.onStart({ item: cardOf(home, "生成图片") });
    assert.ok(bar(home).textContent.includes("内置卡只能在本板块内排序"), "内置卡拖起来就这一句话告诉用户，不让人试");
    sortableFor(create).opts.onStart({ item: cardOf(home, "搬运卡") });
    assert.equal(bar(home).querySelector(".ns-home-edit-status").textContent, "", "自建卡不用提示");

    dropAt(cardOf(home, "生成图片"), 1);
    const after = gridOf(home, "创作");   // 落位后首页按草稿重画：断言落在新画出来的那条网格上
    assert.deepEqual(titlesIn(after).slice(0, 3), ["生成视频", "生成图片", "导演视频"],
        "落在哪一格就插进那一格，其余卡往后挪一格");
    assert.equal(sortableFor(create).destroys, 1,
        "上一轮的网格在重画那一刻还挂在文档里：它的实例要收掉（离屏的就不收——Sortable 的 destroy 要写 el.parentNode，离屏元素上直接抛）");
    assert.ok(sortableFor(after), "落位重画出的新网格当场接上新实例");

    const keep = titlesIn(gridOf(home, "创作"));
    const back = dropAt(cardOf(home, "生成视频"), 0, gridOf(home, "编辑"));
    assert.equal(back.cancels, 1, "内置卡落进别的板块：Sortable 退回原位");
    assert.deepEqual(titlesIn(gridOf(home, "创作")), keep, "草稿没动：板块里的卡还在板块里");

    dropAt(cardOf(home, "搬运卡"), 0, gridOf(home, "编辑"));
    assert.ok(titlesIn(gridOf(home, "编辑")).includes("搬运卡"), "自建卡落进「编辑」板块落位");
    assert.ok(!titlesIn(gridOf(home, "创作")).includes("搬运卡"));

    dropAt(cardOf(home, "生成图片"), 6);   // 落在这一版最后一格
    assert.deepEqual(titlesIn(gridOf(home, "创作")).slice(-1), ["生成图片"], "落在最后一格就是排到最后");

    click(home.querySelector(".ns-home-edit-entry"));
    await flush(40);
    const sent = lastCall("/neo_home/layout", "POST").body;
    assert.equal(sent.custom[0].section, "edit", "搬过去的板块落进版式");
    assert.ok(sent.order.edit.includes("custom_move"));
    assert.ok(!sent.order.create.includes("custom_move"));
    assert.deepEqual(sent.order.create, ["video", "director", "pose", "agent", "voice", "prompt-enhance", "paint"], "落位的格子序落进版式");
});

test("标题区就地改字：点字直接改，失焦写进草稿，收起的标题区留在这页上", async () => {
    mountStudio();
    mockLayout({});
    await importApp();
    await settle();
    const home = homeOf();
    await enterEdit(home);

    const hero = home.querySelector(".ns-home-hero");
    assert.equal(hero.querySelectorAll("[contenteditable]").length, 5,
        "大标题三段、副标题与出图按钮在编辑态都是点字直接改的");
    assert.equal(hero.querySelector('[data-hero-key="cta"]').getAttribute("contenteditable"), "plaintext-only");

    const accent = hero.querySelector('[data-hero-key="accent"]');
    accent.textContent = "  拍片  ";
    accent.dispatchEvent(new Event("blur"));
    await flush();
    assert.equal(home.querySelector(".ns-home-accent").textContent, "拍片", "失焦写进草稿并即时重画");

    const suffix = home.querySelector('[data-hero-key="suffix"]');
    suffix.textContent = "   ";
    suffix.dispatchEvent(new Event("blur"));
    await flush();
    assert.ok(home.querySelector(".ns-home-hero h1").textContent.includes("什么？"),
        "清空一行等于落回注册表默认文案");

    click(barBtn(home, "hero"));
    await flush();
    assert.ok(home.querySelector(".ns-home-hero").classList.contains("is-off"),
        "收起的标题区标暗留在这页上：开关就在这条细栏上");
    click(barBtn(home, "hero"));
    await flush();
    assert.ok(!home.querySelector(".ns-home-hero").classList.contains("is-off"));
    click(barBtn(home, "cta"));
    await flush();
    assert.ok(home.querySelector(".ns-home-cta"),
        "编辑态的出图按钮留在页上：收掉了也得能在这页上按回来");

    assert.equal(POSTS(), 0, "改字这一段不落盘");
    click(home.querySelector(".ns-home-edit-entry"));
    await flush(40);
    const sent = lastCall("/neo_home/layout", "POST").body;
    assert.equal(sent.hero.accent, "拍片");
    assert.equal(sent.hero.suffix, undefined, "空文案不落进版式");
    assert.equal(sent.hero.cta_off, true);
    assert.equal(sent.hero.off, false, "展开的标题区把 off 记成 false：读回来就是展开");
    assert.ok(!home.classList.contains("ns-home-editing"), "落盘之后编辑态结束");
    assert.ok(!home.querySelector(".ns-home-cta"), "已保存的收起状态落回首页：出图按钮不在了");
});

test("恢复默认：细栏一按，首页落回注册表版式并广播空版式", async () => {
    mountStudio();
    mockLayout({
        sections: ["material", "edit", "create"],
        custom: [{ id: "custom_x", section: "create", title: "自建卡", target: "page", value: "paint" }],
        hero: { title: "改过的标题" },
    });
    await importApp();
    await settle();
    const home = homeOf();
    const events = [];
    window.addEventListener("neo:home-layout", (e) => events.push(e.detail));
    assert.ok(home.querySelector(".ns-home-hero h1").textContent.startsWith("改过的标题"));
    assert.ok(cardOf(home, "自建卡"));

    await enterEdit(home);
    click(barBtn(home, "reset"));
    await flush(40);
    assert.equal(lastCall("/neo_home/layout/reset", "POST").path, "/neo_home/layout/reset", "恢复默认走 reset");
    assert.equal(events.length, 1, "广播一次落回来的版式");
    assert.deepEqual(events[0].sections, [], "广播空版式，首页按注册表默认重画");
    assert.equal(home.querySelector(".ns-home-hero h1").textContent, "今天想创作什么？", "标题区落回默认文案");
    assert.ok(!cardOf(home, "自建卡"), "自建卡跟着版式一起清掉");
    assert.ok(!home.classList.contains("ns-home-editing"), "恢复默认之后编辑态结束");
});



test("版式文件落点：前端交出去的形状经后端写盘，恢复默认删掉文件", () => {
    const payload = {
        sections: ["edit", "create"],
        hidden_sections: ["material"],
        order: { create: ["video", "paint"], edit: ["merge"] },
        hidden: ["video"],
        cols: 5,
        hero: { title: "自定义大标题", sub: "一行副标题", off: false, cta_off: true },
        custom: [{ id: "custom_live", section: "create", title: "自建卡", target: "url", url: "https://example.com/a" }],
    };
    const saved = pyBridge("h.save_layout(payload)", payload);
    assert.equal(JSON.parse(fs.readFileSync(LAYOUT_FILE, "utf8")).cols, 5, "文件落在 configs/home_layout.json");
    assert.deepEqual(pyBridge("h.get_layout()"), saved, "读回来的是归一化后的那一份");
    assert.equal(pyBridge("h.get_layout()[\"hero\"][\"cta_off\"]"), true);
    assert.equal(pyBridge("h.get_layout()[\"custom\"]")[0].url, "https://example.com/a");
    pyBridge("h.reset_layout()");
    assert.equal(fs.existsSync(LAYOUT_FILE), false, "恢复默认删文件，首页落回注册表版式");
});

test("首页原地编辑的文案在英文界面也有话可说", () => {
    const src = fs.readFileSync(path.join(webDir, "studio", "home-layout.js"), "utf8");
    const en = fs.readFileSync(path.join(webDir, "js", "core", "i18n.js"), "utf8");
    const literals = [...src.matchAll(/\bt[fa]?\(\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(literals.length > 20, "文案应直接从 t() 字面量里扫");
    assert.deepEqual(literals.filter((s) => !en.includes(`"${s}"`)), [], "英文字典缺项会在英文界面落回中文");
    const app = fs.readFileSync(path.join(webDir, "studio", "pages", "home-page.js"), "utf8");
    const landing = fs.readFileSync(path.join(webDir, "studio", "skill-landing.js"), "utf8");
    for (const s of ["编辑首页", "完成", "完成首页编辑：保存版式并退出", "已收起",
        "首页卡片已全部移除，在「编辑首页」的添加卡片里加回来。",
        "已保存：插件页、桌面窗口与手机页的首页同步生效", "保存失败：{msg}",
        "这张技能没有可直达的应用页（不是生图 / 生视频 / 提示词增强技能），先进技能页"]) {
        assert.ok(app.includes(`"${s}"`) && en.includes(`"${s}"`), `首页编辑文案缺英文项：${s}`);
    }
    // 落点副标题那几句写在 skill-landing.js：添加卡片落盘时与首页渲染读的都是这一份
    for (const s of ["打开这一发技能的应用页", "进出视频页，这一发直接排成片子", "进输入页，写下画面就出图",
        "进图片编辑，带一张参考图改这一张", "进图片编辑 · {mode}那一发",
        "进提示词增强页，先把这一发润色到位", "进语音页，用克隆出的音色念这段字",
        "先进技能页，在这一叠里挑着用它", "进「{page}」那一页"]) {
        assert.ok(landing.includes(`"${s}"`) && en.includes(`"${s}"`), `落点副标题缺英文项：${s}`);
    }
    for (const s of ["保存版式", "完成首页编辑（Esc）", "右下角「编辑首页」", "收起板块", "下移板块"]) {
        assert.ok(!app.includes(`"${s}"`) && !src.includes(`"${s}"`),
            `细栏保存与板块开关的文案应跟着控件一起删掉：${s}`);
    }
    for (const s of ["隐藏这张卡", "显示这张卡", "编辑这张卡", "编辑卡片", "新卡片",
        "在这板块末尾加一张自建卡", "选一个编辑模式", "跳转类型要一个目标", "页面（旧版直连）"]) {
        assert.ok(!src.includes(`"${s}"`) && !en.includes(`"${s}"`),
            `显隐眼睛与铅笔编辑这条路的文案应跟着控件一起删掉：${s}`);
    }
    for (const s of ["预设卡片", "自建卡片", "从首页移除这张卡", "加到首页：{title}",
        "这张卡已移出首页：在「添加卡片」里加回来",
        "这一板块的预设卡片都已在首页：先在首页删掉一张，再回到这里加回来",
        "自建卡最多 {n} 张，先删一张", "换图标", "写一个名字", "写一句副标题"]) {
        assert.ok(src.includes(`"${s}"`) && en.includes(`"${s}"`), `添加卡片这一面的文案缺英文项：${s}`);
    }
    for (const s of ["技能", "导演配方", "外部链接"]) {
        assert.ok(en.includes(`"${s}"`), `跳转类型那一排 radio 的文案缺英文项：${s}`);
    }
    assert.ok(!src.includes('t("板块")') && !en.includes('"板块"'),
        "板块选择的文案应跟着那枚下拉一起删掉：界面上不再有那枚下拉");
    assert.ok(!src.includes('t("图标")') && !src.includes('t("标题")') && !src.includes('t("副标题")')
        && !en.includes('"图标"') && !en.includes('"标题"') && !en.includes('"副标题"'),
        "标题 / 副标题 / 图标的字段标签应跟着那三行输入框一起删掉：这三样在卡上点字改");
    assert.ok(!app.includes('"自定义首页"'), "「设置 → 首页」深链入口的文案应跟着那条 tab 一起清掉");
    assert.ok(!app.includes("?skill="), "技能卡落应用页，不再走技能页的深链参数");
});

test("首页版式的 CSS 挂点：列数走自定义属性，卡上的控件与细栏各有自己的样式", () => {
    const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
    const src = fs.readFileSync(path.join(webDir, "studio", "home-layout.js"), "utf8");
    assert.match(css, /--ns-home-cols/, "网格列数由版式写进自定义属性");
    assert.match(css, /\.ns-home-edit-entry\s*\{/, "首页右上角的编辑入口应有自己的样式");
    assert.ok(/\.ns-home-edit-entry\s*\{[^}]*position:\s*absolute/.test(css)
        && /\.ns-home\s*\{[^}]*position:\s*relative/.test(css),
        "入口站在首页自己的右上角：首页这一层是定位父级，入口落在滚动内容里跟着页面走");
    assert.ok(!/\.ns-home-edit-entry\s*\{[^}]*(position:\s*fixed|position:\s*sticky|bottom:)/.test(css),
        "入口不常驻在窗口上：不 fixed、不 sticky、不钉右下角，滚出首屏就不见");
    assert.ok(/\.ns-home-edit-bar \.ns-home-edit-entry\s*\{[^}]*position:\s*static/.test(css)
        && !/\.ns-home-edit-bar \.ns-home-edit-entry\s*\{[^}]*margin-left:\s*auto/.test(css),
        "「完成」就是栏里那一行末尾的那一枚：细栏收成小组后它自然贴着右端，不在栏里占整段");
    assert.ok(/\.ns-home-edit-bar\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/.test(css),
        "编辑态那条细栏钉在首页顶缘，滚到哪一屏都够得着列数与恢复默认");
    assert.ok(/\.ns-home-edit-bar\s*\{[^}]*width:\s*fit-content/.test(css)
        && /\.ns-home-edit-bar\s*\{[^}]*margin:\s*0 0 14px auto/.test(css),
        "细栏整块收成小组贴在首页右上角：栏不吃整条宽度，左外边距 auto 把它推到右端");
    assert.ok(/\.ns-home-edit-bar\s*\{[^}]*max-width:\s*100%/.test(css)
        && /\.ns-home-edit-bar\s*\{[^}]*flex-wrap:\s*wrap/.test(css),
        "窄窗口里细栏自己换行：收成小组也不溢出窗口，不把整页顶走");
    assert.match(css, /\.ns-home-card-tools\s*\{/, "卡上的控件条应有自己的样式");
    assert.ok(!css.includes("is-hidden-card"), "幽灵位与显隐眼睛的样式应跟着那枚控件一起删掉");
    assert.match(css, /\.ns-home-add-tile\s*\{/, "网格末尾的添加卡片占位卡应有自己的样式");
    assert.match(css, /\.ns-home-card-dialog\s*\{/, "添加卡片这一面应有自己的层级与遮罩");
    assert.ok(/\.ns-home-card-dialog-body\s*\{[^}]*overflow:\s*auto/.test(css),
        "这一面自己滚动：预设与表单叠在一处，窗口矮了不溢出盒子");
    assert.ok(/\.ns-home-preset-grid\s*\{[^}]*grid-template-columns/.test(css)
        && /@media \(max-width: 720px\)[\s\S]{0,600}\.ns-home-preset-grid\s*\{[^}]*minmax\(0, 1fr\)/.test(css),
        "预设排两格一行，窄窗口里收成一行一格");
    assert.ok(/\.ns-home-preset-card\s*\{[^}]*border:\s*1px solid/.test(css)
        && /\.ns-home-preset-card:hover\s*\{[^}]*border-color:\s*var\(--ns-accent\)/.test(css),
        "预设卡是一枚点得着的卡：描边在 hover 上点亮");
    assert.match(css, /\.ns-home-preset-empty\s*\{/, "预设都已在首页时的空态应有自己的样式");
    assert.match(css, /\.ns-home-card-dialog-body\s*\{[^}]*gap:\s*14px/,
        "预设区与自建卡区之间空一档：两块的标题与内容不挤在一起");
    assert.match(css, /\.ns-home-card-dialog-fields\s*\{[^}]*flex-direction:\s*column/,
        "弹窗下半一行一行排下来：预览卡、跳转类型、跳转目标各占一行");
    assert.ok(/\.ns-home-form-card\s*\{[^}]*width:\s*fit-content/.test(css)
        && /\.ns-home-preset-card\s*\{[^}]*width:\s*fit-content/.test(css),
        "预览卡与预设卡都按内容收成宽：卡面不拖出整条弹窗宽的那两行空白");
    assert.ok(/\.ns-home-f-select\s*\{[^}]*flex:\s*none[^}]*max-width:\s*100%/.test(css)
        && /\.ns-home-f-input\s*\{[^}]*flex:\s*1 1 auto/.test(css),
        "跳转目标收成最长的一项那么宽：铺满整行时这一行只有「跳转目标」四个字，拖出一条长条；地址框留长，粘贴一条长 URL 要放得下");
    assert.ok(!/\.ns-home-f-field:nth-child\(4n/.test(css),
        "字段行由弹窗结构排出来：字段不再靠 nth-child 跨列");
    assert.match(css, /\.ns-home-card-dialog-foot\s*\{/, "弹窗脚一行管状态与保存取消");
    assert.ok(/\.ns-home-form-icons\s*\{[^}]*display:\s*none/.test(css)
        && /\.ns-home-form-preview\.is-open \.ns-home-form-icons\s*\{[^}]*display:\s*flex/.test(css),
        "图标候选默认收起：点卡上那枚图标才展开这一把格子");
    assert.ok(!css.includes(".ns-home-f-icons-field") && !src.includes("inlineIconPicker"),
        "常驻展开的图标格选择面应跟着那四行表单一起收掉");
    assert.ok(/\.ns-home-icon-swatch\s*\{[^}]*width:\s*34px/.test(css)
        && /\.ns-home-f-icons\s*\{[^}]*flex-wrap:\s*wrap/.test(css),
        "一格 34px、排满就换行：展开的那 25 枚图标落几行才点得准");
    assert.ok(/\.ns-home-icon-swatch\.is-on\s*\{[^}]*border-color:\s*var\(--ns-accent\)/.test(css),
        "选中的那一枚描边点亮：一眼看得出选的是哪枚");
    assert.ok(/\.ns-home-f-radios-field\s*\{[^}]*grid-column:\s*1 \/ -1/.test(css),
        "跳转类型那一行横跨弹窗两列：三颗 radio 铺开才点得准");
    assert.ok(/\.ns-home-f-radio\.is-on\s*\{[^}]*border-color:\s*var\(--ns-accent\)/.test(css)
        && /\.ns-home-f-radio\.is-on \.ns-home-f-radio-dot\s*\{[^}]*background:\s*currentColor/.test(css),
        "选中的那颗 radio 描边点亮、圆点点实：一眼看得出选的是哪种跳转");
    assert.match(css, /\.ns-home-hero \[contenteditable\]/, "标题区就地改字应有可见的描边");
    assert.match(css, /\.ns-home-form-card \[contenteditable\]/, "预览卡上的标题与副标题就地改字有同一套描边");
    assert.match(css, /\.ns-home-editing \.ns-home-card\s*\{/, "编辑态的卡面应打断点击，跳屏不会把草稿带走");
    assert.ok(/\.ns-home-card\.is-dragging\s*\{[^}]*transform/.test(css), "指针上那张克隆卡是斜着的半透明影子");
    assert.ok(!css.includes("is-drag-ghost") && !src.includes("is-drag-ghost"),
        "forceFallback 下 Sortable 不应用 ghostClass：那条影子样式与那个 option 都是不生效的死代码，不留");
    assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}\.ns-home-editing \.ns-home-grid \.ns-home-card\s*\{[^}]*transition:\s*none\s*!important/,
        "系统偏好减少动画：让位的 transform 是 Sortable 写在行内的，要 !important 才压得住");
    assert.ok(!css.includes(".ns-home-drop-gap") && !css.includes("is-drop-target") && !css.includes("ns-no-anim"),
        "自写预览那套的落点缝、亮格与 FLIP 起点样式应跟着手势一起删掉");
    assert.ok(!css.includes(".ns-home-card-form"), "卡内表单的样式应跟着那条路一起删掉");
    assert.ok(!css.includes(".ns-home-edit-block"), "右侧那块版式面板的样式应跟着面板一起删掉");
    assert.ok(!css.includes(".ns-home-grip") && !css.includes(".ns-home-edit-section")
        && !css.includes(".ns-home-edit-save"),
        "板块手柄、板块开关与细栏保存钮的样式应跟着控件一起删掉");
});

test("预设表只收被移出首页的内置卡：已在首页的一张不出，板块各管各的", () => {
    const base = hl.normalizeLayout({});
    assert.deepEqual(hl.presetCards("create", base).map((c) => c.id), ["effect", "storyboard"],
        "创作板块默认不上首页的那两张就是这一板块默认版式的预设：其余创作卡都在首页上");
    const layout = hl.normalizeLayout({ hidden: ["paint", "gallery"] });
    assert.deepEqual(hl.presetCards("create", layout).map((c) => c.id), ["paint", "effect", "storyboard"],
        "预设收本板块没在首页上的内置卡：移出首页的那一张与默认就不上的那两张");
    assert.deepEqual(hl.presetCards("material", layout).map((c) => c.id), ["gallery"]);
    assert.deepEqual(hl.presetCards("edit", layout).map((c) => c.id), ["edit-local", "edit-remove"],
        "别的板块移出首页的卡不落进这一板块的预设里：这一面只有本板块默认不上的那两张");
    const withCustom = hl.normalizeLayout({
        custom: [{ id: "custom_1", section: "create", title: "旧藏卡", target: "url", url: "https://ex.com/a" }],
        hidden: ["custom_1", "paint"],
    });
    assert.deepEqual(withCustom.hidden, ["paint"],
        "hidden 只装内置卡：旧版式里藏着的自建卡在首页照出，界面上删得掉");
    assert.ok(withCustom.order.create.includes("custom_1"), "那张自建卡还在原来的板块与顺序里");
});

test("内置卡删掉再加回来：落回它原来那一格，全程只改草稿", async () => {
    mountStudio();
    mockLayout({});
    await importApp();
    await settle();
    const home = homeOf();
    await enterEdit(home);
    click(chip(cardOf(home, "生成视频"), "从首页移除这张卡"));
    await flush();
    click(chip(cardOf(home, "智能体"), "从首页移除这张卡"));
    await flush();
    assert.ok(!dlg(), "连删两张卡不弹窗：这一面只由「添加卡片」自己开");
    click(home.querySelector(".ns-home-add-tile"));
    await flush();
    assert.deepEqual(presetTitles(dlg()), ["生成视频", "智能体", "特效视频", "宫格图分镜"],
        "移出首页的两张都在这面等着加回来，按卡表顺序排；默认不上首页的那两张也在");
    click(presetIn(dlg(), "生成视频"));
    click(presetIn(dlg(), "智能体"));
    await flush();
    assert.ok(cardOf(home, "生成视频") && cardOf(home, "智能体"), "预设点一下就回到首页上");
    assert.deepEqual(presetTitles(dlg()), ["特效视频", "宫格图分镜"],
        "两张加回去了：这一面只剩默认不上首页的那两张，它们不因为别的卡加回来而上首页");
    assert.equal(POSTS(), 0, "删掉与加回来这一段都不落盘");
    click(home.querySelector(".ns-home-edit-entry"));
    await flush(40);
    const sent = lastCall("/neo_home/layout", "POST").body;
    assert.deepEqual(sent.hidden, [], "删掉又加回来的卡不留 hidden：加回来就是摘掉这一项");
    assert.deepEqual(sent.order.create.slice(0, 6),
        ["paint", "video", "director", "pose", "agent", "voice"],
        "加回来的卡落回 order 里它原来那一格：排好的顺序不动");
});

test("默认不上首页的预设卡：默认首页没有这一张，点了才排进板块末尾，删掉回到预设区", async () => {
    mountStudio();
    mockLayout({});
    await importApp();
    await settle();
    const home = homeOf();
    assert.ok(!cardOf(home, "特效视频"), "默认首页没有这张卡：首页那一叠不因为新能力多出一张");
    await enterEdit(home);
    click(home.querySelector(".ns-home-add-tile"));
    await flush();
    click(presetIn(dlg(), "特效视频"));
    await flush();
    const titles = titlesIn(gridOf(home, "创作"));
    assert.equal(titles[titles.length - 1], "特效视频", "点一下就是排进这一板块末尾，不插进用户排好的那几格中间");
    click(home.querySelector(".ns-home-edit-entry"));
    await flush(40);
    const sent = lastCall("/neo_home/layout", "POST").body;
    assert.ok(sent.order.create.includes("effect"), "带上首页靠的是 order 里排过的这一格");
    assert.ok(!sent.hidden.includes("effect"), "这张卡不靠 hidden 出门：加过之后 hidden 里没有它");
    await enterEdit(home);
    click(chip(cardOf(home, "特效视频"), "从首页移除这张卡"));
    await flush();
    assert.ok(!cardOf(home, "特效视频"), "删掉的这一张离开首页");
    click(home.querySelector(".ns-home-add-tile"));
    await flush();
    assert.ok(presetIn(dlg(), "特效视频"), "删掉的这一张回到预设区等着再点一次");
    click(dlgClose());
    await flush();
});

test("落位手势是 vendored 的 Sortable：文件在位、版本钉住、运行时不联网", () => {
    const lib = fs.readFileSync(path.join(webDir, "vendor", "sortable.min.js"), "utf8");
    assert.match(lib, /^\/\*! Sortable 1\.15\.7 - MIT/, "vendored 文件带着版本与 MIT 头，升级要看得见");
    const src = fs.readFileSync(path.join(webDir, "studio", "home-layout.js"), "utf8");
    assert.match(src, /import "\.\.\/vendor\/sortable\.min\.js";/, "以 vendored 文件引入：与 marked/purify 同一份引进来");
    assert.ok(!/jsdelivr|unpkg|cdnjs|googleapis/i.test(src), "运行时不联网取库：桌面窗口离线也要拖得动");
    assert.match(src, /window\.Sortable\.create/, "网格的手势由 Sortable 接住，落位只写 onEnd 那一段");
    assert.ok(!/addEventListener\("drag/.test(src),
        "自写的 HTML5 拖放事件要跟着那套手势一起删干净，两套手势不能并存");
});

