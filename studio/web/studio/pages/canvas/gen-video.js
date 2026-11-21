// 出片族：视频生成节点那一条链（POST /neo_video_gen/simple 加每一段的轮询快照 —— 这一条链只有出片模式
// 进这条链，串联的每一段走配方族那一发）+ 出片节点卡上的面。轮询的表（timers）与脱手那一档（detached）
// 都在运行态那一层：切画布与卸页交 stopAll 脱手，成片落在 Output 目录里不再写回旧画布。
import { t, tf } from "../../../js/core/i18n.js";
import { ratioGlyph, VIDEO_DUR_CHOICES, VIDEO_SIZE_CHOICES } from "../../../gen-utils.js";
import { MEDIA_CAPS, REF_KIND_NAMES } from "../../../js/core/media-slot.js";
import { gateOf, RUN_LABELS } from "./node-types.js";
import { mergeGenOverrides, readGenOverrides, readGenParams } from "./gen-params.js";
import { REF_BUCKETS, genInputs, mediaNodes } from "./gen-graph.js";

const CLIP_TERMINAL = ["succeeded", "failed", "cancelled"];
const CLIP_POLL_MS = 1000;        // 简单视频与单段任务只有轮询快照：画布就在眼前，进度比出视频页那一格更快

/** 出片那一条链 + 出片节点的面。`hooks.run` / `hooks.cancel` 是装配层的分发；`chainStep` 是串联推进下一段
 *  那一发（长在配方族里，装配层接线）—— 每一段轮询到终态交它推进下一段 */
export function createCanvasVideo({ $el, host, toast, api, canFeature, modeGroup, runs, catalog, ctl,
    hooks, chainStep }) {
    const { running, detached, timers, setRunning, labelsOf, detachTask } = runs;
    const { skills, videoSkills, defaultVideoSkillId, videoSkillName } = catalog;
    const { genBtn, genChip, genParamsChip } = ctl;
    /** 一轮任务快照（简单视频 / 配方单段都是轮询链）：进度写回节点，终态收摊并写回画布。
     *  提交完立刻先拉一格（与 watchTask 的兜底首拉同一套做法），节点上那行状态不用等一秒才有字 */
    function startClipPoll(kind, taskId, nodeId) {
        const path = kind === "video" ? `/neo_video_gen/simple/${taskId}` : `/neo_video_gen/run_segment/${taskId}`;
        const tick = async () => {
            let snap = null;
            try {
                const resp = await api.fetchApi(path);
                snap = await resp.json();
            } catch { return; }   // 网络抖动忽略，下一轮再问
            if (!snap?.success) {
                stopClipPoll(taskId);
                clipFinish(nodeId, { ...snap, task_id: taskId, status: "failed",
                    error: snap?.error || t("状态查询失败") });
                return;
            }
            if (CLIP_TERMINAL.includes(snap.status)) {
                stopClipPoll(taskId);
                clipFinish(nodeId, snap);
                return;
            }
            const cur = running.get(nodeId);
            if (!cur) return;   // 脱手的那一发不在这一张画布上，进度不写它
            const p = snap.progress;
            setRunning(nodeId, { status: snap.status,
                done: p ? Number(p.value) || 0 : 0, total: p ? Number(p.max) || 0 : 0 });
        };
        timers.set(taskId, setInterval(tick, CLIP_POLL_MS));
        tick();
    }

    function stopClipPoll(taskId) {
        const timer = timers.get(taskId);
        if (timer) clearInterval(timer);
        timers.delete(taskId);
    }

    /** 出片落终态：成片写回下游视频节点。切画布脱手的那一发、以及节点已被删掉的：片就在 Output 目录里，
     *  不往现在这张画布上写 */
    function clipFinish(nodeId, snap) {
        chainStep(nodeId);   // 串联里的一段收摊：车尾那一行跟着走进度
        const fell = detached.delete(snap.task_id);
        const labels = labelsOf(nodeId);
        if (snap.status === "succeeded") {
            running.delete(nodeId);
            host.paintNodes();
            if (fell || !host.hasNode(nodeId)) { toast(t(labels.fell), "success"); return; }
            host.applyResult(nodeId, snap.filename
                ? [{ filename: snap.filename, subfolder: snap.subfolder || "" }] : [], "video");
            toast(t(labels.done), "success");
            return;
        }
        if (snap.status === "cancelled") {
            running.delete(nodeId);
            host.paintNodes();
            toast(t(labels.cancelled), "info");
            return;
        }
        const msg = String(snap.error || "");
        running.set(nodeId, { ...(running.get(nodeId) || {}), status: "failed", error: msg });
        host.paintNodes();
        toast(`${t(labels.failToast)}${msg ? `：${msg}` : ""}`, "error");
    }

    /** 提交一发出片（简单视频 / 配方单段同一条路）：入队成功就挂上轮询，失败把真原因写在节点上 */
    function submitClip(path, body, kind, node) {
        api.fetchApi(path, { method: "POST",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
            .then(async (resp) => {
                const data = await resp.json().catch(() => null);
                if (!resp.ok || !data?.success) throw new Error(data?.error || `HTTP ${resp.status}`);
                setRunning(node.id, { kind, task_id: data.task_id, status: data.status || "queued",
                    done: 0, total: 0, error: "" });
                startClipPoll(kind, data.task_id, node.id);
            })
            .catch((err) => {
                const msg = String(err?.message || err);
                running.set(node.id, { kind, status: "failed", error: msg });
                host.paintNodes();
                toast(`${t(labelsOf(node.id).failToast)}：${msg}`, "error");
            });
    }

    /** 出片的闸门（串联的车尾与视频节点共用，见 node-types.js 的 gateOf）：停用的那一张不跑；这一发在跑
     *  就不重复提交；没有执行队列只说去哪儿启（与出图同一套做法）。车尾与视频节点要的能力位不同（分段 /
     *  简单视频），闸门按节点自己那一发查 */
    function clipGate(node) {
        const stop = gateOf(node, { running: running.has(node.id), canFeature });
        if (stop) {
            if (stop.msg) toast(stop.msg, stop.level);
            return true;
        }
        return false;
    }

    /** 视频节点出片：上游正文拼成提示词，参考按技能那一组归一后交后端（首帧 / 尾帧 / 三桶参考同一份来源）。
     *  图 / 视频 / 音频三类都发，各带 media 交后端按 MiniMaxH3ReferenceToVideo 的槽位分桶取用 */
    function runVideo(node) {
        if (clipGate(node)) return;
        const params = readGenParams(node);
        if (!params.skill_id) { toast(t("先选一个视频技能"), "info"); return; }
        const { prompts, references } = genInputs(host.getState(), node.id);
        const skill = videoSkills.rows.find((s) => s.id === params.skill_id);
        const { refs, last_frame: lastFrame, dropped } = videoRefs(skill, references);
        // 后端对这批技能是硬要求（无首帧的 i2v / 无参考的 r2v 必败），在画布上说清楚比跑完再报错省一整发
        if (skill?.requires_ref && !refs.length) {
            toast(t(modeGroup(skill) === "r2v"
                ? "全参考生视频要参考素材：把图 / 视频 / 音频连到这台节点上"
                : "这一发要参考素材：把一张图连到这台节点上"), "info");
            return;
        }
        if (!prompts.length) { toast(t("接一条文本线过来再出片"), "info"); return; }
        const body = { prompt: prompts.join("\n\n"), skill_id: params.skill_id, references: refs,
            last_frame: lastFrame, duration_sec: params.duration, seed: -1 };
        if (params.width && params.height) { body.width = params.width; body.height = params.height; }
        mergeGenOverrides(body, readGenOverrides(node));   // 这一发自定的模型链 / LoRA / 步数（空 = 后端按技能配置与全局设置合并）
        submitClip("/neo_video_gen/simple", body, "video", node);
    }

    /** 出片那一发交后端的参考：技能属于哪一组决定吃哪几类，连过来的顺序就是交出去的顺序。
     *  图生视频只吃前两张图 —— 第一张进首帧槽、第二张进 last_frame，第三张与视频 / 音频在这一发没有槽位；
     *  全参考生视频吃图 / 视频 / 音频三桶，各类按 H3 槽位上限裁，技能模板没有那一类槽位就整类丢掉
     *  （发过去也只会被后端静默扔，落盘前挡住）；文生视频不吃参考。
     *  dropped 是丢掉素材的那些类别：卡上那一行要说清丢的是哪一类，不然用户只知道「没出来」 */
    function videoRefs(skill, references) {
        const group = modeGroup(skill);
        const slots = skill?.gen_config?.ref_kinds || null;   // 老后端与老技能没这一项 = 不门控
        const of = (kind) => references[REF_BUCKETS[kind]] || [];
        const withMedia = (kind, list) => list.map((r) => ({ ...r, media: kind }));
        const lost = new Set();
        if (group === "f2v") {
            const images = of("image");
            if (images.length > 2) lost.add("image");
            if (of("video").length) lost.add("video");
            if (of("audio").length) lost.add("audio");
            return {
                refs: withMedia("image", images.slice(0, 1)),
                last_frame: images.length > 1 ? withMedia("image", images.slice(1, 2))[0] : null,
                dropped: [...lost],
            };
        }
        if (group === "r2v") {
            const refs = [];
            for (const kind of ["image", "video", "audio"]) {
                const list = of(kind);
                if (!list.length) continue;
                if (slots && !slots.includes(kind)) { lost.add(kind); continue; }
                if (list.length > MEDIA_CAPS[kind]) lost.add(kind);
                refs.push(...withMedia(kind, list.slice(0, MEDIA_CAPS[kind])));
            }
            return { refs, last_frame: null, dropped: [...lost] };
        }
        return { refs: [], last_frame: null, dropped: ["image", "video", "audio"].filter((k) => of(k).length) };
    }

    /** 卡上那一行参考概览：这一发真正交出去的参考按类别计数，后面带上被这一发丢掉的类别 */
    function refsSummaryText(refs, lastFrame, dropped) {
        const n = { image: 0, video: 0, audio: 0 };
        for (const r of refs) n[r.media] += 1;
        if (lastFrame) n.image += 1;
        const kinds = ["image", "video", "audio"].filter((k) => n[k])
            .map((k) => tf("{label} {n}", { label: t(REF_KIND_NAMES[k]), n: n[k] })).join(" · ");
        const lost = dropped.length
            ? tf("（{kinds} 没进）", { kinds: dropped.map((k) => t(REF_KIND_NAMES[k])).join(" · ") })
            : "";
        return kinds ? tf("参考：{kinds}{lost}", { kinds, lost }) : tf("没有参考素材{lost}", { lost });
    }

    /** 视频节点的面：技能与自定参数一枚胶囊，时长与尺寸各一枚，出片与取消在最后一行。时长与尺寸留着「跟随」
     *  —— 空着就按技能 config 与全局生视频设置走，与生图的比例 / 长边同一口径；
     *  参考素材从上游图片节点来，不在节点上再摆一格方块 */
    function videoControls(node, params, busy) {
        const durSel = $el("select", { disabled: busy, title: t("时长"),
            onchange: () => host.patchMeta(node.id, { duration: Number(durSel.value) || 5 }) });
        for (const sec of VIDEO_DUR_CHOICES) {
            durSel.append($el("option", { value: String(sec), textContent: tf("{n} 秒", { n: sec }) }));
        }
        durSel.value = String(params.duration);

        const sizeSel = $el("select", { disabled: busy, title: t("尺寸"),
            onchange: () => {
                const [w, h] = (sizeSel.value || "0,0").split(",").map(Number);
                host.patchMeta(node.id, { width: w || 0, height: h || 0 });
            } });
        sizeSel.append($el("option", { value: "0", textContent: t("跟随尺寸") }));
        for (const [w, h, label] of VIDEO_SIZE_CHOICES) {
            sizeSel.append($el("option", { value: `${w},${h}`, textContent: `${w}×${h} · ${t(label)}` }));
        }
        sizeSel.value = params.width && params.height ? `${params.width},${params.height}` : "0";
        sizeSel.dataset.follow = t("跟随尺寸");   // 空着就是跟随：胶囊上要说「跟随尺寸」，不是那句通用的「默认」

        const labels = RUN_LABELS.video;
        const acts = [];
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => hooks.cancel(node), t("取消这一发后台任务")));
        acts.push(genBtn(t(labels.btn), "play", () => hooks.run(node),
            canFeature(labels.cap) === false ? t(labels.offline) : t(labels.tip), busy));
        // 技能与自定参数就这一枚胶囊：点开左栏换技能、右栏改这一发的模型链 / 步数 / LoRA（出视频页同一枚）
        const skillChip = genParamsChip(node, { icon: "film", isVideo: true, busy });
        // 参考概览那一行：这一发真正交出去的是哪几类素材、被这一发丢掉的是哪一类
        const skill = videoSkills.rows.find((s) => s.id === params.skill_id);
        const { refs, last_frame: lastFrame, dropped } = videoRefs(skill, genInputs(host.getState(), node.id).references);
        const refsLine = (refs.length || dropped.length)
            ? [$el("div", { className: "ns-canvas-gen-refs", textContent: refsSummaryText(refs, lastFrame, dropped) })]
            : [];
        return [
            $el("div", { className: "ns-canvas-gen-skill" }, [skillChip.chip.el]),
            ...refsLine,
            $el("div", { className: "ns-canvas-gen-params" },
                [genChip(durSel, { icon: "clock" }), genChip(sizeSel, { glyph: ratioGlyph() })]),
            $el("div", { className: "ns-canvas-gen-bottom" }, [$el("div", { className: "ns-canvas-gen-acts" }, acts)]),
        ];
    }

    return { runVideo, videoControls, startClipPoll, stopClipPoll, clipFinish, submitClip, clipGate,
        videoRefs };
}
