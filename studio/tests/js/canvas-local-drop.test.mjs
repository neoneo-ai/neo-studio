// 画布收本地文件拖放（interactions.js 的落点判定 + page.js 的落盘与落节点）：
// 落到节点上就是换它，落在画布空白就是加一张；正文类文件不读服务端，图片 / 视频 / 音频走画布自己
// 那条文件写入落进 ComfyUI 的 input/ —— 内核在不在跑与这一放无关
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { resetEnv, mockRoute, jsonResponse, flush, sleep, makeFile, fetchLog } from "./setup.mjs";

const geometry = await import("../../web/studio/pages/canvas/geometry.js?dropGeo=1");
const store = await import("../../web/studio/pages/canvas/store.js?dropStore=1");
const page = await import("../../web/studio/pages/canvas/page.js?dropPage=1");
const types = await import("../../web/studio/pages/canvas/node-types.js?dropTypes=1");
const canvas = { ...geometry, ...store, ...page };
const { $el } = await import("../../web/studio/shim/ui.js?dropPage=1");

const STAGE = { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 };
const CENTER = { x: STAGE.width / 2, y: STAGE.height / 2 };
const settle = () => flush(20);

/** 画布与落盘路由的替身：/neo_canvas/upload 按 studio/canvas.py 那一份形状回 {success, filename, subfolder}，
 *  重名追加序号在 handler 那一侧；oversize 里的文件名回 413，与 MAX_UPLOAD_BYTES 那条拒收同一形状 */
function mockEnv({ oversize = [] } = {}) {
  const store = { projects: [], uploads: 0, toasts: [] };
  const routes = {
    "/neo_canvas/list": () => jsonResponse({ success: true, projects: store.projects }),
    "/neo_canvas/project": (body, call) => (call.method === "GET"
      ? jsonResponse({ success: true, project: null })
      : jsonResponse({ success: true, id: body.id })),
    "/neo_canvas/upload": (body, call) => {
      if (oversize.includes(call.query.get("name"))) return jsonResponse({ success: false, error: "文件超过 48MB" }, 413);
      store.uploads += 1;
      return jsonResponse({ success: true, filename: `drop_${store.uploads}.png`, subfolder: "" });
    },
  };
  return { store, routes, api: { fetchApi: (path, opts = {}) => fetch(path, opts) },
    toast: (message, kind = "info") => { store.toasts.push({ message, kind }); } };
}

async function makePage(env = mockEnv()) {
  resetEnv();
  for (const [route, responder] of Object.entries(env.routes)) mockRoute(route, responder);
  document.body.innerHTML = '<div class="ns-page"></div>';
  const host = document.querySelector(".ns-page");
  const canvasPage = canvas.createCanvasPage({ $el, api: env.api, toast: env.toast });
  await canvasPage.build(host);
  const stage = host.querySelector(".ns-canvas-stage");
  stage.__rect = { ...STAGE };
  const nodeLayer = host.querySelector(".ns-canvas-nodes");
  const view = {
    stage, nodeLayer,
    nodeEl: (id) => nodeLayer.querySelector(`[data-node-id="${id}"]`),
    box: (id) => {
      const el = view.nodeEl(id);
      return { w: parseFloat(el.style.width), h: parseFloat(el.style.height) };
    },
  };
  return { page: canvasPage, view, env };
}

/** 本地文件拖放：drop 事件的 dataTransfer.files 就是浏览器交出的那一批（坐标要给，落点按它算） */
function dropFilesAt(el, files, x = CENTER.x, y = CENTER.y) {
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files, types: ["Files"] }, configurable: true });
  Object.assign(ev, { clientX: x, clientY: y });
  el.dispatchEvent(ev);
  return ev;
}
function dropGalleryAt(el, picked, x = CENTER.x, y = CENTER.y) {
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", {
    value: { types: ["application/x-neo-gallery"], files: [],
      getData: (type) => (type === "application/x-neo-gallery" ? JSON.stringify(picked) : "") },
    configurable: true,
  });
  Object.assign(ev, { clientX: x, clientY: y });
  el.dispatchEvent(ev);
  return ev;
}
/** 原生文件拖放的 dragover：这一发浏览器只交出 types，坐标是系统拖放循环给的（下面三条吃的就是它） */
function dragOverAt(el, x, y) {
  const ev = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { types: ["Files"], files: [] }, configurable: true });
  Object.assign(ev, { clientX: x, clientY: y });
  el.dispatchEvent(ev);
  return ev;
}
/** 正文文件是 FileReader 真异步读出来的：等到这一发落到画布上（满载 runner 上固定时长读不完） */
async function waitFor(ready) {
  for (let i = 0; i < 50 && !ready(); i += 1) await sleep(10);
}
const toasts = (env) => env.store.toasts.map((item) => item.message);
const nodes = (page) => page.current().nodes.map((n) => [n.type, n.metadata.filename ?? n.metadata.content ?? ""]);
const uploads = () => fetchLog.filter((c) => c.path === "/neo_canvas/upload").map((c) => c.query.get("name"));
const kernelUploads = () => fetchLog.filter((c) => c.path === "/upload/image").map((c) => c.method);

describe("canvas 本地文件拖入", () => {
  test("拖进一张本地图片：先落进 input/，再按服务端改名后的名字落一张图片节点", async () => {
    const { page, view } = await makePage();
    dropFilesAt(view.stage, [makeFile("cat.png", "image/png")]);
    await settle();
    assert.deepEqual(nodes(page), [["image", "drop_1.png"]]);
    assert.deepEqual(uploads(), ["cat.png"], "画布的预览与出片只认 input/ 里的文件，本地文件必须先落进去");
    assert.deepEqual(kernelUploads(), [], "拖放不发 /upload/image —— 那条在内核身上，内核没起来这一放就该照样成");
    const id = page.current().nodes[0].id;
    assert.deepEqual([view.box(id).w, view.box(id).h], [340, 360], "落点站在图片节点默认那一档（竖友好）");
  });

  test("一次拖进多张图按落点铺开：三张不叠在同一处，也不出一句多余的话", async () => {
    const { page, view, env } = await makePage();
    dropFilesAt(view.stage, [makeFile("a.png", "image/png"), makeFile("b.png", "image/png"),
      makeFile("c.png", "image/png")]);
    await settle();
    assert.deepEqual(nodes(page), [["image", "drop_1.png"], ["image", "drop_2.png"], ["image", "drop_3.png"]]);
    assert.deepEqual(env.store.toasts, [], "拖放落点自己铺料不出 toast —— 「已摆到画布」是结果板那一发的话");
    const [first, second] = page.current().nodes;
    assert.ok(first.position.x !== second.position.x || first.position.y !== second.position.y,
      "三张不叠在同一处");
  });

  test("片落视频输入、声音落音频输入：落成图片节点就是卡上一张读不出来的占位图", async () => {
    const { page, view } = await makePage();
    dropFilesAt(view.stage, [makeFile("clip.mp4", "video/mp4")]);
    await settle();
    dropFilesAt(view.stage, [makeFile("voice.mp3", "audio/mpeg")]);
    await settle();
    assert.deepEqual(nodes(page), [["video_in", "drop_1.png"], ["audio_in", "drop_2.png"]]);
  });

  test("正文文件落一张提示词节点：不上传，正文就是文件里那一段", async () => {
    const { page, view } = await makePage();
    dropFilesAt(view.stage, [makeFile("note.txt", "text/plain", "一句要用的提示词")]);
    await waitFor(() => page.current().nodes.length);
    assert.deepEqual(nodes(page), [["text", "一句要用的提示词"]]);
    assert.deepEqual(uploads(), [], "正文进的是 metadata.content，不落 input/");
  });

  test("落到节点上就是换它：图片节点换一张，节点数量不动", async () => {
    const { page, view } = await makePage();
    dropFilesAt(view.stage, [makeFile("first.png", "image/png")]);
    await settle();
    const id = page.current().nodes[0].id;
    dropFilesAt(view.nodeEl(id), [makeFile("second.png", "image/png")]);
    await settle();
    assert.deepEqual(nodes(page), [["image", "drop_2.png"]], "落在它身上的那一张换的是它");
  });

  test("落到节点上但类型对不上：不动那张节点，另建一张输入节点并说清", async () => {
    const { page, view, env } = await makePage();
    dropFilesAt(view.stage, [makeFile("first.png", "image/png")]);
    await settle();
    const id = page.current().nodes[0].id;
    dropFilesAt(view.nodeEl(id), [makeFile("clip.mp4", "video/mp4")]);
    await settle();
    assert.deepEqual(nodes(page), [["image", "drop_1.png"], ["video_in", "drop_2.png"]],
      "把一段片换进图片节点，卡上是占位图，出片也吃不到它");
    assert.deepEqual(toasts(env), ["这一张节点吃的是图片 · 已另建一张视频输入"]);
  });

  test("一次拖一批落到节点上：首张换它，其余按添加铺开", async () => {
    const { page, view } = await makePage();
    dropFilesAt(view.stage, [makeFile("first.png", "image/png")]);
    await settle();
    const id = page.current().nodes[0].id;
    dropFilesAt(view.nodeEl(id), [makeFile("a.png", "image/png"), makeFile("b.png", "image/png")]);
    await settle();
    assert.equal(page.current().nodes.find((n) => n.id === id).metadata.filename, "drop_2.png");
    assert.deepEqual(nodes(page).map(([type]) => type), ["image", "image"]);
  });

  test("正文文件落到提示词节点：换的是这一格的正文", async () => {
    const { page, view } = await makePage();
    dropFilesAt(view.stage, [makeFile("old.txt", "text/plain", "旧的一段")]);
    await waitFor(() => page.current().nodes.length);
    const id = page.current().nodes[0].id;
    dropFilesAt(view.nodeEl(id), [makeFile("new.txt", "text/plain", "新的一段")]);
    await waitFor(() => page.current().nodes.find((n) => n.id === id)?.metadata.content === "新的一段");
    assert.deepEqual(nodes(page), [["text", "新的一段"]]);
  });

  test("画布不收的文件不收：说一句，不铺一张读不出来的节点", async () => {
    const { page, view, env } = await makePage();
    dropFilesAt(view.stage, [makeFile("pack.zip", "application/zip")]);
    await settle();
    assert.deepEqual(nodes(page), []);
    assert.deepEqual(toasts(env), ["画布不吃这个文件：pack.zip"]);
    assert.deepEqual(uploads(), [], "不收的文件不落 input/");
  });

  test("超体积那一张只说它自己：旁边那张照样落进 input/", async () => {
    const { page, view, env } = await makePage(mockEnv({ oversize: ["big.png"] }));
    dropFilesAt(view.stage, [makeFile("big.png", "video/mp4"), makeFile("cat.png", "image/png")]);
    await settle();
    assert.deepEqual(nodes(page), [["image", "drop_1.png"]]);
    assert.deepEqual(toasts(env), ["上传失败（413）：big.png"], "状态码带在话里，与文件名不合法那条分得开");
    assert.deepEqual(uploads(), ["big.png", "cat.png"], "拒收那一张不挡后面那张");
  });

  test("素材卡片照同一条规则：落空白是添加，落节点是更换，类型对不上就另建", async () => {
    const { page, view } = await makePage();
    dropGalleryAt(view.stage, { filename: "from-lib.mp4", subfolder: "neo_gen/v" });
    await settle();
    const id = page.current().nodes[0].id;
    assert.deepEqual(nodes(page), [["video_in", "from-lib.mp4"]]);
    dropGalleryAt(view.nodeEl(id), { filename: "second-lib.png", subfolder: "" });
    await settle();
    assert.deepEqual(nodes(page), [["video_in", "from-lib.mp4"], ["image", "second-lib.png"]]);
    dropGalleryAt(view.nodeEl(id), { filename: "clip2.mp4", subfolder: "" });
    await settle();
    assert.deepEqual(page.current().nodes.filter((n) => n.type === "video_in")
      .map((n) => [n.type, n.metadata.filename]), [["video_in", "clip2.mp4"]],
    "落在它身上的那一张卡片换的是它");
  });

  test("本地文件拖过舞台时接住这一放：不接住就是浏览器把窗口导航到 file:///", async () => {
    const { view } = await makePage();
    const ev = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: { types: ["Files"], files: [] }, configurable: true });
    view.stage.dispatchEvent(ev);
    assert.ok(ev.defaultPrevented, "dragover 阶段浏览器只交出 types，判定要吃它");
  });

  test("原生拖放的 drop 那一发不带坐标：落点是最后一次 dragover 的指针位置", async () => {
    const { page, view } = await makePage();
    dragOverAt(view.stage, 500, 320);
    dropFilesAt(view.stage, [makeFile("cat.png", "image/png")], 0, 0);
    await settle();
    const spec = types.NODE_SPECS.image;
    const vp = page.current().viewport;
    assert.deepEqual(page.current().nodes[0].position,
      { x: (500 - vp.x) / vp.k - spec.width / 2, y: (320 - vp.y) / vp.k - spec.height / 2 },
      "Chromium / WebView2 在原生文件拖放上交出 (0,0)，按它算就是节点落在画布角落，用户看到的正是「位置不对」");
  });

  test("dragover 与 drop 都不带坐标：落在视口中心，不落在角落", async () => {
    const { page, view } = await makePage();
    dragOverAt(view.stage, 0, 0);
    dropFilesAt(view.stage, [makeFile("cat.png", "image/png")], 0, 0);
    await settle();
    const spec = types.NODE_SPECS.image;
    const vp = page.current().viewport;
    assert.deepEqual(page.current().nodes[0].position,
      { x: (CENTER.x - vp.x) / vp.k - spec.width / 2, y: (CENTER.y - vp.y) / vp.k - spec.height / 2 });
  });

  test("坐标没带过来的那一发，换的是 dragover 指针下那枚节点", async () => {
    const { page, view } = await makePage();
    dropFilesAt(view.stage, [makeFile("first.png", "image/png")]);
    await settle();
    const id = page.current().nodes[0].id;
    dragOverAt(view.nodeEl(id), 500, 320);
    dropFilesAt(view.stage, [makeFile("second.png", "image/png")], 0, 0);
    await settle();
    assert.deepEqual(nodes(page), [["image", "drop_2.png"]],
      "落点事件不带坐标时它的 target 是 (0,0) 那头的元素，指针下那枚节点只在 dragover 里拿得到");
  });
});
