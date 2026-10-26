/**
 * workflow.js — 工作流功能前端模块
 * 合并自 workflow-repair.js 与 workflow-repair-toolbar.js，便于后续扩展更多工作流功能。
 *
 * 1. 工作流模型路径修复（与素材/配方模块解耦）：任何工作流（UI 或 API 格式）
 *    载入画布前可调用后端 /neo_nodes/repair 检测失效的模型路径，并以二次确认弹窗
 *    让用户选择「修复 / 取消」；自动匹配失败的项可在弹窗中手动选择替换文件，
 *    勾选「记住手动选择」后保存为服务端修复映射，之后相同失效路径自动替换；
 *    确认的每次修复按工作流关联写入本地修复日志（localStorage），供后续复查修改点。
 * 2. 顶栏 菜单（top-menu.js）：本模块提供 runRepair / showRepairLogDialog / showRepairMappingsDialog
 *    与失效路径红点提示，按钮本体与下拉菜单归 top-menu.js。
 */
import { api } from "../../../../scripts/api.js";
import { app } from "../../../../scripts/app.js";
import { showToast } from './gallery-utils.js';
import { openModelHub } from './model-hub.js';
import { t, tf } from './js/core/i18n.js';

// 修复行输入名 → 模型库落盘类别（与后端 workflow.py 的 _MODEL_FOLDER_BY_INPUT 同源）。
// 模型没装时本地无候选可替换，只能去模型库下载，这里按输入名推断该落到哪个目录。
const HUB_CATEGORY_BY_INPUT = {
    ckpt_name: 'checkpoints',
    checkpoint_name: 'checkpoints',
    unet_name: 'diffusion_models',
    diffusion_model_name: 'diffusion_models',
    lora_name: 'loras',
    vae_name: 'vae',
    clip_name: 'text_encoders',
    clip_name1: 'text_encoders',
    clip_name2: 'text_encoders',
    clip_name3: 'text_encoders',
    clip_name4: 'text_encoders',
    clip_vision_name: 'clip_vision',
    control_net_name: 'controlnet',
    control_net_name1: 'controlnet',
    control_net_name2: 'controlnet',
    style_model_name: 'style_models',
    latent_upscale_model_name: 'latent_upscale_models',
    model_name: 'upscale_models',
};

// 输入名猜不出类别时的兜底：按子串判定，与后端 _MODEL_FOLDER_HINTS 保持一致
const HUB_CATEGORY_HINTS = [
    ['lora', 'loras'], ['vae', 'vae'], ['ckpt', 'checkpoints'], ['checkpoint', 'checkpoints'],
    ['unet', 'diffusion_models'], ['control', 'controlnet'], ['clip_vision', 'clip_vision'],
    ['clip', 'text_encoders'], ['upscal', 'upscale_models'], ['embedding', 'embeddings'],
];

function hubCategoryFor(inputName) {
    if (HUB_CATEGORY_BY_INPUT[inputName]) return HUB_CATEGORY_BY_INPUT[inputName];
    for (const [hint, folder] of HUB_CATEGORY_HINTS) {
        if (String(inputName || '').includes(hint)) return folder;
    }
    return '';
}

/** 失效文件名 → 模型库搜索词：去掉子目录与后缀，保留可搜的模型名 */
function hubQueryFor(value) {
    return String(value || '').split(/[\\/]/).pop().replace(/\.(safetensors|bin|pth|pt|ckpt|gguf|onnx|npz)$/i, '');
}

/**
 * 调用修复 API。返回 { ok, data, error }：
 *   ok=true  — 请求成功，data 为后端载荷（无失效项时 data.changes 为空数组）
 *   ok=false — 请求失败（网络/HTTP/后端错误），调用方应退回原工作流并提示用户
 * decisions/remember：修复弹窗中的手动选择与「记住」勾选，提交后端套用并保存映射。
 */
export async function repairWorkflow(workflow, decisions, remember, opts = {}) {
    if (!workflow || typeof workflow !== 'object') return { ok: true, data: null };
    try {
        const resp = await api.fetchApi('/neo_nodes/repair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workflow, decisions, remember,
                threshold: opts.threshold || undefined,
                widget_refs: opts.widgetRefs || undefined,
            })
        });
        if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
        const data = await resp.json();
        return data && data.success ? { ok: true, data } : { ok: false, error: (data && data.error) || 'invalid response' };
    } catch (e) {
        console.warn('[Neo Repair] repairWorkflow:', e);
        return { ok: false, error: e };
    }
}

// ===== 匹配置信档位与实时 widget 引用 =====
const REPAIR_THRESHOLD_KEY = 'neo.repairThreshold';
const REPAIR_THRESHOLDS = ['strict', 'standard', 'loose'];

export function getRepairThreshold() {
    const v = localStorage.getItem(REPAIR_THRESHOLD_KEY);
    return REPAIR_THRESHOLDS.includes(v) ? v : 'standard';
}

function setRepairThreshold(t) {
    if (REPAIR_THRESHOLDS.includes(t)) localStorage.setItem(REPAIR_THRESHOLD_KEY, t);
}

// 动态模型 widget 识别：INPUT_TYPES 表达不了的 widget（自定义 loader 运行时添加的
// 模型项等）由前端提供真实名字/位置/选项列表，后端据此匹配（参考小秘书模型匹配的
// 覆盖思路）。只在值确实失效（不在自身选项列表）或名字+扩展名都像模型路径时收集。
const MODEL_INPUT_HINT_RE = /(ckpt|checkpoint|unet|diffusion|vae|lora|clip|gguf|controlnet|control_net|upscale|upscaler|model)/i;
const MODEL_FILE_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i;
const MAX_WIDGET_REFS = 200;
const MAX_REF_OPTIONS = 4000;

function collectWidgetRefs() {
    const refs = [];
    for (const node of (app.graph?._nodes || [])) {
        if (node.mode === 2 || node.mode === 4 || !Array.isArray(node.widgets)) continue;
        for (let i = 0; i < node.widgets.length; i++) {
            const w = node.widgets[i];
            const value = typeof w.value === 'string' ? w.value : null;
            if (!value || !value.trim()) continue;
            const name = String(w.name || '');
            const options = Array.isArray(w.options?.values)
                ? w.options.values.filter((v) => typeof v === 'string')
                : null;
            const comboMiss = !!options && options.length > 0 && !options.includes(value);
            if (!comboMiss && !(MODEL_INPUT_HINT_RE.test(name) && MODEL_FILE_RE.test(value))) continue;
            const ref = { node: String(node.id), input: name, index: i, value };
            if (options && options.length && options.length <= MAX_REF_OPTIONS) ref.options = options;
            refs.push(ref);
            if (refs.length >= MAX_WIDGET_REFS) return refs;
        }
    }
    return refs;
}

// ===== 修复日志（localStorage，按工作流关联，新→旧，每工作流上限 LOG_LIMIT 条） =====
const LOG_KEY = 'neo.workflowRepairLog';
const LOG_LIMIT = 50;

function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

// 工作流结构标识：取节点 id+type 的稳定集合（与模型路径的修复值无关）。
// 修复只改 widget 值、不改节点结构，故同一工作流修复前后标识一致，据此把记录绑定到具体工作流。
// 兼容 UI 格式（nodes 数组，节点含 id/type）与 API 格式（{ "<id>": { class_type } }）。
function workflowKey(workflow) {
    if (!workflow || typeof workflow !== 'object') return '';
    const pairs = [];
    const nodes = workflow.nodes;
    if (Array.isArray(nodes)) {
        for (const n of nodes) if (n && n.id != null) pairs.push(`${n.id}:${n.type || ''}`);
    } else {
        for (const k in workflow) {
            const v = workflow[k];
            if (v && typeof v === 'object' && typeof v.class_type === 'string') pairs.push(`${k}:${v.class_type}`);
        }
    }
    pairs.sort();
    return hashString(pairs.join(','));
}

function readLog() {
    try {
        const log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
        return Array.isArray(log) ? log : [];
    } catch (e) {
        return [];
    }
}

function writeLog(log) {
    try {
        localStorage.setItem(LOG_KEY, JSON.stringify(log));
    } catch (e) {
        console.warn('[Neo Repair] 修复日志写入失败:', e);
    }
}

/** 读取指定工作流的修复日志。条目：{ key, time, source, applied, missing, changes } */
export function getRepairLog(workflow) {
    const key = workflowKey(workflow);
    return readLog().filter((e) => e.key === key);
}

/** 清空指定工作流的修复记录。 */
export function clearRepairLog(workflow) {
    const key = workflowKey(workflow);
    writeLog(readLog().filter((e) => e.key !== key));
}

function recordRepairLog(data, source, workflow) {
    const key = workflowKey(workflow);
    const log = readLog();
    const mine = log.filter((e) => e.key === key);
    const others = log.filter((e) => e.key !== key);
    mine.unshift({
        key,
        time: new Date().toISOString(),
        source: source || 'unknown',
        applied: data.applied || 0,
        missing: data.missing || 0,
        changes: data.changes || []
    });
    writeLog([...mine.slice(0, LOG_LIMIT), ...others]);
}

// ===== 修改行元素（确认弹窗与修复记录表格共用） =====

/** 原路径（红色删除线） */
export function oldPathEl(value) {
    const s = document.createElement('span');
    s.textContent = value;
    s.title = value;
    s.style.cssText = 'color:#e88;text-decoration:line-through;';
    return s;
}

/** 修复结果（绿色）；无法修复时显示「未找到」，候选文件放入 title */
export function newPathEl(c) {
    const s = document.createElement('span');
    if (c.new) {
        s.textContent = c.new;
        s.title = c.new;
        s.style.cssText = 'color:#7d7;';
    } else {
        s.textContent = t('未找到可用文件');
        s.style.cssText = 'color:#da6;';
        if (c.candidates && c.candidates.length) s.title = tf("候选文件：{files}", { files: c.candidates.join('、') });
    }
    return s;
}

/** 修复来源显示名（确认弹窗与修复记录共用） */
export const SOURCE_LABELS = { canvas: t('画布'), gallery: t('素材库'), recipes: t('配方'), import: t('导入'), unknown: t('其他') };

/**
 * 构建修改点表格（3 列：节点·输入 / 原路径 / 修复为）。
 * 确认弹窗与修复记录共用；修复记录按次分组，时间/来源在各组标题中显示一次。
 * 传入 onPick 时为交互模式：未匹配且存在候选的行渲染手动选择下拉框。
 */
/** 交互模式下的手动选择下拉框：候选文件列表，空值 = 保持缺失。 */
function buildPickSelect(c, onPick) {
    const select = document.createElement('select');
    select.style.cssText = 'width:100%;background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:3px 6px;font-size:12.5px;';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('— 手动选择替换文件 —');
    select.appendChild(placeholder);
    for (const cand of c.candidates) {
        const opt = document.createElement('option');
        opt.value = cand;
        opt.textContent = cand;
        opt.title = cand;
        select.appendChild(opt);
    }
    select.onchange = () => onPick(c, select.value);
    return select;
}

/**
 * 「模型库」按钮：本地没有可用文件时（模型压根没装，如空的 text_encoders 目录），
 * 手动选择下拉是空的、无法修复——给一条去模型库搜索下载的出路。
 */
function buildHubBtn(c) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t('模型库');
    btn.title = t('本地没有可用文件，去模型库搜索并下载此模型');
    btn.style.cssText = 'flex:none;padding:2px 8px;background:#2a3a4a;color:#9ab;border:1px solid #445;border-radius:4px;cursor:pointer;font-size:11.5px;';
    btn.onclick = (e) => {
        e.stopPropagation();
        openModelHub({ query: hubQueryFor(c.old), category: hubCategoryFor(c.input) });
    };
    return btn;
}

export function buildChangesTable(changes, onPick, onSkip) {
    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;table-layout:fixed;font-size:12.5px;';
    const col = (w) => {
        const c = document.createElement('col');
        c.style.width = w;
        return c;
    };
    const header = (h) => {
        const th = document.createElement('th');
        th.textContent = h;
        th.style.cssText = 'position:sticky;top:0;background:#2a2a2a;color:#9ab;text-align:left;padding:6px 8px;border-bottom:1px solid #444;';
        return th;
    };
    const cell = (content) => {
        const td = document.createElement('td');
        td.style.cssText = 'padding:5px 8px;border-bottom:1px solid #333;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        if (typeof content === 'string') td.textContent = content;
        else td.appendChild(content);
        return td;
    };
    const headRow = document.createElement('tr');
    for (const h of [t('节点 · 输入'), t('原路径'), t('修复为')]) headRow.appendChild(header(h));
    table.appendChild(headRow);
    table.append(col('220px'), col('1fr'), col('1fr'));
    // 字段名（unet_name / lora_name 等）默认省略；同一节点有多个失效输入时才显示以区分
    const inputsPerNode = {};
    for (const c of changes) {
        (inputsPerNode[c.node] || (inputsPerNode[c.node] = new Set())).add(c.input);
    }
    const nodeLabel = (c) => inputsPerNode[c.node].size > 1 ? `${c.type} · ${c.input}` : c.type;
    for (const c of changes) {
        const tr = document.createElement('tr');
        tr.appendChild(cell(nodeLabel(c)));
        tr.appendChild(cell(oldPathEl(c.old)));
        const canPick = !c.new && Array.isArray(c.candidates) && c.candidates.length;
        if (onPick && canPick) {
            const pickWrap = document.createElement('div');
            pickWrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
            pickWrap.appendChild(buildPickSelect(c, onPick));
            pickWrap.appendChild(buildHubBtn(c));
            tr.appendChild(cell(pickWrap));
        } else {
            const wrap = document.createElement('span');
            wrap.style.cssText = 'display:flex;align-items:center;gap:6px;overflow:hidden;';
            wrap.appendChild(newPathEl(c));
            if (c.new && typeof c.score === 'number') {
                const chip = document.createElement('span');
                chip.textContent = Math.round(c.score * 100) + '%';
                chip.title = t('匹配置信度');
                chip.style.cssText = 'flex:none;color:#7aa;font-size:11px;border:1px solid #445;border-radius:8px;padding:0 6px;';
                wrap.appendChild(chip);
            }
            if (c.low_confidence) {
                const badge = document.createElement('span');
                badge.textContent = t('低置信');
                badge.style.cssText = 'flex:none;color:#da6;font-size:11px;';
                wrap.appendChild(badge);
                if (onSkip) {
                    // 宽松档接受的低分改动：默认不勾选 = 不应用（skip 决策保持原值）
                    const label = document.createElement('label');
                    label.style.cssText = 'flex:none;display:flex;align-items:center;gap:3px;color:#9ab;font-size:11px;cursor:pointer;';
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = false;
                    cb.onchange = () => onSkip(c, cb.checked);
                    label.append(cb, t('应用'));
                    wrap.appendChild(label);
                }
            }
            // 匹配不上且本地无候选：模型没装，只能去模型库下载
            if (!c.new && !canPick) wrap.appendChild(buildHubBtn(c));
            tr.appendChild(cell(wrap));
        }
        table.appendChild(tr);
    }
    return table;
}

/**
 * 修复确认弹窗：只有「修复 / 取消」两个按钮（按原样载入与取消等价，已移除）。
 * 未匹配且存在候选的行在「修复为」列渲染下拉框，可手动选择替换文件；
 * 勾选「记住手动选择」后，本次选择由后端保存为修复映射，之后相同失效路径自动替换。
 * opts.threshold / opts.onThresholdChange：匹配阈值三档（严格/标准/宽松），
 * 切换时经 onThresholdChange 重新匹配并重建表格；宽松档低置信改动默认不勾选，
 * 未勾选的以 skip 决策提交（后端保持原值）。
 * 返回 Promise<{ action: 'repair' | 'cancel', decisions: [...], remember: bool }>。
 */
export function showRepairConfirmDialog(changes, opts = {}) {
    return new Promise((resolve) => {
        const existing = document.querySelector('.neo-repair-dialog');
        if (existing) existing.remove();
        const overlay = document.createElement('div');
        overlay.className = 'neo-repair-dialog';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9001;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#1e1e1e;color:#ddd;border-radius:8px;padding:16px 20px;width:900px;max-width:90vw;max-height:70vh;display:flex;flex-direction:column;gap:8px;font-size:13px;';
        const close = (result) => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(result);
        };
        const onKey = (e) => { if (e.key === 'Escape') close({ action: 'cancel', decisions: [], remember: false }); };
        document.addEventListener('keydown', onKey);

        const pickable = (list) => list.filter((c) => !c.new && c.candidates && c.candidates.length);
        const lowConf = (list) => list.filter((c) => c.low_confidence && c.new);
        const title = document.createElement('div');
        title.style.cssText = 'font-weight:bold;font-size:14px;color:#8cf;';
        const updateTitle = (list) => {
            const applied = list.filter((c) => c.new).length;
            const missing = list.length - applied;
            const lowCount = lowConf(list).length;
            const picks = list.length && missing
                ? (pickable(list).length ? t('，其余可手动选择替换文件') : '')
                : '';
            title.textContent = missing
                ? tf("检测到 {n} 处失效的模型路径，{applied} 处已自动匹配{low}{picks}", { n: list.length, applied, low: lowCount ? tf("（{lowCount} 处低置信，默认不应用）", { lowCount }) : '', picks })
                : tf("检测到 {applied} 处模型路径已失效，已匹配到可用文件", { applied });
        };

        // 手动选择：change -> 选中的替换文件（选回空值 = 保持缺失）；
        // 低置信改动默认不应用：勾选「应用」才生效，否则以 skip 决策提交
        const picks = new Map();
        const skips = new Set();
        const body = document.createElement('div');
        body.style.cssText = 'overflow:auto;max-height:50vh;';
        let currentList = changes;
        const renderTable = (list) => {
            currentList = list;
            picks.clear();
            skips.clear();
            body.replaceChildren(buildChangesTable(list, (c, value) => {
                if (value) picks.set(c, value); else picks.delete(c);
            }, (c, apply) => {
                if (apply) skips.delete(c); else skips.add(c);
            }));
            updateTitle(list);
        };
        renderTable(changes);
        box.appendChild(title);

        // 匹配阈值三档：切换后重新匹配并重建表格（阈值记忆到 localStorage）
        if (typeof opts.onThresholdChange === 'function') {
            const thresholdRow = document.createElement('label');
            thresholdRow.style.cssText = 'display:flex;align-items:center;gap:6px;color:#9ab;font-size:12.5px;';
            const thresholdSel = document.createElement('select');
            thresholdSel.style.cssText = 'background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:4px;padding:2px 6px;font-size:12.5px;';
            for (const [v, label] of [['strict', t('严格')], ['standard', t('标准')], ['loose', t('宽松')]]) {
                const opt = document.createElement('option');
                opt.value = v;
                opt.textContent = label;
                thresholdSel.appendChild(opt);
            }
            thresholdSel.value = opts.threshold || 'standard';
            thresholdSel.onchange = async () => {
                setRepairThreshold(thresholdSel.value);
                thresholdSel.disabled = true;
                try {
                    const next = await opts.onThresholdChange(thresholdSel.value);
                    if (Array.isArray(next)) renderTable(next);
                } finally {
                    thresholdSel.disabled = false;
                }
            };
            thresholdRow.append(t('匹配阈值：'), thresholdSel);
            box.appendChild(thresholdRow);
        }
        box.appendChild(body);

        let rememberBox = null;
        if (pickable(currentList).length) {
            const rememberRow = document.createElement('label');
            rememberRow.style.cssText = 'display:flex;align-items:center;gap:6px;color:#9ab;font-size:12.5px;cursor:pointer;';
            rememberBox = document.createElement('input');
            rememberBox.type = 'checkbox';
            rememberBox.checked = true;
            const rememberText = document.createElement('span');
            rememberText.textContent = t('记住手动选择 — 以后遇到相同的失效路径自动修复');
            rememberRow.append(rememberBox, rememberText);
            box.appendChild(rememberRow);
        }

        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px;';
        const base = 'padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
        const repairBtn = document.createElement('button');
        repairBtn.textContent = t('修复');
        repairBtn.style.cssText = base + 'background:#3a7a3a;color:#fff;';
        repairBtn.onclick = () => close({
            action: 'repair',
            decisions: [
                // 手动选择的替换文件
                ...[...picks.entries()].map(([c, value]) => ({
                    node: c.node, input: c.input, old: c.old, value, folder: c.folder || null,
                })),
                // 未勾选「应用」的低置信改动：skip 决策让后端保持原值
                ...[...skips].map((c) => ({
                    node: c.node, input: c.input, old: c.old, value: c.new || c.old, skip: true,
                })),
            ],
            remember: rememberBox ? rememberBox.checked : false,
        });
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = t('取消');
        cancelBtn.style.cssText = base + 'background:transparent;color:#999;border:1px solid #555;';
        cancelBtn.onclick = () => close({ action: 'cancel', decisions: [], remember: false });
        btns.append(repairBtn, cancelBtn);
        box.appendChild(btns);

        overlay.appendChild(box);
        document.body.appendChild(overlay);
    });
}

/**
 * 载入前修复检查 + 二次确认。
 * source：修复来源（'canvas' / 'gallery' / 'recipes' / 'import'），写入修复日志。
 * 返回 { workflow, cancelled, repairedCount, missingCount, repairUnavailable }：
 *   workflow — 最终应载入画布的工作流（修复后或原样）
 *   cancelled — 用户取消载入（调用方应中止）
 *   repairedCount — 实际应用的修复数（用于提示）
 *   missingCount — 确认载入时仍未匹配的失效路径数（用于提示）
 *   repairUnavailable — 修复接口不可用，已按原样处理，调用方应给出警告提示
 */
export async function confirmWorkflowRepair(workflow, source) {
    const threshold = getRepairThreshold();
    const { ok, data, error } = await repairWorkflow(workflow, undefined, false, {
        threshold,
        widgetRefs: collectWidgetRefs(),
    });
    if (!ok) {
        console.warn('[Neo Repair] repair API unavailable, loading as-is:', error);
        return { workflow, cancelled: false, repairedCount: 0, missingCount: 0, repairUnavailable: true };
    }
    if (!data || !data.changes || !data.changes.length) {
        return { workflow, cancelled: false, repairedCount: 0, missingCount: 0 };
    }
    const { action, decisions, remember } = await showRepairConfirmDialog(data.changes, {
        threshold,
        onThresholdChange: async (next) => {
            const retry = await repairWorkflow(workflow, undefined, false, {
                threshold: next,
                widgetRefs: collectWidgetRefs(),
            });
            return retry.ok && retry.data ? retry.data.changes : null;
        },
    });
    if (action !== 'repair') return { workflow, cancelled: true, repairedCount: 0, missingCount: 0 };
    let result = data;
    if (decisions.length) {
        // 手动选择提交给后端套用到修复结果；勾选「记住」时后端同时保存修复映射
        const second = await repairWorkflow(workflow, decisions, remember);
        if (second.ok && second.data) {
            result = second.data;
        } else {
            console.warn('[Neo Repair] apply manual picks failed:', second.error);
            showToast(app, 'warning', t('手动选择的修复未应用，已按自动匹配结果载入'));
        }
    }
    recordRepairLog(result, source, workflow);
    return {
        workflow: result.workflow,
        cancelled: false,
        repairedCount: result.applied || 0,
        missingCount: result.missing || 0,
        changes: Array.isArray(result.changes) ? result.changes : [],
    };
}

// 清除节点加载时标红的错误状态。has_errors 不是 litegraph 自动跟踪的属性，
// 必须手动触发 node:property:changed 事件 Vue 渲染器才会重绘（同 Lora-Manager 做法）。
function clearNodeHasErrors(node) {
    const oldValue = node.has_errors === true;
    if (!oldValue) return;
    node.has_errors = false;
    if (node.graph) {
        node.graph.trigger('node:property:changed', {
            type: 'node:property:changed',
            nodeId: node.id,
            property: 'has_errors',
            oldValue,
            newValue: false
        });
        node.graph.setDirtyCanvas(true, true);
    }
}

// 原位修复：把修复值直接写回当前画布对应节点的 widget，不重新载入整个图（保留
// 画布上的位置、分组、实时状态等）。参考导入类插件的就地应用方式。
// 返回实际写回的条数；任一改动无法在画布上定位时返回 -1，调用方回退全量载入。
function applyRepairInPlace(changes) {
    const graph = app.graph;
    if (!graph?.nodes?.length) return -1;
    const repairedNodes = new Set();
    let applied = 0;
    for (const ch of changes || []) {
        if (!ch || typeof ch.new !== 'string' || !ch.new) continue; // missing 项无可写值
        let node = graph.getNodeById(typeof ch.node === 'string' ? parseInt(ch.node, 10) : ch.node);
        if (!node) {
            // id 定位失败（如画布节点已重建）：按类型 + 当前值匹配
            node = graph.nodes.find(n => n.type === ch.type
                && n.widgets?.some(w => String(w.value) === String(ch.old)));
        }
        const w = node?.widgets?.find(w => w.name === ch.input && String(w.value) === String(ch.old));
        if (!w) return -1;
        const oldValue = w.value;
        w.value = ch.new;
        // Vue 前端的 combo 组件从 DOM input/change 事件同步值；只改 value 不派发事件的话，
        // 总览错误计数等响应式状态不会更新
        try {
            const domTargets = [w.element, w.inputEl, w.domElement, w.el, w.input].filter(Boolean);
            for (const target of domTargets) {
                if (!(target instanceof HTMLElement)) continue;
                const fields = target.matches?.("input, select, textarea")
                    ? [target]
                    : Array.from(target.querySelectorAll("input, select, textarea"));
                for (const field of fields) {
                    try {
                        field.value = ch.new;
                        field.dispatchEvent(new Event("input", { bubbles: true }));
                        field.dispatchEvent(new Event("change", { bubbles: true }));
                    } catch (e) { /* 单个字段同步失败不阻断 */ }
                }
            }
        } catch (e) { /* DOM 同步失败不影响数据修复 */ }
        if (typeof w.callback === 'function') {
            try { w.callback(ch.new); } catch (e) { /* 单个 widget 回调失败不阻断其余修复 */ }
        }
        if (typeof node.onWidgetChanged === 'function') {
            try { node.onWidgetChanged(w.name, w.value, oldValue, w); } catch (e) { /* 忽略 */ }
        }
        repairedNodes.add(node);
        applied++;
    }
    // 修复后所有 widget 值均命中选项列表的节点，清除加载时标红的错误状态
    for (const node of repairedNodes) {
        const stillMissing = node.widgets?.some(w =>
            Array.isArray(w.options?.values) && w.options.values.length > 0
            && !w.options.values.includes(w.value));
        if (!stillMissing) clearNodeHasErrors(node);
    }
    // 通知 Vue 渲染层图已变化，刷新总览/错误计数等派生状态
    graph.change?.();
    app.canvas?.setDirty?.(true, true);
    return applied;
}

// ===== 导入工作流后自动检测失效模型路径并提示修复 =====
// 统一挂在载入入口 app.loadGraphData / app.loadApiJson：任何途径（打开/拖拽/最近/配方/素材/画布，
// UI 或 API 格式）的工作流先照常载入画布，随后静默检测；发现失效路径就给顶部扳手按钮提示（不弹窗），
// 弹窗只在用户点击扳手（runRepair）时触发，各导入途径流程一致。
let _detectingImport = false;

// 载入完成后的静默检测：只判断当前画布是否存在失效模型路径（不弹窗），有则给顶部扳手按钮加提示，
// 无则清除。弹窗只在用户点击按钮（runRepair）时触发。画布在检测期间被切换则丢弃本次结果。
async function afterLoadDetect() {
    if (_detectingImport || !app.graph?.nodes?.length) return;
    const key = workflowKey(app.graph.serialize());
    if (!key) return;
    _detectingImport = true;
    try {
        const wf = app.graph.serialize();
        const { ok, data } = await repairWorkflow(wf, undefined, false, { widgetRefs: collectWidgetRefs() });
        if (app.graph && workflowKey(app.graph.serialize()) !== key) return; // 画布已切换，忽略
        setRepairHint(ok && data && data.changes ? data.changes.length : 0);
    } catch (e) {
        console.warn('[Neo Repair] import auto-detect:', e);
        setRepairHint(0);
    } finally {
        _detectingImport = false;
    }
}

function installImportRepairHook() {
    if (typeof app.loadGraphData === 'function' && !app.loadGraphData.__neoRepairHook) {
        const original = app.loadGraphData;
        const wrapped = async function () {
            const result = await original.apply(app, arguments);
            await afterLoadDetect();
            return result;
        };
        wrapped.__neoRepairHook = true;
        app.loadGraphData = wrapped;
    }
    if (typeof app.loadApiJson === 'function' && !app.loadApiJson.__neoRepairHook) {
        const original = app.loadApiJson;
        const wrapped = async function () {
            const result = await original.apply(app, arguments);
            await afterLoadDetect();
            return result;
        };
        wrapped.__neoRepairHook = true;
        app.loadApiJson = wrapped;
    }
}

// ===== 顶栏 菜单（top-menu.js）=====

// 修复期间防止重复触发（actionBarButtons 为声明式渲染，无法直接改按钮 disabled/opacity）
let repairBusy = false;

// 顶部 菜单按钮提示：检测到失效模型路径时给按钮加红框和右上角红点（不弹窗），点击按钮后清除。
// actionBarButtons 为声明式渲染，切页/焦点模式等会重建按钮，故用 MutationObserver 同步提示
// （与 LoRA Manager 一致）。观察器在首次需要提示时懒启动——此时画布已载入、操作栏已渲染。
let _repairHintCount = 0;
let _hintObserver = null;

function applyRepairHint() {
    const btn = document.querySelector('.neo-n-menu-btn');   // 顶栏 菜单按钮（top-menu.js）
    if (!btn) return;
    if (_repairHintCount > 0) {
        btn.dataset.origAria ??= btn.getAttribute('aria-label');
        btn.classList.add('neo-repair-hint');
        btn.setAttribute('aria-label', tf("修复工作流：检测到 {n} 处失效模型路径，点击修复", { n: _repairHintCount }));
    } else {
        btn.classList.remove('neo-repair-hint');
        const orig = btn.dataset.origAria;
        if (orig && btn.getAttribute('aria-label') !== orig) btn.setAttribute('aria-label', orig);
    }
}

function setRepairHint(count) {
    _repairHintCount = Math.max(0, count | 0);
    if (_repairHintCount > 0) startHintObserver();
    applyRepairHint();
}

function startHintObserver() {
    if (_hintObserver || typeof MutationObserver === 'undefined') return;
    _hintObserver = new MutationObserver(() => applyRepairHint());
    const watchNode = document.querySelector('[data-testid="action-bar-buttons"]')
        || document.querySelector('.actionbar-container')
        || document.body;
    _hintObserver.observe(watchNode, { childList: true, subtree: true });
}

function fitToContent() {
    requestAnimationFrame(() => {
        const canvas = app.canvas;
        const nodes = canvas?.graph?.nodes;
        if (!nodes?.length || !canvas.ds?.fitToBounds) return;
        const b = [Infinity, Infinity, -Infinity, -Infinity];
        for (const n of nodes) {
            const r = n.boundingRect || [n.pos[0], n.pos[1], n.size?.[0] || 0, n.size?.[1] || 0];
            b[0] = Math.min(b[0], r[0]);
            b[1] = Math.min(b[1], r[1]);
            b[2] = Math.max(b[2], r[0] + r[2]);
            b[3] = Math.max(b[3], r[1] + r[3]);
        }
        if (!b.every(isFinite)) return;
        canvas.ds.fitToBounds([b[0] - 10, b[1] - 10, b[2] - b[0] + 20, b[3] - b[1] + 20]);
        canvas.setDirty?.(true, true);
    });
}

export async function runRepair() {
    if (repairBusy) return;
    if (!app.graph?.nodes?.length) {
        showToast(app, 'info', t('画布为空，无需修复'));
        return;
    }
    repairBusy = true;
    try {
        setRepairHint(null); // 点击后由确认弹窗承载状态，先清除按钮提示
        const r = await confirmWorkflowRepair(app.graph.serialize(), 'canvas');
        if (r.cancelled) return;
        if (r.repairUnavailable) {
            showToast(app, 'warning', t('修复检测不可用，画布保持原样'), t('后端修复接口未响应'));
            return;
        }
        if (r.repairedCount > 0) {
            // 优先原位写回（不重载画布，保留节点位置与实时状态）；定位失败才回退全量载入
            const inPlace = applyRepairInPlace(r.changes);
            if (inPlace < 0) {
                await app.loadGraphData(r.workflow);
                fitToContent();
            }
            await afterLoadDetect(); // 原位修复后重跑静默检测，同步扳手按钮提示
            showToast(app, 'success', r.missingCount
                ? tf("已修复 {ok} 处模型路径，{missing} 处未能匹配", { ok: r.repairedCount, missing: r.missingCount })
                : tf("已修复 {ok} 处模型路径", { ok: r.repairedCount }));
        } else if (r.missingCount > 0) {
            showToast(app, 'warning', tf("仍有 {missing} 处失效模型路径未能匹配", { missing: r.missingCount }));
        } else {
            showToast(app, 'info', t('检查完成：未发现失效模型路径'));
        }
    } catch (err) {
        showToast(app, 'error', t('修复失败'), String(err.message || err));
    } finally {
        repairBusy = false;
    }
}

export function showRepairLogDialog() {
    const existing = document.querySelector('.neo-repair-log-dialog');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.className = 'neo-repair-log-dialog';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9001;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e1e;color:#ddd;border-radius:8px;padding:16px 20px;width:1080px;max-width:92vw;max-height:75vh;display:flex;flex-direction:column;gap:10px;font-size:13px;';
    const close = () => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    const current = app.graph ? app.graph.serialize() : null;
    const wfName = (typeof app.graph?.name === 'string' && app.graph.name.trim()) ? app.graph.name.trim() : '';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;font-size:14px;color:#8cf;';
    title.textContent = wfName ? tf("修复记录 · {wf}", { wf: wfName }) : t('修复记录');
    box.appendChild(title);

    const log = getRepairLog(current);
    const total = log.reduce((n, e) => n + (e.changes?.length || 0), 0);
    const missing = log.reduce((n, e) => n + (e.missing || 0), 0);
    const summary = document.createElement('div');
    summary.style.cssText = 'color:#999;font-size:12px;';
    summary.textContent = log.length
        ? tf("共 {n} 次修复 · {total} 处修改（未匹配 {missing} 处）", { n: log.length, total, missing })
        : t('当前工作流暂无修复记录 — 在画布/素材/配方中确认修复后，修改点会按工作流记录在这里。');
    box.appendChild(summary);

    const body = document.createElement('div');
    body.style.cssText = 'overflow:auto;min-height:60px;';
    for (const entry of log) {
        const changes = entry.changes || [];
        if (!changes.length) continue;
        const group = document.createElement('div');
        group.style.cssText = 'margin-bottom:14px;';
        const label = document.createElement('div');
        label.style.cssText = 'padding:0 2px 4px;font-weight:bold;color:#8cf;font-size:12.5px;';
        label.textContent = `${new Date(entry.time).toLocaleString('zh-CN', { hour12: false })} · ${SOURCE_LABELS[entry.source] || t('其他')}`;
        group.appendChild(label);
        group.appendChild(buildChangesTable(changes));
        body.appendChild(group);
    }
    box.appendChild(body);

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const base = 'padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = t('清空记录');
    clearBtn.style.cssText = base + 'background:transparent;color:#a66;border:1px solid #555;';
    clearBtn.onclick = () => {
        clearRepairLog(current);
        close();
        showToast(app, 'info', t('当前工作流修复记录已清空'));
    };
    const mappingsBtn = document.createElement('button');
    mappingsBtn.textContent = t('修复映射');
    mappingsBtn.style.cssText = base + 'background:#444;color:#ddd;';
    mappingsBtn.onclick = () => { close(); showRepairMappingsDialog(); };
    const closeBtn = document.createElement('button');
    closeBtn.textContent = t('关闭');
    closeBtn.style.cssText = base + 'background:#444;color:#ddd;';
    closeBtn.onclick = close;
    btns.append(clearBtn, mappingsBtn, closeBtn);
    box.appendChild(btns);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
}

// ===== 修复映射管理：查看 / 删除手动选择保存的「失效路径 → 替换文件」映射 =====

export async function showRepairMappingsDialog() {
    const existing = document.querySelector('.neo-repair-mappings-dialog');
    if (existing) existing.remove();
    let mappings = [];
    let loadError = false;
    try {
        const resp = await api.fetchApi('/neo_nodes/repair_mappings');
        const data = resp.ok ? await resp.json() : null;
        mappings = data && Array.isArray(data.mappings) ? data.mappings : [];
    } catch (e) {
        console.warn('[Neo Repair] load mappings:', e);
        loadError = true;
    }

    const overlay = document.createElement('div');
    overlay.className = 'neo-repair-mappings-dialog';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9001;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e1e;color:#ddd;border-radius:8px;padding:16px 20px;width:820px;max-width:90vw;max-height:70vh;display:flex;flex-direction:column;gap:10px;font-size:13px;';
    const close = () => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;font-size:14px;color:#8cf;';
    title.textContent = t('修复映射');
    box.appendChild(title);

    const summary = document.createElement('div');
    summary.style.cssText = 'color:#999;font-size:12px;';
    box.appendChild(summary);

    const body = document.createElement('div');
    body.style.cssText = 'overflow:auto;min-height:60px;';
    box.appendChild(body);

    const base = 'padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = t('清空全部');
    clearBtn.style.cssText = base + 'background:transparent;color:#a66;border:1px solid #555;';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = t('关闭');
    closeBtn.style.cssText = base + 'background:#444;color:#ddd;';
    closeBtn.onclick = close;
    btns.append(clearBtn, closeBtn);
    box.appendChild(btns);

    const refreshSummary = () => {
        summary.textContent = loadError
            ? t('映射列表读取失败 — 后端接口未响应')
            : mappings.length
                ? tf("共 {n} 条映射 — 载入遇到相同失效路径（含大小写/扩展名差异）时自动替换", { n: mappings.length })
                : t('暂无修复映射 — 在修复弹窗中手动选择替换文件并勾选「记住手动选择」后保存到这里。');
        clearBtn.disabled = loadError || !mappings.length;
        clearBtn.style.opacity = clearBtn.disabled ? '0.5' : '1';
    };

    const renderRows = () => {
        body.textContent = '';
        refreshSummary();
        for (const m of mappings) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 2px;border-bottom:1px solid #333;';
            const label = document.createElement('span');
            label.style.cssText = 'flex:1;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            label.textContent = `[${m.folder}] ${m.wanted} → ${m.replacement}`;
            label.title = label.textContent;
            const del = document.createElement('button');
            del.textContent = t('删除');
            del.style.cssText = 'flex:none;padding:2px 10px;border:1px solid #555;border-radius:4px;background:transparent;color:#a66;cursor:pointer;font-size:12px;';
            del.onclick = async () => {
                try {
                    const resp = await api.fetchApi(`/neo_nodes/repair_mappings?key=${encodeURIComponent(m.key)}`, { method: 'DELETE' });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    mappings = mappings.filter((x) => x.key !== m.key);
                    renderRows();
                } catch (e) {
                    console.warn('[Neo Repair] delete mapping:', e);
                    showToast(app, 'error', t('映射删除失败'), String(e.message || e));
                }
            };
            row.append(label, del);
            body.appendChild(row);
        }
    };

    clearBtn.onclick = async () => {
        try {
            const resp = await api.fetchApi('/neo_nodes/repair_mappings?key=all', { method: 'DELETE' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            mappings = [];
            renderRows();
        } catch (e) {
            console.warn('[Neo Repair] clear mappings:', e);
            showToast(app, 'error', t('映射清空失败'), String(e.message || e));
        }
    };

    renderRows();
    overlay.appendChild(box);
    document.body.appendChild(overlay);
}

app.registerExtension({
    name: "comfy.neo.workflowRepairHook",
    // 导入工作流后自动检测失效模型路径并提示修复（挂载 loadGraphData / loadApiJson）。
    // 顶栏 菜单按钮与下拉菜单归 top-menu.js（runRepair / showRepairLogDialog /
    // showRepairMappingsDialog 由本模块导出供其调用）。
    setup() {
        installImportRepairHook();
    },
});
