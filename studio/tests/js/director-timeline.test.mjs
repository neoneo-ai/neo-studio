// DirectorTimeline 交互回归：点击选中、拖拽重排（光标插入语义 + 源块排除）、readOnly。
// canvas 无后端：ctx 用富桩替代，clientWidth/getBoundingClientRect 手动给可预测值。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, sleep } from "./setup.mjs";

// setup.mjs 先装好钩子与桩后再导入组件模块
const { DirectorTimeline } = await import("../../web/director-timeline.js");

function richCtx() {
    return new Proxy(
        {
            font: "", fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, textAlign: "left", textBaseline: "top",
            measureText: () => ({ width: 0 }),
            canvas: null,
        },
        {
            get(t, k) {
                if (k in t) return t[k];
                return () => {}; // 其余绘制方法一律 no-op
            },
            set(t, k, v) {
                t[k] = v;
                return true;
            },
        }
    );
}

function makeTimeline(segs, opts = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const calls = { select: [], reorder: [], resize: [] };
    const extResize = opts.onResize;
    const tl = new DirectorTimeline(container, Object.assign({ height: 40 }, opts, {
        getSegments: () => segs,
        onSelect: (i) => calls.select.push(i),
        onReorder: (o) => calls.reorder.push(o),
        onResize: (i, d) => {
            calls.resize.push([i, d]);
            if (extResize) extResize(i, d);
        },
    }));
    // 覆盖极简 ctx 桩：组件只读 canvas.clientWidth，绘制全走 no-op
    tl.ctx = richCtx();
    Object.defineProperty(tl.canvas, "clientWidth", { value: 320, configurable: true });
    tl.canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 92, width: 320, height: 92 };
    return { tl, container, calls };
}

const mouse = (type, x) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x });

test("点击（位移<4px）选中块，不触发 onReorder", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40); // rAF 后 _segs 就绪

    tl.canvas.dispatchEvent(mouse("mousedown", 50));
    window.dispatchEvent(mouse("mousemove", 52)); // <4px，不算拖动
    window.dispatchEvent(mouse("mouseup", 52));

    assert.deepEqual(calls.select, [0]);
    assert.equal(calls.reorder.length, 0);
    tl.destroy();
});

test("2 段：越过目标块中心才移动；落在间隙保持原序（源块不计入比较）", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);

    // W=320, padX=8：块0 [8,160]，块1 [160,312]，块1 中心 236
    tl.canvas.dispatchEvent(mouse("mousedown", 100)); // 按下块0
    window.dispatchEvent(mouse("mousemove", 250));    // 越过块1 中心 → 移到末尾
    window.dispatchEvent(mouse("mouseup", 250));

    assert.equal(calls.reorder.length, 1);
    assert.deepEqual(calls.reorder[0], [1, 0]);
    assert.equal(calls.select.length, 0); // 拖动结束不应走 select

    // 再拖：落在块1 中心之前的间隙（x=200）→ 顺序不变，但仍是"拖动"而非点击
    tl.canvas.dispatchEvent(mouse("mousedown", 100));
    window.dispatchEvent(mouse("mousemove", 200));
    window.dispatchEvent(mouse("mouseup", 200));

    assert.deepEqual(calls.reorder[1], [0, 1]);
    tl.destroy();
});

test("3 段拖到末尾：只按非源块中心点计数，不多跳", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }, { duration: 10 }]);
    await sleep(40);

    // usable=304：A[8,86.5] B[86.5,165] C[165,312]，中心 A≈47 B≈126 C≈238
    tl.canvas.dispatchEvent(mouse("mousedown", 50)); // 按下 A
    window.dispatchEvent(mouse("mousemove", 300));   // 拖过 B、C 两个中心点 → p=2
    window.dispatchEvent(mouse("mouseup", 300));

    assert.deepEqual(calls.reorder, [[1, 2, 0]]);
    tl.destroy();
});

test("3 段拖到中段：光标在 B、C 之间只越过 A 中心 → [1,0,2]", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }, { duration: 10 }]);
    await sleep(40);

    tl.canvas.dispatchEvent(mouse("mousedown", 50)); // 按下 A
    window.dispatchEvent(mouse("mousemove", 200));   // 仅越过 A 中心(47)，未过 B 中心(126)? 200>126 → p=1（B 非源，C 中心238>200）
    window.dispatchEvent(mouse("mouseup", 200));

    assert.deepEqual(calls.reorder, [[1, 0, 2]]);
    tl.destroy();
});

test("重排拖动布局：_layout(order) 按新顺序摆放、源块占落位槽、首尾相接不重叠", async () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }, { duration: 5 }, { duration: 10 }]);
    await sleep(40);

    // 无 order：原始顺序 [0,1,2]
    assert.deepEqual(tl._layout().blocks.map((b) => b.i), [0, 1, 2], "无 order 时按原始顺序");

    // 重排到新顺序 [2,0,1]：源块(2)落到最前槽，其余依次让位；块连续、无重叠
    const L = tl._layout(undefined, [2, 0, 1]);
    assert.deepEqual(L.blocks.map((b) => b.i), [2, 0, 1], "按传入 order 摆放");
    for (let k = 0; k < L.blocks.length - 1; k++) {
        const a = L.blocks[k], c = L.blocks[k + 1];
        assert.ok(Math.abs((a.x + a.w) - c.x) < 1e-6, `块${k}与块${k + 1}首尾相接不重叠`);
    }
    assert.equal(L.blocks[0].i, 2, "源块(2)在最前槽");
    assert.ok(Math.abs(L.blocks[0].x - L.padX) < 1e-6, "源块 x 起点为 padX（无重叠）");
    tl.destroy();
});

test("重排拖动：幽灵块跟随光标移动，槽位留虚框（不越内容区）", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);

    // W=320, padX=8 → usable=304；块0 [8,160] 宽 152
    tl.canvas.dispatchEvent(mouse("mousedown", 40)); // 块0 内按下，抓取偏移 40-8=32
    window.dispatchEvent(mouse("mousemove", 70));    // 光标右移 30px（仍在块0 槽内，顺序不变）

    const L = tl._layout();
    assert.equal(tl._drag.grabOff, 32);
    assert.equal(tl._drag.w, 152);
    assert.deepEqual(tl._drag.order, [0, 1], "同槽内小幅拖动不改顺序");
    assert.equal(tl._ghostX(tl._drag, L), 38, "幽灵块左缘跟随光标右移 30px（8→38）");
    // 松手前后的落位槽虚框位置由 _layout(order) 决定
    assert.ok(Math.abs(tl._layout(undefined, tl._drag.order).blocks[0].x - 8) < 1e-6);

    window.dispatchEvent(mouse("mouseup", 70));
    assert.deepEqual(calls.reorder, [[0, 1]]);
    tl.destroy();
});

test("重排拖动：拖出内容区时幽灵块夹在边界内", async () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);

    tl.canvas.dispatchEvent(mouse("mousedown", 40));
    window.dispatchEvent(mouse("mousemove", 1000)); // 远超右边界
    const L = tl._layout();
    assert.equal(tl._ghostX(tl._drag, L), L.padX + L.usable - tl._drag.w, "右边界夹紧");
    window.dispatchEvent(mouse("mouseup", 1000));

    tl.canvas.dispatchEvent(mouse("mousedown", 300)); // 块1 右缘附近按下
    window.dispatchEvent(mouse("mousemove", -500));   // 远超左边界
    assert.equal(tl._ghostX(tl._drag, tl._layout()), 8, "左边界夹紧到 padX");
    window.dispatchEvent(mouse("mouseup", -500));
    tl.destroy();
});

test("readOnly：点击只选中，不进入拖拽", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }], { readOnly: true });
    await sleep(40);

    tl.canvas.dispatchEvent(mouse("mousedown", 200)); // 块1
    window.dispatchEvent(mouse("mousemove", 60));
    window.dispatchEvent(mouse("mouseup", 60));

    assert.deepEqual(calls.select, [1]);
    assert.equal(calls.reorder.length, 0);
    tl.destroy();
});

test("destroy 移除 canvas 并停止监听", async () => {
    resetEnv();
    const { tl, container } = makeTimeline([{ duration: 5 }]);
    await sleep(40);
    tl.destroy();
    assert.equal(container.querySelector("canvas"), null);
});

test("段色相一律按位置着色（节点与编辑器同一配色，不随身份/重排变化）", async () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5, id: "a" }, { duration: 5, id: "b" }]);
    await sleep(40);
    assert.equal(tl._segHue(0), (0 * 47 + 180) % 360);   // 位置 0 → 青绿起点（与 id 无关）
    assert.equal(tl._segHue(1), (1 * 47 + 180) % 360);   // 位置 1
    assert.equal(tl._segHue(2), (2 * 47 + 180) % 360);   // 位置 2
    tl.destroy();
});

test("拖块右缘调时长：吸附 0.5s，松手提交 onResize", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);

    // W=320, padX=8, usable=304, total=10 → pps=30.4；块0 [8,160]，右缘热区 x∈[153,162]
    tl.canvas.dispatchEvent(mouse("mousedown", 158)); // 按下块0 右缘 → resize 模式
    window.dispatchEvent(mouse("mousemove", 200));    // (200-8)/30.4≈6.32 → 吸附 6.5
    window.dispatchEvent(mouse("mouseup", 200));

    assert.equal(calls.reorder.length, 0);
    assert.deepEqual(calls.resize, [[0, 6.5]]);
    tl.destroy();
});

test("悬停块：高亮索引更新；右缘热区光标 ew-resize；mouseleave 清除", async () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);

    tl.canvas.dispatchEvent(mouse("mousemove", 100)); // 块0 中部
    assert.equal(tl._hover, 0);
    assert.equal(tl.canvas.style.cursor, "pointer");

    tl.canvas.dispatchEvent(mouse("mousemove", 158)); // 块0 右缘热区
    assert.equal(tl._hover, 0);
    assert.equal(tl.canvas.style.cursor, "ew-resize");

    tl.canvas.dispatchEvent(mouse("mouseleave"));
    assert.equal(tl._hover, null);
    tl.destroy();
});

test("readOnly：右缘热区不进入调时长，点击只选中", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }], { readOnly: true });
    await sleep(40);

    tl.canvas.dispatchEvent(mouse("mousedown", 158)); // 块0 右缘位置
    window.dispatchEvent(mouse("mousemove", 250));
    window.dispatchEvent(mouse("mouseup", 250));

    assert.deepEqual(calls.select, [0]);
    assert.equal(calls.resize.length, 0);
    tl.destroy();
});

test("素材拖到段块上：dragover 记录落点，drop 分发 onDropImage(index, dataTransfer)", async () => {
    resetEnv();
    const drops = [];
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? "{\"filename\":\"a.png\",\"subfolder\":\"\"}" : "") };
    const { tl } = makeTimeline([{ duration: 5 }, { duration: 5 }], { onDropImage: (i, d) => drops.push([i, d]) });
    await sleep(40);

    const dragEvent = (type, x) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clientX", { value: x, configurable: true });
        if (type === "drop" || type === "dragover") Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
        return ev;
    };
    tl.canvas.dispatchEvent(dragEvent("dragover", 100)); // 块0
    assert.equal(tl._dropOver, 0);
    tl.canvas.dispatchEvent(dragEvent("drop", 236)); // 块1
    assert.equal(drops.length, 1);
    assert.deepEqual(drops[0][0], 1);
    assert.equal(drops[0][1].getData("application/x-neo-gallery"), "{\"filename\":\"a.png\",\"subfolder\":\"\"}");
    assert.equal(tl._dropOver, -1, "drop 后清空落点");
    tl.destroy();
});

test("素材拖出（dragleave）清除落点；readOnly 不响应 drop", async () => {
    resetEnv();
    const drops = [];
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? "{\"filename\":\"a.png\"}" : "") };

    const dragEvent = (type, x) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clientX", { value: x, configurable: true });
        if (type === "drop" || type === "dragover") Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
        return ev;
    };
    const { tl } = makeTimeline([{ duration: 5 }, { duration: 5 }], { onDropImage: (i, d) => drops.push([i, d]) });
    await sleep(40);
    tl.canvas.dispatchEvent(dragEvent("dragover", 100));
    assert.equal(tl._dropOver, 0);
    tl.canvas.dispatchEvent(dragEvent("dragleave", 100));
    assert.equal(tl._dropOver, -1, "dragleave 清除落点");
    tl.destroy();

    const { tl: tlRo } = makeTimeline([{ duration: 5 }, { duration: 5 }], { readOnly: true, onDropImage: (i, d) => drops.push([i, d]) });
    await sleep(40);
    tlRo.canvas.dispatchEvent(dragEvent("dragover", 236));
    assert.equal(tlRo._dropOver, -1, "readOnly：dragover 不设置落点");
    tlRo.canvas.dispatchEvent(dragEvent("drop", 236));
    assert.equal(drops.length, 0, "readOnly：drop 不回调");
    tlRo.destroy();
});

test("尾部 ＋ 按钮：提供 onAdd 且非只读时占位并响应点击；readOnly/未提供时不显示", async () => {
    resetEnv();
    const adds = [];
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }], { onAdd: () => adds.push(1) });
    await sleep(40);

    // W=320，onAdd 预留 32px：usable=272 → 块 [8,144]/[144,280]；「＋」x∈[288,312]、y∈[16,40]（height=40）
    const chip = tl._addChipRect();
    assert.ok(chip, "非只读 + onAdd：按钮位置存在");
    const L = tl._layout();
    const last = L.blocks[L.blocks.length - 1];
    assert.equal(last.x + last.w, 280, "块布局为 ＋ 预留尾部空间");

    const click = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    tl.canvas.dispatchEvent(click("mousedown", 300, 28));
    assert.equal(adds.length, 1, "点击 ＋ 触发 onAdd");
    assert.equal(calls.select.length, 0, "点击 ＋ 不选中块");
    tl.destroy();

    // readOnly：即使提供 onAdd 也不显示按钮，点击该位置只选中块
    const addsRo = [];
    const { tl: tlRo, calls: callsRo } = makeTimeline([{ duration: 5 }, { duration: 5 }], { readOnly: true, onAdd: () => addsRo.push(1) });
    await sleep(40);
    assert.equal(tlRo._addChipRect(), null, "readOnly：不显示 ＋");
    tlRo.canvas.dispatchEvent(click("mousedown", 300, 50)); // 块1 [160,312]（无预留）内
    window.dispatchEvent(click("mouseup", 300, 50));
    assert.equal(addsRo.length, 0);
    assert.deepEqual(callsRo.select, [1], "该位置按普通块点击处理");
    tlRo.destroy();

    // 未提供 onAdd：无按钮，布局不预留
    const { tl: tlNo } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);
    assert.equal(tlNo._addChipRect(), null, "未提供 onAdd：不显示 ＋");
    const LNo = tlNo._layout();
    const lastNo = LNo.blocks[LNo.blocks.length - 1];
    assert.equal(lastNo.x + lastNo.w, 312, "布局不预留尾部空间");
    tlNo.destroy();
});

test("setZoom/getZoom：放大/缩小 → canvas 按像素宽；缩回铺满；越界钳制", async () => {
    resetEnv();
    const { tl, container } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);

    // 组件不再内置控制条（UI 由宿主建）；canvas 位于横向滚动容器内
    assert.equal(container.querySelector(".neo-dtl-zoombar"), null, "无内置放大控制条");
    assert.equal(tl.scroll.parentNode, container, "canvas 位于横向滚动容器内");

    // 初始 zoom=1：内容宽度 = 可视宽（320），canvas 铺满
    assert.equal(tl.getZoom(), 1);
    assert.equal(tl._width(), 320, "zoom=1 内容宽度=可视宽");
    assert.equal(tl.canvas.style.width, "100%", "zoom=1 canvas 铺满");

    // 拉伸到 2x：内容宽度 = 640，canvas 按像素宽（横向滚动）
    tl.setZoom(2);
    await sleep(40);
    assert.equal(tl.getZoom(), 2, "getZoom 同步");
    assert.equal(tl._width(), 640, "zoom=2 内容宽度=可视宽×2");
    assert.equal(tl.canvas.style.width, "640px", "zoom>1 canvas 按像素宽");

    // 缩回铺满（zoom→1）：内容回到可视宽，滚动归零
    tl.setZoom(1);
    await sleep(40);
    assert.equal(tl.getZoom(), 1, "缩回铺满");
    assert.equal(tl._width(), 320, "缩回后内容宽度=可视宽");
    assert.equal(tl.canvas.style.width, "100%", "缩回后 canvas 铺满");

    // 缩小（zoom<1）：[5,5] natural=320=可视宽，缩到 0.5 → 内容不窄于可视宽，仍铺满（不拉伸失真）
    tl.setZoom(0.5);
    await sleep(40);
    assert.equal(tl.getZoom(), 0.5, "getZoom 同步（缩小）");
    assert.equal(tl._width(), 320, "内容不窄于可视宽 → 铺满");
    assert.equal(tl.canvas.style.width, "100%", "缩到小于可视宽时仍铺满（不拉伸）");

    // 多段溢出时缩小：内容从默认总宽收窄，但不小于可视宽（横向滚动范围减小）
    const { tl: tlMany } = makeTimeline(Array.from({ length: 10 }, () => ({ duration: 1 })), { height: 184 });
    await sleep(40);
    const manyDefaultW = tlMany._width();
    assert.ok(manyDefaultW > 320, "默认总宽溢出可视区");
    tlMany.setZoom(0.5);
    await sleep(40);
    assert.equal(tlMany.getZoom(), 0.5);
    assert.ok(tlMany._width() < manyDefaultW && tlMany._width() >= 320, "缩小后内容变窄但不小于可视宽");
    tlMany.destroy();

    // setZoom 越界钳制到 [DT_MIN_ZOOM, DT_MAX_ZOOM] = [0.25, 4]
    tl.setZoom(99);
    await sleep(40);
    assert.equal(tl.getZoom(), 4, "超过上限钳制到最大倍数 4");
    tl.setZoom(0);
    await sleep(40);
    assert.equal(tl.getZoom(), 0.25, "低于下限钳制到 0.25");

    tl.destroy();
});

test("默认拉伸=1：_width 恒等于可视宽、canvas 铺满", async () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);
    assert.equal(tl.getZoom(), 1);
    assert.equal(tl._width(), 320);
    assert.equal(tl.canvas.style.width, "100%");
    tl.destroy();
});

test("拉伸时滚轮驱动横向滚动 + 显示可见滚动条类；未拉伸不响应", async () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);

    const wheel = (deltaY) => {
        const ev = new window.WheelEvent("wheel", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "deltaX", { value: 0, configurable: true });
        Object.defineProperty(ev, "deltaY", { value: deltaY, configurable: true });
        return ev;
    };

    // 初始未拉伸：无 zoomed 类，滚轮不横向滚动
    assert.ok(!tl.scroll.classList.contains("neo-dtl-zoomed"), "zoom=1 无 zoomed 类");
    tl.scroll.dispatchEvent(wheel(120));
    assert.equal(tl.scroll.scrollLeft, 0, "未拉伸：滚轮不横向滚动");

    // 拉伸后：出现 zoomed 类（可见滚动条），竖直滚轮 deltaY → scrollLeft
    tl.setZoom(3);
    await sleep(40);
    assert.ok(tl.scroll.classList.contains("neo-dtl-zoomed"), "zoom>1 显示可见滚动条");
    tl.scroll.dispatchEvent(wheel(120));
    assert.equal(tl.scroll.scrollLeft, 120, "拉伸：滚轮 deltaY → scrollLeft");
    tl.scroll.dispatchEvent(wheel(-40));
    assert.equal(tl.scroll.scrollLeft, 80, "反向滚动累加");

    // 缩回铺满：zoomed 类移除
    tl.setZoom(1);
    await sleep(40);
    assert.ok(!tl.scroll.classList.contains("neo-dtl-zoomed"), "缩回后移除 zoomed 类");

    tl.destroy();
});

test("默认总宽 = 段数×(块净高×16/9)：超可视区横滚、窄则铺满；段内按时长比例分配", async () => {
    resetEnv();
    // 用编辑器同款高度 184（块净高=184-28=156）→ 每段默认宽 ≈277px；10 段总宽 = 10×277 + padding(16) ≈ 2790 > 可视宽(320) → 横滚
    const segs = Array.from({ length: 10 }, () => ({ duration: 1 }));
    const { tl } = makeTimeline(segs, { height: 184 });
    await sleep(40);

    const frameW = (tl.opts.height - 28) * 16 / 9; // 每段默认宽 = 块净高 × 16/9（height=184 → ≈277px）
    assert.ok(tl._width() > 320, "内容宽度超出可视区");
    assert.equal(tl._width(), Math.ceil(10 * frameW + 16), "默认总宽 = 段数×默认宽 + padding");
    const blocks = tl._layout().blocks;
    assert.equal(blocks.length, 10);
    for (const b of blocks) assert.ok(Math.abs(b.w - frameW) < 1, "时长相等时每块≈默认帧宽（比例分配，非下限）");
    assert.equal(tl.canvas.style.width, tl._width() + "px", "溢出时 canvas 按像素宽");
    assert.ok(tl.scroll.classList.contains("neo-dtl-zoomed"), "溢出显示可见滚动条");
    tl.destroy();

    // 段少且默认总宽 < 可视区：拉伸铺满可视区
    const { tl: tl2 } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);
    assert.equal(tl2._width(), 320, "默认总宽不足时铺满可视区");
    assert.equal(tl2.canvas.style.width, "100%", "铺满可视区");
    tl2.destroy();

    // 时长不等：段内按 dur 比例分配相对宽（长段更宽）
    const { tl: tl3 } = makeTimeline([{ duration: 1 }, { duration: 3 }]);
    await sleep(40);
    const b3 = tl3._layout().blocks;
    assert.ok(b3[1].w > b3[0].w, "长段更宽（按时长比例）");
    assert.ok(Math.abs(b3[1].w / b3[0].w - 3) < 0.5, "宽度比≈时长比 3:1");
    tl3.destroy();
});

test("_fitLines：中间行取满不加省略号，仅最后一行超出时加省略号", () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }]);
    tl.ctx.measureText = (t) => ({ width: String(t).length * 10 }); // 每字符 10px，maxW=40 → 中间行满 4 字 / 末行 3 字+…
    assert.deepEqual(tl._fitLines(tl.ctx, "abcdefghij", 40, 2), ["abcd", "efg…"], "超两行：首行取满无省略号、仅末行加省略号");
    assert.deepEqual(tl._fitLines(tl.ctx, "abcdef", 40, 2), ["abcd", "ef"], "两行放得下：均无省略号");
    assert.deepEqual(tl._fitLines(tl.ctx, "ab", 40, 2), ["ab"], "单行放得下：只一行无省略号");
    tl.destroy();
});

test("_promptSummary：去掉 H3 固定字段标签，只留画面描述正文并压成单行", () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }]);

    // 基础模式：integrated_multimodal_description / overall_soundscape / non_diegetic_music
    const base = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] Live-action cinematic night fantasy, a woman rises into a midnight sky.\n\noverall_soundscape: Strong high-altitude wind surrounds her.\n\nnon_diegetic_music: N/A";
    assert.equal(tl._promptSummary(base), "[Shot 1] Live-action cinematic night fantasy, a woman rises into a midnight sky.", "基础模式只取 integrated_multimodal_description 正文，去掉标签与前导/尾部字段");

    // Ref2VA 模式：detailed_description 作为画面描述段
    const ref = "subject_definitions: ...\nsummary: [reference generation] x\nretention_analysis: y\ndetailed_description: [Shot 1] A hero leaps through mid-air.\noverall_soundscape: wind rush.\nnon_diegetic_music: orchestral.";
    assert.equal(tl._promptSummary(ref), "[Shot 1] A hero leaps through mid-air.", "Ref2VA 模式取 detailed_description 正文");

    // 非结构化提示词：原样压缩空白
    assert.equal(tl._promptSummary("a  \n\nb\tc"), "a b c", "无字段标签时仅压缩空白");
    assert.equal(tl._promptSummary(""), "", "空提示词返回空串");

    tl.destroy();
});

// 记录路径与填充：canvas 无后端，进度条是「圆角路径 + fill」，需回读坐标断言画在哪
function recordingCtx() {
    const paths = [];
    let cur = null;
    const rec = {
        _paths: paths,
        font: "", fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, textAlign: "left", textBaseline: "top",
        measureText: () => ({ width: 0 }),
        canvas: null,
        beginPath() { cur = { moveTo: null, arcs: [], fill: null }; paths.push(cur); },
        moveTo(x, y) { if (cur) cur.moveTo = [x, y]; },
        arcTo(x1, y1, x2, y2, r) { if (cur) cur.arcs.push([x1, y1, x2, y2, r]); },
        closePath() {},
        fill() { if (cur) cur.fill = this.fillStyle; },
        stroke() {}, fillText() {}, strokeText() {}, fillRect() {},
        save() {}, restore() {}, clip() {}, setLineDash() {}, drawImage() {},
        setTransform() {}, clearRect() {},
    };
    return rec;
}

const BLOCK_TOP = 18 + 4; // DT_RULER_H + DT_TOP_GAP，与 _draw 一致
const RULER_H = 18;       // DT_RULER_H

// _rr 走圆角路径：moveTo 从 x+r 起步，arcTo[0] 是右缘 x+w，半径在 arcTo[4] → 反推填充宽度
const rrWidth = (p) => p.arcs[0][0] - (p.moveTo[0] - p.arcs[0][4]);

test("生成进度条画在刻度尺上（块内不再画顶部细条）", async () => {
    resetEnv();
    const { tl } = makeTimeline([
        { duration: 5, prompt: "a" },
        { duration: 5, prompt: "b" },
        { duration: 5, prompt: "c" },
    ]);
    await sleep(40); // rAF 后 _segs 就绪
    tl._progress = { active: true, segment_index: 1, total_segments: 3, step: 2, total_steps: 8 };

    const ctx = recordingCtx();
    const L = tl._layout();
    tl._drawRulerProgress(ctx, L);

    const green = ctx._paths.filter((p) => p.fill === "#3fb950");
    const amber = ctx._paths.filter((p) => p.fill === "#e6a23c");
    assert.equal(green.length, 1, "已完成段画绿色满条");
    assert.equal(amber.length, 1, "当前段画琥珀色进度条");
    const fullW = Math.max(4, L.blocks[1].w - 4);
    assert.equal(green[0].moveTo[0] - green[0].arcs[0][4], L.blocks[0].x + 2, "按段左缘对齐");
    assert.equal(rrWidth(green[0]), fullW, "已完成段满条");
    assert.equal(amber[0].moveTo[1], RULER_H - 5 - 1, "进度条贴在刻度尺底沿上方");
    assert.ok(Math.abs(rrWidth(amber[0]) - fullW * 0.25) < 0.01, "当前段按 step/total_steps 比例增长");

    // 块内不再画进度条（旧位置在块顶部，已被横向滚动条占用）
    const segCtx = recordingCtx();
    tl._paintSeg(segCtx, 8, 200, BLOCK_TOP, 60, { duration: 5, prompt: "" }, "1", 0, false, false, false);
    const inBlock = segCtx._paths.filter((p) => p.fill === "#e6a23c" || p.fill === "#3fb950");
    assert.equal(inBlock.length, 0, "块内不画进度条");
    tl.destroy();
});

// 分段块底色只做“哪一段”的身份提示，不能压过块内的首帧缩略图与提示词摘要
test("分段块是淡身份底：静止最淡、选中加深、拖动中的幽灵最实", async () => {
    resetEnv();
    const { tl } = makeTimeline([{ duration: 5 }]);
    await sleep(40);
    const blockFill = (sel, ghost) => {
        const ctx = recordingCtx();
        tl._paintSeg(ctx, 8, 200, BLOCK_TOP, 60, { duration: 5, prompt: "" }, "1", 180, ghost, sel, false, -1);
        const m = /hsla\((\d+),(\d+)%,(\d+)%,([\d.]+)\)/.exec(ctx._paths[0].fill);   // 第一笔填充即块底色
        assert.ok(m, "块底色必须是 hsla 串，实得：" + ctx._paths[0].fill);
        return { hue: +m[1], sat: +m[2], light: +m[3], alpha: +m[4] };
    };
    const rest = blockFill(false, false), sel = blockFill(true, false), ghost = blockFill(false, true);
    assert.equal(rest.hue, 180, "填充不改色相，段色相仍由 _segHue 按位置给");
    assert.ok(rest.sat <= 35, "饱和度压到 35% 以下，静止块才是淡底：" + rest.sat + "%");
    assert.ok(rest.alpha <= 0.25, "静止 alpha 不超过 0.25：" + rest.alpha);
    assert.ok(sel.alpha > rest.alpha && ghost.alpha > sel.alpha, "静止淡、选中加深、幽灵最实：" + [rest, sel, ghost].map((c) => c.alpha).join(" < "));
    assert.ok(sel.light > rest.light && sel.light <= 60, "选中靠亮度小抬区分，不跳成亮色块：" + rest.light + "% → " + sel.light + "%");
    tl.destroy();
});

test("revealSeg：内容溢出时把目标段滚进可视区，已可见则不动，未溢出不滚动", async () => {
    resetEnv();
    // 10 段 × 5s、编辑面板尺寸（height=184 → 每段默认宽≈277px）：默认总宽超出可视区 320
    const { tl } = makeTimeline(Array.from({ length: 10 }, () => ({ duration: 5 })), { height: 184 });
    await sleep(40);
    const view = tl._visibleWidth();
    assert.ok(tl._width() > view, "内容宽于可视区");
    assert.equal(tl.scroll.scrollLeft, 0);

    tl.revealSeg(9);
    const b = tl._layout().blocks[9];
    assert.ok(tl.scroll.scrollLeft > 0, "末段在可视区外 → 滚动");
    assert.ok(b.x >= tl.scroll.scrollLeft, "末段左缘进入可视区");
    assert.ok(b.x + b.w <= tl.scroll.scrollLeft + view, "末段右缘进入可视区");

    const settled = tl.scroll.scrollLeft;
    tl.revealSeg(9);
    assert.equal(tl.scroll.scrollLeft, settled, "已可见的段不再滚动");

    tl.revealSeg(0);
    assert.equal(tl.scroll.scrollLeft, 0, "回到首段滚回最左");
    tl.destroy();

    // 段少（默认总宽 < 可视区）：无需滚动
    const { tl: tl2 } = makeTimeline([{ duration: 5 }, { duration: 5 }]);
    await sleep(40);
    assert.ok(tl2._width() <= tl2._visibleWidth(), "内容未溢出");
    tl2.revealSeg(1);
    assert.equal(tl2.scroll.scrollLeft, 0, "未溢出时不滚动");
    tl2.destroy();
});


// ---- 「仅运行勾选的段」（checkable）：点段块左上角勾选框切换、不触发选中；数据变短时丢弃越界勾选 ----

// 勾选框中心：块 x + 5(偏移) + 6(半宽) / 刻度尺 18 + 间距 4 + 偏移 4 + 半高 6
const CHK_OFF_X = 11;
const CHK_Y = 32;
const mouseAt = (type, x, y) => new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });

test("checkable：点勾选框切换该段并回报宿主（不触发 onSelect）", async () => {
    resetEnv();
    const seen = [];
    const { tl, calls } = makeTimeline([{ duration: 5 }, { duration: 5 }],
        { checkable: true, onCheckChange: (list) => seen.push(list) });
    await sleep(40);
    const tap = (x) => {
        tl.canvas.dispatchEvent(mouseAt("mousedown", x, CHK_Y));
        tl.canvas.dispatchEvent(mouseAt("mouseup", x, CHK_Y));
    };

    tap(8 + CHK_OFF_X);                 // 第 1 块勾选框
    assert.deepEqual(tl.getChecked(), [0]);
    assert.deepEqual(seen, [[0]], "变化时把勾选列表回报宿主");
    assert.deepEqual(calls.select, [], "点勾选框不触发选中（不会打开编辑器）");

    tap(160 + CHK_OFF_X);               // 第 2 块勾选框
    assert.deepEqual(tl.getChecked(), [0, 1], "多段累积勾选");

    tap(8 + CHK_OFF_X);                 // 再点一次 = 取消
    assert.deepEqual(tl.getChecked(), [1]);

    tap(60);                            // 块内其它位置仍是选中
    assert.deepEqual(calls.select, [0]);
    assert.deepEqual(tl.getChecked(), [1], "普通点击不动勾选");

    tl.clearChecked();
    assert.deepEqual(tl.getChecked(), []);
    assert.deepEqual(seen[seen.length - 1], [], "清空后回报宿主");
    tl.destroy();
});

test("checkable：非 checkable 时间轴不画勾选框（点块只选中）", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }]);
    await sleep(40);
    tl.canvas.dispatchEvent(mouseAt("mousedown", 8 + CHK_OFF_X, CHK_Y));
    tl.canvas.dispatchEvent(mouseAt("mouseup", 8 + CHK_OFF_X, CHK_Y));
    assert.deepEqual(tl.getChecked(), [], "未开 checkable 时不产生勾选");
    assert.deepEqual(calls.select, [0]);
    tl.destroy();
});

test("checkable：勾选框只在悬停 / 已勾选时出现，命中区比视觉框大一圈", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }], { checkable: true });
    await sleep(40);
    assert.equal(tl._checkVisible(0, false), false, "未悬停不画勾选框");
    tl._hover = 0;
    assert.equal(tl._checkVisible(0, false), true, "悬停该块时才出现");
    tl._hover = null;
    assert.equal(tl._checkVisible(0, true), true, "已勾选的常显（一眼看到会跑哪些段）");

    const tap = (x, y) => {
        tl.canvas.dispatchEvent(mouseAt("mousedown", x, y));
        tl.canvas.dispatchEvent(mouseAt("mouseup", x, y));
    };
    // 视觉框 = (13..26, 26..39)：点框左侧 5px（命中区外扩 7px 内）→ 仍按勾选处理，不落到「点块选中」
    tap(13 - 5, 28);
    assert.deepEqual(tl.getChecked(), [0]);
    assert.deepEqual(calls.select, [], "命中区内不触发选中");
    // 块中部（远离勾选框命中区）→ 仍是选中
    tap(120, 60);
    assert.deepEqual(calls.select, [0]);
    tl.destroy();
});

test("checkable：节点被画布缩放时坐标归一，点勾选仍命中（不会误开编辑器）", async () => {
    resetEnv();
    const { tl, calls } = makeTimeline([{ duration: 5 }], { checkable: true });
    await sleep(40);
    // 画布局部宽 320，但屏幕宽只有 160（节点 zoom 0.5）→ 事件坐标要 ×2 才能回到本地像素
    Object.defineProperty(tl.canvas, "clientWidth", { value: 320, configurable: true });
    tl.canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 160, bottom: 46, width: 160, height: 46 };
    assert.deepEqual(tl._localPoint({ clientX: 13, clientY: 16 }), { x: 26, y: 32 });

    tl.canvas.dispatchEvent(mouseAt("mousedown", 13, 16));   // 屏幕上勾选框中心 ≈ (13,16)
    tl.canvas.dispatchEvent(mouseAt("mouseup", 13, 16));
    assert.deepEqual(tl.getChecked(), [0], "缩放下也能点中勾选框");
    assert.deepEqual(calls.select, [], "不落到「点块选中（打开编辑器）」分支");
    tl.destroy();
});

test("checkable：分段变少（换配方/删段）时丢弃越界勾选并回报宿主", async () => {
    resetEnv();
    const seen = [];
    const segs = [{ duration: 5 }, { duration: 5 }];
    const { tl } = makeTimeline(segs, { checkable: true, onCheckChange: (list) => seen.push(list) });
    await sleep(40);
    tl._toggleChecked(0);
    tl._toggleChecked(1);
    assert.deepEqual(tl.getChecked(), [0, 1]);

    segs.pop();       // 只剩 1 段
    tl.refresh();
    await sleep(40);
    assert.deepEqual(tl.getChecked(), [0], "越界勾选被丢弃");
    assert.deepEqual(seen[seen.length - 1], [0], "丢弃后回报宿主（提示行同步）");
    tl.destroy();
});

