/**
 * skill-writeback.js
 * 工作流回写与画布交接：回写确认弹窗、变更记录弹窗、导入画布后的待回写状态（绿点）、
 * Studio 与主画布交接（?neo_wf_edit=<skill_id>）与顶菜单回写入技能入口。
 */

import { app } from "../../../scripts/app.js";
import { mkEl } from "../dom-utils.js";
import { showToast } from "../gallery-utils.js";
import { t, tf } from "../js/core/i18n.js";
import { previewWorkflowSkill, updateWorkflowSkill, getSkillGenConfig, listGenModels, listVideoGenModels } from "../image-gen.js";
import {
    dispatchSkillsUpdated, makeRepairDialog, loadSkill, loadSkillWorkflow,
    buildCanvasWorkflow, arrangeCanvasNodes, serializeCanvasPrompt, copySkillAsCustom,
    writeLog, SKILL_WRITE_LOG_LIMIT, WRITE_SOURCE_LABELS, WRITE_API_ONLY_NOTE, buildWriteChangesTable,
    skillDisplayName, workflowParamValues,
} from "./skill-core.js";
import { filledTokenNotes } from "../workflow-graph.js";

/** 变更记录弹窗：skillId 省略 = 全部技能（按技能分组，新→旧）；纯本地记录，可清空 */
export function showSkillWriteLogDialog(skillId) {
    const log = writeLog.get(skillId);
    const { body, foot, close } = makeRepairDialog(skillId ? tf("变更记录 · {id}（{n}）", { id: skillId, n: log.length }) : tf("变更记录（{n}）", { n: log.length }), "rs-skill-write-log-overlay");
    if (!log.length) {
        const empty = mkEl("div", "rs-repair-log-empty");
        empty.textContent = t("暂无回写记录 — 画布改完点「回写入技能」并确认后，每次变更会按技能记录在这里。");
        body.appendChild(empty);
    } else {
        for (const entry of log) {
            const group = mkEl("div", "rs-repair-log-group");
            const timeEl = mkEl("div", "rs-repair-log-time");
            timeEl.textContent = [
                new Date(entry.time).toLocaleString("zh-CN", { hour12: false }),
                entry.kind === "gen_video" ? t("生视频") : t("生图"),
                WRITE_SOURCE_LABELS[entry.source] || t("其他"),
                skillId ? null : entry.skillId,
            ].filter(Boolean).join(" · ");
            group.appendChild(timeEl);
            const changes = entry.changes || [];
            if (changes.length) {
                group.appendChild(buildWriteChangesTable(changes));
            } else {
                const none = mkEl("div", "rs-repair-hint");
                none.textContent = t("无键值变更 — 按当前画布重写 workflow.json");
                group.appendChild(none);
            }
            if ((entry.warnings || []).length) {
                const w = mkEl("div", "rs-repair-hint");
                w.style.color = "#da6";
                w.textContent = entry.warnings.join(" / ");
                group.appendChild(w);
            }
            body.appendChild(group);
        }
    }
    const hint = mkEl("span", "rs-repair-hint");
    hint.textContent = tf("仅本机本地记录（每技能最近 {n} 次），不影响技能文件", { n: SKILL_WRITE_LOG_LIMIT });
    const clearBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
    clearBtn.type = "button";
    clearBtn.textContent = t("清空记录");
    foot.append(hint, clearBtn);
    clearBtn.addEventListener("click", () => {
        writeLog.clear(skillId);
        close();
        showToast(app, "info", skillId ? t("本技能变更记录已清空") : t("全部变更记录已清空"));
    });
}
/** 回写确认弹窗：先预览变更清单与 warnings，点「确认保存」才落盘；返回是否已保存 */
function confirmWorkflowWrite(id, source, workflow, displayName, onSaved) {
    const label = displayName || id;
    return previewWorkflowSkill(id, workflow).then((preview) => new Promise((resolve) => {
        const changes = preview.changes || [];
        const warnings = preview.warnings || [];
        const { body, foot, overlay, close } = makeRepairDialog(tf("回写入技能 · {label}（{n} 处变更）", { label, n: changes.length }), "rs-wf-write-confirm", () => {
            document.removeEventListener("keydown", onKey);
            resolve(false);
        });
        const onKey = (e) => { if (e.key === "Escape") close(); };
        document.addEventListener("keydown", onKey);
        if (changes.length) {
            body.appendChild(buildWriteChangesTable(changes));
        } else {
            const empty = mkEl("div", "rs-repair-log-empty");
            empty.textContent = t("画布内容与技能已保存的工作流一致 — 保存只会按当前画布重写 workflow.json / config.json。");
            body.appendChild(empty);
        }
        if (preview.preset) {
            const presetHint = mkEl("div", "rs-repair-hint");
            presetHint.textContent = preview.structural
                ? t("预设技能不改 workflow.json：模型值写入预设本地覆盖（configs/skill_overrides/），结构变更会自动复制为自定义技能写入")
                : t("预设技能：模型值写入预设本地覆盖（configs/skill_overrides/），不改 workflow.json");
            body.appendChild(presetHint);
        }
        if (warnings.length) {
            const warn = mkEl("div", "rs-repair-hint");
            warn.style.color = "#da6";
            warn.textContent = warnings.join(" / ");
            body.appendChild(warn);
        }
        const hint = mkEl("span", "rs-repair-hint");
        hint.textContent = WRITE_API_ONLY_NOTE;
        const cancelBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
        cancelBtn.type = "button";
        cancelBtn.textContent = t("取消");
        const saveBtn = mkEl("button", "rs-btn");
        saveBtn.type = "button";
        saveBtn.textContent = t("确认保存");
        foot.append(hint, cancelBtn, saveBtn);
        cancelBtn.addEventListener("click", close);
        saveBtn.addEventListener("click", async () => {
            saveBtn.disabled = true;
            const kind = preview.gen_video ? "gen_video" : "gen_image";
            try {
                const r = await updateWorkflowSkill(id, workflow);
                writeLog.record(id, { source: source || "canvas", kind: kind || "gen_image", changes: changes || [], warnings: warnings || [] });
                let summary = tf("已回写入技能 \"{label}\"", { label });
                let detail = (r.warnings || []).join("\n");
                let copy = null;
                // 预设不改结构：结构变更自动落进新建的自定义副本，待回写状态跟着搬到副本
                if (preview.preset && preview.structural) {
                    copy = await copySkillAsCustom(id, id);
                    if (copy) {
                        await updateWorkflowSkill(copy.id, workflow);
                        writeLog.record(copy.id, { source: source, kind: kind, changes: changes, warnings: warnings });
                        setPendingWriteback(copy.id, "custom", copy.name);
                        summary = tf("已复制为自定义技能 \"{name}\" 并写入工作流", { name: copy.name });
                        detail = [tf("模型值已写入 \"{id}\" 的本地覆盖", { id }), detail].filter(Boolean).join("\n");
                    }
                }
                document.removeEventListener("keydown", onKey);
                overlay.remove();
                showToast(app, "success", summary, detail);
                dispatchSkillsUpdated();
                if (onSaved) await onSaved(r, copy);
                resolve(true);
            } catch (err) {
                saveBtn.disabled = false;
                showToast(app, "error", t("回写入失败"), err.message);
                resolve(false);
            }
        });
    }));
}


// 整画布 API prompt 回写指定技能：先弹变更确认，确认后才落盘（custom 写 workflow.json；预设只写模型值到本地覆盖）
async function writeWorkflowToSkill(id, origin, displayName) {
    if (!id) { showToast(app, "warning", t("回写入技能"), t("技能未保存，先保存技能本体")); return false; }
    if (typeof app.graphToPrompt !== "function") { showToast(app, "warning", t("无画布"), t("当前视图没有画布，回写不可用")); return false; }
    try {
        const { output, error } = await serializeCanvasPrompt();
        if (error || !output || !Object.keys(output).length) {
            showToast(app, "warning", t("无法回写"), t("画布没有有效工作流") + (error?.message ? tf("（{msg}）", { msg: error.message }) : ""));
            return false;
        }
        const saved = await confirmWorkflowWrite(id, origin || "canvas", output, displayName);
        if (saved) clearPendingWriteback(id);
        return saved;
    } catch (err) {
        showToast(app, "error", t("回写入失败"), err.message);
        return false;
    }
}

// 导入画布后的待回写状态：Studio 交接与技能管理「⤒ 导入到画布」共用同一套行为。
// 画布上不挂常驻 toast 卡片——顶菜单「回写入技能」是唯一落盘入口，绿点就是待回写提示。
// 状态绑定灌入时那张画布（graph 实例）：切走 tab 绿点收起、切回恢复；同画布后导入的顶掉前一个。
let pendingWriteback = null;   // { id, source, wf } —— 灌入技能的那张画布
let _wbUnwatchTab = null;
let _wbHintObserver = null;

function writebackCanvasActive() {
    const wfStore = app.extensionManager?.workflow;
    if (!pendingWriteback?.wf || !wfStore) return true;   // 无工作流 tab store → 单画布
    return wfStore.activeWorkflow === pendingWriteback.wf;
}

// 顶菜单按钮绿点（workflow.js 修复红点同款机制）：绿色 = 当前画布有技能待回写
function applyWritebackHint() {
    const btn = document.querySelector(".neo-n-menu-btn");
    if (!btn) return;
    const on = !!pendingWriteback && writebackCanvasActive();
    btn.classList.toggle("neo-writeback-hint", on);
    if (on) {
        btn.dataset.wbOrigAria ??= btn.getAttribute("aria-label");
        btn.setAttribute("aria-label", tf("回写入技能：技能 \"{name}\" 待保存", { name: pendingWriteback.displayName || pendingWriteback.id }));
    } else if (btn.dataset.wbOrigAria !== undefined) {
        btn.setAttribute("aria-label", btn.dataset.wbOrigAria);
        delete btn.dataset.wbOrigAria;
    }
}

// 顶栏按钮 DOM 由前端声明式重建，重建后补挂绿点
function startWritebackHintObserver() {
    if (_wbHintObserver || typeof MutationObserver === "undefined") return;
    _wbHintObserver = new MutationObserver(() => applyWritebackHint());
    const watchNode = document.querySelector('[data-testid="action-bar-buttons"]')
        || document.querySelector(".actionbar-container")
        || document.body;
    _wbHintObserver.observe(watchNode, { childList: true, subtree: true });
}

// 换 tab 只改 store 的 activeWorkflow，画布 DOM 上没有 litegraph:set-graph 可听 → 订阅 store 重算绿点
function watchWritebackTab() {
    _wbUnwatchTab?.();
    const wfStore = app.extensionManager?.workflow;
    if (!wfStore || !pendingWriteback?.wf || typeof wfStore.$subscribe !== "function") return;
    const off = wfStore.$subscribe(() => applyWritebackHint());
    _wbUnwatchTab = () => { _wbUnwatchTab = null; off?.(); };
}

function setPendingWriteback(id, source, displayName) {
    pendingWriteback = { id, source, displayName: displayName || id, wf: app.extensionManager?.workflow?.activeWorkflow ?? null };
    startWritebackHintObserver();
    applyWritebackHint();
}

function clearPendingWriteback(id) {
    if (id && pendingWriteback && pendingWriteback.id !== id) return;
    pendingWriteback = null;
    _wbUnwatchTab?.();
    applyWritebackHint();
}

/** 当前画布上待回写的技能（切走 tab → null）：顶菜单入口与绿点的可用性据此决定 */
function getPendingWriteback() {
    if (!pendingWriteback || !writebackCanvasActive()) return null;
    return { id: pendingWriteback.id, source: pendingWriteback.source };
}

/** 顶菜单「回写入技能」：画布上没有回写卡片，这里是待回写技能的唯一落盘入口 */
async function runCanvasSkillWriteback() {
    if (!pendingWriteback) {
        showToast(app, "info", t("回写入技能"), t("当前画布没有待回写的技能：技能管理「⤒ 导入到画布」后此入口可用"));
        return false;
    }
    return await writeWorkflowToSkill(pendingWriteback.id, "canvas", pendingWriteback.displayName);
}

/** 技能工作流灌进画布后登记待回写：点亮 绿点，顶菜单「回写入技能」据此可用 */
function armCanvasWriteback(id, source, displayName, notes) {
    setPendingWriteback(id, source, displayName);
    watchWritebackTab();
    // 画布上没有 {{变量}}：技能模板里的变量在灌画布这一步被技能设置写成了数值。导入成功当场说清
    // 每个变量的来源（尺寸 = 长边尺寸 × 默认比例 算出来的）与生成时的行为，画布上那个数字就不再是
    // 「技能里的尺寸」——改设置才会变，本次生成还会按本次宽高重算。
    if (notes && notes.length) {
        showToast(app, "info", tf("已按技能设置灌入 {n} 个模板变量", { n: notes.length }),
            notes.join("\n") + "\n" + t("画布上只剩算出来的数值：生成时尺寸按本次请求的宽高重算，回写入技能时按模板复原这些变量"));
    }
}

// ---- Studio ⇄ 主画布交接 ----
// Studio 没有 LiteGraph，工作流编辑交回主界面：技能详情「⤒ 主画布编辑」开 /?neo_wf_edit=<skill_id>，
// 主界面扩展 setup 消费该参数灌画布，灌入后点亮 绿点、顶菜单「回写入技能」落盘（技能详情弹窗不在场也能写）。
const WF_EDIT_PARAM = "neo_wf_edit";

function openSkillWorkflowInMainUi(id) {
    if (!id) { showToast(app, "warning", t("主画布编辑"), t("技能未保存，先保存技能本体")); return; }
    // 主画布只在 ComfyUI 自己的页面上：离线页里 "/" 是桌面端的只读服务，根路径没有页面，
    // ComfyUI 没就绪时开出去只会是「页面不存在」。运行状态顶栏已经报了，照它拦一下。
    if (document.body.classList.contains("ns-offline")) {
        const starting = document.getElementById("ns-comfy-status")?.classList.contains("ns-comfy-starting");
        showToast(app, "warning", t("主画布编辑"), starting
            ? t("ComfyUI 启动中…就绪后再编辑主画布")
            : t("该功能需要 ComfyUI · 在「设置 → 启动设置」点「启动内核」"));
        return;
    }
    window.open(`/?${WF_EDIT_PARAM}=${encodeURIComponent(id)}`, "_blank");
}

/** 技能 workflow.json 灌进主画布：设置区不在场 → 按技能 config.json + 自动建议模型预渲染（同「导入到画布」） */
async function openSkillWorkflowOnCanvas(id) {
    const [full, wf] = await Promise.all([loadSkill(id), loadSkillWorkflow(id)]);
    const displayName = full && !full.error ? (skillDisplayName(full) || id) : id;
    if (!full || full.error) { showToast(app, "warning", t("主画布编辑"), tf("技能 \"{name}\" 不存在", { name: displayName })); return; }
    if (!wf) { showToast(app, "warning", t("无工作流"), tf("技能 \"{name}\" 没有 workflow.json", { name: displayName })); return; }
    if (typeof app.loadApiJson !== "function") { showToast(app, "warning", t("无画布"), t("当前视图没有画布，导入不可用")); return; }
    const isVideo = !!full.gen_video;
    const models = isVideo ? await listVideoGenModels().catch(() => ({})) : await listGenModels().catch(() => ({}));
    const cfg = (await getSkillGenConfig(id)) || {};
    const canvasWf = await buildCanvasWorkflow(wf, cfg, models, isVideo, { controlRef: cfg.control_ref });
    try {
        await app.loadApiJson(canvasWf, id);
        arrangeCanvasNodes(canvasWf);
    } catch (e) {
        showToast(app, "error", t("导入失败"), String(e.message || e));
        return;
    }
    const source = full.source || "custom";
    armCanvasWriteback(id, source, displayName,
        filledTokenNotes(canvasWf, workflowParamValues(isVideo, { config: cfg, models })));
}

/** 主界面启动时消费 ?neo_wf_edit=<skill_id>：清掉参数（刷新不重复导入）后灌画布。
 *  主界面自身的初始工作流加载排在扩展 setup 之后，抢先灌图会被它覆盖 →
 *  等前端换图事件（画布 DOM 上的 litegraph:set-graph）落地，超时兜底。 */
function runSkillWorkflowHandoff() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get(WF_EDIT_PARAM);
    if (!id) return;
    params.delete(WF_EDIT_PARAM);
    const q = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : "") + window.location.hash);
    const canvasEl = app.canvas?.canvas;
    let fired = false;
    const run = () => {
        if (fired) return;
        fired = true;
        if (canvasEl) canvasEl.removeEventListener("litegraph:set-graph", run);
        openSkillWorkflowOnCanvas(id);
    };
    if (canvasEl) canvasEl.addEventListener("litegraph:set-graph", run);
    setTimeout(run, 2000);
}

// ==========================================
// 导出
// ==========================================
export {
    confirmWorkflowWrite, writeWorkflowToSkill, armCanvasWriteback,
    openSkillWorkflowInMainUi, openSkillWorkflowOnCanvas, runSkillWorkflowHandoff,
    getPendingWriteback, runCanvasSkillWriteback
};
