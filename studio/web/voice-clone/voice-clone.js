/**
 * voice-clone.js — 「声音克隆」页宿主（Studio 视图）：一段参考音频 + 要说的文字，出同一个人的音色。
 *
 * 生成链与音频卡片 ⋯ 菜单那条同源（voice-gen.js）：参考音频经 copy_to_input 落 input/ 当
 * {{REF_AUDIO_1}}，文字走 {{PROMPT}}，产物由 SaveAudio 落 Output/Voice。进度认后端推的事件
 * （rs.voice_gen.status）而不是轮询 HTTP。首页「开始创作」板块的入口卡是这页唯一的来路
 * （顶栏没有这一枚页签）；生成要吃执行队列，离线时按钮交运行闸门。
 */
import { t } from "../js/core/i18n.js";
import { icon, setIconLabel } from "../js/core/icons.js";
import { getAudioSrc } from "../gallery-utils.js";
import { voiceAudioWidget } from "../gallery-card-tools.js";
import { copyImageToInput } from "../gen-utils.js";
import { buildVoiceRequest, requestVoiceGeneration, watchVoiceTask, cancelVoiceTask, VOICE_SKILL_ID } from "../voice-gen.js";
import { getSkillGenConfig } from "../image-gen.js";
import { openGallerySidebar } from "../media-transfer.js";

// 与 studio/voice_gen.py 的 OUTPUT_DIR 同值：结果区那句提示与「打开输出目录」都认这一位
export const VOICE_OUT_DIR = "Voice";

// 组件样式在第一次建视图时注入（幂等）：本模块也会被主画布页的扩展图加载，
// 放在模块顶层会让画布为一份用不上的样式表发一次请求。
function ensureCss() {
    if (document.getElementById("neo-voice-css")) return;
    const link = document.createElement("link");
    link.id = "neo-voice-css";
    link.rel = "stylesheet";
    link.href = "/extensions/comfyui-neo-studio/voice-clone/voice-clone.css";
    document.head.appendChild(link);
}

/** 任务快照 → 进度读数：后端只报 queued / running / 终态，界面把它说成人在看的那两句 */
export function voiceStatusLabel(status) {
    return status === "running" ? t("合成中…") : t("排队中…");
}

/** 进度快照 → 进度条宽度（%）：没有步数的阶段给 0，由样式那侧走不定长条 */
export function voiceProgressPct(progress) {
    const max = Number(progress?.max) || 0;
    if (max <= 0) return 0;
    return Math.max(0, Math.min(100, (Number(progress.value) / max) * 100));
}

/**
 * 建「声音克隆」视图。依赖由宿主注入：openMaterial 打开素材库弹窗取一段参考音频，
 * gateRun 把「生成」交运行闸门（生成要吃执行队列，桌面端离线时点它是引导启动 ComfyUI，不发假请求）。
 */
export function createVoiceCloneView({ $el, openMaterial, gateRun }) {
    return async function buildVoiceClone(el) {
        ensureCss();
        el.classList.add("ns-voice");
        let source = null;    // {filename, subfolder, label} —— null 时整页是起手卡片
        let refName = "";     // copy_to_input 落进 input/ 的那一份名字：换音频就要重拷
        let cancelId = null;
        let cancelRequested = false;
        let running = false;
        const widgets = [];   // 页上的波形控件各带一台自己的播放器
        const stopAudio = () => { for (const w of widgets) w._stop?.(); };
        const dropAudio = () => { stopAudio(); widgets.length = 0; };

        const btn = (label, iconKey, extra = "") => {
            const b = $el("button", { className: "ns-voice-btn" + extra, type: "button" });
            setIconLabel(b, iconKey, t(label));
            return b;
        };

        const pickBtn = btn("从素材库选音频", "folder", " ns-voice-btn-primary");
        const switchBtn = btn("换音频", "cross");
        const runBtn = btn("生成", "volume", " ns-voice-run ns-voice-btn-primary");
        const cancelBtn = btn("取消任务", "cross");
        const openBtn = btn("打开输出目录", "folder");
        const textInput = $el("textarea", {
            className: "ns-voice-text",
            rows: "4",
            placeholder: t("要说的文字（用参考音频的音色朗读）……"),
        });
        const sourcePill = $el("span", { className: "ns-voice-pill", textContent: t("没有音频") });
        const refWave = $el("div", { className: "ns-voice-ref" });
        const fillEl = $el("div", { className: "ns-voice-fill" });
        const track = $el("div", { className: "ns-voice-track", hidden: true }, [fillEl]);
        const status = $el("div", { className: "ns-voice-status", textContent: t("写下要说的文字，点「生成」") });
        const resultBox = $el("div", { className: "ns-voice-result" });

        const topBar = $el("div", { className: "ns-voice-bar" }, [
            $el("span", { className: "ns-voice-bar-title" }, [icon("volume", 18), t("声音克隆")]),
            sourcePill,
            $el("span", { className: "ns-voice-sep" }),
            switchBtn,
            runBtn,
        ]);
        const actions = $el("div", { className: "ns-voice-actions" }, [cancelBtn, openBtn]);
        const composer = $el("section", { className: "ns-voice-composer" }, [
            $el("div", { className: "ns-voice-head" }, [t("参考音频")]),
            refWave,
            textInput,
            track,
            status,
            resultBox,
            actions,
        ]);
        const empty = $el("div", { className: "ns-voice-empty" }, [
            $el("h3", { textContent: t("声音克隆") }),
            $el("p", { textContent: t("挑一段参考音频，写下要说的文字：用那段声音的音色读出来，产物落在素材库的 Voice 目录") }),
            $el("div", { className: "ns-voice-row" }, [pickBtn]),
        ]);
        const main = $el("div", { className: "ns-voice-main" }, [composer, empty]);
        el.append(topBar, main);
        cancelBtn.hidden = true;
        openBtn.hidden = true;

        const paintChrome = () => {
            composer.hidden = !source;
            empty.hidden = !!source;
            sourcePill.textContent = source ? source.label : t("没有音频");
            switchBtn.disabled = !source || running;
            runBtn.disabled = !source || running;
        };
        const paintProgress = (label, progress) => {
            const pct = voiceProgressPct(progress);
            track.hidden = false;
            fillEl.style.width = pct ? `${pct}%` : "";
            // 没有步数的那一段（排队、模型加载）让条自己走，不装作停在 0% 不动
            fillEl.classList.toggle("is-loose", !pct);
            status.textContent = label;
            cancelBtn.hidden = false;
        };
        const endProgress = () => {
            track.hidden = true;
            cancelBtn.hidden = true;
            fillEl.style.width = "";
            fillEl.classList.remove("is-loose");
        };

        const pick = () => openMaterial((picked) => {
            const item = Array.isArray(picked) ? picked[0] : picked;
            if (!item?.filename) return;
            source = {
                filename: item.filename,
                subfolder: item.subfolder || "",
                label: (item.subfolder ? `${item.subfolder}/` : "") + item.filename,
            };
            refName = "";   // 换音频 = 重拷一份参考，input/ 里旧那份不再作数
            dropAudio();
            resultBox.textContent = "";
            status.textContent = t("写下要说的文字，点「生成」");
            endProgress();
            const w = voiceAudioWidget(getAudioSrc({ filename: source.filename }, source.subfolder), source.filename);
            widgets.push(w);
            refWave.replaceChildren(w);
            // 预填与素材卡语音弹窗同一份来源（技能 config.json 的 default_prompt）：空着才填，用户写过的字不动
            if (!textInput.value.trim()) {
                getSkillGenConfig(VOICE_SKILL_ID).then((cfg) => {
                    if (!textInput.value.trim()) textInput.value = cfg?.default_prompt || "";
                });
            }
            paintChrome();
        });
        pickBtn.onclick = pick;
        switchBtn.onclick = pick;

        const paintSuccess = (final) => {
            resultBox.textContent = "";
            (final.audios || []).forEach((a) => {
                const w = voiceAudioWidget(a.url, a.filename);
                widgets.push(w);
                resultBox.appendChild(w);
            });
            status.textContent = t("已生成语音，点波形播放试听；产物在 Output/Voice");
            openBtn.hidden = false;
        };

        const start = async () => {
            if (running || !source) return;
            const text = textInput.value.trim();
            if (!text) { status.textContent = t("请先输入要说的文字"); return; }
            running = true;
            cancelRequested = false;
            openBtn.hidden = true;
            resultBox.textContent = "";
            dropAudio();   // 上一段的参考波形继续放着会让人以为结果已出
            paintChrome();
            paintProgress(t("排队中…"));
            try {
                refName = refName || await copyImageToInput({ filename: source.filename }, source.subfolder);
                const snap = await requestVoiceGeneration(buildVoiceRequest(refName, text));
                cancelId = snap.task_id;
                const final = await watchVoiceTask(
                    snap.task_id,
                    (s) => paintProgress(voiceStatusLabel(s.status), s.progress),
                    () => cancelRequested
                );
                if (final.status === "succeeded") paintSuccess(final);
                else if (final.status === "cancelled") status.textContent = t("已取消");
                else status.textContent = final.error || t("生成失败");
            } catch (e) {
                status.textContent = String(e?.message || e);
            } finally {
                running = false;
                cancelId = null;
                endProgress();
                paintChrome();
            }
        };
        runBtn.onclick = start;
        cancelBtn.onclick = () => {
            cancelRequested = true;
            if (cancelId) cancelVoiceTask(cancelId);
        };
        openBtn.onclick = () => openGallerySidebar(VOICE_OUT_DIR, []);

        gateRun(runBtn, "voice", t("生成"));
        paintChrome();
        // 窗口收起时停掉本页播放器：波形控件攥着整段解码，窗口关了它还在
        window.addEventListener("pagehide", stopAudio);

    };
}

