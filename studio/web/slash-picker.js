/**
 * slash-picker.js
 * 输入框快捷选择器：输入触发字符（默认 /）唤起，随输入实时过滤 skill 列表（按 name/id/tags，含中文拼音），
 * ↑/↓/Home/End 移动高亮、Enter/Tab 提交当前高亮项、Esc 关闭。
 * 只过滤不自动提交：始终需要按一次键确认，不会边打边跳。
 * 一次弹层最多铺 MAX_ROWS 行，余下的收成一行提示：@ 弹层那六类候选上千条时，逐键重铺整棵列表
 * 就是把输入拖慢的那一段；排序只随候选批次算一次，不在每次过滤里重排。
 * 两个调用方差在参数上：提示词页是 / 选技能写进技能下拉；智能体面板是 @ 选技能、选中交后端当本轮点名技能。
 * tokenOf 给定时提交换成往输入框写一个可见记号（智能体面板的 @category:name），不给就照原样吃掉触发字符到光标那一段。
 * 技能分类与显示名由调用方交进来（filter / sort / rowText / categoryLabel）：本模块只认一个列表和一组回调，
 * 不 import skill.js 的分类表——面板那份候选集是「能跑的生图与出片技能 + 没有模板的正文型技能」，
 * 跟提示词页要显示的不是一批。
 */

import { mkEl } from "./dom-utils.js";
import { t, tf } from "./js/core/i18n.js";

const MAX_ROWS = 120;   // 一次弹层铺的行数上限：候选上千时逐键重铺整棵列表，输入的延迟压在这里
const LIST_MAX_PX = 220;   // CSS 没给列表盒 max-height 时的兜底高度；定位时要拿真实的那个数

function createSlashSkillPicker({ quickInput, listSkills, skillSelector = null, commit = null,
                                  triggerChar = "/", filter = null, sort = null,
                                  rowText = null, categoryLabel = null, tokenOf = null,
                                  prefix = "rs-slash-picker" }) {
    let pickerEl = null; // 已打开的弹层句柄：防止重复叠加，关闭时置空
    const rowTextOf = rowText || ((s) => (s.needs_image ? "📷 " : "") + (s.cn_name || s.name || s.id || ""));

    async function openSlashSkillPicker() {
        if (pickerEl) return;
        // / 不一定要在末尾：按光标前一个字符判断，支持在文本中间插入
        const sel = quickInput.selectionStart || 0;
        const slashIndex = sel - 1;
        if (slashIndex < 0 || quickInput.value[slashIndex] !== triggerChar) return;

        // 弹层先开门、候选随后补：@ 弹层那六类由四条接口汇成，最慢的一条（模型目录扫描）
        // 压不住已经到手的那几类，见 mention-picker.js 的 items(onBatch)
        let pool = [];   // 这一批候选里可选的那些，已按调用方的 sort 排好一次
        let settled = false;

        const queryNow = () => quickInput.value.slice(slashIndex + 1, quickInput.selectionStart || 0);

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
            // 保留触发字符之前的内容与光标之后的内容，删除中间的 query；
            // 调用方给了 tokenOf 就换上一个可见记号（智能体面板的 @category:name），
            // 没给就是原样吃掉那一段（提示词页的 / 只写下拉，正文不留记号）
            const caret = quickInput.selectionStart || 0;
            const before = quickInput.value.slice(0, slashIndex);
            const after = quickInput.value.slice(caret);
            const token = tokenOf ? String(tokenOf(skill) || "") : "";
            quickInput.value = before + token + after;
            const at = before.length + token.length;
            quickInput.focus({ preventScroll: true });
            quickInput.setSelectionRange(at, at);
            quickInput.dispatchEvent(new Event("input", { bubbles: true }));
        };

        // 每到手一批候选就重建一次这份池子：filter 与 sort 只看候选自身，随批算一次就定序，
        // 逐字过滤那条路上不再排上千项
        const setPool = (rows) => {
            pool = filter ? rows.filter(filter) : rows.slice();
            if (sort) pool.sort(sort);
        };

        // 按 query 过滤：name / id / tags（含后端追加的中文拼音标签）任一包含（忽略大小写）
        const filterSkills = (query) => {
            const q = (query || "").trim().toLowerCase();
            if (!q) return pool;
            return pool.filter(s => {
                if ((s.name || "").toLowerCase().includes(q)) return true;
                if ((s.id || "").toLowerCase().includes(q)) return true;
                for (const tag of (s.tags || [])) {
                    if (tag && String(tag).toLowerCase().includes(q)) return true;
                }
                return false;
            });
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
                // 一批候选都没到手：弹层先空着，别报"无匹配"骗用户去改 query
                if (!settled) return;
                const empty = mkEl("div", `${prefix}-empty`);
                empty.textContent = t("无匹配 skill");
                list.appendChild(empty);
                activeIndex = 0;
                place();
                return;
            }
            const visible = currentItems.slice(0, MAX_ROWS);
            const omitted = currentItems.length - visible.length;
            if (omitted > 0) {
                // 列表盒只有 220px 高：提示画在末尾永远滚不到，画在最上面才看得到"还剩多少"
                // 这一行不带 -row 类：方向键的钳制与 Enter 取的那一项都按 -row 数，不能算它一份
                const more = mkEl("div", `${prefix}-empty`);
                more.textContent = tf("…其余 {n} 条未显示，继续输入缩小范围", { n: omitted });
                list.appendChild(more);
            }
            visible.forEach((s, idx) => {
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
            activeIndex = Math.max(0, Math.min(activeIndex, visible.length - 1));
            syncActive();
            place();
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
            const query = queryNow();
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

        // 定位：贴住输入框。宽度吃输入框自己的宽度，高度量刚铺完行的真实值——写死一个 220 估高，
        // 输入框贴着窗口下沿时下方必判「装不下」，三行候选的弹层就悬在输入框上方两百多像素处
        const place = () => {
            const r = quickInput.getBoundingClientRect();   // fixed 覆盖层，这里的坐标已含画布缩放
            const w = Math.min(Math.max(r.width, 300), window.innerWidth - 16);
            const roomBelow = window.innerHeight - r.bottom - 12;
            const roomAbove = r.top - 12;
            // 列表盒缩到上下两侧里装得下的那点：翻到上方时铺到第 120 行也不会被窗口上沿切掉。
            // 上限认列表盒自己的 CSS——两个宿主页给的 max-height 不是一个数
            const cap = parseFloat(getComputedStyle(list).maxHeight) || LIST_MAX_PX;
            list.style.maxHeight = Math.min(cap, Math.max(roomBelow, roomAbove)) + "px";
            picker.style.width = w + "px";
            const h = picker.offsetHeight;
            picker.style.top = (roomBelow >= h ? r.bottom + 4 : Math.max(8, r.top - h - 4)) + "px";
            picker.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)) + "px";
        };

        // 焦点保留在 quickInput：继续打字即过滤，方向键/回车由上面的捕获监听接管
        render(queryNow());
        setTimeout(() => setActiveRow(0), 0);

        // 候选源每取回一批就回调重画（items(onBatch)）；最后一批到手才算 settled，
        // 此后空列表才配得上"无匹配"那一句
        const rows = await listSkills((batch) => {
            setPool(batch);
            if (pickerEl) render(queryNow());
        });
        // 取回期间用户可能改动了输入：触发字符不在原位置就丢掉这一批
        if (quickInput.value[slashIndex] !== triggerChar) return;
        setPool(rows);
        settled = true;
        render(queryNow());
    }

    return openSlashSkillPicker;
}

export { createSlashSkillPicker };

