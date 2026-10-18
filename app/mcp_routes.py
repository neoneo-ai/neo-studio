# SPDX-License-Identifier: Apache-2.0
"""桌面端 MCP 路由：前端只发 HTTP，stdio 子进程只活在这个进程里。

模块自带 RouteTableDef，源码里不碰 PromptServer / nodes / comfy —— 桌面端进程里没有
ComfyUI 运行时（app/tests/test_studio_server.py 断言这一点）。
"""
from __future__ import annotations

import asyncio
import json

from aiohttp import web

import mcp_client

routes = web.RouteTableDef()


async def _body(request) -> dict:
    """请求体必须是 JSON 对象：坏报文回 400，不让 handler 拿着 None 往下走。"""
    try:
        data = await request.json()
    except (json.JSONDecodeError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


async def _offload(request, fn):
    """MCP 往返是阻塞的：子进程 readline 与 urllib 都不认事件循环，进线程池等。
    一次 tools/call 里外部工具跑三分钟时，事件循环还要能响应其它请求。"""
    return await asyncio.get_running_loop().run_in_executor(None, fn)


@routes.get("/neo_mcp/servers")
async def servers(request):
    manager = request.app["mcp"]
    return web.json_response({"success": True, "servers": manager.servers(),
                              "connected": manager.connected(),
                              "config": str(manager.config_path)})


@routes.post("/neo_mcp/servers")
async def save_servers(request):
    body = await _body(request)
    if "servers" not in body:
        return web.json_response({"success": False, "error": "缺少 servers"}, status=400)
    res = await _offload(request, lambda: request.app["mcp"].save_servers(body["servers"]))
    return web.json_response(res)


@routes.post("/neo_mcp/connect")
async def connect(request):
    body = await _body(request)
    res = await _offload(request, lambda: request.app["mcp"].connect(body.get("name", "")))
    return web.json_response(res)


@routes.post("/neo_mcp/disconnect")
async def disconnect(request):
    body = await _body(request)
    res = await _offload(request, lambda: request.app["mcp"].disconnect(body.get("name", "")))
    return web.json_response(res)


@routes.get("/neo_mcp/tools")
async def tools(request):
    res = await _offload(request, lambda: request.app["mcp"].tools())
    return web.json_response(res)


@routes.post("/neo_mcp/tools/call")
async def call_tool(request):
    body = await _body(request)
    manager = request.app["mcp"]
    res = await _offload(request, lambda: manager.call(body.get("name", ""),
                                                       body.get("tool", ""),
                                                       body.get("arguments") or {}))
    return web.json_response(res)
