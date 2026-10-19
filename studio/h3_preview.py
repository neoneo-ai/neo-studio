"""H3 实时预览：用 models/vae_approx/taeh3.safetensors 把 H3 潜空间解成真彩动作预览。

核心 latent_preview.get_previewer() 对 H3 只能回退 Latent2RGB —— MiniMaxH3Video 未声明
taesd_decoder_name，且 taeh3 是「96 宽 / 4 次上采样」的扁平 2D TAE，core 的 TAESD.Decoder
建不出来。这里按 checkpoint 的扁平索引重建解码器（同 ComfyUI-KJNodes tiny_vae.py 的做法）。

核心的进度预览通道一步只出一张静图（server.send_image 走 image.save 且只认 JPEG/PNG），
所以这里不用它：每步沿时间轴均匀抽 PREVIEW_FRAMES 帧解成 JPEG 序列，经自有 WS 事件
rs.h3.preview 推给 NeoH3VideoDirector 节点内的动画面板（自动循环 + 暂停/逐帧/逐步）。
同一批解码帧另存一份紧凑档（384 边）给右栏智能体卡片：卡片就这么宽，SSE 只该搬它放得下的尺寸。

NeoH3VideoDirector 逐段执行期间临时替换 latent_preview.get_previewer，执行结束（含异常）
立即还原，不影响画布上其他节点的预览行为。
"""

import base64
import contextlib
import io
import logging

import torch
import torch.nn as nn
from PIL import Image, ImageOps

import comfy.model_management
import comfy.utils
import folder_paths
import latent_preview
from comfy import latent_formats
from comfy.taesd.taesd import Block, Clamp, conv
from server import PromptServer

TINY_VAE = "taeh3.safetensors"
PREVIEW_EVENT = "rs.h3.preview"   # 插件自有预览通道：前端按 node_id 路由到节点内的动画面板
PREVIEW_FRAMES = 8                # 每步沿时间轴均匀抽的帧数
PREVIEW_FPS = 4                   # 面板播放帧率（随载荷带给前端）：8 帧一圈 2 秒，快了就像快放
PREVIEW_SIDE = 1024               # 预览最长边（动图比单图小一档：解码、传输、内存都省）
JPEG_QUALITY = 85
AGENT_PREVIEW_SIDE = 384          # 右栏智能体卡片那一档：卡片就这么宽，全尺寸载荷过 SSE 只是白占带宽
AGENT_JPEG_QUALITY = 70
JPEG_DATA_URL = "data:image/jpeg;base64,"   # 前端拿帧直接塞 <img>.src，载荷里就带好 data URL

_warned = False

_LATEST = {}   # node_id -> 最新预览载荷（前端轮询取帧兜底；_LATEST_CAP 限量，任务终态由调用方清掉）
_LATEST_SMALL = {}   # 同键的紧凑档：右栏智能体卡片经 SSE 逐帧播放只取这一份，WS 与轮询兜底不带上它
_LATEST_CAP = 8


def _store_latest(node_id, payload, small=None):
    _LATEST[node_id] = payload
    if small is not None:
        _LATEST_SMALL[node_id] = small
    while len(_LATEST) > _LATEST_CAP:
        stale = next(iter(_LATEST))
        _LATEST.pop(stale)
        _LATEST_SMALL.pop(stale, None)


def get_latest_preview(node_id, small=False):
    return (_LATEST_SMALL if small else _LATEST).get(node_id)


def clear_latest_preview(node_id):
    _LATEST.pop(node_id, None)
    _LATEST_SMALL.pop(node_id, None)


def _build_decoder(sd):
    """按扁平索引重建 TAE 解码器：缺号按位置补 Clamp(0)/ReLU(2)/Upsample，其余由权重形状定。"""
    by_index = {}
    for k, v in sd.items():
        head, _, rest = k.partition(".")
        if not head.isdigit():
            raise ValueError(f"不是扁平的 TAE 解码器权重（键 '{k}' 意外）")
        by_index.setdefault(int(head), {})[rest] = v

    modules = []
    for i in range(max(by_index) + 1):
        entry = by_index.get(i)
        if entry is None:
            modules.append(Clamp() if i == 0 else nn.ReLU() if i == 2 else nn.Upsample(scale_factor=2))
        elif "conv.0.weight" in entry:
            modules.append(Block(entry["conv.0.weight"].shape[1], entry["conv.0.weight"].shape[0]))
        else:
            w = entry["weight"]
            modules.append(conv(w.shape[1], w.shape[0], bias="bias" in entry))
    return nn.Sequential(*modules)


class H3TinyVAE:
    """只做解码的 taeh3：输出 [0, 1]，与 TAE 家族约定一致。"""

    def __init__(self, sd):
        first = next(iter(sd))
        head = first.split(".")[0]
        if not head.isdigit():   # 权重可能带 "decoder." 之类公共前缀
            prefix = head + "."
            sd = {k[len(prefix):]: v for k, v in sd.items() if k.startswith(prefix)}

        self.device = comfy.model_management.vae_device()
        self.dtype = comfy.model_management.vae_dtype(self.device, [torch.float16, torch.bfloat16])
        self.model = _build_decoder(sd)
        self.model.load_state_dict(sd)
        self.model = self.model.to(device=self.device, dtype=self.dtype).eval()
        self.latent_channels = self.model[1].weight.shape[1]

    def decode_frame(self, latent):
        """[B, C, H, W] -> PIL RGB 图。"""
        out = self.model(latent.to(device=self.device, dtype=self.dtype))
        return latent_preview.preview_to_image(out.to(device=latent.device, dtype=torch.float32)[0].movedim(0, -1), do_scale=False)


def _frame_indices(frames, count):
    """沿时间轴均匀取 count 个帧下标（首尾都取到；帧数不足时全取）。"""
    if frames <= count:
        return list(range(frames))
    if count == 1:
        return [0]
    return [i * (frames - 1) // (count - 1) for i in range(count)]


def _video_frames(x0, channels, count):
    """从 H3 的 AV 潜空间里挑出 taeh3 能解的视频帧序列 [1, C, H, W]；不是视频流则返回 None。

    core 的 prepare_callback 已解开 nested 层（H3 的 tensors[0] 就是视频流 [B, C, T, H, W]），
    这里只按形状与通道数认视频流——音频流是 [B, 32, 2, T]，通道数对不上自然被跳过。
    """
    if x0.ndim == 5:
        batch = x0[:1]
        if batch.shape[1] != channels:
            return None
        return [batch[:, :, i] for i in _frame_indices(batch.shape[2], count)]
    if x0.ndim == 4:
        batch = x0[:1]
        return [batch] if batch.shape[1] == channels else None
    return None


def _preview_payload(images, side=PREVIEW_SIDE, quality=JPEG_QUALITY):
    """帧序列 → 前端载荷：逐帧 JPEG data URL + 播放帧率 + 画面尺寸（前端据此建动画）。"""
    frames = []
    size = (0, 0)
    for img in images:
        if img.width > side or img.height > side:
            img = ImageOps.contain(img, (side, side), Image.Resampling.LANCZOS)
        size = img.size
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=quality)
        frames.append(JPEG_DATA_URL + base64.b64encode(buf.getvalue()).decode("ascii"))
    return {"frames": frames, "fps": PREVIEW_FPS, "w": size[0], "h": size[1]}


def _push_preview(node_id, payload):
    """广播给所有客户端（前端按 node_id 路由到对应面板；Studio 任务由后端回环提交，
    server.client_id 是随机值，定向推永远到不了浏览器页面）。"""
    PromptServer.instance.send_sync(PREVIEW_EVENT, {"node_id": node_id, **payload})


class H3Previewer(latent_preview.LatentPreviewer):
    """H3 段预览：taeh3 真彩、每步抽 PREVIEW_FRAMES 帧，经自有 WS 事件推给节点内动画面板。"""

    def __init__(self, vae, node_id=None, on_step=None):
        self.vae = vae
        self.node_id = node_id
        self._on_step = on_step
        self._step_count = 0

    def decode_latent_to_preview_image(self, preview_format, x0):
        """核心的单图通道这里不用（返回 None，进度条照常推进）：改推多帧载荷给自有面板。"""
        self._step_count += 1
        if self._on_step:
            self._on_step(self._step_count)
        frames = _video_frames(x0, self.vae.latent_channels, PREVIEW_FRAMES)
        if frames is None:
            return None
        try:
            images = [self.vae.decode_frame(frame) for frame in frames]
        except Exception as e:
            logging.warning(f"[Neo Studio] H3 预览解码失败，本步跳过：{e}")
            return None
        if self.node_id:
            payload = {**_preview_payload(images), "step": self._step_count}   # step 供前端按步号去重 / 排序（WS 与轮询兜底同源）
            small = {**_preview_payload(images, AGENT_PREVIEW_SIDE, AGENT_JPEG_QUALITY), "step": self._step_count}
            _store_latest(self.node_id, payload, small)
            _push_preview(self.node_id, payload)
        return None


def load_h3_tiny_vae():
    """加载 taeh3；不可用时返回 None 并只提示一次（预览退回 Latent2RGB，不影响出片）。"""
    global _warned
    path = folder_paths.get_full_path("vae_approx", TINY_VAE)
    if path is None:
        if not _warned:
            _warned = True
            logging.info(f"[Neo Studio] 未找到 models/vae_approx/{TINY_VAE}，H3 预览回退核心默认")
        return None
    try:
        return H3TinyVAE(comfy.utils.load_torch_file(path, safe_load=True))
    except Exception as e:
        if not _warned:
            _warned = True
            logging.warning(f"[Neo Studio] {TINY_VAE} 加载失败（{e}），H3 预览回退核心默认")
        return None


def _is_h3(latent_format):
    return isinstance(latent_format, latent_formats.MiniMaxH3Video)


def _latent2rgb(latent_format):
    """按 latent format 现搭 Latent2RGB：全局预览关闭时也能给出预览图。"""
    if latent_format.latent_rgb_factors is None:
        return None
    return latent_preview.Latent2RGBPreviewer(
        latent_format.latent_rgb_factors,
        getattr(latent_format, "latent_rgb_factors_bias", None),
        getattr(latent_format, "latent_rgb_factors_reshape", None),
    )


@contextlib.contextmanager
def preview_override(enabled, vae, node_id=None, on_step=None):
    """段执行期间接管 H3 预览：关 = 完全不出；开 = taeh3 真彩动作预览（缺 taeh3 则 Latent2RGB 兜底）。

    node_id 是发起本次执行的 NeoH3VideoDirector 节点 id，随载荷推给前端定位面板。
    on_step 是每采样步回调（step_number），供 director 更新进度。
    非 H3 的 latent format 一律交还原实现；退出时（含异常）无条件还原。
    """
    original = latent_preview.get_previewer

    def overridden(device, latent_format):
        if not _is_h3(latent_format):
            return original(device, latent_format)
        if not enabled:
            return None
        return H3Previewer(vae, node_id, on_step) if vae is not None else _latent2rgb(latent_format)

    latent_preview.get_previewer = overridden
    try:
        yield
    finally:
        latent_preview.get_previewer = original