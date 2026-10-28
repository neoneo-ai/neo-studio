# SPDX-License-Identifier: Apache-2.0
"""Neo Studio 桌面端服务的能力边界：哪些插件接口不依赖 ComfyUI 运行时。

桌面端进程里没有 PromptServer / nodes / comfy，只有 folder_paths 与文件系统。路由模块把 handler
挂在各自的 RouteTableDef 上，桌面端按这张表挂载，表外的一律 409 offline，前端据此门控。
判定标准是「这条路由只做文件读写 / 本地检索 / 远程下载」：需要执行队列、显存、节点定义的
都归 ComfyUI，宁可少给离线能力，也不给前端假成功。
"""

# 素材库：浏览 + 写入（删除 / 上传 txt / 清缩略图 / 拷进 input / 目录封面 / 设置）
_GALLERY = {
    ("GET", "/neo_gallery/list"),
    ("GET", "/neo_gallery/css"),
    ("GET", "/neo_gallery/placeholder.png"),
    ("GET", "/neo_gallery/subdirs"),
    ("GET", "/neo_gallery/thumbnail"),
    ("GET", "/neo_gallery/image"),
    ("GET", "/neo_gallery/video"),
    ("GET", "/neo_gallery/audio"),
    ("GET", "/neo_gallery/waveform"),
    ("POST", "/neo_gallery/waveform"),
    ("GET", "/neo_gallery/media_meta"),
    ("GET", "/neo_gallery/txt"),
    ("POST", "/neo_gallery/dir_cover_images"),
    ("GET", "/neo_gallery/get_settings"),
    ("POST", "/neo_gallery/save_settings"),
    ("POST", "/neo_gallery/upload_txt"),
    ("POST", "/neo_gallery/delete"),
    ("POST", "/neo_gallery/clear_thumbnails"),
    ("GET", "/neo_gallery/copy_to_input"),
    ("GET", "/neo_gallery/lora_dirs"),
    ("GET", "/neo_gallery/lora_cache_status"),
    ("POST", "/neo_gallery/lora_retry_failed"),
    ("POST", "/neo_gallery/lora_refresh_dir"),
    ("POST", "/neo_gallery/civitai_test"),
    ("POST", "/neo_gallery/sync_oss"),
    ("GET", "/neo_gallery/oss_status"),
    # LoRA 打标走 8080 LLM 服务，与 ComfyUI 无关
    ("GET", "/neo_gallery/tag_preflight"),
    ("POST", "/neo_gallery/tag_dir"),
}

# 收藏：本地文件 + C 站检索
_BOOKMARK = {
    ("GET", "/neo_bookmark/local"),
    ("POST", "/neo_bookmark/local/add"),
    ("POST", "/neo_bookmark/local/remove"),
    ("POST", "/neo_bookmark/civitai/list"),
    ("POST", "/neo_bookmark/civitai/cover"),
    ("POST", "/neo_bookmark/civitai/resolve"),
    ("POST", "/neo_bookmark/civitai/media"),
    ("GET", "/neo_bookmark/civitai/status"),
    ("GET", "/neo_bookmark/civitai/enabled"),
}

# 技能管理：tasks / presets 目录里的 markdown、config.json、workflow.json
_SKILL = {
    ("GET", "/rs_prompts/skills"),
    ("POST", "/rs_prompts/load_skill"),
    ("POST", "/rs_prompts/save_skill"),
    ("POST", "/rs_prompts/delete_skill"),
    ("POST", "/rs_prompts/reset_skill_config"),
    ("POST", "/rs_prompts/upload_skill"),
    ("POST", "/rs_prompts/load_skill_file"),
    ("POST", "/rs_prompts/save_skill_file"),
    ("POST", "/rs_prompts/delete_skill_file"),
}

# 提示词点名候选：只扫数据根 prompts/ 目录的名字与标签，正文与生成侧那条 list_prompts 不在这里
_PROMPTS = {
    ("POST", "/rs_prompts/list_prompt_names"),
}

# 配方：文件与素材读写；生成 / 拆分 / 送工作流不在这里
_RECIPES = {
    ("POST", "/rs_recipes/list"),
    ("POST", "/rs_recipes/load"),
    ("POST", "/rs_recipes/save"),
    ("POST", "/rs_recipes/copy"),
    ("POST", "/rs_recipes/delete"),
    ("POST", "/rs_recipes/delete_sample"),
    ("POST", "/rs_recipes/delete_result"),
    ("POST", "/rs_recipes/append_results"),
    ("POST", "/rs_recipes/add_results"),
    ("GET", "/rs_recipes/export"),
    ("POST", "/rs_recipes/import"),
    ("GET", "/rs_recipes/asset"),
    ("GET", "/rs_recipes/thumbnail"),
    ("GET", "/rs_recipes/workflow"),
    ("GET", "/rs_recipes/director_spec"),
    ("POST", "/rs_recipes/image_sizes"),
    ("GET", "/rs_recipes/cached_loras"),
    ("POST", "/rs_recipes/save_from_civitai"),
    ("POST", "/rs_recipes/save_from_cached_lora"),
    # 纯 LLM 重写 / 逐格描述 / 故事板分段：依赖 8080 LLM 服务，不依赖 ComfyUI
    ("POST", "/rs_recipes/director_optimize_prompts"),
    ("POST", "/rs_recipes/director_describe_panel"),
    ("POST", "/rs_recipes/director_generate_segments"),
    ("POST", "/rs_recipes/director_modify_segment"),
    # 宫格切分（PIL 切图落 input/）与配方素材拷进 input/：纯文件工作
    ("POST", "/rs_recipes/grid_split"),
    ("POST", "/rs_recipes/send_to_workflow"),
}

# 生图 / 生视频设置与技能配置：configs/*.json 与技能目录
_SETTINGS = {
    ("GET", "/neo_image_gen/settings"),
    ("POST", "/neo_image_gen/settings"),
    ("GET", "/neo_image_gen/models"),
    ("GET", "/neo_image_gen/input_images"),
    ("GET", "/neo_image_gen/skill_workflow"),
    ("GET", "/neo_image_gen/skill_config"),
    ("POST", "/neo_image_gen/skill_config"),
    ("POST", "/neo_image_gen/plan_workflow_skill"),
    ("POST", "/neo_image_gen/save_workflow_skill"),
    ("POST", "/neo_image_gen/update_workflow_skill"),
    ("POST", "/neo_image_gen/update_workflow_skill_preview"),
    ("POST", "/neo_image_gen/copy_skill_files"),
    ("POST", "/neo_image_gen/save_combo_skill"),
    ("GET", "/neo_video_gen/models"),
    ("GET", "/neo_video_gen/settings"),
    ("POST", "/neo_video_gen/settings"),
}

# LLM 配置与标题提取：读写 configs 里的 LLM 配置、扫模型目录、打 8080 与远程服务
_LLM = {
    ("GET", "/rs_prompts/get_models"),
    ("GET", "/rs_prompts/native_models"),
    ("POST", "/rs_prompts/set_model"),
    ("GET", "/rs_prompts/remote_llm_config"),
    ("POST", "/rs_prompts/remote_llm_config"),
    ("POST", "/rs_prompts/llm_connection_test"),
    ("GET", "/rs_prompts/llm_mode"),
    ("POST", "/rs_prompts/extract_title"),
    ("POST", "/rs_prompts/fetch_remote_models"),
}

# 模型库（HF / ModelScope / C 站检索 + 断点续传下载）与 Backyard（OSS 上传管理）
_MODEL_HUB = {
    ("GET", "/neo_model_hub/settings"),
    ("POST", "/neo_model_hub/settings"),
    ("POST", "/neo_model_hub/repos"),
    ("POST", "/neo_model_hub/files"),
    ("POST", "/neo_model_hub/subfolders"),
    ("POST", "/neo_model_hub/download"),
    ("GET", "/neo_model_hub/progress"),
    ("POST", "/neo_model_hub/cancel"),
    ("POST", "/neo_model_hub/civitai/search"),
    ("POST", "/neo_model_hub/civitai/files"),
}

_BACKYARD = {
    ("GET", "/neo-studio-backyard"),
    ("GET", "/neo_backyard/config"),
    ("POST", "/neo_backyard/config"),
    ("POST", "/neo_backyard/preprocess"),
    ("POST", "/neo_backyard/upload"),
    ("GET", "/neo_backyard/upload_plan"),
    ("GET", "/neo_backyard/index"),
    ("GET", "/neo_backyard/dirs"),
    ("POST", "/neo_backyard/delete"),
}

# MCP：外部 MCP 服务的注册表、连接与工具调用。stdio 子进程只活在桌面端进程里，
# 浏览器 spawn 不了，所以这组路由只有桌面端有（app/mcp_routes.py）。
_MCP = {
    ("GET", "/neo_mcp/servers"),
    ("POST", "/neo_mcp/servers"),
    ("POST", "/neo_mcp/connect"),
    ("POST", "/neo_mcp/disconnect"),
    ("GET", "/neo_mcp/tools"),
    ("POST", "/neo_mcp/tools/call"),
}

# 智能体会话落盘与用户级偏好：一次运行的 JSON 在数据根的 agent_sessions/、偏好在 configs/agent_prefs.json，
# 列 / 读 / 删 / 读写偏好都是纯文件读写，ComfyUI 没起来也能读回历史；要内核的 /neo_agent/run、
# /neo_agent/answer 这类不在这组里，仍归 comfy
_AGENT = {
    ("GET", "/neo_agent/sessions"),
    ("GET", "/neo_agent/session"),
    ("POST", "/neo_agent/session/delete"),
    ("POST", "/neo_agent/session/delete_all"),
    ("GET", "/neo_agent/prefs"),
    ("POST", "/neo_agent/prefs"),
}

DESKTOP_ROUTES = (_GALLERY | _BOOKMARK | _SKILL | _PROMPTS | _RECIPES | _SETTINGS | _LLM | _MODEL_HUB
                  | _BACKYARD | _MCP | _AGENT)

# 前端门控用的功能开关：功能 → 代表路由。桌面端服务时该功能可用，否则按钮指向「启动 ComfyUI」。
FEATURE_ROUTES = {
    "image_gen": ("POST", "/neo_image_gen/generate"),
    "agent": ("POST", "/neo_agent/run"),
    "voice": ("POST", "/neo_voice/generate"),
    "segment": ("POST", "/neo_video_gen/run_segment"),
    "director": ("POST", "/neo_studio/director/generate"),
    "simple_video": ("POST", "/neo_video_gen/simple"),
    "grid_split": ("POST", "/rs_recipes/grid_split"),
    "queue": ("GET", "/neo_studio/queue"),
    "memory": ("GET", "/neo_studio/mem_stats"),
    "repair": ("POST", "/neo_nodes/repair"),
    "mcp": ("GET", "/neo_mcp/servers"),
}


def owner(method: str, path: str) -> str:
    """desktop = 桌面端自己就能服务；comfy = 必须 ComfyUI 在跑。"""
    return "desktop" if (method.upper(), path) in DESKTOP_ROUTES else "comfy"


def features() -> dict:
    """当前进程（桌面端）的功能可用性表，随 /neo_studio/version 下发给前端。"""
    return {name: owner(method, path) == "desktop" for name, (method, path) in FEATURE_ROUTES.items()}


def route_list() -> list:
    """DESKTOP_ROUTES 压成 ["GET /neo_gallery/list", ...]，随版本快照下发。

    页面钉在桌面端端口后，comfy 归属的请求由页面自己直连 ComfyUI（app/studio_app.py 的
    comfy_cors）；前端拿这份表判定归属，表就是这张表，不在前端另立第二份清单。"""
    return [f"{method} {path}" for method, path in sorted(DESKTOP_ROUTES)]
