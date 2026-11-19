/**
 * prompt-library.js — 「提示词库」页宿主（Studio 视图）：一条提示词一张卡，卡片上就是它的封面。
 *
 * 读侧两发都在桌面端自服的能力表里（app/studio_caps.py 的 _PROMPTS：list_prompts 与 prompt_cover），
 * 离线窗口里这一页照读、照看封面；写侧那两发（设封面 / 删提示词）归内核，按 prompt_library_write 门控，
 * 缺时按下去引导启动内核，不留一颗只会 409 的钮。
 * 封面是正文旁边的 sidecar（prompts/custom/<扫描名>.jpg，512px 长边的 JPEG），只有用户点名那一发才写；
 * 出厂预设是代码目录，界面上不铺「设封面 / 删除」，后端同一处也挡（403）。
 * 「填入绘画页 / 填入视频页」走装配层那条现成链（applyToPage），与增强页把回话填回页面是同一发落点。
 */
import { t, tf } from "../js/core/i18n.js";
import { icon } from "../js/core/icons.js";
import { listPrompts, loadPrompt, deletePrompt, promptCoverUrl, setPromptCover } from "../prompt-service.js";
import { isVideoPromptName, promptDisplayName } from "../js/core/preset-picker.js";

const CSS_MARK = "data-neo-prompt-library";

// 组件样式在第一次建视图时注入（幂等）：本模块也会被主画布页的扩展图加载，
// 放在模块顶层会让画布为一份用不上的样式表发一次请求。
function ensureCss() {
    if (typeof document === "undefined") return;
    if (document.querySelector(`style[${CSS_MARK}], link[${CSS_MARK}]`)) return;
    const base = window.comfyAPI?.app?.app?.baseDir || "";
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.type = "text/css";
    css.href = `${base}/extensions/comfyui-neo-studio/prompt-library/prompt-library.css`;
    css.setAttribute(CSS_MARK, "1");
    document.head.appendChild(css);
}

/** 池子与来源的筛选项：池子看扫描名首段（与提示词选择浮层同一份规则），来源看条目带的 source */
export const POOL_FILTERS = ["all", "image", "video"];
export const SOURCE_FILTERS = ["all", "presets", "custom"];
const POOL_LABELS = { all: "全部", image: "图像", video: "视频" };
const SOURCE_LABELS = { all: "全部来源", presets: "预设", custom: "自定义" };

/** 这一条属于哪一池：扫描名首段是 video 落视频池，其余落图像池 */
const poolOf = (name) => (isVideoPromptName(name) ? "video" : "image");

/**
 * 筛出要铺的那一叠：搜索吃显示名与标签，池子与来源各筛一发，最新的排前面（条目带的 _mtime）。
 * 列表里的配方条目（isRecipe）不入池 —— 配方有导演页那一张自己的入口。
 */
export function filterPromptCards(items, { query = "", pool = "all", source = "all" } = {}) {
    const q = String(query || "").trim().toLowerCase();
    const rows = (items || []).filter((it) => {
        const name = String(it?.name || "");
        if (!name || it?.isRecipe) return false;
        if (pool !== "all" && poolOf(name) !== pool) return false;
        if (source !== "all" && it?.source !== source) return false;
        if (!q) return true;
        return promptDisplayName(name).toLowerCase().includes(q)
            || (it?.tags || []).join(" ").toLowerCase().includes(q);
    });
    return rows.sort((a, b) => (b._mtime || 0) - (a._mtime || 0));
}

/** 卡上那两枚徽标：预设 / 自定义 说得清这条改不改得动，图像 / 视频 说得清它给哪一池用 */
export function cardBadges(item) {
    return [
        item?.source === "presets" ? t("预设") : t("自定义"),
        poolOf(item?.name) === "video" ? t("视频") : t("图像"),
    ];
}

/**
 * 建「提示词库」视图。依赖由宿主注入：$el 建 DOM，toast 落提示，can 认能力表（写侧离线不可用），
 * gateRun 把写侧那两枚钮交运行闸门，openMaterial 开素材库取封面，applyToPage 把正文填回绘画页 / 视频页。
 */
export function createPromptLibraryView({ $el, toast, can, gateRun, openMaterial, applyToPage }) {
    return async function buildPrompts(el) {
        ensureCss();
        el.classList.add("ns-prompt-library");

        let items = [];
        let note = "";         // 列表读取失败那一发落在网格上的话
        let armedDelete = "";  // 删除要按两次：这一条已 armed，再按一次才真删
        let query = "";

        const grid = $el("div", { className: "ns-pl-grid" });
        const countEl = $el("span", { className: "ns-pl-count" });
        const search = $el("input", {
            className: "ns-pl-search", type: "text", placeholder: t("搜索提示词与标签…"),
            oninput: (e) => { query = e.target.value; render(); },
        });
        const poolChips = chips(POOL_FILTERS, POOL_LABELS);
        const sourceChips = chips(SOURCE_FILTERS, SOURCE_LABELS);
        const refresh = $el("button", {
            className: "ns-pl-btn", type: "button", title: t("重新读取提示词列表"),
        }, [icon("list", 14)]);
        refresh.onclick = () => loadList();
        el.append($el("div", { className: "ns-pl-bar" },
            [search, poolChips.box, sourceChips.box, countEl, refresh]), grid);

        /** 一排单选筛子：点一颗就把这一排的 is-on 挪过去，选中的值由 value 读 */
        function chips(values, labels) {
            const box = $el("div", { className: "ns-pl-chips" });
            let value = "all";
            for (const v of values) {
                const b = $el("button", { className: "ns-pl-chip is-on", type: "button", textContent: t(labels[v]) });
                b.dataset.value = v;
                b.onclick = () => {
                    value = v;
                    for (const c of box.children) c.classList.toggle("is-on", c.dataset.value === v);
                    render();
                };
                box.appendChild(b);
            }
            return { box, get value() { return value; } };
        }

        function action(iconKey, title, onClick, feature) {
            const b = $el("button", { className: "ns-pl-btn", type: "button", title: t(title) }, [icon(iconKey, 13)]);
            b.onclick = () => onClick(b);
            if (feature) gateRun(b, feature, t(title));
            return b;
        }

        async function textOf(name) {
            const text = String((await loadPrompt(name))?.text || "");
            if (!text.trim()) throw new Error(t("这条提示词是空的"));
            return text;
        }

        async function fillPage(mode, name) {
            try {
                applyToPage(mode, await textOf(name));
                toast(mode === "video" ? t("已填入视频页") : t("已填入绘画页"));
            } catch (e) { toast(`${t("填入失败")}：${e.message || e}`); }
        }

        async function copyText(name) {
            try {
                await navigator.clipboard.writeText(await textOf(name));
                toast(t("提示词已复制"));
            } catch (e) { toast(`${t("复制失败")}：${e.message || e}`); }
        }

        function pickCover(name) {
            // 封面跟着当前这一池走：图像池挑图，视频池挑视频（后端取首帧成图）
            openMaterial(poolChips.value === "video" ? "video" : "image", async (picked) => {
                const src = picked?.[0];
                if (!src?.filename) return;
                const res = await setPromptCover(name, { filename: src.filename, subfolder: src.subfolder || "" });
                toast(res.ok ? t("已设为提示词封面") : res.message);
                if (res.ok) loadList();
            });
        }


        async function removePrompt(name, btn) {
            if (armedDelete !== name) {
                armedDelete = name;
                btn.textContent = t("确认删除");
                btn.title = t("再按一次删除这条提示词与它的封面");
                return;
            }
            try {
                const res = await deletePrompt(name);
                if (!res.ok) throw new Error((await res.text()) || String(res.status));
                armedDelete = "";
                toast(t("已删除提示词"));
                loadList();
            } catch (e) { toast(`${t("删除失败")}：${e.message || e}`); }
        }

        function card(it) {
            const name = String(it.name);
            const shown = promptDisplayName(name);
            const tags = (it.tags || []).slice(0, 3).join(" · ");
            // 有封面就是图，没有就是文本位：正文不在列表里（选中那一发才读），文本位铺名字与标签
            const media = it.cover
                ? $el("div", { className: "ns-pl-media" }, [
                    $el("img", { className: "ns-pl-cover", loading: "lazy", alt: "", src: promptCoverUrl(name, it.cover) }),
                ])
                : $el("div", { className: "ns-pl-media is-text" }, [
                    $el("div", { className: "ns-pl-title", textContent: shown }),
                    $el("div", { className: "ns-pl-tags", textContent: (it.tags || []).slice(0, 4).join(" · ") }),
                ]);
            const writable = it.source !== "presets";
            const delBtn = writable
                ? action("trash", "删除", (b) => removePrompt(name, b), "prompt_library_write")
                : null;
            return $el("div", { className: "ns-pl-card", dataset: { name } }, [
                media,
                $el("div", { className: "ns-pl-foot" }, [
                    $el("div", { className: "ns-pl-name", title: name, textContent: shown }),
                    $el("div", { className: "ns-pl-meta" }, [
                        ...cardBadges(it).map((s) => $el("span", { className: "ns-pl-badge", textContent: s })),
                        ...(tags ? [$el("span", { className: "ns-pl-tagline", textContent: tags })] : []),
                    ]),
                ]),
                $el("div", { className: "ns-pl-actions" }, [
                    action("sparkles", "填入绘画页", () => fillPage("paint", name)),
                    action("film", "填入视频页", () => fillPage("video", name)),
                    action("copy", "复制这条提示词全文", () => copyText(name)),
                    ...(writable ? [action("image", "设为封面", () => pickCover(name), "prompt_library_write")] : []),
                    ...(delBtn ? [delBtn] : []),
                ]),
            ]);
        }

        function render() {
            const rows = filterPromptCards(items, {
                query, pool: poolChips.value, source: sourceChips.value,
            });
            countEl.textContent = tf("{n} 条", { n: rows.length });
            grid.textContent = "";
            if (note) {
                grid.appendChild($el("div", { className: "ns-pl-note", textContent: note }));
                return;
            }
            if (!rows.length) {
                grid.appendChild($el("div", { className: "ns-pl-note",
                    textContent: query ? t("无匹配提示词") : t("提示词库是空的，生成面板里存的提示词会出现在这里") }));
                return;
            }
            armedDelete = "";   // 重画即 disarm：armed 的那一发不能挂到重画后的卡片上
            for (const it of rows) grid.appendChild(card(it));
        }

        async function loadList() {
            grid.textContent = t("加载中…");
            countEl.textContent = "";
            note = "";
            try {
                const list = await listPrompts();
                if (!Array.isArray(list)) {
                    // 桌面端离线时这条接口回来的是 409 的 {offline:true}，不是数组
                    note = list?.offline ? t("提示词列表需要 ComfyUI 运行") : t("提示词列表读取失败");
                }
                items = Array.isArray(list) ? list : [];
            } catch (e) {
                console.error("[Neo Studio] 提示词列表读取失败:", e);
                note = t("提示词列表读取失败");
                items = [];
            }
            render();
        }

        await loadList();
    };
}

