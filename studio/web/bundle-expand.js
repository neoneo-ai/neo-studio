// NeoBundleExpand 节点：在节点内只读展示 BUNDLE 展开结果（提示词 + 参考图缩略图网格，编号对应输出 image_1..image_N）。
// 数据来自后端 expand() 返回的 ui payload（{"prompt":[...], "images":[dataURI|null,...]}），经 node.onExecuted 送达。
import { app } from "../../../../scripts/app.js";
import { Lightbox } from "./lightbox.js";
import { t } from "./js/core/i18n.js";

if (!document.getElementById("neo-be-css")) {
    const link = document.createElement("link");
    link.id = "neo-be-css";
    link.rel = "stylesheet";
    link.href = "/extensions/comfyui-neo-studio/bundle-expand.css";
    document.head.appendChild(link);
}

// ui 值经核心 get_output_from_returns 展平为列表（字符串会被逐字符拆开），这里把 prompt 还原成显示文本。
function asText(v) {
    if (v == null) return "";
    if (Array.isArray(v)) return v.join("");
    return String(v);
}

const MIN_HEIGHT = 70;

// autogrow 输出槽：槽 0 固定 prompt，之后 image_1..image_9。默认只显示到 image_1，
// 最后一个已连接的图片槽之后保留一个空槽供继续连线，最多到 image_9（与后端声明一致）。
const OUTPUT_SPECS = [
    { name: "prompt", type: "STRING" },
    ...Array.from({ length: 9 }, (_, i) => ({ name: `image_${i + 1}`, type: "IMAGE" })),
];

// 目标可见输出数 = max(2, 最高已连接图片槽索引 + 2)，上限 10（prompt + 9 图）。
export function computeAutogrowTarget(outputs) {
    let hi = 0; // prompt 槽恒在
    outputs.forEach((o, i) => {
        if (i > 0 && o.links && o.links.length) hi = i;
    });
    return Math.min(OUTPUT_SPECS.length, Math.max(2, hi + 2));
}

// 按目标数增删尾部输出槽；只删未连接的尾部槽，保证槽位 index 与后端返回顺序对齐。
// force=true 用于 onAfterGraphConfigured：此时 node.configure 已完成（links 已恢复），
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
    // 高度对齐 fitNode 的算法：有内容高度时按内容算，否则用核心 computeSize。
    if (node._neoBeContentH != null) {
        const w = node.size ? node.size[0] : 320;
        const widgetY = node._neoBeWidget?.y ?? 40;
        node.setSize([w, Math.max(widgetY + node._neoBeContentH + 8, MIN_HEIGHT)]);
    } else {
        node.setSize(node.computeSize());
    }
}

function makeLabel(icon, text, count) {
    const label = document.createElement("div");
    label.className = "neo-be-label";
    const ic = document.createElement("span");
    ic.textContent = icon;
    label.appendChild(ic);
    const t = document.createElement("span");
    t.textContent = text;
    label.appendChild(t);
    if (count != null) {
        const c = document.createElement("span");
        c.className = "neo-be-count";
        c.textContent = `(${count})`;
        label.appendChild(c);
    }
    return label;
}

function renderView(node, root, output) {
    root.innerHTML = "";
    const prompt = asText(output && output.prompt);
    const images = (output && Array.isArray(output.images)) ? output.images : [];

    // 提示词区
    root.appendChild(makeLabel("", t("提示词")));
    const promptBox = document.createElement("div");
    promptBox.className = "neo-be-prompt";
    if (prompt) {
        promptBox.textContent = prompt;
    } else {
        promptBox.classList.add("neo-be-prompt-empty");
        promptBox.textContent = t("（无提示词）");
    }
    root.appendChild(promptBox);

    // 参考图区：编号对应 image_N 输出槽位；坏参考槽位为 null，跳过显示但保留槽位编号。
    const validCount = images.filter(u => u).length;
    root.appendChild(makeLabel("", t("参考图"), validCount || null));

    if (validCount) {
        const grid = document.createElement("div");
        grid.className = "neo-be-grid";
        const lightboxItems = [];
        images.forEach((url, i) => {
            if (!url) return;  // 坏参考槽位：不显示，但后续编号仍按槽位 i+1
            lightboxItems.push({ kind: "image", url, title: `image_${i + 1}` });
            const cell = document.createElement("div");
            cell.className = "neo-be-cell";
            const badge = document.createElement("span");
            badge.className = "neo-be-badge";
            badge.textContent = String(i + 1);  // 对应 image_{i+1} 输出槽位
            const img = document.createElement("img");
            img.className = "neo-be-thumb";
            img.src = url;
            img.alt = `image_${i + 1}`;
            img.title = `image_${i + 1}`;
            const idx = lightboxItems.length - 1;
            img.addEventListener("click", () => Lightbox.open({ items: lightboxItems, index: idx }));
            cell.appendChild(badge);
            cell.appendChild(img);
            grid.appendChild(cell);
        });
        root.appendChild(grid);
    } else {
        const none = document.createElement("div");
        none.className = "neo-be-none";
        none.textContent = t("无参考图");
        root.appendChild(none);
    }

    // 下一帧测量，确保缩略图（aspect-ratio 占位）与提示词布局完成后高度准确。
    requestAnimationFrame(() => fitNode(node, root));
}

// 执行后按内容实际高度设置节点尺寸；widget.y 给出 DOM widget 在节点内的真实 Y 偏移（含标题栏 + 前置 widget 行）。
// 仅在 onExecuted → renderView 后调用一次，不干扰用户后续手动缩放。
function fitNode(node, root) {
    const w = node.size ? node.size[0] : 320;
    const contentH = root.scrollHeight;
    node._neoBeContentH = contentH;  // getMinHeight 读取此值，阻止用户缩到裁切内容
    const widgetY = node._neoBeWidget?.y ?? 40;
    const h = widgetY + contentH + 8;  // +8 底部内边距
    node.setSize([w, Math.max(h, MIN_HEIGHT)]);
}

app.registerExtension({
    name: "NeoBundleExpand.Display",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NeoBundleExpand") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        const origOnRemoved = nodeType.prototype.onRemoved;
        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        const origOnAfterGraphConfigured = nodeType.prototype.onAfterGraphConfigured;

        nodeType.prototype.onNodeCreated = function() {
            const result = origOnNodeCreated?.apply(this, arguments);
            // 新建节点只保留 prompt + image_1 两个输出槽，其余按连线增长（旧工作流由 onAfterGraphConfigured 归一）。
            while (this.outputs.length > 2) this.removeOutput(this.outputs.length - 1);
            const root = document.createElement("div");
            root.className = "neo-be-view";
            const hint = document.createElement("div");
            hint.className = "neo-be-hint";
            hint.textContent = t("等待执行…（运行后显示提示词与参考图）");
            root.appendChild(hint);

            // getMinHeight 以内容高度为下限：执行后节点不可缩短到裁切内容，但允许用户拉大。
            const widget = this.addDOMWidget("bundle_view", "custom", root, {
                margin: 4,
                getMinHeight: () => this._neoBeContentH || 30,
            });
            this._neoBeWidget = widget;
            this._neoBeRoot = root;
            root.style.width = "100%";
            root.style.maxWidth = "none";
            this.setSize([320, MIN_HEIGHT]);
            return result;
        };

        nodeType.prototype.onExecuted = function(output) {
            if (this._neoBeRoot) renderView(this, this._neoBeRoot, output);
        };

        nodeType.prototype.onConnectionsChange = function() {
            const result = origOnConnectionsChange?.apply(this, arguments);
            syncAutogrowOutputs(this);
            return result;
        };

        nodeType.prototype.onAfterGraphConfigured = function() {
            const result = origOnAfterGraphConfigured?.apply(this, arguments);
            // 加载旧工作流（保存了全部 10 个输出）时，收敛到「已连最高槽 + 1 个空槽」。
            syncAutogrowOutputs(this, true);
            return result;
        };

        nodeType.prototype.onRemoved = function() {
            this._neoBeRoot = null;
            this._neoBeWidget = null;
            return origOnRemoved?.apply(this, arguments);
        };
    },
});
