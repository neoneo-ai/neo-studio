// NeoH3VideoDirector 节点：在节点内嵌入只读导演时间轴（复用 web/director-timeline.js）。
// 按当前 recipe 下拉值拉取配方 spec，按时长比例绘制分段块 + 秒尺；点击分段块直接打开编辑器（只读，不重排）。
// 采样期间另有一块实时预览面板：后端 h3_preview.py 每步抽多帧、经自有 WS 事件推来，
// 这里自动循环播放该段的动作，并可暂停 / 逐帧 / 逐采样步回看（核心的单图预览通道后端已关掉）。
import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { DirectorTimeline } from "./director-timeline.js";
import { createFramePlayer } from "./live-preview.js";
import { openDirectorEditor, DIRECTOR_RECIPE_SAVED_EVENT } from "./director.js";
import { listRecipes, listVideoSkills, directorMetaText, collectWorkflowResults, addRecipeResults } from "./recipes.js";
import { showToast } from "./gallery-utils.js";
import { attachSkillPickerToComboWidget, listSkills, createSkillStatusRow } from "./skill.js";
import { getSkillGenConfig } from "./image-gen.js";
import { ttlCache } from "./js/core/cache.js";
import { t, tf } from "./js/core/i18n.js";

const TL_H = 120; // 节点内时间轴显示区高度（px），canvas 高 TL_H-8=112，与预览卡一致
const ACT_H = 28; // 时间轴下方操作条高度（「＋ 新增导演配方」按钮行）
const PREVIEW_H = 300; // 运行时实时预览面板默认高度（px）：横向载荷的最小高度，节点据此加高
const PREVIEW_H_MAX = 560; // 竖屏载荷的面板高度上限：按画面比例放大，避免节点被拉得过长
const PREVIEW_CHROME_H = 30; // 面板里画面之外的固定占用（控制条 + 间隙）
const PREVIEW_EVENT = "rs.h3.preview"; // 后端每步推来的多帧载荷（见 h3_preview.py）
const H3_FPS = 24; // 与后端 h3_video_director.H3_FPS 同值：skill config 的 length（帧）折算时长（秒）用
const DURATION_DEFAULT = 5; // 与后端 INPUT_TYPES duration_sec 默认一致（内置 H3 skill config 的 length ≈ 5 秒）

// 画布上存活的预览面板：事件按 node_id 路由（node.id 可能被克隆/载入改写，匹配时现读）
const livePreviews = new Set();

function onPreviewEvent(e) {
    const data = e?.detail;
    if (!data || data.node_id == null) return;
    const wanted = String(data.node_id).split(":").pop(); // 子图里的 UNIQUE_ID 形如 "12:7"
    for (const live of livePreviews) {
        if (String(live.node.id) === wanted) live.apply(data);
    }
}

api.addEventListener(PREVIEW_EVENT, onPreviewEvent);

// 选择窗预览卡的配方 spec 缓存：name -> {shared, segments}；配方保存（新建/编辑/重命名）后清空，
// 避免显示旧分段；TTL 兜底外部改过配方文件的情况
const _recipeSpecCache = ttlCache();
async function fetchRecipeSpec(name) {
    const hit = _recipeSpecCache.get(name);
    if (hit !== undefined) return hit;
    const resp = await api.fetchApi(`/rs_recipes/director_spec?name=${encodeURIComponent(name)}`);
    const data = resp.ok ? await resp.json() : null;
    if (data && data.success) { _recipeSpecCache.set(name, data); return data; }
    return null;
}
// 预览卡概览行的技能列表：整页取一次复用（技能增删后刷新页面即更新）
let _videoSkillsPromise = null;
function videoSkillsOnce() {
    if (!_videoSkillsPromise) _videoSkillsPromise = listVideoSkills();
    return _videoSkillsPromise;
}


// 预览卡时间轴实例（只读，与节点内嵌同款组件）：焦点切换 / 选择窗关闭时销毁，避免残留 ResizeObserver
let _previewCardTL = null;
function destroyPreviewTimeline() {
    if (_previewCardTL) { _previewCardTL.destroy(); _previewCardTL = null; }
}
const PREVIEW_TL_H = 112; // 预览卡时间轴高度（与节点内嵌 canvas 同高）
/** 在预览卡里用只读时间轴画出焦点配方的分段（与节点内嵌同款组件、同映射，含首帧缩略图） */
function mountPreviewTimeline(body, segments) {
    body.innerHTML = "";
    if (!segments || !segments.length) { body.textContent = t("（无分段）"); return; }
    const box = document.createElement("div");
    body.appendChild(box);
    try {
        _previewCardTL = new DirectorTimeline(box, {
            height: PREVIEW_TL_H,
            readOnly: true,
            getSegments: () => segments.map(s => ({
                // 内容派生身份：与节点内嵌时间轴同配色规则
                id: `${s.prompt || ''}|${Number(s.duration_sec) || 0}|${s.ref_input || ''}`,
                duration: Number(s.duration_sec) || 0,
                prompt: s.prompt || "",
                thumbUrl: s.ref_input ? `/view?filename=${encodeURIComponent(s.ref_input)}&subfolder=&type=input` : null,
            })),
        });
    } catch (e) {
        console.error("[Neo Studio] recipe preview timeline init failed", e);
        _previewCardTL = null;
        body.textContent = t("加载失败");
    }
}

/** 配方选择窗的浮动预览卡（替代技能详情预览）：焦点配方的概览行 + 只读时间轴；点击卡片由 onPreviewClick 打开该配方编辑器 */
function renderRecipePreview(preview, it) {
    destroyPreviewTimeline();
    preview.innerHTML = "";
    if (!it) {
        const hint = document.createElement("div");
        hint.className = "rs-skill-preview-empty";
        hint.textContent = t("用 ↑ / ↓ 或悬停浏览配方");
        preview.appendChild(hint);
        return;
    }
    preview.dataset.focusId = it.value;
    const nameEl = document.createElement("div");
    nameEl.className = "rs-skill-preview-name";
    nameEl.textContent = it.label;
    nameEl.title = it.label;
    const metaEl = document.createElement("div");
    metaEl.className = "rs-skill-preview-meta";
    const body = document.createElement("div");
    body.textContent = t("加载中…");
    const hint = document.createElement("div");
    hint.className = "rs-skill-preview-hint";
    hint.textContent = t("点击卡片打开配方编辑器");
    preview.append(nameEl, metaEl, body, hint);
    fetchRecipeSpec(it.value).then((spec) => {
        if (preview.dataset.focusId !== it.value || !preview.isConnected) return; // 焦点已切走或选择窗已关，丢弃过期结果
        mountPreviewTimeline(body, spec ? spec.segments || [] : null);
        if (!spec) return;
        videoSkillsOnce().then((skills) => {
            // 技能列表返回时焦点可能已切走：再校验一次，避免把别的配方的概览写进当前卡
            if (preview.dataset.focusId === it.value && preview.isConnected) metaEl.textContent = directorMetaText(spec, skills);
        });
    }).catch(() => {
        if (preview.dataset.focusId === it.value && preview.isConnected) body.textContent = t("加载失败");
    });
}


/**
 * 节点内实时预览面板：每步一段多帧动画，自动循环 + 暂停 / 逐帧 / 逐采样步。
 * 显示用 <img> 换 src 而不是 canvas：不依赖浏览器解码 API（ImageDecoder 只有 Chromium 有），
 * 且每步的帧先 new Image() 预热进图片缓存，换帧不闪。
 * grow(desiredH) 由调用方提供：按内容比例给面板定高并加高节点（首个载荷可能早于 500ms 轮询）。
 */

/** 面板高度按载荷画面比例定：横向（含无 w/h）保持默认高度，竖屏按节点宽度放大到装得下整幅画面。 */
function previewPanelH(w, h, nodeW) {
    const aw = Number(w) || 0;
    const ah = Number(h) || 0;
    if (aw <= 0 || ah <= 0) return PREVIEW_H;
    const contentW = Math.max(160, (Number(nodeW) || 340) - 24); // 减去节点与面板左右内边距
    const need = Math.round(contentW * (ah / aw)) + PREVIEW_CHROME_H;
    return Math.min(PREVIEW_H_MAX, Math.max(PREVIEW_H, need));
}

function createLivePreview(node, box, grow) {
    // 帧播放器状态机在 live-preview.js（与 Studio 共用）；这里只补节点专属的加高逻辑
    const player = createFramePlayer(box, (data) =>
        grow(previewPanelH(data.w, data.h, node.size && node.size[0])));
    return { node, ...player }; // {node, apply, tick, reset, pause}——接口与原先一致
}

app.registerExtension({
    name: "NeoH3VideoDirector.Timeline",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "NeoH3VideoDirector") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        const origOnRemoved = nodeType.prototype.onRemoved;

        nodeType.prototype.onNodeCreated = function() {
            const result = origOnNodeCreated?.apply(this, arguments);
            const node = this;

            const root = document.createElement("div");
            root.className = "neo-dtl-node";
            const widget = node.addDOMWidget("director_timeline", "custom", root);
            root.style.width = "100%";
            root.style.maxWidth = "none";

            // 实时预览面板：放在 root 内部（时间轴+操作条下方），与时间轴同属一个 DOM widget，
            // 避免两个独立 widget 之间 LiteGraph 的额外间距。bundle 锁定时只隐藏时间轴行和操作条。
            const previewBox = document.createElement("div");
            previewBox.className = "neo-dtl-live";
            previewBox.style.display = "none";
            previewBox.style.height = "0px";
            // 预览面板高度：默认 PREVIEW_H，首个载荷按画面比例重定（竖屏更高）；
            // 之后手动拉高节点时面板吃满多出来的高度（见 updateSize），下方不留空白
            let previewH = PREVIEW_H;
            const setPreviewH = (h) => { previewH = h; previewBox.style.height = h + "px"; };

            // 时间轴显示区（canvas + ✎）；「＋ 新增导演配方」按钮另起一行，位于其下方右下角
            const tlRow = document.createElement("div");
            tlRow.className = "neo-dtl-tlrow";
            root.appendChild(tlRow);

            let tlData = { segments: [] };
            let progress = { active: false, segment_index: -1, total_segments: 0 }; // 当前 director 运行进度（轮询 /neo_video_gen/director_progress）
            let runtimeBaseH = 0; // 节点自然高度（含时间轴+操作条），运行时为采样预览加高后据此还原
            // 后端每步推来的多帧载荷走这里：自动循环播放该步动画，可暂停/逐帧/逐步（见 createLivePreview）
            const live = createLivePreview(node, previewBox, (desiredH) => {
                // 首个载荷可能早于 500ms 进度轮询，先兜一次加高（幂等）；还原仍由轮询负责。
                // 节点已被手动拉高时保留多出来的高度，面板吃掉这部分空间（竖屏时尤其需要）
                if (runtimeBaseH <= 0) { setPreviewH(desiredH); return; }
                const free = Math.round(node.size[1] - runtimeBaseH);
                setPreviewH(free > desiredH ? free : desiredH);
                if (node.size[1] < runtimeBaseH + previewH) node.setSize([node.size[0], runtimeBaseH + previewH]);
            });
            node._neoDtLive = live; // 暴露给测试驱动（tick）
            node._neoDtPreviewBox = previewBox; // 暴露给测试定位面板元素
            // 取消按钮：运行期间显示，点它 POST 后端中断当前 director 任务（进度为进程内单例）
            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = "neo-dtl-live-btn neo-dtl-live-cancel";
            cancelBtn.textContent = "";
            cancelBtn.title = t("取消生成");
            cancelBtn.style.display = "none";
            previewBox.appendChild(cancelBtn);
            node._neoDtCancelBtn = cancelBtn; // 暴露给测试定位按钮
            cancelBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                cancelBtn.disabled = true;
                try {
                    const r = await api.fetchApi("/neo_video_gen/director/cancel", { method: "POST" });
                    const d = await r.json().catch(() => null);
                    if (!r.ok) cancelBtn.title = tf("取消失败：{e}", { e: d?.error || r.status });
                } catch (err) {
                    cancelBtn.title = tf("取消失败：{e}", { e: err.message });
                }
                cancelBtn.disabled = false;
            });
            livePreviews.add(live);
            let tl = null;
            // 「仅运行勾选的段」：时间轴段块左上角勾选框 → 写入隐藏输入 only_segments（1 基段号文本，
            // 空 = 全部段）。勾选是运行期临时状态，不写进配方；换配方 / 加载工作流 / 配方内容变更时清空。
            const onlySegWidget = node.widgets?.find(w => w.name === "only_segments");
            if (onlySegWidget) onlySegWidget.hidden = true;
            let runHint = null;   // 操作条上的提示行（runHint 之后创建，未就绪时只同步输入值）
            const syncOnlySegments = (checked) => {
                const list = checked || [];
                const text = list.map(i => i + 1).join(",");
                if (onlySegWidget) {
                    onlySegWidget.value = text;
                    onlySegWidget.callback?.(text);
                }
                if (!runHint) return;
                runHint.textContent = text ? tf("仅运行勾选的 {n} 段：[{text}]", { n: list.length, text }) : t("未勾选 = 整条配方");
                runHint.title = text
                    ? t("本次只生成勾选的段（其余段不出现在输出里）；勾选只在当前画布会话有效，不写进配方")
                    : t("在时间轴段块左上角勾选要单独运行的段；未勾选时按整条配方从头生成");
            };
            try {
                tl = new DirectorTimeline(tlRow, {
                    height: TL_H - 8,
                    readOnly: true,
                    checkable: true,               // 段块左上角勾选框：只跑勾选的段
                    onCheckChange: syncOnlySegments,
                    onSelect: (i) => openEditor(i), // 点击分段块直接打开编辑器，并定位到该段
                    getProgress: () => progress,   // 各段顶部实时显示生成状态（done/current）
                    getSegments: () => (tlData.segments || []).map(s => ({
                        // 内容派生身份：spec 重载后颜色保持稳定（只读预览不重排）
                        id: `${s.prompt || ''}|${Number(s.duration_sec) || 0}|${s.ref_input || ''}`,
                        duration: Number(s.duration_sec) || 0,
                        prompt: s.prompt || "",
                        thumbUrl: s.ref_input ? `/view?filename=${encodeURIComponent(s.ref_input)}&subfolder=&type=input` : null,
                    })),
                });
            } catch (e) {
                console.error("[Neo Studio] director timeline init failed", e);
            }
            node._neoDtTimeline = tl;

            // 分段列表可能已变（换配方 / 加载工作流 / 配方保存）→ 勾选作废：清空时间轴勾选并同步隐藏输入
            const resetChecks = () => { tl?.clearChecked(); syncOnlySegments(tl ? tl.getChecked() : []); };

            // 轮询 director 运行进度，状态变化时刷新时间轴（节点存活期间每 500ms 一次；端点为 O(1) dict 读）
            const pollProgress = async () => {
                try {
                    const resp = await api.fetchApi("/neo_video_gen/director_progress");
                    if (!resp.ok) return;
                    const p = await resp.json();
                    const prev = progress;
                    progress = { active: !!p.active, segment_index: Number(p.segment_index) || -1, total_segments: Number(p.total_segments) || 0,
                                 step: Number(p.step) || 0, total_steps: Number(p.total_steps) || 0 };
                    if (progress.active !== prev.active || progress.segment_index !== prev.segment_index || progress.total_segments !== prev.total_segments || progress.step !== prev.step) {
                        tl?.refresh();
                        cancelBtn.style.display = progress.active ? "" : "none";   // 运行中才给取消入口
                        // 跟随运行：段切换时把正在生成的块横向滚动到可视区（段多/放大时才需要）
                        if (progress.active && progress.segment_index !== prev.segment_index) tl?.revealSeg(progress.segment_index);
                        // 换段 / 新一轮运行：清空重来（每段的采样步各自从第 1 步计数）；
                        // 运行结束：停在最后一帧暂停，面板保留供逐帧 / 逐采样步回看；并把本次产物路径记回配方
                        if (progress.active !== prev.active || progress.segment_index !== prev.segment_index) {
                            if (progress.active) {
                                live.reset();
                            } else {
                                live.pause();
                                recordResults();
                            }
                        }
                        // 运行时为实时预览面板加高预留空间；结束后面板还在（停在最后一帧）就保持加高，
                        // 本次运行没有任何预览内容才还原自然高度，不留一块空位
                        if (progress.active !== prev.active && runtimeBaseH > 0) {
                            if (progress.active) {
                                // 新一轮：沿用当前高度（手动拉高的部分不丢），首个载荷再按画面比例定
                                setPreviewH(Math.max(PREVIEW_H, Math.round(node.size[1] - runtimeBaseH)));
                                if (node.size[1] < runtimeBaseH + previewH) node.setSize([node.size[0], runtimeBaseH + previewH]);
                            } else if (previewBox.style.display === "none") {
                                node.setSize([node.size[0], runtimeBaseH]);
                            }
                        }
                    }
                } catch (_) {}
            };
            node._neoDtProgressTick = pollProgress; // 供测试直接触发
            node._neoDtProgressTimer = setInterval(pollProgress, 500);

            // 宽度随节点缩放同步（LiteGraph 拖拽缩放不检查 min，这里补钳制；最小高度含时间轴）
            const updateSize = () => {
                if (!widget || !node.size) return;
                if (node.minWidth && node.size[0] < node.minWidth) node.size[0] = node.minWidth;
                if (node.minHeight && node.size[1] < node.minHeight) node.size[1] = node.minHeight;
                widget.width = node.size[0];
                // 运行中手动拉高节点：多出来的高度给预览面板（竖屏尤其需要），下方不留空白。
                // 压到基础高度以下时面板停在默认高度，由 minHeight 兜住不被裁切
                if (runtimeBaseH > 0 && previewBox.style.display !== "none") {
                    setPreviewH(Math.max(PREVIEW_H, Math.round(node.size[1] - runtimeBaseH)));
                }
            };
            node.onResize = node.onResize || function() {};
            const origOnResize = node.onResize;
            node.onResize = function() { updateSize(); origOnResize.apply(this, arguments); };
            updateSize();

            // 节点增高容纳时间轴，并设最小尺寸防止被压缩裁切。
            // computeSize() 返回 widget 自然高度（含 DOM widget TL_H），加 ACT_H（操作条）。
            // 工作流保存的高度可能包含运行时预览面板的额外高度，这里统一重置为自然值。
            const bw = (node.size && node.size[0]) || 340;
            const naturalH = this.computeSize()[1] + ACT_H;
            node.setSize([Math.max(bw, 340), naturalH]);
            node.minWidth = Math.max(bw, 340);
            node.minHeight = naturalH;
            runtimeBaseH = naturalH; // 记录自然高度，供运行时加高/还原采样预览预留区

            // bundle 连接时由 NeoNodes.BundleLock 调用：隐藏时间轴+操作条并收缩节点高度；断开恢复。
            let tlVisible = true;
            node._neoDtApplyBundleLock = (locked) => {
                const visible = !locked;
                if (visible === tlVisible) return;
                tlVisible = visible;
                tlRow.style.display = visible ? "" : "none";
                actBar.style.display = visible ? "" : "none";
                // bundle 单段模式：隐藏 recipe、显示视频 skill 选择器与时长（秒）；断开恢复
                if (recipeWidget) recipeWidget.hidden = !visible;
                if (skillIdWidget) skillIdWidget.hidden = visible;
                if (durationWidget) durationWidget.hidden = visible;
                // 显示态回到建节点时量好的自然高度（含 DOM widget 与操作条）；
                // 隐藏态 DOM widget 量出 0，按 computeSize 扣掉时间轴高度收缩节点
                runtimeBaseH = visible ? naturalH : this.computeSize()[1] - TL_H;
                node.minHeight = runtimeBaseH;
                node.setSize([node.size[0], runtimeBaseH + (previewBox.style.display === "none" ? 0 : previewH)]);
            };

            const recipeWidget = node.widgets?.find(w => w.name === "recipe");
            const skillIdWidget = node.widgets?.find(w => w.name === "skill");
            const durationWidget = node.widgets?.find(w => w.name === "duration_sec");
            // 默认（无 bundle）：显示 recipe、隐藏视频 skill 选择器与时长（秒）；连上 BUNDLE 时由 _neoDtApplyBundleLock 互换。
            if (skillIdWidget) skillIdWidget.hidden = true;
            if (durationWidget) durationWidget.hidden = true;
            // duration（秒）仅 bundle 单段模式使用（recipe 多段的时长在各段自带 duration_sec 里）。
            // 默认 5 秒 = 内置 H3 skill config 的 length（124 帧）；新建节点、bundle 模式里切换 skill 时
            // 按所选 skill config 的 length 重新折算。旧版默认 -1 的哨兵已删：载入工作流时把遗留的
            // -1/0 就地改回 5（同步、不依赖请求），避免「低于最小值 1」校验报错而无法出队。
            let configured = false;
            const repairDuration = () => {
                if (!durationWidget) return false;
                const cur = Number(durationWidget.value);
                if (Number.isFinite(cur) && cur > 0) return false;
                durationWidget.value = DURATION_DEFAULT;
                durationWidget.callback?.(DURATION_DEFAULT);
                return true;
            };
            const applyDurationFromSkill = async (initial = false) => {
                const name = skillIdWidget ? String(skillIdWidget.value || "").replace(/（不可用）$/, "") : ""; // 下拉值可能带「（不可用）」后缀，剥掉再按名反查
                if (!name || !durationWidget) return;
                const repaired = repairDuration(); // 同步修复，fetch 前先保证值合法
                const metas = await listSkills();
                const skills = Array.isArray(metas) ? metas : []; // listSkills 对非 2xx 会把错误体当结果返回，这里兜住
                const id = (skills.find((s) => s.cn_name === name || s.name === name) || { id: name }).id; // combo 存的是 skill 中文名；映射不到就按原值查（旧工作流可能存的是 id/名称）
                const cfg = await getSkillGenConfig(id);
                if (initial && configured && !repaired) return; // 还原的工作流已存值优先；刚修复的继续按 skill config 精确化
                const frames = Number(cfg && cfg.length);
                if (!Number.isFinite(frames) || frames <= 0) return;
                const seconds = Math.max(1, Math.round(frames / H3_FPS));
                if (durationWidget.value === seconds) return;
                durationWidget.value = seconds;
                durationWidget.callback?.(seconds);
            };
            repairDuration();
            applyDurationFromSkill(true);
            if (skillIdWidget) {
                const ocSkill = skillIdWidget.callback;
                skillIdWidget.callback = function() { ocSkill?.apply(this, arguments); applyDurationFromSkill(); if (node._neoDtStatusRow) node._neoDtStatusRow.refresh(); }; // 手动切换 skill 后按新技能重检有效性
            }

            // 运行结束：把本次执行产物（output 目录）的路径记进当前配方 results，
            // 「配方」面板据此点击查看 / 删除真实文件（只记路径，不复制文件）
            const recordResults = async () => {
                const name = recipeWidget ? String(recipeWidget.value || "").trim() : "";
                if (!name) return;   // bundle 单段模式没有配方，跳过
                const results = collectWorkflowResults();
                if (!results.length) return;
                try {
                    const res = await addRecipeResults(name, results);
                    if (!res?.success) console.warn("[Neo Studio] director results not recorded:", res?.error || res);
                } catch (e) {
                    console.warn("[Neo Studio] director results record failed", e);
                }
            };
            // continuity / context_frames：暂不开放给用户设置，只在节点上隐藏 widget。
            // 隐藏≠清空：两个 widget 仍占 widgets_values 的位置、值仍随工作流保存并随 prompt 发给后端，
            // 所以新节点走后端默认（连续性开、窗口 22 帧），旧工作流里已存的值照旧生效。
            for (const nm of ["continuity", "context_frames"]) {
                const w = node.widgets?.find((x) => x.name === nm);
                if (w) w.hidden = true;
            }
            // 点击 recipe / skill combo → 弹居中选择窗（替代原生下拉）。
            // recipe：仅搜索、无底部工具栏，预览卡显示焦点配方只读时间轴（节点内嵌同款组件）；skill：默认技能列表（含管理工具栏）
            const recipeItemsProvider = async (w) => {
                const recipes = (await listRecipes()).filter((r) => r.type === "video_director");
                const allowed = Array.isArray(w?.options?.values) ? w.options.values : null;
                const pool = allowed ? recipes.filter((r) => allowed.includes(r.name)) : recipes;
                return pool.map((r) => ({ value: r.name, label: r.name }));
            };
            if (recipeWidget) attachSkillPickerToComboWidget(recipeWidget, {
                title: t("选择导演配方"),
                showFooter: false,
                itemsProvider: recipeItemsProvider,
                previewRenderer: renderRecipePreview,
                onPreviewClick: (it) => openEditor(-1, it.value), // 点预览卡直接打开该配方的编辑器
                onClose: destroyPreviewTimeline, // 选择窗关闭时销毁预览卡时间轴实例
            });
            if (skillIdWidget) attachSkillPickerToComboWidget(skillIdWidget, { title: t("选择视频技能（H3）") });
            // 按配方默认填充 width/height/steps widget：width/height 优先配方 shared（自定义分辨率），缺省回退首段 skill config；steps 取首段 skill config。
            // 每个配方有自己的硬性要求（如 VDN/turbo 配方要求 steps=8），所以重新载入配方时一律重新初始化，用户手改值也不保留。
            // 唯一例外是创建节点时的首次载入：工作流已存的实值优先，只在仍为默认 -1 时填充。
            const applyDimDefaults = (d, force) => {
                if (!d) return;
                for (const [nm, val] of [["width", d.width], ["height", d.height], ["steps", d.steps]]) {
                    const w = node.widgets?.find((x) => x.name === nm);
                    if (!w || !Number.isFinite(val)) continue;
                    if (!force && Number(w.value) !== -1) continue;
                    w.value = val;
                    w.callback?.(val);
                }
            };

            // specSeq：loadSpec 并发令牌。工作流还原会先后拉两次（创建时的默认值 + configure 后的还原值），
            // 响应可能交错，旧响应用 seq 判废，不得覆盖新值
            let specSeq = 0;
            const loadSpec = async (force = false) => {
                const seq = ++specSeq;
                const name = recipeWidget ? String(recipeWidget.value || "") : "";
                resetChecks();   // 分段可能已变 → 勾选（运行期临时状态）不跨配方保留
                if (!name) { tlData = { segments: [] }; if (tl) tl.refresh(); if (node._neoDtStatusRow) node._neoDtStatusRow.refresh(); return; }
                try {
                    const resp = await api.fetchApi(`/rs_recipes/director_spec?name=${encodeURIComponent(name)}`);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data.success && seq === specSeq) { tlData = data; applyDimDefaults(data.defaults, force); if (tl) tl.refresh(); if (node._neoDtStatusRow) node._neoDtStatusRow.refresh(); }
                    }
                } catch (e) {
                    console.error("[Neo Studio] director spec fetch failed", e);
                }
            };
            loadSpec();

            // 切换 recipe 下拉时重新拉取并重新初始化尺寸/步数（本版本 combo widget 用 callback 触发变化，onchange 不存在）
            if (recipeWidget) {
                const oc = recipeWidget.callback;
                recipeWidget.callback = function() { oc?.apply(this, arguments); loadSpec(true); };
            }

            // 配方编辑器保存成功（任意入口：节点「＋/✎」或侧栏新建/编辑）都会广播，据此刷新下拉候选、
            // 必要时重选并重载时间轴。集中在此一处，避免各入口各自刷导致重复拉取 / 选择冲突。
            const onDirectorRecipeSaved = async (e) => {
                const detail = e?.detail || {};
                _recipeSpecCache.clear(); // 配方内容可能已变（新建/编辑/重命名），预览卡不得再用旧 spec
                try {
                    const directors = (await listRecipes()).filter((r) => r.type === "video_director");
                    if (recipeWidget && Array.isArray(recipeWidget.options?.values)) recipeWidget.options.values = directors.map((r) => r.name);
                    if (recipeWidget) {
                        const cur = String(recipeWidget.value || "").trim();
                        const stillThere = directors.some((r) => r.name === cur);
                        // 新建：选中刚保存的配方；编辑后当前值失效（如重命名）：落到第一个有效项
                        if (detail.created || !stillThere) {
                            recipeWidget.value = (detail.name && directors.some((r) => r.name === detail.name)) ? detail.name : (directors[0]?.name ?? "");
                        }
                    }
                } catch (_) {}
                await loadSpec(true);
            };
            node._neoDtOnRecipeSaved = onDirectorRecipeSaved;
            window.addEventListener(DIRECTOR_RECIPE_SAVED_EVENT, onDirectorRecipeSaved);

            // 时间轴右上角「✎」：打开当前配方的导演编辑器，保存后自动刷新时间轴；
            // 点击分段块时带上该段索引（segIndex），编辑器打开即定位到被点的段；
            // nameOverride 供选择窗预览卡点击直接打开焦点配方（而非当前选中值）
            const openEditor = async (segIndex = -1, nameOverride = "") => {
                const name = nameOverride || (recipeWidget ? String(recipeWidget.value || "").trim() : "");
                if (!name) { showToast(app, "warn", t("请先选择分段配方"), ""); return; }
                editBtn.disabled = true;
                try {
                    const metas = await listRecipes();
                    const meta = metas.find((r) => r.name === name);
                    if (!meta || meta.type !== "video_director") {
                        showToast(app, "warn", tf("未找到分段配方：{name}", { name }), "");
                        return;
                    }
                    await openDirectorEditor(meta, null, segIndex, { node });
                } catch (e) {
                    console.error("[Neo Studio] open director editor failed", e);
                    showToast(app, "error", t("打开配方编辑器失败"), String(e));
                } finally {
                    editBtn.disabled = false;
                }
            };
            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "neo-dtl-edit";
            editBtn.title = t("编辑分段配方");
            editBtn.textContent = "✎";
            editBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
            editBtn.addEventListener("click", (e) => { e.stopPropagation(); openEditor(); });
            tlRow.appendChild(editBtn);

            // 时间轴左侧「」实时预览开关：与节点输入 preview（BOOLEAN）双向同步，随工作流保存。
            // 开（默认）= 采样期间用 taeh3 真彩预览；关 = 本次生成完全不出预览（不受全局预览设置影响）。
            const previewWidget = node.widgets?.find(w => w.name === "preview");
            const previewBtn = document.createElement("button");
            previewBtn.type = "button";
            previewBtn.className = "neo-dtl-preview";
            previewBtn.textContent = "";
            const syncPreviewBtn = () => {
                const on = previewWidget ? !!previewWidget.value : true;
                previewBtn.classList.toggle("neo-dtl-preview-on", on);
                previewBtn.title = on ? t("节点内实时预览：开（taeh3 真彩，≤1024）") : t("节点内实时预览：关（采样期间不出预览）");
            };
            previewBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
            previewBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (!previewWidget) return;
                previewWidget.value = !previewWidget.value;
                previewWidget.callback?.(previewWidget.value);
                syncPreviewBtn();
            });
            if (previewWidget) {
                const origPreviewCallback = previewWidget.callback;
                previewWidget.callback = function() { origPreviewCallback?.apply(this, arguments); syncPreviewBtn(); };
            }
            syncPreviewBtn();
            tlRow.insertBefore(previewBtn, tlRow.firstChild);

            // 工作流还原按 widgets_values 直接写 value、不触发 callback，故在 configure 后补一次同步：
            // 预览按钮态 + 按还原后的 recipe 重拉 spec（onNodeCreated 的首次拉取用的是还原前的默认值，
            // 不补这一次时间轴就会停在默认配方的分段上）
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function() {
                const r = origOnConfigure?.apply(this, arguments);
                configured = true; // 此后已存 widgets_values 优先：初始的时长按 skill 填充不再覆盖
                applyDurationFromSkill(true); // 旧工作流遗留的 -1/0 同步改回 5 秒，避免「低于最小值 1」校验报错
                syncPreviewBtn();
                loadSpec();
                return r;
            };

            // 时间轴显示区外右下角「＋ 新增导演配方」：打开新建模式编辑器；保存后由 DIRECTOR_RECIPE_SAVED_EVENT 统一刷新下拉并选中新配方
            const actBar = document.createElement("div");
            actBar.className = "neo-dtl-actbar";
            const newBtn = document.createElement("button");
            newBtn.type = "button";
            newBtn.className = "neo-dtl-new";
            newBtn.title = t("新建分镜视频导演配方");
            newBtn.textContent = t("＋ 新增导演配方");
            newBtn.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
            newBtn.addEventListener("click", (e) => { e.stopPropagation(); openDirectorEditor(null); });
            actBar.appendChild(newBtn);
            // 勾选提示行：未勾选 = 整条配方；勾选后只跑这些段（勾选不落盘、不跨配方）
            runHint = document.createElement("span");
            runHint.className = "neo-dtl-runhint";
            actBar.insertBefore(runHint, newBtn);   // 靠左（CSS margin-right: auto），「＋」仍在右侧
            syncOnlySegments(tl ? tl.getChecked() : []);
            root.appendChild(actBar);
            root.appendChild(previewBox);

            // 节点底部 Skill 有效性状态条：检测所选视频 skill（bundle 单段，下拉存的是技能名称）或配方各段的 skill，
            // 缺模型/节点时告警并可点开详情修复
            node._neoDtStatusRow = createSkillStatusRow({
                getSkills: () => {
                    const skills = [];
                    if (skillIdWidget) skills.push(String(skillIdWidget.value || ""));
                    for (const seg of (tlData && tlData.segments) || []) if (seg && seg.skill_id) skills.push(String(seg.skill_id));
                    return skills;
                },
                isVideo: true,
            });
            root.appendChild(node._neoDtStatusRow.el);
            node._neoDtStatusRow.refresh(); // 首次检测（loadSpec 完成后也会再触发一次）

            return result;
        };

        nodeType.prototype.onRemoved = function() {
            if (this._neoDtStatusRow) { this._neoDtStatusRow.destroy(); this._neoDtStatusRow = null; }
            if (this._neoDtProgressTimer) { clearInterval(this._neoDtProgressTimer); this._neoDtProgressTimer = null; }
            if (this._neoDtTimeline) { try { this._neoDtTimeline.destroy(); } catch (_) {} this._neoDtTimeline = null; }
            if (this._neoDtLive) { this._neoDtLive.reset(); livePreviews.delete(this._neoDtLive); this._neoDtLive = null; }
            if (this._neoDtOnRecipeSaved) { window.removeEventListener(DIRECTOR_RECIPE_SAVED_EVENT, this._neoDtOnRecipeSaved); this._neoDtOnRecipeSaved = null; }
            return origOnRemoved?.apply(this, arguments);
        };
    },
});
