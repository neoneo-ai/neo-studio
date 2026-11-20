/**
 * prompt-library.js — 「提示词库」页宿主（Studio 视图）：一条提示词一张卡，卡上铺封面、正文摘要与动作。
 *
 * 读侧三发都在桌面端自服的能力表里（app/studio_caps.py 的 _PROMPTS：list_prompts、prompt_cover 与
 * prompt_previews），离线窗口里这一页照读、照看封面、照铺摘要；写侧那两发（设封面 / 删提示词）归内核，
 * 按 prompt_library_write 门控，缺时按下去引导启动内核，不留一颗只会 409 的钮。
 * 封面是正文旁边的 sidecar（prompts/custom/<扫描名>.jpg，512px 长边的 JPEG），只有用户点名那一发才写；
 * 出厂预设是代码目录，界面上不铺「设封面 / 删除」，后端同一处也挡（403）。
 * 卡片上的正文摘要按页批量取（一次最多那一页的条数），整篇正文仍是「填入 / 复制」那一发才读。
 * 筛子条一排是池子、来源、排序与标签词表（排序吃条目自己的文件时间，标签词表从条目标签的频次来），
 * 一屏 24 张卡，滚到底那一发才追加下一屏；列表到位之前网格铺一屏骨架卡。
 * 标题行行尾那枚「刷新」先把云端索引（主索引 + 逐目录索引）整片强制重拉，再重读列表：卡片上的云端图
 * 与预览配对只读磁盘上那份目录索引缓存，不发这一发，云端刚发布的卡可以整天不动。
 * 「填入绘画页 / 填入视频页」走装配层那条现成链（applyToPage），与增强页把回话填回页面是同一发落点。
 * 「设为封面」开素材库时先铺这条的出图搜索词：窗里那几条就是用它生成过的产物，清空那一格才看全部。
 */
import { t, tf } from "../js/core/i18n.js";
import { icon, setIconLabel } from "../js/core/icons.js";
import { listPrompts, listPromptPreviews, loadPrompt, deletePrompt, promptCoverUrl, setPromptCover, cloudPreviewUrl, cloudMediaUrl, cloudDirCoverUrl, galleryImageUrl, coverMediaSrc, syncCloudIndex } from "../prompt-service.js";
import { isVideoPromptName, promptDisplayName } from "../js/core/preset-picker.js";
import { attachMasonry } from "../gallery-masonry.js";
import { Lightbox } from "../lightbox.js";

const CSS_MARK = "data-neo-prompt-library";

// 一屏 24 张卡：滚到底才追加下一屏，摘要那一发的批量也夹在这一屏的条数里（服务端同一口径夹上限）
export const PAGE_SIZE = 24;

// 瀑布流的列宽：素材页那一份装箱（web/gallery-masonry.js）认的是定宽列，卡片不随页宽拉伸
export const CARD_COLUMN_WIDTH = 230;
// 媒体位高度夹档：横版裁到 3/4 卡宽，竖版整宽最长 2 倍卡宽（9:16 整幅进位，长截图不铺成长条）
const MEDIA_HEIGHT_FLOOR = 0.75;
const MEDIA_HEIGHT_CEIL = 2;

// 目录封面那条是图才认它有一个可放大的本体：视频目录的封面是索引里那一帧，本体不是图
const IMAGE_COVER_SUFFIXES = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff"]);

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

// 排序与标签筛子：条目只有文件时间与标签，所以排序只有这三档、标签筛子从条目自己的标签里来。
// 热度、作者、点赞那一排控件在 prompts.chat 靠云端数据，这一页没有这些数据，界面就不铺。
export const SORT_FILTERS = ["new", "old", "name"];
export const TAG_FILTER_LIMIT = 14;
const SORT_LABELS = { new: "最新", old: "最早", name: "名称" };

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
 * 卡片要自动播的那一发预览，两条来源都认，认不出一条就不铺预览位（卡片落一张静封面）：
 * 云端预设走发布时 --preview 压的 480p 静音片；自定义那条走封面旁边那条指针指的本地成片
 * （list_prompts 的 cover_media，写侧见 prompt_names.write_cover_source）。
 * 预览永远带着封面当 poster —— 两条链都只在封面已经在卡上时才铺预览。
 * `original` 是同一发的本体：云端那条去掉 preview=1，本地成片本来就是本体；卡片要 480p，灯箱要原片。
 */
export function cardPreviewMedia(item) {
    const cloud = cloudPreviewMedia(item);
    if (cloud) return { media: cloud, src: cloudPreviewUrl(cloud), original: cloudMediaUrl(cloud) };
    const local = item?.cover_media;
    // 指针说这张封面就是那条视频截出来的，就播它：图像池的提示词一样能有一张会动的封面。
    // 池子筛子只筛列表，不决定一张封面的来路——来路是「设为封面」那一步记进指针的
    if (item?.cover && local?.kind === "video") {
        const src = coverMediaSrc(local);
        return { media: local, src, original: src };
    }
    return null;
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
 * 灯箱里那一张：来路与卡片那一格一一相对，只把「缩着的那一份」换成本体。
 * 云端媒体那条走媒体本体路由（云端目录里发布的是整图，卡片要的 512 是同一张的缩略图）；
 * 封面指针说这张封面缩自素材库某张产物，就放大那张产物；指针是视频时这条走的是预览那条链
 * （见 lightboxItem），落不到这里；目录封面那条是视频（一帧封面）时没有图本体，照放那张缩略图。
 * 三条来路都没有才是正文旁边那张 sidecar。
 */
export function cardOriginalSrc(item) {
    const media = item?.media;
    if (media?.filename && media.type === "image") return galleryImageUrl(media);
    const pointer = item?.cover_media;
    if (item?.cover && pointer?.filename && pointer.kind === "image") return galleryImageUrl(pointer);
    if (item?.cover) return promptCoverUrl(String(item.name), item.cover);
    const dirCover = item?.dir_cover;
    if (!dirCover?.filename) return null;
    return IMAGE_COVER_SUFFIXES.has(dirCover.filename.slice(dirCover.filename.lastIndexOf(".")).toLowerCase())
        ? galleryImageUrl(dirCover) : cloudDirCoverUrl(dirCover);
}

/**
 * 筛出要铺的那一叠：搜索吃显示名与标签，池子、来源与标签各筛一发，筛完交 sortPromptCards 排。
 * 列表里的配方条目（isRecipe）不入池 —— 配方有导演页那一张自己的入口。
 */
export function filterPromptCards(items, { query = "", pool = "all", source = "all", tag = "all", sort = "new" } = {}) {
    const q = String(query || "").trim().toLowerCase();
    const rows = (items || []).filter((it) => {
        const name = String(it?.name || "");
        if (!name || it?.isRecipe) return false;
        if (pool !== "all" && poolOf(name) !== pool) return false;
        if (source !== "all" && it?.source !== source) return false;
        if (tag !== "all" && !(it?.tags || []).includes(tag)) return false;
        if (!q) return true;
        return promptDisplayName(name).toLowerCase().includes(q)
            || (it?.tags || []).join(" ").toLowerCase().includes(q);
    });
    return sortPromptCards(rows, sort);
}

/** 排这一叠：默认最新的在前（条目带的 _mtime），最早与名称是筛子条上那一排的另一发 */
export function sortPromptCards(rows, sort = "new") {
    const list = (rows || []).slice();
    if (sort === "old") return list.sort((a, b) => (a._mtime || 0) - (b._mtime || 0));
    if (sort === "name") {
        return list.sort((a, b) =>
            promptDisplayName(String(a?.name)).localeCompare(promptDisplayName(String(b?.name)), "zh-Hans-CN"));
    }
    return list.sort((a, b) => (b._mtime || 0) - (a._mtime || 0));
}

/** 标签筛子的词表：按出现次数从多到少，次数相同保持条目里的先后（Array#sort 稳定）；只铺前 limit 颗 */
export function topTags(items, limit = TAG_FILTER_LIMIT) {
    const count = new Map();
    for (const it of items || []) {
        for (const tag of (it?.tags || [])) count.set(tag, (count.get(tag) || 0) + 1);
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([tag]) => tag);
}

/** 卡上那两枚徽标：预设 / 自定义 说得清这条改不改得动，图像 / 视频 说得清它给哪一池用 */
export function cardBadges(item) {
    return [
        item?.source === "presets" ? t("预设") : t("自定义"),
        poolOf(item?.name) === "video" ? t("视频") : t("图像"),
    ];
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

/** 卡片标题只写名字本身：这一页顶部有池子筛子，标题里再写一遍目录段就是白占一行。
 *  整条扫描名在这张卡的 `title` 上，搜索照旧吃带目录段的全名。 */
function cardTitle(name) {
    const parts = promptDisplayName(name).split("/");
    return parts[parts.length - 1] || String(name || "");
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
        let tag = "all";                     // 标签筛子选中那一发
        let shown = 0;                       // 已铺进网格的条数：滚到底才追加下一屏
        const previews = new Map();          // 扫描名 → {mtime, text}：只活在这一页的闭包里，页卸载即散

        const body = $el("div", { className: "ns-pl-body" });
        const grid = $el("div", { className: "ns-pl-grid" });
        const noteEl = $el("div", { className: "ns-pl-note" });   // 空池 / 读取失败那句话落在网格之外：瀑布流只装箱卡片
        const moreEl = $el("div", { className: "ns-pl-more" });   // 底部那一行：还有下一屏是「载入更多…」，铺完是「已全部 N 条」
        body.append(grid, noteEl, moreEl);
        attachMasonry(grid, CARD_COLUMN_WIDTH);
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
            }, { root: body, threshold: 0.4 })
            : null;
        // 滚到底那一发才追加下一屏：观察者吃这一页自己的滚动容器，底部那一行进视野就补一屏
        const moreObserver = typeof IntersectionObserver === "function"
            ? new IntersectionObserver((entries) => {
                if (entries.some((e) => e.isIntersecting)) appendMore();
            }, { root: body, rootMargin: "300px 0px" })
            : null;
        moreObserver?.observe(moreEl);
        const search = $el("input", {
            className: "ns-pl-search", type: "text", placeholder: t("搜索提示词与标签…"),
            oninput: (e) => { query = e.target.value; render(); body.scrollTop = 0; },
        });
        const poolChips = chips(POOL_FILTERS, POOL_LABELS);
        const sourceChips = chips(SOURCE_FILTERS, SOURCE_LABELS);
        const sortChips = chips(SORT_FILTERS, SORT_LABELS);
        const tagBox = $el("div", { className: "ns-pl-chips ns-pl-tagbox" });   // 词表随这一份列表铺，重新读取才重铺
        // 刷新是一发动作，图标旁要有字（图标 + 文案那枚钮走 icons.js 的 setIconLabel）：
        // 这一位在顶栏行尾，纯图标会被读成列表控件
        const refresh = $el("button", {
            className: "ns-pl-btn ns-pl-refresh", type: "button",
            title: t("重拉云端预设索引并重读提示词列表"),
        });
        setIconLabel(refresh, "refresh", t("刷新"), 14);
        refresh.onclick = () => refreshAll();
        el.append(
            $el("div", { className: "ns-pl-top" }, [
                $el("h2", { className: "ns-pl-h1", textContent: t("提示词库") }),
                countEl, refresh,
            ]),
            $el("div", { className: "ns-pl-bar" }, [search, poolChips.box, sourceChips.box, sortChips.box, tagBox]),
            body);

        /** 一排单选筛子：点一颗就把这一排的 is-on 挪过去，选中的值由 value 读 */
        function chips(values, labels) {
            const box = $el("div", { className: "ns-pl-chips" });
            let value = "all";
            for (const v of values) {
                const b = $el("button", {
                    className: "ns-pl-chip is-on", type: "button", textContent: t(labels[v]),
                    "aria-pressed": "true",
                });
                b.dataset.value = v;
                b.onclick = () => {
                    value = v;
                    for (const c of box.children) {
                        const on = c.dataset.value === v;
                        c.classList.toggle("is-on", on);
                        c.setAttribute("aria-pressed", String(on));
                    }
                    render();
                    body.scrollTop = 0;   // 换筛子就是换了一叠：滚在下面的视口留在空档上
                };
                box.appendChild(b);
            }
            return { box, get value() { return value; } };
        }

        /** 标签筛子：词表从这一份列表的标签里来，点一颗就只留带那一发的条目。
         *  词表只有一颗标签就不铺这一排——一颗筛子筛不出任何东西 */
        function renderTagChips(rows) {
            tagBox.textContent = "";
            tag = "all";
            const words = topTags(rows);
            if (words.length < 2) return;
            for (const w of ["all", ...words]) {
                const on = w === "all";
                const b = $el("button", {
                    className: "ns-pl-chip" + (on ? " is-on" : ""),
                    type: "button", textContent: w === "all" ? t("全部标签") : w,
                    "aria-pressed": String(on),
                });
                b.dataset.value = w;
                b.onclick = () => {
                    tag = w;
                    for (const c of tagBox.children) {
                        const hit = c.dataset.value === w;
                        c.classList.toggle("is-on", hit);
                        c.setAttribute("aria-pressed", String(hit));
                    }
                    render();
                    body.scrollTop = 0;
                };
                tagBox.appendChild(b);
            }
        }

        /** 列表到位之前铺一屏卡形占位：瀑布流先有一屏的形状，比一句「加载中…」更说得清在等什么 */
        function skeleton() {
            grid.textContent = "";
            for (let i = 0; i < PAGE_SIZE; i++) {
                grid.appendChild($el("div", { className: "ns-pl-card ns-pl-skel" }, [
                    $el("div", { className: "ns-pl-skel-media" }),
                    $el("div", { className: "ns-pl-skel-line is-name" }),
                    $el("div", { className: "ns-pl-skel-line" }),
                    $el("div", { className: "ns-pl-skel-line is-short" }),
                ]));
            }
        }

        // 动作排在卡片身上是开灯箱的落点，点动作排的那一发不冒到卡片上
        function action(iconKey, title, onClick, feature) {
            const b = $el("button", { className: "ns-pl-btn", type: "button", title: t(title) }, [icon(iconKey, 13)]);
            b.onclick = (e) => { e.stopPropagation(); onClick(b); };
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
            // 素材库放行哪一类跟着筛子走：筛「视频」只挑视频、筛「图像」只挑图（后端按产物类型取首帧成图），
            // 「全部」两类都挑——图像池的提示词也能钉一条成片当封面，卡片就认那条指针自动播
            openMaterial(poolChips.value === "all" ? null : poolChips.value, async (picked) => {
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
            const shown = cardTitle(name);
            const writable = it.source !== "presets";
            const kids = [];
            // 封面自动播两条链都认（见 mediaTile 与 cardPreviewMedia）：云端预设走 480p 预览，
            // 自定义走封面指针那条本地成片；没有画面就铺文字位，这一页不铺假缩略图，也不给空卡留一整档空档
            const preview = cardPreviewMedia(it);
            const coverSrc = cardCoverSrc(it);
            const head = $el("div", { className: "ns-pl-head" }, [
                $el("div", { className: "ns-pl-name", title: name, textContent: shown }),
                $el("div", { className: "ns-pl-badges" },
                    cardBadges(it).map((s) => $el("span", { className: "ns-pl-badge", textContent: s }))),
            ]);
            if (coverSrc) {
                kids.push(mediaTile(it, coverSrc, preview));
                kids.push(head);
            } else {
                // 没有画面的卡先认名字：这一张没有画面压住顶部，名字落在最上方，下面才是正文那一格
                kids.push(head);
                kids.push(textTile(name));   // 摘要位在文字位里，下面不再铺一次
            }
            // 摘要位先空着：正文按页那一发回来才填，:empty 把这一位整位收掉，卡片落名字与标签
            if (coverSrc) kids.push($el("div", { className: "ns-pl-excerpt", textContent: previews.get(name)?.text || "" }));
            const tags = (it.tags || []).slice(0, 3);
            if (tags.length) {
                kids.push($el("div", { className: "ns-pl-tags" },
                    tags.map((s) => $el("span", { className: "ns-pl-tag", textContent: s }))));
            }
            kids.push($el("div", { className: "ns-pl-foot" }, [
                $el("span", { className: "ns-pl-src",
                    textContent: `${writable ? t("自定义") : t("预设")} · ${agoText(it._mtime)}` }),
                // 填页那一发认池子：视频条只给填入视频页，图像条只给填入绘画页，卡上不留一颗用不上的钮
                $el("div", { className: "ns-pl-actions" }, [
                    poolOf(name) === "video"
                        ? action("film", "填入视频页", () => fillPage("video", name))
                        : action("sparkles", "填入绘画页", () => fillPage("paint", name)),
                    action("copy", "复制这条提示词全文", () => copyText(name)),
                    ...(writable ? [action("image", "设为封面", () => pickCover(name), "prompt_library_write")] : []),
                    ...(writable ? [action("trash", "删除", (b) => removePrompt(name, b), "prompt_library_write")] : []),
                ]),
            ]));
            // 有画面的卡整张点开灯箱（见 openCardLightbox）；文字位卡片没有可放的画面，不铺这一发
            const viewable = Boolean(coverSrc);
            return $el("div", {
                className: "ns-pl-card" + (viewable ? " is-viewable" : ""),
                dataset: { name },
                ...(viewable ? { title: t("点击放大查看"), onclick: () => openCardLightbox(it) } : {}),
            }, kids);
        }

        /** 灯箱里那一条：播与放的都是本体，不是卡片那一格那一发（云端图像走 512 缩略图代理、
         *  云端视频走 480p 预览，本体的口径见 cardOriginalSrc 与 cloudMediaUrl） */
        function lightboxItem(it) {
            const preview = cardPreviewMedia(it);
            const url = preview ? preview.original : cardOriginalSrc(it);
            if (!url) return null;
            return { raw: it, kind: preview ? "video" : "image", url, title: cardTitle(String(it.name)) };
        }

        /** 卡片整张点开灯箱：←/→ 在当前筛子那叠有画面的卡之间翻，文字位卡片不进这一叠 */
        function openCardLightbox(it) {
            const items = filteredRows().map(lightboxItem).filter(Boolean);
            const index = items.findIndex((x) => String(x.raw.name) === String(it.name));
            if (index < 0) return;
            Lightbox.open({
                items,
                index,
                actions: (item) => lightboxActions(item.raw),
                panel: (item) => lightboxPanel(item.raw),
            });
        }

        /** 灯箱底栏的动作与卡上同一口径，认这条的池子：视频条只有填入视频页，图像条只有填入绘画页 */
        function lightboxActions(it) {
            const name = String(it.name);
            const fill = poolOf(name) === "video"
                ? { icon: "film", label: t("填入视频页"), title: t("填入视频页"), onClick: () => fillPage("video", name) }
                : { icon: "sparkles", label: t("填入绘画页"), title: t("填入绘画页"), onClick: () => fillPage("paint", name) };
            const acts = [fill, { icon: "copy", label: t("复制全文"), title: t("复制这条提示词全文"), onClick: () => copyText(name) }];
            if (it.source !== "presets")
                acts.push({ icon: "image", label: t("设为封面"), title: t("设为封面"), onClick: () => pickCover(name) });
            return acts;
        }

        /** 灯箱侧栏：这条的标签与全文（正文走 loadPrompt 那一发，读不到就只铺标签，全空就不占位） */
        async function lightboxPanel(it) {
            const body = $el("div", { className: "neo-lightbox-panel-body" });
            const tags = it.tags || [];
            if (tags.length) body.appendChild($el("div", { className: "neo-lightbox-panel-tags" },
                tags.map((s) => $el("span", { className: "neo-lightbox-panel-tag", textContent: s }))));
            let text = "";
            try { text = String((await loadPrompt(String(it.name)))?.text || ""); } catch { /* 正文读不到就只铺标签 */ }
            const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
            if (lines.length) body.appendChild($el("div", { className: "neo-lightbox-panel-plain" },
                lines.map((s) => $el("div", { className: "neo-lightbox-panel-line", textContent: s }))));
            if (!body.childNodes.length) return null;
            return $el("div", { className: "neo-lightbox-panel-inner" }, [
                $el("div", { className: "neo-lightbox-panel-header" }, [
                    $el("span", { className: "neo-lightbox-panel-title", textContent: t("提示词全文") }),
                    $el("span", { className: "ns-pl-src",
                        textContent: `${it.source === "presets" ? t("预设") : t("自定义")} · ${agoText(it._mtime)}` }),
                ]),
                body,
            ]);
        }

        /** 媒体位：高度跟着画面朝向的那一档（见 bindMediaRatio），横版裁切铺满、竖版整宽；
         *  铺预览位时带一枚播放角标，与素材方块那枚同一口径 */
        function mediaTile(it, coverSrc, preview) {
            const wrap = $el("div", { className: "ns-pl-media" });
            const face = preview ? previewVideo(preview, coverSrc) : coverImage(coverSrc);
            wrap.append(face);
            // 少动效那条路不挂 src（见 previewVideo），没有要播的片就不铺这枚角标
            if (face.dataset.src) wrap.append($el("span", { className: "ns-pl-kind" }, [icon("play", 12)]));
            bindMediaRatio(wrap, face, coverSrc, it.cover_media);
            return wrap;
        }

        /** 没有画面的卡铺文字位：正文摘要那一格，不铺假缩略图（摘要位仍是 .ns-pl-excerpt，
         *  按页那一发照同一发回填）。池子标签在上方那两枚徽标里，这一格不再铺第二枚同样的标签 */
        function textTile(name) {
            return $el("div", { className: "ns-pl-tile" }, [
                $el("div", { className: "ns-pl-excerpt ns-pl-tile-text", textContent: previews.get(name)?.text || "" }),
            ]);
        }

        /** 媒体位的高度认画面朝向：横版裁到 3/4 卡宽，竖版整宽、最长 2 倍卡宽（9:16 整幅进位，长截图不铺成长条）。
         *  尺寸优先吃写封面那一步记在指针里的 w/h（见 prompt_names.write_cover_source）——卡片落位就定高，
         *  瀑布流不在画面到位之后整页重排。云端那条媒体与出厂目录封面没有这份记录，退回探测：图在 load 认，
         *  视频在 loadedmetadata 认；预览位先探它那张 poster——poster 就是这条的封面，比例与成片一致，
         *  等 metadata 的话竖版卡会先以 4:3 落位、片头一齐来整页重排。
         *  卡片随之长高，瀑布流的 ResizeObserver 接住这一发重排 */
        function bindMediaRatio(wrap, face, coverSrc, known) {
            const fit = (w, h) => {
                if (!w || !h) return false;
                const height = Math.min(MEDIA_HEIGHT_CEIL, Math.max(MEDIA_HEIGHT_FLOOR, h / w));
                wrap.style.aspectRatio = `1 / ${Number(height.toFixed(4))}`;
                return true;
            };
            if (fit(known?.w, known?.h)) return;
            if (face.tagName === "VIDEO") {
                face.addEventListener("loadedmetadata", () => fit(face.videoWidth, face.videoHeight));
                if (!coverSrc) return;
                const poster = document.createElement("img");
                poster.onload = () => fit(poster.naturalWidth, poster.naturalHeight);
                poster.src = coverSrc;
                return;
            }
            face.addEventListener("load", () => fit(face.naturalWidth, face.naturalHeight));
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

        /** 预览位：<video> 先只带 poster，src 由视野观察者挂上（两条链的地址都在 cardPreviewMedia 里定）；
         *  要少动效的用户就停在封面上 */
        function previewVideo(preview, poster) {
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
            video.dataset.src = preview.src;
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
            const rows = filteredRows();
            shown = 0;
            grid.textContent = "";
            countEl.textContent = tf("{n} 条", { n: rows.length });
            if (note) { noteEl.textContent = note; renderMore(rows.length); return; }
            noteEl.textContent = rows.length ? ""
                : query ? t("无匹配提示词") : t("提示词库是空的，生成面板里存的提示词会出现在这里");
            armedDelete = "";   // 重画即 disarm：armed 的那一发不能挂到重画后的卡片上
            appendPage(rows);
        }

        /** 当前搜索词与筛子筛出来的那一叠 */
        function filteredRows() {
            return filterPromptCards(items, {
                query, pool: poolChips.value, source: sourceChips.value,
                tag, sort: sortChips.value,
            });
        }

        /** 滚到底那一发：追加下一屏；整叠已在手里，这一发只往网格里补卡 */
        function appendMore() {
            const rows = filteredRows();
            if (shown >= rows.length) { renderMore(rows.length); return; }
            appendPage(rows);
        }

        function appendPage(rows) {
            const batch = rows.slice(shown, shown + PAGE_SIZE);
            shown += batch.length;
            for (const it of batch) grid.appendChild(card(it));
            fillPreviews(batch);
            renderMore(rows.length);
            // 底部那一行还在视野里就接着补：IntersectionObserver 只在相交状态变化时回调，
            // 不重新观察的话铺完一屏就停在「载入更多…」上，用户得再滚一下才动
            moreObserver?.unobserve(moreEl);
            if (shown < rows.length) moreObserver?.observe(moreEl);
        }

        function renderMore(total) {
            moreEl.textContent = !total ? ""
                : shown >= total ? tf("已全部 {n} 条", { n: total }) : t("载入更多…");
        }

        async function loadList() {
            skeleton();
            noteEl.textContent = "";
            countEl.textContent = "";
            moreEl.textContent = "";
            note = "";
            shown = 0;
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
            renderTagChips(items);
            render();
        }

        /**
         * 刷新那一发：先强制重拉云端索引（主索引 + 逐目录索引），再重读列表。
         * 只重读列表不够——卡片上的云端图与预览配对吃的是磁盘上那份目录索引缓存，主索引在进程里
         * 按 sync_interval_hours（缺省 24 小时）缓存，云端刚发布的卡在两页上都可以一发都不动。
         * 云端提示词目录同一发镜像进提示词池（sync_prompt_mirror）：池子那批 .txt 才是卡片单位，
         * 云端新发的条补进池子、云端删掉的条从池子里收掉，数量与旧卡才会跟着这一发变。
         * 在飞时这颗钮收着：一发在路上就不排第二发。
         */
        async function refreshAll() {
            if (refresh.disabled) return;
            refresh.disabled = true;
            refresh.classList.add("is-busy");
            const cloud = await syncCloudIndex();
            await loadList();
            refresh.classList.remove("is-busy");
            refresh.disabled = false;
            if (cloud.ok) {
                // 云端提示词目录这一发镜像进了提示词池：条数变了才报这一步，一条没动就只报索引
                const mirror = (cloud.imported || cloud.pruned)
                    ? tf("，云端提示词 +{add} / -{cut}", { add: cloud.imported, cut: cloud.pruned }) : "";
                toast(tf("已刷新：{dirs} 个云端目录 / {items} 项（重拉 {refreshed} 个目录索引）",
                    { dirs: cloud.directories, items: cloud.items, refreshed: cloud.refreshed }) + mirror);
            } else if (cloud.reason === "not_configured") {
                toast(t("未配置云端预设，已重读本地列表"));
            } else if (cloud.reason === "offline") {
                toast(t("云端索引需要 ComfyUI 运行，已重读本地列表"));
            } else {
                toast(`${t("刷新云端索引失败")}：${cloud.message}`);
            }
        }

        // 用例驱动「滚到底追加下一屏」：jsdom 没有 IntersectionObserver，滚轮也不会自己到底
        el.__neoStudioPromptLibraryPageTestHooks = { appendMore, shown: () => shown, moreRow: moreEl };

        await loadList();
    };
}

