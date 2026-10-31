/**
 * Gallery List - toolbar controls and breadcrumb navigation
 */
import { $el } from "../../../../scripts/ui.js";
import { api } from "../../../../scripts/api.js";
import { THUMBNAIL_SIZE_MIN, THUMBNAIL_SIZE_MAX, THUMBNAIL_SIZE_STEP, getCardHeight, cardColumnWidth, createBreadcrumbItem, createBreadcrumbSeparator, PAGE_SIZE, sortByMtime, isImageFile, showNoFilesMessage, showToast, releaseLazyThumbnails, KIND_FILTERS, kindLabel } from './gallery-utils.js';
import { attachMasonry } from './gallery-masonry.js';
import { t, tf } from "./js/core/i18n.js";

// Civitai bookmarks virtual dir: identified by a stable key in the backend; "C站收藏" is display-only.
const CIVITAI_DIR_KEY = "civitai_bookmarks";
const CIVITAI_DIR_NAME = t("C站收藏");

export class GalleryList {
    constructor(gallery) {
        this.gallery = gallery;
        this._scrollContainer = null;
    }


    // ====== UI Builders ======

    createSearchInput(gallery) {
        const input = $el("input", {
            type: "text",
            placeholder: "Search prompt images...",
            className: "neo-gallery-search-input"
        });
        input.addEventListener("input", gallery.debounce(() => gallery.handleSearch(input.value), 300));
        return input;
    }

    createThumbnailSizeSlider(gallery) {
        const valueLabel = $el("span", {
            className: "thumbnail-size-value",
            textContent: `${gallery.maxThumbnailSize}px`
        });

        const slider = $el("input", {
            type: "range",
            min: THUMBNAIL_SIZE_MIN,
            max: THUMBNAIL_SIZE_MAX,
            step: THUMBNAIL_SIZE_STEP,
            value: gallery.maxThumbnailSize,
            className: "neo-gallery-thumbnail-slider",
            onchange: () => {
                const val = parseInt(slider.value);
                gallery.updateThumbnailSize(val);
                valueLabel.textContent = `${val}px`;
                gallery.savePluginData({ maxThumbnailSize: val });
            }
        });

        return $el("div", { className: "neo-gallery-slider-row" }, [
            $el("span", { className: "neo-gallery-size-label", textContent: "Size:" }),
            slider,
            valueLabel
        ]);
    }

    createNavButtons(gallery) {
        const backBtn = $el("button", {
            className: "neo-gallery-nav-btn",
            title: t("后退 (Back)"),
            textContent: "\u2190",
            onclick: () => gallery.navigateHistory(-1)
        });
        const forwardBtn = $el("button", {
            className: "neo-gallery-nav-btn",
            title: t("前进 (Forward)"),
            textContent: "\u2192",
            onclick: () => gallery.navigateHistory(1)
        });
        gallery.navBackBtn = backBtn;
        gallery.navForwardBtn = forwardBtn;
        return $el("div", { className: "neo-gallery-nav-group" }, [backBtn, forwardBtn]);
    }

    createCustomDirSettingBtn(gallery) {
        const btn = $el("button", {
            className: "neo-gallery-custom-dir-btn",
            title: "Set custom directory",
            onclick: async () => await gallery.promptAndSetCustomDir(),
            textContent: "+"
        });
        gallery.customDirSettingBtn = btn;
        return btn;
    }

    createRefreshBtn(gallery) {
        const btn = $el("button", {
            className: "neo-gallery-nav-btn",
            title: t("重新扫描（刷新当前视图）"),
            textContent: "\u27f3",
            onclick: async () => {
                btn.disabled = true;
                try {
                    await gallery.refreshCurrent();
                } finally {
                    btn.disabled = false;
                }
            }
        });
        gallery.refreshBtn = btn;
        return btn;
    }
    // ====== Breadcrumb Navigation ======

    createBreadcrumbHome(gallery) {
        return createBreadcrumbItem("⌂", () => gallery.showCategoryCards(), { isHome: true });
    }

    updateBreadcrumb(gallery, pathSegments, sourceName) {
        const breadcrumb = document.getElementById("neo-gallery-breadcrumb");
        if (!breadcrumb) return;

        this._removeSiblingDropdown();

        const rootDirName = gallery.currentView.source || '';
        // The civitai bookmarks virtual dir is identified by a stable key; show its display name.
        const rootLabel = (rootDirName === CIVITAI_DIR_KEY) ? CIVITAI_DIR_NAME : rootDirName;

        if (pathSegments.length === 0 && !sourceName && !rootDirName) {
            breadcrumb.style.display = 'flex';
            breadcrumb.innerHTML = '';
            breadcrumb.appendChild(this.createBreadcrumbHome(gallery));
            return;
        }

        breadcrumb.style.display = 'flex';
        breadcrumb.innerHTML = '';

        breadcrumb.appendChild(this.createBreadcrumbHome(gallery));

        if (rootDirName) {
            breadcrumb.appendChild(createBreadcrumbSeparator());

            if (pathSegments.length > 0) {
                breadcrumb.appendChild(createBreadcrumbItem(rootLabel, () => gallery.showDirectoryStructure(rootDirName, []), { title: rootLabel }));
            } else {
                breadcrumb.appendChild(createBreadcrumbItem(rootLabel, null, { isCurrent: true }));
            }

            for (let i = 0; i < pathSegments.length; i++) {
                breadcrumb.appendChild(createBreadcrumbSeparator());

                if (i === pathSegments.length - 1) {
                    const currentSegmentEl = createBreadcrumbItem(pathSegments[i], null, { isCurrent: true, title: tf("{seg}\n点击显示同级目录", { seg: pathSegments[i] }) });
                    currentSegmentEl.classList.add('neo-gallery-breadcrumb-sibling-trigger');
                    currentSegmentEl.onclick = (e) => {
                        e.stopPropagation();
                        this._toggleSiblingDropdown(gallery, e, rootDirName, pathSegments);
                    };
                    breadcrumb.appendChild(currentSegmentEl);
                } else {
                    breadcrumb.appendChild(createBreadcrumbItem(pathSegments[i], () => gallery.showDirectoryStructure(rootDirName, pathSegments.slice(0, i + 1)), { title: pathSegments[i] }));
                }
            }

            if (pathSegments.length > 0) {
                breadcrumb.appendChild(createBreadcrumbItem("\u21A9", () => gallery.showDirectoryStructure(rootDirName, pathSegments.slice(0, -1)), { isUp: true, title: t("上一级") }));
            } else {
                // Show back button for root directory of custom dir
                breadcrumb.appendChild(createBreadcrumbItem("\u21A9", () => gallery.showCategoryCards(), { isUp: true, title: t("返回上级") }));
            }
        } else if (sourceName) {
            breadcrumb.appendChild(createBreadcrumbSeparator());
            breadcrumb.appendChild(createBreadcrumbItem(sourceName, null, { isCurrent: true }));

            if (pathSegments.length > 0 || sourceName) {
                breadcrumb.appendChild(createBreadcrumbItem("\u21A9", () => gallery.showCategoryCards(), { isUp: true, title: t("返回上级") }));
            }
        }
    }

    // ====== 虚拟归类快捷筛选（顶部标签栏） ======

    createKindBar(gallery) {
        const bar = $el("div", { className: "neo-gallery-kind-bar", style: { display: "none" } });
        gallery.kindBar = bar;
        return bar;
    }

    /** 按当前计数与视图重绘标签栏：一种素材也没有的标签不进栏里，两种以下的标签整排都不出。 */
    renderKindBar(gallery) {
        const bar = gallery.kindBar;
        if (!bar) return;
        const counts = gallery.kindCounts || {};
        const usable = KIND_FILTERS.filter((f) => (counts[f.key] || 0) > 0);
        if (usable.length < 2) {
            bar.innerHTML = "";
            bar.style.display = "none";
            return;
        }
        bar.innerHTML = "";
        const active = gallery.currentView.mode === 'kind' ? gallery.currentView.source : null;
        bar.appendChild($el("button", {
            className: "neo-gallery-kind-chip" + (active ? "" : " active"),
            textContent: t("全部"),
            title: t("回到目录卡首页"),
            onclick: () => gallery.showCategoryCards()
        }));
        for (const filter of usable) {
            const label = kindLabel(filter.key);
            bar.appendChild($el("button", {
                className: "neo-gallery-kind-chip" + (active === filter.key ? " active" : ""),
                textContent: `${label} ${counts[filter.key]}`,
                title: tf("{label}：全库这一类的条数，点开只看这一类", { label }),
                onclick: () => gallery.showKindView(filter.key)
            }));
        }
        bar.style.display = "";
    }

    updateKindBreadcrumb(gallery, label) {
        const breadcrumb = document.getElementById("neo-gallery-breadcrumb");
        if (!breadcrumb) return;
        this._removeSiblingDropdown();
        breadcrumb.style.display = 'flex';
        breadcrumb.innerHTML = '';
        breadcrumb.appendChild(this.createBreadcrumbHome(gallery));
        breadcrumb.appendChild(createBreadcrumbSeparator());
        breadcrumb.appendChild(createBreadcrumbItem(label, null, { isCurrent: true }));
        breadcrumb.appendChild(createBreadcrumbItem("\u21A9", () => gallery.showCategoryCards(), { isUp: true, title: t("返回上级") }));
    }

    /**
     * 归类视图铺瀑布流。条目是后端全库聚合出来的，每条已经带上首页一致的目录名前缀
     * subfolder（"Output/Pose"、"Lora/detail"），所以不走 renderImagesFromStructure 的
     * 目录名兜底，卡片寻址、缩略图、拖进节点全部照现有那一条路走。
     */
    renderKindItems(items, truncated) {
        if (!items.length) {
            this.gallery._currentDirImages = [];
            showNoFilesMessage(this.gallery.accordion, t("这一类还没有素材"));
            return;
        }
        this.renderImagesFromStructure(items, "", []);
        if (truncated) {
            this.gallery.accordion.appendChild($el("div", {
                className: "neo-gallery-kind-hint",
                textContent: tf("只列了前 {n} 条，这一类还有更多：继续滚动加载，或按目录卡片浏览", { n: items.length })
            }));
        }
    }

    // ====== Sibling Directory Dropdown ======

    _removeSiblingDropdown() {
        const existing = document.getElementById('neo-gallery-sibling-dropdown');
        if (existing) existing.remove();
    }

    async _toggleSiblingDropdown(gallery, event, rootDirName, pathSegments) {
        this._removeSiblingDropdown();

        const trigger = event.currentTarget;
        if (trigger.classList.contains('neo-gallery-breadcrumb-sibling-trigger')) {
            const existingDropdown = document.getElementById('neo-gallery-sibling-dropdown');
            if (existingDropdown) {
                existingDropdown.remove();
                return;
            }
        }

        const parentPath = pathSegments.slice(0, -1);

        let siblings = [];
        try {
            const resp = await api.fetchApi(`/neo_gallery/list?fields=dirs&dir_name=${encodeURIComponent(rootDirName)}&path=${encodeURIComponent(parentPath.join("/"))}`);
            if (resp.ok) {
                const data = await resp.json();
                const structure = data.directories[0] || {};
                // /neo_gallery/list returns subdirs as object {name: {image_count, path}}
                siblings = Object.keys(structure.subdirs || {}).map(name => ({ name, path: [...parentPath, name] }));
            }
        } catch (e) {
            console.error('[Gallery] Error fetching sibling directories:', e);
        }

        if (siblings.length === 0) return;

        const dropdown = $el("div", {
            id: "neo-gallery-sibling-dropdown",
            className: "neo-galleryibling-dropdown"
        });

        const rect = event.target.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = (rect.bottom + 4) + 'px';
        dropdown.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
        dropdown.style.zIndex = '9999';

        const listContainer = $el("div", { className: "neo-gallery-sibling-list" });

        for (const sib of siblings) {
            const item = $el("div", {
                className: "neo-gallery-sibling-item",
                onclick: (e) => {
                    e.stopPropagation();
                    this._removeSiblingDropdown();
                    gallery.showDirectoryStructure(rootDirName, sib.path);
                },
                textContent: sib.name
            });

            item.onmouseenter = () => item.classList.add('neo-gallery-sibling-item-hover');
            item.onmouseleave = () => item.classList.remove('neo-gallery-sibling-item-hover');

            listContainer.appendChild(item);
        }

        dropdown.appendChild(listContainer);
        document.body.appendChild(dropdown);

        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== trigger) {
                this._removeSiblingDropdown();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }
    async sortAndDisplayImages() {
        // Clear cached scroll container reference before clearing DOM
        this._scrollContainer = null;
        // 清空 DOM 会让浏览器把 scrollTop 归零并派发 scroll，锁住自动保存，恢复完再放开
        this.gallery._scrollRestoreLock = true;
        releaseLazyThumbnails(this.gallery.accordion);
        this.gallery.accordion.innerHTML = "";
        // 首页目录卡与搜索结果都不是归类视图：标签栏的「全部」跟着这次重绘亮起来
        this.renderKindBar(this.gallery);

        const dirsToDisplay = this.gallery.isSearchActive ? this.gallery.filteredDirectories : this.gallery.allDirectories;

        if (this.gallery.currentView.mode === 'civitai_bookmarks') {
            await this.gallery._renderCivitaiBookmarks(false, this.gallery._civitaiPage || 0);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this._restoreScrollPosition();
                });
            });
            return;
        }

        if (this.gallery.currentView.mode === 'local_bookmarks') {
            await this.gallery._renderLocalBookmarks();
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this._restoreScrollPosition();
                });
            });
            return;
        }

        if (this.gallery.currentView.mode === 'directory' && this.gallery._currentDirStructure) {
            this.renderDirectoryStructure(this.gallery._currentDirStructure, this.gallery.currentView.source, this.gallery.currentView.categoryPath);
            // Restore scroll position after directory rendering
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this._restoreScrollPosition();
                });
            });
            return;
        }

        if (this.gallery.currentView.mode === 'images') {
            this.renderExpandedImages();
            // Restore scroll position after images rendering
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this._restoreScrollPosition();
                });
            });
            return;
        }

        // In lazy mode, count dirs with subdirs, root_count or pending lora fetches
        const totalDirs = dirsToDisplay.filter(d => 
            (d.subdirs && Object.keys(d.subdirs).length > 0) || (d.root_count && d.root_count > 0) || d.pending
        ).length;

        // 非搜索视图总有「本地收藏」首页卡，所以只有搜索无命中时才提示空结果。
        if (totalDirs === 0 && this.gallery.isSearchActive) {
            showNoFilesMessage(this.gallery.accordion, "No matching images found");
            this.gallery._scrollRestoreLock = false;
            return;
        }

        const cardContainer = await this.createCategoryCardGrid(dirsToDisplay);
        if (cardContainer) {
            this.gallery.accordion.appendChild(cardContainer);
        }

        // Setup IntersectionObserver for lazy-loading cover images on directory cards
        this._setupCoverLazyLoad();

        // Restore scroll position after rendering completes
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this._restoreScrollPosition();
            });
        });
    }

    async createCategoryCardGrid(dirGroups) {
        const container = $el("div", {
            className: "neo-gallery-category-grid",
            style: { '--neo-card-h': `${getCardHeight(this.gallery)}px` }
        });
        attachMasonry(container, cardColumnWidth(this.gallery));

        // Collect workflow-used loras once for the smart filter (only lora dirs are filtered).
        const usedLoras = this.gallery.workflowMatchActive ? this.gallery.collectUsedLoras() : null;

        const _renderDirCard = async (dir) => {
            const hasContent = (dir.subdirs && Object.keys(dir.subdirs).length > 0) ||
                               (dir.root_count && dir.root_count > 0) ||
                               dir.pending;
            if (!hasContent) return;

            if (usedLoras && dir.path && String(dir.path).toLowerCase().startsWith('lora/') && dir.lora_path) {
                if (!usedLoras.has(dir.lora_path.replace(/\\/g, '/'))) return;
            }

            const isPresets = dir.name.toLowerCase() === 'presets';
            const displayItems = isPresets ? [] : (dir.items || []);

            const card = await this.gallery.card.createDirCard(this.gallery, dir.name, dir.path, displayItems, dir.subdirs, dir.source, dir);
            container.appendChild(card);
        };

        // 统一顺序表渲染：内置卡（Output / Input / 收藏 / Lora）与自定义目录同表排序。
        const order = this.gallery.homeOrder.length ? this.gallery.homeOrder
            : ["Output", "Input", "local_bookmarks", "civitai_bookmarks", ...dirGroups.map((d) => d.name), "Lora"];
        const hidden = this.gallery.hiddenHomeEntries;
        const byName = new Map();
        for (const dir of dirGroups) {
            const key = dir.name.toLowerCase();
            if (!byName.has(key)) byName.set(key, dir);
        }
        const slots = [];
        const usedDirs = new Set();
        const pushDir = (dir) => {
            if (dir && !usedDirs.has(dir)) { usedDirs.add(dir); slots.push({ dir }); }
        };

        for (const token of order) {
            const key = String(token).toLowerCase();
            if (hidden.has(key)) continue;
            if (key === "local_bookmarks") {
                if (!this.gallery.isSearchActive) slots.push({ local: true });
                continue;
            }
            if (key === "civitai_bookmarks") {
                if (this.gallery.civitaiBookmarkEnabled && !this.gallery.isSearchActive) slots.push({ civitai: true });
                continue;
            }
            if (key === "lora") {
                for (const dir of dirGroups) {
                    const n = dir.name.toLowerCase();
                    if (n === "lora" || n.startsWith("lora/")) pushDir(dir);
                }
                continue;
            }
            pushDir(byName.get(String(token).split(/[\\/]/).pop().toLowerCase()));
        }
        // 顺序表之外的条目（presets 子目录、OSS 目录等）保持原顺序
        for (const dir of dirGroups) pushDir(dir);

        for (const slot of slots) {
            if (slot.local) container.appendChild(this.gallery._createLocalHomeCard());
            else if (slot.civitai) container.appendChild(this.gallery._createCivitaiHomeCard());
            else await _renderDirCard(slot.dir);
        }

        return container;
    }

// ====== View Rendering ======

    async renderDirectoryStructure(structure, dirName, pathSegments) {
        releaseLazyThumbnails(this.gallery.accordion);
        this.gallery.accordion.innerHTML = "";
        
        // New structure: { subdirs: object, items: array, root_count: number }
        const { subdirs, items, root_count } = structure;
        
        // Convert items to images for compatibility
        const imageArray = items || [];
        // Convert subdirs object to array for compatibility (keep pending/lora metadata)
        const subdirArray = Object.keys(subdirs || {}).map(name => ({
            name,
            path: subdirs[name].path || name,
            image_count: subdirs[name].image_count || 0,
            pending: subdirs[name].pending || false,
            lora_path: subdirs[name].lora_path || null,
            model_name: subdirs[name].model_name || "",
            base_model: subdirs[name].base_model || "",
            civitai: subdirs[name].civitai || null,
            // 注入的云端预设入口（主目录下的 Cloud Presets）靠 path 导航
            source: subdirs[name].source || "",
            read_only: subdirs[name].read_only || false
        }));

        // Include pending lora subdirs (queued/running/failed) even with no cached images yet.
        const nonEmptySubdirs = subdirArray.filter(s => s.image_count > 0 || s.pending);
        const hasSubdirs = nonEmptySubdirs.length > 0;
        
        if (hasSubdirs) {
            this.renderSubdirCards(structure, dirName, pathSegments, nonEmptySubdirs);
        } else if (imageArray.length > 0) {
            this.renderImagesFromStructure(imageArray, dirName, pathSegments);
        } else if (root_count && root_count > 0) {
            // Lazy-loaded: has images but no image data yet — fetch them now
            await this._fetchLazyImages(structure, dirName, pathSegments);
            return; // Don't show anything yet, _fetchLazyImages will render
        } else if (structure.pending) {
            const st = structure.civitai || {};
            let message, cls;
            if (st.needs_api_key) {
                message = t("需要在「Manage Directories」中配置 C 站 API KEY 才能获取示例图。");
                cls = "pending-warn";
            } else if (st.status === 'not_found') {
                message = "This lora was not found on Civitai.";
                cls = "pending-failed";
            } else if (st.status === 'failed') {
                message = tf("抓取失败：{err}", { err: st.error || 'unknown error' });
                if (st.error && st.error.includes("无法连接")) {
                    message += t(" · 可在「Manage Directories」中点「测试 C 站连通性」排查（C 站需要代理或可直连的网络）");
                }
                cls = "pending-failed";
            } else {
                message = "Fetching examples from Civitai... this directory will refresh automatically.";
                cls = "";
            }
            this.gallery.accordion.appendChild($el("div", {
                className: "neo-gallery-pending-message" + (cls ? " " + cls : ""),
                textContent: message
            }));
        } else {
            showNoFilesMessage(this.gallery.accordion, "No images found in this folder");
        }
    }

    async renderSubdirCards(structure, dirName, pathSegments, filteredSubdirs = null) {
        // New structure: { subdirs: object, items: array, root_count: number }
        const { subdirs, items, root_count } = structure;
        const dir = this.gallery.allDirectories.find(d => d.name === dirName || d.path === dirName);

        // Use filtered subdirs if provided (non-empty only), otherwise use all
        const displaySubdirs = filteredSubdirs || Object.keys(subdirs || {});

        let subdirArray = Array.isArray(displaySubdirs)
            ? displaySubdirs
            : Object.keys(subdirs || {}).map(name => ({ name, path: subdirs[name].path || name, image_count: subdirs[name].image_count || 0 }));

        // Smart workflow filter for the Lora section: only active when the user
        // manually enables it. Jumping to a used lora highlights the card instead.
        const isLoraView = String(dirName).toLowerCase().startsWith('lora');
        const jumpTarget = this.gallery._jumpTargetPath || null;
        this.gallery._jumpTargetPath = null;
        if (isLoraView && this.gallery.workflowMatchActive) {
            const usedLoras = this.gallery.collectUsedLoras();
            if (usedLoras.size > 0) {
                const beforeFilter = subdirArray;
                subdirArray = subdirArray.filter(s => {
                    const loraPath = (s.lora_path || '').replace(/\\/g, '/');
                    return !loraPath || usedLoras.has(loraPath);
                });
                // The used lora may not have cached examples yet (not_found / pending),
                // so nothing matches here. Show the whole directory instead of an
                // empty page so the jump is never a dead end.
                if (subdirArray.length === 0) {
                    subdirArray = beforeFilter;
                }
            }
        }

        const container = $el("div", {
            className: "neo-gallery-category-grid",
            style: { '--neo-card-h': `${getCardHeight(this.gallery)}px` }
        });
        attachMasonry(container, cardColumnWidth(this.gallery));

        if (isLoraView) {
            const usedCount = this.gallery.collectUsedLoras().size;
            const filterBar = $el("div", { className: "neo-gallery-workflow-filter" }, [
                $el("span", { className: "neo-gallery-workflow-filter-label", textContent: t("智能感知:") }),
                $el("button", {
                    className: "neo-gallery-workflow-chip" + (!this.gallery.workflowMatchActive ? " active" : ""),
                    onclick: () => { if (this.gallery.workflowMatchActive) this.gallery.toggleWorkflowMatch(); }
                }, [t("全部")]),
                $el("button", {
                    className: "neo-gallery-workflow-chip" + (this.gallery.workflowMatchActive ? " active" : ""),
                    onclick: () => this.gallery._jumpToUsedLora()
                }, [tf("工作流已用 ({n})", { n: usedCount })])
            ]);
            this.gallery.accordion.appendChild(filterBar);
        }

        for (const subdir of subdirArray) {
            const subdirName = typeof subdir === 'string' ? subdir : subdir.name;
            // Injected OSS preset cards under Grid / Character carry an explicit nav
            // path ("presets"); regular subdirs navigate by their display name.
            const subdirSeg = (subdir && subdir.source === 'oss' && subdir.path) ? subdir.path : subdirName;
            const fullPath = [...pathSegments, subdirSeg];
            
            const card = await this.gallery.card.createSubdirCard(this.gallery, subdirName, dirName, fullPath, subdir);
            if (jumpTarget) {
                const cardLora = ((subdir && subdir.lora_path) || '').replace(/\\/g, '/');
                if (cardLora === jumpTarget) {
                    card.classList.add('neo-gallery-card-jump-highlight');
                }
            }
            container.appendChild(card);
        }
        
        // 目录卡与图片卡共用同一个瀑布流容器：DOM 顺序保证目录卡在前，
        // 最短列装箱让图片卡接着填满目录卡参差不齐的底边，衔接处不留空。
        this.gallery.accordion.appendChild(container);
        
        // Only show images section if we have actual image data (not lazy-loaded)
        if (items && items.length > 0) {
            
            let currentSubfolder;
            if (pathSegments.length > 0) {
                currentSubfolder = dirName + "/" + pathSegments.join("/");
            } else {
                currentSubfolder = dirName;
            }
            
            // Use render queue for lazy loading
            this.gallery._renderQueue = [...sortByMtime(items)];
            this.gallery._renderedCount = 0;
            
            const renderPage = (count) => {
                for (let i = 0; i < count && this.gallery._renderQueue.length > 0; i++) {
                    const item = this.gallery._renderQueue.shift();
                    const itemSubfolder = item.subfolder || currentSubfolder;
                    const itemWithSubfolder = {...item, subfolder: itemSubfolder};
                    const imgEl = this.gallery.card.createImageElement(this.gallery, itemWithSubfolder, itemSubfolder, (dir && dir.source) || "");
                    container.appendChild(imgEl);
                }
                this.gallery._renderedCount += count;
            };
            
            // Render first page
            renderPage(PAGE_SIZE);
            
            // Setup auto-load if there are more images
            if (this.gallery._renderQueue.length > 0) {
                this._setupAutoLoad(container, renderPage);
            }
            
            // Save images for lightbox navigation (lazy mode fallback)
            this.gallery._currentDirImages = [...sortByMtime(items)];
        }
    }

    renderImagesFromStructure(images, dirName, pathSegments) {
        let subfolder;
        if (pathSegments.length > 0) {
            subfolder = dirName + "/" + pathSegments.join("/");
        } else {
            subfolder = dirName;
        }
        const dir = this.gallery.allDirectories.find(d => d.name === dirName || d.path === dirName);

        if (images.length === 0) {
            showNoFilesMessage(this.gallery.accordion, "No images found in this folder");
            return;
        }

        const sortedItems = sortByMtime(images);
        this.gallery._renderQueue = [...sortedItems];
        this.gallery._renderedCount = 0;
        
        const imageGrid = $el("div", { className: "neo-gallery-image-grid neo-gallery-expanded-images" });
        attachMasonry(imageGrid, cardColumnWidth(this.gallery));
        
        const renderPage = (count) => {
            for (let i = 0; i < count && this.gallery._renderQueue.length > 0; i++) {
                const item = this.gallery._renderQueue.shift();
                // Use item's subfolder if available, otherwise use the current subfolder
                const itemSubfolder = item.subfolder || subfolder;
                // Add subfolder to item so it's available when sending
                const itemWithSubfolder = {...item, subfolder: itemSubfolder};
                const el = this.gallery.card.createImageElement(this.gallery, itemWithSubfolder, itemSubfolder, (dir && dir.source) || "");
                if (!isImageFile(item.filename)) {
                    el.style.width = `${this.gallery.maxThumbnailSize}px`;
                }
                imageGrid.appendChild(el);
            }
            this.gallery._renderedCount += count;
        };

        this.gallery.accordion.appendChild(imageGrid);
        renderPage(PAGE_SIZE);
        
        // Save images for lightbox navigation (lazy mode fallback)
        this.gallery._currentDirImages = [...sortedItems];
        
        // 滚动到底部自动加载
        if (this.gallery._renderQueue.length > 0) {
            this._setupAutoLoad(imageGrid, renderPage);
        }
    }

    renderExpandedImages() {
        const { source, categoryPath } = this.gallery.currentView;
        
        let items = [];
        let subfolder = source;

        const dir = this.gallery.allDirectories.find(d => d.name === source || d.path === source);
        // In lazy mode, dir.items is undefined - use _currentDirImages as fallback
        const dirItems = (dir && Array.isArray(dir.items)) ? dir.items : [];
        if (dir) {
            subfolder = source;
            if (categoryPath.length > 0) {
                const catKey = categoryPath[0];
                items = dirItems.filter(i => i.category === catKey || !i.category);
            } else {
                items = [...dirItems];
            }
        }

        // Fallback to _currentDirImages if dir.items is empty (lazy mode)
        if (items.length === 0 && this.gallery._currentDirImages && this.gallery._currentDirImages.length > 0) {
            items = [...this.gallery._currentDirImages];
        }

        if (items.length === 0) {
            showNoFilesMessage(this.gallery.accordion, "No images found in this category");
            return;
        }

        const sortedItems = sortByMtime(items);
        this.gallery._renderQueue = [...sortedItems];
        this.gallery._renderedCount = 0;
        
        const imageGrid = $el("div", { className: "neo-gallery-image-grid neo-gallery-expanded-images" });
        attachMasonry(imageGrid, cardColumnWidth(this.gallery));
        
        const renderPage = (count) => {
            for (let i = 0; i < count && this.gallery._renderQueue.length > 0; i++) {
                const item = this.gallery._renderQueue.shift();
                // Add subfolder to item so it's available when sending
                const itemWithSubfolder = {...item, subfolder: subfolder};
                const el = this.gallery.card.createImageElement(this.gallery, itemWithSubfolder, subfolder, dir.source || "");
                if (!isImageFile(item.filename)) {
                    el.style.width = `${this.gallery.maxThumbnailSize}px`;
                }
                imageGrid.appendChild(el);
            }
            this.gallery._renderedCount += count;
        };

        this.gallery.accordion.appendChild(imageGrid);
        renderPage(PAGE_SIZE);
        
        // Save images for lightbox navigation (lazy mode fallback)
        this.gallery._currentDirImages = [...sortedItems];
        
        // 滚动到底部自动加载
        if (this.gallery._renderQueue.length > 0) {
            this._setupAutoLoad(imageGrid, renderPage);
        }
    }

// ====== Lazy Pagination & Cover Loading ======

    async _fetchLazyImages(structure, dirName, pathSegments) {
        // Fetch full image list using /neo_gallery/list with dir_name parameter
        const relPath = pathSegments.join("/");
        
        try {
            // Use /neo_gallery/list with dir_name to get specific directory data
            const listResp = await api.fetchApi(`/neo_gallery/list?fields=items&dir_name=${encodeURIComponent(dirName)}&path=${encodeURIComponent(relPath)}`);
            if (!listResp.ok) throw new Error(`HTTP ${listResp.status}`);
            
            const listData = await listResp.json();
            
            // Get the directory from response
            const matchedDir = listData.directories[0];
            
            if (matchedDir && matchedDir.items) {
                this.renderImagesFromStructure(matchedDir.items, dirName, pathSegments);
                return;
            }
            
            // Fallback: show no files message
            showNoFilesMessage(this.gallery.accordion, "No images found in this folder");
        } catch (error) {
            console.error('[Gallery] Error loading directory structure:', error);
            showToast(this.gallery.app, 'error', 'Error', 'Failed to load directory structure');
        }
    }

    _setupAutoLoad(container, renderPage) {
        // 移除旧的监听器 - 使用闭包保存的旧容器引用
        if (this._autoLoadScrollHandler && this._currentScrollContainer) {
            const oldContainer = this._currentScrollContainer;
            if (oldContainer === window) {
                window.removeEventListener('scroll', this._autoLoadScrollHandler);
            } else {
                oldContainer.removeEventListener('scroll', this._autoLoadScrollHandler);
            }
        }
        
        const threshold = 300; // 距离底部多少像素时触发加载
        const scrollContainer = this._getScrollContainer();
        
        // 保存容器引用到闭包中，避免后续查找错误元素
        this._currentScrollContainer = scrollContainer;
        
        this._autoLoadScrollHandler = () => {
            const currentContainer = this._currentScrollContainer || this._getScrollContainer();
            const scrollTop = currentContainer === window 
                ? window.pageYOffset || document.documentElement.scrollTop 
                : currentContainer.scrollTop;
            const viewHeight = currentContainer === window 
                ? window.innerHeight 
                : currentContainer.clientHeight;
            const docHeight = currentContainer === window 
                ? document.documentElement.scrollHeight 
                : currentContainer.scrollHeight;
            
            // 当滚动到距离底部 threshold 像素时触发加载
            if (scrollTop + viewHeight >= docHeight - threshold) {
                if (this.gallery._renderQueue.length > 0) {
                    renderPage(PAGE_SIZE);
                    if (this.gallery._renderQueue.length > 0) {
                        this._setupAutoLoad(container, renderPage);
                    }
                }
            }
        };
        if (scrollContainer === window) {
            window.addEventListener('scroll', this._autoLoadScrollHandler);
        } else {
            scrollContainer.addEventListener('scroll', this._autoLoadScrollHandler);
        }
    }

    /**
     * Setup IntersectionObserver for lazy-loading cover images on directory cards.
     * Only loads covers when cards scroll into the viewport.
     */
    _setupCoverLazyLoad() {
        // Disconnect old observer if exists
        if (this._coverLazyObserver) {
            this._coverLazyObserver.disconnect();
        }

        const options = {
            root: null, // viewport
            rootMargin: '200px', // Start loading 200px before card enters viewport
            threshold: 0.1
        };

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const card = entry.target;
                    const dirName = card.dataset.lazyCovers;
                    
                    if (dirName && !card.dataset._lazyLoaded) {
                        // Mark as loaded to avoid duplicate requests
                        card.dataset._lazyLoaded = 'true';
                        
                        // Get the coverWrapper - skeleton is applied directly on it
                        const coverWrapper = card._coverWrapper || card.querySelector('.neo-gallery-card-cover-wrapper');
                        if (coverWrapper) {
                            // Remove skeleton shimmer by clearing inline styles and loading covers
                            this.gallery.card._applyCoverImages(card, coverWrapper, this.gallery, dirName, dirName);
                        }
                    }
                    
                    observer.unobserve(card);
                }
            }
        }, options);

        // Observe all directory cards with lazy data attribute
        const cards = document.querySelectorAll('.neo-gallery-category-card[data-lazy-covers]');
        for (const card of cards) {
            observer.observe(card);
        }

        this._coverLazyObserver = observer;
    }

// ====== Scroll Position Memory ======

    _getScrollKey() {
        if (this.gallery.currentView.mode === 'directory' && this.gallery.currentView.source) {
            return `gallery_v2:${encodeURIComponent(this.gallery.currentView.source)}:${this.gallery.currentView.categoryPath.join('/')}`;
        }
        // 归类视图与 URL 深链同名：每个标签各记自己的滚动位置，回退时不落到首页的位置上
        if (this.gallery.currentView.mode === 'kind' && this.gallery.currentView.source) {
            return `gallery_kind:${this.gallery.currentView.source}`;
        }
        return 'gallery_categories';
    }

    _getScrollContainer() {
        if (this._scrollContainer) {
            return this._scrollContainer;
        }
        
        // 尝试多种可能的滚动容器选择器（按优先级排序）
        const selectors = [
            // ComfyUI sidebar-content-container: 实际的侧边栏滚动容器（最常见）
            '.sidebar-content-container',
            // Tailwind CSS: ComfyUI 主内容区滚动容器
            '.size-full.overflow-x-hidden.overflow-y-auto',
            // ComfyUI v1.3.x+ sidebar panel (flex layout)
            '[id="side-bar-panel"]',
            '.p-splitterpanel.side-bar-panel',
            // ComfyUI 侧边栏相关
            '#comfy-sidebar',
            '.comfy-sidebar',
            '.comfy-menu',
            '.sidebar',
            // 通用选择器
            '[role="complementary"]',
        ];
        
        for (const selector of selectors) {
            const container = document.querySelector(selector);
            if (container && (container.scrollHeight > container.clientHeight || container === document.body)) {
                this._scrollContainer = container;
                return container;
            }
        }
        
        // 回退：使用 window
        const parent = this.gallery.element?.parentElement;
        if (parent) {
            let current = parent;
            while (current && current !== document.body && current !== document.documentElement) {
                const style = window.getComputedStyle(current);
                
                if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') {
                    const canScroll = current.scrollHeight > current.clientHeight + 10;
                    
                    if (canScroll) {
                        this._scrollContainer = current;
                        return current;
                    } else {
                        if (!this._scrollContainer) {
                            this._scrollContainer = current;
                        }
                    }
                }
                current = current.parentElement;
            }
            
            if (this._scrollContainer) {
                return this._scrollContainer;
            }
        }
        
        return window;
    }

    _saveScrollPosition() {
        const key = this._getScrollKey();
        if (key) {
            const scrollContainer = this._getScrollContainer();
            const scrollTop = scrollContainer === window 
                ? window.pageYOffset || document.documentElement.scrollTop 
                : scrollContainer.scrollTop;
            this.gallery._scrollPositions[key] = scrollTop;
            
            // 异步持久化，不阻塞渲染
            this.gallery.savePluginData({ scrollPositions: this.gallery._scrollPositions }).catch(err => {
                console.warn('[Neo Gallery] Failed to persist scroll position:', err);
            });
        }
    }

    /**
     * 保存当前视图的滚动位置（用于视图切换前）
     */
    async _saveCurrentScrollPosition() {
        const currentKey = this._getScrollKey();
        if (!currentKey) return;
        
        // 清除缓存的滚动容器引用，确保获取最新的
        this._scrollContainer = null;
        const scrollContainer = this._getScrollContainer();
        
        let scrollTop = 0;
        if (scrollContainer === window) {
            scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        } else {
            // Neo Gallery 内容在 .sidebar-content-container 内部滚动，使用容器的 scrollTop
            scrollTop = scrollContainer.scrollTop;
        }
        
        this.gallery._scrollPositions[currentKey] = scrollTop;
        
        // 立即持久化
        try {
            await this.gallery.savePluginData();
        } catch (err) {
            console.error('[Neo Gallery] [_saveCurrentScrollPosition] Failed to persist:', err);
        }
    }

    _restoreScrollPosition() {
        const done = () => { this.gallery._scrollRestoreLock = false; };
        const key = this._getScrollKey();
        if (!key) return done();
        
        // 修复：使用 'in' 检查 key 是否存在，而不是 !this.gallery._scrollPositions[key]（因为值可能是 0）
        if (!(key in this.gallery._scrollPositions)) {
            return done();
        }
        
        const targetScrollTop = this.gallery._scrollPositions[key];
        
        // 使用多次 requestAnimationFrame + setTimeout 确保 DOM 完全渲染后再恢复滚动位置
        const restore = () => {
            const scrollContainer = this._getScrollContainer();
            
            if (scrollContainer === window) {
                window.scrollTo(0, targetScrollTop);
            } else {
                const windowScrollTop = window.pageYOffset || document.documentElement.scrollTop;
                if (scrollContainer.scrollTop === 0 && windowScrollTop > 0) {
                    window.scrollTo(0, targetScrollTop);
                } else if (scrollContainer.scrollHeight > scrollContainer.clientHeight) {
                    const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
                    scrollContainer.scrollTop = Math.min(targetScrollTop, maxScroll);
                } else {
                    return false;
                }
            }
            return true;
        };
        
        // 延迟恢复以确保 DOM 完全渲染
        setTimeout(() => {
            const scrollContainer = this._getScrollContainer();
            if (scrollContainer === window) {
                window.scrollTo(0, targetScrollTop);
                done();
            } else if (scrollContainer.scrollHeight > scrollContainer.clientHeight) {
                const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
                scrollContainer.scrollTop = Math.min(targetScrollTop, maxScroll);
                done();
            } else {
                // 容器尚未就绪，稍后重试
                setTimeout(() => { restore(); done(); }, 300);
            }
        }, 100);
    }

    // Aggregate the media entries navigable by the lightbox for the current view:
    // inside a directory, that directory's images; otherwise all loaded directories.
    collectLightboxMedia(image, subfolder) {
        const gallery = this.gallery;
        const allImages = [];
        const collectAllDirs = () => {
            for (const dir of gallery.allDirectories) {
                if (!gallery.isSearchActive || gallery.filteredDirectories.some(d => d.name === dir.name)) {
                    for (const item of (dir.items || [])) allImages.push({ ...item, subfolder: dir.name });
                }
            }
        };

        const { source, categoryPath, mode } = gallery.currentView;
        if (mode !== 'categories' && source) {
            const dir = gallery.allDirectories.find(d => d.name === source || d.path === source);
            let dirItems = [];
            if (dir?.items?.length > 0) {
                dirItems = [...dir.items];
            } else if (gallery._currentDirImages?.length > 0) {
                dirItems = [...gallery._currentDirImages];
            }
            if (categoryPath?.length > 0) {
                const catKey = categoryPath[0];
                dirItems = dirItems.filter(i => i.category === catKey || !i.category);
            }
            for (const item of dirItems) allImages.push({ ...item, subfolder: item.subfolder || source });
        } else {
            collectAllDirs();
        }

        const sorted = sortByMtime(allImages);
        return {
            entries: sorted,
            index: sorted.findIndex(img => img.filename === image.filename && img.subfolder === subfolder)
        };
    }

}
