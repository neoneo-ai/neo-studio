# SPDX-License-Identifier: Apache-2.0
"""Neo Studio 桌面端服务的能力边界：哪些插件接口不依赖 ComfyUI 运行时。

桌面端进程里没有 PromptServer / nodes / comfy，只有 folder_paths 与文件系统。路由模块把 handler
挂在各自的 RouteTableDef 上，桌面端按这张表挂载，表外的路径由 forwardable() 决定去留：清单内的转给
内核（内核不在时 409 offline），清单外是桌面端没有这条接口（404）。判定标准是「这条路由只做文件读写
/ 本地检索 / 远程下载」：需要执行队列、显存、节点定义的都归 ComfyUI，宁可少给离线能力，也不给前端假成功。
"""

# 表外的路径里允许转发给内核的那一撮：按首段点名，桌面端口不是一台谁都能打的转发器。
# 插件族按前缀收（neo_/rs_ 两族 + ComfyUI 的 /api 别名），ComfyUI 自己的路由逐族点名 ——
# 页面要跑的只有这些：生成 / 队列 / 历史 / 取消 / 出图与取图 / 上传 / 节点定义 / 事件流 /
# 前端设置与主题。/extensions 不在这里：插件 JS 由桌面端自己那份挂载（DESKTOP_ROUTES）。
FORWARD_PREFIXES = ("/neo_", "/rs_", "/api/")
FORWARD_SEGMENTS = frozenset({
    "prompt", "queue", "history", "free", "interrupt", "interrupt-all", "view", "view_image",
    "view_metadata", "folder_info", "upload", "userdata", "models", "object_info",
    "node_def_info", "ws", "internal", "settings", "themes", "workflow", "i18n", "version",
    "docs", "profiler", "audio", "video", "embeddings", "modelmetadata", "runs", "assets",
    "asset", "validation", "validate_prompt",
    # 队列面板的显存条读桌面端自己的 /neo_studio/mem_stats，内存那一格只有内核这条给得出
    "system_stats",
})

# 素材库：浏览 + 写入（删除 / 上传 txt / 清缩略图 / 拷进 input / 目录封面 / 设置）
_GALLERY = {
    ("GET", "/neo_gallery/list"),
    ("GET", "/neo_gallery/kind_items"),
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

# 预设模型自检（studio/skill_models.py）：预设 models.json 的文件层就位检查与双源下载计划，
# 只读文件与模型库设置，不碰 ComfyUI 运行时；实际下载仍走上面那组 /neo_model_hub/* 路由
_SKILL_MODELS = {
    ("GET", "/neo_skill_models/check"),
    ("GET", "/neo_skill_models/all"),
    ("POST", "/neo_skill_models/plan"),
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

# 3D 姿势页（studio/pose.py）：伺服 3d-pose-art 的构建产物 + 与页面之间的桥接口，全在文件层，
# 桌面端进程没有 ComfyUI 运行时也能答。两条静态前缀 /pose-dist/ 与 /models/ 都不在表里：它们由
# 两端各自直接注册（前端在 iframe 内部直接加载 JS / CSS / GLB / wasm，道具注册表与 GLB 的地址是产物
# 按站点根写死的 /models/...，逐条给静态文件打表只会让条目数随构建产物变动），
# 理由见 studio/pose.py 的 register_static。
# 照片估点 / 网格 / pano 要 pose-art 那套 Python sidecar，桌面端起不动它，
# 状态接口的 caps 里这几位是 False，页面据此置灰按钮。场景存档是数据根里的文件，删只走 UI 上选中的
# 那一条 /neo_gallery/delete 式的单条路，没有「清空姿势库」；姿势库（<数据根>/pose/lib）本身只读。
# 素体（caps 的 body_import）归姿势页自己那侧：随包只发授权干净的 CC0 素体，Mixamo 与 SMPL 派生的那几份
# 由用户在页面自己的本地导入区登记。宿主面板只发标准男 / 标准女两具基座，没有自备素体导入这条接口。
# 云端姿势库与云端道具（studio/pose_cloud.py）三条都在文件层 + 公开 GET：索引带 TTL 缓存，
# 取文件落进 <数据根>/pose/oss_cache 后由本机伺服，桌面端离线服务同样答得了。
_POSE = {
    ("GET", "/neo-pose"),
    ("GET", "/neo_pose/status"),
    ("POST", "/neo_pose/export_image"),
    ("POST", "/neo_pose/export_set"),
    ("GET", "/neo_pose/scenes"),
    ("GET", "/neo_pose/scene"),
    ("POST", "/neo_pose/scene"),
    ("GET", "/neo_pose/cloud_status"),
    ("GET", "/neo_pose/cloud_index"),
    ("GET", "/neo_pose/cloud_file"),
}


# 视频抽帧（studio/frames.py）：抽帧在浏览器里做（video seek + canvas 取帧），本机服务只回两样 ——
# 素材库那条视频的分段响应与把抽出来的一帧 PNG 写进 output/Frames。都在文件层，桌面端没有
# ComfyUI 运行时也能答。/neo_frames/video 不用 Gallery 那条整份读进内存的视频响应：没有分段响应
# 时浏览器只会顺序往后读，seek 落回开头，抽出来的帧全是片头那一帧
_FRAMES = {
    ("GET", "/neo_frames/video"),
    ("POST", "/neo_frames/save"),
}

# 任务历史（studio/task_center.py）：顶栏队列面板的持久历史，只读写数据根 SQLite。
# 它不吃 ComfyUI 执行队列；离线窗口打开时靠它把「上一次跑到哪了」铺出来，实时进度仍走内核 WS。
_TASKS = {
    ("GET", "/neo_studio/tasks"),
}

# 手机扫码连接（局域网）：配对页、令牌校验与设置页轮询的二维码数据。只有桌面端服务有这条
# 链路（app/mobile_pair.py + app/studio_server.py），ComfyUI 端口上没有配对页
_PAIR = {
    ("GET", "/neo-studio/pair"),
    ("GET", "/neo-studio/pair/check"),
    ("GET", "/neo-studio/pair/info"),
}

DESKTOP_ROUTES = (_GALLERY | _BOOKMARK | _SKILL | _PROMPTS | _RECIPES | _SETTINGS | _LLM | _MODEL_HUB
                  | _SKILL_MODELS | _BACKYARD | _MCP | _AGENT | _POSE | _FRAMES | _PAIR | _TASKS)

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
    "task_history": ("GET", "/neo_studio/tasks"),
    "memory": ("GET", "/neo_studio/mem_stats"),
    "repair": ("POST", "/neo_nodes/repair"),
    "mcp": ("GET", "/neo_mcp/servers"),
    "pose": ("GET", "/neo_pose/status"),
}


def owner(method: str, path: str) -> str:
    """desktop = 桌面端自己就能服务；comfy = 必须 ComfyUI 在跑。"""
    return "desktop" if (method.upper(), path) in DESKTOP_ROUTES else "comfy"


def forwardable(method: str, path: str) -> bool:
    """这条请求归谁：桌面端表内自服，表外只有这份清单进内核，其余桌面端没有这条接口。

    前缀按整条路径比（"/neo_" 认不出剥掉头斜杠的 "neo_gallery"，插件族就全成 404 了）。"""
    if owner(method, path) == "desktop":
        return False
    first = path.strip("/").split("/")[0]
    return path.startswith(FORWARD_PREFIXES) or first in FORWARD_SEGMENTS


def features(kernel_ready: bool) -> dict:
    """功能可用性表，随 /neo_studio/version 下发给前端。

    创作面恒可用（桌面端自服）；生成面跟着内核就绪翻面 —— 页面钉在桌面端端口上，
    就绪前后是同一个地址，翻面只换能力表与事件流目标（app/studio_server.py 的代理）。"""
    return {name: (name not in KERNEL_FEATURES or kernel_ready)
            for name in FEATURE_ROUTES}


# 要内核的那一撮功能名：FEATURE_ROUTES 里代表路由不在桌面端表内的，从表算，不另立清单
KERNEL_FEATURES = frozenset(name for name, (method, path) in FEATURE_ROUTES.items()
                            if (method, path) not in DESKTOP_ROUTES)
