// Neo Studio 的 `scripts/api.js` 替身：fetchApi（返回 Response）+ WebSocket 事件桥。
// ComfyUI 前端把 WS 消息按 type 派发为同名事件（rs.image_gen.status / rs.prompt.update …），
// 断线重连后补发 "reconnected"；这里照同一契约实现，web/ 模块无需改动。
// 页面钉在桌面端端口上，请求一律相对路径：内核的接口由桌面端转发（app/studio_server.py）。
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

// 409 {offline:true} = 内核没就绪时桌面端答的离线响应：广播给页面统一提示，
// 不让各模块各自处理一个裸 409。
async function fetchApi(path, init) {
    const resp = await fetch(path, init);
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
// /ws 打在页面自己的端口上：内核在跑时桌面端把这一路双向接力到内核的事件流（studio_ws）
function wsUrl() {
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

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

// 翻面（离线 ↔ 就绪）时换事件流：桩（桌面端没内核）↔ 真隧道（桌面端接力到内核）。
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
