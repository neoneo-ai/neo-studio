// Neo Gallery 顶部工具条：前进/后退与重扫按钮、导航历史栈、按钮禁用态、新导航截断前进分支、重挂载回到离开时的视图。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, mockRoute, flush } from "./setup.mjs";

// gallery.js 必须在 setup（模块钩子）装好后动态导入，scripts/* shim 才能生效
let NeoGallery;
async function loadNeoGallery() {
    if (!NeoGallery) ({ NeoGallery } = await import("../../web/gallery.js"));
    return NeoGallery;
}

function makeGallery() {
    const gallery = new NeoGallery({});
    // 渲染走真实 GalleryList（面包屑等），仅跳过重绘与滚动持久化
    gallery.list.sortAndDisplayImages = async () => {};
    gallery.list._saveCurrentScrollPosition = async () => {};
    mockRoute("/neo_gallery/list", { directories: [{ subdirs: {}, root_count: 0 }], covers: {} });
    return gallery;
}

test("导航历史：后退/前进按钮切换视图并更新禁用态", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    document.body.appendChild(gallery.element);

    const backBtn = gallery.navBackBtn;
    const fwdBtn = gallery.navForwardBtn;
    assert.ok(backBtn && fwdBtn, "头部应包含后退/前进按钮");

    await gallery.showCategoryCards();
    assert.equal(backBtn.disabled, true, "首页无历史，后退禁用");
    assert.equal(fwdBtn.disabled, true, "首页无历史，前进禁用");

    await gallery.showDirectoryStructure("Output", ["a"]);
    assert.deepEqual(gallery.currentView, { mode: "directory", source: "Output", categoryPath: ["a"] });
    assert.equal(backBtn.disabled, false);
    assert.equal(fwdBtn.disabled, true);

    const ok = await gallery.navigateHistory(-1);
    assert.equal(ok, true);
    assert.equal(gallery.currentView.mode, "categories");
    assert.equal(backBtn.disabled, true);
    assert.equal(fwdBtn.disabled, false);

    const ok2 = await gallery.navigateHistory(1);
    assert.equal(ok2, true);
    assert.deepEqual(gallery.currentView, { mode: "directory", source: "Output", categoryPath: ["a"] });
    assert.equal(backBtn.disabled, false);
    assert.equal(fwdBtn.disabled, true);

    // 越界返回 false，视图不变
    assert.equal(await gallery.navigateHistory(1), false);
    assert.equal(gallery.currentView.mode, "directory");
});

test("导航历史：新导航截断前进分支", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    document.body.appendChild(gallery.element);

    await gallery.showCategoryCards();
    await gallery.showDirectoryStructure("Output", ["a"]);
    await gallery.navigateHistory(-1); // 回到首页，前进分支存在
    assert.equal(gallery.navForwardBtn.disabled, false);

    await gallery.showDirectoryStructure("Output", ["b"]);
    assert.deepEqual(gallery._navStack.map((v) => v.categoryPath), [[], ["b"]]);
    assert.equal(gallery.navForwardBtn.disabled, true, "新导航后前进分支被截断");
});

test("头部渲染三颗工具条按钮（后退 / 前进 / 重扫），禁用态下点击不触发", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    document.body.appendChild(gallery.element);

    const btns = [...document.querySelectorAll(".neo-gallery-nav-btn")];
    assert.equal(btns.length, 3, "后退 / 前进 / 重扫三颗");
    assert.equal(btns[0].title, "后退 (Back)");
    assert.equal(btns[1].title, "前进 (Forward)");
    assert.equal(btns[2].title, "重新扫描（刷新当前视图）", "重扫紧跟在导航按钮后面");

    let called = 0;
    gallery.navigateHistory = async () => { called += 1; return false; };
    btns[0].disabled = true;
    btns[0].click();
    await flush();
    assert.equal(called, 0, "禁用按钮点击不应触发导航");
});

test("重扫按钮：重进当前目录，刷新期间禁用自己", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    document.body.appendChild(gallery.element);

    const btn = [...document.querySelectorAll(".neo-gallery-nav-btn")][2];
    gallery.currentView = { mode: "directory", source: "Output", categoryPath: ["a"] };
    const calls = [];
    gallery.showDirectoryStructure = async (src, segs) => { calls.push([src, segs, btn.disabled]); };
    btn.click();
    await flush();
    assert.deepEqual(calls, [["Output", ["a"], true]], "刷的是当前目录，且刷新期间按钮禁用");
    assert.equal(btn.disabled, false, "重扫完成后按钮恢复可点");
});

test("首页重扫：重读目录树再重绘，导航恢复标记复位", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    document.body.appendChild(gallery.element);

    gallery.currentView = { mode: "categories", source: null, categoryPath: [] };
    const calls = [];
    gallery.loadGallery = async () => { calls.push(["load", gallery._navRestoring]); };
    gallery.list.sortAndDisplayImages = async () => { calls.push(["draw", gallery._navRestoring]); };
    await gallery.refreshCurrent();
    assert.deepEqual(calls, [["load", true], ["draw", true]], "先重读目录树再重绘，全程不算一次导航");
    assert.equal(gallery._navRestoring, false, "刷新完把导航恢复标记交回去");
});

test("重挂载回到离开时的视图：侧栏 tab 重画不得把二级目录拽回首页", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    document.body.appendChild(gallery.element);

    const calls = [];
    gallery.list.sortAndDisplayImages = async () => { calls.push("home"); };
    // 记录 _navRestoring：真 showDirectoryStructure 靠它跳过 history.pushState
    gallery.showDirectoryStructure = async (src, segs) => { calls.push(["dir", src, segs, gallery._navRestoring]); };
    gallery.showLocalBookmarks = async () => { calls.push("marks"); };

    await gallery.renderCurrentView();
    assert.deepEqual(calls, ["home"], "首页状态重挂载仍画首页");

    gallery.currentView = { mode: "directory", source: "Output", categoryPath: ["a", "b"] };
    calls.length = 0;
    await gallery.renderCurrentView();
    assert.deepEqual(calls, [["dir", "Output", ["a", "b"], true]], "目录状态重画离开时那个目录，且不写浏览器历史");

    gallery.currentView = { mode: "local_bookmarks", source: "本地收藏", categoryPath: [] };
    calls.length = 0;
    await gallery.renderCurrentView();
    assert.deepEqual(calls, ["marks"], "收藏页状态重挂载回到收藏页");
    assert.equal(gallery._navRestoring, false, "重挂载结束要清掉 _navRestoring");
});

test("素材目录按宿主分开记录：导演弹窗与绘画页弹窗互不覆盖", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    const directorHost = document.createElement("div");
    directorHost.dataset.libScope = "director";
    const paintHost = document.createElement("div");
    paintHost.dataset.libScope = "paint";
    document.body.appendChild(directorHost);
    directorHost.appendChild(gallery.element);
    await gallery.showDirectoryStructure("Output", ["a"]);
    gallery.rememberView(directorHost);

    // 绘画页弹窗没有记录：沿用当前视图；它自己翻进的目录只记在自己名下
    directorHost.removeChild(gallery.element);
    gallery.applyView(paintHost);
    assert.equal(gallery.currentView.categoryPath.join("/"), "a", "没有记录的宿主沿用当前视图");
    await gallery.showDirectoryStructure("Input", ["x"]);
    gallery.rememberView(paintHost);

    gallery.applyView(directorHost);
    assert.deepEqual(gallery.currentView, { mode: "directory", source: "Output", categoryPath: ["a"] },
        "回到导演页恢复导演页自己记的目录");
    assert.deepEqual(gallery._libViews.paint.categoryPath, ["x"], "绘画页的记录不被导演页覆盖");
});

// 关弹窗时收留宿主正是画廊页宿主：render 先清空目标宿主，会把画廊从当前宿主摘走，
// 旧宿主身份丢失 → 弹窗里浏览的目录记不下来，重开弹窗落回首页。
test("素材库弹窗开合（收留宿主=画廊页宿主）不丢弹窗里的目录", async () => {
    resetEnv();
    clearRoutes();
    await loadNeoGallery();
    const gallery = makeGallery();
    const pageHost = document.createElement("div");
    pageHost.dataset.libScope = "page";
    const directorHost = document.createElement("div");
    directorHost.dataset.libScope = "director";
    document.body.append(pageHost, directorHost);

    await gallery.mountTo(pageHost);
    await gallery.showDirectoryStructure("Output", ["a"]);   // 画廊页在 Output/a
    await gallery.mountTo(directorHost);                       // 开弹窗：带过来
    await gallery.showDirectoryStructure("Input", ["x"]);    // 弹窗里翻进 Input/x

    await gallery.mountTo(pageHost);                          // 关弹窗（收留宿主=画廊页宿主）
    assert.deepEqual(gallery.currentView.categoryPath, ["a"], "关弹窗回到画廊页自己的目录");

    await gallery.mountTo(directorHost);                      // 重开弹窗
    assert.equal(gallery.currentView.mode, "directory");
    assert.equal(gallery.currentView.source, "Input");
    assert.deepEqual(gallery.currentView.categoryPath, ["x"], "重开弹窗回到弹窗里那个目录");
});

