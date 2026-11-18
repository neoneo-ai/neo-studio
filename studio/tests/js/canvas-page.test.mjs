import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { resetEnv, mockRoute, jsonResponse, flush, click, setConfirmAnswer, dialogs } from "./setup.mjs";

// 引擎层纯函数在 pages/canvas/geometry.js，数据契约在 pages/canvas/store.js，页面在 pages/canvas/page.js：
// 模块级没有可变状态，跨用例不串味
const geometry = await import("../../web/studio/pages/canvas/geometry.js?canvasGeo=1");
const store = await import("../../web/studio/pages/canvas/store.js?canvasStore=1");
const page = await import("../../web/studio/pages/canvas/page.js?canvasPage=1");
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
async function makePage(env = mockCanvas(), { width = STAGE.width, height = STAGE.height } = {}) {
  resetEnv();
  for (const [route, responder] of Object.entries(env.routes)) mockRoute(route, responder);
  document.body.innerHTML = '<div class="ns-page"></div>';
  const host = document.querySelector(".ns-page");
  const page = canvas.createCanvasPage({ $el, api: env.api, toast: env.toast });
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
    select: host.querySelector(".ns-canvas-select"),
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

describe("canvas-page", () => {
  const at = (x, y) => ({ x, y });
  const imageNode = (id, x, y) => ({ id, type: "image", title: "图片", position: at(x, y), width: 340, height: 240, metadata: {} });
  const pair = () => [imageNode("n1", 0, 0), imageNode("n2", 800, 0)];
  const handle = (nodeId, handleType) => ({ nodeId, handleType });

  describe("常量与节点规格", () => {
    test("格距、缩放区间与背景模式循环", () => {
      assert.equal(canvas.GRID_SIZE, 48);
      assert.equal(canvas.MIN_SCALE, 0.05);
      assert.equal(canvas.MAX_SCALE, 5);
      assert.deepEqual(canvas.BACKGROUND_MODES, ["dots", "lines", "blank"]);
      assert.deepEqual(canvas.NODE_SPECS.image, { width: 340, height: 240, title: "图片" });
      assert.deepEqual(canvas.NODE_SPECS.text, { width: 340, height: 240, title: "提示词" });
    });
    test("连线命中半径与节点外扩 padding", () => {
      assert.equal(canvas.CONNECTION_HANDLE_HIT_RADIUS, 40);
      assert.equal(canvas.CONNECTION_NODE_HIT_PADDING, 32);
      assert.equal(canvas.CONNECTION_HIT_WIDTH, 16);
      assert.equal(canvas.MIN_NODE_WIDTH, 220);
      assert.equal(canvas.MIN_NODE_HEIGHT, 160);
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
      for (const label of ["新建画布", "重命名", "删除画布", "加图片", "加提示词", "适应内容"]) {
        assert.ok(view.bar.querySelector(`[aria-label="${label}"]`), label);
      }
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
    test("从正文框起手不拖节点（打字优先）", async () => {
      const { view, pos } = await makePage();
      click(view.button("加提示词"));
      const before = pos();
      const ta = view.nodeLayer.querySelector("textarea");
      fire(ta, "pointerdown", { clientX: CENTER.x, clientY: CENTER.y });
      fire(window, "pointermove", { clientX: CENTER.x + 60, clientY: CENTER.y + 60 });
      fire(window, "pointerup", {});
      assert.deepEqual(pos(), before);
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
      // 落点 = 鼠标处居中的图片节点：(400,300) 减掉半张图 170x120
      assert.deepEqual(view.pos(), [[CENTER.x - 170, CENTER.y - 120]]);
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
    test("空白处双击就地写一句提示词", async () => {
      const { page, view } = await makePage();
      click(view.button("加图片"));
      fire(view.stage, "dblclick", { clientX: CENTER.x - 200, clientY: CENTER.y - 100 });
      assert.equal(page.current().nodes.length, 2);
      assert.deepEqual(view.pos(), [[CENTER.x, CENTER.y], [CENTER.x - 370, CENTER.y - 220]]);
      assert.ok(view.nodeLayer.children[1].classList.contains("ns-canvas-node-text"));
    });
    test("双击节点正文 = 进编辑", async () => {
      const { view } = await makePage();
      click(view.button("加提示词"));
      const node = view.nodeLayer.children[0];
      const ta = node.querySelector("textarea");
      fire(node, "dblclick", { clientX: CENTER.x, clientY: CENTER.y });
      assert.equal(document.activeElement, ta);
      assert.equal(view.nodeLayer.children.length, 1);
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
    test("空白处起手框选，罩住的节点全亮", async () => {
      const { view } = await makePage();
      twoImages(view);
      fire(view.stage, "pointerdown", { clientX: 100, clientY: 100, button: 0 });
      fire(window, "pointermove", { clientX: 1150, clientY: 700 });
      assert.equal(lit(view), 2);
      assert.ok(view.world.querySelector(".ns-canvas-marquee"));
      fire(window, "pointerup", {});
      assert.equal(lit(view), 2, "松手之后选中要留着");
    });
    test("框不住任何节点时不亮", async () => {
      const { view } = await makePage();
      click(view.button("加图片"));
      fire(view.stage, "pointerdown", { clientX: 30, clientY: 30, button: 0 });
      fire(window, "pointermove", { clientX: 200, clientY: 200 });
      assert.equal(lit(view), 0);
      fire(window, "pointerup", {});
      assert.ok(!view.world.querySelector(".ns-canvas-marquee"), "松手要把框收掉");
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
      fire(view.stage, "pointerdown", { clientX: 100, clientY: 100, button: 0 });
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
      assert.ok(Math.abs(h - 440 * 240 / 340) < 1e-6, `高 ${h} 要按 340:240 跟上`);
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
    test("中键拖 = 平移，Ctrl 点空白 = 平移", async () => {
      const { view, page } = await makePage();
      fire(view.stage, "pointerdown", { clientX: 100, clientY: 100, button: 1 });
      fire(window, "pointermove", { clientX: 150, clientY: 110 });
      fire(window, "pointerup", {});
      assert.deepEqual(page.current().viewport, { x: 50, y: 10, k: 1 });
      fire(view.stage, "pointerdown", { clientX: 100, clientY: 100, button: 0, ctrlKey: true });
      fire(window, "pointermove", { clientX: 120, clientY: 100 });
      fire(window, "pointerup", {});
      assert.deepEqual(page.current().viewport, { x: 70, y: 10, k: 1 });
    });
    test("适应内容把节点装进视口，四周留边且左右居中", async () => {
      const { view, page } = await makePage();
      click(view.button("加图片"));
      click(view.button("适应内容"));
      const { x, y, k } = page.current().viewport;
      assert.equal(view.zoom.textContent, "267%");
      const left = x + CENTER.x * k;                       // 节点左上角落到屏幕的位置
      const right = x + (CENTER.x + 340) * k;
      assert.ok(left > 80 - 1e-6 && STAGE.width - right > 80 - 1e-6, `两侧要留 80 边距：${left}/${right}`);
      assert.ok(Math.abs(left - (STAGE.width - right)) < 1e-6, "左右等边距");
      const top = y + CENTER.y * k, bottom = y + (CENTER.y + 240) * k;
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
      assert.ok([...view.select.options].some((o) => o.textContent === "我的画布"),
        "新建的画布要出现在下拉里，切走之后还得切得回来");
      assert.equal(view.select.value, page.current().id);
    });
    test("没存过的画布点重命名要说话", async () => {
      const { view, env } = await makePage();
      click(view.button("加图片"));
      click(view.button("重命名"));
      await settle();
      assert.equal(env.store.renames.length, 0);
      assert.ok(toastOf(env).some((m) => m.includes("还没存过")));
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
      assert.ok([...view.select.options].some((o) => o.textContent === "改名后"));
    });
    test("删除画布走单张真路由，删完加载下一张", async () => {
      const { view, env } = await makePage(TWO_IMAGES());
      assert.equal(view.select.value, "canvas-0001");
      setConfirmAnswer(true);
      click(view.button("删除画布"));
      await settle();
      assert.equal(env.store.deleted.length, 1);
      assert.equal(env.store.deleted[0].id, "canvas-0001");
      assert.equal(view.select.value, "canvas-0002");
      assert.equal(env.store.projects.length, 1);
    });
    test("删除取消就不动数据", async () => {
      const { view, env } = await makePage(TWO_IMAGES());
      setConfirmAnswer(false);
      click(view.button("删除画布"));
      await settle();
      assert.equal(env.store.deleted.length, 0);
      assert.equal(view.select.value, "canvas-0001");
    });
    test("切画布先把未落盘的改动写进这一张，再读下一张", async () => {
      const { page, view, env } = await makePage(TWO_IMAGES());
      click(view.button("加图片"));
      view.select.value = "canvas-0002";
      fire(view.select, "change");
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
});

