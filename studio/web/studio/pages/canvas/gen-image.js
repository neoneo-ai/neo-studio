// 出图族：图像生成节点与图像编辑节点那两条链 —— 出图走 POST /neo_image_gen/generate 加 rs.image_gen
// 事件推送，编辑走同一条链的另一张表单；两条链的进度与终态写回都交运行态那一层（runs.finish）。
// 卡上的控件也在这里：出图那一张与编辑那一张，共享的技能 + 自定参数胶囊由控件基座给（gen-controls.js）。
import { t, tf } from "../../../js/core/i18n.js";
import { QWEN_IMAGE_SKILL_ID, ratioGlyph } from "../../../gen-utils.js";
import { COMMON_EDGES, COMMON_RATIOS, requestGeneration, watchTask } from "../../../image-gen.js";
import { skillAcceptsRef, skillAcceptsText } from "../../../skill.js";
import { RUN_LABELS, gateOf, runKind } from "./node-types.js";
import { mergeGenOverrides, readEditParams, readGenOverrides, readGenParams } from "./gen-params.js";
import { genInputs } from "./gen-graph.js";

/** 出图与编辑两条链 + 出图 / 编辑两张卡的面。
 *  `hooks.run` / `hooks.cancel` 是装配层的分发（卡上的运行钮与取消钮都走它） */
export function createCanvasImage({ $el, host, toast, canFeature, runs, catalog, ctl, hooks }) {
    const { running, setRunning, labelsOf, finish } = runs;
    const { skills, cfgOf, primeCfg, skillName, defaultSkillId, defaultEditSkillId } = catalog;
    const { genBtn, genChip, countChip, genParamsChip } = ctl;
    function runImage(node) {
        // 停用的那一张按一下就明说自己不跑（这句排在「这一发在跑」之前）；出图要执行队列，拉起它是顶栏
        // 那一位的事：画布出图与绘画页出图同一口径，这里只说去哪儿启。能力位与话术都在注册表那一行里
        const stop = gateOf(node, { running: running.has(node.id), canFeature });
        if (stop) {
            if (stop.msg) toast(stop.msg, stop.level);
            return;
        }
        const params = readGenParams(node);
        if (!params.skill_id) { toast(t("先选一个生图技能"), "info"); return; }
        const state = host.getState();
        const { prompts, references } = genInputs(state, node.id);
        // 技能收不进文本就别把正文发出去：后端会 400，画布上提前说清楚（参考图照带）
        const skill = skills.rows.find((s) => s.id === params.skill_id);
        if (prompts.length && skill && !skillAcceptsText(skill)) {
            toast(tf("{skill} 不吃文本提示词，接上参考图再出图", { skill: skillName(params.skill_id) }), "info");
            return;
        }
        if (!prompts.length && !references.images.length) { toast(t("接一条文本或图片线过来再出图"), "info"); return; }
        const body = { skill_id: params.skill_id, prompt: prompts.join("\n\n"),
            references: references.images, count: params.count };
        if (params.default_ratio) body.default_ratio = params.default_ratio;
        if (params.base_resolution) body.base_resolution = params.base_resolution;
        mergeGenOverrides(body, readGenOverrides(node));   // 这一发自定的主模型 / LoRA（空 = 后端按技能 config 与全局设置合并）
        submitImageRun(node, body, params.count);
    }

    /** 出图与图像编辑共用的那一发：入队、挂上监听、把进度与终态落回这张节点（终态收摊在 finish）。
     *  requestGeneration 的契约：成功交后端那一份 {task_id,status}，失败抛 Error（落进 catch） */
    function submitImageRun(node, body, total) {
        requestGeneration(body)
            .then((res) => {
                setRunning(node.id, { kind: "image", task_id: res.task_id, status: res.status || "queued",
                    done: 0, total, error: "" });
                watchTask(res.task_id, (snap) => {
                    if (snap.status === "queued" || snap.status === "running") {
                        const cur = running.get(node.id);
                        if (!cur) return;   // 脱手的那一发不在这一张画布上，进度不写它
                        const p = snap.progress;
                        setRunning(node.id, { status: snap.status,
                            done: p ? Number(p.value) || 0 : (snap.images || []).length,
                            total: p ? Number(p.max) || cur.total : cur.total });
                        return;
                    }
                    finish(node.id, snap);
                });
            })
            .catch((err) => {
                const msg = String(err?.message || err);
                running.set(node.id, { kind: "image", status: "failed", error: msg });
                host.paintNodes();
                toast(`${t(labelsOf(node.id).failToast)}：${msg}`, "error");
            });
    }

    /** 图像编辑节点出图：连过来的图片节点按连线顺序进参考，第一张就是被改的那一张；提示词就是连过来的
     *  那几条正文。载荷与绘画页编辑面板「常规」那一发同口径（references + skip_enhance），结果照走
     *  finish 落下游图片节点 */
    function runEdit(node) {
        const stop = gateOf(node, { running: running.has(node.id), canFeature });
        if (stop) {
            if (stop.msg) toast(stop.msg, stop.level);
            return;
        }
        const params = readEditParams(node);
        const skill = skills.rows.find((s) => s.id === params.skill_id);
        // 这一发的全部力气都在「按指令改那张图」上：技能不吃参考图就是必败，跑之前说清楚
        if (skill && !skillAcceptsRef(skill)) {
            toast(tf("{skill} 不吃参考图，换一张技能再编辑", { skill: skillName(params.skill_id) }), "info");
            return;
        }
        const { prompts, references } = genInputs(host.getState(), node.id);
        const refs = references.images;
        if (!refs.length) { toast(t("把要编辑的那一张图片节点连过来"), "info"); return; }
        if (!prompts.length) { toast(t("把要用的提示词节点连过来"), "info"); return; }
        const body = { skill_id: params.skill_id || QWEN_IMAGE_SKILL_ID, prompt: prompts.join("\n\n"),
            references: refs, count: params.count, skip_enhance: true };
        mergeGenOverrides(body, readGenOverrides(node));
        submitImageRun(node, body, params.count);
    }

    /**
     * 铺在节点上的控件：技能与自定参数一枚胶囊，比例、长边、张数一行一枚，出图与取消在最后一行。
     * 改动当场走 host.patchMeta —— 进撤销栈、跟复制走、随画布落盘；比例与长边的「跟随」态跟着技能 config 走。
     */

    function imageControls(node, params, busy) {
        const offline = canFeature(RUN_LABELS[runKind(node)].cap) === false;
        const cfg = cfgOf(params.skill_id);
        primeCfg(params.skill_id);

        const ratioSel = $el("select", { disabled: busy, title: t("默认比例"),
            onchange: () => host.patchMeta(node.id, { default_ratio: ratioSel.value }) });
        ratioSel.append($el("option", { value: "", textContent: t("默认比例") }));
        for (const r of COMMON_RATIOS) ratioSel.append($el("option", { value: r, textContent: r }));
        ratioSel.value = params.default_ratio;
        ratioSel.dataset.follow = t("默认比例");
        if (cfg?.follow_ratio) {
            ratioSel.value = "";
            ratioSel.dataset.follow = t("跟随技能 {ratio}", { ratio: cfg.default_ratio || "" });
        }

        const edgeSel = $el("select", { disabled: busy, title: t("长边尺寸"),
            onchange: () => host.patchMeta(node.id, { base_resolution: Number(edgeSel.value) || 0 }) });
        edgeSel.append($el("option", { value: "0", textContent: t("长边尺寸") }));
        for (const e of COMMON_EDGES) edgeSel.append($el("option", { value: String(e), textContent: String(e) }));
        edgeSel.value = String(params.base_resolution || 0);
        edgeSel.dataset.follow = t("长边尺寸");
        if (cfg?.follow_resolution) {
            edgeSel.value = "0";
            edgeSel.dataset.follow = t("跟随技能 {edge}", { edge: cfg.base_resolution || "" });
        }

        const labels = RUN_LABELS[runKind(node)];
        const acts = [];
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => hooks.cancel(node), t("取消这一发后台任务")));
        // 出图是这一张卡的主按钮：独占最后一行铺满、主色实心，一眼看见（参考无限画布卡片底部那条生成钮）
        acts.push(genBtn(t(labels.btn), "play", () => hooks.run(node),
            // 离线不 disable：按下去就是要替用户去启队列的（run 里说清楚）；只有这一发在跑才收着
            offline ? t(labels.offline) : t(labels.tip), busy, "ns-canvas-gen-go"));
        // 技能与自定参数就这一枚胶囊：点开左栏换技能、右栏改这一发的主模型与 LoRA（绘画页同一枚）
        const skillChip = genParamsChip(node, { icon: "sparkles", isVideo: false, busy });
        return [
            $el("div", { className: "ns-canvas-gen-skill" }, [skillChip.chip.el]),
            $el("div", { className: "ns-canvas-gen-params" },
                [genChip(ratioSel, { glyph: ratioGlyph() }), genChip(edgeSel, { icon: "image" }),
                    countChip(node, params, busy)]),
            $el("div", { className: "ns-canvas-gen-bottom" }, [$el("div", { className: "ns-canvas-gen-acts" }, acts)]),
        ];
    }

    /** 图像编辑节点上的控件：技能与自定参数一枚胶囊、张数一枚、出图与取消一行 —— 这一张节点上不进图
     *  也不进正文，那两样都从连过来的节点取（见 runEdit） */
    function editControls(node) {
        const params = readEditParams(node);
        const st = running.get(node.id) || {};
        const busy = st.status === "queued" || st.status === "running";
        const offline = canFeature(RUN_LABELS.edit.cap) === false;
        primeCfg(params.skill_id);
        const labels = RUN_LABELS.edit;
        const acts = [];
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => hooks.cancel(node), t("取消这一发后台任务")));
        acts.push(genBtn(t(labels.btn), "play", () => runEdit(node),
            // 离线不 disable：按下去就是要替用户去启队列的（runEdit 里说清楚）；只有这一发在跑才收着
            offline ? t(labels.offline) : t(labels.tip), busy, "ns-canvas-gen-go"));
        const skillChip = genParamsChip(node, { icon: "pencil", isVideo: false, busy });
        return [
            $el("div", { className: "ns-canvas-gen-skill" }, [skillChip.chip.el]),
            $el("div", { className: "ns-canvas-gen-params ns-canvas-edit-params" }, [countChip(node, params, busy)]),
            $el("div", { className: "ns-canvas-gen-bottom" }, [$el("div", { className: "ns-canvas-gen-acts" }, acts)]),
        ];
    }

    return { runImage, runEdit, imageControls, editControls };
}
