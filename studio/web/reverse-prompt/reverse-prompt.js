/**
 * reverse-prompt.js — 「图片反推」页宿主（Studio 视图）：挑一张图，把画面写成一段提示词。
 *
 * 反推由内核那侧的 LLM 链做（POST /rs_prompts/reverse_prompt），逐 token 经 SSE 推流，成文同时
 * 写进图片同目录的 .txt —— 与素材卡 ⋯ 菜单那条反推是同一个接口、同一份落点，本页只管取图、
 * 上屏、复制。首页「编辑」板块的入口卡是这页唯一的来路（顶栏没有这一枚页签）。
 */
import { t } from "../js/core/i18n.js";
import { icon, setIconLabel } from "../js/core/icons.js";
import { getThumbnailSrc } from "../gallery-utils.js";

const REVERSE_API = "/rs_prompts/reverse_prompt";

// 与素材卡反推弹窗同一对取值：后端认 zh / en，界面上的「中文 / 英文」只是字
export const REVERSE_LANGS = [
    { value: "zh", label: "中文" },
    { value: "en", label: "英文" },
];

// 组件样式在第一次建视图时注入（幂等）：本模块也会被主画布页的扩展图加载，
// 放在模块顶层会让画布为一份用不上的样式表发一次请求。
function ensureCss() {
    if (document.getElementById("neo-reverse-css")) return;
    const link = document.createElement("link");
    link.id = "neo-reverse-css";
    link.rel = "stylesheet";
    link.href = "/extensions/comfyui-neo-studio/reverse-prompt/reverse-prompt.css";
    document.head.appendChild(link);
}

/** 素材库选中项 → 反推请求体：后端认的就是画廊那三元组 */
export function reverseRequestBody(item, language) {
    return {
        filename: item?.filename || "",
        subfolder: item?.subfolder || "",
        language: language || "zh",
    };
}

/**
 * SSE 帧 → 文本增量。帧形与素材卡反推弹窗同一套：meta 帧只带 status / txt_file，正文在 text 帧，
 * [DONE] 收尾，[ERROR] 是后端把失败写进流里 —— 流没有状态码可查，不在这里抛就只剩一个空结果框。
 */
export async function readReverseStream(resp, onText) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") return;
            if (data.startsWith("[ERROR]")) throw new Error(data.slice(7).trim() || t("反推失败"));
            try {
                const parsed = JSON.parse(data);
                if (typeof parsed.text === "string") onText(parsed.text);
            } catch { /* 非 JSON 帧（心跳）照收不下屏 */ }
        }
    }
}

/**
 * 建「图片反推」视图。依赖由宿主注入：api 走 shim（离线与在线同一条路），
 * openMaterial 打开素材库弹窗并把选中项交回来，gateRun 把「反推」交运行闸门。
 */
export function createReverseView({ api, $el, toast, openMaterial, gateRun }) {
    return async function buildReverse(el) {
        ensureCss();
        el.classList.add("ns-reverse");
        let source = null;    // {filename, subfolder, label} —— null 时整页是起手卡片
        let language = "zh";
        let runSeq = 0;       // 换图与重跑之后，在途的那一条流只丢字，不再上屏

        const btn = (label, iconKey, extra = "") => {
            const b = $el("button", { className: "ns-reverse-btn" + extra, type: "button" });
            setIconLabel(b, iconKey, t(label));
            return b;
        };

        const pickBtn = btn("从素材库选图", "folder", " ns-reverse-btn-primary");
        const switchBtn = btn("换图", "cross");
        const runBtn = btn("反推", "eye", " ns-reverse-run ns-reverse-btn-primary");
        const copyBtn = btn("复制提示词", "copy");
        const preview = $el("img", { className: "ns-reverse-preview", alt: "" });
        const sourcePill = $el("span", { className: "ns-reverse-pill", textContent: t("没有图片") });
        const outText = $el("pre", { className: "ns-reverse-out", textContent: "" });
        const status = $el("div", {
            className: "ns-reverse-status",
            textContent: t("点「反推」生成提示词，结果自动写进图片同目录的 .txt"),
        });

        const langRow = $el("div", { className: "ns-reverse-lang" });
        const paintLang = () => {
            for (const chip of langRow.children) chip.classList.toggle("is-on", chip.dataset.value === language);
        };
        for (const l of REVERSE_LANGS) {
            const chip = $el("button", { className: "ns-reverse-chip", type: "button", textContent: t(l.label) });
            chip.dataset.value = l.value;
            chip.onclick = () => { language = l.value; paintLang(); };
            langRow.appendChild(chip);
        }
        paintLang();

        const bar = $el("div", { className: "ns-reverse-bar" }, [
            $el("span", { className: "ns-reverse-bar-title" }, [icon("eye", 18), t("图片反推")]),
            sourcePill,
            $el("span", { className: "ns-reverse-sep" }),
            switchBtn,
            runBtn,
        ]);
        const outBox = $el("section", { className: "ns-reverse-out-box" }, [
            $el("div", { className: "ns-reverse-head" }, [t("反推出的提示词"), langRow, copyBtn]),
            outText,
            status,
        ]);
        const empty = $el("div", { className: "ns-reverse-empty" }, [
            $el("h3", { textContent: t("图片反推") }),
            $el("p", { textContent: t("挑一张图，把画面写成一段提示词：结果同时写进图片同目录的 .txt，浏览素材库就看得见") }),
            $el("div", { className: "ns-reverse-row" }, [pickBtn]),
        ]);
        const main = $el("div", { className: "ns-reverse-main" }, [preview, outBox, empty]);
        el.append(bar, main);

        const paintChrome = () => {
            preview.hidden = !source;
            if (source) preview.src = getThumbnailSrc({ filename: source.filename }, source.subfolder);
            outBox.hidden = !source;
            empty.hidden = !!source;
            sourcePill.textContent = source ? source.label : t("没有图片");
            switchBtn.disabled = !source;
            runBtn.disabled = !source;
        };

        const pick = () => openMaterial((picked) => {
            const item = Array.isArray(picked) ? picked[0] : picked;   // 取用条批量交上来时是一条数组
            if (!item?.filename) return;
            source = {
                filename: item.filename,
                subfolder: item.subfolder || "",
                label: (item.subfolder ? `${item.subfolder}/` : "") + item.filename,
            };
            runSeq++;   // 上一张图在途的流到此为止：它的字不该落进这一张的结果框
            outText.textContent = "";
            paintChrome();
        });
        pickBtn.onclick = pick;
        switchBtn.onclick = pick;

        const run = async () => {
            if (!source) return;
            const seq = ++runSeq;
            outText.textContent = "";
            status.textContent = t("反推中…");
            runBtn.disabled = true;
            try {
                const resp = await api.fetchApi(REVERSE_API, {
                    method: "POST",
                    body: JSON.stringify(reverseRequestBody(source, language)),
                    headers: { "Content-Type": "application/json" },
                });
                if (!resp.ok) {
                    const data = await resp.json().catch(() => ({}));
                    throw new Error(data?.error || `HTTP ${resp.status}`);
                }
                await readReverseStream(resp, (piece) => {
                    if (seq === runSeq) outText.textContent += piece;
                });
                status.textContent = outText.textContent.trim()
                    ? t("已生成，结果同时写进图片同目录的 .txt")
                    : t("(空提示词)");
            } catch (e) {
                if (seq === runSeq) status.textContent = String(e?.message || e);
            } finally {
                if (seq === runSeq) runBtn.disabled = !source;
            }
        };
        runBtn.onclick = run;

        copyBtn.onclick = async () => {
            const text = outText.textContent.trim();
            if (!text) { toast(t("还没有可复制的提示词")); return; }
            try {
                await navigator.clipboard.writeText(text);
                setIconLabel(copyBtn, "check", t("已复制"));
                setTimeout(() => { setIconLabel(copyBtn, "copy", t("复制提示词")); }, 1500);
            } catch (e) {
                toast(t("复制失败，选中结果框自己复制"));
            }
        };

        gateRun(runBtn, "prompt_reverse", t("反推"));
        paintChrome();
    };
}

