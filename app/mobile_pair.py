# SPDX-License-Identifier: Apache-2.0
"""手机扫码连接（局域网）：配对令牌的生成与校验，二维码内容就是配对页地址。

手机扫的码指向桌面端服务端口上的 /neo-studio/pair：手机浏览器直接打开配对页，
不装原生 App，也没有云端中转 —— 只有「启动设置 → 局域网监听」放开时这条链路才有意义。
令牌与到期时间落进 launcher_config.json 持久化，桌面端窗口重启后设置页里还是同一个码，
手机不必重扫；「立即刷新」换新码，旧码当场失效。

二维码里的地址用请求的 Host 头（手机眼中的本机地址），不是本机网卡清单里的第一个 IP：
多网卡机器上网卡顺序与手机走的网段经常不一致，按清单出码就会扫开一张连不上的网卡。
"""

import hmac
import secrets
from urllib.parse import urlsplit

PAIR_TTL_SECONDS = 300
STUDIO_PATH = "/neo-studio"
PAIR_PATH = "/neo-studio/pair"
PAIR_INFO_PATH = "/neo-studio/pair/info"
PAIR_CHECK_PATH = "/neo-studio/pair/check"
TOKEN_BYTES = 16   # 128 bit：配对页是个免登录入口，令牌的强度按一次性入口的惯例给足
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


def new_token() -> str:
    """URL 安全的配对令牌（secrets 的 base64url，无 +/= —— 直接进查询串不必转义）。"""
    return secrets.token_urlsafe(TOKEN_BYTES)


def _stamp_token(cfg: dict, token: str, now: float) -> str:
    cfg["pair_token"] = token
    cfg["pair_expires_at"] = round(now + PAIR_TTL_SECONDS, 3)
    cfg["pair_dirty"] = True   # 服务侧只改字典，落盘由桌面端的 save 负责（app/studio_server.py）
    return token


def ensure_token(cfg: dict, now: float) -> str:
    """当前有效令牌；没有或已过期就换新的写回配置字典（落盘由调用方的 save_config 负责）。"""
    token = cfg.get("pair_token") or ""
    if token and float(cfg.get("pair_expires_at") or 0) > now:
        return token
    return _stamp_token(cfg, new_token(), now)


def rotate_token(cfg: dict, now: float) -> str:
    """「立即刷新」：无视剩余寿命换新码，旧码立刻失效，寿命从这次重算。"""
    return _stamp_token(cfg, new_token(), now)


def token_ok(cfg: dict, token: str, now: float) -> bool:
    """配对页带令牌来验：常数时间比对，过期与令牌不匹配是同一条回复，不告诉是哪一种。"""
    want = cfg.get("pair_token") or ""
    if not want or float(cfg.get("pair_expires_at") or 0) <= now:
        return False
    return hmac.compare_digest(want, token or "")


def seconds_left(cfg: dict, now: float) -> int:
    """二维码还剩多少秒可用；已过期回 0，页面据此提示刷新。"""
    return max(0, int(float(cfg.get("pair_expires_at") or 0) - now))


def lan_prefixes(ips: list) -> list:
    """网卡地址的网段前缀（IPv4 前三段 = /24）：主机头落进这些网段才算局域网来的请求。

    手机与电脑在同一个 WiFi 时，手机看到的本机地址与它自己同网段；跨网段的公网地址
    不在这个集合里，扫开也连不上，直接拒。
    """
    out = []
    for ip in ips or []:
        parts = str(ip).split(".")
        if len(parts) == 4 and all(p.isdigit() for p in parts[:3]):
            out.append(".".join(parts[:3]))
    return out


def lan_host(host_header: str, prefixes: list) -> str:
    """请求 Host 头里的 IP 命中本机网段时给出该 IP，否则空串（含回环与公网地址）。

    兼容旧版浏览器直连 ComfyUI 端口（主机头端口是 8188）：端口换成桌面端端口。
    """
    host = urlsplit(f"//{host_header}").hostname or ""
    if not host or host.lower() in LOOPBACK_HOSTS:
        return ""
    if not any(host.startswith(p + ".") for p in prefixes or []):
        return ""
    return host


def pair_url(host: str, port: int, token: str, path: str = PAIR_PATH) -> str:
    """二维码与配对链接的正文：桌面端服务端口上的配对页。"""
    return f"http://{host}:{port}{path}?token={token}"


def pair_payload(cfg: dict, host: str, port: int, now: float, lan_open: bool = True) -> dict:
    """设置页轮询的那份数据：配对地址、令牌、剩余秒数，以及监听是否放开。

    监听没放开 = 手机根本连不到这台电脑：不出码也不生成令牌，面板直接说明去哪一项放开。
    host 为空 = 这次请求不是局域网来的（桌面端窗口自己就是回环）：沿用上次落盘的
    主机地址出码，让设置页上的二维码与手机扫码时的地址是同一个。
    """
    lan_host_ = (host or (cfg.get("pair_host") or "")) if lan_open else ""
    if lan_open and host:
        cfg["pair_host"] = host
    out = {"success": True, "mode": "lan", "lan_open": bool(lan_open),
           "port": port, "ttl_seconds": PAIR_TTL_SECONDS}
    if not lan_host_:
        out.update({"url": "", "token": "", "seconds_left": 0})
        return out
    token = ensure_token(cfg, now)
    out.update({"url": pair_url(lan_host_, port, token), "token": token,
                "host": lan_host_, "seconds_left": seconds_left(cfg, now)})
    return out
