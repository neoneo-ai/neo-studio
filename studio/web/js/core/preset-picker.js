/**
 * preset-picker.js — 提示词选择浮层（绘画页 / 视频页 / 生成素材面板共用）
 * 只列提示词：预设、用户自存与 collections 条目，配方不入池（配方有各自的入口）。
 * kind 决定看哪一池："image" 图像提示词，"video" 视频提示词 —— 归属看扫描名首段（video/ 目录下的都归视频），
 * 与提示词管理页的「图像 / 视频」便签同一条规则，本模块是这条规则在前端的唯一出处。
 * 点一行 = 读该条全文交回调用方填框；× / 点浮层外 / Esc 三条退路都收口到 closePresetPicker。
 * 浮层是挂在按钮下方的下拉（placeUnder），不是居中弹窗。
 */
import { $el } from "../../../../scripts/ui.js";
import { t } from "./i18n.js";
import { listPrompts, loadPrompt, randomPrompts, savePrompt } from "../../prompt-service.js";

/** 视频提示词判定：扫描名带目录前缀，首段是 video（含其子目录）归视频，其余归图像。后端 prompts.py 的 _is_video_prompt 同口径。 */
export function isVideoPromptName(name) {
    return String(name || "").split("/")[0] === "video";
}

/** 行上的名字只去 `video/` 这一段池子标记：浮层与列表已经按池子分了，行上再写一遍是噪音。
 *  子目录那一段留着（`couple/地铁通勤` 标的是这条词在池子里的位置）；键与请求照旧吃扫描名全名，
 *  `load_prompt` / 删除 / 标签索引认的都是 `video/名字`。 */
export function promptDisplayName(name) {
    const raw = String(name || "");
    return (isVideoPromptName(raw) ? raw.split("/").slice(1).join("/") : raw) || raw;
}

const itemName = (item) => (typeof item === "string" ? item : item?.name || "");

// 同时只开一扇：从别的页面再点一次是换作用域，先拆旧的那扇（含它的 Esc 与外关监听）
let opened = null;

/** 关掉提示词浮层；没开着就是空操作。 */
export function closePresetPicker() {
    if (!opened) return;
    document.removeEventListener("keydown", opened.onKey, true);
    document.removeEventListener("pointerdown", opened.onPress, true);
    opened.overlay.remove();
    opened = null;
}

/** 挂在按钮下方那一发：右端对齐按钮右端、上沿贴按钮下沿；下面放不下整块就翻到按钮上方，
 *  两侧各留 8px 不出屏（绘画页 / 视频页那两排都住在页面右上角，右对齐才不会溢出窗口右边）。
 *  列表读完之后才量得到真实高度，所以渲染完还要再量一次。 */
function placeUnder(overlay, anchor) {
    const r = anchor.getBoundingClientRect();
    const w = overlay.offsetWidth;
    const h = overlay.offsetHeight;
    overlay.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - 8 - w))}px`;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    overlay.style.top = `${top}px`;
}

/**
 * 打开提示词选择浮层。kind: "image" | "video"；anchor 是打开它的那颗按钮，浮层挂在它正下方；
 * onPick(text) 在点中一条并读到全文后调用。浮层自挂在 document.body 上，不依赖任何页面结构。
 */
export async function openPresetPicker({ kind = "image", onPick, anchor } = {}) {
    // 再点同一颗按钮 = 收窗：按下那一发不在按钮上收（见 onPress），交到这里由 click 收口
    if (opened && opened.anchor === anchor) { closePresetPicker(); return; }
    closePresetPicker();
    const body = $el("div", { className: "rs-preset-list-body" });
    const search = $el("input", { className: "rs-preset-search-input", type: "text", placeholder: t("搜索提示词…") });
    const overlay = $el("div", {
        // prompts.css 的骨架自带 display:none（提示词管理页自己管显隐），不显式展开就是「点了没窗口」；
        // 层位要盖得住生成素材 / 图片编辑那两层浮窗（9845），这一发由 JS 定，不依赖各页面各自的 CSS；
        // 骨架的居中 transform 在这里抹掉——浮层吃 placeUnder 写的 left/top，住在按钮下方
        className: "rs-preset-list-overlay neo-preset-picker",
        style: { display: "flex", zIndex: 9900, transform: "none" },
    });
    const onKey = (e) => {
        if (e.key !== "Escape") return;
        // capture + 掐断传播：面板自己的「Esc 关窗」不能跟着这一发把窗口一起关掉
        e.stopPropagation();
        e.preventDefault();
        closePresetPicker();
    };
    // 下拉挂在按钮下方，没有遮罩可点：浮层外任何按下都收窗（按下那一发收，比 click 早，
    // 不会把「点开素材库」这类同一次点击带着浮层一起跑）。按钮本身让开，那一发由 click 走收窗
    const onPress = (e) => {
        if (!opened || opened.overlay.contains(e.target) || anchor.contains(e.target)) return;
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
        const shown = items.filter((it) => !q || promptDisplayName(itemName(it)).toLowerCase().includes(q));
        if (!shown.length) {
            // 读取失败与词库真空是两件事：离线那一发必须点明「要 ComfyUI 在跑」，不能被一句「暂无可用提示词」盖过去
            body.appendChild($el("div", { className: "neo-preset-picker-empty", textContent: note || (q ? t("无匹配提示词") : t("暂无可用提示词")) }));
            return;
        }
        for (const it of shown) {
            const key = itemName(it);   // 扫描名是键：读正文、删除、标签索引都认它
            body.appendChild($el("div", { className: "rs-preset-item", dataset: { name: key }, onclick: () => choose(key) }, [
                $el("span", { className: "rs-preset-content", textContent: promptDisplayName(key) }),
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
    document.body.appendChild(overlay);
    opened = { overlay, onKey, onPress, anchor };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPress, true);
    placeUnder(overlay, anchor);
    body.textContent = t("加载中…");
    try {
        const list = await listPrompts();
        if (!Array.isArray(list)) {
            // 桌面端离线时这条接口回来的是 409 的 {offline:true}，不是数组：说清楚这一发要 ComfyUI 在跑
            note = list?.offline ? t("提示词列表需要 ComfyUI 运行") : t("提示词列表读取失败");
        } else {
            items = list.filter((it) => !it?.isRecipe && isVideoPromptName(itemName(it)) === (kind === "video"));
        }
    } catch (e) {
        console.error("[Neo Studio] 提示词列表读取失败:", e);
        note = t("提示词列表读取失败");
    }
    render(items, "", note);
    placeUnder(overlay, anchor);   // 列表落定才量得到真实高度：下面放得下就不动，放不下这一发翻到按钮上方
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
    if (!Array.isArray(res?.texts) && res?.offline) throw new Error(t("提示词与随机需要 ComfyUI 运行"));
    return (res?.texts || [])[0] || "";
}

/**
 * 把面板里那句提示词存进指定池子：kind="video" 走 `video/` 前缀（custom/video/，与本页「提示词」「随机」
 * 同一池），其余落图像池（custom/ 根层）。用户打头的 video/ 段先剥掉，池子只由 kind 定；
 * 名字按后端同一套清洗（字母数字与空格 / 下划线 / 连字符）。同名不覆盖，后端自动加 -1 序号。
 * 返回存下去的名字（就是提示词管理页与这条规则的扫描名）。
 */
export async function savePromptTo(kind, name, text) {
    const clean = String(name || "").replace(/^presets\//, "").replace(/^video\//, "")
        .replace(/[^\p{L}\p{N} _-]/gu, "").trim();
    if (!clean) throw new Error(t("要先给这条提示词起个名字"));
    const saved = kind === "video" ? `video/${clean}` : clean;
    const res = await savePrompt(saved, text);
    const body = await res.text();
    let payload = null;
    try { payload = JSON.parse(body); } catch { /* 成功那一发后端回的是纯文本 OK */ }
    if (!res.ok) {
        // 保存是写侧，不在桌面端自服的提示词读侧表里：离线那一发就是没有这条接口
        throw new Error(payload?.offline || res.status === 409 ? t("保存提示词需要 ComfyUI 运行") : t("提示词保存失败"));
    }
    return saved;
}
