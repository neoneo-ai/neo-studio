/**
 * gallery-gen.js
 * 生图家族的门面：对外只从这里导出（卡片「⋯」的生成入口、两块生成面板、素材库小窗、绘画页宿主）。
 * 卡片菜单的生成项与「再来一发」的分发留在本文件；实现位于 gen-utils.js（面板宿主与 chip 底座）、
 * t2i-panel.js（生成素材面板）、image-edit-panel.js（图片编辑面板）、gallery-card-tools.js
 * （角色图 / 九宫格分镜图 / 反推提示词 / LoRA 打标 / 语音克隆）。
 */

import { $el } from "../../../../scripts/ui.js";
import { isImageFile, isAudioFile } from "./gallery-utils.js";
import { actionToast } from "./toast.js";
import { t } from "./js/core/i18n.js";
import {
    setPaintHost, chipButton, skillParamsChip, reuseModelOverlay, openImageEditMode,
    notifyPrefillFilled, ratioGlyph,
} from "./gen-utils.js";
import {
    buildCharacterSheetRequest, buildStoryboardGridPrompt, buildStoryboardGridRequest,
    openStoryboardDialog, openReversePromptDialog, openLoraTagDialog,
    openCharacterSheetDialog, openVoiceDialog,
} from "./gallery-card-tools.js";
import { openImageEditDialog } from "./image-edit-panel.js";
import { openGenMaterialDialog } from "./t2i-panel.js";

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

/** 素材卡菜单「再来一发」的视频入口：出视频页挂载时注册，把这一发交回视频页铺好面板。
 *  注册方在桌面端视频页（studio-app.js 的 buildVideo）；页面还没建过时先交应用层建页
 *  （setVideoPageJump 在应用层启动时注册），建完页注册方就落位了，这一发照样交得出去。
 *  画布页（#ns-view=canvas）没有这一层应用层：建不了页就明说，不假装跳过去。
 *  预填是异步的（要等技能与模型列表落位），填完的清单以 promise 交回。 */
let _videoReuseOpen = null;
let _videoPageJump = null;
export function setVideoReuseOpen(open) { _videoReuseOpen = open || null; }
export function setVideoPageJump(jump) { _videoPageJump = jump || null; }
export function openVideoReuse(reuse) {
    if (!_videoReuseOpen) {
        if (!_videoPageJump) {
            actionToast({ severity: "info", summary: t("出视频页尚未就绪"), detail: t("打开「视频」页后再点「再来一发」") });
            return Promise.resolve([]);
        }
        _videoPageJump();   // route 同步建视图：回来的那一刻注册方已在 buildVideo 里落位
    }
    const filled = _videoReuseOpen(reuse);
    notifyPrefillFilled(filled);   // 预填是异步的：填完的清单落回同一条复用提示，与两块输入卡一个口径
    return filled;
}

/** 卡片「⋯」菜单「再来一发」：把素材旁 .txt 读出的摘要交给对口的输入卡。
 *  视频 → 出视频页 composer；带原图或参考图的是编辑那一发 → 图片编辑面板（原图 / 参考图 / 模式一并填回）；
 *  只有提示词与尺寸的（含旧版 .txt）→ 「生成素材」输入卡。没有提示词可复用就是这条菜单项不该出现，
 *  兜底提示走 info 而不是报错。 */
export function reuseParamsFromMedia(gallery, reuse) {
    if (!String(reuse?.prompt || "").trim()) {
        actionToast({ severity: "info", summary: t("该素材没有可复用的提示词"), detail: t("素材旁的 .txt 由生成时写入，示例图只有提示词原文") });
        return;
    }
    if (reuse?.video) {
        openVideoReuse(reuse);
        return;
    }
    if (reuse?.src?.filename || reuse?.refs?.length) {
        openImageEditDialog(gallery, null, "", { prefill: reuse });
        return;
    }
    openGenMaterialDialog(gallery, { prefill: reuse });
}

export {
    setPaintHost, chipButton, skillParamsChip, reuseModelOverlay, openImageEditMode,
    buildCharacterSheetRequest, buildStoryboardGridPrompt, buildStoryboardGridRequest,
    openStoryboardDialog, openReversePromptDialog, openLoraTagDialog, openImageEditDialog,
    openGenMaterialDialog, ratioGlyph,
};
