// 画布上的生成节点：技能与参数存在节点 metadata 里（随画布落盘、进撤销栈、跟复制走）。这一层只做装配与
// 分发 —— 运行态在 gen-state.js，只读清单在 gen-catalog.js，卡面控件基座在 gen-controls.js，出图与编辑
// 两条链在 gen-image.js，增强 / 反推 / 故事板三条链在 gen-llm.js；出片与串联这两族还在这一个文件里。
// 族模块只吃装配层交下来的 ctx（$el / toast / api / canFeature / host / modeGroup / groupLabels 与 runs /
// catalog / ctl / hooks），不直连页面、不自持跨请求的缓存；要跨族的那两一手（车尾那一枚技能下拉、故事板
// 写段时长）由装配层点名接线，族与族之间不互拿。
// 结果写回该节点下游：图进图片节点，片进视频节点，成文进提示词节点与车厢。
import { t, tf } from "../../../js/core/i18n.js";
import { chipButton, ratioGlyph, VIDEO_DUR_CHOICES, VIDEO_SIZE_CHOICES } from "../../../gen-utils.js";
import { cancelTask } from "../../../image-gen.js";
import { directorMetaText } from "../../../recipes.js";
import { skillDisplayName } from "../../../skill.js";
import { MEDIA_CAPS, REF_KIND_NAMES } from "../../../js/core/media-slot.js";
import { RUN_LABELS, gateOf, runKind } from "./node-types.js";
import { ANCHOR_CHOICES, CONTEXT_FRAMES_CHOICES, CONTEXT_FRAMES_DEFAULT, SEG_SEC_MAX, SEG_SEC_MIN,
    SEED_MAX, STEPS_CHOICES, mergeGenOverrides, readGenOverrides, readGenParams, readRecipeParams } from "./gen-params.js";
import { REF_BUCKETS, chainCars, chainRecipe, genInputs, isCar, mediaNodes, segmentRefs } from "./gen-graph.js";
import { createCanvasCatalog } from "./gen-catalog.js";
import { createCanvasControls } from "./gen-controls.js";
import { createCanvasImage } from "./gen-image.js";
import { createCanvasLlm } from "./gen-llm.js";
import { createCanvasState } from "./gen-state.js";

/**
 * 装配层的接线面（族模块契约里的 `ctx.recipe`）：族模块要跨到配方族那一发时，只从这里取点名好的那一个。
 * @typedef {object} CanvasGenHooks
 * @property {(node: object) => void} run 卡上的运行钮走分发（按节点那一发的种类派到族里）
 * @property {(node: object) => void} cancel 卡上的取消钮走分发（按在途那一发的种类收场）
 */
// 参数读法在 gen-params.js，连线图上的取用在 gen-graph.js（都是纯读法，不持页面状态）：这一层只管三条链
// 的请求构造、运行态与卡面控件。

const CLIP_TERMINAL = ["succeeded", "failed", "cancelled"];
const CLIP_POLL_MS = 1000;        // 简单视频与单段任务只有轮询快照：画布就在眼前，进度比出视频页那一格更快

export function createCanvasGen({ $el, toast, api, canFeature, host, modeGroup, groupLabels }) {
    const runs = createCanvasState({ host, toast });
    const catalog = createCanvasCatalog({ host });
    // 卡上的运行钮与取消钮都走分发（按种类派到族里），族模块拿到的就是这两个点名好的入口
    const hooks = { run: (node) => run(node), cancel: (node) => cancel(node) };
    const ctl = createCanvasControls({ $el, host, catalog, groupLabels, modeGroup,
        tailSkillSelect: (node, busy, follow) => tailSkillSelect(node, busy, follow) });
    const image = createCanvasImage({ $el, host, toast, canFeature, runs, catalog, ctl, hooks });
    const llm = createCanvasLlm({ $el, host, toast, api, canFeature, runs, catalog, ctl, hooks,
        recipe: { writeSegmentDuration: (w) => writeSegmentDuration(w) } });
    const { running, detached, timers, chains, llmRuns, stateOf, setRunning, labelsOf, detachTask } = runs;
    const { skills, enhanceSkills, videoSkills, recipes, loadSkills, loadEnhanceSkills, loadVideoSkills,
        loadRecipes, loadModelLists, skillName, videoSkillName, defaultSkillId, defaultEditSkillId,
        defaultVideoSkillId, recipeRow, cfgOf, primeCfg } = catalog;
    const { chips, openParams, paramsChips, genBtn, genChip, countChip, genParamsChip, modelText } = ctl;
    const { runImage, runEdit, imageControls, editControls } = image;
    const { runEnhance, runReverse, runStoryboard, llmControls, storyboardControls } = llm;
    /** 车厢自己写的正文（metadata.content，与提示词节点同一份存法） */
    function carOwnText(car) {
        return String(car?.metadata.content || "");
    }

    /** 这一段生效的提示词：连过来的正文 > 车厢自己写的那一句 > 配方里那一段的正文；三档都空就是空串 */
    function carPrompt(state, car) {
        const { prompts } = genInputs(state, car.id);
        if (prompts.length) return prompts.join("\n\n");
        const own = carOwnText(car);
        if (own) return own;
        const { recipe, segment } = readRecipeParams(car);
        return recipeRow(recipe)?.segments?.[segment]?.prompt || "";
    }

    /** 那一行配方概览：段数 · 模式 · 技能 · 宽高 · 总时长 —— 整列共用的东西只在串联车尾露一份，
     *  车厢一份都不出（车厢上的状态行说的是这一段自己跑到哪了）。
     *  车尾读它那一列车厢记着的配方名 —— 车尾自己不记配方，只记整列共用的那一个视频技能 */
    function recipeMetaText(node) {
        if (isCar(node)) return "";
        const recipe = chainRecipe(chainCars(host.getState(), node.id));
        if (!recipe) return t("未选配方");
        const row = recipeRow(recipe);
        return row ? directorMetaText(row, videoSkills.rows) : recipe;
    }

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

    /** 串联的一列里收掉一段：车尾那一行的进度跟着走，最后一收发完才收掉车尾那一发 */
    function chainStep(carId) {
        for (const [tailId, cars] of chains) {
            if (!cars.has(carId)) continue;
            cars.delete(carId);
            const st = running.get(tailId);
            if (!st) { chains.delete(tailId); return; }
            if (!cars.size) {
                running.delete(tailId);
                chains.delete(tailId);
                host.paintNodes();
                return;
            }
            setRunning(tailId, { done: (st.done || 0) + 1 });
            return;
        }
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

    /** 串联的一列出片：整列共用的那一个视频技能与那一套生成参数（锚点 / 步数 / 连续性 / 上下文帧 / 种子）
     *  都在车尾这一张卡上，配方名与段号在每一厢自己身上；按链序把启用的那几段依次入队 —— ComfyUI 队列自己
     *  按提交顺序跑，跑法与在导演页逐段出片相同，成片各落各的下游视频位，停用的那几段不进这一发 */
    function runChain(node) {
        if (clipGate(node)) return;
        const cars = chainCars(host.getState(), node.id);
        if (!cars.length) { toast(t("这台视频生成节点上游没有车厢：用「添加配方」铺一列"), "info"); return; }
        const live = cars.filter((car) => car.metadata.disabled !== true);
        if (!live.length) { toast(t("链上没有启用的段"), "info"); return; }
        const recipe = chainRecipe(cars);
        if (!recipe) { toast(t("链上的车厢没有配方名：用「添加配方」重铺一列"), "info"); return; }
        const skill_id = readGenParams(node).skill_id;
        if (!skill_id && !chainRecipeSkillIds(recipe).length) {
            toast(t("这份配方没有技能：在车尾选一个视频技能"), "error");
            return;
        }
        // 车尾没盖技能就是空着交后端：每一段用配方里那一段自己写的技能；盖了就是整列共用这一份。
        // 盖的是全参考那一组就整列按全参考出片：锚点帧在那一发的模板里没有槽位，锁成不用锚点
        const fullRef = tailFullRef(node);
        const params = { ...readRecipeParams(node), recipe, skill_id,
            anchors: fullRef ? "none" : readRecipeParams(node).anchors,
            mode: fullRef ? "r2v" : "" };
        const { width, height } = readGenParams(node);
        if (width && height) Object.assign(params, { width, height });   // 车尾盖的分辨率：整列共用这一份
        const ov = readGenOverrides(node);   // 车尾那一发的模型链 / LoRA / 步数：整列共用（导演页同一份合并）
        chains.set(node.id, new Set(live.map((car) => car.id)));
        setRunning(node.id, { kind: "chain", task_id: "", status: "running", done: 0, total: live.length, error: "" });
        const state = host.getState();
        for (const car of live) submitCar(state, params, car, ov);
    }

    /** 串联里一段的载荷：车尾的公共参数与那一个技能 + 这一段的段号 + 画布连过来的正文 / 素材。
     *  种子按段号偏移（一列车厢各段彼此不同种），-1 就是这一段每次换种子 */
    function submitCar(state, params, car, ov) {
        const { segment } = readRecipeParams(car);
        const { prompts, references } = genInputs(state, car.id);
        const body = { ...params, segment,
            seed: params.seed === -1 ? -1 : params.seed + segment,
            prompt: carPrompt(state, car), references };
        mergeGenOverrides(body, ov);   // 车尾那一发的模型链 / LoRA / 步数：整列共用（后端按技能配置与全局设置合并）
        submitClip("/neo_video_gen/run_segment", body, "segment", car);
    }

    /** 「链上 N 段 · 启用 M 段」：整条链与启用数都要「段」字（链上没有启用的车厢，出片就是没有这一段），
     *  段数后面的那一项（配方名）由调用方接在后面 */
    function chainCountText(cars, live) {
        return tf("链上 {n} 段 · 启用 {m} 段", { n: cars.length, m: live.length });
    }

    /** 车尾盖的技能属于哪一组出片：「全参考生视频」那一组整列按全参考出片（画布盖 mode、不吃锚点帧）。
     *  车尾空着 = 每一段用配方里那一段自己的技能，画布不盖模式，锚点照车尾上那一份 */
    function tailFullRef(node) {
        const id = readGenParams(node).skill_id;
        return !!id && modeGroup(videoSkills.rows.find((s) => s.id === id)) === "r2v";
    }

    /** 节点上那枚运行钮的入口：这一发走哪一条链全看 runKind 落在注册表里的哪一行 —— 车厢那一行没有钮，
     *  落在这张表上就是空（出片在它那一列的车尾） */
    const RUNNERS = {
        image: runImage,
        video: runVideo,
        chain: runChain,
        edit: runEdit,
        enhance: runEnhance,
        reverse: runReverse,
        storyboard: runStoryboard,
    };

    function run(node) {
        RUNNERS[runKind(node)]?.(node);
    }

    function cancel(node) {
        const inflight = llmRuns.get(node.id);
        if (inflight) {
            inflight.stopped = true;
            inflight.abort.abort();   // 收摊在 submitLlmRun 的 catch：那一发自己收状态并说一句已取消
            return;
        }
        const chain = chains.get(node.id);
        if (chain) {
            // 整列取消：这一列在跑的每一段自己出队，收摊归各自的轮询
            chains.delete(node.id);
            running.delete(node.id);
            host.paintNodes();
            const state = host.getState();
            for (const carId of chain) {
                const car = state.nodes.find((n) => n.id === carId);
                if (car) cancel(car);
            }
            return;
        }
        const st = running.get(node.id);
        if (!st?.task_id) { running.delete(node.id); host.paintNodes(); return; }
        if (st.kind === "image") {
            // 出队交后端：跑着的那一发后端会推 cancelled 那一格，摘监听与收摊都归 watchTask 与 finish
            cancelTask(st.task_id);
            return;
        }
        // 轮询链的取消：出队交后端，终态由下一格轮询收摊（摘计时与收运行态都在 clipFinish）
        const path = st.kind === "segment"
            ? `/neo_video_gen/run_segment/${st.task_id}/cancel` : `/neo_video_gen/simple/${st.task_id}/cancel`;
        api.fetchApi(path, { method: "POST" }).catch(() => { /* 取消失败不挡 UI：这一发还在队列里，顶栏「队列」能取消 */ });
    }

    /** 卸页与切项目共用的那一发：把还在跑的先脱手，再断监听。脱手那一份名单留着 ——
     *  终态那一格晚于切画布到达时，靠它认得出「这一发不再写回哪张画布」，只说一句图已存进 Output。
     *  生图脱手（图落在 Output 目录里，终态那一格只说一句），轮询链摘计时并脱手 —— 画布不在眼前了
     *  就不再替用户问进度，这一发在顶栏「队列」里照常被看见与取消；串联的车尾没有自己的 task，跟着清掉 */
    function stopAll() {
        for (const [nodeId, st] of running) {
            if (st.kind === "image") detachTask(st.task_id, nodeId);
            else if (st.kind !== "chain") { stopClipPoll(st.task_id); detached.add(st.task_id); }
        }
        running.clear();
        chains.clear();
        for (const llm of llmRuns.values()) {
            llm.stopped = true;
            llm.abort.abort();   // 在途的正文不落这一张画布：catch 认得出这是脱手，只收流
        }
        llmRuns.clear();
    }

    function controls(node) {
        const params = readGenParams(node);
        const st = running.get(node.id) || {};
        const busy = st.status === "queued" || st.status === "running";
        if (params.kind === "video") {
            // 串联的车尾那台生成节点的面与出视频页那一张不同：参数是整列共用的那一份
            return params.chain === "train" ? chainControls(node, busy) : videoControls(node, params, busy);
        }

        return imageControls(node, params, busy);
    }
    /** 「加图像生成节点」把技能列表取到手：胶囊里列的就是那一份；技能被删了，旧画布上的节点要能认出来 */
    function prime() {
        loadSkills().then(host.paintNodes).catch(() => {});
        loadEnhanceSkills().then(host.paintNodes).catch(() => {});
        loadModelLists();
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
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => cancel(node), t("取消这一发后台任务")));
        acts.push(genBtn(t(labels.btn), "play", () => run(node),
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

    /** 配方里每一段写了哪几份技能（去重）：一份 = 整列共用这一份；多份 = 跟随就是「每一段自己的技能」；
     *  空 = 配方没写技能（配方列表没取到、段上没技能），出片要明说没技能可跑 */
    function chainRecipeSkillIds(recipe) {
        return [...new Set((recipeRow(recipe)?.segments || [])
            .map((s) => String(s.skill_id || "")).filter(Boolean))];
    }

    /** 车尾技能胶囊上「空着」那一句说的跟随：配方里每一段自己写的技能合成一份时就说那一份，
     *  各段不同就说「跟随每一段自己的技能」，配方里没有技能就是没选 */
    function chainFollowText(recipe) {
        const ids = chainRecipeSkillIds(recipe);
        if (!ids.length) return t("未选技能");
        if (ids.length > 1) return t("跟随每一段自己的技能");
        return tf("跟随配方 {skill}", { skill: videoSkillName(ids[0]) });
    }

    /** 车尾那一枚技能胶囊里的技能下拉（共享胶囊把它当状态容器收在壳里）：第一项就是「跟随配方 …」，
     *  选了谁整列就用谁（配方里每一段自己写的技能被它盖掉）；技能列表没取到时把存的这一个也列出来 */
    function tailSkillSelect(node, busy, follow) {
        const saved = readGenParams(node).skill_id;
        const sel = $el("select", { disabled: busy,
            title: t("整列共用的出视频技能：空着 = 每一段用配方里那一段自己写的技能"),
            onchange: () => {
                openParams.add(node.id);   // 选技能不收面板（绘画页同一手感）：整层重画完在原处接着弹开
                host.patchMeta(node.id, { skill_id: sel.value });
                primeCfg(sel.value);       // 右栏要铺新技能钉的那一套模型链
            } });
        sel.append($el("option", { value: "", textContent: follow }));
        for (const s of videoSkills.rows) {
            const opt = $el("option", { value: s.id, textContent: skillDisplayName(s) });
            opt.__skillMeta = s;   // 面板左栏的技能分组认的就是这一个
            sel.append(opt);
        }
        sel.value = saved;
        if (sel.value !== saved) {
            sel.value = "";
            sel.appendChild($el("option", { value: saved, textContent: saved, disabled: true, selected: true }));
        }
        return sel;
    }

    /** 车尾那一枚分辨率胶囊（与导演页同一份尺寸表）：整列出片共用的分辨率，空着 = 按配方共享的那一份；
     *  盖一次就是这一列出片用的分辨率（两端锚点那一路后端照旧按成片尺寸走，并在任务里说明） */
    function chainSizeSelect(node, busy, recipe) {
        const { width, height } = readGenParams(node);
        const shared = recipeRow(recipe)?.shared || {};
        const follow = shared.width && shared.height
            ? tf("跟随配方 {size}", { size: `${shared.width}×${shared.height}` })
            : t("跟随配方尺寸");
        const sel = $el("select", { disabled: busy, title: t("分辨率"),
            onchange: () => {
                const [w, h] = (sel.value || "0,0").split(",").map(Number);
                host.patchMeta(node.id, { width: w || 0, height: h || 0 });
            } });
        sel.append($el("option", { value: "0", textContent: follow }));
        for (const [w, h, label] of VIDEO_SIZE_CHOICES) {
            sel.append($el("option", { value: `${w},${h}`, textContent: `${w}×${h} · ${t(label)}` }));
        }
        sel.value = width && height ? `${width},${height}` : "0";
        sel.dataset.follow = follow;
        return sel;
    }

    /** 整列共用那一套生成参数的控件（步数 / 锚点 / 连续性 / 上下文帧 / 种子）：只有串联的车尾那台生成节点
     *  读这一份，改动都走 patchMeta —— 空值与 -1 都是「跟随」，请求里带着它由后端合并 */
    function recipeParamSelects(node, busy) {
        const params = readRecipeParams(node);
        const stepsSel = $el("select", { disabled: busy, title: t("步数"),
            onchange: () => host.patchMeta(node.id, { steps: Number(stepsSel.value) || -1 }) });
        stepsSel.append($el("option", { value: "-1", textContent: t("跟随步数") }));
        for (const n of STEPS_CHOICES) {
            stepsSel.append($el("option", { value: String(n), textContent: tf("{n} 步", { n }) }));
        }
        stepsSel.value = String(params.steps);
        stepsSel.dataset.follow = t("跟随步数");   // -1 就是跟随：胶囊上直接这么说，不是那句通用的「默认」

        // 车尾盖的是全参考那一组：锚点帧在那一发的模板里没有槽位，出片固定走不用锚点，这一格不给改
        const fullRef = tailFullRef(node);
        const anchorSel = $el("select", { disabled: busy || fullRef,
            title: fullRef ? t("全参考生视频不吃锚点帧：整列固定不用锚点") : t("锚点"),
            onchange: () => host.patchMeta(node.id, { anchors: anchorSel.value }) });
        for (const [key, label] of ANCHOR_CHOICES) {
            anchorSel.append($el("option", { value: key, textContent: t(label) }));
        }
        anchorSel.value = fullRef ? "none" : params.anchors;

        const contSel = $el("select", { disabled: busy, title: t("连续性"),
            onchange: () => host.patchMeta(node.id, { continuity: contSel.value === "on" }) });
        contSel.append($el("option", { value: "on", textContent: t("连续性 开") }));
        contSel.append($el("option", { value: "off", textContent: t("连续性 关") }));
        contSel.value = params.continuity ? "on" : "off";

        const ctxSel = $el("select", { disabled: busy, title: t("上下文帧"),
            onchange: () => host.patchMeta(node.id, { context_frames: Number(ctxSel.value) || 0 }) });
        for (const frames of CONTEXT_FRAMES_CHOICES) {
            ctxSel.append($el("option", { value: String(frames), textContent: tf("{n} 帧窗口", { n: frames }) }));
        }
        ctxSel.value = String(CONTEXT_FRAMES_CHOICES.includes(params.context_frames)
            ? params.context_frames : CONTEXT_FRAMES_DEFAULT);
        ctxSel.dataset.follow = tf("{n} 帧窗口", { n: CONTEXT_FRAMES_DEFAULT });

        const seedIn = $el("input", { className: "ns-canvas-recipe-seed", type: "number", min: "-1",
            max: String(SEED_MAX), step: "1", disabled: busy, title: t("种子（-1 = 每次换种子）"),
            value: String(params.seed),
            onchange: () => host.patchMeta(node.id, { seed: Number(seedIn.value) > 0 ? Number(seedIn.value) : -1 }) });

        return { stepsSel, anchorSel, contSel, ctxSel, seedIn };
    }

    /** 车厢上显示的那一段读哪一份：配方名与段号是车厢自己的（铺一列时写进去的那一份），整列共用的那一个
     *  视频技能在它那一列的车尾上 —— 车尾断了回落配方里这一段自己写的技能。正文与素材是车厢自己的 */
    function carView(node) {
        const state = host.getState();
        const own = readRecipeParams(node);
        const seg = recipeRow(own.recipe)?.segments?.[own.segment] || {};
        const { prompts } = genInputs(state, node.id);
        const canvasRefs = mediaNodes(state, node.id);
        // 这一段写了的参考素材（图 / 参考视频 / 参考音频，连首帧与分镜图）：铺一列时已经落成画布节点的
        // 数在 canvasRefs 里，这一条只补配方里写了、画布上没铺的那几份
        const laid = new Set(canvasRefs.map((n) => String(n.metadata.asset || n.metadata.filename || "")));
        const ownRefs = segmentRefs(seg).filter((name) => !laid.has(name));
        const canvasPrompt = prompts.join("\n\n");
        const ownText = carOwnText(node);
        const segPrompt = String(seg.prompt || "").trim();
        return {
            // 顶行那一行：这一段时长（车厢上那一枚数框，改了写进配方）· 配方名 · 生效的技能
            // （段号在左边「段 N」那枚里，这里不重复）
            duration: seg.duration_sec ?? null,
            head: [own.recipe, videoSkillName(own.skill_id || seg.skill_id)].filter(Boolean).join(" · "),
            src: canvasPrompt ? t("画布") : ownText ? t("车厢") : t("配方"),
            // 正文框铺的是这一段生效的那一份：连过来的正文（锁着）、车厢写过的、都没有就是配方那一段
            edit: canvasPrompt || ownText || segPrompt,
            seed: segPrompt,      // 车厢没写过时框里就是这一份：改没改过拿它比
            prompt: canvasPrompt || ownText || segPrompt || t("这一段没有提示词"),
            fromCanvas: !!canvasPrompt,
            count: canvasRefs.length + ownRefs.length,
        };
    }

    /** 车厢顶行那一枚时长框落笔：把这一段的时长写进配方文件（导演页、重铺一列、出片读的都是这一份）。
     *  与配方里那一份一字不差就不打后端；写成功就把手里那一段改成后端钳过的值再整层重画，
     *  车尾那一行的总时长跟着变。这是配方文件的写，不进画布撤销栈（与「删除素材」同一类），
     *  改回去就在车厢上改回来 */
    function setCarDuration(node, seconds) {
        const own = readRecipeParams(node);
        const seg = recipeRow(own.recipe)?.segments?.[own.segment];
        const typed = Math.round(Number(seconds));
        if (!Number.isFinite(typed)) { host.paintNodes(); return; }   // 空框 / 非数：不写盘，重画回配方那一份
        const next = Math.min(SEG_SEC_MAX, Math.max(SEG_SEC_MIN, typed));
        if (next === Number(seg?.duration_sec)) { host.paintNodes(); return; }
        writeSegmentDuration({ recipe: own.recipe, segment: own.segment, duration_sec: next },
            (sec) => toast(tf("第 {n} 段：{sec} 秒（写进配方）", { n: own.segment + 1, sec }), "success"));
    }

    /** 把一段的时长写进配方文件（车厢顶行那一枚数框与文字故事板写回共用这一发）：成功后把手里那一段
     *  改成后端钳过的值并整层重画，车尾那一行的总时长跟着变。这是配方文件的写，不进画布撤销栈
     *  （与「删除素材」同一类），改回去就在车厢上改回来 */
    function writeSegmentDuration({ recipe, segment, duration_sec }, onDone) {
        api.fetchApi("/rs_recipes/set_segment_duration", { method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: recipe, segment, duration_sec }) })
            .then(async (resp) => {
                const data = await resp.json().catch(() => null);
                if (!resp.ok || !data?.success) throw new Error(data?.error || `HTTP ${resp.status}`);
                const seg = recipeRow(recipe)?.segments?.[segment];
                if (seg) seg.duration_sec = Number(data.duration_sec) || duration_sec;
                host.paintNodes();
                onDone?.(Number(data.duration_sec) || duration_sec);
            })
            .catch((err) => {
                // 没写进去就不在画布上留一份配方里没有的时长：整层重画把框退回配方那一份
                host.paintNodes();
                toast(`${t("段时长没写进去")}：${String(err?.message || err)}`, "error");
            });
    }

    /** 串联车尾那台生成节点的面：卡上只留整列共用的技能与分辨率两枚胶囊、这一列跑几段那一行、出片那一发；
     *  步数 / 锚点 / 连续性 / 上下文帧 / 种子这些不常用的参数收在「参数」弹窗里（openChainParams）。
     *  出片就是按链序把启用的那几段依次入队（与在导演页逐段出片同一发），成片落各段的下游视频位，
     *  这台节点自己不落片；每一段的时长跟着配方走，卡上没有时长口子 */
    function chainControls(node, busy) {
        const cars = chainCars(host.getState(), node.id);
        const live = cars.filter((car) => car.metadata.disabled !== true);
        // 这一列跑的是哪一份配方：铺的时候定下、记在每一厢身上，车尾只把它写出来（换配方是重铺一列，不在这里改）
        const recipe = chainRecipe(cars) || String(node.metadata?.recipe || "");
        const labels = RUN_LABELS.chain;
        const acts = [];
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => cancel(node), t("取消这一列在跑的段")));
        acts.push(genBtn(t("参数"), "gear", () => openChainParams(node),
            tailFullRef(node)
                ? t("步数 / 连续性 / 上下文帧 / 种子：整列共用的参数（锚点已锁为不用锚点）")
                : t("步数 / 锚点 / 连续性 / 上下文帧 / 种子：整列共用的参数"), busy));
        acts.push(genBtn(t(labels.btn), "play", () => run(node),
            canFeature(labels.cap) === false ? t(labels.offline) : t(labels.tip), busy));
        return [
            // 第一行就是这一列的关键信息：配方名 + 跑几段 / 启用几段（与车厢顶行同一行式，段数与配方名一行写完）
            $el("div", { className: "ns-canvas-car-head",
                title: t("这一列跑哪一份配方在铺的时候定下：要换配方用「添加配方」重铺一列") }, [
                $el("span", { className: "ns-canvas-car-seg", textContent: t("车尾") }),
                $el("span", { className: "ns-canvas-car-info",
                    textContent: recipe
                        ? `${chainCountText(cars, live)} · ${recipe}`
                        : chainCountText(cars, live) }),
            ]),
            $el("div", { className: "ns-canvas-gen-skill" },
                // 技能这一枚是共享技能弹窗那一枚（左栏整列要用的出视频技能，第一项就是「跟随配方 …」）
                [genParamsChip(node, { icon: "film", isVideo: true, busy,
                    follow: chainFollowText(recipe) }).chip.el,
                    genChip(chainSizeSelect(node, busy, recipe), { glyph: ratioGlyph() })]),
            $el("div", { className: "ns-canvas-gen-bottom" }, [$el("div", { className: "ns-canvas-gen-acts" }, acts)]),
        ];
    }

    /** 车尾的「参数」弹窗：整列共用的次要点（步数 / 锚点 / 连续性 / 上下文帧 / 种子）收在这里，
     *  下拉一律走胶囊菜单 —— 桌面窗口的 WebView 里原生 select 弹不出列表（与卡上那两枚胶囊同一套控件）。
     *  菜单挂在弹窗自己那一层（不是画布那层 .ns-canvas-gen-menus）：弹窗是盖在画布上的浮层，
     *  画布层在弹窗下面，菜单进画布层就被这一层遮死、还被 .ns-canvas-stage 的 overflow 切掉。
     *  改一下当场走 patchMeta（进撤销栈、随画布落盘）。收窗与「添加配方」那扇同一套：点窗外、Esc、右上角 × */
    function openChainParams(node) {
        const close = () => {
            mask.remove();
            document.removeEventListener("keydown", onKey);
        };
        const onKey = (ev) => { if (ev.key === "Escape") close(); };
        const menus = $el("div", { className: "ns-canvas-tailform-menus" });
        const formChip = (sel, opts) => {
            const chip = chipButton(sel, { ...opts, mount: () => menus });
            chips.add(chip);
            return chip.el;
        };
        const { stepsSel, anchorSel, contSel, ctxSel, seedIn } = recipeParamSelects(node, false);
        const row = (label, el) => $el("div", { className: "ns-canvas-tailform-row" },
            [$el("span", { className: "ns-canvas-tailform-label", textContent: t(label) }), el]);
        const mask = $el("div", { className: "ns-canvas-tailform-mask",
            onclick: (ev) => { if (ev.target === mask) close(); } }, [
            $el("div", { className: "ns-canvas-tailform" }, [
                $el("div", { className: "ns-canvas-tailform-head" }, [
                    $el("span", { className: "ns-canvas-tailform-title", textContent: t("整列共用参数") }),
                    $el("button", { className: "ns-iconbtn ns-size-md ns-ghost", type: "button", textContent: "×",
                        title: t("关闭"), onclick: close }),
                ]),
                row("步数", formChip(stepsSel, { icon: "sliders" })),
                row("锚点", formChip(anchorSel, { icon: "anchor" })),
                row("连续性", formChip(contSel, { icon: "film" })),
                row("上下文帧", formChip(ctxSel, { icon: "clock" })),
                row("种子", seedIn),
                $el("p", { className: "ns-canvas-tailform-note",
                    textContent: t("每一段的时长在车厢上那一枚框里改，写进配方那一段") }),
                menus,
            ])]);
        host.pageEl().appendChild(mask);
        document.addEventListener("keydown", onKey);
    }

    /** 「加视频生成节点」把视频技能列表取到手（与出视频页同一份来源） */
    function primeVideo() {
        loadVideoSkills().then(host.paintNodes).catch(() => {});
        loadModelLists();
    }

    /** 「添加配方」弹窗把配方列表与视频技能取到手：弹窗的卡与车厢上那行配方概览都读这两份 */
    function primeRecipes() {
        Promise.all([loadRecipes(), loadVideoSkills()]).then(() => host.paintNodes()).catch(() => {});
    }

    /** 「添加配方」弹窗要读的段列表：配方列表没取到（离线、配方被删）时交空数组，页面据此说明原因 */
    function recipeSegments(name) {
        return recipeRow(name)?.segments || [];
    }

    /** 「添加配方」弹窗卡片上那一行概览：段数 · 模式 · 技能 · 宽高 · 总时长（弹窗自己不碰技能列表） */
    function recipeCardText(name) {
        const row = recipeRow(name);
        return row ? directorMetaText(row, videoSkills.rows) : "";
    }

    /** 「添加配方」弹窗要列的那一份配方列表：卡片上的名称、段数、时长与封面都读这一份 */
    function recipeCards() {
        return recipes.rows;
    }

    return {
        stateOf,
        skillName,
        defaultSkillId,
        defaultVideoSkillId,
        defaultEditSkillId,
        modelText,
        recipeMetaText,
        recipeSegments,
        segmentRefs,
        recipeCards,
        recipeCardText,
        carView,
        setCarDuration,
        controls,
        editControls,
        llmControls,
        storyboardControls,
        prime,
        primeVideo,
        primeRecipes,
        run,
        cancel,
        stopAll,
    };
}
