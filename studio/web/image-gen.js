/**
 * image-gen.js
 * 生图客户端：/neo_image_gen/* API 包装、任务事件等待、
 * 结果发送到 LoadImage 节点（复用 /neo_gallery/copy_to_input）与生图设置表单。
 * 设置表单挂在「自动增强」菜单内，接口形态与 llm-setting.js 一致：{ el, load, save }。
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { loadSkill } from "./skill.js";
import { attachComboBox } from "./combo-box.js";
import { mkEl } from "./dom-utils.js";
import { showToast } from "./gallery-utils.js";
import { sseStream } from "./prompt-service.js";
import { t, tf } from "./js/core/i18n.js";

const GEN_API = "/neo_image_gen";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const GEN_PLACEHOLDER = "【人物形象描述】";
// 后端 _watch 按变化推送的任务快照事件（广播，按 task_id 过滤）
const STATUS_EVENT = "rs.image_gen.status";

// ==========================================
// API 包装
// ==========================================

async function getJson(path) {
    const resp = await fetch(path);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

export async function getGenSettings() {
    return getJson(`${GEN_API}/settings`);
}

export async function saveGenSettings(patch) {
    const resp = await fetch(`${GEN_API}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch || {})
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

// 生视频（MiniMax H3）独立设置：/neo_video_gen/*，落盘 configs/video_gen.json，与生图 image_gen.json 分开
const VIDEO_API = "/neo_video_gen";

export async function getVideoGenSettings() {
    return getJson(`${VIDEO_API}/settings`);
}

export async function saveVideoGenSettings(patch) {
    const resp = await fetch(`${VIDEO_API}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch || {})
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

export async function listGenModels() {
    return getJson(`${GEN_API}/models`);
}

// 生视频模型列表：/neo_video_gen/models，H3 相关靠前（与生图 krea2-first 独立）
export async function listVideoGenModels() {
    return getJson(`${VIDEO_API}/models`);
}

/** 提交生图任务，返回任务快照（含 task_id / warnings）；失败抛 Error(后端消息) */
export async function requestGeneration(payload) {
    const resp = await fetch(`${GEN_API}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

/**
 * SSE 流式增强提示词。
 * @param {object} payload - { skill_id, prompt }
 * @param {object} handlers - { onChunk(text), onDone(fullText), onError(msg) }
 */
export function enhancePromptStream(payload, handlers) {
    const { onChunk, onDone, onError } = handlers;
    let accumulated = "";
    return sseStream(`${GEN_API}/enhance`, {
        onChunk: (chunk) => {
            if (!chunk.text) return;
            accumulated += chunk.text;
            onChunk?.(chunk.text);
        },
        onDone: () => onDone?.(accumulated),
        onError: (err) => onError?.(err),
    }, payload);
}

export async function cancelTask(taskId) {
    try {
        await fetch(`${GEN_API}/cancel/${encodeURIComponent(taskId)}`, { method: "POST" });
    } catch (e) {
        console.warn("cancel generation failed:", e);
    }
}

/** 把当前画布工作流（API prompt）保存为生图技能；返回 { id, warnings } */
export async function saveWorkflowSkill({ name, description, tags, workflow, bindings }) {
    const resp = await fetch(`${GEN_API}/save_workflow_skill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, tags: tags || [], workflow, bindings: bindings || [] })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

/** 导出预览：后端给出画布里可替换成占位符的 widget 候选（提示词原文节点 / 分辨率选择器）；
 * 返回 { gen_video, candidates: [{ node, field, token, class_type, value }], warnings } */
export async function planWorkflowSkill(workflow) {
    const resp = await fetch(`${GEN_API}/plan_workflow_skill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

/** 把当前画布工作流（API prompt）回写入 existing custom skill；返回 { id, warnings } */
export async function updateWorkflowSkill(skillId, workflow) {
    const resp = await fetch(`${GEN_API}/update_workflow_skill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill_id: skillId, workflow })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

/** 回写前预览：后端同一套计算给出变更清单与 warnings（只算不写）；返回 { id, changes, warnings, gen_video } */
export async function previewWorkflowSkill(skillId, workflow) {
    const resp = await fetch(`${GEN_API}/update_workflow_skill_preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill_id: skillId, workflow })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

/** 读技能的生图设置覆盖（config.json；缺失返回 {}） */
export async function getSkillGenConfig(skillId) {
    try {
        return await getJson(`${GEN_API}/skill_config?skill_id=${encodeURIComponent(skillId)}`);
    } catch (e) {
        return {};
    }
}

/** 写技能的生图/生视频设置覆盖（自定义写自身 config.json，预设写本地覆盖文件；失败抛 Error(后端消息)） */
export async function saveSkillGenConfig(skillId, config) {
    const resp = await fetch(`${GEN_API}/skill_config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill_id: skillId, config: config || {} })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

/** 「复制为自定义」时把源技能的 workflow.json / config.json 一并带过去（失败静默） */
export async function copySkillFiles(fromId, toId) {
    try {
        await fetch(`${GEN_API}/copy_skill_files`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from_id: fromId, to_id: toId })
        });
    } catch (e) {
        console.warn("copy skill files failed:", e);
    }
}

/**
 * 等待任务到终态（succeeded/failed/cancelled），返回最终快照。
 * 后端把快照按变化经 WebSocket 推送（rs.image_gen.status），这里订阅事件而非轮询
 * HTTP；订阅后兜底首拉一次当前状态（兜住推送前已终态的任务），断线重连时再拉一次
 * 补漏；约 40 分钟无终态按失败收场，避免无限等待。
 */
export function watchTask(taskId, onSnapshot, isCancelled) {
    return new Promise((resolve) => {
        const statusUrl = `${GEN_API}/status/${encodeURIComponent(taskId)}`;
        let timeout;
        function finish(snap) {
            clearTimeout(timeout);
            api.removeEventListener(STATUS_EVENT, onStatus);
            api.removeEventListener("reconnected", onReconnected);
            resolve(snap);
        }
        function apply(snap) {
            if (!snap || snap.task_id !== taskId) return;
            onSnapshot?.(snap);
            if (TERMINAL_STATUSES.has(snap.status)) finish(snap);
        }
        function resync() {
            // 兜底拉取（非轮询）：订阅窗口与断线重连可能错过推送
            getJson(statusUrl).then(apply).catch(() => {}); // 404/网络抖动：等推送或重连再拉
        }
        function onStatus(event) {
            if (isCancelled?.()) return finish({ status: "cancelled" });
            apply(event.detail);
        }
        function onReconnected() {
            if (isCancelled?.()) return finish({ status: "cancelled" });
            resync();
        }
        timeout = setTimeout(
            () => finish({ status: "failed", error: t("等待生图超时，请稍后在 Gallery 查看") }),
            40 * 60 * 1000
        );
        api.addEventListener(STATUS_EVENT, onStatus);
        api.addEventListener("reconnected", onReconnected);
        if (isCancelled?.()) {
            finish({ status: "cancelled" });
            return;
        }
        resync();
    });
}

// ==========================================
// 四视图模板：占位符替换（仅参考图模式需要）；结构指令由后端固定前缀 + 四视图 LoRA 提供
// ==========================================

const templateCache = new Map();

async function loadGenTemplate(skillId) {
    if (templateCache.has(skillId)) return templateCache.get(skillId);
    const full = await loadSkill(skillId).catch(() => null);
    const body = full && !full.error ? String(full.content || "") : "";
    templateCache.set(skillId, body);
    return body;
}

/**
 * 拼装生图提示词：无参考图直接用用户文本；有参考图套 skill 正文模板。
 * 模板含占位符则全部替换为用户文本，否则把文本附在模板前。
 * 带 workflow.json 的技能正文只作帮助文档（不参与生成），直接返回用户文本。
 */
export async function buildGenPrompt(skillId, text, hasRefs, hasWorkflow) {
    if (!hasRefs || hasWorkflow) return text;
    const body = await loadGenTemplate(skillId);
    if (!body) return text;
    if (body.includes(GEN_PLACEHOLDER)) {
        return body.split(GEN_PLACEHOLDER).join(text || t("参考图片中的角色形象"));
    }
    return `${text}\n${body}`;
}

// ==========================================
// 发送到 LoadImage 节点（复用 Gallery 的 copy_to_input 通道）
// ==========================================

export function findImageWidget(node) {
    return (node.widgets || []).find(w =>
        w.type === "combo" && /image/i.test(w.name || "")) || null;
}

/** 收集画布上可用的 LoadImage 目标：跳过禁用(mode 4)，按画布位置 y → x 排序 */
export function collectLoadImageTargets() {
    const nodes = app.graph?._nodes || [];
    const targets = [];
    for (const node of nodes) {
        if (node.mode === 4) continue;
        const cls = String(node.comfyClass || node.type || "");
        if (!/load.?image/i.test(cls)) continue;
        const widget = findImageWidget(node);
        if (widget) targets.push({ node, widget });
    }
    targets.sort((a, b) =>
        ((a.node.pos?.[1] ?? 0) - (b.node.pos?.[1] ?? 0))
        || ((a.node.pos?.[0] ?? 0) - (b.node.pos?.[0] ?? 0)));
    return targets;
}

/** 把输出目录里的图复制进 input（Gallery 通道），返回 LoadImage 应显示的文件名 */
async function copyOutputToInput(image) {
    const query = "?filename=" + encodeURIComponent(image.filename)
        + (image.subfolder ? "&subfolder=" + encodeURIComponent(image.subfolder) : "");
    const resp = await api.fetchApi("/neo_gallery/copy_to_input" + query);
    const result = await resp.json().catch(() => null);
    if (!resp.ok || !result || result.success === false) {
        throw new Error(result?.error || t("复制到输入目录失败"));
    }
    return result.skipped ? image.filename : result.filename;
}

export async function applyImageToTarget(target, image) {
    const filename = await copyOutputToInput(image);
    target.widget.value = filename;
    if (target.widget.type === "combo" && target.widget.callback) {
        target.widget.callback(filename);
    } else if (target.node.onWidgetChanged) {
        target.node.onWidgetChanged(target.widget.name, filename);
    }
    app.graph.setDirtyCanvas(true, true);
}

// 目标选择菜单：内联插入到按钮下方（DOM 流内布局，节点 UI 在变换容器里 fixed 定位坐标不可靠）
let openSendMenu = null;

function closeSendMenu() {
    if (!openSendMenu) return;
    openSendMenu.remove();
    openSendMenu = null;
    document.removeEventListener("pointerdown", onSendMenuOutside, true);
}

function onSendMenuOutside(e) {
    if (!openSendMenu || openSendMenu.contains(e.target)) return;
    closeSendMenu();
}

// 新建节点后 image widget 可能尚未构建完成，短轮询等待
async function waitForImageWidget(node, tries = 20, delayMs = 30) {
    for (let i = 0; i < tries; i++) {
        const w = findImageWidget(node);
        if (w) return w;
        await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error(t("Load Image 节点创建后未找到图片选项"));
}

// 画布上没有 LoadImage 时自动创建一个（放在按钮下方，屏幕坐标经 canvasPosToGraph 换算到画布坐标）并写入图片
async function createLoadImageTarget(anchorEl, image) {
    const L = globalThis.LiteGraph;
    if (!L?.createNode) throw new Error(t("无法创建 Load Image 节点"));
    const node = L.createNode("LoadImage");
    app.graph.add(node);
    try {
        const cv = app.canvas;
        const cRect = cv?.canvas?.getBoundingClientRect?.() || { left: 0, top: 0 };
        const aRect = anchorEl.getBoundingClientRect();
        const localX = aRect.left - cRect.left;
        const localY = aRect.bottom - cRect.top + 8;
        node.pos = cv?.canvasPosToGraph ? cv.canvasPosToGraph([localX, localY]) : [localX, localY];
    } catch {
        node.pos = [200, 200];
    }
    app.graph.setDirtyCanvas(true);
    const widget = await waitForImageWidget(node);
    await applyImageToTarget({ node, widget }, image);
    return { node, widget };
}

/** 单图发送：唯一目标直接写入；多目标弹菜单确认；无目标自动新建 LoadImage */
export function sendImageToLoadImage(image, anchorEl) {
    closeSendMenu();
    const targets = collectLoadImageTargets();
    if (!targets.length) {
        createLoadImageTarget(anchorEl, image)
            .then(({ node }) => showToast(app, "success", t("已发送"), tf("新建 Load Image #{id} 并写入", { id: node.id })))
            .catch(e => showToast(app, "error", t("发送失败"), e.message));
        return;
    }
    if (targets.length === 1) {
        const tgt = targets[0];
        applyImageToTarget(tgt, image)
            .then(() => showToast(app, "success", t("已发送"), tf("写入 {node} #{id}", { node: tgt.node.title || "LoadImage", id: tgt.node.id })))
            .catch(e => showToast(app, "error", t("发送失败"), e.message));
        return;
    }
    const menu = mkEl("div", "rs-gen-send-menu");
    const title = mkEl("div", "rs-gen-send-menu-title");
    title.textContent = t("发送到 Load Image");
    menu.appendChild(title);
    const selectedIds = new Set(Object.values(app.canvas?.selected_nodes || {}).map(n => n.id));
    for (const tgt of targets) {
        const item = mkEl("button", "rs-gen-send-menu-item");
        item.type = "button";
        item.textContent = `#${tgt.node.id} ${tgt.node.title || tgt.node.type || "LoadImage"}${selectedIds.has(tgt.node.id) ? "  ✓" : ""}`;
        item.addEventListener("click", () => {
            closeSendMenu();
            applyImageToTarget(tgt, image)
                .then(() => showToast(app, "success", t("已发送"), tf("写入 {node} #{id}", { node: tgt.node.title || "LoadImage", id: tgt.node.id })))
                .catch(e => showToast(app, "error", t("发送失败"), e.message));
        });
        menu.appendChild(item);
    }
    anchorEl.insertAdjacentElement("afterend", menu);
    openSendMenu = menu;
    document.addEventListener("pointerdown", onSendMenuOutside, true);
}

/** 多图装配：按画布顺序把每张图依次写入一个 LoadImage（多余图跳过并提示） */
export async function assembleAllGenerated(images) {
    if (!images?.length) return;
    const targets = collectLoadImageTargets();
    if (!targets.length) {
        showToast(app, "warning", t("装配"), t("画布上没有可用的 Load Image 节点"));
        return;
    }
    const n = Math.min(images.length, targets.length);
    let ok = 0;
    let lastError = "";
    for (let i = 0; i < n; i++) {
        try {
            await applyImageToTarget(targets[i], images[i]);
            ok++;
        } catch (e) {
            lastError = e.message;
        }
    }
    if (ok === images.length) {
        showToast(app, "success", t("装配完成"), tf("{n} 张已写入 Load Image 节点", { n: ok }));
    } else {
        const detail = targets.length < images.length
            ? tf("画布节点不足，已写入 {ok}/{total} 张", { ok, total: images.length })
            : tf("已写入 {ok}/{total} 张{err}", { ok, total: images.length, err: lastError ? t("：") + lastError : "" });
        showToast(app, ok > 0 ? "warning" : "error", t("装配"), detail);
    }
}

// ==========================================
// 生图设置表单（挂「自动增强」菜单内）
// ==========================================

export function shortModelName(name) {
    const tail = String(name || "").split("/").pop();
    return tail.replace(/\.(safetensors|sft|pt|bin|gguf)$/i, "");
}

// H3 视频模型建议：从文件列表挑首个含 h3/minimax 的名字供「自动」项显示（无匹配返回空串）
export function videoSuggestion(files) {
    return (files || []).find((n) => /h3|minimax/i.test(String(n))) || "";
}

// H3 音频 VAE：文件名同时含 h3 与 audio（与后端 suggest_audio_vae 对齐）
export function videoAudioVaeSuggestion(files) {
    return (files || []).find((n) => /h3/i.test(String(n)) && /audio/i.test(String(n))) || "";
}

// H3 视频 VAE：文件名含 h3_video（与后端 _VIDEO_MODEL_HINTS.vae 对齐），避开 audio vae
export function videoVideoVaeSuggestion(files) {
    return (files || []).find((n) => /h3_video/i.test(String(n))) || "";
}

// 主模型家族名称线索（与后端 _MODEL_HINTS 同风格）：命中则同家族条目在模型下拉里靠前
const LORA_FAMILY_HINTS = ["qwen", "krea2"];

/** 模型类下拉排序：与当前主模型同级者靠前（同目录 → 同家族关键词），其余保持后端顺序（排序稳定，只改顺序不改内容）。
 *  例：主模型 QwenImage2.1\qwen_image_2.1_int8_convrot → QwenImage2.1 目录的模型与 LoRA 最前，其次名字含 qwen 的。
 *  用于 生图模型 / Text Encoder / VAE / LoRA 四个下拉（后端统一 krea2 优先，Qwen 主模型会被埋在几百条之后）。 */
function sortByModelFamily(files, model) {
    if (!files || !files.length) return files || [];
    const path = String(model || "").replace(/\\/g, "/").toLowerCase();
    if (!path) return files;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const family = LORA_FAMILY_HINTS.find((h) => path.includes(h)) || "";
    const tier = (f) => {
        const p = String(f).replace(/\\/g, "/").toLowerCase();
        if (dir && p.startsWith(dir)) return 0;
        return family && p.includes(family) ? 1 : 2;
    };
    return [...files].sort((a, b) => tier(a) - tier(b));
}

/** 下拉项后缀：模型文件修改日期。后端 mtimes_* 给 epoch 秒，取不到（网络盘断开）就没有这一项。 */
function modelDateSuffix(name, mtimes) {
    const sec = mtimes ? mtimes[name] : 0;
    if (!sec) return "";
    const d = new Date(sec * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return ` · ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 填充 select 选项；suggested 非空时作为「自动」默认值（空值选项显示为「自动（建议名）」）；current 为当前值（含旧名模糊匹配）。
 *  mtimes：「模型名 → epoch 秒」映射，用于在下拉项后追加文件更新时间。 */
function fillComboSelect(select, files, suggested, current, mtimes) {
    select.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = suggested ? tf("自动（{model}）", { model: shortModelName(suggested) }) : t("自动");
    select.appendChild(auto);
    for (const f of files || []) {
        const opt = document.createElement("option");
        opt.value = f;
        opt.textContent = shortModelName(f) + modelDateSuffix(f, mtimes);
        select.appendChild(opt);
    }
    // config.json 可能存反斜杠（工作流导出），模型列表用正斜杠；归一化后匹配，避免已保存值回落"自动"
    let matched = "";
    let missing = false;
    if (current) {
        const norm = String(current).replace(/\\/g, "/");
        for (const f of files || []) {
            if (String(f).replace(/\\/g, "/") === norm) { matched = f; break; }   // 全路径精确命中
        }
        if (!matched) missing = true;   // 已保存值不在列表（模型被挪走/删除）
    }
    if (missing) {
        // 如实显示原值并标缺失，不再静默回填唯一同名文件——回填会误导用户以为已修好，
        // 而运行时仍读失效的 config 原值。修复交给「修复失效路径」按钮（复用后端匹配）。
        const opt = document.createElement("option");
        opt.value = current;
        opt.textContent = shortModelName(current) + t(" (缺失)");
        select.appendChild(opt);
        matched = current;
    }
    const box = select.closest(".rs-model-select-box");
    if (box) box.classList.toggle("rs-model-missing", missing);
    select.value = matched;
}

function numberRow(labelText, attrs) {
    const row = mkEl("div", "rs-config-row");
    const label = mkEl("label", "rs-form-label");
    label.textContent = labelText;
    const input = mkEl("input", "rs-form-input");
    input.type = "number";
    Object.assign(input, attrs);
    row.append(label, input);
    return { row, input };
}

/** 生图模型 / Text Encoder / VAE + LoRA 列表控件区（每技能生图设置用）。 */
export function createModelConfigSection() {
    const section = mkEl("div", "rs-gen-model-section");

    // 三个模型选择行：空值 = 按名称线索自动挑选（后端 suggest_model），用户可显式指定
    const makeComboRow = (labelText, placeholder, extraClass) => {
        const row = mkEl("div", "rs-config-row" + (extraClass ? " " + extraClass : ""));
        const label = mkEl("label", "rs-form-label");
        label.textContent = labelText;
        const select = document.createElement("select");
        const combo = attachComboBox(select, { placeholder }).box;
        row.append(label, combo);
        return { row, select };
    };
    const modelCtl = makeComboRow(t("生图模型"));
    // Text Encoder / VAE 很少改动：打 rs-gen-adv-row 标记，供技能弹窗收进折叠区（全局菜单不折叠）
    const encoderCtl = makeComboRow("Text Encoder", undefined, "rs-gen-adv-row");
    const vaeCtl = makeComboRow("VAE", undefined, "rs-gen-adv-row");

    // LoRA 行：动态增删，每行 = 模型选择 + 强度
    const loraRow = mkEl("div", "rs-config-row");
    const loraLabel = mkEl("label", "rs-form-label");
    loraLabel.textContent = "LoRA";
    const loraList = mkEl("div", "rs-gen-lora-list");
    const loraAddBtn = mkEl("button", "rs-gen-lora-add");
    loraAddBtn.type = "button";
    loraAddBtn.textContent = t("+ 添加 LoRA");
    loraRow.append(loraLabel, loraList, loraAddBtn);
    section.append(modelCtl.row, encoderCtl.row, vaeCtl.row, loraRow);

    let loraFiles = [];
    let loraMtimes = {};   // LoRA 文件修改时间（模型名 → epoch 秒），随 loraFiles 一起刷新
    let loadedModels = {};   // 最近一次 load 的 models（切换主模型后按新家族重排四个下拉）

    // LoRA 行：动态增删，每行 = 模型选择 + 强度
    function addLoraRow(name = "", strength = 1.0) {
        const line = mkEl("div", "rs-gen-lora-row");
        const select = document.createElement("select");
        const combo = attachComboBox(select).box;
        const strengthInput = mkEl("input", "rs-gen-lora-strength");
        strengthInput.type = "number";
        strengthInput.min = -10;
        strengthInput.max = 10;
        strengthInput.step = 0.05;
        strengthInput.value = strength;
        const delBtn = mkEl("button", "rs-gen-lora-del");
        delBtn.type = "button";
        delBtn.textContent = "✕";
        delBtn.setAttribute("data-rs-tooltip", t("移除此 LoRA"));
        delBtn.addEventListener("click", () => line.remove());
        line.append(combo, strengthInput, delBtn);
        fillComboSelect(select, loraFiles, "", name, loraMtimes);
        loraList.appendChild(line);
    }

    loraAddBtn.addEventListener("click", () => addLoraRow());

    /** 重建所有 LoRA 行的下拉（保留各行已选值）：模型切换 / 「自动」建议名变化时复用 */
    function refreshLoraRows() {
        for (const line of loraList.querySelectorAll(".rs-gen-lora-row")) {
            const select = line.querySelector("select");
            if (select) fillComboSelect(select, loraFiles, "", select.value, loraMtimes);
        }
    }

    // 切换主模型 → 模型 / Encoder / VAE / LoRA 四个下拉按新模型家族重排（只改顺序，不动各自已选值）
    modelCtl.select.addEventListener("change", () => fillModelSelects(modelCtl.select.value));

    /** 四个下拉统一按「当前主模型家族」排序填充（生图模型 / Text Encoder / VAE / LoRA）：
     *  同目录最前 → 同家族线索（qwen / krea2）次之 → 其余保持后端顺序。
     *  cfg 提供首次 load 的目标值（空 = 自动）；不传 cfg 表示切换主模型后重排 → 各下拉保留当前选中值。 */
    function fillModelSelects(anchor, cfg) {
        const models = loadedModels;
        fillComboSelect(modelCtl.select, sortByModelFamily(models.diffusion_models || [], anchor),
            models.suggested_diffusion_models || "", cfg ? cfg.model || "" : modelCtl.select.value,
            models.mtimes_diffusion_models);
        fillComboSelect(encoderCtl.select, sortByModelFamily(models.text_encoders || [], anchor),
            models.suggested_text_encoders || "", cfg ? cfg.text_encoder || "" : encoderCtl.select.value,
            models.mtimes_text_encoders);
        fillComboSelect(vaeCtl.select, sortByModelFamily(models.vae || [], anchor),
            models.suggested_vae || "", cfg ? cfg.vae || "" : vaeCtl.select.value,
            models.mtimes_vae);
        loraFiles = sortByModelFamily(models.loras || [], anchor);
        loraMtimes = models.mtimes_loras || {};
        refreshLoraRows();
    }

    function load(settings, models) {
        loadedModels = models || {};
        // 按 config 里的主模型定位家族：Qwen Image 2.1 主模型 → 同目录 / 名字含 qwen 的模型与 LoRA 靠前
        fillModelSelects(settings.model || models.suggested_diffusion_models || "", settings);
        loraList.innerHTML = "";
        for (const entry of settings.loras || []) {
            if (typeof entry === "string") addLoraRow(entry, 1.0);
            else if (entry && typeof entry === "object") addLoraRow(entry.name || "", entry.strength ?? 1.0);
        }
    }

    function collect() {
        const loras = [];
        for (const line of loraList.querySelectorAll(".rs-gen-lora-row")) {
            const select = line.querySelector("select");
            const strength = line.querySelector(".rs-gen-lora-strength");
            const name = select ? select.value : "";
            if (!name) continue;
            loras.push({ name, strength: parseFloat(strength?.value ?? "1") || 1.0 });
        }
        return {
            model: modelCtl.select.value,
            text_encoder: encoderCtl.select.value,
            vae: vaeCtl.select.value,
            loras,
        };
    }

    return { el: section, load, collect };
}

/** 生图张数 / 长边尺寸 / 默认比例 / 输出前缀 控件区（每技能生图设置用）。 */
export function createGenSizeRows() {
    const section = mkEl("div", "rs-gen-size-section");
    const countCtl = numberRow(t("生图张数"), { min: 1, max: 8, step: 1, value: 1 });
    // 生图张数默认隐藏 → 打 rs-gen-adv-row 标记供技能弹窗收进折叠区（全局菜单不折叠）
    countCtl.row.classList.add("rs-gen-adv-row");

    // 下拉行（长边尺寸 / 默认比例）：结构同模型选择行
    const makeChoiceRow = (labelText) => {
        const row = mkEl("div", "rs-config-row");
        const label = mkEl("label", "rs-form-label");
        label.textContent = labelText;
        const select = document.createElement("select");
        const combo = attachComboBox(select, {}).box;
        row.append(label, combo);
        return { row, select };
    };
    const sizeCtl = makeChoiceRow(t("长边尺寸"));
    const ratioCtl = makeChoiceRow(t("默认比例"));
    // 采样步数：写 skill config.json 的 steps（模板 {{STEPS}}），缺省 20（与后端 resolve 一致）
    const stepsCtl = numberRow(t("步数"), { min: 1, max: 100, step: 1, value: 20 });

    // 输出前缀（可含子目录），写入模板 {{PREFIX}}；很少改动 → 打 rs-gen-adv-row 标记供技能弹窗收进折叠区（全局菜单不折叠）
    const prefixRow = mkEl("div", "rs-config-row rs-gen-adv-row");
    const prefixLabel = mkEl("label", "rs-form-label");
    prefixLabel.textContent = t("输出前缀");
    const prefixInput = mkEl("input", "rs-form-input");
    prefixInput.type = "text";
    prefixInput.placeholder = "NeoAgent";
    prefixRow.append(prefixLabel, prefixInput);

    // 常用长边（像素）与比例下拉可选；空值（「默认」）= 走后端默认；
    // 未列出的已保存值自动追加为「…（已保存）」项保留，避免切下拉即丢数据
    const COMMON_EDGES = ["1024", "1152", "1280", "1536", "1792", "2048", "2560", "3072"];
    const COMMON_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
    function fillChoiceSelect(select, options, current, defaultValue) {
        select.innerHTML = "";
        const auto = document.createElement("option");
        auto.value = "";
        // 「默认」项标注后端实际默认值（base_resolution=1280 / default_ratio=1:1），让用户知道空值会出什么尺寸
        auto.textContent = defaultValue ? tf("默认 ({v})", { v: defaultValue }) : t("默认");
        select.appendChild(auto);
        for (const v of options) {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = v;
            select.appendChild(opt);
        }
        select.value = options.includes(current) ? current : "";
        if (current && !options.includes(current)) {
            const keep = document.createElement("option");
            keep.value = current;
            keep.textContent = current + t("（已保存）");
            select.appendChild(keep);
            select.value = current;
        }
    }

    // 张数 / 长边 / 比例 / 步数 / 前缀各占一行（标签 | 控件），与模型区两栏风格统一
    section.append(countCtl.row, sizeCtl.row, ratioCtl.row, stepsCtl.row, prefixRow);

    function load(settings) {
        countCtl.input.value = settings.count ?? 1;
        fillChoiceSelect(sizeCtl.select, COMMON_EDGES, String(settings.base_resolution ?? ""), "1280");
        fillChoiceSelect(ratioCtl.select, COMMON_RATIOS, String(settings.default_ratio ?? ""), "1:1");
        stepsCtl.input.value = settings.steps ?? 20;
        prefixInput.value = settings.output_prefix ?? "";
    }

    function collect() {
        return {
            count: parseInt(countCtl.input.value, 10) || 1,
            base_resolution: parseInt(sizeCtl.select.value, 10) || 1280,
            default_ratio: ratioCtl.select.value.trim(),
            steps: parseInt(stepsCtl.input.value, 10) || 20,
            output_prefix: prefixInput.value.trim(),
        };
    }

    return { el: section, load, collect };
}

/** 生视频模型 / Text Encoder / VAE（视频）/ VAE（音频）控件区（每技能生视频设置用）。
 *  空值 = 回落全局「生视频模型」设置，再按 H3 名称线索自动挑选。 */
export function createVideoModelConfigSection() {
    const section = mkEl("div", "rs-gen-model-section");

    const makeComboRow = (labelText, extraClass) => {
        const row = mkEl("div", "rs-config-row" + (extraClass ? " " + extraClass : ""));
        const label = mkEl("label", "rs-form-label");
        label.textContent = labelText;
        const select = document.createElement("select");
        const combo = attachComboBox(select, {}).box;
        row.append(label, combo);
        return { row, select };
    };
    const modelCtl = makeComboRow(t("生视频模型"));
    // Text Encoder / 视频 VAE / 音频 VAE 很少改动：打 rs-gen-adv-row 标记，供技能弹窗收进折叠区
    const encoderCtl = makeComboRow("Text Encoder", "rs-gen-adv-row");
    const videoVaeCtl = makeComboRow(t("VAE（视频）"), "rs-gen-adv-row");
    const audioVaeCtl = makeComboRow(t("VAE（音频）"), "rs-gen-adv-row");
    // 采样步数：写 skill config.json 的 steps（模板 {{STEPS}}），缺省 20；放可见区，不收进高级折叠
    const stepsCtl = numberRow(t("步数"), { min: 1, max: 100, step: 1, value: 20 });

    // LoRA 行：动态增删，每行 = 模型选择 + 强度
    const loraRow = mkEl("div", "rs-config-row");
    const loraLabel = mkEl("label", "rs-form-label");
    loraLabel.textContent = "LoRA";
    const loraList = mkEl("div", "rs-gen-lora-list");
    const loraAddBtn = mkEl("button", "rs-gen-lora-add");
    loraAddBtn.type = "button";
    loraAddBtn.textContent = t("+ 添加 LoRA");
    loraRow.append(loraLabel, loraList, loraAddBtn);

    section.append(modelCtl.row, stepsCtl.row, encoderCtl.row, videoVaeCtl.row, audioVaeCtl.row, loraRow);

    let loraFiles = [];
    let loraMtimes = {};   // LoRA 文件修改时间（模型名 → epoch 秒）

    function addLoraRow(name = "", strength = 1.0) {
        const line = mkEl("div", "rs-gen-lora-row");
        const select = document.createElement("select");
        const combo = attachComboBox(select).box;
        const strengthInput = mkEl("input", "rs-gen-lora-strength");
        strengthInput.type = "number";
        strengthInput.min = -10;
        strengthInput.max = 10;
        strengthInput.step = 0.05;
        strengthInput.value = strength;
        const delBtn = mkEl("button", "rs-gen-lora-del");
        delBtn.type = "button";
        delBtn.textContent = "✕";
        delBtn.setAttribute("data-rs-tooltip", t("移除此 LoRA"));
        delBtn.addEventListener("click", () => line.remove());
        line.append(combo, strengthInput, delBtn);
        fillComboSelect(select, loraFiles, "", name, loraMtimes);
        loraList.appendChild(line);
    }

    loraAddBtn.addEventListener("click", () => addLoraRow());

    function load(settings, models) {
        loraFiles = models.loras || [];
        loraMtimes = models.mtimes_loras || {};
        fillComboSelect(modelCtl.select, models.diffusion_models || [],
            videoSuggestion(models.diffusion_models), settings.model || "", models.mtimes_diffusion_models);
        fillComboSelect(encoderCtl.select, models.text_encoders || [],
            videoSuggestion(models.text_encoders), settings.text_encoder || "", models.mtimes_text_encoders);
        fillComboSelect(videoVaeCtl.select, models.vae || [],
            videoVideoVaeSuggestion(models.vae), settings.vae || "", models.mtimes_vae);
        fillComboSelect(audioVaeCtl.select, models.vae || [],
            videoAudioVaeSuggestion(models.vae), settings.audio_vae || "", models.mtimes_vae);
        stepsCtl.input.value = settings.steps ?? 20;
        loraList.innerHTML = "";
        for (const entry of settings.loras || []) {
            if (typeof entry === "string") addLoraRow(entry, 1.0);
            else if (entry && typeof entry === "object")
                addLoraRow(entry.name || "", entry.strength ?? 1.0);
        }
    }

    function collect() {
        const loras = [];
        for (const line of loraList.querySelectorAll(".rs-gen-lora-row")) {
            const select = line.querySelector("select");
            const strength = line.querySelector(".rs-gen-lora-strength");
            const name = select ? select.value : "";
            if (!name) continue;
            loras.push({ name, strength: parseFloat(strength?.value ?? "1") || 1.0 });
        }
        return {
            model: modelCtl.select.value.trim(),
            text_encoder: encoderCtl.select.value.trim(),
            vae: videoVaeCtl.select.value.trim(),
            audio_vae: audioVaeCtl.select.value.trim(),
            steps: parseInt(stepsCtl.input.value, 10) || 20,
            loras,
        };
    }

    return { el: section, load, collect };
}

/** 全局生图默认设置表单（「自动增强」菜单内）：核心模型 / Text Encoder / VAE / 目标像素数（MP）/ 输出前缀 + 保存按钮。
 *  独立实现，不复用每技能设置的 createModelConfigSection / createGenSizeRows；
 *  张数 / 长边尺寸 / 默认比例 / LoRA 只在每技能设置里配置，Enhance Prompt 开关在技能正文（System Prompt Content）旁。 */
export function createImageGenSettingsForm() {
    const form = mkEl("div", "rs-gen-settings");

    // 三个模型选择行：空值 = 按名称线索自动挑选（后端 suggest_model），用户可显式指定
    const makeComboRow = (labelText) => {
        const row = mkEl("div", "rs-config-row");
        const label = mkEl("label", "rs-form-label");
        label.textContent = labelText;
        const select = document.createElement("select");
        const combo = attachComboBox(select, {}).box;
        row.append(label, combo);
        return { row, select };
    };
    const modelCtl = makeComboRow(t("生图模型"));
    const encoderCtl = makeComboRow("Text Encoder");
    const vaeCtl = makeComboRow("VAE");
    // 模型工作分辨率（MP）：扩图补边画布归一化到此像素数；画廊编辑的目标默认超过它时等比封顶
    const mpCtl = numberRow(t("目标像素数 (MP)"), { min: 0.1, max: 16, step: 0.1, value: 1.5 });
    mpCtl.input.title = t("Qwen Image 2.1 的工作分辨率：扩图补边画布缩放到该像素数；画廊编辑目标超过它时等比封顶");

    // 输出前缀（可含子目录），写入模板 {{PREFIX}}
    const prefixRow = mkEl("div", "rs-config-row");
    const prefixLabel = mkEl("label", "rs-form-label");
    prefixLabel.textContent = t("输出前缀");
    const prefixInput = mkEl("input", "rs-form-input");
    prefixInput.type = "text";
    prefixInput.placeholder = "NeoAgent";
    prefixRow.append(prefixLabel, prefixInput);

    // 显式保存按钮：选择后立即落盘，不依赖关菜单时的静默保存
    const saveBtn = mkEl("button", "rs-gen-save");
    saveBtn.type = "button";
    saveBtn.textContent = t("💾 保存设置");
    let saveResetTimer = null;
    saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        const ok = await save();
        saveBtn.disabled = false;
        saveBtn.textContent = ok ? t("✓ 已保存") : t("✕ 保存失败");
        clearTimeout(saveResetTimer);
        saveResetTimer = setTimeout(() => { saveBtn.textContent = t("💾 保存设置"); }, 1600);
    });
    const saveRow = mkEl("div", "rs-config-row");
    saveRow.appendChild(saveBtn);

    form.append(modelCtl.row, encoderCtl.row, vaeCtl.row, mpCtl.row, prefixRow, saveRow);

    // 加载窗口标记：load() 异步回填期间（await 网络请求）不算 dirty，避免初始化误判
    let loading = false;

    async function load() {
        loading = true;
        try {
            const [settings, models] = await Promise.all([getGenSettings(), listGenModels()]);
            fillComboSelect(modelCtl.select, models.diffusion_models || [],
                models.suggested_diffusion_models || "", settings.model || "", models.mtimes_diffusion_models);
            fillComboSelect(encoderCtl.select, models.text_encoders || [],
                models.suggested_text_encoders || "", settings.text_encoder || "", models.mtimes_text_encoders);
            fillComboSelect(vaeCtl.select, models.vae || [],
                models.suggested_vae || "", settings.vae || "", models.mtimes_vae);
            prefixInput.value = settings.output_prefix ?? "";
            mpCtl.input.value = settings.target_megapixels ?? 1.5;
            snapshot = collect();
        } catch (e) {
            console.warn("Failed to load image gen settings:", e);
        } finally {
            loading = false;
        }
    }

    // 收集当前表单值（与后端 /neo_image_gen/settings 字段对齐）；save 与脏检查共用
    function collect() {
        return {
            model: modelCtl.select.value,
            text_encoder: encoderCtl.select.value,
            vae: vaeCtl.select.value,
            target_megapixels: parseFloat(mpCtl.input.value) || 1.5,
            output_prefix: prefixInput.value.trim(),
        };
    }

    // load/save 后的表单快照，用于关闭菜单时判断是否有未保存修改
    let snapshot = null;

    async function save() {
        try {
            await saveGenSettings(collect());
            snapshot = collect();
            return true;
        } catch (e) {
            console.warn("Failed to save image gen settings:", e);
            return false;
        }
    }

    // 当前表单相对最近一次 load/save 是否有改动（供关闭菜单时确认用）；加载窗口内恒为 false
    function isDirty() {
        if (loading) return false;
        return snapshot !== null && JSON.stringify(collect()) !== JSON.stringify(snapshot);
    }

    return { el: form, load, save, isDirty };
}

/** 全局生视频（MiniMax H3）默认设置表单（「自动增强」菜单内独立 tab）：视频模型 / Text Encoder (视频) / VAE (视频) / VAE (音频) + 保存按钮。
 *  与生图共用 diffusion_models/text_encoders/vae 目录，但独立成页；save 只提交 video_* 字段（后端合并，不覆盖生图设置）。 */
export function createVideoGenSettingsForm() {
    const form = mkEl("div", "rs-gen-settings");

    // 三个模型选择行：空值 = 按名称线索自动挑选（videoSuggestion），用户可显式指定
    const makeComboRow = (labelText) => {
        const row = mkEl("div", "rs-config-row");
        const label = mkEl("label", "rs-form-label");
        label.textContent = labelText;
        const select = document.createElement("select");
        const combo = attachComboBox(select, {}).box;
        row.append(label, combo);
        return { row, select };
    };

    // 生视频模型（MiniMax H3）：与生图共用 diffusion_models/text_encoders/vae 目录，独立设置项
    const videoHeading = mkEl("div", "rs-gen-video-heading");
    videoHeading.textContent = t("生视频模型（MiniMax H3）");
    const videoModelCtl = makeComboRow(t("视频模型"));
    const videoEncoderCtl = makeComboRow(t("Text Encoder (视频)"));
    const videoVaeCtl = makeComboRow(t("VAE (视频)"));
    const videoAudioVaeCtl = makeComboRow(t("VAE (音频)"));

    // 显式保存按钮：选择后立即落盘，不依赖关菜单时的静默保存
    const saveBtn = mkEl("button", "rs-gen-save");
    saveBtn.type = "button";
    saveBtn.textContent = t("💾 保存设置");
    let saveResetTimer = null;
    saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        const ok = await save();
        saveBtn.disabled = false;
        saveBtn.textContent = ok ? t("✓ 已保存") : t("✕ 保存失败");
        clearTimeout(saveResetTimer);
        saveResetTimer = setTimeout(() => { saveBtn.textContent = t("💾 保存设置"); }, 1600);
    });
    const saveRow = mkEl("div", "rs-config-row");
    saveRow.appendChild(saveBtn);

    form.append(videoHeading, videoModelCtl.row, videoEncoderCtl.row, videoVaeCtl.row, videoAudioVaeCtl.row, saveRow);

    // 加载窗口标记：load() 异步回填期间（await 网络请求）不算 dirty，避免初始化误判
    let loading = false;

    async function load() {
        loading = true;
        try {
            const [settings, models] = await Promise.all([getVideoGenSettings(), listVideoGenModels()]);
            fillComboSelect(videoModelCtl.select, models.diffusion_models || [],
                videoSuggestion(models.diffusion_models), settings.video_model || "", models.mtimes_diffusion_models);
            fillComboSelect(videoEncoderCtl.select, models.text_encoders || [],
                videoSuggestion(models.text_encoders), settings.video_text_encoder || "", models.mtimes_text_encoders);
            fillComboSelect(videoVaeCtl.select, models.vae || [],
                videoVideoVaeSuggestion(models.vae), settings.video_vae || "", models.mtimes_vae);
            fillComboSelect(videoAudioVaeCtl.select, models.vae || [],
                videoAudioVaeSuggestion(models.vae), settings.video_audio_vae || "", models.mtimes_vae);
            snapshot = collect();
        } catch (e) {
            console.warn("Failed to load video gen settings:", e);
        } finally {
            loading = false;
        }
    }

    // 收集当前表单值（与后端 /neo_video_gen/settings 的 video_* 字段对齐）；save 与脏检查共用。空 = 自动挑选
    function collect() {
        return {
            video_model: videoModelCtl.select.value,
            video_text_encoder: videoEncoderCtl.select.value,
            video_vae: videoVaeCtl.select.value,
            video_audio_vae: videoAudioVaeCtl.select.value,
        };
    }

    // load/save 后的表单快照，用于关闭菜单时判断是否有未保存修改
    let snapshot = null;

    async function save() {
        try {
            await saveVideoGenSettings(collect());
            snapshot = collect();
            return true;
        } catch (e) {
            console.warn("Failed to save video gen settings:", e);
            return false;
        }
    }

    // 当前表单相对最近一次 load/save 是否有改动（供关闭菜单时确认用）；加载窗口内恒为 false
    function isDirty() {
        if (loading) return false;
        return snapshot !== null && JSON.stringify(collect()) !== JSON.stringify(snapshot);
    }

    return { el: form, load, save, isDirty };
}
