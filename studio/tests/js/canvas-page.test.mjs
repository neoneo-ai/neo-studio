import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, describe } from "node:test";
import { fileURLToPath } from "node:url";
import { resetEnv, mockRoute, jsonResponse, flush, click, setConfirmAnswer, dialogs, fetchLog } from "./setup.mjs";
import { dispatchApiEvent, listenerCount, resetApiState } from "./mocks/comfy-api.mjs";
import { ICON_NAMES } from "../../web/js/core/icons.js";

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
    test("串联展开的标记走一圈存盘读盘：chain / train / expand_mode / disabled 都读得回来", () => {
      const nodes = [{ id: "g1", type: "gen", title: "生成", position: at(0, 0), width: 320, height: 208,
        metadata: { kind: "video", chain: "train", recipe: "短片配方", seed: 100 } },
      { id: "r1", type: "recipe", title: "配方闭环", position: at(400, 0), width: 386, height: 324,
        metadata: { recipe: "短片配方", segment: 1, train: 1, expand_mode: "train", disabled: true } }];
      const state = canvas.readCanvas(canvas.serializeCanvas({ ...canvas.readCanvas({}),
        id: "canvas-0001", title: "一圈", nodes, connections: [{ id: "c1", fromNodeId: "r1", toNodeId: "g1" }],
        viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots" }));
      assert.deepEqual([state.nodes[0].metadata.chain, state.nodes[0].metadata.seed], ["train", 100]);
      assert.deepEqual([state.nodes[1].metadata.train, state.nodes[1].metadata.expand_mode,
        state.nodes[1].metadata.disabled], [1, "train", true],
      "旧画布没这些键时读回来就是 undefined：平铺、不停用、非串联");
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
      for (const label of ["新建画布", "重命名", "删除画布", "加图片", "加提示词", "加生成节点", "加视频节点", "加配方节点",
        "复制选中", "剪切选中", "复制", "粘贴", "撤销", "重做", "缩小", "放大", "适应内容", "背景"]) {
        assert.ok(view.bar.querySelector(`[aria-label="${label}"]`), label);
      }
    });
    test("工具条每一枚钮的图标名都画得出来（缺一名就是条上一枚只剩边框的空钮）", () => {
      const source = fs.readFileSync(path.join(webDir, "studio/pages/canvas/page.js"), "utf8");
      const bar = source.slice(source.indexOf("function buildBar"), source.indexOf("return { root, select"));
      const names = [...bar.matchAll(/\bmk(?:Label|Hint)?\((?:[^()]|\([^()]*\))*?,\s*"([a-z0-9-]+)"/g)]
        .map((m) => m[1]);
      assert.ok(names.length >= 14, `工具条里只扫到 ${names.length} 枚图标名：${names.join(",")}`);
      for (const name of names) {
        assert.ok(ICON_NAMES.includes(name), `图标 ${name} 在 icons.js 里画不出`);
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
      assert.ok(view.stage.classList.contains("ns-canvas-marqueeing"), "起手要把光标换成十字");
      fire(window, "pointerup", {});
      assert.equal(lit(view), 2, "松手之后选中要留着");
      assert.ok(!view.stage.classList.contains("ns-canvas-marqueeing"), "松手要把手势态收掉");
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
    test("空白框选换掉选中集：罩不住的不留", async () => {
      const { view } = await makePage();
      const [n1, n2] = twoImages(view);
      selectNode(view, n1);
      assert.equal(lit(view), 1);
      fire(view.stage, "pointerdown", { clientX: 1000, clientY: 450, button: 0 });
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
    test("触屏那一拖 = 平移，不许画框", async () => {
      const { view, page } = await makePage();
      click(view.button("加图片"));
      fire(view.stage, "pointerdown", { clientX: 300, clientY: 250, button: 0, pointerType: "touch" });
      fire(window, "pointermove", { clientX: 380, clientY: 300, pointerType: "touch" });
      fire(window, "pointerup", { pointerType: "touch" });
      assert.deepEqual(page.current().viewport, { x: 80, y: 50, k: 1 }, "触屏那一拖要挪得动画面");
      assert.ok(!view.world.querySelector(".ns-canvas-marquee"), "触屏不许画框");
    });
    test("空白处起手拖 = 框选，画面与节点都不动", async () => {
      const { view, page, pos } = await makePage();
      click(view.button("加图片"));
      const before = pos();
      fire(view.stage, "pointerdown", { clientX: 300, clientY: 250, button: 0 });
      fire(window, "pointermove", { clientX: 700, clientY: 500 });
      fire(window, "pointerup", {});
      assert.deepEqual(page.current().viewport, { x: 0, y: 0, k: 1 }, "框选不许挪画面");
      assert.deepEqual(pos(), before, "框选不许把节点挪走");
      assert.equal(lit(view), 1, "框罩到的那一张亮起来");
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
      const ctx = await makePage(env, { canGen: () => true, startComfy: () => { env.starts.push(1); }, ...extraHost });
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
      // 配方卡独有的读法：段一行的钮（一枚一段，按段号排）与那几行概览文本
      const segBtn = (id, at) => [...ctx.view.nodeEl(id).querySelectorAll(".ns-canvas-seg-btn")][at];
      const segLabels = (id) => [...ctx.view.nodeEl(id).querySelectorAll(".ns-canvas-seg-btn")]
        .map((el) => el.textContent.trim());
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
        segBtn, segLabels, recipeText, linkNodes };
    }
    const genCalls = () => fetchLog.filter((c) => c.path === "/neo_image_gen/generate");
    const okImages = (n) => ({ task_id: "gen-1", status: "succeeded",
      images: Array.from({ length: n }, (_x, i) => ({ filename: `o${i + 1}.png`, subfolder: "" })) });
    const deepSettle = () => flush(60);   // 出图链比页面落盘多两跳：提交一发 + 兜底首拉

    // 画布上的出片链走视频页那两条后端链（/neo_video_gen/simple 与 /neo_video_gen/run_segment）：
    // 路由按真接口的形状给 —— 提交回 task_id，状态快照带 progress 与 filename/subfolder，取消在同一层 /cancel
    const videoSkills = () => ([
      { id: "image_gen", name: "出图", category: "image_gen", source: "preset", gen_image: true },
      { id: "h3_t2v", name: "文生视频", category: "gen_video", source: "preset", gen_video: true },
      { id: "h3_i2v", name: "图生视频", category: "gen_video", source: "preset", gen_video: true, requires_ref: true },
    ]);
    const RECIPE_ROW = { name: "短片配方", title: "短片", source: "mine", type: "video_director",
      canvas_id: "", shared: { mode: "i2v", width: 1344, height: 768 },
      segments: [{ title: "开场", skill_id: "h3_t2v", duration_sec: 5, prompt: "开场那一段的提示词",
        first_frame: "开场首帧.png", refs: { images: ["角色设定.png"] } },
        { title: "收尾", skill_id: "h3_t2v", duration_sec: 8, refs: { videos: ["收尾参考.mp4"] } }] };
    const RECIPE_ROW_EMPTY = { ...RECIPE_ROW, name: "空配方", title: "空", segments: [] };
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
    const recipeNode = (id, x, meta = {}) => ({ id, type: "recipe", title: "配方闭环",
      position: { x, y: 300 }, width: 386, height: 324,
      metadata: { recipe: "短片配方", segment: 0, anchors: "both", ...meta } });
    const clipCalls = (path) => fetchLog.filter((c) => c.path === path);
    const clipPolls = (taskId) => fetchLog.filter((c) => c.path.endsWith(`/${taskId}`));
    const clipVideoSrc = (ctx, id) => ctx.view.nodeEl(id).querySelector("video")?.getAttribute("src") || "";

    test("加生成节点：铺一张生成节点，默认技能落内置生图技能", async () => {
      const { page, view } = await genPage([]);
      click(view.button("加生成节点"));
      const node = page.current().nodes[0];
      assert.equal(node.type, "gen");
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
          .map((el) => el.title), ["技能", "默认比例", "长边尺寸", "生图张数"],
        "精简胶囊不带行标签，每一枚是干什么的写在悬停提示里");
      assert.equal(ctx.genText("g1", "model"), "主模型：跟随技能配置", "技能 config 取到手才写得出这一行");
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
    test("离线（没有执行队列）时出图不动作，点一下叫它启动", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), genNode("g1", 0, 0)], [link("t1", "g1")],
        { extraHost: { canGen: () => false } });
      click(ctx.genBtn("g1", "出图"));
      await settle();
      assert.equal(genCalls().length, 0);
      assert.equal(ctx.env.starts.length, 1);
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("出图需要 ComfyUI 执行队列")));
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
      ctx.view.select.value = "canvas-0002";
      fire(ctx.view.select, "change");
      await settle();
      dispatchApiEvent("rs.image_gen.status", okImages(2));
      await settle();
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("图已存进 Output 目录")));
      assert.equal(ctx.page.current().id, "canvas-0002");
      assert.ok(ctx.env.store.saved.every((payload) => !payload.nodes?.some((n) => n.id === "i1" && n.metadata.filename)),
        "脱手的那一发不写旧画布");
      assert.equal(listenerCount("rs.image_gen.status"), 0);
    });
    test("控件那一片起手不拖节点，胶囊菜单浮在节点外那一层", async () => {
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
    test("加视频节点与加配方节点：16:9 的出片节点与一份空着的配方", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoSlot("vid1", 700)], [], { routes: clipRoutes() });
      await deepSettle();   // 视频技能表与配方表都在 build 之后才落地
      click(ctx.view.button("加视频节点"));
      click(ctx.view.button("加配方节点"));
      await settle();
      const video = ctx.page.current().nodes.find((n) => n.type === "gen" && n.metadata.kind === "video");
      const recipe = ctx.page.current().nodes.find((n) => n.type === "recipe");
      assert.deepEqual([video.width, video.height], [320, 208], "出片节点默认 16:9 的框");
      assert.equal(video.metadata.skill_id, "h3_t2v", "技能默认落在视频技能表第一份");
      assert.ok(ctx.genBtn(video.id, "出片"), "出片节点自带出片钮");
      assert.equal(recipe.metadata.recipe, "", "配方默认空着，由面板里选");
      assert.equal(recipe.metadata.anchors, "both", "默认两端锚点");
      assert.equal(ctx.genText(recipe.id, "model"), "未选配方", "没选配方时概览行这么说");
      click(ctx.genBtn(recipe.id, "出片"));
      await settle();
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("先选一份配方")));
      assert.equal(clipCalls("/neo_video_gen/run_segment").length, 0, "没选配方不进闭环节");
      assert.ok(ctx.view.nodeEl("vid1").querySelector(".ns-canvas-node-video-empty"), "没落上片的视频位这么说");
    });
    test("视频节点出片：入参进简单视频链，成片写进下游空视频节点", async () => {
      const ctx = await genPage([promptNode("t1", "镜头慢慢推进"), videoGen("v1", 0), imageSlot("i1", 0),
        videoSlot("vid1", 700)], [link("t1", "v1"), link("i1", "v1"), link("v1", "vid1")],
        { routes: clipRoutes() });
      await deepSettle();
      ctx.page.current().nodes.find((n) => n.id === "i1").metadata = { filename: "a.png", subfolder: "sub" };
      click(ctx.genBtn("v1", "出片"));
      await deepSettle();
      assert.deepEqual(clipCalls("/neo_video_gen/simple")[0].body, {
        prompt: "镜头慢慢推进", skill_id: "h3_t2v",
        references: [{ kind: "input", value: "sub/a.png[output]" }],
        last_frame: null, duration_sec: 8, seed: -1, width: 1344, height: 768,
      }, "入参按出视频页那一条链的字段名走");
      assert.ok(fetchLog.some((c) => c.path === "/neo_video_gen/simple/clip-1" && c.method === "GET"),
        "提交完先拉一格快照");
      assert.equal(clipVideoSrc(ctx, "vid1"), "/neo_gallery/video?filename=o.mp4&subfolder=sub",
        "成片写进连着的空视频节点");
      assert.equal(ctx.genText("v1", "status"), "", "出完片状态行收回，节点不挂运行态");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("已出片")));
      assert.equal(ctx.page.current().nodes.filter((n) => n.type === "video").length, 1, "有空位就不新开");
    });
    test("视频节点出片：没有空视频节点就新开一台并连上这一发", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0)], [link("t1", "v1")],
        { routes: clipRoutes() });
      await deepSettle();
      click(ctx.genBtn("v1", "出片"));
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
      click(ctx.genBtn("v1", "出片"));
      await deepSettle();
      assert.ok(ctx.genText("v1", "status").includes("生成中 3/120"), ctx.genText("v1", "status"));
      assert.ok(ctx.view.nodeEl("v1").classList.contains("ns-canvas-node-run"), "跑着时节点挂运行态");
      assert.equal(ctx.genBtn("v1", "出片").disabled, true, "这一发在跑就不给叠第二发");
      click(ctx.genBtn("v1", "取消任务"));
      await settle();
      assert.ok(fetchLog.some((c) => c.path === "/neo_video_gen/simple/clip-1/cancel" && c.method === "POST"),
        "取消要交后端出队，不是只把界面收掉");
      click(ctx.genBtn("v1", "出片"));   // 闸门：这一发还没收摊就不叠第二发
      await deepSettle();
      assert.equal(clipCalls("/neo_video_gen/simple").length, 1, "取消没收摊前不提交第二发");
      assert.ok(ctx.genText("v1", "status").includes("生成中 3/120"), "终态由后端那一格收摊，界面不自演已取消");
    });
    test("出片走到后端那一格 cancelled：状态行收回并允许再来一发", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0)], [link("t1", "v1")],
        { routes: clipRoutes({ snaps: [{ success: true, task_id: "clip-1", status: "cancelled" }] }) });
      await deepSettle();
      click(ctx.genBtn("v1", "出片"));
      await deepSettle();
      assert.equal(ctx.genText("v1", "status"), "", "取消完不挂运行态");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("已取消出片")));
      assert.equal(ctx.genBtn("v1", "出片").disabled, false, "取消完允许再来一发");
    });
    test("出片失败：后端给的原因留在状态行，这一张允许再来一发", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0)], [link("t1", "v1")],
        { routes: clipRoutes({ snaps: [{ success: false, status: "failed", error: "显存不够" }] }) });
      await deepSettle();
      click(ctx.genBtn("v1", "出片"));
      await deepSettle();
      assert.equal(ctx.genText("v1", "status"), "显存不够", "状态行就是后端那一格的失败原因");
      assert.ok(ctx.view.nodeEl("v1").querySelector(".ns-canvas-gen-fail"), "失败那一行标失败色");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("出片失败：显存不够")));
      assert.equal(ctx.genBtn("v1", "出片").disabled, false, "失败过的那一张允许再来一发");
    });
    test("要参考素材的技能缺图时在画布上就拦下", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0, { skill_id: "h3_i2v" })],
        [link("t1", "v1")], { routes: clipRoutes() });
      await deepSettle();
      click(ctx.genBtn("v1", "出片"));
      await settle();
      assert.equal(clipCalls("/neo_video_gen/simple").length, 0, "无参考的 i2v 不进队列");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("要参考素材")));
    });
    test("配方节点出片：只发选中的那一段进闭环节，成片写进下游视频节点", async () => {
      const ctx = await genPage([recipeNode("r1", 0, { segment: 1 }), videoSlot("vid1", 700)],
        [link("r1", "vid1")], { routes: clipRoutes() });
      await deepSettle();
      assert.ok(ctx.genText("r1", "model").includes("2 段"), ctx.genText("r1", "model"));
      assert.ok(ctx.genText("r1", "model").includes("1344×768"), "概览行读配方自己那份 spec");
      click(ctx.genBtn("r1", "出片"));
      await deepSettle();
      assert.deepEqual(clipCalls("/neo_video_gen/run_segment")[0].body, {
        recipe: "短片配方", segment: 1, anchors: "both", steps: -1, seed: -1,
        continuity: true, context_frames: 22, prompt: "", references: { images: [], videos: [], audios: [] },
      }, "只发选中的这一段，生成参数留跟随");
      assert.equal(clipVideoSrc(ctx, "vid1"), "/neo_gallery/video?filename=seg0.mp4&subfolder=director");
      assert.equal(ctx.genText("r1", "status"), "", "出完片状态行收回");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("已出片")));
    });
    test("配方节点：没选配方不发，选中的段与锚点落进 metadata 并进闭环节", async () => {
      const ctx = await genPage([recipeNode("r1", 0, { recipe: "" })], [], { routes: clipRoutes() });
      await deepSettle();
      assert.ok(ctx.chipLabelAt("r1", 0).includes("未选配方"), "配方胶囊先说未选");
      assert.equal(ctx.genText("r1", "model"), "未选配方", "没选配方时概览行这么说");
      click(ctx.genBtn("r1", "出片"));
      await settle();
      assert.equal(clipCalls("/neo_video_gen/run_segment").length, 0, "没选配方不进闭环节");
      await ctx.pickChip("r1", 0, "短片配方");
      await ctx.pickChip("r1", 2, "不用锚点");
      const meta = ctx.page.current().nodes.find((n) => n.id === "r1").metadata;
      assert.deepEqual([meta.recipe, meta.segment, meta.anchors], ["短片配方", 0, "none"],
        "换配方时段号回到第 1 段");
      click(ctx.genBtn("r1", "出片"));
      await deepSettle();
      assert.deepEqual(clipCalls("/neo_video_gen/run_segment")[0].body, {
        recipe: "短片配方", segment: 0, anchors: "none", steps: -1, seed: -1,
        continuity: true, context_frames: 22, prompt: "", references: { images: [], videos: [], audios: [] },
      });
    });
    test("配方胶囊不列一段都没有的配方：那一个选了只会撞到段序号越界", async () => {
      const ctx = await genPage([recipeNode("r1", 0, { recipe: "" })], [],
        { routes: clipRoutes({ recipes: [RECIPE_ROW, RECIPE_ROW_EMPTY] }) });
      await deepSettle();
      click(ctx.chipAt("r1", 0));
      await settle();
      const labels = [...ctx.menu().querySelectorAll(".neo-gallery-gm-menu-item")].map((el) => el.textContent);
      assert.ok(labels.includes("短片配方"), "有段的配方照旧列出来");
      assert.ok(!labels.includes("空配方"), "一段都没有的配方不给选");
    });
    const undoKey = () => fire(window, "keydown", { key: "z", ctrlKey: true });

    test("配方卡一段一枚钮：主色跟着选中的段走，改动进节点也进撤销栈", async () => {
      const ctx = await genPage([recipeNode("r1", 0)], [], { routes: clipRoutes() });
      await deepSettle();
      assert.deepEqual(ctx.segLabels("r1"), ["段 1", "段 2"], "段一行一枚一段，按段号排");
      assert.ok(ctx.segBtn("r1", 0).classList.contains("ns-canvas-seg-btn-on"), "第 1 段抬到主色");
      assert.ok(ctx.segBtn("r1", 1).title.includes("8 秒"), "段钮的悬停说这一段多长");
      assert.ok(ctx.segBtn("r1", 0).title.includes("开场那一段的提示词"), "悬停里带这一段的提示词");
      click(ctx.segBtn("r1", 1));
      await settle();
      assert.equal(ctx.page.current().nodes.find((n) => n.id === "r1").metadata.segment, 1);
      assert.ok(ctx.segBtn("r1", 1).classList.contains("ns-canvas-seg-btn-on"), "换段之后主色跟着走");
      undoKey();
      await settle();
      assert.equal(ctx.page.current().nodes.find((n) => n.id === "r1").metadata.segment, 0, "撤销收回上一次选的段");
    });

    test("配方卡提示词来源那一行：连过来的正文就是画布那一份", async () => {
      const ctx = await genPage([promptNode("t1", "画布上写的提示词"), recipeNode("r1", 0),
        videoSlot("vid1", 700)], [link("r1", "vid1")], { routes: clipRoutes() });
      await deepSettle();
      const row = () => ctx.view.nodeEl("r1").querySelector(".ns-canvas-recipe-prompt");
      assert.equal(ctx.recipeText("r1", "text"), "开场那一段的提示词", "没连正文时这一行读配方选中那一段");
      assert.equal(ctx.recipeText("r1", "src"), "配方");
      assert.ok(!row().classList.contains("ns-canvas-recipe-on"), "用配方那一份时不抬主色");
      ctx.linkNodes("t1", "r1");
      await settle();
      assert.ok(row().classList.contains("ns-canvas-recipe-on"), "连了正文，这一行抬到主色");
      assert.equal(ctx.recipeText("r1", "src"), "画布");
      assert.equal(ctx.recipeText("r1", "text"), "画布上写的提示词");
      click(ctx.genBtn("r1", "出片"));
      await deepSettle();
      assert.equal(clipCalls("/neo_video_gen/run_segment")[0].body.prompt, "画布上写的提示词",
        "出片发出去的就是画布那一份");
    });

    test("配方卡上的参考素材：连过来的图排在配方素材前面，出片按参考素材那套交后端", async () => {
      const ctx = await genPage([imageSlot("i1", -700), recipeNode("r1", 0),
        videoSlot("vid1", 700)], [link("r1", "vid1")], { routes: clipRoutes() });
      await deepSettle();
      ctx.page.current().nodes.find((n) => n.id === "i1").metadata = { filename: "a.png", subfolder: "sub" };
      ctx.linkNodes("i1", "r1");
      await settle();
      const thumbs = () => [...ctx.view.nodeEl("r1").querySelectorAll(".ns-canvas-recipe-thumb")];
      assert.deepEqual(thumbs().map((el) => el.getAttribute("alt")),
        ["a.png", "开场首帧.png", "角色设定.png"], "首帧排最前，连过来的图排在配方素材前面");
      assert.ok(thumbs()[0].getAttribute("src").startsWith("/neo_gallery/thumbnail"), "画布上的图走 Gallery 缩略图");
      assert.ok(thumbs()[1].getAttribute("src").includes("/rs_recipes/thumbnail")
        && thumbs()[1].getAttribute("src").includes("dir=assets"), "配方素材走配方 assets 那条缩略图");
      assert.equal(ctx.recipeText("r1", "count"), "3 张参考素材");
      click(ctx.genBtn("r1", "出片"));
      await deepSettle();
      assert.deepEqual(clipCalls("/neo_video_gen/run_segment")[0].body.references,
        { images: [{ kind: "input", value: "sub/a.png[output]" }], videos: [], audios: [] },
        "连过来的图按参考素材那套标注交后端");
    });

    test("展开配方：一段一台段节点，提示词与参考素材摊成连过去的独立节点", async () => {
      const ctx = await genPage([recipeNode("r1", 0, { anchors: "none", segment: 1 })], [],
        { routes: clipRoutes() });
      await deepSettle();
      click(ctx.genBtn("r1", "展开配方"));
      await settle();
      const made = ctx.page.current().nodes.filter((n) => n.id !== "r1");
      const typed = (type) => made.filter((n) => n.type === type);
      assert.deepEqual([typed("recipe").length, typed("text").length, typed("video").length], [2, 2, 2],
        "两段就是两台段节点、两块提示词、两台空视频位");
      assert.deepEqual(typed("image").map((n) => n.metadata.asset),
        ["开场首帧.png", "角色设定.png", "收尾参考.mp4"], "每一段的首帧与参考素材各摊一张");
      assert.ok(typed("image").every((n) => n.metadata.recipe === "短片配方"),
        "素材节点认得自己是哪一份配方的");
      assert.deepEqual(typed("recipe").map((n) => n.metadata.segment), [0, 1], "段号按段序落进新节点");
      assert.ok(typed("recipe").every((n) => n.metadata.recipe === "短片配方" && n.metadata.anchors === "none"),
        "配方与锚点带到每一段上");
      assert.deepEqual(typed("text").map((n) => n.metadata.content), ["开场那一段的提示词", ""],
        "提示词摊成正文节点，配方里没写的就是空的");
      assert.deepEqual(typed("text").map((n) => [n.position.x, n.position.y]), [[426, 300], [426, 724]],
        "一段一行往下排");
      assert.deepEqual(typed("image").map((n) => [n.position.x, n.position.y]),
        [[716, 300], [998, 300], [716, 724]], "参考素材排在提示词右边一行里");
      assert.deepEqual(typed("recipe").map((n) => [n.position.x, n.position.y]), [[1288, 300], [1288, 724]]);
      assert.deepEqual(typed("video").map((n) => [n.position.x, n.position.y]), [[1706, 300], [1706, 724]],
        "每段右边留一台空的成片位");
      const conns = ctx.page.current().connections;
      assert.equal(conns.length, 7, "一次摊出 7 条线：正文→段、素材→段、段→视频位");
      assert.ok(conns.some((c) => c.fromNodeId === typed("text")[0].id
        && c.toNodeId === typed("recipe")[0].id), "第 1 段的提示词连到自己那台段节点");
      assert.ok(conns.some((c) => c.fromNodeId === typed("image")[1].id
        && c.toNodeId === typed("recipe")[0].id), "这一段的参考图连到自己那台段节点");
      assert.ok(conns.some((c) => c.fromNodeId === typed("recipe")[1].id
        && c.toNodeId === typed("video")[1].id), "第 2 段的成片有落的位子");
      assert.equal(lit(ctx.view), 2, "选中落在摊出来的那两台段节点上");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("已展开 2 段")));
      undoKey();
      await settle();
      assert.deepEqual([ctx.page.current().nodes.length, ctx.page.current().connections.length], [1, 0],
        "撤销一次退掉整批");
    });

    test("展开出来的节点直接出片：素材连配方名交后端，正文走的就是那条连线", async () => {
      const ctx = await genPage([recipeNode("r1", 0, { anchors: "none", segment: 1 })], [],
        { routes: clipRoutes() });
      await deepSettle();
      click(ctx.genBtn("r1", "展开配方"));
      await settle();
      const segId = ctx.page.current().nodes.find((n) => n.type === "recipe" && n.metadata.segment === 0).id;
      click(ctx.genBtn(segId, "出片"));
      await deepSettle();
      const calls = clipCalls("/neo_video_gen/run_segment");
      assert.equal(calls.length, 1, "展开本身不出片");
      const seg = calls[0].body;
      assert.deepEqual(seg.references.images, [
        { kind: "recipe", value: "开场首帧.png", recipe: "短片配方" },
        { kind: "recipe", value: "角色设定.png", recipe: "短片配方" },
      ], "摊出来的素材连配方名一起交后端，画布这边不用先把素材拷进 input");
      assert.equal(seg.prompt, "开场那一段的提示词", "摊出来的正文节点连到段节点上，出片走的就是这条连线");
      assert.equal(seg.segment, 0);
    });

    test("工具条的展开配方认选中的那一台配方节点：没选中与读不到都说话，不摊假节点", async () => {
      const bare = await genPage([], [], { routes: clipRoutes() });
      click(bare.view.button("展开配方"));
      await settle();
      assert.ok(bare.env.store.toasts.some((item) => item.message.includes("先选中一台配方节点")));
      assert.equal(bare.page.current().nodes.length, 0);
      const ctx = await genPage([recipeNode("r1", 0)], [], { routes: clipRoutes({ recipes: [] }) });
      await deepSettle();
      selectNode(ctx.view, "r1");
      click(ctx.view.button("展开配方"));
      await settle();
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("配方列表读不到")));
      assert.equal(ctx.page.current().nodes.length, 1, "读不到就只留原来那一台");
    });

    test("串联展开：车厢首尾相接接到车尾，整列共用的参数与出片落在车尾那台生成节点上", async () => {
      const ctx = await genPage([recipeNode("r1", 0, { anchors: "first", seed: 100 })], [], { routes: clipRoutes() });
      await deepSettle();
      assert.equal(ctx.genBtn("r1", "平铺展开").textContent.trim(), "平铺展开", "展开方式先站在平铺那一挡");
      click(ctx.genBtn("r1", "平铺展开"));
      await settle();
      assert.equal(ctx.genBtn("r1", "串联展开").textContent.trim(), "串联展开", "按一下就换到串联那一挡");
      assert.equal(ctx.page.current().nodes.find((n) => n.id === "r1").metadata.expand_mode, "train");
      click(ctx.genBtn("r1", "展开配方"));
      await settle();
      const made = ctx.page.current().nodes.filter((n) => n.id !== "r1");
      const typed = (type) => made.filter((n) => n.type === type);
      assert.deepEqual([typed("recipe").length, typed("text").length, typed("video").length, typed("image").length, typed("gen").length],
        [2, 2, 0, 3, 1], "两段就是两台车厢、两块正文、三张参考素材与一台车尾：串联不铺成片位");
      const [car1, car2] = typed("recipe");
      const tail = typed("gen")[0];
      assert.deepEqual([car1.metadata.train, car2.metadata.train], [1, 1], "车厢认得自己是串联里的一段");
      assert.deepEqual([car1.metadata.segment, car2.metadata.segment], [0, 1], "段号按段序落进车厢");
      assert.deepEqual([car1.width, car1.height], [360, 152], "车厢落的是精简卡的尺寸");
      assert.deepEqual([typed("text")[0].width, typed("text")[0].height], [360, 220],
        "正文与车厢同宽，铺得比平铺那一挡宽——整段提示词读得完");
      assert.equal(car1.metadata.anchors, undefined, "锚点与步数这一套不落在车厢上");
      const carEl = ctx.view.nodeEl(car1.id);
      assert.ok(carEl.querySelector(".ns-canvas-car"), "车厢走的是精简卡那一层");
      assert.ok(!carEl.querySelector(".ns-canvas-gen-go"), "车厢上没有出片钮：整列出片在车尾");
      assert.ok(!nodeAct(ctx.view, car1.id, "expand"), "车厢不给「展开配方」那一枚：点了是把同一份配方再铺一遍");
      assert.deepEqual(typed("recipe").map((n) => ctx.view.nodeEl(n.id)
        .querySelectorAll(".ns-canvas-gen-btn").length), [1, 1], "车厢上一枚钮都没有：只有停用那一枚");
      assert.deepEqual([tail.metadata.chain, tail.metadata.kind, tail.metadata.recipe,
        tail.metadata.anchors, tail.metadata.seed], ["train", "video", "短片配方", "first", 100],
        "整列共用的那一份参数在车尾");
      const conns = ctx.page.current().connections;
      const wired = (from, to) => conns.some((c) => c.fromNodeId === from && c.toNodeId === to);
      assert.ok(wired(car1.id, car2.id), "第 1 段接到第 2 段");
      assert.ok(wired(car2.id, tail.id), "最后一节接到车尾");
      assert.ok(wired(typed("text")[0].id, car1.id), "这一段的正文连到自己那台车厢");
      assert.equal(typed("text")[0].position.x, car1.position.x, "正文与车厢同列");
      assert.ok(typed("text")[0].position.y < car1.position.y, "正文落在车厢上方");
      const refs = typed("image");
      assert.deepEqual(refs.map((n) => [n.width, n.height]), [[176, 124], [176, 124], [176, 124]],
        "素材节点比平铺那一挡小一档：两列正好铺满车厢那一列的宽");
      assert.deepEqual(refs.map((n) => [n.position.x, n.position.y]), [[426, 488], [610, 488], [826, 488]],
        "素材铺在自己那台车厢正下方：第 1 段两张，第 2 段一张");
      assert.ok(wired(refs[0].id, car1.id) && wired(refs[1].id, car1.id) && wired(refs[2].id, car2.id),
        "每一张素材连到自己那一段的车厢");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("已串开 2 段")));
      undoKey();
      await settle();
      assert.deepEqual([ctx.page.current().nodes.length, ctx.page.current().connections.length], [1, 0],
        "撤销一次退掉整批");
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
      const ctx = await genPage([recipeNode("r1", 0, { expand_mode: "train", seed: 100, steps: 25, anchors: "first" })],
        [], { routes });
      await deepSettle();
      click(ctx.genBtn("r1", "展开配方"));
      await settle();
      const made = ctx.page.current().nodes.filter((n) => n.id !== "r1");
      const tail = made.find((n) => n.type === "gen");
      const cars = made.filter((n) => n.type === "recipe");
      click(ctx.genBtn(tail.id, "出片"));
      await settle();
      assert.equal(ctx.genText(tail.id, "status"), "串联出片 1/2", "第一段收摊，车尾那一行进一格");
      const clips = () => ctx.page.current().nodes.filter((n) => n.type === "video");
      assert.equal(clips().length, 1, "车厢没有成片位：第一段收摊时新开一台视频位");
      assert.ok(clipVideoSrc(ctx, clips()[0].id), "新开的那一台落上这一段的成片");
      assert.ok(ctx.page.current().connections.some((c) => c.fromNodeId === cars[0].id
        && c.toNodeId === clips()[0].id), "新开的视频位接在出片那一发上，与平铺同一口径");
      releaseGate();
      await deepSettle();
      assert.equal(ctx.genText(tail.id, "status"), "", "整列收完车尾收摊");
      const calls = clipCalls("/neo_video_gen/run_segment");
      assert.deepEqual(calls.map((c) => c.body.segment), [0, 1], "按链序一段一发");
      assert.deepEqual(calls.map((c) => c.body.seed), [100, 101], "种子按段号偏移（车尾那一份是起手）");
      assert.deepEqual(calls.map((c) => [c.body.recipe, c.body.anchors, c.body.steps,
        c.body.continuity, c.body.context_frames]),
      [["短片配方", "first", 25, true, 22], ["短片配方", "first", 25, true, 22]], "公共参数取的是车尾那一份");
      assert.equal(calls[0].body.prompt, "开场那一段的提示词", "正文走的是这一段上方的那块正文节点");
      assert.deepEqual(calls.map((c) => c.body.references.images), [
        [{ kind: "recipe", value: "开场首帧.png", recipe: "短片配方" },
          { kind: "recipe", value: "角色设定.png", recipe: "短片配方" }],
        [{ kind: "recipe", value: "收尾参考.mp4", recipe: "短片配方" }]],
      "厢底摊出的素材连配方名一起交后端：这一段跑的是它自己那几张");
      assert.deepEqual(clips().map((c) => ctx.view.nodeEl(c.id)?.querySelector("video")?.getAttribute("src") || ""),
        ["/neo_gallery/video?filename=seg0.mp4&subfolder=director",
          "/neo_gallery/video?filename=seg0.mp4&subfolder=director"],
        "两段各落各的视频位，车尾自己不落片");
      assert.equal(clips().length, 2, "第二段收摊时再开一台");
    });

    test("停用一段：整列跳过这一段，这一张压暗并挂徽标", async () => {
      let seq = 0;
      const routes = { ...clipRoutes(),
        "/neo_video_gen/run_segment": () => jsonResponse({ success: true, task_id: `chain-${++seq}`, status: "queued" }) };
      const ctx = await genPage([recipeNode("r1", 0, { expand_mode: "train" })], [], { routes });
      await deepSettle();
      click(ctx.genBtn("r1", "展开配方"));
      await settle();
      const made = ctx.page.current().nodes.filter((n) => n.id !== "r1");
      const cars = made.filter((n) => n.type === "recipe");
      const tail = made.find((n) => n.type === "gen");
      click(ctx.genBtn(cars[1].id, "停用"));
      await settle();
      assert.equal(ctx.page.current().nodes.find((n) => n.id === cars[1].id).metadata.disabled, true);
      assert.ok(ctx.view.nodeEl(cars[1].id).classList.contains("ns-canvas-node-off"), "停用的那一张压暗");
      assert.ok(ctx.view.nodeEl(cars[1].id).textContent.includes("已停用"), "停用的那一张挂徽标");
      assert.ok(ctx.genBtn(cars[1].id, "启用"), "停用的那一张给启用这一枚");
      assert.equal(ctx.view.nodeEl(tail.id).querySelector(".ns-canvas-recipe-info-text").textContent,
        "链上 2 段 · 启用 1 段", "车尾那一行说这一列跑几段");
      click(ctx.genBtn(tail.id, "出片"));
      await deepSettle();
      assert.deepEqual(clipCalls("/neo_video_gen/run_segment").map((c) => c.body.segment), [0],
        "整列出片跳过停用的那一段");
      click(ctx.genBtn(cars[0].id, "停用"));
      await settle();
      click(ctx.genBtn(tail.id, "出片"));
      await settle();
      assert.equal(clipCalls("/neo_video_gen/run_segment").length, 1, "全停用就不入队");
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("链上没有启用的段")));
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
      const ctx = await genPage([recipeNode("r1", 0, { expand_mode: "train", seed: 100 })], [], { routes });
      await deepSettle();
      click(ctx.genBtn("r1", "展开配方"));
      await settle();
      const tail = ctx.page.current().nodes.find((n) => n.type === "gen");
      click(ctx.genBtn(tail.id, "出片"));
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

    test("串联的车厢是精简卡：只有停用这一枚，出片与公共参数都不在这一张上", async () => {
      const ctx = await genPage([{ ...recipeNode("c1", 0, { train: 1, segment: 0 }), width: 360, height: 152 }],
        [], { routes: clipRoutes() });
      await deepSettle();
      const el = ctx.view.nodeEl("c1");
      assert.ok(el.querySelector(".ns-canvas-car"), "车厢走的是精简卡那一层");
      assert.ok(ctx.genBtn("c1", "停用"), "车厢上就有停用这一枚");
      assert.ok(!el.querySelector(".ns-canvas-gen-go"), "车厢上没有出片钮：整列出片在车尾那台生成节点");
      assert.ok(!el.querySelector("select"), "配方 / 步数 / 锚点那些下拉不在车厢上");
      assert.ok(!el.querySelector(".ns-canvas-recipe-segs"), "段列表也不在车厢上");
      click(ctx.genBtn("c1", "停用"));
      await settle();
      assert.equal(ctx.page.current().nodes.find((n) => n.id === "c1").metadata.disabled, true,
        "停用是车厢上唯一的控制");
      assert.equal(clipCalls("/neo_video_gen/run_segment").length, 0, "车厢这一张不发片");
    });

    test("车尾生成节点上游没有车厢时说清楚：不发请求", async () => {
      const ctx = await genPage([videoGen("tail1", 0, { chain: "train", skill_id: "", recipe: "短片配方" })], [],
        { routes: clipRoutes() });
      await deepSettle();
      assert.ok(ctx.genText("tail1", "model").includes("2 段"), "车尾那一行说它带的是哪一份配方");
      click(ctx.genBtn("tail1", "出片"));
      await settle();
      assert.equal(clipCalls("/neo_video_gen/run_segment").length, 0);
      assert.ok(ctx.env.store.toasts.some((item) => item.message.includes("上游没有段节点")));
    });

    test("切走画布停掉在出的片的轮询：卸页后不再问进度", async () => {
      const ctx = await genPage([promptNode("t1", "一句"), videoGen("v1", 0), videoSlot("vid1", 700)],
        [link("t1", "v1"), link("v1", "vid1")],
        { gen: { canvases: [{ id: "canvas-0002", title: "乙", nodes: [], connections: [],
          viewport: { x: 0, y: 0, k: 1 }, background_mode: "dots" }] },
          routes: clipRoutes({ snaps: [{ success: true, task_id: "clip-1", status: "running",
            progress: { value: 3, max: 120 } }] }) });
      await deepSettle();
      click(ctx.genBtn("v1", "出片"));
      await deepSettle();
      assert.equal(clipCalls("/neo_video_gen/simple").length, 1, "提交完先拉一格");
      assert.equal(clipPolls("clip-1").length, 1);
      ctx.view.select.value = "canvas-0002";
      fire(ctx.view.select, "change");
      await settle();
      const polls = clipPolls("clip-1").length;
      await deepSettle();
      assert.equal(clipPolls("clip-1").length, polls, "切走画布停掉这一发的轮询");
    });

  });
});