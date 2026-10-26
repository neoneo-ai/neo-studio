/**
 * canvas-lock.js — 主画布离线闸门：ComfyUI 不在跑时锁住画布编辑。
 * 页面是 SPA，进程停了页面还活着，画布照常能拖能改，改完的东西落不到任何执行里。
 * 判据用前端自己的连接事件：socket 断开派发 status(detail=null) + reconnecting，
 * 重连成功派发 reconnected，存活时 status 带数据。WS 抖动不算掉线 —— 锁之前先打一次
 * /system_stats 确认，HTTP 还答话就照常编辑。
 * 锁走前端自带的画布锁（LGraphCanvas.read_only，Comfy.Canvas.Lock 同一份）：平移照常，
 * 节点拖动 / 缩放 / widget 编辑 / 右键加节点全停。解锁还原用户自己的锁状态，不抢用户的锁定。
 */
import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { t } from "./js/core/i18n.js";

const RETRY_MS = 3000;   // 离线期间的复探间隔：reconnected 不来（WS 一直连不上）也要能解锁

let offline = false;
let userLocked = false;   // 进离线前用户自己的锁定状态，解锁时还原
let retryTimer = 0;
let probing = false;

function applyLock(locked) {
    if (app.canvas) app.canvas.read_only = locked ? true : userLocked;
}

function showBanner() {
    if (document.getElementById("neo-canvas-offline")) return;
    const bar = document.createElement("div");
    bar.id = "neo-canvas-offline";
    bar.className = "neo-canvas-offline";
    bar.textContent = t("ComfyUI 未运行 · 画布只读");
    document.body.appendChild(bar);
}

function hideBanner() {
    document.getElementById("neo-canvas-offline")?.remove();
}

function goOffline() {
    if (offline) return;
    offline = true;
    userLocked = !!app.canvas?.read_only;
    applyLock(true);
    showBanner();
    if (!retryTimer) retryTimer = setInterval(probe, RETRY_MS);
}

function goOnline() {
    if (!offline) return;
    offline = false;
    clearInterval(retryTimer);
    retryTimer = 0;
    applyLock(false);
    hideBanner();
}

async function probe() {
    if (probing) return;
    probing = true;
    let alive = false;
    try {
        alive = (await api.fetchApi("/system_stats")).ok;
    } catch {
        alive = false;
    }
    probing = false;
    if (alive) goOnline();
    else goOffline();
}

app.registerExtension({
    name: "comfy.neo.canvasLock",
    setup() {
        api.addEventListener("status", (e) => { if (e?.detail) goOnline(); else probe(); });
        api.addEventListener("reconnecting", probe);
        api.addEventListener("reconnected", goOnline);

        const styleId = "neo-canvas-offline-style";
        if (!document.getElementById(styleId)) {
            const style = document.createElement("style");
            style.id = styleId;
            // 底部居中：顶栏是 ComfyUI 菜单与桌面端返回胶囊，右下角是排队按钮
            style.textContent =
                ".neo-canvas-offline{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);" +
                "z-index:100001;padding:6px 14px;border-radius:999px;background:rgba(38,38,42,.94);" +
                "border:1px solid #4a4a4f;color:#d7dae0;font:12px system-ui;line-height:1;pointer-events:none;}";
            document.head.appendChild(style);
        }
    },
});
