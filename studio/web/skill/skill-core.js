/**
 * skill-core.js
 * Skill 模块共享底座（skill.js 门面与 skill-writeback / skill-detail-popup 共用）：
 * - API：listSkills / loadSkill / saveSkill / deleteSkill / uploadSkill
 *        listSkillFiles / loadSkillFile / saveSkillFile / deleteSkillFile
 * - 共享：Markdown 渲染、分类标签、技能下拉填充、工作流模板预渲染、回写变更记录、弹窗外壳
 */

// Markdown 渲染复用 ComfyUI 内置同款库（marked + DOMPurify），breaks:true 保留单行换行
import "../marked.min.js";
import "../purify.min.js";
import { app } from "../../../scripts/app.js";
import { mkEl } from "../dom-utils.js";
import { applyWorkflowParams, injectRuntimeLoras, canvasLayout } from "../workflow-graph.js";
import { getNodeDef } from "../js/core/object-info.js";
import { showToast } from "../gallery-utils.js";
import { copySkillFiles, videoSuggestion, videoAudioVaeSuggestion, videoVideoVaeSuggestion } from "../image-gen.js";
import { t, getLang } from "../js/core/i18n.js";

// 共享 UI 小工具：技能增删改广播、弹窗内指针事件拦截（不冒泡到画布选节点）
function dispatchSkillsUpdated() {
    document.dispatchEvent(new CustomEvent("rs.skills.updated"));
}
function stopPointerBubble(el) {
    ["pointerdown", "mousedown", "mouseup", "click"].forEach((t) => el.addEventListener(t, (e) => e.stopPropagation()));
}
/** 修复样式遮罩弹窗外壳：head（标题 + ✕）/ body / foot，点遮罩关闭。
 *  extraClass 兼作同窗去重选择器（同名只留一个），onClose 在关闭时回调。 */
function makeRepairDialog(title, extraClass, onClose) {
    if (extraClass) {
        const existing = document.querySelector(`.${extraClass}`);
        if (existing) existing.remove();
    }
    const overlay = mkEl("div", extraClass ? `rs-repair-overlay ${extraClass}` : "rs-repair-overlay");
    const box = mkEl("div", "rs-repair-box");
    const head = mkEl("div", "rs-repair-head");
    const titleEl = mkEl("span", "");
    titleEl.textContent = title;
    const closeBtn = mkEl("button", "rs-repair-close");
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    head.append(titleEl, closeBtn);
    const body = mkEl("div", "rs-repair-body");
    const foot = mkEl("div", "rs-repair-foot");
    box.append(head, body, foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = () => {
        overlay.remove();
        if (onClose) onClose();
    };
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    return { overlay, box, head, body, foot, titleEl, closeBtn, close };
}
// ==========================================
// Skill API
// ==========================================

/** 列出所有 skill（任务 + 模板统一元数据，不含正文） */
async function listSkills() {
    try {
        const res = await fetch("/rs_prompts/skills");
        return await res.json();
    } catch (e) {
        console.error("Failed to list skills:", e);
        return [];
    }
}

// 技能 API 的统一 JSON POST：!res.ok 与异常归一成调用方约定的失败形状
async function postJson(path, body, label, fail) {
    try {
        const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) return fail(await res.text());
        return await res.json();
    } catch (e) {
        console.error(`Failed to ${label}:`, e);
        return fail(e.message);
    }
}
const apiFail = (m) => ({ success: false, error: m });
const loadFail = (m) => ({ error: m });

/** 加载单个 skill 完整数据（元数据 + 拼接正文 + 文件列表） */
async function loadSkill(id) {
    return postJson("/rs_prompts/load_skill", { id }, "load skill", loadFail);
}

/** 加载技能工作流模板（API prompt，/neo_image_gen/skill_workflow）；缺失返回 null */
async function loadSkillWorkflow(id) {
    try {
        const res = await fetch(`/neo_image_gen/skill_workflow?skill_id=${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return (data && data.workflow) || null;
    } catch (e) {
        console.error("Failed to load skill workflow:", e);
        return null;
    }
}
// ResolutionSelector 的 aspect_ratio 是 combo，只认这几个写法（与后端 image_gen.ASPECT_LABELS 同一份）
const ASPECT_LABELS = {
    "1:1": "1:1 (Square)", "2:3": "2:3 (Portrait Photo)", "3:2": "3:2 (Photo)",
    "3:4": "3:4 (Portrait Standard)", "4:3": "4:3 (Standard)",
    "9:16": "9:16 (Portrait Widescreen)", "16:9": "16:9 (Widescreen)", "21:9": "21:9 (Ultrawide)",
};

/** 技能里的比例（"16:9" / "16:9 (Widescreen)" / "1.78"）→ combo 项；combo 没有这一档返回 null */
function aspectComboValue(ratio) {
    const m = String(ratio || "").trim().split(" ")[0].match(/^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/i);
    if (!m || !(parseFloat(m[1]) > 0) || !(parseFloat(m[2]) > 0)) return null;
    return ASPECT_LABELS[`${parseFloat(m[1])}:${parseFloat(m[2])}`] || null;
}

// 工作流模板预渲染的已知参数：设置显式值优先，空值回落自动建议模型（与设置区「自动」项一致）；
// 运行时变量（提示词/种子/参考图）不填。genInfo = { config, models }，来自设置区加载结果。
function workflowParamValues(isVideo, genInfo) {
    const cfg = (genInfo && genInfo.config) || {};
    const models = (genInfo && genInfo.models) || {};
    const values = {};
    if (isVideo) {
        values.MODEL = cfg.model || videoSuggestion(models.diffusion_models || []);
        values.TEXT_ENCODER = cfg.text_encoder || videoSuggestion(models.text_encoders || []);
        values.VAE = cfg.vae || videoVideoVaeSuggestion(models.vae || []);
        values.AUDIO_VAE = cfg.audio_vae || videoAudioVaeSuggestion(models.vae || []);
        values.STEPS = cfg.steps ?? 20;
        values.WIDTH = cfg.width ?? 1344;
        values.HEIGHT = cfg.height ?? 768;
        values.LENGTH = cfg.length ?? 124;
    } else {
        values.MODEL = cfg.model || models.suggested_diffusion_models;
        values.TEXT_ENCODER = cfg.text_encoder || models.suggested_text_encoders;
        values.VAE = cfg.vae || models.suggested_vae;
        values.STEPS = Number.isFinite(cfg.steps) && cfg.steps > 0 ? cfg.steps : 20;
        values.COUNT = cfg.count ?? 1;
        values.PREFIX = cfg.output_prefix || "NeoAgent";
        const [w, h] = defaultSizeFromConfig(cfg);
        values.WIDTH = w;
        values.HEIGHT = h;
        // 「来源」说明要引用这两项真设置（长边尺寸 / 默认比例），照字面写出来才不会把 megapixels
        // 说成技能里存的值；小写键不与 {{TOKEN}} 同名，不会参与模板替换
        values.base_resolution = Math.max(256, parseInt(cfg.base_resolution, 10) || 1280);
        values._ratio_text = String(cfg.default_ratio || "1:1").trim() || "1:1";
        // 参考槽预处理里的 ImageScale 目标：后端 _edit_canvas_size 按 32 对齐，number widget 必须是数字
        const round32 = (v) => Math.max(32, Math.floor(v / 32 + 0.5) * 32);
        values.CANVAS_WIDTH = round32(w);
        values.CANVAS_HEIGHT = round32(h);
        // 分辨率选择器灌的两项：百万像素由默认宽高反算（夹在节点的 0.1~16 区间里），
        // 比例必须落进 combo 认得的 label，落不进去就不灌、保持画布上的原值
        values.MEGAPIXELS = Math.min(16, Math.max(0.1, Math.round(w * h / 1048576 * 100) / 100));
        const combo = aspectComboValue(cfg.default_ratio);
        if (combo) values.ASPECT_RATIO = combo;
    }
    for (const [i, entry] of (cfg.loras || []).entries()) {
        const name = typeof entry === "string" ? entry : (entry && entry.name);
        if (!name) continue;
        values[`LORA_${i + 1}_NAME`] = name;
        values[`LORA_${i + 1}_STRENGTH`] = String(typeof entry === "string" ? 1.0 : (entry.strength ?? 1.0));
    }
    return values;
}

// 画布 import 的 number widget 的 keys：模板预渲染把纯数字串归 number（与后端 render_template typed values 一致）
const NUMERIC_WIDGET_KEYS = new Set(["width", "height", "batch_size", "seed", "steps", "length"]);

// 默认宽高：长边 base_resolution、比例 default_ratio（与后端 resolve_dimensions 一致，对齐 16）
function defaultSizeFromConfig(cfg) {
    // 后端 _round_multiple 是 int(v / 16 + 0.5) * 16，正数即向下取整；用 Math.round 会把 16 的整数倍
    // 整头抬高一格（1024 → 1040），预览尺寸与百万像素就永远比真实生成值大一档
    const round16 = (v) => Math.max(16, Math.floor(v / 16 + 0.5) * 16);
    const longSide = Math.max(256, parseInt(cfg.base_resolution, 10) || 1280);
    let ratio = 1.0;
    const text = String(cfg.default_ratio || "1:1").trim();
    const m = text.match(/^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/i);
    if (m && parseFloat(m[2]) > 0) ratio = parseFloat(m[1]) / parseFloat(m[2]);
    else { const f = parseFloat(text); if (f > 0) ratio = f; }
    return ratio >= 1.0 ? [round16(longSide), round16(longSide / ratio)] : [round16(longSide * ratio), round16(longSide)];
}

// 画布 widget 值归一：number widget 的纯数字串归 number、提示词占串清空（与后端 render_template 的 typed values 一致）
function toCanvasTypedValues(wf) {
    for (const node of Object.values(wf)) {
        const inputs = (node || {}).inputs;
        if (!inputs) continue;
        for (const [k, v] of Object.entries(inputs)) {
            if (typeof v !== "string") continue;
            const s = v.split("{{PROMPT}}").join("").split("{{NEGATIVE}}").join("");
            inputs[k] = NUMERIC_WIDGET_KEYS.has(k) && /^\d+$/.test(s) ? Number(s) : s;
        }
    }
    return wf;
}

// 画布导入按技能已保存配置灌 widget：画布导出成技能时只有主链值被占位符化（生图 steps、SeedNode.seed
// 等保持写死），只替换 {{TOKEN}} 会让画布显示导出时的旧值。这里按后端 _template_from_workflow /
// _template_video_from_workflow 的同一套键位，把技能 config 推出的值覆盖进图里已存在的 widget；
// 连线输入不动，模板里没有的槽位不加。
const CONFIG_WIDGET_TARGETS = {
    UNETLoader: { unet_name: "MODEL" },
    CLIPLoader: { clip_name: "TEXT_ENCODER" },
    KSampler: { seed: "SEED", steps: "STEPS" },
    KSamplerAdvanced: { seed: "SEED", steps: "STEPS" },
    SeedNode: { seed: "SEED" },
    EmptyLatentImage: { width: "WIDTH", height: "HEIGHT", batch_size: "COUNT" },
    EmptySD3LatentImage: { width: "WIDTH", height: "HEIGHT", batch_size: "COUNT" },
    SaveImage: { filename_prefix: "PREFIX" },
    // 导出技能时勾选了「百万像素 / 比例」的技能：画布导入按技能 config 的比例与分辨率灌这两项
    ResolutionSelector: { aspect_ratio: "ASPECT_RATIO", megapixels: "MEGAPIXELS" },
};
const MINIMAX_H3_TARGETS = { width: "WIDTH", height: "HEIGHT", length: "LENGTH" };
const NUMERIC_WIDGET_FIELDS = new Set(["seed", "steps", "width", "height", "batch_size", "length", "megapixels"]);

function forceCanvasConfigValues(wf, values, isVideo) {
    // 与后端一致：喂 VAEDecodeAudio 的 VAELoader 是音频 VAE，灌 AUDIO_VAE 而不是视频 VAE
    const audioVaeIds = new Set();
    for (const node of Object.values(wf)) {
        const vae = node && node.class_type === "VAEDecodeAudio" ? (node.inputs || {}).vae : null;
        if (Array.isArray(vae)) audioVaeIds.add(String(vae[0]));
    }
    for (const [id, node] of Object.entries(wf)) {
        const ct = (node || {}).class_type;
        if (!ct) continue;
        const targets = ct.startsWith("MiniMaxH3") ? MINIMAX_H3_TARGETS
            : ct === "VAELoader" ? { vae_name: isVideo && audioVaeIds.has(id) ? "AUDIO_VAE" : "VAE" }
                : CONFIG_WIDGET_TARGETS[ct];
        if (!targets) continue;
        const inputs = node.inputs || {};
        for (const [key, valueKey] of Object.entries(targets)) {
            if (!(key in inputs) || Array.isArray(inputs[key])) continue;
            const raw = values[valueKey];
            if (raw === undefined || raw === null || raw === "") continue;
            if (!NUMERIC_WIDGET_FIELDS.has(key)) { inputs[key] = String(raw); continue; }
            const num = Number(raw);
            if (Number.isFinite(num)) inputs[key] = num;
        }
    }
    return wf;
}

// 画布导入时把 LoadImage 的 {{REF_IMAGE_N}} / {{CONTROL_IMAGE}} 占位符替换为 combo 里的实际图片，避免红框
const REF_IMAGE_SLOT_RE = /^\{\{REF_IMAGE_(\d+)\}\}$/;
const CONTROL_IMAGE_RE = /^\{\{CONTROL_IMAGE\}\}$/;
async function replaceRefImagePlaceholders(wf, controlRef = 0) {
    // 只要 LoadImage 一个节点的 combo（全量 /object_info 十几 MB，逐次拉会把点击卡成秒级）
    const combo = (await getNodeDef("LoadImage"))?.input?.required?.image?.[0];
    if (!Array.isArray(combo) || !combo.length) return wf;
    for (const node of Object.values(wf)) {
        if (!node || node.class_type !== "LoadImage") continue;
        const img = (node.inputs || {}).image;
        if (typeof img !== "string") continue;
        const m = REF_IMAGE_SLOT_RE.exec(img);
        if (m) node.inputs.image = combo[(Number(m[1]) - 1) % combo.length];
        // 控制图槽位：按技能 config 的 control_ref（第几张参考图）取同一张，与后端 control_image 同口径
        else if (CONTROL_IMAGE_RE.test(img)) node.inputs.image = combo[Math.max(0, controlRef - 1) % combo.length];
    }
    return wf;
}

/** 技能模板 → 预渲染工作流：灌 config 值、LoRA 注入、尺寸归一、换参考图槽位。
 *  runtime=true 为画布导入：种子归零、参考宽高跟随尺寸、widget 值归 typed；
 *  runtime=false 为内嵌编辑器：保留运行时 {{变量}} 原串与 widget 原值。 */
async function buildCanvasWorkflow(wf, cfg, models, isVideo, { runtime = true, controlRef = 0 } = {}) {
    const values = workflowParamValues(isVideo, { config: cfg, models });
    if (runtime) {
        values.SEED = 0;
        values.REF_WIDTH = values.WIDTH;
        values.REF_HEIGHT = values.HEIGHT;
    }
    const filled = applyWorkflowParams(injectRuntimeLoras(wf, cfg.loras), values);
    const shaped = forceCanvasConfigValues(runtime ? toCanvasTypedValues(filled) : filled, values, isVideo);
    return await replaceRefImagePlaceholders(shaped, controlRef);
}

// 载入画布后按流程图同一套布局重排：拓扑分层 → 左到右排布、参考加载器统一在最左列、列内按上游重心堆叠、
// 短列垂直居中，同列宽度拉齐到最宽节点（模型加载节点按模型名加长），最后适配视图。
// 加宽后带预览的 LoadImage 会重算高度，所以先套宽度、再按新尺寸排第二轮位置，同列才不会叠块。
function arrangeCanvasNodes(wf) {
    const nodes = app.graph && app.graph._nodes;
    if (!nodes || !nodes.length) return;
    const byId = new Map(nodes.map(n => [String(n.id), n]));
    const sizeOf = (id) => (byId.get(id) || {}).size;
    // 模板的 mode（参考视频/音频槽位默认跳过 bypass）：loadApiJson 不读 API prompt 里的 mode，灌完画布补上
    for (const [id, node] of Object.entries(wf)) {
        const n = byId.get(id);
        if (n && Number.isInteger(node?.mode)) n.mode = node.mode;
    }
    for (const cell of canvasLayout(wf, sizeOf)) {
        const node = byId.get(cell.id);
        if (node && cell.w > node.size[0]) node.setSize([cell.w, node.size[1]]);
    }
    for (const cell of canvasLayout(wf, sizeOf)) {
        const node = byId.get(cell.id);
        if (!node) continue;
        node.setPos(cell.x, cell.y);
    }
    app.graph.setDirtyCanvas(true, true);
    if (typeof app.canvas?.fitViewToSelectionAnimated === "function") app.canvas.fitViewToSelectionAnimated();
}

// 画布 → API prompt：graphToPrompt 跳过 mode 2（NEVER）与 mode 4（BYPASS）的节点，参考视频/音频槽位默认跳过 → 取前临时启用，取完还原
async function serializeCanvasPrompt() {
    const slots = (app.graph?._nodes || []).filter((n) => (n.type === "LoadVideo" || n.type === "LoadAudio") && n.mode === 4);
    try {
        for (const n of slots) n.mode = 0;
        return (await app.graphToPrompt()) || {};
    } finally {
        for (const n of slots) n.mode = 4;
    }
}

/** localStorage 按技能 id 关联的追加式记录（新→旧，每技能上限 limit 条） */
function makeSkillLog(key, limit, label) {
    const read = () => {
        try { const l = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(l) ? l : []; } catch (e) { return []; }
    };
    const write = (log) => {
        try { localStorage.setItem(key, JSON.stringify(log)); } catch (e) { console.warn(`[Neo Skill] ${label}写入失败:`, e); }
    };
    return {
        get: (skillId) => skillId ? read().filter((e) => e.skillId === skillId) : read(),
        clear: (skillId) => write(skillId ? read().filter((e) => e.skillId !== skillId) : []),
        record(skillId, entry) {
            const log = read();
            const mine = log.filter((e) => e.skillId === skillId);
            const others = log.filter((e) => e.skillId !== skillId);
            mine.unshift({ skillId, time: new Date().toISOString(), ...entry });
            write([...mine.slice(0, limit), ...others]);
        },
    };
}

// ---- 回写变更记录（每技能上限 50 条）----
const SKILL_WRITE_LOG_LIMIT = 50;
const WRITE_SOURCE_LABELS = { canvas: t("画布回写"), editor: t("内嵌编辑") };
// 节点位置 / 颜色 / 分组 / 折叠只存在于 LiteGraph 序列化，API prompt 不携带 → 回写不保存界面布局
const WRITE_API_ONLY_NOTE = t("仅保存 API 工作流（节点、连线、widget 值）：画布上的节点位置、颜色、分组、折叠状态等界面布局不写入，skill.md 正文保留");
const writeLog = makeSkillLog("neo.skillWriteLog", SKILL_WRITE_LOG_LIMIT, t("变更记录"));

/** 变更清单表格（项 / 原值 删除线 / 新值）：回写确认弹窗与变更记录共用 */
function buildWriteChangesTable(changes) {
    const table = document.createElement("table");
    table.style.cssText = "width:100%;border-collapse:collapse;table-layout:fixed;font-size:12.5px;";
    const cell = (txt, style) => {
        const td = document.createElement("td");
        td.textContent = txt === 0 || txt ? String(txt) : "";
        td.title = td.textContent;
        td.style.cssText = "padding:5px 8px;border-bottom:1px solid #333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" + (style || "color:#ccc;");
        return td;
    };
    const headRow = document.createElement("tr");
    for (const h of [t("项"), t("原值"), t("新值")]) {
        const th = document.createElement("th");
        th.textContent = h;
        th.style.cssText = "position:sticky;top:0;background:#2a2a2a;color:#9ab;text-align:left;padding:6px 8px;border-bottom:1px solid #444;";
        headRow.appendChild(th);
    }
    table.appendChild(headRow);
    for (const c of changes) {
        const tr = document.createElement("tr");
        tr.append(cell(c.field), cell(c.from, "color:#e88;text-decoration:line-through;"), cell(c.to, "color:#7d7;"));
        table.appendChild(tr);
    }
    return table;
}
/** 保存/更新 skill 主文件 skill.md（预设只读） */
async function saveSkill(skill) {
    return postJson("/rs_prompts/save_skill", skill, "save skill", apiFail);
}

/** 删除整个 skill 目录（预设不可删） */
async function deleteSkill(id) {
    return postJson("/rs_prompts/delete_skill", { id }, "delete skill", apiFail);
}

/**
 * 上传 skill。payload 二选一：
 *   - { zipFile: File }                         —— 单个 .zip
 *   - { files: [{ path, blob }], skillId? }     —— 目录清单（多个 .md）
 */
async function uploadSkill(payload) {
    const form = new FormData();
    if (payload.skillId) form.append("skill_id", payload.skillId);
    if (payload.zipFile) {
        form.append("file", payload.zipFile, payload.zipFile.name);
    } else if (payload.files && payload.files.length) {
        form.append("manifest", JSON.stringify(payload.files.map(f => f.path)));
        for (const f of payload.files) {
            const blob = f.blob instanceof Blob ? f.blob : new Blob([f.blob]);
            form.append("files", blob, f.path);
        }
    } else {
        return { success: false, error: "No upload payload" };
    }
    try {
        const res = await fetch("/rs_prompts/upload_skill", { method: "POST", body: form });
        if (!res.ok) return { success: false, error: await res.text() };
        return await res.json();
    } catch (e) {
        console.error("Failed to upload skill:", e);
        return { success: false, error: e.message };
    }
}

/** 列出 skill 的文件（后端无独立接口，取自 load_skill.files） */
async function listSkillFiles(id) {
    const full = await loadSkill(id);
    if (!full || full.error) return [];
    return full.files || [];
}

/** 加载 skill 目录内某个 .md 文件内容（仅限扁平文件名） */
async function loadSkillFile(id, file) {
    return postJson("/rs_prompts/load_skill_file", { id, file }, "load skill file", loadFail);
}

/** 保存 skill 目录内某个 .md 文件（仅限扁平文件名） */
async function saveSkillFile(id, file, content) {
    return postJson("/rs_prompts/save_skill_file", { id, file, content }, "save skill file", apiFail);
}

/** 删除 skill 目录内某个 .md 文件（skill.md 不可删） */
async function deleteSkillFile(id, file) {
    return postJson("/rs_prompts/delete_skill_file", { id, file }, "delete skill file", apiFail);
}

/** 预设技能生图/生视频设置恢复默认（删除本地覆盖文件） */
async function resetSkillGenConfig(id) {
    return postJson("/rs_prompts/reset_skill_config", { id }, "reset skill config", apiFail);
}
// ==========================================
// Markdown 渲染：marked（GFM + breaks:true 保留换行）+ DOMPurify 消毒，防 LLM/用户内容注入
// ==========================================
function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(src) {
    const text = String(src == null ? "" : src);
    if (!text) return "";
    // 首选：marked（GFM + breaks:true 保留单行换行）+ DOMPurify 消毒，防止 LLM/用户内容注入 HTML
    if (window.marked && window.DOMPurify) {
        return window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true, breaks: true }));
    }
    // 回退：ComfyUI 内置渲染器（已消毒，但不保留单行换行）
    const app = window.comfyAPI?.app;
    if (app?.extensionManager?.renderMarkdownToHtml) {
        return app.extensionManager.renderMarkdownToHtml(text);
    }
    // 最后兜底：转义纯文本 + 手动换行
    return escapeHtml(text).replace(/\n/g, "<br>");
}

// ==========================================
// skill 选择列表：分类标签 + 把 skills 填充进原生 <select>（combo-box 数据源）
// ==========================================
// 提示词节点技能列表：图像/视频提示词增强排最前（仅次于 select 顶部的「默认」项，原生 option 恒在 optgroup 之前），
// 反推 / 直接生图或编辑 / custom 依次跟随；video_gen（生视频）与 task 为内部使用技能，不在下拉与 / 快捷菜单显示（hidden），task 也不进技能管理窗口左列表（managerHidden）；未知分类回落 image_enhance
const CATEGORY_LABELS = {
    "image_enhance": { label: t("图像提示词增强"), order: 0 },
    "video_enhance": { label: t("视频提示词增强"), order: 1 },
    "vision": { label: t("图像 / 反推"), order: 2 },
    "image_gen": { label: t("直接生图或编辑"), order: 3 },
    "custom": { label: t("自定义"), order: 4 },
    "video_gen": { label: t("生视频 (H3)"), order: 5, hidden: true },
    "task": { label: t("任务"), order: 6, hidden: true, managerHidden: true }
};

/** 技能显示名：中文界面用 cn_name（中文名）；英文界面不回落中文名，直接用 name / id。
 *  只用于显示——节点 combo 的取值、反查、持久化仍走 cn_name（见 skill.js / director-node.js）。 */
function skillDisplayName(s) {
    if (!s) return "";
    if (getLang() === "en") return s.name || s.id || "";
    return s.cn_name || s.name || s.id || "";
}

/** 生图技能的输入形态：t2i = 纯文生图；edit = 必须带参考图；t2i_edit = 两者皆可（Qwen Image 2.1 生图/编辑）。
 *  预设由 skill.md 的 mode 声明；画布导入的用户技能没有 mode，回落 requires_ref（画布回写按模板占位维护它）。 */
function skillImageMode(s) {
    const m = s && s.mode;
    if (m === "edit" || m === "t2i_edit" || m === "t2i") return m;
    return s && s.requires_ref ? "edit" : "t2i";
}
/** 能当文生图用：文生图页与分镜 t2i 模式只列这些（挂参考图也没槽位收，选了等于白挂） */
function skillAcceptsText(s) {
    const m = skillImageMode(s);
    return m === "t2i" || m === "t2i_edit";
}
/** 能当参考图编辑用：图片编辑页与分镜 r2i 模式只列这些（纯文生图模板会静默丢掉原图） */
function skillAcceptsRef(s) {
    const m = skillImageMode(s);
    return m === "edit" || m === "t2i_edit";
}

/** 把 skills 元数据填充进原生 <select>：按 category 分组为 optgroup，option 带 (需图) 徽标与 multiTurn 标记；
 *  includeHidden=true 时连 hidden 分类（task / video_gen）一起列出 */
function populateSkillOptions(selectEl, skills, { includeHidden = false } = {}) {
    if (!skills || !skills.length) return;
    const groups = {};
    skills.forEach(s => {
        const cat = CATEGORY_LABELS[s.category] ? s.category : "image_enhance";
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(s);
    });
    Object.keys(groups).sort((a, b) =>
        (CATEGORY_LABELS[a]?.order ?? 99) - (CATEGORY_LABELS[b]?.order ?? 99)
    ).filter(cat => includeHidden || !CATEGORY_LABELS[cat].hidden).forEach(cat => {
        const optgroup = mkEl("optgroup");
        optgroup.label = CATEGORY_LABELS[cat].label;
        groups[cat].forEach(s => {
            const opt = mkEl("option");
            opt.value = s.id;
            opt.dataset.multiTurn = s.multi_turn ? "1" : "";
            opt.dataset.source = s.source || "";
            // 生图 skill 元数据：genImage 走后端生图分支，
            // requiresRef 标记四视图（必须带参考图，缺图在预览区底部报错）
            opt.dataset.genImage = s.gen_image ? "1" : "";
            opt.dataset.requiresRef = s.requires_ref ? "1" : "";
            // tags（含后端追加的中文拼音/首字母缩写）供 combo box 搜索匹配
            opt.dataset.tags = (s.tags || []).join(" ");
            opt.__skillMeta = s; // 完整元数据（gen_config / 分类 / 名称）供浮动预览卡读取
            const imgBadge = s.needs_image ? "" : "";
            opt.textContent = `${imgBadge}${skillDisplayName(s)}`;
            optgroup.appendChild(opt);
        });
        selectEl.appendChild(optgroup);
    });
}
const SKILL_CHANGED_EVENT = "neo.skillChanged"; // 详情弹窗保存/修复后派发，节点状态条据此即时重检
function dispatchSkillChanged(skillId) {
    window.dispatchEvent(new CustomEvent(SKILL_CHANGED_EVENT, { detail: { skillId: String(skillId || "") } }));
}
/**
 * 复制技能为自定义副本（客户端 loadSkill + saveSkill，无专用后端接口）：连同 workflow.json / config.json 一起复制。
 * 详情弹窗「复制为自定义」与技能管理列表行内复制图标共用。成功返回 { id, name }，失败提示后返回 null。
 */
async function copySkillAsCustom(skillId, fallbackName = "") {
    const full = await loadSkill(skillId);
    if (full && full.error) { showToast(app, "error", t("复制失败"), full.error); return null; }
    const newId = `${skillId}_copy_${Date.now()}`;
    // 复制产生的 name 需与已有 skill 不重名（后端 save_skill 会 409），冲突时递增序号
    const baseName = ((full && full.name) || fallbackName || skillId) + " (Copy)";
    const takenNames = new Set((await listSkills()).map(s => (s.name || "").trim()));
    let copyName = baseName;
    for (let n = 2; takenNames.has(copyName); n++) copyName = `${baseName} ${n}`;
    const result = await saveSkill({
        id: newId,
        name: copyName,
        content: (full && full.content) || "",
        tags: [...((full && full.tags) || [])],
        source: "custom",
        multi_turn: !!(full && full.multi_turn),
        // 保留 frontmatter 元数据：生图/生视频技能复制后仍是原分类且设置区可见
        category: (full && full.category) || "",
        gen_image: !!(full && full.gen_image),
        gen_video: !!(full && full.gen_video),
        // 视频模式（t2v/i2v/fl2v/r2v）：导演编辑器的分段技能下拉按 skill.mode 过滤，复制后必须保留
        mode: (full && full.mode) || "",
        requires_ref: !!(full && full.requires_ref)
    });
    if (!result.success) { showToast(app, "error", t("复制失败"), result.error || "Unknown error"); return null; }
    await copySkillFiles(skillId, newId);
    dispatchSkillsUpdated();
    return { id: newId, name: copyName };
}

// ==========================================
// 导出
// ==========================================
export {
    dispatchSkillsUpdated, stopPointerBubble, makeRepairDialog,
    listSkills, loadSkill, loadSkillWorkflow, saveSkill, deleteSkill, uploadSkill,
    listSkillFiles, loadSkillFile, saveSkillFile, deleteSkillFile, resetSkillGenConfig,
    workflowParamValues, buildCanvasWorkflow, arrangeCanvasNodes, serializeCanvasPrompt,
    makeSkillLog, SKILL_WRITE_LOG_LIMIT, WRITE_SOURCE_LABELS, WRITE_API_ONLY_NOTE,
    writeLog, buildWriteChangesTable,
    escapeHtml, renderMarkdown, CATEGORY_LABELS, populateSkillOptions, skillDisplayName,
    skillImageMode, skillAcceptsText, skillAcceptsRef,
    SKILL_CHANGED_EVENT, dispatchSkillChanged, copySkillAsCustom
};
