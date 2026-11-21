// LLM 族：文本增强与图片反推（POST 一条 SSE，正文逐段上屏，成文写进连过来的空提示词节点）、文字故事板
// （一发非流式的导演段生成链，成文按连线顺序写进车厢，段长落进配方）。在途那一发都挂在运行态的 llmRuns
// 上 —— 取消与切画布的脱手共用同一条收场。
import { t, tf } from "../../../js/core/i18n.js";
import { ratioGlyph } from "../../../gen-utils.js";
import { ENHANCE_API, enhancePayload } from "../../../prompt-enhance/prompt-enhance.js";
import { REVERSE_API, REVERSE_LANGS, reverseRequestBody } from "../../../reverse-prompt/reverse-prompt.js";
import { STORYBOARD_API, SEG_SEC_DEFAULT, storyboardCarPatches, storyboardDurationWrites, storyboardError,
    storyboardMismatchText, storyboardRequestBody, storyboardSegments } from "../../storyboard/storyboard.js";
import { skillDisplayName } from "../../../skill.js";
import { RUN_LABELS, gateOf, runKind, upstreamNodes } from "./node-types.js";
import { SEG_SEC_MAX, SEG_SEC_MIN, readGenParams, readRecipeParams } from "./gen-params.js";
import { chainRecipe, genInputs, reverseFirstImage } from "./gen-graph.js";

/** 增强 / 反推 / 故事板三条链 + 三张卡的面。
 *  `hooks.run` / `hooks.cancel` 是装配层的分发；`recipe.writeSegmentDuration` 是配方族那一发（装配层接线） */
export function createCanvasLlm({ $el, host, toast, api, canFeature, runs, catalog, ctl, hooks, recipe }) {
    const { running, setRunning, llmRuns } = runs;
    const { enhanceSkills, primeCfg } = catalog;
    const { genBtn, genChip } = ctl;
/** SSE 帧体 → 帧对象：非 JSON 的帧（心跳、注释行）交 null，读流那一条不收它当正文 */
function llmFrame(data) {
    try { return JSON.parse(data); } catch { return null; }
}

    /** 增强与反推共用的闸门：停用的那一张不跑；这一发在跑就不重复提交；能力位缺了说去哪儿启。
     *  两条链都在桌面端自服的能力表上（prompt_enhance / prompt_reverse），离线窗口照跑 ——
     *  要的是本机配好 LLM，不是执行队列 */
    function llmGate(node) {
        const stop = gateOf(node, { running: running.has(node.id), canFeature });
        if (stop) {
            if (stop.msg) toast(stop.msg, stop.level);
            return true;
        }
        return false;
    }

    /** LLM 流的帧 → 正文增量：思考块不进正文（画布要落的是提示词，不是模型的思考过程）；失败走
     *  [ERROR] 前缀帧与写进正文块里的 [ERROR] 两种（与 prompt-service 读流那一条同一口径）——
     *  这一发没有状态码可查，不在这里抛就只剩一个空正文 */
    async function readLlmText(resp, onProgress) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        let buf = "";
        const fail = (msg) => new Error(msg || t("LLM 链失败"));
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (data === "[DONE]") return acc;
                if (data.startsWith("[ERROR]")) throw fail(data.slice(7).trim());
                const frame = llmFrame(data);
                if (!frame || frame.kind === "thinking") continue;   // 心跳与非 JSON 帧照收不下屏
                if (typeof frame.text !== "string") continue;
                if (frame.text.startsWith("[ERROR]")) throw fail(frame.text.slice(7).trim());
                acc += frame.text;
                onProgress(acc);
            }
        }
        return acc;
    }

    /** 一发 LLM 链（增强 / 反推）：POST 一条 SSE，正文逐段落进状态行那一串字数，成文交 applyText
     *  写进下游空的提示词节点。取消走 AbortController（cancel 里按节点摘这一发）；切画布与卸页交
     *  stopAll 脱手 —— 在途的正文不落这一张画布 */
    function submitLlmRun(node, path, body, run) {
        const inflight = { abort: new AbortController(), stopped: false };
        llmRuns.set(node.id, inflight);
        setRunning(node.id, { kind: run.kind, status: "running", done: 0, total: 0, error: "" });
        let shown = 0;
        api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body), signal: inflight.abort.signal })
            .then(async (resp) => {
                // 状态码先判，正文一消费就读不了流：失败那一格的提示只在这一条里取 json（prompt-service 同一读流法）
                if (!resp.ok) {
                    const data = await resp.json().catch(() => null);
                    throw new Error(data?.error || `HTTP ${resp.status}`);
                }
                const text = await readLlmText(resp, (acc) => {
                    // 每 40 字报一次进度：逐 token 整层重画会把节点上的打字与拖动全卡住
                    if (acc.length - shown < 40) return;
                    shown = acc.length;
                    if (running.has(node.id)) setRunning(node.id, { done: acc.length });
                });
                if (inflight.stopped || inflight.abort.signal.aborted) {
                    // 取消时流自己断（reader 直接 done）：在途的半截正文不落这一张画布
                    if (llmRuns.get(node.id) === inflight) finishLlmCancel(node, inflight, run);
                    return;
                }
                llmRuns.delete(node.id);
                if (!text.trim()) throw new Error(t("后端没有回正文"));
                running.delete(node.id);
                if (!host.hasNode(node.id)) { toast(t("提示词已生成"), "success"); return; }
                host.applyText(node.id, text.trim());
                toast(t(run.done), "success");
            })
            .catch((err) => {
                const fell = llmRuns.get(node.id) !== inflight;   // 脱手与取消：这一发不再改这一张画布上的状态
                llmRuns.delete(node.id);
                if (fell) return;
                if (err?.name === "AbortError" || inflight.stopped) {
                    finishLlmCancel(node, inflight, run);
                    return;
                }
                running.set(node.id, { kind: run.kind, status: "failed", error: String(err?.message || err) });
                host.paintNodes();
                toast(`${t(run.fail)}：${String(err?.message || err)}`, "error");
            });
    }

    /** 取消那一发的收场：摘状态、整层重画、说一句「已取消」—— 已摘掉这一发的（脱手）不再说话 */
    function finishLlmCancel(node, inflight, run) {
        if (llmRuns.get(node.id) !== inflight) return;
        llmRuns.delete(node.id);
        running.delete(node.id);
        host.paintNodes();
        toast(t(run.cancelled), "info");
    }

    /** 增强节点：连过来的正文按连线顺序拼一条送进那条增强链（技能留空 = 后端按输入智能挑一条），
     *  成文落下游提示词节点 —— 与首页「提示词增强」页是同一条接口 */
    function runEnhance(node) {
        if (llmGate(node)) return;
        const { prompts } = genInputs(host.getState(), node.id);
        if (!prompts.length) { toast(t("把要增强的提示词节点连过来"), "info"); return; }
        submitLlmRun(node, ENHANCE_API,
            enhancePayload({ text: prompts.join("\n\n"), skillId: String(node.metadata.skill_id || "") }),
            RUN_LABELS.enhance);
    }

    /** 反推节点：连线顺序里第一张图进请求（素材库那三元组，与素材卡 ⋯ 反推同一份），成文落下游
     *  提示词节点。配方素材（只有 asset 没有 filename）后端认不到，跑之前就说清楚 */
    function runReverse(node) {
        if (llmGate(node)) return;
        const src = reverseFirstImage(host.getState(), node.id);
        if (!src) { toast(t("把要反推的那一张图片节点连过来"), "info"); return; }
        const filename = String(src.metadata?.filename || "");
        if (!filename) { toast(t("反推只吃素材库里的图：连一张带素材路径的图片节点过来"), "info"); return; }
        submitLlmRun(node, REVERSE_API,
            reverseRequestBody({ filename, subfolder: String(src.metadata?.subfolder || "") },
                node.metadata.language === "en" ? "en" : "zh"),
            RUN_LABELS.reverse);
    }

    /** 文字故事板节点那一发：主题或整篇剧本就在这一张的正文里，每一段的时长由卡上那枚数框定；
     *  成文按连线顺序写进连过来的车厢，段时长写进车厢所属配方那一段（配方名读车厢身上那一份）。
     *  这一发走的是后端既有的导演段生成链，与导演页「从一段话生成每一段」同一发，配方一个字都不写 */
    function runStoryboard(node) {
        if (llmGate(node)) return;
        const text = String(node.metadata.content || "").trim();
        if (!text) { toast(t("在这张节点上写一段话：一个主题或整篇剧本"), "info"); return; }
        const cars = upstreamNodes(host.getState(), node.id, ["recipe"]);
        if (!cars.length) { toast(t("把要写的那几厢车厢连过来：按连线顺序一厢一段"), "info"); return; }
        const run = RUN_LABELS.storyboard;
        submitJsonRun(node, STORYBOARD_API,
            storyboardRequestBody({ text, segmentSeconds: node.metadata.segment_seconds }),
            run, (data) => applyStoryboard(node, cars, data, run));
    }

    /** 一发非流式的后端链（文字故事板）：在途那一发照 LLM 那一条的记法挂在 llmRuns 上 —— 取消与切画布
     *  的脱手共用那一条收场（finishLlmCancel 认「已摘掉这一发」就不写画布）。成了交 onDone 写回，
     *  败了落在状态行上 */
    function submitJsonRun(node, path, body, run, onDone) {
        const inflight = { abort: new AbortController(), stopped: false };
        llmRuns.set(node.id, inflight);
        setRunning(node.id, { kind: run.kind, status: "running", done: 0, total: 0, error: "" });
        api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body), signal: inflight.abort.signal })
            .then(async (resp) => {
                const data = await resp.json().catch(() => null);
                // 状态码先判：后端在缺 LLM 与正文为空时回的是 {ok:false, error}，那一格的 reason 要说给用户
                if (!resp.ok) throw data?.error ? storyboardError(data) : new Error(`HTTP ${resp.status}`);
                if (inflight.stopped || inflight.abort.signal.aborted) {
                    if (llmRuns.get(node.id) === inflight) finishLlmCancel(node, inflight, run);
                    return;
                }
                llmRuns.delete(node.id);
                onDone(data);
            })
            .catch((err) => {
                const fell = llmRuns.get(node.id) !== inflight;   // 脱手与取消：这一发不再改这一张画布上的状态
                llmRuns.delete(node.id);
                if (fell) return;
                if (err?.name === "AbortError" || inflight.stopped) {
                    finishLlmCancel(node, inflight, run);
                    return;
                }
                running.set(node.id, { kind: run.kind, status: "failed", error: String(err?.message || err) });
                host.paintNodes();
                toast(`${t(run.fail)}：${String(err?.message || err)}`, "error");
            });
    }

    /** 成文落画布：段提示词按连线顺序写进车厢（一格一发的 patchMeta，进撤销栈、随画布落盘），生成的那一段
     *  列表记在故事板节点自己的 metadata 上 —— 复制、撤销与存盘都带着走。段时长只有车厢记着配方名时
     *  才有落点（手工铺的车厢没有配方，段时长就没有地方落） */
    function applyStoryboard(node, cars, data, run) {
        const segments = storyboardSegments(data);
        if (!segments) {
            const msg = String(data?.error || t("后端没有回段列表"));
            running.set(node.id, { kind: run.kind, status: "failed", error: msg });
            host.paintNodes();
            toast(`${t(run.failToast)}：${msg}`, "error");
            return;
        }
        running.delete(node.id);
        if (!host.hasNode(node.id)) { toast(t("段提示词已生成"), "success"); return; }   // 切画布脱手与节点被删
        const live = cars.filter((car) => host.hasNode(car.id));
        const patches = storyboardCarPatches(segments, live);
        host.patchMeta(node.id, { segments, segments_at: Date.now() });
        for (const p of patches) host.patchMeta(p.node.id, p.meta);
        for (const w of storyboardDurationWrites(patches, chainRecipe(live))) recipe.writeSegmentDuration(w);
        host.paintNodes();
        const note = storyboardMismatchText(segments.length, live.length);
        if (note) toast(note, "info");
        toast(tf(run.done, { n: patches.length }), "success");
    }

    /** 增强 / 反推节点上的控件：一枚技能（增强）或语言（反推）胶囊 + 运行钮一行 —— 要重写的正文与
     *  要反推的那一张都不在这张节点上，从连过来的节点取（见 runEnhance 与 runReverse） */
    function llmControls(node) {
        const st = running.get(node.id) || {};
        const busy = st.status === "running";
        const isReverse = node.type === "reverse";
        const run = RUN_LABELS[runKind(node)];
        const acts = [];
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => hooks.cancel(node), t("取消这一发后台任务")));
        acts.push(genBtn(t(run.btn), "play", () => (isReverse ? runReverse(node) : runEnhance(node)),
            t(run.tip), busy, "ns-canvas-gen-go"));
        return [
            $el("div", { className: "ns-canvas-gen-skill" }, [isReverse ? reverseLangChip(node, busy) : enhanceSkillChip(node, busy)]),
            $el("div", { className: "ns-canvas-gen-bottom" }, [$el("div", { className: "ns-canvas-gen-acts" }, acts)]),
        ];
    }

    /** 文字故事板节点上的控件：每一段的时长（进这一发的 segment_seconds，边界与后端同一份）与那一枚运行钮。
     *  要写的那一段话就在这张节点上（与车厢自己写正文同一份存法），不从连过来的节点取 */
    function storyboardControls(node) {
        const st = running.get(node.id) || {};
        const busy = st.status === "running";
        const run = RUN_LABELS.storyboard;
        const acts = [];
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => hooks.cancel(node), t("取消这一发后台任务")));
        acts.push(genBtn(t(run.btn), "play", () => runStoryboard(node), t(run.tip), busy, "ns-canvas-gen-go"));
        // 每一段的时长就是一枚数框（与车厢顶行那一枚同一法，步进箭头去掉）：写歪了钳进后端认的那一份区间
        const sec = $el("input", { className: "ns-canvas-storyboard-sec", type: "number",
            min: String(SEG_SEC_MIN), max: String(SEG_SEC_MAX), step: "1",
            value: String(Number(node.metadata.segment_seconds) || SEG_SEC_DEFAULT),
            title: t("每一段的时长（秒）：交后端按这一发拆段"),
            onmousedown: (e) => { if (document.activeElement !== e.target) e.preventDefault(); },
            onchange: () => host.patchMeta(node.id, {
                segment_seconds: Math.min(SEG_SEC_MAX, Math.max(SEG_SEC_MIN,
                    Math.round(Number(sec.value)) || SEG_SEC_DEFAULT)) }) });
        sec.disabled = busy;
        return [$el("div", { className: "ns-canvas-gen-acts" }, [
            $el("span", { className: "ns-canvas-storyboard-sec-label", textContent: t("每段") }),
            sec, ...acts,
        ])];
    }

    /** 反推节点上的语言胶囊：与反推页和素材卡反推同一对取值（后端认 zh / en） */
    function reverseLangChip(node, busy) {
        const sel = $el("select", { disabled: busy, title: t("反推输出的语言"),
            onchange: () => host.patchMeta(node.id, { language: sel.value }) });
        for (const { value, label } of REVERSE_LANGS) sel.append($el("option", { value, textContent: label }));
        sel.value = node.metadata.language === "en" ? "en" : "zh";
        return genChip(sel, { icon: "list" });
    }

    /** 增强节点上的技能胶囊：列表里留空那一档就是「后端智能判断」（带图走反推、不带图走默认增强），
     *  与首页「提示词增强」页的技能那一枚同一口径；技能被删了、列表没取到时把存的这一个也列出来 */
    function enhanceSkillChip(node, busy) {
        const saved = String(node.metadata.skill_id || "");
        const sel = $el("select", { disabled: busy, title: t("增强用哪一条技能：留空 = 后端按输入智能判断"),
            onchange: () => host.patchMeta(node.id, { skill_id: sel.value }) });
        sel.append($el("option", { value: "", textContent: t("智能判断") }));
        for (const s of enhanceSkills.rows) sel.append($el("option", { value: s.id, textContent: skillDisplayName(s) }));
        sel.value = saved;
        if (sel.value !== saved && saved) {
            sel.value = "";
            sel.appendChild($el("option", { value: saved, textContent: saved, disabled: true, selected: true }));
        }
        return genChip(sel, { icon: "sparkles" });
    }

    return { runEnhance, runReverse, runStoryboard, llmControls, storyboardControls };
}
