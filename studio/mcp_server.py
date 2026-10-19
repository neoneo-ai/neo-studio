# SPDX-License-Identifier: Apache-2.0
# Neo Studio MCP Server —— 外部智能体（Claude Desktop / Cursor / 自建 MCP 客户端）经 MCP 使用
# Neo Studio 的生图与导演能力。由 MCP 客户端作为 stdio 子进程启动，不随 ComfyUI 启动。
#
# 叶子模块：零相对导入、只用标准库。一切能力经本机 ComfyUI 的 HTTP 接口完成，地址强制回环。
# stdout 只跑 JSON-RPC，日志一律走 stderr。

import argparse
import base64
import difflib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROTOCOL_VERSION = "2024-11-05"
SUPPORTED_PROTOCOLS = ("2024-11-05", "2025-03-26", "2025-06-18")
DEFAULT_COMFY_URL = "http://127.0.0.1:8188"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "ip6-localhost"}
MAX_TEXT = 12000          # 单次工具返回文本上限，超出截断
MAX_B64_IMAGES = 4        # 单次返回 base64 图片张数上限
MAX_B64_BYTES = 1_500_000  # base64 回传的单张图字节上限（超出只给 url）
MAX_IMAGES = 8            # 单次返回的产物图条目上限（与 image_gen 的批量上限一致）
SSE_TIMEOUT = 600         # LLM 流式端点读超时（整段提示词生成可能很慢）
STORYBOARD_POLL_SEC = 2.0
STORYBOARD_WAIT_SEC = 900.0   # 分镜逐段串行跑图：每段数十秒起，超时就回 task_id 让智能体用 task_status 续查
KEYFRAME_REF_MAX = 9          # 段参考图上限（与 H3 参考生视频的 autogrow 槽位一致）


def log(msg) -> None:
    print(msg, file=sys.stderr, flush=True)


def plugin_version() -> str:
    """与 util.plugin_version 同源：pyproject.toml 里的版本号，避免两处漂移。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pyproject.toml")
    try:
        with open(path, encoding="utf-8") as f:
            m = re.search(r'^version\s*=\s*"([^"]+)"', f.read(), re.M)
    except OSError:
        return "unknown"
    return m.group(1) if m else "unknown"


class ToolError(Exception):
    """能直接回给智能体的短错误。"""


def comfy_base(raw: str) -> str:
    """ComfyUI 地址：只允许本机回环，非回环直接拒绝启动（不给对外网发起请求留口子）。"""
    url = (raw or DEFAULT_COMFY_URL).strip().rstrip("/")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in LOOPBACK_HOSTS:
        raise SystemExit("NEO_MCP_COMFY_URL 必须是本机回环 http 地址"
                         f"（127.0.0.1 / localhost / ::1）：{raw!r}")
    return url if parsed.port else url + ":8188"


def _error_detail(e: urllib.error.HTTPError) -> str:
    try:
        data = json.loads(e.read().decode("utf-8", "replace"))
        return str(data.get("error") or data.get("message") or "")
    except Exception:
        return ""


class Comfy:
    """ComfyUI 的 HTTP 客户端（urllib，仅本机回环）。"""

    def __init__(self, base: str, timeout: int):
        self.base = base
        self.timeout = timeout

    def _open(self, method, path, body=None, query=None, timeout=None):
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            return urllib.request.urlopen(req, timeout=timeout or self.timeout)
        except urllib.error.HTTPError as e:
            detail = _error_detail(e)
            raise ToolError(f"HTTP {e.code}" + (f"：{detail}" if detail else "") + f"（{path}）")
        except urllib.error.URLError as e:
            raise ToolError(f"ComfyUI 不可达（{self.base}）：{e.reason}；确认 Neo Studio 已启动")
        except OSError as e:
            raise ToolError(f"请求失败（{path}）：{e}")

    def _json(self, method, path, body=None, query=None, timeout=None):
        with self._open(method, path, body, query, timeout) as resp:
            raw = resp.read()
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8", "replace"))
        except ValueError as e:
            raise ToolError(f"响应不是 JSON（{path}）：{e}")

    def get(self, path, query=None, timeout=None):
        return self._json("GET", path, query=query, timeout=timeout)

    def post(self, path, body=None, timeout=None):
        return self._json("POST", path, body=body, timeout=timeout)

    def get_soft(self, path):
        """404 当作「不在这套任务表里」，返回 None 让调用方探测下一个端点。"""
        return self._soft(lambda: self.get(path))

    def post_soft(self, path):
        return self._soft(lambda: self.post(path))

    def _soft(self, call):
        try:
            return call()
        except ToolError as e:
            if "HTTP 404" in str(e):
                return None
            raise

    def get_bytes(self, path, query=None):
        with self._open("GET", path, query=query) as resp:
            return resp.read()


    def sse_text(self, path, body, timeout=SSE_TIMEOUT):
        """POST 一个 SSE 端点并收正文：跳过 thinking，[DONE] 收尾，[ERROR] 抛 ToolError。"""
        req = urllib.request.Request(self.base + path,
                                     data=json.dumps(body).encode("utf-8"), method="POST")
        req.add_header("Content-Type", "application/json")
        parts = []
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                for raw in resp:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    if payload.startswith("[ERROR]"):
                        raise ToolError(payload[len("[ERROR]"):].strip() + "（LLM 未配置时先在 Neo Studio 设置里选模型）")
                    try:
                        frame = json.loads(payload)
                    except ValueError:
                        continue
                    if frame.get("kind") == "thinking":
                        continue
                    parts.append(str(frame.get("text") or ""))
        except urllib.error.HTTPError as e:
            raise ToolError(_error_detail(e) or f"HTTP {e.code}（{path}）")
        except urllib.error.URLError as e:
            raise ToolError(f"ComfyUI 不可达（{self.base}）：{e.reason}")
        text = "".join(parts).strip()
        if not text:
            raise ToolError("LLM 没有产出内容：确认 Neo Studio 设置里已配置 LLM 模型")
        return text


class Ctx:
    def __init__(self, comfy: Comfy, b64_images: bool = False):
        self.comfy = comfy
        self.b64_images = b64_images


def clip(text) -> str:
    text = str(text)
    if len(text) > MAX_TEXT:
        return text[:MAX_TEXT] + f"\n…（已截断，共 {len(text)} 字符）"
    return text


def dump(obj, indent: int = 1) -> str:
    return clip(json.dumps(obj, ensure_ascii=False, indent=indent))


def need(args, key) -> str:
    val = str(args.get(key) or "").strip()
    if not val:
        raise ToolError(f"缺少参数：{key}")
    return val


def view_url(comfy: Comfy, filename, subfolder="", type_="output") -> str:
    """ComfyUI 的 /view 取件地址：产物只经 ComfyUI 读，MCP 层不碰本地文件路径。"""
    query = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder or "", "type": type_})
    return f"{comfy.base}/view?{query}"


IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"}


def media_kind(filename) -> str:
    """按扩展名判断产物类型：导演整片 / 单段 / 拼接的产物是 mp4，生图产物是 png。"""
    ext = os.path.splitext(str(filename))[1].lower()
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    return "image"


def image_items(comfy: Comfy, images, limit: int = MAX_B64_IMAGES) -> list:
    out = []
    for im in (images or [])[:limit]:
        filename = im.get("filename")
        if not filename:
            continue
        subfolder = im.get("subfolder") or ""
        out.append({"filename": filename, "subfolder": subfolder, "type": "output",
                    "url": view_url(comfy, filename, subfolder)})
    return out


# 五套任务表（生图 / 整片 / 单段 / 拼接 / 图片分镜）的 task_id 都是裸 uuid，没有前缀可判；
# 按顺序探测状态端点，命中即返回。
# 生图任务只有整表列表（无单任务路由），其余四套各有单任务快照路由。
TASK_STATUS_ROUTES = (
    ("director", "/neo_studio/director/{tid}"),
    ("segment", "/neo_video_gen/run_segment/{tid}"),
    ("assemble", "/neo_video_gen/assemble_segments/{tid}"),
    ("storyboard", "/neo_video_gen/storyboard_status/{tid}"),
)
TASK_CANCEL_ROUTES = (
    ("image", "/neo_image_gen/cancel/{tid}"),
    ("director", "/neo_studio/director/{tid}/cancel"),
    ("segment", "/neo_video_gen/run_segment/{tid}/cancel"),
    ("assemble", "/neo_video_gen/assemble_segments/{tid}/cancel"),
    ("storyboard", "/neo_video_gen/storyboard_cancel/{tid}"),
)


# ===========================================================================
# 基础工具
# ===========================================================================

def tool_neo_status(ctx, args):
    ver = ctx.comfy.get("/neo_studio/version") or {}
    queue = ctx.comfy.get("/queue") or {}
    return dump({
        "neo_studio": ver.get("plugin_version"),
        "comfyui": ver.get("comfyui_version"),
        "mcp_server": plugin_version(),
        "comfy_url": ctx.comfy.base,
        "director_recipes": len(ver.get("recipes") or []),
        "queue_running": len(queue.get("queue_running") or []),
        "queue_pending": len(queue.get("queue_pending") or []),
    })


def tool_list_skills(ctx, args):
    """技能清单（id 就是 generate_image 的 skill_id）；默认只列生图 / 生视频技能，all=true 列全部。
    q 连 mode 的值一起匹配：q=t2i 列出 mode=t2i 与 t2i_edit，q=edit 列出 mode=edit 与 t2i_edit——
    只匹配 id / 名称时，q=t2i_edit 这类按模式搜的词谁都命中不了，调用方就会沿用到手的第一批编辑技能。"""
    q = str(args.get("q") or "").strip().lower()
    want_all = bool(args.get("all"))
    rows = []
    for s in (ctx.comfy.get("/rs_prompts/skills") or []):
        row = {"id": s.get("id"), "name": s.get("name"), "cn_name": s.get("cn_name"),
               "has_workflow": bool(s.get("has_workflow")), "gen_image": bool(s.get("gen_image")),
               "gen_video": bool(s.get("gen_video")), "mode": str(s.get("mode") or ""),
               "requires_ref": bool(s.get("requires_ref"))}
        if not want_all and not (row["gen_image"] or row["gen_video"]):
            continue
        if q and q not in " ".join(str(row[k] or "") for k in ("id", "name", "cn_name", "mode")).lower():
            continue
        rows.append(row)
    return dump({"count": len(rows), "skills": rows}, None)


def tool_generate_prompt(ctx, args):
    body = {"text": need(args, "text")}
    if args.get("skill_id"):
        body["skillId"] = str(args["skill_id"]).strip()
    return clip(ctx.comfy.sse_text("/rs_prompts/stream_generate_prompt", body))


# 模型扫描的两套口径：生图（suggested_* 给自动挑选值）与出片 H3（扫描表里没有 suggested_*）。
MODEL_SCANS = {"image": "/neo_image_gen/models", "video": "/neo_video_gen/models"}
MODEL_GROUPS = ("diffusion_models", "text_encoders", "vae", "loras")
# 家族关键词与前端 image-gen.js 的 LORA_FAMILY_HINTS、后端 video_gen._VIDEO_MODEL_HINTS 同步；
# 词表分叉时 near 的同目录档还在，同家族那一档会退化成原序。
MODEL_FAMILY_HINTS = {"image": ("qwen", "krea2"), "video": ("minimax_h3", "minimaxh3", "minimax", "h3")}
MODEL_LIMIT = 60


def model_key(name) -> str:
    """相对路径名的比较形态：反斜杠归一成斜杠并小写。扫描表里同一个目录两种写法都有。"""
    return str(name).replace("\\", "/").lower()


def model_dir(name) -> str:
    path = str(name).replace("\\", "/")
    return path[:path.rfind("/") + 1] if "/" in path else ""


def near_order(files: list, near: str, hints: tuple) -> list:
    """当前主模型周边排序：同目录最前，其次名字里带同家族关键词，其余保持扫描原序。
    与前端 image-gen.js 的 sortByModelFamily 同一口径；sorted 稳定，同档内部不动。"""
    anchor_dir = model_dir(near).lower()
    family = next((h for h in hints if h in model_key(near)), "")

    def tier(name) -> int:
        key = model_key(name)
        if anchor_dir and key.startswith(anchor_dir):
            return 0
        return 1 if family and family in key else 2

    return sorted(files, key=tier)


def tool_list_models(ctx, args):
    scope = str(args.get("scope") or "image").strip().lower()
    if scope not in MODEL_SCANS:
        raise ToolError(f"list_models 的 scope 只认 image / video，收到的是 '{scope}'")
    group = str(args.get("group") or "").strip().lower()
    if group and group not in MODEL_GROUPS:
        raise ToolError(f"模型组只有 {'、'.join(MODEL_GROUPS)}，收到的是 '{group}'；要看全部就不传 group")
    try:
        limit = min(max(1, int(args.get("limit") or MODEL_LIMIT)), 500)
    except (TypeError, ValueError):
        raise ToolError(f"list_models 的 limit 要的是一个整数，默认 {MODEL_LIMIT}")
    near = str(args.get("near") or "").strip()
    q = model_key(args.get("q") or "")
    data = ctx.comfy.get(MODEL_SCANS[scope]) or {}
    out = {"scope": scope}
    if near:
        out["near"], out["near_dir"] = near, model_dir(near)
    for name in (MODEL_GROUPS if not group else (group,)):
        files = [str(f) for f in (data.get(name) or []) if str(f).strip()]
        if not files:
            continue        # 空组不列：这套模板结构里就没有这一项
        matched = [f for f in files if not q or q in model_key(f)]
        if near:
            matched = near_order(matched, near, MODEL_FAMILY_HINTS[scope])
        out[name] = {"count": len(files), "matched": len(matched),
                     "returned": min(len(matched), limit), "truncated": len(matched) > limit,
                     "items": [{"name": f, "dir": model_dir(f)} for f in matched[:limit]]}
    for key, val in data.items():
        if str(key).startswith("suggested_"):
            out[key] = val
    return dump(out, None)


def generate_loras(ctx, value) -> list:
    """单次 LoRA 覆盖（不落技能配置）：只吃 [{name,strength}] 与裸文件名，name 为空的条目跳过——与前端 LoRA 行同一过滤。
    名字先对着 loras 扫描表核一遍：后端对不存在的 LoRA 是 404 一次必败的生成，工具侧换成带候选文件名的一句。"""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ToolError("loras 要的是一个数组：[{\"name\": \"lora.safetensors\", \"strength\": 1.0}]")
    wanted = []
    for item in value:
        if isinstance(item, str):
            name, strength = item.strip(), 1.0
        elif isinstance(item, dict):
            name = str(item.get("name") or "").strip()
            raw = item.get("strength")
            strength = 1.0 if raw is None or raw == "" else float(raw)
        else:
            raise ToolError("loras 的每一项要写成 {\"name\": \"lora.safetensors\", \"strength\": 1.0}")
        wanted.append((name, min(max(strength, 0.0), 2.0)))
    wanted = [(n, s) for n, s in wanted if n]
    seen, unique = set(), []
    for name, strength in wanted:
        # 同一个 LoRA 点名两次只挂一次：重复项在后端是第二个 LoraLoader 节点，白多跑一趟模型
        key = model_key(name)
        if key not in seen:
            seen.add(key)
            unique.append((name, strength))
    if not unique:
        return []
    table = {model_key(f): str(f) for f in ((ctx.comfy.get("/neo_image_gen/models") or {}).get("loras") or [])}
    out = []
    for name, strength in unique:
        hit = table.get(model_key(name))
        if hit is None:
            close = [table[c] for c in difflib.get_close_matches(model_key(name), list(table), n=3, cutoff=0.3)]
            raise ToolError(f"LoRA '{name}' 不在本地 loras 目录的 {len(table)} 个文件里；"
                            f"最接近的是 {'、'.join(close) if close else '没有相近的文件名'}；"
                            "完整名单用 list_models(group=loras)，配主模型那一批就再带 near=<主模型名>")
        out.append({"name": hit, "strength": strength})
    return out



_GENERATE_KEYS = ("skill_id", "prompt", "width", "height", "count", "seed", "negative",
                  "ratio", "model", "text_encoder", "vae", "steps", "output_prefix")


def _skill_row(ctx, skill_id: str) -> dict:
    """技能表里的那一行；表里没有这个 id 返回空行，交后端的技能报错说话。"""
    for s in (ctx.comfy.get_soft("/rs_prompts/skills") or []):
        if isinstance(s, dict) and str(s.get("id") or "") == skill_id:
            return s
    return {}


def _ref_form(row: dict) -> str:
    """技能收不收参考图，判法与绘画页的技能列表同源（studio/web/skill/skill-core.js 的 skillImageMode）：
    mode 声明优先，画布导入的用户技能没有 mode 时回落 requires_ref。"""
    if not row:
        return ""
    mode = str(row.get("mode") or "")
    if mode in ("t2i", "edit", "t2i_edit"):
        return mode
    return "edit" if row.get("requires_ref") else "t2i"


def _model_family(name: str) -> str:
    """名字里的模型家族关键词（krea2 / qwen）：词表与前端 image-gen.js 的 sortByModelFamily、
    list_models 的 near 同一份。Krea2 的文本编码器名字里带的就是 qwen，这一层只用在主模型、
    LoRA 与技能名上，编码器名进来的话家族是错的。"""
    key = model_key(name)
    return next((h for h in MODEL_FAMILY_HINTS["image"] if h in key), "")


def _skill_family(row: dict) -> str:
    """技能自带的模型家族：内置技能的 id 与中文名里带家族词（qwen_image_21* / 「Krea2 文生图」）。
    画布导入的用户技能两处都没有家族词，返回空串交后端模板说话。"""
    return _model_family(f"{row.get('id') or ''} {row.get('cn_name') or ''}")


def tool_generate_image(ctx, args):
    skill_id = str(args.get("skill_id") or "").strip()
    if not skill_id:
        # 后端的空技能报错写的是「技能下拉」，那是 Studio 界面的控件，MCP 调用方没有下拉，先给一条照着做得下去的
        raise ToolError("generate_image 需要 skill_id：先调 list_skills 取一个 has_workflow=true 的技能 id")
    row = _skill_row(ctx, skill_id)
    form, family = _ref_form(row), _skill_family(row)
    refs = args.get("references")
    if isinstance(refs, str):
        refs = [refs]
    if refs and form == "t2i":
        # 参考图进了纯文生图模板就是静默丢图：跑完用户看到的就是「出的图不跟我给的图走」。
        # 绘画页的技能列表把这种技能从编辑面板里过滤掉了，工具这一侧要在发出请求之前点名要换的技能
        raise ToolError(f"技能 {skill_id} 是纯文生图（mode=t2i），模板里没有参考图槽位，参考图会被直接丢掉；"
                        "带参考图出图要在 list_skills 里选 mode=edit / t2i_edit 的技能"
                        "（没有 mode 声明时看 requires_ref=true），换完 skill_id 再调一次")
    if not refs and form == "edit":
        # 编辑技能的模板有必填参考图槽位：槽位空着进队列，后端把模板当文生图跑完，
        # 出来的图跟用户的编辑意图无关（会话 20261019-125206 的「文生图请求被当编辑跑」就是这一发）
        raise ToolError(f"技能 {skill_id} 是纯编辑技能（mode=edit / requires_ref=true），本轮 references 是空的，"
                        "模板的参考图槽位空着跑不出编辑结果；本轮要的是纯文生图就调 list_skills(q=t2i) 选"
                        "mode=t2i / t2i_edit 的技能（没有 mode 声明时看 requires_ref=false），"
                        "要在这个技能上做编辑就把参考图放进 references")
    body = {k: args[k] for k in _GENERATE_KEYS if args.get(k) is not None}
    body["skill_id"] = skill_id
    model_family = _model_family(str(args.get("model") or ""))
    if family and model_family and model_family != family:
        # Krea2 主模型要 12 层 tap×2560 的 conditioning，Qwen 模板按 qwen 类型加载编码器只给 2560：
        # 家族对撞的模板在后端是必败的一发，照抄扫描表 suggested_* 的用户提示词那一发就死在这里
        raise ToolError(f"主模型 {args.get('model')} 是 {model_family} 家族，技能 {skill_id} 的模板是 {family} 家族，"
                        f"家族不同的 conditioning 维度对不上，这一发必败；主模型留空让后端按技能自动挑，"
                        f"要换家族就调 list_skills(q={model_family}) 选 {model_family} 家族的技能")
    loras = generate_loras(ctx, args.get("loras"))
    if loras:
        body["loras"] = loras
        alien = sorted({f for f in (_model_family(str(l["name"])) for l in loras) if f} - {family}) if family else []
        if alien:
            raise ToolError(f"LoRA 是 {alien[0]} 家族的（{'、'.join(str(l['name']) for l in loras)}），技能 {skill_id} "
                            f"的模板是 {family} 家族，LoRA 挂不进不同家族的主模型（LoraLoader 报权重形状不匹配）；"
                            f"要挂这一批 LoRA 就调 list_skills(q={alien[0]}) 选 {alien[0]} 家族的技能，"
                            "或把 loras 留空")
    if refs:
        # 后端 _reference_name 认 {kind,value}：value 是 input/ 相对名（output/ 前缀会自动拷进 input/）
        body["references"] = [{"kind": "input", "value": str(r)} for r in refs[:4]]
    snap = ctx.comfy.post("/neo_image_gen/generate", body) or {}
    return dump({"task_id": snap.get("task_id"), "status": snap.get("status"),
                 "images": image_items(ctx.comfy, snap.get("images"))})


def tool_task_status(ctx, args):
    tid = need(args, "task_id")
    for t in (ctx.comfy.get_soft("/neo_image_gen/tasks") or []):
        if t.get("task_id") == tid:
            out = {"kind": "image", **t}
            out.pop("preview", None)       # 预览帧是 base64 载荷，智能体只要产物名
            out["images"] = image_items(ctx.comfy, t.get("images"), MAX_IMAGES)
            return dump(out)
    for kind, route in TASK_STATUS_ROUTES:
        data = ctx.comfy.get_soft(route.format(tid=tid))
        if data is None:
            continue
        data.pop("latest_preview", None)   # 预览帧载荷很大，智能体只要产物名
        data.pop("preview", None)
        if kind == "storyboard":
            # 分镜的 warning / filename 有用，preview_url 是相对地址（取图统一走 get_media）
            for d in (data.get("details") or []):
                d.pop("preview_url", None)
        out = {"kind": kind, **data}
        if data.get("filename"):
            # 播放链接只能由后端拼：智能体自己拼时抄的是配方里的 filename_prefix（NeoDirector/xxx），
            # 真实落盘目录是 neo_director_regen，拼出来的 /view 必 404
            out["url"] = view_url(ctx.comfy, data["filename"], data.get("subfolder") or "")
        if kind == "director":
            prog = ctx.comfy.get_soft("/neo_video_gen/director_progress") or {}
            if prog.get("active") and (prog.get("segment_index") or -1) >= 0:
                out["segment"] = {"index": prog["segment_index"] + 1,
                                  "total": prog.get("total_segments"),
                                  "step": prog.get("step"),
                                  "total_steps": prog.get("total_steps")}
        return dump(out)
    raise ToolError(f"任务不存在（结束后被清理也会这样）：{tid}")


def tool_list_tasks(ctx, args):
    tasks = ctx.comfy.get("/neo_image_gen/tasks") or []
    return dump([{"task_id": t.get("task_id"), "status": t.get("status"), "mode": t.get("mode"),
                  "prompt": str(t.get("prompt") or "")[:120], "seed": t.get("seed"),
                  "images": image_items(ctx.comfy, t.get("images"), MAX_IMAGES)} for t in tasks[:8]], None)


def tool_cancel_task(ctx, args):
    tid = need(args, "task_id")
    for kind, route in TASK_CANCEL_ROUTES:
        data = ctx.comfy.post_soft(route.format(tid=tid))
        if data is None:
            continue
        return dump({"kind": kind, **data})
    raise ToolError(f"任务不存在：{tid}")


def tool_get_media(ctx, args):
    filename = need(args, "filename")
    subfolder = str(args.get("subfolder") or "").strip()
    type_ = str(args.get("type") or "output").strip()
    kind = media_kind(filename)
    out = {"filename": filename, "subfolder": subfolder, "type": type_, "kind": kind,
           "url": view_url(ctx.comfy, filename, subfolder, type_)}
    if kind != "image":
        out["note"] = f"产物是{('视频' if kind == 'video' else '音频')}，用 url 下载或播放；base64 只对图片有效"
        return dump(out)
    if args.get("base64") or ctx.b64_images:
        raw = ctx.comfy.get_bytes("/view", {"filename": filename, "subfolder": subfolder, "type": type_})
        if len(raw) > MAX_B64_BYTES:
            out["bytes"] = len(raw)
            out["note"] = "图片过大，不回传 base64，请用 url 取图"
        else:
            out["base64"] = base64.b64encode(raw).decode("ascii")
            out["bytes"] = len(raw)
    return dump(out)


def tool_list_gallery(ctx, args):
    query = {"fields": "dirs"}
    if args.get("dir_name"):
        query["dir_name"] = str(args["dir_name"]).strip()
    if args.get("path"):
        query["path"] = str(args["path"]).strip()
    data = ctx.comfy.get("/neo_gallery/list", query) or {}
    return dump(data.get("dirs", data))


def tool_list_recipes(ctx, args):
    recipes = [{"name": r.get("name"), "type": r.get("type"), "source": r.get("source"),
                "segments": len(r.get("segments") or [])}
               for r in (ctx.comfy.post("/rs_recipes/list", {}) or [])]
    return dump({"count": len(recipes), "recipes": recipes})


def tool_load_recipe(ctx, args):
    data = ctx.comfy.post("/rs_recipes/load", {"name": need(args, "name")}) or {}
    return dump(data.get("recipe", data))


# ===========================================================================
# 导演工具（video_director 配方 → 整片 / 单段 / 拼接）
# 段序号对外一律 1 起（与 Studio 时间轴「第 N 段」一致），内部换算成端点的 0 基。
# ===========================================================================

def seg_index(value) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ToolError(f"段序号必须是整数（1 起）：{value!r}")
    if n < 1:
        raise ToolError("段序号必须 1 起：第 1 段就是时间轴第一段")
    return n - 1


def seg_list(value) -> list:
    if isinstance(value, str):
        value = [p for p in re.split(r"[,\s]+", value.strip()) if p]
    if not value:
        raise ToolError("段序号列表为空")
    return [seg_index(v) for v in value]


def tool_director_recipes(ctx, args):
    ver = ctx.comfy.get("/neo_studio/version") or {}
    return dump({"recipes": ver.get("recipes") or []})


def tool_director_spec(ctx, args):
    data = ctx.comfy.get("/rs_recipes/director_spec", {"name": need(args, "name")}) or {}
    segs = [{"index": i + 1, "skill_id": s.get("skill_id"), "mode": s.get("mode"),
             "duration_sec": s.get("duration_sec"), "ref_input": s.get("ref_input"),
             "first_frame": s.get("first_frame"), "storyboard": s.get("storyboard"),
             "storyboard_prompt": s.get("storyboard_prompt"),
             "prompt": clip(str(s.get("prompt") or ""))}
            for i, s in enumerate(data.get("segments") or [])]
    return dump({"name": data.get("name"), "shared": data.get("shared") or {},
                 "defaults": data.get("defaults"), "identity_images": data.get("identity_images"),
                 "segment_count": len(segs), "segments": segs})


def tool_director_plan(ctx, args):
    """文字故事板 → 分段 JSON（plan），或单段提示词按 H3 格式重写 / 按指令改写（optimize / modify）。"""
    mode = str(args.get("mode") or "plan").strip()
    if mode == "plan":
        body = {"idea": need(args, "idea")} if args.get("script") is None else {"script": str(args["script"])}
        if args.get("segment_seconds") is not None:
            body["segment_seconds"] = int(args["segment_seconds"])
        if args.get("characters"):
            body["characters"] = [str(c) for c in args["characters"]]
        data = ctx.comfy.post("/rs_recipes/director_generate_segments", body, timeout=SSE_TIMEOUT) or {}
        return dump({"segments": data.get("segments") or []})

    if mode not in ("optimize", "modify"):
        raise ToolError("mode 只能是 plan / optimize / modify")
    body = {"prompt": need(args, "prompt")}
    if args.get("duration_sec") is not None:
        body["duration_sec"] = args["duration_sec"]
    if args.get("video_mode"):
        body["mode"] = str(args["video_mode"]).strip()
    if args.get("refs"):
        body["refs"] = args["refs"]
    route = "/rs_recipes/director_optimize_prompts"
    if mode == "modify":
        body["instruction"] = need(args, "instruction")
        route = "/rs_recipes/director_modify_segment"
    return clip(ctx.comfy.sse_text(route, body))


def _wait_storyboard(ctx, task_id):
    """轮询分镜任务到终态。逐段串行跑图、每段数十秒起，等到上限就带着 running 回给智能体，
    让它用 task_status 按同一个 task_id 继续查，别把一次工具调用挂死。"""
    deadline = time.time() + STORYBOARD_WAIT_SEC
    while True:
        snap = ctx.comfy.get(f"/neo_video_gen/storyboard_status/{task_id}") or {}
        if snap.get("status") in ("done", "cancelled") or time.time() >= deadline:
            return snap
        time.sleep(STORYBOARD_POLL_SEC)


def _keyframe_segments(segments, frames, shared):
    """把关键帧接回段：storyboard 记图名，非全参考段同时设首帧（i2v 吃这张图，只写 storyboard
    时后端只把它当多帧分块锚点），r2v 段进参考图池 —— 与 📖 故事板页 generateAllStoryboards 同口径。
    save 是整份覆盖，所以这里回整份段清单，智能体原样喂回 director_save 就行。"""
    shared_mode = str((shared or {}).get("mode") or "").strip()
    out = []
    for i, seg in enumerate(segments):
        seg = dict(seg)
        fname = frames.get(i)
        if fname:
            seg["storyboard"] = fname
            eff = str(seg.get("mode") or "").strip() or shared_mode
            if eff in ("r2v", "v2v", "rv2v"):
                refs = dict(seg.get("refs") or {})
                imgs = [str(x) for x in (refs.get("images") or []) if str(x) and str(x) != fname]
                refs["images"] = ([fname] + imgs)[:KEYFRAME_REF_MAX]
                seg["refs"] = refs
            else:
                seg["first_frame"] = fname
        out.append(seg)
    return out


def tool_director_keyframes(ctx, args):
    """图片分镜：按段给配方出关键帧（写进配方自己的 assets/），回可直接喂回 director_save 的段。"""
    name = need(args, "recipe")
    meta = (ctx.comfy.post("/rs_recipes/load", {"name": name}) or {}).get("recipe") or {}
    if meta.get("type") != "video_director":
        raise ToolError(f"不是 video_director 配方：{name}")
    segments = meta.get("segments") or []
    if not segments:
        raise ToolError(f"配方还没有分段：{name}（先 director_plan 出分段、director_save 写进配方）")
    picks = list(range(len(segments))) if args.get("segments") is None else seg_list(args["segments"])
    for i in picks:
        if i >= len(segments):
            raise ToolError(f"段序号超出范围：第 {i + 1} 段（配方共 {len(segments)} 段）")
    mode = str(args.get("mode") or "").strip()
    if mode not in ("", "t2i", "r2i"):
        raise ToolError(f"mode 只能是 t2i / r2i：{mode}")

    # 后端按 segments[] + index 偏移给图名编号（storyboard_{recipe}_{n:02d}）：连续选段一发提交，
    # 跳着选段按段各发一发，图名才不会和段号错位
    groups = []
    for i in picks:
        if groups and i == groups[-1][-1] + 1:
            groups[-1].append(i)
        else:
            groups.append([i])

    details, statuses, task_ids = [], [], []
    for group in groups:
        body = {"name": name,
                "segments": [{"prompt": str((segments[i] or {}).get("prompt") or ""),
                              "storyboard_prompt": str((segments[i] or {}).get("storyboard_prompt") or "")}
                             for i in group],
                "skill_id": str(args.get("skill_id") or "").strip() or "image_gen",
                "index": group[0],
                "force": bool(args.get("force"))}
        if mode:
            body["mode"] = mode
        for key in ("ratio", "width", "height", "seed"):
            if args.get(key) is not None:
                body[key] = args[key]
        snap = ctx.comfy.post("/neo_video_gen/storyboard_generate", body) or {}
        task_id = str(snap.get("task_id") or "")
        if not task_id:
            raise ToolError(f"图片分镜没有返回 task_id：{snap.get('error') or name}")
        task_ids.append(task_id)
        state = _wait_storyboard(ctx, task_id)
        statuses.append(str(state.get("status") or "running"))
        details.extend(state.get("details") or [])

    frames = {}
    for d in details:
        if d.get("filename") and d.get("index") is not None:
            frames[int(d["index"])] = str(d["filename"])
    status = "done" if all(s == "done" for s in statuses) else (statuses[-1] if statuses else "running")
    return dump({"recipe": name, "task_id": task_ids[-1], "task_ids": task_ids, "status": status,
                 # 段号对外一律 1 起：后端 details 里是 0 基偏移
                 "details": [{"index": int(d["index"]) + 1, "status": d.get("status"),
                              "filename": d.get("filename"), "error": d.get("error"),
                              "warnings": d.get("warnings")}
                             for d in details if d.get("index") is not None],
                 "segments": _keyframe_segments(segments, frames, meta.get("shared")),
                 "shared": meta.get("shared") or {}, "story": meta.get("story") or {},
                 "note": "把 segments / shared / story 原样传给 director_save 才会落盘："
                         "storyboard 已记图名，非全参考段已设首帧，全参考段已进参考图池"})


def tool_director_save(ctx, args):
    """把分段写进 custom 配方（写操作）：预设配方只读，先 director_copy 再保存。"""
    segments = args.get("segments")
    if not segments:
        raise ToolError("segments 为空：每段至少 prompt + duration_sec（草稿可留空 prompt）")
    body = {"name": need(args, "name"), "type": "video_director",
            "shared": args.get("shared") or {}, "segments": segments}
    for key in ("assets", "prompt", "gen_type", "story"):
        if args.get(key) is not None:
            body[key] = args[key]
    return dump(ctx.comfy.post("/rs_recipes/save", body) or {})


def tool_director_copy(ctx, args):
    """复制配方为新的 custom 配方（解锁内置预设的只读限制），返回新配方名。"""
    return dump(ctx.comfy.post("/rs_recipes/copy", {"name": need(args, "name")}) or {})


def tool_director_run(ctx, args):
    """整片入队，立即返回 task_id（多段 × 每段数分钟，绝不阻塞等待）。"""
    body = {"recipe": need(args, "recipe")}
    for key in ("seed", "width", "height", "continuity", "context_frames", "steps"):
        if args.get(key) is not None:
            body[key] = args[key]
    if args.get("only_segments") is not None:
        body["only_segments"] = ",".join(str(i + 1) for i in seg_list(args["only_segments"]))
    snap = ctx.comfy.post("/neo_studio/director/generate", body) or {}
    return dump({"task_id": snap.get("task_id"), "status": snap.get("status"),
                 "recipe": snap.get("recipe"), "prompt_id": snap.get("prompt_id")})


def tool_segment_run(ctx, args):
    """单段生成 / 重生成（修片主手段）；入队即返回 task_id。"""
    body = {"recipe": need(args, "recipe"), "segment": seg_index(args.get("segment"))}
    for key in ("seed", "anchors", "continuity", "context_frames", "film"):
        if args.get(key) is not None:
            body[key] = args[key]
    snap = ctx.comfy.post("/neo_video_gen/run_segment", body) or {}
    return dump({"task_id": snap.get("task_id"), "status": snap.get("status"),
                 "segment": (snap.get("segment") or 0) + 1, "recipe": snap.get("recipe")})


def tool_assemble_run(ctx, args):
    """把勾选的段拼回成片；后台线程执行，入队即返回 task_id。"""
    body = {"recipe": need(args, "recipe"), "use": seg_list(args.get("segments"))}
    for key in ("film", "blend", "continuity", "context_frames"):
        if args.get(key) is not None:
            body[key] = args[key]
    snap = ctx.comfy.post("/neo_video_gen/assemble_segments", body) or {}
    return dump({"task_id": snap.get("task_id"), "status": snap.get("status"),
                 "recipe": snap.get("recipe"), "use": [i + 1 for i in body["use"]]})


# ===========================================================================
# 工具表
# ===========================================================================

def s(t, d) -> dict:
    return {"type": t, "description": d}


def tool(name, desc, props, required=(), example=None) -> dict:
    item = {"name": name, "description": desc,
            "inputSchema": {"type": "object", "properties": props, "required": list(required)}}
    if example is not None:
        # 示例参数只给 Studio 设置页的工具卡预填；_meta 是协议里放附加数据的位置，外部智能体可无视
        item["_meta"] = {"example": example}
    return item


TASK_ID = s("string", "generate_image / director_run / segment_run / assemble_run 返回的 task_id")
RECIPE = s("string", "video_director 配方名（director_recipes 可查）")
SEGMENT = s("integer", "段序号，1 起（第 1 段 = 时间轴第一段）")

TOOLS = [
    tool("neo_status", "Neo Studio / ComfyUI 版本、队列长度、导演配方数；先调它确认服务在线", {}),
    tool("list_skills", "列出技能（id 即 generate_image 的 skill_id）；默认只列生图 / 生视频技能，all=true 列全部，q 按 id / 名称 / 中文名 / mode 子串过滤（q=t2i 列 mode=t2i 与 t2i_edit，q=edit 列 mode=edit 与 t2i_edit）；本轮没有 references 就是纯文生图，要选 mode=t2i / t2i_edit（无 mode 时 requires_ref=false）的技能，mode=edit 的纯编辑技能没有参考图跑不出编辑结果；带参考图出图要选 mode=edit / t2i_edit 的技能（没有 mode 声明时看 requires_ref=true），mode=t2i 的纯文生图技能会把参考图直接丢掉；技能 id 与中文名里的家族词（krea2 / qwen）就是它模板的主模型家族，挂 LoRA 时要在同一家族里选",
         {"all": s("boolean", "true 时连任务类技能一起列（较长）"),
          "q": s("string", "按 id / 名称 / 中文名 / mode 子串过滤")}),
    tool("generate_prompt", "把简短想法扩写成成品提示词（LLM 同步返回文本）",
         {"text": s("string", "简短想法或草稿提示词"),
          "skill_id": s("string", "可选：按该技能的模板上下文扩写")}, ("text",),
         {"text": "一只在窗台打盹的橘猫，暖色阳光，写实"}),
    tool("list_models", "列出 Neo Studio 扫到的模型与 LoRA（scope=image 生图扫描，scope=video 出片 H3 扫描）。q 按 目录/文件名 子串过滤，group 只看一组，near 给当前主模型名时同目录条目排最前、同家族关键词次之；每项带 dir，看某个 LoRA 与主模型是否同一目录就看它。描述里带人物 / 画风 / 作品名这类专名时就带 q=<关键词> 搜一轮 loras",
         {"scope": s("string", "image（默认，生图扫描，带 suggested_* 自动挑选值）/ video（出片 H3 扫描）"),
          "group": s("string", "只看一组：diffusion_models / text_encoders / vae / loras"),
          "q": s("string", "按 目录/文件名 子串过滤（大小写不敏感，中文文件名可用）"),
          "near": s("string", "当前主模型的相对路径名：同目录的模型与 LoRA 排最前，其次名字里带同家族关键词的；换同目录的主模型、给主模型配 LoRA 就传它"),
          "limit": s("integer", f"每组最多列几条，默认 {MODEL_LIMIT}")},
         example={"scope": "image", "near": "<当前主模型名，如 Krea2\\krea2_turbo_fp8.safetensors>",
                  "q": "<目录或文件名关键词>"}),
    tool("generate_image", "提交生图任务，立即返回 task_id（用 task_status 轮询、get_media 取图）；带 references 的这一次是编辑那张参考图，不是文生图；references 为空的这一次是纯文生图，mode=edit 的纯编辑技能会被拒；主模型与 LoRA 的家族（krea2 / qwen）与技能的模板家族不一致时会被拒",
         {"skill_id": s("string", "生图技能 id（list_skills 可查）；带 references 时必须是 mode=edit / t2i_edit 的技能，mode=t2i 会把参考图直接丢掉；references 为空时不能是 mode=edit 的技能"),
          "prompt": s("string", "提示词"),
          "width": s("integer", "宽（像素），留空用技能默认"),
          "height": s("integer", "高（像素），留空用技能默认"),
          "count": s("integer", "张数"),
          "seed": s("integer", "种子，-1 随机"),
          "negative": s("string", "负向提示词"),
          "references": s("array", "参考图文件名列表（input/ 下的名字）；右栏的附件图会自动接进来，显式传空列表就是纯文生图；带它的这一次按编辑那张参考图走，技能要选 mode=edit / t2i_edit"),
          "model": s("string", "扩散模型文件名，留空自动挑选；只影响这一次，技能里的自定参数不动。家族（krea2 / qwen）必须与技能一致，扫描表里的 suggested_* 是整套默认建议、照抄进这里会让主模型与技能模板家族对撞"),
          "text_encoder": s("string", "文本编码器文件名，留空自动挑选"),
          "vae": s("string", "VAE 文件名，留空自动挑选"),
          "loras": s("array", "这一次的 LoRA：[{\"name\": \"lora.safetensors\", \"strength\": 1.0}]，也可直接写文件名；strength 0-2，超出后端夹到 0-2；只影响这一次，技能里的自定参数不动。名字用 list_models(group=loras, near=<主模型名>) 查；LoRA 的家族（krea2 / qwen）必须与技能一致；用户没点名 LoRA 时，描述里带人物 / 画风 / 作品名这类专名也先按 q=<关键词> 搜一轮，命中多项就问用户选哪个"),
          "steps": s("integer", "采样步数")}, ("skill_id", "prompt"),
         {"skill_id": "<list_skills 里 has_workflow=true 的技能 id>",
          "prompt": "一只橘猫坐在窗台，暖色阳光，写实", "width": 1024, "height": 1024}),

    tool("task_status", "查任务快照（生图 / 整片 / 单段 / 拼接共用 task_id）；生图 succeeded 后 images 带取图 URL，导演类 succeeded 后 filename 是 mp4 产物、url 是可直接转给用户的播放/下载链接，别自己拼",
         {"task_id": TASK_ID}, ("task_id",), {"task_id": "<generate_image / director_run 返回的 task_id>"}),
    tool("list_tasks", "列出最近的生图任务", {}),
    tool("cancel_task", "取消任务（未执行出队，执行中中断）", {"task_id": TASK_ID}, ("task_id",),
         {"task_id": "<list_tasks 里的 task_id>"}),
    tool("get_media", "取产物文件（图片 / 视频 / 音频）：返回文件名、类型与 /view 的 URL；图片可 base64=true 回字节，视频与音频只给 URL",
         {"filename": s("string", "产物文件名（生图是 png，导演 / 单段 / 拼接是 mp4）"),
          "subfolder": s("string", "产物子目录（照抄 task_status 的 subfolder：整片 NeoDirector/配方名、单段 neo_director_regen、拼接 neo_director_merge）"),
          "type": s("string", "output（默认）或 input"),
          "base64": s("boolean", "为 true 且产物是图片时附带 base64 字节")}, ("filename",),
         {"filename": "<task_status 里的产物文件名>", "base64": False}),
    tool("list_gallery", "列素材库目录结构（可 dir_name / path 下钻）",
         {"dir_name": s("string", "目录名"), "path": s("string", "目录内子路径")}),
    tool("list_recipes", "列出配方（含 video_director 类型标记与段数）", {}),
    tool("load_recipe", "读单个配方的元数据", {"name": s("string", "配方名")}, ("name",),
         {"name": "<list_recipes 里的配方名>"}),
    tool("director_recipes", "列出导演配方（type=video_director）", {}),
    tool("director_spec", "读导演配方的 shared 与分段清单（段号 1 起）", {"name": RECIPE}, ("name",),
         {"name": "<director_recipes 里的配方名>"}),
    tool("director_plan", "故事板规划：mode=plan 主题/脚本→分段 JSON（未点名段数时只出 1 段）；mode=optimize 单段按 H3 格式重写；mode=modify 按指令改写单段",
         {"mode": s("string", "plan（默认）/ optimize / modify"),
          "idea": s("string", "plan：故事主题"),
          "script": s("string", "plan：已确认的故事脚本（按原剧情拆分，不改写情节）"),
          "segment_seconds": s("integer", "plan：每段目标秒数，默认 5（出片默认一段 5 秒）"),
          "characters": s("array", "plan：角色参考图文件名，锁角色身份；右栏的附件图会自动接进来"),
          "prompt": s("string", "optimize/modify：该段现有提示词"),
          "instruction": s("string", "modify：修改指令"),
          "duration_sec": s("number", "optimize/modify：本段秒数"),
          "video_mode": s("string", "optimize/modify：t2v/i2v/l2v/fl2v/r2v/v2v/rv2v"),
          "refs": s("object", "optimize/modify：本段参考素材 {images,videos,audios}")}),
    tool("director_save", "写操作：把分段写进 custom 配方（内置预设只读，先 director_copy）",
         {"name": s("string", "配方名"),
          "shared": s("object", "{width,height,seed,mode?,chunk_sec?}；mode 全体统一，mixed 时每段用 seg.mode；"
                              "拿参考图（角色图目录的设定图）出片写 r2v，图进各段 refs.images，不当 first_frame"),
          "segments": s("array", "每段 {prompt,duration_sec,skill_id?,first_frame?,storyboard?,storyboard_prompt?,refs?,mode?}；草稿可留空 prompt"),
          "story": s("object", "{idea,story,characters,segment_seconds,image_mode,image_skill,frame_source}："
                               "文字故事板快照；带上才有主题 / 角色参考 / 分镜设置，关键帧也才拿得到角色参考"),
          "assets": s("array", "随配方收录的素材 {filename,subfolder,type,kind}，kind=image/video/audio")}, ("name", "segments"),
         {"name": "<director_copy 返回的新配方名>",
          "segments": [{"prompt": "橘猫走过城市街道，黄昏，镜头缓慢推进", "duration_sec": 5}]}),
    tool("director_keyframes", "图片分镜（写操作，逐段串行跑图，可能要几分钟）：按段给配方出关键帧，落进配方自己的 assets/。"
         "返回 segments / shared / story，原样传给 director_save 才记进配方（storyboard 已记图名、非全参考段已设首帧）",
         {"recipe": RECIPE,
          "segments": s("array", "只跑这些段（1 起）；留空跑全部"),
          "skill_id": s("string", "生图技能 id（list_skills 可查），默认 image_gen（Krea2）"),
          "mode": s("string", "t2i 纯文生图 / r2i 带角色参考；留空按配方的角色参考图自动"),
          "force": s("boolean", "true 时已有关键帧的段也重出（换新随机种子）"),
          "ratio": s("string", "宽高比（如 16:9），留空按配方 shared.ratio 或方图"),
          "width": s("integer", "宽（像素），留空按比例"),
          "height": s("integer", "高（像素），留空按比例"),
          "seed": s("integer", "种子，留空随机")}, ("recipe",),
         {"recipe": "<director_recipes 里的配方名>"}),
    tool("director_copy", "复制配方为新的 custom 配方（解锁内置预设的只读限制），返回新配方名",
         {"name": RECIPE}, ("name",), {"name": "<director_recipes 里的配方名>"}),
    tool("director_run", "整片入队，立即返回 task_id（多段长任务，用 task_status 轮询，勿同步等待；succeeded 后 filename 是整片 mp4，用 get_media 取）。出片默认口径是一段 5 秒，那种走 segment_run",
         {"recipe": RECIPE,
          "only_segments": s("array", "只跑勾选的段（1 起）；留空跑全部"),
          "seed": s("integer", "种子，-1 随机"),
          "width": s("integer", "宽，-1 用配方默认"),
          "height": s("integer", "高，-1 用配方默认"),
          "continuity": s("boolean", "段间连续性"),
          "context_frames": s("integer", "连续性上下文帧数"),
          "steps": s("integer", "采样步数，-1 用各段技能默认（VDN 技能 8 步，非 VDN 20 步）")}, ("recipe",),
         {"recipe": "<director_recipes 里的配方名>"}),
    tool("segment_run", "单段生成 / 重生成（修片主手段），立即返回 task_id（succeeded 后 filename 是该段 mp4）",
         {"recipe": RECIPE, "segment": SEGMENT,
          "seed": s("integer", "种子，-1 随机"),
          "anchors": s("string", "锚点模式 both/first/none"),
          "continuity": s("boolean", "段间连续性"),
          "context_frames": s("integer", "连续性上下文帧数"),
          "film": s("string", "锚定用的成片文件名，留空取最新")}, ("recipe", "segment"),
         {"recipe": "<director_recipes 里的配方名>", "segment": 1}),
    tool("assemble_run", "把勾选的段拼回成片，立即返回 task_id（succeeded 后 filename 是拼接后的整片 mp4）",
         {"recipe": RECIPE, "segments": s("array", "要拼接的段序号（1 起）"),
          "film": s("string", "被替换的成片文件名，留空取最新"),
          "blend": s("integer", "接缝融合帧数"),
          "continuity": s("boolean", "段间连续性"),
          "context_frames": s("integer", "连续性上下文帧数")}, ("recipe", "segments"),
         {"recipe": "<director_recipes 里的配方名>", "segments": [1]}),
]

HANDLERS = {
    "neo_status": tool_neo_status,
    "list_skills": tool_list_skills,
    "generate_prompt": tool_generate_prompt,
    "list_models": tool_list_models,
    "generate_image": tool_generate_image,
    "task_status": tool_task_status,
    "list_tasks": tool_list_tasks,
    "cancel_task": tool_cancel_task,
    "get_media": tool_get_media,
    "list_gallery": tool_list_gallery,
    "list_recipes": tool_list_recipes,
    "load_recipe": tool_load_recipe,
    "director_recipes": tool_director_recipes,
    "director_spec": tool_director_spec,
    "director_plan": tool_director_plan,
    "director_keyframes": tool_director_keyframes,
    "director_save": tool_director_save,
    "director_copy": tool_director_copy,
    "director_run": tool_director_run,
    "segment_run": tool_segment_run,
    "assemble_run": tool_assemble_run,
}


# ===========================================================================
# JSON-RPC over stdio（换行分隔）
# ===========================================================================

def serve(ctx, tools, stdin, stdout) -> int:
    handlers = {t["name"]: HANDLERS[t["name"]] for t in tools}

    def send(payload) -> None:
        stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        stdout.flush()

    def fail(mid, code, message) -> None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}})

    while True:
        try:
            line = stdin.readline()
        except (KeyboardInterrupt, EOFError, ValueError):
            return 0
        if not line:
            return 0
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            fail(None, -32700, "请求不是有效 JSON")
            continue
        method = msg.get("method")
        mid = msg.get("id")
        params = msg.get("params") or {}

        if method == "initialize":
            want = str(params.get("protocolVersion") or PROTOCOL_VERSION)
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": want if want in SUPPORTED_PROTOCOLS else PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "neo-studio", "version": plugin_version()},
                "instructions": "生图与整片都是异步任务：generate_image / director_run / segment_run / "
                                "assemble_run 只返回 task_id，用 task_status 轮询到 succeeded 再取产物。"
                                "生图产物是图片，导演 / 单段 / 拼接产物是 mp4 视频，都用 get_media 取（视频只给 URL）。"
                                "段序号一律 1 起。generate_image 的 skill_id 必须是 list_skills 里 has_workflow=true 的技能。"
                                "出片默认口径是一段 5 秒、VDN 技能（minimax_h3_vdn_*，8 步）走 segment_run；"
                                "多段整片要用户点名才跑，别拿现成多段配方直接 director_run。"
                                "要每段有图可依就用 director_keyframes 出关键帧，再把返回的 segments / shared / story "
                                "原样传给 director_save 才生效；没跑过关键帧不要说已经设了首帧。"}})
        elif method == "notifications/initialized":
            continue
        elif method == "ping":
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": mid, "result": {"tools": tools}})
        elif method in ("resources/list", "resources/templates/list", "prompts/list"):
            key = {"resources/list": "resources", "resources/templates/list": "resourceTemplates",
                   "prompts/list": "prompts"}[method]
            send({"jsonrpc": "2.0", "id": mid, "result": {key: []}})
        elif method == "tools/call":
            name = str(params.get("name") or "")
            handler = handlers.get(name)
            if handler is None:
                fail(mid, -32602, f"未知工具：{name}")
                continue
            args = params.get("arguments")
            if not isinstance(args, dict):
                args = {}
            try:
                result = {"content": [{"type": "text", "text": handler(ctx, args)}], "isError": False}
            except ToolError as e:
                result = {"content": [{"type": "text", "text": str(e)}], "isError": True}
            except Exception as e:
                log(f"tool {name} failed: {e}")
                result = {"content": [{"type": "text", "text": f"工具执行失败：{e}"}], "isError": True}
            send({"jsonrpc": "2.0", "id": mid, "result": result})
        elif mid is not None:
            fail(mid, -32601, f"不支持的方法：{method}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="neo-studio-mcp", description="Neo Studio MCP Server（stdio）")
    ap.add_argument("--comfy-url", default=os.environ.get("NEO_MCP_COMFY_URL"),
                    help="ComfyUI 地址，必须本机回环（默认 http://127.0.0.1:8188）")
    ap.add_argument("--timeout", type=int, default=int(os.environ.get("NEO_MCP_TIMEOUT", "30")))
    ap.add_argument("--tools", default=os.environ.get("NEO_MCP_TOOLS", ""),
                    help="逗号分隔的工具白名单；留空启用全部")
    ap.add_argument("--image-base64", action="store_true",
                    default=os.environ.get("NEO_MCP_IMAGE_BASE64") == "1",
                    help="get_media 对图片默认附带 base64 字节")
    ap.add_argument("--selftest", action="store_true", help="打印启用工具后退出（不连 ComfyUI）")
    args = ap.parse_args(argv)

    allow = {t.strip() for t in args.tools.split(",") if t.strip()}
    unknown = allow - set(HANDLERS)
    if unknown:
        raise SystemExit(f"工具白名单里有未知工具：{', '.join(sorted(unknown))}")
    tools = [t for t in TOOLS if not allow or t["name"] in allow]

    if args.selftest:
        log(f"Neo Studio MCP Server v{plugin_version()} · {len(tools)} 工具："
            + ", ".join(t["name"] for t in tools))
        return 0

    ctx = Ctx(Comfy(comfy_base(args.comfy_url), args.timeout), args.image_base64)
    log(f"Neo Studio MCP Server v{plugin_version()} · {len(tools)} 工具 · {ctx.comfy.base}")
    # Windows 控制台默认不是 UTF-8，协议要求按 UTF-8 收发
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    return serve(ctx, tools, sys.stdin, sys.stdout)


if __name__ == "__main__":
    sys.exit(main())





