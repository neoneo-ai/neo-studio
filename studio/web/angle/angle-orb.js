// angle-orb.js — 机位球：图片编辑面板「机位」模式的控件，独立模块，零依赖。
//
// 形状照 artcraft-research 的 PageAngles/OrbitSphere（React 壳剥掉，画的全是 Canvas2D）：
// 12 个经线圈 + 5 个纬线圈的淡线框球（白 6%、0.7px，整张网随转角自转），
// 机身 / 手柄 / 取景器 / 镜筒是填实暗面加白色边光，镜筒带玻璃圈与白色录制灯点，一条激光从镜口指到球心。
// 拖球 = 绕主体转相机，松手吸附到离散档位；四条边中点上的四个方位键沿档位步进，右三条滑杆同步。
// 几何、吸附、档位名全是纯函数：Canvas 不进 jsdom 测试，测试只吃这些导出。
import { t } from "../js/core/i18n.js";

export const ROTATION_VALUES = [0, 45, 90, 135, 180, 225, 270, 315];   // fal 口径：0=正面 90=右侧 180=背面 270=左侧
export const TILT_VALUES = [-30, 0, 30, 60];                           // 并集：qwen 的 ±30 与 flux 的 0-60
export const ZOOM_VALUES = [0, 5, 10];
export const DEFAULT_ANGLE = { rotation: 0, tilt: 0, zoom: 5 };       // 镜头默认中景：0（远景）会让人以为机位没生效

const DRAG_SENSITIVITY = 0.8;   // 每像素度数，与参考实现同值
const DRAG_SLOP = 3;            // px：总位移不到这个数按点按算，方位键那一下仍走 click
const TILT_DRAG_MIN = -30, TILT_DRAG_MAX = 60;   // 拖拽中允许连续角，实时夹在这条带内（flux 档的硬约束就是 0-60）

const ROTATION_LABELS = { 0: "正面", 45: "右前", 90: "右侧", 135: "右后", 180: "背面", 225: "左后", 270: "左侧", 315: "左前" };
const TILT_LABELS = { "-30": "仰拍", 0: "平视", 30: "俯拍", 60: "高俯" };
const ZOOM_LABELS = { 0: "远景", 5: "中景", 10: "特写" };
const ROTATION_PHRASES = { 0: "front view", 45: "front-right three-quarter view", 90: "right side view", 135: "back-right three-quarter view", 180: "back view", 225: "back-left three-quarter view", 270: "left side view", 315: "front-left three-quarter view" };
const TILT_PHRASES = { "-30": "low-angle shot looking up", 0: "eye-level shot", 30: "high-angle shot looking down", 60: "top-down view" };
const ZOOM_PHRASES = { 0: "wide establishing shot", 5: "medium shot", 10: "close-up" };

/** 连续角吸附到离散档位（拖拽结束时调用）。转角在 0-360 环上取最短路：350 归 0 不归 315。 */
export function snapToNearest(value, allowed) {
    const v = Number(value);
    if (!Number.isFinite(v)) return allowed[0];
    let best = allowed[0], bestDist = Infinity;
    for (const a of allowed) {
        let d = Math.abs(v - a);
        if (allowed === ROTATION_VALUES) d = Math.min(d, 360 - d);   // 档位环是闭合的，跨 0° 那侧也算距离
        if (d < bestDist) { bestDist = d; best = a; }
    }
    return best;
}

/** 后端 0-315 → 界面 -180..180：滑杆上「左侧」是 -90，不是 270。 */
export function rotationToDisplay(rotation) {
    const r = ((Number(rotation) || 0) % 360 + 360) % 360;
    return r > 180 ? r - 360 : r;
}

/** 界面 -180..180 → 后端 0-315，顺手吸附到离散档位。 */
export function displayToRotation(deg) {
    const r = ((Number(deg) || 0) % 360 + 360) % 360;
    return snapToNearest(r, ROTATION_VALUES);
}

export function rotationLabel(rotation) { return t(ROTATION_LABELS[String(rotation)] ?? "正面"); }
export function tiltLabel(tilt) { return t(TILT_LABELS[String(tilt)] ?? "平视"); }
export function zoomLabel(zoom) { return t(ZOOM_LABELS[String(zoom)] ?? "中景"); }

/** 读数：「右侧90° · 俯拍30° · 中景」。 */
export function angleLabel(angle) {
    const r = rotationToDisplay(angle.rotation), t2 = Number(angle.tilt) || 0;
    return `${rotationLabel(angle.rotation)}${r}° · ${tiltLabel(angle.tilt)}${t2}° · ${zoomLabel(angle.zoom)}`;
}

/**
 * 触发词：技能默认提示词里的三个方括号就是「转角 / 俯仰 / 镜头」，按当前档位填死。
 * 空模板直接给一句完整的；老配置那种没有方括号的模板在句尾补一段，不碰用户写的句子。
 */
export function anglePrompt(angle, template) {
    const p = [ROTATION_PHRASES[String(angle.rotation)] ?? ROTATION_PHRASES[0],
        TILT_PHRASES[String(angle.tilt)] ?? TILT_PHRASES[0],
        ZOOM_PHRASES[String(angle.zoom)] ?? ZOOM_PHRASES[5]];
    const tpl = String(template ?? "");
    if (!tpl) return `Camera: ${p.join(", ")}.`;
    let i = 0;
    const filled = tpl.replace(/\[[^\]]*\]/g, () => p[i++] ?? "");
    return i ? filled : `${tpl}, camera: ${p.join(", ")}`;
}
// ---- 几何与绘制（逐段照抄参考实现 OrbitSphere.drawSphere：球半径取 1，透视 6/(6−z)）----
const PERSP = 6.0;                                  // 参考的 perspective：前缘 1.2 倍、后缘 0.86 倍
const MERIDIANS = 12, PARALLELS = 5, SEGMENTS = 40;
const WIRE = "rgba(255, 255, 255, 0.06)";
const WIRE_DRAG = "rgba(255, 255, 255, 0.12)";      // 拖拽时线框提亮（参考的 wireAlpha 就这两档）
// 相机是黑白的：近黑的机身 + 白的边光，只靠明度分层，不抢面板的橙色强调色
const EDGE = "rgba(236, 238, 241, 0.4)";
const EDGE_BRIGHT = "rgba(255, 255, 255, 0.62)";
const BODY_FILL = "rgba(30, 30, 33, 0.94)";
const GRIP_FILL = "rgba(24, 24, 27, 0.92)";
const VF_FILL = "rgba(36, 36, 40, 0.92)";
const LENS_FILL = "rgba(18, 18, 21, 0.96)";
const LCD_FILL = "rgba(10, 10, 12, 0.98)";
const RING_MID = "rgba(255, 255, 255, 0.46)";
const RING_IN = "rgba(255, 255, 255, 0.28)";
const RETICLE = "rgba(255, 255, 255, 0.12)";
const LASER = "rgba(235, 240, 250, 0.72)";

const deg2rad = (d) => (Number(d) || 0) * Math.PI / 180;

/** 机位在球面上的位置（球半径取 1）：y 朝屏幕下，所以俯仰取负（+30 = 相机在上方往下拍）。 */
export function cameraPoint(rotation, tilt) {
    const r = deg2rad(rotation), t = deg2rad(tilt);
    return { x: Math.sin(r) * Math.cos(t), y: -Math.sin(t), z: Math.cos(r) * Math.cos(t) };
}

/**
 * 机身 / 手柄 / 取景器 / 镜筒的全部面（参考的 makeBox + BOX_FACES + addCylinder），世界坐标，未投影。
 * 面绕向沿参考的 BOX_FACES 顺序，绘制层按 (a→b × b→c).y >= 0 剔除其余面：留下的正是凸体对着观众的
 * 那几面 + 对着观众的那半截镜筒（镜筒 20 片侧壁与镜口环同源绕向）。
 * 上轴取「屏幕竖直方向里垂直于镜头朝向」的那一段（对视线做 Gram-Schmidt），单位长。参考的
 * right × 镜头朝向 = 相机点的径向外：平视档整台机身的竖轴全压在视线方向上，投影压成球心上一条
 * 水平线，取景器/镜筒/录制点糊在同一行里；取 Gram-Schmidt 这段，平视看得见整块机身正面、俯拍看得见
 * 顶板，档位、payload、读数都不受影响。
 */
export function cameraFaces(rot, tilt) {
    const c = cameraPoint(rot, tilt);
    const dir = { x: -c.x, y: -c.y, z: -c.z };                                   // 镜头朝向主体
    let rightX = dir.z, rightZ = -dir.x;                                         // 相机右（y 恒为 0）
    const rl = Math.hypot(rightX, rightZ) || 1;
    rightX /= rl; rightZ /= rl;
    const right = { x: rightX, y: 0, z: rightZ };
    // 上轴：u=(0,-1,0) 减掉 u 在相机点上的投影再取负（屏幕上朝上），k = u·相机点，随后归一
    const t = deg2rad(tilt);
    const k = Math.sin(t);
    const gsx = -k * c.x, gsy = -1 - k * c.y, gsz = -k * c.z;
    const gsLen = Math.hypot(gsx, gsy, gsz) || 1;
    const up = { x: gsx / gsLen, y: gsy / gsLen, z: gsz / gsLen };

    const at = (bx, by, bz) => ({
        x: c.x + dir.x * bz + rightX * bx + up.x * by,
        y: c.y + dir.y * bz + up.y * by,
        z: c.z + dir.z * bz + rightZ * bx + up.z * by,
    });
    // 参考 makeBox：基面 4 点 + 沿 dir 推进 hd 的 4 点，机身因此带楔形断面。前三个参数是相对
    // 相机点的局部偏移（bx 沿相机右、by 沿上轴、bz 沿镜头朝向），不是世界坐标——机身基面因此
    // 正好落在相机点处球面的切平面上（相机贴在球面），其余部件都以同一套偏移摆放。
    const box = (bx, by, bz, hw, hh, hd) => [at(bx + hw, by + hh, bz), at(bx - hw, by + hh, bz), at(bx - hw, by - hh, bz), at(bx + hw, by - hh, bz),
        at(bx + hw, by + hh, bz + hd), at(bx - hw, by + hh, bz + hd), at(bx - hw, by - hh, bz + hd), at(bx + hw, by - hh, bz + hd)]
        .map((p) => ({ x: p.x, y: p.y, z: p.z, depth: p.z }));
    const FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [1, 2, 6, 5], [0, 3, 7, 4]];
    const boxFaces = (corners, fill, edge, w, markBack = false, markFront = false, markVf = false, markTop = false) =>
        FACES.map((idx, i) => {
            const pts = idx.map((k) => corners[k]);
            return { pts, fill, edge, w, isBodyBack: markBack && i === 0, isBodyFront: markFront && i === 1,
                isBodyTop: markTop && i === 5, isVf: markVf && i === 0, isLensCap: false,
                avgDepth: pts.reduce((s, p) => s + p.depth, 0) / pts.length };
        });
    const BODY_W = 0.28, BODY_H = 0.19, BODY_D = 0.22, LENS_R = 0.1, LENS_LEN = 0.14;
    const VF_BACK = 0.13, VF_UP = BODY_H + 0.05;                                 // 取景口压在机身「后」上方
    const lensC = at(0, 0, BODY_D);                                              // 镜筒底环中心（机身前断面上）
    // 取景器往机身「后」（背离球心那侧）压 0.13、再抬到机身顶板上方：压在 −0.03 的话取景器的
    // 投影整个糊在机身矩形正中（球上只剩一坨重叠框）；压到 −0.13 它在屏幕上落在机身顶缘上方，
    // 跟真相机的取景口位置一致。
    const vf = box(0, VF_UP, -VF_BACK, 0.09, 0.05, 0.1);
    const grip = box(BODY_W + 0.03, 0, 0, 0.04, BODY_H * 0.85, BODY_D * 0.7);
    const ringPt = (a, len) => ({
        x: lensC.x + rightX * Math.cos(a) * LENS_R + up.x * Math.sin(a) * LENS_R + dir.x * len,
        y: lensC.y + up.y * Math.sin(a) * LENS_R + dir.y * len,
        z: lensC.z + rightZ * Math.cos(a) * LENS_R + up.z * Math.sin(a) * LENS_R + dir.z * len,
        depth: 0,
    });
    const lens = [];
    for (let i = 0; i < 20; i++) {
        const a1 = (i / 20) * Math.PI * 2, a2 = ((i + 1) / 20) * Math.PI * 2;
        const quad = [ringPt(a1, 0), ringPt(a2, 0), ringPt(a2, LENS_LEN), ringPt(a1, LENS_LEN)];
        quad.forEach((p) => { p.depth = p.z; });
        lens.push({ pts: quad, fill: LENS_FILL, edge: EDGE_BRIGHT, w: 0.8, isBodyBack: false, isBodyFront: false, isLensCap: false,
            avgDepth: quad.reduce((s, p) => s + p.depth, 0) / 4 });
    }
    const cap = [];
    for (let i = 0; i < 20; i++) cap.push(ringPt((i / 20) * Math.PI * 2, LENS_LEN));
    cap.forEach((p) => { p.depth = p.z; });
    lens.push({ pts: cap, fill: LENS_FILL, edge: EDGE_BRIGHT, w: 0.8, isBodyBack: false, isBodyFront: false, isLensCap: true,
        avgDepth: cap.reduce((s, p) => s + p.depth, 0) / cap.length });
    const faces = boxFaces(box(0, 0, 0, BODY_W, BODY_H, BODY_D), BODY_FILL, EDGE, 1.0, true, true, false, true)
        .concat(boxFaces(grip, GRIP_FILL, EDGE, 0.7), boxFaces(vf, VF_FILL, EDGE, 0.8, false, false, true), lens);
    return { faces, right, up, lensTip: at(0, 0, BODY_D + LENS_LEN),
        // 录制灯钉在机身顶板（参考的录制点在机身前断面上，而前断面在球近侧永远背对观众，
        // 点子会脱开剪影飘在相机上方）：顶板是凸体最朝上的一面，绘制层按背剔除的结果决定画不画。
        recDot: at(BODY_W * 0.35, BODY_H, 0.05) };
}

/**
 * 机位球控件。cfg = { rotation, tilt, zoom }（后端档位）。
 * 返回 { el, canvas, readout, get, set, setTemplate, prompt } —— 状态属于这块面板这一次调用，
 * 随面板销毁，不落模块级 store。
 */
export function createAngleOrb({ cfg, onChange, size = 160 } = {}) {
    ensureCss();
    const angle = { rotation: Number(cfg?.rotation) || 0, tilt: Number(cfg?.tilt) || 0, zoom: Number(cfg?.zoom) || 0 };
    let dragging = false, lastX = 0, lastY = 0, template = "";
    let dragMoved = false, dragStart = null, pressStep = null;

    const readout = document.createElement("span");
    readout.className = "neo-angle-readout";
    const canvas = document.createElement("canvas");
    canvas.className = "neo-angle-canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "slider");
    canvas.setAttribute("aria-label", t("机位"));
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const arrows = document.createElement("div");
    arrows.className = "neo-angle-arrows";
    for (const [key, glyph, tip] of [
        ["tiltUp", "︿", t("抬高俯仰：向上换一档")],
        ["tiltDown", "﹀", t("压低俯仰：向下换一档")],
        ["rotCw", "›", t("顺时针：向右绕主体转一档")],
        ["rotCcw", "‹", t("逆时针：向左绕主体转一档")],
    ]) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.step = key;
        b.textContent = glyph;
        b.title = tip;
        b.setAttribute("aria-label", tip);
        arrows.appendChild(b);
    }
    const wrap = document.createElement("div");
    wrap.className = "neo-angle-wrap";
    wrap.append(canvas, arrows);
    const el = document.createElement("div");
    el.className = "neo-angle-orb";
    el.append(wrap, readout);

    const emit = () => { if (onChange) onChange({ ...angle }); };
    /** 画一次。jsdom 这类桩后端只给半个 ctx（缺 createRadialGradient），任何缺件都整帧跳过：
     *  控件的滑杆 / 读数 / 指针捕获不靠 Canvas，不许被绘制端拖死。 */
    const paint = () => { try { draw(canvas, angle, dragging); } catch { /* 无 canvas 后端 */ } };

    /** 步进：旋转绕圈循环，俯仰到端点不动（参考实现那四个箭头就是这条规矩）。 */
    function step(kind) {
        const ri = ROTATION_VALUES.indexOf(angle.rotation), ti = TILT_VALUES.indexOf(angle.tilt);
        if (kind === "rotCw") angle.rotation = ROTATION_VALUES[(ri + 1 + ROTATION_VALUES.length) % ROTATION_VALUES.length];
        else if (kind === "rotCcw") angle.rotation = ROTATION_VALUES[(ri - 1 + ROTATION_VALUES.length) % ROTATION_VALUES.length];
        else if (kind === "tiltUp") angle.tilt = TILT_VALUES[Math.min(ti + 1, TILT_VALUES.length - 1)];
        else if (kind === "tiltDown") angle.tilt = TILT_VALUES[Math.max(ti - 1, 0)];
        readout.textContent = angleLabel(angle);
        paint();
        emit();
    }

    arrows.addEventListener("click", (e) => {
        // 鼠标 / 触摸的点按在 pointerup 里结算（指针捕获会把 click 的目标改成 wrap，click 里读不到
        // data-step）；这里只接键盘回车 / 空格，键盘激活的 click 的 detail 是 0。
        if (e.detail) return;
        const kind = e.target?.dataset?.step;
        if (kind) step(kind);
    });
    canvas.addEventListener("keydown", (e) => {
        const kind = { ArrowRight: "rotCw", ArrowLeft: "rotCcw", ArrowUp: "tiltUp", ArrowDown: "tiltDown" }[e.key];
        if (!kind) return;
        e.preventDefault();
        step(kind);
    });

    // 拖拽挂在 wrap 上而不是 canvas：高俯档（俯仰 60）相机正落在上边中点的方位键底下，
    // 挂在 canvas 上时那里按下的是按钮、球拖不动。位移不到 DRAG_SLOP 按点按算，起手在方位键上
    // 就在 pointerup 里结算一档——指针捕获会把 click 的目标改成 wrap，步进不能挂在 click 上。
    wrap.addEventListener("pointerdown", (e) => {
        dragging = true;
        dragMoved = false;
        pressStep = e.target?.dataset?.step ?? null;
        dragStart = { ...angle };
        lastX = e.clientX;
        lastY = e.clientY;
        // 光标跟着指针下的元素走（指针捕获不改它）：整块球（含读数）锁成抓取态，划过方位键 / 读数都不变样
        el.classList.add("dragging");
        wrap.setPointerCapture?.(e.pointerId);
        paint();
        e.preventDefault();
    });
    wrap.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) dragMoved = true;
        angle.rotation = (((angle.rotation + dx * DRAG_SENSITIVITY) % 360) + 360) % 360;
        angle.tilt = Math.min(TILT_DRAG_MAX, Math.max(TILT_DRAG_MIN, angle.tilt - dy * DRAG_SENSITIVITY));
        lastX = e.clientX;
        lastY = e.clientY;
        paint();
    });
    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove("dragging");
        wrap.releasePointerCapture?.(e.pointerId);
        angle.rotation = snapToNearest(angle.rotation, ROTATION_VALUES);
        angle.tilt = snapToNearest(angle.tilt, TILT_VALUES);
        const tap = dragMoved ? null : pressStep;   // 起手按在方位键上又没动：这一下是点按，走一档
        pressStep = null;
        const same = dragStart && dragStart.rotation === angle.rotation && dragStart.tilt === angle.tilt;
        dragStart = null;
        readout.textContent = angleLabel(angle);
        paint();
        if (!same) emit();   // 原地按一下不重复发变化，那一档由 step 发
        if (tap) step(tap);
    };
    wrap.addEventListener("pointerup", endDrag);
    wrap.addEventListener("pointercancel", (e) => { pressStep = null; endDrag(e); });   // 手势被系统收回：不算点按

    readout.textContent = angleLabel(angle);
    paint();

    return {
        el,
        canvas,
        readout,
        get: () => ({ ...angle }),
        set: (cfg2) => {
            angle.rotation = Number(cfg2?.rotation) || 0;
            angle.tilt = Number(cfg2?.tilt) || 0;
            angle.zoom = Number(cfg2?.zoom) || 0;
            readout.textContent = angleLabel(angle);
            paint();
        },
        /** 技能 config.json 的 default_prompt（带方括号的模板）：触发词按它填。 */
        setTemplate: (tpl) => { template = String(tpl || ""); },
        prompt: () => anglePrompt(angle, template),
    };
}

function draw(canvas, cfg, active) {
    const size = parseInt(canvas.style.width, 10) || 160;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(size * dpr);
    if (canvas.width !== bw) { canvas.width = bw; canvas.height = bw; }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;   // jsdom 这类无 canvas 后端：控件照常可用，滑杆与读数不受影响
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2, cy = size / 2, R = size * 0.4;
    const rotRad = deg2rad(cfg.rotation), tiltRad = deg2rad(cfg.tilt);
    const project = (p) => {
        const k = PERSP / (PERSP - p.z);
        return { x: cx + p.x * R * k, y: cy + p.y * R * k };
    };
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // 球外一层极淡的微光（参考从白 2% 起步，面板底色偏蓝，沿用我们的渐变写法）
    const glow = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 1.3);
    glow.addColorStop(0, "rgba(255,255,255,0.02)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    // 线框球：参考就是白 6% / 0.7px 的一层淡线（拖拽提到 12%），12 个经线圈随转角自转 + 5 个纬线圈
    ctx.strokeStyle = active ? WIRE_DRAG : WIRE;
    ctx.lineWidth = 0.7;
    for (let i = 0; i < MERIDIANS; i++) {
        const a = (i * Math.PI) / 6 + rotRad;
        ctx.beginPath();
        for (let s = 0; s <= SEGMENTS; s++) {
            const phi = (s / SEGMENTS) * Math.PI * 2;
            const q = project({ x: Math.cos(a) * Math.sin(phi), y: Math.cos(phi), z: Math.sin(a) * Math.sin(phi) });
            if (s) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
        }
        ctx.stroke();
    }
    for (let i = 1; i <= PARALLELS; i++) {
        const phi = (i * Math.PI) / 6;
        ctx.beginPath();
        for (let s = 0; s <= SEGMENTS; s++) {
            const a = (s / SEGMENTS) * Math.PI * 2 + rotRad;
            const q = project({ x: Math.cos(a) * Math.sin(phi), y: Math.cos(phi), z: Math.sin(a) * Math.sin(phi) });
            if (s) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
        }
        ctx.stroke();
    }

    const cam = cameraFaces(cfg.rotation, cfg.tilt);
    const center = project({ x: 0, y: 0, z: 0 });
    // 瞄准激光：镜筒口到球心，先压在相机面之前画 —— 镜头对着观众时线被镜筒自己盖住，
    // 只留球面那一段；跟在面后面画就会从镜口玻璃正中插出来。
    {
        const tip = project(cam.lensTip);
        ctx.save();
        ctx.strokeStyle = LASER;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = "rgba(235, 240, 250, 0.85)";
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(center.x, center.y);
        ctx.stroke();
        ctx.restore();
    }
    const sorted = cam.faces.slice().sort((a, b) => a.avgDepth - b.avgDepth);
    // 背剔除：凸体的内层面在画家算法下会把边光从半透明填充里透出来，球上就散成一堆平行四边形框；
    // 留下的就是对着观众的那几面（参考 BOX_FACES 的绕向，凸体对着观众的面就是 (a→b × b→c).y >= 0 那批）。
    // 等号要取：正左/正右档位上机身的侧面法向正好垂直视线（= 0），对着观众是一条棱，
    // 严格 > 0 会把整台机身剔干净、球上只剩镜筒。
    const faces = sorted.filter((f) => {
        const [a, b, c] = f.pts;
        const ny = (b.z - a.z) * (c.x - b.x) - (b.x - a.x) * (c.z - b.z);
        return ny >= 0;
    });
    const fillPath = (pts) => {
        ctx.beginPath();
        pts.forEach((p, i) => { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
        ctx.closePath();
    };
    // 镜头前环上的同心玻璃圈（参考在 cap 面上画 0.7 / 0.4 / 0.85 / 0.95 四圈，全在镜口平面上）
    const ringPts = (rScale) => {
        const pts = [];
        for (let i = 0; i < 20; i++) {
            const a = (i / 20) * Math.PI * 2, w = 0.1 * rScale;
            pts.push(project({
                x: cam.lensTip.x + cam.right.x * Math.cos(a) * w + cam.up.x * Math.sin(a) * w,
                y: cam.lensTip.y + cam.up.y * Math.sin(a) * w,
                z: cam.lensTip.z + cam.right.z * Math.cos(a) * w + cam.up.z * Math.sin(a) * w,
            }));
        }
        return pts;
    };

    for (const f of faces) {
        const pts = f.pts.map(project);
        fillPath(pts);
        ctx.fillStyle = f.fill;
        ctx.fill();
        ctx.save();
        ctx.shadowColor = "rgba(255, 255, 255, 0.34)";
        ctx.shadowBlur = 3;
        ctx.strokeStyle = f.edge;
        ctx.lineWidth = f.w;
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = f.edge;
        ctx.lineWidth = f.w * 0.5;
        ctx.stroke();

        // 机身基面板（isBodyBack = 基面那块，相机背着镜头的一面）上的 LCD 内嵌屏
        if (f.isBodyBack) {
            const scx = pts.reduce((s, p) => s + p.x, 0) / 4, scy = pts.reduce((s, p) => s + p.y, 0) / 4;
            const screen = pts.map((p) => ({ x: scx + (p.x - scx) * 0.82, y: scy + (p.y - scy) * 0.75 }));
            fillPath(screen);
            ctx.fillStyle = LCD_FILL;
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        // 镜筒前环：同心玻璃圈（画在 cap 面上，渐变见循环后的镜口一层）
        if (f.isLensCap) {
            ctx.strokeStyle = RING_MID;
            ctx.lineWidth = 1.0;
            fillPath(ringPts(0.7));
            ctx.stroke();
            ctx.strokeStyle = RING_IN;
            ctx.lineWidth = 0.6;
            fillPath(ringPts(0.4));
            ctx.stroke();
            ctx.save();
            ctx.shadowColor = "rgba(255, 255, 255, 0.5)";
            ctx.shadowBlur = 6;
            ctx.strokeStyle = "rgba(255, 255, 255, 0.38)";
            ctx.lineWidth = 1.2;
            fillPath(ringPts(0.95));
            ctx.stroke();
            ctx.restore();
        }
        // 机身顶板（isBodyTop 那面）上的录制灯点（白点，相机整体保持黑白）：顶板在剔除后留在
        // 「对着观众」那一侧才画；顶板侧立时灯点会脱开剪影飘在相机上方。
        if (f.isBodyTop) {
            const dot = project(cam.recDot);
            const rec = ctx.createRadialGradient(dot.x, dot.y, 0, dot.x, dot.y, 5);
            rec.addColorStop(0, "rgba(255, 255, 255, 0.8)");
            rec.addColorStop(0.5, "rgba(255, 255, 255, 0.2)");
            rec.addColorStop(1, "rgba(255, 255, 255, 0)");
            ctx.fillStyle = rec;
            ctx.beginPath();
            ctx.arc(dot.x, dot.y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "rgba(255, 255, 255, 1)";
            ctx.beginPath();
            ctx.arc(dot.x, dot.y, 1.8, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // 镜口玻璃：压在镜头前环上的镜面渐变（面全画完才落，免得被机身填实在自己身上）
    {
        const tip = project(cam.lensTip);
        const glass = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 8);
        glass.addColorStop(0, "rgba(255, 255, 255, 0.34)");
        glass.addColorStop(0.6, "rgba(198, 198, 202, 0.16)");
        glass.addColorStop(1, "rgba(140, 140, 146, 0.05)");
        ctx.fillStyle = glass;
        fillPath(ringPts(0.85));
        ctx.fill();
    }

    // 球心十字：一眼看出「相机正对着主体」
    ctx.lineJoin = "miter";
    ctx.strokeStyle = RETICLE;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(center.x - 5, center.y); ctx.lineTo(center.x + 5, center.y);
    ctx.moveTo(center.x, center.y - 5); ctx.lineTo(center.x, center.y + 5);
    ctx.stroke();
}
// 样式在第一次建控件时注入（幂等）：本模块也会被别的页面 import，放模块顶层就多一次请求
function ensureCss() {
    if (document.getElementById("neo-angle-css")) return;
    const link = document.createElement("link");
    link.id = "neo-angle-css";
    link.rel = "stylesheet";
    link.href = "/extensions/comfyui-neo-studio/angle/angle-orb.css";
    document.head.appendChild(link);
}
