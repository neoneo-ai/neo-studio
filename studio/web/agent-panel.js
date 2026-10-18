/**
 * agent-panel.js — Neo Agent 面板（Neo Studio 桌面端 Studio 页右栏）
 *
 * 聊天区挂桌面端右栏：生图技能与空值「智能判断」都交给后端智能体（POST /neo_agent/run 的 SSE
 * 时间线：计划 / 工具卡 / 状态 / 产物图 / 最终回答），后端那一侧是 MCP 客户端，工具经
 * mcp_server 的 JSON-RPC 走，右栏不直接调后端函数；增强类技能仍只出提示词（prompt-service 的
 * SSE 与 skill.js 的技能表）。MCP 区
 * （注册表 / 连接 / 工具调用）交给设置页的「MCP 服务」栏，右栏只在「✨ 生成」下方留一个跳转入口。
 * stdio 型 MCP 服务是子进程，浏览器起不了，连接只活在桌面端进程里：面板只发 HTTP 打 /neo_mcp/*，
 * 桌面端服务不在时这些接口回 409，面板据此把 MCP 区收成一句离线说明，不给假成功。
 * 宿主是 studio 外壳（studio-app.js 挂右栏与设置页），不是 ComfyUI 画布侧栏：本模块不注册扩展。
 * 样式全在 agent-panel.css，作用域收在 .neo-agent 下。
 */
import { mkEl } from "./dom-utils.js";
import { t } from "./js/core/i18n.js";
import { listSkills, populateSkillOptions, renderMarkdown } from "./skill.js";
import { invokePromptStream, sseStream } from "./prompt-service.js";
import { Lightbox } from "./lightbox.js";

const AGENT_CSS_HREF = "/extensions/comfyui-neo-studio/agent-panel.css";

const OFFLINE_HINT = t("MCP 连接由 Neo Studio 桌面端提供：桌面端服务未就绪时无法连接外部 MCP 服务");

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

// ==========================================
// 聊天区：一问一答，正文按 Markdown 渲染
// ==========================================

function buildChat(onOpenMcp) {
    const box = mkEl("div", "neo-agent-section neo-agent-chat");
    const transcript = mkEl("div", "neo-agent-transcript");
    const empty = mkEl("div", "neo-agent-empty");
    empty.textContent = t("输入需求，Enter 生成；选技能则按技能模板生成");
    transcript.appendChild(empty);

    const composer = mkEl("div", "neo-agent-composer");
    const skillSel = mkEl("select", "neo-agent-skill");
    const input = mkEl("textarea", "neo-agent-input");
    input.rows = 3;
    input.placeholder = t("描述要生成的提示词，或要改写的方向");
    const run = mkEl("button", "neo-agent-run");
    run.type = "button";
    run.textContent = t("✨ 生成");
    composer.append(skillSel, input, run);
    // MCP 注册表在设置页那一栏，生成按钮下面只留一个跳转入口
    const foot = mkEl("div", "neo-agent-foot");
    const mcpEntry = mkEl("button", "neo-agent-entry");
    mcpEntry.type = "button";
    mcpEntry.textContent = "🔌 MCP";
    mcpEntry.title = t("MCP 服务设置");
    mcpEntry.onclick = () => onOpenMcp && onOpenMcp();
    foot.appendChild(mcpEntry);
    composer.appendChild(foot);

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

    let skillsLoaded = false;

    async function loadSkills() {
        if (skillsLoaded) return;
        const skills = await listSkills();
        if (!skills || !skills.length) return;
        // 空值项 = 后端无 skillId 时的 smart_prompt 分支（llm.py 里「智能判断是否使用模版」），与主面板 llm-chat 同口径；
        // 不插这一项的话 select 默认落在第一个技能上，右栏等于强制套模板。
        const auto = mkEl("option");
        auto.value = "";
        auto.textContent = t("智能判断");
        skillSel.appendChild(auto);
        populateSkillOptions(skillSel, skills);
        skillsLoaded = true;
    }

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
            answer(text) {
                final.innerHTML = renderMarkdown(text);
            },
            // 「⏹ 取消」落在步骤区，不覆盖最终回答那一行；取消请求本身失败要留在时间线上——
            // 按钮那一行在断流收尾时就被「✨ 生成」盖掉，写在那里没人看得见
            cancelled(note) {
                const row = mkEl("div", "neo-agent-step");
                row.textContent = "⏹ " + t("已取消") + (note ? "（" + note + "）" : "");
                steps.appendChild(row);
            },
            error(text) {
                final.textContent = text;
                final.classList.add("neo-agent-answer-error");
            },
        };
    }

    // 运行中的这一路：取消要断流、要按 run_id 停后端循环、要往当前时间线补一行，句柄挂在这里
    let running = false;
    let controller = null;
    let runId = "";
    let activeView = null;

    // 智能体路径：一次请求换一路 SSE。选了生图技能时后端按技能直出图（不叫 LLM），
    // 空值「智能判断」时后端让 LLM 规划并调 MCP 工具
    async function runAgent(answer, skillId, text) {
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
                else view.answer(frame.text || "");
                transcript.scrollTop = transcript.scrollHeight;
            },
            onError: (err) => view.error(String(err || t("生成失败"))),
        }, { text, skill_id: skillId });
    }

    // 「⏹ 取消」：断流 + 让后端停循环并掐在跑的任务。首帧的 run_id 还没到就只断流——
    // 断开路径上后端会兜底掐任务，不给一个空 run_id 去打接口
    async function stopRun() {
        if (!running || !controller) return;   // 增强类技能那一路没有可断的流，按钮本来就锁着
        run.disabled = true;
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
        const text = input.value.trim();
        if (!text || running) return;
        if (empty.parentNode) empty.remove();
        const turn = mkEl("div", "neo-agent-turn");
        const opt = skillSel.selectedOptions[0];
        const meta = mkEl("div", "neo-agent-meta");
        meta.textContent = opt?.textContent || t("智能判断");
        const ask = mkEl("div", "neo-agent-ask");
        ask.textContent = text;
        const answer = mkEl("div", "neo-agent-answer");
        turn.append(meta, ask, answer);
        transcript.appendChild(turn);
        transcript.scrollTop = transcript.scrollHeight;

        // 生图技能与空值「智能判断」都交给后端智能体：前者按技能直出图，后者由 LLM 规划调工具；
        // 增强类技能照旧只出提示词
        const agentPath = opt?.dataset.genImage === "1" || !skillSel.value;
        running = true;
        // 智能体路径运行中不禁用按钮：这一击就是停止，禁用等于把停止键从界面上摘掉。
        // 增强类技能那一路没有可断的流，照旧锁住按钮
        run.disabled = !agentPath;
        run.textContent = t("⏳ 生成中");
        if (agentPath) run.classList.add("ns-agent-stop");
        let acc = "";
        let raf = null;
        const paint = () => {
            raf = null;
            answer.innerHTML = renderMarkdown(acc);
            transcript.scrollTop = transcript.scrollHeight;
        };
        const flush = () => {
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            if (acc) paint();
        };
        try {
            if (agentPath) {
                await runAgent(answer, skillSel.value, text);
                return;
            }
            await invokePromptStream({ text, skillId: skillSel.value, description: text }, {
                onChunk: (chunk) => {
                    if (!chunk || !chunk.text) return;
                    if (chunk.kind === "thinking" || chunk.kind === "status") {
                        meta.textContent = chunk.kind === "thinking" ? t("💭 思考中…") : chunk.text;
                        return;
                    }
                    acc = chunk.kind === "replace" ? chunk.text : acc + chunk.text;
                    if (!raf) raf = requestAnimationFrame(paint);
                },
                onDone: flush,
                onError: (err) => {
                    flush();
                    answer.textContent = String(err || t("生成失败"));
                    answer.classList.add("neo-agent-answer-error");
                },
            });
        } catch (e) {
            answer.textContent = String(e);
            answer.classList.add("neo-agent-answer-error");
        } finally {
            running = false;
            controller = null;
            runId = "";
            activeView = null;
            run.disabled = false;
            run.classList.remove("ns-agent-stop");
            run.textContent = t("✨ 生成");
        }
    }

    // 一个键两态：空闲是「✨ 生成」，运行中是「⏹ 取消」
    run.onclick = () => (running ? stopRun() : generate());
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            generate();
        }
    });

    return { box, loadSkills };
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
 * 把聊天面板挂进宿主（桌面端 Studio 右栏）。opts.onOpenMcp 是「🔌 MCP」入口的跳转回调。
 * 返回 { root, refresh }：refresh 拉技能表，宿主在栏子展开时调。
 */
export function createAgentPanel(host, opts = {}) {
    ensureCss();
    const chat = buildChat(opts.onOpenMcp);
    const root = mkEl("div", "neo-agent");
    root.appendChild(chat.box);
    host.appendChild(root);
    return {
        root,
        async refresh() {
            await chat.loadSkills();
        },
    };
}
