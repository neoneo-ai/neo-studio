# SPDX-License-Identifier: Apache-2.0
"""预设技能模型清单（skills/presets/<id>/models.json）：文件层就位检查 + 双源下载计划。

清单声明一个技能要用的模型文件：落盘类别、预设口径的相对名、体积与 ModelScope / Hugging Face /
C 站出处（sources[0] 是推荐源，gated 标 HF 上要先申请授权的条目）。族系共用同一套权重的技能用
extends 指向基准预设，自己的清单只写追加项（LoRA 等）。

就位只看文件层 —— 不检查 ComfyUI 版本、显存、队列、代理，也不预测生成成败。判定口径跟着生成侧：
配置写死了模型名就按那个相对名精确查（resolve_model 找不到就是硬报错），名留空才按清单推荐名 +
族系变体名在类别树里认。下载计划只产出模型库 /neo_model_hub/download 的现成 payload，按当前选定
的源出计划，不新造下载器，也不跨源自动续传。

models.json 缺文件 / 坏 JSON / 缺字段一律按「无清单」降级：检查返回 has_manifest=False，绝不抛错。
"""
import json
from pathlib import Path

import folder_paths
from aiohttp import web

routes = web.RouteTableDef()

MANIFEST_FILE = "models.json"
# 视频族的落盘设置键在 configs/video_gen.json 里带 video_ 前缀，技能 config.json 里是短名
VIDEO_SETTING_KEYS = {"model": "video_model", "text_encoder": "video_text_encoder",
                      "vae": "video_vae", "audio_vae": "video_audio_vae"}
IMAGE_FIELDS = ("model", "text_encoder", "vae")
LORA_FIELD = "loras"
SOURCE_LABELS = {"modelscope": "MS", "huggingface": "HF", "civitai": "C 站"}
EXTENDS_MAX_DEPTH = 1


# ---------------------------------------------------------------------------
# 清单与技能配置读取
# ---------------------------------------------------------------------------

def _read_json(path: Path) -> dict:
    """数据根里的 JSON 读成对象：缺文件、坏 JSON、非对象一律空 dict（清单缺失等于无清单）。"""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def preset_manifest(skill_id: str) -> dict:
    """预设自己的 models.json（不含 extends 合并）。"""
    from .skill import _skill_dir

    d = _skill_dir(str(skill_id or "").strip())
    return _read_json(Path(d) / MANIFEST_FILE) if d else {}


def skill_config(skill_id: str) -> dict:
    """技能的有效配置：预设 config.json ⊕ 本地覆盖文件（与生成侧读的是同一份）。"""
    from .skill import get_skill_gen_config

    return get_skill_gen_config(str(skill_id or "").strip())


def _file_key(entry: dict) -> tuple:
    return (str(entry.get("category") or ""),
            str(entry.get("filename") or "").replace("\\", "/").lower())



def resolve_skill_models(skill_id: str, _depth: int = 0) -> dict:
    """预设清单 + extends 基准的族系文件：基准在前、预设追加，(类别, 文件名) 去重。

    extends 只解一层（EXTENDS_MAX_DEPTH）：A extends B、B extends A 这种环到此为止，
    按「无基准」继续，不会递归下去。
    """
    manifest = preset_manifest(skill_id)
    if not manifest:
        return {}
    files = [e for e in (manifest.get("files") or []) if isinstance(e, dict)]
    base = {}
    base_id = str(manifest.get("extends") or "").strip()
    if base_id and _depth < EXTENDS_MAX_DEPTH:
        base = resolve_skill_models(base_id, _depth + 1)
    if base:
        merged, seen = [], set()
        base_files = [e for e in (base.get("files") or []) if isinstance(e, dict)]
        for entry in base_files + files:
            key = _file_key(entry)
            if key not in seen:
                seen.add(key)
                merged.append(entry)
        files = merged
    return {"family": str(manifest.get("family") or base.get("family") or "").strip(),
            "label": str(manifest.get("label") or base.get("label")
                         or manifest.get("family") or "").strip(),
            "license": str(manifest.get("license") or base.get("license") or "").strip(),
            "kind": str(manifest.get("kind") or base.get("kind") or "image").strip(),
            "notes": [str(n).strip() for n in (manifest.get("notes") or base.get("notes") or [])
                      if str(n).strip()],
            "files": files}


# ---------------------------------------------------------------------------
# 文件层就位（只认本地模型根里的真实文件，绝不发起网络请求）
# ---------------------------------------------------------------------------

def category_files(category: str) -> list:
    """类别的相对文件清单（含子目录）；类别名非法、folder_paths 未就绪 → 空表。"""
    if not category:
        return []
    try:
        return sorted(folder_paths.get_filename_list(category) or [])
    except Exception:
        return []



def locate_exact(category: str, wanted: str) -> str:
    """按相对名精确找文件（生成侧 resolve_model 的口径）：斜杠方向与大小写不敏感，找不到空串。"""
    wanted = str(wanted or "").strip().replace("\\", "/")
    if not wanted:
        return ""
    files = category_files(category)
    exact = next((f for f in files if f.replace("\\", "/") == wanted), "")
    if exact:
        return exact
    lowered = {f.replace("\\", "/").lower(): f for f in files}
    return lowered.get(wanted.lower(), "")


def locate_by_names(category: str, names: list) -> str:
    """按文件名（末段 basename）在类别整棵树里认文件，大小写不敏感；命中返回相对名，否则空串。

    族系变体互备就靠这一步：清单推荐名不在，族系里任何变体的同名文件落在这个类别就算就位，
    生成侧 resolve_model 的自动挑选同样能用它跑通。
    """
    files = category_files(category)
    if not files:
        return ""
    by_base = {}
    for f in files:
        by_base.setdefault(f.replace("\\", "/").split("/")[-1].lower(), f)
    for name in names:
        key = str(name or "").strip().replace("\\", "/").split("/")[-1].lower()
        if key and key in by_base:
            return by_base[key]
    return ""


def subfolder_of(rel_path: str) -> str:
    """相对路径的落盘子目录；裸文件返回空串。"""
    parts = str(rel_path or "").replace("\\", "/").split("/")
    return "/".join(parts[:-1])


def settings_wanted(skill_id: str, kind: str) -> dict:
    """每个 field 该用哪个模型名：技能 config.json（含预设本地覆盖）→ 全局默认 → 空（自动挑选）。

    读的就是生成侧灌工作流前的那份值（get_skill_gen_config ⊕ 全局设置），检查与生成不会各说各话。
    LoRA 激活口径同样跟生成侧一致：技能 config 没写 loras 就用全局 LoRA 表，
    表里没有的预设 LoRA 不会被灌进工作流，因此不该算阻塞项。
    """
    from .image_gen_files import get_settings

    cfg = skill_config(skill_id)
    default = get_settings()
    if kind == "video":
        from .video_gen import get_video_settings

        default.update(get_video_settings())
    out = {}
    for field in IMAGE_FIELDS:
        out[field] = str(cfg.get(field) or default.get(field) or "").strip()
    if kind == "video":
        for field in ("model", "text_encoder", "vae", "audio_vae"):
            out[field] = str(cfg.get(field) or default.get(VIDEO_SETTING_KEYS[field]) or "").strip()
    raw = cfg.get(LORA_FIELD) if isinstance(cfg.get(LORA_FIELD), list) else (default.get("loras") or [])
    out[LORA_FIELD] = [str(e.get("name") if isinstance(e, dict) else e).strip()
                       for e in raw if str(e.get("name") if isinstance(e, dict) else e).strip()]
    return out



# ---------------------------------------------------------------------------
# 源侧信息：出处表、当前源、授权状态
# ---------------------------------------------------------------------------

def source_entries(entry: dict) -> list:
    """清单出处归一成 [{source, repo, path, gated, is_primary}]；推荐源（sources[0]）排第一。"""
    out = []
    for src in entry.get("sources") or []:
        if not isinstance(src, dict):
            continue
        name = str(src.get("source") or "").strip().lower()
        if name not in SOURCE_LABELS:
            continue
        out.append({"source": name,
                    "repo": str(src.get("repo") or "").strip(),
                    "path": str(src.get("path") or "").strip(),
                    "gated": bool(src.get("gated")),
                    "is_primary": not out})
    return out


def pick_source(source: str = "") -> str:
    """未指定源时取模型库当前选定的源；读不到设置回推荐源 ModelScope。"""
    wanted = str(source or "").strip().lower()
    if wanted in SOURCE_LABELS:
        return wanted
    from .model_hub import load_hub_settings

    current = str(load_hub_settings().get("source") or "").strip().lower()
    return current if current in SOURCE_LABELS else "modelscope"


def source_flags(source: str) -> dict:
    """该源的下载前置：HF 要 token、C 站要 Key；ModelScope 免登录。

    探测只读本地配置文件（token 的有无），不发网络请求 —— 检查页每轮都会算一遍，
    这里联网就是往产品里塞后台轮询。
    """
    if source == "huggingface":
        from .model_hub import load_hub_settings

        has_token = bool(str(load_hub_settings().get("hf_token") or "").strip())
        return {"label": SOURCE_LABELS["huggingface"], "needs_token": True, "has_token": has_token}
    if source == "civitai":
        from . import civitai

        return {"label": SOURCE_LABELS["civitai"], "needs_token": False, "has_token": bool(civitai.api_key())}
    return {"label": SOURCE_LABELS["modelscope"], "needs_token": False, "has_token": True}


# ---------------------------------------------------------------------------
# 就位检查
# ---------------------------------------------------------------------------

def _lora_config_name(configured: list, filename: str) -> str:
    """在配置的 LoRA 表里找这条清单项对应的名字；表里没有说明它不进工作流。"""
    base = str(filename or "").replace("\\", "/").split("/")[-1].lower()
    for item in configured:
        name = str(item.get("name") if isinstance(item, dict) else item)
        if name.replace("\\", "/").split("/")[-1].lower() == base:
            return name
    return ""


def check_skill(skill_id: str) -> dict | None:
    """预设的模型就位情况；技能目录不存在返回 None，无清单返回 has_manifest=False。

    判定口径跟生成侧对齐：配置写死了模型名就按那个相对名精确查（resolve_model 找不到就是硬报错），
    名留空才按清单推荐名 + 族系变体名在类别树里认。LoRA 只有配置里真的有才计入阻塞。
    """
    from .skill import _skill_dir

    sid = str(skill_id or "").strip()
    if not _skill_dir(sid):
        return None
    manifest = resolve_skill_models(sid)
    if not manifest.get("files"):
        return {"skill_id": sid, "has_manifest": False, "family": "", "label": "",
                "kind": "image", "files": [], "notes": [], "missing": [],
                "missing_count": 0, "missing_gb": 0.0, "blocked": False}
    wanted = settings_wanted(sid, manifest["kind"])
    files = [_file_state(entry, wanted) for entry in manifest["files"]]
    blocking = [f for f in files if f["active"] and not f["ready"] and not f["optional"]]
    return {"skill_id": sid, "has_manifest": True, "family": manifest["family"],
            "label": manifest["label"], "kind": manifest["kind"], "files": files,
            "notes": [str(n) for n in (manifest.get("notes") or []) if str(n).strip()],
            "missing": [f"{f['label'] or f['filename']}（{f['category']} · {f['gb']} GB）"
                        for f in blocking],
            "missing_count": len(blocking),
            "missing_gb": round(sum(f["gb"] for f in blocking), 2),
            "blocked": bool(blocking)}



def _file_state(entry: dict, wanted: dict) -> dict:
    """单条清单项的就位情况：pinned（配置写死名字）精确查，自动挑选按推荐名 + 族系变体名认。"""
    category = str(entry.get("category") or "").strip()
    filename = str(entry.get("filename") or "").strip().replace("\\", "/")
    field = str(entry.get("field") or "").strip()
    notes = []
    if field == LORA_FIELD:
        cfg_name = _lora_config_name(wanted.get(LORA_FIELD) or [], filename)
        active, pinned = bool(cfg_name), bool(cfg_name)
        found = locate_exact(category, cfg_name)
    else:
        cfg_name = str(wanted.get(field) or "").strip()
        active, pinned = True, bool(cfg_name)
        alts = [str(a) for a in (entry.get("alt") or [])]
        found = locate_exact(category, cfg_name) if cfg_name else locate_by_names(category, [filename] + alts)
    normalized = filename.lower()
    if pinned and cfg_name.replace("\\", "/").lower() != normalized:
        notes.append(f"配置用的是 {cfg_name}，不是预设推荐名")
    if found and found.replace("\\", "/").lower() != normalized:
        notes.append(f"本机落点 {found}，清单推荐 {filename}")
    if pinned and cfg_name and not found:
        notes.append(f"配置写死的 {cfg_name} 不在模型根里")
    return {"field": field, "category": category, "filename": filename,
            "label": str(entry.get("label") or "").strip(),
            "gb": round(float(entry.get("gb") or 0), 2),
            "sources": source_entries(entry), "alt": [str(a) for a in (entry.get("alt") or [])],
            "pinned": pinned, "wanted": cfg_name, "found": found,
            "ready": bool(found), "active": active, "optional": bool(entry.get("optional")),
            "notes": notes}


def family_files(files: list) -> list:
    """同族文件的并集：按 (类别, basename 小写) 去重，同族多预设的体积只算一次；无名条目跳过。"""
    merged, seen = [], set()
    for f in files:
        filename = str(f.get("filename") or "").strip()
        if not filename:
            continue
        key = (str(f.get("category") or "").lower(), filename.replace("\\", "/").split("/")[-1].lower())
        if key in seen:
            continue
        seen.add(key)
        merged.append(f)
    return merged


def check_all() -> dict:
    """全部预设按族系聚合的就位总览：文件去重、体积只计一次，缺清单的预设不进表。

    blocking_count 数的是「有模型要补的族系」个数，不是预设个数 —— 同族预设共用基座清单，
    按预设数会把一份缺失重复计给族里每个预设。
    """
    from .skill import scan_skills

    groups, preset_count = {}, 0
    for item in scan_skills():
        if item.get("source") != "presets":
            continue
        chk = check_skill(item.get("id", ""))
        if not chk or not chk["has_manifest"]:
            continue
        preset_count += 1
        group = groups.setdefault(chk["family"], {"family": chk["family"], "label": chk["label"],
                                                 "kind": chk["kind"], "skills": [], "files": []})
        group["skills"].append({"skill_id": chk["skill_id"],
                                "cn_name": str(item.get("cn_name") or chk["skill_id"])})
        group["files"] = family_files(group["files"] + chk["files"])
    families = []
    for group in groups.values():
        gaps = [f for f in group["files"] if f["active"] and not f["ready"] and not f["optional"]]
        families.append({"family": group["family"], "label": group["label"], "kind": group["kind"],
                         "skills": group["skills"], "files": group["files"],
                         "preset_count": len(group["skills"]), "file_count": len(group["files"]),
                         "total_gb": round(sum(f["gb"] for f in group["files"]), 2),
                         "missing_count": len(gaps),
                         "missing_gb": round(sum(f["gb"] for f in gaps), 2),
                         "blocked": bool(gaps)})
    families.sort(key=lambda g: (g["kind"], g["family"]))
    return {"family_count": len(families), "preset_count": preset_count,
            "blocking_count": sum(1 for g in families if g["blocked"]),
            "families": families}


# ---------------------------------------------------------------------------
# 下载计划（只产出模型库现成 payload，不新造下载器）
# ---------------------------------------------------------------------------

def download_plan(skill_id: str, source: str = "", include_optional: bool = False) -> dict:
    """技能缺失文件的下载计划：条目 = 模型库 /neo_model_hub/download 的现成 payload。

    按当前选定源出计划；该源没有这条文件就报 not_on_source 并给出另一源，跨源续传是模型库
    自己的事，这里不自动换源。仓库名 / 仓库内路径 / 落盘子目录都过模型库的校验器；模型库按仓库内
    文件名落盘，与清单推荐名不同名时条目带 note，清单项必须在 alt 里认得它，否则就位检查认不出。
    """
    manifest = resolve_skill_models(str(skill_id or "").strip())
    picked = pick_source(source)
    flags = source_flags(picked)
    if not manifest.get("files"):
        # 无清单也要给全同一套字段：前端按同一形状读，不用为降级分支判空
        return {"skill_id": skill_id, "has_manifest": False, "source": picked, "family": "",
                "label": "", "kind": "image", "notes": [], "source_label": flags["label"],
                "needs_token": flags["needs_token"], "has_token": flags["has_token"],
                "files": [], "missing": [], "missing_gb": 0.0, "total_gb": 0.0}
    state = {(f["category"].lower(), f["filename"].lower()): (f["ready"], f["active"])
             for f in check_skill(skill_id)["files"]}
    items = [item for item in (_plan_item(e, picked, state, include_optional)
                               for e in manifest["files"]) if item]
    downloadable = [i for i in items if i.get("payload")]
    return {"skill_id": skill_id, "has_manifest": True, "family": manifest["family"],
            "label": manifest["label"], "kind": manifest["kind"], "notes": manifest["notes"],
            "source": picked,
            "source_label": flags["label"], "needs_token": flags["needs_token"],
            "has_token": flags["has_token"], "files": items,
            "missing": [f"{i['label'] or i['filename']}（{i['category']} · {i['gb']} GB）"
                        for i in items if not i.get("payload")],
            "missing_gb": round(sum(i["gb"] for i in items if not i.get("payload")), 2),
            "total_gb": round(sum(i["gb"] for i in downloadable), 2)}



def _plan_item(entry: dict, picked: str, state: dict, include_optional: bool) -> dict | None:
    """单条清单项的计划条目；已就位 / 未激活 / 未勾选可选项时返回 None（不进计划）。

    落盘子目录 = 仓库内路径的相对目录，落盘名 = 仓库内文件名，两者都过模型库自己的消毒器，
    payload 直接 POST 给 /neo_model_hub/download 就能开下。
    """
    from .model_hub import (HubError, other_source, sanitize_filename, sanitize_subfolder,
                            validate_civitai_path, validate_path, validate_repo)

    category = str(entry.get("category") or "").strip()
    filename = str(entry.get("filename") or "").strip().replace("\\", "/")
    optional = bool(entry.get("optional"))
    if str(entry.get("field") or "").strip().lower() in ("lora", LORA_FIELD):
        return None  # LoRA 跟随预设/全局配置列表，不进下载计划
    ready, active = state.get((category.lower(), filename.lower()), (False, True))
    if ready or not active or (optional and not include_optional):
        return None
    sources = source_entries(entry)
    base = filename.split("/")[-1]
    item = {"field": str(entry.get("field") or ""), "category": category, "filename": filename,
            "base_name": base, "label": str(entry.get("label") or "").strip(),
            "gb": round(float(entry.get("gb") or 0), 2), "sources": sources,
            "subfolder": subfolder_of(filename)}
    src = next((s for s in sources if s["source"] == picked), None)
    if not src:
        other = other_source(picked)
        item.update({"on_source": False, "reason": "not_on_source",
                     "other_source": next((s["source"] for s in sources if s["source"] == other), "")})
        return item
    repo, path = str(src["repo"]), str(src["path"])
    try:
        if src["source"] == "civitai":
            validate_civitai_path(path)
            subfolder, land = item["subfolder"], base
        else:
            target = validate_path(path)
            validate_repo(repo)
            subfolder = sanitize_subfolder(subfolder_of(target))
            land = sanitize_filename(target.split("/")[-1])
    except HubError as exc:
        item.update({"on_source": True, "reason": "bad_source", "note": f"该出处非法：{exc}"})
        return item
    item.update({"on_source": True, "reason": "", "source": src["source"], "gated": src["gated"],
                 "subfolder": subfolder,
                 "payload": {"source": src["source"], "repo": repo, "path": path,
                             "category": category, "subfolder": subfolder, "filename": land}})
    if land.lower() != base.lower():
        item["note"] = f"仓库文件落盘名 {land} 与配置名 {base} 不同名，就位检查按 {land} 算"
    return item



# ---------------------------------------------------------------------------
# 路由（与模型库同属离线可用能力，见 app/studio_caps.py）
# ---------------------------------------------------------------------------

@routes.get("/neo_skill_models/check")
async def get_skill_models_check(request):
    """预设的模型就位情况。

    查询参数：skill_id（必填）。
    返回：{success, check}；技能不存在 success=False。
    """
    skill_id = str(request.query.get("skill_id") or "").strip()
    if not skill_id:
        return web.json_response({"success": False, "error": "skill_id required"})
    check = check_skill(skill_id)
    if check is None:
        return web.json_response({"success": False, "error": f"技能不存在: {skill_id}"})
    return web.json_response({"success": True, "check": check})


@routes.get("/neo_skill_models/all")
async def get_skill_models_all(request):
    """全部预设按族系聚合的就位总览。

    返回：{success, family_count, preset_count, blocking_count, families}。
    """
    return web.json_response({"success": True, **check_all()})


@routes.post("/neo_skill_models/plan")
async def post_skill_models_plan(request):
    """技能缺失文件的下载计划（条目可直接喂 /neo_model_hub/download）。

    请求体：{skill_id, source?: modelscope|huggingface|civitai, include_optional?: bool}。
    返回：{success, plan}；无清单时 plan.has_manifest=False。
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    skill_id = str(body.get("skill_id") if isinstance(body, dict) else "").strip()
    if not skill_id:
        return web.json_response({"success": False, "error": "skill_id required"})
    optional = bool(body.get("include_optional")) if isinstance(body, dict) else False
    plan = download_plan(skill_id, body.get("source", "") if isinstance(body, dict) else "", optional)
    return web.json_response({"success": True, "plan": plan})

