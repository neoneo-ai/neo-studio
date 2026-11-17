// 首页卡直达的六张薄页（3D 姿势 / 视频抽帧 / 图片反推 / 视频反推 / 声音克隆 / 提示词增强）。
// 页的实现各在 studio/web/<页名>/ 那一份里，这一层只把它们接到宿主交来的那几样：素材库取用、
// 运行闸门，与两条交回装配层的现成链（姿势页导出控制图进图片编辑面板；增强页把回话填回那一页）。
// 这六页在顶栏都没有页签，只从首页的卡进——落点由 app-registry.js 那六条描述符说。
import { createPoseView } from "../../pose/pose.js";
import { createFramesView } from "../../frames/frames.js";
import { createReverseView } from "../../reverse-prompt/reverse-prompt.js";
import { createReverseVideoView } from "../../reverse-video/reverse-video.js";
import { createVoiceCloneView } from "../../voice-clone/voice-clone.js";
import { createPromptEnhanceView } from "../../prompt-enhance/prompt-enhance.js";

/** @typedef {Object} LeafPagesHost
 *  @property {Function} api 取接口：离线与在线同一条路
 *  @property {Function} $el 建元素
 *  @property {Function} toast 提示文本
 *  @property {Function} can 读一个能力旗标
 *  @property {Function} gateRun 门控运行钮：能力缺时点它引导启动内核
 *  @property {Function} openMaterial 素材库取用一次就收窗（scope, accept, onPick）
 *  @property {Function} openEdit 把导出的控制图交图片编辑面板预填
 *  @property {Function} applyToPage 增强页的回话填回对应那一页 */

/** 六张薄页的工厂：宿主只在调用时传进来，页内状态留在各自工厂里，页卸载即散 */
export function createLeafPages(host) {
    const { api, $el, toast, can, gateRun, openMaterial, openEdit, applyToPage } = host;

    // 姿势视图的依赖在这汇聚：api 走 shim（离线/在线同一条路）；导出图组的控制图交图片编辑面板预填
    const buildPose = createPoseView({ api, $el, toast, openEdit });

    // 抽帧页与姿势页不共享任何东西：取用同一套弹窗，抽帧自己在浏览器里做（见 studio/web/frames/frames.js）
    const buildFrames = createFramesView({
        api, $el, toast,
        openMaterial: (onPick) => openMaterial("frames", "video", onPick),
    });

    // 图片反推 / 视频反推 / 声音克隆 / 提示词增强：运行按钮交 gateRun，能力缺时点它引导启动内核
    const buildReverse = createReverseView({
        api, $el, toast,
        openMaterial: (onPick, accept) => openMaterial("reverse", accept || "image", onPick),
        gateRun,
    });
    const buildReverseVideo = createReverseVideoView({
        api, $el, toast,
        openMaterial: (onPick) => openMaterial("reverse_video", "video", onPick),
        gateRun,
    });
    const buildVoiceClone = createVoiceCloneView({
        $el,
        openMaterial: (onPick) => openMaterial("voice", "audio", onPick),
        gateRun,
    });
    // 增强页只要素材库取图、运行闸门，以及回话上那枚「填入对应页」的落点；
    // 保存为预设那颗钮自己读能力表（提示词库写侧归内核）
    const buildPromptEnhance = createPromptEnhanceView({
        $el, toast, can,
        openMaterial: (onPick) => openMaterial("enhance", "image", onPick),
        gateRun,
        applyToPage,
    });

    return { buildPose, buildFrames, buildReverse, buildReverseVideo, buildVoiceClone, buildPromptEnhance };
}
