// 首页（#/home）：意图卡片页——大字标题 + 板块卡片，点卡直达对应页；右上角入口把这一页切进原地编辑。
// 卡表、板块表与版式形状在 web/studio/home-layout.js，「这一张卡落哪一屏」认的是 web/studio/app-registry.js
// 里的那一名页；编辑态长在这份 DOM 上：每张卡长出一枚删除，板块末尾一枚「添加卡片」开预设卡与自建卡表单，
// 标题区直接点字改，细栏只管列数与开关；落盘在细栏右端那枚「完成」。
// 工厂只接装配层给得出的那几样：切页、深链重路由、桌面外链、编辑页的模式落点与生图面板选技能。
import { t, tf } from "../../js/core/i18n.js";
import { icon } from "../../js/core/icons.js";
import { openImageEditMode, openVideoReuse } from "../../gallery-gen.js";
import { listRecipes, listVideoSkills } from "../../recipes.js";
import { listSkills, skillDisplayName } from "../../skill.js";
import { appById } from "../app-registry.js";
import { HOME_SECTIONS, createHomeInlineEditor, heroText, layoutSections, loadHomeLayout, normalizeLayout, sectionOrder, visibleCards } from "../home-layout.js";

export function createHomePage({ $el, toast, go, route, currentView, openExternalUrl, paintEdit }) {
// ====== 首页：意图卡片 —— 大字标题 + 板块卡片，点卡直达对应页；右上角入口把这一页切进原地编辑 ======
// 卡表、板块表与版式形状在 web/studio/home-layout.js；这一块只管 DOM 与「这张卡跳到哪一屏」，
// 编辑态长在这份 DOM 上：每张卡长出一枚删除，板块末尾一枚「添加卡片」开预设卡与自建卡表单，
// 标题区直接点字改，细栏只管列数与开关；落盘在细栏右端那枚「完成」。
// 版式是数据根里的一份文件（configs/home_layout.json）：插件页、桌面窗口、手机页打开同一份首页。
const HOME_QUICK_LEAVE_MS = 260;   // 指针从「首页」那一格跨进面板这几像素的宽限：不留宽限就是跨一步闪收
const HOME_QUICK_EDGE = 8;          // 面板夹进窗口的边距，与 style.css 的 8px 同一份常量
const HOME_QUICK_GAP = 10;          // 面板顶沿离顶栏底沿的间距：页签自己的矩形只到那一格，贴着它画就是把面板压在页签那一行上
const HOME_QUICK_COLS = 2;          // 面板固定两列（创作｜编辑）：列数随窗口高度起落就是在宽窗口里拉出一条伸出屏外的长条
const HOME_QUICK_MIN_H = 120;       // 面板封顶的最小高：窗口矮到顶沿以下放不下时也不把这块控件压成零高，条目裁在里面
// 「素材与配置」整块不进这一列：素材库在顶栏那一格、设置在顶栏右端那枚齿轮、技能在首页那张卡里都有直达，
// 快捷入口只留创作与编辑那两板块的路（首页本身照旧铺这三张卡）
const HOME_QUICK_SKIP_SECTIONS = ["material"];

let homeViewEl = null;                    // 首页视图元素；版式到达后重画这一块
let homeLayout = normalizeLayout({});     // 首页按这一份画：编辑期间是草稿，平时是已落盘的版式
let homeStored = homeLayout;              // 已落盘的版式：退出编辑落回它，页面上未保存的草稿不留
let homeEditing = false;
let homeSaving = false;               // 「完成」在飞的这一发：不让人连点成两次 POST
let homeEditor = null;
let homeQuickEl = null;             // 悬浮快速入口的根：钉在 body 上，left/top 按顶栏「首页」那一格的矩形写
let homeQuickPanel = null;          // 面板本体（多列 grid 在这一层）：每次浮出按可视高度分列重画
let homeQuickTimer = null;          // 指针离开页签或面板之后的收起计时

function buildHome(el) {
    el.classList.add("ns-home");
    homeViewEl = el;
    homeEditor = createHomeInlineEditor({
        listRecipes, listSkills, skillLabel: skillDisplayName, toast,
        onDraft: (draft) => { if (!homeEditing) return; homeLayout = draft; renderHome(); },
    });
    renderHome();
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        // Esc 弃草稿退出：落盘只有「完成」这一条路，切页也一样丢草稿
        if (homeEditing) stopHomeEdit();
    });
}

function startHomeEdit() {
    homeStored = homeLayout;
    homeEditing = true;
    renderHome();
    homeEditor.load().catch(e => console.error("[Neo Studio] home layout load failed:", e));
}

function stopHomeEdit() {
    if (!homeEditing) return;
    homeEditing = false;
    homeEditor?.closeDialog();   // 添加卡片这一面浮在页上：退出编辑态不能留一块遮罩
    homeLayout = homeStored;
    renderHome();
}

/** 「完成」= 保存版式并退出：保存收口在这枚入口上，细栏不再管落盘。
 *  保存没成就留在编辑态——页面上这份草稿不能随着一次失败的 POST 消失 */
async function finishHomeEdit() {
    if (homeSaving) return;
    homeSaving = true;
    renderHome();
    try {
        await homeEditor.save();
        toast(t("已保存：插件页、桌面窗口与手机页的首页同步生效"));
    } catch (e) {
        toast(tf("保存失败：{msg}", { msg: String(e?.message || e) }));
    } finally {
        homeSaving = false;
        renderHome();
    }
}

function renderHome() {
    if (!homeViewEl) return;   // 首页还没建：buildHome 建的时候直接按当前版式铺
    const kids = [];
    if (homeEditing) kids.push(homeEditor.bar);
    if (homeEditing || !homeLayout.hero.off) {
        const hero = homeHeroEl();
        if (homeEditing) homeEditor.decorateHero(hero);   // 编辑态连收起的标题区一起出：不出就点不回来
        kids.push(hero);
    }
    const blocks = [];
    for (const section of homeSections()) {
        const part = homeSectionBlock(section);
        if (part) blocks.push(...part);
    }
    kids.push($el("div", { className: "ns-home-inner" }, blocks.length ? blocks : [
        $el("p", { className: "ns-home-empty", textContent: t("首页卡片已全部移除，在「编辑首页」的添加卡片里加回来。") }),
    ]));
    // disabled 走属性：$el 认不出的键一律 setAttribute，disabled:false 写出来就是 disabled="false"，
    // 属性一在就是禁用 —— 这颗钮在窗口里点了没反应就是这么来的
    const entry = $el("button", {
        className: "ns-btn ns-home-edit-entry", type: "button",
        title: homeEditing ? t("完成首页编辑：保存版式并退出")
            : t("编辑首页：卡片顺序、删除与添加卡片、标题区文案、网格列数"),
        onclick: () => (homeEditing ? finishHomeEdit() : startHomeEdit()),
    }, homeEditing
        ? [icon("save", 14), " " + t("完成")]
        : [icon("gear", 14), " " + t("编辑首页")]);
    entry.disabled = homeSaving;
    // 编辑态的「完成」交进细栏右端：细栏钉在首页顶缘，滚到哪一屏都点得着完成；
    // 浏览态入口自己站在首页右上角，跟着页面滚
    if (homeEditing) homeEditor.setEntry(entry);
    else kids.push(entry);
    homeViewEl.replaceChildren(...kids);
    homeViewEl.classList.toggle("ns-home-editing", homeEditing);
    // 落位手势要交在已挂载的网格上：Sortable 的实例建在脱离文档的元素上只认得「拖起来」，认不出落点
    // （真浏览器实测：拖起、emulateDragOver、onDragOver 都跑，就是不换行）。replaceChildren 之后才在文档里。
    if (homeEditing) {
        for (const grid of homeViewEl.querySelectorAll(".ns-home-grid")) {
            homeEditor.decorateGrid(grid, grid.dataset.section || "");
        }
    }
}

/* ====== 悬浮快速入口：鼠标落在顶栏「首页」那一格上（当前不在首页时）浮出的直达面板 ======
   条目读的就是首页那一叠（layoutSections 的板块序 + visibleCards 的卡序），跳转落在 openHomeCard——
   浮窗不养第二套卡表，也不给一张首页上没有、点了只会失败的入口。
   列数固定两块（一块板块一列）：列数随窗口高度起落就是在宽窗口里拉出一条一路伸出屏外的长条；整块不滚（要滚起来的菜单不算快捷入口）。
   根钉在 body 上、left 由那一格的矩形写、top 由顶栏整条的底沿写：顶栏横滚、右侧控件吃掉宽度时它照旧落在那一行之下 */

function homeQuickRoot() {
    if (homeQuickEl) return homeQuickEl;
    homeQuickPanel = $el("div", { className: "ns-home-quick-panel" });
    homeQuickEl = $el("div", { className: "ns-home-quick ns-hidden" }, [homeQuickPanel]);
    document.body.appendChild(homeQuickEl);
    return homeQuickEl;
}

/** 分列：一块板块占一列，整块不劈开、每块自带列头，列数固定两列。
 *  列数不看窗口高度：宽窗口里一列装得下两块就会拉出一条一路伸出屏外的长条，快捷入口就变成要滚的清单。
 *  没有板块带条目时返回空表，调用方不浮出 */
function homeQuickColumns() {
    return layoutSections(homeLayout)
        .filter((s) => !HOME_QUICK_SKIP_SECTIONS.includes(s.id))
        .map((s) => ({ label: s.label, cards: visibleCards(s.id, homeLayout) }))
        .filter((g) => g.cards.length)
        .slice(0, HOME_QUICK_COLS)   // 旧版式里板块多于两块：第三块起不进这一列
        .map((group) => [group]);
}

/** 画面板：一列一块，列数交给 CSS 的 grid（grid-template-columns 读这个自定义属性，宽度 = 列数 × 单列宽） */
function renderHomeQuick(columns) {
    homeQuickRoot();
    homeQuickPanel.replaceChildren(...columns.map((blocks) => $el("div", { className: "ns-home-quick-col" },
        blocks.flatMap((group) => [
            $el("div", { className: "ns-home-quick-label", textContent: t(group.label) }),
            ...group.cards.map(homeQuickItem),
        ]))));
    homeQuickEl.style.setProperty("--ns-home-quick-cols", String(columns.length));
    return homeQuickEl;
}

function homeQuickItem(card) {
    // 图标与两行字就是首页那张卡的形状，跳转是 openHomeCard 那一条现成的路：这一列不认第二套目标。
    // 保活与收起挂在条目上——面板本体不吃指针事件，落在空白处的事件穿到浮窗下面那一页
    return $el("button", {
        className: "ns-home-quick-item", type: "button", dataset: { cardId: card.id },
        onclick: () => { closeHomeQuick(); openHomeCard(card); },
        onpointerenter: () => clearTimeout(homeQuickTimer),
        onpointerleave: scheduleHomeQuickClose,
        onfocus: () => clearTimeout(homeQuickTimer),
        onblur: scheduleHomeQuickClose,
    }, [
        $el("span", { className: "ns-home-quick-icon" }, [icon(card.icon || "sparkles", 18)]),
        $el("span", { className: "ns-home-quick-text" }, [
            $el("span", { className: "ns-home-quick-name", textContent: t(card.title) }),
            $el("span", { className: "ns-home-quick-sub", textContent: t(card.sub) }),
        ]),
    ]);
}

/** 浮出：鼠标落上与键盘 Tab 落上同一条路。已经站在首页上就不浮——那一页不缺这一列 */
function openHomeQuick() {
    clearTimeout(homeQuickTimer);
    if (currentView() === "home") return;
    // 触屏档没有 hover：点那一格就是进首页。不在这里闪一列浮窗，tap 的 pointerenter 会让它闪一下
    if (!window.matchMedia("(hover: hover)").matches) return;
    const tab = document.querySelector('.ns-tabs a[data-tab="home"]');
    const rect = tab.getBoundingClientRect();
    // 落点锚在顶栏整条的底沿：页签的矩形只到那一格自己，贴着它画就是把面板压在页签那一行下沿上
    const barBottom = (tab.closest(".ns-header") || tab.parentElement).getBoundingClientRect().bottom;
    const columns = homeQuickColumns();
    if (!columns.length) return;
    const root = renderHomeQuick(columns);
    root.classList.remove("ns-hidden");   // 先上屏才量得出面板宽；位置在同一个 task 里钉好，中间不落地
    const left = Math.max(HOME_QUICK_EDGE, Math.min(rect.left, window.innerWidth - root.offsetWidth - HOME_QUICK_EDGE));
    // 顶沿只钉在顶栏底沿之下：窗口再矮也不把面板顶到页签那一行上去——压住页签的浮窗没人点得准
    const top = barBottom + HOME_QUICK_GAP;
    // 面板按顶沿以下的剩余高度封顶（CSS 的 max-height 是静态底线，这里按当次落点算准）：整块进窗口，装不下的尾部裁在面板里
    root.querySelector(".ns-home-quick-panel").style.maxHeight =
        `${Math.max(HOME_QUICK_MIN_H, window.innerHeight - top - HOME_QUICK_EDGE)}px`;
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
}

/** 指针离开那一格或面板就收起；这一段宽限是给「从页签跨进面板」那几步指针留的，跨过去不算离开 */
function scheduleHomeQuickClose() {
    clearTimeout(homeQuickTimer);
    homeQuickTimer = setTimeout(closeHomeQuick, HOME_QUICK_LEAVE_MS);
}

function closeHomeQuick() {
    clearTimeout(homeQuickTimer);
    if (homeQuickEl) homeQuickEl.classList.add("ns-hidden");
}

// 旧版式里收起的板块在编辑态连卡一起铺回来：这一版不给收起开关，收起状态在「完成」落盘时被清成展开
function homeSections() {
    const ids = homeEditing ? sectionOrder(homeLayout) : layoutSections(homeLayout).map((s) => s.id);
    return ids.map((id) => HOME_SECTIONS.find((s) => s.id === id)).filter(Boolean);
}

function homeSectionBlock(section) {
    const off = homeLayout.hidden_sections.includes(section.id);
    const cards = visibleCards(section.id, homeLayout);   // 编辑态铺的也是这一叠：移出首页的卡在添加卡片弹窗里等着
    if (!homeEditing && (off || !cards.length)) return null;   // 收起的板块与没有卡的板块整块不出，不留空标题
    const title = $el("h2", { className: "ns-home-section" + (off ? " is-off" : "") }, [t(section.label)]);
    if (off) title.appendChild($el("span", { className: "ns-home-off-tag", textContent: t("已收起") }));
    return [title, homeGrid(cards, section.id)];
}

function homeHeroEl() {
    const hero = heroText(homeLayout);
    const off = homeLayout.hero.off;
    const kids = [
        $el("h1", {}, [
            $el("span", { dataset: { heroKey: "title" } }, [t(hero.title)]),
            $el("span", { className: "ns-home-accent", dataset: { heroKey: "accent" } }, [t(hero.accent)]),
            $el("span", { dataset: { heroKey: "suffix" } }, [t(hero.suffix)]),
        ]),
        $el("p", { dataset: { heroKey: "sub" } }, [t(hero.sub)]),
    ];
    if (homeEditing || !homeLayout.hero.cta_off) {
        kids.push($el("button", {
            className: "ns-home-cta", type: "button", dataset: { heroKey: "cta" }, textContent: t(hero.cta),
            onclick: () => { if (!homeEditing) go("paint"); },
        }));
    }
    return $el("div", { className: "ns-home-hero" + (off ? " is-off" : "") }, kids);
}

function homeGrid(cards, sectionId) {
    const grid = $el("div", { className: "ns-home-grid", dataset: { section: sectionId } });
    cards.forEach((card, index) => {
        const el = homeCard(card);
        grid.appendChild(el);
        if (homeEditing) homeEditor.decorateCard(el, { section: sectionId, card, index });
    });
    if (homeEditing) grid.appendChild(homeEditor.addTile(sectionId));
    // 落位手势不在这里交：这一会儿网格还没挂上文档，renderHome 挂载完再交（见 renderHome 末尾）
    if (homeLayout.cols) grid.style.setProperty("--ns-home-cols", String(homeLayout.cols));
    return grid;
}

function homeCard(card) {
    // 编辑期间这张卡上的控件改的是草稿：卡面本身不跳屏——跳到别的页，页面上这份未保存的草稿就没了
    // data-card-id 是给拖拽落位认卡用的：预览与落位都按这张卡的 id 找位置
    return $el("button", {
        className: "ns-home-card", type: "button", dataset: { cardId: card.id },
        onclick: () => { if (!homeEditing) openHomeCard(card); },
    }, [
        $el("span", { className: "ns-home-card-icon" }, [icon(card.icon || "sparkles", 22)]),
        $el("span", { className: "ns-home-card-text" }, [
            $el("span", { className: "ns-home-card-title", textContent: t(card.title) }),
            $el("span", { className: "ns-home-card-sub", textContent: t(card.sub) }),
        ]),
        icon("chevron", 16),
    ]);
}

// 一张卡的落地：内置卡与自建卡同一条路，跳转全按卡上的 target / value 这份数据走
function openHomeCard(card) {
    if (card.target === "url") { if (card.url) openExternalUrl(card.url); return; }
    if (card.target === "edit") { goEditMode(card.value || "normal"); return; }
    if (card.target === "recipe") { goDirectorRecipe(card.value); return; }
    if (card.target === "skill") { goSkillApply(card.value); return; }
    go(card.value || "home");
}

// 「编辑」板块的直达卡：先确保编辑页那块面板已铺好（go 走 route，视图没建就建），再把这一发的模式带进去
function goEditMode(mode) {
    go("edit");
    openImageEditMode(mode);
}

// 配方卡与技能卡靠深链进那一页：导演页与技能页各自把「按名字打开」那一条路交给这里
function goDirectorRecipe(name) {
    if (!name) { go("director"); return; }
    history.pushState(null, "", `#/director?recipe=${encodeURIComponent(name)}`);
    route();
}

// 技能卡的落点是这张技能的应用页：技能 frontmatter 写了 landing 就落它声明的那一页
// （app-registry.js 里认得出的那一名，写歪了就当没写）；没写的照旧走两条启发——
// 视频技能进视频页选中它，生图技能进输入页选中它。
// 增强类、模板类技能在这两页的技能下拉里都没有位置：没有可直达的应用页就说清楚再落技能页，不装能跳。
async function goSkillApply(id) {
    if (!id) { go("skills"); return; }
    const [videoSkills, skills] = await Promise.all([
        listVideoSkills().catch(() => []),
        listSkills().catch(() => []),
    ]);
    const meta = skills.find((s) => s.id === id);
    const landing = meta?.landing;
    if (appById(landing)) {
        // 视频页那一发要把这张技能选中在技能下拉上，走的是出视频页那条现成预填链
        if (landing === "video") { openVideoReuse({ skill: id }); return; }
        go(landing);
        if (landing === "paint") paintEdit.selectSkill(id);   // 生图面板自己选中这张技能
        return;
    }
    if (videoSkills.some((s) => s.id === id)) { openVideoReuse({ skill: id }); return; }
    if (meta?.gen_image) {
        go("paint");
        paintEdit.selectSkill(id);   // 技能不在本页候选里时面板自己就不填
        return;
    }
    toast(t("这张技能没有可直达的应用页（不是生图 / 生视频技能），先进技能页"));
    go("skills");
}

// 启动读一次版式（不挡启动链：先出默认版式，版式到了再重画）；编辑控件落盘后同一条事件重画并退出编辑
function initHomeLayout() {
    loadHomeLayout().then((stored) => {
        if (!stored) return;   // 比这版插件老的构建没有这条接口：首页停在注册表默认版式
        homeStored = stored;
        if (homeEditing) return;   // 编辑期间晚到的这一份读回不能盖掉页面上那份草稿
        homeLayout = stored;
        renderHome();
    });
    window.addEventListener("neo:home-layout", (e) => {
        homeLayout = normalizeLayout(e.detail);
        homeStored = homeLayout;   // 保存与恢复默认交回来的就是已落盘的版式：编辑态到此结束
        homeEditing = false;
        renderHome();
    });
}
    return { buildHome, startHomeEdit, stopHomeEdit, openHomeQuick, closeHomeQuick, scheduleHomeQuickClose, initHomeLayout, renderHome, openHomeCard };
}
