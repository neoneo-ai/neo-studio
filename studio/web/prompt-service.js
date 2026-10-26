/**
 * prompt-service.js
 * API 调用和数据处理模块
 */

import { mkEl } from "./dom-utils.js";
import { t } from "./js/core/i18n.js";

// ==========================================
// 远程 LLM 配置缓存
// ==========================================
let remoteLLMConfigCache = null;
let remoteLLMConfigCacheTime = 0;
const REMOTE_LLM_CONFIG_CACHE_TTL = 10000; // 10秒缓存

/**
 * 获取远程 LLM 配置
 * @returns {Promise<Object>}
 */
async function getRemoteLLMConfig() {
    const now = Date.now();
    if (remoteLLMConfigCache && (now - remoteLLMConfigCacheTime) < REMOTE_LLM_CONFIG_CACHE_TTL) {
        return remoteLLMConfigCache;
    }
    
    try {
        const res = await fetch("/rs_prompts/remote_llm_config");
        const config = await res.json();
        remoteLLMConfigCache = config;
        remoteLLMConfigCacheTime = now;
        return config;
    } catch (e) {
        console.error("Failed to get remote LLM config:", e);
        return {
            enabled: false,
            active_provider: "openai",
            providers: {
                openai: { api_key: "", base_url: "", model: "gpt-4o-mini", max_tokens: 500, timeout: 60 },
                lmstudio: { api_key: "", base_url: "http://localhost:1234/v1", model: "", max_tokens: 500, timeout: 60 },
                ollama: { api_key: "", base_url: "http://localhost:11430/v1", model: "", max_tokens: 500, timeout: 60 }
            }
        };
    }
}

/**
 * 保存远程 LLM 配置
 * @param {Object} config - 配置对象
 * @returns {Promise<Object>}
 */
async function saveRemoteLLMConfig(config) {
    try {
        const res = await fetch("/rs_prompts/remote_llm_config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config)
        });
        const result = await res.json();
        if (result.success) {
            // 清除缓存
            remoteLLMConfigCache = null;
            remoteLLMConfigCacheTime = 0;
        }
        return result;
    } catch (e) {
        console.error("Failed to save remote LLM config:", e);
        return { success: false, error: e.message };
    }
}

/**
 * 连接测试：用当前表单的 provider/密钥/端点/模型发送「你好」，成功返回 {success, reply}
 * @param {Object} config - { provider, api_key, base_url, model }
 * @returns {Promise<Object>}
 */
async function testLLMConnection(config) {
    try {
        const res = await fetch("/rs_prompts/llm_connection_test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config || {})
        });
        return await res.json();
    } catch (e) {
        console.error("Failed to test LLM connection:", e);
        return { success: false, error: e.message };
    }
}

/**
 * 获取当前 LLM 模式
 * @returns {Promise<string>} - "local" 或 "remote"
 */
async function getLLMMode() {
    try {
        const res = await fetch("/rs_prompts/llm_mode");
        const data = await res.json();
        return data.mode || "local";
    } catch (e) {
        console.error("Failed to get LLM mode:", e);
        return "local";
    }
}

// ==========================================
// API 服务
// ==========================================

/**
 * 增强提示词（非流式）
 * @param {string} text - 原始提示词
 * @returns {Promise<{status: string, enhanced: string, error?: string}>}
 */
async function enhancePrompt(text) {
    const res = await fetch("/rs_prompts/enhance_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
    });
    return await res.json();
}

/**
 * 通用 SSE 流式请求
 * @param {string} url - 请求 URL
 * @param {Object} options - 回调选项
 * @param {Function} options.onChunk - 收到数据块时回调
 * @param {Function} options.onDone - 完成时回调
 * @param {Function} options.onError - 错误时回调
 * @param {AbortSignal} options.signal - 取消请求时回调（用户点停止）
 * @param {Object} body - 请求体（可选）
 * @returns {Promise<void>}
 */
async function sseStream(url, options = {}, body = null) {
    const { onChunk, onDone, onError, signal } = options;
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
            signal
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            onError?.(err.error || "Request failed");
            return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6);
                if (data === "[DONE]") {
                    onDone?.();
                    return;
                }
                // 生成器（llm.py / image_gen.py / skill.py）失败时以 [ERROR] 前缀的文本帧上报：
                // 交给 onError 让调用方弹 action toast，不再当作正文写进提示词
                if (data.startsWith("[ERROR]")) {
                    onError?.(data.slice("[ERROR]".length).trim());
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    // 生成器内部失败同样以正文块上报（llm.py / skill.py / image_gen.py 的
                    // {"text":"[ERROR] …","kind":"content"}）：当错误处理，不写进提示词正文
                    if (typeof parsed?.text === "string" && parsed.text.startsWith("[ERROR]")) {
                        onError?.(parsed.text.slice("[ERROR]".length).trim());
                        return;
                    }
                    onChunk?.(parsed);
                } catch {
                    onChunk?.({ text: data });
                }
            }
        }
        onDone?.();
    } catch (e) {
        if (signal?.aborted) return;   // 用户点停止：断流是预期收场，不报「生成失败」
        onError?.(e.message);
    }
}

/**
 * 翻译提示词（非流式）
 * @param {string} text - 原始提示词
 * @returns {Promise<{status: string, translated: string, error?: string}>}
 */
async function translatePrompt(text) {
    const res = await fetch("/rs_prompts/translate_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
    });
    return await res.json();
}

/**
 * 增强提示词（流式）
 */
async function enhancePromptStream(text, options = {}) {
    return sseStream("/rs_prompts/stream_enhance_prompt", options, { text });
}

/**
 * 翻译提示词（流式）
 */
async function translatePromptStream(text, options = {}) {
    return sseStream("/rs_prompts/stream_translate_prompt", options, { text });
}

/**
 * 保存提示词
 * @param {string} name - 提示词名称
 * @param {string} text - 提示词内容
 * @param {string[]} tags - 标签列表
 * @returns {Promise<Response>}
 */
async function savePrompt(name, text, tags = []) {
    return await fetch("/rs_prompts/save_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, text, tags })
    });
}

/**
 * 加载提示词
 * @param {string} name - 提示词名称
 * @returns {Promise<{text: string}>}
 */
async function loadPrompt(name) {
    const res = await fetch("/rs_prompts/load_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });
    return await res.json();
}

/**
 * 列出所有提示词
 * @returns {Promise<Array<{name: string, tags: string[]}|string>}
 */
async function listPrompts() {
    const res = await fetch("/rs_prompts/list_prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
    });
    return await res.json();
}

/**
 * 列出多行集合文件的提示词条目（分页，服务端按标题过滤）
 * @param {string} name - 集合显示名（collections/ 前缀）
 * @param {number} offset - 起始条目索引
 * @param {number} limit - 本页条数上限
 * @param {string} query - 标题过滤关键字
 * @param {string} source - "custom" 或 "presets"
 * @returns {Promise<{total: number, titles: string[], texts: string[]}>}
 */
async function listPromptLines(name, offset = 0, limit = 200, query = "", source = "custom") {
    const res = await fetch("/rs_prompts/list_prompt_lines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, offset, limit, query, source })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
}

/**
 * 删除提示词
 */
async function deletePrompt(name) {
    return await fetch("/rs_prompts/delete_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });
}

/**
 * 提取标题（非流式）
 * @param {string} text - 提示词内容
 * @returns {Promise<{status: string, title: string, error?: string}>}
 */
async function extractTitle(text) {
    const res = await fetch("/rs_prompts/extract_title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
    });
    return await res.json();
}

/**
 * 提取分类（非流式）
 * @param {string} text - 提示词内容
 * @returns {Promise<{status: string, classify: string, error?: string}>}
 */
async function extractClassify(text) {
    const res = await fetch("/rs_prompts/extract_classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
    });
    return await res.json();
}

/**
 * 智能提示词 - LLM 直接判断用户意图并生成/改写（非流式）
 * @param {string} text - 原始提示词（可选，为空则从头生成）
 * @param {string} description - 用户描述
 * @returns {Promise<{status: string, prompt: string, error?: string}>}
 */
async function smartPrompt(text, description) {
    const res = await fetch("/rs_prompts/smart_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text || "", description })
    });
    return await res.json();
}

/**
 * 智能提示词 - 流式
 */
async function smartPromptStream(text, description, options = {}) {
    return sseStream("/rs_prompts/stream_generate_prompt", options, { text: text || "", description });
}

/**
 * 随机生成文生图提示词（从 preset list 中随机选择一个）
 * @returns {Promise<{status: string, prompt: string, error?: string}>}
 */
async function randomPrompt() {
    const res = await fetch("/rs_prompts/list_prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
    });
    const list = await res.json();
    
    if (!list || list.length === 0) {
        return { status: "error", prompt: "", error: "No presets available" };
    }
    
    // 随机选择一个
    const randomIndex = Math.floor(Math.random() * list.length);
    const selectedItem = list[randomIndex];
    const name = typeof selectedItem === 'string' ? selectedItem : selectedItem.name;
    
    // 加载该 preset 的完整内容
    const loadRes = await fetch("/rs_prompts/load_prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });
    const data = await loadRes.json();
    
    return {
        status: "success",
        prompt: data.text || ""
    };
}


/**
 * 运行时随机：从混合池不重复抽取 count 条（与 Prompt Agent 节点同池，供批量生成使用）。
 * @returns {Promise<{texts: string[]}>}
 */
async function randomPrompts(count) {
    const res = await fetch("/rs_prompts/random_prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count })
    });
    return await res.json();
}


/**
 * 获取可用模型列表
 * @returns {Promise<{current_model: string, models: Array<{key: string, name: string, filename: string, model_dir: string}>}>}
 */
async function getAvailableModels() {
    try {
        const res = await fetch("/rs_prompts/get_models");
        return await res.json();
    } catch (e) {
        console.error("Failed to get available models:", e);
        return {
            current_model: "",
            models: []
        };
    }
}

/**
 * 设置当前模型
 * @param {string} modelKey - 模型键值
 * @returns {Promise<{success: boolean, current_model?: string, error?: string}>}
 */
async function setCurrentModel(modelKey) {
    try {
        const res = await fetch("/rs_prompts/set_model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model_key: modelKey })
        });
        return await res.json();
    } catch (e) {
        console.error("Failed to set current model:", e);
        return { success: false, error: e.message };
    }
}

/**
 * 将图片文件缩放并转为 base64 data URI
 * @param {File} file - 图片文件
 * @param {number} maxSide - 最长边限制
 * @returns {Promise<{data: string, name: string}>}
 */
function fileToBase64(file, maxSide = 1024) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.max(img.width, img.height) > maxSide
                    ? maxSide / Math.max(img.width, img.height)
                    : 1;
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve({ data: canvas.toDataURL("image/png"), name: file.name });
            };
            img.onerror = reject;
            img.src = reader.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * 从剪贴板事件提取图片文件列表
 * @param {ClipboardEvent} e
 * @returns {File[]}
 */
function imagesFromClipboard(e) {
    const items = e.clipboardData?.items || [];
    const files = [];
    for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
            const f = item.getAsFile();
            if (f) files.push(f);
        }
    }
    return files;
}

/**
 * 以 skill 形式调用流式生成接口（支持 text + images + skillId）
 * `payload = { text, skillId, images: [{kind:"data", data: base64Uri}] }`。
 */
async function invokePromptStream(payload, options = {}) {
    return sseStream("/rs_prompts/stream_generate_prompt", options, payload);
}

/**
 * 创建 SSE 流 → textarea「输出框」处理器（NeoPromptAgent 节点与画廊弹窗共用）：
 * - 正文先攒进 accumulated，rAF 到点才刷 UI，避免逐 token 重排
 * - thinking 块实时显示在 textarea 上方临时面板（跟随滚底），正文出现/流结束时清除，不写入提示词
 * - status 块显示为流程状态行（技能生成 / H3 自检等阶段），保留到流结束供回看，仅出错时清除
 * - replace 块整段替换已透传的正文
 * @param {Object} opts - { textarea, refreshPreview?, onDone?(accumulated), onError?(err) }
 * @returns {{onChunk: Function, onDone: Function, onError: Function, flush: Function}}
 *         前三个直接传给 sseStream/invokePromptStream；flush 供调用方在收尾块补落正文
 */
function createStreamOutputHandlers({ textarea, refreshPreview, onDone, onError }) {
    let rafId = null;
    let accumulated = "";
    const wrapper = textarea.parentElement;
    function flush() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        if (accumulated) {
            textarea.value = accumulated;
            textarea.scrollTop = textarea.scrollHeight;
            refreshPreview?.();
        }
    }
    // 思考过程（reasoning_content）：临时面板只用于展示，不写入提示词
    let thinkingEl = null;
    let thinkingBuf = "";
    let thinkingRaf = null;
    function ensureThinkingEl() {
        if (thinkingEl) return thinkingEl;
        thinkingEl = mkEl("div", "rs-thinking");
        const label = mkEl("div", "rs-thinking-label");
        label.textContent = t("思考中…");
        thinkingEl.appendChild(label);
        thinkingEl.appendChild(mkEl("div", "rs-thinking-body"));
        wrapper.insertBefore(thinkingEl, textarea);
        return thinkingEl;
    }
    function clearThinking() {
        if (thinkingRaf) { cancelAnimationFrame(thinkingRaf); thinkingRaf = null; }
        if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
    }
    // 流程状态（技能生成 / H3 格式自检等阶段）：复用思考面板样式，逐条累计展示
    let statusEl = null;
    function showStatus(msg) {
        if (!statusEl) {
            statusEl = mkEl("div", "rs-thinking");
            const label = mkEl("div", "rs-thinking-label");
            label.textContent = t("处理流程");
            statusEl.appendChild(label);
            statusEl.appendChild(mkEl("div", "rs-thinking-body"));
            wrapper.insertBefore(statusEl, textarea);
        }
        const body = statusEl.querySelector(".rs-thinking-body");
        body.textContent += (body.textContent ? "\n" : "") + msg;
        // 内联 display 必须显式设为可见值（同思考面板：设 "" 会回落到 .rs-thinking{display:none}）
        statusEl.style.display = "block";
        statusEl.scrollTop = statusEl.scrollHeight;
    }
    function clearStatus() {
        if (statusEl) { statusEl.remove(); statusEl = null; }
    }
    return {
        onChunk: (chunk) => {
            if (!chunk || !chunk.text) return;
            if (chunk.kind === "status") {
                // 流程阶段上报：只显示状态行，不写入提示词
                showStatus(chunk.text);
                return;
            }
            if (chunk.kind === "replace") {
                // H3 窄修复采纳后整段替换已透传的正文
                if (thinkingEl) clearThinking();
                accumulated = chunk.text;
                if (!rafId) rafId = requestAnimationFrame(flush);
                return;
            }
            if (chunk.kind === "thinking") {
                thinkingBuf += chunk.text;
                // 内联 display 必须显式设为可见值：设成 "" 会移除内联样式、回落到 .rs-thinking{display:none}，面板就永远不可见
                ensureThinkingEl().style.display = "block";
                if (!thinkingRaf) {
                    thinkingRaf = requestAnimationFrame(() => {
                        thinkingRaf = null;
                        if (thinkingEl) {
                            thinkingEl.querySelector(".rs-thinking-body").textContent = thinkingBuf;
                            // 面板 max-height:40% + overflow-y:auto，思考增长后必须跟随滚到底部，否则停在顶部看不到打字效果
                            thinkingEl.scrollTop = thinkingEl.scrollHeight;
                        }
                    });
                }
                return;
            }
            // 正文开始：思考完成，清除思考面板（状态行保留到流结束，供回看自检/修复结果）
            if (thinkingEl) clearThinking();
            accumulated += chunk.text;
            if (!rafId) rafId = requestAnimationFrame(flush);
        },
        // 取消尚未执行的合并帧后把 accumulated 落进 textarea，再交给调用方做收尾（如持久化 widget）
        onDone: () => {
            flush();
            clearThinking();
            onDone?.(accumulated);
        },
        onError: (err) => {
            // 取消未执行的合并帧，避免出错后部分正文被刷进 textarea（失败时输入框保持原文）
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            clearThinking();
            clearStatus();
            onError?.(err);
        },
        flush,
    };
}

// ==========================================
// 提示词服务包装器 - 为节点行为模块提供统一的 API 调用接口
// ==========================================

/**
 * 创建提示词服务包装器
 * 将原有的 API 函数包装成便于测试和使用的接口
 */
function createPromptService() {
    return {
        /**
         * 增强提示词（非流式）
         */
        async enhance(text) {
            return await enhancePrompt(text);
        },

        /**
         * 增强提示词（流式）
         */
        async enhanceStream(text, options) {
            return await enhancePromptStream(text, options);
        },

        /**
         * 翻译提示词（非流式）
         */
        async translate(text) {
            return await translatePrompt(text);
        },

        /**
         * 翻译提示词（流式）
         */
        async translateStream(text, options) {
            return await translatePromptStream(text, options);
        },

        /**
         * 智能提示词 - LLM 直接判断用户意图并生成/改写（非流式）
         */
        async smart(text, description) {
            return await smartPrompt(text, description);
        },

        /**
         * 智能提示词 - 流式
         */
        async smartStream(text, description, options) {
            return await smartPromptStream(text, description, options);
        },

        /**
         * 随机生成提示词
         */
        async random() {
            return await randomPrompt();
        }
    };
}

// 创建单例实例
const promptService = createPromptService();

// ==========================================
// 导出
// ==========================================

export {
    enhancePrompt,
    enhancePromptStream,
    translatePrompt,
    translatePromptStream,
    savePrompt,
    loadPrompt,
    listPrompts,
    listPromptLines,
    deletePrompt,
    extractTitle,
    extractClassify,
    randomPrompt,
    randomPrompts,
    smartPrompt,
    smartPromptStream,
    sseStream,
    getAvailableModels,
    setCurrentModel,
    createPromptService,
    // 远程 LLM 配置相关
    getRemoteLLMConfig,
    saveRemoteLLMConfig,
    testLLMConnection,
    getLLMMode,
    fileToBase64,
    imagesFromClipboard,
    invokePromptStream,
    createStreamOutputHandlers
};

export default promptService;

// ==========================================
// 暴露到全局 window 对象 (供模态框使用)
// ==========================================
if (typeof window !== 'undefined') {
    // Namespace to avoid conflicts with other extensions
    if (!window.NeoNodes) {
        window.NeoNodes = {};
    }
    window.NeoNodes.getRemoteLLMConfig = getRemoteLLMConfig;
    window.NeoNodes.saveRemoteLLMConfig = saveRemoteLLMConfig;
    window.NeoNodes.testLLMConnection = testLLMConnection;
    window.NeoNodes.getLLMMode = getLLMMode;
}
