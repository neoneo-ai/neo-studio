/**
 * Gallery 素材卡片「一键生成」：角色图（多视图）与九宫格分镜图的请求体、弹窗 UI 与生成流程。
 * 从 gallery-card.js 拆出，固定走 Qwen Image 2.1 预设；输出分别落 Output/CharacterSheet 与 Output/StoryBoard。
 */

import { $el } from "../../../../scripts/ui.js";
import { api } from "../../../../scripts/api.js";
import { getImageHeight, getThumbnailSrc, isImageFile, isAudioFile, getAudioSrc, renderWaveform, decorativeHeights } from "./gallery-utils.js";
import { DIRECTOR_ASPECTS } from "./director.js";
import { openLLMSettingsModal } from "./llm-setting.js";
import { actionToast } from "./toast.js";
import { openSkillDetailById, listSkills, populateSkillOptions, skillDisplayName, skillAcceptsText, skillAcceptsRef, skillFamily } from "./skill.js";
import { Lightbox } from "./lightbox.js";
import { requestGeneration, watchTask, cancelTask, createModelConfigSection, listGenModels, getSkillGenConfig, getGenSettings, shortModelName, modelFamily, LORA_FAMILY_HINTS } from "./image-gen.js";
import { inOpenComboList } from "./combo-box.js";
import { requestVoiceGeneration, watchVoiceTask, cancelVoiceTask, buildVoiceRequest, VOICE_SKILL_ID } from "./voice-gen.js";
import { invokePromptStream, createStreamOutputHandlers, randomPrompts, listPrompts, loadPrompt } from "./prompt-service.js";
import { createQuickInputHistory } from "./quick-input-history.js";
import { openGallerySidebar, toggleGallerySidebar, grabDataType, copyGalleryToInput, uploadLocalFiles } from "./media-transfer.js";
import { ttlCache } from "./js/core/cache.js";
import { t, tf } from "./js/core/i18n.js";
import { icon, setIcon, setIconLabel } from "./js/core/icons.js";

// 一键角色图 / 九宫格分镜图都固定走 Qwen Image 2.1 预设（多路参考槽位、不走 Krea2 编辑链）。
const QWEN_IMAGE_SKILL_ID = "qwen_image_21";
// 扩图专用技能：LoRA 固定在其 config.json（缺失时后端提示并跳过）
const QWEN_OUTPAINT_SKILL_ID = "qwen_image_21_outpaint";
// 高分局部编辑技能：涂抹区域自动裁剪-高分重绘-羽化合并（无额外 LoRA）
const QWEN_LOCAL_EDIT_SKILL_ID = "qwen_image_21_local_edit";
// 姿势编辑技能：只挂原图时按提示词改姿势，拖入第 2 张参考时把它的姿势搬到原图人物上
const QWEN_POSE_EDIT_SKILL_ID = "qwen_image_21_pose_edit";

// 扩图目标比例预设（free=自由拖框；其余按 w:h 锁定拖框长宽比）
const OUTPAINT_RATIOS = [
    ["free", t("自由")],
    ["1:1", "1:1"],
    ["4:3", "4:3"],
    ["3:4", "3:4"],
    ["16:9", "16:9"],
    ["9:16", "9:16"],
    ["21:9", "21:9"],
    ["2.35:1", "2.35:1"],
];
// 扩图默认触发词（与后端 OUTPAINT_DEFAULT_PROMPT 一致）
const OUTPAINT_DEFAULT_PROMPT = ("Outpaint the image: replace the solid gray areas with a seamless continuation " +
    "of the scene, keeping the existing picture unchanged.");
// 点选删除默认提示词（与后端 REMOVE_DEFAULT_PROMPT 一致）
const REMOVE_DEFAULT_PROMPT = ("Remove the object in the red highlighted area and fill it with the surrounding background. " +
    "The filled area seamlessly continues the scene's lighting, perspective, and surface textures. " +
    "All other parts of the image remain exactly unchanged.");
// 多图融合默认提示词（以原图为目标场景，将额外参考图中的人物/物体自然融入）
const BLEND_DEFAULT_PROMPT = ("Using the first image as the base scene, naturally insert the subjects from the additional reference images into the scene. " +
    "Match their scale, lighting direction, color temperature, and perspective to the environment. " +
    "The result reads as a single photograph where all subjects belong to the same moment.");
// 姿势迁移默认触发词（姿势模式拖入姿势参考图时自动换上，与技能 skill.md 的「姿势迁移」用法一致）
const POSE_REF_DEFAULT_PROMPT = ("Adopt the pose of the person in <image2>, keeping the face, hair, clothing, " +
    "lighting, background and camera framing of <image1> unchanged, high quality, sharp details, 4k");
// 扩图链两次缩放的目标（与后端 OUTPAINT_REF_MP + 设置项 target_megapixels、参考工作流
// ▶▷Qwen-image21-功能流 的「图像扩展」一致）：原图先归一化到 1MP，补灰边后画布再归一化到目标 MP
const OUTPAINT_REF_MP = 1.0;
// 目标像素数（MP）出厂默认：全局设置在「生图默认设置 → 目标像素数 (MP)」，读不到设置时用这个
const DEFAULT_TARGET_MP = 1.5;
// Python round()：四舍六入五取偶。后端 ImageScaleToTotalPixels 用的就是它，而 JS Math.round 会把 .5
// 进位，碰上尺寸正好差半格（如 720/32=22.5）就会算出差 32px 的目标，必须对齐
const pyRound = (v) => {
    const f = Math.floor(v), d = v - f;
    return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 ? f + 1 : f);
};
// 与后端 ImageScaleToTotalPixels(megapixels, resolution_steps=32) 同算法：整幅等比缩放到目标像素后 32 对齐
const scaleToMp = (w, h, mp) => {
    const k = Math.sqrt(mp * 1024 * 1024 / (w * h));
    return { w: pyRound(w * k / 32) * 32, h: pyRound(h * k / 32) * 32 };
};
// 目标像素数（MP）：补边画布整幅缩放到该像素数后出图（0/空 = 用出厂默认）
const targetMp = (mp) => mp > 0 ? mp : DEFAULT_TARGET_MP;
// Qwen Image 2.1 的目标尺寸必须 32 对齐（latent 一格 = 32px），否则模型自己补/裁一格 → 出图尺寸和内容一起偏
const round32 = (v) => Math.max(32, Math.round(v / 32) * 32);
// 常规编辑的目标分辨率默认值：原图尺寸对齐到 32；原图太大时按目标像素数（MP）等比封顶
// （模型在 ~1.5MP 以内最稳，超大原图直接按原尺寸跑会拖慢/爆显存；只封顶不放大，小图保持原尺寸）
const editDefaultTargetSize = (w, h, mp) => {
    const capped = w * h > mp * 1024 * 1024 ? scaleToMp(w, h, mp) : { w, h };
    return { w: round32(capped.w), h: round32(capped.h) };
};
// 对比窗标题：常规编辑换成缩放图后写明尺寸，切换模式/重新生成前还原
const COMPARE_LABEL = t("原图 / 编辑结果（拖拽分割线对比）");
// 扩图画布边长上限（×原图显示尺寸）：拖框换算随缩放指数增长，封顶防失控与后端显存爆炸
const OUTPAINT_MAX_EXTEND = 4;
// 「生成素材」弹窗默认技能：Krea2 文生图（纯提示词出图，产物落 Output/NeoAgent/<日期>）
const KREA2_T2I_SKILL_ID = "image_gen";
// 「生成素材」弹窗上次选中的技能（localStorage，关窗不清除）
const GM_LAST_SKILL_KEY = "neo.gallery.gen_material.skill";
// 「生成素材」弹窗上次选中的「增强 skill」（localStorage，关窗不清除；空 = 默认自动路由）
const GM_ENHANCE_SKILL_KEY = "neo.gallery.gen_material.enhance_skill";
// 用所选人像作参考图生成四视图角色设定图，供拖入导演配方的 角色参考图。
const CHARACTER_SHEET_PROMPT = "角色设定多视图：根据参考图中的人物，在一张横版画面中生成四个视图横向并排的角色设定图：第一格为大头特写（肩部以上，突出五官脸型），第二格为正面全身站立，第三格为侧面全身站立，第四格为背面全身站立。严格保持与参考图一致的五官脸型、发型发色、服装配饰和体型比例；全身视图中人物自然站立，双臂下垂，纯白背景，均匀柔光，写实摄影风格，高清细节，画面内不出现文字标注。";
// 角色图输出目录：保存路径的日期段会变成文件名前缀，成品直接落在 Output/CharacterSheet 下。
const CHARACTER_SHEET_DIR = "CharacterSheet";
/** 小窗标题栏拖动 + 双击最大化/还原（同导演编辑器）：首次按下从居中切到绝对定位并记录起点，
 *  之后按鼠标位移更新 left/top；钳制保证窗口不会被拖出视口（始终留一条可点到的标题栏 / ✕）。
 *  配合 overlay 的 pointer-events:none（gallery.css 的 *-modal-overlay 规则）= 不遮罩、可移动、窗户外照常浏览。 */
function makeStoryWindowDraggable(modal) {
    const titlebar = modal.querySelector(".neo-gallery-story-titlebar");
    if (!titlebar) return;
    let dragging = false;
    let startMX = 0, startMY = 0, startL = 0, startT = 0;
    const onTitleMove = (e) => {
        if (!dragging) return;
        let left = startL + (e.clientX - startMX);
        let top = startT + (e.clientY - startMY);
        const w = modal.offsetWidth;
        left = Math.max(-w + 80, Math.min(left, window.innerWidth - 80));
        top = Math.max(0, Math.min(top, window.innerHeight - 44));
        modal.style.left = left + "px";
        modal.style.top = top + "px";
    };
    const onTitleUp = () => {
        dragging = false;
        window.removeEventListener("mousemove", onTitleMove);
        window.removeEventListener("mouseup", onTitleUp);
    };
    titlebar.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || e.target.closest("button, .neo-gallery-story-close")) return; // 按钮/关闭钮不触发拖动，标题栏其余空白可拖窗口
        const r = modal.getBoundingClientRect();
        if (!modal.style.left) { // 首次：从居中切到绝对定位，无跳变
            modal.style.position = "absolute";
            modal.style.left = r.left + "px";
            modal.style.top = r.top + "px";
        }
        startMX = e.clientX; startMY = e.clientY;
        startL = parseFloat(modal.style.left); startT = parseFloat(modal.style.top);
        dragging = true;
        window.addEventListener("mousemove", onTitleMove);
        window.addEventListener("mouseup", onTitleUp);
    });
    let maximized = false;
    let prevRect = null;
    const toggleMaximize = () => {
        if (!maximized) {
            const r = modal.getBoundingClientRect();
            prevRect = { left: r.left, top: r.top, width: r.width, height: r.height };
            if (!modal.style.left) modal.style.position = "absolute";
            modal.style.left = "8px";
            modal.style.top = "8px";
            modal.style.width = (window.innerWidth - 16) + "px";
            modal.style.height = (window.innerHeight - 16) + "px";
            modal.style.maxWidth = "none";
            modal.style.maxHeight = "none";
            maximized = true;
        } else {
            modal.style.left = prevRect.left + "px";
            modal.style.top = prevRect.top + "px";
            modal.style.width = prevRect.width + "px";
            modal.style.height = prevRect.height + "px";
            modal.style.maxWidth = "";
            modal.style.maxHeight = "";
            maximized = false;
            prevRect = null;
        }
    };
    titlebar.addEventListener("dblclick", (e) => {
        if (e.target.closest("button, .neo-gallery-story-close")) return;
        toggleMaximize();
    });
}



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

/** 卡片图片经 copy_to_input 落到 input 目录（与发送到 LoadImage 同一通道），返回 input 内的文件名 */
async function copyImageToInput(image, subfolder) {
    const query = "filename=" + encodeURIComponent(image.filename || "")
        + (subfolder ? "&subfolder=" + encodeURIComponent(subfolder) : "");
    const resp = await api.fetchApi("/neo_gallery/copy_to_input?" + query);
    const result = await resp.json().catch(() => null);
    if (!resp.ok || !result || !result.success) {
        throw new Error((result && result.error) || t('无法读取该图片'));
    }
    return result.filename;
}



/** 一键角色图的前置小窗（复用九宫格分镜图同款弹窗结构）：先看参考图确认，点「生成」后
 * 在窗口内显示排队/生图进度与结果预览；Esc 或点遮罩关闭。 */
function openCharacterSheetDialog(gallery, image, subfolder) {
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




/** 图片编辑弹窗：以卡片原图为参考，用所选生图/编辑技能 + 用户输入的编辑指令生成新图。
 * 默认 Qwen Image 2.1，可在下拉中切换其他 image_gen 类技能。 */
// 弹窗 → 内嵌面板双宿主（同 director.js 的 setDirectorEditorHost / opts.container）：
// Studio 绘画页注册过宿主，面板就铺进宿主容器，不建浮层、不带标题栏拖动；
// ComfyUI 插件模式（画布侧栏 gallery）没有宿主，照旧弹浮层窗，入口与类名一律不变。
let _paintHosts = null;   // { text, edit, onOpen }：文生图宿主 / 图片编辑宿主 / 打开时切到绘画页
export function setPaintHost(hosts) { _paintHosts = hosts; }

function storyPanelRoot(host, overlayClass, kind) {
    const embedded = !!(host && host.isConnected);
    if (!embedded) {
        document.querySelector(`.${overlayClass}`)?.remove();
        return { root: $el("div", { className: `neo-gallery-story-modal-overlay ${overlayClass}` }), embedded: false, host: null };
    }
    host.__neoPanelClose?.();   // 宿主上一次的同页面板先收尾（摘全局监听）再清空
    host.textContent = "";
    _paintHosts?.onOpen?.(kind);
    const root = $el("div", { className: "neo-gallery-gen-panel" });
    host.__neoPanelRoot = root;
    return { root, embedded: true, host };
}

/** 宽高比 glyph：描边小方框按选中比例定形（16:9 出扁长框、9:16 出瘦高框），chip 上少写字也知道是哪一项 */
function ratioGlyph() {
    const el = $el("span", { className: "neo-gallery-gm-chip-glyph" });
    const sync = (v) => {
        const [a, b] = String(v || "1:1").split(":").map(Number);
        if (!a || !b) return;
        el.style.width = `${a >= b ? 15 : Math.max(6, Math.round(15 * a / b))}px`;
        el.style.height = `${a >= b ? Math.max(6, Math.round(15 * b / a)) : 15}px`;
    };
    return { el, sync };
}

/** chip 浮层落点（chipButton 的菜单与 skillParamsChip 的双栏面板共用这一套）：
 *  浮层是绝对定位层，样式坐标相对它的包含块——会话页 composer 在可拖动弹层里（带 transform），
 *  弹层顶贴近窗口顶，照视口算的数与相对包含块的数几乎同值，所以浮层今天就是「弹在 chip 上方」；
 *  视频页 dock 贴窗口底（style.css .ns-video-dock bottom:18px），包含块是 .ns-video-page，
 *  壳顶在几百像素开外，照视口那串数直接写出来浮层整块沉到窗底以下，只剩组头一行露在窗口里。
 *  所以：先照视口算期望落点（优先 chip 上方 6px，放不下才落 chip 下方）并夹进窗口，
 *  再减掉包含块自己的视口位置换算成样式坐标；最后量浮层真实矩形兜底，越窗就整块推回窗内。
 *  会话页那枚本来就落在窗内：换算量为 0、夹位不触发，弹法与今天逐字一致。 */
function placeChipPanel(el, chipRect) {
    const shell = (el.offsetParent || document.documentElement).getBoundingClientRect();
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    const above = chipRect.top - h - 6;
    const top = Math.max(8, Math.min(above > 8 ? above : chipRect.bottom + 6, window.innerHeight - h - 8));
    const left = Math.max(8, Math.min(chipRect.left, window.innerWidth - w - 8));
    el.style.top = `${top - shell.top}px`;
    el.style.left = `${left - shell.left}px`;
    const box = el.getBoundingClientRect();
    const dx = Math.min(0, window.innerWidth - 8 - box.right);
    const dy = Math.min(0, window.innerHeight - 8 - box.bottom);
    if (dx < 0) el.style.left = `${parseFloat(el.style.left) + dx}px`;
    if (dy < 0) el.style.top = `${parseFloat(el.style.top) + dy}px`;
}

/** 真 chip（输入条样式参考 ArtCraft）：一枚胶囊按钮 + 从上方浮出的选项菜单——输入卡钉在页面底部，
 *  菜单只能朝上开。原生 select 收在壳里当状态容器并隐藏：chip 显示生效值（覆盖值 / 跟随值 / 默认），
 *  点菜单项写 value 并派发 change；切技能重放配置是程序改 value，不触发 change，调用方要跟着 sync() */
export function chipButton(sel, { icon: iconName, glyph = null } = {}) {
    sel.hidden = true;
    const icoSlot = iconName ? $el("span", { className: "neo-gallery-gm-chip-icon" }, [icon(iconName, 12)]) : null;
    const label = $el("span", { className: "neo-gallery-gm-chip-label" });
    const chip = $el("button", { className: "neo-gallery-gm-chip-btn", type: "button", title: sel.title }, [
        glyph ? glyph.el : icoSlot,
        label,
        $el("span", { className: "neo-gallery-gm-chip-caret", textContent: "▾" }),
    ]);
    const menu = $el("div", { className: "rs-runtime-menu neo-gallery-gm-chip-menu" });
    const wrap = $el("span", { className: "neo-gallery-gm-chip-wrap" }, [chip, menu, sel]);
    let open = false;
    const sync = () => {
        const v = sel.value || sel.dataset.follow || "";
        label.textContent = v ? (sel.value ? (sel.options[sel.selectedIndex]?.textContent || v) : v) : t("默认");
        const optTitle = sel.options[sel.selectedIndex]?.title;
        chip.title = optTitle || sel.title;
        if (glyph) glyph.sync(v);
    };
    const setIcon = (name) => {
        if (!icoSlot) return;
        icoSlot.textContent = "";
        icoSlot.appendChild(icon(name, 12));
    };
    const close = () => {
        if (!open) return;
        open = false;
        menu.style.display = "none";
        chip.classList.remove("neo-gallery-gm-chip-open");
    };
    chip.addEventListener("click", (e) => {
        e.stopPropagation();
        if (open) { close(); return; }
        menu.textContent = "";
        for (const o of sel.options) {
            const item = $el("button", {
                className: "neo-gallery-gm-menu-item" + (o.value === sel.value ? " neo-gallery-gm-menu-on" : ""),
                type: "button", textContent: o.textContent,
            });
            if (o.title) item.title = o.title;
            item.addEventListener("click", () => {
                close();
                sel.value = o.value;
                sel.dispatchEvent(new Event("change", { bubbles: true }));
            });
            menu.appendChild(item);
        }
        menu.style.display = "block";
        open = true;
        chip.classList.add("neo-gallery-gm-chip-open");
        const r = chip.getBoundingClientRect();
        placeChipPanel(menu, r);
    });
    sel.addEventListener("change", sync);
    sync();
    return {
        el: wrap, chip, sync, close, setIcon,
        isOpen: () => open,
        closeOnOutside: (target) => { if (open && !wrap.contains(target)) close(); },
    };
}

// 家族组头显示名：家族词表词是小写英文（image-gen.js 的 LORA_FAMILY_HINTS），组头用产品名
const SKILL_FAMILY_LABELS = { qwen: "Qwen Image", krea2: "Krea2", moss: "MOSS" };

/** 技能 + 自定参数合成一枚 chip（输入条样式参考 ArtCraft 的模型菜单）：点开一个双栏浮层，
 *  左栏技能按家族分组（组头 = 家族，副标题 = 该技能钉的主模型），右栏 = 传进来的主模型 / LoRA 控件。
 *  技能行一律可点：点技能会走 modelCfg.load(该技能 config)，右栏主模型与 LoRA 整份被该技能自己的配置替换，
 *  家族对撞在这一发里根本留不住；跨家族行只把「会换成哪个主模型」写在副标题上（↻ 前缀）。
 *  真正必败的是「当前技能 + 手填的别家族主模型」，那条由 guardMainModelFamily 在填的那一刻拦。
 *  原生 select 收在壳里只当状态容器：点技能写 value 并派发 change；切技能重放配置是程序改 value，调用方要跟着 sync()
 *  分组规则由调用方给：视频页按生成模式分组（groupOf 取 skill 的 mode），组头名与组序都取 groupLabels 的键序。 */
export function skillParamsChip(sel, paramsEl, { icon: iconName = "sparkles", getOverride, groupOf = skillFamily, groupLabels = SKILL_FAMILY_LABELS } = {}) {
    sel.hidden = true;
    const icoSlot = $el("span", { className: "neo-gallery-gm-chip-icon" }, [icon(iconName, 12)]);
    const label = $el("span", { className: "neo-gallery-gm-chip-label" });
    const chip = $el("button", { className: "neo-gallery-gm-chip-btn", type: "button", title: sel.title }, [
        icoSlot, label, $el("span", { className: "neo-gallery-gm-chip-caret", textContent: "▾" }),
    ]);
    const skillsCol = $el("div", { className: "neo-gallery-gm-skills-col" });
    // 完成按钮：点技能不关面板（选完要在右栏看该技能钉的主模型效果），看完点完成才收起
    // 类名不带 neo-gallery-story-btn：输入卡的「生成」是那族按钮，共用会让面板里的按钮被当成生成
    const foot = $el("div", { className: "neo-gallery-gm-panel-foot" }, [
        $el("button", {
            className: "neo-gallery-gm-panel-done",
            type: "button", textContent: t("完成"), title: t("关闭技能与自定参数面板"),
            onclick: () => close(),
        }),
    ]);
    const panel = $el("div", {
        className: "rs-runtime-menu neo-gallery-gm-chip-menu neo-gallery-gm-chip-panel neo-gallery-gm-skills-panel",
    }, [skillsCol, $el("div", { className: "neo-gallery-gm-params-col" }, [paramsEl]), foot]);
    // 双栏样式自带 display:grid，盖过 .rs-runtime-menu 基座的 display:none：收起态由这里钉住
    panel.style.display = "none";
    const wrap = $el("span", { className: "neo-gallery-gm-chip-wrap" }, [chip, panel, sel]);
    let open = false;
    // 组序 = groupLabels 的键序，词表认不出的技能落「其他」排最后
    const famOrder = (fam) => { const i = Object.keys(groupLabels).indexOf(fam); return i < 0 ? 99 : i; };

    /** 左栏整列重建（技能十几行，开面板与 sync 时各一次） */
    const renderSkills = () => {
        skillsCol.textContent = "";
        const rows = [...sel.options].map((o) => ({ o, fam: groupOf(o.__skillMeta) }));
        const fams = [...new Set(rows.map((r) => r.fam))].sort((a, b) => famOrder(a) - famOrder(b));
        const modelFam = modelFamily((getOverride ? getOverride() : {}).model || "");
        for (const fam of fams) {
            if (fams.length > 1) {
                skillsCol.appendChild($el("div", {
                    className: "neo-gallery-gm-skill-group",
                    textContent: groupLabels[fam] || t("其他"),
                }));
            }
            // fam: rowFam —— 内层不能再绑 fam，filter 回调认的是外层组循环那个 fam
            for (const { o, fam: rowFam } of rows.filter((r) => r.fam === fam)) {
                const item = $el("button", {
                    className: "neo-gallery-gm-menu-item neo-gallery-gm-skill-item"
                        + (o.value === sel.value ? " neo-gallery-gm-menu-on" : ""),
                    type: "button",
                });
                item.appendChild($el("span", { className: "neo-gallery-gm-skill-name", textContent: o.textContent }));
                const model = ((o.__skillMeta || {}).gen_config || {}).model || "";
                const cross = !!modelFam && !!rowFam && rowFam !== modelFam;
                if (model) {
                    // 跨家族行的副标题带 ↻：点它是「换成这个技能钉的主模型」，不是「配不上」
                    item.appendChild($el("span", {
                        className: "neo-gallery-gm-skill-sub",
                        textContent: (cross ? "↻ " : "") + shortModelName(model),
                    }));
                }
                if (cross) {
                    item.title = tf("{a} 家族的技能：选中会改用该技能自带的主模型（当前主模型 / LoRA 覆盖会被替换）", {
                        a: groupLabels[rowFam] || rowFam,
                    });
                }
                item.addEventListener("click", (e) => {
                    // 不收面板：这一发的效果要在右栏看见（主模型 / LoRA 被该技能整份替换），看完点完成
                    // .stopPropagation：面板里的选择不算「点面板外」，chip 的文档级收起循环会把它当外点
                    e.stopPropagation();
                    sel.value = o.value;
                    sel.dispatchEvent(new Event("change", { bubbles: true }));
                });
                skillsCol.appendChild(item);
            }
        }
    };
    const close = () => {
        if (!open) return;
        open = false;
        panel.style.display = "none";
        chip.classList.remove("neo-gallery-gm-chip-open");
    };
    // chip 说出当前生效值：技能名，有覆盖时带上主模型短名与 LoRA 条数
    const sync = () => {
        const ov = (getOverride ? getOverride() : {}) || {};
        const loras = ov.loras || [];
        const parts = [sel.options[sel.selectedIndex]?.textContent || ""];
        if (ov.model) parts.push(shortModelName(ov.model));
        if (loras.length) parts.push(tf("LoRA ×{n}", { n: loras.length }));
        label.textContent = parts.filter(Boolean).join(" · ");
        chip.classList.toggle("on", !!(ov.model || loras.length));
        if (open) renderSkills();
    };
    chip.addEventListener("click", (e) => {
        e.stopPropagation();
        if (open) { close(); return; }
        renderSkills();
        panel.style.display = "grid";   // 双栏靠这里钉住：.rs-runtime-menu 基座在 gallery.css 之后加载，样式表分不出胜负
        open = true;
        chip.classList.add("neo-gallery-gm-chip-open");
        const r = chip.getBoundingClientRect();
        placeChipPanel(panel, r);
    });
    sel.addEventListener("change", sync);
    sync();
    return {
        el: wrap, chip, sync, close,
        isOpen: () => open,
        // 模型 / LoRA 下拉的列表弹层挂在 body 上，点在弹层里不算「面板外」
        closeOnOutside: (target) => { if (open && !wrap.contains(target) && !inOpenComboList(target)) close(); },
    };
}

/** 手填主模型与当前技能家族对撞就收回这一选（两块生图输入卡共用）：家族不同的 conditioning 维度
 *  对不上，这一发在后端是必败的生成（MCP 生成校验 tool_generate_image 同一口径）。
 *  切技能不经过这里：技能自带配置由 modelCfg.load() 整份写入，家族天然一致。
 *  收回后落回空值 = 「自动」，也就是该技能 config 里钉的那个主模型；combo 的 .value setter 会同步
 *  输入框文本，界面不会停在被拒的那个名字上 */
function guardMainModelFamily(modelCfg, skillSel) {
    modelCfg.modelSelect.addEventListener("change", () => {
        const fam = skillFamily(skillSel.options[skillSel.selectedIndex]?.__skillMeta);
        const pickedFam = modelFamily(modelCfg.modelSelect.value);
        if (!fam || !pickedFam || fam === pickedFam) return;
        modelCfg.modelSelect.value = "";
        actionToast({
            severity: "info",
            summary: t("主模型与技能家族不同"),
            detail: tf("{a} 家族的技能配不上 {b} 家族的主模型：家族不同的 conditioning 维度对不上，这一发必败。主模型留空 = 跟随该技能自带的主模型；要用这一家族的主模型就换技能", {
                a: SKILL_FAMILY_LABELS[fam] || fam, b: SKILL_FAMILY_LABELS[pickedFam] || pickedFam,
            }),
        });
    });
}

// 绘画页进页就把两块面板铺好（常驻），入口再点只做模式切换：重建面板会把用户写了一半的
// 提示词清空，所以宿主里已有面板时直接复用，不再走一遍构建。图片编辑入口带着图来，
// 就把这张图换进现成面板当原图（卡片菜单「图片编辑」与拖进预览区同一条路）
/** 面板宿主为绘画页时复用已铺好的面板：同种面板在位就只换内容（拖进来的原图），不重建 */
function reusePaintPanel(host, kind, image, subfolder) {

    if (!host?.__neoPanelRoot?.isConnected) return false;
    if (image) host.__neoSetSource?.(image, subfolder);
    _paintHosts?.onOpen?.(kind);
    return true;
}

export function openImageEditDialog(gallery, image = null, subfolder = "", opts = null) {
    const host = opts?.container || _paintHosts?.edit;
    if (reusePaintPanel(host, "edit", image, subfolder)) return;
    const panel = storyPanelRoot(host, "neo-gallery-edit-modal-overlay", "edit");
    const overlay = panel.root;
    // 原图可以后补：绘画页进页铺的就是空面板，把素材拖进预览区即成原图
    let source = image ? { filename: image.filename || image.name, subfolder: subfolder || "" } : null;
    const pathLabel = () => (source.subfolder ? `${source.subfolder}/` : "") + source.filename;
    const origUrl = () => `/neo_gallery/image?filename=${encodeURIComponent(source.filename)}&subfolder=${encodeURIComponent(source.subfolder)}`;

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    const actionsBox = $el("div", { className: "neo-gallery-story-actions" });
    const promptInput = $el("textarea", {
        className: "neo-gallery-story-input neo-gallery-gm-quick-input",
        rows: 4,
        placeholder: t("描述你想对这张图做的修改，例如：把背景换成海边日落、给角色加一顶帽子……")
    });

    let running = false;
    let cancelId = null;
    let cancelRequested = false;
    let refName = null;

    const close = () => overlay.remove();
    const fill = (box, ...children) => { box.textContent = ""; box.append(...children.filter(Boolean)); };
    const btn = (label, onclick, primary = false) =>
        $el("button", { className: "neo-gallery-story-btn" + (primary ? " neo-gallery-story-btn-primary" : ""), textContent: label, onclick });

    // 技能下拉：只列吃参考图的 image_gen 技能（必须带图的编辑类 + Qwen 2.1 这类两栖类）；
    // 纯文生图技能挂上原图也会被模板丢掉，不在本页列出。默认 Qwen Image 2.1。
    // 下拉收进输入卡的技能 chip：胶囊按钮 + 向上菜单，与文生图输入条同一枚控件
    const skillSel = $el("select", { className: "neo-recipes-sort neo-gallery-gm-chip-select neo-gallery-gm-skill-sel", title: t("技能与自定参数：只列吃参考图的生图技能；主模型 / LoRA 留空 = 跟随该技能配置与全局生图设置") });
    // 自定参数（同「生成素材」弹窗）：与技能同一枚 chip，点开从上方浮出双栏面板（左技能 / 右主模型 + LoRA），
    // 收起时不占输入卡空间。宽高比 / 最长边不在这里露出：编辑出图尺寸跟原图走（「目标分辨率」chip），比例覆盖在这条路上不生效。
    const editModelCfg = createModelConfigSection();
    for (const row of editModelCfg.el.querySelectorAll(".rs-gen-adv-row")) row.remove();
    const editModelBox = $el("div", { className: "neo-gallery-edit-model-box" });
    editModelBox.appendChild(editModelCfg.el);
    const skillChip = skillParamsChip(skillSel, editModelBox, {
        icon: "pencil",
        getOverride: () => editModelCfg.collect(),
    });
    // 换主模型 / 加 LoRA 后 chip 标签跟上（技能名 + 覆盖态）
    const syncEditParamsChip = () => skillChip.sync();
    editModelBox.addEventListener("change", syncEditParamsChip);
    guardMainModelFamily(editModelCfg, skillSel);
    let _genSkills = [];
    (async () => {
        try {
            const res = await fetch("/rs_prompts/skills");
            const skills = await res.json();
            _genSkills = (Array.isArray(skills) ? skills : []).filter(s => s.category === "image_gen" && s.gen_image && skillAcceptsRef(s));
            _genSkills.forEach(s => {
                const opt = $el("option", { value: s.id, textContent: skillDisplayName(s) });
                opt.__skillMeta = s;   // 家族与主模型副标题取这份元数据（populateSkillOptions 同一约定）
                if (s.id === QWEN_IMAGE_SKILL_ID) opt.selected = true;
                skillSel.appendChild(opt);
            });
            if (!_genSkills.some(s => s.id === QWEN_IMAGE_SKILL_ID)) {
                skillSel.value = _genSkills.length ? _genSkills[0].id : "";
            }
        } catch {
            skillSel.value = QWEN_IMAGE_SKILL_ID;
        }
        skillChip.sync();   // 下拉整份重建过：chip 标签跟着新选中项
    })();
    let editGenModels = null;   // 开窗拉一次模型列表，切技能重放配置时复用
    const applyEditModelCfg = async (skillId) => {
        if (!editGenModels || !skillId) return;
        editModelCfg.load(await getSkillGenConfig(skillId), editGenModels);
    };
    (async () => {
        try {
            editGenModels = await listGenModels();
            editModelCfg.load({}, editGenModels);   // 先按「自动」渲染，避免下拉为空
            await applyEditModelCfg(skillSel.value);   // 再覆盖为当前技能配置
            syncEditParamsChip();
        } catch { /* 模型列表拉不到就保持「自动」，不挡生成 */ }
    })();
    // 切换技能时自动填入默认提示词（如换脸触发词）
    skillSel.onchange = () => {
        const sk = _genSkills.find(s => s.id === skillSel.value);
        const dp = sk?.gen_config?.default_prompt;
        if (dp) promptInput.value = dp;
        applyEditModelCfg(skillSel.value).then(syncEditParamsChip);
    };

    const renderIdle = () => {
        const hint = !source ? t("把素材拖进预览区当原图，再写编辑指令")
            : panel.embedded ? t("写编辑指令、拖素材进预览区换原图，生成结果与原图左右对比")
            : t("填写编辑指令后点「生成」，原图将作为参考图传入所选技能。");
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint", textContent: hint }));
        fill(actionsBox, panel.embedded ? null : btn(t("取消"), close));
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
        if (images.length > 0) {
            const resultSrc = `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&size=640`;
            // 灯箱用全尺寸 /view 地址：对比窗里那张只是 640 缩略图，放大看不能糊。
            // 结果层 pointer-events:none（点击要落到原图上拖窗帘），结果图自己挂 onclick 永远点不到。
            resultItems = images.map(im => ({ kind: "image", url: im.url, title: im.filename }));
            resultImg.src = resultSrc;
            resultImg.title = t("点击放大查看");
            showResultOverlay();
            showEditedCanvas(final.canvas);
        }
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint", textContent: t("已生成编辑结果。") }));
        // 「生成」常驻输入卡：连续编辑直接再点它，不再挂一枚重复的「再生成」
        fill(actionsBox, panel.embedded ? null : btn(t("关闭"), close, true));
    };

    const renderError = (message) => {
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: message || t("生成失败") }));
        fill(actionsBox, panel.embedded ? null : btn(t("关闭"), close));
    };

    // 生图失败：窗内留错误 + 重试，另弹 action toast 引导去技能详情修模型（缺模型/节点等非 LLM 问题）
    const failGen = (message) => {
        renderError(message);
        actionToast({ severity: "error", summary: t("图片编辑生成失败"), detail: message, actionLabel: t("打开技能详情"), onAction: () => openSkillDetailById(skillSel.value || QWEN_IMAGE_SKILL_ID) });
    };

    const start = async () => {
        if (running) return;
        if (!source && !refName) { renderError(t("先把素材拖进预览区当原图")); return; }
        if (editMode === "local" && !painted) { renderError(t("请先涂抹要编辑的区域")); return; }
        if (editMode === "remove" && !removePoints.length) { renderError(t("请先点击原图标记要删除的物体")); return; }
        restoreOrigImage();   // 上一轮换过的缩放图先还原，避免扩图/局部的基准尺寸跟着变
        let prompt = promptInput.value.trim();
        if (editMode === "outpaint" && !prompt) prompt = OUTPAINT_DEFAULT_PROMPT;
        if (editMode === "remove" && !prompt) prompt = REMOVE_DEFAULT_PROMPT;
        if (editMode === "blend" && !prompt) prompt = BLEND_DEFAULT_PROMPT;
        if (editMode === "pose" && !prompt) prompt = extraRefs.length ? POSE_REF_DEFAULT_PROMPT : poseBasePrompt();
        if (!prompt) { promptInput.focus(); return; }
        running = true;
        cancelRequested = false;
        renderRunning(t("排队中…"));
        try {
            if (!refName) refName = await copyImageToInput(source, source.subfolder);
            // 扩图模式：带四边留白量 + 目标像素数；LoRA 由扩图技能 config 固定，不随请求传
            let outpaintPayload = null;
            let metaWidth = parseInt(widthInput.value, 10) || undefined;
            let metaHeight = parseInt(heightInput.value, 10) || undefined;
            // 常规编辑的目标尺寸：模板会据此把原图缩放后送进编码器，对比窗左侧同步换成缩放图；
            // 扩图/局部编辑走各自的画布（基准要用原图自然尺寸），这里必须清掉，免得沿用上一轮
            plainEdit = (editMode === "normal" || editMode === "pose") && !!metaWidth && !!metaHeight;
            if (editMode === "outpaint" && box) {
                const p = paddings();
                if (p.left || p.top || p.right || p.bottom) {
                    // 出图尺寸 = 补边画布（1MP 层 + 留白）整幅缩放到目标像素（与后端同算法）
                    const s = outputSize();
                    metaWidth = s.w;
                    metaHeight = s.h;
                    outpaintPayload = { ...p, total_pixels: targetMp(parseFloat(mpInput.value)) };
                }
            }
            const refs = [{ kind: "input", value: refName }];
            // 额外参考图（换脸/换身源图、多张融合、姿势参考）；局部编辑的涂抹遮罩走 data 通道
            if (editMode !== "outpaint" && editMode !== "local") {
                for (const r of extraRefs) {
                    refs.push({ kind: "input", value: r.subfolder ? `${r.subfolder}/${r.filename}` : r.filename });
                }
            }
            if (editMode === "local") refs.push({ kind: "data", data: maskCanvas.toDataURL("image/png") });
            const payload = {
                skill_id: skillSel.value || QWEN_IMAGE_SKILL_ID,
                prompt,
                width: metaWidth,
                height: metaHeight,
                references: refs,
                skip_enhance: true,
            };
            // 自定参数只带非空值：空串 / 空数组会覆盖掉该技能 config 与全局设置里的显式配置
            const ov = editModelCfg.collect();
            if (ov.model) payload.model = ov.model;
            if (ov.loras.length) payload.loras = ov.loras;
            if (outpaintPayload) {
                payload.outpaint = outpaintPayload;
            }
            if (editMode === "local") payload.local_edit = true;
            if (editMode === "remove") payload.remove_points = removePoints;
            const snap = await requestGeneration(payload);
            cancelId = snap.task_id;
            renderRunning(t("排队中…"));
            const final = await watchTask(snap.task_id, (s) => {
                renderRunning(s.status === "running" ? t("生图中…") : t("排队中…"), s.progress);
            }, () => cancelRequested);
            if (final.status === "succeeded") renderSuccess(final);
            else if (final.status === "cancelled") renderError(t("已取消"));
            else failGen(final.error || t("生成失败"));
        } catch (e) {
            console.error('[Gallery] image edit failed:', e);
            failGen(String(e?.message || e));
        } finally {
            running = false;
            cancelId = null;
        }
    };

    const onKey = (e) => {
        if (e.key === "Escape") {
            // 输入卡 chip 菜单开着时先关菜单，没有菜单才关窗
            if (composerChips.some(c => c.isOpen())) { for (const c of composerChips) c.close(); }
            else if (!panel.embedded) close();   // 内嵌面板由绘画页自己管生命周期，Esc 不销毁
        }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) start();
    };

    // 编辑模式 chip（与技能 chip 同一枚控件）：一枚胶囊 + 向上菜单，选模式即切 setEditMode；
    // 图标跟着模式换（扩图=补边框、局部=画笔、删除=叉、融合=叠图、姿势=人形），模式说明挂在菜单项上
    const MODE_ICONS = { normal: "wand", outpaint: "maximize", local: "pencil", remove: "cross", blend: "copy", pose: "user" };
    const modeSel = $el("select", { className: "neo-recipes-sort neo-gallery-gm-chip-select neo-gallery-edit-mode-select", title: t("编辑模式：决定在原图上怎么动手") });
    for (const [mode, name, tip] of [
        ["normal", t("常规"), t("常规编辑：按编辑指令整图重绘，原图作参考")],
        ["outpaint", t("扩图"), t("扩图：在原图上拖框定四边留白量，由模型补全周边场景")],
        ["local", t("局部"), t("高分局部编辑：涂抹要修改的区域，自动裁剪放大重绘后合并回原图")],
        ["remove", t("删除"), t("点选删除：在原图上点击要删除的物体，SAM3 自动分割并叠加红色遮罩预览，确认后移除（已预填默认删除指令，可修改）")],
        ["blend", t("融合"), t("多图融合：添加多张参考图，由模型自动融合为一张连贯画面")],
        ["pose", t("姿势"), t("姿势编辑：按提示词改原图人物的姿势；在参考图区拖入第 2 张图（人物图或骨架图）则把它的姿势搬到原图人物上，触发词自动切换")],
    ]) {
        modeSel.appendChild($el("option", { value: mode, textContent: name, title: tip }));
    }
    const modeChip = chipButton(modeSel, { icon: MODE_ICONS.normal });
    modeSel.addEventListener("change", () => setEditMode(modeSel.value));

    const sizeLabel = $el("span", { className: "neo-gallery-edit-size-label" });
    sizeLabel.style.display = "none";
    const ratioSel = $el("select", { className: "neo-recipes-sort neo-gallery-edit-ratio" });
    OUTPAINT_RATIOS.forEach(([value, label]) => {
        ratioSel.appendChild($el("option", { value, textContent: t(label) }));
    });
    // 目标像素数（MP）：补边画布整幅缩放到该像素数后出图（默认取全局设置，见「生图默认设置」）
    let globalTargetMp = DEFAULT_TARGET_MP;
    const mpInput = $el("input", { type: "number", className: "neo-recipes-sort neo-gallery-edit-mp", min: 0.5, max: 8, step: 0.5, value: String(globalTargetMp) });
    mpInput.title = t("补边画布缩放到多少像素数后出图（默认取「生图默认设置 → 目标像素数 (MP)」，出厂 1.5）");
    const resLabelEl = $el("label", { className: "neo-director-field-label", textContent: t("目标分辨率") });
    const outpaintRow = $el("div", { className: "neo-gallery-edit-outpaint-row" }, [
        $el("label", { className: "neo-director-field-label", textContent: t("目标比例") }),
        ratioSel,
        $el("label", { className: "neo-director-field-label", textContent: t("目标像素") }),
        mpInput,
        $el("span", { className: "neo-director-field-label", textContent: "MP" })
    ]);
    outpaintRow.style.display = "none";

    // 局部编辑控件：画笔大小 / 橡皮 / 清空（涂抹画布叠加在原图上）
    const brushInput = $el("input", { type: "range", className: "neo-gallery-edit-brush", min: 8, max: 200, step: 4, value: "48" });
    brushInput.title = t("画笔大小（显示像素）");
    const eraserChk = $el("input", { type: "checkbox" });
    const eraserLbl = $el("label", { className: "neo-director-field-label", title: t("勾选后涂抹变为擦除"), textContent: t("橡皮") });
    const clearBtn = $el("button", { className: "neo-gallery-story-btn", type: "button", textContent: t("清空") });
    const localRow = $el("div", { className: "neo-gallery-edit-outpaint-row" }, [
        $el("label", { className: "neo-director-field-label", textContent: t("画笔") }),
        brushInput,
        eraserLbl,
        eraserChk,
        clearBtn
    ]);
    localRow.style.display = "none";

    // 点选删除控件：在原图上点击标记要删的物体（最多 5 点），SAM3 分割后走局部编辑管线移除
    const removeHint = $el("span", { className: "neo-gallery-edit-size-label" });
    const removeClearBtn = $el("button", { className: "neo-gallery-story-btn", type: "button", textContent: t("清空标记") });
    const removeRow = $el("div", { className: "neo-gallery-edit-outpaint-row" }, [
        $el("label", { className: "neo-director-field-label", textContent: t("点击原图上的物体标记（最多 5 点，点标记可取消）") }),
        removeHint,
        removeClearBtn
    ]);
    removeRow.style.display = "none";

    // 出图尺寸 chip：默认跟原图走（原图探测完按目标像素数填 32 对齐的默认值），点开才露出宽高输入
    const widthInput = $el("input", { type: "number", className: "neo-recipes-sort", id: "img-edit-width", min: 256, max: 8192, step: 32, placeholder: t("宽") });
    const heightInput = $el("input", { type: "number", className: "neo-recipes-sort", id: "img-edit-height", min: 256, max: 8192, step: 32, placeholder: t("高") });
    const sizeEditor = $el("div", { className: "neo-gallery-edit-size-editor" }, [
        widthInput, $el("span", { textContent: " × " }), heightInput, sizeLabel,
    ]);
    sizeEditor.style.display = "none";
    const sizeChipVal = $el("span", { className: "neo-gallery-edit-size-chip-val", textContent: t("跟随原图") });
    const sizeChip = $el("button", {
        className: "neo-gallery-gm-chip-btn neo-gallery-edit-size-chip", type: "button",
        title: t("本次出图尺寸：默认 = 原图缩放到目标像素数（生图默认设置里的 MP）；点开可手改宽高"),
    }, [
        icon("fullscreen", 12),
        $el("span", { className: "neo-gallery-gm-chip-label" }, [resLabelEl, sizeChipVal]),
    ]);
    const syncSizeChip = () => {
        const w = widthInput.value, h = heightInput.value;
        sizeChipVal.textContent = (w && h) ? `${w}×${h}` : t("跟随原图");
    };
    sizeChip.addEventListener("click", () => {
        const open = sizeEditor.style.display === "none";
        sizeEditor.style.display = open ? "" : "none";
        sizeChip.classList.toggle("on", open);
    });


    // 参考图区（autogrow）：拖入一张追加新空槽，最多 9 张（Qwen Image 2.1 上限）
    // 这一行挂在输入卡里（提示词框上方），与提示词框同一块描边，不再单独占一块焦点框
    const MAX_EXTRA_REFS = 9;
    const refDropContainer = $el("div", { className: "neo-gallery-edit-refdrop-row" });
    const refFileInput = document.createElement("input");
    refFileInput.type = "file";
    refFileInput.accept = "image/*";
    refFileInput.multiple = true;
    refFileInput.style.display = "none";
    refDropContainer.appendChild(refFileInput);
    // 取图浮层：hover 左上角「＋参考」方块才浮出，头部计数 + 本地上传 / 素材库取用两项
    const refPickRow = $el("div", { className: "neo-gallery-edit-refpicks" }, [
        $el("div", { className: "neo-gallery-edit-refcount" }, [
            $el("span", { textContent: t("参考图") }),
            $el("span", { className: "neo-gallery-edit-refcount-num", textContent: `0/${MAX_EXTRA_REFS}` }),
        ]),
        $el("button", {
            className: "neo-gallery-edit-refpick", type: "button", textContent: "⬆ " + t("本地上传"),
            title: t("从本地文件选图作参考（可多选）"),
            onclick: () => { refFileInput._targetIndex = null; refFileInput.click(); closePicks(); },
        }),
        $el("button", {
            className: "neo-gallery-edit-refpick", type: "button", textContent: "🖼 " + t("素材库取用"),
            title: t("从素材库取图作参考：弹窗里点卡片取用，或从素材库拖进图位"),
            onclick: () => {
                // Studio 宿主听 neo:media-pick 开素材库弹窗取用；ComfyUI 里没有监听，开侧栏照旧拖拽
                refFileInput._targetIndex = null;
                window.dispatchEvent(new CustomEvent("neo:media-pick", { detail: { target: null, onPick: addRefImages } }));
                toggleGallerySidebar();
                closePicks();
            },
        }),
    ]);
    refDropContainer.appendChild(refPickRow);
    const refCountNum = refPickRow.querySelector(".neo-gallery-edit-refcount-num");
    const syncRefCount = () => { refCountNum.textContent = `${extraRefs.length}/${MAX_EXTRA_REFS}`; };
    // 浮层带 6px 间隙开在方块上方，纯 :hover 跨不过间隙（鼠标一离开方块行就失 hover、浮层变不可点，点不中）：
    // JS 开关 + 关闭宽限，离开后留一段定时器，期间移入浮层取消关闭，鼠标来得及跨过间隙点中两项
    let pickCloseTimer = 0;
    const openPicks = () => { clearTimeout(pickCloseTimer); refDropContainer.classList.add("picks-open"); };
    const closePicks = () => { clearTimeout(pickCloseTimer); pickCloseTimer = setTimeout(() => refDropContainer.classList.remove("picks-open"), 250); };
    refDropContainer.addEventListener("mouseenter", openPicks);
    refDropContainer.addEventListener("mouseleave", closePicks);
    refPickRow.addEventListener("mouseenter", openPicks);
    refPickRow.addEventListener("mouseleave", closePicks);

    // 图片对比区（前后叠加 + 拖拽窗帘）
    const refFullUrl = (it) => `/neo_gallery/image?filename=${encodeURIComponent(it.filename)}&subfolder=${encodeURIComponent(it.subfolder ? `input/${it.subfolder}` : "input")}`;
    // Lightbox 统一列表：原图 + 所有参考图，支持 ←/→ 切换
    const buildLightboxItems = () => [
        { kind: "image", url: origUrl(), title: pathLabel() },
        ...extraRefs.map((r) => ({ kind: "image", url: refFullUrl(r), title: r.filename }))
    ];
    // 本次生成的结果图（全尺寸地址），未生成时为空
    let resultItems = [];
    // 点图落在窗帘哪一侧：分割线右侧露的是结果图、左侧露的是原图；窗帘贴右 = 整幅原图，没有结果可看
    const isResultSide = (clientX) => {
        if (!resultItems.length || dividerPct >= 100) return false;
        const rect = divider.parentElement.getBoundingClientRect();
        return ((clientX - rect.left) / rect.width) * 100 >= dividerPct;
    };
    const openCompareLightbox = (showResult) => {
        const items = buildLightboxItems();
        if (!resultItems.length) return Lightbox.open({ items, index: 0 });
        const firstResult = items.length;
        items.push(...resultItems);
        Lightbox.open({ items, index: showResult ? firstResult : 0 });
    };
    const origImg = $el("img", {
        className: "neo-gallery-edit-compare-img",
        src: source ? origUrl() : "",
        alt: source ? source.filename : "",
        title: t("点击放大查看")
    });
    const resultImg = $el("img", {
        className: "neo-gallery-edit-compare-img neo-gallery-edit-result-img",
        alt: t("编辑结果")
    });
    // imgwrap：非扩图时收缩到原图显示尺寸；开扩图后变为中心舞台（画布超出时整体等比缩小）
    const imgWrap = $el("div", { className: "neo-gallery-edit-compare-imgwrap" });
    // 结果图裁剪层 + 拖拽分割线（窗帘效果）：与原图同盒，覆盖区域才能逐像素对齐
    const resultClip = $el("div", { className: "neo-gallery-edit-result-clip", style: { display: "none" } }, [resultImg]);
    const divider = $el("div", { className: "neo-gallery-edit-divider", style: { display: "none" } });
    imgWrap.append(origImg, resultClip, divider);
    // 空面板进页就在位：预览区即拖放落点，从素材库拖一张进来当原图
    const emptyDrop = source ? null : $el("div", { className: "neo-gallery-edit-empty", textContent: t("把素材拖到这里当原图") });
    if (emptyDrop) {
        origImg.style.display = "none";
        imgWrap.classList.add("neo-gallery-edit-empty-stage");
        imgWrap.appendChild(emptyDrop);
    }
    const compareLabel = $el("span", { className: "neo-gallery-edit-compare-label", textContent: COMPARE_LABEL });
    // 灯箱按钮入口：局部/点选模式点图是涂抹/打点，扩图模式点图落在拖框框体上，都只能从这里进
    const zoomBtn = $el("button", {
        className: "neo-gallery-edit-zoom-btn", type: "button", textContent: t("看大图"),
        title: t("灯箱查看原图、编辑结果与参考图"),
        onclick: () => openCompareLightbox(false)
    });
    // 扩图 / 局部 / 点选删除 / 融合 / 姿势都要在原图上动手，没原图时先收起这些入口。
    // 禁用态要自己说出缺什么：一枚灰 chip 挂着一句「在原图上拖框」的 tooltip，在用户眼里就是点坏了的控件
    const sourceBtns = [modeChip.chip, zoomBtn];
    const sourceTitles = sourceBtns.map((b) => b.title);
    const noSourceTitle = t("先拖入原图（从素材库取一张，或把图片文件拖进来）");
    const setSourceModeBtns = (on) => {
        sourceBtns.forEach((b, i) => {
            b.disabled = !on;
            b.title = on ? sourceTitles[i] : noSourceTitle;
        });
    };
    setSourceModeBtns(!!source);
    const compareLabelRow = $el("div", { className: "neo-gallery-edit-compare-label-row" }, [compareLabel, zoomBtn]);
    // 舞台：只负责把图片盒水平居中
    const compareStage = $el("div", { className: "neo-gallery-edit-compare-stage" }, [imgWrap]);
    const compareBox = $el("div", { className: "neo-gallery-edit-compare" }, [
        $el("div", {}, [compareLabelRow, compareStage])
    ]);

    // 窗帘拖拽逻辑：分割线左侧露出原图、右侧露出结果图（结果图层整幅不缩放，只裁掉左侧 pct%）
    // 按下后必须拖过阈值才算拖窗帘：原地按下即抬起是「点图」，交给灯箱看大图（点分割线把手同理）
    const DIVIDER_DRAG_PX = 6;
    let dividerDrag = null;
    let dividerPct = 0;   // 窗帘位置：点图看大图时按它判断点在哪一侧
    const setDividerPos = (pct) => {
        pct = Math.max(0, Math.min(100, pct));
        dividerPct = pct;
        resultClip.style.clipPath = `inset(0 0 0 ${pct}%)`;
        divider.style.left = pct + "%";
    };
    // 分割线挂在原图盒/扩图画布内，位置按所在容器宽算百分比（舞台/画布可能比原图宽）
    const posFromClientX = (clientX) => {
        const rect = divider.parentElement.getBoundingClientRect();
        setDividerPos(((clientX - rect.left) / rect.width) * 100);
    };
    const onDividerMove = (e) => {
        if (!dividerDrag) return;
        dividerDrag.moved = Math.max(dividerDrag.moved, Math.abs(e.clientX - dividerDrag.sx));
        if (dividerDrag.moved >= DIVIDER_DRAG_PX) posFromClientX(e.clientX);
    };
    const onDividerEnd = (e) => {
        const d = dividerDrag;
        dividerDrag = null;
        if (!d || d.moved >= DIVIDER_DRAG_PX) return;
        // 按下即抬起是「点图」：点落在窗帘右侧看结果图、左侧看原图；把手是边界，固定看原图
        const x = (e && e.clientX) || d.sx;
        openCompareLightbox(!d.onHandle && isResultSide(x));
    };
    // 只吃原图与分割线：局部/点选模式的涂抹画布、扩图框体各有自己的按下语义（扩图框体自己判点图）
    imgWrap.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (e.target !== origImg && e.target !== divider) return;
        e.preventDefault();
        dividerDrag = { sx: e.clientX, moved: 0, onHandle: e.target === divider };
    });
    document.addEventListener("pointermove", onDividerMove);
    document.addEventListener("pointerup", onDividerEnd);

    // 常规编辑：模板里的 ImageScale 把原图缩放到画布尺寸后才送进编码器（参考工作流「图像编辑」同款链路），
    // 对比窗左侧也换成这张缩放图——两侧同尺寸才能逐像素对比（否则 contain 会把结果图挤进「原图盒」，
    // 比例不同 → 越靠上下边缘错位越明显）。画布尺寸随任务返回（final.canvas），前端不重复计算。
    let plainEdit = false;      // 本次是否为常规编辑（扩图/局部编辑各有自己的画布，不参与替换）
    let scaledInputSrc = "";    // 缩放后的原图（dataURL）；非空即表示左侧已替换
    const restoreOrigImage = () => {
        if (!scaledInputSrc) return;
        scaledInputSrc = "";
        origImg.src = origUrl();
        compareLabel.textContent = COMPARE_LABEL;
    };
    const showEditedCanvas = (canvas) => {
        if (!plainEdit || scaledInputSrc || !canvas) return;
        const [cw, ch] = canvas;
        if (!cw || !ch) return;
        const c = document.createElement("canvas");
        c.width = cw;
        c.height = ch;
        // 用尺寸探针（同一张原图、已解码）作源，不受可见图元素加载时机影响
        c.getContext("2d").drawImage(dimProbe, 0, 0, cw, ch);
        scaledInputSrc = c.toDataURL("image/png");
        origImg.src = scaledInputSrc;
        compareLabel.textContent = tf("原图（缩放到 {cw}×{ch}）/ 编辑结果（拖拽分割线对比）", { cw, ch });
    };

    const showResultOverlay = () => {
        resultClip.style.display = "";
        divider.style.display = "";
        // 初始贴左边界：整幅显示结果图，往右拖分割线才逐渐露出原图对比
        setDividerPos(0);
    };

    // 输入卡（与文生图同一组贴底控件）：编辑指令框 + 底行 chip（技能与自定参数 / 模式 / 出图尺寸 … 生成）；
    // 点「出图尺寸」chip 才在底行下方露出宽高输入，点「技能」chip 从上方浮出技能 / 主模型双栏面板
    const genBtn = btn(t("生成"), start, true);
    genBtn.classList.add("neo-gallery-gm-gen-btn");
    const composerChips = [skillChip, modeChip];
    // 参考图位与编辑指令框在同一块输入卡里：一框一事，卡里只有一处主焦点
    const composer = $el("div", { className: "neo-gallery-gm-composer" }, [
        $el("div", { className: "neo-gallery-edit-refline" }, [refDropContainer, promptInput]),
        $el("div", { className: "neo-gallery-gm-composer-bar neo-gallery-gm-chips" }, [
            skillChip.el,
            modeChip.el,
            sizeChip,
            $el("div", { className: "neo-gallery-gm-composer-gap" }),
            genBtn,
        ]),
        sizeEditor
    ]);

    overlay.appendChild($el("div", { className: "neo-gallery-story-modal neo-gallery-edit-modal" + (panel.embedded ? " neo-gallery-story-modal--embedded" : "") }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: t("图片编辑") }),
            $el("span", { className: "neo-gallery-story-close", textContent: "\u00D7", onclick: close })
        ]),
        // 图片在上、操作在下：对比区（原图 | 编辑结果 + 分割线滑块）固定在窗内上方
        compareBox,
        $el("div", { className: "neo-gallery-edit-form" }, [
            outpaintRow,
            localRow,
            removeRow,
            statusBox,
            composer,
            actionsBox
        ])
    ]));

    renderIdle();
    const onDocClick = (e) => { for (const chip of composerChips) chip.closeOnOutside(e.target); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onDocClick);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => {
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("click", onDocClick);
        document.removeEventListener("pointermove", onDividerMove);
        document.removeEventListener("pointerup", onDividerEnd);
        origRemove();
    };
    if (panel.embedded) {
        panel.host.appendChild(overlay);
        panel.host.__neoPanelClose = () => { close(); panel.host.__neoPanelRoot = null; panel.host.__neoSetSource = null; };
        panel.host.__neoSetSource = (img, sub) => applySource(img.filename || img.name, sub || "");
    } else {
        document.body.appendChild(overlay);
        // 标题栏拖动 + 双击最大化/还原（同导演编辑器 / 生成素材窗模式）
        makeStoryWindowDraggable(overlay.querySelector(".neo-gallery-edit-modal"));
    }

    // 原图尺寸填进宽高输入（32 对齐：Qwen2.1 latent 一格 = 32px，错开会让模型自己补/裁一格）
    for (const el of [widthInput, heightInput]) {
        el.addEventListener("change", () => {
            const v = parseInt(el.value, 10);
            if (v > 0) el.value = String(round32(v));
            syncSizeChip();
        });
        el.addEventListener("input", syncSizeChip);
    }

    const dimProbe = new Image();
    const fullUrlReady = () => {
        if (!source) return;
        dimProbe.src = origUrl();
    };
    dimProbe.onload = () => {
        if (dimProbe.naturalWidth && dimProbe.naturalHeight) {
            const t = editDefaultTargetSize(dimProbe.naturalWidth, dimProbe.naturalHeight, globalTargetMp);
            widthInput.value = t.w;
            heightInput.value = t.h;
            syncSizeChip();
        }

    };
    // 先读全局设置里的目标像素数（MP，出厂 1.5）再探测原图尺寸，保证默认目标用的是配置值
    (async () => {
        try {
            const cfg = await getGenSettings();
            const v = parseFloat(cfg?.target_megapixels);
            if (v > 0) {
                // 用户已经改过输入框就别覆盖
                if (mpInput.value === String(globalTargetMp)) mpInput.value = String(v);
                globalTargetMp = v;
                updateSizeLabel();
            }
        } catch (e) {
            console.warn("[Gallery] image gen settings unavailable, using default target MP:", e);
        }
        fullUrlReady();
    })();

    // ---- 编辑模式统一管理（normal / outpaint / local / remove / blend / pose） ----
    let editMode = "normal";

    // ---- 扩图：原图上拖框定四边留白量（只向外扩；比例模式锁长宽比） ----
    let box = null;        // {x, y, w, h} 画布坐标（基准像素），原点为原图左上角
    let base = null;       // 基准尺寸：原图 contain 进舞台后的可见图片尺寸；开扩图时定一次后冻结
    let canvasEl = null;   // 原图+留白整体，超出舞台时 transform 等比缩小
    let boxEl = null;

    // 原图元素带 object-fit:contain，元素盒含左右留黑，量元素盒会把留黑算进画布；开扩图后原图已
    // 移进画布（量它为 0），所以按「自然尺寸 + 舞台盒」算 contain 结果。无布局时退回元素盒/自然尺寸。
    const fitSize = () => {
        const nw = origImg.naturalWidth, nh = origImg.naturalHeight;
        const bw = imgWrap.clientWidth, bh = imgWrap.clientHeight;
        if (!nw || !nh || !bw || !bh) {
            return { dw: origImg.clientWidth || nw, dh: origImg.clientHeight || nh };
        }
        const k = Math.min(bw / nw, bh / nh);
        return { dw: nw * k, dh: nh * k };
    };
    const imgSize = () => base;
    const ratioValue = () => {
        if (ratioSel.value === "free") return null;
        const [a, b] = ratioSel.value.split(":").map(Number);
        return a / b;
    };
    // 画布超出舞台时的显示缩放（jsdom 无布局时退化为 1）
    const viewScale = () => {
        if (!box) return 1;
        const { dw, dh } = imgSize();
        const aw = imgWrap.clientWidth || dw;
        const ah = imgWrap.clientHeight || dh;
        return Math.min(1, aw / box.w, ah / box.h);
    };
    // 画布尺寸/原图偏移/整体缩放同步到 DOM（拖框铺满画布，由 CSS 定位）
    const syncOutpaintView = () => {
        if (!canvasEl || !box) return;
        const { dw, dh } = imgSize();
        canvasEl.style.width = `${box.w}px`;
        canvasEl.style.height = `${box.h}px`;
        origImg.style.left = `${-box.x}px`;
        origImg.style.top = `${-box.y}px`;
        origImg.style.width = `${dw}px`;
        origImg.style.height = `${dh}px`;
        const s = viewScale();
        canvasEl.style.transform = `scale(${s})`;
        canvasEl.style.setProperty("--op-inv", s > 0 ? (1 / s).toFixed(4) : "1");
    };
    // 四边留白：以「原图按 1MP 归一化后那一层」的像素计（后端 ImagePadForOutpaint 就补在这一层），
    // 所以拖动量先按显示→原图换算、再乘 1MP 归一化的缩放比，扩出来的比例才和拖出来的一致
    const paddings = () => {
        const { dw, dh } = imgSize();
        const nw = origImg.naturalWidth || dw, nh = origImg.naturalHeight || dh;
        const ref = scaleToMp(nw, nh, OUTPAINT_REF_MP);
        const s = nw / dw;
        const kx = ref.w / nw * s, ky = ref.h / nh * s;
        return { left: Math.max(0, Math.round(-box.x * kx)),
                 top: Math.max(0, Math.round(-box.y * ky)),
                 right: Math.max(0, Math.round((box.x + box.w - dw) * kx)),
                 bottom: Math.max(0, Math.round((box.y + box.h - dh) * ky)) };
    };
    // 最终出图尺寸：补边画布（1MP 层）再加留白，整幅缩放到目标像素（32 对齐）——与后端同算法
    const outputSize = () => {
        const p = paddings();
        const ref = scaleToMp(origImg.naturalWidth, origImg.naturalHeight, OUTPAINT_REF_MP);
        return scaleToMp(ref.w + p.left + p.right, ref.h + p.top + p.bottom,
                         targetMp(parseFloat(mpInput.value)));
    };
    const updateSizeLabel = () => {
        if (editMode !== "outpaint" || !box) { sizeLabel.textContent = ""; return; }
        const p = paddings();
        // 没拖框时就是原图尺寸；拖了就显示出图尺寸（补边画布整幅缩放到目标像素后的尺寸）
        sizeLabel.textContent = (p.left || p.top || p.right || p.bottom)
            ? tf("目标 {w}×{h}", { w: outputSize().w, h: outputSize().h })
            : tf("目标 {w}×{h}", { w: origImg.naturalWidth, h: origImg.naturalHeight });
    };
    const dragResize = (mode, dx, dy, b0, dw, dh, R) => {
        const b = { ...b0 };
        if (mode === "move") {
            // 平移：只挪留白分布，框必须仍包住原图（x ≤ 0 且 x + w ≥ dw）
            b.x = Math.min(0, Math.max(dw - b0.w, b0.x + dx));
            b.y = Math.min(0, Math.max(dh - b0.h, b0.y + dy));
            return b;
        }
        if (!R) {
            // 自由：只向外扩（框必须包住原图）
            if (mode.includes("e")) b.w = Math.max(dw, b0.x + b0.w + dx);
            if (mode.includes("w")) { const nx = Math.min(0, b0.x + dx); b.x = nx; b.w = b0.x + b0.w - nx; }
            if (mode.includes("s")) b.h = Math.max(dh, b0.y + b0.h + dy);
            if (mode.includes("n")) { const ny = Math.min(0, b0.y + dy); b.y = ny; b.h = b0.y + b0.h - ny; }
            b.w = Math.min(b.w, dw * OUTPAINT_MAX_EXTEND);
            b.h = Math.min(b.h, dh * OUTPAINT_MAX_EXTEND);
            return b;
        }
        // 比例锁定：等比缩放，锚定对边/对角
        let s;
        if (mode === "n" || mode === "s") s = (b0.h + (mode === "s" ? dy : -dy)) / b0.h;
        else if (mode === "e" || mode === "w") s = (b0.w + (mode === "e" ? dx : -dx)) / b0.w;
        else s = Math.max((b0.w + (mode.includes("e") ? dx : -dx)) / b0.w,
                          (b0.h + (mode.includes("s") ? dy : -dy)) / b0.h);
        // 把手拖过对边时 s 会掉到 0 甚至负数：下限锁在「仍盖住原图」上
        s = Math.max(s, dw / b0.w, dh / b0.h);
        let w = b0.w * s, h = b0.h * s;
        if (w > dw * OUTPAINT_MAX_EXTEND || h > dh * OUTPAINT_MAX_EXTEND) {
            // 封顶不许把框缩到包不住原图：缩一半时以「仍盖住原图」为准
            const cap = Math.min(dw * OUTPAINT_MAX_EXTEND / w, dh * OUTPAINT_MAX_EXTEND / h);
            const k = Math.max(cap, Math.max(dw / w, dh / h));
            w *= k; h *= k;
        }
        const left0 = b0.x, right0 = b0.x + b0.w, top0 = b0.y, bottom0 = b0.y + b0.h;
        if (mode.includes("e")) b.x = left0;
        else if (mode.includes("w")) b.x = right0 - w;
        else b.x = (left0 + right0) / 2 - w / 2;   // n/s：水平居中不动
        if (mode.includes("s")) b.y = top0;
        else if (mode.includes("n")) b.y = bottom0 - h;
        else b.y = (top0 + bottom0) / 2 - h / 2;   // e/w：垂直居中不动
        // 锚点后只钳位置、不动尺寸：框必须盖住原图，且长宽比保持锁定
        // （旧写法补宽不补高，1:1 会被拉成矩形，原图在框里跟着偏）
        b.x = Math.min(0, Math.max(dw - w, b.x));
        b.y = Math.min(0, Math.max(dh - h, b.y));
        b.w = w; b.h = h;
        return b;
    };
    const attachBoxEvents = () => {
        let drag = null;
        const onMove = (ev) => {
            if (!drag) return;
            drag.moved = Math.max(drag.moved, Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy));
            const { dw, dh } = imgSize();
            // 指针位移按按下时的显示缩放换算；拖动中画布变大、缩放会变小，若每帧重算会让框成倍暴涨
            box = dragResize(drag.mode, (ev.clientX - drag.sx) * drag.k, (ev.clientY - drag.sy) * drag.k,
                             drag.b0, dw, dh, ratioValue());
            syncOutpaintView();
            updateSizeLabel();
        };
        const onUp = (ev) => {
            const d = drag;
            drag = null;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            // 拖框铺满画布，原图点不到：框体上按下即抬起（没拖动）就是点图，按窗帘位置决定看原图还是结果
            if (d && d.mode === "move" && d.moved <= 3) openCompareLightbox(isResultSide(ev.clientX));
        };
        boxEl.addEventListener("pointerdown", (ev) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            const handleEl = ev.target.closest(".neo-gallery-edit-outpaint-handle");
            const s = viewScale();
            drag = { mode: handleEl ? handleEl.dataset.handle : "move",
                     sx: ev.clientX, sy: ev.clientY, b0: { ...box }, k: s > 0 ? 1 / s : 1, moved: 0 };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
        });
    };
    // 窗口变化后舞台尺寸变了：基准尺寸跟着重算，框按同一比例缩放，留白量保持不变
    const onStageResize = () => {
        if (!base) return;
        const next = fitSize();
        if (next.dw > 0 && next.dh > 0 && next.dw !== base.dw) {
            const k = next.dw / base.dw;
            box = { x: box.x * k, y: box.y * k, w: box.w * k, h: box.h * k };
            base = next;
        }
        syncOutpaintView();
        updateSizeLabel();
    };
    const teardownOutpaintBox = () => {
        window.removeEventListener("resize", onStageResize);
        if (boxEl) boxEl.remove();
        if (canvasEl) {
            imgWrap.append(origImg, resultClip, divider);   // 原图/结果层/分割线归位，恢复 CSS 自适应尺寸
            origImg.style.cssText = "";
            canvasEl.remove();
        }
        canvasEl = null;
        boxEl = null;
        box = null;
        base = null;
        imgWrap.classList.remove("neo-gallery-edit-outpaint");
    };
    const setupOutpaintBox = () => {
        teardownOutpaintBox();
        imgWrap.classList.add("neo-gallery-edit-outpaint");
        base = fitSize();
        box = { x: 0, y: 0, w: base.dw, h: base.dh };
        canvasEl = $el("div", { className: "neo-gallery-edit-outpaint-canvas" });
        boxEl = $el("div", { className: "neo-gallery-edit-outpaint-box" });
        for (const pos of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
            boxEl.appendChild($el("div", { className: `neo-gallery-edit-outpaint-handle neo-gallery-edit-outpaint-handle-${pos}`, dataset: { handle: pos } }));
        }
        // 原图/结果层/分割线都进画布：结果=补边画布整幅，落在这里才和原图区域逐像素对齐
        // （挂在图片盒上会被 contain 缩放 → 扩图结果看起来整体错位）
        canvasEl.append(origImg, resultClip, boxEl, divider);
        imgWrap.append(canvasEl);
        syncOutpaintView();
        attachBoxEvents();
        window.addEventListener("resize", onStageResize);
    };
    const snapBoxToRatio = () => {
        if (!box) return;
        const R = ratioValue();
        if (!R) return;
        const { dw, dh } = imgSize();
        // 框尺寸只由「原图显示尺寸 + 目标比例」定：换预设要回到该比例包住原图的最小框。
        // 旧写法从上一个比例的框接着算，只放大不缩回，连换几次后原图在框里只剩一小格
        const w = Math.max(dw, dh * R), h = w / R;
        // 中心尽量沿用现框中心（保住用户拖出来的留白分布），越界就贴回能包住原图的边界
        const cx = Math.min(w / 2, Math.max(dw - w / 2, box.x + box.w / 2));
        const cy = Math.min(h / 2, Math.max(dh - h / 2, box.y + box.h / 2));
        box = { x: cx - w / 2, y: cy - h / 2, w, h };
        syncOutpaintView();
        updateSizeLabel();
    };
    // ---- 统一编辑模式切换（新增模式只需在此加一个 case） ----
    // 姿势模式触发词随参考图切换：没参考图 = 按提示词改姿势（技能 config 的 default_prompt），
    // 拖入姿势参考 = 换成迁移触发词。只替换「空 / 仍是默认词」的提示词，用户写过的不动。
    const poseBasePrompt = () => String(_genSkills.find(s => s.id === QWEN_POSE_EDIT_SKILL_ID)?.gen_config?.default_prompt || "").trim();
    const syncPosePrompt = () => {
        if (editMode !== "pose") return;
        const base = poseBasePrompt();
        const cur = promptInput.value.trim();
        if (cur && cur !== base && cur !== POSE_REF_DEFAULT_PROMPT) return;
        const want = extraRefs.length ? POSE_REF_DEFAULT_PROMPT : base;
        if (want) promptInput.value = want;
    };
    const setEditMode = async (mode) => {
        if (mode === editMode) return;
        const prev = editMode;
        editMode = mode;

        // teardown 旧模式
        if (prev === "outpaint") teardownOutpaintBox();
        if (prev === "local") teardownPaint();
        if (prev === "remove") teardownRemove();

        restoreOrigImage();

        // 模式 chip：菜单里的选中值与图标跟着模式换（程序改 value 不触发 change，sync 自己跟上）
        modeSel.value = mode;
        modeChip.sync();
        modeChip.setIcon(MODE_ICONS[mode]);

        // 模式专属行
        outpaintRow.style.display = mode === "outpaint" ? "" : "none";
        localRow.style.display = mode === "local" ? "" : "none";
        removeRow.style.display = mode === "remove" ? "" : "none";

        // 尺寸片：扩图/局部/删除各自的画布定尺寸，片收起；扩图要把「目标尺寸」读数露在编辑区里
        const hideWH = (mode === "outpaint" || mode === "local" || mode === "remove");
        widthInput.style.display = hideWH ? "none" : "";
        heightInput.style.display = hideWH ? "none" : "";
        resLabelEl.textContent = { outpaint: t("目标尺寸"), local: t("编辑区（自动）"), remove: t("同原图") }[mode] || t("目标分辨率");
        sizeLabel.style.display = mode === "outpaint" ? "" : "none";
        sizeChip.style.display = hideWH && mode !== "outpaint" ? "none" : "";
        const openEditor = mode === "outpaint";
        sizeEditor.style.display = openEditor ? "" : "none";
        sizeChip.classList.toggle("on", openEditor);


        // 技能选择（程序改 value 不触发 onchange，自定参数要自己重放到新技能的配置）
        skillSel.value = { outpaint: QWEN_OUTPAINT_SKILL_ID, local: QWEN_LOCAL_EDIT_SKILL_ID, pose: QWEN_POSE_EDIT_SKILL_ID }[mode] || QWEN_IMAGE_SKILL_ID;
        skillChip.sync();
        await applyEditModelCfg(skillSel.value);
        syncEditParamsChip();

        // 模式专属 setup
        if (mode === "outpaint") {
            setupOutpaintBox();
            snapBoxToRatio();
            if (!promptInput.value.trim()) promptInput.value = OUTPAINT_DEFAULT_PROMPT;
        } else if (mode === "local") {
            await setupPaint();
        } else if (mode === "remove") {
            widthInput.value = origImg.naturalWidth || "";
            heightInput.value = origImg.naturalHeight || "";
            await setupRemoveClicks();
            if (!promptInput.value.trim()) promptInput.value = REMOVE_DEFAULT_PROMPT;
            if (!refName) {
                try { refName = await copyImageToInput(image, subfolder); }
                catch (e) { removeHint.textContent = tf("原图读取失败：{msg}", { msg: e.message }); }
            }
        } else if (mode === "blend") {
            if (!promptInput.value.trim()) promptInput.value = BLEND_DEFAULT_PROMPT;
        } else if (mode === "pose") {
            syncPosePrompt();
        }

        syncRefBtn();
        updateSizeLabel();
        syncSizeChip();
    };


    ratioSel.addEventListener("change", snapBoxToRatio);
    mpInput.addEventListener("input", updateSizeLabel);

    // ---- 局部编辑：涂抹画布叠加在原图上（遮罩存自然分辨率，红色高亮层仅显示用） ----
    let maskCanvas = null;   // 遮罩（灰度，自然分辨率）——payload 传这张
    let tintCanvas = null;   // 红色高亮层（自然分辨率）
    let paintCanvas = null;  // 叠加在原图上的显示画布
    let painted = false;

    const ensureImgLoaded = () => new Promise((res) => {
        if (origImg.naturalWidth && origImg.naturalHeight) res();
        else origImg.onload = () => res();
    });
    // 显示画布对齐原图 contain 显示盒（元素盒含留黑，需算偏移）
    const syncPaintView = () => {
        if (!paintCanvas) return;
        const nw = origImg.naturalWidth, nh = origImg.naturalHeight;
        const bw = imgWrap.clientWidth, bh = imgWrap.clientHeight;
        if (!nw || !nh || !bw || !bh) return;
        const k = Math.min(bw / nw, bh / nh);
        paintCanvas.style.left = `${(bw - nw * k) / 2}px`;
        paintCanvas.style.top = `${(bh - nh * k) / 2}px`;
        paintCanvas.width = Math.max(1, Math.round(nw * k));
        paintCanvas.height = Math.max(1, Math.round(nh * k));
        redrawPaintOverlay();
    };
    const redrawPaintOverlay = () => {
        if (!paintCanvas || !tintCanvas) return;
        const ctx = paintCanvas.getContext("2d");
        ctx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
        if (painted) ctx.drawImage(tintCanvas, 0, 0, paintCanvas.width, paintCanvas.height);
    };
    // 画笔半径（自然像素）：滑杆是显示像素，按显示缩放换算
    const brushRadius = () => {
        const nw = origImg.naturalWidth || 1;
        const dw = paintCanvas ? paintCanvas.width : nw;
        return Math.max(2, (parseInt(brushInput.value, 10) / 2) * (nw / dw));
    };
    const stroke = (x0, y0, x1, y1, erase) => {
        if (!maskCanvas || !tintCanvas) return;
        const r = brushRadius();
        for (const [cv, style] of [[maskCanvas, "#ffffff"], [tintCanvas, "rgba(255,0,0,0.9)"]]) {
            const ctx = cv.getContext("2d");
            ctx.save();
            ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
            ctx.strokeStyle = style;
            ctx.fillStyle = style;
            ctx.lineWidth = r * 2;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x1, y1, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
        painted = true;
        redrawPaintOverlay();
    };
    const attachPaintEvents = () => {
        let last = null;
        const toNatural = (ev) => {
            const rect = paintCanvas.getBoundingClientRect();
            return { x: (ev.clientX - rect.left) / rect.width * origImg.naturalWidth,
                     y: (ev.clientY - rect.top) / rect.height * origImg.naturalHeight };
        };
        paintCanvas.addEventListener("pointerdown", (ev) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            paintCanvas.setPointerCapture(ev.pointerId);
            last = toNatural(ev);
            stroke(last.x, last.y, last.x, last.y, eraserChk.checked);
        });
        paintCanvas.addEventListener("pointermove", (ev) => {
            if (!last) return;
            const p = toNatural(ev);
            stroke(last.x, last.y, p.x, p.y, eraserChk.checked);
            last = p;
        });
        const endPaint = () => { last = null; };
        paintCanvas.addEventListener("pointerup", endPaint);
        paintCanvas.addEventListener("pointercancel", endPaint);
    };

    const setupPaint = async () => {
        teardownPaint();
        await ensureImgLoaded();
        const nw = origImg.naturalWidth, nh = origImg.naturalHeight;
        maskCanvas = document.createElement("canvas");
        maskCanvas.width = nw; maskCanvas.height = nh;
        tintCanvas = document.createElement("canvas");
        tintCanvas.width = nw; tintCanvas.height = nh;
        painted = false;
        paintCanvas = $el("canvas", { className: "neo-gallery-edit-paint-canvas" });
        imgWrap.appendChild(paintCanvas);
        attachPaintEvents();
        window.addEventListener("resize", syncPaintView);
        syncPaintView();
    };
    const teardownPaint = () => {
        if (paintCanvas) paintCanvas.remove();
        paintCanvas = null;
        maskCanvas = tintCanvas = null;
        painted = false;
        window.removeEventListener("resize", syncPaintView);
    };
    clearBtn.addEventListener("click", () => {
        if (!maskCanvas || !tintCanvas) return;
        maskCanvas.getContext("2d").clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        tintCanvas.getContext("2d").clearRect(0, 0, tintCanvas.width, tintCanvas.height);
        painted = false;
        redrawPaintOverlay();
    });

    // ---- 点选删除：透明点击层对齐原图 contain 显示盒，标记点存自然像素坐标 ----
    let removePoints = [];   // [{x, y}] 原图像素坐标
    let removeCanvas = null; // 叠加在原图上的透明点击/标记画布
    let removeMaskImg = null; // 当前 SAM3 遮罩预览图（红色叠加 = 将被删除的区域）
    let removeSegTimer = null; // 点选后防抖：延迟调 SAM3 分割生成遮罩预览
    let removeSegSeq = 0;    // 序列号：丢弃过期的异步分割结果

    // 最后一次点击后延迟 600ms，SAM3 点提示分割并把遮罩红色叠加到原图上（所见即所得）；提示词框已预填默认删除指令，可改
    const scheduleRemoveMask = () => {
        if (removeSegTimer) clearTimeout(removeSegTimer);
        removeSegTimer = setTimeout(async () => {
            removeSegTimer = null;
            if (editMode !== "remove" || !removePoints.length || running) return;
            const seq = ++removeSegSeq;
            removeMaskImg = null;
            redrawRemoveOverlay();
            removeHint.textContent = t("分割中…");
            try {
                const res = await fetch("/neo_image_gen/segment_points", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ image: refName, points: removePoints }),
                });
                const data = await res.json().catch(() => null);
                if (seq !== removeSegSeq || editMode !== "remove") return;   // 分割期间已重新标记/关模式，丢弃过期结果
                if (!res.ok || !data || !data.mask) throw new Error((data && data.error) || t("分割失败"));
                const parts = data.mask.split("/");
                const maskFile = parts.pop();
                const img = new Image();
                img.src = `/neo_gallery/image?filename=${encodeURIComponent(maskFile)}&subfolder=${encodeURIComponent(`input/${parts.join("/")}`)}`;
                await img.decode?.().catch(() => {});
                if (seq !== removeSegSeq || editMode !== "remove") return;
                removeMaskImg = img;
                removeHint.textContent = "";
                redrawRemoveOverlay();
            } catch (e) {
                if (seq === removeSegSeq && editMode === "remove") removeHint.textContent = tf("分割失败：{msg}", { msg: e.message });
            }
        }, 600);
    };

    const syncRemoveView = () => {
        if (!removeCanvas) return;
        const nw = origImg.naturalWidth, nh = origImg.naturalHeight;
        const bw = imgWrap.clientWidth, bh = imgWrap.clientHeight;
        if (!nw || !nh || !bw || !bh) return;
        const k = Math.min(bw / nw, bh / nh);
        removeCanvas.style.left = `${(bw - nw * k) / 2}px`;
        removeCanvas.style.top = `${(bh - nh * k) / 2}px`;
        removeCanvas.width = Math.max(1, Math.round(nw * k));
        removeCanvas.height = Math.max(1, Math.round(nh * k));
        redrawRemoveOverlay();
    };
    const redrawRemoveOverlay = () => {
        if (!removeCanvas) return;
        const ctx = removeCanvas.getContext("2d");
        ctx.clearRect(0, 0, removeCanvas.width, removeCanvas.height);
        // SAM3 遮罩预览：将被删除的区域半透明红填充（所见即所得）；遮罩是灰度图（白=删除区），按亮度取 alpha
        if (removeMaskImg && removeMaskImg.naturalWidth) {
            const tint = document.createElement("canvas");
            tint.width = removeCanvas.width; tint.height = removeCanvas.height;
            const tctx = tint.getContext("2d", { willReadFrequently: true });
            tctx.drawImage(removeMaskImg, 0, 0, tint.width, tint.height);
            const imgData = tctx.getImageData(0, 0, tint.width, tint.height);
            const d = imgData.data;
            for (let i = 0; i < d.length; i += 4) {
                const on = d[i] > 127;
                d[i] = 255; d[i + 1] = 82; d[i + 2] = 82;
                d[i + 3] = on ? 115 : 0;
            }
            tctx.putImageData(imgData, 0, 0);
            ctx.drawImage(tint, 0, 0);
        }
        const nw = origImg.naturalWidth || 1, nh = origImg.naturalHeight || 1;
        const kx = removeCanvas.width / nw, ky = removeCanvas.height / nh;
        removePoints.forEach((p, i) => {
            const x = p.x * kx, y = p.y * ky;
            ctx.beginPath();
            ctx.arc(x, y, 12, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255, 82, 82, 0.35)";
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = "#ff5252";
            ctx.stroke();
            ctx.fillStyle = "#fff";
            ctx.font = "bold 14px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(i + 1), x, y);
        });
    };
    const setupRemoveClicks = async () => {
        teardownRemove();
        await ensureImgLoaded();
        removeCanvas = $el("canvas", { className: "neo-gallery-edit-remove-canvas" });
        imgWrap.appendChild(removeCanvas);
        syncRemoveView();
        window.addEventListener("resize", syncRemoveView);
        removeCanvas.addEventListener("pointerdown", (ev) => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            const rect = removeCanvas.getBoundingClientRect();
            const dx = ev.clientX - rect.left, dy = ev.clientY - rect.top;
            const nw = origImg.naturalWidth || 1, nh = origImg.naturalHeight || 1;
            const kx = removeCanvas.width / nw, ky = removeCanvas.height / nh;
            // 点在已有标记上 → 取消该标记
            for (let i = 0; i < removePoints.length; i++) {
                if (Math.hypot(dx - removePoints[i].x * kx, dy - removePoints[i].y * ky) <= 14) {
                    removePoints.splice(i, 1);
                    redrawRemoveOverlay();
                    scheduleRemoveMask();
                    return;
                }
            }
            if (removePoints.length >= 5) { removeHint.textContent = t("最多标记 5 个点，请先清空部分"); return; }
            removePoints.push({ x: Math.round(dx / kx), y: Math.round(dy / ky) });
            redrawRemoveOverlay();
            scheduleRemoveMask();
        });
    };
    const teardownRemove = () => {
        if (removeCanvas) removeCanvas.remove();
        removeCanvas = null;
        removePoints = [];
        removeMaskImg = null;
        removeSegSeq++;   // 让在途的分割结果作废
        removeHint.textContent = "";
        window.removeEventListener("resize", syncRemoveView);
    };
    removeClearBtn.addEventListener("click", () => {
        removePoints = [];
        removeMaskImg = null;
        removeSegSeq++;
        redrawRemoveOverlay();
    });

    // ---- 参考图区（autogrow：拖入一张追加新空槽，最多 9 张） ----
    let extraRefs = [];   // [{filename, subfolder}]
    const refThumbUrl = (it, size) =>
        `/neo_gallery/thumbnail?filename=${encodeURIComponent(it.filename)}&subfolder=${encodeURIComponent(it.subfolder ? `input/${it.subfolder}` : "input")}&size=${size}`;

    function makeRefSlot(index) {
        const slot = $el("div", { className: "neo-gallery-edit-refdrop" });
        slot.title = t("拖放素材库图片或点击上传");
        const ref = extraRefs[index];
        if (ref) {
            slot.classList.add("has-img");
            slot.appendChild($el("img", { className: "neo-gallery-edit-refchip-img", src: refThumbUrl(ref, 128), alt: ref.filename, title: t("点击放大查看"), onclick: () => Lightbox.open({ items: buildLightboxItems(), index: index + 1 }) }));
            slot.appendChild($el("span", { className: "neo-gallery-edit-refchip-x", textContent: "×", onclick: (e) => { e.stopPropagation(); extraRefs.splice(index, 1); renderRefSlots(); } }));
        } else {
            slot.appendChild($el("span", { className: "neo-gallery-edit-refdrop-icon", textContent: "＋" }));
            slot.appendChild($el("span", { className: "neo-gallery-edit-refdrop-cap", textContent: t("参考") }));
        }
        // 拖放
        slot.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; slot.classList.add("drop-active"); });
        slot.addEventListener("dragleave", (e) => { if (!slot.contains(e.relatedTarget)) slot.classList.remove("drop-active"); });
        slot.addEventListener("drop", async (e) => {
            e.preventDefault();
            slot.classList.remove("drop-active");
            const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
            let fname = null;
            if (files.length) { [fname] = await uploadLocalFiles(files); }
            else { fname = await copyGalleryToInput(grabDataType(e)); }
            if (fname) { extraRefs[index] = { filename: fname, subfolder: "" }; renderRefSlots(); }
        });
        // 点击上传（空槽才触发）
        slot.addEventListener("click", () => { if (!extraRefs[index]) { refFileInput._targetIndex = index; refFileInput.click(); } });
        return slot;
    }

    function renderRefSlots() {
        // 图位整列重建；file input 与取图按钮行是常驻节点，按类名清掉上一批图位
        for (const node of [...refDropContainer.children]) {
            if (node.classList.contains("neo-gallery-edit-refdrop")) node.remove();
        }
        const count = Math.max(1, extraRefs.length + (extraRefs.length < MAX_EXTRA_REFS ? 1 : 0));
        for (let i = 0; i < count; i++) {
            refDropContainer.insertBefore(makeRefSlot(i), refPickRow);
        }
        syncRefCount();
        syncPosePrompt();
    }
    renderRefSlots();

    /** 取用一批参考图（素材库弹窗回调 / 本地多选共用）：画廊素材先复制进 input/ 根目录，落不下的跳过 */
    async function addRefImages(items) {
        for (const it of items || []) {
            if (extraRefs.length >= MAX_EXTRA_REFS) break;
            const fname = it.subfolder ? await copyGalleryToInput(JSON.stringify(it)) : it.filename;
            if (fname) extraRefs.push({ filename: fname, subfolder: "" });
        }
        renderRefSlots();
    }

    refFileInput.onchange = async () => {
        const files = [...(refFileInput.files || [])];
        if (!files.length) return;
        const names = await uploadLocalFiles(files);
        refFileInput.value = "";
        // 点空槽进来的是「补这一格」（空槽下标 = 现有张数），取图按钮进来的是「往后追加」
        const at = refFileInput._targetIndex;
        refFileInput._targetIndex = null;
        for (const fname of names) {
            if (!fname || extraRefs.length >= MAX_EXTRA_REFS) continue;
            if (at != null && at === extraRefs.length) extraRefs[at] = { filename: fname, subfolder: "" };
            else extraRefs.push({ filename: fname, subfolder: "" });
        }
        renderRefSlots();
    };

    // 扩图/局部/点选模式只用首张参考，额外参考不可用（融合模式允许多张）
    const syncRefBtn = () => {
        const disabled = editMode === "outpaint" || editMode === "local" || editMode === "remove";
        refDropContainer.classList.toggle("disabled", disabled);
        if (disabled && extraRefs.length) { extraRefs = []; renderRefSlots(); }
    };

    // 原图区拖放替换：支持素材库拖入和本地文件上传
    // 换原图（拖放落点与卡片菜单「图片编辑」共用一条路）：refName 归零，生成时再把新原图复制进 input/
    const applySource = (filename, sub) => {
        if (editMode !== "normal") setEditMode("normal");
        refName = null;
        source = { filename, subfolder: sub };
        emptyDrop?.remove();
        imgWrap.classList.remove("neo-gallery-edit-empty-stage");
        origImg.style.display = "";
        origImg.src = origUrl();
        setSourceModeBtns(true);
        renderIdle();
        fullUrlReady();   // 默认目标分辨率按新原图 + 全局目标像素数重算
    };
    imgWrap.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; imgWrap.classList.add("drop-active"); });
    imgWrap.addEventListener("dragleave", (e) => { if (!imgWrap.contains(e.relatedTarget)) imgWrap.classList.remove("drop-active"); });
    imgWrap.addEventListener("drop", async (e) => {
        e.preventDefault();
        imgWrap.classList.remove("drop-active");
        const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
        let fname = null;
        if (files.length) { [fname] = await uploadLocalFiles(files); }
        else { fname = await copyGalleryToInput(grabDataType(e)); }
        if (!fname) return;
        applySource(fname, "");
        refName = fname;   // 拖进来的图已落在 input/，省掉生成时那一次复制
    });

    setTimeout(() => promptInput.focus(), 0);
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
function openVoiceDialog(gallery, image, subfolder) {
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

/** 素材卡片「⋯」菜单里的生成入口（角色图 / 九宫格分镜图 / 图片编辑 / 语音克隆），由 gallery-card.js 展开使用。 */
export function buildGenerationMenuItems({ card, gallery, image, subfolder }) {
    return [
        isAudioFile(image.filename) ? $el("div", {
            className: "neo-gallery-collect-item",
            title: t("用这段音频的音色（CosyVoice 零样本克隆）朗读你输入的文字，弹窗内试听结果波形"),
            onclick: () => { card._removeCollectMenu(); openVoiceDialog(gallery, image, subfolder); }
        }, [t("生成语音")]) : null,
        isImageFile(image.filename) ? $el("div", {
            className: "neo-gallery-collect-item",
            title: t("用 Qwen Image 2.1 基于这张人像生成头特写+正/侧/背四视图角色设定图；窗口内可看进度与结果预览，完成后拖入配方的 角色参考图"),
            onclick: () => { card._removeCollectMenu(); openCharacterSheetDialog(gallery, image, subfolder); }
        }, [t("生成角色图（多视图）")]) : null,
        isImageFile(image.filename) ? $el("div", {
            className: "neo-gallery-collect-item",
            title: t("以这张图为参考、按所选宫格技能与故事生成分镜图（每格一镜，可直接进导演编辑器「宫格分镜图拆分」切成视频关键帧）"),
            onclick: () => { card._removeCollectMenu(); openStoryboardDialog(gallery, image, subfolder); }
        }, [t("生成九宫格分镜图")]) : null,
        isImageFile(image.filename) ? $el("div", {
            className: "neo-gallery-collect-item",
            title: t("以这张图为参考进行 AI 编辑（默认 Qwen Image 2.1，可在弹窗内切换其他生图/编辑技能）"),
            onclick: () => { card._removeCollectMenu(); openImageEditDialog(gallery, image, subfolder); }
        }, [t("图片编辑")]) : null,
    ];
}


/** 画廊搜索行「生成素材」：纯提示词一键生成新素材（默认 Krea2 文生图），产物落 Output/NeoAgent/<日期>，素材面板可直接浏览。 */
export function openGenMaterialDialog(gallery, opts = null) {
    const host = opts?.container || _paintHosts?.text;
    if (reusePaintPanel(host, "text")) return;
    const panel = storyPanelRoot(host, "neo-gallery-gm-modal-overlay", "text");
    const overlay = panel.root;

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    const actionsBox = $el("div", { className: "neo-gallery-story-actions" });
    // 一个输入框就是生成用的提示词：写一句直接生成，「增强」（可选）把扩写结果写回同一个框
    const quickInput = $el("textarea", {
        className: "neo-gallery-gm-quick-input",
        rows: 3,
        placeholder: t("描述要生成的素材，例如：红色陶瓷杯的白底产品图……或输入修改指令（↑/↓ 调出历史）")
    });

    // 快捷输入命令终端式历史：↑/↓ 召回之前生成用过的提示词（localStorage 持久化，最新在前，上限 20）
    const gmHistory = createQuickInputHistory(quickInput, { storageKey: "neo.gallery.gen_material.quick_history" });
    // 占位符提示轮播（参考 llm-chat QUICK_INPUT_TIPS）：聚焦且为空时每 5s 换一条
    const GM_QUICK_TIPS = [
        t("描述要生成的素材，例如：红色陶瓷杯的白底产品图"),
        t("✏输入修改指令，例如：去掉动漫风格，改成写实"),
        t("加风格要求，例如：改成赛博朋克风格"),
        t("在 ⋯ 菜单点「增强」，LLM 把描述扩写成详细提示词"),
        t("在 ⋯ 菜单随机填入一条提示词（配方不入池）"),
        t("按 ↑/↓ 召回之前生成用过的提示词")
    ];
    let tipTimer = null;
    const setQuickTip = () => { if (!quickInput.value.trim()) quickInput.placeholder = GM_QUICK_TIPS[Math.floor(Math.random() * GM_QUICK_TIPS.length)]; };
    const stopQuickTips = () => { if (tipTimer) { clearInterval(tipTimer); tipTimer = null; } };
    quickInput.addEventListener("focus", () => { setQuickTip(); stopQuickTips(); tipTimer = setInterval(setQuickTip, 5000); });
    quickInput.addEventListener("blur", () => { stopQuickTips(); setQuickTip(); });

    // ── 输入卡：一个提示词框 + 底部一行（技能 / 宽高比 / 最长边 / 自定参数 … ⋯ 生成）；
    // ⋯ 菜单收 随机填入 / 运行时随机批量 / 预设列表 / 提示词增强 ──
    const GM_RANDOM_KEY = "neo.gallery.gen_material.runtime_random";
    let gmRandom = { enabled: false, count: 1 };
    try {
        const saved = JSON.parse(localStorage.getItem(GM_RANDOM_KEY) || "null");
        if (saved && typeof saved === "object") {
            gmRandom = { enabled: !!saved.enabled, count: Math.max(1, Math.min(parseInt(saved.count, 10) || 1, 16)) };
        }
    } catch {}
    const saveGmRandom = () => { try { localStorage.setItem(GM_RANDOM_KEY, JSON.stringify(gmRandom)); } catch {} };

    const moreBtn = $el("button", { className: "neo-gallery-gm-tool-btn neo-gallery-gm-more-btn", type: "button", textContent: "⋯", title: t("更多：随机填入 / 提示词增强 / 运行时随机批量 / 预设列表") });

    // ⋯ 菜单（复用 Prompt Agent 节点运行时菜单样式；运行时随机状态 localStorage 持久化）
    const moreMenu = $el("div", { className: "rs-runtime-menu neo-gallery-gm-more-menu" });
    const randomItem = $el("button", { className: "neo-gallery-gm-menu-item", type: "button", textContent: t("随机填入一条提示词") });
    const presetItem = $el("button", { className: "neo-gallery-gm-menu-item", type: "button", textContent: t("预设列表") });
    const runtimeCheck = $el("input", { type: "checkbox" });

    runtimeCheck.checked = gmRandom.enabled;
    const countValEl = $el("span", { className: "rs-runtime-count-val", textContent: String(gmRandom.count) });
    const mkCountBtn = (delta) => {
        const b = $el("button", { className: "rs-runtime-count-btn", type: "button" });
        b.textContent = delta > 0 ? "+" : "−";
        b.addEventListener("click", () => {
            gmRandom.count = Math.max(1, Math.min(gmRandom.count + delta, 16));
            countValEl.textContent = String(gmRandom.count);
            saveGmRandom();
        });
        return b;
    };
    moreMenu.append(
        randomItem,
        $el("label", { className: "rs-runtime-row rs-runtime-toggle" }, [
            runtimeCheck,
            $el("span", { className: "rs-runtime-row-text", textContent: t("运行时随机抽取提示词") })
        ]),
        $el("div", { className: "rs-runtime-row" }, [
            mkCountBtn(-1), countValEl, mkCountBtn(1),
            $el("span", { className: "rs-runtime-row-text", textContent: t("张（批量生成）") })
        ]),
        presetItem
    );
    const syncRandomState = () => {
        moreBtn.classList.toggle("neo-gallery-gm-tool-on", gmRandom.enabled);
    };

    runtimeCheck.addEventListener("change", () => {
        gmRandom.enabled = runtimeCheck.checked;
        saveGmRandom();
        syncRandomState();
    });
    syncRandomState();

    // 预设列表浮层（复用预设列表样式；配方不入池，点击填入提示词框）
    const presetOverlay = $el("div", { className: "rs-preset-list-overlay" });
    const presetHeader = $el("div", { className: "rs-preset-header" }, [
        $el("input", { className: "rs-preset-search-input", type: "text", placeholder: t("搜索预设…") }),
        $el("button", { className: "rs-preset-close", type: "button", textContent: "×" })
    ]);
    const presetSearch = presetHeader.querySelector("input");
    presetHeader.querySelector("button").addEventListener("click", () => { presetOverlay.style.display = "none"; quickInput.focus(); });
    const presetBody = $el("div", { className: "rs-preset-list-body" });
    presetOverlay.append(presetHeader, presetBody);

    let presetItems = null; // 本次弹窗会话缓存
    const renderPresetList = (query) => {
        presetBody.textContent = "";
        const q = (query || "").trim().toLowerCase();
        const items = (presetItems || []).filter(it => !q || it.name.toLowerCase().includes(q));
        if (!items.length) {
            presetBody.appendChild($el("div", { className: "neo-gallery-story-hint", textContent: q ? t("无匹配预设") : t("暂无预设") }));
            return;
        }
        items.forEach(it => {
            const row = $el("div", { className: "rs-preset-item" }, [
                $el("span", { className: "rs-preset-content", textContent: it.name }),
                $el("span", { className: "rs-source-badge", textContent: it.source === "presets" ? t("预设") : t("自定义") })
            ]);
            row.addEventListener("click", async () => {
                try {
                    const data = await loadPrompt(it.name);
                    quickInput.value = data.text || "";
                    presetOverlay.style.display = "none";
                    quickInput.focus();
                } catch (e) {
                    console.error("[Gallery] load preset failed:", e);
                    actionToast({ severity: "error", summary: t("加载预设失败"), detail: String(e?.message || e) });
                }
            });
            presetBody.appendChild(row);
        });
    };
    const openPresetList = async () => {
        presetOverlay.style.display = "flex";
        presetSearch.value = "";
        if (!presetItems) {
            presetBody.textContent = t("加载中…");
            try { presetItems = await listPrompts(); } catch (e) { console.error("[Gallery] list prompts failed:", e); presetItems = []; }
        }
        renderPresetList("");
        presetSearch.focus();
    };
    presetSearch.addEventListener("input", () => renderPresetList(presetSearch.value));


    let running = false;
    let cancelId = null;
    let cancelRequested = false;
    let deleting = false;
    let randomPicking = false;

    const close = () => overlay.remove();
    const fill = (box, ...children) => { box.textContent = ""; box.append(...children.filter(Boolean)); };
    const btn = (label, onclick, primary = false) =>
        $el("button", { className: "neo-gallery-story-btn" + (primary ? " neo-gallery-story-btn-primary" : ""), textContent: label, onclick });

    // 技能下拉：只列吃文字的生图技能（纯文生图 + Qwen 2.1 这类两栖类）；必须带参考图的编辑类
    // 在本页没有图可给，列出来只会出废图。记住上次选中的技能（localStorage），失效时回 Krea2 文生图
    const skillSel = $el("select", { className: "neo-recipes-sort neo-gallery-gm-chip-select neo-gallery-gm-skill-sel", title: t("技能与自定参数：只列吃文字输入的生图技能；主模型 / LoRA 留空 = 跟随该技能配置与全局生图设置") });
    // 自定参数（本次临时选主模型 / LoRA，类似节点上接模型，空值 = 跟随全局生图设置）：
    // 与技能同一枚 chip，点开从上方浮出双栏面板；Text Encoder / VAE 很少变，弹窗里不露出（共享组件保留行，这里裁掉）
    const modelCfg = createModelConfigSection();
    for (const row of modelCfg.el.querySelectorAll(".rs-gen-adv-row")) row.remove();
    const modelBox = $el("div", { className: "neo-gallery-gm-model-box" });
    modelBox.appendChild(modelCfg.el);
    const skillChip = skillParamsChip(skillSel, modelBox, {
        icon: "sparkles",
        getOverride: () => modelCfg.collect(),
    });
    // 换主模型 / 加 LoRA 后 chip 标签跟上（技能名 + 覆盖态）
    const syncParamsChip = () => skillChip.sync();
    modelBox.addEventListener("change", syncParamsChip);
    guardMainModelFamily(modelCfg, skillSel);
    let rememberedSkill = "";

    try { rememberedSkill = localStorage.getItem(GM_LAST_SKILL_KEY) || ""; } catch {}
    // 拉技能列表重建下拉（打开时与保存新技能后调用）；preferId 优先选中（刚保存的新技能）
    const fillSkillOptions = async (preferId) => {
        try {
            const res = await fetch("/rs_prompts/skills");
            const skills = await res.json();
            const genSkills = (Array.isArray(skills) ? skills : []).filter(s => s.gen_image && skillAcceptsText(s));
            skillSel.textContent = "";
            genSkills.forEach(s => {
                const opt = $el("option", { value: s.id, textContent: skillDisplayName(s) });
                opt.__skillMeta = s;   // 家族与主模型副标题取这份元数据（populateSkillOptions 同一约定）
                skillSel.appendChild(opt);
            });
            const ids = genSkills.map(s => s.id);
            if (preferId && ids.includes(preferId)) skillSel.value = preferId;
            else if (rememberedSkill && ids.includes(rememberedSkill)) skillSel.value = rememberedSkill;
            else skillSel.value = ids.includes(KREA2_T2I_SKILL_ID) ? KREA2_T2I_SKILL_ID : (ids[0] || "");
        } catch {
            skillSel.value = KREA2_T2I_SKILL_ID;
        }
        skillChip.sync();   // 下拉整份重建过：chip 标签跟着新选中项
        applySkillModelConfig(skillSel.value); // 自定参数同步为该技能配置（模型列表未就绪时为空操作）
    };
    fillSkillOptions();
    // 选中变化即写入 localStorage：下次打开沿用该技能（关窗不清除）；自定参数同步切到新技能
    skillSel.addEventListener("change", () => {
        try { localStorage.setItem(GM_LAST_SKILL_KEY, skillSel.value); } catch {}
        applySkillModelConfig(skillSel.value);
    });

    // 增强 skill 下拉：与节点同源 populateSkillOptions（按分类分组），只列图像提示词增强技能
    // （category=image_enhance）；「默认」空值 = 后端 smart_prompt 自动路由；记住上次选择
    const enhanceSel = $el("select", { className: "neo-recipes-sort neo-gallery-gm-enhance-skill", title: t("增强方式：用哪个图像增强技能扩写描述（默认 = 后端自动路由）") });

    let rememberedEnhanceSkill = "";
    try { rememberedEnhanceSkill = localStorage.getItem(GM_ENHANCE_SKILL_KEY) || ""; } catch {}
    (async () => {
        try {
            const skills = await listSkills();
            enhanceSel.textContent = "";
            enhanceSel.appendChild($el("option", { value: "", textContent: t("默认") }));
            populateSkillOptions(enhanceSel, skills.filter(s => s.category === "image_enhance"));
            const ids = Array.from(enhanceSel.options).map(o => o.value);
            if (rememberedEnhanceSkill && ids.includes(rememberedEnhanceSkill)) enhanceSel.value = rememberedEnhanceSkill;
        } catch { /* 拉取失败保持「默认」 */ }
    })();
    enhanceSel.addEventListener("change", () => {
        try { localStorage.setItem(GM_ENHANCE_SKILL_KEY, enhanceSel.value); } catch {}
    });

    // 宽高比 / 最长边：本次临时覆盖（空值 = 跟随技能配置 / 全局设置），同行紧凑布局
    // 宽高比选项与导演编辑页同源（DIRECTOR_ASPECTS）：值保持纯比例，显示带中文备注
    const GM_RATIO_OPTIONS = DIRECTOR_ASPECTS.map(([label]) => [label.split(" ")[0], t(label)]);
    const GM_RATIOS = GM_RATIO_OPTIONS.map(([v]) => v);
    // 「默认」选项跟随值用无括号备注：16:9 (宽屏) → 16:9 宽屏，避免嵌套括号
    const GM_RATIO_AUTO_TEXT = Object.fromEntries(DIRECTOR_ASPECTS.map(([label]) => {
        const [v, note] = t(label).split(" ");
        return [v, `${v} ${note.replace(/[()]/g, "")}`];
    }));
    const GM_EDGES = ["1024", "1152", "1280", "1536", "1792", "2048", "2560", "3072"];
    const makeGmSelect = (options) => {
        const select = document.createElement("select");
        select.className = "neo-gallery-gm-chip-select";

        const auto = document.createElement("option");
        auto.value = "";
        auto.textContent = t("默认");   // 跟随值由 setGmAutoLabel 写进这一项与 chip
        select.appendChild(auto);
        for (const opt of options) {
            const [value, text] = Array.isArray(opt) ? opt : [opt, opt];
            const el = document.createElement("option");
            el.value = value;
            el.textContent = text;
            select.appendChild(el);
        }
        return select;
    };
    // 跟随值 = 当前技能配置的生效值（切技能时更新）：菜单里写出值，chip 标签与比例 glyph 直接用这份
    const setGmAutoLabel = (sel, v) => {
        sel.dataset.follow = v || "";
        sel.options[0].textContent = v ? tf("默认 ({v})", { v }) : t("默认");
    };
    const sizeRow = $el("div", { className: "neo-gallery-gm-size-row neo-gallery-gm-chip-group" });
    const ratioSel = makeGmSelect(GM_RATIO_OPTIONS);
    ratioSel.title = t("宽高比：本次临时覆盖出图比例，默认 = 跟随技能配置与全局生图设置");
    const edgeSel = makeGmSelect(GM_EDGES);
    edgeSel.title = t("最长边：本次临时覆盖出图最长边像素，默认 = 跟随技能配置与全局生图设置");
    const ratioChip = chipButton(ratioSel, { glyph: ratioGlyph() });
    const edgeChip = chipButton(edgeSel, { icon: "maximize" });
    sizeRow.append(ratioChip.el, edgeChip.el);

    // 保存为新技能：把当前选的「主模型 + LoRA + 宽高比 + 最长边」存成新技能（名称自动生成 = 主模型名+LoRA 名，其余设置沿用当前技能）
    const saveSkillBtn = $el("button", {
        className: "neo-gallery-gm-save-skill",
        type: "button",
        textContent: t("保存为新技能"),
        style: { display: "none" },
    });
    modelBox.appendChild(saveSkillBtn);
    // 选中了主模型或 LoRA 才显示（委托：覆盖区内任意下拉 / 强度输入变化）
    const refreshSaveSkillBtn = () => {
        const ov = modelCfg.collect();
        saveSkillBtn.style.display = (ov.model || ov.loras.length) ? "" : "none";
    };
    modelBox.addEventListener("change", refreshSaveSkillBtn);
    let savingSkill = false;
    saveSkillBtn.addEventListener("click", async () => {
        if (savingSkill) return;
        const ov = modelCfg.collect();
        if (!ov.model && !ov.loras.length) return;
        savingSkill = true;
        saveSkillBtn.textContent = t("保存中…");
        try {
            const res = await fetch("/neo_image_gen/save_combo_skill", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ skill_id: skillSel.value || KREA2_T2I_SKILL_ID, model: ov.model, loras: ov.loras, ratio: ratioSel.value, edge: edgeSel.value }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            // 新技能已进列表 → 直接选中并记住（下次打开沿用该组合）
            await fillSkillOptions(data.id);
            try { localStorage.setItem(GM_LAST_SKILL_KEY, data.id); } catch {}
            actionToast({ severity: "success", summary: tf("已保存为新技能「{name}」", { name: data.name }) });
        } catch (e) {
            console.error("[Gallery] save combo skill failed:", e);
            actionToast({ severity: "error", summary: t("保存为新技能失败"), detail: String(e?.message || e) });
        } finally {
            savingSkill = false;
            saveSkillBtn.textContent = t("保存为新技能");
            refreshSaveSkillBtn();
        }
    });
    // 每次打开都默认「自动」（跟随全局设置），不预填已配置值——否则关窗重开像上次选择没清除；
    // 模型列表拉取失败时覆盖区保持空下拉（等效跟随设置），不挡生成
    let genModels = null; // 打开时拉取的模型列表，切换技能重放配置时复用
    // 切换生成技能后把自定参数同步为该技能配置的主模型 / LoRA / 比例 / 最长边（无配置 = 自动跟随全局设置）
    async function applySkillModelConfig(skillId) {
        if (!genModels) return; // 模型列表未就绪：首次加载 / 技能列表回调稍后会应用
        const cfg = await getSkillGenConfig(skillId);
        modelCfg.load(cfg, genModels);
        ratioSel.value = GM_RATIOS.includes(cfg.default_ratio) ? cfg.default_ratio : "";
        edgeSel.value = GM_EDGES.includes(String(cfg.base_resolution)) ? String(cfg.base_resolution) : "";
        setGmAutoLabel(ratioSel, cfg.default_ratio ? (GM_RATIO_AUTO_TEXT[cfg.default_ratio] || cfg.default_ratio) : "");
        setGmAutoLabel(edgeSel, cfg.base_resolution);
        ratioChip.sync();   // 程序改 value 不触发 change：chip 标签与 glyph 自己跟上
        edgeChip.sync();
        syncParamsChip();
    }
    (async () => {
        try {
            genModels = await listGenModels();
            modelCfg.load({}, genModels); // 先按「自动」渲染，避免下拉为空
            applySkillModelConfig(skillSel.value); // 再覆盖为当前技能配置
        } catch {
            // 同上：静默保持「自动」
        }
    })();
    // 增强：可选步骤，整条收进 ⋯ 菜单，默认视野只剩输入框 = 写一句直接生成。
    // 复用节点 agent 逻辑（所选增强 skill 的 skill.md 作系统提示词 + 按需读引用文件）直调
    // /rs_prompts/stream_generate_prompt，扩写结果流式写回同一个输入框；原句先进历史，↑ 可召回
    const enhanceBtn = $el("button", { className: "neo-gallery-story-btn", textContent: t("增强") });
    const enhanceGroup = $el("div", { className: "neo-gallery-gm-enhance-group" }, [
        $el("div", { className: "neo-director-field-label", textContent: t("提示词增强（可选）") }),
        $el("div", { className: "rs-runtime-row" }, [enhanceSel, enhanceBtn]),
    ]);
    moreMenu.insertBefore(enhanceGroup, presetItem);
    let enhancing = false;
    enhanceBtn.addEventListener("click", async () => {
        if (enhancing || running) return;
        const text = quickInput.value.trim();
        if (!text) { closeMoreMenu(); quickInput.focus(); return; }
        gmHistory.record(text);
        const original = quickInput.value;
        enhancing = true;
        closeMoreMenu();
        enhanceBtn.textContent = t("增强中…");

        try {
            await invokePromptStream({ text, skillId: enhanceSel.value }, createStreamOutputHandlers({
                textarea: quickInput,
                onDone: (acc) => {
                    if (!acc.trim()) {
                        quickInput.value = original;
                        actionToast({ severity: "warning", summary: t("增强失败"), detail: t("LLM 未返回内容") });
                    }
                    quickInput.focus();
                },
                onError: (e) => {
                    quickInput.value = original;
                    console.error("[Gallery] gen material enhance failed:", e);
                    actionToast({ severity: "error", summary: t("提示词增强失败"), detail: String(e?.message || e), actionLabel: t("打开 LLM 设置"), onAction: openLLMSettingsModal });
                }
            }));
        } finally {
            enhancing = false;
            enhanceBtn.textContent = t("增强");
        }
    });

    const renderIdle = () => {
        // 页内 idle 不在中间铺一整块空画布：那块没有内容的框把输入区顶到屏幕正中，
        // 用户先看到的是框不是控件。弹窗空间小，仍走一句短 hint
        fill(statusBox, panel.embedded
            ? $el("div", { className: "neo-gallery-gm-idle" }, [
                $el("div", { className: "neo-gallery-gm-idle-title", textContent: t("写一句提示词，点生成") }),
                $el("div", { className: "neo-gallery-gm-idle-sub", textContent: t("结果图出现在输入卡上方，产物保存到 Output 目录（NeoAgent/<日期>）") }),
            ])
            : $el("div", { className: "neo-gallery-story-hint", textContent: t("填写素材描述后点「生成」，图片保存到 Output 目录（NeoAgent/<日期>），可在素材面板浏览。") }));
        fill(actionsBox, panel.embedded ? null : btn(t("取消"), close));
    };


    // 预览区：生成中显示占位（spinner + 进度条），成功后结果图原位替换它（同一容器复用，布局不跳）
    const previewBox = $el("div", { className: "neo-gallery-gm-preview" });

    const renderRunning = (label, progress, preview) => {
        previewBox.className = "neo-gallery-gm-preview";
        const hasSteps = !!(progress && progress.max > 0);
        const fillEl = $el("div", { className: "neo-gallery-cs-progress-fill" });
        if (hasSteps) {
            fillEl.style.width = `${Math.max(0, Math.min(100, (progress.value / progress.max) * 100))}%`;
        } else {
            fillEl.classList.add("neo-gallery-cs-progress-indeterminate");
        }
        // 采样中拿到实时预览图（与节点预览同源）时替换 spinner，否则显示占位
        const runningRow = preview
            ? $el("img", { className: "neo-gallery-gm-preview-img", src: preview, alt: label })
            : $el("div", { className: "neo-gallery-cs-running" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: label })
            ]);
        fill(previewBox,
            runningRow,
            $el("div", { className: "neo-gallery-cs-progress" }, [fillEl]));
        fill(statusBox, previewBox);
        fill(actionsBox, btn(t("取消任务"), () => { cancelRequested = true; if (cancelId) cancelTask(cancelId); }));
    };


    // 成功后：结果图已在位（单张=1 图 / 批量=网格图），这里只补提示 + 操作按钮
    const renderGenDone = (images, hint) => {
        const oldHint = statusBox.querySelector(".neo-gallery-story-hint");
        if (oldHint) oldHint.remove();
        statusBox.appendChild($el("div", { className: "neo-gallery-story-hint", textContent: hint }));
        // 打开输出目录：跳到 Output 下实际落盘的日期子目录（窗口保留，可继续再生成/删除）
        const openOutputDir = () => {
            const sub = images.map(i => i.subfolder).find(Boolean);
            openGallerySidebar("Output", sub ? sub.split("/").filter(Boolean) : []);
        };
        // 删除：结果不满意 → 直接删掉落盘文件（含 .txt 与缩略图缓存），删完回 idle 原地再生成
        const deleteResult = async () => {
            if (!images.length || deleting) return;
            deleting = true;
            try {
                for (const im of images) {
                    const ok = await gallery.deleteItem(im.filename, im.subfolder || "", { silent: true });
                    if (!ok) { actionToast({ severity: "error", summary: t("删除失败"), detail: tf("无法删除 {name}", { name: im.filename }) }); break; }
                }
                renderIdle();
            } catch (e) {
                console.error("[Gallery] gen material delete failed:", e);
                actionToast({ severity: "error", summary: t("删除失败"), detail: String(e?.message || e) });
            } finally {
                deleting = false;
            }
        };
        fill(actionsBox, btn(t("打开输出目录"), openOutputDir), btn(t("删除"), deleteResult), panel.embedded ? null : btn(t("关闭"), close, true));
    };

    const renderSuccess = (final) => {
        const images = final.images || [];
        // 结果图原位替换预览区：复用同一容器，只换类名与内容
        previewBox.className = "neo-gallery-cs-result";
        fill(previewBox);
        if (images.length > 0) {
            const img = $el("img", {
                className: "neo-gallery-cs-result-img",
                src: `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&size=640`,
                alt: images[0].filename
            });
            img.addEventListener("click", () => Lightbox.open({ items: images.map(im => ({ kind: "image", url: im.url, title: im.filename })), index: 0 }));
            previewBox.appendChild(img);
        }
        renderGenDone(images, t("已生成，图片保存在 Output 目录（NeoAgent/<日期>），可在素材面板浏览。"));
    };

    // 提交一次生图任务并等终态；render(snap) 随快照推送刷新 UI（单张=整个预览区 / 批量=当前行原位更新）
    const runOnePrompt = async (promptText, render) => {
        // 自定参数只带非空值：空串 / 空数组会覆盖掉全局设置里的显式配置
        const payload = {
            skill_id: skillSel.value || KREA2_T2I_SKILL_ID,
            prompt: promptText,
            skip_enhance: true,
        };
        const ov = modelCfg.collect();
        if (ov.model) payload.model = ov.model;
        if (ov.loras.length) payload.loras = ov.loras;
        if (ratioSel.value) payload.default_ratio = ratioSel.value;
        if (edgeSel.value) payload.base_resolution = parseInt(edgeSel.value, 10);
        const snap = await requestGeneration(payload);
        cancelId = snap.task_id;
        return await watchTask(snap.task_id, render, () => cancelRequested);
    };

    // 运行时随机批量：逐张生成，成功即把结果图追加进网格；取消时保留已生成的
    const runBatch = async (prompts) => {
        const total = prompts.length;
        const results = [];
        fill(statusBox, previewBox); // 结果区挂到上方区域（与单张模式复用同一容器）
        previewBox.className = "neo-gallery-cs-result";
        fill(previewBox);
        for (let i = 0; i < total; i++) {
            if (cancelRequested) break;
            const runningRow = $el("div", { className: "neo-gallery-gm-batch-item" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: tf("生成 {i}/{total}（排队中…）", { i: i + 1, total }) })
            ]);
            previewBox.appendChild(runningRow);
            fill(actionsBox, btn(t("取消任务"), () => { cancelRequested = true; if (cancelId) cancelTask(cancelId); }));
            let final;
            try {
                final = await runOnePrompt(prompts[i], s => {
                    runningRow.lastChild.textContent = tf("生成 {i}/{total}（{state}…）", { i: i + 1, total, state: s.status === "running" ? t("生图中") : t("排队中") });
                });
            } catch (e) {
                runningRow.remove();
                throw e;
            }
            runningRow.remove();
            if (final.status === "succeeded") {
                results.push(final);
                const images = final.images || [];
                if (images.length > 0) {
                    const img = $el("img", {
                        className: "neo-gallery-cs-result-img",
                        src: `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&size=640`,
                        alt: images[0].filename
                    });
                    img.addEventListener("click", () => Lightbox.open({ items: results.flatMap(f => (f.images || []).map(im => ({ kind: "image", url: im.url, title: im.filename }))), index: 0 }));
                    previewBox.appendChild(img);
                }
            } else if (final.status === "cancelled") {
                break;
            } else {
                // 中途失败：保留已生成的图，错误显示在其下方
                const oldHint = statusBox.querySelector(".neo-gallery-story-hint");
                if (oldHint) oldHint.remove();
                statusBox.appendChild($el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: tf("第 {i}/{total} 张生成失败：{err}", { i: i + 1, total, err: final.error || t("未知错误") }) }));
                fill(actionsBox, panel.embedded ? null : btn(t("关闭"), close, true));
                return;
            }
        }
        if (!results.length) { renderError(t("已取消")); return; }
        renderGenDone(results.flatMap(f => f.images || []), tf("已生成 {done}/{total} 张，图片保存在 Output 目录（NeoAgent/<日期>），可在素材面板浏览。", { done: results.length, total }));
    };

    const renderError = (message) => {
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: message || t("生成失败") }));
        fill(actionsBox, btn(t("重试"), start), panel.embedded ? null : btn(t("关闭"), close));
    };

    // 生图失败：窗内留错误 + 重试，另弹 action toast 引导去技能详情修模型（缺模型/节点等非 LLM 问题）
    const failGen = (message) => {
        renderError(message);
        actionToast({ severity: "error", summary: t("素材生成失败"), detail: message, actionLabel: t("打开技能详情"), onAction: () => openSkillDetailById(skillSel.value || KREA2_T2I_SKILL_ID) });
    };

    // 随机填入（与批量同池抽一条，配方不入池）
    randomItem.addEventListener("click", async () => {
        if (randomPicking || running) return;
        randomPicking = true;
        randomItem.disabled = true;
        try {
            const data = await randomPrompts(1);
            const text = (data.texts || [])[0] || "";
            if (text.trim()) {
                quickInput.value = text;
                quickInput.focus();
                closeMoreMenu();
            } else {
                actionToast({ severity: "error", summary: t("随机提示词失败"), detail: t("提示词库为空") });
            }
        } catch (e) {
            console.error("[Gallery] random prompt failed:", e);
            actionToast({ severity: "error", summary: t("随机提示词失败"), detail: String(e?.message || e) });
        } finally {
            randomPicking = false;
            randomItem.disabled = false;
        }
    });

    // ⋯ 菜单（挂在弹窗 overlay 上，随窗移除）：output 框在面板下沿，默认朝按钮上方展开
    let moreMenuOpen = false;
    const closeMoreMenu = () => { moreMenuOpen = false; moreMenu.style.display = "none"; };
    moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (moreMenuOpen) { closeMoreMenu(); return; }
        moreMenu.style.display = "block";
        moreMenuOpen = true;
        const r = moreBtn.getBoundingClientRect();
        moreMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - moreMenu.offsetWidth - 8))}px`;
        const above = r.top - moreMenu.offsetHeight - 6;
        moreMenu.style.top = `${above > 8 ? above : r.bottom + 6}px`;
    });
    const onDocClick = (e) => {
        if (moreMenuOpen && !moreMenu.contains(e.target)) closeMoreMenu();
        for (const chip of composerChips) chip.closeOnOutside(e.target);
    };
    document.addEventListener("click", onDocClick);

    // 预设列表（无配方条目，点击填入提示词框）
    presetItem.addEventListener("click", () => {
        closeMoreMenu();
        openPresetList();
    });



    const start = async () => {
        if (running) return;
        let prompts;
        if (gmRandom.enabled) {
            // 运行时随机：从节点同池抽 N 条不重复提示词，逐张批量生成（配方不入池）
            const n = Math.max(1, Math.min(gmRandom.count || 1, 16));
            renderRunning(tf("抽取 {n} 条随机提示词…", { n }));
            let res;
            try {
                res = await randomPrompts(n);
            } catch (e) {
                console.error("[Gallery] random prompts failed:", e);
                failGen(String(e?.message || e));
                return;
            }
            prompts = (res.texts || []).filter(t => t && t.trim());
            if (!prompts.length) { failGen(t("提示词库为空，抽不到随机提示词")); return; }
        } else {
            // 一个框就是最终提示词，固定 skip_enhance（增强是 ⋯ 里的显式动作）
            const prompt = quickInput.value.trim();
            if (!prompt) { quickInput.focus(); return; }
            prompts = [prompt];
        }
        const batch = prompts.length > 1;
        if (!batch) gmHistory.record(prompts[0]);
        running = true;
        cancelRequested = false;
        try {
            if (!batch) {
                renderRunning(t("排队中…"));
                const final = await runOnePrompt(prompts[0], s => renderRunning(s.status === "running" ? t("生图中…") : t("排队中…"), s.progress, s.preview));
                if (final.status === "succeeded") renderSuccess(final);
                else if (final.status === "cancelled") renderError(t("已取消"));
                else failGen(final.error || t("生成失败"));
            } else {
                await runBatch(prompts);
            }
        } catch (e) {
            console.error('[Gallery] gen material failed:', e);
            failGen(String(e?.message || e));
        } finally {
            running = false;
            cancelId = null;
        }
    };

    const onKey = (e) => {
        if (e.key === "Escape") {
            // 有浮层先关浮层，无浮层才关窗
            if (composerChips.some(c => c.isOpen())) { for (const c of composerChips) c.close(); }
            else if (moreMenuOpen) closeMoreMenu();

            else if (presetOverlay.style.display === "flex") presetOverlay.style.display = "none";
            else if (!panel.embedded) close();   // 内嵌面板由绘画页自己管生命周期，Esc 不销毁
        }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) start();
    };

    // 输入卡：一个提示词框 + 底行（技能与自定参数 / 宽高比 / 最长边 … ⋯ 生成）；
    // 结果区在上（预览/成品原位替换），生成后在卡下补操作按钮
    const genBtn = btn(t("生成"), start, true);
    genBtn.classList.add("neo-gallery-gm-gen-btn");
    const composerChips = [skillChip, ratioChip, edgeChip];
    const composer = $el("div", { className: "neo-gallery-gm-composer" }, [
        quickInput,
        $el("div", { className: "neo-gallery-gm-composer-bar neo-gallery-gm-chips" }, [
            skillChip.el,
            sizeRow,
            $el("div", { className: "neo-gallery-gm-composer-gap" }),
            moreBtn,
            genBtn,
        ]),
    ]);

    const modal = $el("div", { className: "neo-gallery-story-modal" + (panel.embedded ? " neo-gallery-story-modal--embedded" : "") }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: t("生成素材") }),
            $el("span", { className: "neo-gallery-story-close", textContent: "\u00D7", onclick: close })
        ]),
        statusBox,
        composer,
        actionsBox
    ]);
    overlay.appendChild(modal);
    // 浮层挂在 overlay 上（z-index 高于弹窗，随窗移除）
    overlay.append(moreMenu, presetOverlay);


    if (!panel.embedded) {
        // 标题栏拖动 + 双击最大化/还原（同导演编辑器模式）
        makeStoryWindowDraggable(modal);
    }

    renderIdle();
    document.addEventListener("keydown", onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => { stopQuickTips(); document.removeEventListener("keydown", onKey); document.removeEventListener("click", onDocClick); origRemove(); };
    if (panel.embedded) {
        panel.host.appendChild(overlay);
        panel.host.__neoPanelClose = () => { close(); panel.host.__neoPanelRoot = null; };
    } else {
        document.body.appendChild(overlay);
    }

    setTimeout(() => quickInput.focus(), 0);
}