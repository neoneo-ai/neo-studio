/**
 * lib-modal.js — Studio 素材库 / 配方弹窗的通用外壳
 * 外壳只管：开合、Esc / 遮罩 / ✕ 关闭、最大化与还原、拖标题栏挪窗（拖完就是浮窗，右缘调宽）、
 * 底部「取用已选」条的显隐；内容（画廊宿主、配方面板）由调用方 setContent 塞进来。
 * 开在哪、铺多大存 localStorage：max 是「下次铺满整窗」偏好，x / y / w / h 是浮窗摆位。
 * 取用语义交给调用方：setPickMode 传入后，单点素材卡片 = 取用并关窗；卡片左上角勾选进
 * 底部取用条批量取用。不传则卡片保持画廊原行为（点开灯箱）。
 */
import { $el } from "../../../../scripts/ui.js";
import { t, tf } from "./i18n.js";
import { icon } from "./icons.js";
import { isPickableImage } from "../../gallery-utils.js";

// 单点取用只认媒体文件：卡片网格里有 Lora / txt / 工作流这类文件，点它们开灯箱才对
const PICKABLE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|avif|mp4|mov|webm|mkv|avi|mp3|wav|m4a|flac)$/i;
// 取用方收哪一类：图片编辑的原图与参考位只吃图，视频落进 <img> 就是破图；出片参考区与抽帧页吃的正是视频；
// 声音克隆页要的是音频，图片塞进波形控件就是解不出声的静音条。
// 不传 accept 就是媒体全收——导演页一直靠这条路透视频，把默认值收紧会连出片的素材一起挡掉
const PICK_ACCEPT = {
    image: isPickableImage,
    video: (f) => /\.(mp4|mov|webm|mkv|avi)$/i.test(f),
    audio: (f) => /\.(mp3|wav|m4a|flac|ogg|aac)$/i.test(f),
};

/** 建一枚弹窗外壳；宿主自己挂进 document.body。storageKey 存浮窗摆位与最大化偏好，scope 写进 data-lib-scope 供页面定位这扇窗。 */
export function createLibraryModal({ storageKey = "neo_studio_libmodal", scope = "assets" } = {}) {
    let opened = false;
    let pickHandler = null;   // 单点取用：(images: [{filename, subfolder}]) => void
    let pickAccept = null;    // 这一扇弹窗放行哪一类素材（(filename) => bool），close 时归零
    let bulkHandler = null;   // 底部「取用已选」：自己从宿主的多选集合取值
    let clearHandler = null;  // 取用条「清空」：交给宿主清它自己的多选集合
    let onCloseCb = null;
    let geo = { x: 0, y: 0, w: 0, h: 0, max: false, float: false };
    let maxed = false;   // 本窗铺满状态：拖一下就转浮窗，max 偏好留给下一次开

    const overlay = $el("div", { className: "ns-libmodal ns-hidden", role: "dialog", "aria-modal": "true", dataset: { libScope: scope } });
    const titleEl = $el("span", { className: "ns-libmodal-title" });
    // 标题栏右侧的插槽（最大化钮之前）：宿主把自己的搜索框塞进来，空着就不占标题栏的宽度
    const titleSlot = $el("div", { className: "ns-libmodal-titlebar-slot" });
    const maxBtn = $el("button", { className: "ns-libmodal-btn ns-libmodal-max", type: "button" }, [icon("maximize", 14)]);
    const closeBtn = $el("button", { className: "ns-libmodal-btn ns-libmodal-close", type: "button", title: t("关闭（Esc）") }, [icon("cross", 14)]);
    const head = $el("div", { className: "ns-libmodal-titlebar", title: t("拖动标题栏移动弹窗 · Esc 关闭") }, [titleEl, titleSlot, maxBtn, closeBtn]);
    const content = $el("div", { className: "ns-libmodal-content" });
    const pickCount = $el("span", { className: "ns-libmodal-pick-count" });
    const pickClear = $el("button", { className: "ns-btn ns-libmodal-pick-clear", type: "button", textContent: t("清空") });
    const pickUse = $el("button", { className: "ns-btn ns-libmodal-pick-use", type: "button" });
    const pickbar = $el("div", { className: "ns-libmodal-pickbar ns-libmodal-pick ns-hidden" }, [pickCount, pickClear, pickUse]);
    const resizeEl = $el("div", { className: "ns-libmodal-resize", title: t("拖动调整宽度（下限 640px）") });
    const box = $el("div", { className: "ns-libmodal-box" }, [head, content, pickbar, resizeEl]);
    overlay.appendChild(box);

    const renderMaxBtn = () => {
        maxBtn.replaceChildren(icon(maxed ? "restore" : "maximize", 14));
        maxBtn.title = maxed ? t("还原") : t("最大化");
    };
    // 浮窗下限：再窄也留得下画廊顶栏与右侧表单，拖出的摆位不能把窗口弄没
    const MIN_W = 640, MIN_H = 400;
    const readGeo = () => {
        try {
            const raw = JSON.parse(localStorage.getItem(storageKey) || "null");
            if (!raw || typeof raw !== "object") return null;
            const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
            return { x: n(raw.x), y: n(raw.y), w: n(raw.w), h: n(raw.h), max: raw.max === true, float: raw.float === true };
        } catch { return null; }
    };
    const saveGeo = () => {
        try { localStorage.setItem(storageKey, JSON.stringify(geo)); } catch { /* 偏好写不进不影响用 */ }
    };
    const applyGeo = () => {
        const floated = geo.float && !maxed;
        overlay.classList.toggle("ns-libmodal-maximized", maxed);
        overlay.classList.toggle("ns-libmodal-floated", floated);
        if (floated) {
            box.style.left = geo.x + "px";
            box.style.top = geo.y + "px";
            box.style.width = Math.max(MIN_W, geo.w || MIN_W) + "px";
            box.style.height = Math.max(MIN_H, geo.h || MIN_H) + "px";
        } else {
            box.style.left = box.style.top = box.style.width = box.style.height = "";
        }
        renderMaxBtn();
    };
    const toggleMax = () => { geo.max = !geo.max; maxed = geo.max; applyGeo(); saveGeo(); };

    // 拖窗与调宽共用一套收尾。move / up 只在起点元素上收的话，光标一离开那条标题栏
    // （或 8px 宽的调宽条），松手那一发就不经过它 —— 手势永不结束，弹窗就一直跟着鼠标跑，
    // 也就是「拖动了释放不掉」。move / up 一律在 window 上收；再配上指针捕获，
    // 在窗口外松手那一发 up 也会回到页面（pywebview 里把窗拖出窗口很常见）。
    let endGesture = null;
    const beginGesture = (captureEl, e, move, onEnd) => {
        if (endGesture) endGesture();   // 上一段还没收尾的手势先收掉，不留挂着的 window 监听
        try { captureEl.setPointerCapture(e.pointerId); } catch { /* 捕获不上，window 上照收 */ }
        const end = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
            endGesture = null;
            onEnd();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
        endGesture = end;
    };

    // 挪窗：标题栏空白处按下接管指针，按钮与插槽里的控件上的按下不抢，交给它们自己
    // （标题栏搜索框里按下就是打字，抢走指针等于一点输入框就把窗拖走）。
    // 最大化下拖一下就是浮窗（max 偏好留着，下次开仍铺满整窗）
    head.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button, .ns-libmodal-titlebar-slot")) return;
        e.preventDefault();
        const r = box.getBoundingClientRect();
        geo.w = Math.round(r.width);
        geo.h = Math.round(r.height);
        const sx = e.clientX, sy = e.clientY, ox = r.left, oy = r.top;
        beginGesture(head, e, (ev) => {
            maxed = false;   // 铺满的窗拖一下就是浮窗，max 偏好不动
            geo.float = true;
            geo.x = Math.round(ox + ev.clientX - sx);
            geo.y = Math.round(oy + ev.clientY - sy);
            applyGeo();
        }, saveGeo);
    });

    // 右缘调整条：只改宽度，宽度下限 640px
    resizeEl.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const r = box.getBoundingClientRect();
        maxed = false;
        geo.float = true;
        geo.x = Math.round(r.left);
        geo.y = Math.round(r.top);
        geo.h = Math.round(r.height);
        const sx = e.clientX, ow = r.width;
        beginGesture(resizeEl, e, (ev) => {
            geo.w = Math.min(Math.max(MIN_W, ow + ev.clientX - sx), Math.max(MIN_W, window.innerWidth - geo.x));
            applyGeo();
        }, saveGeo);
    });


    const onKey = (e) => {
        if (e.key !== "Escape" || !opened) return;
        // 灯箱叠在弹窗之上时这一发 Esc 归灯箱（它自己监听关窗），弹窗不能抢着把自己关掉
        if (document.querySelector(".neo-lightbox")) return;
        close();
    };

    // capture 抢在卡片自己的 onclick（开灯箱）之前：取用模式下单点即取用并关窗
    content.addEventListener("click", (e) => {
        if (!pickHandler) return;
        const card = e.target.closest(".neo-gallery-thumb-container");
        if (!card || !card.dataset.filename) return;
        // 勾选框 / ⋯ 菜单 / 发送钮这类控件由卡片自己的监听处理，capture 不截它们
        if (e.target.closest(".neo-gallery-select-check, .neo-gallery-thumb-bookmark-btn, .neo-gallery-thumb-img-send-btn, .neo-gallery-card-lora-send-btn, .neo-gallery-card-dir-menu-btn, .neo-gallery-audio-play-btn")) return;
        // 只放行取用方收得动的素材：图片编辑开的那扇不认视频与音频，点上去落回卡片自己的灯箱浏览
        if (!(pickAccept || ((f) => PICKABLE_RE.test(f)))(card.dataset.filename)) return;
        e.preventDefault();
        e.stopPropagation();
        const picked = { filename: card.dataset.filename, subfolder: card.dataset.subfolder || "" };
        const fn = pickHandler;
        close();
        fn([picked]);
    }, true);

    function open(title) {
        if (title) titleEl.textContent = title;
        opened = true;
        geo = readGeo() || geo;
        maxed = geo.max;
        overlay.classList.remove("ns-hidden");
        applyGeo();
        saveGeo();   // 首开落一份默认摆位，之后拖窗与最大化才有基线可比
        document.addEventListener("keydown", onKey);
    }

    function close() {
        if (!opened) return;
        opened = false;
        overlay.classList.add("ns-hidden");
        document.removeEventListener("keydown", onKey);
        if (endGesture) endGesture();   // 拖到一半按 Esc / 点遮罩关窗：手势与 window 上的 move 一起收掉，窗体不再跟鼠标
        pickHandler = null;
        pickAccept = null;
        bulkHandler = null;
        setPickCount(0);
        if (onCloseCb) onCloseCb();
    }

    maxBtn.onclick = (e) => { e.stopPropagation(); toggleMax(); };
    closeBtn.onclick = (e) => { e.stopPropagation(); close(); };
    // 只算点在遮罩空白上的点击：box 里的任何点击都会冒泡到 overlay
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    pickClear.onclick = () => { if (clearHandler) clearHandler(); setPickCount(0); };
    pickUse.onclick = () => {
        const fn = bulkHandler;
        if (!fn) return;
        close();
        fn();
    };

    /** 取用模式：onPick 单点卡片取用（关窗后调用）；onBulk 底部取用条；onClear 清宿主多选。
     *  accept 声明这一扇收哪一类（"image" / "video"，不传 = 媒体全收）：类别对不上的卡片点下去不取用。 */
    function setPickMode({ onPick, onBulk, onClear, accept } = {}) {
        pickHandler = onPick || null;
        bulkHandler = onBulk || null;
        clearHandler = onClear || null;
        pickAccept = (accept && PICK_ACCEPT[accept]) || null;
        setPickCount(0);
    }

    /** 底部取用条：有取用目标且勾选数 > 0 才出现；计数由宿主的多选变化喂进来。 */
    function setPickCount(n) {
        pickCount.textContent = tf("已选 {n} 项", { n });
        pickUse.textContent = tf("取用已选 {n} 项", { n });
        pickbar.classList.toggle("ns-hidden", !(pickHandler && bulkHandler && n > 0));
    }

    return {
        el: overlay,
        open,
        close,
        isOpen: () => opened,
        setContent: (el) => content.replaceChildren(el),
        /** 标题栏右侧插槽的内容（一颗搜索框、宿主用得少的那几颗钮）：插槽是外壳的，塞什么由宿主定，外壳不认它 */
        setTitlebarExtra: (...els) => titleSlot.replaceChildren(...els.filter(Boolean)),
        setPickMode,
        setPickCount,
        setOnClose: (fn) => { onCloseCb = fn; },
    };
}
