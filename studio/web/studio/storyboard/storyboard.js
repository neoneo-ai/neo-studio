// 文字故事板：一段话 → 一串段提示词，直接走后端既有的导演段生成链
// （/rs_recipes/director_generate_segments = studio/api/rs_recipes.py 的 _director_generate_segments）。
// 与导演页「从一段话生成每一段」同一条链，画布上这一发的产物只落进画布节点，配方一个字都不写。
// 请求构造、响应规整与写回计划都是纯函数：入参是文字与配置，出参是 payload / 段数组 / patch，不持页面状态。
import { t, tf } from "../../js/core/i18n.js";

export const STORYBOARD_API = "/rs_recipes/director_generate_segments";
// 每一段的时长边界（整数秒）：与后端 _DIRECTOR_SEC_MIN / _DIRECTOR_SEC_MAX 和导演页时长框同一份 min-max
export const SEG_SEC_MIN = 1;
export const SEG_SEC_MAX = 3600;
export const SEG_SEC_DEFAULT = 5;
// 「一句话」与「一整篇剧本」的分界：后端认 idea（让模型自己展开）与 script（照原文拆段）两条输入。
// 单行且不长的就是主题；换了行或长过这一截就交后端照原文拆，后端会把每一行分成一段
const IDEA_MAX_CHARS = 60;

/** 这一发的请求体：单行短文本当主题交后端展开，换行或长过一截就当剧本交后端拆段。
 *  段时长钳到后端认的那一份区间，写歪了落回默认 5 秒 —— 后端对越界直接 400，画布上先把话说平 */
export function storyboardRequestBody({ text = "", segmentSeconds } = {}) {
    const body = {};
    if (text.includes("\n") || text.length > IDEA_MAX_CHARS) body.script = text;
    else body.idea = text;
    const sec = Math.round(Number(segmentSeconds));
    body.segment_seconds = Number.isFinite(sec) && sec >= SEG_SEC_MIN
        ? Math.min(sec, SEG_SEC_MAX) : SEG_SEC_DEFAULT;
    return body;
}

/** 后端回包 → 段数组：每一段留正文、段号与后端算好的时长，丢掉没正文的那一段。
 *  后端在缺 LLM 与正文为空时回的是 {ok:false, error}，这里一律交 null，运行那一条把 error 说给用户 */
export function storyboardSegments(data) {
    const out = [];
    for (const seg of data?.segments || []) {
        const prompt = String(seg?.prompt || "").trim();
        if (!prompt) continue;
        const sec = Number(seg?.duration_sec);
        out.push({
            prompt,
            segment: Number.isFinite(Number(seg?.segment)) ? Number(seg.segment) : out.length,
            duration_sec: Number.isFinite(sec) && sec >= SEG_SEC_MIN && sec <= SEG_SEC_MAX
                ? Math.round(sec) : null,
        });
    }
    return out.length ? out : null;
}

/** 段数组 → 卡上那几行预览：第几段 · 时长 · 正文前 80 字。后端没给时长（老后端）就不写时长，
 *  出片时那一段的时长落回配方与后端那一份 */
export function storyboardPreviewLines(segments, max = 12) {
    return (segments || []).slice(0, max).map((seg) => tf("第 {n} 段{dur}：{text}", {
        n: seg.segment + 1,
        dur: seg.duration_sec ? tf(" · {n} 秒", { n: seg.duration_sec }) : "",
        text: seg.prompt.slice(0, 80),
    }));
}

/** 段数组 → 每一厢的写回 patch（按连线顺序，一厢一段，段数多于车厢时后面的段不进这一发）。
 *  车厢上只落这一列真正用的那几项：正文写 metadata.content（连过来的正文在出片时优先，卡上说清楚）。
 *  时长进不了画布 metadata —— metadata.duration 是视频生成节点那一条的时长口径，
 *  段时长只认配方那一份，写回交 setDurations 那一发 */
export function storyboardCarPatches(segments, cars) {
    const patches = [];
    const n = Math.min((segments || []).length, (cars || []).length);
    for (let i = 0; i < n; i += 1) {
        patches.push({ node: cars[i], meta: { content: segments[i].prompt },
            duration_sec: segments[i].duration_sec });
    }
    return patches;
}

/** 写回计划里「这一段能落时长」的那几厢：段时长写进配方那一段，配方名与段号取自车厢自己，
 *  同一份 (配方, 段) 只落一次；配方名落在哪一厢由调用方给（链上整列共用一份，读第一个记着的） */
export function storyboardDurationWrites(patches, recipeName) {
    const recipe = String(recipeName || "");
    if (!recipe) return [];
    const seen = new Set();
    const writes = [];
    for (const p of patches) {
        if (!p.duration_sec) continue;
        const meta = p.node?.metadata || {};
        const segment = Number(meta.segment);
        if (!Number.isFinite(segment) || segment < 0) continue;
        const key = `${recipe}/${segment}`;
        if (seen.has(key)) continue;
        seen.add(key);
        writes.push({ recipe, segment, duration_sec: p.duration_sec });
    }
    return writes;
}

/** 段数与车厢数不齐时在卡上说的话：段多了后面的段不进这一发，车厢多了后面那几厢不动 */
export function storyboardMismatchText(segN, carN) {
    if (segN === carN) return "";
    return tf("生成 {n} 段 · 链上 {m} 厢：按连线顺序一厢一段", { n: segN, m: carN });
}

/** 后端回包里的失败原因 → 这一发的错误：LLM 没配好、正文为空这类都落在 error 字段上（与导演页同一句读法）。
 *  后端在 200 里也会回 {ok:false, error}，没有 error 就说是没回段列表 —— 前缀那句由运行那一条补 */
export function storyboardError(data) {
    return new Error(String(data?.error || "").trim() || t("后端没有回段列表"));
}
