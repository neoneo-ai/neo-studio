# Neo Studio - Bundle 展开节点
# 把 NeoPromptAgent 输出的运行时 BUNDLE（id）展开成官方视频节点可直接消费的输入：
# prompt(STRING) + image_1..image_9(IMAGE)。用于对接官方 MiniMax H3 Reference to Video
# （ref_images 最多 9 张），对接官方节点而不必走内置 NeoH3VideoDirector。bundle 只携带轻量数据
# （提示词文本 + 参考图 data URI），本节点把参考图按输出顺序还原成 IMAGE 张量，
# 未用到的槽位返回空批次占位；同时回传 ui payload（提示词 + 缩略图）供节点内展示。

from __future__ import annotations

import io as _io

import numpy as np
import torch
from PIL import Image

from .bundles import get_bundle
from .image_gen_files import _read_image_raw
from .prompts import MAX_BUNDLE_REFERENCES


def _reference_to_image(src: dict) -> torch.Tensor | None:
    """把 bundle reference（data URI 或 input/output 路径）转成 IMAGE 张量 [1,H,W,C] float 0~1；失败返回 None。"""
    raw = _read_image_raw(src)
    if raw is None:
        return None
    try:
        with Image.open(_io.BytesIO(raw)) as img:
            arr = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    except Exception:
        return None
    return torch.from_numpy(arr).unsqueeze(0)


def _tensor_to_thumb_data_uri(tensor: torch.Tensor, max_side: int = 256) -> str | None:
    """把 [1,H,W,C] float 0~1 张量转成小尺寸 PNG data URI（供节点内展示，控制 ui payload 体积）；失败返回 None。"""
    import base64
    try:
        arr = tensor[0].detach().cpu().numpy()
        arr = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
        img = Image.fromarray(arr)
        w, h = img.size
        if max(w, h) > max_side:
            ratio = max_side / max(w, h)
            img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return None


class NeoBundleExpand:
    """把 Neo Prompt Agent 的 BUNDLE 展开成 prompt + image_1..image_9，对接官方 MiniMax H3 Reference to Video。

    - prompt：bundle 里的主提示词（prompts[0]），无则空串；接官方节点的 prompt 输入。
    - image_1..image_9：bundle 参考图按顺序还原成 IMAGE 张量 [1,H,W,C] float 0~1，对齐 Ref2V 的
      ref_images 槽位（最多 9 张）；只连需要的即可，未用到的槽位返回空批次占位。
    - 节点内展示：执行后在节点里只读显示提示词与参考图缩略图网格（见 web/bundle-expand.js）。
    clip/vae/尺寸/时长等模型侧参数不在 bundle 里，需在官方节点上自行设置。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "bundle": ("STRING", {"forceInput": True,
                                      "tooltip": "NeoPromptAgent / NeoRefGrid 的 BUNDLE 输出（纯连线槽）。"}),  # NeoPromptAgent BUNDLE 输出（纯连线槽）
            },
        }

    RETURN_TYPES = ("STRING",) + ("IMAGE",) * MAX_BUNDLE_REFERENCES
    RETURN_NAMES = ("prompt",) + tuple(f"image_{i}" for i in range(1, MAX_BUNDLE_REFERENCES + 1))
    OUTPUT_NODE = True
    FUNCTION = "expand"
    CATEGORY = "Neo Studio"
    DESCRIPTION = "把 Neo Prompt Agent 的 BUNDLE 展开成 prompt + image_1..image_9，对接官方 MiniMax H3 Reference to Video。"
    SEARCH_ALIASES = [
        "bundle expand", "unpack bundle", "ref2v", "reference to video", "minimax h3",
        "ref images", "unbundle", "展开", "解包", "参考图展开", "官方视频节点", "宫格转参考",
    ]
    OUTPUT_TOOLTIPS = ("bundle 里的主提示词（prompts[0]），接官方 H3 Ref2V 的 prompt。",) + (
        "bundle 参考图按槽位顺序还原的 IMAGE [1,H,W,C]；未连接的槽位为空批次占位。",
    ) * MAX_BUNDLE_REFERENCES

    def expand(self, bundle):
        payload = get_bundle(bundle) or {}

        prompts = payload.get("prompts") or []
        prompt = str(prompts[0]).strip() if prompts else ""

        empty = torch.zeros((0, 1, 1, 3))
        images = [empty] * MAX_BUNDLE_REFERENCES
        thumbs = []
        for i, ref in enumerate(payload.get("references") or []):
            if i >= MAX_BUNDLE_REFERENCES:
                break
            tensor = _reference_to_image(ref)
            if tensor is None:
                thumbs.append(None)  # 坏参考：占位，保持与 image_{i+1} 输出槽位对齐
                continue
            images[i] = tensor
            thumbs.append(_tensor_to_thumb_data_uri(tensor))

        return {
            "ui": {"prompt": [prompt], "images": thumbs},
            "result": tuple([prompt] + images),
        }


NODE_CLASS_MAPPINGS = {"NeoBundleExpand": NeoBundleExpand}
NODE_DISPLAY_NAME_MAPPINGS = {"NeoBundleExpand": "Neo Bundle Expand"}
