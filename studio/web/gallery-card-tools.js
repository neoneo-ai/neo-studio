/**
 * gallery-card-tools.js
 * 素材库专属小窗弹窗：一键角色图（四视图）与九宫格分镜图（产物落 Output/CharacterSheet 与
 * Output/StoryBoard）、图片反推提示词、目录级 LoRA 打标、语音克隆（CosyVoice 零样本）。
 * 输入是素材卡或目录、产物写回素材库目录，与「输入文字出图」的两块生成面板分界：面板在
 * t2i-panel.js 与 image-edit-panel.js，底座在 gen-utils.js，入口在 gallery-gen.js。
 */

import { $el } from "../../../../scripts/ui.js";
import { getImageHeight, getThumbnailSrc, getAudioSrc, renderWaveform, decorativeHeights } from "./gallery-utils.js";
import { openLLMSettingsModal } from "./llm-setting.js";
import { actionToast } from "./toast.js";
import { openSkillDetailById, skillDisplayName } from "./skill.js";
import { Lightbox } from "./lightbox.js";
import { requestGeneration, watchTask, cancelTask, getSkillGenConfig } from "./image-gen.js";
import { requestVoiceGeneration, watchVoiceTask, cancelVoiceTask, buildVoiceRequest, VOICE_SKILL_ID } from "./voice-gen.js";
import { invokePromptStream } from "./prompt-service.js";
import { openGallerySidebar } from "./media-transfer.js";
import { ttlCache } from "./js/core/cache.js";
import { t, tf } from "./js/core/i18n.js";
import { icon, setIconLabel } from "./js/core/icons.js";
import { QWEN_IMAGE_SKILL_ID, makeStoryWindowDraggable, copyImageToInput } from "./gen-utils.js";

// 用所选人像作参考图生成四视图角色设定图，供拖入导演配方的 角色参考图。
const CHARACTER_SHEET_PROMPT = "角色设定多视图：根据参考图中的人物，在一张横版画面中生成四个视图横向并排的角色设定图：第一格为大头特写（肩部以上，突出五官脸型），第二格为正面全身站立，第三格为侧面全身站立，第四格为背面全身站立。严格保持与参考图一致的五官脸型、发型发色、服装配饰和体型比例；全身视图中人物自然站立，双臂下垂，纯白背景，均匀柔光，写实摄影风格，高清细节，画面内不出现文字标注。";
// 角色图输出目录：保存路径的日期段会变成文件名前缀，成品直接落在 Output/CharacterSheet 下。
const CHARACTER_SHEET_DIR = "CharacterSheet";

/** 一键角色图的生图请求体（/neo_image_gen/generate）：固定 Qwen Image 2.1 + 头特写/正/侧/背提示词 + 1920×1080 请求（后端按 Qwen2.1 规则对齐到 32 → 1920×1088）；输出走独立 character 目录 */
export function buildCharacterSheetRequest(refName) {
    return {
        skill_id: QWEN_IMAGE_SKILL_ID,
        prompt: CHARACTER_SHEET_PROMPT,
        width: 1920,
        height: 1080,
        references: [{ kind: "input", value: refName }],
        loras: [],          // 不带全局 LoRA（避免把 Krea2 风格 LoRA 灌进 Qwen 模型）
        skip_enhance: true, // 固定提示词，不走 LLM 增强
        output_prefix: CHARACTER_SHEET_DIR, // 独立输出目录（覆盖全局 output_prefix）
    };
}

// 一键宫格分镜图：原图当参考 + 宫格指令出 N 格故事板，供导演编辑器「宫格分镜图拆分」切成视频关键帧。
// 每格保持约 16:9（够拆完当视频首帧），按布局调整体宽高；默认 6 宫格（2×3）。
const STORYBOARD_DIR = "StoryBoard";
const STORYBOARD_GRID_OPTIONS = [4, 6, 9];
const STORYBOARD_DEFAULT_GRIDS = 6;
// 各宫格数对应的布局与画布尺寸（每格约 16:9）：4=2列×2行、6=3列×2行、9=3列×3行。
const STORYBOARD_LAYOUTS = {
    4: { rows: 2, cols: 2, width: 2048, height: 1152 },   // 每格约 1024×576
    6: { rows: 2, cols: 3, width: 2048, height: 768 },    // 每格约 683×384
    9: { rows: 3, cols: 3, width: 2048, height: 1152 },   // 每格约 683×384
};
const STORYBOARD_GRID_LABELS = { 4: "2列×2行 四宫格", 6: "3列×2行 六宫格", 9: "3列×3行 九宫格" };
// 小窗里的参考图预览尺寸（px，走 /neo_gallery/thumbnail 缓存，不为预览另存大图）
const STORYBOARD_PREVIEW_SIZE = 480;
// 参考图细节提取任务（skills/tasks/storyboard_ref_detail）：受限视觉调用，把参考图里的人物外形 + 服装
// 提取成一两句文字注入生图提示词做文字锚定（只写 "<image1> 指代" 时模型拿不到具体细节）。
const STORYBOARD_REF_DETAIL_SKILL_ID = "storyboard_ref_detail";

function _normalizeGrids(count) {
    return STORYBOARD_GRID_OPTIONS.includes(Number(count)) ? Number(count) : STORYBOARD_DEFAULT_GRIDS;
}

/** 从 skill id（如 storyboard_grid_9）提取宫格数；无法识别时回退默认值 */
function _gridCountFromSkillId(skillId) {
    const m = /storyboard_grid_(\d+)/.exec(skillId || "");
    return m ? _normalizeGrids(Number(m[1])) : STORYBOARD_DEFAULT_GRIDS;
}

// 分镜宫格模板正文缓存：skillId -> 模板；TTL 兜底（技能正文被编辑后不必刷新页面才生效）
const _gridTemplateCache = ttlCache();

async function _loadGridTemplate(skillId) {
    const hit = _gridTemplateCache.get(skillId);
    if (hit !== undefined) return hit;
    try {
        const res = await fetch("/rs_prompts/load_skill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: skillId }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const content = (data.content || "").trim();
        if (content) _gridTemplateCache.set(skillId, content);
        return content || null;
    } catch {
        return null;
    }
}

// 技能正文里 <!-- @story-writer -->…<!-- @end --> 是给 LLM 的编剧说明，进生图提示词前剔除
const STORY_WRITER_SECTION_RE = /<!--\s*@story-writer\s*-->[\s\S]*?<!--\s*@end\s*-->/g;

/** 故事 → 宫格指令：从 skill（storyboard_grid_N）加载模板（去掉编剧区块）后替换 {story} 占位符。
 * refDetail 是参考图人物与服装的文字细节（可空）：有则写在故事开头做文字锚定，模型才知道 <image1> 是谁、穿什么。
 * qwen_image21 分词器会为每张参考图插字面量 <imageN>，所以提示词里可以直接写 <image1>。 */
export async function buildStoryboardGridPrompt(story, count = STORYBOARD_DEFAULT_GRIDS, skillId, refDetail = "") {
    const n = _normalizeGrids(count);
    const layout = STORYBOARD_LAYOUTS[n];
    const sid = skillId || `storyboard_grid_${n}`;
    const raw = await _loadGridTemplate(sid);
    const tpl = raw ? raw.replace(STORY_WRITER_SECTION_RE, "").trim() : raw;
    const body = refDetail ? `【参考图人物与服装细节】${refDetail}\n\n${story}` : story;
    if (tpl && tpl.includes("{story}")) {
        return tpl.replace(/\{story\}/g, () => body);
    }
    // Fallback: 模板未加载成功时使用内联默认
    return `一张 ${STORYBOARD_GRID_LABELS[n]}分镜故事板（${n}-panel storyboard sheet），布局为 ${layout.cols} 列 × ${layout.rows} 行（每行 ${layout.cols} 格，共 ${layout.rows} 行），按阅读顺序（从左到右、从上到下，第 1 格到第 ${n} 格）讲述以下故事：\n`
        + body + "\n"
        + `参考图 <image1> 里的人物就是故事主角：所有格子保持与参考图一致的五官脸型、发型发色、服装配饰与体型比例，场景与画风统一。\n`
        + `要求：布局严格为 ${layout.cols} 列 × ${layout.rows} 行的网格；每格一个镜头，叙事逐格推进；格子之间用均匀细白缝分隔，便于后续自动切分；格子内不出现任何文字、字幕或编号。`;
}

/** 一键宫格分镜图的生图请求体（/neo_image_gen/generate）：Qwen Image 2.1 + 卡片原图作参考图 + 宫格指令；输出走独立 StoryBoard 目录 */
export async function buildStoryboardGridRequest(refName, story, skillId = `storyboard_grid_${STORYBOARD_DEFAULT_GRIDS}`, refDetail = "") {
    const n = _gridCountFromSkillId(skillId);
    const layout = STORYBOARD_LAYOUTS[n];
    return {
        skill_id: QWEN_IMAGE_SKILL_ID,
        prompt: await buildStoryboardGridPrompt(story, n, skillId, refDetail),
        width: layout.width,
        height: layout.height,
        references: [{ kind: "input", value: refName }],
        loras: [],          // 不带全局 LoRA（避免把 Krea2 风格 LoRA 灌进 Qwen 模型）
        skip_enhance: true, // 固定提示词，不走 LLM 增强
        output_prefix: STORYBOARD_DIR, // 独立输出目录（覆盖全局 output_prefix）
    };
}

/** 一键角色图的前置小窗（复用九宫格分镜图同款弹窗结构）：先看参考图确认，点「生成」后
 * 在窗口内显示排队/生图进度与结果预览；Esc 或点遮罩关闭。 */
export function openCharacterSheetDialog(gallery, image, subfolder) {
    document.querySelector('.neo-gallery-cs-modal-overlay')?.remove();
    // 参考图按卡片图片高度显示（与九宫格小窗一致），方便确认用的就是这张
    const previewHeight = getImageHeight(gallery.maxThumbnailSize, gallery.displayLabels);
    const pathLabel = (subfolder ? `${subfolder}/` : "") + (image.filename || image.name || "");

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    const actionsBox = $el("div", { className: "neo-gallery-story-actions" });
    let running = false;         // 防止重复提交
    let cancelId = null;         // 当前任务 id（取消用）
    let cancelRequested = false; // 用户点了「取消任务」
    let refName = null;          // copy_to_input 后的 input 文件名（重试复用，不重复落盘）

    const overlay = $el("div", { className: "neo-gallery-story-modal-overlay neo-gallery-cs-modal-overlay" });
    const close = () => overlay.remove();
    const fill = (box, ...children) => { box.textContent = ""; box.append(...children.filter(Boolean)); };
    const btn = (label, onclick, primary = false) =>
        $el("button", { className: "neo-gallery-story-btn" + (primary ? " neo-gallery-story-btn-primary" : ""), textContent: label, onclick });

    const renderIdle = () => {
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint", textContent: t("将基于这张人像生成头特写 / 正面 / 侧面 / 背面四视图，输出到 Output/CharacterSheet。") }));
        fill(actionsBox, btn(t("取消"), close), btn(t("生成"), start, true));
    };

    const renderRunning = (label, progress) => {
        const hasSteps = !!(progress && progress.max > 0);
        const fillEl = $el("div", { className: "neo-gallery-cs-progress-fill" });
        if (hasSteps) {
            fillEl.style.width = `${Math.max(0, Math.min(100, (progress.value / progress.max) * 100))}%`;
        } else {
            fillEl.classList.add("neo-gallery-cs-progress-indeterminate");
        }
        const bar = $el("div", { className: "neo-gallery-cs-progress" }, [fillEl]);
        fill(statusBox,
            $el("div", { className: "neo-gallery-cs-running" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: label })
            ]),
            bar);
        fill(actionsBox, btn(t("取消任务"), () => { cancelRequested = true; if (cancelId) cancelTask(cancelId); }));
    };

    const renderSuccess = (final) => {
        const images = final.images || [];
        const box = $el("div", { className: "neo-gallery-cs-result" });
        if (images.length > 0) {
            const img = $el("img", {
                className: "neo-gallery-cs-result-img",
                src: `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&size=640`,
                alt: images[0].filename
            });
            img.addEventListener("click", () => Lightbox.open({ items: images.map(im => ({ kind: "image", url: im.url, title: im.filename })), index: 0 }));
            box.appendChild(img);
        }
        const size = final.width && final.height ? ` · ${final.width}×${final.height}` : "";
        fill(statusBox, box, $el("div", { className: "neo-gallery-story-hint", textContent: tf("已生成{size}，可拖入配方的 角色参考图", { size }) }));
        fill(actionsBox, btn(t("打开输出目录"), () => openGallerySidebar(CHARACTER_SHEET_DIR, [])), btn(t("关闭"), close, true));
    };

    const renderError = (message) => {
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: message || t("生成失败") }));
        fill(actionsBox, btn(t("重试"), start), btn(t("关闭"), close));
    };

    const start = async () => {
        if (running) return;
        running = true;
        cancelRequested = false;
        renderRunning(t("排队中…"));
        try {
            if (!refName) refName = await copyImageToInput(image, subfolder);
            const snap = await requestGeneration(buildCharacterSheetRequest(refName));
            cancelId = snap.task_id;
            renderRunning(t("排队中…"));
            const final = await watchTask(snap.task_id, (s) => {
                renderRunning(s.status === "running" ? t("生图中…") : t("排队中…"), s.progress);
            }, () => cancelRequested);
            if (final.status === "succeeded") renderSuccess(final);
            else if (final.status === "cancelled") renderError(t("已取消"));
            else renderError(final.error || t("生成失败"));
        } catch (e) {
            console.error('[Gallery] character sheet generation failed:', e);
            renderError(String(e?.message || e));
        } finally {
            running = false;
            cancelId = null;
        }
    };

    const onKey = (e) => { if (e.key === "Escape") close(); };

    overlay.appendChild($el("div", { className: "neo-gallery-story-modal" }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: t("生成角色图（多视图）") }),
            $el("span", { className: "neo-gallery-story-close", textContent: "\u00D7", onclick: close })
        ]),
        // 参考图直接出缩略图（同一张卡片走同一缓存接口），避免只看到文件名却不确定是哪张
        $el("div", { className: "neo-gallery-story-ref" }, [
            $el("img", {
                className: "neo-gallery-story-ref-img",
                src: getThumbnailSrc(image, subfolder, STORYBOARD_PREVIEW_SIZE),
                alt: image.name || image.filename,
                style: { height: `${previewHeight}px` }
            }),
            $el("div", { className: "neo-gallery-story-ref-info" }, [
                $el("div", { className: "neo-gallery-story-ref-label", textContent: t("参考图 · 人物沿用这张") }),
                $el("div", { className: "neo-gallery-story-path", title: pathLabel, textContent: pathLabel })
            ])
        ]),
        statusBox,
        actionsBox
    ]));

    renderIdle();

    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => { document.removeEventListener("keydown", onKey); origRemove(); };
    document.body.appendChild(overlay);
}

/** 九宫格分镜图的前置小窗（与角色图小窗同款）：上面是分镜故事（可手写，或点「LLM 生成分镜故事」由所选宫格技能
 * + 下方「简要故事 / 想法」+ 参考图流式生成），下面依次是宫格技能下拉与可选的简要故事 / 想法；点「生成」后窗口内显示排队/生图进度与结果预览。 */
export function openStoryboardDialog(gallery, image, subfolder) {
    document.querySelector('.neo-gallery-story-modal-overlay')?.remove();
    // 预览按卡片图片的高度显示：小窗里的参考图和卡片里看到的一样大，方便确认用的就是这张
    const previewHeight = getImageHeight(gallery.maxThumbnailSize, gallery.displayLabels);
    const pathLabel = (subfolder ? `${subfolder}/` : "") + (image.filename || image.name || "");
    const hint = $el("div", { className: "neo-gallery-story-hint" });
    const input = $el("textarea", {
        className: "neo-gallery-story-input",
        rows: 6,
        placeholder: t("例：雨夜的地铁口，她收起伞抬头，看见多年未见的他站在灯下……")
    });
    // 简要故事 / 想法：LLM 编故事的输入（这一步不带参考图），可留空（留空则只给格数，让 LLM 自己编）；生成结果覆盖写入上面的故事框
    const ideaInput = $el("textarea", {
        className: "neo-gallery-story-idea",
        rows: 3,
        placeholder: t("可选：一句话想法（如：雨夜地铁口偶遇旧友）。留空则只给格数，让 LLM 自行编故事")
    });
    // 宫格技能：从后端加载 storyboard_grid_* 技能列表；选中技能同时充当编剧技能（写故事）与生图提示词模板 / 布局
    const gridSel = $el("select", { className: "neo-gallery-story-grid" }, [
        $el("option", { value: "", textContent: t("加载中…") }),
    ]);
    (async () => {
        try {
            const res = await fetch("/rs_prompts/skills");
            const skills = await res.json();
            const gridSkills = skills.filter(s => /^storyboard_grid_\d+$/.test(s.id));
            if (gridSkills.length === 0) {
                gridSel.innerHTML = "";
                for (const n of STORYBOARD_GRID_OPTIONS) {
                    gridSel.appendChild($el("option", { value: `storyboard_grid_${n}`, textContent: t(STORYBOARD_GRID_LABELS[n]) }));
                }
            } else {
                gridSel.innerHTML = "";
                for (const s of gridSkills) {
                    gridSel.appendChild($el("option", { value: s.id, textContent: skillDisplayName(s) }));
                }
            }
            const defaultId = `storyboard_grid_${STORYBOARD_DEFAULT_GRIDS}`;
            gridSel.value = Array.from(gridSel.options).some(o => o.value === defaultId) ? defaultId : gridSel.options[0]?.value || "";
        } catch {
            gridSel.innerHTML = "";
            for (const n of STORYBOARD_GRID_OPTIONS) {
                gridSel.appendChild($el("option", { value: `storyboard_grid_${n}`, textContent: t(STORYBOARD_GRID_LABELS[n]) }));
            }
            gridSel.value = `storyboard_grid_${STORYBOARD_DEFAULT_GRIDS}`;
        }
    })();
    // 表单整块（故事框 + 提示 + 宫格数 + 简要故事框）：生成中被下面的进度/结果区整块替换
    const formBox = $el("div", { className: "neo-gallery-story-form" }, [
        input,
        hint,
        $el("div", { className: "neo-gallery-story-field-label", textContent: t("宫格技能") }),
        gridSel,
        $el("div", { className: "neo-gallery-story-field-label", textContent: t("简要故事 / 想法（可留空，留空则让 LLM 自行编故事）") }),
        ideaInput
    ]);
    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    const actionsBox = $el("div", { className: "neo-gallery-story-actions" });

    let refName = null;          // copy_to_input 后的 input 文件名（生成故事与生图复用，不重复落盘）
    let refDetail = null;        // 参考图人物与服装细节（生图前取一次；空串=取不到，不再重试）
    let running = false;         // 防重复提交（生图）
    let cancelId = null;         // 当前生图任务 id（取消用）
    let cancelRequested = false; // 用户点了「取消任务」
    let llmRunning = false;      // 防重复提交（生成故事）
    let llmBtn = null;

    const overlay = $el("div", { className: "neo-gallery-story-modal-overlay" });
    const close = () => overlay.remove();
    const fill = (box, ...children) => { box.textContent = ""; box.append(...children.filter(Boolean)); };
    const btn = (label, onclick, primary = false) =>
        $el("button", { className: "neo-gallery-story-btn" + (primary ? " neo-gallery-story-btn-primary" : ""), textContent: label, onclick });
    // 产物目录：归档后打开画廊 Grid 主目录（优先跳到实际落盘的日期子目录，取不到时回退根目录）
    const openOutputDir = (final) => {
        const sub = (final.images || []).map(i => i.subfolder).find(Boolean);
        const date = sub ? sub.split("/").filter(Boolean).pop() : "";
        openGallerySidebar(STORYBOARD_DIR, date ? [date] : []);
    };

    // 表单态：故事框 + 简要故事框可编辑，右下有 LLM / 取消 / 生成
    const renderForm = () => {
        hint.classList.remove("neo-gallery-story-hint-error");
        hint.textContent = t("按所选宫格技能逐格推进，人物沿用这张图；故事可手写，也可用下面的简要故事 / 想法让 LLM 生成。");
        formBox.style.display = "";
        statusBox.style.display = "none";
        fill(actionsBox, llmBtn, btn(t("取消"), close), btn(t("生成"), onSubmit, true));
    };

    const renderRunning = (label, progress) => {
        const hasSteps = !!(progress && progress.max > 0);
        const fillEl = $el("div", { className: "neo-gallery-cs-progress-fill" });
        if (hasSteps) {
            fillEl.style.width = `${Math.max(0, Math.min(100, (progress.value / progress.max) * 100))}%`;
        } else {
            fillEl.classList.add("neo-gallery-cs-progress-indeterminate");
        }
        formBox.style.display = "none";
        statusBox.style.display = "";
        fill(statusBox,
            $el("div", { className: "neo-gallery-cs-running" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: label })
            ]),
            $el("div", { className: "neo-gallery-cs-progress" }, [fillEl]));
        fill(actionsBox, btn(t("取消任务"), () => { cancelRequested = true; if (cancelId) cancelTask(cancelId); }));
    };

    const renderSuccess = (final) => {
        const images = final.images || [];
        const box = $el("div", { className: "neo-gallery-cs-result" });
        if (images.length > 0) {
            const img = $el("img", {
                className: "neo-gallery-cs-result-img",
                src: `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&size=640`,
                alt: images[0].filename
            });
            img.addEventListener("click", () => Lightbox.open({ items: images.map(im => ({ kind: "image", url: im.url, title: im.filename })), index: 0 }));
            box.appendChild(img);
        }
        formBox.style.display = "none";
        statusBox.style.display = "";
        fill(statusBox, box, $el("div", { className: "neo-gallery-story-hint", textContent: t("已生成九宫格分镜图，可拖入导演编辑器「宫格分镜图拆分」切成关键帧。") }));
        fill(actionsBox, btn(t("打开输出目录"), () => openOutputDir(final), true), btn(t("关闭"), close));
    };

    const renderError = (message) => {
        formBox.style.display = "none";
        statusBox.style.display = "";
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: message || t("生成失败") }));
        fill(actionsBox, btn(t("重试"), onSubmit), btn(t("关闭"), close));
    };

    // 生图失败：窗内留错误 + 重试，另弹 action toast 引导去技能详情修模型（缺模型/节点等非 LLM 问题）
    const failGen = (message) => {
        renderError(message);
        actionToast({ severity: "error", summary: t("九宫格分镜图生成失败"), detail: message, actionLabel: t("打开技能详情"), onAction: () => openSkillDetailById(QWEN_IMAGE_SKILL_ID) });
    };

    // 参考图人物与服装细节：受限视觉调用（只出 1~2 句外形 + 服装），失败或没有视觉模型时返回空串，
    // 生图照常走（只少一层文字锚定，退回只有 <image1> 指代）。
    const loadRefDetail = async () => {
        let buf = "";
        try {
            await invokePromptStream(
                { text: "只看这张参考图，写它的人物外形与服装细节", skillId: STORYBOARD_REF_DETAIL_SKILL_ID, images: [{ kind: "input", value: refName }] },
                {
                    onChunk: (chunk) => { if (chunk && chunk.kind !== "thinking") buf += chunk.text || ""; },
                    onError: (err) => console.warn("[Gallery] reference detail failed:", err),
                }
            );
        } catch (e) {
            console.warn("[Gallery] reference detail failed:", e);
        }
        return buf.trim();
    };

    // 生图：卡片原图落 input/ 当参考图，按故事 + 所选宫格技能出故事板；进度/结果都留在窗口内
    const start = async () => {
        if (running) return;
        running = true;
        cancelRequested = false;
        renderRunning(t("排队中…"));
        try {
            if (!refName) refName = await copyImageToInput(image, subfolder);
            if (refDetail === null) {
                renderRunning(t("读取参考图细节…"));
                refDetail = await loadRefDetail();
            }
            if (cancelRequested) { renderError(t("已取消")); return; }
            const snap = await requestGeneration(await buildStoryboardGridRequest(refName, input.value.trim(), gridSel.value, refDetail));
            cancelId = snap.task_id;
            renderRunning(t("排队中…"));
            const final = await watchTask(snap.task_id, (s) => {
                renderRunning(s.status === "running" ? t("生图中…") : t("排队中…"), s.progress);
            }, () => cancelRequested);
            if (final.status === "succeeded") renderSuccess(final);
            else if (final.status === "cancelled") renderError(t("已取消"));
            else failGen(final.error || t("生成失败"));
        } catch (e) {
            console.error('[Gallery] storyboard generation failed:', e);
            failGen(String(e?.message || e));
        } finally {
            running = false;
            cancelId = null;
        }
    };

    const onSubmit = () => {
        if (running) return;
        if (!input.value.trim()) {
            hint.textContent = t("请先填写分镜故事，或点「LLM 生成分镜故事」");
            hint.classList.add("neo-gallery-story-hint-error");
            input.focus();
            return;
        }
        start();
    };
    // 宫格故事生成：把简要故事 / 想法交给**所选宫格技能**（它的正文既是编剧指令也是生图模板）写成逐格故事，
    // 覆盖写入上面的故事框。**不给编剧看参考图**——人物设定图（三视图 / 四视图）会被它当成"要描述的图"而反推；
    // 改把参考图的人物外形 + 服装先用 storyboard_ref_detail 提取成文字，连简要故事一起给它。
    const generateStoryFromIdea = async () => {
        if (llmRunning) return;
        llmRunning = true;
        llmBtn.disabled = true;
        llmBtn.textContent = t("生成中…");
        hint.classList.remove("neo-gallery-story-hint-error");
        try {
            if (!refName) refName = await copyImageToInput(image, subfolder);
            if (refDetail === null) refDetail = await loadRefDetail();
            let buf = "";
            const skillId = gridSel.value || `storyboard_grid_${STORYBOARD_DEFAULT_GRIDS}`;
            const n = _gridCountFromSkillId(skillId);
            const idea = ideaInput.value.trim();
            const brief = idea || "自行编一个完整故事——有开端、发展、结尾，每格不同场景与不同动作";
            const storyText = `${refDetail ? `参考图人物外形与服装：${refDetail}\n\n` : ""}${brief}（按 ${n} 格分镜）`;
            await invokePromptStream(
                { text: storyText, skillId },
                {
                    onChunk: (chunk) => {
                        if (!chunk || chunk.kind === "thinking") return;
                        buf += chunk.text || "";
                        input.value = buf;
                    },
                    onDone: () => {
                        input.value = buf;
                        hint.textContent = t("已生成分镜故事，可继续编辑后再点「生成」。");
                    },
                    onError: (err) => {
                        console.error('[Gallery] storyboard story generation failed:', err);
                        actionToast({ severity: 'error', summary: t('LLM 生成分镜故事失败'), detail: String(err), actionLabel: t('打开 LLM 设置'), onAction: openLLMSettingsModal });
                    }
                }
            );
        } catch (e) {
            console.error('[Gallery] storyboard story generation failed:', e);
            actionToast({ severity: 'error', summary: t('LLM 生成分镜故事失败'), detail: String(e?.message || e), actionLabel: t('打开 LLM 设置'), onAction: openLLMSettingsModal });
        } finally {
            llmRunning = false;
            llmBtn.disabled = false;
            llmBtn.textContent = t("LLM 生成分镜故事");
        }
    };
    llmBtn = $el("button", { className: "neo-gallery-story-btn", textContent: t("LLM 生成分镜故事"), onclick: generateStoryFromIdea });
    const onKey = (e) => {
        if (e.key === "Escape") close();
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSubmit();
    };
    overlay.appendChild($el("div", { className: "neo-gallery-story-modal" }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: t("生成九宫格分镜图") }),
            $el("span", { className: "neo-gallery-story-close", textContent: "\u00D7", onclick: close })
        ]),
        // 参考图直接出缩略图（同一张卡片走同一缓存接口），避免只看到文件名却不确定是哪张
        $el("div", { className: "neo-gallery-story-ref" }, [
            $el("img", {
                className: "neo-gallery-story-ref-img",
                src: getThumbnailSrc(image, subfolder, STORYBOARD_PREVIEW_SIZE),
                alt: image.name || image.filename,
                style: { height: `${previewHeight}px` }
            }),
            $el("div", { className: "neo-gallery-story-ref-info" }, [
                $el("div", { className: "neo-gallery-story-ref-label", textContent: t("参考图 \u00B7 人物沿用这张") }),
                $el("div", { className: "neo-gallery-story-path", title: pathLabel, textContent: pathLabel })
            ])
        ]),
        formBox,
        statusBox,
        actionsBox
    ]));

    renderForm();
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => { document.removeEventListener("keydown", onKey); origRemove(); };
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 0);
}

// 图片反推：弹窗展示参考图，调用 /rs_prompts/reverse_prompt 反推提示词。
// 后端会把结果自动存成与图片同目录的 .txt（已存在则直接返回缓存）。
export function openReversePromptDialog(image, subfolder) {
    const filename = image.filename || image.name;
    const previewSrc = getThumbnailSrc(image, subfolder);
    const pathLabel = `${subfolder ? subfolder + "/" : ""}${filename}`;

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    let busy = false;

    function close() {
        if (busy) return; // 反推中不允许关闭，避免误触丢失结果
        document.removeEventListener("keydown", onKey);
        overlay.remove();
    }
    function onKey(e) { if (e.key === "Escape") close(); }

    function setStatus(state, text) {
        statusBox.innerHTML = "";
        if (state === "idle") {
            statusBox.appendChild($el("span", { className: "neo-gallery-story-hint", textContent: text }));
        } else if (state === "running") {
            statusBox.appendChild($el("div", { className: "neo-gallery-cs-running" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: text }),
            ]));
        } else if (state === "success") {
            statusBox.appendChild($el("div", { className: "neo-gallery-rp-result", textContent: text }));
            const copyBtn = $el("button", {
                className: "neo-gallery-story-btn neo-gallery-rp-copy",
                onclick: () => copyPrompt(text, copyBtn),
            }, [icon("copy"), " " + t("复制提示词")]);
            statusBox.appendChild(copyBtn);
        } else if (state === "error") {
            statusBox.appendChild($el("span", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: text }));
        }
    }

    async function copyPrompt(text, btn) {
        try {
            await navigator.clipboard.writeText(text);
            setIconLabel(btn, "check", t("已复制"));
            setTimeout(() => { setIconLabel(btn, "copy", t("复制提示词")); }, 1500);
        } catch (e) {
            actionToast({ severity: "info", summary: t("复制失败"), detail: String(e) });
        }
    }

    function renderStreaming(text) {
        statusBox.innerHTML = "";
        statusBox.appendChild($el("div", { className: "neo-gallery-cs-running" }, [
            $el("span", { className: "neo-gallery-cs-spinner" }),
            $el("div", { className: "neo-gallery-rp-result", textContent: text || "…" }),
        ]));
    }

    async function run() {
        busy = true;
        let acc = "";
        renderStreaming("");
        try {
            const language = (langRow.querySelector('input[name="rpLang"]:checked') || {}).value || "zh";
            const resp = await fetch("/rs_prompts/reverse_prompt", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename, subfolder, language }),
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${resp.status}`);
            }
            // SSE 流式消费：逐帧解析，正文实时写入，meta 帧（status/txt_file/language）忽略
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    const data = line.slice(6);
                    if (data === "[DONE]") break;
                    if (data.startsWith("[ERROR]")) throw new Error(data.slice("[ERROR]".length).trim());
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.meta) continue;
                        if (typeof parsed.text === "string") {
                            acc += parsed.text;
                            renderStreaming(acc);
                        }
                    } catch { /* 非 JSON 帧忽略 */ }
                }
            }
            const final = acc.trim() || t("(空提示词)");
            setStatus("success", final);
            actionToast({ severity: "success", summary: t("已保存反推结果到图片目录") });
        } catch (err) {
            setStatus("error", err.message || String(err));
        } finally {
            busy = false;
        }
    }

    // 输出语言选择（默认中文）
    const langRow = document.createElement("div");
    langRow.className = "neo-gallery-rp-lang";
    const mkLangOpt = (value, label, checked) => {
        const wrap = document.createElement("label");
        wrap.className = "neo-gallery-rp-lang-opt";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "rpLang";
        input.value = value;
        if (checked) input.checked = true;
        wrap.append(input, document.createTextNode(label));
        return wrap;
    };
    langRow.append(mkLangOpt("zh", t("中文"), true), mkLangOpt("en", t("英文"), false));

    const overlay = $el("div", { className: "neo-gallery-story-modal-overlay" });
    const modal = $el("div", {
        className: "neo-gallery-story-modal",
        onclick: e => e.stopPropagation(),
    }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: t("图片反推") }),
            $el("span", { className: "neo-gallery-story-close", textContent: "×", onclick: close }),
        ]),
        $el("div", { className: "neo-gallery-story-ref" }, [
            $el("img", { className: "neo-gallery-story-ref-img", src: previewSrc, style: { height: `${getImageHeight(image) || 160}px` } }),
            $el("div", { className: "neo-gallery-story-ref-info" }, [
                $el("span", { className: "neo-gallery-story-ref-label", textContent: t("参考图") }),
                $el("span", { className: "neo-gallery-story-path", title: pathLabel, textContent: filename }),
            ]),
        ]),
        langRow,
        statusBox,
        $el("div", { className: "neo-gallery-story-actions" }, [
            $el("button", { className: "neo-gallery-story-btn", textContent: t("取消"), onclick: close }),
            $el("button", { className: "neo-gallery-story-btn neo-gallery-story-btn-primary", textContent: t("反推"), onclick: run }),
        ]),
    ]);
    overlay.onclick = () => close();
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    setStatus("idle", t("点击「反推」生成提示词，结果将自动保存到图片所在目录"));
    document.addEventListener("keydown", onKey);
}

/** LoRA 打标弹窗：为叶子图片目录批量生成标准化标签 .txt（触发词 + 可选先自动标准化目录）。 */
export function openLoraTagDialog(gallery, dirPath) {
    document.querySelector(".neo-gallery-lt-modal-overlay")?.remove();

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    let busy = false;
    let controller = null;
    let aborted = false;

    function close() {
        // 打标中点关闭 = 中止：断开 SSE，后端流结束后置位取消标志
        if (busy && controller) { aborted = true; controller.abort(); }
        busy = false;
        document.removeEventListener("keydown", onKey);
        overlay.remove();
    }
    function onKey(e) { if (e.key === "Escape") close(); }

    const triggerInput = $el("input", {
        className: "neo-gallery-story-input neo-gallery-lt-trigger",
        type: "text",
        placeholder: t("触发词（如 gtx）"),
    });
    const stdCheck = $el("input", { type: "checkbox" });
    stdCheck.checked = true;
    const stdRow = $el("label", { className: "neo-gallery-lt-std-row" }, [
        stdCheck,
        document.createTextNode(t("先自动标准化目录（HEIC→PNG + 001.png... 顺序编号）")),
    ]);

    // 当前打标图片 + 标签结果实时预览：SSE 帧按顺序到达，自然逐张切换
    const previewImg = $el("img", { className: "neo-gallery-lt-preview-img" });
    const previewCaption = $el("div", { className: "neo-gallery-lt-preview-caption" });
    const previewBox = $el("div", { className: "neo-gallery-lt-preview" }, [previewImg, previewCaption]);
    previewBox.style.display = "none";

    function setStatus(state, text) {
        statusBox.innerHTML = "";
        if (state === "idle") {
            statusBox.appendChild($el("span", { className: "neo-gallery-story-hint", textContent: text }));
        } else if (state === "running") {
            statusBox.appendChild($el("div", { className: "neo-gallery-cs-running" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: text }),
            ]));
        } else if (state === "success") {
            statusBox.appendChild($el("div", { className: "neo-gallery-rp-result", textContent: text }));
        } else if (state === "error") {
            statusBox.appendChild($el("span", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: text }));
        }
    }

    async function run() {
        const trigger = triggerInput.value.trim();
        if (!trigger) { setStatus("error", t("请输入触发词")); return; }
        busy = true;
        cancelBtn.textContent = t("中止打标");
        runBtn.disabled = true;
        controller = new AbortController();
        let lastMeta = null;
        try {
            const resp = await fetch("/neo_gallery/tag_dir", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dir: dirPath, trigger_word: trigger, standardize: stdCheck.checked }),
                signal: controller.signal,
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${resp.status}`);
            }
            // SSE 流式消费：progress 帧更新状态行，meta 帧定最终状态
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    const data = line.slice(6);
                    if (data === "[DONE]") break;
                    if (data.startsWith("[ERROR]")) throw new Error(data.slice("[ERROR]".length).trim());
                    let parsed;
                    try { parsed = JSON.parse(data); } catch { continue; }
                    if (parsed.meta) { lastMeta = parsed.meta; continue; }
                    const p = parsed.progress;
                    if (!p) continue;
                    if (p.phase === "standardize") {
                        const n = (p.converted || []).length + (p.renamed || []).length;
                        setStatus("running", tf("标准化目录：已处理 {n} 个文件", { n }) + (p.backup ? tf("，原件已备份到 {backup}", { backup: p.backup }) : ""));
                    } else {
                        const mark = p.status === "ok" ? "" : "✗";
                        setStatus("running", tf("打标 {index}/{total} · {file} {mark}", { index: p.index, total: p.total, file: p.file, mark }));
                        // 实时预览当前图片与标签，随下一帧自动切换
                        previewBox.style.display = "";
                        previewImg.src = `/neo_gallery/thumbnail?filename=${encodeURIComponent(p.file)}&subfolder=${encodeURIComponent(dirPath)}&size=400`;
                        previewCaption.textContent = p.status === "ok" ? (p.caption || "") : tf("打标失败：{error}", { error: p.error || "" });
                    }
                }
            }
            if (lastMeta && lastMeta.status === "error") throw new Error(lastMeta.error);
            if (lastMeta) {
                const failed = lastMeta.failed || [];
                setStatus(failed.length ? "error" : "success",
                    tf("打标完成 {done}/{total}", { done: lastMeta.done, total: lastMeta.total }) +
                    (failed.length ? tf("，{n} 张失败：{files}", { n: failed.length, files: failed.map((f) => f.file).join("、") }) : ""));
                if (!failed.length) {
                    actionToast({ severity: "success", summary: t("LoRA 打标完成"), detail: tf("已写入 {n} 个标签文件", { n: lastMeta.done }) });
                } else {
                    actionToast({ severity: "warning", summary: t("部分图片打标失败"), detail: tf("{n}/{total} 失败", { n: failed.length, total: lastMeta.total }) });
                }
            }
            // 重显当前目录，让重命名后的文件与新 .txt 立即可见
            const [source, ...segs] = dirPath.split("/");
            if (typeof gallery.showDirectoryStructure === "function") {
                await gallery.showDirectoryStructure(source, segs);
            }
        } catch (err) {
            if (aborted) return; // 用户中止：窗已关，静默
            setStatus("error", err.message || String(err));
        } finally {
            busy = false;
            controller = null;
            cancelBtn.textContent = t("取消");
            runBtn.disabled = false;
        }
    }
    const cancelBtn = $el("button", { className: "neo-gallery-story-btn", textContent: t("取消"), onclick: close });
    const runBtn = $el("button", { className: "neo-gallery-story-btn neo-gallery-story-btn-primary", textContent: t("开始打标"), onclick: run });
    const overlay = $el("div", { className: "neo-gallery-story-modal-overlay neo-gallery-lt-modal-overlay" });
    const modal = $el("div", {
        className: "neo-gallery-story-modal",
        onclick: e => e.stopPropagation(),
    }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: t("LoRA 打标") }),
            $el("span", { className: "neo-gallery-story-close", textContent: "×", onclick: close }),
        ]),
        $el("div", { className: "neo-gallery-lt-dir", title: dirPath, textContent: dirPath }),
        $el("div", { className: "neo-gallery-lt-trigger-row" }, [
            $el("span", { className: "neo-gallery-lt-label", textContent: t("触发词") }),
            triggerInput,
        ]),
        stdRow,
        previewBox,
        statusBox,
        $el("div", { className: "neo-gallery-story-actions" }, [cancelBtn, runBtn]),
    ]);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    makeStoryWindowDraggable(modal);

    setStatus("idle", t("输入触发词后点「开始打标」，每张图片会写入标准化标签 .txt"));
    // preflight：图片数 + 建议触发词（文件夹名拼音首字母），失败不阻塞
    fetch(`/neo_gallery/tag_preflight?dir=${encodeURIComponent(dirPath)}`)
        .then((r) => r.json())
        .then((data) => {
            if (typeof data.image_count === "number") {
                setStatus("idle", tf("{count} 张图片 · 输入触发词后点「开始打标」", { count: data.image_count }));
            }
            if (data.suggested_trigger && !triggerInput.value.trim()) {
                triggerInput.value = data.suggested_trigger;
            }
        })
        .catch(() => {});

    document.addEventListener("keydown", onKey);
}

/** 解码音频真实峰值重绘波形（一次性开销，失败保留装饰波形）。 */
async function decodeAudioPeaks(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const actx = new AC();
    if (actx.state === "suspended") await actx.resume().catch(() => {});
    const audioBuf = await actx.decodeAudioData(buf);
    const data = audioBuf.getChannelData(0);
    const n = 60, step = Math.max(1, Math.floor(data.length / n));
    const peaks = new Array(n);
    for (let i = 0; i < n; i++) {
        let peak = 0; const s = i * step;
        for (let j = s; j < s + step && j < data.length; j += 8) {
            const v = Math.abs(data[j]);
            if (v > peak) peak = v;
        }
        peaks[i] = Math.min(1, peak);
    }
    actx.close();
    return peaks;
}

/** 波形 + 播放控件（参考音频 / 结果音频共用）：装饰波形起步，首次播放解码真实峰值重绘，
 *  播放时按进度填充；自带独立 Audio 播放器，不干扰画廊卡片的共享播放器。 */
function voiceAudioWidget(url, seedStr) {
    const wrap = $el("div", { className: "neo-gallery-voice-audio" });
    const playBtn = $el("div", { className: "neo-gallery-audio-play-btn", title: t("播放 / 暂停") }, ["\u25B6"]);
    const canvas = $el("canvas", { className: "neo-gallery-audio-waveform" });
    wrap.appendChild(playBtn);
    wrap.appendChild(canvas);
    const bars = decorativeHeights(seedStr);
    const draw = (progress) => renderWaveform(canvas, bars, progress);
    draw(0);
    let player = null;
    wrap._stop = () => { if (player) player.pause(); };
    playBtn.onclick = (e) => {
        e.stopPropagation();
        if (!player) {
            player = new Audio(url);
            player.preload = "metadata";
            player.addEventListener("timeupdate", () => {
                const dur = isFinite(player.duration) ? player.duration : 0;
                draw(dur > 0 ? Math.min(1, player.currentTime / dur) : 0);
            });
            player.addEventListener("ended", () => { playBtn.textContent = "\u25B6"; draw(1); });
        }
        if (!player.paused) { player.pause(); playBtn.textContent = "\u25B6"; return; }
        playBtn.textContent = "\u23F8";
        player.play().catch(() => { playBtn.textContent = "\u25B6"; });
        if (!canvas.dataset.decoded) {
            decodeAudioPeaks(url).then((peaks) => {
                bars.length = 0; bars.push(...peaks);
                canvas.dataset.decoded = "1";
                const dur = isFinite(player.duration) ? player.duration : 0;
                draw(dur > 0 ? Math.min(1, player.currentTime / dur) : 0);
            }).catch(() => {});
        }
    };
    return wrap;
}

/** 音频卡片「生成语音」弹窗：用参考音频的音色（CosyVoice 零样本克隆）朗读目标文字，
 *  窗口内显示排队/合成进度，完成后显示结果波形并可直接播放试听。参考音频经 copy_to_input
 *  落 input/ 作为 {{REF_AUDIO_1}}，目标文字走 {{PROMPT}}，产物落 Output/Voice。 */
export function openVoiceDialog(gallery, image, subfolder) {
    document.querySelector('.neo-gallery-voice-modal-overlay')?.remove();
    const pathLabel = (subfolder ? `${subfolder}/` : "") + (image.filename || image.name || "");

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    const actionsBox = $el("div", { className: "neo-gallery-story-actions" });
    const targetInput = $el("textarea", {
        className: "neo-gallery-story-input",
        rows: 4,
        placeholder: t("要说的文字（用参考音频的音色朗读）……")
    });

    let running = false, cancelId = null, cancelRequested = false, refName = null;
    const widgets = [];
    const stopVoiceAudio = () => { widgets.forEach((w) => w._stop()); };

    const overlay = $el("div", { className: "neo-gallery-story-modal-overlay neo-gallery-voice-modal-overlay" });
    const close = () => { overlay.remove(); stopVoiceAudio(); };
    const fill = (box, ...children) => { box.textContent = ""; box.append(...children.filter(Boolean)); };
    const btn = (label, onclick, primary = false) =>
        $el("button", { className: "neo-gallery-story-btn" + (primary ? " neo-gallery-story-btn-primary" : ""), textContent: label, onclick });

    const renderIdle = () => {
        fill(actionsBox, btn(t("取消"), close), btn(t("生成"), start, true));
    };
    const renderRunning = (label, progress) => {
        const hasSteps = !!(progress && progress.max > 0);
        const fillEl = $el("div", { className: "neo-gallery-cs-progress-fill" });
        if (hasSteps) fillEl.style.width = `${Math.max(0, Math.min(100, (progress.value / progress.max) * 100))}%`;
        else fillEl.classList.add("neo-gallery-cs-progress-indeterminate");
        const bar = $el("div", { className: "neo-gallery-cs-progress" }, [fillEl]);
        fill(statusBox, $el("div", { className: "neo-gallery-cs-running" }, [
            $el("span", { className: "neo-gallery-cs-spinner" }),
            $el("span", { textContent: label })]), bar);
        fill(actionsBox, btn(t("取消任务"), () => { cancelRequested = true; if (cancelId) cancelVoiceTask(cancelId); }));
    };
    const renderSuccess = (final) => {
        const audios = final.audios || [];
        const box = $el("div", { className: "neo-gallery-voice-result" });
        if (audios.length) {
            const w = voiceAudioWidget(audios[0].url, audios[0].filename);
            widgets.push(w);
            box.appendChild(w);
        }
        fill(statusBox, box, $el("div", { className: "neo-gallery-story-hint", textContent: t("已生成语音，点波形播放试听；产物在 Output/Voice。") }));
        fill(actionsBox, btn(t("打开输出目录"), () => openGallerySidebar("Voice", [])), btn(t("关闭"), close, true));
    };
    const renderError = (message) => {
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: message || t("生成失败") }));
        fill(actionsBox, btn(t("重试"), start), btn(t("关闭"), close));
    };

    const start = async () => {
        if (running) return;
        const text = targetInput.value.trim();
        if (!text) { renderError(t("请先输入要说的文字")); return; }
        running = true; cancelRequested = false;
        renderRunning(t("排队中…"));
        try {
            if (!refName) refName = await copyImageToInput(image, subfolder);
            const snap = await requestVoiceGeneration(buildVoiceRequest(refName, text));
            cancelId = snap.task_id;
            renderRunning(t("排队中…"));
            const final = await watchVoiceTask(snap.task_id, (s) => {
                renderRunning(s.status === "running" ? t("合成中…") : t("排队中…"), s.progress);
            }, () => cancelRequested);
            if (final.status === "succeeded") renderSuccess(final);
            else if (final.status === "cancelled") renderError(t("已取消"));
            else renderError(final.error || t("生成失败"));
        } catch (e) {
            renderError(String(e?.message || e));
        } finally {
            running = false; cancelId = null;
        }
    };

    const onKey = (e) => { if (e.key === "Escape") close(); };

    const refWidget = voiceAudioWidget(getAudioSrc(image, subfolder), image.filename);
    widgets.push(refWidget);

    overlay.appendChild($el("div", { className: "neo-gallery-story-modal" }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: t("生成语音（CosyVoice 克隆）") }),
            $el("span", { className: "neo-gallery-story-close", textContent: "\u00D7", onclick: close })
        ]),
        $el("div", { className: "neo-gallery-story-ref" }, [
            refWidget,
            $el("div", { className: "neo-gallery-story-ref-info" }, [
                $el("div", { className: "neo-gallery-story-ref-label", textContent: t("参考音源 · 用它的音色朗读") }),
                $el("div", { className: "neo-gallery-story-path", title: pathLabel, textContent: pathLabel })
            ])
        ]),
        $el("div", { className: "neo-gallery-story-field-label", textContent: t("要说的文字") }),
        targetInput,
        statusBox,
        actionsBox
    ]));

    renderIdle();
    // 预填默认提示词（config.json 的 default_prompt），方便直接测试；用户已输入时不覆盖
    getSkillGenConfig(VOICE_SKILL_ID).then((cfg) => {
        const def = typeof cfg?.default_prompt === "string" ? cfg.default_prompt.trim() : "";
        if (def && !targetInput.value.trim()) targetInput.value = def;
    });
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => { document.removeEventListener("keydown", onKey); stopVoiceAudio(); origRemove(); };
    document.body.appendChild(overlay);
}
