// 画布节点上的生效参数：节点 metadata 里存的是「跟随」哨兵（空串与 -1 / 0），这一层把它读成这一发真正
// 交后端的那一份。边界与后端 widget 同一份（steps / context_frames 的 min-max、段时长 1–3600），画布上
// 钳一遍是为了把越界的输入落在卡上，不是为了护后端。纯读法与纯边界：不碰 DOM，也不持页面状态。
import { VIDEO_DUR_CHOICES } from "../../../gen-utils.js";

export const GEN_COUNT_MAX = 8;          // 后端 MAX_IMAGES：一次最多这么多张，画布上也不至于铺不满
export const SEED_MAX = 9007199254740991;    // JS 能精确表示的整数上限，再大后端也接不住
export const STEPS_MAX = 200;
export const STEPS_CHOICES = [8, 12, 15, 20, 25, 30, 40, 60];
export const CONTEXT_FRAMES_MAX = 362;
export const CONTEXT_FRAMES_DEFAULT = 22;    // 导演页与后端同一个默认窗口
export const CONTEXT_FRAMES_CHOICES = [0, 8, 14, 22, 29, 36];
// 段时长边界（整数秒）：与后端 _DIRECTOR_SEC_MIN / _DIRECTOR_SEC_MAX 和导演页时长框同一份 min-max
export const SEG_SEC_MIN = 1;
export const SEG_SEC_MAX = 3600;
// 锚点三档与后端 _ANCHOR_KEYS 同一份，文案沿用导演页那三个标签
export const ANCHOR_CHOICES = [["both", "两端锚点（首+尾，最稳）"], ["first", "只钉首帧"], ["none", "不用锚点"]];
// 自定参数存在生成节点 metadata.gen_params 里的键（与后端 _OVERRIDE_KEYS / _VIDEO_OVERRIDE_KEYS 同一批）：
// 空 = 跟随该技能 config 与全局生图 / 生视频设置，请求里不带这一项
export const GEN_PARAM_KEYS = ["model", "text_encoder", "vae", "audio_vae", "steps"];

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

/** 图像编辑节点生效的参数：这一版只开「常规编辑」—— 连过来的第一张图片是被改的那一张，后面的依次进
 *  参考；提示词从连过来的提示词节点取。目标尺寸不在节点上钉：跟着技能 config 与全局生图设置
 *  （与绘画页编辑面板不设宽高那一档同一口径） */
export function readEditParams(node) {
    const meta = node?.metadata || {};
    const count = parseInt(meta.count, 10);
    return {
        skill_id: String(meta.skill_id || ""),
        count: count >= 1 && count <= GEN_COUNT_MAX ? count : 1,
    };
}

/** 车厢（配方节点）与串联车尾上的参数：配方名、段序号（0 基，与后端 payload 同一口径）、这一段自己的
 *  技能（空 = 跟随配方里那一份）、锚点档位，与步数 / 种子 / 连续性 / 上下文帧。
 *  -1 与「跟随」是同一件事：请求里带着 -1，后端按配方与全局设置合并 */
export function readRecipeParams(node) {
    const meta = node?.metadata || {};
    const segment = parseInt(meta.segment, 10);
    const seed = Number(meta.seed);
    const steps = Number(meta.steps);
    const window = Number(meta.context_frames);
    return {
        recipe: String(meta.recipe || ""),
        segment: Number.isFinite(segment) && segment >= 0 ? segment : 0,
        skill_id: String(meta.skill_id || ""),
        anchors: ANCHOR_CHOICES.some(([key]) => key === meta.anchors) ? meta.anchors : "both",
        steps: Number.isFinite(steps) && steps >= 1 ? Math.min(steps, STEPS_MAX) : -1,
        seed: Number.isFinite(seed) && seed >= 0 ? Math.min(seed, SEED_MAX) : -1,
        continuity: meta.continuity !== false,
        context_frames: Number.isFinite(window) && window >= 0
            ? Math.min(window, CONTEXT_FRAMES_MAX) : CONTEXT_FRAMES_DEFAULT,
    };
}

/** 这台生成节点的自定参数：画布上这一发临时换的主模型 / Text Encoder / VAE / LoRA / 步数，
 *  存 metadata.gen_params（进撤销栈、随画布落盘）。空串与 -1 / 0 都是「跟随」—— 该技能 config 与
 *  全局生图 / 生视频设置由后端合并，请求里不带这一项。旧画布没有这一份，出图出片照旧跑 */
export function readGenOverrides(node) {
    const raw = node?.metadata?.gen_params;
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const key of GEN_PARAM_KEYS) {
        const v = String(raw[key] ?? "").trim();
        if (!v) continue;
        if (key === "steps") {
            const steps = Number(v);
            if (!(steps > 0)) continue;   // -1 / 0 是「跟随技能配置」的哨兵（车尾参数同一口径）
            out.steps = Math.min(steps, STEPS_MAX);
            continue;
        }
        out[key] = v;
    }
    const loras = (Array.isArray(raw.loras) ? raw.loras : []).map((entry) => {
        if (typeof entry === "string") return entry.trim();   // 旧画布存的纯名字照收（后端认这一型）
        const name = String(entry?.name ?? "").trim();
        return name ? { name, strength: Number(entry.strength) || 1 } : "";
    }).filter(Boolean);
    if (loras.length) out.loras = loras;
    return out;
}

/** 自定参数并进请求体：只带非空项，后端按技能 config 与全局设置合并（image_gen._OVERRIDE_KEYS /
 *  h3_video_gen._VIDEO_OVERRIDE_KEYS 认的就是这一批键） */
export function mergeGenOverrides(body, overrides) {
    for (const key of GEN_PARAM_KEYS) {
        if (overrides[key]) body[key] = overrides[key];
    }
    if (overrides.loras) body.loras = overrides.loras;
    return body;
}
