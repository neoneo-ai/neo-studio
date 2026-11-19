/**
 * bundle-lock.js
 * NeoImageGenEdit / NeoH3VideoDirector：
 * 1) bundle 是 NeoPromptAgent 产出的引用 id，不由用户手输——后端以 forceInput 声明为纯连线槽，
 *    与 image 一致：节点体内不显示文本框，只留左侧 slot；未连接时后端收到 ""。
 * 2) bundle 输入一旦链接，即禁用「以 bundle 为准」的控件（Gen&Edit: prompt；Director: recipe），断开后恢复；
 *    实时连线变化（onConnectionsChange）与加载工作流（onAfterGraphConfigured）都按当前连线状态刷新。
 */

import { registerExtension } from "./js/core/comfy-app.js";

// Gen&Edit 只锁 prompt（bundle 携带的增强提示词）；skill_id 保持可用——bundle 只带资源、不带 skill。
// Director 的 recipe / 视频 skill 选择器显隐由 director-node.js 自行处理，这里不锁控件。
const BUNDLE_LOCK_NODES = {
    "NeoImageGenEdit": ["prompt"],
    "NeoH3VideoDirector": [],
};

function bundleLinked(node) {
    const input = node.inputs?.find((i) => i.name === "bundle");
    return !!(input && input.link != null);
}

function applyBundleLock(node) {
    const locked = bundleLinked(node);
    for (const name of BUNDLE_LOCK_NODES[node.type] || []) {
        const w = node.widgets?.find((w) => w.name === name);
        if (w) w.disabled = locked;
    }
    // Director 额外隐藏/恢复节点内时间轴（Krea2 无此方法，?. 安全跳过）
    node._neoDtApplyBundleLock?.(locked);
    if (node.graph) node.graph.setDirtyCanvas(true, true);
}

registerExtension({
    name: "NeoNodes.BundleLock",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!(nodeData.name in BUNDLE_LOCK_NODES)) return;

        // 实时连线变化（bundle 输入 link 增删）：延迟一拍读取，确保 inputs[slot].link 已写入。
        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const result = origOnConnectionsChange?.apply(this, arguments);
            setTimeout(() => applyBundleLock(this), 0);
            return result;
        };

        // 加载工作流：图配置完成后按最终连线状态刷新禁用态。
        const origOnAfterGraphConfigured = nodeType.prototype.onAfterGraphConfigured;
        nodeType.prototype.onAfterGraphConfigured = function () {
            const result = origOnAfterGraphConfigured?.apply(this, arguments);
            setTimeout(() => applyBundleLock(this), 0);
            return result;
        };
    },
});
