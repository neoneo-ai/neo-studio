// 「主画布编辑」那一发的落点：画布只在 ComfyUI 自己的页面上，Studio 页面钉在桌面端端口时
// 相对 "/" 是桌面端自己的页面，必须按内核地址开。桌面端从 /neo_studio/version 报这两值：
// 本机内核只报端口 —— 页面按自己的主机名配它，局域网对端的主机名就是它那台机器看得到的本机地址；
// 远程内核报桌面端配的那个地址（那台机器对网段上所有设备都可达）。
// 两者都没有（内核没就绪、或页面就在内核自己那份 Studio 页上）时 canvasOrigin() 给空串，
// 拼出来的链接就是相对路径：页面与内核同源，本来就在画布那一侧。
let port = 0;
let origin = "";

export function configureCanvasOrigin(next = {}) {
    port = Number(next?.port) || 0;
    origin = /^https?:\/\/[^\s/]+$/.test(String(next?.origin || "")) ? String(next.origin).replace(/\/+$/, "") : "";
}

export function canvasOrigin() {
    if (port) return `${location.protocol}//${location.hostname}:${port}`;
    return origin;
}