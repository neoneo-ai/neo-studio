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
// 内置预设卡直连本页（page）；自建卡的跳转类型只有 HOME_TARGETS 那四种。page 只在旧版式里存着的卡上
// 出现：读得回来、跳得动，编辑器不再给这一项（HOME_TARGETS 与 LEGACY_TARGET 分开就是为这个）。
export const HOME_CARDS = [
    { id: "paint", section: "create", icon: "sparkles", title: "生成图片", sub: "描述画面，直接出图", target: "page", value: "paint" },
    { id: "video", section: "create", icon: "film", title: "生成视频", sub: "一句话加首帧，出一段视频", target: "page", value: "video" },
    { id: "director", section: "create", icon: "play", title: "导演视频", sub: "多段配方，生成整片视频", target: "page", value: "director" },
    { id: "pose", section: "create", icon: "pose", title: "3D 姿势", sub: "姿势 · 整场 · 全景", target: "page", value: "pose" },
    { id: "agent", section: "create", icon: "target", title: "智能体", sub: "说出目标，工具链多轮跑完", target: "page", value: "agent" },
    { id: "edit-normal", section: "edit", icon: "pencil", title: "图片编辑", sub: "写下要改成什么样，整图重绘", target: "edit", value: "normal" },
    { id: "edit-outpaint", section: "edit", icon: "maximize", title: "扩图", sub: "拖框定四边留白，补全周边场景", target: "edit", value: "outpaint" },
    { id: "edit-local", section: "edit", icon: "pencil", title: "局部", sub: "涂抹要改的区域，高分重绘并合回原图", target: "edit", value: "local" },
    { id: "edit-remove", section: "edit", icon: "cross", title: "删除", sub: "点掉要删的物体，分割后移除", target: "edit", value: "remove" },
    { id: "edit-angle", section: "edit", icon: "camera", title: "机位", sub: "拖机位球换角度重出这张", target: "edit", value: "angle" },
    { id: "edit-blend", section: "edit", icon: "copy", title: "融合", sub: "多张参考图融成一张连贯画面", target: "edit", value: "blend" },
    { id: "edit-pose", section: "edit", icon: "user", title: "姿势", sub: "骨架图锁姿势，重出这一张", target: "edit", value: "pose" },
    { id: "frames", section: "edit", icon: "film", title: "视频抽帧", sub: "挑一条视频，抽帧存进素材库", target: "page", value: "frames" },
    { id: "gallery", section: "material", icon: "folder", title: "素材库", sub: "浏览与管理全部生成素材", target: "page", value: "gallery" },
    { id: "skills", section: "material", icon: "wand", title: "技能", sub: "管理预设与技能包", target: "page", value: "skills" },
    { id: "settings", section: "material", icon: "gear", title: "设置", sub: "生成默认值与界面语言", target: "page", value: "settings" },
];

export const HOME_HERO = {
    title: "今天想", accent: "创作", suffix: "什么？",
    sub: "一句话到一段成片，全部在你自己的电脑上完成", cta: "一句话出图",
};

export const HOME_PAGES = ["home", "gallery", "paint", "edit", "video", "director",
                           "pose", "agent", "frames", "skills", "settings"];
// 编辑页那一发模式的清单与 image-edit-panel.js 的模式 chip 同源同序：少一个就是首页少一张直达卡
export const HOME_EDIT_MODES = ["normal", "outpaint", "local", "remove", "blend", "pose", "angle"];
export const HOME_TARGETS = ["edit", "recipe", "skill", "url"];   // 自建卡能配的四种跳转
export const LEGACY_TARGET = "page";   // 旧版式里存的直连卡：读得回来跳得动，弹窗只给已经在用它的人看
export const HOME_COLS = [0, 2, 3, 4, 5];   // 0 = 跟随窗口档位；窄档与手机自己收到 2 / 1 列

const LAYOUT_PATH = "/neo_home/layout";
const ID_OK = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,39}$/;
const MAX_CUSTOM = 20;
const PAGE_LABELS = {
    home: "首页", gallery: "素材库", paint: "绘画", edit: "图片编辑", video: "视频",
    director: "导演", pose: "3D 姿势", agent: "智能体", frames: "视频抽帧", skills: "技能", settings: "设置",
};
const TARGET_LABELS = { page: "页面（旧版直连）", edit: "编辑模式", url: "外部链接", recipe: "导演配方", skill: "技能" };
const EDIT_MODE_LABELS = {
    normal: "图片编辑", outpaint: "扩图", local: "局部", remove: "删除",
    blend: "融合", pose: "姿势", angle: "机位",
};
const HERO_KEYS = ["title", "accent", "suffix", "sub", "cta"];

/** 跳转类型 + 跳转目标定了这张卡要去哪，形状就按那一发填：内置卡表里同一条目的标题 / 副标题 / 图标 / 板块直接拿来，
 *  配方 / 技能 / 外部链接没有内置条目就落一份对应落点的默认形状。label 是配方名或技能显示名 */
export function cardShapeForTarget(target, value, label = "") {
    const twin = HOME_CARDS.find((c) => c.target === target && c.value === value);
    if (twin) return { title: twin.title, sub: twin.sub, icon: twin.icon, section: twin.section };
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

/** 一个板块的全部卡片（含隐藏的：表单要能把它排回原位）；认不出的 id 丢掉，新卡补在末尾 */
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
    return [...saved, ...pool.filter((c) => !taken.has(c))];
}

/** 首页上真出现的那一叠卡 */
export function visibleCards(sectionId, layout) {
    return sectionCards(sectionId, layout).filter((c) => !layout.hidden.includes(c.id));
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
    const known = new Set(HOME_CARDS.map((c) => c.id));
    custom.forEach((c) => known.add(c.id));
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
        hidden: uniq(data.hidden).filter((id) => known.has(id)),
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

    /** 卡片上长出的控件：显隐（自建卡多「编辑这张卡」与「删除这张卡」）。整张卡就是拖动手势，不设手柄与上下移 */
    function decorateCard(cardEl, ctx) {
        const { section, card } = ctx;
        const isCustom = draft.custom.some((c) => c.id === card.id);
        const hidden = draft.hidden.includes(card.id);
        cardEl.classList.toggle("is-custom", isCustom);
        cardEl.classList.toggle("is-hidden-card", hidden);
        cardEl.appendChild($el("span", { className: "ns-home-card-tools" }, [
            iconBtn("eye", hidden ? t("显示这张卡") : t("隐藏这张卡"), () => toggleCard(card.id), hidden),
            ...(isCustom ? [
                iconBtn("pencil", t("编辑这张卡"), () => openCardDialog(card, false)),
                iconBtn("trash", t("删除这张卡"), () => deleteCard(card.id)),
            ] : []),
        ]));
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
        const ids = sectionCards(to, draft).map((c) => c.id).filter((x) => x !== id);
        ids.splice(Math.min(Math.max(0, evt.newDraggableIndex ?? ids.length), ids.length), 0, id);
        draft.order[to] = uniq(ids);
        render();
    }

    /** 自建卡的编辑弹窗：新建与编辑同一条路。填在一份副本上，「保存」才进草稿，「取消」与 Esc 丢掉这一份。
     *  字段排三行：跳转类型 + 跳转目标、标题 + 副标题、图标 + 板块 */
    function openCardDialog(card, isNew) {
        const work = { ...card };
        // 自动填只动没人碰过的格子：打过字的那一格不覆盖。板块算碰过——占位卡点的是那个板块
        const touched = { title: !isNew, sub: !isNew, icon: !isNew, section: true };
        const fields = $el("div", { className: "ns-home-card-dialog-fields" });
        const statusEl = $el("span", { className: "ns-home-card-dialog-status" });
        let targetField = null;   // 当前那张「跳转目标」字段：跳转类型一变就换掉它
        let shapeBox = null;      // 第二、三行（标题 / 副标题 / 图标 / 板块）：自动填完重画这一块

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
                inlineSelect(t("图标"), ICON_NAMES.map((n) => [n, n]), work.icon || "sparkles", mark("icon")),
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
            if (work.target === "edit") {
                // 编辑模式必落一个：这一发没有模式就没有落点，空值进不了这张下拉
                if (!HOME_EDIT_MODES.includes(work.value)) work.value = HOME_EDIT_MODES[0];
                return inlineSelect(t("跳转目标"), HOME_EDIT_MODES.map((m) => [m, t(EDIT_MODE_LABELS[m] || m)]),
                    work.value, pickTarget);
            }
            // 配方与技能都给了「不指定」这一行：取消选中的那一份，这张卡就只进导演页 / 技能页
            const blank = work.target === "recipe" ? t("不指定（只进导演页）") : t("不指定（只进技能页）");
            const choices = work.target === LEGACY_TARGET
                ? HOME_PAGES.map((p) => [p, t(PAGE_LABELS[p] || p)])
                : work.target === "recipe"
                    ? [[ "", blank], ...pickLists.recipes.filter((r) => r.type === "video_director").map((r) => [r.name, r.name])]
                    : [[ "", blank], ...pickLists.skills.map((s) => [s.id, host.skillLabel ? host.skillLabel(s) : s.id])];
            return inlineSelect(t("跳转目标"), choices, work.value, pickTarget);
        }

        const targetChoices = HOME_TARGETS.map((k) => [k, t(TARGET_LABELS[k])]);
        // 旧版式里的直连卡留着这一行：铅笔开弹窗不会把它的跳转类型静默换掉
        if (work.target === LEGACY_TARGET) targetChoices.push([LEGACY_TARGET, t(TARGET_LABELS[LEGACY_TARGET])]);

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
        if (isNew) autoFillShape();   // 新建：这一发的落点已定（编辑模式 + 图片编辑），格子开局就填好

        function close() {
            overlay.remove();
            document.removeEventListener("keydown", onKey, true);
        }

        function onKey(e) {
            if (e.key === "Escape") { e.stopPropagation(); close(); }   // Esc 只关这一张弹窗，不顺手退出整页编辑
        }

        function commit() {
            const issue = cardFormIssue(work);
            if (issue) { statusEl.textContent = issue; return; }
            const section = HOME_SECTIONS.some((s) => s.id === work.section) ? work.section : "create";
            const saved = { ...work, section };
            if (isNew) {
                draft.custom.push(saved);
                draft.order[section] = uniq([...(draft.order[section] || []), saved.id]);
            } else {
                const at = draft.custom.findIndex((c) => c.id === saved.id);
                if (at >= 0) draft.custom[at] = saved;
                moveCustomTo(saved, section);   // 板块改了就把这张卡搬到新板块末尾
            }
            close();
            render();
        }

        const overlay = $el("div", { className: "ns-libmodal ns-home-card-dialog", role: "dialog", "aria-modal": "true" }, [
            $el("div", { className: "ns-libmodal-box" }, [
                $el("div", { className: "ns-libmodal-titlebar" }, [
                    $el("span", { className: "ns-libmodal-title", textContent: isNew ? t("添加卡片") : t("编辑卡片") }),
                    $el("button", {
                        className: "ns-libmodal-btn ns-libmodal-close", type: "button",
                        title: t("关闭（Esc）"), onclick: close,
                    }, [icon("cross", 14)]),
                ]),
                fields,
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
    }

    /** 弹窗的保存门：与后端同一条门，缺什么就说什么，不让人存下一张上不了首页的卡 */
    function cardFormIssue(card) {
        if (!oneLine(card.title, 40)) return t("先填标题");
        if (card.target === "url" && !safeUrl(card.url)) return t("链接要 http:// 或 https:// 开头");
        if (card.target === "edit" && !HOME_EDIT_MODES.includes(card.value)) return t("选一个编辑模式");
        if (card.target === LEGACY_TARGET && !HOME_PAGES.includes(card.value)) return t("跳转类型要一个目标");
        // 配方与技能给了「不指定」这一行是合法保存态：空目标就是只进导演页 / 技能页
        return "";
    }

    /** 网格末尾的占位卡：点一下开新建弹窗，保存了才在这板块末尾落这张卡 */
    function addTile(sectionId) {
        return $el("button", {
            className: "ns-home-add-tile", type: "button", title: t("在这板块末尾加一张自建卡"),
            onclick: () => {
                const card = newCard(draft.custom);
                card.section = sectionId;
                openCardDialog(card, true);
            },
        }, [icon("plus", 16), " " + t("添加卡片")]);
    }

    function toggleCard(id) {
        draft.hidden = draft.hidden.includes(id) ? draft.hidden.filter((i) => i !== id) : uniq([...draft.hidden, id]);
        render();
    }

    function deleteCard(id) {
        draft.custom = draft.custom.filter((c) => c.id !== id);
        draft.hidden = draft.hidden.filter((i) => i !== id);
        for (const key of Object.keys(draft.order)) {
            draft.order[key] = draft.order[key].filter((i) => i !== id);
        }
        render();
    }

    function moveCustomTo(card, sectionId) {
        const from = card.section || "create";
        draft.order[from] = (draft.order[from] || []).filter((id) => id !== card.id);
        card.section = sectionId;
        draft.order[sectionId] = uniq([...(draft.order[sectionId] || []), card.id]);
        render();
    }

    function moveCard(sectionId, from, to) {
        const list = sectionCards(sectionId, draft);
        if (to < 0 || to >= list.length) return;
        const [item] = list.splice(from, 1);
        list.splice(to, 0, item);
        draft.order[sectionId] = list.map((c) => c.id);
        render();
    }

    render();
    return { bar, load, save, setEntry, decorateHero, decorateCard, decorateGrid, addTile };
}

function iconBtn(name, title, onclick, on) {
    return $el("button", {
        className: "ns-btn ns-home-edit-chip" + (on ? " is-on" : ""), type: "button", title, onclick,
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
    // 旧版式里存着的值在候选里认不出时留一行原值：用户改一下就正了，界面不会假装它是空选项
    if (value && !options.some(([v]) => v === value)) {
        sel.appendChild($el("option", { value, textContent: value }));
    }
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    return $el("label", { className: "ns-home-f-field" },
        [$el("span", { className: "ns-home-f-label", textContent: label }), sel]);
}

function newCard(custom) {
    let n = custom.length + 1;
    while (custom.some((c) => c.id === `custom_${n}`)) n++;
    return {
        id: `custom_${n}`, section: "create", title: t("新卡片"), sub: "",
        icon: "image", target: "edit", value: "normal", url: "",
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
    // 与后端同一条门（后端 CUSTOM_TARGETS 里 page 还在）：旧版式里存的直连卡照读照跳，
    // 弹窗新给的卡只可能是 HOME_TARGETS 那四种
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

