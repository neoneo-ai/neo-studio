// 画布上的生成节点：技能与参数存在节点 metadata 里（随画布落盘、进撤销栈、跟复制走）。这一层只做装配与
// 分发 —— 运行态在 gen-state.js，只读清单在 gen-catalog.js，卡面控件基座在 gen-controls.js，四条链按模型
// 依赖分族：出图族 gen-image.js（出图 / 编辑）、出片族 gen-video.js（简单视频链 + 每一段的轮询）、配方族
// gen-recipe.js（串联的车尾与车厢 + 配方列表的读法）、LLM 族 gen-llm.js（增强 / 反推 / 故事板）。族模块
// 只吃装配层交下来的 ctx（$el / toast / api / canFeature / host / modeGroup / groupLabels 与 runs /
// catalog / ctl / hooks），不直连页面、不自持跨请求的缓存；要跨族的那一手（车尾那一枚技能下拉、故事板写
// 段时长）由装配层点名接线，族与族之间不互拿。
// 结果写回该节点下游：图进图片节点，片进视频节点，成文进提示词节点与车厢。
import { t, tf } from "../../../js/core/i18n.js";
import { cancelTask } from "../../../image-gen.js";
import { RUN_LABELS, runKind } from "./node-types.js";
import { readGenParams } from "./gen-params.js";
import { segmentRefs } from "./gen-graph.js";
import { createCanvasCatalog } from "./gen-catalog.js";
import { createCanvasControls } from "./gen-controls.js";
import { createCanvasImage } from "./gen-image.js";
import { createCanvasLlm } from "./gen-llm.js";
import { createCanvasRecipe } from "./gen-recipe.js";
import { createCanvasState } from "./gen-state.js";
import { createCanvasVideo } from "./gen-video.js";

export function createCanvasGen({ $el, toast, api, canFeature, host, modeGroup, groupLabels }) {
    const runs = createCanvasState({ host, toast });
    const catalog = createCanvasCatalog({ host });
    // 卡上的运行钮与取消钮都走分发（按节点那一发的种类派到族里），族模块拿到的就是这两个点名好的入口
    const hooks = { run: (node) => run(node), cancel: (node) => cancel(node) };
    const ctl = createCanvasControls({ $el, host, catalog, groupLabels, modeGroup,
        tailSkillSelect: (...args) => recipe.tailSkillSelect(...args) });
    const video = createCanvasVideo({ $el, host, toast, api, canFeature, modeGroup, runs, catalog, ctl,
        hooks, chainStep: (carId) => recipe.chainStep(carId) });
    const recipe = createCanvasRecipe({ $el, host, toast, api, canFeature, modeGroup, runs, catalog, ctl,
        hooks, video });
    const image = createCanvasImage({ $el, host, toast, canFeature, runs, catalog, ctl, hooks });
    const llm = createCanvasLlm({ $el, host, toast, api, canFeature, runs, catalog, ctl, hooks,
        recipe: { writeSegmentDuration: (w) => recipe.writeSegmentDuration(w) } });
    const { running, chains, llmRuns, detached, stateOf, detachTask } = runs;
    const { loadSkills, loadEnhanceSkills, loadVideoSkills, loadRecipes, loadModelLists, skillName,
        defaultSkillId, defaultVideoSkillId, defaultEditSkillId } = catalog;
    const { modelText } = ctl;
    const { runImage, runEdit, imageControls, editControls } = image;
    const { runVideo, videoControls, stopClipPoll } = video;
    const { runChain, chainControls, recipeMetaText, recipeSegments, recipeCardText, recipeCards,
        carView, setCarDuration } = recipe;
    const { runEnhance, runReverse, runStoryboard, llmControls, storyboardControls } = llm;
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

    /** 「加视频生成节点」把视频技能列表取到手（与出视频页同一份来源） */
    function primeVideo() {
        loadVideoSkills().then(host.paintNodes).catch(() => {});
        loadModelLists();
    }

    /** 「添加配方」弹窗把配方列表与视频技能取到手：弹窗的卡与车厢上那行配方概览都读这两份 */
    function primeRecipes() {
        Promise.all([loadRecipes(), loadVideoSkills()]).then(() => host.paintNodes()).catch(() => {});
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
