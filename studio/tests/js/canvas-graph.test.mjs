// 画布纯叶子的用例：gen-params.js 的参数读法与 gen-graph.js 的连线图取用都不碰 DOM、不持页面状态，
// 喂一份 state 直接断言（页面上的链路、运行态与写回在 canvas-page.test.mjs 里）
import assert from "node:assert/strict";
import { test } from "node:test";
import "./setup.mjs";   // 解析与 globalThis 的测试底座（ComfyUI 的 scripts/api.js 由它接住）

const params = await import("../../web/studio/pages/canvas/gen-params.js?canvasParams=1");
const graph = await import("../../web/studio/pages/canvas/gen-graph.js?canvasGraph=1");

// 一台节点只由类型与 metadata 决定这些读法的结果；位置与尺寸固定，链与参考都只读 id / type / metadata
const node = (id, type, metadata = {}) => ({ id, type, title: id, position: { x: 0, y: 0 },
    width: 320, height: 220, metadata });
const link = (from, to) => ({ id: `c-${from}-${to}`, fromNodeId: from, toNodeId: to,
    fromAnchor: "right", toAnchor: "left", output: "output" });
const state = (nodes, connections = []) => ({ nodes, connections });

test("生成节点参数：空与 0 是跟随，越界的张数落回 1，时长只认那一份选项", () => {
    assert.deepEqual(params.readGenParams({}), {
        kind: "image", chain: "", skill_id: "", default_ratio: "", base_resolution: 0,
        count: 1, duration: 5, width: 0, height: 0,
    }, "旧画布上一台空节点就是全跟随");
    const tail = params.readGenParams({ metadata: { kind: "video", chain: "train", skill_id: "h3",
        count: "9", duration: "10", width: "0", height: "768", base_resolution: "768" } });
    assert.equal(tail.kind, "video");
    assert.equal(tail.chain, "train", "串联的车尾出片按链序跑启用的那几段");
    assert.equal(tail.count, 1, "张数越过后端上限落回 1，不照后端那一份跑");
    assert.equal(tail.duration, 10, "时长在那一份选项里才认");
    assert.equal(tail.width, 0, "0 是「按配方 / 技能那一份」，不进请求");
    assert.equal(params.readGenParams({ metadata: { duration: "13" } }).duration, 5,
        "时长不在那一份选项里落回默认 5 秒");
});

test("车尾与车厢参数：锚点认三档，步数 / 种子 / 上下文帧的 -1 与跟随同一口径", () => {
    const bare = params.readRecipeParams({});
    assert.equal(bare.recipe, "");
    assert.equal(bare.segment, 0);
    assert.equal(bare.anchors, "both");
    assert.equal(bare.steps, -1, "-1 交给后端按配方与全局设置合并");
    assert.equal(bare.seed, -1, "-1 是每次换种子");
    assert.equal(bare.continuity, true);
    assert.equal(bare.context_frames, 22, "默认窗口与导演页和后端同一份");
    const pinned = params.readRecipeParams({ metadata: { recipe: "demo", segment: "2",
        anchors: "nope", steps: "900", seed: "-5", continuity: false, context_frames: "900" } });
    assert.equal(pinned.recipe, "demo");
    assert.equal(pinned.segment, 2);
    assert.equal(pinned.anchors, "both", "锚点认三档，写歪了落回两端锚点");
    assert.equal(pinned.steps, 200, "步数钳到后端 widget 的上限");
    assert.equal(pinned.seed, -1, "负数种子就是每次换种子");
    assert.equal(pinned.continuity, false);
    assert.equal(pinned.context_frames, 362, "上下文帧钳到后端的 362");
    assert.equal(params.readRecipeParams({ metadata: { segment: "-3" } }).segment, 0,
        "负段号落回第一段，不交一个后端不认的段号");
});

test("自定参数：空串与 -1 是跟随，LoRA 名字与强度一起读，并进请求体只带非空项", () => {
    assert.deepEqual(params.readGenOverrides({}), {}, "旧画布没有这一份，出图出片照旧跑");
    assert.deepEqual(params.readGenOverrides({ metadata: { gen_params: {
        model: "  ", steps: -1, loras: ["", { name: "  " }] } } }), {},
    "空值、-1 与空白 LoRA 名都不进请求");
    const ov = params.readGenOverrides({ metadata: { gen_params: {
        model: " qwen/diffusion_qwen.safetensors ", steps: "900",
        loras: ["lora_a.safetensors", { name: "lora_b.safetensors", strength: 0.6 }] } } });
    assert.deepEqual(ov, {
        model: "qwen/diffusion_qwen.safetensors", steps: 200,
        loras: ["lora_a.safetensors", { name: "lora_b.safetensors", strength: 0.6 }],
    }, "旧画布存的纯名字照收，强度跟着名字走，步数钳到 200");
    assert.deepEqual(params.mergeGenOverrides({ prompt: "x" }, ov), {
        prompt: "x", model: "qwen/diffusion_qwen.safetensors", steps: 200,
        loras: ["lora_a.safetensors", { name: "lora_b.safetensors", strength: 0.6 }],
    }, "请求里只带这一发自定的那几项");
    assert.deepEqual(params.mergeGenOverrides({ prompt: "x" }, {}), { prompt: "x" },
        "全跟随时请求里一个自定键都不带");
});

test("生成输入：正文按连线顺序拼接，图片走 [output] 标注，配方素材连配方名一起交后端", () => {
    const nodes = [
        node("t1", "text", { content: "第一段" }), node("t2", "text", { content: "  " }),
        node("i1", "image", { filename: "a.png", subfolder: "neo_gen" }),
        node("i2", "image", { filename: "b.png" }),
        node("asset", "image", { asset: "s01_k1.png", recipe: "demo" }),
        node("vid", "video_in", { filename: "ref.mp4" }),
        node("aud", "audio_in", { filename: "voice.mp3" }),
        node("g", "gen", { skill_id: "qwen" }),
    ];
    const conns = [link("t1", "g"), link("t2", "g"), link("i1", "g"), link("i2", "g"),
        link("asset", "g"), link("vid", "g"), link("aud", "g"), link("i1", "i2")];
    const { prompts, references } = graph.genInputs(state(nodes, conns), "g");
    assert.deepEqual(prompts, ["第一段"], "空白正文不进这一发");
    assert.deepEqual(references.images, [
        { kind: "input", value: "neo_gen/a.png[output]" },
        { kind: "input", value: "b.png[output]" },
        { kind: "recipe", value: "s01_k1.png", recipe: "demo" },
    ], "图片节点存的正是 Output 目录里那一份；「展开配方」铺的素材连配方名一起交后端");
    assert.deepEqual(references.videos, [{ kind: "input", value: "ref.mp4[output]" }],
        "视频输入节点与出片落点同一条流");
    assert.deepEqual(references.audios, [{ kind: "input", value: "voice.mp3[output]" }]);
    // i1 → i2 那条线只把 i1 送进 i2 的输入，不因此在这一发里多算一份
    assert.equal(references.images.filter((r) => r.value.includes("a.png")).length, 1);
});

test("生成输入：断头的与停用的节点不进这一发，同一节点两条线只算一份", () => {
    const nodes = [node("t", "text", { content: "正文" }),
        node("off", "image", { filename: "off.png", disabled: true }),
        node("blank", "image", {}), node("g", "gen")];
    const conns = [link("t", "g"), link("off", "g"), link("blank", "g"),
        link("t", "off")];   // 上游的上游：那是那一条链，不是这一发的输入
    const { prompts, references } = graph.genInputs(state(nodes, conns), "g");
    assert.deepEqual(prompts, ["正文"], "只收直连这一层的正文");
    assert.deepEqual(references.images, [], "停用的那一张与没有文件的空位都不进这一发");
    const dup = graph.genInputs(state([node("i", "image", { filename: "x.png" }), node("g", "gen")],
        [link("i", "g"), { ...link("i", "g"), id: "c2" }]), "g");
    assert.equal(dup.references.images.length, 1, "同一节点连两条线，参考素材也只算一份");
});

test("卡上铺的素材与反推那一张：都按连线顺序，只认有文件的", () => {
    const nodes = [node("i1", "image", { filename: "a.png" }),
        node("v", "video_in", { asset: "k.mp4", recipe: "demo" }),
        node("blank", "image", {}), node("t", "text", { content: "x" }), node("g", "gen")];
    const conns = [link("i1", "g"), link("v", "g"), link("blank", "g"), link("t", "g")];
    assert.deepEqual(graph.mediaNodes(state(nodes, conns), "g").map((n) => n.id), ["i1", "v"],
        "正文节点不在卡上铺，没有文件的空位也不铺");
    assert.equal(graph.reverseFirstImage(state(nodes, conns), "g").id, "i1",
        "反推吃连线顺序里第一张启用的图片节点");
    assert.equal(graph.reverseFirstImage(state([node("g", "gen")], []), "g"), null,
        "上游没有图片节点时交 null，运行那一发自己说要把图片节点连过来");
});

test("配方那一段的参考素材：首帧与分镜图排最前，重复只算一份", () => {
    assert.deepEqual(graph.segmentRefs({
        first_frame: "f.png", storyboard: "s.png",
        refs: { images: ["s.png", "a.png"], videos: ["v.mp4"], audios: ["a.mp3"] },
    }), ["f.png", "s.png", "a.png", "v.mp4", "a.mp3"],
    "后端解析首帧与 refs.images 是同一路，卡上也要看见这一段靠哪张图起头");
    assert.deepEqual(graph.segmentRefs({}), [], "段上没写参考就是空");
    assert.deepEqual(graph.segmentRefs({ refs: "not-an-object" }), [], "refs 写歪了不炸");
});

test("链序：从车尾沿链往回走到车头再翻过来，链剪断就停在走到的那一段", () => {
    const cars = [node("c0", "recipe", { recipe: "demo", segment: 0 }),
        node("c1", "recipe", { recipe: "demo", segment: 1 }),
        node("c2", "recipe", { recipe: "demo", segment: 2 }),
        node("tail", "gen", { kind: "video", chain: "train" }),
        node("plain", "gen", { kind: "video" })];
    const full = state(cars, [link("c0", "c1"), link("c1", "c2"), link("c2", "tail")]);
    assert.deepEqual(graph.chainCars(full, "tail").map((n) => n.id), ["c0", "c1", "c2"],
        "出片按链序跑，车头在前");
    assert.deepEqual(graph.chainCars(state(cars, [link("c1", "c2"), link("c2", "tail")]), "tail")
        .map((n) => n.id), ["c1", "c2"], "链剪断了停在走到的那一段，出片照这一段跑");
    assert.deepEqual(graph.chainCars(full, "plain").map((n) => n.id), [],
        "没有车厢连过来的节点链上是空的");
    assert.equal(graph.chainRecipe(graph.chainCars(full, "tail")), "demo",
        "整列共用的配方名读车厢身上那一份，车尾不记配方名");
    assert.equal(graph.chainRecipe(graph.chainCars(state([node("c", "recipe", {})], []), "c")), "",
        "链上的车厢没记配方名时交空串，出片要明说重铺一列");
});

