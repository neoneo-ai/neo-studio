// 画布节点类型注册表（studio/pages/canvas/node-types.js）的跨文件契约。每一类节点要在六处都兑现——
// 规格（store.js 建节点与读盘兜底）、卡面（nodes.js 的 body/css）、附加栏、加节点菜单（page.js 照 ADD_MENU 铺）、
// 运行文案（RUN_LABELS 的每条字都在 i18n 词表里）、中英文档的节点表行。以前这六处分头写，漏一处就是
// 「菜单里有、卡上没有」或「中文文档有行、英文文档没有」。这里把六处钉在同一张表上。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./setup.mjs";   // 与画布其余用例同一套：jsdom 与全局在 import 被测模块之前装好
import { ADD_MENU, NODE_SPECS, NODE_TYPES, RUN_LABELS, gateOf, runKind, upstreamNodes }
    from "../../web/studio/pages/canvas/node-types.js";
import { createCanvasNode, readCanvas } from "../../web/studio/pages/canvas/store.js?nodeTypesStore=1";
import { ICON_NAMES } from "../../web/js/core/icons.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const canvasDir = path.resolve(here, "../../web/studio/pages/canvas");
const docsDir = path.resolve(here, "../../../docs");
const pageSource = fs.readFileSync(path.join(canvasDir, "page.js"), "utf8");
const i18nSource = fs.readFileSync(path.resolve(here, "../../web/js/core/i18n.js"), "utf8");
const capsSource = fs.readFileSync(path.resolve(here, "../../../app/studio_caps.py"), "utf8");
const docsZh = fs.readFileSync(path.join(docsDir, "canvas.md"), "utf8");
const docsEn = fs.readFileSync(path.join(docsDir, "en", "canvas.md"), "utf8");

const types = Object.keys(NODE_TYPES);
const inWordTable = (text) => i18nSource.includes(`"${text}":`);
const hasRow = (doc, name) => doc.split("\n").some((line) => line.trimStart().startsWith(`| ${name} `));

test("描述符形状：每一类齐标题与默认框，卡面与运行文案的取值都在能落地的集合里", () => {
    assert.equal(new Set(types).size, types.length, "同一类型不能出现两次");
    for (const [type, d] of Object.entries(NODE_TYPES)) {
        assert.ok(d.title, `${type} 没有标题：建出来的节点没有名字`);
        assert.ok(d.w > 0 && d.h > 0, `${type} 的默认框不在正数里：placeGrid 的格距会算成 0`);
        assert.ok(["image", "text", "video", "gen", "edit", "llm", "car"].includes(d.body),
            `${type} 的 body 不在 nodes.js 认的那几个渲染器里：这一类铺出来是空的`);
        if (d.run) assert.ok(RUN_LABELS[d.run], `${type} 说 run=${d.run}，RUN_LABELS 里没有那一行`);
        if (d.bar) assert.ok(["hero", "prompt"].includes(d.bar), `${type} 的 bar 不是附加栏认的那两枚`);
        assert.ok(!d.add || ICON_NAMES.includes(d.add.icon), `${type} 的菜单图标 ${d.add?.icon} 画不出`);
    }
});

test("规格与落盘同源：store 建节点用的就是这一份，旧画布上的未知类型照旧回落并留着 metadata", () => {
    for (const [type, d] of Object.entries(NODE_TYPES)) {
        assert.deepEqual(NODE_SPECS[type], { width: d.w, height: d.h, title: d.title },
            `${type} 的规格与注册表对不上：建节点与落盘读的是两份数`);
    }
    const node = createCanvasNode("gen", { x: 0, y: 0 });
    assert.deepEqual([node.type, node.width, node.height, node.title],
        ["gen", NODE_TYPES.gen.w, NODE_TYPES.gen.h, "生成"]);
    // 旧版页面写的文件里有这一版不认的类型：回落成提示词节点，metadata 整份留着（写回不丢参数）
    const read = readCanvas({ nodes: [{ id: "n1", type: "sticker", width: 99, metadata: { content: "旧正文" } }] });
    assert.equal(read.nodes[0].type, "text");
    assert.equal(read.nodes[0].width, 99);
    assert.equal(read.nodes[0].metadata.content, "旧正文");
});

test("加节点菜单与页面同源：顺序与图标都在注册表那一列里，页面不再逐行写一遍名字", () => {
    assert.deepEqual(ADD_MENU.map((row) => row.label), types.map((t) => NODE_TYPES[t].add.label),
        "菜单顺序与注册表那一列的顺序对不上");
    assert.ok(pageSource.includes("ADD_MENU.map"), "页面没有照注册表铺菜单：加一类节点还要在页面补一行菜单");
    for (const type of types) {
        const label = NODE_TYPES[type].add.label;
        // 菜单那一行不许在页面里现写一遍名字（「添加配方」在配方弹窗的标题里还有正当的一处）
        assert.ok(!new RegExp(`mk\\(\\s*t\\("${label}"`).test(pageSource), `菜单名 ${label} 又在页面里现写了一遍`);
    }
    // 「加视频节点」落的是生成节点的视频档，「添加配方」铺一列 —— 这两发落的类型与菜单名不是一回事
    assert.equal(ADD_MENU.find((row) => row.label === "加视频节点").type, "gen");
    assert.equal(ADD_MENU.find((row) => row.label === "加视频节点").seed, "videoSkill");
    assert.equal(ADD_MENU.find((row) => row.label === "添加配方").act, "recipe");
    assert.equal(ADD_MENU.find((row) => row.label === "加图片").act, "material");
});

test("运行文案齐那一行要说的字，每一条都在词表里：少一条就是卡上或提示条上露键名", () => {
    for (const [type, d] of Object.entries(NODE_TYPES)) {
        if (!d.run) continue;
        const labels = RUN_LABELS[d.run];
        const keys = d.run === "car" ? ["queued", "running", "progress", "fail", "failToast"]
            : ["btn", "tip", "running", "fail", "failToast"];
        // LLM 两条链没有排队档（一条 SSE 直接开跑），数的是字数；三条队列链数张数 / 段数
        if (d.run === "enhance" || d.run === "reverse") keys.push("chars", "done", "cancelled");
        else keys.push("queued", "progress");
        for (const key of keys) {
            assert.ok(labels[key], `${type}（run=${d.run}）的运行文案缺 ${key}`);
            assert.ok(inWordTable(labels[key]), `${type} 的 ${key}「${labels[key]}」没进 i18n 词表`);
        }
    }
});

test("能力位就是桌面端能力表里那一个名字：表里写错一名，这一发在离线窗口与插件页都不说话", () => {
    for (const [type, d] of Object.entries(NODE_TYPES)) {
        if (!d.gate) continue;
        assert.ok(capsSource.includes(`"${d.gate}"`),
            `${type} 的能力位 ${d.gate} 不在 app/studio_caps.py 的能力名里`);
    }
});

test("中英文档的节点表里每一类都有行：缺一份，那一语言的用户查这一类时就查不到", () => {
    for (const [type, d] of Object.entries(NODE_TYPES)) {
        for (const name of d.doc.zh) assert.ok(hasRow(docsZh, name), `docs/canvas.md 节点表里没有「${name}」这一行`);
        for (const name of d.doc.en) assert.ok(hasRow(docsEn, name), `docs/en/canvas.md 节点表里没有 "${name}" 这一行`);
    }
});

test("跑哪一条链看节点自己的档：串联的车尾数段数，视频档走出片，其余看注册表那一行", () => {
    assert.equal(runKind({ type: "gen", metadata: {} }), "image");
    assert.equal(runKind({ type: "gen", metadata: { kind: "video" } }), "video");
    assert.equal(runKind({ type: "gen", metadata: { kind: "video", chain: "train" } }), "chain");
    assert.equal(runKind({ type: "edit", metadata: { kind: "video" } }), "edit");
    assert.equal(runKind({ type: "reverse", metadata: {} }), "reverse");
    assert.equal(runKind({ type: "recipe", metadata: {} }), "car");
});

test("闸门：停用的那一张先说话，在跑的不重复提交，能力位缺了的话术按能力位分三档", () => {
    const on = () => true, off = () => false;
    assert.deepEqual(gateOf({ metadata: { disabled: true } }, { running: true, gate: "image_gen", canFeature: off }),
        { msg: "这台节点已停用：在节点上方的浮出栏里启用", level: "info" }, "已停用这句不许被「在跑」吃掉");
    assert.deepEqual(gateOf({ metadata: {} }, { running: true, gate: "image_gen", canFeature: on }),
        { msg: "", level: "info" }, "这一发在跑：不出声，也不许重复提交");
    assert.ok(gateOf({ metadata: {} }, { gate: "image_gen", canFeature: off }).msg.startsWith("出图需要"));
    assert.ok(gateOf({ metadata: {} }, { gate: "simple_video", canFeature: off }).msg.startsWith("出片需要"));
    assert.ok(gateOf({ metadata: {} }, { gate: "segment", canFeature: off }).msg.startsWith("出片需要"));
    assert.ok(gateOf({ metadata: {} }, { gate: "prompt_enhance", canFeature: off }).msg.startsWith("该功能需要"));
    assert.equal(gateOf({ metadata: {} }, { gate: "image_gen", canFeature: on }), null, "能力位在就不该拦");
});

test("上游取数只看直连：顺序就是连线顺序，停用的那一张不进这一发", () => {
    const state = {
        nodes: [
            { id: "gen1", type: "gen", metadata: {} },
            { id: "t1", type: "text", metadata: { content: "一" } },
            { id: "t2", type: "text", metadata: { content: "二" } },
            { id: "t3", type: "text", metadata: { content: "停用", disabled: true } },
            { id: "up", type: "text", metadata: { content: "上游的上游" } },
            { id: "i1", type: "image", metadata: { filename: "a.png" } },
        ],
        connections: [
            { id: "c1", fromNodeId: "t1", toNodeId: "gen1" },
            { id: "c2", fromNodeId: "t2", toNodeId: "gen1" },
            { id: "c3", fromNodeId: "t3", toNodeId: "gen1" },
            { id: "c4", fromNodeId: "up", toNodeId: "t1" },
            { id: "c5", fromNodeId: "i1", toNodeId: "gen1" },
        ],
    };
    assert.deepEqual(upstreamNodes(state, "gen1", ["text"]).map((n) => n.id), ["t1", "t2"],
        "上游的上游不进这一发：连过来的是那一条链，不是这一发的输入");
    assert.deepEqual(upstreamNodes(state, "gen1", ["image"]).map((n) => n.id), ["i1"]);
    assert.deepEqual(upstreamNodes(state, "gen1", ["text"], true).map((n) => n.id), ["t1", "t2", "t3"],
        "disableOk 才把停用的那一张交回来");
});
