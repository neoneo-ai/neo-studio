import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, describe } from "node:test";
import { fileURLToPath } from "node:url";
import { resetEnv, mockRoute, jsonResponse, flush, click, setConfirmAnswer, dialogs } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

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
async function makePage(env = mockCanvas(), extraHost = {}, { width = STAGE.width, height = STAGE.height } = {}) {
  resetEnv();
  for (const [route, responder] of Object.entries(env.routes)) mockRoute(route, responder);
  document.body.innerHTML = '<div class="ns-page"></div>';
  const host = document.querySelector(".ns-page");
  const page = canvas.createCanvasPage({ $el, api: env.api, toast: env.toast, ...extraHost });
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
/** 一张填好图的 + 一张空着的图片节点，中间一条连线：节点头部动作的用例都从这一张起 */
const PAIR_WITH_LINK = () => mockCanvas({ projects: [
  { id: "canvas-0001", title: "甲", nodes: [
    { id: "n-a", type: "image", title: "图片", position: { x: 10, y: 20 }, width: 340, height: 240, metadata: { filename: "a.png" } },
    { id: "n-b", type: "image", title: "图片", position: { x: 400, y: 20 }, width: 340, height: 240, metadata: {} }],
    connections: [{ id: "c1", fromNodeId: "n-a", toNodeId: "n-b" }],
    viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" },
] });
/** 素材库弹窗的替身：开一次记一条回调，用例自己决定交回哪一批（与装配层同一份契约：一次一批数组） */
const picker = () => { const calls = []; return { calls, openMaterial: (cb) => calls.push(cb) }; };
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
      for (const label of ["新建画布", "重命名", "删除画布", "加图片", "加提示词", "复制选中", "撤销", "重做", "适应内容"]) {
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
      pk.calls[0]([{ filename: "picked.png", subfolder: "neo_gen/p" }]);
      await settle();
      const node = page.current().nodes.find((n) => n.id === "n-b");
      assert.deepEqual([node.metadata.filename, node.metadata.subfolder], ["picked.png", "neo_gen/p"]);
      assert.ok(view.nodeEl("n-b").querySelector("img").src.includes("picked.png"));
      assert.equal(nodeAct(view, "n-b", "pick"), null, "填上图之后「选图」钮要让位");
      page.flush();
      await settle();
      assert.equal(env.store.saved[0].nodes.find((n) => n.id === "n-b").metadata.filename, "picked.png");
    });

    test("填好图的节点不出「选图」，两类节点都有删除钮", async () => {
      const { view } = await makePage(PAIR_WITH_LINK());
      assert.equal(nodeAct(view, "n-a", "pick"), null);
      assert.ok(nodeAct(view, "n-a", "delete") && nodeAct(view, "n-b", "delete"));
      assert.ok(nodeAct(view, "n-a", "hero"), "图片节点有主图钮");
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
        assert.ok(el.children[1].classList.contains("ns-canvas-node-bar"), "操作栏直接住在节点里");
      }
    });
    test("操作栏默认不出现，节点选中时那条 CSS 规则才把它铺出来", () => {
      const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
      assert.match(css, /\.ns-canvas-node-bar \{[^}]*display: none/);
      assert.match(css, /\.ns-canvas-node-on \.ns-canvas-node-bar \{ display: flex/);
      assert.match(css, /\.ns-canvas-node-img \{[^}]*inset: 0/);
      assert.match(css, /\.ns-canvas-node-textarea \{[^}]*inset: 0/);
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
      click(nodeAct(view, "n-a", "copy"));
      const copy = page.current().nodes.at(-1);
      assert.ok(copy.id !== "n-a", "副本是新 id");
      assert.deepEqual([copy.position.x, copy.position.y], [46, 56], "副本偏移 36 落在旁边");
      assert.equal(copy.metadata.filename, "a.png", "图坐标跟着副本走");
      assert.equal(lit(view), 1);
      assert.ok(view.nodeEl(copy.id).classList.contains("ns-canvas-node-on"), "选中要落到副本上");
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
      click(view.button("复制选中"));
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
      view.select.value = "canvas-0002";
      fire(view.select, "change");
      await settle();
      assert.equal(page.current().nodes.length, 0);
      assert.equal(view.button("撤销").disabled, true, "切过来就是空栈");
      click(view.button("加提示词"));
      undo();
      assert.equal(page.current().nodes.length, 0, "只退这一张上的一步");
      view.select.value = "canvas-0001";
      fire(view.select, "change");
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
      const { view, env, page } = await makePage();
      copyKey();
      click(view.button("粘贴"));
      assert.equal(page.current().nodes.length, 0, "两条都不该改动画布");
      const toasts = toastOf(env);
      assert.ok(toasts.some((m) => m.includes("先选中")), "没选中要说清楚");
      assert.ok(toasts.some((m) => m.includes("剪贴板是空的")), "空剪贴板要说清楚");
      assert.ok(view.button("剪切选中").title.includes("Ctrl+X"));
      assert.ok(view.button("复制").title.includes("Ctrl+C"));
      assert.ok(view.button("粘贴").title.includes("Ctrl+V"));
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
      assert.equal(document.activeElement, ta, "双击才是进编辑");
      assert.ok(!evFire(ta, "mousedown").defaultPrevented, "编辑态里不拦，划词与光标动作照旧");
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

