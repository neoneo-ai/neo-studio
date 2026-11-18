// 画布上的生成节点：技能与参数存在节点 metadata 里（随画布落盘、进撤销栈、跟复制走），三条出片链共用
// 同一份运行态与同一条写回 —— 生图走 POST /neo_image_gen/generate + rs.image_gen.status 事件推送；
// 视频节点（metadata.kind = "video"）走出视频页那条简单视频链（POST /neo_video_gen/simple + 1s 轮询快照）；
// 配方闭环节点（type = "recipe"）走导演页单段那条链（POST /neo_video_gen/run_segment + 1s 轮询快照）。
// 结果写回该节点下游：图进图片节点，片进视频节点。
// 参数控件直接铺在节点上 —— 胶囊与比例字形是 gen-utils 那一套，与绘画页同一手感；节点缩放时控件跟着缩放，
// 拖节点用控件之外那一片，缩放走四角尺寸柄。胶囊是精简的那一枚（图标 + 生效值，没有行标签），
// 每一枚是干什么的写在悬停提示里。
// 这一层不持画布 state：读写全走页面交下来的那几条（host.getState / patchMeta / applyResult / paintNodes）。
import { t, tf } from "../../../js/core/i18n.js";
import { setIconLabel } from "../../../js/core/icons.js";
import { chipButton, ratioGlyph, VIDEO_DUR_CHOICES, VIDEO_SIZE_CHOICES } from "../../../gen-utils.js";
import { cancelTask, COMMON_EDGES, COMMON_RATIOS, getSkillGenConfig,
    requestGeneration, shortModelName, watchTask } from "../../../image-gen.js";
import { directorMetaText, listRecipes, listVideoSkills } from "../../../recipes.js";
import { listSkills, skillAcceptsText, skillDisplayName } from "../../../skill.js";

// 画布自己记的默认技能（绘画页与视频页各记各的，同一套法）：新建生成节点带出上一次在这页选的技能
const LAST_SKILL_KEY = "neo.canvas.skill";
const LAST_VIDEO_SKILL_KEY = "neo.canvas.video.skill";
const GEN_COUNT_MAX = 8;          // 后端 MAX_IMAGES：一次最多这么多张，画布上也不至于铺不满
const CLIP_TERMINAL = ["succeeded", "failed", "cancelled"];
const CLIP_POLL_MS = 1000;        // 简单视频与单段任务只有轮询快照：画布就在眼前，进度比出视频页那一格更快
// 锚点三档与后端 _ANCHOR_KEYS 同一份，文案沿用导演页那三个标签
const ANCHOR_CHOICES = [["both", "两端锚点（首+尾，最稳）"], ["first", "只钉首帧"], ["none", "不用锚点"]];
// 生成参数的边界与 NeoH3SegmentRun 的 widget 同一份（steps / context_frames 的 min-max）
const SEED_MAX = 9007199254740991;    // JS 能精确表示的整数上限，再大后端也接不住
const STEPS_MAX = 200;
const STEPS_CHOICES = [8, 12, 15, 20, 25, 30, 40, 60];
const CONTEXT_FRAMES_MAX = 362;
const CONTEXT_FRAMES_DEFAULT = 22;    // 导演页与后端同一个默认窗口
const CONTEXT_FRAMES_CHOICES = [0, 8, 14, 22, 29, 36];
// 连过来的素材按类型分三档，与后端段参考素材（refs.images / videos / audios）同一口径
const MEDIA_GROUPS = { image: "images", video: "videos", audio: "audios" };
// 配方卡上参考素材只铺得下这些张（段参考素材上限是 9 张，其余在计数里说清楚）
const RECIPE_REF_SHOWN = 4;
const CAR_REF_SHOWN = 2;      // 车厢是精简卡：素材缩略只留两枚，剩下的看数字

/** 生效参数：空串与 0 是「跟随」—— 技能 config 与全局生图/生视频设置由后端合并，请求里不带这一项 */
export function readGenParams(node) {
    const meta = node?.metadata || {};
    const count = parseInt(meta.count, 10);
    const duration = parseInt(meta.duration, 10);
    const width = Number(meta.width) > 0 ? Number(meta.width) : 0;
    const height = Number(meta.height) > 0 ? Number(meta.height) : 0;
    return {
        kind: meta.kind === "video" ? "video" : "image",
        chain: meta.chain === "train" ? "train" : "",   // 串联展开的车尾：出片是按链序跑启用的那几段
        skill_id: String(meta.skill_id || ""),
        default_ratio: String(meta.default_ratio || ""),
        base_resolution: Number(meta.base_resolution) > 0 ? Number(meta.base_resolution) : 0,
        count: count >= 1 && count <= GEN_COUNT_MAX ? count : 1,
        duration: VIDEO_DUR_CHOICES.includes(duration) ? duration : 5,
        width,
        height,
    };
}

/** 配方闭环节点上的参数：配方名、段序号（0 基，与后端 payload 同一口径）、锚点档位，
 *  与步数 / 种子 / 连续性 / 上下文帧。-1 与「跟随」是同一件事：请求里带着 -1，后端按配方与全局设置合并 */
export function readRecipeParams(node) {
    const meta = node?.metadata || {};
    const segment = parseInt(meta.segment, 10);
    const seed = Number(meta.seed);
    const steps = Number(meta.steps);
    const window = Number(meta.context_frames);
    return {
        recipe: String(meta.recipe || ""),
        segment: Number.isFinite(segment) && segment >= 0 ? segment : 0,
        anchors: ANCHOR_CHOICES.some(([key]) => key === meta.anchors) ? meta.anchors : "both",
        steps: Number.isFinite(steps) && steps >= 1 ? Math.min(steps, STEPS_MAX) : -1,
        seed: Number.isFinite(seed) && seed >= 0 ? Math.min(seed, SEED_MAX) : -1,
        continuity: meta.continuity !== false,
        context_frames: Number.isFinite(window) && window >= 0
            ? Math.min(window, CONTEXT_FRAMES_MAX) : CONTEXT_FRAMES_DEFAULT,
    };
}

/** 这一发的输入：上游连线里的提示词按连线顺序拼接；图片 / 视频 / 音频按参考素材那套标注给后端 ——
 *  画布图片节点存的正是 Output 目录里的那一份，[output] 标注让后端从输出目录取并拷进 input；
 *  带 asset 的图片节点是「展开配方」铺进来的配方素材，文件在配方自己那一份 assets/ 里，
 *  连配方名一起交后端，由后端拷进 input 再用；停用的那一张不进这一发（节点上的「停用」是通用功能） */
export function genInputs(state, genNodeId) {
    const prompts = [];
    const references = { images: [], videos: [], audios: [] };
    const seen = new Set();
    for (const conn of state.connections) {
        if (conn.toNodeId !== genNodeId) continue;
        const node = state.nodes.find((n) => n.id === conn.fromNodeId);
        if (!node || node.metadata?.disabled === true) continue;
        const text = String(node.metadata?.content || "").trim();
        if (node.type === "text" && text) prompts.push(text);
        const group = MEDIA_GROUPS[node.type];
        if (!group) continue;
        const filename = String(node.metadata?.filename || "");
        const sub = String(node.metadata?.subfolder || "");
        // 「展开配方」铺进来的素材节点：文件在配方自己那一份 assets/ 里，把配方名一起交后端去取
        const asset = String(node.metadata?.asset || "");
        const recipe = String(node.metadata?.recipe || "");
        const key = filename ? `${sub ? `${sub}/` : ""}${filename}[output]` : `${recipe}/${asset}`;
        // 同一个节点往这一台生成节点上连两条线，参考素材也只算一份
        if (!key || seen.has(key)) continue;
        seen.add(key);
        references[group].push(filename
            ? { kind: "input", value: key }
            : { kind: "recipe", value: asset, recipe });
    }
    return { prompts, references };
}

export function createCanvasGen({ $el, toast, api, canGen, startComfy, host }) {
    // 一发一份运行态（节点上那一行状态就是它）。watchTask 在终态自己摘监听；切画布只把这一发脱手：
    // 图已经落在 Output 目录，不再写回旧画布，也不在页面外头留一份没人收的监听
    const running = new Map();
    const detached = new Set();
    const timers = new Map();     // 轮询链（简单视频 / 配方单段）的计时句柄：task_id → setInterval
    const chains = new Map();     // 串联的车尾节点 id → 这一列还在跑的段节点 id（车尾的进度与整列取消读它）
    const skills = { rows: [], inflight: null };
    const videoSkills = { rows: [], inflight: null };
    const recipes = { rows: [], inflight: null };
    const cfgs = { byId: new Map(), inflight: new Map() };
    const chips = new Set();
    // 胶囊菜单挂在页面给的浮层里（世界层带 scale、节点裁剪自己的内容，菜单进那一层会跟着缩放并被节点切掉）。
    // 节点每重画一次控件就整份重建，挂出去的菜单元素由页面在那一层里一起清掉 —— 收菜单只看 document 起手这一下
    document.addEventListener("pointerdown", (e) => {
        for (const chip of chips) {
            if (!chip.el.isConnected) chips.delete(chip);
            else if (chip.isOpen()) chip.closeOnOutside(e.target);
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

    function skillName(id) {
        if (!id) return t("未选技能");
        const hit = skills.rows.find((s) => s.id === id);
        return hit ? skillDisplayName(hit) : id;
    }

    /** 「加生成节点」的默认技能：上次在这页选的那一个，没有就落内置生图技能 */
    function defaultSkillId() {
        let last = "";
        try { last = localStorage.getItem(LAST_SKILL_KEY) || ""; } catch { /* 隐私模式记不住就算了，不挡建节点 */ }
        if (skills.rows.some((s) => s.id === last)) return last;
        return skills.rows.some((s) => s.id === "image_gen") ? "image_gen" : (skills.rows[0]?.id || "");
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

    /** 「加视频节点」的默认技能：上次在这页选的那一个，没有就落列表里第一张 */
    function defaultVideoSkillId() {
        let last = "";
        try { last = localStorage.getItem(LAST_VIDEO_SKILL_KEY) || ""; } catch { /* 隐私模式记不住就算了，不挡建节点 */ }
        if (videoSkills.rows.some((s) => s.id === last)) return last;
        return videoSkills.rows[0]?.id || "";
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

    /** 节点上那行配方概览：段数 · 模式 · 技能 · 宽高 · 总时长（与配方卡片那一行同一份文本） */
    function recipeMetaText(node) {
        const { recipe } = readRecipeParams(node);
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
            offline: canGen() === false,
        };
    }

    function setRunning(id, patch) {
        running.set(id, { ...(running.get(id) || {}), ...patch });
        host.paintNodes();
    }

    function finish(nodeId, snap) {
        const fell = detached.delete(snap.task_id);
        if (snap.status === "succeeded") {
            running.delete(nodeId);
            host.paintNodes();
            // 切画布时脱手的那一发、以及节点已被删掉的：图就在 Output 目录里，不往现在这张画布上写
            if (fell || !host.hasNode(nodeId)) { toast(t("图已存进 Output 目录"), "success"); return; }
            host.applyResult(nodeId, snap.images || []);
            toast(tf("已出图 {n} 张", { n: (snap.images || []).length }), "success");
            return;
        }
        if (snap.status === "cancelled") {
            running.delete(nodeId);
            host.paintNodes();
            toast(t("已取消出图"), "info");
            return;
        }
        const msg = String(snap.error || "");
        const needKey = ["GEMINI_API_KEY", "GOOGLE_API_KEY"].some((k) => msg.includes(k)) || msg.includes("apiKey");
        running.set(nodeId, { ...(running.get(nodeId) || {}),
            status: "failed", error: needKey ? t("技能缺 API Key，在技能管理里填好再出图") : msg });
        host.paintNodes();
        if (needKey) {
            toast(t("技能缺 API Key，已为你打开技能管理"), "info");
            startComfy?.();   // 页面把这一枚钮接去技能管理：缺 Key 就是要去填它
            return;
        }
        toast(`${t("出图失败")}${msg ? `：${msg}` : ""}`, "error");
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
        if (snap.status === "succeeded") {
            running.delete(nodeId);
            host.paintNodes();
            if (fell || !host.hasNode(nodeId)) { toast(t("视频已存进 Output 目录"), "success"); return; }
            host.applyResult(nodeId, snap.filename
                ? [{ filename: snap.filename, subfolder: snap.subfolder || "" }] : [], "video");
            toast(t("已出片"), "success");
            return;
        }
        if (snap.status === "cancelled") {
            running.delete(nodeId);
            host.paintNodes();
            toast(t("已取消出片"), "info");
            return;
        }
        const msg = String(snap.error || "");
        running.set(nodeId, { ...(running.get(nodeId) || {}), status: "failed", error: msg });
        host.paintNodes();
        toast(`${t("出片失败")}${msg ? `：${msg}` : ""}`, "error");
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
        Promise.resolve(startComfy())
            .then(() => api.fetchApi(path, { method: "POST",
                headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
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
                toast(`${t("出片失败")}：${msg}`, "error");
            });
    }

    /** 出片的公共闸门：停用的那一张不跑；这一发在跑就不重复提交；离线按一下就替用户去启执行队列（与出图同一套做法） */
    function clipGate(node) {
        if (node.metadata?.disabled === true) {
            toast(t("这台节点已停用：在节点上方的浮出栏里启用"), "info");
            return true;
        }
        if (running.has(node.id)) return true;
        if (canGen() === false) {
            startComfy?.();
            toast(t("出片需要 ComfyUI 执行队列，已试着启动，好了再按一次"), "warn");
            return true;
        }
        return false;
    }

    /** 视频节点出片：上游正文拼成提示词，上游图片按 [output] 标注交后端取用（首帧 / 参考同一份来源）。
     *  简单视频链的参考素材只有图这一档（首帧 / 参考图），连过来的视频与音频不进这一发 */
    function runVideo(node) {
        if (clipGate(node)) return;
        const params = readGenParams(node);
        if (!params.skill_id) { toast(t("先选一个视频技能"), "info"); return; }
        const { prompts, references } = genInputs(host.getState(), node.id);
        const skill = videoSkills.rows.find((s) => s.id === params.skill_id);
        // 后端对这批技能是硬要求（无首帧的 i2v / 无参考的 r2v 必败），在画布上说清楚比跑完再报错省一整发
        if (skill?.requires_ref && !references.images.length) {
            toast(t("这一发要参考素材：把一张图连到这台节点上"), "info");
            return;
        }
        if (!prompts.length) { toast(t("接一条文本线过来再出片"), "info"); return; }
        const body = { prompt: prompts.join("\n\n"), skill_id: params.skill_id, references: references.images,
            last_frame: null, duration_sec: params.duration, seed: -1 };
        if (params.width && params.height) { body.width = params.width; body.height = params.height; }
        submitClip("/neo_video_gen/simple", body, "video", node);
    }

    /** 配方闭环节点出片：配方名、段序号与锚点 / 步数 / 种子 / 连续性 / 上下文帧都从节点 metadata 交出去，
     *  连到这台节点的正文与素材按画布覆盖交后端（只影响这一发，配方自己那一份不动）；成片落进下游视频节点。
     *  串联展开铺的段节点（metadata.train）参数在它那一列的车尾上：停用与断链都明说，不静默按默认值跑 */
    function runSegment(node) {
        if (clipGate(node)) return;
        const params = readRecipeParams(node);
        if (!params.recipe) { toast(t("先选一份配方"), "info"); return; }
        const { prompts, references } = genInputs(host.getState(), node.id);
        submitClip("/neo_video_gen/run_segment",
            { ...params, prompt: prompts.join("\n\n"), references },
            "segment", node);
    }

    /** 串联的一列出片：按链序把启用的那几段依次入队 —— ComfyUI 队列自己按提交顺序跑，
     *  跑法与在导演页逐段出片相同，成片各落各的下游视频位，停用的那几段不进这一发 */
    function runChain(node) {
        if (clipGate(node)) return;
        const params = readRecipeParams(node);
        if (!params.recipe) { toast(t("先选一份配方"), "info"); return; }
        const cars = chainCars(host.getState(), node.id);
        if (!cars.length) { toast(t("这台生成节点上游没有段节点：用串联展开铺一列"), "info"); return; }
        const live = cars.filter((car) => car.metadata.disabled !== true);
        if (!live.length) { toast(t("链上没有启用的段"), "info"); return; }
        chains.set(node.id, new Set(live.map((car) => car.id)));
        setRunning(node.id, { kind: "chain", task_id: "", status: "running", done: 0, total: live.length, error: "" });
        const state = host.getState();
        for (const car of live) submitCar(state, params, car);
    }

    /** 串联里一段的载荷：车尾的公共参数 + 这一段的段号与画布连过来的正文 / 素材。
     *  种子按段号偏移（与平铺展开逐段出片同一口径），-1 就是这一段每次换种子 */
    function submitCar(state, shared, car) {
        const segment = readRecipeParams(car).segment;
        const { prompts, references } = genInputs(state, car.id);
        submitClip("/neo_video_gen/run_segment",
            { ...shared, segment, seed: shared.seed === -1 ? -1 : shared.seed + segment,
                prompt: prompts.join("\n\n"), references },
            "segment", car);
    }

    /** 串联铺出来的那台段节点：参数在车尾，这一段只带配方名与段号 */
    function isCar(node) {
        return node?.type === "recipe" && node.metadata?.train === 1;
    }

    /** 链序：链边是「段 → 下一段 → … → 车尾」，从车尾沿链往回走到车头再翻过来。
     *  链被剪断就停在走到的那一段，成环靠 seen 停下 */
    function chainCars(state, tailNodeId) {
        const nodeOf = (id) => state.nodes.find((n) => n.id === id) || null;
        const carUp = (id) => state.connections
            .map((c) => (c.toNodeId === id ? nodeOf(c.fromNodeId) : null))
            .find((n) => isCar(n)) || null;
        const out = [];
        const seen = new Set();
        let cur = carUp(tailNodeId);
        while (cur && !seen.has(cur.id)) {
            seen.add(cur.id);
            out.push(cur);
            cur = carUp(cur.id);
        }
        return out.reverse();
    }

    /** 这一段那一列的车尾：沿链往下走到那台生成节点（链剪断了交 null，出片要明说没有参数来源） */
    function chainTail(state, carId) {
        const nodeOf = (id) => state.nodes.find((n) => n.id === id) || null;
        const seen = new Set([carId]);
        let cur = carId;
        for (;;) {
            const next = state.connections
                .map((c) => (c.fromNodeId === cur ? nodeOf(c.toNodeId) : null))
                .find((n) => n && !seen.has(n.id)
                    && (isCar(n) || (n.type === "gen" && readGenParams(n).chain === "train")));
            if (!next) return null;
            if (!isCar(next)) return next;
            seen.add(next.id);
            cur = next.id;
        }
    }

    /** 节点上那枚出片钮的入口：配方闭环节点出这一段，串联的车尾按链序跑启用的那几段，
     *  视频节点出片，生成节点出图 */
    function run(node) {
        if (node.type === "recipe") return runSegment(node);
        const params = readGenParams(node);
        if (params.kind !== "video") return runImage(node);
        return params.chain === "train" ? runChain(node) : runVideo(node);
    }

    function runImage(node) {
        // 停用的那一张按一下就明说自己不跑：这条要说清「已停用」，排在「这一发在跑」之前（跑着的那一发不该把这句吃掉）
        if (node.metadata?.disabled === true) {
            toast(t("这台节点已停用：在节点上方的浮出栏里启用"), "info");
            return;
        }
        if (running.has(node.id)) return;
        if (canGen() === false) {
            startComfy?.();   // 出图要执行队列：按一下就替用户去启它，这一发不排队
            toast(t("出图需要 ComfyUI 执行队列，已试着启动，好了再按一次"), "warn");
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
        Promise.resolve(startComfy())   // 宿主可以同步回话：不押它一定交 Promise
            .then(() => requestGeneration(body))
            .then((res) => {
                // requestGeneration 的契约：成功交后端那一份 {task_id,status}，失败抛 Error（落进 catch）
                setRunning(node.id, { kind: "image", task_id: res.task_id, status: res.status || "queued",
                    done: 0, total: params.count, error: "" });
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
                toast(`${t("出图失败")}：${msg}`, "error");
            });
    }

    function cancel(node) {
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
     *  串联的车尾不出自己的片，这一行说它带的是哪一份配方 */
    function modelText(node) {
        if (readGenParams(node).chain === "train") return recipeMetaText(node);
        const cfg = cfgOf(node.metadata.skill_id);
        if (!cfg) return t("主模型：读取中");
        return cfg.model ? tf("主模型：{model}", { model: shortModelName(cfg.model) }) : t("主模型：跟随技能配置");
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


    /**
     * 铺在节点上的控件：技能、比例、长边、张数一行一枚胶囊，出图与取消在右下角。
     * 改动当场走 host.patchMeta —— 进撤销栈、跟复制走、随画布落盘；比例与长边的「跟随」态跟着技能 config 走。
     */
    function controls(node) {
        // 串联的车厢是精简卡：卡上一枚钮都没有 —— 停用、复制与删除都在节点上方的浮出栏里，
        // 出片与整列共用的参数在车尾那台生成节点
        if (node.type === "recipe") return node.metadata.train === 1 ? [] : recipeControls(node);
        const params = readGenParams(node);
        const st = running.get(node.id) || {};
        const busy = st.status === "queued" || st.status === "running";
        if (params.kind === "video") {
            // 串联的车尾那台生成节点的面与出视频页那一张不同：参数是整列共用的那一份
            return params.chain === "train" ? chainControls(node, busy) : videoControls(node, params, busy);
        }
        const offline = canGen() === false;
        const cfg = cfgOf(params.skill_id);
        primeCfg(params.skill_id);

        const skillSel = $el("select", { disabled: busy, title: t("技能"), onchange: () => {
            const id = skillSel.value;
            try { localStorage.setItem(LAST_SKILL_KEY, id); } catch { /* 隐私模式记不住就算了，不挡出图 */ }
            host.patchMeta(node.id, { skill_id: id });
            primeCfg(id);
        } });
        skillSel.append($el("option", { value: "", textContent: t("未选技能") }));
        for (const s of skills.rows) skillSel.append($el("option", { value: s.id, textContent: skillDisplayName(s) }));
        skillSel.value = params.skill_id;
        if (skillSel.value !== params.skill_id) {
            // 技能列表没取到、或节点上存的技能被删了：把存的这一个也列出来，参数行不能看着是空的
            skillSel.value = "";
            skillSel.appendChild($el("option", { value: params.skill_id, textContent: params.skill_id,
                disabled: true, selected: true }));
        }

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

        const acts = [];
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => cancel(node), t("取消这一发后台任务")));
        // 出图是这一张卡的主按钮：独占最后一行铺满、主色实心，一眼看见（参考无限画布卡片底部那条生成钮）
        acts.push(genBtn(t("出图"), "play", () => run(node),
            // 离线不 disable：按下去就是要替用户去启队列的（run 里说清楚）；只有这一发在跑才收着
            offline ? t("出图需要 ComfyUI 执行队列") : t("提交这一发生图任务"), busy, "ns-canvas-gen-go"));
        return [
            $el("div", { className: "ns-canvas-gen-skill" }, [genChip(skillSel, { icon: "sparkles" })]),
            $el("div", { className: "ns-canvas-gen-params" },
                [genChip(ratioSel, { glyph: ratioGlyph() }), genChip(edgeSel, { icon: "image" }),
                    countChip(node, params, busy)]),
            $el("div", { className: "ns-canvas-gen-bottom" }, [$el("div", { className: "ns-canvas-gen-acts" }, acts)]),
        ];
    }

    /** 「加生成节点」把技能列表取到手：胶囊里列的就是那一份；技能被删了，旧画布上的节点要能认出来 */
    function prime() {
        loadSkills().then(host.paintNodes).catch(() => {});
    }

    /** 视频节点的面：技能、时长、尺寸与出片。时长与尺寸留着「跟随」—— 空着就按技能 config 与全局生视频设置走，
     *  与生图的比例 / 长边同一口径；参考素材从上游图片节点来，不在节点上再摆一格方块 */
    function videoControls(node, params, busy) {
        const skillSel = $el("select", { disabled: busy, title: t("技能"), onchange: () => {
            const id = skillSel.value;
            try { localStorage.setItem(LAST_VIDEO_SKILL_KEY, id); } catch { /* 隐私模式记不住就算了，不挡出片 */ }
            host.patchMeta(node.id, { skill_id: id });
        } });
        skillSel.append($el("option", { value: "", textContent: t("未选技能") }));
        for (const s of videoSkills.rows) skillSel.append($el("option", { value: s.id, textContent: skillDisplayName(s) }));
        skillSel.value = params.skill_id;
        if (skillSel.value !== params.skill_id) {
            // 视频技能列表没取到、或节点上存的技能被删了：把存的这一个也列出来，参数行不能看着是空的
            skillSel.value = "";
            skillSel.appendChild($el("option", { value: params.skill_id, textContent: params.skill_id,
                disabled: true, selected: true }));
        }

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

        const acts = [];
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => cancel(node), t("取消这一发后台任务")));
        acts.push(genBtn(t("生成视频"), "play", () => run(node),
            canGen() === false ? t("生成视频需要 ComfyUI 执行队列") : t("提交这一发生成视频任务"), busy));
        return [
            $el("div", { className: "ns-canvas-gen-skill" }, [genChip(skillSel, { icon: "film" })]),
            $el("div", { className: "ns-canvas-gen-params" },
                [genChip(durSel, { icon: "clock" }), genChip(sizeSel, { glyph: ratioGlyph() })]),
            $el("div", { className: "ns-canvas-gen-bottom" }, [$el("div", { className: "ns-canvas-gen-acts" }, acts)]),
        ];
    }

    /** 连到这一台节点的素材节点（按连线顺序）：出片交给后端的就是这一批，卡上也按这一批铺；
     *  停用的那一张既不进这一发也不在卡上露出来 */
    function mediaNodes(nodeId) {
        const state = host.getState();
        const out = [];
        for (const conn of state.connections) {
            if (conn.toNodeId !== nodeId) continue;
            const node = state.nodes.find((n) => n.id === conn.fromNodeId);
            if (!node || !MEDIA_GROUPS[node.type] || node.metadata?.disabled === true) continue;
            if (node.metadata?.filename || node.metadata?.asset) out.push(node);
        }
        return out;
    }

    /** 配方这一段自己的参考素材（recipe.json 记的是配方 assets/ 里的文件名）：首帧与分镜关键帧排最前 ——
     *  后端解析首帧与 refs.images 是同一路，卡上也要看见「这一段靠哪张图起头」 */
    function segmentRefs(seg) {
        const names = [];
        for (const key of ["first_frame", "storyboard"]) {
            const name = String(seg[key] || "");
            if (name && !names.includes(name)) names.push(name);
        }
        const refs = seg.refs && typeof seg.refs === "object" ? seg.refs : {};
        for (const key of ["images", "videos", "audios"]) {
            for (const name of (refs[key] || [])) if (name && !names.includes(name)) names.push(name);
        }
        return names;
    }

    /** 卡上一枚参考素材缩略：画布上的图走 Gallery 缩略图，配方素材走配方缩略图那条（都是按需生成），
     *  缩略图缓存不在时回原文件那一条 */
    function refThumb(node, asset, recipe) {
        const fromRecipe = !!asset;
        const name = fromRecipe ? asset : String(node?.metadata?.filename || "");
        const src = fromRecipe
            ? `/rs_recipes/thumbnail?recipe=${encodeURIComponent(recipe)}&file=${encodeURIComponent(asset)}&dir=assets&size=160`
            : `/neo_gallery/thumbnail?filename=${encodeURIComponent(name)}`
                + `&subfolder=${encodeURIComponent(node?.metadata?.subfolder || "")}&size=160`;
        return $el("img", {
            className: "ns-canvas-recipe-thumb", src, alt: name, draggable: "false",
            onerror: (e) => {
                e.target.src = fromRecipe
                    ? `/rs_recipes/asset?recipe=${encodeURIComponent(recipe)}&file=${encodeURIComponent(asset)}&dir=assets`
                    : "/neo_gallery/placeholder.png";
            },
        });
    }

    /** 配方闭环节点的面：配方、步数 / 锚点 / 连续性 / 上下文帧 / 种子、这一段概览、提示词来源、参考素材、
     *  段列表与出片都在这一张卡上。段一行的内容读配方自己那份 spec；换配方时段号回到第 1 段。
     *  连过来的正文与素材是「画布覆盖」：只影响这一发出片，配方里那一份不动（提示词来源那一行就说清楚用的是哪一份）。
     *  串联展开铺出来的那一台是车厢，不走这一张卡（车厢的面在 nodes.js 的 nodeCar） */
    function recipeControls(node) {
        const params = readRecipeParams(node);
        const st = running.get(node.id) || {};
        const busy = st.status === "queued" || st.status === "running";
        const segs = recipeRow(params.recipe)?.segments || [];
        const segCount = Math.max(segs.length, 1);
        const at = Math.min(params.segment, segCount - 1);
        const seg = segs[at] || {};
        const canvasPrompt = genInputs(host.getState(), node.id).prompts.join("\n\n");
        const canvasRefs = mediaNodes(node.id);
        const ownRefs = segmentRefs(seg);
        const shownRefs = [...canvasRefs.map((n) => ({ node: n })), ...ownRefs.map((name) => ({ asset: name }))]
            .slice(0, RECIPE_REF_SHOWN);
        const recipeSel = recipeSelect(node, busy);
        const { stepsSel, anchorSel, contSel, ctxSel, seedIn } = recipeParamSelects(node, busy);

        // 段一行：一枚一段、按段号排开，选中那一段抬到主色；悬停说这一段的时长与提示词
        const segChips = segs.map((s, i) => {
            const title = [tf("第 {n} 段", { n: i + 1 }),
                ...(Number(s.duration_sec) > 0 ? [tf("{n} 秒", { n: Number(s.duration_sec) })] : []),
                String(s.prompt || "").trim() || t("这一段没有提示词")].join(" · ");
            const btn = $el("button", { className: "ns-canvas-seg-btn" + (i === at ? " ns-canvas-seg-btn-on" : ""),
                type: "button", title, "aria-label": title, disabled: busy,
                onclick: () => host.patchMeta(node.id, { segment: i }) });
            btn.append($el("span", { textContent: tf("段 {n}", { n: i + 1 }) }));
            return btn;
        });

        const skillRow = videoSkills.rows.find((s) => s.id === String(seg.skill_id || ""));
        const segInfo = tf("第 {n} 段 · {sec} 秒 · {skill}", { n: at + 1,
            sec: Number(seg.duration_sec) || 0,
            skill: skillRow ? skillDisplayName(skillRow) : t("未选技能") });

        const acts = [];
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => cancel(node), t("取消这一发后台任务")));
        acts.push(genBtn(t("展开配方"), "maximize", () => host.expandRecipe?.(node),
            t("把每一段摊成段节点，提示词与参考素材摊成连过去的独立节点")));
        acts.push(genBtn(t("生成视频"), "play", () => run(node),
            canGen() === false ? t("生成视频需要 ComfyUI 执行队列") : t("生成这一段"), busy));

        const rows = [$el("div", { className: "ns-canvas-gen-skill" }, [genChip(recipeSel, { icon: "film" })])];
        rows.push($el("div", { className: "ns-canvas-gen-params" },
            [genChip(stepsSel, { icon: "gear" }), genChip(anchorSel, { icon: "plug" }),
                genChip(contSel, { icon: "history" })]));
        rows.push($el("div", { className: "ns-canvas-recipe-args" }, [genChip(ctxSel, { icon: "target" }), seedIn]));
        rows.push($el("div", { className: "ns-canvas-recipe-info" },
            [$el("span", { className: "ns-canvas-recipe-info-text", textContent: segInfo }),
                expandModeChip(node)]));
        // 提示词来源那一行就是「画布覆盖」的可见状态：连了正文就是画布那一份，没连就是配方那一份
        rows.push($el("div", { className: "ns-canvas-recipe-prompt" + (canvasPrompt ? " ns-canvas-recipe-on" : "") }, [
            $el("span", { className: "ns-canvas-recipe-src", textContent: canvasPrompt ? t("画布") : t("配方") }),
            $el("span", { className: "ns-canvas-recipe-text",
                textContent: canvasPrompt || String(seg.prompt || "").trim() || t("这一段没有提示词") }),
        ]));
        rows.push($el("div", { className: "ns-canvas-recipe-refs" }, [
            ...shownRefs.map((item) => refThumb(item.node, item.asset, params.recipe)),
            $el("span", { className: "ns-canvas-recipe-count",
                textContent: tf("{n} 张参考素材", { n: canvasRefs.length + ownRefs.length }) }),
        ]));
        rows.push($el("div", { className: "ns-canvas-recipe-segs" }, segChips));
        rows.push($el("div", { className: "ns-canvas-gen-bottom" }, [$el("div", { className: "ns-canvas-gen-acts" }, acts)]));
        return rows;
    }

    /** 配方那一枚胶囊的 select：配方列表没取到、或节点上存的配方被删了，把存的这一个也列出来，
     *  参数行不能看着是空的；换配方时段号回到第 1 段 */
    function recipeSelect(node, busy) {
        const { recipe } = readRecipeParams(node);
        const sel = $el("select", { disabled: busy, title: t("配方"), onchange: () => {
            host.patchMeta(node.id, { recipe: sel.value, segment: 0 });
        } });
        sel.append($el("option", { value: "", textContent: t("未选配方") }));
        for (const r of recipes.rows) sel.append($el("option", { value: r.name, textContent: r.name }));
        sel.dataset.follow = t("未选配方");   // 空着就是没选：胶囊上直接这么说，不是那句通用的「默认」
        sel.value = recipe;
        if (sel.value !== recipe) {
            sel.value = "";
            sel.appendChild($el("option", { value: recipe, textContent: recipe, disabled: true, selected: true }));
        }
        return sel;
    }

    /** 整列共用那一套生成参数的控件（步数 / 锚点 / 连续性 / 上下文帧 / 种子）：配方卡的参数行与串联的
     *  车尾生成节点读同一份，改动都走 patchMeta —— 空值与 -1 都是「跟随」，请求里带着它由后端合并 */
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

        const anchorSel = $el("select", { disabled: busy, title: t("锚点"),
            onchange: () => host.patchMeta(node.id, { anchors: anchorSel.value }) });
        for (const [key, label] of ANCHOR_CHOICES) {
            anchorSel.append($el("option", { value: key, textContent: t(label) }));
        }
        anchorSel.value = params.anchors;

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

    /** 展开方式那一挡：平铺是一段一行，串联是一段接一段、生成参数收到车尾。这一挡存在卡的 metadata 里，
     *  工具条与卡上的「展开配方」都按它铺 */
    function expandModeChip(node) {
        const train = node.metadata.expand_mode === "train";
        return genBtn(train ? t("串联展开") : t("平铺展开"), train ? "plug" : "list",
            () => host.patchMeta(node.id, { expand_mode: train ? "grid" : "train" }),
            t("展开配方怎么铺：平铺是一段一行，串联是一段接一段接到车尾"));
    }

    /** 车厢上显示的那一段读哪一份：配方与它的段 spec 取它那一列车尾的（公共参数只有一处，配方名也在
     *  车尾那一份上，换配方时车厢跟着换），车尾断了回落车厢自己存的这一份。段号、正文与素材是车厢自己的 */
    function carView(node) {
        const state = host.getState();
        const own = readRecipeParams(node);
        const tail = chainTail(state, node.id);
        const params = tail ? readRecipeParams(tail) : own;
        const seg = (recipeRow(params.recipe)?.segments || [])[own.segment] || {};
        const skillRow = videoSkills.rows.find((s) => s.id === String(seg.skill_id || ""));
        const canvasPrompt = genInputs(state, node.id).prompts.join("\n\n");
        const canvasRefs = mediaNodes(node.id);
        const ownRefs = segmentRefs(seg);
        return {
            head: tf("第 {n} 段 · {sec} 秒 · {skill}", { n: own.segment + 1,
                sec: Number(seg.duration_sec) || 0,
                skill: skillRow ? skillDisplayName(skillRow) : t("未选技能") }),
            fromCanvas: !!canvasPrompt,
            prompt: canvasPrompt || String(seg.prompt || "").trim() || t("这一段没有提示词"),
            refs: [...canvasRefs.map((n) => refThumb(n, "", params.recipe)),
                ...ownRefs.slice(0, CAR_REF_SHOWN).map((name) => refThumb(null, name, params.recipe))],
            count: canvasRefs.length + ownRefs.length,
        };
    }

    /** 串联车尾那台生成节点的面：整列共用的配方与生成参数都在这一张卡上，出片就是按链序把启用的那几段
     *  依次入队（与在导演页逐段出片同一发）。成片落各段的下游视频位，这台节点自己不落片 */
    function chainControls(node, busy) {
        const cars = chainCars(host.getState(), node.id);
        const live = cars.filter((car) => car.metadata.disabled !== true);
        const { stepsSel, anchorSel, contSel, ctxSel, seedIn } = recipeParamSelects(node, busy);
        const acts = [];
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => cancel(node), t("取消这一列在跑的段")));
        acts.push(genBtn(t("生成视频"), "play", () => run(node),
            canGen() === false ? t("生成视频需要 ComfyUI 执行队列") : t("按链序跑启用的那几段"), busy));
        return [
            $el("div", { className: "ns-canvas-gen-skill" }, [genChip(recipeSelect(node, busy), { icon: "film" })]),
            $el("div", { className: "ns-canvas-gen-params" },
                [genChip(stepsSel, { icon: "gear" }), genChip(anchorSel, { icon: "plug" }),
                    genChip(contSel, { icon: "history" })]),
            $el("div", { className: "ns-canvas-recipe-args" }, [genChip(ctxSel, { icon: "target" }), seedIn]),
            $el("div", { className: "ns-canvas-recipe-info",
                title: t("串联只管排布与顺序：出片就是逐段跑导演页那一条链") },
                [$el("span", { className: "ns-canvas-recipe-info-text",
                    textContent: tf("链上 {n} 段 · 启用 {m} 段", { n: cars.length, m: live.length }) })]),
            $el("div", { className: "ns-canvas-gen-bottom" }, [$el("div", { className: "ns-canvas-gen-acts" }, acts)]),
        ];
    }

    /** 「加视频节点」把视频技能列表取到手（与出视频页同一份来源） */
    function primeVideo() {
        loadVideoSkills().then(host.paintNodes).catch(() => {});
    }

    /** 「加配方节点」把配方列表与视频技能取到手：段那一列与那行配方概览都读这两份 */
    function primeRecipes() {
        Promise.all([loadRecipes(), loadVideoSkills()]).then(() => host.paintNodes()).catch(() => {});
    }

    /** 展开配方要读的段列表：配方列表没取到（离线、配方被删）时交空数组，页面据此说明原因 */
    function recipeSegments(name) {
        return recipeRow(name)?.segments || [];
    }

    return {
        stateOf,
        skillName,
        defaultSkillId,
        defaultVideoSkillId,
        modelText,
        recipeMetaText,
        recipeSegments,
        carView,
        controls,
        prime,
        primeVideo,
        primeRecipes,
        run,
        cancel,
        stopAll,
    };
}
