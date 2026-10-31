// 接口归属路由：Studio 页面钉在桌面端端口上，生成类请求由页面自己直连 ComfyUI。
// 归属表由桌面端 /neo_studio/version 下发（app/studio_caps.py 是唯一真源），这里不另立第二份清单。
// comfyBase 为空 = 这路 ComfyUI 不认桌面端 origin（未就绪 / 附着的那路 / 远程那路）：
// comfy 归属的路径照旧打桌面端，拿 409 走统一的「需要 ComfyUI」提示，不给前端假成功。
let comfyBase = "";
let desktopRoutes = new Set();

// 桌面端自己的 origin：整页跳到 ComfyUI 端口时由桌面端挂在 URL 上（app/studio_app.py 的
// studio_target）。MCP 那族（注册表 / 连接 / 工具调用）只有桌面端进程有，页面在 ComfyUI
// 端口上时它必然 404 —— 这一族从这里回桌面端口，其余路径不受影响。
// 首次 resolve 才读：模块 import 期页面可能还没有 location（测试桩先建模块图，后建窗口）。
const MCP_PREFIX = "/neo_mcp";
let desktopBase;
function desktopOrigin() {
    if (desktopBase === undefined) {
        const value = new URLSearchParams(location.search).get("neo_desktop") || "";
        desktopBase = /^http:\/\/127\.0\.0\.1:\d+$/.test(value) ? value : "";
    }
    return desktopBase;
}

// 归属判定只认「绝对路径 + 方法」：Request / 绝对 URL 交给调用方，桌面端与 ComfyUI 都按路径路由
function ownershipKey(input, init) {
    if (typeof input !== "string" || !input.startsWith("/")) return null;
    return `${((init && init.method) || "GET").toUpperCase()} ${input.split("?")[0]}`;
}

export function configure({ desktopRoutes: list, comfyBase: base } = {}) {
    if (list) desktopRoutes = new Set(list);   // 只传 comfyBase 时保留归属表：翻回离线形态就靠这一发
    comfyBase = base && base !== location.origin ? String(base).replace(/\/+$/, "") : "";
}

export function resolve(input, init) {
    const desk = desktopOrigin();
    if (desk && typeof input === "string" && input.startsWith(MCP_PREFIX)) return desk + input;
    const key = comfyBase ? ownershipKey(input, init) : null;
    return key && !desktopRoutes.has(key) ? comfyBase + input : input;
}

// /ws 不受 CORS 约束：就绪后直连 ComfyUI 的真事件流，未就绪时连桌面端的桩（studio_server.py 的 studio_ws）
export function wsUrl() {
    const base = comfyBase ? comfyBase.replace(/^http/, "ws")
                           : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
    return `${base}/ws`;
}
