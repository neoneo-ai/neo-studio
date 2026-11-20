// 网格尾部的载入行：状态行即哨兵，进视口取下一页；取完写「已全部载入」并断开观察。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, clearRoutes, flush } from "./setup.mjs";

let utils;
async function loadUtils() {
    if (!utils) utils = await import("../../web/gallery-utils.js");
    return utils;
}

function installQueueObserver(spy) {
    globalThis.IntersectionObserver = class {
        constructor(cb) {
            this._cb = cb;
            this.targets = [];
            spy.observers.push(this);
        }
        observe(el) { this.targets.push(el); }
        unobserve(el) { this.targets = this.targets.filter(t => t !== el); }
        disconnect() { this.stopped = true; }
        fire(el, isIntersecting) {
            // 真浏览器断开观察后回调不再触发：桩按同一语义门住，用例才验得出 release
            if (this.stopped) return;
            this._cb([{ target: el, isIntersecting }], this);
        }
    };
}

function makeQueue(total, pageSize) {
    const state = { queue: Array.from({ length: total }, (_, i) => i), rendered: 0 };
    return {
        state,
        opts: {
            hasMore: () => state.queue.length,
            loaded: () => state.rendered,
            loadMore: () => {
                const page = state.queue.splice(0, pageSize);
                for (const item of page) {
                    const card = document.createElement("div");
                    card.className = "neo-gallery-thumb-container";
                    grid.appendChild(card);
                }
                state.rendered += page.length;
            },
            getScrollContainer: () => window,
        },
    };
}

let grid;
function makeGrid() {
    grid = document.createElement("div");
    grid.className = "neo-gallery-image-grid";
    document.body.appendChild(grid);
    return grid;
}

test("载入行排在网格末尾，未取完时写剩余条数", async () => {
    resetEnv();
    const spy = { observers: [] };
    installQueueObserver(spy);
    const { attachQueueTailLoader } = await loadUtils();
    makeGrid();
    const { state, opts } = makeQueue(250, 100);
    opts.loadMore();          // 首屏一页先排出去
    attachQueueTailLoader(grid, opts);

    const row = grid.querySelector(".neo-gallery-load-status");
    assert.equal(row.textContent, "继续滚动载入更多 · 剩余 150", "未取完时写剩余条数");
    assert.equal(grid.lastElementChild, row, "载入行是网格末尾那枚哨兵");
});

test("载入行进视口取下一页；取完写「已全部载入」并断开观察", async () => {
    resetEnv();
    const spy = { observers: [] };
    installQueueObserver(spy);
    const { attachQueueTailLoader } = await loadUtils();
    makeGrid();
    const { state, opts } = makeQueue(150, 100);
    opts.loadMore();
    attachQueueTailLoader(grid, opts);
    const row = grid.querySelector(".neo-gallery-load-status");
    const observer = spy.observers[spy.observers.length - 1];

    observer.fire(row, true);
    await flush(10);
    assert.equal(state.rendered, 150, "进视口取走下一页");
    assert.equal(row.textContent, "已全部载入 · 150", "取完写已载入条数");
    assert.ok(row.classList.contains("neo-gallery-load-status--done"), "取完状态打上 done");
    assert.equal(grid.lastElementChild, row, "新卡片排在载入行前面");

    // 取完之后行再进视口也不该再取
    observer.fire(row, true);
    assert.equal(state.rendered, 150, "队列空了就不再取页");
});

test("release 之后哨兵不再取页（视图换掉时断开观察）", async () => {
    resetEnv();
    const spy = { observers: [] };
    installQueueObserver(spy);
    const { attachQueueTailLoader } = await loadUtils();
    makeGrid();
    const { state, opts } = makeQueue(300, 100);
    opts.loadMore();
    const loader = attachQueueTailLoader(grid, opts);
    const row = grid.querySelector(".neo-gallery-load-status");
    const observer = spy.observers[spy.observers.length - 1];

    loader.release();
    observer.fire(row, true);
    assert.equal(state.rendered, 100, "断开观察后旧网格的取页不再被触发");
});

test("没有 IntersectionObserver 的宿主：载入行退化成点一下载下一页", async () => {
    resetEnv();
    const saved = globalThis.IntersectionObserver;
    delete globalThis.IntersectionObserver;
    try {
        const { attachQueueTailLoader } = await loadUtils();
        makeGrid();
        const { state, opts } = makeQueue(200, 100);
        opts.loadMore();
        attachQueueTailLoader(grid, opts);
        const row = grid.querySelector(".neo-gallery-load-status");
        assert.ok(row.classList.contains("neo-gallery-load-status--clickable"), "退化状态下发可点击样式");
        row.onclick();
        assert.equal(state.rendered, 200, "点一次取下一页");
        assert.equal(row.textContent, "已全部载入 · 200");
    } finally {
        Object.defineProperty(globalThis, "IntersectionObserver", { value: saved, configurable: true, writable: true });
    }
});
