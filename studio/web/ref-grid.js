/**
 * ref-grid.js — Neo Reference Grid（参考图宫格节点）前端。
 * 宫格槽位（1~12，工具条 −/+ 运行时调整，不随工作流保存）：画廊拖入 / 本地批量添加 →
 * 文件名写入隐藏 refs widget（JSON 数组，随工作流序列化）；布局按节点宽度流式排布（auto-fill），
 * 节点高度跟随内容。瓷砖支持拖放重排、✕ 移除、点击 Lightbox 查看；
 * 工具条：−/+ 槽位数、清空、保存配方；右侧组：素材面板（pi-images，同 Neo Gallery）、
 * 本地批量添加、☰ 加载配方（选择窗：普通含图配方，排除多段导演；悬停预览封面/图片条/提示词摘要，点击载入宫格）。
 * 提示词框同步隐藏 prompt_text widget。
 * 输出 autogrow image_1..image_12（默认显示前 3 槽，连线后增长），同 bundle-expand.js 模式。
 * 节点级 _neoRg = { getAssets(), setAssets(refs), getPrompt(), setPrompt(text) } 供 recipes.js
 * 收集/还原配方（鸭子类型，避免循环导入）。
 */
import { app } from "../../../../scripts/app.js";
import { $el } from "../../../../scripts/ui.js";
import { t, tf } from "./js/core/i18n.js";
import { icon } from "./js/core/icons.js";
import { Lightbox } from "./lightbox.js";
import { grabDataType, copyGalleryToInput, toggleGallerySidebar, uploadLocalFiles } from "./media-transfer.js";
import { collectWorkflowAssets, saveRecipe, listRecipes } from "./recipes.js";

if (!document.getElementById("neo-rg-css")) {
    const link = document.createElement("link");
    link.id = "neo-rg-css";
    link.rel = "stylesheet";
    link.href = "/extensions/comfyui-neo-studio/ref-grid.css";
    document.head.appendChild(link);
}

const GRID_MAX = 12;      // 宫格槽位上限（与后端 ref_grid.GRID_MAX 一致）
const DEFAULT_SLOTS = 9;  // 默认槽位数；加载/填入的图更多时自动扩到其数量

// autogrow 输出槽：槽 0 prompt、槽 1 BUNDLE，之后 image_1..image_12。默认只显示前 3 槽，
// 最后一个已连接图片槽之后保留一个空槽供继续连线，最多全部输出（与后端声明一致）。
const OUTPUT_SPECS = [
    { name: "prompt", type: "STRING" },
    { name: "BUNDLE", type: "STRING" },
    ...Array.from({ length: GRID_MAX }, (_, i) => ({ name: `image_${i + 1}`, type: "IMAGE" })),
];

// 目标可见输出数 = max(3, 最高已连接图片槽索引 + 2)。
export function computeAutogrowTarget(outputs) {
    let hi = 0;
    outputs.forEach((o, i) => {
        if (i >= 2 && o.links && o.links.length) hi = i;
    });
    return Math.min(OUTPUT_SPECS.length, Math.max(3, hi + 2));
}

// 按目标数增删尾部输出槽；只删未连接的尾部槽，保证槽位 index 与后端返回顺序对齐。
// force=true 用于 onAfterGraphConfigured：此时 configure 已完成（links 已恢复），
// 但核心的 configuringGraphLevel 尚未递减，不能走常规守卫。
function syncAutogrowOutputs(node, force = false) {
    if (!node.outputs || (app.configuringGraph && !force)) return;
    const target = computeAutogrowTarget(node.outputs);
    while (node.outputs.length < target) {
        const spec = OUTPUT_SPECS[node.outputs.length];
        node.addOutput(spec.name, spec.type);
    }
    while (node.outputs.length > target) {
        const last = node.outputs[node.outputs.length - 1];
        if (last.links && last.links.length) break;
        node.removeOutput(node.outputs.length - 1);
    }
}

function refsWidgetOf(node) { return node.widgets?.find(w => w.name === "refs") || null; }
function promptWidgetOf(node) { return node.widgets?.find(w => w.name === "prompt_text") || null; }

/** 读 refs widget 值（JSON 文件名数组）；解析失败/非列表返回空。 */
function readRefs(node) {
    const raw = refsWidgetOf(node)?.value;
    if (!raw || typeof raw !== "string") return [];
    try {
        const data = JSON.parse(raw);
        if (Array.isArray(data)) return data.map(x => String(x)).filter(Boolean).slice(0, GRID_MAX);
    } catch { /* 坏格式按空处理 */ }
    return [];
}

const toast = (severity, detail) => app.extensionManager?.toast?.add({ severity, summary: t("参考图宫格"), detail, life: 3500 });
const thumbUrl = (name) => `/view?filename=${encodeURIComponent(name)}&subfolder=&type=input`;

function openTileLightbox(list, index) {
    const items = list.map(name => ({ kind: "image", url: thumbUrl(name), title: name }));
    Lightbox.open({ items, index });
}

/** 保存配方小弹窗：名称输入 + 资产收集提示；保存走 recipes.js 的 collectWorkflowAssets + saveRecipe。 */
function openRecipeDialog(node) {
    const overlay = $el("div", { className: "neo-rg-overlay" });
    const nameInput = $el("input", { type: "text", className: "neo-rg-input", placeholder: t("配方名称") });
    const hint = $el("div", { className: "neo-rg-dialog-hint", textContent: t("正在收集工作流资源...") });
    collectWorkflowAssets(node).then(assets => {
        const p = (node._neoRg?.getPrompt() || "").trim();
        hint.textContent = tf("配方将包含 {n} 个资源（宫格图 + 当前子图中已连线的 LoadImage）{p}。", { n: assets.length, p: p ? t(" + 当前提示词") : "" });
    }).catch(e => {
        console.error("[Neo RefGrid] collect assets failed:", e);
        hint.textContent = t("工作流资源收集失败");
    });

    const saveBtn = $el("button", { className: "neo-rg-btn neo-rg-dialog-save", textContent: t("保存") });
    const cancelBtn = $el("button", { className: "neo-rg-btn", textContent: t("取消") });
    const close = () => overlay.remove();
    cancelBtn.onclick = close;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

    saveBtn.onclick = async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        saveBtn.disabled = true;
        try {
            const assets = await collectWorkflowAssets(node);
            const result = await saveRecipe(name, node._neoRg?.getPrompt() || "", assets);
            close();
            if (result.success) {
                app.extensionManager.toast.add({ severity: "success", summary: t("配方已保存"), detail: tf("{name}（{n} 资源）", { name, n: result.asset_count }), life: 4000 });
            } else {
                app.extensionManager.toast.add({ severity: "error", summary: t("保存失败"), detail: result.error || "Unknown error", life: 5000 });
                saveBtn.disabled = false;
            }
        } catch (e) {
            console.error("[Neo RefGrid] save recipe failed:", e);
            app.extensionManager.toast.add({ severity: "error", summary: t("保存失败"), detail: e.message, life: 5000 });
            saveBtn.disabled = false;
        }
    };

    const box = $el("div", { className: "neo-rg-dialog" }, [
        $el("div", { className: "neo-rg-dialog-title", textContent: t("保存配方（提示词 + 宫格图）") }),
        nameInput,
        hint,
        $el("div", { className: "neo-rg-dialog-btns" }, [cancelBtn, saveBtn]),
    ]);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    nameInput.focus();
}

// 配方资产预览 URL（与侧边栏配方卡片封面同源：资产存于配方目录，经后端端点读取）
const recipeAssetUrl = (recipe, file) =>
    `/rs_recipes/asset?recipe=${encodeURIComponent(recipe)}&file=${encodeURIComponent(file)}`;

/** 加载配方选择窗：只列普通含图配方（排除多段导演与无图配方），左侧列表带缩略图、
 *  右侧预览封面 + 图片条 + 提示词摘要（悬停切换），点击把图片与提示词载入宫格。 */
function openRecipePicker(node) {
    const overlay = $el("div", { className: "neo-rg-overlay" });
    const close = () => overlay.remove();

    const search = $el("input", { type: "text", className: "neo-rg-input neo-rg-picker-search", placeholder: t("搜索配方名称...") });
    const listBox = $el("div", { className: "neo-rg-picker-list" });
    const preview = $el("div", { className: "neo-rg-picker-preview" });
    let items = [];
    let focused = null;

    const imageFilesOf = (r) =>
        (Array.isArray(r.assets) ? r.assets : []).filter(a => a && a.kind === "image").map(a => a.file);

    const renderPreview = () => {
        preview.innerHTML = "";
        if (!focused) {
            preview.appendChild($el("div", { className: "neo-rg-picker-empty", textContent: t("悬停左侧配方查看预览") }));
            return;
        }
        const files = imageFilesOf(focused);
        const cover = focused.cover || files[0];
        if (cover) preview.appendChild($el("img", { className: "neo-rg-picker-cover", src: recipeAssetUrl(focused.name, cover), alt: focused.name }));
        const strip = $el("div", { className: "neo-rg-picker-strip" });
        for (const f of files.slice(0, GRID_MAX)) strip.appendChild($el("img", { src: recipeAssetUrl(focused.name, f), alt: f, title: f, loading: "lazy" }));
        preview.appendChild(strip);
        preview.appendChild($el("div", { className: "neo-rg-picker-meta", textContent: focused.name, title: focused.name }));
        if (focused.prompt) preview.appendChild($el("div", { className: "neo-rg-picker-prompt", textContent: focused.prompt }));
    };

    const setActive = (r) => {
        if (focused === r) return;
        focused = r;
        for (const el of listBox.children) el.classList.toggle("neo-rg-picker-active", el._recipe === r);
        renderPreview();
    };

    const loadRecipe = (r) => {
        const files = imageFilesOf(r).slice(0, GRID_MAX);
        node._neoRg?.setAssets(files);
        node._neoRg?.setPrompt(r.prompt || "");
        close();
        const extra = [];
        if (imageFilesOf(r).length > GRID_MAX) extra.push(tf("仅载入前 {n} 张", { n: GRID_MAX }));
        const other = (r.asset_count || 0) - imageFilesOf(r).length;
        if (other > 0) extra.push(tf("{n} 个非图片资产未载入", { n: other }));
        toast("success", tf("已载入配方「{name}」（{n} 张图片{prompt}）{extra}", { name: r.name, n: files.length, prompt: r.prompt ? t(" + 提示词") : "", extra: extra.length ? t("；") + extra.join(t("，")) : "" }));
    };

    const renderList = () => {
        listBox.innerHTML = "";
        const q = search.value.trim().toLowerCase();
        const shown = items.filter(r => !q || r.name.toLowerCase().includes(q));
        if (!shown.length) {
            listBox.appendChild($el("div", { className: "neo-rg-picker-empty", textContent: items.length ? t("无匹配配方") : t("暂无含图片的配方（可先用 保存）") }));
            focused = null;
            renderPreview();
            return;
        }
        for (const r of shown) {
            const files = imageFilesOf(r);
            const other = (r.asset_count || 0) - files.length;
            const row = $el("div", { className: "neo-rg-picker-row" }, [
                $el("img", { className: "neo-rg-picker-thumb", src: recipeAssetUrl(r.name, r.cover || files[0]), alt: "", loading: "lazy" }),
                $el("div", { className: "neo-rg-picker-rowtext" }, [
                    $el("div", { className: "neo-rg-picker-name", textContent: r.name, title: r.name }),
                    $el("div", { className: "neo-rg-picker-sub", textContent: tf("图片×{n}{other} · {src}", { n: files.length, other: other > 0 ? tf(" · 其他资产×{n}", { n: other }) : "", src: r.source === "preset" ? t("内置") : t("自定义") }) }),
                ]),
            ]);
            row._recipe = r;
            row.addEventListener("mouseenter", () => setActive(r));
            row.onclick = () => loadRecipe(r);
            listBox.appendChild(row);
        }
        setActive(shown[0]);
    };

    search.addEventListener("input", renderList);

    listRecipes().then(recipes => {
        // 只留普通含图配方：排除多段导演（video_director）与无图片资产的配方
        items = (Array.isArray(recipes) ? recipes : [])
            .filter(r => r && r.type !== "video_director" && imageFilesOf(r).length > 0);
        renderList();
    }).catch(e => {
        console.error("[Neo RefGrid] list recipes failed:", e);
        listBox.appendChild($el("div", { className: "neo-rg-picker-empty", textContent: t("配方列表加载失败") }));
    });

    const dialog = $el("div", { className: "neo-rg-dialog neo-rg-picker" }, [
        $el("div", { className: "neo-rg-dialog-title", textContent: t("加载配方（提示词 + 图片入宫格）") }),
        search,
        $el("div", { className: "neo-rg-picker-main" }, [listBox, preview]),
        $el("div", { className: "neo-rg-dialog-btns" }, [$el("button", { className: "neo-rg-btn", textContent: t("取消"), onclick: close })]),
    ]);
    overlay.appendChild(dialog);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    search.focus();
}

// ===== 节点内宫格 UI =====

/** 构建节点内宫格 UI（工具条含 −/+ 槽位数 + 流式网格 + 提示词框 + 状态行），并挂 _neoRg API。
 *  onNodeCreated 先于 configure 运行：新建节点直接渲染空宫格；旧工作流由实例 onConfigure 钩子回填。 */
function buildGridUI(node) {
    if (node._neoRgUI) return node._neoRgUI;
    const list = [];   // 已用素材文件名（有序）：槽位号 = 数组下标 + 1
    let slotCount = DEFAULT_SLOTS;   // 可见槽位数（仅运行时，不持久化）；图更多时自动扩
    let dragIdx = null;   // 正在拖放的瓷砖序号（内部重排用，区别于外部素材拖入）

    const root = $el("div", { className: "neo-rg-root" });
    const body = $el("div", { className: "neo-rg-body" });   // 宽度 100%，列数由 CSS auto-fill 按宽度决定
    const count = $el("span", { className: "neo-rg-count" });

    // 本地批量上传：隐藏多选 file input（挂在 body 上，避免被 render() 清空）
    const localInput = document.createElement("input");
    localInput.type = "file";
    localInput.accept = "image/*";
    localInput.multiple = true;
    localInput.style.display = "none";
    localInput.onchange = async () => {
        for (const name of await uploadLocalFiles(Array.from(localInput.files || []))) insert(name);
        localInput.value = "";   // 允许重复选择同名文件
    };

    const setSlots = (n) => {
        slotCount = Math.max(1, Math.min(GRID_MAX, n));
        render();
        fitToNode();
    };

    const minusBtn = $el("button", { className: "neo-rg-btn", title: t("减少宫格数（最少 1）"), textContent: "−" });
    const plusBtn = $el("button", { className: "neo-rg-btn", title: tf("增加宫格数（最多 {n}）", { n: GRID_MAX }), textContent: "+" });
    minusBtn.onclick = () => setSlots(slotCount - 1);
    plusBtn.onclick = () => setSlots(slotCount + 1);

    const toolbar = $el("div", { className: "neo-rg-toolbar" }, [
        minusBtn, count, plusBtn,
        $el("button", { className: "neo-rg-btn", title: t("清空宫格"), onclick: () => { if (!list.length) return; list.length = 0; render(); markDirty(node); } }, [icon("trash")]),
        $el("button", { className: "neo-rg-btn", title: t("保存配方（提示词 + 宫格图）"), onclick: () => openRecipeDialog(node) }, [$el("i", { className: "pi pi-save" })]),
        $el("button", { className: "neo-rg-btn neo-rg-right", title: t("打开素材面板（从画廊拖图到宫格）"), onclick: () => toggleGallerySidebar() }, [$el("i", { className: "pi pi-images" })]),
        $el("button", { className: "neo-rg-btn", title: t("本地批量添加图片（可多选）"), textContent: "", onclick: () => localInput.click() }),
        $el("button", { className: "neo-rg-btn", title: t("加载配方（提示词 + 图片入宫格）"), onclick: () => openRecipePicker(node) }, [$el("i", { className: "pi pi-list" })]),
    ]);

    const grid = $el("div", { className: "neo-rg-grid" });

    // 每次改动整体重建瓷砖（≤12，开销可忽略），保证顺序始终对应当前排列
    const render = () => {
        if (list.length > slotCount) slotCount = list.length;   // 槽位自动扩到装下全部图（加载/回填/拖入）
        grid.innerHTML = "";
        for (let i = 0; i < slotCount; i++) {
            const name = list[i];
            const cell = $el("div", { className: "neo-rg-cell" + (name ? "" : " neo-rg-cell-empty") });
            if (name) {
                const img = $el("img", { className: "neo-rg-thumb", src: thumbUrl(name), alt: name, title: `${i + 1}. ${name}`, loading: "lazy" });
                // 卡片宽高跟随图片真实比例（加载前保持默认正方形），配合 contain 保证整图可见不裁剪
                img.onload = () => {
                    if (img.naturalWidth && img.naturalHeight) {
                        cell.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
                        fitToNode();   // 内容高度变化，重算节点高度
                    }
                };
                img.addEventListener("click", () => openTileLightbox(list, i));
                const badge = $el("span", { className: "neo-rg-badge", textContent: String(i + 1) });
                const del = $el("button", { className: "neo-rg-del", title: t("移除该图"), textContent: "✕" });
                del.onclick = (e) => { e.stopPropagation(); list.splice(i, 1); render(); markDirty(node); };
                cell.appendChild(img);
                cell.appendChild(badge);
                cell.appendChild(del);
                // 瓷砖拖放重排（内部拖动，区别于外部素材拖入）
                cell.draggable = true;
                cell.addEventListener("dragstart", (e) => {
                    dragIdx = i;
                    e.dataTransfer.effectAllowed = "move";
                    try { e.dataTransfer.setData("text/plain", name); } catch (_) {}
                    cell.classList.add("neo-rg-dragging");
                });
                cell.addEventListener("dragend", () => { dragIdx = null; cell.classList.remove("neo-rg-dragging"); });
            } else {
                cell.appendChild($el("span", { className: "neo-rg-plus", textContent: "+" }));
            }
            grid.appendChild(cell);
        }
        count.textContent = `${list.length}/${slotCount}`;
        minusBtn.disabled = slotCount <= 1;
        plusBtn.disabled = slotCount >= GRID_MAX;
        // refs 隐藏 widget 是工作流序列化的唯一事实源：每次渲染（含增/删/重排/程序回填）都回写
        const w = refsWidgetOf(node);
        if (w) w.value = JSON.stringify(list);
    };

    // 插入新素材（拖入/本地上传/程序回填）：去重 + 上限校验，达上限提示并拒绝
    const insert = (name) => {
        if (!name || list.includes(name)) return;
        if (list.length >= GRID_MAX) { toast("warning", tf("宫格最多 {n} 张图", { n: GRID_MAX })); return; }
        list.push(name);
        render();
        markDirty(node);
    };

    // 拖放重排：把被拖瓷砖移到指针所在瓷砖的前/后（按水平中线判断插入位）
    const reorderFromDrop = (e) => {
        const from = dragIdx;
        dragIdx = null;
        if (from == null || from >= list.length) return;
        const cells = Array.from(grid.querySelectorAll(".neo-rg-cell"));
        let insertAt = cells.length;
        for (let k = 0; k < cells.length; k++) {
            const r = cells[k].getBoundingClientRect();
            if (e.clientX < r.left + r.width / 2) { insertAt = k; break; }
        }
        let at = from < insertAt ? insertAt - 1 : insertAt;
        const item = list.splice(from, 1)[0];
        at = Math.max(0, Math.min(list.length, at));
        list.splice(at, 0, item);
        render();
        markDirty(node);
    };

    grid.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (dragIdx != null) { e.dataTransfer.dropEffect = "move"; return; }   // 内部重排：不亮「新素材」高亮
        e.dataTransfer.dropEffect = "copy";
        grid.classList.add("neo-rg-drop");
    });
    grid.addEventListener("dragleave", (e) => { if (!grid.contains(e.relatedTarget)) grid.classList.remove("neo-rg-drop"); });
    grid.addEventListener("drop", async (e) => {
        e.preventDefault();
        grid.classList.remove("neo-rg-drop");
        if (dragIdx != null) { reorderFromDrop(e); return; }   // 内部瓷砖拖放 = 重排
        // OS 本地文件拖入：只收图片，批量上传后逐张入格
        const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
        if (files.length) {
            for (const name of await uploadLocalFiles(files)) insert(name);
            return;
        }
        // 画廊素材拖入：落盘 input/ 后入格
        const fname = await copyGalleryToInput(grabDataType(e));
        if (fname) insert(fname);
    });
    // 点击宫格黑色空区弹出本地文件选择器（点瓷砖不触发）
    grid.addEventListener("click", (e) => {
        if (e.target.closest(".neo-rg-cell:not(.neo-rg-cell-empty)")) return;
        localInput.click();
    });

    // 提示词框：同步隐藏 prompt_text widget（执行时后端按优先级取用）
    const ta = document.createElement("textarea");
    ta.className = "neo-rg-prompt";
    ta.placeholder = t("提示词（节点内）");
    ta.spellcheck = false;
    ta.addEventListener("input", () => {
        const w = promptWidgetOf(node);
        if (w) w.value = ta.value;
        markDirty(node);
    });

    const status = $el("div", { className: "neo-rg-status" });

    body.appendChild(toolbar);
    body.appendChild(grid);
    body.appendChild(ta);
    body.appendChild(status);
    body.appendChild(localInput);
    root.appendChild(body);

    // 节点高度跟随内容：宫格列数随节点宽度流式排布（CSS auto-fill），行数/高度随卡片比例变化，
    // 故每次现测 body.scrollHeight 并 setSize 恰好装下；getMinHeight 阻止手动缩到裁切内容（同 bundle-expand 模式）。
    const widget = node.addDOMWidget("ref_grid_view", "custom", root, { margin: 4, getMinHeight: () => node._neoRgContentH || 80 });
    node._neoRgWidget = widget;

    const fitToNode = () => {
        if (!grid.children.length) return;   // 首次渲染前不测
        node._neoRgContentH = body.scrollHeight;
        const box = root.parentElement;      // 核心管理的 .dom-widget 容器；未挂载（测试环境）时跳过
        if (!box || !box.clientWidth) return;
        const widgetY = node._neoRgWidget?.y ?? 40;
        const h = Math.round(widgetY + body.scrollHeight + 8);   // +8 底部内边距
        if (Math.abs(node.size[1] - h) > 1) node.setSize([node.size[0], h]);
    };
    new ResizeObserver(fitToNode).observe(root.parentElement || root);
    fitToNode();

    const setAssets = (names) => {
        list.length = 0;
        for (const n of (Array.isArray(names) ? names : [])) {
            if (n && !list.includes(n) && list.length < GRID_MAX) list.push(String(n));
        }
        render();
        markDirty(node);
    };

    node._neoRgUI = { list, render, insert, ta, status };
    // 供 recipes.js 鸭子类型调用（避免循环导入）：收集/还原配方时读写宫格与提示词
    node._neoRg = {
        getAssets: () => list.slice(),
        setAssets,
        getPrompt: () => ta.value,
        setPrompt: (text) => {
            ta.value = text || "";
            const w = promptWidgetOf(node);
            if (w) w.value = ta.value;
            markDirty(node);
        },
    };
    return node._neoRgUI;
}

function markDirty(node) { node.graph?.setDirtyCanvas(true, true); }

// 从 refs / prompt_text widget 回填宫格与提示词框（configure 还原 widgets_values 之后调用）
function refreshFromWidgets(node) {
    const ui = node._neoRgUI;
    if (!ui) return;
    ui.list.length = 0;
    for (const n of readRefs(node)) if (!ui.list.includes(n)) ui.list.push(n);
    ui.ta.value = promptWidgetOf(node)?.value || "";
    ui.render();
}

app.registerExtension({
    name: "NeoRefGrid.Grid",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NeoRefGrid") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        const origOnRemoved = nodeType.prototype.onRemoved;
        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        const origOnAfterGraphConfigured = nodeType.prototype.onAfterGraphConfigured;

        nodeType.prototype.onNodeCreated = function() {
            const result = origOnNodeCreated?.apply(this, arguments);
            // 新建节点只保留 prompt/BUNDLE/image_1 三个输出槽，其余按连线增长（旧工作流由 onAfterGraphConfigured 归一）。
            while (this.outputs.length > 3) this.removeOutput(this.outputs.length - 1);
            buildGridUI(this);
            // onNodeCreated 先于 configure 运行：此时 widgets 为默认值（空 refs），先渲染空宫格；
            // 旧工作流还原后由下方实例 onConfigure 钩子回填。
            refreshFromWidgets(this);
            // 默认尺寸按 9 槽排版估算；挂载后 fitToNode 会按内容实际高度校正（宽度流式，列数随节点宽变化）
            this.setSize([340, 510]);

            const origOnConfigure = this.onConfigure;
            this.onConfigure = function(data) {
                const r = origOnConfigure?.apply(this, arguments);
                refreshFromWidgets(this);   // widgets_values 还原完成后回填宫格与提示词框
                return r;
            };
            return result;
        };

        nodeType.prototype.onExecuted = function(output) {
            const ui = this._neoRgUI;
            if (!ui || !output) return;
            // ui payload 经核心展平：count 为 [n]，order 为字符串列表
            const count = Array.isArray(output.count) ? output.count[0] : (output.count ?? 0);
            const order = Array.isArray(output.order) ? output.order.filter(x => typeof x === "string") : [];
            ui.status.textContent = count
                ? tf("本次执行：{n} 张参考图{order}", { n: count, order: order.length ? " · " + order.join("、") : "" })
                : t("本次执行：无参考图（宫格为空）");
        };

        nodeType.prototype.onConnectionsChange = function() {
            const result = origOnConnectionsChange?.apply(this, arguments);
            syncAutogrowOutputs(this);
            return result;
        };

        nodeType.prototype.onAfterGraphConfigured = function() {
            const result = origOnAfterGraphConfigured?.apply(this, arguments);
            // 加载旧工作流（保存了全部 14 个输出）时，收敛到「已连最高槽 + 1 个空槽」。
            syncAutogrowOutputs(this, true);
            return result;
        };

        nodeType.prototype.onRemoved = function() {
            this._neoRgUI = null;
            this._neoRg = null;
            return origOnRemoved?.apply(this, arguments);
        };
    },
});
