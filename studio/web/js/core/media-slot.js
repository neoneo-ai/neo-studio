/**
 * 素材方块：一枚虚线方块 = 一个素材落点（首帧 / 尾帧 / 参考素材共用这一副，视频页与导演页同一口径）。
 *
 * 空格时点它是「从素材库取用」，取用与画面来源由宿主注入，组件不认识配方、也不认识 input/：
 *   thumbSrc(value) = 缩略图 URL；
 *   pick({accept, kindMax, multiple, add}) = 宿主把用户挑的东西变成值（input 相对名）交回 add；
 *   refKinds() = 这一发/这一段的技能模板收哪几类参考素材（null = 不门控）。
 * 类型归类、各类上限、技能槽位门控与对应提示都在这份组件里——两条页面对外说的是同一句话。
 *
 * 值数组是组件的全部状态（[{value, kind}]）：宿主经 get() / first() / fill() 读写，
 * setReadOnly(true) = 预设配方那种「看得见改不了」：＋ 与 ✕ 都不画。
 */
import { $el } from "../../../../scripts/ui.js";
import { t, tf } from "./i18n.js";
import { icon, setIcon } from "./icons.js";
import { mediaKindOf } from "../../gallery-utils.js";

export const REF_KIND_NAMES = { image: "参考图", video: "参考视频", audio: "参考音频" };   // 取用时过 t()，随语言现读

/** 方块上的画面：图是封面，视频是首帧画面（不给 controls——这枚方块点了是换素材不是播片），
 *  音频没有可画的画面，只有类型图标，文件名写在方块 title 里 */
function slotFace(it, thumbSrc) {
    if (it.kind === "video") {
        // muted 是媒体元素的属性开关：$el 只会 setAttribute，静音要在建好元素后写上去
        const movie = $el("video", { className: "ns-slot-media", src: thumbSrc(it.value), preload: "metadata", playsInline: true, draggable: false });
        movie.muted = true;
        return movie;
    }
    if (it.kind === "audio") return $el("span", { className: "ns-slot-audio" }, [icon("volume", 20)]);
    return $el("img", { className: "neo-gallery-edit-refchip-img", alt: it.value, src: thumbSrc(it.value), draggable: false });
}

export function createMediaSlot({ label, multiple = false, maxN = 1, kindMax = null, thumbSrc, pick, refKinds = null, toast = () => {}, onChange = null }) {
    const items = [];   // {value, kind}：素材的 input 相对名 + 参考类型（kindMax 缺省时恒 image）
    let readOnly = false;
    const add = $el("button", { className: "ns-slot-add", type: "button" });
    setIcon(add, "plus", 18);
    const cap = $el("span", { className: "neo-gallery-edit-refdrop-cap" });
    const thumbs = $el("div", { className: "ns-slot-thumbs" });
    const slot = multiple
        ? $el("div", { className: "ns-slot ns-slot-row" })
        : $el("div", { className: "ns-slot neo-gallery-edit-refdrop" }, [thumbs, add, cap]);
    const countOf = (kind) => items.reduce((n, it) => n + (it.kind === kind ? 1 : 0), 0);

    const tile = (it) => {
        const kids = [slotFace(it, thumbSrc)];
        // 视频那一枚补一枚播放角标：缩略图上它和一张静图长得一样；音频方块的图标已经把类型说满
        if (it.kind === "video") kids.push($el("i", { className: "ns-slot-kind" }, [icon("play", 12)]));
        if (!readOnly) {
            const del = $el("button", { className: "neo-gallery-edit-refchip-x", type: "button", title: t("移除"), textContent: "✕" });
            del.onclick = () => { items.splice(items.indexOf(it), 1); render(); onChange?.(); };
            kids.push(del);
        }
        return $el("div", { className: "neo-gallery-edit-refdrop ns-slot-tile has-img", title: `${t(REF_KIND_NAMES[it.kind])} · ${it.value}` }, kids);
    };

    const render = () => {
        if (multiple) {
            const tiles = items.map(tile);
            if (!readOnly && items.length < maxN) {
                cap.textContent = items.length ? `${items.length}/${maxN}` : t(label);
                // 角标写总数，各类各收到第几张写在添图那一枚的 title 里——三类计数铺开就是三行字
                add.title = kindMax
                    ? Object.entries(kindMax).map(([k, n]) => `${t(REF_KIND_NAMES[k])} ${countOf(k)}/${n}`).join(" · ")
                    : t("从素材库取用");
                tiles.push($el("div", { className: "neo-gallery-edit-refdrop ns-slot-tile" }, [add, cap]));
            }
            slot.replaceChildren(...tiles);
            slot.scrollLeft = slot.scrollWidth;   // 连选时把刚添的那枚滚进视线
            return;
        }
        thumbs.textContent = "";
        for (const it of items.slice()) {
            const wrap = $el("span", { className: "ns-slot-thumb" }, [
                $el("img", { alt: it.value, src: thumbSrc(it.value) }),
            ]);
            if (!readOnly) {
                const del = $el("button", { className: "neo-gallery-edit-refchip-x", type: "button", title: t("移除"), textContent: "✕" });
                del.onclick = () => { items.splice(items.indexOf(it), 1); render(); onChange?.(); };
                wrap.appendChild(del);
            }
            thumbs.appendChild(wrap);
        }
        cap.textContent = items.length ? t("换图") : t(label);
        slot.classList.toggle("has-img", items.length > 0);
        add.style.display = readOnly ? "none" : "";
    };

    /** 取用前那道闸：类型归类、各类上限与技能槽位门控都在这一步，返回过了闸的那批 [{value, kind, src}]。
     *  宿主先过闸再 copy_to_input——挡下的不落盘，input 目录不留用户用不上的文件（copy_to_input 会实打实写一份）。
     *  技能没声明那一类时那条加载链会被后端整条裁掉，素材只是发出去被静默丢掉，所以在落盘前就挡住；
     *  老后端与老技能没有 ref_kinds 字段 = 不门控（照收，与加这道闸之前一致）。 */
    const gate = (values) => {
        const allowed = refKinds ? (refKinds() || null) : null;
        const full = new Set(), blocked = new Set(), unusable = new Set();
        const accepted = [];
        const nOf = (kind) => items.reduce((n, it) => n + (it.kind === kind ? 1 : 0), 0)
            + accepted.reduce((n, it) => n + (it.kind === kind ? 1 : 0), 0);
        for (const v of values || []) {
            const value = typeof v === "string" ? v : [v?.subfolder, v?.filename].filter(Boolean).join("/");
            if (!value) continue;
            const kind = kindMax ? mediaKindOf(value) : "image";
            if (!kind) { unusable.add(value); continue; }
            if (allowed && !allowed.includes(kind)) { blocked.add(kind); continue; }
            if (items.length + accepted.length >= maxN || (kindMax && nOf(kind) >= kindMax[kind])) { full.add(kind); continue; }
            accepted.push({ value, kind, src: v });
        }
        for (const kind of full) toast(tf("{label}最多 {n} 个，多出来的没进", {
            label: kindMax ? t(REF_KIND_NAMES[kind]) : t(label), n: maxN,
        }));
        for (const kind of blocked) toast(tf("该技能模板没有{label}槽位，取用的没进", { label: t(REF_KIND_NAMES[kind]) }));
        for (const name of unusable) toast(tf("参考节点不吃这类素材：{name}", { name }));
        return accepted;
    };

    /** 宿主过完闸、落完盘把过了闸的那批交回来（copy_to_input 可能改名，value 以宿主给的为准）。
     *  单枚方块（首帧 / 尾帧）= 整槽换内容：后取用的那张顶掉前一张 */
    const accept = (entries) => {
        for (const e of entries || []) {
            const value = typeof e === "string" ? e : e.value;
            if (!value) continue;
            const kind = (typeof e === "string" ? null : e.kind) || (kindMax ? mediaKindOf(value) : "image");
            if (!kind) continue;
            if (multiple) items.push({ value, kind });
            else { items.length = 0; items.push({ value, kind }); }
        }
        render();
        onChange?.();
    };

    add.onclick = () => pick({ accept: kindMax ? null : "image", kindMax, multiple, gate, add: accept });
    render();

    return {
        el: slot,
        get: () => items.map((it) => ({ value: it.value, media: it.kind })),
        first: () => items[0] || null,
        /** 整槽换内容（重开配方 / 「再来一发」）：面板已铺好，重建会把用户写了一半的提示词清掉。
         *  混收那一行按扩展名归类，认不出的整项不填 */
        fill: (vals) => {
            items.length = 0;
            for (const v of vals || []) {
                const value = typeof v === "string" ? v : [v?.subfolder, v?.filename].filter(Boolean).join("/");
                if (!value) continue;
                const kind = kindMax ? mediaKindOf(value) : "image";
                if (!kind || (kindMax && countOf(kind) >= kindMax[kind])) continue;
                items.push({ value, kind });
            }
            render();
        },
        setReadOnly: (on) => { readOnly = !!on; render(); },
    };
}
