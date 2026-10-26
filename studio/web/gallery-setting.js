/**
 * Gallery Setting - directory management modal (custom dirs, OSS, Civitai sync)
 */
import { $el } from "../../../../scripts/ui.js";
import { api } from "../../../../scripts/api.js";
import { showToast } from './gallery-utils.js';
import { icon } from "./js/core/icons.js";
import { t, tf } from "./js/core/i18n.js";

export class GallerySetting {
    constructor(gallery) {
        this.gallery = gallery;
    }


    // ====== Directory Management Modal ======

    async buildDirModal(gallery) {
        // Remove existing modal and overlay if any
        const existingModal = document.querySelector('.neo-gallery-dir-modal');
        if (existingModal) existingModal.remove();
        const existingOverlay = document.querySelector('.neo-gallery-dir-modal-overlay');
        if (existingOverlay) existingOverlay.remove();

        let currentDirs = [];
        let homeOrder = [];
        let hiddenDirs = new Set();
        let characterDirs = new Set();
        let civitaiKeySet = false;
        let civitaiKeyHint = "";
        let civitaiProxy = "";
        let loraSyncDirs = [];
        let civitaiEnabled = false;
        let civitaiBookmarkEnabled = true;
        try {
            const resp = await api.fetchApi('/neo_gallery/get_settings');
            if (resp.ok) {
                const settings = await resp.json();
                const dirs = settings.custom_directories || [];
                if (Array.isArray(dirs)) {
                    currentDirs = [...dirs];
                } else if (settings.custom_directory) {
                    currentDirs = [settings.custom_directory];
                }
                if (Array.isArray(settings.home_order)) homeOrder = [...settings.home_order];
                civitaiKeySet = !!settings.civitai_api_key_set;
                civitaiKeyHint = settings.civitai_api_key_hint || "";
                civitaiProxy = settings.civitai_proxy || "";
                civitaiEnabled = !!settings.civitai_lora_enabled;
                civitaiBookmarkEnabled = settings.civitai_bookmark_enabled !== false;
                if (Array.isArray(settings.lora_sync_dirs)) loraSyncDirs = [...settings.lora_sync_dirs];
                if (Array.isArray(settings.hidden_directories)) hiddenDirs = new Set(settings.hidden_directories.map((h) => String(h).toLowerCase()));
                if (Array.isArray(settings.character_dirs)) characterDirs = new Set(settings.character_dirs.map((c) => String(c).toLowerCase()));
            }
        } catch (e) { }

        // Create modal overlay
        const modalOverlay = $el("div", {
            className: "neo-gallery-dir-modal-overlay",
            onclick: (e) => { if (e.target === modalOverlay) gallery.closeDirModal(); }
        });

        const modal = $el("div", { className: "neo-gallery-dir-modal" });

        // Title bar
        const titleBar = $el("div", { className: "neo-gallery-dir-modal-titlebar" }, [
            $el("span", { className: "neo-gallery-dir-modal-title", textContent: "Manage Directories" }),
            $el("button", {
                className: "neo-gallery-dir-modal-refresh",
                title: t("强制重新拉取云端预设索引，新目录立刻出现在首页"),
                textContent: "\u27F3 " + t("刷新索引"),
                onclick: async (e) => {
                    e.stopPropagation();
                    e.target.disabled = true;
                    try {
                        const resp = await api.fetchApi('/neo_gallery/sync_oss', { method: 'POST' });
                        const result = await resp.json();
                        if (result.success) {
                            showToast(gallery.app, 'success', t('已刷新'),
                                tf("云端索引：{dirs} 个目录 / {items} 项", { dirs: result.directories, items: result.items }));
                            await reloadDirModalState();
                            refreshGallery();
                        } else {
                            showToast(gallery.app, 'error', t('刷新云端索引失败'), result.error || String(resp.status));
                        }
                    } catch (err) {
                        showToast(gallery.app, 'error', t('刷新云端索引失败'), String(err));
                    }
                    e.target.disabled = false;
                }
            }),
            $el("span", {
                className: "neo-gallery-dir-modal-close",
                onclick: () => gallery.closeDirModal(),
                textContent: "\u00D7"
            })
        ]);

        // Directory list area (compact rows: reorder / hide / remove)
        const dirListContainer = $el("div", { className: "neo-gallery-dir-list-container" }, [
            $el("div", { className: "neo-gallery-dir-section-title", textContent: t("素材目录") })
        ]);
        const dirItemsWrap = $el("div", { className: "neo-gallery-dir-items-wrap" });
        dirListContainer.appendChild(dirItemsWrap);

        const saveDirAction = async (payload) => {
            const resp = await api.fetchApi('/neo_gallery/save_settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            return resp.json();
        };

        const refreshGallery = async () => {
            try { await gallery.refreshAfterSettingsChange(); } catch (e) { }
        };

        // 内置板块与自定义目录共用同一张顺序表
        const BUILTIN_LABELS = { Output: "Output", Input: "Input", local_bookmarks: t("本地收藏"), civitai_bookmarks: t("C站收藏"), Lora: "Lora" };
        const OSS_PREFIX = "Cloud Presets/";
        const isOss = (token) => String(token).startsWith(OSS_PREFIX);
        const rowLabel = (token) => isOss(token) ? "\u2601 " + String(token).slice(OSS_PREFIX.length) : token;
        const entries = homeOrder.length ? homeOrder
            : ["Output", "Input", "local_bookmarks", "civitai_bookmarks", ...currentDirs, "Lora"];
        const isBuiltin = (t) => Object.prototype.hasOwnProperty.call(BUILTIN_LABELS, t);
        const isHidden = (t) => hiddenDirs.has(String(t).toLowerCase());
        const isCharacter = (t) => characterDirs.has(String(t).toLowerCase());

        let dragToken = null;

        const clearDropMarks = () => {
            dirItemsWrap.querySelectorAll(".drop-above, .drop-below").forEach((el) => {
                el.classList.remove("drop-above", "drop-below");
            });
        };

        const isAboveMid = (e, item) => {
            const rect = item.getBoundingClientRect();
            return e.clientY < rect.top + rect.height / 2;
        };

        const renderDirList = () => {
            dirItemsWrap.innerHTML = "";
            if (entries.length === 0) {
                dirItemsWrap.appendChild($el("div", {
                    className: "neo-gallery-dir-empty",
                    textContent: "No directories configured yet."
                }));
                return;
            }
            const dirItems = $el("div", { className: "neo-gallery-dir-items" });
            entries.forEach((token) => {
                const builtin = isBuiltin(token);
                const hidden = isHidden(token);
                const children = [
                    $el("span", {
                        className: "neo-gallery-dir-drag-handle",
                        textContent: "\u283F",
                        title: t("拖拽排序")
                    }),
                    $el("span", {
                        className: "neo-gallery-dir-path",
                        textContent: builtin ? BUILTIN_LABELS[token] : rowLabel(token),
                        title: builtin ? t("内置板块") : token
                    })
                ];
                if (hidden) {
                    children.push($el("span", { className: "neo-gallery-dir-hidden-badge", textContent: t("已隐藏") }));
                }
                if (isCharacter(token)) {
                    children.push($el("span", { className: "neo-gallery-dir-char-badge", textContent: t("角色图") }));
                }
                const actions = [];
                if (token === "Lora" || token === "civitai_bookmarks") {
                    actions.push($el("button", {
                        className: "neo-gallery-dir-ctl-btn neo-gallery-dir-settings-btn",
                        title: t("C 站设置（API KEY / 代理 / 同步目录）"),
                        onclick: (e) => {
                            e.stopPropagation();
                            toggleCivitaiSettings(token === "civitai_bookmarks" ? civitaiKeyInput : null);
                        }
                    }, [icon("gear", 13)]));
                }
                actions.push($el("button", {
                    className: "neo-gallery-dir-ctl-btn neo-gallery-dir-char-btn" + (isCharacter(token) ? " is-on" : ""),
                    title: isCharacter(token)
                        ? t("角色图目录（已标记）：从这里多选图片新建导演配方时默认全参考")
                        : t("标记为角色图目录：从这里多选图片新建导演配方时默认全参考，三视图不当关键帧"),
                    onclick: () => toggleDirCharacter(token)
                }, [icon("user", 13)]));
                actions.push($el("button", {
                    className: "neo-gallery-dir-ctl-btn",
                    title: hidden ? t("显示") : t("隐藏（不在素材库中列出）"),
                    onclick: () => toggleDirHidden(token)
                }, [icon("eye", 13)]));
                if (!builtin && !isOss(token)) {
                    actions.push($el("button", {
                        className: "neo-gallery-dir-remove-btn",
                        title: t("移除（仅从列表移除，不删除磁盘文件）"),
                        onclick: async (e) => {
                            e.stopPropagation();
                            if (!await gallery.removeCustomDir(token)) return;
                            currentDirs = currentDirs.filter(p => p !== token);
                            entries.splice(entries.indexOf(token), 1);
                            hiddenDirs.delete(String(token).toLowerCase());
                            characterDirs.delete(String(token).toLowerCase());
                            renderDirList();
                            refreshGallery();
                        },
                        textContent: "\u2715"
                    }));
                }
                children.push($el("div", { className: "neo-gallery-dir-item-actions" }, actions));
                const item = $el("div", {
                    className: "neo-gallery-dir-item" + (hidden ? " is-hidden" : ""),
                    draggable: "true",
                    ondragstart: (e) => {
                        dragToken = token;
                        item.classList.add("dragging");
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", token);
                    },
                    ondragover: (e) => {
                        if (!dragToken || dragToken === token) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        clearDropMarks();
                        item.classList.add(isAboveMid(e, item) ? "drop-above" : "drop-below");
                    },
                    ondrop: async (e) => {
                        e.preventDefault();
                        if (!dragToken || dragToken === token) return;
                        const before = isAboveMid(e, item);
                        entries.splice(entries.indexOf(dragToken), 1);
                        const target = entries.indexOf(token);
                        entries.splice(before ? target : target + 1, 0, dragToken);
                        dragToken = null;
                        clearDropMarks();
                        renderDirList();
                        try { await saveDirAction({ action: "reorder", paths: [...entries] }); } catch (e) { }
                        refreshGallery();
                    },
                    ondragend: () => {
                        dragToken = null;
                        item.classList.remove("dragging");
                        clearDropMarks();
                    }
                }, children);
                dirItems.appendChild(item);
            });
            dirItemsWrap.appendChild(dirItems);
        };

        // 刷新云端索引后新目录要立刻出现在这张表里，重读一次设置再重画
        const reloadDirModalState = async () => {
            try {
                const resp = await api.fetchApi('/neo_gallery/get_settings');
                if (!resp.ok) return;
                const settings = await resp.json();
                if (Array.isArray(settings.home_order)) { entries.length = 0; entries.push(...settings.home_order); }
                if (Array.isArray(settings.hidden_directories)) hiddenDirs = new Set(settings.hidden_directories.map((h) => String(h).toLowerCase()));
                if (Array.isArray(settings.character_dirs)) characterDirs = new Set(settings.character_dirs.map((c) => String(c).toLowerCase()));
                renderDirList();
            } catch (e) { }
        };

        const toggleDirHidden = async (token) => {
            const key = String(token).toLowerCase();
            try {
                const hidden = !hiddenDirs.has(key);
                const result = await saveDirAction({ action: "set_hidden", path: token, hidden });
                if (!result.success) return;
                if (hidden) hiddenDirs.add(key); else hiddenDirs.delete(key);
                renderDirList();
                await refreshGallery();
            } catch (e) {
                console.error('[Neo Gallery] Error toggling directory visibility:', e);
            }
        };

        const toggleDirCharacter = async (token) => {
            const key = String(token).toLowerCase();
            try {
                const character = !characterDirs.has(key);
                const result = await saveDirAction({ action: "set_character", path: token, character });
                if (!result.success) return;
                if (character) characterDirs.add(key); else characterDirs.delete(key);
                // 画廊实例同步：重读设置是异步的，先改本地集，选择栏文案与建配方默认模式立刻生效
                if (character) gallery.characterDirs?.add(key); else gallery.characterDirs?.delete(key);
                renderDirList();
                await refreshGallery();   // 画廊重读标记：选择栏按钮文案与建配方的默认模式跟着变
            } catch (e) {
                console.error('[Neo Gallery] Error toggling character directory:', e);
            }
        };

        renderDirList();

        // Add new directory input area
        const addArea = $el("div", { className: "neo-gallery-dir-add-area" }, [
            $el("label", { className: "neo-gallery-dir-label", textContent: t("新目录路径") }),
            $el("div", { className: "neo-gallery-dir-add-row" }, [
                $el("input", {
                    type: "text",
                    id: "neo-gallery-new-dir-input",
                    className: "neo-gallery-dir-input",
                    placeholder: t("粘贴或输入完整目录路径..."),
                    title: "Paste or type a full directory path here"
                }),
                $el("button", {
                    className: "neo-gallery-dir-add-btn",
                    onclick: async () => {
                        const input = document.getElementById('neo-gallery-new-dir-input');
                        const dirPath = input.value.trim();

                        if (!dirPath) return;

                        try {
                            const resp = await api.fetchApi('/neo_gallery/save_settings', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: "add", path: dirPath })
                            });
                            const result = await resp.json();

                            if (resp.ok && result.success) {
                                input.value = '';
                                if (!currentDirs.includes(dirPath)) currentDirs.push(dirPath);
                                if (!entries.includes(dirPath)) entries.push(dirPath);
                                renderDirList();
                                refreshGallery();
                            } else {
                                alert('Failed: ' + (result.error || 'Unknown error'));
                            }
                        } catch (e) {
                            console.error('[Neo Gallery] Error adding directory:', e);
                            alert('Error adding directory');
                        }
                    },
                    textContent: "\u27A4"
                })
            ])
        ]);


        // ====== Civitai LORA example sync ======
        const civitaiKeyInput = $el("input", {
            type: "password",
            className: "neo-gallery-dir-input",
            placeholder: civitaiKeySet ? `Civitai API KEY configured (${civitaiKeyHint}) \u2014 leave empty to keep` : "Civitai API KEY...",
            onkeydown: (e) => { if (e.key === "Enter") saveCivitaiKey(); },
        });

        const saveCivitaiKey = async () => {
            const value = civitaiKeyInput.value.trim();
            if (!value) {
                showToast(gallery.app, 'warning', 'Civitai API KEY', t('请输入 API KEY'));
                return;
            }
            try {
                const resp = await api.fetchApi('/neo_gallery/save_settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: "save_civitai", api_key: value })
                });
                const result = await resp.json();
                if (resp.ok && result.success && result.civitai_api_key_set) {
                    civitaiKeyInput.value = '';
                    civitaiKeySet = true;
                    civitaiKeyHint = result.civitai_api_key_hint || "";
                    civitaiKeyInput.placeholder = `Civitai API KEY configured (${civitaiKeyHint}) \u2014 leave empty to keep`;
                    showToast(gallery.app, 'success', t('已保存'), t('API KEY 已保存'));
                    pollLoraSync();
                } else {
                    showToast(gallery.app, 'error', t('保存失败'), result.error || t('后端未确认写入'));
                }
            } catch (e) {
                showToast(gallery.app, 'error', t('保存失败'), String(e));
            }
        };

        // C 站代理：多数网络直连 civitai.com 不通，代理在这里统一配置，
        // 画廊同步 / C 站收藏 / 技能修复 LoRA 下载 / 模型库 C 站源共用。
        const civitaiProxyInput = $el("input", {
            type: "text",
            className: "neo-gallery-dir-input",
            placeholder: t("如 http://127.0.0.1:7890，留空直连"),
            value: civitaiProxy,
            onkeydown: (e) => { if (e.key === "Enter") saveCivitaiProxy(); },
        });

        const saveCivitaiProxy = async () => {
            const value = civitaiProxyInput.value.trim();
            try {
                const resp = await api.fetchApi('/neo_gallery/save_settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: "save_civitai", proxy: value })
                });
                const result = await resp.json();
                if (resp.ok && result.success) {
                    civitaiProxy = value;
                    showToast(gallery.app, 'success', t('已保存'),
                        value ? tf("C 站代理已设为 {proxy}", { proxy: value }) : t('C 站已改为直连'));
                } else {
                    showToast(gallery.app, 'error', t('保存失败'), result.error || t('后端未确认写入'));
                }
            } catch (e) {
                showToast(gallery.app, 'error', t('保存失败'), String(e));
            }
        };

        const modalBody = $el("div", { className: "neo-gallery-dir-modal-body" });
        const leftPane = $el("div", { className: "neo-gallery-dir-modal-left" });
        modal.appendChild(titleBar);
        modal.appendChild(modalBody);
        modalBody.appendChild(leftPane);
        leftPane.appendChild(dirListContainer);

        // Civitai connectivity probe: the API is often unreachable without a proxy,
        // so let the user test it explicitly instead of guessing from failed fetches.
        const netResult = $el("div", { className: "neo-gallery-net-result", textContent: "" });
        const testNetBtn = $el("button", {
            className: "neo-gallery-dir-bulk-btn",
            textContent: t("测试 C 站连通性"),
            onclick: async () => {
                const label = testNetBtn.textContent;
                testNetBtn.disabled = true;
                testNetBtn.textContent = t("测试中...");
                netResult.className = "neo-gallery-net-result warn";
                netResult.textContent = t("正在连接 civitai.com（最长 20 秒）...");
                try {
                    const resp = await api.fetchApi('/neo_gallery/civitai_test', { method: 'POST' });
                    const r = await resp.json();
                    if (!resp.ok || !r.success) {
                        netResult.className = "neo-gallery-net-result err";
                        netResult.textContent = t("测试失败: ") + (r.error || resp.status);
                        showToast(gallery.app, 'error', t('C 站连通性'), t('连通性测试请求失败。'));
                        return;
                    }
                    const rejected = r.http_status === 401 || r.http_status === 403;
                    const cls = (!r.reachable || rejected) ? "err" : (r.key_ok ? "ok" : "warn");
                    netResult.className = `neo-gallery-net-result ${cls}`;
                    netResult.textContent = r.message;
                    showToast(gallery.app, cls === "ok" ? 'success' : cls === "warn" ? 'warning' : 'error',
                        t('C 站连通性'), r.message);
                } catch (e) {
                    netResult.className = "neo-gallery-net-result err";
                    netResult.textContent = t("测试失败: ") + e;
                    showToast(gallery.app, 'error', t('C 站连通性'), t('连通性测试请求失败。'));
                } finally {
                    testNetBtn.disabled = false;
                    testNetBtn.textContent = label;
                }
            }
        });
        const loraDirsList = $el("div", { className: "neo-gallery-lora-dirs", style: { display: "none" } });
        let loraDirsLoaded = false;
        const loadLoraDirs = async () => {
            loraDirsList.innerHTML = '';
            loraDirsList.appendChild($el("div", { className: "neo-gallery-lora-progress", textContent: "Loading lora directories..." }));
            try {
                const resp = await api.fetchApi('/neo_gallery/lora_dirs');
                const data = await resp.json();
                const dirs = data.dirs || [];
                loraDirsList.innerHTML = '';
                if (!dirs.length) {
                    loraDirsList.appendChild($el("div", { className: "neo-gallery-lora-progress", textContent: "No lora files found in models/loras." }));
                    return;
                }
                for (const d of dirs) {
                    const label = d.path === "" ? "(loras root)" : d.path;
                    const cb = $el("input", { type: "checkbox" });
                    cb.checked = loraSyncDirs.includes(d.path);
                    cb.onchange = async () => {
                        if (cb.checked) {
                            if (!loraSyncDirs.includes(d.path)) loraSyncDirs.push(d.path);
                        } else {
                            loraSyncDirs = loraSyncDirs.filter(p => p !== d.path);
                        }
                        try {
                            const resp = await api.fetchApi('/neo_gallery/save_settings', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: "save_civitai", dirs: loraSyncDirs })
                            });
                            const result = await resp.json();
                            if (!resp.ok || !result.success) {
                                showToast(gallery.app, 'error', t('保存失败'), result.error || t('LORA 目录选择未保存'));
                            } else {
                                pollLoraSync();
                            }
                        } catch (e) {
                            showToast(gallery.app, 'error', t('保存失败'), String(e));
                        }
                    };
                    loraDirsList.appendChild($el("label", { className: "neo-gallery-lora-dir-item" }, [cb, `${label} (${d.count})`]));
                }
            } catch (e) {
                loraDirsList.innerHTML = '';
                loraDirsList.appendChild($el("div", { className: "neo-gallery-lora-progress", textContent: "Failed to load lora directories." }));
            }
        };
        const loraDirsToggle = $el("button", {
            className: "neo-gallery-dir-bulk-btn",
            textContent: "Select LORA Directories",
            onclick: () => {
                const hidden = loraDirsList.style.display === "none";
                loraDirsList.style.display = hidden ? "" : "none";
                if (hidden && !loraDirsLoaded) { loraDirsLoaded = true; loadLoraDirs(); }
            }
        });

        // Lora / C站收藏行的 ：展开（默认隐藏）或收起 C 站设置区
        const toggleCivitaiSettings = (focusInput) => {
            if (civitaiArea.style.display !== "none") {
                civitaiArea.style.display = "none";
                return;
            }
            civitaiArea.style.display = "";
            const target = focusInput || civitaiArea;
            if (typeof target.scrollIntoView === "function") {
                target.scrollIntoView({ behavior: "smooth", block: "start" });
            }
            if (focusInput) focusInput.focus();
            if (loraDirsList.style.display === "none") {
                loraDirsList.style.display = "";
                if (!loraDirsLoaded) { loraDirsLoaded = true; loadLoraDirs(); }
            }
        };

        const loraProgress = $el("div", { className: "neo-gallery-lora-progress", textContent: "" });
        const retryBtn = $el("button", {
            className: "neo-gallery-dir-bulk-btn",
            textContent: "Retry Failed",
            style: { display: "none" },
            onclick: async () => {
                try {
                    const resp = await api.fetchApi('/neo_gallery/lora_retry_failed', { method: 'POST' });
                    const result = await resp.json();
                    if (resp.ok && result.count > 0) {
                        showToast(gallery.app, 'success', 'Retry Queued', `Re-queued ${result.count} failed loras.`);
                        pollLoraSync();
                    }
                } catch (e) { }
            }
        });
        let loraPollTimer = null;
        const pollLoraSync = async () => {
            if (loraPollTimer) { clearInterval(loraPollTimer); loraPollTimer = null; }
            const tick = async () => {
                if (!document.querySelector('.neo-gallery-dir-modal')) {
                    clearInterval(loraPollTimer); loraPollTimer = null;
                    return;
                }
                try {
                    const resp = await api.fetchApi('/neo_gallery/lora_cache_status');
                    const st = await resp.json();
                    const failHint = st.failed ? tf(" · {n} failed（可点「测试 C 站连通性」排查网络）", { n: st.failed }) : '';
                    if (st.running) {
                        loraProgress.textContent = `Auto-caching ${st.done}/${st.total} \u00B7 ${st.current || ''}${st.failed ? ` \u00B7 failed ${st.failed}` : ''}`;
                        retryBtn.style.display = st.failed > 0 ? '' : 'none';
                    } else {
                        clearInterval(loraPollTimer); loraPollTimer = null;
                        retryBtn.style.display = st.failed > 0 ? '' : 'none';
                        if (st.error) {
                            loraProgress.textContent = st.error;
                        } else if (st.pending_count) {
                            let reason;
                            if (!st.master_enabled) reason = t('总开关已关闭');
                            else if (!st.enabled) reason = t('需配置 C 站 API KEY');
                            else reason = `fetches on access${failHint}`;
                            loraProgress.textContent = `${st.pending_count} lora(s) queued \u00B7 ${reason}`;
                        } else {
                            loraProgress.textContent = st.failed ? tf("{n} failed（可点「测试 C 站连通性」排查网络）", { n: st.failed }) : '';
                        }
                    }
                } catch (e) { }
            };
            loraPollTimer = setInterval(tick, 1500);
            tick();
        };

        const civitaiArea = $el("div", { className: "neo-gallery-civitai-area", style: { display: "none" } }, [
            $el("div", { className: "neo-gallery-civitai-title", textContent: t("Civitai（C 站同步）") }),
            $el("label", { className: "neo-gallery-civitai-toggle" }, [
                $el("input", {
                    type: "checkbox",
                    checked: civitaiEnabled,
                    onchange: async (e) => {
                        civitaiEnabled = !!e.target.checked;
                        try {
                            await api.fetchApi('/neo_gallery/save_settings', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: "save_civitai", enabled: civitaiEnabled })
                            });
                            showToast(gallery.app, 'success', civitaiEnabled ? t('已启用') : t('已停用'), civitaiEnabled ? t('C 站 LORA 示例获取已开启。') : t('C 站 LORA 示例获取已关闭。'));
                            await gallery.refreshAfterSettingsChange();
                        } catch (err) {
                            showToast(gallery.app, 'error', 'Save Failed', 'Failed to save the Civitai LORA switch.');
                        }
                    }
                }),
                $el("span", { textContent: t("启用 C 站 LORA（访问时自动获取示例图）") })
            ]),
            $el("label", { className: "neo-gallery-civitai-toggle" }, [
                $el("input", {
                    type: "checkbox",
                    checked: civitaiBookmarkEnabled,
                    onchange: async (e) => {
                        civitaiBookmarkEnabled = !!e.target.checked;
                        try {
                            await api.fetchApi('/neo_gallery/save_settings', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: "save_civitai", bookmark_enabled: civitaiBookmarkEnabled })
                            });
                            showToast(gallery.app, 'success', civitaiBookmarkEnabled ? t('已启用') : t('已停用'),
                                civitaiBookmarkEnabled ? t('C 站收藏已开启。') : t('C 站收藏已关闭。'));
                            await gallery.refreshAfterSettingsChange();
                        } catch (err) {
                            showToast(gallery.app, 'error', 'Save Failed', 'Failed to save the Civitai bookmarks switch.');
                        }
                    }
                }),
                $el("span", { textContent: t("启用 C 站收藏（默认开启）") })
            ]),
            $el("label", { className: "neo-gallery-dir-label", textContent: "Civitai API KEY" }),
            $el("div", { className: "neo-gallery-civitai-key-row" }, [
                civitaiKeyInput,
                $el("button", {
                    className: "neo-gallery-dir-bulk-btn neo-gallery-civitai-save-btn",
                    textContent: t("保存"),
                    onclick: saveCivitaiKey,
                }),
            ]),
            $el("label", { className: "neo-gallery-dir-label", textContent: t("C 站代理") }),
            $el("div", { className: "neo-gallery-civitai-key-row" }, [
                civitaiProxyInput,
                $el("button", {
                    className: "neo-gallery-dir-bulk-btn neo-gallery-civitai-save-btn",
                    textContent: t("保存代理"),
                    onclick: saveCivitaiProxy,
                }),
            ]),
            $el("div", { className: "neo-gallery-civitai-actions" }, [testNetBtn]),
            netResult,
            $el("div", { className: "neo-gallery-lora-progress", textContent: "Examples are cached automatically when the Lora section is accessed." }),
            loraDirsToggle,
            loraDirsList,
            retryBtn,
            loraProgress,
        ]);

        leftPane.appendChild(addArea);
        modalBody.appendChild(civitaiArea);
        modalOverlay.appendChild(modal);
        document.body.appendChild(modalOverlay);

        setTimeout(() => {
            const input = document.getElementById('neo-gallery-new-dir-input');
            if (input) input.focus();
        }, 100);
    }
}
