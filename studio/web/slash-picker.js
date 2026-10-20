/**
 * slash-picker.js
 * 输入框快捷选择器：输入触发字符（默认 /）唤起，随输入实时过滤 skill 列表（按 name/id/tags，含中文拼音），
 * ↑/↓/Home/End 移动高亮、Enter/Tab 提交当前高亮项、Esc 关闭。
 * 只过滤不自动提交：始终需要按一次键确认，不会边打边跳。
 * 两个调用方差在参数上：提示词页是 / 选技能写进技能下拉；智能体面板是 @ 选技能、选中交后端当本轮点名技能。
 * 技能分类与显示名由调用方交进来（filter / sort / rowText / categoryLabel）：本模块只认一个列表和一组回调，
 * 不 import skill.js 的分类表——面板那份候选集是「能跑的生图与出片技能」，跟提示词页要显示的不是一批。
 */

import { mkEl } from "./dom-utils.js";
import { t } from "./js/core/i18n.js";

function createSlashSkillPicker({ quickInput, listSkills, skillSelector = null, commit = null,
                                  triggerChar = "/", filter = null, sort = null,
                                  rowText = null, categoryLabel = null, prefix = "rs-slash-picker" }) {
    let pickerEl = null; // 已打开的弹层句柄：防止重复叠加，关闭时置空
    const rowTextOf = rowText || ((s) => (s.needs_image ? "📷 " : "") + (s.cn_name || s.name || s.id || ""));

    async function openSlashSkillPicker() {
        if (pickerEl) return;
        // / 不一定要在末尾：按光标前一个字符判断，支持在文本中间插入
        const sel = quickInput.selectionStart || 0;
        const slashIndex = sel - 1;
        if (slashIndex < 0 || quickInput.value[slashIndex] !== triggerChar) return;

        const skills = await listSkills();
        // await 期间用户可能改动了输入：触发字符不在原位置则放弃
        if (quickInput.value[slashIndex] !== triggerChar) return;

        let activeIndex = 0;
        let currentItems = [];

        // 提交当前选中 skill：交调用方（提示词页写下拉，仅当 option 存在，避免清空已有选择）、清除触发字符到光标那一段、关闭弹层
        const commitSkill = (skill) => {
            closePicker();
            if (!skill || quickInput.value[slashIndex] !== triggerChar) return;
            if (commit) commit(skill);
            else if (Array.from(skillSelector.options).some(o => o.value === skill.id)) {
                skillSelector.value = skill.id;
                skillSelector.dispatchEvent(new Event("change", { bubbles: true }));
            }
            // 保留触发字符之前的内容与光标之后的内容，删除中间的 query
            const caret = quickInput.selectionStart || 0;
            const before = quickInput.value.slice(0, slashIndex);
            const after = quickInput.value.slice(caret);
            quickInput.value = before + after;
            quickInput.focus({ preventScroll: true });
            quickInput.setSelectionRange(before.length, before.length);
            quickInput.dispatchEvent(new Event("input", { bubbles: true }));
        };

        // 按 query 过滤：name / id / tags（含后端追加的中文拼音标签）任一包含（忽略大小写）；
        // 调用方的 filter 决定这一份列表里哪些技能可选，空 query 时按调用方的 sort 稳定排一次
        const filterSkills = (query) => {
            const q = (query || "").trim().toLowerCase();
            const matched = skills.filter(s => {
                if (filter && !filter(s)) return false;
                if (!q) return true;
                if ((s.name || "").toLowerCase().includes(q)) return true;
                if ((s.id || "").toLowerCase().includes(q)) return true;
                for (const tag of (s.tags || [])) {
                    if (tag && String(tag).toLowerCase().includes(q)) return true;
                }
                return false;
            });
            if (!q && sort) matched.sort(sort);
            return matched;
        };

        const picker = mkEl("div", prefix);
        const list = mkEl("div", `${prefix}-list`);
        picker.append(list);
        pickerEl = picker;
        document.body.appendChild(picker); // 挂 body + fixed：quickInputWrapper 的 overflow 会裁剪内部弹层

        const rowEls = () => Array.from(list.querySelectorAll(`.${prefix}-row`));
        const syncActive = () => {
            rowEls().forEach((r, i) => r.classList.toggle("rs-picker-row-active", i === activeIndex));
            const rows = rowEls();
            const activeEl = rows[activeIndex];
            // 只滚动列表内部，避免 scrollIntoView 连带滚动祖先导致弹层整体偏离
            if (activeEl) {
                const rowTop = activeEl.offsetTop;
                const rowBottom = rowTop + activeEl.offsetHeight;
                const listTop = list.scrollTop;
                const listBottom = listTop + list.clientHeight;
                if (rowTop < listTop) list.scrollTop = rowTop;
                else if (rowBottom > listBottom) list.scrollTop = rowBottom - list.clientHeight;
            }
        };
        const setActiveRow = (idx) => {
            activeIndex = Math.max(0, Math.min(rowEls().length - 1, idx));
            syncActive();
        };

        // 重建行：渲染当前过滤结果，高亮索引钳制到范围内
        const render = (query) => {
            list.innerHTML = "";
            currentItems = filterSkills(query);
            if (!currentItems.length) {
                const empty = mkEl("div", `${prefix}-empty`);
                empty.textContent = t("无匹配 skill");
                list.appendChild(empty);
                activeIndex = 0;
                return;
            }
            currentItems.forEach((s, idx) => {
                const row = mkEl("div", `${prefix}-row`);
                const name = mkEl("span", `${prefix}-name`);
                name.textContent = rowTextOf(s);
                row.appendChild(name);
                const label = categoryLabel && categoryLabel(s);
                if (label) {
                    const meta = mkEl("span", `${prefix}-meta`);
                    meta.textContent = label;
                    row.appendChild(meta);
                }
                row.addEventListener("click", () => commitSkill(s));
                row.addEventListener("mousemove", () => setActiveRow(idx));
                list.appendChild(row);
            });
            activeIndex = Math.max(0, Math.min(activeIndex, currentItems.length - 1));
            syncActive();
        };

        let handleKey = null;
        let handleInputChange = null;
        const closePicker = () => {
            document.removeEventListener("mousedown", onOutside);
            if (handleKey) document.removeEventListener("keydown", handleKey, true);
            if (handleInputChange) quickInput.removeEventListener("input", handleInputChange);
            pickerEl = null;
            picker.remove();
        };
        const onOutside = (e) => {
            if (!picker.contains(e.target)) closePicker();
        };
        setTimeout(() => document.addEventListener("mousedown", onOutside), 0);

        // 输入变化：触发字符被删或 query 出现空白则关闭，否则重新过滤（不自动提交）。焦点留在 quickInput，继续打字即更新 value 触发这里。
        handleInputChange = () => {
            if (quickInput.value[slashIndex] !== triggerChar) { closePicker(); return; }
            const caret = quickInput.selectionStart || 0;
            const query = quickInput.value.slice(slashIndex + 1, caret);
            if (/\s/.test(query)) { closePicker(); return; }
            render(query);
        };
        quickInput.addEventListener("input", handleInputChange);

        // 键盘：document 捕获阶段拦截，先于 llm-chat 的 quickInput Enter/发送处理。
        // 可打印字符放行（让 value 更新触发过滤）；↑/↓/Home/End 移动高亮、Enter/Tab 提交、Esc 关闭。
        handleKey = (e) => {
            switch (e.key) {
                case "ArrowDown": e.preventDefault(); e.stopPropagation(); setActiveRow(activeIndex + 1); break;
                case "ArrowUp": e.preventDefault(); e.stopPropagation(); setActiveRow(activeIndex - 1); break;
                case "Home": e.preventDefault(); e.stopPropagation(); setActiveRow(0); break;
                case "End": e.preventDefault(); e.stopPropagation(); setActiveRow(rowEls().length - 1); break;
                case "Enter":
                case "Tab": e.preventDefault(); e.stopPropagation(); commitSkill(currentItems[activeIndex]); break;
                case "Escape":
                    // 摘走这一下：右栏的 Esc 是「收掉写了一半的输入」，弹层开着时那一下归弹层
                    e.preventDefault(); e.stopPropagation(); closePicker(); break;
            }
        };
        document.addEventListener("keydown", handleKey, true);

        // 焦点保留在 quickInput：继续打字即过滤，方向键/回车由上面的捕获监听接管
        render(quickInput.value.slice(slashIndex + 1, quickInput.selectionStart || 0));
        setTimeout(() => setActiveRow(0), 0);

        // 定位：锚定到输入框下方（fixed 覆盖层，getBoundingClientRect 已含画布缩放），超视口则上翻/靠边
        const r = quickInput.getBoundingClientRect();
        const width = 340;
        let left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - width));
        let top = r.bottom + 4;
        const estHeight = 220;
        if (top + estHeight > window.innerHeight - 8) top = Math.max(8, r.top - estHeight - 4);
        picker.style.left = left + "px";
        picker.style.top = top + "px";
        picker.style.width = width + "px";
    }

    return openSlashSkillPicker;
}

export { createSlashSkillPicker };

