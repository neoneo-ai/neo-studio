/**
 * toast.js — 统一「需用户处理」通知（action toast）。
 * 卡片右侧给处理入口（action 按钮）时不自动关闭：点 action 执行回调后关闭，或 ✕ 手动关闭。
 * 无 action 时：异常级别（error/warning）不自动关闭，正常级别（success/info）超时自动消失。
 * 普通信息类提示仍走 gallery-utils.showToast（ComfyUI 内置 toast，5s 自动消失）。
 * 样式在 prompts.css（#neo-action-toast-stack / .neo-at-*）。
 */

import { t } from "./js/core/i18n.js";

const ICONS = { error: "", warning: "", success: "", info: "" };
// 正常级别（success/info）自动消失时长，与 ComfyUI 内置 toast 一致；异常级别不自动关闭。
const AUTO_DISMISS_MS = 5000;

function ensureStack() {
    let stack = document.getElementById("neo-action-toast-stack");
    if (stack && stack.parentNode) return stack;
    stack = document.createElement("div");
    stack.id = "neo-action-toast-stack";
    document.body.appendChild(stack);
    return stack;
}

/**
 * @param {object} opts - { severity='error', summary, detail='', actionLabel='', onAction=null, onClose=null }
 *   actionLabel 非空时渲染 action 按钮；点击先执行 onAction() 再关闭。
 *   onClose：卡片关闭时回调（解绑外部监听）。
 * @returns {{ el: HTMLElement, close: Function }}
 */
export function actionToast(opts = {}) {
    const { severity = "error", summary, detail = "", actionLabel = "", onAction = null, onClose = null } = opts;
    const stack = ensureStack();

    const el = document.createElement("div");
    el.className = `neo-at neo-at-${severity}`;
    el.setAttribute("role", "alert");

    const icon = document.createElement("span");
    icon.className = "neo-at-icon";
    icon.textContent = ICONS[severity] || ICONS.info;
    const body = document.createElement("div");
    body.className = "neo-at-body";
    const sum = document.createElement("div");
    sum.className = "neo-at-summary";
    sum.textContent = String(summary || "");
    body.appendChild(sum);
    if (detail) {
        const det = document.createElement("div");
        det.className = "neo-at-detail";
        det.textContent = String(detail);
        body.appendChild(det);
    }
    el.append(icon, body);

    let autoTimer = null;
    const close = () => {
        if (autoTimer) clearTimeout(autoTimer);
        if (!el.parentNode) return;
        onClose?.();
        el.classList.add("neo-at-out");
        setTimeout(() => el.remove(), 200);
    };
    if (actionLabel) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "neo-at-action";
        btn.textContent = actionLabel;
        btn.addEventListener("click", () => { onAction?.(); close(); });
        el.appendChild(btn);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "neo-at-close";
    x.title = t("关闭");
    x.textContent = "✕";
    x.addEventListener("click", close);
    el.appendChild(x);

    stack.appendChild(el);
    // 带 action 的卡片等用户处理；无 action 的正常级别（success/info）超时自动消失
    if (!actionLabel && (severity === "success" || severity === "info")) {
        autoTimer = setTimeout(close, AUTO_DISMISS_MS);
    }
    return {
        el,
        close,
    };
}
