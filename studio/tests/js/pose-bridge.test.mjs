// 3D 姿势宿主：iframe 承载、桥的门禁与收发、面板动作往返（pose:call / pose:state），
// 以及桥接结果落到的那几个 /neo_pose 接口。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, click, changeValue, inputText, flush, sleep, clearBody, window } from "./setup.mjs";
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
    // 道具项的真实形状来自姿势页 src/core/propKit.js 的 listPropOptions：键名是 propKey，不是 key；
    // preview 是道具目录里的预览图相对路径（内置道具没有注册表行，这一项是空串，面板按约定名取图）
    props: [
        { propKey: "builtin:chair", label: "椅子", source: "builtin", preview: "" },
        { propKey: "glb:arrow.glb", label: "箭", source: "glb", preview: "preview/arrow.png" },
        { propKey: "glb:sting-sword.glb", label: "细剑（Sting）", source: "glb", preview: "preview/sting-sword.png" },
    ],
    formats: [
        { key: "skeleton", label: "骨架图", suffix: "openpose", hint: "OpenPose 输入" },
        { key: "depth", label: "深度图", suffix: "depth", hint: "depth 输入" },
    ],
    views: [{ key: "front", label: "正面" }, { key: "side", label: "侧面" }],
    sizes: [256, 512, 1024, 2048],
    bones: ["hips", "head"],
    // 外观两档来自姿势页 core/scene.js 的 LOOKS：studio 是页面开局的摄影棚灰，dark 是暗色
    looks: [{ key: "studio", label: "摄影棚" }, { key: "dark", label: "暗色" }],
    maxExportSize: 1024,
};
/** 随包 CC0 姿势包那份素体表：表首就是姿势仓库 CHARACTERS 的标准男基座，
    默认素体与基座筛选两条路都认它，旧包的素体表只有用户自备的那几具 */
const META_CC0 = {
    ...META,
    models: [{ key: "bodyMale", label: "标准男素体" }, { key: "bodyFemale", label: "标准女素体" },
             { key: "girl", label: "少女" }],
};
const PROPS = { items: [{ id: "p1", label: "椅子", attach: null }], options: META.props, bones: META.bones };
const STATE = {
    ready: true, model: "girl", members: 2, poseMode: true, snap: false,
    outline: true, subjects: true, look: "studio", props: 1,
};
const STATUS = {
    success: true, installed: true,
    // 生效的那一级与随包清单：宿主左栏据此决定要不要出「跑在随包副本上」的说明
    dist_source: "data_root", package_installed: true, models_present: ["bodyMale.glb"],
    manifest_version: "neo-studio-pose-package/1",
    caps: { pose: true, export: true, photo3d: false, hostUi: true, body_import: true },
    scenes: [{ name: "hero", size: 12, mtime: 1 }],
    lib_installed: true, lib_entries: 3, lib_bytes: 4096,
    bridge: ["pose:ready", "pose:theme", "pose:state", "pose:call"],
    hint: "",
};

/** pose-lib 的索引 fixture：形状来自姿势仓库 poseLibrary.js 的 buildIndex（3dpose.index/1）。
    库里一份条目是一整场（people / props 在清单里），条目带 groups / categories / preview / charKey，
    preview 是「档位 → 图」的对象（clay 优先、缺档往下落），charKey 是这条姿态挂的基座
    （同步脚本按姿势仓库 lib:bodies 的分派结果写进索引；没有分派结果的条目不带这个字段），
    缩略图优先级、无预览占位与分层口径都钉在这份上 */
const POSE_LIB = {
    format: "3dpose.index/1",
    count: 4,
    groups: [{ key: "stand", label: "站立", count: 3 }, { key: "fight", label: "格斗与武器", count: 1 }],
    entries: [
        { id: "a", label: "A-Pose 标定", path: "poses/stand/a.scene.json", kind: "scene",
          people: 1, props: 0, groups: ["stand"], charKey: "girl",
          categories: ["站立", "standing-poses"], tags: ["preset"], source: "preset", origin: "lib",
          preview: { skeleton: "preview/a.skeleton.png", silhouette: "preview/a.silhouette.png" } },
        { id: "calm-1", label: "双臂伸展 1", path: "poses/calm/calm-1.scene.json", kind: "scene",
          people: 2, props: 0, groups: ["calm", "stand"], charKey: "girl",
          categories: ["手臂绘图参考", "arm-drawing-reference"], source: "photo3d", origin: "lab",
          preview: { clay: "preview/calm-1.clay.png", skeleton: "preview/calm-1.skeleton.png" } },
        { id: "sword", label: "双手持剑", path: "poses/fight/sword.scene.json", kind: "scene",
          people: 2, props: 1, groups: ["fight"], categories: ["格斗", "sword"], source: "preset", origin: "lib",
          charKey: "girl", preview: {} },
        { id: "fem-1", label: "侧坐扶手", path: "poses/stand/fem-1.scene.json", kind: "scene",
          people: 1, props: 1, groups: ["stand"],
          categories: ["坐姿", "sitting"], source: "preset", origin: "lib",
          preview: { clay: "preview/fem-1.clay.png" } },
    ],
};

/** 库里一份场景文件（3dpose.scene/1）：两副骨架加一份视角，套用的就是这一整场 */
const LIB_SCENE = {
    format: "3dpose.scene/1",
    subjects: [{ kind: "rig", id: "rig-1", charKey: "bodyMale" }, { kind: "rig", id: "rig-2", charKey: "bodyMale" }],
    view: { camera: [1.4, 1.4, 4.5], target: [0, 0.9, 0], fov: 45 },
};

/** 云端清单的 fixture（格式 neo-pose-cloud/1，studio/pose_cloud.py 的形状）：行字段与 POSE_LIB 同名，
    多出来的只有 base_url（预览图直连的那一级）与 cloud 标记；道具的 path 是页面写死的 models/props/ */
const CLOUD_INDEX = {
    success: true, source: "remote", format: "neo-pose-cloud/1",
    base_url: "https://oss.example/neo/pose/",
    count: 2,
    groups: [{ key: "stand", label: "站立", count: 2 }],
    entries: [
        { id: "c1", label: "云端站姿", path: "poses/stand/c1.scene.json", kind: "scene",
          people: 1, props: 0, groups: ["stand"], charKey: "girl", origin: "cloud", cloud: true,
          categories: ["站立"], preview: { clay: "preview/c1.clay.png" } },
        { id: "c2", label: "云端坐姿", path: "poses/stand/c2.scene.json", kind: "scene",
          people: 1, props: 0, groups: ["stand"], charKey: "girl", origin: "cloud", cloud: true,
          categories: ["坐姿"], preview: {} },
    ],
    props: [{ id: "stick", label: "木棍", file: "stick-cloud.glb", path: "models/props/stick-cloud.glb",
              preview: "preview/stick-cloud.png", origin: "cloud", cloud: true }],
};
const CLOUD_SCENE = {
    format: "3dpose.scene/1",
    subjects: [{ kind: "rig", id: "rig-9", charKey: "bodyMale" }],
    view: { camera: [2, 2, 5], target: [0, 0.9, 0], fov: 45 },
};
/** 云端配好那一条：素材库云端预设同 bucket 的 neo/pose/（pose_cloud.py 的 cloud_urls） */
const CLOUD_ON = { success: true, enabled: true, available: true, scenes: 2, props: 1,
                   base_url: "https://oss.example/neo/pose/", groups: CLOUD_INDEX.groups };


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
    mockRoute("/neo_pose/scene", (body, call) => call.method === "POST"
        ? jsonResponse({ success: true, name: body?.name })
        : jsonResponse({ success: true, scene: { camYaw: 42 } }));
    mockRoute("/neo_pose/export_image", () => jsonResponse({ success: true, filename: "pose_shot_1.png" }));
    mockRoute("/neo_pose/export_set", (body) => jsonResponse({
        success: true,
        saved: (body?.files || []).map((f) => f.name),
        count: (body?.files || []).length,
    }));
    // 场景库的两条静态读：索引清单不带 success 外壳，库里的一份场景就是场景文件原样
    mockRoute("/pose-lib/index.json", () => jsonResponse(status.lib === undefined ? POSE_LIB : status.lib));
    mockRoute("/pose-lib/poses/calm/calm-1.scene.json", () => jsonResponse(LIB_SCENE));
    // 云端三接口（studio/pose_cloud.py）：默认「未配置」，带 cloud_status 的用例才把云端打开
    mockRoute("/neo_pose/cloud_status",
        () => jsonResponse(status.cloud_status || { success: true, enabled: false, available: false }));
    mockRoute("/neo_pose/cloud_index",
        () => jsonResponse(status.cloud_index === undefined ? CLOUD_INDEX : status.cloud_index));
    mockRoute("/neo_pose/cloud_file", (body, call) => (call.query.get("path") || "").endsWith(".glb")
        ? jsonResponse({})
        : jsonResponse(status.cloud_file === undefined ? CLOUD_SCENE : status.cloud_file));


    const host = $el("div");
    document.body.appendChild(host);
    const sent = [];
    const toasts = [];
    const cw = { postMessage: (msg, origin, ports = []) => sent.push({ msg, origin, ports }) };
    const env = {
        host, sent, toasts, cw,
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
    const build = createPoseView({ api, $el, toast: (m) => toasts.push(m) });
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
});

test("装好包：iframe 指短路径并带沙箱，pose:ready 之前控件全禁用", async () => {
    resetEnv();
    const env = await mounted();
    const frame = env.host.querySelector(".ns-pose-frame");
    assert.equal(frame.getAttribute("src"), POSE_PAGE_URL);
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-downloads");
    assert.equal(env.host.querySelector(".ns-pose-bar"), null, "顶栏那条「3D 姿势」行整条不出");
    // 收起钮是布局入口，不在门禁里：页面没 ready 时也要能把栏收起来看画布
    const gated = () => [...env.host.querySelectorAll(".ns-pose-btn:not(.ns-pose-collapse), .ns-pose-sel, .ns-pose-checkrow input")];
    assert.ok(gated().length > 15, "面板与库的控件要在位");
    assert.ok(gated().every((n) => n.disabled), "页面没 ready 时控件不能点");
    assert.ok(env.host.querySelectorAll(".ns-pose-collapse").length === 2, "两栏各一枚收起钮");
    assert.ok([...env.host.querySelectorAll(".ns-pose-collapse")].every((b) => !b.disabled),
        "收起钮不吃 ready 门禁");
    await env.ready();
    const theme = env.sent.find((s) => s.msg.type === "pose:theme");
    assert.equal(theme.msg.caps.hostUi, true, "宿主面板能力位要随主题下发");
    assert.equal(theme.msg.caps.photo3d, false, "要 sidecar 的能力位一并下发");
});

test("桥只认本页 iframe 的同源消息", async () => {
    resetEnv();
    const env = await mounted();
    const panelBtn = () => env.host.querySelector(PANEL + " .ns-pose-btn:not(.ns-pose-collapse)");
    env.from({ type: "pose:ready" }, { postMessage() {} });   // 别的来源冒充页面
    assert.ok(panelBtn().disabled, "来源不是这张 iframe 就不认");
    env.from({ type: "pose:ready" }, env.cw, "http://evil.local");   // 来源对、origin 不对
    assert.ok(panelBtn().disabled, "非同源的 ready 不解锁控件");
});

test("旧姿势包（caps.hostUi 关）：面板禁用并说明缺什么，场景读写照旧", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, caps: { ...STATUS.caps, hostUi: false } });
    await env.ready();
    assert.equal(env.host.querySelector(PANEL + " .ns-pose-notice").hidden, false, "旧包要出提示");
    assert.match(env.host.querySelector(PANEL + " .ns-pose-notice").textContent, /sync_pose_dist/);
    const panelBtns = [...env.host.querySelectorAll(PANEL + " .ns-pose-btn")]
        .filter((b) => !b.classList.contains("ns-pose-collapse"));
    const importBody = env.button("导入自备素体");
    assert.ok(panelBtns.every((b) => b === importBody || b.disabled),
        "没有命令层就不出点了只会空转的控件");
    assert.equal(importBody.disabled, false,
        "自备素体导入走宿主自己的接口，不依赖姿势页的命令层，旧包也照旧可点");
    assert.equal(env.host.querySelector(PANEL + " .ns-pose-collapse").disabled, false,
        "收起栏是布局偏好，不是页面动作：控件整片禁用时栏也收得回去");
    assert.equal(env.calls().length, 0, "旧包不许发 pose:call");
    click(env.item("hero", LIB));
    click(env.button("载入场景", LIB));
    await settle();
    assert.equal(env.sent.find((s) => s.msg.type === "pose:open-scene").msg.scene.camYaw, 42,
        "读写数据根文件的通道不受 hostUi 影响");
});

test("左右栏收起：栏首的收起钮收栏，栏首留在原地当展开入口", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    const body = env.host.querySelector(".ns-pose-body");
    const lib = env.host.querySelector(LIB);
    const panel = env.host.querySelector(PANEL);
    const sideBtn = (scope) => env.host.querySelector(scope + " .ns-pose-collapse");
    const paneW = (scope) => Number(sideBtn(scope).querySelector(".ns-pose-collapse-pane").getAttribute("width"));
    const rulePath = (scope) => sideBtn(scope).querySelector("path").getAttribute("d");
    assert.equal(lib.getAttribute("data-collapsed"), "0", "开局两栏都展开");
    assert.equal(body.getAttribute("data-lib"), "on");
    assert.equal(body.getAttribute("data-panel"), "on");
    const wide = paneW(LIB);
    assert.equal(sideBtn(LIB).querySelector("svg").getAttribute("aria-hidden"), "true", "钮面上只有图标，图标不进读屏");
    assert.equal(sideBtn(LIB).getAttribute("aria-label"), "收起场景库", "图标钮要有读屏念得出的话");
    assert.equal(rulePath(LIB), "M9.5 7v10", "左栏图标：分隔线在左，填实格是场景库那一栏");
    assert.equal(rulePath(PANEL), "M14.5 7v10", "右栏图标镜像：分隔线在右");
    click(sideBtn(LIB));
    assert.equal(lib.getAttribute("data-collapsed"), "1");
    assert.equal(body.getAttribute("data-lib"), "off", "画布要吃到场景库让出来的那一列");
    assert.equal(lib.querySelector(".ns-pose-side-head").hidden, false, "收起后栏首就是整栏全部，展开入口必须在");
    assert.equal(sideBtn(LIB).title, "展开场景库", "钮上的话要说清收的是哪一栏");
    assert.ok(paneW(LIB) < wide, "图标里那一格缩成一条 —— 栏现在是窄的，图标要说得出来");
    click(sideBtn(LIB));
    assert.equal(lib.getAttribute("data-collapsed"), "0");
    assert.equal(body.getAttribute("data-lib"), "on");
    assert.equal(paneW(LIB), wide, "展开回来图标那一格回到满格");
    click(sideBtn(PANEL));
    assert.equal(panel.getAttribute("data-collapsed"), "1");
    assert.equal(body.getAttribute("data-panel"), "off");
    assert.equal(JSON.parse(localStorage.getItem("neo_studio_pose_sides")).panel, true,
        "收起偏好要落盘，重开窗口停在原处");
    clearBody();   // 切走再回来：新视图建在干净的 body 上，只剩那份偏好
    const again = await mounted();
    await again.ready();
    assert.equal(again.host.querySelector(PANEL).getAttribute("data-collapsed"), "1",
        "新视图回灌上次的收起偏好");
    assert.equal(again.host.querySelector(LIB).getAttribute("data-collapsed"), "0",
        "没收过的那一栏照旧展开");
    assert.equal(again.host.querySelector(PANEL + " .ns-pose-collapse").title, "展开控制面板",
        "回灌的栏首钮要说得清现在收的是哪一栏");
    localStorage.removeItem("neo_studio_pose_sides");
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
    assert.deepEqual([...env.sel(3).options].map((o) => o.value), ["", "front", "side"], "视角下拉来自 meta");
    assert.deepEqual([...env.sel(4).options].map((o) => o.value), ["", "256", "512", "1024", "2048"]);
    assert.equal(env.host.querySelectorAll(PANEL + " .ns-pose-format input").length, 2, "格式勾选组来自 meta");
});

test("道具卡片：一张卡一个 propKey 与一张预览图，点卡片选中、「添加道具」发的就是那一项", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    const cards = () => [...env.host.querySelectorAll(".ns-pose-prop-card")];
    assert.deepEqual(cards().map((c) => c.dataset.propKey),
        ["builtin:chair", "glb:arrow.glb", "glb:sting-sword.glb"],
        "卡片顺序就是 meta/list 那份清单：卡片带的是页面的 propKey，label 只当显示名");
    assert.ok(cards()[0].classList.contains("ns-pose-prop-on"),
        "第一张卡片默认选中：「添加道具」将拿到哪件必须在面板上看得见");
    assert.equal(cards()[1].querySelector(".ns-pose-prop-thumb").getAttribute("src"),
        "/models/props/preview/arrow.png",
        "预览图走页面写死的那一级 /models/props/，注册表 preview 原样拼地址");
    assert.equal(cards()[0].querySelector(".ns-pose-prop-thumb").getAttribute("src"),
        "/models/props/preview/builtin-chair.png",
        "内置道具没有注册表行：按 preview/builtin-<id>.png 这条约定名取图");
    click(cards()[2]);
    await settle();
    assert.ok(cards()[2].classList.contains("ns-pose-prop-on"), "点过的卡片要标出来");
    assert.ok(!cards()[0].classList.contains("ns-pose-prop-on"), "选中项只有一个");
    assert.match(env.host.querySelector(".ns-pose-prop-meta").textContent, /3 件道具 · 选中 细剑/);
    click(env.button("添加道具"));
    await settle();
    assert.deepEqual(env.calls("prop/add")[0].msg.args, { key: "glb:sting-sword.glb" },
        "页面 addProp 要的是带前缀的 propKey，卡片上看见的是中文 label");
});

test("道具面板没有挂骨点：没有「挂到骨点」按钮、没有骨点下拉，加具不发 prop/attach", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.ok(!env.button("挂到骨点"), "挂骨点是姿势页物体面板的事，Neo Studio 的道具只落地");
    assert.ok(env.host.querySelector(".ns-pose-prop-search"), "道具改的是带搜索框的卡片列表");
    const panelSelects = [...env.host.querySelectorAll(PANEL + " select")].map((s) => s.title);
    assert.ok(!panelSelects.includes("挂点骨"), "面板不再有骨点下拉：" + panelSelects.join("/"));
    click([...env.host.querySelectorAll(".ns-pose-prop-card")][0]);
    click(env.button("添加道具"));
    await settle();
    assert.equal(env.calls("prop/attach").length, 0, "加具这条路上没有挂骨那一步");
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
    assert.equal(rows.length, 3, "模式开关不进状态栏：姿势靠点人物，轮廓线与吸附页面默认就是关");
    assert.equal(env.host.querySelectorAll(PANEL + " .ns-pose-checkrow").length, 0,
        "面板不出姿势模式 / 吸附 / 轮廓线 / 主体层四个勾选");
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

test("外观默认暗色：旧姿势包没有暗色档时不发只会失败的动作", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], { ...META, looks: [{ key: "studio", label: "摄影棚" }] });
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.equal(env.calls("look/set").length, 0, "清单里没有的档位不发");
});

test("场景库：左栏只有场景那一条路，点存档与「载入场景」共用同一次 pose:open-scene", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    assert.ok(!env.button("存为姿态", LIB) && !env.button("载入姿态", LIB) && !env.button("删姿态", LIB),
        "左栏不再写 pose/presets 那批姿态文件，控件就不出");
    assert.ok(!env.button("浏览姿势库…", LIB) && !env.button("浏览场景…", LIB), "浏览只有一颗钮");
    assert.ok(env.button("浏览场景库…", LIB), "一颗钮开场景库弹窗");

    click(env.item("hero", LIB));
    await settle();
    let opened = env.sent.filter((s) => s.msg.type === "pose:open-scene");
    assert.equal(opened.length, 1, "点一条存档 = 一次装载，不另发第二条消息");
    assert.equal(opened[0].msg.scene.camYaw, 42, "读回来的那份场景原样交回页面，宿主不改一个字段");

    /* 输入框里的名字是另一条路：手写的名字也装得进，走的还是同一条装载路 */
    inputText(env.libField(0), "hero");
    click(env.button("载入场景", LIB));
    await settle();
    opened = env.sent.filter((s) => s.msg.type === "pose:open-scene");
    assert.equal(opened.length, 2, "载入场景复用同一条装载路，不另写一份逻辑");
    assert.match(env.toasts.join("|"), /hero/);
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
    changeValue(env.sel(3), "side");
    changeValue(env.sel(4), "512");
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
    inputText(env.libField(0), "hero scene");
    click(env.button("存为场景", LIB));
    await settle();
    env.reply("pose:save-scene", { scene: { camYaw: 42 } });
    await settle();
    const post = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_pose/scene");
    assert.deepEqual(post.body, { name: "hero scene", scene: { camYaw: 42 } });
    assert.equal(env.libField(0).value, "", "名字是一次性的：写完就清，下一发不覆盖上一发");
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
    assert.deepEqual(libFilter(POSE_LIB.entries, { origin: "lib" }).map((e) => e.id), ["a", "sword", "fem-1"],
        "来源筛选只放过预设条目");
    assert.deepEqual(libFilter(POSE_LIB.entries, { origin: "lab" }).map((e) => e.id), ["calm-1"]);
    assert.deepEqual(libFilter([{ id: "no-origin", groups: ["stand"] }], { origin: "lab" }).map((e) => e.id),
        ["no-origin"], "旧版清单没有 origin 字段 = 本地库那一份（合并库落在本机，预设是拆库才有的）");
    assert.deepEqual(libFilter(POSE_LIB.entries, { origin: "lab", q: "双臂" }).map((e) => e.id), ["calm-1"],
        "来源与搜索是同一条过滤口径的两刀");
    assert.deepEqual(libFilter(POSE_LIB.entries, { charKey: "girl" }).map((e) => e.id), ["a", "calm-1", "sword"],
        "基座筛选只放过挂在当前基座上的条目");
    assert.deepEqual(libFilter(POSE_LIB.entries, { charKey: "bodyFemale" }).map((e) => e.id), [],
        "条目没有 charKey 时基座筛不掉它：旧版清单的条目只在「全部基座」那一档可见");
    assert.deepEqual(libGroups(POSE_LIB.entries, POSE_LIB.groups).map((s) => s.count), [3, 1],
        "分组条数从过滤后的分层数出来，来源一筛下拉就跟着变");
    assert.deepEqual(libGroups(POSE_LIB.entries, POSE_LIB.groups).map((s) => [s.key, s.items.length]),
        [["stand", 3], ["fight", 1]], "多组条目只落排最前的那个组，同 id 不许出现两张卡");
    assert.equal(libTagsOf(POSE_LIB.entries[1]), "2人 · 0道具 · 手臂绘图参考 / arm-drawing-reference · photo3d");
    assert.equal(libTagsOf(POSE_LIB.entries[0]), "1人 · 0道具 · 站立 / standing-poses", "preset 来源不上来源那一档");
});

test("场景库弹窗：卡片按预览优先级出缩略图与人数，点卡片读库文件走一次 scene/apply 并收窗", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    click(env.button("浏览场景库…", LIB));
    await settle();
    const modal = () => env.host.querySelector(".ns-libmodal:not(.ns-hidden)");
    assert.ok(modal(), "弹窗要开着");
    assert.ok(fetchLog.some((c) => c.path === "/pose-lib/index.json"), "打开弹窗读一次索引清单");
    const cards = () => [...modal().querySelectorAll(".ns-pose-lib-card")];
    changeValue(modal().querySelector(".ns-pose-lib-char"), "");   // 基座筛选默认停在当前素体，四条卡片要在「全部基座」那一档才全出来
    assert.equal(cards().length, 4, "库里四条 = 四张卡");
    const card = (id) => cards().find((c) => c.dataset.libId === id);
    assert.equal(card("calm-1").querySelector(".ns-pose-lib-thumb").getAttribute("src"),
        "/pose-lib/preview/calm-1.clay.png");
    assert.equal(card("a").querySelector(".ns-pose-lib-thumb").getAttribute("src"),
        "/pose-lib/preview/a.skeleton.png");
    assert.ok(!card("sword").querySelector(".ns-pose-lib-thumb"), "四档全无的条目出占位，不出图");
    assert.match(card("sword").textContent, /无预览/);
    assert.ok(card("calm-1").querySelector(".ns-pose-lib-ref") && card("a").querySelector(".ns-pose-lib-ref"),
        "预览是姿势仓库对参考图的渲染，卡片要标住它是参考图：参考图版式能把同一个人画两遍");
    assert.ok(!card("sword").querySelector(".ns-pose-lib-ref"), "没图的卡片不标参考图");
    assert.match(card("calm-1").textContent, /2人/,
        "多人场景要在卡片副标题上看得见，挑的时候就知道这场有几个人");
    assert.equal(modal().querySelector(".ns-pose-lib-more").hidden, true, "库里只有四条，不出加载更多");
    click(cards().find((c) => c.dataset.libId === "calm-1"));
    await settle();
    const apply = env.calls("scene/apply")[0];
    assert.deepEqual(apply.msg.args.file, LIB_SCENE,
        "库里那份场景文件原样交回页面，宿主不补字段");
    env.replyCall(apply, { ok: true, rigsApplied: 2, propsApplied: 1 });
    await settle();
    assert.equal(env.host.querySelector(".ns-libmodal").classList.contains("ns-hidden"), true, "套用完要收窗");
    assert.match(env.toasts.join("|"), /双臂伸展 1.*2 副骨架/, "报清套上了几副骨架，多人场景要看得见");
});

test("场景库弹窗：页面报整场没套上时说清原因，不收窗也不报成功", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    click(env.button("浏览场景库…", LIB));
    await settle();
    changeValue(env.host.querySelector(".ns-pose-lib-char"), "");   // 基座筛选默认停在当前素体，卡片要在「全部基座」那一档才全出来
    const card = [...env.host.querySelectorAll(".ns-pose-lib-card")].find((c) => c.dataset.libId === "calm-1");
    click(card);
    await settle();
    env.replyCall(env.calls("scene/apply")[0],
        { ok: false, stage: "validate", errors: ["场上素体不足，2 副骨架没套上"] });
    await settle();
    assert.match(env.toasts.join("|"), /场上素体不足/, "页面的那一句原因要透到面板上");
    assert.equal(env.host.querySelector(".ns-libmodal").classList.contains("ns-hidden"), false,
        "没套成就不收窗，用户可以接着挑一条");
});

test("场景库弹窗：搜索与分组下拉同一条过滤口径，卡片区按归并组分层", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    click(env.button("浏览场景库…", LIB));
    await settle();
    const modal = () => env.host.querySelector(".ns-libmodal:not(.ns-hidden)");
    const titles = () => [...modal().querySelectorAll(".ns-pose-lib-group-title")].map((h) => h.textContent);
    changeValue(modal().querySelector(".ns-pose-lib-char"), "");   // 基座筛选默认停在当前素体，搜索与分组要在「全部基座」那一档看
    assert.deepEqual(titles(), ["站立（3）", "格斗与武器（1）"], "分层按 index.json 的 groups 顺序走");
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

test("场景库未同步：出同步指引，不给一个空浏览器", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, lib: null });
    await env.ready();
    click(env.button("浏览场景库…", LIB));
    await settle();
    const blank = env.host.querySelector(".ns-pose-lib-blank");
    assert.equal(blank.hidden, false);
    assert.match(blank.textContent, /sync_pose_lib/);
    assert.equal(env.host.querySelectorAll(".ns-pose-lib-card").length, 0, "库没同步就不该渲染卡片");
    assert.match(env.toasts.join("|"), /pose-lib\/index\.json/);
});

test("本机场景文件：读成场景装进页面并收窗，坏 JSON 挡在发请求之前", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, lib: null });   // 库没同步也要能从本机挑一份
    await env.ready();
    click(env.button("浏览场景库…", LIB));
    await settle();
    const input = [...env.host.querySelectorAll(".ns-pose-file")].find((i) => i.accept === ".json");
    assert.ok(input, "弹窗里的本机场景文件选择器要在界面上（CSS 里藏着，借浏览器那套选择框）");
    const pick = (text) => {
        Object.defineProperty(input, "files", {
            value: [new window.File([text], "mine.scene.json", { type: "application/json" })],
            configurable: true,
        });
        input.dispatchEvent(new window.Event("change", { bubbles: true }));
    };
    pick("{ not json");
    await sleep(20);
    await settle();
    assert.match(env.toasts.join("|"), /本机文件不是一份 JSON 对象/);
    assert.equal(env.sent.filter((s) => s.msg.type === "pose:open-scene").length, 0,
        "坏 JSON 不许下发装载，也不许发 pose:call");
    pick(JSON.stringify(LIB_SCENE));
    await sleep(20);
    await settle();
    const opened = env.sent.filter((s) => s.msg.type === "pose:open-scene");
    assert.equal(opened.length, 1, "本机那一份与数据根的存档走同一条装载路");
    assert.deepEqual(opened[0].msg.scene, LIB_SCENE, "文件里那份场景原样交回页面");
    assert.match(env.toasts.join("|"), /mine\.scene\.json/);
    assert.equal(env.host.querySelector(".ns-libmodal").classList.contains("ns-hidden"), true, "装载完要收窗");
});


test("场景库来源筛选：预设 / 本地角标与来源下拉同一条 origin，分组条数跟着过滤走", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    click(env.button("浏览场景库…", LIB));
    await settle();
    const modal = () => env.host.querySelector(".ns-libmodal:not(.ns-hidden)");
    const cards = () => [...modal().querySelectorAll(".ns-pose-lib-card")];
    const originOf = (card) => card.querySelector(".ns-pose-lib-origin-badge").textContent;
    changeValue(modal().querySelector(".ns-pose-lib-char"), "");   // 基座筛选默认停在当前素体，来源过滤要在「全部基座」那一档看
    assert.deepEqual(cards().map((c) => [c.dataset.libId, originOf(c)]),
        [["a", "预设"], ["calm-1", "本地"], ["fem-1", "预设"], ["sword", "预设"]], "合并库每条的出处要写在卡片上");
    const originSel = modal().querySelector(".ns-pose-lib-origin");
    assert.deepEqual([...originSel.options].map((o) => o.value), ["", "lib", "lab"],
        "来源下拉：全部 / 预设 / 本地三档");
    assert.match(modal().querySelector(".ns-pose-lib-meta").textContent,
        /4 个场景（预设 3 · 本地 1）/, "顶部一行报清预设与本地各几条");
    changeValue(originSel, "lib");
    assert.deepEqual(cards().map((c) => c.dataset.libId), ["a", "fem-1", "sword"], "预设档只列预设条目");
    assert.deepEqual([...modal().querySelector(".ns-pose-lib-group").options].map((o) => o.textContent),
        ["全部分组", "站立（2）", "格斗与武器（1）"], "分组下拉的条数跟着来源过滤走，不拿清单里预设集那份 count");
    changeValue(originSel, "lab");
    assert.deepEqual(cards().map((c) => c.dataset.libId), ["calm-1"]);
    changeValue(originSel, "");
    assert.equal(cards().length, 4, "回到全部来源 = 合并库全量");
});

test("场景库基座筛选：默认落在当前素体上，条目按 charKey 过滤，旧版清单没有这字段时全量可见", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    await settle();
    click(env.button("浏览场景库…", LIB));
    await settle();
    const modal = () => env.host.querySelector(".ns-libmodal:not(.ns-hidden)");
    const cards = () => [...modal().querySelectorAll(".ns-pose-lib-card")];
    const charSel = modal().querySelector(".ns-pose-lib-char");
    assert.equal(charSel.value, "bodyMale", "库默认停在画布当前那具素体（页面开局的标准男基座）：默认显示的就是套得进当前素体的那一批");
    assert.deepEqual([...charSel.options].map((o) => o.textContent),
        ["全部基座", "bodyMale", "少女"],
        "选项来自库条目自带的 charKey 与当前素体：没有分派结果的条目不出选项，meta/list 有这档素体就换它的中文 label");
    assert.equal(cards().length, 0, "库里没有挂在标准男基座上的姿态时基座筛出空集，列表出占位不摆半截卡片");
    changeValue(charSel, "girl");
    assert.deepEqual(cards().map((c) => c.dataset.libId), ["a", "calm-1", "sword"], "基座下拉按条目的 charKey 过滤");
    changeValue(charSel, "");
    assert.equal(cards().length, 4, "全部基座 = 合并库全量：没有 charKey 的条目也在这档可见");
    assert.deepEqual(libFilter(POSE_LIB.entries, { charKey: "girl" }).map((e) => e.id), ["a", "calm-1", "sword"]);
    assert.deepEqual(libFilter([{ id: "old-1", groups: ["stand"] }], { charKey: "bodyMale" }), [],
        "条目没有 charKey 时基座筛不掉它：旧版清单的条目只在「全部基座」那一档可见");
});

test("素体默认标准男基座：随包 CC0 清单到位后下拉落在 bodyMale，加素体与基座筛选都跟着这一档", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META_CC0);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.equal(env.sel(0).value, "bodyMale", "页面开局挂的就是标准男基座，下拉不能停在「选择素体…」");
    click(env.button("加素体"));
    await settle();
    assert.deepEqual(env.calls("member/add")[0].msg.args, { key: "bodyMale" },
        "「加素体」拿到的就是下拉上看得见的那具身");
    changeValue(env.sel(0), "girl");
    await settle();
    assert.deepEqual(env.calls("model/set")[0].msg.args, { key: "girl" }, "素体下拉改档就换当前素体");
    env.from({ type: "pose:state", state: { ...STATE, model: "bodyFemale" } });
    await settle();
    assert.equal(env.sel(0).value, "bodyFemale", "页面自己换了素体：面板下拉跟着对账");
    click(env.button("浏览场景库…", LIB));
    await settle();
    assert.equal(env.host.querySelector(".ns-pose-lib-char").value, "bodyFemale",
        "基座筛选跟着当前素体走：库不会停在套不上的那一档");
});

test("旧姿势包没有标准基座：素体下拉停在「选择素体…」，加素体不写一个清单里没有的 key", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.equal(env.sel(0).value, "", "清单里没有 bodyMale 就不许写一个没有的 key");
    click(env.button("加素体"));
    await settle();
    assert.deepEqual(env.calls("member/add")[0].msg.args, {}, "没有 key 就交回空参数，跟着页面当前素体走");
});

test("云端未配置：来源开关只有本机库那一条，道具下拉里没有云端道具", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.deepEqual([...env.host.querySelectorAll(".ns-pose-prop-card")].map((c) => c.dataset.propKey),
        ["builtin:chair", "glb:arrow.glb", "glb:sting-sword.glb"],
        "没配云端的机器上不许出现一条选了只会失败的道具卡片");
    click(env.button("浏览场景库…", LIB));
    await settle();
    const source = env.host.querySelector(".ns-libmodal:not(.ns-hidden) .ns-pose-lib-source");
    assert.deepEqual([...source.options].map((o) => o.value), ["local"], "只有一台机器就不给开关");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_pose/cloud_index").length, 0,
        "未配置的云端不是一次后台轮询：连清单都不读");
});

test("云端库：切到云端读一次清单，卡片带云端角标与直连预览，点卡片经后端代读套用整场", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, cloud_status: CLOUD_ON });
    await env.ready();
    click(env.button("浏览场景库…", LIB));
    await settle();
    const modal = () => env.host.querySelector(".ns-libmodal:not(.ns-hidden)");
    const source = () => modal().querySelector(".ns-pose-lib-source");
    assert.deepEqual([...source().options].map((o) => o.value), ["local", "cloud"], "配好云端才出第二条来源");
    assert.ok(fetchLog.some((c) => c.path === "/neo_pose/cloud_index"), "配好云端进页读一次清单");
    changeValue(source(), "cloud");
    await settle();
    changeValue(modal().querySelector(".ns-pose-lib-char"), "");   // 基座筛选跟着当前素体，卡片要在全部基座那档全出来
    const cards = [...modal().querySelectorAll(".ns-pose-lib-card")];
    assert.deepEqual(cards.map((c) => c.dataset.libId), ["c1", "c2"], "云端两条 = 两张卡");
    assert.ok(cards[0].querySelector(".ns-pose-lib-origin-cloud"), "云端条目要带「云端」角标");
    assert.equal(cards[0].querySelector(".ns-pose-lib-thumb").getAttribute("src"),
        "https://oss.example/neo/pose/preview/c1.clay.png", "封面只是一张 <img>，直连 OSS 地址不经后端");
    assert.equal(modal().querySelector(".ns-pose-lib-origin").hidden, true, "云端清单没有预设/本地这层，筛选跟着收起");
    assert.match(modal().querySelector(".ns-pose-lib-meta").textContent, /2 个云端场景/);
    click(cards[0]);
    await settle();
    assert.ok(fetchLog.some((c) => c.path === "/neo_pose/cloud_file"
        && c.query.get("path") === "poses/stand/c1.scene.json"), "场景 JSON 走后端代读，不暴露 OSS 地址");
    assert.deepEqual(env.calls("scene/apply")[0].msg.args.file, CLOUD_SCENE,
        "云端那份场景文件原样交回页面，宿主不补字段");
});

test("云端道具：卡片接在本机那批后面带「云端」角标与直连预览，添加道具先把 GLB 落进本机缓存", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, cloud_status: CLOUD_ON });
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    const cards = () => [...env.host.querySelectorAll(".ns-pose-prop-card")];
    assert.deepEqual(cards().map((c) => c.dataset.propKey),
        ["builtin:chair", "glb:arrow.glb", "glb:sting-sword.glb", "glb:stick-cloud.glb"],
        "云端道具接在本机那批后面，key 走页面自己的 glb: 口径");
    const cloud = cards()[3];
    assert.match(cloud.querySelector(".ns-pose-prop-label").textContent, /木棍/,
        "看得见的名字要说清这条来自云端");
    assert.ok(cloud.querySelector(".ns-pose-prop-badge"), "云端卡片要带角标");
    assert.equal(cloud.querySelector(".ns-pose-prop-thumb").getAttribute("src"),
        "https://oss.example/neo/pose/props/preview/stick-cloud.png",
        "预览图与场景库封面同一口径：直连 OSS，不占后端一条代读");
    click(cloud);
    click(env.button("添加道具"));
    await settle();
    assert.ok(fetchLog.some((c) => c.path === "/neo_pose/cloud_file"
        && c.query.get("path") === "models/props/stick-cloud.glb"),
        "云端道具先经后端落进本机缓存，页面才认自己那条写死的 /models/props/ 路径");
    assert.deepEqual(env.calls("prop/add")[0].msg.args, { key: "glb:stick-cloud.glb" });
});

test("云端清单读不到：切过去给云端指引，不渲染一个空浏览器", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, cloud_status: { ...CLOUD_ON, available: false, scenes: 0, props: 0 },
        cloud_index: { success: false, error: "云端索引取不到：404 no such key" } });
    await env.ready();
    click(env.button("浏览场景库…", LIB));
    await settle();
    const modal = () => env.host.querySelector(".ns-libmodal:not(.ns-hidden)");
    changeValue(modal().querySelector(".ns-pose-lib-source"), "cloud");
    await settle();
    assert.equal(modal().querySelectorAll(".ns-pose-lib-card").length, 0);
    assert.match(modal().querySelector(".ns-pose-lib-blank").textContent, /pose_deploy_oss/,
        "空态要说的是怎么把云端配起来，不是「没有匹配」");
    assert.match(env.toasts.join("|"), /云端索引取不到/);
});


