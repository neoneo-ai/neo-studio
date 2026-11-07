// 机位模块（angle/angle-orb.js）：档位吸附、-180..180 换算、读数与触发词、拖拽夹紧与键盘步进。
// 画布几何不进 jsdom（getContext 桩成 null，draw 直接返回），这里只测纯函数与控件状态机。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv } from "./setup.mjs";
import {
    snapToNearest, rotationToDisplay, displayToRotation, angleLabel, anglePrompt, createAngleOrb,
    ROTATION_VALUES, TILT_VALUES, ZOOM_VALUES, DEFAULT_ANGLE,
} from "../../web/angle/angle-orb.js";

const TPL = "Move the camera of <image1> to [front view], [eye-level shot], [medium shot] relative to the main subject, keeping unchanged";

const noCtx = () => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { value: () => null, configurable: true });
};

test("机位档位：连续角吸附到离散档位", () => {
    assert.equal(snapToNearest(91, ROTATION_VALUES), 90);
    assert.equal(snapToNearest(20, ROTATION_VALUES), 0);
    assert.equal(snapToNearest(350, ROTATION_VALUES), 0);      // 越界绕回正面：350 距 0 只差 10
    assert.equal(snapToNearest(52, ROTATION_VALUES), 45);
    assert.equal(snapToNearest(8, ZOOM_VALUES), 10);      // 档位环上的真实最近点：8 距 10 只差 2
    assert.equal(snapToNearest(NaN, TILT_VALUES), -30);        // 读不出数落第一档，不把 NaN 喂给滑杆
});

test("机位换算：后端 0-315 ↔ 界面 -180..180，读数带档位名", () => {
    assert.equal(rotationToDisplay(90), 90);
    assert.equal(rotationToDisplay(270), -90);
    assert.equal(rotationToDisplay(180), 180);
    assert.equal(displayToRotation(-90), 270);
    assert.equal(displayToRotation(91), 90);
    assert.equal(angleLabel({ rotation: 90, tilt: 30, zoom: 5 }), "右侧90° · 俯拍30° · 中景");
    assert.equal(angleLabel({ rotation: 270, tilt: -30, zoom: 10 }), "左侧-90° · 仰拍-30° · 特写");
    assert.equal(angleLabel({ rotation: 0, tilt: 0, zoom: 5 }), "正面0° · 平视0° · 中景");
});

test("机位触发词：按当前三档填死模板的方括号，无模板的旧配置在句尾补一段", () => {
    const filled = anglePrompt({ rotation: 90, tilt: 30, zoom: 10 }, TPL);
    assert.match(filled, /right side view/);
    assert.match(filled, /high-angle shot looking down/);
    assert.match(filled, /close-up/);
    assert.ok(!filled.includes("["), "方括号应全部填掉");
    const mid = anglePrompt({ rotation: 180, tilt: 0, zoom: 5 }, TPL);
    assert.match(mid, /back view, eye-level shot, medium shot/);
    const legacy = anglePrompt({ rotation: 0, tilt: 0, zoom: 5 }, "Move the camera of <image1> around the subject");
    assert.match(legacy, /camera: front view, eye-level shot, medium shot/);
    assert.equal(anglePrompt({ rotation: 0, tilt: 0, zoom: 5 }, ""), "Camera: front view, eye-level shot, medium shot.");
});

test("机位球：拖拽实时夹紧俯仰带，松手吸附档位并只回一次变化", () => {
    resetEnv();
    noCtx();
    const changes = [];
    const orb = createAngleOrb({ cfg: { ...DEFAULT_ANGLE }, onChange: (cfg) => changes.push(cfg) });
    const canvas = orb.canvas;
    const pointer = (type, x, y) => canvas.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1 }));

    pointer("pointerdown", 80, 80);
    pointer("pointermove", 180, 80);    // 右拖 100px × 0.8 = +80°
    assert.equal(orb.get().rotation, 80, "拖拽中允许连续角");
    assert.equal(changes.length, 0, "拖拽中不刷提示词，松手才回一次");
    pointer("pointermove", 180, -60);   // 上拖 140px = +112°，夹到高俯上限 60
    assert.equal(orb.get().tilt, 60, "拖拽中俯仰夹在 -30..60 带内");
    pointer("pointerup", 180, -60);
    assert.deepEqual(orb.get(), { rotation: 90, tilt: 60, zoom: 5 }, "松手吸附到档位");
    assert.deepEqual(changes, [{ rotation: 90, tilt: 60, zoom: 5 }], "松手只发一次变化");

    pointer("pointerdown", 80, 80);
    pointer("pointermove", 80, 380);    // 下拖 300px = -240°：一路向下夹到仰拍下限 -30
    assert.equal(orb.get().tilt, -30, "连续下拖夹在 -30，不越到 flux 档之外");
    pointer("pointerup", 80, 380);
    assert.equal(orb.get().tilt, -30);
    assert.equal(orb.readout.textContent, "右侧90° · 仰拍-30° · 中景", "读数随吸附后的档位刷新");
});

test("机位球：方位键按一下走一档，从键上起手拖拽只拖球不步进", () => {
    resetEnv();
    noCtx();
    const changes = [];
    const orb = createAngleOrb({ cfg: { rotation: 0, tilt: 0, zoom: 5 }, onChange: (cfg) => changes.push(cfg) });
    const btn = () => orb.el.querySelector('.neo-angle-arrows button[data-step="tiltUp"]');
    const pointer = (type, x, y, target = btn()) =>
        target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1 }));

    // 不动的点按：pointerdown + pointerup 就结算一档（鼠标的 click 目标会被指针捕获改成 wrap，
    // 所以步进不能挂在 click 上）
    pointer("pointerdown", 80, 20);
    pointer("pointerup", 80, 20);
    assert.equal(orb.get().tilt, 30, "点一下「︿」抬一档到俯拍");
    assert.deepEqual(changes, [{ rotation: 0, tilt: 30, zoom: 5 }], "点按只回一次变化");

    // 1px 抖动仍算点按（不到 3px 的起手阈值）
    changes.length = 0;
    pointer("pointerdown", 80, 20);
    pointer("pointermove", 81, 20);
    pointer("pointerup", 81, 20);
    assert.equal(orb.get().tilt, 60, "抖动 1px 仍算点按，再抬一档到高俯");
    assert.deepEqual(changes, [{ rotation: 0, tilt: 60, zoom: 5 }], "点按不发拖拽那次变化");

    // 从同一个键上起手拖拽：球面跟手，松手吸附，不再多走一档
    changes.length = 0;
    pointer("pointerdown", 80, 20);
    pointer("pointermove", 80, 140);   // 下拖 120px = -96°：从高俯 60 一路夹到仰拍下限 -30
    pointer("pointerup", 80, 140);
    assert.equal(orb.get().tilt, -30, "高俯档相机压在上边中点的键下面，从键上起手也能拖");
    assert.deepEqual(changes, [{ rotation: 0, tilt: -30, zoom: 5 }], "拖拽只回一次变化");

    // 鼠标的 click 不再参与步进（detail 非 0 一律忽略），键盘回车 / 空格那条（detail = 0）照旧
    btn().dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    assert.equal(orb.get().tilt, -30, "鼠标 click 不重复步进");
    btn().dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    assert.equal(orb.get().tilt, 0, "键盘激活的 click 仍走一档");
});

test("机位球：四个方位键与键盘方向键沿档位步进，旋转绕圈、俯仰到端点不动", () => {
    resetEnv();
    noCtx();
    const changes = [];
    const orb = createAngleOrb({ cfg: { ...DEFAULT_ANGLE }, onChange: (cfg) => changes.push(cfg) });
    const arrow = (key) => {
        const btn = orb.el.querySelector(`.neo-angle-arrows button[data-step="${key}"]`);
        // 鼠标点按的真实序列：pointerdown + pointerup（不位移），步进在 pointerup 里结算
        for (const type of ["pointerdown", "pointerup"])
            btn.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 80, clientY: 20, pointerId: 1 }));
    };
    arrow("rotCw");
    assert.equal(orb.get().rotation, 45, "正面转一档到右前");
    arrow("tiltUp");
    assert.equal(orb.get().tilt, 30, "平视点一次上一档到俯拍");
    arrow("tiltUp");
    assert.equal(orb.get().tilt, 60, "再点一次到高俯");
    arrow("tiltUp");
    assert.equal(orb.get().tilt, 60, "高俯是上限，再点不动");
    orb.set({ rotation: 315, tilt: -30, zoom: 0 });
    changes.length = 0;
    arrow("rotCw");
    assert.equal(orb.get().rotation, 0, "左前再转一档绕回正面");
    arrow("tiltDown");
    assert.equal(orb.get().tilt, -30, "仰拍是下限，再点不动");
    orb.canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    assert.equal(orb.get().rotation, 315, "键盘方向键走同一条步进");
    assert.equal(changes.length, 3, "每次步进都刷一次提示词");
});
