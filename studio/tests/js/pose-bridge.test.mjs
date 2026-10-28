// 3D 摆姿宿主：iframe 承载、桥的门禁与收发、面板动作往返（pose:call / pose:state），
// 以及桥接结果落到的那几个 /neo_pose 接口。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, click, changeValue, inputText, flush, sleep, window } from "./setup.mjs";
import { $el } from "../../web/studio/shim/ui.js";
import { createPoseView, poseMaterialUrl, POSE_PAGE_URL } from "../../web/pose/pose.js";

const api = { fetchApi: (path, opts) => fetch(path, opts) };
const LIB = ".ns-pose-side:not(.ns-pose-panel)";
const PANEL = ".ns-pose-panel";

/** 一次面板动作要跨两次 fetch 与一次桥回复：微任务与定时器各放一遍才到终点 */
const settle = async () => { await flush(); await sleep(0); await flush(); };

/** meta/list 的 fixture：面板每个下拉与勾选组都从这一份清单渲染 */
const META = {
    models: [{ key: "girl", label: "少女" }],
    presets: [{ key: "run", label: "奔跑" }],
    props: [{ key: "sword", label: "长剑" }],
    formats: [
        { key: "skeleton", label: "骨架图", suffix: "openpose", hint: "OpenPose 输入" },
        { key: "depth", label: "深度图", suffix: "depth", hint: "depth 输入" },
    ],
    views: [{ key: "front", label: "正面" }, { key: "side", label: "侧面" }],
    sizes: [256, 512, 1024, 2048],
    bones: ["hips", "head"],
    looks: [{ key: "studio", label: "棚拍" }],
    maxExportSize: 1024,
};
const PROPS = { items: [{ id: "p1", label: "长剑", attach: null }], options: META.props, bones: META.bones };
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
        checks: () => [...host.querySelectorAll(PANEL + " .ns-pose-checkrow input")],
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
    assert.match(env.host.querySelector(PANEL + " .ns-pose-item").textContent, /长剑 · 未挂载/);
    env.replyCall(env.calls("meta/list")[0], META);
    await settle();
    assert.deepEqual([...env.sel(0).options].map((o) => o.value), ["", "girl"], "素体下拉来自 meta");
    assert.deepEqual([...env.sel(5).options].map((o) => o.value), ["", "front", "side"], "视角下拉来自 meta");
    assert.deepEqual([...env.sel(6).options].map((o) => o.value), ["", "256", "512", "1024", "2048"]);
    assert.equal(env.host.querySelectorAll(PANEL + " .ns-pose-format input").length, 2, "格式勾选组来自 meta");
});

test("pose:state 镜像：状态栏与开关跟着画布对账", async () => {
    resetEnv();
    const env = await mounted();
    env.from({ type: "pose:state", state: STATE });
    await settle();
    const rows = [...env.host.querySelectorAll(PANEL + " .ns-pose-state-row")].map((r) => r.textContent);
    assert.ok(rows.some((r) => r.includes("girl")), "素体要落进状态栏");
    assert.ok(rows.some((r) => r.includes("素体数") && r.endsWith("2")), "人数要落进状态栏");
    assert.ok(rows.some((r) => r.includes("摆姿模式") && r.endsWith("开")), "摆姿模式显示为开");
    assert.equal(env.checks()[0].checked, true);
    assert.equal(env.checks()[1].checked, false);
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

    click(env.item("run pose", LIB));
    click(env.button("载入姿态", LIB));
    await settle();
    assert.deepEqual(env.calls("pose/apply")[0].msg.args.file, { version: 1, rig: {} },
        "载入是把库里的文件交回页面套用");

    click(env.button("删姿态", LIB));
    await settle();
    const del = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_pose/preset/delete");
    assert.equal(del.body.name, "run pose");
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
    inputText(env.panelField(1), "hero");   // 面板里第一个输入框是自备素体的 key，第二个才是导出标签
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

test("导入素材：素材库选中项变成同源 /view URL 送进页面", async () => {
    resetEnv();
    assert.equal(poseMaterialUrl(null), "");
    const env = await mounted();
    await env.ready();
    click(env.button("导入素材", ".ns-pose-bar"));   // 先开素材库，回调才交到手上来
    env.pick([{ filename: "a.png", subfolder: "角色", type: "output" }]);
    const imported = env.sent.find((s) => s.msg.type === "neo:import-image");
    assert.match(imported.msg.url, /^\/view\?filename=a\.png/);
    assert.match(imported.msg.url, /subfolder=/);
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
