/**
 * prompt-enhance.js — 「提示词增强」页宿主（Studio 视图）：一句话加一枚技能，写成一段完整提示词。
 *
 * 版面照绘画页与视频页那一套：整页一块舞台，底部一枚输入卡钉在下缘（技能与思考深度是底行那两枚 chip，
 * 参考图是编辑页那一副「＋参考」方块与取图浮层，右上角一枚「图像 / 视频」开关换技能清单与提示词池），
 * 舞台上落逐轮对话（空舞台先落一句起手引导，第一条气泡落下来就收）——会话就在这一页的闭包里攒着，每一发的输入一条气泡、
 * 模型的回话一条气泡，下一发默认把攒下的回话垫在正文前面交给模型（historyBlock），「新增会话」把这一摞清空。
 * 运行中那枚「增强」就是「停止」本身，按下去断流。思考与流程状态只占回话气泡里的一行状态位，思考正文不上屏。
 * 整条链不碰 ComfyUI 运行时：技能列表读数据根（GET /rs_prompts/skills），
 * 出流打 8080 与远程 LLM（POST /rs_prompts/stream_generate_prompt，注册在 studio/llm.py 的 routes 上，
 * 桌面端离线服务挂载的就是这一份），参考图读 input/ 与粘贴进来的 data URI —— 桌面窗口离线时这一页照用。
 * 只有「保存为预设」是提示词库写侧，按能力表门控（app/studio_caps.py 的 prompt_library_write）。
 * 首页「创作」板块的入口卡是这页唯一的来路（顶栏没有这一枚页签）。
 */
import { t, tf } from "../js/core/i18n.js";
import { setIcon, setIconLabel } from "../js/core/icons.js";
import { actionToast } from "../toast.js";
import { getThumbnailSrc, isPickableImage } from "../gallery-utils.js";
import { listSkills, populateSkillOptions, openSkillDetailById, SKILL_CHANGED_EVENT, ENHANCE_CATEGORIES, isEnhanceSkill } from "../skill.js";
import { openLLMSettingsModal } from "../llm-setting.js";
import { chipButton } from "../gen-utils.js";
import { openPresetPicker, randomPromptText, savePromptTo } from "../js/core/preset-picker.js";
import { sseStream, fileToBase64, imagesFromClipboard, createStreamOutputHandlers,
         extractTitle, THINKING_EFFORTS } from "../prompt-service.js";

/** 思考深度档位：off 发 enable_thinking:false，其余走 THINKING_EFFORTS 那份映射（high 是模板的 xhigh 档） */
export const THINKING_DEPTHS = ["off", "low", "medium", "high"];
/** 参考图上限 = 后端那条增强链的 MAX_REF_IMAGES（studio/llm.py），写死一份会让两端各说各话 */
export const MAX_ENHANCE_REFS = 4;
/** 右上角那枚「图像 / 视频」开关：技能清单只列对应分类（image_enhance / video_enhance），
 *  提示词的取用 / 骰子 / 保存一起落对应那一池（preset-picker 的 kind，与提示词管理页同一条池子规则）。
 *  视频模式没有「智能判断」：后端空 skillId 只认图像侧（带图走反推、不带图走默认增强任务，studio/llm.py） */
export const ENHANCE_MODES = ["image", "video"];
const MODE_LABELS = { image: "图像", video: "视频" };
const MODE_CATEGORIES = { image: ENHANCE_CATEGORIES[0], video: ENHANCE_CATEGORIES[1] };
export const ENHANCE_API = "/rs_prompts/stream_generate_prompt";
/** 会话交进请求体的规模：与后端会话文件同一份口径（单条 4000 字裁剪、整份有上限）。
 *  粘贴与上传的参考图是整串 data URI，进历史只留一句引用，图字节只发当前这一发 */
export const HISTORY_PAIRS = 8;
export const HISTORY_CHAR_CAP = 4000;

const DEPTH_LABELS = { off: "不思考", low: "浅思考", medium: "标准思考", high: "深度思考" };

function ensureCss() {
    const MARK = "data-neo-prompt-enhance";
    if (typeof document === "undefined") return;
    if (document.querySelector(`style[${MARK}]`)) return;
    const link = document.querySelector(`link[${MARK}]`);
    if (link) {
        link.setAttribute("rel", "stylesheet");
        link.setAttribute("href", window.comfyAPI?.app?.app?.baseDir
            ? `${window.comfyAPI.app.app.baseDir}/extensions/comfyui-neo-studio/prompt-enhance/prompt-enhance.css`
            : "/extensions/comfyui-neo-studio/prompt-enhance/prompt-enhance.css");
        return;
    }
    const base = window.comfyAPI?.app?.app?.baseDir
        ? `${window.comfyAPI.app.app.baseDir}/extensions/comfyui-neo-studio/prompt-enhance/prompt-enhance.css`
        : "/extensions/comfyui-neo-studio/prompt-enhance/prompt-enhance.css";
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.type = "text/css";
    css.href = base;
    css.setAttribute(MARK, "1");
    document.head.appendChild(css);
}

/**
 * 增强链的请求体：技能留空 = 后端按输入长度自己挑（图片反推与通用增强两条），空串发出去后端会当合法 skillId 处理。
 * 思考深度 off 走 enable_thinking:false（DeepSeek 思考开关），其余档位走 reasoning_effort（OpenAI 兼容）。
 * 档位词表用 prompt-service 里的那一份共享常量：与 NeoPromptAgent 节点同源，后端新加一档时两处一起跟上。
 */
export function enhancePayload({ text, skillId = "", depth = "medium", images = [] }) {
    const payload = { text };
    if (skillId) payload.skillId = skillId;
    if (depth === "off") payload.enable_thinking = false;
    else payload.reasoning_effort = THINKING_EFFORTS[depth] || THINKING_EFFORTS.medium;
    if (images.length) payload.images = images;
    return payload;
}

/** 两段拼一条：骰子往输入里追加一行随机提示词、历史垫在正文前面都走这条分隔线。
 *  后端吃的是单条文本，线让模型看得出哪段是上一轮、哪段是这一发 */
export function joinPromptText(main, extra) {
    const a = (main || "").trim();
    const b = (extra || "").trim();
    if (!a) return b;
    if (!b) return a;
    return `${a}\n\n---\n\n${b}`;
}

/**
 * 会话 → 垫在正文前的历史块。后端那条增强链是单轮的（studio/llm.py 里消息就是 [system, user]，
 * Native 模式连多轮都不认），历史就当正文垫在这一发前面，三种 LLM 模式通吃、请求体形状不变。
 * 只收最近 HISTORY_PAIRS 对、单条裁到 HISTORY_CHAR_CAP：参考图只留一句引用，整串 data URI 进历史
 * 会把请求体撑到几 MB。
 */
export function historyBlock(entries) {
    return (entries || []).slice(-HISTORY_PAIRS * 2).map((e) => {
        const who = e.role === "assistant" ? t("上一轮模型回的") : t("上一轮我说的");
        const refs = e.role === "user" && e.refs ? tf("（附 {n} 张参考图）", { n: e.refs }) : "";
        return `${who}${refs}：\n${(e.text || "").trim().slice(0, HISTORY_CHAR_CAP)}`;
    }).join("\n\n");
}

/** 素材库选中项 → 后端认的图片源：素材落在 output/ 侧，[output] 标注交给 image_gen_files._read_image_raw 认目录 */
export function galleryImageSource(item) {
    const filename = item?.filename || "";
    if (!filename) return null;
    const path = (item.subfolder ? `${item.subfolder}/` : "") + filename;
    return { src: { kind: "input", value: `${path}[output]` }, label: path };
}


/**
 * 建「提示词增强」视图。依赖由宿主注入：$el 建 DOM，toast 落提示，openMaterial 开素材库弹窗取图，
 * gateRun 把「增强」交运行闸门，can 认能力表（提示词库写侧离线不可用）。
 */
export function createPromptEnhanceView({ $el, toast, openMaterial, gateRun, can, applyToPage }) {
    return async function buildEnhance(el) {
        ensureCss();
        el.classList.add("ns-enhance");
        const thumbs = new Map();    // 方块值 → 缩略图：素材走 output 侧的 /view，粘贴进来的就是那串 data URI
        const pasted = new Map();    // 方块值 → data URI：整串 data URI 不当方块值用（方块 title 里它会拖成一坨）
        let pastedSeq = 0;
        let runSeq = 0;              // 点停止与重跑之后，在途的那一条流只丢字，不再上屏
        let abort = null;
        let media = loadMode();      // 图像 / 视频：技能清单与提示词池一起换

        const btn = (label, iconKey, extra = "") => {
            const b = $el("button", { className: "ns-enhance-btn" + extra, type: "button" });
            setIconLabel(b, iconKey, t(label));
            return b;
        };

        // 空舞台那块引导（字号配色就是绘画页与视频页共享的 .neo-gallery-gm-idle：一行大字一句细注）：
        // 第一条气泡落下来就收，「新增会话」清空舞台再回来。引导里不放第二套钮——抽词、取图、选技能
        // 都在下面那枚输入卡上，把入口抄一份到舞台中间只会多出一套要跟着模式改的文案
        const guide = $el("div", { className: "ns-enhance-guide neo-gallery-gm-idle" }, [
            $el("div", { className: "neo-gallery-gm-idle-title", textContent: t("写一句，点增强") }),
            $el("div", { className: "neo-gallery-gm-idle-sub", textContent: t("结果落在上方气泡，可复制或存为预设") }),
        ]);
        guide.onclick = () => promptEl.focus();   // 点引导就是回到输入框

        // 舞台 = 逐轮对话：输入那条贴右、回话那条贴左，底部内边距躲开浮动胶囊
        const stage = $el("div", { className: "ns-enhance-stage" }, [guide]);
        const toBottom = () => { stage.scrollTop = stage.scrollHeight; };

        const statusEl = $el("div", { className: "ns-enhance-status" });
        // 思考与流程状态在整页只占这一行，就钉在输入卡上方（每发一条气泡不再各带一行）：思考正文一个字
        // 也不上屏，正文一开始就收走。面板那份留给节点面板与技能执行弹窗（createStreamOutputHandlers 无 lineEl 的旧行为）
        const lineEl = $el("div", { className: "ns-enhance-line", hidden: true });

        // 参考图：编辑页那一副「＋参考」方块（gallery.css 的 .neo-gallery-edit-refdrop 族，与编辑页同一份样式）——
        // 空格是 ＋，点击就是素材库取用，本地文件与素材卡直接拖进图位；hover 方块行浮出取图浮层
        // （头部计数 + 本地上传 / 素材库取用）。图位值是张标签：素材库取用的是 input 相对名 + [output]，
        // 粘贴与本地上传的是「粘贴的图片 N」，那串 data URI 存在 pasted 里，发出去时才取
        const refs = [];   // 图位顺序就是发出去的参考顺序
        const refFile = $el("input", { className: "ns-enhance-file", type: "file", accept: "image/*", multiple: "multiple" });
        refFile.hidden = true;
        const refCount = $el("span", { className: "neo-gallery-edit-refcount-num" });
        const refPicks = $el("div", { className: "neo-gallery-edit-refpicks" }, [
            $el("div", { className: "neo-gallery-edit-refcount" }, [
                $el("span", { textContent: t("参考图") }),
                refCount,
            ]),
            $el("button", {
                className: "neo-gallery-edit-refpick", type: "button", textContent: "⬆ " + t("本地上传"),
                title: t("选本地图片文件作参考：一次可选多张"),
                onclick: () => { refFile.click(); closePicks(); },
            }),
            $el("button", {
                className: "neo-gallery-edit-refpick", type: "button", textContent: "🖼 " + t("素材库取用"),
                title: t("从素材库取图作参考：弹窗里点卡片取用，或从素材库拖进图位"),
                onclick: () => { pickRefsFromLibrary(); closePicks(); },
            }),
        ]);
        const refRow = $el("div", { className: "ns-enhance-refrow neo-gallery-edit-refdrop-row" }, [refPicks, refFile]);
        // 浮层开在方块上方、中间有 6px 间隙：纯 :hover 跨不过去（一离开方块行就失 hover、浮层变不可点，
        // 两项取图就点不中）——JS 开关带 250ms 关闭宽限，期间移进浮层取消关闭（同编辑页那一副）
        let pickCloseTimer = 0;
        const openPicks = () => { clearTimeout(pickCloseTimer); refRow.classList.add("picks-open"); };
        const closePicks = () => { clearTimeout(pickCloseTimer); pickCloseTimer = setTimeout(() => refRow.classList.remove("picks-open"), 250); };
        refRow.addEventListener("mouseenter", openPicks);
        refRow.addEventListener("mouseleave", closePicks);
        refPicks.addEventListener("mouseenter", openPicks);
        refPicks.addEventListener("mouseleave", closePicks);
        const syncRefCount = () => { refCount.textContent = `${refs.length}/${MAX_ENHANCE_REFS}`; };
        // 图位值 → 后端认的图片源：素材库那批是 input 相对名 + [output]，粘贴与上传那批是 data URI
        const refSources = () => refs.map((v) => (pasted.has(v)
            ? { kind: "data", data: pasted.get(v) }
            : { kind: "input", value: v }));
        const refSnap = () => refs.map((v) => ({ label: v, thumb: thumbs.get(v) || "" }));
        function pruneMaps() {
            const keep = new Set(refs);
            for (const k of thumbs.keys()) if (!keep.has(k)) thumbs.delete(k);
            for (const k of pasted.keys()) if (!keep.has(k)) pasted.delete(k);
        }

        /** 图位一枚：有图就是缩略 + ✕（摘掉那一张，后面的补位），空格是「＋参考」——点击就是素材库取用 */
        function makeRefSlot(index) {
            const value = refs[index];
            const slot = $el("div", { className: "neo-gallery-edit-refdrop" });
            if (value) {
                slot.classList.add("has-img");
                slot.title = value;
                slot.appendChild($el("img", { className: "neo-gallery-edit-refchip-img", src: thumbs.get(value) || "", alt: value, draggable: false }));
                slot.appendChild($el("span", {
                    className: "neo-gallery-edit-refchip-x", textContent: "✕", title: t("移除"),
                    onclick: (e) => { e.stopPropagation(); refs.splice(index, 1); renderRefs(); },
                }));
            } else {
                slot.title = t("点空格从素材库取图；把素材卡或本地图片文件拖进图位");
                slot.appendChild($el("span", { className: "neo-gallery-edit-refdrop-icon", textContent: "＋" }));
                slot.appendChild($el("span", { className: "neo-gallery-edit-refdrop-cap", textContent: t("参考") }));
                slot.onclick = () => pickRefsFromLibrary();
            }
            slot.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; slot.classList.add("drop-active"); });
            slot.addEventListener("dragleave", (e) => { if (!slot.contains(e.relatedTarget)) slot.classList.remove("drop-active"); });
            slot.addEventListener("drop", (e) => {
                e.preventDefault();
                e.stopPropagation();
                slot.classList.remove("drop-active");
                const files = Array.from(e.dataTransfer?.files || []);
                if (files.length) { addFiles(files); return; }
                const card = galleryCardFromDrop(e);
                if (card) addGalleryPicks([card]);
            });
            return slot;
        }

        /** 图位整列重建：取图浮层与隐藏文件框是常驻节点，图位插在它们前面 */
        function renderRefs() {
            for (const node of [...refRow.children]) {
                if (node.classList.contains("neo-gallery-edit-refdrop")) node.remove();
            }
            for (let i = 0; i < Math.min(refs.length + 1, MAX_ENHANCE_REFS); i++) {   // 满位就不长空位
                refRow.insertBefore(makeRefSlot(i), refPicks);
            }
            pruneMaps();
            syncRefCount();
        }
        renderRefs();

        /** 素材库取用的那批（弹窗回调与拖进来的素材卡共用）：只收图片，同一张不重复占位，满位报上限 */
        function addGalleryPicks(items) {
            let refused = 0, overflow = 0;
            for (const it of (Array.isArray(items) ? items : [items])) {
                if (refs.length >= MAX_ENHANCE_REFS) { overflow++; continue; }
                const name = String(it?.filename || "");
                if (!isPickableImage(name)) { refused++; continue; }
                const got = galleryImageSource(it);
                if (!got || refs.includes(got.src.value)) continue;
                thumbs.set(got.src.value, getThumbnailSrc({ filename: name }, it.subfolder || ""));
                refs.push(got.src.value);
            }
            if (refused) toast(t("参考图只吃图片：视频与音频不进图位"));
            if (overflow) toast(tf("参考图最多 {max} 张，先清掉几张", { max: MAX_ENHANCE_REFS }));
            renderRefs();
        }

        /** 参考图位的素材库取用：宿主给的 openMaterial 开素材库弹窗，取到的那批交回 addGalleryPicks */
        function pickRefsFromLibrary() {
            openMaterial((picked) => addGalleryPicks(picked));
        }

        /** 本地文件与粘贴进来的图（一次一批）：只吃图片，data URI 落进 pasted，图位上画的就是这一串 */
        async function addFiles(files) {
            const picked = (files || []).filter((f) => f.type.startsWith("image/"));
            if (picked.length !== (files || []).length) toast(t("参考图只吃图片：视频与音频不进图位"));
            if (!picked.length) return;
            const room = MAX_ENHANCE_REFS - refs.length;
            if (room <= 0) { toast(tf("参考图最多 {max} 张，先清掉几张", { max: MAX_ENHANCE_REFS })); return; }
            for (const f of picked.slice(0, room)) {
                try {
                    const { data } = await fileToBase64(f);
                    const value = tf("粘贴的图片 {n}", { n: ++pastedSeq });
                    pasted.set(value, data);
                    thumbs.set(value, data);
                    refs.push(value);
                } catch (e) {
                    toast(tf("图片读取失败：{msg}", { msg: String(e?.message || e) }));
                }
            }
            renderRefs();
        }

        const promptEl = $el("textarea", {
            className: "ns-enhance-prompt ns-enhance-input neo-gallery-gm-quick-input",
            rows: "2", spellcheck: "false",
        });
        const promptCount = $el("span", { className: "ns-enhance-count" });
        const syncCount = () => { promptCount.textContent = String(promptEl.value.length); };
        promptEl.addEventListener("input", syncCount);
        syncCount();

        const skillSel = $el("select", { className: "ns-enhance-skill" });
        const depthSel = $el("select", { className: "ns-enhance-depth" });
        for (const value of THINKING_DEPTHS) {
            depthSel.appendChild($el("option", { value, textContent: t(DEPTH_LABELS[value]) }));
        }
        depthSel.value = loadDepth();
        depthSel.addEventListener("change", () => {
            try { localStorage.setItem("rs.thinking_depth", depthSel.value); } catch { /* 隐私模式 */ }
        });
        // 底行两枚 chip 就是绘画页与视频页那一枚工厂产物（胶囊 + 朝上浮的菜单，原生 select 收在壳里当状态容器）
        const skillChip = chipButton(skillSel, { icon: "wand" });
        const depthChip = chipButton(depthSel, { icon: "sparkles" });

        const runBtn = btn("增强", "send", " ns-enhance-run ns-enhance-btn-primary");
        gateRun(runBtn, "prompt_enhance", t("增强"));
        const newBtn = btn("新增会话", "plus");

        const card = $el("div", { className: "ns-enhance-card neo-gallery-gm-composer" }, [
            $el("div", { className: "ns-enhance-top" }, [
                refRow,
                $el("div", { className: "ns-enhance-inputbox" }, [promptEl, promptCount]),
            ]),
            $el("div", { className: "ns-enhance-chips neo-gallery-gm-composer-bar neo-gallery-gm-chips" }, [
                skillChip.el,
                depthChip.el,
                $el("span", { className: "neo-gallery-gm-composer-gap" }),
                newBtn,
                runBtn,
            ]),
        ]);
        // 输入卡上方那一行独立的状态：左边是这一发的状态，右边是思考与流程的那一句。
        // 卡片与气泡里都不留这一行——两个子项空着时这一行自己塌成零高，页面上就是干净的输入卡
        const runline = $el("div", { className: "ns-enhance-runline" }, [statusEl, lineEl]);
        const dock = $el("div", { className: "ns-enhance-dock" }, [runline, card]);

        // 右上浮一枚入口列（同绘画页与视频页那一列）：左半从提示词库挑一条，右半骰子抽一条；
        // 它们左边那枚「图像 / 视频」开关换的是整页作用域——技能清单只列那一类的增强技能，
        // 取用 / 骰子 / 存预设一起落图像或视频那一池（preset-picker 的 kind 就是提示词管理页那条池子规则）
        const presetBtn = $el("button", {
            type: "button", className: "ns-btn ns-enhance-preset-btn", textContent: t("提示词"),
            title: t("从提示词库挑一条填进输入框"),
        });
        const diceBtn = $el("button", {
            type: "button", className: "ns-btn ns-enhance-dice",
            title: t("随机灵感填进输入框"),
        });
        setIcon(diceBtn, "dice");

        /** 占位符与 chip 的生效值跟着模式走：图像模式留空是「智能判断」，
         *  视频模式没有后端自选那一发，留空就说「选择技能」，不装成模型会自己挑 */
        const syncModeUi = () => {
            promptEl.placeholder = t(media === "video"
                ? "写下这一镜的画面与动作，或把已有的视频提示词贴进来"
                : "写下画面描述，或把已有的提示词贴进来");
            skillSel.dataset.follow = media === "video" ? t("选择技能") : t("智能判断");
        };
        const modeBtns = ENHANCE_MODES.map((m) => $el("button", {
            type: "button",
            className: "ns-enhance-mode-btn" + (m === media ? " active" : ""),
            textContent: t(MODE_LABELS[m]),
            title: t(m === "video"
                ? "增强视频提示词：技能清单与提示词池都换成视频那一池"
                : "增强图像提示词：技能清单与提示词池都换成图像那一池"),
            onclick: () => setMode(m),
        }));
        const setMode = (m) => {
            if (m === media) return;
            media = m;
            try { localStorage.setItem("rs.enhance.media", m); } catch { /* 隐私模式 */ }
            modeBtns.forEach((b, i) => b.classList.toggle("active", ENHANCE_MODES[i] === m));
            syncModeUi();
            loadSkills();   // 技能清单按池重填（重填里顺带把 chip 的生效值刷出来）
        };

        const bar = $el("div", { className: "ns-enhance-bar" }, [
            $el("div", { className: "ns-enhance-modes" }, modeBtns),
            $el("div", { className: "neo-split-btn" }, [presetBtn, diceBtn]),
        ]);
        syncModeUi();

        const fillPrompt = (text) => {
            promptEl.value = text;
            syncCount();
            promptEl.focus();
        };
        presetBtn.onclick = () => openPresetPicker({ kind: media, onPick: fillPrompt, anchor: presetBtn });
        diceBtn.onclick = async () => {
            try {
                fillPrompt(joinPromptText(promptEl.value, await randomPromptText(media)));
            } catch (e) { toast(String(e?.message || e)); }
        };

        refFile.addEventListener("change", () => {
            addFiles(Array.from(refFile.files || []));
            refFile.value = "";
        });
        const onPaste = (e) => {
            const files = imagesFromClipboard(e);
            if (!files.length) return;   // 纯文字粘贴照走输入框自己的那条路
            e.preventDefault();
            addFiles(files);
        };

        // 技能列表：技能管理里刚建的技能要即时出现在这一页的 chip 里（与节点面板认同一个事件）
        const loadSkills = async () => {
            const listed = await listSkills();
            const skills = Array.isArray(listed) ? listed : [];   // 桌面端离线那一发回来的不是数组
            const current = skillSel.value;
            // 带 workflow.json 与 gen_image 的技能走出图链路，本页只写提示词，不收这两类（isEnhanceSkill 与首页
            // 技能卡的落点同一口径）；图像与视频的增强技能不在同一张表里混着，只列当前这一池的分类
            const pool = skills.filter((s) => isEnhanceSkill(s)
                && (s.category || ENHANCE_CATEGORIES[0]) === MODE_CATEGORIES[media]);
            skillSel.replaceChildren();
            if (media === "image") {
                skillSel.appendChild($el("option", { value: "", textContent: t("智能判断") }));
            }
            populateSkillOptions(skillSel, pool);
            if (current && Array.from(skillSel.options).some((o) => o.value === current)) {
                skillSel.value = current;
            } else if (media === "video") {
                // 视频模式没有「智能判断」这一项，也没有跨池可留的选中：落在列表第一条，chip 上写的就是它
                skillSel.selectedIndex = 0;
            }
            skillChip.sync();
        };
        window.addEventListener(SKILL_CHANGED_EVENT, loadSkills);

        const skillLabel = () => skillSel.options[skillSel.selectedIndex]?.textContent
            || (media === "video" ? t("选择技能") : t("智能判断"));
        const depthLabel = () => t(DEPTH_LABELS[depthSel.value] || DEPTH_LABELS.medium);

        /** 这一发的气泡：输入那条把正文与参考图缩略留在舞台上，回话那条带正文框与「复制 / 存预设」 */
        const userMsg = (text, refs) => $el("div", { className: "ns-enhance-msg ns-enhance-msg-user" }, [
            $el("div", { className: "ns-enhance-msg-meta", textContent: t("我的输入") }),
            $el("div", { className: "ns-enhance-msg-text", textContent: text || t("只给了参考图") }),
            refs.length ? $el("div", { className: "ns-enhance-refs" }, refs.map((r) => $el("div", {
                className: "ns-enhance-ref", title: r.label,
            }, [r.thumb ? $el("img", { className: "ns-enhance-ref-img", src: r.thumb, alt: "" }) : null]))) : null,
        ]);


        const aiMsg = (histCount) => {
            // 正文就是舞台上那段文字，不套框：CSS 里 field-sizing 让它多长写多高，rows 只是老浏览器那一档的兜底
            const outEl = $el("textarea", {
                className: "ns-enhance-out", rows: "2", spellcheck: "false", readonly: "readonly",
                placeholder: t("增强结果会逐字落在这里"),
            });
            // 复制 / 落页 / 保存三枚图标钮，文字收进悬停提示；预设名不再让使用者填，标题由正文自动生成
            const copyBtn = $el("button", {
                className: "ns-enhance-btn ns-enhance-acts-btn ns-enhance-copy", type: "button",
                title: t("复制提示词"), "aria-label": t("复制提示词"),
            });
            setIcon(copyBtn, "copy");
            // 落页的档位按这一发发出时的档位定：中途切了图像 / 视频开关，这一段正文仍是当时那一侧的提示词，
            // 就落当时那一侧的页——图像落绘画页那块现成输入卡，视频走出视频页那条现成预填链
            const landing = media === "video" ? "video" : "image";
            const landingLabel = t(landing === "video" ? "填入视频页" : "填入绘画页");
            const goBtn = $el("button", {
                className: "ns-enhance-btn ns-enhance-acts-btn ns-enhance-go", type: "button",
                title: landingLabel, "aria-label": landingLabel,
            });
            setIcon(goBtn, landing === "video" ? "film" : "image");
            const saveBtn = $el("button", {
                className: "ns-enhance-btn ns-enhance-acts-btn ns-enhance-save", type: "button",
                title: t("保存为预设"), "aria-label": t("保存为预设"),
            });
            setIcon(saveBtn, "save");
            gateRun(saveBtn, "prompt_library_write", t("保存提示词"));
            // 这一行只在正文落定之后出现：流式途中只有文字在长，空产出的那条回话不铺钮
            const acts = $el("div", { className: "ns-enhance-msg-acts", hidden: true }, [copyBtn, goBtn, saveBtn]);
            const revealActs = () => { acts.hidden = !outEl.value.trim(); };
            copyBtn.onclick = async () => {
                const out = outEl.value.trim();
                if (!out) { toast(t("还没有可复制的提示词")); return; }
                try { await navigator.clipboard.writeText(out); }
                catch { actionToast({ severity: "success", summary: t("增强结果"), detail: out }); return; }
                setIcon(copyBtn, "check");
                copyBtn.title = t("已复制");
                setTimeout(() => {
                    setIcon(copyBtn, "copy");
                    copyBtn.title = t("复制提示词");
                }, 1500);
            };
            goBtn.onclick = () => {
                const text = outEl.value.trim();
                if (!text) { toast(t("还没有可填入的提示词")); return; }
                applyToPage(landing, text);
            };
            saveBtn.onclick = async () => {
                const text = outEl.value.trim();
                if (!text) { toast(t("还没有可保存的提示词")); return; }
                // 提示词库写侧归内核：这道门在取名之前，离线那一发不白跑一次 LLM
                if (!can("prompt_library_write")) { toast(t("保存提示词需要 ComfyUI 运行")); return; }
                saveBtn.disabled = true;
                try {
                    // 标题自动生成：后端那一发从正文取名，它没给就用正文首行前 24 字（存预设不许空名）
                    const name = (await extractTitle(text))?.title || text.split("\n")[0].slice(0, 24);
                    const saved = await savePromptTo(media, name, text);
                    toast(tf("已存入提示词库：{name}", { name: saved }));
                } catch (e) {
                    toast(String(e?.message || e));   // 写侧离线与空正文都由抛出的那句说清
                } finally {
                    saveBtn.disabled = false;
                }
            };
            const box = $el("div", { className: "ns-enhance-msg ns-enhance-msg-ai" }, [
                $el("div", { className: "ns-enhance-msg-meta" }, [
                    $el("span", { className: "ns-enhance-msg-skill", textContent: skillLabel() }),
                    $el("span", { textContent: depthLabel() }),
                    // 会话里攒了回话就说清这一发垫了几条，空会话不铺这一句
                    histCount ? $el("span", { textContent: tf("带 {n} 条历史", { n: histCount }) }) : null,
                ]),
                outEl,
                acts,
            ]);
            return { el: box, outEl, revealActs };
        };

        // 会话就攒在这一页的闭包里：每一发的输入与落定的回话依次进队，下一发默认整份垫在正文前面。
        // 视图常驻（studio-app.js 的 ensureView），切页回来这一摞还在；「新增会话」清空它，页面不重建
        const convo = [];
        let runCtl = null;    // 在途那一发：{ text, refs, outEl, msg, handlers }，停止时按它把已落的正文接进会话
        const pushConvo = (role, text, refs = 0) => {
            const body = (text || "").trim();
            if (role === "assistant" && !body) return;   // 空产出不留一条空回话
            convo.push({ role, text: body.slice(0, HISTORY_CHAR_CAP), refs });
            if (convo.length > HISTORY_PAIRS * 2) convo.splice(0, convo.length - HISTORY_PAIRS * 2);
        };

        // 运行中这枚钮就是「停止」本身：不 disable，按下去断流（换面口径同智能体面板那颗）
        const setRunFace = (busy) => {
            setIconLabel(runBtn, busy ? "cross" : "send", t(busy ? "停止" : "增强"));
            runBtn.title = t(busy ? "停止" : "增强");
        };

        const run = async () => {
            const text = promptEl.value.trim();
            const images = refSources();
            if (!text && !images.length) {
                toast(t("先写一句描述，或附一张参考图"));
                return;
            }
            const seq = ++runSeq;
            const skillId = skillSel.value || "";
            // 视频模式没有后端自选那一发：空 skillId 在 studio/llm.py 只认图像侧（带图走反推、不带图走默认增强），
            // 这一页不装成「模型会自己挑视频词」，没有可用的视频增强技能就挡在原地
            if (media === "video" && !skillId) {
                toast(t("先选一个视频提示词增强技能：技能管理里新建，分类选「视频提示词增强」"));
                return;
            }
            const refs = refSnap();
            const msg = aiMsg(convo.length);
            guide.hidden = true;   // 舞台上有话了，起手引导收掉
            stage.append(userMsg(text, refs), msg.el);
            toBottom();
            const outEl = msg.outEl;
            statusEl.textContent = t("增强中…");
            lineEl.hidden = true;   // 输入卡上方那一行：这一发先清空，思考与流程的话由处理器写进来
            setRunFace(true);
            abort = new AbortController();
            // 收场把这一发接进会话（完成 / 失败 / 停止三条收场都算一轮）：seq 对不上就是被
            // 停止作废掉的那一发，迟到帧不进会话，会话里的那一发由停止当场写进去
            const keep = () => {
                if (seq !== runSeq) return;
                pushConvo("user", text, refs.length);
                pushConvo("assistant", outEl.value.trim());
                runCtl = null;
            };
            // 正文上屏 + 一行状态位由这份处理器管（与节点面板同一份实现；传了 lineEl 就不铺思考面板）；
            // 点停止与重跑之后在途的那一条流只丢字，不再上屏（seq 对不上就不落）
            const handlers = createStreamOutputHandlers({
                textarea: outEl,
                lineEl: lineEl,
                onDone: () => {
                    keep();
                    msg.revealActs();   // 正文落定了，复制与保存这两枚才出现
                    abort = null;
                    statusEl.textContent = outEl.value.trim()
                        ? t("已生成，可复制或存为预设") : t("这一发没有产出内容");
                    setRunFace(false);
                    toBottom();
                },
                onError: (err) => {
                    const failText = String(err?.message || err);
                    statusEl.textContent = failText;
                    // 选了技能就把「去技能详情页修」给到手；没选技能就是 LLM 本身的事，引导去 LLM 设置
                    actionToast({
                        severity: "error",
                        summary: skillId ? t("技能执行失败") : t("LLM 处理失败"),
                        detail: failText,
                        actionLabel: skillId ? t("查看技能详情") : t("打开 LLM 设置"),
                        onAction: () => (skillId ? openSkillDetailById(skillId) : openLLMSettingsModal()),
                    });
                    keep();
                    msg.revealActs();
                    abort = null;
                    setRunFace(false);
                },
            });
            runCtl = { text, refs: refs.length, outEl, msg, handlers };
            sseStream(ENHANCE_API, {
                signal: abort.signal,
                onChunk: handlers.onChunk,
                onDone: () => { if (seq === runSeq) handlers.onDone(); },
                onError: (e) => { if (seq === runSeq) handlers.onError(e); },
            }, enhancePayload({
                text: joinPromptText(historyBlock(convo), text),
                skillId,
                depth: depthSel.value,
                images,
            }));
        };
        runBtn.onclick = () => {
            if (abort) {
                // 停止：断流 + 作废在途那一发的迟到帧，已落的正文留着并连着输入一起进会话
                const cur = runCtl;
                abort.abort();
                abort = null;
                runSeq++;
                statusEl.textContent = t("已停止");
                setRunFace(false);
                if (!cur) return;
                cur.handlers.flush();   // 在途的合并帧先落进正文框，留下的正文才算得全
                cur.msg.revealActs();   // 已落的正文也能复制、能存
                pushConvo("user", cur.text, cur.refs);
                pushConvo("assistant", cur.outEl.value.trim());
                runCtl = null;
                return;
            }
            run();
        };
        newBtn.onclick = () => {
            abort?.abort();
            abort = null;
            runSeq++;
            runCtl = null;
            convo.length = 0;
            guide.hidden = false;   // 舞台空了，起手引导回到中间
            stage.replaceChildren(guide);
            statusEl.textContent = "";
            lineEl.hidden = true;   // 断在途的流：输入卡上方那行思考的话也跟着收掉
            setRunFace(false);
            toast(t("已开新会话"));
        };

        promptEl.addEventListener("paste", onPaste);
        // 聊天惯例：Enter 发送、Shift+Enter 换行；停止走同一枚钮
        promptEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runBtn.click(); }
        });
        card.addEventListener("dragover", (e) => e.preventDefault());
        card.addEventListener("drop", (e) => {
            e.preventDefault();
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length) { addFiles(files); return; }
            const cardItem = galleryCardFromDrop(e);   // 从素材库拖进来的卡片落在输入卡任意处都收
            if (cardItem) addGalleryPicks([cardItem]);
        });

        el.append(bar, $el("div", { className: "ns-enhance-page" }, [stage, dock]));
        await loadSkills();
    };
}

/** 思考深度的持久化与 NeoPromptAgent 节点共用同一把 localStorage 键：一处调档，两处同档 */
function loadDepth() {
    try {
        const saved = localStorage.getItem("rs.thinking_depth");
        return THINKING_DEPTHS.includes(saved) ? saved : "medium";
    } catch { return "medium"; }   // 隐私模式下 localStorage 不可用：回落默认档
}

/** 图像 / 视频模式的持久化：切页回来、下次开窗口还是同一池，与思考深度同一把 localStorage 口径 */
function loadMode() {
    try {
        const saved = localStorage.getItem("rs.enhance.media");
        return ENHANCE_MODES.includes(saved) ? saved : "image";
    } catch { return "image"; }
}

/** 从素材库拖出来的卡片写在 dataTransfer 里是一行 JSON（带 filename）：本地文件走 files 那一条，认不出来的整发丢 */
function galleryCardFromDrop(e) {
    const raw = e?.dataTransfer?.getData("text/plain") || e?.dataTransfer?.getData("application/json");
    if (!raw) return null;
    try {
        const item = JSON.parse(raw);
        return item?.filename ? item : null;
    } catch { return null; }
}
