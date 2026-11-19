/**
 * prompt-library.js — 「提示词库」页宿主（Studio 视图）：一条提示词一张卡，卡上铺封面、正文摘要与动作。
 *
 * 读侧三发都在桌面端自服的能力表里（app/studio_caps.py 的 _PROMPTS：list_prompts、prompt_cover 与
 * prompt_previews），离线窗口里这一页照读、照看封面、照铺摘要；写侧那两发（设封面 / 删提示词）归内核，
 * 按 prompt_library_write 门控，缺时按下去引导启动内核，不留一颗只会 409 的钮。
 * 封面是正文旁边的 sidecar（prompts/custom/<扫描名>.jpg，512px 长边的 JPEG），只有用户点名那一发才写；
 * 出厂预设是代码目录，界面上不铺「设封面 / 删除」，后端同一处也挡（403）。
 * 卡片上的正文摘要按页批量取（一次最多那一页的条数），整篇正文仍是「填入 / 复制」那一发才读。
 * 「填入绘画页 / 填入视频页」走装配层那条现成链（applyToPage），与增强页把回话填回页面是同一发落点。
 * 「设为封面」开素材库时先铺这条的出图搜索词：窗里那几条就是用它生成过的产物，清空那一格才看全部。
 */
import { t, tf } from "../js/core/i18n.js";
import { icon } from "../js/core/icons.js";
import { listPrompts, listPromptPreviews, loadPrompt, deletePrompt, promptCoverUrl, setPromptCover, cloudPreviewUrl, cloudDirCoverUrl } from "../prompt-service.js";
import { isVideoPromptName, promptDisplayName } from "../js/core/preset-picker.js";

const CSS_MARK = "data-neo-prompt-library";

// 一屏 24 张卡：三列八行的密度，摘要那一发的批量就夹在这一页的条数里（服务端同一口径夹上限）
export const PAGE_SIZE = 24;

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
 * 卡片要自动播的那一发预览：视频池的条目、云端那条带预览的媒体、有封面当 poster，缺一就不铺预览。
 * 预览是发布时 --preview 压的 480p 静音片；没配上对的条目这一位就是封面图。
 */
export function cloudPreviewMedia(item) {
    const media = item?.media;
    if (!media?.filename || media.type !== "video" || !media.preview) return null;
    if (poolOf(String(item?.name || "")) !== "video") return null;
    return item.cover ? media : null;
}

/**
 * 卡片那张图的地址：云端那条媒体是这条提示词真正的产物，图像媒体直接铺那张图（缩略图代理 512px）；
 * 没有媒体才看正文旁边的封面 sidecar，随包预设没有 sidecar 时再拿云端目录那张封面补一张
 * （条目带的 dir_cover，见 _attach_cloud_dir_covers）；一样都没有就不铺图位。
 */
export function cardCoverSrc(item) {
    const media = item?.media;
    if (media?.filename && media.type === "image") return cloudDirCoverUrl(media);
    if (item?.cover) return promptCoverUrl(String(item.name), item.cover);
    return item?.dir_cover?.filename ? cloudDirCoverUrl(item.dir_cover) : null;
}

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

/** 页码那一排：最多铺五枚页码，出界时补上首页 / 末页与「…」 */
export function pageWindow(current, total) {
    if (total <= 1) return [1];
    const from = Math.max(1, Math.min(current - 2, total - 4));
    const to = Math.min(total, from + 4);
    const rows = [];
    if (from > 1) rows.push(1, "…");
    for (let p = from; p <= to; p++) rows.push(p);
    if (to < total) rows.push("…", total);
    return rows;
}

/** 卡上那句「多久前」：吃列表条目自带的文件时间，只到「月」这一档，分钟级对这一页没有意义 */
export function agoText(mtime) {
    const days = Math.floor((Date.now() / 1000 - Number(mtime || 0)) / 86400);
    if (days <= 0) return t("今天");
    if (days === 1) return t("昨天");
    if (days < 30) return tf("{n} 天前", { n: days });
    return tf("{n} 个月前", { n: Math.floor(days / 30) });
}

// 素材库取用窗的搜索框吃的是产物旁车首行——生成时那句提示词（读端只吃副文件前 500 字）。
// 封面要在这条自己的出图里挑，就把正文首行当前缀铺进那一格：出过图的落进来，清空那一格照旧看全部素材
export const COVER_SEARCH_CHARS = 60;

/** 这条的出图搜索词：正文首行（旁车首行就是正文的第一行），夹到副文件读得到的长度里 */
export function coverSearchTerm(text) {
    return String(text || "").split("\n")[0].trim().slice(0, COVER_SEARCH_CHARS);
}

/** 建「提示词库」视图。依赖由宿主注入：$el 建 DOM，toast 落提示，can 认能力表（写侧离线不可用），
 * gateRun 把写侧那两枚钮交运行闸门，openMaterial 开素材库取封面（带这条的出图搜索词），
 * applyToPage 把正文填回绘画页 / 视频页。
 */
export function createPromptLibraryView({ $el, toast, can, gateRun, openMaterial, applyToPage }) {
    return async function buildPrompts(el) {
        ensureCss();
        el.classList.add("ns-prompt-library");

        let items = [];
        let note = "";         // 列表读取失败那一发落在网格上的话
        let armedDelete = "";  // 删除要按两次：这一条已 armed，再按一次才真删
        let query = "";
        let page = 0;                        // 当前那一页：搜索与筛子一动就回首页
        const previews = new Map();          // 扫描名 → {mtime, text}：只活在这一页的闭包里，页卸载即散

        const grid = $el("div", { className: "ns-pl-grid" });
        const pager = $el("div", { className: "ns-pl-pager" });
        const countEl = $el("span", { className: "ns-pl-count" });
        // 卡片预览进视野才挂 src：一屏十几条视频，同时挂着就是十几路解码一起抢这一发带宽
        const previewObserver = typeof IntersectionObserver === "function"
            ? new IntersectionObserver((rows) => {
                for (const row of rows) {
                    if (row.isIntersecting) {
                        if (!row.target.src) row.target.src = row.target.dataset.src;
                        row.target.play()?.catch(() => { });
                    } else row.target.pause?.();
                }
            }, { root: grid, threshold: 0.4 })
            : null;
        const search = $el("input", {
            className: "ns-pl-search", type: "text", placeholder: t("搜索提示词与标签…"),
            oninput: (e) => { query = e.target.value; page = 0; render(); },
        });
        const poolChips = chips(POOL_FILTERS, POOL_LABELS);
        const sourceChips = chips(SOURCE_FILTERS, SOURCE_LABELS);
        const refresh = $el("button", {
            className: "ns-pl-btn", type: "button", title: t("重新读取提示词列表"),
        }, [icon("list", 14)]);
        refresh.onclick = () => loadList();
        el.append(
            $el("div", { className: "ns-pl-top" }, [
                $el("h2", { className: "ns-pl-h1", textContent: t("提示词库") }),
                countEl, refresh,
            ]),
            $el("div", { className: "ns-pl-bar" }, [search, poolChips.box, sourceChips.box]),
            grid, pager);

        /** 一排单选筛子：点一颗就把这一排的 is-on 挪过去，选中的值由 value 读 */
        function chips(values, labels) {
            const box = $el("div", { className: "ns-pl-chips" });
            let value = "all";
            for (const v of values) {
                const b = $el("button", { className: "ns-pl-chip is-on", type: "button", textContent: t(labels[v]) });
                b.dataset.value = v;
                b.onclick = () => {
                    value = v;
                    page = 0;
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

        async function pickCover(name) {
            // 先读这条的正文：素材库靠它筛出这条自己的出图，正文读不到就不开窗
            let term;
            try { term = coverSearchTerm(await textOf(name)); }
            catch (e) { toast(`${t("封面设置失败")}：${e.message || e}`); return; }
            // 封面跟着当前这一池走：图像池挑图，视频池挑视频（后端取首帧成图）
            openMaterial(poolChips.value === "video" ? "video" : "image", async (picked) => {
                const src = picked?.[0];
                if (!src?.filename) return;
                const res = await setPromptCover(name, { filename: src.filename, subfolder: src.subfolder || "" });
                toast(res.ok ? t("已设为提示词封面") : res.message);
                if (res.ok) loadList();
            }, term);
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
            const writable = it.source !== "presets";
            const kids = [];
            // 封面那一档只在有条目可铺时铺：512px 长边的 sidecar 直接进 <img>，浏览器只做等比裁切
            // 视频池里配上对云端媒体的那一条换 480p 预览自动播，poster 仍是这张封面
            const preview = cloudPreviewMedia(it);
            const coverSrc = cardCoverSrc(it);
            if (coverSrc) {
                kids.push($el("div", { className: "ns-pl-media" }, [
                    preview
                        ? previewVideo(it, preview, coverSrc)
                        : coverImage(coverSrc),
                ]));
            }
            kids.push($el("div", { className: "ns-pl-head" }, [
                $el("div", { className: "ns-pl-name", title: name, textContent: shown }),
                $el("div", { className: "ns-pl-badges" },
                    cardBadges(it).map((s) => $el("span", { className: "ns-pl-badge", textContent: s }))),
            ]));
            // 摘要位先空着：正文按页那一发回来才填，:empty 把这一位整位收掉，卡片落名字与标签
            kids.push($el("div", { className: "ns-pl-excerpt", textContent: previews.get(name)?.text || "" }));
            const tags = (it.tags || []).slice(0, 3);
            if (tags.length) {
                kids.push($el("div", { className: "ns-pl-tags" },
                    tags.map((s) => $el("span", { className: "ns-pl-tag", textContent: s }))));
            }
            kids.push($el("div", { className: "ns-pl-foot" }, [
                $el("span", { className: "ns-pl-src",
                    textContent: `${writable ? t("自定义") : t("预设")} · ${agoText(it._mtime)}` }),
                $el("div", { className: "ns-pl-actions" }, [
                    action("sparkles", "填入绘画页", () => fillPage("paint", name)),
                    action("film", "填入视频页", () => fillPage("video", name)),
                    action("copy", "复制这条提示词全文", () => copyText(name)),
                    ...(writable ? [action("image", "设为封面", () => pickCover(name), "prompt_library_write")] : []),
                    ...(writable ? [action("trash", "删除", (b) => removePrompt(name, b), "prompt_library_write")] : []),
                ]),
            ]));
            return $el("div", { className: "ns-pl-card", dataset: { name } }, kids);
        }

        /** 封面取不到就换一个缓存键重取一次：`v=` 是封面 mtime，长周期缓存把 ComfyUI 重启窗口里
         *  那次失败的响应钉在原 URL 上，浏览器不再发请求，卡片便一直空着。查询参数一变就是新的
         *  缓存键，浏览器必须重新取图。第二次仍失败连图位一起收掉——只摘 <img> 的话，
         *  `.ns-pl-media` 那 150px 的 raised 底色就是一段谁都不认得的空档。 */
        function coverImage(src) {
            const img = $el("img", { className: "ns-pl-cover", loading: "lazy", alt: "", src });
            img.onerror = () => {
                if (img.dataset.probed) { (img.parentElement || img).remove(); return; }
                img.dataset.probed = "1";
                img.setAttribute("src", `${src}${src.includes("?") ? "&" : "?"}r=${Date.now()}`);
            };
            return img;
        }

        /** 预览位：<video> 先只带 poster，src 由视野观察者挂上；要少动效的用户就停在封面上 */
        function previewVideo(it, media, poster) {
            const video = $el("video", {
                className: "ns-pl-preview",
                poster,
                preload: "none",
                autoplay: true,
            });
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.setAttribute("playsinline", "");
            if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches)
                return video;
            video.dataset.src = cloudPreviewUrl(media);
            previewObserver?.observe(video);
            return video;
        }

        /** 摘要按页取：只发这一页缺的那几个名字，回填只落在还挂在网格上的那张卡 */
        async function fillPreviews(rows) {
            const stamps = new Map();
            const missing = [];
            for (const it of rows) {
                const name = String(it.name);
                stamps.set(name, it._mtime);
                if (previews.get(name)?.mtime === it._mtime) continue;
                if (missing.length < 32) missing.push(name);   // 与服务端那一发的上限同口径
            }
            if (!missing.length) return;
            const got = await listPromptPreviews(missing);
            if (!Object.keys(got || {}).length) return;
            const slots = new Map();
            for (const cardEl of grid.children) {
                if (cardEl.classList?.contains("ns-pl-card")) slots.set(cardEl.dataset.name, cardEl);
            }
            for (const [name, text] of Object.entries(got)) {
                previews.set(name, { mtime: stamps.get(name), text });
                const slot = slots.get(name)?.querySelector(".ns-pl-excerpt");
                if (slot) slot.textContent = text;
            }
        }

        function render() {
            previewObserver?.disconnect();   // 重画即换卡：旧卡上的观察者不留
            const rows = filterPromptCards(items, {
                query, pool: poolChips.value, source: sourceChips.value,
            });
            const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
            page = Math.min(page, pages - 1);
            const shown = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
            countEl.textContent = tf("{n} 条", { n: rows.length });
            grid.textContent = "";
            pager.textContent = "";
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
            for (const it of shown) grid.appendChild(card(it));
            renderPager(pages);
            fillPreviews(shown);
        }

        /** 页码那一排：首末箭头吃边界，页码吃当前那一页；换页把网格滚回顶 */
        function renderPager(pages) {
            if (pages <= 1) return;
            pager.appendChild(edgeBtn("‹", "上一页", page > 0, () => { page -= 1; render(); grid.scrollTop = 0; }));
            for (const p of pageWindow(page + 1, pages)) {
                if (p === "…") {
                    pager.appendChild($el("span", { className: "ns-pl-dots", textContent: "…" }));
                    continue;
                }
                const b = $el("button", { className: "ns-pl-page", type: "button", textContent: String(p) });
                if (p === page + 1) b.classList.add("is-on");
                b.onclick = () => { page = p - 1; render(); grid.scrollTop = 0; };
                pager.appendChild(b);
            }
            pager.appendChild(edgeBtn("›", "下一页", page < pages - 1, () => { page += 1; render(); grid.scrollTop = 0; }));
            pager.appendChild($el("span", { className: "ns-pl-pages",
                textContent: tf("第 {a} / {b} 页", { a: page + 1, b: pages }) }));
        }

        function edgeBtn(glyph, label, enabled, onClick) {
            const b = $el("button", { className: "ns-pl-page is-edge", type: "button",
                textContent: glyph, "aria-label": t(label) });
            b.disabled = !enabled;
            b.onclick = onClick;
            return b;
        }

        async function loadList() {
            grid.textContent = t("加载中…");
            countEl.textContent = "";
            pager.textContent = "";
            note = "";
            page = 0;
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

