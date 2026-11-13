// Neo Studio 首页版式：卡片注册表、版式读写、与首页上那一叠原地编辑控件。
//
// 版式落在后端（studio/home_layout.py 写 configs/home_layout.json），不落 localStorage：
// 插件页、桌面窗口、手机页是三份互看不见的本机存储，偏好存本机等于每台设备各排一套首页。
// 卡表只有这里一份：后端只存 id 与形状，认不出的一张卡落回默认板块与默认页；
// 「跳到哪一屏」是数据（target + value），由 studio-app.js 的 openHomeCard 落地。
import { $el } from "./shim/ui.js";
import { api } from "./shim/api.js";
import { t, tf } from "../js/core/i18n.js";
import { icon, ICON_NAMES } from "../js/core/icons.js";
import "../vendor/sortable.min.js";   // 落位手势：vendored 的 Sortable（与 marked/purify 同一份引进来），运行时不联网

export const HOME_SECTIONS = [
    { id: "create", label: "开始创作" },
    { id: "edit", label: "编辑" },
    { id: "material", label: "素材与配置" },
];

// 每张卡是一段数据：target = page（切到 value 那一页）/ edit（进编辑页带上 value 那一发模式）
// / url（开外部链接）/ recipe、skill（进导演页与技能页，带上选中的那一份）。板块只有三个，自建卡落进其一。
// 内置预设卡直连本页（page）与编辑模式（edit），特效那一张走技能落点（skill）：添加卡片弹窗只配 FORM_TARGETS 那三种。
// page 与 edit 只出现在旧版式里存着的卡上：读得回来、跳得动，界面上不再产出这两类
// （HOME_TARGETS 是读门，FORM_TARGETS 是能配的那三种，LEGACY_TARGET 单列就是为这个）。
// defaultHidden = 这张内置卡默认不上首页，只在「添加卡片」的预设里等着加：首页版式排过它才出。
export const HOME_CARDS = [
    { id: "paint", section: "create", icon: "sparkles", title: "生成图片", sub: "描述画面，直接出图", target: "page", value: "paint" },
    { id: "video", section: "create", icon: "film", title: "生成视频", sub: "一句话加首帧，出一段视频", target: "page", value: "video" },
    { id: "director", section: "create", icon: "play", title: "导演视频", sub: "多段配方，生成整片视频", target: "page", value: "director" },
    { id: "pose", section: "create", icon: "pose", title: "3D 姿势", sub: "姿势 · 整场 · 全景", target: "page", value: "pose" },
    { id: "agent", section: "create", icon: "target", title: "智能体", sub: "说出目标，工具链多轮跑完", target: "page", value: "agent" },
    { id: "voice", section: "create", icon: "volume", title: "声音克隆", sub: "用一段参考音频的音色朗读文字", target: "page", value: "voice" },
    // 特效是这张技能的全部能力，不是一页自己的功能：卡片走技能落点，进视频页就把 effect_h3 选中，
    // 特效芯片由那张技能自己铺出来——技能页删了这张技能，这张卡跟着落技能页（goSkillApply 那条门）。
    { id: "effect", section: "create", icon: "sparkles", title: "特效视频", sub: "选一枚镜头特效，出一段片", target: "skill", value: "effect_h3", defaultHidden: true },
    { id: "edit-normal", section: "edit", icon: "pencil", title: "图片编辑", sub: "写下要改成什么样，整图重绘", target: "edit", value: "normal" },
    { id: "edit-outpaint", section: "edit", icon: "maximize", title: "扩图", sub: "拖框定四边留白，补全周边场景", target: "edit", value: "outpaint" },
    { id: "edit-local", section: "edit", icon: "pencil", title: "局部", sub: "涂抹要改的区域，高分重绘并合回原图", target: "edit", value: "local" },
    { id: "edit-remove", section: "edit", icon: "cross", title: "删除", sub: "点掉要删的物体，分割后移除", target: "edit", value: "remove" },
    { id: "edit-angle", section: "edit", icon: "camera", title: "机位", sub: "拖机位球换角度重出这张", target: "edit", value: "angle" },
    { id: "edit-blend", section: "edit", icon: "copy", title: "融合", sub: "多张参考图融成一张连贯画面", target: "edit", value: "blend" },
    { id: "edit-pose", section: "edit", icon: "user", title: "姿势", sub: "骨架图锁姿势，重出这一张", target: "edit", value: "pose" },
    { id: "frames", section: "edit", icon: "film", title: "视频抽帧", sub: "挑一条视频，抽帧存进素材库", target: "page", value: "frames" },
    { id: "reverse", section: "edit", icon: "eye", title: "图片反推", sub: "挑一张图，反推出提示词", target: "page", value: "reverse" },
    { id: "gallery", section: "material", icon: "folder", title: "素材库", sub: "浏览与管理全部生成素材", target: "page", value: "gallery" },
    { id: "skills", section: "material", icon: "wand", title: "技能", sub: "管理预设与技能包", target: "page", value: "skills" },
    { id: "settings", section: "material", icon: "gear", title: "设置", sub: "生成默认值与界面语言", target: "page", value: "settings" },
];

export const HOME_HERO = {
    title: "今天想", accent: "创作", suffix: "什么？",
    sub: "一句话到一段成片，全部在你自己的电脑上完成", cta: "一句话出图",
};

// 编辑页那一发模式的清单与 image-edit-panel.js 的模式 chip 同源同序：少一个就是首页少一张直达卡
export const HOME_EDIT_MODES = ["normal", "outpaint", "local", "remove", "blend", "pose", "angle"];
export const HOME_TARGETS = ["edit", "recipe", "skill", "url"];   // 读门：旧版式里的卡照读照跳，一条都不丢
export const FORM_TARGETS = ["recipe", "skill", "url"];           // 添加卡片弹窗能配的三种跳转
export const LEGACY_TARGET = "page";   // 旧版式里存的直连卡：读得回来跳得动，界面上不再产出这一类
export const HOME_COLS = [0, 2, 3, 4, 5];   // 0 = 跟随窗口档位；窄档与手机自己收到 2 / 1 列

// 自建卡挑图标的候选：弹窗里铺出来的是图标本身，图标名只当这枚的标识（tooltip 上看得见）。
// 内置卡表与 cardShapeForTarget 用到的每一枚都在这一把里——自动填落下的图标必定点得着。
export const CARD_ICONS = [
    "sparkles", "wand", "image", "pencil", "film", "play", "camera", "pose",
    "target", "copy", "user", "folder", "gear", "plug", "maximize", "cross",
    "list", "clock", "send", "history", "eye", "volume", "plus", "ratio", "trash",
];

const LAYOUT_PATH = "/neo_home/layout";
const ID_OK = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,39}$/;
const MAX_CUSTOM = 20;
const TARGET_LABELS = { recipe: "导演配方", skill: "技能", url: "外部链接" };
const HERO_KEYS = ["title", "accent", "suffix", "sub", "cta"];

/** 跳转类型 + 跳转目标定了这张卡要去哪，形状就按那一发填：配方 / 技能 / 外部链接落一份对应落点的默认形状。
 *  label 是配方名或技能显示名 */
export function cardShapeForTarget(target, value, label = "") {
    if (target === "recipe") {
        return { title: label || TARGET_LABELS.recipe, sub: "多段配方，生成整片视频", icon: "play", section: "create" };
    }
    if (target === "skill") {
        return { title: label || TARGET_LABELS.skill, sub: "打开这一发技能的应用页", icon: "wand", section: "material" };
    }
    if (target === "url") {
        return { title: urlHost(value), sub: "打开外部链接", icon: "plug", section: "create" };
    }
    return { title: "", sub: "", icon: "image", section: "create" };
}

/** 链接的主机名：自动填标题时给这一发外部链接起的名，认不出的地址留空让保存门去说 */
function urlHost(value) {
    const hit = /^https?:\/\/([^/]+)/i.exec(String(value || "").trim());
    return hit ? hit[1].replace(/^www\./i, "") : "";
}




/** 板块顺序：版式给的在前，注册表剩下的按默认序补后。板块位置移动这一版不给了，这份序只服务旧版式里排过的顺序 */
export function sectionOrder(layout) {
    const known = HOME_SECTIONS.map((s) => s.id);
    const saved = layout.sections.filter((id) => known.includes(id));
    return [...saved, ...known.filter((id) => !saved.includes(id))];
}

/** 首页的板块：顺序表里收起来的整块不出。板块收起同样只剩读的一面：编辑态把它连卡一起铺回来（见 studio-app.js） */
export function layoutSections(layout) {
    return sectionOrder(layout)
        .filter((id) => !layout.hidden_sections.includes(id))
        .map((id) => HOME_SECTIONS.find((s) => s.id === id));
}

/** 这张卡在这份版式里在不在首页上：hidden 里的（移出首页的内置卡）永远不在；带 defaultHidden 的
 *  内置卡只有版式的 order 显式排过它才在——新能力默认不上首页，用户在「添加卡片」里点过一次就算排过。 */
function homePlaced(card, layout) {
    if ((layout.hidden || []).includes(card.id)) return false;
    if (!card.defaultHidden) return true;
    return (layout.order[card.section] || []).includes(card.id);
}

/** 卡在这份版式里占不占一格：移出首页的内置卡留着原来那一格（加回来才落回原位），
 *  默认不上首页又没排过的卡不占格——补末尾与排格那两步不能把它推上首页 */
function homeSlot(card, layout) {
    return (layout.hidden || []).includes(card.id) || homePlaced(card, layout);
}

/** 一个板块的全部卡片（含移出首页的：order 里那张卡的位要保住）；认不出的 id 丢掉，新卡补在末尾 */
export function sectionCards(sectionId, layout) {
    const pool = [...HOME_CARDS.filter((c) => c.section === sectionId),
                  ...layout.custom.filter((c) => (c.section || "create") === sectionId)];
    const byId = new Map(pool.map((c) => [c.id, c]));
    const saved = [];
    const taken = new Set();
    for (const raw of (Array.isArray(layout.order[sectionId]) ? layout.order[sectionId] : [])) {
        const card = byId.get(String(raw));
        if (card && !taken.has(card)) { saved.push(card); taken.add(card); }   // 按卡片对象去重：uniq() 认的是 id，喂对象会全丢
    }
    return [...saved, ...pool.filter((c) => !taken.has(c) && homeSlot(c, layout))];
}

/** 首页上真出现的那一叠卡：编辑态铺的也是这一叠——移出首页的卡不在网格上留位置，它在添加卡片弹窗里 */
export function visibleCards(sectionId, layout) {
    return sectionCards(sectionId, layout).filter((c) => homePlaced(c, layout));
}

/** 添加卡片弹窗里的预设：这一板块没在首页上的内置卡（被移出首页的、与默认就不上首页的）。
 *  已在首页的一张不出——预设不跟首页上的卡重复。
 *  自建卡不在其上：导演配方 / 技能 / 外部链接是表单建的卡，没有预设可挑 */
export function presetCards(sectionId, layout) {
    return HOME_CARDS.filter((c) => c.section === sectionId && !homePlaced(c, layout));
}

/** 标题区的文案：版式给几行换几行，没给的行落默认文案 */
export function heroText(layout) {
    return { ...HOME_HERO, ...layout.hero };
}

/** 读回来的版式过一次形状门：认不出的键与卡一律丢掉，首页不因为一份坏版式空屏 */
export function normalizeLayout(raw) {
    const data = raw && typeof raw === "object" ? raw : {};
    const custom = (Array.isArray(data.custom) ? data.custom : [])
        .map(cleanCustom).filter(Boolean).slice(0, MAX_CUSTOM);
    // hidden 只装内置卡：界面上没有「藏一张自建卡」的入口，旧版式里藏着的自建卡在首页照出，
    // 位置由 order 保住——不能让一次保存把用户已有的卡静默清掉
    const builtin = new Set(HOME_CARDS.map((c) => c.id));
    const sections = uniq(data.sections).filter((id) => HOME_SECTIONS.some((s) => s.id === id));
    const orderRaw = data.order && typeof data.order === "object" ? data.order : {};
    const order = {};
    for (const id of sectionOrder({ sections })) {
        order[id] = sectionCards(id, { order: orderRaw, custom }).map((c) => c.id);
    }
    const hero = {};
    for (const key of HERO_KEYS) {
        const text = oneLine(data.hero?.[key], key === "sub" ? 60 : 40);
        if (text) hero[key] = text;
    }
    for (const key of ["off", "cta_off"]) {
        if (data.hero?.[key] != null) hero[key] = !!data.hero[key];
    }
    const cols = Number(data.cols);
    return {
        sections,
        hidden_sections: uniq(data.hidden_sections).filter((id) => HOME_SECTIONS.some((s) => s.id === id)),
        order,
        hidden: uniq(data.hidden).filter((id) => builtin.has(id)),
        custom,
        cols: HOME_COLS.includes(cols) ? cols : 0,
        hero,
    };
}

/** 读版式：非 200（比这版插件老的构建没有这条接口）与请求崩了都回 null，首页按默认版式渲染 */
export async function loadHomeLayout() {
    try {
        const resp = await api.fetchApi(LAYOUT_PATH);
        if (!resp.ok) return null;
        return normalizeLayout(await resp.json());
    } catch {
        return null;
    }
}

export async function saveHomeLayout(layout) {
    const resp = await api.fetchApi(LAYOUT_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(layout),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.success) throw new Error(data?.error || t("保存失败"));
    return normalizeLayout(data.layout);
}

export async function resetHomeLayout() {
    const resp = await api.fetchApi(`${LAYOUT_PATH}/reset`, { method: "POST" });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.success) throw new Error(data?.error || t("恢复默认失败"));
    return normalizeLayout(data.layout);
}


/** 首页原地编辑：首页这一页就是编辑器。卡片上长出小控件，标题区点字直接改，顶端一条细栏管列数、
 *  标题区开关与恢复默认；每一次改动经 host.onDraft 重画首页，落盘收口在细栏右端那枚「完成」（宿主调 save） */
export function createHomeInlineEditor(host = {}) {
    const bar = $el("div", { className: "ns-home-edit-bar" });
    const status = $el("span", { className: "ns-home-edit-status" });

    let draft = normalizeLayout({});
    let pickLists = { recipes: [], skills: [] };   // 自建卡的配方 / 技能候选：开编辑弹窗时下拉要用，进编辑态拉一次
    let entry = null;                              // 「完成」：编辑态由宿主交进来，落进细栏右端
    let closeCardDialog = null;                    // 开着的添加卡片这一面：再开一面时先收掉旧的，不留两层遮罩
    const grids = new Map();                       // gridEl -> { section, epoch, sortable }：重画一次首页就换一批网格元素
    let gridEpoch = 0;                             // 渲染轮次：一轮里三条网格同一轮，比它旧的那批要销毁

    function render() {
        gridEpoch++;   // 宿主接着要按这份草稿重画首页：新的网格元素落在这一轮里，上一轮那批 Sortable 实例就该收了
        // 清扫排在换 DOM 之前：这一刻旧网格还挂在文档里。Sortable 的 destroy 要写 el.parentNode，
        // 等 replaceChildren 把旧网格摘掉再收就只剩「放手」——实例绑在 document 上的那批事件
        // （dragover / drop / keydown / visibilitychange）不跟着网格走，会一直留在页上。
        for (const [el, grid] of grids) {
            if (grid.epoch >= gridEpoch) continue;
            grids.delete(el);
            if (el.isConnected) grid.sortable.destroy();
        }
        bar.replaceChildren(...barControls(), status, ...(entry ? [entry] : []));
        host.onDraft?.(draft);   // 首页跟着草稿重画：卡上的控件改的就是这一点下去要落盘的排法
    }

    /** 细栏每次重画都接回这一枚「完成」：细栏钉在首页顶缘，入口放进它这一行才滚到哪一屏都点得着 */
    function setEntry(el) {
        bar.querySelector(".ns-home-edit-entry")?.remove();
        entry = el || null;
        if (entry) bar.appendChild(entry);
    }

    /** 细栏：列数档位、标题区与出图按钮开关、恢复默认。板块不参与——顺序与收起读旧版式，这一版不给开关 */
    function barControls() {
        const items = [$el("span", { className: "ns-home-edit-tag", textContent: t("网格列数") })];
        for (const n of HOME_COLS) {
            items.push($el("button", {
                className: "ns-btn ns-home-edit-col" + (draft.cols === n ? " is-on" : ""),
                type: "button", dataset: { cols: String(n) },
                title: n ? tf("{n} 列", { n }) : t("跟随窗口"),
                textContent: n ? String(n) : t("自动"),
                onclick: () => { draft.cols = n; render(); },
            }));
        }
        items.push($el("button", {
            className: "ns-btn ns-home-edit-hero", type: "button",
            textContent: draft.hero.off ? t("显示标题区") : t("隐藏标题区"),
            onclick: () => { draft.hero.off = !draft.hero.off; render(); },
        }));
        items.push($el("button", {
            className: "ns-btn ns-home-edit-cta", type: "button",
            textContent: draft.hero.cta_off ? t("显示出图按钮") : t("收起出图按钮"),
            onclick: () => { draft.hero.cta_off = !draft.hero.cta_off; render(); },
        }));
        items.push($el("button", {
            className: "ns-btn ns-home-edit-reset", type: "button",
            textContent: t("恢复默认"), onclick: () => resetDraft(),
        }));
        return items;
    }

    /** 落盘这一份草稿：成功就广播（studio-app 收到写回已落盘版式并退出编辑），失败抛到宿主去说——
     *  页面上这份草稿原样留着，「完成」回到可点的，不让人重排一遍 */
    async function save() {
        // 板块收起是上一版控件留下的状态：这一版不给开关，落一次盘就把这一格清干净
        draft = await saveHomeLayout({ ...draft, hidden_sections: [] });
        window.dispatchEvent(new CustomEvent("neo:home-layout", { detail: draft }));
        return draft;
    }

    async function resetDraft() {
        const btn = bar.querySelector(".ns-home-edit-reset");
        btn.disabled = true;
        try {
            draft = await resetHomeLayout();
            render();
            window.dispatchEvent(new CustomEvent("neo:home-layout", { detail: draft }));
            host.toast?.(t("已恢复默认版式"));   // 广播之后这条细栏跟着收掉：这一句要说在界面上
        } catch (e) {
            status.textContent = tf("恢复默认失败：{msg}", { msg: String(e?.message || e) });
        } finally {
            btn.disabled = false;
        }
    }

    async function load() {
        const stored = await loadHomeLayout();
        if (stored) draft = stored;
        // 配方与技能候选只服务卡内表单那两个下拉：宿主没给回调或拉崩了就留空下拉，排版照样能存
        const [recipes, skills] = await Promise.all([
            (host.listRecipes?.() || Promise.resolve([])).catch(() => []),
            (host.listSkills?.() || Promise.resolve([])).catch(() => []),
        ]);
        pickLists = { recipes: recipes || [], skills: skills || [] };
        render();
    }

    /** 标题区就地改字：大标题三段、副标题、出图按钮文案直接在这页上点字编辑，失焦写进草稿 */
    function decorateHero(heroEl) {
        for (const node of heroEl.querySelectorAll("[data-hero-key]")) {
            const key = node.dataset.heroKey;
            node.setAttribute("contenteditable", "plaintext-only");
            node.setAttribute("spellcheck", "false");
            node.addEventListener("blur", () => {
                const text = node.textContent.trim();
                // 空行不落：hero 的某一行清空等于回到注册表的默认文案
                if (!text || text === heroText(draft)[key]) { render(); return; }
                draft.hero[key] = text;
                render();
            });
            node.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); node.blur(); }   // 每一行都是一句话，回车就是「改完了」
            });
        }
    }

    /** 卡片上长出的控件就一枚删除：内置卡删掉是移出首页（回到添加卡片弹窗的预设里），自建卡删掉是真删。
     *  整张卡就是拖动手势，不设手柄与上下移，卡上的按钮不算拖起点（ignore） */
    function decorateCard(cardEl, ctx) {
        const { card } = ctx;
        const isCustom = draft.custom.some((c) => c.id === card.id);
        cardEl.classList.toggle("is-custom", isCustom);
        cardEl.appendChild($el("span", { className: "ns-home-card-tools" }, [
            iconBtn("trash", isCustom ? t("删除这张卡") : t("从首页移除这张卡"), () => removeCard(card)),
        ]));
    }

    /** 内置卡从首页移除：进 hidden，order 里那一格留着，加回来就落在原来的位置。
     *  不自动弹「添加卡片」这一面——连删几张卡时一弹一弹最碍事，这里只说一句去哪儿加回来 */
    function removeCard(card) {
        if (draft.custom.some((c) => c.id === card.id)) {
            deleteCard(card.id);
            return;
        }
        draft.hidden = uniq([...draft.hidden, card.id]);
        render();
        host.toast?.(t("这张卡已移出首页：在「添加卡片」里加回来"));
    }
    /** 网格的落位手势交给 Sortable：让位动画、跨板块迁移、触摸端拖动都是它的内建。自己写 HTML5 拖放时
     *  「预览挪卡 → 落点跟着变 → 预览重放」这条自追循环就是它替我们消掉的——落点判定不再读我们的预览。
     *  整张卡就是手势，卡上的按钮不算拖起点（ignore）。上一轮实例的清扫在 render() 里，这里只管这一条网格。 */
    function decorateGrid(gridEl, sectionId) {
        grids.get(gridEl)?.sortable.destroy();   // 同一条网格被重复装饰（同一轮重画两次）：旧实例先收掉，不留两套手势
        // 调用方（renderHome）在网格挂上文档之后才交到这里：实例建在脱离文档的元素上只认得「拖起来」，认不出落点
        // （真浏览器实测：dragStarted / emulateDragOver / onDragOver 都跑，就是不换行）。这一轮没挂载就不建，下一轮装饰补上。
        if (!gridEl.isConnected) return;
        grids.set(gridEl, { section: sectionId, epoch: gridEpoch, sortable: createSortable(gridEl, sectionId) });
    }

    function createSortable(gridEl, sectionId) {
        return window.Sortable.create(gridEl, {
            group: "ns-home",        // 三条网格同组：自建卡能在板块之间搬
            animation: 150,
            draggable: ".ns-home-card",
            // 卡面本身是 <button>：整条 ignore 里写 button 会把卡片自己的拖动一起挡掉，只挡卡上那排控件
            ignore: ".ns-home-card-tools .ns-btn, select, input, a",
            // 不用系统的 HTML5 拖动：自己的鼠标兜底才有可放的影子与让位动画，桌面窗口、Chrome、
            // 触摸端与自动化里同一套走法（系统的 dragstart 不吃合成鼠标事件，自动化里拖不起来）
            forceFallback: true,
            fallbackOnBody: true,   // 卡面带着 transform / scale：影子钉在 body 上才不跟着祖先的变换跑
            fallbackTolerance: 3,   // 按下先走出 3px 才算拖起来：点一下卡不误入拖动
            dragClass: "is-dragging",   // forceFallback 下 Sortable 不应用 ghostClass：跟指针的克隆吃这一条，原位的卡吃它自己的 .sortable-chosen
            swapThreshold: 0.65,
            onStart: (e) => {
                status.textContent = isCustomCard(draft, e.item?.dataset?.cardId)
                    ? "" : t("内置卡只能在本板块内排序，自建卡能搬去别的板块");
            },
            onEnd: function (e) { commitDrop(e, this); },
        });
    }

    /** Sortable 落位 → 草稿：同板块按格子换位置；跨板块只认自建卡——内置卡的板块是注册表定死的，
     *  落进别的板块就退回原位并说一句。newDraggableIndex 就是落在这一版卡里的第几格，末尾即「排到最后」。 */
    function commitDrop(evt, sortable) {
        const from = grids.get(evt.from)?.section || "";
        const to = grids.get(evt.to)?.section || from;
        const id = evt.item?.dataset?.cardId || "";
        if (from !== to && !isCustomCard(draft, id)) {
            sortable?.cancel();
            render();
            return;
        }
        if (from === to) { moveCard(from, evt.oldDraggableIndex, evt.newDraggableIndex); return; }
        const card = draft.custom.find((c) => c.id === id);
        if (card) card.section = to;   // 一张卡属于哪个板块看的就是这个字段
        draft.order[from] = (draft.order[from] || []).filter((x) => x !== id);
        const ids = visibleCards(to, draft).map((c) => c.id).filter((x) => x !== id);
        ids.splice(Math.min(Math.max(0, evt.newDraggableIndex ?? ids.length), ids.length), 0, id);
        draft.order[to] = orderWithHidden(to, ids);
        render();
    }

    /** 添加卡片这一面：上半铺这一板块还没在首页上的预设卡（点一下就进首页），下半是自建卡的表单
     *  （导演配方 / 技能 / 外部链接——内置卡与编辑模式由预设给，表单不重复配）。
     *  两条都只改草稿：预设点一下当场生效，表单要「保存」才落卡，落盘收口在细栏右端那枚「完成」。
     *  表单字段排三行：跳转类型 + 跳转目标、标题 + 副标题、图标 + 板块 */
    function addCardDialog(sectionId) {
        closeCardDialog?.();   // 连删两张卡时只留最新那一面：旧的那一面带着过时的预设清单
        const work = newCard(draft.custom, sectionId);
        // 自动填只动没人碰过的格子：打过字的那一格不覆盖。板块算碰过——点开的是那个板块的占位卡
        const touched = { title: false, sub: false, icon: false, section: true };
        const fields = $el("div", { className: "ns-home-card-dialog-fields" });
        const statusEl = $el("span", { className: "ns-home-card-dialog-status" });
        const presetBox = $el("div", { className: "ns-home-preset-box" });
        let targetField = null;   // 当前那张「跳转目标」字段：跳转类型一变就换掉它
        let shapeBox = null;      // 第二、三行（标题 / 副标题 / 图标 / 板块）：自动填完重画这一块

        /** 预设区重画一次：加进首页的那一张当场从这一面消失，剩下的还在等着点 */
        function paintPresets() {
            const presets = presetCards(sectionId, draft);
            presetBox.replaceChildren(
                $el("span", { className: "ns-home-preset-head", textContent: t("预设卡片") }),
                presets.length
                    ? $el("div", { className: "ns-home-preset-grid" }, presets.map(presetTile))
                    : $el("p", { className: "ns-home-preset-empty",
                        textContent: t("这一板块的预设卡片都已在首页：先在首页删掉一张，再回到这里加回来") }));
        }

        /** 一张预设卡：图标 + 标题 + 副标题，右下角一枚 ＋。点一下就是把这张加进首页 */
        function presetTile(card) {
            return $el("button", {
                className: "ns-home-preset-card", type: "button", dataset: { cardId: card.id },
                title: tf("加到首页：{title}", { title: t(card.title) }),
                onclick: () => { addPreset(card); paintPresets(); },
            }, [
                $el("span", { className: "ns-home-card-icon" }, [icon(card.icon || "sparkles", 20)]),
                $el("span", { className: "ns-home-card-text" }, [
                    $el("span", { className: "ns-home-card-title", textContent: t(card.title) }),
                    $el("span", { className: "ns-home-card-sub", textContent: t(card.sub) }),
                ]),
                icon("plus", 16),
            ]);
        }

        /** 预设加进首页：摘掉 hidden 这一项，卡回到 order 里它原来那一格；
         *  默认不上首页的那一张（特效）本来没有格子，排进板块末尾就是「排过」，这一次保存才把它带上首页 */
        function addPreset(card) {
            draft.hidden = draft.hidden.filter((id) => id !== card.id);
            if (card.defaultHidden) {
                draft.order[card.section] = uniq([...(draft.order[card.section] || []), card.id]);
            }
            render();
        }

        /** 配方名与技能显示名：自动填标题时用的那一份标签 */
        function pickLabel() {
            if (work.target === "recipe") {
                const hit = pickLists.recipes.find((r) => r.name === work.value);
                return hit ? hit.name : "";
            }
            if (work.target === "skill") {
                const hit = pickLists.skills.find((s) => s.id === work.value);
                return hit && host.skillLabel ? host.skillLabel(hit) : "";
            }
            return "";
        }

        /** 按这一发跳转填形状：跳转类型或目标一变，没碰过的格子就换成那一发的标题 / 副标题 / 图标 / 板块 */
        function autoFillShape() {
            const shape = cardShapeForTarget(work.target,
                work.target === "url" ? work.url : work.value, pickLabel());
            for (const key of ["title", "sub", "icon", "section"]) {
                if (!touched[key]) work[key] = shape[key];
            }
            const next = shapeBoxFields();
            fields.replaceChild(next, shapeBox);
            shapeBox = next;
        }

        function shapeBoxFields() {
            const mark = (key) => (v) => { touched[key] = true; work[key] = v; };
            return $el("div", { className: "ns-home-card-dialog-shape" }, [
                inlineField(t("标题"), work.title, mark("title")),
                inlineField(t("副标题"), work.sub, mark("sub")),
                inlineIconPicker(t("图标"), CARD_ICONS, work.icon, mark("icon")),
                inlineSelect(t("板块"), HOME_SECTIONS.map((s) => [s.id, t(s.label)]), work.section || "create",
                    mark("section")),
            ]);
        }

        function targetValueField() {
            const pickTarget = (v) => { work.value = v; autoFillShape(); };
            if (work.target === "url") {
                return inlineField(t("链接地址"), work.url,
                    (v) => { work.url = v; autoFillShape(); }, "https://…");
            }
            // 配方与技能都给了「不指定」这一行：取消选中的那一份，这张卡就只进导演页 / 技能页
            const blank = work.target === "recipe" ? t("不指定（只进导演页）") : t("不指定（只进技能页）");
            // 已经建过卡的配方与技能从候选里摘掉：同一条落点不在首页上摆两张卡（内置卡占的那一条也算）
            const taken = new Set([...draft.custom, ...HOME_CARDS]
                .filter((c) => c.target === work.target).map((c) => c.value));
            const choices = work.target === "recipe"
                ? [["", blank], ...pickLists.recipes.filter((r) => r.type === "video_director" && !taken.has(r.name)).map((r) => [r.name, r.name])]
                : [["", blank], ...pickLists.skills.filter((s) => !taken.has(s.id)).map((s) => [s.id, host.skillLabel ? host.skillLabel(s) : s.id])];
            return inlineSelect(t("跳转目标"), choices, work.value, pickTarget);
        }

        const targetChoices = FORM_TARGETS.map((k) => [k, t(TARGET_LABELS[k])]);
        const targetSelect = inlineSelect(t("跳转类型"), targetChoices, work.target, (v) => {
            work.target = v;
            work.value = "";
            work.url = "";
            const next = targetValueField();
            fields.replaceChild(next, targetField);
            targetField = next;
            autoFillShape();
        });
        targetField = targetValueField();
        shapeBox = shapeBoxFields();
        fields.append(targetSelect, targetField, shapeBox);
        autoFillShape();   // 开局按这一发的落点（导演配方 · 不指定）填好格子，省掉九成空格
        paintPresets();

        function close() {
            overlay.remove();
            document.removeEventListener("keydown", onKey, true);
            if (closeCardDialog === close) closeCardDialog = null;
        }

        function onKey(e) {
            if (e.key === "Escape") { e.stopPropagation(); close(); }   // Esc 只关这一张弹窗，不顺手退出整页编辑
        }

        function commit() {
            // 自建卡的上限由后端守住（_MAX_CUSTOM）：到顶就在这颗钮上说出来，不让人存下一张被丢掉
            if (draft.custom.length >= MAX_CUSTOM) {
                statusEl.textContent = tf("自建卡最多 {n} 张，先删一张", { n: MAX_CUSTOM });
                return;
            }
            const issue = cardFormIssue(work);
            if (issue) { statusEl.textContent = issue; return; }
            const section = HOME_SECTIONS.some((s) => s.id === work.section) ? work.section : "create";
            draft.custom.push({ ...work, section });
            draft.order[section] = uniq([...(draft.order[section] || []), work.id]);
            close();
            render();
        }

        const overlay = $el("div", { className: "ns-libmodal ns-home-card-dialog", role: "dialog", "aria-modal": "true" }, [
            $el("div", { className: "ns-libmodal-box" }, [
                $el("div", { className: "ns-libmodal-titlebar" }, [
                    $el("span", { className: "ns-libmodal-title", textContent: t("添加卡片") }),
                    $el("button", {
                        className: "ns-libmodal-btn ns-libmodal-close", type: "button",
                        title: t("关闭（Esc）"), onclick: close,
                    }, [icon("cross", 14)]),
                ]),
                $el("div", { className: "ns-home-card-dialog-body" }, [
                    presetBox,
                    $el("span", { className: "ns-home-form-head", textContent: t("自建卡片") }),
                    fields,
                ]),
                $el("div", { className: "ns-home-card-dialog-foot" }, [
                    statusEl,
                    $el("button", { className: "ns-btn ns-primary ns-home-card-dialog-save", type: "button", textContent: t("保存"), onclick: commit }),
                    $el("button", { className: "ns-btn ns-home-card-dialog-cancel", type: "button", textContent: t("取消"), onclick: close }),
                ]),
            ]),
        ]);
        overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
        document.addEventListener("keydown", onKey, true);
        document.body.appendChild(overlay);
        closeCardDialog = close;
    }

    /** 弹窗的保存门：与后端同一条门，缺什么就说什么，不让人存下一张上不了首页的卡 */
    function cardFormIssue(card) {
        if (!oneLine(card.title, 40)) return t("先填标题");
        if (card.target === "url" && !safeUrl(card.url)) return t("链接要 http:// 或 https:// 开头");
        // 配方与技能给了「不指定」这一行是合法保存态：空目标就是只进导演页 / 技能页
        return "";
    }

    /** 网格末尾的添加卡片占位卡：点开的是这一板块的添加卡片这一面（预设卡 + 自建卡表单） */
    function addTile(sectionId) {
        return $el("button", {
            className: "ns-home-add-tile", type: "button", title: t("这板块末尾的添加卡片：预设卡片与自建卡"),
            onclick: () => addCardDialog(sectionId),
        }, [icon("plus", 16), " " + t("添加卡片")]);
    }

    function deleteCard(id) {
        draft.custom = draft.custom.filter((c) => c.id !== id);
        draft.hidden = draft.hidden.filter((i) => i !== id);
        for (const key of Object.keys(draft.order)) {
            draft.order[key] = draft.order[key].filter((i) => i !== id);
        }
        render();
    }

    /** 同板块的落位：网格里的格子只数得着首页上那些卡，order 里还留着移出首页的卡，
     *  所以排完可见的那一叠，再按原槽位把移出首页的卡插回去 */
    function moveCard(sectionId, from, to) {
        const ids = visibleCards(sectionId, draft).map((c) => c.id);
        if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return;
        const [item] = ids.splice(from, 1);
        ids.splice(to, 0, item);
        draft.order[sectionId] = orderWithHidden(sectionId, ids);
        render();
    }

    /** 可见顺序写回整条 order：移出首页的卡留在它原来的槽位上，加回来才落回原来那一格 */
    function orderWithHidden(sectionId, visibleIds) {
        const hidden = new Set(draft.hidden);
        const out = [];
        let at = 0;
        for (const id of sectionCards(sectionId, draft).map((c) => c.id)) {
            if (hidden.has(id)) out.push(id);
            else if (at < visibleIds.length) out.push(visibleIds[at++]);
        }
        return uniq([...out, ...visibleIds.slice(at)]);
    }

    render();
    return { bar, load, save, setEntry, decorateHero, decorateCard, decorateGrid, addTile,
        closeDialog: () => closeCardDialog?.() };   // 退出编辑态时收掉这一面：它浮在页上，切了页还留着就是块遮罩
}

function iconBtn(name, title, onclick) {
    return $el("button", {
        className: "ns-btn ns-home-edit-chip", type: "button", title, onclick,
    }, [icon(name, 13)]);
}

function inlineField(label, value, onChange, placeholder) {
    const input = $el("input", {
        className: "ns-home-f-input", type: "text",
        value: value == null ? "" : value, placeholder: placeholder || "",
    });
    input.addEventListener("change", () => onChange(input.value));
    return $el("label", { className: "ns-home-f-field" },
        [$el("span", { className: "ns-home-f-label", textContent: label }), input]);
}

function inlineSelect(label, options, value, onChange) {
    const sel = $el("select", { className: "ns-home-f-select" });
    for (const [v, text] of options) sel.appendChild($el("option", { value: v, textContent: text }));
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    return $el("label", { className: "ns-home-f-field" },
        [$el("span", { className: "ns-home-f-label", textContent: label }), sel]);
}

/** 图标挑一枚：候选直接铺成图标格，点一下就是它。图标名是给写版式的人看的标识，
 *  拿它当选择面等于让用户在「pencil / maximize」里自己认图形 */
function inlineIconPicker(label, names, value, onChange) {
    const box = $el("div", { className: "ns-home-f-icons" });
    const paint = () => {
        for (const b of box.children) {
            const on = b.dataset.icon === value;
            b.classList.toggle("is-on", on);
            b.setAttribute("aria-pressed", on ? "true" : "false");
        }
    };
    for (const name of names) {
        box.appendChild($el("button", {
            className: "ns-home-icon-swatch", type: "button", title: name, dataset: { icon: name },
            onclick: () => { value = name; paint(); onChange(name); },
        }, [icon(name, 18)]));
    }
    paint();
    return $el("div", { className: "ns-home-f-field ns-home-f-icons-field" },
        [$el("span", { className: "ns-home-f-label", textContent: label }), box]);
}

/** 自建卡开局的形状：id 取第一个空号，跳转类型落弹窗能配的第一种，板块由点开的是哪一板块的添加卡片定。
 *  标题 / 副标题 / 图标留空给 autoFillShape 填——自动填只动没人碰过的格子 */
function newCard(custom, sectionId) {
    let n = custom.length + 1;
    while (custom.some((c) => c.id === `custom_${n}`)) n++;
    return {
        id: `custom_${n}`, section: sectionId, title: "", sub: "",
        icon: "play", target: FORM_TARGETS[0], value: "", url: "",
    };
}

function uniq(list) {
    const out = [];
    for (const value of (Array.isArray(list) ? list : [])) {
        const item = String(value);
        if (ID_OK.test(item) && !out.includes(item)) out.push(item);
    }
    return out;
}

/** 这张卡是不是自建卡：内置卡来自注册表，板块定死，搬不出板块 */
function isCustomCard(draft, id) {
    return !!id && draft.custom.some((c) => c.id === id);
}

function oneLine(value, limit) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function safeUrl(value) {
    const text = String(value == null ? "" : value).trim().slice(0, 500);
    return /^https?:\/\//i.test(text) ? text : "";
}

function cleanCustom(item) {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id || "");
    const title = oneLine(item.title, 40);
    // 与后端同一条门（后端 CUSTOM_TARGETS 里 edit 与 page 还在）：旧版式里存的编辑模式卡与直连卡
    // 照读照跳，弹窗新给的卡只可能是 FORM_TARGETS 那三种
    if (!ID_OK.test(id) || !title) return null;
    if (item.target !== LEGACY_TARGET && !HOME_TARGETS.includes(item.target)) return null;
    return {
        id,
        section: HOME_SECTIONS.some((s) => s.id === item.section) ? item.section : "",
        title,
        sub: oneLine(item.sub, 60),
        icon: ICON_NAMES.includes(item.icon) ? item.icon : "",
        target: item.target,
        value: oneLine(item.value, 120),
        url: safeUrl(item.url),
    };
}

