/**
 * skill-detail-popup.js
 * 单技能详情弹窗（查看 / 编辑 / 删除 / 复制为自定义 / 新建）与跨节点单例。
 * 由技能下拉的行内操作与底部工具栏打开；overlay 挂到 document.body，跨节点共享一个实例。
 */

import { app } from "../../../scripts/app.js";
import { mkEl } from "../dom-utils.js";
import { showToast } from "../gallery-utils.js";
import { openModelHub } from "../model-hub.js";
import { checkWorkflow, renderWorkflowGraph, applyWorkflowParams, validateWorkflow, injectRuntimeLoras, canvasLayout, filledTokenNotes } from "../workflow-graph.js";
import { updateWorkflowSkill, getSkillGenConfig, saveSkillGenConfig, listGenModels, createModelConfigSection, createGenSizeRows, createVideoModelConfigSection, listVideoGenModels, shortModelName } from "../image-gen.js";
import {
    dispatchSkillsUpdated, stopPointerBubble, makeRepairDialog, listSkills, loadSkill, loadSkillWorkflow,
    saveSkill, deleteSkill, loadSkillFile, saveSkillFile, deleteSkillFile, resetSkillGenConfig,
    workflowParamValues, buildCanvasWorkflow, arrangeCanvasNodes, makeSkillLog,
    renderMarkdown, dispatchSkillChanged, copySkillAsCustom, skillDisplayName,
} from "./skill-core.js";
import { confirmWorkflowWrite, writeWorkflowToSkill, showSkillWriteLogDialog, armCanvasWriteback, openSkillWorkflowInMainUi } from "./skill-writeback.js";
import { t, tf } from "../js/core/i18n.js";
import { icon, setIconLabel } from "../js/core/icons.js";

// ==========================================
// UI：createSkillDetailPopup() —— 单技能详情弹窗（查看 / 编辑 / 删除 / 复制为自定义 / 新建）
// 由技能下拉的行内操作与底部工具栏打开；overlay 挂到 document.body，跨节点共享一个实例。
// 返回 { overlay, openExisting(id, source), openNew(), close }。canvasBtns=false（Studio 内嵌，无画布）时工作流区画布按钮不挂。
// ==========================================

function createSkillDetailPopup(host, canvasBtns = true, opts = {}) {
    const embedded = !!host;   // 内嵌模式：modal 挂到调用方容器（统一技能管理窗口右侧），不自建遮罩、不监听全局 Esc/点遮罩
    const onCloseWindow = opts.onCloseWindow;   // 内嵌宿主（技能管理整窗）注入：导入到画布后收起整窗，避免遮挡画布
    const overlay = mkEl("div", "rs-skill-modal-overlay");
    const modal = mkEl("div", "rs-skill-modal rs-skill-detail");
    const showDetail = () => { if (embedded) modal.style.display = ""; else overlay.style.display = "flex"; };

    // ---- 头部：标题 + 技能名称（点击进入行内编辑）+ 来源徽标 + 复制为自定义 + 关闭 ----
    const header = mkEl("div", "rs-skill-modal-header");
    const titleSpan = mkEl("span", "rs-skill-modal-title");
    titleSpan.textContent = t("📝 技能");
    const nameView = mkEl("span", "rs-skill-name-view");
    nameView.title = t("点击编辑技能名称（Enter / 失焦提交，Esc 还原）");
    const nameInput = mkEl("input", "rs-form-input rs-tpl-name rs-skill-name-input");
    nameInput.placeholder = t("输入技能名称…");
    const nameWrap = mkEl("div", "rs-skill-name-wrap");
    nameWrap.append(nameView, nameInput);
    const sourceBadge = mkEl("span", "rs-source-badge rs-skill-detail-badge");
    header.append(titleSpan, nameWrap, sourceBadge);
    // 「复制为自定义」放标题栏（仅预设/任务技能显示），在 ✕ 左侧
    const copyBtn = mkEl("button", "rs-btn rs-btn-local");
    copyBtn.type = "button";
    setIconLabel(copyBtn, "copy", t("复制为自定义"));
    copyBtn.title = t("把这个内置技能复制为可编辑的自定义技能");
    copyBtn.style.display = "none";
    // 带工作流的技能：正文只作帮助文档，标题栏 ? 徽标弹出文档浮窗（正文区整体搬进浮窗，编辑也在浮窗内）
    const docBtn = mkEl("button", "rs-btn rs-btn-local rs-skill-doc-btn");
    docBtn.type = "button";
    docBtn.textContent = "?";
    docBtn.title = t("查看技能说明（skill.md 正文）");
    docBtn.style.display = "none";
    const closeBtn = mkEl("button", "rs-skill-modal-close");
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close");
    header.append(docBtn, copyBtn, closeBtn);

    // 技能名称行内编辑（同导演编辑器配方名）：显示态点文字进入编辑，Enter / 失焦提交，Esc 还原为已保存名
    const renderName = () => {
        const v = nameInput.value.trim();
        nameView.textContent = v || t("未命名技能");
        nameView.classList.toggle("rs-skill-name-empty", !v);
        nameInput.title = v;
    };
    const stopNameEdit = () => {
        nameWrap.classList.remove("rs-skill-name-editing");
        renderName();
    };
    const startNameEdit = () => {
        if (nameInput.disabled) return;   // 只读技能（SYS / TASK）不可改名
        nameWrap.classList.add("rs-skill-name-editing");
        nameInput.focus();
        nameInput.select();
        nameInput.scrollLeft = 0;   // 全选后回到开头，长名称不至于只显示尾部
    };
    nameView.addEventListener("click", startNameEdit);
    nameInput.addEventListener("blur", stopNameEdit);
    nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); stopNameEdit(); }
        else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();   // 别让 Esc 顺带关掉整窗
            nameInput.value = contentBaseline ? contentBaseline.name : "";
            stopNameEdit();
        }
    });

    // ---- 内容：名称行 + 正文区（多文件下拉 + 预览/编辑切换）----
    const content = mkEl("div", "rs-skill-modal-content");

    // 不可用说明：依赖 VDN 加速节点的视频技能在插件未装时顶部提示（不影响查看/编辑）
    const unavailableBanner = mkEl("div", "rs-skill-unavailable-banner");
    unavailableBanner.textContent = t("⚠️ 该技能依赖 VDN 加速节点（ComfyUI-VDN-H3 插件），当前未注册，暂不能用于生成。可继续查看与编辑其设置。");
    unavailableBanner.style.display = "none";

    // multi_turn 勾选：每次生成仅推进一个阶段（节点底部会显示多轮提示）
    const multiTurnRow = mkEl("div", "rs-skill-multiturn-row");
    const multiTurnChk = document.createElement("input");
    multiTurnChk.type = "checkbox";
    multiTurnChk.className = "rs-skill-multiturn-chk";
    const multiTurnLabel = mkEl("label", "rs-skill-multiturn-label");
    multiTurnLabel.textContent = "Multi-turn (multi_turn)";
    multiTurnLabel.title = t("每次生成仅推进一个阶段，需补充返回的问询后再次点击 ✨ 继续");
    multiTurnRow.append(multiTurnChk, multiTurnLabel);

    const contentRow = mkEl("div", "rs-config-row");
    const contentHeader = mkEl("div", "rs-content-header");
    const contentLeft = mkEl("div", "rs-content-left");
    // 正文用途说明（tooltip）：无工作流时正文参与生成，带 workflow.json 的技能正文只作帮助文档
    const CONTENT_HINT = t("技能正文（skill.md）：无工作流时作为提示词增强的扩写指令或参考图模式的提示词模板；带 workflow.json 的技能正文只作帮助文档，不参与生成（点标题栏 ? 查看/编辑）。");
    const contentLabel = mkEl("label", "rs-form-label");
    contentLabel.textContent = t("系统提示词内容");
    contentLabel.title = CONTENT_HINT;
    contentLeft.appendChild(contentLabel);
    // Enhance Prompt 开关（仅生图技能显示）：LLM 提示词增强，指令即上方正文；放在标题右侧便于就近理解
    const enhancePromptWrap = mkEl("div", "rs-content-enhance");
    enhancePromptWrap.style.display = "none";
    const enhancePromptChk = document.createElement("input");
    enhancePromptChk.type = "checkbox";
    enhancePromptChk.className = "rs-gen-enhance-chk";
    const enhancePromptLabel = mkEl("label", "rs-form-label");
    enhancePromptLabel.textContent = t("提示词增强");
    enhancePromptLabel.title = t("使用 LLM 自动扩写生图提示词（指令即上方正文，需已配置 LLM）");
    enhancePromptWrap.append(enhancePromptChk, enhancePromptLabel);
    contentLeft.appendChild(enhancePromptWrap);
    // 多文件切换下拉（skill 含多个 .md 时显示）
    const fileSelect = document.createElement("select");
    fileSelect.className = "rs-file-select";
    fileSelect.style.display = "none";
    contentLeft.appendChild(fileSelect);
    // 附属 .md 的新增 / 删除（仅自定义 skill）
    const fileTools = mkEl("div", "rs-content-mode");
    const addFileBtn = mkEl("button", "rs-btn rs-btn-local rs-content-mode-btn");
    addFileBtn.type = "button";
    addFileBtn.textContent = t("+ 文件");
    addFileBtn.title = "Add a .md file to this skill";
    const delFileBtn = mkEl("button", "rs-btn rs-delete-cancel-btn rs-content-mode-btn");
    delFileBtn.type = "button";
    delFileBtn.append(icon("trash"));
    delFileBtn.title = "Delete the selected file";
    fileTools.append(addFileBtn, delFileBtn);
    contentLeft.appendChild(fileTools);
    const modeBtns = mkEl("div", "rs-content-mode");
    const previewBtn = mkEl("button", "rs-btn rs-btn-local rs-content-mode-btn");
    previewBtn.type = "button";
    previewBtn.textContent = t("👁 预览");
    const editBtn = mkEl("button", "rs-btn rs-btn-local rs-content-mode-btn");
    editBtn.type = "button";
    editBtn.textContent = t("✎ 编辑");
    modeBtns.append(previewBtn, editBtn);
    contentHeader.appendChild(contentLeft);
    contentHeader.appendChild(modeBtns);
    const contentTextarea = document.createElement("textarea");
    contentTextarea.className = "rs-form-input rs-tpl-content";
    contentTextarea.style.resize = "vertical";
    contentTextarea.placeholder = t("输入系统提示词内容…");
    const contentPreview = mkEl("div", "rs-md-preview");
    contentPreview.style.display = "none";
    contentRow.append(contentHeader, contentTextarea, contentPreview);

    // ---- 生图设置（仅 gen_image 技能显示）：复用全局生图设置的共享控件区，读写该技能的 config.json 覆盖 ----
    const genSettingsWrap = mkEl("div", "rs-gen-settings rs-skill-gen-settings");
    genSettingsWrap.style.display = "none";
    const genSettingsHeader = mkEl("div", "rs-config-row rs-gen-settings-header");
    const genSettingsTitle = mkEl("label", "rs-form-label");
    genSettingsTitle.textContent = t("🖼️ 生图设置");
    genSettingsTitle.title = t("仅对本技能生效，未填项回落全局生图设置");
    const genLocalHint = mkEl("span", "rs-gen-readonly-hint");
    genLocalHint.textContent = t("预设的设置改动保存为本地覆盖，不修改预设文件");
    genLocalHint.title = t("模型路径等本机差异存于 configs/skill_overrides/，可用「↺ 恢复默认」一键清除");
    genLocalHint.style.display = "none";
    const genSaveCfgBtn = mkEl("button", "rs-btn rs-btn-local");
    genSaveCfgBtn.type = "button";
    genSaveCfgBtn.textContent = t("💾 保存");
    genSaveCfgBtn.title = t("保存本技能生图设置（预设技能存为本地覆盖）");
    genSaveCfgBtn.style.display = "none";
    const genRestoreCfgBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
    genRestoreCfgBtn.type = "button";
    genRestoreCfgBtn.textContent = t("↺ 恢复默认");
    genRestoreCfgBtn.title = t("清除本技能本地覆盖设置，恢复预设默认值");
    genRestoreCfgBtn.style.display = "none";
    const genCfgBtns = mkEl("div", "rs-gen-cfg-btns");
    genCfgBtns.append(genSaveCfgBtn, genRestoreCfgBtn);
    genSettingsHeader.append(genSettingsTitle, genLocalHint, genCfgBtns);
    const genModelSection = createModelConfigSection();
    const genSizeSection = createGenSizeRows();
    // Text Encoder / VAE / 生图张数 / 输出前缀 很少改动：收进可折叠「高级选项」（默认收起），放到最底部
    // 可折叠「高级选项」组（默认收起）：勾选开头复选框展开、取消勾选收起；点标题其余部分不触发（防误点）。纯原生 checkbox + CSS :checked，无 JS 逻辑
    function makeAdvGroup(label) {
        const adv = mkEl("div", "rs-gen-advanced");
        const chk = mkEl("input", "rs-gen-adv-check");
        chk.type = "checkbox";
        chk.setAttribute("aria-label", label);
        const lbl = mkEl("span", "rs-gen-adv-label");
        lbl.textContent = label;
        const advContent = mkEl("div", "rs-gen-adv-content");
        adv.append(chk, lbl, advContent);
        return { adv, content: advContent };
    }
    let advEl = null;
    {
        const advRows = [
            ...genModelSection.el.querySelectorAll(".rs-gen-adv-row"),
            ...genSizeSection.el.querySelectorAll(".rs-gen-adv-row"),
        ];
        if (advRows.length) {
            const g = makeAdvGroup(t("Text Encoder / VAE / 生图张数 / 输出前缀（高级）"));
            for (const r of advRows) g.content.appendChild(r);
            advEl = g.adv;
        }
    }
    genSettingsWrap.append(genSettingsHeader, genModelSection.el, genSizeSection.el);
    if (advEl) genSettingsWrap.appendChild(advEl);

    // ---- 生视频设置（仅 gen_video 技能显示）：读写该技能 config.json 覆盖（model/text_encoder/vae/audio_vae），未填项回落全局「生视频模型」----
    const videoGenSettingsWrap = mkEl("div", "rs-gen-settings rs-skill-video-gen-settings");
    videoGenSettingsWrap.style.display = "none";
    const videoGenSettingsHeader = mkEl("div", "rs-config-row rs-gen-settings-header");
    const videoGenSettingsTitle = mkEl("label", "rs-form-label");
    videoGenSettingsTitle.textContent = t("🎬 生视频设置");
    videoGenSettingsTitle.title = t("仅对本技能生效，未填项回落全局「生视频模型」设置");
    const videoLocalHint = mkEl("span", "rs-gen-readonly-hint");
    videoLocalHint.textContent = t("预设的设置改动保存为本地覆盖，不修改预设文件");
    videoLocalHint.title = t("模型路径等本机差异存于 configs/skill_overrides/，可用「↺ 恢复默认」一键清除");
    videoLocalHint.style.display = "none";
    const videoSaveCfgBtn = mkEl("button", "rs-btn rs-btn-local");
    videoSaveCfgBtn.type = "button";
    videoSaveCfgBtn.textContent = t("💾 保存");
    videoSaveCfgBtn.title = t("保存本技能生视频设置（预设技能存为本地覆盖）");
    videoSaveCfgBtn.style.display = "none";
    const videoRestoreCfgBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
    videoRestoreCfgBtn.type = "button";
    videoRestoreCfgBtn.textContent = t("↺ 恢复默认");
    videoRestoreCfgBtn.title = t("清除本技能本地覆盖设置，恢复预设默认值");
    videoRestoreCfgBtn.style.display = "none";
    const videoCfgBtns = mkEl("div", "rs-gen-cfg-btns");
    videoCfgBtns.append(videoSaveCfgBtn, videoRestoreCfgBtn);
    videoGenSettingsHeader.append(videoGenSettingsTitle, videoLocalHint, videoCfgBtns);
    const videoModelSection = createVideoModelConfigSection();
    // Text Encoder / VAE（视频）/ VAE（音频）很少改动：收进可折叠「高级选项」（默认收起），放到最底部
    let videoAdvEl = null;
    {
        const advRows = [...videoModelSection.el.querySelectorAll(".rs-gen-adv-row")];
        if (advRows.length) {
            const g = makeAdvGroup(t("Text Encoder / VAE（视频）/ VAE（音频）（高级）"));
            for (const r of advRows) g.content.appendChild(r);
            videoAdvEl = g.adv;
        }
    }
    videoGenSettingsWrap.append(videoGenSettingsHeader, videoModelSection.el);
    if (videoAdvEl) videoGenSettingsWrap.appendChild(videoAdvEl);

    // ---- 工作流流程图（仅 gen_image/gen_video 技能显示）：workflow.json 模板自动布局为只读 SVG，
    //      红框 = 节点未安装/模型缺失，蓝框 = 含 {{模板变量}}；无 workflow.json 时隐藏
    const workflowWrap = mkEl("div", "rs-skill-workflow");
    workflowWrap.style.display = "none";
    const workflowHeader = mkEl("div", "rs-config-row rs-gen-settings-header rs-skill-workflow-head");
    const workflowCaret = mkEl("span", "rs-wf-caret");
    workflowCaret.textContent = "▾";
    const workflowTitle = mkEl("label", "rs-form-label");
    workflowTitle.textContent = t("🔀 工作流（内嵌编辑）");
    workflowTitle.title = t("技能 workflow.json 模板按本技能 config 初始化后直接内嵌编辑；无 LiteGraph 的视图回落只读流程图");
    const workflowBody = mkEl("div", "rs-wf-body");
    const workflowSummary = mkEl("div", "rs-wf-summary");
    workflowHeader.append(workflowCaret, workflowTitle);
    workflowHeader.title = t("点击折叠 / 展开工作流图");
    // 折叠时画布已卸载；展开重挂内嵌编辑画布，挂不上（无 LiteGraph 的视图 / 含未注册节点）回落只读流程图
    workflowHeader.addEventListener("click", () => {
        const collapse = !workflowWrap.classList.contains("rs-wf-collapsed");
        setWorkflowCollapsed(collapse);
        if (collapse || !workflowShown) return;
        workflowBody.style.display = "";
        workflowSummary.style.display = "";
        if (wfCanvas) return;
        mountWorkflowEditor().then((ok) => {
            if (!ok && workflowShown) renderWorkflowPreview(skillWorkflowRaw, loadedGenInfo, currentIsVideo, currentSkillId);
        });
    });
    // 画布 ⇄ 技能：导入把模板按当前设置预渲染、运行时占串归 concrete values 后 loadApiJson 载入画布；
    //      回写把整画布 API prompt 落盘该技能 workflow.json（skill.md 保留；预设只写模型值到本地覆盖，结构变更自动复制为自定义技能）。
    //      Studio 内嵌无画布（canvasBtns=false）→ 只挂「⤒ 主画布编辑」，开主界面 ?neo_wf_edit=<id> 交接编辑。
    const wfCanvasBtns = mkEl("div", "rs-wf-canvas-btns");
    if (canvasBtns) {
        const wfImportBtn = mkEl("button", "rs-btn rs-wf-canvas-import-btn");
        wfImportBtn.type = "button";
        wfImportBtn.textContent = t("⤒ 导入到画布");
        wfImportBtn.title = t("把本技能 workflow.json 载入画布（模板变量按当前设置预渲染，参考图槽位留占串），画里后点「💾 回写入技能」落盘");
        wfImportBtn.addEventListener("click", (e) => { e.stopPropagation(); importWorkflowToCanvas(); });
        const wfWriteBtn = mkEl("button", "rs-btn rs-wf-canvas-write-btn");
        wfWriteBtn.type = "button";
        wfWriteBtn.textContent = t("💾 回写入技能");
        wfWriteBtn.title = t("把整画布工作流落盘本技能 workflow.json（先列出变更、确认后写入；仅 API 工作流，画布节点位置等界面布局不写入；预设技能只写模型值到本地覆盖，结构变更自动复制为自定义技能）");
        wfWriteBtn.addEventListener("click", (e) => { e.stopPropagation(); writeWorkflowBackToSkill(); });
        wfCanvasBtns.append(wfImportBtn, wfWriteBtn);
    } else {
        const wfOpenBtn = mkEl("button", "rs-btn rs-wf-canvas-import-btn");
        wfOpenBtn.type = "button";
        wfOpenBtn.textContent = t("⤒ 主画布编辑");
        wfOpenBtn.title = t("在主 ComfyUI 界面打开本技能 workflow.json 编辑（按技能设置预渲染），改完点「💾 回写入技能」落盘本技能");
        wfOpenBtn.addEventListener("click", (e) => { e.stopPropagation(); openSkillWorkflowInMainUi(currentSkillId); });
        wfCanvasBtns.append(wfOpenBtn);
    }
    const wfLogBtn = mkEl("button", "rs-btn rs-wf-write-log-btn");
    wfLogBtn.type = "button";
    wfLogBtn.textContent = t("🕘 变更记录");
    wfLogBtn.title = t("查看本技能的回写历史（每次确认保存的变更清单，本机本地记录）");
    wfLogBtn.addEventListener("click", (e) => { e.stopPropagation(); showSkillWriteLogDialog(currentSkillId); });
    wfCanvasBtns.appendChild(wfLogBtn);
    workflowHeader.append(wfCanvasBtns);
    // 工作流区直接内嵌 litegraph 编辑（前端未暴露 LiteGraph 的视图回落只读流程图预览）
    const wfEditorSupported = !!window.LGraph && !!window.LGraphCanvas && !!window.LiteGraph;

    const wfEditWrap = mkEl("div", "rs-wf-editor");
    wfEditWrap.style.display = "none";
    const wfEditBar = mkEl("div", "rs-wf-editor-bar");
    const wfSaveBtn = mkEl("button", "rs-btn rs-btn-local");
    wfSaveBtn.type = "button";
    wfSaveBtn.textContent = t("💾 保存工作流");
    const wfReloadBtn = mkEl("button", "rs-btn rs-btn-local");
    wfReloadBtn.type = "button";
    wfReloadBtn.textContent = t("↺ 重新载入");
    wfReloadBtn.title = t("丢弃画布上的改动，按技能当前 workflow.json 与 config 重载");
    const wfFitBtn = mkEl("button", "rs-btn rs-btn-local");
    wfFitBtn.type = "button";
    wfFitBtn.textContent = t("🧭 适配视图");
    wfEditBar.append(wfSaveBtn, wfReloadBtn, wfFitBtn);
    const wfCanvasBox = mkEl("div", "rs-wf-editor-canvas-box");
    wfEditWrap.append(wfEditBar, wfCanvasBox);
    workflowWrap.append(workflowHeader, workflowBody, workflowSummary, wfEditWrap);

    // 失效模型路径修复：复用后端 /neo_nodes/skill_model_suggest（与工作流修复同款 match_model_file），
    // 弹窗列出 config 里所有失效字段与候选/置信度，批量套用后回填对应设置区，用户再点 Save 写入 config.json。
    // 「🔧 修复失效路径」+「📋 修复记录」并排放在各设置区头部（随 gen/video 设置区显隐）。config.json 恒可编辑（模型路径因机器而异、无统一预设），设置区无只读态。
    let genRepairBtn = null, videoRepairBtn = null;   // 各设置区「修复」按钮引用：检测/应用后切换红框+右上角红点告警态
    const makeSectionRepairBtns = () => {
        const group = mkEl("div", "rs-model-repair-group");
        const repairBtn = mkEl("button", "rs-btn rs-model-repair-btn");
        repairBtn.type = "button";
        repairBtn.textContent = t("🔧 修复失效路径");
        repairBtn.title = t("检测本技能 config 里失效的模型路径，给出候选并批量套用（复用工作流修复匹配）");
        repairBtn.addEventListener("click", (e) => { e.stopPropagation(); openModelRepairDialog(); });
        const logBtn = mkEl("button", "rs-btn rs-model-repair-log-btn");
        logBtn.type = "button";
        logBtn.textContent = t("📋 修复记录");
        logBtn.title = t("查看本技能的模型路径修复历史（本机本地记录）");
        logBtn.addEventListener("click", (e) => { e.stopPropagation(); openSkillRepairLogDialog(); });
        group.append(repairBtn, logBtn);
        return { group, repairBtn };
    };
    const genRepairGroup = makeSectionRepairBtns();
    genSettingsHeader.appendChild(genRepairGroup.group);
    const videoRepairGroup = makeSectionRepairBtns();
    videoGenSettingsHeader.appendChild(videoRepairGroup.group);
    genRepairBtn = genRepairGroup.repairBtn;
    videoRepairBtn = videoRepairGroup.repairBtn;

    // 当前活动设置区（生图/生视频互斥）的上下文：section、对应「修复」按钮、collect() 出的 config。
    // 「修复失效路径」弹窗与告警检测都基于它，保证用的是当前显示区的最新值而非最近 load 的快照。
    const activeIsVideo = () => videoGenSettingsWrap.style.display !== "none";
    const activeConfig = () => activeIsVideo()
        ? videoModelSection.collect()
        : { ...genModelSection.collect(), ...genSizeSection.collect() };

    const activeRepairContext = () => {
        const isVideo = activeIsVideo();
        return {
            section: isVideo ? videoModelSection : genModelSection,
            btn: isVideo ? videoRepairBtn : genRepairBtn,
            config: activeConfig(),
        };
    };
    const setRepairAlert = (btn, on) => { if (btn) btn.classList.toggle("rs-alert", !!on); };
    function countMissingFields(fields) {
        if (!fields || typeof fields !== "object") return 0;
        let n = 0;
        for (const k of ["model", "text_encoder", "vae", "audio_vae"]) if (fields[k] && fields[k].status === "missing") n++;
        for (const l of fields.loras || []) if (l.status === "missing") n++;
        return n;
    }

    // 设置区头部「💾 Save / ↺ 恢复默认」与本地覆盖提示的显隐（仅预设；恢复仅在存在覆盖时显示）
    // 检测当前活动设置区是否有失效模型路径 → 「修复」按钮红框+右上角红点；无缺失则清除。
    // 打开/重载技能、应用修复后调用；异步结果按「技能未切换且该区仍显示」校验，避免过期覆盖。
    async function checkRepairStatus() {
        const ctx = activeRepairContext();
        if (!ctx.btn) return;
        const idAtStart = currentSkillId;
        if (!idAtStart) { setRepairAlert(ctx.btn, false); return; }
        let missing = 0;
        try {
            const data = await fetchModelSuggest(ctx.config);
            if (data && data.success) missing = countMissingFields(data.fields);
        } catch (e) { /* 检测失败不告警，保持现状 */ }
        if (currentSkillId === idAtStart && ctx.btn === activeRepairContext().btn) setRepairAlert(ctx.btn, missing > 0);
    }

    // 失效模型路径修复：复用后端 /neo_nodes/skill_model_suggest（与工作流修复同款 match_model_file）
    async function fetchModelSuggest(config) {
        const resp = await fetch("/neo_nodes/skill_model_suggest", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config }),
        });
        return await resp.json();
    }

    // ---- 修复记录（每技能上限 50 条）----
    const repairLog = makeSkillLog("neo.skillRepairLog", 50, t("修复记录"));

    // 修复记录弹窗：列出本技能历史修复（时间·类型 + 每处 from→to），可清空；纯本地，不影响 config.json
    function openSkillRepairLogDialog() {
        if (!currentSkillId) return;
        const log = repairLog.get(currentSkillId);
        const { body, foot, close } = makeRepairDialog(tf("修复记录（{n}）", { n: log.length }), "rs-skill-repair-log-overlay");
        if (!log.length) {
            const empty = mkEl("div", "rs-repair-log-empty");
            empty.textContent = t("本技能暂无修复记录 — 点「🔧 修复失效路径」套用后，修改会记录在这里。");
            body.appendChild(empty);
        } else {
            for (const entry of log) {
                const group = mkEl("div", "rs-repair-log-group");
                const timeEl = mkEl("div", "rs-repair-log-time");
                timeEl.textContent = `${new Date(entry.time).toLocaleString("zh-CN", { hour12: false })} · ${entry.kind === "gen_video" ? t("生视频") : t("生图")}`;
                group.appendChild(timeEl);
                for (const c of entry.changes || []) {
                    const row = mkEl("div", "rs-repair-row");
                    const label = mkEl("span", "rs-repair-label");
                    label.textContent = REPAIR_FIELD_LABELS[c.field] || c.field;
                    const from = mkEl("span", "rs-repair-cur");
                    from.textContent = shortModelName(c.from);
                    from.title = c.from;
                    const arrow = mkEl("span", "rs-repair-arrow");
                    arrow.textContent = "→";
                    const to = mkEl("span", "rs-repair-new");
                    to.textContent = shortModelName(c.to);
                    to.title = c.to;
                    row.append(label, from, arrow, to);
                    group.appendChild(row);
                }
                body.appendChild(group);
            }
        }
        const hint = mkEl("span", "rs-repair-hint");
        hint.textContent = t("仅本机本地记录，不影响 config.json");
        const clearBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
        clearBtn.type = "button";
        clearBtn.textContent = t("清空记录");
        foot.append(hint, clearBtn);
        clearBtn.addEventListener("click", () => { repairLog.clear(currentSkillId); close(); showToast(app, "info", t("本技能修复记录已清空")); });
    }

    function updateCfgButtons(btns, saveBtn, restoreBtn, localHint) {
        const preset = currentSource === "presets";
        btns.style.display = preset ? "flex" : "none";
        saveBtn.style.display = preset ? "inline-block" : "none";
        restoreBtn.style.display = preset && configOverridden ? "inline-block" : "none";
        localHint.style.display = preset ? "inline" : "none";
    }

    async function loadVideoGenSettings() {
        if (!currentSkillId) return null;
        const [config, videoModels] = await Promise.all([
            getSkillGenConfig(currentSkillId),
            listVideoGenModels().catch(() => ({})),
        ]);
        videoModelSection.load(config || {}, videoModels);
        updateCfgButtons(videoCfgBtns, videoSaveCfgBtn, videoRestoreCfgBtn, videoLocalHint);
        checkRepairStatus();   // 打开/重载后检测失效路径 → 「修复」按钮告警态
        return { config: config || {}, models: videoModels };
    }

    // config.json 恒可编辑（模型路径因机器而异、无统一预设）→ 设置区不置灰；config 缺失按空对象回落默认。
    async function loadGenSettings() {
        if (!currentSkillId) return null;
        const config = await getSkillGenConfig(currentSkillId);
        let models = {};
        try { models = await listGenModels(); } catch (e) { console.warn("Failed to load gen models:", e); }
        genModelSection.load(config || {}, models);
        genSizeSection.load(config || {});
        enhancePromptChk.checked = !!(config && config.enhance_prompt);
        updateCfgButtons(genCfgBtns, genSaveCfgBtn, genRestoreCfgBtn, genLocalHint);
        checkRepairStatus();   // 打开/重载后检测失效路径 → 「修复」按钮告警态
        return { config: config || {}, models };
    }

    // ---- 失效模型路径修复：检测 config 里失效字段，弹窗批量套用候选后回填设置区 ----
    const REPAIR_FIELD_LABELS = { model: t("主模型"), text_encoder: "Text Encoder", vae: "VAE", audio_vae: t("音频 VAE") };
    // 修复项 → 模型库落盘类别；失效文件名去目录与扩展名后作为模型库搜索词
    const REPAIR_FIELD_CATEGORY = { model: "diffusion_models", text_encoder: "text_encoders", vae: "vae", audio_vae: "audio_vae", lora: "loras" };
    const repairHubQuery = (value) => String(value || "").split(/[\\/]/).pop().replace(/\.(safetensors|bin|pth|pt|ckpt|gguf|onnx|npz)$/i, "");

    // 「修复失效路径」应用后刷新工作流图：内嵌编辑按修复后的 config 重挂画布；只读预览则用当前设置区值
    // 重新预渲染模板并重新校验，清掉已修好的红框（复用已加载的原始模板，不重新拉 workflow.json）
    async function refreshWorkflowGraph() {
        if (!workflowShown || !currentSkillId || !skillWorkflowRaw) return;
        const isVideo = videoGenSettingsWrap.style.display !== "none";
        const cfg = isVideo ? videoModelSection.collect() : { ...genModelSection.collect(), ...genSizeSection.collect() };
        if (wfCanvas) { await mountWorkflowEditor(); return; }
        await renderWorkflowPreview(skillWorkflowRaw, { config: cfg, models: (loadedGenInfo && loadedGenInfo.models) || {} }, isVideo, currentSkillId);
    }

    // ---- 画布 ⇄ 技能：把技能模板归画布可 load 的 API prompt（已知参数按设置预渲染、运行时占串归 concrete values
    //      与后端 render_template 的 typed values 一致：number widget 的纯数字串归 number；参考图槽位留 {{REF_IMAGE}} 占串）
    // 控制图槽位（config.json 的 control_ref）：画布导入时 {{CONTROL_IMAGE}} 取第几张参考图
    const controlRefOf = () => Number(((loadedGenInfo || {}).config || {}).control_ref) || 0;

    async function canvasWorkflow() {
        if (!skillWorkflowRaw) return null;
        return await buildCanvasWorkflow(skillWorkflowRaw, activeConfig(), (loadedGenInfo || {}).models || {}, activeIsVideo(), { controlRef: controlRefOf() });
    }

    // 内嵌编辑的初始图：模板按技能已保存 config 灌 widget（模型 / 尺寸 / 张数 / 前缀 / 步数 / 视频宽高时长
    // 与 LoRA 槽位），超出模板槽位的 LoRA 同运行时一样动态注入；提示词 / 种子 / 参考图等运行时 {{变量}}
    // 原样保留 → 保存时后端按同一套键位重新占位符化并回写 config。
    async function editorTemplateWorkflow() {
        const wf = JSON.parse(JSON.stringify(skillWorkflowRaw));
        return await buildCanvasWorkflow(wf, activeConfig(), (loadedGenInfo || {}).models || {}, activeIsVideo(), { runtime: false, controlRef: controlRefOf() });
    }

    async function importWorkflowToCanvas() {
        if (!skillWorkflowRaw) { showToast(app, "warning", t("无工作流"), t("本技能没有 workflow.json")); return; }
        if (typeof app.loadApiJson !== "function") { showToast(app, "warning", t("无画布"), t("当前视图没有画布，导入不可用")); return; }
        const wf = await canvasWorkflow();
        if (!wf) return;
        try {
            await app.loadApiJson(wf, currentSkillId);
            arrangeCanvasNodes(wf);
        } catch (e) {
            showToast(app, "error", t("导入失败"), String(e.message || e));
            return;
        }
        // 导入成功的说明：画布上没有 {{变量}}，模板变量已按「长边尺寸 × 默认比例」等设置灌成数值
        armCanvasWriteback(currentSkillId, currentSource, currentDisplayName,
            filledTokenNotes(wf, workflowParamValues(activeIsVideo(), { config: activeConfig(), models: (loadedGenInfo || {}).models || {} })));
        // 导入成功即收起技能窗口：内嵌宿主（技能管理整窗）走 onCloseWindow 关整窗，独立详情弹窗走 requestClose
        if (onCloseWindow) onCloseWindow(); else requestClose();
    }

    async function writeWorkflowBackToSkill() {
        await writeWorkflowToSkill(currentSkillId, "editor", currentDisplayName);
    }

    // 把接受的修复项回填到当前活动的设置区（生图/生视频）：合并进 collect() 后重新 load，
    // LoRA 按原失效名匹配替换（不依赖下标，避免用户增删行后错位）。回填不自动保存。
    function applyModelFixes(fixes) {
        const isGen = genSettingsWrap.style.display !== "none";
        const section = isGen ? genModelSection : videoModelSection;
        const models = (loadedGenInfo && loadedGenInfo.models) || {};
        const merged = { ...section.collect() };
        for (const k of ["model", "text_encoder", "vae", "audio_vae"]) if (k in fixes) merged[k] = fixes[k];
        if (fixes.loras && fixes.loras.length) {
            merged.loras = (merged.loras || []).map((e) => {
                const fix = fixes.loras.find((f) => f.from === e.name);
                return fix ? Object.assign({}, e, { name: fix.to }) : e;
            });
        }
        section.load(merged, models);
        refreshWorkflowGraph();   // 设置区已回填 → 重渲染工作流图并重新校验，清掉已修好的红框
    }

    async function openModelRepairDialog() {
        if (!currentSkillId) return;
        const config = activeRepairContext().config;   // 用当前活动设置区最新值（而非最近 load 的快照）
        let data;
        try {
            data = await fetchModelSuggest(config);
        } catch (e) {
            showToast(app, "error", t("修复检查失败"), String(e.message || e));
            return;
        }
        if (!data || !data.success) { showToast(app, "error", t("修复检查失败"), (data && data.error) || ""); return; }
        const fields = data.fields || {};
        // 收集失效项（标量字段 + LoRA），保留后端返回顺序
        const rows = [];
        for (const key of ["model", "text_encoder", "vae", "audio_vae"]) {
            const f = fields[key];
            if (f && f.status === "missing")
                rows.push({ kind: "field", key, value: f.value, suggestion: f.suggestion, score: f.score, candidates: f.candidates || [] });
        }
        for (const l of fields.loras || []) {
            if (l.status === "missing")
                rows.push({ kind: "lora", index: l.index, value: l.value, suggestion: l.suggestion, score: l.score, candidates: l.candidates || [] });
        }
        if (!rows.length) { showToast(app, "info", t("没有失效的模型路径")); return; }

        const { body, foot, close } = makeRepairDialog(tf("修复失效模型路径（{n}）", { n: rows.length }));
        const selects = [];   // 与 rows 对齐：每项一个 <select>，value="" 表示跳过
        for (const r of rows) {
            const row = mkEl("div", "rs-repair-row");
            const label = mkEl("span", "rs-repair-label");
            label.textContent = r.kind === "lora" ? `LoRA #${(r.index ?? 0) + 1}` : (REPAIR_FIELD_LABELS[r.key] || r.key);
            const cur = mkEl("span", "rs-repair-cur");
            cur.textContent = shortModelName(r.value);
            cur.title = r.value;
            const sel = document.createElement("select");
            sel.className = "rs-repair-sel rs-form-input";
            const ph = document.createElement("option");
            ph.value = "";
            ph.textContent = t("（跳过）");
            sel.appendChild(ph);
            const addOpt = (val, text) => {
                const o = document.createElement("option");
                o.value = val;
                o.textContent = text;
                sel.appendChild(o);
            };
            if (r.suggestion) addOpt(r.suggestion, tf("{m}（推荐 {pct}%）", { m: shortModelName(r.suggestion), pct: Math.round((r.score || 0) * 100) }));
            for (const c of r.candidates) {
                if (c === r.suggestion) continue;
                addOpt(c, shortModelName(c));
            }
            if (r.suggestion) sel.value = r.suggestion;   // 高置信默认选中推荐项
            row.append(label, cur, sel);

            // 本地缺这个模型 → 直接进模型库搜索下载（预填失效文件名 + 对应落盘类别）
            const hubBtn = mkEl("button", "rs-repair-hub-btn");
            hubBtn.type = "button";
            hubBtn.textContent = t("📥 模型库");
            hubBtn.title = t("在模型库（Comfy-Org · Hugging Face / ModelScope）搜索并下载此模型");
            hubBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                openModelHub({
                    query: repairHubQuery(r.value),
                    category: REPAIR_FIELD_CATEGORY[r.kind === "lora" ? "lora" : r.key] || "",
                });
            });
            row.appendChild(hubBtn);

            // LoRA 无本地候选时，提供 C站搜索下载按钮
            if (r.kind === "lora" && !r.suggestion && !(r.candidates && r.candidates.length)) {
                const civBtn = mkEl("button", "rs-repair-civitai-btn");
                civBtn.type = "button";
                civBtn.textContent = t("🔍 C站");
                civBtn.title = t("从 Civitai 搜索并下载此 LoRA");
                const subPanel = mkEl("div", "rs-repair-civitai-panel");
                subPanel.style.display = "none";
                civBtn.addEventListener("click", async () => {
                    if (subPanel.style.display !== "none") { subPanel.style.display = "none"; return; }
                    subPanel.innerHTML = `<span class="rs-civ-loading">${t("搜索中…")}</span>`;
                    subPanel.style.display = "block";
                    try {
                        const resp = await fetch("/neo_nodes/civitai_search_lora", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ query: r.value }),
                        });
                        const data = await resp.json();
                        if (!data.success) throw new Error(data.error || t("搜索失败"));
                        subPanel.innerHTML = "";
                        const items = data.items || [];
                        if (!items.length) {
                            subPanel.innerHTML = `<span class="rs-civ-empty">${t("未找到匹配的 LoRA")}</span>`;
                            return;
                        }
                        for (const it of items.slice(0, 6)) {
                            const itemRow = mkEl("div", "rs-civ-item");
                            const info = mkEl("span", "rs-civ-info");
                            const sizeStr = it.file_size ? ` (${(it.file_size / 1024 / 1024).toFixed(1)} MB)` : "";
                            info.textContent = `${it.name} — ${it.author || "?"}${sizeStr}`;
                            info.title = it.file_name || "";
                            const dlBtn = mkEl("button", "rs-civ-dl-btn");
                            dlBtn.type = "button";
                            dlBtn.textContent = t("下载");
                            dlBtn.addEventListener("click", async () => {
                                dlBtn.disabled = true;
                                dlBtn.textContent = t("下载中…");
                                try {
                                    const dResp = await fetch("/neo_nodes/civitai_download_lora", {
                                        method: "POST", headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ url: it.download_url, filename: it.file_name }),
                                    });
                                    const dData = await dResp.json();
                                    if (!dData.success) throw new Error(dData.error || t("下载失败"));
                                    // 下载成功：把文件名加入 select 并选中
                                    const fname = dData.filename;
                                    addOpt(fname, tf("{m}（已下载）", { m: shortModelName(fname) }));
                                    sel.value = fname;
                                    subPanel.style.display = "none";
                                    showToast(app, "success", tf("LoRA 已下载: {name}", { name: fname }));
                                } catch (e) {
                                    dlBtn.disabled = false;
                                    dlBtn.textContent = t("重试");
                                    showToast(app, "error", t("下载失败"), String(e.message || e));
                                }
                            });
                            itemRow.append(info, dlBtn);
                            subPanel.appendChild(itemRow);
                        }
                    } catch (e) {
                        subPanel.innerHTML = `<span class="rs-civ-err">${e.message || t("搜索出错")}</span>`;
                    }
                });
                row.appendChild(civBtn);
                body.appendChild(row);
                body.appendChild(subPanel);
            } else {
                body.appendChild(row);
            }
            selects.push(sel);
        }

        const hint = mkEl("span", "rs-repair-hint");
        hint.textContent = t("套用后自动保存到 config.json");
        const cancelBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
        cancelBtn.type = "button";
        cancelBtn.textContent = t("取消");
        const applyBtn = mkEl("button", "rs-btn");
        applyBtn.type = "button";
        applyBtn.textContent = t("应用选中项");
        foot.append(hint, cancelBtn, applyBtn);
        cancelBtn.addEventListener("click", close);

        applyBtn.addEventListener("click", async () => {
            const fixes = {};
            const changes = [];   // 写入本技能修复记录：{ field, from, to }
            let n = 0;
            rows.forEach((r, i) => {
                const val = selects[i].value;
                if (!val) return;
                if (r.kind === "field") { fixes[r.key] = val; n++; changes.push({ field: r.key, from: r.value, to: val }); }
                else { (fixes.loras = fixes.loras || []).push({ from: r.value, to: val }); n++; changes.push({ field: `LoRA #${(r.index ?? 0) + 1}`, from: r.value, to: val }); }
            });
            if (!n) { close(); return; }
            const kind = videoGenSettingsWrap.style.display !== "none" ? "gen_video" : "gen_image";
            applyModelFixes(fixes);
            repairLog.record(currentSkillId, { kind: kind || "gen_image", changes });   // 记录到本技能修复历史（localStorage）
            checkRepairStatus();                                 // 重新检测：无缺失则清除红框/红点
            close();
            // 直接保存设置区到 config.json
            try {
                if (isCustom()) {
                    await persistGenSettings();
                } else {
                    await savePresetGenSettings();
                }
                showToast(app, "success", tf("已修复 {n} 项并保存", { n }));
            } catch (err) {
                showToast(app, "error", t("保存失败"), String(err.message || err));
            }
        });
    }

    // ---- 预设技能设置区：独立保存（主 Save 对预设隐藏）+ 一键恢复默认 ----
    async function savePresetGenSettings() {
        if (!currentSkillId || currentSource !== "presets") return;
        try {
            if (genSettingsWrap.style.display !== "none") {
                await saveSkillGenConfig(currentSkillId, { ...genModelSection.collect(), ...genSizeSection.collect(), enhance_prompt: enhancePromptChk.checked });
            } else if (videoGenSettingsWrap.style.display !== "none") {
                await saveSkillGenConfig(currentSkillId, videoModelSection.collect());
            }
            configOverridden = true;
            genSettingsBaseline = collectGenSettingsJson();
            updateCfgButtons(genCfgBtns, genSaveCfgBtn, genRestoreCfgBtn, genLocalHint);
            updateCfgButtons(videoCfgBtns, videoSaveCfgBtn, videoRestoreCfgBtn, videoLocalHint);
            dispatchSkillChanged(currentSkillId); // 预设设置落盘（本地覆盖）→ 通知节点状态条即时重检
        } catch (err) {
            alert("Save gen settings failed: " + err.message);
        }
    }

    async function restorePresetGenSettings() {
        if (!currentSkillId || currentSource !== "presets") return;
        if (!confirm(t("恢复本技能设置为预设默认？（将清除本地覆盖设置）"))) return;
        const r = await resetSkillGenConfig(currentSkillId);
        if (!r.success) { alert("Restore failed: " + (r.error || "")); return; }
        configOverridden = false;
        try {
            if (genSettingsWrap.style.display !== "none") await loadGenSettings();
            else if (videoGenSettingsWrap.style.display !== "none") await loadVideoGenSettings();
        } catch (err) {
            alert("Reload settings failed: " + err.message);
        }
    }
    genSaveCfgBtn.addEventListener("click", (e) => { e.stopPropagation(); savePresetGenSettings(); });
    videoSaveCfgBtn.addEventListener("click", (e) => { e.stopPropagation(); savePresetGenSettings(); });
    genRestoreCfgBtn.addEventListener("click", (e) => { e.stopPropagation(); restorePresetGenSettings(); });
    videoRestoreCfgBtn.addEventListener("click", (e) => { e.stopPropagation(); restorePresetGenSettings(); });

    // ---- 底部按钮：随状态显隐（保存 / 删除）；关闭走标题栏 ✕，复制走标题栏「复制为自定义」----
    const footerBtns = mkEl("div", "rs-modal-btns rs-skill-detail-actions");
    const saveBtn = mkEl("button", "rs-btn rs-btn-local rs-tpl-save-btn");
    saveBtn.textContent = t("💾 保存");
    const deleteBtn = mkEl("button", "rs-btn rs-delete-cancel-btn");
    setIconLabel(deleteBtn, "trash", t("删除"));
    footerBtns.append(saveBtn, deleteBtn);

    // 主区两栏：左 = 生图/生视频设置，右 = 系统提示词内容（面板够宽时并排；窄面板堆叠且系统提示词在上，顺序由 CSS 控制）
    const mainRow = mkEl("div", "rs-skill-detail-main");
    const settingsCol = mkEl("div", "rs-skill-detail-settings");
    settingsCol.append(genSettingsWrap, videoGenSettingsWrap);
    mainRow.append(contentRow, settingsCol);
    // 普通技能（无生图/生视频设置区）隐藏左栏，正文占满整行
    const syncSettingsColumn = () => {
        const on = genSettingsWrap.style.display !== "none" || videoGenSettingsWrap.style.display !== "none";
        settingsCol.style.display = on ? "" : "none";
    };

    content.append(unavailableBanner, multiTurnRow, mainRow, workflowWrap, footerBtns);
    modal.append(header, content);
    if (embedded) { modal.style.display = "none"; host.appendChild(modal); }
    else { overlay.appendChild(modal); document.body.appendChild(overlay); }

    // 带工作流的技能：正文区整体搬进这个文档浮窗（只读技能只能看，自定义技能在浮窗里编辑）
    const docOverlay = mkEl("div", "rs-skill-doc-overlay");
    const docModal = mkEl("div", "rs-skill-modal rs-skill-doc-modal");
    const docHeader = mkEl("div", "rs-skill-modal-header");
    const docTitle = mkEl("span", "rs-skill-modal-title");
    docTitle.textContent = t("📖 技能说明（skill.md）");
    const docClose = mkEl("button", "rs-skill-modal-close");
    docClose.textContent = "✕";
    docClose.setAttribute("aria-label", "Close");
    docHeader.append(docTitle, docClose);
    const docBody = mkEl("div", "rs-skill-doc-body");
    docModal.append(docHeader, docBody);
    docOverlay.appendChild(docModal);
    document.body.appendChild(docOverlay);
    const closeDoc = () => { docOverlay.style.display = "none"; };
    docClose.addEventListener("click", closeDoc);
    docOverlay.addEventListener("click", (e) => { if (e.target === docOverlay) closeDoc(); });
    docBtn.addEventListener("click", () => {
        docBody.appendChild(contentRow);   // 正文区（多文件下拉 + 预览/编辑 + 增删文件）整体搬进浮窗
        setEditorMode("preview");
        docOverlay.style.display = "flex";
    });

    // ---- 状态 ----
    let currentSkillId = null;
    let currentSource = "custom";
    let currentDisplayName = null;   // 技能显示名（英文界面用 name），用于用户提示
    let configOverridden = false;   // 预设技能是否存在本地配置覆盖（load_skill 返回）
    let currentFiles = [];   // [{ name, size }]（递归 .md/.txt 相对路径，含主文件 skill.md）
    let selectedFile = null;
    let editorMode = "preview";
    const isCustom = () => currentSource === "custom";
    const isMainFile = (name) => String(name || "").toLowerCase() === "skill.md";
    let workflowShown = false;   // 是否渲染了工作流流程图（正文区随之搬进 ? 文档浮窗）
    let contentBaseline = null;   // { name, content, multiTurn } 加载/新建后的快照，关闭时判断正文有无未保存修改
    let genSettingsBaseline = null;   // 生图/生视频设置区 collect() 的 JSON 快照（load/save 后刷新）；null = 无设置区
    let loadedGenInfo = null;         // 最近一次 loadGenSettings/loadVideoGenSettings 返回的 { config, models }，供「修复失效路径」回填复用
    let skillWorkflowRaw = null;     // 最近加载的技能 workflow.json 原始模板（「修复失效路径」后重渲染复用，避免重新拉取）
    let currentIsVideo = false;      // 当前技能是否生视频（内嵌编辑保存后重渲染流程图取对应设置）
    let wfGraph = null, wfCanvas = null;   // 内嵌编辑模式的子图与画布（null = 未挂载）

    // 折叠/展开工作流区：折叠时隐藏流程图与摘要，正文区恢复完整高度
    function setWorkflowCollapsed(collapsed) {
        workflowWrap.classList.toggle("rs-wf-collapsed", collapsed);
        workflowCaret.textContent = collapsed ? "▸" : "▾";
        if (collapsed) unmountWorkflowEditor();   // 折叠 → 卸载内嵌画布
    }
    function resetWorkflowCollapse() {
        setWorkflowCollapsed(true);   // 每次打开技能：工作流区默认折叠
    }

    // ---- 内嵌 litegraph 编辑（workflow.json 模板）----
    // 编辑模式把模板按技能 config 初始化后灌进独立 LGraph + LGraphCanvas（与「导入到画布」同一套
    // widget 键位），保存走 app.graphToPrompt(子图) → updateWorkflowSkill 写回本技能 workflow.json
    // 并同步 config.json，提示词 / 种子 / 参考图等 {{运行时变量}} 原样保留。
    // LiteGraph.configure 只认 litegraph 序列化，API prompt 必须先转换：节点按注册模板实例化取
    // 真实 widget 顺序与槽位顺序，widget 值按名对齐，连线按 API 的 [id, slot] 落到目标槽位名。
    function apiPromptToLitegraph(api) {
        const LiteGraph = window.LiteGraph;
        // 模板节点 id 允许是 "193_82" 这类非数字串（子图展开后是「子图id_子图内节点id」）。LiteGraph 节点 id 必须是数字：
        // Number("193_82") = NaN 会把所有节点挤成同一个 id（连线全接错），且 last_node_id = NaN 会让
        // LGraph.configure 死循环卡死整页 → 先把模板 id 映射成连续整数
        const ids = new Map(Object.keys(api).map((id, i) => [id, i + 1]));
        const infos = Object.entries(api).map(([id, def]) => ({ id: ids.get(id), def: def || {}, node: LiteGraph.createNode((def || {}).class_type) }));
        const byId = new Map(infos.filter((i) => i.node).map((i) => [i.id, i]));
        const missing = infos.filter((i) => !i.node).map((i) => (i.def || {}).class_type);
        const nodes = [], links = [];
        for (const info of infos) {
            if (!info.node) continue;
            const inputs = info.def.inputs || {};
            const widgets = info.node.widgets || [];
            info.out = {
                id: info.id, type: info.node.type, pos: [0, 0], size: [info.node.size[0], info.node.size[1]],
                flags: info.node.flags || {}, mode: Number.isInteger(info.def.mode) ? info.def.mode : (info.node.mode || 0),
                order: (info.def._meta || {}).order || 0,
                properties: {},
                // 按节点自身 widget 顺序取值：createNode 出来的节点只有带默认值的 widgets，
                // widgets_values 要 configure / serialize 才填 → 从它取会整批丢值，画布只剩节点默认值
                widgets_values: widgets.map((w) => (Object.prototype.hasOwnProperty.call(inputs, w.name) ? inputs[w.name] : w.value)),
                inputs: (info.node.inputs || []).map((s) => ({ name: s.name, type: s.type, link: null })),
                outputs: (info.node.outputs || []).map((s) => ({ name: s.name, type: s.type, links: null })),
            };
            nodes.push(info.out);
        }
        for (const info of infos) {
            if (!info.out) continue;
            for (const [name, ref] of Object.entries(info.def.inputs || {})) {
                if (!Array.isArray(ref)) continue;
                const origin = byId.get(ids.get(String(ref[0])));
                const slot = info.out.inputs.findIndex((s) => s.name === name);
                if (!origin || !origin.out || slot < 0 || !origin.out.outputs[ref[1]]) continue;
                const linkId = links.length + 1;
                links.push([linkId, origin.id, ref[1], info.id, slot, ref.length >= 5 ? ref[4] : ref[2] || "COMBO"]);
                info.out.inputs[slot].link = linkId;
                (origin.out.outputs[ref[1]].links || (origin.out.outputs[ref[1]].links = [])).push(linkId);
            }
        }
        // 与导入主画布同一套布局（arrangeCanvasNodes → canvasLayout）：拓扑分层左到右、列内按上游重心堆叠、
        // 列宽拉齐到该列最宽节点。上面每个节点都写 pos [0,0]，不排布就会全叠在原点上
        const byKey = new Map(Object.keys(api).map((key) => [key, byId.get(ids.get(key))]));
        for (const cell of canvasLayout(api, (key) => (byKey.get(key) || {}).out?.size)) {
            const info = byKey.get(cell.id);
            if (!info || !info.out) continue;
            if (cell.w > info.out.size[0]) info.out.size = [cell.w, info.out.size[1]];
            info.out.pos = [cell.x, cell.y];
        }
        const lite = {
            id: 1, version: 0.4, nodes, links, groups: [], config: {},
            last_node_id: ids.size, last_link_id: links.length, last_group_id: 0,
        };
        return { lite, missing };
    }

    function refitWfCanvas() {
        if (!wfCanvas) return;
        const w = wfCanvasBox.clientWidth || 800, h = wfCanvasBox.clientHeight || 420;
        // litegraph 约定后备缓冲 = CSS 尺寸 × dpr、前层 ctx 按 dpr 缩放（同前端 resizeCanvas）：
        // 只按 CSS 像素下发会让背景层只铺满 1/dpr 的画布（125% 缩放下画布看着只剩 80% 大小）
        const dpr = Math.max(window.devicePixelRatio || 1, 1);
        wfCanvas.resize(Math.round(w * dpr), Math.round(h * dpr));
        wfCanvas.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);   // canvas.width 赋值会重置 ctx 变换
        const nodes = (wfCanvas.graph && wfCanvas.graph._nodes) || [];
        if (nodes.length) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const n of nodes) {
                x0 = Math.min(x0, n.pos[0]); y0 = Math.min(y0, n.pos[1]);
                x1 = Math.max(x1, n.pos[0] + n.size[0]); y1 = Math.max(y1, n.pos[1] + n.size[1]);
            }
            const sc = Math.min(1, w / (x1 - x0 + 160), h / (y1 - y0 + 160));
            wfCanvas.ds.scale = sc;
            wfCanvas.ds.offset = [w / (2 * sc) - (x0 + x1) / 2, h / (2 * sc) - (y0 + y1) / 2];
        }
        wfCanvas.setDirty(true, true);
        wfCanvas.draw(true, true);
    }

    // 盒子尺寸变化（窗口缩放 / ⛶ 放大还原 / 把手拉伸 / 左栏分隔条拖动）后重适配内嵌画布
    const wfBoxResize = new ResizeObserver(() => refitWfCanvas());

    function destroyWfEditor() {
        if (wfCanvas) {
            wfCanvas.stopRendering();
            wfCanvas.unbindEvents();
            // litegraph 在 pointerdown 时把 active_canvas 抢给内嵌画布；卸载后必须还原给主画布，
            // 否则主画布上依赖 active_canvas 的静态入口（右键加节点 / 对齐 / 分布 / 节点面板）会打到已死的子图
            const LG = window.LGraphCanvas;
            if (LG && LG.active_canvas === wfCanvas) LG.active_canvas = app.canvas;
            wfCanvas = null;
        }
        if (wfGraph) {
            for (const n of [...wfGraph._nodes]) wfGraph.removeNode(n);   // 逐节点走 litegraph 生命周期（断线、DOM widget 清理）
            wfGraph.clear();
            wfGraph = null;
        }
        wfBoxResize.disconnect();
        wfCanvasBox.innerHTML = "";
    }

    async function mountWfEditor() {
        if (wfCanvas) return true;
        if (!skillWorkflowRaw) { showToast(app, "warning", t("无工作流"), t("本技能没有 workflow.json")); return false; }
        const LGraph = window.LGraph, LGraphCanvas = window.LGraphCanvas;
        if (!LGraph || !LGraphCanvas) { showToast(app, "warning", t("无内嵌画布"), t("当前视图没有 LiteGraph，请用「⤒ 导入到画布」编辑")); return false; }
        const wf = await editorTemplateWorkflow();
        const { lite, missing } = apiPromptToLitegraph(wf);
        // 未注册节点直接进编辑会在保存时把该节点从 workflow.json 里丢掉，拒绝并退回只读预览
        if (missing.length) { showToast(app, "warning", t("无法内嵌编辑"), tf("节点类型未注册：{list}，请用「⤒ 导入到画布」编辑", { list: missing.join("、") })); return false; }
        const g = new LGraph();
        g.configure(lite);   // 节点位置 / 列宽由 converter 里的 canvasLayout 排好
        g.start();
        wfGraph = g;
        const canvasEl = mkEl("canvas", "rs-wf-editor-canvas");
        canvasEl.tabIndex = 1;   // litegraph 把 keydown 绑在 canvas 元素上（主画布靠 tabindex=1），没有焦点就收不到快捷键
        wfCanvasBox.appendChild(canvasEl);
        // ComfyUI 给 litegraph 打的补丁把「画布快捷键」执行在 app.canvas（主画布）上：内嵌画布选中
        // 节点后按 Delete 会打到空的主画布，提示「未选中任何内容」。这里在 litegraph 绑定事件之前抢一个
        // capture 监听，把这些命令作用在内嵌子图上。
        canvasEl.addEventListener("keydown", (e) => {
            const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, alt = e.altKey;
            const nodes = Object.values(wfCanvas.selected_nodes);
            if (!ctrl && !alt && (k === "delete" || k === "backspace")) {
                if (wfCanvas.selectedItems.size) wfCanvas.deleteSelected();
            } else if (ctrl && !e.shiftKey && k === "a") wfCanvas.selectItems();
            else if (ctrl && k === "m") for (const n of nodes) n.mode = n.mode === LiteGraph.NEVER ? LiteGraph.ALWAYS : LiteGraph.NEVER;
            else if (ctrl && k === "b") for (const n of nodes) n.mode = n.mode === 4 ? LiteGraph.ALWAYS : 4;   // BYPASS = 4
            else if (alt && k === "c") for (const n of nodes) n.collapse();
            else if (ctrl && e.shiftKey && k === "v") wfCanvas.pasteFromClipboard({ connectInputs: true });
            else if (k === "." && !ctrl && !alt) {
                if (wfCanvas.empty) return;
                wfCanvas.fitViewToSelectionAnimated({ viewport: wfCanvas.viewport });
            } else return;
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            wfCanvas.setDirty(true, true);
        }, true);
        wfCanvas = new LGraphCanvas(canvasEl, g);
        canvasEl.addEventListener("pointerdown", () => canvasEl.focus());
        canvasEl.focus();
        // litegraph 的 widget 弹窗按「clientX - canvas.getBoundingClientRect().left」定位：主画布左上角
        // 就是视口原点所以看不出问题，内嵌画布在窗口里偏移几百像素，弹窗会飞到鼠标左上方。
        // 前端 CSS 里 .graphdialog 是 position:fixed，落点直接按视口坐标下发。
        const basePrompt = wfCanvas.prompt;
        wfCanvas.prompt = function (name, value, callback, event, multiline) {
            const r = basePrompt.call(this, name, value, callback, event, multiline);
            const dlg = this.prompt_box;
            if (!dlg) return r;
            const rect = canvasEl.getBoundingClientRect();
            dlg.style.left = `${(event ? event.clientX : rect.left + rect.width / 2) - 20}px`;
            dlg.style.top = `${(event ? event.clientY : rect.top + rect.height / 2) - 20}px`;
            dlg.style.zIndex = "10000";   // .graphdialog 基础层只有 1000，会被技能弹窗（9846）盖住
            return r;
        };
        // litegraph 搜索框（双击空白加节点）默认 hide_on_mouse_leave：指针离开 500ms 就自动关。
        // 打中文时输入法候选窗是原生窗口，盖在搜索框上会让页面收到 pointerleave → 输入中文即关窗
        // （输入英文无候选窗，不会触发）。内嵌编辑里关掉这个行为。
        const baseSearchBox = wfCanvas.showSearchBox;
        wfCanvas.showSearchBox = function (event, options) {
            return baseSearchBox.call(this, event, { ...options, hide_on_mouse_leave: false });
        };
        wfBoxResize.observe(wfCanvasBox);
        return true;
    }

    // 展开工作流区时挂内嵌编辑画布（折叠态调用会先展开，画布盒子才有尺寸）。无 LiteGraph 的视图 /
    // 技能含未注册节点时返回 false，调用方回落只读流程图预览。
    async function mountWorkflowEditor() {
        if (!workflowShown || !skillWorkflowRaw || !wfEditorSupported) return false;
        if (workflowWrap.classList.contains("rs-wf-collapsed")) setWorkflowCollapsed(false);   // 展开：画布才有盒子尺寸
        destroyWfEditor();
        if (!(await mountWfEditor())) return false;
        workflowBody.style.display = "none";
        workflowSummary.style.display = "none";
        wfEditWrap.style.display = "flex";
        wfSaveBtn.title = isCustom()
            ? t("把画布上的工作流写回本技能 workflow.json，并把画布上的模型 / 尺寸 / 张数 / 前缀同步进 config.json（提示词等运行时变量原样保留）")
            : t("预设技能：模型 / 尺寸 / 张数 / 前缀等值写入本地覆盖；工作流结构有变更时自动复制为自定义技能写入");
        modal.classList.add("rs-wf-editing");   // 卡片吃满内容区剩余高度，设置区收成区头让位给画布
        requestAnimationFrame(refitWfCanvas);
        return true;
    }

    function unmountWorkflowEditor() {
        destroyWfEditor();
        wfEditWrap.style.display = "none";
        modal.classList.remove("rs-wf-editing");
    }

    // 只读流程图：先按模板变量画蓝框预检，/object_info·/models/* 校验在后台完成后原地补红框
    async function renderWorkflowPreview(wf, genInfo, isVideo, seqId) {
        // 超出模板槽位的 LoRA 运行时动态插入（同后端 _apply_loras：在 render_template 之后、LoRA 槽位填充之前执行，流程图与真实提交一致）
        const values = workflowParamValues(isVideo, genInfo);
        const rendered = applyWorkflowParams(injectRuntimeLoras(wf, ((genInfo || {}).config || {}).loras), values);
        renderWorkflowGraph(workflowBody, rendered, validateWorkflow(rendered, null, {}), workflowSummary, values);   // 内部先清空占位再画
        const validation = await checkWorkflow(rendered);   // /object_info + /models/*，失败内部按跳过处理
        if (currentSkillId === seqId && workflowShown) {   // 等待期间切了技能/关区 → 丢弃过期结果
            const sl = workflowBody.scrollLeft, st = workflowBody.scrollTop;
            renderWorkflowGraph(workflowBody, rendered, validation, workflowSummary, values);
            workflowBody.scrollLeft = sl;
            workflowBody.scrollTop = st;
        }
    }

    async function saveWorkflowFromEditor() {
        if (!currentSkillId) { showToast(app, "warning", t("保存工作流"), t("请先保存技能本体")); return; }
        if (!wfGraph) return;
        if (typeof app.graphToPrompt !== "function") { showToast(app, "warning", t("无画布序列化"), t("当前视图没有画布，保存不可用")); return; }
        try {
            const { output, error } = (await app.graphToPrompt(wfGraph)) || {};
            if (error || !output || !Object.keys(output).length) { showToast(app, "warning", t("无法保存"), t("画布上没有有效工作流") + (error && error.message ? tf("（{msg}）", { msg: error.message }) : "")); return; }
            await confirmWorkflowWrite(currentSkillId, currentSource, output, currentDisplayName, async (r, copy) => {
                if (copy) { await openExisting(copy.id, "custom"); return; }   // 预设结构变更 → 详情切到新建副本继续编辑
                skillWorkflowRaw = output;   // 按新模板重挂内嵌编辑画布
                const genInfo = currentIsVideo ? await loadVideoGenSettings() : await loadGenSettings();   // 回写后的 config 灌回设置区
                loadedGenInfo = genInfo || null;
                genSettingsBaseline = collectGenSettingsJson();   // 设置区已按新 config 重载 → 脏检查基线同步
                if (!(await mountWorkflowEditor())) await renderWorkflowPreview(output, genInfo, currentIsVideo, currentSkillId);
            });
        } catch (err) {
            showToast(app, "error", t("保存工作流失败"), err.message);
        }
    }

    wfSaveBtn.addEventListener("click", (e) => { e.stopPropagation(); saveWorkflowFromEditor(); });
    wfReloadBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!(await mountWorkflowEditor())) await renderWorkflowPreview(skillWorkflowRaw, loadedGenInfo, currentIsVideo, currentSkillId);
    });
    wfFitBtn.addEventListener("click", (e) => { e.stopPropagation(); refitWfCanvas(); });

    // 带工作流的技能：正文不参与生成 → 正文区整体搬进 ? 文档浮窗，主弹窗只留设置区；
    // 无工作流的技能正文区留在主区（参与生成）。
    function syncContentVisibility() {
        if (workflowShown) docBody.appendChild(contentRow);
        else mainRow.insertBefore(contentRow, settingsCol);
        docBtn.style.display = workflowShown ? "" : "none";
    }

    // 客户端剥离 skill.md 的 YAML frontmatter（与后端对标准 --- 块的解析一致）
    function stripFrontmatter(text) {
        let t = String(text || "");
        if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
        const lines = t.split("\n");
        if ((lines[0] || "").replace(/\r$/, "") !== "---") return text;
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].replace(/\r$/, "") === "---") {
                return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
            }
        }
        return text;
    }

    function setEditorMode(mode) {
        editorMode = mode;
        const previewing = mode === "preview";
        // 预览与编辑保持等高：进入预览时按当前编辑框像素高度锁定（长内容各自内部滚动）
        contentPreview.style.height = previewing && contentTextarea.offsetHeight ? contentTextarea.offsetHeight + "px" : "";
        contentTextarea.style.display = previewing ? "none" : "block";
        contentPreview.style.display = previewing ? "block" : "none";
        if (previewing) contentPreview.innerHTML = renderMarkdown(contentTextarea.value);
        previewBtn.classList.toggle("rs-content-mode-active", previewing);
        editBtn.classList.toggle("rs-content-mode-active", !previewing);
    }
    previewBtn.addEventListener("click", (e) => { e.stopPropagation(); setEditorMode("preview"); });
    editBtn.addEventListener("click", (e) => { e.stopPropagation(); setEditorMode("edit"); });

    function populateFileSelect(defaultName) {
        fileSelect.innerHTML = "";
        if (currentFiles.length <= 1) { fileSelect.style.display = "none"; return; }
        currentFiles.forEach(f => {
            const opt = document.createElement("option");
            opt.value = f.name;
            opt.textContent = f.name;
            fileSelect.appendChild(opt);
        });
        if (defaultName) fileSelect.value = defaultName;
        fileSelect.style.display = "inline-block";
    }

    // 依据当前来源 + 选中文件，更新名称/正文/各按钮的可用性与显隐
    function updateControls() {
        const readOnly = !isCustom();
        const mainSel = isMainFile(selectedFile);
        nameInput.disabled = readOnly || (currentFiles.length > 0 && !mainSel);
        contentTextarea.disabled = readOnly;
        multiTurnChk.disabled = readOnly;
        saveBtn.style.display = readOnly ? "none" : "inline-block";
        copyBtn.style.display = readOnly ? "inline-block" : "none";
        deleteBtn.style.display = isCustom() ? "inline-block" : "none";
        addFileBtn.style.display = isCustom() ? "inline-block" : "none";
        editBtn.style.display = readOnly ? "none" : "inline-block";
        previewBtn.style.display = readOnly ? "none" : "inline-block";
        const canDeleteFile = isCustom() && currentFiles.length > 1 && !!selectedFile && !mainSel;
        delFileBtn.style.display = canDeleteFile ? "inline-block" : "none";
    }

    function setBadge() {
        if (currentSource === "presets") { sourceBadge.textContent = "SYS"; sourceBadge.title = "System preset (read-only)"; }
        else if (currentSource === "tasks") { sourceBadge.textContent = "TASK"; sourceBadge.title = "Built-in task skill (read-only)"; }
        else { sourceBadge.textContent = "USR"; sourceBadge.title = "User custom"; }
    }

    async function selectFile(name) {
        if (!currentSkillId || !name) return;
        selectedFile = name;
        const data = await loadSkillFile(currentSkillId, name);
        if (data && data.error) { alert("Failed to load file: " + data.error); return; }
        let text = (data && data.content) || "";
        if (isMainFile(name)) text = stripFrontmatter(text);
        contentTextarea.value = text;
        contentBaseline = { name: nameInput.value, content: text, multiTurn: multiTurnChk.checked };
        setEditorMode(/\.md$/i.test(name) ? editorMode : "edit");
        updateControls();
    }
    fileSelect.addEventListener("change", () => selectFile(fileSelect.value));

    // ---- 打开：查看/编辑已有 skill ----
    async function openExisting(id, source) {
        showDetail();
        titleSpan.textContent = t("📝 技能");
        currentSkillId = id;
        currentSource = source || "custom";
        setBadge();
        nameInput.value = "";
        renderName();   // 加载先清掉上一个技能的名称显示
        contentTextarea.value = "";
        contentPreview.innerHTML = "";
        fileSelect.innerHTML = "";
        fileSelect.style.display = "none";
        selectedFile = null;
        contentBaseline = null;
        genSettingsBaseline = null;
        const full = await loadSkill(id);
        if (full && full.error) { alert("Failed to load skill: " + full.error); close(); return; }
        currentDisplayName = skillDisplayName(full) || null;
        const nm = (full && full.name) || id;
        nameInput.value = nm;
        stopNameEdit();   // 切技能：退出上一个技能的编辑态并回显新名称
        multiTurnChk.checked = !!(full && full.multi_turn);
        currentIsVideo = !!(full && full.gen_video);
        configOverridden = !!(full && full.config_overridden);
        // 不可用视频技能（VDN 加速节点未装）：内容区顶部显示说明
        unavailableBanner.style.display = (full && full.gen_video && full.available === false) ? "block" : "none";
        currentFiles = (full && full.files) || [];
        let mainName = null;
        for (const f of currentFiles) { if (isMainFile(f.name)) { mainName = f.name; break; } }
        if (!mainName && currentFiles.length) mainName = currentFiles[0].name;
        populateFileSelect(mainName);
        setEditorMode("preview");
        if (mainName) await selectFile(mainName);
        else { selectedFile = null; contentTextarea.value = ""; contentBaseline = { name: nm, content: "", multiTurn: multiTurnChk.checked }; }
        // workflow.json 拉取与设置区加载互不依赖 → 提前并发发出，省一段串行等待
        const wfPromise = (full && (full.gen_image || full.gen_video)) ? loadSkillWorkflow(id) : null;
        // 生图/生视频技能显示各自 config.json 覆盖区（恒可编辑：预设存本地覆盖、自定义随主 Save）；其余技能隐藏。
        // multi_turn 是文本多轮概念，生图/生视频技能用不到 → 一并隐藏
        let genInfo = null; // 设置区加载的 { config, models }，供工作流模板预渲染复用（不再重复请求）
        setRepairAlert(genRepairBtn, false);   // 打开新技能先清告警；loadGenSettings/loadVideoGenSettings 内 checkRepairStatus 检测后再点亮
        setRepairAlert(videoRepairBtn, false);
        if (full && full.gen_image) {
            genSettingsWrap.style.display = "block";
            videoGenSettingsWrap.style.display = "none";
            multiTurnRow.style.display = "none";
            enhancePromptWrap.style.display = "";
            genInfo = await loadGenSettings();
        } else if (full && full.gen_video) {
            genSettingsWrap.style.display = "none";
            videoGenSettingsWrap.style.display = "block";
            multiTurnRow.style.display = "none";
            enhancePromptWrap.style.display = "none";
            genInfo = await loadVideoGenSettings();
        } else {
            genSettingsWrap.style.display = "none";
            videoGenSettingsWrap.style.display = "none";
            multiTurnRow.style.display = "";
            enhancePromptWrap.style.display = "none";
        }
        syncSettingsColumn();
        loadedGenInfo = genInfo || null;                  // 「修复失效路径」用：保存 { config, models }
        genSettingsBaseline = collectGenSettingsJson();   // 设置区回填完成 → 脏检查基线就绪
        // 工作流区：仅生图/生视频技能，默认折叠。先显示骨架占位；无 workflow.json 时隐藏。
        // 无 LiteGraph 的视图（Studio 内嵌）没有画布可挂，加载完直接出只读流程图；
        // 有 LiteGraph 的视图展开头部时才挂内嵌编辑画布（见 workflowHeader click），挂不上回落只读流程图。
        workflowBody.innerHTML = "";
        workflowSummary.textContent = "";
        workflowWrap.style.display = "none";
        workflowShown = false;
        skillWorkflowRaw = null;
        unmountWorkflowEditor();   // 切技能先卸载上一个技能的内嵌画布
        closeDoc();                // 切技能收起上一个技能的文档浮窗
        resetWorkflowCollapse();   // 每次打开技能：工作流区默认折叠
        if (wfPromise) {
            const skel = mkEl("div", "rs-wf-skeleton");
            skel.textContent = t("加载工作流图中…");
            workflowBody.appendChild(skel);
            workflowWrap.style.display = "flex";   // 卡片是 flex 列（见 .rs-skill-workflow）：写 block 会让内嵌画布的 flex:1 失效
            workflowShown = true;
            const wf = await wfPromise;
            if (currentSkillId === id && wf) skillWorkflowRaw = wf;   // 存原始模板：内嵌编辑与「修复失效路径」后重渲染复用
            if (wf) {
                // 折叠态不预挂画布（展开头部时才挂，画布盒子要有尺寸）；只读视图没有画布可挂 → 直接出流程图
                if (!wfEditorSupported) await renderWorkflowPreview(wf, genInfo, full.gen_video, id);
            } else {
                workflowWrap.style.display = "none";
                workflowShown = false;
                workflowBody.innerHTML = "";
            }
        }
        syncContentVisibility();
        setEditorMode(editorMode);
        updateControls();
    }

    // ---- 打开：新建空表单 ----
    function openNew() {
        showDetail();
        titleSpan.textContent = t("✨ 新建技能");
        currentSkillId = null;
        currentFiles = [];
        currentSource = "custom";
        configOverridden = false;
        setBadge();
        nameInput.value = "";
        contentTextarea.value = "";
        contentPreview.innerHTML = "";
        fileSelect.innerHTML = "";
        fileSelect.style.display = "none";
        selectedFile = null;
        multiTurnChk.checked = false;
        multiTurnRow.style.display = "";
        enhancePromptWrap.style.display = "none";
        enhancePromptChk.checked = false;
        genSettingsWrap.style.display = "none";
        videoGenSettingsWrap.style.display = "none";
        syncSettingsColumn();
        unavailableBanner.style.display = "none";
        workflowWrap.style.display = "none";
        workflowShown = false;
        skillWorkflowRaw = null;
        currentIsVideo = false;
        unmountWorkflowEditor();
        closeDoc();
        resetWorkflowCollapse();
        syncContentVisibility();   // 新建：正文区回到主区
        workflowBody.innerHTML = "";
        workflowSummary.textContent = "";
        contentBaseline = { name: "", content: "", multiTurn: false };
        genSettingsBaseline = null;
        loadedGenInfo = null;
        nameInput.disabled = false;
        contentTextarea.disabled = false;
        setEditorMode("edit");
        updateControls();
        renderName();
        startNameEdit();   // 新建技能直接进编辑态，名称就是标题
    }

    // ---- 关闭保护：有未保存修改先出确认条（同自动增强菜单 rs-gen-dirty-confirm 模式）----
    // 当前生图/生视频设置区的 JSON 快照（脏检查与保存共用）；无设置区返回 null
    function collectGenSettingsJson() {
        if (genSettingsWrap.style.display !== "none")
            return JSON.stringify({ ...genModelSection.collect(), ...genSizeSection.collect(), enhance_prompt: enhancePromptChk.checked });
        if (videoGenSettingsWrap.style.display !== "none")
            return JSON.stringify(videoModelSection.collect());
        return null;
    }

    function hasUnsavedChanges() {
        if (contentBaseline && (nameInput.value !== contentBaseline.name ||
            contentTextarea.value !== contentBaseline.content ||
            multiTurnChk.checked !== contentBaseline.multiTurn)) return true;
        return genSettingsBaseline !== null && collectGenSettingsJson() !== genSettingsBaseline;
    }

    const dirtyConfirm = mkEl("div", "rs-gen-dirty-confirm");
    dirtyConfirm.hidden = true;
    const dirtyText = mkEl("span", "rs-gen-dirty-text");
    dirtyText.textContent = t("⚠ 有未保存的修改");
    const dirtyActions = mkEl("div", "rs-gen-dirty-actions");
    const btnSaveClose = mkEl("button", "rs-btn rs-gen-dirty-save");
    btnSaveClose.type = "button";
    btnSaveClose.textContent = t("💾 保存并关闭");
    const btnDiscard = mkEl("button", "rs-btn rs-gen-dirty-discard");
    btnDiscard.type = "button";
    btnDiscard.textContent = t("放弃修改");
    const btnKeepEditing = mkEl("button", "rs-btn rs-gen-dirty-keep");
    btnKeepEditing.type = "button";
    btnKeepEditing.textContent = t("继续编辑");
    dirtyActions.append(btnSaveClose, btnDiscard, btnKeepEditing);
    dirtyConfirm.append(dirtyText, dirtyActions);
    content.insertBefore(dirtyConfirm, footerBtns);

    function close() { dirtyConfirm.hidden = true; destroyWfEditor(); closeDoc(); if (embedded) modal.style.display = "none"; else overlay.style.display = "none"; }

    // 用户主动关闭（✕ / 点遮罩 / Esc）：有未保存修改时暂停关闭，等用户在确认条里选择
    function requestClose() {
        if (!hasUnsavedChanges()) { close(); return; }
        dirtyConfirm.hidden = false;
    }
    btnDiscard.addEventListener("click", (e) => { e.stopPropagation(); close(); });
    btnKeepEditing.addEventListener("click", (e) => { e.stopPropagation(); dirtyConfirm.hidden = true; });
    btnSaveClose.addEventListener("click", async (e) => {
        e.stopPropagation();
        btnSaveClose.disabled = true;
        if (isCustom() || !currentSkillId) await handleSave();   // 自定义/新建：主 Save（含生图设置），成功即关
        else { await savePresetGenSettings(); if (!hasUnsavedChanges()) close(); }   // 预设：正文只读，仅设置区可能脏；失败留在弹窗重试
        btnSaveClose.disabled = false;
    });

    // ---- 保存（新建主文件 / 已有 skill 的当前选中文件）----
    // 自定义技能：生图设置区随主 Save 一起写入该技能 config.json；预设技能：走设置区头部「💾 Save」（本地覆盖，见 savePresetGenSettings）
    async function persistGenSettings() {
        if (!currentSkillId || !isCustom()) return;
        try {
            if (genSettingsWrap.style.display !== "none") {
                await saveSkillGenConfig(currentSkillId, { ...genModelSection.collect(), ...genSizeSection.collect(), enhance_prompt: enhancePromptChk.checked });
            } else if (videoGenSettingsWrap.style.display !== "none") {
                await saveSkillGenConfig(currentSkillId, videoModelSection.collect());
            }
            genSettingsBaseline = collectGenSettingsJson();
            dispatchSkillChanged(currentSkillId); // 自定义技能设置落盘 → 通知节点状态条即时重检
        } catch (err) {
            alert("Save gen settings failed: " + err.message);
        }
    }

    async function handleSave() {
        const name = nameInput.value.trim();
        if (!name) { alert("Skill name is required"); return; }
        if (!currentSkillId) {
            const id = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
            if (!id) return;
            const result = await saveSkill({ id, name, content: contentTextarea.value, tags: [], source: "custom", multi_turn: multiTurnChk.checked });
            if (result.success) { dispatchSkillsUpdated(); close(); }
            else alert("Save failed: " + (result.error || "Unknown error"));
            return;
        }
        if (isMainFile(selectedFile)) {
            const result = await saveSkill({ id: currentSkillId, name, content: contentTextarea.value, tags: [], source: "custom", multi_turn: multiTurnChk.checked });
            if (result.success) { contentBaseline = { name: nameInput.value, content: contentTextarea.value, multiTurn: multiTurnChk.checked }; await persistGenSettings(); dispatchSkillsUpdated(); close(); }
            else alert("Save failed: " + (result.error || "Unknown error"));
        } else {
            const r = await saveSkillFile(currentSkillId, selectedFile, contentTextarea.value);
            if (r.success) { contentBaseline = { name: nameInput.value, content: contentTextarea.value, multiTurn: multiTurnChk.checked }; await persistGenSettings(); dispatchSkillsUpdated(); close(); }
            else alert("Save failed: " + (r.error || ""));
        }
    }
    saveBtn.addEventListener("click", (e) => { e.stopPropagation(); handleSave(); });

    // ---- 删除（仅自定义）----
    deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentSkillId || !isCustom()) return;
        const nm = nameInput.value.trim() || currentSkillId;
        if (!confirm(`Delete skill "${nm}"?`)) return;
        const result = await deleteSkill(currentSkillId);
        if (result.success) { dispatchSkillsUpdated(); close(); }
        else alert(`Delete failed: ${result.error || "Unknown error"}`);
    });

    // ---- 复制为自定义（仅内置）----
    copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentSkillId || isCustom()) return;
        const copy = await copySkillAsCustom(currentSkillId, nameInput.value.trim());
        if (copy) await openExisting(copy.id, "custom"); // 立即切换到复制后的 skill 详情
    });

    // ---- 附属 .md：新增 / 删除（仅自定义）----
    addFileBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentSkillId || !isCustom()) return;
        const fname = prompt("New file name (.md or .txt; use / for subfolders):", "notes.md");
        if (!fname || !fname.trim()) return;
        const r = await saveSkillFile(currentSkillId, fname.trim(), "");
        if (r.success) { await openExisting(currentSkillId, currentSource); dispatchSkillsUpdated(); }
        else alert("Add failed: " + (r.error || ""));
    });

    delFileBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!currentSkillId || !selectedFile || isMainFile(selectedFile)) return;
        if (!confirm(`Delete file "${selectedFile}"?`)) return;
        const r = await deleteSkillFile(currentSkillId, selectedFile);
        if (r.success) { await openExisting(currentSkillId, currentSource); dispatchSkillsUpdated(); }
        else alert("Delete failed: " + (r.error || ""));
    });

    // 拦截弹窗内部指针事件向外冒泡，避免触发画布选节点等副作用（同预设列表浮层）
    stopPointerBubble(modal);
    stopPointerBubble(docModal);
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); requestClose(); });
    // 文档浮窗在弹窗之上：Esc 先收起浮窗，再走主弹窗的关闭保护
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && docOverlay.style.display !== "none") { e.stopImmediatePropagation(); closeDoc(); }
    });
    if (!embedded) {
        // 独立弹窗：点遮罩 / Esc 关闭；内嵌模式由宿主窗口（统一技能管理）负责关闭与 Esc
        overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) requestClose(); });
        const onKey = (e) => { if (e.key === "Escape" && overlay.style.display !== "none") requestClose(); };
        document.addEventListener("keydown", onKey);
    }

    // 拦住会打到主画布的全局快捷键。ComfyUI 的 keybindHandler 挂在 window 冒泡，对没有 targetElementId
    // 的绑定（Ctrl+Enter 排队 / Ctrl+S 保存 / Ctrl+O 打开 / Ctrl+G 成组 / Ctrl+, 设置 / Ctrl+` 日志 /
    // Ctrl+Shift+K 快捷键 / Esc 退出子图 / r 刷新 / w n m a 侧栏 / Alt+M）会无条件执行。
    // 本监听在 document 冒泡、注册晚于 Neo 自己的所有 Esc 监听（技能管理 / 文档浮窗 / 选择器都是 capture 或更早），
    // 只把事件截断在 window 之前，Neo 浮层与内嵌画布的按键照常处理。
    // 带 targetElementId 的画布命令（Delete / Ctrl+A / Ctrl+M / Ctrl+B / Alt+C / Ctrl+Shift+V / .）由内嵌画布
    // 自己的 capture 监听就地执行——ComfyUI 的补丁会把这类命令打到 app.canvas，见 mountWfEditor。
    const ctrlBlock = new Set(["enter", "s", "o", "g", ",", "v", "`", "k"]);
    const singleBlock = new Set(["r", "w", "n", "m", "a"]);
    document.addEventListener("keydown", (e) => {
        if (!modal.isConnected || !modal.contains(e.target)) return;   // 弹窗内的按键才归本弹窗管（先关窗的 Esc 监听也要拦住）
        const tag = e.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;   // 输入框里的键归输入框
        const onWfCanvas = !!wfCanvas && e.target === wfCanvas.canvas;
        if (e.key === "Escape") {
            if (onWfCanvas) return;   // 内嵌画布上的 Esc 交给 litegraph 收节点面板 / 断连线
            e.stopPropagation();
            return;
        }
        const k = e.key.toLowerCase();
        if (e.ctrlKey || e.metaKey) { if (ctrlBlock.has(k)) e.stopPropagation(); return; }
        if (e.altKey) { if (k === "m") e.stopPropagation(); return; }
        if (singleBlock.has(k) && !onWfCanvas) e.stopPropagation();
    });

    return { overlay, openExisting, openNew, close, isDirty: hasUnsavedChanges };
}

// ==========================================
// 单例：详情弹窗 / 上传隐藏 input（跨节点共享；createSkillDropdown 的管理入口都走这里）
// ==========================================

let _skillDetailPopup = null;
function getSkillDetailPopup() {
    if (!_skillDetailPopup) _skillDetailPopup = createSkillDetailPopup();
    return _skillDetailPopup;
}

/** 按 id 解析 source 后打开单技能详情弹窗（跨节点单例）。 */
async function openSkillDetailById(skillId) {
    const id = String(skillId || "").trim();
    if (!id) return;
    let source = "custom";
    try {
        const list = await listSkills();
        const hit = (list || []).find((s) => s.id === id);
        if (hit && hit.source) source = hit.source;
    } catch (_) {}
    getSkillDetailPopup().openExisting(id, source);
}

export { createSkillDetailPopup, getSkillDetailPopup, openSkillDetailById };
