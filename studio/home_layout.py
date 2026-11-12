# SPDX-License-Identifier: Apache-2.0
# Neo Studio — 首页版式：卡片顺序与显隐、板块顺序、自建卡、标题区文案、网格列数。
# 只读写 configs/home_layout.json，不依赖 PromptServer 与执行队列，
# 因此 ComfyUI 内注册与桌面端离线服务共用这一份实现。
#
# 版式存数据根而不是浏览器 localStorage：插件页、桌面窗口和手机页是三份互看不见的本机存储，
# 偏好落在文件上才是「我排好的首页」，三端打开同一份数据根就长一个样。
#
# 这里只守形状与规模：哪张卡真实存在、跳到哪一屏归前端注册表（web/studio/home-layout.js 的
# HOME_CARDS）。后端认不出一张已删的卡，前端认不出来就落回默认页 —— 卡表只有前端那一份。

from __future__ import annotations

import json
import logging
import os
import re

from aiohttp import web

from . import plugin_paths
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

CONFIGS_DIR = str(plugin_paths.CONFIGS_DIR)
LAYOUT_FILE = os.path.join(CONFIGS_DIR, "home_layout.json")

# 空版式 = 首页按前端注册表的默认卡片与默认文案渲染：文件缺失、文件坏掉、
# 前端读到一半认不出的键，全都落回这里，首页不空屏。
DEFAULT_LAYOUT = {
    "sections": [],          # 板块顺序；空 = 注册表默认顺序
    "hidden_sections": [],   # 收起来的板块
    "order": {},             # 板块 → 该板块卡片 id 顺序（整板块写入）
    "hidden": [],            # 隐藏的卡片 id
    "custom": [],            # 自建卡：{id,section,title,sub,icon,target,value,url}
    "cols": 0,               # 网格列数；0 = 跟随窗口档位
    "hero": {},              # 标题区：{title,accent,suffix,sub,cta,off,cta_off}
}

# 自建卡与内置卡共用这套 id 形态：卡片改名之后旧版式里的行只会认不出，不会写坏文件
_ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_-]{0,39}$")
_URL_SCHEME = re.compile(r"https?://", re.I)

# 自建卡的跳转类型；前端 openHomeCard 按同一份清单落地，多给一种就是前端接不住的一条死路。
# 卡片弹窗能配的只有前四种（与前端 HOME_TARGETS 同步）：直连本页是内置预设卡的事，弹窗不再给这一项；
# page 留在这一份里只为旧版式里存着的直连卡 —— 照读照跳，不让一次保存静默丢掉用户已有的卡。
CUSTOM_TARGETS = ("edit", "url", "recipe", "skill", "page")

_HERO_KEYS = ("title", "accent", "suffix", "sub", "cta")
_MAX_SECTIONS = 20
_MAX_CARDS = 60
_MAX_CUSTOM = 20
_MAX_TITLE = 40
_MAX_SUB = 60
_MAX_ICON = 24
_MAX_VALUE = 120
_MAX_URL = 500
_COLS = (0, 2, 3, 4, 5)   # 0 = 跟随窗口档位；手机上与窄窗口里网格自己收到单列

routes = web.RouteTableDef()


@routes.get("/neo_home/layout")
async def layout_route(request: web.Request) -> web.Response:
    return web.json_response(get_layout())


@routes.post("/neo_home/layout")
async def save_layout_route(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "版式数据读不出来"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"success": False, "error": "版式数据不是一个对象"}, status=400)
    return web.json_response({"success": True, "layout": save_layout(body)})


@routes.post("/neo_home/layout/reset")
async def reset_layout_route(request: web.Request) -> web.Response:
    return web.json_response({"success": True, "layout": reset_layout()})


def get_layout() -> dict:
    """读首页版式：文件缺失或读坏了都回空版式，首页照默认卡片渲染。"""
    layout = _blank()
    try:
        with open(LAYOUT_FILE, "r", encoding="utf-8") as f:
            stored = json.load(f)
    except FileNotFoundError:
        return layout
    except Exception as e:
        logger.warning(f"home layout file ignored ({e}), rendering default home")
        return layout
    return normalize_layout(stored)


def save_layout(patch: dict) -> dict:
    """整份版式校验后原子落盘，返回存下来的那一份。"""
    layout = normalize_layout(patch)
    os.makedirs(CONFIGS_DIR, exist_ok=True)
    tmp = LAYOUT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(layout, f, ensure_ascii=False, indent=2)
    os.replace(tmp, LAYOUT_FILE)
    return layout


def reset_layout() -> dict:
    """删掉版式文件：首页回到注册表的默认版式（首页原地编辑那条细栏里那一个「恢复默认」）。"""
    try:
        os.remove(LAYOUT_FILE)
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.warning(f"home layout reset failed: {e}")
    return _blank()


def normalize_layout(patch: dict) -> dict:
    """形状与规模守门：认不出的键丢掉，越界的值钳回边界内。"""
    patch = patch if isinstance(patch, dict) else {}
    layout = _blank()
    layout["sections"] = _ids(patch.get("sections"), _MAX_SECTIONS)
    layout["hidden_sections"] = _ids(patch.get("hidden_sections"), _MAX_SECTIONS)
    order = patch.get("order")
    if isinstance(order, dict):
        for key, value in list(order.items())[:_MAX_SECTIONS]:
            section = str(key or "")
            ids = _ids(value if isinstance(value, list) else [], _MAX_CARDS)
            if ids and _ID_RE.match(section):
                layout["order"][section] = ids
    layout["hidden"] = _ids(patch.get("hidden"), _MAX_CARDS)
    layout["custom"] = _custom_cards(patch.get("custom"))
    layout["cols"] = _cols(patch.get("cols"))
    hero = patch.get("hero")
    layout["hero"] = _hero(hero if isinstance(hero, dict) else {})
    return layout


def _blank() -> dict:
    return {key: ({} if isinstance(val, dict) else list(val) if isinstance(val, list) else val)
            for key, val in DEFAULT_LAYOUT.items()}


def _ids(values, limit: int) -> list:
    """id 列表：只留形态合格的，去重并按上限截断。"""
    out = []
    for value in (values if isinstance(values, list) else []):
        item = str(value or "")
        if _ID_RE.match(item) and item not in out:
            out.append(item)
        if len(out) >= limit:
            break
    return out


def _text(value, limit: int) -> str:
    """一行文案：换行压成空格，超长截断。"""
    return " ".join(str(value if value is not None else "").split())[:limit]


def _url(value) -> str:
    """外链只认 http / https：js: 与 data: 这类 scheme 不落进文件（前端开外链同一口径，
    scheme 大小写都认，浏览器自己会把 open 的 URL 归成小写）。"""
    text = str(value if value is not None else "").strip()[:_MAX_URL]
    return text if _URL_SCHEME.match(text) else ""


def _cols(value) -> int:
    try:
        cols = int(value)
    except (TypeError, ValueError):
        return 0
    return cols if cols in _COLS else 0


def _hero(patch: dict) -> dict:
    hero = {}
    for key in _HERO_KEYS:
        text = _text(patch.get(key), _MAX_SUB if key == "sub" else _MAX_TITLE)
        if text:
            hero[key] = text
    for key in ("off", "cta_off"):
        if key in patch:
            hero[key] = bool(patch[key])
    return hero


def _custom_cards(values) -> list:
    """自建卡三件齐全才留：id 形态合格、标题非空、跳转类型在清单内。

    section 与 value 只认形态：板块名与目标页是前端注册表里的名字，前端删了板块或改了页名，
    这一张卡落回默认板块与默认页 —— 不能让一份旧版式把首页拖成认不出来的一块。"""
    out = []
    for item in (values if isinstance(values, list) else []):
        if not isinstance(item, dict):
            continue
        card_id = str(item.get("id") or "")
        section = str(item.get("section") or "")
        title = _text(item.get("title"), _MAX_TITLE)
        target = str(item.get("target") or "")
        if not _ID_RE.match(card_id) or not title or target not in CUSTOM_TARGETS:
            continue
        if len(out) >= _MAX_CUSTOM:
            break
        out.append({
            "id": card_id,
            "section": section if _ID_RE.match(section) else "",
            "title": title,
            "sub": _text(item.get("sub"), _MAX_SUB),
            "icon": _text(item.get("icon"), _MAX_ICON),
            "target": target,
            "value": _text(item.get("value"), _MAX_VALUE),
            "url": _url(item.get("url")),
        })
    return out
