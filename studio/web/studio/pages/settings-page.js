// 设置页（#/settings）：左栏四段十栏的壳与 tab 切换，深链 #/settings?tab=.. 认的那一个参数就在这页。
// 页里自己铺的：生图 / 生视频 / LLM 三张表单、智能体偏好与 MCP 面板、手机连接二维码、启动日志轮询、
// 界面语言单选、关于栏版本行，以及启动设置那一整块面板（内核启停 + 根目录 / 解释器 / 端口 / 监听 /
// 远程 / 无边框 / 开发模式 / 姿势仓库，桌面端桥在面板里自己读）。
// 版本快照、内核启停与采样帧偏好是装配层的状态：这一页只把它们要的那几样接过来。
import { t, tf, applyLang, getLang, LANGS } from "../../js/core/i18n.js";
import { icon } from "../../js/core/icons.js";
import { createPairPanel } from "../../js/core/pair-access.js";
import { createImageGenSettingsForm, createVideoGenSettingsForm } from "../../image-gen.js";
import { createModelConfigForm } from "../../llm-setting.js";
import { createAgentPrefsForm, createMcpPanel } from "../../agent-panel.js";

/** @typedef {Object} SettingsPageHost
 *  @property {Function} $el 建元素
 *  @property {Function} api 取接口：离线与在线同一条路
 *  @property {Function} toast 提示文本
 *  @property {Function} openExternalUrl 打开外链（无边框窗口走桌面端的桥）
 *  @property {Function} versionText 关于栏顶上的版本串
 *  @property {Function} renderAboutRows 画关于栏的路径行
 *  @property {Function} previewMode 这一轮要不要逐采样步的动画帧
 *  @property {Function} setPreviewMode 改采样帧偏好
 *  @property {Function} userStarting 已点下启动内核、正在等端口就绪
 *  @property {Function} onComfyState 订阅内核状态
 *  @property {Function} startKernel 启动内核
 *  @property {Function} stopKernel 停止内核 */

export function createSettingsPage({ $el, api, toast, openExternalUrl, versionText, renderAboutRows,
                                     previewMode, setPreviewMode, userStarting, onComfyState,
                                     startKernel, stopKernel }) {
// ====== 启动设置：便携 exe 的 ComfyUI 根目录 / 解释器 / 端口 ======
// 这份数据归桌面端：桌面端窗口里走 js_api，页面在桌面端端口还是 ComfyUI 端口都读得到（就绪后整页跳到 ComfyUI，
// 同源就没有 /neo_studio/launcher 了）；浏览器标签页没有桥，只剩桌面端服务那条路由，读不到就收起 tab。
function createLauncherPanel() {
    const input = (ph) => $el("input", { className: "ns-launch-input", placeholder: ph, spellcheck: "false" });
    const rootIn = input(t("ComfyUI 根目录"));
    const pyIn = input(t("python.exe 路径"));
    const portIn = input("8188");
    const remoteIn = input("http://192.168.0.20:8188");
    remoteIn.classList.add("ns-launch-remote");
    const poseIn = input(t("3d-pose-art 仓库根（留空 = 不自动同步）"));
    poseIn.classList.add("ns-launch-pose");
    const listenSel = $el("select", { className: "ns-launch-input ns-launch-listen" });
    const status = $el("div", { className: "ns-launch-status" });
    const info = $el("div", { className: "ns-launch-info" });
    const lanHint = $el("div", { className: "ns-launch-info" });
    const browseBtn = $el("button", { className: "ns-btn", textContent: t("浏览…") });
    const pyBrowseBtn = $el("button", { className: "ns-btn", textContent: t("浏览…") });
    const poseBrowseBtn = $el("button", { className: "ns-btn", textContent: t("浏览…") });
    const applyBtn = $el("button", { className: "ns-btn ns-launch-apply", textContent: t("保存并重启 ComfyUI") });
    const depsBtn = $el("button", { className: "ns-btn", textContent: t("安装依赖") });
    const fixBtn = $el("button", { className: "ns-btn", textContent: t("重试安装插件") });
    const framelessIn = $el("input", { type: "checkbox", className: "ns-launch-frameless" });
    const devIn = $el("input", { type: "checkbox", className: "ns-launch-dev" });
    const kernelState = $el("div", { className: "ns-kernel-state" });
    const startBtn = $el("button", { className: "ns-btn ns-kernel-start", textContent: t("▶ 启动内核") });
    const stopBtn = $el("button", { className: "ns-btn ns-kernel-stop", textContent: t("■ 停止内核") });
    // 一键打开这一路 ComfyUI 的地址：无边框窗口里没有新标签可开，点了交桌面端的桥开系统浏览器
    const openBtn = $el("button", { className: "ns-btn ns-kernel-open", textContent: t("打开 ComfyUI") });
    let kernelUrl = "";
    // 标签旁的 ⓘ：悬停给出前提条件与生效方式 —— 面板里这几项的规矩各不相同（保存并重启 / 重启窗口 / 归远端管）
    const TIPS = {
        root: "ComfyUI 安装目录，要有 main.py。\n"
            + "改完点「保存并重启 ComfyUI」：桌面端停掉旧进程，按新配置重新拉起。",
        python: "跑 ComfyUI 的 python.exe，要已装好 ComfyUI 的依赖（缺依赖时下方出「安装依赖」按钮）。\n"
            + "改完点「保存并重启 ComfyUI」。",
        port: "本机 ComfyUI 的端口，窗口与探活都打在 127.0.0.1:该端口。\n"
            + "端口被占用时桌面端自动换到下一个空闲端口。改完点「保存并重启 ComfyUI」。",
        listen: "ComfyUI 的 --listen，默认「仅本机」= 只监听 127.0.0.1，局域网访问不到。\n"
            + "填网卡地址时会自动带上 127.0.0.1，否则窗口自己打不开。\n"
            + "ComfyUI 没有鉴权：防火墙放行该端口，只在你信任的网段开。改完点「保存并重启 ComfyUI」。\n"
            + "放开后「设置 → 手机连接」才会出手机扫码用的二维码。",
        remote: "连远端那台 ComfyUI：http(s)://主机[:端口]，留空 = 连本机。\n"
            + "前提：远端已装 comfyui-neo-studio 插件，并在远端自己的「启动设置 → 局域网监听」放开监听。\n"
            + "远程模式本机不启动也不停止 ComfyUI：「启动内核」= 重连远端，「停止内核」禁用，"
            + "根目录 / 解释器 / 端口 / 局域网监听归远端管。\n"
            + "改完点「保存并重启 ComfyUI」，窗口直接开在远端页面。",
        frameless: "桌面端窗口自绘标题栏（最小化 / 最大化 / 全屏 / 关闭），勾掉回系统标题栏。\n"
            + "立刻生效并写进启动配置，下次开机沿用。",
        dev: "打开刷新键 / 右键菜单 / 开发者工具，排查窗口白屏与前端问题用。\n"
            + "pywebview 在建窗口时定值：勾完要重启桌面端窗口才生效。",
        poseRepo: "3d-pose-art 仓库根（带 pose-lib 那一层目录）：填上后桌面端每次启动自动把 dist 姿势包与 "
            + "pose-lib 姿势库补进数据根，pose 数据更新后姿势页不会停在旧构建与空白缩略图上。\n"
            + "保存这一行会立刻在后台同步一次；留空 = 不自动同步，姿势页停在数据根现有那份与随包副本上。",
    };
    const infoDot = (tip) => $el("span", { className: "ns-info", textContent: "i", tabindex: "0", "data-tip": tip });
    const row = (label, tip, ...kids) => $el("div", { className: "ns-launch-row" },
        [$el("span", { className: "ns-launch-label" }, [label, infoDot(tip)]), ...kids]);
    const rootRow = row(t("ComfyUI 根目录"), t(TIPS.root), rootIn, browseBtn);
    const pyRow = row("Python", t(TIPS.python), pyIn, pyBrowseBtn);
    const portRow = row(t("端口"), t(TIPS.port), portIn);
    const listenRow = row(t("局域网监听"), t(TIPS.listen), listenSel);
    const remoteRow = row(t("远程 ComfyUI"), t(TIPS.remote), remoteIn);
    const poseRow = row(t("姿势仓库"), t(TIPS.poseRepo), poseIn, poseBrowseBtn);
    // 远程模式下这几项归远端那台机器管：灰掉，别让本机设置看起来能影响远端
    const localRows = [rootRow, pyRow, portRow, listenRow, poseRow];
    const localInputs = [rootIn, pyIn, portIn, listenSel, browseBtn, pyBrowseBtn, poseIn, poseBrowseBtn];

    const STATE_TEXT = {
        ok: "就绪",
        remote_ok: "远程就绪",
        remote_down: "远程不可达",
        bad_root: "根目录无效",
        missing_python: "找不到 Python",
        deps_missing: "缺少插件依赖",
        install_failed: "插件安装失败",
    };

    // 局域网监听做成下拉：手输 IP 容易错，可选项就是「仅本机 / 全部网卡 / 本机各网卡」
    const LAN_CHOICES = [["", "仅本机（默认）"], ["0.0.0.0", "全部网卡（0.0.0.0）"]];
    let lanIps = [];

    // 桌面端存的是规范化值（127.0.0.1,192.168.0.165）：去掉补出来的回环才是下拉项
    const lanKey = (listen) => (listen || "").split(",")
        .map((x) => x.trim()).filter((x) => x && x !== "127.0.0.1").join(",");

    function renderLanHint() {
        const remote = remoteIn.value.trim();
        if (remote) {
            lanHint.textContent = tf("远程 ComfyUI：{remote}/neo-studio · 远端要已开监听并装好 Neo Studio 插件，起停与端口都在远端那台机器上设", { remote });
            return;
        }
        const v = listenSel.value;
        const port = portIn.value || "8188";
        if (!v) {
            lanHint.textContent = tf("仅本机访问：http://127.0.0.1:{port}/neo-studio", { port });
            return;
        }
        const urls = v === "0.0.0.0"
            ? lanIps.map((ip) => `http://${ip}:${port}/neo-studio`)
            : [`http://${v}:${port}/neo-studio`];
        lanHint.textContent = t("局域网可访问（ComfyUI 没有鉴权，只在你信任的网段开）：")
            + (urls.join("  ·  ") || tf("http://<本机 IP>:{port}/neo-studio", { port }));
    }

    // 远程模式灰掉本机启动项：远端的根目录 / 解释器 / 端口 / 监听由远端自己配
    function renderLocalMode(remote) {
        for (const el of localInputs) el.disabled = remote;
        for (const r of localRows) r.classList.toggle("ns-launch-remote-off", remote);
    }

    function render(s) {
        rootIn.value = s.root || "";
        pyIn.value = s.python || "";
        portIn.value = s.port || "";
        remoteIn.value = s.remote || "";
        poseIn.value = s.pose_repo || "";
        renderLocalMode(!!s.remote);
        lanIps = s.lan_ips || [];
        const opts = LAN_CHOICES.concat(lanIps.map((ip) => [ip, tf("本机网卡 {ip}", { ip })]));
        const key = lanKey(s.listen);
        if (!opts.some(([v]) => v === key)) opts.push([key, tf("已保存：{key}", { key })]);
        listenSel.replaceChildren(...opts.map(([v, label]) => $el("option", { value: v, textContent: t(label) })));
        listenSel.value = key;
        renderLanHint();
        status.textContent = t(STATE_TEXT[s.state] || s.state || "") + (s.error ? ` · ${s.error}` : "");
        status.classList.toggle("ns-launch-bad", !!s.state && s.state !== "ok" && s.state !== "remote_ok");
        info.textContent = tf("插件 {plugin} · 状态 {state} · {mode}", {
            plugin: s.plugin_dir, state: s.state_dir, mode: t(s.portable ? "便携模式" : "插件内运行"),
        });
        depsBtn.style.display = s.state === "deps_missing" ? "" : "none";
        fixBtn.style.display = s.state === "install_failed" ? "" : "none";
        framelessIn.checked = !!s.frameless;
        devIn.checked = !!s.dev_mode;
        framelessRow.style.display = s.platform === "mac" ? "none" : "";
    }

    // 动作 → 桌面端 js_api 上的方法名：桥在就直接问桌面端，不在才走桌面端服务的 HTTP 路由
    const BRIDGE_FN = { apply: "apply_launcher", install_plugin: "install_plugin", install_deps: "install_deps", set_frameless: "set_frameless", set_dev_mode: "set_dev_mode", set_pose_repo: "set_pose_repo" };
    const bridge = () => (window.pywebview?.api?.launcher_state ? window.pywebview.api : null);

    async function refresh() {
        const desktop = bridge();
        if (desktop) {
            render(await desktop.launcher_state());
            return;
        }
        const resp = await api.fetchApi("/neo_studio/launcher");
        if (!resp.ok) throw new Error(tf("读取启动设置失败：{status}", { status: resp.status }));
        render(await resp.json());
    }

    async function post(payload) {
        applyBtn.disabled = depsBtn.disabled = fixBtn.disabled = true;
        try {
            const action = payload.action || "apply";
            const fn = bridge()?.[BRIDGE_FN[action]];
            let data;
            if (fn) {
                data = action === "apply"
                    ? await fn(payload.root, payload.python, payload.port, payload.listen, payload.remote)
                    : action === "set_frameless"
                        ? await fn(payload.frameless)
                        : action === "set_dev_mode"
                            ? await fn(payload.dev_mode)
                            : action === "set_pose_repo"
                                ? await fn(payload.pose_repo)
                                : await fn();
            } else {
                const resp = await api.fetchApi("/neo_studio/launcher", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                data = await resp.json();
            }
            const failed = data.ok === false;   // 重试安装插件回的是内核状态，没有 ok 字段也算成功
            toast(failed ? (data.error || t("操作失败")) : (data.msg || t("已保存，ComfyUI 重启中…")));
            if (!failed) await refresh();
        } catch (e) {
            toast(tf("启动设置保存失败：{msg}", { msg: e.message }));
        } finally {
            applyBtn.disabled = depsBtn.disabled = fixBtn.disabled = false;
        }
    }

    browseBtn.addEventListener("click", async () => {
        const picked = await window.pywebview?.api?.pick_root?.();
        if (picked) rootIn.value = picked;
    });
    pyBrowseBtn.addEventListener("click", async () => {
        const picked = await window.pywebview?.api?.pick_python?.();
        if (picked) pyIn.value = picked;
    });
    poseBrowseBtn.addEventListener("click", async () => {
        const picked = await window.pywebview?.api?.pick_pose_repo?.();
        if (picked) poseIn.value = picked;
    });
    poseIn.addEventListener("change", () => post({ action: "set_pose_repo", pose_repo: poseIn.value.trim() }));
    applyBtn.addEventListener("click", () => post({
        root: rootIn.value, python: pyIn.value, port: portIn.value,
        listen: listenSel.value, remote: remoteIn.value.trim(),
    }));
    depsBtn.addEventListener("click", () => post({ action: "install_deps" }));
    fixBtn.addEventListener("click", () => post({ action: "install_plugin" }));
    framelessIn.addEventListener("change", () => post({ action: "set_frameless", frameless: framelessIn.checked }));
    devIn.addEventListener("change", () => post({ action: "set_dev_mode", dev_mode: devIn.checked }));
    // 提示行跟着选中项与端口实时变，点「保存并重启 ComfyUI」才落盘
    listenSel.addEventListener("change", renderLanHint);
    portIn.addEventListener("input", renderLanHint);
    remoteIn.addEventListener("input", renderLanHint);

    // 内核启停在面板顶部：状态一行 + 启动 / 停止 / 打开地址三枚按钮，此刻做不了的那枚禁用、上不了页面的收起
    // 内核状态行：远程模式没有本机端口 / 谁启动 / PID 可报，只报远端地址；停止内核管不到远端进程，禁用
    function renderKernel(s) {
        const booting = (userStarting() || s.starting) && !s.ready;
        const running = s.running && !booting;
        kernelState.textContent = `ComfyUI ${booting ? t("启动中…") : (s.running ? t("运行中") : t("已停止"))}`
            + (s.remote ? tf(" · 远程 {remote}", { remote: s.remote })
                : tf(" · 端口 {port} · {by}", { port: s.port, by: t(s.mine ? "桌面端启动" : "外部启动") }))
            + (s.pid ? ` · PID ${s.pid}` : "");
        kernelState.classList.toggle("ns-kernel-run", running);
        startBtn.textContent = booting ? t("启动中…") : (s.remote ? t("重连远端") : t("▶ 启动内核"));
        startBtn.disabled = booting || s.running;
        stopBtn.disabled = booting || !s.running || !!s.remote;
        // 地址取桌面端报的那一份：本机端口被占用时它会换到下一个空闲端口，配置里那个端口不一定在听
        kernelUrl = s.remote || `http://127.0.0.1:${s.port || 8188}`;
        openBtn.title = tf("在浏览器打开 {url}", { url: kernelUrl });
        openBtn.style.display = running ? "" : "none";   // 端口没人在听时打开就是浏览器报错页
    }
    onComfyState(renderKernel);
    startBtn.addEventListener("click", () => { startBtn.disabled = true; startKernel(); });
    stopBtn.addEventListener("click", () => { stopBtn.disabled = true; stopKernel(); });
    openBtn.addEventListener("click", () => openExternalUrl(kernelUrl));

    const framelessRow = row(t("无边框窗口"), t(TIPS.frameless), framelessIn);
    const devRow = row(t("开发模式"), t(TIPS.dev), devIn);

    const el = $el("div", { className: "ns-settings-section" }, [
        $el("h3", { textContent: t("启动设置") }),
        $el("div", { className: "ns-kernel" }, [
            kernelState,
            $el("div", { className: "ns-kernel-actions" }, [startBtn, stopBtn, openBtn]),
        ]),
        status,
        // 栏内九行分三类：这台机器上的 ComfyUI 在哪、这个端口谁连得到、桌面窗口自己的样子。平铺时「局域网监听」与「远程 ComfyUI」
        // 看不出是一回事，无边框 / 开发模式又混在 ComfyUI 设置里。启停与状态行始终在顶部，保存按钮管前三类
        $el("div", { className: "ns-launch-group", textContent: t("ComfyUI 位置") }),
        rootRow,
        pyRow,
        $el("div", { className: "ns-launch-group", textContent: t("网络与端口") }),
        portRow,
        listenRow,
        remoteRow,
        $el("div", { className: "ns-launch-group", textContent: t("桌面窗口") }),
        framelessRow,
        devRow,
        $el("div", { className: "ns-launch-group", textContent: t("姿势资产") }),
        poseRow,
        $el("div", { className: "ns-launch-actions" }, [applyBtn, depsBtn, fixBtn]),
        lanHint,
        info,
    ]);
    return { el, refresh };
}

// ====== 界面语言：桌面端设置页的一栏，单选即选即落盘并整页刷新 ======
// 语言只影响桌面端自有文案（顶栏、导演面板、启动设置、状态位）；素材 / 技能 / 各设置表单沿用共享模块原文。
function createLangPanel() {
    const current = getLang();
    const rows = LANGS.map((l) => {
        const input = $el("input", { type: "radio", name: "ns-lang", value: l.value });
        input.checked = l.value === current;
        input.addEventListener("change", () => applyLang(l.value));
        return $el("label", { className: "ns-lang-row" }, [input, $el("span", { textContent: l.label })]);
    });
    return $el("div", { className: "ns-lang" },
        [...rows, $el("div", { className: "ns-lang-hint", textContent: t("选择后立即落盘并整页刷新，界面文案按新语言重建。") })]);
}

// ====== 设置页：左侧 tab 切换（LLM / 生图 / 生视频 / 智能体偏好 / MCP 服务 / 首页 / 界面语言 / 日志 / 启动设置 / 关于），默认 LLM ======
let settingsShow = null;   // 设置页的 tab 切换函数：深链 #/settings?tab=mcp 要用它落到那一栏

let agentPrefs = null;   // 设置页那张偏好表单：深链 #/settings?tab=agent&skill=.. 的预填要走它

function buildSettings(el) {
    // 三个表单工厂均返回 { el, load, save, isDirty }，挂 .el、后台 load（保存按钮在表单内部）
    const genForm = createImageGenSettingsForm();
    const videoForm = createVideoGenSettingsForm();
    const llmForm = createModelConfigForm();

    // 日志面板：tab 激活时轮询。桌面端里两份日志分块 —— 内核那块是桌面端拉起 ComfyUI 的输出，
    // 桌面端那块是自身的启动 / 跳转 / 前端错误轨迹；浏览器标签页只有内核那一块，来源筛选不上页面
    const logBody = $el("pre", { className: "ns-log" });
    let logTimer = null;
    let logStick = true;   // 贴底才自动滚；用户往上翻看时停住，翻回底部恢复
    let logEntries = [];   // 最近一轮的条目：切来源只重渲染这一份，不为此多发一次请求
    let logSrc = "all";

    const logAtBottom = () =>
        logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight <= 40;
    logBody.addEventListener("scroll", () => { logStick = logAtBottom(); });

    // 每 2 秒整段重写 <pre> 会把拖到一半的选区抹掉；选区落在日志里就跳过这一轮刷新
    const logSelected = () => {
        const sel = window.getSelection();
        return !!sel && !sel.isCollapsed && logBody.contains(sel.anchorNode);
    };

    // 按钮只给短标签（390 宽的手机上整行放不下全称），完整来源名留在鼠标提示与块标题里
    const SRC_BTN = { all: "全部", studio: "桌面端", comfy: "内核" };
    const SRC_TITLE = {
        all: "按来源筛选日志",
        studio: "只看 Neo Studio 桌面端日志",
        comfy: "只看 ComfyUI 内核日志",
    };
    const SRC_HEAD = { studio: "Neo Studio 桌面端", comfy: "ComfyUI 内核" };
    const srcBtns = {};
    const logSrcBar = $el("div", { className: "ns-log-srcs" });
    for (const key of ["all", "studio", "comfy"]) {
        srcBtns[key] = $el("button", {
            className: "ns-btn ns-log-src-btn",
            title: t(SRC_TITLE[key]),
            textContent: t(SRC_BTN[key]),
            onclick: () => {
                logSrc = key;
                paintLog();
                paintSrcBar();
                if (logStick) logBody.scrollTop = logBody.scrollHeight;
            },
        });
        logSrcBar.appendChild(srcBtns[key]);
    }

    // 只有一块时不分块：浏览器标签页里没有桌面端那一路，块标题与「桌面端」筛选钮都是多余控件
    const logSplit = () => logEntries.some((e) => e.src === "studio");

    function paintSrcBar() {
        const split = logSplit();
        for (const key of Object.keys(srcBtns)) {
            srcBtns[key].classList.toggle("is-on", key === logSrc);
            srcBtns[key].style.display = key === "studio" && !split ? "none" : "";
        }
    }

    function paintLog() {
        // 条目是原始 stdout，自带换行与 ANSI 色码；色码在网页里是乱码，剥掉
        const split = logSplit();
        const nodes = [];
        let shown = null;
        for (const e of logEntries) {
            const src = e.src || "comfy";
            if (logSrc !== "all" && src !== logSrc) continue;
            if (split && src !== shown) {
                nodes.push($el("span", { className: "ns-log-src", textContent: `—— ${t(SRC_HEAD[src])} ——\n` }));
                shown = src;
            }
            nodes.push(String(e.m).replace(/\x1b\[[0-9;]*m/g, ""));
        }
        logBody.replaceChildren(...nodes);
    }

    async function refreshLog() {
        if (logSelected()) return;
        try {
            const data = await (await api.fetchApi("/neo_studio/log")).json();
            logEntries = data.entries || [];
            paintLog();
            paintSrcBar();
            if (logStick) logBody.scrollTop = logBody.scrollHeight;
        } catch { /* ComfyUI 未就绪时保留上次内容 */ }
    }

    // 整段取走日志：非 dev 模式的桌面窗口里 WebView2 关掉了右键菜单与 Ctrl+C，
    // 页内按钮是不依赖这两条通道就能拿到日志的路径
    // 按钮的 mousedown 默认动作会清掉页面选区，click 时已经读不到 —— 下按时先把选区取走
    let logSelText = "";
    const copyLogBtn = $el("button", {
        className: "ns-btn ns-log-copy",
        title: t("有选区复制选区，没有选区复制全部日志"),
        onclick: async () => {
            const picked = !!logSelText;
            const text = logSelText || logBody.textContent;
            logSelText = "";
            if (!text) { toast(t("日志为空")); return; }
            const lines = text.split("\n").length;
            try {
                await navigator.clipboard.writeText(text);
                toast(picked ? tf("已复制选中内容（{n} 行）", { n: lines })
                             : tf("日志已复制（{n} 行）", { n: lines }));
            } catch (e) {
                toast(tf("复制失败：{msg}", { msg: String(e) }));
            }
        },
    }, [icon("copy"), " " + t("复制日志")]);
    copyLogBtn.addEventListener("mousedown", () => {
        const sel = window.getSelection();
        logSelText = sel && !sel.isCollapsed && logBody.contains(sel.anchorNode) ? sel.toString() : "";
    });
    const launcher = createLauncherPanel();
    const mcp = createMcpPanel();
    const pairPanel = createPairPanel({ api, t, tf, toast });
    const prefs = createAgentPrefsForm({
        previewMode, setPreviewMode,
    });
    agentPrefs = prefs;   // 深链带预填参数进来时，route() 要把焦点链那份值交给这张表单

    const section = (title) => $el("h3", { textContent: t(title) });
    // 左栏自上而下四段：启动与连接（启动设置 / 启动日志 / 手机连接）· 生成（LLM / 生图 / 生视频）·
    // 智能体（偏好 / MCP）· 语言与关于（界面语言 / 关于）。十项平铺时找「生图默认值」要逐条扫，
    // 段之间只落一条无文字的细线，界面上的行数就等于设定项的数目；tab 的 key 与深链 #/settings?tab=.. 全不变
    // （首页版式不在这里排——它由首页右上角「编辑首页」原地改，见 web/studio/home-layout.js）
    const sections = [
        { key: "launch", group: "startup", label: t("启动设置"), body: launcher.el },
        { key: "log", group: "startup", label: t("启动日志"), body: $el("div", { className: "ns-settings-section ns-log-section" }, [$el("div", { className: "ns-log-head" }, [section("启动日志"), logSrcBar, copyLogBtn]), logBody]) },
        { key: "pair", group: "startup", label: t("手机连接"), body: pairPanel.el },
        { key: "llm", group: "generate", label: t("LLM 设置"), body: $el("div", { className: "ns-settings-section" }, [section("LLM 设置"), llmForm.el]) },
        { key: "gen", group: "generate", label: t("生图设置"), body: $el("div", { className: "ns-settings-section" }, [section("生图设置"), genForm.el]) },
        { key: "video", group: "generate", label: t("生视频设置"), body: $el("div", { className: "ns-settings-section" }, [section("生视频设置"), videoForm.el]) },
        { key: "agent", group: "agent", label: t("智能体偏好"), body: $el("div", { className: "ns-settings-section" }, [section("智能体偏好"), prefs.el]) },
        { key: "mcp", group: "agent", label: t("MCP 服务"), body: $el("div", { className: "ns-settings-section ns-mcp-section" }, [section("MCP 服务"), mcp.root]) },
        { key: "lang", group: "ui", label: t("界面语言"), body: $el("div", { className: "ns-settings-section" }, [section("界面语言"), createLangPanel()]) },
        { key: "about", group: "ui", label: t("关于"), body: $el("div", { className: "ns-settings-section ns-about-section" }, [section("关于"), $el("div", { className: "ns-about-version", id: "ns-about-version", textContent: versionText() }), $el("div", { className: "ns-about-rows", id: "ns-about-rows" })]) },
    ];

    const tabs = $el("div", { className: "ns-settings-tabs" });
    const content = $el("div", { className: "ns-settings-content" });
    const showSection = (key) => {
        // 认不出的 tab 名落回默认栏：旧书签里的 #/settings?tab=home（首页版式已并到首页原地编辑）
        // 走进原来那套循环会让每一块 body 都 display:none，设置页开成一片空白
        if (!sections.some((s) => s.key === key)) key = "llm";
        for (const s of sections) s.body.style.display = s.key === key ? "" : "none";
        for (const btn of tabs.children) btn.classList.toggle("active", btn.dataset.key === key);
        if (key === "log") {
            logStick = true;   // 重新进 tab 回到最新，之后按用户滚动位置决定
            refreshLog();
            logTimer = setInterval(refreshLog, 2000);
        } else if (key === "mcp") {
            mcp.refresh().catch(e => console.error("[Neo Studio] mcp panel refresh failed:", e));
        } else if (key === "agent") {
            prefs.load().catch(e => console.error("[Neo Studio] agent prefs load failed:", e));
        } else if (key === "pair") {
            pairPanel.refresh();   // 二维码倒计时要跟着秒走，离开这栏就停轮询
        } else {
            pairPanel.stop();
            if (logTimer) {
                clearInterval(logTimer);
                logTimer = null;
            }
        }
    };
    settingsShow = showSection;
    let lastGroup = null;
    for (const s of sections) {
        if (s.group !== lastGroup) {   // 段间线与 tab 平级放在左栏里：测试与深链都按 [data-key] 取 tab，线只做切段
            if (tabs.children.length) tabs.appendChild($el("div", { className: "ns-settings-sep" }));
            lastGroup = s.group;   // 首组顶部不落线，摘掉整组 tab（浏览器形态的启动设置）之后条首不悬空线
        }
        const btn = $el("button", { className: "ns-settings-tab", textContent: s.label });
        btn.dataset.key = s.key;
        btn.addEventListener("click", () => showSection(s.key));
        tabs.appendChild(btn);
        content.appendChild(s.body);
    }

    el.appendChild($el("div", { className: "ns-settings" }, [tabs, content]));
    showSection("llm");  // 默认 LLM 设置
    renderAboutRows();   // 版本快照早于本页建成：路径行在 DOM 齐了之后补一次
    Promise.all([genForm.load(), videoForm.load(), llmForm.load()])
        .catch(e => console.error("[Neo Studio] settings load failed:", e));
    // 桥由 pywebview 在导航完成后才注入、方法还要晚一步填：桥在长就等它长完，别把桌面端窗口判成浏览器
    (async () => {
        for (let tries = 0; tries < 10; tries++) {
            try {
                await launcher.refresh();
                return;
            } catch {
                if (!window.pywebview) break;
                await new Promise(r => setTimeout(r, 300));
            }
        }
        launcher.el.remove();
        tabs.querySelector('[data-key="launch"]')?.remove();
    })();
}

return {
    buildSettings,
    // 深链的两条落点：页没建过时 settingsShow / agentPrefs 还是 null，跳过去就是空跳
    showSettingsTab: (tab) => settingsShow?.(tab),
    prefillAgentPrefs: (query) => agentPrefs?.prefill(query),
};
}
