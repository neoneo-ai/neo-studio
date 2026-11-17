// 绘画页（文生图）与编辑页（图片编辑）：一页一块面板铺满整栏；素材库走弹窗取用，只挂在编辑页。
// 面板内嵌进这两页（同导演编辑器 setDirectorEditorHost 语义）：面板进页就铺好，素材库的「生成素材」与
// 图片卡菜单「图片编辑」只负责跳到那一页（面板复用，不重建）。ComfyUI 插件模式没有宿主，照旧弹浮层窗。
import { t } from "../../js/core/i18n.js";
import { setIcon, setIconLabel } from "../../js/core/icons.js";
import { openPresetPicker, randomPromptText } from "../../js/core/preset-picker.js";
import { reusePaintPanel } from "../../gen-utils.js";
import { setPaintHost, openGenMaterialDialog, openImageEditDialog, openVideoReuse } from "../../gallery-gen.js";

/** @typedef {Object} PaintEditHost
 *  @property {Function} $el 建元素
 *  @property {Function} toast 提示文本
 *  @property {Function} go 切页
 *  @property {Function} openLibModal 开素材库弹窗（scope, onPick, accept）：弹窗是单例，归装配层的素材宿主
 *  @property {Function} closeMaterialModal 收掉素材库弹窗
 *  @property {Function} gallery 现值读一次画廊宿主（面板构造函数的第一枚参数） */

/** 绘画页与编辑页的工厂：面板宿主、armed 门与技能选中态都留在这一个闭包里，随视图常驻 */
export function createPaintEditPage(host) {
    const { $el, toast, go, openLibModal, closeMaterialModal, gallery } = host;

    // 宿主 onOpen 是一份合并表（setPaintHost 后写覆盖前写），两页共用这一个按 kind 分流的入口。
    // 面板构造时宿主也会发一次（空画布自己种 storyboard 也发）：那一下不是用户要点素材，
    // 建完面板才放开跳页——启动时这一发就不会把页面从首页 / 设置页深链拽走
    let paintArmed = false;
    let paintTextHost = null;   // 输入页那块生图面板的宿主：技能卡直达时按它的 __neoSetPrompt 选中这张技能
    let paintEditHost = null;   // 图片编辑那块面板的宿主：只能带参考图的编辑技能在输入页候选里没有位置，落这一页选中
    let editArmed = false;
    function paintHostOpen(kind) {
        if (kind === "text" ? paintArmed : editArmed) openPaintTarget(kind);
    }

    function openPaintTarget(kind) {
        // 已在目标页时 go() 是同页空转，showView 里「离开该页收起弹窗」那段不触发：
        // 交还给本页面板后弹窗会盖在面板上，所以入口自己收
        go(kind === "edit" ? "edit" : "paint");
        closeMaterialModal();
    }

    function buildPaint(el) {
        const page = $el("div", { className: "ns-paint" });
        el.appendChild(page);
        const main = $el("div", { className: "ns-paint-main" });
        const textHost = $el("div", { className: "ns-paint-panel ns-paint-text" });
        page.appendChild(main);
        main.appendChild(textHost);

        setPaintHost({ text: textHost, onOpen: paintHostOpen });
        paintTextHost = textHost;
        // 文生图直接写提示词就能生成
        openGenMaterialDialog(gallery(), { container: textHost });
        // 右上角浮一枚提示词入口（绝对定位在预览区上，不为它们空出一行）
        page.appendChild(paintPromptBar(textHost, "text"));
        paintArmed = true;
    }

    /** 绘画页 / 编辑页右上角那排提示词入口：一颗组合钮——左半「提示词」在按钮下方开提示词浮层，
     *  右半骰子抽一条图像提示词，两条都落进这一页现成面板的提示词框（面板不在了就重建一块带预填的）。
     *  extra 是这一页原本就有的入口（编辑页的「素材库」），排在最前 */
    function paintPromptBar(hostEl, kind, extra = []) {
        const fill = (text) => fillPaintPrompt(hostEl, kind, text);
        const presetBtn = $el("button", { className: "ns-btn ns-paint-preset-btn", type: "button", textContent: t("提示词"), title: t("从图像提示词列表里挑一条填进提示词") });
        const randomBtn = $el("button", { className: "ns-btn ns-paint-random-btn", type: "button", title: t("随机填入一条图像提示词") });
        setIcon(randomBtn, "dice");
        presetBtn.onclick = () => openPresetPicker({ kind: "image", onPick: fill, anchor: presetBtn });
        randomBtn.onclick = async () => {
            try {
                const text = await randomPromptText("image");
                if (!text.trim()) { toast(t("提示词库为空，抽不到图像提示词")); return; }
                fill(text);
            } catch (e) { toast(String(e?.message || e)); }   // 桌面端离线那一发要说出需要 ComfyUI，不能报词库为空
        };
        return $el("div", { className: "ns-paint-bar" }, [...extra, $el("div", { className: "neo-split-btn" }, [presetBtn, randomBtn])]);
    }

    /** 把一段提示词落进那一页现成面板的提示词框：面板在位就只换内容（这一排入口与增强页的落页钮共用这一条），
     *  面板不在这页了才重建一块带预填的 */
    function fillPaintPrompt(hostEl, kind, text) {
        if (reusePaintPanel(hostEl, kind, null, null, { prompt: text })) return;
        if (kind === "edit") openImageEditDialog(gallery(), null, "", { container: hostEl, prefill: { prompt: text } });
        else openGenMaterialDialog(gallery(), { container: hostEl, prefill: { prompt: text } });
    }

    function buildEdit(el) {
        const page = $el("div", { className: "ns-paint" });
        el.appendChild(page);
        const main = $el("div", { className: "ns-paint-main" });
        const editHost = $el("div", { className: "ns-paint-panel ns-paint-edit" });
        page.appendChild(main);
        main.appendChild(editHost);
        // 素材库入口浮在页面右上角（绝对定位在 .ns-paint 上），不为它空出一行；
        // 弹窗点卡片 = 取用该图当原图，拖进预览区 = 投放当原图
        const libBtn = $el("button", { className: "ns-btn ns-paint-lib-btn", type: "button", title: t("打开素材库：点卡片取用进图片编辑，拖进预览区投放") });
        setIconLabel(libBtn, "folder", t("素材库"));
        libBtn.onclick = () => openLibModal("edit", pickImage, "image");
        page.appendChild(paintPromptBar(editHost, "edit", [libBtn]));

        setPaintHost({ edit: editHost, onOpen: paintHostOpen });
        paintEditHost = editHost;
        // 空面板铺好，从素材库把图拖进预览区当原图即可
        openImageEditDialog(gallery(), null, "", { container: editHost });
        editArmed = true;
    }

    /** 悬浮「素材库」的取用：弹窗点卡片 = 把这张图喂进图片编辑面板当原图（参考图菜单自己交回调，不经这里） */
    function pickImage(images) {
        const img = images[0];
        if (!img) return;
        openImageEditDialog(gallery(), { filename: img.filename }, img.subfolder);
    }

    /** 首页技能卡直达这一发：把这张技能选中在绘画页那块生图面板上（技能不在候选里时面板自己就不填） */
    function selectSkill(skillId) {
        paintTextHost?.__neoSetPrompt?.({ skill: skillId });
    }

    /** 只能带参考图的编辑技能那一发：图片编辑这块面板认 skill / 模式 / 原图，技能不在候选里时同样自己就不填 */
    function selectEditSkill(skillId) {
        paintEditHost?.__neoPrefillEdit?.({ skill: skillId });
    }

    /** 增强页那枚落页钮的落点：图像进绘画页那块现成输入卡，视频走出视频页那条现成预填链
     *  （这一页没建过时由启动时注册的 setVideoPageJump 先把页建起来，同素材卡「再来一发」那一条）。
     *  只填提示词框：增强那一发认的是增强技能清单，两页的技能候选是另一套，不拿它改这页的技能 */
    function applyEnhanced(mode, text) {
        if (mode === "video") { openVideoReuse({ prompt: text }); return; }
        go("paint");
        fillPaintPrompt(paintTextHost, "text", text);
    }

    return { buildPaint, buildEdit, pickImage, selectSkill, selectEditSkill, applyEnhanced };
}
