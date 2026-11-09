/**
 * image-edit-panel.js
 * 图片编辑面板：以一张原图为参考，用所选生图/编辑技能 + 编辑指令出图——扩图、涂抹区局部重绘、
 * 点选删除、多图融合、姿势锁形、机位改写，带参考图槽、窗帘对比与画布拖框。
 * 弹窗与内嵌双宿主：Studio 注册过宿主就铺进编辑页容器，没有宿主照旧弹浮层窗（入口与类名不变）。
 * 入口是素材卡「⋯」的「图片编辑」、首页「编辑」板块、Studio 编辑页，以及带原图的「再来一发」。
 * 从 gallery-gen.js 拆出，面板底座在 gen-utils.js。
 */

import { $el } from "../../../../scripts/ui.js";
import { isPickableImage } from "./gallery-utils.js";
import { actionToast } from "./toast.js";
import { openSkillDetailById, populateSkillOptions, skillDisplayName, skillAcceptsRef } from "./skill.js";
import { Lightbox } from "./lightbox.js";
import { requestGeneration, watchTask, cancelTask, createModelConfigSection, listGenModels, getSkillGenConfig, getGenSettings } from "./image-gen.js";
import { toggleGallerySidebar, grabDataType, copyGalleryToInput, uploadLocalFiles } from "./media-transfer.js";
import { t, tf } from "./js/core/i18n.js";
import { icon, setIcon } from "./js/core/icons.js";
import { createAngleOrb, anglePrompt, rotationLabel, rotationToDisplay, displayToRotation, tiltLabel, zoomLabel, snapToNearest, ROTATION_VALUES, TILT_VALUES, ZOOM_VALUES } from "./angle/angle-orb.js";
import {
    QWEN_IMAGE_SKILL_ID, makeStoryWindowDraggable, copyImageToInput, _paintHosts,
    storyPanelRoot, chipButton, skillParamsChip, guardMainModelFamily, reuseModelOverlay,
    reusePaintPanel, notifyPrefillFilled,
} from "./gen-utils.js";

// 扩图专用技能：LoRA 固定在其 config.json（缺失时后端提示并跳过）
const QWEN_OUTPAINT_SKILL_ID = "qwen_image_21_outpaint";
// 高分局部编辑技能：涂抹区域自动裁剪-高分重绘-羽化合并（无额外 LoRA）
const QWEN_LOCAL_EDIT_SKILL_ID = "qwen_image_21_local_edit";
// 姿势锁形技能（ControlNet）：第 1 张额外参考位放控制图，锁住它的姿势与构图重出原图
const QWEN_CONTROLNET_SKILL_ID = "qwen_image_21_controlnet";
const POSE_MAX_REFS = 1;   // 姿势锁形一发只吃这一张控制图：这个模式下参考图区只给一格
// 机位技能：按「转角 / 俯仰 / 镜头」三档改写相机机位重出这一张（档位与短语在 angle/angle-orb.js）
const QWEN_CAMERA_ANGLE_SKILL_ID = "qwen_image_21_camera_angle";

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
// 扩图画布边长上限（×原图显示尺寸）：拖框换算随缩放指数增长，封顶防失控与后端显存爆炸
const OUTPAINT_MAX_EXTEND = 4;

/** 图片编辑弹窗：以卡片原图为参考，用所选生图/编辑技能 + 用户输入的编辑指令生成新图。
 * 默认 Qwen Image 2.1，可在下拉中切换其他 image_gen 类技能。 */

export function openImageEditDialog(gallery, image = null, subfolder = "", opts = null) {
    const host = opts?.container || _paintHosts?.edit;
    if (reusePaintPanel(host, "edit", image, subfolder, opts?.prefill)) return;
    const panel = storyPanelRoot(host, "neo-gallery-edit-modal-overlay", "edit");
    const overlay = panel.root;
    // 原图可以后补：绘画页进页铺的就是空面板，点预览区那枚「原图」方块或把素材拖进来即成原图
    let source = image ? { filename: image.filename || image.name, subfolder: subfolder || "" } : null;
    const pathLabel = () => (source.subfolder ? `${source.subfolder}/` : "") + source.filename;
    // 空 subfolder 在这一头就是 input/ 根目录（本地上传与素材库取用都落在那儿）：不带 input/ 前缀的话，
    // /neo_gallery/image 把空 subfolder 当 presets/ 解，原图与尺寸探针一起 404 成破图（参考位同一套寻址，一直带前缀）
    const origUrl = () => `/neo_gallery/image?filename=${encodeURIComponent(source.filename)}&subfolder=${encodeURIComponent(source.subfolder || "input")}`;

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    const actionsBox = $el("div", { className: "neo-gallery-story-actions" });
    const promptInput = $el("textarea", {
        className: "neo-gallery-story-input neo-gallery-gm-quick-input",
        rows: 4,
        placeholder: t("描述你想对这张图做的修改，例如：把背景换成海边日落、给角色加一顶帽子……")
    });
    // 提示词框里「代码写进去的那句」记在 autoPrompt（模式切换、技能切换写进去的都算）。
    // 切模式时只有「空框 / 就是这句」会被换成本模式的触发词——上一模式的自动句留着，技能收到的就是
    // 不相干的指令（扩图收了机位指令出不了补边）。用户自己写的句子在这条线上认不出来，永远不动。
    let autoPrompt = "";
    const fillAutoPrompt = (text) => { autoPrompt = String(text || "").trim(); promptInput.value = autoPrompt; };
    const isAutoPrompt = () => { const cur = promptInput.value.trim(); return !cur || cur === autoPrompt; };

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
    const editModelCfg = createModelConfigSection({ getSkillId: () => skillSel.value });
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
    // 技能列表是异步填进下拉的：「再来一发」要等它落位才认得出副文件里那个技能 id
    const skillsReady = (async () => {
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
    const applyEditModelCfg = async (skillId, overlay = {}) => {
        if (!editGenModels || !skillId) return;
        const cfg = await getSkillGenConfig(skillId);
        // 「再来一发」的主模型 / LoRA 叠在技能配置之上：重放的是那一发的生效值
        editModelCfg.load({ ...cfg, ...overlay }, editGenModels);
    };
    const modelsReady = (async () => {
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
        if (dp) fillAutoPrompt(dp);
        applyEditModelCfg(skillSel.value).then(syncEditParamsChip);
    };

    // 模式码 → chip 上那个名字（空面板的提示句要报名字，名字跟着 i18n 走；chip 与 modeSel 在下方构造）
    const modeLabel = (mode) => Array.from(modeSel.options).find((o) => o.value === mode)?.textContent || mode;

    let editMode = "normal";   // 声明在 renderIdle 之前：空面板初始渲染就要读它（模式只由用户切，代码不改）

    // 空面板的提示句跟着面板落定的模式走：直达卡与模式 chip 都能在没有原图时把模式定下来，
    // 提示要点名这一发要干什么，否则用户只知道面板在等他、不知道在等什么
    const renderIdle = () => {
        // 绘画页那块面板贴着预览图，纵向没有余量：有原图时不再挂那行说明（进度 / 错误仍用这块状态区）
        // 空面板 + 首页带来的模式：提示句要点名这一发要干什么，否则用户只知道面板在等他、不知道在等什么
        const hint = !source ? (editMode !== "normal"
            ? tf("已选「{mode}」：点预览区的「原图」方块选原图", { mode: modeLabel(editMode) })
            : t("点预览区的「原图」方块选原图，再写编辑指令"))
            : panel.embedded ? ""
            : t("填写编辑指令后点「生成」，原图将作为参考图传入所选技能。");
        fill(statusBox, hint ? $el("div", { className: "neo-gallery-story-hint", textContent: hint }) : null);
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
        if (!source && !refName) { renderError(t("先选一张原图：点预览区的「原图」方块，或把素材拖进来")); return; }
        if (editMode === "local" && !painted) { renderError(t("请先涂抹要编辑的区域")); return; }
        if (editMode === "remove" && !removePoints.length) { renderError(t("请先点击原图标记要删除的物体")); return; }
        restoreOrigImage();   // 上一轮换过的缩放图先还原，避免扩图/局部的基准尺寸跟着变
        let prompt = promptInput.value.trim();
        if (editMode === "outpaint" && !prompt) prompt = OUTPAINT_DEFAULT_PROMPT;
        if (editMode === "remove" && !prompt) prompt = REMOVE_DEFAULT_PROMPT;
        if (editMode === "blend" && !prompt) prompt = BLEND_DEFAULT_PROMPT;
        if (editMode === "pose" && !prompt) prompt = poseBasePrompt();
        if (editMode === "angle" && !prompt) prompt = angleOrb.prompt();
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
            plainEdit = (editMode === "normal" || editMode === "pose" || editMode === "angle") && !!metaWidth && !!metaHeight;
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
            if (editMode === "angle") payload.angle = angleOrb.get();   // 三档进副文件：再来一发按同一机位重放
            // 姿势锁形：控制图已是控制图（骨架 / 深度 / 法线 / 线稿 / 剪影）时直连模型补丁，
            // 模板里那道 Openpose 预处理只对「拿人物照片当控制图」有用
            if (editMode === "pose" && controlDirectChk.checked) payload.control_direct = true;
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
    const MODE_ICONS = { normal: "wand", outpaint: "maximize", local: "pencil", remove: "cross", blend: "copy", pose: "user", angle: "camera" };
    const modeSel = $el("select", { className: "neo-recipes-sort neo-gallery-gm-chip-select neo-gallery-edit-mode-select", title: t("编辑模式：决定在原图上怎么动手") });
    for (const [mode, name, tip] of [
        ["normal", t("常规"), t("常规编辑：按编辑指令整图重绘，原图作参考")],
        ["outpaint", t("扩图"), t("扩图：在原图上拖框定四边留白量，由模型补全周边场景")],
        ["local", t("局部"), t("高分局部编辑：涂抹要修改的区域，自动裁剪放大重绘后合并回原图")],
        ["remove", t("删除"), t("点选删除：在原图上点击要删除的物体，SAM3 自动分割并叠加红色遮罩预览，确认后移除（已预填默认删除指令，可修改）")],
        ["blend", t("融合"), t("多图融合：添加多张参考图，由模型自动融合为一张连贯画面")],
        ["pose", t("姿势"), t("姿势锁形（ControlNet）：预览区放原图，参考图区第 1 格放控制图（骨架 / 深度 / 法线 / 线稿 / 剪影），锁住控制图的姿势与构图重出原图")],
        ["angle", t("机位"), t("机位：拖动机位球（或用球角四个箭头、三条滑杆、键盘方向键）定相机位置，按转角 / 俯仰 / 镜头三档重出这一张，长相服装光线背景不变")],
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

    // 姿势锁形（ControlNet）控件：免检测直连开关 + 图位约束提示。控制图吃的是参考图区第 1 格
    // （技能 control_ref=2 只摘那一张进模型补丁），原图还是预览区那一张，这一发两张缺一不可。
    const controlDirectChk = $el("input", { type: "checkbox", checked: "checked" });
    controlDirectChk.title = t("勾上 = 控制图已是控制图（骨架 / 深度 / 法线 / 线稿 / 剪影），直连模型补丁；关掉 = 控制图是人物照片，先由 Openpose 检测出骨架");
    const poseHint = $el("span", { className: "neo-gallery-edit-size-label", textContent: t("控制图放参考图区第 1 格，原图放预览区：这一发两张都要") });
    const poseRow = $el("div", { className: "neo-gallery-edit-outpaint-row" }, [
        $el("label", { className: "neo-director-field-label", textContent: t("控制图免检测直连") }),
        controlDirectChk,
        poseHint
    ]);
    poseRow.style.display = "none";

    // 机位控件：机位球 + 三条滑杆（转角 / 俯仰 / 镜头），只在「机位」模式出现，控件本体在 angle/angle-orb.js
    const angleSliders = {};
    const angleRowsBox = $el("div", { className: "neo-gallery-edit-angle-sliders" });
    for (const [key, labelText, values, tip] of [
        ["rotation", t("转角"), ROTATION_VALUES, t("相机绕主体转一圈的八个机位（正面 → 右侧 → 背面 → 左侧）")],
        ["tilt", t("俯仰"), TILT_VALUES, t("相机的高低：负值从下往上仰拍，正值从上往下俯拍")],
        ["zoom", t("镜头"), ZOOM_VALUES, t("镜头远近：远景定场、中景带环境、特写贴脸")],
    ]) {
        const out = $el("output");
        // 转角滑杆走界面刻度 -180..180（左端、右端都是背面，中点正面），滑块位置与读数同一套数字；
        // 直接用后端的 0..315 时滑杆右端停在左前 315，绕不到背面
        const lo = key === "rotation" ? -180 : values[0];
        const hi = key === "rotation" ? 180 : values[values.length - 1];
        const input = $el("input", { type: "range", min: String(lo), max: String(hi), step: String(values[1] - values[0]), value: "0", title: tip });
        angleSliders[key] = { input, out, values };
        angleRowsBox.appendChild($el("div", { className: "neo-angle-row" }, [$el("label", { textContent: labelText }), input, out]));
    }
    const angleOrb = createAngleOrb({
        cfg: { rotation: 0, tilt: 0, zoom: 5 },
        onChange: (cfg) => { syncAngleSliders(cfg); fillAnglePrompt(); },
    });
    const angleBox = $el("div", { className: "neo-gallery-edit-angle" }, [angleOrb.el, angleRowsBox]);
    angleBox.style.display = "none";

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
    // 图位上限按模式走：姿势锁形只吃第 1 格那张控制图，多出来的图位在这一发没有去处
    const refSlotCap = () => (editMode === "pose" ? POSE_MAX_REFS : MAX_EXTRA_REFS);
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
            onclick: () => { refFileInput.click(); closePicks(); },
        }),
        $el("button", {
            className: "neo-gallery-edit-refpick", type: "button", textContent: "🖼 " + t("素材库取用"),
            title: t("从素材库取图作参考：弹窗里点卡片取用，或从素材库拖进图位"),
            onclick: () => { pickRefsFromLibrary(); closePicks(); },
        }),
    ]);
    refDropContainer.appendChild(refPickRow);
    const refCountNum = refPickRow.querySelector(".neo-gallery-edit-refcount-num");
    const syncRefCount = () => { refCountNum.textContent = `${extraRefs.length}/${refSlotCap()}`; };
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
    // Lightbox 统一列表：原图 + 所有参考图，支持 ←/→ 切换。直达卡会把模式带到空面板上，
    // 那时 source 还是 null，origUrl()/pathLabel() 读的就是 source.filename —— 没有原图就不放这一项
    const buildLightboxItems = () => [
        ...(source ? [{ kind: "image", url: origUrl(), title: pathLabel() }] : []),
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
        if (!items.length && !resultItems.length) return;   // 空面板点预览区：没有任何可放大的图
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
    // 空预览里的原图方块：点一下开素材库，hover 出「素材库取图 / 本地上传」两项，拖进来 / 粘贴同样吃。
    // 提示区整块不吃指针（空态时预览舞台本身是拖放落点），方块自己把指针吃回来
    const empty = $el("div", { className: "neo-gallery-edit-empty" });
    // 方块菜单里「⬆ 本地上传」那项走的隐藏文件框：本地文件先传进 input/，再落进原图（原图只有一张，取第一张）
    const srcFileInput = document.createElement("input");
    srcFileInput.type = "file";
    srcFileInput.accept = "image/*";
    srcFileInput.style.display = "none";
    srcFileInput.onchange = async () => {
        const files = Array.from(srcFileInput.files || []);
        srcFileInput.value = "";
        if (!files.length) return;
        const [fname] = await uploadLocalFiles(files);
        if (fname) useSourcePicks([{ filename: fname, subfolder: "" }]);
    };
    imgWrap.appendChild(srcFileInput);
    const renderSourceEmptyBox = () => {
        const box = $el("div", { className: "neo-gallery-edit-srcbox" }, [
            $el("span", { className: "neo-gallery-edit-srcbox-plus", textContent: "＋" }),
            $el("span", { className: "neo-gallery-edit-srcbox-cap", textContent: t("原图") }),
            $el("span", { className: "neo-gallery-edit-srcbox-tip", textContent: t("点击从素材库选 · 拖进来 · 悬停出菜单") }),
            $el("div", { className: "neo-gallery-edit-libmenu", style: { display: "none" } }, [
                $el("button", { className: "neo-gallery-edit-libmenu-item", type: "button", textContent: "🖼 " + t("素材库取图"), onclick: (e) => { e.stopPropagation(); pickSourceFromLibrary(); } }),
                $el("button", { className: "neo-gallery-edit-libmenu-item", type: "button", textContent: "⬆ " + t("本地上传"), onclick: (e) => { e.stopPropagation(); srcFileInput.click(); } }),
            ]),
        ]);
        const menu = box.querySelector(".neo-gallery-edit-libmenu");
        box.onmouseenter = () => { clearTimeout(box._menuTimer); menu.style.display = "block"; };
        box.onmouseleave = () => { box._menuTimer = setTimeout(() => { menu.style.display = "none"; }, 150); };
        box.onclick = () => pickSourceFromLibrary();
        box.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; box.classList.add("drop-active"); });
        box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove("drop-active"); });
        box.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); box.classList.remove("drop-active"); applyDroppedSource(e); });
        empty.textContent = "";
        empty.appendChild(box);
    };
    renderSourceEmptyBox();
    imgWrap.appendChild(empty);
    if (!source) origImg.style.display = "none";
    // 模式 chip 永远可点：模式是用户的选择，代码不替用户改它（收回原图、换原图都不动），
    // 禁用等于把模式锁死在无原图面板上。缺原图由提示句与「生成」那句话说清
    // 舞台：只负责把图片盒水平居中。对比说明行与「看大图」按钮去掉了——点图 / 点分割线本来就进灯箱
    const compareStage = $el("div", { className: "neo-gallery-edit-compare-stage" }, [imgWrap]);
    const compareBox = $el("div", { className: "neo-gallery-edit-compare" }, [compareStage]);

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
    // 原图方块、参考图位与编辑指令框在同一块输入卡里：一框一事，卡里只有一处主焦点
    const composer = $el("div", { className: "neo-gallery-gm-composer" }, [
        $el("div", { className: "neo-gallery-edit-refline" }, [refDropContainer, promptInput]),
        // 宽高输入排在 chip 行上方：输入卡钉在页面底边，排在下面就会被折叠线切掉（点开了看不见）
        sizeEditor,
        $el("div", { className: "neo-gallery-gm-composer-bar neo-gallery-gm-chips" }, [
            skillChip.el,
            modeChip.el,
            sizeChip,
            $el("div", { className: "neo-gallery-gm-composer-gap" }),
            genBtn,
        ]),
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
            poseRow,
            angleBox,
            statusBox,
            composer,
            actionsBox
        ])
    ]));

    renderIdle();
    // chip 菜单收在按下那一发（pointerdown 捕获）上：combo 的模型 / LoRA 列表在 mousedown 里就收了，
    // 松手落在浮层底下的元素上，click 由浏览器发在两个落点的共同祖先上，照 click 收就把「选个模型」当成点面板外
    const onDocPress = (e) => { for (const chip of composerChips) chip.closeOnOutside(e.target); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDocPress, true);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => {
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("pointerdown", onDocPress, true);
        document.removeEventListener("pointermove", onDividerMove);
        document.removeEventListener("pointerup", onDividerEnd);
        origRemove();
    };
    if (panel.embedded) {
        panel.host.appendChild(overlay);
        panel.host.__neoPanelClose = () => { close(); panel.host.__neoPanelRoot = null; panel.host.__neoSetSource = null; panel.host.__neoPrefillEdit = null; panel.host.__neoSetMode = null; panel.host.__neoClearSource = null; };
        panel.host.__neoSetSource = (img, sub) => applySource(img.filename || img.name, sub || "");
        panel.host.__neoPrefillEdit = (pf) => applyEditPrefill(pf);   // 再来一发：原图 / 参考图 / 模式 / 技能全换进这块现成面板
        panel.host.__neoSetMode = (m) => setPanelMode(m);   // 首页直达卡：把这一发的模式切进这块面板
        panel.host.__neoClearSource = () => clearSource();   // 收回原图走面板内那条路（宿主侧入口与 ✕ 同一函数）
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
            // 原图是在扩图模式里落进来的话，画布基准是按「还没解码的原图」量的（fitSize 量到 0）。
            // 解码完成这一刻按真实显示尺寸重铺一次——此时用户还没开始拖框，重铺没有代价
            if (editMode === "outpaint" && canvasEl && !base?.dw) {
                setupOutpaintBox();
                snapBoxToRatio();
                updateSizeLabel();
            }
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

    // ---- 编辑模式统一管理（normal / outpaint / local / remove / blend / pose）：editMode 在 renderIdle 上方声明 ----
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
    // 姿势锁形的触发词就是 ControlNet 技能 config 的 default_prompt，模式不在前端另写一份
    const poseBasePrompt = () => String(_genSkills.find(s => s.id === QWEN_CONTROLNET_SKILL_ID)?.gen_config?.default_prompt || "").trim();
    // 机位触发词 = 技能 default_prompt 的方括号按当前三档填死；只覆盖「空 / 代码写进去的那句」，
    // 用户自己写过的句子不碰
    const angleTemplate = () => String(_genSkills.find(s => s.id === QWEN_CAMERA_ANGLE_SKILL_ID)?.gen_config?.default_prompt || "").trim();
    const syncAngleSliders = (cfg) => {
        for (const [key, box] of Object.entries(angleSliders)) {
            // 转角滑块读界面刻度（-180..180）：背面同时是两端，已经停在左端时别被同步弹到右端
            const shown = key === "rotation" ? rotationToDisplay(cfg.rotation) : cfg[key];
            const keepLeft = key === "rotation" && shown === 180 && Number(box.input.value) === -180;
            box.input.value = String(keepLeft ? -180 : shown);
            box.out.textContent = key === "rotation" ? `${rotationLabel(cfg.rotation)}${box.input.value}°`
                : key === "tilt" ? `${tiltLabel(cfg.tilt)}${cfg.tilt}°` : zoomLabel(cfg.zoom);
        }
    };
    // 机位触发词 = 技能 default_prompt 的方括号按当前三档填死。
    // 进模式那一下（force）直接写：模式本身就是「用机位指令重出这一张」，框里残留上一个模式的词会让技能收不到机位；
    // 进模式之后只覆盖「空 / 代码写进去的那句」，用户自己改过的不碰。
    const fillAnglePrompt = (force = false) => {
        if (editMode !== "angle") return;
        if (!force && !isAutoPrompt()) return;
        fillAutoPrompt(anglePrompt(angleOrb.get(), angleTemplate()));
    };
    /** 滑杆落点吸附到档位：range 的 step 已按档位排好，这里只兜手改 value 与拖到中间值的情况。 */
    const snapAngleValue = (key, raw) => snapToNearest(Number(raw) || 0,
        { rotation: ROTATION_VALUES, tilt: TILT_VALUES, zoom: ZOOM_VALUES }[key]);
    for (const [key, box] of Object.entries(angleSliders)) {
        box.input.addEventListener("change", () => {
            // 转角滑杆读的是界面刻度，转到后端的 0-315 顺带吸附；俯仰 / 镜头直接吸档
            const next = key === "rotation" ? displayToRotation(box.input.value) : snapAngleValue(key, box.input.value);
            angleOrb.set({ ...angleOrb.get(), [key]: next });
            syncAngleSliders(angleOrb.get());
            fillAnglePrompt();
        });
    }
    // 模式专属行与尺寸片的显隐：扩图框 / 涂抹行 / 点选行 / 机位球都是「在原图上动手」的控件，
    // 没有原图时整块收着（那枚模式 chip 此时也是禁用的）。首页直达卡会把模式带到空面板上，
    // 空面板只剩预览区那枚「＋ 原图」方块与提示词框，applySource 把原图落定之后这里才亮起来。
    const syncModeRows = () => {
        const on = !!source;
        const m = editMode;
        outpaintRow.style.display = on && m === "outpaint" ? "" : "none";
        localRow.style.display = on && m === "local" ? "" : "none";
        removeRow.style.display = on && m === "remove" ? "" : "none";
        // 姿势锁形这一行不是「在原图上动手」的控件，没有原图也要露着：那一条图位约束
        // 正是用户选原图之前要知道的事
        poseRow.style.display = m === "pose" ? "" : "none";
        // 机位只用原图这一张：参考位与提示词框整块收起，这两件事跟着模式走，跟有没有原图无关
        // —— 直达卡把机位带到空面板时，那框固定句式的触发词更不该露在初始界面上。机位球要贴着
        // 原图摆才有意义，没有原图时收着；球 + 三条滑杆 + 一框提示词叠在一起，输入卡就顶到预览区
        // 头上，框收起来省下整块高度，出图时 prompt 照旧由滑杆实时写进框里，用户改过的句子切回
        // 其它模式还在。
        const isAngle = m === "angle";
        angleBox.style.display = on && isAngle ? "" : "none";
        refDropContainer.style.display = isAngle ? "none" : "";
        promptInput.style.display = isAngle ? "none" : "";
        // 尺寸片：扩图/局部/删除各自的画布定尺寸，片收起；扩图要把「目标尺寸」读数露在编辑区里
        const hideWH = on && (m === "outpaint" || m === "local" || m === "remove");
        widthInput.style.display = hideWH ? "none" : "";
        heightInput.style.display = hideWH ? "none" : "";
        resLabelEl.textContent = (on && { outpaint: t("目标尺寸"), local: t("编辑区（自动）"), remove: t("同原图") }[m]) || t("目标分辨率");
        sizeLabel.style.display = on && m === "outpaint" ? "" : "none";
        sizeChip.style.display = hideWH && m !== "outpaint" ? "none" : "";
        const openEditor = on && m === "outpaint";
        sizeEditor.style.display = openEditor ? "" : "none";
        sizeChip.classList.toggle("on", openEditor);
    };

    // 要在原图上动手的模式层：扩图把原图移进补边画布、局部铺涂抹层、点选删除铺标记层。
    // 空面板没有原图可动手，这三层都不铺：扩图在无原图的 imgWrap 上铺画布，量出来的基准是 0，
    // 画布塌成一格，还把 src 为空的 <img> 搬进画布（浏览器画出一枚坏图），分割线也挂进画布变可点。
    const setupModeLayer = async () => {
        if (!source) return;
        if (editMode === "outpaint") {
            setupOutpaintBox();
            snapBoxToRatio();
            if (!promptInput.value.trim()) fillAutoPrompt(OUTPAINT_DEFAULT_PROMPT);
        } else if (editMode === "local") {
            await setupPaint();
        } else if (editMode === "remove") {
            widthInput.value = origImg.naturalWidth || "";
            heightInput.value = origImg.naturalHeight || "";
            await setupRemoveClicks();
            if (!promptInput.value.trim()) fillAutoPrompt(REMOVE_DEFAULT_PROMPT);
            if (!refName) {
                try { refName = await copyImageToInput(source, source.subfolder); }
                catch (e) { removeHint.textContent = tf("原图读取失败：{msg}", { msg: e.message }); }
            }
        }
    };


    /** 切进一个模式写进提示词框的那句默认触发词。常规 / 局部要用户自己写，不在表里；
     *  机位那句照球当前档位现写（fillAnglePrompt），也不在这张表里 */
    const MODE_DEFAULT_PROMPT = {
        outpaint: () => OUTPAINT_DEFAULT_PROMPT,
        remove: () => REMOVE_DEFAULT_PROMPT,
        blend: () => BLEND_DEFAULT_PROMPT,
        pose: () => poseBasePrompt(),
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

        // 模式专属行与尺寸片：一次同步（空面板上这些行全部收着，见 syncModeRows）
        syncModeRows();

        // 技能选择（程序改 value 不触发 onchange，自定参数要自己重放到新技能的配置）
        skillSel.value = { outpaint: QWEN_OUTPAINT_SKILL_ID, local: QWEN_LOCAL_EDIT_SKILL_ID, pose: QWEN_CONTROLNET_SKILL_ID, angle: QWEN_CAMERA_ANGLE_SKILL_ID }[mode] || QWEN_IMAGE_SKILL_ID;
        skillChip.sync();
        await applyEditModelCfg(skillSel.value);
        syncEditParamsChip();

        // 模式专属 setup：提示词默认值是纯文本，空面板也填（直达卡进模式就该看到该模式那句话）；
        // 要在原图上动手的层由 setupModeLayer 自己判空，applySource 落定原图之后再补铺
        if (mode === "angle") {
            angleOrb.setTemplate(angleTemplate());
            fillAnglePrompt(true);
            syncAngleSliders(angleOrb.get());
        } else if (isAutoPrompt()) {
            // 上一个模式自动写的那句留着，这个模式的技能收到的就是不相干的指令——机位那句
            // 「Move the camera…」进扩图，扩图就出不了补边。空框与这句一起换成本模式那句；
            // 常规 / 局部没有固定句式，清空等用户重写
            fillAutoPrompt(MODE_DEFAULT_PROMPT[mode]?.() || "");
        }
        await setupModeLayer();   // 先铺层（扩图要在铺好的画布上量目标尺寸），再同步 chip 与尺寸读数
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

    /** 原图与参考位是 <img>，只吃图片：素材库那一片同时列着视频与音频（抽帧与出片要吃），
     *  把它们落进 <img> 就是破图。弹窗侧按 accept 过滤，拖放与批量取用这条路在落点挡，
     *  话点名走得通的那条路（视频先去「视频抽帧」取帧，帧图才是图） */
    const toastNeedImage = () => actionToast({ severity: "warning", summary: t("这里要一张图片"), detail: t("视频先到「视频抽帧」取帧，用帧图当原图与参考图；音频不能当图") });
    const refuseNonImage = (filename) => {
        if (isPickableImage(String(filename || ""))) return false;
        toastNeedImage();
        return true;
    };
    /** 拖进来的素材卡在复制进 input/ 之前先看一眼：视频复制过来只是白占一份磁盘 */
    const refuseDroppedCard = (raw) => {
        try { return refuseNonImage(JSON.parse(raw)?.filename); } catch { return false; }
    };

    function makeRefSlot(index) {
        const slot = $el("div", { className: "neo-gallery-edit-refdrop" });
        slot.title = t("点空格从素材库取图；把素材卡或本地图片文件拖进图位");
        const ref = extraRefs[index];
        if (ref) {
            slot.classList.add("has-img");
            // 列表第 0 项是原图；直达卡把模式带进空面板时没有原图，参考图下标不再往后挪一位
            slot.appendChild($el("img", { className: "neo-gallery-edit-refchip-img", src: refThumbUrl(ref, 128), alt: ref.filename, title: t("点击放大查看"), onclick: () => Lightbox.open({ items: buildLightboxItems(), index: index + (source ? 1 : 0) }) }));
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
            else {
                const raw = grabDataType(e);
                if (refuseDroppedCard(raw)) return;
                fname = await copyGalleryToInput(raw);
            }
            if (fname) { extraRefs[index] = { filename: fname, subfolder: "" }; renderRefSlots(); }
        });
        // 空格点击 = 素材库取用（本地文件走「＋参考」浮层里的「⬆ 本地上传」，或直接把文件拖进方块）
        slot.addEventListener("click", () => { if (!extraRefs[index]) pickRefsFromLibrary(); });
        return slot;
    }

    function renderRefSlots() {
        // 图位整列重建；file input 与取图按钮行是常驻节点，按类名清掉上一批图位
        for (const node of [...refDropContainer.children]) {
            if (node.classList.contains("neo-gallery-edit-refdrop")) node.remove();
        }
        const count = Math.min(Math.max(1, extraRefs.length + (extraRefs.length < refSlotCap() ? 1 : 0)), refSlotCap());
        for (let i = 0; i < count; i++) {
            refDropContainer.insertBefore(makeRefSlot(i), refPickRow);
        }
        syncRefCount();
    }
    renderRefSlots();

    /** 取用一批参考图（素材库弹窗回调 / 本地多选共用）：画廊素材先复制进 input/ 根目录，落不下的跳过 */
    async function addRefImages(items) {
        let refused = 0;   // 勾选集合这条路没被 accept 过滤过，混进来的视频与音频逐张挡，一次批量只说一句
        for (const it of items || []) {
            if (extraRefs.length >= refSlotCap()) break;
            if (!isPickableImage(String(it?.filename || ""))) { refused++; continue; }
            const fname = it.subfolder ? await copyGalleryToInput(JSON.stringify(it)) : it.filename;
            if (fname) extraRefs.push({ filename: fname, subfolder: "" });
        }
        if (refused) toastNeedImage();
        renderRefSlots();
    }

    /** 参考图位的素材库取用：Studio 宿主听 neo:media-pick 开弹窗；ComfyUI 没有监听，开侧栏照旧往方块里拖 */
    const pickRefsFromLibrary = () => {
        window.dispatchEvent(new CustomEvent("neo:media-pick", { detail: { target: null, onPick: addRefImages, accept: "image" } }));
        toggleGallerySidebar();
    };

    refFileInput.onchange = async () => {
        const files = [...(refFileInput.files || [])];
        if (!files.length) return;
        const names = await uploadLocalFiles(files);
        refFileInput.value = "";
        for (const fname of names) {
            if (!fname || extraRefs.length >= refSlotCap()) continue;
            extraRefs.push({ filename: fname, subfolder: "" });
        }
        renderRefSlots();
    };

    // 机位 / 扩图 / 局部 / 点选只用原图这一张，额外参考不可用（机位把整行收起，其余置灰）
    const syncRefBtn = () => {
        const disabled = editMode === "outpaint" || editMode === "local" || editMode === "remove" || editMode === "angle";
        refDropContainer.classList.toggle("disabled", disabled);
        if (disabled && extraRefs.length) { extraRefs = []; renderRefSlots(); }
        // 从多图模式带着参考图切进姿势：多出来的那些在这发没有去处，收着，图位只剩控制图那一格
        else if (editMode === "pose" && extraRefs.length > POSE_MAX_REFS) { extraRefs.length = POSE_MAX_REFS; renderRefSlots(); }
        // 图位不增不减也要重建一次：取图浮层上的「参考图 N/9」计数跟着模式的上限走，切模式就得改写
        else renderRefSlots();
    };

    // 原图区拖放替换：支持素材库拖入和本地文件上传
    // 换原图（拖放落点、卡片菜单「图片编辑」与素材库取用共用一条路）：refName 归零，生成时再把新原图复制进 input/
    const applySource = (filename, sub) => {
        // 模式只由用户切，换原图不动它——原图换了，扩图框 / 涂抹层 / 标记点由
        // setupModeLayer 在新原图上重铺（三层的 setup 开头各自拆旧层）
        refName = null;
        source = { filename, subfolder: sub };
        empty.style.display = "none";
        origImg.style.display = "";
        origImg.src = origUrl();
        renderIdle();
        fullUrlReady();   // 默认目标分辨率按新原图 + 全局目标像素数重算
        // 直达卡把模式带进空面板时，模式自己的控件是收着铺不了层的（没有原图可动手）；
        // 原图落定这一刻补上：扩图铺补边画布、局部铺涂抹层、点选删除铺标记层。
        // 不 await：涂抹/标记层要等原图解码，选原图这一步不能压着不返回
        syncModeRows();
        setupModeLayer().then(() => { updateSizeLabel(); syncSizeChip(); });
    };

    /** 首页「编辑」板块的直达卡把模式带进这块面板：当场切过去，没有原图也切（模式 chip 一直可点，
     *  用户一进面板就看到这一发要干什么）。之后选原图、换原图、收回原图都不动它——模式只由用户切 */
    const setPanelMode = (mode) => {
        const m = String(mode || "");
        if (!Array.from(modeSel.options).some((o) => o.value === m)) return;
        setEditMode(m);
        renderIdle();   // 状态区那行提示要点名这一发的模式，setEditMode 不碰状态区
    };

    // ---- 原图取用（预览区那枚方块）：点开素材库，取用 / 拖放 / 本地上传都落进 applySource ----
    /** 素材库弹窗点卡片取原图：原图只有一张，多张取用时只落第一张 */
    const useSourcePicks = async (items) => {
        const it = (items || [])[0];
        if (!it || refuseNonImage(it.filename)) return;
        const fname = it.subfolder ? await copyGalleryToInput(JSON.stringify(it)) : it.filename;
        if (!fname) return;
        applySource(fname, "");
        refName = fname;   // 取用的图已落在 input/，省掉生成时那一次复制
    };
    const pickSourceFromLibrary = () => {
        // Studio 宿主听 neo:media-pick 开素材库弹窗；ComfyUI 没有监听，开侧栏照旧往方块里拖
        window.dispatchEvent(new CustomEvent("neo:media-pick", { detail: { target: null, onPick: useSourcePicks, accept: "image" } }));
        toggleGallerySidebar();
    };
    /** ✕ 收回原图：只收原图。模式跟着用户，代码不切它（切走会把用户选的扩图 / 机位丢掉，切回来又得重选）；
     *  铺在原图上的那一层（扩图框 / 涂抹画布 / 标记点）随原图一起拆，模式专属控件由 syncModeRows 收起，
     *  出图尺寸读数回到无原图态 */
    const clearSource = () => {
        if (running) return;
        teardownOutpaintBox();
        teardownPaint();
        teardownRemove();
        restoreOrigImage();   // 扩图把 <img> 搬进补边画布、局部换过缩放图，这里搬回预览区等着下一张
        source = null;
        refName = null;
        resultItems = [];
        resultImg.removeAttribute("src");
        resultClip.style.display = "none";
        divider.style.display = "none";
        origImg.removeAttribute("src");
        origImg.style.display = "none";
        empty.style.display = "flex";
        renderSourceEmptyBox();
        widthInput.value = "";
        heightInput.value = "";
        syncModeRows();
        updateSizeLabel();
        syncSizeChip();
        renderIdle();
    };
    /** 拖进原图方块与拖进预览区同一语义：本地文件先上传，素材库卡片先复制进 input/ */
    const applyDroppedSource = async (e) => {
        e.currentTarget.classList.remove("drop-active");
        const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
        let fname = null;
        if (files.length) { [fname] = await uploadLocalFiles(files); }
        else {
            const raw = grabDataType(e);
            if (refuseDroppedCard(raw)) return;
            fname = await copyGalleryToInput(raw);
        }
        if (!fname) return;
        applySource(fname, "");
        refName = fname;   // 拖进来的图已落在 input/，省掉生成时那一次复制
    };

    /** 「再来一发」（编辑图）：副文件里的原图 / 编辑模式 / 参考图 / 出图尺寸 / 技能与自定参数
     *  逐项填进这块现成面板，面板不重建。姿势锁形那一发还带回免检测直连那一档。
     *
     *  顺序是原图 → 模式 → 参考图：切模式会清掉额外参考图（扩图 / 局部 / 点选只用原图那一张），
     *  反过来填只剩一地残留。涂抹遮罩与扩图边距是用户在原图上画出来
     *  的，这两样复现不了；技能不在本页下拉里（本页只列吃参考图的技能）就整项不填。 */
    const applyEditPrefill = async (pf) => {
        await skillsReady;
        const filled = [];
        const src = pf?.src;
        if (src?.filename && !refuseNonImage(src.filename)) {
            await setEditMode("normal");   // 先把模式收回常规：applySource 里那一次就不再多跑一轮
            applySource(src.filename, src.subfolder || "");
            filled.push(t("原图"));
        }
        const mode = String(pf?.mode || "");
        if (mode && mode !== "normal" && Array.from(modeSel.options).some((o) => o.value === mode)) {
            await setEditMode(mode);
            filled.push(t("编辑模式"));
        }
        // 扩图 / 局部 / 点选 / 机位的额外参考图不进 payload（这几条只用原图），填了就是骗人
        const refs = editMode === "outpaint" || editMode === "local" || editMode === "remove" || editMode === "angle"
            ? [] : (pf?.refs || []).filter((r) => r?.filename);
        if (refs.length) {
            await addRefImages(refs);
            if (extraRefs.length) filled.push(t("参考图"));
        }
        // 免检测直连跟着副文件走：那一发出的是骨架直连，重放就不许落到人物照片那条检测路
        if (editMode === "pose" && pf?.control_direct !== undefined) controlDirectChk.checked = !!pf.control_direct;
        const w = Number(pf?.width) || 0, h = Number(pf?.height) || 0;
        if (w >= 256 && h >= 256 && w <= 8192 && h <= 8192) {
            widthInput.value = String(round32(w));
            heightInput.value = String(round32(h));
            syncSizeChip();
            filled.push(t("出图尺寸"));
        }
        filled.push(...await applyEditReuseSkill(pf));
        // 机位三档：模式与技能都填好后回填，球、滑杆、读数一起跟上（提示词在下一步照副文件填）
        if (editMode === "angle" && pf?.angle) {
            angleOrb.set(pf.angle);
            syncAngleSliders(angleOrb.get());
            filled.push(t("机位"));
        }
        const prompt = String(pf?.prompt || "").trim();
        if (prompt) {
            promptInput.value = prompt;
            // 机位那一发框里那句就是球当前档位写的：拖球还要接着改它，这句按「代码写进去的」记；
            // 别的模式带回来的句子是用户写的，切模式时不给他换掉
            autoPrompt = editMode === "angle" ? prompt : "";
            filled.push(t("提示词"));   // 最后填：切技能那一步写的是该技能的默认触发词
        }
        return filled;
    };

    /** 副文件里的技能与自定参数落进面板：自定参数只填清单里还在盘上、家族与技能对得上的那部分 */
    const applyEditReuseSkill = async (pf) => {
        const meta = _genSkills.find((s) => s.id === String(pf?.skill || ""));
        if (!meta) return [];
        skillSel.value = meta.id;
        skillChip.sync();
        await modelsReady;
        await applyEditModelCfg(meta.id, reuseModelOverlay(pf, editGenModels, meta));
        syncEditParamsChip();
        return [t("技能与自定参数")];
    };
    imgWrap.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; imgWrap.classList.add("drop-active"); });
    imgWrap.addEventListener("dragleave", (e) => { if (!imgWrap.contains(e.relatedTarget)) imgWrap.classList.remove("drop-active"); });
    imgWrap.addEventListener("drop", (e) => { e.preventDefault(); applyDroppedSource(e); });

    notifyPrefillFilled(opts?.prefill ? applyEditPrefill(opts.prefill) : []);
    setTimeout(() => promptInput.focus(), 0);
}
