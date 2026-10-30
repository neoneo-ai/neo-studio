// Neo Studio 的 `scripts/api.js` 替身：fetchApi（返回 Response）+ WebSocket 事件桥。
// ComfyUI 前端把 WS 消息按 type 派发为同名事件（rs.image_gen.status / rs.prompt.update …），
// 断线重连后补发 "reconnected"；这里照同一契约实现，web/ 模块无需改动。
import { resolve, wsUrl } from "./route.js";

function newClientId() {
    // WebKit / non-secure http origin may not expose crypto.randomUUID; the
    // ComfyUI client id only needs to be unique enough for the websocket bridge.
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const clientId = newClientId();
const listeners = new Map();

// 409 {offline:true} = 桌面端服务不认的接口（要 ComfyUI 执行队列）：广播给页面统一提示，
// 不让各模块各自处理一个裸 409。
async function fetchApi(path, init) {
    const resp = await fetch(resolve(path, init), init);
    if (resp.status === 409) {
        resp.clone().json()
            .then((data) => {
                if (data && data.offline) {
                    window.dispatchEvent(new CustomEvent("neo-offline-request", { detail: { path } }));
                }
            })
            .catch(() => {});
    }
    return resp;
}

function dispatch(type, detail) {
    const arr = listeners.get(type);
    if (!arr || !arr.length) return;
    for (const fn of [...arr]) {
        try {
            fn({ type, detail });
        } catch (e) {
            console.error(`[Neo Studio] api event ${type}:`, e);
        }
    }
}

let ws = null;
function connect() {
    ws = new WebSocket(`${wsUrl()}?clientId=${clientId}`);
    ws.onopen = () => dispatch("reconnected");
    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg && typeof msg.type === "string") dispatch(msg.type, msg.data);
        } catch { /* 非 JSON 消息忽略 */ }
    };
    ws.onclose = () => setTimeout(connect, 2000);
}

// 页面原地接上 ComfyUI 时换目标：桩（桌面端）→ 真事件流（ComfyUI）。
// 先摘掉 onclose 再关，否则自动重连会照旧连回桩，出现「按钮已解禁、进度事件全不来」的半在线态。
export function reconnectSocket() {
    if (ws) {
        ws.onclose = null;
        try { ws.close(); } catch { /* 已关 */ }
        ws = null;
    }
    connect();
}

export const api = {
    fetchApi,
    addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
        const arr = listeners.get(type);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
    },
};

connect();
