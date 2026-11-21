// 画布上的生成节点：技能与参数存在节点 metadata 里（随画布落盘、进撤销栈、跟复制走），三条出片链共用
// 同一份运行态与同一条写回 —— 生图走 POST /neo_image_gen/generate + rs.image_gen.status 事件推送；
// 视频节点（metadata.kind = "video"）走出视频页那条简单视频链（POST /neo_video_gen/simple + 1s 轮询快照）；
// 配方闭环节点（type = "recipe"）走导演页单段那条链（POST /neo_video_gen/run_segment + 1s 轮询快照）。
// 结果写回该节点下游：图进图片节点，片进视频节点。
// 参数控件直接铺在节点上 —— 胶囊与比例字形是 gen-utils 那一套，与绘画页同一手感；节点缩放时控件跟着缩放，
// 拖节点用控件之外那一片，缩放走四角尺寸柄。比例、长边、张数是精简的那一枚（图标 + 生效值，没有行标签），
// 每一枚是干什么的写在悬停提示里。技能那一枚就是绘画页与出视频页的那一枚（skillParamsChip）：
// 点开左栏换技能、右栏改这一发的自定参数（主模型 / LoRA，出片多几行模型链与步数）。
// 这一层不持画布 state：读写全走页面交下来的那几条（host.getState / patchMeta / applyResult / paintNodes）。
import { t, tf } from "../../../js/core/i18n.js";
import { setIconLabel } from "../../../js/core/icons.js";
import { chipButton, guardMainModelFamily, QWEN_IMAGE_SKILL_ID, ratioGlyph, skillParamsChip,
    VIDEO_DUR_CHOICES, VIDEO_SIZE_CHOICES } from "../../../gen-utils.js";
import { cancelTask, COMMON_EDGES, COMMON_RATIOS, createModelConfigSection, createVideoModelConfigSection,
    getSkillGenConfig, listGenModels, listVideoGenModels, requestGeneration, shortModelName,
    watchTask } from "../../../image-gen.js";
import { directorMetaText, listRecipes, listVideoSkills } from "../../../recipes.js";
import { listSkills, skillAcceptsRef, skillAcceptsText, skillDisplayName, isEnhanceSkill } from "../../../skill.js";
import { MEDIA_CAPS, REF_KIND_NAMES } from "../../../js/core/media-slot.js";
import { ENHANCE_API, enhancePayload } from "../../../prompt-enhance/prompt-enhance.js";
import { REVERSE_API, REVERSE_LANGS, reverseRequestBody } from "../../../reverse-prompt/reverse-prompt.js";
import { STORYBOARD_API, SEG_SEC_DEFAULT, storyboardCarPatches, storyboardDurationWrites, storyboardError,
    storyboardMismatchText, storyboardRequestBody, storyboardSegments } from "../../storyboard/storyboard.js";
import { RUN_LABELS, gateOf, runKind, upstreamNodes } from "./node-types.js";
import { ANCHOR_CHOICES, CONTEXT_FRAMES_CHOICES, CONTEXT_FRAMES_DEFAULT,
    GEN_COUNT_MAX, GEN_PARAM_KEYS, SEG_SEC_MAX, SEG_SEC_MIN, SEED_MAX, STEPS_CHOICES, STEPS_MAX,
    mergeGenOverrides, readEditParams, readGenOverrides, readGenParams, readRecipeParams } from "./gen-params.js";
import { REF_BUCKETS, chainCars, chainRecipe, genInputs, isCar, mediaNodes, reverseFirstImage, segmentRefs } from "./gen-graph.js";

// 参数读法在 gen-params.js，连线图上的取用在 gen-graph.js（都是纯读法，不持页面状态）：这一层只管三条链
// 的请求构造、运行态与卡面控件。
// 画布自己记的默认技能（绘画页与视频页各记各的，同一套法）：新建生成节点带出上一次在这页选的技能
const LAST_SKILL_KEY = "neo.canvas.skill";
const LAST_VIDEO_SKILL_KEY = "neo.canvas.video.skill";
const CLIP_TERMINAL = ["succeeded", "failed", "cancelled"];
const CLIP_POLL_MS = 1000;        // 简单视频与单段任务只有轮询快照：画布就在眼前，进度比出视频页那一格更快

// 增强与反推两条 LLM 链在卡面上说的话在 node-types.js 的 RUN_LABELS 里（运行钮、状态行与提示条共用）

/** SSE 帧体 → 帧对象：非 JSON 的帧（心跳、注释行）交 null，读流那一条不收它当正文 */
function llmFrame(data) {
    try { return JSON.parse(data); } catch { return null; }
}

export function createCanvasGen({ $el, toast, api, canFeature, host, modeGroup, groupLabels }) {
    // 一发一份运行态（节点上那一行状态就是它）。watchTask 在终态自己摘监听；切画布只把这一发脱手：
    // 图已经落在 Output 目录，不再写回旧画布，也不在页面外头留一份没人收的监听
    const running = new Map();
    const detached = new Set();
    const timers = new Map();     // 轮询链（简单视频 / 配方单段）的计时句柄：task_id → setInterval
    const chains = new Map();     // 串联的车尾节点 id → 这一列还在跑的段节点 id（车尾的进度与整列取消读它）
    const llmRuns = new Map();    // 增强 / 反推的在途一发：节点 id → {abort, stopped}（取消与脱手都按节点摘这一发）
    const skills = { rows: [], inflight: null };
    const enhanceSkills = { rows: [], inflight: null };
    const videoSkills = { rows: [], inflight: null };
    const recipes = { rows: [], inflight: null };
    const cfgs = { byId: new Map(), inflight: new Map() };
    const chips = new Set();
    // 技能 + 自定参数那一枚胶囊按节点存一份（nodeId → 签名 + 那一套表单）：patchMeta 每改一格就整层重画，
    // 面板每重画一次重建的话，下拉的焦点与滚动位置全丢了 —— 签名没变就接同一块；openParams 记着
    // 「这台节点的面板开着」，重画完在原处接着弹开
    const paramsChips = new Map();
    const openParams = new Set();
    // 自定参数那两块表单要列的模型清单（生图与生视频各一份，与出视频页那份 videoModels 同一判法）：
    // 没到手就不发覆盖值，各节点照技能 config 与全局设置走，弹窗里的模型行也铺不出东西
    let genModels = null;
    let videoModels = null;
    // 胶囊菜单挂在页面给的浮层里（世界层带 scale、节点裁剪自己的内容，菜单进那一层会跟着缩放并被节点切掉）。
    // 节点每重画一次控件就整份重建，挂出去的菜单元素由页面在那一层里一起清掉 —— 收菜单只看 document 起手这一下
    document.addEventListener("pointerdown", (e) => {
        for (const chip of chips) {
            if (!chip.el.isConnected) chips.delete(chip);
            else if (chip.isOpen()) chip.closeOnOutside(e.target);
        }
        // 节点没了（删节点、切画布）就把这台节点的表单连同开着的面板一起收掉：那一层里没有节点认得它了
        for (const [id, entry] of paramsChips) {
            if (host.hasNode(id)) continue;
            chips.delete(entry.chip);
            entry.chip.close();
            paramsChips.delete(id);
        }
    }, true);

    function loadSkills() {
        if (skills.rows.length) return Promise.resolve(skills.rows);
        if (!skills.inflight) {
            skills.inflight = listSkills()
                .then((rows) => {
                    skills.rows = (rows || []).filter((s) => s.gen_image && skillAcceptsText(s));
                    return skills.rows;
                })
                .catch(() => [])
                .finally(() => { skills.inflight = null; });
        }
        return skills.inflight;
    }

    /** 增强节点的技能胶囊要列的那一份：与首页「提示词增强」页同一判法（吃正文的那几条增强技能）。
     *  生图技能不在这一份里 —— 增强链不跑图，画布上的技能列表与那一页必须同一口径 */
    function loadEnhanceSkills() {
        if (enhanceSkills.rows.length) return Promise.resolve(enhanceSkills.rows);
        if (!enhanceSkills.inflight) {
            enhanceSkills.inflight = listSkills()
                .then((rows) => { enhanceSkills.rows = (rows || []).filter(isEnhanceSkill); return enhanceSkills.rows; })
                .catch(() => [])
                .finally(() => { enhanceSkills.inflight = null; });
        }
        return enhanceSkills.inflight;
    }

    function skillName(id) {
        if (!id) return t("未选技能");
        const hit = skills.rows.find((s) => s.id === id);
        return hit ? skillDisplayName(hit) : id;
    }

    /** 「加图像生成节点」的默认技能：上次在这页选的那一个，没有就落内置生图技能 */
    function defaultSkillId() {
        let last = "";
        try { last = localStorage.getItem(LAST_SKILL_KEY) || ""; } catch { /* 隐私模式记不住就算了，不挡建节点 */ }
        if (skills.rows.some((s) => s.id === last)) return last;
        return skills.rows.some((s) => s.id === "image_gen") ? "image_gen" : (skills.rows[0]?.id || "");
    }

    /** 「加图像编辑节点」的默认技能：编辑链默认那一张（Qwen Image 2.1 —— 参考图槽位最宽、编辑触发词钉在它
     *  的 config 里），技能列表里没有就落第一张。编辑节点不跟着「加图像生成节点」记住的上一次：那一档记的是
     *  出图技能，吃不吃参考图两回事 */
    function defaultEditSkillId() {
        return skills.rows.some((s) => s.id === QWEN_IMAGE_SKILL_ID) ? QWEN_IMAGE_SKILL_ID : (skills.rows[0]?.id || "");
    }

    /** 视频技能（带 workflow.json 的 gen_video）：与出视频页同一份来源，画布上共用一份列表 */
    function loadVideoSkills() {
        if (videoSkills.rows.length) return Promise.resolve(videoSkills.rows);
        if (!videoSkills.inflight) {
            videoSkills.inflight = listVideoSkills()
                .then((rows) => { videoSkills.rows = rows || []; return videoSkills.rows; })
                .catch(() => [])
                .finally(() => { videoSkills.inflight = null; });
        }
        return videoSkills.inflight;
    }

    /** 「加视频生成节点」的默认技能：上次在这页选的那一个，没有就落列表里第一张 */
    function defaultVideoSkillId() {
        let last = "";
        try { last = localStorage.getItem(LAST_VIDEO_SKILL_KEY) || ""; } catch { /* 隐私模式记不住就算了，不挡建节点 */ }
        if (videoSkills.rows.some((s) => s.id === last)) return last;
        return videoSkills.rows[0]?.id || "";
    }

    /** 自定参数那两块表单要列的模型清单（生图与生视频各一份）：到手重画一次，
     *  节点上那行主模型摘要跟着生效值走；取不到（离线）就整页不发覆盖值 */
    function loadModelLists() {
        if (!genModels) listGenModels()
            .then((rows) => { genModels = rows || {}; host.paintNodes(); }).catch(() => {});
        if (!videoModels) listVideoGenModels()
            .then((rows) => { videoModels = rows || {}; host.paintNodes(); }).catch(() => {});
    }

    /** 视频技能 id 在卡上怎么写：列表里有就用技能自己的名字，没有（技能被删了、列表没取到）就照存的 id 说 */
    function videoSkillName(id) {
        if (!id) return "";
        const hit = videoSkills.rows.find((s) => s.id === id);
        return hit ? skillDisplayName(hit) : id;
    }

    /** 导演配方列表（单段生成只认用户配方：内置预设只读，后端会直接拒；没有一段的配方在这里只会撞到「段序号越界」） */
    function loadRecipes() {
        if (recipes.rows.length) return Promise.resolve(recipes.rows);
        if (!recipes.inflight) {
            recipes.inflight = listRecipes()
                .then((rows) => {
                    recipes.rows = (rows || []).filter((r) => r?.type === "video_director" && r.source !== "preset"
                        && (r.segments?.length || 0) > 0);
                    return recipes.rows;
                })
                .catch(() => [])
                .finally(() => { recipes.inflight = null; });
        }
        return recipes.inflight;
    }

    function recipeRow(name) {
        return recipes.rows.find((r) => r.name === String(name || "")) || null;
    }

    /** 密度行上的停用说法：停用的那一张在生成卡与车厢最后一行都写出来，启用与停用都从双击节点那一发来 */
    function densityTitle(node) {
        return node.metadata?.disabled === true
            ? ` · ${t("已停用 · 双击节点启用")}`
            : ` · ${t("停用 · 双击节点停用")}`;
    }

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

    function stateOf(node) {
        const st = running.get(node.id);
        return {
            status: st?.status || "",
            // kind 给状态行认串联的车尾：那一行数的是链上的段数，不是某一发的步数
            kind: st?.kind || "",
            done: st?.done || 0,
            total: st?.total || 0,
            error: st?.error || "",
        };
    }

    function setRunning(id, patch) {
        running.set(id, { ...(running.get(id) || {}), ...patch });
        host.paintNodes();
    }

    /** 这一张节点那一发在提示条里说的话（RUN_LABELS 里那一行）：节点已经不在这一张画布上（切走了、撤销掉了）
     *  就按生图那一发收 —— 图与片都已经在 Output 目录里，只剩一句落点 */
    function labelsOf(nodeId) {
        const node = host.getState().nodes.find((n) => n.id === nodeId);
        return RUN_LABELS[node ? runKind(node) : "image"];
    }

    function finish(nodeId, snap) {
        const fell = detached.delete(snap.task_id);
        const labels = labelsOf(nodeId);
        if (snap.status === "succeeded") {
            running.delete(nodeId);
            host.paintNodes();
            // 切画布时脱手的那一发、以及节点已被删掉的：图就在 Output 目录里，不往现在这张画布上写
            if (fell || !host.hasNode(nodeId)) { toast(t(labels.fell), "success"); return; }
            host.applyResult(nodeId, snap.images || []);
            toast(tf(labels.doneN, { n: (snap.images || []).length }), "success");
            return;
        }
        if (snap.status === "cancelled") {
            running.delete(nodeId);
            host.paintNodes();
            toast(t(labels.cancelled), "info");
            return;
        }
        const msg = String(snap.error || "");
        const needKey = ["GEMINI_API_KEY", "GOOGLE_API_KEY"].some((k) => msg.includes(k)) || msg.includes("apiKey");
        running.set(nodeId, { ...(running.get(nodeId) || {}),
            status: "failed", error: needKey ? t("技能缺 API Key，在技能管理里填好再出图") : msg });
        host.paintNodes();
        if (needKey) {
            toast(t("技能缺 API Key，已为你打开技能管理"), "info");
            return;
        }
        toast(`${t(labels.failToast)}${msg ? `：${msg}` : ""}`, "error");
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
        for (const w of storyboardDurationWrites(patches, chainRecipe(live))) writeSegmentDuration(w);
        host.paintNodes();
        const note = storyboardMismatchText(segments.length, live.length);
        if (note) toast(note, "info");
        toast(tf(run.done, { n: patches.length }), "success");
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

    /** 切画布项目：这一发脱手 —— 图落在 Output 目录里，不再写回旧画布，也不在页面外头留一份没人收的监听 */
    function detachTask(taskId, nodeId) {
        detached.add(taskId);
        running.delete(nodeId);
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

    /** 技能 config 缓存：节点上「主模型」那一行与比例 / 长边的跟随态读它。一份技能只取一次
     *  （画布上同技能的节点共用这一份），取到手才重画节点 */
    function cfgOf(skillId) {
        return cfgs.byId.get(String(skillId || "")) || null;
    }

    function primeCfg(skillId) {
        const id = String(skillId || "");
        if (!id || cfgs.byId.has(id) || cfgs.inflight.has(id)) return;
        const inflight = getSkillGenConfig(id)
            .then((cfg) => { cfgs.byId.set(id, cfg || {}); host.paintNodes(); })
            .catch(() => { cfgs.byId.set(id, {}); })
            .finally(() => { cfgs.inflight.delete(id); });
        cfgs.inflight.set(id, inflight);
    }

    /** 节点上那行主模型：技能 config 里的那一个；比例与尺寸由技能自己定时说清楚。
     *  自定参数存在时这一行说的是这一发真正生效的那一套（换掉的主模型 / LoRA 条数 / 步数）。
     *  串联的车尾不铺这一行（段数、技能、分辨率都在顶行与那两枚胶囊上，见 chainControls） */
    function modelText(node) {
        const cfg = cfgOf(node.metadata.skill_id);
        if (!cfg) return `${t("主模型：读取中")}${densityTitle(node)}`;
        const ov = readGenOverrides(node);
        const model = ov.model || cfg.model;
        const parts = [model ? tf("主模型：{model}", { model: shortModelName(model) }) : t("主模型：跟随技能配置")];
        if (ov.loras?.length) parts.push(tf("LoRA ×{n}", { n: ov.loras.length }));
        if (ov.steps) parts.push(tf("{n} 步", { n: ov.steps }));
        return `${parts.join(" · ")}${densityTitle(node)}`;
    }

    function genBtn(label, iconName, onclick, title = label, disabled = false, extraClass = "") {
        // disabled 走属性：$el 把它当普通属性落，disabled="false" 在浏览器里就是真禁用（属性只看存在）
        const el = $el("button", { className: `ns-canvas-gen-btn${extraClass ? ` ${extraClass}` : ""}`,
            type: "button", title, "aria-label": title, onclick: disabled ? null : onclick });
        if (disabled) el.disabled = true;
        setIconLabel(el, iconName, label);
        return el;
    }

    /** 张数也是一枚胶囊：点开从 1 到 8 里选一枚（后端一次最多 8 张），不给它留第三格输入 */
    function countChip(node, params, busy) {
        const sel = $el("select", { disabled: busy, title: t("生图张数"),
            onchange: () => host.patchMeta(node.id, { count: Number(sel.value) || 1 }) });
        for (let i = 1; i <= GEN_COUNT_MAX; i += 1) {
            sel.append($el("option", { value: String(i), textContent: tf("{n} 张", { n: i }) }));
        }
        sel.value = String(params.count);
        return genChip(sel, { icon: "images" });
    }

    /** 节点上的一枚胶囊：菜单交页面那一层浮着（genMenus），控件自己留在节点里跟着缩放 */
    function genChip(sel, opts) {
        const chip = chipButton(sel, { ...opts, mount: () => host.genMenus() });
        chips.add(chip);
        return chip.el;
    }

    /** 那一枚技能胶囊里的技能下拉（共用胶囊把它当状态容器收在壳里，只列吃文字输入的生图技能）：
     *  技能被删了、列表没取到时把存的这一个也列出来，胶囊上不能看着是空的 */
    function paramsSkillSelect(node, busy, isVideo) {
        const saved = readGenParams(node).skill_id;
        const sel = $el("select", { disabled: busy,
            title: isVideo
                ? t("技能与自定参数：主模型 / LoRA 留空 = 跟随该技能配置与全局生视频设置")
                : t("技能与自定参数：只列吃文字输入的生图技能；主模型 / LoRA 留空 = 跟随该技能配置与全局生图设置"),
            onchange: () => {
                const id = sel.value;
                try { localStorage.setItem(isVideo ? LAST_VIDEO_SKILL_KEY : LAST_SKILL_KEY, id); } catch { /* 隐私模式记不住就算了，不挡出片 */ }
                // 换技能 = 技能钉的那一套整份换掉：这台节点自定的那几项跟着清空。patchMeta 要整层重画，
                // 记着「面板开着」才弹得回来 —— 绘画页选技能不收面板，右栏就是要看新技能钉的那一套
                openParams.add(node.id);
                host.patchMeta(node.id, { skill_id: id, gen_params: {} });
                primeCfg(id);
            } });
        sel.append($el("option", { value: "", textContent: t("未选技能") }));
        for (const s of (isVideo ? videoSkills.rows : skills.rows)) {
            const opt = $el("option", { value: s.id, textContent: skillDisplayName(s) });
            opt.__skillMeta = s;   // 面板左栏的技能分组与主模型家族守卫认的就是这一个
            sel.append(opt);
        }
        sel.value = saved;
        if (sel.value !== saved) {
            sel.value = "";
            sel.appendChild($el("option", { value: saved, textContent: saved, disabled: true, selected: true }));
        }
        return sel;
    }

    /** 出图 / 出片节点上那一枚技能胶囊就是绘画页与出视频页的那一枚（skillParamsChip）：点开的双栏面板
     *  左栏换技能、右栏改这一发的自定参数 —— 出图 = 主模型 + LoRA，出片 = 生视频模型 / Text Encoder /
     *  视频 VAE / 音频 VAE / 步数 + LoRA。空 = 跟随该技能 config 与全局生图 / 生视频设置：与技能钉的那一份
     *  相同的值不落盘，技能配置改了这台节点跟着走；改动当场写进 metadata.gen_params（进撤销栈、随画布落盘）。
     *  传了 `follow`（「跟随配方 …」那一句）就是串联车尾那一枚：只有技能一栏，出片参数不在这里改。
     *  表单按节点签名存一份（见 paramsChips）：改一格参数就整层重画，签名没变接同一块，面板不被重建；
     *  技能换了、模型清单到手、这一发开跑 —— 签名变了才换新的，面板开着时重画完接着在原处弹开 */
    function genParamsChip(node, { icon, isVideo, busy, follow }) {
        const tail = follow != null;   // 车尾那一枚：整列共用一个技能，参数是整列出片共用的那一份
        const skillId = readGenParams(node).skill_id;
        const models = isVideo ? videoModels : genModels;
        const key = `${tail ? "t" : isVideo ? "v" : "i"}|${skillId}|${(isVideo ? videoSkills : skills).rows.length}`
            + `|${busy ? 1 : 0}|${models ? 1 : 0}|${cfgOf(skillId) ? 1 : 0}|${tail ? follow : ""}`;
        // 撤销与切画布把节点对象整份换掉：闭包里那份旧的只能用来认 id，读值要拿画布上活着的那一台
        const live = () => host.getState().nodes.find((n) => n.id === node.id) || node;
        const keepOpen = openParams.has(node.id);   // 换旧的表单会收面板：这一份记着「收之前开着」，新的铺完接着弹开
        // 换表单那一路 old.chip.close() 走的是旧的 onClose，会把这一份抹掉：弹开之后要把它钉回去，
        // 下一发重画（技能 config 到手、模型清单到手）才认得出「这一台的面板还开着」
        const reopen = (chip) => { if (!keepOpen) return; chip.open(); openParams.add(node.id); };
        const old = paramsChips.get(node.id);
        if (old && old.key === key) {
            old.chip.sync();
            reopen(old.chip);
            return old;
        }
        if (old) {
            chips.delete(old.chip);
            old.chip.close();
            paramsChips.delete(node.id);
        }
        const skillSel = tail ? tailSkillSelect(node, busy, follow) : paramsSkillSelect(node, busy, isVideo);
        // 出片（含车尾那一枚）的右栏就是出视频页那块模型链表单；车尾改的这一段是整列出片共用的那一份
        const cfg = isVideo
            ? createVideoModelConfigSection()
            : createModelConfigSection({ getSkillId: () => readGenParams(live()).skill_id });
        const box = $el("div", { className: "neo-gallery-gm-model-box" }, [cfg.el]);
        if (!isVideo) {
            // 出图只露主模型与 LoRA：Text Encoder / VAE 是高级行，与绘画页那一条摘掉同一批
            for (const row of cfg.el.querySelectorAll(".rs-gen-adv-row")) row.remove();
            guardMainModelFamily(cfg, skillSel);   // 手填主模型与该技能家族对撞就当场收回这一选（绘画页同一判定）
        }
        if (tail) {
            // 车尾的步数在「参数」弹窗里（metadata.steps 那一份，与锚点 / 种子同处）：右栏只给模型链与 LoRA，一口子不两处
            box.querySelector(".rs-gen-steps")?.closest(".rs-config-row")?.remove();
        }
        const stored = readGenOverrides(live());
        const entry = {
            key,
            last: JSON.stringify(stored),
            chip: skillParamsChip(skillSel, box, {
                icon,
                getOverride: () => readGenOverrides(live()),
                // 出片技能按生成模式分组（出视频页同一份判法与词表）：全参考生视频那一组在画布上要看得见
                ...(isVideo ? { groupOf: modeGroup, groupLabels } : {}),
                panelClass: busy ? "ns-canvas-params-busy" : "",
                mount: () => host.genMenus(),
                onClose: () => openParams.delete(node.id),
            }),
        };
        chips.add(entry.chip);
        // 点开就记着「这台节点的面板开着」：整层重画完要在原处接着弹开（收窗那一路走 onClose 摘掉）
        entry.chip.chip.addEventListener("click", () => { if (entry.chip.isOpen()) openParams.add(node.id); });
        const write = () => {
            const ov = cfg.collect();
            const base = cfgOf(readGenParams(live()).skill_id) || {};
            const patch = {};
            for (const field of GEN_PARAM_KEYS) {
                const v = ov[field];
                if (v === "" || v == null) continue;
                if (field === "steps") {
                    // 步数没动过 = 这一发跟着技能配置走（出视频页同一判法）
                    if (cfg.stepsFollowSkill?.() || !(Number(v) > 0)) continue;
                    patch.steps = Math.min(Number(v), STEPS_MAX);
                    continue;
                }
                if (String(base[field] ?? "") === String(v)) continue;   // 与技能钉的一样 = 跟随，不钉死
                patch[field] = v;
            }
            const loras = (ov.loras || [])
                .filter((row) => String(typeof row === "string" ? row : row?.name || "").trim());
            if (loras.length) patch.loras = loras;
            const json = JSON.stringify(patch);
            if (json === entry.last) return;   // 真没改就不压撤销栈：加一条空 LoRA 行、点开下拉都算这一发
            entry.last = json;
            host.patchMeta(node.id, { gen_params: patch });
            entry.chip.sync();
        };
        cfg.el.addEventListener("change", write);
        // 删 LoRA 行（✕）与「+ 添加 LoRA」是按钮，不发 change：跟着点击写一次，不然删掉的那一条还钉在盘上
        cfg.el.addEventListener("click", write);
        // 模型清单没到手就不铺：面板里的模型行没有可列的东西，这一发照技能 config 与全局设置走
        if (models) cfg.load({ ...(cfgOf(skillId) || {}), ...stored }, models,
            { stepsFromRun: Number(stored.steps) >= 1 });
        paramsChips.set(node.id, entry);
        reopen(entry.chip);
        return entry;
    }


    /**
     * 铺在节点上的控件：技能与自定参数一枚胶囊，比例、长边、张数一行一枚，出图与取消在最后一行。
     * 改动当场走 host.patchMeta —— 进撤销栈、跟复制走、随画布落盘；比例与长边的「跟随」态跟着技能 config 走。
     */
    function controls(node) {
        const params = readGenParams(node);
        const st = running.get(node.id) || {};
        const busy = st.status === "queued" || st.status === "running";
        if (params.kind === "video") {
            // 串联的车尾那台生成节点的面与出视频页那一张不同：参数是整列共用的那一份
            return params.chain === "train" ? chainControls(node, busy) : videoControls(node, params, busy);
        }
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
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => cancel(node), t("取消这一发后台任务")));
        // 出图是这一张卡的主按钮：独占最后一行铺满、主色实心，一眼看见（参考无限画布卡片底部那条生成钮）
        acts.push(genBtn(t(labels.btn), "play", () => run(node),
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
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => cancel(node), t("取消这一发后台任务")));
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

    /** 增强 / 反推节点上的控件：一枚技能（增强）或语言（反推）胶囊 + 运行钮一行 —— 要重写的正文与
     *  要反推的那一张都不在这张节点上，从连过来的节点取（见 runEnhance 与 runReverse） */
    function llmControls(node) {
        const st = running.get(node.id) || {};
        const busy = st.status === "running";
        const isReverse = node.type === "reverse";
        const run = RUN_LABELS[runKind(node)];
        const acts = [];
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => cancel(node), t("取消这一发后台任务")));
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
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => cancel(node), t("取消这一发后台任务")));
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
