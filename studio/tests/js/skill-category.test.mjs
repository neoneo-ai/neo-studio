// 技能下拉分类分组回归：category → optgroup 归属、排序与内部使用分类的隐藏。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv } from "./setup.mjs";

test("populateSkillOptions：增强类排最前，video_gen / task 隐藏", async () => {
    resetEnv();
    const { populateSkillOptions, CATEGORY_LABELS } = await import("../../web/skill.js");

    // 内部使用分类必须定义 hidden（否则 line 里 `CATEGORY_LABELS[s.category] ? ... : "image_enhance"` 会误归类）
    assert.ok(CATEGORY_LABELS.video_gen?.hidden, "video_gen 应为隐藏分类");
    assert.ok(CATEGORY_LABELS.task?.hidden, "task 应为隐藏分类");

    const select = document.createElement("select");
    populateSkillOptions(select, [
        { id: "krea2", name: "Krea2 出图", category: "image_gen" },
        { id: "h3_t2v", name: "H3 文生视频", category: "video_gen" },
        { id: "h3_i2v", name: "H3 图生视频", category: "video_gen" },
        { id: "anime_style", name: "动漫风格", category: "image_enhance" },
        { id: "full_ref", name: "全参考", category: "video_enhance" },
        { id: "reverse_prompt", name: "反推提示词", category: "vision" },
        { id: "story_expand", name: "故事扩写", category: "task" },
        { id: "weird", name: "未知分类", category: "no_such_cat" }, // 回落 image_enhance
    ]);

    const groupOf = (id) => select.querySelector(`option[value="${id}"]`)?.parentElement ?? null;
    const labelOf = (id) => groupOf(id)?.label;

    // 增强类排最前、生图随后；未知分类仍回落 image_enhance
    assert.equal(labelOf("anime_style"), "图像提示词增强");
    assert.equal(labelOf("full_ref"), "视频提示词增强");
    assert.equal(labelOf("krea2"), "直接生图或编辑");
    assert.equal(labelOf("weird"), "图像提示词增强");

    // video_gen / task 隐藏：下拉中无对应 option
    assert.equal(groupOf("h3_t2v"), null);
    assert.equal(groupOf("h3_i2v"), null);
    assert.equal(groupOf("story_expand"), null);

    const order = Array.from(select.querySelectorAll("optgroup")).map((g) => g.label);
    assert.deepEqual(order, [
        "图像提示词增强",
        "视频提示词增强",
        "图像 / 反推",
        "直接生图或编辑",
    ]);
});
