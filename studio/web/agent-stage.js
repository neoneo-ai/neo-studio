/**
 * agent-stage.js —— 中间舞台：右栏那一轮智能体的当前过程与产物，在页面生成面板下方放大显示。
 *
 * 只吃实时帧（右栏 agent-panel.js 把同一路 SSE 的帧交过来），自己不留第二份状态：
 * 新的 run 帧一到就清场，中间永远只有当前这一轮，不会堆成第二条历史时间线。
 * 开关（偏好表单里那一项，存 localStorage）关掉时整块不挂，帧也接不进来。
 */
import { mkEl } from "./dom-utils.js";
import { t, tf } from "./js/core/i18n.js";
import { Lightbox } from "./lightbox.js";
import { renderMarkdown } from "./skill.js";
import { createFramePlayer } from "./live-preview.js";
import { isMediaHref, mediaKindOf } from "./js/core/media-href.js";

// 焦点链事实在中间只留用户在放映区认得出的那几项：种子这类左栏里没有的留给右栏焦点卡
const STAGE_FACTS = [["skill_id", "技能"], ["model", "主模型"], ["loras", "LoRA"],
                     ["width", "宽"], ["height", "高"], ["recipe", "导演配方"]];

// 采样预览块的最长边：与结果图那一档同高，竖图按高定宽、横图按宽定高；STAGE_MAX_W 是 CSS 的块宽上限
const PREVIEW_MAX_SIDE = 480;
const STAGE_MAX_W = 720;

export function createAgentStage(options = {}) {
    // 宿主块只在有内容时占位由调用方决定：绘画页空轮不该在页面底下留一块空面板
    const onContent = options.onContent || null;
    const el = mkEl("div", "ns-agent-stage");
    const head = mkEl("div", "ns-agent-stage-head");
    const title = mkEl("span", "ns-agent-stage-title");
    title.textContent = "" + t("智能体");
    const status = mkEl("span", "ns-agent-stage-status");
    head.append(title, status);
    const planBox = mkEl("div", "ns-agent-stage-plan");
    const factBox = mkEl("div", "ns-agent-stage-facts");
    const previewBox = mkEl("div", "ns-agent-stage-preview");
    const mediaBox = mkEl("div", "ns-agent-stage-media");
    const answerBox = mkEl("div", "ns-agent-stage-answer");
    el.append(head, planBox, factBox, previewBox, mediaBox, answerBox);

    let on = false;
    let empty = true;
    let live = null;
    let previewOn = true;     // 采样预览是本机开关（设置页「智能体偏好」）：关掉时这一轮的帧不铺动画
    let previewOff = false;   // 产物上台后采样预览退场：中间那一块留给结果图
    const items = [];

    function render() {
        el.hidden = !on;
        planBox.hidden = empty || !planBox.children.length;
        factBox.hidden = empty || !factBox.children.length;
        previewBox.hidden = empty || previewOff || !previewOn;
        mediaBox.hidden = empty || !mediaBox.children.length;
        answerBox.hidden = empty || !answerBox.textContent;
        if (onContent) onContent(on && (!empty || !!status.textContent));
    }

    function clear() {
        items.length = 0;
        planBox.textContent = "";
        factBox.textContent = "";
        mediaBox.textContent = "";
        answerBox.textContent = "";
        if (live) { live.pause(); live = null; }
        previewBox.textContent = "";   // 播放器在 box 里铺了自己的节点，清空就是清场
        previewOff = false;
        empty = true;
        status.textContent = "";
    }

    // 同一张产物会到两次：generate_image 的 tool_result 交一次，finish_task 收场时把同一批产物名再交一次。
    // 中间这一轮只认 url，第二遍是重复像素，不是新产物
    // 产物一格一格铺大：点开放大窗口看全图与播放，页面自己不导航（同右栏口径）
    function addMedia(media) {
        const added = (media || []).filter((m) => m && m.url && !items.some((x) => x.url === m.url));
        if (!added.length) return;
        empty = false;
        const start = items.length;
        added.forEach((m, i) => {
            items.push({ kind: m.kind || "image", url: m.url, title: m.title || "" });
            const video = (m.kind || "image") === "video";
            const node = mkEl(video ? "video" : "img");
            node.src = m.url;
            node.loading = "lazy";
            node.title = video ? t("点击播放") : t("点击放大查看");
            if (video) {
                node.muted = true;
                node.preload = "metadata";
                node.setAttribute("playsinline", "true");
            }
            node.onclick = () => Lightbox.open({ items, index: start + i, compact: true });
            mediaBox.appendChild(node);
        });
    }

    // 最终回答里的产物图与链接收在页面内：放任 <a> 默认行为就是整扇窗口翻到图片页
    answerBox.addEventListener("click", (e) => {
        const pic = e.target.closest ? e.target.closest("img") : null;
        if (pic) {
            const src = pic.getAttribute("src") || "";
            if (isMediaHref(src)) Lightbox.open({ items: [{ kind: mediaKindOf(src), url: src, title: pic.alt || "" }], compact: true });
            else if (src) window.open(src, "_blank", "noopener");
            return;
        }
        const a = e.target.closest ? e.target.closest("a[href]") : null;
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href") || "";
        if (isMediaHref(href)) Lightbox.open({ items: [{ kind: mediaKindOf(href), url: href, title: a.textContent || "" }], compact: true });
        else window.open(href, "_blank", "noopener");
    });

    function planRows(list) {
        const rows = list.map((s, i) => {
            const row = mkEl("div", "ns-agent-stage-plan-row" + (s.done ? " ns-agent-stage-plan-done" : ""));
            row.textContent = `${s.done ? "" : "▢ "}${i + 1}. ${s.tool}`
                + (s.key_args ? `（${s.key_args}）` : "") + (s.note ? `：${s.note}` : "");
            return row;
        });
        const foot = mkEl("div", "ns-agent-stage-plan-foot");
        foot.textContent = tf("{done}/{total} 已完成",
            { done: list.filter((s) => s.done).length, total: list.length });
        planBox.replaceChildren(...rows);
        planBox.appendChild(foot);
    }

    function factChips(focusObj) {
        const chips = STAGE_FACTS
            .filter(([key]) => focusObj[key] !== undefined && focusObj[key] !== null)
            .map(([key, label]) => {
                const chip = mkEl("span", "ns-agent-stage-fact");
                const value = focusObj[key];
                chip.title = t(label);
                chip.textContent = `${t(label)} ${Array.isArray(value) ? value.join(" / ") : value}`;
                return chip;
            });
        if (chips.length) factBox.replaceChildren(...chips);
    }

    function onFrame(frame) {
        if (!on) return;
        const kind = frame?.kind || "";
        // 会话标题帧是前端自己发的显示帧（agent-panel.js 在标题定下来那一发交过来，不进后端时间线）：
        // 页眉在整场生成里挂同一句，清空标题回到默认那一句
        if (kind === "title") { title.textContent = frame.text ? "" + frame.text : "" + t("智能体"); return; }
        if (kind === "run") { clear(); status.textContent = t("本轮开始"); render(); return; }
        if (kind === "tool_call") {
            empty = false;
            status.textContent = "" + (frame.tool || "?");
        } else if (kind === "tool_skipped") {
            // 点名已经把这一步定好了，后端在调用点上直接跳过：状态行报一句跳过，不铺工具卡
            empty = false;
            status.textContent = "⤷ " + t("已跳过") + " " + (frame.tool || "?");
        } else if (kind === "status") {
            empty = false;
            status.textContent = frame.text || "";
            // 采样预览在中间正是它最该大的那块：播放器自定帧率循环该步动画，运行结束定格
            const preview = frame.preview;
            if (previewOn && preview && Array.isArray(preview.frames) && preview.frames.length) {
                // 退场之后又有新的采样步：pause() 过的实例不收迟到载荷，换新实例才接得上这一帧
                if (previewOff) { previewBox.textContent = ""; live = null; previewOff = false; }
                // reset() 把内联高度写成 0px 藏住面板；载荷到达时按画面宽高比定块宽：
                // 固定高度配 100% 宽会把竖图裁成头部特写，竖图那一档只能让宽跟着画面走
                live = live || createFramePlayer(previewBox, (data) => {
                    previewBox.style.height = "";
                    const w = Number(data.w) || 0, h = Number(data.h) || 0;
                    if (w && h) previewBox.style.maxWidth = `${Math.round(Math.min(PREVIEW_MAX_SIDE * w / h, STAGE_MAX_W))}px`;
                });
                live.apply(preview);
            }
        } else if (kind === "plan_steps") {
            const list = frame.steps || [];
            if (list.length) { empty = false; planRows(list); }
        } else if (kind === "focus") {
            const facts = frame.focus || {};
            if (Object.keys(facts).length) { empty = false; factChips(facts); }
        } else if (kind === "tool_result") {
            if (!(frame.media || []).length) return;
            addMedia(frame.media);
            if (live) live.pause();   // 产物上台，采样预览退场：那一块换给结果图
            previewOff = true;
            status.textContent = "" + (frame.tool || "");
        } else if (kind === "ask") {
            empty = false;
            status.textContent = "" + (frame.text || "");
        } else if (kind === "paused") {
            status.textContent = t("已暂停");
        } else if (kind === "resumed") {
            status.textContent = t("运行中");
        } else if (kind === "finish") {
            empty = false;
            if (live) live.pause();   // 收场不留动画在跑：定格的预览帧也让位给产物
            previewOff = true;
            answerBox.innerHTML = renderMarkdown(frame.text || "");
            addMedia(frame.media || []);
            status.textContent = t("本轮完成");
        } else return;
        render();
    }

    // 关掉就整块收起：期间右栏在跑的帧接不进来，重新打开从下一帧开始跟
    function setEnabled(value) {
        on = !!value;
        if (!on) clear();
        render();
    }

    // 采样预览开关（本机偏好）：中途关掉就把在跑的动画收掉，那块立刻让给状态行与产物
    function setPreviewMode(value) {
        previewOn = !!value;
        if (!previewOn) {
            if (live) live.pause();
            live = null;
            previewBox.textContent = "";
        }
        render();
    }

    render();
    return { el, onFrame, setEnabled, setPreviewMode };
}
