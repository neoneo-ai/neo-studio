// 3D 姿势宿主：iframe 承载、桥的门禁与收发、面板动作往返（pose:call / pose:state），
// 以及桥接结果落到的那几个 /neo_pose 接口。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, click, changeValue, inputText, keydown, flush, sleep, clearBody, window } from "./setup.mjs";
import { $el } from "../../web/studio/shim/ui.js";

// pose.js 现在经 lib-modal.js 拉 scripts/ui.js 的 shim：静态导入会在 setup.mjs 装好钩子之前就解完
// 整张模块图，所以按 lib-modal-geometry.test.mjs 那条路动态取
const { createPoseView, resolvePropChoice, POSE_PAGE_URL, previewOf, libFilter, libGroups, libTagsOf } =
    await import("../../web/pose/pose.js");

const api = { fetchApi: (path, opts) => fetch(path, opts) };
/* 控件在浮于画布的弹层里（弹层按 data-pop 认），「姿势库」与「道具」两颗钮开的是整屏那几扇弹窗
   （.ns-pose-libpane / .ns-pose-proppane）。PANEL 写成一条选择器而不是逗号列表 —— 测试里
   PANEL + " .ns-pose-btn" 这种后代拼接要对每一扇都生效。弹层建序是 角色 → 保存 → 导出 → 状态，
   下拉与输入框在那份合集里的下标就是这一份顺序 */
const LIB = '.ns-pose-libpane';
const PROP = '.ns-pose-proppane';
const PANEL = '[data-pop]';
const STATE_POP = '[data-pop="state"]';
const PROP_PAGE_KEY = "neo_studio_pose_prop_page";
const dockBtn = (env, label) => [...env.host.querySelectorAll(".ns-pose-dock-btn")]
    .find((b) => b.textContent.includes(label));
const openPop = (env, label) => click(dockBtn(env, label));
const openPops = (env) => [...env.host.querySelectorAll(".ns-pose-pop")].filter((p) => !p.hidden);
/** 「道具」那颗钮直接开整扇道具弹窗：一页卡片 + 页码条，和姿势库同一套弹窗外壳 */
const openProp = async (env) => { click(dockBtn(env, "道具")); await settle(); };

/** 一次面板动作要跨两次 fetch 与一次桥回复：微任务与定时器各放一遍才到终点 */
const settle = async () => { await flush(); await sleep(0); await flush(); };

/** meta/list 的 fixture：面板每个下拉与勾选组都从这一份清单渲染。
    素体是页面那份全表（Mixamo / SMPL / 用户自备的都在），面板只发标准男 / 标准女两具 CC0 基座；
    预设带 group（姿势页 src/pose/presets.js 那份分组名），视角带页面自己的 current 那一档 */
const META = {
    models: [{ key: "bodyMale", label: "标准男素体" }, { key: "bodyFemale", label: "标准女素体" },
             { key: "girl", label: "少女" }],
    presets: [{ key: "run", label: "奔跑", group: "运动" }, { key: "sit", label: "坐下", group: "坐姿" }],
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
    views: [{ key: "front", label: "正面" }, { key: "side", label: "侧面" }, { key: "current", label: "当前视角" }],
    sizes: [256, 512, 1024, 2048],
    bones: ["hips", "head"],
    // 外观两档来自姿势页 core/scene.js 的 LOOKS：studio 是页面开局的摄影棚灰，dark 是暗色
    looks: [{ key: "studio", label: "摄影棚" }, { key: "dark", label: "暗色" }],
    maxExportSize: 1024,
};
/** 旧姿势包的素体表：随包 CC0 那两具基座还没注册，面板就不许默认写一个清单里没有的 key */
const META_NO_STANDARD = { ...META, models: [{ key: "girl", label: "少女" }] };
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
          people: 1, props: 0, groups: ["stand"], charKey: "bodyMale",
          categories: ["站立", "standing-poses"], tags: ["preset"], source: "preset", origin: "lib",
          preview: { skeleton: "preview/a.skeleton.png", silhouette: "preview/a.silhouette.png" } },
        { id: "calm-1", label: "双臂伸展 1", path: "poses/calm/calm-1.scene.json", kind: "scene",
          people: 2, props: 0, groups: ["calm", "stand"], charKey: "bodyMale",
          categories: ["手臂绘图参考", "arm-drawing-reference"], source: "photo3d", origin: "lab",
          preview: { clay: "preview/calm-1.clay.png", skeleton: "preview/calm-1.skeleton.png" } },
        { id: "sword", label: "双手持剑", path: "poses/fight/sword.scene.json", kind: "scene",
          people: 2, props: 1, groups: ["fight"], categories: ["格斗", "sword"], source: "preset", origin: "lib",
          charKey: "bodyMale", preview: {} },
        { id: "fem-1", label: "侧坐扶手", path: "poses/stand/fem-1.scene.json", kind: "scene",
          people: 1, props: 1, groups: ["stand"], charKey: "bodyFemale",
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
          people: 1, props: 0, groups: ["stand"], charKey: "bodyMale", origin: "cloud", cloud: true,
          categories: ["站立"], preview: { clay: "preview/c1.clay.png" } },
        { id: "c2", label: "云端坐姿", path: "poses/stand/c2.scene.json", kind: "scene",
          people: 1, props: 0, groups: ["stand"], charKey: "bodyMale", origin: "cloud", cloud: true,
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
    // 姿势库的两条静态读：索引清单不带 success 外壳，库里的一份条目就是一整场场景文件原样
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
        panelField: (i = 0) => [...host.querySelectorAll(PANEL + " .ns-pose-name")][i],
        propField: (i = 0) => [...host.querySelectorAll(PROP + " .ns-pose-name")][i],
        item: (name, scope) => [...host.querySelectorAll(scope + " .ns-pose-item")].find((r) => r.textContent === name),
        /** 姿势库弹窗里本机存档那一列的行：行末贴了出处角标，按行里的名字那一段找 */
        libRow: (label, scope = LIB) => [...host.querySelectorAll(scope + " .ns-pose-item-label")]
            .find((s) => s.textContent === label)?.closest(".ns-pose-item"),
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

test("缺包：不出 iframe，两条透明工具条整条收起并给出装包提示", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, installed: false, hint: "跑 tools\\sync_pose_dist.ps1" });
    assert.equal(env.host.querySelector(".ns-pose-frame"), null, "没有包就不能挂 iframe");
    assert.match(env.host.querySelector(".ns-pose-empty").textContent, /sync_pose_dist/);
    assert.equal(env.host.querySelector(".ns-pose-dock-left").hidden, true, "没有包就不出弹层入口");
    assert.equal(env.host.querySelector(".ns-pose-dock-right").hidden, true, "没有包就不出导出与状态");
    assert.equal(env.host.querySelectorAll(".ns-pose-pop").length, 4, "弹层外壳在位，只是全关着");
    assert.equal(openPops(env).length, 0, "没有包就不许开出一扇只会失败的弹层");
});

test("装好包：iframe 指短路径并带沙箱，pose:ready 之前控件全禁用", async () => {
    resetEnv();
    const env = await mounted();
    const frame = env.host.querySelector(".ns-pose-frame");
    assert.equal(frame.getAttribute("src"), POSE_PAGE_URL);
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-downloads");
    assert.equal(env.host.querySelector(".ns-pose-bar"), null, "顶栏那条「3D 姿势」行整条不出");
    // 弹层入口都是布局，不在门禁里：页面没 ready 时也要看得见画布与清单
    const gated = () => [...env.host.querySelectorAll(
        ".ns-pose-pop .ns-pose-btn, .ns-pose-sel, .ns-pose-checkrow input")]
        .filter((n) => !n.classList.contains("ns-pose-pop-close"));
    assert.ok(gated().length >= 14, "弹层里的控件要在位");
    assert.ok(gated().every((n) => n.disabled), "页面没 ready 时控件不能点");
    assert.equal(env.host.querySelectorAll(".ns-pose-dock-btn").length, 6,
        "六条入口：左 姿势库 / 角色与外观 / 道具，右 保存姿势 / 导出图组 / 画布状态");
    assert.ok([...env.host.querySelectorAll(".ns-pose-dock-btn")].every((b) => !b.disabled),
        "工具条入口是布局入口，不吃 ready 门禁");
    assert.ok(openPops(env).length === 0, "开局一扇弹层都不开：这一页要的是画布");
    await env.ready();
    const theme = env.sent.find((s) => s.msg.type === "pose:theme");
    assert.equal(theme.msg.caps.hostUi, true, "宿主面板能力位要随主题下发");
    assert.equal(theme.msg.caps.photo3d, false, "要 sidecar 的能力位一并下发");
});

test("桥只认本页 iframe 的同源消息", async () => {
    resetEnv();
    const env = await mounted();
    // 弹层头的关钮不吃门禁，取一条真控件来验门禁
    const panelCtl = () => env.host.querySelector(PANEL + " .ns-pose-sel");
    env.from({ type: "pose:ready" }, { postMessage() {} });   // 别的来源冒充页面
    assert.ok(panelCtl().disabled, "来源不是这张 iframe 就不认");
    env.from({ type: "pose:ready" }, env.cw, "http://evil.local");   // 来源对、origin 不对
    assert.ok(panelCtl().disabled, "非同源的 ready 不解锁控件");
});

test("旧姿势包（caps.hostUi 关）：弹层控件禁用并说明缺什么，姿势读写照旧", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, caps: { ...STATUS.caps, hostUi: false } });
    await env.ready();
    assert.equal(env.host.querySelector(STATE_POP + " .ns-pose-notice").hidden, false, "旧包要出提示");
    assert.match(env.host.querySelector(STATE_POP + " .ns-pose-notice").textContent, /sync_pose_dist/);
    const disabled = (label) => env.button(label)?.disabled;
    assert.equal(disabled("加素体"), true, "页面动作在缺命令层时整片禁用");
    assert.equal(disabled("导出图组到素材库"), true, "没有命令层就不出点了只会空转的控件");
    assert.equal(disabled("画布截图"), true);
    assert.equal(disabled("存为姿势"), false,
        "保存姿势写的是宿主那条 /neo_pose/scene：没有命令层也能存本机一份");
    assert.ok(dockBtn(env, "姿势库") && dockBtn(env, "道具"),
        "读本机文件的两扇弹窗不吃 hostUi：缺命令层时清单与卡片照常浏览");
    assert.ok([...env.host.querySelectorAll(".ns-pose-dock-btn")].every((b) => !b.disabled),
        "弹层入口是布局入口，不是页面动作：控件整片禁用时弹层也开得了、关得回去");
    assert.equal(env.calls().length, 0, "旧包不许发 pose:call");
    await openLib(env);
    await settle();
    click(env.libRow("hero", LIB));
    await settle();
    assert.equal(env.sent.find((s) => s.msg.type === "pose:open-scene").msg.scene.camYaw, 42,
        "读写数据根文件的通道不受 hostUi 影响");
});

test("弹层：画布吃满整页，工具条的钮开一扇浮在画布上的弹层，一次只留一扇", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    assert.equal(env.host.querySelector(".ns-pose-body"), null, "没有三栏那条 grid：画布吃满整页");
    assert.ok(openPops(env).length === 0, "开局一扇弹层都不开");
    openPop(env, "角色与外观");
    assert.deepEqual(openPops(env).map((p) => p.dataset.pop), ["char"], "点一条钮只开对应那一扇");
    assert.equal(dockBtn(env, "角色与外观").getAttribute("aria-expanded"), "true", "开着的那一条要标出来");
    openPop(env, "保存姿势");
    assert.deepEqual(openPops(env).map((p) => p.dataset.pop), ["save"], "一次只留一扇：画布上不许叠两层控件");
    assert.equal(dockBtn(env, "角色与外观").getAttribute("aria-expanded"), "false", "换到另一扇时前一条回到没开的样子");
    assert.equal(dockBtn(env, "角色与外观").classList.contains("ns-pose-dock-btn-on"), false, "关掉的钮不再亮着");
    click(env.host.querySelector('[data-pop="save"] .ns-pose-pop-close'));
    assert.ok(openPops(env).length === 0, "弹层头那颗 ✕ 就是关：弹层不钉在画布上");
});

test("「道具」那颗钮直接开整扇道具弹窗：卡片、页码条与场上清单都在同一扇窗里", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.ok(!env.button("道具"), "工具条上不再给「道具」留一扇小弹层");
    await openProp(env);
    assert.ok(env.host.querySelector(".ns-libmodal:not(.ns-hidden) " + PROP), "点一下就是弹窗开着");
    assert.deepEqual(openPops(env).map((p) => p.dataset.pop), [], "道具不走那条小弹层：它和姿势库一样是一扇整屏窗");
    assert.ok(env.host.querySelector(PROP + " .ns-pose-prop-card"), "一页卡片在窗里");
    assert.ok(env.host.querySelector(PROP + " .ns-pose-prop-pager"), "页码条在卡片下方");
    assert.ok(env.host.querySelector(PROP + " .ns-pose-prop-added .ns-pose-list"),
        "场上道具清单在同一扇窗底部：加完就看得见落地了哪几件");
});

test("姿势库与道具那两扇弹窗：同一颗钮再点一次就是关，钮的亮起态跟着每一条收窗路走", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    const win = () => env.host.querySelector(".ns-libmodal:not(.ns-hidden)");
    const lit = (label) => dockBtn(env, label).classList.contains("ns-pose-dock-btn-on");
    await openLib(env);
    assert.ok(win(), "第一下开窗");
    assert.ok(lit("姿势库"), "开着的那颗钮亮着：第二下是关这件事要在钮上看得见");
    assert.equal(dockBtn(env, "姿势库").getAttribute("aria-expanded"), "true");
    await openLib(env);
    assert.equal(win(), null, "同一颗「姿势库」再点一次就是关：整屏弹窗不只 Esc / 遮罩 / ✕ 那三条关法");
    assert.ok(!lit("姿势库"), "关掉的钮回到没开的样子");
    assert.equal(dockBtn(env, "姿势库").getAttribute("aria-expanded"), "false");
    await openProp(env);
    assert.ok(env.host.querySelector(".ns-libmodal:not(.ns-hidden) " + PROP), "「道具」开自己那扇窗");
    await openProp(env);
    assert.equal(win(), null, "同一颗「道具」再点一次就是关");
    assert.ok(!lit("道具"), "道具那颗钮同样收回");
    await openLib(env);
    await openProp(env);
    assert.ok(env.host.querySelector(".ns-libmodal:not(.ns-hidden) " + PROP), "两扇弹窗不叠：姿势库让位给道具");
    assert.ok(!lit("姿势库"), "让位收掉的那扇窗，钮一起收回没开的样子");
    keydown(document.body, "Escape");
    await settle();
    assert.equal(win(), null, "Esc 照旧关窗");
    assert.ok(!lit("道具"), "Esc 那条路关的窗同样把钮收回：四条收窗路共用同一份回调");
});

test("弹层的关法：Esc、点在弹层之外、再点同一条钮都关，且 Esc 让位给姿势库那扇弹窗", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    openPop(env, "角色与外观");
    keydown(document.body, "Escape");
    assert.ok(openPops(env).length === 0, "Esc 关弹层：界面不留在画布上挡视线");
    openPop(env, "角色与外观");
    click(env.host.querySelector(".ns-pose-stage"));
    assert.ok(openPops(env).length === 0, "点在弹层与工具条之外就关");
    openPop(env, "角色与外观");
    click(env.host.querySelector(".ns-pose-dock-left"));
    assert.equal(dockBtn(env, "角色与外观").getAttribute("aria-expanded"), "true", "点在工具条本身上不收：那条就是控件本体");
    openPop(env, "角色与外观");
    assert.ok(openPops(env).length === 0, "同一条钮再点一次就是关：不多给一颗「关」");
    // 弹窗开着时那一发 Esc 归弹窗自己（它监听 document），弹层不许抢着关
    openPop(env, "角色与外观");
    await openLib(env);

    assert.ok(env.host.querySelector(".ns-libmodal:not(.ns-hidden)"), "姿势库弹窗开着");
    keydown(document.body, "Escape");
    await settle();
    assert.ok(env.host.querySelector(".ns-libmodal.ns-hidden"), "Esc 关的是姿势库弹窗");
    assert.deepEqual(openPops(env).map((p) => p.dataset.pop), ["char"], "弹层不抢着关：那一发归弹窗");
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
    assert.match(env.host.querySelector(PROP + " .ns-pose-item").textContent, /椅子 · 未挂载/);
    env.replyCall(env.calls("meta/list")[0], META);
    await settle();
    assert.deepEqual([...env.sel(0).options].map((o) => o.value), ["", "bodyMale", "bodyFemale"],
        "素体下拉只发标准男 / 标准女：页面注册表里的其余那几档（Mixamo / SMPL / 自备）不进面板");
    assert.deepEqual([...env.sel(2).options].map((o) => o.value), ["", "front", "side", "current"], "视角下拉来自 meta");
    assert.deepEqual([...env.sel(3).options].map((o) => o.value), ["", "256", "512", "1024", "2048"]);
    assert.equal(env.host.querySelectorAll(PANEL + " .ns-pose-format input").length, 2, "格式勾选组来自 meta");
});

test("道具卡片：一张卡一个 propKey 与一张预览图，点一张卡就是加一件", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    await openProp(env);
    const cards = () => [...env.host.querySelectorAll(PROP + " .ns-pose-prop-card")];
    assert.deepEqual(cards().map((c) => c.dataset.propKey),
        ["builtin:chair", "glb:arrow.glb", "glb:sting-sword.glb"],
        "卡片顺序就是 meta/list 那份清单：卡片带的是页面的 propKey，label 只当显示名");
    assert.ok(!env.button("添加道具", PROP), "不给「添加道具」这颗按钮：点卡片本身就是添加");
    assert.equal(cards()[1].querySelector(".ns-pose-prop-thumb").getAttribute("src"),
        "/models/props/preview/arrow.png",
        "预览图走页面写死的那一级 /models/props/，注册表 preview 原样拼地址");
    assert.equal(cards()[0].querySelector(".ns-pose-prop-thumb").getAttribute("src"),
        "/models/props/preview/builtin-chair.png",
        "内置道具没有注册表行：按 preview/builtin-<id>.png 这条约定名取图");
    assert.match(env.host.querySelector(".ns-pose-prop-meta").textContent, /3 件道具 · 第 1\/1 页/);
    click(cards()[2]);
    await settle();
    assert.deepEqual(env.calls("prop/add")[0].msg.args, { key: "glb:sting-sword.glb" },
        "点一次就是一次 prop/add：页面 addProp 收的是带前缀的 propKey，卡片上看见的是中文 label");
});

test("道具搜索：过滤只动卡片与页码条，回车把命中那一件加进画布", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    await openProp(env);
    const cards = () => [...env.host.querySelectorAll(PROP + " .ns-pose-prop-card")];
    assert.equal(cards().length, 3, "三件道具一页装得下，卡片一次全出");
    inputText(env.host.querySelector(".ns-pose-prop-search"), "剑");
    await settle();
    assert.deepEqual(cards().map((c) => c.dataset.propKey), ["glb:sting-sword.glb"],
        "搜索一次就只剩命中的那一张");
    assert.match(env.host.querySelector(".ns-pose-prop-meta").textContent, /3 件道具 · 第 1\/1 页/,
        "数量行报整张表的件数与页码：筛选只改卡片那一片");
    keydown(env.host.querySelector(".ns-pose-prop-search"), "Enter");
    await settle();
    assert.deepEqual(env.calls("prop/add").map((c) => c.msg.args), [{ key: "glb:sting-sword.glb" }],
        "搜索框回车就是添加命中那一件：挑图与键入是同一个落点");
    // 道具名框写名字 + 回车 = 同一条一键添加（自由名字仍走清单解析）
    inputText(env.propField(0), "桌子");
    keydown(env.propField(0), "Enter");
    await settle();
    assert.equal(env.calls("prop/add").length, 1,
        "清单里没有「桌子」：解析不到就不发请求，同点卡片那一条路");
    assert.match(env.toasts.join(" "), /道具表里没有「桌子」/);
});

test("道具翻页：一页 120 件，页码落盘、重开停在同一页", async () => {
    resetEnv();
    localStorage.removeItem(PROP_PAGE_KEY);
    // 300 件照页面注册表那种形状造：一页 120，翻到第三页剩 60
    const many = Array.from({ length: 300 }, (_, i) => ({ propKey: `glb:p${i}.glb`, label: `道具${i}` }));
    const meta = { ...META, props: many };
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], meta);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    await openProp(env);
    const cards = () => [...env.host.querySelectorAll(PROP + " .ns-pose-prop-card")];
    const pager = () => env.host.querySelector(PROP + " .ns-pose-prop-pager");
    assert.equal(cards().length, 120, "一页 120 件：整张表在弹窗里翻，画布不被一条长清单顶开");
    assert.equal(pager().hidden, false, "三页就要有页码条");
    assert.equal(pager().querySelector('[aria-current="page"]').textContent, "1", "开局第一页");
    click(pager().querySelector('[data-page="1"]'));
    await settle();
    assert.equal(cards()[0].dataset.propKey, "glb:p120.glb", "第二页从第 121 件起");
    assert.equal(localStorage.getItem(PROP_PAGE_KEY), "1", "页码是布局偏好：翻到哪页就记哪页");
    const again = await mounted();
    await again.ready();
    again.replyCall(again.calls("meta/list")[0], meta);
    again.replyCall(again.calls("prop/list")[0], PROPS);
    await settle();
    await openProp(again);
    assert.equal(again.host.querySelector(PROP + ' .ns-pose-prop-pager [aria-current="page"]').textContent, "2",
        "重开停在同一页：不把用户翻到一半的清单打回第一页");
    click(again.host.querySelector(PROP + ' .ns-pose-prop-pager [data-page="2"]'));
    await settle();
    const tail = [...again.host.querySelectorAll(PROP + " .ns-pose-prop-card")];
    assert.equal(tail.length, 60, "最后一页只剩那 60 件，不拿空卡片补位");
    assert.equal(again.host.querySelector(PROP + " .ns-pose-prop-pager .ns-pose-prop-jump:last-child").disabled, true,
        "末页的「下一页」按不动：按钮自己说清到头了");
});

test("道具弹窗没有挂骨点：没有「挂到骨点」按钮、没有骨点下拉，加具不发 prop/attach", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    await openProp(env);
    assert.ok(!env.button("挂到骨点", PROP), "挂骨点是姿势页物体面板的事，Neo Studio 的道具只落地");
    assert.ok(env.host.querySelector(PROP + " .ns-pose-prop-search"), "道具弹窗改的是带搜索框的卡片列表");
    const panelSelects = [...env.host.querySelectorAll(PANEL + " select")].map((s) => s.title);
    assert.ok(!panelSelects.includes("挂点骨"), "面板不再有骨点下拉：" + panelSelects.join("/"));
    click([...env.host.querySelectorAll(PROP + " .ns-pose-prop-card")][0]);
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
    await openProp(env);
    const addByName = async (name) => {
        inputText(env.propField(0), name);
        keydown(env.propField(0), "Enter");
        await settle();
    };
    await addByName("椅子");
    assert.deepEqual(env.calls("prop/add")[0].msg.args, { key: "builtin:chair" },
        "面板上看见中文 label，页面 addProp 要的是带前缀的 propKey");
    assert.equal(env.propField(0).value, "", "名字框是一次性的：写完就清，下一发不覆盖上一发");
    await addByName("细剑");
    assert.deepEqual(env.calls("prop/add")[1].msg.args, { key: "glb:sting-sword.glb" },
        "label 的全角括号后缀（细剑（Sting））按括号前的名字认");
    await addByName("沙发");
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
    assert.equal(env.sel(1).value, "dark", "外观下拉要显示当前档位，用户看得见切到了哪一档");
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

/* 工具条上「姿势库」那颗钮直接开整屏那扇姿势库弹窗（外壳是 js/core/lib-modal.js），
   弹窗里上半是库的卡片网格、下半是本机存档那一列 */
const openLib = async (env) => { click(dockBtn(env, "姿势库")); await settle(); };

test("「姿势库」那颗钮直接开弹窗：本机存档在弹窗下半，预设卡片在上半，点存档就是一次 pose:open-scene", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    assert.ok(!env.button("载入姿势"), "载入姿势那颗钮没了：弹窗里点一行就是装载");
    assert.ok(!env.button("浏览姿势库…"), "工具条上不再嵌一颗「浏览姿势库…」，姿势库就是工具条本身");
    assert.ok(!env.button("存为姿态") && !env.button("载入姿态") && !env.button("删姿态"),
        "弹窗不写 pose/presets 那批姿态文件，控件就不出");
    await openLib(env);
    assert.ok(env.host.querySelector(".ns-libmodal:not(.ns-hidden)"), "点一下就是弹窗开着");
    const pane = env.host.querySelector(LIB);
    const localBox = pane.querySelector(".ns-pose-lib-local");
    assert.ok(localBox, "弹窗下半那一列本机存档");
    assert.ok(localBox.querySelector(".ns-pose-pose-list"), "本机存档那一列");
    const search = localBox.querySelector(".ns-pose-list-search");
    const list = localBox.querySelector(".ns-pose-pose-list");
    assert.equal(search.parentNode, localBox, "搜索框是这一列的一行，不嵌进列表里");
    assert.equal(search.parentNode, list.parentNode,
        "列表在这一列里吃剩下的高度：搜索框与它同列兄弟，嵌进列表会跟着列表一起被拉高");
    assert.ok(!search.classList.contains("ns-pose-lib-search"),
        "这一列不共用弹窗搜索框那条 flex: 1：那一条是弹窗顶部横行的样式，在竖着排的列里就是把输入框拉成整块");
    assert.ok(pane.querySelector(".ns-pose-lib-search"), "弹窗上半的搜索框在弹窗自己的那一横行里");
    const rows = () => [...localBox.querySelectorAll(".ns-pose-item")];
    assert.deepEqual(rows().map((r) => r.textContent), ["hero本地"],
        "下半只列本机存档：预设不在这一份列表里重复一遍");

    click(env.libRow("hero", LIB));
    await settle();
    const opened = env.sent.filter((s) => s.msg.type === "pose:open-scene");
    assert.equal(opened.length, 1, "点一条存档 = 一次装载，不另发第二条消息");
    assert.equal(opened[0].msg.scene.camYaw, 42, "读回来的那份场景原样交回页面，宿主不改一个字段");
});

test("预设只从弹窗上半那一条路进：卡片按 groups 分层，下半不排预设清单", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.ok(!env.button("套用预设", PANEL), "弹层不出「套用预设」这颗按钮");
    assert.ok(![...env.host.querySelectorAll(PANEL + " .ns-pose-sel")]
        .some((s) => [...s.options].some((o) => o.value === "run")), "弹层不摆预设下拉");
    await openLib(env);
    const rows = () => [...env.host.querySelectorAll(LIB + " .ns-pose-lib-local .ns-pose-item")];
    assert.equal(rows().some((r) => r.textContent.includes("预设")), false,
        "meta/list 回报的预设不进下半那份列表 —— 姿势库里有的东西不在这里再排一遍");
    assert.equal(rows().filter((r) => !r.querySelector(".ns-pose-row-origin")).length, 0,
        "下半的行只带「本地」角标，没有「预设」行");
    assert.deepEqual([...env.host.querySelectorAll(".ns-pose-lib-group-title")].map((h) => h.textContent),
        ["站立（2）", "格斗与武器（1）"],
        "预设按 index.json 的 groups 在弹窗上半分层；基座筛选停在标准男，挂少女基座的那条不在这屏");
    assert.equal(env.host.querySelectorAll(".ns-pose-lib-card").length, 3, "弹窗里只渲染套得上当前基座的三条卡片");
});

/** 弹窗下半那一列本机存档的搜索框（只吃本机存档的名字，placeholder 在 i18n 里是独立那条） */
const libPanelSearch = (env) => env.host.querySelector(LIB + " .ns-pose-list-search");

test("本机存档那一列按名字过滤：命中就剩那几行，搜不到说清，不给一个空列表", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS,
        scenes: [{ name: "甲姿势", size: 1, mtime: 1 }, { name: "乙姿势", size: 1, mtime: 2 },
                 { name: "standing 10", size: 1, mtime: 3 }] });
    await env.ready();
    await openLib(env);
    const rows = () => [...env.host.querySelectorAll(LIB + " .ns-pose-lib-local .ns-pose-item-label")].map((s) => s.textContent);
    inputText(libPanelSearch(env), "姿势");
    assert.deepEqual(rows(), ["乙姿势", "甲姿势"], "按名字过滤，命中的那两行留下");
    inputText(libPanelSearch(env), "standing");
    assert.deepEqual(rows(), ["standing 10"], "英文名也吃");
    inputText(libPanelSearch(env), "zzz");
    assert.deepEqual(rows(), ["没有匹配的姿势"], "搜不到时列表里就一句实话，不空着");
});

test("本机存档那一列分页：一屏 120 行，「加载更多」把剩下的补齐", async () => {
    resetEnv();
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `姿势 ${i}`, size: 1, mtime: i + 1 }));
    const env = await mounted({ ...STATUS, scenes: many });
    await env.ready();
    await openLib(env);
    const list = env.host.querySelector(LIB + " .ns-pose-pose-list");
    const more = env.host.querySelector(".ns-pose-list-more");
    assert.equal(list.querySelectorAll(".ns-pose-item").length, 120, "一屏只渲染 120 行（300 条存档全塞进 DOM 撑不住）");
    assert.match(more.textContent, /还有 180 条/, "「加载更多」报清还剩几条");
    click(more);
    await settle();
    assert.equal(list.querySelectorAll(".ns-pose-item").length, 240, "一颗钮先补下一屏，不一次吞掉全部");
    click(more);
    await settle();
    assert.equal(list.querySelectorAll(".ns-pose-item").length, 300, "再点一次把剩下的补齐");
    assert.equal(more.hidden, true, "补齐之后这颗钮收起");
});

test("ControlNet 图组：视角默认当前视角，页面交回 files，宿主 POST 进 /neo_pose/export_set", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], { items: [], options: [], bones: [] });
    await settle();
    openPop(env, "导出图组");
    assert.equal(env.sel(2).value, "current",
        "视角默认落在当前视角：面板不动用户调好的机位就能出图（页面 view=current 沿用现场相机）");
    changeValue(env.sel(2), "side");
    changeValue(env.sel(3), "512");
    inputText(env.panelField(1), "hero");   // 弹层里的输入框依次是 姿势名（保存）、导出标签（导出）
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
    openPop(env, "导出图组");
    click(env.button("画布截图"));
    await settle();
    env.replyCall(env.calls("snapshot")[0], { data: "data:image/png;base64,AAE=" });
    await settle();
    const post = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_pose/export_image");
    assert.match(post.body.data, /^data:image\/png/);
    assert.match(env.toasts.join("|"), /pose_shot_1\.png/, "提示报的是落进素材库的那个文件名");
});

test("保存姿势：页面回序列化结果，宿主按弹层里写的名字写盘并清名字", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    openPop(env, "保存姿势");
    inputText(env.panelField(0), "hero scene");
    click(env.button("存为姿势"));
    await settle();
    env.reply("pose:save-scene", { scene: { camYaw: 42 } });
    await settle();
    const post = fetchLog.find((c) => c.method === "POST" && c.path === "/neo_pose/scene");
    assert.deepEqual(post.body, { name: "hero scene", scene: { camYaw: 42 } });
    assert.equal(env.panelField(0).value, "", "名字是一次性的：写完就清，下一发不覆盖上一发");
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

test("素体只发标准男 / 标准女：其余那几档不进下拉，面板也没有「导入自备素体」那一行", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    const bodies = [...env.sel(0).options].filter((o) => o.value);
    assert.deepEqual(bodies.map((o) => o.value), ["bodyMale", "bodyFemale"],
        "面板只发随包 CC0 那两具基座：页面注册表里的 Mixamo / SMPL / 自备那几档不出选项");
    assert.deepEqual(bodies.map((o) => o.textContent), ["标准男素体", "标准女素体"],
        "label 用页面 meta/list 那份，面板不复刻定义");
    assert.ok(!env.button("导入自备素体"), "自备 GLB 归姿势页自己那侧的本地导入区，面板不摆这条入口");
    assert.ok(!env.host.querySelector(PANEL + " .ns-pose-file"), "面板里没有自备素体的 .glb 文件选择器");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_pose/import_model").length, 0,
        "这条接口随「导入自备素体」一起删了，面板不许再打它");
});

test("旧姿势包的默认素体：随包 CC0 清单到位后下拉落在 bodyMale，加素体与基座筛选都跟着这一档", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.equal(env.sel(0).value, "bodyMale", "页面开局挂的就是标准男基座，下拉不能停在「选择素体…」");
    click(env.button("加素体"));
    await settle();
    assert.deepEqual(env.calls("member/add")[0].msg.args, { key: "bodyMale" },
        "「加素体」拿到的就是下拉上看得见的那具身");
    await openLib(env);

    assert.equal(env.host.querySelector(".ns-pose-lib-char").value, "bodyMale",
        "基座筛选跟着当前素体走：库不会停在套不上的那一档");
    env.from({ type: "pose:state", state: { ...STATE, model: "bodyFemale" } });
    await settle();
    assert.equal(env.sel(0).value, "bodyFemale", "页面自己换了素体：面板下拉跟着对账");
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
    assert.deepEqual(libFilter(POSE_LIB.entries, { charKey: "bodyMale" }).map((e) => e.id), ["a", "calm-1", "sword"],
        "基座筛选只放过挂在当前基座上的条目");
    assert.deepEqual(libFilter(POSE_LIB.entries, { charKey: "girl" }).map((e) => e.id), [],
        "库条目挂的基座就是面板发得出的那两具：Mixamo / SMPL / 自备那一档在库里筛不到条目");
    assert.deepEqual(libGroups(POSE_LIB.entries, POSE_LIB.groups).map((s) => s.count), [3, 1],
        "分组条数从过滤后的分层数出来，来源一筛下拉就跟着变");
    assert.deepEqual(libGroups(POSE_LIB.entries, POSE_LIB.groups).map((s) => [s.key, s.items.length]),
        [["stand", 3], ["fight", 1]], "多组条目只落排最前的那个组，同 id 不许出现两张卡");
    assert.equal(libTagsOf(POSE_LIB.entries[1]), "2人 · 0道具 · 手臂绘图参考 / arm-drawing-reference · photo3d");
    assert.equal(libTagsOf(POSE_LIB.entries[0]), "1人 · 0道具 · 站立 / standing-poses", "preset 来源不上来源那一档");
});

test("姿势库弹窗：卡片按预览优先级出缩略图与人数，点卡片读库文件走一次 scene/apply 并收窗", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    await openLib(env);

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

test("姿势库弹窗：页面报整场没套上时说清原因，不收窗也不报成功", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    await openLib(env);

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

test("姿势库弹窗：搜索与分组下拉同一条过滤口径，卡片区按归并组分层", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    await openLib(env);

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

test("姿势库未同步：出同步指引，不给一个空浏览器", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, lib: null });
    await env.ready();
    await openLib(env);

    const blank = env.host.querySelector(".ns-pose-lib-blank");
    assert.equal(blank.hidden, false);
    assert.match(blank.textContent, /sync_pose_lib/);
    assert.equal(env.host.querySelectorAll(".ns-pose-lib-card").length, 0, "库没同步就不该渲染卡片");
    assert.match(env.toasts.join("|"), /pose-lib\/index\.json/);
});

test("本机姿势文件：读成场景装进页面并收窗，坏 JSON 挡在发请求之前", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, lib: null });   // 库没同步也要能从本机挑一份
    await env.ready();
    await openLib(env);

    const input = [...env.host.querySelectorAll(".ns-pose-file")].find((i) => i.accept === ".json");
    assert.ok(input, "弹窗里的本机姿势文件选择器要在界面上（CSS 里藏着，借浏览器那套选择框）");
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


test("姿势库来源筛选：预设 / 本地角标与来源下拉同一条 origin，分组条数跟着过滤走", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    await openLib(env);

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
        /4 个姿势（预设 3 · 本地 1）/, "顶部一行报清预设与本地各几条");
    changeValue(originSel, "lib");
    assert.deepEqual(cards().map((c) => c.dataset.libId), ["a", "fem-1", "sword"], "预设档只列预设条目");
    assert.deepEqual([...modal().querySelector(".ns-pose-lib-group").options].map((o) => o.textContent),
        ["全部分组", "站立（2）", "格斗与武器（1）"], "分组下拉的条数跟着来源过滤走，不拿清单里预设集那份 count");
    changeValue(originSel, "lab");
    assert.deepEqual(cards().map((c) => c.dataset.libId), ["calm-1"]);
    changeValue(originSel, "");
    assert.equal(cards().length, 4, "回到全部来源 = 合并库全量");
});

test("姿势库基座筛选：默认落在标准男基座上，条目按 charKey 过滤，旧版清单没有这字段时全量可见", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META);
    await settle();
    await openLib(env);

    const modal = () => env.host.querySelector(".ns-libmodal:not(.ns-hidden)");
    const cards = () => [...modal().querySelectorAll(".ns-pose-lib-card")];
    const charSel = modal().querySelector(".ns-pose-lib-char");
    assert.equal(charSel.value, "bodyMale", "库默认停在画布当前那具素体（页面开局的标准男基座）：默认显示的就是套得进当前素体的那一批");
    assert.deepEqual([...charSel.options].map((o) => o.textContent),
        ["全部基座", "标准男素体", "标准女素体"],
        "基座选项跟着面板那两具基座走：label 用 meta/list 那份，页面注册表里的其余那几档不出选项");
    assert.deepEqual(cards().map((c) => c.dataset.libId), ["a", "calm-1", "sword"],
        "挂在女基座上的姿态默认不出现：套到男素体上是上半身全歪");
    changeValue(charSel, "bodyFemale");
    assert.deepEqual(cards().map((c) => c.dataset.libId), ["fem-1"], "基座下拉按条目的 charKey 过滤");
    changeValue(charSel, "");
    assert.equal(cards().length, 4, "全部基座 = 合并库全量：没有 charKey 的条目也在这档可见");
    assert.deepEqual(libFilter(POSE_LIB.entries, { charKey: "bodyFemale" }).map((e) => e.id), ["fem-1"]);
    assert.deepEqual(libFilter([{ id: "old-1", groups: ["stand"] }], { charKey: "bodyMale" }), [],
        "条目没有 charKey 时基座筛不掉它：旧版清单的条目只在「全部基座」那一档可见");
});

test("旧姿势包没有标准基座：素体下拉停在「选择素体…」，加素体不写一个清单里没有的 key", async () => {
    resetEnv();
    const env = await mounted();
    await env.ready();
    env.replyCall(env.calls("meta/list")[0], META_NO_STANDARD);
    env.replyCall(env.calls("prop/list")[0], PROPS);
    await settle();
    assert.equal(env.sel(0).value, "", "清单里没有 bodyMale 就不许写一个没有的 key");
    assert.deepEqual([...env.sel(0).options].map((o) => o.value), [""],
        "白名单外的素体不出选项：面板不摆一条点了只会失败的档位");
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
    await openLib(env);

    const source = env.host.querySelector(".ns-libmodal:not(.ns-hidden) .ns-pose-lib-source");
    assert.deepEqual([...source.options].map((o) => o.value), ["local"], "只有一台机器就不给开关");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_pose/cloud_index").length, 0,
        "未配置的云端不是一次后台轮询：连清单都不读");
});

test("云端库：切到云端读一次清单，卡片带云端角标与直连预览，点卡片经后端代读套用整场", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, cloud_status: CLOUD_ON });
    await env.ready();
    await openLib(env);

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
    assert.match(modal().querySelector(".ns-pose-lib-meta").textContent, /2 个云端姿势/);
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
        "预览图与姿势库封面同一口径：直连 OSS，不占后端一条代读");
    click(cloud);
    await settle();
    assert.ok(fetchLog.some((c) => c.path === "/neo_pose/cloud_file"
        && c.query.get("path") === "models/props/stick-cloud.glb"),
        "云端道具先经后端落进本机缓存，页面才认自己那条写死的 /models/props/ 路径");
    assert.deepEqual(env.calls("prop/add")[0].msg.args, { key: "glb:stick-cloud.glb" },
        "点云端卡片一步到位：落缓存与 prop/add 同一次点击里做完");
});

test("云端清单读不到：切过去给云端指引，不渲染一个空浏览器", async () => {
    resetEnv();
    const env = await mounted({ ...STATUS, cloud_status: { ...CLOUD_ON, available: false, scenes: 0, props: 0 },
        cloud_index: { success: false, error: "云端索引取不到：404 no such key" } });
    await env.ready();
    await openLib(env);

    const modal = () => env.host.querySelector(".ns-libmodal:not(.ns-hidden)");
    changeValue(modal().querySelector(".ns-pose-lib-source"), "cloud");
    await settle();
    assert.equal(modal().querySelectorAll(".ns-pose-lib-card").length, 0);
    assert.match(modal().querySelector(".ns-pose-lib-blank").textContent, /pose_deploy_oss/,
        "空态要说的是怎么把云端配起来，不是「没有匹配」");
    assert.match(env.toasts.join("|"), /云端索引取不到/);
});




