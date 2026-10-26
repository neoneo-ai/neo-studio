/**
 * Gallery Utilities - Constants and helper functions
 */
import { $el } from "../../../../scripts/ui.js";

// Constants
export const PAGE_SIZE = 100;
export const RESERVED_SPACE_WITH_LABEL = 52;
export const RESERVED_SPACE_WITHOUT_LABEL = 36;
export const MAX_COVER_IMAGES = 2;
export const MAX_COVER_IMAGES_WIDE = 3;
export const MAX_ROOT_IMAGES = 20;
export const THUMBNAIL_SIZE_MIN = 150;
export const THUMBNAIL_SIZE_MAX = 500;
export const THUMBNAIL_SIZE_STEP = 25;
export const THUMBNAIL_SIZE_DEFAULT = 320;
export const THUMBNAIL_CACHE_SIZE = 400; // Fixed thumbnail cache size
export const WIDE_CARD_MAX = 320;
export const MOSAIC_MIN_CARD_WIDTH = 240;

/**
 * Get reserved space based on label display setting
 */
export function getReservedSpace(displayLabels) {
    return displayLabels ? RESERVED_SPACE_WITH_LABEL : RESERVED_SPACE_WITHOUT_LABEL;
}

/**
 * Calculate image height for thumbnail
 */
export function getImageHeight(maxThumbnailSize, displayLabels) {
    const reservedSpace = getReservedSpace(displayLabels);
    return Math.max(maxThumbnailSize - reservedSpace, 40);
}

/**
 * 宽宿主（桌面端素材页）下的卡片列宽：滑杆拉到 500 也压在 WIDE_CARD_MAX 以内，
 * 避免宽窗口只排出 3 列巨型卡。侧栏宿主没有宽宿主标记，滑杆照旧全量生效。
 */
export function cardColumnWidth(gallery) {
    const size = gallery.maxThumbnailSize;
    return gallery.element && gallery.element.classList.contains("neo-gallery-panel--wide")
        ? Math.min(size, WIDE_CARD_MAX)
        : size;
}

/** 宽宿主且卡片够宽才用三图封面拼贴，其余宿主保持双图。 */
export function coverMaxTiles(gallery) {
    return cardColumnWidth(gallery) >= MOSAIC_MIN_CARD_WIDTH &&
        gallery.element && gallery.element.classList.contains("neo-gallery-panel--wide")
        ? MAX_COVER_IMAGES_WIDE
        : MAX_COVER_IMAGES;
}

/**
 * Calculate card height for directory cards
 */
export function getCardHeight(gallery) {
    const reservedSpace = getReservedSpace(gallery.displayLabels);
    return Math.max(cardColumnWidth(gallery) - reservedSpace, 40);
}

/**
 * Check if filename is an image
 */
export function isImageFile(filename) {
    return /\.(png|jpg|jpeg|gif|webp|bmp|tiff)$/i.test(filename);
}

/**
 * Check if filename is a video
 */
export function isVideoFile(filename) {
    return /\.(mp4|webm|mov|avi|mkv|flv|wmv)$/i.test(filename);
}

/**
 * Check if filename is an audio file
 */
export function isAudioFile(filename) {
    return /\.(mp3|wav|ogg|flac|aac|m4a|wma|opus)$/i.test(filename);
}

/**
 * Get video source URL
 */
export function getVideoSrc(video, subfolder) {
    return `${window.location.protocol}//${window.location.host}/neo_gallery/video?filename=${encodeURIComponent(video.filename)}&subfolder=${encodeURIComponent(subfolder)}`;
}

/**
 * Get audio source URL (waveform decode + playback + lightbox)
 */
export function getAudioSrc(audio, subfolder) {
    return `${window.location.protocol}//${window.location.host}/neo_gallery/audio?filename=${encodeURIComponent(audio.filename)}&subfolder=${encodeURIComponent(subfolder)}`;
}

/**
 * Get image source URL
 */
export function getImageSrc(image, subfolder) {
    const categoryParam = image.category ? `&category=${encodeURIComponent(image.category)}` : '';
    return image.preview || `${window.location.protocol}//${window.location.host}/neo_gallery/image?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}${categoryParam}`;
}

/**
 * Get thumbnail source URL (cached, optimized for display)
 */
export function getThumbnailSrc(image, subfolder, size = THUMBNAIL_CACHE_SIZE) {
    const categoryParam = image.category ? `&category=${encodeURIComponent(image.category)}` : '';
    const mtimeParam = image.mtime ? `&t=${image.mtime}` : '';
    return `${window.location.protocol}//${window.location.host}/neo_gallery/thumbnail?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}&size=${size}${categoryParam}${mtimeParam}`;
}
/**
 * 缩略图懒加载：卡片进入视口才请求，且同时最多 6 个请求。
 * 首页上千张卡片如果各自 new Image() 会瞬间打满浏览器并发上限，
 * 排队在后面的缩略图要等很久才拿到数据；这里用共享 IntersectionObserver
 * 触发 + 显式并发队列，视口外的卡片完全不产生请求。
 */
const THUMB_CONCURRENCY = 6;
const _thumbQueue = [];
let _thumbActive = 0;
let _thumbObserver = null;
const _thumbCallbacks = new WeakMap();

function _pumpThumbQueue() {
    while (_thumbActive < THUMB_CONCURRENCY && _thumbQueue.length > 0) {
        const task = _thumbQueue.shift();
        _thumbActive++;
        const loader = new Image();
        task.img._thumbLoader = loader;
        loader.onload = () => {
            _finishThumbTask(task);
            if (task.img.isConnected) {
                task.img.src = task.src;
                if (task.onLoaded) task.onLoaded(task.img, loader.naturalWidth, loader.naturalHeight);
            }
        };
        loader.onerror = () => {
            _finishThumbTask(task);
            if (task.img.isConnected && task.onFailed) task.onFailed(task.img);
        };
        loader.src = task.src;
    }
}

function _finishThumbTask(task) {
    _thumbActive--;
    task.img._thumbLoader = null;
    _pumpThumbQueue();
}

/** 请求一张缩略图；同一元素重复入队时只更新目标地址，元素被移除后任务自动作废。 */
export function enqueueThumbnail(img, src, callbacks) {
    if (!src) return;
    for (const task of _thumbQueue) {
        if (task.img === img) { task.src = src; return; }
    }
    _thumbQueue.push({ img, src, onLoaded: callbacks && callbacks.onLoaded, onFailed: callbacks && callbacks.onFailed });
    _pumpThumbQueue();
}

export function cancelThumbnail(img) {
    const idx = _thumbQueue.findIndex(task => task.img === img);
    if (idx >= 0) _thumbQueue.splice(idx, 1);
    if (img._thumbLoader) {
        img._thumbLoader.onload = null;
        img._thumbLoader.onerror = null;
        img._thumbLoader = null;
        _thumbActive = Math.max(0, _thumbActive - 1);
        _pumpThumbQueue();
    }
}

function _startLazyThumbnail(img) {
    enqueueThumbnail(img, img.dataset.thumbnailSrc, _thumbCallbacks.get(img));
}

/**
 * 注册懒加载缩略图：img 先显示占位图，滚动到视口附近（提前 300px）才排队请求。
 * callbacks: { onLoaded(img, naturalWidth, naturalHeight), onFailed(img) }
 */
export function registerLazyThumbnail(img, src, callbacks) {
    img.dataset.thumbnailSrc = src;
    if (callbacks) _thumbCallbacks.set(img, callbacks);
    if (typeof IntersectionObserver === "undefined") {
        _startLazyThumbnail(img);
        return;
    }
    if (!_thumbObserver) {
        _thumbObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                _thumbObserver.unobserve(entry.target);
                _startLazyThumbnail(entry.target);
            }
        }, { rootMargin: "300px 0px" });
    }
    _thumbObserver.observe(img);
}

export function releaseLazyThumbnail(img) {
    if (_thumbObserver) _thumbObserver.unobserve(img);
    cancelThumbnail(img);
}

/** 容器清空前调用：释放容器内所有待加载缩略图，避免队列堆积已移除的卡片。 */
export function releaseLazyThumbnails(container) {
    if (!container) return;
    for (const img of container.querySelectorAll("img[data-thumbnail-src]")) releaseLazyThumbnail(img);
}



/**
 * Debounce function
 */
export function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

/**
 * Create pagination UI with load more button
 */
export function createPaginationUI(container, items, renderPage, gallery) {
    const displayedCount = Math.min(PAGE_SIZE, items.length);
    
    renderPage(displayedCount);
    
    if (displayedCount < items.length) {
        const createLoadMoreBtn = () => {
            const btn = $el("div", {
                className: "neo-gallery-load-more-btn",
                textContent: `Load more (${items.length - displayedCount} remaining)`
            });
            btn.onclick = () => {
                btn.remove();
                renderPage(PAGE_SIZE);
                const remaining = items.length - gallery._renderedCount;
                if (remaining > 0) {
                    container.appendChild(createLoadMoreBtn());
                }
            };
            return btn;
        };
        container.appendChild(createLoadMoreBtn());
    }
}

/**
 * Deterministic decorative waveform heights seeded from a string (FNV-1a + LCG).
 * The same seed always yields the same bars, so a tile looks stable across renders.
 */
export function decorativeHeights(seedStr) {
    const s = String(seedStr || "");
    const n = 60;
    let seed = 2166136261;
    for (let i = 0; i < s.length; i++) {
        seed ^= s.charCodeAt(i);
        seed = Math.imul(seed, 16777619) >>> 0;
    }
    const phase = (seed % 628) / 100;
    const heights = new Array(n);
    for (let i = 0; i < n; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const rnd = seed / 4294967296;
        const t = i / n;
        const base = 0.25 + 0.5 * Math.abs(Math.sin(t * Math.PI * 3 + phase));
        heights[i] = Math.min(1, base * (0.55 + rnd * 0.8));
    }
    return heights;
}

/**
 * Draw a bar waveform onto a canvas. `progress` (0..1) fills the played portion.
 */
export function renderWaveform(canvas, heights, progress = 0) {
    const dpr = window.devicePixelRatio || 1;
    // 布局前 clientWidth/Height 为 0，回退到默认尺寸；布局后按实际显示尺寸绘制更清晰
    const W = canvas.clientWidth || 240;
    const H = canvas.clientHeight || 72;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const n = heights.length;
    const gap = W / n;
    for (let i = 0; i < n; i++) {
        const bh = Math.max(2, Math.min(1, heights[i]) * H * 0.9);
        const played = progress > 0 && (i + 0.5) / n <= progress;
        ctx.fillStyle = played ? "#8b5cf6" : "rgba(148, 163, 184, 0.45)";
        ctx.fillRect(i * gap, (H - bh) / 2, Math.max(1, gap - 1), bh);
    }
}

/**
 * Cover entries carry a `kind` ("image" | "video" | "audio"). Audio renders as a
 * dedicated tile; anything else (or a legacy entry without kind) is an <img>.
 */
export function getCoverTileKind(cover) {
    return cover && cover.kind === "audio" ? "audio" : "media";
}

function _coverImgSrc(cover) {
    if (cover && cover.url) return cover.url;
    return getThumbnailSrc(cover, (cover && cover.subfolder) || "");
}
export { _coverImgSrc as coverImgSrc };

/** Generic placeholder tile for an empty or failed non-audio cover. */
export function buildPlaceholderTile() {
    const tile = $el("div", { className: "neo-gallery-card-placeholder" });
    tile.appendChild($el("span", { className: "neo-gallery-card-placeholder-icon", textContent: "" }));
    return tile;
}

/** Audio cover tile reusing the audio-card visual language (badge + waveform). */
export function buildAudioTile(seed) {
    const tile = $el("div", { className: "neo-gallery-cover-audio-tile" });
    tile.appendChild($el("span", { className: "neo-gallery-cover-audio-badge", textContent: "\u266A" }));
    const canvas = $el("canvas", { className: "neo-gallery-cover-audio-waveform" });
    tile.appendChild(canvas);
    renderWaveform(canvas, decorativeHeights(seed), 0);
    return tile;
}

/** Map a loaded image's orientation to a display ratio: portrait 3:4, landscape 3:2, square 1:1. */
function _orientationRatio(w, h) {
    if (!w || !h) return null;
    const r = w / h;
    if (r < 0.92) return 3 / 4;      // portrait → tall card
    if (r > 1.1) return 3 / 2;       // landscape → wide/short card
    return 1;                        // square
}

/**
 * Adapt a directory card's cover box to the composite orientation of its tiles:
 * two portraits side-by-side read as one wide 3:2 image; a landscape lead tile
 * shows on its own (two stacked landscapes read as too tall) — so directory
 * cards differ from single-media cards.
 * Tiles keep their own ratio (row adds widths, column adds heights), which means
 * no crop when both covers share an orientation. Layout follows the first tile:
 * portrait & square go side-by-side (top-anchored), landscape keeps one tile.
 * Unknown tiles are assumed to match the first, so the box is set on the first load
 * and refined when the second arrives. Falls back to the default fixed height when
 * no dimensions are available.
 */
function _applyAdaptiveCoverRatio(coverWrapper, grid, ratios) {
    const r1 = ratios[0];
    if (!r1) return;
    const useRow = r1 !== 3 / 2;     // portrait & square side-by-side; landscape single
    const mosaic = useRow && grid.children.length > 2;
    const keepTiles = mosaic ? 3 : (useRow ? 2 : 1);
    while (grid.children.length > keepTiles) grid.lastChild.remove();
    grid.classList.toggle("neo-gallery-card-cover-grid--mosaic", mosaic);
    grid.classList.toggle("neo-gallery-card-cover-grid--row", !mosaic && useRow);
    grid.classList.toggle("neo-gallery-card-cover-grid--portrait", !mosaic && useRow);
    let ratio = r1;
    if (mosaic) {
        // 左大图占 2/3 宽，右列两张小图各占 1/3：合成比例取两列中较高的一列
        const r2 = ratios[1] || r1;
        const r3 = ratios[2] || r1;
        ratio = 3 / Math.max(2 / r1, 1 / r2 + 1 / r3);
    } else if (grid.children.length > 1) {
        const r2 = ratios[1] || r1;  // unknown tile assumed same as the first
        ratio = useRow ? r1 + r2 : 1 / (1 / r1 + 1 / r2);
    }
    const card = coverWrapper.parentElement;
    if (card && card.classList.contains("neo-gallery-category-card")) {
        coverWrapper.style.aspectRatio = String(Math.round(ratio * 1000) / 1000);
        coverWrapper.style.flex = "0 0 auto";
        card.style.height = "auto";
    }
}

/**
 * Adapt a single media card to its image's orientation: portrait gets a tall card,
 * landscape a wide/short one, square stays square. The thumbnail box drives the
 * card height (the grid is top-aligned so mixed heights don't stretch).
 */
export function applyMediaCardRatio(container, imgWrapper, w, h) {
    const ratio = _orientationRatio(w, h);
    if (!ratio) return;
    imgWrapper.style.aspectRatio = String(ratio);
    imgWrapper.style.flex = "0 0 auto";
    container.style.height = "auto";
}

/**
 * Render a directory / bookmark cover into `coverWrapper`.
 * The first loaded image's orientation drives both the cover layout and the
 * card's height (see _applyAdaptiveCoverRatio): portrait & square pair up
 * side-by-side, landscape keeps a single tile. An audio-only set becomes one
 * audio tile, and nothing usable becomes one placeholder.
 */
export function renderCoverTiles(coverWrapper, covers, alt = "", maxTiles = MAX_COVER_IMAGES) {
    coverWrapper.innerHTML = "";
    const list = (covers || []).slice(0, maxTiles);
    const mediaCovers = list.filter(c => getCoverTileKind(c) === "media");

    if (mediaCovers.length > 0) {
        const grid = $el("div", { className: "neo-gallery-card-cover-grid" });
        const ratios = new Array(mediaCovers.length).fill(null);
        const settle = () => _applyAdaptiveCoverRatio(coverWrapper, grid, ratios);
        mediaCovers.forEach((c, i) => {
            const itemEl = $el("div", { className: "neo-gallery-card-cover-grid-item" });
            // 封面尺寸随列表数据下发（w/h）：比例先定好，图片到位只是补内容
            ratios[i] = _orientationRatio(c.w, c.h);
            const img = $el("img", { src: _coverImgSrc(c), alt, loading: "lazy" });
            img.onerror = () => { ratios[i] = 1; itemEl.replaceWith(buildPlaceholderTile()); settle(); };
            img.onload = () => { ratios[i] = _orientationRatio(img.naturalWidth, img.naturalHeight); settle(); };
            itemEl.appendChild(img);
            grid.appendChild(itemEl);
        });
        settle();
        coverWrapper.appendChild(grid);
    } else if (list.some(c => getCoverTileKind(c) === "audio")) {
        const firstAudio = list.find(c => getCoverTileKind(c) === "audio");
        coverWrapper.appendChild(buildAudioTile(firstAudio && (firstAudio.filename || firstAudio.name)));
        // 音频瓦片高度固定，收缩卡片避免方形留白（与 _applyAdaptiveCoverRatio 同模式）
        const card = coverWrapper.parentElement;
        if (card && card.classList.contains("neo-gallery-category-card")) {
            coverWrapper.style.flex = "0 0 auto";
            card.style.height = "auto";
        }
    } else {
        coverWrapper.appendChild(buildPlaceholderTile());
    }
}

/**
 * Create breadcrumb item
 */
export function createBreadcrumbItem(text, onClick, options = {}) {
    const { isCurrent = false, isHome = false, isUp = false, title = '' } = options;
    
    let className = 'neo-gallery-breadcrumb-item';
    if (isHome) className += ' neo-gallery-breadcrumb-home';
    if (isCurrent) className += ' neo-gallery-breadcrumb-current';
    if (isUp) className += ' neo-gallery-breadcrumb-up';
    
    const item = $el("span", {
        className: className,
        textContent: text,
        title: title
    });
    
    if (onClick) {
        item.onclick = (e) => {
            e.stopPropagation();
            onClick();
        };
    }
    
    return item;
}

/**
 * Create separator element
 */
export function createBreadcrumbSeparator() {
    return $el("span", { className: "neo-gallery-breadcrumb-sep", textContent: ">" });
}

/**
 * Sort items by mtime descending, fallback to name
 */
export function sortByMtime(items) {
    return [...items].sort((a, b) => {
        const at = a.mtime ?? a._mtime ?? 0;
        const bt = b.mtime ?? b._mtime ?? 0;
        if (bt !== at) return bt - at;
        return b.name.localeCompare(a.name);
    });
}

/**
 * Show no files message
 */
export function showNoFilesMessage(container, message = "No images found") {
    container.appendChild($el("div", { className: "neo-gallery-no-files" }, [
        $el("div", { className: "neo-gallery-no-files-icon", textContent: "" }),
        $el("div", { className: "neo-gallery-no-files-text", textContent: message })
    ]));
}

/**
 * Show loading overlay
 */
export function showLoadingOverlay(container, size = 320) {
    const skeletonCards = [];
    // Create 6 skeleton cards to simulate a grid
    for (let i = 0; i < 6; i++) {
        skeletonCards.push($el("div", { className: "skeleton-card" }));
    }
    
    const loadingEl = $el("div", { className: "neo-gallery-loading-overlay" }, [
        $el("div", { className: "neo-gallery-loading-skeleton", dataset: { size: size.toString() } }, skeletonCards),
        $el("span", { className: "neo-gallery-loading-text", textContent: "Loading gallery..." })
    ]);
    container.appendChild(loadingEl);
    return loadingEl;
}

/**
 * Toast notification
 */
export function showToast(app, severity, summary, detail) {
    app.extensionManager.toast.add({ severity, summary, detail, life: 5000 });
}

/**
 * Inline feedback on button
 */
export function showInlineFeedback(button, message, type) {
    const existing = button.querySelector('.neo-gallery-feedback');
    if (existing) existing.remove();

    const feedbackClassName = type === 'success' ? 'neo-gallery-feedback neo-gallery-feedback-success' : 'neo-gallery-feedback neo-gallery-feedback-error';
    const feedback = $el("div", {
        className: feedbackClassName,
        textContent: message
    });

    document.body.appendChild(feedback);

    const buttonRect = button.getBoundingClientRect();
    const top = buttonRect.top;
    const left = buttonRect.left + buttonRect.width / 2;

    feedback.style.position = 'fixed';
    feedback.style.top = (top - 32) + 'px';
    feedback.style.left = left + 'px';
    feedback.style.transform = 'translateX(-50%)';
    feedback.style.zIndex = '9846';
    feedback.style.pointerEvents = 'none';

    setTimeout(() => {
        if (feedback.parentNode) {
            feedback.style.opacity = "0";
            feedback.style.transition = "opacity 0.3s ease";
            setTimeout(() => {
                if (feedback.parentNode) feedback.remove();
            }, 300);
        }
    }, 1500);
}