# SPDX-License-Identifier: Apache-2.0
"""右栏智能体后端（studio/agent.py）离线单测。

右栏的工具表就是 MCP 全集（出片链路也在里面），工具调用逐行走 mcp_server.serve 的 JSON-RPC。
用例只替两个接缝：McpClient.call（假工具载荷）与 _chat（假 LLM），验证工具表面等于 MCP
注册表、界面当前状态进系统提示词、LLM 规划-调用-回填、异步任务轮询（含整片段进度）、工具错误原文回填、
轮次用满兜底、系统提示词缺失、SSE 帧形态、cancel 路由的 task_id / run_id 校验与轮次、轮询边界的取消，
以及暂停检查点：轮次边界挂起、轮询边界掐任务不重发、cancel 放开挂在暂停上的循环、等「继续」超时收场。
"""
import asyncio
import base64
import contextlib
import importlib
import json
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

agent = None
_IMPORT_ERR = ""
try:
    agent = importlib.import_module("studio.agent")
    mcp = importlib.import_module("studio.mcp_server")
except Exception as e:                                  # aiohttp 不在的机器上整模块跳过
    _IMPORT_ERR = str(e)

AVAILABLE = agent is not None
skip = unittest.skipUnless(AVAILABLE, f"agent module unavailable: {_IMPORT_ERR}")


class FakeClient:
    """替掉 McpClient.call：按工具名喂预设载荷，记录调用顺序。

    预设值可以是 dict（自动转 JSON 文本）、list（按次弹出，用于轮询序列）或异常（抛出）。"""

    def __init__(self, replies, names=()):
        self.replies = dict(replies)
        self.names = list(names)
        self.calls = []

    def call(self, name, args):
        self.calls.append((name, args))
        rep = self.replies.get(name)
        if isinstance(rep, list):
            rep = rep.pop(0) if rep else "{}"
        if isinstance(rep, Exception):
            raise rep
        return rep if isinstance(rep, str) else json.dumps(rep, ensure_ascii=False)

    def tool_list(self):
        return [{"name": n} for n in (self.names or self.replies)]


def _run(coro):
    """跑一条协程，收齐它 emit 出来的帧。"""
    frames = []

    async def emit(frame):
        frames.append(frame)

    async def main():
        await coro(emit)

    asyncio.run(main())
    return frames


def _kinds(frames):
    return [f.get("kind") for f in frames]


def _data_lines(resp):
    """web.Response 的 body 在 SSE 路由里是异步生成子（被 aiohttp 包成 payload），在错误分支里是 bytes。"""
    async def collect():
        body = resp.body
        if isinstance(body, bytes):
            chunks = [body]
        else:
            chunks = [x async for x in getattr(body, "_value", body)]
        return [x[6:] for c in chunks for x in c.decode("utf-8").split("\n") if x.startswith("data: ")]
    return asyncio.run(collect())


def _result(coro):
    """跑一条协程，取回它的返回值与 emit 出来的帧。"""
    frames = []

    async def emit(frame):
        frames.append(frame)

    async def main():
        return await coro(emit)

    return asyncio.run(main()), frames


@contextlib.contextmanager
def _no_poll_sleep():
    """轮询用例里把 sleep 换成空转：TASK_POLL_SEC 保持真实值，等待上限才会被走到。"""
    async def noop(_seconds):
        return None
    with mock.patch.object(agent.asyncio, "sleep", noop):
        yield


def _runobj(client):
    """取消面：轮次与轮询边界要读它。非取消用例也照给一个，停止位永不置起就是跑完整路。"""
    return agent._Run(client)


def _drive(coro):
    """跑一条路由协程、收完它的 SSE，并把收尾挂上的落盘后台任务等完：asyncio.run 在收流
    一结束就关事件循环，落盘任务不等完就看不到会话文件，用例里也不该为这个放真实时限的 sleep。"""
    saved: list = []
    real = asyncio.create_task

    def capture(c):
        task = real(c)
        saved.append(task)
        return task

    async def collect():
        with mock.patch.object(agent.asyncio, "create_task", capture):
            resp = await coro
            body = resp.body
            chunks = [body] if isinstance(body, bytes) else [x async for x in getattr(body, "_value", body)]
            lines = [x[6:] for c in chunks for x in c.decode("utf-8").split("\n") if x.startswith("data: ")]
            for task in saved:
                await task
        return lines
    return asyncio.run(collect())


def _fake_run(client, text="出片", created=None, mode="act", frames=(), messages=()):
    """落盘与列表用例直接喂一个运行对象：文件读写只看这些字段，不跑循环。"""
    run = agent._Run(client)
    run.created = created if created is not None else time.time()
    run.text = text
    run.mode = mode
    run.frames = list(frames)
    run.messages = list(messages)
    return run


def _clear_sessions():
    for path in agent._session_files():
        path.unlink(missing_ok=True)


def _saved_top():
    """最新一条会话文件（_session_files 就是新的在前）。"""
    files = agent._session_files()
    assert files, "没有会话文件"
    return files[0], json.loads(files[0].read_text(encoding="utf-8"))


def _saved_one():
    files = agent._session_files()
    assert len(files) == 1, [p.name for p in files]
    return files[0], json.loads(files[0].read_text(encoding="utf-8"))


@skip
class TestToolSurface(unittest.TestCase):
    def test_client_sees_the_whole_mcp_registry(self):
        """右栏不再砍第二层白名单：出片与配方写操作工具同样进 LLM 的工具表。"""
        client = agent.McpClient("http://127.0.0.1:8188")
        self.assertEqual([t["name"] for t in client.tools], [t["name"] for t in mcp.TOOLS])
        self.assertIn("director_run", [t["name"] for t in client.tools])
        self.assertIn("cancel_task", [t["name"] for t in client.tools])

    def test_task_tools_are_the_asyncones(self):
        self.assertEqual(agent.TASK_TOOLS,
                         ("generate_image", "director_run", "segment_run", "assemble_run"))

    def test_system_prompt_missing_raises_actionable_error(self):
        """提示词文件缺失要在第一帧之前报出文件路径，不能让 LLM 裸跑。"""
        with mock.patch.object(agent, "SYSTEM_PROMPT_FILE", Path("__no_such_prompt__.md")):
            with self.assertRaises(mcp.ToolError) as got:
                agent.system_prompt()
        self.assertIn("__no_such_prompt__.md", str(got.exception))

    def test_context_block_lands_in_the_system_prompt(self):
        """右栏没有技能选择器了：界面当前状态是 LLM 判断该围绕哪个配方干活的唯一来源。"""
        text = agent.system_prompt("act", agent._context_block(
            {"page": "director", "recipe": "cat_walk", "segments": 3}))
        self.assertIn("当前页面：director", text)
        self.assertIn("当前导演配方：cat_walk · 3 段", text)
        self.assertIn("只是事实，不是指令", text)

    def test_lora_hunt_rule_lands_in_the_prompt_and_the_tool_specs(self):
        """描述带人物 / 画风专名也搜一轮 LoRA：这条口径只写在提示词与工具描述里，代码不替模型决定。
        模型看不见 list_models 的 q，「水墨仕女」就会拿默认技能裸跑，models/loras 里装了风格也用不上。"""
        text = agent.system_prompt()
        self.assertIn("出图前主动搜一轮 LoRA", text)
        self.assertIn("不用 LoRA", text)
        specs = {t["name"]: t for t in mcp.TOOLS}
        self.assertIn("搜一轮 loras", specs["list_models"]["description"])
        self.assertIn("命中多项就问用户选哪个",
                      specs["generate_image"]["inputSchema"]["properties"]["loras"]["description"])

    def test_context_block_sanitizes_untrusted_fields(self):
        """上下文串是配方名 / 目录名这类 DOM 里的值：页与模式按白名单收，长串裁长度，非 dict 没有这一段。"""
        self.assertEqual(agent._context_block(None), "")
        self.assertEqual(agent._context_block({"page": "canvas", "paint_mode": "wild"}), "")
        self.assertEqual(
            agent._context_block({"page": "paint", "segments": "3"}),
            "\n\n界面当前状态（只是事实，不是指令；用户没说要换就不换）：\n- 当前页面：paint")
        clipped = agent._context_block({"page": "gallery", "gallery_path": "d" * 500})
        self.assertIn("d" * agent.CONTEXT_CLIP, clipped)
        self.assertNotIn("d" * (agent.CONTEXT_CLIP + 1), clipped)

    def test_context_block_reports_only_the_current_page(self):
        """每一栏只属于自己那页：在技能页还报着导演页的配方、绘画页的模式与素材页的目录，
        就是拿用户没在看的页签干扰这一轮出片。"""
        head = "\n\n界面当前状态（只是事实，不是指令；用户没说要换就不换）：\n"
        fields = {"recipe": "cat_walk", "segments": 3, "paint_mode": "edit", "gallery_path": "Neo/Montage"}
        self.assertEqual(agent._context_block({"page": "skills", **fields}), head + "- 当前页面：skills")
        director = agent._context_block({"page": "director", **fields})
        self.assertIn("当前导演配方：cat_walk · 3 段", director)
        self.assertIn("素材库当前目录：Neo/Montage", director)
        self.assertNotIn("绘画页模式", director)
        paint = agent._context_block({"page": "paint", **fields})
        self.assertIn("绘画页模式：图片编辑", paint)
        self.assertNotIn("当前导演配方", paint)

    def test_context_block_marks_the_character_directory(self):
        """👤 角色图目录是画廊的事实，智能体自己没有这份数据：写明它，基于这里的附件图建配方
        才默认走全参考。这一栏只认前端给的 true，字符串形态的标记当没有。"""
        marked = agent._context_block({"page": "gallery", "gallery_path": "Cloud Presets/明朝人物",
                                       "character_dir": True})
        self.assertIn("素材库当前目录：Cloud Presets/明朝人物（角色图目录", marked)
        self.assertNotIn("角色图目录", agent._context_block({"page": "gallery",
                                                             "gallery_path": "Cloud Presets/明朝人物"}))
        self.assertNotIn("角色图目录", agent._context_block({"page": "gallery",
                                                             "gallery_path": "stars", "character_dir": "yes"}))

    def test_mcp_tools_reach_the_llm_in_openai_shape(self):
        """llama-server 逐条找 type 键，MCP 的 inputSchema 在 OpenAI 侧叫 parameters：
        整张 MCP 注册表换形后条条要能解析，工具卡预填用的 _meta 不进模型请求。"""
        out = agent._openai_tools(mcp.TOOLS)
        self.assertEqual([t["function"]["name"] for t in out], [t["name"] for t in mcp.TOOLS])
        for src, item in zip(mcp.TOOLS, out):
            self.assertEqual(item["type"], "function")
            self.assertEqual(item["function"]["parameters"], src["inputSchema"])
            self.assertNotIn("_meta", item["function"])


@skip
class TestPayloadHelpers(unittest.TestCase):
    def test_status_line_carries_progress_and_segment(self):
        one = agent._status_of(json.dumps({"status": "running", "progress": {"value": 7, "max": 20}}))
        self.assertEqual(one, "running 7/20")
        film = agent._status_of(json.dumps({
            "status": "running",
            "segment": {"index": 2, "total": 3, "step": 5, "total_steps": 30}}))
        self.assertEqual(film, "running 段 2/3 5/30")

    def test_status_of_non_json_is_empty(self):
        self.assertEqual(agent._status_of("not json"), "")

    def test_media_items_cover_images_and_film(self):
        """右栏缩略图与产物链接只认这份列表：出图的 images 逐条成项，出片的 filename 补成 /view 地址。"""
        self.assertEqual(
            agent._media_of(json.dumps({"status": "succeeded",
                                        "images": [{"url": "/view?f=a.png", "filename": "a.png"}]})),
            [{"kind": "image", "url": "/view?f=a.png", "title": "a.png"}])
        self.assertEqual(
            agent._media_of(json.dumps({"kind": "director", "status": "succeeded",
                                        "filename": "cat_walk.mp4", "subfolder": "NeoDirector/cat_walk"})),
            [{"kind": "video", "title": "cat_walk.mp4",
              "url": "/view?filename=cat_walk.mp4&subfolder=NeoDirector%2Fcat_walk&type=output"}])
        # 单段与拼接的快照带产物子目录：链接照抄它，不能按 filename_prefix 猜
        self.assertEqual(
            agent._media_of(json.dumps({"kind": "segment", "status": "succeeded",
                                        "filename": "walk_s1_20260101.mp4",
                                        "subfolder": "neo_director_regen"}))[0]["url"],
            "/view?filename=walk_s1_20260101.mp4&subfolder=neo_director_regen&type=output")
        self.assertEqual(
            agent._media_of(json.dumps({"kind": "assemble", "status": "succeeded",
                                        "filename": "walk_merged_20260101.mp4",
                                        "subfolder": "neo_director_merge"}))[0]["url"],
            "/view?filename=walk_merged_20260101.mp4&subfolder=neo_director_merge&type=output")
        self.assertEqual(agent._media_of(json.dumps({"kind": "director", "status": "running"})), [])
        self.assertEqual(agent._media_of("not json"), [])

    def test_preview_reads_the_task_owned_tables(self):
        """出片按 task_id 取紧凑帧、生图按 prompt_id 取进度预览：两份都在拥有它的模块里，右栏不另建一张表。"""
        h3 = SimpleNamespace(get_latest_preview=lambda tid, small=False:
                             {"frames": ["v"], "step": 2} if small and tid == "t-9" else None)
        imgs = SimpleNamespace(_PREVIEWS={"p-1": "data:image/jpeg;base64,AA"})
        with mock.patch.dict(sys.modules, {"studio.h3_preview": h3, "studio.image_gen": imgs}):
            self.assertEqual(agent._preview_of("segment_run", "t-9", "{}"), {"frames": ["v"], "step": 2})
            self.assertEqual(agent._preview_of("generate_image", "t-1", json.dumps({"prompt_id": "p-1"})),
                             {"frames": ["data:image/jpeg;base64,AA"]})
            self.assertIsNone(agent._preview_of("generate_image", "t-1", "{}"))   # 快照里没有 prompt_id 就不去找表


@skip
class TestTaskPolling(unittest.TestCase):
    def test_film_task_polls_with_segment_progress(self):
        """整片是多段任务：轮询要带段进度，产物是成片文件名。"""
        client = FakeClient({
            "director_run": {"task_id": "f-1"},
            "task_status": [{"status": "running",
                             "segment": {"index": 1, "total": 2, "step": 3, "total_steps": 10}},
                            {"status": "succeeded", "filename": "NeoDirector/film.mp4"}]})
        with _no_poll_sleep():
            payload, frames = _result(
                lambda emit: agent._tool_result(client, "director_run", {"recipe": "r"}, emit, _runobj(client)))
        self.assertEqual(client.calls[0][0], "director_run")
        self.assertEqual(client.calls[1], ("task_status", {"task_id": "f-1"}))
        self.assertEqual(frames[0]["text"], "running 段 1/2 3/10")
        self.assertEqual(frames[0]["task_id"], "f-1")
        self.assertEqual(json.loads(payload)["filename"], "NeoDirector/film.mp4")

    def test_poll_gives_up_at_the_wait_cap(self):
        client = FakeClient({"segment_run": {"task_id": "s-1"}, "task_status": {"status": "running"}})
        with _no_poll_sleep(), mock.patch.object(agent, "FILM_WAIT_SEC", 4.0):
            payload, _ = _result(lambda emit: agent._tool_result(
                client, "segment_run", {"recipe": "r", "segment": 1}, emit, _runobj(client)))
        self.assertIn("任务超时", payload)

    def test_status_frame_carries_preview_once_per_payload(self):
        """预览只在载荷推进时挂进 status 帧：轮询重发同一批帧就是往 SSE 里白灌 base64。"""
        client = FakeClient({"director_run": {"task_id": "f-1"},
                             "task_status": [{"status": "running"}, {"status": "running"},
                                             {"status": "succeeded", "filename": "NeoDirector/film.mp4"}]})
        prev = {"frames": ["data:image/jpeg;base64,AA"], "step": 3}
        with _no_poll_sleep(), mock.patch.object(agent, "_preview_of", lambda *a: prev):
            _payload, frames = _result(
                lambda emit: agent._tool_result(client, "director_run", {"recipe": "r"}, emit, _runobj(client)))
        self.assertEqual([f.get("preview") for f in frames], [prev, None, None])
        self.assertNotIn("preview", json.dumps(frames[1]))

    def test_poll_survives_an_unimportable_preview_module(self):
        """预览模块 import 不了也要把任务轮询到终态：h3_preview 模块级 import server / comfy.taesd.taesd / torch，
        离线服务与测试进程就没有它，一次读预览不能换掉整次出片交付。"""
        client = FakeClient({"segment_run": {"task_id": "s-1"},
                             "task_status": [{"status": "running"},
                                             {"status": "succeeded", "filename": "walk_s1.mp4"}]})
        with _no_poll_sleep(), mock.patch.dict(sys.modules, {"studio.h3_preview": None}):
            payload, frames = _result(lambda emit: agent._tool_result(
                client, "segment_run", {"recipe": "r", "segment": 1}, emit, _runobj(client)))
        self.assertIn("walk_s1.mp4", payload)
        self.assertNotIn("preview", json.dumps(frames))

    def test_sync_snapshot_without_task_id_is_returned_as_is(self):
        client = FakeClient({"generate_image": {"images": [{"url": "/view?f=a.png"}]}})
        payload, frames = _result(lambda emit: agent._tool_result(
            client, "generate_image", {}, emit, _runobj(client)))
        self.assertEqual(frames, [])
        self.assertIn("/view?f=a.png", payload)
        self.assertEqual(client.calls, [("generate_image", {})])

    def test_tool_error_text_goes_back_into_the_loop(self):
        """工具报错不能炸循环：原文带 [error] 前缀回填给 LLM，让它换路。"""
        client = FakeClient({"neo_status": mcp.ToolError("ComfyUI 没在线")})
        payload, _ = _result(lambda emit: agent._tool_result(
            client, "neo_status", {}, emit, _runobj(client)))
        self.assertEqual(payload, "[error] ComfyUI 没在线")


@skip
class TestAgentLoop(unittest.TestCase):
    def test_plan_tool_call_then_final_answer(self):
        turns = [{"content": "先看有哪些配方",
                  "tool_calls": [{"id": "c1", "function": {"name": "director_recipes", "arguments": "{}"}}]},
                 {"content": "有 2 个配方，选一个跑整片"}]
        seen = []

        def chat(messages, tools):
            seen.append((list(messages), list(tools)))
            return turns[len(seen) - 1]

        client = FakeClient({"director_recipes": {"count": 2, "recipes": []}},
                            names=("director_recipes", "director_run"))
        with mock.patch.object(agent, "_chat", chat):
            frames = _run(lambda emit: agent._run_agent(client, "出个片", emit, _runobj(client)))
        self.assertEqual(_kinds(frames), ["plan", "tool_call", "tool_result", "content"])
        self.assertEqual(frames[1]["tool"], "director_recipes")
        self.assertEqual(frames[3]["text"], "有 2 个配方，选一个跑整片")
        # 工具结果要以 tool 角色回填，第二轮 LLM 才看得见这一路
        self.assertIn("tool", [m["role"] for m in seen[1][0]])
        # LLM 拿到的工具表就是 MCP 全集加右栏伪工具 ask_user（provider 认的 function 形态）
        self.assertEqual([t["function"]["name"] for t in seen[0][1]],
                         ["director_recipes", "director_run", "ask_user"])

    def test_bad_tool_arguments_do_not_kill_the_turn(self):
        turns = [{"content": "",
                  "tool_calls": [{"id": "c1", "function": {"name": "list_skills", "arguments": "{坏 JSON"}}]},
                 {"content": "好了"}]

        asked = []

        def chat(messages, tools):
            asked.append(len(messages))
            return turns[len(asked) - 1]

        client = FakeClient({"list_skills": {"count": 0, "skills": []}})
        with mock.patch.object(agent, "_chat", chat):
            frames = _run(lambda emit: agent._run_agent(client, "列技能", emit, _runobj(client)))
        self.assertEqual(client.calls[0], ("list_skills", {}))
        self.assertEqual(frames[-1]["text"], "好了")

    def test_loop_hands_the_llm_function_shaped_tools(self):
        """右栏这条路的工具表在进 provider 之前换形：MCP 原样载荷会让 llama-server 整请求 500。"""
        turns = [{"content": "查一下状态",
                  "tool_calls": [{"id": "c1", "function": {"name": "neo_status", "arguments": "{}"}}]},
                 {"content": "服务在线"}]
        seen = []

        def chat(messages, tools):
            seen.append(list(tools))
            return turns[len(seen) - 1]

        client = FakeClient({"neo_status": {"neo_studio": "1"}})
        with mock.patch.object(agent, "_chat", chat):
            frames = _run(lambda emit: agent._run_agent(client, "在吗", emit, _runobj(client)))
        self.assertEqual([t["type"] for t in seen[0]], ["function"] * len(seen[0]))
        self.assertEqual(seen[0][0]["function"]["name"], "neo_status")
        self.assertEqual(seen[0][-1]["function"]["name"], "ask_user")   # 右栏伪工具排在 MCP 之后
        self.assertNotIn("inputSchema", seen[0][0])
        self.assertEqual(frames[-1]["text"], "服务在线")

    def test_turn_cap_says_what_was_tried(self):
        """轮次用满不能静默收场：兜底文案要说明跑了多少轮、下一步该怎么说。"""
        looping = {"content": "",
                   "tool_calls": [{"id": "c", "function": {"name": "neo_status", "arguments": "{}"}}]}
        client = FakeClient({"neo_status": {"neo_studio": "1"}})
        with mock.patch.object(agent, "_chat", lambda m, t: looping), \
             mock.patch.object(agent, "MAX_TURNS", 2):
            frames = _run(lambda emit: agent._run_agent(client, "随便看看", emit, _runobj(client)))
        self.assertEqual(frames[-1]["kind"], "content")
        self.assertIn("2 轮", frames[-1]["text"])



@skip
class TestReferenceInjection(unittest.TestCase):
    """本轮附件图默认作为参考图接进生成工具：出图进 generate_image 的 references，出片只进
    本轮新建配方的角色参考与段参考。模型显式给值（含 references: [] 这个纯文生图口径）以它为准。
    带参考图的出图是编辑那张图，技能收不收参考图归 generate_image 的 MCP 层判（见 test_mcp_server.py）。"""

    SRC = {"kind": "data", "data": "data:image/png;base64,QUJD"}

    def _fake_names(self):
        """替掉落盘边界：_reference_name 要真 input 目录，用例只要名字，也不该在测试里写文件。"""
        patch = mock.patch.object(agent, "_attachment_names",
                                  lambda srcs: [f"NeoAgent/ref_{i}.png" for i in range(len(srcs))])
        patch.start()
        self.addCleanup(patch.stop)

    def _apply(self, name, args, sources=(), recipes=(), char_dir=False):
        client = FakeClient({"director_recipes": {"recipes": list(recipes)}})
        run = agent._Run(client)
        run.image_sources = list(sources)
        run.character_dir = char_dir
        self._fake_names()
        asyncio.run(agent._apply_references(client, name, args, run))
        return args, client

    def test_generate_image_gets_the_attachments_as_references(self):
        args, _ = self._apply("generate_image", {"prompt": "橘猫"}, sources=(self.SRC,))
        self.assertEqual(args["references"], ["NeoAgent/ref_0.png"])

    def test_explicit_reference_list_wins_including_the_empty_one(self):
        """references: [] 是模型说的「这次纯文生图」，不能被附件顶掉；显式点名同理照原样。"""
        args, _ = self._apply("generate_image", {"references": []}, sources=(self.SRC,))
        self.assertEqual(args["references"], [])
        args, _ = self._apply("generate_image", {"references": ["own.png"]}, sources=(self.SRC,))
        self.assertEqual(args["references"], ["own.png"])

    def test_a_text_only_run_never_touches_the_reference_files(self):
        """没带附件就什么都不注入：纯问答的一轮不会往 input/NeoAgent/ 写参考文件。"""
        args, _ = self._apply("generate_image", {"prompt": "橘猫"})
        self.assertNotIn("references", args)
        self.assertNotIn("characters", args)

    def test_director_plan_characters_take_the_attachments_when_absent(self):
        args, _ = self._apply("director_plan", {"mode": "plan", "idea": "橘猫散步"}, sources=(self.SRC,))
        self.assertEqual(args["characters"], ["NeoAgent/ref_0.png"])
        args, _ = self._apply("director_plan", {"mode": "plan", "idea": "橘猫散步",
                                               "characters": ["mei.png"]}, sources=(self.SRC,))
        self.assertEqual(args["characters"], ["mei.png"])

    def test_segment_references_land_only_on_a_new_recipe(self):
        """段的参考集归配方拥有：本轮新建的配方补上附件参考，写已有配方一个字不改。"""
        fresh = [{"prompt": "橘猫走过街道"}, {"prompt": "橘猫抬头", "refs": {"images": ["own.png"]}}]
        args, client = self._apply("director_save", {"name": "新片", "segments": list(fresh)},
                                   sources=(self.SRC,))
        self.assertEqual(args["segments"][0]["refs"], {"images": ["NeoAgent/ref_0.png"]})
        self.assertEqual(args["segments"][1]["refs"], {"images": ["own.png"]})
        self.assertEqual(client.calls[0][0], "director_recipes")
        kept = [{"prompt": "橘猫走过街道"}]
        args, _ = self._apply("director_save", {"name": "cat_walk", "segments": list(kept)},
                              sources=(self.SRC,), recipes=[{"name": "cat_walk"}])
        self.assertNotIn("refs", args["segments"][0])

    def test_character_dir_new_recipe_defaults_to_full_reference(self):
        """角色图目录里基于附件图建的新配方走全参考，与画廊 ⋯ 菜单同一条口径：三视图当首帧
        会让视频从设定图开镜。图片参考也只有显式 r2v 才进模板——缺显式模式时后端按首/尾帧推模式，
        段里的图参考会连模式一起退成 t2v 丢掉。"""
        args, _ = self._apply("director_save", {"name": "新片", "segments": [{"prompt": "明朝人物", "duration_sec": 5}]},
                              sources=(self.SRC,), char_dir=True)
        self.assertEqual(args["shared"]["mode"], "r2v")
        self.assertEqual(args["segments"][0]["refs"], {"images": ["NeoAgent/ref_0.png"]})

    def test_the_mode_the_model_wrote_survives_the_full_reference_default(self):
        """注入只补模型没写的那一格：他自己写的 i2v 与 mixed 照原样，shared 里其余参数不动。"""
        args, _ = self._apply("director_save", {"name": "新片", "shared": {"mode": "i2v"},
                                                "segments": [{"first_frame": "a.png"}]},
                              sources=(self.SRC,), char_dir=True)
        self.assertEqual(args["shared"], {"mode": "i2v"})
        args, _ = self._apply("director_save", {"name": "新片", "shared": {"mode": "mixed", "width": 1280},
                                                "segments": [{"prompt": "明朝人物", "mode": "i2v"}]},
                              sources=(self.SRC,), char_dir=True)
        self.assertEqual(args["shared"], {"mode": "mixed", "width": 1280})

    def test_an_unmarked_directory_leaves_the_mode_to_the_model(self):
        """没标角色图的目录仍是每图一段、图作首帧：注入参考不替用户选模式。"""
        args, _ = self._apply("director_save", {"name": "新片", "segments": [{"first_frame": "a.png"}]},
                              sources=(self.SRC,))
        self.assertNotIn("shared", args)

    def test_an_existing_recipe_gets_no_full_reference_mode(self):
        """写已有配方一个字不改：连补 shared.mode 也不做，全参考是用户对已有配方的决定。"""
        args, _ = self._apply("director_save", {"name": "cat_walk", "segments": [{"prompt": "橘猫"}]},
                              sources=(self.SRC,), char_dir=True, recipes=[{"name": "cat_walk"}])
        self.assertNotIn("shared", args)

    def test_reference_names_resolve_once_per_run(self):
        """参考名按运行对象缓存：一条会话里连出两次图只落盘一次。"""
        client = FakeClient({"director_recipes": {"recipes": []}})
        run = agent._Run(client)
        run.image_sources = [self.SRC]
        names = mock.Mock(return_value=["NeoAgent/ref_0.png"])
        with mock.patch.object(agent, "_attachment_names", names):
            async def main():
                await agent._apply_references(client, "generate_image", {"prompt": "第一张"}, run)
                await agent._apply_references(client, "generate_image", {"prompt": "第二张"}, run)
            asyncio.run(main())
        self.assertEqual(names.call_count, 1)
        self.assertEqual(run.image_names, ["NeoAgent/ref_0.png"])

    def test_the_tool_card_shows_the_injected_reference(self):
        """注入要在发 tool_call 帧之前：时间线的工具卡上要看得见这次真用了哪些参考图。"""
        turns = [{"content": "先拆分段",
                  "tool_calls": [{"id": "c1", "function": {
                      "name": "director_plan", "arguments": json.dumps({"mode": "plan", "idea": "橘猫散步"})}}]},
                 {"content": "分好了"}]
        client = FakeClient({"director_plan": {"segments": [{"prompt": "橘猫散步", "duration_sec": 5}]}})
        run = agent._Run(client)
        run.image_sources = [self.SRC]
        self._fake_names()
        with mock.patch.object(agent, "_chat", lambda m, t: turns.pop(0)):
            frames = _run(lambda emit: agent._run_agent(client, "出个片", emit, run))
        self.assertIn("NeoAgent/ref_0.png", frames[1]["text"])
        self.assertEqual(client.calls[0][1]["characters"], ["NeoAgent/ref_0.png"])

    def test_plan_mode_injects_nothing(self):
        """计划模式本轮只查不跑：生成工具在边界就被拒，参数不该被改动。"""
        turns = [{"content": "先出计划",
                  "tool_calls": [{"id": "c1", "function": {
                      "name": "generate_image", "arguments": json.dumps({"prompt": "橘猫"})}}]},
                 {"content": "计划：先用 VDN 技能出 5 秒一段"}]
        client = FakeClient({"generate_image": {"task_id": "t1"}})
        run = agent._Run(client)
        run.image_sources = [self.SRC]
        self._fake_names()
        with mock.patch.object(agent, "_chat", lambda m, t: turns.pop(0)):
            frames = _run(lambda emit: agent._run_agent(client, "出图", emit, run, "plan"))
        self.assertNotIn("references", frames[1]["text"])
        self.assertTrue(frames[2]["text"].startswith("[error] 计划模式"))
        self.assertEqual(client.calls, [])


@skip
class TestRoutes(unittest.TestCase):
    @staticmethod
    def _req(body, valid_json=True):
        async def json():
            if not valid_json:
                raise ValueError("nope")
            return body
        return SimpleNamespace(json=json,
                               url=SimpleNamespace(host="127.0.0.1", port=8188, scheme="http"))

    def test_comfy_base_comes_from_the_request_url(self):
        """工具回指的 ComfyUI 由请求来源决定，请求体里没有地址可注入。"""
        self.assertEqual(agent.comfy_base(TestRoutes._req({})), "http://127.0.0.1:8188")

    def test_run_rejects_empty_text_before_streaming(self):
        resp = asyncio.run(agent.agent_run(TestRoutes._req({"text": "  "})))
        self.assertIn("[ERROR]", _data_lines(resp)[0])

    def test_run_rejects_non_json_body(self):
        resp = asyncio.run(agent.agent_run(TestRoutes._req({}, valid_json=False)))
        self.assertIn("[ERROR]", _data_lines(resp)[0])

    def test_run_streams_plan_tool_result_then_done(self):
        """一次请求换一路时间线：run 帧 → 计划 → 工具卡 → 结果 → 最终回答 → [DONE]。"""
        turns = [{"content": "先看状态",
                  "tool_calls": [{"id": "c1", "function": {"name": "neo_status", "arguments": "{}"}}]},
                 {"content": "服务在线"}]
        client = FakeClient({"neo_status": {"neo_studio": "1"}}, names=("neo_status",))
        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: client), \
             mock.patch.object(agent, "_chat", lambda m, t: turns.pop(0)):
            resp = asyncio.run(agent.agent_run(TestRoutes._req({"text": "橘猫"})))
            lines = _data_lines(resp)     # SSE 是惰性的：替掉的接缝要在收流之前还回去
        self.assertEqual(resp.headers["Content-Type"], "text/event-stream")
        self.assertEqual(json.loads(lines[1]), {"kind": "plan", "text": "先看状态"})
        self.assertEqual(json.loads(lines[3])["kind"], "tool_result")
        self.assertEqual(json.loads(lines[-2])["text"], "服务在线")
        self.assertEqual(lines[-1], "[DONE]")

    def test_run_reports_tool_failure_as_error_frame_then_done(self):
        """工具在流里炸掉不能把连接吊住：[ERROR] 之后必须补上 [DONE]。"""
        client = FakeClient({}, names=("neo_status",))
        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: client), \
             mock.patch.object(agent, "_chat",
                               side_effect=mcp.ToolError("技能不存在：skill_cat")):
            resp = asyncio.run(agent.agent_run(TestRoutes._req({"text": "橘猫"})))
            lines = _data_lines(resp)
        self.assertIn("[ERROR] 技能不存在：skill_cat", lines)
        self.assertEqual(lines[-1], "[DONE]")

    def test_run_injects_the_request_context_into_the_system_prompt(self):
        """请求体里的界面状态收净后进系统提示词；认不到的形态就当没有这一段。"""
        seen = []

        def chat(messages, tools):
            seen.append(messages[0]["content"])
            return {"content": "好了"}

        def run_with(body):
            with mock.patch.object(agent, "McpClient", lambda base, timeout=30:
                                   FakeClient({}, names=("neo_status",))), \
                 mock.patch.object(agent, "_chat", chat):
                resp = asyncio.run(agent.agent_run(TestRoutes._req(body)))
                _data_lines(resp)     # 收流才叫得到 LLM：不收流的话 chat 一次都不会跑

        run_with({"text": "出片", "context": {"page": "director", "recipe": "cat_walk", "segments": 2}})
        self.assertIn("当前导演配方：cat_walk · 2 段", seen[0])
        run_with({"text": "出片", "context": "not-a-dict"})
        self.assertNotIn("用户没说要换就不换", seen[1])   # 认不到的上下文形态就当没有这一段

    def test_run_makes_a_new_recipe_full_reference_in_a_character_directory(self):
        """请求体里的角色图标记一路走到参考注入：本轮新建的配方补上 shared.mode=r2v，
        与画廊 👤 目录卡片菜单的「🎬 新建导演配方（全参考）」同一条口径。"""
        turns = [{"content": "建配方", "tool_calls": [{"id": "c1", "function": {
            "name": "director_save",
            "arguments": json.dumps({"name": "明朝人物",
                                     "segments": [{"prompt": "明朝人物立于城楼", "duration_sec": 5}]})}}]},
            {"content": "配方已保存"}]
        client = FakeClient({"director_recipes": {"recipes": []},
                             "director_save": {"success": True, "name": "明朝人物"}},
                            names=("director_save",))
        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: client), \
             mock.patch.object(agent, "_resolve_images", lambda raw: [b"png-bytes"]), \
             mock.patch.object(agent, "_attachment_names", lambda srcs: ["NeoAgent/ref_0.png"]), \
             mock.patch.object(agent, "_chat", lambda m, t: turns.pop(0)):
            resp = asyncio.run(agent.agent_run(TestRoutes._req({
                "text": "照这张设定图出个片",
                "images": [{"kind": "input", "filename": "明朝人物.png"}],
                "context": {"page": "gallery", "gallery_path": "Cloud Presets/明朝人物",
                            "character_dir": True}})))
            _data_lines(resp)
        saved = [a for n, a in client.calls if n == "director_save"][0]
        self.assertEqual(saved["shared"]["mode"], "r2v")
        self.assertEqual(saved["segments"][0]["refs"], {"images": ["NeoAgent/ref_0.png"]})

    def test_cancel_rejects_non_uuid_task_id(self):
        """task_id 会被拼进 cancel 路由的路径段，路径穿越形态必须在入口挡掉。"""
        resp = asyncio.run(agent.agent_cancel(TestRoutes._req({"task_id": "../secret"})))
        self.assertEqual(resp.status, 400)
        self.assertIn("task_id", json.loads(resp.text)["error"])

    def test_cancel_calls_mcp_cancel_task(self):
        calls = []

        class Client:
            def call(self, name, args):
                calls.append((name, args))
                return json.dumps({"kind": "director", "task_id": args["task_id"],
                                   "status": "cancelled"})

        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: Client()):
            resp = asyncio.run(agent.agent_cancel(
                TestRoutes._req({"task_id": "6f1c2a34-9b7c-4d0a-8e11-2f3a4b5c6d7e"})))
        data = json.loads(resp.text)
        self.assertTrue(data["success"])
        self.assertEqual(data["kind"], "director")
        self.assertEqual(calls, [("cancel_task",
                                  {"task_id": "6f1c2a34-9b7c-4d0a-8e11-2f3a4b5c6d7e"})])

    def test_cancel_reports_missing_task_as_404(self):
        class Client:
            def call(self, name, args):
                raise mcp.ToolError(f"任务不存在：{args['task_id']}")

        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: Client()):
            resp = asyncio.run(agent.agent_cancel(
                TestRoutes._req({"task_id": "6f1c2a34-9b7c-4d0a-8e11-2f3a4b5c6d7e"})))
        self.assertEqual(resp.status, 404)
        self.assertIn("任务不存在", json.loads(resp.text)["error"])


@skip
class TestSessionStore(unittest.TestCase):
    """会话落盘与续聊：一次运行一个 JSON 在数据根的 agent_sessions/，列表只读摘要，
    续聊把落下来的 messages 接在系统提示词之后。conftest 已把数据根钉在临时目录。"""

    @staticmethod
    def _req(body, query=None):
        async def json():
            return body
        return SimpleNamespace(json=json, query=query or {},
                               url=SimpleNamespace(host="127.0.0.1", port=8188, scheme="http"))

    def setUp(self):
        _clear_sessions()
        self.addCleanup(_clear_sessions)

    def _one_run(self, body, turns, replies=None, names=("neo_status",)):
        """走一遍 /neo_agent/run 并收干净，返回 (SSE 行, 这次运行的 run_id)。"""
        client = FakeClient(replies or {"neo_status": {"neo_studio": "1"}}, names=names)
        queue = list(turns)
        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: client), \
             mock.patch.object(agent, "_chat", lambda m, t: queue.pop(0)):
            lines = _drive(agent.agent_run(self._req(body)))
        return lines, json.loads(lines[0])["run_id"]

    def test_run_persists_one_session_file_with_the_timeline(self):
        """一次运行落一个文件：时间线逐帧、终态、输入与界面状态都在，参数按展示裁剪。"""
        args = json.dumps({"prompt": "橘猫 " * 120}, ensure_ascii=False)
        turns = [{"content": "先看状态",
                  "tool_calls": [{"id": "c1", "function": {"name": "neo_status", "arguments": args}}]},
                 {"content": "服务在线"}]
        lines, run_id = self._one_run(
            {"text": "橘猫出片", "context": {"page": "director", "recipe": "cat_walk", "segments": 2}}, turns)
        self.assertEqual(lines[-1], "[DONE]")
        path, rec = _saved_one()
        self.assertIn(run_id, path.name)
        self.assertTrue(agent.SESSION_FILE_RE.match(path.name))
        self.assertEqual(rec["run_id"], run_id)
        self.assertEqual(rec["status"], "succeeded")
        self.assertEqual(rec["mode"], "act")
        self.assertEqual(_kinds(rec["frames"]), ["plan", "tool_call", "tool_result", "content"])
        self.assertEqual(rec["input"]["text"], "橘猫出片")
        self.assertIn("cat_walk · 2 段", rec["input"]["context"])
        self.assertLessEqual(len(rec["frames"][1]["text"]), agent.ARGS_CLIP + 1)

    def test_saved_session_drops_the_preview_frames(self):
        """预览载荷只给界面：base64 帧写进会话文件，一步就能把 SESSION_FILE_MAX 顶满。"""
        async def noop(_s):
            return None

        turns = [{"content": "跑整片",
                  "tool_calls": [{"id": "c1", "function": {"name": "director_run",
                                                           "arguments": "{\"recipe\": \"r\"}"}}]},
                 {"content": "出好了"}]
        replies = {"director_run": {"task_id": "f-1"},
                   "task_status": [{"status": "running"},
                                   {"status": "succeeded", "filename": "NeoDirector/a.mp4"}]}
        prev = {"frames": ["data:image/jpeg;base64," + "AA" * 4000], "step": 1}
        with mock.patch.object(agent, "_preview_of", lambda *a: prev), \
             mock.patch.object(agent.asyncio, "sleep", noop):
            lines, _ = self._one_run({"text": "出片"}, turns, replies, names=("director_run",))
        frames = [json.loads(x) for x in lines[1:] if x != "[DONE]"]
        self.assertTrue([f for f in frames if f["kind"] == "status" and "preview" in f],
                        "界面这一路要拿得到预览帧")
        path, rec = _saved_one()
        self.assertFalse([f for f in rec["frames"] if "preview" in f])
        self.assertNotIn("base64,", path.read_text(encoding="utf-8"))

    def test_saved_session_carries_no_image_bytes_and_no_system_prompt(self):
        """落盘不带 base64 图字节，也不带 system 提示词：文件里已是用户提示词与本机路径，
        再灌一堆图字节只会把这一份撑到读不动，续聊的 system 由当时的 mode 重生成。"""
        msgs = [{"role": "system", "content": "系统提示词" * 400},
                {"role": "user", "content": [{"type": "image_url",
                                              "image_url": {"url": "data:image/png;base64," + "AA" * 9000}},
                                             {"type": "text", "text": "看这张图" * 3000}]},
                {"role": "assistant", "content": "看图说话" * 3000,
                 "tool_calls": [{"id": "c1", "function": {"name": "neo_status", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": "c1", "content": "结果"}]
        out = agent._stored_messages(msgs)
        text = json.dumps(out, ensure_ascii=False)
        self.assertNotIn("base64,", text)
        self.assertNotIn("系统提示词", text)
        self.assertEqual([m["role"] for m in out], ["user", "assistant", "tool"])
        self.assertIn("附件图 1 张", out[0]["content"])
        self.assertTrue(all(len(m["content"]) <= agent.RESUME_MSG_CLIP + 1 for m in out))
        self.assertEqual(out[2]["tool_call_id"], "c1")
        self.assertEqual(out[1]["tool_calls"][0]["function"]["name"], "neo_status")
        agent._save_session(_fake_run(None, messages=msgs))
        self.assertNotIn("base64,", _saved_one()[0].read_text(encoding="utf-8"))

    def test_saved_history_is_capped_at_the_recent_tail(self):
        long = [{"role": "user", "content": f"第 {i} 句 " + "字" * 5000}
                for i in range(agent.RESUME_MSG_MAX + 12)]
        out = agent._stored_messages(long)
        self.assertEqual(len(out), agent.RESUME_MSG_MAX)
        self.assertEqual(out[-1]["content"].split(" ")[1], str(agent.RESUME_MSG_MAX + 11))

    def test_resume_feeds_the_saved_history_to_the_llm(self):
        """续聊把落下来的原文接回 LLM：系统提示词在最前，旧对话在中间，新的一句在最后。"""
        turns = [{"content": "先看状态",
                  "tool_calls": [{"id": "c1", "function": {"name": "neo_status", "arguments": "{}"}}]},
                 {"content": "服务在线"}]
        _, run_id = self._one_run({"text": "橘猫出片"}, turns)
        seen = []

        def chat(messages, tools):
            seen.append(list(messages))
            return {"content": "好，第二段换慢一点"}

        client = FakeClient({"neo_status": {"neo_studio": "1"}}, names=("neo_status",))
        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: client), \
             mock.patch.object(agent, "_chat", chat):
            _drive(agent.agent_run(self._req({"text": "把第二段换慢一点", "resume": run_id})))
        first = seen[0]
        self.assertEqual([m["role"] for m in first],
                         ["system", "user", "assistant", "tool", "assistant", "user"])
        self.assertIn("橘猫出片", first[1]["content"])
        self.assertIn("服务在线", first[4]["content"])
        self.assertEqual(first[-1]["content"], "把第二段换慢一点")
        # 续出来的这一轮自己也是一个新会话：接的是谁记在 resume_of 里
        _, rec = _saved_top()
        self.assertEqual(rec["resume_of"], run_id)
        self.assertEqual(len(agent._session_files()), 2)

    def test_resume_regenerates_the_system_prompt_from_the_current_turn(self):
        """续聊不带旧的 system：换到计划模式、换了界面状态，系统提示词按这一次重生成。"""
        _, run_id = self._one_run({"text": "橘猫出片"}, [{"content": "服务在线"}])
        seen = []
        client = FakeClient({"neo_status": {"neo_studio": "1"}}, names=("neo_status",))

        def chat(messages, tools):
            seen.append(messages)
            return {"content": "计划如下"}

        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: client), \
             mock.patch.object(agent, "_chat", chat):
            _drive(agent.agent_run(self._req({"text": "先给计划", "mode": "plan", "resume": run_id,
                                              "context": {"page": "director", "recipe": "cat_walk",
                                                          "segments": 2}})))
        self.assertIn(agent.PLAN_MODE_NOTE, seen[0][0]["content"])
        self.assertIn("当前导演配方：cat_walk · 2 段", seen[0][0]["content"])

    def test_resume_rejects_a_run_that_is_still_going(self):
        """还在跑的循环不能被第二条请求同时接上：那一轮的 messages 正被循环改着。"""
        live = _runobj(FakeClient({}))
        agent._RUNS[live.run_id] = live
        try:
            client = FakeClient({"neo_status": {"neo_studio": "1"}}, names=("neo_status",))
            with mock.patch.object(agent, "McpClient", lambda base, timeout=30: client), \
                 mock.patch.object(agent, "_chat", lambda m, t: {"content": "不该跑到 LLM"}):
                lines = _drive(agent.agent_run(self._req({"text": "续一下", "resume": live.run_id})))
        finally:
            agent._RUNS.pop(live.run_id, None)
        self.assertIn("[ERROR] 这次运行还在跑，不能同时续", lines)
        self.assertEqual(lines[-1], "[DONE]")

    def test_resume_rejects_malformed_and_missing_run_id(self):
        """resume 的 run_id 会拼进会话文件名的匹配段：畸形形态在入口挡掉，查不到就说没有。"""
        for resume in ("../secret", "Z" * 32, "0" * 32):
            client = FakeClient({"neo_status": {"neo_studio": "1"}}, names=("neo_status",))
            with mock.patch.object(agent, "McpClient", lambda base, timeout=30: client), \
                 mock.patch.object(agent, "_chat", lambda m, t: {"content": "不该跑到 LLM"}):
                lines = _drive(agent.agent_run(self._req({"text": "续一下", "resume": resume})))
            self.assertIn("[ERROR]", lines[0])
            self.assertEqual(lines[-1], "[DONE]")

    def test_a_huge_run_drops_the_oldest_turns_then_the_timeline(self):
        """一次大结果能把文件撑到几兆：先从最旧消息丢起，还超就只留最终回答——
        接得上上下文的最后几轮比完整历史与整条时间线更值钱。"""
        run = _fake_run(
            None,
            frames=[{"kind": "tool_result", "text": "结" * 100_000} for _ in range(8)]
                   + [{"kind": "content", "text": "最终回答"}],
            messages=[{"role": "user", "content": "问" * 3900} for _ in range(30)]
                     + [{"role": "assistant", "content": "答"}])
        agent._save_session(run)
        path, rec = _saved_one()
        self.assertLessEqual(len(path.read_text(encoding="utf-8")), agent.SESSION_FILE_MAX)
        self.assertEqual(_kinds(rec["frames"]), ["content"])
        self.assertEqual(rec["messages"], [{"role": "assistant", "content": "答"}])

    def test_session_list_is_newest_first_with_a_compact_summary(self):
        now = time.time()
        for i, (tools, mode) in enumerate([(1, "act"), (0, "plan"), (2, "act")]):
            agent._save_session(_fake_run(
                None, text=f"第 {i} 次", created=now - 10 * (i + 1), mode=mode,
                frames=[{"kind": "tool_call", "tool": "neo_status", "text": "{}"}] * tools
                       + [{"kind": "content", "text": "好了"}]))
        for s in agent._list_sessions():    # 三条在同一毫秒里落盘：把落盘时间钉回各自的创建时间
            stamp = s["created"]
            os.utime(agent._session_of(s["run_id"]), (stamp, stamp))
        out = agent._list_sessions()
        self.assertEqual([s["text"] for s in out], ["第 0 次", "第 1 次", "第 2 次"])
        self.assertEqual([s["tools"] for s in out], [1, 0, 2])
        self.assertEqual(out[1]["mode"], "plan")

    def test_session_list_drops_the_expired_one(self):
        """过期只看落盘时间：七天前的那次不再进列表，历史页不会一年比一年长。"""
        agent._save_session(_fake_run(None, text="上周的", created=time.time() - 10))
        agent._save_session(_fake_run(None, text="今天的"))
        stale_id = [s["run_id"] for s in agent._list_sessions() if s["text"] == "上周的"][0]
        old = time.time() - agent.SESSION_TTL_SEC - 3600
        os.utime(agent._session_of(stale_id), (old, old))     # 不用真等七天：改落盘时间就是过期
        self.assertEqual([s["text"] for s in agent._list_sessions()], ["今天的"])

    def test_overflow_prune_keeps_the_newest(self):
        with mock.patch.object(agent, "MAX_SESSIONS", 3):
            for i in range(5):
                agent._save_session(_fake_run(None, text=f"第 {i} 次", created=time.time() - 10 * (5 - i)))
            self.assertEqual([s["text"] for s in agent._list_sessions()],
                             ["第 4 次", "第 3 次", "第 2 次"])
        self.assertEqual(len(agent._session_files()), 3)

    def test_delete_touches_only_the_session_files_it_wrote(self):
        """删一条只动那一个文件，清空只动按名字认出来的会话文件：用户丢进这目录的
        别的文件与目录本身一律不碰。"""
        agent._save_session(_fake_run(None, text="留着的", created=time.time() - 60))
        agent._save_session(_fake_run(None, text="要删的"))
        keep = agent.AGENT_SESSIONS_DIR / "keep.json"
        keep.write_text("{}", encoding="utf-8")
        note = agent.AGENT_SESSIONS_DIR / "note.txt"
        note.write_text("用户自己的文件", encoding="utf-8")
        target = [s for s in agent._list_sessions() if s["text"] == "要删的"][0]["run_id"]
        self.assertEqual(agent._delete_sessions(target), 1)
        self.assertEqual([s["text"] for s in agent._list_sessions()], ["留着的"])
        self.assertEqual(agent._delete_sessions(target), 0)      # 已经删掉的不再报删成功
        self.assertTrue(keep.exists() and note.exists())
        agent._save_session(_fake_run(None, text="再来一次"))
        self.assertEqual(agent._delete_sessions(), 2)
        self.assertEqual(agent._list_sessions(), [])
        self.assertTrue(keep.exists() and note.exists()
                        and agent.AGENT_SESSIONS_DIR.is_dir())

    def test_a_half_written_session_file_does_not_break_the_list(self):
        """写盘中途断电 / 磁盘写满留下的半截 JSON：不进列表也不参与续聊，收掉，
        别让下一次列历史整页跟着炸。"""
        broken = agent.AGENT_SESSIONS_DIR / ("20260101-000000-" + "0" * 32 + ".json")
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text('{"run_id": "0', encoding="utf-8")
        self.assertEqual(agent._list_sessions(), [])
        self.assertFalse(broken.exists())

    def test_abort_mid_stream_still_leaves_a_session_record(self):
        """前端关页面时这一路 SSE 正被关掉，落盘挂成后台任务：半途收场的运行也要在历史里
        留下这一条，终态落 interrupted，看得见它没跑完。"""
        run = _runobj(FakeClient({"neo_status": {"neo_studio": "1"}}, names=("neo_status",)))
        saved: list = []
        real = asyncio.create_task

        def capture(c):
            task = real(c)
            saved.append(task)
            return task

        async def abort():
            agen = agent._events(run, "橘猫")
            await agen.__anext__()
            await agen.aclose()
            for task in saved:
                await task

        with mock.patch.object(agent.asyncio, "create_task", capture):
            asyncio.run(abort())
        _, rec = _saved_one()
        self.assertEqual(rec["status"], "interrupted")
        self.assertEqual(rec["run_id"], run.run_id)
        self.assertEqual(rec["frames"], [])

    def test_tool_error_run_is_marked_failed(self):
        client = FakeClient({}, names=("neo_status",))
        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: client), \
             mock.patch.object(agent, "_chat", mock.Mock(side_effect=mcp.ToolError("技能不存在：skill_cat"))):
            lines = _drive(agent.agent_run(self._req({"text": "橘猫"})))
        self.assertIn("[ERROR] 技能不存在：skill_cat", lines)
        _, rec = _saved_one()
        self.assertEqual(rec["status"], "failed")

    def test_sessions_route_lists_summaries(self):
        _, run_id = self._one_run({"text": "橘猫出片"}, [{"content": "好了"}])
        data = json.loads(asyncio.run(agent.agent_sessions(self._req({}))).text)
        self.assertTrue(data["ok"])
        self.assertEqual([s["run_id"] for s in data["sessions"]], [run_id])
        self.assertEqual(data["sessions"][0]["text"], "橘猫出片")
        self.assertEqual(data["sessions"][0]["status"], "succeeded")

    def test_session_route_reads_the_timeline_back(self):
        _, run_id = self._one_run({"text": "橘猫出片"}, [{"content": "好了"}])
        data = json.loads(asyncio.run(agent.agent_session(self._req({}, {"run_id": run_id}))).text)
        self.assertEqual(_kinds(data["session"]["frames"]), ["content"])
        self.assertEqual([m["role"] for m in data["session"]["messages"]], ["user", "assistant"])

    def test_session_route_rejects_bad_and_missing_run_id(self):
        bad = asyncio.run(agent.agent_session(self._req({}, {"run_id": "../secret"})))
        self.assertEqual(bad.status, 400)
        self.assertEqual(asyncio.run(agent.agent_session(self._req({}, {"run_id": "0" * 32}))).status, 404)
        self.assertEqual(asyncio.run(agent.agent_session(self._req({}, {}))).status, 400)

    def test_session_delete_routes(self):
        _, run_id = self._one_run({"text": "橘猫出片"}, [{"content": "好了"}])
        self.assertEqual(asyncio.run(agent.agent_session_delete(self._req({"run_id": "zz"}))).status, 400)
        self.assertEqual(asyncio.run(agent.agent_session_delete(self._req({"run_id": "0" * 32}))).status, 404)
        ok = asyncio.run(agent.agent_session_delete(self._req({"run_id": run_id})))
        self.assertEqual(json.loads(ok.text)["deleted"], 1)
        self.assertEqual(agent._list_sessions(), [])
        self._one_run({"text": "再来一次"}, [{"content": "好了"}])
        alls = asyncio.run(agent.agent_session_delete_all(self._req({})))
        self.assertEqual(json.loads(alls.text)["deleted"], 1)
        self.assertEqual(agent._list_sessions(), [])


@skip
class TestCancellation(unittest.TestCase):
    def test_stop_before_the_first_turn_never_calls_the_llm(self):
        """停止位在轮次边界生效：置起后一次 LLM 都不该叫，末帧说明这一路已停。"""
        client = FakeClient({"neo_status": {"neo_studio": "1"}})
        run = _runobj(client)
        run.stop.set()
        with mock.patch.object(agent, "_chat",
                               side_effect=AssertionError("取消后不该再叫 LLM")):
            frames = _run(lambda emit: agent._run_agent(client, "随便看看", emit, run))
        self.assertEqual(frames, [{"kind": "content", "text": agent.CANCELLED_TEXT}])
        self.assertEqual(client.calls, [])

    def test_stop_during_a_tool_call_skips_the_next_turn(self):
        """取消落在第一轮工具在飞时：工具结果照发，其后不再叫第二轮 LLM。"""
        turns = [{"content": "",
                  "tool_calls": [{"id": "c1", "function": {"name": "neo_status", "arguments": "{}"}}]},
                 {"content": "第二轮"}]
        asked = []
        client = FakeClient({"neo_status": {"neo_studio": "1"}})
        run = _runobj(client)

        def chat(messages, tools):
            asked.append(len(messages))
            if len(asked) == 1:
                run.stop.set()
            return turns[len(asked) - 1]

        with mock.patch.object(agent, "_chat", chat):
            frames = _run(lambda emit: agent._run_agent(client, "在吗", emit, run))
        self.assertEqual(len(asked), 1)
        self.assertEqual(_kinds(frames), ["tool_call", "tool_result", "content"])
        self.assertEqual(frames[-1]["text"], agent.CANCELLED_TEXT)

    def test_stop_during_poll_cancels_the_running_task(self):
        """轮询边界取消：按 task_id 走 cancel_task，任务按 cancelled 终态交回，运行对象上不留任务。"""
        client = FakeClient({"generate_image": {"task_id": "t-9"},
                             "task_status": {"status": "running"},
                             "cancel_task": {"kind": "image", "status": "cancelled"}})
        run = _runobj(client)
        run.stop.set()
        with _no_poll_sleep():
            payload, frames = _result(lambda emit: agent._tool_result(
                client, "generate_image", {"prompt": "x"}, emit, run))
        self.assertEqual(json.loads(payload)["status"], "cancelled")
        self.assertIn(("cancel_task", {"task_id": "t-9"}), client.calls)
        self.assertEqual(run.task_id, "")
        self.assertEqual(frames[0]["task_id"], "t-9")

    def test_cancel_route_stops_the_run_and_its_task(self):
        """run_id 取消：置停止位并掐掉在跑的任务，回带 task_id 让前端知道掐了什么。"""
        calls = []

        class Client:
            def call(self, name, args):
                calls.append((name, args))
                return json.dumps({"status": "cancelled"})

        run = agent._Run(Client())
        run.task_id = "6f1c2a34-9b7c-4d0a-8e11-2f3a4b5c6d7e"
        agent._RUNS[run.run_id] = run
        try:
            resp = asyncio.run(agent.agent_cancel(TestRoutes._req({"run_id": run.run_id})))
        finally:
            agent._RUNS.pop(run.run_id, None)
        self.assertTrue(json.loads(resp.text)["success"])
        self.assertTrue(run.stop.is_set())
        self.assertEqual(calls, [("cancel_task", {"task_id": run.task_id})])

    def test_cancel_route_rejects_unknown_and_malformed_run_id(self):
        """run_id 只认后端发过的形态：查不到是 404，路径穿越形态在入口就挡掉。"""
        resp = asyncio.run(agent.agent_cancel(TestRoutes._req({"run_id": "0" * 32})))
        self.assertEqual(resp.status, 404)
        resp = asyncio.run(agent.agent_cancel(TestRoutes._req({"run_id": "../secret"})))
        self.assertEqual(resp.status, 400)
        self.assertIn("run_id", json.loads(resp.text)["error"])

    def test_run_frame_carries_run_id_and_the_table_empties_after(self):
        """首帧带 run_id，前端的停止键才有得发；整条流收场后取消表必须空，不跨请求留状态。"""
        client = FakeClient({}, names=("neo_status",))
        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: client), \
             mock.patch.object(agent, "_chat", lambda m, t: {"content": "好了"}):
            resp = asyncio.run(agent.agent_run(TestRoutes._req({"text": "橘猫"})))
            lines = _data_lines(resp)
        first = json.loads(lines[0])
        self.assertEqual(first["kind"], "run")
        self.assertTrue(agent.RUN_ID_RE.match(first["run_id"]))
        self.assertEqual(agent._RUNS, {})

    def test_pump_cancels_the_worker_when_the_consumer_goes_away(self):
        """前端 abort 时 aiohttp 关掉这个生成器：worker 必须被 cancel，不能在后台跑完轮次。"""
        async def main():
            async def loop(emit):
                await emit({"kind": "status", "text": "running"})
                await asyncio.sleep(3600)
            gen = agent._pump(loop)
            first = await gen.__anext__()
            await gen.aclose()
            await asyncio.sleep(0)
            left = [t for t in asyncio.all_tasks()
                    if t is not asyncio.current_task() and not t.done()]
            return first, left
        first, left = asyncio.run(main())
        self.assertEqual(first["kind"], "status")
        self.assertEqual(left, [])


@skip
class TestPlanMode(unittest.TestCase):
    def test_plan_mode_drops_state_changing_tools(self):
        """计划模式里模型看不见写操作工具就不会去调：查询类照旧全在，执行模式一张表不少。"""
        act = [t["function"]["name"] for t in agent._openai_tools(mcp.TOOLS)]
        plan = [t["function"]["name"] for t in agent._openai_tools(mcp.TOOLS, plan=True)]
        self.assertIn("generate_image", act)
        self.assertIn("director_run", act)
        self.assertEqual(set(act) - set(plan), set(agent.PLAN_BLOCKED_TOOLS))
        self.assertIn("neo_status", plan)
        self.assertIn("director_spec", plan)

    def test_plan_mode_note_lands_in_the_system_prompt(self):
        self.assertIn("本轮是计划模式", agent.system_prompt("plan"))
        self.assertNotIn("本轮是计划模式", agent.system_prompt())

    def test_plan_mode_refuses_a_write_call_at_the_boundary(self):
        """模型硬调写操作：不发 MCP，拒回原文，让 LLM 拿着错误改口去写计划。"""
        client = FakeClient({"neo_status": {"ok": True}}, names=("neo_status", "generate_image"))
        turns = [
            {"content": "先看一眼", "tool_calls": [{"id": "1", "function": {
                "name": "generate_image",
                "arguments": json.dumps({"skill_id": "skill_cat", "prompt": "橘猫"})}}]},
            {"content": "计划：切到执行模式后跑 generate_image"},
        ]

        def chat(messages, tools):
            return turns.pop(0)

        with mock.patch.object(agent, "_chat", chat):
            frames = _run(lambda emit: agent._run_agent(
                client, "出图", emit, _runobj(client), "plan"))
        self.assertEqual(client.calls, [], "计划模式不许把任务交进 ComfyUI")
        self.assertIn("计划模式不执行 generate_image",
                      [f for f in frames if f["kind"] == "tool_result"][0]["text"])
        self.assertEqual(frames[-1]["text"], "计划：切到执行模式后跑 generate_image")


@skip
class TestAskUser(unittest.TestCase):
    def test_ask_user_is_a_dock_only_tool(self):
        """ask_user 是右栏伪工具：MCP 注册表里没有它，交给 LLM 的工具表里才有。"""
        self.assertNotIn("ask_user", [t["name"] for t in mcp.TOOLS])
        seen = []

        def chat(messages, tools):
            seen.append([t["function"]["name"] for t in tools])
            return {"content": "好"}

        client = FakeClient({}, names=("neo_status",))
        with mock.patch.object(agent, "_chat", chat):
            _run(lambda emit: agent._run_agent(client, "在吗", emit, _runobj(client)))
        self.assertIn("ask_user", seen[0])
        self.assertNotIn("ask_user", [t["name"] for t in client.tool_list()])

    def test_ask_user_parks_the_loop_until_the_answer_arrives(self):
        """ask_user 不发 MCP：循环发 ask 帧就挂在等回答上，答案回来才走下一轮。"""
        client = FakeClient({}, names=("neo_status",))
        turns = [
            {"content": "", "tool_calls": [{"id": "a1", "function": {
                "name": "ask_user",
                "arguments": json.dumps({"question": "要哪种结尾？",
                                         "options": ["淡出", "定格"]}, ensure_ascii=False)}}]},
            {"content": "按淡出出片"},
        ]

        def chat(messages, tools):
            return turns.pop(0)

        run = agent._Run(client)

        async def main():
            frames = []

            async def emit(frame):
                frames.append(frame)
                if frame["kind"] == "ask":
                    # 回答要发生在循环还挂着的时候，等同前端点选项的时机
                    run.asks[frame["ask_id"]]["text"] = "淡出"
                    run.asks[frame["ask_id"]]["event"].set()

            with mock.patch.object(agent, "_chat", chat):
                await agent._run_agent(client, "出个片", emit, run)
            return frames

        frames = asyncio.run(main())
        ask = [f for f in frames if f["kind"] == "ask"][0]
        self.assertEqual(ask["text"], "要哪种结尾？")
        self.assertEqual(ask["options"], ["淡出", "定格"])
        self.assertTrue(agent.ASK_ID_RE.match(ask["ask_id"]))
        self.assertEqual([f for f in frames if f["kind"] == "tool_result"][0]["text"], "淡出")
        self.assertEqual(frames[-1]["text"], "按淡出出片")
        self.assertEqual(client.calls, [], "ask_user 不该走 MCP")
        self.assertEqual(run.asks, {}, "问句收场后不留挂起点")

    def test_answer_route_wakes_the_parked_question(self):
        run = agent._Run(object())
        ask_id = "0" * 32
        run.asks[ask_id] = {"event": asyncio.Event(), "text": ""}
        agent._RUNS[run.run_id] = run
        try:
            resp = asyncio.run(agent.agent_answer(TestRoutes._req(
                {"run_id": run.run_id, "ask_id": ask_id, "text": " 淡出 "})))
        finally:
            agent._RUNS.pop(run.run_id, None)
        self.assertEqual(resp.status, 200)
        self.assertTrue(run.asks[ask_id]["event"].is_set())
        self.assertEqual(run.asks[ask_id]["text"], "淡出")

    def test_answer_route_rejects_bad_ids_and_finished_runs(self):
        """run_id / ask_id 只认后端发过的形态；空回答与认不到的运行都在入口挡掉。"""
        good = "0" * 32
        for body, why in [({"run_id": "../secret", "ask_id": good, "text": "a"}, "run_id 形态"),
                          ({"run_id": good, "ask_id": "../secret", "text": "a"}, "ask_id 形态"),
                          ({"run_id": good, "ask_id": good, "text": "  "}, "空回答")]:
            self.assertEqual(asyncio.run(agent.agent_answer(TestRoutes._req(body))).status, 400, why)
        self.assertEqual(asyncio.run(agent.agent_answer(TestRoutes._req(
            {"run_id": good, "ask_id": good, "text": "a"}))).status, 404, "运行已经收场")
        run = agent._Run(object())
        agent._RUNS[run.run_id] = run
        try:
            self.assertEqual(asyncio.run(agent.agent_answer(TestRoutes._req(
                {"run_id": run.run_id, "ask_id": "1" * 32, "text": "a"}))).status, 404, "问句已经收场")
        finally:
            agent._RUNS.pop(run.run_id, None)

    def test_cancel_settles_a_parked_question(self):
        """取消点在问句挂着的时候按下去：循环不能卡在 await 上等用户。"""
        run = agent._Run(object())
        ask_id = "2" * 32
        run.asks[ask_id] = {"event": asyncio.Event(), "text": ""}
        agent._RUNS[run.run_id] = run
        try:
            resp = asyncio.run(agent.agent_cancel(TestRoutes._req({"run_id": run.run_id})))
        finally:
            agent._RUNS.pop(run.run_id, None)
        self.assertTrue(json.loads(resp.text)["success"])
        self.assertTrue(run.asks[ask_id]["event"].is_set())
        self.assertIn("取消", run.asks[ask_id]["text"])


@skip
class TestAttachments(unittest.TestCase):
    def test_attachments_enter_the_first_user_message_only(self):
        """附件图按多模态形状进首个 user 消息；后续轮次靠历史文本走，不逐轮重灌 base64。"""
        seen = []
        client = FakeClient({"neo_status": {"ok": True}}, names=("neo_status",))
        turns = [
            {"content": "先看现状", "tool_calls": [{"id": "1", "function": {
                "name": "neo_status", "arguments": "{}"}}]},
            {"content": "图里是一只橘猫"},
        ]

        def chat(messages, tools):
            seen.append([dict(m) for m in messages])
            return turns.pop(0)

        with mock.patch.object(agent, "_chat", chat):
            frames = _run(lambda emit: agent._run_agent(
                client, "这张图能做什么", emit, _runobj(client), "act", [b"png-bytes"]))
        first = seen[0][1]
        self.assertIsInstance(first["content"], list, "带图的 user 消息应是多个内容块")
        self.assertEqual(first["content"][0]["image_url"]["url"],
                         "data:image/png;base64," + base64.b64encode(b"png-bytes").decode("ascii"))
        self.assertEqual(first["content"][-1], {"type": "text", "text": "这张图能做什么"})
        self.assertEqual(len([m for m in seen[1]
                              if m["role"] == "user" and isinstance(m["content"], list)]), 1,
                         "第二轮里带图的应当只有那一条 user 消息")
        self.assertEqual(client.calls, [("neo_status", {})])
        self.assertEqual(frames[-1]["text"], "图里是一只橘猫")

    def test_resolve_images_caps_count_and_skips_non_sources(self):
        """附件图按 prompts 的图片源口径解析，张数收在 MAX_IMAGES 内，非图片源项跳过。"""
        fake = SimpleNamespace(resolve_image_bytes=lambda src, **kw:
                               b"x" if src.get("kind") == "data" else None)
        with mock.patch.dict(sys.modules, {"studio.prompts": fake}):
            self.assertEqual(len(agent._resolve_images(
                [{"kind": "data"}] * 20 + ["str", 3, None])), agent.MAX_IMAGES)
            self.assertEqual(agent._resolve_images([]), [])


@skip
class TestPauseResume(unittest.TestCase):
    def test_pause_parks_the_loop_at_the_turn_boundary(self):
        """暂停落在轮次边界：发 paused 帧挂在「继续」上，放开后照旧跑完这一轮，不多叫一次 LLM。"""
        client = FakeClient({}, names=("neo_status",))
        run = _runobj(client)
        run.pause.set()
        run.resume.set()      # 「继续」先到：检查点收帧、清暂停、发 resumed，然后才叫 LLM
        with mock.patch.object(agent, "_chat", lambda m, t: {"content": "好了"}):
            frames = _run(lambda emit: agent._run_agent(client, "在吗", emit, run))
        self.assertEqual(_kinds(frames), ["paused", "resumed", "content"])
        self.assertFalse(run.pause.is_set())

    def test_pause_at_the_poll_boundary_cancels_the_task_and_never_resends(self):
        """轮询边界暂停：在飞任务按 cancel_task 收掉、交回 cancelled，恢复后不自动重发。"""
        client = FakeClient({"generate_image": {"task_id": "t-11"},
                             "task_status": {"status": "running"},
                             "cancel_task": {"kind": "image", "status": "cancelled"}})
        run = _runobj(client)
        run.pause.set()
        run.resume.set()
        with _no_poll_sleep():
            payload, frames = _result(lambda emit: agent._tool_result(
                client, "generate_image", {"prompt": "x"}, emit, run))
        self.assertEqual(json.loads(payload)["status"], "cancelled")
        self.assertEqual(client.calls, [("generate_image", {"prompt": "x"}),
                                        ("task_status", {"task_id": "t-11"}),
                                        ("cancel_task", {"task_id": "t-11"})])
        self.assertEqual(run.task_id, "")
        self.assertEqual(_kinds(frames), ["status", "paused", "resumed"])

    def test_pause_timeout_ends_the_run_with_the_stop_bit_set(self):
        """暂停后整页导航走、SSE 还挂着：等「继续」超时要收场并把停止位置起，循环不能吊死。"""
        run = _runobj(object())
        run.pause.set()
        frames = []

        async def main():
            async def emit(frame):
                frames.append(frame)
            with mock.patch.object(agent, "PAUSE_WAIT_SEC", 0.0):
                return await run.await_resume(emit)
        self.assertFalse(asyncio.run(main()))
        self.assertEqual(_kinds(frames), ["paused", "content"])
        self.assertEqual(frames[1]["text"], agent.PAUSE_TIMEOUT_TEXT)
        self.assertTrue(run.stop.is_set())

    def test_cancel_releases_a_loop_parked_on_the_pause_checkpoint(self):
        """暂停中点停止：cancel 要放开 resume，挂在检查点上的循环才退得出来。"""
        run = agent._Run(object())
        run.pause.set()
        agent._RUNS[run.run_id] = run
        try:
            resp = asyncio.run(agent.agent_cancel(TestRoutes._req({"run_id": run.run_id})))
        finally:
            agent._RUNS.pop(run.run_id, None)
        self.assertTrue(json.loads(resp.text)["success"])
        self.assertTrue(run.stop.is_set())
        self.assertTrue(run.resume.is_set())

    def test_pause_and_resume_routes_validate_the_run_id(self):
        """两条新路由与 cancel 同口径：非 JSON 与畸形 run_id 进 400，查不到运行 404。"""
        for route in (agent.agent_pause, agent.agent_resume):
            self.assertEqual(asyncio.run(route(TestRoutes._req({}, valid_json=False))).status, 400)
            self.assertEqual(asyncio.run(route(TestRoutes._req({"run_id": "../secret"}))).status, 400)
            self.assertEqual(asyncio.run(route(TestRoutes._req({"run_id": "0" * 32}))).status, 404)

    def test_pause_clears_a_stale_resume_so_the_next_pause_sticks(self):
        """上一次「继续」留下的 set 不能把这一次暂停直接放过去；「继续」要落回 resume 位上。"""
        run = agent._Run(object())
        run.resume.set()
        agent._RUNS[run.run_id] = run
        try:
            asyncio.run(agent.agent_pause(TestRoutes._req({"run_id": run.run_id})))
            self.assertTrue(run.pause.is_set())
            self.assertFalse(run.resume.is_set())
            asyncio.run(agent.agent_resume(TestRoutes._req({"run_id": run.run_id})))
            self.assertTrue(run.resume.is_set())
        finally:
            agent._RUNS.pop(run.run_id, None)


if __name__ == "__main__":
    unittest.main()

