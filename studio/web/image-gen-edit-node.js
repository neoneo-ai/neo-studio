// NeoImageGenEdit 节点：width/height/steps 默认跟随所选 skill 预设（base_resolution + default_ratio + steps）。
// 参考 NeoH3VideoDirector（web/director-node.js）的 applyDimDefaults：仅当仍为默认 -1 时填充，
// 切换 skill 下拉强制重填；工作流已存的实值优先（首次载入不覆盖）。
// 另修复旧版本工作流/复制粘贴导致的 widgets_values 串位：seed 之后会自动追加 control_after_generate
// 下拉（吃一个位置），widget 集合变化后按位置还原会把它落到数字上。正常态它恒为模式串、seed 恒为非负整数，
// 二者任一非法即判定 seed/count/width/height 整块错位 → 复位 control/seed/count 并强制按预设重填宽高。
import { registerExtension } from "./js/core/comfy-app.js";
import { api } from "../../../../scripts/api.js";
import { attachSkillPickerToComboWidget, createSkillStatusRow } from "./skill.js";
import { t } from "./js/core/i18n.js";

registerExtension({
    name: "NeoImageGenEdit.DimDefaults",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NeoImageGenEdit") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function() {
            const result = origOnNodeCreated?.apply(this, arguments);
            const node = this;
            const skillWidget = node.widgets?.find((w) => w.name === "skill");
            // 点击 skill combo → 弹居中技能选择窗（替代原生下拉）；选中写回 widget.value，
            // 其 callback 已被下方包装为 loadDims(true)，故尺寸预设自动刷新
            if (skillWidget) attachSkillPickerToComboWidget(skillWidget, { title: t("选择 Skill（生图/编辑）") });

            // 节点底部 Skill 有效性状态条：选完 skill 后台检测缺模型/缺节点，有缺失显示告警并可点开详情修复
            // （skill 下拉存的是技能名称，状态条内部反查真实 skill 再校验）
            const statusRow = createSkillStatusRow({ getSkills: () => (skillWidget ? [String(skillWidget.value || "")] : []), isVideo: false });
            node.addDOMWidget("skill_status", "custom", statusRow.el);
            statusRow.refresh();

            // 用 skill 预设填 width/height/steps widget；force=false 时仅当仍为默认 -1（保留工作流已存值）。
            const applyDimDefaults = (d, force) => {
                if (!d) return;
                for (const [nm, val] of [["width", d.width], ["height", d.height], ["steps", d.steps]]) {
                    const w = node.widgets?.find((x) => x.name === nm);
                    if (!w || !Number.isFinite(val)) continue;
                    if (!force && Number(w.value) !== -1) continue;
                    w.value = val;
                    w.callback?.(val);
                }
            };

            // dimsSeq：并发令牌。工作流还原会先后触发两次（创建默认值 + configure 还原值），旧响应用 seq 判废
            let dimsSeq = 0;
            const loadDims = async (force = false) => {
                const seq = ++dimsSeq;
                const name = skillWidget ? String(skillWidget.value || "") : "";
                if (!name) return;
                try {
                    const resp = await api.fetchApi(`/neo_image_gen/skill_dims?skill_id=${encodeURIComponent(name)}`);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data.success && seq === dimsSeq) applyDimDefaults(data, force);
                    }
                } catch (e) {
                    console.error("[Neo Studio] krea2 skill dims fetch failed", e);
                }
            };

            // 串位修复：control_after_generate 正常恒为模式串，seed 恒为 >=0 的整数。二者任一非法即判定
            // seed/count/width/height 数字块错位（或复制粘贴损坏）→ 复位 control/seed/count，强制按预设重填宽高。
            const repairShiftedWidgets = () => {
                const control = node.widgets?.find((w) => w.name === "control_after_generate");
                const cv = control ? control.value : null;
                const controlBad = typeof cv === "number" || (typeof cv === "string" && cv.trim() !== "" && Number.isFinite(Number(cv)));
                const seedW = node.widgets?.find((w) => w.name === "seed");
                const seedNum = seedW ? Number(seedW.value) : 0;
                const seedBad = !Number.isFinite(seedNum) || seedNum < 0;
                if (!controlBad && !seedBad) return;

                // control 落到数字 → 整块错位：复位 control、count，宽高按预设重填
                if (controlBad) {
                    if (control) {
                        const modes = control.options?.values || control.values || [];
                        control.value = modes.includes("fixed") ? "fixed" : (modes[0] ?? "fixed");
                        control.callback?.(control.value);
                    }
                    const countW = node.widgets?.find((x) => x.name === "count");
                    if (countW) { countW.value = 1; countW.callback?.(1); }
                    loadDims(true);
                }
                // seed 非法（NaN/负数）→ 串位块无法可靠恢复原值，复位为默认 0
                if (seedBad && seedW) { seedW.value = 0; seedW.callback?.(0); }
            };

            loadDims();

            // 切换 skill 下拉时强制重填预设宽高/步数（本版本 combo widget 用 callback 触发变化，onchange 不存在）
            if (skillWidget) {
                const oc = skillWidget.callback;
                skillWidget.callback = function() { oc?.apply(this, arguments); loadDims(true); statusRow.refresh(); };
            }

            // 载入/粘贴按 widgets_values 还原后修复串位：control 是数字 → 复位并强制重填宽高；
            // 旧格式（widgets_values 少于当前控件数，width/height 是新加的）→ 强制按预设重填。
            // onNodeCreated 先于 configure 运行，故在此挂接实例钩子（同 web/director-node.js）。
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function(data) {
                const r = origOnConfigure?.apply(this, arguments);
                repairShiftedWidgets();
                const sv = data?.widgets_values;
                if (Array.isArray(sv) && sv.length < (this.widgets?.length || 0)) loadDims(true);
                statusRow.refresh(); // 工作流还原后按还原的 skill 重检有效性
                return r;
            };

            const origOnRemoved = node.onRemoved;
            node.onRemoved = function() {
                statusRow.destroy();
                return origOnRemoved?.apply(this, arguments);
            };

            return result;
        };
    },
});
