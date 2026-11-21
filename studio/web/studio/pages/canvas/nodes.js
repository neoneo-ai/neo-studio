// 节点层：节点 DOM、几何落位与选中描边。节点不铺标题栏 —— 图与正文撑满整张节点，附加操作
// （停用 / 选图 / 设为主图 / 提示词 / 复制 / 删除）是浮在节点上沿外头那一排，选中该节点就出现（CSS 认 .ns-canvas-node-on）。
// 节点上的动作都从这里的元素出发，回调交给页面；手势不在这一层（在 interactions.js）。
import { t, tf } from "../../../js/core/i18n.js";
import { setIcon, setIconLabel } from "../../../js/core/icons.js";
import { NODE_TYPES, RUN_LABELS, runKind } from "./node-types.js";
import { storyboardPreviewLines } from "../../storyboard/storyboard.js";

/** 节点 DOM（上游 canvas-node.tsx 的 vanilla 版）：内容铺满整张，上沿外头是附加操作栏，左上角是「主图」徽标，
 *  上下左右四枚接线点、四个角上的尺寸柄。图片节点是 <img>（走 Gallery 缩略图，取不到落占位图），提示词节点是
 *  <textarea>，正文存在 metadata.content —— 图片节点上的坐标就是 Gallery 的 filename + subfolder。
 *  这一张长什么样全按 node-types.js 里那一行落：css 卡面类名、body 内容走哪个渲染器、bar 附加栏多出来的那枚 */
export function nodeElement(node, { $el, onText, onPick, onPickPrompt, onHero, onDelete, onCopy, onToggleDisabled,
    genState, genControls, genModel, editControls, llmControls, storyboardControls, recipeMeta, carView, onCarDuration, onMediaSize }) {
    const desc = NODE_TYPES[node.type] || NODE_TYPES.text;
    // 有运行钮的那几类共用生成节点那一份运行态（running 按节点 id 记在 gen.js 里）；
    // 图片 / 提示词 / 视频位没有运行态 —— 注册表那一行没有 run 的就是这一批
    const st = desc.run ? (genState?.(node) || {}) : null;
    const busy = st?.status === "queued" || st?.status === "running";
    const nodeEl = $el("div", {
        className: `ns-canvas-node ${desc.css}`
            + (busy ? " ns-canvas-node-run" : "")
            + (node.metadata.disabled ? " ns-canvas-node-off" : ""),
        dataset: { nodeId: node.id },
    });
    nodeEl.append(
        desc.body === "image" ? nodeImage(node, $el, onMediaSize)
            : desc.body === "video" ? nodeVideo(node, $el, onMediaSize)
            : desc.body === "audio" ? nodeAudio(node, $el)
            : desc.body === "gen" ? nodeGen(node, $el, { gen: st, genControls, genModel })
            : desc.body === "car" ? nodeCar(node, $el, { recipe: st, carView, recipeMeta, onText, onCarDuration })
            : desc.body === "edit" ? nodeEdit(node, $el, { edit: st, editControls })
            : desc.body === "llm" ? nodeLlm(node, $el, { llm: st, llmControls })
            : desc.body === "storyboard" ? nodeStoryboard(node, $el, { storyboard: st, storyboardControls, onText })
            : nodeText(node, $el, onText),
        nodeBar(node, { $el, onPick, onPickPrompt, onHero, onDelete, onCopy, onToggleDisabled }),
        // 四枚接线点：左与上收线（入），右与下出线（源）。上下这两枚给上下叠放的节点就近接线用
        // （串联铺出来的那几张参考素材就在车厢正上方，按连线接进车厢）
        $el("div", { className: "ns-canvas-handle ns-canvas-handle-left", dataset: { handle: "target", side: "left" } }),
        $el("div", { className: "ns-canvas-handle ns-canvas-handle-top", dataset: { handle: "target", side: "top" } }),
        $el("div", { className: "ns-canvas-handle ns-canvas-handle-bottom", dataset: { handle: "source", side: "bottom" } }),
        $el("div", { className: "ns-canvas-handle ns-canvas-handle-right", dataset: { handle: "source", side: "right" } }),
    );
    if (desc.bar === "hero" && node.metadata.hero) {
        nodeEl.appendChild($el("span", { className: "ns-canvas-node-tag", textContent: t("主图") }));
    }
    if (node.metadata.disabled) {
        nodeEl.appendChild($el("span", { className: "ns-canvas-node-tag", textContent: t("已停用") }));
    }
    for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
        nodeEl.appendChild($el("div", { className: `ns-canvas-resize ns-canvas-resize-${corner}`, dataset: { corner } }));
    }
    return nodeEl;
}

/** 图片节点的内容：整张就是那张图，缩略图缓存不在（刚生成、桌面端离线、素材被移走）时回原图那一条，
 *  原图也没有才落占位图。带 asset 的那一张是「添加配方」铺出来的配方素材（在配方 assets/ 里，
 *  不在 ComfyUI 的 Output 目录），读图走配方那两条路由。
 *  图读上来了就把宽高交回页面落节点的那一格（onMediaSize → page.js 的 fitMediaNode）：
 *  缩略图与素材卡都是同一张图的缩放，比例就是原图的比例 */
function nodeImage(node, $el, onMediaSize) {
    const filename = node.metadata.filename || "";
    const asset = node.metadata.asset || "";
    const recipe = node.metadata.recipe || "";
    const loaded = (e) => onMediaSize?.(node, e.target.naturalWidth, e.target.naturalHeight);
    if (asset && recipe) {
        return $el("img", {
            className: "ns-canvas-node-img",
            src: `/rs_recipes/thumbnail?recipe=${encodeURIComponent(recipe)}`
                + `&file=${encodeURIComponent(asset)}&dir=assets&size=640`,
            alt: asset,
            draggable: "false",
            onload: loaded,
            onerror: (e) => { e.target.src = `/rs_recipes/asset?recipe=${encodeURIComponent(recipe)}`
                + `&file=${encodeURIComponent(asset)}&dir=assets`; },
        });
    }
    return $el("img", {
        className: "ns-canvas-node-img",
        src: filename
            ? `/neo_gallery/thumbnail?filename=${encodeURIComponent(filename)}`
                + `&subfolder=${encodeURIComponent(node.metadata.subfolder || "")}&size=640`
            : "/neo_gallery/placeholder.png",
        alt: filename || t("图片"),
        draggable: "false",
        onload: loaded,
        onerror: (e) => {
            e.target.src = filename && !e.target.dataset.fallback
                ? (e.target.dataset.fallback = "1",
                    `/neo_gallery/image?filename=${encodeURIComponent(filename)}`
                    + `&subfolder=${encodeURIComponent(node.metadata.subfolder || "")}&type=output`)
                : "/neo_gallery/placeholder.png";
        },
    });
}

/** 视频类节点的内容：整张就是那一段片（Output 目录与素材库里的文件，播控交浏览器自己）。出片落点空着是
 *  一张空位 —— 出片时先按连线顺序填这些空位，多出来的才新建节点（见 page.js 的 applyGenResult）；
 *  视频输入节点空着说「空视频输入」，并且不静音 —— 参考片的声音要在画布上听得到，出片那一发吃的就是它 */
function nodeVideo(node, $el, onMediaSize) {
    const filename = node.metadata.filename || "";
    const asset = node.metadata.asset || "";
    const recipe = node.metadata.recipe || "";
    const input = node.type === "video_in";
    // 「添加配方」铺出来的那一段参考视频在配方自己那一份 assets/ 里：播它走配方那一条路由，不经 input/
    const src = asset && recipe
        ? `/rs_recipes/asset?recipe=${encodeURIComponent(recipe)}&file=${encodeURIComponent(asset)}&dir=assets`
        : filename
            ? `/neo_gallery/video?filename=${encodeURIComponent(filename)}`
                + `&subfolder=${encodeURIComponent(node.metadata.subfolder || "")}`
            : "";
    if (!src) {
        return $el("div", { className: "ns-canvas-node-video-empty",
            textContent: t(input ? "空视频输入" : "空视频位") });
    }
    return $el("video", {
        className: "ns-canvas-node-video-el",
        src,
        controls: "", muted: input ? null : "", playsinline: "", preload: "metadata", draggable: "false",
        title: asset || filename,
        // 段的宽高读出来才落节点那一格（preload=metadata 就是为这一发）：竖片落在横框里就是一圈黑边
        onloadedmetadata: (e) => onMediaSize?.(node, e.target.videoWidth, e.target.videoHeight),
    });
}

/** 音频输入节点的内容：浏览器自绘的那一条播控加下面一行出处。文件走 /neo_gallery/audio ——
 *  视频那条按扩展名挡非视频（400），音频吃那条流永远播不出来；空着的是一张空位，
 *  栏上「取用素材」开素材库。「添加配方」铺的那一段参考音频在配方 assets/ 里，播它走配方那一条路由 */
function nodeAudio(node, $el) {
    const filename = node.metadata.filename || "";
    const asset = node.metadata.asset || "";
    const recipe = node.metadata.recipe || "";
    const name = asset || filename;
    if (!name) {
        return $el("div", { className: "ns-canvas-node-video-empty", textContent: t("空音频输入") });
    }
    return $el("div", { className: "ns-canvas-node-audio-body" }, [
        $el("audio", { className: "ns-canvas-node-audio-el", controls: "", preload: "metadata",
            draggable: "false", title: name,
            src: asset && recipe
                ? `/rs_recipes/asset?recipe=${encodeURIComponent(recipe)}&file=${encodeURIComponent(asset)}&dir=assets`
                : `/neo_gallery/audio?filename=${encodeURIComponent(filename)}`
                    + `&subfolder=${encodeURIComponent(node.metadata.subfolder || "")}` }),
        $el("span", { className: "ns-canvas-node-audio-name", textContent: name, title: name }),
    ]);
}

/** 提示词节点的内容：整张就是那块正文。单击不落焦点 —— 浏览器在 mousedown 上默认把焦点交给 textarea，
 *  焦点在里面时 Ctrl+C/V/X/A 全归浏览器自己，节点就再也剪不动了。进编辑是双击（interactions.js 的
 *  onDoubleClick 给焦点），落了焦点之后不拦 —— 划词与光标动作照旧（拖过一截才挪节点，见 CONTENT_DRAG_GATE） */
function nodeText(node, $el, onText) {
    return $el("textarea", {
        className: "ns-canvas-node-textarea",
        value: node.metadata.content || "",
        placeholder: t("写提示词"),
        spellcheck: "false",
        onmousedown: (e) => { if (document.activeElement !== e.target) e.preventDefault(); },
        oninput: (e) => onText(node, e.target.value),
    });
}

/** 控件卡的骨架：一行控件 + 一行这一发的状态 —— 生成 / 编辑 / 增强 / 反推四类控件卡共用这一条。
 *  生成节点把主模型那一行追加在状态行之后，车厢与图片 / 提示词 / 视频位不走这一条 */
function cardShell($el, rows, statusEl) {
    return $el("div", { className: "ns-canvas-gen" }, [
        $el("div", { className: "ns-canvas-gen-ctl" }, rows),
        statusEl,
    ]);
}

/** 卡上那一行状态（RUN_LABELS 里的取值）：出图与编辑数的是张数、增强与反推数的是字数（字数由 gen.js
 *  每 40 字收一次，逐 token 整层重画会把节点上的打字与拖动全卡住）、串联的车尾数的是链上的段数。
 *  失败那一条把后端给的原因留在行上并挂红 */
function statusRow($el, st, labels) {
    const el = $el("div", { className: "ns-canvas-gen-status" });
    const failed = st.status === "failed";
    el.textContent = failed ? (st.error || t(labels.fail))
        : st.status === "running"
            ? (st.total ? tf(labels.progress, { done: st.done, total: st.total })
                : st.done && labels.chars ? tf(labels.chars, { n: st.done }) : t(labels.running))
        : st.status === "queued" ? t(labels.queued) : "";
    el.classList.toggle("ns-canvas-gen-fail", failed);
    return el;
}

/** 生成节点的表面：技能、比例、长边、张数与出图直接铺在节点上（控件由 gen.js 建，改动走 patchMeta），
 *  下面两行是这一发的状态与主模型。控件那一片不拖节点，拖动用其余部分，缩放走四角尺寸柄 */
function nodeGen(node, $el, { gen, genControls, genModel }) {
    const card = cardShell($el, genControls?.(node) || [], statusRow($el, gen || {}, RUN_LABELS[runKind(node)]));
    // 串联车尾的段数、技能、分辨率都在顶行与那两枚胶囊里，这里不再重复一份配方概览
    if (node.metadata?.chain !== "train") {
        card.appendChild($el("div", { className: "ns-canvas-gen-model", textContent: genModel?.(node) || "" }));
    }
    return card;
}

/** 图像编辑节点的内容：一行控件（技能胶囊 · 张数胶囊 · 出图）加一行这一发的状态。要改的那一张与
 *  要用的提示词都不在这张节点上 —— 从连过来的节点取（见 gen.js 的 runEdit） */
function nodeEdit(node, $el, { edit, editControls }) {
    return cardShell($el, editControls?.(node) || [], statusRow($el, edit || {}, RUN_LABELS.edit));
}

/** 增强 / 反推节点的内容：一行控件（技能或语言胶囊 · 运行钮）加一行这一发的状态 —— 要重写的正文与
 *  要反推的那一张都不在这张节点上，从连过来的节点取（见 gen.js 的 runEnhance 与 runReverse） */
function nodeLlm(node, $el, { llm, llmControls }) {
    return cardShell($el, llmControls?.(node) || [], statusRow($el, llm || {}, RUN_LABELS[runKind(node)]));
}

/** 文字故事板节点的内容：要写的那一段话（主题或整篇剧本）就在这张节点上，一行控件（每一段时长 · 运行钮）
 *  加一行这一发的状态，底下是生成出来的每一段预览。正文与那几段都在这一张自己的 metadata 里 ——
 *  进撤销栈、随画布落盘、复制带着走（预览是 metadata.segments 现算的，不另存一份） */
function nodeStoryboard(node, $el, { storyboard, storyboardControls, onText }) {
    const busy = storyboard?.status === "running";
    const text = $el("textarea", {
        className: "ns-canvas-node-textarea ns-canvas-storyboard-text",
        value: node.metadata.content || "",
        placeholder: t("写一段话：一个主题（一只猫去冒险）或整篇剧本（一行一段）"),
        spellcheck: "false",
        onmousedown: (e) => { if (document.activeElement !== e.target) e.preventDefault(); },
        oninput: (e) => onText?.(node, e.target.value),
    });
    if (busy) text.disabled = true;   // 在途的那一发送的是起手这一段话，跑着不许改
    const card = cardShell($el, [text, ...(storyboardControls?.(node) || [])],
        statusRow($el, storyboard || {}, RUN_LABELS.storyboard));
    const lines = storyboardPreviewLines(node.metadata.segments);
    if (lines.length) card.appendChild($el("div", { className: "ns-canvas-storyboard-segs" },
        lines.map((line) => $el("div", { className: "ns-canvas-storyboard-seg", textContent: line }))));
    return card;
}

/** 串联的车厢：这一段自己写的提示词、这一段的时长、停不停用，就这些 —— 技能与整列共用的生成参数都在它那一列的车尾
 *  那台生成节点上，出片也从车尾那一发。三档正文优先级（连过来的正文 > 车厢自己写的 > 配方那一段）在
 *  gen.js 的 carPrompt 里，卡上只铺车厢自己写的那一份；连过来的正文在跑时这块锁着并说出来源 */
function nodeCar(node, $el, { recipe, carView, onText, onCarDuration }) {
    const st = recipe || {};
    const view = carView?.(node) || {};
    const locked = view.fromCanvas === true;
    const busy = st.status === "running" || st.status === "queued";
    // 时长就铺在顶行这一枚数框上：改了写进配方那一段（导演页、重铺一列、出片读的都是这一份）。
    // 跑起来这一发锁着 —— disabled 走属性（与 genBtn 同一坑，$el 把 disabled="false" 也当禁用）
    const durEl = $el("input", {
        className: "ns-canvas-car-dur", type: "number", min: "1", max: "3600", step: "1",
        value: view.duration == null ? "" : String(view.duration),
        title: t("这一段时长（秒）：写进配方那一段，导演页与出片都读这一份"),
        onmousedown: (e) => { if (document.activeElement !== e.target) e.preventDefault(); },
        onchange: (e) => onCarDuration?.(node, e.target.value),
    });
    durEl.disabled = busy;
    // disabled 走属性：$el 把它当普通属性落，disabled="false" 在浏览器里就是真禁用（genBtn 同一坑）
    const text = $el("textarea", {
        className: "ns-canvas-node-textarea ns-canvas-car-text",
        value: view.edit || "",
        placeholder: t("写这一段"),
        spellcheck: "false",
        title: locked ? t("连过来的正文盖过车厢自己写的那一句；断线就回到车厢这一句")
            : t("双击进编辑，正文框里打字"),
        onmousedown: (e) => { if (document.activeElement !== e.target) e.preventDefault(); },
        oninput: (e) => {
            onText?.(node, e.target.value);
            // 来源那一枚当场说这一句走的是哪一档：整层重画会把正在打字的正文框换掉、光标跑掉
            const src = e.target.closest(".ns-canvas-recipe-prompt")?.querySelector(".ns-canvas-recipe-src");
            // 框里铺的就是配方那一段那一份：与它一字不差就是没改过，那一档不写标签；改过才补上「车厢」那一枚
            const edited = e.target.value && e.target.value !== view.seed;
            if (src && !edited) src.remove();
            else if (src) src.textContent = t("车厢");
            else if (edited) e.target.parentNode?.insertBefore(
                $el("span", { className: "ns-canvas-recipe-src", textContent: t("车厢") }), e.target);
        },
    });
    if (locked) text.disabled = true;
    return $el("div", { className: "ns-canvas-car" }, [
        // 顶行就一行：段号 + 这一段时长 + 配方名 · 生效的技能，右端是参考素材计数（段号只写一次）
        $el("div", { className: "ns-canvas-car-head" }, [
            $el("span", { className: "ns-canvas-car-seg", textContent: tf("段 {n}", { n: Number(node.metadata.segment) + 1 }) }),
            durEl,
            $el("span", { className: "ns-canvas-car-info", textContent: view.head || "" }),
            $el("span", { className: "ns-canvas-recipe-count", textContent: tf("{n} 张参考素材", { n: view.count || 0 }) }),
        ]),
        // 配方那一段就是默认来源，不写标签；车厢改过的那一句与连过来的画布正文才标出来
        $el("div", { className: "ns-canvas-recipe-prompt" + (locked ? " ns-canvas-recipe-on" : "") }, [
            ...(view.src && view.src !== t("配方")
                ? [$el("span", { className: "ns-canvas-recipe-src", textContent: view.src })] : []),
            text,
        ]),
        // 整列共用的那一句（段数、模式、技能、宽高、总时长）只在车尾露一份，车厢不重复；这一行只说这一段跑到哪了
        statusRow($el, st, RUN_LABELS.car),
    ]);
}

/** 附加操作栏：停用 / 复制 / 删除每类节点都有一枚，图片节点多一枚主图钮（整片只留一枚），
 *  没填上图的多一枚「选图」。这一排默认不出现，该节点被选中时才浮在节点上沿外头（定位在 style.css），
 *  栏在节点外就不盖卡上的胶囊与正文；点了算 click，起手不拖（见 interactions.js）
 *  提示词节点不在这一排放「进入编辑」那一枚：进编辑是双击正文，出编辑是 Esc 或落在节点外那一按（interactions.js） */
function nodeBar(node, { $el, onPick, onPickPrompt, onHero, onDelete, onCopy, onToggleDisabled }) {
    const desc = NODE_TYPES[node.type] || NODE_TYPES.text;
    const off = node.metadata.disabled === true;
    // 栏首这一枚是固定抓手：整张铺满播控的视频卡上没有按得中的空白，每一张卡都从这一枚起手拖
    const drag = $el("span", { className: "ns-canvas-node-drag", title: t("拖动这张节点"),
        "aria-label": t("拖动这张节点") });
    setIcon(drag, "move");
    const kids = [drag, off
        ? nodeAct($el, "enable", t("启用"), "check", () => onToggleDisabled(node), t("启用这一张：出片与整列出片都会跑它"))
        : nodeAct($el, "disable", t("停用"), "ban", () => onToggleDisabled(node), t("停用这一张：出片与整列出片都跳过它"))];
    if (off) kids[1].classList.add("ns-canvas-node-act-on");
    // 栏里多出来的那一枚看注册表里那一行：图片节点是主图 + 取图（填过图的写「换图」，换的照旧从素材库取），
    // 视频 / 音频输入节点是「取用素材 / 换素材」，提示词节点是提示词库
    if (desc.bar === "hero") {
        const heroLabel = node.metadata.hero ? t("取消主图") : t("设为主图");
        const hero = nodeAct($el, "hero", heroLabel, "circle-check", () => onHero(node), heroLabel);
        if (node.metadata.hero) hero.classList.add("ns-canvas-node-act-on");
        kids.push(hero);
        kids.push(nodePick($el, node, onPick, node.metadata.filename ? t("换图") : t("选图"), "image"));
    }
    if (desc.bar === "media") {
        kids.push(nodePick($el, node, onPick, node.metadata.filename ? t("换素材") : t("取用素材"),
            node.type === "audio_in" ? "volume" : "film"));
    }
    if (desc.bar === "prompt") {
        // 这一枚开的是绘画页同一扇提示词浮层：点一行把整段全文填进正文框
        const prompt = $el("button", { className: "ns-canvas-node-pick", type: "button",
            title: t("从提示词库挑一条填进输入框"), "aria-label": t("提示词"), dataset: { nodeAct: "prompt" },
            onclick: () => onPickPrompt(node, prompt) });
        setIconLabel(prompt, "list", t("提示词"));
        kids.push(prompt);
    }
    kids.push(nodeAct($el, "copy", t("复制"), "copy", () => onCopy(node), t("复制节点")));
    kids.push(nodeAct($el, "delete", t("删除"), "trash", () => onDelete(node), t("删除节点")));
    return $el("div", { className: "ns-canvas-node-bar" }, kids);
}

/** 栏上那一枚取素材：开素材库（按这一类节点只收图 / 视频 / 音频中的一类），取到的那一份填进这一张节点 */
function nodePick($el, node, onPick, label, iconName) {
    const pick = $el("button", { className: "ns-canvas-node-pick", type: "button",
        title: label, "aria-label": label, dataset: { nodeAct: "pick" }, onclick: () => onPick(node) });
    setIconLabel(pick, iconName, label);
    return pick;
}

function nodeAct($el, name, label, iconName, onclick, title = label) {
    const btn = $el("button", { className: "ns-canvas-node-act", type: "button",
        title, "aria-label": label, dataset: { nodeAct: name }, onclick });
    setIcon(btn, iconName);
    return btn;
}

/** 整层节点重画：拖动与缩放不走这一条（走 applyNodeGeometry），换画布、增删节点才走 */
export function renderNodes({ nodeLayer, links, hint, nodes, selectedNodeIds, selectedConnectionId, $el, onText,
    onPick, onPickPrompt, onHero, onDelete, onCopy, onToggleDisabled, genState, genControls, genModel, editControls,
    llmControls, storyboardControls, recipeMeta, carView, onCarDuration, onMediaSize }) {
    nodeLayer.replaceChildren(...nodes.map((node) => nodeElement(node, { $el, onText, onPick, onPickPrompt, onHero, onDelete, onCopy,
        onToggleDisabled, genState, genControls, genModel, editControls, llmControls, storyboardControls, recipeMeta, carView, onCarDuration, onMediaSize })));
    // 几何要在元素挂上世界层之后再落：nodeElement 里查不到还没挂上的元素
    for (const node of nodes) applyNodeGeometry(nodeLayer, node);
    hint.style.display = nodes.length ? "none" : "";
    paintSelection({ nodeLayer, links, selectedNodeIds, selectedConnectionId });
}

/** 一个节点的位置与尺寸落到元素上：拖动与缩放每帧走这一条，不重建节点 */
export function applyNodeGeometry(nodeLayer, node) {
    const nodeEl = nodeLayer?.querySelector(`[data-node-id="${cssEscape(node.id)}"]`);
    if (!nodeEl) return;
    nodeEl.style.left = `${node.position.x}px`;
    nodeEl.style.top = `${node.position.y}px`;
    nodeEl.style.width = `${node.width}px`;
    nodeEl.style.height = `${node.height}px`;
}

/** 选中描边：节点一层 class，连线一层 class（换选中与删完东西之后都要重扫一遍） */
export function paintSelection({ nodeLayer, links, selectedNodeIds, selectedConnectionId }) {
    for (const nodeEl of nodeLayer.children) {
        nodeEl.classList.toggle("ns-canvas-node-on", selectedNodeIds.has(nodeEl.dataset.nodeId));
    }
    for (const path of links.children) {
        path.classList.toggle("ns-canvas-line-on", path.dataset.connectionId === selectedConnectionId);
    }
}

function cssEscape(value) {
    return window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
}
