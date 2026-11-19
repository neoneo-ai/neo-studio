// 节点层：节点 DOM、几何落位与选中描边。节点不铺标题栏 —— 图与正文撑满整张节点，附加操作
// （停用 / 选图 / 设为主图 / 复制 / 删除）是浮在节点上沿外头那一排，选中该节点就出现（CSS 认 .ns-canvas-node-on）。
// 节点上的动作都从这里的元素出发，回调交给页面；手势不在这一层（在 interactions.js）。
import { t, tf } from "../../../js/core/i18n.js";
import { setIcon, setIconLabel } from "../../../js/core/icons.js";

/** 节点 DOM（上游 canvas-node.tsx 的 vanilla 版）：内容铺满整张，上沿外头是附加操作栏，左上角是「主图」徽标，
 *  上下左右四枚接线点、四个角上的尺寸柄。图片节点是 <img>（走 Gallery 缩略图，取不到落占位图），提示词节点是
 *  <textarea>，正文存在 metadata.content —— 图片节点上的坐标就是 Gallery 的 filename + subfolder */
export function nodeElement(node, { $el, onText, onPick, onHero, onDelete, onCopy, onToggleDisabled,
    genState, genControls, genModel, recipeMeta, carView, onImageSize }) {
    const gen = node.type === "gen" ? (genState?.(node) || {}) : null;
    const recipe = node.type === "recipe" ? (genState?.(node) || {}) : null;
    const busy = (gen || recipe)?.status === "queued" || (gen || recipe)?.status === "running";
    const nodeEl = $el("div", {
        className: "ns-canvas-node "
            + (node.type === "image" ? "ns-canvas-node-image"
                : node.type === "gen" ? "ns-canvas-node-gen"
                : node.type === "video" ? "ns-canvas-node-video"
                : node.type === "recipe" ? "ns-canvas-node-recipe" : "ns-canvas-node-text")
            + (busy ? " ns-canvas-node-run" : "")
            + (node.metadata.disabled ? " ns-canvas-node-off" : ""),
        dataset: { nodeId: node.id },
    });
    nodeEl.append(
        node.type === "image" ? nodeImage(node, $el, onImageSize)
            : node.type === "video" ? nodeVideo(node, $el)
            : node.type === "gen" ? nodeGen(node, $el, { gen, genControls, genModel })
            : node.type === "recipe" ? nodeCar(node, $el, { recipe, carView, recipeMeta, onText })
            : nodeText(node, $el, onText),
        nodeBar(node, { $el, onPick, onHero, onDelete, onCopy, onToggleDisabled }),
        // 四枚接线点：左与上收线（入），右与下出线（源）。上下这两枚给上下叠放的节点就近接线用
        // （串联铺出来的那几张参考素材就在车厢正上方，按连线接进车厢）
        $el("div", { className: "ns-canvas-handle ns-canvas-handle-left", dataset: { handle: "target", side: "left" } }),
        $el("div", { className: "ns-canvas-handle ns-canvas-handle-top", dataset: { handle: "target", side: "top" } }),
        $el("div", { className: "ns-canvas-handle ns-canvas-handle-bottom", dataset: { handle: "source", side: "bottom" } }),
        $el("div", { className: "ns-canvas-handle ns-canvas-handle-right", dataset: { handle: "source", side: "right" } }),
    );
    if (node.metadata.hero) {
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
 *  图读上来了就把宽高交回页面落节点的那一格（onImageSize → page.js 的 fitImageNode）：
 *  缩略图与素材卡都是同一张图的缩放，比例就是原图的比例 */
function nodeImage(node, $el, onImageSize) {
    const filename = node.metadata.filename || "";
    const asset = node.metadata.asset || "";
    const recipe = node.metadata.recipe || "";
    const loaded = (e) => onImageSize?.(node, e.target.naturalWidth, e.target.naturalHeight);
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

/** 视频节点的内容：整张就是那一段片（Output 目录里的文件，播控交浏览器自己）。没落上片的是一张空位 ——
 *  出片时先按连线顺序填这些空位，多出来的才新建节点（见 page.js 的 applyGenResult） */
function nodeVideo(node, $el) {
    const filename = node.metadata.filename || "";
    if (!filename) {
        return $el("div", { className: "ns-canvas-node-video-empty", textContent: t("空视频位") });
    }
    return $el("video", {
        className: "ns-canvas-node-video-el",
        src: `/neo_gallery/video?filename=${encodeURIComponent(filename)}`
            + `&subfolder=${encodeURIComponent(node.metadata.subfolder || "")}`,
        controls: "", muted: "", playsinline: "", preload: "metadata", draggable: "false",
        title: filename,
    });
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

/** 生成节点的表面：技能、比例、长边、张数与出图直接铺在节点上（控件由 gen.js 建，改动走 patchMeta），
 *  下面两行是这一发的状态与主模型。控件那一片不拖节点，拖动用其余部分，缩放走四角尺寸柄 */
function nodeGen(node, $el, { gen, genControls, genModel }) {
    const st = gen || {};
    const failed = st.status === "failed";
    // 串联的车尾跑的是链上一列段，那一行数的是段数，不是某一发的步数
    const stepLabel = st.kind === "chain" ? "串联出片 {done}/{total}" : "生成中 {done}/{total}";
    const status = failed ? (st.error || t("出图失败"))
        : st.status === "running" ? (st.total ? tf(stepLabel, { done: st.done, total: st.total }) : t("生成中"))
        : st.status === "queued" ? t("排队中") : "";
    return $el("div", { className: "ns-canvas-gen" }, [
        $el("div", { className: "ns-canvas-gen-ctl" }, genControls?.(node) || []),
        $el("div", { className: "ns-canvas-gen-status" + (failed ? " ns-canvas-gen-fail" : ""), textContent: status }),
        // 串联车尾的段数、技能、分辨率都在顶行与那两枚胶囊里，这里不再重复一份配方概览
        ...(node.metadata?.chain === "train" ? []
            : [$el("div", { className: "ns-canvas-gen-model", textContent: genModel?.(node) || "" })]),
    ]);
}

/** 串联的车厢：这一段自己写的提示词、停不停用，就这些 —— 技能与整列共用的生成参数都在它那一列的车尾
 *  那台生成节点上，出片也从车尾那一发。三档正文优先级（连过来的正文 > 车厢自己写的 > 配方那一段）在
 *  gen.js 的 carPrompt 里，卡上只铺车厢自己写的那一份；连过来的正文在跑时这块锁着并说出来源 */
function nodeCar(node, $el, { recipe, carView, onText }) {
    const st = recipe || {};
    const view = carView?.(node) || {};
    const failed = st.status === "failed";
    const status = failed ? (st.error || t("出片失败"))
        : st.status === "running" ? (st.total ? tf("生成中 {done}/{total}", { done: st.done, total: st.total }) : t("生成中"))
        : st.status === "queued" ? t("排队中") : "";
    const locked = view.fromCanvas === true;
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
        // 顶行就一行：段号 + 配方名 · 这一段时长 · 生效的技能，右端是参考素材计数（段号只写一次）
        $el("div", { className: "ns-canvas-car-head" }, [
            $el("span", { className: "ns-canvas-car-seg", textContent: tf("段 {n}", { n: Number(node.metadata.segment) + 1 }) }),
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
        $el("div", { className: "ns-canvas-gen-status" + (failed ? " ns-canvas-gen-fail" : ""), textContent: status }),
    ]);
}

/** 附加操作栏：停用 / 复制 / 删除每类节点都有一枚，图片节点多一枚主图钮（整片只留一枚），
 *  没填上图的多一枚「选图」。这一排默认不出现，该节点被选中时才浮在节点上沿外头（定位在 style.css），
 *  栏在节点外就不盖卡上的胶囊与正文；点了算 click，起手不拖（见 interactions.js）
 *  提示词节点不在这一排放「进入编辑」那一枚：进编辑是双击正文，出编辑是 Esc 或落在节点外那一按（interactions.js） */
function nodeBar(node, { $el, onPick, onHero, onDelete, onCopy, onToggleDisabled }) {
    const off = node.metadata.disabled === true;
    // 栏首这一枚是固定抓手：整张铺满播控的视频卡上没有按得中的空白，每一张卡都从这一枚起手拖
    const drag = $el("span", { className: "ns-canvas-node-drag", title: t("拖动这张节点"),
        "aria-label": t("拖动这张节点") });
    setIcon(drag, "move");
    const kids = [drag, off
        ? nodeAct($el, "enable", t("启用"), "check", () => onToggleDisabled(node), t("启用这一张：出片与整列出片都会跑它"))
        : nodeAct($el, "disable", t("停用"), "ban", () => onToggleDisabled(node), t("停用这一张：出片与整列出片都跳过它"))];
    if (off) kids[1].classList.add("ns-canvas-node-act-on");
    if (node.type === "image") {
        const heroLabel = node.metadata.hero ? t("取消主图") : t("设为主图");
        const hero = nodeAct($el, "hero", heroLabel, "circle-check", () => onHero(node), heroLabel);
        if (node.metadata.hero) hero.classList.add("ns-canvas-node-act-on");
        kids.push(hero);
        if (!node.metadata.filename) {
            const pick = $el("button", { className: "ns-canvas-node-pick", type: "button",
                title: t("选图"), "aria-label": t("选图"), dataset: { nodeAct: "pick" }, onclick: () => onPick(node) });
            setIconLabel(pick, "image", t("选图"));
            kids.push(pick);
        }
    }
    kids.push(nodeAct($el, "copy", t("复制"), "copy", () => onCopy(node), t("复制节点")));
    kids.push(nodeAct($el, "delete", t("删除"), "trash", () => onDelete(node), t("删除节点")));
    return $el("div", { className: "ns-canvas-node-bar" }, kids);
}

function nodeAct($el, name, label, iconName, onclick, title = label) {
    const btn = $el("button", { className: "ns-canvas-node-act", type: "button",
        title, "aria-label": label, dataset: { nodeAct: name }, onclick });
    setIcon(btn, iconName);
    return btn;
}

/** 整层节点重画：拖动与缩放不走这一条（走 applyNodeGeometry），换画布、增删节点才走 */
export function renderNodes({ nodeLayer, links, hint, nodes, selectedNodeIds, selectedConnectionId, $el, onText,
    onPick, onHero, onDelete, onCopy, onToggleDisabled, genState, genControls, genModel,
    recipeMeta, carView, onImageSize }) {
    nodeLayer.replaceChildren(...nodes.map((node) => nodeElement(node, { $el, onText, onPick, onHero, onDelete, onCopy,
        onToggleDisabled, genState, genControls, genModel, recipeMeta, carView, onImageSize })));
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
