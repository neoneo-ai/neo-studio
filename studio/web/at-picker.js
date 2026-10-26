/**
 * at-picker.js
 * 输入框 @ 图片选择器：扫描工作流上的 Load Image 节点，把弹层锚定到光标附近，
 * 点击或回车将 <Picture N> 标记插入快捷输入框；无参数位的图片仅作为反推附件附加。
 */

import { app } from "../../scripts/app.js";
import { mkEl } from "./dom-utils.js";
import { t, tf } from "./js/core/i18n.js";

// quickInput：快捷输入框；attachedImages / imageKey / addImageInput / inputViewUrl 由聊天域注入，
// 选择器只读写附件与内联标记，不持有节点级状态。
function createAtImagePicker({ quickInput, attachedImages, imageKey, addImageInput, inputViewUrl }) {
    let pickerEl = null;

    // 收集工作流上未禁用的 Load Image 节点图片（与 gallery 发送按钮同款过滤：跳过 BYPASS/禁用）。
    // pictureNo：图片输出连接到目标节点 IMAGE 输入槽的参数序号（1-based）；无连线为 null，仅能用于反推。
    function collectWorkflowLoadImages() {
        return (async () => {
            try {
                let nodes = null;
                let serializedLinks = null; // graphToPrompt 序列化格式的 links 数组
                if (typeof app?.graphToPrompt === "function") {
                    try {
                        const prompt = await app.graphToPrompt();
                        nodes = prompt?.workflow?.nodes || null;
                        serializedLinks = prompt?.workflow?.links || null;
                    } catch (e) {
                        console.warn("[Neo] graphToPrompt:", e);
                    }
                }
                if (!Array.isArray(nodes)) nodes = app.graph?._nodes || [];

                // linkId -> {origin_id, target_id, target_slot}
                const linkMap = new Map();
                if (Array.isArray(serializedLinks)) {
                    for (const l of serializedLinks) {
                        // [id, origin_id, origin_slot, target_id, target_slot, type]
                        if (Array.isArray(l)) linkMap.set(String(l[0]), { origin_id: l[1], target_id: l[3], target_slot: l[4] });
                    }
                } else {
                    const gl = app.graph?.links;
                    const iter = gl && typeof gl.forEach === "function" ? gl : Object.values(gl || {});
                    iter.forEach(l => {
                        if (l && l.target_id != null) linkMap.set(String(l.id), l);
                    });
                }
                const nodeById = new Map(nodes.map(n => [String(n.id), n]));

                // 该 load image 输出连到目标节点 IMAGE 输入槽的参数序号；无连线返回 null
                const computePictureNo = (n) => {
                    for (const o of (n.outputs || [])) {
                        const lids = Array.isArray(o.links) ? o.links : (o.link != null ? [o.link] : []);
                        for (const lid of lids) {
                            const link = linkMap.get(String(lid));
                            if (!link) continue;
                            const target = nodeById.get(String(link.target_id));
                            if (!target) continue;
                            let count = 0;
                            const slotIdx = Number(link.target_slot) || 0;
                            for (let i = 0; i < (target.inputs || []).length; i++) {
                                if (String(target.inputs[i].type).toUpperCase() !== "IMAGE") continue;
                                count++;
                                if (i === slotIdx) return count;
                            }
                        }
                    }
                    return null;
                };

                // 有参数位（pictureNo）的优先排在前面；两组内部保持工作流原有顺序
                const connected = [];
                const unconnected = [];
                const skipped = [];
                for (const n of nodes) {
                // 核心 LoadImage / LoadImageOutput 及各类加载器变体
                const cls = String(n.comfyClass || n.type || "");
                if (!/load.*image/i.test(cls)) continue;
                if (n.mode === 2 || n.mode === 4) continue; // NEVER / BYPASS
                // 新增/切换/粘贴加载的节点，其 widgets_values 可能滞后于当前 widget 值。
                // 与前端序列化一致：先把自己节点的 widget 当前值回填，避免 @ 读到旧图片。
                if (Array.isArray(n.widgets) && Array.isArray(n.widgets_values)) {
                    for (let i = 0; i < n.widgets.length; i++) {
                        const w = n.widgets[i];
                        if (w && w.value !== undefined) n.widgets_values[i] = w.value;
                    }
                }
                // widgets_values 里图片项可能是字符串、数组(["name","sub","type"])或对象{name,...}
                let raw;
                for (const entry of (n.widgets_values || [])) {
                    if (typeof entry === "string" || Array.isArray(entry)) { raw = entry; break; }
                    if (entry && typeof entry === "object" && (entry.name || entry.filename)) { raw = entry; break; }
                }
                let v = "";
                if (typeof raw === "string") v = raw.trim();
                else if (Array.isArray(raw)) v = String(raw[0] ?? "").trim();
                else if (raw && typeof raw === "object") v = String(raw.name ?? raw.filename ?? "").trim();
                if (!v) {
                    skipped.push(`节点#${n.id}: empty`);
                    continue;
                }
                // [input]/[output] 标注不参与扩展名判断
                const base = v.replace(/\[[^\]]*\]\s*$/, "").trim();
                if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(base)) {
                    skipped.push(`节点#${n.id}: ${v}`);
                    continue;
                }
                const pictureNo = computePictureNo(n);
                (pictureNo != null ? connected : unconnected).push({ value: v, nodeId: n.id, pictureNo });
            }
            if (skipped.length) console.info("[Neo] @ 图片选择器跳过的加载节点:", skipped);
            return [...connected, ...unconnected];
        } catch (e) {
            console.warn("collectWorkflowLoadImages:", e);
            return [];
        }
        })();
    }

    // 估算 textarea 光标距内容区左上角的像素坐标（用于把 @ 弹层定位到光标附近）
    function getCaretPixel(el) {
        const mirror = mkEl("div");
        const cs = window.getComputedStyle(el);
        for (const p of ["fontFamily", "fontSize", "fontWeight", "fontStyle",
                         "letterSpacing", "lineHeight", "textTransform", "wordSpacing",
                         "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
                         "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
                         "boxSizing", "width"]) {
            mirror.style[p] = cs[p];
        }
        mirror.style.position = "absolute";
        mirror.style.left = "-99999px";
        mirror.style.top = "0";
        mirror.style.whiteSpace = "pre-wrap";
        mirror.style.wordWrap = "break-word";
        mirror.style.overflowWrap = "break-word";
        mirror.style.visibility = "hidden";
        const before = mkEl("span");
        before.textContent = el.value.slice(0, el.selectionStart);
        const marker = mkEl("span");
        marker.textContent = "\u200b"; // 零宽空格占位，测光标位置
        mirror.appendChild(before);
        mirror.appendChild(marker);
        document.body.appendChild(mirror);
        const mRect = marker.getBoundingClientRect();
        const m0 = mirror.getBoundingClientRect();
        document.body.removeChild(mirror);
        return { x: mRect.left - m0.left, y: mRect.top - m0.top };
    }

    async function openAtImagePicker() {
        if (pickerEl) return;
        // @ 不一定要在末尾：按光标前一个字符判断，支持在文本中间插入图片标记
        const sel = quickInput.selectionStart || 0;
        const atIndex = sel - 1;
        if (atIndex < 0 || quickInput.value[atIndex] !== "@") return;
        const images = await collectWorkflowLoadImages();
        // await 期间用户可能改动了输入：@ 不在原位置则放弃
        if (quickInput.value[atIndex] !== "@") return;

        // 点击行即插入：已附加的图片引用现有 <Picture N>，未附加的先添加再插入，然后关闭弹层
        const insertImageAtCaret = (img) => {
            if (!img || quickInput.value[atIndex] !== "@") { closePicker(); return; }
            // 无参数位（输出未连接）：仅作为反推附件附加，不占用 <Picture N> 编号
            if (img.pictureNo == null) {
                addImageInput(img.value); // 内部判重，已附加则忽略
                closePicker();
                return;
            }
            // 有参数位：确保已附加（chips 用于发送 payload），插入其参数序号标记
            const existIdx = attachedImages.findIndex(im => imageKey(im.input) === imageKey(img.value));
            if (existIdx < 0) addImageInput(img.value, null, img.pictureNo);
            const marker = "<Picture " + img.pictureNo + ">";
            quickInput.value = quickInput.value.slice(0, atIndex) + marker + quickInput.value.slice(atIndex + 1);
            // 焦点回到输入框并停在插入标记之后，方便继续输入
            quickInput.focus({ preventScroll: true });
            quickInput.setSelectionRange(atIndex + marker.length, atIndex + marker.length);
            quickInput.dispatchEvent(new Event("input", { bubbles: true }));
            closePicker();
        };

        const picker = mkEl("div", "rs-at-picker");
        const list = mkEl("div", "rs-at-picker-list");

        // 弹层无标题栏：无可用图片时在列表内给占位提示
        if (!images.length) {
            const empty = mkEl("div", "rs-at-picker-empty");
            empty.textContent = t("工作流中没有可用的 Load Image 图片");
            list.appendChild(empty);
        }

        images.forEach(img => {
            const row = mkEl("div", "rs-at-picker-row");
            row.style.position = "relative";

            const thumb = mkEl("img", "rs-at-picker-thumb");
            thumb.src = inputViewUrl(img.value);

            row.addEventListener("click", () => insertImageAtCaret(img));

            // 徽章语义：
            // - 有参数位（pictureNo）：蓝色 #N，点击插入/引用 <Picture N>
            // - 无参数位但已附加：灰色 ，点击无操作（仅作反推附件）
            const existIdx = attachedImages.findIndex(im => imageKey(im.input) === imageKey(img.value));
            if (img.pictureNo != null) {
                const picBadge = mkEl("span", "rs-picker-pic-badge");
                picBadge.textContent = `#${img.pictureNo}`;
                row.append(thumb, picBadge);
            } else if (existIdx >= 0) {
                const refBadge = mkEl("span", "rs-picker-ref-badge");
                refBadge.textContent = "";
                row.append(thumb, refBadge);
            } else {
                row.append(thumb);
            }
            list.appendChild(row);
        });

        picker.append(list);
        // 挂到 body 并用 fixed 定位：quickInputWrapper 的 overflow 会裁剪内部弹层
        pickerEl = picker;
        document.body.appendChild(picker);

        // ==========================================
        // 键盘导航：↑/↓ 移动高亮，Enter 插入当前项，Esc 关闭
        // ==========================================
        picker.tabIndex = 0;
        let activeIndex = 0;
        const rowEls = Array.from(list.querySelectorAll(".rs-at-picker-row"));
        const setActiveRow = (idx) => {
            activeIndex = Math.max(0, Math.min(rowEls.length - 1, idx));
            rowEls.forEach((r, i) => {
                r.classList.toggle("rs-picker-row-active", i === activeIndex);
            });
            const activeEl = rowEls[activeIndex];
            // 只滚动列表内部，避免 scrollIntoView 连带滚动祖先/页面导致弹层整体偏离
            if (activeEl) {
                const rowTop = activeEl.offsetTop;
                const rowBottom = rowTop + activeEl.offsetHeight;
                const listTop = list.scrollTop;
                const listBottom = listTop + list.clientHeight;
                if (rowTop < listTop) {
                    list.scrollTop = rowTop;
                } else if (rowBottom > listBottom) {
                    list.scrollTop = rowBottom - list.clientHeight;
                }
            }
        };
        rowEls.forEach((row, idx) => {
            row.classList.add("rs-picker-row");
            row.addEventListener("mousemove", () => setActiveRow(idx));
        });
        picker.addEventListener("keydown", (e) => {
            // 阻断冒泡，避免 ComfyUI 全局键盘处理器（画布平移等）响应这些按键导致弹层偏离输入框
            if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", " ", "Enter"].includes(e.key)) {
                e.preventDefault();
                e.stopPropagation();
            }
            switch (e.key) {
                case "ArrowDown":
                    setActiveRow(activeIndex + 1);
                    break;
                case "ArrowUp":
                    setActiveRow(activeIndex - 1);
                    break;
                case "Home":
                    setActiveRow(0);
                    break;
                case "End":
                    setActiveRow(rowEls.length - 1);
                    break;
                case "Enter":
                    insertImageAtCaret(images[activeIndex]);
                    break;
            }
        });
        // 打开后聚焦到 picker，让键盘立即可用，同时保留 Esc 全局处理
        picker.focus({ preventScroll: true });
        setTimeout(() => setActiveRow(0), 0);

        let handleEsc = null;
        let handleInputChange = null;
        const closePicker = () => {
            window.removeEventListener("pointerdown", onOutside, true);
            if (handleEsc) document.removeEventListener("keydown", handleEsc);
            if (handleInputChange) quickInput.removeEventListener("input", handleInputChange);
            pickerEl = null;
            picker.remove();
        };
        const onOutside = (e) => {
            if (!picker.contains(e.target)) closePicker();
        };
        window.addEventListener("pointerdown", onOutside, true);

        // 锚定到 @ 所在光标位置附近（支持在文本中间插入时跟随 @）。
        // 同步读取坐标并在同一次布局内计算定位，避免 rAF 延迟到下一帧导致缩放/布局变化偏移。
        const r = quickInput.getBoundingClientRect();
        const caret0 = getCaretPixel(quickInput);
        // 计算元素所在缩放容器的实际缩放比例：getBoundingClientRect 返回层叠后的屏幕坐标，
        // 而 getCaretPixel 的镜像测量返回 CSS 内容坐标。两者不一致时按比例校正，抵消画布缩放偏移。
        const elW = quickInput.offsetWidth || r.width;
        const elH = quickInput.offsetHeight || r.height;
        const scaleX = elW ? r.width / elW : 1;
        const scaleY = elH ? r.height / elH : scaleX;
        const caret = { x: caret0.x * scaleX, y: caret0.y * scaleY };
        const cs = window.getComputedStyle(quickInput);
        const bLeft = parseFloat(cs.borderLeftWidth) || 0;
        const bTop = parseFloat(cs.borderTopWidth) || 0;
        const pw = Math.min(Math.max(r.width, 50), 80); // 限制宽度在 50-80px 之间
        const estHeight = 260;
        let left = r.left + bLeft + caret.x - quickInput.scrollLeft;
        let top = r.top + bTop + caret.y + 20 - quickInput.scrollTop; // 默认在其下方
        // 水平：优先让弹层显示在 @ 右侧，超视口则靠右对齐
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
        // 垂直：下方放不下则翻到上方
        if (top + estHeight > window.innerHeight - 8) {
            top = r.top + bTop + caret.y - 14 - estHeight;
        }
        picker.style.left = Math.max(8, left) + "px";
        picker.style.top = Math.max(8, top) + "px";
        picker.style.width = pw + "px";

        // ESC 键关闭选择器
        handleEsc = (e) => {
            if (e.key === "Escape") closePicker();
        };
        document.addEventListener("keydown", handleEsc);

        // 监听输入框变化，如果 @ 被删除（选择器将失去对应锚点）则关闭
        handleInputChange = () => {
            if (quickInput.value[atIndex] !== "@") closePicker();
        };
        quickInput.addEventListener("input", handleInputChange);
    }

    // 从按钮触发的图片选择器：不需要 @ 在文本中，锚定到按钮位置，顶部有"全部"选项。
    async function openFromButton(anchorEl) {
        if (pickerEl) return;
        const images = (await collectWorkflowLoadImages()).sort((a, b) => (a.pictureNo ?? 999) - (b.pictureNo ?? 999));

        const insertPos = quickInput.selectionStart ?? quickInput.value.length;

        const insertSingle = (img) => {
            if (img.pictureNo == null) {
                addImageInput(img.value);
            } else {
                const existIdx = attachedImages.findIndex(im => imageKey(im.input) === imageKey(img.value));
                if (existIdx < 0) addImageInput(img.value, null, img.pictureNo);
                const marker = "<Picture " + img.pictureNo + ">";
                quickInput.value = quickInput.value.slice(0, insertPos) + marker + quickInput.value.slice(insertPos);
                quickInput.focus({ preventScroll: true });
                quickInput.setSelectionRange(insertPos + marker.length, insertPos + marker.length);
                quickInput.dispatchEvent(new Event("input", { bubbles: true }));
            }
        };

        const insertAll = () => {
            let offset = insertPos;
            for (const img of images) {
                if (img.pictureNo == null) {
                    addImageInput(img.value);
                } else {
                    const existIdx = attachedImages.findIndex(im => imageKey(im.input) === imageKey(img.value));
                    if (existIdx < 0) addImageInput(img.value, null, img.pictureNo);
                    const marker = "<Picture " + img.pictureNo + ">";
                    quickInput.value = quickInput.value.slice(0, offset) + marker + quickInput.value.slice(offset);
                    offset += marker.length;
                }
            }
            quickInput.focus({ preventScroll: true });
            quickInput.setSelectionRange(offset, offset);
            quickInput.dispatchEvent(new Event("input", { bubbles: true }));
        };

        const picker = mkEl("div", "rs-at-picker");
        const list = mkEl("div", "rs-at-picker-list");

        if (images.length) {
            const allRow = mkEl("div", "rs-at-picker-row rs-at-picker-all-row");
            const allLabel = mkEl("span", "rs-at-picker-all-label");
            allLabel.textContent = tf("全部 ({n})", { n: images.length });
            allRow.appendChild(allLabel);
            allRow.addEventListener("click", () => { insertAll(); closePicker(); });
            list.appendChild(allRow);
        }

        if (!images.length) {
            const empty = mkEl("div", "rs-at-picker-empty");
            empty.textContent = t("工作流中没有可用的 Load Image 图片");
            list.appendChild(empty);
        }

        images.forEach(img => {
            const row = mkEl("div", "rs-at-picker-row");
            row.style.position = "relative";
            const thumb = mkEl("img", "rs-at-picker-thumb");
            thumb.src = inputViewUrl(img.value);
            row.addEventListener("click", () => { insertSingle(img); closePicker(); });
            const existIdx = attachedImages.findIndex(im => imageKey(im.input) === imageKey(img.value));
            if (img.pictureNo != null) {
                const picBadge = mkEl("span", "rs-picker-pic-badge");
                picBadge.textContent = `#${img.pictureNo}`;
                row.append(thumb, picBadge);
            } else if (existIdx >= 0) {
                const refBadge = mkEl("span", "rs-picker-ref-badge");
                refBadge.textContent = "";
                row.append(thumb, refBadge);
            } else {
                row.append(thumb);
            }
            list.appendChild(row);
        });

        picker.append(list);
        pickerEl = picker;
        document.body.appendChild(picker);
        picker.tabIndex = 0;
        let activeIndex = 0;
        const rowEls = Array.from(list.querySelectorAll(".rs-at-picker-row"));
        const setActiveRow = (idx) => {
            activeIndex = Math.max(0, Math.min(rowEls.length - 1, idx));
            rowEls.forEach((r, i) => r.classList.toggle("rs-picker-row-active", i === activeIndex));
            const activeEl = rowEls[activeIndex];
            if (activeEl) {
                const rowTop = activeEl.offsetTop;
                const rowBottom = rowTop + activeEl.offsetHeight;
                const listTop = list.scrollTop;
                const listBottom = listTop + list.clientHeight;
                if (rowTop < listTop) list.scrollTop = rowTop;
                else if (rowBottom > listBottom) list.scrollTop = rowBottom - list.clientHeight;
            }
        };
        rowEls.forEach((row, idx) => {
            row.classList.add("rs-picker-row");
            row.addEventListener("mousemove", () => setActiveRow(idx));
        });
        picker.addEventListener("keydown", (e) => {
            if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", " ", "Enter"].includes(e.key)) {
                e.preventDefault();
                e.stopPropagation();
            }
            switch (e.key) {
                case "ArrowDown": setActiveRow(activeIndex + 1); break;
                case "ArrowUp": setActiveRow(activeIndex - 1); break;
                case "Home": setActiveRow(0); break;
                case "End": setActiveRow(rowEls.length - 1); break;
                case "Enter":
                    if (activeIndex === 0 && images.length) { insertAll(); closePicker(); }
                    else if (images[activeIndex - 1]) { insertSingle(images[activeIndex - 1]); closePicker(); }
                    break;
            }
        });
        picker.focus({ preventScroll: true });
        setTimeout(() => setActiveRow(0), 0);

        const closePicker = () => {
            window.removeEventListener("pointerdown", onOutside, true);
            if (handleEsc) document.removeEventListener("keydown", handleEsc);
            pickerEl = null;
            picker.remove();
        };
        const onOutside = (e) => {
            if (!picker.contains(e.target) && e.target !== anchorEl) closePicker();
        };
        window.addEventListener("pointerdown", onOutside, true);

        // 锚定到按钮下方
        const r = anchorEl.getBoundingClientRect();
        const pw = Math.max(100, Math.min(r.width + 60, 140));
        const estHeight = 260;
        let left = r.left;
        let top = r.bottom + 4;
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
        if (top + estHeight > window.innerHeight - 8) {
            top = r.top - 4 - estHeight;
        }
        picker.style.left = Math.max(8, left) + "px";
        picker.style.top = Math.max(8, top) + "px";
        picker.style.width = pw + "px";

        let handleEsc = null;
        handleEsc = (e) => { if (e.key === "Escape") closePicker(); };
        document.addEventListener("keydown", handleEsc);
    }

    return { open: openAtImagePicker, openFromButton };
}

export { createAtImagePicker };
