import { app } from "../../../../scripts/app.js";
import { api } from "../../../../scripts/api.js";
import { $el } from "../../../../scripts/ui.js";
import { GalleryList } from './gallery-list.js';
import { GalleryCard } from './gallery-card.js';
import { GallerySetting } from './gallery-setting.js';
import { getRecipesPanel } from './recipes.js';
import { openDirectorEditor } from './director.js';
import { copyGalleryToInput } from './media-transfer.js';
import { openGenMaterialDialog } from './gallery-gen.js';
import { attachGalleryNodeDrop } from './gallery-node-drop.js';
import { attachMasonry, setMasonryColumnWidth } from './gallery-masonry.js';
import { t, tf } from "./js/core/i18n.js";
import {
    THUMBNAIL_SIZE_DEFAULT,
    THUMBNAIL_SIZE_MIN,
    THUMBNAIL_SIZE_MAX,
    THUMBNAIL_SIZE_STEP,
    getCardHeight,
    cardColumnWidth,
    renderCoverTiles,
    buildPlaceholderTile,
    showNoFilesMessage,
    showLoadingOverlay,
    showToast,
    showInlineFeedback,
    isAudioFile,
    isImageFile,
    releaseLazyThumbnails
} from './gallery-utils.js';

// 启动页里 gallery.css / recipes.css 由 studio/index.html 静态带上（见那里的注释）。在 ComfyUI 里
// 当扩展加载时没有那份文档，这里补一份带时间戳的：prompts.css 同款坑——按内容估新鲜度的话，
// CSS 更新后会长期吃旧副本，新样式看着就"不生效"
function cssLinkInjected(prefix) {
    return [...document.querySelectorAll('link[rel="stylesheet"]')]
        .some((l) => (l.getAttribute('href') || '').startsWith(prefix));
}
if (!cssLinkInjected('/extensions/comfyui-neo-studio/gallery.css')) {
    const galleryCssLink = document.createElement('link');
    galleryCssLink.rel = 'stylesheet';
    galleryCssLink.href = "/extensions/comfyui-neo-studio/gallery.css?v=" + Date.now();
    document.head.appendChild(galleryCssLink);
}
if (!cssLinkInjected('/extensions/comfyui-neo-studio/recipes.css')) {
    const recipesCssLink = document.createElement('link');
    recipesCssLink.rel = 'stylesheet';
    recipesCssLink.href = "/extensions/comfyui-neo-studio/recipes.css?v=" + Date.now();
    document.head.appendChild(recipesCssLink);
}

// Civitai 收藏 view: bookmarked C-site models, shown like the Lora section.
const CIVITAI_DIR_NAME = t("C站收藏");  // display label only (card name, breadcrumb) — never used for backend matching
const CIVITAI_DIR_KEY = "civitai_bookmarks";  // stable dir_name key sent to the backend (must match bookmark.CIVITAI_DIR_KEY)
const CIVITAI_VIEW_SOURCE = CIVITAI_DIR_KEY;  // same stable identifier reused in the URL state

// 角色图目录建配方的上限：与导演编辑器的每段参考图（MiniMaxH3ReferenceToVideo 槽位）和 角色参考图一致
const DIRECTOR_REF_MAX = 9;
const DIRECTOR_CHAR_MAX = 6;

/**
 * NeoGallery — preset-based gallery (no YAML).
 */
export class NeoGallery {
    constructor(app) {
        this.app = app;
        this.maxThumbnailSize = THUMBNAIL_SIZE_DEFAULT;
        this.displayLabels = true;
        this.allDirectories = [];
        this.filteredDirectories = [];
        this.sortAscending = true;
        this._renderQueue = [];
        this._renderedCount = 0;
        this.isFocused = false;
        this.isVisible = false;
        
        // UI components
        this.list = new GalleryList(this);
        this.card = new GalleryCard(this);
        this.settings = new GallerySetting(this);
        this.searchInput = this.list.createSearchInput(this);
        this.thumbnailSizeSlider = this.list.createThumbnailSizeSlider(this);
        this.customDirSettingBtn = null;
        
        // Card-based layout state
        this.currentView = {
            mode: 'categories',
            source: null,
            categoryPath: [],
        };
        this.workflowMatchActive = false;   // smart filter: show only loras used in the workflow
        this.civitaiLoraEnabled = false;     // 「启用 C 站 LORA」总开关（首页 Lora 板块）
        this.civitaiBookmarkEnabled = true;  // 「启用 C 站收藏」开关（首页 C站收藏卡）
        this.homeOrder = [];                // 统一顺序表：内置卡 + 自定义目录
        this.hiddenHomeEntries = new Set();  // 排序列表里被隐藏的条目（小写键）
        this.characterDirs = new Set();      // 角色图目录（小写 token）：从这里多选建导演配方默认全参考
        this._customDirTokens = new Map();   // 自定义目录名 → 绝对路径（画廊按目录名寻址，设置里存路径）
        this._loraRefreshTimer = null;       // auto-refresh polling for the Lora section
        this.placeholderImageUrl = `${window.location.protocol}//${window.location.host}/neo_gallery/placeholder.png`;
        this.sectionStates = {};
        this.isSearchActive = false;
        this.elementId = "neo-gallery-panel-root";
        
        // Store current directory images for lightbox navigation (used in lazy mode)
        this._currentDirImages = [];
        
        // 滚动位置状态
        this._scrollPositions = {};
        this._scrollRestoreLock = false;   // 重绘清空内容时的伪滚动不覆盖已保存位置

        // 导航历史（顶部前进/后退按钮）
        this._navStack = [];
        this._navPos = -1;
        this._navRestoring = false;

        // 各宿主的素材目录（scope → 视图快照）：导演抽屉 / 绘画页左栏 / 素材页共用同一个
        // gallery.element，摘走时记下、挂上时恢复（rememberView / applyView），互不覆盖
        this._libViews = {};

        // 多选删除：卡片左上角勾选框选中后，底部操作条批量删除
        this._selectedItems = new Set();
        this._selectionBar = null;

        // 音频卡片共享播放器：同一时刻只播一个，点击音频卡片外区域停止
        this._audioPlayer = null;
        this._audioCtx = null;
        this._audioActiveUrl = null;
        this._audioActiveBtn = null;
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.neo-gallery-audio-card')) {
                this._stopAudio();
            }
        });
        
        
        // Custom dir input
        this.customDirInput = $el("input", {
            type: "text",
            value: "",
            readonly: true,
            className: "neo-gallery-custom-dir-input-inline",
            style: { display: "none" }
        });

        const customDirBtn = this.list.createCustomDirSettingBtn(this);
        const navGroup = this.list.createNavButtons(this);

        // Main content area
        this.accordion = $el("div", { className: "neo-gallery-accordion" });

        // 头部一条粘性工具条：前进后退 / + 目录 / 面包屑 / 尺寸滑杆 / 搜索 / 生成素材
        // 全塞进同一块，宽宿主（桌面素材页）排成一行，窄侧栏自动换行；样式见 .neo-gallery-topbar
        this.element = $el("div", { id: this.elementId, className: "neo-gallery-panel" }, [
            $el("div", { className: "neo-gallery-topbar" }, [
                navGroup,
                customDirBtn,
                $el("div", {
                    id: "neo-gallery-breadcrumb",
                    className: "neo-gallery-breadcrumb",
                    style: { display: 'none' }
                }, [this.list.createBreadcrumbHome(this)]),
                this.thumbnailSizeSlider,
                $el("div", { className: "neo-gallery-search-container" }, [this.searchInput]),
                $el("button", {
                    className: "neo-gallery-gm-btn",
                    title: t("生成新素材（默认 Krea2 文生图，产物保存到 Output 目录）"),
                    textContent: t("生成素材"),
                    onclick: () => openGenMaterialDialog(this)
                })
            ]),
            this.accordion,
            this.customDirInput
        ]);

        this.loadGallerySettings();
    }

    // ====== Directory Management ======

    async loadGallerySettings() {
        try {
            const resp = await api.fetchApi('/neo_gallery/get_settings');
            if (resp.ok) {
                const settings = await resp.json();
                this.civitaiLoraEnabled = !!settings.civitai_lora_enabled;
                this.civitaiBookmarkEnabled = settings.civitai_bookmark_enabled !== false;
                this.homeOrder = Array.isArray(settings.home_order) ? [...settings.home_order] : [];
                const hidden = settings.hidden_directories;
                this.hiddenHomeEntries = new Set(Array.isArray(hidden) ? hidden.map((h) => String(h).toLowerCase()) : []);
                const chars = settings.character_dirs;
                this.characterDirs = new Set(Array.isArray(chars) ? chars.map((c) => String(c).toLowerCase()) : []);
                const customDirs = Array.isArray(settings.custom_directories) ? settings.custom_directories : [];
                // 自定义目录在画廊里按目录名寻址（/neo_gallery/list 用 dir_path.name 匹配），
                // 目录设置里存的是绝对路径：建一张 目录名 → 路径 的表，标记比对两边才对得上。
                this._customDirTokens = new Map(
                    customDirs.map((p) => [String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop().toLowerCase(), String(p).toLowerCase()])
                );
                const customDir = settings.custom_directory || "";
                this.customDirInput.value = customDir;
                
                if (this.customDirSettingBtn) {
                    if (customDir) {
                        const displayName = customDir.split(/[\\/]/).pop();
                        this.customDirSettingBtn.title = customDir + '\n(Click to change)\nCurrent: ' + displayName;
                        this.customDirSettingBtn.textContent = "";
                    } else {
                        this.customDirSettingBtn.title = "Set custom directory\n(Currently not configured)";
                        this.customDirSettingBtn.textContent = "+";
                    }
                }
            }
        } catch (error) {
            console.error('Error loading gallery settings:', error);
            if (this.customDirSettingBtn) {
                this.customDirSettingBtn.title = "Failed to load settings";
                this.customDirSettingBtn.textContent = "?";
            }
        }
    }

    /** 设置变更后重读并重绘首页：关闭的板块与隐藏的条目立即消失。 */
    async refreshAfterSettingsChange() {
        this.stopLoraRefresh();
        await this.loadGallerySettings();
        await this.loadGallery();
        if (this.currentView.mode === 'categories') await this.list.sortAndDisplayImages();
    }

    async promptAndSetCustomDir() {
        await this.settings.buildDirModal(this);
    }

    closeDirModal() {
        const modal = document.querySelector('.neo-gallery-dir-modal-overlay');
        if (modal) modal.remove();
    }

    async removeCustomDir(dirPath) {
        if (!confirm(`Remove directory "${dirPath}" from gallery?`)) return false;

        const saveResp = await api.fetchApi('/neo_gallery/save_settings', {
            method: "POST",
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: "remove", path: dirPath })
        });
        const result = await saveResp.json();

        if (!(saveResp.ok && result.success)) {
            alert('Failed to remove directory: ' + (result.error || ''));
            return false;
        }

        // Clear thumbnails for this directory
        try {
            await api.fetchApi('/neo_gallery/clear_thumbnails', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subfolder: dirPath })
            });
        } catch (e) {
            console.warn('[Neo Gallery] Failed to clear thumbnails:', e);
        }
        return true;
    }

    // ====== State / Persistence ======

    async savePluginData(overrides) {
        const pluginData = {
            sectionStates: this.sectionStates,
            sortAscending: this.sortAscending,
            maxThumbnailSize: this.maxThumbnailSize,
            displayLabels: this.displayLabels,
            scrollPositions: this._scrollPositions,
            currentView: this.currentView,
            ...overrides
        };
        try {
            const resp = await api.fetchApi('/userdata/neo_gallery_data.json', {
                method: 'POST',
                body: JSON.stringify(pluginData),
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Error saving plugin data:', error);
        }
    }

    async loadPluginData() {
        try {
            const response = await api.fetchApi('/userdata/neo_gallery_data.json');
            if (response.ok) {
                const data = await response.json();
                this.sectionStates = data.sectionStates || {};
                this.sortAscending = data.sortAscending !== undefined ? data.sortAscending : true;
                this.maxThumbnailSize = data.maxThumbnailSize || THUMBNAIL_SIZE_DEFAULT;
                this.displayLabels = data.displayLabels !== undefined ? data.displayLabels : true;
                this._scrollPositions = data.scrollPositions || {};
                if (data.currentView && data.currentView.mode) {
                    this._savedView = { ...data.currentView };
                }
                if (data.libViews && typeof data.libViews === 'object') {
                    this._libViews = data.libViews;   // 各宿主上次停在哪个目录（scope → 视图）
                }
            }
        } catch (error) {
            console.error('Error loading plugin data:', error);
        }
    }

    // ====== Cover Image Cache ======

    // ====== Data Loading & Caching ======

    async loadGallery() {
        try {
            // Fetch directory structure with covers (covers loaded lazily per card via IntersectionObserver)
            const resp = await api.fetchApi('/neo_gallery/list?fields=dirs,covers');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            
            this.allDirectories = (data.directories || []).map(dir => ({
                name: dir.name,
                path: dir.path,
                subdirs: dir.subdirs || {},
                read_only: dir.read_only || false,
                root_count: dir.root_count || 0,
                items: dir.items || [],
                source: dir.source || "local",
                lora_path: dir.lora_path || null,
                pending: dir.pending || false,
                civitai: dir.civitai || null,
                model_name: dir.model_name || "",
                base_model: dir.base_model || "",
                has_pending: dir.has_pending || false
            }));
            this.filteredDirectories = this.allDirectories;

            // Use covers from list response (no separate request needed)
            // FIX: Merge with existing cache instead of replacing to preserve covers when navigating back
            if (data.covers && Object.keys(data.covers).length > 0) {
                this._dirCovers = { ...this._dirCovers, ...data.covers };
                console.log('[Neo Gallery] Merged cover images from list response:', Object.keys(this._dirCovers).length, 'directories');
            }
        } catch (error) {
            console.error('Error loading gallery:', error);
            this.allDirectories = [];
            this.filteredDirectories = this.allDirectories;
        }
    }

    // ====== Smart Workflow Matching (智能感知) ======

    /**
     * Collect the lora paths currently loaded by LoraLoader nodes on the canvas.
     * Returns a Set of normalized (posix, forward-slash) lora relative paths.
     */
    collectUsedLoras() {
        const used = new Set();
        if (!this.app || !this.app.graph || !this.app.graph._nodes) return used;
        for (const node of this.app.graph._nodes) {
            if (node.mode === 4) continue; // bypassed nodes don't contribute
            if (!/^LoraLoader/i.test(node.comfyClass || '') || !node.widgets) continue;
            for (const w of node.widgets) {
                if (w.name === 'lora_name' && w.type === 'combo' && typeof w.value === 'string' && w.value) {
                    used.add(w.value.replace(/\\/g, '/'));
                }
            }
        }
        return used;
    }

    toggleWorkflowMatch() {
        this.workflowMatchActive = !this.workflowMatchActive;
        this.list.sortAndDisplayImages();
    }

    /**
     * Jump straight to the directory of a lora used by the current workflow.
     * The target card is briefly highlighted after render, but the rest of the
     * directory stays fully visible (no persistent filter).
     */
    async _jumpToUsedLora() {
        const used = [...this.collectUsedLoras()];
        if (used.length === 0) return;
        used.sort();
        this._jumpTargetPath = used[0];
        const segs = used[0].replace(/\.(safetensors|pt|ckpt|bin|sft)$/i, "").split("/");
        await this.showDirectoryStructure("Lora", segs.slice(0, -1));
    }

    // ====== Lora Section Auto-Refresh ======

    _isLoraView() {
        return this.currentView.mode === 'directory' && (this.currentView.source || '').toLowerCase().startsWith('lora');
    }

    startLoraRefresh() {
        if (this._loraRefreshTimer) return;
        this._loraRefreshTimer = setInterval(async () => {
            try {
                const resp = await api.fetchApi('/neo_gallery/lora_cache_status');
                if (!resp.ok) return;
                const st = await resp.json();
                // Keep refreshing while the auto-cache worker is active or loras are
                // queued with a configured API key; without a key there is nothing to fetch.
                if (this._isLoraView() && st.enabled && (st.running || st.pending_count > 0)) {
                    const src = this.currentView.source;
                    const segs = this.currentView.categoryPath || [];
                    await this.showDirectoryStructure(src, segs);
                } else {
                    this.stopLoraRefresh();
                }
            } catch (e) { /* keep polling */ }
        }, 2000);
    }

    stopLoraRefresh() {
        if (this._loraRefreshTimer) {
            clearInterval(this._loraRefreshTimer);
            this._loraRefreshTimer = null;
        }
    }

    // ====== 导航历史（顶部前进/后退按钮） ======

    _snapshotView() {
        return {
            mode: this.currentView.mode,
            source: this.currentView.source,
            categoryPath: [...(this.currentView.categoryPath || [])]
        };
    }

    // 每次视图切换（进入目录 / 收藏页 / 首页）记录一条历史；相同视图不重复入栈。
    _recordNavState() {
        if (this._navRestoring) return;
        const view = this._snapshotView();
        const cur = this._navStack[this._navPos];
        if (cur && cur.mode === view.mode && cur.source === view.source &&
            JSON.stringify(cur.categoryPath) === JSON.stringify(view.categoryPath)) {
            return;
        }
        this._navStack.length = this._navPos + 1; // 丢弃前进分支
        this._navStack.push(view);
        this._navPos = this._navStack.length - 1;
        this._updateNavButtons();
        // 视图一变就记在当前宿主名下。等摘走时才写的话，切走那一下套用的是目标宿主的上一次
        // 记录：抽屉里刚浏览的目录要等下次才生效，开合素材库就变成一次首页、一次目录。
        this.rememberView(this.element.parentNode);
        this.savePluginData({ currentView: this.currentView, libViews: this._libViews });
    }

    _updateNavButtons() {
        if (this.navBackBtn) this.navBackBtn.disabled = this._navPos <= 0;
        if (this.navForwardBtn) this.navForwardBtn.disabled = this._navPos >= this._navStack.length - 1;
    }

    // delta: -1 后退 / +1 前进。无可达条目时返回 false（调用方可走旧逻辑兜底）。
    async navigateHistory(delta) {
        const target = this._navPos + delta;
        if (target < 0 || target >= this._navStack.length) return false;
        const view = this._navStack[target];
        this._navPos = target;
        this._updateNavButtons();
        this._navRestoring = true; // 恢复渲染时不再入栈、不写浏览器历史
        try {
            if (view.mode === 'categories') await this.showCategoryCards();
            else if (view.mode === 'local_bookmarks') await this.showLocalBookmarks();
            else if (view.mode === 'civitai_bookmarks') await this.showCivitaiBookmarks();
            else await this.showDirectoryStructure(view.source, view.categoryPath);
        } finally {
            this._navRestoring = false;
        }
        return true;
    }

    // 每个宿主各记自己停在哪个目录，挂上时恢复它记的那个（applyView）。
    // 三个宿主共用一个 currentView 的话，在导演抽屉里翻进二级目录，绘画页左栏会跟着跳过去。
    // 写入点在 _recordNavState：视图一变就记，切走那一下套用的才是目标宿主自己的目录。
    // 宿主靠 data-lib-scope 认身份；没收标记的（收留宿主、ComfyUI 侧栏）不进这张表。
    rememberView(hostEl) {
        const scope = hostEl?.dataset?.libScope;
        if (!scope || !this.currentView?.mode) return;
        this._libViews[scope] = {
            mode: this.currentView.mode,
            source: this.currentView.source || null,
            categoryPath: [...(this.currentView.categoryPath || [])],
        };
    }

    applyView(hostEl) {
        const saved = hostEl?.dataset?.libScope ? this._libViews[hostEl.dataset.libScope] : null;
        if (!saved || !saved.mode) return;
        this.currentView = { mode: saved.mode, source: saved.source || null, categoryPath: saved.categoryPath || [] };
    }
    // 侧栏标签页与 Studio 各页宿主共用这条挂载路径。
    async mountTo(hostEl) {
        hostEl.innerHTML = "";
        hostEl.appendChild(this.element);
        this.applyView(hostEl);        // 新宿主记过目录就切到它自己的，没记过沿用当前
        // 宽宿主标记：桌面端素材页的专属样式全部挂在 .neo-gallery-panel--wide 下，
        // 侧栏标签页把同一个元素搬进侧栏容器时没有这个祖先，侧栏外观不变。
        this.element.classList.toggle("neo-gallery-panel--wide", !!hostEl.closest(".ns-gallery-host"));

        if (!this._loaded) {
            await this.loadAndDisplay();
            this._loaded = true;
        } else {
            releaseLazyThumbnails(this.accordion);
            this.accordion.innerHTML = "";
            await this.renderCurrentView();
        }
        // 面板在带 gallery 参数的 URL 下挂载时补一次面包屑
        const galleryParam = new URLSearchParams(window.location.search).get('gallery');
        if (galleryParam && this.currentView.mode === 'directory') {
            this.list.updateBreadcrumb(this, this.currentView.categoryPath, '');
        }
        this.isVisible = true;
        this.startScrollListener();
    }

    // 重挂载（切页、开合素材库抽屉）不是导航：画离开时那个视图。
    // 侧栏 tab 的 render 旧代码在这里固定画首页，用户从二级目录切走再切回就被拽回首页。
    // _navRestoring 挡住 showDirectoryStructure 的 pushState，免得每次开关抽屉
    // 都在浏览器历史里堆一条同视图记录（后退键要点好几次才离开素材库）。
    async renderCurrentView() {
        const view = this.currentView;
        this._navRestoring = true;
        try {
            if (view.mode === 'directory' && view.source) await this.showDirectoryStructure(view.source, view.categoryPath || []);
            else if (view.mode === 'local_bookmarks') await this.showLocalBookmarks();
            else if (view.mode === 'civitai_bookmarks') await this.showCivitaiBookmarks();
            else await this.list.sortAndDisplayImages();
        } finally {
            this._navRestoring = false;
        }
    }

    // ====== 本地收藏（仅记录路径信息，打开时基于路径查找） ======

    _createLocalHomeCard() {
        const card = $el("div", {
            className: "neo-gallery-category-card neo-gallery-local-home",
            onclick: () => this.showLocalBookmarks()
        });
        const coverWrapper = $el("div", {
            className: "neo-gallery-card-cover-wrapper skeleton-loading"
        });
        coverWrapper.appendChild(buildPlaceholderTile());
        // 首页卡封面取收藏内容前两张（有收藏时异步补齐）。
        api.fetchApi('/neo_bookmark/local').then(r => (r.ok ? r.json() : { items: [] })).then(d => {
            const first = ((d && d.items) || []).find(i => i.covers && i.covers.length);
            if (first && card.isConnected) this._applyBookmarkCovers(coverWrapper, first.covers, first);
        }).catch(() => {});
        const typeBadge = $el("div", {
            className: "neo-gallery-card-type-badge type-directory",
            title: t("本地收藏（记录路径，打开时基于路径查找）")
        }, [""]);
        const nameEl = $el("span", { className: "neo-gallery-card-name", textContent: t("本地收藏") });
        const info = $el("div", { className: "neo-gallery-card-info" }, [nameEl]);
        card.appendChild(typeBadge);
        card.appendChild(coverWrapper);
        card.appendChild(info);
        return card;
    }

    async showLocalBookmarks() {
        await this.list._saveCurrentScrollPosition();
        this.currentView.mode = 'local_bookmarks';
        this.currentView.source = t('本地收藏');
        this.currentView.categoryPath = [];
        this.stopLoraRefresh();
        this.list.updateBreadcrumb(this, [], '');

        const stateKey = 'gallery_v2:local_bookmarks:';
        if (!this._navRestoring) {
            const currentUrl = new URL(window.location.href);
            currentUrl.searchParams.set('gallery', stateKey);
            history.pushState({ galleryState: stateKey }, '', currentUrl.toString());
        }

        await this._renderLocalBookmarks();
        this._recordNavState();
    }

    async _renderLocalBookmarks() {
        releaseLazyThumbnails(this.accordion);
        this.accordion.innerHTML = "";
        let data;
        try {
            const resp = await api.fetchApi('/neo_bookmark/local');
            data = await resp.json();
        } catch (e) {
            console.error('[Neo Gallery] Failed to load local bookmarks:', e);
            showNoFilesMessage(this.accordion, t("加载本地收藏失败"));
            return;
        }
        const items = (data && data.items) || [];
        if (items.length === 0) {
            showNoFilesMessage(this.accordion, t("暂无本地收藏。在图片缩略图右下角的「⋯」按钮即可收藏。"));
            return;
        }
        const container = $el("div", {
            className: "neo-gallery-category-grid",
            style: { '--neo-card-h': `${getCardHeight(this)}px` }
        });
        attachMasonry(container, cardColumnWidth(this));
        for (const item of items) {
            container.appendChild(this._createLocalBookmarkCard(item));
        }
        this.accordion.appendChild(container);
    }

    // ====== Civitai 收藏 (bookmarked C-site models, shown like the Lora section) ======

    _createLocalBookmarkCard(item) {
        const isAudio = !!(item.filename && isAudioFile(item.filename));
        const card = $el("div", {
            className: "neo-gallery-category-card neo-gallery-local-card" + (isAudio ? " neo-gallery-local-card-audio" : ""),
            onclick: () => {
                if (isAudio) { this._toggleBookmarkAudio(item, card); return; }
                this._openLocalBookmark(item);
            }
        });
        card.dataset.bookmarkId = item.id;
        const coverWrapper = $el("div", {
            className: "neo-gallery-card-cover-wrapper skeleton-loading"
        });
        card._coverWrapper = coverWrapper;
        if (isAudio) {
            const subfolder = this._resolveBookmarkSubfolder(item);
            const audioCard = this.card._buildAudioCard(this, { filename: item.filename }, subfolder);
            coverWrapper.classList.remove('skeleton-loading');
            coverWrapper.classList.add('skeleton-loaded');
            coverWrapper.appendChild(audioCard);
        } else {
            this._applyBookmarkCovers(coverWrapper, item.covers || [], item);
        }

        const sourceLabel = item.source === "oss" ? t("OSS 预设") : (item.source === "civitai" ? t("C 站") : t("本地"));
        const nameEl = $el("span", { className: "neo-gallery-card-name", textContent: item.name || item.filename || t("未命名") });
        const info = $el("div", { className: "neo-gallery-card-info" }, [
            nameEl,
            $el("span", { className: "neo-gallery-card-source-badge", textContent: sourceLabel })
        ]);
        const isFile = !!item.filename;
        const typeBadge = $el("div", {
            className: `neo-gallery-card-type-badge ${isAudio ? "type-audio" : (isFile ? "type-image" : "type-directory")}`,
            title: tf("{src}收藏 · {path}", { src: sourceLabel, path: [item.dir, item.subfolder, item.filename].filter(Boolean).join("/") })
        }, [isAudio ? "\u266A" : (item.source === "oss" ? "\u2601" : (isFile ? "" : ""))]);
        const menuBtn = $el("div", {
            className: "neo-gallery-thumb-bookmark-btn",
            title: t("更多操作"),
            onclick: (e) => {
                e.stopPropagation();
                const unfavorite = () => this._removeLocalBookmark(item, card);
                if (isFile) {
                    this.card._showCollectMenu(this, { filename: item.filename, name: item.name }, this._resolveBookmarkSubfolder(item), item.source, menuBtn, unfavorite);
                } else {
                    this.card._showBookmarkMenu(this, item, menuBtn, unfavorite);
                }
            }
        }, ["\u22EF"]);

        card.appendChild(typeBadge);
        card.appendChild(coverWrapper);
        card.appendChild(info);
        card.appendChild(menuBtn);
        return card;
    }

    _resolveBookmarkSubfolder(item) {
        return item.source === "oss"
            ? (item.dir || "")
            : ((item.subfolder) ? `${item.dir}/${item.subfolder}` : (item.dir || ""));
    }

    _toggleBookmarkAudio(item, card) {
        const subfolder = this._resolveBookmarkSubfolder(item);
        this.card._toggleAudioPlayback(this, { filename: item.filename }, subfolder, card);
    }

    async _openLocalBookmark(item) {
        try {
            if (item.source === "civitai") {
                await this.showDirectoryStructure(CIVITAI_DIR_KEY, [item.dir || item.filename]);
            } else if (item.filename) {
                // 单图收藏：仅显示本图，直接以灯箱打开该媒体（不进入目录）
                this.card.showLightbox(this, { filename: item.filename }, this._resolveBookmarkSubfolder(item));
            } else {
                const segs = (item.subfolder || "").split("/").filter(Boolean);
                await this.showDirectoryStructure(item.dir, segs);
            }
        } catch (e) {
            console.error('[Neo Gallery] Failed to open local bookmark:', e);
            showToast(this.app, 'error', t('打开收藏失败'), t('源路径可能已被移动或删除：') + String(e));
        }
    }

    async _removeLocalBookmark(item, card) {
        try {
            const resp = await api.fetchApi('/neo_bookmark/local/remove', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id })
            });
            const data = await resp.json();
            if (data.success) {
                if (card && card.parentNode) card.remove();
                showToast(this.app, 'success', t('已取消收藏'), item.name || '');
            } else {
                showToast(this.app, 'error', t('取消收藏失败'), data.error || '');
            }
        } catch (e) {
            showToast(this.app, 'error', t('取消收藏失败'), String(e));
        }
    }

    _createCivitaiHomeCard() {
        const card = $el("div", {
            className: "neo-gallery-category-card neo-gallery-civitai-home",
            onclick: () => this.showCivitaiBookmarks()
        });
        const coverWrapper = $el("div", {
            className: "neo-gallery-card-cover-wrapper skeleton-loading"
        });
        coverWrapper.appendChild(buildPlaceholderTile());
        // 首页卡封面取收藏列表内容前两张（开关开启且有收藏时异步补齐）。
        api.fetchApi('/neo_bookmark/civitai/list', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
        }).then(r => (r.ok ? r.json() : { success: false })).then(d => {
            const first = d && d.success ? ((d.items) || []).find(i => i.covers && i.covers.length) : null;
            if (first && card.isConnected) this._applyBookmarkCovers(coverWrapper, first.covers, first);
        }).catch(() => {});
        const typeBadge = $el("div", {
            className: "neo-gallery-card-type-badge type-directory",
            title: t("C站收藏（可保存为配方）")
        }, [""]);
        const nameEl = $el("span", { className: "neo-gallery-card-name", textContent: CIVITAI_DIR_NAME });
        const info = $el("div", { className: "neo-gallery-card-info" }, [nameEl]);

        card.appendChild(typeBadge);
        card.appendChild(coverWrapper);
        card.appendChild(info);
        return card;
    }

    async showCivitaiBookmarks() {
        this.clearSelection();
        await this.list._saveCurrentScrollPosition();
        this.currentView.mode = 'civitai_bookmarks';
        this.currentView.source = CIVITAI_DIR_KEY;
        this.currentView.categoryPath = [];
        this.stopLoraRefresh();
        this.list.updateBreadcrumb(this, [], '');

        const stateKey = `gallery_v2:${encodeURIComponent(CIVITAI_VIEW_SOURCE)}:`;
        if (!this._navRestoring) {
            const currentUrl = new URL(window.location.href);
            currentUrl.searchParams.set('gallery', stateKey);
            history.pushState({ galleryState: stateKey }, '', currentUrl.toString());
        }

        await this._renderCivitaiBookmarks();
        this._recordNavState();
    }

    async _renderCivitaiBookmarks(refresh = false, page = 0) {
        releaseLazyThumbnails(this.accordion);
        this.accordion.innerHTML = "";
        this._civitaiPage = page;
        let data;
        try {
            const resp = await api.fetchApi('/neo_bookmark/civitai/list', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh, page })
            });
            data = await resp.json();
        } catch (e) {
            console.error('[Neo Gallery] Failed to load Civitai bookmarks:', e);
            showNoFilesMessage(this.accordion, t("加载收藏失败"));
            return;
        }

        if (!data.success) {
            const msg = data.needs_api_key ? t("需在「Manage Directories」配置 C 站 API KEY") : (data.error || t("加载收藏失败"));
            showNoFilesMessage(this.accordion, msg);
            return;
        }

        const items = data.items || [];
        if (items.length === 0) {
            showNoFilesMessage(this.accordion, t("暂无收藏的 C 站模型"));
            return;
        }

        const refreshBtn = document.createElement("button");
        refreshBtn.textContent = "\u27F3 \u5237\u65B0";
        refreshBtn.title = "\u91CD\u65B0\u4ECE C \u7AD9\u62C9\u53D6\u6536\u85CF\u5217\u8868\uFF08\u5FFD\u7565\u7F13\u5B58\uFF09";
        refreshBtn.style.cssText = "margin:0 0 8px;padding:4px 12px;font-size:12px;cursor:pointer;background:#2a2a2a;color:#ccc;border:1px solid #444;border-radius:6px;";
        refreshBtn.onclick = async () => {
            if (refreshBtn.disabled) return;
            refreshBtn.disabled = true;
            refreshBtn.textContent = "\u27F3 \u5237\u65B0\u4E2D\u2026";
            try {
                await this._renderCivitaiBookmarks(true, this._civitaiPage);
            } catch (e) {
                console.error('[Neo Gallery] Failed to refresh Civitai bookmarks:', e);
                refreshBtn.disabled = false;
                refreshBtn.textContent = "\u27F3 \u5237\u65B0";
            }
        };

        const container = $el("div", {
            className: "neo-gallery-category-grid",
            style: { '--neo-card-h': `${getCardHeight(this)}px` }
        });
        attachMasonry(container, cardColumnWidth(this));
        for (const item of items) {
            container.appendChild(this._createCivitaiBookmarkCard(item));
        }
        this.accordion.appendChild(refreshBtn);
        this.accordion.appendChild(container);

        // 上下页切换（与 Lora 板块一致的分页浏览）
        const pagination = $el("div", {
            className: "neo-gallery-pagination",
            style: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', marginTop: '12px' }
        }, [
            $el("button", {
                className: "neo-gallery-pagination-btn",
                title: t("上一页"),
                textContent: t("‹ 上一页"),
                disabled: page <= 0,
                onclick: () => this._renderCivitaiBookmarks(false, page - 1)
            }),
            $el("span", { className: "neo-gallery-pagination-info", textContent: tf("第 {n} 页", { n: page + 1 }) }),
            $el("button", {
                className: "neo-gallery-pagination-btn",
                title: t("下一页"),
                textContent: t("下一页 ›"),
                disabled: !data.has_more,
                onclick: () => this._renderCivitaiBookmarks(false, page + 1)
            })
        ]);
        this.accordion.appendChild(pagination);

        this._setupCivitaiCoverLazyLoad();
    }

    _createCivitaiBookmarkCard(item) {
        const card = $el("div", {
            className: "neo-gallery-category-card neo-gallery-civitai-card",
            onclick: (e) => this._openCivitaiBookmarkDir(item, e.currentTarget)
        });
        card.dataset.civitaiId = item.id;

        const coverWrapper = $el("div", {
            className: "neo-gallery-card-cover-wrapper skeleton-loading"
        });

        const typeLabel = [item.type, item.baseModel].filter(Boolean).join(" · ");
        const nameEl = $el("span", { className: "neo-gallery-card-name", textContent: item.name || ("Civitai #" + item.id) });
        const info = $el("div", { className: "neo-gallery-card-info" }, [nameEl]);

        const typeBadge = $el("div", {
            className: "neo-gallery-card-type-badge type-directory",
            title: typeLabel || t("Civitai 模型")
        }, [""]);

        const saveBtn = $el("div", {
            className: "neo-gallery-card-civitai-save-btn",
            title: t("保存为配方"),
            onclick: (e) => { e.stopPropagation(); this._saveCivitaiBookmarkAsRecipe(item, saveBtn); }
        }, [""]);

        card.appendChild(typeBadge);
        card.appendChild(coverWrapper);
        card.appendChild(info);
        card.appendChild(saveBtn);
        card._coverWrapper = coverWrapper;

        if (item.covers && item.covers.length) {
            this._applyBookmarkCovers(coverWrapper, item.covers, item);
        }
        return card;
    }

    async _openCivitaiBookmarkDir(item, card) {
        if (card && card.dataset.opening === "1") return;
        if (card) card.dataset.opening = "1";
        const progressEl = card ? $el("div", { className: "neo-gallery-civitai-progress", textContent: t("正在连接 Civitai…") }) : null;
        if (progressEl) card.appendChild(progressEl);
        let pollTimer = null;
        const stopPolling = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
        if (progressEl) {
            pollTimer = setInterval(async () => {
                try {
                    const resp = await api.fetchApi('/neo_bookmark/civitai/status');
                    const st = await resp.json();
                    if (st.running) {
                        progressEl.textContent = tf("正在缓存示例图 {done}/{total} · {current}", { done: st.done, total: st.total, current: st.current || '' });
                    } else if (st.error) {
                        progressEl.textContent = st.error;
                    }
                } catch (_) { /* keep the initial hint */ }
            }, 1000);
        }
        try {
            const resp = await api.fetchApi('/neo_bookmark/civitai/media', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, name: item.name })
            });
            const data = await resp.json();
            if (!data.success) {
                showToast(this.app, 'error', t('加载示例图失败'), data.error || '');
                return;
            }
            if (!(data.images || []).length) {
                showToast(this.app, 'info', t('无示例图'), t('该模型暂无可预览的示例图'));
                return;
            }
            // 边下边开：下载到第一张即进入目录；剩余由后台任务续下，
            // 完成后自动刷新当前目录补齐（进度见卡片下方轮询提示）。
            const modelKey = data.model_key || String(item.id);
            await this.showDirectoryStructure(CIVITAI_DIR_KEY, [modelKey]);
            if (!data.complete) this._pollBookmarkMediaUntilDone(modelKey);
        } catch (e) {
            console.error('[Neo Gallery] Failed to open Civitai bookmark examples:', e);
            showToast(this.app, 'error', t('打开失败'), String(e));
        } finally {
            stopPolling();
            if (progressEl) progressEl.remove();
            if (card) delete card.dataset.opening;
        }
    }

    async _pollBookmarkMediaUntilDone(modelKey) {
        const started = Date.now();
        const timer = setInterval(async () => {
            try {
                const resp = await api.fetchApi('/neo_bookmark/civitai/status');
                const st = await resp.json();
                const sameDir = this.currentView.mode === 'directory' &&
                    (this.currentView.source || '') === CIVITAI_DIR_KEY &&
                    (this.currentView.categoryPath || []).join('/') === modelKey;
                if (!st.running) {
                    clearInterval(timer);
                    if (sameDir && !st.error) {
                        await this.showDirectoryStructure(CIVITAI_DIR_KEY, [modelKey]);
                    }
                } else if (!sameDir || Date.now() - started > 15 * 60 * 1000) {
                    clearInterval(timer);
                }
            } catch (_) { clearInterval(timer); }
        }, 2000);
    }

    _applyCivitaiCover(coverWrapper, url) {
        this._applyBookmarkCovers(coverWrapper, [{ url }], {});
    }

    /**
     * 收藏卡封面：交给共享渲染器竖排展示（图/视频自然比例，音频走音频瓦片）。
     * covers 项形如 {filename, subfolder}（本地缓存，走缩略图接口）或 {url}（远程直链）。
     */
    _applyBookmarkCovers(coverWrapper, covers, item) {
        coverWrapper.classList.remove('skeleton-loading');
        coverWrapper.classList.add('skeleton-loaded');
        renderCoverTiles(coverWrapper, covers || [], (item && item.name) || "");
    }

    _setCivitaiCoverPlaceholder(coverWrapper) {
        coverWrapper.classList.remove('skeleton-loading');
        renderCoverTiles(coverWrapper, [], "");
    }

    _setupCivitaiCoverLazyLoad() {
        // Fetch covers for cards that didn't get one from the list response (like Lora lazy covers).
        const pending = Array.from(this.accordion.querySelectorAll('.neo-gallery-civitai-card[data-civitai-id]'))
            .filter(c => c._coverWrapper && c._coverWrapper.classList.contains('skeleton-loading'));
        if (pending.length === 0) return;

        const observer = new IntersectionObserver(async (entries, obs) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const card = entry.target;
                obs.unobserve(card);
                try {
                    const resp = await api.fetchApi('/neo_bookmark/civitai/cover', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: card.dataset.civitaiId })
                    });
                    const data = await resp.json();
                    if (data.success && data.cover) {
                        this._applyCivitaiCover(card._coverWrapper, data.cover);
                    } else {
                        this._setCivitaiCoverPlaceholder(card._coverWrapper);
                    }
                } catch (e) {
                    this._setCivitaiCoverPlaceholder(card._coverWrapper);
                }
            }
        }, { rootMargin: '200px' });

        for (const card of pending) observer.observe(card);
    }

    async _saveCivitaiBookmarkAsRecipe(item, button) {
        if (button.dataset.saving === "1") return;
        const url = `https://civitai.com/models/${item.id}`;
        button.dataset.saving = "1";
        button.textContent = "";
        try {
            const resolveResp = await api.fetchApi('/neo_bookmark/civitai/resolve', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url })
            });
            const resolved = await resolveResp.json();
            if (!resolved.success) {
                showInlineFeedback(button, resolved.error || t("解析失败"), "error");
                button.textContent = "";
                return;
            }
            const saveResp = await api.fetchApi('/rs_recipes/save_from_civitai', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                    name: resolved.name || item.name,
                    model_id: resolved.model_id,
                    prompt: resolved.prompt || "",
                    images: resolved.images || [],
                    loras: resolved.loras || []
                })
            });
            const saved = await saveResp.json();
            if (!saved.success) {
                showInlineFeedback(button, saved.error || t("保存失败"), "error");
                button.textContent = "";
                return;
            }
            showInlineFeedback(button, t("已保存为配方"), "success");
            button.textContent = "";
        } catch (e) {
            console.error('[Neo Gallery] Failed to save Civitai recipe:', e);
            showInlineFeedback(button, String(e), "error");
            button.textContent = "";
        } finally {
            button.dataset.saving = "";
        }
    }

    async showDirectoryStructure(source, pathSegments = []) {
        this.clearSelection();
        const dirName = source;
        const relPath = pathSegments.join("/");

        // The civitai_bookmarks top level is a custom bookmark list, not a real directory.
        // With no path segments we show that list; with path segments we render the
        // selected model's cached example images as a standard directory (like Lora).
        if (dirName === CIVITAI_DIR_KEY && pathSegments.length === 0) {
            this.showCivitaiBookmarks();
            return;
        }

        // 修复：在进入新视图之前，先保存当前视图的滚动位置
        if (this.currentView.mode !== 'directory' || this.currentView.source !== dirName) {
            await this.list._saveCurrentScrollPosition();
        }
        
        try {
            // Use /neo_gallery/list with fields=dirs,items,covers to get directory structure, items, and covers
            const resp = await api.fetchApi(`/neo_gallery/list?fields=dirs,items,covers&dir_name=${encodeURIComponent(dirName)}&path=${encodeURIComponent(relPath)}`);
            if (resp.status === 404) {
                // 目录已不存在（被删除/移动，或 URL 里残留的旧导航状态）：回到首页而不是报错。
                this.currentView.mode = 'categories';
                await this.showCategoryCards();
                return;
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            
            const data = await resp.json();
            let structure = data.directories[0] || {};
            
            // Update covers cache if provided (merge to preserve parent dir covers when navigating back)
            if (data.covers && Object.keys(data.covers).length > 0) {
                this._dirCovers = { ...this._dirCovers, ...data.covers };
                console.log('[Neo Gallery] Merged cover images from directory response:', Object.keys(this._dirCovers).length, 'directories');
            }
            
            this.currentView.mode = 'directory';
            this.currentView.source = dirName;
            this.currentView.categoryPath = pathSegments;
            this._currentDirStructure = structure;

            this.list.updateBreadcrumb(this, pathSegments, '');

            this.list.renderDirectoryStructure(structure, dirName, pathSegments);

            // Auto-refresh while browsing the Lora section so newly cached examples appear.
            if (String(dirName).toLowerCase().startsWith('lora')) {
                this.startLoraRefresh();
            } else {
                this.stopLoraRefresh();
            }
            
            // Push state to history for back button support (use query param to avoid conflict with workflow hash)
            const stateKey = `gallery_v2:${encodeURIComponent(dirName)}:${pathSegments.join('/')}`;
            if (!this._navRestoring) {
                const currentUrl = new URL(window.location.href);
                currentUrl.searchParams.set('gallery', stateKey);
                history.pushState({ galleryState: stateKey }, '', currentUrl.toString());
            }

            this._recordNavState();

        } catch (error) {
            console.error('[Gallery] Error loading directory structure:', error);
            showToast(this.app, 'error', 'Error', 'Failed to load directory structure');
        }
    }

    showCategoryImages(source, pathSegments, displayName) {
        this.showDirectoryStructure(source, pathSegments || []);
    }

    async showCategoryCards() {
        this.clearSelection();
        // 保存当前滚动位置（在切换 mode 之前）
        const currentKey = this.list._getScrollKey();
        if (currentKey) {
            const scrollContainer = this.list._getScrollContainer();
            const scrollTop = scrollContainer === window 
                ? window.pageYOffset || document.documentElement.scrollTop 
                : scrollContainer.scrollTop;
            this._scrollPositions[currentKey] = scrollTop;
        }
        
        this.currentView.mode = 'categories';
        this.currentView.source = null;
        this.currentView.categoryPath = [];
        this.stopLoraRefresh();

        const breadcrumb = document.getElementById("neo-gallery-breadcrumb");
        if (breadcrumb) {
            breadcrumb.style.display = 'none';
        }

        // Remove gallery query param when going back to categories
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.delete('gallery');
        history.replaceState(null, '', currentUrl.toString());

        await this.list.sortAndDisplayImages();
        this._recordNavState();
    }

    // ====== Actions ======

    async deleteItem(name, subfolder, { silent = false } = {}) {
        try {
            const response = await api.fetchApi('/neo_gallery/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: name, subfolder })
            });
            const result = await response.json();
            
            // Check success field (new format) or deleted field (legacy fallback)
            if (result.success || result.deleted) {
                if (!silent) showToast(this.app, 'success', 'Deleted', `Removed: ${name}`);
                
                // Remove from data source immediately
                // In lazy mode, use _currentDirImages as fallback since dir.items is undefined
                for (const dir of this.allDirectories) {
                    const items = Array.isArray(dir.items) ? dir.items : [];
                    if (items.length > 0) {
                        const before = items.length;
                        dir.items = items.filter(item => item.name !== name || item.subfolder !== subfolder);
                        if (before !== dir.items.length) break;
                    }
                }
                
                // Also remove from filtered directories (search results)
                for (const dir of this.filteredDirectories) {
                    const items = Array.isArray(dir.items) ? dir.items : [];
                    if (items.length > 0) {
                        const before = items.length;
                        dir.items = items.filter(item => item.name !== name || item.subfolder !== subfolder);
                        if (before !== dir.items.length) break;
                    }
                }
                
                // Also remove from the cached directory structure (directory view re-renders from it;
                // its items are scoped to the current view, so name match is enough)
                if (this._currentDirStructure && Array.isArray(this._currentDirStructure.items)) {
                    this._currentDirStructure.items = this._currentDirStructure.items.filter(item => item.name !== name);
                }

                // Also remove from _currentDirImages (lazy mode fallback; items may lack subfolder)
                if (this._currentDirImages && this._currentDirImages.length > 0) {
                    this._currentDirImages = this._currentDirImages.filter(item => item.name !== name);
                }
                
                // Remove DOM element immediately for better UX
                let domRemoved = false;
                
                // Try matching by filename (with extension) and also try without extension
                const nameWithoutExt = name.replace(/\.(png|jpg|jpeg|gif|webp|bmp|tiff|mp4|webm|mov|avi|mkv|flv|wmv)$/i, '');
                
                // First try: match with full filename (image.filename in DOM) or without extension
                const thumbContainers = document.querySelectorAll('.neo-gallery-thumb-container');
                for (const container of thumbContainers) {
                    if ((container.dataset.filename === name || container.dataset.filename === nameWithoutExt) && 
                        container.dataset.subfolder === subfolder) {
                        container.remove();
                        domRemoved = true;
                        break;
                    }
                }
                
                // Second try: match by checking if filename starts with the deleted name (handles extension mismatch)
                if (!domRemoved) {
                    for (const container of thumbContainers) {
                        const containerName = container.dataset.filename || '';
                        const containerSubfolder = container.dataset.subfolder || '';
                        if ((containerName === name || containerName.startsWith(nameWithoutExt + '.')) && 
                            containerSubfolder === subfolder) {
                            container.remove();
                            domRemoved = true;
                            break;
                        }
                    }
                }
                
                // Also remove from presets directory cards that might reference this file
                if (!domRemoved) {
                    const cardThumbnails = document.querySelectorAll('.neo-gallery-card-cover-grid-item img');
                    for (const img of cardThumbnails) {
                        if (img.alt === name || (img.src && img.src.includes(encodeURIComponent(name)))) {
                            img.parentElement?.parentElement?.remove();
                            break;
                        }
                    }
                }
                
                // If no elements remain, show empty state. Subdir cards count as content:
                // a folder that only lost its root images must not show the empty message.
                const remaining = this.accordion.querySelectorAll('.neo-gallery-thumb-container, .neo-gallery-category-card');
                if (remaining.length === 0 && !this.isSearchActive) {
                    this.displayNoFilesMessage();
                }
                return true;
            } else {
                const errorMsg = result.error || 'Unknown error';
                if (!silent) showToast(this.app, 'error', 'Delete Failed', errorMsg);
                return false;
            }
        } catch (error) {
            console.error("Error deleting item:", error);
            if (!silent) showToast(this.app, 'error', 'Delete Failed', error.message || 'Network error');
            return false;
        }
        return false;
    }

    // ====== 多选删除（卡片左上角勾选框） ======

    /** 当前视图的目录 token（与目录设置的 token 同形）：source + categoryPath，小写比较。
     *  自定义目录在画廊里用目录名做 source，设置里存绝对路径，这里换成路径再比。 */
    _dirTokenOf(view = this.currentView) {
        if (!view || view.mode !== 'directory' || !view.source) return '';
        const src = String(view.source).toLowerCase();
        const base = this._customDirTokens?.get(src) || src;
        return [base, ...(view.categoryPath || []).map(String)].join('/').toLowerCase();
    }

    /** 当前视图是角色图目录：多选建导演配方走全参考（三视图当关键帧会让视频从设定图开镜）。
     *  子目录继承父目录的标记：标了 stars，stars/孟子义 里的图同样按角色图处理。
     *  宿主（studio-app.js 的右栏上下文）要问的是自己那份视图，传进来查，不读画廊现值。 */
    isCharacterDir(view = this.currentView) {
        const token = this._dirTokenOf(view);
        if (!token) return false;
        const parts = token.split('/');
        for (let i = parts.length; i > 0; i--) {
            if (this.characterDirs.has(parts.slice(0, i).join('/'))) return true;
        }
        return false;
    }

    /** 导演配方草稿：卡片菜单（单图）与多选操作条共用。
     *  角色图目录 → 一段全参考：图进该段参考图，同时填 角色参考图（身份参考 + r2i 图片分镜）；
     *  其余目录 → 每图一段、图作首帧。三视图是设定图，当首帧会让视频从设定图开镜。 */
    directorDraft(frames) {
        if (!this.isCharacterDir()) {
            return { name: '', shared: { mode: 'f2v' }, segments: frames.map((f) => ({ first_frame: f, duration_sec: 5 })) };
        }
        return {
            name: '',
            shared: { mode: 'r2v' },
            segments: [{ refs: { images: frames.slice(0, DIRECTOR_REF_MAX) }, duration_sec: 5 }],
            story: {
                characters: frames.slice(0, DIRECTOR_CHAR_MAX).map((filename) => ({ filename })),
                image_mode: 'r2i',
            },
        };
    }

    _selectionKey(name, subfolder) {
        return `${subfolder || ''}\u0000${name}`;
    }

    /** 与 ⋯ 菜单的 canDelete 判定一致：presets/lora/C站收藏目录（按目录名或子路径）与 oss 只读。 */
    isDeletableItem(name, subfolder, source = "", dirName = "") {
        const lower = (s) => String(s || "").toLowerCase();
        const readOnlyPrefixes = ["presets", "lora", "civitai_bookmarks"];
        const isReadOnlyPath = (p) => readOnlyPrefixes.some((pre) => p === pre || p.startsWith(pre + "/"));
        if (isReadOnlyPath(lower(subfolder)) || isReadOnlyPath(lower(dirName))) return false;
        return source !== "oss";
    }

    toggleSelection(name, subfolder) {
        const key = this._selectionKey(name, subfolder);
        if (this._selectedItems.has(key)) this._selectedItems.delete(key);
        else this._selectedItems.add(key);
        this._updateSelectionBar();
    }

    clearSelection() {
        if (this._selectedItems.size === 0 && !this._selectionBar) return;
        this._selectedItems.clear();
        // 勾选框/选中态同步回 DOM，否则清空后卡片仍显示为选中（且再点已勾的框会被当成新增）
        document.querySelectorAll('.neo-gallery-thumb-container').forEach((el) => {
            const cb = el.querySelector('.neo-gallery-select-check');
            if (cb) cb.checked = false;
            el.classList.remove('neo-gallery-thumb-selected');
        });
        this._updateSelectionBar();
    }

    /** Ctrl+A：选中当前视图内所有可删除素材。 */
    selectAllVisible() {
        const items = this.isSearchActive ? this.filteredDirectories : this.allDirectories;
        for (const dir of items || []) {
            for (const item of Array.isArray(dir.items) ? dir.items : []) {
                if (!this.isDeletableItem(item.name, item.subfolder, dir.source, dir.name)) continue;
                this._selectedItems.add(this._selectionKey(item.name, item.subfolder));
            }
        }
        this._updateSelectionBar();
    }

    _updateSelectionBar() {
        if (this._selectionBar) { this._selectionBar.remove(); this._selectionBar = null; }
        const count = this._selectedItems.size;
        if (count === 0) return;
        const charDir = this.isCharacterDir();
        const bar = $el("div", { className: "neo-gallery-selection-bar" }, [
            $el("span", { className: "neo-gallery-selection-count", textContent: tf("已选 {n} 项", { n: count }) }),
            $el("div", {
                className: "neo-gallery-selection-btn neo-gallery-selection-btn-danger",
                title: t("仅删除勾选的素材，不影响未选中文件"),
                onclick: () => this.deleteSelected()
            }, [t("删除")]),
            $el("div", {
                className: "neo-gallery-selection-btn",
                title: charDir
                    ? t("角色图目录：整批合成一段全参考配方，图片进该段参考图（前 9 张）与 角色参考图，不当关键帧")
                    : t("将选中图片设为分镜图，新建视频导演配方"),
                onclick: () => this.createDirectorFromSelection()
            }, [charDir ? t("新建导演配方（全参考）") : t("新建导演配方")]),
            $el("div", { className: "neo-gallery-selection-btn", onclick: () => this.clearSelection() }, [t("✕ 清空")])
        ]);
        this.element.appendChild(bar);
        this._selectionBar = bar;
    }

    async deleteSelected() {
        const count = this._selectedItems.size;
        if (count === 0) return;
        if (!confirm(tf("删除已选中的 {n} 个素材？此操作不可恢复。", { n: count }))) return;
        const targets = [...this._selectedItems];
        this._selectedItems.clear();
        this._updateSelectionBar();
        let okCount = 0;
        let skipped = 0;
        for (const key of targets) {
            const idx = key.indexOf('\u0000');
            const subfolder = key.slice(0, idx);
            const name = key.slice(idx + 1);
            if (!this.isDeletableItem(name, subfolder)) { skipped += 1; continue; } // 只读源（presets/lora/C站收藏/oss）跳过
            // 逐项静默删除，卡片 DOM 由 deleteItem 自己移除，瀑布流负责重排
            if (await this.deleteItem(name, subfolder, { silent: true })) okCount += 1;
        }
        const attempted = count - skipped;
        if (attempted > 0 && okCount === attempted) {
            showToast(this.app, 'success', t('批量删除完成'), tf("已删除 {n} 个素材", { n: okCount }) + (skipped ? tf("，跳过 {n} 个只读项", { n: skipped }) : ''));
        } else if (okCount > 0) {
            showToast(this.app, 'error', t('部分删除失败'), tf("成功 {ok} / {total}", { ok: okCount, total: attempted }));
        } else if (attempted > 0) {
            showToast(this.app, 'error', t('批量删除失败'), t('没有素材被删除'));
        }
        // deleteItem 已逐项移除卡片 DOM，瀑布流会自己重排。只有整个目录被删空时才重绘父列表，
        // 其余情况整表重绘会刷新页面并丢掉滚动位置。
        if (this.currentView.mode === 'directory' && this._currentDirStructure
            && this.accordion.querySelectorAll('.neo-gallery-thumb-container, .neo-gallery-category-card').length === 0) {
            this.list._saveScrollPosition();
            await this.list.sortAndDisplayImages();
        }
    }

    async createDirectorFromSelection() {
        const images = [];   // [subfolder, name]
        for (const key of this._selectedItems) {
            const idx = key.indexOf('\u0000');
            const subfolder = key.slice(0, idx);
            const name = key.slice(idx + 1);
            if (isImageFile(name)) images.push([subfolder, name]);
        }
        if (!images.length) {
            showToast(this.app, 'warning', t('无可用图片'), t('选中的素材中没有图片，无法创建导演配方'));
            return;
        }
        // 导演编辑器帧一律走 input/ 根目录（/view?subfolder=）：子文件夹里的图先经 copy_to_input 落盘再建配方
        const frames = [];
        for (const [subfolder, name] of images) {
            const fname = subfolder ? await copyGalleryToInput(JSON.stringify({ filename: name, subfolder })) : name;
            if (!fname) {
                showToast(this.app, 'error', t('新建导演配方失败'), tf("无法读取 {name}", { name }));
                return;
            }
            frames.push(fname);
        }
        // 角色图目录：三视图是设定图，当首帧会让视频从设定图开镜 —— 整批合成一段全参考（见 directorDraft）
        const characterDir = this.isCharacterDir();
        const draft = this.directorDraft(frames);
        try {
            await openDirectorEditor(draft);
        } catch (err) {
            showToast(this.app, 'error', t('新建导演配方失败'), String(err.message || err));
            return;
        }
        if (characterDir && frames.length > DIRECTOR_REF_MAX) {
            showToast(this.app, 'warning', t('参考图超出上限'), tf("每段参考图最多 {n} 张，其余 {rest} 张未加入", { n: DIRECTOR_REF_MAX, rest: frames.length - DIRECTOR_REF_MAX }));
        }
        this.clearSelection();
    }

    async handleSearch(searchTerm) {
        searchTerm = searchTerm.toLowerCase();
        this.isSearchActive = searchTerm.length > 0;
        
        // Use list?search_mode=1 to get lightweight searchable data (style + content only, no full txt parsing)
        const resp = await api.fetchApi('/neo_gallery/list?search_mode=1');
        if (!resp.ok) {
            console.error('[Gallery] Search failed: could not fetch search data');
            this.filteredDirectories = [];
            await this.list.sortAndDisplayImages();
            return;
        }
        
        const data = await resp.json();
        this.filteredDirectories = (data.directories || [])
            .map(dir => ({
                ...dir,
                items: (dir.items || []).filter(img =>
                    (img.name && img.name.toLowerCase().includes(searchTerm)) ||
                    (img.style && img.style.toLowerCase().includes(searchTerm)) ||
                    (img.content && img.content.toLowerCase().includes(searchTerm))
                )
            }))
            .filter(d => d.items.length > 0);
        
        this.currentView.mode = 'categories';
        this.currentView.source = null;
        this.currentView.categoryPath = [];
        
        await this.list.sortAndDisplayImages();
    }

    async updateThumbnailSize(newSize) {
        this.maxThumbnailSize = newSize;
        if (this.thumbnailSizeSlider) {
            const slider = this.thumbnailSizeSlider.querySelector("input[type='range']");
            if (slider) slider.value = newSize;
        }
        const grids = document.querySelectorAll('.neo-gallery-category-grid');
        for (const grid of grids) {
            if (grid.offsetParent !== null) {
                setMasonryColumnWidth(grid, cardColumnWidth(this));
                grid.style.setProperty('--neo-card-h', `${getCardHeight(this)}px`);
            }
        }
        await this.list.sortAndDisplayImages();
    }

    async updateLabelDisplay(display) {
        this.displayLabels = display;
        await this.list.sortAndDisplayImages();
    }

    // ====== Prompt Handling ======

    cleanText(text) {
        if (!text) return "";
        text = text.replace(/^[,\s]+|[,\s]+$/g, '');
        text = text.replace(/\s*BREAK\s*(?:,\s*)?/gi, '. ');
        text = text.replace(/\.{2,}/g, '.').replace(/,\s*\./g, '.');
        text = text.replace(/([.,])(?=\S)/g, '$1 ').trim();
        return text;
    }

    getFirstSegment(text) {
        if (!text) return "";
        const segments = text.split(/[.\u3002\uFF01\uFF01\uff1b:\n]+/).filter(s => s.trim());
        if (segments.length === 0) return "";
        let first = segments[0].trim();
        const colonIdx = first.indexOf('\uff1a');
        if (colonIdx > 0) {
            first = first.substring(colonIdx + 1).trim();
        }
        return first.length > 50 ? first.substring(0, 50) + '...' : first;
    }

    parsePromptSections(txtContent) {
        if (!txtContent) return [];
        // 预设 txt 的分节标签常用半角冒号（「画面右侧区域:」），只认全角冒号的话整节正文没有标签；
        // 断句也补上 ？!?;，否则一段问答式正文糊成一行。
        const rawSegments = txtContent.split(/[.\u3002\uff01\uff1f\uff1b;!?;\n]+/).filter(s => s.trim());
        const sections = [];

        for (const rawSeg of rawSegments) {
            const trimmed = rawSeg.trim();
            if (!trimmed) continue;

            const fullColonMatch = trimmed.match(/^(.+?)[:\uff1a](.*)$/s);
            if (fullColonMatch) {
                const beforeColon = fullColonMatch[1].trim();
                const afterColon = fullColonMatch[2].trim();
                const cjkMatch = beforeColon.match(/[\u4e00-\u9fa5]/g);
                const cjkCount = cjkMatch ? cjkMatch.length : 0;

                if (cjkCount > 0 && cjkCount <= 10 && beforeColon.length <= 30) {
                    sections.push({ label: beforeColon, value: afterColon });
                } else {
                    sections.push({ label: null, value: trimmed });
                }
                continue;
            }

            sections.push({ label: null, value: trimmed });
        }

        return sections;
    }

    combineTexts(existing, newText) {
        existing = this.cleanText(existing);
        newText = this.cleanText(newText);
        if (!existing) return newText;
        return existing.endsWith('.') ? existing + ' ' + newText : existing + ', ' + newText;
    }

    // ====== Utility ======

    debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    showToast(severity, summary, detail) {
        showToast(this.app, severity, summary, detail);
    }

    showInlineFeedback(button, message, type) {
        showInlineFeedback(button, message, type);
    }

    displayNoFilesMessage() {
        this.accordion.appendChild($el("div", {
            className: "neo-gallery-no-files-message"
        }, [
            $el("div", { className: "neo-gallery-no-files-message-icon", textContent: "" }),
            $el("p", { className: "neo-gallery-no-files-message-text", textContent: "No presets found. Add images + .txt files to gallery/presets/ or click \u{1F4C1} to add custom directories." })
        ]));
    }

    // ====== Audio Playback ======

    _stopAudio() {
        const player = this._audioPlayer;
        if (player && !player.paused) player.pause();
        const card = this._audioActiveCard;
        if (card) {
            const btn = card.querySelector(".neo-gallery-audio-play-btn");
            if (btn) btn.textContent = "\u25B6";
            if (card._renderAudio) card._renderAudio(0);
            if (card._audioTimeEl) {
                const dur = player && isFinite(player.duration) ? player.duration : 0;
                card._audioTimeEl.textContent = `0:00 / ${this._formatAudioTime(dur)}`;
            }
        }
        this._audioActiveUrl = null;
        this._audioActiveCard = null;
        this._audioActiveBtn = null;
    }

    _onAudioTimeUpdate() {
        const card = this._audioActiveCard;
        if (!card) return;
        const player = this._audioPlayer;
        const dur = isFinite(player.duration) ? player.duration : 0;
        const progress = (dur > 0) ? Math.min(1, player.currentTime / dur) : 0;
        if (card._renderAudio) card._renderAudio(progress);
        if (card._audioTimeEl) {
            card._audioTimeEl.textContent = `${this._formatAudioTime(player.currentTime)} / ${this._formatAudioTime(dur)}`;
        }
    }

    _formatAudioTime(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, "0")}`;
    }

    // ====== Send Menus ======

    async sendLoraToNode(loraPath, target, button) {
        let targetNode = null;
        let targetWidget = null;
        if (target === 'selected') {
            const selKeys = Object.keys(app.canvas.selected_nodes);
            if (selKeys.length > 0) {
                targetNode = app.canvas.selected_nodes[selKeys[0]];
                targetWidget = targetNode?.widgets?.find(w => w.name === 'lora_name');
            }
        } else {
            const [nodeId, , index] = target.split(':');
            targetNode = app.graph.getNodeById(parseInt(nodeId));
            targetWidget = targetNode?.widgets?.[parseInt(index)];
        }
        if (!targetNode || !targetWidget) {
            showToast(this.app, 'error', 'Send Failed', 'Could not find target node/widget.');
            return;
        }
        // LoraLoader combo values use OS separators; lora_path from the gallery is posix.
        const normalized = loraPath.replace(/\//g, '\\');
        const options = targetWidget.options || (targetWidget.options_values || []);
        const matched = Array.isArray(options) ? options.find(o => (o || '').replace(/\\/g, '/') === loraPath.replace(/\\/g, '/')) : null;
        targetWidget.value = matched !== undefined && matched !== null ? matched : normalized;
        if (targetWidget.callback) {
            targetWidget.callback(targetWidget.value);
        } else if (targetNode.onWidgetChanged) {
            targetNode.onWidgetChanged(targetWidget.name, targetWidget.value);
        }
        app.graph.setDirtyCanvas(true, true);
        showInlineFeedback(button, 'Lora Sent!', 'success');
        showToast(this.app, 'success', 'Lora Sent!', `${targetWidget.value} \u2192 ${targetNode.title || 'Node'}`);
    }

    // ====== Main init ======

    async init() {
        await this.loadPluginData();
        
        // Restore gallery state from URL query param on page load
        const params = new URLSearchParams(window.location.search);
        const galleryParam = params.get('gallery');
        if (galleryParam) {
            let dirName, pathSegments;
            const v2Match = galleryParam.match(/^gallery_v2:(.+):(.*)$/);
            if (v2Match) {
                dirName = decodeURIComponent(v2Match[1]);
                const pathStr = v2Match[2];
                pathSegments = pathStr ? pathStr.split('/') : [];
            } else {
                const match = galleryParam.match(/^gallery_(.+?)_(.*)$/);
                if (match) {
                    dirName = match[1];
                    const pathStr = match[2];
                    pathSegments = pathStr ? pathStr.split('/') : [];
                }
            }
            if (dirName) {
                this.currentView.mode = 'directory';
                this.currentView.source = dirName;
                this.currentView.categoryPath = pathSegments;
                // Load gallery data first so breadcrumb can initialize properly
                await this.loadGallery();
                await this.showDirectoryStructure(dirName, pathSegments);
                return; // skip normal init
            }
        }

        // Intercept browser back button when gallery is visible
        window.addEventListener('popstate', (e) => {
            if (!this.isVisible) return;
            if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
            this.navigateHistory(-1).then(handled => {
                if (handled) return;
                if (this.currentView.mode === 'directory' && this.currentView.categoryPath.length > 0) {
                    const parentPath = this.currentView.categoryPath.slice(0, -1);
                    this.showDirectoryStructure(this.currentView.source, parentPath);
                } else {
                    this.showCategoryCards();
                }
            });
        });

        // Intercept keyboard back navigation (Alt+Left, Backspace) - use capture to beat ComfyUI
        window.addEventListener('keydown', (e) => {
            if (!this.isVisible) return;
            if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
            
            if ((e.altKey && e.key === 'ArrowLeft') || (e.ctrlKey && e.key === 'ArrowLeft')) {
                e.preventDefault();
                e.stopPropagation();
                if (this.currentView.mode === 'directory' && this.currentView.categoryPath.length > 0) {
                    const parentPath = this.currentView.categoryPath.slice(0, -1);
                    this.showDirectoryStructure(this.currentView.source, parentPath);
                } else {
                    this.showCategoryCards();
                }
            } else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
                // 多选：Ctrl+A 全选当前视图内可删除素材
                e.preventDefault();
                e.stopPropagation();
                this.selectAllVisible();
            } else if (e.key === 'Escape' && this._selectedItems.size > 0) {
                this.clearSelection();
            } else if (e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                if (this.currentView.mode === 'directory' && this.currentView.categoryPath.length > 0) {
                    const parentPath = this.currentView.categoryPath.slice(0, -1);
                    this.showDirectoryStructure(this.currentView.source, parentPath);
                } else {
                    this.showCategoryCards();
                }
            }
        }, true);
    }

    async loadAndDisplay() {
        releaseLazyThumbnails(this.accordion);
        this.accordion.innerHTML = '';
        const loadingEl = showLoadingOverlay(this.accordion, this.maxThumbnailSize);
        
        // 直接加载（不额外增加延迟）
        // 宿主自己记的目录（applyView 已写进 currentView）优先于上次退出时的全局视图
        const sv = (this.currentView.mode === 'directory' && this.currentView.source)
            ? { mode: 'directory', source: this.currentView.source, categoryPath: [...this.currentView.categoryPath] }
            : this._savedView;
        this._savedView = null;
        if (sv && sv.mode === 'directory' && sv.source) {
            // 并行加载顶层目录和保存的目录结构，避免串行等待
            await Promise.all([
                this.loadGallery(),
                this.showDirectoryStructure(sv.source, sv.categoryPath || [])
            ]);
        } else {
            await this.loadGallery();
            await this.list.sortAndDisplayImages();
            this._recordNavState();
        }

        if (loadingEl.parentNode) loadingEl.remove();
    }

    /**
     * 启动滚动监听器，在每次滚动时自动保存当前位置
     */
    startScrollListener() {
        // 清除旧的监听器
        this.stopScrollListener();
        
        const onScroll = () => {
            if (!this.currentView || !this.currentView.mode) return;
            // 重绘清空内容会让浏览器把 scrollTop 归零并派发 scroll，
            // 这次伪滚动不能覆盖已保存的位置，否则重绘后必然回到顶部。
            if (this._scrollRestoreLock) return;
            
            const key = this.list._getScrollKey();
            if (!key) return;
            
            const scrollContainer = this.list._getScrollContainer();
            let scrollTop = 0;
            if (scrollContainer === window) {
                scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            } else {
                scrollTop = scrollContainer.scrollTop;
            }
            
            // 只在位置变化超过 50px 时保存，避免频繁写入
            const prevValue = this._scrollPositions[key];
            if (prevValue === undefined || Math.abs(scrollTop - prevValue) > 50) {
                this._scrollPositions[key] = scrollTop;
            }
        };
        
        // 监听滚动容器的 scroll 事件
        const scrollContainer = this.list._getScrollContainer();
        if (scrollContainer === window) {
            window.addEventListener('scroll', onScroll, { passive: true });
            this._scrollListener = onScroll;
            this._scrollTarget = window;
        } else {
            scrollContainer.addEventListener('scroll', onScroll, { passive: true });
            this._scrollListener = onScroll;
            this._scrollTarget = scrollContainer;
        }
    }

    stopScrollListener() {
        if (this._scrollListener && this._scrollTarget) {
            this._scrollTarget.removeEventListener('scroll', this._scrollListener);
            this._scrollListener = null;
            this._scrollTarget = null;
        }
    }

}

// ====== Extension Registration =====
app.registerExtension({
    name: "comfy.neo.gallery",
    async setup() {
        const gallery = new NeoGallery(app);
        app.neoGallery = gallery;
        await gallery.init();

        // 允许把 Gallery 卡片图片拖放到画布上的 LoadImage 节点
        attachGalleryNodeDrop();

        app.ui.settings.addSetting({
            id: "Neo Gallery._General.maxThumbnailSize",
            name: "Neo Gallery Max Thumbnail Size",
            type: "slider", attrs: { min: THUMBNAIL_SIZE_MIN, max: THUMBNAIL_SIZE_MAX, step: THUMBNAIL_SIZE_STEP }, defaultValue: THUMBNAIL_SIZE_DEFAULT,
            onChange: (val) => { if (app.neoGallery) app.neoGallery.updateThumbnailSize(val); }
        });

        app.ui.settings.addSetting({
            id: "Neo Gallery._General.displayLabels",
            name: "Neo Gallery Display Image Labels",
            type: "boolean", defaultValue: true,
            onChange: (val) => { if (app.neoGallery) app.neoGallery.updateLabelDisplay(val); }
        });

        // Periodic persistence of scroll positions (every 5 seconds when gallery is visible)
        let _scrollPersistInterval = null;
        
        if (app.extensionManager && app.extensionManager.registerSidebarTab) {
                app.extensionManager.registerSidebarTab({
            id: "neo.gallery",
            icon: "pi pi-images",
            title: t("素材"),
            tooltip: "Neo Gallery",
            type: "custom",
            render: async (el) => gallery.mountTo(el),
            });

            // 视频配方侧边栏
            app.extensionManager.registerSidebarTab({
                id: "neo.recipes",
                icon: "pi pi-box",
                title: t("配方"),
                tooltip: t("Neo Recipes (视频配方)"),
                type: "custom",
                render: async (el) => {
                    el.innerHTML = "";
                    const panel = await getRecipesPanel();
                    if (!el.contains(panel)) el.appendChild(panel);
                },
            });

        }
    },
});
