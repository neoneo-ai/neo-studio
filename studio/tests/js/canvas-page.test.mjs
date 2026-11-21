import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, describe } from "node:test";
import { fileURLToPath } from "node:url";
import { resetEnv, mockRoute, jsonResponse, flush, click, setConfirmAnswer, dialogs, fetchLog } from "./setup.mjs";
import { dispatchApiEvent, listenerCount, resetApiState } from "./mocks/comfy-api.mjs";
import { ICON_NAMES } from "../../web/js/core/icons.js";
import { closePresetPicker } from "../../web/js/core/preset-picker.js";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

// 引擎层纯函数在 pages/canvas/geometry.js，数据契约在 pages/canvas/store.js，页面在 pages/canvas/page.js：
// 模块级没有可变状态，跨用例不串味
const geometry = await import("../../web/studio/pages/canvas/geometry.js?canvasGeo=1");
const store = await import("../../web/studio/pages/canvas/store.js?canvasStore=1");
const page = await import("../../web/studio/pages/canvas/page.js?canvasPage=1");
const gen = await import("../../web/studio/pages/canvas/gen.js?canvasGen=1");
const params = await import("../../web/studio/pages/canvas/gen-params.js?canvasGenParams=1");
const canvas = { ...geometry, ...store, ...page };
const { $el } = await import("../../web/studio/shim/ui.js?canvasPage=1");

const STAGE = { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 };
const CENTER = { x: STAGE.width / 2, y: STAGE.height / 2 };   // 舞台矩形原点 0,0 时的视口中心，世界坐标与屏幕坐标同值
const STEP_X = canvas.NODE_SPECS.image.width + 32;            // placeGrid 的横向格距 = 节点宽 + 32
const settle = () => flush(20);

/** 画布项目存储：/neo_canvas/* 四条路由的内存替身，list / 读 / 存 / 重命名 / 删按真后端的形状走 */
function mockCanvas({ projects = [], saveImpl = null, projectImpl = null, renameImpl = null, deleteImpl = null } = {}) {
  const store = {
    projects: [...projects],
    saved: [],
    renames: [],
    deleted: [],
    toasts: [],
    current() { return store.projects[0] ? store.projects[0].id : ""; },
    seed() {
      store.projects = [
        { id: "canvas-a", title: "第一张", nodes: [{ id: "node-1", type: "image", title: "图片", position: { x: 0, y: 0 }, width: 340, height: 240, metadata: { filename: "a.png" } }],
          connections: [], viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots", node_count: 1, connection_count: 0, updated_at: "1" },
        { id: "canvas-b", title: "第二张", nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 },
          background_mode: "lines", node_count: 0, connection_count: 0, updated_at: "2" }];
    },
    project(id) { return store.projects.find((item) => item.id === id) || null; },
  };
  const routes = {
    "/neo_canvas/list": () => jsonResponse({ success: true, projects: store.projects }),
    "/neo_canvas/project": (body, call) => {
      if (call.method === "GET") {
        const id = call.query.get("id");
        return projectImpl ? projectImpl(id) : jsonResponse({ success: true, project: store.project(id) });
      }
      store.saved.push(body);
      if (saveImpl) return saveImpl(body);
      const payload = { ...body };
      if (!payload.id || !store.projects.some((item) => item.id === payload.id)) {
        payload.id = `canvas-${String(store.projects.length + 1).padStart(4, "0")}`;
      }
      const record = { ...payload, id: String(payload.id), title: String(payload.title || "未命名画布") };
      const meta = { ...record, node_count: (record.nodes || []).length,
        connection_count: (record.connections || []).length, updated_at: String(store.saved.length) };
      const at = store.projects.findIndex((item) => item.id === record.id);
      if (at >= 0) store.projects[at] = meta; else store.projects.push(meta);
      store.projects.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return jsonResponse({ success: true, id: record.id, title: record.title, project: record });
    },
    "/neo_canvas/rename": (body) => {
      store.renames.push(body);
      if (renameImpl) return renameImpl(body);
      const at = store.projects.findIndex((item) => item.id === body.id);
      if (at < 0) return jsonResponse({ success: false, error: "画布不存在" }, 404);
      store.projects[at].title = String(body.title || "未命名画布").slice(0, 96);
      return jsonResponse({ success: true, id: body.id, title: store.projects[at].title });
    },
    "/neo_canvas/delete": (body) => {
      store.deleted.push(body);
      if (deleteImpl) return deleteImpl(body);
      const at = store.projects.findIndex((item) => item.id === body.id);
      if (at < 0) return jsonResponse({ success: false, error: "画布不存在" }, 404);
      store.projects.splice(at, 1);
      return jsonResponse({ success: true, id: body.id });
    },
  };
  return { store, routes, api: { fetchApi: (path, opts = {}) => fetch(path, opts) },
    toast: (message, kind = "info") => { store.toasts.push({ message, kind }); } };
}
const noFetch = () => mockCanvas({ saveImpl: () => jsonResponse({ success: false, error: "画布目录写不进去" }, 500) });

function fire(target, type, init = {}) {
  const Ctor = type.startsWith("key") ? window.KeyboardEvent
    : type.startsWith("pointer") ? window.PointerEvent
      : type === "wheel" ? window.WheelEvent : window.MouseEvent;
  target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
}
function dragFire(target, type, payload, init = {}) {
  // jsdom 不造 DragEvent：drop 只看 dataTransfer 与坐标，挂普通事件上就够
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: payload, configurable: true });
  Object.assign(event, init);
  target.dispatchEvent(event);
}
const galleryPayload = (obj) => ({ types: ["application/x-neo-gallery"], getData: (type) => (type === "application/x-neo-gallery" ? JSON.stringify(obj) : "") });
const plainPayload = (text) => ({ types: ["text/plain"], getData: (type) => (type === "text/plain" ? text : "") });
/** 图片节点里的 <img> 读出图来了：jsdom 不真的读图，把 naturalWidth/Height 钉上去再交 load 事件 */
const loadSize = (img, width, height) => {
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  fire(img, "load");
};
/** 视频节点里的 <video> 读出那一段的宽高来了：同一发钉在 videoWidth/Height 上再交 loadedmetadata */
const loadVideoSize = (video, width, height) => {
  Object.defineProperty(video, "videoWidth", { value: width, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: height, configurable: true });
  fire(video, "loadedmetadata");
};
/** 出视频页那一份生成模式分组（studio-app.js 的 videoModeGroup / VIDEO_GROUP_LABELS 同一判法）：
 *  画布出片的参考分桶与技能面板分组都按它走，测试钉住这同一条判法 */
const GROUP_LABELS = { f2v: "图生视频", r2v: "全参考生视频", t2v: "文生视频" };
const modeGroupOf = (meta) => (["r2v", "v2v", "rv2v"].includes(meta?.mode) ? "r2v"
    : (meta?.mode && meta.mode !== "t2v" ? "f2v" : "t2v"));

async function makePage(env = mockCanvas(), extraHost = {}, { width = STAGE.width, height = STAGE.height } = {}) {
  resetEnv();
  for (const [route, responder] of Object.entries(env.routes)) mockRoute(route, responder);
  document.body.innerHTML = '<div class="ns-page"></div>';
  const host = document.querySelector(".ns-page");
  const page = canvas.createCanvasPage({ $el, api: env.api, toast: env.toast,
    modeGroup: modeGroupOf, groupLabels: GROUP_LABELS, ...extraHost });
  await page.build(host);
  const view = {
    stage: host.querySelector(".ns-canvas-stage"),
    grid: host.querySelector(".ns-canvas-grid"),
    world: host.querySelector(".ns-canvas-world"),
    links: host.querySelector(".ns-canvas-links"),
    active: host.querySelector(".ns-canvas-active-line"),
    nodeLayer: host.querySelector(".ns-canvas-nodes"),
    hint: host.querySelector(".ns-canvas-hint"),
    bar: host.querySelector(".ns-canvas-bar"),
    project: host.querySelector(".ns-canvas-project-btn"),
    projectPanel: host.querySelector(".ns-canvas-project-panel"),
    zoom: host.querySelector(".ns-canvas-zoom"),
    save: host.querySelector(".ns-canvas-save"),
  };
  view.stage.__rect = { ...STAGE, width, height, right: width, bottom: height };
  const nodeEl = (id) => view.nodeLayer.querySelector(`[data-node-id="${id}"]`);
  const pos = () => [...view.nodeLayer.children].map((el) => [parseFloat(el.style.left), parseFloat(el.style.top)]);
  const box = (id) => {
    const el = nodeEl(id);
    return { x: parseFloat(el.style.left), y: parseFloat(el.style.top),
      w: parseFloat(el.style.width), h: parseFloat(el.style.height) };
  };
  const button = (label) => [...view.bar.querySelectorAll(".ns-canvas-tool")]
    .find((el) => (el.getAttribute("aria-label") || "") === label);
  // 用例都从 view 上取 DOM 视图：把这几个读法挂在 view 上，断言里就只有一层
  Object.assign(view, { nodeEl, pos, box, button });
  return { page, host, view, nodeEl, pos, box, button, env };
}
const nodeHandle = (view, nodeId, side) => view.nodeLayer
  .querySelector(`[data-node-id="${nodeId}"] .ns-canvas-handle-${side}`);
const toastOf = (env) => env.store.toasts.map((item) => item.message);
// 切画布走自绘面板：点开条上那枚画布名，再点面板里那一行的名字
const pickCanvas = (view, id) => {
  click(view.project);
  click(view.projectPanel.querySelector(`[data-canvas="${id}"] .ns-canvas-project-row-name`));
};

describe("canvas-page", () => {
  const at = (x, y) => ({ x, y });
  const imageNode = (id, x, y) => ({ id, type: "image", title: "图片", position: at(x, y), width: 340, height: 240, metadata: {} });
  const pair = () => [imageNode("n1", 0, 0), imageNode("n2", 800, 0)];
  const handle = (nodeId, handleType, side = null) => (side
    ? { nodeId, handleType, side } : { nodeId, handleType });

  describe("常量与节点规格", () => {
    test("格距、缩放区间与背景模式循环", () => {
      assert.equal(canvas.GRID_SIZE, 48);
      assert.equal(canvas.MIN_SCALE, 0.05);
      assert.equal(canvas.MAX_SCALE, 5);
      assert.deepEqual(canvas.BACKGROUND_MODES, ["dots", "lines", "blank"]);
      assert.deepEqual(canvas.NODE_SPECS.image, { width: 340, height: 360, title: "图片" });
      assert.deepEqual(canvas.NODE_SPECS.text, { width: 340, height: 240, title: "提示词" });
    });
    test("连线命中半径与节点外扩 padding", () => {
      assert.equal(canvas.CONNECTION_HANDLE_HIT_RADIUS, 40);
      assert.equal(canvas.CONNECTION_NODE_HIT_PADDING, 32);
      assert.equal(canvas.CONNECTION_HIT_WIDTH, 16);
      assert.equal(canvas.MIN_NODE_WIDTH, 220);
      assert.equal(canvas.MIN_NODE_HEIGHT, 160);
    });
    test("图片节点按比例落位：横图压矮、竖图收窄，短边钉在 120", () => {
      assert.deepEqual(store.fitImageSize(1600, 900), { width: 340, height: 191 });
      assert.deepEqual(store.fitImageSize(900, 1600), { width: 203, height: 360 },
        "默认框是竖友好那一档：9:16 的竖图不再落到 135 宽那一条细条");
      assert.deepEqual(store.fitImageSize(1000, 1000), { width: 340, height: 340 },
        "正方图吃满默认框的宽，矮到 240 那一档就是竖屏素材变小那一发");
      assert.deepEqual(store.fitImageSize(3000, 100), { width: 340, height: 120 },
        "极端的长条幅压在短边下限上，不许比这更矮");
      assert.deepEqual(store.fitImageSize(100, 3000), { width: 120, height: 360 });
      assert.equal(store.fitImageSize(0, 900), null);
      assert.equal(store.fitImageSize(1600, 0), null);
    });
  });

  describe("屏幕 / 世界坐标", () => {
    const viewport = { x: 120, y: -60, k: 1.25 };
    const rect = { left: 40, top: 20, width: 800, height: 600 };

    test("屏幕 → 世界：先减容器原点，再除以缩放", () => {
      assert.deepEqual(canvas.screenToCanvas(viewport, 40 + 120 + 250, 20 - 60 + 125, rect), { x: 200, y: 100 });
      assert.deepEqual(canvas.screenToCanvas(viewport, 40 + 120, 20 - 60, rect), { x: 0, y: 0 });
    });
    test("世界 → 屏幕：与 screenToCanvas 互为逆", () => {
      assert.deepEqual(canvas.canvasToScreen(viewport, 200, 100, rect), { x: 40 + 120 + 250, y: 20 - 60 + 125 });
      const rect0 = { left: 0, top: 0, width: 800, height: 600 };
      const base = { x: 60, y: -20, k: 2 };
      const screen = canvas.canvasToScreen(base, 113, -47, rect0);
      assert.deepEqual(canvas.screenToCanvas(base, screen.x, screen.y, rect0), { x: 113, y: -47 });
    });
  });

  describe("缩放与平移", () => {
    test("滚轮缩放锚在指针上：指针下那一格缩放前后是同一个世界点", () => {
      const viewport = { x: 40, y: -20, k: 1 };
      const next = canvas.zoomViewportAt(viewport, 300, 200, -100);
      assert.equal(next.k, 1.1);
      assert.deepEqual(canvas.screenToCanvas(next, 300, 200, { left: 0, top: 0 }),
        canvas.screenToCanvas(viewport, 300, 200, { left: 0, top: 0 }));
    });
    test("连滚 6 格到 1.1^6，反向滚回去落回原视口", () => {
      const viewport = { x: 40, y: -20, k: 1 };
      let out = viewport;
      for (let i = 0; i < 6; i += 1) out = canvas.zoomViewportAt(out, 300, 200, -100);
      assert.ok(Math.abs(out.k - 1.1 ** 6) < 1e-9);
      for (let i = 0; i < 6; i += 1) out = canvas.zoomViewportAt(out, 300, 200, 100);
      assert.ok(Math.abs(out.k - 1) < 1e-9);
      assert.ok(Math.abs(out.x - viewport.x) < 1e-6 && Math.abs(out.y - viewport.y) < 1e-6);
    });
    test("缩放夹在 5%–500%", () => {
      assert.equal(canvas.zoomViewportAt({ x: 0, y: 0, k: 4 }, 100, 100, -1000).k, 5);
      assert.equal(canvas.zoomViewportAt({ x: 0, y: 0, k: 0.1 }, 100, 100, 1000).k, 0.05);
    });
    test("平移只动视口原点，缩放不动", () => {
      assert.deepEqual(canvas.panViewport({ x: 100, y: 50, k: 2 }, 100, 100, 140, 60), { x: 140, y: 10, k: 2 });
      assert.deepEqual(canvas.panViewport({ x: 100, y: 50, k: 2 }, 100, 100, 100, 100), { x: 100, y: 50, k: 2 });
    });
  });

  describe("网格几何", () => {
    test("格距 = 48 * k，视口原点取模", () => {
      assert.deepEqual(canvas.gridGeometry({ x: 0, y: 0, k: 1 }), { backgroundSize: "48px 48px",
        backgroundPosition: "0px 0px", fine: false });
      assert.deepEqual(canvas.gridGeometry({ x: 60, y: -30, k: 2 }), { backgroundSize: "96px 96px",
        backgroundPosition: "60px -30px", fine: false });
    });
    test("缩到 0.12 以下格子要变小", () => {
      assert.equal(canvas.gridGeometry({ x: 0, y: 0, k: 0.12 }).fine, false);
      assert.equal(canvas.gridGeometry({ x: 0, y: 0, k: 0.1 }).fine, true);
      assert.equal(canvas.gridGeometry({ x: 0, y: 0, k: 0.05 }).fine, true);
    });
  });

  describe("节点外接矩形", () => {
    test("空表回 null（空画布点「适应内容」不能把画面甩飞）", () => {
      assert.equal(canvas.nodeBounds([]), null);
    });
    test("一叠节点取最小左上与最大右下", () => {
      assert.deepEqual(canvas.nodeBounds([imageNode("n1", 40, 50), imageNode("n2", 400, 300)]),
        { left: 40, top: 50, right: 740, bottom: 540 });
      assert.deepEqual(canvas.nodeBounds([imageNode("n1", -80, -120)]),
        { left: -80, top: -120, right: 260, bottom: 120 });
    });
  });


  describe("连线路径与命中", () => {
    test("出源节点右中、落目标节点左中，控制点曲率 = max(距离 * 0.5, 50)", () => {
      const from = imageNode("n1", 0, 0), to = imageNode("n2", 400, 0);
      assert.deepEqual(canvas.connectionEnds(from, to), { start: at(340, 120), end: at(400, 120), curvature: 50 });
      assert.equal(canvas.connectionPathD(from, to), "M 340 120 C 390 120, 350 120, 400 120");
    });
    test("两节点贴在一起时曲率也留 50，线不会塌成一条直线", () => {
      const ends = canvas.connectionEnds(imageNode("n1", 0, 0), imageNode("n2", 340, 0));
      assert.equal(ends.curvature, 50);
      assert.deepEqual(ends.start, at(340, 120));
    });
    test("目标节点在源节点左边时线绕出去，端点仍是右中 → 左中", () => {
      assert.deepEqual(canvas.connectionEnds(imageNode("n1", 800, 0), imageNode("n2", 0, 0)),
        { start: at(1140, 120), end: at(0, 120), curvature: 570 });
    });
    test("上下叠放的两台节点走竖轴：上面出底边、下面收顶边（串联那一列）", () => {
      const text = imageNode("t", 0, 0), car = imageNode("c", 0, 300);
      assert.equal(canvas.connectionAxis(text, car), "y");
      assert.deepEqual(canvas.connectionEnds(text, car), { start: at(170, 240), end: at(170, 300), curvature: 50 });
      assert.equal(canvas.connectionPathD(text, car), "M 170 240 C 170 290, 170 250, 170 300");
    });
    test("下方素材连上方车厢：出顶边、落底边", () => {
      assert.deepEqual(canvas.connectionEnds(imageNode("ref", 0, 300), imageNode("car", 0, 0)),
        { start: at(170, 300), end: at(170, 240), curvature: 50 });
      assert.equal(canvas.connectionPathD(imageNode("ref", 0, 300), imageNode("car", 0, 0)),
        "M 170 300 C 170 250, 170 290, 170 240");
    });
    test("横向上没交与正好贴边都算并排：照旧走左右", () => {
      assert.equal(canvas.connectionAxis(imageNode("n1", 0, 0), imageNode("n2", 340, 0)), "x");
      assert.equal(canvas.connectionAxis(imageNode("n1", 0, 0), imageNode("n2", 800, 0)), "x");
      assert.equal(canvas.connectionAxis(imageNode("n1", 0, 0), imageNode("n2", 20, 400)), "y");
    });
    test("竖轴的线同样点得中：命中阈值同一套", () => {
      const from = imageNode("t", 0, 0), to = imageNode("c", 0, 300);
      assert.ok(canvas.hitConnection(at(170, 270), from, to, 1));
      assert.ok(canvas.hitConnection(at(178, 270), from, to, 1));
      assert.ok(!canvas.hitConnection(at(179, 270), from, to, 1), "离线 8 世界单位之外点不中");
      assert.ok(!canvas.hitConnection(at(170, 120), from, to, 1), "节点自己的中线上没有线");
      assert.ok(canvas.hitConnection(at(171, 270), from, to, 4));
      assert.ok(!canvas.hitConnection(at(173, 270), from, to, 4));
    });
    test("命中阈值 = 16/2/k：1 倍缩放 8 世界单位，4 倍缩放 2 世界单位", () => {
      const from = imageNode("n1", 0, 0), to = imageNode("n2", 800, 0);
      assert.ok(canvas.hitConnection(at(340, 120), from, to, 1));
      assert.ok(canvas.hitConnection(at(340, 128), from, to, 1));
      assert.ok(!canvas.hitConnection(at(340, 140), from, to, 1));
      assert.ok(canvas.hitConnection(at(570, 120), from, to, 1));
      assert.ok(!canvas.hitConnection(at(570, 129), from, to, 1));
      assert.ok(!canvas.hitConnection(at(2000, 120), from, to, 1));
      assert.ok(canvas.hitConnection(at(340, 121), from, to, 4));
      assert.ok(!canvas.hitConnection(at(340, 123), from, to, 4));
    });
    test("拉线中的那一条虚线：源端钉在节点上、悬空那头跟手，吸到候选节点时落锚点", () => {
      const d = canvas.activeConnectionPathD(imageNode("n1", 0, 0), handle("n1", "source"), at(900, 300), null);
      assert.ok(d.startsWith("M 340 120 C"));
      assert.ok(d.endsWith("900 300"));
      assert.ok(canvas.activeConnectionPathD(imageNode("n1", 0, 0), handle("n1", "source"), at(900, 300),
        imageNode("n2", 800, 0)).endsWith("800 120"));
      assert.ok(canvas.activeConnectionPathD(imageNode("n1", 0, 0), handle("n1", "target"), at(-100, 100), null)
        .startsWith("M -100 100 C"));
      assert.equal(canvas.activeConnectionPathD(null, handle("n1", "source"), at(900, 300), null), "");
    });
  });

  describe("连线落点与归一化", () => {
    test("候选节点的锚点：source 落左中、target 落右中", () => {
      const node = imageNode("n2", 800, 0);
      assert.deepEqual(canvas.getConnectionTargetAnchor(node, handle("n1", "source")), at(800, 120));
      assert.deepEqual(canvas.getConnectionTargetAnchor(node, handle("n1", "target")), at(1140, 120));
    });
    test("上下叠放时落点在顶边 / 底边中点：起手那台节点知道方向", () => {
      const nodes = [imageNode("txt", 0, 0), imageNode("car", 20, 400)];
      // 正文在车厢正上方：从底接线点拖出，就近落车厢顶边中点
      assert.deepEqual(canvas.getConnectionTargetAnchor(nodes[1], handle("txt", "source", "bottom"), nodes[0]), at(190, 400));
      // 从车厢顶接线点拖出接正文：车厢是出线那端，落点落正文底边中点
      assert.deepEqual(canvas.getConnectionTargetAnchor(nodes[0], handle("car", "target", "top"), nodes[1]), at(170, 240));
      assert.equal(canvas.getConnectionDropTarget(at(190, 400), nodes, handle("txt", "source", "bottom"), 1).nodeId, "car");
      assert.equal(canvas.getConnectionDropTarget(at(170, 240), nodes, handle("car", "target", "top"), 1).nodeId, "txt");
      // 没有起手那台节点（老调用口径）时照旧落左右
      assert.deepEqual(canvas.getConnectionTargetAnchor(nodes[1], handle("txt", "source")), at(20, 520));
    });
    test("节点内 > 锚点半径 > 节点外扩 32/k，半径全除以 k", () => {
      const nodes = pair();
      assert.equal(canvas.getConnectionDropTarget(at(900, 100), nodes, handle("n1", "source"), 1).nodeId, "n2");
      assert.equal(canvas.getConnectionDropTarget(at(900, 260), nodes, handle("n1", "source"), 1).isNearNode, true);
      // 锚点 (800,120) 外 70：k=1 时半径 40 够不着，k=0.5 时半径 80 够得着
      assert.equal(canvas.getConnectionDropTarget(at(730, 120), nodes, handle("n1", "source"), 1).nodeId, null);
      assert.equal(canvas.getConnectionDropTarget(at(730, 120), nodes, handle("n1", "source"), 0.5).nodeId, "n2");
      // 外扩 padding 32/k：k=1 时左边界 768 够不着，k=0.5 时 padding 64 → 边界 736 落得到
      assert.equal(canvas.getConnectionDropTarget(at(760, 260), nodes, handle("n1", "source"), 1).nodeId, null);
      assert.equal(canvas.getConnectionDropTarget(at(736, 260), nodes, handle("n1", "source"), 0.5).nodeId, "n2");
      // 拖回自己：isNearNode 成立，但不能自己连自己
      assert.deepEqual(canvas.getConnectionDropTarget(at(100, 100), nodes, handle("n1", "source"), 1),
        { nodeId: null, isNearNode: true });
      // 远处空白：连 isNearNode 都不成立
      assert.deepEqual(canvas.getConnectionDropTarget(at(2000, 900), nodes, handle("n1", "source"), 1),
        { nodeId: null, isNearNode: false });
    });
    test("拖出端的接线点类型决定落在目标的哪一侧", () => {
      const nodes = pair();
      // 从 n2 左侧（target）拖出 → 锚点是 n1 右中 (340,120)，外 45：k=1 差一点，k=0.5 够
      assert.equal(canvas.getConnectionDropTarget(at(385, 120), nodes, handle("n2", "target"), 1).nodeId, null);
      assert.equal(canvas.getConnectionDropTarget(at(385, 120), nodes, handle("n2", "target"), 0.5).nodeId, "n1");
    });
    test("归一化：拖出的一端是源、落下的一端是目标；自己连自己不成立", () => {
      const nodes = pair();
      assert.deepEqual(canvas.normalizeConnection("n1", "n2", nodes), { fromNodeId: "n1", toNodeId: "n2" });
      assert.deepEqual(canvas.normalizeConnection("n2", "n1", nodes), { fromNodeId: "n2", toNodeId: "n1" });
      assert.equal(canvas.normalizeConnection("n1", "n1", nodes), null);
      assert.equal(canvas.normalizeConnection("n1", "nope", nodes), null);
    });
    test("加连线：不成立的静默原样返回，同方向已有不叠第二条，反方向算新线", () => {
      const nodes = pair();
      const added = canvas.addConnection([], nodes, "n1", "n2");
      assert.deepEqual(added, [{ id: "conn-n1-n2", fromNodeId: "n1", toNodeId: "n2" }]);
      assert.equal(canvas.addConnection(added, nodes, "n1", "n2"), added);
      assert.equal(canvas.addConnection(added, nodes, "n2", "n1").length, 2);
      assert.equal(canvas.addConnection(added, nodes, "n1", "n1"), added);
      assert.equal(canvas.addConnection(added, nodes, "n1", "nope"), added);
    });
  });


  describe("节点增删与整体搬运", () => {
    test("删节点连带删掉两端接在它上面的连线", () => {
      const nodes = pair();
      const conns = [{ id: "conn-n1-n2", fromNodeId: "n1", toNodeId: "n2" }];
      const out = canvas.removeNodes(nodes, conns, ["n1"]);
      assert.deepEqual(out.nodes.map((n) => n.id), ["n2"]);
      assert.deepEqual(out.connections, []);
      const all = canvas.removeNodes(nodes, conns, ["n1", "n2"]);
      assert.deepEqual([all.nodes, all.connections], [[], []]);
      const untouched = canvas.removeNodes(nodes, conns, ["nope"]);
      assert.equal(untouched.nodes.length, 2);
      assert.equal(untouched.connections.length, 1);
    });
    test("整体搬一叠节点：选中的跟着走，没选中的不动", () => {
      const moved = canvas.moveNodes(pair(), ["n1"], 120, -80);
      assert.deepEqual(moved[0].position, at(120, -80));
      assert.deepEqual(moved[1].position, at(800, 0));
      assert.deepEqual(canvas.moveNodes(pair(), ["n1", "n2"], 10, 20)[1].position, at(810, 20));
      assert.deepEqual(canvas.moveNodes(pair(), [], 10, 20)[0].position, at(0, 0));
    });
    test("建节点：图片带素材坐标、提示词带正文，未知型回落成提示词", () => {
      const img = canvas.createCanvasNode("image", at(40, 60), { filename: "cat.png", subfolder: "x" });
      assert.equal(img.type, "image");
      assert.equal(img.title, "图片");
      assert.deepEqual(img.position, at(40, 60));
      assert.equal(img.width, 340);
      assert.ok(img.id.startsWith("node-"));
      const text = canvas.createCanvasNode("text", at(0, 0), { content: "雨夜" });
      assert.equal(text.title, "提示词");
      assert.equal(text.metadata.content, "雨夜");
      const bogus = canvas.createCanvasNode("config", at(0, 0), {});
      assert.equal(bogus.type, "text");
      assert.equal(bogus.height, 240);
    });
  });

  describe("框选", () => {
    test("AABB 相交即选中", () => {
      const nodes = pair();
      assert.deepEqual(canvas.marqueeSelect(nodes, { left: -50, top: 300, width: 100, height: 100 }), []);
      assert.deepEqual(canvas.marqueeSelect(nodes, { left: 100, top: 100, width: 10, height: 10 }), ["n1"]);
      assert.deepEqual(canvas.marqueeSelect(nodes, { left: 0, top: 0, width: 1140, height: 240 }), ["n1", "n2"]);
      assert.deepEqual(canvas.marqueeSelect(nodes, { left: 339, top: 119, width: 2, height: 2 }), ["n1"]);
      assert.deepEqual(canvas.marqueeSelect(nodes, { left: 341, top: 119, width: 2, height: 2 }), []);
    });
    test("Shift 加选把框前的选中集并进结果", () => {
      const nodes = pair();
      assert.deepEqual(canvas.marqueeSelect(nodes, { left: 100, top: 100, width: 10, height: 10 }, ["n2"]).sort(),
        ["n1", "n2"]);
      assert.deepEqual(canvas.marqueeSelect(nodes, { left: -10, top: -10, width: 10, height: 10 }, ["n2"]), ["n2"]);
    });
  });

  describe("拖角缩放", () => {
    const node = () => imageNode("n1", 100, 100);

    test("右下柄：位置不动，尺寸跟手，最小 220×160", () => {
      assert.deepEqual(canvas.resizeNode(node(), "bottom-right", 60, 40, false),
        { width: 400, height: 280, x: 100, y: 100 });
      assert.deepEqual(canvas.resizeNode(node(), "bottom-right", -900, -900, false),
        { width: 220, height: 160, x: 100, y: 100 });
    });
    test("左上柄：右下角钉住，原点往回挪", () => {
      assert.deepEqual(canvas.resizeNode(node(), "top-left", 60, 40, false),
        { width: 280, height: 200, x: 160, y: 140 });
    });
    test("锁比例按主轴算另一边，撑到最小值再按比例补回来", () => {
      const out = canvas.resizeNode(node(), "bottom-right", 170, 0, true);
      assert.equal(out.width, 510);
      assert.equal(out.height, 360);
      const shrunk = canvas.resizeNode(node(), "bottom-right", -200, -10, true);
      assert.equal(shrunk.height, 160);
      assert.equal(shrunk.width, 160 * (340 / 240));
    });
  });

  describe("落位与落盘形状", () => {
    test("placeGrid：空格落 start，压着已有节点就顺次往后排", () => {
      const size = { width: 340, height: 240 };
      assert.deepEqual(canvas.placeGrid([], size, at(0, 0)), at(0, 0));
      assert.deepEqual(canvas.placeGrid([imageNode("n1", 0, 0)], size, at(0, 0)), at(372, 0));
      assert.deepEqual(canvas.placeGrid([imageNode("n1", 0, 0)], size, at(0, 0), 32, 2), at(372, 0));
      assert.deepEqual(canvas.placeGrid([imageNode("n1", 0, 0)], size, at(0, 0), 32, 1), at(0, 272));
    });
    test("overlaps：贴边不算压着", () => {
      assert.equal(canvas.overlaps(imageNode("a", 0, 0), imageNode("b", 340, 0)), false);
      assert.equal(canvas.overlaps(imageNode("a", 0, 0), imageNode("b", 339, 0)), true);
      assert.equal(canvas.overlaps(imageNode("a", 0, 0), imageNode("b", 0, 241)), false);
    });
    test("序列化：字段名与 studio/canvas.py 收的那一份一致", () => {
      const state = { ...canvas.readCanvas({}), id: "canvas-0001", title: "分镜",
        nodes: [imageNode("n1", 0, 0)], connections: [{ id: "c1", fromNodeId: "n1", toNodeId: "n1" }],
        viewport: { x: 10, y: 20, k: 1.5 }, backgroundMode: "lines" };
      assert.deepEqual(canvas.serializeCanvas(state), { id: "canvas-0001", title: "分镜",
        nodes: state.nodes, connections: state.connections, viewport: { x: 10, y: 20, k: 1.5 },
        background_mode: "lines" });
    });
    test("串联的标记走一圈存盘读盘：chain / skill_id / disabled 都读得回来（旧键整份留着不丢）", () => {
      const nodes = [{ id: "g1", type: "gen", title: "出片", position: at(0, 0), width: 320, height: 208,
        metadata: { kind: "video", chain: "train", recipe: "短片配方", seed: 100 } },
      { id: "r1", type: "recipe", title: "车厢", position: at(400, 0), width: 360, height: 152,
        metadata: { recipe: "短片配方", segment: 1, skill_id: "h3_i2v", disabled: true } }];
      const state = canvas.readCanvas(canvas.serializeCanvas({ ...canvas.readCanvas({}),
        id: "canvas-0001", title: "一圈", nodes, connections: [{ id: "c1", fromNodeId: "r1", toNodeId: "g1" }],
        viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots" }));
      assert.deepEqual([state.nodes[0].metadata.chain, state.nodes[0].metadata.seed], ["train", 100]);
      assert.deepEqual([state.nodes[1].metadata.skill_id, state.nodes[1].metadata.disabled], ["h3_i2v", true]);
      assert.deepEqual([state.nodes[1].width, state.nodes[1].height], [360, 152], "车厢落的就是精简卡的尺寸");
      const old = canvas.readCanvas({ id: "c", nodes: [{ id: "n1", type: "recipe", width: 386, height: 324,
        metadata: { recipe: "短片配方", segment: 1, train: 1, expand_mode: "train" } }] });
      assert.deepEqual([old.nodes[0].metadata.train, old.nodes[0].metadata.expand_mode], [1, "train"],
        "旧画布上那两键读得回来，新版不写也不丢");
      assert.deepEqual(state.connections, [{ id: "c1", fromNodeId: "r1", toNodeId: "g1" }]);
    });
    test("读盘：缺字段回默认值", () => {
      const state = canvas.readCanvas({});
      assert.equal(state.id, "");
      assert.equal(state.title, "未命名画布");
      assert.deepEqual(state.nodes, []);
      assert.deepEqual(state.connections, []);
      assert.deepEqual(state.viewport, { x: 0, y: 0, k: 1 });
      assert.equal(state.backgroundMode, "dots");
    });
    test("读盘：旧版文件缺字段与未知键都要接住", () => {
      const state = canvas.readCanvas({
        id: "canvas-0001", title: "上一版存的",
        nodes: [{ id: "n1", type: "image", position: { x: 10, y: 20 }, width: 300, height: 200, metadata: { filename: "a.png" } },
          { id: "n2", type: "config" }, { type: "text" }],
        connections: [{ id: "c1", fromNodeId: "n1", toNodeId: "n2" }, { id: "gone", fromNodeId: "n1", toNodeId: "nope" }],
        viewport: { x: 30, k: 99 }, background_mode: "grid", wat: true,
      });
      assert.equal(state.nodes.length, 2);
      assert.deepEqual(state.nodes[0].position, at(10, 20));
      assert.equal(state.nodes[0].metadata.filename, "a.png");
      assert.equal(state.nodes[1].type, "text");
      assert.equal(state.nodes[1].width, 340);
      assert.deepEqual(state.connections, [{ id: "c1", fromNodeId: "n1", toNodeId: "n2" }]);
      assert.deepEqual(state.viewport, { x: 30, y: 0, k: 5 });
      assert.equal(state.backgroundMode, "dots");
    });
    test("读盘：连线端点不在节点表上的整条丢掉（含自己连自己）", () => {
      const state = canvas.readCanvas({ nodes: [{ id: "n1" }, { id: "n2" }],
        connections: [{ id: "c1", fromNodeId: "n1", toNodeId: "nope" }, { id: "c2", fromNodeId: "n1", toNodeId: "n1" },
          { id: "c3", fromNodeId: "n1", toNodeId: "n2" }] });
      assert.deepEqual(state.connections, [{ id: "c3", fromNodeId: "n1", toNodeId: "n2" }]);
    });
    test("存盘读盘走一圈回原样", () => {
      const state = canvas.readCanvas(canvas.serializeCanvas({ ...canvas.readCanvas({}),
        id: "canvas-0001", title: "一圈", nodes: [imageNode("n1", 0, 0)],
        connections: [], viewport: { x: -5, y: 9, k: 0.5 }, backgroundMode: "blank" }));
      assert.equal(state.id, "canvas-0001");
      assert.equal(state.title, "一圈");
      assert.deepEqual(state.nodes, [imageNode("n1", 0, 0)]);
      assert.deepEqual(state.viewport, { x: -5, y: 9, k: 0.5 });
      assert.equal(state.backgroundMode, "blank");
    });
  });


});

/* 页面用例的坐标基线：舞台钉在 (0,0,1200,800)、视口默认 {x:0,y:0,k:1}，
   于是世界坐标 = 舞台坐标，节点样式里的 left/top 就是屏幕落点。 */
const TWO_IMAGES = () => mockCanvas({ projects: [
  { id: "canvas-0001", title: "甲", nodes: [{ id: "n-a", type: "image", title: "图片",
    position: { x: 10, y: 20 }, width: 340, height: 240, metadata: { filename: "a.png" } }],
    connections: [], viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" },
  { id: "canvas-0002", title: "乙", nodes: [], connections: [],
    viewport: { x: 0, y: 0, k: 1 }, background_mode: "lines" },
] });
/** 一张填好图的 + 一张空着的图片节点，中间一条连线：节点头部动作的用例都从这一张起 */
const PAIR_WITH_LINK = () => mockCanvas({ projects: [
  { id: "canvas-0001", title: "甲", nodes: [
    { id: "n-a", type: "image", title: "图片", position: { x: 10, y: 20 }, width: 340, height: 240, metadata: { filename: "a.png" } },
    { id: "n-b", type: "image", title: "图片", position: { x: 400, y: 20 }, width: 340, height: 240, metadata: {} }],
    connections: [{ id: "c1", fromNodeId: "n-a", toNodeId: "n-b" }],
    viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" },
] });
/** 素材库弹窗的替身：开一次记一条回调，用例自己决定交回哪一批（与装配层同一份契约：一次一批数组） */
/** 上下叠放的两台节点（串联展开那一列的形状：正文 340×240 在车厢正上方、车厢 360×152）：
 *  就近接线与竖轴连线的用例从这一张起 */
/** 选中那一排上的动作名，按栏上的顺序 */
const barActs = (view, id) => [...view.nodeEl(id).querySelectorAll("[data-node-act]")].map((el) => el.dataset.nodeAct);
const STACKED_PAIR = () => mockCanvas({ projects: [
  { id: "canvas-0001", title: "甲", nodes: [
    { id: "txt", type: "text", title: "提示词", position: { x: 300, y: 60 }, width: 340, height: 240,
      metadata: { content: "第一段正文" } },
    { id: "car", type: "recipe", title: "配方闭环", position: { x: 300, y: 460 }, width: 360, height: 152,
      metadata: { recipe: "短片配方", segment: 0 } }],
    connections: [], viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" },
] });

/** 素材库弹窗的替身：开一次记一条回调与它声明要收的那一类（与装配层同一份契约：一次一批数组） */
const picker = () => {
  const calls = [], kinds = [];
  return { calls, kinds, openMaterial: (cb, kind) => { calls.push(cb); kinds.push(kind || "image"); } };
};
const nodeAct = (view, id, act) => view.nodeEl(id).querySelector(`[data-node-act="${act}"]`);
/** 选中一个节点：点它起手、松手收笔（点住即拖的起点，拖距 0 不算改动） */
const selectNode = (view, id, init = {}) => {
  const el = view.nodeEl(id);
  fire(el, "pointerdown", {
    clientX: parseFloat(el.style.left) + parseFloat(el.style.width) / 2,
    clientY: parseFloat(el.style.top) + parseFloat(el.style.height) / 2, button: 0, ...init,
  });
  fire(window, "pointerup", {});
};
const lit = (view) => [...view.nodeLayer.children]
  .filter((el) => el.classList.contains("ns-canvas-node-on")).length;

describe("canvas-page 页面", () => {
  describe("页面骨架", () => {
    test("页面结构：工具条 + 舞台 + 世界层 + 连线层 + 节点层", async () => {
      const { host, view } = await makePage();
      assert.ok(host.querySelector(".ns-canvas-bar"));
      assert.ok(view.stage.querySelector(".ns-canvas-grid"));
      assert.ok(view.world.querySelector(".ns-canvas-links"));
      assert.ok(view.world.querySelector(".ns-canvas-nodes"));
      // 拉线中的虚线用屏幕坐标画，挂在舞台上，不跟着世界层的 transform 走
      assert.ok(view.stage.querySelector(".ns-canvas-active-line"));
      assert.ok(!view.world.querySelector(".ns-canvas-active-line"));
    });
    test("空画布有提示，工具条上的动作一个不缺", async () => {
      const { view } = await makePage();
      assert.ok(view.hint.textContent.includes("把图拖进来"));
      for (const label of ["加图片", "加提示词", "加图像生成节点", "加视频生成节点", "添加配方",
        "撤销", "重做", "缩小", "放大", "适应内容", "背景"]) {
        assert.ok(view.bar.querySelector(`[aria-label="${label}"]`), label);
      }
      // 画布切换是自绘面板：画布组里不摆图标钮，新建画布是面板末行；没有画布就没有改名与删除可摆
      const panel = view.projectPanel;
      const groupEl = view.bar.querySelector(".ns-canvas-bar-group");
      assert.ok([...groupEl.children].filter((el) => el !== panel)
        .every((el) => !el.classList.contains("ns-canvas-tool")),
      "画布组条上不摆图标钮：条上只有当前画布名与箭头");
      assert.ok(panel.querySelector('[aria-label="新建画布"]'), "新建画布是面板末行");
      assert.ok(!view.bar.querySelector('[aria-label="重命名"]') && !view.bar.querySelector('[aria-label="删除画布"]'),
        "一张画布都没有时不摆改名与删除：不能工作的控件不上条");
      assert.ok(!view.bar.querySelector(".ns-canvas-select"), "原生 select 不在条上：弹层装不下这两枚钮");
      assert.equal(view.bar.querySelector('[aria-label="展开配方"]'), null, "工具条不摆展开配方：卡上那枚就够");
      // 剪贴板四枚不上条：Ctrl+D / X / C / V 就是这四发，鼠标用户在同一条上按条上那枚是同一发
      assert.deepEqual(["复制选中", "剪切选中", "复制", "粘贴"]
        .filter((label) => view.bar.querySelector(`[aria-label="${label}"]`)), []);
    });
    test("工具条每一枚钮的图标名都画得出来（缺一名就是条上一枚只剩边框的空钮）", () => {
      // 加节点那八行的图标在 node-types.js 那一列里（菜单照它铺），其余各枚还在 page.js 里现建
      const source = fs.readFileSync(path.join(webDir, "studio/pages/canvas/page.js"), "utf8");
      const addSource = fs.readFileSync(path.join(webDir, "studio/pages/canvas/node-types.js"), "utf8");
      const names = [
        ...[...source.matchAll(/\b(?:mk(?:Label|Hint)?|rowAct|setIcon(?:Label)?)\((?:[^()]|\([^()]*\))*?,\s*"([a-z0-9-]+)"/g)].map((m) => m[1]),
        ...[...addSource.matchAll(/\bicon:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]),
      ];
      assert.ok(names.length >= 14, `工具条里只扫到 ${names.length} 枚图标名：${names.join(",")}`);
      for (const name of names) {
        assert.ok(ICON_NAMES.includes(name), `图标 ${name} 在 icons.js 里画不出`);
      }
    });
    test("节点头上的图标名都画得出来，停用与删除分得开", () => {
      const source = fs.readFileSync(path.join(webDir, "studio/pages/canvas/nodes.js"), "utf8");
      const bar = source.slice(source.indexOf("function nodeBar"));
      const iconOf = (act) => (bar.match(new RegExp(`nodeAct\\(\\$el, "${act}", [^,]+, "([a-z0-9-]+)"`)) || [])[1];
      // 两枚都是 ✕ 的话，按下去之前看不出这一枚是停一张还是删一张
      assert.equal(iconOf("disable"), "ban", "停用是圆圈上一道斜杠");
      assert.equal(iconOf("enable"), "check", "启用是一枚勾");
      assert.equal(iconOf("delete"), "trash", "删除是垃圾桶");
      assert.equal(iconOf("copy"), "copy", "复制是两张叠着的纸");
      for (const name of ["ban", "trash", "check", "copy", "circle-check"]) {
        assert.ok(ICON_NAMES.includes(name), `图标 ${name} 在 icons.js 里画不出`);
      }
    });
    test("车尾「参数」弹窗里那几枚胶囊的图标名都画得出来", () => {
      const source = fs.readFileSync(path.join(webDir, "studio/pages/canvas/gen-recipe.js"), "utf8");
      const names = [...source.slice(source.indexOf("function openChainParams"))
        .matchAll(/\bicon:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
      assert.ok(names.length >= 4, `参数弹窗里只扫到 ${names.length} 枚图标名：${names.join(",")}`);
      for (const name of names) {
        assert.ok(ICON_NAMES.includes(name), `图标 ${name} 在 icons.js 里画不出`);
      }
    });
    test("加节点是一枚下拉菜单：五条都在条里，点一项加一个并自己收起", async () => {
      const { view } = await makePage();
      const add = view.button("加节点");
      const menu = view.bar.querySelector(".ns-canvas-add-menu");
      assert.ok(add, "条上就一枚「加节点」");
      assert.ok(!menu.classList.contains("ns-canvas-add-menu-open"), "起手是收着的");
      for (const label of ["加图片", "加提示词", "加图像生成节点", "加视频生成节点", "添加配方"]) {
        const row = menu.querySelector(`[aria-label="${label}"]`);
        assert.ok(row, `菜单里少了 ${label}`);
        assert.ok(row.textContent.includes(label), `${label} 要把名字打在行面上`);
      }
      click(add);
      assert.ok(menu.classList.contains("ns-canvas-add-menu-open"), "按一下就展开");
      click(add);
      assert.ok(!menu.classList.contains("ns-canvas-add-menu-open"), "再按一下就收起");
      click(add);
      click(view.button("加提示词"));
      assert.equal(view.nodeLayer.children.length, 1, "菜单里点一项就加一个节点");
      assert.ok(!menu.classList.contains("ns-canvas-add-menu-open"), "点完一项菜单自己收起");
    });
    test("加节点菜单按 文字 / 图像 / 视频 三大类铺开：每一行落在自己那一档下", async () => {
      const { view } = await makePage();
      const menu = view.bar.querySelector(".ns-canvas-add-menu");
      const under = {};
      let head = null;
      for (const child of menu.children) {
        if (child.classList.contains("ns-canvas-add-group")) { head = child.textContent; under[head] = []; continue; }
        under[head].push(child.getAttribute("aria-label"));
      }
      assert.deepEqual(Object.keys(under), ["文字", "图像", "视频"], "三大类的标题与顺序");
      assert.deepEqual(under["文字"], ["加提示词", "加文本增强节点", "加文字故事板节点", "加备注卡"]);
      assert.deepEqual(under["图像"], ["加图片", "加图像生成节点", "加图像编辑节点", "加图片反推节点"]);
      assert.deepEqual(under["视频"], ["加视频生成节点", "加视频输入", "加音频输入", "添加配方"]);
      // 标题行是一行小字，不是可按的钮：菜单里可按的行就是注册表那一列的行数
      assert.equal([...menu.children].filter((el) => el.classList.contains("ns-canvas-add-item")).length, 12);
      for (const el of menu.querySelectorAll(".ns-canvas-add-group")) {
        assert.equal(el.tagName, "DIV", `标题行「${el.textContent}」不可按`);
      }
    });
    test("备注卡（仓内扩展行的第一类）：正文与颜色标记都落进 metadata，卡上的控件按得中", async () => {
      const { page, view } = await makePage();
      click(view.button("加备注卡"));
      const card = view.nodeLayer.querySelector(".ns-canvas-node-note");
      assert.ok(card, "菜单里那一行要铺出一张备注卡");
      assert.equal(parseFloat(card.style.width), 240, "默认框按扩展行那一档");
      const ta = card.querySelector("textarea");
      const pick = card.querySelector("select");
      assert.ok(ta && !ta.hasAttribute("readonly"), "正文框要能直接打字");
      assert.equal(pick.options.length, 4, "颜色标记四档：默认色 / 暖 / 冷 / 醒目");
      ta.value = "拍 3 号镜头之前先看一眼";
      fire(ta, "input");
      pick.value = "warm";
      fire(pick, "change");
      await settle();
      const [note] = page.current().nodes;
      assert.equal(note.type, "note", "落盘的 type 就是扩展行那一个字符串");
      assert.equal(note.metadata.content, "拍 3 号镜头之前先看一眼");
      assert.equal(note.metadata.tone, "warm");
      const live = view.nodeEl(note.id).querySelector("select");
      assert.equal(live.value, "warm", "重画完要认得出这一张标的是暖");
      assert.equal(view.save.textContent, "未保存", "改了正文与颜色要标脏");
      // 手势层那一条：卡上的下拉起手交浏览器（那一发拦下来就没有展开），滚轮在卡上的控件上不缩放画面
      const press = new window.PointerEvent("pointerdown",
        { bubbles: true, cancelable: true, button: 0, clientX: CENTER.x, clientY: CENTER.y });
      live.dispatchEvent(press);
      assert.ok(!press.defaultPrevented, "下拉那一发不许拦：拦了 pointerdown 就没有展开");
      fire(window, "pointerup", {});
      fire(live, "wheel", { clientX: CENTER.x, clientY: CENTER.y, deltaY: -100 });
      assert.equal(page.current().viewport.k, 1, "滚轮落在卡上的下拉上不缩放画面");
      fire(view.nodeEl(note.id).querySelector("textarea"), "wheel", { clientX: CENTER.x, clientY: CENTER.y, deltaY: -100 });
      assert.equal(page.current().viewport.k, 1, "滚轮落在正文框上也不缩放画面");
    });



    test("加一个提示词节点：正文框可直接打字，有节点之后提示让位", async () => {
      const { view } = await makePage();
      click(view.button("加提示词"));
      const ta = view.nodeLayer.querySelector("textarea");
      assert.ok(ta);
      assert.ok(!ta.hasAttribute("readonly"), "新建的正文框要能直接打字");
      assert.ok(view.nodeLayer.querySelector(".ns-canvas-node-text"));
      assert.equal(view.nodeLayer.children.length, 1);
      assert.equal(view.hint.style.display, "none", "有节点之后提示要让位");
    });
    test("提示词正文落到 metadata.content 并标脏", async () => {
      const { page, view } = await makePage();
      click(view.button("加提示词"));
      const textarea = view.nodeLayer.querySelector("textarea");
      textarea.value = "三段文字";
      fire(textarea, "input");
      assert.equal(page.current().nodes[0].metadata.content, "三段文字");
      assert.equal(view.save.textContent, "未保存");
      assert.deepEqual(view.pos(), [[CENTER.x, CENTER.y]]);
    });
    test("正文框起手是选中这一张：短距离选字不动节点，拖过一截才挪走", async () => {
      const { view, page } = await makePage();
      click(view.button("加提示词"));
      const ta = view.nodeLayer.querySelector("textarea");
      fire(ta, "pointerdown", { clientX: CENTER.x, clientY: CENTER.y });
      fire(window, "pointermove", { clientX: CENTER.x + 5, clientY: CENTER.y + 3 });
      assert.deepEqual(view.pos(), [[CENTER.x, CENTER.y]], "正文里短距离是选字，节点不该跟着走");
      fire(window, "pointermove", { clientX: CENTER.x + 90, clientY: CENTER.y + 70 });
      assert.deepEqual(view.pos(), [[CENTER.x + 90, CENTER.y + 70]], "拖过一截就是拖节点");
      fire(window, "pointerup", {});
      assert.equal(page.current().nodes[0].position.x, CENTER.x + 90);
      assert.equal(lit(view), 1, "从正文框起手要把这一张选中");
    });
    test("加图片节点落在视口中心，第二个不压着第一个", async () => {
      const { view } = await makePage();
      click(view.button("加图片"));
      assert.deepEqual(view.pos(), [[CENTER.x, CENTER.y]]);
      assert.ok(view.nodeLayer.querySelector("img"));
      click(view.button("加图片"));
      assert.deepEqual(view.pos(), [[CENTER.x, CENTER.y], [CENTER.x + STEP_X, CENTER.y]]);
    });
    test("没有素材坐标的图片节点走占位图，拖进来的素材走 Gallery 缩略图", async () => {
      const { view } = await makePage();
      click(view.button("加图片"));
      assert.ok(view.nodeLayer.querySelector("img").src.endsWith("/neo_gallery/placeholder.png"),
        "没有 filename 的节点要显示占位图");
      dragFire(view.stage, "drop", galleryPayload({ filename: "rain.png", subfolder: "neo_gen/2026-11" }),
        { clientX: CENTER.x, clientY: CENTER.y });
      await settle();
      const img = view.nodeLayer.children[1].querySelector("img");
      assert.ok(img.src.includes("/neo_gallery/thumbnail"));
      assert.ok(img.src.includes("rain.png"));
    });
    test("缩略图不在时先回原图，原图也不在才落占位图", async () => {
      mockRoute("/neo_gallery/thumbnail", () => jsonResponse({}, 404));
      const { view } = await makePage();
      dragFire(view.stage, "drop", galleryPayload({ filename: "rain.png" }),
        { clientX: CENTER.x, clientY: CENTER.y });
      await settle();
      const img = view.nodeLayer.querySelector("img");
      fire(img, "error");
      assert.ok(img.src.includes("/neo_gallery/image"));
      fire(img, "error");
      assert.ok(img.src.endsWith("/neo_gallery/placeholder.png"));
    });
    test("图读上来了就按图自己的比例落那一格：横图压矮、竖图收窄", async () => {
      const { page, view, env } = await makePage();
      dragFire(view.stage, "drop", galleryPayload({ filename: "wide.png" }),
        { clientX: CENTER.x, clientY: CENTER.y });
      await settle();
      const [wide] = page.current().nodes;
      loadSize(view.nodeEl(wide.id).querySelector("img"), 1600, 900);
      assert.deepEqual([view.box(wide.id).w, view.box(wide.id).h], [340, 191], "16:9 的图压矮那一格");
      dragFire(view.stage, "drop", galleryPayload({ filename: "tall.png" }),
        { clientX: CENTER.x, clientY: CENTER.y + 300 });
      await settle();
      const tall = page.current().nodes[1];
      loadSize(view.nodeEl(tall.id).querySelector("img"), 900, 1600);
      assert.deepEqual([view.box(tall.id).w, view.box(tall.id).h], [203, 360], "2:3 的图收窄那一格");
      page.flush();
      const saved = env.store.saved[0].nodes.find((n) => n.id === wide.id);
      assert.deepEqual([saved.width, saved.height], [340, 191],
        "落下的比例跟着节点存盘，下次打开还是这一格");
    });
    test("拉过尺寸的节点不按图重铺，没有素材坐标的占位图不算比例", async () => {
      const { page, view } = await makePage();
      dragFire(view.stage, "drop", galleryPayload({ filename: "wide.png" }),
        { clientX: CENTER.x, clientY: CENTER.y });
      await settle();
      const [id] = page.current().nodes.map((node) => node.id);
      fire(view.nodeEl(id).querySelector(".ns-canvas-resize-bottom-right"), "pointerdown",
        { clientX: CENTER.x + 340, clientY: CENTER.y + 240, button: 0 });
      fire(window, "pointermove", { clientX: CENTER.x + 420, clientY: CENTER.y + 320 });
      fire(window, "pointerup", {});
      const sized = view.box(id);
      assert.ok(sized.w > 340 && sized.h > 240, "先把这一张拉大一档");
      loadSize(view.nodeEl(id).querySelector("img"), 1600, 900);
      assert.deepEqual([view.box(id).w, view.box(id).h], [sized.w, sized.h],
        "用户拉过的尺寸是用户要的，不许按图重铺");
      click(view.button("加图片"));
      const empty = page.current().nodes[1];
      loadSize(view.nodeEl(empty.id).querySelector("img"), 1600, 900);
      assert.deepEqual([view.box(empty.id).w, view.box(empty.id).h], [340, 360],
        "空节点上的占位图不是那张图，不能按它的比例铺");
    });
    test("串联素材那种 240×160 的小卡不按图重铺", async () => {
      const { page, view } = await makePage(mockCanvas({ projects: [
        { id: "canvas-0001", title: "甲", nodes: [
          { id: "n-ref", type: "image", title: "图片", position: { x: 0, y: 0 }, width: 240, height: 160,
            metadata: { filename: "ref.png", subfolder: "" } }],
          connections: [], viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" }] }));
      await settle();
      loadSize(view.nodeEl("n-ref").querySelector("img"), 1600, 900);
      assert.deepEqual([view.box("n-ref").w, view.box("n-ref").h], [240, 160],
        "串联的行距与素材卡都按 240×160 那一档铺，按图重铺就会压到车厢身上");
      assert.equal(page.current().nodes[0].height, 160);
    });
  });


  describe("素材拖放与双击", () => {
    test("拖到舞台上的素材卡片落成一个图片节点", async () => {
      const { page, view } = await makePage();
      dragFire(view.stage, "drop", galleryPayload({ filename: "rain.png", subfolder: "neo_gen/2026-11" }),
        { clientX: CENTER.x, clientY: CENTER.y });
      await settle();
      assert.equal(page.current().nodes.length, 1);
      const [node] = page.current().nodes;
      assert.equal(node.type, "image");
      assert.equal(node.metadata.filename, "rain.png");
      assert.equal(node.metadata.subfolder, "neo_gen/2026-11");
      // 落点 = 鼠标处居中的图片节点：(400,300) 减掉半张图 170x180
      assert.deepEqual(view.pos(), [[CENTER.x - 170, CENTER.y - 180]]);
    });
    test("素材卡片只给文件名时走 text/plain 回退", async () => {
      const { page, view } = await makePage();
      dragFire(view.stage, "drop", plainPayload("rain.png"), { clientX: CENTER.x, clientY: CENTER.y });
      await settle();
      assert.equal(page.current().nodes[0].metadata.filename, "rain.png");
      assert.equal(page.current().nodes.length, 1);
    });
    test("非素材的拖拽不动画布", async () => {
      const { page, view } = await makePage();
      dragFire(view.stage, "drop", plainPayload("一段不是文件名的文字"), { clientX: 100, clientY: 100 });
      dragFire(view.stage, "drop", galleryPayload({ subfolder: "sub" }), { clientX: 100, clientY: 100 });
      await settle();
      assert.equal(page.current().nodes.length, 0);
    });
    test("空白处双击弹「加节点」菜单：选完那一行就在指针那一点铺一张节点", async () => {
      const { page, view } = await makePage();
      click(view.button("加图片"));
      const menu = view.bar.querySelector(".ns-canvas-add-menu");
      fire(view.stage, "dblclick", { clientX: CENTER.x - 200, clientY: CENTER.y - 100 });
      assert.ok(menu.classList.contains("ns-canvas-add-menu-open"), "双击空白 = 弹节点选择，不是默认铺一张提示词");
      assert.equal(page.current().nodes.length, 1, "双击那一下自己不铺节点");
      fire(document.body, "keydown", { key: "Escape" });
      assert.ok(!menu.classList.contains("ns-canvas-add-menu-open"), "Esc 把菜单收回去");
      fire(view.stage, "dblclick", { clientX: CENTER.x - 200, clientY: CENTER.y - 100 });
      click(menu.querySelector('[aria-label="加提示词"]'));
      await settle();
      assert.deepEqual(view.pos(), [[CENTER.x, CENTER.y], [CENTER.x - 370, CENTER.y - 220]],
        "菜单里那一行落在双击的那一点上（节点中心 = 指针），不回到视口中心");
      assert.ok(view.nodeLayer.children[1].classList.contains("ns-canvas-node-text"));
      assert.ok(!menu.classList.contains("ns-canvas-add-menu-open"), "选完菜单自己收起");
    });
    test("双击节点正文 = 进编辑", async () => {
      const { view } = await makePage();
      click(view.button("加提示词"));
      const node = view.nodeLayer.children[0];
      fire(node, "dblclick", { clientX: CENTER.x, clientY: CENTER.y });
      assert.ok(document.activeElement?.classList?.contains("ns-canvas-node-textarea"),
        "双击 = 落进正文框");
      assert.equal(view.nodeLayer.children.length, 1, "进编辑不重建节点");
    });
  });

  describe("连线：拉、选中、删", () => {
    /** 两张图：n1 在 (600,400)、n2 在 (972,400)，各 340x240，中间隔 32px */
    const twoNodes = async () => {
      const ctx = await makePage();
      click(ctx.view.button("加图片"));
      click(ctx.view.button("加图片"));
      const [n1, n2] = [...ctx.view.nodeLayer.children].map((el) => el.dataset.nodeId);
      return { ...ctx, n1, n2 };
    };
    test("从右接线点拖到另一个节点松手 = 一条连线", async () => {
      const { page, view, n1, n2 } = await twoNodes();
      fire(nodeHandle(view, n1, "right"), "pointerdown", { clientX: 940, clientY: 520, button: 0 });
      fire(window, "pointermove", { clientX: 1142, clientY: 520 });
      assert.ok(view.active.getAttribute("d").length > 0, "拉线中要画跟随指针的虚线");
      fire(window, "pointerup", {});
      await settle();
      assert.equal(page.current().connections.length, 1);
      assert.deepEqual([page.current().connections[0].fromNodeId, page.current().connections[0].toNodeId], [n1, n2]);
      assert.equal(view.links.children.length, 2, "一条连线是宽命中描边 + 可见细线两条 path");
      assert.equal(view.active.getAttribute("d"), "", "松手之后拉线虚线要收掉");
    });
    test("四枚接线点：左与上收线、右与下出线，各认自己那一面", async () => {
      const { view, n1 } = await twoNodes();
      assert.deepEqual(["left", "top", "bottom", "right"].map((side) => nodeHandle(view, n1, side).dataset.handle),
        ["target", "target", "source", "source"]);
      assert.deepEqual(["left", "top", "bottom", "right"].map((side) => nodeHandle(view, n1, side).dataset.side),
        ["left", "top", "bottom", "right"]);
    });
    test("上下叠放的两台节点：从上面那台的底接线点就近接到下面那台", async () => {
      const { page, view } = await makePage(STACKED_PAIR());
      fire(nodeHandle(view, "txt", "bottom"), "pointerdown", { clientX: 470, clientY: 300, button: 0 });
      fire(window, "pointermove", { clientX: 480, clientY: 460 });
      fire(window, "pointerup", {});
      await settle();
      const conn = page.current().connections[0];
      assert.deepEqual([conn.fromNodeId, conn.toNodeId], ["txt", "car"], "正文是源、车厢是目标");
      const d = view.links.querySelector('.ns-canvas-line[data-connection-id="conn-txt-car"]').getAttribute("d");
      assert.ok(d.startsWith("M 470 300 C 470 380"), "线从正文底边出，不绕右中");
      assert.ok(d.endsWith("480 460"), "落在车厢顶边中点");
    });
    test("松手在空白处要说话，不记一条线", async () => {
      const { page, view, env, n1 } = await twoNodes();
      fire(nodeHandle(view, n1, "right"), "pointerdown", { clientX: 940, clientY: 520, button: 0 });
      fire(window, "pointermove", { clientX: 100, clientY: 100 });
      fire(window, "pointerup", {});
      await settle();
      assert.equal(page.current().connections.length, 0);
      assert.ok(toastOf(env).some((m) => m.includes("连线要落在一个节点上")));
      assert.equal(view.active.getAttribute("d"), "");
    });
    test("点宽命中描边选中连线，Delete 删掉这一条", async () => {
      const { page, view, n1, n2 } = await twoNodes();
      fire(nodeHandle(view, n1, "right"), "pointerdown", { clientX: 940, clientY: 520, button: 0 });
      fire(window, "pointermove", { clientX: 1142, clientY: 520 });
      fire(window, "pointerup", {});
      await settle();
      fire(view.links.querySelector(".ns-canvas-line-hit"), "pointerdown", { clientX: 900, clientY: 520, button: 0 });
      assert.ok(view.links.querySelector(".ns-canvas-line.ns-canvas-line-on"));
      assert.equal(lit(view), 0, "点线要把节点选中清掉");
      fire(window, "keydown", { key: "Delete", code: "Delete" });
      assert.equal(page.current().connections.length, 0);
      assert.equal(page.current().nodes.length, 2, "删线不碰节点");
    });
    test("删节点连带删掉两端接在它上面的连线", async () => {
      const { page, view, n1, n2 } = await twoNodes();
      fire(nodeHandle(view, n1, "right"), "pointerdown", { clientX: 940, clientY: 520, button: 0 });
      fire(window, "pointermove", { clientX: 1142, clientY: 520 });
      fire(window, "pointerup", {});
      await settle();
      assert.equal(page.current().connections.length, 1);
      selectNode(view, n1);
      fire(window, "keydown", { key: "Delete", code: "Delete" });
      assert.equal(page.current().nodes.length, 1);
      assert.equal(page.current().connections.length, 0);
    });
    test("同方向重复拉线只有一条", async () => {
      const { page, view, n1, n2 } = await twoNodes();
      const pull = () => {
        fire(nodeHandle(view, n1, "right"), "pointerdown", { clientX: 940, clientY: 520, button: 0 });
        fire(window, "pointermove", { clientX: 1142, clientY: 520 });
        fire(window, "pointerup", {});
      };
      pull();
      pull();
      await settle();
      assert.equal(page.current().connections.length, 1);
      assert.equal(view.links.children.length, 2);
    });
  });


  describe("选中：框选、键盘、删除", () => {
    const twoImages = (view) => {
      click(view.button("加图片"));
      click(view.button("加图片"));
      return [...view.nodeLayer.children].map((el) => el.dataset.nodeId);
    };
    test("Ctrl 空白处起手框选，罩住的节点全亮", async () => {
      const { view } = await makePage();
      twoImages(view);
      fire(view.stage, "pointerdown", { clientX: 100, clientY: 100, button: 0, ctrlKey: true });
      fire(window, "pointermove", { clientX: 1150, clientY: 700 });
      assert.equal(lit(view), 2);
      assert.ok(view.world.querySelector(".ns-canvas-marquee"));
      assert.ok(view.stage.classList.contains("ns-canvas-marqueeing"), "起手要把光标换成十字");
      fire(window, "pointerup", {});
      assert.equal(lit(view), 2, "松手之后选中要留着");
      assert.ok(!view.stage.classList.contains("ns-canvas-marqueeing"), "松手要把手势态收掉");
    });
    test("框不住任何节点时不亮", async () => {
      const { view } = await makePage();
      click(view.button("加图片"));
      fire(view.stage, "pointerdown", { clientX: 30, clientY: 30, button: 0, ctrlKey: true });
      fire(window, "pointermove", { clientX: 200, clientY: 200 });
      assert.equal(lit(view), 0);
      fire(window, "pointerup", {});
      assert.ok(!view.world.querySelector(".ns-canvas-marquee"), "松手要把框收掉");
    });
    test("空白框选换掉选中集：罩不住的不留", async () => {
      const { view } = await makePage();
      const [n1, n2] = twoImages(view);
      selectNode(view, n1);
      assert.equal(lit(view), 1);
      fire(view.stage, "pointerdown", { clientX: 1000, clientY: 450, button: 0, ctrlKey: true });
      fire(window, "pointermove", { clientX: 1300, clientY: 600 });
      fire(window, "pointerup", {});
      assert.deepEqual([...view.nodeLayer.children]
        .filter((el) => el.classList.contains("ns-canvas-node-on")).map((el) => el.dataset.nodeId), [n2]);
    });
    test("Shift 框选在已选基础上加选", async () => {
      const ctx = await makePage();
      const [n1] = twoImages(ctx.view);
      selectNode(ctx.view, n1);
      assert.equal(lit(ctx.view), 1);
      fire(ctx.view.stage, "pointerdown", { clientX: 1000, clientY: 450, button: 0, shiftKey: true });
      fire(window, "pointermove", { clientX: 1300, clientY: 600 });
      assert.equal(lit(ctx.view), 2, "Shift 框选把罩住的加进来，原来选的留着");
      fire(window, "pointerup", {});
    });
    test("方向键微移 8px，Shift 40px（世界单位）", async () => {
      const { view } = await makePage();
      click(view.button("加图片"));
      selectNode(view, view.nodeLayer.children[0].dataset.nodeId);
      fire(window, "keydown", { key: "ArrowRight", code: "ArrowRight" });
      fire(window, "keydown", { key: "ArrowDown", code: "ArrowDown" });
      assert.deepEqual(view.pos(), [[CENTER.x + 8, CENTER.y + 8]]);
      fire(window, "keydown", { key: "ArrowLeft", code: "ArrowLeft", shiftKey: true });
      assert.deepEqual(view.pos(), [[CENTER.x - 32, CENTER.y + 8]]);
    });
    test("Escape 清掉选中", async () => {
      const { view } = await makePage();
      click(view.button("加图片"));
      selectNode(view, view.nodeLayer.children[0].dataset.nodeId);
      assert.equal(lit(view), 1);
      fire(window, "keydown", { key: "Escape", code: "Escape" });
      assert.equal(lit(view), 0);
    });
    test("正文框在打字时键盘不动节点", async () => {
      const { view, pos } = await makePage();
      click(view.button("加提示词"));
      const before = pos();
      view.nodeLayer.querySelector("textarea").focus();
      for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
        fire(window, "keydown", { key, code: key });
      }
      assert.deepEqual(pos(), before);
    });
    test("Shift 点选：加选与减选", async () => {
      const { view } = await makePage();
      const [n1, n2] = twoImages(view);
      selectNode(view, n1);
      assert.equal(lit(view), 1);
      selectNode(view, n2, { shiftKey: true });
      assert.equal(lit(view), 2);
      selectNode(view, n2, { shiftKey: true });
      assert.equal(lit(view), 1, "Shift 再点同一个 = 减选");
    });
    test("框选之后 Delete 一次删掉整批", async () => {
      const { page, view } = await makePage();
      twoImages(view);
      fire(view.stage, "pointerdown", { clientX: 100, clientY: 100, button: 0, ctrlKey: true });
      fire(window, "pointermove", { clientX: 1150, clientY: 700 });
      fire(window, "pointerup", {});
      fire(window, "keydown", { key: "Delete", code: "Delete" });
      assert.equal(page.current().nodes.length, 0);
    });
  });


  describe("拖动节点与拖角缩放", () => {
    const addOne = (view, label) => {
      click(view.button(label));
      return view.nodeLayer.children[0].dataset.nodeId;
    };
    const dragCorner = (view, id, dx, dy) => {
      const corner = view.nodeEl(id).querySelector(".ns-canvas-resize-bottom-right");
      fire(corner, "pointerdown", { clientX: CENTER.x + 340, clientY: CENTER.y + 240, button: 0 });
      fire(window, "pointermove", { clientX: CENTER.x + 340 + dx, clientY: CENTER.y + 240 + dy });
      fire(window, "pointerup", {});
    };
    test("点住节点拖：屏幕位移按缩放换算成世界位移", async () => {
      const { view, page } = await makePage();
      const id = addOne(view, "加图片");
      fire(view.nodeEl(id), "pointerdown", { clientX: 770, clientY: 520, button: 0 });
      fire(window, "pointermove", { clientX: 870, clientY: 620 });
      assert.deepEqual(view.pos(), [[700, 500]]);
      fire(window, "pointerup", {});
      assert.equal(view.save.textContent, "未保存");
      assert.equal(page.current().nodes[0].position.x, 700);
    });
    test("缩到 50% 时鼠标走 100px 节点在世界上走 200 单位", async () => {
      const { view } = await makePage();
      const id = addOne(view, "加图片");
      // factor = 1.1^(-deltaY/100)：滚这么多正好把 k 落到 0.5
      fire(view.stage, "wheel", { clientX: CENTER.x, clientY: CENTER.y,
        deltaY: 100 * Math.LN2 / Math.log(1.1) });
      assert.equal(view.zoom.textContent, "50%");
      // 缩放锚在指针上：节点左上角落回屏幕 (600,400)，整张图缩成 170x120
      fire(view.nodeEl(id), "pointerdown", { clientX: 650, clientY: 450, button: 0 });
      fire(window, "pointermove", { clientX: 750, clientY: 450 });
      fire(window, "pointerup", {});
      assert.deepEqual(view.pos(), [[800, 400]]);
    });
    test("图片节点拖角锁比例", async () => {
      const { view, box } = await makePage();
      const id = addOne(view, "加图片");
      dragCorner(view, id, 100, 0);
      const { w, h, x, y } = box(id);
      assert.ok(Math.abs(w - 440) < 1e-6, `宽 ${w}`);
      assert.ok(Math.abs(h - 440 * 360 / 340) < 1e-6, `高 ${h} 要按 340:360 跟上`);
      assert.ok(Math.abs(x - CENTER.x) < 1e-6, `右下角拖时左上角 x 不动：${x}`);
      assert.ok(Math.abs(y - CENTER.y) < 1e-6, `右下角拖时左上角 y 不动：${y}`);
    });
    test("提示词节点拖角自由缩放（不锁比例）", async () => {
      const { view } = await makePage();
      const id = addOne(view, "加提示词");
      dragCorner(view, id, 100, 0);
      const { w, h } = view.box(id);
      assert.ok(Math.abs(w - 440) < 1e-6, `宽 ${w}`);
      assert.ok(Math.abs(h - 240) < 1e-6, `自由缩放的高不跟比例：${h}`);
    });
  });


  describe("收笔被接走的那一发：pointercancel、窗口失焦、原生拖拽", () => {
    const addImage = (view) => {
      click(view.button("加图片"));
      return view.nodeLayer.children[view.nodeLayer.children.length - 1].dataset.nodeId;
    };
    const twoImages = (view) => {
      addImage(view);
      addImage(view);
      return [...view.nodeLayer.children].map((el) => el.dataset.nodeId);
    };
    const litIds = (view) => [...view.nodeLayer.children]
      .filter((el) => el.classList.contains("ns-canvas-node-on")).map((el) => el.dataset.nodeId);

    test("拖节点中窗口失焦：挪出的落点收下，舞台手势态收掉，裸移动不再搬节点", async () => {
      const { view, pos } = await makePage();
      addImage(view);
      fire(view.nodeLayer.children[0], "pointerdown", { clientX: CENTER.x, clientY: CENTER.y, button: 0 });
      assert.ok(view.stage.classList.contains("ns-canvas-dragging"), "拖中的舞台挂让位态（style.css 那条 pointer-events）");
      fire(window, "pointermove", { clientX: CENTER.x + 60, clientY: CENTER.y + 40 });
      fire(window, "blur", {});   // 拖出窗口、切走窗口、原生菜单挡在中间：这一发的 pointerup 永远不会来
      assert.deepEqual(pos(), [[CENTER.x + 60, CENTER.y + 40]], "已经挪出的落点要收下");
      assert.ok(!view.stage.classList.contains("ns-canvas-dragging"), "失焦要把舞台手势态收掉");
      fire(window, "pointermove", { clientX: CENTER.x + 500, clientY: CENTER.y + 300 });
      assert.deepEqual(pos(), [[CENTER.x + 60, CENTER.y + 40]], "失焦之后的裸移动不许再搬节点");
      fire(view.nodeLayer.children[0], "pointerdown", { clientX: CENTER.x + 60, clientY: CENTER.y + 40, button: 0 });
      fire(window, "pointermove", { clientX: CENTER.x + 110, clientY: CENTER.y + 70 });
      assert.deepEqual(pos(), [[CENTER.x + 110, CENTER.y + 70]], "失焦之后画布照旧拖得动节点");
      fire(window, "pointerup", {});
    });

    test("pointercancel 收笔：那一按被系统手势接走之后不粘状态", async () => {
      const { view, pos } = await makePage();
      addImage(view);
      fire(view.nodeLayer.children[0], "pointerdown", { clientX: CENTER.x, clientY: CENTER.y, button: 0 });
      fire(window, "pointermove", { clientX: CENTER.x + 60, clientY: CENTER.y + 40 });
      fire(window, "pointercancel", {});
      assert.ok(!view.stage.classList.contains("ns-canvas-dragging"), "pointercancel 要把手势态收掉");
      fire(window, "pointermove", { clientX: CENTER.x + 400, clientY: CENTER.y });
      assert.deepEqual(pos(), [[CENTER.x + 60, CENTER.y + 40]], "被接走之后的裸移动不许再搬节点");
    });

    test("正文文本被浏览器拖出去：这一发就地收笔，节点不跟着光栅跑", async () => {
      const { view, pos } = await makePage();
      click(view.button("加提示词"));
      const ta = view.nodeLayer.querySelector("textarea");
      ta.focus();   // 编辑态里按下拖：选字与拖字归浏览器自己
      fire(ta, "pointerdown", { clientX: CENTER.x, clientY: CENTER.y, button: 0 });
      fire(window, "pointermove", { clientX: CENTER.x + 90, clientY: CENTER.y + 70 });
      assert.deepEqual(pos(), [[CENTER.x + 90, CENTER.y + 70]], "拖过一截就是拖节点");
      dragFire(ta, "dragstart", plainPayload("三段文字"));   // 文本拖出去：往后没有 pointerup
      assert.ok(!view.stage.classList.contains("ns-canvas-dragging"), "拖拽起手就把舞台手势态收掉");
      fire(window, "pointermove", { clientX: CENTER.x + 500, clientY: CENTER.y + 300 });
      assert.deepEqual(pos(), [[CENTER.x + 90, CENTER.y + 70]], "原生拖拽接走之后不许再搬节点");
    });
    test("框选途中失焦：框选框与 pointer-events 那一层一起收掉", async () => {
      const { view } = await makePage();
      twoImages(view);
      fire(view.stage, "pointerdown", { clientX: 100, clientY: 100, button: 0, ctrlKey: true });
      fire(window, "pointermove", { clientX: 1150, clientY: 700 });
      assert.ok(view.world.querySelector(".ns-canvas-marquee"), "起手要有框");
      fire(window, "blur", {});
      assert.ok(!view.world.querySelector(".ns-canvas-marquee"), "失焦要把框选框收掉");
      assert.ok(!view.stage.classList.contains("ns-canvas-marqueeing"),
        "失焦要把 pointer-events: none 那一层收掉 —— 留着就是整张画布按不动任何东西");
    });

    test("拉线中的源节点挂 ns-canvas-node-linking，松手摘掉", async () => {
      const { view } = await makePage();
      const [n1, n2] = twoImages(view);
      fire(nodeHandle(view, n1, "right"), "pointerdown", { clientX: 940, clientY: 520, button: 0 });
      assert.ok(view.nodeEl(n1).classList.contains("ns-canvas-node-linking"),
        "起手那一张挂让位态（四枚接线点的可见规则也认它）");
      assert.ok(!view.nodeEl(n2).classList.contains("ns-canvas-node-linking"), "只挂起手那一张");
      fire(window, "pointermove", { clientX: 1142, clientY: 520 });
  describe("视频卡面与操作栏固定抓手", () => {
    // 这一组吃视口 {0,0,1} 与舞台矩形原点 0,0：世界坐标与屏幕坐标同值，浏览器自绘播控那一条落在
    // 哪个 clientY 上就能直接写进断言（片面底 = y + height - 6，见 style.css 的 inset: 6px）
    const at = (x, y) => ({ x, y });
    const imageNode = (id, x, y) => ({ id, type: "image", title: "图片", position: at(x, y),
      width: 340, height: 240, metadata: { filename: `${id}.png` } });
    const videoNode = (id, x, y) => ({ id, type: "video", title: "视频", position: at(x, y),
      width: 320, height: 208, metadata: { filename: `片${id}.mp4` } });
    const videoPage = async (nodes) => {
      const ctx = await makePage(mockCanvas({ projects: [{ id: "canvas-0001", title: "甲",
        nodes, connections: [], viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" }] }));
      await settle();   // 首张画布落地才有节点
      return ctx;
    };
    const face = (view, id) => view.nodeEl(id).querySelector("video");
    const grab = (view, id) => view.nodeEl(id).querySelector(".ns-canvas-node-drag");

    test("视频卡面上起手：拖过那一截整张卡跟着走", async () => {
      const ctx = await videoPage([videoNode("v1", 100, 100)]);
      fire(face(ctx.view, "v1"), "pointerdown", { clientX: 200, clientY: 150, button: 0 });
      assert.ok(ctx.view.nodeEl("v1").classList.contains("ns-canvas-node-on"), "起手就是选中这一张");
      assert.deepEqual(ctx.pos(), [[100, 100]], "起手只选中，不动");
      fire(window, "pointermove", { clientX: 206, clientY: 150 });
      assert.deepEqual(ctx.pos(), [[100, 100]], "8px 那一截之内是浏览器在翻播放，节点不动");
      assert.ok(!ctx.view.stage.classList.contains("ns-canvas-dragging"),
        "没真拖起来就不压内容面 —— 压了这一发的 click 就落不到 video 上");
      fire(window, "pointermove", { clientX: 220, clientY: 172 });
      assert.deepEqual(ctx.pos(), [[120, 122]]);
      assert.ok(ctx.view.stage.classList.contains("ns-canvas-dragging"), "真拖起来了，内容面才让位");
      fire(window, "pointerup", { clientX: 220, clientY: 172 });
      assert.deepEqual(ctx.page.current().nodes.find((n) => n.id === "v1").position, { x: 120, y: 122 });
    });

    test("视频卡面点一下只翻播放：节点不挪，也不进撤销栈", async () => {
      const ctx = await videoPage([videoNode("v1", 100, 100)]);
      fire(face(ctx.view, "v1"), "pointerdown", { clientX: 200, clientY: 150, button: 0 });
      fire(window, "pointermove", { clientX: 204, clientY: 153 });
      fire(window, "pointerup", { clientX: 204, clientY: 153 });
      assert.deepEqual(ctx.pos(), [[100, 100]]);
      assert.ok(!ctx.view.stage.classList.contains("ns-canvas-dragging"));
      fire(document, "keydown", { key: "z", ctrlKey: true });   // 撤一发：撤销栈里没有这一按
      assert.deepEqual(ctx.pos(), [[100, 100]], "点一下卡不算一次改动，撤销撤不动它");
    });

    test("底部那一条播控上起手：拖的是进度条，节点不跟着走", async () => {
      const ctx = await videoPage([videoNode("v1", 100, 100)]);
      // 片面 106..302，浏览器自绘播控占底上 36px（缩 1 时）：266 以下是 seek / 音量 / 全屏那一行
      fire(face(ctx.view, "v1"), "pointerdown", { clientX: 200, clientY: 290, button: 0 });
      fire(window, "pointermove", { clientX: 240, clientY: 290 });
      fire(window, "pointerup", { clientX: 240, clientY: 290 });
      assert.deepEqual(ctx.pos(), [[100, 100]], "播控那一行上起手不拖节点，整条交浏览器 seek");
      assert.ok(ctx.view.nodeEl("v1").classList.contains("ns-canvas-node-on"), "按完还是要选中这一张");
      fire(face(ctx.view, "v1"), "pointerdown", { clientX: 200, clientY: 250, button: 0 });
      fire(window, "pointermove", { clientX: 220, clientY: 250 });
      fire(window, "pointerup", { clientX: 220, clientY: 250 });
      assert.deepEqual(ctx.pos(), [[120, 100]], "同一张卡上面那一截照旧拖得动");
    });

    test("操作栏首那枚固定抓手：是 span，按下就拖，视频卡也有这一枚", async () => {
      const ctx = await videoPage([imageNode("i1", 0, 0), videoNode("v1", 100, 100)]);
      const handle = grab(ctx.view, "v1");
      assert.ok(handle, "视频卡的操作栏首挂着这一枚固定抓手");
      assert.equal(handle.tagName, "SPAN");
      assert.ok(handle.querySelector("svg"), "抓手是一枚图标，不是一段空白");
      fire(handle, "pointerdown", { clientX: 120, clientY: 60, button: 0 });
      assert.ok(ctx.view.stage.classList.contains("ns-canvas-dragging"), "这一枚不吃那一截，起手就拖");
      fire(window, "pointermove", { clientX: 140, clientY: 90 });
      assert.deepEqual(ctx.pos(), [[0, 0], [120, 130]], "拖的是视频卡自己");
      fire(window, "pointerup", { clientX: 140, clientY: 90 });
    });

    test("多张卡一起选中时，抓手拖走整组", async () => {
      const ctx = await videoPage([imageNode("i1", 0, 0), videoNode("v1", 100, 100)]);
      fire(ctx.view.stage, "pointerdown", { clientX: 10, clientY: 10, button: 0, ctrlKey: true });
      fire(window, "pointermove", { clientX: 500, clientY: 400 });
      fire(window, "pointerup", {});
      assert.deepEqual(ctx.pos(), [[0, 0], [100, 100]], "框选两张，两张都在选中集里");
      fire(grab(ctx.view, "i1"), "pointerdown", { clientX: 50, clientY: 50, button: 0 });
      fire(window, "pointermove", { clientX: 70, clientY: 60 });
      assert.deepEqual(ctx.pos(), [[20, 10], [120, 110]], "拖一张就是拖这一组");
      fire(window, "pointerup", { clientX: 70, clientY: 60 });
    });

    test("固定抓手不在节点控件那一列里，也不在让位列里", () => {
      const gestures = fs.readFileSync(path.join(webDir, "studio/pages/canvas/interactions.js"), "utf8");
      const ctlBlock = gestures.match(/const NODE_CTL_SELECTOR = ([\s\S]*?);/)[1];
      assert.ok(!ctlBlock.includes("ns-canvas-node-drag"),
        "抓手进了控件列就只剩 click，按下永远拖不动");
      const bar = fs.readFileSync(path.join(webDir, "studio/pages/canvas/nodes.js"), "utf8");
      assert.match(bar, /\$el\("span", \{ className: "ns-canvas-node-drag"/);
    });
  });

      fire(window, "pointerup", {});
      await settle();
      assert.ok(!view.nodeEl(n1).classList.contains("ns-canvas-node-linking"), "松手要摘掉");
    });

    test("拖角缩放中的节点挂 ns-canvas-node-resizing，松手摘掉", async () => {
      const { view } = await makePage();
      const id = addImage(view);
      fire(view.nodeEl(id).querySelector(".ns-canvas-resize-bottom-right"), "pointerdown",
        { clientX: CENTER.x + 340, clientY: CENTER.y + 240, button: 0 });
      assert.ok(view.nodeEl(id).classList.contains("ns-canvas-node-resizing"), "缩放中的节点里的正文与图片要让位");
      fire(window, "pointermove", { clientX: CENTER.x + 400, clientY: CENTER.y + 300 });
      fire(window, "pointerup", {});
      assert.ok(!view.nodeEl(id).classList.contains("ns-canvas-node-resizing"), "松手要摘掉");
    });

    test("按在节点动作钮上就是选中这一张，起手不拖节点", async () => {
      const { view, pos } = await makePage();
      const [n1, n2] = twoImages(view);
      selectNode(view, n1);
      assert.deepEqual(litIds(view), [n1]);
      fire(view.nodeEl(n2).querySelector(".ns-canvas-node-act"), "pointerdown", { clientX: 900, clientY: 400, button: 0 });
      assert.deepEqual(litIds(view), [n2], "按在第二张的动作钮上就是选中第二张");
      fire(window, "pointermove", { clientX: 1000, clientY: 500 });
      assert.deepEqual(pos(), [[CENTER.x, CENTER.y], [CENTER.x + STEP_X, CENTER.y]], "控件那一片起手不拖节点");
      fire(window, "pointerup", {});
    });

    test("让位那一层 CSS 认的就是这几个类，只让节点里的内容面让位", async () => {
      const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
      const faces = ".ns-canvas-node-textarea, .ns-canvas-node-img, .ns-canvas-node-video-el, "
        + ".ns-canvas-node-audio-body, .ns-canvas-gen, .ns-canvas-car";
      const scoped = (cls) => css.includes(`.${cls} :is(${faces})`);
      assert.ok(scoped("ns-canvas-dragging") && scoped("ns-canvas-marqueeing")
          && scoped("ns-canvas-node-resizing") && scoped("ns-canvas-node-linking"),
        "让位的四个类就是 interactions.js 真挂的那四个，认的层必须是节点里那几张内容面");
      assert.ok(!/^\.ns-canvas-dragging[^\n]*\{ pointer-events: none; \}/m.test(css),
        "pointer-events 不许落在舞台自己身上：双击正文那第二下按完整张画布按不动，dblclick 落不到正文框，四角尺寸柄与接线点也一起没了");
    });

    test("光标在正文里时点节点外那一按交浏览器：焦点换走才出得了编辑", async () => {
      const { view } = await makePage(mockCanvas());
      click(view.button("加提示词"));
      await settle();
      const ta = view.nodeLayer.querySelector("textarea");
      const pressDown = (el, x, y) => {
        const ev = new window.PointerEvent("pointerdown",
          { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
        el.dispatchEvent(ev);
        return ev;
      };
      ta.focus();
      assert.ok(!pressDown(view.stage, 20, 20).defaultPrevented,
        "点空白那一按不许拦：拦下 pointerdown 连焦点交接给空白一起拦了，blur 不来就一直出不了编辑");
      ta.focus();
      const card = view.nodeLayer.querySelector(".ns-canvas-node");
      assert.ok(!pressDown(card, parseFloat(card.style.left) + 10, parseFloat(card.style.top) + 10).defaultPrevented,
        "点在节点上那一按照样把焦点交接给浏览器");
      ta.blur();
      assert.ok(pressDown(view.stage, 20, 20).defaultPrevented,
        "光标不在正文里时那一按照样要拦：拖动的选字与焦点抢占归浏览器");
      fire(window, "pointerup", {});
    });


    test("卡上正文不可选：按下拖拖的是这一张节点，不是浏览器选字", async () => {
      const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
      assert.match(css, /\.ns-canvas-node \{[^}]*user-select: none; \}/, "节点整体要禁选，否则拖一张卡就是在选它的正文");
      const lift = css.match(/\.ns-canvas-node-textarea, \.ns-canvas-recipe-seed \{ user-select: text; \}/);
      assert.ok(lift, "正文编辑框与种子输入要抬回可选");
      assert.ok(!/\.ns-canvas-gen-ctl[^\n]*user-select: text/.test(css),
        "整列控件行（.ns-canvas-gen-ctl 含配方概览与提示词行）不能整片抬回可选，那等于把正文选回来");
      assert.ok(css.indexOf(".ns-canvas-node {") < css.indexOf(lift[0]),
        "抬回可选那条写在禁选之后才压得住继承（同特异度看先后）");
    });

  });



  describe("视口：缩放、平移、网格、背景", () => {
    test("滚轮以指针为锚缩放，缩放标签跟着写", async () => {
      const { view, page } = await makePage();
      fire(view.stage, "wheel", { clientX: 300, clientY: 250, deltaY: -100 });
      const vp = page.current().viewport;
      assert.ok(Math.abs(vp.k - 1.1) < 1e-9, "一格滚轮 = 1.1 倍");
      assert.ok(Math.abs(vp.x - 300 * (1 - vp.k)) < 1e-6);
      assert.ok(Math.abs(vp.y - 250 * (1 - vp.k)) < 1e-6);
      assert.equal(view.zoom.textContent, `${Math.round(vp.k * 100)}%`);
    });
    test("缩到上下限就钉住", async () => {
      const { view, page } = await makePage();
      for (let i = 0; i < 40; i += 1) fire(view.stage, "wheel", { clientX: 100, clientY: 100, deltaY: -400 });
      assert.equal(page.current().viewport.k, 5);
      for (let i = 0; i < 80; i += 1) fire(view.stage, "wheel", { clientX: 100, clientY: 100, deltaY: 400 });
      assert.equal(page.current().viewport.k, 0.05);
    });
    test("平移视口：拖一下平移多少写多少", async () => {
      const { view, page } = await makePage();
      fire(view.stage, "pointerdown", { clientX: CENTER.x, clientY: CENTER.y, button: 1 });
      fire(window, "pointermove", { clientX: CENTER.x + 90, clientY: CENTER.y - 40 });
      fire(window, "pointerup", {});
      assert.deepEqual(page.current().viewport, { x: 90, y: -40, k: 1 });
      assert.ok(view.grid.style.backgroundSize.startsWith("48px"), "1 倍缩放格距 48");
      assert.equal(view.grid.style.backgroundPosition, "42px -40px", "网格原点取模跟着画面走");
    });
    test("空格按住拖 = 平移，节点不动", async () => {
      const { view, page, pos } = await makePage();
      click(view.button("加图片"));
      const before = pos();
      fire(window, "keydown", { key: " ", code: "Space" });
      fire(view.stage, "pointerdown", { clientX: 400, clientY: 300, button: 0 });
      fire(window, "pointermove", { clientX: 480, clientY: 300 });
      fire(window, "pointerup", {});
      fire(window, "keyup", { key: " ", code: "Space" });
      assert.deepEqual(page.current().viewport, { x: 80, y: 0, k: 1 });
      assert.deepEqual(pos(), before);
    });
    test("中键拖 = 平移，空白那一拖 = 平移（默认就是拖动）", async () => {
      const { view, page } = await makePage();
      fire(view.stage, "pointerdown", { clientX: 100, clientY: 100, button: 1 });
      fire(window, "pointermove", { clientX: 150, clientY: 110 });
      fire(window, "pointerup", {});
      assert.deepEqual(page.current().viewport, { x: 50, y: 10, k: 1 });
      fire(view.stage, "pointerdown", { clientX: 100, clientY: 100, button: 0 });
      fire(window, "pointermove", { clientX: 120, clientY: 100 });
      fire(window, "pointerup", {});
      assert.deepEqual(page.current().viewport, { x: 70, y: 10, k: 1 }, "左键在空白那一拖就是平移，与 ComfyUI 同一手感");
    });
    test("触屏那一拖 = 平移，不许画框", async () => {
      const { view, page } = await makePage();
      click(view.button("加图片"));
      fire(view.stage, "pointerdown", { clientX: 300, clientY: 250, button: 0, pointerType: "touch" });
      fire(window, "pointermove", { clientX: 380, clientY: 300, pointerType: "touch" });
      fire(window, "pointerup", { pointerType: "touch" });
      assert.deepEqual(page.current().viewport, { x: 80, y: 50, k: 1 }, "触屏那一拖要挪得动画面");
      assert.ok(!view.world.querySelector(".ns-canvas-marquee"), "触屏不许画框");
    });
    test("Ctrl 空白处起手拖 = 框选，画面与节点都不动", async () => {
      const { view, page, pos } = await makePage();
      click(view.button("加图片"));
      const before = pos();
      fire(view.stage, "pointerdown", { clientX: 300, clientY: 250, button: 0, ctrlKey: true });
      fire(window, "pointermove", { clientX: 700, clientY: 500 });
      fire(window, "pointerup", {});
      assert.deepEqual(page.current().viewport, { x: 0, y: 0, k: 1 }, "框选不许挪画面");
      assert.deepEqual(pos(), before, "框选不许把节点挪走");
      assert.equal(lit(view), 1, "框罩到的那一张亮起来");
    });
    test("空白处起手拖 = 平移画面：节点世界位置不动，也不画框", async () => {
      const { view, page, pos } = await makePage();
      click(view.button("加图片"));
      selectNode(view, view.nodeLayer.children[0].dataset.nodeId);
      const before = pos();
      fire(view.stage, "pointerdown", { clientX: 300, clientY: 250, button: 0 });
      fire(window, "pointermove", { clientX: 700, clientY: 500 });
      fire(window, "pointerup", {});
      assert.deepEqual(page.current().viewport, { x: 400, y: 250, k: 1 }, "默认那一拖就是平移画面");
      assert.deepEqual(pos(), before, "平移不许把节点挪走");
      assert.ok(!view.world.querySelector(".ns-canvas-marquee"), "平移那一拖不画框");
      assert.equal(lit(view), 1, "拖开了就是平移，选中集不动");
    });
    test("空白处点一下（没拖开）收走选中", async () => {
      const { view, page } = await makePage();
      click(view.button("加图片"));
      selectNode(view, view.nodeLayer.children[0].dataset.nodeId);
      assert.equal(lit(view), 1);
      fire(view.stage, "pointerdown", { clientX: 300, clientY: 250, button: 0 });
      fire(window, "pointermove", { clientX: 302, clientY: 251 });   // 拖不过起手那一格就是点空白
      fire(window, "pointerup", {});
      assert.equal(lit(view), 0);
      assert.deepEqual(page.current().viewport, { x: 0, y: 0, k: 1 }, "点一下不许挪画面");
      assert.ok(!view.world.querySelector(".ns-canvas-marquee"), "点一下不留框");
    });
    test("适应内容把节点装进视口，四周留边且左右居中", async () => {
      const { view, page } = await makePage();
      click(view.button("加图片"));
      click(view.button("适应内容"));
      const { x, y, k } = page.current().viewport;
      assert.equal(view.zoom.textContent, "178%");
      const left = x + CENTER.x * k;                       // 节点左上角落到屏幕的位置
      const right = x + (CENTER.x + 340) * k;
      assert.ok(left > 80 - 1e-6 && STAGE.width - right > 80 - 1e-6, `两侧要留 80 边距：${left}/${right}`);
      assert.ok(Math.abs(left - (STAGE.width - right)) < 1e-6, "左右等边距");
      const top = y + CENTER.y * k, bottom = y + (CENTER.y + 360) * k;
      assert.ok(top > 80 - 1e-6 && STAGE.height - bottom > 80 - 1e-6, `上下留边距：${top}/${bottom}`);
    });
    test("空画布适应内容回到原点 100%", async () => {
      const { view, page } = await makePage();
      fire(view.stage, "wheel", { clientX: 300, clientY: 300, deltaY: -300 });
      click(view.button("适应内容"));
      assert.deepEqual(page.current().viewport, { x: STAGE.width / 2, y: STAGE.height / 2, k: 1 });
      assert.equal(view.world.style.transform, `translate(${STAGE.width / 2}px, ${STAGE.height / 2}px) scale(1)`);
      assert.equal(view.zoom.textContent, "100%");
    });
    test("背景循环 圆点→线→无→圆点", async () => {
      const { view, page } = await makePage();
      const modes = [];
      for (let i = 0; i < 3; i += 1) {
        click(view.button("背景"));
        modes.push(page.current().backgroundMode);
      }
      assert.deepEqual(modes, ["lines", "blank", "dots"]);
    });
  });


  describe("加图片与节点头部动作", () => {
    test("「加图片」开素材弹窗：弹窗交回图之前不铺节点", async () => {
      const pk = picker();
      const { view } = await makePage(mockCanvas(), pk);
      click(view.button("加图片"));
      assert.equal(pk.calls.length, 1, "点「加图片」要开一次素材库弹窗");
      assert.equal(view.nodeLayer.children.length, 0, "没取到图之前不铺节点");
    });

    test("取到的图铺成图片节点：带 filename 走 Gallery 缩略图", async () => {
      const pk = picker();
      const { view, page } = await makePage(mockCanvas(), pk);
      click(view.button("加图片"));
      pk.calls[0]([{ filename: "a.png", subfolder: "neo_gen/x" }, { filename: "b.png", subfolder: "" }]);
      await settle();
      assert.deepEqual(page.current().nodes.map((n) => n.metadata.filename), ["a.png", "b.png"]);
      const src = [...view.nodeLayer.children].map((el) => el.querySelector("img").src);
      assert.ok(src[0].includes("/neo_gallery/thumbnail") && src[0].includes("a.png") && src[0].includes("neo_gen%2Fx"), src[0]);
      assert.ok(src[1].includes("b.png"), src[1]);
      assert.ok(!src[0].includes("placeholder"), "填上图的节点不该还站在占位图上");
    });

    test("素材弹窗空手回来时说「没有选中的图」，不铺节点", async () => {
      const pk = picker();
      const { view, env } = await makePage(mockCanvas(), pk);
      click(view.button("加图片"));
      pk.calls[0]([]);
      await settle();
      assert.ok(toastOf(env).some((m) => m.includes("没有选中的图")));
      assert.equal(view.nodeLayer.children.length, 0);
    });

    test("空图片节点出「选图」：取到的那一张填这一张，落盘带 filename", async () => {
      const pk = picker();
      const { view, page, env } = await makePage(PAIR_WITH_LINK(), pk);
      click(nodeAct(view, "n-b", "pick"));
      assert.equal(pk.calls.length, 1);
      assert.equal(pk.kinds[0], "image", "图片节点开的那扇只收图");
      pk.calls[0]([{ filename: "picked.png", subfolder: "neo_gen/p" }]);
      await settle();
      const node = page.current().nodes.find((n) => n.id === "n-b");
      assert.deepEqual([node.metadata.filename, node.metadata.subfolder], ["picked.png", "neo_gen/p"]);
      assert.ok(view.nodeEl("n-b").querySelector("img").src.includes("picked.png"));
      assert.equal(nodeAct(view, "n-b", "pick")?.getAttribute("aria-label"), "换图",
        "填上图之后这一枚换成「换图」：图必须还能换");
      page.flush();
      await settle();
      assert.equal(env.store.saved[0].nodes.find((n) => n.id === "n-b").metadata.filename, "picked.png");
    });

    test("配方素材节点换一张：配方那一份出处一起收掉，卡面跟着换", async () => {
      const pk = picker();
      const { view, page } = await makePage(mockCanvas({ projects: [
        { id: "canvas-0001", title: "甲", nodes: [
          { id: "m1", type: "image", title: "素材", position: { x: 0, y: 0 }, width: 240, height: 160,
            metadata: { asset: "角色设定.png", recipe: "短片配方" } }],
          connections: [], viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" }] }), pk);
      assert.ok(view.nodeEl("m1").querySelector("img").src.includes("/rs_recipes/thumbnail"),
        "配方里的素材走配方那两条路由");
      click(nodeAct(view, "m1", "pick"));
      pk.calls[0]([{ filename: "new.png", subfolder: "neo_gen/x" }]);
      await settle();
      const node = page.current().nodes.find((n) => n.id === "m1");
      assert.deepEqual([node.metadata.filename, node.metadata.asset, node.metadata.recipe],
        ["new.png", null, null], "换了素材库的一张，配方那一份出处要一起收掉");
      assert.ok(view.nodeEl("m1").querySelector("img").src.includes("/neo_gallery/thumbnail"),
        "卡面播的就是换上去的那一张，不是配方里那一张");
      loadSize(view.nodeEl("m1").querySelector("img"), 900, 1600);
      assert.deepEqual([view.box("m1").w, view.box("m1").h], [240, 160],
        "串联铺出来的那一格不换框：网格步长与串联行距全按它算");
    });

    test("换图之后框按新那一张的比例重落：旧的横竖比例不留着", async () => {
      const pk = picker();
      const { view, page, env } = await makePage(mockCanvas({ projects: [
        { id: "canvas-0001", title: "甲", nodes: [
          { id: "n-a", type: "image", title: "图", position: { x: 0, y: 0 }, width: 340, height: 191,
            metadata: { filename: "wide.png", subfolder: "" } }],
          connections: [], viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" }] }), pk);
      assert.deepEqual([view.box("n-a").w, view.box("n-a").h], [340, 191], "起手是一张按横图落过位的框");
      click(nodeAct(view, "n-a", "pick"));
      pk.calls[0]([{ filename: "tall.png", subfolder: "" }]);
      await settle();
      loadSize(view.nodeEl("n-a").querySelector("img"), 900, 1600);
      assert.deepEqual([view.box("n-a").w, view.box("n-a").h], [203, 360],
        "换上去的竖图读出来就按它自己的比例重铺，object-fit 不再裁掉一截");
      page.flush();
      await settle();
      const saved = env.store.saved[0].nodes.find((n) => n.id === "n-a");
      assert.deepEqual([saved.width, saved.height], [203, 360], "重落的框要跟着这张画布存下去");
    });

    test("填好图的节点照样出那一枚（写「换图」）：选中那一排是停用 / 主图 / 换图 / 复制 / 删除", async () => {
      const { view } = await makePage(PAIR_WITH_LINK());
      assert.deepEqual(barActs(view, "n-a"), ["disable", "hero", "pick", "copy", "delete"],
        "填好图的这一张也留那一枚 —— 换不了图就是这条链断了");
      assert.equal(nodeAct(view, "n-a", "pick").getAttribute("aria-label"), "换图");
      assert.deepEqual(barActs(view, "n-b"), ["disable", "hero", "pick", "copy", "delete"],
        "没填图的这一张同一枚写「选图」");
      assert.equal(nodeAct(view, "n-b", "pick").getAttribute("aria-label"), "选图");
    });

    test("「加视频输入 / 加音频输入」按类型开素材库：取到的那一份落成对应的输入节点", async () => {
      const pk = picker();
      const { view, page, env } = await makePage(mockCanvas(), pk);
      click(view.button("加视频输入"));
      click(view.button("加音频输入"));
      assert.deepEqual(pk.kinds, ["video", "audio"], "素材库那一扇按这一类节点只收一类");
      pk.calls[0]([{ filename: "ref.mp4", subfolder: "neo_gen/v" }]);
      pk.calls[1]([{ filename: "voice.mp3", subfolder: "" }]);
      await settle();
      assert.deepEqual(page.current().nodes.map((n) => [n.type, n.metadata.filename, n.metadata.subfolder]),
        [["video_in", "ref.mp4", "neo_gen/v"], ["audio_in", "voice.mp3", ""]]);
      page.flush();
      await settle();
      assert.deepEqual(env.store.saved.at(-1).nodes.map((n) => [n.type, n.metadata.filename]),
        [["video_in", "ref.mp4"], ["audio_in", "voice.mp3"]], "两类输入节点照同一份形状落盘");
    });

    test("输入节点的卡面：视频整张是那一播（不静音），音频是播控加一行出处", async () => {
      const pk = picker();
      const { view, page } = await makePage(mockCanvas(), pk);
      click(view.button("加视频输入"));
      click(view.button("加音频输入"));
      pk.calls[0]([{ filename: "ref.mp4" }]);
      pk.calls[1]([{ filename: "voice.mp3" }]);
      await settle();
      const [vin, ain] = page.current().nodes;
      const video = view.nodeEl(vin.id).querySelector("video.ns-canvas-node-video-el");
      assert.ok(video.getAttribute("src").includes("/neo_gallery/video?filename=ref.mp4"), video.getAttribute("src"));
      assert.equal(video.hasAttribute("muted"), false, "参考片的声音要在画布上听得到");
      const audio = view.nodeEl(ain.id).querySelector("audio.ns-canvas-node-audio-el");
      assert.ok(audio.getAttribute("src").includes("/neo_gallery/audio?filename=voice.mp3"),
        audio.getAttribute("src"));
      assert.ok(!audio.getAttribute("src").includes("/neo_gallery/video"),
        "音频走音频那条流：视频那条按扩展名挡非视频，音频吃它永远播不出来");
      assert.equal(view.nodeEl(ain.id).querySelector(".ns-canvas-node-audio-name").textContent, "voice.mp3");
    });

    test("取到一段竖片时视频输入节点按片的比例落框：横框里不留一圈黑边", async () => {
      const pk = picker();
      const { view, page, env } = await makePage(mockCanvas(), pk);
      click(view.button("加视频输入"));
      pk.calls[0]([{ filename: "portrait.mp4", subfolder: "" }]);
      await settle();
      const vin = page.current().nodes[0];
      assert.deepEqual([view.box(vin.id).w, view.box(vin.id).h], [340, 360], "落点先站在默认那一档");
      loadVideoSize(view.nodeEl(vin.id).querySelector("video"), 720, 1280);
      assert.deepEqual([view.box(vin.id).w, view.box(vin.id).h], [203, 360],
        "那一段读出来是竖的，框就收窄成它的比例");
      page.flush();
      await settle();
      assert.deepEqual([env.store.saved.at(-1).nodes[0].width, env.store.saved.at(-1).nodes[0].height],
        [203, 360], "重落的框要跟着这张画布存下去");
    });

    test("视频输入换一段：旧框的比例不留着，按新那一段重落", async () => {
      const pk = picker();
      const { view, page } = await makePage(mockCanvas({ projects: [
        { id: "canvas-0001", title: "甲", nodes: [
          { id: "v1", type: "video_in", title: "视频输入", position: { x: 0, y: 0 }, width: 340, height: 191,
            metadata: { filename: "wide.mp4", subfolder: "" } }],
          connections: [], viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" }] }), pk);
      assert.deepEqual([view.box("v1").w, view.box("v1").h], [340, 191], "起手是一段横片落过的框");
      click(nodeAct(view, "v1", "pick"));
      pk.calls[0]([{ filename: "tall.mp4", subfolder: "" }]);
      await settle();
      loadVideoSize(view.nodeEl("v1").querySelector("video"), 720, 1280);
      assert.deepEqual([view.box("v1").w, view.box("v1").h], [203, 360],
        "换上去的那一段读出来是竖的，框跟着重铺");
    });

    test("空的输入节点说空位，栏上是「取用素材」；装配层没交弹窗时菜单落一张空输入节点", async () => {
      const { view, page } = await makePage(mockCanvas());
      click(view.button("加视频输入"));
      click(view.button("加音频输入"));
      await settle();
      const [vin, ain] = page.current().nodes;
      assert.deepEqual([vin.type, ain.type], ["video_in", "audio_in"]);
      assert.equal(view.nodeEl(vin.id).querySelector(".ns-canvas-node-video-empty").textContent, "空视频输入");
      assert.equal(view.nodeEl(ain.id).querySelector(".ns-canvas-node-video-empty").textContent, "空音频输入");
      assert.deepEqual(barActs(view, vin.id), ["disable", "pick", "copy", "delete"],
        "输入节点没有主图位，也没有提示词位");
      assert.equal(nodeAct(view, vin.id, "pick").getAttribute("aria-label"), "取用素材");
      assert.equal(nodeAct(view, ain.id, "pick").getAttribute("aria-label"), "取用素材");
    });

    test("从素材库拖进来的卡片按文件类型落节点：片落视频输入，声音落音频输入", async () => {
      const { view, page } = await makePage(mockCanvas());
      dragFire(view.stage, "drop", galleryPayload({ filename: "clip.mp4" }), { clientX: CENTER.x, clientY: CENTER.y });
      dragFire(view.stage, "drop", galleryPayload({ filename: "voice.mp3" }), { clientX: CENTER.x, clientY: CENTER.y });
      dragFire(view.stage, "drop", galleryPayload({ filename: "shot.png" }), { clientX: CENTER.x, clientY: CENTER.y });
      await settle();
      assert.deepEqual(page.current().nodes.map((n) => [n.type, n.metadata.filename]),
        [["video_in", "clip.mp4"], ["audio_in", "voice.mp3"], ["image", "shot.png"]],
        "把一段片落成图片节点，卡上就是一张读不出来的占位图");
    });

    test("选中就把那一排摆出来：停用 / 提示词 / 复制 / 删除，不留「进入编辑」", async () => {
      const { view, page } = await makePage(mockCanvas());
      click(view.button("加提示词"));
      await settle();
      const txt = page.current().nodes.find((n) => n.type === "text").id;
      assert.deepEqual(barActs(view, txt), ["disable", "prompt", "copy", "delete"],
        "正文节点的栏上有停用 / 提示词 / 复制 / 删除四枚");
      assert.ok(view.nodeEl(txt).querySelector("textarea"), "正文框还在：进编辑是双击它");
      assert.equal(view.nodeEl(txt).querySelector(".ns-canvas-node-hero"), null, "就一排，不铺第二排");
    });

    test("设为主图整片只留一枚，再点同一枚是取消", async () => {
      const { view, page } = await makePage(PAIR_WITH_LINK());
      click(nodeAct(view, "n-a", "hero"));
      assert.equal(page.current().nodes.find((n) => n.id === "n-a").metadata.hero, true);
      assert.ok(view.nodeEl("n-a").querySelector(".ns-canvas-node-tag").textContent.includes("主图"));
      click(nodeAct(view, "n-b", "hero"));
      assert.deepEqual(page.current().nodes.map((n) => n.metadata.hero === true), [false, true]);
      assert.equal([...view.nodeLayer.children].filter((el) => el.querySelector(".ns-canvas-node-act-on")).length, 1);
      click(nodeAct(view, "n-b", "hero"));
      assert.equal(page.current().nodes.find((n) => n.id === "n-b").metadata.hero, false);
      assert.equal([...view.nodeLayer.children].filter((el) => el.querySelector(".ns-canvas-node-act-on")).length, 0);
    });

    test("附加操作栏里的删除只删这一张，连带两端接上的线", async () => {
      const { view, page } = await makePage(PAIR_WITH_LINK());
      assert.equal(view.links.querySelectorAll(".ns-canvas-line").length, 1);
      fire(view.nodeEl("n-a"), "dblclick", {});
      click(nodeAct(view, "n-a", "delete"));
      await settle();
      assert.deepEqual(page.current().nodes.map((n) => n.id), ["n-b"]);
      assert.equal(page.current().connections.length, 0, "接在被删节点上的那条线要一起没了");
      assert.equal(view.links.querySelectorAll(".ns-canvas-line").length, 0);
    });

    test("附加操作栏上的钮起手不拖节点", async () => {
      const { view, pos } = await makePage(PAIR_WITH_LINK());
      const before = pos();
      fire(nodeAct(view, "n-a", "hero"), "pointerdown", { clientX: 180, clientY: 140, button: 0 });
      fire(window, "pointermove", { clientX: 320, clientY: 240 });
      fire(window, "pointerup", {});
      assert.deepEqual(pos(), before, "操作栏上的钮起手不能把整张节点拖走");
    });
  });

  describe("节点内容铺满与选中才出的操作栏", () => {
    test("节点没有标题栏：内容与操作栏直接住在节点里", async () => {
      const { view } = await makePage(PAIR_WITH_LINK());
      click(view.button("加提示词"));
      for (const el of [...view.nodeLayer.children]) {
        assert.equal(el.querySelector(".ns-canvas-node-head"), null, "节点不铺标题栏");
        assert.equal(el.querySelector(".ns-canvas-node-title"), null, "也不铺标题文字");
        assert.ok(el.children[0].matches(".ns-canvas-node-img, .ns-canvas-node-textarea"), "第一层就是内容");
      }
      for (const el of [...view.nodeLayer.children]) {
        assert.ok(el.querySelector(".ns-canvas-node-bar"), "每一张节点里都住着一排附加操作");
        assert.equal(el.querySelector(".ns-canvas-node-hero"), null, "选中那一排就一排");
      }
    });
    test("操作栏默认不出现，节点选中时那条 CSS 规则才把它铺出来", () => {
      const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
      assert.match(css, /\.ns-canvas-node-bar \{[^}]*display: none/);
      assert.match(css, /\.ns-canvas-node-on \.ns-canvas-node-bar \{ display: flex/);
      assert.match(css, /\.ns-canvas-node-img \{[^}]*inset: 0/);
      assert.match(css, /\.ns-canvas-node-textarea \{[^}]*inset: 0/);
    });
    test("接线点默认收着：悬停、选中与被拉线瞄着时 CSS 才把它亮出来", () => {
      const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
      assert.match(css, /\.ns-canvas-handle \{[^}]*opacity: 0/);
      assert.match(css, /\.ns-canvas-node:hover \.ns-canvas-handle[^{]*\{[^}]*opacity: 1/);
      assert.match(css, /\.ns-canvas-handle-top \{[^}]*top: -6px/);
      assert.match(css, /\.ns-canvas-handle-bottom \{[^}]*bottom: -6px/);
    });

    test("画布改名与删除收在面板行右端：指针与键盘落到那一行才亮，触屏档常显", () => {
      const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
      assert.match(css, /\.ns-canvas-project-row-act \{[^}]*opacity: 0[^}]*pointer-events: none/,
        "默认收着就不能按得中：只降透明度不改 pointer-events，看不见时那一枚还在原位等着误按");
      assert.match(css, /\.ns-canvas-project-row:hover \.ns-canvas-project-row-act[^{]*\{[^}]*opacity: 1/);
      assert.match(css, /\.ns-canvas-project-row:focus-within \.ns-canvas-project-row-act[^{]*\{[^}]*opacity: 1/,
        "键盘 Tab 进这一行也要亮：只认 hover 的话键盘用户永远碰不到改名与删除");
      assert.match(css, /@media \(hover: none\) \{ \.ns-canvas-project-row-act \{[^}]*opacity: 1/,
        "触屏没有 hover：收着就是按不到，这两枚在触屏档常显");
      assert.match(css, /\.ns-canvas-project-panel \{[^}]*position: fixed[^}]*z-index: 30/,
        "面板钉在视口坐标上：工具条横向滚动时不被裁掉");
    });

    test("主图徽标不住操作栏里：没选中也看得见那枚「主图」", async () => {
      const { view } = await makePage(PAIR_WITH_LINK());
      click(nodeAct(view, "n-a", "hero"));
      const tag = view.nodeEl("n-a").querySelector(".ns-canvas-node-tag");
      assert.ok(tag.textContent.includes("主图"));
      assert.ok(!tag.closest(".ns-canvas-node-bar"), "徽标不住在选中才出现的那一层里");
      assert.equal([...view.nodeLayer.children].filter((el) => el.querySelector(".ns-canvas-node-tag")).length, 1);
    });
    test("操作栏上的复制只复制这一张，选中落到副本上", async () => {
      const { view, page } = await makePage(PAIR_WITH_LINK());
      selectNode(view, "n-a");
      fire(view.nodeEl("n-a"), "dblclick", {});
      click(nodeAct(view, "n-a", "copy"));
      const copy = page.current().nodes.at(-1);
      assert.ok(copy.id !== "n-a", "副本是新 id");
      assert.deepEqual([copy.position.x, copy.position.y], [46, 56], "副本偏移 36 落在旁边");
      assert.equal(copy.metadata.filename, "a.png", "图坐标跟着副本走");
      assert.equal(lit(view), 1);
      assert.ok(view.nodeEl(copy.id).classList.contains("ns-canvas-node-on"), "选中要落到副本上");
    });
  });

  describe("提示词节点上的「提示词」", () => {
    /** 提示词浮层的两条读侧接口（/rs_prompts/*，与 prompt-service 同一口径） */
    const promptPool = (items) => {
      mockRoute("/rs_prompts/list_prompts", () => jsonResponse(items));
      mockRoute("/rs_prompts/load_prompt", (body) => jsonResponse({ text: `全文：${body.name}` }));
    };
    const pickerRows = () => [...document.querySelectorAll(".neo-preset-picker .rs-preset-item")];

    test("只有提示词节点那一排有「提示词」：车厢与图片节点都不带这一枚", async () => {
      const { view } = await makePage(STACKED_PAIR());
      assert.ok(nodeAct(view, "txt", "prompt"), "提示词节点要有这一枚");
      assert.equal(nodeAct(view, "car", "prompt"), null, "车厢的正文是配方那一段，不接词库");
    });
    test("点「提示词」开浮层：只列图像池，选一条把整段全文填进正文并落盘", async () => {
      const { page, view, env } = await makePage();
      promptPool([{ name: "地铁通勤", source: "presets" }, { name: "video/雨夜站台", source: "custom" }]);
      click(view.button("加提示词"));
      const id = page.current().nodes[0].id;
      const ta = view.nodeEl(id).querySelector("textarea");
      ta.value = "原来写的";
      fire(ta, "input");
      click(nodeAct(view, id, "prompt"));
      await settle();
      assert.deepEqual(pickerRows().map((el) => el.dataset.name), ["地铁通勤"], "浮层只列图像池那一条");
      click(pickerRows()[0]);
      await settle();
      assert.equal(view.nodeEl(id).querySelector("textarea").value, "全文：地铁通勤",
        "正文框里换的是整段全文，不是名字");
      assert.equal(page.current().nodes[0].metadata.content, "全文：地铁通勤", "正文落 metadata.content");
      assert.equal(document.querySelector(".neo-preset-picker"), null, "填完自己收窗");
      page.flush();
      const saved = env.store.saved.at(-1).nodes.find((n) => n.id === id);
      assert.equal(saved.metadata.content, "全文：地铁通勤", "填进去的正文跟着画布落盘");
    });
    test("ComfyUI 没在跑时浮层说要 ComfyUI，正文不动", async () => {
      const { page, view } = await makePage();
      mockRoute("/rs_prompts/list_prompts", () => jsonResponse({ offline: true, reason: "comfyui_not_running" }, 409));
      click(view.button("加提示词"));
      const id = page.current().nodes[0].id;
      click(nodeAct(view, id, "prompt"));
      await settle();
      assert.ok(document.querySelector(".neo-preset-picker .neo-preset-picker-empty")?.textContent.includes("需要 ComfyUI"),
        "离线那一发要点明来源，不能只写「暂无可用提示词」");
      assert.equal(page.current().nodes[0].metadata.content, undefined, "没有可填的正文时这一格不动");
      closePresetPicker();
    });
    test("填进去的正文撤销一次退回去：正文框与落盘一起回原样", async () => {
      const { page, view } = await makePage();
      promptPool([{ name: "地铁通勤", source: "presets" }]);
      click(view.button("加提示词"));
      const id = page.current().nodes[0].id;
      click(nodeAct(view, id, "prompt"));
      await settle();
      click(pickerRows()[0]);
      await settle();
      assert.equal(page.current().nodes[0].metadata.content, "全文：地铁通勤", "先确认填进去了");
      fire(window, "keydown", { key: "z", ctrlKey: true });
      assert.equal(page.current().nodes[0].metadata.content, undefined, "撤销一次退掉整段填入");
      assert.equal(view.nodeEl(id).querySelector("textarea").value, "", "正文框跟着回退");
    });
  });

  describe("撤销重做与复制", () => {
    const undo = () => fire(window, "keydown", { key: "z", ctrlKey: true });
    const redoShift = () => fire(window, "keydown", { key: "z", ctrlKey: true, shiftKey: true });
    const redoKey = () => fire(window, "keydown", { key: "y", ctrlKey: true });
    const copyKey = () => fire(window, "keydown", { key: "d", ctrlKey: true });
    const dragBy = (view, id, dx, dy) => {
      const el = view.nodeEl(id);
      const cx = parseFloat(el.style.left) + parseFloat(el.style.width) / 2;
      const cy = parseFloat(el.style.top) + parseFloat(el.style.height) / 2;
      fire(el, "pointerdown", { clientX: cx, clientY: cy, button: 0 });
      fire(window, "pointermove", { clientX: cx + dx, clientY: cy + dy });
      fire(window, "pointerup", {});
    };

    test("加一个节点：Ctrl+Z 退掉，Ctrl+Shift+Z 与 Ctrl+Y 都摆回来，回退要落盘", async () => {
      const { view, page, env } = await makePage();
      click(view.button("加提示词"));
      undo();
      assert.equal(page.current().nodes.length, 0);
      assert.equal(view.nodeLayer.children.length, 0, "退掉的节点要从节点层上摘下来");
      redoShift();
      assert.equal(page.current().nodes.length, 1, "Ctrl+Shift+Z 是重做");
      undo();
      redoKey();
      assert.equal(page.current().nodes.length, 1, "Ctrl+Y 同一条重做");
      page.flush();
      await settle();
      assert.equal(env.store.saved[0].nodes.length, 1, "撤销与重做都是一次改动：要落盘");
    });

    test("拖一段撤销一次就回原位（一次拖动只压一次栈）", async () => {
      const { view, pos } = await makePage(PAIR_WITH_LINK());
      const before = pos();
      dragBy(view, "n-a", 60, 80);
      assert.notDeepEqual(pos(), before);
      undo();
      assert.deepEqual(pos(), before);
      undo();
      assert.deepEqual(pos(), before, "没有下一次改动，撤销不重复吃同一次拖动");
    });

    test("删掉带连线的节点，撤销把节点与连线一起带回来", async () => {
      const { view, page } = await makePage(PAIR_WITH_LINK());
      fire(view.nodeEl("n-a"), "dblclick", {});
      click(nodeAct(view, "n-a", "delete"));
      assert.equal(page.current().connections.length, 0);
      undo();
      assert.deepEqual(page.current().nodes.map((n) => n.id), ["n-a", "n-b"]);
      assert.equal(page.current().connections.length, 1);
      assert.equal(page.current().nodes[0].metadata.filename, "a.png", "带回来的节点要带着素材坐标");
      assert.equal(view.links.querySelectorAll(".ns-canvas-line").length, 1);
    });

    test("撤销只回节点与连线，不动视口与背景", async () => {
      const { view, page } = await makePage(PAIR_WITH_LINK());
      click(view.button("加提示词"));
      fire(view.stage, "wheel", { clientX: 600, clientY: 400, deltaY: -120 });
      click(view.button("背景"));
      const viewport = { ...page.current().viewport };
      undo();
      assert.deepEqual(page.current().viewport, viewport, "撤销不该把用户脚下的那片画面拽走");
      assert.equal(page.current().nodes.length, 2, "加的那一个提示词节点要退掉");
    });
    test("正文连打一段，撤销一次退掉整段；正文框里的 Ctrl+Z 不抢", async () => {
      const { view, page } = await makePage();
      click(view.button("加提示词"));
      const ta = view.nodeLayer.querySelector("textarea");
      let typed = "";
      for (const text of ["三段", "文字", "啊"]) { typed += text; ta.value = typed; fire(ta, "input"); }
      assert.equal(page.current().nodes[0].metadata.content, "三段文字啊");
      ta.focus();
      const nodes = page.current().nodes.length;
      fire(window, "keydown", { key: "z", ctrlKey: true });
      assert.equal(page.current().nodes.length, nodes, "正文框里的 Ctrl+Z 归浏览器自己的文本撤销");
      ta.blur();
      undo();
      assert.equal(page.current().nodes[0].metadata.content ?? "", "", "撤销一次退掉整段连打，不是逐字退");
      assert.equal(view.nodeLayer.querySelector("textarea").value, "", "重画出来的正文框要跟着回");
    });

    test("Ctrl+D 复制选中：新 id、偏移 36 落在旁边，选中落到副本上", async () => {
      const { view, page } = await makePage(PAIR_WITH_LINK());
      selectNode(view, "n-a");
      copyKey();
      const nodes = page.current().nodes;
      assert.equal(nodes.length, 3);
      const copy = nodes[2];
      assert.ok(copy.id !== "n-a" && copy.id !== "n-b");
      assert.deepEqual([copy.position.x, copy.position.y], [10 + 36, 20 + 36]);
      assert.deepEqual([copy.type, copy.width, copy.height, copy.title], ["image", 340, 240, "图片"]);
      assert.equal(copy.metadata.filename, "a.png", "副本要带着素材坐标");
      assert.equal(lit(view), 1, "选中落到副本上");
      assert.ok(view.nodeEl(copy.id));
      undo();
      assert.equal(page.current().nodes.length, 2, "复制这一步也能撤销");
    });

    test("复制带上两端都在选中里的那条连线，跨出选中集的连线不带", async () => {
      const { view, page } = await makePage(PAIR_WITH_LINK());
      selectNode(view, "n-a");
      copyKey();
      const single = page.current().connections;
      assert.equal(single.length, 1, "只复制一张时原连线不该跟着多一条");
      assert.deepEqual([single[0].fromNodeId, single[0].toNodeId], ["n-a", "n-b"]);
      selectNode(view, "n-a");
      selectNode(view, "n-b", { shiftKey: true });
      copyKey();
      const conns = page.current().connections;
      assert.equal(conns.length, 2, "两端都在选中里的那条线跟着复制");
      assert.deepEqual([conns[1].fromNodeId, conns[1].toNodeId],
        page.current().nodes.slice(3).map((n) => n.id), "副本的连线只接副本自己");
      assert.equal(view.links.querySelectorAll(".ns-canvas-line").length, 2);
    });

    test("没选中就复制要说话；撤销与重做钮的灰态跟着栈走", async () => {
      const { view, env } = await makePage();
      const undoBtn = view.button("撤销"), redoBtn = view.button("重做");
      assert.ok(undoBtn.disabled && redoBtn.disabled, "没有改动时两枚都是灰的");
      copyKey();
      assert.ok(toastOf(env).some((m) => m.includes("先选中")));
      click(view.button("加提示词"));
      assert.equal(undoBtn.disabled, false, "有了改动撤销就要亮");
      assert.equal(redoBtn.disabled, true);
      undo();
      assert.equal(redoBtn.disabled, false, "撤销过就能重做");
      redoShift();
      assert.equal(undoBtn.disabled, false);
    });

    test("切画布清栈：上一张的撤销不倒进这一张", async () => {
      const { view, page } = await makePage(TWO_IMAGES());
      click(view.button("加提示词"));
      pickCanvas(view, "canvas-0002");
      await settle();
      assert.equal(page.current().nodes.length, 0);
      assert.equal(view.button("撤销").disabled, true, "切过来就是空栈");
      click(view.button("加提示词"));
      undo();
      assert.equal(page.current().nodes.length, 0, "只退这一张上的一步");
      pickCanvas(view, "canvas-0001");
      await settle();
      undo();
      assert.equal(page.current().nodes.length, 2, "列表里那 1 个节点 + 之前加的 1 个：甲的栈切走时已清");
    });
  });

  describe("剪贴板（Ctrl+C / Ctrl+X / Ctrl+V / Ctrl+A）", () => {
    const copyKey = () => fire(window, "keydown", { key: "c", ctrlKey: true });
    const cutKey = () => fire(window, "keydown", { key: "x", ctrlKey: true });
    const pasteKey = () => fire(window, "keydown", { key: "v", ctrlKey: true });
    const allKey = () => fire(window, "keydown", { key: "a", ctrlKey: true });
    const undoKey = () => fire(window, "keydown", { key: "z", ctrlKey: true });
    const pasted = (page) => page.current().nodes.at(-1);

    test("Ctrl+C 再 Ctrl+V：副本是新 id，整批落在看得见的中心，选中落到副本上", async () => {
      const { view, page } = await makePage(PAIR_WITH_LINK());
      selectNode(view, "n-a");
      copyKey();
      pasteKey();
      const nodes = page.current().nodes;
      assert.equal(nodes.length, 3);
      const out = pasted(page);
      assert.ok(out.id !== "n-a" && out.id !== "n-b", "粘贴出来的是新节点");
      assert.deepEqual([out.position.x, out.position.y], [CENTER.x - 170, CENTER.y - 120],
        "整批的中心对到视口中心");
      assert.equal(out.metadata.filename, "a.png", "副本带着素材坐标");
      assert.equal(lit(view), 1, "选中落到粘贴出来的那一批上");
      assert.ok(view.nodeEl(out.id), "粘贴出来的节点要立刻画在节点层上");
      undoKey();
      assert.equal(page.current().nodes.length, 2, "粘贴这一步也能撤销");
    });

    test("连按 Ctrl+V 一次比一批往右下让 36", async () => {
      const { view, page } = await makePage(PAIR_WITH_LINK());
      selectNode(view, "n-a");
      copyKey();
      pasteKey();
      const first = { ...pasted(page).position };
      pasteKey();
      const second = { ...pasted(page).position };
      assert.deepEqual([second.x - first.x, second.y - first.y], [36, 36]);
      assert.equal(page.current().nodes.length, 4);
    });

    test("剪贴板带着那批内部的连线，粘回来只接副本自己", async () => {
      const { view, page } = await makePage(PAIR_WITH_LINK());
      selectNode(view, "n-a");
      selectNode(view, "n-b", { shiftKey: true });
      copyKey();
      pasteKey();
      const conns = page.current().connections;
      assert.equal(conns.length, 2, "两条都在选中里的那条线跟着一起粘回来");
      assert.deepEqual([conns[1].fromNodeId, conns[1].toNodeId],
        page.current().nodes.slice(2).map((n) => n.id), "副本的连线只接副本自己");
      assert.equal(view.links.querySelectorAll(".ns-canvas-line").length, 2);
    });

    test("Ctrl+X 剪掉原节点，Ctrl+V 再粘回来，撤销把剪掉的那一张连线带回来", async () => {
      const { view, page } = await makePage(PAIR_WITH_LINK());
      selectNode(view, "n-a");
      cutKey();
      assert.deepEqual(page.current().nodes.map((n) => n.id), ["n-b"], "剪掉的节点要摘掉");
      assert.equal(page.current().connections.length, 0, "接在剪掉节点上的线一起摘");
      assert.equal(lit(view), 0, "剪完没有选中");
      pasteKey();
      assert.equal(page.current().nodes.length, 2);
      assert.ok(page.current().nodes.some((n) => n.id !== "n-b"), "粘回来的是新 id 那一张");
      undoKey();
      assert.deepEqual(page.current().nodes.map((n) => n.id), ["n-b"], "撤销粘贴回到剪完那一刻");
      assert.equal(page.current().connections.length, 0);
      undoKey();
      assert.deepEqual(page.current().nodes.map((n) => n.id), ["n-a", "n-b"]);
      assert.equal(page.current().connections.length, 1, "撤销把剪掉的连线一起带回来");
    });

    test("没选中就 Ctrl+C 要说话，空剪贴板 Ctrl+V 要说话", async () => {
      const { env, page } = await makePage();
      copyKey();
      pasteKey();
      assert.equal(page.current().nodes.length, 0, "两条都不该改动画布");
      const toasts = toastOf(env);
      assert.ok(toasts.some((m) => m.includes("先选中")), "没选中要说清楚");
      assert.ok(toasts.some((m) => m.includes("剪贴板是空的")), "空剪贴板要说清楚");
    });

    test("正文框里的 Ctrl+C 与 Ctrl+A 归浏览器，画布上的 Ctrl+A 是全选节点", async () => {
      const { view, env } = await makePage();
      click(view.button("加提示词"));
      click(view.button("加提示词"));
      const ta = view.nodeLayer.children[0].querySelector("textarea");
      fire(window, "keydown", { key: "Escape" });
      ta.focus();
      copyKey();
      allKey();
      assert.equal(lit(view), 0, "正文框里 Ctrl+A 不该把节点全选");
      assert.ok(!toastOf(env).some((m) => m.includes("已复制")), "正文框里 Ctrl+C 不该动节点");
      ta.blur();
      allKey();
      assert.equal(lit(view), 2, "画布上 Ctrl+A 是把节点全选");
    });

    test("装配层摘走这几键（document capture）之后，画布上的撤销与剪贴板键照旧生效", async () => {
      const { view, page } = await makePage(PAIR_WITH_LINK());
      // studio-app.js 的 initClipboardKeys 形状：document capture 上 stopImmediatePropagation，
      // 冒泡相位的 window 监听从此收不到事件
      const keys = new Set(["KeyC", "KeyV", "KeyX", "KeyA", "KeyZ", "KeyY"]);
      const swallow = (e) => { if ((e.ctrlKey || e.metaKey) && keys.has(e.code)) e.stopImmediatePropagation(); };
      document.addEventListener("keydown", swallow, true);
      try {
        const hit = (key) => fire(view.nodeEl("n-a"), "keydown", { key, code: `Key${key.toUpperCase()}`, ctrlKey: true });
        selectNode(view, "n-a");
        hit("c");
        hit("v");
        assert.equal(page.current().nodes.length, 3, "Ctrl+V 粘得动才有这一条");
        hit("z");
        assert.equal(page.current().nodes.length, 2, "Ctrl+Z 撤得动");
      } finally {
        document.removeEventListener("keydown", swallow, true);
      }
    });

    const evFire = (target, type, init = {}) => {
      const Ctor = type.startsWith("key") ? window.KeyboardEvent : window.MouseEvent;
      const ev = new Ctor(type, { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;   // 这一组要看 defaultPrevented，模块级那条 fire 不回事件
    };
    const addPrompt = (view) => click(view.button("加提示词"));
    const firstText = (view) => view.nodeLayer.children[0].querySelector("textarea");

    test("提示词节点：单击不落焦点，双击才进编辑，编辑态里的 mousedown 不拦", async () => {
      const { view } = await makePage();
      addPrompt(view);
      const ta = firstText(view);
      ta.blur();   // 新建那一张落在编辑态里，先出编辑（真窗口里就是点一下空白）
      assert.ok(evFire(ta, "mousedown").defaultPrevented, "没在编辑时那一发 mousedown 要拦掉焦点");
      assert.notEqual(document.activeElement, ta, "单击只选中节点，光标不进正文");
      fire(ta, "dblclick");
      // 双击同时浮出停用 / 复制 / 删除那一排，整层重画过一次：在编辑的是重画出来的那一块正文框
      const live = document.activeElement;
      assert.ok(live?.classList?.contains("ns-canvas-node-textarea"), "双击才是进编辑");
      assert.ok(!evFire(live, "mousedown").defaultPrevented, "编辑态里不拦，划词与光标动作照旧");
    });

    test("提示词节点用 Ctrl+C / Ctrl+V / Ctrl+X 走得通，副本带着那句提示词", async () => {
      const { view, page } = await makePage();
      addPrompt(view);
      const ta = firstText(view);
      ta.value = "一句提示词";
      fire(ta, "input");
      ta.blur();
      selectNode(view, page.current().nodes[0].id);
      copyKey();
      pasteKey();
      assert.equal(page.current().nodes.length, 2);
      assert.equal(pasted(page).metadata.content, "一句提示词", "副本带着正文");
      cutKey();
      assert.equal(page.current().nodes.length, 1, "Ctrl+X 剪掉副本");
      undoKey();
      assert.equal(page.current().nodes.length, 2, "撤销把剪掉的副本带回来");
    });

    test("编辑态按 Esc 出编辑，Ctrl+C 这才剪节点", async () => {
      const { view, page } = await makePage();
      addPrompt(view);
      const ta = firstText(view);
      ta.focus();
      fire(window, "keydown", { key: "Escape" });
      assert.notEqual(document.activeElement, ta, "Esc 要把光标从正文里收出来");
      selectNode(view, page.current().nodes[0].id);
      copyKey();
      pasteKey();
      assert.equal(page.current().nodes.length, 2, "出编辑之后粘得动");
    });

    test("光标在正文里按 Ctrl+C 要说出路，节点一个都不许动", async () => {
      const { view, env, page } = await makePage();
      addPrompt(view);
      firstText(view).focus();
      assert.ok(!evFire(window, "keydown", { key: "c", ctrlKey: true }).defaultPrevented,
        "浏览器自己的划词复制不许被拦");
      assert.ok(toastOf(env).some((m) => m.includes("Esc")), "要告诉用户怎么走回节点");
      assert.equal(page.current().nodes.length, 1, "这一发不许动节点");
    });
  });

  describe("落盘与画布项目", () => {
    test("改动攒着，切页 flush 落盘；没有改动不重复写", async () => {
      const { page, view, env } = await makePage();
      click(view.button("加图片"));
      assert.equal(env.store.saved.length, 0, "900ms 内不该抢跑写盘");
      page.flush();
      await settle();
      assert.equal(env.store.saved.length, 1);
      assert.equal(view.save.textContent, "已保存");
      page.flush();
      await settle();
      assert.equal(env.store.saved.length, 1, "没有改动就不重复写");
    });
    test("写不进去时说「保存失败」并留下改动", async () => {
      const { page, view, env } = await makePage(noFetch());
      click(view.button("加图片"));
      page.flush();
      await settle();
      assert.ok(toastOf(env).some((m) => m.includes("保存失败")));
      assert.equal(view.save.textContent, "保存失败");
    });
    test("新建画布：给名字就建一张空的，列表里选到这张新画布", async () => {
      const { page, view, env } = await makePage();
      dialogs.promptAnswer = "我的画布";
      click(view.button("新建画布"));
      await settle();
      assert.equal(env.store.saved.length, 1);
      assert.equal(env.store.saved[0].title, "我的画布");
      assert.equal(env.store.saved[0].nodes.length, 0);
      assert.equal(page.current().title, "我的画布");
      assert.equal(view.save.textContent, "已保存");
      assert.ok([...view.projectPanel.querySelectorAll(".ns-canvas-project-row-name")]
        .some((el) => el.textContent === "我的画布"),
      "新建的画布要出现在面板里，切走之后还得切得回来");
      assert.equal(view.projectPanel.querySelector(".ns-canvas-project-row-on").dataset.canvas, page.current().id);
    });
    test("画布面板：点开是一列画布，Esc 收回去", async () => {
      const { view } = await makePage(TWO_IMAGES());
      assert.equal(view.project.getAttribute("aria-expanded"), "false");
      click(view.project);
      assert.ok(view.projectPanel.classList.contains("ns-canvas-project-panel-open"));
      assert.equal(view.project.getAttribute("aria-expanded"), "true");
      assert.ok([...view.projectPanel.querySelectorAll(".ns-canvas-project-row-name")]
        .some((el) => el.textContent === "乙"), "面板里两张画布都在那一列里");
      fire(view.project, "keydown", { key: "Escape" });
      assert.equal(view.projectPanel.classList.contains("ns-canvas-project-panel-open"), false);
      assert.equal(view.project.getAttribute("aria-expanded"), "false");
    });
    test("面板里改别的画布的名字：这一张不动，那一行跟着改名", async () => {
      const { page, view, env } = await makePage(TWO_IMAGES());
      dialogs.promptAnswer = "改名乙";
      click(view.projectPanel.querySelector('[data-canvas="canvas-0002"] [aria-label="重命名"]'));
      await settle();
      assert.equal(env.store.renames[0].id, "canvas-0002");
      assert.equal(env.store.renames[0].title, "改名乙");
      assert.equal(page.current().title, "甲", "改的是那一行的画布，这一张的名字不跟着换");
      assert.ok([...view.projectPanel.querySelectorAll(".ns-canvas-project-row-name")]
        .some((el) => el.textContent === "改名乙"));
    });
    test("面板里删掉不是当前那张：这一张不动，列表少一行", async () => {
      const { page, view, env } = await makePage(TWO_IMAGES());
      setConfirmAnswer(true);
      click(view.projectPanel.querySelector('[data-canvas="canvas-0002"] [aria-label="删除画布"]'));
      await settle();
      assert.deepEqual(env.store.deleted.map((item) => item.id), ["canvas-0002"]);
      assert.equal(page.current().id, "canvas-0001", "删的是那一行，画面不换画布");
      assert.equal(env.store.projects.length, 1);
      assert.equal(view.projectPanel.querySelectorAll(".ns-canvas-project-row").length, 1);
    });
    test("重命名只动列表名字，节点与连线不碰", async () => {
      const { page, view, env } = await makePage();
      click(view.button("加图片"));
      page.flush();
      await settle();
      dialogs.promptAnswer = "改名后";
      click(view.button("重命名"));
      await settle();
      assert.equal(env.store.renames[0].id, "canvas-0001");
      assert.equal(env.store.renames[0].title, "改名后");
      assert.equal(page.current().title, "改名后");
      assert.equal(page.current().nodes.length, 1);
      assert.ok([...view.projectPanel.querySelectorAll(".ns-canvas-project-row-name")]
        .some((el) => el.textContent === "改名后"));
    });
    test("删除画布走单张真路由，删完加载下一张", async () => {
      const { view, env } = await makePage(TWO_IMAGES());
      assert.equal(view.projectPanel.querySelector(".ns-canvas-project-row-on").dataset.canvas, "canvas-0001");
      setConfirmAnswer(true);
      click(view.button("删除画布"));
      await settle();
      assert.equal(env.store.deleted.length, 1);
      assert.equal(env.store.deleted[0].id, "canvas-0001");
      assert.equal(view.projectPanel.querySelector(".ns-canvas-project-row-on").dataset.canvas, "canvas-0002");
      assert.equal(env.store.projects.length, 1);
    });
    test("删除取消就不动数据", async () => {
      const { view, env } = await makePage(TWO_IMAGES());
      setConfirmAnswer(false);
      click(view.button("删除画布"));
      await settle();
      assert.equal(env.store.deleted.length, 0);
      assert.equal(view.projectPanel.querySelector(".ns-canvas-project-row-on").dataset.canvas, "canvas-0001");
    });
    test("切画布先把未落盘的改动写进这一张，再读下一张", async () => {
      const { page, view, env } = await makePage(TWO_IMAGES());
      click(view.button("加图片"));
      pickCanvas(view, "canvas-0002");
      await settle();
      assert.equal(env.store.saved.length, 1);
      assert.equal(env.store.saved[0].id, "canvas-0001");
      assert.equal(env.store.saved[0].nodes.length, 2, "列表里那 1 个节点 + 新加的 1 个");
      assert.equal(page.current().id, "canvas-0002");
    });
    test("后端读不出画布时说「画布读不出来」，页面照样能铺", async () => {
      const env = mockCanvas({
        projects: [{ id: "canvas-0001", title: "甲", nodes: [], connections: [],
          viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" }],
        projectImpl: () => jsonResponse({ success: false, error: "画布文件坏了" }, 500),
      });
      const { view, page } = await makePage(env);
      assert.ok(toastOf(env).some((m) => m.includes("画布读不出来")));
      assert.ok(toastOf(env).some((m) => m.includes("画布文件坏了")), "toast 里要带上后端给的原因");
      assert.equal(view.nodeLayer.children.length, 0, "读不到就不铺假节点");
      click(view.button("加图片"));
      assert.equal(page.current().nodes.length, 1);
    });
    test("后端列表读不出来时页面照样能铺", async () => {
      const { view, page, env } = await makePage();
      mockRoute("/neo_canvas/list", () => jsonResponse({ success: false, error: "目录不可读" }, 500));
      click(view.button("加图片"));
      page.flush();
      await settle();
      assert.equal(page.current().nodes.length, 1);
      assert.equal(env.store.saved.length, 1);
    });
  });

  describe("生成节点与视频节点：出图链、出片链与写回", () => {
    /** 出图链那几条路由的内存替身：技能表、技能 config、缺模型预检（无清单 = 不挡）、提交、状态、取消 */
    const genRoutes = ({ skills, skillConfig, generateImpl } = {}) => ({
      "/rs_prompts/skills": () => jsonResponse(skills
        || [{ id: "image_gen", name: "出图", category: "image_gen", source: "preset", gen_image: true }]),
      "/neo_skill_models/check": () => jsonResponse({ success: true, check: { has_manifest: false } }),
      "/neo_image_gen/skill_config": () => jsonResponse(skillConfig
        || { default_ratio: "1:1", base_resolution: 1280, steps: 20 }),
      "/neo_image_gen/generate": () => generateImpl ? generateImpl()
        : jsonResponse({ task_id: "gen-1", status: "queued" }),
      "/neo_image_gen/status/*": () => jsonResponse({ task_id: "gen-1", status: "running", progress: { value: 1, max: 8 } }),
      "/neo_image_gen/cancel/*": () => jsonResponse({ success: true }),
    });
    const genNode = (id, x, y, meta = {}) => ({ id, type: "gen", title: "生成",
      position: { x, y }, width: 260, height: 168, metadata: { skill_id: "image_gen", ...meta } });
    const promptNode = (id, content) => ({ id, type: "text", title: "提示词",
      position: { x: -400, y: 0 }, width: 340, height: 240, metadata: { content } });
    const imageSlot = (id, x) => ({ id, type: "image", title: "图片",
      position: { x, y: 300 }, width: 340, height: 240, metadata: {} });
    const link = (from, to) => ({ id: `conn-${from}-${to}`, fromNodeId: from, toNodeId: to });
    const oneCanvas = (nodes, connections = []) => [{ id: "canvas-0001", title: "甲", nodes, connections,
      viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" }];
    async function genPage(nodes, connections, { gen = {}, extraHost = {}, routes = {} } = {}) {
      resetApiState();
      globalThis.localStorage?.removeItem("neo.canvas.skill");
      const env = mockCanvas({ projects: [...(nodes.length ? oneCanvas(nodes, connections) : []), ...(gen.canvases || [])] });
      env.starts = [];
      Object.assign(env.routes, genRoutes(gen), routes);
      const ctx = await makePage(env, { can: () => true, ...extraHost });
      await settle();   // 首张画布与技能列表都在 build 之后落地
      const genText = (id, part) => ctx.view.nodeEl(id)
        .querySelector(`.ns-canvas-gen-${part}`)?.textContent || "";
      const genBtn = (id, label) => [...ctx.view.nodeEl(id).querySelectorAll(".ns-canvas-gen-btn")]
        .find((btn) => btn.textContent.trim() === label);
      const chipLabelAt = (id, at) => [...ctx.view.nodeEl(id).querySelectorAll(".neo-gallery-gm-chip-label")]
        .map((el) => el.textContent)[at] || "";
      const chipAt = (id, at) => [...ctx.view.nodeEl(id).querySelectorAll(".neo-gallery-gm-chip-btn")][at];
      // 胶囊菜单浮在页面那一层（.ns-canvas-gen-menus）：世界层带 scale、节点裁剪自己的内容，菜单进那一层两头都吃亏
      const menu = () => ctx.host.querySelector(".ns-canvas-gen-menus .neo-gallery-gm-chip-menu");
      const pickChip = async (id, at, value) => {
        click(chipAt(id, at));
        await settle();
        click([...menu().querySelectorAll(".neo-gallery-gm-menu-item")].find((el) => el.textContent === value));
        await settle();
      };
      // 车厢卡独有的读法：那几行概览文本（段号是 .ns-canvas-car-seg，技能胶囊走上面那几条胶囊读法）
      const recipeText = (id, part) => ctx.view.nodeEl(id)
        .querySelector(`.ns-canvas-recipe-${part}`)?.textContent || "";
      // 画布上真连一条线：从右接线点拖到目标节点中间松手
      const linkNodes = (fromId, toId) => {
        const src = ctx.view.nodeEl(fromId), dst = ctx.view.nodeEl(toId);
        fire(nodeHandle(ctx.view, fromId, "right"), "pointerdown", {
          clientX: parseFloat(src.style.left) + parseFloat(src.style.width),
          clientY: parseFloat(src.style.top) + parseFloat(src.style.height) / 2, button: 0 });
        fire(window, "pointermove", {
          clientX: parseFloat(dst.style.left) + parseFloat(dst.style.width) / 2,
          clientY: parseFloat(dst.style.top) + parseFloat(dst.style.height) / 2 });
        fire(window, "pointerup", {});
      };
      return { ...ctx, env, genText, genBtn, chipLabelAt, chipAt, menu, pickChip,
        recipeText, linkNodes };
    }
    const genCalls = () => fetchLog.filter((c) => c.path === "/neo_image_gen/generate");
    const okImages = (n) => ({ task_id: "gen-1", status: "succeeded",
      images: Array.from({ length: n }, (_x, i) => ({ filename: `o${i + 1}.png`, subfolder: "" })) });
    const deepSettle = () => flush(60);   // 出图链比页面落盘多两跳：提交一发 + 兜底首拉

    // 画布上的出片链走视频页那两条后端链（/neo_video_gen/simple 与 /neo_video_gen/run_segment）：
    // 路由按真接口的形状给 —— 提交回 task_id，状态快照带 progress 与 filename/subfolder，取消在同一层 /cancel
    const videoSkills = () => ([
      { id: "image_gen", name: "出图", category: "image_gen", source: "preset", gen_image: true },
      { id: "h3_t2v", name: "文生视频", category: "gen_video", source: "preset", gen_video: true, mode: "t2v" },
      { id: "h3_i2v", name: "图生视频", category: "gen_video", source: "preset", gen_video: true,
        mode: "i2v", requires_ref: true },
      { id: "h3_r2v", name: "参考生视频", category: "gen_video", source: "preset", gen_video: true,
        mode: "r2v", requires_ref: true, gen_config: { ref_kinds: ["image", "video", "audio"] } },
    ]);
    const RECIPE_ROW = { name: "短片配方", title: "短片", source: "mine", type: "video_director",
      canvas_id: "", shared: { mode: "i2v", width: 1344, height: 768 },
      segments: [{ title: "开场", skill_id: "h3_t2v", duration_sec: 5, prompt: "开场那一段的提示词",
        first_frame: "开场首帧.png", refs: { images: ["角色设定.png"] } },
        { title: "收尾", skill_id: "h3_t2v", duration_sec: 8, refs: { videos: ["收尾参考.mp4"] } }] };
    // 七段配方：没有参考素材，每一列就是一张厢的宽，专门用来量「几厢一行」的摆位
    const SEVEN_ROW = { name: "七段配方", title: "七段", source: "mine", type: "video_director",
      canvas_id: "", shared: { mode: "i2v", width: 1344, height: 768 },
      segments: Array.from({ length: 7 }, (_s, i) => ({ title: `第${i + 1}段`,
        skill_id: "h3_t2v", duration_sec: 5, prompt: `第${i + 1}段正文` })) };
    const clipRoutes = ({ snaps = [{ success: true, task_id: "clip-1", status: "succeeded",
      filename: "o.mp4", subfolder: "sub" }], recipes = [RECIPE_ROW] } = {}) => {
      let at = 0;
      return {
        "/rs_prompts/skills": () => jsonResponse(videoSkills()),
        "/rs_recipes/list": () => jsonResponse(recipes),
        "/neo_video_gen/simple": () => jsonResponse({ success: true, task_id: "clip-1", status: "queued" }),
        "/neo_video_gen/simple/*": (body, call) => call.method === "POST"
          ? jsonResponse({ success: true })
          : jsonResponse(snaps[Math.min(at++, snaps.length - 1)]),
        "/neo_video_gen/run_segment": () => jsonResponse({ success: true, task_id: "seg-1", status: "queued" }),
        "/neo_video_gen/run_segment/*": () => jsonResponse({ success: true, task_id: "seg-1",
          status: "succeeded", filename: "seg0.mp4", subfolder: "director" }),
      };
    };
    const videoGen = (id, x, meta = {}) => ({ id, type: "gen", title: "出片",
      position: { x, y: 0 }, width: 320, height: 208,
      metadata: { kind: "video", skill_id: "h3_t2v", duration: 8, width: 1344, height: 768, ...meta } });
    const videoSlot = (id, x, meta = {}) => ({ id, type: "video", title: "视频",
      position: { x, y: 600 }, width: 320, height: 208, metadata: meta });
    // 车厢（配方节点）：段号与这一段自己的技能在它身上，整列共用的参数在它那一列的车尾上
    const recipeNode = (id, x, meta = {}) => ({ id, type: "recipe", title: "车厢",
      position: { x, y: 300 }, width: 360, height: 152,
      metadata: { recipe: "短片配方", segment: 0, skill_id: "", ...meta } });
    const tailNode = (id, x, meta = {}) => ({ id, type: "gen", title: "出片",
      position: { x, y: 0 }, width: 320, height: 208,
      metadata: { kind: "video", chain: "train", recipe: "短片配方", anchors: "both",
          continuity: true, context_frames: 22, steps: -1, seed: -1, ...meta } });
    const clipCalls = (path) => fetchLog.filter((c) => c.path === path);
    const clipPolls = (taskId) => fetchLog.filter((c) => c.path.endsWith(`/${taskId}`));
    const clipVideoSrc = (ctx, id) => ctx.view.nodeEl(id).querySelector("video")?.getAttribute("src") || "";
    /** 工具条「添加配方」→ 弹窗第一张卡：车厢、素材与车尾一次铺进画布（换配方就是一条新链） */
    const layTrain = async (ctx, cardAt = 0) => {
      click(ctx.view.button("添加配方"));
      await settle();
      click([...ctx.host.querySelectorAll(".ns-canvas-picker-card")][cardAt]);
      await deepSettle();
    };

    test("加图像生成节点：铺一张图像生成节点，默认技能落内置生图技能", async () => {
      const { page, view } = await genPage([]);
      click(view.button("加图像生成节点"));
      const node = page.current().nodes[0];
      assert.equal(node.type, "gen");
      assert.equal(node.title, "图像生成", "卡上的名字点明这一张出的是图");
      assert.deepEqual([node.width, node.height], [320, 208]);
      assert.equal(node.metadata.skill_id, "image_gen");
      assert.ok(view.nodeEl(node.id).classList.contains("ns-canvas-node-gen"));
    });
    test("技能、比例、长边、张数直接铺在节点上，跑起来写进度与失败原因", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), genNode("g1", 0, 0, { default_ratio: "16:9", count: 3 })],
        [link("t1", "g1")]);
      await deepSettle();   // 技能 config 取到手才有「主模型」那一行
      assert.deepEqual([ctx.chipLabelAt("g1", 0), ctx.chipLabelAt("g1", 1)], ["出图", "16:9"], "胶囊上写的是生效值");
      assert.equal(ctx.chipLabelAt("g1", 2), "长边尺寸", "没盖过长边就写跟随");
      assert.equal(ctx.chipLabelAt("g1", 3), "3 张", "张数也是一枚胶囊，写的是生效张数");
      assert.deepEqual([ctx.chipAt("g1", 0), ctx.chipAt("g1", 1), ctx.chipAt("g1", 2), ctx.chipAt("g1", 3)]
          .map((el) => el.title), ["技能与自定参数：只列吃文字输入的生图技能；主模型 / LoRA 留空 = 跟随该技能配置与全局生图设置",
        "默认比例", "长边尺寸", "生图张数"],
        "技能那一枚说的是「技能 + 自定参数」（绘画页同一句），其余精简胶囊不带行标签，含义写在悬停提示里");
      assert.equal(ctx.genText("g1", "model"), "主模型：跟随技能配置 · 停用 · 双击节点停用",
        "技能 config 取到手才写得出这一行；停用与启用从双击节点那一发来，这一行就写在那一行上");
      assert.equal(ctx.genText("g1", "status"), "");
      click(ctx.genBtn("g1", "出图"));
      await deepSettle();
      assert.equal(ctx.genText("g1", "status"), "生成中 1/8", "状态行走后端推进的那一格");
      assert.ok(ctx.genBtn("g1", "取消任务"), "跑着的时候要给出取消的入口");
      assert.equal(ctx.genBtn("g1", "出图").disabled, true, "这一发在跑就不给叠第二发");
      dispatchApiEvent("rs.image_gen.status", { task_id: "gen-1", status: "failed", error: "显存不足" });
      await settle();
      assert.equal(ctx.genText("g1", "status"), "显存不足");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("出图失败")));
      assert.equal(ctx.genBtn("g1", "出图").disabled, false, "失败过的那一张允许再来一发");
    });
    test("出图请求按连线顺序带提示词与参考图，只带节点上盖过的值", async () => {
      const ctx = await genPage([promptNode("t1", "第一句"), promptNode("t2", "第二句"),
        genNode("g1", 0, 0, { count: 2 }), imageSlot("i1", 0)],
      [link("t1", "g1"), link("t2", "g1"), link("i1", "g1")]);
      ctx.page.current().nodes.find((n) => n.id === "i1").metadata = { filename: "a.png", subfolder: "sub" };
      click(ctx.genBtn("g1", "出图"));
      await settle();
      const body = genCalls()[0].body;
      assert.equal(body.prompt, "第一句\n\n第二句", "多张提示词按连线顺序拼");
      assert.deepEqual(body.references, [{ kind: "input", value: "sub/a.png[output]" }]);
      assert.equal(body.count, 2);
      assert.equal("default_ratio" in body, false, "没盖过比例就不带这一项，交后端按技能 config 合并");
      assert.equal("base_resolution" in body, false);
    });
    test("没有提示词连线时说出图要提示词，不发请求", async () => {
      const ctx = await genPage([genNode("g1", 0, 0)]);
      click(ctx.genBtn("g1", "出图"));
      await settle();
      assert.equal(genCalls().length, 0);
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("接一条文本或图片线")));
    });
    test("没有执行队列时出图不拉内核：只说去顶栏胶囊启动", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), genNode("g1", 0, 0)], [link("t1", "g1")],
        { extraHost: { can: () => false } });
      click(ctx.genBtn("g1", "出图"));
      await settle();
      assert.equal(genCalls().length, 0);
      assert.equal(ctx.env.starts.length, 0,
                   "出图不叫宿主拉内核：在跑的内核被拉一次就是收回它的代理目标，与绘画页出图同一口径");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("点顶栏 ComfyUI 胶囊启动")),
                "提示要说清去哪儿启");
    });
    test("节点上的胶囊选比例：写进节点并进撤销栈", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), genNode("g1", 0, 0)], [link("t1", "g1")]);
      await ctx.pickChip("g1", 1, "9:16");
      assert.equal(ctx.page.current().nodes.find((n) => n.id === "g1").metadata.default_ratio, "9:16");
      assert.equal(ctx.chipLabelAt("g1", 1), "9:16");
      click(ctx.view.button("撤销"));
      await settle();
      assert.equal(ctx.page.current().nodes.find((n) => n.id === "g1").metadata.default_ratio, undefined,
        "撤销把这一项收回原样（原来没写过这一项）");
      assert.equal(ctx.chipLabelAt("g1", 1), "默认比例", "跟随技能配置时胶囊写「默认比例」");
    });
    test("长边胶囊：盖过的值写进节点，选回默认收回跟随", async () => {
      const ctx = await genPage([genNode("g1", 0, 0)]);
      await ctx.pickChip("g1", 2, "2048");
      assert.equal(ctx.page.current().nodes[0].metadata.base_resolution, 2048);
      assert.equal(ctx.chipLabelAt("g1", 2), "2048");
      await ctx.pickChip("g1", 2, "长边尺寸");
      assert.equal(ctx.page.current().nodes[0].metadata.base_resolution, 0, "选回默认 = 跟随技能 config 与全局生图设置");
      assert.equal(ctx.chipLabelAt("g1", 2), "长边尺寸");
    });
    test("张数胶囊写进节点，菜单就列后端吃得下的 1 到 8", async () => {
      const ctx = await genPage([genNode("g1", 0, 0, { count: 3 })]);
      assert.equal(ctx.chipLabelAt("g1", 3), "3 张");
      click(ctx.chipAt("g1", 3));
      await settle();
      const items = () => [...ctx.menu().querySelectorAll(".neo-gallery-gm-menu-item")];
      assert.deepEqual(items().map((el) => el.textContent),
        ["1 张", "2 张", "3 张", "4 张", "5 张", "6 张", "7 张", "8 张"],
        "菜单就列后端吃得下的那一份：一次最多 8 张");
      click(items().find((el) => el.textContent === "8 张"));
      await settle();
      assert.equal(ctx.page.current().nodes[0].metadata.count, 8);
      assert.equal(ctx.chipLabelAt("g1", 3), "8 张", "选完胶囊上写的是生效张数");
      assert.equal(ctx.menu(), null, "这一发改动把节点重建了，菜单跟着收回");
      click(ctx.chipAt("g1", 3));
      await settle();
      click(items().find((el) => el.textContent === "1 张"));
      await settle();
      assert.equal(ctx.page.current().nodes[0].metadata.count, 1);
      assert.equal(ctx.chipLabelAt("g1", 3), "1 张");
    });
    test("出图结果按连线顺序填下游空图节点，多出来的在右侧新建并接上", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), genNode("g1", 0, 0, { count: 3 }),
        imageSlot("i1", 0), imageSlot("i2", 400)],
      [link("t1", "g1"), link("g1", "i1"), link("g1", "i2")]);
      click(ctx.genBtn("g1", "出图"));
      await deepSettle();   // 提交落进队列才收得到结果
      dispatchApiEvent("rs.image_gen.status", okImages(3));
      await settle();
      const nodes = () => ctx.page.current().nodes;
      const slot = (id) => nodes().find((n) => n.id === id).metadata.filename;
      assert.deepEqual([slot("i1"), slot("i2")], ["o1.png", "o2.png"], "空着的槽位按连线顺序填");
      const created = nodes().filter((n) => n.type === "image" && !["i1", "i2"].includes(n.id));
      assert.equal(created.length, 1, "多出来的那一张新建图片节点落在右侧");
      assert.equal(created[0].metadata.filename, "o3.png");
      assert.ok(ctx.page.current().connections.some((c) => c.fromNodeId === "g1" && c.toNodeId === created[0].id),
        "新建的那一张要接在这张生成节点上");
      click(ctx.view.button("撤销"));
      await settle();
      assert.equal(nodes().length, 4, "撤销一次退掉这一发落下的全部图");
      assert.equal(slot("i1"), undefined);
    });
    test("取消任务走后端取消，节点收回不挂运行态", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), genNode("g1", 0, 0)], [link("t1", "g1")]);
      click(ctx.genBtn("g1", "出图"));
      await deepSettle();
      click(ctx.genBtn("g1", "取消任务"));
      await settle();
      assert.ok(fetchLog.some((c) => c.path === "/neo_image_gen/cancel/gen-1" && c.method === "POST"),
        "取消要交后端出队，不是只把界面收掉");
      dispatchApiEvent("rs.image_gen.status", { task_id: "gen-1", status: "cancelled" });
      await settle();
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("已取消出图")));
      assert.equal(ctx.genText("g1", "status"), "");
      assert.equal(listenerCount("rs.image_gen.status"), 0, "终态把监听摘干净");
    });
    test("切画布时脱手：结果不写旧画布，说一句图已存进 Output", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), genNode("g1", 0, 0), imageSlot("i1", 0)],
        [link("t1", "g1"), link("g1", "i1")],
        { gen: { canvases: [{ id: "canvas-0002", title: "乙", nodes: [], connections: [],
          viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" }] } });
      click(ctx.genBtn("g1", "出图"));
      await deepSettle();
      pickCanvas(ctx.view, "canvas-0002");
      await settle();
      dispatchApiEvent("rs.image_gen.status", okImages(2));
      await settle();
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("图已存进 Output 目录")));
      assert.equal(ctx.page.current().id, "canvas-0002");
      assert.ok(ctx.env.store.saved.every((payload) => !payload.nodes?.some((n) => n.id === "i1" && n.metadata.filename)),
        "脱手的那一发不写旧画布");
      assert.equal(listenerCount("rs.image_gen.status"), 0);
    });
    test("胶囊、按钮与种子输入起手不拖节点，胶囊菜单浮在节点外那一层", async () => {
      const ctx = await genPage([genNode("g1", 0, 0)]);
      const nodeEl = ctx.view.nodeEl("g1");
      const at = { ...ctx.page.current().nodes[0].position };
      for (const chip of nodeEl.querySelectorAll(".neo-gallery-gm-chip-btn")) fire(chip, "pointerdown");
      fire(nodeEl.querySelector(".ns-canvas-gen-go"), "pointerdown");
      assert.deepEqual(ctx.page.current().nodes[0].position, at, "控件上起手不拖节点");
      assert.equal(ctx.env.store.saved.length, 0, "起手按控件不算一次改动");
      click(ctx.chipAt("g1", 1));
      await settle();
      assert.ok(ctx.menu(), "菜单浮在页面那一层");
      assert.equal(nodeEl.querySelector(".neo-gallery-gm-chip-menu"), null,
        "菜单不在节点里 —— 世界层带 scale、节点裁剪自己的内容，进那一层两头都吃亏");
    });
    test("胶囊菜单：点菜单里的项不收，点节点外收掉", async () => {
      const ctx = await genPage([genNode("g1", 0, 0)]);
      click(ctx.chipAt("g1", 1));
      await settle();
      assert.ok(ctx.menu());
      fire(ctx.menu().querySelector(".neo-gallery-gm-menu-item"), "pointerdown");
      assert.ok(ctx.menu(), "点菜单里的项不算菜单外");
      fire(ctx.host.querySelector(".ns-canvas-stage"), "pointerdown");
      await settle();
      assert.equal(ctx.menu(), null, "点节点外收掉菜单");
    });
    test("加视频生成节点：16:9 的出片节点，默认技能落在视频技能表第一份", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoSlot("vid1", 700)], [], { routes: clipRoutes() });
      await deepSettle();   // 视频技能表与配方表都在 build 之后才落地
      click(ctx.view.button("加视频生成节点"));
      await settle();
      const video = ctx.page.current().nodes.find((n) => n.type === "gen" && n.metadata.kind === "video");
      assert.deepEqual([video.width, video.height], [320, 208], "出片节点默认 16:9 的框");
      assert.equal(video.title, "视频生成", "同一类节点的两个档，卡上的名字跟着档走");
      assert.equal(video.metadata.skill_id, "h3_t2v", "技能默认落在视频技能表第一份");
      assert.ok(ctx.genBtn(video.id, "生成视频"), "出片节点自带生成视频钮");
      assert.ok(ctx.view.nodeEl("vid1").querySelector(".ns-canvas-node-video-empty"), "没落上片的视频位这么说");
    });
    test("视频节点出片：入参进简单视频链，成片写进下游空视频节点", async () => {
      const ctx = await genPage([promptNode("t1", "镜头慢慢推进"), videoGen("v1", 0, { skill_id: "h3_i2v" }),
        imageSlot("i1", 0), videoSlot("vid1", 700)], [link("t1", "v1"), link("i1", "v1"), link("v1", "vid1")],
        { routes: clipRoutes() });
      await deepSettle();
      ctx.page.current().nodes.find((n) => n.id === "i1").metadata = { filename: "a.png", subfolder: "sub" };
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      assert.deepEqual(clipCalls("/neo_video_gen/simple")[0].body, {
        prompt: "镜头慢慢推进", skill_id: "h3_i2v",
        references: [{ kind: "input", value: "sub/a.png[output]", media: "image" }],
        last_frame: null, duration_sec: 8, seed: -1, width: 1344, height: 768,
      }, "入参按出视频页那一条链的字段名走，参考带自己的 media 交后端分桶");
      assert.ok(fetchLog.some((c) => c.path === "/neo_video_gen/simple/clip-1" && c.method === "GET"),
        "提交完先拉一格快照");
      assert.equal(clipVideoSrc(ctx, "vid1"), "/neo_gallery/video?filename=o.mp4&subfolder=sub",
        "成片写进连着的空视频节点");
      assert.equal(ctx.genText("v1", "status"), "", "出完片状态行收回，节点不挂运行态");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("已出片")));
      assert.equal(ctx.page.current().nodes.filter((n) => n.type === "video").length, 1, "有空位就不新开");
    });

    test("全参考生视频出片：图与参考视频都进简单视频链，卡上那一行说出交出去的每一类", async () => {
      const ctx = await genPage([promptNode("t1", "一句话"), videoGen("v1", 0, { skill_id: "h3_r2v" }),
        imageSlot("i1", 0), videoSlot("r1", 400, { filename: "ref.mp4" }), videoSlot("vid1", 700)],
      [link("t1", "v1"), link("i1", "v1"), link("r1", "v1"), link("v1", "vid1")], { routes: clipRoutes() });
      await deepSettle();
      ctx.page.current().nodes.find((n) => n.id === "i1").metadata = { filename: "a.png" };
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      assert.deepEqual(clipCalls("/neo_video_gen/simple")[0].body.references, [
        { kind: "input", value: "a.png[output]", media: "image" },
        { kind: "input", value: "ref.mp4[output]", media: "video" },
      ], "全参考那一组吃三桶：参考视频不再像图生视频那一发一样被丢掉");
      assert.equal(ctx.genText("v1", "refs"), "参考：参考图 1 · 参考视频 1", "卡上那一行说清这一发交出去的参考");
    });

    test("画布上取的参考视频与参考音频直接进全参考那一发的三桶", async () => {
      const ctx = await genPage([promptNode("t1", "一句话"), videoGen("v1", 0, { skill_id: "h3_r2v" }),
        imageSlot("i1", 0),
        { id: "vin", type: "video_in", title: "视频输入", position: { x: 300, y: 600 }, width: 340, height: 240,
          metadata: { filename: "ref.mp4", subfolder: "neo_gen/v" } },
        { id: "ain", type: "audio_in", title: "音频输入", position: { x: 600, y: 600 }, width: 340, height: 104,
          metadata: { filename: "voice.mp3" } },
        videoSlot("vid1", 700)],
      [link("t1", "v1"), link("i1", "v1"), link("vin", "v1"), link("ain", "v1"), link("v1", "vid1")],
      { routes: clipRoutes() });
      await deepSettle();
      ctx.page.current().nodes.find((n) => n.id === "i1").metadata = { filename: "a.png" };
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      assert.deepEqual(clipCalls("/neo_video_gen/simple")[0].body.references, [
        { kind: "input", value: "a.png[output]", media: "image" },
        { kind: "input", value: "neo_gen/v/ref.mp4[output]", media: "video" },
        { kind: "input", value: "voice.mp3[output]", media: "audio" },
      ], "素材输入节点照同一口径带 media 交后端分桶，连线顺序就是交出去的顺序");
      assert.equal(ctx.genText("v1", "refs"), "参考：参考图 1 · 参考视频 1 · 参考音频 1");
    });

    test("图生视频那一发不吃画布上的参考视频与参考音频：卡上说明丢的是哪一类", async () => {
      const ctx = await genPage([promptNode("t1", "一句话"), videoGen("v1", 0, { skill_id: "h3_i2v" }),
        imageSlot("i1", 0),
        { id: "vin", type: "video_in", title: "视频输入", position: { x: 300, y: 600 }, width: 340, height: 240,
          metadata: { filename: "ref.mp4" } },
        { id: "ain", type: "audio_in", title: "音频输入", position: { x: 600, y: 600 }, width: 340, height: 104,
          metadata: { filename: "voice.mp3" } },
        videoSlot("vid1", 700)],
      [link("t1", "v1"), link("i1", "v1"), link("vin", "v1"), link("ain", "v1"), link("v1", "vid1")],
      { routes: clipRoutes() });
      await deepSettle();
      ctx.page.current().nodes.find((n) => n.id === "i1").metadata = { filename: "a.png" };
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      const body = clipCalls("/neo_video_gen/simple")[0].body;
      assert.deepEqual(body.references, [{ kind: "input", value: "a.png[output]", media: "image" }],
        "首帧槽只吃第一张图：这一发的模板没有参考视频与参考音频的槽位");
      assert.equal(ctx.genText("v1", "refs"), "参考：参考图 1（参考视频 · 参考音频 没进）");
    });

    test("全参考生视频出片：超过 H3 槽位上限的那几张不进，卡上说明丢的是哪一类", async () => {
      const nodes = [promptNode("t1", "一句话"), videoGen("v1", 0, { skill_id: "h3_r2v" })];
      const links = [link("t1", "v1")];
      for (let i = 1; i <= 10; i += 1) {
        nodes.push(imageSlot(`i${i}`, i * 40));
        links.push(link(`i${i}`, "v1"));
      }
      for (let i = 1; i <= 4; i += 1) {
        nodes.push(videoSlot(`r${i}`, 3000 + i * 40, { filename: `ref${i}.mp4` }));
        links.push(link(`r${i}`, "v1"));
      }
      const ctx = await genPage(nodes, links, { routes: clipRoutes() });
      await deepSettle();
      for (const n of ctx.page.current().nodes) if (n.type === "image") n.metadata = { filename: `${n.id}.png` };
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      const refs = clipCalls("/neo_video_gen/simple")[0].body.references;
      assert.deepEqual([refs.filter((r) => r.media === "image").length, refs.filter((r) => r.media === "video").length],
        [9, 3], "图 9 / 视频 3 是 MiniMaxH3ReferenceToVideo 的槽位上限，多出来的不发出去");
      assert.equal(refs[8].value, "i9.png[output]", "连过来的顺序就是交出去的顺序");
      assert.equal(ctx.genText("v1", "refs"), "参考：参考图 9 · 参考视频 3（参考图 · 参考视频 没进）",
        "丢掉的那一类写在卡上，不让用户只看见「没出来」");
    });

    test("图生视频出片：前两张图进首帧与尾帧，第三张与参考视频不进这一发", async () => {
      const ctx = await genPage([promptNode("t1", "一句话"), videoGen("v1", 0, { skill_id: "h3_i2v" }),
        imageSlot("i1", 0), imageSlot("i2", 40), imageSlot("i3", 80),
        videoSlot("r1", 400, { filename: "ref.mp4" }), videoSlot("vid1", 700)],
      [link("t1", "v1"), link("i1", "v1"), link("i2", "v1"), link("i3", "v1"), link("r1", "v1"), link("v1", "vid1")],
      { routes: clipRoutes() });
      await deepSettle();
      for (const id of ["i1", "i2", "i3"]) {
        ctx.page.current().nodes.find((n) => n.id === id).metadata = { filename: `${id}.png` };
      }
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      const body = clipCalls("/neo_video_gen/simple")[0].body;
      assert.deepEqual(body.references, [{ kind: "input", value: "i1.png[output]", media: "image" }],
        "首帧槽只吃第一张：这一发的模板没有多路参考槽位");
      assert.deepEqual(body.last_frame, { kind: "input", value: "i2.png[output]", media: "image" }, "第二张进尾帧");
      assert.equal(ctx.genText("v1", "refs"), "参考：参考图 2（参考图 · 参考视频 没进）");
    });

    test("文生视频出片：连过来的图不带走，卡上说明这一发没有参考", async () => {
      const ctx = await genPage([promptNode("t1", "一句话"), videoGen("v1", 0), imageSlot("i1", 0),
        videoSlot("vid1", 700)], [link("t1", "v1"), link("i1", "v1"), link("v1", "vid1")],
        { routes: clipRoutes() });
      await deepSettle();
      ctx.page.current().nodes.find((n) => n.id === "i1").metadata = { filename: "a.png" };
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      assert.deepEqual(clipCalls("/neo_video_gen/simple")[0].body.references, [],
        "文生视频的模板没有参考槽位，发过去也只会被后端静默扔");
      assert.equal(ctx.genText("v1", "refs"), "没有参考素材（参考图 没进）");
    });

    test("全参考生视频缺参考素材时在画布上就拦下", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0, { skill_id: "h3_r2v" })],
        [link("t1", "v1")], { routes: clipRoutes() });
      await deepSettle();
      click(ctx.genBtn("v1", "生成视频"));
      await settle();
      assert.equal(clipCalls("/neo_video_gen/simple").length, 0, "无参考的 r2v 不进队列");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("全参考生视频要参考素材")),
        "缺的是哪一类参考要说清：图 / 视频 / 音频都算这一发的素材");
    });

    test("出片技能面板按生成模式分组：全参考生视频那一组在画布上看得见", async () => {
      const ctx = await genPage([videoGen("v1", 0)], [], { routes: clipRoutes() });
      await deepSettle();
      click(ctx.chipAt("v1", 0));
      await settle();
      assert.deepEqual([...ctx.menu().querySelectorAll(".neo-gallery-gm-skill-group")].map((el) => el.textContent),
        ["图生视频", "全参考生视频", "文生视频"], "组头与组序就是出视频页那一份词表");
    });
    test("视频节点出片：没有空视频节点就新开一台并连上这一发", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0)], [link("t1", "v1")],
        { routes: clipRoutes() });
      await deepSettle();
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      const created = ctx.page.current().nodes.filter((n) => n.type === "video");
      assert.equal(created.length, 1);
      assert.deepEqual([created[0].metadata.filename, created[0].metadata.subfolder], ["o.mp4", "sub"]);
      assert.ok(ctx.view.nodeEl(created[0].id).querySelector("video"), "新节点直接播这一发");
      assert.ok(ctx.page.current().connections.some((c) => c.fromNodeId === "v1" && c.toNodeId === created[0].id),
        "新节点接在这一发出片节点的下游");
      assert.ok(!ctx.view.nodeEl(created[0].id).classList.contains("ns-canvas-node-run"),
        "出完片的节点不挂运行态");
      assert.ok(ctx.env.store.toasts.some((item) => item.message === "已出片"));
    });
    test("视频节点出片：状态行走快照那一格，取消把这一发交后端出队", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0)], [link("t1", "v1")],
        { routes: clipRoutes({ snaps: [{ success: true, task_id: "clip-1", status: "running",
          progress: { value: 3, max: 120 } }] }) });
      await deepSettle();
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      assert.ok(ctx.genText("v1", "status").includes("生成中 3/120"), ctx.genText("v1", "status"));
      assert.ok(ctx.view.nodeEl("v1").classList.contains("ns-canvas-node-run"), "跑着时节点挂运行态");
      assert.equal(ctx.genBtn("v1", "生成视频").disabled, true, "这一发在跑就不给叠第二发");
      click(ctx.genBtn("v1", "取消任务"));
      await settle();
      assert.ok(fetchLog.some((c) => c.path === "/neo_video_gen/simple/clip-1/cancel" && c.method === "POST"),
        "取消要交后端出队，不是只把界面收掉");
      click(ctx.genBtn("v1", "生成视频"));   // 闸门：这一发还没收摊就不叠第二发
      await deepSettle();
      assert.equal(clipCalls("/neo_video_gen/simple").length, 1, "取消没收摊前不提交第二发");
      assert.ok(ctx.genText("v1", "status").includes("生成中 3/120"), "终态由后端那一格收摊，界面不自演已取消");
    });
    test("出片走到后端那一格 cancelled：状态行收回并允许再来一发", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0)], [link("t1", "v1")],
        { routes: clipRoutes({ snaps: [{ success: true, task_id: "clip-1", status: "cancelled" }] }) });
      await deepSettle();
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      assert.equal(ctx.genText("v1", "status"), "", "取消完不挂运行态");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("已取消出片")));
      assert.equal(ctx.genBtn("v1", "生成视频").disabled, false, "取消完允许再来一发");
    });
    test("出片失败：后端给的原因留在状态行，这一张允许再来一发", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0)], [link("t1", "v1")],
        { routes: clipRoutes({ snaps: [{ success: false, status: "failed", error: "显存不够" }] }) });
      await deepSettle();
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      assert.equal(ctx.genText("v1", "status"), "显存不够", "状态行就是后端那一格的失败原因");
      assert.ok(ctx.view.nodeEl("v1").querySelector(".ns-canvas-gen-fail"), "失败那一行标失败色");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("出片失败：显存不够")));
      assert.equal(ctx.genBtn("v1", "生成视频").disabled, false, "失败过的那一张允许再来一发");
    });
    test("要参考素材的技能缺图时在画布上就拦下", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0, { skill_id: "h3_i2v" })],
        [link("t1", "v1")], { routes: clipRoutes() });
      await deepSettle();
      click(ctx.genBtn("v1", "生成视频"));
      await settle();
      assert.equal(clipCalls("/neo_video_gen/simple").length, 0, "无参考的 i2v 不进队列");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("要参考素材")));
    });
    test("卡上正文行按下拖就是拖这一张：只有胶囊、按钮与种子输入起手不吃这一按", async () => {
      const ctx = await genPage([recipeNode("r1", 0)], [], { routes: clipRoutes() });
      await deepSettle();
      const posOf = () => ctx.page.current().nodes.find((n) => n.id === "r1").position;
      const drag = (el, dx, dy) => {
        const before = { ...posOf() };
        fire(el, "pointerdown", { clientX: 620, clientY: 420, button: 0 });
        fire(window, "pointermove", { clientX: 620 + dx, clientY: 420 + dy });
        fire(window, "pointerup", {});
        return [posOf().x - before.x, posOf().y - before.y];
      };
      const row = (part) => ctx.view.nodeEl("r1").querySelector(`.ns-canvas-${part}`);
      assert.deepEqual(drag(row("car-info"), 40, 30), [40, 30], "段号与配方概览那一行按下拖就是拖这一张节点");
      assert.deepEqual(drag(row("recipe-count"), 18, -9), [18, -9], "参考素材计数那一行按下拖就是拖这一张节点");
      // 正文框是打字的地方：拖过一截才算拖节点（CONTENT_DRAG_GATE），没拖过就是选字
      const ta = ctx.view.nodeEl("r1").querySelector(".ns-canvas-car-text");
      assert.deepEqual(drag(ta, 2, 1), [0, 0], "正文框里拖两像素不算拖节点");
      assert.deepEqual(drag(ta, 40, 30), [40, 30], "正文框里拖过一截就是拖这一张节点");
      assert.ok([...ctx.view.nodeLayer.children].some((el) => el.dataset.nodeId === "r1"
        && el.classList.contains("ns-canvas-node-on")), "按在控件上就是选中这一张");
    });

    test("配方卡提示词来源那一行：连过来的正文就是画布那一份", async () => {
      const ctx = await genPage([promptNode("t1", "画布上写的提示词"), recipeNode("r1", 0),
        tailNode("g1", 700, { skill_id: "h3_t2v" }), videoSlot("vid1", 1200)],
      [link("r1", "g1")], { routes: clipRoutes() });
      await deepSettle();
      const row = () => ctx.view.nodeEl("r1").querySelector(".ns-canvas-recipe-prompt");
      const car = () => ctx.view.nodeEl("r1").querySelector(".ns-canvas-car-text");
      assert.equal(car().value, "开场那一段的提示词", "没连正文也没写过：这一格铺的就是配方那一段那一句");
      assert.equal(ctx.recipeText("r1", "src"), "", "配方那一段就是默认来源：提示词前不写「配方」二字");
      assert.ok(!row().classList.contains("ns-canvas-recipe-on"), "用配方那一份时不抬主色");
      ctx.linkNodes("t1", "r1");
      await settle();
      assert.ok(row().classList.contains("ns-canvas-recipe-on"), "连了正文，这一行抬到主色");
      assert.equal(ctx.recipeText("r1", "src"), "画布");
      assert.ok(car().disabled, "连过来的正文在跑，这一格锁着");
      click(ctx.genBtn("g1", "生成视频"));
      await deepSettle();
      assert.equal(clipCalls("/neo_video_gen/run_segment")[0].body.prompt, "画布上写的提示词",
        "出片发出去的就是画布那一份");
    });

    test("车尾出片：启用的段按链序依次入队，参数取车尾那一份，成片落进新开的视频位", async () => {
      let seq = 0;
      let releaseGate;
      const gate = new Promise((done) => { releaseGate = done; });
      const routes = { ...clipRoutes(),
        // 第二段的入队卡在闸门后：第一段跑完收摊，车尾那一行先站在 1/2 上
        "/neo_video_gen/run_segment": async () => {
          if (++seq === 2) await gate;
          return jsonResponse({ success: true, task_id: `chain-${seq}`, status: "queued" });
        } };
      const ctx = await genPage([], [], { routes });
      await layTrain(ctx);
      const tail = ctx.page.current().nodes.find((n) => n.type === "gen");
      const cars = () => ctx.page.current().nodes.filter((n) => n.type === "recipe");
      Object.assign(tail.metadata, { seed: 100, steps: 25, anchors: "first", skill_id: "h3_t2v" });
      await settle();
      click(ctx.genBtn(tail.id, "生成视频"));
      await settle();
      assert.equal(ctx.genText(tail.id, "status"), "串联出片 1/2", "第一段收摊，车尾那一行进一格");
      const clips = () => ctx.page.current().nodes.filter((n) => n.type === "video");
      assert.equal(clips().length, 1, "车厢没有成片位：第一段收摊时新开一台视频位");
      assert.ok(clipVideoSrc(ctx, clips()[0].id), "新开的那一台落上这一段的成片");
      assert.ok(ctx.page.current().connections.some((c) => c.fromNodeId === cars()[0].id
        && c.toNodeId === clips()[0].id), "新开的视频位接在自己那一段的车厢上");
      releaseGate();
      await deepSettle();
      assert.equal(ctx.genText(tail.id, "status"), "", "整列收完车尾收摊");
      const calls = clipCalls("/neo_video_gen/run_segment");
      assert.deepEqual(calls.map((c) => c.body.segment), [0, 1], "按链序一段一发");
      assert.deepEqual(calls.map((c) => c.body.seed), [100, 101], "种子按段号偏移（车尾那一份是起手）");
      assert.deepEqual(calls.map((c) => [c.body.recipe, c.body.anchors, c.body.steps,
        c.body.continuity, c.body.context_frames]),
      [["短片配方", "first", 25, true, 22], ["短片配方", "first", 25, true, 22]], "公共参数取的是车尾那一份");
      assert.equal(calls[0].body.prompt, "开场那一段的提示词", "没连正文线时车厢跑的就是配方那一段那一句");
      assert.deepEqual(calls.map((c) => c.body.references.images), [
        [{ kind: "recipe", value: "开场首帧.png", recipe: "短片配方" },
          { kind: "recipe", value: "角色设定.png", recipe: "短片配方" }],
        []],
      "铺在厢上方的图片素材连配方名一起交后端；参考视频不铺成节点，出片那一发由后端从配方那一份取");
      assert.deepEqual(clips().map((c) => ctx.view.nodeEl(c.id)?.querySelector("video")?.getAttribute("src") || ""),
        ["/neo_gallery/video?filename=seg0.mp4&subfolder=director",
          "/neo_gallery/video?filename=seg0.mp4&subfolder=director"],
        "两段各落各的视频位，车尾自己不落片");
      assert.equal(clips().length, 2, "第二段收摊时再开一台");
    });

    test("车尾盖全参考技能：整列按全参考出片，锚点锁成不用锚点", async () => {
      const ctx = await genPage([], [], { routes: clipRoutes() });
      await layTrain(ctx);
      await deepSettle();
      const tail = ctx.page.current().nodes.find((n) => n.type === "gen");
      Object.assign(tail.metadata, { skill_id: "h3_r2v", anchors: "both" });
      await settle();
      click(ctx.genBtn(tail.id, "生成视频"));
      await deepSettle();
      const calls = clipCalls("/neo_video_gen/run_segment");
      assert.deepEqual(calls.map((c) => c.body.mode), ["r2v", "r2v"], "每一段都带上画布盖的生成模式");
      assert.deepEqual(calls.map((c) => c.body.anchors), ["none", "none"],
        "全参考那一组的模板没有锚点帧槽位：整列不吃锚点，车尾上那一份「两端锚点」不生效");
      click(ctx.genBtn(tail.id, "参数"));
      await settle();
      const form = ctx.host.querySelector(".ns-canvas-tailform");
      const anchorSel = [...form.querySelectorAll("select")].find((s) => s.title.includes("全参考生视频不吃锚点帧"));
      assert.ok(anchorSel.disabled, "锚点那一格锁着：这一发没有它要换的东西");
      assert.equal(anchorSel.value, "none", "锁在出片真正用的那一份上");
      fire(document, "keydown", { key: "Escape" });
      await settle();
      assert.equal(ctx.host.querySelector(".ns-canvas-tailform-mask"), null, "Esc 收窗");
    });

    test("停用一段：整列跳过这一段，这一张压暗并挂徽标", async () => {
      let seq = 0;
      const routes = { ...clipRoutes(),
        "/neo_video_gen/run_segment": () => jsonResponse({ success: true, task_id: `chain-${++seq}`, status: "queued" }) };
      const ctx = await genPage([], [], { routes });
      await layTrain(ctx);
      const cars = () => ctx.page.current().nodes.filter((n) => n.type === "recipe");
      const tail = ctx.page.current().nodes.find((n) => n.type === "gen");
      Object.assign(tail.metadata, { skill_id: "h3_t2v" });
      await settle();
      click(nodeAct(ctx.view, cars()[1].id, "disable"));
      await settle();
      assert.equal(ctx.page.current().nodes.find((n) => n.id === cars()[1].id).metadata.disabled, true);
      assert.ok(ctx.view.nodeEl(cars()[1].id).classList.contains("ns-canvas-node-off"), "停用的那一张压暗");
      assert.ok(ctx.view.nodeEl(cars()[1].id).textContent.includes("已停用"), "停用的那一张挂徽标");
      assert.ok(nodeAct(ctx.view, cars()[1].id, "enable"), "停用的那一张给启用这一枚");
      assert.equal(ctx.view.nodeEl(tail.id).querySelector(".ns-canvas-car-info").textContent,
        "链上 2 段 · 启用 1 段 · 短片配方", "车尾那一行说这一列跑几段");
      click(ctx.genBtn(tail.id, "生成视频"));
      await deepSettle();
      assert.deepEqual(clipCalls("/neo_video_gen/run_segment").map((c) => c.body.segment), [0],
        "整列出片跳过停用的那一段");
      click(nodeAct(ctx.view, cars()[0].id, "disable"));
      await settle();
      click(ctx.genBtn(tail.id, "生成视频"));
      await settle();
      assert.equal(clipCalls("/neo_video_gen/run_segment").length, 1, "全停用就不入队");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("链上没有启用的段")));
    });

    test("停用是通用功能：正文与参考图都不取停用的那一张，停用的节点自己不出图", async () => {
      const ctx = await genPage([promptNode("t1", "第一句"), promptNode("t2", "第二句"),
        genNode("g1", 0, 0), imageSlot("i1", 0), imageSlot("i2", 400)],
      [link("t1", "g1"), link("t2", "g1"), link("i1", "g1"), link("i2", "g1")]);
      ctx.page.current().nodes.find((n) => n.id === "i1").metadata = { filename: "a.png" };
      ctx.page.current().nodes.find((n) => n.id === "i2").metadata = { filename: "b.png" };
      await settle();
      click(nodeAct(ctx.view, "t2", "disable"));
      click(nodeAct(ctx.view, "i2", "disable"));
      await settle();
      click(ctx.genBtn("g1", "出图"));
      await settle();
      const body = genCalls()[0].body;
      assert.equal(body.prompt, "第一句", "停用的那块正文不进这一发");
      assert.deepEqual(body.references, [{ kind: "input", value: "a.png[output]" }], "停用的那张参考图不进这一发");
      // 这一发收摊才谈停用：跑着的那一张本来就不叠第二发，停用那一句要在这一发之外说
      dispatchApiEvent("rs.image_gen.status", okImages(1));
      await settle();
      click(nodeAct(ctx.view, "g1", "disable"));
      await settle();
      click(ctx.genBtn("g1", "出图"));
      await settle();
      assert.equal(genCalls().length, 1, "停用的生成节点自己不出图");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("已停用")),
        "停用那一句要说给按下的那一张");
      click(nodeAct(ctx.view, "g1", "enable"));
      await settle();
      click(ctx.genBtn("g1", "出图"));
      await settle();
      assert.equal(genCalls().length, 2, "启用之后照跑出图");
    });

    test("停用的视频位不是成片落点：出片往下找别的空位，没有就新开一台", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0), videoSlot("s1", 400)],
        [link("t1", "v1"), link("v1", "s1")], { routes: clipRoutes() });
      await deepSettle();
      click(nodeAct(ctx.view, "s1", "disable"));
      await settle();
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      assert.equal(ctx.view.nodeEl("s1").querySelector("video"), null, "停用的那一张不落片");
      const created = ctx.page.current().nodes.filter((n) => n.type === "video" && n.id !== "s1");
      assert.equal(created.length, 1, "新开一台视频位接在这台节点下游");
      assert.ok(ctx.view.nodeEl(created[0].id).querySelector("video"), "成片落进新开的那一台");
    });

    test("车尾取消任务取消这一列在跑的每一段：两段都出队", async () => {
      let seq = 0;
      let release;
      const hold = new Promise((done) => { release = done; });
      const routes = { ...clipRoutes(),
        "/neo_video_gen/run_segment": () => jsonResponse({ success: true, task_id: `chain-${++seq}`, status: "queued" }),
        // 第一段的进度卡在闸门后：这一列两段都还挂着运行态，取消要把它们逐个出队
        "/neo_video_gen/run_segment/chain-1": () => hold
          .then(() => jsonResponse({ success: true, task_id: "chain-1", status: "succeeded", filename: "a.mp4", subfolder: "" })),
        "/neo_video_gen/run_segment/chain-2": () => jsonResponse({ success: true, task_id: "chain-2",
          status: "running", progress: { value: 1, max: 100 } }) };
      const ctx = await genPage([], [], { routes });
      await layTrain(ctx);
      const tail = ctx.page.current().nodes.find((n) => n.type === "gen");
      Object.assign(tail.metadata, { skill_id: "h3_t2v", seed: 100 });
      await settle();
      click(ctx.genBtn(tail.id, "生成视频"));
      await settle();
      assert.equal(ctx.genText(tail.id, "status"), "串联出片 0/2", "整列出片挂着，车尾数的是段数");
      click(ctx.genBtn(tail.id, "取消任务"));
      await settle();
      assert.ok(fetchLog.some((c) => c.path === "/neo_video_gen/run_segment/chain-1/cancel" && c.method === "POST"),
        "第 1 段出队");
      assert.ok(fetchLog.some((c) => c.path === "/neo_video_gen/run_segment/chain-2/cancel" && c.method === "POST"),
        "第 2 段出队");
      assert.equal(ctx.genText(tail.id, "status"), "", "车尾收摊");
      release();
      await deepSettle();
      assert.equal(clipCalls("/neo_video_gen/run_segment").length, 2, "取消不再补发新的一发");
      assert.ok(clipPolls("chain-2").length >= 1, "车厢自己的收摊归它那一发的轮询");
    });

    test("串联的车厢是精简卡：卡上一枚钮都没有，停用与删除在节点上方的浮出栏里", async () => {
      const ctx = await genPage([{ ...recipeNode("c1", 0, { train: 1, segment: 0 }), width: 360, height: 152 }],
        [], { routes: clipRoutes() });
      await deepSettle();
      const el = ctx.view.nodeEl("c1");
      assert.ok(el.querySelector(".ns-canvas-car"), "车厢走的是精简卡那一层");
      assert.equal(el.querySelectorAll(".ns-canvas-gen-btn").length, 0, "车厢卡上一枚钮都没有：整列出片在车尾那台生成节点");
      assert.ok(!el.querySelector("select"), "配方 / 步数 / 锚点那些下拉不在车厢上");
      assert.ok(!el.querySelector(".ns-canvas-recipe-segs"), "段列表也不在车厢上");
      assert.ok(nodeAct(ctx.view, "c1", "disable"), "停用这一枚在选中那一排里");
      click(nodeAct(ctx.view, "c1", "disable"));
      await settle();
      assert.equal(ctx.page.current().nodes.find((n) => n.id === "c1").metadata.disabled, true,
        "栏上的停用落进 metadata.disabled");
      assert.equal(clipCalls("/neo_video_gen/run_segment").length, 0, "车厢这一张不发片");
    });

    test("车厢卡上的正文铺的就是这一段生效的那一句：改了就走自己这一句", async () => {
      const ctx = await genPage([recipeNode("c1", 0), tailNode("t1", 300, { skill_id: "h3_t2v" }), videoSlot("vid1", 600)],
        [link("c1", "t1")], { routes: clipRoutes() });
      await deepSettle();
      const car = () => ctx.view.nodeEl("c1").querySelector(".ns-canvas-car-text");
      assert.ok(car(), "车厢卡上有一块可编辑的正文");
      assert.equal(car().value, "开场那一段的提示词", "车厢没写过：框里铺的就是配方那一段那一句");
      assert.equal(ctx.recipeText("c1", "src"), "", "配方那一段就是默认来源：提示词前不写「配方」二字");
      car().value = "开场那一段的提示词\n";   // 与配方那一份只差一个换行：这一发算改过
      fire(car(), "input");
      await settle();
      assert.equal(ctx.recipeText("c1", "src"), "车厢", "与那一份一字不差才算没改过");
      car().value = "车厢自己写的那一句";
      fire(car(), "input");
      await settle();
      assert.equal(ctx.page.current().nodes.find((n) => n.id === "c1").metadata.content, "车厢自己写的那一句",
        "正文落进 metadata.content，与提示词节点同一份存法");
      assert.equal(ctx.recipeText("c1", "src"), "车厢", "写完来源就落到车厢这一档");
      click(ctx.genBtn("t1", "生成视频"));
      await deepSettle();
      assert.equal(clipCalls("/neo_video_gen/run_segment")[0].body.prompt, "车厢自己写的那一句",
        "出片发出去的就是车厢自己写的那一句");
    });

    test("连过来的正文盖过车厢自己写的那一句，断线回到车厢这一句", async () => {
      const ctx = await genPage([promptNode("p1", "画布上写的提示词"),
        recipeNode("c1", 0, { content: "车厢自己写的那一句" }), tailNode("t1", 300, { skill_id: "h3_t2v" }), videoSlot("vid1", 600)],
      [link("p1", "c1"), link("c1", "t1")], { routes: clipRoutes() });
      await deepSettle();
      const car = () => ctx.view.nodeEl("c1").querySelector(".ns-canvas-car-text");
      assert.ok(car().disabled, "连过来的正文在跑，这一块锁着，不给人改一份跑不出去的");
      assert.equal(ctx.recipeText("c1", "src"), "画布", "来源那一枚说的是画布");
      click(ctx.genBtn("t1", "生成视频"));
      await deepSettle();
      assert.equal(clipCalls("/neo_video_gen/run_segment")[0]?.body?.prompt, "画布上写的提示词",
        "连过来的正文盖过车厢自己写的那一句");
    });

    test("铺一列不压在一起：厢在一行里排开，素材在自己厢正上方，车尾紧跟最后一厢", async () => {
      const ctx = await genPage([], [], { routes: clipRoutes() });
      click(ctx.view.button("添加配方"));
      await settle();
      click(ctx.host.querySelector(".ns-canvas-picker-card"));   // 弹窗里就一份短片配方，两段
      await deepSettle();
      const nodes = ctx.page.current().nodes;
      const cars = nodes.filter((n) => n.type === "recipe");
      const refs = nodes.filter((n) => n.type === "image");
      const tail = nodes.find((n) => n.type === "gen");
      assert.deepEqual([cars.length, refs.length, tail ? 1 : 0], [2, 2, 1],
        "两段两厢，第一段铺首帧与那一张参考素材，一台车尾");
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          assert.ok(!canvas.overlaps(nodes[i], nodes[j]),
            `${nodes[i].type} 与 ${nodes[j].type} 压在一起：`
            + `${JSON.stringify(nodes[i].position)} ${JSON.stringify(nodes[j].position)}`);
        }
      }
      assert.equal(cars[0].position.y, cars[1].position.y, "同一行的厢同一高");
      assert.ok(cars[1].position.x > cars[0].position.x + cars[0].width, "第二厢在第一厢右边那一格");
      assert.ok(tail.position.x > cars[1].position.x + cars[1].width, "车尾紧跟最后一厢右边那一格");
      assert.ok(tail.position.y < cars[1].position.y + cars[1].height, "车尾与厢同一行：顶边落在厢那一带");
      assert.ok(refs[0].position.y + refs[0].height <= cars[0].position.y, "参考素材落在自己那厢正上方");
      assert.ok(refs[1].position.x > refs[0].position.x + refs[0].width, "同一厢的素材在一行里排开，不叠在一起");
      // 素材行铺得比厢宽时是围着厢居中的（列宽就是素材行的宽）：居中在厢上就是「自己那一列」
      assert.equal(Math.round(refs[0].position.x + (refs[1].position.x + refs[1].width - refs[0].position.x) / 2),
        cars[0].position.x + Math.round(cars[0].width / 2), "素材行的中心就是自己那厢的中心");
    });

    test("铺一列默认 3 厢一行：第七段落第三行行首，与第一厢同一列", async () => {
      const ctx = await genPage([], [], { routes: clipRoutes({ recipes: [SEVEN_ROW] }) });
      await layTrain(ctx);
      const cars = ctx.page.current().nodes.filter((n) => n.type === "recipe");
      const tail = ctx.page.current().nodes.find((n) => n.type === "gen");
      assert.equal(cars.length, 7, "七段铺七厢");
      assert.ok(cars.slice(0, 3).every((c) => c.position.y === cars[0].position.y), "第一行就三厢");
      assert.ok(cars[3].position.y > cars[2].position.y, "第 4 厢落第二行");
      assert.ok(cars[6].position.y > cars[5].position.y, "第 7 厢落第三行");
      assert.equal(cars[6].position.x, cars[0].position.x, "第三行从行首起：第 7 厢与第 1 厢同一列");
      assert.ok(cars[1].position.x > cars[0].position.x + cars[0].width
        && cars[2].position.x > cars[1].position.x + cars[1].width, "一行里三厢排开不叠");
      assert.ok(tail.position.x > cars[6].position.x + cars[6].width, "车尾紧跟最后一厢右边那一格");
      assert.ok(Math.abs(tail.position.y - cars[6].position.y) < cars[6].height, "车尾与最后一厢同一行");
    });

    test("整列那一句只在车尾露一份：配方名写在车尾，车厢一份都不出", async () => {
      const ctx = await genPage([], [], { routes: clipRoutes() });
      await layTrain(ctx);
      const cars = () => ctx.page.current().nodes.filter((n) => n.type === "recipe");
      const tailId = () => ctx.page.current().nodes.find((n) => n.type === "gen").id;
      const info = () => ctx.view.nodeEl(tailId()).querySelector(".ns-canvas-car-info").textContent;
      assert.equal(cars().length, 2, "两段铺两厢");
      for (const car of cars()) {
        assert.ok(!ctx.view.nodeEl(car.id).querySelector(".ns-canvas-recipe-info"), "车厢不铺整列那一句");
        assert.ok(!ctx.view.nodeEl(car.id).querySelector("select"), "整列共用的下拉不在车厢上");
      }
      assert.equal(info(), "链上 2 段 · 启用 2 段 · 短片配方", "车尾那一行把段数与配方名一起写出来");
      const model = ctx.view.nodeEl(tailId()).querySelector(".ns-canvas-gen-model");
      assert.equal(model, null, "车尾不铺第二份配方概览：段数与配方名在顶行，技能与分辨率在两枚胶囊上");
      assert.equal(ctx.view.nodeEl(tailId()).querySelector(".ns-canvas-recipe-pick"), null,
        "车尾不在这里换配方：要换配方是重铺一列");
      click(nodeAct(ctx.view, cars()[1].id, "disable"));
      await settle();
      assert.equal(info(), "链上 2 段 · 启用 1 段 · 短片配方", "启用几段写在同一行上");
    });

    test("车尾顶行是这一列的关键信息：配方名与段数写在第一行，卡上不铺第二份概览", async () => {
      const ctx = await genPage([], [], { routes: clipRoutes() });
      await layTrain(ctx);
      const tailId = () => ctx.page.current().nodes.find((n) => n.type === "gen").id;
      const rows = [...ctx.view.nodeEl(tailId()).querySelector(".ns-canvas-gen-ctl").children];
      assert.ok(rows[0].classList.contains("ns-canvas-car-head"), "卡上第一行就是顶行那一行");
      assert.equal(rows[0].querySelector(".ns-canvas-car-info").textContent,
        "链上 2 段 · 启用 2 段 · 短片配方", "配方名与跑几段写在第一行");
      assert.equal(ctx.view.nodeEl(tailId()).querySelector(".ns-canvas-gen-model"), null,
        "车尾不铺第二份概览：段数、技能、分辨率各只在一处");
    });

    test("车尾技能空着 = 每一段跟配方里那一个；选一枚 = 整列共用这一份", async () => {
      const ctx = await genPage([], [], { routes: clipRoutes() });
      await layTrain(ctx);
      const tailId = () => ctx.page.current().nodes.find((n) => n.type === "gen").id;
      const carId = () => ctx.page.current().nodes.filter((n) => n.type === "recipe")[0].id;
      assert.equal(ctx.chipLabelAt(tailId(), 0), "跟随配方 文生视频",
        "车尾空着时胶囊上写的就是跟随配方那一份技能");
      assert.ok(ctx.view.nodeEl(carId()).querySelector(".ns-canvas-car-info")
        .textContent.includes("文生视频"), "车厢顶行写的是这一段生效的技能");
      await ctx.pickChip(tailId(), 0, "图生视频");
      assert.equal(ctx.page.current().nodes.find((n) => n.type === "gen").metadata.skill_id, "h3_i2v",
        "车尾选一枚就盖在整列上");
      click(ctx.genBtn(tailId(), "生成视频"));
      await deepSettle();
      assert.equal(clipCalls("/neo_video_gen/run_segment")[0].body.skill_id, "h3_i2v",
        "发出去的那一发整列走车尾那一枚");
    });

    test("车尾分辨率空着 = 跟配方共享那一份；选一枚 = 整列出片用它", async () => {
      const ctx = await genPage([], [], { routes: clipRoutes() });
      await layTrain(ctx);
      const tailId = () => ctx.page.current().nodes.find((n) => n.type === "gen").id;
      assert.equal(ctx.chipLabelAt(tailId(), 1), "跟随配方 1344×768",
        "空着时胶囊上写的就是配方共享的那一份");
      await ctx.pickChip(tailId(), 1, "1280×720 · 720p 横屏");
      const tail = ctx.page.current().nodes.find((n) => n.type === "gen");
      assert.deepEqual([tail.metadata.width, tail.metadata.height], [1280, 720],
        "选一枚就把整列出片的分辨率写进车尾");
      click(ctx.genBtn(tail.id, "生成视频"));
      await deepSettle();
      const body = clipCalls("/neo_video_gen/run_segment")[0].body;
      assert.deepEqual([body.width, body.height], [1280, 720], "发出去的那一发带着车尾选的分辨率");
      assert.equal(body.skill_id, "", "车尾没盖技能就交空值：每一段用配方里那一段自己那一个，由后端合并");
    });

    test("车厢顶行只一行：段号一枚、时长数框、配方名 · 技能与参考素材计数在同一行", async () => {
      const ctx = await genPage([], [], { routes: clipRoutes() });
      await layTrain(ctx);
      const carId = ctx.page.current().nodes.filter((n) => n.type === "recipe")[0].id;
      const head = ctx.view.nodeEl(carId).querySelector(".ns-canvas-car-head");
      assert.equal(head.querySelectorAll(".ns-canvas-car-seg").length, 1, "段号只写一枚");
      assert.equal(head.querySelector(".ns-canvas-car-seg").textContent, "段 1");
      assert.equal(head.querySelector(".ns-canvas-car-info").textContent,
        "短片配方 · 文生视频", "顶行那一行说完配方名与生效技能，时长不在这句里");
      assert.equal(head.querySelector(".ns-canvas-car-dur").value, "5",
        "这一段跑几秒就是顶行那一枚数框，值来自配方那一段");

      const car = ctx.page.current().nodes.filter((n) => n.type === "recipe")[0];
      // 计数 = 连进这一厢的素材节点（铺一列铺上来的）+ 配方里那一段写了、画布上没铺的那几份
      const state = ctx.page.current();
      const laid = state.nodes.filter((n) => n.metadata.asset
        && state.connections.some((c) => c.fromNodeId === n.id && c.toNodeId === car.id));
      assert.equal(head.querySelector(".ns-canvas-recipe-count").textContent,
        `${laid.length} 张参考素材`, "顶行数的就是连进这一厢生效的那几张，铺上来的不重复数");
      assert.ok(!ctx.view.nodeEl(carId).querySelector("select"),
        "车厢上没有技能 / 分辨率的下拉：整列共用的在车尾，这一段只有时长那一枚数框");
    });

    // 车厢顶行那一枚时长框：改了走后端写进配方那一段（画布不存这一份，重画读的就是文件里那一份）
    const carDur = (ctx, id) => ctx.view.nodeEl(id).querySelector(".ns-canvas-car-dur");
    const setCarDur = async (ctx, id, value) => {
      const el = carDur(ctx, id);
      el.value = value;
      fire(el, "change");
      await deepSettle();
    };
    // 每一发用例领一份配方副本：写成功时 helper 会把那一段改掉，不串到后面的用例
    const durRoutes = (impl) => ({ ...clipRoutes({ recipes: [structuredClone(RECIPE_ROW)] }),
      "/rs_recipes/set_segment_duration": impl });
    const durOk = (body) => jsonResponse({ success: true, name: body.name, segment: body.segment,
      duration_sec: body.duration_sec });
    const firstCar = (ctx) => ctx.page.current().nodes.filter((n) => n.type === "recipe")[0].id;

    test("车厢时长框改了那一发就写进配方：只带配方名 + 段号 + 秒数，只动这一段", async () => {
      const ctx = await genPage([], [], { routes: durRoutes(durOk) });
      await layTrain(ctx);
      const cars = ctx.page.current().nodes.filter((n) => n.type === "recipe");
      assert.equal(carDur(ctx, cars[0].id).value, "5", "框里就是配方那一段的时长");
      await setCarDur(ctx, cars[0].id, "12");
      assert.deepEqual(clipCalls("/rs_recipes/set_segment_duration").map((c) => c.body),
        [{ name: "短片配方", segment: 0, duration_sec: 12 }], "那一发只带配方名、段号与秒数");
      assert.equal(carDur(ctx, cars[0].id).value, "12", "写成功当场把新时长铺回这一厢");
      assert.equal(carDur(ctx, cars[1].id).value, "8", "只写这一段的时长，第二厢那一枚不动");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("第 1 段：12 秒")),
        "写成了当场说一声");
    });

    test("时长框填回配方里那一个数不打后端；越界钳到上限；后端拒了就退回配方那一份并说清原因", async () => {
      const ctx = await genPage([], [], { routes: durRoutes(durOk) });
      await layTrain(ctx);
      const carId = firstCar(ctx);
      await setCarDur(ctx, carId, "5");
      assert.equal(clipCalls("/rs_recipes/set_segment_duration").length, 0,
        "与配方一字不差就不写盘");
      await setCarDur(ctx, carId, "9000");
      assert.equal(clipCalls("/rs_recipes/set_segment_duration")[0].body.duration_sec, 3600,
        "越界先钳到上限再写盘");
      assert.equal(carDur(ctx, carId).value, "3600", "框里就是钳过之后落盘的那一份");

      const bad = await genPage([], [], { routes: durRoutes(() => jsonResponse(
        { success: false, error: "内置预设配方只读：请先「复制配方」" }, 403)) });
      await layTrain(bad);
      const badCar = firstCar(bad);
      await setCarDur(bad, badCar, "12");
      assert.equal(carDur(bad, badCar).value, "5",
        "没写进去就不在画布上留一份配方里没有的时长");
      assert.ok(bad.env.store.toasts.some((item) => item.message.includes("内置预设配方只读")),
        "toast 里带上后端给的原因");
    });

    test("这一列在跑着就锁着时长框：跑着的一发不改段时长", async () => {
      const ctx = await genPage([], [], { routes: { ...durRoutes(durOk),
        "/neo_video_gen/run_segment/*": () => jsonResponse({ success: true, task_id: "seg-1",
          status: "running", progress: { value: 1, max: 12 } }) } });
      await layTrain(ctx);
      const tail = ctx.page.current().nodes.find((n) => n.type === "gen");
      const carId = firstCar(ctx);
      assert.equal(carDur(ctx, carId).disabled, false, "没在跑就开着");
      click(ctx.genBtn(tail.id, "生成视频"));
      await deepSettle();
      assert.equal(carDur(ctx, carId).disabled, true, "这一发在跑就锁着这枚框");
      assert.equal(carDur(ctx, carId).value, "5", "锁着时框里还是配方那一段的时长");
    });

    // 全参考那一段写了图 / 参考视频 / 参考音频：铺一列要把三样都铺成素材节点接进厢
    const MEDIA_ROW = { name: "全参考配方", title: "全参考", source: "mine", type: "video_director",
      canvas_id: "", shared: { mode: "r2v", width: 1344, height: 768 },
      segments: [{ title: "开场", skill_id: "h3_r2v", duration_sec: 5, prompt: "开场正文",
        refs: { images: ["角色.png"], videos: ["动作参考.mp4"], audios: ["旁白.mp3"] } }] };
    const mediaRoutes = () => clipRoutes({ recipes: [MEDIA_ROW] });
    const laidByType = (ctx, type) => ctx.page.current().nodes.filter((n) => n.type === type);

    test("铺一列把这一段写的参考视频与参考音频也铺成素材节点，按连线接进厢", async () => {
      const ctx = await genPage([], [], { routes: mediaRoutes() });
      await layTrain(ctx);
      const state = ctx.page.current();
      const car = state.nodes.find((n) => n.type === "recipe");
      assert.deepEqual(laidByType(ctx, "image").map((n) => n.metadata.asset), ["角色.png"]);
      assert.deepEqual(laidByType(ctx, "video_in").map((n) => n.metadata.asset), ["动作参考.mp4"]);
      assert.deepEqual(laidByType(ctx, "audio_in").map((n) => n.metadata.asset), ["旁白.mp3"]);
      for (const type of ["image", "video_in", "audio_in"]) {
        const node = laidByType(ctx, type)[0];
        assert.ok(state.connections.some((c) => c.fromNodeId === node.id && c.toNodeId === car.id),
          `${type} 要按连线接进自己那一厢`);
        assert.equal(node.metadata.recipe, "全参考配方", "铺出来的素材节点带自己那一份配方出处");
      }
      // 三样都在厢上方同一行里排开，落在厢的正上方
      const row = ["image", "video_in", "audio_in"].map((type) => laidByType(ctx, type)[0]);
      assert.ok(row.every((n) => n.position.y + n.height <= car.position.y), "素材行在厢的正上方");
      const lefts = row.map((n) => n.position.x);
      assert.deepEqual([...lefts].sort((a, b) => a - b), lefts, "一行里从左到右排开：图 → 参考视频 → 参考音频");
      // 视频与音频节点播的是配方 assets/ 里那一份（不经 input/ 的 gallery 那两条路由）
      const videoSrc = ctx.view.nodeEl(row[1].id).querySelector("video").getAttribute("src");
      assert.match(videoSrc, /^\/rs_recipes\/asset\?recipe=[^&]+&file=[^&]+&dir=assets$/,
        "参考视频播的是配方自己那一份文件");
      const audioSrc = ctx.view.nodeEl(row[2].id).querySelector("audio").getAttribute("src");
      assert.match(audioSrc, /^\/rs_recipes\/asset\?recipe=[^&]+&file=[^&]+&dir=assets$/,
        "参考音频播的是配方自己那一份文件");
      assert.equal(ctx.view.nodeEl(car.id).querySelector(".ns-canvas-recipe-count").textContent,
        "3 张参考素材", "顶行计数把三样各数一份，铺上来的不重复数");
    });

    test("串联出片那一发把连进厢的参考视频与参考音频按三桶交后端", async () => {
      const ctx = await genPage([], [], { routes: mediaRoutes() });
      await layTrain(ctx);
      const tail = ctx.page.current().nodes.find((n) => n.type === "gen");
      click(ctx.genBtn(tail.id, "生成视频"));
      await deepSettle();
      const body = clipCalls("/neo_video_gen/run_segment")[0].body;
      assert.deepEqual(body.references, {
        images: [{ kind: "recipe", value: "角色.png", recipe: "全参考配方" }],
        videos: [{ kind: "recipe", value: "动作参考.mp4", recipe: "全参考配方" }],
        audios: [{ kind: "recipe", value: "旁白.mp3", recipe: "全参考配方" }],
      }, "三桶各归各的，出处是配方 assets/ 里那一份");
    });



    test("车尾「参数」弹窗：整列共用的次要点收在这里，改种子当场落盘，Esc 收窗", async () => {
      const ctx = await genPage([], [], { routes: clipRoutes() });
      await layTrain(ctx);
      const tail = ctx.page.current().nodes.find((n) => n.type === "gen");
      assert.ok(!ctx.view.nodeEl(tail.id).querySelector(".ns-canvas-gen-ctl select option[value=\"-1\"]"),
        "步数 / 锚点那些下拉不铺在车尾卡上");
      click(ctx.genBtn(tail.id, "参数"));
      await settle();
      const form = () => ctx.host.querySelector(".ns-canvas-tailform");
      assert.ok(form(), "弹窗开在页面那一层");
      assert.deepEqual([...form().querySelectorAll(".ns-canvas-tailform-label")].map((el) => el.textContent),
        ["步数", "锚点", "连续性", "上下文帧", "种子"], "弹窗里就是这五项");
      const seed = form().querySelector(".ns-canvas-recipe-seed");
      seed.value = "7";
      fire(seed, "change");
      await settle();
      assert.equal(ctx.page.current().nodes.find((n) => n.type === "gen").metadata.seed, 7,
        "种子走 patchMeta：落进车尾那一台并随画布落盘");
      const formChips = [...form().querySelectorAll(".neo-gallery-gm-chip-btn")];
      assert.equal(formChips.length, 4, "步数 / 锚点 / 连续性 / 上下文帧各一枚胶囊");
      click(formChips[1]);
      await settle();
      assert.ok(form().querySelector(".ns-canvas-tailform-menus .neo-gallery-gm-chip-menu"),
        "弹窗里的下拉开在弹窗自己那一层：画布那一层在弹窗底下，菜单进那一层就看不见");
      assert.equal(ctx.host.querySelector(".ns-canvas-gen-menus .neo-gallery-gm-chip-menu"), null,
        "弹窗的菜单不落画布那一层");
      click([...form().querySelectorAll(".neo-gallery-gm-menu-item")]
        .find((el) => el.textContent === "只钉首帧"));
      await settle();
      assert.equal(ctx.page.current().nodes.find((n) => n.type === "gen").metadata.anchors, "first",
        "弹窗里选一锚点挡：走 patchMeta 落进车尾");
      assert.ok(form().querySelector(".ns-canvas-tailform-note").textContent.includes("在车厢上那一枚框里改"),
        "弹窗说清楚时长在车厢那一枚框上改");
      fire(document, "keydown", { key: "Escape" });
      await settle();
      assert.equal(ctx.host.querySelector(".ns-canvas-tailform-mask"), null, "Esc 收窗");
    });

    test("车尾生成节点上游没有车厢时说清楚：不发请求", async () => {
      const ctx = await genPage([videoGen("tail1", 0, { chain: "train", skill_id: "h3_t2v", recipe: "短片配方" })], [],
        { routes: clipRoutes() });
      await deepSettle();
      assert.ok(ctx.view.nodeEl("tail1").querySelector(".ns-canvas-car-info")
        .textContent.includes("链上 0 段"), "没有车厢可问时顶行就说这一列零段");
      click(ctx.genBtn("tail1", "生成视频"));
      await settle();
      assert.equal(clipCalls("/neo_video_gen/run_segment").length, 0);
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("上游没有车厢")));
    });

    test("切走画布停掉在出的片的轮询：卸页后不再问进度", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0), videoSlot("vid1", 700)],
        [link("t1", "v1"), link("v1", "vid1")],
        { gen: { canvases: [{ id: "canvas-0002", title: "乙", nodes: [], connections: [],
          viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" }] },
          routes: clipRoutes({ snaps: [{ success: true, task_id: "clip-1", status: "running",
            progress: { value: 3, max: 120 } }] }) });
      await deepSettle();
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      assert.equal(clipCalls("/neo_video_gen/simple").length, 1, "提交完先拉一格");
      assert.equal(clipPolls("clip-1").length, 1);
      pickCanvas(ctx.view, "canvas-0002");
      await settle();
      const polls = clipPolls("clip-1").length;
      await deepSettle();
      assert.equal(clipPolls("clip-1").length, polls, "切走画布停掉这一发的轮询");
    });

    // ===== 自定参数：这一发临时换的主模型 / LoRA / 步数（存 metadata.gen_params，随画布落盘）=====
    const IMAGE_MODELS = () => jsonResponse({
      diffusion_models: ["base/base.safetensors", "qwen/diffusion_qwen.safetensors"],
      text_encoders: ["base/te.safetensors"], vae: ["base/vae.safetensors"],
      loras: ["lora_a.safetensors"],
      mtimes_diffusion_models: {}, mtimes_text_encoders: {}, mtimes_vae: {}, mtimes_loras: {},
    });
    const VIDEO_MODELS = () => jsonResponse({
      diffusion_models: ["h3/h3_t2v.safetensors", "h3/h3_i2v.safetensors"],
      text_encoders: ["h3/h3_te.safetensors"], vae: ["h3/h3_vae.safetensors"],
      loras: ["lora_b.safetensors"],
      mtimes_diffusion_models: {}, mtimes_text_encoders: {}, mtimes_vae: {}, mtimes_loras: {},
    });
    // 技能那一枚就是绘画页 / 出视频页那枚共享技能弹窗：面板挂在页面那一层（.ns-canvas-gen-menus），
    // 节点每重画一次不收它，画布缩放也不裁它。节点上第一枚胶囊就是技能
    const openParams = async (ctx, id) => {
      click(ctx.chipAt(id, 0));
      await settle();
      return ctx.host.querySelector(".ns-canvas-gen-menus .neo-gallery-gm-skills-panel .neo-gallery-gm-model-box");
    };
    const pickField = (box, name) => {
      const sel = box.querySelector(".rs-model-select-box select");
      sel.value = name;
      fire(sel, "change");
    };

    test("自定参数读法：空串、-1 与空白 LoRA 名都是跟随，强度跟着名字走", () => {
      assert.deepEqual(params.readGenOverrides({ metadata: {} }), {}, "旧画布没有这一份");
      assert.deepEqual(params.readGenOverrides({ metadata: { gen_params: { model: "  ", steps: -1, loras: [""] } } }), {},
        "空值与 -1 都不进请求：后端按技能 config 与全局设置合并");
      assert.deepEqual(params.readGenOverrides({ metadata: { gen_params: {
        model: " qwen/diffusion_qwen.safetensors ", steps: "24", audio_vae: "h3/h3_vae.safetensors",
        loras: ["lora_a.safetensors", { name: "lora_b.safetensors", strength: 0.5 }, { name: "  " }] } } }),
        { model: "qwen/diffusion_qwen.safetensors", audio_vae: "h3/h3_vae.safetensors", steps: 24,
          loras: ["lora_a.safetensors", { name: "lora_b.safetensors", strength: 0.5 }] });
    });

    test("出图自定参数：弹窗里换主模型与加 LoRA 当场写进节点，出图请求带上这一发", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), genNode("g1", 0, 0)], [link("t1", "g1")],
        { gen: { skillConfig: { model: "base/base.safetensors", steps: 20 } },
          routes: { "/neo_image_gen/models": IMAGE_MODELS } });
      await deepSettle();
      assert.equal(ctx.genText("g1", "model"), "主模型：base · 停用 · 双击节点停用",
        "技能 config 钉的主模型铺在卡上（shortModelName 把「目录 = 文件名」那一种收成目录名）");
      const box = await openParams(ctx, "g1");
      assert.ok(box, "自定参数弹窗挂在页面那一层：节点重画不收它");
      assert.equal(box.querySelectorAll(".rs-gen-adv-row").length, 0,
        "出图只露主模型与 LoRA：Text Encoder / VAE 随高级行摘掉");
      pickField(box, "qwen/diffusion_qwen.safetensors");
      await settle();
      click(box.querySelector(".rs-gen-lora-add"));
      await settle();
      const loraSel = box.querySelector(".rs-gen-lora-row select");
      loraSel.value = "lora_a.safetensors";
      fire(loraSel, "change");
      await settle();
      const node = ctx.page.current().nodes.find((n) => n.id === "g1");
      assert.equal(node.metadata.gen_params.model, "qwen/diffusion_qwen.safetensors");
      assert.deepEqual(node.metadata.gen_params.loras, [{ name: "lora_a.safetensors", strength: 1 }]);
      assert.equal(ctx.genText("g1", "model"),
        "主模型：diffusion_qwen · LoRA ×1 · 停用 · 双击节点停用",
        "卡上那一行说的是这一发真正生效的那一套");
      click(ctx.genBtn("g1", "出图"));
      await settle();
      const body = genCalls()[0].body;
      assert.equal(body.model, "qwen/diffusion_qwen.safetensors");
      assert.deepEqual(body.loras, [{ name: "lora_a.safetensors", strength: 1 }]);
      click(ctx.view.button("撤销"));
      await settle();
      assert.deepEqual(ctx.page.current().nodes.find((n) => n.id === "g1").metadata.gen_params,
        { model: "qwen/diffusion_qwen.safetensors" }, "一次撤销退掉最后那一改（LoRA）");
      click(ctx.view.button("撤销"));
      await settle();
      assert.equal(ctx.page.current().nodes.find((n) => n.id === "g1").metadata.gen_params, undefined,
        "再撤一回落回这一发没改之前的样子：这一项压根没写过，跟着技能配置走");
    });

    test("没自定参数的节点出图不带 model / loras：旧画布那一发照旧走技能配置", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), genNode("g1", 0, 0)], [link("t1", "g1")],
        { gen: { skillConfig: { model: "base/base.safetensors", steps: 20 } },
          routes: { "/neo_image_gen/models": IMAGE_MODELS } });
      await deepSettle();
      click(ctx.genBtn("g1", "出图"));
      await settle();
      const body = genCalls()[0].body;
      assert.equal("model" in body, false, "没盖过主模型就不带这一项，交后端按技能 config 合并");
      assert.equal("loras" in body, false);
      assert.equal("steps" in body, false);
    });

    test("出片自定参数：弹窗里换生视频模型与步数，写进节点并进 /neo_video_gen/simple", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0)], [link("t1", "v1")],
        { gen: { skillConfig: { model: "h3/h3_t2v.safetensors", steps: 20 } },
          routes: { ...clipRoutes(), "/neo_video_gen/models": VIDEO_MODELS } });
      await deepSettle();
      const box = await openParams(ctx, "v1");
      assert.ok(box.querySelector(".rs-gen-steps"), "出片的自定参数带步数那一格");
      pickField(box, "h3/h3_i2v.safetensors");
      const steps = box.querySelector(".rs-gen-steps");
      steps.value = "24";
      fire(steps, "change");
      await settle();
      const node = ctx.page.current().nodes.find((n) => n.id === "v1");
      assert.deepEqual(node.metadata.gen_params, { model: "h3/h3_i2v.safetensors", steps: 24 },
        "与技能钉的那一份相同的值不落盘：跟着技能配置走");
      click(ctx.genBtn("v1", "生成视频"));
      await deepSettle();
      const body = clipCalls("/neo_video_gen/simple")[0].body;
      assert.equal(body.model, "h3/h3_i2v.safetensors");
      assert.equal(body.steps, 24);
      assert.equal("text_encoder" in body, false, "没动过的行不进请求");
    });

    test("换技能清掉这台节点的自定参数：技能钉的那一套整份换掉", async () => {
      const ctx = await genPage([promptNode("t1", "一句"),
        genNode("g1", 0, 0, { gen_params: { model: "qwen/diffusion_qwen.safetensors", loras: ["lora_a.safetensors"] } })],
      [link("t1", "g1")], {
        gen: { skills: [{ id: "image_gen", name: "出图", category: "image_gen", source: "preset", gen_image: true },
          { id: "t2i_fast", name: "快图", category: "image_gen", source: "preset", gen_image: true }],
          skillConfig: { model: "base/base.safetensors", steps: 20 } },
        routes: { "/neo_image_gen/models": IMAGE_MODELS } });
      await deepSettle();
      const sel = ctx.view.nodeEl("g1").querySelector(".ns-canvas-gen-skill select");
      sel.value = "t2i_fast";
      fire(sel, "change");
      await settle();
      const node = ctx.page.current().nodes.find((n) => n.id === "g1");
      assert.deepEqual(node.metadata.gen_params, {}, "换技能 = 这一发自定的那几项一起清");
      click(ctx.genBtn("g1", "出图"));
      await settle();
      assert.equal("model" in genCalls()[0].body, false, "下一发不再带着上一发钉的主模型");
    });

    test("车尾技能弹窗就是出视频页那一枚模型链：主模型写进车尾，整列每一段都带着这一发", async () => {
      const ctx = await genPage([], [], { gen: { skillConfig: { model: "h3/h3_t2v.safetensors", steps: 20 } },
        routes: { ...clipRoutes(), "/neo_video_gen/models": VIDEO_MODELS } });
      await layTrain(ctx);
      const tailId = () => ctx.page.current().nodes.find((n) => n.type === "gen").id;
      const box = await openParams(ctx, tailId());
      assert.ok(box, "车尾那一枚弹的是模型链那一整块：与出视频页同一块表单");
      assert.ok(box.querySelector(".rs-model-select-box select"), "右栏第一行就是生视频模型");
      assert.ok(box.querySelector(".rs-gen-lora-add"), "LoRA 那一行也在");
      assert.equal(box.querySelector(".rs-gen-steps"), null, "步数不在这枚上：整列那一份在「参数」弹窗里");
      pickField(box, "h3/h3_i2v.safetensors");
      await settle();
      const tail = ctx.page.current().nodes.find((n) => n.type === "gen");
      assert.equal(tail.metadata.gen_params.model, "h3/h3_i2v.safetensors", "主模型写进车尾那一台");
      click(ctx.genBtn(tail.id, "生成视频"));
      await deepSettle();
      const calls = clipCalls("/neo_video_gen/run_segment");
      assert.equal(calls.length, 2, "两段各发一段");
      assert.deepEqual(calls.map((c) => c.body.model),
        ["h3/h3_i2v.safetensors", "h3/h3_i2v.safetensors"], "整列每一段都带着车尾这一发主模型");
    });

    test("技能弹窗里换技能：整层重画完在原处接着弹开，面板不在节点壳里（缩放与裁剪切不到它）", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), genNode("g1", 0, 0)], [link("t1", "g1")], {
        gen: { skills: [{ id: "image_gen", name: "出图", category: "image_gen", source: "preset", gen_image: true },
          { id: "t2i_fast", name: "快图", category: "image_gen", source: "preset", gen_image: true }],
          skillConfig: { model: "base/base.safetensors", steps: 20 } },
        routes: { "/neo_image_gen/models": IMAGE_MODELS } });
      await deepSettle();
      const panel = () => ctx.host.querySelector(".ns-canvas-gen-menus .neo-gallery-gm-skills-panel");
      await openParams(ctx, "g1");
      assert.ok(panel(), "面板挂在页面那一层");
      assert.ok(!ctx.view.nodeEl("g1").contains(panel()), "面板不在节点壳里：画布缩放与节点裁剪都切不到它");
      click([...panel().querySelectorAll(".neo-gallery-gm-skill-item")]
          .find((el) => el.textContent.includes("快图")));
      await settle();
      assert.ok(panel(), "换技能要走一次整层重画，重画完面板在原处接着弹开");
      assert.equal(panel().querySelector(".neo-gallery-gm-skill-item.neo-gallery-gm-menu-on")?.textContent,
        "快图", "弹回来时选中的就是新技能那一套");
      assert.deepEqual(ctx.page.current().nodes.find((n) => n.id === "g1").metadata.gen_params, {},
        "换技能把这一发自定的那几项一起清");
    });

    test("这一发在跑时技能弹窗整块收控件，整列取消当场恢复", async () => {
      // 第二段的入队卡在闸门后：整列停在「跑着」那一档（画布用例的 flush 不推定时器，收摊只能走整列取消）
      let seq = 0;
      let releaseGate;
      const gate = new Promise((done) => { releaseGate = done; });
      const ctx = await genPage([], [], { routes: { ...clipRoutes(),
        "/neo_video_gen/run_segment": async () => {
          if (++seq === 2) await gate;
          return jsonResponse({ success: true, task_id: `chain-${seq}`, status: "queued" });
        },
        "/neo_video_gen/models": VIDEO_MODELS } });
      await layTrain(ctx);
      const tailId = () => ctx.page.current().nodes.find((n) => n.type === "gen").id;
      const panel = () => ctx.host.querySelector(".ns-canvas-gen-menus .neo-gallery-gm-skills-panel");
      await openParams(ctx, tailId());
      assert.ok(!panel().classList.contains("ns-canvas-params-busy"), "没在跑不收控件");
      click(ctx.genBtn(tailId(), "生成视频"));
      await settle();
      assert.equal(ctx.genText(tailId(), "status"), "串联出片 1/2", "整列停在跑着那一档");
      assert.ok(panel(), "整列在跑，开着的面板跟着整层重画还在原处");
      assert.ok(panel().classList.contains("ns-canvas-params-busy"),
        "面板挂上这一发在跑那一档：两栏的指针事件由 CSS 收掉（style.css）");
      click(ctx.genBtn(tailId(), "取消任务"));
      await settle();
      releaseGate();
      await deepSettle();
      assert.ok(panel(), "整列取消重画完面板还在原处");
      assert.ok(!panel().classList.contains("ns-canvas-params-busy"), "取消当场摘掉那一档");
    });

    test("删掉节点与切走画布把开着的面板一起收掉", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), genNode("g1", 0, 0)], [link("t1", "g1")],
        { gen: { canvases: [{ id: "canvas-0002", title: "乙", nodes: [], connections: [],
          viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" }] },
          routes: { "/neo_image_gen/models": IMAGE_MODELS } });
      await deepSettle();
      const panel = () => ctx.host.querySelector(".ns-canvas-gen-menus .neo-gallery-gm-skills-panel");
      await openParams(ctx, "g1");
      assert.ok(panel(), "面板开着");
      click(nodeAct(ctx.view, "g1", "delete"));
      await settle();
      assert.equal(panel(), null, "删掉节点：控件整份重建，面板跟着收");
      pickCanvas(ctx.view, "canvas-0002");
      await settle();
      assert.equal(panel(), null, "切走画布：这一层里没有节点认得它了");
    });

    describe("图像编辑节点：连过来的图与提示词，节点只管选技能与出图", () => {
      // 编辑链认的是吃参考图的技能：纯文生图那一张在列表里，专门用来验「不吃参考图就说清楚」那一发
      const EDIT_SKILLS = [
        { id: "image_gen", name: "出图", category: "image_gen", source: "preset", gen_image: true, mode: "t2i" },
        { id: "qwen_image_21", name: "Qwen 编辑", category: "image_gen", source: "preset", gen_image: true, mode: "t2i_edit" },
      ];
      const editNode = (id, x, y, meta = {}) => ({ id, type: "edit", title: "图像编辑",
        position: { x, y }, width: 320, height: 208, metadata: { skill_id: "qwen_image_21", ...meta } });
      const metaOf = (ctx, id) => ctx.page.current().nodes.find((n) => n.id === id).metadata;

      test("加图像编辑节点：卡上只有控件行与状态行，默认技能落在吃参考图的那一张", async () => {
        const ctx = await genPage([], [], { gen: { skills: EDIT_SKILLS } });
        click(ctx.view.button("加图像编辑节点"));
        await settle();
        const node = ctx.page.current().nodes.at(-1);
        assert.deepEqual([node.type, node.metadata.skill_id], ["edit", "qwen_image_21"],
          "编辑节点不跟「加图像生成节点」记的上一次：那一档记的是出图技能，吃不吃参考图两回事");
        const el = ctx.view.nodeEl(node.id);
        assert.ok(el.querySelector(".ns-canvas-gen-ctl"), "控件行铺在节点上");
        assert.ok(ctx.genBtn(node.id, "出图"), "控件行最后一枚是出图");
        assert.equal(el.querySelector("textarea"), null, "这张节点上不进正文 —— 提示词从连过来的节点取");
        assert.equal(el.querySelector(".ns-canvas-node-img"), null, "这张节点上不进图 —— 被改的那一张从连过来的节点取");
        assert.deepEqual(barActs(ctx.view, node.id), ["disable", "copy", "delete"],
          "这一排是停用 / 复制 / 删除 —— 编辑节点没有选图位，也没有提示词位");
      });

      test("出图载荷：连过来的图片按连线顺序进参考，提示词就是连过来的那几条正文", async () => {
        const ctx = await genPage([promptNode("t1", "把外套换成红色"), promptNode("t2", "背景换成地下铁"),
          imageSlot("i1", 500), imageSlot("i2", 900), editNode("e1", 0, 0, { count: 2 })],
        [link("t1", "e1"), link("t2", "e1"), link("i1", "e1"), link("i2", "e1")], { gen: { skills: EDIT_SKILLS } });
        Object.assign(metaOf(ctx, "i1"), { filename: "a.png" });
        Object.assign(metaOf(ctx, "i2"), { filename: "b.png", subfolder: "sub" });
        click(ctx.genBtn("e1", "出图"));
        await settle();
        const body = genCalls()[0].body;
        assert.equal(body.prompt, "把外套换成红色\n\n背景换成地下铁", "提示词按连线顺序拼");
        assert.deepEqual(body.references.map((r) => r.value), ["a.png[output]", "sub/b.png[output]"],
          "连过来的第一张就是被改的那一张，后面的依次跟上");
        assert.deepEqual([body.skill_id, body.count, body.skip_enhance], ["qwen_image_21", 2, true],
          "目标尺寸不在节点上钉：跟着技能配置与全局生图设置");
      });

      test("同一张图片连两条线只算一份参考", async () => {
        const ctx = await genPage([promptNode("t1", "改背景"), imageSlot("i1", 500), editNode("e1", 0, 0)],
          [link("t1", "e1"), link("i1", "e1"), link("i1", "e1")], { gen: { skills: EDIT_SKILLS } });
        Object.assign(metaOf(ctx, "i1"), { filename: "a.png" });
        click(ctx.genBtn("e1", "出图"));
        await settle();
        assert.deepEqual(genCalls()[0].body.references.map((r) => r.value), ["a.png[output]"]);
      });

      test("没连图片：说把要编辑的那一张连过来，不发请求", async () => {
        const ctx = await genPage([promptNode("t1", "改背景"), editNode("e1", 0, 0)], [],
          { gen: { skills: EDIT_SKILLS } });
        click(ctx.genBtn("e1", "出图"));
        await settle();
        assert.equal(genCalls().length, 0);
        assert.ok(ctx.env.store.toasts.some((i) => i.message.includes("把要编辑的那一张图片节点连过来")));
      });

      test("没连提示词：说把要用的提示词连过来，不发请求", async () => {
        const ctx = await genPage([imageSlot("i1", 500), editNode("e1", 0, 0)], [link("i1", "e1")],
          { gen: { skills: EDIT_SKILLS } });
        Object.assign(metaOf(ctx, "i1"), { filename: "a.png" });
        click(ctx.genBtn("e1", "出图"));
        await settle();
        assert.equal(genCalls().length, 0);
        assert.ok(ctx.env.store.toasts.some((i) => i.message.includes("把要用的提示词节点连过来")));
      });

      test("技能不吃参考图：说换一张技能，不发请求", async () => {
        const ctx = await genPage([promptNode("t1", "改背景"), imageSlot("i1", 500),
          editNode("e1", 0, 0, { skill_id: "image_gen" })],
        [link("t1", "e1"), link("i1", "e1")], { gen: { skills: EDIT_SKILLS } });
        Object.assign(metaOf(ctx, "i1"), { filename: "a.png" });
        click(ctx.genBtn("e1", "出图"));
        await settle();
        assert.equal(genCalls().length, 0);
        assert.ok(ctx.env.store.toasts.some((i) => i.message.includes("不吃参考图")));
      });

      test("离线按出图：只说去哪儿启队列，不拉内核", async () => {
        const ctx = await genPage([promptNode("t1", "改背景"), imageSlot("i1", 500), editNode("e1", 0, 0)],
          [link("t1", "e1"), link("i1", "e1")], { gen: { skills: EDIT_SKILLS }, extraHost: { can: () => false } });
        Object.assign(metaOf(ctx, "i1"), { filename: "a.png" });
        click(ctx.genBtn("e1", "出图"));
        await settle();
        assert.equal(genCalls().length, 0);
        assert.equal(ctx.env.starts.length, 0, "出图不叫宿主拉内核：与生成节点那一发同一口径");
        assert.ok(ctx.env.store.toasts.some((i) => i.message.includes("点顶栏 ComfyUI 胶囊启动")));
      });

      test("卡上就技能胶囊与张数胶囊两枚，跑起来状态行写编辑中", async () => {
        const ctx = await genPage([promptNode("t1", "改背景"), imageSlot("i1", 500), editNode("e1", 0, 0)],
          [link("t1", "e1"), link("i1", "e1")], { gen: { skills: EDIT_SKILLS } });
        Object.assign(metaOf(ctx, "i1"), { filename: "a.png" });
        assert.deepEqual([ctx.chipLabelAt("e1", 0), ctx.chipLabelAt("e1", 1)], ["Qwen 编辑", "1 张"],
          "比例与长边不在编辑节点上摆：这一发的尺寸跟着技能配置走");
        click(ctx.genBtn("e1", "出图"));
        await deepSettle();
        assert.ok(ctx.genText("e1", "status").startsWith("编辑中"), ctx.genText("e1", "status"));
        assert.ok(ctx.genBtn("e1", "取消任务"), "跑着的时候要给出取消的入口");
        dispatchApiEvent("rs.image_gen.status", { task_id: "gen-1", status: "failed", error: "显存不足" });
        await settle();
        assert.equal(ctx.genText("e1", "status"), "显存不足");
        assert.ok(ctx.env.store.toasts.some((i) => i.message.includes("出图失败")));
      });

      test("编辑结果按连线顺序落下游图片节点，撤销一次退掉这一发", async () => {
        const ctx = await genPage([promptNode("t1", "改背景"), imageSlot("s0", 900),
          editNode("e1", 0, 0, { count: 2 }), imageSlot("i1", 500)],
        [link("t1", "e1"), link("s0", "e1"), link("e1", "i1")], { gen: { skills: EDIT_SKILLS } });
        Object.assign(metaOf(ctx, "s0"), { filename: "a.png" });
        click(ctx.genBtn("e1", "出图"));
        await deepSettle();
        dispatchApiEvent("rs.image_gen.status", okImages(2));
        await settle();
        assert.equal(metaOf(ctx, "i1").filename, "o1.png", "空着的槽位按连线顺序填");
        const created = ctx.page.current().nodes.filter((n) => n.type === "image" && n.id !== "i1" && n.id !== "s0");
        assert.deepEqual(created.map((n) => n.metadata.filename), ["o2.png"]);
        assert.ok(ctx.page.current().connections.some((c) => c.fromNodeId === "e1" && c.toNodeId === created[0].id),
          "多出来的那一张新建图片节点接在这张编辑节点上");
        click(ctx.view.button("撤销"));
        await settle();
        assert.equal(metaOf(ctx, "i1").filename, undefined, "撤销一次退掉这一发落下的全部图");
      });
    });

  });

  // ====== 画布上的增强节点与反推节点（LLM 链在画布上的那两张卡） ======
  describe("画布上的增强节点与反推节点：成文写进下游空的提示词节点", () => {
    // 增强链的技能池就是首页「提示词增强」那一条判法（category image_enhance / enhance，且不吃生图与配方）
    const LLM_SKILLS = [
      { id: "image_gen", name: "出图", category: "image_gen", source: "preset", gen_image: true, gen_video: false },
      { id: "zh_enh", name: "zh_enh", cn_name: "中文增强", category: "image_enhance", source: "preset" },
      { id: "en_enh", name: "en_enh", cn_name: "英文增强", category: "image_enhance", source: "preset" },
    ];
    const ENH_OUT = "增强出来的那一段正文";
    const REV_OUT = "反推出来的那一段正文";
    const ENH_PATH = "/rs_prompts/stream_generate_prompt";
    const REV_PATH = "/rs_prompts/reverse_prompt";

    const enhNode = (id, x, metadata = {}) => ({ id, type: "enhance", title: "增强",
      position: { x, y: 40 }, width: 320, height: 168, metadata: { skill_id: "", ...metadata } });
    const revNode = (id, x, metadata = {}) => ({ id, type: "reverse", title: "反推",
      position: { x, y: 40 }, width: 320, height: 168, metadata: { language: "zh", ...metadata } });
    const textNode = (id, x, y, content = "", metadata = {}) => ({ id, type: "text", title: `提示词 ${id}`,
      position: { x, y }, width: 340, height: 240, metadata: { content, ...metadata } });
    const picNode = (id, x, metadata = { filename: "a.png" }) => ({ id, type: "image", title: `图片 ${id}`,
      position: { x, y: 300 }, width: 340, height: 240, metadata });
    const llmLink = (from, to) => ({ id: `lc-${from}-${to}`, fromNodeId: from, toNodeId: to });
    const llmCanvas = (nodes, connections, id = "canvas-0001", title = "甲") =>
      ({ id, title, nodes, connections, viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" });
    const sseLine = (frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}`;
    const llmSse = (lines) => new Response(lines.map((l) => `${l}\n`).join(""),
      { status: 200, headers: { "Content-Type": "text/event-stream" } });

    // 跑到一半的那一条流：交一份认 signal 的在途 SSE，最后一块后面永不落 ——「取消这一发」与「切画布脱手」
    // 都发生在正文只到一半的时候；abort 一到就交 done，读流那一条跟着收摊
    const inflightSse = (frames) => (_body, call) => ({
      ok: true, status: 200, json: async () => ({}),
      body: { getReader: () => {
        let i = 0;
        return {
          read: async () => (i < frames.length
            ? { done: false, value: new TextEncoder().encode(`${sseLine(frames[i++])}\n`) }
            : new Promise((res) => {
              if (call.signal?.aborted) return res({ done: true });
              call.signal?.addEventListener("abort", () => res({ done: true }));
            })),
          releaseLock() {},
        };
      } },
    });

    async function llmPage(nodes, connections, { skills = LLM_SKILLS, canvases = [],
      enhance, reverse, enhanceResponder, reverseResponder, extraHost = {} } = {}) {
      fetchLog.length = 0;
      const env = mockCanvas({ projects: [llmCanvas(nodes, connections), ...canvases] });
      Object.assign(env.routes, {
        "/rs_prompts/skills": () => jsonResponse(skills),
        [ENH_PATH]: enhanceResponder
          || (() => llmSse((enhance || [{ text: ENH_OUT }, "[DONE]"]).map(sseLine))),
        [REV_PATH]: reverseResponder
          || (() => llmSse((reverse || [{ text: REV_OUT }, "[DONE]"]).map(sseLine))),
      });
      const ctx = await makePage(env, { can: () => true, ...extraHost });
      await settle();
      const genText = (id, part) => ctx.view.nodeEl(id)?.querySelector(`.ns-canvas-gen-${part}`)?.textContent || "";
      const genBtn = (id, label) => [...ctx.view.nodeEl(id).querySelectorAll(".ns-canvas-gen-btn")]
        .find((btn) => btn.textContent.trim() === label);
      const chipOptions = (id) => [...ctx.view.nodeEl(id)
        .querySelectorAll(".ns-canvas-gen-skill select option")].map((opt) => opt.textContent);
      const chipLabel = (id) => ctx.view.nodeEl(id)
        .querySelector(".ns-canvas-gen-skill .neo-gallery-gm-chip-label")?.textContent || "";
      // 胶囊的菜单挂在节点浮层那一级（节点在带 scale 的世界层里，菜单落在节点外面才不跟着缩放）
      const chipItems = () => [...document.body.querySelectorAll(".ns-canvas-gen-menus .neo-gallery-gm-menu-item")];
      const pickChip = async (id, label) => {
        click(ctx.view.nodeEl(id).querySelector(".ns-canvas-gen-skill .neo-gallery-gm-chip-btn"));
        await settle();
        click(chipItems().find((el) => el.textContent === label));
        await settle();
      };
      // 流是 fetch 之后一层层 await 出来的：光收微任务收不到帧，跑流的那几步用真实定时器等一拍
      const tick = async () => { await new Promise((r) => setTimeout(r, 30)); await settle(); };
      const run = async (id, label) => { click(genBtn(id, label)); await tick(); };
      const content = (id) => ctx.page.current().nodes.find((n) => n.id === id)?.metadata.content;
      const sent = (path) => fetchLog.filter((c) => c.path === path).map((c) => c.body);
      return { ...ctx, genText, genBtn, chipOptions, chipLabel, pickChip, content, sent, run, tick, chipItems };
    }

    test("加文本增强节点：节点上不写正文，只有一枚增强技能胶囊与「增强」钮，默认落「后端智能判断」", async () => {
      const ctx = await llmPage([]);
      click(ctx.view.button("加文本增强节点"));
      await settle();
      const node = ctx.page.current().nodes[0];
      assert.equal(node.type, "enhance");
      assert.deepEqual([node.width, node.height], [320, 168]);
      assert.equal(node.metadata.skill_id, "", "默认让后端按提示词语言挑增强技能");
      const el = ctx.view.nodeEl(node.id);
      assert.ok(el.querySelector(".ns-canvas-gen"), "增强节点走生成节点那张卡的骨架与控件行");
      assert.equal(el.querySelectorAll("textarea").length, 0, "要增强的是连过来的那一段，节点上不写正文");
      assert.deepEqual([...el.querySelectorAll("[data-node-act]")].map((btn) => btn.dataset.nodeAct),
        ["disable", "copy", "delete"], "增强节点上没有选图与设为主图那两枚");
      assert.deepEqual(ctx.chipOptions(node.id), ["智能判断", "中文增强", "英文增强"],
        "技能胶囊只列增强链那三条（与首页「提示词增强」同一判法），生图技能不在里头");
      assert.equal(ctx.chipLabel(node.id), "默认", "留空那一档在胶囊上就说「默认」：挑哪一条是后端的事");
      assert.ok(ctx.genBtn(node.id, "增强").classList.contains("ns-canvas-gen-go"));
      assert.equal(ctx.genText(node.id, "status"), "", "没在跑就不出状态行");
    });

    test("加图片反推节点：节点上不摆图，只有一枚语言胶囊与「反推」钮，默认中文", async () => {
      const ctx = await llmPage([]);
      click(ctx.view.button("加图片反推节点"));
      await settle();
      const node = ctx.page.current().nodes[0];
      assert.equal(node.type, "reverse");
      assert.equal(node.metadata.language, "zh");
      const el = ctx.view.nodeEl(node.id);
      assert.equal(el.querySelectorAll("img").length, 0, "要反推的是连过来的那一张图片节点，节点上不摆图");
      assert.deepEqual(ctx.chipOptions(node.id), ["中文", "英文"], "语言就是反推页那一对取值");
      assert.equal(ctx.chipLabel(node.id), "中文");
      assert.ok(ctx.genBtn(node.id, "反推").classList.contains("ns-canvas-gen-go"));
    });

    test("增强一发：连过来的正文按连线顺序拼一段交链，技能照节点上选的，成文只写下游第一个空正文节点", async () => {
      const ctx = await llmPage([
        textNode("t1", -760, 0, "第一段"),
        textNode("t2", -760, 300, "第二段"),
        enhNode("e1", -340, { skill_id: "zh_enh" }),
        textNode("o1", 40, 0, ""),
        textNode("o2", 40, 300, "已填过的正文"),
      ], [llmLink("t1", "e1"), llmLink("t2", "e1"), llmLink("e1", "o1"), llmLink("e1", "o2")]);
      click(ctx.genBtn("e1", "增强"));
      await settle();
      assert.deepEqual(ctx.sent(ENH_PATH),
        [{ text: "第一段\n\n第二段", skillId: "zh_enh", reasoning_effort: "medium" }]);
      assert.equal(ctx.content("o1"), ENH_OUT, "成文写进下游第一个空的提示词节点");
      assert.equal(ctx.content("o2"), "已填过的正文", "下游填过的正文一个字都不盖");
      assert.ok(ctx.env.store.toasts.some((i) => i.message === "已增强出提示词" && i.kind === "success"));
      assert.equal(ctx.genText("e1", "status"), "", "跑完收回状态行");
      assert.equal(ctx.genBtn("e1", "增强").disabled, false, "跑完的节点上能直接再按");
    });

    test("技能留空 = 后端智能判断：载荷里不带 skillId；换技能落在节点 metadata 上，撤销一次退回去", async () => {
      const ctx = await llmPage([textNode("t1", -760, 0, "写一段夜景"), enhNode("e1", -340)], [llmLink("t1", "e1")]);
      click(ctx.genBtn("e1", "增强"));
      await settle();
      assert.deepEqual(ctx.sent(ENH_PATH)[0], { text: "写一段夜景", reasoning_effort: "medium" },
        "空串不进载荷（与首页「提示词增强」留空同一档）");
      await ctx.pickChip("e1", "中文增强");
      assert.equal(ctx.page.current().nodes.find((n) => n.id === "e1").metadata.skill_id, "zh_enh");
      assert.equal(ctx.chipLabel("e1"), "中文增强");
      click(ctx.genBtn("e1", "增强"));
      await settle();
      assert.equal(ctx.sent(ENH_PATH)[1].skillId, "zh_enh");
      click(ctx.view.button("撤销"));   // 这一发的写回先退掉（下游没有空位，新建的那一张整张撤走）
      await settle();
      click(ctx.view.button("撤销"));   // 再退一次才回到换技能之前：撤销栈按压栈的次序一层层退
      await settle();
      assert.equal(ctx.page.current().nodes.find((n) => n.id === "e1").metadata.skill_id, "",
        "两次撤销退完这一发与换技能那一格：技能回到留空");
    });

    test("增强没连正文：说一句不发包", async () => {
      const ctx = await llmPage([enhNode("e1", -340), textNode("o1", 40, 0, "")], [llmLink("e1", "o1")]);
      click(ctx.genBtn("e1", "增强"));
      await settle();
      assert.ok(ctx.env.store.toasts.some((i) => i.message === "把要增强的提示词节点连过来" && i.kind === "info"));
      assert.equal(ctx.sent(ENH_PATH).length, 0);
      assert.equal(ctx.genText("e1", "status"), "", "不收摊不写状态行");
    });

    test("反推一发：吃连线顺序里第一张启用的图，subfolder 与语言照节点上选的，成文落下游空正文节点", async () => {
      const ctx = await llmPage([
        picNode("i1", -760, { filename: "z.png", subfolder: "videos", disabled: true }),
        picNode("i2", -400, { filename: "a.png", subfolder: "人物" }),
        picNode("i3", -40, { filename: "b.png" }),
        revNode("r1", 300, { language: "en" }),
        textNode("o1", 700, 0, ""),
      ], [llmLink("i1", "r1"), llmLink("i2", "r1"), llmLink("i3", "r1"), llmLink("r1", "o1")]);
      click(ctx.genBtn("r1", "反推"));
      await settle();
      assert.deepEqual(ctx.sent(REV_PATH), [{ filename: "a.png", subfolder: "人物", language: "en" }],
        "停用的那一张不吃，连线顺序里第一张启用的就是被反推的那一张");
      assert.equal(ctx.content("o1"), REV_OUT);
      assert.ok(ctx.env.store.toasts.some((i) => i.message === "已反推出提示词" && i.kind === "success"));
    });

    test("反推的输入认到点上：只有配方素材的那一张与没连图都只说一句", async () => {
      const asset = await llmPage([picNode("i1", -400, { asset: "开场首帧.png", recipe: "短片配方" }),
        revNode("r1", 300), textNode("o1", 700, 0, "")], [llmLink("i1", "r1"), llmLink("r1", "o1")]);
      click(asset.genBtn("r1", "反推"));
      await settle();
      assert.ok(asset.env.store.toasts.some((i) => i.message === "反推只吃素材库里的图：连一张带素材路径的图片节点过来" && i.kind === "info"),
        "配方素材（只有 asset 没有 filename）后端认不到，跑之前就说清楚");
      assert.equal(asset.sent(REV_PATH).length, 0);
      assert.equal(asset.content("o1"), "");
      const empty = await llmPage([revNode("r1", 300), textNode("o1", 700, 0, "")], [llmLink("r1", "o1")]);
      click(empty.genBtn("r1", "反推"));
      await settle();
      assert.ok(empty.env.store.toasts.some((i) => i.message === "把要反推的那一张图片节点连过来"));
      assert.equal(empty.sent(REV_PATH).length, 0);
    });

    test("停用的那一张按一下就明说自己不跑；连过来的停用正文也不取", async () => {
      const ctx = await llmPage([
        textNode("t1", -760, 0, "启用的那一段"),
        textNode("t2", -760, 300, "停用的那一段", { disabled: true }),
        enhNode("e1", -340),
        enhNode("e2", -340, { disabled: true }),
        textNode("o1", 40, 0, ""),
      ], [llmLink("t1", "e1"), llmLink("t2", "e1"), llmLink("e1", "o1"), llmLink("t1", "e2")]);
      click(ctx.genBtn("e2", "增强"));
      await settle();
      assert.ok(ctx.env.store.toasts.some((i) => i.message === "这台节点已停用：在节点上方的浮出栏里启用" && i.kind === "info"));
      assert.equal(ctx.sent(ENH_PATH).length, 0);
      click(ctx.genBtn("e1", "增强"));
      await settle();
      assert.deepEqual(ctx.sent(ENH_PATH), [{ text: "启用的那一段", reasoning_effort: "medium" }],
        "连过来的停用正文不进载荷");
    });

    test("能力位没有那一项（桌面端离线窗）：增强与反推都说一句去哪儿启，不发请求", async () => {
      const ctx = await llmPage([
        textNode("t1", -760, 0, "一段正文"), enhNode("e1", -340),
        picNode("i1", -400), revNode("r1", 300), textNode("o1", 40, 300, ""),
      ], [llmLink("t1", "e1"), llmLink("e1", "o1"), llmLink("i1", "r1"), llmLink("r1", "o1")],
      { extraHost: { can: (feature) => feature !== "prompt_enhance" && feature !== "prompt_reverse" } });
      click(ctx.genBtn("e1", "增强"));
      click(ctx.genBtn("r1", "反推"));
      await settle();
      assert.equal(ctx.env.store.toasts.filter((i) => i.message === "该功能需要 ComfyUI：点顶栏 ComfyUI 胶囊启动，好了再按一次").length, 2);
      assert.deepEqual(ctx.sent(ENH_PATH), []);
      assert.deepEqual(ctx.sent(REV_PATH), []);
    });

    test("[ERROR] 帧：失败那句写进状态行并落进提示条，半截正文不落节点，节点上能直接再按", async () => {
      const enh = await llmPage([textNode("t1", -760, 0, "一段正文"), enhNode("e1", -340), textNode("o1", 40, 0, "")],
        [llmLink("t1", "e1"), llmLink("e1", "o1")], { enhance: [{ text: "半截" }, "[ERROR] 缺少 MS_TOKEN"] });
      click(enh.genBtn("e1", "增强"));
      await settle();
      assert.equal(enh.genText("e1", "status"), "缺少 MS_TOKEN");
      assert.ok(enh.view.nodeEl("e1").querySelector(".ns-canvas-gen-status")
        .classList.contains("ns-canvas-gen-fail"));
      assert.ok(enh.env.store.toasts.some((i) => i.message === "增强失败：缺少 MS_TOKEN" && i.kind === "error"));
      assert.equal(enh.content("o1"), "", "半截正文不落节点");
      assert.equal(enh.genBtn("e1", "增强").disabled, false, "失败的那一发收摊：能直接再按");
      const rev = await llmPage([picNode("i1", -400), revNode("r1", 300), textNode("o1", 700, 0, "")],
        [llmLink("i1", "r1"), llmLink("r1", "o1")],
        { reverse: [{ text: "前半截" }, { text: "[ERROR] 反推链失败：LLM 端点未配置" }, "[DONE]"] });
      click(rev.genBtn("r1", "反推"));
      await settle();
      assert.equal(rev.genText("r1", "status"), "反推链失败：LLM 端点未配置",
        "失败写进正文块里也认得出（与 prompt-service 读流同一口径）");
      assert.ok(rev.env.store.toasts.some((i) => i.message === "反推失败：反推链失败：LLM 端点未配置"));
      assert.equal(rev.content("o1"), "");
    });

    test("心跳与非 JSON 帧照收不下屏，思考块不进正文：落节点的是成文那一段", async () => {
      const ctx = await llmPage([textNode("t1", -760, 0, "一段正文"), enhNode("e1", -340), textNode("o1", 40, 0, "")],
        [llmLink("t1", "e1"), llmLink("e1", "o1")], {
        enhance: ["ping", { kind: "thinking", text: "我先想想这一段的构图" }, { text: "成文那一段" }, "[DONE]"],
      });
      click(ctx.genBtn("e1", "增强"));
      await settle();
      assert.equal(ctx.content("o1"), "成文那一段", "画布要落的是提示词，不是模型的思考过程");
      assert.ok(ctx.env.store.toasts.some((i) => i.message === "已增强出提示词"));
      assert.equal(ctx.genText("e1", "status"), "");
    });

    test("跑到一半：状态行报字数并出「取消任务」，取消掉半截正文不落节点，说一句已取消增强", async () => {
      const long = "一大段增强出来的正文";   // 每满 40 字才报一次进度：不足这一格只说「增强中」
      const ctx = await llmPage([textNode("t1", -760, 0, "一段正文"), enhNode("e1", -340), textNode("o1", 40, 0, "")],
        [llmLink("t1", "e1"), llmLink("e1", "o1")],
        { enhanceResponder: inflightSse([{ text: long.repeat(4) }, { text: long.repeat(4) }]) });
      click(ctx.genBtn("e1", "增强"));
      await settle();
      const el = ctx.view.nodeEl("e1");
      assert.ok(el.classList.contains("ns-canvas-node-run"), "在跑的那一张节点上有运行的边");
      assert.ok(ctx.genBtn("e1", "取消任务"), "这一发还在途：出着取消钮");
      assert.equal(el.querySelector(".ns-canvas-gen-status").textContent, `增强中 · ${long.length * 8} 字`);
      click(ctx.genBtn("e1", "取消任务"));
      await ctx.tick();
      assert.ok(ctx.env.store.toasts.some((i) => i.message === "已取消增强" && i.kind === "info"));
      assert.equal(ctx.content("o1"), "", "在途那一发的正文一个字都不写");
      assert.equal(ctx.genText("e1", "status"), "", "取消完收回状态行");
      assert.equal(ctx.genBtn("e1", "增强").disabled, false);
    });

    test("切画布脱手：在途那一发不落这一张画布，也不报成功", async () => {
      const long = "一大段增强出来的正文";
      const ctx = await llmPage([textNode("t1", -760, 0, "一段正文"), enhNode("e1", -340), textNode("o1", 40, 0, "")],
        [llmLink("t1", "e1"), llmLink("e1", "o1")],
        { enhanceResponder: inflightSse([{ text: long + long + long }]),
          canvases: [llmCanvas([], "乙", "canvas-0002")] });
      click(ctx.genBtn("e1", "增强"));
      await settle();
      assert.ok(ctx.genBtn("e1", "取消任务"), "这一发还在途：节点上有取消钮");
      pickCanvas(ctx.view, "canvas-0002");
      await settle();
      pickCanvas(ctx.view, "canvas-0001");
      await settle();
      assert.equal(ctx.content("o1"), "", "切走的画布脱手：在途的正文不落回来");
      assert.ok(!ctx.env.store.toasts.some((i) => i.message === "已增强出提示词"));
      assert.equal(ctx.genText("e1", "status"), "", "脱手的那一发不在眼前报状态");
    });

    test("下游没有空的提示词节点：新建一张接过去，撤销一次整发退掉", async () => {
      const ctx = await llmPage([textNode("t1", -760, 0, "一段正文"), enhNode("e1", -340),
        textNode("o1", 40, 0, "已填过的正文")], [llmLink("t1", "e1"), llmLink("e1", "o1")]);
      click(ctx.genBtn("e1", "增强"));
      await settle();
      const nodes = ctx.page.current().nodes;
      const made = nodes.find((n) => n.type === "text" && n.id !== "o1" && n.metadata.content === ENH_OUT);
      assert.ok(made, "在增强节点右下方新建一张提示词节点接过去");
      assert.ok(ctx.page.current().connections.some((c) => c.fromNodeId === "e1" && c.toNodeId === made.id),
        "新建的那一张接在增强节点下游");
      assert.equal(ctx.content("o1"), "已填过的正文");
      click(ctx.view.button("撤销"));
      await settle();
      assert.equal(ctx.page.current().nodes.length, 3, "撤销一次退掉新建的节点与连线");
      assert.equal(ctx.content("o1"), "已填过的正文");
    });

    test("节点上的技能与语言随画布落盘：metadata 就是存盘的那一份", async () => {
      const ctx = await llmPage([]);
      click(ctx.view.button("加文本增强节点"));
      click(ctx.view.button("加图片反推节点"));
      await settle();
      const [enh, rev] = ctx.page.current().nodes;
      await ctx.pickChip(enh.id, "英文增强");
      await ctx.pickChip(rev.id, "英文");
      ctx.page.flush();
      const saved = ctx.env.store.saved.at(-1).nodes;
      assert.equal(saved.find((n) => n.id === enh.id).metadata.skill_id, "en_enh");
      assert.equal(saved.find((n) => n.id === rev.id).metadata.language, "en");
    });
  });
});
