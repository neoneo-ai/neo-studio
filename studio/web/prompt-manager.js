/**
 * prompt-manager.js
 * 提示词管理模块 - UI 组件创建 + 保存、列表、加载、删除
 */

import { app } from "../../scripts/app.js";
import { collectWorkflowAssets, collectWorkflowResults, collectWorkflowLoras, saveRecipe, listRecipes, deleteRecipe, applyRecipeToWorkflow, RECIPE_ICON_SVG } from "./recipes.js";
import { t, tf } from "./js/core/i18n.js";

import {
    savePrompt,
    loadPrompt,
    listPrompts,
    listPromptLines,
    deletePrompt,
    extractTitle,
    extractClassify
} from "./prompt-service.js";
import { mkEl } from "./dom-utils.js";
import { createStatusBars, createPromptOutputArea, triggerTextChange } from "./llm-chat.js";
import { openLLMSettingsModal } from "./llm-setting.js";
import { actionToast } from "./toast.js";

// 「保存预设」时的自动命名/打标签依赖 LLM：失败给 LLM 设置入口，标题与标签仍可手填
function llmAnalysisErrorToast(detail) {
    actionToast({
        severity: "warning",
        summary: t("LLM 分析提示词失败"),
        detail: tf("{err}。请手动填写标题/标签，或检查 API Key / 模型 / 端点。", { err: detail }),
        actionLabel: t("打开 LLM 设置"),
        onAction: openLLMSettingsModal,
    });
}

// 配方类型：按当前工作流里的生成节点判定（H3=视频 / Gen&Edit=图像），供列表筛选；都没有则空
function detectGenType(graph) {
    const types = (graph?._nodes || []).map(n => n.type);
    if (types.includes("NeoH3VideoDirector")) return "video";
    if (types.includes("NeoImageGenEdit")) return "image";
    return "";
}

// 预设列表的过滤便签：图像（默认）/ 视频（presets 下 video/ 目录的提示词）/ 配方（普通配方）。
// 用户选择写入 localStorage，下次打开沿用。
const FILTER_TABS = [
    { key: "image", label: t("图像") },
    { key: "video", label: t("视频") },
    { key: "recipe", label: t("配方") },
];
const FILTER_TAB_KEY = "rs.preset_filter";

function loadFilterTab() {
    try {
        const saved = localStorage.getItem(FILTER_TAB_KEY);
        return FILTER_TABS.some(t => t.key === saved) ? saved : "image";
    } catch (e) {
        return "image";
    }
}

function saveFilterTab(key) {
    try { localStorage.setItem(FILTER_TAB_KEY, key); } catch (err) { /* 隐私模式下 localStorage 可能不可用 */ }
}

function matchFilterTab(item, tab) {
    const name = typeof item === "string" ? item : item.name;
    if (item.isRecipe) return tab === "recipe";
    if (tab === "recipe") return false;
    // 提示词扫描带目录前缀，presets 下 video/ 及其子目录算视频提示词，其余归图像
    const isVideo = name.startsWith("video/");
    return tab === "video" ? isVideo : !isVideo;
}

// ==========================================
// UI 组件创建 (内部使用)
// ==========================================

function createOverlayWithSearch() {
    const overlay = mkEl("div", "rs-preset-list-overlay");
    // Search input at top of the panel
    const searchBar = mkEl("input", "rs-preset-search-input");
    searchBar.type = "text";
    searchBar.placeholder = "Search presets...";
    const tabBar = mkEl("div", "rs-preset-tabs");
    const body = mkEl("div", "rs-preset-list-body");
    overlay.appendChild(searchBar);
    overlay.appendChild(tabBar);
    overlay.appendChild(body);
    return { overlay, body, searchBar, tabBar };
}

function createInputModal() {
    const modal = mkEl("div", "rs-preset-name-input");
    const aiStatus = mkEl("div", "rs-ai-status processing");
    aiStatus.innerHTML = t("AI 正在分析提示词...");

    const label = mkEl("div", "rs-input-label");
    label.textContent = t("名称:");

    const inputWrapper = mkEl("div", "rs-input-wrapper");
    const field = mkEl("input", "rs-input-field");
    field.placeholder = "Enter preset name...";
    inputWrapper.appendChild(field);

    const tagsLabel = mkEl("div", "rs-input-label");
    tagsLabel.textContent = "Tags (optional):";

    const tagsContainer = mkEl("div", "rs-tags-container");
    const tagList = ["唯美", "特色", "写实", "古风", "动漫", "油画", "室内", "户外"];
    const selectedTags = new Set();

    tagList.forEach(tag => {
        const tagBtn = mkEl("button", "rs-tag-btn");
        tagBtn.dataset.tag = tag;
        tagBtn.textContent = t(tag);
        tagBtn.addEventListener("click", () => {
            if (selectedTags.has(tag)) {
                selectedTags.delete(tag);
                tagBtn.classList.remove("rs-tag-selected");
            } else {
                selectedTags.add(tag);
                tagBtn.classList.add("rs-tag-selected");
            }
        });
        tagsContainer.appendChild(tagBtn);
    });

    const recipeHint = mkEl("div", "rs-recipe-hint");
    recipeHint.style.display = "none";

    // 同时保存结果：把当前工作流最近一次执行的输出存入配方 samples/（用于封面与预览），
    // 示例文件内嵌了 ComfyUI 工作流，可在详情浮层一键复制回画布。
    const saveResultsRow = mkEl("label", "rs-save-results-row");
    saveResultsRow.title = t("把当前工作流最近一次执行的输出存入配方，用于封面与预览展示；示例内嵌工作流，可在详情浮层一键复制回画布");
    const saveResultsCheck = mkEl("input", "rs-save-results-check");
    saveResultsCheck.type = "checkbox";
    saveResultsCheck.checked = true; // 默认选中当前运行结果与工作流备份
    const saveResultsText = mkEl("span", "");
    saveResultsText.textContent = t("同时保存结果");
    saveResultsRow.append(saveResultsCheck, saveResultsText);
    saveResultsRow.style.display = "none";

    const btnsDiv = mkEl("div", "rs-input-buttons");
    const okBtn = mkEl("button", "rs-input-ok-btn");
    okBtn.textContent = t("保存提示词");
    const recipeOkBtn = mkEl("button", "rs-input-ok-btn rs-input-recipe-btn");
    recipeOkBtn.innerHTML = `${RECIPE_ICON_SVG}<span>${t("保存配方")}</span>`;
    recipeOkBtn.style.display = "none";
    const cancelBtn = mkEl("button", "rs-input-cancel-btn");
    cancelBtn.textContent = "Cancel";
    btnsDiv.append(okBtn, recipeOkBtn, cancelBtn);
    modal.append(aiStatus, label, inputWrapper, tagsLabel, tagsContainer, recipeHint, saveResultsRow, btnsDiv);

    return { modal, aiStatus, label, field, inputWrapper, tagsLabel, tagsContainer, okBtn, recipeOkBtn, cancelBtn, selectedTags, recipeHint, saveResultsRow, saveResultsCheck };
}

function createDeleteModal() {
    const modal = mkEl("div", "rs-delete-confirm-overlay");
    const textDiv = mkEl("div", "rs-delete-text");
    const btnsDiv = mkEl("div", "rs-delete-buttons");
    const okBtn = mkEl("button", "rs-delete-ok-btn");
    okBtn.textContent = "OK";
    const cancelBtn = mkEl("button", "rs-delete-cancel-btn");
    cancelBtn.textContent = "Cancel";
    btnsDiv.append(okBtn, cancelBtn);
    modal.append(textDiv, btnsDiv);
    return { modal, textDiv, okBtn, cancelBtn };
}


// ==========================================
// Main UI factory
// ==========================================

function createPromptManagerUI() {
    const { statusBar, quickInputWrapper, randomBtn, randomWrap, listBtn, quickInput, generateBtn, customTextarea, buttonsWrapper, saveBtn, toggleSwitch, localTab, externalTab, skillSelector, populateSkillSelector, actionRow, autoGenerateCheckbox, thinkingDepthSelect, attachedImages, addImageFile, clearImages, attachBtn, imageChipsRow, setAttachedChangeListener } = createStatusBars();
    const { overlay: presetListOverlay, body: presetListBody, searchBar: presetSearchBar, tabBar: presetTabBar } = createOverlayWithSearch();
    const { modal: presetNameInput, aiStatus, label, field: inputField, tagsLabel, tagsContainer, selectedTags, okBtn: inputOk, recipeOkBtn: inputRecipeOk, cancelBtn: inputCancel, recipeHint, saveResultsRow: recipeResultsRow, saveResultsCheck: recipeResultsCheck } = createInputModal();
    const { modal: deleteConfirmOverlay, textDiv: deleteText, okBtn: deleteOk, cancelBtn: deleteCancel } = createDeleteModal();

    const root = mkEl("div", "rs-root");

    root.appendChild(statusBar);
    // Preset list overlay - positioned as a centered panel (not dropdown).
    // 挂到 body 而非节点 DOM 层：留在节点层内时，聚焦搜索框引发节点选中后
    // 选中态工具栏会压在浮层之上。同时拦截浮层内部指针/按键事件向外冒泡，
    // 避免点击或聚焦输入框时触发画布选节点等副作用。
    document.body.appendChild(presetListOverlay);
    ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "touchstart", "keydown"].forEach((t) => {
        presetListOverlay.addEventListener(t, (e) => e.stopPropagation());
    });
    // 弹出位置贴着节点上的 list 按钮（不再屏幕居中）：与按钮右缘对齐、默认弹到下方，
    // 下方放不下且上方空间更大时上翻，水平夹在视口内。调用前需已将 display 设为 flex 以便测量。
    const placePresetOverlay = () => {
        const r = listBtn.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = presetListOverlay.offsetWidth || 400;
        const h = presetListOverlay.offsetHeight || 300;
        let left = r.right - w;
        if (left < 8) left = 8;
        if (left + w > vw - 8) left = Math.max(8, vw - 8 - w);
        const spaceBelow = vh - 8 - (r.bottom + 6);
        const spaceAbove = r.top - 14;
        let top = r.bottom + 6;
        if (h > spaceBelow && spaceAbove > spaceBelow) {
            top = Math.max(8, r.top - h - 6);
        }
        if (top + h > vh - 8) top = Math.max(8, vh - 8 - h);
        presetListOverlay.style.left = left + "px";
        presetListOverlay.style.top = top + "px";
        presetListOverlay.style.transform = "none";
    };
    // 列表内容异步加载、集合翻页、聚合搜索结果都会让浮层变高，跟踪尺寸变化随时重定位，
    // 否则刚打开时按空列表测量的位置会在内容渲染后底部越出视口。
    new ResizeObserver(() => {
        if (presetListOverlay.style.display === "flex") placePresetOverlay();
    }).observe(presetListOverlay);

    // 配方行悬停浮出预览图：单一共享节点，避免每个 row 都创建/销毁 <img>
    let presetPreviewPop = null;
    const recipeAssetUrl = (recipe, file) =>
        `${window.location.protocol}//${window.location.host}/rs_recipes/asset?recipe=${encodeURIComponent(recipe)}&file=${encodeURIComponent(file)}`;
    function showPresetPreview(anchor, recipe, coverFile) {
        if (!coverFile) return;
        if (!presetPreviewPop) {
            presetPreviewPop = document.createElement("div");
            presetPreviewPop.className = "rs-preset-preview-pop";
            const img = document.createElement("img");
            img.alt = "";
            img.loading = "lazy";
            presetPreviewPop.appendChild(img);
            document.body.appendChild(presetPreviewPop);
        }
        const img = presetPreviewPop.querySelector("img");
        const key = `${recipe}::${coverFile}`;
        if (img.dataset.src !== key) {
            img.dataset.src = key;
            img.src = recipeAssetUrl(recipe, coverFile);
        }
        const rect = anchor.getBoundingClientRect();
        const popWidth = 240;
        const margin = 8;
        let left = rect.right + margin;
        if (left + popWidth > window.innerWidth - margin) {
            left = rect.left - popWidth - margin;
        }
        if (left < margin) left = margin;
        let top = rect.top;
        presetPreviewPop.style.left = `${left}px`;
        presetPreviewPop.style.top = `${top}px`;
        presetPreviewPop.classList.add("visible");
    }
    function hidePresetPreview() {
        if (presetPreviewPop) presetPreviewPop.classList.remove("visible");
    }

    // 预设列表键盘导航：↑↓/Home/End/PageUp/PageDown 切换活动行，Enter 激活，
    // Delete 触发自定义行的删除确认，Esc 关闭浮层，← 在集合视图里走「返回」行。
    // 活动行复用 .rs-preset-active 类，避免与 :hover 视觉冲突。
    let presetActiveIndex = -1;
    const getVisiblePresetItems = () => {
        const all = presetListBody.querySelectorAll(".rs-preset-item");
        return Array.from(all).filter(el => el.offsetParent !== null || getComputedStyle(el).display !== "none");
    };
    const setActivePresetItem = (index) => {
        const items = getVisiblePresetItems();
        if (!items.length) {
            presetActiveIndex = -1;
            return;
        }
        let next = index;
        if (next < 0) next = items.length - 1;
        if (next >= items.length) next = 0;
        items.forEach((el, i) => el.classList.toggle("rs-preset-active", i === next));
        presetActiveIndex = next;
        const target = items[next];
        if (target && typeof target.scrollIntoView === "function") {
            target.scrollIntoView({ block: "nearest" });
        }
    };
    const activatePresetItem = (row) => {
        if (!row) return;
        row.click();
    };
    const findActivePresetIndex = () => {
        const items = getVisiblePresetItems();
        return items.findIndex(el => el.classList.contains("rs-preset-active"));
    };
    const handlePresetListKeydown = (e) => {
        if (presetListOverlay.style.display !== "flex") return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const target = e.target;
        // 便签按钮：Enter/空格交给按钮自身的 click，不当作「激活当前行」；
        // 仅方向键与 Esc 仍交给列表导航
        if (target.closest?.(".rs-preset-tabs")
            && e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape") return;
        // 浮层内的输入控件（搜索框）允许普通字符编辑；
        // 只在方向键/Home/End/PageUp/PageDown/Enter/Esc/← 时才切换列表焦点
        const inSearch = target === presetSearchBar;
        if (inSearch && e.key !== "ArrowDown" && e.key !== "ArrowUp"
            && e.key !== "Enter" && e.key !== "Escape"
            && e.key !== "Home" && e.key !== "End"
            && e.key !== "PageUp" && e.key !== "PageDown"
            && e.key !== "ArrowLeft") return;

        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            presetListOverlay.style.display = "none";
            isListOpen = false;
            clearCollectionViewState();
            hidePresetPreview();
            presetActiveIndex = -1;
            return;
        }

        const items = getVisiblePresetItems();
        if (!items.length) return;

        let current = findActivePresetIndex();
        if (current < 0 && (e.key === "ArrowDown" || e.key === "Enter")) {
            current = 0;
            setActivePresetItem(0);
        }
        if (current < 0) return;

        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                setActivePresetItem(current + 1);
                break;
            case "ArrowUp":
                e.preventDefault();
                setActivePresetItem(current - 1);
                break;
            case "Home":
                e.preventDefault();
                setActivePresetItem(0);
                break;
            case "End":
                e.preventDefault();
                setActivePresetItem(items.length - 1);
                break;
            case "PageDown":
                e.preventDefault();
                setActivePresetItem(current + 10);
                break;
            case "PageUp":
                e.preventDefault();
                setActivePresetItem(current - 10);
                break;
            case "Enter":
                e.preventDefault();
                activatePresetItem(items[current]);
                break;
            case "ArrowLeft":
                if (collectionView) {
                    const back = presetListBody.querySelector(".rs-collection-back");
                    if (back) {
                        e.preventDefault();
                        activatePresetItem(back);
                    }
                }
                break;
            case "Delete":
            case "Backspace": {
                // 仅在「非 Backspace」或「自定义行」时触发，避免与文本编辑混淆
                const row = items[current];
                const isCustom = row && row.classList.contains("rs-preset-item")
                    && !row.classList.contains("rs-collection-back")
                    && !row.classList.contains("rs-load-more-item")
                    && row.querySelector(".rs-delete-icon") !== null;
                if (e.key === "Backspace" && !isCustom) break;
                if (isCustom) {
                    e.preventDefault();
                    const delBtn = row.querySelector(".rs-delete-icon");
                    if (delBtn) delBtn.click();
                }
                break;
            }
        }
    };
    presetListOverlay.addEventListener("keydown", handlePresetListKeydown);

    // 鼠标悬停时同步键盘活动行：用户用鼠标选中后，↑↓ 接着当前行走
    presetListBody.addEventListener("mousemove", (e) => {
        const row = e.target.closest(".rs-preset-item");
        if (!row) return;
        const items = getVisiblePresetItems();
        const idx = items.indexOf(row);
        if (idx >= 0 && idx !== presetActiveIndex) {
            items.forEach((el, i) => el.classList.toggle("rs-preset-active", i === idx));
            presetActiveIndex = idx;
        }
    });
    presetListBody.addEventListener("mouseleave", () => {
        // 鼠标移出列表不主动清空活动行，方便用户接着用键盘
    });

    // 输出区（textarea + Markdown 预览 + 清空 + 多轮提示）归 llm-chat.js 所有；
    // //三个动作按钮作为不透明节点组合进它的按钮组，顺序保持不变。
    const promptOutput = createPromptOutputArea({ customTextarea, skillSelector, actions: [saveBtn, randomWrap, listBtn] });

    root.appendChild(promptOutput.el);

    root.appendChild(buttonsWrapper);
    // quickInputWrapper at the bottom of the node
    root.appendChild(quickInputWrapper);
    // 多轮提示贴节点最底部（跟在快捷输入栏下），避免落在文本区下方的空白中段
    root.appendChild(promptOutput.skillHintEl);
    // 生图状态行：节点最底部一行固定显示生成状态/进度/取消（运行中出现、结束即隐藏，不随预览滚动）
    root.appendChild(promptOutput.genStatusEl);

    // 挂 body 防节点边界裁剪（fixed 定位居中于视口）
    document.body.appendChild(presetNameInput);
    document.body.appendChild(deleteConfirmOverlay);

    presetListBody.style.scrollbarWidth = "thin";
    presetListBody.style.scrollbarColor = "#5090cc #1a1a1a";

    let pendingDeleteName = null;
    let pendingDeleteIsRecipe = false;
    let context = null;
    let isLoading = false;
    let isListOpen = false;

    // 过滤便签（图像 / 视频 / 配方）：默认「图像」，选择持久化在 localStorage
    let filterTab = loadFilterTab();

    function renderFilterTabs() {
        presetTabBar.innerHTML = "";
        FILTER_TABS.forEach(({ key, label }) => {
            const tab = mkEl("button", "rs-preset-tab");
            tab.type = "button";
            tab.textContent = label;
            tab.dataset.key = key;
            if (key === filterTab) tab.classList.add("rs-preset-tab-active");
            presetTabBar.appendChild(tab);
        });
    }
    renderFilterTabs();

    // 图片增删即时推送暂存（按节点 id）：使 @引用/本地上传图不依赖点击生成即进入 bundle.references
    function pushBundleRefs(nodeId, images) {
        const refs = images.map(img => img.input ? { kind: "input", value: img.input } : { kind: "data", data: img.data });
        fetch("/rs_prompts/bundle_refs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uid: nodeId, refs })
        }).catch(e => console.warn("pushBundleRefs failed:", e));
    }

    function init(ctx) {
        context = ctx;
        const { node, textWidget, allowRecipe } = ctx;

        setAttachedChangeListener(images => pushBundleRefs(node.id, images));

        function handleSaveClick() {
            presetListOverlay.style.display = "none";
            deleteConfirmOverlay.style.display = "none";
            presetNameInput.style.display = "block";
            inputField.value = "";
            setTimeout(() => inputField.focus(), 50);

            inputRecipeOk.style.display = allowRecipe ? "" : "none";
            recipeResultsRow.style.display = allowRecipe ? "" : "none";

            selectedTags.clear();
            const tagButtons = tagsContainer.querySelectorAll(".rs-tag-btn");
            tagButtons.forEach(btn => {
                btn.classList.remove("rs-tag-selected");
            });

            const currentText = textWidget?.value || "";

            recipeHint.style.display = allowRecipe ? "block" : "none";
            if (allowRecipe) {
                recipeHint.textContent = t("正在收集工作流资源...");
                collectWorkflowAssets(node).then(assets => {
                    const p = (customTextarea?.value || currentText).trim();
                    recipeHint.textContent = tf("配方将包含 {n} 个资源（当前子图中已连线的 LoadImage/LoadVideo/LoadAudio）{p}。", { n: assets.length, p: p ? t(" + 当前提示词") : "" });
                }).catch(e => {
                    console.error("[Neo Recipes] Collect failed:", e);
                    recipeHint.textContent = t("工作流资源收集失败");
                });
            }

            if (currentText.trim()) {
                saveBtn.disabled = true;
                aiStatus.className = "rs-ai-status processing";
                aiStatus.innerHTML = t("AI 正在分析提示词...");

                Promise.all([
                    extractTitle(currentText),
                    extractClassify(currentText)
                ]).then(([dataTitle, dataClassify]) => {
                    if (dataTitle.status === "success") {
                        inputField.value = dataTitle.title;
                    }

                    if (dataClassify.status === "success" && dataClassify.classify) {
                        const classifyText = dataClassify.classify.trim();
                        const classifyList = classifyText.split(/[,，]/).map(s => s.trim()).filter(s => s);

                        tagButtons.forEach(btn => {
                            const btnText = btn.dataset.tag;
                            if (classifyList.includes(btnText)) {
                                selectedTags.add(btnText);
                                btn.classList.add("rs-tag-selected");
                            }
                        });
                        aiStatus.className = "rs-ai-status success";
                        aiStatus.innerHTML = t("AI 分析完成");
                    } else {
                        aiStatus.className = "rs-ai-status error";
                        aiStatus.innerHTML = t("AI 分析失败，请手动填写");
                        llmAnalysisErrorToast(dataClassify.error || dataTitle.error || t("未能识别标题与标签"));
                    }
                }).catch(e => {
                    console.error("Auto-extract error:", e);
                    llmAnalysisErrorToast(e?.message || String(e));
                }).finally(() => {
                    saveBtn.disabled = false;
                });
            }
        }

        function performSave() {
            const name = inputField.value.trim();
            if (!name) return;
            presetNameInput.style.display = "none";
            const tags = Array.from(selectedTags);
            savePrompt(name, textWidget ? textWidget.value : "", tags);
        }

        function performRecipeSave() {
            const name = inputField.value.trim();
            if (!name) return;
            presetNameInput.style.display = "none";
            saveRecipeFromModal(name);
        }

        async function saveRecipeFromModal(name) {
            try {
                const assets = await collectWorkflowAssets(node);
                const results = recipeResultsCheck.checked ? collectWorkflowResults() : [];
                const loras = await collectWorkflowLoras(node);
                const promptText = customTextarea?.value || textWidget?.value || "";
                const genType = detectGenType(node.graph);
                const result = await saveRecipe(name, promptText, assets, results, loras, null, genType);
                if (result.success) {
                    const extra = result.sample_added ? tf(" + {n} 结果", { n: result.sample_added }) : "";
                    app.extensionManager.toast.add({ severity: "success", summary: t("配方已保存"), detail: tf("{name}（{n} 资源{extra}）", { name, n: result.asset_count, extra }), life: 4000 });
                } else {
                    app.extensionManager.toast.add({ severity: "error", summary: t("保存失败"), detail: result.error || "Unknown error", life: 5000 });
                }
            } catch (e) {
                console.error("[Neo Recipes] Save failed:", e);
                app.extensionManager.toast.add({ severity: "error", summary: t("保存失败"), detail: e.message, life: 5000 });
            }
        }

        async function loadPresetDropdown() {
            if (isLoading) return;
            isLoading = true;
            presetActiveIndex = -1;

            presetListBody.innerHTML = "";

            const loadingDiv = mkEl("div", "rs-loading");
            loadingDiv.textContent = "Loading...";
            presetListBody.appendChild(loadingDiv);

            try {
                const [list, recipes] = await Promise.all([listPrompts(), listRecipes()]);

                if (loadingDiv.parentNode) loadingDiv.remove();

                // 配方并入预设列表统一展示（立方体图标区分）；source 归一化为 presets/custom
                const recipeItems = (Array.isArray(recipes) ? recipes : []).map(r => ({
                    name: r.name,
                    tags: [],
                    source: r.source === "preset" ? "presets" : "custom",
                    _mtime: r.mtime || 0,
                    isRecipe: true,
                    prompt: r.prompt || "",
                    assetCount: r.asset_count || 0,
                    cover: r.cover || null,
                    assets: Array.isArray(r.assets) ? r.assets : [],
                }));
                const merged = [...list, ...recipeItems];

                // 按当前便签分类过滤：图像 / 视频 / 配方
                const filtered = merged.filter(item => matchFilterTab(item, filterTab));

                if (!filtered.length) {
                    presetListBody.textContent = "No presets found";
                    isLoading = false;
                    return;
                }

                // 集合（collections/）条目置顶展示，避免混在普通预设里被淹没；
                // 其余条目（提示词+配方）按来源分组、组内 mtime 降序统一排序
                const isCollection = item => isCollectionName(typeof item === 'string' ? item : item.name);
                const byMtime = (a, b) => (b._mtime || 0) - (a._mtime || 0);
                const ordered = [
                    ...filtered.filter(isCollection),
                    ...filtered.filter(item => !isCollection(item) && item.source !== "presets").sort(byMtime),
                    ...filtered.filter(item => !isCollection(item) && item.source === "presets").sort(byMtime),
                ];

                // 配方行悬停浮出预览图：showPresetPreview / hidePresetPreview 由外层 createPromptManagerUI 提供。
                ordered.forEach(item => {
                    const name = typeof item === 'string' ? item : item.name;
                    const tags = typeof item === 'string' ? [] : (item.tags || []);
                    const source = typeof item === 'object' ? item.source : "custom";
                    const shown = name;

                    const row = document.createElement("div");
                    row.className = "rs-preset-item";
                    row.dataset.name = name;

                    const leftDiv = mkEl("div", "rs-preset-left");
                    const contentSpan = mkEl("span", "rs-preset-content");
                    const displayText = shown;

                    if (tags && tags.length > 0) {
                        contentSpan.textContent = shown;
                        const tagsSpan = document.createElement("span");
                        tagsSpan.className = "rs-tags-part";
                        tagsSpan.textContent = ` [${tags.join(", ")}]`;
                        contentSpan.appendChild(document.createTextNode(" "));
                        contentSpan.appendChild(tagsSpan);
                    } else {
                        contentSpan.textContent = shown;
                    }

                    if (item.isRecipe) {
                        const icon = mkEl("span", "rs-recipe-icon");
                        icon.innerHTML = RECIPE_ICON_SVG;
                        contentSpan.prepend(icon);
                        contentSpan.title = tf("{name}（{src}配方{assets}）", { name, src: source === "presets" ? t("内置") : t("自定义"), assets: item.assetCount ? tf(" · {n} 个资源", { n: item.assetCount }) : "" });

                        // 悬停浮出预览图：与侧边栏配方卡片用同一封面解析（_preview/_cover/首图）
                        const coverFile = item.cover || (Array.isArray(item.assets)
                            ? (item.assets.find(a => a && a.kind === "image") || {}).file
                            : null);
                        if (coverFile) {
                            row.addEventListener("mouseenter", () => showPresetPreview(row, item.name, coverFile));
                            row.addEventListener("mouseleave", hidePresetPreview);
                        }
                    }

                    const sourceBadge = mkEl("span", "rs-source-badge");
                    sourceBadge.textContent = source === "presets" ? "SYS" : "USR";
                    sourceBadge.title = source === "presets" ? "System preset (cannot delete)" : "User preset";
                    contentSpan.appendChild(sourceBadge);

                    contentSpan.dataset.original = displayText;
                    row.dataset.original = displayText;
                    leftDiv.appendChild(contentSpan);
                    row.appendChild(leftDiv);

                    row.onclick = async (e) => {
                        if (e.target.closest(".rs-delete-icon")) return;
                        hidePresetPreview();
                        presetActiveIndex = -1;

                        if (isCollectionName(name)) {
                            openCollection(name, source);
                            return;
                        }

                        if (item.isRecipe) {
                            fillFromEntry({ text: item.prompt || "" });
                            // 与侧边栏一键发送一致：同时按参数位还原资源；提示词已由 fillFromEntry 写入当前节点，
                            // 资产只还原到当前节点所在子图，与其他子图无关
                            applyRecipeToWorkflow({ name: item.name }, { fillPrompt: false, anchorNode: node });
                            return;
                        }

                        const data = await loadPrompt(name);

                        if (textWidget) {
                            textWidget.value = data.text || "";
                        }
                        if (customTextarea) {
                            customTextarea.value = data.text || "";
                            triggerTextChange(customTextarea);
                        }

                        const currentUid = node.properties.rs_instance_uid || node.widgets?.find(w => w.name === "instance_uid")?.value;
                        // In-memory cache only - no localStorage

                        presetListOverlay.style.display = "none";
                        if (node.graph) node.graph.setDirtyCanvas(true, true);
                    };

                    if (source === "custom") {
                        const deleteBtn = mkEl("span", "rs-delete-icon");
                        deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
                        deleteBtn.setAttribute("aria-label", "Delete preset");
                        deleteBtn.onclick = async (e) => {
                            e.stopPropagation();
                            pendingDeleteName = name;
                            pendingDeleteIsRecipe = !!item.isRecipe;
                            deleteText.textContent = item.isRecipe ? `Delete recipe "${name}"?` : `Delete "${name}"?`;
                            deleteConfirmOverlay.style.display = "block";
                        };
                        row.appendChild(deleteBtn);
                    }

                    presetListBody.appendChild(row);
                });
            } catch (e) {
                presetListBody.textContent = "Error loading";
            } finally {
                isLoading = false;
                clearCollectionViewState();
            }
        }

        // 多行集合（collections/ 目录约定）浏览：分页加载，避免一次渲染上万条目
        const COLLECTION_PAGE_LIMIT = 200;
        let collectionView = null; // { name, source, total, shown, query }；null 表示文件级列表
        let collectionSearchTimer = null;
        let collectionSearchSeq = 0; // 聚合搜索过期结果丢弃用

        function isCollectionName(name) {
            return typeof name === "string" && name.startsWith("collections/");
        }

        function clearCollectionViewState() {
            collectionView = null;
            clearTimeout(collectionSearchTimer);
            collectionSearchSeq++;
            const matches = presetListBody.querySelector(".rs-collection-matches");
            if (matches) matches.remove();
        }

        function buildCollectionBackRow() {
            const row = mkEl("div", "rs-preset-item rs-collection-back");
            row.textContent = t("← 返回预设列表");
            row.onclick = () => {
                clearCollectionViewState();
                presetSearchBar.value = "";
                loadPresetDropdown();
            };
            return row;
        }

        function applyCollectionRows(entries) {
            const frag = document.createDocumentFragment();
            entries.forEach(({ title, text }) => {
                const row = mkEl("div", "rs-preset-item");
                const leftDiv = mkEl("div", "rs-preset-left");
                const contentSpan = mkEl("span", "rs-preset-content");
                contentSpan.textContent = title;
                contentSpan.title = title;
                leftDiv.appendChild(contentSpan);
                row.appendChild(leftDiv);
                row.onclick = async (e) => {
                    if (e.target.closest(".rs-delete-icon")) return;

                    fillFromEntry({ text });
                };
                frag.appendChild(row);
            });
            presetListBody.appendChild(frag);
        }

        function fillFromEntry(entry) {
            if (textWidget) {
                textWidget.value = entry.text || "";
            }
            if (customTextarea) {
                customTextarea.value = entry.text || "";
                triggerTextChange(customTextarea);
            }

            presetListOverlay.style.display = "none";
            isListOpen = false;
            clearCollectionViewState();
            if (node.graph) node.graph.setDirtyCanvas(true, true);
        }

        function renderCollectionMatches(total, entries) {
            presetListBody.querySelector(".rs-collection-matches")?.remove();
            if (!entries.length) return;

            const box = mkEl("div", "rs-collection-matches");
            const head = mkEl("div", "rs-loading");
            head.textContent = tf("集合内匹配 {shown} / {total} 条", { shown: entries.length, total });
            box.appendChild(head);

            entries.forEach(({ title, text, name, source }) => {
                const row = mkEl("div", "rs-preset-item");
                const leftDiv = mkEl("div", "rs-preset-left");
                const contentSpan = mkEl("span", "rs-preset-content");
                contentSpan.textContent = title;
                contentSpan.title = `${name}（${source}）`;
                leftDiv.appendChild(contentSpan);

                const originBadge = mkEl("span", "rs-tags-part");
                originBadge.textContent = ` @${String(name || "").replace("collections/", "")}`;
                contentSpan.appendChild(originBadge);

                row.appendChild(leftDiv);
                row.onclick = async (e) => {
                    if (e.target.closest(".rs-delete-icon")) return;
                    fillFromEntry({ text });
                };
                box.appendChild(row);
            });

            presetListBody.appendChild(box);
        }

        function updateCollectionTail() {
            const old = presetListBody.querySelector(".rs-load-more-item, .rs-list-end-item, .rs-match-note");
            if (old) old.remove();
            if (!collectionView) return;
            if (collectionView.shown < collectionView.total) {
                const more = mkEl("div", "rs-preset-item rs-load-more-item");
                more.textContent = tf("加载更多（已显示 {shown} / {total}）", { shown: collectionView.shown, total: collectionView.total });
                more.onclick = () => appendCollectionPage();
                presetListBody.appendChild(more);
            } else if (collectionView.total) {
                const end = mkEl("div", "rs-loading rs-list-end-item");
                end.textContent = tf("共 {n} 条", { n: collectionView.total });
                presetListBody.appendChild(end);
            }
        }

        async function appendCollectionPage() {
            if (!collectionView) return;
            const view = collectionView;
            const loadingDiv = mkEl("div", "rs-loading");
            loadingDiv.textContent = "Loading...";
            presetListBody.appendChild(loadingDiv);
            try {
                const data = await listPromptLines(view.name, view.shown, COLLECTION_PAGE_LIMIT, view.query, view.source);
                if (collectionView !== view) return; // 视图已切换，丢弃过期页
                if (loadingDiv.parentNode) loadingDiv.remove();
                view.total = data.total;
                view.shown += data.titles.length;
                applyCollectionRows(data.titles.map((t, i) => ({ title: t, text: data.texts[i] || "" })));
                updateCollectionTail();
            } catch (e) {
                if (loadingDiv.parentNode) loadingDiv.remove();
                presetListBody.textContent = "Error loading";
            }
        }

        async function openCollection(name, source) {
            presetNameInput.style.display = "none";
            deleteConfirmOverlay.style.display = "none";

            collectionView = { name, source, total: 0, shown: 0, query: "" };
            presetSearchBar.value = "";
            presetListOverlay.style.display = "flex";
            placePresetOverlay();
            presetSearchBar.focus();
            isListOpen = true;

            presetListBody.innerHTML = "";
            presetListBody.appendChild(buildCollectionBackRow());
            await appendCollectionPage();
        }

        saveBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            handleSaveClick();
        }, true);

        // 过滤便签：切换后回到文件级列表并按新分类重载（集合视图与搜索词一并清空）
        presetTabBar.addEventListener("click", (e) => {
            const tab = e.target.closest(".rs-preset-tab");
            if (!tab || tab.dataset.key === filterTab) return;
            filterTab = tab.dataset.key;
            saveFilterTab(filterTab);
            renderFilterTabs();
            presetSearchBar.value = "";
            clearCollectionViewState();
            loadPresetDropdown();
        });

        // Preset list search bar - 文件级列表本地过滤；集合视图改为服务端标题检索（防抖）
        presetSearchBar.addEventListener("input", () => {
            if (!collectionView) {
                const query = presetSearchBar.value.trim();
                const qLower = query.toLowerCase();
                const items = presetListBody.querySelectorAll(":scope > .rs-preset-item");
                items.forEach(item => {
                    const name = (item.querySelector(".rs-preset-content")?.textContent || "").toLowerCase();
                    item.style.display = !qLower || name.includes(qLower) ? "" : "none";
                });
                clearTimeout(collectionSearchTimer);
                if (!qLower) {
                    const oldMatches = presetListBody.querySelector(".rs-collection-matches");
                    if (oldMatches) oldMatches.remove();
                    return;
                }
                // 文件名过滤的同时，跨全部集合做标题聚合检索
                collectionSearchTimer = setTimeout(async () => {
                    const seq = ++collectionSearchSeq;
                    let data;
                    try {
                        data = await listPromptLines("*", 0, COLLECTION_PAGE_LIMIT, query, "custom");
                    } catch (e) {
                        return;
                    }
                    if (seq !== collectionSearchSeq || collectionView) return; // 输入已更新或已进入集合视图，丢弃过期结果
                    renderCollectionMatches(data.total,
                        data.titles.map((t, i) => ({ title: t, text: data.texts[i] || "", name: data.names[i], source: data.sources[i] })));
                }, 200);
                return;
            }

            clearTimeout(collectionSearchTimer);
            collectionSearchTimer = setTimeout(async () => {
                const view = collectionView;
                if (!view) return;
                const query = presetSearchBar.value.trim();
                view.query = query;
                view.total = 0;
                view.shown = 0;

                presetListBody.innerHTML = "";
                presetListBody.appendChild(buildCollectionBackRow());
                try {
                    const data = await listPromptLines(view.name, 0, COLLECTION_PAGE_LIMIT, query, view.source);
                    if (collectionView !== view) return; // 视图已切换，丢弃过期结果
                    view.total = data.total;
                    view.shown = data.titles.length;
                    applyCollectionRows(data.titles.map((t, i) => ({ title: t, text: data.texts[i] || "" })));
                    updateCollectionTail();
                    if (query && view.shown < view.total) {
                        const note = mkEl("div", "rs-loading rs-match-note");
                        note.textContent = tf("仅显示前 {n} 条匹配，可继续输入缩小范围", { n: COLLECTION_PAGE_LIMIT });
                        const more = presetListBody.querySelector(".rs-load-more-item");
                        if (more) presetListBody.insertBefore(note, more);
                        else presetListBody.appendChild(note);
                    }
                } catch (e) {
                    presetListBody.textContent = "Error loading";
                }
            }, 200);
        });

        listBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (presetListOverlay.style.display === "flex") {
                presetListOverlay.style.display = "none";
                isListOpen = false;
                hidePresetPreview();
                presetActiveIndex = -1;
            } else {
                clearCollectionViewState();
                loadPresetDropdown();
                presetListOverlay.style.display = "flex";
                placePresetOverlay();
                presetSearchBar.focus();
                isListOpen = true;
            }
        });

        const closePresetListOnOutside = (e) => {
            // 节点被移除后浮层已脱离 DOM，顺手注销自己，避免残留监听器越积越多
            if (!presetListOverlay.isConnected) {
                document.removeEventListener("mousedown", closePresetListOnOutside);
                return;
            }
            if (!promptOutput.actionGroupEl.contains(e.target) && !presetListOverlay.contains(e.target)) {
                presetListOverlay.style.display = "none";
                isListOpen = false;
                clearCollectionViewState();
                hidePresetPreview();
                presetActiveIndex = -1;
            }
        };
        document.addEventListener("mousedown", closePresetListOnOutside);

        inputOk.addEventListener("click", performSave);
        inputRecipeOk.addEventListener("click", performRecipeSave);
        inputCancel.addEventListener("click", () => {
            presetNameInput.style.display = "none";
        });
        inputField.addEventListener("keydown", (e) => {
            if (e.key === "Enter") performSave();
            if (e.key === "Escape") presetNameInput.style.display = "none";
        });

        deleteOk.addEventListener("click", async () => {
            if (pendingDeleteName) {
                if (pendingDeleteIsRecipe) await deleteRecipe(pendingDeleteName);
                else await deletePrompt(pendingDeleteName);
                deleteConfirmOverlay.style.display = "none";
                if (!quickInput.value.trim()) {
                    loadPresetDropdown();
                }
                pendingDeleteName = null;
                pendingDeleteIsRecipe = false;
            }
        });

        deleteCancel.addEventListener("click", () => {
            deleteConfirmOverlay.style.display = "none";
            pendingDeleteName = null;
            pendingDeleteIsRecipe = false;
        });

        return {
            statusBar,
            quickInputWrapper,
            generateBtn,
            randomBtn,
            listBtn,
            quickInput,
            customTextarea,
            refreshMarkdownPreviewAuto: promptOutput.refreshMarkdownPreviewAuto,
            genResultsController: promptOutput.genResultsController,
            toggleSwitch,
            localTab,
            externalTab,
            saveBtn,
            presetListOverlay,
            presetNameInput,
            deleteConfirmOverlay,
            skillSelector,
            populateSkillSelector,
            autoGenerateCheckbox,
            thinkingDepthSelect,
            attachedImages,
            clearImages
        };
    }

    return {
        root,
        init
    };
}

export {
    createPromptManagerUI
};
