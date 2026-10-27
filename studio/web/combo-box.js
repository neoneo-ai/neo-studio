/**
 * combo-box.js
 * 可搜索下拉组件（combobox）：点击框体展开全量列表、键入实时过滤并覆盖当前值、
 * ↑↓+Enter 键盘选择；右缘常显下拉箭头作视觉指示。
 *
 * 用法：const { box, destroy } = attachComboBox(selectEl, { placeholder, emptyText });
 * opts.onItemFocus?.(itemEl | null)：焦点行变化回调（打开列表 / hover / 键盘高亮），
 * 过滤重置与关闭列表时以 null 调用；供技能下拉挂浮动预览卡等场景使用。
 * 原生 <select> 被移到屏幕外保留为数据源与取值真相——外部代码对 select 的选项填充、
 * style 显隐切换、.value 读写、disabled 切换全部照旧生效，组件自动跟随同步。
 */

import { t } from "./js/core/i18n.js";

// 组件实例注册表：共享「点外关闭」「滚动/缩放重定位」监听，避免随实例数线性增长
const instances = new Set();
let sharedBound = false;
const onDocMouseDown = (e) => {
    instances.forEach((inst) => {
        if (!inst.wrap.contains(e.target) && !inst.listEl.contains(e.target)) inst.closeList();
    });
};
const onReposition = () => {
    instances.forEach((inst) => {
        if (inst.listEl.style.display !== "none") inst.placeList();
    });
};
function bindShared() {
    if (sharedBound) return;
    sharedBound = true;
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
}
function unbindSharedIfIdle() {
    if (instances.size || !sharedBound) return;
    sharedBound = false;
    document.removeEventListener("mousedown", onDocMouseDown);
    window.removeEventListener("resize", onReposition);
    window.removeEventListener("scroll", onReposition, true);
}

/** 列表弹层挂在 document.body 上，宿主浮层（技能 + 自定参数面板）据此判定「点在弹层里」不收自己 */
export function inOpenComboList(el) {
    for (const inst of instances) if (inst.listEl.contains(el)) return true;
    return false;
}

function el(tag, className, cssText = "") {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (cssText) n.style.cssText = cssText;
    return n;
}

export function attachComboBox(selectEl, opts = {}) {
    const placeholder = opts.placeholder || t("输入过滤或点击选择...");
    const emptyText = opts.emptyText || t("无匹配模型");

    const box = el("div", "rs-model-select-box", "display:none;");

    // 原生 select 移出可视区（外部代码仍会切换它的 display，组件只读不写，避免循环）
    selectEl.style.setProperty("position", "absolute", "");
    selectEl.style.setProperty("left", "-9999px", "");
    selectEl.style.setProperty("top", "0", "");
    selectEl.style.setProperty("width", "10px", "");
    selectEl.style.setProperty("opacity", "0", "");

    const wrap = el("div", "", "position:relative;");
    const inputEl = el("input", "rs-form-input rs-combo-input");
    inputEl.type = "text";
    inputEl.autocomplete = "off";
    inputEl.placeholder = placeholder;
    inputEl.style.paddingRight = "24px"; // 右缘常显 caret 预留位

    // 列表挂在 body 上用 fixed 定位：不被弹窗 overflow 裁剪，下方空间不足时自动向上翻。
    // z-index 高于 .rs-skill-modal-overlay（9846），技能详情等弹窗内打开的列表不被盖住；
    // 整条 Neo 阶梯都压在 LiteGraph 弹层（9999）之下，内嵌画布的 combo 弹窗才浮得住。
    // opts.footerEl 存在时改为 flex 列布局（滚动区 itemsHost + 固定底部工具栏），否则保持原样
    // （整个 listEl 自身滚动）——模型下拉等未传 footer 的既有行为完全不变。
    const hasFooter = !!opts.footerEl;
    const listOpenDisplay = hasFooter ? "flex" : "block";
    const listEl = el("div", "rs-combo-list", hasFooter
        ? "position:fixed;display:none;max-height:400px;overflow:hidden;background:#222;border:1px solid #555;border-radius:4px;z-index:9847;box-shadow:0 4px 12px rgba(0,0,0,.5);flex-direction:column;"
        : "position:fixed;display:none;max-height:220px;overflow-y:auto;background:#222;border:1px solid #555;border-radius:4px;z-index:9847;box-shadow:0 4px 12px rgba(0,0,0,.5);");
    document.body.appendChild(listEl);

    // 行容器：有 footer 时为内部滚动区，无 footer 时即 listEl 自身（保持既有行为）
    let itemsHost = listEl;
    if (hasFooter) {
        const itemsWrap = el("div", "rs-combo-items", "flex:1 1 auto;overflow-y:auto;min-height:0;padding:2px;");
        listEl.appendChild(itemsWrap);
        listEl.appendChild(opts.footerEl);
        itemsHost = itemsWrap;
    }

    // 右缘 caret 常显，指示「点击展开列表」；pointer-events:none 让点击落到输入框统一处理
    const caret = el("span", "rs-combo-caret", "position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:14px;line-height:1;color:#888;pointer-events:none;z-index:1;");
    caret.textContent = "▾";

    const items = () => Array.from(listEl.querySelectorAll("[data-value]"));
    let highlight = -1;
    const closeList = () => { listEl.style.display = "none"; highlight = -1; opts.onItemFocus?.(null); };

    const syncInputFromSelect = () => {
        const sel = selectEl.selectedOptions && selectEl.selectedOptions[0];
        inputEl.value = sel ? sel.textContent : "";
        // 输入框较窄时长名会被截断，悬停用 title 显示完整选中名
        inputEl.title = sel ? sel.textContent : "";
    };

    // 原生 select 的 .value 是取值真相，但程序化赋值（如回填已保存模型）不会触发
    // MutationObserver，输入框文本会停在自动选中的首项。包一层 setter：任何 .value
    // 写入都同步输入框，兑现「外部对 select 的 .value 读写组件自动跟随」的约定。
    const nativeValueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    Object.defineProperty(selectEl, "value", {
        get: () => nativeValueDesc.get.call(selectEl),
        set: (v) => {
            nativeValueDesc.set.call(selectEl, v);
            syncInputFromSelect();
        },
        configurable: true,
    });

    const placeList = () => {
        const r = inputEl.getBoundingClientRect();
        const vh = window.innerHeight;
        listEl.style.left = r.left + "px";
        // opts.listMinWidth：管理型下拉可大幅宽于输入框（右向钳制在视口内）；不传则维持与输入框同宽
        listEl.style.width = Math.max(r.width, Math.min(opts.listMinWidth || 0, window.innerWidth - r.left - 6)) + "px";
        const need = Math.min(220, listEl.scrollHeight || 220);
        if (vh - r.bottom < Math.max(need, 80) && r.top > vh - r.bottom) {
            listEl.style.top = "";
            listEl.style.bottom = (vh - r.top + 2) + "px";
        } else {
            listEl.style.bottom = "";
            listEl.style.top = (r.bottom + 2) + "px";
        }
    };

    const setHighlight = (idx) => {
        const els = items();
        if (!els.length) return;
        highlight = ((idx % els.length) + els.length) % els.length;
        els.forEach((n, i) => { n.style.background = i === highlight ? "#3a5a8c" : ""; });
        els[highlight].scrollIntoView({ block: "nearest" });
        opts.onItemFocus?.(els[highlight]);
    };

    const renderList = (query) => {
        const q = (query || "").trim().toLowerCase();
        // option 可带 data-tags（空格分隔，如中文拼音/首字母缩写）作为附加搜索文本；无该属性的下拉不受影响
        const matches = (o) => {
            if (!q) return true;
            if (o.textContent.toLowerCase().includes(q)) return true;
            const tags = o.dataset.tags ? o.dataset.tags.split(/\s+/) : [];
            return tags.some((t) => t && t.toLowerCase().includes(q));
        };
        itemsHost.innerHTML = "";
        highlight = -1;
        // 遍历 select 的直接子节点，以支持 <optgroup> 分组渲染分类标题。
        // selectEl.options 会展平整个 optgroup，丢失分组信息；改用 children 保留结构。
        // items() 用 [data-value] 过滤，分类标题（无 data-value）自然被键盘导航跳过。
        // indented=true 表示该 option 位于某个 optgroup 下：比分类标题多缩进，体现层级
        const renderItem = (o, indented = false) => {
            const item = document.createElement("div");
            item.dataset.value = o.value;
            item.textContent = o.textContent;
            item.style.cssText = "padding:6px 8px;font-size:12px;color:#ccc;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
                (o.value === selectEl.value ? "background:#3a5a8c;" : "");
            if (indented) item.style.paddingLeft = "22px";
            if (o.value === selectEl.value) highlight = items().length;
            item.addEventListener("mousedown", (e) => {
                e.preventDefault(); // 避免 input 先失焦把列表关掉
                pickValue(o.value);
            });
            item.addEventListener("mouseenter", () => setHighlight(items().indexOf(item)));
            itemsHost.appendChild(item);
        };
        Array.from(selectEl.children).forEach((child) => {
            if (child.tagName === "OPTGROUP") {
                // 仅当该组有命中项时才渲染分类标题 + 选项
                const opts2 = Array.from(child.children).filter(
                    (o) => o.tagName === "OPTION" && matches(o)
                );
                if (!opts2.length) return;
                const header = el("div", "rs-combo-category",
                    "padding:4px 8px;font-size:11px;color:#7aa8c1;cursor:default;text-transform:uppercase;letter-spacing:0.5px;");
                header.textContent = child.getAttribute("label") || "";
                itemsHost.appendChild(header);
                opts2.forEach((o) => renderItem(o, true));
            } else if (child.tagName === "OPTION") {
                if (matches(child)) renderItem(child);
            }
        });
        if (!items().length) {
            const empty = el("div", "", "padding:6px 8px;font-size:12px;color:#777;cursor:default;");
            empty.textContent = emptyText;
            itemsHost.appendChild(empty);
        }
    };

    const openList = () => {
        if (selectEl.disabled) return;
        renderList(""); // 打开即全量，过滤只发生在键入时
        listEl.style.display = listOpenDisplay;
        placeList();
        opts.onItemFocus?.(items()[highlight] || null); // 打开时焦点在已选项（无则 null）
    };

    const pickValue = (value) => {
        if (selectEl.value !== value) {
            selectEl.value = value;
            selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
        syncInputFromSelect();
        closeList();
        inputEl.blur();
    };


    inputEl.addEventListener("focus", () => {
        // 聚焦（键盘 Tab 或点击）→ 展开全量未过滤列表；键入即过滤覆盖
        openList();
    });
    // 点击框体/caret → 展开全量列表并全选当前文字，键入即覆盖
    inputEl.addEventListener("click", () => {
        if (selectEl.disabled) return;
        openList();
        inputEl.select();
    });
    inputEl.addEventListener("input", () => {
        renderList(inputEl.value);
        if (!selectEl.disabled) { listEl.style.display = listOpenDisplay; placeList(); }
        highlight = -1;
        opts.onItemFocus?.(null); // 过滤后焦点重置
    });
    inputEl.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            if (listEl.style.display === "none") openList();
            setHighlight(highlight + 1);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight(highlight - 1);
        } else if (e.key === "Enter") {
            e.preventDefault();
            const els = items();
            const target = els[highlight >= 0 ? highlight : 0];
            if (target) pickValue(target.dataset.value);
        } else if (e.key === "Escape") {
            const wasOpen = listEl.style.display !== "none";
            closeList();
            syncInputFromSelect();
            // 列表开着时 Esc 只消费在「关列表」，不冒泡到外层设置菜单/浮层处理器；
            // 列表已关则照常冒泡（第二次 Esc 交给外层）
            if (wasOpen) e.stopPropagation();
        }
    });
    // 失焦未选中选项时把过滤文字还原为当前选中值（取值真相始终是 select）
    inputEl.addEventListener("blur", () => setTimeout(() => { closeList(); syncInputFromSelect(); }, 120));

    // select 的显隐/disabled/选项变化 → 同步盒子可见性、输入框文本和列表内容
    const syncFromSelect = () => {
        box.style.display = selectEl.style.display === "none" ? "none" : "";
        inputEl.disabled = !!selectEl.disabled;
        syncInputFromSelect();
        renderList(inputEl.value);
        if (selectEl.disabled || box.style.display === "none") closeList();
    };
    const observer = new MutationObserver(syncFromSelect);
    observer.observe(selectEl, {
        attributes: true, attributeFilter: ["style", "disabled"], childList: true,
    });

    wrap.appendChild(inputEl);
    wrap.appendChild(caret);
    box.appendChild(wrap);
    box.appendChild(selectEl);

    const inst = { wrap, listEl, closeList, placeList };
    instances.add(inst);
    bindShared();

    return {
        box,
        // 供行内操作按钮在打开详情弹窗前关闭下拉（避免与弹窗叠加）
        close: () => closeList(),
        destroy() {
            observer.disconnect();
            listEl.remove();
            instances.delete(inst);
            unbindSharedIfIdle();
        },
    };
}