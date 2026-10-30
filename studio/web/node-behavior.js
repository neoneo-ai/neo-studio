/**
 * node-behavior.js
 * 共享的节点行为逻辑 - 消除 NeoPromptSimple 和 NeoPrompts 之间的代码重复
 */

import { randomPrompt } from "./prompt-service.js";
import { t, tf } from "./js/core/i18n.js";

// ==========================================
// 工具函数
// ==========================================

// 标记快捷输入已被生成消费：出队时后端跳过拼接；重新编辑输入即自动复位
export function markQuickInputConsumed(node) {
    const widget = node?.widgets?.find(w => w.name === "quick_input_used");
    if (widget) widget.value = true;
    if (node?.properties) node.properties.rs_quick_input_used = true;
}

function resetQuickInputConsumed(node) {
    const widget = node?.widgets?.find(w => w.name === "quick_input_used");
    if (widget) widget.value = false;
    if (node?.properties) node.properties.rs_quick_input_used = false;
}

function randomHex() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID().replace(/-/g, "");
    }
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/**
 * 获取实例 UID
 */
function getInstanceUid(node) {
    if (node.properties?.rs_instance_uid) {
        return node.properties.rs_instance_uid;
    }
    const uidWidget = node.widgets?.find(w => w.name === "instance_uid");
    if (uidWidget?.value) {
        return uidWidget.value;
    }
    return 'rs_inst_' + randomHex();
}

/**
 * Set textarea value and dispatch synthetic "input" event (triggers auto-switch from EXTERNAL to LOCAL)
 */
function setTextAndTrigger(customTextarea, value) {
    if (!customTextarea) return;
    customTextarea.value = value;
    customTextarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * 保存文本到 widget（in-memory cache）
 */
export function saveTextToStorage(node, textWidget, customTextarea, forceSave = false) {
    const instanceUid = getInstanceUid(node);
    const text = customTextarea?.value ?? textWidget?.value ?? "";
    
    if (textWidget && (forceSave || textWidget.value !== text)) {
        textWidget.value = text;
    }
    if (customTextarea && customTextarea.value !== text) {
        customTextarea.value = text;
    }
    // In-memory cache only - no localStorage
    return text;
}

/**
 * 从 widget 恢复文本（in-memory cache）
 */
function restoreTextFromStorage(node, textWidget, customTextarea) {
    // In-memory cache only - use widget value
    if (textWidget && textWidget.value) {
        if (customTextarea) customTextarea.value = textWidget.value;
        return textWidget.value;
    }
    return null;
}

/**
 * 创建通用的初始化处理器（设置基本属性）
 */
function createBasicNodeInitializer(node) {
    return function() {
        if (!node.properties) {
            node.properties = {};
        }
        if (node.properties.rs_disable_state === undefined) {
            node.properties.rs_disable_state = false;
        }
        if (node.properties.rs_waiting_prompt === undefined) {
            node.properties.rs_waiting_prompt = "";
        }
        if (node.properties.rs_waiting_timestamp === undefined) {
            node.properties.rs_waiting_timestamp = 0;
        }
    };
}

// ==========================================
// 按钮操作工厂函数
// ==========================================

/**
 * 创建随机生成提示词的处理函数（纯本地操作，不需要大模型）
 */
function createRandomHandler(promptUI) {
    return async () => {
        const { randomBtn, customTextarea, textWidget, node } = promptUI;

        randomBtn.disabled = true;

        try {
            const data = await randomPrompt();
            if (data.status === "success") {
                setTextAndTrigger(customTextarea, data.prompt);
                saveTextToStorage(node, textWidget, customTextarea);
                if (node.graph) node.graph.setDirtyCanvas(true, true);
            } else {
                console.error("Random prompt failed:", data);
                alert("Failed to generate random prompt: " + (data.error || "Unknown error"));
            }
        } catch (e) {
            console.error("Network Error:", e);
            alert("Network error during random prompt generation.");
        } finally {
            randomBtn.disabled = false;
        }
    };
}

/**
 * 运行时随机选词（▾ 菜单）状态接线：恢复 UI、持久化到 properties 与同名隐藏控件。
 * 编码器（NeoPromptEncoder）单输出固定每次抽 1 条并隐藏数量行；
 * 生成器（NeoPromptAgent）按列表输出，支持一次抽取多条循环消费。
 */
function wireRuntimeRandom(node, randomBtn) {
    const ui = randomBtn._rsRuntime;
    if (!ui || !node) return;
    const isEncoder = node.type === "NeoPromptEncoder";
    if (isEncoder) ui.countRow.style.display = "none";

    const currentState = () => {
        const prop = node.properties?.rs_runtime_random;
        if (prop && typeof prop === "object") return prop;
        const en = node.widgets?.find(w => w.name === "random_enabled");
        const cn = node.widgets?.find(w => w.name === "random_count");
        return { enabled: !!en?.value, count: cn ? (parseInt(cn.value, 10) || 1) : 1 };
    };

    const applyState = () => {
        const st = currentState();
        const count = Math.max(1, Math.min(st.count || 1, 16));
        ui.checkbox.checked = !!st.enabled;
        ui.valueSpan.textContent = String(isEncoder ? 1 : count);
        // 启用时给按钮组内的骰子容器打标：折叠状态下也保持可见（见 .rs-random-on 样式）。
        // 菜单本身挂在 body 上，不能从 checkbox 往上找容器，必须用显式引用。
        if (ui.wrap) ui.wrap.classList.toggle("rs-random-on", !!st.enabled);
        const en = node.widgets?.find(w => w.name === "random_enabled");
        const cn = node.widgets?.find(w => w.name === "random_count");
        if (en) en.value = !!st.enabled;
        if (cn) cn.value = isEncoder ? 1 : count;
    };

    const persistState = () => {
        if (!node.properties) node.properties = {};
        node.properties.rs_runtime_random = {
            enabled: ui.checkbox.checked,
            count: isEncoder ? 1 : Math.max(1, Math.min(parseInt(ui.valueSpan.textContent, 10) || 1, 16)),
        };
        applyState();
        if (node.graph) node.graph.setDirtyCanvas(true, true);
    };

    ui.checkbox.addEventListener("change", persistState);
    ui.minusBtn.addEventListener("click", () => {
        if (isEncoder) return;
        ui.valueSpan.textContent = String(Math.max(1, (parseInt(ui.valueSpan.textContent, 10) || 1) - 1));
        ui.checkbox.dispatchEvent(new Event("change"));
    });
    ui.plusBtn.addEventListener("click", () => {
        if (isEncoder) return;
        ui.valueSpan.textContent = String(Math.min(16, (parseInt(ui.valueSpan.textContent, 10) || 1) + 1));
        ui.checkbox.dispatchEvent(new Event("change"));
    });

    // 接线即同步一次：新节点按隐藏控件/属性恢复折叠态下的骰子可见性
    applyState();

    // 工作流加载（configure）后从隐藏控件刷新菜单状态
    if (typeof node.restoreFromProperties === "function") {
        const origRestore = node.restoreFromProperties;
        node.restoreFromProperties = () => {
            origRestore();
            applyState();
        };
    }
}

// ==========================================
// 事件监听器管理
// ==========================================

/**
 * 创建弹窗自动关闭的事件监听器
 */
function createPopupCloser(promptUIElements) {
    return (e) => {
        const { presetListOverlay, presetNameInput, deleteConfirmOverlay, saveBtn, quickInputWrapper } = promptUIElements;
        
        // Check if click is inside our custom UI root
        const clickedRoot = e.target.closest(".rs-root");
        
        if (presetListOverlay) {
            // 点击 overlay 内部不关闭
            if (presetListOverlay.contains(e.target)) {
                return;
            }
            // 点击 quickInputWrapper 内部（包括 quickInput、listBtn、randomBtn、generateBtn）不关闭
            if (quickInputWrapper && quickInputWrapper.contains(e.target)) {
                return;
            }
            // 点击外部（不在 rs-root 内）才关闭
            if (!clickedRoot) {
                presetListOverlay.style.display = "none";
            }
        }
        if (presetNameInput && !presetNameInput.contains(e.target)) {
            // Don't close if clicking inside the same rs-root or on the save button
            if (clickedRoot && (!saveBtn || !saveBtn.contains(e.target))) {
                presetNameInput.style.display = "none";
            }
        }
        if (deleteConfirmOverlay && !deleteConfirmOverlay.contains(e.target)) {
            // Don't close if clicking inside the same rs-root
            if (clickedRoot) {
                deleteConfirmOverlay.style.display = "none";
            }
        }
    };
}

/**
 * 运行时随机抽取的即时反馈：在触发按钮上方短暂浮现提示气泡。
 */
function showRandomPickToast(anchorEl, count) {
    document.querySelectorAll(".rs-random-pick-toast").forEach((t) => t.remove());
    if (!anchorEl || !anchorEl.getBoundingClientRect) return;
    const toast = document.createElement("div");
    toast.className = "rs-random-pick-toast";
    toast.textContent = count > 1 ? tf("已随机抽取 {n} 条提示词", { n: count }) : t("已随机抽取一条新提示词");
    const r = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth;
    toast.style.left = Math.max(8, Math.min(r.right - 190, vw - 198)) + "px";
    toast.style.top = Math.max(8, r.top - 36) + "px";
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = "1"; });
    setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 400);
    }, 2200);
}


/**
 * 创建处理 rs.prompt.update 事件的处理函数
 */
function createPromptUpdateHandler(promptUI) {
    return (event) => {
        const { customTextarea, textWidget, node } = promptUI;
        const currentUid = getInstanceUid(node);
        
        if (event.detail.instance_uid === currentUid) {
            setTimeout(() => {
                customTextarea.value = event.detail.prompt;
                if (textWidget) {
                    textWidget.value = event.detail.prompt;
                    // In-memory cache only - no localStorage
                }
                if (node.graph) node.graph.setDirtyCanvas(true, true);
                // 随机路径附带 random_count：给出可视化反馈（外部输入同步无此字段）
                if (event.detail.random_count) showRandomPickToast(promptUI.randomBtn, event.detail.random_count);
            }, 10);
        }
    };
}

/**
 * 创建 beforeunload 事件处理函数
 */
function createBeforeUnloadHandler(node, textWidget) {
    return () => {
        // In-memory cache only - no localStorage
        const disableWidget = node.widgets?.find(w => w.name === "disable_text_input");
        if (disableWidget) node.properties.rs_disable_state = disableWidget.value;
    };
}

/**
 * 创建文本变更回调 - 当本地操作修改了 customText 时自动切换到 LOCAL PROMPT 状态
 */
function createOnTextChangeCallback(statusBar, updateStatusAndUI, node) {
    return function() {
        if (!statusBar) return;
        
        const statusTextEl = statusBar.querySelector("span");
        if (statusTextEl && statusTextEl.textContent.includes("EXTERNAL INPUT")) {
            // 自动切换到 LOCAL PROMPT 状态 - set rs_disable_state to true so updateStatusAndUI applies green theme
            if (node) node.properties.rs_disable_state = true;
            const disableWidget = node?.widgets?.find(w => w.name === "disable_text_input");
            if (disableWidget) disableWidget.value = true;
            
            // 自动切换状态并更新 UI
            if (updateStatusAndUI) updateStatusAndUI();
            
            // 显示切换提示
            statusTextEl.textContent = "Switched to LOCAL PROMPT";
            statusBar.style.background = "#1a3a1a";
            statusBar.style.color = "#4ade80";
            
            setTimeout(() => {
                if (statusTextEl) {
                    statusTextEl.textContent = "LOCAL PROMPT";
                }
                statusBar.style.background = "";
                statusBar.style.color = "";
            }, 1500);
        }
    };
}

// ==========================================
// 导出
// ==========================================

export const NodeBehaviors = {
    // 工具函数
    getInstanceUid,
    saveTextToStorage,
    restoreTextFromStorage,

    // 节点初始化器工厂
    createBasicNodeInitializer,

    // 按钮处理器工厂
    createRandomHandler,
    wireRuntimeRandom,

    // 快捷输入消费标记
    resetQuickInputConsumed,

    // 文本变更回调
    createOnTextChangeCallback,

    // 事件监听器
    createPopupCloser,
    createPromptUpdateHandler,
    createBeforeUnloadHandler,
};

export default NodeBehaviors;
