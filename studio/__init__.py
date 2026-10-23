# Neo Studio

# 当插件作为 ComfyUI 自定义节点包加载（__package__ 非空）时才注册节点与路由。
# pytest 收集 tests/ 时会把含连字符目录名的 __init__.py 当作顶层 __init__ 模块
# 导入（此时 __package__ 为空），跳过注册即可；ComfyUI 实际加载始终按包导入。
if __package__ not in (None, ""):
    from .util import plugin_version

    # 入口登记的节点清单：模块导入失败时节点会静默消失，加载结束时按清单核对并打印。
    NEO_NODES = {
        "NeoPromptEncoder": "prompts",
        "NeoPromptAgent": "prompts",
        "NeoImageGenEdit": "image_gen_edit",
        "NeoH3VideoDirector": "h3_video_director",
        "NeoH3AddKeyframe": "h3_video_director",
        "NeoH3AddGuides": "h3_video_director",
        "NeoH3AddContext": "h3_video_director",
        "NeoH3SegmentRun": "h3_segment",
        "NeoBundleExpand": "bundle_expand",
        "NeoRefGrid": "ref_grid",
        "NeoGridSplit": "grid_split_node",
    }

    # 桌面端模块：自带 RouteTableDef，handler 只依赖 folder_paths 与文件系统。
    # 这里统一挂进 ComfyUI 路由表（server.add_routes 会一并生成 /api 前缀副本）；
    # 桌面端离线服务复用同一批 handler，不经过 PromptServer。
    from . import (gallery, gallery_lora, gallery_oss, bookmark, lora_tag, skill, llm, recipes,
                   video_gen, image_gen_files, model_hub, backyard, prompt_names)

    from server import PromptServer
    for _mod in (gallery_lora, gallery_oss, gallery, bookmark, lora_tag, skill, llm, recipes,
                 video_gen, image_gen_files, model_hub, backyard, prompt_names):
        for _route in _mod.routes:
            PromptServer.instance.routes.route(_route.method, _route.path, **_route.kwargs)(_route.handler)

    # Import workflow module (workflow repair API; registers /neo_nodes/repair route)
    from . import workflow

    # 右栏智能体代理循环（/neo_agent/run）：工具调用走进程内 MCP 客户端，需要 ComfyUI 运行时，
    # 桌面端离线服务不挂这条路由（app/studio_caps.py 里没有它，离线时回 409）
    from . import agent
    for _route in agent.routes:
        PromptServer.instance.routes.route(_route.method, _route.path, **_route.kwargs)(_route.handler)

    # Import built-in image generation module (registers /neo_image_gen/* generation routes)
    from . import image_gen

    # Import voice generation module (CosyVoice 零样本克隆，独立 /neo_voice/* 路由与任务表)
    from . import voice_gen

    # Import from prompts module
    from .prompts import (
        NODE_CLASS_MAPPINGS as PROMPT_CLASS_MAPPINGS,
        NODE_DISPLAY_NAME_MAPPINGS as PROMPT_DISPLAY_NAME_MAPPINGS,
    )

    # 生图/编辑节点（NeoImageGenEdit，方案 A mini-executor）：按 skill workflow.json 同步生成
    # IMAGE 输出。依赖 image_gen/skill 已加载；导入失败时优雅降级，不阻断其它节点。
    IMAGE_GEN_EDIT_MAPPINGS = {}
    IMAGE_GEN_EDIT_DISPLAY_MAPPINGS = {}
    try:
        from .image_gen_edit import (
            NODE_CLASS_MAPPINGS as IMAGE_GEN_EDIT_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as IMAGE_GEN_EDIT_DISPLAY_MAPPINGS,
        )
    except Exception as e:
        print(f"[Neo Studio] image_gen_edit 节点注册失败（生图/编辑不可用）: {e}")

    # Neo H3 Video Director：以 video_director 配方为参数，逐段生成并拼接成单个含音频 VIDEO。
    # 复用单段 H3 解析/执行链；导入失败时优雅降级。
    H3_DIRECTOR_MAPPINGS = {}
    H3_DIRECTOR_DISPLAY_MAPPINGS = {}
    try:
        from .h3_video_director import (
            NODE_CLASS_MAPPINGS as H3_DIRECTOR_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as H3_DIRECTOR_DISPLAY_MAPPINGS,
        )
    except Exception as e:
        print(f"[Neo Studio] h3_video_director 节点注册失败（分镜视频导演不可用）: {e}")

    # 图片分镜（storyboard）：用生图技能逐段生成关键帧，注册 /neo_video_gen/storyboard_* 路由。
    # 独立于 director 节点运行时；依赖 image_gen/skill/image_gen_edit/recipes 已加载。导入失败时优雅降级。
    try:
        from . import storyboard  # noqa: F401
    except Exception as e:
        print(f"[Neo Studio] storyboard 路由注册失败（图片分镜不可用）: {e}")

    # Neo Bundle Expand：把 NeoPromptAgent 的 BUNDLE 展开成 prompt + image，便于对接官方 MiniMax H3 视频节点。
    # 依赖 prompts/bundles 已加载；导入失败时优雅降级。
    BUNDLE_EXPAND_MAPPINGS = {}
    BUNDLE_EXPAND_DISPLAY_MAPPINGS = {}
    try:
        from .bundle_expand import (
            NODE_CLASS_MAPPINGS as BUNDLE_EXPAND_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as BUNDLE_EXPAND_DISPLAY_MAPPINGS,
        )
    except Exception as e:
        print(f"[Neo Studio] bundle_expand 节点注册失败（BUNDLE 展开不可用）: {e}")

    # Neo Reference Grid：参考图宫格节点，宫格槽位（1~12 运行时可调）→ prompt + BUNDLE + image_1..image_12。
    # 依赖 prompts/bundles 已加载；导入失败时优雅降级。
    REF_GRID_MAPPINGS = {}
    REF_GRID_DISPLAY_MAPPINGS = {}
    try:
        from .ref_grid import (
            NODE_CLASS_MAPPINGS as REF_GRID_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as REF_GRID_DISPLAY_MAPPINGS,
        )
    except Exception as e:
        print(f"[Neo Studio] ref_grid 节点注册失败（9宫格参考图不可用）: {e}")

    # Neo H3 单段生成/重生成（h3_segment.py）：NeoH3SegmentRun 节点 + /neo_video_gen/run_segment* 路由。
    # 走执行队列，节点是为"单段调试"准备的；导入失败时优雅降级。
    H3_SEGMENT_MAPPINGS = {}
    H3_SEGMENT_DISPLAY_MAPPINGS = {}
    try:
        from .h3_segment import (
            NODE_CLASS_MAPPINGS as H3_SEGMENT_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as H3_SEGMENT_DISPLAY_MAPPINGS,
        )
        # 段落拼接（h3_assemble.py）：只注册 /neo_video_gen/segment_clips + assemble_segments* 路由。
        from . import h3_assemble  # noqa: F401
    except Exception as e:
        print(f"[Neo Studio] h3_segment 节点注册失败（单段生成/重生成不可用）: {e}")

    # Neo Studio 独立应用：/neo_studio/* 路由（导演配方整片生成 + 版本信息）；
    # Studio 页面走 /extensions/comfyui-neo-studio/studio/ 静态路由提供，前端复用 web/ 现有模块。
    # 依赖 image_gen/recipes 已加载；导入失败时优雅降级。
    try:
        from . import studio  # noqa: F401
    except Exception as e:
        print(f"[Neo Studio] studio 路由注册失败（Neo Studio 整片生成不可用）: {e}")

    # Neo Grid Split：宫格图拆分节点，一张分镜宫格图 → 各格 IMAGE（行优先）+ 原图内嵌提示词。
    # 复用 grid_split.py 纯像素核心；导入失败时优雅降级。
    GRID_SPLIT_MAPPINGS = {}
    GRID_SPLIT_DISPLAY_MAPPINGS = {}
    try:
        from .grid_split_node import (
            NODE_CLASS_MAPPINGS as GRID_SPLIT_MAPPINGS,
            NODE_DISPLAY_NAME_MAPPINGS as GRID_SPLIT_DISPLAY_MAPPINGS,
        )
    except Exception as e:
        print(f"[Neo Studio] grid_split_node 节点注册失败（宫格图拆分不可用）: {e}")

    # Merge all node mappings
    NODE_CLASS_MAPPINGS = {
        **PROMPT_CLASS_MAPPINGS,
        **IMAGE_GEN_EDIT_MAPPINGS,
        **H3_DIRECTOR_MAPPINGS,
        **H3_SEGMENT_MAPPINGS,
        **BUNDLE_EXPAND_MAPPINGS,
        **REF_GRID_MAPPINGS,
        **GRID_SPLIT_MAPPINGS,
    }

    NODE_DISPLAY_NAME_MAPPINGS = {
        **PROMPT_DISPLAY_NAME_MAPPINGS,
        **IMAGE_GEN_EDIT_DISPLAY_MAPPINGS,
        **H3_DIRECTOR_DISPLAY_MAPPINGS,
        **H3_SEGMENT_DISPLAY_MAPPINGS,
        **BUNDLE_EXPAND_DISPLAY_MAPPINGS,
        **REF_GRID_DISPLAY_MAPPINGS,
        **GRID_SPLIT_DISPLAY_MAPPINGS,
    }

    _missing = [f"{name}({NEO_NODES[name]})" for name in NEO_NODES if name not in NODE_CLASS_MAPPINGS]
    _no_display = sorted(set(NODE_CLASS_MAPPINGS) - set(NODE_DISPLAY_NAME_MAPPINGS))
    _status = f"[Neo Studio] v{plugin_version()} 已注册 {len(NODE_CLASS_MAPPINGS)}/{len(NEO_NODES)} 个节点"
    if _missing:
        _status += f"，缺失: {', '.join(_missing)}"
    if _no_display:
        _status += f"，缺显示名: {', '.join(_no_display)}"
    print(_status)

# Web directory for frontend extensions
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]