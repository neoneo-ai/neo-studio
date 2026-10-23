/**
 * mention-picker.js — 智能体输入框 @ 点名的候选源
 *
 * 一次 @ 弹层要铺的六类候选汇成一份列表：技能、主模型、LoRA、图像提示词、视频提示词、配方，
 * 每一类只认自己那条接口。接口回 409 / 404（桌面端离线服务没有那一条，能力表见
 * app/studio_caps.py）就当这一类是空的，弹层里少一类，铺不出假候选。
 * 每项归一成 {category, id, name, label, source, tags}：slash-picker 按 name / id / tags
 * 过滤，面板按 category + name 往输入框写 @category:name 这个可见记号，随请求体交后端的是
 * {category, id, name, source}（提示词那两类多带 text，正文在选中那一发取回）。
 * 模型与提示词那两条是同步目录扫描，每按一次 @ 全扫一遍会拖住弹层：走 cache.js 的 TTL 兜住，
 * 保存配方那一发显式清掉（agent-panel.js 接 DIRECTOR_RECIPE_SAVED_EVENT 调 clear）。
 */
import { ttlCache } from "./js/core/cache.js";

const MENTION_TTL_MS = 30000;
const MENTION_CATEGORIES = ["skill", "model", "lora", "image_prompt", "video_prompt", "recipe"];
const MENTION_LABELS = {
    skill: "技能", model: "主模型", lora: "LoRA",
    image_prompt: "图像提示词", video_prompt: "视频提示词", recipe: "配方",
};

// 记号里不能有空白与冒号：@ 弹层一见到空白就关，后端也照空白切这一段
function mentionName(raw) {
    return String(raw || "").replace(/[\s:@]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}

function mentionToken(category, name) {
    return `@${category}:${mentionName(name)}`;
}

// 模型下拉里 Krea2\krea2_turbo_fp8.safetensors 这种长路径，用户在右栏认的是文件名
function modelLabel(path) {
    const base = String(path || "").replace(/\\/g, "/").split("/").pop();
    return base.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, "") || base;
}

// presets/video/ 下那一批是出片用的提示词，其余（含 collections/ 多行集合）算图像提示词
function isVideoPrompt(name) {
    return String(name || "").replace(/\\/g, "/").split("/")[0].toLowerCase() === "video";
}

function createMentionSource({ getJson, postJson, listSkills }) {
    const cache = ttlCache(MENTION_TTL_MS);

    async function cached(key, load) {
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        let rows;
        try {
            rows = await load();
        } catch {
            return [];   // 这一条接口不在这台机器上服务：这一类空着，不给假候选
        }
        return cache.set(key, rows);
    }

    async function skills() {
        const rows = await cached("skills", async () => {
            const res = await listSkills();
            return Array.isArray(res) ? res : [];
        });
        return rows.map((s) => ({
            category: "skill", id: String(s.id || ""),
            name: s.cn_name || s.name || s.id, label: MENTION_LABELS.skill,
            tags: s.tags || [], raw: s,
        }));
    }

    async function models() {
        const scan = await cached("models", async () => {
            const res = await getJson("/neo_image_gen/models");
            return (res && !res.offline) ? res : {};
        });
        const rows = [];
        for (const f of scan.diffusion_models || []) {
            rows.push({ category: "model", id: f, name: modelLabel(f), label: MENTION_LABELS.model, tags: [] });
        }
        for (const f of scan.loras || []) {
            rows.push({ category: "lora", id: f, name: modelLabel(f), label: MENTION_LABELS.lora, tags: [] });
        }
        return rows;
    }

    async function prompts() {
        const rows = await cached("prompts", async () => {
            const res = await postJson("/rs_prompts/list_prompts", {});
            return (res && !res.offline && Array.isArray(res)) ? res : [];
        });
        return rows.map((p) => {
            const cat = isVideoPrompt(p.name) ? "video_prompt" : "image_prompt";
            return { category: cat, id: String(p.name || ""), name: p.name,
                     label: MENTION_LABELS[cat], source: p.source || "", tags: p.tags || [] };
        });
    }

    async function recipes() {
        const rows = await cached("recipes", async () => {
            const res = await postJson("/rs_recipes/list", {});
            return (res && !res.offline && Array.isArray(res)) ? res : [];
        });
        return rows.map((r) => ({
            category: "recipe", id: String(r.name || ""), name: r.name,
            label: MENTION_LABELS.recipe, source: r.source || "",
            tags: [r.gen_type, r.type].filter(Boolean),
        }));
    }

    async function items() {
        const groups = await Promise.all([skills(), models(), prompts(), recipes()]);
        const seen = new Set();
        const out = [];
        for (const group of groups) {
            for (const m of group) {
                if (!m.name || !m.category) continue;
                const key = mentionToken(m.category, m.name);
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(m);
            }
        }
        return out;
    }

    return { items, clear: () => cache.clear() };
}

export { MENTION_CATEGORIES, MENTION_LABELS, mentionName, mentionToken, modelLabel, createMentionSource };
