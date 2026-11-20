# SPDX-License-Identifier: Apache-2.0
# 内嵌元数据里的提示词收集（studio/util.py::_collect_prompt_texts）：出视频的内嵌图里，
# 原文写在视频生成节点的 prompt 输入上，或链在文本原语节点那一侧，两处都得解出来。

import unittest

from studio import util

VIDEO_GRAPH = {
    "4": {"class_type": "MiniMaxH3ImageToVideo",
          "inputs": {"prompt": " 雨夜街角的女孩回头 ", "width": 480, "height": 854,
                     "length": 121, "clip": ["2", 0], "vae": ["3", 0]}},
    "6": {"class_type": "KSampler",
          "inputs": {"seed": 12345, "steps": 20, "cfg": 3.5,
                     "positive": ["4", 1], "negative": ["4", 2]}},
}

CHAIN_GRAPH = {
    "136": {"class_type": "MiniMaxH3ReferenceToVideo",
            "inputs": {"prompt": ["138", 0], "width": 1024, "height": 576}},
    "138": {"class_type": "PrimitiveStringMultiline",
            "inputs": {"value": "镜头缓缓推近，女孩抬手拢发"}},
    "156": {"class_type": "SelfLiftH3Sampler",
            "inputs": {"seed": 7, "positive": ["158", 0], "negative": ["158", 0]}},
    "158": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["136", 2]}},
}

TEXT_KEYS_GRAPH = {
    "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "晴天海边"}},
    "2": {"class_type": "Wan2TextEncode", "inputs": {"negative_prompt": "畸变的手"}},
    "3": {"class_type": "PrimitiveFloat", "inputs": {"value": 1.5}},
    "4": {"class_type": "ComfyMathExpression", "inputs": {"expression": "a*2"}},
}


class TestCollectedPromptTexts(unittest.TestCase):
    def test_video_node_prompt_is_the_prompt(self):
        got = util._collect_prompt_texts(VIDEO_GRAPH)
        self.assertEqual(got["positive"], ["雨夜街角的女孩回头"])
        self.assertEqual(got["negative"], [])

    def test_video_node_params_survive(self):
        params = util._collect_prompt_texts(VIDEO_GRAPH)["params"]
        self.assertEqual(params["width"], 480)
        self.assertEqual(params["length"], 121)
        self.assertEqual((params["seed"], params["steps"], params["cfg"]), (12345, 20, 3.5))

    def test_text_on_a_linked_text_node_is_read_once(self):
        got = util._collect_prompt_texts(CHAIN_GRAPH)
        self.assertEqual(got["positive"], ["镜头缓缓推近，女孩抬手拢发"],
                         "链到文本原语节点要取到原文，源节点自身再遍历一遍不能重复计")
        self.assertEqual(got["negative"], [])

    def test_conditioning_chain_yields_no_text(self):
        self.assertEqual(util._collect_prompt_texts(CHAIN_GRAPH)["negative"], [],
                         "ConditioningZeroOut 这类条件链没有原文，不该编出值来")

    def test_negative_key_goes_negative_and_non_text_values_stay_out(self):
        got = util._collect_prompt_texts(TEXT_KEYS_GRAPH)
        self.assertEqual(got["positive"], ["晴天海边"])
        self.assertEqual(got["negative"], ["畸变的手"])

    def test_empty_graph_shape_is_stable(self):
        for empty in ({}, None):
            self.assertEqual(util._collect_prompt_texts(empty),
                             {"positive": [], "negative": [], "params": {}})


if __name__ == "__main__":
    unittest.main()
