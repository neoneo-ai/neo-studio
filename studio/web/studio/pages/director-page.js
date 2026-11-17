// 导演页（#/director）：顶部条 + 上结果舞台 + 下生成坞（时间轴 / 该段 / 素材槽 / 参数行）。
// 页里自己铺的：配方弹窗与配方面板、整片生成（提交 / 状态事件 / 轮询兜底 / 取消）、实时预览订阅与成片定格、
// 时间轴与段菜单、技能胶囊与整片参数表单、素材槽取用、新建与保存配方、director_spec 回显。
// 生成模式分组 / 默认技能 / input 缩略图 / copy_to_input 是装配层与出视频页共用的那一份词汇，由宿主交进来；
// 素材库弹窗、生成能力门、智能体上下文与故事板页的让位也是宿主交进来，本页交回去三条跨页落点。
import { t, tf } from "../../js/core/i18n.js";
import { icon, setIcon, setIconLabel } from "../../js/core/icons.js";
import { createLibraryModal } from "../../js/core/lib-modal.js";
import { createMediaSlot } from "../../js/core/media-slot.js";
import { openDirectorEditor, createSegmentOps, createSharedConfigSection, DIRECTOR_RECIPE_SAVED_EVENT, LEGACY_MODE_MAP } from "../../director.js";
import { DirectorTimeline } from "../../director-timeline.js";
import { ratioGlyph, skillParamsChip } from "../../gallery-gen.js";
import { createFramePlayer } from "../../live-preview.js";
import { createRecipesPanel, listRecipes, listVideoSkills } from "../../recipes.js";
import { createVideoModelConfigSection, listVideoGenModels, getSkillGenConfig } from "../../image-gen.js";
import { skillDisplayName } from "../../skill.js";
import { queueTrack } from "../../queue-panel.js";

/** @typedef {Object} DirectorPageHost
 *  @property {Function} $el 建元素
 *  @property {Object} api 取接口与事件：预览帧与任务状态都从这上面来
 *  @property {Function} toast 提示文本
 *  @property {Function} currentView 当前显示的视图名（隐藏期间不拉 spec）
 *  @property {Function} openLibModal 开素材库弹窗
 *  @property {Function} closeLibModal 收素材库弹窗
 *  @property {Function} gateRunButton 离线 / 内核未就绪时收起生成入口
 *  @property {Function} setAgentRecipe 把智能体上下文挪到刚选中的那份配方
 *  @property {Function} releaseStoryboardEditor 开整片编辑器前先收回故事板页内嵌那一份
 *  @property {Function} thumbSrc input/ 里素材的缩略图 URL
 *  @property {Function} copyPickedToInput 素材库选中的文件落进 input 根目录
 *  @property {Function} modeGroup 技能归到哪一组生成模式（与出视频页同一份词汇）
 *  @property {Function} defaultSkill 新建配方首段钉的默认技能
 *  @property {Object} groupLabels 各生成模式的组头名 */

export function createDirectorPage({ $el, api, toast, currentView, openLibModal, closeLibModal,
                                     gateRunButton, setAgentRecipe, releaseStoryboardEditor,
                                     thumbSrc, copyPickedToInput, modeGroup, defaultSkill, groupLabels }) {
let recipesModal = null;   // 配方弹窗（本页自建：顶栏 Esc 那一条路要能收它）
let onShown = null;        // 进本页要补拉的活：隐藏期间跳过的 director_spec 补一次
let openByName = null;     // 「按名字选中配方」：首页配方卡的 ?recipe= 深链走这一条
// ====== 导演页：顶部条 + 上结果舞台 + 下生成坞（时间轴 / 该段 / 素材槽 / 参数行） ======
let genState = null;   // 当前整片任务 {task_id, statusEl, barEl, fillEl, runBtn, cancelBtn, media, livePlayer}
const GEN_TERMINAL = ["succeeded", "failed", "cancelled"];
const DIRECTOR_TIMELINE_H = 68;   // 时间轴净高：16px 秒刻度尺 + 4px 间距 + 42px 段块（勾选框 + 序号时长一行 + 提示词一行，两行之间露出缩略图层）+ 6px 底部留白
const DIRECTOR_ZOOM_KEY = "neo_studio.director_zoom";   // 时间轴缩放档位：跨页面重开记住（同一浏览器档位是常态）
const DIRECTOR_REF_MAX = { images: 9, videos: 3, audios: 3 };   // 与后端 _DIRECTOR_REF_CAPS 同一份
const DIRECTOR_REF_TOTAL = DIRECTOR_REF_MAX.images + DIRECTOR_REF_MAX.videos + DIRECTOR_REF_MAX.audios;
const NEW_RECIPE_BASE = "未命名配方";   // 顶栏「＋」的起手名：盘上同名配方（含预设）就往后排数字，不盖它的卡
// 全参考家族（含旧 v2v / rv2v）用参考素材那一行，帧模式（t2v / i2v / l2v / fl2v）用首帧 / 尾帧两枚：
// 判据与后端 director_spec 那条优先序同一份——整片生成模式（shared.mode）是全参考时每一段都走 ref2va，
// 其余档按这一段自己的显式模式逐段切。混配方逐段切时，隐藏的槽位不写进配方——留着上一家族的素材就是让它替模式说话
const DIRECTOR_REF_MODES = new Set(["r2v", "v2v", "rv2v"]);
const segFamily = (seg, sharedMode) => (
    DIRECTOR_REF_MODES.has(sharedMode) || DIRECTOR_REF_MODES.has(String(seg?.mode || "").trim()) ? "ref" : "frame"
);

// 实时预览落点：顶栏队列放开并发后，切配方 / 再提交都不许把正在跑那一发的预览帧掐掉，
// 所以整页只挂一条订阅，按 task_id 分发给当前这一发的播放器（node_id 就是提交时的 task_id）。
let activeLive = null;   // { task_id, apply(payload) }
api.addEventListener("rs.h3.preview", ({ detail }) => {
    if (!detail || !activeLive || String(detail.node_id) !== activeLive.task_id) return;
    activeLive.apply(detail);
});

function updateGenStatus(task) {
    if (!genState || task.task_id !== genState.task_id) return;
    // 终态之后落地的旧载荷（在途轮询 / 迟到 WS）不得把界面拉回生成中：进度条与取消按钮会复活，
    // 用户点下去只会拿到「任务已结束，无法取消」
    if (genState.terminal && !GEN_TERMINAL.includes(task.status)) return;
    const { statusEl, barEl, fillEl } = genState;
    // 终态：定格预览 / 时间轴清掉段状态（停轮询在 WS / 轮询两条事件路径里做，闭包可见 stopPolling）
    if (GEN_TERMINAL.includes(task.status)) {
        genState.terminal = true;   // 界面就此定格，后续旧载荷一律作废
        genState.livePlayer?.pause();
        genState.onTerminal?.();
        activeLive = null;   // 这一发跑完：预览帧不再往播放器上送
    }
    // 页内进度留一条紧凑状态行，生成钮不锁：这一发的进度在顶栏「队列」里跟
    barEl.style.display = task.status === "running" ? "block" : "none";
    if (task.status === "queued") {
        statusEl.textContent = tf("排队中…（{recipe}）· 顶栏「队列」看进度", { recipe: task.recipe });
    } else if (task.status === "running") {
        const p = task.progress;
        statusEl.textContent = p ? tf("生成中… {value}/{max}", { value: p.value, max: p.max }) : t("生成中…");
        if (p) fillEl.style.width = `${Math.round(100 * p.value / p.max)}%`;
    } else if (task.status === "succeeded" && !genState.done) {
        genState.done = true;   // 终态可能经 WS + 在途轮询重复到达：成片只替换一次
        statusEl.textContent = tf("已完成：{filename}", { filename: task.filename });
        const url = `/view?filename=${encodeURIComponent(task.filename)}`
            + `&subfolder=${encodeURIComponent(task.subfolder || "")}&type=output`;
        // 成片就地替换实时预览（定格帧一并清掉）；也可在浏览器单独打开
        genState.media.replaceChildren(
            $el("video", { className: "ns-gen-preview ns-gen-final", controls: true, src: url }),
            $el("a", { className: "ns-gen-final", href: url, textContent: tf("{filename}（在浏览器中打开）", { filename: task.filename }) })
        );
        refreshRecipesPanel();
    } else if (task.status === "failed") {
        statusEl.textContent = tf("失败：{error}", { error: task.error || t("未知错误") });
    } else if (task.status === "cancelled") {
        statusEl.textContent = t("已取消");
    }
    genState.cancelBtn.style.display = (task.status === "queued" || task.status === "running") ? "" : "none";
}

let recipesPanelEl = null;
let panelOpts = null;   // 配方面板那一份口径：buildDirector 铺好后，重建面板都读这一份
async function refreshRecipesPanel() {
    if (!recipesPanelEl || !panelOpts) return;
    const parent = recipesPanelEl.parentNode;
    // 先建好再换：先摘掉旧面板的话，弹窗打开那一下列表是空的（异步取数期间整块空白闪一下）
    const next = await createRecipesPanel(panelOpts());   // 导演页只列多段导演配方；点卡片 = 选中
    parent?.replaceChild(next, recipesPanelEl);
    recipesPanelEl = next;
}

let recipesHost = null;   // 配方弹窗里的配方面板宿主（buildDirector 建）

async function buildDirector(el) {
    const page = $el("div", { className: "ns-director" });
    el.appendChild(page);

    let recipeItems = [];    // 导演配方列表（listRecipes 条目：含 segments / shared / story / setup / assets / source）
    let recipe = null;       // 当前配方的整份数据：保存时把没动的字段原样带回去
    let spec = null;         // director_spec：每段有效模式，与解析进 input/ 的首帧 / 尾帧 / 参考素材名
    let currentName = "";
    let selected = 0;
    let tlProgress = { active: false, segment_index: -1, total_segments: 0 };
    let checkedSegments = [];
    let directorSkills = [];   // 视频技能列表：每段「模板收哪几类参考素材」与技能胶囊那一列都读它
    let skillPick = null;      // 本次动过的统一技能：没动过就一段都不写、shared.mode 也不动
    const segs = () => recipe?.segments || [];
    const isPreset = () => recipe?.source === "preset";
    const skillMeta = (id) => directorSkills.find((s) => s.id === id) || null;
    // 整片生成模式：本次选过技能就以它所属那一组为准，没选就回落到配方里钉的 shared.mode（旧值静默重映射）。
    // 旧混配方留在这页的 mixed 落在这一步：素材槽与分块秒数照旧逐段按该段自己钉的模式切。
    const sharedGenMode = () => {
        if (skillPick !== null) return modeGroup(skillMeta(skillPick));
        const m = recipe?.shared?.mode;
        return LEGACY_MODE_MAP.get(m) || m || "";
    };
    // 段落的增删改与「保存该段」走 director.js 那份共享实现（出片视图后面要嵌进画布，同一套语义）：
    // 脏标记记在 ops 里，页面上「未保存」只有保存钮这一处要亮
    const ops = createSegmentOps(() => recipe, {
        onChange: () => saveBtn.classList.add("ns-director-dirty"),
        readOnly: isPreset,
    });

    // --- 顶部条：左端 配方管理（卡片弹窗）· ＋（本页落一份新配方），右端 素材库 · 高级模式（整片编辑器浮层） ---
    recipesHost = $el("div", { className: "ns-director-recipes" });
    recipesModal = createLibraryModal({ storageKey: "neo_studio_libmodal_recipes", scope: "recipes" });
    recipesModal.setContent(recipesHost);
    document.body.appendChild(recipesModal.el);
    // 换配方只有这一颗：弹窗里点卡片 = 选中喂给本页。顶栏不再挂一份同样的配方下拉——同一页两个入口选同一件事
    const recipesBtn = $el("button", { className: "ns-btn", type: "button", title: t("打开配方管理：点卡片选中，含复制 / 删除 / 新增") });
    setIconLabel(recipesBtn, "list", t("配方管理"));
    recipesBtn.onclick = () => { recipesModal.open(t("导演配方")); refreshRecipesPanel(); };
    const newBtn = $el("button", { className: "ns-btn ns-director-new", type: "button", title: t("新建一份分镜视频导演配方：就在本页落一段，写完「保存该段」写回") });
    setIcon(newBtn, "plus", 15);
    newBtn.onclick = () => startNewRecipe();
    const libBtn = $el("button", { className: "ns-btn", type: "button", title: t("打开素材库：看大图与取用") });
    setIconLabel(libBtn, "folder", t("素材库"));
    libBtn.onclick = () => openLibModal("director");
    const editorBtn = $el("button", { className: "ns-btn", type: "button", title: t("高级模式：整片编辑器浮层（分段增删、生成模式与分辨率、故事板与提示词工具）") });
    setIconLabel(editorBtn, "film", t("高级模式"));
    editorBtn.onclick = () => openEditor();
    page.appendChild($el("div", { className: "ns-director-bar" }, [
        recipesBtn, newBtn, $el("span", { className: "ns-director-bar-space" }), libBtn, editorBtn,
    ]));

    // --- 结果舞台：idle 起手卡 / 实时预览 / 成片，下面一条状态行 + 进度 ---
    const idleCard = $el("div", { className: "ns-director-idle-card neo-gallery-gm-idle" }, [
        $el("div", { className: "neo-gallery-gm-idle-title", textContent: t("导演视频") }),
        $el("div", { className: "neo-gallery-gm-idle-sub", textContent: t("选一份配方，勾要跑的段，然后生成整片") }),
        $el("i", { className: "ns-video-corner c-tl" }),
        $el("i", { className: "ns-video-corner c-tr" }),
        $el("i", { className: "ns-video-corner c-bl" }),
        $el("i", { className: "ns-video-corner c-br" }),
    ]);
    const liveBox = $el("div", { className: "ns-director-live neo-dtl-live" });
    const media = $el("div", { className: "ns-director-media ns-director-idle" }, [idleCard, liveBox]);
    const livePlayer = createFramePlayer(liveBox, () => {
        liveBox.style.height = "";                       // 高度交给 CSS：结果区按配方的画面比例贴
        media.classList.remove("ns-director-idle");      // 预览一有画面就占住结果区，idle 卡让位
    });
    const statusEl = $el("div", { className: "ns-director-status" });
    const barEl = $el("div", { className: "ns-gen-progress ns-director-progress" }, [$el("div")]);
    const statusRow = $el("div", { className: "ns-director-statusrow" }, [statusEl, barEl]);
    // 舞台只剩画面一块：状态行搬进生成坞卡顶，起手的空带不再由它顶出来
    page.appendChild($el("div", { className: "ns-director-stage" }, [media]));

    // --- 生成坞：紧凑时间轴（勾选 = 本次跑哪几段）+ 该段（时长 / 提示词）+ 素材槽 + 参数行 ---
    const timelineHost = $el("div", { className: "ns-director-timeline" });
    const checkHint = $el("span", { className: "ns-director-checkhint" });
    const promptIn = $el("textarea", { className: "ns-director-prompt neo-gallery-gm-quick-input", rows: "1", spellcheck: "false", placeholder: t("这一段要拍成什么样…") });
    const firstSlot = createMediaSlot({ label: "首帧", thumbSrc, toast, pick: slotPick, refKinds: () => segRefKinds(selected), onChange: slotChanged });
    const lastSlot = createMediaSlot({ label: "尾帧", thumbSrc, toast, pick: slotPick, refKinds: () => segRefKinds(selected), onChange: slotChanged });
    const refSlot = createMediaSlot({ label: "参考素材", multiple: true, maxN: DIRECTOR_REF_TOTAL, kindMax: DIRECTOR_REF_MAX, thumbSrc, toast, pick: slotPick, refKinds: () => segRefKinds(selected), onChange: slotChanged });

    // 「技能」胶囊就是视频页那一枚 skillParamsChip：左栏技能按生成模式分组（关键帧生视频 / 全参考生视频），
    // 右栏是本次整片的模型链覆盖（主模型 / Text Encoder / VAE / 音频 VAE / LoRA / 步数，留空 = 该段跟随自己的技能配置）。
    // 选中的技能是整片要统一成的那一个，它所属那一组就是生成模式。
    // 配方里每段本就自带技能，本页选的是要把它们统一成哪一个——所以改动只记在页面上，落盘走「保存该段」那一条链。
    const skillSel = $el("select", { className: "ns-director-skill", title: t("技能与自定参数：左栏选整片统一的技能（它所属那一组就是生成模式），点它就把右栏铺成该技能钉的模型链；右栏主模型 / LoRA 留空 = 各段跟随自己的技能配置") });
    skillSel.appendChild($el("option", { value: "", textContent: t("（加载视频技能…）") }));
    const videoCfg = createVideoModelConfigSection();
    let videoModels = null;   // 模型清单：没拉到就整块不发覆盖值，各段技能配置照常生效
    const videoParamsBox = $el("div", { className: "neo-gallery-gm-model-box" }, [videoCfg.el]);
    const skillChip = skillParamsChip(skillSel, videoParamsBox, {
        icon: "film",
        groupOf: modeGroup,
        groupLabels,
        getOverride: () => videoModels ? videoCfg.collect() : {},
        panelClass: "ns-director-compact-form ns-director-skill-panel",
    });
    videoParamsBox.addEventListener("change", () => skillChip.sync());
    // 换技能 = 右栏整份换成该技能 config 钉的那一套（与视频页、绘画页同一语义）：面板里看到的就是这一发真要跑的模型链。
    // 技能没钉配置（config 是空的）就是清空回「自动」：这一发跟着各段自己的技能配置跑。
    async function applySkillParams(skillId) {
        if (!videoModels) return;
        if (!skillId) {
            videoCfg.load({}, videoModels);
            skillChip.sync();
            return;
        }
        videoCfg.load(await getSkillGenConfig(skillId), videoModels);
        skillChip.sync();   // 程序改 value 不触发 change：chip 上那行生效值要跟着重读
    }
    skillSel.addEventListener("change", () => {
        applySkillParams(skillSel.value);
        if (skillSel.value === skillPick) return;
        skillPick = skillSel.value;
        markDirty();
        renderSegment();   // 生成模式跟着换：该段素材槽那一行与分辨率胶囊上的模式名都要翻面
    });

    // 技能那一列 = 本页的视频技能清单；选中值回落到配方首段钉的技能，各段钉的不是同一个也落首段那一枚。
    // 本页只有一条统一口径：不动这一列就一直不写段，各段照跑自己钉的技能；要点一行技能再「保存该段」才铺满每一段
    function syncSkillChip() {
        const list = directorSkills;
        const first = segs()[0]?.skill_id || "";
        skillSel.textContent = "";
        for (const s of list) {
            // 特效技能缺 LoRA 时后端把 available 判成 false（skill._video_skill_available），列里要说出来
            const opt = $el("option", { value: s.id, textContent: skillDisplayName(s) + (s.available === false ? t("（不可用）") : "") });
            opt.__skillMeta = s;   // 分组与 chip 标签取这份元数据（视频页技能面板同一约定）
            skillSel.appendChild(opt);
        }
        skillPick = null;
        skillSel.value = list.some((s) => s.id === first) ? first : (list[0]?.id || "");
        skillChip.sync();   // 技能与选中态都是程序改的，chip 显示的生效值要跟着重读
        applySkillParams(skillSel.value);   // 程序铺的选中值同样铺该技能钉的模型链：清单没到就整块不动，下面 modelsReady 那一路补
    }

    // 该段「⋯」菜单：重生成 / 复制 / 前移 / 后移 / 删除。增删改本身在 director.js 那份共享实现里，页面只出这一条入口
    const segMenuItem = (label, tip, fn) => $el("button", { className: "ns-btn", type: "button", textContent: t(label), title: t(tip), onclick: () => { segMenuClose(); fn(); } });
    // 重生成该段：段菜单直接进编辑器展开该段的重生成面板。那枚 ♻ 画在高级模式的段行里，
    // 时间轴上看到哪段想重跑，不该让用户先点高级模式、再在整片编辑器里找那一行
    const regenItem = segMenuItem("重生成该段", "打开高级模式编辑器并展开该段的重生成面板：锚点取成片里该段前后的真实帧，换种子单跑这一段", () => {
        if (!currentName) { toast(t("先选一份导演配方")); return; }
        openDirectorEditor(findItem(currentName) || { name: currentName }, afterEditorSaved, selected,
            { onSaveAndRun: () => submitGenerate(), openRegen: true });
    });
    regenItem.classList.add("ns-director-segmenu-regen");   // RUN_GATES 认这个类：窗口翻回离线形态时这一项跟着收口
    gateRunButton(regenItem, "segment", t("重生成该段"));
    // 基座 .rs-runtime-menu 给 fixed 定位：.neo-gallery-gm-chip-menu / -panel 只出宽度与滚动，
    // 少了基座这块就是页面流里的一块，下面按 ⋯ 的 rect 算出的 left/top 全部无效（菜单落在页面最左、压住首帧方块）
    const segMenuPanel = $el("div", { className: "rs-runtime-menu neo-gallery-gm-chip-menu neo-gallery-gm-chip-panel ns-director-segmenu" }, [
        regenItem,
        segMenuItem("复制该段", "把该段的提示词 / 时长 / 素材整份复制到下面一段", () => {
            const at = ops.duplicate(selected);
            if (at < 0) return;
            dropStaleTails();
            timeline.refresh();
            selectSegment(at);
        }),
        segMenuItem("前移一段", "该段往前挪一位", () => {
            if (!ops.move(selected, -1)) return;
            dropStaleTails();
            timeline.refresh();
            selectSegment(selected - 1);
        }),
        segMenuItem("后移一段", "该段往后挪一位", () => {
            if (!ops.move(selected, 1)) return;
            dropStaleTails();
            timeline.refresh();
            selectSegment(selected + 1);
        }),
        segMenuItem("删除该段", "删除该段（素材文件留在配方里，不删文件）", () => {
            const n = segs().length;
            if (n <= 1) { toast(t("最后一段不能删：整片至少留一段")); return; }
            if (!confirm(tf("删除第 {n} 段？该段的素材文件留在配方里，不删文件。", { n: selected + 1 }))) return;
            ops.remove(selected);
            dropStaleTails();
            checkedSegments = [];
            timeline.clearChecked();
            renderCheckHint();
            timeline.refresh();
            selectSegment(Math.min(selected, n - 2));
        }),
    ]);
    page.appendChild(segMenuPanel);
    let segMenuOpen = false;
    const segMenuClose = () => { segMenuOpen = false; segMenuPanel.style.display = "none"; };
    // 时间轴段块右上角那枚「⋯」点出来的菜单：弹在那枚 glyph 旁边（上方放得下就朝上，否则朝下，右边夹进窗口）。
    // 菜单五项都作用在「选中那段」上，所以先把点的那块选中——这一页只有段块右上角这一条段操作入口
    function openSegMenu(i, rect) {
        if (!rect) return;
        selectSegment(i);
        segMenuOpen = true;
        segMenuPanel.style.display = "block";
        const pw = segMenuPanel.offsetWidth || 190;
        const ph = segMenuPanel.offsetHeight || 130;
        segMenuPanel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8))}px`;
        const above = rect.top - ph - 6;
        segMenuPanel.style.top = `${above > 8 ? above : rect.bottom + 6}px`;
    }

    // 「分辨率」胶囊弹的是共享的整片参数表单（createSharedConfigSection）：页内改分辨率与运行参数 + 分块秒数，
    // 保存走「保存该段」同一条 ops 链。生成模式不在表单里（它是技能胶囊那一列的事）；分块秒数要看当前生效技能
    // 支不支持多帧，技能由本页交进来——表单不自己拉技能清单
    const sharedCfg = createSharedConfigSection(() => (sharedGenMode() === "mixed" ? null : skillMeta(skillPick ?? segs()[0]?.skill_id)));
    const sizeSaveBtn = $el("button", { className: "rs-btn ns-director-size-save", type: "button", textContent: t("保存整片参数") });
    const sizePanel = $el("div", { className: "rs-runtime-menu neo-gallery-gm-chip-menu neo-gallery-gm-chip-panel ns-director-compact-form ns-director-size-panel" }, [sharedCfg.el, sizeSaveBtn]);
    page.appendChild(sizePanel);
    let sizeOpen = false;
    const sizeClose = () => { sizeOpen = false; sizePanel.style.display = "none"; };
    const sizePos = () => {
        const r = sizeBtn.getBoundingClientRect();
        sizePanel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - sizePanel.offsetWidth - 8))}px`;
        const above = r.top - sizePanel.offsetHeight - 6;
        sizePanel.style.top = `${above > 8 ? above : r.bottom + 6}px`;
    };
    sizeSaveBtn.onclick = async () => {
        if (!currentName || isPreset()) { statusEl.textContent = t("内置预设配方只读：先「复制配方」才能改"); return; }
        recipe.shared = { ...(recipe.shared || {}), ...sharedCfg.collect() };
        markDirty();
        sizeClose();
        await saveRecipeNow();
    };


    const sizeGlyph = ratioGlyph();
    const sizeLabel = $el("span", { className: "neo-gallery-gm-chip-label" });
    const sizeBtn = $el("button", { className: "neo-gallery-gm-chip-btn ns-director-size", type: "button", title: t("整片参数（宽高比 / 百万像素 / 种子 / 连续性 / 上下文帧 / 角色身份参考 / 分块秒数）：页内改，保存写回配方") }, [sizeGlyph.el, sizeLabel]);
    sizeBtn.onclick = () => {
        if (!currentName) { toast(t("先选一份导演配方")); return; }
        sizeOpen = !sizeOpen;
        sizePanel.style.display = sizeOpen ? "block" : "none";
        if (!sizeOpen) return;
        sharedCfg.load(recipe.shared || {}, segs());   // 段数决定「分块秒数」露不露，首段的技能是统一技能的起手选中
        sizePos();
    };
    const saveBtn = $el("button", { className: "ns-btn ns-director-save", type: "button", textContent: t("保存该段"), title: t("把该段的提示词 / 时长 / 素材槽改动写回配方（不新增段，也不动故事板与分辨率）") });
    // 主行动就写「生成」：跑哪几段是时间轴勾选取与下面那条提示行的事，按钮上不替它说那句长文案
    const runBtn = $el("button", { className: "rs-btn ns-gen-run ns-director-run", type: "button", textContent: t("生成") });
    gateRunButton(runBtn, "director", t("生成"));
    const cancelBtn = $el("button", { className: "rs-btn ns-gen-cancel", type: "button", textContent: t("取消"), style: { display: "none" } });
    // 时间轴缩放：一屏放不下多段时的唯一压缩手段（块宽按时长分配，缩一档就能多看几段）。
    // 档位存在 localStorage——每次进导演页都回到上次那一档
    const zoomBtn = (label, tip, fn) => {
        const b = $el("button", { className: "ns-director-zoom", type: "button", textContent: label, title: t(tip) });
        b.onclick = fn;
        return b;
    };
    const zoomRow = $el("div", { className: "ns-director-zoomrow" }, [
        zoomBtn(t("适应"), "时间轴铺满一屏，缩放回到 1 倍", () => directorZoom(1)),
        zoomBtn("−", "缩小时间轴：一屏看更多段", () => directorZoom(timeline.getZoom() - 0.25)),
        zoomBtn("＋", "放大时间轴：横向滚动看细节", () => directorZoom(timeline.getZoom() + 0.25)),
    ]);
    const hintRow = $el("div", { className: "ns-director-hintrow" }, [checkHint, zoomRow]);
    page.appendChild($el("div", { className: "ns-director-dock" }, [
        $el("div", { className: "ns-director-card neo-gallery-gm-composer" }, [
            statusRow,
            timelineHost,
            hintRow,
            // 方块在左、该段的提示词吃剩下的宽度：段号与秒数不再在这块重复一遍，时间轴块左上就是「第 N 段 · Xs」
            $el("div", { className: "ns-director-main" }, [
                $el("div", { className: "ns-director-segrow" }, [
                    $el("div", { className: "ns-director-slots" }, [firstSlot.el, lastSlot.el, refSlot.el]),
                ]),
                promptIn,
            ]),
            $el("div", { className: "ns-director-controls neo-gallery-gm-composer-bar neo-gallery-gm-chips" }, [
                skillChip.el, sizeBtn, saveBtn,
                $el("div", { className: "neo-gallery-gm-composer-gap" }),
                cancelBtn, runBtn,
            ]),
        ]),
    ]));

    const timeline = new DirectorTimeline(timelineHost, {
        height: DIRECTOR_TIMELINE_H,
        checkable: true,
        getSegments: () => segs().map((s, i) => ({
            duration: Number(s.duration_sec) || 5,
            prompt: s.prompt || "",
            thumbUrl: specThumb(i),
        })),
        onSelect: (i) => { selected = i; renderSegment(); },   // 画布点块：画布自己已落选中态，这里只刷该段面板（不得回调 select，会成环）
        onCheckChange: (list) => { checkedSegments = list; renderCheckHint(); },
        onSegMenu: (i, rect) => openSegMenu(i, rect),   // 块右上角「⋯」→ 该段操作菜单弹在那枚 glyph 旁边
        onReorder: (order) => reorderSegs(order),
        onResize: (i, sec) => {
            const s = segs()[i];
            if (!s) return;
            s.duration_sec = sec;
            markDirty();
            timeline.refresh();
            renderSegment();
        },
        onAdd: () => addSeg(),
        getProgress: () => tlProgress,
    });
    function directorZoom(z) {
        const v = Math.max(0.25, Math.min(4, Math.round(z * 100) / 100));
        localStorage.setItem(DIRECTOR_ZOOM_KEY, String(v));
        segMenuClose();
        timeline.setZoom(v);
    }
    timeline.setZoom(Number(localStorage.getItem(DIRECTOR_ZOOM_KEY)) || 1);
    // 横向滚动与换档位都会把段块连同那枚 ⋯ 挪走：菜单弹在 glyph 旁边，跟着一起收，不许脱离它
    timeline.scroll.addEventListener("scroll", segMenuClose);
    // 提示词框一行起步、随内容长到 20vh 上限（与 CSS 的 max-height 同一档）。
    // 无布局引擎的环境（jsdom）里 scrollHeight 恒为 0，这时不写内联高度，留给 CSS 的 min-height。
    // 框是 border-box 且带 1px 描边：scrollHeight 只量到内容加内衬，边框那 2px 要在这一发补给框高，
    // 否则最后一行的下沿被描边裁进框内自滚的竖线里
    function growPrompt() {
        promptIn.style.height = "auto";
        if (promptIn.scrollHeight > 0) {
            promptIn.style.height = Math.min(promptIn.scrollHeight + 4, Math.round(window.innerHeight * 0.2)) + "px";
        }
    }
    const onDocPress = (e) => {
        if (!document.body.contains(page)) { document.removeEventListener("pointerdown", onDocPress, true); return; }
        skillChip.closeOnOutside(e.target);
        if (segMenuOpen && !segMenuPanel.contains(e.target)) segMenuClose();
        if (sizeOpen && !sizePanel.contains(e.target) && !sizeBtn.contains(e.target)) sizeClose();
    };
    document.addEventListener("pointerdown", onDocPress, true);


    function specThumb(i) {
        const s = spec?.segments?.[i];
        const name = s?.keyframe || s?.ref_input || (s?.refs?.images || [])[0] || "";
        return name ? thumbSrc(name) : "";
    }
    const renderCheckHint = () => {
        checkHint.textContent = checkedSegments.length
            ? tf("仅运行勾选的 {n} 段：[{list}]", { n: checkedSegments.length, list: checkedSegments.map((i) => i + 1).join(",") })
            : t("未勾选 = 生成整片 · 点时间轴块左上角勾选");
    };
    function markDirty() { ops.markDirty(); }
    function clearDirty() { ops.clearDirty(); saveBtn.classList.remove("ns-director-dirty"); }
    function selectSegment(i) { timeline.select(i); }   // 走画布：落选中态后由 onSelect 刷该段面板

    // 该段控件：模式决定素材槽显哪一组，隐藏的槽位不写进配方（后端按资产推模式，留旧素材就是推错）
    function renderSegment() {
        const s = segs()[selected];
        const fam = segFamily(s, sharedGenMode());
        skillChip.chip.disabled = !s || isPreset();   // 预设只读与没有配方：统一技能这枚胶囊不给动
        // 段号与秒数不在这里重复：时间轴块左上就是「第 N 段 · Xs」，右缘一拖就改时长
        promptIn.value = s?.prompt || "";
        promptIn.disabled = !s || isPreset();
        growPrompt();
        firstSlot.el.classList.toggle("ns-hidden", fam !== "frame");
        // 尾帧只给最后一段：中间段钉一张尾帧，接的是下一段的开头，接不上（整片模式 renumberSegs 同一条规矩）
        lastSlot.el.classList.toggle("ns-hidden", fam !== "frame" || !isLastSeg());
        refSlot.el.classList.toggle("ns-hidden", fam === "frame");
        firstSlot.setReadOnly(isPreset());
        lastSlot.setReadOnly(isPreset());
        refSlot.setReadOnly(isPreset());
        fillSlots(s);
    }

    // 「最后一段」这一身份会随增删与重排移动，所以它是个问句不是一份状态
    const isLastSeg = () => selected >= segs().length - 1;

    // 段从最后位置下来，它那份尾帧必须跟着清：后端是按素材推生成模式的，留着就推成首尾帧，
    // 跑的却是一个界面上再也改不到的框。增删改顺序五个入口共用这一发
    function dropStaleTails() {
        let stale = false;
        for (const s of segs().slice(0, -1)) {
            if (s && s.last_frame) { delete s.last_frame; stale = true; }
        }
        if (stale) markDirty();
    }

    // 槽位里的画面用 director_spec 那份（素材已从配方 assets/ 解析进 input/）；spec 没到就退回配方里记的名
    function fillSlots(s) {
        const sp = spec?.segments?.[segs().indexOf(s)];
        firstSlot.fill(sp ? [sp.ref_input] : [s?.first_frame]);
        lastSlot.fill(sp ? [sp.last_input] : [s?.last_frame]);
        const rf = sp?.refs || s?.refs || {};
        refSlot.fill([...(rf.images || []), ...(rf.videos || []), ...(rf.audios || [])]);
    }

    function slotChanged() {
        const s = segs()[selected];
        if (!s) return;
        if (segFamily(s, sharedGenMode()) === "frame") {
            const f = firstSlot.first()?.value;
            // 非最后一段不认尾帧：那一格是藏着的，旧值也不许从槽里写回配方（藏着的槽不许写进配方）
            const l = isLastSeg() ? lastSlot.first()?.value : null;
            if (f) s.first_frame = f; else delete s.first_frame;
            if (l) s.last_frame = l; else delete s.last_frame;
        } else {
            const picked = refSlot.get();
            const refs = {};
            for (const [media, key] of [["image", "images"], ["video", "videos"], ["audio", "audios"]]) {
                const vals = picked.filter((x) => x.media === media).map((x) => x.value);
                if (vals.length) refs[key] = vals;
            }
            if (Object.keys(refs).length) s.refs = refs; else delete s.refs;
        }
        markDirty();
        timeline.refresh();
    }

    // 素材方块取用与视频页同一条路：素材库弹窗点卡片 → copy_to_input 落进 input 根目录，
    // 返回加载节点可用的文件名；保存时这份名字进配方 assets/，重开时 spec 又把它解析回 input/
    function slotPick({ accept, multiple: keepOpen, gate, add }) {
        openLibModal("director", async (picked) => {
            const ok = gate(picked);   // 先过闸：挡下的不 copy_to_input，input 目录不留用不上的文件
            const filled = [];
            for (const a of ok) {
                try { filled.push({ ...a, value: await copyPickedToInput(a.src) }); }
                catch (e) { toast(tf("取用素材失败：{msg}", { msg: e.message })); }
            }
            add(filled);
            if (!keepOpen) libModal?.close();   // 首帧 / 尾帧取一张即收窗；参考素材留着弹窗好连选
        }, accept);
    }

    function segRefKinds(i) { return skillMeta(segs()[i]?.skill_id)?.gen_config?.ref_kinds || null; }

    function addSeg() {
        const at = ops.add();
        if (at < 0) return;
        dropStaleTails();   // 新段成了最后一段：原来那段不再是最后，它的尾帧要跟着清
        timeline.refresh();
        selectSegment(at);
    }

    function reorderSegs(order) {
        if (!ops.reorder(order)) return;   // 顺序表不完整时 ops 不动配方：这次拖拽丢掉，不留少一段的配方
        dropStaleTails();
        checkedSegments = [];
        timeline.clearChecked();
        renderCheckHint();
        timeline.refresh();
        selectSegment(Math.min(selected, Math.max(0, segs().length - 1)));
    }


    const findItem = (name) => recipeItems.find((r) => r.name === name) || null;
    async function refreshRecipeItems() {
        try { recipeItems = (await listRecipes()).filter((r) => r.type === "video_director"); }
        catch { recipeItems = []; }   // 离线模式 / ComfyUI 未就绪：列表拿不到就留着现有那一份
    }

    function openEditor(opts = null) {
        if (!currentName) { toast(t("先选一份导演配方")); return; }
        // 编辑器全窗口只有一份：故事板页把同一份配方内嵌在自己那一页时，先让它让位再开浮层。
        // 那一面有未保存修改时让位失败（确认条长在隐藏的视图里点不到，静默关窗就是丢改动），这一发就此收住。
        if (releaseStoryboardEditor?.() === false) return;
        // 编辑器是浮层（桌面端不再内嵌宿主）：底部「保存并生成整片」保存成功后交本页直接提交
        openDirectorEditor(findItem(currentName) || { name: currentName }, afterEditorSaved, selected, { onSaveAndRun: () => submitGenerate(), ...opts });
    }
    async function afterEditorSaved() {
        await refreshRecipeItems();
        await openRecipe(currentName);
    }

    // 顶栏「＋」与配方管理里的「新增导演配方」都在本页落：一段空段起手，整片参数取本页那张表单的
    // 默认口径，一次 ops.save 落盘——生成整片、素材槽取用、director_spec 回显从这一刻起全部可用，
    // 页上也因此只有「已落盘的配方」这一种状态，不给未落盘的草稿开第二条写路径。
    // 不想要就在配方管理里用那张卡自己的「删除」删掉（单件入口，页上不铺清空动作）。
    async function startNewRecipe() {
        const name = newRecipeName();
        recipe = {
            name, type: "video_director", source: "user", prompt: "", assets: [], loras: [],
            // 首段钉默认技能（关键帧家族里步数最少的可用技能，与后端 _default_video_skill 同口径）；
            // 技能清单还没到就是空串——后端认段级 skill_id，起手不靠整片生成模式替它说话
            segments: [{ skill_id: defaultSkill(directorSkills), prompt: "", duration_sec: 5 }],
        };
        sharedCfg.load({}, segs());   // 整片参数从表单默认起，不带上一份配方刚落盘的那一份
        recipe.shared = sharedCfg.collect();
        currentName = name;
        selected = 0;
        checkedSegments = [];
        timeline.clearChecked();
        renderCheckHint();
        syncSkillChip();   // 胶囊回显首段钉的那一枚：清单没到就整块不动，listVideoSkills 那一路到了会补一次
        markDirty();
        if (!await saveRecipeNow()) {
            // 落盘失败（离线 409 / 后端报错）：页上不许钉着一份盘上不存在的配方，退回「没有配方」那一面
            recipe = null;
            currentName = "";
            checkedSegments = [];
            clearDirty();
            await loadSpec();   // 尺寸胶囊 / 时间轴 / 该段槽位一起回空白
            return;
        }
        statusEl.textContent = tf("已新建配方 {name}：写提示词、取首帧，「保存该段」写回", { name });
        await refreshRecipesPanel();   // 保存链只刷本页；管理弹窗里那份面板得单独长出新卡
        promptIn.focus();
    }

    // 起手名往后排数字，不盖盘上的同名配方：配方管理里那张同名卡不该被一次新建悄悄改掉（预设同名后端 409 挡）
    function newRecipeName() {
        const taken = new Set(recipeItems.map((r) => r.name));
        let name = NEW_RECIPE_BASE;
        for (let i = 2; taken.has(name); i++) name = `${NEW_RECIPE_BASE}${i}`;
        return name;
    }

    // 每段的有效模式与素材名要 director_spec 那份（配方 assets/ 里的文件已复制进 input/）。
    // 启动时导演页是隐藏的：spec 逐文件同步复制，桌面端一个事件循环上会把首页 list 挤到几秒后，
    // 所以隐藏期间不拉，进本页由 onDirectorShown 补一次
    async function loadSpec() {
        spec = null;
        if (currentName && currentView() === "director") {
            try {
                const r = await api.fetchApi(`/rs_recipes/director_spec?name=${encodeURIComponent(currentName)}`);
                const d = r.ok ? await r.json() : null;
                if (d?.success) spec = d;
            } catch { /* ComfyUI 未就绪时保持空白：槽位退回配方里记的名 */ }
        }
        applySpec();
    }
    function applySpec() {
        const d = spec?.defaults;
        sizeLabel.textContent = d ? `${d.width}×${d.height}` : "";
        if (d) sizeGlyph.sync(`${d.width}:${d.height}`);
        media.style.setProperty("--ns-gen-ratio", d ? `${d.width} / ${d.height}` : "");
        media.style.setProperty("--ns-gen-ar", d ? String(d.width / d.height) : "");
        timeline.refresh();
        renderSegment();
    }

    async function openRecipe(name, opts = {}) {
        name = String(name || "").trim();
        if (!name) return;
        let d = null;
        try {
            const r = await api.fetchApi("/rs_recipes/load", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
            });
            d = await r.json().catch(() => null);
            if (!r.ok || !d?.success) throw new Error(String(d?.error || r.status));
        } catch (e) {
            statusEl.textContent = tf("配方读取失败：{msg}", { msg: e.message });
            return;
        }
        recipe = d.recipe || null;
        currentName = recipe?.name || name;
        selected = 0;
        checkedSegments = [];
        timeline.clearChecked();
        renderCheckHint();
        clearDirty();
        timeline.opts.readOnly = isPreset();   // 预设配方：时间轴不能加段 / 拖时长 / 重排
        saveBtn.disabled = isPreset();
        timeline.setSegMenuOps(isPreset() ? null : openSegMenu);   // 预设只读：段菜单四项没有一项能用，块右上角不出 ⋯
        saveBtn.title = isPreset() ? t("内置预设配方只读：先「复制配方」才能改") : t("把该段的提示词 / 时长 / 素材槽改动写回配方（不新增段，也不动故事板与分辨率）");
        recipesPanelEl?.__neoRecipesPanel?.select(currentName);   // 卡片高亮跟着本页的选中配方挪（配方管理里点卡片 / 保存后重读）
        // 「保存该段」后的重读要留着那句「已保存」：重读是把刚落盘的结果刷回界面，不是开一份新配方
        const presetNote = isPreset() ? t("内置预设配方只读：想改这一片就先「复制配方」") : "";
        statusEl.textContent = presetNote || (opts.keepStatus ? statusEl.textContent : "");
        syncSkillChip();   // 技能胶囊回到这份配方钉的技能：各段钉的不是同一个就落首段那一枚
        await loadSpec();
        selectSegment(0);
        setAgentRecipe(currentName, segs().length);   // 智能体上下文：默认围绕这一份配方出片，段数要报得出
    }

    // 保存只发本次新取用的素材与改动后的段：既有资产与结果历史由后端按盘上现状保留
    // 「保存该段」与「保存整片参数」共用这一条链：ops.save 落盘，重读把刚落盘的结果刷回界面
    async function saveRecipeNow() {
        if (!currentName) { statusEl.textContent = t("请先选一份导演配方"); return false; }
        if (isPreset()) { statusEl.textContent = t("内置预设配方只读：先「复制配方」再改"); return false; }
        // 技能胶囊动了才写段：整片生成模式落 shared.mode，选中的技能经 applySkill 写进每一段 skill_id
        if (skillPick !== null) {
            recipe.shared = { ...(recipe.shared || {}), mode: modeGroup(skillMeta(skillPick)) };
            ops.applySkill(skillPick);
        }
        saveBtn.disabled = true;
        try {
            const res = await ops.save(currentName);
            if (!res?.success) { statusEl.textContent = tf("保存失败：{msg}", { msg: res?.error || t("未知错误") }); return false; }
            clearDirty();
            statusEl.textContent = tf("已保存：{name}（{n} 段）", { name: currentName, n: segs().length });
            await refreshRecipeItems();
            // 落盘后素材名可能被后端改名（重名让位）：重读配方与 spec，槽位与时间轴缩略图跟着换
            await openRecipe(currentName, { keepStatus: true });
            return true;
        } catch (e) {
            statusEl.textContent = tf("保存失败：{msg}", { msg: e.message });
            return false;
        } finally {
            saveBtn.disabled = isPreset();
        }
    }
    saveBtn.addEventListener("click", () => saveRecipeNow());


    // setGen 只在「提交成功」之后调用：WS 事件为主、轮询兜底。提交失败不挂订阅也不起轮询——
    // 那会在每次重开本页时按盘上的旧 task_id 白白发请求
    function setGen(task) {
        genState = {
            task_id: task.task_id, statusEl, barEl, fillEl: barEl.firstElementChild,
            runBtn, cancelBtn, media, pollTimer: null,
            done: false, terminal: false, lastPreviewStep: 0,   // done：成片只替换一次；terminal：终态已落地，旧载荷一律作废；lastPreviewStep：预览帧按步号单调推进（WS / 轮询同源）
            livePlayer,   // 终态时定格在最后一帧
            onTerminal: () => { tlProgress = { active: false, segment_index: -1, total_segments: 0 }; timeline.refresh(); },
        };
        api.addEventListener("rs.director.status", onStatusEvent);
        activeLive = { task_id: task.task_id, apply: applyPreview };   // 这一发的预览帧从此刻起进这个播放器
        // WS 事件为主，轮询兜底（页面晚于任务打开 / 断线重连窗口）
        const poll = async () => {
            try {
                const r = await api.fetchApi(`/neo_studio/director/${task.task_id}`);
                const st = await r.json();
                // 终态由 WS 先到时，这次在途轮询的旧载荷不得把界面拉回生成中（进度条 / 取消按钮 / 段高亮会复活）
                if (!genState || genState.terminal) return;
                if (st?.success) {
                    updateGenStatus(st);
                    if (GEN_TERMINAL.includes(st.status)) stopPolling();
                    applyPreview(st.latest_preview);   // 轮询兜底：WS 断档期间没有帧，取后端最新一帧
                }
                // 分段进度：与画布节点同源，时间轴据此高亮正在跑的段并跟到那一格
                const p = await api.fetchApi("/neo_video_gen/director_progress");
                const d = await p.json();
                if (d && typeof d.active === "boolean") {
                    tlProgress = d;
                    timeline.refresh();
                    timeline.revealSeg(d.segment_index);
                }
            } catch { /* 网络抖动忽略，下一轮再试 */ }
        };
        genState.pollTimer = setInterval(poll, 2000);
        updateGenStatus(task);
    }


    function stopPolling() {
        if (genState && genState.pollTimer) clearInterval(genState.pollTimer);
        api.removeEventListener("rs.director.status", onStatusEvent);
    }
    function onStatusEvent({ detail }) {
        if (!detail || !detail.task_id) return;
        updateGenStatus(detail);
        // 终态即停轮询（WS 与下方轮询兜底两条路都覆盖，否则轮询拿到终态后会永远跑下去）
        if (GEN_TERMINAL.includes(detail.status)) stopPolling();
    }
    // 实时预览按 task_id 订阅：顶栏队列放开并发后，切配方 / 再提交都不许把正在跑那一发的
    // 预览订阅摘掉，所以整页只挂一条订阅，由 activeLive 决定当前这一发的帧落在哪个播放器上。
    function applyPreview(p) {
        if (!p || !Array.isArray(p.frames) || !p.frames.length) return;
        const st = Number(p.step);
        if (Number.isFinite(st) && st <= genState.lastPreviewStep) return;
        if (Number.isFinite(st)) genState.lastPreviewStep = st;
        livePlayer.apply(p);
    }
    activeLive = null;

    // 提交整片生成：配方名 + 勾选的段 + 配方记着的种子 + 技能面板那套模型链覆盖。
    // 后端按配方名从盘上读整片（分辨率 / 连续性 / 上下文帧 / 每段的技能与素材都在配方里）——本页不发这些，
    // 页面上改过的段必须先「保存该段」写回配方，这一发才带得走。
    async function submitGenerate() {
        if (!currentName) { statusEl.textContent = t("请先选一份导演配方"); return; }
        if (isPreset()) { statusEl.textContent = t("内置预设配方只读：先「复制配方」再生成整片"); return; }
        if (ops.isDirty()) { statusEl.textContent = t("该段有未保存的改动：先点「保存该段」，改动进配方后再生成"); return; }
        const body = { recipe: currentName };
        // 勾选按 1 起的段号发（后端 parse_segment_selection 认段号，越界与坏号整发 400 拒收）：不发 = 跑全部段
        if (checkedSegments.length) body.only_segments = checkedSegments.map((i) => i + 1).join(",");
        // 种子只在整片参数表单里（生成坞不留第二枚种子输入）：这一发带的就是配方落过盘的那一个，-1 = 随机换
        const filmSeed = Math.trunc(Number(recipe?.shared?.seed));
        body.seed = Number.isFinite(filmSeed) ? filmSeed : -1;
        const ovBits = [];
        if (videoModels) {
            const c = videoCfg.collect();
            const push = (key, label) => {
                if (!c[key]) return;
                body[key] = c[key];   // 与视频页自定参数同一批顶层键：空值不进覆盖，该段跟随自己的 skill config
                ovBits.push(tf("{label} {name}", { label, name: String(c[key]).split("/").pop() }));
            };
            push("model", t("模型"));
            push("text_encoder", t("编码器"));
            push("vae", t("VAE"));
            push("audio_vae", t("音频 VAE"));
            if (c.loras?.length) { body.loras = c.loras; ovBits.push(tf("{n} 个 LoRA", { n: c.loras.length })); }
            // 步数只在用户改过面板时才发：各段技能钉着的步数不该被整片覆盖掉
            if (c.steps && !videoCfg.stepsFollowSkill()) { body.steps = c.steps; ovBits.push(tf("{n} 步", { n: c.steps })); }
        }

        stopPolling();
        statusEl.textContent = t("提交中…");
        barEl.style.display = "none";
        media.classList.add("ns-director-idle");   // 这一发的画面没来之前起手卡先站着
        media.replaceChildren(idleCard, liveBox);   // 上一发的成片与定格帧让位：这一发从起手卡开始
        livePlayer.reset();
        let data = null;
        try {
            const r = await api.fetchApi("/neo_studio/director/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            data = await r.json().catch(() => null);
            if (!r.ok || !data?.success) throw new Error(String(data?.error || r.status));
        } catch (e) {
            statusEl.textContent = tf("提交失败：{msg}", { msg: e.message });
            return;
        }
        // 提交成功才把界面交给这一发：WS 事件与轮询兜底都在 setGen 里挂。
        // 按钮不锁——这一发在顶栏队列里跑，用户能接着排下一发
        setGen(data);
        queueTrack("film", data, { label: currentName });
        // 覆盖值要在队列提示里说出来：整片每一段都被这一份模型链盖着，跑完才发现「和配方里钉的不一样」就晚了
        toast(tf("已加入队列：{label}{ov} · 顶栏「队列」看进度", {
            label: currentName,
            ov: ovBits.length ? tf(" · 本次每段临时换：{list}", { list: ovBits.join(" · ") }) : "",
        }));
    }
    runBtn.addEventListener("click", () => submitGenerate());

    cancelBtn.addEventListener("click", async () => {
        if (!genState) return;
        // 中断不可逆：这一发出不了成片，先把「这一发要丢什么」说清楚再动手（与删段同一套 confirm 口径）
        if (!confirm(t("取消这一发生成？排队中的这一发直接出队，已经在跑的立即中断，这一发不出成片。"))) return;
        // 乐观先落「已取消」并收起取消钮：入队前的取消连 prompt_id 都没有，队列项的 cancel 会直接吃灰
        statusEl.textContent = t("已取消");
        cancelBtn.style.display = "none";
        cancelBtn.disabled = true;
        try {
            const r = await api.fetchApi(`/neo_studio/director/${genState.task_id}/cancel`, { method: "POST" });
            const data = await r.json().catch(() => null);
            if (!r.ok) throw new Error(String(data?.error || r.status));
        } catch (e) {
            statusEl.textContent = tf("取消任务失败：{msg}", { msg: e.message });
            cancelBtn.style.display = "";
        }
        cancelBtn.disabled = false;
    });

    promptIn.addEventListener("input", () => {
        const s = segs()[selected];
        if (!s) return;
        s.prompt = promptIn.value;
        markDirty();
        growPrompt();
        timeline.refresh();
    });

    // 配方面板（弹窗里：点卡片 = 选中喂给本页，含复制 / 删除 / 新增；只列多段导演配方）
    panelOpts = () => ({
        directorOnly: true,
        hideTitle: true,            // 弹窗顶栏就是标题（导演配方），面板不再重复一行「📦 配方」
        autoSelectFirst: true,      // 进页就选中首份导演配方：整片生成区与时间轴不用先点一次卡片
        initialSelection: currentName,
        onSelect: (r) => { recipesModal?.close(); openRecipe(r.name); },
        onNewRecipe: () => { recipesModal?.close(); startNewRecipe(); },
    });
    // 编辑器保存 / 新建保存后：重建配方面板（新配方立刻长出一张卡）并把那份配方选中，时间轴与该段控件跟着换
    window.addEventListener(DIRECTOR_RECIPE_SAVED_EVENT, async (e) => {
        await refreshRecipeItems();
        await refreshRecipesPanel();
        const name = e?.detail?.name;
        if (name) await openRecipe(name);
    });
    listVideoSkills().then((list) => { directorSkills = list || []; syncSkillChip(); }).catch(() => {});
    listVideoGenModels().then((models) => {
        videoModels = models || {};
        videoCfg.load({}, videoModels);   // 先按「自动」铺一遍：右栏四行要有清单可挑
        applySkillParams(skillSel.value);   // 再铺当前技能钉的那一套（清单拿不到就整块不发覆盖值，各段技能配置照常生效）
    }).catch(() => { /* 清单拿不到：覆盖面板整块不发值，各段技能配置照常生效 */ });
    recipesPanelEl = await createRecipesPanel(panelOpts());
    recipesHost.appendChild(recipesPanelEl);
    onShown = () => { refreshRecipeItems(); if (currentName) loadSpec(); };
    // 首页的配方卡带 ?recipe= 深链进来：按名字选中那一份导演配方
    openByName = async (name) => {
        await refreshRecipeItems();
        if (findItem(name)) await openRecipe(name);
    };
    await refreshRecipeItems();
}

return {
    buildDirector,
    // 交回装配层的三条跨页落点：进本页补拉、首页深链按名字选配方、顶栏 Esc 收配方弹窗
    directorShown: () => onShown?.(),
    openDirectorRecipe: (name) => openByName?.(name),
    closeRecipesModal: () => recipesModal?.close(),
};
}
