/**
 * agent-panel.js — Neo Agent 面板（Neo Studio 桌面端 Studio 页右栏）
 *
 * 聊天区挂桌面端右栏：一次「✨ 生成」交给后端智能体（POST /neo_agent/run 的 SSE 时间线：
 * 计划 / 工具卡 / 状态 / 产物图 / 暂停 / 继续 / 最终回答），后端那一侧是 MCP 客户端，工具经
 * mcp_server 的 JSON-RPC 走，右栏不直接调后端函数；右栏不再选技能，界面当前状态（当前页 /
 * 当前导演配方 / 绘画页模式 / 素材库目录）由宿主随请求体交给后端进系统提示词。MCP 区
 * （注册表 / 连接 / 工具调用）交给设置页的「MCP 服务」栏，右栏只在输入框底栏留一个跳转入口；用户级偏好走同一条路，表单在设置页「智能体偏好」栏，右栏的 ⚙ 与焦点链上的「设为偏好」都只做跳转。
 * 输入框按 Cline 的口径做：只读上下文条、附件图 chip、文本框，底栏一行是 📎 附件图、🔌 MCP、
 * 「📝 计划 / ⚡ 执行」与右下角主按钮（生成 / 暂停 / 继续）；整行「⏹ 取消」只在跑起来之后出现。
 * 空态按 Cline 首页 RECENT 的口径默认铺最近几条会话，点一行直接读回那条会话续聊。时间线里的选项确认卡
 * （后端 ask_user 发一问就挂在循环上，点选经 POST /neo_agent/answer 交回去）；最终回答末尾的
 * 「下一步选项」编号列表铺成一排可点的方向，点一下即把这句话当作下一轮输入发出。
 * stdio 型 MCP 服务是子进程，浏览器起不了，连接只活在桌面端进程里：面板只发 HTTP 打 /neo_mcp/*，
 * 桌面端服务不在时这些接口回 409，面板据此把 MCP 区收成一句离线说明，不给假成功。
 * 宿主是 studio 外壳（studio-app.js 挂右栏与设置页），不是 ComfyUI 画布侧栏：本模块不注册扩展。
 * 样式全在 agent-panel.css，作用域收在 .neo-agent 下。
 */
import { mkEl } from "./dom-utils.js";
import { isMediaHref, mediaKindOf } from "./js/core/media-href.js";
import { app } from "../../scripts/app.js";
import { t, tf } from "./js/core/i18n.js";
import { COMMON_EDGES, COMMON_RATIOS, LORA_FAMILY_HINTS, modelFamily } from "./image-gen.js";
import { icon, setIcon } from "./js/core/icons.js";
import { renderMarkdown } from "./skill.js";
import { fileToBase64, imagesFromClipboard, sseStream } from "./prompt-service.js";
import { Lightbox } from "./lightbox.js";
import { grabDataType, copyGalleryToInput } from "./media-transfer.js";
import { createFramePlayer } from "./live-preview.js";
import { DIRECTOR_RECIPE_SAVED_EVENT } from "./director.js";

const AGENT_CSS_HREF = "/extensions/comfyui-neo-studio/agent-panel.css";

const OFFLINE_HINT = t("MCP 连接由 Neo Studio 桌面端提供：桌面端服务未就绪时无法连接外部 MCP 服务");

// focus 帧里的键 → 右栏 chip 上的标签：与后端 _focus_block 是同一批事实，只挑用户在右栏认得出
// 的那几项（产物图与最近任务在工具卡上本来就看得见，不重复铺）
const FOCUS_FACTS = [["skill_id", "技能"], ["model", "主模型"], ["loras", "LoRA"],
                     ["width", "宽"], ["height", "高"], ["seed", "种子"], ["recipe", "导演配方"]];
// 偏好表单的字段：与后端 _clean_prefs 收净的那六个一一对应。技能 / 尺寸 / 家族是枚举值，
// 直接给固定下拉（select）；风格要求与要避开的是长文本（area），出片确认是开关（check）
const PREFS_FIELDS = [["preferred_skill", "技能", "select"], ["preferred_size", "尺寸", "select"],
                      ["preferred_family", "主模型家族", "select"], ["style_notes", "风格要求", "area"],
                      ["avoid", "要避开的", "area"], ["confirm_films", "出片前逐发确认", "check"]];
const PREFS_NONE = "不设（跟随每次输入）";
// 尺寸档位 = 生图的比例档 + 长边正方形档：与生图设置共用同一批常量，用户在两处看到的是同一套数
const PREFS_SIZE_STEPS = [...COMMON_RATIOS, ...COMMON_EDGES.map((e) => `${e}x${e}`)];
// 家族 = 家族线索（LORA_FAMILY_HINTS）在已装主模型路径里的命中集；一台模型都没装时回落线索全集，
// 下拉不空着——用户接着要装的那一发本来就在这份候选里
function modelFamilies(files) {
    const found = [];
    for (const f of files) {
        const hit = modelFamily(f);
        if (hit && !found.includes(hit)) found.push(hit);
    }
    return found.length ? found : [...LORA_FAMILY_HINTS];
}
// token 数在右栏那一栏宽里只写一档量级：24000 写作 24k，几百不缩写
const tokenText = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

const toast = (severity, detail) =>
    app.extensionManager?.toast?.add({ severity, summary: t("智能体"), detail, life: 4000 });

function ensureCss() {
    if (document.querySelector('link[data-neo-agent="1"]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = AGENT_CSS_HREF;
    link.setAttribute("data-neo-agent", "1");
    document.head.appendChild(link);
}

function sectionHead(title, actions) {
    const bar = mkEl("div", "neo-agent-head");
    const label = mkEl("span", "neo-agent-head-title");
    label.textContent = title;
    bar.appendChild(label);
    const tools = mkEl("span", "neo-agent-head-actions");
    (actions || []).forEach((btn) => tools.appendChild(btn));
    bar.appendChild(tools);
    return bar;
}

function headBtn(label, title, onClick) {
    const btn = mkEl("button", "neo-agent-head-btn");
    btn.type = "button";
    btn.replaceChildren(label);   // 文案字符串或图标节点都走这一条
    btn.title = title;
    btn.onclick = onClick;
    return btn;
}

// 底栏按钮的标签拆成图标与文字两段：栏子拖窄时容器查询只收文字（agent-panel.css 的
// @container (max-width: 300px)），字形留下，主按钮不会被栏子的 overflow: hidden 裁掉。
// 图标 span 带尾随空格，两段拼起来与整串标签逐字相同；整串进 aria-label，文字收掉后还能认出按钮
function labelSpans(btn, label) {
    const cut = label.indexOf(" ");
    if (cut < 0) {
        btn.textContent = label;
        return;
    }
    const icon = mkEl("span", "neo-agent-btn-icon");
    icon.textContent = label.slice(0, cut + 1);
    const text = mkEl("span", "neo-agent-btn-text");
    text.textContent = label.slice(cut + 1);
    btn.replaceChildren(icon, text);
    btn.setAttribute("aria-label", label);
}

async function getJson(path) {
    const res = await fetch(path);
    if (res.status === 409 || res.status === 404) return { offline: true };
    return await res.json();
}

async function postJson(path, body) {
    const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 404) return { offline: true };
    return await res.json();
}

// 智能体写完配方要广播编辑器保存那一条同一个事件：导演页左栏的配方列表、节点内时间轴
// 都监听它，收不到就只能等下一次建页。结果文本是 MCP 回的 JSON（带 name），
// 被后端 RESULT_CLIP 裁断时解析不动，就当这一发没写成交互
const RECIPE_WRITE_TOOLS = { director_save: true, director_copy: true };
function savedRecipeName(tool, text) {
    if (!RECIPE_WRITE_TOOLS[tool]) return "";
    try { return String(JSON.parse(text)?.name || "").trim(); } catch { return ""; }
}

// 素材库卡片可拖的图片后缀：与 prompts._read_image_raw 认的那一集对齐。heic / tiff 这类
// 放进来只会得到一张复制成功、后端解不动、最后静默消失的缩略图
const GALLERY_IMAGE = /\.(png|jpe?g|gif|webp|bmp)(?=&|#|$)/i;

// 附件缩略图地址：本地文件是 data URI，素材库拖入的是 copy_to_input 落进 input 后的那张
const attSrc = (a) => a.data || `/view?filename=${encodeURIComponent(a.input)}&type=input`;

// 最终回答末尾的「下一步选项」：模型在收场那段里列的编号方向。ask_user 的选项卡只在循环挂着时
// 能点，跑完那一轮这些方向此前只是一段文本，用户只能自己抄进输入框再点一次生成。
// 标题是必须的：计划模式交出的同样是一串编号步骤，只按编号认列表就会把计划照抄成一排按钮。
const OPT_ITEM = /^\s*(?:[1-9]\d*[.)]|[-*+])\s+(.+)$/;
const OPT_MAX = 6;

/** 标题行只认一行的短标题（「下一步选项」「Options」）：带两个关键词的长句子是正文。 */
function isOptionsTitle(raw) {
    const line = raw.replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/[：:]\s*$/, "").trim();
    if (!line || line.length > 24) return false;
    if (/^(next\s+)?(options?|choices?|directions?)\b/i.test(line)) return true;
    return /下一步|接下来|后续/.test(line) && /选项|方向|建议|操作|做法/.test(line);
}

/** 从回答原文里摘出末尾的选项块，交回去掉这一块的正文、标题与选项文本；摘不动回 null。 */
function splitAnswerOptions(text) {
    const lines = String(text || "").split("\n");
    let head = -1;
    let fence = false;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }   // 代码块里的编号列表是样例，不是方向
        if (fence) continue;
        if (isOptionsTitle(lines[i])) head = i;   // 一轮里可能两次列方向，只认最后一个标题
    }
    if (head < 0) return null;
    const items = [];
    let end = head;
    for (let i = head + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const hit = OPT_ITEM.exec(line);
        if (!hit) break;
        items.push(hit[1].replace(/\*\*/g, "").trim());
        end = i;
    }
    if (items.length < 2 || items.length > OPT_MAX) return null;
    return {
        title: lines[head].replace(/^#+\s*/, "").replace(/\*\*/g, "").trim(),
        items,
        body: lines.slice(0, head).concat(lines.slice(end + 1)).join("\n").trim(),
    };
}

// ==========================================
// 聊天区：一问一答，正文按 Markdown 渲染
// ==========================================

function buildChat(onOpenMcp, getContext, onOpenPrefs, onFrame, previewSide) {
    const box = mkEl("div", "neo-agent-section neo-agent-chat");
    const transcript = mkEl("div", "neo-agent-transcript");
    const empty = mkEl("div", "neo-agent-empty");
    renderEmpty();
    transcript.appendChild(empty);
    // 历史列表与时间线互斥显示：列表整页铺满右栏，读回的旧会话落回时间线本体
    const historyBox = mkEl("div", "neo-agent-history");
    historyBox.hidden = true;

    // 会话标题就是这一轮的第一句话，钉在时间线顶上（sticky 见 agent-panel.css 的 .neo-agent-titlebar）。
    // 时间线整栏重铺的三条路（新增会话、读回旧会话、删掉读回的会话）都要把它放回第一个子节点，
    // sticky 才有吸得住的位置
    const titleBar = mkEl("div", "neo-agent-titlebar");
    titleBar.hidden = true;
    function setConversationTitle(text) {
        titleBar.textContent = text ? "💬 " + text : "";
        titleBar.hidden = !text;
    }

    // 复制钮一轮只挂一枚，钉在最终回答之后，钮面用 Cline 那枚叠角方块：桌面窗口的 WebView2 只在 dev 态放行
    // Ctrl+C 与右键菜单（app/studio_app.py 把 AreBrowserAcceleratorKeysEnabled / AreDefaultContextMenusEnabled 绑到
    // debug），正文又常被宿主注入的 body{user-select:none;cursor:default} 压得选不动，复制这一句只剩按钮一条路。
    // 回合头右端再放一枚复制提问的，同一张问答卡片里就是两枚并排，分不出各复制哪一段。
    // 局域网 IP 访问不是安全上下文，navigator.clipboard 不存在，回落 execCommand
    function mkCopyBtn(host, getText) {
        const btn = mkEl("button", "neo-agent-copy");
        btn.type = "button";
        // 钮面只有图标、不写文案，界面上一句提示都没有；图标是 core/icons.js 的常量，划正文时带不走按钮字样
        const setState = (state) => setIcon(btn, state === "ok" ? "check" : state === "fail" ? "cross" : "copy");
        setState("idle");
        btn.onclick = () => {
            const feedback = (ok) => {
                setState(ok ? "ok" : "fail");
                setTimeout(() => { setState("idle"); }, 1500);
            };
            const value = getText();
            if (typeof navigator.clipboard?.writeText === "function") {
                navigator.clipboard.writeText(value).then(() => feedback(true), () => feedback(false));
                return;
            }
            const ta = mkEl("textarea");
            ta.value = value;
            ta.style.cssText = "position:absolute;opacity:0";
            document.body.appendChild(ta);
            ta.select();
            let ok = false;
            try { ok = document.execCommand("copy"); } catch (e) { /* 环境不支持 execCommand，按失败处理 */ }
            ta.remove();
            feedback(ok);
        };
        host.appendChild(btn);
    }

    const composer = mkEl("div", "neo-agent-composer");
    // 上下文条：宿主（studio-app.js）在切页 / 选配方 / 切绘画模式时把当前页签那一栏状态交过来。
    // 条上的 ✕ 是本轮取消位：用户点名「别管界面，照我写的做」时连这一栏也不交；点条恢复，
    // 宿主下一次刷新（切页 / 选配方 / 切模式）也恢复——取消位跨页留着，下一次点生成就没上下文了
    const ctxBar = mkEl("div", "neo-agent-ctx");
    const ctxText = mkEl("span", "neo-agent-ctx-text");
    const ctxOffBtn = mkEl("button", "neo-agent-ctx-off-btn");
    ctxOffBtn.type = "button";
    ctxOffBtn.textContent = "✕";
    ctxOffBtn.title = t("取消本轮上下文：这一轮不带界面状态，切页 / 选配方 / 切模式后自动恢复");
    ctxOffBtn.onclick = (e) => { e.stopPropagation(); ctxOff = true; renderCtx(); };
    ctxBar.onclick = () => { if (ctxOff) { ctxOff = false; renderCtx(); } };
    ctxBar.append(ctxText, ctxOffBtn);
    let ctxOff = false;
    const chips = mkEl("div", "neo-agent-chips");
    const input = mkEl("textarea", "neo-agent-input");
    input.rows = 3;
    input.placeholder = t("描述要生成的提示词，或要改写的方向；可粘贴 / 拖入图片（含素材库卡片）");
    // 框高跟着内容走：rows 只给初值，长提示词撑出来的高度在窗口里不会自己缩回，
    // 拖拽手柄一并禁掉（agent-panel.css 的 resize: none），发送与 Esc 后收回初值
    function fitInput() {
        input.style.height = "";
        const h = Math.min(input.scrollHeight || 0, 108);
        if (h > 0) input.style.height = h + "px";
    }

    // Cline 的口径：取消只在跑起来之后存在，整行铺在文本框上面，空闲时这一行不占位
    const cancelBar = mkEl("button", "neo-agent-cancelbar");
    cancelBar.type = "button";
    cancelBar.textContent = "⏹ " + t("取消");
    cancelBar.title = t("取消这次运行：断流并掐掉在跑的任务");
    cancelBar.hidden = true;
    cancelBar.onclick = () => stopRun();
    // 底栏一行：附件图 + MCP 入口 + 计划 / 执行 + 右下角主按钮。计划模式后端只把查询类工具交给 LLM
    const toolbar = mkEl("div", "neo-agent-toolbar");
    const modes = mkEl("div", "neo-agent-modes");
    let mode = "act";
    const modeBtns = [["plan", t("📝 计划")], ["act", t("⚡ 执行")]].map(([key, label]) => {
        const btn = mkEl("button", "neo-agent-mode-btn");
        btn.type = "button";
        btn.dataset.mode = key;
        labelSpans(btn, label);
        btn.title = key === "plan" ? t("只查询与规划，不执行生成") : t("按计划直接执行生成");
        btn.onclick = () => setMode(key);
        modes.appendChild(btn);
        return btn;
    });
    function setMode(next) {
        mode = next;
        modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === next));
    }
    setMode("act");
    const attach = mkEl("button", "neo-agent-attach");
    attach.type = "button";
    labelSpans(attach, "📎 " + t("添加图片"));
    attach.title = t("附加参考图（粘贴、从素材库拖入或点选，最多 6 张）");
    const fileInput = mkEl("input", "neo-agent-file");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.hidden = true;
    attach.onclick = () => fileInput.click();
    // MCP 注册表在设置页那一栏，这一行只留一个跳转入口
    const mcpEntry = mkEl("button", "neo-agent-entry");
    mcpEntry.type = "button";
    labelSpans(mcpEntry, "🔌 MCP");
    mcpEntry.title = t("MCP 服务设置");
    mcpEntry.onclick = () => onOpenMcp && onOpenMcp();
    // 主按钮在右下角，一个钮三态（生成 / 暂停 / 继续）——空闲时它就是发送键
    const run = mkEl("button", "neo-agent-run");
    run.type = "button";
    labelSpans(run, t("✨ 生成"));
    run.title = t("✨ 生成");
    toolbar.append(attach, fileInput, mcpEntry, modes, run);
    composer.append(ctxBar, chips, cancelBar, input, toolbar);

    // 界面当前状态：宿主只交当前选中页签自己那一栏（studio-app.js 的 agentContext 负责裁剪），
    // 这一条把它拼成一行给用户看，随请求体原样交后端
    const PAGE_NAMES = { gallery: "素材库", director: "导演页", paint: "绘画页", skills: "技能页", settings: "设置页" };
    function currentContext() {
        const ctx = (getContext && getContext()) || {};
        const parts = [];
        if (PAGE_NAMES[ctx.page]) parts.push(t(PAGE_NAMES[ctx.page]));
        if (ctx.recipe) parts.push(ctx.recipe + (ctx.segments > 0 ? tf("{n} 段", { n: ctx.segments }) : ""));
        if (ctx.paint_mode === "text") parts.push(t("文生图"));
        else if (ctx.paint_mode === "edit") parts.push(t("图片编辑"));
        if (ctx.gallery_path) parts.push(ctx.character_dir ? tf("{dir}（角色图）", { dir: ctx.gallery_path }) : ctx.gallery_path);
        return parts;
    }
    function ctxLine() { return ctxOff ? "" : currentContext().join(" · "); }
    function renderCtx() {
        const line = ctxLine();
        ctxText.textContent = "📍 " + (line || t(ctxOff ? "已取消上下文" : "无当前上下文"));
        ctxOffBtn.hidden = !line;
        ctxBar.classList.toggle("neo-agent-ctx-off", ctxOff);
        ctxBar.title = ctxOff ? t("点此恢复本轮界面上下文") : "";
    }
    function resetCtx() { ctxOff = false; }   // 宿主交来新状态 = 界面上下文回来
    renderCtx();

    // 附件图：本地文件读成 data URI 随请求体走（与 llm-chat 的附加图同一口径），
    // 后端按 prompts 的图片源解析并等比缩边，面板这边只管增删与预览
    const MAX_IMAGES = 6;
    const attachments = [];
    function renderChips() {
        chips.replaceChildren();
        attachments.forEach((img, i) => {
            const chip = mkEl("span", "neo-agent-chip");
            const thumb = mkEl("img");
            thumb.src = attSrc(img);
            thumb.alt = img.name || "";
            thumb.title = img.name || "";
            const del = mkEl("button", "neo-agent-chip-del");
            del.type = "button";
            del.textContent = "✕";
            del.title = t("移除");
            del.onclick = () => { attachments.splice(i, 1); renderChips(); };
            chip.append(thumb, del);
            chips.appendChild(chip);
        });
    }
    function rawFileToDataUri(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ data: String(reader.result), name: file.name });
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    }
    function addFiles(files) {
        Array.from(files || [])
            .filter((f) => f.type && f.type.startsWith("image/"))
            .forEach((f) => {
                if (attachments.length >= MAX_IMAGES) return;
                // 浏览器画不动的图（HEIC 这类）退回原始 data URI：后端 PIL 认得的原图比缩过的副本更值得给
                fileToBase64(f)
                    .catch(() => rawFileToDataUri(f))
                    .then((img) => {
                        if (!img) return;
                        attachments.push(img);
                        renderChips();
                    })
                    .catch(() => {});
            });
    }
    function clearAttachments() { attachments.length = 0; renderChips(); }
    fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ""; };
    input.addEventListener("paste", (e) => {
        const files = imagesFromClipboard(e);
        if (!files.length) return;
        e.preventDefault();
        addFiles(files);
    });
    composer.addEventListener("dragover", (e) => e.preventDefault());
    composer.addEventListener("drop", (e) => {
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) {
            e.preventDefault();
            addFiles(files);
            return;
        }
        addGalleryImage(e);   // 素材库卡片只带自定义 MIME，dataTransfer 里没有文件
    });
    // 素材库卡片拖入：载荷是 {filename, subfolder}，走 copy_to_input 落进 input 后按文件名引用
    // （与导演页参考图宫格同一通道）。视频音频挡在这一步——后端只把字节当图片喂给视觉模型，
    // 喂进去就是一次看不懂的失败；拖进来的是文字时载荷连 JSON 都不是，静默放过。
    function addGalleryImage(e) {
        const raw = grabDataType(e.dataTransfer);
        let payload = null;
        try { payload = JSON.parse(raw); } catch { return; }
        if (!payload || !payload.filename) return;
        e.preventDefault();
        if (attachments.length >= MAX_IMAGES) { toast("warning", tf("附件图最多 {n} 张", { n: MAX_IMAGES })); return; }
        if (!GALLERY_IMAGE.test(payload.filename)) { toast("warning", t("素材库里的视频和音频不能当参考图")); return; }
        copyGalleryToInput(raw)
            .then((copied) => {
                if (!copied) { toast("error", t("素材库图片复制失败")); return; }
                attachments.push({ input: copied, name: copied });
                renderChips();
            })
            .catch(() => toast("error", t("素材库图片复制失败")));
    }
    box.append(sectionHead(t("智能体"), [
        headBtn("＋", t("新增会话"), () => newSession()),
        headBtn("🗂", t("会话历史"), () => toggleHistory()),
        headBtn(icon("trash"), t("清空对话与历史"), () => clearConversation()),
        headBtn("⚙", t("智能体偏好"), () => onOpenPrefs && onOpenPrefs()),
    ]), transcript, historyBox, composer);

    // 时间线里的链接一律收在页面内：产物进弹出窗口，外部链接交给新窗口。放任 <a> 的默认行为
    // 就是整扇窗口翻到 /view 图片页——返回时 Studio 页重载，启动状态位与整条时间线一起没了
    transcript.addEventListener("click", (e) => {
        // Markdown 正文里的产物图：卡片里限高显示，点击进弹出窗口看大图，外链图交给新窗口
        const pic = e.target.closest ? e.target.closest(".neo-agent-answer img") : null;
        if (pic) {
            const src = pic.getAttribute("src") || "";
            if (isMediaHref(src)) Lightbox.open({ items: [{ kind: mediaKindOf(src), url: src, title: pic.alt || "" }], compact: true });
            else if (src) window.open(src, "_blank", "noopener");
            return;
        }
        const a = e.target.closest ? e.target.closest("a[href]") : null;
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href") || "";
        if (isMediaHref(href)) {
            Lightbox.open({ items: [{ kind: mediaKindOf(href), url: href, title: a.textContent || "" }], compact: true });
            return;
        }
        window.open(href, "_blank", "noopener");
    });

    // 产物缩略图：右栏窄，整幅铺图 / 铺片；点击进弹出窗口看大图与播放，页面自己不导航
    function renderGenMedia(host, media) {
        const box = mkEl("div", "neo-agent-media");
        const items = media.map((m) => ({ kind: m.kind || "image", url: m.url, title: m.title || "" }));
        media.forEach((m, i) => {
            const video = (m.kind || "image") === "video";
            const el = mkEl(video ? "video" : "img");
            el.src = m.url;
            el.loading = "lazy";
            el.title = video ? t("点击播放") : t("点击放大查看");
            if (video) {
                el.muted = true;
                el.preload = "metadata";
                el.setAttribute("playsinline", "true");
            }
            el.onclick = () => Lightbox.open({ items, index: i, compact: true });
            box.appendChild(el);
        });
        host.appendChild(box);
    }

    // 回答末尾的方向铺成一排可点的行（Cline 的口径：可选项是能点的按钮，不是让用户抄的文本）。
    // 点一下走的就是用户自己敲这句话那条路：填进输入框直接开跑。整行铺满栏宽、文字折行，
    // 右栏拖到 260px 下限也只是折行，不截断。
    function renderAnswerOptions(host, block) {
        const box = mkEl("div", "neo-agent-answer-opts");
        const title = mkEl("div", "neo-agent-answer-opts-title");
        title.textContent = "▶ " + block.title;
        box.appendChild(title);
        const pick = (item) => {
            if (running) return;
            box.classList.add("neo-agent-answer-opts-locked");
            box.querySelectorAll("button").forEach((b) => { b.disabled = true; });
            const chosen = mkEl("div", "neo-agent-answer-chosen");
            chosen.textContent = "✔ " + item;
            box.appendChild(chosen);
            input.value = item;
            generate();
        };
        block.items.forEach((item, i) => {
            const btn = mkEl("button", "neo-agent-answer-opt");
            btn.type = "button";
            btn.textContent = `${i + 1}. ${item}`;
            btn.title = item;
            btn.onclick = () => pick(item);
            box.appendChild(btn);
        });
        host.appendChild(box);
    }

    // 后端 /neo_agent/run 的时间线：计划一行、每次工具调用一张卡（参数 / 状态 / 结果），
    // 产物图铺在卡下，最终回答落在末尾
    function agentTimeline(answerBox) {
        const steps = mkEl("div", "neo-agent-steps");
        const final = mkEl("div", "neo-agent-answer-body");
        answerBox.append(steps, final);
        let card = null;
        let live = null;   // 当前工具卡上的采样预览播放器（live-preview.js），卡片切走即换
        let planBox = null;      // 执行清单那一块：后端每划掉一条重发整张，原地重铺
        let focusCard = null, focusChips = null, focusFacts = {};   // 焦点链卡与「设为偏好」照的这份
        let metaRow = null;      // 上下文与 token 统计共用的那一行
        const metaPart = (which) => {
            if (!metaRow) {
                metaRow = mkEl("div", "neo-agent-runmeta");
                steps.appendChild(metaRow);
            }
            const cls = "neo-agent-runmeta-" + which;
            let span = metaRow.querySelector("." + cls);
            if (!span) {
                span = mkEl("span", "neo-agent-runmeta-part " + cls);
                metaRow.appendChild(span);
            }
            return span;
        };
        const slot = (cls) => card && card.querySelector("." + cls);

        // 任务卡上的取消：后端 /neo_agent/cancel 走 MCP cancel_task，四种任务类型由它自己找路由
        function mkCancel(host, taskId) {
            const btn = mkEl("button", "neo-agent-cancel");
            btn.type = "button";
            btn.textContent = t("取消任务");
            btn.onclick = async () => {
                btn.disabled = true;
                const data = await postJson("/neo_agent/cancel", { task_id: taskId });
                btn.textContent = data.success ? t("已取消") : t("取消失败");
                btn.title = String(data.error || "");
            };
            host.appendChild(btn);
        }

        return {
            plan(text) {
                const row = mkEl("div", "neo-agent-step");
                row.textContent = "🧭 " + text;
                steps.appendChild(row);
            },
            toolCall(name, args) {
                card = mkEl("div", "neo-agent-tool");
                const title = mkEl("div", "neo-agent-tool-title");
                title.textContent = "🔧 " + name;
                const body = mkEl("pre", "neo-agent-tool-args");
                body.textContent = args;
                const preview = mkEl("div", "neo-agent-tool-preview neo-dtl-live");
                const status = mkEl("div", "neo-agent-tool-status");
                const out = mkEl("pre", "neo-agent-tool-out");
                card.append(title, body, preview, status, out);
                steps.appendChild(card);
                live = null;
            },
            status(text, taskId, preview) {
                const row = slot("neo-agent-tool-status");
                if (!row) return;
                row.textContent = text;
                if (taskId && !row.querySelector(".neo-agent-cancel")) mkCancel(row, taskId);
                // 采样预览走 SSE 的 status 帧（后端只发紧凑档、一步一份）；播放器自定帧率循环该步动画
                if (preview && Array.isArray(preview.frames) && preview.frames.length) {
                    const box = slot("neo-agent-tool-preview");
                    if (box) {
                        // reset() 把内联高度写成 0px 藏住面板；首个载荷到达时交回 CSS 的定高
                        live = live || createFramePlayer(box, () => { box.style.height = ""; });
                        live.apply(preview);
                    }
                }
            },
            toolResult(text, media) {
                const out = slot("neo-agent-tool-out");
                if (!out) return;
                out.textContent = text;
                const btn = slot("neo-agent-cancel");
                if (btn) btn.remove();       // 任务到终态，取消入口跟着收掉
                if (live) { live.pause(); live = null; }   // 预览定格在最后一帧，产物媒体条另铺在卡下
                if (media.length) renderGenMedia(card, media);
            },
            // 中途的选项确认：后端 ask_user 发一问就挂在循环上，点选即把方向交回 /neo_agent/answer。
            // 这一击必须能点：卡片在步骤区，主按钮在运行中是暂停态，两条路互不挡
            ask(question, options, askId) {
                const card = mkEl("div", "neo-agent-step neo-agent-choice");
                // 恢复出来的旧会话没有 run_id 可交：循环早收场了，这一击铺出来就是死钮
                const dead = !askId;
                const q = mkEl("div", "neo-agent-choice-q");
                q.textContent = "❓ " + question;
                const opts = mkEl("div", "neo-agent-choice-opts");
                const free = mkEl("input", "neo-agent-choice-free");
                free.placeholder = t("或自己写一个方向");
                const send = mkEl("button", "neo-agent-choice-send");
                send.type = "button";
                send.textContent = t("发送");
                const chosen = mkEl("div", "neo-agent-choice-chosen");
                const answer = (text) => {
                    [...opts.children].forEach((b) => { b.disabled = true; });
                    free.disabled = true;
                    send.disabled = true;
                    chosen.textContent = "✔ " + text;
                    card.appendChild(chosen);
                    postJson("/neo_agent/answer", { run_id: runId, ask_id: askId, text });
                };
                const sendFree = () => { const v = free.value.trim(); if (v) answer(v); };
                options.forEach((o) => {
                    const btn = mkEl("button", "neo-agent-choice-opt");
                    btn.type = "button";
                    btn.textContent = o;
                    btn.disabled = dead;
                    btn.onclick = () => answer(o);
                    opts.appendChild(btn);
                });
                free.disabled = dead;
                send.disabled = dead;
                send.onclick = sendFree;
                free.addEventListener("keydown", (e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    e.stopPropagation();
                    sendFree();
                });
                card.append(q, opts, free, send);
                steps.appendChild(card);
            },
            answer(text) {
                // 末尾的方向块从正文里摘出来铺成按钮：留着编号文本就等于同一份内容出现两遍
                const block = splitAnswerOptions(text);
                final.innerHTML = renderMarkdown(block ? block.body : text);
                if (block) renderAnswerOptions(final, block);
                mkCopyBtn(answerBox, () => text);   // 按钮落在正文容器外，划正文文本时不带进剪贴板
            },
            // 「⏹ 取消」落在步骤区，不覆盖最终回答那一行；取消请求本身失败要留在时间线上——
            // 主按钮在断流收尾时就被「✨ 生成」盖回去，写在那里没人看得见
            cancelled(note) {
                const row = mkEl("div", "neo-agent-step");
                row.textContent = "⏹ " + t("已取消") + (note ? "（" + note + "）" : "");
                steps.appendChild(row);
            },
            // 暂停 / 继续各落一行：暂停点在飞的任务由后端掐掉，恢复后要不要再生成由 LLM 定
            paused() {
                const row = mkEl("div", "neo-agent-step neo-agent-step-paused");
                row.textContent = "⏸ " + t("已暂停");
                steps.appendChild(row);
            },
            resumed() {
                const row = mkEl("div", "neo-agent-step");
                row.textContent = "▶ " + t("已继续");
                steps.appendChild(row);
            },
            // 执行清单：write_plan 交出整张，之后每划掉一条后端重发整张。一块列表原地重铺，
            // 逐帧追加就是刷屏
            planSteps(list) {
                if (!list.length) return;
                if (!planBox) {
                    planBox = mkEl("div", "neo-agent-plan");
                    steps.appendChild(planBox);
                }
                const rows = list.map((s, i) => {
                    const row = mkEl("div", "neo-agent-plan-row" + (s.done ? " neo-agent-plan-done" : ""));
                    row.textContent = `${s.done ? "✅" : "▢"} ${i + 1}. ${s.tool}`
                        + (s.key_args ? `（${s.key_args}）` : "") + (s.note ? `：${s.note}` : "");
                    return row;
                });
                const foot = mkEl("div", "neo-agent-plan-foot");
                foot.textContent = tf("{done}/{total} 已完成",
                    { done: list.filter((s) => s.done).length, total: list.length });
                planBox.replaceChildren(...rows);
                planBox.appendChild(foot);
            },
            // 焦点链落一块卡：本轮刚立的事实逐条铺成 chip，「设为偏好」照这一份填进偏好表单——
            // 用户不用自己抄技能名与宽高（后端逐轮重注入系统提示词的就是这一份）
            focus(focusObj) {
                if (!focusCard) {
                    focusCard = mkEl("div", "neo-agent-focus");
                    focusChips = mkEl("span", "neo-agent-focus-chips");
                    const btn = mkEl("button", "neo-agent-focus-prefs");
                    btn.type = "button";
                    btn.textContent = "⚙ " + t("设为偏好");
                    btn.title = t("把这一发的技能与尺寸写进偏好，下一条输入照它跑");
                    btn.onclick = () => onOpenPrefs && onOpenPrefs(focusFacts);
                    focusCard.append(focusChips, btn);
                    steps.appendChild(focusCard);
                }
                focusFacts = focusObj || {};
                const chips = FOCUS_FACTS
                    .filter(([key]) => focusFacts[key] !== undefined && focusFacts[key] !== null)
                    .map(([key, label]) => {
                        const chip = mkEl("span", "neo-agent-focus-chip");
                        const value = focusFacts[key];
                        chip.title = t(label);
                        chip.textContent = `${t(label)} ${Array.isArray(value) ? value.join(" / ") : value}`;
                        return chip;
                    });
                focusChips.replaceChildren(...chips);
            },
            // 上下文与 token 统计两帧都是「当前整份」：各占那一行里的一段，逐轮重写
            context(frame) {
                metaPart("ctx").textContent = "🧮 " + tf("上下文 ~{n}（{pct}%）",
                    { n: tokenText(frame.approx_tokens || 0), pct: Math.round((frame.ratio || 0) * 100) });
            },
            usage(frame) {
                metaPart("usage").textContent = "🧾 " + tf("token {total}（提示 {p} · 补全 {c}）· {n} 轮",
                    { total: tokenText(frame.total_tokens || 0), p: tokenText(frame.prompt_tokens || 0),
                      c: tokenText(frame.completion_tokens || 0), n: frame.turns || 0 });
            },
            // finish_task 的收场载荷：正文 + 产物 + 下一步方向。后端走这条收场时不发 content 帧，
            // 这一条就是最终回答的唯一落点；方向优先按正文里那段编号列表铺按钮，正文没有才用
            // finish 交下来的结构化方向
            finish(text, media, options) {
                const block = splitAnswerOptions(text);
                final.innerHTML = renderMarkdown(block ? block.body : text);
                if (media.length) renderGenMedia(final, media);
                const items = block ? block.items : (options || []);
                if (items.length >= 2) renderAnswerOptions(final, block || { title: t("下一步选项"), items });
                mkCopyBtn(answerBox, () => text);
            },
            error(text) {
                final.textContent = text;
                final.classList.add("neo-agent-answer-error");
            },
        };
    }

    // 运行中的这一路：暂停 / 继续按 run_id 打后端，取消要断流并停后端循环，句柄挂在这里
    let running = false;
    let paused = false;
    let controller = null;
    let runId = "";
    let activeView = null;
    let resumeId = "";
    let restartFrom = 0;   // 「从这条消息重新开始」的序号：旧会话里第几条用户消息（1 起），0 = 整条接上
    let historyOpen = false;
    let lastTurn = null;   // 上一发的原文、模式与附件图：失败收场那一行靠它原样重发

    // 「接上次会话」条铺在文本框上方，与「⏹ 取消」同一位置口径：打开过一条旧会话才出现，
    // 点一下断开。下一次「✨ 生成」带着 resume 打后端，旧对话原文接在系统提示词之后
    const resumeBar = mkEl("button", "neo-agent-resumebar");
    resumeBar.type = "button";
    resumeBar.hidden = true;
    resumeBar.onclick = () => { resumeId = ""; restartFrom = 0; renderResumeBar(); };
    composer.insertBefore(resumeBar, cancelBar);

    // 失败收场那一行：输入框在提交这一步就清空了，LLM 502 这类一次性失败要用户把整段提示词重打
    // 一遍是说不过去的。这一行按上一发的文本、模式与附件图原样重发；下一次提交与新会话收掉它
    const retryBar = mkEl("button", "neo-agent-retrybar");
    retryBar.type = "button";
    retryBar.hidden = true;
    retryBar.onclick = () => retryLastTurn();
    composer.insertBefore(retryBar, input);

    function showRetryBar() {
        if (!lastTurn) return;
        const head = lastTurn.text.length > 22 ? lastTurn.text.slice(0, 22) + "…" : lastTurn.text;
        retryBar.textContent = "🔁 " + t("重试") + (head ? " · " + head : "");
        retryBar.title = tf("按上一发原样重发（{mode}，附件图照带）：{text}",
            { mode: lastTurn.mode === "plan" ? t("计划") : t("执行"), text: lastTurn.text });
        retryBar.hidden = false;
    }

    // 重发走同一条提交路径：回填文本、模式与附件图，界面当前状态由 generate 现读——那一发跑期间
    // 用户切了页签或换了配方，重发就该带新的这一份，不该复活上一发的旧上下文
    function retryLastTurn() {
        if (running || !lastTurn) return;
        // 输入框里还写着东西就不动手：这一行重发的是上一发，把用户正在写的这一发覆盖掉是说不过去的
        if (input.value.trim() || attachments.length) {
            toast("warning", t("输入框里还有内容：清空后再点重试"));
            return;
        }
        retryBar.hidden = true;
        input.value = lastTurn.text;
        fitInput();
        setMode(lastTurn.mode);
        clearAttachments();
        lastTurn.files.forEach((a) => attachments.push({ ...a }));
        renderChips();
        generate();
    }

    function renderResumeBar() {
        resumeBar.hidden = !resumeId;
        resumeBar.textContent = resumeId
            ? "↩ " + t("接上次会话") + " " + resumeId.slice(0, 8)
                + (restartFrom ? " · " + tf("从第 {n} 条消息重开", { n: restartFrom }) : "")
            : "";
    }

    const SESSION_STATUS = { succeeded: "完成", failed: "失败", cancelled: "已取消",
                             interrupted: "中断", running: "在跑", error: "出错" };
    function sessionStatus(s) { return t(SESSION_STATUS[s] || s || "?"); }
    function sessionTime(sec) { return sec ? new Date(sec * 1000).toLocaleString() : "-"; }

    function showTranscript() {
        historyOpen = false;
        historyBox.hidden = true;
        transcript.hidden = false;
    }

    function sessionRow(s) {
        const row = mkEl("div", "neo-agent-session-row");
        const time = mkEl("span", "neo-agent-session-time");
        time.textContent = sessionTime(s.created);
        const tag = mkEl("span", "neo-agent-badge");
        tag.textContent = s.mode === "plan" ? t("计划") : t("执行模式");
        const text = mkEl("span", "neo-agent-session-text");
        text.textContent = s.text || t("（只给了附件图）");
        const note = mkEl("span", "neo-agent-session-note");
        note.textContent = sessionStatus(s.status) + " · " + tf("{n} 次工具", { n: s.tools || 0 })
            + (s.tokens ? " · ~" + tokenText(s.tokens) + " tokens" : "")
            + (s.focus_skill ? " · " + s.focus_skill : "")
            + (s.resume_of ? " · " + t("接上次会话") : "");
        const open = headBtn(t("打开"), t("读回这条会话的完整时间线"), () => openSession(s.run_id));
        // 会话文件删掉就没了，确认框挡在请求前面
        const del = headBtn(icon("trash"), t("删除这条会话"), async () => {
            if (!window.confirm(t("删除这条会话？"))) return;
            await postJson("/neo_agent/session/delete", { run_id: s.run_id });
            if (resumeId === s.run_id) { resumeId = ""; renderResumeBar(); }
            renderHistory();
        });
        row.append(time, tag, text, note, open, del);
        return row;
    }

    // 空态默认铺最近几条会话（Cline 首页 RECENT 的口径：进页面就能点开上一条接着聊）。
    // 摘要与「🗂」列表同源；桌面端服务回 409、请求直连不到或没有会话时，空态只剩提示行，不给假列表
    const RECENT_MAX = 3;
    function renderEmpty() {
        const hint = mkEl("div", "neo-agent-empty-hint");
        hint.textContent = t("输入需求，Enter 生成；右栏会带着界面当前状态去规划");
        empty.replaceChildren(hint);
    }
    async function renderRecent() {
        renderEmpty();
        let data;
        try {
            data = await getJson("/neo_agent/sessions");
        } catch {
            return;   // 钉在桌面端端口且 ComfyUI 没跑时，这条 comfy 归属的请求直连不到
        }
        const list = (data.sessions || []).slice(0, RECENT_MAX);
        if (data.offline || !list.length) return;
        const head = mkEl("div", "neo-agent-recent-head");
        const title = mkEl("span", "neo-agent-recent-title");
        title.textContent = t("最近");
        const all = mkEl("button", "neo-agent-recent-all");
        all.type = "button";
        all.textContent = t("查看全部 ›");
        all.onclick = () => renderHistory();
        head.append(title, all);
        const rows = mkEl("div", "neo-agent-recent");
        list.forEach((s) => {
            const row = mkEl("button", "neo-agent-recent-row");
            row.type = "button";
            const text = mkEl("span", "neo-agent-recent-text");
            text.textContent = s.text || t("（只给了附件图）");
            const time = mkEl("span", "neo-agent-recent-time");
            time.textContent = s.created ? new Date(s.created * 1000).toLocaleDateString() : "-";
            row.append(text, time);
            row.onclick = () => openSession(s.run_id);
            rows.appendChild(row);
        });
        empty.append(head, rows);
    }

    async function renderHistory() {
        const data = await getJson("/neo_agent/sessions");
        historyBox.replaceChildren();
        // 整页列表由「🗂」或「查看全部」铺满右栏：栏头自带 ✕，回时间线不用绕栏头那一排
        historyBox.appendChild(sectionHead(t("会话历史"), [headBtn("✕", t("关闭会话列表"), showTranscript)]));
        const note = mkEl("div", "neo-agent-history-note");
        if (data.offline) {
            note.textContent = t("桌面端服务读不回历史会话");
            historyBox.appendChild(note);
        } else {
            const list = data.sessions || [];
            if (!list.length) {
                note.textContent = t("还没有历史会话");
                historyBox.appendChild(note);
            }
            list.forEach((s) => historyBox.appendChild(sessionRow(s)));
        }
        historyOpen = true;
        transcript.hidden = true;
        historyBox.hidden = false;
    }

    function toggleHistory() {
        if (historyOpen) { showTranscript(); return; }
        renderHistory();
    }

    // 旧会话逐帧铺回现有时间线：跑完的循环没有可取消的任务（状态行不带取消钮），
    // 也没有可回答的问句（ask 卡在视图里按 askId 空挡置灰）
    function replayFrame(view, f) {
        const kind = f?.kind || "content";
        if (kind === "run") return;
        if (kind === "plan") view.plan(f.text || "");
        else if (kind === "tool_call") view.toolCall(f.tool || "?", f.text || "");
        else if (kind === "status") view.status(f.text || "", "");
        else if (kind === "tool_result") view.toolResult(f.text || "", f.media || []);
        else if (kind === "ask") view.ask(f.text || "", f.options || [], "");
        else if (kind === "paused") view.paused();
        else if (kind === "resumed") view.resumed();
        else if (kind === "plan_steps") view.planSteps(f.steps || []);
        else if (kind === "focus") view.focus(f.focus || {});
        else if (kind === "usage") view.usage(f);
        else if (kind === "context") view.context(f);
        else if (kind === "finish") view.finish(f.text || "", f.media || [], f.options || []);
        else view.answer(f.text || "");
    }

    // 「从这条消息重新开始」（Cline 的 fork 口径）：旧会话里每条用户消息给一个入口，点它就把下一条
    // 输入接在截断点之前——后端按序号把那条之后的原文丢掉（见 /neo_agent/run 的 from）。只有第一条
    // 用户消息时「从它重开」等于开一条新会话，那一排不铺
    function restartRows(rec) {
        const marks = [];
        (rec.messages || []).forEach((m, i) => { if (m && m.role === "user") marks.push(i); });
        if (marks.length < 2) return null;
        const box = mkEl("div", "neo-agent-restart");
        const title = mkEl("span", "neo-agent-restart-title");
        title.textContent = "↩ " + t("从这条消息重新开始");
        box.appendChild(title);
        marks.forEach((pos, idx) => {
            const line = String(rec.messages[pos].content || "").replace(/\s+/g, " ");
            const btn = mkEl("button", "neo-agent-restart-row");
            btn.type = "button";
            btn.textContent = `${idx + 1}. ${line.length > 40 ? line.slice(0, 40) + "…" : line}`;
            btn.title = t("从这条消息重新跑，这条之后的原文丢掉");
            btn.onclick = () => {
                restartFrom = idx + 1;
                resumeId = rec.run_id;
                renderResumeBar();
                [...box.querySelectorAll("button")].forEach((b) => b.classList.toggle("neo-agent-restart-on", b === btn));
            };
            box.appendChild(btn);
        });
        return box;
    }

    async function openSession(id) {
        const data = await getJson(`/neo_agent/session?run_id=${encodeURIComponent(id)}`);
        const rec = data.session;
        if (!rec) {
            toast("error", data.error || t("这条会话读不回来"));
            return;
        }
        showTranscript();
        transcript.replaceChildren();
        transcript.prepend(titleBar);
        setConversationTitle(rec.text || t("（只给了附件图）"));
        if (empty.parentNode) empty.remove();
        const head = mkEl("div", "neo-agent-session-head");
        const title = mkEl("span", "neo-agent-session-title");
        title.textContent = sessionTime(rec.created) + " · "
            + (rec.mode === "plan" ? t("计划") : t("执行模式")) + " · " + sessionStatus(rec.status);
        const hint = mkEl("span", "neo-agent-session-note");
        hint.textContent = t("输入下一句就接在这条会话后面");
        const del = headBtn(icon("trash"), t("删除这条会话"), async () => {
            if (!window.confirm(t("删除这条会话？"))) return;
            await postJson("/neo_agent/session/delete", { run_id: rec.run_id });
            resetTranscript();
            renderHistory();
        });
        head.append(title, hint, del);
        transcript.appendChild(head);
        const restart = restartRows(rec);
        if (restart) transcript.appendChild(restart);
        const view = agentTimeline(transcript);
        (rec.frames || []).forEach((f) => replayFrame(view, f));
        restartFrom = 0;
        resumeId = rec.run_id;
        renderResumeBar();
        transcript.scrollTop = transcript.scrollHeight;
    }

    // 「＋ 新增会话」（Cline New Task 的口径）：时间线收回空态、resumeId 清零，下一条消息开一条新会话；
    // 后端保存的会话原样留下，空态照铺最近列表
    function newSession() {
        resetTranscript();
        showTranscript();
    }

    // 收回空态：标题行跟着收起并占住第一个子节点，下一条消息一到就换成新的第一句话
    function resetTranscript() {
        transcript.replaceChildren();
        transcript.prepend(titleBar);
        transcript.appendChild(empty);
        titleBar.hidden = true;
        resumeId = "";
        retryBar.hidden = true;   // 「＋ 新增会话」与清空历史都收掉失败那一行
        renderResumeBar();
        renderRecent();
    }

    // 垃圾桶图标的「清空对话与历史」连着清后端保存的历史：删掉的是整目录里的会话文件，先确认再动手
    async function clearConversation() {
        newSession();
        if (!window.confirm(t("清空对话会同时删掉后端保存的历史会话，继续？"))) return;
        await postJson("/neo_agent/session/delete_all", {});
        renderRecent();   // 后端历史已清空：空态里的最近列表跟着收空，不能留在屏幕上
    }

    // 主按钮三态：空闲「✨ 生成」、运行中「⏸ 暂停」、暂停中「▶ 继续」。整行「⏹ 取消」跟着
    // 运行出现——Cline 的口径：没在跑就没有取消键，空闲时那一行不占位
    function setRunState(next) {
        const label = next === "run" ? t("✨ 生成")
            : next === "paused" ? t("▶ 继续") : t("⏸ 暂停");
        labelSpans(run, label);
        run.title = label;
        run.classList.toggle("neo-agent-paused", next === "paused");
        cancelBar.hidden = next === "run";
        // 跑起来之后不点第二下：上一轮留下的方向按钮整排锁住，本轮收场放开（点过的那组保持锁定，
        // 与 ask_user 选项卡同一口径）
        transcript.querySelectorAll(".neo-agent-answer-opts:not(.neo-agent-answer-opts-locked) .neo-agent-answer-opt")
            .forEach((b) => { b.disabled = next !== "run"; });
    }

    // 智能体路径：一次请求换一路 SSE。界面当前状态随请求体进后端系统提示词，
    // mode 决定计划还是执行，images 是附件图，preview_side 是这一轮要的采样预览档（中间舞台宽就要大档）
    async function runAgent(answer, text, planMode, images, context, markFail) {
        const view = agentTimeline(answer);
        activeView = view;
        controller = new AbortController();
        await sseStream("/neo_agent/run", {
            signal: controller.signal,
            onChunk: (frame) => {
                // 同一帧同时交中间舞台：右栏与舞台各自画当前这一轮，先后无干系
                if (onFrame) onFrame(frame);
                const kind = frame?.kind || "content";
                if (kind === "run") { runId = frame.run_id || ""; return; }
                if (kind === "plan") view.plan(frame.text || "");
                else if (kind === "tool_call") view.toolCall(frame.tool || "?", frame.text || "");
                else if (kind === "status") view.status(frame.text || "", frame.task_id || "", frame.preview);
                else if (kind === "tool_result") {
                    view.toolResult(frame.text || "", frame.media || []);
                    // 配方落盘只发生在后端，界面这一侧要有人接：广播后导演页左栏刷新并选中新配方，
                    // 用户点开即进编辑器调整，跑整片与单段都在那里复用同一份配方
                    const saved = savedRecipeName(frame.tool || "", frame.text || "");
                    if (saved) {
                        window.dispatchEvent(new CustomEvent(DIRECTOR_RECIPE_SAVED_EVENT,
                            { detail: { name: saved, created: true } }));
                        toast("info", tf("配方「{name}」已保存，在导演页配方列表里打开调整", { name: saved }));
                    }
                }
                else if (kind === "ask") view.ask(frame.text || "", frame.options || [], frame.ask_id || "");
                else if (kind === "paused") { paused = true; setRunState("paused"); view.paused(); }
                else if (kind === "resumed") { paused = false; setRunState("running"); view.resumed(); }
                else if (kind === "plan_steps") view.planSteps(frame.steps || []);
                else if (kind === "focus") view.focus(frame.focus || {});
                else if (kind === "usage") view.usage(frame);
                else if (kind === "context") view.context(frame);
                else if (kind === "finish") view.finish(frame.text || "", frame.media || [], frame.options || []);
                else view.answer(frame.text || "");
                transcript.scrollTop = transcript.scrollHeight;
            },
            // 后端两条失败口径都汇到这一条（raw [ERROR] 行与 content 帧里的 [ERROR] 前缀），
            // 用户主动取消的断流不走这条，那一行不会在取消后铺出来
            onError: (err) => { markFail(); view.error(String(err || t("生成失败"))); },
        }, { text, mode: planMode, images, context, preview_side: previewSide && previewSide(), resume: resumeId || undefined, from: restartFrom || undefined });
    }

    // 「⏸ 暂停」只置后端一个位，SSE 不断：后端在下一个轮次 / 轮询边界把在飞的任务掐掉、发
    // paused 帧挂住循环。首帧 run_id 还没到就没有可暂停的运行。按钮先翻成「继续」，
    // paused 帧到了会再对一次——两边对不上时以帧为准
    async function pauseRun() {
        if (!running || !runId) return;
        const data = await postJson("/neo_agent/pause", { run_id: runId });
        if (!data.success) {
            toast("error", data.offline ? t("桌面端服务未就绪") : (data.error || t("暂停失败")));
            return;
        }
        paused = true;
        setRunState("paused");
    }

    // 「▶ 继续」放开挂在检查点上的循环。后端在暂停中不自动重发被取消的任务，
    // 要不要再生成由恢复后的那一轮 LLM 自己定
    async function resumeRun() {
        if (!running || !runId) return;
        const data = await postJson("/neo_agent/resume", { run_id: runId });
        if (!data.success) {
            toast("error", data.offline ? t("桌面端服务未就绪") : (data.error || t("继续失败")));
            return;
        }
        paused = false;
        setRunState("running");
    }

    // 「⏹ 取消」：断流 + 让后端停循环并掐在跑的任务（后端同时放开 resume，挂在暂停检查点上的
    // 循环也退得出来）。首帧的 run_id 还没到就只断流——断开路径上后端会兜底掐任务，
    // 不给一个空 run_id 去打接口
    async function stopRun() {
        if (!running || !controller) return;
        run.disabled = true;
        cancelBar.hidden = true;
        labelSpans(run, t("⏳ 取消中"));
        controller.abort();
        let note = "";
        if (runId) {
            // 断流已经生效，取消请求发不出去也不能演成「取消中」吊在那儿：把失败写进时间线
            let data = { success: false };
            try {
                data = await postJson("/neo_agent/cancel", { run_id: runId });
            } catch (e) {
                data.error = String(e);
            }
            if (!data.success) note = t("取消失败");
        }
        if (activeView) activeView.cancelled(note);
    }


    async function generate() {
        if (running) return;
        retryBar.hidden = true;
        const text = input.value.trim();
        // 只给图不给字是合法输入（看图说话），两头都空才拦。素材库拖入的图已在 input 目录里，
        // 按文件名给后端（与绘画页参考图同一口径），本地粘贴 / 选图仍是 data URI
        const images = attachments.map((a) => (a.data ? { kind: "data", data: a.data } : { kind: "input", value: a.input }));
        if (!text && !images.length) return;
        // 发出去的话交进时间线留档，输入框立刻清出来：一条长提示词留在框里只挡下一句
        input.value = "";
        fitInput();
        // 交回焦点：整段原文留在时间线里可复制，输入框清空后不抢焦点的话，下一句要点一下框才写得到
        input.focus();

        if (titleBar.hidden) {
            transcript.prepend(titleBar);
            setConversationTitle(text);
        }
        const planMode = mode;
        const context = ctxOff ? null : (getContext && getContext()) || null;
        // 附件图在这一步就清空了，文本与模式也一样：失败收场要原样重发，就得在这一发交出去之前
        // 把三份都留在面板里。重发是新的一轮，不带 resume 与「从这条消息重开」
        lastTurn = { text, mode: planMode, files: attachments.map((a) => ({ ...a })) };
        let failed = false;
        if (empty.parentNode) empty.remove();
        const turn = mkEl("div", "neo-agent-turn");
        const meta = mkEl("div", "neo-agent-meta");
        meta.textContent = (ctxLine() || t("无当前上下文"))
            + (planMode === "plan" ? " · " + t("计划") : "")
            + (resumeId ? " · " + t("接上次会话") : "")
            + (restartFrom ? " · " + tf("从第 {n} 条消息重开", { n: restartFrom }) : "");
        const ask = mkEl("div", "neo-agent-ask");
        ask.textContent = text;
        turn.appendChild(meta);
        turn.appendChild(ask);
        if (images.length) {
            const strip = mkEl("div", "neo-agent-ask-media");
            attachments.forEach((a) => {
                const thumb = mkEl("img");
                thumb.src = attSrc(a);
                strip.appendChild(thumb);
            });
            turn.appendChild(strip);
        }
        const answer = mkEl("div", "neo-agent-answer");
        turn.appendChild(answer);
        transcript.appendChild(turn);
        transcript.scrollTop = transcript.scrollHeight;
        clearAttachments();
        renderCtx();

        running = true;
        paused = false;
        // 运行中主按钮不锁：这一击就是「暂停」，锁掉等于把暂停键从界面上摘掉
        setRunState("running");
        // 运行中锁模式：一轮跑到一半换模式等于把工具表从脚下抽走，计划要留到下一轮
        modeBtns.forEach((b) => { b.disabled = true; });
        try {
            await runAgent(answer, text, planMode, images, context, () => { failed = true; });
        } catch (e) {
            failed = true;
            answer.textContent = String(e);
            answer.classList.add("neo-agent-answer-error");
        } finally {
            running = false;
            paused = false;
            controller = null;
            runId = "";
            activeView = null;
            run.disabled = false;
            setRunState("run");
            modeBtns.forEach((b) => { b.disabled = false; });
            if (failed) showRetryBar();
        }
    }

    // 主按钮一个钮三态：空闲生成、运行中暂停、暂停中继续
    run.onclick = () => {
        if (!running) return generate();
        return paused ? resumeRun() : pauseRun();
    };
    input.addEventListener("input", fitInput);

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            if (!running) generate();
        }
        if (e.key === "Escape" && !running) {
            // Esc 收掉写了一半的长提示词：写过整段的原文在时间线里可复制，框里清空重开
            e.preventDefault();
            e.stopPropagation();
            input.value = "";
            fitInput();
        }
    });

    renderRecent();
    return { box, renderCtx, resetCtx };
}



// ==========================================
// MCP 服务面板（设置页「MCP 服务」栏）：注册表 / 连接 / 工具调用
// ==========================================

function contentText(result) {
    const blocks = (result && result.content) || [];
    const text = blocks.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
    return text || t("无内容");
}

/**
 * 挂出 MCP 服务面板。返回 { root, refresh }：refresh 拉注册表与已连服务的工具表，
 * 宿主在栏子激活时调。
 */
export function createMcpPanel() {
    ensureCss();
    const root = mkEl("div", "neo-agent");
    const box = mkEl("div", "neo-agent-section neo-agent-mcp");
    const body = mkEl("div", "neo-agent-mcp-body");
    const status = mkEl("div", "neo-agent-status");
    const editor = mkEl("textarea", "neo-agent-json");
    editor.spellcheck = false;
    editor.rows = 12;
    const editorBox = mkEl("div", "neo-agent-editor");
    editorBox.hidden = true;
    const saveBtn = headBtn(t("保存注册表"), t("写回数据根的 configs/mcp_servers.json"), saveRegistry);
    const editorHead = mkEl("div", "neo-agent-editor-head");
    editorHead.appendChild(saveBtn);
    editorBox.append(editorHead, editor);

    box.append(sectionHead(t("MCP 服务"), [
        headBtn("{ }", t("编辑注册表"), () => { editorBox.hidden = !editorBox.hidden; }),
        headBtn("⟳", t("刷新"), () => load()),
    ]), status, body, editorBox);

    let servers = [];
    let toolsList = null;

    function note(text, kind) {
        status.textContent = text || "";
        status.className = "neo-agent-status" + (kind ? " neo-agent-status-" + kind : "");
    }

    function emptyHint(text) {
        body.innerHTML = "";
        const hint = mkEl("div", "neo-agent-empty");
        hint.textContent = text;
        body.appendChild(hint);
    }

    async function saveRegistry() {
        let parsed;
        try {
            parsed = JSON.parse(editor.value || "[]");
        } catch (e) {
            note(t("注册表不是合法 JSON"), "err");
            return;
        }
        const res = await postJson("/neo_mcp/servers", { servers: parsed });
        if (res.offline) { note(OFFLINE_HINT, "warn"); return; }
        if (!res.success) { note(res.error || t("保存失败"), "err"); return; }
        note(t("已保存"), "ok");
        await load();
    }

    function renderServers(connected) {
        if (!servers.length) {
            emptyHint(t("还没有 MCP 服务：点 { } 编辑注册表"));
            return;
        }
        servers.forEach((srv) => {
            const on = connected.includes(srv.name);
            const row = mkEl("div", "neo-agent-row");
            const dot = mkEl("span", "neo-agent-dot" + (on ? " neo-agent-dot-on" : ""));
            const name = mkEl("span", "neo-agent-name");
            name.textContent = srv.name;
            const badge = mkEl("span", "neo-agent-badge");
            badge.textContent = srv.transport;
            const btn = mkEl("button", "neo-agent-row-btn");
            btn.type = "button";
            btn.textContent = on ? t("断开") : t("连接");
            btn.onclick = async () => {
                btn.disabled = true;
                const res = await postJson(on ? "/neo_mcp/disconnect" : "/neo_mcp/connect", { name: srv.name });
                btn.disabled = false;
                if (res.offline) { note(OFFLINE_HINT, "warn"); return; }
                if (!res.success) note(res.error || t("连接失败"), "err");
                await load();
            };
            row.append(dot, name, badge, btn);
            body.appendChild(row);
        });
    }


    function renderTools(tools) {
        // 每次重画先摘掉上一套工具卡：断开之后 tools 为空，留下的卡片等于给用户一排还能点的按钮
        if (toolsList) { toolsList.remove(); toolsList = null; }
        if (!tools.length) return;
        const list = mkEl("div", "neo-agent-tools");
        tools.forEach((tool) => {
            const card = mkEl("div", "neo-agent-tool" + (tool.enabled ? "" : " neo-agent-tool-off"));
            const title = mkEl("div", "neo-agent-tool-name");
            title.textContent = tool.name;
            const from = mkEl("span", "neo-agent-badge");
            from.textContent = tool.server;
            title.appendChild(from);
            const desc = mkEl("div", "neo-agent-tool-desc");
            desc.textContent = tool.description || "";
            const args = mkEl("textarea", "neo-agent-tool-args");
            args.spellcheck = false;
            args.rows = 3;
            args.hidden = true;
            // 服务端 _meta.example 是能直接跑通的参数样例；没有样例时退回必填项空壳
            args.value = JSON.stringify(tool.example && Object.keys(tool.example).length
                ? tool.example
                : Object.fromEntries((tool.required || []).map((k) => [k, ""])), null, 2);
            const result = mkEl("pre", "neo-agent-tool-result");
            result.hidden = true;
            const runBtn = mkEl("button", "neo-agent-row-btn");
            runBtn.type = "button";
            runBtn.textContent = t("执行");
            runBtn.hidden = true;
            runBtn.onclick = async () => {
                let payload;
                try {
                    payload = JSON.parse(args.value || "{}");
                } catch (e) {
                    result.hidden = false;
                    result.textContent = t("参数不是合法 JSON");
                    return;
                }
                result.hidden = false;
                result.textContent = t("调用中…");
                const res = await postJson("/neo_mcp/tools/call",
                    { name: tool.server, tool: tool.name, arguments: payload });
                result.textContent = res.offline ? OFFLINE_HINT
                    : (res.success ? contentText(res.result) : (res.error || t("调用失败")));
            };
            const toggle = mkEl("button", "neo-agent-row-btn");
            toggle.type = "button";
            toggle.textContent = t("调用");
            toggle.onclick = () => {
                const open = args.hidden;
                args.hidden = !open;
                runBtn.hidden = !open;
                result.hidden = true;
            };
            card.append(title, desc, toggle, args, runBtn, result);
            list.appendChild(card);
        });
        body.appendChild(list);
        toolsList = list;
    }

    async function load() {
        const data = await getJson("/neo_mcp/servers");
        if (data.offline) {
            servers = [];
            emptyHint(OFFLINE_HINT);
            note("", null);
            return;
        }
        if (!data.success) {
            note(data.error || t("读取注册表失败"), "err");
            return;
        }
        servers = data.servers || [];
        // 连接 / 断开 / 刷新 / 保存注册表都会重跑 load：不清场的话服务行与工具卡会一层层叠在同一栏里
        body.replaceChildren();
        renderServers(data.connected || []);
        if (editorBox.hidden) editor.value = JSON.stringify(servers, null, 2);
        const tools = await getJson("/neo_mcp/tools");
        if (!tools.offline && tools.success) renderTools(tools.tools || []);
    }

    root.appendChild(box);
    return { root, refresh: load };
}

// ==========================================
// 面板装配
// ==========================================

/**
 * 把聊天面板挂进宿主（桌面端 Studio 右栏）。opts.onOpenMcp 是「🔌 MCP」入口的跳转回调，opts.onOpenPrefs 是「⚙ 智能体偏好」与焦点链「设为偏好」跳设置页的回调；
 * opts.getContext 交回界面当前状态，只有当前选中页签自己那一栏（导演页的配方、绘画页的模式、
 * 上屏那几页的素材库目录），面板只把它画进上下文条并随请求体交后端，不解释它。
 * 返回 { root, refresh }：refresh 恢复条上的取消位并重画，宿主在切页 / 选配方 / 切绘画模式时调。
 * opts.onFrame 把实时帧同时交给中间舞台（agent-stage.js）：舞台与右栏消费同一路帧，各自画当前这一轮。
 */
export function createAgentPanel(host, opts = {}) {
    ensureCss();
    const chat = buildChat(opts.onOpenMcp, opts.getContext, opts.onOpenPrefs, opts.onFrame, opts.previewSide);
    const root = mkEl("div", "neo-agent");
    root.appendChild(chat.box);
    host.appendChild(root);
    return {
        root,
        refresh() { chat.resetCtx(); chat.renderCtx(); },
    };
}

// ==========================================
// 用户级偏好表单（设置页「智能体偏好」栏）
// ==========================================

/**
 * 用户级偏好落在数据根的 configs/agent_prefs.json，一台机器一份：表单在设置页那一栏，右栏只留入口
 * （栏子拖到 260px 宽时塞不下六个字段）。返回 { el, load, prefill }：load 读当前偏好，prefill 把
 * 焦点链上的技能 / 宽高 / 导演配方填进表单。
 * 技能 / 尺寸 / 家族是枚举值，给固定下拉：技能取 /rs_prompts/skills 的 id（标签是中文名），尺寸取
 * 生图那批比例与长边正方形档，家族取家族线索在已装主模型里的命中集。焦点链带进来的值不在档位里
 * （1280x720 这种具体宽高、后来被删掉的技能 id）时追加成一项，用户看得见自己点进来的是什么。
 * 保存按后端 _clean_prefs 收净的返回值回填——越界的技能名与尺寸在后端被丢回默认值，表单留着用户刚写的
 * 那一份就是演它存上了。字段与后端收净的那六个一一对应（select 是枚举，area 是长文本，check 是开关）。
 * opts.stageMode / opts.setStageMode 是中间舞台那个界面开关的读写口：开关不在这六个字段里，宿主存本地。
 */
export function createAgentPrefsForm(opts = {}) {
    const form = mkEl("div", "ns-agent-prefs");
    const field = {};
    const desc = mkEl("div", "rs-settings-desc");
    desc.textContent = t("偏好对本机每条输入生效；本会话刚出过的那一发优先");
    const rows = PREFS_FIELDS.map(([key, label, kind]) => {
        const row = mkEl("div", "rs-config-row ns-prefs-row" + (kind === "check" ? " ns-prefs-check" : ""));
        const lab = mkEl("label", "rs-form-label");
        lab.textContent = t(label);
        const el = mkEl(kind === "select" ? "select" : (kind === "area" ? "textarea" : "input"), "rs-form-input");
        el.name = key;   // 深链预填与测试都按 name 认字段
        if (kind === "check") el.type = "checkbox";
        if (kind === "area") el.rows = 3;
        field[key] = el;
        row.append(lab, el);
        return row;
    });
    const note = mkEl("div", "ns-prefs-note");

    // 中间舞台是本机界面开关（宿主存 localStorage），与右栏开合同类：偏好文件里那六个字段会进系统
    // 提示词，界面布局不该进去，所以这一项不在 PREFS_FIELDS 里、不进保存请求体
    const stageRow = mkEl("div", "rs-config-row ns-prefs-row ns-prefs-check");
    const stageLab = mkEl("label", "rs-form-label");
    stageLab.textContent = t("中间舞台（过程与产物显示在页面中间）");
    stageLab.title = t("关掉就回到只在右栏看智能体的布局；这一项是本机界面开关，不写进偏好文件");
    const stageBox = mkEl("input", "rs-form-input");
    stageBox.type = "checkbox";
    stageBox.name = "stage_mode";
    stageBox.checked = opts.stageMode ? opts.stageMode() : true;
    stageBox.onchange = () => opts.setStageMode && opts.setStageMode(stageBox.checked);
    stageRow.append(stageLab, stageBox);

    // 下拉的选项来源在 load 里与偏好一起取：技能列表与已装主模型；取不到就是空列表，下拉只剩「不设」
    let skills = [], modelFiles = [];
    const prefOptions = (key) => key === "preferred_skill"
        ? skills.map((s) => [String(s?.id || ""), String(s?.cn_name || s?.name || s?.id || "")])
        : key === "preferred_size" ? PREFS_SIZE_STEPS.map((v) => [v, v])
        : modelFamilies(modelFiles).map((v) => [v, v]);

    function setSelect(key, value) {
        const el = field[key];
        const opts = prefOptions(key);
        el.innerHTML = "";
        const none = document.createElement("option");
        none.value = "";
        none.textContent = t(PREFS_NONE);
        el.appendChild(none);
        for (const [v, label] of opts) {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = label;
            el.appendChild(opt);
        }
        if (value && !opts.some(([v]) => v === value)) {
            const extra = document.createElement("option");
            extra.value = value;
            extra.textContent = value + t("（焦点链）");
            el.appendChild(extra);
        }
        el.value = value || "";
    }

    function setValue(key, kind, value) {
        if (kind === "check") field[key].checked = !!value;
        else if (kind === "select") setSelect(key, String(value || ""));
        else field[key].value = String(value ?? "");
    }

    function fill(prefs) {
        PREFS_FIELDS.forEach(([key, , kind]) => setValue(key, kind, prefs[key]));
    }

    const save = mkEl("button", "rs-gen-save ns-prefs-save");
    save.type = "button";
    save.textContent = t("保存偏好");
    save.onclick = async () => {
        const body = {};
        PREFS_FIELDS.forEach(([key, , kind]) => {
            body[key] = kind === "check" ? field[key].checked : field[key].value.trim();
        });
        const data = await postJson("/neo_agent/prefs", body);
        if (!data.ok) {
            toast("error", data.offline ? t("桌面端服务未就绪") : (data.error || t("保存偏好失败")));
            return;
        }
        fill(data.prefs || {});
        note.textContent = t("已写入 configs/agent_prefs.json，下一条输入起效");
        toast("info", t("智能体偏好已保存"));
    };

    async function load() {
        // 技能列表与主模型列表是下拉的选项来源，与偏好一起取；任一条取不到（离线服务、模型目录读失败）
        // 只让那一项下拉少几档，偏好本身照读——选项来源不该有把表单读崩的能力
        const [data, skillRes, modelRes] = await Promise.all([
            getJson("/neo_agent/prefs"),
            getJson("/rs_prompts/skills").catch(() => null),
            getJson("/neo_image_gen/models").catch(() => null),
        ]);
        if (data.offline) { note.textContent = t("桌面端服务未就绪"); return; }
        skills = Array.isArray(skillRes) ? skillRes : [];
        modelFiles = modelRes?.diffusion_models || [];
        fill(data.prefs || {});
        if (opts.stageMode) stageBox.checked = !!opts.stageMode();   // 开关以宿主那份为准，后端读回来的只有六个字段
        applyPending();
    }

    // 焦点链带过来的三个值走深链 #/settings?tab=agent&skill=..&size=..&family=..：预填要先落下，
    // 再在晚到的那次读之后盖回去——进栏子时的 GET 晚于预填落地，先把用户刚点进来的值抹平就是演它读上了
    let pending = null;
    function applyPending() {
        if (!pending) return;
        for (const [key, value] of [["preferred_skill", pending.skill],
                                    ["preferred_size", pending.size],
                                    ["preferred_family", pending.family]]) {
            if (value) setSelect(key, value);
        }
        field.preferred_skill.focus();
    }
    function prefill(query) {
        pending = { skill: query.get("skill"), size: query.get("size"), family: query.get("family") };
        applyPending();
    }

    form.append(desc, ...rows, stageRow, save, note);
    return { el: form, load, prefill };
}

