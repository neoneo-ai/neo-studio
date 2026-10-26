/**
 * skill.js
 * Skill 模块门面：组装共享底座与拆分模块，统一对外导出。
 * 实现位于 web/skill/：skill-core.js（API 与共享底座）、skill-writeback.js（回写与画布交接）、
 * skill-detail-popup.js（单技能详情弹窗）。
 */

import { app } from "../../scripts/app.js";
import { attachComboBox } from "./combo-box.js";
import { mkEl } from "./dom-utils.js";
import { checkWorkflow, applyWorkflowParams, injectRuntimeLoras } from "./workflow-graph.js";
import { getSkillGenConfig, listGenModels, listVideoGenModels, shortModelName, videoSuggestion, saveWorkflowSkill, planWorkflowSkill } from "./image-gen.js";
import { showToast } from "./gallery-utils.js";
import {
    dispatchSkillsUpdated, stopPointerBubble, listSkills, loadSkill, saveSkill, deleteSkill,
    uploadSkill, listSkillFiles, loadSkillFile, saveSkillFile, deleteSkillFile,
    loadSkillWorkflow, workflowParamValues, populateSkillOptions, CATEGORY_LABELS,
    renderMarkdown, SKILL_CHANGED_EVENT, copySkillAsCustom, serializeCanvasPrompt, skillDisplayName,
    skillImageMode, skillAcceptsText, skillAcceptsRef,
} from "./skill/skill-core.js";
import {
    showSkillWriteLogDialog, openSkillWorkflowInMainUi, openSkillWorkflowOnCanvas,
    runSkillWorkflowHandoff, getPendingWriteback, runCanvasSkillWriteback,
} from "./skill/skill-writeback.js";
import { createSkillDetailPopup, getSkillDetailPopup, openSkillDetailById } from "./skill/skill-detail-popup.js";
import { t, tf } from "./js/core/i18n.js";
import { icon } from "./js/core/icons.js";

// ==========================================
// 节点级 Skill 有效性检测：选完 skill 后在节点底部提前提示「缺模型/缺节点」，可一键进详情修复
// - 节点的 skill 下拉 value 是技能「名称」（见 image_gen_edit/h3_video_gen 的 schema；旧工作流可能存的是
//   目录名/id）→ resolveSkillId 按与后端 _resolve_skill_id 同规则反查真实 skill，再取模板校验。
// - validateSkillForNode(skill, isVideo)：复用 checkWorkflow（对照 /object_info + /models/*），
//   只检测带 workflow.json 的生图/生视频 skill；结果按 (类型 + 真实 skill) 会话级缓存（TTL）+ 在途去重，检测失败不误报。
// - createSkillStatusRow({ getSkills, isVideo })：节点底部状态条 DOM 工厂（无问题隐藏、不占高），
//   聚合多个 skill 的缺失项显示「N 个模型缺失 · M 个节点未安装 → 查看详情/修复」，点击打开首个有问题的 skill 详情。
// - openSkillDetailById(skillId)：按 id 解析 source 后打开单技能详情弹窗（供节点状态条复用）。
// ==========================================

const SKILL_VALIDATION_TTL = 60_000; // 检测结果会话级缓存有效期（模型/节点可用性极少变化，过期自动重检）
const _skillValidationCache = new Map();    // key(类型: skill) -> { t, data }
const _skillValidationInflight = new Map(); // key -> Promise
let _skillNameLookup = { image: { t: 0, map: null }, video: { t: 0, map: null } }; // 技能名称 → 真实 skill（按生图/生视频各自建表）


/** 把节点下拉的 skill 名称（或旧工作流里存的 id）解析成真实 skill；名称表不可用时原样返回（按 id 兜底）。
 *  与后端 _resolve_skill_id 同规则：只认带 workflow.json 的同类型技能（名称取列表最后一个同名项），
 *  下拉 value 就是技能名称，所以校验前必须先反查，否则 /neo_image_gen/skill_workflow 拿不到模板。 */
async function resolveSkillId(skill, isVideo) {
    const ref = String(skill || "").trim().replace(/（不可用）$/, ""); // 下拉值可能带「（不可用）」后缀（h3_video_gen._skill_label），先剥掉再反查
    if (!ref) return "";
    const entry = _skillNameLookup[isVideo ? "video" : "image"];
    if (!entry.map || Date.now() - entry.t > SKILL_VALIDATION_TTL) {
        const list = await listSkills();
        const map = new Map();
        for (const s of Array.isArray(list) ? list : []) {
            if (!s || !s.id || !(isVideo ? s.gen_video : s.gen_image)) continue;
            map.set(String(s.id), s.id);
            if (s.cn_name) map.set(String(s.cn_name), s.id);
            if (s.name && s.name !== s.id) map.set(String(s.name), s.id);
        }
        if (map.size) { entry.map = map; entry.t = Date.now(); }
    }
    return (entry.map && entry.map.get(ref)) || ref;
}

/** 全量失效：技能可能已改名/新增/修复 → 下次重新反查名称并重校验（缓存很小，整体清比按名逐条准）。 */
function invalidateSkillValidation() {
    _skillValidationCache.clear();
    _skillNameLookup.image.t = 0;
    _skillNameLookup.video.t = 0;
}

/** 检测某个生图/生视频 skill（下拉里是技能名称，旧工作流可能是目录名/id）在本机是否可用（缺模型/缺节点）。
 *  返回 { ok, id, noWorkflow, missingNodes:[], missingModels:[] }，id 为反查出的真实 skill（供打开详情用）。 */
async function validateSkillForNode(skill, isVideo) {
    const id = await resolveSkillId(skill, isVideo);
    if (!id) return { ok: true, id: "", empty: true, missingNodes: [], missingModels: [] };
    const key = (isVideo ? "vid:" : "img:") + id;
    const hit = _skillValidationCache.get(key);
    if (hit && Date.now() - hit.t < SKILL_VALIDATION_TTL) return hit.data;
    if (_skillValidationInflight.has(key)) return _skillValidationInflight.get(key);

    const p = (async () => {
        let data;
        try {
            const workflow = await loadSkillWorkflow(id);
            if (!workflow) {
                data = { ok: true, id, noWorkflow: true, missingNodes: [], missingModels: [] }; // 无 workflow.json → 无模型依赖可查
            } else {
                const [config, models] = await Promise.all([
                    getSkillGenConfig(id).catch(() => ({})),
                    (isVideo ? listVideoGenModels() : listGenModels()).catch(() => ({})),
                ]);
                const cfg = config || {};
                const genInfo = { config: cfg, models: models || {} };
                const rendered = applyWorkflowParams(injectRuntimeLoras(workflow, cfg.loras), workflowParamValues(isVideo, genInfo));
                const validation = await checkWorkflow(rendered);
                const c = validation.counts || {};
                const missingNodes = [], missingModels = [];
                for (const list of Object.values(validation.issues || {})) {
                    for (const i of list) {
                        if (i.kind === "missing_node" && i.value && !missingNodes.includes(i.value)) missingNodes.push(i.value);
                        else if (i.kind === "missing_model" && i.value && !missingModels.includes(i.value)) missingModels.push(i.value);
                    }
                }
                data = { ok: !(c.missingNodes || 0) && !(c.missingModels || 0), id, noWorkflow: false, missingNodes, missingModels };
            }
        } catch (e) {
            console.warn("[Neo Studio] validateSkillForNode failed", e);
            data = { ok: true, id, noWorkflow: false, error: String(e), missingNodes: [], missingModels: [] }; // 检测失败不误报
        }
        _skillValidationCache.set(key, { t: Date.now(), data });
        return data;
    })();
    _skillValidationInflight.set(key, p);
    try { return await p; } finally { _skillValidationInflight.delete(key); }
}

/** 节点底部 Skill 有效性状态条：返回 { el, refresh, destroy }。getSkills() 返回要检测的 skill 引用（下拉 value
 *  即技能名称，旧工作流可能是目录名/id），内部先反查真实 skill 再校验（重复项去重）。
 *  无问题/无 workflow 时隐藏（不占高），有缺失显示聚合告警并可点开首个有问题的 skill 详情；节点移除时调 destroy() 注销监听。 */
function createSkillStatusRow(opts) {
    const isVideo = !!opts.isVideo;
    const getSkills = opts.getSkills || (() => []);
    const el = document.createElement("div");
    el.className = "neo-skill-status";
    el.style.display = "none";

    let seq = 0;
    let currentKey = "";

    function render(agg) {
        el.innerHTML = "";
        const show = agg && agg.hasWorkflow && ((agg.missingModels || []).length || (agg.missingNodes || []).length);
        if (!show) { el.style.display = "none"; return; }
        el.style.display = "";
        el.classList.add("neo-skill-status-warn");
        const parts = [];
        if (agg.missingModels.length) parts.push(tf("{n} 个模型缺失", { n: agg.missingModels.length }));
        if (agg.missingNodes.length) parts.push(tf("{n} 个节点未安装", { n: agg.missingNodes.length }));
        const label = document.createElement("span");
        label.className = "neo-skill-status-label";
        label.textContent = "" + parts.join(" · ");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "neo-skill-status-open";
        btn.textContent = t("查看详情/修复 →");
        btn.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
        btn.addEventListener("click", (e) => { e.stopPropagation(); openSkillDetailById(agg.firstBadId); });
        el.append(label, btn);
    }

    const refresh = async (force = false) => {
        const s = ++seq;
        const skills = [...new Set((getSkills() || []).map((v) => String(v || "").trim()).filter(Boolean))];
        currentKey = skills.join("\u0000");
        if (!skills.length) { render({ hasWorkflow: false }); return; }
        if (force) invalidateSkillValidation(); // 事件（保存/修复/改名）后全量失效，重新反查名称与校验
        render(null); // 检测中先清旧告警，避免闪现过期红条
        const missingModels = [], missingNodes = [];
        let hasWorkflow = false, firstBadId = null;
        for (const skill of skills) { // 顺序检测：把 /object_info·/models/* 的并发压到 1，同 skill 由在途去重兜住
            const d = await validateSkillForNode(skill, isVideo);
            if (d.noWorkflow) continue;
            hasWorkflow = true;
            for (const v of d.missingModels || []) if (!missingModels.includes(v)) missingModels.push(v);
            for (const v of d.missingNodes || []) if (!missingNodes.includes(v)) missingNodes.push(v);
            if (!firstBadId && ((d.missingModels || []).length || (d.missingNodes || []).length)) firstBadId = d.id;
        }
        if (s === seq && currentKey === skills.join("\u0000")) render({ hasWorkflow, missingModels, missingNodes, firstBadId });
    };

    // 整行不触发节点拖拽/选中；详情弹窗保存/修复后即时重检（force 绕过缓存）
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    const onSkillChanged = () => refresh(true);
    window.addEventListener(SKILL_CHANGED_EVENT, onSkillChanged);
    const destroy = () => window.removeEventListener(SKILL_CHANGED_EVENT, onSkillChanged);

    return { el, refresh, destroy };
}
// ==========================================
// 标题对话框：从画布导出技能时问名称 + 勾选要替换成技能变量的 widget。
// overlay 挂到 document.body，复用 skill 弹窗样式；Enter 提交、Esc/点遮罩取消，返回 Promise<{name, bindings}|null>。
// ==========================================
// config.json 的键 → 技能设置面板里的控件名（设置弹窗用的就是这两个词，行上要用同一个词才认得出改哪儿）
const SETTING_LABELS = { base_resolution: "长边尺寸", default_ratio: "默认比例" };
let _activeTitleDialog = null;
function promptSkillTitle(defaultValue = "", plan = null) {
    if (_activeTitleDialog) return _activeTitleDialog; // 避免重复弹层
    let resolveFn;
    const promise = new Promise((r) => { resolveFn = r; });

    const overlay = mkEl("div", "rs-skill-modal-overlay");
    const modal = mkEl("div", "rs-skill-modal rs-skill-title-dialog");
    const header = mkEl("div", "rs-skill-modal-header");
    const titleSpan = mkEl("span", "rs-skill-modal-title");
    titleSpan.textContent = t("从画布创建技能");
    header.appendChild(titleSpan);

    const body = mkEl("div", "rs-skill-modal-content");
    const row = mkEl("div", "rs-config-row");
    const label = mkEl("label", "rs-form-label");
    label.textContent = t("技能名称");
    const input = document.createElement("input");
    input.className = "rs-form-input rs-tpl-name";
    input.value = defaultValue;
    row.append(label, input);
    body.appendChild(row);

    // 变量替换清单：固定项由后端固定规则替换，候选项逐项勾选，不勾的保持画布里的写死值
    const binds = mkEl("div", "rs-skill-title-binds");
    const head = mkEl("div", "rs-skill-title-binds-head");
    head.textContent = t("替换为技能变量");
    const fixed = mkEl("div", "rs-skill-title-binds-note");
    fixed.textContent = plan && plan.gen_video
        ? t("固定替换：模型 / 编码器 / VAE / 提示词 / 宽高 / 时长")
        : t("固定替换：模型 / 编码器 / VAE / Seed / 张数 / 输出前缀 / 参考图 / 提示词编码");
    binds.append(head, fixed);
    const rows = [];
    for (const c of (plan && plan.candidates) || []) {
        const line = mkEl("label", "rs-skill-title-bind");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = true;
        const shown = String(c.value === undefined ? "" : c.value).replace(/\s+/g, " ").trim();
        // 尺寸两行的主语换成技能里真正存的那两项：画布上的 megapixels 不是设置项，勾上后
        // config.json 落的是 base_resolution / default_ratio，画布上那个数只是「当前值」参考
        const setting = c.setting && c.setting.key ? c.setting : null;
        const span = mkEl("span", "");
        span.textContent = setting
            ? tf("技能设置「{label}」{value} → {token}", {
                label: t(SETTING_LABELS[setting.key] || setting.key), value: setting.value, token: `{{${c.token}}}`,
            })
            : `${c.class_type} #${c.node} · ${c.field} → {{${c.token}}}`;
        const hint = !setting ? "" : c.token === "MEGAPIXELS"
            ? t("生成时按本次宽高重算，画布上的 megapixels 不保存")
            : t("生成时取 ResolutionSelector 下拉认得的那一项");
        span.title = `${c.class_type} #${c.node} · ${c.field} = ${shown}` + (hint ? ` · ${hint}` : "");
        const value = mkEl("span", "rs-skill-title-bind-value");
        const text = (setting ? t("画布当前 ") : "") + shown;
        value.textContent = text.length > 26 ? `${text.slice(0, 26)}…` : text;
        line.append(box, span, value);
        binds.appendChild(line);
        rows.push({ box, binding: { node: c.node, field: c.field, token: c.token } });
    }
    if (!rows.length) {
        const none = mkEl("div", "rs-skill-title-binds-note");
        none.textContent = t("画布里没有可额外勾选的替换项");
        binds.appendChild(none);
    } else if (rows.some((r) => r.binding.token === "MEGAPIXELS" || r.binding.token === "ASPECT_RATIO")) {
        // 行上的 base_resolution 是按画布这一次的 megapixels 反算出来的：不写这一行，用户会以为
        // 保存的是画布上的宽高（照字面理解 = 冻结当前值），也不知道 megapixels 这项数从哪来
        const calc = mkEl("div", "rs-skill-title-binds-note");
        calc.textContent = t("megapixels 不是技能设置项：它是「长边尺寸 × 默认比例」得到的宽高 ÷ 1024² 算出来的（夹在 0.1–16）；勾选只按画布这一次的值反算出上面两项设置，出图尺寸生成时按本次宽高重算");
        binds.appendChild(calc);
    }
    for (const w of (plan && plan.warnings) || []) {
        const warn = mkEl("div", "rs-skill-title-binds-note");
        warn.textContent = `${w}`;
        binds.appendChild(warn);
    }
    body.appendChild(binds);

    const btns = mkEl("div", "rs-modal-btns");
    const cancelBtn = mkEl("button", "rs-btn rs-btn-local");
    cancelBtn.type = "button";
    cancelBtn.textContent = t("取消");
    const okBtn = mkEl("button", "rs-btn rs-btn-local");
    okBtn.type = "button";
    okBtn.textContent = t("创建");
    btns.append(cancelBtn, okBtn);

    modal.append(header, body, btns);
    overlay.appendChild(modal);

    let done = false;
    const finish = (value) => {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        _activeTitleDialog = null;
        resolveFn(value);
    };
    const submit = () => {
        const v = input.value.trim();
        if (!v) { input.focus(); return; } // 名称必填：空则聚焦输入框，不关闭
        finish({ name: v, bindings: rows.filter((r) => r.box.checked).map((r) => r.binding) });
    };
    const onKey = (e) => {
        if (e.key === "Escape") finish(null);
        else if (e.key === "Enter") { e.preventDefault(); submit(); }
    };
    // 拦截弹窗内部指针事件向外冒泡，避免触发画布选节点等副作用（同详情弹窗）
    stopPointerBubble(modal);
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) finish(null); });
    okBtn.addEventListener("click", (e) => { e.stopPropagation(); submit(); });
    cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); finish(null); });

    overlay.style.display = "flex";
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => { input.focus(); input.select(); });

    _activeTitleDialog = promise;
    return promise;
}

/** 「从画布」两个入口共用：序列化画布 → 预览可替换的 widget → 名称 + 勾选 → 保存 */
async function exportCanvasAsSkill() {
    const { output, error } = await serializeCanvasPrompt();
    if (error || !output || !Object.keys(output).length) {
        showToast(app, "warning", t("无法导出"), t("画布上没有有效工作流") + (error?.message ? tf("（{msg}）", { msg: error.message }) : ""));
        return;
    }
    let plan = null;
    try {
        plan = await planWorkflowSkill(output);
    } catch (e) {
        // 预览拿不到候选也照常创建：模板只按固定规则替换
    }
    const picked = await promptSkillTitle("my-workflow", plan);
    if (!picked) return; // 用户在标题对话框取消
    const r = await saveWorkflowSkill({
        name: picked.name, description: "", tags: [], workflow: output, bindings: picked.bindings,
    });
    showToast(app, "success", tf("已保存{kind}技能 \"{id}\"", { kind: r.gen_video ? t("生视频") : t("生图"), id: r.id }), (r.warnings || []).join("\n"));
    dispatchSkillsUpdated();
}

// 共享的 ZIP / 目录上传隐藏 input：多个节点的技能下拉共用同一对，change 时上传并广播刷新
let _skillUploadInputs = null;
function getSkillUploadInputs() {
    if (_skillUploadInputs) return _skillUploadInputs;
    const zipInput = document.createElement("input");
    zipInput.type = "file";
    zipInput.accept = ".zip";
    zipInput.style.display = "none";
    const dirInput = document.createElement("input");
    dirInput.type = "file";
    dirInput.setAttribute("webkitdirectory", "");
    dirInput.style.display = "none";
    document.body.appendChild(zipInput);
    document.body.appendChild(dirInput);

    zipInput.addEventListener("change", async () => {
        const f = zipInput.files[0];
        zipInput.value = "";
        if (!f) return;
        const r = await uploadSkill({ zipFile: f });
        if (r.success) { alert(`Uploaded skill "${r.id}"`); dispatchSkillsUpdated(); }
        else alert("Upload failed: " + (r.error || ""));
    });
    dirInput.addEventListener("change", async () => {
        const all = Array.from(dirInput.files || []);
        dirInput.value = "";
        const textFiles = all.filter(f => /\.(md|txt)$/i.test(f.name));
        if (!textFiles.length) { alert("No .md/.txt files in the selected folder"); return; }
        const tops = [...new Set(textFiles.map(f => (f.webkitRelativePath || f.name).split("/")[0]))];
        const payload = { files: textFiles.map(f => ({ path: f.webkitRelativePath || f.name, blob: f })) };
        if (tops.length === 1) payload.skillId = tops[0];
        const r = await uploadSkill(payload);
        if (r.success) { alert(`Uploaded skill "${r.id}"`); dispatchSkillsUpdated(); }
        else alert("Upload failed: " + (r.error || ""));
    });

    _skillUploadInputs = { zipInput, dirInput };
    return _skillUploadInputs;
}

// ==========================================
// 技能选择弹窗（居中式，替代原生 combo 下拉）：
// - openSkillPickerModal()：通用居中弹窗（标题 + 搜索过滤 + 分组列表 + 可选底部管理工具栏）；
//   技能列表在右侧附浮动预览卡（生成技能 = 主模型 / LoRA / 长边尺寸 / 默认比例 / 步数，未保存字段显示与详情一致的自动默认值；其余技能 = skill.md 模板提示词正文摘录），随行焦点（键盘高亮 / hover）切换，点击打开详情弹窗
// - attachSkillPickerToComboWidget()：拦截 ComfyUI 画布 combo widget 的点击（widget.mouse），
//   弹出选择窗；选中写回 widget.value 并触发 callback（保留 Krea2/H3 既有的 loadDims/loadSpec 钩子）
// - attachSkillPickerToSelect()：拦截原生 <select>（导演编辑器分段技能下拉），同样弹居中窗口
// ==========================================

/** skill 元数据 → 选择窗 / 预览卡条目：value 是写回 combo 的合法值，skillId 按 id 打开详情（value 可能是 name） */
function skillItemFromMeta(s, value, label) {
    return {
        value,
        skillId: s.id || value,
        label,
        source: s.source || "custom",
        genImage: !!s.gen_image,
        genVideo: !!s.gen_video,
        genConfig: (s.gen_config && typeof s.gen_config === "object") ? s.gen_config : null, // 生图/生视频配置摘要（主模型 / LoRA / 长边 / 默认比例 / 步数）
    };
}

/** 把 skill 元数据映射为选择窗条目（value/label/badge/tags/source/group），按 category 分组排序。
 *  combo 的取值可能是 name 或 id：以实际出现在 allowed(options.values) 里的为准，保证写回合法；
 *  无 allowed 时默认用 name。 */
function skillItemsFromMeta(skills, allowed) {
    const items = [];
    for (const s of skills || []) {
        let value;
        if (allowed) {
            // combo 选项值 = cn_name || name（见 image_gen_edit._gen_image_skills）；不可用视频技能带「（不可用）」后缀（h3_video_gen._skill_label）；按此优先级匹配，保证写回合法
            // 「（不可用）」是与后端 _skill_label 对齐的协议串，不参与 i18n
            const candidates = [s.cn_name, s.name, s.id].filter(Boolean);
            if (s.available === false) candidates.unshift(`${s.cn_name || s.name || s.id}（不可用）`);
            value = candidates.find((c) => allowed.includes(c)) || null;
        } else {
            value = s.name || s.id;
        }
        if (!value) continue;
        const item = skillItemFromMeta(s, value, String(value).endsWith("（不可用）") ? value : skillDisplayName(s));
        item.badge = s.needs_image ? "" : "";
        item.tags = (s.tags || []).join(" ");
        item.group = CATEGORY_LABELS[s.category]?.label || "";
        items.push(item);
    }
    items.sort((a, b) => {
        if (a.group !== b.group) return a.group < b.group ? -1 : 1;
        return a.label.localeCompare(b.label);
    });
    return items;
}

/** 底部管理工具栏按钮（+ New Skill / ZIP / Folder / From Canvas）；onClose 在动作前关闭当前容器 */
function buildSkillManagementButtons(onClose) {
    const makeBtn = (label, title) => {
        const b = mkEl("button", "rs-btn rs-btn-local rs-skill-footer-btn");
        b.type = "button";
        b.textContent = label;
        b.title = title;
        b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        return b;
    };
    const newBtn = makeBtn("+ New Skill", "Create a new custom skill");
    newBtn.addEventListener("click", (e) => { e.stopPropagation(); onClose(); getSkillDetailPopup().openNew(); });
    const zipBtn = makeBtn("ZIP", "Upload a .zip skill package");
    zipBtn.addEventListener("click", (e) => { e.stopPropagation(); onClose(); getSkillUploadInputs().zipInput.click(); });
    const dirBtn = makeBtn("Folder", "Upload a skill folder (all .md files)");
    dirBtn.addEventListener("click", (e) => { e.stopPropagation(); onClose(); getSkillUploadInputs().dirInput.click(); });
    // 把当前画布工作流（API prompt）导出为生图技能：后端自动抽模板占位符 + LoRA 槽位
    const canvasBtn = makeBtn("From Canvas", "Export the current canvas workflow as a skill (image or H3 video)");
    canvasBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        onClose();
        try {
            await exportCanvasAsSkill();
        } catch (err) {
            showToast(app, "error", t("保存失败"), err.message);
        }
    });
    return [newBtn, zipBtn, dirBtn, canvasBtn];
}

/**
 * 打开居中技能选择弹窗。
 * opts: { title, items:[{value,label,badge,tags,source,group,skillId,genImage,genVideo,genConfig}], currentValue, onPick(value,item), showFooter }
 * 返回 { close, overlay }；每次调用新建并挂到 body，close 时移除。
 * 同一时刻只允许一个选择窗：重复点击 / 异步竞态（连点 combo）不会叠加出多个弹窗。
 */
// 把 anchor（DOM 元素 / 带 clientX/clientY 的指针事件 / {left,top,width,height}）归一成视口坐标矩形；无法解析返回 null
function resolveAnchorRect(anchor) {
    if (!anchor || typeof anchor !== "object") return null;
    if (typeof anchor.getBoundingClientRect === "function") {
        const r = anchor.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }
    if (Number.isFinite(anchor.clientX)) {
        // 指针事件：以点击点为锚，矩形退化为一个点（弹窗贴在该点下方）
        return { left: anchor.clientX, top: anchor.clientY, right: anchor.clientX, bottom: anchor.clientY, width: 0, height: 0 };
    }
    if (Number.isFinite(anchor.left) && Number.isFinite(anchor.top)) {
        return { left: anchor.left, top: anchor.top, right: anchor.right ?? anchor.left, bottom: anchor.bottom ?? anchor.top, width: anchor.width || 0, height: anchor.height || 0 };
    }
    return null;
}

// 把弹窗面板锚定到矩形附近：默认贴下方左侧，越界翻到上方并夹在视口内。jsdom 无布局（offsetWidth=0）时用回退尺寸。
function positionPickerPanel(panel, rect) {
    const GAP = 10;
    const MARGIN = 8;
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const pw = panel.offsetWidth || 440;
    const ph = panel.offsetHeight || 320;
    let left = rect.left;
    let top = rect.bottom + GAP;
    if (top + ph > vh - MARGIN) top = rect.top - ph - GAP; // 下方放不下 → 翻到上方
    left = Math.max(MARGIN, Math.min(left, vw - pw - MARGIN));
    top = Math.max(MARGIN, Math.min(top, vh - ph - MARGIN));
    panel.style.position = "fixed";
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}

// 预览卡正文摘录长度（skill.md 模板提示词，超长截断）
const PREVIEW_EXCERPT_LEN = 400;

// skill.md 正文缓存：非生成技能预览按需 loadSkill 取正文，避免每次 hover 都请求；技能增删改后随广播清空
const _skillPreviewContent = new Map(); // skillId -> 正文（"" = 已加载且为空）
document.addEventListener("rs.skills.updated", () => _skillPreviewContent.clear());

async function getSkillPreviewContent(id) {
    if (_skillPreviewContent.has(id)) return _skillPreviewContent.get(id);
    const data = await loadSkill(id);
    const body = (data && !data.error) ? String(data.content || "") : "";
    _skillPreviewContent.set(id, body);
    return body;
}

/** 预览卡锚定：紧贴焦点行右侧、顶边对齐；右侧放不下翻到行左侧，坐标夹在视口内 */
function positionPreviewCard(previewEl, rect) {
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const MARGIN = 8, GAP = 8;
    const w = previewEl.offsetWidth || 420;
    const h = previewEl.offsetHeight || 120;
    let left = rect.right + GAP;
    if (left + w > vw - MARGIN) left = rect.left - w - GAP; // 右侧放不下 → 翻到行左侧
    left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
    const top = Math.max(MARGIN, Math.min(rect.top, vh - h - MARGIN));
    previewEl.style.left = `${left}px`;
    previewEl.style.top = `${top}px`;
}

// 自动建议模型列表（未保存主模型时显示「自动（建议名）」，与详情弹窗同源）：模块级懒加载，选择窗与技能下拉共享
let _previewGenModelsPromise = null;
let _previewVideoModelsPromise = null;
function ensurePreviewModelLists() {
    if (!_previewGenModelsPromise) _previewGenModelsPromise = listGenModels().catch(() => null);
    if (!_previewVideoModelsPromise) _previewVideoModelsPromise = listVideoGenModels().catch(() => null);
    return Promise.all([_previewGenModelsPromise, _previewVideoModelsPromise]).then(([genModels, videoModels]) => ({ genModels, videoModels }));
}

/** 把焦点条目渲染进预览卡并重新锚定；未保存主模型的生成技能拉一次模型列表取自动建议，
 *  到位后按 isStale(item) 判断焦点是否已切走再刷新（models 为调用方共享的 { genModels, videoModels }） */
function refreshSkillPreview(previewEl, item, rowEl, models, render, isStale) {
    render(previewEl, item, models);
    positionPreviewCard(previewEl, rowEl.getBoundingClientRect());
    if (!item || !(item.genImage || item.genVideo) || (item.genConfig && item.genConfig.model)) return;
    ensurePreviewModelLists().then((m) => {
        models.genModels = m.genModels;
        models.videoModels = m.videoModels;
        if (isStale(item)) return; // 焦点已切走，丢弃过期结果
        render(previewEl, item, models);
        positionPreviewCard(previewEl, rowEl.getBoundingClientRect());
    });
}

/** 把焦点技能渲染进预览卡：生成技能 = 主模型 / LoRA（逐条 chip）/ 长边尺寸 / 默认比例 / 步数，未保存的按详情弹窗同款自动默认显示；
 *  其余技能 = skill.md 模板提示词正文摘录（懒加载 + 缓存）。it 为 null（无焦点行）时显示操作提示。整卡点击打开详情由调用方绑定。 */
function renderSkillPreview(preview, it, ctx = {}) {
    preview.innerHTML = "";
    if (!it) {
        const hint = mkEl("div", "rs-skill-preview-empty");
        hint.textContent = t("用 ↑ / ↓ 或悬停浏览技能");
        preview.appendChild(hint);
        return;
    }
    const id = it.skillId || it.value;
    preview.dataset.focusId = id;
    const name = mkEl("div", "rs-skill-preview-name");
    name.textContent = it.label;
    name.title = it.label;
    preview.appendChild(name);
    if (it.genImage || it.genVideo) {
        const cfg = (it.genConfig && typeof it.genConfig === "object") ? it.genConfig : {};
        const addRow = (key, valEl) => {
            const r = mkEl("div", "rs-skill-preview-row");
            const k = mkEl("span", "rs-skill-preview-key");
            k.textContent = key;
            r.append(k, valEl);
            preview.appendChild(r);
        };
        // 主模型：已保存值优先；未保存时与详情「自动（建议名）」一致——生图取 suggested_diffusion_models，生视频按 H3 名称线索挑
        let model = String(cfg.model || "").trim();
        if (!model) {
            const suggested = it.genImage
                ? (ctx.genModels && ctx.genModels.suggested_diffusion_models) || ""
                : videoSuggestion(ctx.videoModels ? ctx.videoModels.diffusion_models : []);
            model = suggested ? tf("自动（{m}）", { m: shortModelName(suggested) }) : t("自动");
        }
        const mv = mkEl("span", "rs-skill-preview-val");
        mv.textContent = model;
        addRow(t("主模型"), mv);
        // LoRA：仅已保存配置展示（详情同样不自动加行）
        const loras = Array.isArray(cfg.loras) ? cfg.loras.filter((n) => n) : [];
        if (loras.length) {
            const chips = mkEl("span", "rs-skill-preview-val rs-skill-preview-chips");
            loras.forEach((n) => {
                const c = mkEl("span", "rs-skill-preview-chip");
                c.textContent = n;
                chips.appendChild(c);
            });
            addRow("LoRA", chips);
        }
        // 长边 / 比例：生图与生视频共用同一 gen_config 字段，未保存时显示后端默认（与详情「默认 (1280)」/「默认 (1:1)」一致）
        const base = Number.isFinite(cfg.base_resolution) && cfg.base_resolution > 0 ? cfg.base_resolution : null;
        const bv = mkEl("span", "rs-skill-preview-val");
        bv.textContent = base ? `${base}px` : t("默认 (1280)");
        addRow(t("长边尺寸"), bv);
        const ratio = String(cfg.default_ratio || "").trim();
        const rv = mkEl("span", "rs-skill-preview-val");
        rv.textContent = ratio || t("默认 (1:1)");
        addRow(t("默认比例"), rv);
        // 步数：详情「生视频设置」的「步数」输入框 / 模板 {{STEPS}}，缺省 20（与后端 resolve 一致）
        const steps = Number.isFinite(cfg.steps) && cfg.steps > 0 ? cfg.steps : null;
        const sv = mkEl("span", "rs-skill-preview-val");
        sv.textContent = steps ? String(steps) : t("默认 (20)");
        addRow(t("步数"), sv);
    } else {
        // 非生成技能：skill.md 模板提示词正文摘录（懒加载 + 缓存，超长截断）
        const showBody = (body) => (body.length > PREVIEW_EXCERPT_LEN ? body.slice(0, PREVIEW_EXCERPT_LEN) + "…" : body) || t("（无正文）");
        const bodyEl = mkEl("div", "rs-skill-preview-body");
        preview.appendChild(bodyEl);
        const cached = _skillPreviewContent.get(id);
        if (cached !== undefined) {
            bodyEl.textContent = showBody(cached);
        } else {
            bodyEl.textContent = t("加载中…");
            getSkillPreviewContent(id).then((body) => {
                if (preview.dataset.focusId !== id) return; // 焦点已切走，丢弃过期结果
                bodyEl.textContent = showBody(body);
            });
        }
    }
    const hint = mkEl("div", "rs-skill-preview-hint");
    hint.textContent = t("点击卡片打开技能详情");
    preview.appendChild(hint);
}

let _skillPickerOpen = false;

function openSkillPickerModal(opts = {}) {
    if (_skillPickerOpen) return; // 已有选择窗打开，忽略重复触发
    _skillPickerOpen = true;
    const items = Array.isArray(opts.items) ? opts.items : [];
    const overlay = mkEl("div", "rs-skill-modal-overlay");
    overlay.style.display = "flex";

    // 键盘导航状态：visibleItems/Rows 为当前过滤后的候选，highlightIndex 是光标（-1 未聚焦）
    let visibleItems = [];
    let visibleRows = [];
    let highlightIndex = -1;
    const setHighlight = (i) => {
        if (!visibleRows.length) return;
        highlightIndex = ((i % visibleRows.length) + visibleRows.length) % visibleRows.length;
        visibleRows.forEach((r, j) => r.classList.toggle("is-highlighted", j === highlightIndex));
        visibleRows[highlightIndex]?.scrollIntoView?.({ block: "nearest" });
        updatePreview(); // 预览卡随焦点切换
    };
    const pickHighlighted = () => {
        const it = visibleItems[highlightIndex];
        if (!it) return;
        close();
        opts.onPick?.(it.value, it);
    };

    // close 需在构建 footer（引用它）之前定义；onKey 与 close 互相闭包，实际调用都在二者初始化之后
    const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); setHighlight(highlightIndex + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight(highlightIndex - 1); }
        else if (e.key === "Enter") { e.preventDefault(); pickHighlighted(); }
    };
    const close = () => { _skillPickerOpen = false; overlay.remove(); document.removeEventListener("keydown", onKey, true); window.removeEventListener("resize", positionPreview); opts.onClose?.(); };
    // 打开技能详情（编辑）弹窗：选择窗关闭后按 skill id 加载（名称可改，id 是稳定键）
    const openDetail = (it) => { close(); getSkillDetailPopup().openExisting(it.skillId || it.value, it.source); };

    const panel = mkEl("div", "rs-skill-modal rs-skill-picker");

    const search = mkEl("input", "rs-form-input rs-skill-picker-search");
    search.type = "text";
    search.placeholder = t("输入过滤...");

    const list = mkEl("div", "rs-skill-picker-list");
    panel.append(search, list);

    if (opts.showFooter) {
        const footer = mkEl("div", "rs-skill-dropdown-footer");
        buildSkillManagementButtons(close).forEach((b) => footer.appendChild(b));
        panel.appendChild(footer);
    }

    // 技能列表：浮动预览卡，以焦点行为锚点贴其右侧（键盘高亮 / hover 跟随）；
    // 生成技能显示配置摘要（未保存字段按详情同款自动默认），其余技能显示 skill.md 模板正文摘录，故只要存在技能条目就渲染。
    // 调用方传 previewRenderer 时改用自定义渲染（如导演配方的只读时间轴），此时只要有候选项就渲染
    const wrap = mkEl("div", "rs-skill-picker-wrap");
    wrap.appendChild(panel);
    let preview = null;
    if (opts.previewRenderer || items.some((it) => it.skillId || it.genImage || it.genVideo)) {
        preview = mkEl("div", "rs-skill-picker-preview");
        preview.title = opts.previewRenderer ? "" : t("点击打开技能详情");
        preview.addEventListener("mousedown", (e) => e.preventDefault()); // 不抢搜索框焦点
        preview.addEventListener("click", () => {
            const it = visibleItems[highlightIndex];
            if (!it) return;
            if (opts.onPreviewClick) { close(); opts.onPreviewClick(it); }
            else openDetail(it);
        });
        overlay.appendChild(preview); // absolute 挂在 overlay（fixed inset:0）上，按视口坐标锚定焦点行
    }
    // 预览卡锚点定位：紧贴焦点行右侧，顶边对齐；右侧放不下翻到行左侧，垂直夹在视口内。无焦点时锚定列表顶部
    const positionPreview = () => {
        if (!preview) return;
        positionPreviewCard(preview, (visibleRows[highlightIndex] || list).getBoundingClientRect());
    };
    // 有生成技能未保存主模型时，拉一次模型列表取自动建议（与详情弹窗同源）；到位后刷新当前预览
    const models = { genModels: null, videoModels: null };
    if (preview) {
        const needModels = items.some((it) => (it.genImage || it.genVideo) && !(it.genConfig && it.genConfig.model));
        if (needModels) {
            ensurePreviewModelLists().then((m) => { models.genModels = m.genModels; models.videoModels = m.videoModels; updatePreview(); });
        }
    }
    const updatePreview = () => {
        if (!preview) return;
        const it = visibleItems[highlightIndex] || null;
        if (opts.previewRenderer) { opts.previewRenderer(preview, it); positionPreview(); return; }
        refreshSkillPreview(preview, it, (visibleRows[highlightIndex] || list), models, renderSkillPreview,
            (token) => (visibleItems[highlightIndex] || null) !== token);
    };

    overlay.appendChild(wrap);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey, true);
    list.addEventListener("scroll", positionPreview); // 列表滚动时焦点行位置变化
    window.addEventListener("resize", positionPreview);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

    const render = (filter) => {
        list.innerHTML = "";
        const f = String(filter || "").trim().toLowerCase();
        const matches = items.filter((it) => !f || `${it.label} ${it.tags || ""}`.toLowerCase().includes(f));
        visibleItems = matches;
        visibleRows = [];
        highlightIndex = -1;
        updatePreview(); // 过滤后焦点重置，预览卡回到提示态（下方命中当前值时会重新高亮）
        if (!matches.length) {
            const empty = mkEl("div", "rs-skill-picker-empty");
            empty.textContent = t("无匹配项");
            list.appendChild(empty);
            return;
        }
        let lastGroup = null;
        matches.forEach((it, i) => {
            if (it.group && it.group !== lastGroup) {
                const gh = mkEl("div", "rs-combo-category");
                gh.textContent = it.group;
                list.appendChild(gh);
                lastGroup = it.group;
            }
            const row = mkEl("div", "rs-skill-picker-item" + (it.value === opts.currentValue ? " is-selected" : ""));
            if (it.badge) { const b = mkEl("span", "rs-skill-picker-badge"); b.textContent = it.badge; row.appendChild(b); }
            const lbl = mkEl("span", "rs-skill-picker-label");
            lbl.textContent = it.label;
            row.appendChild(lbl);
            row.addEventListener("mousedown", (e) => e.preventDefault()); // 保持搜索框焦点
            row.addEventListener("mouseenter", () => setHighlight(i)); // hover 行同步右侧预览卡
            row.addEventListener("click", (e) => { e.stopPropagation(); close(); opts.onPick?.(it.value, it); });
            visibleRows[i] = row;
            list.appendChild(row);
        });
        const cur = matches.findIndex((it) => it.value === opts.currentValue); // 默认高亮当前值所在行
        if (cur >= 0) setHighlight(cur);
    };
    render("");
    search.addEventListener("input", () => render(search.value));

    // 传入 anchor 时贴到触发控件附近（去遮罩的浮层）；否则保持居中模态。预览卡独立 absolute 定位，不受面板位置影响
    const anchorRect = resolveAnchorRect(opts.anchor);
    if (anchorRect) {
        overlay.classList.add("rs-skill-picker--anchored");
        positionPickerPanel(wrap, anchorRect);
        positionPreview(); // 面板锚定后焦点行坐标已变，预览卡需重新对齐（首次定位发生在居中布局下）
    }

    search.focus();
    return { close, overlay };
}

/** 写回 combo widget：更新 value + 触发 callback（Krea2/H3 已在其上挂 loadDims/loadSpec）+ 标记画布脏 */
function setComboWidgetValue(node, widget, value) {
    if (widget.value === value) return;
    const old = widget.value;
    widget.value = value;
    try { if (typeof widget.callback === "function") widget.callback(value); } catch (_) {}
    try { node?.onWidgetChanged?.(widget.name, value, old, widget); } catch (_) {}
    try { node?.graph?.change?.(); } catch (_) {}
}

/** 默认技能条目来源：listSkills() 元数据，value 对齐该 combo 的合法 options.values（Krea2/H3 skill_id 通用） */
async function defaultSkillItemsProvider(widget) {
    const skills = await listSkills();
    const allowed = Array.isArray(widget?.options?.values) ? widget.options.values : null;
    return skillItemsFromMeta(skills, allowed);
}

/** 打开 combo 对应的选择窗（异步取条目后展示）；extra 透传给 openSkillPickerModal（previewRenderer / onPreviewClick） */
async function openComboSkillPicker(node, widget, title, showFooter, provider, anchor, extra = {}) {
    let items = [];
    try { items = (await provider(widget)) || []; } catch (e) { console.error("[Neo Studio] skill picker load failed", e); }
    openSkillPickerModal({
        title,
        items,
        currentValue: String(widget.value || ""),
        showFooter,
        anchor,
        onPick: (value) => setComboWidgetValue(node, widget, value),
        ...extra,
    });
}

/**
 * 拦截 ComfyUI 画布 combo widget 的点击，改为弹出技能选择窗（锚定到鼠标位置）。
 * opts: { title, showFooter(默认 true), itemsProvider(widget)->Promise<items[]>,
 *         previewRenderer(previewEl, item|null)（自定义预览卡渲染，如配方时间轴）, onPreviewClick(item)（点预览卡动作，默认打开技能详情）, onClose()（选择窗关闭时回调，供调用方清理预览卡资源） }
 * 新版前端 processWidgetClick 只认 onPointerDown 返回真值来短路原生 combo 下拉；
 * 其 pointer 参数没有视口坐标，因此用 document 捕获阶段记录的真实 pointerdown 坐标做锚点。
 * 不能挂 widget.mouse：processMouseMove 也会调用它，会导致悬停/点击别处时重复弹窗。
 */
let _neoLastPointer = null;
function ensureNeoPointerTracker() {
    if (_neoLastPointer) return;
    _neoLastPointer = { x: 0, y: 0 };
    document.addEventListener("pointerdown", (e) => {
        _neoLastPointer.x = e.clientX;
        _neoLastPointer.y = e.clientY;
    }, true);
}

function attachSkillPickerToComboWidget(widget, opts = {}) {
    if (!widget || widget.__neoSkillPickerAttached) return;
    const showFooter = opts.showFooter !== false;
    const provider = typeof opts.itemsProvider === "function" ? opts.itemsProvider : defaultSkillItemsProvider;
    const extra = {};
    if (typeof opts.previewRenderer === "function") extra.previewRenderer = opts.previewRenderer;
    if (typeof opts.onPreviewClick === "function") extra.onPreviewClick = opts.onPreviewClick;
    if (typeof opts.onClose === "function") extra.onClose = opts.onClose;
    ensureNeoPointerTracker();
    const node = widget.node;
    widget.onPointerDown = () => {
        openComboSkillPicker(node || widget.node, widget, null, showFooter, provider, { clientX: _neoLastPointer.x, clientY: _neoLastPointer.y }, extra);
        return true;
    };
    widget.__neoSkillPickerAttached = true;
}

/** 拦截原生 <select>（导演编辑器分段技能下拉）：点击弹居中搜索窗，选中写回 select.value。
 *  option 可携带 __skillMeta（listVideoSkills 元数据），透传给选择窗条目以渲染浮动预览卡 */
function attachSkillPickerToSelect(selectEl, opts = {}) {
    if (!selectEl || selectEl.__neoSkillPickerAttached) return;
    const title = opts.title || t("选择视频技能");
    selectEl.__neoSkillPickerAttached = true;
    selectEl.addEventListener("mousedown", (e) => {
        e.preventDefault(); // 阻止原生下拉展开
        const items = Array.from(selectEl.options)
            .filter((o) => o.value !== "")
            .map((o) => {
                const meta = o.__skillMeta || {};
                const item = skillItemFromMeta(meta, o.value, String(o.textContent || o.value).trim());
                item.source = (o.dataset && o.dataset.source) || "custom";
                item.group = CATEGORY_LABELS[meta.category]?.label || "";
                return item;
            });
        openSkillPickerModal({
            title,
            items,
            currentValue: selectEl.value,
            anchor: selectEl,
            showFooter: false,
            onPick: (value) => {
                if (selectEl.value !== value) {
                    selectEl.value = value;
                    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
                }
            },
        });
    });
}

// ==========================================
// 技能下拉组装：原生 select（数据源）+ 可搜索组件 + 底部管理工具栏 + 行内操作一体创建。
// prompt-manager 只需 const { selectEl, combo } = createSkillDropdown() 并挂载 combo.box；
// 选项填充仍走 populateSkillOptions(selectEl, skills)，combo 自动跟随（选项带 data-source 供行内操作判断）。
// ==========================================

function createSkillDropdown() {
    const selectEl = mkEl("select", "rs-tpl-selector");
    selectEl.title = "Select a skill";

    // 底部工具栏：+ New Skill / ZIP / Folder / From Canvas —— 管理入口（与技能选择弹窗共用同一组按钮）
    const skillFooter = mkEl("div", "rs-skill-dropdown-footer");
    buildSkillManagementButtons(() => combo.close()).forEach((b) => skillFooter.appendChild(b));

    // 浮动预览卡：与选择窗同款，挂在 body 上（fixed），跟随焦点行；所有技能可预览
    // （生成技能 = 配置摘要，其余 = skill.md 模板正文摘录），点击打开详情弹窗
    let skillPreview = null;
    let previewFocusItem = null;
    let previewFocusRow = null;
    const ensureSkillPreview = () => {
        if (skillPreview) return skillPreview;
        skillPreview = mkEl("div", "rs-skill-picker-preview rs-skill-picker-preview--fixed");
        skillPreview.style.display = "none";
        skillPreview.title = t("点击打开技能详情");
        // stopPropagation 必须：combo 点外关闭是 document mousedown，不拦的话列表先关、click 到不了卡片（同 viewBtn / 底部按钮）
        skillPreview.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }); // 不抢输入框焦点
        skillPreview.addEventListener("click", () => {
            const it = previewFocusItem;
            if (!it) return;
            combo.close();
            getSkillDetailPopup().openExisting(it.skillId, it.source);
        });
        document.body.appendChild(skillPreview);
        return skillPreview;
    };
    // 未保存主模型的生成技能需拉模型列表取自动建议（与选择窗 / 详情弹窗同源）
    const models = { genModels: null, videoModels: null };
    const onItemFocus = (itemEl) => {
        const val = itemEl && itemEl.dataset.value;
        const opt = val ? Array.from(selectEl.options).find((o) => o.value === val) : null;
        if (!opt) {
            previewFocusItem = null;
            previewFocusRow = null;
            if (skillPreview) skillPreview.style.display = "none";
            return;
        }
        const meta = opt.__skillMeta || {};
        previewFocusItem = skillItemFromMeta(meta, val, skillDisplayName(meta) || String(opt.textContent || val).trim());
        previewFocusItem.source = (opt.dataset && opt.dataset.source) || "custom";
        previewFocusRow = itemEl;
        const preview = ensureSkillPreview();
        preview.style.display = "";
        refreshSkillPreview(preview, previewFocusItem, itemEl, models, renderSkillPreview,
            (token) => previewFocusItem !== token);
    };
    window.addEventListener("resize", () => {
        if (skillPreview && skillPreview.style.display !== "none" && previewFocusRow) {
            positionPreviewCard(skillPreview, previewFocusRow.getBoundingClientRect());
        }
    });

    // combo 声明在其后：footer / 预览卡闭包只在用户交互时执行，届时 combo 已赋值
    const combo = attachComboBox(selectEl, {
        placeholder: t("输入过滤 skill..."),
        emptyText: t("无匹配 skill"),
        listMinWidth: 306,
        footerEl: skillFooter,
        onItemFocus,
    });

    // hover 已选 skill 时右侧出现 按钮，点击打开详情弹窗（覆盖 caret 区域）
    const wrap = combo.box.firstElementChild;
    const viewBtn = mkEl("button", "rs-skill-view-btn");
    viewBtn.type = "button";
    viewBtn.textContent = "";
    viewBtn.title = t("查看当前技能详情");
    viewBtn.style.cssText = "position:absolute;right:24px;top:50%;transform:translateY(-50%);opacity:0;pointer-events:none;background:none;border:none;cursor:pointer;font-size:13px;padding:2px 4px;color:#ccc;z-index:2;transition:opacity .15s;line-height:1;";
    viewBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    viewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const val = selectEl.value;
        if (!val) return;
        const selOpt = selectEl.selectedOptions[0];
        const source = (selOpt && selOpt.dataset && selOpt.dataset.source) || "custom";
        getSkillDetailPopup().openExisting(val, source);
    });
    wrap.appendChild(viewBtn);
    combo.box.addEventListener("mouseenter", () => {
        const val = selectEl.value;
        if (!val) return;
        const selOpt = selectEl.selectedOptions[0];
        const source = (selOpt && selOpt.dataset && selOpt.dataset.source) || "custom";
        if (source === "preset") return; // 预设只读，不显示查看按钮
        viewBtn.style.opacity = "1";
        viewBtn.style.pointerEvents = "auto";
    });
    combo.box.addEventListener("mouseleave", () => {
        viewBtn.style.opacity = "0"; viewBtn.style.pointerEvents = "none";
    });

    return { selectEl, combo };
}

// ==========================================
// 统一技能管理 UI：左侧技能列表（搜索 + 分类分组）+ 右侧技能详情（内嵌 createSkillDetailPopup）
// createSkillManager(host, opts) 直接挂进给定容器，返回 { el, closeBtn, close }；
// openSkillManager() 包一层模态遮罩作顶栏 菜单「技能管理」入口（跨节点单例，重复打开不叠加）；
// Neo Studio「技能」页签直接挂主区（无弹窗外壳）。
// 技能增删改/上传均广播 rs.skills.updated，左侧列表随之自动刷新。
// ==========================================
let _skillManagerOpen = false;

// 左栏宽度拖拽：下限保证列表可读，右栏下限保证详情不被挤没；宽度记忆到 localStorage，双击分隔条清除
const SKILL_LEFT_W_KEY = "neo.skillManagerLeftWidth";
const SKILL_LEFT_MIN_W = 180;
const SKILL_RIGHT_MIN_W = 320;

function createSkillManager(host, { showClose = true, showCanvasBtn = true } = {}) {
    const box = mkEl("div", "rs-skill-manager");

    // 顶部标题栏：技能管理 + ✕（关闭整窗；内嵌模式无 ✕）
    const head = mkEl("div", "rs-skill-manager-head");
    const title = mkEl("span", "rs-skill-manager-title");
    title.textContent = t("技能管理");
    head.appendChild(title);
    let closeBtn = null;
    if (showClose) {
        closeBtn = mkEl("button", "rs-skill-modal-close");
        closeBtn.type = "button";
        closeBtn.title = t("关闭");
        closeBtn.textContent = "✕";
        head.appendChild(closeBtn);
    }

    // 主体：左列表 | 分隔条 | 右详情
    const body = mkEl("div", "rs-skill-manager-body");
    const left = mkEl("div", "rs-skill-manager-left");
    const split = mkEl("div", "rs-skill-manager-split");
    const right = mkEl("div", "rs-skill-manager-right");
    body.append(left, split, right);
    box.append(head, body);

    // 左：搜索框 + 列表 + 管理工具栏（新建 / ZIP / 目录 / 从画布）
    const search = document.createElement("input");
    search.type = "text";
    search.className = "rs-skill-picker-search";
    search.placeholder = t("搜索技能…");
    search.addEventListener("input", () => renderList());
    const list = mkEl("div", "rs-skill-picker-list");
    const mgmt = mkEl("div", "rs-skill-dropdown-footer");
    left.append(search, list, mgmt);

    // 右：占位提示 + 内嵌详情弹窗（modal 挂到 right）
    const placeholder = mkEl("div", "rs-skill-manager-empty");
    placeholder.textContent = t("从左侧选择技能查看详情");
    right.appendChild(placeholder);
    const popup = createSkillDetailPopup(right, showCanvasBtn, { onCloseWindow: () => closeBtn && closeBtn.click() });

    host.appendChild(box);

    // 左栏宽度拖拽：分隔条跟随光标，钳制在 [左栏下限, 主体宽 - 右栏下限]；松手记忆到 localStorage（开窗沿用，
    // 上限由 CSS .rs-skill-manager-left max-width 兜底），双击分隔条清除记忆回到默认宽度。
    const setLeftWidth = (w) => {
        const max = Math.max(SKILL_LEFT_MIN_W, body.getBoundingClientRect().width - SKILL_RIGHT_MIN_W);
        left.style.width = `${Math.round(Math.max(SKILL_LEFT_MIN_W, Math.min(w, max)))}px`;
    };
    split.title = t("拖动调整列表宽度（双击恢复默认）");
    let savedLeftW = NaN;
    try { savedLeftW = parseInt(localStorage.getItem(SKILL_LEFT_W_KEY), 10); } catch { /* 隐私模式下 localStorage 不可用 */ }
    if (Number.isFinite(savedLeftW)) left.style.width = `${Math.max(SKILL_LEFT_MIN_W, savedLeftW)}px`;
    // 捕获指针 + 闸门：手势取消或在页面外松手时页面收不到 mouseup/pointerup，
    // 不捕获就会留下 move 监听器，左栏宽度会一直跟着鼠标跑
    let splitDrag = false;
    split.addEventListener("pointerdown", (e) => {
        if (splitDrag || e.button !== 0) return;
        const startX = e.clientX;
        const startW = left.getBoundingClientRect().width;
        splitDrag = true;
        split.classList.add("is-dragging");
        document.body.classList.add("rs-skill-resizing");
        split.setPointerCapture?.(e.pointerId);
        const onMove = (ev) => { if (splitDrag) setLeftWidth(startW + ev.clientX - startX); };
        const onUp = () => {
            splitDrag = false;
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onUp);
            split.classList.remove("is-dragging");
            document.body.classList.remove("rs-skill-resizing");
            try { localStorage.setItem(SKILL_LEFT_W_KEY, left.style.width); } catch { /* 同上 */ }
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
    });
    split.addEventListener("dblclick", () => {
        try { localStorage.removeItem(SKILL_LEFT_W_KEY); } catch { /* 同上 */ }
        left.style.width = "";
    });

    let allItems = [];
    let selectedId = null;
    // 手风琴：同时只展开一个分类；undefined = 首屏尚未定位（首次加载后默认展开「生图」）
    let openGroup;
    const syncEmpty = () => {
        const m = right.querySelector(".rs-skill-modal");
        placeholder.hidden = !!(m && m.style.display !== "none");
    };

    // 行内操作按钮（core/icons.js 的复制 / 删除图标）：默认透明，hover 行时淡入（见 prompts.css .rs-skill-row-btn）
    const mkRowBtn = (name, tip, extraCls = "") => {
        const b = mkEl("button", "rs-skill-row-btn" + (extraCls ? ` ${extraCls}` : ""));
        b.type = "button";
        b.append(icon(name));
        b.title = tip;
        b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        return b;
    };

    // 渲染分组列表（搜索过滤）；分类头可点击折叠/展开（手风琴：仅一个组展开，搜索时全展开）；展开组加粗高亮 is-open；选中项高亮 is-selected
    function renderList() {
        list.textContent = "";
        const q = search.value.trim().toLowerCase();
        const items = allItems.filter((it) => !q || `${it.label} ${it.badge || ""}`.toLowerCase().includes(q));
        if (!items.length) {
            const empty = mkEl("div", "rs-skill-picker-empty");
            empty.textContent = q ? t("无匹配技能") : t("暂无技能");
            list.appendChild(empty);
            return;
        }
        // 搜索时强制展开，保证匹配项可见
        const searching = !!q;
        // 按分组聚合（items 已按 group 排序，Map 保持原顺序；无分组项归入 ""）
        const groups = new Map();
        for (const it of items) {
            const g = it.group || "";
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(it);
        }
        for (const [g, groupItems] of groups) {
            if (g) {
                const collapsed = !searching && g !== openGroup;
                const gh = mkEl("div", "rs-combo-category rs-skill-manager-cat" + (collapsed ? "" : " is-open"));
                gh.dataset.group = g;
                const caret = mkEl("span", "rs-skill-manager-cat-caret");
                caret.textContent = collapsed ? "▸" : "▾";
                const lbl = mkEl("span", "rs-skill-manager-cat-label");
                lbl.textContent = g;
                gh.append(caret, lbl);
                gh.title = collapsed ? tf("展开「{g}」", { g }) : tf("折叠「{g}」", { g });
                gh.addEventListener("click", () => toggleGroup(g));
                list.appendChild(gh);
                if (collapsed) continue;
            }
            for (const it of groupItems) {
                const row = mkEl("div", "rs-skill-picker-item" + (it.value === selectedId ? " is-selected" : ""));
                if (it.badge) { const b = mkEl("span", "rs-skill-picker-badge"); b.textContent = it.badge; row.appendChild(b); }
                const lbl = mkEl("span", "rs-skill-picker-label");
                lbl.textContent = it.label;
                row.appendChild(lbl);
                const actions = mkEl("div", "rs-skill-picker-actions");
                const copyBtn = mkRowBtn("copy", it.source === "custom" ? t("复制为副本") : t("复制为自定义技能"));
                copyBtn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    const copy = await copySkillAsCustom(it.skillId || it.value, it.label);
                    if (copy) await selectSkill({ value: copy.name, skillId: copy.id, source: "custom" });
                });
                actions.appendChild(copyBtn);
                if (it.source === "custom") {
                    const delBtn = mkRowBtn("trash", t("删除该自定义技能"), "rs-skill-row-del");
                    delBtn.addEventListener("click", async (e) => {
                        e.stopPropagation();
                        const id = it.skillId || it.value;
                        if (!confirm(tf("删除技能 \"{label}\"？", { label: it.label }))) return;
                        const r = await deleteSkill(id);
                        if (!r.success) { showToast(app, "error", t("删除失败"), r.error || "Unknown error"); return; }
                        if (it.value === selectedId) { popup.close(); selectedId = null; }   // 删的正是右侧正在显示的详情
                        dispatchSkillsUpdated();
                    });
                    actions.appendChild(delBtn);
                }
                row.appendChild(actions);
                row.addEventListener("click", () => selectSkill(it));
                list.appendChild(row);
            }
        }
    }

    // 分类头点击：手风琴——展开某组会收起其它组，再点当前组收起全部
    function toggleGroup(group) {
        openGroup = openGroup === group ? null : group;
        renderList();
    }

    async function loadList() {
        const skills = (await listSkills()).filter(s => !CATEGORY_LABELS[s.category]?.managerHidden);
        allItems = skillItemsFromMeta(skills);
        // 首屏默认展开「生图」（没有生图技能时展开第一个分类），避免一屏铺满全部分类
        if (openGroup === undefined) {
            const labels = allItems.map((it) => it.group).filter(Boolean);
            const gen = CATEGORY_LABELS.image_gen.label;
            openGroup = labels.includes(gen) ? gen : (labels[0] ?? null);
        }
        if (selectedId && !allItems.some((it) => it.value === selectedId)) selectedId = null;   // 删除后清选择
        renderList();
        syncEmpty();
    }

    // 选中技能：有未保存修改先确认，再加载详情到右侧
    async function selectSkill(it) {
        if (it.value === selectedId) return;
        if (popup.isDirty() && !confirm(t("当前技能有未保存的修改，放弃并切换？"))) return;
        selectedId = it.value;
        renderList();
        await popup.openExisting(it.skillId || it.value, it.source);
        syncEmpty();
    }

    // 管理工具栏按钮：新建进右侧内嵌详情；上传/导出广播 rs.skills.updated 自动刷新列表
    const makeMgmtBtn = (label, tip) => {
        const b = mkEl("button", "rs-btn rs-btn-local rs-skill-footer-btn");
        b.type = "button";
        b.textContent = label;
        b.title = tip;
        b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        return b;
    };
    const newBtn = makeMgmtBtn(t("+ 新建"), t("新建自定义技能"));
    newBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (popup.isDirty() && !confirm(t("当前技能有未保存的修改，放弃并新建？"))) return;
        selectedId = null;
        renderList();
        await popup.openNew();
        syncEmpty();
    });
    const zipBtn = makeMgmtBtn("ZIP", t("上传 .zip 技能包"));
    zipBtn.addEventListener("click", (e) => { e.stopPropagation(); getSkillUploadInputs().zipInput.click(); });
    const dirBtn = makeMgmtBtn(t("目录"), t("上传技能目录（全部 .md）"));
    dirBtn.addEventListener("click", (e) => { e.stopPropagation(); getSkillUploadInputs().dirInput.click(); });
    mgmt.append(newBtn, zipBtn, dirBtn);
    if (showCanvasBtn) {
        const canvasBtn = makeMgmtBtn(t("从画布"), t("把当前画布工作流导出为技能"));
        canvasBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
                await exportCanvasAsSkill();
            } catch (err) {
                showToast(app, "error", t("保存失败"), err.message);
            }
        });
        mgmt.appendChild(canvasBtn);
    }

    // 技能增删改（rs.skills.updated）自动刷新列表；close() 清监听、卸载内嵌画布并移除根节点
    const onSkillsUpdated = () => loadList();
    document.addEventListener("rs.skills.updated", onSkillsUpdated);
    const close = () => {
        document.removeEventListener("rs.skills.updated", onSkillsUpdated);
        popup.close();   // 关整窗要卸载内嵌画布：active_canvas 留在已死的子图上会让主画布的右键加节点 / 对齐打空
        box.remove();
    };

    // 初始加载 + 默认选中「默认展开分类」的第一项（与左侧展开的分类一致，而非按分组排序的列表首项）
    loadList().then(() => {
        if (selectedId || !allItems.length) return;
        selectSkill(allItems.find((it) => it.group === openGroup) || allItems[0]);
    });

    return { el: box, head, closeBtn, close };
}

function openSkillManager() {
    if (_skillManagerOpen) return;
    _skillManagerOpen = true;
    // 独立窗口（同导演编辑器）：无遮罩 —— 背景透明且指针穿透，画布保持可操作；
    // 标题栏拖动 / 双击放大还原 / ⛶ 放大还原 / 右下角拉伸；关闭只走 ✕（Esc 不关整窗）
    const overlay = mkEl("div", "rs-skill-modal-overlay rs-skill-manager-overlay");
    overlay.style.display = "flex";   // .rs-skill-modal-overlay 默认 display:none，内嵌整窗需显式显示
    document.body.appendChild(overlay);

    const mgr = createSkillManager(overlay);
    const box = mgr.el;
    overlay.appendChild(box);

    // ⛶ 放大/还原：铺满视口（留 8px 边距），还原回到放大前的几何
    let maximized = false, prevRect = null;
    const maxBtn = mkEl("button", "rs-skill-manager-maximize");
    maxBtn.type = "button";
    maxBtn.title = t("放大到最大");
    maxBtn.textContent = "⛶";
    const toggleMaximize = () => {
        if (maximized) {
            Object.assign(box.style, prevRect || { left: "", top: "", width: "", height: "" });
            maximized = false;
            maxBtn.textContent = "⛶";
            maxBtn.title = t("放大到最大");
        } else {
            prevRect = { left: box.style.left, top: box.style.top, width: box.style.width, height: box.style.height };
            Object.assign(box.style, { position: "absolute", left: "8px", top: "8px", width: "calc(100vw - 16px)", height: "calc(100vh - 16px)" });
            maximized = true;
            maxBtn.textContent = "";
            maxBtn.title = t("还原窗口");
        }
    };
    maxBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMaximize(); });
    mgr.head.insertBefore(maxBtn, mgr.closeBtn);

    // 标题栏拖动：位移后夹回视口，保证标题栏始终够得到（放大态铺满，拖动无意义）
    // 拖拽期间捕获指针并在 onMove 上设闸门：手势被取消（pointercancel）或在页面外松手时
    // 页面收不到 pointerup，不捕获就会留下 pointermove 监听器，松手后窗口继续跟着鼠标跑
    let headDrag = false;
    mgr.head.addEventListener("pointerdown", (e) => {
        if (maximized || headDrag || e.button !== 0 || e.target.closest("button, input")) return;
        const startL = parseFloat(box.style.left) || box.offsetLeft;
        const startT = parseFloat(box.style.top) || box.offsetTop;
        const startX = e.clientX, startY = e.clientY;
        box.style.position = "absolute";
        box.style.left = startL + "px";
        box.style.top = startT + "px";
        headDrag = true;
        mgr.head.setPointerCapture?.(e.pointerId);
        const onMove = (ev) => {
            if (!headDrag) return;
            const w = box.offsetWidth, h = box.offsetHeight;
            box.style.left = Math.max(-w + 80, Math.min(startL + ev.clientX - startX, window.innerWidth - 80)) + "px";
            box.style.top = Math.max(0, Math.min(startT + ev.clientY - startY, window.innerHeight - 44)) + "px";
        };
        const onUp = () => {
            headDrag = false;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    });
    mgr.head.addEventListener("dblclick", (e) => {
        if (e.target.closest("button, input")) return;
        toggleMaximize();
    });

    // 右下角拖拽改尺寸
    const grip = mkEl("div", "rs-skill-manager-resize");
    grip.title = t("拖拽调整窗口大小");
    box.appendChild(grip);
    // 右下角拖拽改尺寸（同标题栏拖动：捕获指针 + 闸门，松手/取消手势后不再跟随鼠标）
    let resizing = false;
    grip.addEventListener("pointerdown", (e) => {
        if (resizing || e.button !== 0) return;
        e.preventDefault();
        const sw = box.offsetWidth, sh = box.offsetHeight;
        const startX = e.clientX, startY = e.clientY;
        resizing = true;
        grip.setPointerCapture?.(e.pointerId);
        const onMove = (ev) => {
            if (!resizing) return;
            box.style.width = Math.max(640, sw + ev.clientX - startX) + "px";
            box.style.height = Math.max(420, sh + ev.clientY - startY) + "px";
        };
        const onUp = () => {
            resizing = false;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    });

    // Esc 不关整窗，也不让它打到主画布的退出子图：窗口内的 Esc 就地吞掉（内嵌画布 / 输入框的先处理自己的事）
    box.addEventListener("keydown", (e) => { if (e.key === "Escape") e.stopPropagation(); });

    // 关闭只走「✕」：Esc 不关整窗——内嵌画布、输入框、浮窗里的 Esc 各管各的事，不至于顺手关掉整个窗口
    const close = () => {
        _skillManagerOpen = false;
        overlay.remove();
        mgr.close();
    };
    mgr.closeBtn.addEventListener("click", (e) => { e.stopPropagation(); close(); });
}

// ==========================================
// 导出（纯 ES 模块，无副作用）
// ==========================================

// ==========================================
// 导出（纯 ES 模块，无副作用）
// ==========================================
export {
    listSkills,
    loadSkill,
    saveSkill,
    deleteSkill,
    uploadSkill,
    listSkillFiles,
    loadSkillFile,
    saveSkillFile,
    deleteSkillFile,
    populateSkillOptions,
    skillDisplayName,
    skillImageMode,
    skillAcceptsText,
    skillAcceptsRef,
    validateSkillForNode,
    invalidateSkillValidation,
    resolveSkillId,
    openSkillDetailById,
    createSkillStatusRow,
    SKILL_CHANGED_EVENT,
    CATEGORY_LABELS,
    renderMarkdown,
    createSkillDetailPopup,
    createSkillDropdown,
    openSkillPickerModal,
    createSkillManager,
    openSkillManager,
    openSkillWorkflowInMainUi,
    openSkillWorkflowOnCanvas,
    runSkillWorkflowHandoff,
    getPendingWriteback,
    runCanvasSkillWriteback,
    showSkillWriteLogDialog,
    attachSkillPickerToComboWidget,
    attachSkillPickerToSelect
};
