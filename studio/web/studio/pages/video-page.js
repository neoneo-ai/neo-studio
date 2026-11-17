// 出视频页（#/video）：一句话 + 首帧（可选尾帧 / 参考素材）直接出一段视频。
// 工厂只接装配层给得出的那几样：素材库弹窗与「取一张即收窗」那一条、生成按钮的能力门、
// input/ 素材方块的缩略图 URL 与 copy_to_input 那条取用落盘。
import { api } from "../shim/api.js";
import { t, tf } from "../../js/core/i18n.js";
import { icon, setIcon } from "../../js/core/icons.js";
import { chipButton, ratioGlyph, reuseModelOverlay, setVideoReuseOpen, skillParamsChip } from "../../gallery-gen.js";
import { listVideoSkills } from "../../recipes.js";
import { blockingMissingModels, createVideoModelConfigSection, getSkillGenConfig, listVideoGenModels } from "../../image-gen.js";
import { skillDisplayName } from "../../skill.js";
import { queueTrack } from "../../queue-panel.js";
import { createMediaSlot } from "../../js/core/media-slot.js";
import { openPresetPicker, randomPromptText, savePromptTo } from "../../js/core/preset-picker.js";

export function createVideoPage({ $el, toast, go, openLibModal, closeLibModal, gateRunButton, thumbSrc, copyPickedToInput, modeGroup, groupLabels, defaultSkill }) {
// ====== 视频页：一句话 + 首帧（可选尾帧 / 参考图）直接出一段视频 ======
// 独立于导演多段流程：不建配方、不读配方，参数在本页 composer 里现填，提交后端简单视频接口。
// 版面照 ArtCraft 的 Create Video：整页是舞台，空着时正中盖一句起手提示（版式同绘画页 idle），
// 底部浮一张胶囊 composer（素材方块 + 提示词 + 芯片行 + 生成钮）；出片后提示淡出，成片卡片进舞台滚动。
// 分辨率档就是 MiniMax H3 的画布档（短边 768、面积上限 768×1344，官方节点按轴 32 对齐）：每一档横竖
// 成对排在一起，竖屏就是同一档宽高对调——像素量与对齐要求同档同值，模型侧不需要第二条解析路
const VIDEO_SIZE_CHOICES = [
    [624, 352, "352p 横屏"], [352, 624, "352p 竖屏"],
    [768, 432, "432p 横屏"], [432, 768, "432p 竖屏"],
    [1024, 576, "576p 横屏"], [576, 1024, "576p 竖屏"],
    [1280, 720, "720p 横屏"], [720, 1280, "720p 竖屏"],
    [1344, 768, "768p 横屏"], [768, 1344, "768p 竖屏"],
    [1920, 1080, "1080p 横屏"], [1080, 1920, "1080p 竖屏"],
];
const VIDEO_DUR_CHOICES = [3, 5, 8, 10, 15];
// 参考素材那一行的三类上限（与后端 _MAX_REF 同档）：一行混收，各类各收各的，总数 = 三者之和
const VIDEO_REF_MAX = { image: 9, video: 3, audio: 3 };
const VIDEO_REF_TOTAL = Object.values(VIDEO_REF_MAX).reduce((a, b) => a + b, 0);
const VIDEO_TERMINAL = ["succeeded", "failed", "cancelled"];
const VIDEO_LAST_SKILL_KEY = "neo.video.skill";

function buildVideo(el) {
    el.classList.add("ns-video");
    const page = $el("div", { className: "ns-video-page" });
    el.appendChild(page);

    const stage = $el("div", { className: "ns-video-stage" });
    const hero = $el("section", { className: "ns-video-hero" }, [
        // 文案样式直接借绘画页的页内 idle（.neo-gallery-gm-idle 那三级类），两页起手提示长一个样
        $el("div", { className: "ns-video-hero-card neo-gallery-gm-idle" }, [
            $el("div", { className: "neo-gallery-gm-idle-title", textContent: t("创建视频") }),
            $el("div", { className: "neo-gallery-gm-idle-sub", textContent: t("选一张图，写一句话，然后生成") }),
            $el("i", { className: "ns-video-corner c-tl" }),
            $el("i", { className: "ns-video-corner c-tr" }),
            $el("i", { className: "ns-video-corner c-bl" }),
            $el("i", { className: "ns-video-corner c-br" }),
        ]),
    ]);

    // 素材方块走共用组件 js/core/media-slot.js：这一页的落点是「取用即 copy_to_input 落进 input 根目录」，
    // 缩略图就是 input 的 /view。kindMax 给了就是混收那一行：素材库媒体全收，取用的按扩展名归入
    // 图 / 视频 / 音频，各类按各自上限收——上限、类型归类与技能槽位门控都写在组件里。
    function mediaSlot(label, multiple, maxN, kindMax = null) {
        return createMediaSlot({
            label, multiple, maxN, kindMax,
            thumbSrc,
            toast,
            refKinds: () => (kindMax ? (selectedMeta()?.gen_config?.ref_kinds || null) : null),
            pick: ({ accept, multiple: keepOpen, gate, add }) => openLibModal("video", async (picked) => {
                const ok = gate(picked);   // 先过闸：挡下的不 copy_to_input，input 目录不留用不上的文件
                const filled = [];
                for (const a of ok) {
                    try { filled.push({ ...a, value: await copyPickedToInput(a.src) }); }
                    catch (e) { toast(tf("取用素材失败：{msg}", { msg: e.message })); }
                }
                add(filled);
                if (!keepOpen) closeLibModal();   // 首帧 / 尾帧取一张即收窗；参考素材留着弹窗好连选
            }, accept),
        });
    }

    const firstSlot = mediaSlot("首帧", false, 1);
    const lastSlot = mediaSlot("尾帧", false, 1);
    const refSlot = mediaSlot("参考素材", true, VIDEO_REF_TOTAL, VIDEO_REF_MAX);

    const promptIn = $el("textarea", {
        className: "ns-video-prompt neo-gallery-gm-quick-input", rows: "2", spellcheck: "false",
        placeholder: t("描述这段视频要拍成什么样…"),
    });
    const promptCount = $el("span", { className: "ns-video-count", textContent: "0 / ∞" });
    promptIn.addEventListener("input", () => { promptCount.textContent = `${promptIn.value.length} / ∞`; });

    const skillSel = $el("select", { className: "ns-video-skill", title: t("技能与自定参数：主模型 / LoRA 留空 = 跟随该技能配置与全局生视频设置") });
    skillSel.appendChild($el("option", { value: "", textContent: t("（加载视频技能…）") }));
    // 自定参数（本次临时换主模型 / 编码器 / VAE / 步数 / LoRA，空值 = 跟随该技能配置与全局生视频设置）：
    // 与技能同一枚 chip，点开从上方浮出双栏面板——左栏技能按生成模式分组，右栏生视频模型 / 步数 / LoRA
    const videoCfg = createVideoModelConfigSection();
    const videoParamsBox = $el("div", { className: "neo-gallery-gm-model-box" });
    videoParamsBox.appendChild(videoCfg.el);
    const skillChip = skillParamsChip(skillSel, videoParamsBox, {
        icon: "film",
        groupOf: modeGroup,
        groupLabels,
        getOverride: () => videoCfg.collect(),
    });
    videoParamsBox.addEventListener("change", () => skillChip.sync());

    const selectedMeta = () => skillSel.options[skillSel.selectedIndex]?.__skillMeta || null;
    const selectedGroup = () => modeGroup(selectedMeta());
    let videoModels = null;   // 自定参数面板的模型列表：没拉到就整块不发覆盖值，技能配置照常生效

    // 素材槽位随技能家族显隐：关键帧生视频给首帧 / 尾帧，全参考生视频给参考素材那一行。
    // 隐藏的槽位不进 payload——留着上一家族的首帧去跑 r2v，后端按资产推模式就会推错
    const applyVideoSlots = () => {
        const f2v = selectedGroup() === "f2v";
        firstSlot.el.classList.toggle("ns-hidden", !f2v);
        lastSlot.el.classList.toggle("ns-hidden", !f2v);
        refSlot.el.classList.toggle("ns-hidden", f2v);
    };

    // 换技能 = 把自定参数整块换成该技能 config 里钉的那一套（与绘画页同一语义）；
    // 「再来一发」带 reuseOverlay = 在技能配置上盖那一发的生效值，面板显示的就是重放要用的那一套
    const applySkillConfig = async (skillId, reuseOverlay = null) => {
        if (!skillId || !videoModels) return;
        const cfg = await getSkillGenConfig(skillId);
        // 「再来一发」带进来的步数是那一发的显式值（重放要照发）；技能配置铺的不算这一发的覆盖
        videoCfg.load({ ...(cfg || {}), ...(reuseOverlay || {}) }, videoModels,
            { stepsFromRun: Number(reuseOverlay?.steps) >= 1 });
        skillChip.sync();   // 程序改 value 不触发 change：chip 标签自己跟上
    };

    skillSel.addEventListener("change", () => {
        applyVideoSlots();
        applyEffectOptions();
        applySkillConfig(skillSel.value);
        try { localStorage.setItem(VIDEO_LAST_SKILL_KEY, skillSel.value); } catch { /* 隐私模式下记不住就算了，不挡生成 */ }
    });
    applyVideoSlots();

    const skillsReady = listVideoSkills().then((list) => {
        skillSel.textContent = "";
        for (const s of list) {
            // 特效技能缺 LoRA 时后端把 available 判成 false（skill._video_skill_available），下拉里要说出来
            const opt = $el("option", { value: s.id, textContent: skillDisplayName(s) + (s.available === false ? t("（不可用）") : "") });
            opt.__skillMeta = s;   // 分组与主模型副标题取这份元数据（会话页技能面板同一约定）
            skillSel.appendChild(opt);
        }
        if (!list.length) skillSel.appendChild($el("option", { value: "", textContent: t("（无可用视频技能）") }));
        let last = "";
        try { last = localStorage.getItem(VIDEO_LAST_SKILL_KEY) || ""; } catch { last = ""; }
        skillSel.value = list.some((s) => s.id === last) ? last : defaultSkill(list);
        skillChip.sync();   // 技能是异步填进 select 的，chip 显示的生效值得跟着重读
        applyVideoSlots();
        applyEffectOptions();
        applySkillConfig(skillSel.value);
    }).catch(() => {
        skillSel.textContent = "";
        skillSel.appendChild($el("option", { value: "", textContent: t("（无可用视频技能）") }));
        skillChip.sync();
    }).then(() => { });   // 预填要等技能落进下拉才动技能行：与绘画页的 skillsReady 同一约定

    // 模型列表拉一次：先按「自动」渲染覆盖区，再覆盖成当前技能配置；拉不到保持空下拉（等效跟随设置，不挡生成）
    const modelsReady = listVideoGenModels().then((models) => {
        videoModels = models || {};
        videoCfg.load({}, videoModels);
        applySkillConfig(skillSel.value);
    }).catch(() => {});

    const sizeSel = $el("select", { className: "ns-video-size" });
    for (const [w, h, label] of VIDEO_SIZE_CHOICES)
        sizeSel.appendChild($el("option", { value: `${w},${h}`, textContent: tf("{w}×{h} · {label}", { w, h, label: t(label) }) }));
    sizeSel.value = "1344,768";

    const durSel = $el("select", { className: "ns-video-dur" });
    for (const sec of VIDEO_DUR_CHOICES)
        durSel.appendChild($el("option", { value: String(sec), textContent: tf("{n} 秒", { n: sec }) }));
    durSel.value = "5";

    // 特效表技能（config.json 的 effects，后端 skill._attach_video_effects 发的那一份）才有这一枚；
    // 技能没有特效表时整枚收起——页面不摆一个只会跑默认特效的下拉
    const effectSel = $el("select", { className: "ns-video-effect", title: t("特效本体是技能钉着的嵌入文件：缺文件的特效标不可用，选了也进不了队列") });
    const effectChip = chipButton(effectSel, { icon: "sparkles" });
    const skillEffects = () => selectedMeta()?.effects || [];
    const effectEntry = (id) => skillEffects().find((e) => e.id === id) || null;
    const applyEffectPrompt = () => {
        // 示例提示词进占位符：这一发该写什么样的画面，技能比页面懂
        promptIn.placeholder = effectEntry(effectSel.value)?.prompt_default || t("描述这段视频要拍成什么样…");
    };
    const applyEffectOptions = () => {
        const list = skillEffects();
        effectSel.textContent = "";
        for (const e of list) {
            // 缺本体的特效照样列出来：说清它现在跑不了，去模型库补完回来就能选
            effectSel.appendChild($el("option", { value: e.id, textContent: e.label + (e.ready === false ? t("（不可用）") : "") }));
        }
        effectChip.el.style.display = list.length ? "" : "none";
        const def = effectEntry((selectedMeta() || {}).effect) || list.find((e) => e.ready !== false) || list[0];
        effectSel.value = def ? def.id : "";
        applyEffectPrompt();
        effectChip.sync();
    };
    effectSel.addEventListener("change", applyEffectPrompt);

    const seedIn = $el("input", { className: "ns-video-seed neo-gallery-gm-chip-btn", type: "number", min: "-1", placeholder: t("随机") });
    const seedRoll = $el("button", { className: "ns-video-seed-roll", type: "button", title: t("换一个随机种子") });
    setIcon(seedRoll, "sparkles", 13);
    seedRoll.onclick = () => { seedIn.value = String(Math.floor(Math.random() * 1e15)); };

    // 芯片行就是会话页那枚工厂的产物：胶囊 chip + 从上方浮出的选项菜单，原生 select 收在壳里当状态容器
    // 分辨率 chip 用比例 glyph（与绘画页比例 chip 同一枚）：选中竖屏档时方框立起来，不看字也知道是竖屏
    const sizeChip = chipButton(sizeSel, { glyph: ratioGlyph() });
    const durChip = chipButton(durSel, { icon: "clock" });
    const chips = [skillChip, sizeChip, effectChip, durChip];
    for (const c of chips) c.el.classList.add("ns-video-chip");
    const seedChip = $el("label", { className: "ns-video-chip neo-gallery-gm-chip-group", title: t("种子") }, [icon("sparkles", 12), seedIn, seedRoll]);
    // 菜单开着的 chip 要点外面才收；换页会重建这一页，页面离场时把监听摘掉，别一次次堆在 document 上。
    // 收在 pointerdown 这一发上而不是 click：combo 在列表项的 mousedown 里就收起了挂在 body 上的列表，
    // 松手落在浮层底下的页面元素上，浏览器按规范把 click 发在按下点与松手点的共同祖先（这一页里就是
    // document.body）上——照 click 收菜单的话，自定参数面板里选一次 VAE 就成了「点面板外」，
    // 整块面板连技能列一起收掉。按下点的 target 才是用户真正指的那 element，列表项在 inOpenComboList 里。
    const onDocPress = (e) => {
        if (!document.body.contains(page)) { document.removeEventListener("pointerdown", onDocPress, true); return; }
        for (const c of chips) c.closeOnOutside(e.target);
        if (videoMoreOpen && !videoMoreMenu.contains(e.target)) closeVideoMore();
    };
    document.addEventListener("pointerdown", onDocPress, true);

    // ⋯ 菜单（复用生成素材面板那枚 ⋯ 与运行时菜单样式）：保存当前提示词落视频池
    // （custom/video/，名字带 video/ 前缀，与本页「提示词」「随机」同一池）
    let videoMoreOpen = false;
    const videoMoreBtn = $el("button", { className: "neo-gallery-gm-tool-btn ns-video-more", type: "button", textContent: "⋯", title: t("更多：保存当前提示词") });
    const videoMoreMenu = $el("div", { className: "rs-runtime-menu ns-video-more-menu" });
    const videoSaveName = $el("input", { className: "neo-gallery-gm-menu-input", type: "text", placeholder: t("起个名字") });
    const videoSaveBtn = $el("button", { className: "neo-gallery-story-btn", type: "button", textContent: t("保存") });
    const closeVideoMore = () => { videoMoreOpen = false; videoMoreMenu.style.display = "none"; };
    videoMoreMenu.append($el("div", { className: "neo-gallery-gm-enhance-group" }, [
        $el("div", { className: "neo-director-field-label", textContent: t("保存当前提示词（视频池）") }),
        $el("div", { className: "rs-runtime-row" }, [videoSaveName, videoSaveBtn]),
    ]));
    videoMoreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (videoMoreOpen) { closeVideoMore(); return; }
        videoMoreMenu.style.display = "block";
        videoMoreOpen = true;
        const r = videoMoreBtn.getBoundingClientRect();
        videoMoreMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - videoMoreMenu.offsetWidth - 8))}px`;
        const above = r.top - videoMoreMenu.offsetHeight - 6;
        videoMoreMenu.style.top = `${above > 8 ? above : r.bottom + 6}px`;
    });
    videoSaveBtn.addEventListener("click", async () => {
        const text = promptIn.value.trim();
        if (!text) { toast(t("提示词是空的，没有可保存的提示词")); promptIn.focus(); return; }
        videoSaveBtn.disabled = true;
        try {
            const saved = await savePromptTo("video", videoSaveName.value, text);
            toast(tf("已存入视频提示词库：{name}", { name: saved }));
            videoSaveName.value = "";
            closeVideoMore();
        } catch (e) {
            toast(String(e?.message || e));   // 离线那一发是「保存提示词需要 ComfyUI 运行」，由 savePromptTo 说清楚
        } finally {
            videoSaveBtn.disabled = false;
        }
    });

    const runBtn = $el("button", { className: "ns-video-run neo-gallery-story-btn neo-gallery-story-btn-primary neo-gallery-gm-gen-btn", type: "button", textContent: t("生成") });
    gateRunButton(runBtn, "simple_video", t("生成视频"));
    const cancelBtn = $el("button", { className: "ns-video-cancel neo-gallery-story-btn", type: "button", textContent: t("取消"), style: { display: "none" } });

    const statusEl = $el("div", { className: "ns-video-status" });
    const barEl = $el("div", { className: "ns-gen-progress ns-video-progress" }, [$el("div")]);

    const dock = $el("div", { className: "ns-video-dock" }, [
        $el("div", { className: "ns-video-card neo-gallery-gm-composer" }, [
            $el("div", { className: "ns-video-head" }, [statusEl, barEl]),
            $el("div", { className: "ns-video-top" }, [
                $el("div", { className: "ns-video-deck" }, [firstSlot.el, lastSlot.el, refSlot.el]),
                $el("div", { className: "ns-video-input" }, [promptIn, promptCount]),
            ]),
            $el("div", { className: "ns-video-chips neo-gallery-gm-composer-bar neo-gallery-gm-chips" }, [
                skillChip.el,
                sizeChip.el,
                effectChip.el,
                durChip.el,
                seedChip,
                $el("div", { className: "neo-gallery-gm-composer-gap" }),
                videoMoreBtn,
                cancelBtn,
                runBtn,
            ]),
        ]),
    ]);
    page.appendChild(stage);
    page.appendChild(hero);
    page.appendChild(dock);

    // 右上浮一枚入口列（绝对定位同绘画页那一列，不为它们空出一行）：组合钮左半挑一条词、右半骰子抽一条视频提示词
    const fillVideoPrompt = (text) => {
        promptIn.value = text;
        promptCount.textContent = `${promptIn.value.length} / ∞`;
        promptIn.focus();
    };
    const videoPresetBtn = $el("button", { type: "button", className: "ns-btn ns-video-preset-btn", textContent: t("提示词"), title: t("从视频提示词列表里挑一条填进提示词") });
    const videoRandomBtn = $el("button", { type: "button", className: "ns-btn ns-video-random-btn", title: t("随机填入一条视频提示词") });
    setIcon(videoRandomBtn, "dice");
    const videoBar = $el("div", { className: "ns-video-bar ns-paint-bar" }, [
        $el("div", { className: "neo-split-btn" }, [videoPresetBtn, videoRandomBtn]),
    ]);
    videoPresetBtn.addEventListener("click", () => openPresetPicker({ kind: "video", onPick: fillVideoPrompt, anchor: videoPresetBtn }));
    videoRandomBtn.addEventListener("click", async () => {
        try {
            const text = await randomPromptText("video");
            if (!text.trim()) { toast(t("提示词库为空，抽不到视频提示词")); return; }
            fillVideoPrompt(text);
        } catch (e) { toast(String(e?.message || e)); }   // 同上：离线那一发的原因由 randomPromptText 说清楚
    });
    page.appendChild(videoBar);
    // ⋯ 菜单挂在页面上（.rs-runtime-menu 是 fixed 定位，随页面离场由 onDocPress 摘监听）
    page.appendChild(videoMoreMenu);


    // --- 生成 + 轮询 + 取消（无画布、无采样实时预览：只有排队 / 进度条 / 成片） ---
    let state = null;   // {task_id, pollTimer, terminal, done}
    const stopPolling = () => { if (state?.pollTimer) clearInterval(state.pollTimer); };

    // 成片进舞台：新卡插到最前，hero 标题淡出（淡出后 pointer-events 本就关着，卡片照常可点）
    const addClip = (task) => {
        const url = `/view?filename=${encodeURIComponent(task.filename)}&subfolder=${encodeURIComponent(task.subfolder || "")}&type=output`;
        stage.prepend($el("div", { className: "ns-video-clip" }, [
            $el("video", { className: "ns-video-player", controls: true, autoplay: true, src: url }),
            $el("div", { className: "ns-video-clip-meta" }, [
                $el("span", { className: "ns-video-clip-name", textContent: task.filename }),
                $el("a", { className: "ns-video-open", href: url, target: "_blank", rel: "noreferrer", textContent: t("在浏览器中打开") }),
            ]),
        ]));
        hero.classList.add("ns-video-hero-off");
    };

    const renderTask = (task) => {
        if (!state || task.task_id !== state.task_id) return;
        if (state.terminal && !VIDEO_TERMINAL.includes(task.status)) return;   // 终态后在途旧载荷不得复活进度条 / 取消
        if (VIDEO_TERMINAL.includes(task.status)) {
            state.terminal = true;
            cancelBtn.style.display = "none";
        }
        barEl.style.display = task.status === "running" ? "block" : "none";
        if (task.status === "queued") {
            statusEl.textContent = t("排队中…· 顶栏「队列」看进度");
        } else if (task.status === "running") {
            const p = task.progress;
            statusEl.textContent = p ? tf("生成中… {value}/{max}", { value: p.value, max: p.max }) : t("生成中…");
            if (p) barEl.firstElementChild.style.width = `${Math.round(100 * p.value / p.max)}%`;
        } else if (task.status === "succeeded" && !state.done) {
            state.done = true;   // 终态可能在途轮询重复到达：成片卡片只挂一次
            statusEl.textContent = tf("已完成：{filename}", { filename: task.filename });
            addClip(task);
        } else if (task.status === "failed") {
            statusEl.textContent = tf("失败：{error}", { error: task.error || t("未知错误") });
        } else if (task.status === "cancelled") {
            statusEl.textContent = t("已取消");
        }
        cancelBtn.style.display = (task.status === "queued" || task.status === "running") ? "" : "none";
    };

    const startPolling = (task) => {
        state = { task_id: task.task_id, pollTimer: null, terminal: false, done: false };
        renderTask(task);
        const poll = async () => {
            try {
                const r = await api.fetchApi(`/neo_video_gen/simple/${task.task_id}`);
                const d = await r.json();
                if (!state || state.terminal) return;
                if (d?.success) { renderTask(d); if (VIDEO_TERMINAL.includes(d.status)) stopPolling(); }
            } catch { /* 网络抖动忽略，下一轮再试 */ }
        };
        state.pollTimer = setInterval(poll, 2000);
    };

    async function submitVideo() {
        const meta = selectedMeta();
        // 只发当前家族用得上的槽位：切过家族留下的旧素材混进这一发，就是让它替模式说话
        const f2v = selectedGroup() === "f2v";
        const first = f2v ? firstSlot.first() : null;
        const last = f2v ? lastSlot.first() : null;
        const refs = f2v ? [] : refSlot.get();
        if (meta?.requires_ref && !first && !last && !refs.length) {
            // 后端对这批技能是硬要求（无帧的 fl2v / 无参考的 r2v 必败），在这里说清楚比跑完再报错省一整发
            statusEl.textContent = f2v
                ? t("该技能需要参考素材：首帧 / 尾帧至少选一张")
                : t("该技能需要参考素材：至少选一张图 / 视频 / 音频");
            return;
        }
        // 特效技能缺本体的文件就不进队列：缺嵌入的那一发跑完也只是「没有特效的片」（ComfyUI 读不到
        // embedding: 段只 warning 后忽略），预检自带「去模型库」直达，与生图的生成前预检同一条
        const effect = skillEffects().length ? effectSel.value : "";
        const blocked = await blockingMissingModels(skillSel.value, effect);
        if (blocked) {
            statusEl.textContent = blocked;
            return;
        }
        const [w, h] = (sizeSel.value || "1344,768").split(",").map(Number);
        const body = {
            prompt: promptIn.value.trim(),
            skill_id: skillSel.value,
            references: first ? [first, ...refs] : refs,
            last_frame: last || null,
            width: w, height: h,
            duration_sec: Number(durSel.value),
            seed: seedIn.value === "" ? -1 : Number(seedIn.value),
        };
        if (effect) body.effect = effect;   // 特效表技能交特效 id；后端认这个 id 拼嵌入段与特效契约
        // 自定参数只带非空项：空 = 这一发跟着技能配置与全局生视频设置走（与生图覆盖同一口径）
        if (videoModels) {
            const ov = videoCfg.collect();
            if (ov.model) body.model = ov.model;
            if (ov.text_encoder) body.text_encoder = ov.text_encoder;
            if (ov.vae) body.vae = ov.vae;
            if (ov.audio_vae) body.audio_vae = ov.audio_vae;
            // 步数只在用户改过面板时才发：特效技能把步数钉在特效项上，发了就把那一发契约改了
            if (ov.steps && !videoCfg.stepsFollowSkill()) body.steps = ov.steps;
            if (ov.loras.length) body.loras = ov.loras;
        }
        runBtn.disabled = true;
        try {
            const r = await api.fetchApi("/neo_video_gen/simple", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            const data = await r.json().catch(() => null);
            if (!r.ok || !data?.success) {
                statusEl.textContent = tf("生成失败：{msg}", { msg: data?.error || r.status });
                runBtn.disabled = false;
                return;
            }
            startPolling(data);
            queueTrack("simple", data, { label: body.prompt });
            toast(tf("已加入队列：{label} · 顶栏「队列」看进度", { label: body.prompt.slice(0, 40) }));
            runBtn.disabled = false;   // 提交成功就把按钮交回：这一发在顶栏队列里跑，用户能接着排下一发
        } catch (e) {
            statusEl.textContent = tf("生成失败：{msg}", { msg: e.message });
            runBtn.disabled = false;
        }
    }

    runBtn.addEventListener("click", () => submitVideo());
    cancelBtn.addEventListener("click", async () => {
        if (!state) return;
        cancelBtn.disabled = true;
        try {
            const r = await api.fetchApi(`/neo_video_gen/simple/${state.task_id}/cancel`, { method: "POST" });
            const data = await r.json().catch(() => null);
            if (!r.ok) statusEl.textContent = tf("取消失败：{msg}", { msg: data?.error || r.status });
        } catch (e) {
            statusEl.textContent = tf("取消失败：{msg}", { msg: e.message });
        }
        cancelBtn.disabled = false;
    });

    // 素材卡「再来一发」：这一发的生效参数（副文件记的）填回本页 composer。面板常驻不重建，
    // 只换内容；逐项校验，面板认不出的（技能不在下拉、模型不在清单与家族判定内、时长不在档位、
    // 随机种子）整项不填，填完的清单交给复用提示。
    const prefillVideo = async (reuse) => {
        await skillsReady;
        const filled = [];
        const skillId = String(reuse?.skill || "");
        const hasSkill = skillId && [...skillSel.options].some((o) => o.value === skillId);
        if (hasSkill) {
            skillSel.value = skillId;
            skillChip.sync();
            applyVideoSlots();
            applyEffectOptions();
            try { localStorage.setItem(VIDEO_LAST_SKILL_KEY, skillId); } catch { /* 隐私模式记不住就算了 */ }
            filled.push(t("技能与自定参数"));
        } else if (skillId) {
            // 技能被删了或换了类：下拉里没有这一项就填不进去，说清是哪一张、去哪改，其余项照填
            toast(tf("技能「{skill}」在这页没有位置：技能项没填，到技能页改这张技能再回来", { skill: skillId }));
        }
        // 特效项认这一发记的那个特效 id：认得才填，认不出就停在技能默认那一个（不写假承诺）
        const effectId = String(reuse?.effect || "");
        if (effectId && [...effectSel.options].some((o) => o.value === effectId)) {
            effectSel.value = effectId;
            applyEffectPrompt();
            effectChip.sync();
            filled.push(t("特效"));
        }
        const f2v = hasSkill && modeGroup(selectedMeta()) === "f2v";
        const src = reuse?.src?.filename ? reuse.src : null;
        const last = reuse?.last?.filename ? reuse.last : null;
        const refs = (reuse?.refs || []).filter((r) => r?.filename);
        firstSlot.fill(f2v && src ? [src] : []);
        lastSlot.fill(f2v && last ? [last] : []);
        refSlot.fill(f2v ? [] : [src, ...refs].filter(Boolean));
        const mediaNames = [];
        if (f2v) {
            if (src) mediaNames.push(t("首帧"));
            if (last) mediaNames.push(t("尾帧"));
        } else if (src || refs.length) {
            mediaNames.push(t("参考素材"));
        }
        if (mediaNames.length) filled.push(mediaNames.join("、"));
        const seed = Number(reuse?.seed);
        if (Number.isFinite(seed) && seed >= 0) {
            seedIn.value = String(seed);
            filled.push(t("种子"));
        }
        if (reuse?.width && reuse?.height) {
            const value = `${reuse.width},${reuse.height}`;
            if ([...sizeSel.options].some((o) => o.value === value)) {
                sizeSel.value = value;
                filled.push(t("出片尺寸"));
            }
        }
        if (reuse?.duration && VIDEO_DUR_CHOICES.includes(Number(reuse.duration))) {
            durSel.value = String(Number(reuse.duration));
            filled.push(t("时长"));
        }
        if (String(reuse?.prompt || "").trim()) {
            promptIn.value = String(reuse.prompt).trim();
            promptCount.textContent = `${promptIn.value.length} / ∞`;
            filled.push(t("提示词"));
        }
        // 自定参数整块 = 那一发的生效值盖在技能配置上；主模型与 LoRA 只留清单里还在盘上的
        await modelsReady;
        if (hasSkill && videoModels) {
            const ov = reuseModelOverlay(reuse, videoModels, selectedMeta());
            const cfgOv = { ...ov };
            for (const key of ["text_encoder", "vae", "audio_vae"]) {
                const name = reuse?.[key];
                const pool = key === "text_encoder" ? videoModels.text_encoders : videoModels.vae;
                if (name && (pool || []).includes(name)) cfgOv[key] = name;
            }
            if (Number(reuse?.steps) >= 1) cfgOv.steps = Number(reuse.steps);
            await applySkillConfig(skillId, cfgOv);
        }
        return filled;
    };
    setVideoReuseOpen((reuse) => {
        go("video");   // 走 hash 换页（与绘画页入口同一约定），本页在位时只显隐
        return prefillVideo(reuse);
    });
}
    return { buildVideo };
}
