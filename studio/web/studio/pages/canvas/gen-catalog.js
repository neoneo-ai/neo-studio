// 画布生成层的只读清单：生图 / 增强 / 生视频技能、导演配方、技能 config、模型清单各一份，一份只取一次
// （画布上同技能的节点共用这一份），取到手交回去整层重画。清单取不到（离线、技能被删）一律交空列表 ——
// 卡面据此说「未选技能」，覆盖值不发。这一层只有读法与取法，不持运行态。
import { t } from "../../../js/core/i18n.js";
import { QWEN_IMAGE_SKILL_ID } from "../../../gen-utils.js";
import { getSkillGenConfig, listGenModels, listVideoGenModels } from "../../../image-gen.js";
import { listRecipes, listVideoSkills } from "../../../recipes.js";
import { listSkills, skillAcceptsText, skillDisplayName, isEnhanceSkill } from "../../../skill.js";

// 画布自己记的默认技能（绘画页与视频页各记各的，同一套法）：新建生成节点带出上一次在这页选的技能
export const LAST_SKILL_KEY = "neo.canvas.skill";
export const LAST_VIDEO_SKILL_KEY = "neo.canvas.video.skill";

export function createCanvasCatalog({ host }) {
    const skills = { rows: [], inflight: null };
    const enhanceSkills = { rows: [], inflight: null };
    const videoSkills = { rows: [], inflight: null };
    const recipes = { rows: [], inflight: null };
    const cfgs = { byId: new Map(), inflight: new Map() };

    // 自定参数那两块表单要列的模型清单（生图与生视频各一份，与出视频页那份 videoModels 同一判法）：
    // 没到手就不发覆盖值，各节点照技能 config 与全局设置走，弹窗里的模型行也铺不出东西
    let genModels = null;
    let videoModels = null;

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

    /** 自定参数那两块表单要列的模型清单：出图与出片各一份，没到手就是 null（调用方不铺模型行） */
    function models(isVideo) {
        return isVideo ? videoModels : genModels;
    }

    return {
        skills, enhanceSkills, videoSkills, recipes,
        loadSkills, loadEnhanceSkills, loadVideoSkills, loadRecipes, loadModelLists,
        skillName, videoSkillName, defaultSkillId, defaultEditSkillId, defaultVideoSkillId,
        recipeRow, cfgOf, primeCfg, models,
    };
}
