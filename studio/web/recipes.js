/**
 * recipes.js — Neo Studio 配方模块
 * 配方 = 提示词 + 有序多资产(图/视频/音频)。负责：
 *   - 从当前工作流收集资源 (LoadImage / LoadVideo / LoadAudio) 供「保存配方」
 *   - 调用后端 /rs_recipes/* API
 *   - 侧边栏「配方」面板：列表 + 一键发送到工作流
 */
import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { $el } from "../../../../scripts/ui.js";
import { Lightbox } from "./lightbox.js";
import { openDirectorEditor, MODE_LABELS, LEGACY_MODE_MAP } from "./director.js";
import { skillDisplayName } from "./skill.js";
import { t, tf } from "./js/core/i18n.js";
import { icon } from "./js/core/icons.js";

const assetUrl = (recipe, file, dir) =>
    `${window.location.protocol}//${window.location.host}/rs_recipes/asset?recipe=${encodeURIComponent(recipe)}&file=${encodeURIComponent(file)}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`;

/** 封面/网格缩略图 URL：后端按需生成并缓存 JPEG（卡片 112，详情网格 256）。 */
export function thumbUrl(recipe, file, dir, size) {
    return `${window.location.protocol}//${window.location.host}/rs_recipes/thumbnail?recipe=${encodeURIComponent(recipe)}&file=${encodeURIComponent(file)}&size=${size}${dir ? `&dir=${encodeURIComponent(dir)}` : ''}`;
}

// 配方筛选/排序选项（面板工具条）
const RECIPE_FILTERS = [
    { id: 'all', label: t('全部') },
    { id: 'normal', label: t('普通'), title: t('不含多段导演与内置预设') },
    { id: 'director', label: t('多段'), title: t('多段导演配方') },
    { id: 'mine', label: t('我的'), title: t('我自己保存/导入的配方') },
    { id: 'preset', label: t('预设'), title: t('内置预设配方') },
];
const RECIPE_SORTS = [
    { id: 'mtime', label: t('最近修改') },
    { id: 'name', label: t('名称') },
    { id: 'results', label: t('有结果优先') },
];

// 配方结果（results）指向 output 目录里的真实产物，直接走 ComfyUI 原生 /view 读取
const outputUrl = (r) =>
    `/view?filename=${encodeURIComponent(r.filename)}&subfolder=${encodeURIComponent(r.subfolder || '')}&type=output`;

// 配方统一立方体图标：侧边栏标题、保存弹窗按钮、预设列表条目共用
export const RECIPE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';

// ==========================================
// 从工作流收集资源
// ==========================================

const GRID_REF_MAX = 12;   // NeoRefGrid 宫格槽位上限（运行时可调 1~12，与 ref_grid.GRID_MAX 一致）

/** 把 widget 值规范成 Comfy 文件引用 {filename, subfolder, type}；无法解析返回 null。
 * 兼容对象 / ["name","sub","type"] 数组 / 字符串（含 [input]/[output]/[temp] 注解）。 */
export function widgetValueToRef(v) {
    if (!v) return null;
    if (typeof v === 'object' && v.filename) {
        return { filename: v.filename, subfolder: v.subfolder || '', type: v.type || 'input' };
    }
    if (Array.isArray(v)) {
        const [filename, subfolder, type] = v;
        if (filename) return { filename, subfolder: subfolder || '', type: type || 'input' };
        return null;
    }
    if (typeof v === 'string' && v.trim()) {
        let s = v.trim();
        let type = 'input';
        const m = s.match(/^(.*?)\s*\[(input|output|temp)\]$/i);
        if (m) { s = m[1].trim(); type = m[2].toLowerCase(); }
        let filename = s, subfolder = '';
        const idx = s.lastIndexOf('/');
        if (idx > 0) { subfolder = s.slice(0, idx); filename = s.slice(idx + 1); }
        if (filename) return { filename, subfolder, type };
    }
    return null;
}

/** 是否禁用节点：跳过 Mute/Never(mode 2) 与 Bypass(mode 4)。 */
function isNodeDisabled(n) {
    return n.mode === 2 || n.mode === 4;
}

function buildLinkMap(serializedLinks) {
    const linkMap = new Map();
    if (Array.isArray(serializedLinks)) {
        for (const l of serializedLinks) {
            // [id, origin_id, origin_slot, target_id, target_slot, type]
            if (Array.isArray(l)) linkMap.set(String(l[0]), { origin_id: l[1], target_id: l[3], target_slot: l[4] });
        }
    } else {
        const gl = app.graph?.links;
        const iter = gl && typeof gl.forEach === 'function' ? gl : Object.values(gl || {});
        iter.forEach(l => {
            if (l && l.target_id != null) linkMap.set(String(l.id), { origin_id: l.origin_id, target_id: l.target_id, target_slot: l.target_slot });
        });
    }
    return linkMap;
}

/** 连通子图：把画布连线当无向边做并查集，返回 nodeId -> 子图根 nodeId。
 * 同一画布上互不相连的多张工作流图各自成一个子图；disable 节点仍作桥接参与划分。 */
function buildComponents(nodes, linkMap) {
    const parent = new Map(nodes.map(n => [String(n.id), String(n.id)]));
    const find = (x) => {
        let root = x;
        while (parent.get(root) !== root) root = parent.get(root);
        while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
        return root;
    };
    for (const link of linkMap.values()) {
        const a = String(link.origin_id), b = String(link.target_id);
        if (!parent.has(a) || !parent.has(b)) continue;
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
    }
    for (const id of parent.keys()) find(id);
    return parent;
}

// 节点的媒体输出连到目标节点指定类型输入槽的参数序号（1-based）；无连线返回 null
// 同时返回 targetId（连到的下游目标节点 id），供还原端「同目标节点的分组/计数」
function computeSlotNo(n, slotType, linkMap, nodeById) {
    for (const o of n.outputs || []) {
        const lids = Array.isArray(o.links) ? o.links : (o.link != null ? [o.link] : []);
        for (const lid of lids) {
            const link = linkMap.get(String(lid));
            if (!link) continue;
            const target = nodeById.get(String(link.target_id));
            if (!target) continue;
            let count = 0;
            const slotIdx = Number(link.target_slot) || 0;
            for (let i = 0; i < (target.inputs || []).length; i++) {
                if (String(target.inputs[i].type).toUpperCase() !== slotType) continue;
                count++;
                if (i === slotIdx) return { slot: count, targetId: String(link.target_id) };
            }
        }
    }
    return null;
}

/** 找到 Load 节点上承载媒体文件引用的 widget（优先按名称匹配，退化为第一个像媒体引用的值）。 */
function findMediaWidget(n, kind) {
    const namePat = kind === 'video' ? /video/i : kind === 'audio' ? /audio|upload/i : /image|upload/i;
    let found = null;
    for (const w of n.widgets || []) {
        const v = w.value;
        const shaped = (typeof v === 'string' && v) || (Array.isArray(v) && v.length) ||
            (v && typeof v === 'object' && (v.filename || v.name));
        if (namePat.test(w.name || '')) {
            if (shaped || w.type === 'combo') return w;
            if (!found) found = w;
        } else if (!found && shaped) {
            found = w;
        }
    }
    return found;
}

function findMediaValueFromWidgetsValues(widgetsValues) {
    for (const entry of widgetsValues || []) {
        if (typeof entry === 'string' || Array.isArray(entry)) return entry;
        if (entry && typeof entry === 'object' && (entry.name || entry.filename)) return entry;
    }
    return null;
}

/**
 * 扫描工作流中的 LoadImage / LoadVideo / LoadAudio 节点，保存与还原共用同一编码规则：
 *   - 跳过禁用（BYPASS/NEVER）状态的节点；
 *   - 用 graphToPrompt 序列化连线，计算输出连到目标节点 IMAGE/VIDEO/AUDIO 输入槽的
 *     参数序号（1-based）与目标节点 id，未连线为 null；
 *   - 返回 { media, comps, sizes, disabledConn }：media 元素为
 *     { node, live, widget, value, kind, slot, targetId }，widget 是活动节点上
 *     可写的媒体 widget；comps 为 nodeId -> 连通子图根 nodeId，sizes 为子图根 ->
 *     节点数（含禁用节点）；disabledConn 为「已连线但被禁用的 Load 节点」，
 *     用于还原端补齐资产时的自动 enable 对齐。
 */
export async function scanMediaNodes() {
    let nodes = null;
    let serializedLinks = null;
    if (typeof app?.graphToPrompt === 'function') {
        try {
            const prompt = await app.graphToPrompt();
            nodes = prompt?.workflow?.nodes || null;
            serializedLinks = prompt?.workflow?.links || null;
        } catch (e) {
            console.warn('[Neo Recipes] graphToPrompt:', e);
        }
    }
    if (!Array.isArray(nodes)) nodes = app.graph?._nodes || [];
    const linkMap = buildLinkMap(serializedLinks);
    const comps = buildComponents(nodes, linkMap);
    const sizes = new Map();
    for (const n of nodes) {
        const root = comps.get(String(n.id));
        sizes.set(root, (sizes.get(root) || 0) + 1);
    }
    const nodeById = new Map(nodes.map(n => [String(n.id), n]));
    const liveById = new Map((app.graph?._nodes || []).map(n => [String(n.id), n]));

    const media = [];
    const disabledConn = [];
    for (const n of nodes) {
        const cls = String(n.comfyClass || n.type || '');
        const isLoadImage = /load.?image/i.test(cls);
        const isLoadVideo = /load.?video/i.test(cls);
        const isLoadAudio = /load.?audio/i.test(cls);
        if (!isLoadImage && !isLoadVideo && !isLoadAudio) continue;
        const kind = isLoadVideo ? 'video' : isLoadAudio ? 'audio' : 'image';
        const live = liveById.get(String(n.id)) || null;
        const widget = live ? findMediaWidget(live, kind) : null;
        const value = widget ? widget.value : findMediaValueFromWidgetsValues(n.widgets_values);
        const slotInfo = computeSlotNo(n, kind.toUpperCase(), linkMap, nodeById);
        const slot = slotInfo?.slot ?? null;
        const targetId = slotInfo?.targetId ?? null;
        if (isNodeDisabled(n)) {
            if (slot != null && live) disabledConn.push({ node: n, live, widget, kind, slot, targetId });
        } else {
            media.push({ node: n, live, widget, value, kind, slot, targetId });
        }
    }
    return { media, comps, sizes, disabledConn };
}

/**
 * 扫描工作流，收集媒体文件引用（保存用）。与还原共用 scanMediaNodes 的编码规则：
 * 只收集 anchorNode（当前 Neo Prompt 节点）所在连通子图内、输出已连线的资源，
 * 图片组按参数序号在前、视频、音频组在后；其他子图与未连线节点一律不保存。
 */
export async function collectWorkflowAssets(anchorNode) {
    const { media: scanned, comps } = await scanMediaNodes();
    const root = anchorNode ? comps.get(String(anchorNode.id)) : null;
    // 参考图宫格节点（NeoRefGrid）：宫格槽位是主参考集，排在连线 LoadImage 之前收集（鸭子类型 _neoRg API）
    const gridAssets = [];
    for (const n of app.graph?._nodes || []) {
        if (!n._neoRg?.getAssets || isNodeDisabled(n)) continue;
        if (root != null && comps.get(String(n.id)) !== root) continue;
        for (const name of n._neoRg.getAssets()) gridAssets.push({ filename: name, subfolder: '', type: 'input', kind: 'image' });
    }
    const pick = (kind) => scanned
        .filter(s => s.kind === kind && s.slot != null && comps.get(String(s.node.id)) === root)
        .sort((a, b) => a.slot - b.slot)
        .map(s => {
            // kind 来自加载节点类型（LoadImage/LoadVideo/LoadAudio）：mp4 等文件可能
            // 作为音频使用，后端不能用后缀反推，故随 ref 一并传给配方记录
            const ref = widgetValueToRef(s.value);
            return ref ? { ...ref, kind: s.kind } : null;
        })
        .filter(Boolean);
    // 保存时后端按此顺序写入配方 assets，还原时按同规则反解即可落回原参数位置
    return [...gridAssets, ...pick('image'), ...pick('video'), ...pick('audio')];
}

/** 扫描工作流，收集 LoRA Loader 节点（保存用）：只收 anchorNode 所在连通子图内、
 *  未禁用的 LoRA 加载节点，返回 [{name, strength}]。strength 取 strength_model，
 *  缺失时退化为 strength_clip，再缺失为 1.0。 */
export async function collectWorkflowLoras(anchorNode) {
    const { comps } = await scanMediaNodes();
    const root = anchorNode ? comps.get(String(anchorNode.id)) : null;
    const loras = [];
    for (const n of app.graph?._nodes || []) {
        const cls = String(n.comfyClass || n.type || '');
        if (!/lora/i.test(cls) || isNodeDisabled(n)) continue;
        if (root && comps.get(String(n.id)) !== root) continue;
        const widgets = n.widgets || [];
        let name = null;
        for (const w of widgets) {
            if (/lora.?name/i.test(w.name || '')) { name = w.value; break; }
        }
        if (name == null) {
            const cw = widgets.find(x => x.type === 'combo') || widgets.find(x => typeof x.value === 'string' && x.value);
            name = cw ? cw.value : null;
        }
        if (typeof name !== 'string' || !name) continue;
        const sm = widgets.find(x => /strength.?model/i.test(x.name || ''));
        const sc = widgets.find(x => /strength.?clip/i.test(x.name || ''));
        let strength = 1.0;
        if (sm && typeof sm.value === 'number' && Number.isFinite(sm.value)) strength = sm.value;
        else if (sc && typeof sc.value === 'number' && Number.isFinite(sc.value)) strength = sc.value;
        loras.push({ name, strength });
    }
    return loras;
}

/** 是否为“结果输出”节点：只有这类节点产生的结果才应存入 samples。
 *  排除 load 类与输入类（LoadImage 的输出是输入资产而非执行结果）。
 *  按 comfyClass 特征匹配：save / preview / output / combine / vhs / audio 等。 */
function isOutputNode(n) {
    const cls = String(n.comfyClass || n.type || '');
    // 明确的输入/加载类或中间节点（不产生“结果”）
    if (/^(load_|load[A-Z0-9])/i.test(cls) || /load.?image|load.?video|load.?audio|load.?latent/im.test(cls)) return false;
    if (/\b(input|load)\b/i.test(cls)) return false;
    // 只认可明确的结果输出节点
    return /(save|preview|output|combine|vhs|videohelper|audio|result|export|download|upload|animate)/i.test(cls);
}

/** 计算每个节点的最长路径深度（拓扑执行序的深度）。输出节点结果将只保留深度最大者 =
 *  最终结果；中间结果节点（被后续节点继续消费/继续输出的）会被忽略。
 *  以节点 id 为键返回 Map。 */
function computeNodeDepths(nodes, linkMap) {
    const byId = new Map(nodes.map(n => [String(n.id), n]));
    const memo = new Map();
    const visiting = new Set();
    const depthOf = (id) => {
        if (memo.has(id)) return memo.get(id);
        if (visiting.has(id)) return 0; // 环保护：不计入深度
        visiting.add(id);
        let d = 0;
        for (const link of linkMap.values()) {
            if (String(link.target_id) !== id) continue;
            const oid = String(link.origin_id);
            if (byId.has(oid)) d = Math.max(d, depthOf(oid) + 1);
        }
        visiting.delete(id);
        memo.set(id, d);
        return d;
    };
    const depths = new Map();
    for (const n of nodes) depths.set(String(n.id), depthOf(String(n.id)));
    return depths;
}

/** 收集当前画布最近一次执行的输出（app.nodeOutputs），kind 按输出节点类型判定。
 *  只收确实落在 Comfy output 目录的结果（img.type === 'output'）：LoadImage 等输入
 *  节点的缓存 type 为 input（读入的图片是输入资产而非执行结果），天然被排除。
 *  只保留拓扑执行序最末端的输出节点结果（最终结果）；中间结果（被后续继续处理的）忽略。 */
export function collectWorkflowResults() {
    const outputs = app.nodeOutputs || {};
    const nodes = app.graph?._nodes || [];
    const linkMap = buildLinkMap();
    const depths = computeNodeDepths(nodes, linkMap);

    let maxDepth = -1;
    const outNodes = [];
    for (const n of nodes) {
        if (!isOutputNode(n)) continue;
        const images = outputs[String(n.id)]?.images;
        if (!Array.isArray(images) || !images.length) continue;
        const d = depths.get(String(n.id)) ?? 0;
        outNodes.push({ n, d });
        if (d > maxDepth) maxDepth = d;
    }
    // 只保留深度最大（最终）的输出节点集合
    const finals = outNodes.filter(x => x.d === maxDepth);

    const results = [];
    for (const { n } of finals) {
        const images = outputs[String(n.id)]?.images;
        if (!Array.isArray(images) || !images.length) continue;
        const cls = String(n.comfyClass || n.type || '');
        // kind 按输出节点类型判定：audio 类独有 → 音频；其余含 video/combine 特征 → 视频；否则图片
        const kind = /(saveaudio|audio)/i.test(cls) ? 'audio'
            : /video|combine|animate/i.test(cls) ? 'video'
                : 'image';
        for (const img of images) {
            if (!img || !img.filename || img.type !== 'output') continue; // 只收 output 目录产物
            results.push({ filename: img.filename, subfolder: img.subfolder || '', type: 'output', kind });
        }
    }
    return results;
}

// ==========================================
// 后端 API
// ==========================================

/** 读回配方示例内嵌的 ComfyUI 工作流/提示词（后端从媒体元数据解析）；请求失败抛出。 */
async function fetchSampleWorkflow(recipeName, sampleFile) {
    const resp = await api.fetchApi(`/rs_recipes/workflow?recipe=${encodeURIComponent(recipeName)}&file=${encodeURIComponent(sampleFile)}`);
    if (!resp.ok) throw new Error(`workflow fetch ${resp.status}`);
    return resp.json();
}

/** 把示例内嵌的工作流（或 API 提示词）加载到画布；无备份时报提示。返回是否成功。 */
async function copySampleWorkflowToCanvas(recipeName, sampleFile) {
    try {
        const meta = await fetchSampleWorkflow(recipeName, sampleFile);
        const wf = meta?.workflow;
        const prompt = meta?.prompt;
        if (wf && Array.isArray(wf.nodes)) {
            await app.loadGraphData(wf, true, true, tf("{name} · 工作流备份", { name: recipeName }));
        } else if (prompt && typeof app.loadApiJson === 'function') {
            await app.loadApiJson(prompt, recipeName);
        } else {
            app.extensionManager.toast.add({ severity: 'info', summary: t('无工作流备份'), detail: t('该示例未内嵌工作流'), life: 4000 });
            return false;
        }
        app.extensionManager.toast.add({ severity: 'success', summary: t('工作流已复制'), detail: tf("已加载 {name} 的工作流", { name: recipeName }), life: 4000 });
        return true;
    } catch (err) {
        console.error('[Neo Recipes] Copy workflow failed:', err);
        app.extensionManager.toast.add({ severity: 'error', summary: t('复制工作流失败'), detail: err.message, life: 4000 });
        return false;
    }
}

export async function saveRecipe(name, prompt, assets, results = [], loras = [], director = null, genType = "") {
    const body = { name, prompt, assets, results, loras };
    if (genType) body.gen_type = genType;
    if (director && director.segments) {
        body.type = 'video_director';
        body.shared = director.shared || {};
        body.segments = director.segments;
        if (director.story) body.story = director.story; // 自动故事板内容（可选），后端落盘并随列表回读
        if (director.setup) body.setup = director.setup; // 统一设置区状态（可选）：统一参考/首帧/尾帧，重新打开时回显
    }
    const resp = await api.fetchApi('/rs_recipes/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return resp.json();
}

/** 列出可用于视频生成的 skill（gen_video），供多段导演每段选择模板。 */
export async function listVideoSkills() {
    try {
        const res = await fetch('/rs_prompts/skills');
        const all = await res.json();
        return Array.isArray(all) ? all.filter(s => s && s.gen_video) : [];
    } catch (e) {
        return [];
    }
}

/** 导演配方概览行：段数 · 模式 · 技能 · 宽×高 · 总时长。skills 用于 skill_id → 名称映射（未取到时按 id 显示）。 */
export function directorMetaText(r, skills) {
    const shared = r.shared || {};
    const segs = r.segments || [];
    const nameOf = new Map(skills.map(s => [s.id, skillDisplayName(s)]));
    const modeText = (shared.mode && MODE_LABELS.get(LEGACY_MODE_MAP.get(shared.mode) || shared.mode)) || t('自动');
    const skillCounts = new Map();
    for (const s of segs) {
        const sid = s.skill_id || '';
        if (sid) skillCounts.set(sid, (skillCounts.get(sid) || 0) + 1);
    }
    const skillText = [...skillCounts.entries()]
        .map(([sid, n]) => `${nameOf.get(sid) || sid}${n > 1 ? ` ×${n}` : ''}`)
        .join('、');
    const total = segs.reduce((sum, s) => sum + (Number(s.duration_sec) || 0), 0);
    return [
        tf("{n} 段", { n: segs.length }),
        modeText,
        skillText || '—',
        shared.width && shared.height ? `${shared.width}×${shared.height}` : '',
        total > 0 ? tf("总时长 {t}s", { t: Number.isInteger(total) ? total : total.toFixed(1) }) : '',
    ].filter(Boolean).join(' · ');
}

export async function appendResultsToRecipe(name, results) {
    const resp = await api.fetchApi('/rs_recipes/append_results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, results })
    });
    return resp.json();
}

export async function deleteRecipeSample(name, file) {
    const resp = await api.fetchApi('/rs_recipes/delete_sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, file })
    });
    return resp.json();
}

/** 把执行产物（output 目录）的路径记进配方 results；导演节点跑完自动调用。 */
export async function addRecipeResults(name, results) {
    const resp = await api.fetchApi('/rs_recipes/add_results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, results })
    });
    return resp.json();
}

/** 从配方结果里删掉一条，并删除 output 目录里的真实文件（前端先 confirm）。 */
export async function deleteRecipeResult(name, ref) {
    const resp = await api.fetchApi('/rs_recipes/delete_result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, filename: ref.filename, subfolder: ref.subfolder || '', kind: ref.kind || '' })
    });
    return resp.json();
}

export async function listRecipes() {
    const resp = await api.fetchApi('/rs_recipes/list', { method: 'POST' });
    return resp.ok ? resp.json() : [];
}

export async function deleteRecipe(name) {
    const resp = await api.fetchApi('/rs_recipes/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    return resp.json();
}

export async function copyRecipe(name) {
    const resp = await api.fetchApi('/rs_recipes/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    return resp.json();
}

export async function sendRecipeToWorkflow(name) {
    const resp = await api.fetchApi('/rs_recipes/send_to_workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    return resp.json();
}

// ==========================================
// 一键发送到工作流
// ==========================================

/** 子图在下拉选项里的说明文案。 */
function describeSubgraph(index, stat, size) {
    const parts = [];
    if (stat.image.length) parts.push(tf("图片×{n}", { n: stat.image.length }));
    if (stat.video.length) parts.push(tf("视频×{n}", { n: stat.video.length }));
    if (stat.audio.length) parts.push(tf("音频×{n}", { n: stat.audio.length }));
    parts.push(stat.prompt ? t('含 Neo Prompt') : t('无 Neo Prompt'));
    return tf("子图 {i}（{parts} · {size} 节点）", { i: index, parts: parts.join(' · '), size });
}

/** 多个子图并列匹配或数量不匹配时，弹下拉让用户指定还原到哪个子图；取消返回 null。 */
function chooseSubgraphDialog(options) {
    return new Promise(resolve => {
        const select = $el('select', { className: 'neo-recipes-subgraph-select' });
        for (const o of options) select.appendChild($el('option', { value: o.value, textContent: o.label }));
        const close = (value) => { overlay.remove(); resolve(value); };
        const body = $el('div', { className: 'neo-recipes-detail-body neo-recipes-subgraph-body' }, [
            $el('div', { className: 'neo-recipes-detail-name', textContent: t('请选择还原到的子图') }),
            $el('div', { className: 'neo-recipes-detail-prompt', textContent: t('配方只还原到同一个子图。当前画布存在多个互不相连的子图，请指定目标：') }),
            select,
            $el('div', { className: 'neo-recipes-detail-foot' }, [
                $el('button', { className: 'rs-btn neo-recipes-detail-close', textContent: t('取消'), onclick: () => close(null) }),
                $el('button', { className: 'rs-btn neo-recipes-detail-send', textContent: t('✈还原到该子图'), onclick: () => close(select.value) }),
            ]),
        ]);
        const overlay = $el('div', { className: 'neo-recipes-detail' }, [body]);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        document.body.appendChild(overlay);
    });
}


function setWidgetValue(target, filename) {
    const { widget } = target;
    if (widget.type === 'combo') {
        widget.value = filename;
        if (widget.callback) widget.callback(filename);
    } else {
        widget.value = { filename, subfolder: '', type: 'input' };
    }
    if (target.node.onWidgetChanged) {
        try { target.node.onWidgetChanged(widget.name, widget.value); } catch (e) { /* 忽略 */ }
    }
    target.node.graph?.setDirtyCanvas(true, true);
}

/**
 * 还原前的自动对齐：当配方资产数与目标子图内已启用的 conn Load 节点数不一致时：
 *   - 资产偏多：按参数位升序启用子图内已连线但被禁用（BYPASS/Never）的同类节点补齐，
 *     能补多少补多少，仍不足的部分由还原流程按缺额提示；
 *   - 资产偏少：若该类启用节点全部连到同一个下游目标节点（参数位可比），按参数位降序
 *     把多余的启用节点设为 BYPASS（保留参数位靠前的参与还原）。
 * 约束：仅影响目标子图内的同类 conn Load 节点。
 * @returns {Promise<boolean>} 是否改动过节点 mode（调用方据此重扫刷新统计）
 */
async function autoToggleByTarget(targetRoot, want, disabledConn, scanned, comps) {
    let toggled = false;
    for (const kind of ['image', 'video', 'audio']) {
        if (!want[kind]) continue;
        const need = want[kind];
        const enabled = scanned.filter(s => s.slot != null && s.widget && !isNodeDisabled(s.node) && comps.get(String(s.node.id)) === targetRoot && s.kind === kind);
        if (enabled.length === need) continue;

        if (enabled.length < need) {
            // 缺：按参数位升序启用已连线但被禁用的同类节点补齐，能补多少补多少
            let short = need - enabled.length;
            const disabled = disabledConn
                .filter(d => comps.get(String(d.node.id)) === targetRoot && d.kind === kind && d.widget)
                .sort((a, b) => a.slot - b.slot);
            for (const d of disabled) {
                if (short <= 0) break;
                if (!d.live || !isNodeDisabled(d.live)) continue;
                d.live.mode = 0; // 启用
                d.live.graph?.setDirtyCanvas(true, true);
                short--;
                toggled = true;
            }
            continue;
        }

        // 多：启用节点按 targetId 分组，要求全部连到同一个下游目标节点（参数位可比），
        // 按 slot 降序把多余的启用节点设为 Bypass，保留参数位靠前的参与还原
        const byTarget = new Map();
        for (const s of enabled) {
            const list = byTarget.get(s.targetId);
            if (list) list.push(s); else byTarget.set(s.targetId, [s]);
        }
        if (byTarget.size !== 1) continue; // 多个目标节点 → 该类不裁剪
        const [enabledNodes] = byTarget.values();
        enabledNodes.sort((a, b) => a.slot - b.slot);
        for (let i = enabledNodes.length - 1; i >= need; i--) {
            const s = enabledNodes[i];
            if (!s.live || isNodeDisabled(s.live)) continue;
            s.live.mode = 4; // Bypass（Ctrl+B，半透明）；mode 2 是 Mute/Never（深色）
            s.live.graph?.setDirtyCanvas(true, true);
            toggled = true;
        }
    }
    return toggled;
}

/** 一键发送：与保存时的编码规则互逆，把资产还原到原参数位置，禁用节点不参与。
 *  资产与提示词只写进同一个连通子图：节点内预设入口（fillPrompt=false）以 anchorNode
 *  所在子图为准（同样先做自动对齐，全程不弹窗）；侧边栏入口找「资源数与连线 Load
 *  节点数一致（且含 Neo Prompt）」的子图，
 *  唯一匹配或画布仅一张子图时直接还原（数量差异由自动对齐补齐），多张子图无匹配或
 *  并列时弹下拉由用户指定；整体禁用的子图不参与，容纳不下的部分提示只还原了部分。 */
export async function applyRecipeToWorkflow(recipe, { fillPrompt = true, anchorNode = null } = {}) {
    const result = await sendRecipeToWorkflow(recipe.name);
    if (!result.success) {
        app.extensionManager.toast.add({ severity: 'error', summary: t('发送失败'), detail: result.error, life: 4000 });
        return false;
    }

    let { media: scanned, comps, sizes, disabledConn } = await scanMediaNodes();
    // 按子图统计可用还原目标：已连线的 Load 节点（按类型分开）与可写的 Neo Prompt；未连线节点不参与
    const statByRoot = new Map();
    const statOf = (root) => {
        let stat = statByRoot.get(root);
        if (!stat) statByRoot.set(root, stat = { image: [], video: [], audio: [], prompt: false });
        return stat;
    };
    for (const s of scanned) {
        if (s.slot == null || !s.widget) continue;
        const root = comps.get(String(s.node.id));
        if (root != null) statOf(root)[s.kind].push(s);
    }
    const promptNodes = (app.graph?._nodes || [])
        .filter(n => n._rsPromptUIElements?.customTextarea && !isNodeDisabled(n))
        .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    for (const n of promptNodes) {
        const root = comps.get(String(n.id));
        if (root != null) statOf(root).prompt = true;
    }
    // 参考图宫格节点（NeoRefGrid）：宫格槽位可容纳最多 GRID_REF_MAX 张图，
    // 还原时先填宫格、其余再进 LoadImage（鸭子类型 _neoRg API）
    const gridByRoot = new Map();
    for (const n of app.graph?._nodes || []) {
        if (!n._neoRg?.setAssets || isNodeDisabled(n)) continue;
        const root = comps.get(String(n.id));
        if (root != null && !gridByRoot.has(root)) gridByRoot.set(root, n);
    }
    // 纯宫格子图（无任何 Load 节点）也要进候选：占位一条空 stat，容量由 gridCap 表达
    for (const root of gridByRoot.keys()) statOf(root);

    // 选定目标子图：anchorNode 直接指定；否则按数量一致性精确匹配
    let target = null;
    const want = { image: 0, video: 0, audio: 0 };
    for (const a of result.assets) if (want[a.kind] != null) want[a.kind]++;

    if (anchorNode) {
        const root = comps.get(String(anchorNode.id));
        if (root != null) target = { root, stat: statOf(root) };
    } else {
        const needPrompt = fillPrompt && !!recipe.prompt;
        const candidates = [...statByRoot.keys()]
            .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
            .map(root => ({ root, stat: statByRoot.get(root), size: sizes.get(root) || 0, gridCap: gridByRoot.has(root) ? GRID_REF_MAX : 0 }));
        // 图片按区间匹配：有宫格的子图可容纳 stat.image.length ~ +gridCap 张（宫格先吸收）；无宫格退化为精确相等
        const matched = candidates.filter(({ stat, gridCap }) =>
            want.image >= stat.image.length && want.image <= stat.image.length + gridCap
            && stat.video.length === want.video && stat.audio.length === want.audio && (!needPrompt || stat.prompt));
        if (matched.length === 1) {
            target = matched[0];
        } else if (!candidates.length) {
            app.extensionManager.toast.add({ severity: 'info', summary: t('配方已发送'), detail: tf("{name}：工作流程中无可匹配的子图，未还原", { name: recipe.name }), life: 4000 });
            return true;
        } else if (candidates.length === 1) {
            // 画布上只有一张工作流图：无需确认，数量差异交给下面的自动对齐
            target = candidates[0];
        } else {
            // 数量对不上或多个子图并列：由用户在下拉中指定目标子图，取消则不动工作流
            const options = (matched.length ? matched : candidates).map(({ root, stat, size }, i) => ({
                value: root,
                label: describeSubgraph(i + 1, stat, size),
            }));
            const picked = await chooseSubgraphDialog(options);
            if (picked == null) return false;
            target = { root: picked, stat: statByRoot.get(picked) };
        }
    }

    // 先填宫格：把最多 GRID_REF_MAX 张图片资产填入 NeoRefGrid 宫格槽位（主参考集），
    // 并从剩余 LoadImage 目标数中扣除（须在 autoToggleByTarget 之前，对齐逻辑按扣除后的 want 启/禁用 Load 节点）
    let gridFilled = 0;
    if (target && want.image > 0) {
        const gridNode = gridByRoot.get(target.root);
        if (gridNode) {
            gridFilled = Math.min(GRID_REF_MAX, want.image);
            gridNode._neoRg.setAssets(result.assets.filter(a => a.kind === 'image').slice(0, gridFilled).map(a => a.file));
            want.image -= gridFilled;
        }
    }

    // 自动对齐：资产数与该子图 conn Load 节点数不一致时，按同目标节点启/禁用补齐或裁剪
    // （节点内入口与侧边栏入口均适用，全程不弹窗）
    if (target) {
        const toggled = await autoToggleByTarget(target.root, want, disabledConn, scanned, comps);
        if (toggled) {
            // 重新扫描以获取更新后的节点状态
            const { media: rescanned, comps: recomp } = await scanMediaNodes();
            const rescanStatByRoot = new Map();
            const rescanStatOf = (root) => {
                let stat = rescanStatByRoot.get(root);
                if (!stat) rescanStatByRoot.set(root, stat = { image: [], video: [], audio: [], prompt: false });
                return stat;
            };
            for (const s of rescanned) {
                if (s.slot == null || !s.widget) continue;
                const root = recomp.get(String(s.node.id));
                if (root != null) rescanStatOf(root)[s.kind].push(s);
            }
            for (const n of promptNodes) {
                const root = recomp.get(String(n.id));
                if (root != null) rescanStatOf(root).prompt = true;
            }
            target.stat = rescanStatOf(target.root);
            comps = recomp; // 更新 comps 用于后续 Neo Prompt 查找
        }
    }

    // 只还原到选定子图：连线节点按参数位升序与配方资产逐一配对（已填入宫格的前 gridFilled 张图跳过）
    let applied = 0, missing = 0;
    let gridSkipped = 0;
    for (const kind of ['image', 'video', 'audio']) {
        const slots = target ? target.stat[kind] : [];
        slots.sort((a, b) => a.slot - b.slot);
        let si = 0;
        for (const asset of result.assets) {
            if (asset.kind !== kind) continue;
            if (kind === 'image' && gridSkipped < gridFilled) { gridSkipped++; continue; }
            const t = si < slots.length ? slots[si++] : null;
            if (!t) { missing++; continue; }
            setWidgetValue({ node: t.live, widget: t.widget }, asset.file);
            applied++;
        }
    }

    const wantPrompt = fillPrompt && !!recipe.prompt;
    let promptApplied = false;
    if (wantPrompt && target?.stat.prompt) {
        const promptNode = promptNodes.find(n => comps.get(String(n.id)) === target.root);
        const { customTextarea, textWidget } = promptNode._rsPromptUIElements;
        customTextarea.value = recipe.prompt;
        if (textWidget) textWidget.value = recipe.prompt;
        customTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        promptApplied = true;
    } else if (wantPrompt && target) {
        // 子图无 Neo Prompt：兜底写入宫格节点的提示词框
        const gridNode = gridByRoot.get(target.root);
        if (gridNode?._neoRg?.setPrompt) {
            gridNode._neoRg.setPrompt(recipe.prompt);
            promptApplied = true;
        }
    }

    const total = result.assets.length;
    const restored = applied + gridFilled;
    const partial = missing > 0 || (wantPrompt && !promptApplied);
    const parts = [tf("按参数位还原 {ok}/{total} 个资源", { ok: restored, total })];
    if (gridFilled) parts.push(tf("宫格填入 {n}", { n: gridFilled }));
    if (missing) parts.push(tf("{n} 个资源该子图无可用节点", { n: missing }));
    if (promptApplied) parts.push(t('提示词已写入'));
    else if (wantPrompt) parts.push(t('提示词未写入：该子图无 Neo Prompt / 宫格'));
    app.extensionManager.toast.add({
        severity: partial ? 'warn' : (restored || promptApplied ? 'success' : 'info'),
        summary: t('配方已发送'),
        detail: tf("{name}：{partial}{parts}", { name: recipe.name, partial: partial ? t('仅还原了部分，') : '', parts: parts.join('，') }),
        life: 4000
    });
    return true;
}

// ==========================================
// 侧边栏「配方」面板
// ==========================================

export async function createRecipesPanel(options = {}) {
    const root = $el('div', { className: 'neo-recipes-panel' });
    // directorOnly（Studio 导演页）：只列多段导演配方，隐藏筛选 chips；普通配方在那里无用
    const directorOnly = !!options.directorOnly;
    const fixedFilter = directorOnly ? 'director' : null;
    // selectable（Studio 导演页）：点卡片即选中并回传 onSelect，直接喂给上方整片生成区（不再用顶部下拉选配方）
    const selectable = typeof options.onSelect === 'function';
    // openEditorOnSelect（Studio 导演页）：选中后顺手在内嵌宿主里打开该配方，省得再去找 ✎
    const openEditorOnSelect = !!options.openEditorOnSelect;
    const autoSelectFirst = !!options.autoSelectFirst;
    let selectedName = null;
    // 选中即打开内嵌编辑器（Studio 导演页）：点卡片与首屏自动选中走同一条路径。
    // 自动选中只回 onSelect 的话，进页时右上宿主是空的 —— 得再点一次配方卡才有编辑器
    const openOnSelect = (r) => {
        // 选中由编辑器 adopt 回传：脏态挡下时卡片高亮与上方生成区一律不动，确认条处理完才跟着切过去
        if (openEditorOnSelect && r.type === 'video_director') openDirectorEditor(r, renderList, -1, { onAdopt: () => selectRecipe(r) });
    };

    // 面板状态（搜索/筛选/排序/分组折叠）：存 /userdata/neo_recipes_data.json，刷新后回显
    const prefs = { query: '', filter: fixedFilter || 'all', sort: 'mtime', collapsed: {} };
    let prefTimer = null;
    function savePrefs() {
        clearTimeout(prefTimer);
        prefTimer = setTimeout(() => {
            const payload = { ...prefs };
            if (fixedFilter) delete payload.filter;   // 筛选固定，不写回共享 prefs（免得覆盖画布侧栏选的筛选）
            api.fetchApi('/userdata/neo_recipes_data.json?file_format=json&merge=true', {
                method: 'POST',
                body: JSON.stringify({ recipes_prefs: payload }),
            }).catch(() => { });
        }, 300);
    }
    async function loadPrefs() {
        try {
            const res = await api.fetchApi('/userdata/neo_recipes_data.json');
            if (!res.ok) return;
            const p = (await res.json())?.recipes_prefs;
            if (!p) return;
            if (typeof p.query === 'string') prefs.query = p.query;
            if (!fixedFilter && RECIPE_FILTERS.some(f => f.id === p.filter)) prefs.filter = p.filter;
            if (RECIPE_SORTS.some(s => s.id === p.sort)) prefs.sort = s.id;
            if (p.collapsed && typeof p.collapsed === 'object') Object.assign(prefs.collapsed, p.collapsed);
        } catch (e) { /* 无存档时用默认值 */ }
    }

    // 标题行：图标标题 + 操作按钮（窄栏自动换行，按钮带 title 提示）
    const fileInput = $el('input', {
        type: 'file', accept: '.zip,application/zip', style: { display: 'none' }, id: 'neo-recipes-import-file',
        onchange: async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            const form = new FormData();
            form.append('file', file);
            try {
                const res = await fetch('/rs_recipes/import', { method: 'POST', body: form });
                const data = await res.json().catch(() => ({}));
                if (data?.success) {
                    app.extensionManager.toast.add({ severity: 'success', summary: tf("导入成功：{name}", { name: data.name }) });
                    await renderList();
                } else {
                    app.extensionManager.toast.add({ severity: 'error', summary: t('导入失败'), detail: data?.error || 'Unknown error', life: 4000 });
                }
            } catch (err) {
                app.extensionManager.toast.add({ severity: 'error', summary: t('导入失败'), detail: String(err), life: 4000 });
            }
        }
    });
    const importBtn = $el('button', {
        className: 'rs-btn rs-action-btn neo-recipes-import',
        textContent: t('导入'), title: t('导入配方 zip 包'),
        onclick: () => fileInput.click()
    });
    const directorBtn = $el('button', {
        className: 'rs-btn rs-action-btn neo-recipes-director',
        textContent: options.newRecipeLabel || t('新增导演配方'),
        title: options.newRecipeTitle || t('新建分镜视频导演配方'),
        onclick: () => (options.onNewRecipe ? options.onNewRecipe(renderList) : openDirectorEditor(null, renderList))
    });
    const refreshBtn = $el('button', {
        className: 'rs-btn rs-action-btn neo-recipes-refresh',
        textContent: '↻', title: t('刷新'),
        onclick: () => renderList()
    });

    // 工具条：搜索框 + 筛选 chips + 排序下拉
    const searchInput = $el('input', {
        className: 'neo-recipes-search',
        type: 'text',
        placeholder: t('搜索名称 / 提示词'),
        value: prefs.query,
    });
    let queryTimer = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(queryTimer);
        queryTimer = setTimeout(() => { prefs.query = searchInput.value; savePrefs(); paint(); }, 200);
    });
    const filters = fixedFilter ? [] : RECIPE_FILTERS;   // 筛选固定（导演页 / 绘画页）时 chips 无意义
    const chipEls = filters.map(f => $el('button', { className: 'neo-recipes-chip', textContent: f.label, title: f.title }));
    function syncChips() {
        filters.forEach((f, i) => chipEls[i].classList.toggle('neo-recipes-chip-active', prefs.filter === f.id));
    }
    filters.forEach((f, i) => chipEls[i].addEventListener('click', () => { prefs.filter = f.id; syncChips(); savePrefs(); paint(); }));
    const sortSel = $el('select', { className: 'neo-recipes-sort' }, RECIPE_SORTS.map(s => $el('option', { value: s.id, textContent: s.label })));
    sortSel.value = prefs.sort;
    sortSel.addEventListener('change', () => { prefs.sort = sortSel.value; savePrefs(); paint(); });

    const header = $el('div', { className: 'neo-recipes-header' }, [
        $el('div', { className: 'neo-recipes-title-row' }, [
            $el('h3', { className: 'neo-recipes-title', innerHTML: `${RECIPE_ICON_SVG}<span>${options.title || t('配方')}</span>` }),
            refreshBtn, importBtn, directorBtn,
        ]),
        searchInput,
        $el('div', { className: 'neo-recipes-tools' }, [...chipEls, sortSel]),
    ]);
    root.appendChild(header);

    const listEl = $el('div', { className: 'neo-recipes-list' });
    root.appendChild(listEl);

    // 卡片「⋯ 更多」菜单：点外部或 Esc 关闭（面板级，避免每卡各挂监听）
    const closeMoreMenus = () => root.querySelectorAll('.neo-recipes-more-menu.open').forEach(m => m.classList.remove('open'));
    document.addEventListener('click', (e) => { if (!root.contains(e.target)) closeMoreMenus(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMoreMenus(); });

    /** 详情浮层：完整标题 + 完整提示词 + 资源网格（视频可预览）+ 示例结果 + 发送入口。Esc 关闭，焦点管理。 */
    function openDetail(r, opener) {
        document.querySelector('.neo-recipes-detail')?.remove();

        // 缩略图为静态预览：video/audio 不拦截点击，统一由外层容器打开 Lightbox（播放交给 Lightbox 内的 controls+autoplay）
        const makeMedia = (a, dir) => {
            if (a.kind === 'video') return $el('video', { src: assetUrl(r.name, a.file, dir), preload: 'metadata' });
            if (a.kind === 'audio') return $el('div', { className: 'neo-recipes-detail-asset-audio', textContent: `${a.file}` });
            // 图片网格走缩略图（256px JPEG，懒加载）；生成失败回退原图
            const img = $el('img', { src: thumbUrl(r.name, a.file, dir, 256), alt: a.file, loading: 'lazy' });
            let fellBack = false;
            img.addEventListener('error', () => { if (fellBack) return; fellBack = true; img.src = assetUrl(r.name, a.file, dir); });
            return img;
        };

        // 资产缩略图：点击用 Lightbox 查看大图（图片可缩放/拖拽，音视频可播放）
        const assetItems = (r.assets || []).map(a => ({ kind: a.kind, url: assetUrl(r.name, a.file), title: a.file }));
        const grid = $el('div', { className: 'neo-recipes-detail-grid' });
        (r.assets || []).forEach((a, i) => {
            grid.appendChild($el('div', {
                className: 'neo-recipes-detail-asset',
                title: t('点击放大查看'),
                onclick: () => Lightbox.open({ items: assetItems, index: i })
            }, [
                makeMedia(a),
                $el('div', { className: 'neo-recipes-detail-file', textContent: a.file, title: a.file })
            ]));
        });
        const loras = r.loras || [];
        const lorasEl = loras.length ? $el('div', { className: 'neo-recipes-detail-loras' }, [
            $el('div', { className: 'neo-recipes-detail-loras-title', textContent: tf("LoRA（{n}）", { n: loras.length }) }),
            ...loras.map(l => $el('span', {
                className: 'neo-recipes-detail-lora',
                title: l.name,
                textContent: `${l.name} × ${Number(l.strength).toFixed(2)}`
            }))
        ]) : null;
        // 导演配方概览行（段数/模式/技能/宽×高/总时长）：先按 skill id 渲染，取回技能列表后原地换成名称
        let metaLine = null;
        if (r.type === 'video_director') {
            metaLine = $el('div', { className: 'neo-recipes-detail-meta', textContent: directorMetaText(r, []) });
            listVideoSkills().then(skills => { metaLine.textContent = directorMetaText(r, skills); });
        }

        const bodyChildren = [
            $el('div', { className: 'neo-recipes-detail-head' }, [
                $el('div', { className: 'neo-recipes-detail-name', textContent: r.name }),
                $el('div', { className: 'neo-recipes-detail-source', textContent: r.source === 'preset' ? t('内置预设') : t('我的配方') })
            ]),
            ...(metaLine ? [metaLine] : []),
            $el('div', { className: 'neo-recipes-detail-prompt', textContent: r.prompt || t('（无提示词）') }),
            ...(lorasEl ? [lorasEl] : []),
            ...((r.assets || []).length ? [grid] : []),
        ];

        const samples = r.samples || [];
        if (samples.length) {
            const sampleGrid = $el('div', { className: 'neo-recipes-detail-grid' });
            const sampleItems = samples.map(s => ({ kind: s.kind, url: assetUrl(r.name, s.file, 'samples'), title: s.file }));
            samples.forEach((s, i) => {
                const item = $el('div', {
                    className: 'neo-recipes-detail-asset',
                    title: t('点击放大查看'),
                    onclick: () => Lightbox.open({
                        items: sampleItems,
                        index: i,
                        // 示例内嵌了 ComfyUI 工作流时，在 Lightbox 内提供「复制工作流」动作
                        actions: (cur) => [{
                            label: t('复制工作流'),
                            title: t('把该示例内嵌的工作流加载到画布'),
                            onClick: (it, lb, btn) => {
                                btn.disabled = true;
                                copySampleWorkflowToCanvas(r.name, it.file)
                                    .finally(() => { btn.disabled = false; });
                            },
                        }],
                    })
                }, [
                    makeMedia(s, 'samples'),
                    $el('div', { className: 'neo-recipes-detail-file', textContent: s.file, title: s.file })
                ]);
                // 复制工作流：从示例内嵌元数据读回；无备份则提示
                const copyBtn = $el('button', {
                    className: 'neo-recipes-sample-copy',
                    textContent: '',
                    title: t('复制该示例内嵌的工作流到画布'),
                    onclick: async (e) => {
                        e.stopPropagation();
                        copyBtn.disabled = true;
                        await copySampleWorkflowToCanvas(r.name, s.file);
                        copyBtn.disabled = false;
                    }
                });
                item.appendChild(copyBtn);
                if (r.source !== 'preset') {
                    const delBtn = $el('button', {
                        className: 'neo-recipes-sample-del',
                        title: t('删除该示例结果'),
                        onclick: async (e) => {
                            e.stopPropagation();
                            if (!confirm(tf("删除示例「{file}」？", { file: s.file }))) return;
                            delBtn.disabled = true;
                            const res = await deleteRecipeSample(r.name, s.file);
                            delBtn.disabled = false;
                            if (res?.success) {
                                close();
                                const list = await listRecipes();
                                const fresh = list.find(x => x.name === r.name);
                                if (fresh) openDetail(fresh);
                            } else {
                                app.extensionManager.toast.add({ severity: 'error', summary: t('删除失败'), detail: res?.error || 'Unknown error', life: 4000 });
                            }
                        }
                    }, [icon('trash')]);
                    item.appendChild(delBtn);
                }
                sampleGrid.appendChild(item);
            });
            bodyChildren.push($el('div', { className: 'neo-recipes-detail-section', textContent: tf("示例结果（{n}）", { n: samples.length }) }));
            bodyChildren.push(sampleGrid);
        }

        // 结果（results）：只记 output 目录产物路径，点击即可查看，删除图标确认后连同磁盘文件一起删
        const results = r.results || [];
        if (results.length) {
            const resultGrid = $el('div', { className: 'neo-recipes-detail-grid' });
            const resultItems = results.map(x => ({ kind: x.kind, url: outputUrl(x), title: x.filename }));
            results.forEach((x, i) => {
                const item = $el('div', {
                    className: 'neo-recipes-detail-asset',
                    title: x.at ? tf("点击查看（{at}）", { at: x.at }) : t('点击查看'),
                    onclick: () => Lightbox.open({ items: resultItems, index: i })
                }, [
                    x.kind === 'video' ? $el('video', { src: outputUrl(x), preload: 'metadata' })
                        : x.kind === 'audio' ? $el('div', { className: 'neo-recipes-detail-asset-audio', textContent: `${x.filename}` })
                            : $el('img', { src: outputUrl(x), alt: x.filename, loading: 'lazy' }),
                    $el('div', { className: 'neo-recipes-detail-file', textContent: x.filename, title: x.filename })
                ]);
                const delBtn = $el('button', {
                    className: 'neo-recipes-result-del',
                    title: t('删除该结果文件（连同 output 目录里的文件）'),
                    onclick: async (e) => {
                        e.stopPropagation();
                        if (!confirm(tf("删除结果文件「{filename}」？\n会同时从磁盘删除该文件。", { filename: x.filename }))) return;
                        delBtn.disabled = true;
                        const res = await deleteRecipeResult(r.name, x);
                        delBtn.disabled = false;
                        if (res?.success) {
                            close();
                            await renderList();
                            const fresh = (await listRecipes()).find(v => v.name === r.name);
                            if (fresh) openDetail(fresh);
                        } else {
                            app.extensionManager.toast.add({ severity: 'error', summary: t('删除失败'), detail: res?.error || 'Unknown error', life: 4000 });
                        }
                    }
                }, [icon('trash')]);
                item.appendChild(delBtn);
                resultGrid.appendChild(item);
            });
            bodyChildren.push($el('div', { className: 'neo-recipes-detail-section', textContent: tf("结果（{n}）", { n: results.length }) }));
            bodyChildren.push(resultGrid);
        }

        const copyPromptBtn = $el('button', {
            className: 'rs-btn neo-recipes-detail-copy',
            title: t('把配方提示词复制到剪贴板'),
            disabled: !r.prompt,
            onclick: async () => {
                try { await navigator.clipboard.writeText(r.prompt); }
                catch (e) { app.extensionManager.toast.add({ severity: 'info', summary: t('复制失败'), detail: String(e), life: 3000 }); }
            }
        }, [icon('copy'), ' ' + t('复制提示词')]);

        const closeBtn = $el('button', { className: 'rs-btn neo-recipes-detail-close', textContent: t('关闭') });
        const footBtns = [closeBtn, copyPromptBtn];
        if (r.type === 'video_director') {
            // 多段导演配方由 NeoH3VideoDirector 节点按名称消费，无法走「发送到工作流」还原
            footBtns.push($el('button', {
                className: 'rs-btn neo-recipes-detail-edit',
                textContent: t('✎ 编辑配方'),
                title: t('编辑多段导演配方'),
                onclick: () => { close(); openDirectorEditor(r, renderList); }
            }));
        } else {
            const sendBtn = $el('button', {
                className: 'rs-btn neo-recipes-detail-send',
                textContent: t('✈发送到工作流'),
                onclick: async () => {
                    sendBtn.disabled = true;
                    const ok = await applyRecipeToWorkflow(r);
                    sendBtn.disabled = false;
                    if (ok) { close(); await renderList(); }
                }
            });
            footBtns.push(sendBtn);
        }
        bodyChildren.push($el('div', { className: 'neo-recipes-detail-foot' }, footBtns));

        const body = $el('div', { className: 'neo-recipes-detail-body' }, bodyChildren);
        const overlay = $el('div', { className: 'neo-recipes-detail' }, [body]);

        // Esc 关闭 + 焦点管理：打开时聚焦关闭按钮，关闭时归还给触发元素
        let closed = false;
        function close() {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            opener?.focus?.();
        }
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        closeBtn.onclick = close;
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey);
        closeBtn.focus();
    }

    function buildCard(r, skills) {
        const card = $el('div', {
            className: 'neo-recipes-card',
            tabindex: '0',
            role: 'button',
            'aria-label': r.name,
        });
        card.dataset.name = r.name;
        if (selectable) {
            // 点卡片即选中并回传 onSelect（Studio 导演页：直接喂给上方整片生成区）；
            // openEditorOnSelect 时同一次点击直接在内嵌宿主里打开该配方（重复点同一配方只切段，不重载）
            const pick = () => {
                // 导演配方：选中跟着编辑器走（编辑器 adopt 才回传 onSelect）
                if (openEditorOnSelect && r.type === 'video_director') { openOnSelect(r); return; }
                selectRecipe(r);
            };
            card.addEventListener('click', pick);
            card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        } else {
            card.onclick = () => openDetail(r, card);
            card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r, card); } };
        }

        // 媒体区：通栏。普通配方=封面/示例缩略图（单张横幅，多张网格）；导演配方=各段首帧网格
        const isDirector = r.type === 'video_director';
        const media = $el('div', {
            className: 'neo-recipes-card-media',
            title: isDirector ? t('编辑多段导演配方') : t('查看资源'),
        });
        if (!selectable) media.onclick = (e) => { e.stopPropagation(); if (isDirector) openDirectorEditor(r, renderList); else openDetail(r, card); };
        const mediaTiles = [];
        const addTile = (file, dir) => {
            const img = $el('img', { src: thumbUrl(r.name, file, dir, isDirector ? 192 : 256), alt: r.name, loading: 'lazy' });
            let fb = false;
            img.addEventListener('error', () => { if (fb) return; fb = true; img.src = assetUrl(r.name, file, dir); });
            mediaTiles.push(img);
        };
        if (isDirector) {
            const frames = (r.segments || []).map(s => s.first_frame).filter(Boolean);
            for (const f of frames.slice(0, 9)) addTile(f, '');
            if (!frames.length) mediaTiles.push($el('div', { className: 'neo-recipes-card-no-cover', textContent: '' }));
        } else {
            const files = [];
            if (r.cover) files.push([r.cover, '']);
            for (const s of (r.samples || [])) if ((s.kind === 'image' || s.kind === 'video') && s.file !== r.cover) files.push([s.file, 'samples']);
            if (!files.length) {
                const a = (r.assets || []).find(a => a.kind === 'image') || (r.assets || []).find(a => a.kind === 'video');
                if (a) files.push([a.file, '']);
            }
            for (const [f, dir] of files.slice(0, 4)) addTile(f, dir);
            if (!files.length) mediaTiles.push($el('div', { className: 'neo-recipes-card-no-cover', textContent: r.assets?.length ? '' : '' }));
        }
        media.append(...mediaTiles);
        if (mediaTiles.length === 1 && mediaTiles[0].tagName === 'IMG') media.classList.add('single');

        // 标题在图片上方，导演配方带「导演」标签
        const nameEl = $el('div', { className: 'neo-recipes-card-name' }, [
            $el('span', { textContent: r.name }),
            ...(isDirector ? [$el('span', { className: 'neo-recipes-card-badge', textContent: t('导演') })] : [])
        ]);
        nameEl.title = t('查看资源');
        if (!selectable) nameEl.onclick = (e) => { e.stopPropagation(); openDetail(r, card); };

        // 正文：信息 chips（预设/资源/示例/结果）+ 摘要折叠（导演）或提示词预览
        const chips = [];
        if (r.source === 'preset') chips.push(t('预设'));
        if (r.sample_count) chips.push(tf("{n} 个示例", { n: r.sample_count }));
        if (r.result_count) chips.push(tf("{n} 个结果", { n: r.result_count }));
        let summaryWrap = null;
        if (isDirector && (r.segments || []).length) {
            summaryWrap = $el('div', { className: 'neo-recipes-card-summary', textContent: directorMetaText(r, skills) });
        }
        const body = $el('div', { className: 'neo-recipes-card-body' }, [
            ...(chips.length ? [$el('div', { className: 'neo-recipes-card-chips' }, chips.map(c => $el('span', { className: 'neo-recipes-chip', textContent: c })))] : []),
            summaryWrap || $el('div', { className: 'neo-recipes-card-meta', textContent: (r.prompt || '').slice(0, 120) || t('无提示词') })
        ]);
        // 操作：主操作（发送/编辑 + 复制）直接展示，其余收进 ⋯ 更多菜单
        const direct = [];
        const more = [];
        if (selectable) direct.push({ cls: 'neo-recipes-detail-open', icon: '', title: t('查看资源'), run: (b) => openDetail(r, b) });
        if (r.type !== 'video_director') {
            direct.push({ cls: 'neo-recipes-send', icon: '✈', title: t('一键发送到工作流'), run: (b) => { b.disabled = true; applyRecipeToWorkflow(r).then(ok => { b.disabled = false; if (ok) renderList(); }); } });
        } else {
            direct.push({ cls: 'neo-recipes-edit-director', icon: '✎', title: t('编辑多段导演配方'), run: () => openDirectorEditor(r, renderList) });
        }
        direct.push({ cls: 'neo-recipes-copy', icon: icon('copy'), title: t('复制配方（生成副本）'), run: (b) => { b.disabled = true; copyRecipe(r.name).then(res => { b.disabled = false; if (res?.success) { app.extensionManager.toast.add({ severity: 'success', summary: t('配方已复制'), detail: tf("已创建副本「{name}」", { name: res.name }), life: 4000 }); renderList(); } else app.extensionManager.toast.add({ severity: 'error', summary: t('复制失败'), detail: res?.error || 'Unknown error', life: 4000 }); }); } });
        if (r.type !== 'video_director') {
            more.push({ cls: 'neo-recipes-append', icon: '', title: t('追加当前输出为示例结果'), run: (b) => { b.disabled = true; const results = collectWorkflowResults(); appendResultsToRecipe(r.name, results).then(res => { b.disabled = false; if (res?.success) { app.extensionManager.toast.add({ severity: res.added ? 'success' : 'info', summary: t('示例结果追加'), detail: tf("{name}：新增 {added}，跳过重复 {skipped}", { name: r.name, added: res.added, skipped: res.skipped }), life: 4000 }); renderList(); } else app.extensionManager.toast.add({ severity: 'error', summary: t('追加失败'), detail: res?.error || 'Unknown error', life: 4000 }); }); } });
        }
        more.push({ cls: 'neo-recipes-export', icon: '', title: t('导出为 zip 包（含 Readme.txt）'), run: () => { fetch(`/rs_recipes/export?name=${encodeURIComponent(r.name)}`).then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.blob(); }).then(blob => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${r.name}.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }).catch(err => app.extensionManager.toast.add({ severity: 'error', summary: t('导出失败'), detail: String(err), life: 4000 })); } });
        if (r.source !== 'preset') {
            more.push({ cls: 'neo-recipes-delete', icon: icon('trash'), title: t('删除配方'), run: (b) => { if (!confirm(tf("删除配方「{name}」？", { name: r.name }))) return; b.disabled = true; deleteRecipe(r.name).then(res => { b.disabled = false; if (res?.success) renderList(); else app.extensionManager.toast.add({ severity: 'error', summary: t('删除失败'), detail: res?.error || 'Unknown error', life: 4000 }); }); } });
        }

        const actions = $el('div', { className: 'neo-recipes-card-actions' });
        for (const it of direct) {
            const b = $el('button', { className: `rs-btn rs-action-btn ${it.cls}`, title: it.title }, [it.icon]);
            b.onclick = (e) => { e.stopPropagation(); it.run(b); };
            actions.append(b);
        }
        if (more.length) {
            const wrap = $el('span', { className: 'neo-recipes-more-wrap' });
            const moreBtn = $el('button', { className: 'rs-btn rs-action-btn neo-recipes-more', title: t('更多操作'), textContent: '⋯', 'aria-expanded': 'false' });
            const menu = $el('div', { className: 'neo-recipes-more-menu' });
            for (const it of more) {
                const row = $el('button', { className: 'neo-recipes-more-item' });
                row.append($el('span', { className: 'neo-recipes-more-icon' }, [it.icon]), $el('span', { textContent: it.title }));
                row.onclick = (e) => { e.stopPropagation(); menu.classList.remove('open'); moreBtn.setAttribute('aria-expanded', 'false'); it.run(row); };
                menu.append(row);
            }
            moreBtn.onclick = (e) => { e.stopPropagation(); const open = menu.classList.toggle('open'); moreBtn.setAttribute('aria-expanded', String(open)); };
            wrap.append(moreBtn, menu);
            actions.append(wrap);
        }
        card.append(nameEl, media, body, actions);
        return card;
    }

    const state = { recipes: [], skills: [] };
    const cardIndex = new Map();   // 配方名 -> { card, sig }：重排时复用 DOM，已解码图片不重新加载
    const groupTitles = {};        // 分组 key -> 标题元素（sticky，点击折叠）

    const emptyEl = $el('div', { className: 'neo-recipes-empty' }, [
        $el('div', { textContent: t('暂无配方') }),
        $el('div', { className: 'neo-recipes-empty-hint', textContent: t('在「Neo Video Creator」节点点 保存为配方，或点 导入 zip、新建导演配方') }),
    ]);

    function recipeSig(r) {
        return [r.cover, r.type, r.asset_count, (r.assets || []).length, r.sample_count, (r.samples || []).map(s => s.file).join(','), (r.results || []).length, (r.segments || []).map(s => s.first_frame || '').join(','), (r.prompt || '').slice(0, 200)].join('|');
    }

    function cardFor(r) {
        const sig = recipeSig(r);
        const hit = cardIndex.get(r.name);
        if (hit && hit.sig === sig) return hit.card;
        const card = buildCard(r, state.skills);
        cardIndex.set(r.name, { card, sig });
        return card;
    }

    function visibleRecipes(recipes) {
        const q = prefs.query.trim().toLowerCase();
        const out = recipes.filter(r => {
            if (prefs.filter === 'normal' && (r.type === 'video_director' || r.source === 'preset')) return false;
            if (prefs.filter === 'director' && r.type !== 'video_director') return false;
            if (prefs.filter === 'mine' && r.source === 'preset') return false;
            if (prefs.filter === 'preset' && r.source !== 'preset') return false;
            if (!q) return true;
            const hay = [r.name, r.prompt, ...(r.segments || []).map(s => s.desc || '')].join(' ').toLowerCase();
            return hay.includes(q);
        });
        if (prefs.sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        else if (prefs.sort === 'results') out.sort((a, b) => (((b.results || []).length ? 1 : 0) - ((a.results || []).length ? 1 : 0)) || a.name.localeCompare(b.name, 'zh-CN'));
        return out;   // mtime：保持后端返回顺序（最近修改在前）
    }

    function groupTitleEl(key, label) {
        let el = groupTitles[key];
        if (!el) {
            el = $el('div', { className: 'neo-recipes-group-title', title: t('点击折叠/展开'), onclick: () => { prefs.collapsed[key] = !prefs.collapsed[key]; savePrefs(); paint(); } });
            groupTitles[key] = el;
        }
        el.textContent = `${prefs.collapsed[key] ? '▸' : '▾'} ${label}`;
        return el;
    }

    // 选中高亮（selectable 模式）：只改 class，不重复触发 onSelect
    function applySelectionHighlight(name) {
        for (const [n, entry] of cardIndex) entry.card.classList.toggle('neo-recipes-card-selected', n === name);
    }
    function selectRecipe(r, fire = true) {
        selectedName = r.name;
        applySelectionHighlight(selectedName);
        if (fire) options.onSelect?.(r);
    }

    function paint() {
        const list = visibleRecipes(state.recipes);
        const wanted = [];
        for (const g of [
            { key: 'custom', label: t('我的配方'), match: r => r.source !== 'preset' },
            { key: 'preset', label: t('内置预设'), match: r => r.source === 'preset' },
        ]) {
            const items = list.filter(g.match);
            if (!items.length) continue;
            wanted.push(groupTitleEl(g.key, g.label));
            if (prefs.collapsed[g.key]) continue;
            for (const r of items) wanted.push(cardFor(r));
        }
        if (!wanted.length) wanted.push(emptyEl);

        // 增量重排：已有节点只移动位置，不重建 DOM（滚动位置与已解码图片保留）
        let cursor = listEl.firstChild;
        for (const node of wanted) {
            if (cursor === node) { cursor = node.nextSibling; continue; }
            listEl.insertBefore(node, cursor);
        }
        while (cursor) { const next = cursor.nextSibling; listEl.removeChild(cursor); cursor = next; }
        const alive = new Set(state.recipes.map(r => r.name));
        for (const name of [...cardIndex.keys()]) if (!alive.has(name)) cardIndex.delete(name);
        // 恢复选中高亮（不重复触发 onSelect）；首次按 initialSelection / autoSelectFirst 自动选中，
        // 并和点卡片一样把选中的配方铺进内嵌编辑器（进页即有编辑器，不用先点一次）
        if (selectedName) {
            applySelectionHighlight(selectedName);
        } else if (autoSelectFirst) {
            const list = visibleRecipes(state.recipes);
            if (list.length) {
                const name = (options.initialSelection && list.some(x => x.name === options.initialSelection))
                    ? options.initialSelection : list[0].name;
                const first = list.find(x => x.name === name);
                selectRecipe(first);
                openOnSelect(first);
            }
        }
    }

    async function renderList() {
        let recipes = [];
        let skills = [];
        // 技能列表供多段导演卡片摘要行做 skill_id → 名称映射（listVideoSkills 内部已吞错，不会拒绝）
        try { [recipes, skills] = await Promise.all([listRecipes(), listVideoSkills()]); } catch (e) { /* 忽略 */ }
        state.recipes = recipes;
        state.skills = skills;
        paint();
    }

    refreshFn = renderList;
    loadPrefs().then(() => { syncChips(); searchInput.value = prefs.query; sortSel.value = prefs.sort; paint(); });
    await renderList();
    return root;
}

// 面板单例：侧边栏切页签重新渲染时复用同一 DOM（滚动位置/已解码图片保留），并触发刷新
let panelPromise = null;
let refreshFn = null;
export function getRecipesPanel() {
    if (!panelPromise) panelPromise = createRecipesPanel();
    else refreshFn?.();
    return panelPromise;
}


