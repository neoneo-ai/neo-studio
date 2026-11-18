// 节点层：节点 DOM、几何落位与选中描边。节点不铺标题栏 —— 图与正文撑满整张节点，附加操作
// （停用 / 进入编辑 / 选图 / 设为主图 / 复制 / 删除）是浮在节点上沿外头那一排，只在该节点被选中时出现（CSS 认 .ns-canvas-node-on）。
// 节点上的动作都从这里的元素出发，回调交给页面；手势不在这一层（在 interactions.js）。
import { t, tf } from "../../../js/core/i18n.js";
import { setIcon, setIconLabel } from "../../../js/core/icons.js";

/** 节点 DOM（上游 canvas-node.tsx 的 vanilla 版）：内容铺满整张，上沿外头是附加操作栏，左上角是「主图」徽标，
 *  上下左右四枚接线点、四个角上的尺寸柄。图片节点是 <img>（走 Gallery 缩略图，取不到落占位图），提示词节点是
 *  <textarea>，正文存在 metadata.content —— 图片节点上的坐标就是 Gallery 的 filename + subfolder */
export function nodeElement(node, { $el, onText, onPick, onHero, onDelete, onCopy, onExpand, onToggleDisabled,
    genState, genControls, genModel, recipeState, recipeControls, recipeMeta, carView }) {
    const gen = node.type === "gen" ? (genState?.(node) || {}) : null;
    const recipe = node.type === "recipe" ? (recipeState?.(node) || {}) : null;
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
        node.type === "image" ? nodeImage(node, $el)
            : node.type === "video" ? nodeVideo(node, $el)
            : node.type === "gen" ? nodeGen(node, $el, { gen, genControls, genModel })
            : node.type === "recipe" ? (node.metadata.train === 1
                ? nodeCar(node, $el, { recipe, carView, recipeControls })
                : nodeRecipe(node, $el, { recipe, recipeControls, recipeMeta }))
            : nodeText(node, $el, onText),
        nodeBar(node, { $el, onPick, onHero, onDelete, onCopy, onExpand, onToggleDisabled }),
        // 四枚接线点：左与上收线（入），右与下出线（源）。上下这两枚给上下叠放的节点就近接线用
        // （串联展开把正文铺在车厢正上方、参考素材铺在正下方），样式上平时收着，见 style.css
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
 *  原图也没有才落占位图。带 asset 的那一张是「展开配方」铺进来的配方素材（在配方 assets/ 里，
 *  不在 ComfyUI 的 Output 目录），读图走配方那两条路由 */
function nodeImage(node, $el) {
    const filename = node.metadata.filename || "";
    const asset = node.metadata.asset || "";
    const recipe = node.metadata.recipe || "";
    if (asset && recipe) {
        return $el("img", {
            className: "ns-canvas-node-img",
            src: `/rs_recipes/thumbnail?recipe=${encodeURIComponent(recipe)}`
                + `&file=${encodeURIComponent(asset)}&dir=assets&size=640`,
            alt: asset,
            draggable: "false",
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
 *  onDoubleClick 给焦点），落了焦点之后不拦 —— 划词与光标动作照旧（拖过一截才挪节点，见 TEXT_DRAG_GATE） */
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
        $el("div", { className: "ns-canvas-gen-model", textContent: genModel?.(node) || "" }),
    ]);
}

/** 配方闭环节点的表面：配方、段、锚点与出片铺在节点上（控件由 gen.js 建，同一套胶囊与状态行），
 *  下面两行是这一发的状态与配方概览。产物是一段片，落进下游的视频节点 */
function nodeRecipe(node, $el, { recipe, recipeControls, recipeMeta }) {
    const st = recipe || {};
    const failed = st.status === "failed";
    const status = failed ? (st.error || t("出片失败"))
        : st.status === "running" ? (st.total ? tf("生成中 {done}/{total}", { done: st.done, total: st.total }) : t("生成中"))
        : st.status === "queued" ? t("排队中") : "";
    return $el("div", { className: "ns-canvas-gen" }, [
        $el("div", { className: "ns-canvas-gen-ctl" }, recipeControls?.(node) || []),
        $el("div", { className: "ns-canvas-gen-status" + (failed ? " ns-canvas-gen-fail" : ""), textContent: status }),
        $el("div", { className: "ns-canvas-gen-model", textContent: recipeMeta?.(node) || "" }),
    ]);
}

/** 串联的车厢：这一段显示什么与停不停用，就这些。出片与整列共用的锚点 / 连续性 / 上下文帧 / 步数 / 种子
 *  都在它那一列的车尾那台生成节点上，这一段在跑时状态行跟着那一发的进度走 */
function nodeCar(node, $el, { recipe, carView, recipeControls }) {
    const st = recipe || {};
    const view = carView?.(node) || {};
    const failed = st.status === "failed";
    const status = failed ? (st.error || t("出片失败"))
        : st.status === "running" ? (st.total ? tf("生成中 {done}/{total}", { done: st.done, total: st.total }) : t("生成中"))
        : st.status === "queued" ? t("排队中") : "";
    return $el("div", { className: "ns-canvas-car" }, [
        $el("div", { className: "ns-canvas-car-head" }, [
            $el("span", { className: "ns-canvas-car-seg", textContent: tf("段 {n}", { n: Number(node.metadata.segment) + 1 }) }),
            $el("span", { className: "ns-canvas-car-info", textContent: view.head || "" }),
            ...(recipeControls?.(node) || []),
        ]),
        $el("div", { className: "ns-canvas-recipe-prompt" + (view.fromCanvas ? " ns-canvas-recipe-on" : "") }, [
            $el("span", { className: "ns-canvas-recipe-src", textContent: view.fromCanvas ? t("画布") : t("配方") }),
            $el("span", { className: "ns-canvas-recipe-text", textContent: view.prompt || "" }),
        ]),
        $el("div", { className: "ns-canvas-car-refs" }, [
            ...(view.refs || []),
            $el("span", { className: "ns-canvas-recipe-count", textContent: tf("{n} 张参考素材", { n: view.count || 0 }) }),
        ]),
        $el("div", { className: "ns-canvas-gen-status" + (failed ? " ns-canvas-gen-fail" : ""), textContent: status }),
    ]);
}

/** 附加操作栏：停用与复制、删除每类节点都有；图片节点多一枚主图钮（整片只留一枚），
 *  没填上图的多一枚「选图」，配方节点前一枚「展开配方」。这一排默认不出现，节点被选中时才浮在节点上沿外头（定位在 style.css），
 *  栏在节点外就不盖卡上的胶囊与正文；点了算 click，起手不拖（见 interactions.js）
 *  提示词节点不在这一排放「进入编辑」那一枚：进编辑是双击正文，出编辑是 Esc 或落在节点外那一按（interactions.js） */
function nodeBar(node, { $el, onPick, onHero, onDelete, onCopy, onExpand, onToggleDisabled }) {
    const off = node.metadata.disabled === true;
    const act = (name, label, fn, title = label) => {
        const btn = $el("button", { className: "ns-canvas-node-act", type: "button",
            title, "aria-label": label, dataset: { nodeAct: name }, onclick: fn });
        setIcon(btn, name === "delete" ? "trash" : name === "copy" ? "copy"
            : name === "expand" ? "maximize" : name === "disable" ? "ban"
            : name === "enable" ? "check" : "circle-check");
        return btn;
    };
    const kids = [off
        ? act("enable", t("启用"), () => onToggleDisabled(node), t("启用这一张：出片与整列出片都会跑它"))
        : act("disable", t("停用"), () => onToggleDisabled(node), t("停用这一张：出片与整列出片都跳过它"))];
    if (off) kids[0].classList.add("ns-canvas-node-act-on");
    // 车厢是展开出来的那一段，不再给它「展开配方」那一枚：点了是把同一份配方再铺一遍
    if (node.type === "recipe" && node.metadata.train !== 1) kids.push(act("expand", t("展开配方"), () => onExpand(node)));
    if (node.type === "image") {
        const heroLabel = node.metadata.hero ? t("取消主图") : t("设为主图");
        const hero = act("hero", heroLabel, () => onHero(node));
        if (node.metadata.hero) hero.classList.add("ns-canvas-node-act-on");
        kids.push(hero);
        if (!node.metadata.filename) {
            const pick = $el("button", { className: "ns-canvas-node-pick", type: "button",
                title: t("选图"), "aria-label": t("选图"), dataset: { nodeAct: "pick" }, onclick: () => onPick(node) });
            setIconLabel(pick, "image", t("选图"));
            kids.push(pick);
        }
    }
    kids.push(act("copy", t("复制节点"), () => onCopy(node)));
    kids.push(act("delete", t("删除节点"), () => onDelete(node)));
    return $el("div", { className: "ns-canvas-node-bar" }, kids);
}

/** 整层节点重画：拖动与缩放不走这一条（走 applyNodeGeometry），换画布、增删节点才走 */
export function renderNodes({ nodeLayer, links, hint, nodes, selectedNodeIds, selectedConnectionId, $el, onText,
    onPick, onHero, onDelete, onCopy, onExpand, onToggleDisabled, genState, genControls, genModel,
    recipeState, recipeControls, recipeMeta, carView }) {
    nodeLayer.replaceChildren(...nodes.map((node) => nodeElement(node, { $el, onText, onPick, onHero, onDelete, onCopy,
        onExpand, onToggleDisabled, genState, genControls, genModel, recipeState, recipeControls, recipeMeta, carView })));
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
