/**
 * pair-access.js —— 「设置 → 手机连接」面板：局域网配对二维码、配对链接与有效期倒计时。
 *
 * 数据只有一条来源：桌面端服务的 /neo-studio/pair/info（app/studio_server.py 与
 * app/mobile_pair.py）。二维码由 core/qrcode-lite.js 现画成内联 SVG，不产生图片文件；
 * tab 激活时每 5 秒轮询、每秒走一格倒计时，令牌到期由服务端换新码。
 * 只有「启动设置 → 局域网监听」放开后这条链路才通：没放开时面板明说不可用，不摆一个只会失败的码。
 */

import { qrSvg } from "./qrcode-lite.js";

const POLL_MS = 5000;

/** 桌面窗口的页面跑在 http://127.0.0.1（非安全上下文），navigator.clipboard 可能整个不存在；
 * WebView2 这边 execCommand("copy") 走得通，是复制的兜底出口。 */
export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch { /* 非安全上下文：走 execCommand 兜底 */ }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
}

/** 面板本体：返回 { el, refresh, stop }，由设置页的 tab 激活/切走驱动。 */
export function createPairPanel({ api, t, tf, toast }) {
    const el = document.createElement("div");
    el.className = "ns-settings-section ns-pair-section";

    const title = document.createElement("h3");
    title.textContent = t("手机连接");
    const hint = document.createElement("div");
    hint.className = "ns-pair-hint";
    hint.textContent = t("手机与电脑连同一个 WiFi，扫码即在手机浏览器里打开 Neo Studio，不需要装 App。");

    const qrBox = document.createElement("div");
    qrBox.className = "ns-pair-qr";
    const linkRow = document.createElement("div");
    linkRow.className = "ns-pair-row";
    const linkIn = document.createElement("input");
    linkIn.className = "ns-pair-url";
    linkIn.readOnly = true;
    linkIn.spellcheck = false;
    const copyBtn = document.createElement("button");
    copyBtn.className = "ns-btn";
    copyBtn.textContent = t("复制");
    const refreshBtn = document.createElement("button");
    refreshBtn.className = "ns-btn ns-pair-refresh";
    refreshBtn.textContent = t("立即刷新二维码");
    const status = document.createElement("div");
    status.className = "ns-pair-status";

    linkRow.append(linkIn, copyBtn);
    el.append(title, hint, qrBox, linkRow, refreshBtn, status);

    let seconds = 0;
    let timer = null;
    let tick = null;

    copyBtn.onclick = async () => {
        if (!linkIn.value) { toast(t("还没有可复制的配对链接")); return; }
        toast(await copyText(linkIn.value)
            ? t("配对链接已复制，发到手机浏览器地址栏即可打开")
            : t("复制失败，请长按上方链接手动复制"));
    };

    refreshBtn.onclick = async () => {
        try {
            const res = await api.fetchApi("/neo_studio/launcher", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "pair_rotate" }),
            });
            const data = await res.json();
            if (!data.ok) { toast(tf("刷新失败：{error}", { error: data.error || "unknown" })); return; }
            seconds = data.seconds_left || 0;
            await poll();
        } catch (e) {
            toast(tf("刷新失败：{msg}", { msg: String(e) }));
        }
    };

    function renderInfo(info) {
        if (!info || !info.success) {
            show({ qr: false, link: false, refresh: false });
            status.textContent = t("桌面端服务未运行：手机连接只在 Neo Studio 桌面端窗口里可用。");
            return;
        }
        if (!info.lan_open) {
            show({ qr: false, link: false, refresh: false });
            status.textContent = t("未放开局域网监听，手机连不到这台电脑。到「启动设置 → 局域网监听」选一个网卡地址并保存重启后，这里才会出二维码。");
            return;
        }
        if (!info.url) {
            show({ qr: false, link: false, refresh: true });
            status.textContent = t("还没拿到本机局域网地址：连上 WiFi 或插好网线后点「立即刷新二维码」。");
            return;
        }
        show({ qr: true, link: true, refresh: true });
        qrBox.innerHTML = qrSvg(info.url);
        linkIn.value = info.url;
        seconds = info.seconds_left || 0;
        status.textContent = seconds > 0
            ? tf("二维码将在 {n} 秒后自动刷新；手机与电脑需保持同一 WiFi。", { n: seconds })
            : t("二维码已过期，点「立即刷新二维码」换一张。");
    }

    /** 用 native hidden 收起当前用不了的控件：复制与刷新在没有可复制内容时点了只会失败。 */
    function show({ qr, link, refresh }) {
        qrBox.hidden = !qr;
        linkRow.hidden = !link;
        refreshBtn.hidden = !refresh;
        if (!link) linkIn.value = "";
        if (!qr) qrBox.innerHTML = "";
    }

    async function poll() {
        try {
            const res = await api.fetchApi("/neo-studio/pair/info");
            renderInfo(await res.json());
        } catch {
            show({ qr: false, link: false, refresh: false });
            status.textContent = t("读不到桌面端服务的配对信息：手机连接只在 Neo Studio 桌面端窗口里可用。");
        }
    }

    /** tab 激活：拉一次并开始轮询与倒计时。 */
    function refresh() {
        stop();
        poll();
        timer = setInterval(poll, POLL_MS);
        tick = setInterval(() => {
            if (seconds <= 0) return;
            seconds -= 1;
            status.textContent = tf("二维码将在 {n} 秒后自动刷新；手机与电脑需保持同一 WiFi。", { n: seconds });
        }, 1000);
    }

    /** tab 切走：停掉定时器，不留后台轮询。 */
    function stop() {
        if (timer) clearInterval(timer);
        if (tick) clearInterval(tick);
        timer = null;
        tick = null;
    }

    return { el, refresh, stop, poll, renderInfo };
}
