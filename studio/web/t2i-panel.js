/**
 * t2i-panel.js
 * 「生成素材」面板：纯提示词一键出图（默认 Krea2 文生图）——技能与自定参数 chip、增强 skill、
 * 随机提示词与输入历史、预设搜索，产物落 Output/NeoAgent/<日期>，素材面板可直接浏览。
 * 入口是顶栏 🅝「生成素材」、素材搜索行的生成按钮、Studio 绘画页，以及纯提示词的「再来一发」。
 * 从 gallery-gen.js 拆出，面板底座在 gen-utils.js。
 */

import { $el } from "../../../../scripts/ui.js";
import { DIRECTOR_ASPECTS } from "./director.js";
import { openLLMSettingsModal } from "./llm-setting.js";
import { actionToast } from "./toast.js";
import { openSkillDetailById, listSkills, populateSkillOptions, skillDisplayName, skillAcceptsText } from "./skill.js";
import { Lightbox } from "./lightbox.js";
import { requestGeneration, watchTask, cancelTask, createModelConfigSection, listGenModels, getSkillGenConfig } from "./image-gen.js";
import { invokePromptStream, createStreamOutputHandlers, randomPrompts, listPrompts, loadPrompt } from "./prompt-service.js";
import { createQuickInputHistory } from "./quick-input-history.js";
import { openGallerySidebar } from "./media-transfer.js";
import { t, tf } from "./js/core/i18n.js";
import { icon } from "./js/core/icons.js";
import {
    makeStoryWindowDraggable, _paintHosts, storyPanelRoot, ratioGlyph, chipButton,
    skillParamsChip, guardMainModelFamily, reuseModelOverlay, reusePaintPanel,
    notifyPrefillFilled,
} from "./gen-utils.js";

// 「生成素材」弹窗默认技能：Krea2 文生图（纯提示词出图，产物落 Output/NeoAgent/<日期>）
const KREA2_T2I_SKILL_ID = "image_gen";
// 「生成素材」弹窗上次选中的技能（localStorage，关窗不清除）
const GM_LAST_SKILL_KEY = "neo.gallery.gen_material.skill";
// 「生成素材」弹窗上次选中的「增强 skill」（localStorage，关窗不清除；空 = 默认自动路由）
const GM_ENHANCE_SKILL_KEY = "neo.gallery.gen_material.enhance_skill";

/** 画廊搜索行「生成素材」：纯提示词一键生成新素材（默认 Krea2 文生图），产物落 Output/NeoAgent/<日期>，素材面板可直接浏览。 */
export function openGenMaterialDialog(gallery, opts = null) {
    const host = opts?.container || _paintHosts?.text;
    if (reusePaintPanel(host, "text", null, "", opts?.prefill)) return;
    const panel = storyPanelRoot(host, "neo-gallery-gm-modal-overlay", "text");
    const overlay = panel.root;

    const statusBox = $el("div", { className: "neo-gallery-cs-status" });
    const actionsBox = $el("div", { className: "neo-gallery-story-actions" });
    // 一个输入框就是生成用的提示词：写一句直接生成，「增强」（可选）把扩写结果写回同一个框
    // rows 给的是 intrinsic 高，绘画页那条 64px 的 min-height 只有在这里才够矮（3 行的 intrinsic 顶到 84px）
    const quickInput = $el("textarea", {
        className: "neo-gallery-gm-quick-input",
        rows: 2,
        placeholder: t("描述要生成的素材，例如：红色陶瓷杯的白底产品图……或输入修改指令（↑/↓ 调出历史）")
    });

    // 快捷输入命令终端式历史：↑/↓ 召回之前生成用过的提示词（localStorage 持久化，最新在前，上限 20）
    const gmHistory = createQuickInputHistory(quickInput, { storageKey: "neo.gallery.gen_material.quick_history" });
    // 占位符提示轮播（参考 llm-chat QUICK_INPUT_TIPS）：聚焦且为空时每 5s 换一条
    const GM_QUICK_TIPS = [
        t("描述要生成的素材，例如：红色陶瓷杯的白底产品图"),
        t("✏输入修改指令，例如：去掉动漫风格，改成写实"),
        t("加风格要求，例如：改成赛博朋克风格"),
        t("在 ⋯ 菜单点「增强」，LLM 把描述扩写成详细提示词"),
        t("在 ⋯ 菜单随机填入一条提示词（配方不入池）"),
        t("按 ↑/↓ 召回之前生成用过的提示词")
    ];
    let tipTimer = null;
    const setQuickTip = () => { if (!quickInput.value.trim()) quickInput.placeholder = GM_QUICK_TIPS[Math.floor(Math.random() * GM_QUICK_TIPS.length)]; };
    const stopQuickTips = () => { if (tipTimer) { clearInterval(tipTimer); tipTimer = null; } };
    quickInput.addEventListener("focus", () => { setQuickTip(); stopQuickTips(); tipTimer = setInterval(setQuickTip, 5000); });
    quickInput.addEventListener("blur", () => { stopQuickTips(); setQuickTip(); });

    // ── 输入卡：一个提示词框 + 底部一行（技能 / 宽高比 / 最长边 / 自定参数 … ⋯ 生成）；
    // ⋯ 菜单收 随机填入 / 运行时随机批量 / 预设列表 / 提示词增强 ──
    const GM_RANDOM_KEY = "neo.gallery.gen_material.runtime_random";
    let gmRandom = { enabled: false, count: 1 };
    try {
        const saved = JSON.parse(localStorage.getItem(GM_RANDOM_KEY) || "null");
        if (saved && typeof saved === "object") {
            gmRandom = { enabled: !!saved.enabled, count: Math.max(1, Math.min(parseInt(saved.count, 10) || 1, 16)) };
        }
    } catch {}
    const saveGmRandom = () => { try { localStorage.setItem(GM_RANDOM_KEY, JSON.stringify(gmRandom)); } catch {} };

    const moreBtn = $el("button", { className: "neo-gallery-gm-tool-btn neo-gallery-gm-more-btn", type: "button", textContent: "⋯", title: t("更多：随机填入 / 提示词增强 / 运行时随机批量 / 预设列表") });

    // ⋯ 菜单（复用 Prompt Agent 节点运行时菜单样式；运行时随机状态 localStorage 持久化）
    const moreMenu = $el("div", { className: "rs-runtime-menu neo-gallery-gm-more-menu" });
    const randomItem = $el("button", { className: "neo-gallery-gm-menu-item", type: "button", textContent: t("随机填入一条提示词") });
    const presetItem = $el("button", { className: "neo-gallery-gm-menu-item", type: "button", textContent: t("预设列表") });
    const runtimeCheck = $el("input", { type: "checkbox" });

    runtimeCheck.checked = gmRandom.enabled;
    const countValEl = $el("span", { className: "rs-runtime-count-val", textContent: String(gmRandom.count) });
    const mkCountBtn = (delta) => {
        const b = $el("button", { className: "rs-runtime-count-btn", type: "button" });
        b.textContent = delta > 0 ? "+" : "−";
        b.addEventListener("click", () => {
            gmRandom.count = Math.max(1, Math.min(gmRandom.count + delta, 16));
            countValEl.textContent = String(gmRandom.count);
            saveGmRandom();
        });
        return b;
    };
    moreMenu.append(
        randomItem,
        $el("label", { className: "rs-runtime-row rs-runtime-toggle" }, [
            runtimeCheck,
            $el("span", { className: "rs-runtime-row-text", textContent: t("运行时随机抽取提示词") })
        ]),
        $el("div", { className: "rs-runtime-row" }, [
            mkCountBtn(-1), countValEl, mkCountBtn(1),
            $el("span", { className: "rs-runtime-row-text", textContent: t("张（批量生成）") })
        ]),
        presetItem
    );
    const syncRandomState = () => {
        moreBtn.classList.toggle("neo-gallery-gm-tool-on", gmRandom.enabled);
    };

    runtimeCheck.addEventListener("change", () => {
        gmRandom.enabled = runtimeCheck.checked;
        saveGmRandom();
        syncRandomState();
    });
    syncRandomState();

    // 预设列表浮层（复用预设列表样式；配方不入池，点击填入提示词框）
    const presetOverlay = $el("div", { className: "rs-preset-list-overlay" });
    const presetHeader = $el("div", { className: "rs-preset-header" }, [
        $el("input", { className: "rs-preset-search-input", type: "text", placeholder: t("搜索预设…") }),
        $el("button", { className: "rs-preset-close", type: "button", textContent: "×" })
    ]);
    const presetSearch = presetHeader.querySelector("input");
    presetHeader.querySelector("button").addEventListener("click", () => { presetOverlay.style.display = "none"; quickInput.focus(); });
    const presetBody = $el("div", { className: "rs-preset-list-body" });
    presetOverlay.append(presetHeader, presetBody);

    let presetItems = null; // 本次弹窗会话缓存
    const renderPresetList = (query) => {
        presetBody.textContent = "";
        const q = (query || "").trim().toLowerCase();
        const items = (presetItems || []).filter(it => !q || it.name.toLowerCase().includes(q));
        if (!items.length) {
            presetBody.appendChild($el("div", { className: "neo-gallery-story-hint", textContent: q ? t("无匹配预设") : t("暂无预设") }));
            return;
        }
        items.forEach(it => {
            const row = $el("div", { className: "rs-preset-item" }, [
                $el("span", { className: "rs-preset-content", textContent: it.name }),
                $el("span", { className: "rs-source-badge", textContent: it.source === "presets" ? t("预设") : t("自定义") })
            ]);
            row.addEventListener("click", async () => {
                try {
                    const data = await loadPrompt(it.name);
                    quickInput.value = data.text || "";
                    presetOverlay.style.display = "none";
                    quickInput.focus();
                } catch (e) {
                    console.error("[Gallery] load preset failed:", e);
                    actionToast({ severity: "error", summary: t("加载预设失败"), detail: String(e?.message || e) });
                }
            });
            presetBody.appendChild(row);
        });
    };
    const openPresetList = async () => {
        presetOverlay.style.display = "flex";
        presetSearch.value = "";
        if (!presetItems) {
            presetBody.textContent = t("加载中…");
            try { presetItems = await listPrompts(); } catch (e) { console.error("[Gallery] list prompts failed:", e); presetItems = []; }
        }
        renderPresetList("");
        presetSearch.focus();
    };
    presetSearch.addEventListener("input", () => renderPresetList(presetSearch.value));


    let running = false;
    let cancelId = null;
    let cancelRequested = false;
    let deleting = false;
    let randomPicking = false;

    const close = () => overlay.remove();
    const fill = (box, ...children) => { box.textContent = ""; box.append(...children.filter(Boolean)); };
    const btn = (label, onclick, primary = false) =>
        $el("button", { className: "neo-gallery-story-btn" + (primary ? " neo-gallery-story-btn-primary" : ""), textContent: label, onclick });

    // 技能下拉：只列吃文字的生图技能（纯文生图 + Qwen 2.1 这类两栖类）；必须带参考图的编辑类
    // 在本页没有图可给，列出来只会出废图。记住上次选中的技能（localStorage），失效时回 Krea2 文生图
    const skillSel = $el("select", { className: "neo-recipes-sort neo-gallery-gm-chip-select neo-gallery-gm-skill-sel", title: t("技能与自定参数：只列吃文字输入的生图技能；主模型 / LoRA 留空 = 跟随该技能配置与全局生图设置") });
    // 自定参数（本次临时选主模型 / LoRA，类似节点上接模型，空值 = 跟随全局生图设置）：
    // 与技能同一枚 chip，点开从上方浮出双栏面板；Text Encoder / VAE 很少变，弹窗里不露出（共享组件保留行，这里裁掉）
    const modelCfg = createModelConfigSection({ getSkillId: () => skillSel.value });
    for (const row of modelCfg.el.querySelectorAll(".rs-gen-adv-row")) row.remove();
    const modelBox = $el("div", { className: "neo-gallery-gm-model-box" });
    modelBox.appendChild(modelCfg.el);
    const skillChip = skillParamsChip(skillSel, modelBox, {
        icon: "sparkles",
        getOverride: () => modelCfg.collect(),
    });
    // 换主模型 / 加 LoRA 后 chip 标签跟上（技能名 + 覆盖态）
    const syncParamsChip = () => skillChip.sync();
    modelBox.addEventListener("change", syncParamsChip);
    guardMainModelFamily(modelCfg, skillSel);
    let rememberedSkill = "";

    try { rememberedSkill = localStorage.getItem(GM_LAST_SKILL_KEY) || ""; } catch {}
    // 拉技能列表重建下拉（打开时与保存新技能后调用）；preferId 优先选中（刚保存的新技能）
    const fillSkillOptions = async (preferId) => {
        try {
            const res = await fetch("/rs_prompts/skills");
            const skills = await res.json();
            const genSkills = (Array.isArray(skills) ? skills : []).filter(s => s.gen_image && skillAcceptsText(s));
            skillSel.textContent = "";
            genSkills.forEach(s => {
                const opt = $el("option", { value: s.id, textContent: skillDisplayName(s) });
                opt.__skillMeta = s;   // 家族与主模型副标题取这份元数据（populateSkillOptions 同一约定）
                skillSel.appendChild(opt);
            });
            const ids = genSkills.map(s => s.id);
            if (preferId && ids.includes(preferId)) skillSel.value = preferId;
            else if (rememberedSkill && ids.includes(rememberedSkill)) skillSel.value = rememberedSkill;
            else skillSel.value = ids.includes(KREA2_T2I_SKILL_ID) ? KREA2_T2I_SKILL_ID : (ids[0] || "");
        } catch {
            skillSel.value = KREA2_T2I_SKILL_ID;
        }
        skillChip.sync();   // 下拉整份重建过：chip 标签跟着新选中项
        await applySkillModelConfig(skillSel.value); // 自定参数同步为该技能配置（模型列表未就绪时为空操作）
    };
    const skillsReady = fillSkillOptions();
    // 选中变化即写入 localStorage：下次打开沿用该技能（关窗不清除）；自定参数同步切到新技能
    skillSel.addEventListener("change", () => {
        try { localStorage.setItem(GM_LAST_SKILL_KEY, skillSel.value); } catch {}
        applySkillModelConfig(skillSel.value);
    });

    // 增强 skill 下拉：与节点同源 populateSkillOptions（按分类分组），只列图像提示词增强技能
    // （category=image_enhance）；「默认」空值 = 后端 smart_prompt 自动路由；记住上次选择
    const enhanceSel = $el("select", { className: "neo-recipes-sort neo-gallery-gm-enhance-skill", title: t("增强方式：用哪个图像增强技能扩写描述（默认 = 后端自动路由）") });

    let rememberedEnhanceSkill = "";
    try { rememberedEnhanceSkill = localStorage.getItem(GM_ENHANCE_SKILL_KEY) || ""; } catch {}
    (async () => {
        try {
            const skills = await listSkills();
            enhanceSel.textContent = "";
            enhanceSel.appendChild($el("option", { value: "", textContent: t("默认") }));
            populateSkillOptions(enhanceSel, skills.filter(s => s.category === "image_enhance"));
            const ids = Array.from(enhanceSel.options).map(o => o.value);
            if (rememberedEnhanceSkill && ids.includes(rememberedEnhanceSkill)) enhanceSel.value = rememberedEnhanceSkill;
        } catch { /* 拉取失败保持「默认」 */ }
    })();
    enhanceSel.addEventListener("change", () => {
        try { localStorage.setItem(GM_ENHANCE_SKILL_KEY, enhanceSel.value); } catch {}
    });

    // 宽高比 / 最长边：本次临时覆盖（空值 = 跟随技能配置 / 全局设置），同行紧凑布局
    // 宽高比选项与导演编辑页同源（DIRECTOR_ASPECTS）：值保持纯比例，显示带中文备注
    const GM_RATIO_OPTIONS = DIRECTOR_ASPECTS.map(([label]) => [label.split(" ")[0], t(label)]);
    const GM_RATIOS = GM_RATIO_OPTIONS.map(([v]) => v);
    // 「默认」选项跟随值用无括号备注：16:9 (宽屏) → 16:9 宽屏，避免嵌套括号
    const GM_RATIO_AUTO_TEXT = Object.fromEntries(DIRECTOR_ASPECTS.map(([label]) => {
        const [v, note] = t(label).split(" ");
        return [v, `${v} ${note.replace(/[()]/g, "")}`];
    }));
    const GM_EDGES = ["1024", "1152", "1280", "1536", "1792", "2048", "2560", "3072"];
    const makeGmSelect = (options) => {
        const select = document.createElement("select");
        select.className = "neo-gallery-gm-chip-select";

        const auto = document.createElement("option");
        auto.value = "";
        auto.textContent = t("默认");   // 跟随值由 setGmAutoLabel 写进这一项与 chip
        select.appendChild(auto);
        for (const opt of options) {
            const [value, text] = Array.isArray(opt) ? opt : [opt, opt];
            const el = document.createElement("option");
            el.value = value;
            el.textContent = text;
            select.appendChild(el);
        }
        return select;
    };
    // 跟随值 = 当前技能配置的生效值（切技能时更新）：菜单里写出值，chip 标签与比例 glyph 直接用这份
    const setGmAutoLabel = (sel, v) => {
        sel.dataset.follow = v || "";
        sel.options[0].textContent = v ? tf("默认 ({v})", { v }) : t("默认");
    };
    const sizeRow = $el("div", { className: "neo-gallery-gm-size-row neo-gallery-gm-chip-group" });
    const ratioSel = makeGmSelect(GM_RATIO_OPTIONS);
    ratioSel.title = t("宽高比：本次临时覆盖出图比例，默认 = 跟随技能配置与全局生图设置");
    const edgeSel = makeGmSelect(GM_EDGES);
    edgeSel.title = t("最长边：本次临时覆盖出图最长边像素，默认 = 跟随技能配置与全局生图设置");
    const ratioChip = chipButton(ratioSel, { glyph: ratioGlyph() });
    const edgeChip = chipButton(edgeSel, { icon: "maximize" });
    sizeRow.append(ratioChip.el, edgeChip.el);

    // 「再来一发」预填：提示词 / 技能与自定参数 / 宽高比 / 最长边。技能不在本页下拉里
    // （本页只列吃文字输入的技能）就整项不填；尺寸填在最后，压过切技能时按该技能配置写回的跟随值
    const applyGmPrefill = async (pf) => {
        const filled = [];
        const prompt = String(pf?.prompt || "").trim();
        if (prompt) { quickInput.value = prompt; filled.push(t("提示词")); }
        filled.push(...await applyGmReuseSkill(pf));
        const w = Number(pf?.width) || 0, h = Number(pf?.height) || 0;
        if (!w || !h) return filled;
        const ratio = matchGmRatio(w, h);
        if (ratio) { ratioSel.value = ratio; ratioChip.sync(); filled.push(t("宽高比")); }
        const edge = GM_EDGES.find((v) => Number(v) === Math.max(w, h));
        if (edge) { edgeSel.value = edge; edgeChip.sync(); filled.push(t("最长边")); }
        return filled;
    };

    /** 副文件里的技能与自定参数落进面板：主模型 / LoRA 叠在该技能配置之上，重放那一发的生效值 */
    const applyGmReuseSkill = async (pf) => {
        await skillsReady;   // 技能是异步填进下拉的：等它落位才认得出副文件里那个技能 id
        const opt = Array.from(skillSel.options).find((o) => o.value === String(pf?.skill || ""));
        if (!opt) return [];
        skillSel.value = opt.value;
        skillChip.sync();
        try { localStorage.setItem(GM_LAST_SKILL_KEY, opt.value); } catch {}
        await modelsReady;
        await applySkillModelConfig(opt.value, reuseModelOverlay(pf, genModels, opt.__skillMeta));
        return [t("技能与自定参数")];
    };

    // 保存为新技能：把当前选的「主模型 + LoRA + 宽高比 + 最长边」存成新技能（名称自动生成 = 主模型名+LoRA 名，其余设置沿用当前技能）
    const saveSkillBtn = $el("button", {
        className: "neo-gallery-gm-save-skill",
        type: "button",
        textContent: t("保存为新技能"),
        style: { display: "none" },
    });
    modelBox.appendChild(saveSkillBtn);
    // 选中了主模型或 LoRA 才显示（委托：覆盖区内任意下拉 / 强度输入变化）
    const refreshSaveSkillBtn = () => {
        const ov = modelCfg.collect();
        saveSkillBtn.style.display = (ov.model || ov.loras.length) ? "" : "none";
    };
    modelBox.addEventListener("change", refreshSaveSkillBtn);
    let savingSkill = false;
    saveSkillBtn.addEventListener("click", async () => {
        if (savingSkill) return;
        const ov = modelCfg.collect();
        if (!ov.model && !ov.loras.length) return;
        savingSkill = true;
        saveSkillBtn.textContent = t("保存中…");
        try {
            const res = await fetch("/neo_image_gen/save_combo_skill", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ skill_id: skillSel.value || KREA2_T2I_SKILL_ID, model: ov.model, loras: ov.loras, ratio: ratioSel.value, edge: edgeSel.value }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            // 新技能已进列表 → 直接选中并记住（下次打开沿用该组合）
            await fillSkillOptions(data.id);
            try { localStorage.setItem(GM_LAST_SKILL_KEY, data.id); } catch {}
            actionToast({ severity: "success", summary: tf("已保存为新技能「{name}」", { name: data.name }) });
        } catch (e) {
            console.error("[Gallery] save combo skill failed:", e);
            actionToast({ severity: "error", summary: t("保存为新技能失败"), detail: String(e?.message || e) });
        } finally {
            savingSkill = false;
            saveSkillBtn.textContent = t("保存为新技能");
            refreshSaveSkillBtn();
        }
    });
    // 每次打开都默认「自动」（跟随全局设置），不预填已配置值——否则关窗重开像上次选择没清除；
    // 模型列表拉取失败时覆盖区保持空下拉（等效跟随设置），不挡生成
    let genModels = null; // 打开时拉取的模型列表，切换技能重放配置时复用
    // 切换生成技能后把自定参数同步为该技能配置的主模型 / LoRA / 比例 / 最长边（无配置 = 自动跟随全局设置）
    async function applySkillModelConfig(skillId, overlay = {}) {
        // 模型列表未就绪，或技能列表还没回填（下拉为空串）：后者问后端必回 400（后端只在带 skill_id 时答配置），
        // 且会把刚渲染的「自动」覆盖成一份空配置。fillSkillOptions 填完选项会重放这一次。
        if (!genModels || !skillId) return;
        const cfg = await getSkillGenConfig(skillId);
        modelCfg.load({ ...cfg, ...overlay }, genModels);   // 「再来一发」的主模型 / LoRA 叠在技能配置之上
        ratioSel.value = GM_RATIOS.includes(cfg.default_ratio) ? cfg.default_ratio : "";
        edgeSel.value = GM_EDGES.includes(String(cfg.base_resolution)) ? String(cfg.base_resolution) : "";
        setGmAutoLabel(ratioSel, cfg.default_ratio ? (GM_RATIO_AUTO_TEXT[cfg.default_ratio] || cfg.default_ratio) : "");
        setGmAutoLabel(edgeSel, cfg.base_resolution);
        ratioChip.sync();   // 程序改 value 不触发 change：chip 标签与 glyph 自己跟上
        edgeChip.sync();
        syncParamsChip();
    }
    const modelsReady = (async () => {
        try {
            genModels = await listGenModels();
            modelCfg.load({}, genModels); // 先按「自动」渲染，避免下拉为空
            applySkillModelConfig(skillSel.value); // 再覆盖为当前技能配置
        } catch {
            // 同上：静默保持「自动」
        }
    })();
    // 增强：可选步骤，整条收进 ⋯ 菜单，默认视野只剩输入框 = 写一句直接生成。
    // 复用节点 agent 逻辑（所选增强 skill 的 skill.md 作系统提示词 + 按需读引用文件）直调
    // /rs_prompts/stream_generate_prompt，扩写结果流式写回同一个输入框；原句先进历史，↑ 可召回
    const enhanceBtn = $el("button", { className: "neo-gallery-story-btn", textContent: t("增强") });
    const enhanceGroup = $el("div", { className: "neo-gallery-gm-enhance-group" }, [
        $el("div", { className: "neo-director-field-label", textContent: t("提示词增强（可选）") }),
        $el("div", { className: "rs-runtime-row" }, [enhanceSel, enhanceBtn]),
    ]);
    moreMenu.insertBefore(enhanceGroup, presetItem);
    let enhancing = false;
    enhanceBtn.addEventListener("click", async () => {
        if (enhancing || running) return;
        const text = quickInput.value.trim();
        if (!text) { closeMoreMenu(); quickInput.focus(); return; }
        gmHistory.record(text);
        const original = quickInput.value;
        enhancing = true;
        closeMoreMenu();
        enhanceBtn.textContent = t("增强中…");

        try {
            await invokePromptStream({ text, skillId: enhanceSel.value }, createStreamOutputHandlers({
                textarea: quickInput,
                onDone: (acc) => {
                    if (!acc.trim()) {
                        quickInput.value = original;
                        actionToast({ severity: "warning", summary: t("增强失败"), detail: t("LLM 未返回内容") });
                    }
                    quickInput.focus();
                },
                onError: (e) => {
                    quickInput.value = original;
                    console.error("[Gallery] gen material enhance failed:", e);
                    actionToast({ severity: "error", summary: t("提示词增强失败"), detail: String(e?.message || e), actionLabel: t("打开 LLM 设置"), onAction: openLLMSettingsModal });
                }
            }));
        } finally {
            enhancing = false;
            enhanceBtn.textContent = t("增强");
        }
    });

    const renderIdle = () => {
        // 页内 idle 不在中间铺一整块空画布：那块没有内容的框把输入区顶到屏幕正中，
        // 用户先看到的是框不是控件。弹窗空间小，仍走一句短 hint
        fill(statusBox, panel.embedded
            ? $el("div", { className: "neo-gallery-gm-idle" }, [
                $el("div", { className: "neo-gallery-gm-idle-title", textContent: t("写一句提示词，点生成") }),
                $el("div", { className: "neo-gallery-gm-idle-sub", textContent: t("结果图出现在输入卡上方，产物保存到 Output 目录（NeoAgent/<日期>）") }),
            ])
            : $el("div", { className: "neo-gallery-story-hint", textContent: t("填写素材描述后点「生成」，图片保存到 Output 目录（NeoAgent/<日期>），可在素材面板浏览。") }));
        fill(actionsBox, panel.embedded ? null : btn(t("取消"), close));
    };


    // 预览区：生成中显示占位（spinner + 进度条），成功后结果图原位替换它（同一容器复用，布局不跳）
    const previewBox = $el("div", { className: "neo-gallery-gm-preview" });

    const renderRunning = (label, progress, preview) => {
        previewBox.className = "neo-gallery-gm-preview";
        const hasSteps = !!(progress && progress.max > 0);
        const fillEl = $el("div", { className: "neo-gallery-cs-progress-fill" });
        if (hasSteps) {
            fillEl.style.width = `${Math.max(0, Math.min(100, (progress.value / progress.max) * 100))}%`;
        } else {
            fillEl.classList.add("neo-gallery-cs-progress-indeterminate");
        }
        // 采样中拿到实时预览图（与节点预览同源）时替换 spinner，否则显示占位
        const runningRow = preview
            ? $el("img", { className: "neo-gallery-gm-preview-img", src: preview, alt: label })
            : $el("div", { className: "neo-gallery-cs-running" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: label })
            ]);
        fill(previewBox,
            runningRow,
            $el("div", { className: "neo-gallery-cs-progress" }, [fillEl]));
        fill(statusBox, previewBox);
        fill(actionsBox, btn(t("取消任务"), () => { cancelRequested = true; if (cancelId) cancelTask(cancelId); }));
    };


    // 成功后：结果图已在位（单张=1 图 / 批量=网格图），这里只补提示 + 操作按钮
    const renderGenDone = (images, hint) => {
        const oldHint = statusBox.querySelector(".neo-gallery-story-hint");
        if (oldHint) oldHint.remove();
        statusBox.appendChild($el("div", { className: "neo-gallery-story-hint", textContent: hint }));
        // 打开输出目录：跳到 Output 下实际落盘的日期子目录（窗口保留，可继续再生成/删除）
        const openOutputDir = () => {
            const sub = images.map(i => i.subfolder).find(Boolean);
            openGallerySidebar("Output", sub ? sub.split("/").filter(Boolean) : []);
        };
        // 删除：结果不满意 → 直接删掉落盘文件（含 .txt 与缩略图缓存），删完回 idle 原地再生成
        const deleteResult = async () => {
            if (!images.length || deleting) return;
            deleting = true;
            try {
                for (const im of images) {
                    const ok = await gallery.deleteItem(im.filename, im.subfolder || "", { silent: true });
                    if (!ok) { actionToast({ severity: "error", summary: t("删除失败"), detail: tf("无法删除 {name}", { name: im.filename }) }); break; }
                }
                renderIdle();
            } catch (e) {
                console.error("[Gallery] gen material delete failed:", e);
                actionToast({ severity: "error", summary: t("删除失败"), detail: String(e?.message || e) });
            } finally {
                deleting = false;
            }
        };
        fill(actionsBox, btn(t("打开输出目录"), openOutputDir), btn(t("删除"), deleteResult), panel.embedded ? null : btn(t("关闭"), close, true));
    };

    const renderSuccess = (final) => {
        const images = final.images || [];
        // 结果图原位替换预览区：复用同一容器，只换类名与内容
        previewBox.className = "neo-gallery-cs-result";
        fill(previewBox);
        if (images.length > 0) {
            const img = $el("img", {
                className: "neo-gallery-cs-result-img",
                src: `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&size=640`,
                alt: images[0].filename
            });
            img.addEventListener("click", () => Lightbox.open({ items: images.map(im => ({ kind: "image", url: im.url, title: im.filename })), index: 0 }));
            previewBox.appendChild(img);
        }
        renderGenDone(images, t("已生成，图片保存在 Output 目录（NeoAgent/<日期>），可在素材面板浏览。"));
    };

    // 提交一次生图任务并等终态；render(snap) 随快照推送刷新 UI（单张=整个预览区 / 批量=当前行原位更新）
    const runOnePrompt = async (promptText, render) => {
        // 自定参数只带非空值：空串 / 空数组会覆盖掉全局设置里的显式配置
        const payload = {
            skill_id: skillSel.value || KREA2_T2I_SKILL_ID,
            prompt: promptText,
            skip_enhance: true,
        };
        const ov = modelCfg.collect();
        if (ov.model) payload.model = ov.model;
        if (ov.loras.length) payload.loras = ov.loras;
        if (ratioSel.value) payload.default_ratio = ratioSel.value;
        if (edgeSel.value) payload.base_resolution = parseInt(edgeSel.value, 10);
        const snap = await requestGeneration(payload);
        cancelId = snap.task_id;
        return await watchTask(snap.task_id, render, () => cancelRequested);
    };

    // 运行时随机批量：逐张生成，成功即把结果图追加进网格；取消时保留已生成的
    const runBatch = async (prompts) => {
        const total = prompts.length;
        const results = [];
        fill(statusBox, previewBox); // 结果区挂到上方区域（与单张模式复用同一容器）
        previewBox.className = "neo-gallery-cs-result";
        fill(previewBox);
        for (let i = 0; i < total; i++) {
            if (cancelRequested) break;
            const runningRow = $el("div", { className: "neo-gallery-gm-batch-item" }, [
                $el("span", { className: "neo-gallery-cs-spinner" }),
                $el("span", { textContent: tf("生成 {i}/{total}（排队中…）", { i: i + 1, total }) })
            ]);
            previewBox.appendChild(runningRow);
            fill(actionsBox, btn(t("取消任务"), () => { cancelRequested = true; if (cancelId) cancelTask(cancelId); }));
            let final;
            try {
                final = await runOnePrompt(prompts[i], s => {
                    runningRow.lastChild.textContent = tf("生成 {i}/{total}（{state}…）", { i: i + 1, total, state: s.status === "running" ? t("生图中") : t("排队中") });
                });
            } catch (e) {
                runningRow.remove();
                throw e;
            }
            runningRow.remove();
            if (final.status === "succeeded") {
                results.push(final);
                const images = final.images || [];
                if (images.length > 0) {
                    const img = $el("img", {
                        className: "neo-gallery-cs-result-img",
                        src: `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(images[0].filename)}&subfolder=${encodeURIComponent(images[0].subfolder || "")}&size=640`,
                        alt: images[0].filename
                    });
                    img.addEventListener("click", () => Lightbox.open({ items: results.flatMap(f => (f.images || []).map(im => ({ kind: "image", url: im.url, title: im.filename }))), index: 0 }));
                    previewBox.appendChild(img);
                }
            } else if (final.status === "cancelled") {
                break;
            } else {
                // 中途失败：保留已生成的图，错误显示在其下方
                const oldHint = statusBox.querySelector(".neo-gallery-story-hint");
                if (oldHint) oldHint.remove();
                statusBox.appendChild($el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: tf("第 {i}/{total} 张生成失败：{err}", { i: i + 1, total, err: final.error || t("未知错误") }) }));
                fill(actionsBox, panel.embedded ? null : btn(t("关闭"), close, true));
                return;
            }
        }
        if (!results.length) { renderError(t("已取消")); return; }
        renderGenDone(results.flatMap(f => f.images || []), tf("已生成 {done}/{total} 张，图片保存在 Output 目录（NeoAgent/<日期>），可在素材面板浏览。", { done: results.length, total }));
    };

    const renderError = (message) => {
        fill(statusBox, $el("div", { className: "neo-gallery-story-hint neo-gallery-story-hint-error", textContent: message || t("生成失败") }));
        fill(actionsBox, btn(t("重试"), start), panel.embedded ? null : btn(t("关闭"), close));
    };

    // 生图失败：窗内留错误 + 重试，另弹 action toast 引导去技能详情修模型（缺模型/节点等非 LLM 问题）
    const failGen = (message) => {
        renderError(message);
        actionToast({ severity: "error", summary: t("素材生成失败"), detail: message, actionLabel: t("打开技能详情"), onAction: () => openSkillDetailById(skillSel.value || KREA2_T2I_SKILL_ID) });
    };

    // 随机填入（与批量同池抽一条，配方不入池）
    randomItem.addEventListener("click", async () => {
        if (randomPicking || running) return;
        randomPicking = true;
        randomItem.disabled = true;
        try {
            const data = await randomPrompts(1);
            const text = (data.texts || [])[0] || "";
            if (text.trim()) {
                quickInput.value = text;
                quickInput.focus();
                closeMoreMenu();
            } else {
                actionToast({ severity: "error", summary: t("随机提示词失败"), detail: t("提示词库为空") });
            }
        } catch (e) {
            console.error("[Gallery] random prompt failed:", e);
            actionToast({ severity: "error", summary: t("随机提示词失败"), detail: String(e?.message || e) });
        } finally {
            randomPicking = false;
            randomItem.disabled = false;
        }
    });

    // ⋯ 菜单（挂在弹窗 overlay 上，随窗移除）：output 框在面板下沿，默认朝按钮上方展开
    let moreMenuOpen = false;
    const closeMoreMenu = () => { moreMenuOpen = false; moreMenu.style.display = "none"; };
    moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (moreMenuOpen) { closeMoreMenu(); return; }
        moreMenu.style.display = "block";
        moreMenuOpen = true;
        const r = moreBtn.getBoundingClientRect();
        moreMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - moreMenu.offsetWidth - 8))}px`;
        const above = r.top - moreMenu.offsetHeight - 6;
        moreMenu.style.top = `${above > 8 ? above : r.bottom + 6}px`;
    });
    // 外关读按下那一发：combo 的列表在 mousedown 里就收了，click 由浏览器发在按下点与松手点的共同祖先上，
    // 照 click 收就把面板里「选个模型」当成点面板外，整块自定参数面板连 ⋯ 菜单一起收掉
    const onDocPress = (e) => {
        if (moreMenuOpen && !moreMenu.contains(e.target)) closeMoreMenu();
        for (const chip of composerChips) chip.closeOnOutside(e.target);
    };
    document.addEventListener("pointerdown", onDocPress, true);

    // 预设列表（无配方条目，点击填入提示词框）
    presetItem.addEventListener("click", () => {
        closeMoreMenu();
        openPresetList();
    });



    const start = async () => {
        if (running) return;
        let prompts;
        if (gmRandom.enabled) {
            // 运行时随机：从节点同池抽 N 条不重复提示词，逐张批量生成（配方不入池）
            const n = Math.max(1, Math.min(gmRandom.count || 1, 16));
            renderRunning(tf("抽取 {n} 条随机提示词…", { n }));
            let res;
            try {
                res = await randomPrompts(n);
            } catch (e) {
                console.error("[Gallery] random prompts failed:", e);
                failGen(String(e?.message || e));
                return;
            }
            prompts = (res.texts || []).filter(t => t && t.trim());
            if (!prompts.length) { failGen(t("提示词库为空，抽不到随机提示词")); return; }
        } else {
            // 一个框就是最终提示词，固定 skip_enhance（增强是 ⋯ 里的显式动作）
            const prompt = quickInput.value.trim();
            if (!prompt) { quickInput.focus(); return; }
            prompts = [prompt];
        }
        const batch = prompts.length > 1;
        if (!batch) gmHistory.record(prompts[0]);
        running = true;
        cancelRequested = false;
        try {
            if (!batch) {
                renderRunning(t("排队中…"));
                const final = await runOnePrompt(prompts[0], s => renderRunning(s.status === "running" ? t("生图中…") : t("排队中…"), s.progress, s.preview));
                if (final.status === "succeeded") renderSuccess(final);
                else if (final.status === "cancelled") renderError(t("已取消"));
                else failGen(final.error || t("生成失败"));
            } else {
                await runBatch(prompts);
            }
        } catch (e) {
            console.error('[Gallery] gen material failed:', e);
            failGen(String(e?.message || e));
        } finally {
            running = false;
            cancelId = null;
        }
    };

    const onKey = (e) => {
        if (e.key === "Escape") {
            // 有浮层先关浮层，无浮层才关窗
            if (composerChips.some(c => c.isOpen())) { for (const c of composerChips) c.close(); }
            else if (moreMenuOpen) closeMoreMenu();

            else if (presetOverlay.style.display === "flex") presetOverlay.style.display = "none";
            else if (!panel.embedded) close();   // 内嵌面板由绘画页自己管生命周期，Esc 不销毁
        }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) start();
    };

    // 输入卡：一个提示词框 + 底行（技能与自定参数 / 宽高比 / 最长边 … ⋯ 生成）；
    // 结果区在上（预览/成品原位替换），生成后在卡下补操作按钮
    const genBtn = btn(t("生成"), start, true);
    genBtn.classList.add("neo-gallery-gm-gen-btn");
    const composerChips = [skillChip, ratioChip, edgeChip];
    const composer = $el("div", { className: "neo-gallery-gm-composer" }, [
        quickInput,
        $el("div", { className: "neo-gallery-gm-composer-bar neo-gallery-gm-chips" }, [
            skillChip.el,
            sizeRow,
            $el("div", { className: "neo-gallery-gm-composer-gap" }),
            moreBtn,
            genBtn,
        ]),
    ]);

    const modal = $el("div", { className: "neo-gallery-story-modal" + (panel.embedded ? " neo-gallery-story-modal--embedded" : "") }, [
        $el("div", { className: "neo-gallery-story-titlebar" }, [
            $el("span", { className: "neo-gallery-story-title", textContent: t("生成素材") }),
            $el("span", { className: "neo-gallery-story-close", textContent: "\u00D7", onclick: close })
        ]),
        statusBox,
        composer,
        actionsBox
    ]);
    overlay.appendChild(modal);
    // 浮层挂在 overlay 上（z-index 高于弹窗，随窗移除）
    overlay.append(moreMenu, presetOverlay);


    if (!panel.embedded) {
        // 标题栏拖动 + 双击最大化/还原（同导演编辑器模式）
        makeStoryWindowDraggable(modal);
    }

    renderIdle();
    notifyPrefillFilled(opts?.prefill ? applyGmPrefill(opts.prefill) : []);
    document.addEventListener("keydown", onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => { stopQuickTips(); document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDocPress, true); origRemove(); };
    if (panel.embedded) {
        panel.host.appendChild(overlay);
        panel.host.__neoPanelClose = () => { close(); panel.host.__neoPanelRoot = null; panel.host.__neoSetPrompt = null; };
        panel.host.__neoSetPrompt = applyGmPrefill;   // 绘画页里面板已铺好：再来一发只换内容（同图片编辑的 __neoSetSource）
    } else {
        document.body.appendChild(overlay);
    }

    setTimeout(() => quickInput.focus(), 0);
}

// 「再来一发」的比例容差：出图按最长边定尺寸时按 32 对齐，1024×416 已不是整比值 21:9，
// 超出容差就只填最长边，不在 chip 上写一个没人用的比例。
const GM_RATIO_TOLERANCE = 0.02;

function matchGmRatio(w, h) {
    const r = w / h;
    let best = null, bestDev = Infinity;
    // 比例表与宽高比 chip 同源（DIRECTOR_ASPECTS）。比值在调用时算：director.js 与本模块
    // 互为导入，模块求值时那份 const 还没初始化
    for (const [label, a, b] of DIRECTOR_ASPECTS) {
        const dev = Math.abs(a / b - r) / (a / b);
        if (dev < bestDev) { bestDev = dev; best = label.split(" ")[0]; }
    }
    return bestDev <= GM_RATIO_TOLERANCE ? best : null;
}
