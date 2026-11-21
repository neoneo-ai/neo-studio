// 文字故事板节点（studio/storyboard/storyboard.js 的纯函数 + gen.js 的 runStoryboard 在页面上那一发）：
// 请求构造、响应规整与写回计划都不持页面状态；页面那一发从节点上的运行钮出发，写回看节点自己的 metadata
import test, { describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockRoute, jsonResponse, flush, click, resetEnv, fetchLog } from "./setup.mjs";
import { setLang } from "../../web/js/core/i18n.js";

const geometry = await import("../../web/studio/pages/canvas/geometry.js?sbGeo=1");
const store = await import("../../web/studio/pages/canvas/store.js?sbStore=1");
const canvasPage = await import("../../web/studio/pages/canvas/page.js?sbPage=1");
const sb = await import("../../web/studio/storyboard/storyboard.js?sbLeaf=1");
const nodeTypes = await import("../../web/studio/pages/canvas/node-types.js?sbTypes=1");
const { $el } = await import("../../web/studio/shim/ui.js?sbUi=1");
const canvas = { ...geometry, ...store, ...canvasPage };

const SB_PATH = "/rs_recipes/director_generate_segments";
const DUR_PATH = "/rs_recipes/set_segment_duration";
const settle = () => flush(20);
const STAGE = { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 };

beforeEach(() => setLang("zh"));

describe("文字故事板的请求构造与写回计划", () => {
    test("一行短文本当主题交后端展开，换行或长过一截当剧本交后端拆段", () => {
        assert.deepEqual(sb.storyboardRequestBody({ text: "一只猫去冒险", segmentSeconds: 8 }),
            { idea: "一只猫去冒险", segment_seconds: 8 }, "单行短文本就是主题");
        assert.deepEqual(sb.storyboardRequestBody({ text: "第一行\n第二行", segmentSeconds: 5 }),
            { script: "第一行\n第二行", segment_seconds: 5 }, "换了行就是整篇剧本");
        const long = "一".repeat(61);
        assert.equal(sb.storyboardRequestBody({ text: long }).script, long,
            "单行长过那一截也当剧本：后端按行拆，一行就是一段");
        assert.equal(sb.storyboardRequestBody({ text: "一只猫去冒险" }).segment_seconds, 5,
            "没给时长就走默认 5 秒");
    });

    test("每一段的时长钳进后端认的那一份区间，写歪了落回 5 秒", () => {
        const at = (v) => sb.storyboardRequestBody({ text: "主题", segmentSeconds: v }).segment_seconds;
        assert.equal(at(1), 1);
        assert.equal(at(3600), 3600);
        assert.equal(at(0), 5, "后端对越界直接 400，画布上先把话说平");
        assert.equal(at(-4), 5);
        assert.equal(at(3601), 3600, "越过上限落回上限，不交一个后端不认的秒数");
        assert.equal(at("7.4"), 7, "数框里的小数收整");
        assert.equal(at("abc"), 5);
        assert.equal(at(undefined), 5);
    });

    test("后端回包规整成段数组：没正文的那一段丢掉，一段都没有就交 null", () => {
        const rows = sb.storyboardSegments({ segments: [
            { prompt: "第一段", segment: 0, duration_sec: 6 },
            { prompt: "   ", segment: 1, duration_sec: 6 },
            { prompt: "第三段", segment: 2 },
        ] });
        assert.deepEqual(rows, [
            { prompt: "第一段", segment: 0, duration_sec: 6 },
            { prompt: "第三段", segment: 2, duration_sec: null },
        ], "后端没给时长时交 null：出片那一段的时长落回配方与后端那一份");
        assert.equal(sb.storyboardSegments({}), null, "没回段列表交 null，运行那一条把原因说给用户");
        assert.equal(sb.storyboardSegments({ segments: [{ prompt: "" }] }), null);
        assert.equal(sb.storyboardSegments({ ok: false, error: "未配置 LLM" }), null);
    });

    test("写回计划：一厢一段，段数与厢数不齐就只写到能配上的那一段", () => {
        const cars = [{ id: "c0", metadata: { recipe: "短片配方", segment: 0 } },
            { id: "c1", metadata: { recipe: "短片配方", segment: 1 } }];
        const segs = [{ prompt: "A", segment: 0, duration_sec: 5 }, { prompt: "B", segment: 1, duration_sec: 9 },
            { prompt: "C", segment: 2, duration_sec: 4 }];
        const patches = sb.storyboardCarPatches(segs, cars);
        assert.deepEqual(patches.map((p) => [p.node.id, p.meta.content, p.duration_sec]),
            [["c0", "A", 5], ["c1", "B", 9]], "第三段没有厢可落，不写进任何一张节点");
        assert.deepEqual(sb.storyboardCarPatches(segs, []).length, 0);
        assert.deepEqual(sb.storyboardCarPatches(null, cars).length, 0);
        assert.equal(sb.storyboardMismatchText(3, 2),
            "生成 3 段 · 链上 2 厢：按连线顺序一厢一段");
        assert.equal(sb.storyboardMismatchText(2, 2), "", "数齐了不在卡上多说一句");
    });

    test("段时长只落给记着配方名的车厢，同一 (配方, 段) 只落一次", () => {
        const patches = [{ node: { id: "c0", metadata: { recipe: "短片配方", segment: 0 } },
            meta: { content: "A" }, duration_sec: 7 },
        { node: { id: "c1", metadata: { recipe: "短片配方", segment: 0 } }, meta: { content: "B" }, duration_sec: 8 },
        { node: { id: "c2", metadata: {} }, meta: { content: "C" }, duration_sec: 9 },
        { node: { id: "c3", metadata: { recipe: "短片配方", segment: 3 } }, meta: { content: "D" }, duration_sec: null }];
        assert.deepEqual(sb.storyboardDurationWrites(patches, "短片配方"),
            [{ recipe: "短片配方", segment: 0, duration_sec: 7 }],
            "手工铺的车厢没有配方，段时长没有落点；后端没给时长的段也不写");
        assert.deepEqual(sb.storyboardDurationWrites(patches, ""), [],
            "链上没记配方名时整发不写配方文件");
        assert.deepEqual(sb.storyboardDurationWrites([], "短片配方"), []);
    });

    test("卡上那几行预览：第几段 · 几秒 · 正文前 80 字", () => {
        const lines = sb.storyboardPreviewLines([{ prompt: "第一段正文", segment: 0, duration_sec: 6 },
        { prompt: "x".repeat(120), segment: 1, duration_sec: null }]);
        assert.equal(lines[0], "第 1 段 · 6 秒：第一段正文");
        assert.equal(lines[1], `第 2 段：${"x".repeat(80)}`, "后端没给时长那一行不写秒数");
        assert.deepEqual(sb.storyboardPreviewLines(undefined), []);
    });

    test("节点表里那一行：菜单名、运行文案与中英文档名都在同一处", () => {
        const d = nodeTypes.NODE_TYPES.storyboard;
        assert.deepEqual([d.title, d.run, d.body, d.add.label],
            ["文字故事板", "storyboard", "storyboard", "加文字故事板节点"]);
        assert.deepEqual(d.add.defaults, { segment_seconds: 5 }, "新建那张默认每一段 5 秒");
        assert.equal(nodeTypes.runKind({ type: "storyboard", metadata: {} }), "storyboard");
    });
});

// ====== 页面那一发：从节点上的运行钮出发，写回看节点自己的 metadata ======
const RECIPE = { name: "短片配方", title: "短片", source: "mine", type: "video_director", canvas_id: "",
    shared: { mode: "i2v", width: 1344, height: 768 },
    segments: [{ title: "开场", skill_id: "h3_t2v", duration_sec: 5, prompt: "配方里那一段" },
        { title: "收尾", skill_id: "h3_t2v", duration_sec: 8, prompt: "收尾那一段" }] };

const segNode = (id, metadata = {}) => ({ id, type: "storyboard", title: "文字故事板",
    position: { x: 0, y: 40 }, width: 320, height: 208,
    metadata: { segment_seconds: 5, content: "一只猫去冒险", ...metadata } });
const car = (id, metadata = {}) => ({ id, type: "recipe", title: "车厢", position: { x: 0, y: 320 },
    width: 360, height: 176, metadata: { recipe: "短片配方", segment: 0, ...metadata } });
const link = (from, to) => ({ id: `conn-${from}-${to}`, fromNodeId: from, toNodeId: to });

/** 故事板链的门面：段生成一发 + 段时长一发 + 配方列表，画布项目两条（切画布的用例要第二张） */
function sbEnv({ nodes, connections, sbImpl, durImpl }) {
    const store = { projects: [
        { id: "canvas-a", title: "甲", nodes, connections, viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" },
        { id: "canvas-b", title: "乙", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" },
    ], toasts: [] };
    const routes = {
        "/neo_canvas/list": () => jsonResponse({ success: true, projects: store.projects }),
        "/neo_canvas/project": (body, call) => call.method === "GET"
            ? jsonResponse({ success: true, project: store.projects.find((p) => p.id === call.query.get("id")) })
            : jsonResponse({ success: true, id: "canvas-a" }),
        "/neo_canvas/rename": () => jsonResponse({ success: true }),
        "/neo_canvas/delete": () => jsonResponse({ success: true }),
        "/rs_recipes/list": () => jsonResponse([RECIPE]),
        [SB_PATH]: sbImpl || (() => jsonResponse({ ok: true, segments: [
            { prompt: "第一段正文", segment: 0, duration_sec: 7 },
            { prompt: "第二段正文", segment: 1, duration_sec: 9 }] })),
        [DUR_PATH]: durImpl || (() => jsonResponse({ success: true, duration_sec: 7 })),
    };
    return { store, routes, api: { fetchApi: (path, opts = {}) => fetch(path, opts) },
        toast: (message, kind = "info") => store.toasts.push({ message, kind }) };
}

async function sbPage(nodes, connections, { sbImpl, durImpl, can = () => true } = {}) {
    resetEnv();
    const env = sbEnv({ nodes, connections, sbImpl, durImpl });
    for (const [route, responder] of Object.entries(env.routes)) mockRoute(route, responder);
    document.body.innerHTML = '<div class="ns-page"></div>';
    const host = document.querySelector(".ns-page");
    const page = canvas.createCanvasPage({ $el, api: env.api, toast: env.toast,
        modeGroup: () => "f2v", groupLabels: {}, can });
    await page.build(host);
    const view = {
        nodeLayer: host.querySelector(".ns-canvas-nodes"),
        bar: host.querySelector(".ns-canvas-bar"),
        project: host.querySelector(".ns-canvas-project-btn"),
        projectPanel: host.querySelector(".ns-canvas-project-panel"),
        stage: host.querySelector(".ns-canvas-stage"),
    };
    view.stage.__rect = { ...STAGE, right: STAGE.width, bottom: STAGE.height };
    const nodeEl = (id) => view.nodeLayer.querySelector(`[data-node-id="${id}"]`);
    const button = (label) => [...view.bar.querySelectorAll(".ns-canvas-tool")]
        .find((el) => (el.getAttribute("aria-label") || "") === label);
    const genBtn = (id, label) => [...nodeEl(id).querySelectorAll(".ns-canvas-gen-btn")]
        .find((btn) => btn.textContent.trim() === label);
    const status = (id) => nodeEl(id).querySelector(".ns-canvas-gen-status")?.textContent || "";
    const metaOf = (id) => page.current().nodes.find((n) => n.id === id).metadata;
    const sbCalls = () => fetchLog.filter((c) => c.path === SB_PATH).map((c) => c.body);
    const durCalls = () => fetchLog.filter((c) => c.path === DUR_PATH).map((c) => c.body);
    const pickCanvas = (id) => {
        click(view.project);
        click(view.projectPanel.querySelector(`[data-canvas="${id}"] .ns-canvas-project-row-name`));
    };
    Object.assign(view, { nodeEl, button });
    await settle();
    return { page, view, env, genBtn, status, metaOf, sbCalls, durCalls, pickCanvas };
}

/** 在途那一发的门：请求先发出去，放门之后才回包 —— 取消与切画布都发生在门开着的那一段时间里 */
function gated(data) {
    let release = null;
    const gate = new Promise((done) => { release = done; });
    return { sbImpl: () => gate.then(() => jsonResponse(data)), release };
}



describe("画布上的文字故事板节点：一段话写进连过来的车厢", () => {
    test("菜单那一行落一张节点：卡上是正文框、每一段时长数框与运行钮", async () => {
        const ctx = await sbPage([], []);
        click(ctx.view.button("加文字故事板节点"));
        await settle();
        const node = ctx.page.current().nodes.at(-1);
        assert.deepEqual([node.type, node.metadata.segment_seconds], ["storyboard", 5]);
        const el = ctx.view.nodeEl(node.id);
        assert.ok(el.querySelector("textarea.ns-canvas-storyboard-text"), "要写的那一段话就在这张卡上");
        assert.equal(el.querySelector(".ns-canvas-storyboard-sec").value, "5");
        assert.ok(ctx.genBtn(node.id, "生成段提示词"), "控件行那一枚是运行钮");
        assert.ok(el.querySelector(".ns-canvas-gen-status"), "最后一行是这一发的状态");
        assert.equal(ctx.status(node.id), "", "没跑起来状态行是空的");
    });

    test("空正文与没连车厢：各说一句，不发请求", async () => {
        const empty = await sbPage([segNode("sb", { content: "  " })], []);
        click(empty.genBtn("sb", "生成段提示词"));
        await settle();
        assert.equal(empty.sbCalls().length, 0);
        assert.ok(empty.env.store.toasts.some((i) => i.message.includes("写一段话")),
            "正文空着就说要在节点上写");
        const bare = await sbPage([segNode("sb")], []);
        click(bare.genBtn("sb", "生成段提示词"));
        await settle();
        assert.equal(bare.sbCalls().length, 0);
        assert.ok(bare.env.store.toasts.some((i) => i.message.includes("把要写的那几厢车厢连过来")));
    });

    test("一行主题交后端展开；整篇剧本交后端拆段；每一段时长钳进后端认的那一份", async () => {
        const ctx = await sbPage([segNode("sb", { segment_seconds: 9000 }),
            car("c0", { segment: 0 })], [link("c0", "sb")]);
        click(ctx.genBtn("sb", "生成段提示词"));
        await settle();
        assert.deepEqual(ctx.sbCalls()[0], { idea: "一只猫去冒险", segment_seconds: 3600 },
            "数框里写了越界的秒数：交后端前钳进 1–3600");
        const script = await sbPage([segNode("sb", { content: "第一行\n第二行" }),
            car("c0", { segment: 0 })], [link("c0", "sb")]);
        click(script.genBtn("sb", "生成段提示词"));
        await settle();
        assert.equal(script.sbCalls()[0].script, "第一行\n第二行", "换了行就当剧本交后端");
        assert.equal(script.sbCalls()[0].idea, undefined);
    });

    test("成了：段写进故事板节点自己的 metadata，车厢按连线顺序收到正文", async () => {
        const ctx = await sbPage([segNode("sb"), car("c0", { segment: 0 }), car("c1", { segment: 1 })],
            [link("c1", "sb"), link("c0", "sb")]);
        click(ctx.genBtn("sb", "生成段提示词"));
        await settle();
        const segs = ctx.metaOf("sb").segments;
        assert.deepEqual(segs.map((s) => s.prompt), ["第一段正文", "第二段正文"]);
        assert.ok(ctx.metaOf("sb").segments_at > 0, "记下这一发是什么时候生成的");
        assert.deepEqual([ctx.metaOf("c0").content, ctx.metaOf("c1").content],
            ["第二段正文", "第一段正文"], "按连线书写顺序一厢一段：这条线先写的是 c1");
        assert.deepEqual([...ctx.view.nodeEl("sb").querySelectorAll(".ns-canvas-storyboard-seg")]
            .map((el) => el.textContent), ["第 1 段 · 7 秒：第一段正文", "第 2 段 · 9 秒：第二段正文"],
        "卡上铺的就是生成出来的那几行");
        assert.ok(ctx.env.store.toasts.some((i) => i.message === "已写进 2 厢"), ctx.env.store.toasts.map((i) => i.message));
        assert.equal(ctx.status("sb"), "", "跑完了状态行收干净");
    });

    test("车厢记着配方名：段时长写进配方那一段；手工铺的车厢只有正文落得下", async () => {
        const ctx = await sbPage([segNode("sb"), car("c0", { segment: 0 }), car("c1", { segment: 1 })],
            [link("c0", "sb"), link("c1", "sb")]);
        click(ctx.genBtn("sb", "生成段提示词"));
        await settle();
        assert.deepEqual(ctx.durCalls(), [
            { name: "短片配方", segment: 0, duration_sec: 7 },
            { name: "短片配方", segment: 1, duration_sec: 9 }],
        "整列共用的配方名读车厢身上那一份，每一段落自己那一段");
        const hand = await sbPage([segNode("sb"), car("c0", { recipe: "", segment: 0 })], [link("c0", "sb")]);
        click(hand.genBtn("sb", "生成段提示词"));
        await settle();
        assert.equal(hand.metaOf("c0").content, "第一段正文");
        assert.equal(hand.durCalls().length, 0, "手工铺的车厢没有配方：段时长没有落点，一个字节都不写");
    });

    test("段数多于厢数：后面的段不落，卡上说一句", async () => {
        const ctx = await sbPage([segNode("sb"), car("c0", { segment: 0 })], [link("c0", "sb")],
            { sbImpl: () => jsonResponse({ ok: true, segments: [
                { prompt: "A", segment: 0, duration_sec: 5 }, { prompt: "B", segment: 1, duration_sec: 5 },
                { prompt: "C", segment: 2, duration_sec: 5 }] }) });
        click(ctx.genBtn("sb", "生成段提示词"));
        await settle();
        assert.equal(ctx.metaOf("c0").content, "A", "只有第一段有厢可落");
        assert.ok(ctx.env.store.toasts.some((i) => i.message.includes("生成 3 段 · 链上 1 厢")),
            ctx.env.store.toasts.map((i) => i.message));
        assert.equal(ctx.durCalls().length, 1);
    });

    test("取消那一发：在途的正文不落画布，说一句已取消生成", async () => {
        const g = gated({ ok: true, segments: [{ prompt: "第一段正文", segment: 0, duration_sec: 7 }] });
        const ctx = await sbPage([segNode("sb"), car("c0", { segment: 0 })], [link("c0", "sb")], g);
        click(ctx.genBtn("sb", "生成段提示词"));
        await settle();
        assert.equal(ctx.status("sb"), "生成中", ctx.status("sb"));
        click(ctx.genBtn("sb", "取消任务"));
        g.release();
        await settle();
        assert.equal(ctx.metaOf("sb").segments, undefined, "取消那一发不写画布");
        assert.equal(ctx.metaOf("c0").content, undefined, "车厢上那一句也不动");
        assert.equal(ctx.durCalls().length, 0);
        assert.ok(ctx.env.store.toasts.some((i) => i.message === "已取消生成"),
            ctx.env.store.toasts.map((i) => i.message));
        assert.equal(ctx.status("sb"), "");
    });

    test("切画布项目：在途那一发脱手，旧画布一个字节都不写", async () => {
        const g = gated({ ok: true, segments: [{ prompt: "第一段正文", segment: 0, duration_sec: 7 }] });
        const ctx = await sbPage([segNode("sb"), car("c0", { segment: 0 })], [link("c0", "sb")], g);
        click(ctx.genBtn("sb", "生成段提示词"));
        await settle();
        ctx.pickCanvas("canvas-b");
        await settle();
        g.release();
        await settle();
        assert.equal(ctx.page.current().id, "canvas-b", "切过去了才放门：这一发已经不在眼前了");
        assert.deepEqual([...ctx.view.nodeLayer.children].length, 0);
        assert.ok(ctx.env.store.toasts.every((i) => i.message !== "已写进 1 厢"),
            "脱手的那一发不说「已写进」那句");
    });

    test("后端没配 LLM：状态行写原因，并说一句生成失败", async () => {
        const ctx = await sbPage([segNode("sb"), car("c0", { segment: 0 })], [link("c0", "sb")],
            { sbImpl: () => jsonResponse({ ok: false, error: "未配置远端 LLM" }, 400) });
        click(ctx.genBtn("sb", "生成段提示词"));
        await settle();
        assert.equal(ctx.status("sb"), "未配置远端 LLM", ctx.status("sb"));
        assert.ok(ctx.env.store.toasts.some((i) => i.message.includes("生成失败：未配置远端 LLM")),
            ctx.env.store.toasts.map((i) => i.message));
        assert.equal(ctx.metaOf("c0").content, undefined);
    });

    test("后端回了段却没有正文：说没回段列表，画布上不留半截", async () => {
        const ctx = await sbPage([segNode("sb"), car("c0", { segment: 0 })], [link("c0", "sb")],
            { sbImpl: () => jsonResponse({ ok: true, segments: [{ prompt: "" }] }) });
        click(ctx.genBtn("sb", "生成段提示词"));
        await settle();
        assert.ok(ctx.env.store.toasts.some((i) => i.message.includes("后端没有回段列表")),
            ctx.env.store.toasts.map((i) => i.message));
        assert.equal(ctx.metaOf("sb").segments, undefined);
    });

    test("这一发在桌面端自服的能力表上：能力位缺了只说去哪儿启，不发请求", async () => {
        const ctx = await sbPage([segNode("sb"), car("c0", { segment: 0 })], [link("c0", "sb")],
            { can: () => false });
        click(ctx.genBtn("sb", "生成段提示词"));
        await settle();
        assert.equal(ctx.sbCalls().length, 0);
        assert.ok(ctx.env.store.toasts.some((i) => i.message.includes("该功能需要 ComfyUI")));
    });
});

