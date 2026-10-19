/**
 * lightbox.js — Neo Studio 通用 Lightbox 组件（自包含、可复用）。
 *
 * 全屏媒体查看：深色遮罩 + 居中卡片；图片滚轮缩放(0.5–5x) + 拖拽平移；
 * ←/→ 翻页（箭头按钮 + i/n 计数）；Esc 关闭/退出全屏；F 键全屏；点遮罩关闭。
 * 单例：同一时刻只有一个实例，再次 open() 会替换当前实例并清理其监听器。
 *
 * 用法：
 *   Lightbox.open({
 *     items: [{ kind: 'image'|'video'|'audio', url, title, resolve }],
 *     index: 0,    // 可选：起始项
 *     compact: true,   // 可选：弹出窗口形态（薄遮罩 + 收小卡片），右栏产物预览用，不铺满整扇窗口
 *     actions: (item, index) => [{ label, title, icon, onClick(item, lightbox, button) }], // 函数按项定额外按钮；也接受普通数组；icon 取 core/icons.js 的名字，按钮文字前带图标
 *     panel: (item, index) => Node | null,   // 可选：右侧信息栏，按项重建；返回空则不占位
 *   });
 *
 * item.resolve 为可选的异步取源函数，返回可直接赋给 src 的地址（blob:/http:）。
 * 用于需要鉴权或需精确判断加载完成的媒体：加载期间显示 spinner，地址由本组件回收。
 * 缩放/平移跨翻页保持，仅关闭时复位；翻页时新图按上一张渲染尺寸占位，避免布局跳动。
 */
import { $el } from "../../../../scripts/ui.js";
import { t } from "./js/core/i18n.js";
import { icon } from "./js/core/icons.js";

// 组件自带样式（幂等注入，调用方无需单独加载 CSS）
if (!document.getElementById('neo-lightbox-css')) {
    const link = document.createElement('link');
    link.id = 'neo-lightbox-css';
    link.rel = 'stylesheet';
    link.href = '/extensions/comfyui-neo-studio/lightbox.css';
    document.head.appendChild(link);
}

export class Lightbox {
    static get instance() {
        if (!this._instance) this._instance = new Lightbox();
        return this._instance;
    }

    /** 打开 Lightbox；重复调用会替换当前实例。options: { items, index, actions, panel, compact }。 */
    static open(options) { return Lightbox.instance.open(options); }

    static close() { return Lightbox.instance.close(); }

    constructor() {
        this.items = [];
        this.index = 0;
        this.actionsProvider = null;
        this.panelProvider = null;

        this._resolved = new Map();   // 预加载完成但尚未展示的媒体地址
        this._loadToken = 0;
        this._panelToken = 0;

        this._root = null;      // 遮罩
        this._box = null;       // 卡片
        this._stage = null;     // 媒体区
        this._media = null;     // 当前媒体元素
        this._caption = null;
        this._counter = null;
        this._toolbar = null;
        this._prevBtn = null;
        this._nextBtn = null;
        this._fullBtn = null;
        this._closeBtn = null;

        // 图片缩放/平移状态
        this._scale = 1;
        this._panX = 0;
        this._panY = 0;
        this._dragging = false;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._zoomHandlers = null;

        this._onKey = null;
        this._onFsChange = null;
    }

    open({ items = [], index = 0, actions = null, panel = null, compact = false } = {}) {
        this.close();
        if (!items.length) return this;

        this.items = items;
        this.actionsProvider = actions;
        this.panelProvider = panel;
        this.index = Math.max(0, Math.min(index, items.length - 1));

        this._root = $el('div', {
            className: compact ? 'neo-lightbox neo-lightbox-compact' : 'neo-lightbox',
            onclick: (e) => { if (e.target === this._root) this.close(); }
        });

        this._closeBtn = $el('button', {
            className: 'neo-lightbox-close', textContent: '×',
            title: t("关闭（Esc）"),
            onclick: (e) => { e.stopPropagation(); this.close(); }
        });
        this._prevBtn = $el('button', {
            className: 'neo-lightbox-nav neo-lightbox-prev', textContent: '‹',
            title: t("上一张（←）"),
            onclick: (e) => { e.stopPropagation(); this.navigate(-1); }
        });
        this._nextBtn = $el('button', {
            className: 'neo-lightbox-nav neo-lightbox-next', textContent: '›',
            title: t("下一张（→）"),
            onclick: (e) => { e.stopPropagation(); this.navigate(1); }
        });
        this._fullBtn = $el('button', {
            className: 'neo-lightbox-nav neo-lightbox-full', textContent: '⛶',
            title: t("全屏（F）"),
            onclick: (e) => { e.stopPropagation(); this.toggleFullscreen(); }
        });

        // 关闭/全屏按钮挂在媒体区内：贴图片角落，不遮挡侧栏
        this._stage = $el('div', { className: 'neo-lightbox-stage' }, [this._closeBtn, this._fullBtn]);
        this._caption = $el('div', { className: 'neo-lightbox-caption' });
        this._counter = $el('span', { className: 'neo-lightbox-counter' });
        this._dims = $el('span', { className: 'neo-lightbox-dims' });
        this._toolbar = $el('div', { className: 'neo-lightbox-toolbar' });
        const meta = $el('div', { className: 'neo-lightbox-meta' }, [this._counter, this._caption, this._dims, this._toolbar]);
        this._panelHost = $el('div', { className: 'neo-lightbox-panel' });
        const main = $el('div', { className: 'neo-lightbox-main' }, [this._stage, meta]);

        this._box = $el('div', { className: 'neo-lightbox-box' }, [
            main,
            this._panelHost,
            this._prevBtn,
            this._nextBtn
        ]);
        this._root.appendChild(this._box);
        document.body.appendChild(this._root);
        this._render();

        this._onKey = (e) => {
            switch (e.key) {
                case 'ArrowLeft': this.navigate(-1); break;
                case 'ArrowRight': this.navigate(1); break;
                case 'Escape':
                    if (document.fullscreenElement) document.exitFullscreen();
                    else this.close();
                    break;
                case 'f':
                case 'F':
                    // 视频项不响应 F 全屏（用原生控件全屏）
                    if (this.items[this.index]?.kind !== 'video') this.toggleFullscreen();
                    break;
            }
        };
        document.addEventListener('keydown', this._onKey);

        this._onFsChange = () => {
            if (!document.fullscreenElement) {
                this._box?.classList.remove('fullscreen-mode');
                this._root?.classList.remove('neo-lightbox-fullscreen');
            }
        };
        document.addEventListener('fullscreenchange', this._onFsChange);
        return this;
    }

    _render() {
        if (!this._stage) return;
        const item = this.items[this.index];
        if (!item) return;

        // 释放远离当前项的预加载结果，避免 blob 随翻页累积
        for (const [key, url] of this._resolved) {
            if (Math.abs(this.items.indexOf(key) - this.index) > 1) {
                this._resolved.delete(key);
                URL.revokeObjectURL(url);
            }
        }

        this._removeZoom();
        // 记录旧媒体渲染尺寸：新图未加载前撑住布局，避免翻页时面板跳动
        let keepW = 0;
        let keepH = 0;
        if (this._media) {
            keepW = this._media.clientWidth;
            keepH = this._media.clientHeight;
            if (this._media.tagName === 'VIDEO') { this._media.pause(); this._media.src = ''; }
            this._media.remove();
            this._media = null;
        }

        const kind = item.kind || 'image';
        const tag = kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'img';
        const media = document.createElement(tag);
        media.className = `neo-lightbox-media neo-lightbox-${kind}`;
        media.draggable = false;
        if (tag === 'video') { media.controls = true; media.autoplay = true; media.loop = true; }
        else if (tag === 'audio') { media.controls = true; }
        else { media.alt = item.title || ''; }
        if (keepW && keepH) {
            media.style.width = `${keepW}px`;
            media.style.height = `${keepH}px`;
            const releaseKeep = () => { media.style.width = ''; media.style.height = ''; };
            media.addEventListener(kind === 'image' ? 'load' : 'loadedmetadata', releaseKeep, { once: true });
            media.addEventListener('error', releaseKeep, { once: true });
        }
        this._stage.appendChild(media);
        this._media = media;

        if (kind === 'image') {
            this._loadImageSource(media, item);
            this._attachZoom();
            if (this._scale !== 1) this._applyTransform();
        } else {
            media.src = item.url;
        }

        this._dims.textContent = '';
        const showDims = () => {
            this._dims.textContent = kind === 'video'
                ? `${media.videoWidth} \u00d7 ${media.videoHeight}`
                : `${media.naturalWidth} \u00d7 ${media.naturalHeight}`;
        };
        media.addEventListener(kind === 'image' ? 'load' : 'loadedmetadata', showDims, { once: true });

        this._caption.textContent = item.title || '';
        this._counter.textContent = this.items.length > 1 ? `${this.index + 1} / ${this.items.length}` : '';
        this._prevBtn.disabled = this.index <= 0;
        this._nextBtn.disabled = this.index >= this.items.length - 1;
        // 视频原生控件自带全屏按钮，隐藏自定义全屏按钮
        this._fullBtn.classList.toggle('neo-lightbox-hidden', kind === 'video');

        // 动作按钮：函数可按当前项定制，数组则所有项相同
        this._toolbar.innerHTML = '';
        const actions = typeof this.actionsProvider === 'function'
            ? (this.actionsProvider(item, this.index) || [])
            : (this.actionsProvider || []);
        for (const a of actions) {
            const btn = $el('button', {
                className: 'neo-lightbox-action',
                title: a.title || a.label,
                onclick: (e) => { e.stopPropagation(); a.onClick?.(item, this, btn); }
            }, a.icon ? [icon(a.icon), " " + a.label] : [a.label]);
            this._toolbar.appendChild(btn);
        }

        // 侧栏：调用方按项构建，可异步填充；返回空则不占位
        this._renderPanel(item);

        this._root.classList.toggle('neo-lightbox-single', this.items.length <= 1);
        this._preloadNeighbors();
    }
    // panelProvider 可返回 Node、Promise<Node> 或 null；异步结果晚到时丢弃过期渲染
    _renderPanel(item) {
        const token = ++this._panelToken;
        this._panelHost.innerHTML = '';
        this._box.classList.remove('neo-lightbox-with-panel');

        const panel = typeof this.panelProvider === 'function' ? this.panelProvider(item, this.index) : null;
        if (!panel) return;

        const append = (node) => {
            if (token !== this._panelToken || !node) return;
            this._panelHost.appendChild(node);
            this._box.classList.add('neo-lightbox-with-panel');
        };
        if (typeof panel.then === 'function') {
            panel.then(append).catch(() => {});
            return;
        }
        append(panel);
    }

    // 面板内容变化后（如反推完成）由调用方刷新当前侧栏
    refreshPanel() {
        const item = this.items[this.index];
        if (item) this._renderPanel(item);
    }

    // item.resolve() 返回可赋给 src 的地址（blob:/http:），加载完成后由本组件回收
    _loadImageSource(media, item) {
        if (!item.resolve) { media.src = item.url; return; }

        const cached = this._resolved.get(item);
        if (cached !== undefined) {
            this._resolved.delete(item);
            const revokeCached = () => URL.revokeObjectURL(cached);
            media.addEventListener('load', revokeCached, { once: true });
            media.addEventListener('error', revokeCached, { once: true });
            media.src = cached;
            return;
        }

        const token = ++this._loadToken;
        const spinner = $el('div', { className: 'neo-lightbox-spinner' });
        this._stage.appendChild(spinner);
        const finish = () => { if (spinner.isConnected) spinner.remove(); };
        media.addEventListener('load', finish, { once: true });
        media.addEventListener('error', finish, { once: true });
        item.resolve().then((url) => {
            if (token !== this._loadToken) { URL.revokeObjectURL(url); return; }
            const revoke = () => URL.revokeObjectURL(url);
            media.addEventListener('load', revoke, { once: true });
            media.addEventListener('error', revoke, { once: true });
            media.src = url;
        }).catch(finish);
    }

    _preloadNeighbors() {
        for (const idx of [this.index - 1, this.index + 1]) {
            const neighbor = this.items[idx];
            if (!neighbor?.resolve || this._resolved.has(neighbor)) continue;
            neighbor.resolve().then((url) => {
                if (!this.items.includes(neighbor)) { URL.revokeObjectURL(url); return; }
                this._resolved.set(neighbor, url);
            }).catch(() => {});
        }
    }

    navigate(direction) {
        const next = this.index + direction;
        if (next < 0 || next >= this.items.length) return;
        this.index = next;
        this._render();
    }

    // ===== 图片缩放 / 拖拽平移 =====

    _attachZoom() {
        if (!this._media || this._media.tagName !== 'IMG' || !this._stage) return;
        const stage = this._stage;
        const handlers = {};

        handlers.wheel = (e) => {
            e.preventDefault(); e.stopPropagation();
            this._scale = Math.max(0.5, Math.min(5, this._scale + (e.deltaY > 0 ? -0.1 : 0.1)));
            this._applyTransform();
        };
        handlers.down = (e) => {
            if (this._scale <= 1) return;
            e.preventDefault(); e.stopPropagation();
            this._dragging = true;
            this._dragStartX = e.clientX - this._panX;
            this._dragStartY = e.clientY - this._panY;
        };
        handlers.move = (e) => {
            if (!this._dragging) return;
            e.preventDefault(); e.stopPropagation();
            this._panX = e.clientX - this._dragStartX;
            this._panY = e.clientY - this._dragStartY;
            this._applyTransform();
        };
        handlers.up = () => { this._dragging = false; this._applyTransform(); };
        handlers.leave = () => { this._dragging = false; this._applyTransform(); };

        stage.addEventListener('wheel', handlers.wheel, { passive: false });
        stage.addEventListener('mousedown', handlers.down);
        stage.addEventListener('mousemove', handlers.move);
        stage.addEventListener('mouseup', handlers.up);
        stage.addEventListener('mouseleave', handlers.leave);
        this._zoomHandlers = handlers;
    }

    _removeZoom() {
        if (!this._zoomHandlers || !this._stage) return;
        const { wheel, down, move, up, leave } = this._zoomHandlers;
        this._stage.removeEventListener('wheel', wheel);
        this._stage.removeEventListener('mousedown', down);
        this._stage.removeEventListener('mousemove', move);
        this._stage.removeEventListener('mouseup', up);
        this._stage.removeEventListener('mouseleave', leave);
        this._zoomHandlers = null;
    }

    // 缩放/平移跨翻页保持，仅在关闭时复位
    _resetTransform() {
        this._scale = 1;
        this._panX = 0;
        this._panY = 0;
        this._dragging = false;
    }

    _applyTransform() {
        if (!this._media) return;
        if (this._scale === 1) {
            this._media.style.transform = 'none';
            this._media.style.cursor = 'default';
        } else {
            this._media.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._scale})`;
            this._media.style.cursor = this._dragging ? 'grabbing' : 'grab';
        }
    }

// ===== 全屏 =====

    toggleFullscreen() {
        if (!this._box) return;
        if (!document.fullscreenElement) {
            this._box.classList.add('fullscreen-mode');
            this._root?.classList.add('neo-lightbox-fullscreen');
            this._box.requestFullscreen?.();
        } else {
            this._box.classList.remove('fullscreen-mode');
            this._root?.classList.remove('neo-lightbox-fullscreen');
            document.exitFullscreen?.();
        }
    }

    close() {
        this._removeZoom();
        this._resetTransform();
        this._panelToken++;   // 丢弃尚未返回的异步面板结果
        for (const url of this._resolved.values()) URL.revokeObjectURL(url);
        this._resolved.clear();
        if (this._onKey) { document.removeEventListener('keydown', this._onKey); this._onKey = null; }
        if (this._onFsChange) { document.removeEventListener('fullscreenchange', this._onFsChange); this._onFsChange = null; }
        if (this._root) { this._root.remove(); this._root = null; }
        this.items = [];
        this.index = 0;
        this.actionsProvider = null;
        this.panelProvider = null;
    }
}