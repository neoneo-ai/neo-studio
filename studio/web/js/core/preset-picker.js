/**
 * preset-picker.js — 预设提示词选择浮层（绘画页 / 视频页 / 生成素材面板共用）
 * 只列提示词：预设、用户自存与 collections 条目，配方不入池（配方有各自的入口）。
 * kind 决定看哪一池："image" 图像提示词，"video" 视频提示词 —— 归属看扫描名首段（video/ 目录下的都归视频），
 * 与提示词管理页的「图像 / 视频」便签同一条规则，本模块是这条规则在前端的唯一出处。
 * 点一行 = 读该条全文交回调用方填框；× / 点遮罩 / Esc 三条退路都收口到 closePresetPicker。
 */
import { $el } from "../../../../scripts/ui.js";
import { t } from "./i18n.js";
import { listPrompts, loadPrompt, randomPrompts } from "../../prompt-service.js";

/** 视频提示词判定：扫描名带目录前缀，首段是 video（含其子目录）归视频，其余归图像。后端 prompts.py 的 _is_video_prompt 同口径。 */
export function isVideoPromptName(name) {
    return String(name || "").split("/")[0] === "video";
}

const itemName = (item) => (typeof item === "string" ? item : item?.name || "");

// 同时只开一扇：从别的页面再点一次是换作用域，先拆旧的那扇（含它的 Esc 监听）
let opened = null;

/** 关掉预设浮层；没开着就是空操作。 */
export function closePresetPicker() {
    if (!opened) return;
    document.removeEventListener("keydown", opened.onKey, true);
    opened.overlay.remove();
    opened = null;
}

/**
 * 打开预设选择浮层。kind: "image" | "video"；onPick(text) 在点中一条并读到全文后调用。
 * 浮层自挂在 document.body 上，不依赖任何页面结构。
 */
export async function openPresetPicker({ kind = "image", onPick } = {}) {
    closePresetPicker();
    const body = $el("div", { className: "rs-preset-list-body" });
    const search = $el("input", { className: "rs-preset-search-input", type: "text", placeholder: t("搜索预设…") });
    const overlay = $el("div", {
        // prompts.css 的骨架自带 display:none（提示词管理页自己管显隐），不显式展开就是「点了没窗口」；
        // 层位要盖得住生成素材 / 图片编辑那两层浮窗（9845），这一发由 JS 定，不依赖各页面各自的 CSS
        className: "rs-preset-list-overlay neo-preset-picker",
        style: { display: "flex", zIndex: 9900 },
    });
    const onKey = (e) => {
        if (e.key !== "Escape") return;
        // capture + 掐断传播：面板自己的「Esc 关窗」不能跟着这一发把窗口一起关掉
        e.stopPropagation();
        e.preventDefault();
        closePresetPicker();
    };
    const choose = async (name) => {
        try {
            const data = await loadPrompt(name);
            closePresetPicker();
            onPick?.(data.text || "");
        } catch (e) {
            console.error("[Neo Studio] 预设读取失败:", e);
        }
    };
    const render = (items, query, note) => {
        body.textContent = "";
        const q = (query || "").trim().toLowerCase();
        const shown = items.filter((it) => !q || itemName(it).toLowerCase().includes(q));
        if (!shown.length) {
            // 读取失败与词库真空是两件事：离线那一发必须点明「要 ComfyUI 在跑」，不能被一句「暂无可用提示词」盖过去
            body.appendChild($el("div", { className: "neo-preset-picker-empty", textContent: note || (q ? t("无匹配预设") : t("暂无可用提示词")) }));
            return;
        }
        for (const it of shown) {
            body.appendChild($el("div", { className: "rs-preset-item", onclick: () => choose(itemName(it)) }, [
                $el("span", { className: "rs-preset-content", textContent: itemName(it) }),
                $el("span", { className: "rs-source-badge", textContent: it.source === "presets" ? t("预设") : t("自定义") }),
            ]));
        }
    };
    let items = [];
    let note = "";
    overlay.append(
        $el("div", { className: "rs-preset-header" }, [
            search,
            $el("span", { className: "neo-preset-picker-scope", textContent: kind === "video" ? t("视频提示词") : t("图像提示词") }),
            $el("button", { className: "rs-preset-close", type: "button", title: t("关闭（Esc）"), textContent: "×" }),
        ]),
        body,
    );
    overlay.querySelector(".rs-preset-close").addEventListener("click", closePresetPicker);
    search.addEventListener("input", () => render(items, search.value, note));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closePresetPicker(); });
    document.body.appendChild(overlay);
    opened = { overlay, onKey };
    document.addEventListener("keydown", onKey, true);
    body.textContent = t("加载中…");
    try {
        const list = await listPrompts();
        if (!Array.isArray(list)) {
            // 桌面端离线时这条接口回来的是 409 的 {offline:true}，不是数组：说清楚这一发要 ComfyUI 在跑
            note = list?.offline ? t("预设列表需要 ComfyUI 运行") : t("预设列表读取失败");
        } else {
            items = list.filter((it) => !it?.isRecipe && isVideoPromptName(itemName(it)) === (kind === "video"));
        }
    } catch (e) {
        console.error("[Neo Studio] 预设列表读取失败:", e);
        note = t("预设列表读取失败");
    }
    render(items, "", note);
    search.focus();
}

/**
 * 随机取一条提示词：kind 选池子（"image" 排除 video 目录、"video" 只取它们，与后端同口径）。
 * 返回文本；抽不到（池子为空）返回空串，由调用方把「词库为空」说给用户；桌面端离线那一发直接抛错，
 * 让调用方把「需要 ComfyUI 在跑」说给用户。
 */
export async function randomPromptText(kind = "image") {
    const res = await randomPrompts(1, kind);
    // 桌面端离线那一发不是词库空：409 的 {offline:true} 要直说，不能让调用方报「提示词库为空」
    if (!Array.isArray(res?.texts) && res?.offline) throw new Error(t("预设与随机需要 ComfyUI 运行"));
    return (res?.texts || [])[0] || "";
}
