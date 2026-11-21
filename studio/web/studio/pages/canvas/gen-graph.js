// 画布连线图上的读法：一台节点从连过来的那一层直接取什么 —— 正文、参考素材、链上的车厢顺序。
// 全部入参是 (state, id) 与一段配方：不碰 DOM、不持页面状态，用例喂一份 state 就能断言。
// 「只看直连这一层」是 node-types.js 的 upstreamNodes 定的口径（上游的上游连过来的是那一条链，不是这一发的输入）。
import { upstreamNodes } from "./node-types.js";

// 连过来的素材按节点类型分三桶，与后端段参考素材（refs.images / videos / audios）同一口径：
// 视频输入节点与出片落点都进参考视频那一桶，音频输入节点进参考音频那一桶
export const MEDIA_GROUPS = { image: "images", video: "videos", video_in: "videos", audio_in: "audios" };
// 参考类别 → 那一桶：出片那一发按类别取桶、按类别说丢掉的是哪一类
export const REF_BUCKETS = { image: "images", video: "videos", audio: "audios" };

/** 这一发的输入：上游连线里的提示词按连线顺序拼接；图片 / 视频 / 音频按参考素材那套标注给后端 ——
 *  画布图片节点存的正是 Output 目录里的那一份，[output] 标注让后端从输出目录取并拷进 input；
 *  带 asset 的图片节点是「展开配方」铺进来的配方素材，文件在配方自己那一份 assets/ 里，
 *  连配方名一起交后端，由后端拷进 input 再用；停用的那一张不进这一发（节点上的「停用」是通用功能） */
export function genInputs(state, genNodeId) {
    const prompts = [];
    const references = { images: [], videos: [], audios: [] };
    const seen = new Set();
    for (const node of upstreamNodes(state, genNodeId, ["text", "image", "video", "video_in", "audio_in"])) {
        const text = String(node.metadata?.content || "").trim();
        if (node.type === "text" && text) prompts.push(text);
        const group = MEDIA_GROUPS[node.type];
        if (!group) continue;
        const filename = String(node.metadata?.filename || "");
        const sub = String(node.metadata?.subfolder || "");
        // 「展开配方」铺进来的素材节点：文件在配方自己那一份 assets/ 里，把配方名一起交后端去取
        const asset = String(node.metadata?.asset || "");
        const recipe = String(node.metadata?.recipe || "");
        // 空位（没有文件也不是配方素材）不进这一发：交一条空参考给后端只会撞回一个看不懂的错
        if (!filename && !asset) continue;
        const key = filename ? `${sub ? `${sub}/` : ""}${filename}[output]` : `${recipe}/${asset}`;
        // 同一个节点往这一台生成节点上连两条线，参考素材也只算一份
        if (seen.has(key)) continue;
        seen.add(key);
        references[group].push(filename
            ? { kind: "input", value: key }
            : { kind: "recipe", value: asset, recipe });
    }
    return { prompts, references };
}

/** 连到这一台节点的素材节点（按连线顺序）：出片交给后端的就是这一批，卡上也按这一批铺；
 *  停用的那一张既不进这一发也不在卡上露出来 */
export function mediaNodes(state, nodeId) {
    return upstreamNodes(state, nodeId, ["image", "video", "video_in", "audio_in"])
        .filter((node) => node.metadata?.filename || node.metadata?.asset);
}

/** 配方这一段自己的参考素材（recipe.json 记的是配方 assets/ 里的文件名）：首帧与分镜关键帧排最前 ——
 *  后端解析首帧与 refs.images 是同一路，卡上也要看见「这一段靠哪张图起头」 */
export function segmentRefs(seg) {
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

/** 反推吃的那一张：连线顺序里第一张启用的图片节点（与 genInputs 取参考同一条顺序） */
export function reverseFirstImage(state, nodeId) {
    return upstreamNodes(state, nodeId, ["image"])[0] || null;
}

/** 车厢：一台配方节点就是链上的一段，参数在它那一列的车尾上，这一段只带段号与自己的技能 */
export function isCar(node) {
    return node?.type === "recipe";
}

/** 链序：链边是「段 → 下一段 → … → 车尾」，从车尾沿链往回走到车头再翻过来。
 *  链被剪断就停在走到的那一段，成环靠 seen 停下 */
export function chainCars(state, tailNodeId) {
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

/** 整列共用的配方名读车厢身上那一份（「添加配方」铺出来的每一厢都记着同一份）—— 车尾那一张不记配方名，
 *  链上出片与卡上那行概览都读车厢这一份 */
export function chainRecipe(cars) {
    const car = cars.find((c) => String(c.metadata.recipe || ""));
    return car ? String(car.metadata.recipe) : "";
}
