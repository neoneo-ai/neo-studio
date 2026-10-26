/**
 * llm-chat.js
 * LLM 聊天域：快捷输入框、工具条、skill 下拉、附加图片 chips、提示语轮播，
 * 以及提示词输出区（textarea + Markdown 预览 + 清空 + 多轮技能提示）与 SSE 生成流程。
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { fileToBase64, imagesFromClipboard, sseStream, invokePromptStream, createStreamOutputHandlers } from "./prompt-service.js";
import { listSkills, populateSkillOptions, createSkillDropdown, renderMarkdown, resolveSkillId, openSkillDetailById, CATEGORY_LABELS, skillDisplayName } from "./skill.js";
import { createModelConfigForm, openLLMSettingsModal } from "./llm-setting.js";
import { mkEl } from "./dom-utils.js";
import { icon } from "./js/core/icons.js";
import { collectWorkflowContext } from "./workflow-context.js";
import { saveTextToStorage, markQuickInputConsumed } from "./node-behavior.js";
import { createAtImagePicker } from "./at-picker.js";
import { createSlashSkillPicker } from "./slash-picker.js";
import { createImageGenSettingsForm, createVideoGenSettingsForm, requestGeneration, watchTask, cancelTask, buildGenPrompt, sendImageToLoadImage, assembleAllGenerated, enhancePromptStream, getGenSettings, getSkillGenConfig } from "./image-gen.js";
import { Lightbox } from "./lightbox.js";
import { showToast } from "./gallery-utils.js";
import { actionToast } from "./toast.js";
import { t, tf } from "./js/core/i18n.js";

// 「思考深度」下拉 → Qwen3.8 模板参数映射：off=不思考（enable_thinking:false）；
// low/medium/high 对应 chat_template_kwargs.reasoning_effort 档位（xhigh 为模板的深度档）。
const THINKING_EFFORTS = { low: "low", medium: "medium", high: "xhigh" };

// LLM 自身异常的报文特征（llm.py 的 Remote LLM network error / timeout / HTTP <code>、
// "LLM model not found" / "Model not loaded"、provider 的 openai 报错 "Error code: 401"、
// 缺 API key 提示等）。端点 / 密钥 / 模型 / 网络问题换 skill 也没用 → 一律给 LLM 设置。
const LLM_ERROR_PATTERN = /remote llm|remote provider|remote_llm_config|local model|llm model|model not loaded|api key|unauthorized|rate limit|insufficient_quota|timeout|timed out|network error|connection (error|refused)|econnrefused|fetch failed|error code:|http [45]\d\d/i;

function isLLMError(err) {
    return LLM_ERROR_PATTERN.test(String(err || ""));
}

// 失败提示入口：LLM 异常 → LLM 设置；否则选了 skill → 技能详情页修复；都没命中（智能/反推路由）→ LLM 设置。
// actionToast 不自动关闭，点 action 或 ✕ 才消失。
function failAction(skillId, err) {
    if (skillId && !isLLMError(err)) {
        return { summary: t("技能执行失败"), actionLabel: t("打开技能详情"), onAction: () => openSkillDetailById(skillId) };
    }
    return { summary: t("LLM 处理失败"), actionLabel: t("打开 LLM 设置"), onAction: openLLMSettingsModal };
}

// ==========================================
// Quick input tips rotation
// ==========================================

const QUICK_INPUT_TIPS = [
    t("输入描述，AI 自动帮你生成提示词"),
    t("输入改写需求，如：'去掉动漫风格，改成写实'"),
    t("输入翻译需求，如：'翻译成中文'"),
    t("输入风格要求，如：'改成赛博朋克风格'"),
    t("输入场景描述，如：'夕阳下的海边日落'"),
    t("输入关键词搜索已有提示词"),
    t("输入描述后按 Enter 生成，Shift+Enter 换行"),
    t("按 ↑/↓ 召回之前生成用过的输入"),
    t("输入修改指令，如：'增加细节描述'"),
    t("输入角色描述，如：'一个穿着汉服的女孩'"),
    t("输入时间场景，如：'清晨的森林，阳光穿透树叶'"),
    t("输入城市描述，如：'未来科幻城市，高楼林立'"),
    t("点击保存按钮将提示词存为预设"),
    t("▾ 自动增强菜单内配置 LLM，管理技能/模板")
];

function getRandomTip() {
    return QUICK_INPUT_TIPS[Math.floor(Math.random() * QUICK_INPUT_TIPS.length)];
}

// ==========================================
// Status bars with toggle, skill selector, action buttons
// ==========================================

function createStatusBars() {
    const statusBar = mkEl("div", "rs-status-bar");
    
    const toggleWrapper = mkEl("div", "rs-toggle-wrapper");
    
    // Tab-style toggle with text labels
    const toggleSwitch = mkEl("div", "rs-toggle-switch");
    toggleSwitch.setAttribute("data-rs-tooltip", "Switch between local prompt and external input");
    
    const localTab = mkEl("div", "rs-toggle-tab rs-toggle-local");
    localTab.textContent = "LOCAL";
    localTab.dataset.state = "local";
    
    const externalTab = mkEl("div", "rs-toggle-tab rs-toggle-external");
    externalTab.textContent = "EXTERNAL";
    externalTab.dataset.state = "external";
    
    toggleSwitch.appendChild(localTab);
    toggleSwitch.appendChild(externalTab);
    toggleWrapper.appendChild(toggleSwitch);
    
    // Skill selector dropdown (tasks + presets + image skills)
    // 组装（原生 select 数据源 + 可搜索下拉 + 底部管理工具栏 + 行内操作）已收敛到 skill.js 的
    // createSkillDropdown()；可见 UI 是返回的 combo.box（select 被移入其中），工具栏须挂载 box。
    const { selectEl: skillSelector, combo: skillCombo } = createSkillDropdown();

    // 附加图片 chips 容器 + 图片选择按钮（用于反推等 vision skill）
    const imageChipsRow = mkEl("div", "rs-image-chips");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    const attachedImages = []; // [{data: dataURI, name: string}]

    // 图片增删后通知（init 时由 node 绑定后设置）：把当前 @引用/本地上传图推送暂存，
    // 使"添加参考图"不依赖点击生成即可进入 bundle.references。
    let _attachedChangeListener = null;
    function setAttachedChangeListener(fn) { _attachedChangeListener = fn; }
    function notifyAttachedChange() { if (_attachedChangeListener) _attachedChangeListener(attachedImages); }

    function addImageFile(file) {
        return fileToBase64(file).then(img => {
            attachedImages.push(img);
            renderImageChips();
            notifyAttachedChange();
            return img;
        }).catch(e => console.error("Failed to read image:", e));
    }

    // 悬停放大预览：单例元素挂在 body 上（fixed 定位），避免被节点 overflow 裁剪
    let imageHoverPreview = null;

    function showImageHoverPreview(src, anchorEl) {
        if (!imageHoverPreview) {
            imageHoverPreview = mkEl("img", "rs-image-hover-preview");
            document.body.appendChild(imageHoverPreview);
        }
        // 预览最大尺寸跟随画布缩放比率，保持与节点内容的视觉大小一致
        const canvasScale = app?.canvas?.ds?.scale || 1;
        const scale = Math.max(0.4, Math.min(canvasScale, 2.5));
        const maxW = 320 * scale;
        const maxH = 320 * scale;
        imageHoverPreview.style.maxWidth = maxW + "px";
        imageHoverPreview.style.maxHeight = maxH + "px";

        const r = anchorEl.getBoundingClientRect();
        // 按图片实际显示尺寸（保持宽高比）定位，避免横向/纵向图片偏离缩略图太远
        const positionPreview = () => {
            if (imageHoverPreview.style.display !== "block") return;
            const nw = imageHoverPreview.naturalWidth || maxW;
            const nh = imageHoverPreview.naturalHeight || maxH;
            const k = Math.min(1, maxW / nw, maxH / nh); // 不放大，仅按需缩小
            const dispW = nw * k;
            const dispH = nh * k;
            let left = r.left + r.width / 2 - dispW / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - dispW - 8));
            let top = r.top - dispH - 10; // 默认显示在缩略图上方
            if (top < 8) top = r.bottom + 10; // 放不下则翻到下方
            imageHoverPreview.style.left = left + "px";
            imageHoverPreview.style.top = top + "px";
        };
        imageHoverPreview.onload = positionPreview;
        imageHoverPreview.src = src;
        imageHoverPreview.style.display = "block";
        // 缓存命中时 onload 不触发，complete 时立即定位
        if (imageHoverPreview.complete && imageHoverPreview.naturalWidth) {
            positionPreview();
        }
    }

    function hideImageHoverPreview() {
        if (imageHoverPreview) imageHoverPreview.style.display = "none";
    }

    function renderImageChips() {
        imageChipsRow.innerHTML = "";
        attachedImages.forEach((img, idx) => {
            const chip = mkEl("span", "rs-image-chip");

            const thumb = document.createElement("img");
            thumb.src = img.input ? inputViewUrl(img.input) : img.data;
            thumb.alt = `Image ${idx + 1}`;
            thumb.className = "rs-image-chip-thumb";
            // 悬停放大预览
            thumb.addEventListener("mouseenter", () => showImageHoverPreview(thumb.src, chip));
            thumb.addEventListener("mouseleave", hideImageHoverPreview);

            // 顺序编号 badge：显示该图的参数位 <Picture N>；无参数位（反推附件）不显示编号
            const controls = mkEl("span", "rs-image-controls");

            if (img.pictureNo != null) {
                const orderBadge = mkEl("span", "rs-image-order-badge");
                orderBadge.textContent = `${img.pictureNo}`;
                controls.appendChild(orderBadge);
            }

            // 删除按钮
            const del = document.createElement("button");
            del.type = "button";
            del.textContent = "✕";
            del.className = "rs-image-chip-del";
            del.title = t("移除图片");
            del.addEventListener("click", () => {
                attachedImages.splice(idx, 1);
                renderImageChips();
                notifyAttachedChange();
            });

            controls.appendChild(del);
            chip.appendChild(thumb);
            chip.appendChild(controls);
            imageChipsRow.appendChild(chip);
        });
    }

    function clearImages() {
        attachedImages.length = 0;
        renderImageChips();
        notifyAttachedChange();
    }

    // input 目录图片的缩略图地址（ComfyUI /view 端点）
    function inputViewUrl(value) {
        const v = String(value).trim().replace(/\[[^\]]*\]$/, "");
        const i = v.lastIndexOf("/");
        const fname = i >= 0 ? v.slice(i + 1) : v;
        const sub = i >= 0 ? v.slice(0, i) : "";
        return `/view?filename=${encodeURIComponent(fname)}&subfolder=${encodeURIComponent(sub)}&type=input`;
    }

    // 图片判重键：去掉 [input]/[output] 标注并归一化
    function imageKey(value) {
        return String(value || "").replace(/\[[^\]]*\]\s*$/, "").trim();
    }

    // 以文件名形式附加图片（出队时由后端从 input/output 目录解析，无需连线）。
    // 判重：同一图片已附加则忽略，避免重复 chip / 编号错乱。
    // pictureNo：目标节点 IMAGE 输入参数序号；未连接的图片为 undefined（仅作反推附件）。
    function addImageInput(value, name, pictureNo) {
        const key = imageKey(value);
        if (!key) return;
        const dup = attachedImages.some(img => imageKey(img.input) === key);
        if (dup) return;
        attachedImages.push({ name: name || key.split("/").pop(), input: value, pictureNo });
        renderImageChips();
        notifyAttachedChange();
    }

    // 图片选择按钮（+）
    const attachBtn = mkEl("button", "rs-attach-btn");
    attachBtn.textContent = "+";
    attachBtn.title = t("附加图片（反推/多模态 skill）");
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
        Array.from(fileInput.files || []).forEach(addImageFile);
        fileInput.value = "";
    });

    // debounce: per-node timer to avoid duplicate calls from multiple init paths
    const _populateTimer = new Map();

    async function populateSkillSelector(startNode = null) {
        const node = startNode;
        if (node && _populateTimer.has(node.id)) {
            clearTimeout(_populateTimer.get(node.id));
        }
        return new Promise(resolve => {
            _populateTimer.set(node.id, setTimeout(() => {
                _populateTimer.delete(node.id);
                Promise.resolve(doPopulate()).then(resolve, resolve);
            }, 50));
        });
    }

    async function doPopulate() {
        const skills = await listSkills();
        const currentVal = skillSelector.value;
        skillSelector.innerHTML = "";

        const defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = t("默认");
        skillSelector.appendChild(defaultOpt);

        // 带 workflow.json 的技能由工作流驱动、正文不参与本节点 → 不出现在提示词代理下拉里
        populateSkillOptions(skillSelector, skills.filter(s => !s.has_workflow));

        if (currentVal && Array.from(skillSelector.options).some(o => o.value === currentVal)) {
            skillSelector.value = currentVal;
        }

        // Programmatic value assignment does not fire change events; dispatch one so
        // node listeners persist the selected skill (rs_selected_skill) after repopulation.
        skillSelector.dispatchEvent(new Event("change"));
    }
    
    statusBar.appendChild(toggleWrapper);

    const randomBtn = mkEl("button", "rs-random-btn");
    randomBtn.textContent = "";
    randomBtn.setAttribute("data-rs-tooltip", "Random prompt");

    // 主点击=立即随机填入；▾ 展开运行时随机的运行期配置菜单
    // （勾选状态由 NodeBehaviors.wireRuntimeRandom 接线持久化到 properties 与隐藏控件）
    const randomWrap = mkEl("div", "rs-random-wrap");
    const randomCaret = mkEl("button", "rs-random-caret");
    randomCaret.type = "button";
    randomCaret.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    randomCaret.setAttribute("data-rs-tooltip", "Runtime random options");
    const runtimeMenu = mkEl("div", "rs-runtime-menu");
    // 挂到 body 用 fixed 定位：留在节点 DOM widget 内会被节点边界裁剪（同 combo-box 列表与预设列表浮层策略）
    document.body.appendChild(runtimeMenu);
    const runtimeToggleRow = mkEl("label", "rs-runtime-row rs-runtime-toggle");
    const runtimeCheckbox = mkEl("input", "rs-auto-generate-checkbox");
    runtimeCheckbox.type = "checkbox";
    const runtimeToggleText = mkEl("span", "rs-runtime-row-text");
    runtimeToggleText.textContent = t("运行时随机抽取提示词");
    runtimeToggleRow.appendChild(runtimeCheckbox);
    runtimeToggleRow.appendChild(runtimeToggleText);
    const runtimeCountRow = mkEl("div", "rs-runtime-row");
    const runtimeCountText = mkEl("span", "rs-runtime-row-text");
    runtimeCountText.textContent = t("每次抽取");
    const runtimeCountMinus = mkEl("button", "rs-runtime-count-btn");
    runtimeCountMinus.type = "button";
    runtimeCountMinus.textContent = "−";
    const runtimeCountVal = mkEl("span", "rs-runtime-count-val");
    runtimeCountVal.textContent = "1";
    const runtimeCountPlus = mkEl("button", "rs-runtime-count-btn");
    runtimeCountPlus.type = "button";
    runtimeCountPlus.textContent = "+";
    runtimeCountRow.appendChild(runtimeCountText);
    runtimeCountRow.appendChild(runtimeCountMinus);
    runtimeCountRow.appendChild(runtimeCountVal);
    runtimeCountRow.appendChild(runtimeCountPlus);
    runtimeMenu.appendChild(runtimeToggleRow);
    runtimeMenu.appendChild(runtimeCountRow);
    randomWrap.appendChild(randomBtn);
    randomWrap.appendChild(randomCaret);
    let runtimeMenuOpen = false;
    const closeRuntimeMenu = () => {
        runtimeMenuOpen = false;
        runtimeMenu.style.display = "none";
    };
    const openRuntimeMenu = () => {
        runtimeMenu.style.display = "block";
        const r = randomCaret.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = runtimeMenu.offsetWidth || 220, h = runtimeMenu.offsetHeight || 110;
        let left = Math.min(Math.max(8, r.right - w), vw - 8 - w);
        let top = r.bottom + 4;
        if (top + h > vh - 8) top = Math.max(8, r.top - h - 4);
        runtimeMenu.style.left = left + "px";
        runtimeMenu.style.top = top + "px";
        runtimeMenuOpen = true;
    };
    randomCaret.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        runtimeMenuOpen ? closeRuntimeMenu() : openRuntimeMenu();
    });
    // 捕获阶段监听外部按下：画布等区域的指针事件会被上游全局处理器 stopPropagation，
    // 冒泡阶段根本到不了 document；捕获阶段在最前面执行不受影响。
    // （同一处理挂 pointerdown 与 mousedown 双保险，第二次触发时已关闭会直接返回）
    const onDocPointerDown = (e) => {
        if (!runtimeMenuOpen) return;
        if (randomWrap.contains(e.target) || runtimeMenu.contains(e.target)) return;
        closeRuntimeMenu();
    };
    const onRuntimeMenuKey = (e) => {
        if (e.key === "Escape" && runtimeMenuOpen) closeRuntimeMenu();
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("mousedown", onDocPointerDown, true);
    document.addEventListener("keydown", onRuntimeMenuKey);
    randomBtn._rsRuntime = {
        checkbox: runtimeCheckbox, countRow: runtimeCountRow, minusBtn: runtimeCountMinus, plusBtn: runtimeCountPlus, valueSpan: runtimeCountVal, wrap: randomWrap,
        destroy: () => {
            document.removeEventListener("pointerdown", onDocPointerDown, true);
            document.removeEventListener("mousedown", onDocPointerDown, true);
            document.removeEventListener("keydown", onRuntimeMenuKey);
            runtimeMenu.remove();
        }
    };

    const listBtn = mkEl("button", "rs-list-btn");
    listBtn.textContent = "☰";
    listBtn.setAttribute("data-rs-tooltip", "Preset list");

    const quickInputWrapper = mkEl("div", "rs-quick-input-wrapper");

    // Note: randomBtn, listBtn are NOT added to quickInputWrapper here.
    // They will be placed in topRightBtnGroup by createPromptManagerUI().

    const quickInput = document.createElement("textarea");
    quickInput.className = "rs-quick-input";
    quickInput.placeholder = 'Describe what you want... (Enter to generate, Shift+Enter for newline)';
    quickInput.rows = 2;

    let tipInterval = null;

    function startTipRotation() {
        stopTipRotation();
        tipInterval = setInterval(() => {
            if (!quickInput.value.trim()) {
                quickInput.placeholder = getRandomTip();
            }
        }, 5000);
    }

    function stopTipRotation() {
        if (tipInterval) {
            clearInterval(tipInterval);
            tipInterval = null;
        }
    }

    quickInput.addEventListener("focus", () => {
        quickInput.placeholder = getRandomTip();
        startTipRotation();
    });

    quickInput.addEventListener("blur", () => {
        stopTipRotation();
        if (!quickInput.value.trim()) {
            quickInput.placeholder = getRandomTip();
        }
    });

    // Create input toolbar (chat-like experience)
    const inputToolbar = mkEl("div", "rs-input-toolbar");

    const generateBtn = mkEl("button", "rs-generate-btn");
    generateBtn.replaceChildren(icon("sparkles", 16));
    generateBtn.setAttribute("data-rs-tooltip", "Generate from description");

    // Auto-generate 复选框并入 的 ▾ 菜单（参照骰子菜单交互）：
    // 主点击=立即生成；▾ 展开"运行时自动增强"开关。保留原 checkbox 元素身份，
    // 使 prompts.js 既有接线（恢复/持久化/rs_auto_generate 事件）零改动。
    const autoGenerateCheckbox = document.createElement("input");
    autoGenerateCheckbox.type = "checkbox";
    autoGenerateCheckbox.className = "rs-auto-generate-checkbox";
    autoGenerateCheckbox.id = "rs-auto-generate";
    const autoGenerateLabel = document.createElement("label");
    autoGenerateLabel.htmlFor = "rs-auto-generate";
    autoGenerateLabel.className = "rs-auto-generate-label";
    autoGenerateLabel.textContent = t("工作流运行时自动增强");

    const genCaret = mkEl("button", "rs-random-caret");
    genCaret.type = "button";
    genCaret.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    genCaret.setAttribute("data-rs-tooltip", "Auto-enhance options");
    const autoMenu = mkEl("div", "rs-runtime-menu rs-auto-config");
    document.body.appendChild(autoMenu); // 挂 body 防节点边界裁剪
    // 右上角关闭按钮：与点外部/再点 caret 同一条关闭路径（有未保存修改时先出确认条）
    const autoCloseBtn = mkEl("button", "rs-auto-close");
    autoCloseBtn.type = "button";
    autoCloseBtn.textContent = "✕";
    autoCloseBtn.setAttribute("data-rs-tooltip", t("关闭设置"));
    autoMenu.appendChild(autoCloseBtn);
    const autoToggleRow = mkEl("label", "rs-runtime-row rs-runtime-toggle");
    autoToggleRow.appendChild(autoGenerateCheckbox);
    autoToggleRow.appendChild(autoGenerateLabel);
    autoMenu.appendChild(autoToggleRow);

    // 「思考深度」下拉：参考 Qwen3.8 的 reasoning_effort 档位。默认"标准思考"（medium）；
    // "不思考"发 enable_thinking:false（跳过推理，更快更稳，避免思考耗尽 max_tokens 截断正文）；
    // 浅/标准/深度经 chat_template_kwargs.reasoning_effort 传给服务端，不支持该字段的服务端会忽略。
    // localStorage 持久化。
    const thinkingDepthSelect = document.createElement("select");
    thinkingDepthSelect.className = "rs-thinking-depth-select";
    for (const [value, label] of [["off", t("不思考")], ["low", t("浅思考")], ["medium", t("标准思考")], ["high", t("深度思考")]]) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        if (value === "medium") opt.selected = true; // 默认档
        thinkingDepthSelect.appendChild(opt);
    }
    try {
        const savedDepth = localStorage.getItem("rs.thinking_depth");
        if (savedDepth && ["off", "low", "medium", "high"].includes(savedDepth)) {
            thinkingDepthSelect.value = savedDepth;
        }
    } catch (e) { /* 隐私模式下 localStorage 可能不可用 */ }
    const thinkingDepthLabel = mkEl("span", "rs-auto-generate-label");
    thinkingDepthLabel.textContent = t("思考深度");
    const thinkingDepthRow = mkEl("div", "rs-runtime-row");
    thinkingDepthRow.appendChild(thinkingDepthLabel);
    thinkingDepthRow.appendChild(thinkingDepthSelect);
    const thinkingDepthHint = mkEl("div", "rs-runtime-hint");
    thinkingDepthHint.textContent = t("默认标准思考；不思考直接输出，更快更稳（需服务端支持）");
    autoMenu.appendChild(thinkingDepthRow);
    autoMenu.appendChild(thinkingDepthHint);
    thinkingDepthSelect.addEventListener("change", (e) => {
        e.stopPropagation();
        try { localStorage.setItem("rs.thinking_depth", thinkingDepthSelect.value); } catch (err) {}
    });
    // 设置区 tab 切换：LLM Settings / 生图设置（两张表单都较长，纵向堆叠菜单过深；
    // 打开时两个表单都 load、关闭时都 save，隐藏面板的输入值照常读写，切 tab 不丢状态）
    const modelForm = createModelConfigForm();
    const genForm = createImageGenSettingsForm();
    const videoForm = createVideoGenSettingsForm();
    const autoDivider = mkEl("div", "rs-runtime-divider");
    const autoTabs = mkEl("div", "rs-auto-tabs");
    const llmTabBtn = mkEl("button", "rs-auto-tab rs-auto-tab-active");
    llmTabBtn.type = "button";
    llmTabBtn.textContent = "LLM Settings";
    const genTabBtn = mkEl("button", "rs-auto-tab");
    genTabBtn.type = "button";
    genTabBtn.textContent = t("生图默认设置");
    const videoTabBtn = mkEl("button", "rs-auto-tab");
    videoTabBtn.type = "button";
    videoTabBtn.textContent = t("生视频模型");
    autoTabs.append(llmTabBtn, genTabBtn, videoTabBtn);
    const llmPanel = mkEl("div", "rs-auto-panel");
    llmPanel.appendChild(modelForm.el);
    const genPanel = mkEl("div", "rs-auto-panel");
    genPanel.style.display = "none";
    genPanel.appendChild(genForm.el);
    const videoPanel = mkEl("div", "rs-auto-panel");
    videoPanel.style.display = "none";
    videoPanel.appendChild(videoForm.el);
    const setAutoTab = (which) => {
        llmTabBtn.classList.toggle("rs-auto-tab-active", which === "llm");
        genTabBtn.classList.toggle("rs-auto-tab-active", which === "gen");
        videoTabBtn.classList.toggle("rs-auto-tab-active", which === "video");
        llmPanel.style.display = which === "llm" ? "" : "none";
        genPanel.style.display = which === "gen" ? "" : "none";
        videoPanel.style.display = which === "video" ? "" : "none";
    };
    llmTabBtn.addEventListener("click", () => setAutoTab("llm"));
    genTabBtn.addEventListener("click", () => setAutoTab("gen"));
    videoTabBtn.addEventListener("click", () => setAutoTab("video"));
    autoMenu.appendChild(autoDivider);
    autoMenu.appendChild(autoTabs);
    autoMenu.appendChild(llmPanel);
    autoMenu.appendChild(genPanel);
    autoMenu.appendChild(videoPanel);
    const autoWrap = mkEl("div", "rs-auto-wrap");
    autoWrap.appendChild(generateBtn);
    autoWrap.appendChild(genCaret);

    // 未保存修改确认条：挂在 autoMenu 内随菜单显隐；点菜单外/按 Esc 视为"继续编辑"
    const dirtyConfirm = mkEl("div", "rs-gen-dirty-confirm");
    dirtyConfirm.hidden = true;
    const dirtyText = mkEl("span", "rs-gen-dirty-text");
    dirtyText.textContent = t("有未保存的修改");
    const dirtyActions = mkEl("div", "rs-gen-dirty-actions");
    const btnSaveClose = mkEl("button", "rs-btn rs-gen-dirty-save");
    btnSaveClose.type = "button";
    btnSaveClose.textContent = t("保存并关闭");
    const btnDiscard = mkEl("button", "rs-btn rs-gen-dirty-discard");
    btnDiscard.type = "button";
    btnDiscard.textContent = t("放弃修改");
    const btnKeepEditing = mkEl("button", "rs-btn rs-gen-dirty-keep");
    btnKeepEditing.type = "button";
    btnKeepEditing.textContent = t("继续编辑");
    dirtyActions.append(btnSaveClose, btnDiscard, btnKeepEditing);
    dirtyConfirm.append(dirtyText, dirtyActions);
    autoMenu.appendChild(dirtyConfirm);

    let autoMenuOpen = false;
    let confirmShown = false;
    // 两表单 load() 全部落定后才放行脏检查：初始化回填结束前不会有用户改动，
    // 期间关闭直接走 performClose；seq 防止上一轮慢加载晚到误标当前轮已就绪
    let autoMenuReady = false;
    let autoMenuLoadSeq = 0;
    const hideConfirm = () => { confirmShown = false; dirtyConfirm.hidden = true; };
    const performClose = () => {
        hideConfirm();
        autoMenuOpen = false;
        autoMenu.style.display = "none";
    };
    const closeAutoMenu = () => {
        if (!autoMenuOpen) return;
        if (!autoMenuReady) { performClose(); return; } // 初始化未完成：无用户改动可确认
        if (modelForm.isDirty() || genForm.isDirty() || videoForm.isDirty()) {
            confirmShown = true;
            dirtyConfirm.hidden = false;
            return; // 有未保存修改：暂停关闭，等用户在确认条里选择
        }
        performClose();
    };
    const openAutoMenu = () => {
        autoMenu.style.display = "block";
        const r = genCaret.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = autoMenu.offsetWidth || 220, h = autoMenu.offsetHeight || 110;
        let left = Math.min(Math.max(8, r.right - w), vw - 8 - w);
        let top = r.bottom + 4;
        if (top + h > vh - 8) top = Math.max(8, r.top - h - 4);
        autoMenu.style.left = left + "px";
        autoMenu.style.top = top + "px";
        hideConfirm();
        // 打开即后台回填；等两表单 load 全部落定（含模型列表拉取）后才放行脏检查，
        // 避免初始化收尾阶段的程序化改动被误判为未保存修改
        autoMenuReady = false;
        const seq = ++autoMenuLoadSeq;
        Promise.all([modelForm.load(), genForm.load(), videoForm.load()])
            .catch(() => {}) // 单侧 load 失败不阻断就绪标记（表单内部已兜底记录）
            .then(() => { if (seq === autoMenuLoadSeq) autoMenuReady = true; });
        autoMenuOpen = true;
    };
    btnSaveClose.addEventListener("click", async () => {
        btnSaveClose.disabled = true;
        const [genOk, llmOk, videoOk] = await Promise.all([genForm.save(), modelForm.save(), videoForm.save()]);
        if (genOk && llmOk && videoOk) performClose();
        else showToast(app, "error", t("保存失败"), t("请重试后再关闭"));
        btnSaveClose.disabled = false;
    });
    btnDiscard.addEventListener("click", () => performClose());
    btnKeepEditing.addEventListener("click", () => hideConfirm());
    genCaret.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        autoMenuOpen ? closeAutoMenu() : openAutoMenu();
    });
    autoCloseBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // 防冒泡进全局关浮层/事件处理器
        closeAutoMenu();
    });
    // 捕获阶段外关，规避上游全局处理器 stopPropagation（同骰子菜单）
    const onAutoDocPointerDown = (e) => {
        if (!autoMenuOpen) return;
        if (autoWrap.contains(e.target) || autoMenu.contains(e.target)) return;
        if (e.target.closest && e.target.closest(".rs-combo-list")) return; // 模型下拉浮层挂在 body，点它不关菜单
        if (confirmShown) { hideConfirm(); return; } // 确认条显示时点外部 = 继续编辑
        closeAutoMenu();
    };
    const onAutoMenuKey = (e) => {
        if (e.key !== "Escape" || !autoMenuOpen) return;
        // Esc 恒为关闭：有未保存修改时直接放弃（同「放弃修改」），无修改则正常关
        performClose();
    };
    document.addEventListener("pointerdown", onAutoDocPointerDown, true);
    document.addEventListener("mousedown", onAutoDocPointerDown, true);
    document.addEventListener("keydown", onAutoMenuKey);
    autoGenerateCheckbox._rsAutoMenu = {
        destroy: () => {
            document.removeEventListener("pointerdown", onAutoDocPointerDown, true);
            document.removeEventListener("mousedown", onAutoDocPointerDown, true);
            document.removeEventListener("keydown", onAutoMenuKey);
            autoMenu.remove();
        }
    };

    // 勾选自动增强 ⇄ 主按钮高亮：不做图标替换，仅切 class，由 CSS 画圆形边框/光晕（见 .rs-auto-enhance-active）
    const syncGenerateIcon = () => {
        generateBtn.classList.toggle("rs-auto-enhance-active", autoGenerateCheckbox.checked);
    };
    autoGenerateCheckbox.addEventListener("change", (e) => {
        e.stopPropagation(); // 防冒泡进全局关浮层/事件处理器
        syncGenerateIcon();
    });
    // 整行点击切换：外层与内层都是 <label>（label 不能嵌套，内层 htmlFor 激活不可靠），
    // 故直接监听行点击手动反转勾选；点到复选框本身时交给原生机
    autoToggleRow.addEventListener("click", (e) => {
        if (e.target === autoGenerateCheckbox) return;
        e.preventDefault();
        autoGenerateCheckbox.checked = !autoGenerateCheckbox.checked;
        autoGenerateCheckbox.dispatchEvent(new Event("change"));
    });

    // Add elements to toolbar
    const atPicker = createAtImagePicker({ quickInput, attachedImages, imageKey, addImageInput, inputViewUrl });
    const openAtImagePicker = atPicker.open;

    // @ 按钮：点击弹出图片选择器（含"全部"选项），无需在文本中输入 @
    const atBtn = mkEl("button", "rs-at-btn");
    atBtn.textContent = "@";
    atBtn.title = t("插入参考图片标记");
    atBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        atPicker.openFromButton(atBtn);
    });

    inputToolbar.appendChild(atBtn);
    inputToolbar.appendChild(attachBtn);
    inputToolbar.appendChild(skillCombo.box);
    const spacer = mkEl("div", "rs-spacer");
    inputToolbar.appendChild(spacer);
    inputToolbar.appendChild(autoWrap);

    // Add input and toolbar to wrapper
    quickInputWrapper.appendChild(imageChipsRow);
    quickInputWrapper.appendChild(quickInput);
    quickInputWrapper.appendChild(inputToolbar);
    quickInputWrapper.appendChild(fileInput);

    // 粘贴图片直接附加（反推）
    quickInput.addEventListener("paste", (e) => {
        const files = imagesFromClipboard(e);
        if (files.length) {
            e.preventDefault();
            files.forEach(addImageFile);
        }
    });

    // 拖拽图片到输入框附加
    quickInputWrapper.addEventListener("dragover", (e) => e.preventDefault());
    quickInputWrapper.addEventListener("drop", (e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
        files.forEach(addImageFile);
    });

    // 输入 / 唤起 skill 快捷菜单：随输入实时过滤，↑/↓ + Enter/Tab 提交（写入 skill 下拉），Esc 关闭
    // 分类口径在本页定：生视频 / 任务为内部使用技能不在菜单里出现（见 skill.js 的 CATEGORY_LABELS）
    const openSlashSkillPicker = createSlashSkillPicker({
        quickInput, skillSelector, listSkills,
        rowText: (s) => (s.needs_image ? "" : "") + skillDisplayName(s),
        categoryLabel: (s) => (CATEGORY_LABELS[s.category] || CATEGORY_LABELS.image_enhance).label,
        filter: (s) => !CATEGORY_LABELS[s.category]?.hidden,
        sort: (a, b) => ((CATEGORY_LABELS[a.category]?.order ?? 99) - (CATEGORY_LABELS[b.category]?.order ?? 99))
            || String(a.name || a.id).localeCompare(String(b.name || b.id)),
    });

    // 输入 @ 唤起工作流图片选择器、/ 唤起 skill 快捷菜单（均支持在文本中间插入：看光标前一个字符）
    quickInput.addEventListener("input", (e) => {
        const caret = quickInput.selectionStart;
        if (caret <= 0) return;
        const ch = quickInput.value[caret - 1];
        if (ch === "@") openAtImagePicker();
        else if (ch === "/") openSlashSkillPicker();
    });

    const customTextarea = document.createElement("textarea");
    customTextarea.className = "comfy-multiline-input";
    customTextarea.placeholder = "Enter your prompt here...";

    const buttonsWrapper = mkEl("div", "rs-buttons-wrapper");
    
    const actionRow = mkEl("div", "rs-btn-row rs-action-row");

    const saveBtn = mkEl("button", "rs-btn rs-action-btn");
    saveBtn.textContent = "";
    saveBtn.setAttribute("data-rs-tooltip", "Save as preset");

    // Note: saveBtn is NOT added to actionRow here.
    // It will be placed in topRightBtnGroup by createPromptManagerUI().
    buttonsWrapper.appendChild(actionRow);

    return { statusBar, quickInputWrapper, randomBtn, randomWrap, listBtn, quickInput, generateBtn, customTextarea, buttonsWrapper, saveBtn, toggleSwitch, localTab, externalTab, skillSelector, populateSkillSelector, actionRow, autoGenerateCheckbox, thinkingDepthSelect, attachedImages, addImageFile, clearImages, attachBtn, imageChipsRow, openAtImagePicker, setAttachedChangeListener };
}

// ==========================================
// LLM 生成：/ Enter 触发，三条流式分支共用同一 SSE 处理
// ==========================================
// 追踪节点 image 输入插槽的上游节点（如 LoadImage），取其图片文件名
// 返回 {kind:"input", value:"<filename>"}、{kind:"unresolved"}（图已连接但读不到文件名）或 null（未连接）
function resolveConnectedImageSource(node) {
    try {
        const slot = node.inputs?.find(i => /^image/i.test(i.name || ""));
        if (!slot || slot.link == null) return null;
        const links = node.graph?.links;
        const link = typeof links?.get === "function" ? links.get(slot.link) : links?.[slot.link];
        if (!link) return { kind: "unresolved" };
        const srcNode = node.graph.getNodeById(link.origin_id);
        if (!srcNode) return null;
        // 优先读实时 widget 值（换图立即生效）；widgets_values 仅在序列化时刷新，作为回退快照
        const candidates = [
            ...(srcNode.widgets || []).map(w => w?.value),
            ...(srcNode.widgets_values || []),
        ];
        // 图片项可能是字符串、数组(["name","sub","type"])或对象{name,...}
        for (const c of candidates) {
            let v = "";
            if (typeof c === "string") v = c.trim();
            else if (Array.isArray(c)) v = String(c[0] ?? "").trim();
            else if (c && typeof c === "object") v = String(c.name ?? c.filename ?? "").trim();
            if (v && /\.(png|jpe?g|webp|bmp|gif)$/i.test(v)) {
                return { kind: "input", value: v };
            }
        }
        console.warn("image input connected but no image filename found on upstream node:", srcNode.type);
        return { kind: "unresolved" };
    } catch (e) {
        console.warn("resolveConnectedImageSource failed:", e);
        return { kind: "unresolved" };
    }
}

// ==========================================
// Krea2 生图 skill：提交 → 事件等待 → 结果块（进度 / 取消 / 缩略图 / 发送装配）
// ==========================================

// 预览区只加载 640px 缩略图（复用 gallery thumbnail 缓存接口），原图留给灯箱按需加载
function genThumbSrc(image) {
    return `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail`
        + `?filename=${encodeURIComponent(image.filename)}`
        + `&subfolder=${encodeURIComponent(image.subfolder || "")}&size=640`;
}

// 该 skill 是否启用 LLM 提示词增强：skill 级生图配置显式声明 enhance_prompt 时以它为准，
// 否则看全局生图设置。与后端 image_gen.py start_generation 的合并规则保持一致，
// 未启用时跳过前端 LLM 增强，直接把用户/模板文本交给 Krea2。
async function resolveImageEnhance(skillId) {
    const [settings, cfg] = await Promise.all([
        getGenSettings().catch(() => ({})),
        getSkillGenConfig(skillId).catch(() => ({})),
    ]);
    return cfg && typeof cfg.enhance_prompt === "boolean"
        ? cfg.enhance_prompt
        : !!settings.enhance_prompt;
}

async function runChatImageGeneration({ generateBtn, controller }, text, references, opt) {
    if (!controller) return;
    // 四视图 skill（requiresRef）必须带参考图；纯文生图 skill 不使用参考图（附加的图一律忽略）
    const useRefs = opt?.dataset?.requiresRef === "1";
    const resolvedRefs = references.filter(r => r && r.kind !== "unresolved");
    const unresolvedCount = references.filter(r => r && r.kind === "unresolved").length;
    const hasRefs = resolvedRefs.length > 0;

    generateBtn.disabled = true;
    generateBtn.textContent = "";

    if (useRefs) {
        // image 输入已连接但解析不到文件名：直接报错，绝不静默降级（优先于「缺图」）
        if (unresolvedCount > 0) {
            controller.open();
            controller.set({
                running: false, cancelId: "", images: [], warnings: [],
                statusText: t("参考图读取失败"),
                error: t("节点的图片输入已连接，但无法从上游节点解析出图片文件。请在画布上用 LoadImage 节点并提供图片，或直接粘贴/附加图片后重试。"),
            });
            showToast(app, "error", t("参考图读取失败"), t("图片输入已连接但无法解析出图片文件"));
            generateBtn.disabled = false;
            generateBtn.textContent = "";
            return;
        }
        // 四视图缺参考图：通知 + 节点底部提示区，不提交（不弹 alert）
        if (!hasRefs) {
            controller.open();
            controller.set({
                running: false, cancelId: "", images: [], warnings: [],
                statusText: t("缺少参考图"),
                error: t("四视图需要参考图：请连接 image 输入、@ 引用工作流图片，或粘贴/附加一张角色图片后重试。"),
            });
            showToast(app, "error", t("缺少参考图"), t("四视图需要参考图才能生图"));
            generateBtn.disabled = false;
            generateBtn.textContent = "";
            return;
        }
    }

    const sendRefs = useRefs ? resolvedRefs : [];
    const state = {
        running: true, cancelId: "", error: "", images: [], warnings: [], progress: null,
        enhancedPrompt: "",
        statusText: useRefs ? tf("参考图模式（{n} 张），提交中…", { n: resolvedRefs.length }) : t("提交生图任务…"),
        // 生图阶段机：submit=任务构建 / enhance=LLM 流式增强提示词 / queue=排队 / sample=采样生图。
        // 底部状态行按阶段切换进度条形态（增强文本无确定步数，用已生成字符驱动近似进度）。
        phase: "submit",
    };
    const myToken = controller.open();
    controller.set(state);
    try {
        const [promptText, enhanceEnabled] = await Promise.all([
            buildGenPrompt(opt.value, text, useRefs, opt.__skillMeta?.has_workflow),
            resolveImageEnhance(opt.value || ""),
        ]);

        // Phase 1: LLM 增强提示词（流式），仅在开启增强时执行；失败静默回退原文。
        // 未开启（skill/全局 enhance_prompt=false，如不带 LLM 增强预设的四视图 skill）
        // 时跳过，直接提交用户/模板文本，不再自动增强。
        let finalPrompt = promptText;
        if (enhanceEnabled) {
            state.statusText = t("增强提示词中…");
            state.phase = "enhance";
            controller.set(state);
            let enhanceErr = null;
            try {
                const enhanced = await new Promise((resolve) => {
                    let rafId = null;
                    enhancePromptStream(
                        { skill_id: opt?.value || "", prompt: promptText },
                        {
                            onChunk: (chunk) => {
                                state.enhancedPrompt += chunk;
                                if (rafId) return;
                                rafId = requestAnimationFrame(() => {
                                    rafId = null;
                                    controller.set(state);
                                });
                            },
                            onDone: (fullText) => {
                                if (rafId) cancelAnimationFrame(rafId);
                                state.enhancedPrompt = fullText || "";
                                resolve(fullText);
                            },
                            onError: (err) => { enhanceErr = err || t("未知错误"); resolve(null); },
                        }
                    );
                });
                if (enhanced && enhanced.trim()) {
                    finalPrompt = enhanced.trim();
                }
            } catch (e) {
                enhanceErr = e?.message || String(e);
                console.warn("prompt enhancement failed, using original:", e);
            }
            // 增强是可选步骤，失败仍用原文出图；但 LLM 异常要给出处理入口，不再静默
            if (enhanceErr) {
                actionToast({
                    severity: "warning",
                    summary: t("LLM 提示词增强失败，已用原文生成"),
                    detail: tf("{err}。请检查 API Key / 模型 / 端点。", { err: enhanceErr }),
                    actionLabel: t("打开 LLM 设置"),
                    onAction: openLLMSettingsModal,
                });
            }
        }

        // Phase 2: 提交生图任务（skip_enhance 避免后端重复增强）
        state.statusText = t("排队中…");
        state.phase = "queue";
        controller.set(state);
        const body = { skill_id: opt?.value || "", prompt: finalPrompt, references: sendRefs, skip_enhance: true };
        const snap = await requestGeneration(body);
        state.cancelId = snap.task_id;
        state.warnings = snap.warnings || [];
        state.statusText = t("排队中…");
        controller.set(state);
        const final = await watchTask(snap.task_id, (s) => {
            state.statusText = s.status === "running" ? t("生图中…") : t("排队中…");
            state.phase = s.status === "running" ? "sample" : "queue";
            state.progress = s.progress || null;
            controller.set(state);
        }, () => controller.isStale(myToken));
        if (final.status === "succeeded") {
            state.images = final.images || [];
            state.statusText = tf("完成：{n} 张 · {w}×{h}", { n: state.images.length, w: final.width, h: final.height });
        } else if (final.status === "cancelled") {
            state.statusText = t("已取消");
        } else {
            state.statusText = t("失败");
            state.error = final.error || t("生图失败");
        }
    } catch (e) {
        state.statusText = t("失败");
        state.error = e?.message || String(e);
    } finally {
        state.running = false;
        controller.set(state);
        // 等待期间被清空（代际更替）时不动按钮，避免解禁新一轮正在进行的生成
        if (!controller.isStale(myToken)) {
            generateBtn.disabled = false;
            generateBtn.textContent = "";
            // 生图失败：action toast 引导到技能详情页处理（缺模型/缺节点等），不自动关闭
            if (state.error) {
                const skillName = opt?.value || "";
                actionToast({
                    severity: "error",
                    summary: t("生图失败"),
                    detail: state.error,
                    actionLabel: t("打开技能详情"),
                    onAction: () => resolveSkillId(skillName, false).then((id) => { if (id) openSkillDetailById(id); }),
                });
            }
        }
    }
}

/**
 * 创建生成提示词的处理函数 - 使用选中的模板或 LLM 智能判断
 */
function createGenerateHandler(promptUI) {
    return async () => {
        const { generateBtn, quickInput, customTextarea, textWidget, node, graph, skillSelector, attachedImages = [], refreshMarkdownPreviewAuto, genResultsController, thinkingDepthSelect } = promptUI;

        // 「思考深度」：不思考→enable_thinking:false（跳过推理，更快更稳）；浅/标准/深度→reasoning_effort 档位
        const thinkingDepth = thinkingDepthSelect?.value || "medium";
        const enableThinkingField = thinkingDepth === "off" ? { enable_thinking: false } : { reasoning_effort: THINKING_EFFORTS[thinkingDepth] };

        const quickText = quickInput.value.trim();
        const currentPrompt = customTextarea?.value?.trim() || "";

        // If quickInput is empty, use customTextarea content as the message
        const messageToLLM = quickText || currentPrompt;

        // 附加图片、节点 image 输入连接 -> vision skill 路由（反推等）
        const slotImage = resolveConnectedImageSource(node);
        // @引用/本地上传参考图（不含连线 slotImage）：供出队时合并进 bundle.references
        const attachedPayload = attachedImages.map(img => img.input
            ? { kind: "input", value: img.input }
            : { kind: "data", data: img.data });
        const imagesPayload = [
            ...(slotImage ? [slotImage] : []),
            ...attachedPayload,
        ];
        const hasImages = imagesPayload.length > 0;

        // 选中生图 skill：绕过 LLM，直连后端生图流程，结果渲染在 Markdown 预览区
        const selectedOpt = skillSelector
            ? Array.from(skillSelector.options).find(o => o.value === skillSelector.value) : null;

        if (!messageToLLM && !hasImages) {
            // 文案随所选 skill 区分：文生图只看文字；四视图需要文字 + 参考图；其余输入可二选一
            const missing = selectedOpt?.dataset.genImage === "1"
                ? (selectedOpt.dataset.requiresRef === "1"
                    ? t("请先输入画面描述，并提供参考图（连接 image 输入、@ 引用或附加图片）。")
                    : t("请先输入画面描述。"))
                : t("请先在快捷输入栏输入描述，或附加一张图片。");
            showToast(app, "warning", t("缺少输入"), missing);
            if (genResultsController) {
                genResultsController.open();
                genResultsController.set({
                    running: false, cancelId: "", images: [], warnings: [],
                    statusText: t("缺少输入"),
                    error: missing,
                });
            }
            return;
        }

        // 记入快捷输入命令终端式历史（↑/↓ 可召回）：只记录真正发出的快捷输入
        promptUI.recordQuickHistory?.(quickText);

        if (selectedOpt?.dataset.genImage === "1") {
            // 生图：output 区域已有提示词 + quick input 新输入，两者拼接
            const genText = [currentPrompt, quickText].filter(Boolean).join("\n");
            await runChatImageGeneration({ generateBtn, controller: promptUI.genResultsController },
                genText, imagesPayload, selectedOpt);
            return;
        }

        // 工作流上下文（MiniMax H3 参数 + 叶子媒体清单）：探测图片尺寸有超时上限，失败静默降级
        // 必须用 node.graph 而非闭包捕获的 graph：加载/切换工作流后旧图引用会失效，导致采集到空图
        let workflowContext = null;
        try {
            workflowContext = await collectWorkflowContext(node.graph);
        } catch (e) {
            console.warn("collectWorkflowContext failed:", e);
        }

        // LAYA 智能选 skill：有文字输入且当前未显式选择增强 skill 时，自动推荐最匹配的
        if (messageToLLM && skillSelector && !skillSelector.value) {
            try {
                const resp = await Promise.race([
                    fetch("/rs_prompts/classify_skill", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ text: messageToLLM }),
                    }).then(r => r.json()),
                    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 500)),
                ]);
                if (resp?.skill && resp.confidence > 0.6) {
                    const opt = Array.from(skillSelector.options).find(o => o.value === resp.skill);
                    if (opt) {
                        skillSelector.value = resp.skill;
                        // 同步到 node properties（持久化）
                        if (node.properties) node.properties.rs_selected_skill = resp.skill;
                    }
                }
            } catch (e) { /* LAYA 不可用/超时：静默跳过，保持默认 */ }
        }

        // 检查是否选择了 skill（任务/预设统一选择器，值为 skill id）
        const selectedSkillId = skillSelector?.value || "";

        generateBtn.disabled = true;
        generateBtn.textContent = "";

        // 三条流式分支共用的 SSE 输出框处理器（正文 rAF 批量写回 / 思考面板 / 状态行，见 prompt-service）：
        // onDone 先把正文落进 textarea 再持久化 widget；failOpts = (err) => ({ summary, actionLabel, onAction })，失败时按错误来源给处理入口
        const streamHandlers = (errorLabel, failOpts) => createStreamOutputHandlers({
            textarea: customTextarea,
            refreshPreview: refreshMarkdownPreviewAuto,
            onDone: () => {
                saveTextToStorage(node, textWidget, customTextarea, true);
                markQuickInputConsumed(node);
            },
            onError: (err) => {
                console.error(errorLabel, err);
                const opts = failOpts?.(err);
                if (opts?.actionLabel) {
                    actionToast({ severity: "error", detail: String(err), ...opts });
                } else {
                    showToast(app, "error", t("处理失败"), String(err));
                }
            }
        });
        let handlers = null;
        try {
            if (hasImages) {
                // 图片 -> skill 路由（反推等 vision skill，流式）
                generateBtn.textContent = ""; // 统一短反馈，而非长串处理文案

                const skillId = selectedSkillId || "reverse_prompt";

                const payload = {
                    text: messageToLLM,
                    skillId,
                    images: imagesPayload,
                    uid: node.id,
                    bundleRefs: attachedPayload,
                    description: quickText || currentPrompt,
                    context: workflowContext,
                    ...enableThinkingField
                };
                handlers = streamHandlers("Skill invoke error:", (err) => failAction(selectedSkillId, err));
                await invokePromptStream(payload, handlers);
            } else if (selectedSkillId) {
                // 使用选中的模板进行生成（流式）
                generateBtn.textContent = ""; // 统一短反馈

                // If quickInput has content, combine with currentPrompt; otherwise use currentPrompt alone
                const userPrompt = quickText ? (currentPrompt ? `${currentPrompt}\n\n---\n\n${quickText}` : quickText) : currentPrompt;

                // 使用流式API，传入skillId
                handlers = streamHandlers("Skill stream error:", (err) => failAction(selectedSkillId, err));
                await sseStream("/rs_prompts/stream_generate_prompt", handlers, { 
                    text: userPrompt, 
                    skillId: selectedSkillId,
                    description: quickText || currentPrompt,
                    context: workflowContext,
                    ...enableThinkingField
                });
            } else {
                // 使用 LLM 智能判断（流式）：LLM 直接判断用户意图并生成/改写
                generateBtn.textContent = ""; // 统一短反馈
                // 拼接 currentPrompt 和 quickText（与选择了模版时保持一致）
                const userPrompt = quickText ? (currentPrompt ? `${currentPrompt}\n\n---\n\n${quickText}` : quickText) : currentPrompt;
                handlers = streamHandlers("Smart prompt stream error:", (err) => failAction("", err));
                await sseStream("/rs_prompts/stream_generate_prompt", handlers, {
                    text: userPrompt,
                    description: quickText || currentPrompt,
                    context: workflowContext,
                    ...enableThinkingField
                });
            }
        } catch (e) {
            console.error("Network Error:", e);
            showToast(app, "error", t("网络错误"), e.message || String(e));
        } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = "";
            // 补落尚未执行的合并帧（正常路径 onDone 已落过，幂等）
            handlers?.flush();
        }
    };
}

// ==========================================
// Backend streaming sync (auto-generate during execution)
// ==========================================

/**
 * 后端执行期自动生成（prompts.py 两条 auto-generate 路径）按块推送
 * rs.prompt.auto_generate_update：先写回 textarea/widget，再刷新 Markdown 预览，
 * 保证预览与输入框内容同帧（此前两处监听分开注册，预览总落后一个事件）。
 * 返回注销函数，节点移除时调用，避免残留监听持有已销毁节点的 DOM。
 */
function wireBackendStreamUpdate(promptUI) {
    const { customTextarea, textWidget, node, refreshMarkdownPreviewAuto, skillSelector } = promptUI;
    // 后端流失败时生成器 yield "[ERROR] xxx"，随 accumulated 逐次推送；只弹一次 toast
    let errorToastShown = false;
    const handler = (event) => {
        const currentUid = node.properties?.rs_instance_uid || node.widgets?.find(w => w.name === "instance_uid")?.value;
        if (event.detail.instance_uid !== currentUid) return;
        const promptText = event.detail.prompt || "";
        customTextarea.value = promptText;
        customTextarea.scrollTop = customTextarea.scrollHeight;
        saveTextToStorage(node, textWidget, customTextarea);
        // 用 node.graph 而非闭包捕获的 graph：加载/切换工作流后旧图引用会失效
        if (node.graph) node.graph.setDirtyCanvas(true, true);
        refreshMarkdownPreviewAuto?.();
        if (promptText.includes("[ERROR]")) {
            if (!errorToastShown) {
                errorToastShown = true;
                const detail = promptText.replace(/^\[ERROR\]\s*/, "");
                actionToast({ severity: "error", detail, ...failAction(skillSelector?.value || "", detail) });
            }
        } else {
            errorToastShown = false;
        }
    };
    api.addEventListener("rs.prompt.auto_generate_update", handler);
    return () => api.removeEventListener("rs.prompt.auto_generate_update", handler);
}

// ==========================================
// Prompt output area (textarea + Markdown preview)
// ==========================================

function triggerTextChange(textareaEl) {
    textareaEl.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * 提示词输出区：textarea + Markdown 预览层 + 清空按钮 + 多轮技能提示。
 * actions 是宿主自己的动作按钮（保存/随机/列表），按传入顺序组合进按钮组，
 * 预览按钮始终排最后；写入 textarea 时派发原生 input 事件供外部同步 widget。
 */
function createPromptOutputArea({ customTextarea, skillSelector, actions = [] }) {
    // Create wrapper for custom textarea and buttons
    const customTextareaWrapper = mkEl("div", "rs-custom-textarea-wrapper");
    customTextareaWrapper.appendChild(customTextarea);

    // Markdown 预览层：覆盖在 textarea 区域，点 切换显示（复用 skill.js 的 renderMarkdown）
    const mdPreview = mkEl("div", "rs-md-preview rs-prompt-md-preview");
    mdPreview.style.display = "none";
    customTextareaWrapper.appendChild(mdPreview);
    
    // Create button group wrapper
    const buttonGroup = mkEl("div", "rs-button-group");
    for (const action of actions) buttonGroup.appendChild(action);

    // Markdown 预览切换按钮（）：默认随按钮组折叠，hover 展开，激活时常亮高亮
    const mdPreviewBtn = mkEl("button", "rs-action-btn rs-md-preview-btn");
    mdPreviewBtn.textContent = "";
    mdPreviewBtn.setAttribute("data-rs-tooltip", t("Markdown 预览 / 编辑"));
    buttonGroup.appendChild(mdPreviewBtn);

    customTextareaWrapper.appendChild(buttonGroup);

    // 切换 Markdown 预览 / 原始编辑；refreshMarkdownPreview 供流式更新时同步刷新
    let mdPreviewOn = false;
    // 渲染预览并把 GFM 任务列表复选框设为可交互（marked 默认输出 disabled，这里放开）
    // 生图结果块（若有）追加在 Markdown 内容之后；重渲染会重置滚动位置，
    // 若用户此前已贴底（或从未手动上滚）则自动滚回底部，跟随流式/进度更新
    let mdPinnedToBottom = true;
    function paintMdPreview() {
        const wasAtBottom = mdPreview.scrollHeight - mdPreview.scrollTop - mdPreview.clientHeight < 24;
        if (wasAtBottom) mdPinnedToBottom = true;
        mdPreview.innerHTML = renderMarkdown(customTextarea.value || "");
        for (const box of mdPreview.querySelectorAll('input[type="checkbox"]')) {
            box.disabled = false;
            box.style.cursor = "pointer";
        }
        if (genState) paintGenBlock();
        if (mdPinnedToBottom) mdPreview.scrollTop = mdPreview.scrollHeight;
    }
    // 用户手动上滚查看历史内容时停止自动跟随，滚回底部后恢复
    mdPreview.addEventListener("scroll", () => {
        mdPinnedToBottom = mdPreview.scrollHeight - mdPreview.scrollTop - mdPreview.clientHeight < 24;
    });
    // 切换源码中第 boxIndex 个任务项的勾选（[ ]/[x]），未命中则原样返回
    function setTaskItemChecked(text, boxIndex, checked) {
        const lines = text.split("\n");
        let seen = -1;
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])/);
            if (!m) continue;
            seen++;
            if (seen === boxIndex) {
                lines[i] = m[1] + (checked ? "x" : " ") + m[3] + lines[i].slice(m[0].length);
                return lines.join("\n");
            }
        }
        return text;
    }
    function setMdPreview(on) {
        mdPreviewOn = on;
        if (on) {
            paintMdPreview();
            customTextarea.style.display = "none";
            mdPreview.style.display = "block";
            mdPreviewBtn.classList.add("rs-md-preview-active");
        } else {
            mdPreview.style.display = "none";
            customTextarea.style.display = "";
            mdPreviewBtn.classList.remove("rs-md-preview-active");
        }
    }
    function refreshMarkdownPreview() {
        if (mdPreviewOn) paintMdPreview();
    }
    // 生成/流式结束后调用：内容识别为 Markdown 则自动切到预览，否则同步刷新已开启的预览
    function refreshMarkdownPreviewAuto() {
        if (looksLikeMarkdown(customTextarea.value || "")) setMdPreview(true);
        else refreshMarkdownPreview();
    }
    mdPreviewBtn.addEventListener("click", () => setMdPreview(!mdPreviewOn));
    // 一键清除按钮：定位在 custom area 右上角，清空提示词并同步 widget/storage（无确认，直接清）
    const clearBtn = mkEl("button", "rs-clear-btn");
    clearBtn.textContent = "✕";
    clearBtn.setAttribute("data-rs-tooltip", t("Clear prompt / 清空"));
    clearBtn.addEventListener("click", () => {
        customTextarea.value = "";
        triggerTextChange(customTextarea);
        // 生图结果块一并清除（genResultsController 定义在后，闭包引用无碍）
        genResultsController.clear();
    });
    customTextareaWrapper.appendChild(clearBtn);
    // 预览中的任务列表复选框可点击：回写 [ ]/[x] 到 textarea（经 input 事件同步 widget/storage），
    // 便于多轮技能把用户选择带入下一次生成；不重渲染，避免长列表滚动位置跳动
    mdPreview.addEventListener("click", (e) => {
        const box = e.target && e.target.closest ? e.target.closest('input[type="checkbox"]') : null;
        if (!box || !mdPreview.contains(box)) return;
        const boxes = Array.from(mdPreview.querySelectorAll('input[type="checkbox"]'));
        const next = setTaskItemChecked(customTextarea.value || "", boxes.indexOf(box), box.checked);
        if (next !== customTextarea.value) {
            customTextarea.value = next;
            triggerTextChange(customTextarea);
        }
    });

    // 生图结果块状态（Krea2 生图 skill 专用）：runChatImageGeneration 通过 controller 更新，
    // 随 Markdown 预览重绘附加在内容之后；预览未开启时由 open() 强制切到预览展示进度
    let genState = null;
    // 代际 token：open() 捕获当前 genSeq；clear() 递增 genSeq 后，运行中任务的后续 set（含轮询 tick / finally）不再回写 UI
    let genSeq = 0;
    let genToken = 0;
    // 生图状态行：固定挂在节点最底部（rs-root 底部），运行中一行显示 状态/进度/取消，
    // 结束（完成/取消/失败/清空）即隐藏——不随预览滚动吸顶，避免滚动容器 padding 造成的贴顶间隙
    const genStatusEl = mkEl("div", "rs-gen-status");
    genStatusEl.style.display = "none";
    // 状态行 DOM 复用：同一阶段（尤其增强文本 rAF 高频 set）只刷新文本/宽度/label，
    // 整行重建会让 transition 起点丢失、fill 每帧硬跳变，视觉上像左右抖动。
    let genStatusPhase = "";    // 当前渲染的阶段；非 running 置空强制下次重建
    let genStatusText = null;   // .rs-gen-status-text
    let genStatusBar = null;    // .rs-gen-progress（进度条外层，用于切 indeterminate 类）
    let genStatusFill = null;   // .rs-gen-progress-fill（宽度过渡目标）
    let genStatusLabel = null;  // .rs-gen-progress-label（步数 / 已生成字数）
    let genStatusCancel = null; // .rs-gen-cancel（cancelId 出现后追加）

    // 按阶段刷新进度条填充：增强文本=字符渐近曲线；采样=真实步数；排队/提交=不定动画
    function paintGenFill() {
        const bar = genStatusBar, fill = genStatusFill;
        const determinate = genState.phase === "enhance" || genState.progress?.max > 0;
        if (determinate) {
            if (fill._rsAnim) { fill._rsAnim.cancel(); fill._rsAnim = null; }
            bar.classList.remove("rs-gen-progress--indeterminate");
            if (genState.phase === "enhance") {
                // LLM 流式增强文本没有已知总长度：用 len/(len+C) 渐近曲线逼近进度。
                // 开头平缓、随文字持续推进且增速放缓、长文本减速但永不停滞；
                // C=700 时 100/400/800/1500 字约对应 12%/36%/53%/68%。
                const len = (genState.enhancedPrompt || "").length;
                fill.style.width = ((len / (len + 700)) * 100) + "%";
                fill.style.transition = "width 0.2s ease";
            } else {
                const pct = Math.max(0, Math.min(100, (genState.progress.value / genState.progress.max) * 100));
                fill.style.width = pct + "%";
                fill.style.transition = "width 0.4s ease";
            }
        } else {
            bar.classList.add("rs-gen-progress--indeterminate");
            fill.style.width = "40%";
            // WAAPI 替代 CSS keyframes；jsdom 未实现 animate，可选调用兜底。
            // 连续刷新不复启动画，避免不确定条每次从头开始造成闪烁
            if (!fill._rsAnim) {
                fill._rsAnim = fill.animate?.(
                    [{ transform: "translateX(-100%)" }, { transform: "translateX(350%)" }],
                    { duration: 1200, iterations: Infinity, easing: "ease-in-out" }
                ) || null;
            }
        }
    }
    function paintGenLabel() {
        let want = "";
        if (genState.phase === "enhance") {
            want = tf("已生成 {n} 字", { n: (genState.enhancedPrompt || "").length });
        } else if (genState.progress?.max > 0) {
            want = tf("第 {cur} / {max} 步", { cur: genState.progress.value, max: genState.progress.max });
        }
        genStatusLabel.textContent = want;
        genStatusLabel.style.display = want ? "" : "none";
    }
    function paintGenStatus() {
        if (!genState || !genState.running) {
            genStatusEl.style.display = "none";
            genStatusPhase = "";
            if (genStatusFill?._rsAnim) { genStatusFill._rsAnim.cancel(); genStatusFill._rsAnim = null; }
            genStatusEl.innerHTML = "";
            genStatusText = genStatusBar = genStatusFill = genStatusLabel = genStatusCancel = null;
            return;
        }
        const sameRow = genStatusPhase === genState.phase && genStatusBar;
        if (!sameRow) {
            if (genStatusFill?._rsAnim) { genStatusFill._rsAnim.cancel(); genStatusFill._rsAnim = null; }
            genStatusPhase = genState.phase;
            genStatusEl.style.display = "flex";
            genStatusEl.innerHTML = "";
            genStatusText = mkEl("span", "rs-gen-status-text");
            genStatusEl.appendChild(genStatusText);
            // 内联样式自包含进度条（同原约定）：track/fill 是空 div，外部 CSS 缺失时高度塌缩不可见
            genStatusBar = mkEl("div", "rs-gen-progress");
            const track = mkEl("div", "rs-gen-progress-track",
                "height:8px;border-radius:4px;background:#333;overflow:hidden");
            genStatusFill = mkEl("div", "rs-gen-progress-fill",
                "height:100%;border-radius:4px;background:linear-gradient(90deg,#456ba8,#6b9bd8)");
            track.appendChild(genStatusFill);
            genStatusBar.appendChild(track);
            genStatusEl.appendChild(genStatusBar);
            genStatusLabel = mkEl("span", "rs-gen-progress-label");
            genStatusLabel.style.display = "none";
            genStatusEl.appendChild(genStatusLabel);
            genStatusCancel = null;
        }
        genStatusText.textContent = tf("生图 · {status}", { status: genState.statusText });
        paintGenFill();
        paintGenLabel();
        // 取消按钮：cancelId 在提交任务后出现（phase 未变时增量补挂），点击后禁用防重复
        if (genState.cancelId && !genStatusCancel) {
            genStatusCancel = mkEl("button", "rs-gen-cancel");
            genStatusCancel.type = "button";
            genStatusCancel.textContent = t("取消");
            genStatusCancel.addEventListener("click", () => {
                genStatusCancel.disabled = true;
                cancelTask(genState.cancelId);
            });
            genStatusEl.appendChild(genStatusCancel);
        } else if (!genState.cancelId && genStatusCancel) {
            genStatusCancel.remove();
            genStatusCancel = null;
        }
    }
    function paintGenBlock() {
        const block = mkEl("div", "rs-gen-block");
        // 状态/进度已移到节点底部 .rs-gen-status 一行（运行中显示、结束即隐藏），不再吸顶；
        // 生图块只承载结果内容（增强提示 / 警告 / 错误 / 图片），无结果时不渲染空边框
        let hasContent = false;
        // 增强提示词（流式输出中或完成后均显示）
        if (genState.enhancedPrompt) {
            hasContent = true;
            const promptEl = mkEl("div", "rs-gen-enhanced-prompt");
            promptEl.style.cssText = "margin:6px 0;padding:8px 10px;border-radius:6px;background:rgba(128,128,255,0.08);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:#ccc";
            promptEl.textContent = genState.enhancedPrompt;
            block.appendChild(promptEl);
        }
        for (const warn of genState.warnings || []) {
            hasContent = true;
            const warnEl = mkEl("div", "rs-gen-warn");
            warnEl.textContent = `${warn}`;
            block.appendChild(warnEl);
        }
        if (genState.error) {
            hasContent = true;
            const errEl = mkEl("div", "rs-gen-error");
            errEl.textContent = `✕ ${genState.error}`;
            block.appendChild(errEl);
        }
        if (genState.images?.length) {
            hasContent = true;
            const grid = mkEl("div", "rs-gen-thumbs");
            genState.images.forEach((image, i) => {
                const cell = mkEl("div", "rs-gen-thumb");
                const img = mkEl("img");
                // 缩略图走 gallery 的 thumbnail 缓存接口（640px），点击才用灯箱加载原图
                img.src = genThumbSrc(image);
                img.loading = "lazy";
                img.addEventListener("click", () => Lightbox.open({
                    items: genState.images.map(im => ({ kind: "image", url: im.url, title: im.filename })),
                    index: i,
                }));
                cell.appendChild(img);
                const sendBtn = mkEl("button", "rs-gen-send");
                sendBtn.type = "button";
                sendBtn.textContent = t("发送到节点");
                sendBtn.addEventListener("click", (e) => sendImageToLoadImage(image, e.currentTarget));
                cell.appendChild(sendBtn);
                grid.appendChild(cell);
            });
            block.appendChild(grid);
            if (genState.images.length > 1) {
                const assembleBtn = mkEl("button", "rs-gen-assemble");
                assembleBtn.type = "button";
                assembleBtn.textContent = t("⏩ 全部装配到节点");
                assembleBtn.addEventListener("click", () => assembleAllGenerated(genState.images));
                block.appendChild(assembleBtn);
            }
        }
        if (!hasContent) return;
        mdPreview.appendChild(block);
    }
    const genResultsController = {
        set(state) {
            // 代际校验：clear() 之后运行中任务的后续 set（含轮询 tick / finally）不再回写 UI
            if (genSeq !== genToken) return;
            genState = state;
            paintGenStatus();
            if (mdPreviewOn) paintMdPreview();
        },
        open() {
            genToken = genSeq;
            paintGenStatus();
            if (!mdPreviewOn) setMdPreview(true);
            return genToken;
        },
        isStale(token) {
            // 该 token 的任务已被 clear()（或新任务 open）取代：轮询应停止，避免清空后仍空转
            return genSeq !== token;
        },
        clear() {
            // 清空生图结果块：递增代际使运行中任务的后续 set 失效（服务端任务继续跑，仅 UI 不再回写）
            genSeq++;
            genState = null;
            paintGenStatus();
            if (mdPreviewOn) paintMdPreview();
        },
    };

    // 轻量 Markdown 识别：仅当出现标题 / 代码块 / 列表 / 加粗等强信号才判定为 Markdown，避免普通提示词误判
    function looksLikeMarkdown(text) {
        if (!text) return false;
        let heading = 0, list = 0;
        for (const line of text.split("\n")) {
            if (/^#{1,6}\s/.test(line)) heading++;
            else if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) list++;
        }
        return /```/.test(text) || heading >= 1 || list >= 2 || /\*\*[^*\n]+\*\*/.test(text);
    }

    // 多轮交互提示：每次生成只推进一个阶段，需补充返回的问询后再次运行
    const skillHint = mkEl("div", "rs-skill-hint");
    skillHint.textContent = t("多轮技能：每次仅推进一阶段，补充问询后再点 ");
    // 按需显示：仅当前选中的 skill 声明了 multi_turn 时才出现（默认隐藏）
    skillHint.style.display = "none";
    function updateSkillHint() {
        const opt = Array.from(skillSelector.options).find(o => o.value === skillSelector.value);
        skillHint.style.display = (opt && opt.dataset.multiTurn === "1") ? "" : "none";
    }
    skillSelector.addEventListener("change", updateSkillHint);

    return {
        el: customTextareaWrapper,
        actionGroupEl: buttonGroup,
        skillHintEl: skillHint,
        genStatusEl,
        refreshMarkdownPreviewAuto,
        genResultsController
    };
}

export {
    createStatusBars,
    createPromptOutputArea,
    triggerTextChange,
    createGenerateHandler,
    wireBackendStreamUpdate
};
