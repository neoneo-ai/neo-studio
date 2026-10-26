// Neo Gallery 卡片「生成九宫格分镜图」：原图当参考 + 宫格指令，产物落独立 grid 目录，
// 供导演编辑器「宫格分镜图拆分」按行优先切成视频关键帧。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, sleep, click, sseResponse } from "./setup.mjs";
import { dispatchApiEvent } from "./mocks/comfy-api.mjs";
import { app, resetSidebarTab } from "./mocks/comfy-app.mjs";

const STORY = "雨夜的地铁口，她收起伞抬头，看见多年未见的他站在灯下。";

// 各宫格 skill 模板内容（模拟 /rs_prompts/load_skill 返回）
const GRID_TEMPLATES = {
    storyboard_grid_4: "创建一张横向真人四宫格制作故事板，两行两列（2 columns × 2 rows），均匀细白缝分隔，外框干净。\n\n【身份锚定】<image1> 是唯一人物身份与身材来源。\n\n【格式要求】\n- 四格按阅读顺序编号 S01–S04。\n\n{story}\n\n【禁止事项】\n- 画面内不出现任何文字、字幕、水印、logo、编号。",
    storyboard_grid_6: "<!-- @story-writer -->\n【故事编写】只输出 {story} 处应填入的正文。\n<!-- @end -->\n\n创建一张横向真人六宫格制作故事板，两行三列（3 columns × 2 rows），均匀细白缝分隔，外框干净；只能生成要求的两行三列数，不能多生成或少生成画面。\n\n【身份锚定】<image1> 是唯一人物身份与身材来源。\n\n【格式要求】\n- 六格按阅读顺序编号 S01–S06。\n\n<!-- @story-writer -->\n【编排模板】左上S01（使用 <image1>）：〔景别〕。〔画面描述〕\n<!-- @end -->\n\n{story}\n\n【禁止事项】\n- 画面内不出现任何文字、字幕、水印、logo、编号。",
    storyboard_grid_9: "创建一张横向真人九宫格制作故事板，三行三列（3 columns × 3 rows），均匀细白缝分隔，外框干净。\n\n【身份锚定】<image1> 是唯一人物身份与身材来源。\n\n【格式要求】\n- 九格按阅读顺序编号 S01–S09。\n\n{story}\n\n【禁止事项】\n- 画面内不出现任何文字、字幕、水印、logo、编号。",
};

function mockGridSkillRoutes() {
    mockRoute("/rs_prompts/load_skill", (b) => {
        const id = b && b.id;
        if (GRID_TEMPLATES[id]) {
            return jsonResponse({ id, name: id, content: GRID_TEMPLATES[id], files: [], gen_image: false, requires_ref: false, multi_turn: false, tags: [], category: "task" });
        }
        return jsonResponse({ error: "not found" }, 404);
    });
}

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

function itemByLabel(label) {
    return [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes(label));
}

// 卡片 ⋯ 菜单：gallery 桩只实现本次流程真正用到的成员（弹提示 / 跳目录 / 删除 / 卡片尺寸设置）
function makeGallery(toasts) {
    const jumps = [];
    return {
        jumps,
        gallery: {
            app: { extensionManager: { toast: { add: (t) => toasts.push(t) } } },
            maxThumbnailSize: 320,
            displayLabels: true,
            deleteItem() {},
            showDirectoryStructure(source, path) { jumps.push([source, path]); return Promise.resolve(); },
        },
    };
}

function openMenu(card, gallery) {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "shot", filename: "shot.png" }, "", "Output", anchor);
}

test("buildStoryboardGridRequest：默认 6 宫格（3列×2行），Qwen Image 2.1 + 原图参考 + grid 目录", async () => {
    const { buildStoryboardGridRequest, buildStoryboardGridPrompt } = await import("../../web/gallery-gen.js");
    mockGridSkillRoutes();
    const body = await buildStoryboardGridRequest("NeoAgent/portrait.png", STORY);
    assert.equal(body.skill_id, "qwen_image_21");
    assert.equal(body.width, 2048);   // 每格约 683×384（16:9）
    assert.equal(body.height, 768);   // 默认 6 宫格（3列×2行）
    assert.deepEqual(body.references, [{ kind: "input", value: "NeoAgent/portrait.png" }]);
    assert.deepEqual(body.loras, []);
    assert.equal(body.skip_enhance, true);
    assert.equal(body.output_prefix, "StoryBoard");
    // 模板来自 skill（中文）
    assert.match(body.prompt, /六宫格制作故事板/);
    assert.match(body.prompt, /3 columns × 2 rows/);
    assert.match(body.prompt, /<image1>/);
    assert.match(body.prompt, /雨夜的地铁口/);  // 故事原文进提示词
    // 技能正文里两处 <!-- @story-writer --> 区块（编剧说明 + 编排模板）都不进生图提示词
    assert.doesNotMatch(body.prompt, /@story-writer|【故事编写】|【编排模板】|〔/);
});

test("buildStoryboardGridRequest：4 / 9 宫格布局与提示词", async () => {
    const { buildStoryboardGridRequest } = await import("../../web/gallery-gen.js");
    mockGridSkillRoutes();
    const b4 = await buildStoryboardGridRequest("p.png", STORY, "storyboard_grid_4");
    assert.equal(b4.width, 2048);
    assert.equal(b4.height, 1152);   // 2列×2行，每格约 1024×576
    assert.match(b4.prompt, /四宫格制作故事板/);
    assert.match(b4.prompt, /2 columns × 2 rows/);
    const b9 = await buildStoryboardGridRequest("p.png", STORY, "storyboard_grid_9");
    assert.equal(b9.width, 2048);
    assert.equal(b9.height, 1152);   // 3列×3行，每格约 683×384
    assert.match(b9.prompt, /九宫格制作故事板/);
    assert.match(b9.prompt, /3 columns × 3 rows/);
});

test("buildStoryboardGridPrompt：故事文本正确插入模板", async () => {
    const { buildStoryboardGridPrompt } = await import("../../web/gallery-gen.js");
    mockGridSkillRoutes();
    const prompt = await buildStoryboardGridPrompt(STORY, 4);
    assert.match(prompt, /雨夜的地铁口/);
    assert.match(prompt, /四宫格制作故事板/);
    // 模板中不应残留 {story} 占位符
    assert.doesNotMatch(prompt, /\{story\}/);
});

test("⋯ 菜单「生成九宫格分镜图」：填故事后带参考图请求生图，窗内出结果预览，点「打开输出目录」跳转", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    mockGridSkillRoutes();
    const toasts = [];
    const { gallery, jumps } = makeGallery(toasts);
    resetSidebarTab();
    app.neoGallery = gallery;   // 「打开输出目录」经侧栏助手走全局画廊实例
    const card = new GalleryCard(gallery);   // 与 gallery.js 的 new GalleryCard(this) 同构
    openMenu(card, gallery);

    const item = itemByLabel("生成九宫格分镜图");
    assert.equal(item?.textContent, "生成九宫格分镜图");
    click(item);
    assert.equal(document.querySelector(".neo-gallery-collect-menu"), null, "菜单应关闭");

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    assert.ok(overlay, "应弹出填故事小窗");
    // 小窗里要有参考图本身（走卡片同一缩略图缓存接口），不能只给一个文件名
    const refImg = overlay.querySelector(".neo-gallery-story-ref-img");
    assert.match(refImg?.getAttribute("src") || "", /\/neo_gallery\/thumbnail\?filename=shot\.png&subfolder=&size=480$/);
    assert.equal(refImg?.getAttribute("alt"), "shot");
    // 预览与卡片图片同高（320 缩略图 - 52 标签保留区），不放大小图
    assert.equal(refImg?.style.height, "268px");
    assert.equal(overlay.querySelector(".neo-gallery-story-ref-label").textContent, "参考图 · 人物沿用这张");
    assert.equal(overlay.querySelector(".neo-gallery-story-path").textContent, "shot.png");
    const genBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成");

    // 空故事：只提示、窗口留着、不发请求
    click(genBtn);
    await sleep(10);
    assert.equal(document.querySelector(".neo-gallery-story-modal-overlay"), overlay);
    assert.match(overlay.querySelector(".neo-gallery-story-hint").textContent, /请先填写/);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_image_gen/generate").length, 0);

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "shot.png" }));
    // 生图前会用参考图细节提取技能跑一次受限视觉调用（人物外形 + 服装），注入提示词做文字锚定
    let detailBody = null;
    mockRoute("/rs_prompts/stream_generate_prompt", (b) => {
        detailBody = b;
        return sseResponse([
            'data: {"text":"黑长直发配红色流苏发绳，高挑纤细；","kind":"content"}',
            'data: {"text":"红金渐变薄纱改良旗袍。","kind":"content"}',
            "data: [DONE]",
        ]);
    });
    let body = null;
    mockRoute("/neo_image_gen/generate", (b) => {
        body = b;
        return jsonResponse({ task_id: "g1", status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/g1", () => jsonResponse({
        task_id: "g1", status: "succeeded",
        images: [{ filename: "nine_panel_storyboard_sheet_00001_.png", subfolder: "StoryBoard/2026-09-24", url: "/x.png" }],
    }));

    overlay.querySelector(".neo-gallery-story-input").value = STORY;
    click(genBtn);
    await sleep(50);

    const copy = fetchLog.find((c) => c.path === "/neo_gallery/copy_to_input");
    assert.ok(copy, "卡片图片应先经 copy_to_input 落到 input/ 当参考图");
    assert.equal(copy.query.get("filename"), "shot.png");
    assert.ok(body, "应发出 /neo_image_gen/generate 请求");
    assert.equal(body.skill_id, "qwen_image_21");
    assert.equal(body.output_prefix, "StoryBoard");
    assert.deepEqual(body.references, [{ kind: "input", value: "shot.png" }]);
    // 参考图细节（人物外形 + 服装）先提取出来注入提示词：模型才知道 <image1> 是谁、穿什么
    assert.equal(detailBody?.skillId, "storyboard_ref_detail", "应先调参考图细节提取技能");
    assert.deepEqual(detailBody?.images, [{ kind: "input", value: "shot.png" }]);
    assert.match(body.prompt, /【参考图人物与服装细节】黑长直发配红色流苏发绳，高挑纤细；红金渐变薄纱改良旗袍。/);

    // 窗口保持打开并显示结果预览（走 thumbnail 缓存接口，size=640），不是点生成就关闭
    assert.equal(document.querySelector(".neo-gallery-story-modal-overlay"), overlay, "生成过程中小窗不关闭");
    const resultImg = overlay.querySelector(".neo-gallery-cs-result-img");
    assert.match(resultImg?.getAttribute("src") || "",
        /\/neo_gallery\/thumbnail\?filename=nine_panel_storyboard_sheet_00001_\.png&subfolder=StoryBoard%2F2026-09-24&size=640$/);

    // 成功不自动跳目录，由「打开输出目录」触发（打开左侧素材栏并跳画廊 StoryBoard 的日期子目录），窗口保持打开
    assert.deepEqual(jumps, [], "成功后不自动跳目录");
    const openDirBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "打开输出目录");
    assert.ok(openDirBtn, "成功后应有「打开输出目录」按钮");
    click(openDirBtn);
    await sleep(10);
    assert.equal(app.extensionManager.sidebarTab.activeSidebarTabId, "neo.gallery", "打开左侧素材面板");
    assert.deepEqual(jumps, [["StoryBoard", ["2026-09-24"]]], "打开归档后的日期子目录");
    assert.equal(document.querySelector(".neo-gallery-story-modal-overlay"), overlay, "打开输出目录后窗口不关闭");
    delete app.neoGallery;
});

test("⋯ 菜单「生成九宫格分镜图」：生成中窗内显示进度条与「取消任务」，故事表单让位", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery([]);
    const card = new GalleryCard(gallery);
    openMenu(card, gallery);
    click(itemByLabel("生成九宫格分镜图"));

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    const genBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成");

    mockGridSkillRoutes();
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "shot.png" }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "g2", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/g2", () => jsonResponse({
        task_id: "g2", status: "running", progress: { value: 3, max: 10 }, images: [],
    }));

    overlay.querySelector(".neo-gallery-story-input").value = STORY;
    click(genBtn);
    await sleep(50);

    assert.equal(document.querySelector(".neo-gallery-story-modal-overlay"), overlay, "生成中小窗保持打开");
    assert.equal(overlay.querySelector(".neo-gallery-story-form").style.display, "none", "生成中故事表单让位给进度区");
    const fillEl = overlay.querySelector(".neo-gallery-cs-progress-fill");
    assert.equal(fillEl?.style.width, "30%", "进度条按 progress.value/max 填充");
    assert.ok([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "取消任务"), "生成中可取消任务");

    // 派发终态让 watcher 收尾（不留悬挂监听/定时器），窗内转为错误/重试态
    dispatchApiEvent("rs.image_gen.status", { task_id: "g2", status: "cancelled" });
    await sleep(10);
    assert.equal(document.querySelector(".neo-gallery-story-modal-overlay"), overlay, "取消后小窗仍在");
    assert.match(overlay.querySelector(".neo-gallery-cs-status .neo-gallery-story-hint").textContent, /已取消/);
    assert.ok([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "重试"), "可重试");
});

test("⋯ 菜单「生成九宫格分镜图」：生图失败弹 action toast 引导去技能详情，窗内留错误可重试", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery([]);
    const card = new GalleryCard(gallery);
    openMenu(card, gallery);
    click(itemByLabel("生成九宫格分镜图"));

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    const genBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成");

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "shot.png" }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "g3", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/g3", () => jsonResponse({ task_id: "g3", status: "running" }));

    overlay.querySelector(".neo-gallery-story-input").value = STORY;
    click(genBtn);
    await sleep(50);

    // 派发失败终态：缺模型（非 LLM 报文）
    dispatchApiEvent("rs.image_gen.status", { task_id: "g3", status: "failed", error: "找不到模型 Qwen/qwen_image_2.1.safetensors（diffusion_models）" });
    await sleep(10);

    // 窗内留错误 + 可重试
    assert.equal(document.querySelector(".neo-gallery-story-modal-overlay"), overlay, "失败后小窗仍在");
    assert.match(overlay.querySelector(".neo-gallery-cs-status .neo-gallery-story-hint").textContent, /找不到模型/);
    assert.ok([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "重试"), "可重试");

    // 另弹 action toast：引导去技能详情修模型
    const toast = [...document.querySelectorAll(".neo-at")].at(-1);
    assert.ok(toast, "应弹 action toast");
    assert.equal(toast.querySelector(".neo-at-summary").textContent, "九宫格分镜图生成失败");
    assert.equal(toast.querySelector(".neo-at-detail").textContent, "找不到模型 Qwen/qwen_image_2.1.safetensors（diffusion_models）");
    assert.equal(toast.querySelector(".neo-at-action").textContent, "打开技能详情");
});

test("小窗「LLM 生成分镜故事」：简要故事按所选宫格技能生成逐格故事（不带参考图），覆盖写入上方故事框", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const toasts = [];
    const { gallery } = makeGallery(toasts);
    const card = new GalleryCard(gallery);
    openMenu(card, gallery);
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "storyboard_grid_4", name: "四宫格分镜提示词模板", category: "task" },
        { id: "storyboard_grid_6", name: "六宫格分镜提示词模板", category: "task" },
        { id: "storyboard_grid_9", name: "九宫格分镜提示词模板", category: "task" },
    ]));
    click(itemByLabel("生成九宫格分镜图"));

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    assert.ok(overlay, "应弹出填故事小窗");
    const llmBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")]
        .find((b) => b.textContent === "LLM 生成分镜故事");
    assert.ok(llmBtn, "应有「LLM 生成分镜故事」按钮");
    // 现有输入框（九宫格故事）下面还要有个「简要故事 / 想法」输入框
    const ideaBox = overlay.querySelector(".neo-gallery-story-idea");
    assert.ok(ideaBox, "九宫格故事框下面应有简要故事输入框");
    // 宫格技能下拉：异步加载后默认 storyboard_grid_6
    const gridSel = overlay.querySelector(".neo-gallery-story-grid");
    assert.ok(gridSel, "应有宫格技能下拉");
    await sleep(10);
    assert.equal(gridSel.value, "storyboard_grid_6", "默认 6 宫格技能");
    gridSel.value = "storyboard_grid_9";   // 选九宫格 → 编故事与生图都走这个技能

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "shot.png" }));
    let llmBody = null;
    mockRoute("/rs_prompts/stream_generate_prompt", (b) => {
        if (b.skillId === "storyboard_ref_detail") {
            return sseResponse([
                'data: {"text":"黑长直发配红色流苏发绳，高挑纤细；红金渐变薄纱改良旗袍。","kind":"content"}',
                "data: [DONE]",
            ]);
        }
        llmBody = b;
        return sseResponse([
            'data: {"text":"雨夜的地铁口，她收起伞仰望。","kind":"content"}',
            'data: {"text":"\\n他站在灯下，两人相望。","kind":"content"}',
            "data: [DONE]",
        ]);
    });

    overlay.querySelector(".neo-gallery-story-input").value = "我手写的旧故事";
    ideaBox.value = "雨夜地铁口偶遇旧友";
    click(llmBtn);
    await sleep(50);

    assert.ok(llmBody, "应调用 /rs_prompts/stream_generate_prompt");
    assert.equal(llmBody.skillId, "storyboard_grid_9", "编故事用所选宫格技能（不再固定 storyboard_story）");
    // 先用 storyboard_ref_detail 取出参考图的人物外形 + 服装，作为**文字**一起交给编剧（不给图，避免反推多视图）
    assert.equal(llmBody.text, "参考图人物外形与服装：黑长直发配红色流苏发绳，高挑纤细；红金渐变薄纱改良旗袍。\n\n雨夜地铁口偶遇旧友（按 9 格分镜）");
    assert.equal(llmBody.images, undefined, "不把参考图交给编剧（只给文字描述）");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_gallery/copy_to_input").length, 1, "参考图落盘一次，供细节提取用");

    // 生成结果覆盖写入上方故事框（不是追加），供继续编辑后再「生成」
    assert.equal(overlay.querySelector(".neo-gallery-story-input").value, "雨夜的地铁口，她收起伞仰望。\n他站在灯下，两人相望。");
    assert.match(overlay.querySelector(".neo-gallery-story-hint").textContent, /已生成分镜故事/);
    assert.equal(llmBtn.disabled, false, "完成后按钮应恢复可用");
    assert.equal(llmBtn.textContent, "LLM 生成分镜故事");
});

test("小窗「LLM 生成分镜故事」：简要故事留空则按格数自行编故事（细节提取为空时不给人物描述）", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery([]);
    const card = new GalleryCard(gallery);
    openMenu(card, gallery);
    click(itemByLabel("生成九宫格分镜图"));

    const overlay = document.querySelector(".neo-gallery-story-modal-overlay");
    const llmBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")]
        .find((b) => b.textContent === "LLM 生成分镜故事");

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "shot.png" }));
    let llmBody = null;
    mockRoute("/rs_prompts/stream_generate_prompt", (b) => {
        // 细节提取返回空（没有视觉模型 / 出错）：编剧只拿格数，照常编故事
        if (b.skillId === "storyboard_ref_detail") return sseResponse(["data: [DONE]"]);
        llmBody = b;
        return sseResponse([
            'data: {"text":"她把伞收好，走向灯下。","kind":"content"}',
            "data: [DONE]",
        ]);
    });

    overlay.querySelector(".neo-gallery-story-idea").value = "   ";   // 只输空格 = 没填
    click(llmBtn);
    await sleep(50);

    assert.ok(llmBody, "留空也应调用 LLM");
    assert.equal(llmBody.skillId, "storyboard_grid_6", "技能列表拉不到时回退到默认宫格技能");
    assert.equal(llmBody.text, "自行编一个完整故事——有开端、发展、结尾，每格不同场景与不同动作（按 6 格分镜）", "留空时只带格数 + 明确要编剧情");
    assert.equal(llmBody.images, undefined, "编故事不带参考图");
    assert.equal(overlay.querySelector(".neo-gallery-story-input").value, "她把伞收好，走向灯下。");
});

test("⋯ 菜单：点外部 pointerdown（画布点击）收起，单独 mousedown 不收", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery([]);
    const card = new GalleryCard(gallery);
    openMenu(card, gallery);
    await sleep(10);   // 等外部点击监听注册（setTimeout 0）
    assert.ok(document.querySelector(".neo-gallery-collect-menu"), "菜单应显示");

    // 模拟画布点击：LiteGraph 在 pointerdown 上 preventDefault，兼容 mousedown 被抑制到不了 document
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await sleep(10);
    assert.equal(document.querySelector(".neo-gallery-collect-menu"), null, "外部 pointerdown 应收起菜单");

    // 回归：旧的 mousedown 监听已移除——单独的外部 mousedown 不再关菜单
    openMenu(card, gallery);
    await sleep(10);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await sleep(10);
    assert.ok(document.querySelector(".neo-gallery-collect-menu"), "外部 mousedown 不应收起菜单");
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));   // 清理
});

test("⋯ 菜单定位：优先按钮右侧不挡缩略图，右侧放不下回退到按钮下方", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery([]);
    const card = new GalleryCard(gallery);
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);

    const origRect = Element.prototype.getBoundingClientRect;
    try {
        // jsdom 无布局，给菜单一个假定尺寸（240×300）；窗口默认 1024 宽
        Element.prototype.getBoundingClientRect = function () {
            if (this.classList && this.classList.contains("neo-gallery-collect-menu")) {
                return { left: 0, top: 0, right: 240, bottom: 300, width: 240, height: 300 };
            }
            return origRect.call(this);
        };

        // 情况 1：右侧有空间 → 菜单在按钮右侧，顶部与按钮对齐
        anchor.getBoundingClientRect = () => ({ left: 68, right: 100, top: 20, bottom: 48, width: 32, height: 28 });
        card._showCollectMenu(gallery, { name: "shot", filename: "shot.png" }, "", "Output", anchor);
        let menu = document.querySelector(".neo-gallery-collect-menu");
        assert.equal(menu.style.left, "106px", "菜单左缘 = 按钮右缘 + 6");
        assert.equal(menu.style.top, "20px", "菜单顶部与按钮对齐");
        card._removeCollectMenu();

        // 情况 2：右侧放不下（900+6+240 > 1024-8）→ 回退到按钮下方右对齐
        anchor.getBoundingClientRect = () => ({ left: 868, right: 900, top: 20, bottom: 48, width: 32, height: 28 });
        card._showCollectMenu(gallery, { name: "shot", filename: "shot.png" }, "", "Output", anchor);
        menu = document.querySelector(".neo-gallery-collect-menu");
        assert.equal(menu.style.left, "660px", "回退：右对齐于按钮");
        assert.equal(menu.style.top, "52px", "回退：顶缘 = 按钮底缘 + 4");
        card._removeCollectMenu();
    } finally {
        Element.prototype.getBoundingClientRect = origRect;
    }
});
