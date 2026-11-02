/**
 * model-hub.js — 模型库（Comfy-Org 专区 · Hugging Face / ModelScope / Civitai 三源）
 * 顶栏 → 模型库：搜索仓库 → 文件清单（按 split_files 前缀自动归类 + 已存在标记）
 * → 流式下载（进度 / 速度 / 取消，.part 断点续传）。落盘子目录取类别目录下已有子目录成下拉
 * （默认自动探查，可选「＋ 新建子目录…」现填）。面板管理默认源、HF 端点、两侧 Token、
 * LLM 子目录与超时。Civitai 源走 LoRA 搜索（类型 / 底模 / 排序 / NSFW）→ 版本权重清单，
 * API KEY 与代理沿用画廊设置里的 C 站配置。技能修复弹窗可用 openModelHub({ query, category })
 * 预填并定位下载目标。
 * 预设就绪（/neo_skill_models/*）：族系总览 → 单预设缺失出下载计划 → 逐条走本库下载，下完刷新就位。
 */
import { app } from "../../../../scripts/app.js";
import { showToast } from "./gallery-utils.js";
import { t, tf } from "./js/core/i18n.js";

if (!document.getElementById("neo-hub-css")) {
    const link = document.createElement("link");
    link.id = "neo-hub-css";
    link.rel = "stylesheet";
    link.href = "/extensions/comfyui-neo-studio/model-hub.css";
    document.head.appendChild(link);
}

const API = "/neo_model_hub";
const SKILL_API = "/neo_skill_models";   // 预设就绪检查与下载计划，计划条目的 payload 直接喂本库下载
const SOURCE_NAMES = { modelscope: "ModelScope", huggingface: "Hugging Face", civitai: "Civitai" };
const CIVITAI_TYPE_NAMES = { LORA: "LoRA", LoCon: "LoCon", DoRA: "DoRA" };
const CIVITAI_SORT_NAMES = {
    "Most Downloaded": t("下载量"), "Highest Rated": t("评分"), "Most Liked": t("最多点赞"),
    "Most Collected": t("最多收藏"), "Newest": t("最新"), "Recently Added": t("最近收录"),
};
const READY_KIND_NAMES = { image: t("生图"), video: t("视频") };

let hub = null;

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
}

async function apiReq(base, path, body) {
    const resp = await fetch(base + path, body
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : undefined);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success === false) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
}

async function req(path, body) { return apiReq(API, path, body); }

/** 预设就绪接口（/neo_skill_models/*）：与模型库同一套请求口径与报错方式。 */
async function skillReq(path, body) { return apiReq(SKILL_API, path, body); }

// ---------------------------------------------------------------------------
// 列表渲染
// ---------------------------------------------------------------------------

function sourceMark(entry) {
    if (entry.on_hf && entry.on_ms) return t("双源");
    if (entry.on_ms) return "MS";
    if (entry.on_hf) return "HF";
    return t("未探测");
}

function fillRepos(h) {
    const sel = h.ui.repoSel;
    sel.innerHTML = "";
    const byName = new Map(h.repos.map((r) => [r.repo, r]));
    const used = new Set();
    const addRepo = (parent, entry) => {
        const o = document.createElement("option");
        o.value = entry.repo;
        o.textContent = `${entry.repo}${entry.downloads ? ` · ${entry.downloads}` : ""} · ${sourceMark(entry)}`;
        parent.appendChild(o);
        used.add(entry.repo);
    };
    for (const group of h.registry.groups || []) {
        const members = (group.repos || []).map((name) => byName.get(name)).filter(Boolean);
        if (!members.length) continue;
        const grp = document.createElement("optgroup");
        grp.label = group.name || t("分组");
        for (const entry of members) addRepo(grp, entry);
        sel.appendChild(grp);
    }
    const rest = h.repos.filter((r) => !used.has(r.repo));
    if (rest.length) {
        const grp = document.createElement("optgroup");
        grp.label = t("其他");
        for (const entry of rest) addRepo(grp, entry);
        sel.appendChild(grp);
    }
    if (h.wantRepo && byName.has(h.wantRepo)) sel.value = h.wantRepo;
}

function fillCategories(h) {
    const sel = h.ui.catSel;
    sel.innerHTML = "";
    for (const c of h.categories) {
        const o = document.createElement("option");
        o.value = c;
        o.textContent = c;
        sel.appendChild(o);
    }
    if (h.wantCategory && h.categories.includes(h.wantCategory)) sel.value = h.wantCategory;
}

function fillFiles(h) {
    const sel = h.ui.fileList;
    sel.innerHTML = "";
    for (const f of h.files) {
        const o = document.createElement("option");
        o.value = f.path;
        o.dataset.category = f.category;
        o.dataset.filename = f.filename;
        o.dataset.existsSub = f.exists_sub || "";
        o.textContent = `${f.filename}  [${f.category}]  ${fmtSize(f.size)}` +
            `${f.version_name ? `  〈${f.version_name}〉` : ""}` +
            `${f.exists ? `  ${t("已存在")}${f.exists_sub ? ` (${f.exists_sub})` : ""}` : ""}`;
        sel.appendChild(o);
    }
    updateTarget(h);
}

function selectedFile(h) {
    const opt = h.ui.fileList.selectedOptions[0];
    if (!opt || !opt.value) return null;
    return { path: opt.value, category: opt.dataset.category, filename: opt.dataset.filename,
             existsSub: opt.dataset.existsSub || "" };
}

function updateTarget(h) {
    const file = selectedFile(h);
    if (!file) { h.ui.destText.textContent = ""; return; }
    if (h.categories.includes(file.category)) h.ui.catSel.value = file.category;
    const sub = currentSubfolder(h).replace(/^\/+|\/+$/g, "");
    const repoPart = file.category === "llm" ? `${repoBaseName(h.ui.repoSel.value)}/` : "";
    h.ui.destText.textContent = `→ models/${h.ui.catSel.value}/${sub ? `${sub}/` : ""}${repoPart}${file.filename}`;
}

// ---------------------------------------------------------------------------
// 落盘子目录：已有目录成列表 + 默认自动探查 + 新建子目录
// ---------------------------------------------------------------------------

const NEW_SUB = "__new__";

function repoBaseName(repo) {
    const name = String(repo || "").replace(/\\/g, "/").split("/").pop();
    return name === "." || name === ".." ? "" : name;
}

function currentSubfolder(h) {
    return h.ui.subSel.value === NEW_SUB ? h.ui.subNew.value.trim() : h.ui.subSel.value;
}

function syncNewSub(h) {
    const isNew = h.ui.subSel.value === NEW_SUB;
    h.ui.subNew.style.display = isNew ? "" : "none";
    if (isNew) h.ui.subNew.focus();
}

function fillSubfolders(h, subs, def, prefer) {
    const sel = h.ui.subSel;
    sel.innerHTML = "";
    const add = (value, text) => {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = text;
        sel.appendChild(o);
    };
    add("", t("（根目录）"));
    for (const s of subs) add(s, s);
    add(NEW_SUB, t("＋ 新建子目录…"));
    // 已存在文件所在子目录 > 探查默认 > 根目录
    if (prefer && !subs.includes(prefer)) add(prefer, prefer);
    sel.value = prefer && subs.includes(prefer) ? prefer : (subs.includes(def) ? def : "");
    syncNewSub(h);
}

async function loadSubfolders(h, prefer) {
    try {
        const data = await req("/subfolders", { category: h.ui.catSel.value, repo: h.ui.repoSel.value });
        fillSubfolders(h, data.subfolders || [], data.default || "", prefer || "");
    } catch (e) {
        fillSubfolders(h, [], "", prefer || "");
    }
    updateTarget(h);
}

/** 已存在文件所在的子目录：同模型同类别的文件通常同目录，点文件即跟随。 */
function selectedSub(h) {
    const file = selectedFile(h);
    if (!file || !file.existsSub) return "";
    let sub = file.existsSub;
    if (file.category === "llm") {
        const repo = repoBaseName(h.ui.repoSel.value);
        if (repo && (sub === repo || sub.startsWith(`${repo}/`))) sub = sub.slice(repo.length + 1);
    }
    return sub;
}

function applySubfolder(h, sub) {
    if (!sub) return;
    const sel = h.ui.subSel;
    if (![...sel.querySelectorAll("option")].some((o) => o.value === sub)) {
        const o = el("option", "", sub);
        o.value = sub;
        sel.appendChild(o);
    }
    sel.value = sub;
}


// ---------------------------------------------------------------------------
// 弹窗结构
// ---------------------------------------------------------------------------

function field(labelText, input) {
    const wrap = el("label", "neo-hub-field");
    wrap.append(el("span", "neo-hub-field-label", labelText), input);
    return wrap;
}

function buildUI(h) {
    const overlay = el("div", "neo-hub-overlay");
    const box = el("div", "neo-hub-box");

    const head = el("div", "neo-hub-head");
    const srcWrap = el("div", "neo-hub-src");
    const srcBtns = {};
    for (const [key, label] of Object.entries(SOURCE_NAMES)) {
        const b = el("button", "neo-hub-src-btn", label);
        b.type = "button";
        b.dataset.source = key;
        b.addEventListener("click", () => {
            if (h.source === key) return;
            h.source = key;
            syncSource(h);
            loadRepos(h, false);
            if (h.readySkill) loadReadyPlan(h, h.readySkill);   // 已出计划时换源重出：计划跟着当前源走
        });
        srcBtns[key] = b;
        srcWrap.appendChild(b);
    }
    const refreshBtn = el("button", "neo-hub-icon-btn", "⟳");
    refreshBtn.type = "button";
    refreshBtn.title = t("跳过缓存重新拉取仓库与文件清单");
    refreshBtn.addEventListener("click", () => loadRepos(h, true));
    const readyBtn = el("button", "neo-hub-btn neo-hub-ready-toggle", t("预设就绪"));
    readyBtn.type = "button";
    readyBtn.title = t("查看每个预设要用的模型文件是否已在本机模型根里");
    readyBtn.addEventListener("click", () => toggleReady(h));
    const settingsBtn = el("button", "neo-hub-icon-btn", "");
    settingsBtn.type = "button";
    settingsBtn.title = t("模型库设置（源 / 端点 / Token / LLM 子目录 / 超时）");
    const closeBtn = el("button", "neo-hub-icon-btn", "✕");
    closeBtn.type = "button";
    head.append(el("span", "neo-hub-title", t("模型库 · Comfy-Org")), srcWrap, refreshBtn, readyBtn, settingsBtn, closeBtn);

    const readyWrap = el("div", "neo-hub-ready");
    readyWrap.style.display = "none";
    const readyHead = el("div", "neo-hub-row");
    const readySummary = el("span", "neo-hub-ready-summary", t("预设就绪总览加载中…"));
    const readyOptional = el("label", "neo-hub-check");
    const readyOptionalInput = el("input");
    readyOptionalInput.type = "checkbox";
    readyOptional.append(readyOptionalInput, el("span", "", t("计划含可选文件")));
    const readyRefresh = el("button", "neo-hub-btn neo-hub-ready-refresh", t("刷新"));
    readyRefresh.type = "button";
    readyHead.append(readySummary, readyOptional, readyRefresh);
    const readyBody = el("div", "neo-hub-ready-body");
    readyWrap.append(readyHead, readyBody);

    const searchRow = el("div", "neo-hub-row");
    const searchInput = el("input", "neo-hub-input neo-hub-search");
    searchInput.type = "text";
    searchInput.placeholder = t("搜索仓库名（Comfy-Org 内子串匹配 + 跨组织搜索）");
    const searchBtn = el("button", "neo-hub-btn", t("搜索"));
    searchBtn.type = "button";
    searchBtn.addEventListener("click", () => loadRepos(h, false));
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadRepos(h, false); });
    searchRow.append(searchInput, searchBtn);

    // Civitai 过滤行：类型 / 底模 / 排序 / NSFW，仅 C 站源显示
    const civiRow = el("div", "neo-hub-row neo-hub-civi");
    const civiTypeSel = el("select", "neo-hub-input neo-hub-civi-type");
    for (const [key, label] of Object.entries(CIVITAI_TYPE_NAMES)) {
        const o = document.createElement("option");
        o.value = key;
        o.textContent = label;
        civiTypeSel.appendChild(o);
    }
    const civiBaseSel = el("select", "neo-hub-input neo-hub-civi-base");
    const civiBaseAll = document.createElement("option");
    civiBaseAll.value = "";
    civiBaseAll.textContent = t("全部底模");
    civiBaseSel.appendChild(civiBaseAll);
    const civiSortSel = el("select", "neo-hub-input neo-hub-civi-sort");
    for (const [key, label] of Object.entries(CIVITAI_SORT_NAMES)) {
        const o = document.createElement("option");
        o.value = key;
        o.textContent = label;
        civiSortSel.appendChild(o);
    }
    const civiNsfw = el("label", "neo-hub-check");
    const civiNsfwInput = el("input");
    civiNsfwInput.type = "checkbox";
    civiNsfw.append(civiNsfwInput, el("span", "", "NSFW"));
    civiRow.append(el("span", "neo-hub-label", t("类型")), civiTypeSel,
        el("span", "neo-hub-label", t("底模")), civiBaseSel,
        el("span", "neo-hub-label", t("排序")), civiSortSel, civiNsfw);
    const civiPrevBtn = el("button", "neo-hub-btn neo-hub-civi-prev", t("上一页"));
    civiPrevBtn.type = "button";
    civiPrevBtn.disabled = true;
    civiPrevBtn.addEventListener("click", () => {
        if (h.civiPage > 1) { h.civiPage -= 1; loadCivitaiModels(h, true); }
    });
    const civiNextBtn = el("button", "neo-hub-btn neo-hub-civi-next", t("下一页"));
    civiNextBtn.type = "button";
    civiNextBtn.disabled = true;
    civiNextBtn.addEventListener("click", () => {
        if (h.civiCursors[h.civiPage]) { h.civiPage += 1; loadCivitaiModels(h, true); }
    });
    civiRow.append(civiPrevBtn, civiNextBtn);
    civiRow.style.display = "none";
    // 过滤条件一变，旧 cursor 作废，回到第 1 页
    for (const c of [civiTypeSel, civiBaseSel, civiSortSel, civiNsfwInput]) {
        c.addEventListener("change", () => loadRepos(h, false));
    }

    const repoRow = el("div", "neo-hub-row");
    const repoSel = el("select", "neo-hub-input neo-hub-repo");
    const repoInfo = el("span", "neo-hub-info", "");
    repoRow.append(repoSel, repoInfo);

    const fileList = el("select", "neo-hub-input neo-hub-files");
    fileList.size = 8;

    const targetRow = el("div", "neo-hub-row");
    const catSel = el("select", "neo-hub-input neo-hub-cat");
    const subSel = el("select", "neo-hub-input neo-hub-sub");
    const subNew = el("input", "neo-hub-input neo-hub-sub-new");
    subNew.type = "text";
    subNew.placeholder = t("新建子目录名（可含 / 分层）");
    subNew.style.display = "none";
    const destText = el("span", "neo-hub-info neo-hub-dest", "");
    targetRow.append(el("span", "neo-hub-label", t("落盘类别")), catSel,
        el("span", "neo-hub-label", t("子目录")), subSel, subNew, destText);

    const actRow = el("div", "neo-hub-row");
    const dlBtn = el("button", "neo-hub-btn neo-hub-dl", t("下载"));
    dlBtn.type = "button";
    const cancelBtn = el("button", "neo-hub-btn neo-hub-cancel", t("取消"));
    cancelBtn.type = "button";
    cancelBtn.disabled = true;
    const statusText = el("span", "neo-hub-status", t("空闲"));
    actRow.append(dlBtn, cancelBtn, statusText);

    const bar = el("div", "neo-hub-bar");
    const barFill = el("i");
    bar.appendChild(barFill);
    const progText = el("div", "neo-hub-prog", "");

    const panel = el("div", "neo-hub-settings");
    panel.style.display = "none";
    const inputs = {};
    const mkInput = (key, label, type) => {
        const input = el("input", "neo-hub-input");
        input.type = type || "text";
        inputs[key] = input;
        panel.appendChild(field(label, input));
    };
    const srcSel = el("select", "neo-hub-input");
    for (const key of Object.keys(SOURCE_NAMES)) {
        const o = document.createElement("option");
        o.value = key;
        o.textContent = SOURCE_NAMES[key];
        srcSel.appendChild(o);
    }
    inputs.source = srcSel;
    panel.appendChild(field(t("默认下载源"), srcSel));
    mkInput("hf_endpoint", t("HF 端点（镜像站根地址）"));
    mkInput("hf_token", t("HF Token（受限仓库需要）"), "password");
    mkInput("ms_token", t("ModelScope Token（受限仓库下载用，可留空）"), "password");
    mkInput("llm_subdir", t("LLM 子目录（models/ 下，GGUF 落此处）"));
    mkInput("timeout_total", t("下载总超时（秒）"), "number");
    mkInput("sock_read", t("读超时（秒）"), "number");
    const civiNote = el("div", "neo-hub-info neo-hub-civi-note",
        t("C 站 API KEY 与代理在画廊设置的「Civitai（C 站）」区配置，模型库共用同一份。"));
    panel.appendChild(civiNote);
    const saveBtn = el("button", "neo-hub-btn neo-hub-save", t("保存设置"));
    saveBtn.type = "button";
    panel.appendChild(saveBtn);

    box.append(head, readyWrap, searchRow, civiRow, repoRow, fileList, targetRow, actRow, bar, progText, panel);
    overlay.appendChild(box);

    h.ui = {
        srcBtns, repoSel, repoInfo, fileList, catSel, subSel, subNew, destText, dlBtn, cancelBtn,
        statusText, barFill, progText, panel, inputs, searchInput, settingsBtn, closeBtn,
        civiRow, civiTypeSel, civiBaseSel, civiSortSel, civiNsfwInput, civiNote,
        civiPrevBtn, civiNextBtn,
        readyWrap, readySummary, readyOptionalInput, readyRefresh, readyBody,
    };
    return overlay;
}

function syncSource(h) {
    for (const [key, btn] of Object.entries(h.ui.srcBtns)) {
        btn.classList.toggle("neo-hub-src-active", key === h.source);
    }
    const civi = h.source === "civitai";
    h.ui.civiRow.style.display = civi ? "" : "none";
    h.ui.searchInput.placeholder = civi
        ? t("搜索 C 站 LoRA 名称 / 触发词")
        : t("搜索仓库名（Comfy-Org 内子串匹配 + 跨组织搜索）");
}

/** 一行进度文本（模型库进度条与生图面板顶部的就地补齐共用同一口径） */
function progressLine(d) {
    const total = Number(d.total) || 0;
    const done = Number(d.done) || 0;
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    return tf("{pct}% · {done} / {total} · {speed}/s", {
        pct: pct.toFixed(1), done: fmtSize(done), total: fmtSize(total), speed: fmtSize(d.speed || 0),
    });
}

function renderProgress(h, d) {
    const total = Number(d.total) || 0;
    const pct = total ? Math.min(100, (Number(d.done) || 0) / total * 100) : 0;
    h.ui.barFill.style.width = `${pct.toFixed(1)}%`;
    h.ui.progText.textContent = progressLine(d);
    h.ui.statusText.textContent = d.state === "running" ? tf("下载中：{name}", { name: d.filename }) : (d.state || "idle");
}

// ---------------------------------------------------------------------------
// 数据流
// ---------------------------------------------------------------------------

function fillCivitaiModels(h) {
    const sel = h.ui.repoSel;
    sel.innerHTML = "";
    for (const m of h.models) {
        const o = document.createElement("option");
        o.value = String(m.id);
        o.textContent = `${m.name} · ${m.base_models.join("/") || m.type} · ${m.downloads}` +
            `${m.nsfw ? " · NSFW" : ""}${m.creator ? ` · ${m.creator}` : ""}`;
        sel.appendChild(o);
    }
    if (h.wantRepo) sel.value = String(h.wantRepo);
}

async function loadCivitaiModels(h, refresh) {
    if (!refresh) { h.civiPage = 1; h.civiCursors = [""]; }
    h.ui.repoInfo.textContent = t("C 站搜索中…");
    h.ui.fileList.innerHTML = "";
    h.ui.destText.textContent = "";
    try {
        const data = await req("/civitai/search", {
            query: h.ui.searchInput.value.trim(),
            types: [h.ui.civiTypeSel.value],
            base_models: h.ui.civiBaseSel.value ? [h.ui.civiBaseSel.value] : [],
            sort: h.ui.civiSortSel.value,
            nsfw: !!h.ui.civiNsfwInput.checked,
            page: h.civiPage,
            cursor: h.civiCursors[h.civiPage - 1] || "",
        });
        h.models = data.items || [];
        h.civiPage = data.page || 1;
        h.civiCursors[h.civiPage] = data.next_cursor || "";
        if (data.base_models && h.ui.civiBaseSel.options.length <= 1) fillCivitaiBases(h, data.base_models);
        fillCivitaiModels(h);
        h.ui.repoInfo.textContent = tf("{n} 个模型 · 第 {p} 页", { n: h.models.length, p: h.civiPage });
        h.ui.civiPrevBtn.disabled = h.civiPage <= 1;
        h.ui.civiNextBtn.disabled = !data.next_cursor;
        await loadFiles(h, false);
    } catch (e) {
        h.ui.repoInfo.textContent = t("C 站搜索失败");
        showToast(app, "error", t("C 站搜索失败"), String(e.message || e));
    }
}

function fillCivitaiBases(h, bases) {
    for (const b of bases) {
        const o = document.createElement("option");
        o.value = b;
        o.textContent = b;
        h.ui.civiBaseSel.appendChild(o);
    }
}

async function loadCivitaiFiles(h) {
    const modelId = h.ui.repoSel.value;
    h.ui.fileList.innerHTML = "";
    h.ui.destText.textContent = "";
    if (!modelId) return;
    h.ui.fileList.disabled = true;
    try {
        const data = await req("/civitai/files", { model_id: modelId });
        h.files = data.files || [];
        fillFiles(h);
        await loadSubfolders(h);
    } catch (e) {
        const opt = document.createElement("option");
        opt.textContent = tf("C 站文件清单加载失败：{e}", { e: e.message || e });
        h.ui.fileList.appendChild(opt);
        showToast(app, "error", t("C 站文件清单加载失败"), String(e.message || e));
    } finally {
        h.ui.fileList.disabled = false;
    }
}

async function loadRepos(h, refresh) {
    if (h.source === "civitai") return loadCivitaiModels(h, refresh);
    h.ui.repoInfo.textContent = t("仓库列表加载中…");
    try {
        const data = await req("/repos", {
            source: h.source, query: h.ui.searchInput.value.trim(), refresh: !!refresh,
        });
        h.repos = data.repos || [];
        fillRepos(h);
        h.ui.repoInfo.textContent = tf("{n} 个仓库", { n: h.repos.length });
        await loadFiles(h, !!refresh);
    } catch (e) {
        h.ui.repoInfo.textContent = t("仓库列表加载失败");
        h.ui.fileList.innerHTML = "";
        showToast(app, "error", t("仓库列表加载失败"), String(e.message || e));
    }
}

async function loadFiles(h, refresh) {
    if (h.source === "civitai") return loadCivitaiFiles(h);
    const repo = h.ui.repoSel.value;
    h.ui.fileList.innerHTML = "";
    h.ui.destText.textContent = "";
    if (!repo) return;
    h.ui.fileList.disabled = true;
    try {
        const data = await req("/files", { source: h.source, repo, refresh: !!refresh });
        h.files = data.files || [];
        if (data.categories && data.categories.length) { h.categories = data.categories; fillCategories(h); }
        fillFiles(h);
        await loadSubfolders(h);
    } catch (e) {
        const opt = document.createElement("option");
        opt.textContent = tf("文件清单加载失败：{e}", { e: e.message || e });
        h.ui.fileList.appendChild(opt);
        showToast(app, "error", t("文件清单加载失败"), String(e.message || e));
    } finally {
        h.ui.fileList.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// 预设就绪：族系总览 → 单预设计划 → 逐条下载（下载与进度轮询走模型库那套）
// ---------------------------------------------------------------------------

/** 计划的下载前置：HF 要 Token、C 站要 KEY；缺了就说清去哪填，不让人点了才知道。 */
function readyTokenNote(plan) {
    if (plan.needs_token && !plan.has_token) return t("该源需要先在模型库设置里填 HF Token");
    if (plan.source === "civitai" && !plan.has_token) return t("C 站源需要在画廊设置的 Civitai 区填 API KEY");
    return "";
}

function renderReadyOverview(h) {
    const body = h.ui.readyBody;
    body.innerHTML = "";
    for (const fam of h.readyFamilies) {
        const row = el("div", "neo-hub-ready-family");
        const main = el("div", "neo-hub-ready-fam-main");
        main.append(
            el("span", "neo-hub-ready-name", tf("{label}（{kind_text} · {presets} 预设 · {files} 文件 · {gb} GB）", {
                label: fam.label || fam.family, kind_text: READY_KIND_NAMES[fam.kind] || fam.kind,
                presets: fam.preset_count, files: fam.file_count, gb: fam.total_gb,
            })),
            el("span", `neo-hub-ready-badge ${fam.blocked ? "neo-hub-ready-missing" : "neo-hub-ready-ok"}`,
                fam.blocked ? tf("缺 {n} 项 · {gb} GB", { n: fam.missing_count, gb: fam.missing_gb }) : t("已就绪")));
        row.appendChild(main);
        const skills = el("div", "neo-hub-ready-skills");
        for (const sk of fam.skills || []) {
            const btn = el("button", "neo-hub-btn neo-hub-ready-skill", sk.cn_name);
            btn.type = "button";
            btn.dataset.skill = sk.skill_id;
            if (sk.skill_id === h.readySkill) btn.classList.add("neo-hub-ready-skill-active");
            btn.addEventListener("click", () => loadReadyPlan(h, sk.skill_id));
            skills.appendChild(btn);
        }
        row.appendChild(skills);
        body.appendChild(row);
    }
}

function readyTotalsText(h) {
    return tf("{p} 个预设 · {f} 个族系 · 需要补模型的族系 {b} 个", {
        p: h.readyTotals.preset_count, f: h.readyTotals.family_count, b: h.readyTotals.blocking_count,
    });
}

async function loadReadyOverview(h) {
    h.ui.readySummary.textContent = t("预设就绪总览加载中…");
    try {
        const data = await skillReq("/all");
        h.readyFamilies = data.families || [];
        h.readyTotals = {
            family_count: data.family_count || 0,
            preset_count: data.preset_count || 0,
            blocking_count: data.blocking_count || 0,
        };
        h.ui.readySummary.textContent = readyTotalsText(h);
        renderReadyOverview(h);
        if (h.readyPlan) renderReadyPlan(h);
    } catch (e) {
        h.ui.readySummary.textContent = t("预设就绪总览读取失败");
        h.ui.readyBody.innerHTML = "";
        h.ui.readyBody.appendChild(el("div", "neo-hub-ready-note", String(e.message || e)));
    }
}

function planRow(h, item) {
    const payload = item.payload || null;
    const row = el("div", "neo-hub-ready-item");
    row.append(
        el("span", "neo-hub-ready-name",
            `${item.label || item.filename} · ${item.category}/${payload && payload.subfolder ? `${payload.subfolder}/` : ""}${payload ? payload.filename : item.base_name}`),
        el("span", "neo-hub-ready-badge", `${SOURCE_NAMES[item.source] || item.reason || ""} · ${item.gb} GB`));
    const btn = el("button", "neo-hub-btn neo-hub-ready-dl", t("下载"));
    btn.type = "button";
    if (!payload) btn.disabled = true;   // 当前源没有 / 出处非法：没有可下载的东西就不出可用的按钮
    else btn.addEventListener("click", () => startPlanDownloads(h, [item]));
    row.appendChild(btn);
    const note = item.reason === "not_on_source"
        ? tf("当前源没有这条文件，{source} 有，切到该源后重新出计划", { source: SOURCE_NAMES[item.other_source] || item.other_source })
        : (item.reason === "bad_source" ? tf("该出处非法：{note}", { note: item.note || "" }) : (item.note || ""));
    if (note) row.appendChild(el("span", "neo-hub-ready-item-note", note));
    return row;
}

function renderReadyPlan(h) {
    const plan = h.readyPlan;
    if (!plan) return;
    const block = el("div", "neo-hub-ready-plan");
    const headRow = el("div", "neo-hub-row");
    headRow.append(el("span", "neo-hub-ready-name",
        tf("{name} · 出计划源 {source}", { name: plan.label || plan.skill_id, source: plan.source_label || plan.source })));
    const warn = readyTokenNote(plan);
    if (warn) headRow.appendChild(el("span", "neo-hub-ready-warn", warn));
    const items = (plan.files || []).filter((i) => i.payload);
    if (items.length) {
        const allBtn = el("button", "neo-hub-btn neo-hub-ready-all", t("全部下载"));
        allBtn.type = "button";
        allBtn.addEventListener("click", () => startPlanDownloads(h));
        headRow.appendChild(allBtn);
    }
    block.appendChild(headRow);
    block.appendChild(el("div", "neo-hub-ready-note",
        plan.has_manifest
            ? tf("待下载 {n} 项 · {gb} GB", { n: items.length, gb: plan.total_gb || 0 })
            : t("该预设不声明本地模型文件，无需从这里下载")));
    for (const line of plan.notes || []) block.appendChild(el("div", "neo-hub-ready-note", line));
    for (const item of plan.files || []) block.appendChild(planRow(h, item));
    h.ui.readyBody.appendChild(block);
}

async function loadReadyPlan(h, skillId) {
    h.readySkill = skillId;
    h.ui.readySummary.textContent = t("下载计划生成中…");
    try {
        const data = await skillReq("/plan", {
            skill_id: skillId, source: h.source, include_optional: !!h.ui.readyOptionalInput.checked,
        });
        h.readyPlan = data.plan;
        renderReadyOverview(h);
        renderReadyPlan(h);
        h.ui.readySummary.textContent = readyTotalsText(h);   // 出完计划回到计数行，不停在「生成中」
    } catch (e) {
        h.readyPlan = null;
        h.ui.readySummary.textContent = t("下载计划读取失败");
        showToast(app, "error", t("下载计划读取失败"), String(e.message || e));
    }
}

function startPlanDownloads(h, items) {
    const queue = (items || (h.readyPlan ? h.readyPlan.files.filter((i) => i.payload) : [])).slice();
    if (!queue.length) { showToast(app, "info", t("没有可下载的条目")); return; }
    h.planQueue = queue;
    h.planRunning = true;
    pumpPlanQueue(h);
}

/** 计划队列：模型库只有一个下载位，计划逐条喂进去，进度轮询的 done 分支续跑下一条、最后重读就位。 */
async function pumpPlanQueue(h) {
    const item = h.planQueue.shift();
    if (!item) { h.planRunning = false; return; }
    h.ui.dlBtn.disabled = true;
    h.ui.statusText.textContent = tf("计划下载中：{name}", { name: item.payload.filename });
    try {
        await req("/download", item.payload);
        startPoll(h);
    } catch (e) {
        h.planQueue = [];
        h.planRunning = false;
        h.ui.dlBtn.disabled = false;
        h.ui.statusText.textContent = t("下载启动失败");
        showToast(app, "error", t("下载启动失败"), String(e.message || e));
    }
}

/** 一轮计划下完就重读就位：文件落盘后缺项变少，闭环在这一步合上。 */
async function refreshReady(h) {
    await loadReadyOverview(h);
    if (h.readySkill) await loadReadyPlan(h, h.readySkill);
}

async function toggleReady(h) {
    const open = h.ui.readyWrap.style.display === "none";
    h.ui.readyWrap.style.display = open ? "" : "none";
    if (open && !h.readyFamilies.length) await loadReadyOverview(h);
}

function fillSettingsForm(h, settings) {
    for (const [key, input] of Object.entries(h.ui.inputs)) {
        const value = settings[key];
        if (value === undefined || value === null) continue;
        input.value = input.type === "number" ? Number(value) : String(value);
    }
}

async function saveSettings(h) {
    const payload = {};
    for (const [key, input] of Object.entries(h.ui.inputs)) payload[key] = input.value;
    try {
        const data = await req("/settings", payload);
        fillSettingsForm(h, data.settings || {});
        h.source = (data.settings && data.settings.source) || h.source;
        syncSource(h);
        showToast(app, "success", t("模型库设置已保存"));
        await loadRepos(h, true);
    } catch (e) {
        showToast(app, "error", t("设置保存失败"), String(e.message || e));
    }
}

function stopPoll(h) {
    if (h.timer) clearInterval(h.timer);
    h.timer = null;
}

async function pollProgress(h) {
    let data;
    try {
        data = await req("/progress");
    } catch (e) {
        return;
    }
    const d = data.download || {};
    if (d.state === "running") {
        h.ui.cancelBtn.disabled = false;
        renderProgress(h, d);
        return;
    }
    stopPoll(h);
    h.ui.cancelBtn.disabled = true;
    h.ui.dlBtn.disabled = false;
    if (d.state === "done") {
        renderProgress(h, d);
        showToast(app, "success", t("下载完成"), `${d.category} / ${d.filename}`);
        loadFiles(h, true);
        if (!h.planRunning) return;
        if (h.planQueue.length) pumpPlanQueue(h);   // 计划队列：模型库单下载位，一条下完接下一条
        else { h.planRunning = false; refreshReady(h); }   // 计划下完：重读就位，闭环在这一步合上
    } else if (d.state === "paused") {
        h.planQueue = [];   // 取消即断队列：断点留在当前文件上，不自动续下一条
        h.planRunning = false;
        h.ui.statusText.textContent = d.error || t("已取消（断点保留）");
        showToast(app, "info", t("已取消"), t("断点已保留，再次下载同一文件可续传"));
    } else if (d.state === "error") {
        h.planQueue = [];
        h.planRunning = false;
        h.ui.statusText.textContent = d.error || t("下载失败");
        showToast(app, "error", t("下载失败"), d.error || "");
    }
}

function startPoll(h) {
    stopPoll(h);
    h.timer = setInterval(() => pollProgress(h), 800);
    pollProgress(h);
}

function bindActions(h) {
    h.ui.dlBtn.addEventListener("click", async () => {
        const file = selectedFile(h);
        if (!file) { showToast(app, "info", t("未选择文件")); return; }
        h.ui.dlBtn.disabled = true;
        try {
            await req("/download", {
                source: h.source,
                repo: h.source === "civitai" ? `civitai/${h.ui.repoSel.value}` : h.ui.repoSel.value,
                path: file.path,
                category: h.ui.catSel.value,
                subfolder: currentSubfolder(h),
                filename: file.filename,
            });
            startPoll(h);
        } catch (e) {
            h.ui.dlBtn.disabled = false;
            showToast(app, "error", t("下载启动失败"), String(e.message || e));
        }
    });
    h.ui.cancelBtn.addEventListener("click", async () => {
        h.ui.cancelBtn.disabled = true;
        try {
            await req("/cancel", {});
        } catch (e) {
            showToast(app, "error", t("取消失败"), String(e.message || e));
        }
    });
    h.ui.repoSel.addEventListener("change", () => loadFiles(h, false));
    h.ui.catSel.addEventListener("change", () => loadSubfolders(h));
    h.ui.fileList.addEventListener("change", () => {
        const prevCat = h.ui.catSel.value;
        updateTarget(h);
        const prefer = selectedSub(h);
        if (h.ui.catSel.value !== prevCat) { loadSubfolders(h, prefer); return; }
        applySubfolder(h, prefer);
        updateTarget(h);
    });
    h.ui.subSel.addEventListener("change", () => { syncNewSub(h); updateTarget(h); });
    h.ui.subNew.addEventListener("input", () => updateTarget(h));
    h.ui.readyRefresh.addEventListener("click", () => loadReadyOverview(h));
    h.ui.readyOptionalInput.addEventListener("change", () => {
        if (h.readySkill) loadReadyPlan(h, h.readySkill);   // 可选文件勾选只影响出计划的口径
    });
    h.ui.settingsBtn.addEventListener("click", () => {
        h.ui.panel.style.display = h.ui.panel.style.display === "none" ? "block" : "none";
    });
    h.ui.panel.querySelector(".neo-hub-save").addEventListener("click", () => saveSettings(h));
    h.ui.closeBtn.addEventListener("click", closeModelHub);
}

async function loadSettings(h) {
    try {
        const data = await req("/settings");
        h.registry = data.registry || {};
        h.categories = data.categories || [];
        const civi = data.civitai || {};
        h.ui.civiNote.textContent = tf("C 站配置：API KEY {key} · 代理 {proxy}（在画廊设置的 Civitai 区修改）", { key: civi.api_key_set ? t("已设置") : t("未设置"), proxy: civi.proxy ? civi.proxy : t("未设置") });
        fillCategories(h);
        fillSettingsForm(h, data.settings || {});
        if (!h.wantSource) h.source = (data.settings && data.settings.source) || h.source;
        syncSource(h);
    } catch (e) {
        showToast(app, "error", t("模型库设置读取失败"), String(e.message || e));
    }
}

/**
 * 打开模型库弹窗。
 * @param {{query?: string, category?: string, source?: string, repo?: string, readySkill?: string}} opts
 *   query 预填搜索框；category 预选落盘类别；source 覆盖本次下载源；repo 预选仓库；
 *   readySkill 直接展开「预设就绪」并出该预设的下载计划（生成前预检的「去模型库」走这条）。
 */
export function openModelHub(opts = {}) {
    closeModelHub();
    const h = {
        source: opts.source || "modelscope", repos: [], files: [], registry: {}, categories: [],
        models: [], civiPage: 1, civiCursors: [""], timer: null, ui: {}, wantCategory: opts.category || "",
        wantRepo: opts.repo || "", wantSource: opts.source || "",
        readyFamilies: [], readyTotals: { family_count: 0, preset_count: 0, blocking_count: 0 },
        readySkill: "", readyPlan: null, planQueue: [], planRunning: false,
    };
    const overlay = buildUI(h);
    h.overlay = overlay;
    hub = h;
    document.body.appendChild(overlay);
    bindActions(h);
    syncSource(h);
    if (opts.query) h.ui.searchInput.value = opts.query;
    loadSettings(h).then(async () => {
        // 就绪面板默认收起：带 readySkill 进来就替用户展开，落点直接是这个预设的下载计划
        if (!opts.readySkill) return loadRepos(h, false);
        h.ui.readyWrap.style.display = "";
        await loadReadyOverview(h);
        await loadReadyPlan(h, opts.readySkill);
        return loadRepos(h, false);
    });
    return overlay;
}

export function closeModelHub() {
    if (!hub) return;
    stopPoll(hub);
    hub.overlay.remove();
    hub = null;
}

/** 预设缺模型的「就地补齐」：出该预设的下载计划后逐条喂进模型库下载接口，进度回调给调用方渲染
 *  （生图面板顶部的提示条用它 —— 缺模型就在当前界面补齐，不用先把用户赶去模型库）。
 *  模型库只有一个下载位，所以计划串行；轮询属于这一次调用，下完 / 失败 / 取消都要清掉，不留 setInterval。
 *  出不了计划时回 {reason}（源要先填 Token、该源没这文件），由调用方降级成「去模型库」。
 *  @param {{onFile?: function(string), onProgress?: function(object, string),
 *           onDone?: function(), onFail?: function(string)}} handlers
 *  @returns {Promise<{plan, cancel}|{reason}>}
 */
/** 预设缺模型的下载计划（生图面板用它决定主按钮是「下载 X GB」还是「去模型库」：
 *  本机已有同名文件时计划里没有可下载条目，主按钮就不该承诺一次必被「已存在」顶回的下载）。
 *  @returns {Promise<object>} plan */
export async function skillModelPlan(skillId) {
    return (await skillReq("/plan", { skill_id: skillId })).plan;
}

export async function downloadSkillModels(skillId, handlers = {}) {
    const plan = await skillModelPlan(skillId);
    const warn = readyTokenNote(plan);
    const queue = (plan.files || []).filter((i) => i.payload);
    if (warn) return { reason: warn, plan };
    if (!queue.length) return { reason: t("没有可下载的条目"), plan };

    const runner = { timer: null, queue, stopped: false };
    const stop = () => {
        runner.stopped = true;
        if (runner.timer) clearInterval(runner.timer);
        runner.timer = null;
    };
    /** 下一条：模型库单下载位，一条启动成功就交给轮询接力；队尾空即收尾 */
    const pump = async () => {
        const item = runner.queue.shift();
        if (!item) { stop(); handlers.onDone?.(); return false; }
        handlers.onFile?.(item.payload.filename);
        try {
            await req("/download", item.payload);
        } catch (e) {
            stop();
            handlers.onFail?.(String(e.message || e));
            return false;
        }
        return true;
    };
    const poll = async () => {
        let d;
        try {
            d = (await req("/progress")).download || {};
        } catch (e) {
            return;   // 进度接口短暂读不到就本轮不动，下一轮再看
        }
        if (runner.stopped) return;
        if (d.state === "running") { handlers.onProgress?.(d, progressLine(d)); return; }
        if (d.state === "done") {
            handlers.onProgress?.(d, progressLine(d));
            await pump();
            return;
        }
        stop();
        handlers.onFail?.(d.error || t("下载失败"));
    };

    if (await pump()) {
        runner.timer = setInterval(poll, 800);
        poll();
    }
    return { plan, cancel: () => { stop(); return req("/cancel", {}); } };
}
