// 3D 摆姿宿主：iframe 承载、桥的门禁与收发、面板动作往返（pose:call / pose:state），
// 以及桥接结果落到的那几个 /neo_pose 接口。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, click, changeValue, inputText, flush, sleep, window } from "./setup.mjs";
import { $el } from "../../web/studio/shim/ui.js";

// pose.js 现在经 lib-modal.js 拉 scripts/ui.js 的 shim：静态导入会在 setup.mjs 装好钩子之前就解完
// 整张模块图，所以按 lib-modal-geometry.test.mjs 那条路动态取
const { createPoseView, resolvePropChoice, POSE_PAGE_URL, previewOf, libFilter, libGroups, libTagsOf } =
    await import("../../web/pose/pose.js");

const api = { fetchApi: (path, opts) => fetch(path, opts) };
const LIB = ".ns-pose-side:not(.ns-pose-panel)";
const PANEL = ".ns-pose-panel";

/** 一次面板动作要跨两次 fetch 与一次桥回复：微任务与定时器各放一遍才到终点 */
const settle = async () => { await flush(); await sleep(0); await flush(); };

/** meta/list 的 fixture：面板每个下拉与勾选组都从这一份清单渲染 */
const META = {
    models: [{ key: "girl", label: "少女" }],
    presets: [{ key: "run", label: "奔跑" }],
    // 道具项的真实形状来自摆姿页 src/core/propKit.js 的 listPropOptions：键名是 propKey，不是 key
    props: [
        { propKey: "builtin:chair", label: "椅子", source: "builtin" },
        { propKey: "glb:arrow.glb", label: "箭", source: "glb" },
        { propKey: "glb:sting-sword.glb", label: "细剑（Sting）", source: "glb" },
    ],
    formats: [
        { key: "skeleton", label: "骨架图", suffix: "openpose", hint: "OpenPose 输入" },
        { key: "depth", label: "深度图", suffix: "depth", hint: "depth 输入" },
    ],
    views: [{ key: "front", label: "正面" }, { key: "side", label: "侧面" }],
    sizes: [256, 512, 1024, 2048],
    bones: ["hips", "head"],
    // 外观两档来自摆姿页 core/scene.js 的 LOOKS：studio 是页面开局的摄影棚灰，dark 是暗色
    looks: [{ key: "studio", label: "摄影棚" }, { key: "dark", label: "暗色" }],
    maxExportSize: 1024,
};
const PROPS = { items: [{ id: "p1", label: "椅子", attach: null }], options: META.props, bones: META.bones };
const STATE = {
    ready: true, model: "girl", members: 2, poseMode: true, snap: false,
    outline: true, subjects: true, look: "studio", props: 1,
};
const STATUS = {
    success: true, installed: true,
    // 生效的那一级与随包清单：宿主左栏据此决定要不要出「跑在随包副本上」的说明
    dist_source: "data_root", package_installed: true, models_present: ["ybot.glb"],
    manifest_version: "neo-studio-pose-package/1",
    caps: { pose: true, export: true, photo3d: false, hostUi: true, body_import: true },
    scenes: [{ name: "hero", size: 12, mtime: 1 }],
    presets: [{ name: "run pose", size: 20, mtime: 2 }],
    bridge: ["pose:ready", "pose:theme", "pose:state", "pose:call"],
    hint: "",
};

/** pose-lib 的索引 fixture：形状来自摆姿仓库 poseLibrary.js 的 buildIndex（3dpose.index/1）。
    条目带 groups / categories / preview，四档预览各留一条，缩略图优先级与分层口径都钉在这份上 */
const POSE_LIB = {
    format: "3dpose.index/1",
    count: 3,
    groups: [{ key: "stand", label: "站立", count: 2 }, { key: "fight", label: "格斗与武器", count: 1 }],
    entries: [
        { id: "a", label: "A-Pose 标定", path: "poses/stand/a.pose.json", kind: "pose", groups: ["stand"],
          categories: ["站立", "standing-poses"], tags: ["preset"], source: "preset",
          preview: { skeleton: "preview/a.skeleton.png", silhouette: "preview/a.silhouette.png" } },
        { id: "calm-1", label: "双臂伸展 1", path: "poses/calm/calm-1.pose.json", kind: "pose",
          groups: ["calm", "stand"], categories: ["手臂绘图参考", "arm-drawing-reference"], source: "photo3d",
          preview: { clay: "preview/calm-1.clay.png", skeleton: "preview/calm-1.skeleton.png" } },
        { id: "sword", label: "双手持剑", path: "poses/fight/sword.pose.json", kind: "pose", groups: ["fight"],
          categories: ["格斗", "sword"], source: "preset", preview: { depth: "preview/sword.depth.png" } },
    ],
};

// jsdom 没有 MessageChannel：回复端口桩成同步直投（宿主的 port1.onmessage 立刻收到）
class StubPort {
    constructor() { this.onmessage = null; this.peer = null; }
    postMessage(data) { this.peer?.onmessage?.({ data }); }
}
globalThis.MessageChannel = class {
    constructor() {
        this.port1 = new StubPort();
        this.port2 = new StubPort();
        this.port1.peer = this.port2;
        this.port2.peer = this.port1;
    }
};

/** 建宿主视图：消息桩记录宿主发给页面的每一条，回复端口从该条的 ports[0] 取 */
function mounted(status = STATUS) {
    clearRoutes();
    mockRoute("/neo_pose/status", () => jsonResponse(status));
    mockRoute("/neo_pose/scenes", () => jsonResponse({ success: true, scenes: status.scenes || [] }));
    mockRoute("/neo_pose/presets", () => jsonResponse({ success: true, presets: status.presets || [] }));
    mockRoute("/neo_pose/scene", (body, call) => call.method === "POST"
        ? jsonResponse({ success: true, name: body?.name })
        : jsonResponse({ success: true, scene: { camYaw: 42 } }));
    mockRoute("/neo_pose/preset", (body, call) => call.method === "POST"
        ? jsonResponse({ success: true, name: body?.name })
        : jsonResponse({ success: true, pose: { version: 1, rig: {} } }));
    mockRoute("/neo_pose/preset/delete", () => jsonResponse({ success: true, name: "run pose" }));
    mockRoute("/neo_pose/export_image", () => jsonResponse({ success: true, filename: "pose_shot_1.png" }));
    mockRoute("/neo_pose/export_set", (body) => jsonResponse({
        success: true,
        saved: (body?.files || []).map((f) => f.name),
        count: (body?.files || []).length,
    }));
    // 姿势库的两条静态读：索引清单不带 success 外壳，库里的一份姿态就是 PoseFile 原样
    mockRoute("/pose-lib/index.json", () => jsonResponse(status.lib === undefined ? POSE_LIB : status.lib));
    mockRoute("/pose-lib/poses/calm/calm-1.pose.json", () => jsonResponse({ format: "pose-file/v1", rig: {} }));

    const host = $el("div");
    document.body.appendChild(host);
    const sent = [];
    const toasts = [];
    const cw = { postMessage: (msg, origin, ports = []) => sent.push({ msg, origin, ports }) };
    let pickCb = null;
    const env = {
        host, sent, toasts, cw,
        pick: (item) => pickCb?.(item),
        button: (label, scope = PANEL) => [...host.querySelectorAll(scope + " .ns-pose-btn")]
            .find((b) => b.textContent.includes(label)),
        sel: (i) => [...host.querySelectorAll(PANEL + " .ns-pose-sel")][i],
        libField: (i) => [...host.querySelectorAll(LIB + " .ns-pose-name")][i],
        panelField: (i = 0) => [...host.querySelectorAll(PANEL + " .ns-pose-name")][i],
        item: (name, scope) => [...host.querySelectorAll(scope + " .ns-pose-item")].find((r) => r.textContent === name),
        calls: (action) => sent.filter((s) => s.msg.type === "pose:call" && (!action || s.msg.action === action)),
        from: (data, source = cw, origin = window.location.origin) => {
            const ev = new window.Event("message");
            Object.defineProperty(ev, "data", { value: data });
            Object.defineProperty(ev, "origin", { value: origin });
            Object.defineProperty(ev, "source", { value: source });
            window.dispatchEvent(ev);
        },
        /** 回一条 pose:call 的结果：请求只认自己那条端口上的回复 */
        replyCall: (entry, data, ok = true) =>
            entry.ports[0].postMessage(ok ? { ok: true, data } : { ok: false, error: data }),
        reply: (type, payload) => sent.find((s) => s.msg.type === type).ports[0].postMessage(payload),
        ready: async () => { env.from({ type: "pose:ready" }); await settle(); },
    };
    const build = createPoseView({
        api, $el,
        toast: (m) => toasts.push(m),
        openMaterial: (cb) => { pickCb = cb; },
    });
    return build(host).then(() => {
        // 视图建完才有 iframe：contentWindow 在 jsdom 里是 null，桩成消息记录器挂上去
        if (env.host.querySelector(".ns-pose-frame")) {
            Object.defineProperty(env.host.querySelector(".ns-pose-frame"), "contentWindow",
                { value: cw, configurable: true });
        }
        // 渲染里的 /neo_pose/status 与两份列表都是异步补的，落了盘才算装好
        return sleep(1);
    }).then(() => env);
}

test("缺包：不出 iframe，两侧栏收起并给出装包提示", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, installed: false, hint: "跑 tools\\sync_pose_dist.ps1" });
    assert.equal(env.host.querySelector(".ns-pose-frame"), null, "没有包就不能挂 iframe");
    assert.match(env.host.querySelector(".ns-pose-empty").textContent, /sync_pose_dist/);
    assert.equal(env.host.querySelector(LIB).hidden, true, "没有包就不出姿势库");
    assert.equal(env.host.querySelector(PANEL).hidden, true, "没有包就不出控制面板");
    assert.equal(env.host.querySelector(".ns-pose-bar .ns-pose-btn").hidden, true, "没有包就不出导入按钮");
});

test("装好包：iframe 指短路径并带沙箱，pose:ready 之前控件全禁用", async () => {
    resetEnv();
    const env = await mounted();
    const frame = env.host.querySelector(".ns-pose-frame");
    assert.equal(frame.getAttribute("src"), POSE_PAGE_URL);
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-downloads");
    const gated = () => [...env.host.querySelectorAll(".ns-pose-btn, .ns-pose-sel, .ns-pose-checkrow input")];
    assert.ok(gated().length > 15, "面板与库的控件要在位");
    assert.ok(gated().every((n) => n.disabled), "页面没 ready 时控件不能点");
    await env.ready();
    const theme = env.sent.find((s) => s.msg.type === "pose:theme");
    assert.equal(theme.msg.caps.hostUi, true, "宿主面板能力位要随主题下发");
    assert.equal(theme.msg.caps.photo3d, false, "要 sidecar 的能力位一并下发");
});

test("桥只认本页 iframe 的同源消息", async () => {
    resetEnv();
    const env = await mounted();
    const panelBtn = () => env.host.querySelector(PANEL + " .ns-pose-btn");
    env.from({ type: "pose:ready" }, { postMessage() {} });   // 别的来源冒充页面
    assert.ok(panelBtn().disabled, "来源不是这张 iframe 就不认");
    env.from({ type: "pose:ready" }, env.cw, "http://evil.local");   // 来源对、origin 不对
    assert.ok(panelBtn().disabled, "非同源的 ready 不解锁控件");
});

test("旧摆姿包（caps.hostUi 关）：面板禁用并说明缺什么，场景读写照旧", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, caps: { ...STATUS.caps, hostUi: false } });
    await env.ready();
    assert.equal(env.host.querySelector(PANEL + " .ns-pose-notice").hidden, false, "旧包要出提示");
    assert.match(env.host.querySelector(PANEL + " .ns-pose-notice").textContent, /sync_pose_dist/);
    assert.equal(env.host.querySelector(".ns-pose-bridge").textContent, "桥过旧");
    const panelBtns = [...env.host.querySelectorAll(PANEL + " .ns-pose-btn")];
    const importBody = env.button("导入自备素体");
    assert.ok(panelBtns.every((b) => b === importBody || b.disabled),
        "没有命令层就不出点了只会空转的控件");
    assert.equal(importBody.disabled, false,
        "自备素体导入走宿主自己的接口，不依赖摆姿页的命令层，旧包也照旧可点");
    assert.equal(env.calls().length, 0, "旧包不许发 pose:call");
    click(env.item("hero", LIB));
    click(env.button("载入场景", LIB));
    await settle();
    assert.equal(env.sent.find((s) => s.msg.type === "pose:open-scene").msg.scene.camYaw, 42,
        "读写数据根文件的通道不受 hostUi 影响");
});

test("pose:call 往返：meta/list 渲染下拉，回复只认自己那条端口", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    assert.deepEqual(env.calls().map((c) => c.msg.action), ["meta/list", "prop/list"],
        "ready 之后一次问齐元数据与道具");
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.equal(env.sel(0).options.length, 0, "道具的回复不许解掉 meta/list 那条请求");
    assert.match(env.host.querySelector(PANEL + " .ns-pose-item").textContent, /椅子 · 未挂载/);
    env.replyCall(env.calls("meta/list")[0], META);
    await settle();
    assert.deepEqual([...env.sel(0).options].map((o) => o.value), ["", "girl"], "素体下拉来自 meta");
    assert.deepEqual([...env.sel(5).options].map((o) => o.value), ["", "front", "side"], "视角下拉来自 meta");
    assert.deepEqual([...env.sel(6).options].map((o) => o.value), ["", "256", "512", "1024", "2048"]);
    assert.equal(env.host.querySelectorAll(PANEL + " .ns-pose-format input").length, 2, "格式勾选组来自 meta");
});

test("道具添加：下拉的 value 必须是页面的 propKey，中文 label 只当显示名", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.deepEqual([...env.sel(3).options].map((o) => o.value),
        ["", "builtin:chair", "glb:arrow.glb", "glb:sting-sword.glb"],
        "value 落空时浏览器拿「椅子」当 value，页面收到的就是显示名");
    changeValue(env.sel(3), "builtin:chair");
    click(env.button("添加道具"));
    await settle();
    assert.deepEqual(env.calls("prop/add")[0].msg.args, { key: "builtin:chair" });
});

test("道具添加：自由填写的道具名解析成 propKey，清单里没有的名字不发请求", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    inputText(env.panelField(1), "椅子");
    click(env.button("添加道具"));
    await settle();
    assert.deepEqual(env.calls("prop/add")[0].msg.args, { key: "builtin:chair" },
        "面板上看见中文 label，页面 addProp 要的是带前缀的 propKey");
    assert.equal(env.panelField(1).value, "", "名字框是一次性的：写完就清，下一发不覆盖上一发");
    inputText(env.panelField(1), "细剑");
    click(env.button("添加道具"));
    await settle();
    assert.deepEqual(env.calls("prop/add")[1].msg.args, { key: "glb:sting-sword.glb" },
        "label 的全角括号后缀（细剑（Sting））按括号前的名字认");
    inputText(env.panelField(1), "沙发");
    click(env.button("添加道具"));
    await settle();
    assert.equal(env.calls("prop/add").length, 2, "道具表里没有的定义不许发请求");
    assert.match(env.toasts.join("|"), /道具表里没有「沙发」/);
});

test("resolvePropChoice：全 key、裸 id、中文名三种写法落到同一个 propKey", () => {
    assert.equal(resolvePropChoice("builtin:chair", META.props), "builtin:chair");
    assert.equal(resolvePropChoice("chair", META.props), "builtin:chair");
    assert.equal(resolvePropChoice("椅子", META.props), "builtin:chair");
    assert.equal(resolvePropChoice(" 箭 ", META.props), "glb:arrow.glb");
    assert.equal(resolvePropChoice("arrow.glb", META.props), "glb:arrow.glb");
    assert.equal(resolvePropChoice("ARROW", META.props), "glb:arrow.glb");
    assert.equal(resolvePropChoice("", META.props), "", "空输入交回空串，调用处走下拉那条路");
    assert.equal(resolvePropChoice("沙发", META.props), null, "没有的定义交回 null 让调用处提示");
});

test("pose:state 镜像：状态栏只镜像素体、人数与道具数", async () => {
    resetEnv();
    const env = await mounted();
    env.from({ type: "pose:state", state: STATE });
    await settle();
    const rows = [...env.host.querySelectorAll(PANEL + " .ns-pose-state-row")].map((r) => r.textContent);
    assert.ok(rows.some((r) => r.includes("girl")), "素体要落进状态栏");
    assert.ok(rows.some((r) => r.includes("素体数") && r.endsWith("2")), "人数要落进状态栏");
    assert.ok(rows.some((r) => r.includes("道具数") && r.endsWith("1")), "道具数要落进状态栏");
    assert.equal(rows.length, 3, "模式开关不进状态栏：摆姿靠点人物，轮廓线与吸附页面默认就是关");
    assert.equal(env.host.querySelectorAll(PANEL + " .ns-pose-checkrow").length, 0,
        "面板不出摆姿模式 / 吸附 / 轮廓线 / 主体层四个勾选");
});

test("外观默认暗色：meta/list 到位后面板把外观定在暗色档并下发 look/set", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    const look = env.calls("look/set")[0];
    assert.deepEqual(look.msg.args, { key: "dark" },
        "页面开局是摄影棚灰，面板按产品口径切到暗色档");
    assert.equal(env.sel(2).value, "dark", "外观下拉要显示当前档位，用户看得见切到了哪一档");
    env.replyCall(look, { look: "dark" });
    await settle();
});

test("外观默认暗色：旧摆姿包没有暗色档时不发只会失败的动作", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], { ...META, looks: [{ key: "studio", label: "摄影棚" }] });
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.equal(env.calls("look/set").length, 0, "清单里没有的档位不发");
});

test("姿势库：存为姿态走 pose/export 写文件，载入读文件交回 pose/apply，删除走单条接口", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    inputText(env.libField(0), "hero pose");
    click(env.button("存为姿态", LIB));
    await settle();
    env.replyCall(env.calls("pose/export")[0], { file: { version: 1, rig: {} } });
    await settle();
    const saved = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_pose/preset");
    assert.equal(saved.body.name, "hero pose");
    assert.deepEqual(saved.body.pose, { version: 1, rig: {} }, "PoseFile 原样落盘，宿主不改一个字段");
    assert.match(env.toasts.join("|"), /hero pose/);

    /* 点库里的一条就把它套上：不再有「载入姿态」第二步 */
    click(env.item("run pose", LIB));
    await settle();
    assert.deepEqual(env.calls("pose/apply")[0].msg.args.file, { version: 1, rig: {} },
        "点一条就是把库里那份交回页面套用");
    /* 输入框里的名字还是另一条路：手打的名称也能套，走的还是同一条套用路径 */
    inputText(env.libField(0), "run pose");
    click(env.button("载入姿态", LIB));
    await settle();
    assert.equal(env.calls("pose/apply").length, 2, "载入姿态复用同一条套用，不另写一份逻辑");

    click(env.button("删姿态", LIB));
    await settle();
    const del = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_pose/preset/delete");
    assert.equal(del.body.name, "run pose");
});

test("预设下拉一改就套：不再要「套用预设」第二步", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.ok(!env.button("套用预设", PANEL), "面板不再出这颗按钮");
    changeValue(env.sel(1), "run");
    await settle();
    assert.deepEqual(env.calls("preset/apply")[0].msg.args, { key: "run" }, "改下拉就是套用");
    assert.equal(env.sel(1).options.length, 2, "预设下拉来自 meta/list 那份清单");
});

test("ControlNet 图组：页面交回 files，宿主 POST 进 /neo_pose/export_set", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], { items: [], options: [], bones: [] });
    await settle();
    changeValue(env.sel(5), "side");
    changeValue(env.sel(6), "512");
    inputText(env.panelField(2), "hero");   // 面板输入框依次是自备素体 key、道具名、导出标签
    click(env.button("导出图组到素材库"));
    await settle();
    const call = env.calls("export/images")[0];
    assert.deepEqual(call.msg.args,
        { view: "side", size: 512, formats: ["skeleton", "depth"], label: "hero" });
    env.replyCall(call, {
        view: "side", size: 512,
        files: [
            { key: "skeleton", name: "pose_hero_side_openpose.png", data: "data:image/png;base64,AAE=" },
            { key: "depth", name: "pose_hero_side_depth.png", data: "data:image/png;base64,BBQ=" },
        ],
    });
    await settle();
    const post = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_pose/export_set");
    assert.deepEqual(post.body.files.map((f) => f.name),
        ["pose_hero_side_openpose.png", "pose_hero_side_depth.png"]);
    assert.match(env.toasts.join("|"), /已导出 2 张/);
});

test("画布截图：snapshot 动作交回 data，写 /neo_pose/export_image 后报落盘文件名", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    click(env.button("画布截图"));
    await settle();
    env.replyCall(env.calls("snapshot")[0], { data: "data:image/png;base64,AAE=" });
    await settle();
    const post = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_pose/export_image");
    assert.match(post.body.data, /^data:image\/png/);
    assert.match(env.toasts.join("|"), /pose_shot_1\.png/, "提示报的是落进素材库的那个文件名");
});

test("保存场景：页面回序列化结果，宿主按左栏写的名字写盘并清名字", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    inputText(env.libField(1), "hero scene");
    click(env.button("存为场景", LIB));
    await settle();
    env.reply("pose:save-scene", { scene: { camYaw: 42 } });
    await settle();
    const post = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_pose/scene");
    assert.deepEqual(post.body, { name: "hero scene", scene: { camYaw: 42 } });
    assert.equal(env.libField(1).value, "", "名字是一次性的：写完就清，下一发不覆盖上一发");
});

test("页面拒绝动作：原因进 toast，控件按能力位解锁", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    click(env.button("删当前素体"));
    await settle();
    env.replyCall(env.calls("member/remove")[0], "场上只剩一个素体，不能删", false);
    await settle();
    assert.match(env.toasts.join("|"), /场上只剩一个素体/);
    assert.ok([...env.host.querySelectorAll(PANEL + " .ns-pose-btn")].every((b) => !b.disabled),
        "失败之后控件要解锁，不许锁死面板");
});

test("导入素材：选中的那张经 /neo_pose/import_image 落进 refs，伺服地址送进页面", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    mockRoute("/neo_pose/import_image", () => jsonResponse({
        success: true, name: "a.png", url: "/neo_pose/refs/a.png",
    }));
    click(env.button("导入素材", ".ns-pose-bar"));   // 先开素材库，回调才交到手上来
    env.pick([{ filename: "a.png", subfolder: "角色" }]);
    await settle();
    const posted = fetchLog.find((f) => f.method === "POST" && f.path === "/neo_pose/import_image");
    assert.deepEqual(posted.body, { filename: "a.png", subfolder: "角色" },
        "素材库的坐标原样交后端解析：自定义目录、收藏与 OSS 预设缓存都只有它算得出来");
    const imported = env.sent.find((s) => s.msg.type === "neo:import-image");
    assert.equal(imported.msg.url, "/neo_pose/refs/a.png",
        "页面吃的必须是后端伺服的那份 —— 拼原生 /view 的话素材库自定义目录那张只会 404，画布上什么都不画");
    assert.equal(imported.msg.name, "a.png");
    assert.match(env.toasts.join("|"), /已贴上参考图：a\.png/);
});

test("导入素材：后端没落成交付时原因进 toast，不送坏地址，按钮解锁", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    mockRoute("/neo_pose/import_image", () => jsonResponse(
        { success: false, error: "素材不存在：a.png" }, 404));
    click(env.button("导入素材", ".ns-pose-bar"));
    env.pick([{ filename: "a.png", subfolder: "" }]);
    await settle();
    assert.match(env.toasts.join("|"), /素材不存在：a\.png/);
    assert.equal(env.sent.find((s) => s.msg.type === "neo:import-image"), undefined,
        "落不成就不许发 neo:import-image：页面接到坏地址只会静默什么都不画");
    assert.equal(env.button("导入素材", ".ns-pose-bar").disabled, false, "失败之后按钮要解锁");
});

test("跑在随包副本上：左栏说明只有 CC0 素体随包；跑在数据根那份上不出这句", async () => {
    resetEnv();
    const pkg = await mounted({ ...STATUS, dist_source: "package" });
    const note = (env) => env.host.querySelector(LIB + " .ns-pose-blank");
    assert.equal(note(pkg).hidden, false, "随包副本要说明随包的只有一份素体");
    assert.match(note(pkg).textContent, /CC0/);
    assert.match(note(pkg).textContent, /导入自备素体/);
    resetEnv();
    const data = await mounted({ ...STATUS, dist_source: "data_root" });
    assert.equal(note(data).hidden, true, "数据根那份压住随包副本时不用说明");
});

test("自备素体：本机 .glb 读成 base64 写进 /neo_pose/import_model，提示报回 key", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    mockRoute("/neo_pose/import_model", (body) => jsonResponse({
        success: true, key: body.key, name: `${body.key}.glb`,
        url: `/pose-dist/models/${body.key}.glb`, size: 100,
    }));
    const input = env.host.querySelector(".ns-pose-file");
    assert.ok(input, "文件选择器要在界面上（CSS 里藏着，借浏览器那套选择框）");
    const file = new window.File(["glTF-bytes"], "mixamo_a.glb", { type: "model/gltf-binary" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(20);
    await settle();
    const post = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_pose/import_model");
    assert.equal(post.body.key, "mixamo_a", "key 默认取文件名：页面按 <key>.glb 取文件");
    assert.match(post.body.data, /^[A-Za-z0-9+/=]+$/, "data 是纯 base64，dataURL 的头要剥掉");
    assert.match(env.toasts.join("|"), /mixamo_a/, "提示要把 key 报出来，页面本地登记要用它");
    assert.match(env.toasts.join("|"), /本地导入区/, "登记动作在页面侧，提示要说清去哪里登记");
});

test("自备素体：key 输入框优先，非法 key 与非 .glb 都挡在发请求之前", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    mockRoute("/neo_pose/import_model", (body) => jsonResponse({ success: true, key: body.key }));
    const input = env.host.querySelector(".ns-pose-file");
    const pick = (name, bytes) => {
        Object.defineProperty(input, "files", {
            value: [new window.File([bytes], name, { type: "application/octet-stream" })],
            configurable: true,
        });
        input.dispatchEvent(new window.Event("change", { bubbles: true }));
    };
    inputText(env.panelField(), "My Body");
    pick("a.glb", "glTF-bytes");
    await sleep(20);
    await settle();
    assert.match(env.toasts.join("|"), /素体 key 只允许/, "key 里带空格要挡下来");
    pick("a.png", "not a glb");
    await settle();
    assert.match(env.toasts.join("|"), /只支持 \.glb/);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_pose/import_model").length, 0,
        "两条挡下的路都不许发出请求");
    inputText(env.panelField(), "my_body");
    pick("a.glb", "glTF-bytes");
    await sleep(20);
    await settle();
    const post = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_pose/import_model");
    assert.equal(post.body.key, "my_body", "key 输入框优先于文件名");
    assert.equal(env.panelField().value, "", "key 是一次性的：写完就清，下一发不覆盖上一发");
});

test("previewOf / libFilter / libGroups / libTagsOf：缩略图优先级与搜索分层口径", () => {
    assert.equal(previewOf(POSE_LIB.entries[1]), "preview/calm-1.clay.png", "clay 是写实渲染那张，优先");
    assert.equal(previewOf(POSE_LIB.entries[0]), "preview/a.skeleton.png", "缺 clay 才落到 skeleton");
    assert.equal(previewOf({ preview: { depth: "x.depth.png" } }), "x.depth.png", "四档都没有时才落到 depth");
    assert.equal(previewOf({}), "", "没预览的条目交回空串，卡片自己出占位槽");
    assert.deepEqual(libFilter(POSE_LIB.entries, { q: "sword" }).map((e) => e.id), ["sword"]);
    assert.deepEqual(libFilter(POSE_LIB.entries, { q: "手臂绘图" }).map((e) => e.id), ["calm-1"],
        "分类名与 label 一起进搜索：库里分类名中英文各一条");
    assert.deepEqual(libFilter(POSE_LIB.entries, { group: "fight" }).map((e) => e.id), ["sword"]);
    assert.deepEqual(libGroups(POSE_LIB.entries, POSE_LIB.groups).map((s) => [s.key, s.items.length]),
        [["stand", 2], ["fight", 1]], "多组条目只落排最前的那个组，同 id 不许出现两张卡");
    assert.equal(libTagsOf(POSE_LIB.entries[1]), "手臂绘图参考 / arm-drawing-reference · photo3d");
    assert.equal(libTagsOf(POSE_LIB.entries[0]), "站立 / standing-poses", "preset 来源不上卡片副标题");
});

test("姿势库弹窗：卡片按预览优先级出缩略图，点卡片读库文件交回 pose/apply 并收窗", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    click(env.button("浏览姿势库…", LIB));
    await settle();
    const modal = () => env.host.querySelector(".ns-libmodal:not(.ns-hidden)");
    assert.ok(modal(), "弹窗要开着");
    assert.ok(fetchLog.some((c) => c.path === "/pose-lib/index.json"), "打开弹窗读一次索引清单");
    const cards = () => [...modal().querySelectorAll(".ns-pose-lib-card")];
    assert.equal(cards().length, 3, "库里三条 = 三张卡");
    const thumb = (id) => cards().find((c) => c.dataset.libId === id).querySelector(".ns-pose-lib-thumb");
    assert.equal(thumb("calm-1").getAttribute("src"), "/pose-lib/preview/calm-1.clay.png");
    assert.equal(thumb("a").getAttribute("src"), "/pose-lib/preview/a.skeleton.png");
    assert.equal(thumb("sword").getAttribute("src"), "/pose-lib/preview/sword.depth.png");
    assert.equal(modal().querySelector(".ns-pose-lib-more").hidden, true, "库里只有三条，不出加载更多");
    click(cards().find((c) => c.dataset.libId === "calm-1"));
    await settle();
    const apply = env.calls("pose/apply")[0];
    assert.deepEqual(apply.msg.args.file, { format: "pose-file/v1", rig: {} },
        "库里那份 PoseFile 原样交回页面，宿主不补字段");
    env.replyCall(apply, { applied: 42, missing: [] });
    await settle();
    assert.equal(env.host.querySelector(".ns-libmodal").classList.contains("ns-hidden"), true, "套用完要收窗");
    assert.match(env.toasts.join("|"), /双臂伸展 1/);
});

test("姿势库弹窗：搜索与分组下拉同一条过滤口径，卡片区按归并组分层", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    click(env.button("浏览姿势库…", LIB));
    await settle();
    const modal = () => env.host.querySelector(".ns-libmodal:not(.ns-hidden)");
    const titles = () => [...modal().querySelectorAll(".ns-pose-lib-group-title")].map((h) => h.textContent);
    assert.deepEqual(titles(), ["站立（2）", "格斗与武器（1）"], "分层按 index.json 的 groups 顺序走");
    inputText(modal().querySelector(".ns-pose-lib-search"), "双手持剑");
    assert.deepEqual([...modal().querySelectorAll(".ns-pose-lib-card")].map((c) => c.dataset.libId), ["sword"]);
    assert.equal(modal().querySelector(".ns-pose-lib-blank").hidden, true, "有匹配就不出空态文案");
    inputText(modal().querySelector(".ns-pose-lib-search"), "没有这个词");
    assert.equal(modal().querySelectorAll(".ns-pose-lib-card").length, 0);
    assert.equal(modal().querySelector(".ns-pose-lib-blank").hidden, false);
    assert.match(modal().querySelector(".ns-pose-lib-blank").textContent, /没有匹配/);
    inputText(modal().querySelector(".ns-pose-lib-search"), "");
    changeValue(modal().querySelector(".ns-pose-lib-group"), "fight");
    assert.deepEqual([...modal().querySelectorAll(".ns-pose-lib-card")].map((c) => c.dataset.libId), ["sword"],
        "分组下拉按 index.json 的 groups key 过滤");
    assert.deepEqual([...modal().querySelector(".ns-pose-lib-group").options].map((o) => o.value),
        ["", "stand", "fight"], "分组下拉来自索引的 groups，label 带中文归并组名与条数");
});

test("姿势库未同步：出同步指引，不给一个空浏览器", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, lib: null });
    await env.ready();
    click(env.button("浏览姿势库…", LIB));
    await settle();
    const blank = env.host.querySelector(".ns-pose-lib-blank");
    assert.equal(blank.hidden, false);
    assert.match(blank.textContent, /sync_pose_lib/);
    assert.equal(env.host.querySelectorAll(".ns-pose-lib-card").length, 0, "库没同步就不该渲染卡片");
    assert.match(env.toasts.join("|"), /pose-lib\/index\.json/);
});

test("本机姿势文件：读成 PoseFile 交回 pose/apply，坏 JSON 挡在发请求之前", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, lib: null });   // 库没同步也要能从本机挑一份
    await env.ready();
    click(env.button("浏览姿势库…", LIB));
    await settle();
    const input = [...env.host.querySelectorAll(".ns-pose-file")].find((i) => i.accept.includes(".pose.json"));
    assert.ok(input, "弹窗里的本机文件选择器要在界面上（CSS 里藏着，借浏览器那套选择框）");
    const pick = (text) => {
        Object.defineProperty(input, "files", {
            value: [new window.File([text], "mine.pose.json", { type: "application/json" })],
            configurable: true,
        });
        input.dispatchEvent(new window.Event("change", { bubbles: true }));
    };
    pick("{ not json");
    await sleep(20);
    await settle();
    assert.match(env.toasts.join("|"), /本机文件不是一份 JSON 对象/);
    assert.equal(env.calls("pose/apply").length, 0, "坏 JSON 不许发 pose:call");
    pick(JSON.stringify({ format: "pose-file/v1", rig: {} }));
    await sleep(20);
    await settle();
    const apply = env.calls("pose/apply")[0];
    assert.deepEqual(apply.msg.args.file, { format: "pose-file/v1", rig: {} });
    env.replyCall(apply, { applied: 1, missing: [] });
    await settle();
    assert.match(env.toasts.join("|"), /mine\.pose\.json/);
    assert.equal(env.host.querySelector(".ns-libmodal").classList.contains("ns-hidden"), true, "套用完要收窗");
});

test("场景弹窗：列数据根的存档，点一条装进页面并收窗；本机场景文件同一条装载路", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    click(env.button("浏览场景…", LIB));
    await settle();
    const rows = [...env.host.querySelectorAll(".ns-pose-lib-list .ns-pose-item")];
    assert.deepEqual(rows.map((r) => r.textContent), ["hero"], "弹窗里列的是数据根 pose/scenes 那份存档");
    click(rows[0]);
    await settle();
    assert.equal(env.sent.find((s) => s.msg.type === "pose:open-scene").msg.scene.camYaw, 42);
    assert.equal(env.host.querySelector(".ns-libmodal").classList.contains("ns-hidden"), true, "装载完要收窗");
    const input = [...env.host.querySelectorAll(".ns-pose-file")].find((i) => i.accept === ".json");
    Object.defineProperty(input, "files", {
        value: [new window.File([JSON.stringify({ camYaw: 7 })], "local.json", { type: "application/json" })],
        configurable: true,
    });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(20);
    await settle();
    const opened = env.sent.filter((s) => s.msg.type === "pose:open-scene");
    assert.equal(opened.length, 2, "本机那份与数据根那条走同一条装载路");
    assert.deepEqual(opened[1].msg.scene, { camYaw: 7 });
    assert.match(env.toasts.join("|"), /local\.json/);
});
