/**
 * agent-panel.js — Neo Agent 面板（Neo Studio 桌面端 Studio 页右栏）
 *
 * 聊天区挂桌面端右栏：一次「✨ 生成」交给后端智能体（POST /neo_agent/run 的 SSE 时间线：
 * 计划 / 工具卡 / 状态 / 产物图 / 暂停 / 继续 / 最终回答），后端那一侧是 MCP 客户端，工具经
 * mcp_server 的 JSON-RPC 走，右栏不直接调后端函数；右栏不再选技能，界面当前状态（当前页 /
 * 当前导演配方 / 绘画页模式 / 素材库目录）由宿主随请求体交给后端进系统提示词。MCP 区
 * （注册表 / 连接 / 工具调用）交给设置页的「MCP 服务」栏，右栏只在输入框底栏留一个跳转入口。
 * 输入框按 Cline 的口径做：只读上下文条、附件图 chip、文本框，底栏一行是 📎 附件图、🔌 MCP、
 * 「📝 计划 / ⚡ 执行」与右下角主按钮（生成 / 暂停 / 继续）；整行「⏹ 取消」只在跑起来之后出现。
 * 时间线里的选项确认卡
 * （后端 ask_user 发一问就挂在循环上，点选经 POST /neo_agent/answer 交回去）；最终回答末尾的
 * 「下一步选项」编号列表铺成一排可点的方向，点一下即把这句话当作下一轮输入发出。
 * stdio 型 MCP 服务是子进程，浏览器起不了，连接只活在桌面端进程里：面板只发 HTTP 打 /neo_mcp/*，
 * 桌面端服务不在时这些接口回 409，面板据此把 MCP 区收成一句离线说明，不给假成功。
 * 宿主是 studio 外壳（studio-app.js 挂右栏与设置页），不是 ComfyUI 画布侧栏：本模块不注册扩展。
 * 样式全在 agent-panel.css，作用域收在 .neo-agent 下。
 */
import { mkEl } from "./dom-utils.js";
import { app } from "../../scripts/app.js";
import { t, tf } from "./js/core/i18n.js";
import { renderMarkdown } from "./skill.js";
import { fileToBase64, imagesFromClipboard, sseStream } from "./prompt-service.js";
import { Lightbox } from "./lightbox.js";
import { grabDataType, copyGalleryToInput } from "./media-transfer.js";

const AGENT_CSS_HREF = "/extensions/comfyui-neo-studio/agent-panel.css";

const OFFLINE_HINT = t("MCP 连接由 Neo Studio 桌面端提供：桌面端服务未就绪时无法连接外部 MCP 服务");

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
    btn.textContent = label;
    btn.title = title;
    btn.onclick = onClick;
    return btn;
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

// 产物地址的形态：后端 media 项与最终回答里的链接都落在这几类地址上
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v|mkv|avi|mp3|wav|ogg|m4a|aac|flac)(?=&|#|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|avi)(?=&|#|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)(?=&|#|$)/i;
const MEDIA_PATH = /^\/(view|neo_gallery\/\w*|rs_recipes\/(asset|thumbnail))(?=\?|#|$)/;

const isMediaHref = (href) => MEDIA_PATH.test(href) || MEDIA_EXT.test(href);
const mediaKindOf = (href) => (VIDEO_EXT.test(href) ? "video" : AUDIO_EXT.test(href) ? "audio" : "image");

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

function buildChat(onOpenMcp, getContext) {
    const box = mkEl("div", "neo-agent-section neo-agent-chat");
    const transcript = mkEl("div", "neo-agent-transcript");
    const empty = mkEl("div", "neo-agent-empty");
    empty.textContent = t("输入需求，Enter 生成；右栏会带着界面当前状态去规划");
    transcript.appendChild(empty);

    const composer = mkEl("div", "neo-agent-composer");
    // 上下文条只读：宿主（studio-app.js）在切页 / 选配方 / 切绘画模式时把状态交过来
    const ctxBar = mkEl("div", "neo-agent-ctx");
    const chips = mkEl("div", "neo-agent-chips");
    const input = mkEl("textarea", "neo-agent-input");
    input.rows = 3;
    input.placeholder = t("描述要生成的提示词，或要改写的方向；可粘贴 / 拖入图片（含素材库卡片）");
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
        btn.textContent = label;
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
    attach.textContent = "📎 " + t("添加图片");
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
    mcpEntry.textContent = "🔌 MCP";
    mcpEntry.title = t("MCP 服务设置");
    mcpEntry.onclick = () => onOpenMcp && onOpenMcp();
    // 主按钮在右下角，一个钮三态（生成 / 暂停 / 继续）——空闲时它就是发送键
    const run = mkEl("button", "neo-agent-run");
    run.type = "button";
    run.textContent = t("✨ 生成");
    toolbar.append(attach, fileInput, mcpEntry, modes, run);
    composer.append(ctxBar, chips, cancelBar, input, toolbar);

    // 界面当前状态：宿主只交事实，这一条把它拼成一行给用户看，随请求体原样交后端
    const PAGE_NAMES = { gallery: "素材库", director: "导演页", paint: "绘画页", skills: "技能页", settings: "设置页" };
    function currentContext() {
        const ctx = (getContext && getContext()) || {};
        const parts = [];
        if (PAGE_NAMES[ctx.page]) parts.push(t(PAGE_NAMES[ctx.page]));
        if (ctx.recipe) parts.push(ctx.recipe + (ctx.segments > 0 ? tf("{n} 段", { n: ctx.segments }) : ""));
        // 绘画模式只在绘画页有意义：素材页上挂一行「文生图」是噪声
        if (ctx.page === "paint") {
            if (ctx.paint_mode === "text") parts.push(t("文生图"));
            else if (ctx.paint_mode === "edit") parts.push(t("图片编辑"));
        }
        if (ctx.gallery_path) parts.push(ctx.gallery_path);
        return parts;
    }
    function renderCtx() {
        const parts = currentContext();
        ctxBar.textContent = "📍 " + (parts.length ? parts.join(" · ") : t("无当前上下文"));
    }
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
    box.append(sectionHead(t("智能体"), [headBtn("🗑", t("清空对话"), () => {
        transcript.innerHTML = "";
        transcript.appendChild(empty);
    })]), transcript, composer);

    // 时间线里的链接一律收在页面内：产物进弹出窗口，外部链接交给新窗口。放任 <a> 的默认行为
    // 就是整扇窗口翻到 /view 图片页——返回时 Studio 页重载，启动状态位与整条时间线一起没了
    transcript.addEventListener("click", (e) => {
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
    function agentTimeline(answer) {
        const steps = mkEl("div", "neo-agent-steps");
        const final = mkEl("div", "neo-agent-answer-body");
        answer.append(steps, final);
        let card = null;
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
                const status = mkEl("div", "neo-agent-tool-status");
                const out = mkEl("pre", "neo-agent-tool-out");
                card.append(title, body, status, out);
                steps.appendChild(card);
            },
            status(text, taskId) {
                const row = slot("neo-agent-tool-status");
                if (!row) return;
                row.textContent = text;
                if (taskId && !row.querySelector(".neo-agent-cancel")) mkCancel(row, taskId);
            },
            toolResult(text, media) {
                const out = slot("neo-agent-tool-out");
                if (!out) return;
                out.textContent = text;
                const btn = slot("neo-agent-cancel");
                if (btn) btn.remove();       // 任务到终态，取消入口跟着收掉
                if (media.length) renderGenMedia(card, media);
            },
            // 中途的选项确认：后端 ask_user 发一问就挂在循环上，点选即把方向交回 /neo_agent/answer。
            // 这一击必须能点：卡片在步骤区，主按钮在运行中是暂停态，两条路互不挡
            ask(question, options, askId) {
                const card = mkEl("div", "neo-agent-step neo-agent-choice");
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
                    btn.onclick = () => answer(o);
                    opts.appendChild(btn);
                });
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

    // 主按钮三态：空闲「✨ 生成」、运行中「⏸ 暂停」、暂停中「▶ 继续」。整行「⏹ 取消」跟着
    // 运行出现——Cline 的口径：没在跑就没有取消键，空闲时那一行不占位
    function setRunState(next) {
        run.textContent = next === "run" ? t("✨ 生成")
            : next === "paused" ? t("▶ 继续") : t("⏸ 暂停");
        run.classList.toggle("neo-agent-paused", next === "paused");
        cancelBar.hidden = next === "run";
        // 跑起来之后不点第二下：上一轮留下的方向按钮整排锁住，本轮收场放开（点过的那组保持锁定，
        // 与 ask_user 选项卡同一口径）
        transcript.querySelectorAll(".neo-agent-answer-opts:not(.neo-agent-answer-opts-locked) .neo-agent-answer-opt")
            .forEach((b) => { b.disabled = next !== "run"; });
    }

    // 智能体路径：一次请求换一路 SSE。界面当前状态随请求体进后端系统提示词，
    // mode 决定计划还是执行，images 是附件图
    async function runAgent(answer, text, planMode, images, context) {
        const view = agentTimeline(answer);
        activeView = view;
        controller = new AbortController();
        await sseStream("/neo_agent/run", {
            signal: controller.signal,
            onChunk: (frame) => {
                const kind = frame?.kind || "content";
                if (kind === "run") { runId = frame.run_id || ""; return; }
                if (kind === "plan") view.plan(frame.text || "");
                else if (kind === "tool_call") view.toolCall(frame.tool || "?", frame.text || "");
                else if (kind === "status") view.status(frame.text || "", frame.task_id || "");
                else if (kind === "tool_result") view.toolResult(frame.text || "", frame.media || []);
                else if (kind === "ask") view.ask(frame.text || "", frame.options || [], frame.ask_id || "");
                else if (kind === "paused") { paused = true; setRunState("paused"); view.paused(); }
                else if (kind === "resumed") { paused = false; setRunState("running"); view.resumed(); }
                else view.answer(frame.text || "");
                transcript.scrollTop = transcript.scrollHeight;
            },
            onError: (err) => view.error(String(err || t("生成失败"))),
        }, { text, mode: planMode, images, context });
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
        run.textContent = t("⏳ 取消中");
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
        const text = input.value.trim();
        // 只给图不给字是合法输入（看图说话），两头都空才拦。素材库拖入的图已在 input 目录里，
        // 按文件名给后端（与绘画页参考图同一口径），本地粘贴 / 选图仍是 data URI
        const images = attachments.map((a) => (a.data ? { kind: "data", data: a.data } : { kind: "input", value: a.input }));
        if (!text && !images.length) return;
        const planMode = mode;
        const context = (getContext && getContext()) || null;
        if (empty.parentNode) empty.remove();
        const turn = mkEl("div", "neo-agent-turn");
        const meta = mkEl("div", "neo-agent-meta");
        meta.textContent = (currentContext().join(" · ") || t("无当前上下文"))
            + (planMode === "plan" ? " · " + t("计划") : "");
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
            await runAgent(answer, text, planMode, images, context);
        } catch (e) {
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
        }
    }

    // 主按钮一个钮三态：空闲生成、运行中暂停、暂停中继续
    run.onclick = () => {
        if (!running) return generate();
        return paused ? resumeRun() : pauseRun();
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            if (!running) generate();
        }
    });

    return { box, renderCtx };
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
 * 把聊天面板挂进宿主（桌面端 Studio 右栏）。opts.onOpenMcp 是「🔌 MCP」入口的跳转回调；
 * opts.getContext 交回界面当前状态（当前页 / 当前导演配方 / 绘画页模式 / 素材库目录），
 * 面板只把它画进上下文条并随请求体交后端，不解释它。
 * 返回 { root, refresh }：refresh 重画上下文条，宿主在切页 / 选配方 / 切绘画模式时调。
 */
export function createAgentPanel(host, opts = {}) {
    ensureCss();
    const chat = buildChat(opts.onOpenMcp, opts.getContext);
    const root = mkEl("div", "neo-agent");
    root.appendChild(chat.box);
    host.appendChild(root);
    return {
        root,
        refresh() { chat.renderCtx(); },
    };
}
