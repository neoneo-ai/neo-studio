/**
 * Gallery Card - content and interactions of a single directory/media card
 */
import { $el } from "../../../../scripts/ui.js";
import { api } from "../../../../scripts/api.js";
import { app } from "../../../../scripts/app.js";
import { getReservedSpace, getImageHeight, isImageFile, isVideoFile, isAudioFile, getThumbnailSrc, getAudioSrc, showToast, showInlineFeedback, renderCoverTiles, coverMaxTiles, buildPlaceholderTile, decorativeHeights, renderWaveform, applyMediaCardRatio, registerLazyThumbnail } from './gallery-utils.js';
import { Lightbox } from "./lightbox.js";
import { buildGenerationMenuItems, openReversePromptDialog, openLoraTagDialog } from "./gallery-gen.js";
import { copyGalleryToInput } from "./media-transfer.js";
import { openDirectorEditor } from "./director.js";
import { t, tf } from "./js/core/i18n.js";
import { icon } from "./js/core/icons.js";

// 已解码波形峰值的会话缓存：同一文件在页面内只请求/解码一次，跨卡片复用。
// 持久化到后端本地目录由 /neo_gallery/waveform 负责（见 gallery.py）。
const _waveformSessionCache = new Map(); // "subfolder::filename" -> { peaks, duration }
function _waveformKey(filename, subfolder) {
    return `${subfolder || ""}::${filename}`;
}

function _relativeTime(ts) {
    const days = Math.floor((Date.now() / 1000 - ts) / 86400);
    if (days <= 0) return t("今天");
    if (days < 30) return tf("{n} 天前", { n: days });
    const months = Math.floor(days / 30);
    if (months < 12) return tf("{n} 个月前", { n: months });
    return tf("{n} 年前", { n: Math.floor(months / 12) });
}

/** 目录卡副信息行：条目数 · 子目录数 · 最近更新时间（缺数据的项直接省略）。 */
function _dirMetaText(items, subdirs, dirInfo) {
    const count = dirInfo && dirInfo.root_count != null ? dirInfo.root_count : (items ? items.length : 0);
    const parts = [];
    if (count > 0) parts.push(tf("{n} 项", { n: count }));
    const sub = Object.keys(subdirs || {}).length;
    if (sub > 0) parts.push(tf("{n} 个子目录", { n: sub }));
    let newest = 0;
    for (const it of items || []) newest = Math.max(newest, it.mtime || it._mtime || 0);
    if (newest) parts.push(_relativeTime(newest));
    return parts.join(" · ");
}

// Civitai fetch badge for pending lora directory cards. Network failures and rejected
// keys need different wording: Civitai is unreachable without a proxy on many networks,
// and that is not a key problem.
export function civitaiBadge(civitai) {
    if (civitai && civitai.needs_api_key) {
        return { text: t("需要配置 C 站 API KEY"), cls: "status-pending", title: "" };
    }
    if (civitai && (civitai.status === 'failed' || civitai.status === 'not_found')) {
        const err = civitai.error || "";
        const offline = err.includes("无法连接") || err.includes("Civitai HTTP 0");
        const text = civitai.status === 'not_found'
            ? "Not on Civitai"
            : (offline ? t("C 站无法连接") : (err.includes("KEY") ? t("API KEY 被拒绝") : "Fetch failed"));
        const hint = offline ? t("（可在设置中点「测试 C 站连通性」排查）") : "";
        return { text, cls: "status-failed", title: err + hint };
    }
    return { text: "Fetching from Civitai...", cls: "status-loading", title: "" };
}
export class GalleryCard {
    constructor(gallery) {
        this.gallery = gallery;
    }


    // ====== Send Menus ======

    _removeLoraSendMenu() {
        const existing = document.getElementById('neo-gallery-lora-send-menu');
        if (existing) existing.remove();
    }

    async _showLoraSendMenu(gallery, loraPath, button) {
        this._removeLoraSendMenu();
        if (!loraPath) {
            showToast(gallery.app, 'warning', 'No Lora', 'This item is not linked to a lora file.');
            return;
        }
        const menuItems = [];
        gallery.app.graph._nodes.forEach(node => {
            // Skip nodes that are in bypass state (mode === 4, set by Ctrl+B or RS_Bypass)
            if (node.mode === 4) return;
            // Standard lora loaders only (LoraLoader / LoraLoaderModelOnly / variants)
            if (!/^LoraLoader/i.test(node.comfyClass || '') || !node.widgets) return;
            node.widgets.forEach((widget, index) => {
                if (widget.name === 'lora_name' && widget.type === 'combo') {
                    menuItems.push({ nodeId: node.id, widgetIndex: index, label: `\u25B8 ${node.title || 'Node'} \u2192 ${widget.name}` });
                }
            });
        });

        const selKeys = Object.keys(gallery.app.canvas.selected_nodes);
        let selectedNodeId = null;
        if (selKeys.length > 0) {
            const sn = gallery.app.canvas.selected_nodes[selKeys[0]];
            if (/^LoraLoader/i.test(sn.comfyClass || '') && sn.widgets?.some(w => w.name === 'lora_name' && w.type === 'combo')) {
                selectedNodeId = sn.id;
            }
        }
        if (menuItems.length === 0 && !selectedNodeId) {
            showToast(gallery.app, 'warning', 'No Target', 'No LoraLoader nodes found.');
            return;
        }

        menuItems.forEach(item => { item.isSelected = item.nodeId === selectedNodeId; });
        menuItems.sort((a, b) => (a.isSelected !== b.isSelected) ? (a.isSelected ? -1 : 1) : 0);

        if (menuItems.length === 1 && !selectedNodeId) {
            const item = menuItems[0];
            gallery.sendLoraToNode(loraPath, `${item.nodeId}:widget:${item.widgetIndex}`, button);
            return;
        }
        if (menuItems.length === 0 && selectedNodeId) {
            // Only the selected (possibly bypassed) loader matched \u2014 send straight to it
            const sn = gallery.app.canvas.selected_nodes[selKeys[0]];
            const idx = sn.widgets.findIndex(w => w.name === 'lora_name' && w.type === 'combo');
            gallery.sendLoraToNode(loraPath, `${sn.id}:widget:${idx}`, button);
            return;
        }

        const dropdown = $el("div", { id: "neo-gallery-lora-send-menu", className: "neo-gallery-send-menu" });
        for (const item of menuItems) {
            const label = item.isSelected ? `${item.label} \u2713` : item.label;
            const el = $el("div", {
                className: "neo-gallery-send-menu-item" + (item.isSelected ? " neo-gallery-send-menu-selected" : ""),
                onclick: (e) => { e.stopPropagation(); this._removeLoraSendMenu(); gallery.sendLoraToNode(loraPath, `${item.nodeId}:widget:${item.widgetIndex}`, button); },
            }, [label]);
            dropdown.appendChild(el);
        }
        const rect = button.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = Math.min(rect.left, window.innerWidth - 250) + 'px';
        dropdown.style.zIndex = '9001';
        document.body.appendChild(dropdown);
        requestAnimationFrame(() => {
            dropdown.style.top = (rect.top - dropdown.offsetHeight - 8) + 'px';
        });
        const closeHandler = (e) => {
            if (!dropdown.contains(e.target) && e.target !== button) {
                this._removeLoraSendMenu();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }

    // ====== Public API ======

    /**
     * Fetch an image, re-encode it as PNG (clipboard only reliably accepts PNG),
     * and write it to the system clipboard. Requires a secure context.
     */
    _copyImageToClipboard(imageUrl, feedbackBtn = null) {
        const fail = (err) => {
            console.error('[Neo Gallery] Copy image failed:', err);
            const msg = String(err && err.message || err);
            if (feedbackBtn) showInlineFeedback(feedbackBtn, '\u274C ' + msg.slice(0, 20), 'error');
            else showToast(this.gallery.app, 'error', 'Copy Failed', msg);
        };
        if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
            fail(new Error('\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u526A\u8D34\u677F\u56FE\u7247'));
            return;
        }
        fetch(imageUrl).then(resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.blob();
        }).then(blob => new Promise((resolve, reject) => {
            const img = new Image();
            const objUrl = URL.createObjectURL(blob);
            img.onload = () => { URL.revokeObjectURL(objUrl); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('\u56FE\u7247\u52A0\u8F7D\u5931\u8D25')); };
            img.src = objUrl;
        })).then(img => new Promise((resolve, reject) => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG \u7F16\u7801\u5931\u8D25')), 'image/png');
        })).then(pngBlob => {
            // Promise form of ClipboardItem: required by some browsers to keep the write permission alive
            const item = new ClipboardItem({ 'image/png': new Promise(resolve => resolve(pngBlob)) });
            return navigator.clipboard.write([item]).then(() => {
                if (feedbackBtn) showInlineFeedback(feedbackBtn, 'Copied!', 'success');
                else showToast(this.gallery.app, 'success', 'Image Copied!', 'Copied image to clipboard');
            });
        }).catch(fail);
    }

    /**
     * Copy text to system clipboard only.
     */
    copyToClipboard(imageName, txtContent, feedbackBtn = null) {
        const textToCopy = this._cleanText(txtContent);
        return this._fallbackToClipboard(textToCopy, feedbackBtn);
    }

    /**
     * Clean text content for copying.
     */
    _cleanText(txtContent) {
        return String(txtContent || "").trim();
    }

    /**
     * Fallback: write to system clipboard.
     */
    _fallbackToClipboard(textToCopy, feedbackBtn = null) {
        navigator.clipboard.writeText(textToCopy).then(() => {
            if (feedbackBtn) showInlineFeedback(feedbackBtn, 'Copied!', 'success');
            else showToast(this.gallery.app, 'success', 'Tags Copied!', `Copied to clipboard`);
        }).catch((err) => {
            console.error('[Neo Gallery] Clipboard write failed:', err);
            if (feedbackBtn) showInlineFeedback(feedbackBtn, '\u274C Failed', 'error');
        });
    }

    async createDirCard(gallery, name, path, items, subdirs = {}, source = "local", dirInfo = null) {
        const isRemote = source === "oss";
        // Lora dirs are addressed by their "Lora/..." path; name may be just the lora stem.
        const isLoraDir = String(path || "").toLowerCase().startsWith("lora/");
        const navTarget = isRemote ? path : (isLoraDir ? path : name);
        const card = $el("div", {
            className: "neo-gallery-category-card" + (isRemote ? " neo-gallery-card-remote" : ""),
            onclick: () => gallery.showDirectoryStructure(navTarget, [])
        });

        const isPending = !!(dirInfo && dirInfo.pending);
        const loraPath = (dirInfo && dirInfo.lora_path) || null;
        const civitai = (dirInfo && dirInfo.civitai) || null;

        const coverWrapper = $el("div", {
            className: "neo-gallery-card-cover-wrapper skeleton-loading"
        });

        // Mark card as lazy-load target with data attributes
        card.dataset.lazyCovers = name;
        card.dataset.lazyCoversPath = path;

        const nameEl = $el("span", { className: "neo-gallery-card-name", textContent: name });
        const metaText = _dirMetaText(items, subdirs, dirInfo);
        const info = $el("div", { className: "neo-gallery-card-info" }, [
            nameEl,
            ...(metaText ? [$el("span", { className: "neo-gallery-card-meta", textContent: metaText })] : [])
        ]);

        if (isRemote) {
            nameEl.parentElement.appendChild($el("span", {
                className: "neo-gallery-remote-badge",
                textContent: "\u2601"
            }));
        }

        const typeBadge = $el("div", {
            className: "neo-gallery-card-type-badge " + (isRemote ? "type-remote" : "type-directory"),
            title: isRemote ? "Remote (OSS)" : "Directory"
        }, [isRemote ? "\u2601\uFE0F" : "\uD83D\uDCC1"]);

        // Pending lora fetch (queued/running/failed) status badge.
        if (isPending) {
            const badge = civitaiBadge(civitai);
            card.appendChild($el("div", {
                className: "neo-gallery-card-status " + badge.cls,
                textContent: badge.text,
                title: badge.title
            }));
        } else if (dirInfo && dirInfo.has_pending) {
            card.appendChild($el("div", {
                className: "neo-gallery-card-status status-pending",
                textContent: "Pending loras",
                title: "Some loras are still queued for Civitai example fetching"
            }));
        }

        // Send the lora path to a standard LoraLoader from the lora directory card.
        if (loraPath) {
            const loraBtn = $el("div", {
                className: "neo-gallery-card-lora-send-btn",
                title: "Send the lora path to a standard LoraLoader",
                onclick: (e) => {
                    e.stopPropagation();
                    this._showLoraSendMenu(gallery, loraPath, loraBtn);
                }
            }, ["\uD83D\uDCE4"]);
            card.appendChild(loraBtn);
        }

        card.appendChild(typeBadge);
        card.appendChild(coverWrapper);
        card.appendChild(info);

        // Store cover wrapper reference for lazy loading
        card._coverWrapper = coverWrapper;

        // Try to load cover images from cache immediately
        this._applyCoverImages(card, coverWrapper, gallery, name, name);

        return card;
    }

    /**
     * Apply cover images to a directory card from the global cache.
     */
    _applyCoverImages(card, coverWrapper, gallery, dirName, displayLabel) {
        // Use cached cover images from batch fetch
        // Case-insensitive lookup: backend uses lowercase keys (e.g. "presets")
        // but frontend passes the directory name as displayed (e.g. "Presets")
        // Also try the card's full path (e.g. "Cloud Presets/26-06-25") for OSS subdirs
        const coverPath = card.dataset && card.dataset.lazyCoversPath;
        const covers = (gallery._dirCovers && gallery._dirCovers[dirName]) ||
                       (gallery._dirCovers && Object.entries(gallery._dirCovers).find(([k]) => k.toLowerCase() === dirName.toLowerCase())?.[1]) ||
                       (gallery._dirCovers && coverPath && gallery._dirCovers[coverPath]) ||
                       (gallery._dirCovers && coverPath && Object.entries(gallery._dirCovers).find(([k]) => k.toLowerCase() === coverPath.toLowerCase())?.[1]) ||
                       [];

        if (covers.length > 0) {
            this._renderCoverGrid(coverWrapper, covers, displayLabel);
            // Remove skeleton loading state
            coverWrapper.classList.remove('skeleton-loading');
            coverWrapper.classList.add('skeleton-loaded');
        } else {
            // No cover images available - keep skeleton loading for lazy loading
            // Don't remove skeleton-loading here, let IntersectionObserver handle it
            // Only show placeholder if skeleton is not active
            if (!coverWrapper.classList.contains('skeleton-loading')) {
                renderCoverTiles(coverWrapper, [], dirName);
            }
        }
    }

    /**
     * Render a directory/subdir cover from an array of cover entries (shared renderer).
     */
    _renderCoverGrid(coverWrapper, images, displayLabel) {
        renderCoverTiles(coverWrapper, images, displayLabel, coverMaxTiles(this.gallery));
    }

    async createSubdirCard(gallery, subdirName, parentDir, fullPath, subdirData = null) {
        const card = $el("div", {
            className: "neo-gallery-category-card",
            onclick: () => gallery.showDirectoryStructure(parentDir, fullPath)
        });

        const isPending = !!(subdirData && subdirData.pending);
        const civitai = (subdirData && subdirData.civitai) || null;
        const loraPath = (subdirData && subdirData.lora_path) || null;

        const typeBadge = $el("div", {
            className: "neo-gallery-card-type-badge type-directory",
            title: "Directory"
        }, ["\uD83D\uDCC1"]);

        const coverWrapper = $el("div", {
            className: "neo-gallery-card-cover-wrapper skeleton-loading"
        });

        const subMeta = _dirMetaText(null, (subdirData && subdirData.subdirs) || {},
            { root_count: (subdirData && subdirData.image_count) || 0 });
        const info = $el("div", { className: "neo-gallery-card-info" }, [
            $el("span", { className: "neo-gallery-card-name", textContent: subdirName }),
            ...(subMeta ? [$el("span", { className: "neo-gallery-card-meta", textContent: subMeta })] : [])
        ]);

        if (isPending) {
            const badge = civitaiBadge(civitai);
            card.appendChild($el("div", {
                className: "neo-gallery-card-status " + badge.cls,
                textContent: badge.text,
                title: badge.title
            }));
        }

        // Send the lora path to a standard LoraLoader from the directory card itself.
        if (loraPath) {
            const loraBtn = $el("div", {
                className: "neo-gallery-card-lora-send-btn",
                title: "Send the lora path to a standard LoraLoader",
                onclick: (e) => {
                    e.stopPropagation();
                    this._showLoraSendMenu(gallery, loraPath, loraBtn);
                }
            }, ["\uD83D\uDCE4"]);
            card.appendChild(loraBtn);
        }

        // LoRA 打标：可写的叶子图片目录（含图片）显示 ⋯ 扩展按钮。
        const dirPath = [parentDir, ...fullPath].join("/");
        if (subdirData && subdirData.image_count > 0 && !this._isReadOnlySource(fullPath.join("/"), subdirData.source)) {
            const tagBtn = $el("div", {
                className: "neo-gallery-card-dir-menu-btn",
                title: t("LoRA 打标 / 目录标准化"),
                onclick: (e) => {
                    e.stopPropagation();
                    this._showDirMenu(gallery, subdirName, dirPath, tagBtn);
                }
            }, ["⋯"]);
            card.appendChild(tagBtn);
        }

        // LoRA 目录刷新：重读 safetensors 头部元数据（本地，不重新下载示例图）。
        if (String(parentDir).toLowerCase().startsWith("lora")) {
            const refreshBtn = $el("div", {
                className: "neo-gallery-card-dir-menu-btn",
                title: t("刷新元数据（重读 safetensors 头部，不重新下载示例图）"),
                onclick: (e) => {
                    e.stopPropagation();
                    this._showLoraRefreshMenu(gallery, subdirName, fullPath.join("/"), refreshBtn);
                }
            }, ["⋯"]);
            card.appendChild(refreshBtn);
        }

        card.appendChild(typeBadge);
        card.appendChild(coverWrapper);
        card.appendChild(info);

        // Try to apply cover images from cache first, then fallback to lazy fetch
        const subdirKey = `${parentDir}/${fullPath.join("/")}`;
        this._applySubdirCover(card, coverWrapper, gallery, subdirKey, parentDir, fullPath, subdirName);

        return card;
    }

    /**
     * Apply cover images to a subdirectory card from the global cache.
     */
    _applySubdirCover(card, coverWrapper, gallery, subdirKey, parentDir, fullPath, subdirName) {
        // Case-insensitive lookup for consistency
        const covers = (gallery._dirCovers && gallery._dirCovers[subdirKey]) || 
                       (gallery._dirCovers && Object.entries(gallery._dirCovers).find(([k]) => k.toLowerCase() === subdirKey.toLowerCase())?.[1]) || [];

        if (covers.length > 0) {
            this._renderCoverGrid(coverWrapper, covers, subdirName);
            // Remove skeleton loading state
            coverWrapper.classList.remove('skeleton-loading');
            coverWrapper.classList.add('skeleton-loaded');
        } else {
            // No cover images available - show placeholder
            renderCoverTiles(coverWrapper, [], subdirName);
            // Remove skeleton loading state even for placeholder
            coverWrapper.classList.remove('skeleton-loading');
            coverWrapper.classList.add('skeleton-loaded');
        }
    }

    // ====== 收藏菜单（缩略图卡右下角「⋯」信息扩展按钮） ======

    _removeCollectMenu() {
        const existing = document.querySelector('.neo-gallery-collect-menu');
        if (existing) existing.remove();
    }

    /** 根据素材来源拆分 gallery 目录名与子路径，用于本地收藏路径记录。 */
    _bookmarkLocator(image, subfolder, source, gallery) {
        const full = String(subfolder || "");
        if (String(source || "").toLowerCase() === "oss") {
            return { source: "oss", dir: full, subfolder: "" };
        }
        // 顶层目录名必须是列表接口可解析的卡片名（自定义目录名 / Input / Output）。
        // item.subfolder 只是卡片内相对路径（如 "美女"），单独无法定位，
        // 因此用当前视图的 source + categoryPath 还原「可打开、可取封面」的路径。
        const view = gallery && gallery.currentView;
        if (view && view.source) {
            const dir = view.source;
            const sub = Array.isArray(view.categoryPath) ? view.categoryPath.join("/") : "";
            return { source: "local", dir, subfolder: sub };
        }
        const segs = full.split("/").filter(Boolean);
        const dir = segs[0] || "Input";
        return { source: "local", dir, subfolder: segs.slice(1).join("/") };
    }

    async _collectMedia(gallery, payload, label) {
        try {
            const resp = await api.fetchApi('/neo_bookmark/local/add', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await resp.json();
            if (data.success) {
                showToast(gallery.app, 'success', t('已加入收藏'), label);
            } else if (resp.status === 409) {
                showToast(gallery.app, 'info', t('已在收藏中'), label);
            } else {
                showToast(gallery.app, 'error', t('收藏失败'), data.error || '');
            }
        } catch (e) {
            showToast(gallery.app, 'error', t('收藏失败'), String(e));
        }
    }

    /** 只读素材源判定：presets/lora/C站收藏目录与远程 oss（⋯ 菜单删除项与左上角勾选框共用）。 */
    _isReadOnlySource(subfolder, source) {
        const subLower = String(subfolder || "").toLowerCase();
        return subLower === 'presets' || subLower.startsWith('presets/') ||
            subLower === 'lora' || subLower.startsWith('lora/') ||
            subLower === 'civitai_bookmarks' || subLower.startsWith('civitai_bookmarks/') ||
            source === "oss";
    }

    /** ⋯ 菜单「🎬 新建导演配方」：角色图目录里走全参考（图进该段参考图 + 👤 角色参考图），否则图作首帧。
     *  草稿形状由 gallery.directorDraft 决定，与多选操作条共用同一份逻辑。 */
    _directorMenuItem(gallery, image, subfolder) {
        const charDir = !!gallery.isCharacterDir?.();
        return $el("div", {
            className: "neo-gallery-collect-item",
            title: charDir
                ? t("角色图目录：建一段全参考配方，这张图进该段参考图与 👤 角色参考图，不当首帧")
                : t("以此图为首帧，新建视频导演配方"),
            onclick: async () => {
                this._removeCollectMenu();
                try {
                    // 导演编辑器帧一律走 input/ 根目录（/view?subfolder=）：子文件夹与云端图先落盘再建配方
                    const fname = subfolder
                        ? await copyGalleryToInput(JSON.stringify({ filename: image.filename, subfolder }))
                        : image.filename;
                    if (!fname) throw new Error(t("无法读取该图片"));
                    openDirectorEditor(gallery.directorDraft([fname]));
                } catch (err) {
                    showToast(gallery.app, "error", t("新建导演配方失败"), String(err.message || err));
                }
            }
        }, [charDir ? t("\uD83C\uDFAC 新建导演配方（全参考）") : t("\uD83C\uDFAC 新建导演配方")]);
    }

    _showCollectMenu(gallery, image, subfolder, source, anchor, unfavorite = null) {
        this._removeCollectMenu();
        const loc = this._bookmarkLocator(image, subfolder, source, gallery);
        const displayName = (image.name || image.filename || '').replace(/\.\w+$/, '') || t("未命名");
        const isOss = loc.source === "oss";
        const fileSub = loc.subfolder ? `/${loc.subfolder}` : "";
        const pathLabel = `${loc.dir}${fileSub}${image.filename ? '/' + image.filename : ''}`;

        const collectFile = () => this._collectMedia(gallery, {
            source: loc.source, name: displayName,
            dir: loc.dir, subfolder: loc.subfolder, filename: image.filename || image.name || ""
        }, displayName);

        // 系统输入/输出文件可删除；presets、lora 与远程 oss 来源只读。
        const canDelete = !this._isReadOnlySource(subfolder, source);
        // 有勾选时菜单「删除」升级为批量删除已选素材
        const selectedCount = (gallery._selectedItems && gallery._selectedItems.size) || 0;

        // 导入工作流：仅当素材内嵌了 ComfyUI 工作流时显示（异步探测后放开）。
        const wfItem = $el("div", {
            className: "neo-gallery-collect-item",
            style: { display: "none" },
            title: t("将此素材内嵌的 ComfyUI 工作流载入画布"),
            onclick: async () => {
                this._removeCollectMenu();
                try {
                    await this._importWorkflowFromMedia(gallery, image, subfolder);
                } catch (err) {
                    showToast(gallery.app, "error", t("导入失败"), String(err.message || err));
                }
            }
        }, [t("\u2937 导入工作流")]);
        this._fetchMediaMeta(image, subfolder).then(meta => {
            if (meta && meta.has && (meta.workflow || meta.prompt)) wfItem.style.display = "";
        }).catch(() => {});

        const menu = $el("div", { className: "neo-gallery-collect-menu" }, [
            $el("div", { className: "neo-gallery-collect-title" }, [
                $el("span", { className: "neo-gallery-collect-name", textContent: displayName }),
                isOss ? $el("span", { className: "neo-gallery-card-source-badge", textContent: t("OSS 预设") }) : null
            ].filter(Boolean)),
            $el("div", {
                className: "neo-gallery-collect-path",
                title: pathLabel,
                textContent: pathLabel
            }),
            $el("div", {
                className: "neo-gallery-collect-item",
                onclick: () => { collectFile(); this._removeCollectMenu(); }
            }, [t("\u2B50 收藏本图")]),
            ...buildGenerationMenuItems({ card: this, gallery, image, subfolder }),
            isImageFile(image.filename) ? this._directorMenuItem(gallery, image, subfolder) : null,
            (isImageFile(image.filename) && canDelete) ? $el("div", {
                className: "neo-gallery-collect-item",
                onclick: () => { this._removeCollectMenu(); openReversePromptDialog(image, subfolder); }
            }, [t("🔍 图片反推")]) : null,
            ...(image.lora_path ? [
                $el("div", {
                    className: "neo-gallery-collect-item",
                    title: t("发送到画布上的 LoraLoader"),
                    onclick: () => { this._removeCollectMenu(); this._showLoraSendMenu(gallery, image.lora_path, anchor); }
                }, [t("\uD83D\uDCE4 发送 Lora")]),
                $el("div", {
                    className: "neo-gallery-collect-path neo-gallery-collect-lora-path",
                    title: image.lora_path,
                    textContent: image.lora_path
                }),
                // LoRA header 元数据徽章：base_model / dtype（有值才显示）
                (image.base_model || image.dtype) ? $el("div", { className: "neo-gallery-collect-lora-badges" }, [
                    image.base_model ? $el("span", { className: "neo-gallery-collect-lora-badge", title: "Base model", textContent: image.base_model }) : null,
                    image.dtype ? $el("span", { className: "neo-gallery-collect-lora-badge", title: "Dtype", textContent: image.dtype }) : null
                ].filter(Boolean)) : null,
                // 触发词：逐词点击复制 + 全量复制
                (image.trigger_words && image.trigger_words.length) ? $el("div", { className: "neo-gallery-collect-triggers" }, [
                    $el("div", { className: "neo-gallery-collect-triggers-head" }, [
                        $el("span", { className: "neo-gallery-collect-triggers-label", textContent: tf("触发词（{n}）", { n: image.trigger_words.length }) }),
                        $el("span", {
                            className: "neo-gallery-collect-triggers-copyall",
                            title: t("复制全部触发词"),
                            onclick: (e) => { e.stopPropagation(); this.copyToClipboard(image.name, image.trigger_words.join(", ")); }
                        }, [icon("copy"), " " + t("复制全部")])
                    ]),
                    ...image.trigger_words.map((w) => $el("span", {
                        className: "neo-gallery-collect-trigger-chip",
                        title: t("点击复制该触发词"),
                        textContent: w,
                        onclick: (e) => { e.stopPropagation(); this.copyToClipboard(image.name, w); }
                    }))
                ]) : null
            ].filter(Boolean) : []),
            image.txt_content ? $el("div", {
                className: "neo-gallery-collect-prompt-preview",
                title: t("提示词（可全选复制）")
            }, [
                $el("span", { className: "neo-gallery-collect-prompt-text", textContent: gallery.cleanText(image.txt_content) })
            ]) : null,
            image.txt_content ? $el("div", {
                className: "neo-gallery-collect-item",
                title: t("读取副文件全文后复制，读不到时复制列表预览"),
                onclick: async () => { const full = await this._fetchFullPrompt(image, subfolder); this.copyToClipboard(image.name, full || image.txt_content); this._removeCollectMenu(); }
            }, [t("复制提示词")]) : null,
            wfItem,
            canDelete ? $el("div", {
                className: "neo-gallery-collect-item neo-gallery-collect-item-danger",
                title: selectedCount > 0 ? tf("删除已勾选的 {n} 个素材，不影响未选中文件", { n: selectedCount }) : t("仅删除当前素材"),
                onclick: () => { this._removeCollectMenu(); selectedCount > 0 ? gallery.deleteSelected() : gallery.deleteItem(image.name, subfolder); }
            }, [selectedCount > 0 ? tf("删除已选素材（{n}）", { n: selectedCount }) : t("删除")]) : null,
            unfavorite ? $el("div", {
                className: "neo-gallery-collect-item neo-gallery-collect-item-danger",
                title: t("取消收藏（仅移除收藏记录，不删除源文件）"),
                onclick: () => { this._removeCollectMenu(); unfavorite(); }
            }, [t("\u2716 取消收藏")]) : null
        ].filter(Boolean));

        this._attachPopupMenu(menu, anchor);
    }

    /** 弹出菜单定位（优先锚点右侧、放不下回退下方）+ 点击外部 / Esc 关闭。 */
    _attachPopupMenu(menu, anchor) {
        document.body.appendChild(menu);
        const rect = (anchor && anchor.getBoundingClientRect()) || { right: 0, bottom: 0 };
        const mRect = menu.getBoundingClientRect();
        // 优先放按钮右侧（⋯ 在卡片右上角，菜单浮在画布上不挡缩略图）；右侧放不下才回退到按钮下方
        if (rect.right + 6 + mRect.width <= window.innerWidth - 8) {
            menu.style.left = (rect.right + 6) + 'px';
            menu.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - mRect.height - 8)) + 'px';
        } else {
            menu.style.left = Math.max(8, Math.min(rect.right - mRect.width, window.innerWidth - mRect.width - 8)) + 'px';
            menu.style.top = (rect.bottom + 4) + 'px';
            if (rect.bottom + mRect.height > window.innerHeight) {
                menu.style.top = Math.max(8, rect.top - mRect.height - 4) + 'px';
            }
        }

        const closeOnOutside = (e) => {
            if (!menu.contains(e.target)) this._removeCollectMenu();
        };
        const closeOnEsc = (e) => { if (e.key === 'Escape') this._removeCollectMenu(); };
        // 用 pointerdown 而非 mousedown：LiteGraph 画布 touch-action:none，pointerdown 上
        // preventDefault 会按规范抑制后续兼容鼠标事件，画布点击的 mousedown 到不了 document
        setTimeout(() => {
            document.addEventListener('pointerdown', closeOnOutside, true);
            document.addEventListener('keydown', closeOnEsc);
        }, 0);
        menu._cleanup = () => {
            document.removeEventListener('pointerdown', closeOnOutside, true);
            document.removeEventListener('keydown', closeOnEsc);
        };
        const origRemove = menu.remove.bind(menu);
        menu.remove = () => { if (menu._cleanup) menu._cleanup(); origRemove(); };
    }

    /** 目录卡 ⋯ 菜单：LoRA 打标（批量生成标签 .txt，可选先自动标准化目录）。 */
    _showDirMenu(gallery, dirName, dirPath, anchor) {
        this._removeCollectMenu();
        const menu = $el("div", { className: "neo-gallery-collect-menu" }, [
            $el("div", { className: "neo-gallery-collect-title" }, [
                $el("span", { className: "neo-gallery-collect-name", textContent: dirName })
            ]),
            $el("div", {
                className: "neo-gallery-collect-path",
                title: dirPath,
                textContent: dirPath
            }),
            $el("div", {
                className: "neo-gallery-collect-item",
                title: t("为目录内每张图片生成标准化标签 .txt，可选先转 HEIC 为 PNG 并顺序编号"),
                onclick: () => { this._removeCollectMenu(); openLoraTagDialog(gallery, dirPath); }
            }, [t("🏷️ LoRA 打标")])
        ]);
        this._attachPopupMenu(menu, anchor);
    }

    /** LoRA 目录卡 ⋯ 菜单：刷新元数据（重读 safetensors 头部，本地，不重新下载示例图）。 */
    _showLoraRefreshMenu(gallery, dirName, dirPath, anchor) {
        this._removeCollectMenu();
        const menu = $el("div", { className: "neo-gallery-collect-menu" }, [
            $el("div", { className: "neo-gallery-collect-title" }, [
                $el("span", { className: "neo-gallery-collect-name", textContent: dirName })
            ]),
            $el("div", {
                className: "neo-gallery-collect-path",
                title: dirPath,
                textContent: dirPath
            }),
            $el("div", {
                className: "neo-gallery-collect-item",
                title: t("重读目录内每个 LORA 的 safetensors 头部元数据（base_model / 触发词 / dtype），不重新下载示例图"),
                onclick: () => { this._removeCollectMenu(); this._refreshLoraDirMeta(gallery, dirPath); }
            }, [t("🔄 刷新元数据")])
        ]);
        this._attachPopupMenu(menu, anchor);
    }

    /** 目录收藏卡 ⋯ 菜单：仅取消收藏（移除收藏记录，不删除源文件）。 */
    _showBookmarkMenu(gallery, item, anchor, unfavorite) {
        this._removeCollectMenu();
        const displayName = (item.name || item.filename || t("收藏")).replace(/\.\w+$/, "") || t("收藏");
        const pathLabel = [item.dir, item.subfolder, item.filename].filter(Boolean).join("/");
        const menu = $el("div", { className: "neo-gallery-collect-menu" }, [
            $el("div", { className: "neo-gallery-collect-title" }, [
                $el("span", { className: "neo-gallery-collect-name", textContent: displayName })
            ]),
            $el("div", { className: "neo-gallery-collect-path", title: pathLabel, textContent: pathLabel }),
            $el("div", {
                className: "neo-gallery-collect-item neo-gallery-collect-item-danger",
                title: t("取消收藏（仅移除收藏记录，不删除源文件）"),
                onclick: () => { this._removeCollectMenu(); unfavorite(); }
            }, [t("\u2716 取消收藏")])
        ]);
        this._attachPopupMenu(menu, anchor);
    }

    async _refreshLoraDirMeta(gallery, dirPath) {
        try {
            const resp = await api.fetchApi("/neo_gallery/lora_refresh_dir", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dir: dirPath }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.success) throw new Error(data.error || t("刷新失败"));
            showToast(gallery.app, "success", t("元数据已刷新"), tf("已更新 {n} 个 LORA", { n: data.updated }));
            const view = gallery.currentView || {};
            await gallery.showDirectoryStructure(view.source, view.categoryPath || []);
        } catch (e) {
            showToast(gallery.app, "error", t("刷新元数据失败"), String(e.message || e));
        }
    }

    // ====== Image Element ======

    createImageElement(gallery, image, subfolder, source = "") {
        const isImageFileResult = isImageFile(image.filename);
        const isVideoFileResult = isVideoFile(image.filename);
        const isAudioFileResult = isAudioFile(image.filename);
        const isDraggableMedia = (isImageFileResult || isVideoFileResult || isAudioFileResult) && !image.lora_path;
        const reservedSpace = getReservedSpace(gallery.displayLabels);
        const imageHeight = getImageHeight(gallery.maxThumbnailSize, gallery.displayLabels);

        const container = $el("div", {
            className: isAudioFileResult
                ? "neo-gallery-thumb-container neo-gallery-thumb-container-audio"
                : "neo-gallery-thumb-container",
            style: {
                height: `${gallery.maxThumbnailSize}px`,
                width: `${gallery.maxThumbnailSize}px`
            },
            // 音频卡片不需要灯箱：点击容器不打开大图（播放由卡片自身处理）
            onclick: () => {
                if (isAudioFileResult) return;
                this.showLightbox(gallery, image, subfolder);
            },
            draggable: isDraggableMedia,
            ondragstart: (e) => {
                if (!isDraggableMedia) { e.preventDefault(); return; }
                e.dataTransfer.setData("application/x-neo-gallery", JSON.stringify({ filename: image.filename, subfolder }));
                e.dataTransfer.setData("text/plain", image.filename);
                e.dataTransfer.effectAllowed = "copy";
            },
            dataset: { filename: image.filename, subfolder: subfolder }
        });

        let imgSendBtn = null;
        if (image.lora_path) {
            imgSendBtn = $el("div", {
                className: "neo-gallery-thumb-img-send-btn",
                title: t("发送 Lora 到画布上的 LoraLoader"),
                onclick: (e) => {
                    e.stopPropagation();
                    this._showLoraSendMenu(gallery, image.lora_path, imgSendBtn);
                }
            }, ["\uD83D\uDCE4"]);
        }

        // 右上角信息扩展按钮：点击弹出扩展菜单（收藏 / Lora 发送 / 提示词预览 / 导入工作流 / 删除）。
        const bookmarkBtn = $el("div", {
            className: "neo-gallery-thumb-bookmark-btn",
            title: t("更多操作"),
            onclick: (e) => {
                e.stopPropagation();
                this._showCollectMenu(gallery, image, subfolder, source, bookmarkBtn);
            }
        }, ["\u22EF"]);

        // 左上角勾选框：多选后由底部操作条批量删除（可删除来源才给，与 ⋯ 菜单 canDelete 一致）。
        // 角色图目录例外：多选的用处是「🎬 新建导演配方」，云端预设图由 copy_to_input 现下到 input，
        // 删除仍会跳过只读项（deleteSelected 按 isDeletableItem 过滤），所以这些卡片也给勾选框。
        const readOnlySource = this._isReadOnlySource(subfolder, source);
        const selectable = !isAudioFileResult && (!readOnlySource || !!gallery.isCharacterDir?.());
        const selectCheck = selectable ? $el("input", {
            className: "neo-gallery-select-check",
            type: "checkbox",
            title: t("选中（可多选，Ctrl+A 全选）"),
            onclick: (e) => e.stopPropagation(),
            onchange: (e) => {
                e.stopPropagation();
                const checked = e.target.checked;
                gallery.toggleSelection(image.filename, subfolder);
                container.classList.toggle('neo-gallery-thumb-selected', checked);
            }
        }) : null;

        let mediaEl;
        const thumbnailSrc = isVideoFileResult || isImageFileResult ? getThumbnailSrc(image, subfolder) : null;
        
        if (isAudioFileResult) {
            mediaEl = this._buildAudioCard(gallery, image, subfolder);
            // 音频用长条形卡片：容器高度收窄以贴合波形条，避免方形留白
            container.style.height = "auto";
        } else if (thumbnailSrc) {
            mediaEl = $el("img", {
                className: "neo-gallery-thumb-img",
                src: gallery.placeholderImageUrl,
                alt: image.name,
                onerror: () => {
                    if (mediaEl) mediaEl.src = gallery.placeholderImageUrl;
                }
            });
            mediaEl.draggable = false;   // 由容器接管拖拽（携带 Neo Gallery 数据），而非浏览器原生图片拖拽
        } else {
            // Unknown type - show placeholder
            mediaEl = $el("div", {
                className: "neo-gallery-thumb-img neo-gallery-thumb-placeholder",
                textContent: "\uD83D\uDCCB"
            });
        }

        // 视频卡片左上角播放图标，一眼区分视频与图片。
        const videoBadge = isVideoFileResult ? $el("div", {
            className: "neo-gallery-thumb-video-badge"
        }, ["\u25B6"]) : null;

        // ⋯ 按钮是右上角独立覆盖层；底部浮动栏只留给 Lora 发送按钮（无则不建）
        const btnBar = imgSendBtn ? $el("div", { className: "neo-gallery-thumb-btn-bar" }, [imgSendBtn]) : null;

        const imgWrapper = $el("div", { className: "neo-gallery-thumb-img-wrapper" }, [videoBadge, mediaEl, btnBar, bookmarkBtn, selectCheck].filter(Boolean));

        // 列表已下发图片尺寸（w/h）：卡片先按方向占好位，滚动到视口才排队取缩略图
        if (thumbnailSrc) {
            applyMediaCardRatio(container, imgWrapper, image.w, image.h);
            registerLazyThumbnail(mediaEl, thumbnailSrc, {
                onLoaded: (el, w, h) => {
                    // 无尺寸数据（视频 / 旧列表）时，缩略图到位后再按真实方向排版
                    applyMediaCardRatio(container, imgWrapper, w, h);
                }
            });
        }

        const labelEl = gallery.displayLabels ? $el("span", {
            className: "neo-gallery-image-label",
            textContent: image.name.replace(/\.\w+$/, '')
        }) : null;

        container.appendChild(imgWrapper);
        if (labelEl) container.appendChild(labelEl);

        const loc = this._bookmarkLocator(image, subfolder, source, gallery);
        const fullPath = [loc.dir, loc.subfolder, image.filename || image.name].filter(Boolean).join("/");
        container.title = tf("{path}\n点击打开大图，右上角 ⋯ 更多操作", { path: fullPath });

        return container;
    }

    // ====== 音频卡片：波形 + 播放预览 ======

    _buildAudioCard(gallery, image, subfolder) {
        const card = $el("div", { className: "neo-gallery-thumb-img neo-gallery-audio-card" });

        const playBtn = $el("div", {
            className: "neo-gallery-audio-play-btn",
            title: t("播放 / 暂停预览")
        }, ["\u25B6"]);
        card.appendChild(playBtn);

        const canvas = $el("canvas", { className: "neo-gallery-audio-waveform" });
        card.appendChild(canvas);

        const timeEl = $el("span", { className: "neo-gallery-audio-time", textContent: "0:00 / 0:00" });
        card.appendChild(timeEl);
        card._audioTimeEl = timeEl;

        // 默认画装饰性波形占位（按文件名做确定性种子），首次播放再解码真实峰值重绘。
        // bars 存在卡片上，进度更新时据此重绘填充。
        card._audioBars = decorativeHeights(image.filename);
        card._renderAudio = (progress) => renderWaveform(canvas, card._audioBars, progress);
        card._renderAudio(0);

        // 若后端已缓存该文件的真实峰值（之前播放过），直接应用，无需再解码。
        this._loadCachedWaveform(image, subfolder, canvas, card);

        // 点击整条卡片即播放/暂停；阻止冒泡到容器，避免误触打开灯箱。
        card.addEventListener("click", (e) => {
            e.stopPropagation();
            this._toggleAudioPlayback(gallery, image, subfolder, card);
        });
        return card;
    }

    _toggleAudioPlayback(gallery, image, subfolder, card) {
        const canvas = card.querySelector(".neo-gallery-audio-waveform");
        const playBtn = card.querySelector(".neo-gallery-audio-play-btn");
        const url = getAudioSrc(image, subfolder);
        let player = gallery._audioPlayer;
        if (!player) {
            player = new Audio();
            gallery._audioPlayer = player;
            // 播放进度：重绘当前卡片波形填充 + 更新时长标签；播完复位
            player.addEventListener("timeupdate", () => gallery._onAudioTimeUpdate());
            player.addEventListener("ended", () => gallery._stopAudio());
        }
        // 已在播放本文件 → 暂停（保留当前进度）
        if (gallery._audioActiveUrl === url && !player.paused) {
            player.pause();
            playBtn.textContent = "\u25B6";
            return;
        }
        // 同一文件的暂停态 → 直接续播，不重载、不清进度
        if (gallery._audioActiveUrl === url && player.paused) {
            playBtn.textContent = "\u23F8";
            gallery._audioActiveCard = card;
            gallery._audioActiveBtn = playBtn;
            player.play().catch(err => { console.error('[Neo Gallery] audio playback failed', err); gallery._stopAudio(); });
            return;
        }
        // 切换文件：先停掉上一个并复位其按钮/波形，再加载新文件
        gallery._stopAudio();
        player.src = url;
        playBtn.textContent = "\u23F8";
        gallery._audioActiveUrl = url;
        gallery._audioActiveCard = card;
        gallery._audioActiveBtn = playBtn;
        player.play().catch(err => { console.error('[Neo Gallery] audio playback failed', err); gallery._stopAudio(); });

        // 首次播放：解码出真实峰值重绘波形（一次性开销，失败则保留装饰波形）
        if (!canvas.dataset.decoded) {
            this._decodeAndDrawWaveform(gallery, card, url, image, subfolder)
                .then(() => { canvas.dataset.decoded = "1"; })
                .catch(err => { console.warn('[Neo Gallery] waveform decode failed', err); });
        }
    }

    async _decodeAndDrawWaveform(gallery, card, url, image, subfolder) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        let actx = gallery._audioCtx;
        if (!actx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) throw new Error('AudioContext unavailable');
            actx = new AC();
            gallery._audioCtx = actx;
        }
        if (actx.state === 'suspended') await actx.resume().catch(() => {});
        const audioBuf = await actx.decodeAudioData(buf);
        const data = audioBuf.getChannelData(0);
        const n = 60;
        const step = Math.max(1, Math.floor(data.length / n));
        const peaks = new Array(n);
        for (let i = 0; i < n; i++) {
            let peak = 0;
            const start = i * step;
            for (let j = start; j < start + step && j < data.length; j += 8) {
                const v = Math.abs(data[j]);
                if (v > peak) peak = v;
            }
            peaks[i] = Math.min(1, peak);
        }
        card._audioBars = peaks;
        // 持久化真实峰值到后端本地目录，之后打开卡片可直接显示正确波形。
        this._saveWaveform(image, subfolder, peaks, audioBuf.duration || 0);
        // 按当前播放进度重绘（未开始/已暂停则 progress=0）
        const player = gallery._audioPlayer;
        const dur = player && isFinite(player.duration) ? player.duration : 0;
        const progress = (dur > 0 && player) ? Math.min(1, player.currentTime / dur) : 0;
        card._renderAudio(progress);
    }

    // 从后端读取已缓存的真实波形峰值；命中则替换装饰占位并标记为已解码。
    async _loadCachedWaveform(image, subfolder, canvas, card) {
        const key = _waveformKey(image.filename, subfolder);
        let entry = _waveformSessionCache.get(key);
        if (!entry) {
            try {
                const url = `${window.location.protocol}//${window.location.host}/neo_gallery/waveform?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder || "")}`;
                const resp = await fetch(url, { headers: { "X-StopPropagation": "1" } });
                if (resp.ok) {
                    const data = await resp.json();
                    if (data && data.has && Array.isArray(data.peaks) && data.peaks.length) {
                        entry = { peaks: data.peaks, duration: Number(data.duration) || 0 };
                        _waveformSessionCache.set(key, entry);
                    }
                }
            } catch (_) {}
        }
        if (!entry) return;
        card._audioBars = entry.peaks;
        canvas.dataset.decoded = "1"; // 已有真实峰值，播放时无需再解码
        if (entry.duration > 0 && card._audioTimeEl) {
            const m = Math.floor(entry.duration / 60);
            const s = Math.floor(entry.duration % 60).toString().padStart(2, "0");
            card._audioTimeEl.textContent = `0:00 / ${m}:${s}`;
        }
        card._renderAudio(0);
    }

    // 将解码出的真实峰值写入后端本地目录缓存（失败静默，不影响播放）。
    async _saveWaveform(image, subfolder, peaks, duration) {
        const key = _waveformKey(image.filename, subfolder);
        _waveformSessionCache.set(key, { peaks, duration });
        try {
            await fetch(`${window.location.protocol}//${window.location.host}/neo_gallery/waveform`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-StopPropagation": "1" },
                body: JSON.stringify({ filename: image.filename, subfolder: subfolder || "", peaks, duration }),
            });
        } catch (_) {}
    }

    // ====== Lightbox（复用通用 Lightbox 组件）======

    _lightboxImageUrl(image, subfolder) {
        const categoryParam = image.category ? `&category=${encodeURIComponent(image.category)}` : '';
        return image.preview || `${window.location.protocol}//${window.location.host}/neo_gallery/image?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}${categoryParam}`;
    }

    _lightboxVideoUrl(image, subfolder) {
        return `${window.location.protocol}//${window.location.host}/neo_gallery/video?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}`;
    }

    // 列表里的 txt_content 是预览（云端索引 500 字、本地扫描 8 行）：全文要读副文件
    _fetchFullPrompt(image, subfolder) {
        const url = `${window.location.protocol}//${window.location.host}/neo_gallery/txt?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}`;
        return fetch(url).then(r => (r.ok ? r.json() : null))
            .then(d => (d && d.success && d.content) ? String(d.content) : null)
            .catch(() => null);
    }

    _fetchBlobUrl(url) {
        return fetch(url)
            .then(resp => { if (!resp.ok) throw new Error(`HTTP ${resp.status}`); return resp.blob(); })
            .then(blob => URL.createObjectURL(blob));
    }

    _toLightboxItem(img, fallbackSubfolder) {
        const owner = img.subfolder || fallbackSubfolder;
        const isVideo = isVideoFile(img.filename);
        const isAudio = isAudioFile(img.filename);
        const url = isVideo ? this._lightboxVideoUrl(img, owner)
            : isAudio ? getAudioSrc(img, owner)
            : this._lightboxImageUrl(img, owner);
        return {
            raw: img,
            subfolder: owner,
            kind: isVideo ? 'video' : isAudio ? 'audio' : 'image',
            title: img.filename,
            url,
            // 图片用 fetch+blob 取源：加载完成可判定，翻页时不会出现半张图与闪烁
            resolve: (isVideo || isAudio) ? null : () => this._fetchBlobUrl(url)
        };
    }

    // 汇总当前视图内可翻页的媒体列表。目录模式取各目录条目；其余优先用目录已加载的条目，
    // 否则回退到网格正在渲染的条目（也覆盖 allDirectories 里没有的书签目录，其条目自带 subfolder）。
    showLightbox(gallery, image, subfolder) {
        const { entries, index } = gallery.list.collectLightboxMedia(image, subfolder);
        // 点击的媒体不在当前视图（如首页单图收藏，源目录未加载）时只显示本图
        if (index < 0) {
            Lightbox.open({
                items: [this._toLightboxItem(image, subfolder)],
                index: 0,
                actions: (item) => this._lightboxActions(gallery, item),
                panel: (item) => this._buildLightboxPanel(gallery, item)
            });
            return;
        }
        Lightbox.open({
            items: entries.map(img => this._toLightboxItem(img, subfolder)),
            index,
            actions: (item) => this._lightboxActions(gallery, item),
            panel: (item) => this._buildLightboxPanel(gallery, item)
        });
    }

    _lightboxActions(gallery, item) {
        const actions = [{
            icon: "copy",
            label: "\u590D\u5236\u56FE\u7247",
            title: "\u590D\u5236\u56FE\u7247\u5230\u526A\u8D34\u677F",
            onClick: (_item, _lightbox, btn) => this._copyImageToClipboard(item.url, btn)
        }];
        return actions;
    }
    // 侧栏：txt 副文件即时渲染；无 txt 时等内嵌元数据，没有内容就不占位。
    _buildLightboxPanel(gallery, item) {
        const image = item.raw;
        const subfolder = item.subfolder;
        if (image.txt_content) return this._lightboxPromptPanel(gallery, image, subfolder);
        return this._fetchMediaMeta(image, subfolder).then(meta =>
            (meta && meta.has) ? this._lightboxEmbeddedPanel(gallery, image, subfolder, meta) : null);
    }

    // 提示词正文排版：逗号/顿号清单（负面词就是几十项一坨）拆成标签块，长句按逗号逐条断行。
    _renderPromptValue(value) {
        const text = String(value);
        const parts = text.split(/[，,、\n]+/).map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 8 && parts.every((s) => s.length <= 20)) {
            const tags = $el("div", { className: "neo-lightbox-panel-tags" });
            for (const part of parts) tags.appendChild($el("span", { className: "neo-lightbox-panel-tag", textContent: part }));
            return tags;
        }
        const box = $el("div", { className: "neo-lightbox-panel-lines" });
        const lines = parts.length > 1 && text.length > 30 ? parts : [text.trim()];
        for (const line of lines) box.appendChild($el("div", { className: "neo-lightbox-panel-line", textContent: line }));
        return box;
    }

    _lightboxPromptPanel(gallery, image, subfolder) {
        let promptText = image.txt_content;
        const body = $el("div", { className: "neo-lightbox-panel-body" });
        const renderPrompt = (text) => {
            body.replaceChildren();
            const sections = this.gallery.parsePromptSections(text);
            if (sections.length > 0 && sections.some(s => s.label)) {
                for (const section of sections) {
                    if (section.label) {
                        const item = $el("div", { className: "neo-lightbox-panel-item" }, [
                            $el("div", { className: "neo-lightbox-panel-label", textContent: section.label + "\uff1a" })
                        ]);
                        if (section.value) {
                            item.appendChild($el("div", { className: "neo-lightbox-panel-value" }, [this._renderPromptValue(section.value)]));
                        }
                        body.appendChild(item);
                    } else if (section.value) {
                        body.appendChild($el("div", { className: "neo-lightbox-panel-plain" }, [this._renderPromptValue(section.value)]));
                    }
                }
            } else {
                body.appendChild($el("div", { className: "neo-lightbox-panel-plain" }, [this._renderPromptValue(this.gallery.cleanText(text))]));
            }
        };
        renderPrompt(promptText);
        // 预览先出，全文到达后整段替换；已翻页（面板已销毁）就丢弃这次结果
        this._fetchFullPrompt(image, subfolder).then((full) => {
            if (!full || full === promptText || !body.isConnected) return;
            promptText = full;
            renderPrompt(full);
        });

        const copyBtn = $el("div", {
            className: "neo-lightbox-panel-btn",
            textContent: "\u590D\u5236\u63D0\u793A\u8BCD",
            onclick: (e) => { e.stopPropagation(); this.copyToClipboard(image.name, promptText, copyBtn); }
        });
        copyBtn.prepend(icon("copy"));

        const inner = $el("div", { className: "neo-lightbox-panel-inner" }, [
            $el("div", { className: "neo-lightbox-panel-header" }, [
                $el("span", { className: "neo-lightbox-panel-title", textContent: "\u63D0\u793A\u8BCD" }),
                copyBtn
            ]),
            body
        ]);

        const btns = $el("div", { className: "neo-lightbox-panel-btns", style: { display: "none" } });
        inner.appendChild(btns);
        this._fetchMediaMeta(image, subfolder).then(meta => {
            // 已翻页或面板已销毁：丢弃过期结果，避免覆盖新页内容。
            if (!inner.isConnected || !meta || !meta.has) return;
            const frag = this._buildMetaButtons(meta, gallery, image, subfolder);
            if (!frag.childNodes.length) return;
            btns.style.display = "";
            btns.appendChild(frag);
        }).catch(() => {});

        return inner;
    }

    _lightboxEmbeddedPanel(gallery, image, subfolder, meta) {
        const body = $el("div", { className: "neo-lightbox-panel-body" });
        const texts = meta.texts;
        const addSection = (label, arr) => {
            if (!arr || !arr.length) return;
            body.appendChild($el("div", { className: "neo-lightbox-panel-item" }, [
                $el("div", { className: "neo-lightbox-panel-label", textContent: label + "\uff1a" }),
                $el("div", { className: "neo-lightbox-panel-value" }, [this._renderPromptValue(arr.join("\n"))])
            ]));
        };
        addSection("\u6B63\u5411", texts?.positive);
        addSection("\u8D1F\u5411", texts?.negative);

        const inner = $el("div", { className: "neo-lightbox-panel-inner" }, [body]);
        const frag = this._buildMetaButtons(meta, gallery, image, subfolder);
        if (frag.childNodes.length) {
            const btns = $el("div", { className: "neo-lightbox-panel-btns" });
            btns.appendChild(frag);
            inner.appendChild(btns);
        }
        return inner;
    }

    _fetchMediaMeta(image, subfolder) {
        // 按文件缓存元数据 Promise：翻页来回切换时不再重复请求，避免右侧面板文字闪烁。
        const key = `${subfolder}/${image.filename}`;
        if (!this._mediaMetaCache) this._mediaMetaCache = new Map();
        let p = this._mediaMetaCache.get(key);
        if (!p) {
            const params = `filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(subfolder)}`;
            p = fetch(`/neo_gallery/media_meta?${params}`).then(r => (r.ok ? r.text() : null)).then(txt => {
                if (!txt) return null;
                try {
                    return JSON.parse(txt);
                } catch (e) {
                    // ComfyUI 内嵌元数据可能含非标准 NaN/Infinity 字面量，替换后重试
                    return JSON.parse(txt.replace(/\bNaN\b/g, "null").replace(/\bInfinity\b/g, "null"));
                }
            }).catch(() => null);
            this._mediaMetaCache.set(key, p);
        }
        return p;
    }

    // 导入素材内嵌的 ComfyUI 工作流到画布（灯箱「导入工作流」按钮与卡片扩展菜单共用）。
    async _importWorkflowFromMedia(gallery, image, subfolder) {
        const meta = await this._fetchMediaMeta(image, subfolder);
        if (!meta || !meta.has) throw new Error(t("此素材没有内嵌工作流"));
        const wf = meta.workflow;
        const isUiFormat = !!(wf && Array.isArray(wf.nodes));
        const source = isUiFormat ? wf
            : (meta.prompt && typeof app.loadApiJson === "function") ? meta.prompt
            : null;
        if (!source) {
            throw new Error(wf ? t("工作流缺少 nodes 数据，无法载入") : t("此文件只有 API 格式工作流且当前前端不支持"));
        }
        if (isUiFormat) {
            await app.loadGraphData(source);
        } else {
            await app.loadApiJson(source, "gallery-example");
        }
        Lightbox.close();
        requestAnimationFrame(() => {
            const canvas = app.canvas;
            const nodes = canvas?.graph?.nodes;
            if (!nodes?.length || !canvas.ds) return;
            const b = [Infinity, Infinity, -Infinity, -Infinity];
            for (const n of nodes) {
                const r = n.boundingRect || [n.pos[0], n.pos[1], n.size?.[0] || 0, n.size?.[1] || 0];
                b[0] = Math.min(b[0], r[0]);
                b[1] = Math.min(b[1], r[1]);
                b[2] = Math.max(b[2], r[0] + r[2]);
                b[3] = Math.max(b[3], r[1] + r[3]);
            }
            if (!b.every(isFinite)) return;
            canvas.ds.fitToBounds([b[0] - 10, b[1] - 10, b[2] - b[0] + 20, b[3] - b[1] + 20]);
            canvas.setDirty?.(true, true);
        });
        showToast(gallery.app, "success", t("工作流已载入画布"), "");
    }

    _buildMetaButtons(meta, gallery, image, subfolder) {
        const frag = document.createDocumentFragment();
        if (meta.workflow || meta.prompt) {
            const loadBtn = document.createElement('div');
            loadBtn.className = "neo-lightbox-panel-btn";
            loadBtn.textContent = "\u2937 \u5BFC\u5165\u5DE5\u4F5C\u6D41";
            loadBtn.title = t("将此示例内嵌的 ComfyUI 工作流载入画布");
            loadBtn.onclick = async (e) => {
                e.stopPropagation();
                if (loadBtn.disabled) return;
                loadBtn.disabled = true;
                const origLabel = loadBtn.textContent;
                loadBtn.textContent = t("⏳ 检测中…");
                loadBtn.style.opacity = "0.6";
                try {
                    await this._importWorkflowFromMedia(gallery, image, subfolder);
                } catch (err) {
                    showToast(gallery.app, "error", t("导入失败"), String(err.message || err));
                } finally {
                    loadBtn.disabled = false;
                    loadBtn.textContent = origLabel;
                    loadBtn.style.opacity = "";
                }
            };
            frag.appendChild(loadBtn);
        }
        return frag;
    }
}
