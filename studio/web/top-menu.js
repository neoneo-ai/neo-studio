/**
 * top-menu.js — 顶栏 菜单（插件统一入口）
 * 把插件入口收敛为顶栏一个动作按钮（图标），悬停约 0.3 秒或点击展开下拉菜单
 * （悬停刚展开 0.5 秒内的点击算同一次手势、不收起，之后点击正常收起）：
 *   新影工坊 / 生成素材 / 新建导演配方 / 创建节点（二级菜单，往画布当前可见区的空白处添加 Neo 节点）
 *   修复工作流（右键 = 修复映射管理）/ 回写入技能（画布上有技能待回写时可用）/ 修复记录 / 变更记录（技能回写历史）
 *   设置（统一设置弹窗：LLM / 生图默认 / 生视频模型 / 界面语言四 tab）/ 模型库 / 技能管理
 *   关于插件。
 * 提示点由外部状态驱动、本模块只提供 .neo-n-menu-btn 按钮与样式：
 * 红点 = workflow.js 的 setRepairHint（失效模型路径），绿点 = skill.js 的画布技能待回写。
 */
import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { showToast } from "./gallery-utils.js";
import { openDirectorEditor } from "./director.js";
import { createModelConfigForm } from "./llm-setting.js";
import { createImageGenSettingsForm, createVideoGenSettingsForm } from "./image-gen.js";
import { runRepair, showRepairLogDialog, showRepairMappingsDialog } from "./workflow.js";
import { openSkillManager, runSkillWorkflowHandoff, showSkillWriteLogDialog, getPendingWriteback, runCanvasSkillWriteback } from "./skill.js";
import { openGenMaterialDialog } from "./gallery-gen.js";
import { openModelHub } from "./model-hub.js";
import { t, tf, getLang, applyLang, LANGS } from "./js/core/i18n.js";

const STUDIO_URL = "/neo-studio";
const REPO_URL = "https://github.com/neoneo-ai/neo-studio";

// 创建节点子菜单：主节点；运行时按 LiteGraph.registeredNodes 过滤（模块加载失败自动隐藏）
// NeoH3SegmentRun 为内部节点（/neo_video_gen/run_segment 组装 prompt 用），不列进菜单
const NODE_ITEMS = [
    { type: "NeoPromptAgent", label: t("Neo Prompt Agent（提示词智能体）") },
    { type: "NeoPromptEncoder", label: t("Neo Prompt Encoder（提示词编码器）") },
    { type: "NeoImageGenEdit", label: t("Neo Image Gen & Edit（图像生成与编辑）") },
    { type: "NeoH3VideoDirector", label: t("Neo H3 Video Director（视频导演）") },
    { type: "NeoBundleExpand", label: t("Neo Bundle Expand（Bundle 展开）") },
    { type: "NeoRefGrid", label: t("Neo Reference Grid（参考图宫格）") },
    { type: "NeoGridSplit", label: t("Neo Grid Split（宫格图拆分）") },
];

let menuEl = null;
let _outsideHandler = null;
let _escHandler = null;
let _ctxMenuBound = false;
let _hoverBound = false;

// 悬停展开 / 移出收起：actionBarButtons 是声明式渲染，按钮 DOM 由前端重建，
// 一律在 document 层按类名委托，不绑定到具体元素
const HOVER_OPEN_MS = 300;    // 悬停 按钮多久后自动展开
const HOVER_CLOSE_MS = 500;   // 指针离开按钮与菜单多久后自动收起
const HOVER_CLICK_GRACE_MS = 500;   // 悬停刚展开后的宽限期：期内点击算同一次手势，不收起
let _hoverOpenTimer = 0;
let _hoverCloseTimer = 0;
let _hoverOpenedAt = 0;   // 本次菜单由悬停展开的时刻（点击展开为 0）

function clearHoverTimers() {
    clearTimeout(_hoverOpenTimer);
    _hoverOpenTimer = 0;
    clearTimeout(_hoverCloseTimer);
    _hoverCloseTimer = 0;
}

// 热区 = 按钮本体 + 已展开的菜单
function inMenuZone(target) {
    if (!(target instanceof Element)) return false;
    return !!target.closest(".neo-n-menu-btn") || !!(menuEl && menuEl.contains(target));
}

function scheduleHoverClose() {
    if (!menuEl || _hoverCloseTimer) return;
    _hoverCloseTimer = setTimeout(() => {
        _hoverCloseTimer = 0;
        closeMenu();
    }, HOVER_CLOSE_MS);
}

function onHoverOver(e) {
    if (e.pointerType && e.pointerType !== "mouse") return;   // 触屏点按会补发 pointerover，忽略
    if (!inMenuZone(e.target)) {
        scheduleHoverClose();
        return;
    }
    clearTimeout(_hoverCloseTimer);
    _hoverCloseTimer = 0;
    const btn = e.target.closest(".neo-n-menu-btn");
    if (btn && !menuEl && !_hoverOpenTimer) {
        _hoverOpenTimer = setTimeout(() => {
            _hoverOpenTimer = 0;
            openMenu(btn, true);
        }, HOVER_OPEN_MS);
    }
}

function onHoverOut(e) {
    if (e.pointerType && e.pointerType !== "mouse") return;
    if (inMenuZone(e.relatedTarget)) return;   // 按钮与菜单之间来回移动不算离开
    clearTimeout(_hoverOpenTimer);
    _hoverOpenTimer = 0;
    scheduleHoverClose();
}

function closeMenu() {
    if (!menuEl) return;
    clearHoverTimers();
    _hoverOpenedAt = 0;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener("pointerdown", _outsideHandler, true);
    document.removeEventListener("keydown", _escHandler);
    _outsideHandler = null;
    _escHandler = null;
}

// 菜单项：点击后先收起菜单再执行动作
function menuItem(label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "neo-n-menu-item";
    btn.textContent = label;
    btn.onclick = (e) => { e.stopPropagation(); closeMenu(); onClick(); };
    return btn;
}

// 菜单项右侧引导点：与 按钮上的提示点同步（红=待修复，绿=待回写）
function menuDot(item, cls) {
    const dot = document.createElement("span");
    dot.className = `neo-n-menu-dot ${cls}`;
    item.appendChild(dot);
}

function separator() {
    const sep = document.createElement("div");
    sep.className = "neo-n-menu-sep";
    return sep;
}

// 当前可见区对应的图坐标矩形（LiteGraph 屏幕变换 screen=(graph+offset)*scale）
function visibleGraphRect(cv) {
    const s = cv?.ds?.scale;
    const rect = cv?.canvas?.getBoundingClientRect?.();
    if (!s || !rect?.width || !rect?.height) return null;
    const ox = cv.ds.offset?.[0] ?? 0;
    const oy = cv.ds.offset?.[1] ?? 0;
    return [-ox, -oy, rect.width / s - ox, rect.height / s - oy];
}

// 从可见区中心一圈圈往外找：第一个不与已有节点重叠、且整块落在可见区内的落点
function freeSpotInVisible(rect, node) {
    const [nw, nh] = node.size || [200, 100];
    const gap = 24;
    const blocked = (x, y) => (app.graph.nodes || []).some((n) => {
        if (n === node) return false;
        const [sw, sh] = n.size || [200, 100];
        return x < n.pos[0] + sw + gap && x + nw + gap > n.pos[0] &&
            y < n.pos[1] + sh + gap && y + nh + gap > n.pos[1];
    });
    const cx = (rect[0] + rect[2]) / 2 - nw / 2;
    const cy = (rect[1] + rect[3]) / 2 - nh / 2;
    const step = Math.max(40, Math.round(Math.min(rect[2] - rect[0], rect[3] - rect[1]) / 6));
    for (let ring = 0; ring < 12; ring++) {
        for (let i = -ring; i <= ring; i++) {
            for (let j = -ring; j <= ring; j++) {
                if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
                const x = cx + i * step;
                const y = cy + j * step;
                if (x < rect[0] || y < rect[1] || x + nw > rect[2] || y + nh > rect[3]) continue;
                if (!blocked(x, y)) return [x, y];
            }
        }
    }
    return null;
}

// 往画布创建节点：落点取当前可见区的空白处，节点不会跑到视野外找不到
function addNodeToCanvas(type) {
    const L = globalThis.LiteGraph;
    if (!L?.createNode) { showToast(app, "error", t("无法创建节点"), t("LiteGraph 未就绪")); return; }
    if (!app.graph) { showToast(app, "info", t("画布为空"), t("请先打开一个工作流")); return; }
    const node = L.createNode(type);
    app.graph.add(node);
    const cv = app.canvas;
    const rect = visibleGraphRect(cv);
    const spot = rect && freeSpotInVisible(rect, node);
    if (spot) {
        node.pos = spot;
    } else {
        const [nw, nh] = node.size || [200, 100];
        if (rect) {
            node.pos = [(rect[0] + rect[2]) / 2 - nw / 2, (rect[1] + rect[3]) / 2 - nh / 2];
        } else if (cv?.canvasPosToGraph) {
            const r = cv.canvas.getBoundingClientRect();
            node.pos = cv.canvasPosToGraph([r.width / 2, r.height / 2]);
        } else {
            node.pos = [200, 200];
        }
        cv?.focusNode?.(node);   // 可见区里挤不出空位：把视图挪到节点上
    }
    cv?.select?.(node);
    app.graph.setDirtyCanvas(true);
}

function buildNodeSubmenu(subEl) {
    const L = globalThis.LiteGraph;
    for (const it of NODE_ITEMS) {
        if (L?.registeredNodes && !L.registeredNodes[it.type]) continue;   // 节点模块加载失败 → 隐藏该项
        subEl.appendChild(menuItem(t(it.label), () => addNodeToCanvas(it.type)));
    }
}

function showAboutDialog() {
    const existing = document.querySelector(".neo-n-about-dialog");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.className = "neo-n-about-dialog";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9003;display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText = "background:#1e1e1e;color:#ddd;border-radius:8px;padding:16px 20px;width:480px;max-width:92vw;display:flex;flex-direction:column;gap:10px;font-size:13px;";
    const close = () => {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);

    const title = document.createElement("div");
    title.style.cssText = "font-weight:bold;font-size:15px;color:#8cf;";
    title.textContent = "Neo Studio";
    box.appendChild(title);

    const verRow = document.createElement("div");
    verRow.style.cssText = "color:#999;font-size:12px;";
    verRow.textContent = t("版本信息加载中…");
    box.appendChild(verRow);

    const srcRow = document.createElement("div");
    srcRow.style.cssText = "line-height:1.7;";
    const ghLink = document.createElement("a");
    ghLink.href = REPO_URL;
    ghLink.target = "_blank";
    ghLink.rel = "noopener";
    ghLink.style.cssText = "color:#60a5fa;text-decoration:none;";
    ghLink.textContent = REPO_URL;
    srcRow.append(t("源码："), ghLink);
    box.appendChild(srcRow);

    const installRow = document.createElement("div");
    installRow.style.cssText = "color:#bbb;line-height:1.7;white-space:pre-line;";
    installRow.textContent = t("安装方式：\n· ComfyUI Manager 搜索 \"Neo Studio\" 一键安装\n· 或 git clone 到 ComfyUI/custom_nodes/ 后重启");
    box.appendChild(installRow);

    const licRow = document.createElement("div");
    licRow.style.cssText = "color:#999;font-size:12px;";
    licRow.textContent = "License: Apache-2.0";
    box.appendChild(licRow);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = t("关闭");
    closeBtn.style.cssText = "align-self:flex-end;padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;background:#444;color:#ddd;";
    closeBtn.onclick = close;
    box.appendChild(closeBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // 版本信息（复用 Studio 版本端点）
    api.fetchApi("/neo_studio/version")
        .then((resp) => (resp.ok ? resp.json() : null))
        .then((data) => {
            if (!data?.success) return;
            verRow.textContent = tf("插件 v{plugin} · ComfyUI v{comfy}", {
                plugin: data.plugin_version || "unknown",
                comfy: data.comfyui_version || "unknown",
            });
        })
        .catch(() => { verRow.textContent = t("版本信息不可用"); });
}


// ---- 统一设置弹窗（全局单例，与具体节点无关）：LLM / 生图默认 / 生视频模型 / 界面语言四 tab。
// 版式与 Studio 设置页同款：弹窗外壳复用 .neo-director-llm-*（recipes.css），体内左栏 tab + 右栏内容。
// 打开即四个表单后台 load、全部落定前关闭不判脏；有未保存修改时 ✕/点遮罩/Esc 先出确认条
// （保存并关闭 / 放弃修改 / 继续编辑）。幂等：已打开时重复调用不叠加。
// 界面语言表单：单选当前语言，保存即落盘并整页刷新（模块级文案与已渲染 DOM 都要按新语言重建）
function createLangSettingsForm() {
    const el = document.createElement("div");
    el.className = "neo-settings-lang";
    const saved = getLang();
    const rows = LANGS.map((l) => {
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "neo-lang";
        input.value = l.value;
        input.checked = l.value === saved;
        const label = document.createElement("span");
        label.className = "rs-form-label";
        label.textContent = l.label;
        const row = document.createElement("label");
        row.className = "neo-settings-lang-row";
        row.append(input, label);
        return { value: l.value, input, row };
    });
    const hint = document.createElement("div");
    hint.className = "rs-form-hint";
    hint.textContent = t("保存后整页刷新，界面文案按新语言重建。");
    el.append(...rows.map((r) => r.row), hint);
    const picked = () => rows.find((r) => r.input.checked)?.value;
    return {
        el,
        load: async () => {},
        save: async () => {
            const value = picked();
            if (!value || value === getLang()) return true;
            applyLang(value);   // 落盘 + 整页刷新
            return true;
        },
        isDirty: () => picked() !== saved,
    };
}

let _settingsModal = null;

function openSettingsModal() {
    if (_settingsModal && !_settingsModal.parentNode) _settingsModal = null;   // 浮层已被清除（外部/测试重置 body）→ 丢弃过期状态
    if (_settingsModal) return;   // 已打开：忽略，避免叠加

    const forms = [
        { key: "llm", label: t("LLM 设置"), form: createModelConfigForm() },
        { key: "gen", label: t("生图默认设置"), form: createImageGenSettingsForm() },
        { key: "video", label: t("生视频模型"), form: createVideoGenSettingsForm() },
        { key: "lang", label: t("界面语言"), form: createLangSettingsForm() },
    ];
    const tabs = document.createElement("div");
    tabs.className = "neo-settings-tabs";
    const content = document.createElement("div");
    content.className = "neo-settings-content";
    for (const f of forms) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "neo-settings-tab";
        btn.textContent = f.label;
        const panel = document.createElement("div");
        panel.className = "neo-settings-panel";
        panel.appendChild(f.form.el);
        f.btn = btn;
        f.panel = panel;
        tabs.appendChild(btn);
        content.appendChild(panel);
    }
    // 四张表单都常驻 DOM：切 tab 只切显隐，隐藏面板的输入值照常读写、不丢状态
    const setTab = (key) => {
        for (const f of forms) {
            f.btn.classList.toggle("neo-settings-tab-active", f.key === key);
            f.panel.style.display = f.key === key ? "" : "none";
        }
    };
    forms.forEach((f) => { f.btn.onclick = () => setTab(f.key); });
    setTab("llm");

    const saveCloseBtn = document.createElement("button");
    saveCloseBtn.type = "button";
    saveCloseBtn.className = "neo-director-llm-btn-save";
    saveCloseBtn.textContent = t("保存并关闭");
    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "neo-director-llm-btn-discard";
    discardBtn.textContent = t("放弃修改");
    const keepBtn = document.createElement("button");
    keepBtn.type = "button";
    keepBtn.className = "neo-director-llm-btn-keep";
    keepBtn.textContent = t("继续编辑");
    const dirtyConfirm = document.createElement("div");
    dirtyConfirm.className = "neo-director-llm-dirty";
    dirtyConfirm.hidden = true;
    dirtyConfirm.append(
        Object.assign(document.createElement("span"), { textContent: t("有未保存的修改") }),
        (() => { const a = document.createElement("div"); a.className = "neo-director-llm-dirty-actions"; a.append(saveCloseBtn, discardBtn, keepBtn); return a; })(),
    );

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "neo-director-llm-close";
    closeBtn.title = t("关闭（Esc）");
    closeBtn.textContent = "✕";
    const head = document.createElement("div");
    head.className = "neo-director-llm-head";
    head.append(Object.assign(document.createElement("span"), { textContent: t("设置") }), closeBtn);
    const bodyEl = document.createElement("div");
    bodyEl.className = "neo-director-llm-body neo-settings-body";
    bodyEl.append(tabs, content);
    const panel = document.createElement("div");
    panel.className = "neo-director-llm-panel neo-settings-modal";
    panel.append(head, bodyEl, dirtyConfirm);
    const overlay = document.createElement("div");
    overlay.className = "neo-director-llm-overlay";
    overlay.appendChild(panel);

    let ready = false;   // load 全部落定前关闭不判脏（初始化回填不算用户改动）
    const hideConfirm = () => { dirtyConfirm.hidden = true; };
    const performClose = () => {
        hideConfirm();
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        _settingsModal = null;
    };
    const requestClose = () => {
        if (!ready) { performClose(); return; }
        if (forms.some((f) => f.form.isDirty())) { dirtyConfirm.hidden = false; return; }
        performClose();
    };
    closeBtn.onclick = (e) => { e.stopPropagation(); requestClose(); };
    overlay.onclick = (e) => { if (e.target === overlay) requestClose(); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); requestClose(); } };

    saveCloseBtn.onclick = async () => {
        saveCloseBtn.disabled = true;
        const results = await Promise.all(forms.map((f) => f.form.save()));   // 保存失败留在弹窗重试
        saveCloseBtn.disabled = false;
        if (results.every(Boolean)) performClose();
    };
    discardBtn.onclick = () => performClose();
    keepBtn.onclick = () => hideConfirm();

    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey, true);
    Promise.all(forms.map((f) => f.form.load()))
        .catch(() => {})   // 单侧 load 失败不阻断就绪标记（表单内部已兜底记录）
        .then(() => { ready = true; });
    _settingsModal = overlay;
}

function openMenu(anchor, byHover = false) {
    if (menuEl) return;
    _hoverOpenedAt = byHover ? performance.now() : 0;
    menuEl = document.createElement("div");
    menuEl.className = "neo-n-menu";

    menuEl.appendChild(menuItem(t("新影工坊"), () => window.open(STUDIO_URL, "_blank")));
    // 生成素材：纯提示词一键出图（与画廊搜索行同一弹窗），app.neoGallery 由 gallery.js setup 挂全局
    menuEl.appendChild(menuItem(t("生成素材"), () => openGenMaterialDialog(app.neoGallery)));
    menuEl.appendChild(menuItem(t("新建导演配方"), () => openDirectorEditor(null)));

    // 创建节点：飞出式二级菜单（仅点击行展开/收起，悬停不弹）
    const nodeRow = document.createElement("button");
    nodeRow.type = "button";
    nodeRow.className = "neo-n-menu-item neo-n-node-row";
    const nodeLabel = document.createElement("span");
    nodeLabel.textContent = t("创建节点");
    const caret = document.createElement("span");
    caret.className = "neo-n-caret";
    caret.textContent = "▸";
    nodeRow.append(nodeLabel, caret);
    const subEl = document.createElement("div");
    subEl.className = "neo-n-submenu";
    subEl.style.display = "none";
    buildNodeSubmenu(subEl);
    // 贴在「创建节点」行右侧纵向对齐；右侧放不下翻到左侧，再夹进视口
    const placeSubmenu = () => {
        subEl.style.display = "";
        const rowRect = nodeRow.getBoundingClientRect();
        const { width, height } = subEl.getBoundingClientRect();
        const gap = 4;
        let left = rowRect.right + gap;
        if (left + width > window.innerWidth - 8) left = rowRect.left - width - gap;
        left = Math.max(8, left);
        let top = rowRect.top;
        if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - height);
        subEl.style.left = left + "px";
        subEl.style.top = top + "px";
    };
    const setSub = (open) => {
        nodeRow.classList.toggle("open", open);
        if (open) placeSubmenu();
        else subEl.style.display = "none";
    };
    nodeRow.onclick = (e) => {
        e.stopPropagation();
        setSub(subEl.style.display === "none");
    };
    menuEl.append(nodeRow, subEl);

    menuEl.appendChild(separator());
    const repairItem = menuItem(t("修复工作流"), runRepair);
    repairItem.classList.add("neo-n-menu-item-repair");   // 右键 → 修复映射管理
    if (anchor.classList.contains("neo-repair-hint")) menuDot(repairItem, "neo-n-menu-dot-red");   // 按钮红点 → 引导修复
    menuEl.appendChild(repairItem);
    // 画布上有技能待回写（「⤒ 导入到画布」后）：画布上没有卡片，这里是唯一落盘入口；无待回写时置灰
    const writebackItem = menuItem(t("回写入技能"), () => runCanvasSkillWriteback());
    const pendingWb = getPendingWriteback();
    if (!pendingWb) {
        writebackItem.disabled = true;
        writebackItem.title = t("当前画布没有待回写的技能：技能管理「⤒ 导入到画布」后此入口可用");
    } else if (pendingWb.source === "presets") {
        writebackItem.title = tf("技能 \"{id}\" 是预设：模型值写本地覆盖，结构变更自动复制为自定义技能", { id: pendingWb.id });
    } else {
        writebackItem.title = tf("把当前画布落盘技能 \"{id}\"（先列出变更、确认后写入）", { id: pendingWb.id });
    }
    if (anchor.classList.contains("neo-writeback-hint")) menuDot(writebackItem, "neo-n-menu-dot-green");   // 按钮绿点 → 引导回写
    menuEl.appendChild(writebackItem);
    menuEl.appendChild(menuItem(t("修复记录"), showRepairLogDialog));
    menuEl.appendChild(menuItem(t("变更记录"), () => showSkillWriteLogDialog()));

    menuEl.appendChild(separator());
    menuEl.appendChild(menuItem(t("设置"), openSettingsModal));
    menuEl.appendChild(menuItem(t("模型库"), openModelHub));
    menuEl.appendChild(menuItem(t("技能管理"), openSkillManager));

    menuEl.appendChild(separator());
    menuEl.appendChild(menuItem(t("关于插件"), showAboutDialog));

    document.body.appendChild(menuEl);

    const rect = anchor.getBoundingClientRect();
    menuEl.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 250)) + "px";
    menuEl.style.top = (rect.bottom + 6) + "px";

    _outsideHandler = (e) => {
        if (!menuEl) return;
        // 点在菜单内或 按钮上（由 onClick 负责 toggle）→ 不关
        if (e.target instanceof Element && (menuEl.contains(e.target) || e.target.closest(".neo-n-menu-btn"))) return;
        closeMenu();
    };
    _escHandler = (e) => { if (e.key === "Escape") closeMenu(); };
    // 用 pointerdown 而非 mousedown：LiteGraph 画布 touch-action:none，pointerdown 上
    // preventDefault 会按规范抑制后续兼容鼠标事件，画布点击的 mousedown 到不了 document
    document.addEventListener("pointerdown", _outsideHandler, true);
    document.addEventListener("keydown", _escHandler);
}

app.registerExtension({
    name: "comfy.neo.topMenu",
    setup() {
        // 图标：前端把 icon 字段渲染为 <i class=...>，用 ::before 出 emoji 字符（构建期 Tailwind 不保证自定义类）
        const styleId = "neo-n-menu-style";
        if (!document.getElementById(styleId)) {
            const style = document.createElement("style");
            style.id = styleId;
            style.textContent =
                // 胶囊按钮：图标放大 + “Neo” 文字标签（标签放 .neo-n-menu-icon::after，按钮 ::after 留给红点）
                ".neo-n-menu-icon{display:inline-flex;align-items:center;width:auto;height:auto;font-size:13px;line-height:1;color:#ddd;}" +
                ".neo-n-menu-icon::before{content:\"\";display:inline-block;font-size:15px;line-height:1;}" +
                ".neo-n-menu-icon::after{content:\"Neo\";margin-left:6px;font-weight:600;letter-spacing:.3px;}" +
                ".neo-n-menu-btn{position:relative;display:flex;align-items:center;padding:4px 12px;border-radius:999px;background:#262626;border:1px solid #3a3a3a;transition:background .2s,border-color .2s,box-shadow .2s;}" +
                ".neo-n-menu-btn:hover{background:#2e2e2e;border-color:#4a4a4a;}" +
                // 技能回写绿点提示（skill.js 待回写状态驱动）：绿框 + 右上角绿点，写在红点之前 → 同时命中时红点优先
                ".neo-n-menu-btn.neo-writeback-hint{border-color:var(--success-green,#4ade80);box-shadow:0 0 0 1px rgba(74,222,128,.3);}" +
                ".neo-n-menu-btn.neo-writeback-hint::after{content:\"\";position:absolute;top:-2px;right:-2px;width:7px;height:7px;border-radius:50%;background:var(--success-green,#4ade80);box-shadow:0 0 0 2px rgba(0,0,0,.25);}" +
                // 修复红点提示（workflow.js setRepairHint 驱动）：红框 + 右上角红点
                ".neo-n-menu-btn.neo-repair-hint{border-color:var(--error-red,#f87171);box-shadow:0 0 0 1px rgba(248,113,113,.3);}" +
                ".neo-n-menu-btn.neo-repair-hint::after{content:\"\";position:absolute;top:-2px;right:-2px;width:7px;height:7px;border-radius:50%;background:var(--error-red,#f87171);box-shadow:0 0 0 2px rgba(0,0,0,.25);}" +
                ".neo-n-menu{position:fixed;z-index:9002;background:#1e1e1e;border:1px solid #3a3a3a;border-radius:8px;padding:6px;min-width:240px;box-shadow:0 8px 24px rgba(0,0,0,.5);}" +
                ".neo-n-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:none;background:transparent;color:#ddd;font-size:13px;text-align:left;border-radius:6px;cursor:pointer;}" +
                ".neo-n-menu-item:hover{background:#2a2a2a;color:#fff;}" +
                ".neo-n-menu-item:disabled{opacity:.45;cursor:default;}" +
                // 菜单项右侧引导点：与 按钮提示点同步（红=待修复，绿=待回写）
                ".neo-n-menu-dot{width:7px;height:7px;border-radius:50%;margin-left:auto;box-shadow:0 0 0 2px rgba(0,0,0,.25);}" +
                ".neo-n-menu-dot-red{background:var(--error-red,#f87171);}" +
                ".neo-n-menu-dot-green{background:var(--success-green,#4ade80);}" +
                ".neo-n-caret{margin-left:auto;font-size:10px;color:#888;transition:transform .15s;}" +
                ".neo-n-node-row.open .neo-n-caret{transform:rotate(90deg);}" +
                // 飞出式二级菜单：fixed 脱离父菜单，贴「创建节点」行右侧弹出（定位在 JS 里算）
                ".neo-n-submenu{position:fixed;z-index:9003;min-width:250px;padding:6px;background:#1e1e1e;border:1px solid #3a3a3a;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);}" +
                ".neo-n-menu-sep{height:1px;background:#3a3a3a;margin:5px 8px;}";
            document.head.appendChild(style);
        }
        // 悬停展开 / 移出收起（document 层委托，按钮由前端声明式渲染）
        if (!_hoverBound) {
            _hoverBound = true;
            document.addEventListener("pointerover", onHoverOver);
            document.addEventListener("pointerout", onHoverOut);
        }
        // 右键「修复工作流」菜单项 → 修复映射管理（actionBarButtons 是声明式渲染，按类名在 document 层拦截）
        if (!_ctxMenuBound) {
            _ctxMenuBound = true;
            document.addEventListener("contextmenu", (e) => {
                if (e.target instanceof Element && e.target.closest(".neo-n-menu-item-repair")) {
                    e.preventDefault();
                    showRepairMappingsDialog();
                }
            });
        }
        runSkillWorkflowHandoff();   // Studio「⤒ 主画布编辑」交接：?neo_wf_edit=<id> → 灌画布 + 回写入口
    },
    actionBarButtons: [
        {
            icon: "neo-n-menu-icon size-5",
            onClick: (e) => {
                if (!menuEl) { openMenu(e.currentTarget); return; }
                // 悬停刚展开的宽限期内：这次点击算同一次手势（手指已停在按钮上），不收起
                if (_hoverOpenedAt && performance.now() - _hoverOpenedAt < HOVER_CLICK_GRACE_MS) return;
                closeMenu();
            },
            class: "neo-n-menu-btn",
        },
    ],
});

// 测试用：收起残留菜单
export function resetTopMenu() { closeMenu(); }
