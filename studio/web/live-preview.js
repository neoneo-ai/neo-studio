// 实时预览帧播放器：后端（h3_preview.py）每采样步抽多帧经 rs.h3.preview 推来，
// 组件自动循环播放该步动画，可暂停 / 逐帧 / 逐采样步回看；运行结束由 pause() 定格在最后一帧。
// 宿主无关：NeoH3VideoDirector 节点（director-node.js）包一层节点加高逻辑，
// Neo Studio（studio-app.js）直接挂进结果区。onFrame(data) 可选：每个载荷到达时回调（w/h），宿主据此调尺寸。

import { t, tf } from "./js/core/i18n.js";

const LIVE_CSS_HREF = "/extensions/comfyui-neo-studio/live-preview.css";
const PREVIEW_STEPS = 40; // 保留的采样步数上限，超出丢最旧（每步 PREVIEW_FRAMES 张 JPEG）
const PREVIEW_FPS = 4;    // 载荷未带 fps 时的兜底播放帧率（与后端 PREVIEW_FPS 同值）

// 采样预览要的档（随 /neo_agent/run 的 preview_side 交后端选载荷）：后端每步存两档，
// 智能体页的结果与动画都铺在面板里（1024），要小了铺在面板里是糊的；导演节点那张右栏卡片只有栏子那么宽（384）
export const DOCK_PREVIEW_SIDE = 384;
export const AGENT_PREVIEW_SIDE = 1024;

function ensureCss() {
    if (document.querySelector('link[data-neo-live="1"]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = LIVE_CSS_HREF;
    link.setAttribute("data-neo-live", "1");
    document.head.appendChild(link);
}

export function createFramePlayer(box, onFrame) {
    ensureCss();

    const img = document.createElement("img");
    img.className = "neo-dtl-live-img";
    img.title = t("点击暂停 / 继续");

    const bar = document.createElement("div");
    bar.className = "neo-dtl-live-bar";
    const mkBtn = (cls, text, title) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "neo-dtl-live-btn " + cls;
        btn.textContent = text;
        btn.title = title;
        return btn;
    };
    const playBtn = mkBtn("neo-dtl-live-play", "", t("暂停动画"));
    const framePrev = mkBtn("neo-dtl-live-frame-prev", "⏪", t("上一帧（自动暂停）"));
    const frameLabel = document.createElement("span");
    frameLabel.className = "neo-dtl-live-label";
    const frameNext = mkBtn("neo-dtl-live-frame-next", "⏩", t("下一帧（自动暂停）"));
    const stepPrev = mkBtn("neo-dtl-live-step-prev", "◀", t("上一个采样步"));
    const stepLabel = document.createElement("span");
    stepLabel.className = "neo-dtl-live-label";
    const stepNext = mkBtn("neo-dtl-live-step-next", "▶", t("下一个采样步"));
    bar.append(stepPrev, stepLabel, stepNext, framePrev, frameLabel, frameNext, playBtn);
    box.append(img, bar);

    let steps = [];   // [{frames:[dataURL...], imgs:[Image...]|null, fps}]
    let sel = -1;     // 当前显示的采样步
    let frame = 0;    // 当前帧
    let playing = true;
    let finished = false; // 本次运行是否已结束（结束后停在最后一帧，不再接受迟到载荷）
    let last = 0;     // 上一帧的时间戳（rAF 时钟）
    let raf = 0;

    const current = () => steps[sel] || null;

    function paint() {
        const step = current();
        if (!step) return;
        if (!step.imgs) {
            step.imgs = step.frames.map((url) => { const pre = new Image(); pre.src = url; return pre; });
            for (const s of steps) { if (s !== step) s.imgs = null; }   // 只留当前步的解码图，别屯内存
        }
        img.src = step.frames[frame] || step.frames[0];
        stepLabel.textContent = tf("第 {n}/{total} 步", { n: sel + 1, total: steps.length });
        frameLabel.textContent = tf("{n}/{total} 帧", { n: frame + 1, total: step.frames.length });
    }

    function tick(now) {
        raf = requestAnimationFrame(tick);
        const step = current();
        if (!step || !playing) return;
        if (!last) { last = now; return; }
        if (now - last < 1000 / (step.fps || PREVIEW_FPS)) return;
        last = now;
        frame = (frame + 1) % step.frames.length;
        paint();
    }

    const setPlaying = (on) => {
        playing = on;
        if (on) {
            last = 0;   // 继续播放时不立刻跳帧，从当前帧安稳接着走
            if (!raf && steps.length) raf = requestAnimationFrame(tick); // 没有内容就不空转时钟
        } else if (raf) {
            cancelAnimationFrame(raf);   // 暂停即停掉时钟，画面留在当前帧不再空转
            raf = 0;
        }
        playBtn.textContent = on ? "" : "▶";
        playBtn.title = on ? t("暂停动画") : t("继续动画");
    };

    function apply(data) {
        if (finished) return;   // 本次运行已结束：迟到载荷不得把画面拽走 / 重新自动播放
        if (!Array.isArray(data.frames) || !data.frames.length) return;
        const following = sel < 0 || sel === steps.length - 1;   // 回看旧步时不要被新载荷拽走
        steps.push({ frames: data.frames, imgs: null, fps: Number(data.fps) || PREVIEW_FPS });
        if (steps.length > PREVIEW_STEPS) { steps.shift(); sel -= 1; }
        if (following) { sel = steps.length - 1; frame = 0; }
        else if (sel < 0) sel = 0;
        last = 0;
        box.style.display = "";
        onFrame?.(data);
        paint();
        if (!raf && playing) raf = requestAnimationFrame(tick);
    }

    /** 运行结束：停在最后一帧（面板保留、动画暂停），供逐帧 / 逐采样步回看；下次运行由 reset 清空 */
    function pause() {
        finished = true;
        setPlaying(false);
    }

    function reset() {
        finished = false;
        steps = [];
        sel = -1;
        frame = 0;
        last = 0;
        setPlaying(true);
        img.removeAttribute("src");
        frameLabel.textContent = "";
        stepLabel.textContent = "";
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        box.style.display = "none";
        box.style.height = "0px";
    }

    const shiftStep = (d) => {
        if (!steps.length) return;
        sel = Math.min(steps.length - 1, Math.max(0, sel + d));
        frame = 0;
        last = 0;
        paint();
    };

    const shiftFrame = (d) => {
        const step = current();
        if (!step) return;
        setPlaying(false);   // 逐帧看就是暂停看：停下动画再挪一帧
        frame = (frame + d + step.frames.length) % step.frames.length;
        last = 0;
        paint();
    };

    const onClick = (el, fn) => el.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    onClick(playBtn, () => setPlaying(!playing));
    onClick(img, () => setPlaying(!playing));
    onClick(stepPrev, () => shiftStep(-1));
    onClick(stepNext, () => shiftStep(1));
    onClick(framePrev, () => shiftFrame(-1));
    onClick(frameNext, () => shiftFrame(1));

    reset();
    return { apply, tick, reset, pause };
}