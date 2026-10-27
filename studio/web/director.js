/**
 * director.js — Neo Studio 分镜视频导演编辑器（配方编辑窗口）。
 * 从 recipes.js 拆出：shared(宽高比/百万像素或自定义 W/H) + 逐段(skill/prompt/首帧/时长)
 * + 半自动故事生成/拆分。数据与保存仍走 recipes.js 的 saveRecipe / listVideoSkills / scanMediaNodes。
 */
import { app } from "../../../../scripts/app.js";
import { $el } from "../../../../scripts/ui.js";
import { DirectorTimeline } from "./director-timeline.js";
import { saveRecipe, listVideoSkills, scanMediaNodes, widgetValueToRef } from "./recipes.js";
import { attachSkillPickerToSelect, skillDisplayName, skillAcceptsText, skillAcceptsRef } from "./skill.js";
import { Lightbox } from "./lightbox.js";
import { grabDataType, copyGalleryToInput, toggleGallerySidebar, uploadLocalFiles } from "./media-transfer.js";
import { openLLMSettingsModal } from "./llm-setting.js";
import { actionToast } from "./toast.js";
import { sseStream } from "./prompt-service.js";
import { openStoryboardDialog } from "./gallery-gen.js";
import { isImageFile, isVideoFile, isAudioFile } from "./gallery-utils.js";
import { t, tf } from "./js/core/i18n.js";
import { icon } from "./js/core/icons.js";

// 配方编辑器保存成功后广播：节点内时间轴等监听方据此刷新下拉候选 + 重载 spec。
export const DIRECTOR_RECIPE_SAVED_EVENT = "neo-director-recipe-saved";

// 桌面端 Studio 注册的内嵌宿主：编辑器直接铺进该容器，不再建浮层窗口（画布页不注册 → 保持浮层弹窗）。
// onSaveAndRun 是宿主侧的「保存并生成整片」落点：内嵌模式下底部多出该按钮，保存成功后交给宿主提交生成。
let _editorHost = null;
let _editorHostOnOpen = null;
let _editorHostSaveAndRun = null;
export function setDirectorEditorHost(host, onOpen = null, onSaveAndRun = null) {
    _editorHost = host && host.isConnected ? host : null;
    _editorHostOnOpen = _editorHost ? onOpen : null;
    _editorHostSaveAndRun = _editorHost ? onSaveAndRun : null;
}

// 生成模式（与 ComfyUI_MiniMaxH3_Director 的任务模式对齐；mixed 仅全局可选）：
// f2v 关键帧生视频 = t2v/i2v/fl2v 合并，行为由首/尾帧槽位决定（无帧=文生、仅首帧=图生、仅尾帧=L2VA、两者=首尾帧）；
// r2v 全参考生视频 = r2v/v2v/rv2v 合并，参考素材（图/视频/音频）可选；第一个参考视频即源视频（提示词自动加 <Video 1>）；
// 旧配方的 t2v/i2v/fl2v/v2v/rv2v 载入时静默重映射（后端同样按资产推导）。
export const SEG_MODES = [
    ['f2v', t('关键帧生视频')],
    ['r2v', t('全参考生视频')],
];
export const MODE_LABELS = new Map([...SEG_MODES, ['mixed', t('混合模式')]]);
// 旧模式值 → 合并模式（载入时静默重映射）
export const LEGACY_MODE_MAP = new Map([['t2v', 'f2v'], ['i2v', 'f2v'], ['fl2v', 'f2v'], ['v2v', 'r2v'], ['rv2v', 'r2v']]);

// 参考素材类型（按扩展名）：拖入 / 本地上传的内容类型须与所在组一致（图片不能进参考视频 / 音频组）
const REF_KIND_NAMES = { image: t('图片'), video: t('视频'), audio: t('音频') };

function mediaKindOf(name) {
    if (isImageFile(name)) return 'image';
    if (isVideoFile(name)) return 'video';
    if (isAudioFile(name)) return 'audio';
    return '';
}

/** 画廊拖拽载荷（grabDataType 取回的 JSON）里的文件名；解析失败 / 非画廊拖拽返回 '' */
function refPayloadName(raw) {
    try { return String((JSON.parse(raw) || {}).filename || ''); } catch (e) { return ''; }
}


// ---- LLM 配置弹窗已下沉到 llm-setting.js（openLLMSettingsModal，全局单例），标题栏 按钮直接调用。

// LLM 依赖的操作失败：action toast 给出处理入口，点「打开 LLM 设置」才弹窗（不自动弹出挡界面）。
function handleLLMError(summary, error) {
    actionToast({
        severity: 'error',
        summary: tf("{op}失败", { op: summary }),
        detail: tf("{err}。请检查 API Key / 模型 / 端点。", { err: error || t("未知错误") }),
        actionLabel: t('打开 LLM 设置'),
        onAction: openLLMSettingsModal,
    });
}


/** 创建本地上传用的隐藏 <input type=file>：accept 按素材类型过滤；open() 打开文件选择器，
 *  选择后上传并回调 onUploaded(fname)。返回 { input, open }（input 需挂进 DOM 才能弹出选择器）。 */
function buildLocalFilePicker(accept, onUploaded) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = accept;
    fileInput.style.display = 'none';
    fileInput.onchange = async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const [fname] = await uploadLocalFiles([file]);
        fileInput.value = '';  // 允许重复选择同名文件
        if (fname) onUploaded(fname);
    };
    return { input: fileInput, open: () => fileInput.click() };
}

/** 创建「从本地添加」按钮：点击弹出文件选择器，选择后上传并回调 onUploaded(fname)。 */
function buildLocalAddButton(accept, onUploaded) {
    const picker = buildLocalFilePicker(accept, onUploaded);
    const btn = $el('button', {
        className: 'neo-director-local-add',
        title: t('从本地添加素材'),
        onclick: picker.open,
    }, [
        $el('i', { className: 'pi pi-upload' }),
        $el('span', { textContent: t('本地') }),
    ]);
    btn.appendChild(picker.input);
    return btn;
}

// ==========================================
// 多段导演分辨率选择（移植自 ComfyUI_MiniMaxH3_Director 的 ResolutionSelector 算法）：
// 宽高比 + 百万像素 → 宽/高（按 32 对齐）；「自定义」时手输 W/H。
// ==========================================

export const DIRECTOR_ASPECTS = [
    ["1:1 (方形)", 1, 1],
    ["2:3 (竖版照片)", 2, 3],
    ["3:2 (横版照片)", 3, 2],
    ["3:4 (竖版标准)", 3, 4],
    ["4:3 (标准)", 4, 3],
    ["9:16 (竖屏)", 9, 16],
    ["16:9 (宽屏)", 16, 9],
    ["21:9 (超宽)", 21, 9],
];
export const DIRECTOR_CUSTOM = "自定义";
const DIRECTOR_MULTIPLE = 32;   // MiniMax H3 画布对齐步长
export const MP_MIN = 0.1, MP_MAX = 2, MP_DEFAULT = 0.5;   // 百万像素，取一位小数

export function directorClampMp(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return MP_DEFAULT;
    return Math.round(Math.min(MP_MAX, Math.max(MP_MIN, n)) * 10) / 10;
}

// aspect + 百万像素 → {width,height}（32 对齐）；「自定义」返回 null
export function directorResolution(label, mp) {
    const row = DIRECTOR_ASPECTS.find(([l]) => l === label);
    if (!row) return null;
    const [, rw, rh] = row;
    const total = directorClampMp(mp) * 1024 * 1024;
    const scale = Math.sqrt(total / (rw * rh));
    return {
        width: Math.round((rw * scale) / DIRECTOR_MULTIPLE) * DIRECTOR_MULTIPLE,
        height: Math.round((rh * scale) / DIRECTOR_MULTIPLE) * DIRECTOR_MULTIPLE,
    };
}

// 编辑旧配方（只存了 W/H）时：比例命中预设（±2%）则反推 aspect + 百万像素，否则按自定义处理
export function directorInferAspect(w, h) {
    const row = DIRECTOR_ASPECTS.find(([, rw, rh]) => Math.abs(w / h - rw / rh) / (rw / rh) < 0.02);
    if (!row) return { label: DIRECTOR_CUSTOM, mp: MP_DEFAULT };
    return { label: row[0], mp: directorClampMp((w * h) / (1024 * 1024)) };
}

// 图片 W/H → 最接近的预设比例标签（相对误差最小，绝不回落「自定义」）。
// 宽比宽、高比高，横竖两向都在预设里，所以横版图不会吸附到竖版比例（反之亦然）。
function directorNearestAspect(w, h) {
    const ratio = w / h;
    let best = DIRECTOR_ASPECTS[0][0], bestErr = Infinity;
    for (const [label, rw, rh] of DIRECTOR_ASPECTS) {
        const err = Math.abs(ratio - rw / rh) / (rw / rh);
        if (err < bestErr) { bestErr = err; best = label; }
    }
    return best;
}

// 多段首帧比例一致性检查：各段首帧就近归到预设比例（±3%），超过一组则返回提示。
// 共享分辨率只能取一个比例，其余段会被拉伸变形——保存前据此给非阻塞告警。sizes 来自 /rs_recipes/image_sizes。
export function firstFrameAspectWarning(segments, sizes) {
    const dim = new Map((sizes || []).map((s) => [s.filename, s]));
    const groups = [];   // [{ label, segs: [] }]
    (segments || []).forEach((seg, i) => {
        if (!seg || !seg.first_frame) return;
        const d = dim.get(seg.first_frame);
        if (!d || !d.width || !d.height) return;
        const ratio = d.width / d.height;
        let label = null;
        for (const [l, rw, rh] of DIRECTOR_ASPECTS) {
            if (Math.abs(ratio - rw / rh) / (rw / rh) < 0.03) { label = l; break; }
        }
        if (!label) label = `${d.width}×${d.height}`;
        let g = groups.find((x) => x.label === label);
        if (!g) { g = { label, segs: [] }; groups.push(g); }
        g.segs.push(i + 1);
    });
    if (groups.length < 2) return null;
    const parts = groups.map((g) => tf("{label}（第 {segs} 段）", { label: t(g.label), segs: g.segs.join("、") }));
    return tf("首帧图比例不一致：{parts}——共享分辨率只能取一个比例，其余段会被拉伸变形", { parts: parts.join("；") });
}

// 当前打开的导演编辑器 { name, close, requestClose, isDirty, overlay }：name=配方名（新建模式为 ''）。
// close=无条件关闭（保存成功/放弃修改后），requestClose=用户主动关闭（有未保存修改先出确认条）。
// 单例且支持「已打开时点击另一配方 → 重新加载为该配方」；overlay 仍在 DOM 才视为真正打开。
let _directorEditor = null;
let _directorOpening = false;   // 打开构建中（异步扫描未完成）：期间的重复点击忽略
let _pendingDirectorSwitch = null;   // 脏态挡下的那次切换 { existing, onSaved, focusSeg, opts }：旧编辑器一关就落地
function currentDirectorEditor() {
    if (_directorEditor && _directorEditor.overlay && _directorEditor.overlay.parentNode) return _directorEditor;
    _directorEditor = null; // 浮层已不在（外部清除 / 测试重置 body）→ 丢弃过期状态
    return null;
}

// 配方名 → 上次打开时停在的页签（会话内记忆）：没编辑完就关掉，再开仍回同一页。
const lastTabByName = new Map();
export function resetDirectorTabMemory() { lastTabByName.clear(); }   // 测试用：清跨用例残留

/** 提交「生成/重生成这一段」到 ComfyUI 执行队列，并按 1s 轮询任务状态。
 *  handlers.onStatus(snapshot)：每次拿到的快照（含 queued/running 的进度）；handlers.onDone(snapshot)：终态。
 *  返回 { cancel() }：调 /cancel 取消（协作式）。 */
function runSegmentTask(body, handlers = {}) {
    const onStatus = handlers.onStatus || (() => {});
    const onDone = handlers.onDone || (() => {});
    let taskId = null;
    let timer = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const poll = async () => {
        if (!taskId) return;
        let data = null;
        try {
            const res = await fetch(`/neo_video_gen/run_segment/${taskId}`);
            data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
        } catch (err) {
            stop();
            onDone({ status: 'failed', error: tf("状态查询失败：{err}", { err: err.message }) });
            return;
        }
        if (data.status === 'queued' || data.status === 'running') { onStatus(data); return; }
        stop();
        onDone(data);
    };
    const submit = async () => {
        try {
            const res = await fetch('/neo_video_gen/run_segment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
            taskId = data.task_id;
            onStatus({ ...data, status: data.status || 'queued' });
            timer = setInterval(poll, 1000);
            poll();
        } catch (err) {
            stop();
            onDone({ status: 'failed', error: err.message, submitFailed: true });
        }
    };
    submit();
    return {
        cancel: async () => {
            if (!taskId) return;
            try {
                await fetch(`/neo_video_gen/run_segment/${taskId}/cancel`, { method: 'POST' });
            } catch { /* 取消失败不阻塞 UI 提示 */ }
        },
    };
}

/** 打开分镜视频导演编辑器：shared(宽高比/百万像素或自定义 W/H) + 逐段(skill/prompt/首帧/时长)。
 *  existing 为既有 director 配方 meta（编辑时预填），null = 新建；onSaved 保存成功后回调刷新。
 *  首帧候选取全图已连线的 LoadImage（以原始文件名引用，后端落盘后回写）。保存走 saveRecipe(director=...)。
 *  单例：已打开同一配方 → 忽略重复点击（但按 focusSeg 切换当前段）；已打开另一配方 → 关闭旧窗口并重新加载为该配方；
 *  那份编辑器有未保存修改 → 出确认条并记下要点的那份配方，确认条里「保存并关闭」/「放弃修改」关掉旧编辑器后自动打开它。
 *  opts.onAdopt：编辑器认下这份配方（本次真打开/已开着同一份）时回传，调用方据此落选中——卡片高亮与生成区永远同指一份配方。
 *  focusSeg：打开时定位到该段（0 基；<0 表示不指定，保持默认第 1 段）。
 *  内嵌：Studio 注册过宿主（setDirectorEditorHost）或 opts.container 指定容器时，编辑器直接铺进容器，
 *  不建浮层窗口，也不带 ⛶ 放大 / 右下角缩放 / 标题栏拖动；宿主带 onSaveAndRun 时底部多出「保存并生成整片」。
 *  内嵌保存成功后编辑器留在原地（桌面端导演页上半栏就是它，保存即关等于把刚编辑的界面抽走）：
 *  关闭只由标题栏 ✕ / 底部 取消 / 确认条「保存并关闭」触发，切到别的配方时由单例重载路径关掉。 */
export async function openDirectorEditor(existing = null, onSaved = null, focusSeg = -1, opts = null) {
    const requestedName = (existing && existing.name) || '';
    const hostNode = opts?.node || null;   // 从节点打开时带上节点：重生成用它取连续性/窗口/节点 id
    // 内嵌宿主（Studio 注册 / opts.container 显式指定）：编辑器铺满容器，无浮层 / 无窗口控件
    const host = opts?.container || _editorHost;
    const embedded = !!(host && host.isConnected);
    const saveAndRun = opts?.onSaveAndRun || _editorHostSaveAndRun;
    if (embedded) _editorHostOnOpen?.();   // 宿主侧同步（切到导演页 / 收起占位）
    const cur = currentDirectorEditor();
    if (cur) {
        // 「重复点击=切段」只对已命名配方成立；新建（name=''）每次携带的内容都不同，
        // 命中同名校验会被静默吞掉（图库多选「新建导演配方」点不动的根因），一律走重载路径
        if (requestedName && cur.name === requestedName) { _pendingDirectorSwitch = null; opts?.onAdopt?.(); cur.focusSeg?.(focusSeg); return; }
        if (cur.isDirty()) {
            // 有未保存修改：出确认条并记下要点的那份配方，「保存并关闭」/「放弃修改」关掉旧编辑器即打开它
            _pendingDirectorSwitch = { existing, onSaved, focusSeg, opts };
            cur.requestClose();
            return;
        }
        _pendingDirectorSwitch = null;    // 干净切换：别让旧编辑器关闭时消费掉上一次挡下的目标
        cur.close();                      // 另一配方 / 新建 → 关闭旧窗口，重载为该配方
    } else if (document.querySelector('.neo-director-overlay')) {
        return; // 兜底：状态缺失但浮层仍在 → 忽略，避免叠加
    }
    // 单例状态要等构建收尾才落地，而开头两次扫描是异步的：这段时间的重复点击
    // （连点配方卡 / 连点时间轴段）会叠出第二个编辑器 → 构建中标记，期间一律忽略
    if (_directorOpening) return;
    _directorOpening = true;
    // 已连线媒体候选（LoadImage / LoadVideo / LoadAudio）：图给首帧与参考图网格，视频/音频给各自参考网格
    const imageRefs = [], videoRefs = [], audioRefs = [];
    try {
        const { media } = await scanMediaNodes();
        for (const [kind, bucket] of [['image', imageRefs], ['video', videoRefs], ['audio', audioRefs]]) {
            for (const s of media) {
                if (s.kind !== kind || s.slot == null) continue;
                const ref = widgetValueToRef(s.value);
                if (ref) bucket.push(Object.assign(ref, { kind }));
            }
        }
    } catch (e) { console.error('[Neo Recipes] Director: collect media failed', e); }

    let skills = [];
    try { skills = await listVideoSkills(); } catch (e) {}
    _directorOpening = false;   // 以下构建同步完成，收尾即落地单例状态，无插空窗口

    const exShared = (existing && existing.shared) || {};
    const exSegs = (existing && Array.isArray(existing.segments)) ? existing.segments : [];
    const exStory = (existing && existing.story) || {};   // 故事板页落盘内容（全局故事参考 / 角色参考图），编辑旧配方时回显
    const exSetup = (existing && existing.setup) || {};   // 统一设置区落盘内容（各段原文快照），编辑旧配方时回显
    let origPrompts = Array.isArray(exSetup.orig_prompts) ? exSetup.orig_prompts : null;  // 首次生成前的各段原文快照，随 setup 落盘、重开回显
    let segCounter = 0; // 段身份计数：时间轴颜色按段内容绑定，重排不变色
    let modeSel = null;   // 全局生成模式（文生/图生/混合），在时间线面板中创建后赋值
    let gSkillSel = null;      // 统一技能选择（非混合模式：各段共用，紧邻生成模式；混合模式隐藏）
    let chunkSecInp = null;    // 分块秒数 shared.chunk_sec：连续兼容段合并成一次多帧单次运行的预算（0 = 关闭），时间线面板创建后赋值
    let chunkSecLabel = null;   // 「分块秒数」标签：与输入框成对，仅当统一技能支持多帧时显示
    let seedSharedInp = null;       // 整片种子 shared.seed：留空 = 随机（落 -1），时间线面板创建后赋值
    let stepsSharedInp = null;      // 整片步数 shared.steps：留空 = 各段技能 config 的步数（落 -1）
    let continuitySharedChk = null; // 跨段连续性 shared.continuity：上下文窗口 + 身份继承
    let ctxSharedInp = null;        // 上下文帧 shared.context_frames：0 = 退回尾帧链入
    let ctxSharedWrap = null;       // 「上下文帧」字段组：连续性关掉时隐藏（关掉时该值不参与生成）
    let refreshSegScale = () => {}; // 段数一变就重算的显隐（分块秒数 / 单段引导 / 各段对照）：时间线面板建好后赋值，renumberSegs 里回调

    // 未保存修改标记：任何会改变落盘内容的操作置位；成功保存 / 关闭后清零。
    let dirty = false;
    const markDirty = () => { dirty = true; };

    // 配方 assets/ 里的文件名（含新生成的分镜关键帧）：缩略图走 /rs_recipes/asset，不经 input/
    const recipeAssetFiles = new Set(((existing && existing.assets) || [])
        .map(a => (typeof a === 'string' ? a : ((a || {}).file || ''))));
    // 当前配方名（与分镜落盘同名）：取输入框值，编辑已存配方回退 requestedName。
    // _nameEl 指向配方名输入框（openDirectorEditor 后期才创建），早期渲染为 null → 安全降级
    let _nameEl = null;
    const currentRecipeName = () => {
        const v = _nameEl ? (_nameEl.value || '') : '';
        return v.trim() || requestedName || 'untitled';
    };
    const assetThumbUrl = (fname) => `/rs_recipes/asset?recipe=${encodeURIComponent(currentRecipeName())}&file=${encodeURIComponent(fname)}`;
    // 缩略图按来源解析：配方资产走 /rs_recipes/asset，其余（画布 LoadImage / 新拖入文件）走 /view
    const thumbSrc = (fname, subfolder = '') => recipeAssetFiles.has(fname)
        ? assetThumbUrl(fname)
        : `/view?filename=${encodeURIComponent(fname)}&subfolder=${encodeURIComponent(subfolder)}&type=input`;

    // 每段参考素材：三组多选网格，上限与 H3 参考节点（MiniMaxH3ReferenceToVideo）槽位一致
    const SEG_REF_GROUPS = [
        { key: 'images', kind: 'image', label: t('参考图'), max: 9 },
        { key: 'videos', kind: 'video', label: t('参考视频'), max: 3 },
        { key: 'audios', kind: 'audio', label: t('参考音频'), max: 3 },
    ];
    const SEG_MODE_KEYS = new Set(SEG_MODES.map(([k]) => k));
    const segRefReaders = new Map();    // 段行 → [读取该段三组参考的函数]（保存时按当前 DOM 顺序取）
    const segRefSetters = new Map();    // 段行 → [设置该段三组参考的函数]（「同步到所有分段」用）
    const segFrameReaders = new Map();  // 段行 → {first, last} 读取该段首/尾帧的函数
    const segFrameSetters = new Map();  // 段行 → {first, last} 设置该段首/尾帧的函数（统一设置自动应用用）

    /** 一组参考素材的「已用列表」：只显示当前挂上的素材，拖入/本地上传直接插入；
     *  瓷砖可鼠标拖放调整顺序、✕ 移除。顺序即保存与时间轴展示顺序，数量受 group.max 上限约束。 */
    function buildSegRefRow(group, initialNames, headExtra, onChange, onOpenTile = null, thumbH = 96) {
        const list = [];   // 已用素材文件名（有序）：顺序即该段参考素材的先后
        const grid = $el('div', { className: 'neo-director-refpick-grid' });
        const count = $el('span', { className: 'neo-director-refpick-count' });
        const sizeTile = (tile, w, h) => { if (w && h) tile.style.width = Math.max(36, thumbH * (w / h)) + 'px'; };   // 瓷砖高度固定 thumbH；宽度按画面比例自适应、紧密平铺不留空白
        const warn = (detail) => app.extensionManager.toast.add({ severity: 'warning', summary: t('多段导演'), detail, life: 4000 });
        let dragIdx = null;   // 正在拖放的瓷砖序号（内部重排用，区别于外部素材拖入）
        // 每次改动都整体重建瓷砖（列表 ≤9，开销可忽略），保证顺序始终对应当前排列
        const render = () => {
            grid.innerHTML = '';
            list.forEach((name, i) => {
                const url = thumbSrc(name);
                let media;
                if (group.kind === 'image') media = $el('img', { className: 'neo-director-refpick-thumb', src: url, alt: name, loading: 'lazy', draggable: false });
                else if (group.kind === 'video') media = $el('video', { className: 'neo-director-refpick-thumb', src: url, muted: true, preload: 'metadata' });
                else media = $el('div', { className: 'neo-director-refpick-thumb neo-director-refpick-thumb-audio', textContent: '' });
                const delBtn = $el('button', { className: 'neo-director-refpick-del', title: t('移除该素材'), textContent: '✕' });
                const tile = $el('div', { className: 'neo-director-refpick-item', style: { height: thumbH + 'px' }, title: name, draggable: true, dataset: { file: name } }, [media, delBtn]);
                // 加载后按画面比例设置瓷砖宽度（图 naturalWidth/Height、视频 videoWidth/Height）
                if (group.kind === 'image') media.addEventListener('load', () => sizeTile(tile, media.naturalWidth, media.naturalHeight));
                else if (group.kind === 'video') media.addEventListener('loadedmetadata', () => sizeTile(tile, media.videoWidth, media.videoHeight));
                if (onOpenTile) media.addEventListener('click', (e) => { e.stopPropagation(); onOpenTile(list, i); });   // 点缩略图看大图（Lightbox 由调用方提供）
                delBtn.onclick = (e) => { e.stopPropagation(); list.splice(i, 1); render(); markDirty(); if (onChange) onChange(); };
                tile.addEventListener('dragstart', (e) => {
                    dragIdx = i;
                    e.dataTransfer.effectAllowed = 'move';
                    try { e.dataTransfer.setData('text/plain', name); } catch (_) {}
                    tile.classList.add('neo-director-refpick-dragging');
                });
                tile.addEventListener('dragend', () => {
                    dragIdx = null;
                    tile.classList.remove('neo-director-refpick-dragging');
                });
                grid.appendChild(tile);
            });
            grid.classList.toggle('has-items', list.length > 0);   // 有素材时去掉空态虚线框、瓷砖顶格紧密平铺
            count.textContent = `${list.length}/${group.max}`;
        };
        // 插入新素材（拖入/本地上传/程序回填）：去重 + 上限校验，达上限则提示并拒绝；quiet=true 供初始化回填静默插入（不标未保存）
        const insert = (name, quiet) => {
            if (!name || list.includes(name)) return;
            if (list.length >= group.max) { warn(tf("{label}最多 {max} 个", { label: group.label, max: group.max })); return; }
            list.push(name);
            render();
            if (!quiet) markDirty();
            if (onChange) onChange();
        };
        // 整体替换本组素材（「同步到所有分段」用）：去重 + 上限约束后重建
        const set = (names) => {
            list.length = 0;
            for (const n of (Array.isArray(names) ? names : [])) {
                if (n && !list.includes(n) && list.length < group.max) list.push(n);
            }
            render();
            markDirty();
        };
        for (const name of (Array.isArray(initialNames) ? initialNames : [])) {
            if (name && !list.includes(name)) list.push(name);   // 编辑旧配方回显（已存数据本就合规）
        }
        render();
        // 拖放重排：把被拖瓷砖移到指针所在瓷砖的前/后（按水平中线判断插入位）
        const reorderFromDrop = (e) => {
            const from = dragIdx;
            dragIdx = null;
            if (from == null || from >= list.length) return;
            const tiles = Array.from(grid.querySelectorAll('.neo-director-refpick-item'));
            let insertAt = tiles.length;
            for (let k = 0; k < tiles.length; k++) {
                const r = tiles[k].getBoundingClientRect();
                if (e.clientX < r.left + r.width / 2) { insertAt = k; break; }
            }
            let at = from < insertAt ? insertAt - 1 : insertAt;
            const item = list.splice(from, 1)[0];
            at = Math.max(0, Math.min(list.length, at));
            list.splice(at, 0, item);
            render();
            markDirty();
            if (onChange) onChange();
        };
        // 类型校验：只收本组类型（图片不能落进参考视频 / 参考音频组）——拖入与本地上传共用一道校验
        const acceptMap = { image: 'image/*', video: 'video/*', audio: 'audio/*' };
        const acceptMime = acceptMap[group.kind] || '*/*';
        const kindName = REF_KIND_NAMES[group.kind] || t('素材');
        const kindReject = (name) => warn(tf("{label}只接受{kind}素材，已忽略：{name}", { label: group.label, kind: kindName, name }));
        const insertTyped = (name) => {
            if (!name) return;
            if (mediaKindOf(name) !== group.kind) { kindReject(name); return; }
            insert(name);
        };
        // OS 文件拖入：dragover 阶段就能读到 MIME，类型不符直接禁止落放（光标变禁、不亮高亮）
        const osFilesMatchKind = (dt) => Array.from((dt && dt.files) || [])
            .every((f) => String(f.type || '').startsWith(acceptMime.replace('*', '')));
        grid.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (dragIdx != null) { e.dataTransfer.dropEffect = 'move'; return; }   // 内部重排：不亮「新素材」高亮
            if (!osFilesMatchKind(e.dataTransfer)) { e.dataTransfer.dropEffect = 'none'; return; }
            e.dataTransfer.dropEffect = 'copy';
            grid.classList.add('neo-director-drop');
        });
        grid.addEventListener('dragleave', (e) => { if (!grid.contains(e.relatedTarget)) grid.classList.remove('neo-director-drop'); });
        grid.addEventListener('drop', async (e) => {
            e.preventDefault(); grid.classList.remove('neo-director-drop');
            if (dragIdx != null) { reorderFromDrop(e); return; }   // 内部瓷砖拖放 = 重排
            // 画廊拖拽在 dragover 阶段读不到文件名，故落放时先按扩展名校验：类型不符不落盘（图片会被当视频参考喂给模型）
            const raw = grabDataType(e);
            const name = refPayloadName(raw);
            if (name && mediaKindOf(name) !== group.kind) { kindReject(name); return; }
            const fname = await copyGalleryToInput(raw);
            if (fname) insert(fname);
        });
        // 本地上传：去掉「本地」按钮，改为点击网格黑色空区弹出文件选择器（隐藏 input 挂在行上，避免被 render() 清空）
        const picker = buildLocalFilePicker(acceptMime, (fname) => insertTyped(fname));
        grid.addEventListener('click', (e) => {
            if (e.target.closest('.neo-director-refpick-item')) return;   // 点瓷砖（移除/拖拽）不触发上传
            picker.open();
        });
        const head = $el('div', { className: 'neo-director-segref-head' }, [
            $el('span', { className: 'neo-director-field-label', textContent: tf("{label}（最多 {max}）", { label: group.label, max: group.max }) }),
            ...(headExtra ? [headExtra] : []),
            count,
        ]);
        const row = $el('div', { className: 'neo-director-segref-row' }, [
            ...(group.hideHead ? [] : [head]),
            grid,
        ]);
        row.appendChild(picker.input);
        return { row, getSelected: () => list.slice(), set, insert };
    }

    /** 弹窗取用的落地：画廊素材进 input/ 根目录（导演帧一律走 /view?subfolder=），根目录图直接原名。 */
    const galleryPickFname = async (im) =>
        im.subfolder ? await copyGalleryToInput(JSON.stringify(im)) : im.filename;

    /** 「素材库」按钮：打开 ComfyUI 左侧 Neo Gallery 面板（首帧行 / 参考区共用）。
     *  target 传主目录名（"CharacterSheet" / "StoryBoard"，就是 /neo_gallery/list 的 dir_name）时顺带导航到该目录，按钮文案随之具体化（角色素材库 / 宫格图素材库），便于直接取角色图 / 分镜图。
     *  onPick 传取用回调（Studio 弹窗点卡片 / 批量取用时调用，参数 [{filename, subfolder}]）：
     *  经 neo:media-pick 事件交给 Studio 宿主；ComfyUI 模式没有监听，照旧只是开侧栏拖拽。 */
    const buildAssetLibButton = (target, onPick) => {
        const label = target === 'CharacterSheet' ? t('角色素材库') : target === 'StoryBoard' ? t('宫格图素材库') : t('素材库');
        return $el('button', {
            className: 'neo-director-ff-lib',
            title: target ? tf("打开素材库（{target}）", { target }) : t('打开素材库'),
            onclick: () => {
                window.dispatchEvent(new CustomEvent('neo:media-pick', { detail: { target, onPick } }));
                toggleGallerySidebar(target, []);
            },
        }, [
            $el('i', { className: 'pi pi-images' }),
            $el('span', { textContent: label }),
        ]);
    };

    /** 首/尾帧槽位上传（与故事板分镜对照表缩略位同款体验）：拖入替换 / 点击空态本地上传。 */
    function attachFrameSlotUpload(thumb, setFn) {
        thumb.addEventListener('dragover', (e) => { if (segReordering) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; thumb.classList.add('neo-director-drop'); });
        thumb.addEventListener('dragleave', (e) => { if (!thumb.contains(e.relatedTarget)) thumb.classList.remove('neo-director-drop'); });
        thumb.addEventListener('drop', async (e) => {
            e.preventDefault();
            if (segReordering) return;
            thumb.classList.remove('neo-director-drop');
            const fnames = await extractDroppedImageFnames(e);
            if (!fnames.length) return;
            // 登记进保存资产清单（配方 assets/ 里已有的只作缩略图来源，不重复落盘）
            for (const f of fnames) {
                if (!recipeAssetFiles.has(f) && !imageRefs.some(r => r.filename === f)) {
                    imageRefs.push({ filename: f, subfolder: '', type: 'input', kind: 'image' });
                }
            }
            setFn(fnames[0]);
        });
        // 空态点击本地上传（已填图时点缩略图看大图，由 fillSegThumb 处理）
        const picker = buildLocalFilePicker('image/*', (fname) => {
            if (!recipeAssetFiles.has(fname) && !imageRefs.some(r => r.filename === fname)) {
                imageRefs.push({ filename: fname, subfolder: '', type: 'input', kind: 'image' });
            }
            setFn(fname);
        });
        thumb.appendChild(picker.input);
        thumb.addEventListener('click', () => { if (!thumb.querySelector('a')) picker.open(); });
    }

    function buildSeg(seg = {}) {
        const skillSel = $el('select', { className: 'neo-director-skill' });
        if (!skills.length) skillSel.appendChild($el('option', { value: '', textContent: t('（无可用视频技能）') }));
        for (const s of skills) {
            const opt = $el('option', { value: s.id, textContent: skillDisplayName(s) });
            opt.dataset.source = s.source || 'custom'; // 详情弹窗按 source 区分预设只读/自定义可编辑
            opt.__skillMeta = s; // 选择窗浮动预览卡取 gen_config / 分类等元数据
            skillSel.appendChild(opt);
        }
        if (seg.skill_id) skillSel.value = seg.skill_id;
        // 点击弹居中搜索窗（替代原生下拉）；refreshSegSkillOptions 重建 options 后监听仍在 select 上生效
        attachSkillPickerToSelect(skillSel);

        const promptTa = $el('textarea', { className: 'neo-director-prompt', placeholder: t('该段画面 / 运动描述（必填）'), value: seg.prompt || '' });
        const durInp = $el('input', { className: 'neo-director-dur', type: 'number', min: 1, max: 3600, value: (seg.duration_sec != null ? seg.duration_sec : 5) });

        // 关键帧生视频（f2v）：与故事板分镜对照表同构的两栏——左栏首帧槽位 / 右栏提示词；
        // 尾帧用得少（默认衔接下一段首帧），收在扩展按钮里。槽位体验同分镜缩略位：拖入 / 点击上传 / 悬停 ✕ / Lightbox。
        let ffVal = seg.first_frame || '';
        let lfVal = seg.last_frame || '';
        const ffSlot = $el('div', { className: 'neo-director-setup-seg-thumb' });
        // 重渲染只清展示内容，保留槽位内挂的隐藏 file input（attachFrameSlotUpload 用）
        const clearSlotEl = (slot) => { Array.from(slot.children).forEach((c) => { if (c.tagName !== 'INPUT') c.remove(); }); };
        const renderFfSlot = () => {
            clearSlotEl(ffSlot);
            if (ffVal) {
                fillSegThumb(ffSlot, ffVal, () => frameSetters.first(''),
                    () => Lightbox.open({ items: [{ kind: 'image', url: thumbSrc(ffVal), title: tf("首帧 · {name}", { name: ffVal }) }] }), t('清除该段首帧'));
            } else {
                ffSlot.classList.add('neo-director-setup-seg-thumb-empty');
                ffSlot.appendChild($el('span', { className: 'neo-director-setup-seg-thumb-hint', textContent: t('＋ 拖入 / 上传首帧') }));
            }
        };
        const lfToggleBtn = $el('button', { className: 'neo-director-lf-toggle', type: 'button', title: t('尾帧（锁住该段收尾画面；默认衔接下一段首帧，少用）') });
        const lfSlotWrap = $el('div', { className: 'neo-director-lf-slot-wrap' });
        const lfSlot = $el('div', { className: 'neo-director-setup-seg-thumb' });
        lfSlotWrap.appendChild(lfSlot);
        let lfExpanded = false;
        const renderLfState = () => {
            clearSlotEl(lfSlot);
            if (lfVal) {
                fillSegThumb(lfSlot, lfVal, () => frameSetters.last(''),
                    () => Lightbox.open({ items: [{ kind: 'image', url: thumbSrc(lfVal), title: tf("尾帧 · {name}", { name: lfVal }) }] }), t('清除该段尾帧'));
            } else {
                lfSlot.classList.add('neo-director-setup-seg-thumb-empty');
                lfSlot.appendChild($el('span', { className: 'neo-director-setup-seg-thumb-hint', textContent: t('＋ 拖入 / 上传尾帧') }));
            }
            lfToggleBtn.innerHTML = '';
            if (lfVal) {
                lfToggleBtn.appendChild($el('img', { className: 'neo-director-lf-chip', src: thumbSrc(lfVal), alt: '' }));
                lfToggleBtn.appendChild($el('span', { textContent: t('尾帧') }));
            } else {
                lfToggleBtn.appendChild($el('span', { textContent: t('＋ 尾帧') }));
            }
            lfSlotWrap.style.display = lfExpanded ? '' : 'none';
        };
        const frameSetters = {
            first: (v) => { ffVal = v || ''; renderFfSlot(); markDirty(); },
            last: (v) => { lfVal = v || ''; renderLfState(); markDirty(); },
        };
        attachFrameSlotUpload(ffSlot, frameSetters.first);
        attachFrameSlotUpload(lfSlot, frameSetters.last);
        lfToggleBtn.onclick = () => { lfExpanded = !lfExpanded; renderLfState(); };
        renderFfSlot();
        renderLfState();
        
        // 本段模式（仅全局“混合模式”下显示）：关键帧生视频 / 全参考
        const segModeSel = $el('select', { className: 'neo-director-segmode' });
        for (const [val, label] of SEG_MODES) segModeSel.appendChild($el('option', { value: val, textContent: label }));
        const segModeVal = LEGACY_MODE_MAP.get(seg.mode || '') || seg.mode || '';   // 旧 t2v/i2v/fl2v/v2v/rv2v → f2v/r2v，其余原样保留
        segModeSel.value = SEG_MODE_KEYS.has(segModeVal) ? segModeVal : 'f2v';

        const removeBtn = $el('button', { className: 'neo-director-seg-del', title: t('删除该段') }, [icon('trash')]);
        // ♻ 重生成该段：从成片取前后真实帧当锚点，换种子单独跑这一段（产物记进配方「结果」区）
        const regenBtn = $el('button', { className: 'neo-director-seg-regen', title: t('重生成该段（锚点：用成片里的前后真实帧）'), textContent: '♻' });
        regenBtn.onclick = (e) => { e.stopPropagation(); openRegenPanel(row, regenBtn); };
        const segModeRow = $el('div', { className: 'neo-director-segmode-row' }, [
            $el('label', { className: 'neo-director-field-label', textContent: t('本段模式') }), segModeSel,
        ]);

        // 「同步到所有分段」：把本段三组参考素材（图/视频/音频）一键覆盖式复制到其余各段
        let selfRowRef = null;   // 本段行引用（row 创建后赋值），供同步按钮定位同步源
        const syncBtn = $el('button', { className: 'neo-director-segref-sync', title: t('把本段参考素材同步到所有分段') }, [
            $el('i', { className: 'pi pi-copy' }),
            $el('span', { textContent: t('同步到所有分段') }),
        ]);
        syncBtn.onclick = () => {
            const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
            if (rows.length < 2) { app.extensionManager.toast.add({ severity: 'info', summary: t('多段导演'), detail: t('只有一个分段，无需同步'), life: 3000 }); return; }
            const src = (segRefReaders.get(selfRowRef) || []).map(r => r());   // [图, 视频, 音频]
            if (!src.some(a => a.length)) { app.extensionManager.toast.add({ severity: 'warning', summary: t('多段导演'), detail: t('本段没有可同步的参考素材'), life: 3000 }); return; }
            for (const other of rows) {
                const setters = segRefSetters.get(other) || [];
                setters.forEach((set, gi) => set && set(src[gi]));
            }
            app.extensionManager.toast.add({ severity: 'success', summary: t('多段导演'), detail: tf("已把本段参考素材同步到全部 {n} 个分段", { n: rows.length }), life: 3000 });
        };
        const segRefRows = SEG_REF_GROUPS.map((g) => buildSegRefRow(g, (seg.refs || {})[g.key]));
        const refsBlock = $el('div', { className: 'neo-director-refs-block' }, [
            $el('div', { className: 'neo-director-refs-head' }, [
                $el('span', { className: 'neo-director-field-label', textContent: t('参考素材（参考生视频技能用：图 / 视频 / 音频）') }),
                syncBtn,
                buildAssetLibButton(null, async (imgs) => {
                    for (const im of imgs) {
                        const fname = await galleryPickFname(im);
                        if (fname) segRefRows[0].insert(fname);
                    }
                }),
            ]),
            segRefRows[0].row,  // 参考图独占一行（最多 9 个，需要更多空间）
            $el('div', { className: 'neo-director-ref-row-pair' }, [
                segRefRows[1].row,  // 参考视频
                segRefRows[2].row,  // 参考音频
            ]),
        ]);

        // 两栏行（与故事板分镜对照表同构）：左栏首帧槽位 + 尾帧扩展 / 右栏提示词；
        // 非 f2v 模式隐藏帧槽位，参考素材区移入左栏——所有资源输入在左、提示词在右，各模式输入体验统一
        const framesLabels = $el('div', { className: 'neo-director-frames-cols neo-director-frames-labels' }, [
            $el('span', { textContent: t('首帧') }),
            $el('span', { textContent: t('提示词（必填）') }),
        ]);
        const lfRow = $el('div', { className: 'neo-director-lf-row' }, [lfToggleBtn, lfSlotWrap]);
        const frameCol = $el('div', { className: 'neo-director-frame-col' }, [ffSlot, lfRow, refsBlock]);
        const framesCols = $el('div', { className: 'neo-director-frames-cols' }, [frameCol, promptTa]);

        const row = $el('div', { className: 'neo-director-seg', dataset: { segId: 'seg-' + (++segCounter) } }, [
            $el('div', { className: 'neo-director-seg-head' }, [
                $el('span', { className: 'neo-director-seg-title', textContent: t('段') }),
                segModeRow,   // 本段模式（仅混合模式显示）：紧跟段标题、位于技能之前，同一行
                $el('label', { className: 'neo-director-field-label neo-director-skill-label', textContent: t('技能（决定模板与模型）') }), skillSel,
                $el('label', { className: 'neo-director-field-label', textContent: t('时长（秒）') }), durInp,
                regenBtn,
                removeBtn,
            ]),
            framesLabels,
            framesCols,
        ]);

        // 本段模式切换 → 刷新该段帧行 / 参考素材区显隐
        segModeSel.addEventListener('change', () => applyGlobalMode());
        row._addRefImage = segRefRows[0].insert;   // 分镜关键帧回填：加入该段参考图池（r2v，去重 + 上限校验）
        segFrameReaders.set(row, { first: () => ffVal, last: () => lfVal });
        segFrameSetters.set(row, frameSetters);
        segRefReaders.set(row, segRefRows.map(r => r.getSelected));
        segRefSetters.set(row, segRefRows.map(r => r.set));
        selfRowRef = row;   // 同步按钮据此定位本段（作为同步源）
        removeBtn.onclick = () => {
            const idx = Array.from(segsWrap.querySelectorAll('.neo-director-seg')).indexOf(row);
            const wasCurrent = currentSegId === row.dataset.segId;
            row.remove();
            renumberSegs();
            markDirty();
            if (wasCurrent) showSeg(Math.max(0, idx - 1));
        };
        if (seg.storyboard) {
            // 回显已存分镜图：记到段行（保存时随 storyboard 落盘），并登记为配方资产（缩略图走 /rs_recipes/asset）
            row.dataset.storyboard = seg.storyboard;
            recipeAssetFiles.add(seg.storyboard);
        }
        if (seg.storyboard_prompt) row.dataset.storyboardPrompt = seg.storyboard_prompt;   // 分镜图提示词快照（拆分 LLM 产出，可缺省）
        return row;
    }

    /** ♻ 单段生成/重生成：提交到 ComfyUI 执行队列（进度/取消都用执行器），轮询任务状态。 */
    function openRegenPanel(row, btn) {
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        const index = rows.indexOf(row);
        const name = (nameInp?.value || '').trim() || requestedName || 'untitled';
        row.querySelector('.neo-director-seg-regen-panel')?.remove();
        // 成片候选：配方 results 的存储顺序是旧 → 新，倒过来即「最新在前」，与后端 list_recipe_results 一致
        // （不按 at 排序：老记录可能没有 at 字段，存储顺序才是权威）
        const films = ((existing && existing.results) || [])
            .filter((r) => r.kind === 'video' && r.segment == null)
            .reverse();
        const hasFilm = films.length > 0;
        const seedSel = $el('select', { className: 'neo-director-regen-seed' }, [
            $el('option', { value: 'new', textContent: t('换种子（默认）') }),
            $el('option', { value: 'keep', textContent: t('沿用节点种子') }),
        ]);
        const anchorSel = $el('select', { className: 'neo-director-regen-anchors' }, [
            $el('option', { value: 'both', textContent: t('两端锚点（首+尾，最稳）') }),
            $el('option', { value: 'first', textContent: t('只钉首帧') }),
            $el('option', { value: 'none', textContent: t('不用锚点') }),
        ]);
        if (!hasFilm) anchorSel.value = 'none';
        const filmLabel = $el('label', { className: 'neo-director-field-label', textContent: t('锚点来源') });
        const filmSel = hasFilm && films.length > 1
            ? $el('select', { className: 'neo-director-regen-film' }, [
                $el('option', { value: '', textContent: tf("自动：最新的成片（{name}）", { name: films[0].filename }) }),
                ...films.map((f, i) => $el('option', {
                    value: f.filename, textContent: f.filename + (i === 0 ? t('（最新）') : ''),
                })),
            ])
            : null;
        const runBtn = $el('button', { className: 'rs-btn neo-director-regen-run', type: 'button', textContent: t('生成这一段') });
        const cancelBtn = $el('button', { className: 'rs-btn neo-director-regen-cancel', type: 'button', textContent: t('取消任务') });
        cancelBtn.style.display = 'none';
        const statusEl = $el('div', { className: 'neo-director-regen-status' });
        const usedFilm = () => (filmSel ? filmSel.value : '') || films[0]?.filename || '';
        const refreshHint = () => {
            const showFilm = hasFilm && anchorSel.value !== 'none' && !!filmSel;
            filmLabel.style.display = showFilm ? '' : 'none';
            if (filmSel) filmSel.style.display = showFilm ? '' : 'none';
            if (!hasFilm) {
                statusEl.textContent = t('该配方还没有成片：将按这一段自身的模式与参考直接生成（单段调试）');
                return;
            }
            if (anchorSel.value === 'none') {
                statusEl.textContent = tf("不用锚点：按这一段自身的模式生成（该配方有 {n} 个成片结果，选锚点可基于其中之一）", { n: films.length });
                return;
            }
            statusEl.textContent = tf("锚点取自成片「{film}」里该段前后的真实帧；任务走 ComfyUI 执行队列（可看进度 / 取消）", { film: usedFilm() })
                + (films.length > 1 ? tf("。该配方有 {n} 个成片结果，可在上方切换来源", { n: films.length }) : '');
        };
        const panel = $el('div', { className: 'neo-director-seg-regen-panel' }, [
            $el('label', { className: 'neo-director-field-label', textContent: t('种子') }), seedSel,
            $el('label', { className: 'neo-director-field-label', textContent: t('锚点') }), anchorSel,
            ...(filmSel ? [filmLabel, filmSel] : []),   // 只有一个成片时不给下拉，成片名写在提示行里
            runBtn, cancelBtn,
            statusEl,
        ]);
        refreshHint();
        anchorSel.addEventListener('change', refreshHint);
        filmSel?.addEventListener('change', refreshHint);
        // ② 单段生成的后续步骤：把这一段拼回成片（其余段沿用原成片）
        let hasClip = ((existing && existing.results) || [])
            .some((res) => res.kind === 'video' && res.segment === index);
        const mergeBtn = $el('button', { className: 'rs-btn neo-director-merge-run', type: 'button', textContent: t('拼回成片') });
        const mergeCancel = $el('button', { className: 'rs-btn neo-director-merge-cancel', type: 'button', textContent: t('取消拼接') });
        mergeCancel.style.display = 'none';
        const mergeLine = $el('div', { className: 'neo-director-merge-status' });
        const mergeRow = $el('div', { className: 'neo-director-regen-merge' }, [mergeBtn, mergeCancel]);
        panel.appendChild(mergeRow);
        panel.appendChild(mergeLine);
        let mergeHandle = null;
        const setMergeIdle = (text) => {
            mergeHandle = null;
            mergeBtn.disabled = !hasClip;
            mergeCancel.style.display = 'none';
            mergeLine.textContent = text
                || (hasClip ? t('这一段已有片段：可拼回成片（其余段沿用原成片，原成片不受影响）')
                            : t('先生成这一段，之后就能一键拼回成片'));
        };
        setMergeIdle('');
        const widgetValue = (n) => { const w = hostNode?.widgets?.find((x) => x.name === n); return w ? w.value : undefined; };
        const mergeBody = () => {
            const payload = { recipe: name, use: [index], blend: 0 };   // 拼回成片不做接缝交叉淡化（硬切）
            if (filmSel?.value) payload.film = filmSel.value;      // 用的是这一段的锚点来源成片
            if (hostNode) {
                payload.continuity = !!widgetValue('continuity');
                const cf = Number(widgetValue('context_frames'));
                if (Number.isFinite(cf)) payload.context_frames = cf;
            }
            return payload;
        };
        mergeBtn.onclick = async () => {
            mergeBtn.disabled = true;
            mergeCancel.style.display = '';
            mergeLine.textContent = t('正在提交拼接…');
            let taskId = null;
            try {
                const res = await fetch('/neo_video_gen/assemble_segments', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(mergeBody()),
                });
                const data = await res.json().catch(() => null);
                if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
                taskId = data.task_id;
            } catch (err) {
                setMergeIdle(tf("提交失败：{err}", { err: err.message }));
                app.extensionManager.toast.add({ severity: 'error', summary: t('拼接提交失败'), detail: err.message, life: 8000 });
                return;
            }
            mergeHandle = {
                cancel: async () => {
                    try { await fetch(`/neo_video_gen/assemble_segments/${taskId}/cancel`, { method: 'POST' }); } catch { /* 忽略 */ }
                },
            };
            let timer = null;
            const tick = async () => {
                let data = null;
                try {
                    const res = await fetch(`/neo_video_gen/assemble_segments/${taskId}`);
                    data = await res.json().catch(() => null);
                    if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
                } catch (err) {
                    clearInterval(timer);
                    setMergeIdle(tf("状态查询失败：{err}", { err: err.message }));
                    return;
                }
                const pct = (data.progress && data.progress.max > 0)
                    ? ` ${Math.round((Number(data.progress.value) / Number(data.progress.max)) * 100)}%` : '';
                if (data.status === 'queued' || data.status === 'running') {
                    mergeLine.textContent = `${data.stage || '拼接中'}…${pct}`;
                    return;
                }
                clearInterval(timer);
                if (data.status === 'succeeded') {
                    for (const warning of (data.warnings || [])) {
                        app.extensionManager.toast.add({ severity: 'warn', summary: t('拼接提示'), detail: warning, life: 6000 });
                    }
                    app.extensionManager.toast.add({
                        severity: 'success', summary: t('已拼回成片'),
                        detail: tf("{file}（{frames} 帧，第 {n} 段已换成新片段）", { file: data.filename, frames: data.frames, n: index + 1 }), life: 6000,
                    });
                    setMergeIdle(tf("已拼成新成片：{file}（记进配方「结果」区，后续重生成默认基于它）", { file: data.filename }));
                    if (typeof onSaved === 'function') onSaved();
                    return;
                }
                if (data.status === 'cancelled') { setMergeIdle(t('已取消拼接')); return; }
                setMergeIdle(tf("拼接失败：{err}", { err: data.error }));
                app.extensionManager.toast.add({ severity: 'error', summary: t('拼接失败'), detail: data.error, life: 8000 });
            };
            timer = setInterval(tick, 1000);
            tick();
        };
        mergeCancel.onclick = async () => {
            if (!mergeHandle) return;
            mergeLine.textContent = t('已请求取消…');
            await mergeHandle.cancel();
        };
        let handle = null;
        const setIdle = (text) => {
            handle = null;
            runBtn.disabled = false;
            runBtn.textContent = t('生成这一段');
            cancelBtn.style.display = 'none';
            if (text) statusEl.textContent = text;
        };
        const taskBody = () => {
            const widget = (n) => { const w = hostNode?.widgets?.find((x) => x.name === n); return w ? w.value : undefined; };
            const payload = {
                recipe: name,
                segment: index,
                anchors: anchorSel.value,
                seed: (seedSel.value === 'keep' && Number.isFinite(Number(widget('seed')))) ? Number(widget('seed')) : -1,
                node_id: hostNode?.id != null ? hostNode.id : undefined,
            };
            if (filmSel?.value && anchorSel.value !== 'none') payload.film = filmSel.value;   // 指定锚点来源；不选/不用锚点则不带
            if (hostNode) {
                payload.continuity = !!widget('continuity');
                const cf = Number(widget('context_frames'));
                if (Number.isFinite(cf)) payload.context_frames = cf;
            }
            return payload;
        };
        const onStatus = (data) => {
            runBtn.disabled = true;
            runBtn.textContent = t('生成中…');
            cancelBtn.style.display = '';
            const pct = (data.progress && data.progress.max > 0)
                ? ` ${Math.round((Number(data.progress.value) / Number(data.progress.max)) * 100)}%` : '';
            statusEl.textContent = data.status === 'running' ? tf("生成中…{pct}", { pct }) : t('排队中…');
        };
        const onDone = (data) => {
            if (data.status === 'succeeded') {
                const source = data.film ? tf("，锚点自 {film}", { film: data.film }) : '';
                app.extensionManager.toast.add({
                    severity: 'success', summary: t('该段已生成'),
                    detail: tf("第 {n} 段：{file}（seed {seed}{source}）", { n: data.segment + 1, file: data.filename, seed: data.seed, source }), life: 6000,
                });
                for (const warning of (data.warnings || [])) {
                    app.extensionManager.toast.add({ severity: 'warn', summary: t('生成提示'), detail: warning, life: 6000 });
                }
                setIdle(tf("已完成：{file}{src}，已记进配方「结果」区", { file: data.filename, src: data.film ? tf("（锚点自 {film}）", { film: data.film }) : '' }));
                hasClip = true;                       // 后续步骤：可以拼回成片了
                mergeBtn.disabled = false;
                mergeLine.textContent = t('已生成：可点「拼回成片」把这一段换进成片（其余段沿用原成片）');
                if (typeof onSaved === 'function') onSaved();
                return;
            }
            if (data.status === 'cancelled') { setIdle(t('已取消')); return; }
            const summary = data.submitFailed ? t('提交失败') : t('生成失败');
            app.extensionManager.toast.add({ severity: 'error', summary, detail: data.error || t('未知错误'), life: 8000 });
            setIdle(tf("{pre}失败：{err}", { pre: data.submitFailed ? t('提交') : '', err: data.error || t('未知错误') }));
        };
        runBtn.onclick = () => {
            runBtn.disabled = true;
            runBtn.textContent = t('提交中…');
            statusEl.textContent = t('正在提交到执行队列…');
            handle = runSegmentTask(taskBody(), { onStatus, onDone });
        };
        cancelBtn.onclick = async () => {
            if (!handle) return;
            cancelBtn.disabled = true;
            try {
                await handle.cancel();
                statusEl.textContent = t('已请求取消…');
            } finally {
                cancelBtn.disabled = false;
            }
        };
        row.appendChild(panel);
    }

    const segsWrap = $el('div', { className: 'neo-director-segs' });
    let timeline = null;
    let currentSegId = null; // 当前编辑段身份（dataset.segId，重排/删除后仍可追踪）
    let currentSegIdx = 0;   // 当前编辑段序号（首帧数据就绪后据此把该块滚入可视区）
    function renumberSegs() {
        const rows = segsWrap.querySelectorAll('.neo-director-seg');
        rows.forEach((row, i) => {
            row.querySelector('.neo-director-seg-title').textContent = tf("段 {n}", { n: i + 1 });
            // 尾帧仅最后一段可添加
            const lfRow = row.querySelector('.neo-director-lf-row');
            if (lfRow) lfRow.style.display = (i === rows.length - 1) ? '' : 'none';
        });
        refreshSegScale();   // 段数一变：单段才收起的控件 / 单段引导立刻跟着切
    }
    // 只显示当前段（其余段保留 DOM，readSegData/保存仍读取全部数据）；时间轴同步把该块滚进可视区
    function showSeg(i) {
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        if (!rows.length) return;
        i = Math.max(0, Math.min(i, rows.length - 1));
        currentSegId = rows[i].dataset.segId;
        currentSegIdx = i;
        rows.forEach((row, k) => row.classList.toggle('neo-director-seg-current', k === i));
        if (timeline) timeline.revealSeg(i);
    }
    function showSegById(id) {
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        const i = rows.findIndex(r => r.dataset.segId === id);
        if (i < 0) showSeg(0); else showSeg(i);
    }
    // 旧 v2v/rv2v 配方携带独立 source_video：并入该段参考视频首位（第一个参考视频即源视频）
    const normSegs = exSegs.map((s) => {
        if (!s || !s.source_video) return s;
        const vids = Array.isArray(s.refs && s.refs.videos) ? s.refs.videos.slice() : [];
        if (!vids.includes(s.source_video)) vids.unshift(s.source_video);
        const ns = { ...s, refs: { ...(s.refs || {}), videos: vids } };
        delete ns.source_video;
        return ns;
    });
    for (const s of (normSegs.length ? normSegs : [{}])) segsWrap.appendChild(buildSeg(s));
    renumberSegs();

    // 按有效模式过滤视频技能（skill.mode 由后端 frontmatter 提供）；无匹配时回退全量，避免空下拉。
    const FRAME_SKILL_MODES = ['t2v', 'i2v', 'l2v', 'fl2v'];   // 关键帧生视频（f2v）技能的模式值（全部进同一池，含多帧单次）
    // 池内按步数从少到多排（skill config 未写 steps 的按后端缺省 20 计），同分偏好 H3 连续多段合成 (VDN)；
    // 原生下拉与居中技能选择窗都按这个顺序显示，新建配方的默认技能就是池里第一个可用的（见 newDefaultSkill）。
    const SKILL_PREF = ['minimax_h3_vdn_multiframe', 'minimax_h3_multiframe'];
    const skillSteps = (s) => {
        const n = Number(s.gen_config && s.gen_config.steps);
        return Number.isFinite(n) && n > 0 ? n : 20;
    };
    const skillPrefRank = (s) => {
        const i = SKILL_PREF.indexOf(s.id);
        return i < 0 ? SKILL_PREF.length : i;
    };
    function skillOptionPool(eff) {
        const pool = eff === 'f2v'
            ? skills.filter(s => FRAME_SKILL_MODES.includes(s.mode))
            : skills.filter(s => s.mode === eff);
        return (pool.length ? pool : skills).slice()
            .sort((a, b) => skillSteps(a) - skillSteps(b) || skillPrefRank(a) - skillPrefRank(b));
    }

    /** 填充技能下拉（统一技能框与各段技能框共用）；keep 仍在新池里时保持选中，否则落回第一个选项。 */
    function fillSkillOptions(sel, eff, keep) {
        sel.innerHTML = '';
        const pool = skillOptionPool(eff);
        if (!pool.length) {
            sel.appendChild($el('option', { value: '', textContent: t('（无可用视频技能）') }));
            return;
        }
        for (const s of pool) {
            const opt = $el('option', { value: s.id, textContent: skillDisplayName(s) });
            opt.dataset.source = s.source || 'custom'; // 详情弹窗按 source 区分预设只读/自定义可编辑
            opt.__skillMeta = s; // 选择窗浮动预览卡取 gen_config / 分类等元数据
            sel.appendChild(opt);
        }
        if (keep && Array.from(sel.options).some(o => o.value === keep)) sel.value = keep;
    }

    function refreshSegSkillOptions(skillSel, eff) {
        if (skillSel) fillSkillOptions(skillSel, eff, skillSel.value);
    }

    /** 当前统一技能 id（非混合模式即各段技能；混合模式该框隐藏，其值仍作为新段默认）。 */
    const currentSkillId = () => (gSkillSel ? gSkillSel.value : '');

    /** 把统一技能写进各段下拉（段内下拉在非混合模式隐藏，但保存/执行仍读段内 skill_id）。 */
    function pushGlobalSkill() {
        const sid = currentSkillId();
        if (!sid) return;
        for (const row of segsWrap.querySelectorAll('.neo-director-seg')) {
            const sel = row.querySelector('.neo-director-skill');
            if (sel) sel.value = sid;
        }
    }

    // 按有效模式刷新各段：非混合模式下技能统一由 gSkillSel 决定（段内技能下拉隐藏）；
    // 混合模式下显示“本段模式”与段内技能下拉并逐段生效；
    // 首帧区（i2v/fl2v）、尾帧区（fl2v）、参考素材区（i2v/r2v）分别显隐。
    function applyGlobalMode() {
        if (!modeSel) return;
        const g = modeSel.value;   // 'f2v' | 'r2v' | 'mixed'
        const mixed = (g === 'mixed');
        // 统一技能框（紧邻生成模式）：非混合模式按全局模式过滤选项并显示；混合模式整体隐藏
        if (gSkillSel) fillSkillOptions(gSkillSel, g, gSkillSel.value);
        for (const el of [gSkillLabel, gSkillSel]) {
            if (el) el.style.display = mixed ? 'none' : '';
        }
        for (const row of segsWrap.querySelectorAll('.neo-director-seg')) {
            const segModeSel = row.querySelector('.neo-director-segmode');
            const modeRow = row.querySelector('.neo-director-segmode-row');
            const eff = (mixed && segModeSel) ? segModeSel.value : g;
            const skillSel = row.querySelector('.neo-director-skill');
            refreshSegSkillOptions(skillSel, eff);
            // 段内技能下拉只在混合模式显示；其余模式的技能由上方统一技能框决定
            const skillLabel = row.querySelector('.neo-director-skill-label');
            if (skillLabel) skillLabel.style.display = mixed ? '' : 'none';
            if (skillSel) skillSel.style.display = mixed ? '' : 'none';
            if (modeRow) modeRow.style.display = mixed ? '' : 'none';
            // 两栏帧行：f2v 显示左栏（首帧槽位 + 尾帧扩展）；r2v 隐藏帧槽位，左栏由参考素材区接管
            for (const el of row.querySelectorAll('.neo-director-frames-cols')) {
                el.classList.toggle('neo-director-frames-noframe', eff !== 'f2v');
            }
            // 左栏标签随有效模式：首帧 / 参考素材
            const firstLabel = row.querySelector('.neo-director-frames-labels > span');
            if (firstLabel) firstLabel.textContent = eff === 'f2v' ? t('首帧') : t('参考素材');
            const refsBlock = row.querySelector('.neo-director-refs-block');
            if (refsBlock) refsBlock.style.display = eff === 'r2v' ? '' : 'none';
        }
        if (!mixed) pushGlobalSkill();   // 统一技能落到各段（新增段 / 切模式后同样生效）
        refreshChunkMarkers?.();         // 有效模式变化 → 重算多帧单次分块标记
    }
    // 定位到指定段（节点时间轴上被点击的那一段）；未指定时仍默认显示第 1 段
    const focusSegAt = (i) => { const n = Number(i); if (Number.isFinite(n) && n >= 0) showSeg(n); };
    focusSegAt(focusSeg >= 0 ? focusSeg : 0);
    // 新增一段：追加后立即按当前全局模式初始化首帧区 / 本段模式显隐
    const appendNewSeg = () => {
        segsWrap.appendChild(buildSeg({}));
        renumberSegs();
        showSeg(segsWrap.children.length - 1);
        applyGlobalMode();
        markDirty();
    };
    const addBtn = $el('button', { className: 'rs-btn neo-director-add', textContent: t('＋ 添加段'), onclick: appendNewSeg });

    // 时间轴组件（复用 web/director-timeline.js）：按时长比例绘制分段块 + 秒尺，点击定位、拖拽重排。
    const tlWrap = $el('div', { className: 'neo-director-timeline' });
    const readSegData = () => Array.from(segsWrap.querySelectorAll('.neo-director-seg')).map(row => {
        const durInp = row.querySelector('.neo-director-dur');
        const promptTa = row.querySelector('.neo-director-prompt');
        const frames = segFrameReaders.get(row) || {};
        const ffName = frames.first ? frames.first() : '';
        const thumbUrl = ffName ? thumbSrc(ffName) : null;
        // 参考素材（r2v）：三组计数 + 全部参考图缩略（按顺序），供时间轴块平铺展示（增删改经 observer 自动刷新）
        const reads = segRefReaders.get(row) || [];
        const mat = { images: 0, videos: 0, audios: 0 };
        const matThumbs = [];
        reads.forEach((read, gi) => {
            const names = read ? read() : [];
            mat[SEG_REF_GROUPS[gi].key] = names.length;
            if (SEG_REF_GROUPS[gi].key === 'images') {
                for (const n of names) matThumbs.push(thumbSrc(n));
            }
        });
        return { duration: Number(durInp.value) || 0, prompt: (promptTa.value || '').trim(), thumbUrl, mat, matThumbs };
    });
    const onSelectSeg = (i) => {
        const row = Array.from(segsWrap.querySelectorAll('.neo-director-seg'))[i];
        if (!row) return;
        showSeg(i);
        const p = row.querySelector('.neo-director-prompt');
        if (p) p.focus();
    };
    const onReorderSegs = (order) => {
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        for (const idx of order) { const el = rows[idx]; if (el) segsWrap.appendChild(el); }
        renumberSegs();
        markDirty();
    };
    // 拖块右缘调时长：写回该段时长输入框（组件内已吸附 0.5s、最小 1s）
    const onResizeSeg = (i, durSec) => {
        const row = Array.from(segsWrap.querySelectorAll('.neo-director-seg'))[i];
        if (!row) return;
        const inp = row.querySelector('.neo-director-dur');
        if (inp) { inp.value = String(Math.min(3600, Math.max(1, Number(durSec) || 1))); markDirty(); }
    };
    try {
        timeline = new DirectorTimeline(tlWrap, {
            height: 184,
            getSegments: readSegData,
            onSelect: onSelectSeg,
            onReorder: onReorderSegs,
            onResize: onResizeSeg,
            // 时间轴尾部「＋」：直接追加新段（等价于下方「＋ 添加段」按钮）
            onAdd: appendNewSeg,
            // 素材库图片直接拖到某段的时间轴块：落地到 input/ 设为该段首帧
            onDropImage: async (i, dt) => {
                const row = Array.from(segsWrap.querySelectorAll('.neo-director-seg'))[i];
                const setters = segFrameSetters.get(row);
                if (!row || !setters) return;
                const fname = await copyGalleryToInput(grabDataType(dt));
                if (!fname) return;
                showSeg(i); // 先切到该段，再设首帧
                setters.first(fname);
            },
        });
    } catch (e) { console.error('[Neo Recipes] Director: timeline init failed', e); }
    // 首次定位（如节点上点的那一段）延后一帧：组件首帧数据就绪后 showSeg 才能算出块坐标并滚动
    requestAnimationFrame(() => showSeg(currentSegIdx));
    const tlObserver = new MutationObserver(() => { if (timeline) timeline.refresh(); refreshChunkMarkers?.(); refreshStepState(); });
    tlObserver.observe(segsWrap, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    segsWrap.addEventListener('input', (e) => {
        if (timeline && (e.target.classList.contains('neo-director-dur') || e.target.classList.contains('neo-director-prompt'))) timeline.refresh();
    });

    // 配方名称：钉在标题栏中间，默认以文本直接显示，点击进入行内编辑
    // （Enter / 失焦提交，Esc 还原为打开时的名称）
    const nameInp = $el('input', { className: 'neo-director-name', type: 'text', placeholder: t('配方名称'), value: (existing && existing.name) || '' });
    _nameEl = nameInp;   // 供 currentRecipeName() 读取当前配方名（缩略图/尺寸查询与落盘同名）
    const nameView = $el('span', { className: 'neo-director-name-view', title: t('点击编辑配方名称') });
    const nameWrap = $el('div', { className: 'neo-director-name-wrap' }, [nameView, nameInp]);
    const renderName = () => {
        const v = nameInp.value.trim();
        nameView.textContent = v || t('未命名配方');
        nameView.classList.toggle('neo-director-name-empty', !v);
    };
    const stopNameEdit = () => {
        nameWrap.classList.remove('neo-director-name-editing');
        renderName();
    };
    renderName();
    nameView.onclick = () => {
        nameWrap.classList.add('neo-director-name-editing');
        nameInp.focus();
        nameInp.select();
        nameInp.scrollLeft = 0;    // 全选后回到开头，长名称不至于只显示尾部
    };
    nameInp.addEventListener('blur', stopNameEdit);
    nameInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); stopNameEdit(); }
        else if (e.key === 'Escape') { e.preventDefault(); nameInp.value = requestedName; stopNameEdit(); }
    });
    // 分辨率：宽高比 + 百万像素 → W/H（32 对齐）；「自定义」手输 W/H。不再保存 seed（后端默认 0，节点输入可覆盖）
    const initRes = (() => {
        const w = Number(exShared.width) || 1344, h = Number(exShared.height) || 768;
        if (exShared.aspect_ratio && DIRECTOR_ASPECTS.some(([l]) => l === exShared.aspect_ratio)) {
            return { label: exShared.aspect_ratio, mp: directorClampMp(exShared.megapixels != null ? exShared.megapixels : MP_DEFAULT), cw: w, ch: h };
        }
        if (exShared.width != null && exShared.height != null) {
            const inf = directorInferAspect(w, h);
            return { label: inf.label, mp: inf.mp, cw: w, ch: h };
        }
        return { label: '16:9 (宽屏)', mp: MP_DEFAULT, cw: 0, ch: 0 };
    })();
    const aspectSel = $el('select', { className: 'neo-director-aspect' });
    for (const [label] of DIRECTOR_ASPECTS) aspectSel.appendChild($el('option', { value: label, textContent: t(label) }));
    aspectSel.appendChild($el('option', { value: DIRECTOR_CUSTOM, textContent: t(DIRECTOR_CUSTOM) + " " + t('（手输 W/H）') }));
    aspectSel.value = initRes.label;
    const mpInp = $el('input', { className: 'neo-director-num neo-director-mp', type: 'number', min: MP_MIN, max: MP_MAX, step: 0.1, value: initRes.mp });
    const cwInp = $el('input', { className: 'neo-director-num', type: 'number', min: 16, placeholder: t('宽'), value: initRes.cw || '' });
    const chInp = $el('input', { className: 'neo-director-num', type: 'number', min: 16, placeholder: t('高'), value: initRes.ch || '' });
    const resOut = $el('span', { className: 'neo-director-res' });
    const customRow = $el('div', { className: 'neo-director-row neo-director-shared' }, [
        $el('label', { textContent: t('宽') }), cwInp,
        $el('label', { textContent: t('高') }), chInp,
    ]);

    const updateRes = () => {
        const custom = aspectSel.value === DIRECTOR_CUSTOM;
        customRow.style.display = custom ? '' : 'none';
        if (custom) { resOut.textContent = ''; return; }
        const r = directorResolution(aspectSel.value, mpInp.value);
        if (r) resOut.textContent = `${r.width}×${r.height}`;
    };
    let resUserTouched = false;   // 手动改过分辨率后不再被自动推断覆盖（新建配方的异步尺寸查询可能晚到）
    aspectSel.onchange = () => { resUserTouched = true; updateRes(); };
    mpInp.addEventListener('input', () => { resUserTouched = true; updateRes(); });
    updateRes();

    // 把「宽高比」切到某张首帧图最接近的预设比例：只动比例下拉，百万像素与手输 W/H 都不碰
    //（不改像素）。新建配方首帧预填 / 宫格拆分后调用——各段同比例，避免忘记改而拉伸。
    const applyAspectFromImage = (w, h) => {
        if (!w || !h) return;
        aspectSel.value = directorNearestAspect(w, h);
        updateRes();
    };

    // 新建配方（未命名）：首帧已预填（图库多选新建）或画布连了 LoadImage 时，宽高比默认吸附到
    // 首帧图最接近的预设比例；百万像素仍是默认 0.5、已有配方的落盘分辨率不动。
    // 尺寸查询异步到达，用户手动改过则不再覆盖。
    if (!requestedName) {
        const ff = (exSegs[0] && exSegs[0].first_frame) || (imageRefs[0] && imageRefs[0].filename);
        if (ff) {
            fetch("/rs_recipes/image_sizes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filenames: [ff] }) })
                .then(r => r.json())
                .then(d => {
                    const s = (d && d.success && Array.isArray(d.sizes) && d.sizes[0]) || null;
                    if (s && s.width && s.height && !resUserTouched) applyAspectFromImage(s.width, s.height);
                })
                .catch(() => {});
        }
    }

    let overlay;
    const close = () => {   // 无条件关闭（保存成功 / 「放弃修改」后走这里）：清脏态并隐藏确认条
        dirty = false;
        dirtyConfirm.hidden = true;
        if (timeline) { try { timeline.destroy(); } catch (_) {} timeline = null; }
        if (overlay && overlay.parentNode) overlay.remove();
        if (_directorEditor && _directorEditor.close === close) _directorEditor = null;
        const pend = _pendingDirectorSwitch;   // 挡下的切换在关闭这一刻落地：确认条里「放弃修改」/「保存并关闭」后直接打开要点的那份配方
        if (pend && !_directorEditor) { _pendingDirectorSwitch = null; openDirectorEditor(pend.existing, pend.onSaved, pend.focusSeg, pend.opts); }
    };
    // 用户主动关闭（✕ / 取消）：有未保存修改时先出确认条暂停关闭，等用户在确认条里选择
    const requestClose = () => {
        if (!dirty) { close(); return; }
        dirtyConfirm.hidden = false;
    };
    const saveBtn = $el('button', { className: 'rs-btn neo-director-save', textContent: t('保存') });
    const cancelBtn = $el('button', { className: 'rs-btn neo-director-cancel', textContent: t('取消'), onclick: requestClose });
    let runAfterSave = false;   // 「保存并生成整片」置位：本次保存成功后交给宿主提交生成
    let closeAfterSave = false; // 确认条「保存并关闭」置位：关闭请求撞上未保存修改时，保存成功后才关
    // 未保存修改确认条（同自动增强菜单 rs-gen-dirty-confirm 模式）：「保存并关闭」复用完整保存路径，失败则留在窗口内重试
    const dirtyConfirm = $el('div', { className: 'neo-director-dirty-confirm' }, [
        $el('span', { className: 'neo-director-dirty-text', textContent: t('有未保存的修改') }),
        $el('button', { className: 'rs-btn neo-director-dirty-save', type: 'button', textContent: t('保存并关闭'), onclick: () => { closeAfterSave = true; saveBtn.onclick(); } }),
        $el('button', { className: 'rs-btn neo-director-dirty-discard', type: 'button', textContent: t('放弃修改'), onclick: close }),
        $el('button', { className: 'rs-btn neo-director-dirty-keep', type: 'button', textContent: t('继续编辑'), onclick: () => { dirtyConfirm.hidden = true; _pendingDirectorSwitch = null; } }),   // 「继续编辑」= 取消这次切换
    ]);
    dirtyConfirm.hidden = true;

    saveBtn.onclick = async () => {
        const closeWhenSaved = closeAfterSave;   // 只认这一次点击：保存失败不该把关闭请求留到下一次保存
        closeAfterSave = false;
        const name = nameInp.value.trim();
        if (!name) { app.extensionManager.toast.add({ severity: 'error', summary: t('多段导演'), detail: t('请填写配方名称'), life: 4000 }); return; }
        const gMode = modeSel.value;   // 'f2v' | 'r2v' | 'mixed'
        const segments = [];
        const warnings = [];   // 内容不完整只提示、不阻止保存（允许先存草稿再补素材）
        let segNo = 0;
        for (const row of Array.from(segsWrap.querySelectorAll('.neo-director-seg'))) {
            segNo += 1;
            // 非混合模式：技能取顶部的统一技能框（段内下拉隐藏、值同源，此处兜底归一）
            const skill_id = (gMode === 'mixed')
                ? row.querySelector('.neo-director-skill').value
                : (currentSkillId() || row.querySelector('.neo-director-skill').value);
            const prompt = row.querySelector('.neo-director-prompt').value.trim();
            if (!skill_id || !prompt) warnings.push(tf("第 {n} 段未选择技能或未填提示词", { n: segNo }));
            const eff = (gMode === 'mixed') ? row.querySelector('.neo-director-segmode').value : gMode;
            const frames = segFrameReaders.get(row) || {};
            const first = frames.first ? frames.first() : '';
            const last = frames.last ? frames.last() : '';
            const seg = {
                skill_id, prompt,
                duration_sec: Number(row.querySelector('.neo-director-dur').value) || null,
            };
            if (gMode === 'mixed') seg.mode = eff;
            const readers = segRefReaders.get(row) || [];
            const refs = {};
            readers.forEach((read, gi) => {
                const picked = read();
                if (picked.length) refs[SEG_REF_GROUPS[gi].key] = picked;
            });
            if (Object.keys(refs).length) seg.refs = refs;
            // 首帧/尾帧：有值即落盘（与模式解耦——宫格拆分、分镜回填等均可在任意模式下写入）
            if (first) seg.first_frame = first;
            if (last) seg.last_frame = last;
            // 分镜图：记录配方 assets/ 里的关键帧名与提示词快照（文件已在 assets，保存不再重复拷贝）
            const sb = row.dataset.storyboard || '';
            if (sb) {
                seg.storyboard = sb;
                if (row.dataset.storyboardPrompt) seg.storyboard_prompt = row.dataset.storyboardPrompt;
            }
            // 各模式的内容完整性：只提示、不阻止保存（允许先存草稿再补素材）；f2v 首/尾帧均可选，无警告
            if (eff === 'r2v' && !seg.refs) {
                warnings.push(tf("第 {n} 段（全参考生视频）缺参考素材（图 / 视频 / 音频）", { n: segNo }));
            }
            segments.push(seg);
        }
        if (!segments.length) { app.extensionManager.toast.add({ severity: 'error', summary: t('多段导演'), detail: t('至少需要一个段'), life: 4000 }); return; }
        // 首帧比例一致性：多段首帧来自不同来源时可能比例不一，共享分辨率只能取一个 → 保存前非阻塞提示拉伸风险
        const ffNames = [...new Set(segments.map((s) => s.first_frame).filter(Boolean))];
        if (ffNames.length >= 2) {
            try {
                const szRes = await fetch("/rs_recipes/image_sizes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filenames: ffNames, recipe: currentRecipeName() }) });
                const szData = await szRes.json();
                if (szData && szData.success) {
                    const aspectMsg = firstFrameAspectWarning(segments, szData.sizes);
                    if (aspectMsg) warnings.push(aspectMsg);
                }
            } catch (_) { /* 尺寸读取失败不阻止保存 */ }
        }
        if (warnings.length) {
            app.extensionManager.toast.add({ severity: 'warning', summary: t('多段导演'), detail: tf("有 {n} 段待完善（不阻止保存）：{list}", { n: warnings.length, list: warnings.join('；') }), life: 6000 });
        }
        // 参考素材（图/视频/音频）都需进配方 assets 才能在 load_director_spec 里解析成 input 相对名
        const assets = imageRefs.slice();
        const assetNames = new Set(assets.map(r => r.filename));
        // 首/尾帧：预填帧（图库多选新建、素材拖到时间轴块等）不在 imageRefs 也不在配方 assets → 一并登记，后端落盘后回写最终名
        for (const seg of segments) {
            for (const fname of [seg.first_frame, seg.last_frame]) {
                if (!fname || assetNames.has(fname) || recipeAssetFiles.has(fname)) continue;
                assetNames.add(fname);
                assets.push({ filename: fname, subfolder: '', type: 'input', kind: 'image' });
            }
        }
        for (const seg of segments) {
            for (const [key, kind] of [['images', 'image'], ['videos', 'video'], ['audios', 'audio']]) {
                for (const name of ((seg.refs || {})[key] || [])) {
                    if (assetNames.has(name)) continue;
                    assetNames.add(name);
                    assets.push({ filename: name, subfolder: '', type: 'input', kind });
                }
            }
        }
        // 角色参考图同样要落 assets：重开配方时，各段身份参考要从配方 assets 里读回这些图
        for (const name of charRefRow.getSelected()) {
            if (assetNames.has(name)) continue;
            assetNames.add(name);
            assets.push({ filename: name, subfolder: '', type: 'input', kind: 'image' });
        }
        const custom = aspectSel.value === DIRECTOR_CUSTOM;
        let outW, outH;
        if (custom) {
            outW = Number(cwInp.value) || 1344;
            outH = Number(chInp.value) || 768;
        } else {
            const r = directorResolution(aspectSel.value, mpInp.value);
            outW = r.width; outH = r.height;
        }
        // 统一设置区：各段原文快照随配方落盘，重新打开时作为重新生成的基线；全空不写
        const setupPayload = {};
        if (origPrompts) setupPayload.orig_prompts = origPrompts;   // 各段原文快照：重开后逐格生成仍基于原文再试
        saveBtn.disabled = true;
        try {
            const result = await saveRecipe(name, '', assets, [], [], {
                shared: Object.assign(
                    custom
                        ? { width: outW, height: outH, aspect_ratio: DIRECTOR_CUSTOM }
                        : { width: outW, height: outH, aspect_ratio: aspectSel.value, megapixels: directorClampMp(mpInp.value) },
                    { mode: gMode },
                    // 多帧单次分块秒数：0 = 关闭（纯逐段生成）；显式落盘，重开回显
                    { chunk_sec: Math.max(0, Math.round(Number(chunkSecInp.value) || 0)) },
                    // 整片运行参数：Studio 生成面板只发配方名 + 勾选段，整片怎么跑读的就是这几个值。
                    // 种子留空 = -1（每次运行随机换种子）；步数留空 = -1（各段技能 config 的步数）
                    {
                        seed: seedSharedInp.value === '' ? -1 : Math.max(-1, Number(seedSharedInp.value)),
                        steps: stepsSharedInp.value === '' ? -1 : Math.min(100, Math.max(-1, Number(stepsSharedInp.value))),
                        continuity: continuitySharedChk.checked,
                        context_frames: ctxSharedInp.value === '' ? 22 : Math.min(362, Math.max(0, Number(ctxSharedInp.value))),
                    },
                    // 身份参考默认开：只有关掉时才落盘（重开时由该键回显开关）
                    identityRefsChk.checked ? {} : { identity_refs: false },
                ),
                segments,
                // 故事板页设置（全局故事参考 + 角色参考图）：随配方落盘，重新打开编辑器回显。
                // 主题 / 脚本 → 分段这条文字故事板路径归右栏智能体（director_plan），编辑器不再落它的输入。
                // 空内容由后端判空后不写入，前端无需分支。
                story: Object.assign({
                    grid_prompts: gridPromptsTa.value.trim() || null,   // 全局故事参考：默认原宫格提示词，可手动改写
                }, storyRefsPayload()),
                setup: Object.keys(setupPayload).length ? setupPayload : null,
            }, "video");
            if (result.success) {
                app.extensionManager.toast.add({ severity: 'success', summary: t('多段导演已保存'), detail: tf("{name}（{n} 段）", { name, n: segments.length }), life: 4000 });
                // 内嵌保存后编辑器留在原地：桌面端导演页上半栏就是它，保存即关等于把刚编辑的界面抽走。
                // 关闭只由 ✕ / 取消 / 「保存并关闭」触发；切到别的配方由单例重载路径关掉。
                if (embedded && !closeWhenSaved) {
                    dirty = false;
                    dirtyConfirm.hidden = true;
                    if (_directorEditor && _directorEditor.close === close) _directorEditor.name = name;   // 新建配方落名：再点同一张卡只切段，不重载
                } else {
                    close();
                }
                // 广播配方已落盘：节点内时间轴据此刷新下拉 + 重载 spec。created=true 表示新建，供节点自动选中刚保存的配方。
                window.dispatchEvent(new CustomEvent(DIRECTOR_RECIPE_SAVED_EVENT, { detail: { name, created: !existing } }));
                if (typeof onSaved === 'function') onSaved();
                if (runAfterSave) { runAfterSave = false; saveAndRun(); }
            } else {
                app.extensionManager.toast.add({ severity: 'error', summary: t('保存失败'), detail: result.error || 'Unknown error', life: 5000 });
            }
        } catch (e) {
            console.error('[Neo Recipes] Director save failed:', e);
            app.extensionManager.toast.add({ severity: 'error', summary: t('保存失败'), detail: e.message, life: 5000 });
        } finally {
            saveBtn.disabled = false;
        }
    };

    // 配方名自动提取：关键动作完成后，若名称为空则用 LAYA→规则→LLM 提取（非阻塞）
    const autoFillName = (sourceText) => {
        if (nameInp.value.trim() || nameManuallySet) return;
        const text = (sourceText || '').trim();
        if (!text) return;
        fetch('/rs_prompts/extract_title', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
            .then(r => r.json())
            .then(d => { if (d.title && !nameInp.value.trim() && !nameManuallySet) { nameInp.value = d.title; renderName(); } })
            .catch(() => {});
    };

    // ==========================================
    // 故事板分镜：宫格图拆分到各段（按主题 / 脚本生成分段的文字故事板由右栏智能体承接）
    // ==========================================

    // 本页两步（体现先后关系）：① 宫格图拆分到各段 → ② 逐格生成提示词。
    // 每步标题行带一个序号徽标：= 已完成、序号高亮 = 轮到这一步、序号变淡 = 前置还没满足。
    // 徽标状态与各步动作按钮的置灰都在 refreshStepState() 里按当前内容统一算。
    const buildStepBadge = (label) => $el('span', { className: 'neo-director-step-badge', textContent: label });
    const stepGridBadge = buildStepBadge('①');
    const stepOptBadge = buildStepBadge('②');
    let stepUiReady = false;   // 本页构建完成前（初始化期的 setGridSrc 等早期调用）直接跳过
    let gridSplitBusy = false, optBusy = false;   // 各步动作执行中：保持置灰

    /** 对照表第一列缩略：点击经 Lightbox 看大图（onOpen）；传 onClear 时右上角悬停出现 ✕（清除该段分镜图记录）。 */
    function fillSegThumb(thumb, fname, onClear, onOpen, clearTitle) {
        if (!thumb || !fname) return;
        Array.from(thumb.children).forEach((c) => { if (c.tagName !== 'INPUT') c.remove(); });   // 保留槽位内挂的隐藏 file input
        const url = thumbSrc(fname);   // 配方资产走 /rs_recipes/asset；宫格格子等 input/ 文件走 /view
        const a = $el('a', { href: url, target: '_blank', rel: 'noopener', title: t('点击查看大图（←/→ 切换各段）') });
        if (onOpen) a.addEventListener('click', (e) => { e.preventDefault(); onOpen(); });
        a.appendChild($el('img', { src: url, alt: fname, loading: 'lazy' }));
        thumb.appendChild(a);
        if (onClear) thumb.appendChild($el('button', { className: 'neo-director-setup-seg-sb-clear', type: 'button', title: clearTitle || t('清除该段分镜图（若首帧正是此图则一并清除）'), textContent: '✕', onclick: (e) => { e.stopPropagation(); onClear(); } }));
    }
    // 新建配方：手动命名后不再被自动提取覆盖；编辑已有配方不同步
    let nameManuallySet = false;
    nameInp.addEventListener('input', () => { nameManuallySet = true; refreshStepState(); });   // 配方名影响宫格产物落盘名
    // 新建配方：直接在时间轴输入段提示词时，若尚未手动命名则同样截取生成标题（与「主题/想法」一致）；
    // 先剥掉 H3 结构前缀（首行对齐指令 / 字段头 / [Shot N] / 时间戳），固定语句不当作配方名
    const stripH3Head = (v) => {
        let s = v.trim();
        s = s.replace(/^(?:For the target video, at \d+\.\d+ seconds into the target video|对于目标视频，在目标视频第 \d+\.\d+ 秒处|How the reference pictures align with the target video|参考图与目标视频的对齐方式)[^\n]*/, '').trim();
        s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*:\s*/, '').trim();
        s = s.replace(/^\[Shot \d+\]\s*/i, '');
        return s.replace(/^\d{2}:\d{2,3}(?:\.\d{1,3})?(?:\s*[-–—~]\s*\d{2}:\d{2,3}(?:\.\d{1,3})?)?\s*/, '').trim();
    };
    segsWrap.addEventListener('input', (e) => {
        if (!e.target.classList.contains('neo-director-prompt')) return;
        if (existing || nameManuallySet) return;
        const v = stripH3Head(e.target.value);
        if (!v) return;
        nameInp.value = v.length > 20 ? v.slice(0, 20) + '…' : v;
        renderName();
    });
    // 段提示词改动（手输 / LLM 写回）→ 重算步骤标记：②/③/④ 的可用性随之变化；同步常驻空段显隐
    segsWrap.addEventListener('input', (e) => {
        if (e.target.classList.contains('neo-director-prompt')) { refreshStepState(); syncGhostSeg(); }
    });

    // 角色参考图（配方级，常驻显示）：主用途是视频各段身份参考（「角色身份参考」开启时）。
    // 复用每段参考网格（本地上传 / 素材库拖入 / 拖拽排序）；顺序即参考先后（第 1 张为编辑目标）。
    // 默认收起（无已有角色图时），点标题展开再添加；添加角色图 / 打开素材库时自动展开。
    let charCard;
    const charChevron = $el('span', { className: 'neo-director-char-caret', textContent: '▸' });
    const setCharOpen = (open) => {
        charCard.classList.toggle('neo-director-setup-char-collapsed', !open);
        charChevron.textContent = open ? '▾' : '▸';
    };
    const charInitial = (exStory.characters || []).map(r => r.filename).filter(Boolean);
    const charRefRow = buildSegRefRow(
        { key: 'characters', kind: 'image', label: t('角色参考图'), max: 6, hideHead: true },
        charInitial,
        null,
        () => {   // 添加角色图自动展开；「+」宫格按钮（要角色图才画得出一致的宫格）随可用性联动
            if (charRefRow.getSelected().length) setCharOpen(true);
            gridSbBtn.disabled = !charRefRow.getSelected().length;
        },
        (names, idx) => Lightbox.open({ items: names.map(n => ({ kind: 'image', url: thumbSrc(n), title: n })), index: idx }),   // 点缩略图经 Lightbox 看大图（←/→ 切换各张）
        64   // 角色参考图紧凑瓷砖：空态同步缩小（见 recipes.css），不压低来源卡 / 各段对照
    );
    // 身份参考开关（默认开）：配方「角色参考图」是否作为视频各段身份参考——关掉就能与旧行为对比。
    // 集成在角色参考图盒的标题行内（标题 flex:1 把它与素材库按钮一起推到右侧）。
    const identityRefsChk = $el('input', { className: 'neo-director-identity-refs', type: 'checkbox' });
    identityRefsChk.checked = exShared.identity_refs !== false;
    identityRefsChk.addEventListener('change', () => markDirty());
    const identityRefsRow = $el('div', { className: 'neo-director-row neo-director-shared' }, [
        $el('label', { className: 'neo-director-field-label', textContent: t('角色身份参考') }),
        $el('label', {
            className: 'neo-director-seglen-wrap',
            title: t('把「角色参考图」作为各段身份参考（关键帧是背影 / 局部特写、看不到脸时靠它保住角色身份）；需「连续性」开启。关掉便于做前后对比测试'),
        }, [identityRefsChk, $el('span', { textContent: t('启用') })]),
    ]);
    const charTitle = $el('span', { className: 'neo-director-field-label neo-director-char-title', title: t('作为视频各段身份参考（「连续性」与「角色身份参考」开启时生效）：关键帧是背影 / 局部特写、看不到脸时靠它保住角色身份。最多取前 4 张作身份参考。点击展开 / 收起') }, [
        charChevron,
        $el('span', { textContent: t('角色参考图') }),
    ]);
    charTitle.addEventListener('click', () => setCharOpen(charCard.classList.contains('neo-director-setup-char-collapsed')));
    const charLibBtn = buildAssetLibButton('CharacterSheet', async (imgs) => {
        setCharOpen(true);
        for (const im of imgs) {
            const fname = await galleryPickFname(im);
            if (fname) charRefRow.insert(fname);
        }
    });
    charLibBtn.addEventListener('click', () => setCharOpen(true));   // 素材库的图要拖进网格：先展开
    charCard = $el('div', { className: 'neo-director-setup-char' }, [
        $el('div', { className: 'neo-director-refs-head' }, [charTitle, identityRefsRow, charLibBtn]),
        $el('div', { className: 'neo-director-story-refs' }, [charRefRow.row]),
    ]);
    setCharOpen(charInitial.length > 0);   // 已有角色图时默认展开，便于直接管理

    // ---- 宫格分镜图拆分：一张宫格分镜图自动切分（均匀间隙检测 / 手动行列）→ 替换分段，各格作该段首帧与分镜图 ----
    // 「全局故事参考（默认为原宫格提示词）」：默认是从原宫格图内嵌的 ComfyUI 元信息（PNG 里的 API 格式 prompt）自动提取到的提示词，
    // 可手动改写；逐格 LLM 描述时作为全片故事上下文传给后端。各格缩略图不再重复列（各段分镜图已在下方「各段对照」逐格显示）。
    // 先声明：setGridSrc 换图 / 清除时要把上一张图提取到的提示词作废并一起清掉。
    let gridPanelShape = null; // {rows, cols}：拆分成功后记录，供逐格描述标注本格在九宫格中的位置
    const gridPromptsTa = $el('textarea', {
        className: 'neo-director-grid-prompts',
        placeholder: t('拆分后显示原宫格图元信息里的提示词（可手动改写为全局故事参考）'),
    });
    const gridPromptCopy = $el('button', { className: 'neo-director-grid-pt-copy', type: 'button', title: t('复制提示词') }, [icon('copy')]);
    gridPromptCopy.onclick = () => {
        const text = gridPromptsTa.value;
        if (!text) return;
        // 钮面只有图标，复制结果只能靠图标自己说（对勾 / 叉），1 秒后回到静止图标
        const feedback = (ok) => {
            gridPromptCopy.replaceChildren(icon(ok ? 'check' : 'cross'));
            setTimeout(() => { gridPromptCopy.replaceChildren(icon('copy')); }, 1000);
        };
        // 优先异步 Clipboard API；不可用（非安全上下文）回落 execCommand
        if (typeof navigator.clipboard?.writeText === 'function') {
            navigator.clipboard.writeText(text).then(() => feedback(true), () => feedback(false));
            return;
        }
        gridPromptsTa.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { /* 环境不支持按失败处理 */ }
        feedback(ok);
    };
    function setGridPrompts(prompts) {
        const list = (prompts || []).map((t) => String(t || '').trim()).filter(Boolean);
        gridPromptsTa.value = list.join('\n\n');   // 默认原宫格提示词；用户可手动改写为全局故事参考
        gridPromptsTa.placeholder = gridSrcFile ? t('原宫格图元信息里没有提示词（可手写全局故事参考）') : t('拆分后显示原宫格图元信息里的提示词（可手动改写为全局故事参考）');
    }

    // 图片输入区：更大的拖放区——点击=本地上传，支持素材库（Neo Gallery）/ 本地文件拖入
    const gridSrcDrop = $el('div', { className: 'neo-director-grid-src' });
    const gridSrcBody = $el('div', { className: 'neo-director-grid-src-body' });
    gridSrcDrop.appendChild(gridSrcBody);
    let gridSrcFile = '';
    function setGridSrc(fname) {
        gridSrcFile = fname || '';
        gridSrcDrop.classList.toggle('has-src', !!gridSrcFile);   // 有图：右下角操作条 hover 才显示
        setGridPrompts([]);   // 换图 / 清除：上一张宫格图提取到的提示词作废
        gridPanelShape = null;   // 行列随源图失效（需重新拆分才恢复）
        gridSrcBody.innerHTML = '';
        if (gridSrcFile) {
            const img = $el('img', { src: thumbSrc(gridSrcFile), alt: gridSrcFile, title: gridSrcFile });
            img.onclick = (e) => { e.stopPropagation(); Lightbox.open({ items: [{ kind: 'image', url: thumbSrc(gridSrcFile), title: gridSrcFile }] }); };
            const clearBtn = $el('button', { className: 'neo-director-grid-src-clear', type: 'button', title: t('清除（重新选择）'), textContent: '✕' });
            clearBtn.onclick = (e) => { e.stopPropagation(); setGridSrc(''); markDirty(); };
            gridSrcBody.appendChild(img);
            gridSrcBody.appendChild(clearBtn);
        } else {
            gridSrcBody.appendChild($el('span', { className: 'neo-director-grid-src-hint', textContent: t('点击上传 / 拖入宫格图') }));
        }
        refreshStepState();   // 换图 / 清除 → ①/② 徽标与「拆分到各段」可用性
    }
    setGridSrc('');
    // 全局故事参考回显：编辑旧配方时恢复上次保存的文本（setGridSrc('') 已清空 textarea）
    if (exStory.grid_prompts) gridPromptsTa.value = exStory.grid_prompts;
    // 本地上传：隐藏 file input 挂在输入区（不随 innerHTML 重绘清除）；空区点击弹出文件选择器
    const gridSrcPicker = buildLocalFilePicker('image/*', (fname) => { setGridSrc(fname); markDirty(); });
    gridSrcDrop.appendChild(gridSrcPicker.input);
    const gridSbBtn = $el('button', { className: 'neo-director-storyboard-btn', title: t('基于角色图生成九宫格分镜图'), textContent: '+' });
    gridSbBtn.disabled = !charRefRow.getSelected().length;   // 无角色参考图时禁用（有图才可点）
    gridSbBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = charRefRow.getSelected();
        openStoryboardDialog(app.neoGallery, { filename: c[0], name: c[0] }, '');
    });
    // 输入区右下角操作条：「宫格素材库」在前、「+」（基于角色图生成九宫格）在后
    const gridSrcActions = $el('div', { className: 'neo-director-grid-src-actions' }, [
        buildAssetLibButton('StoryBoard', async (imgs) => {
            const im = imgs[0];
            if (!im) return;
            const fname = await galleryPickFname(im);
            if (fname) { setGridSrc(fname); markDirty(); }
        }),
        gridSbBtn,
    ]);
    gridSrcActions.addEventListener('click', (e) => e.stopPropagation());   // 操作条内点击不触发输入区「本地上传」
    gridSrcDrop.appendChild(gridSrcActions);
    gridSrcDrop.onclick = (e) => { if (!gridSrcFile && e.target !== gridSrcPicker.input) gridSrcPicker.open(); };   // 已选图时点缩略图看大图、✕ 清除
    // 拖入：OS 本地图片 / 素材库（Neo Gallery）
    gridSrcDrop.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; gridSrcDrop.classList.add('neo-director-drop'); });
    gridSrcDrop.addEventListener('dragleave', (e) => { if (!gridSrcDrop.contains(e.relatedTarget)) gridSrcDrop.classList.remove('neo-director-drop'); });
    gridSrcDrop.addEventListener('drop', async (e) => {
        e.preventDefault();
        gridSrcDrop.classList.remove('neo-director-drop');
        const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
        if (files.length) {
            const [fname] = await uploadLocalFiles(files);
            if (fname) { setGridSrc(fname); markDirty(); }
            return;
        }
        const fname = await copyGalleryToInput(grabDataType(e));
        if (fname) { setGridSrc(fname); markDirty(); }
    });
    const gridModeSel = $el('select', { className: 'neo-director-grid-mode' });
    for (const [val, label] of [['auto', t('自动检测')], ['manual', t('手动行列')]]) {
        gridModeSel.appendChild($el('option', { value: val, textContent: label }));
    }
    const gridRowsInp = $el('input', { className: 'neo-director-grid-n', type: 'number', min: 1, max: 12, value: 2 });
    const gridColsInp = $el('input', { className: 'neo-director-grid-n', type: 'number', min: 1, max: 12, value: 3 });
    const manualCtrls = $el('div', { className: 'neo-director-grid-manual' }, [
        $el('span', { textContent: t('行') }), gridRowsInp, $el('span', { textContent: '×' }), gridColsInp,
    ]);
    manualCtrls.style.display = 'none';   // 默认自动检测；切「手动行列」才显示
    gridModeSel.addEventListener('change', () => { manualCtrls.style.display = (gridModeSel.value === 'manual') ? 'flex' : 'none'; });
    const gridSplitBtn = $el('button', { className: 'rs-btn neo-director-grid-split', type: 'button', textContent: t('✂拆分到各段') });
    const gridStatus = $el('span', { className: 'neo-director-grid-status' });

    function assignGridPanels(panels) {
        const fnames = panels.map(p => p.filename);
        const defaultSkill = currentSkillId() || (skills.length ? skills[0].id : '');
        segsWrap.innerHTML = '';
        for (const fname of fnames) {
            if (!imageRefs.some(r => r.filename === fname)) imageRefs.push({ filename: fname, subfolder: '', type: 'input', kind: 'image' });   // 保存时随 assets 落盘
            const row = buildSeg({ skill_id: defaultSkill, prompt: '', duration_sec: 5, mode: 'f2v', first_frame: fname });
            row.dataset.storyboard = fname;   // 对照表「分镜图」列显示本格（保存时随 storyboard 落盘）
            segsWrap.appendChild(row);
        }
        if (modeSel && modeSel.value !== 'f2v') modeSel.value = 'f2v';   // 宫格拆分各段均带首帧（图生）：同步全局为关键帧生视频模式
        renumberSegs(); showSeg(0); applyGlobalMode();
        renderSetupSegs();   // 对照表按各格分镜图刷新（内部会重算徽标与动作可用性）
        const p0 = panels[0] || {};
        applyAspectFromImage(p0.width, p0.height);   // 共享比例吸附到首帧最近预设（各格同比例），避免忘记改而拉伸
        markDirty();
    }

    gridSplitBtn.onclick = async () => {
        if (!gridSrcFile) { app.extensionManager.toast.add({ severity: 'error', summary: t('宫格拆分'), detail: t('请先选择宫格图（本地添加或素材库）'), life: 4000 }); return; }
        const body = { filename: gridSrcFile };
        if (gridModeSel.value === 'manual') {
            body.rows = Number(gridRowsInp.value) || 1;
            body.cols = Number(gridColsInp.value) || 1;
        }
        // 拆分即替换现有分段：旧段有内容（提示词 / 分镜图）时先确认
        const oldRows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        const hasContent = oldRows.some(r => r.querySelector('.neo-director-prompt').value.trim() || r.dataset.storyboard);
        if (oldRows.length && hasContent && !confirm(t('拆分后现有分段将被替换，继续？'))) return;
        gridSplitBusy = true; refreshStepState(); gridStatus.textContent = t('正在拆分…');
        try {
            const res = await fetch('/rs_recipes/grid_split', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const data = await res.json();
            if (!data.success) { gridStatus.textContent = ''; app.extensionManager.toast.add({ severity: 'error', summary: t('宫格拆分'), detail: data.error || t('切分失败'), life: 5000 }); return; }
            assignGridPanels(data.panels);
            setGridPrompts(data.prompts);   // 原宫格图元信息里的提示词：就地展示（不改动各段提示词）
            gridPanelShape = { rows: Number(data.rows) || 0, cols: Number(data.cols) || 0 };   // 记录行列，供逐格描述标注本格位置
            gridStatus.textContent = tf("{rows}×{cols} → {n}格", { rows: data.rows, cols: data.cols, n: data.panels.length });
            autoFillName(typeof data.prompts === 'string' ? data.prompts : (data.prompts || [])[0] || '');
            app.extensionManager.toast.add({ severity: 'success', summary: t('宫格拆分'), detail: tf("{rows}×{cols} → {n} 段（各格已作首帧）", { rows: data.rows, cols: data.cols, n: data.panels.length }), life: 4000 });
            if (data.panels.length > 9) app.extensionManager.toast.add({ severity: 'warning', summary: t('宫格拆分'), detail: tf("格子数 {n} 超过 H3 参考上限 9，保存时多余段不会被执行", { n: data.panels.length }), life: 6000 });
        } catch (e) {
            console.error('[Neo Recipes] Director grid split failed:', e);
            gridStatus.textContent = '';
            app.extensionManager.toast.add({ severity: 'error', summary: t('宫格拆分'), detail: e.message, life: 5000 });
        } finally { gridSplitBusy = false; refreshStepState(); }
    };

    // band 1 主卡：宫格图故事板——只做拆分（宫格图在外部生成），各格替换现有分段并作为该段首帧与分镜图。
    // 卡标题行拆两列，与下方源图 / 提示词列共享同一 grid（「全局故事参考」label 左缘对齐 textarea）
    const srcGridCard = $el('div', { className: 'neo-director-src-card neo-director-src-card-grid' }, [
        $el('div', { className: 'neo-director-src-head' }, [
            stepGridBadge,   // ② 分段：宫格来源由「拆分到各段」完成
            $el('span', {
                className: 'neo-director-src-desc',
                title: t('上传一张带分隔条 / 留白的分镜宫格图（在外部生成），自动检测行列并切分；各格按阅读顺序替换现有分段，并作为该段首帧与分镜图。点击输入区本地上传，或从左侧素材库 / 本地文件拖入'),
                textContent: t('拆成分镜，分镜作首帧'),
            }),
        ]),
        $el('div', { className: 'neo-director-src-head' }, [
            $el('span', {
                className: 'neo-director-field-label',
                title: t('默认是拆分时从原宫格图内嵌的 ComfyUI 元信息（PNG 里的 prompt）自动提取的提示词，可手动改写供逐格描述；各段分镜图见下方「各段对照」'),
                textContent: t('全局故事参考（默认为原宫格提示词）'),
            }),
            gridPromptCopy,
            // 本步动作组（靠卡右上角）：先定切分方式，再「拆分到各段」
            $el('div', { className: 'neo-director-step-act' }, [
                $el('label', { className: 'neo-director-seglen-wrap', title: t('自动检测行列（推荐），或手动指定行×列') }, [
                    $el('span', { textContent: t('切分方式') }), gridModeSel, manualCtrls,
                ]),
                gridStatus,
                gridSplitBtn,
            ]),
        ]),
        gridSrcDrop,   // 图片输入区：点击本地上传 / 素材库·本地文件拖入（右下角操作条含「宫格素材库」+「+」）
        // 常显（不折叠）：拆分提取到提示词后直接就地显示；左缘与上方「全局故事参考」label 对齐
        $el('div', { className: 'neo-director-grid-pt' }, [
            gridPromptsTa,   // 全局故事参考：默认原宫格提示词、可手动改写（各格缩略图已在「各段对照」逐段显示，此处不再重复）
        ]),
    ]);

    // 当前选中的角色参考（{filename} 列表）：随配方落盘，供各段身份参考；空则不写该键。
    const storyRefsPayload = () => {
        const c = charRefRow.getSelected();
        return c.length ? { characters: c.map(fn => ({ filename: fn })) } : {};
    };

    // 「拉伸」控制条：放在时间轴说明行最右侧（不独占一行），驱动 timeline.setZoom()。
    const zoomSlider = $el('input', { className: 'neo-director-zoom-slider', type: 'range', min: 0.25, max: 4, step: 0.25, value: 1 });
    zoomSlider.addEventListener('input', () => { if (timeline) timeline.setZoom(Number(zoomSlider.value)); });
    const zoomToggle = $el('button', { className: 'neo-director-zoom-toggle', type: 'button', title: t('拉伸时间轴'), textContent: t('↔ 拉伸') });
    zoomToggle.addEventListener('click', () => {
        if (!timeline) return;
        const next = timeline.getZoom() <= 1 ? 2 : 1;
        timeline.setZoom(next);
        zoomSlider.value = String(next);
    });
    const tlLabelRow = $el('div', { className: 'neo-director-tl-label' }, [
        $el('span', { textContent: t('时间轴（拖拽重排 · 点击定位分段 · 尾部 ＋ 添加段）') }),
        addBtn,
        $el('div', { className: 'neo-director-zoom' }, [zoomToggle, zoomSlider]),
    ]);
    // 全局生成模式：关键帧生视频 / 全参考 / 混合（决定各段携带哪些帧与参考）。
    // 旧配方的 t2v/i2v/fl2v/v2v/rv2v 静默重映射为 f2v/r2v；无 shared.mode 时按各段内容推断：有参考素材=r2v、其余=关键帧生视频（旧 v2v/rv2v 源视频已在载入时并入参考视频）。
    const initMode = (() => {
        const m = LEGACY_MODE_MAP.get(exShared.mode) || exShared.mode;
        if (MODE_LABELS.has(m)) return m;
        const hasRef = normSegs.some(s => s && ((s.refs && Object.keys(s.refs).length)));
        return hasRef ? 'r2v' : 'f2v';
    })();
    modeSel = $el('select', { className: 'neo-director-mode' });
    for (const [val, label] of MODE_LABELS) {
        modeSel.appendChild($el('option', { value: val, textContent: label }));
    }
    modeSel.value = initMode;
    // 生成模式只在「分镜时间线」页首行这一处选择（故事板分镜与生成模式无关）：切换时刷新各段显隐，并联动故事板分镜页的模式提示
    modeSel.addEventListener('change', () => { applyGlobalMode(); refreshSetupRefs(); refreshChunkSecVisibility(); });

    // 分块秒数（shared.chunk_sec）：连续兼容段合并成一次多帧单次 ref2va 运行的总时长预算；0 = 关闭（纯逐段生成）
    chunkSecLabel = $el('label', { textContent: t('分块秒数') });
    chunkSecInp = $el('input', {
        className: 'neo-director-num neo-director-chunk-sec', type: 'number', min: 0, max: 30, step: 1,
        value: (exShared.chunk_sec != null ? exShared.chunk_sec : 15),
        title: t('多帧单次分块：连续兼容段（文生/图生/首尾帧、无自带参考素材）总时长 ≤ 该值时合并成一次 ref2va 运行，各段分镜关键帧钉在起点；0 = 关闭（纯逐段生成）。建议 ≤15'),
    });
    chunkSecInp.addEventListener('input', () => { markDirty(); refreshChunkMarkers(); });

    // 整片运行参数（落 shared.seed / shared.steps / shared.continuity / shared.context_frames）：
    // Studio 生成面板不再带这些控件，整片怎么跑完全看这里存进配方的值。
    const initSeed = Number(exShared.seed);
    seedSharedInp = $el('input', {
        className: 'neo-director-num neo-director-seed', type: 'number', min: -1, max: 2 ** 63 - 1,
        placeholder: t('随机'), title: t('留空 = 每次运行随机换种子；各段种子 = 本种子 + 段号'),
        value: Number.isFinite(initSeed) && initSeed >= 0 ? String(initSeed) : '',
    });
    const initSteps = Number(exShared.steps);
    stepsSharedInp = $el('input', {
        className: 'neo-director-num neo-director-steps', type: 'number', min: -1, max: 100,
        placeholder: t('技能默认'), title: t('留空 = 用各段技能 config 的步数；填值则整片统一用这个步数'),
        value: Number.isFinite(initSteps) && initSteps > 0 ? String(initSteps) : '',
    });
    continuitySharedChk = $el('input', { type: 'checkbox' });
    continuitySharedChk.checked = exShared.continuity !== false;   // 旧配方无该键 = 开
    continuitySharedChk.title = t('跨段连续性：上一段尾部画面作为下一段开头的重生成窗口 + 角色身份参考继承');
    ctxSharedInp = $el('input', {
        className: 'neo-director-num neo-director-ctx', type: 'number', min: 0, max: 362,
        title: t('上下文窗口帧数：0 = 退回尾帧链入（只带上一段尾帧，不重生成窗口）'),
        value: String(Number.isFinite(Number(exShared.context_frames)) ? Math.min(362, Math.max(0, Number(exShared.context_frames))) : 22),
    });
    ctxSharedWrap = $el('div', { className: 'neo-director-seg-len' }, [
        $el('span', { textContent: t('上下文帧') }), ctxSharedInp,
    ]);
    const refreshCtxVisibility = () => { ctxSharedWrap.style.display = continuitySharedChk.checked ? '' : 'none'; };
    refreshCtxVisibility();
    for (const el of [seedSharedInp, stepsSharedInp, ctxSharedInp]) el.addEventListener('change', markDirty);
    continuitySharedChk.addEventListener('change', () => { markDirty(); refreshCtxVisibility(); });

    // 整片运行参数收进「高级参数」组：默认收起，勾选才在行尾换出来。纯原生 checkbox + CSS :checked，无 JS；
    // 收起时控件留在 DOM 里，保存照读值——收起不等于不生效。
    const advChk = $el('input', { className: 'neo-director-adv-check', type: 'checkbox', 'aria-label': t('高级参数') });
    const advWrap = $el('div', { className: 'neo-director-adv' }, [
        advChk,
        $el('span', { className: 'neo-director-adv-label', textContent: t('高级参数'), title: t('种子 / 步数 / 连续性 / 上下文帧：整片怎么跑的参数，默认收起') }),
        $el('span', { className: 'neo-director-adv-items' }, [
            $el('label', { textContent: t('种子') }), seedSharedInp,
            $el('label', { textContent: t('步数') }), stepsSharedInp,
            $el('label', { className: 'neo-director-check' }, [continuitySharedChk, $el('span', { textContent: t('连续性') })]),
            ctxSharedWrap,
        ]),
    ]);

    // 多帧单次分块预览（后端 _plan_chunks 的镜像，仅显示用）：把会合并进同一次 ref2va 运行的连续兼容段标成一个块
    const CHUNK_COMPATIBLE_MODES = new Set(['f2v']);
    const multiFrameSkillIds = new Set(skills.filter((s) => s.multi_frame).map((s) => s.id));   // 多帧单次技能 id（frontmatter multi_frame）
    // 「分块秒数」仅在统一技能支持多帧时显示（否则用户不该看到它）；混合模式 gSkillSel 池为空 → 隐藏
    const refreshChunkSecVisibility = () => {
        if (!chunkSecLabel || !chunkSecInp) return;
        // 分块秒数只合并「连续的多段」：单段没有可合并对象，技能支持多帧也不该出现
        const multiSeg = segsWrap.querySelectorAll('.neo-director-seg').length > 1;
        const show = multiSeg && !!(gSkillSel && multiFrameSkillIds.has(gSkillSel.value));
        chunkSecLabel.style.display = show ? '' : 'none';
        chunkSecInp.style.display = show ? '' : 'none';
    };
    const rowEffSkillId = (row) => {   // 该段生效的视频技能 id：非混合取统一技能框，混合取段内下拉
        if (modeSel.value === 'mixed') {
            const sel = row.querySelector('.neo-director-skill');
            return sel ? sel.value : '';
        }
        return gSkillSel ? gSkillSel.value : '';
    };
    const rowDurSec = (row) => {
        const durInp = row.querySelector('.neo-director-dur');
        return Number(durInp && durInp.value) || 5;
    };
    const planChunkUnits = (rows, budgetSec) => {
        const units = [];
        let cur = [], curDur = 0;
        const flush = () => { if (cur.length) { units.push({ kind: cur.length > 1 ? 'multi' : 'legacy', segs: cur }); cur = []; curDur = 0; } };
        // 参考集签名（图/视频/音频各自按顺序）：后端 _ref_signature 的镜像，块内各段须一致才合并
        const refSig = (row) => [0, 1, 2].map((g) => {
            const r = (segRefReaders.get(row) || [])[g];
            return r && r() ? (r() || []) : [];
        }).map((l) => l.join('\u0001')).join('\u0002');
        for (const row of rows) {
            const dur = rowDurSec(row);
            const segModeSel = row.querySelector('.neo-director-segmode');
            const effMode = modeSel.value === 'mixed' ? (segModeSel ? segModeSel.value : 'f2v') : modeSel.value;
            const reads = segRefReaders.get(row) || [];
            const hasRefs = reads.some((r) => r && r().length);
            // 兼容（后端 _chunk_compatible 镜像）：多帧技能，且（f2v 无参考）或（r2v 有参考）
            let compatible;
            if (!multiFrameSkillIds.has(rowEffSkillId(row))) compatible = false;
            else if (effMode === 'r2v') compatible = hasRefs;
            else compatible = CHUNK_COMPATIBLE_MODES.has(effMode) && !hasRefs;
            if (!compatible || dur > budgetSec) {
                flush(); units.push({ kind: 'legacy', segs: [row] }); continue;
            }
            if (cur.length && (curDur + dur > budgetSec || refSig(cur[0]) !== refSig(row))) flush();
            cur.push(row); curDur += dur;
        }
        flush();
        return units;
    };
    let chunkSig = '';
    const refreshChunkMarkers = () => {
        if (!chunkSecInp || !modeSel) return;   // 初始化顺序保护：分块输入 / 模式选择器未就绪时跳过
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        const budget = Number(chunkSecInp.value);   // 分块秒数；0 = 关闭（全逐段）
        const marks = [];
        if (Number.isFinite(budget) && budget > 0) {
            for (const u of planChunkUnits(rows, budget)) {
                if (u.kind !== 'multi') continue;
                const total = Math.round(u.segs.reduce((s, r) => s + rowDurSec(r), 0) * 10) / 10;
                marks.push({ row: u.segs[0], total, n: u.segs.length });
            }
        }
        const sig = JSON.stringify(marks.map((m) => [m.row.dataset.segId, m.total]));
        if (sig === chunkSig) return;   // 无变化不动 DOM（本函数挂在 MutationObserver 上，避免自触发循环）
        chunkSig = sig;
        for (const r of rows) {
            r.classList.remove('neo-director-chunk');
            const b = r.querySelector('.neo-director-chunk-badge');
            if (b) b.remove();
        }
        for (const m of marks) {
            m.row.classList.add('neo-director-chunk');
            const head = m.row.querySelector('.neo-director-seg-head');
            if (!head) continue;
            head.prepend($el('span', {
                className: 'neo-director-chunk-badge',
                title: tf("多帧单次块：{n} 段合并成一次 ref2va 运行（总时长 {total}s，各段分镜关键帧钉在起点）", { n: m.n, total: m.total }),
                textContent: `${m.total}s`,
            }));
        }
    };

    // 统一技能（非混合模式）：紧邻生成模式，一次选择应用到所有分段（各段行不再单独选技能）；混合模式整体隐藏（逐段各选）。
    // 新建配方默认技能：技能池第一个可用的——池已按步数从少到多排序（见 skillOptionPool），故步数少的优先，
    // 不可用的（如 VDN 插件未装）跳过。编辑已有配方不动（沿用落盘的段技能）。
    // 「新建」以配方名为准：图库「新建导演配方」传的是 { name: '' }，对象非 null 但仍是新建。
    const newDefaultSkill = (() => {
        if (requestedName || !skills.length) return skills.length ? skills[0].id : '';
        const pool = skillOptionPool(initMode);
        const usable = pool.filter(s => s.available !== false);
        return (usable.length ? usable : pool)[0].id;
    })();
    const initSkillId = (exSegs[0] && exSegs[0].skill_id) || newDefaultSkill;
    const gSkillLabel = $el('label', { className: 'neo-director-global-skill-label', textContent: t('技能') });
    gSkillSel = $el('select', { className: 'neo-director-global-skill', title: t('统一决定各段模板与模型；混合模式下改为逐段选择') });
    fillSkillOptions(gSkillSel, initMode, initSkillId);
    attachSkillPickerToSelect(gSkillSel);   // 点击弹居中搜索窗（与段内技能下拉一致）
    gSkillSel.addEventListener('change', () => { pushGlobalSkill(); refreshChunkSecVisibility(); });
    applyGlobalMode();   // 初始化各段首帧/尾帧/参考素材区、统一技能框显隐，并把统一技能同步到各段

    // ==========================================
    // 故事板分镜 band 2：各段分镜图 → 逐格按 H3 官方格式生成提示词，再到时间轴逐段微调
    // 生成模式 / 统一技能只在「分镜时间线」页选择，本页只跟随刷新；
    // 参考素材没有「统一」入口：到时间轴页各段的参考素材区逐段设置（含「同步到所有分段」按钮）
    // ==========================================

    const uniR2vHint = $el('div', { className: 'neo-director-setup-hint', textContent: t('全参考模式：各段的参考素材（图 / 视频 / 音频，第一个参考视频即源视频）请到「分镜时间线」页逐段设置') });
    const uniMixedHint = $el('div', { className: 'neo-director-setup-hint', textContent: t('混合模式：技能与首帧/尾帧 / 参考素材请到「分镜时间线」页逐段设置') });

    // 按全局生成模式刷新两条模式提示（与各段有效模式的显隐规则一致）。
    // 生成模式的选择在「分镜时间线」页首行（故事板分镜与生成模式无关），这里只跟随刷新。
    function refreshSetupRefs() {
        const m = modeSel.value;
        uniR2vHint.style.display = (m === 'r2v') ? '' : 'none';   // 参考素材到时间轴页逐段设置（本页无统一入口）
        uniMixedHint.style.display = (m === 'mixed') ? '' : 'none';
    }

    // 逐格生成提示词：各段分镜图（宫格各格 / 拖入的分镜图）+ 本格在宫格里的位置 + 全局故事参考 → LLM 按 H3 官方格式写回编辑器
    const optBtn = $el('button', { className: 'rs-btn neo-director-optimize', textContent: t('生成所有分段的提示词') });
    const optStatus = $el('span', { className: 'neo-director-opt-status' });
    // 逐段循环调用单段端点：一次只让 LLM 处理一段（降低单次负担），每生成完一段立即写回并刷新对照表，让用户看到进展。
    optBtn.onclick = async () => {
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        if (!rows.length) { app.extensionManager.toast.add({ severity: 'error', summary: t('多段导演'), detail: t('还没有分段，请先在故事板页拆分'), life: 3000 }); return; }
        // 首次优化前快照各段原文；之后重新点优化始终基于该原文再试（不叠加上一轮结果）
        if (!origPrompts) origPrompts = rows.map((row) => row.querySelector('.neo-director-prompt').value);
        const segs = rows.map((row, i) => {
            const s = {
                prompt: (origPrompts[i] || '').trim(),
                duration_sec: Number(row.querySelector('.neo-director-dur').value) || null,
                panel: segStoryboardFname(row),   // 各段无原文时按该段分镜图（首帧）逐格描述
                panel_index: i + 1,               // 本格在宫格里的位置 + 全片故事上下文：让 LLM 判断本格是第几段、承接哪一段
                panel_total: rows.length,
            };
            if (gridPanelShape && gridPanelShape.rows && gridPanelShape.cols) {
                s.rows = gridPanelShape.rows;
                s.cols = gridPanelShape.cols;
            }
            const storyRef = gridPromptsTa.value.trim();   // 全局故事参考：默认原宫格提示词，可手动改写
            if (storyRef) s.grid_prompts = [storyRef];
            if (modeSel.value === 'r2v') {   // 参考素材仅全参考模式携带：取该段自己的参考素材区，其余模式不带
                const refs = {};
                (segRefReaders.get(row) || []).forEach((read, gi) => { const picked = read() || []; if (picked.length) refs[SEG_REF_GROUPS[gi].key] = picked; });
                if (Object.keys(refs).length) s.refs = refs;
            }
            return s;
        });
        if (!segs.some(s => s.panel)) { app.extensionManager.toast.add({ severity: 'error', summary: t('多段导演'), detail: t('宫格拆分后没有分镜图可描述，请重新拆分'), life: 4000 }); return; }
        optBusy = true; refreshStepState();
        let okCount = 0, skipped = 0, failed = [], firstErr = '';
        const prompts = [];   // 本轮已生成的各段提示词：下一段按它承接上下文
        for (let i = 0; i < segs.length; i++) {
            if (!segs[i].panel && !segs[i].prompt) { skipped++; continue; }   // 无分镜图也无提示词：跳过（直接拖入的多图流程允许留空段）
            optStatus.textContent = tf("正在生成第 {i}/{total} 段提示词…", { i: i + 1, total: segs.length });
            try {
                const ta = rows[i].querySelector('.neo-director-prompt');
                const acc = { text: '' };
                let segErr = null;
                // 有原文 → 按 H3 格式重写（附参考图走多模态）；宫格空原文 → 按该段分镜图（首帧）逐格描述。两者均 SSE 流式回传。
                const url = segs[i].prompt ? '/rs_recipes/director_optimize_prompts' : '/rs_recipes/director_describe_panel';
                const body = segs[i].prompt
                    ? { prompt: segs[i].prompt, duration_sec: segs[i].duration_sec, mode: modeSel.value, refs: segs[i].refs }
                    : {
                        panel: segs[i].panel, duration_sec: segs[i].duration_sec,
                        panel_index: segs[i].panel_index, panel_total: segs[i].panel_total,
                        rows: segs[i].rows, cols: segs[i].cols, grid_prompts: segs[i].grid_prompts,
                        prev_prompt: prompts[i - 1] || '',   // 上一段本轮已生成提示词：承接上下文（第 1 段无）
                    };
                await sseStream(url, {
                    onChunk: (parsed) => {
                        acc.text += parsed.text || '';
                        ta.value = acc.text;
                        _updateOptCell(i, acc.text);   // 逐 token 轻量刷新对照表右栏，让用户看到进展
                    },
                    onError: (msg) => { segErr = msg; },
                }, body);
                if (segErr) throw new Error(segErr);
                const finalText = acc.text.trim();
                if (!finalText) throw new Error(t('优化结果为空，请重试'));
                ta.value = finalText;
                ta.dispatchEvent(new Event('input', { bubbles: true }));   // 触发自动命名 / 脏标记等既有逻辑
                prompts[i] = finalText;
                okCount++;
            } catch (e) {
                console.error(`[Neo Recipes] Director generate segment ${i + 1} failed:`, e);
                // 流式中途失败：段里已写回半截文本，按原文恢复该段，避免半截提示词被当成结果保存
                const ta = rows[i].querySelector('.neo-director-prompt');
                ta.value = origPrompts[i] || '';
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                failed.push(i + 1);
                if (!firstErr) firstErr = e.message;
            }
            renderSetupSegs();   // 每生成一段刷新对照表，让用户看到进展
        }
        optBusy = false; refreshStepState();
        if (!okCount) renderSetupSegs();
        else markDirty();
        if (failed.length) {
            optStatus.textContent = tf("第 {segs} 段生成失败，其余 {n} 段已完成", { segs: failed.join('、'), n: okCount });
            handleLLMError(tf("提示词生成（第 {segs} 段）", { segs: failed.join('、') }), firstErr);
        } else if (skipped === segs.length) {
            optStatus.textContent = t('所有段都没有分镜图或提示词，未生成');
        } else {
            optStatus.textContent = tf("已生成 {n} 段提示词{skipped}，可到时间轴页逐段微调", { n: okCount, skipped: skipped ? tf("（跳过 {n} 个无图段）", { n: skipped }) : '' });
            app.extensionManager.toast.add({ severity: 'success', summary: t('提示词生成完成'), detail: tf("{n} 段已按 H3 官方格式生成", { n: okCount }), life: 4000 });
        }
    };

    // 「故事板分镜」页 band 3：各段两栏对照（类似表格）——左 = 分镜图（宫格各格 / 拖入的分镜图），右 = 该段提示词。
    // 分镜图列取该段关键帧记录，无且 f2v 模式时回退到时间轴选的首帧；两者皆无显示「无」。
    // 首次点逐格生成前快照原文（origPrompts），之后重新点始终基于该原文再试、不叠加上一轮结果；
    // 快照随 setup 落盘，打开旧配方时回显。数据读时间轴各段行（唯一事实来源）。
    const setupSegPreview = $el('div', { className: 'neo-director-setup-segs' });
    // 单段配方不走「各段对照 + 逐格生成提示词」那套多段工具：换成一行提示，指回时间线页填提示词
    const setupSingleHint = $el('div', {
        className: 'neo-director-setup-hint neo-director-single-story-hint',
        textContent: t('单段配方：提示词在「分镜时间线」页底部填写；要拆成多段，用上面的宫格图拆分；要按故事主题生成分段，用右栏智能体'),
    });
    let segDragEl = null;      // band-2 对照表正在拖拽排序的项
    let segReordering = false; // 内部段排序拖拽进行中（抑制分镜图位的上传拖放）
    setupSegPreview.addEventListener('dragover', onSetupSegsDragOver);
    // 该段有效模式（混合模式取段内下拉，其余取全局）：与时间轴页首帧栏显隐口径一致
    const segEffMode = (row) => {
        const g = modeSel ? modeSel.value : 'f2v';
        const segModeSel = row.querySelector('.neo-director-segmode');
        return (g === 'mixed' && segModeSel) ? segModeSel.value : g;
    };
    // 该段分镜图：优先取关键帧记录（逐段生成图片分镜 / 宫格各格）；无且 f2v 模式时回退到时间轴选的首帧（与后端「分镜首帧优先」同源）
    function segStoryboardFname(row) {
        if (row.dataset.storyboard) return row.dataset.storyboard;
        const frames = segFrameReaders.get(row);
        return (frames?.first && segEffMode(row) === 'f2v') ? frames.first() : '';
    }
    // 徽标状态：done 显示 ，current / todo 显示序号（current 高亮、todo 变淡）
    const bumpStep = (badge, no, state) => {
        badge.textContent = state === 'done' ? '' : no;
        badge.title = state === 'done' ? t('已完成') : (state === 'current' ? t('当前步骤') : t('前置未完成'));
        badge.classList.toggle('neo-director-step-done', state === 'done');
        badge.classList.toggle('neo-director-step-current', state === 'current');
        badge.classList.toggle('neo-director-step-todo', state === 'todo');
    };
    // 两步徽标 + 各步动作按钮的置灰：只有「完全没有前置」才置灰（例：没选宫格图时的「拆分到各段」），
    // 内容不完整仍保持可点、由各按钮自己的 toast 说明——避免把「部分可用」变成「完全点不动」。
    function refreshStepState() {
        if (!stepUiReady) return;
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        const prompts = rows.map((r) => (r.querySelector('.neo-director-prompt')?.value || '').trim());
        const panels = rows.map((r) => segStoryboardFname(r));
        const hasGridSrc = !!gridSrcFile;
        const hasSegs = rows.length > 0;
        const anyPanel = panels.some(Boolean);
        const allPanel = hasSegs && panels.every(Boolean);
        const allPrompt = hasSegs && prompts.every(Boolean);

        bumpStep(stepGridBadge, '①', allPanel ? 'done' : (hasGridSrc ? 'current' : 'todo'));   // 拆分：各段都有格子图
        bumpStep(stepOptBadge, '②', allPrompt ? 'done' : (anyPanel ? 'current' : 'todo'));     // 提示词：各段都有提示词（逐格生成或手写）

        gridSplitBtn.disabled = !hasGridSrc || gridSplitBusy;
        gridSplitBtn.title = hasGridSrc ? t('把宫格图按行列切成各段（各格作该段首帧与分镜图）') : t('请先选宫格图（本地上传或素材库拖入）');
        optBtn.disabled = !anyPanel || optBusy;
        optBtn.title = anyPanel ? t('逐段重写为 H3 官方格式提示词') : t('请先拆分宫格图');
    }


    // 分镜图缩略位支持直接拖入 / 上传（跳过宫格拆分）：把已拆好的分镜图落到该段并同步为首帧；多张拖入自动补空段承接
    function setSegStoryboard(row, fname) {
        if (!imageRefs.some(r => r.filename === fname)) imageRefs.push({ filename: fname, subfolder: '', type: 'input', kind: 'image' });
        row.dataset.storyboard = fname;
        const setters = segFrameSetters.get(row);
        if (setters) setters.first(fname);   // 分镜图同步为该段首帧（宫格模式：格子即首帧）
        markDirty();
    }
    // 拖入分镜图：本地图片文件走 uploadLocalFiles，素材库图片卡走 copyGalleryToInput；返回落盘文件名列表（可能为空）
    async function extractDroppedImageFnames(e) {
        const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
        let fnames = files.length ? await uploadLocalFiles(files) : [];
        if (!fnames.length) { const g = await copyGalleryToInput(grabDataType(e)); if (g) fnames = [g]; }
        return fnames;
    }
    function attachSegThumbUpload(thumb, row) {
        thumb.addEventListener('dragover', (e) => { if (segReordering) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; thumb.classList.add('neo-director-drop'); });
        thumb.addEventListener('dragleave', (e) => { if (!thumb.contains(e.relatedTarget)) thumb.classList.remove('neo-director-drop'); });
        thumb.addEventListener('drop', async (e) => {
            e.preventDefault();
            if (segReordering) return;
            thumb.classList.remove('neo-director-drop');
            const fnames = await extractDroppedImageFnames(e);
            if (!fnames.length) return;
            setSegStoryboard(row, fnames[0]);
            const defaultSkill = currentSkillId() || (skills.length ? skills[0].id : '');
            for (let k = 1; k < fnames.length; k++) {   // 多张拖入：自动补空段承接
                const nr = buildSeg({ skill_id: defaultSkill, prompt: '', duration_sec: 5, mode: 'f2v' });
                segsWrap.appendChild(nr);
                setSegStoryboard(nr, fnames[k]);
            }
            renumberSegs();
            renderSetupSegs();
        });
        if (thumb.classList.contains('neo-director-setup-seg-thumb-empty')) {   // 空位：点击本地上传（已填图时点缩略图看大图）
            const picker = buildLocalFilePicker('image/*', (fname) => { setSegStoryboard(row, fname); renderSetupSegs(); });
            thumb.appendChild(picker.input);
            thumb.onclick = () => picker.open();
        }
    }
    // band-2 末尾常驻空段的缩略位：拖入 / 点击上传分镜图才真实建段（每张图新建一段并设为其分镜图）
    function attachGhostThumbUpload(thumb) {
        const createWith = (fname) => {   // 新建一段并设为其分镜图
            const defaultSkill = currentSkillId() || (skills.length ? skills[0].id : '');
            const nr = buildSeg({ skill_id: defaultSkill, prompt: '', duration_sec: 5, mode: 'f2v' });
            segsWrap.appendChild(nr);
            setSegStoryboard(nr, fname);
        };
        thumb.addEventListener('dragover', (e) => { if (segReordering) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; thumb.classList.add('neo-director-drop'); });
        thumb.addEventListener('dragleave', (e) => { if (!thumb.contains(e.relatedTarget)) thumb.classList.remove('neo-director-drop'); });
        thumb.addEventListener('drop', async (e) => {
            e.preventDefault();
            if (segReordering) return;
            thumb.classList.remove('neo-director-drop');
            const fnames = await extractDroppedImageFnames(e);
            if (!fnames.length) return;
            for (const fname of fnames) createWith(fname);   // 拖入即建段：每张图新建一段并设为其分镜图
            renumberSegs();
            renderSetupSegs();
        });
        const picker = buildLocalFilePicker('image/*', (fname) => { createWith(fname); renumberSegs(); renderSetupSegs(); });   // 点击本地上传（上传后真实建段）
        thumb.appendChild(picker.input);
        thumb.onclick = () => picker.open();
    }
    // band-2 对照表项拖拽排序：拖动头部手柄在预览项间实时换位，松手后把新顺序回写到 segsWrap（唯一事实来源）并刷新。
    function attachSegReorder(item) {
        const grip = item.querySelector('.neo-director-story-seg-grip');
        if (!grip) return;
        grip.addEventListener('mousedown', () => { item.draggable = true; });
        item.addEventListener('dragstart', (e) => {
            segDragEl = item;
            segReordering = true;
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', ''); } catch (_) {}
            requestAnimationFrame(() => item.classList.add('neo-director-seg-dragging'));
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('neo-director-seg-dragging');
            item.draggable = false;
            segDragEl = null;
            segReordering = false;
            commitSegReorder();
        });
    }
    // 拖动经过时实时换位：指针落在某项上半部 → 插到它前面，否则移到末尾（保持在各预览项之间，不越过表头 / 添加行）
    function onSetupSegsDragOver(e) {
        if (!segDragEl) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const items = Array.from(setupSegPreview.querySelectorAll('.neo-director-story-seg-item')).filter(it => it !== segDragEl);
        let target = null;
        for (const it of items) {
            const r = it.getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2) { target = it; break; }
        }
        if (target) setupSegPreview.insertBefore(segDragEl, target);
        else if (items.length) setupSegPreview.insertBefore(segDragEl, items[items.length - 1].nextSibling);
    }
    // 松手后把预览项最终顺序（每项 _segIdx = 原 segsWrap 行号）映射成新顺序，交给 onReorderSegs 重排真实行
    function commitSegReorder() {
        const items = Array.from(setupSegPreview.querySelectorAll('.neo-director-story-seg-item'));
        if (items.length < 2) return;
        const order = items.map(it => it._segIdx);
        if (order.every((v, k) => v === k)) return;   // 顺序未变 → 不触发 markDirty
        onReorderSegs(order);
        renderSetupSegs();
    }

    // band-2 末尾常驻空段（纯 UI，不进 segsWrap、不保存、不参与拖拽排序）：缩略图位看起来可拖入 / 上传分镜图，触发才真实新建一段
    function buildGhostSeg() {
        const thumb = $el('div', { className: 'neo-director-setup-seg-thumb neo-director-setup-seg-thumb-empty neo-director-story-seg-ghost-thumb' }, [
            $el('span', { className: 'neo-director-setup-seg-thumb-hint', textContent: t('＋ 拖入 / 上传分镜图新增一段') }),
        ]);
        attachGhostThumbUpload(thumb);
        const promptCells = [$el('div', { className: 'neo-director-story-seg-prompt' })];
        return $el('div', { className: 'neo-director-story-seg-ghost' }, [
            $el('div', { className: 'neo-director-story-seg-head' }, [$el('span', { textContent: t('＋ 新增分镜段') })]),
            $el('div', { className: 'neo-director-setup-seg-cols' }, [thumb, ...promptCells]),
        ]);
    }

    // 常驻空段显隐：无分段时它是唯一新增入口；有分段时仅当第一段已有输入（分镜图或提示词）才显示——第一段还没填时不出现幻影行
    function syncGhostSeg() {
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        const first = rows[0];
        const show = !rows.length || (!!first && (!!segStoryboardFname(first) || !!(first.querySelector('.neo-director-prompt')?.value || '').trim()));
        const ghost = setupSegPreview.querySelector('.neo-director-story-seg-ghost');
        if (show && !ghost) {
            setupSegPreview.appendChild(buildGhostSeg());
        } else if (!show && ghost) {
            ghost.remove();
        }
    }

    // 流式生成时轻量刷新某段对照表的提示词单元格：只改 textContent，不整表重渲
    function _updateOptCell(i, text) {
        for (const item of setupSegPreview.querySelectorAll('.neo-director-story-seg-item')) {
            if (item._segIdx === i) {
                const cells = item.querySelectorAll('.neo-director-story-seg-prompt');
                const last = cells[cells.length - 1];
                if (last) last.textContent = text;
                return;
            }
        }
    }

    function renderSetupSegs() {
        refreshStepState();   // 各段内容变化 → 重算两步徽标与各步动作可用性
        setupSegPreview.innerHTML = '';
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        // 各段分镜图汇总成一份 Lightbox 列表：点任一缩略图从该段开始，←/→ 在各段间切换；按文件名去重避免重复页
        if (rows.length) {
            setupSegPreview.appendChild($el('div', { className: 'neo-director-setup-seg-cols neo-director-setup-seg-labels' }, [
                $el('span', { textContent: t('分镜图') }),
                $el('span', { textContent: t('提示词') }),
            ]));
        } else {
            setupSegPreview.appendChild($el('div', { className: 'neo-director-story-segs-empty', textContent: t('（还没有分段，把分镜图拖入下方空段即可新增）') }));
        }
        const sbItems = [];
        const sbItemIdx = new Map();
        rows.forEach((row, i) => {
            const dur = row.querySelector('.neo-director-dur').value;
            const thumb = $el('div', { className: 'neo-director-setup-seg-thumb' });
            const sbFname = segStoryboardFname(row);
            if (sbFname) {
                // 悬停 ✕：清除本列当前显示的分镜图——有关键帧记录时清记录（若首帧正是该关键帧则一并取消选中，storyboard_prompt 快照保留便于重新生成）；
                // 显示的是首帧回退时直接清该段首帧。
                const hasSb = !!row.dataset.storyboard;
                const clearStoryboard = () => {
                    if (hasSb) {
                        const fname = row.dataset.storyboard;
                        delete row.dataset.storyboard;
                        const setters = segFrameSetters.get(row);
                        if (fname && setters?.first && setters.first() === fname) setters.first('');
                        markDirty();
                    } else {
                        segFrameSetters.get(row)?.first?.('');   // setter 已标脏
                    }
                    renderSetupSegs();   // 本列回到「无」
                };
                if (!sbItemIdx.has(sbFname)) {
                    sbItemIdx.set(sbFname, sbItems.length);
                    sbItems.push({ kind: 'image', url: thumbSrc(sbFname), title: tf("第 {n} 段 · ", { n: i + 1 }) + sbFname });
                }
                fillSegThumb(thumb, sbFname, clearStoryboard, () => Lightbox.open({ items: sbItems, index: sbItemIdx.get(sbFname) }),
                    hasSb ? undefined : t('清除该段首帧'));
            } else {
                thumb.classList.add('neo-director-setup-seg-thumb-empty');
                thumb.appendChild($el('span', { className: 'neo-director-setup-seg-thumb-hint', textContent: t('＋ 拖入 / 上传分镜图') }));
            }
            attachSegThumbUpload(thumb, row);   // 分镜图位支持直接拖入 / 上传（跳过宫格拆分）
            const promptCells = [$el('div', { className: 'neo-director-story-seg-prompt', textContent: row.querySelector('.neo-director-prompt').value || t('（未生成）') })];
            const item = $el('div', { className: 'neo-director-story-seg-item' }, [
                $el('div', { className: 'neo-director-story-seg-head' }, [
                    $el('span', { className: 'neo-director-story-seg-grip', textContent: '⠿', title: t('拖拽排序') }),
                    $el('span', { textContent: `#${i + 1}` }),
                    $el('span', { textContent: dur ? `${dur}s` : '' }),
                ]),
                $el('div', { className: 'neo-director-setup-seg-cols' }, [thumb, ...promptCells]),
            ]);
            item._segIdx = i;
            attachSegReorder(item);
            setupSegPreview.appendChild(item);
        });
        syncGhostSeg();   // 常驻空段：无分段或第一段已有输入时才显示；拖入分镜图才真实建段
    }

    // 故事板分镜页：band 0 角色参考图盒 → band 1 宫格图卡 + 模式提示 → band 2 各段对照
    // 「各段对照」标题行单独持有：单段配方整块收起（换成 setupSingleHint），段数一变就切
    const setupOptRow = $el('div', { className: 'neo-director-setup-opt' }, [
        stepOptBadge,   // ② 提示词：拆分到各段之后的最后一步
        $el('label', { className: 'neo-director-field-label neo-director-story-segs-title', textContent: t('各段对照（重新生成基于原文再试）') }),
        optStatus,
        optBtn,
    ]);
    const genPane = $el('div', { className: 'neo-director-pane neo-director-pane-story' }, [
        // band 0：角色参考图紧凑盒（标题 / 身份参考 / 素材库 + 网格都集成在盒内，配方级常驻，视频各段身份参考）
        $el('div', { className: 'neo-director-band neo-director-band-top' }, [charCard]),
        // band 1：宫格图故事板卡（① 拆分到各段）+ 生成模式提示（全参考 / 混合的素材到时间轴页逐段设置）
        $el('div', { className: 'neo-director-band' }, [srcGridCard, uniR2vHint, uniMixedHint]),
        // band 2：各段对照（分镜图 / 提示词两栏）
        $el('div', { className: 'neo-director-band neo-director-band-segs' }, [
            // 「各段对照」标题行：优化按钮 + 状态靠本行最右（列名见下方表头），不独占一行
            setupOptRow,
            setupSingleHint,   // 单段：多段对照没有意义，换成一行指引
            setupSegPreview,
        ]),
    ]);
    stepUiReady = true;    // 本页 DOM 齐了：此后各步徽标 / 按钮可用性都随内容实时刷新
    refreshSetupRefs();   // 按当前生成模式初始化模式提示显隐
    renderSetupSegs();    // 打开旧配方时回显各段当前内容


    // 单段提示词生成/修改：在时间线底部输入指令，对当前段按 H3 格式生成或修改（SSE 流式）
    // 提示词为空 → 新生成（director_panel_describe，需首帧图）；有内容 → 修改（director_modify_segment）
    const modTa = $el('textarea', { className: 'neo-director-mod-ta', placeholder: t('描述或修改当前段（如：俯拍城市夜景、加入雨声…）') });
    const modBtn = $el('button', { className: 'rs-btn neo-director-mod-btn', type: 'button', textContent: t('生成/修改') });
    const modStatus = $el('span', { className: 'neo-director-mod-status' });
    modBtn.onclick = async () => {
        const instruction = modTa.value.trim();
        const rows = Array.from(segsWrap.querySelectorAll('.neo-director-seg'));
        if (!rows.length) { app.extensionManager.toast.add({ severity: 'error', summary: t('提示词'), detail: t('还没有分段'), life: 3000 }); return; }
        const row = rows[currentSegIdx] || rows[0];
        const ta = row.querySelector('.neo-director-prompt');
        const curPrompt = (ta ? ta.value : '').trim();
        const durInp = row.querySelector('.neo-director-dur');
        const dur = Number(durInp && durInp.value) || 5;
        const g = modeSel ? modeSel.value : 'f2v';
        const segModeSel = row.querySelector('.neo-director-segmode');
        const effMode = (g === 'mixed' && segModeSel) ? segModeSel.value : g;
        modBtn.disabled = true; modStatus.textContent = curPrompt ? t('正在修改…') : t('正在生成…');
        try {
            let acc = '';
            let segErr = null;
            if (!curPrompt) {
                // 新生成：提示词为空 → 用首帧图调 director_panel_describe
                const ffReader = segFrameReaders.get(row);
                const panel = ffReader ? (ffReader.first() || '') : '';
                if (!panel) throw new Error(t('请为本段选择首帧图片'));
                await sseStream('/rs_recipes/director_describe_panel', {
                    onChunk: (parsed) => { acc += parsed.text || ''; ta.value = acc; },
                    onError: (msg) => { segErr = msg; },
                }, { panel, duration_sec: dur, panel_index: currentSegIdx + 1, panel_total: rows.length });
            } else {
                // 修改：提示词有内容 → 调 director_modify_segment
                const refs = {};
                (segRefReaders.get(row) || []).forEach((read, gi) => { const picked = read() || []; if (picked.length) refs[SEG_REF_GROUPS[gi].key] = picked; });
                await sseStream('/rs_recipes/director_modify_segment', {
                    onChunk: (parsed) => { acc += parsed.text || ''; ta.value = acc; },
                    onError: (msg) => { segErr = msg; },
                }, { prompt: curPrompt, instruction, duration_sec: dur, mode: effMode, refs: Object.keys(refs).length ? refs : undefined });
            }
            if (segErr) throw new Error(segErr);
            const finalText = acc.trim();
            if (!finalText) throw new Error(t('结果为空，请重试'));
            ta.value = finalText;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            modStatus.textContent = curPrompt ? t('已修改') : t('已生成');
            app.extensionManager.toast.add({ severity: 'success', summary: curPrompt ? t('提示词已修改') : t('提示词已生成'), detail: tf("第 {n} 段", { n: currentSegIdx + 1 }), life: 3000 });
            markDirty();
        } catch (e) {
            console.error('[Neo Recipes] Director modify segment failed:', e);
            modStatus.textContent = '';
            handleLLMError(t('提示词'), e.message);
        } finally { modBtn.disabled = false; }
    };
    const modRow = $el('div', { className: 'neo-director-mod-row' }, [
        modTa,
        $el('div', { className: 'neo-director-mod-actions' }, [modBtn, modStatus]),
    ]);

    // 单段引导：空白新建配方落在时间线页，一行指出「要拆多段去哪」；有内容 / 多段时自动收起
    const singleSegGuide = $el('div', { className: 'neo-director-single-guide' }, [
        $el('span', { textContent: t('只有一段：提示词写在下面的段落里即可。要从宫格图一次拆成多段？按故事主题生成分段，用右栏智能体。') }),
        $el('button', {
            className: 'neo-director-single-guide-btn', type: 'button', textContent: t('故事板分镜'),
            onclick: () => switchTab('story'),
        }),
    ]);
    const timelinePane = $el('div', { className: 'neo-director-pane neo-director-pane-timeline' }, [
        // 一行装下「各段怎么生成」：生成模式 / 统一技能 / 分块秒数 / 分辨率；
        // 整片运行参数（种子 / 步数 / 连续性 / 上下文帧）收进行尾「高级参数」，默认不占这一行
        $el('div', { className: 'neo-director-row neo-director-shared' }, [
            $el('label', { textContent: t('生成模式') }), modeSel,
            gSkillLabel, gSkillSel,   // 统一技能：紧邻生成模式（混合模式隐藏）
            chunkSecLabel, chunkSecInp,   // 分块秒数：多段 + 统一技能支持多帧时显示（refreshSegScale）
            $el('label', { textContent: t('宽高比') }), aspectSel,
            $el('label', { textContent: t('百万像素') }), mpInp,
            resOut,
            advWrap,
        ]),
        singleSegGuide,
        customRow,
        tlLabelRow,
        tlWrap,
        segsWrap,
        modRow,
    ]);

    // 段数一变就重算：单段配方只留「一段的时间线」，多段专属的两块（分块秒数 / 各段对照）自动让位
    refreshSegScale = () => {
        const single = segsWrap.querySelectorAll('.neo-director-seg').length === 1;
        refreshChunkSecVisibility();   // 内部已按段数判断（单段不分块）
        singleSegGuide.style.display = (single && !existing) ? '' : 'none';   // 只在空白新建时指路，编辑已有配方不啰嗦
        setupOptRow.style.display = single ? 'none' : '';
        setupSingleHint.style.display = single ? '' : 'none';
        setupSegPreview.style.display = single ? 'none' : '';
    };

    const tabStory = $el('button', { className: 'neo-director-tab', type: 'button', textContent: t('故事板分镜') });
    const tabTimeline = $el('button', { className: 'neo-director-tab', type: 'button', textContent: t('分镜时间线') });
    function switchTab(which) {
        tabStory.classList.toggle('active', which === 'story');
        tabTimeline.classList.toggle('active', which === 'timeline');
        genPane.style.display = (which === 'story') ? '' : 'none';
        timelinePane.style.display = (which === 'timeline') ? '' : 'none';
        const n = (nameInp.value || '').trim() || requestedName;
        if (n) lastTabByName.set(n, which);   // 记住当前页签：下次打开该配方落回此页
        if (which === 'story') renderSetupSegs();   // 切到故事板分镜页时刷新各段当前内容（含时间轴页的改动）
        else if (timeline) timeline.refresh();      // 切回时间轴时按真实宽度重绘 canvas
        refreshSegScale();   // 页签也影响块级显隐（单段引导 / 各段对照只在本页有意义）
    }
    tabStory.onclick = () => switchTab('story');
    tabTimeline.onclick = () => switchTab('timeline');
    const tabBar = $el('div', { className: 'neo-director-tabs' }, [tabStory, tabTimeline]);

    const body = $el('div', { className: 'neo-director-body' }, [genPane, timelinePane]);
    switchTab(lastTabByName.get(requestedName) || 'timeline'); // 优先落回上次打开时停的页签；新建默认时间线页——单段最简单的那条路，故事板分镜留给多段规划
    const foot = $el('div', { className: 'neo-director-foot' }, [cancelBtn, saveBtn]);
    // 桌面端内嵌：底部直接给一枚「保存并生成整片」，走完整保存路径后由宿主提交生成
    if (saveAndRun) foot.appendChild($el('button', { className: 'rs-btn neo-director-save-run', type: 'button', textContent: t('保存并生成整片'), onclick: () => { runAfterSave = true; saveBtn.onclick(); } }));
    // 「放大到最大」：标题栏 ⛶ 按钮 / 双击标题栏均可切换。放大=铺满视口（留 8px
    // 边距，高度受 CSS max-height:88vh 约束），还原=回到放大前几何。内嵌铺满容器，无窗口控件。
    let maximized = false;
    let prevRect = null;
    const maxBtn = embedded ? null : $el('button', { className: 'neo-director-maximize', type: 'button', title: t('放大到最大'), textContent: '⛶' });
    const toggleMaximize = () => {
        if (!maximized) {
            const r = panel.getBoundingClientRect();
            prevRect = { left: r.left, top: r.top, width: r.width, height: r.height };
            if (!panel.style.left) panel.style.position = 'absolute';
            panel.style.left = '8px';
            panel.style.top = '8px';
            panel.style.width = (window.innerWidth - 16) + 'px';
            panel.style.height = (window.innerHeight - 16) + 'px';
            maximized = true;
        } else {
            panel.style.left = prevRect.left + 'px';
            panel.style.top = prevRect.top + 'px';
            panel.style.width = prevRect.width + 'px';
            panel.style.height = prevRect.height + 'px';
            maximized = false;
            prevRect = null;
        }
        maxBtn.classList.toggle('neo-director-maximized', maximized);
        maxBtn.title = maximized ? t('还原窗口') : t('放大到最大');
    };
    if (maxBtn) maxBtn.onclick = toggleMaximize;

    const closeBtn = $el('button', { className: 'neo-director-close', textContent: '✕', onclick: requestClose });
    if (embedded) closeBtn.title = t('关闭编辑');
    const titleBar = $el('div', { className: 'neo-director-title' }, [
        $el('div', { className: 'neo-director-title-left' }, [
            $el('span', { textContent: t('分镜视频导演') }),
            nameWrap,
        ]),
        tabBar,
        $el('div', { className: 'neo-director-title-btns' }, [
            $el('button', { className: 'neo-director-llm-config', type: 'button', title: t('LLM 配置'), textContent: '', onclick: openLLMSettingsModal }),
            ...(maxBtn ? [maxBtn] : []),
            closeBtn,
        ]),
    ]);
    const resizeHandle = embedded ? null : $el('div', { className: 'neo-director-resize', title: t('拖拽调整窗口大小') });
    const panel = $el('div', { className: 'neo-director-panel' }, [titleBar, body, dirtyConfirm, foot, ...(resizeHandle ? [resizeHandle] : [])]);

    // 窗口内表单控件统一脏标记：数据字段（名称/提示词/时长/模式/分辨率…）的 input/change 都算未保存修改；
    // 拉伸滑块只是视图状态，排除。程序化写回（生成/拆分/优化/同步）不触发事件，由各自路径显式 markDirty。
    const isViewOnlyControl = (el) => !!(el && el.classList
        && (el.classList.contains('neo-director-zoom-slider') || el.closest('.neo-director-seg-regen-panel')));
    panel.addEventListener('input', (e) => { if (!isViewOnlyControl(e.target)) markDirty(); }, true);
    panel.addEventListener('change', (e) => { if (!isViewOnlyControl(e.target)) markDirty(); }, true);

    // 标题栏拖动：首次按下从 flex 居中切到绝对定位并记录起点，之后按鼠标位移更新 left/top；
    // 钳制保证窗口不会被拖出视口（始终留一条可点到的标题栏 / ✕）。
    let dragging = false;
    let startMX = 0, startMY = 0, startL = 0, startT = 0;
    const onTitleMove = (e) => {
        if (!dragging) return;
        let left = startL + (e.clientX - startMX);
        let top = startT + (e.clientY - startMY);
        const w = panel.offsetWidth;
        left = Math.max(-w + 80, Math.min(left, window.innerWidth - 80));
        top = Math.max(0, Math.min(top, window.innerHeight - 44));
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
    };
    const onTitleUp = () => {
        dragging = false;
        window.removeEventListener('mousemove', onTitleMove);
        window.removeEventListener('mouseup', onTitleUp);
    };
    if (!embedded) titleBar.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.closest('button') || e.target.closest('.neo-director-name-view, .neo-director-name')) return; // 仅按钮（⛶/✕/页签）与配方名输入/显示区不触发拖动，标题栏其余空白可拖窗口
        const r = panel.getBoundingClientRect();
        if (!panel.style.left) { // 首次：从居中切到绝对定位，无跳变
            panel.style.position = 'absolute';
            panel.style.left = r.left + 'px';
            panel.style.top = r.top + 'px';
        }
        startMX = e.clientX; startMY = e.clientY;
        startL = parseFloat(panel.style.left); startT = parseFloat(panel.style.top);
        dragging = true;
        window.addEventListener('mousemove', onTitleMove);
        window.addEventListener('mouseup', onTitleUp);
    });

    if (!embedded) titleBar.addEventListener('dblclick', (e) => {
        if (e.target.closest('button') || e.target.closest('.neo-director-name-view, .neo-director-name')) return; // 仅双击按钮（⛶/✕/页签）与配方名区不触发放大还原，其余空白可最大化
        toggleMaximize();
    });

    // 右下角手柄拖拽缩放：改面板 width/height（首次同样从居中切到绝对定位）；
    // 宽度下限保证内容不塌，上限钳制在视口内。时间轴经 ResizeObserver 自动跟随重排。
    let resizing = false;
    let rStartMX = 0, rStartMY = 0, rStartW = 0, rStartH = 0;
    const DT_MIN_W = 420, DT_MIN_H = 360; // 高度下限实际由 CSS .neo-director-panel min-height:480px 强制，此处仅兜底防负数
    const onResizeMove = (e) => {
        if (!resizing) return;
        let w = rStartW + (e.clientX - rStartMX);
        let h = rStartH + (e.clientY - rStartMY);
        w = Math.max(DT_MIN_W, Math.min(w, window.innerWidth - 16));
        h = Math.max(DT_MIN_H, Math.min(h, window.innerHeight - 16));
        panel.style.width = w + 'px';
        panel.style.height = h + 'px';
    };
    const onResizeUp = () => {
        resizing = false;
        window.removeEventListener('mousemove', onResizeMove);
        window.removeEventListener('mouseup', onResizeUp);
    };
    if (!embedded) resizeHandle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // 避免拖动时选中文字 / 图片
        if (!panel.style.left) { // 首次：从居中切到绝对定位，无跳变
            const r = panel.getBoundingClientRect();
            panel.style.position = 'absolute';
            panel.style.left = r.left + 'px';
            panel.style.top = r.top + 'px';
        }
        rStartMX = e.clientX; rStartMY = e.clientY;
        rStartW = panel.offsetWidth; rStartH = panel.offsetHeight;
        resizing = true;
        window.addEventListener('mousemove', onResizeMove);
        window.addEventListener('mouseup', onResizeUp);
    });
    if (embedded) {
        panel.classList.add('neo-director-embedded');
        host.appendChild(panel);
        overlay = panel;   // 内嵌时根节点就是面板本身：close() / 单例判定与浮层同源
    } else {
        overlay = $el('div', { className: 'neo-director-overlay' }, [panel]);
        document.body.appendChild(overlay);
    }
    _directorEditor = { name: requestedName, close, requestClose, isDirty: () => dirty, overlay, focusSeg: focusSegAt };
    opts?.onAdopt?.();   // 编辑器认下这份配方才回传选中：卡片高亮与上方生成区从此和编辑器同指一份配方
}
