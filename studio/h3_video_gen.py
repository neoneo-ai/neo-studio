"""MiniMax H3 视频生成的共享 helper：解析单次生成请求为模板参数、渲染 skill workflow.json 模板、校验 VDN 插件。

供 NeoH3VideoDirector（配方多段 / BUNDLE 单段）复用；本模块不再注册节点。
- resolve_video_params：把一次视频生成请求解析成模板参数（模型/编码器/VAE/音频 VAE/LoRA/参考媒体/尺寸/时长/seed）。
- _gen_video_skills / _resolve_skill_id：列出带 workflow.json 的视频 skill、按 cn_name/name 反查 id。
- _require_vdn_plugin：VDN 加速 skill 依赖可选插件 ComfyUI-VDN-H3，未装时给出明确报错。
- 模板渲染与进程内执行复用 image_gen.render_template 与 image_gen_edit.execute_graph_inprocess（由调用方引入）。
"""

import random

import nodes as comfy_nodes

from .h3_prompt_audit import reference_tags
from .image_gen import _reference_name, _resolve_loras, render_template, resolve_model
from .video_gen import get_video_settings, suggest_audio_vae, suggest_video_model
from .skill import load_skill_workflow, scan_skills


def _gen_video_skills():
    """带 workflow.json 的视频生成 skill（scan_skills 保证 name 非空，缺省回退 id）。"""
    return [s for s in scan_skills() if s.get("gen_video") and load_skill_workflow(s["id"])]


def _skill_label(s):
    """skill 下拉显示名：cn_name（中文名）优先；不可用的视频技能带「（不可用）」后缀。"""
    label = s.get("cn_name") or s["name"]
    if s.get("available") is False:
        label += "（不可用）"
    return label


def _default_video_skill(vskills):
    """默认 skill：可用技能里取采样步数最少者（gen_config 摘要缺省按运行时默认 20）；都不可用时在全列表里取步数最少者。"""
    pool = [s for s in vskills if s.get("available") is not False] or vskills
    if not pool:
        return None
    return min(pool, key=lambda s: int((s.get("gen_config") or {}).get("steps") or 20))


def _resolve_skill_id(value):
    """skill 下拉显示 skill cn_name（中文名，不可用带「（不可用）」后缀）；反查真实 id，找不到则按 id/name 直接用（兼容旧工作流存的 id / 名称）。"""
    by_key = {}
    for s in _gen_video_skills():
        by_key[s["id"]] = s["id"]
        if s.get("cn_name"):
            by_key[s["cn_name"]] = s["id"]
        if s.get("name") and s["name"] != s["id"]:
            by_key[s["name"]] = s["id"]
        by_key[_skill_label(s)] = s["id"]
    v = str(value or "").strip()
    if v.endswith("（不可用）"):
        v = v[: -len("（不可用）")]
    return by_key.get(v, v)


# 单次请求允许覆盖的技能配置键（与 image_gen._OVERRIDE_KEYS 同一口径）：视频页自定参数面板的
# 非空值进请求体；空项跳过 = 这一发继续跟着技能 config 与全局生视频设置
_VIDEO_OVERRIDE_KEYS = ("model", "text_encoder", "vae", "audio_vae", "loras", "steps")


def is_multiframe_skill(value) -> bool:
    """该 skill（name 或 id）是否标记为多帧单次（frontmatter multi_frame: true）。"""
    if not value:
        return False
    v = str(value).strip()
    return any(s.get("multi_frame") and (s["id"] == v or s["name"] == v) for s in scan_skills())


def _first_nonempty(*vals):
    for v in vals:
        s = str(v or "").strip()
        if s:
            return s
    return ""


H3_FPS = 24

# MiniMaxH3ReferenceToVideo 三类参考的上限（与官方 autogrow 槽位一致）
_MAX_REF = {"image": 9, "video": 3, "audio": 3}


def _seconds_to_frames(seconds):
    """秒 → H3 帧数：按 24fps 取整后向上对齐到模型的 17k+5 网格（官方模板同款公式）。"""
    n = max(5, round(seconds * H3_FPS))
    return n + (5 - (n % 17)) % 17


def resolve_video_params(body: dict, cfg: dict, skip_model: bool = False) -> dict:
    """把一次视频生成请求解析成模板参数；非法时抛 ValueError（消息可直接回前端）。

    cfg 为 skill 的 config.json：model/text_encoder/vae 优先取 cfg，缺省回落到独立「生视频模型」
    设置（video_gen.json / get_video_settings），仍空则按 H3 名称线索自动挑选；width/height/length 缺省用 H3 默认。
    请求体里 _VIDEO_OVERRIDE_KEYS 的非空值先并入 cfg（视频页自定参数面板本发临时换的模型 / LoRA / 步数）。
    skip_model=True 时跳过主模型解析/校验（外部 MODEL 注入模式，内部 UNETLoader 会被剪掉）。
    """
    prompt_text = str(body.get("prompt") or "").strip()
    if not prompt_text:
        raise ValueError("提示词为空")

    # 会话页自定参数面板本发填的覆盖值先并进技能配置：空值跳过 = 这一发跟着技能配置与全局生视频设置走，
    # 下面每条解析只看合并后的 cfg，回退链一律不变
    cfg = dict(cfg)
    for key in _VIDEO_OVERRIDE_KEYS:
        if body.get(key):
            cfg[key] = body[key]

    # H3 模型/文本编码器/VAE：skill config.json 优先，回落到独立「生视频模型」设置（video_gen.json），
    # 仍空则按 H3 名称线索自动挑选（与生图 suggest_model 一致）；都拿不到才报错
    vs = get_video_settings()
    model = ""
    if not skip_model:
        model = _first_nonempty(cfg.get("model"), vs.get("video_model")) or suggest_video_model("diffusion_models")
        if not model:
            raise ValueError("未找到 H3 视频模型：diffusion_models 里没有 h3 模型，且未在设置或 skill config.json 指定")
    encoder = _first_nonempty(cfg.get("text_encoder"), vs.get("video_text_encoder")) or suggest_video_model("text_encoders")
    if not encoder:
        raise ValueError("未找到 H3 视频 Text Encoder：text_encoders 里没有 h3 模型，且未在设置或 skill config.json 指定")
    vae = _first_nonempty(cfg.get("vae"), vs.get("video_vae")) or suggest_video_model("vae")
    if not vae:
        raise ValueError("未找到 H3 视频 VAE：vae 里没有 h3_video 模型，且未在设置或 skill config.json 指定")
    if not skip_model:
        model, err = resolve_model("diffusion_models", model)
        if err:
            raise ValueError(err)
    encoder, err = resolve_model("text_encoders", encoder)
    if err:
        raise ValueError(err)
    vae, err = resolve_model("vae", vae)
    if err:
        raise ValueError(err)
    # H3 音频是独立 VAE（MiniMaxH3AudioVAE），必须单独加载；VAEDecodeAudio 不能复用视频 VAE
    audio_vae = _first_nonempty(cfg.get("audio_vae"), vs.get("video_audio_vae")) or suggest_audio_vae()
    if not audio_vae:
        raise ValueError("未找到 H3 音频 VAE：vae 里没有 h3 audio 模型，且未在 skill config.json 指定")
    audio_vae, err = resolve_model("vae", audio_vae)
    if err:
        raise ValueError(err)
    # LoRA：复用生图解析（校验存在性 + 强度裁剪）；视频无「依赖参考图」概念，配置的全部无条件加载
    loras, _lora_warns = _resolve_loras(cfg)

    # 参考媒体：按 media（缺省 image）分成参考图 / 参考视频 / 参考音频三组，
    # 各自按 H3 参考节点上限裁剪；第一张参考图同时作为单路 {{REF_IMAGE}} 首帧。
    refs = body.get("references")
    refs = refs if isinstance(refs, list) else ([refs] if refs else [])
    ref_images, ref_videos, ref_audios = [], [], []
    buckets = {"image": ref_images, "video": ref_videos, "audio": ref_audios}
    for src in refs:
        media = str(src.get("media") or "image").strip().lower() if isinstance(src, dict) else "image"
        bucket = buckets.get(media)
        if bucket is None or len(bucket) >= _MAX_REF[media]:
            continue
        name = _reference_name(src, media)
        if name:
            bucket.append(name)

    # 尾帧（首尾帧技能）：单项可选，未给或解析失败时为 None（模板里对应 LoadImage 会被裁掉）
    last_src = body.get("last_frame")
    ref_last = _reference_name(last_src, "image") if isinstance(last_src, dict) else None

    width = int(body.get("width") or cfg.get("width") or 1344)
    height = int(body.get("height") or cfg.get("height") or 768)
    length = int(body.get("length") or cfg.get("length") or 124)
    steps = int(cfg.get("steps") or 20)   # 采样步数：skill config.json 可配，默认 20

    seed = body.get("seed")
    seed = random.randint(0, 2**63 - 1) if seed is None else max(0, int(seed))

    return {
        "prompt": prompt_text,
        "model": model,
        "text_encoder": encoder,
        "vae": vae,
        "audio_vae": audio_vae,
        "loras": loras,
        "width": width,
        "height": height,
        "length": length,
        "steps": steps,
        "seed": seed,
        "ref_name": ref_images[0] if ref_images else None,
        "ref_last": ref_last,
        "ref_images": ref_images,
        "ref_videos": ref_videos,
        "ref_audios": ref_audios,
    }


# MiniMaxH3ReferenceToVideo 的参考槽（autogrow 点号键 ref_images.ref_image_N）有值就进条件；
# <Picture N>/<Video N>/<Audio N> 只说明这一路参考用来干什么，缺标签不影响条件化。补一行是为了给
# 参考一个明确的语义角色：同 seed 下补与不补的画面构图一致，差别只在参考挂没挂上。
_REFERENCE_NODE = "MiniMaxH3ReferenceToVideo"
# (params 里的参考分组, 标签类型, 该类型在提示词里承担的作用)
_REF_TAG_KINDS = (("ref_images", "Picture", "外观与空间结构"),
                  ("ref_videos", "Video", "运镜与时间结构"),
                  ("ref_audios", "Audio", "音色"))


def ensure_reference_tags(template: dict, params: dict) -> None:
    """参考挂上了、提示词却没有该类型标签时，追加一行指代（就地改 params["prompt"]）。

    只对含 MiniMaxH3ReferenceToVideo 的模板生效：只有这个节点的 ref_* 槽会被模型读到；图生 /
    首尾帧技能的首帧走 first_frame 锚点，不需要标签，补了反而会多出没有指代对象的标签。
    模板没声明某类型的槽位时也不加——那条加载链会被 render_template 整条裁掉，加了就是悬空标签。
    编号与 h3_prompt_audit.context_media_tags 一致：同类型第 N 个参考（1 基）。
    """
    slotted = set()
    for node in template.values():
        if isinstance(node, dict) and node.get("class_type") == _REFERENCE_NODE:
            for key in (node.get("inputs") or {}):
                head = key.split(".", 1)[0]
                if head in ("ref_images", "ref_videos", "ref_audios"):
                    slotted.add(head)
    if not slotted:
        return
    tags = reference_tags(params["prompt"])
    clauses = []
    for key, label, role in _REF_TAG_KINDS:
        names = params.get(key) or []
        if not names or key not in slotted or any(t.startswith(f"<{label} ") for t in tags):
            continue
        items = "、".join(f"<{label} {i}>" for i in range(1, len(names) + 1))
        clauses.append(f"{items} 作{role}参考")
    if clauses:
        params["prompt"] += "\n参考素材：" + "；".join(clauses) + "。"


def _require_vdn_plugin(graph):
    """VDN 加速 skill 依赖可选插件 ComfyUI-VDN-H3；未安装时给出明确提示，而非通用的「未知节点」错误。"""
    missing = sorted(
        ct for ct in {n.get("class_type") for n in graph.values()}
        if ct and ct.startswith("ApplyVDNH3") and ct not in comfy_nodes.NODE_CLASS_MAPPINGS
    )
    if missing:
        raise RuntimeError(
            f"[Neo Studio] 该 skill 需要 VDN 加速插件 ComfyUI-VDN-H3（节点 {', '.join(missing)} 未注册）。"
            "请安装该插件并重启 ComfyUI 后重试，或改用非 VDN 的 H3 skill。")
