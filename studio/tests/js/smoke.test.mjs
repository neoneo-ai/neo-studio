// L0：导入冒烟 —— 插件模块在 jsdom + ComfyUI 替身下能求值，导出面稳定。
import test from "node:test";
import assert from "node:assert/strict";
import { assertGolden } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

const EXPECTED_EXPORTS = {
    "prompt-manager.js": ["createPromptManagerUI"],
    "dom-utils.js": ["mkEl"],
    "node-behavior.js": ["NodeBehaviors"],
    "skill.js": ["listSkills", "renderMarkdown", "populateSkillOptions", "createSkillDropdown"],
    "llm-setting.js": ["createModelConfigForm"],
    "prompt-service.js": ["savePrompt", "loadPrompt", "listPrompts", "randomPrompt", "fileToBase64", "imagesFromClipboard"],
    "recipes.js": ["collectWorkflowAssets", "saveRecipe", "listRecipes", "deleteRecipe", "applyRecipeToWorkflow", "listVideoSkills", "RECIPE_ICON_SVG"],
    "director.js": ["openDirectorEditor"],
    "combo-box.js": ["attachComboBox"],
    "workflow-context.js": ["collectWorkflowContext"],
    "top-menu.js": ["resetTopMenu"],
    // 生图家族的门面：调用方与测试只认这 17 个名字，实现在 gen-utils.js / t2i-panel.js /
    // image-edit-panel.js / gallery-card-tools.js（拆分时逐字搬迁，导出面不能少一个）
    "gallery-gen.js": [
        "buildGenerationMenuItems", "buildCharacterSheetRequest", "buildStoryboardGridPrompt",
        "buildStoryboardGridRequest", "openStoryboardDialog", "openReversePromptDialog",
        "openLoraTagDialog", "openImageEditDialog", "openGenMaterialDialog", "openImageEditMode",
        "setPaintHost", "chipButton", "skillParamsChip", "reuseModelOverlay",
        "setVideoReuseOpen", "openVideoReuse", "reuseParamsFromMedia",
    ],
};

const modules = {};

test("插件模块可在 jsdom + ComfyUI 替身下导入", async () => {
    for (const [name, expected] of Object.entries(EXPECTED_EXPORTS)) {
        modules[name] = await import(`../../web/${name}`);
        const missing = expected.filter((key) => modules[name][key] === undefined);
        assert.deepEqual(missing, [], `${name} 缺少导出: ${missing.join(", ")}`);
    }
});

test("prompts.js 注册两个节点扩展", async () => {
    await import("../../web/prompts.js");
    assertGolden(
        "extensions.registered",
        appState.extensions.map((e) => e?.name).sort().join("\n"),
    );
});
