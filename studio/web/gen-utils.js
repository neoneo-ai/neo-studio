/**
 * gen-utils.js
 * 两块生图输入卡与素材库小窗弹窗共用的底座：面板宿主落位与「面板已铺好就只换内容」的复用、chip 家族
 * （胶囊按钮 + 技能参数浮层 + 宽高比 glyph）、技能与主模型的家族守卫、小窗标题栏拖动、素材拷进 input。
 * 从 gallery-gen.js 拆出：面板本体在 t2i-panel.js 与 image-edit-panel.js，素材库专属弹窗在
 * gallery-card-tools.js，卡片菜单入口与「再来一发」分发在 gallery-gen.js。
 */

import { $el } from "../../../../scripts/ui.js";
import { api } from "../../../../scripts/api.js";
import { actionToast } from "./toast.js";
import { skillFamily } from "./skill.js";
import { shortModelName, modelFamily, LORA_FAMILY_HINTS } from "./image-gen.js";
import { inOpenComboList } from "./combo-box.js";
import { t, tf } from "./js/core/i18n.js";
import { icon, setIcon } from "./js/core/icons.js";

// 一键角色图 / 九宫格分镜图都固定走 Qwen Image 2.1 预设（多路参考槽位、不走 Krea2 编辑链）。
export const QWEN_IMAGE_SKILL_ID = "qwen_image_21";

/** 小窗标题栏拖动 + 双击最大化/还原（同导演编辑器）：首次按下从居中切到绝对定位并记录起点，
 *  之后按鼠标位移更新 left/top；钳制保证窗口不会被拖出视口（始终留一条可点到的标题栏 / ✕）。
 *  配合 overlay 的 pointer-events:none（gallery.css 的 *-modal-overlay 规则）= 不遮罩、可移动、窗户外照常浏览。 */
export function makeStoryWindowDraggable(modal) {
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

/** 卡片图片经 copy_to_input 落到 input 目录（与发送到 LoadImage 同一通道），返回 input 内的文件名 */
export async function copyImageToInput(image, subfolder) {
    const query = "filename=" + encodeURIComponent(image.filename || "")
        + (subfolder ? "&subfolder=" + encodeURIComponent(subfolder) : "");
    const resp = await api.fetchApi("/neo_gallery/copy_to_input?" + query);
    const result = await resp.json().catch(() => null);
    if (!resp.ok || !result || !result.success) {
        throw new Error((result && result.error) || t('无法读取该图片'));
    }
    return result.filename;
}

// 弹窗 → 内嵌面板双宿主（同 director.js 的 setDirectorEditorHost / opts.container）：
// Studio 注册过宿主，面板就铺进宿主容器，不建浮层、不带标题栏拖动；
// ComfyUI 插件模式（画布侧栏 gallery）没有宿主，照旧弹浮层窗，入口与类名一律不变。
// 两块宿主由两个页面各自注册（文生图 = 绘画页，图片编辑 = 编辑页），所以是合并写入：
// 覆盖式会让后建的那一页把自己的宿主连同别人的那份一起丢掉。
export let _paintHosts = {};   // { text, edit, onOpen }：文生图宿主 / 图片编辑宿主 / 打开时切到那一页
export function setPaintHost(hosts) { _paintHosts = { ..._paintHosts, ...hosts }; }

export function storyPanelRoot(host, overlayClass, kind) {
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

/** 宽高比 glyph：描边小方框按选中比例定形（16:9 出扁长框、9:16 出瘦高框），chip 上少写字也知道是哪一项。
 *  值两种写法都认：生图比例 chip 是 "16:9"，出视频页的分辨率 chip 是那一项的像素值 "1344,768" */
export function ratioGlyph() {
    const el = $el("span", { className: "neo-gallery-gm-chip-glyph" });
    const sync = (v) => {
        const [a, b] = String(v || "1:1").split(/[:,]/).map(Number);
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
        // 选中项没有自己的提示时落回 select 那句（「编辑模式：…」）：程序换 value 只调 sync，
        // 不写回这行 chip.title 的话，提示会一直挂着上一次选中项那句（用户看到的是上一个模式的说明）
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
 *  左栏技能按家族分组（组头 = 家族，行只写技能名），右栏 = 传进来的主模型 / LoRA 控件。
 *  技能行一律可点：点技能会走 modelCfg.load(该技能 config)，右栏主模型与 LoRA 整份被该技能自己的配置替换，
 *  家族对撞在这一发里根本留不住；跨家族行只把「会换成哪个主模型」写在悬停标题上。
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
                const cross = !!modelFam && !!rowFam && rowFam !== modelFam;
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
export function guardMainModelFamily(modelCfg, skillSel) {
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

/** 主模型与技能家族对撞的判定（guardMainModelFamily 同一条线）：家族不同的 conditioning 维度对不上，
 *  这一发必败。复用的是程序写值、不触发 change，那条 guard 不会自己跑，填之前先过同一道判定 */
function reuseModelFits(skillMeta, model) {
    const fam = skillFamily(skillMeta), pickedFam = modelFamily(model);
    return !fam || !pickedFam || fam === pickedFam;
}

/** 「再来一发」带回来的自定参数（主模型 / LoRA）→ 能填进面板的那部分。
 *  副文件记的是那一发的生效值，文件挪走或改名之后还把它填成覆盖值，等于给用户埋一次必败：
 *  只留模型清单里还在盘上的那些，剩下的落回该技能 config 里钉的那个（= 面板的「自动」） */
export function reuseModelOverlay(pf, models, skillMeta) {
    const list = models || {};
    const overlay = {};
    if (pf?.model && (list.diffusion_models || []).includes(pf.model) && reuseModelFits(skillMeta, pf.model)) {
        overlay.model = pf.model;
    }
    const loras = (pf?.loras || []).filter((l) => l?.name && (list.loras || []).includes(l.name));
    if (loras.length) overlay.loras = loras;
    return overlay;
}

// 绘画页进页就把两块面板铺好（常驻），入口再点只做模式切换：重建面板会把用户写了一半的
// 提示词清空，所以宿主里已有面板时直接复用，不再走一遍构建。图片编辑入口带着图来，
// 就把这张图换进现成面板当原图（卡片菜单「图片编辑」与拖进预览区同一条路）
/** 面板宿主为绘画页时复用已铺好的面板：同种面板在位就只换内容（拖进来的原图 /
 *  「再来一发」带进来的预填），不重建 */
export function reusePaintPanel(host, kind, image, subfolder, prefill = null) {

    if (!host?.__neoPanelRoot?.isConnected) return false;
    if (prefill) {
        // 编辑面板那块的复用要动原图 / 参考图 / 模式，走它自己那套预填；绘画页的只填提示词与尺寸
        const filled = kind === "edit" ? host.__neoPrefillEdit?.(prefill) : host.__neoSetPrompt?.(prefill);
        notifyPrefillFilled(filled);
    } else if (image) {
        host.__neoSetSource?.(image, subfolder);
    }
    _paintHosts?.onOpen?.(kind);
    return true;
}

/** 首页「编辑」板块的直达卡：跳到编辑页，并把这一发要用的模式切进那块现成面板。
 *  编辑页进页就把面板铺好了（buildEdit 注册的宿主），这里只换模式、不重建——重建会把用户写了一半
 *  的提示词清掉。模式当场切过去，没有原图也切，之后换原图也不动它（模式以用户选的为准）。 */
export function openImageEditMode(mode) {
    _paintHosts.edit.__neoSetMode(mode);
    _paintHosts.onOpen("edit");
}

/** 预填结果告诉用户复用了哪几项——填进去的必须是面板认得的，少填一项也要说得出原因。
 *  两块输入卡的预填都要等技能 / 模型列表落位，填完的清单是 promise。 */
export function notifyPrefillFilled(filled) {
    if (filled && typeof filled.then === "function") { filled.then(notifyPrefillFilled).catch((e) => console.error("[Gallery] reuse prefill failed:", e)); return; }
    if (!filled?.length) return;
    actionToast({
        severity: "info",
        summary: tf("已复用 {items}", { items: filled.join("、") }),
        detail: t("只填了面板认得、且这一发还能跑的那部分；改完直接点「生成」"),
    });
}
