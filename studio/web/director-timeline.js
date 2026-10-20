// Neo Studio 导演时间轴组件。
// 按 duration_sec 比例绘制分段块 + 顶部秒刻度尺，支持点击选中、拖拽重排。
// 数据完全由宿主通过 options.getSegments() 提供（返回当前顺序的数组），因此可挂到
// 任意容器——导演编辑器浮层或 NeoH3VideoDirector 节点 DOM 均可复用同一组件。
//
// getSegments() 应返回：[{ duration, prompt, thumbUrl }]，顺序即宿主当前分段顺序。
// 段色相一律按当前位置着色（节点与编辑器复用同一组件、同一配色，始终一致）。
// 回调：onSelect(index)、onReorder(order)（原始索引的新排列）、
//       onResize(index, durationSec)（拖块右缘调时长，吸附 0.5s、最小 1s；仅非 readOnly）、
//       onAdd()（点击时间轴尾部「＋」按钮添加段；仅非 readOnly 且提供时显示）。
// checkable：块左上角画勾选框，点击勾选框切换「本次运行是否包含该段」（不触发 onSelect），
//            宿主用 getChecked() 取结果；勾选是运行期临时状态，组件不保存也不落盘。
//            勾选框只在悬停该块时出现（已勾选的常显），命中区比视觉框大一圈，避免误触成「点块打开编辑器」。
// 回调：onCheckChange(checkedIndices)

import { t } from "./js/core/i18n.js";

const DT_CSS_HREF = "/extensions/comfyui-neo-studio/director-timeline.css";
const DT_MIN_ZOOM = 0.25;    // 时间轴最小缩放（缩小看更多段）
const DT_MAX_ZOOM = 4;       // 时间轴最大缩放倍数
const DT_RULER_H = 18;       // 顶部秒刻度尺高度
const DT_TOP_GAP = 4;        // 刻度尺与块之间的间距
const DT_BOTTOM_PAD = 6;     // 块底部留白（横向滚动条与悬停时间提示占这一带）
const DT_CHECK_S = 13;       // 「仅运行勾选的段」勾选框边长（checkable 时间轴）
const DT_CHECK_PAD = 7;      // 勾选框命中区外扩（点得更稳，避免误触成「点块打开编辑器」）

export class DirectorTimeline {
  constructor(container, options) {
    this.container = container;
    this.opts = Object.assign({ height: 92, getSegments: () => [], onSelect: null, onReorder: null, onDropImage: null, onAdd: null, checkable: false, onCheckChange: null, readOnly: false, getProgress: () => ({ active: false, segment_index: -1, total_segments: 0 }) }, options);
    this._segs = [];
    this._checked = new Set(); // 勾选的段索引（0 基；仅 checkable）：本次运行只跑这些段
    this._progress = null; // 当前 director 运行进度（宿主经 getProgress() 提供）
    this._thumbs = new Map(); // url -> HTMLImageElement
    this._selected = -1;
    this._drag = null; // { src, order, moved, startX, cursorX }
    this._hover = null; // 悬停块索引（高亮 + 时间范围提示）
    this._dropOver = -1; // 素材拖放悬停块索引（-1=无）
    this._addHover = false; // 是否悬停在时间轴尾部「＋」按钮上
    this._raf = 0;

    this._ensureCss();
    // 横向滚动容器：拉伸（zoom>1）时内容宽度超过可视区，超出部分横向滚动
    this.scroll = document.createElement("div");
    this.scroll.className = "neo-dtl-scroll";
    this.scroll.style.height = (this.opts.height || 0) + "px";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "neo-dtl-canvas";
    this.canvas.style.cssText = "display:block;cursor:pointer;";
    this.scroll.appendChild(this.canvas);

    // 拉伸（zoom）状态：由宿主经 setZoom() 控制；>1 时内容变宽并横向滚动
    this._zoom = 1;
    container.appendChild(this.scroll);
    // 内容超出可视区（放大或最小宽导致）时：鼠标滚轮驱动横向滚动；stopPropagation 挡掉画布平移/缩放
    this.scroll.addEventListener("wheel", (e) => {
      if (this._width() <= this._visibleWidth()) return;
      e.stopPropagation();
      if (e.deltaX === 0 && e.deltaY !== 0) {
        e.preventDefault();
        this.scroll.scrollLeft += e.deltaY;
      }
    }, { passive: false });
    this.ctx = this.canvas.getContext("2d");

    this._onMoveB = (e) => this._onMove(e);
    this._onUpB = (e) => this._onUp(e);
    this.canvas.addEventListener("mousedown", (e) => this._onDown(e));
    this.canvas.addEventListener("mousemove", (e) => this._hoverAt(e));
    this.canvas.addEventListener("mouseleave", () => { if (this._hover !== null || this._addHover) { this._hover = null; this._addHover = false; this.refresh(); } });
    this.canvas.addEventListener("dragover", (e) => this._onDragOver(e));
    this.canvas.addEventListener("dragleave", (e) => this._onDragLeave(e));
    this.canvas.addEventListener("drop", (e) => this._onDrop(e));
    this._ro = new ResizeObserver(() => this.refresh());
    this._ro.observe(container);
    this.refresh();
  }

  _ensureCss() {
    if (document.querySelector('link[data-neo-dtl="1"]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = DT_CSS_HREF;
    link.setAttribute("data-neo-dtl", "1");
    document.head.appendChild(link);
  }

  // 宿主在数据变化（增删/重排/时长/首帧）后调用，或组件内部缩略图加载完成后调用。
  refresh() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._doRefresh();
    });
  }

  _doRefresh() {
    const segs = (this.opts.getSegments && this.opts.getSegments()) || [];
    this._segs = segs;
    // 段数变化（换配方 / 删段）→ 越界勾选失效，丢弃并回报宿主（勾选不落盘，仅当前会话有效）
    if (this._checked.size) {
      let dropped = false;
      for (const i of Array.from(this._checked)) {
        if (i >= segs.length) { this._checked.delete(i); dropped = true; }
      }
      if (dropped && this.opts.onCheckChange) this.opts.onCheckChange(this.getChecked());
    }
    this._progress = (this.opts.getProgress && this.opts.getProgress()) || null;
    for (const s of segs) {
      const urls = [s.thumbUrl].concat(Array.isArray(s.matThumbs) ? s.matThumbs : []);
      for (const u of urls) {
        if (!u || this._thumbs.has(u)) continue;
        const img = new Image();
        img.onload = () => this.refresh();
        img.src = u;
        this._thumbs.set(u, img);
      }
    }
    this._draw();
  }

  select(i) {
    this._selected = i;
    if (this.opts.onSelect) this.opts.onSelect(i);
    this.refresh();
  }

  /** 勾选的段索引（0 基升序）：只读数组拷贝，宿主在点运行/生成时取用。 */
  getChecked() {
    return Array.from(this._checked).sort((a, b) => a - b);
  }

  /** 清空勾选（换配方 / 工作流加载时调用；有变化才回报宿主）。 */
  clearChecked() {
    if (!this._checked.size) return;
    this._checked.clear();
    this.refresh();
    if (this.opts.onCheckChange) this.opts.onCheckChange(this.getChecked());
  }

  // 勾选框（仅 checkable）：块左上角，序号徽标随之右移
  _checkRect(x, top) {
    return { x: x + 5, y: top + 4, s: DT_CHECK_S };
  }

  // 勾选框是否显示：已勾选的常显（一眼看到哪些段会跑），未勾选只在悬停该块时出现
  _checkVisible(idx, checked) {
    return !!this.opts.checkable && (!!checked || this._hover === idx);
  }

  // 勾选框命中区：视觉框外扩一圈，点得更稳
  _checkHitRect(x, top) {
    const c = this._checkRect(x, top);
    return { x: c.x - DT_CHECK_PAD, y: c.y - DT_CHECK_PAD, s: c.s + DT_CHECK_PAD * 2 };
  }

  // 事件坐标 → 画布本地坐标。画布被画布缩放（节点 zoom）时 getBoundingClientRect() 是屏幕尺寸，
  // 与布局用的本地像素差一个比例；不归一的话勾选框 / 分段块命中会整体偏移（点勾选变点块）。
  _localPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const layoutW = this.canvas.clientWidth || rect.width || 1;
    const k = rect.width > 0 ? layoutW / rect.width : 1;
    return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k };
  }

  // 点击点是否落在第 i 块的勾选框命中区内（拖动重排只在编辑器里，checkable 时间轴不重排，下标即块序）
  _hitsCheck(x, y, i) {
    const b = this._layout().blocks.find((bb) => bb.i === i);
    if (!b) return false;
    const c = this._checkHitRect(b.x, DT_RULER_H + DT_TOP_GAP);
    return x >= c.x && x <= c.x + c.s && y >= c.y && y <= c.y + c.s;
  }

  _toggleChecked(i) {
    if (this._checked.has(i)) this._checked.delete(i);
    else this._checked.add(i);
    this.refresh();
    if (this.opts.onCheckChange) this.opts.onCheckChange(this.getChecked());
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    window.removeEventListener("mousemove", this._onMoveB);
    window.removeEventListener("mouseup", this._onUpB);
    if (this.scroll.parentNode) this.scroll.parentNode.removeChild(this.scroll);
  }

  // 设置时间轴缩放倍数（作用于自然内容宽：>1 放大、<1 缩小；超出可视区横向滚动）。
  setZoom(z) {
    const next = Math.max(DT_MIN_ZOOM, Math.min(DT_MAX_ZOOM, Number(z) || DT_MIN_ZOOM));
    if (next === this._zoom) return;
    this._zoom = next;
    this.refresh();
    // 内容不再溢出可视区时回到最左（时间 0 对齐）
    if (this.scroll && this._width() <= this._visibleWidth()) this.scroll.scrollLeft = 0;
  }

  // 当前拉伸倍数（宿主据此同步自己的滑块/按钮 UI）。
  getZoom() {
    return this._zoom;
  }

  // 把第 i 段横向滚动到可视区（已整体可见则不动），供宿主在运行进度跳段时跟随当前段。
  // 内容未溢出可视区（无需滚动）时不做任何事；两侧各留 pad 便于看到相邻块。
  revealSeg(i) {
    const b = this._layout().blocks[i];
    if (!b || !this.scroll) return;
    const view = this._visibleWidth();
    const max = Math.max(0, this._width() - view);
    if (max <= 0) return;
    const pad = 12;
    let left = this.scroll.scrollLeft;
    if (b.x < left + pad) left = b.x - pad;
    else if (b.x + b.w > left + view - pad) left = b.x + b.w - view + pad;
    this.scroll.scrollLeft = Math.max(0, Math.min(max, left));
  }

  // 光标是否落在某块右缘的调时长热区（仅非 readOnly）
  _resizeZoneAt(x, i) {
    if (this.opts.readOnly || i < 0) return false;
    const b = this._layout().blocks[i];
    return !!b && x >= b.x + b.w - 7 && x <= b.x + b.w + 2;
  }

  // 时间轴尾部「＋」按钮位置（未显示时返回 null）：块行右侧、垂直居中
  _addChipRect() {
    if (this.opts.readOnly || typeof this.opts.onAdd !== "function") return null;
    const W = this._width();
    const H = this.opts.height;
    const top = DT_RULER_H + DT_TOP_GAP, bh = this._blockHeight(); // 与 _draw 一致
    const s = 24;
    return { x: W - 8 - s, y: top + (bh - s) / 2, w: s, h: s };
  }

  _hoverAt(e) {
    if (this._drag) return; // 拖动中不更新悬停
    const { x, y } = this._localPoint(e);
    const chip = this._addChipRect();
    const overAdd = !!chip && x >= chip.x && x <= chip.x + chip.w && y >= chip.y && y <= chip.y + chip.h;
    const i = this._blockAt(x);
    const zone = !overAdd && this._resizeZoneAt(x, i);
    this.canvas.style.cursor = zone ? "ew-resize" : "pointer";
    if (i !== this._hover) { this._hover = i; this.refresh(); }
    if (overAdd !== this._addHover) { this._addHover = overAdd; this.refresh(); }
  }

  // 素材库图片直接拖到时间轴段块上（相当于拖到该段首帧候选区并选中）：
  // dragover 显示落点高亮，drop 时把索引与 dataTransfer 交回宿主处理（仅非 readOnly 且宿主提供了 onDropImage）。
  _onDragOver(e) {
    if (this.opts.readOnly || typeof this.opts.onDropImage !== "function") return;
    e.preventDefault(); // 允许 drop
    e.dataTransfer && (e.dataTransfer.dropEffect = "copy");
    const x = e.clientX - this.canvas.getBoundingClientRect().left;
    const i = this._blockAt(x);
    if (i !== this._dropOver) { this._dropOver = i; this.refresh(); }
  }

  _onDragLeave() {
    if (this._dropOver !== -1) { this._dropOver = -1; this.refresh(); }
  }

  _onDrop(e) {
    if (this.opts.readOnly || typeof this.opts.onDropImage !== "function") return;
    e.preventDefault();
    const x = e.clientX - this.canvas.getBoundingClientRect().left;
    const i = this._blockAt(x);
    this._dropOver = -1;
    this.refresh();
    if (i >= 0 && e.dataTransfer) this.opts.onDropImage(i, e.dataTransfer);
  }
  // 块净高：画布总高减去顶部秒刻度尺、间距与底部进度条区，即视频预览区的实际高度
  _blockHeight() {
    return Math.max(0, (this.opts.height || 0) - DT_RULER_H - DT_TOP_GAP - DT_BOTTOM_PAD);
  }

  // 每段默认宽度（px）：按块净高以 16:9 计算，作为内容宽度的默认基准（非下限）——每段约一个视频帧宽
  _defaultSegW() {
    return this._blockHeight() * 16 / 9;
  }

  // 可视区宽度：优先 scroll 容器 clientWidth（放大时不含滚动内容）；回退 canvas/容器（测试桩常 mock canvas.clientWidth）
  _visibleWidth() {
    const sc = this.scroll && this.scroll.clientWidth;
    if (sc > 0) return sc;
    return this.canvas.clientWidth || this.container.clientWidth || 0;
  }

  // 内容宽度：以「自然宽 = max(可视宽, 默认总宽)」为基数，按缩放倍数放大/缩小（作用于内容本身）；
  // 缩放后不窄于可视宽（缩到铺满为止），超出可视区即横向滚动。zoom=1 时恒等于自然宽（铺满或默认总宽）。
  _width() {
    const natural = Math.max(this._visibleWidth(), this._defaultContentW());
    return Math.max(Math.round(natural * this._zoom), this._visibleWidth());
  }

  // 默认总内容宽度：段数 × 每段默认宽（按高 16:9，含 padding 与尾部 ＋）；无分段时返回 0。
  // 段内仍按时长比例分配相对宽（见 _layout），故平均约一个帧宽、长段更宽短段更窄
  _defaultContentW() {
    const n = this._segs.length;
    if (n === 0) return 0;
    const padX = 8;
    const addW = (typeof this.opts.onAdd === "function" && !this.opts.readOnly) ? 32 : 0;
    return Math.ceil(n * this._defaultSegW() + padX * 2 + addW);
  }

  // 依据当前分段计算每块像素位置：{ padX, usable, total, pxPerSec, blocks:[{i,x,w}] }
  // preview（索引 -> 预览秒数）用于调时长拖动按新总时长重排；order（索引数组）用于重排拖动，
  // 按其顺序摆放各块（源块占其落位槽），使其余块实时让位、幽灵块不与他人重叠。
  _layout(preview, order) {
    const W = this._width();
    const padX = 8;
    // 宿主提供 onAdd 且非只读时，尾部预留「＋」按钮空间
    const addW = (typeof this.opts.onAdd === "function" && !this.opts.readOnly) ? 32 : 0;
    const usable = Math.max(10, W - padX * 2 - addW);
    const segs = this._segs;
    const idxs = order || segs.map((_, k) => k);
    const durOf = (i) => {
      if (preview && typeof preview[i] === "number") return preview[i];
      return Number(segs[i].duration) || 0;
    };
    let total = 0;
    for (const i of idxs) total += durOf(i);
    const blocks = [];
    if (idxs.length > 0 && total > 0) {
      const pps = usable / total;
      let x = padX;
      for (const i of idxs) {
        const w = durOf(i) * pps;
        blocks.push({ i, x, w, seg: segs[i] });
        x += w;
      }
    } else if (idxs.length > 0) {
      const w = usable / idxs.length;
      let x = padX;
      for (const i of idxs) { blocks.push({ i, x, w, seg: segs[i] }); x += w; }
    }
    return { padX, usable, total, pxPerSec: total > 0 ? usable / total : 0, blocks };
  }

  // 重排拖动中幽灵块的横向位置：跟随光标（保持按下时的抓取偏移），夹在内容区内
  _ghostX(d, L) {
    const raw = d.cursorX - d.grabOff;
    return Math.max(L.padX, Math.min(L.padX + L.usable - d.w, raw));
  }

  _blockAt(x) {
    const L = this._layout();
    for (const b of L.blocks) if (x >= b.x && x <= b.x + b.w) return b.i;
    return -1;
  }

  _onDown(e) {
    if (e.button !== 0) return;
    const { x, y } = this._localPoint(e);
    const chip = this._addChipRect();
    if (chip && x >= chip.x && x <= chip.x + chip.w && y >= chip.y && y <= chip.y + chip.h) {
        e.preventDefault();
        this.opts.onAdd();
        return;
    }
    const i = this._blockAt(x);
    if (i < 0) return;
    e.preventDefault();
    if (this.opts.checkable && this._hitsCheck(x, y, i)) { this._toggleChecked(i); return; }
    if (this.opts.readOnly) { this.select(i); return; }
    if (this._resizeZoneAt(x, i)) {
      this._drag = { src: i, resize: true, moved: false, startX: x };
      window.addEventListener("mousemove", this._onMoveB);
      window.addEventListener("mouseup", this._onUpB);
      return;
    }
    const srcBlock = this._layout().blocks[i];
    // cursorX/grabOff 为画布内坐标：拖动中幽灵块跟随光标，保持按下点相对块左缘的距离
    this._drag = { src: i, order: this._segs.map((_, k) => k), moved: false, startX: e.clientX, cursorX: x, grabOff: srcBlock ? x - srcBlock.x : 0, w: srcBlock ? srcBlock.w : 0 };
    window.addEventListener("mousemove", this._onMoveB);
    window.addEventListener("mouseup", this._onUpB);
  }

  _onMove(e) {
    if (!this._drag) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (this._drag.resize) {
      // 调时长：吸附 0.5s、最小 1s；预览值暂存，松手才提交 onResize
      if (!this._drag.moved && Math.abs(x - this._drag.startX) < 4) return;
      this._drag.moved = true;
      const L = this._layout();
      const b = L.blocks[this._drag.src];
      if (!b || !L.pxPerSec) return;
      const raw = Math.max(1, (x - b.x) / L.pxPerSec);
      this._drag.newDur = Math.min(300, Math.max(1, Math.round(raw * 2) / 2));
      this.refresh();
      return;
    }
    if (!this._drag.moved && Math.abs(e.clientX - this._drag.startX) < 4) return;
    this._drag.moved = true;
    const L = this._layout();
    const cx = Math.max(L.padX, Math.min(rect.width - L.padX, x));
    this._drag.cursorX = cx;
    // 插入位：只统计非源块的中心点（源块被"拿起"，不参与排序比较）
    let p = 0;
    for (const idx of this._drag.order) {
      if (idx === this._drag.src) continue;
      const b = L.blocks[idx];
      if (b && b.x + b.w / 2 < cx) p++;
    }
    const order = this._drag.order.filter((i) => i !== this._drag.src);
    order.splice(p, 0, this._drag.src);
    this._drag.order = order;
    this.refresh();
  }

  _onUp() {
    window.removeEventListener("mousemove", this._onMoveB);
    window.removeEventListener("mouseup", this._onUpB);
    const d = this._drag;
    this._drag = null;
    if (!d) return;
    if (d.resize) {
      if (d.moved && typeof d.newDur === "number" && this.opts.onResize) this.opts.onResize(d.src, d.newDur);
      this.refresh();
      return;
    }
    if (d.moved) { if (this.opts.onReorder) this.opts.onReorder(d.order); }
    else this.select(d.src);
    this.refresh();
  }
  // 段色相按位置着色（+180 让默认段落在青绿色系而非红色）；节点与编辑器同一配色，始终一致
  _segHue(i) {
    return ((i * 47 + 180) % 360);
  }

  _rulerStep(pps, usable) {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    for (const s of steps) if (s * pps >= Math.min(48, usable / 2)) return s;
    return steps[steps.length - 1];
  }

  _rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 把文本折成最多 maxLines 行：中间行按宽度取满（不加省略号，内容在下一行续接），
  // 仅最后一行在超出时加省略号。用于时间轴块内多行显示。
  // 截断点用二分查找（找加省略号后仍放得下的最大前缀），替代逐字符缩减——
  // 逐字符对长提示词要 O(n) 次 measureText、每次 O(n) 字符整形，超长 prompt 单段即秒级。
  _fitLines(ctx, text, maxW, maxLines) {
    const out = [];
    let rest = String(text || "");
    for (let n = 0; n < maxLines && rest.length > 0; n++) {
      if (ctx.measureText(rest).width <= maxW) { out.push(rest); break; } // 剩余整段放得下：作为末行，无省略号
      const last = n === maxLines - 1;
      let lo = 1, hi = rest.length, fit = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ctx.measureText(rest.slice(0, mid) + (last ? "…" : "")).width <= maxW) { fit = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      const t = rest.slice(0, fit);
      out.push(last ? t + "…" : t);
      rest = rest.slice(t.length);
    }
    return out;
  }

  // 时间轴块摘要：优化后的 H3 提示词带 integrated_multimodal_description / overall_soundscape 等固定字段标签，
  // 两行小字放不下也没必要显示——只取画面描述段（integrated_multimodal_description，Ref2VA 为 detailed_description）
  // 正文、去掉字段标签并压成单行供 _fitLines 折行；非结构化提示词原样压缩空白返回。
  _promptSummary(text) {
    const t = String(text || "");
    const m = t.match(/(?:integrated_multimodal_description|detailed_description)\s*:\s*([\s\S]*?)(?:\n\s*(?:overall_soundscape|non_diegetic_music)\s*:|$)/i);
    return (m ? m[1] : t).replace(/\s+/g, " ").trim();
  }

  _drawThumb(img, x, y, w, h) {
    const ctx = this.ctx;
    const ir = img.naturalWidth / (img.naturalHeight || 1);
    const r = w / h;
    let sw, sh, sx, sy;
    if (ir > r) { sh = img.naturalHeight; sw = sh * r; sx = (img.naturalWidth - sw) / 2; sy = 0; }
    else { sw = img.naturalWidth; sh = sw / r; sx = 0; sy = (img.naturalHeight - sh) / 2; }
    ctx.save();
    this._rr(ctx, x, y, w, h, 3);
    ctx.clip();
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    ctx.restore();
  }

  _draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = this._width();
    const H = this.opts.height;
    if (W <= 0) return;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    // 内容超出可视区（放大或最小宽导致）时按像素宽并横向滚动，否则铺满；打 zoomed 类显示可见滚动条
    const overflows = W > this._visibleWidth();
    this.canvas.style.width = overflows ? W + "px" : "100%";
    this.canvas.style.height = H + "px";
    if (this.scroll) this.scroll.classList.toggle("neo-dtl-zoomed", overflows);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 调时长拖动按预览值重排；重排拖动按“新顺序”布局（源块占其落位槽，其余块让位、幽灵不重叠）
    const resizeDrag = this._drag && this._drag.moved && this._drag.resize ? this._drag : null;
    const reorderDrag = this._drag && this._drag.moved && !this._drag.resize ? this._drag : null;
    const preview = resizeDrag && typeof resizeDrag.newDur === "number" ? { [resizeDrag.src]: resizeDrag.newDur } : undefined;
    const L = reorderDrag ? this._layout(undefined, reorderDrag.order) : this._layout(preview);
    if (L.blocks.length === 0) {
      ctx.fillStyle = "#666";
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(t("暂无分段"), L.padX, H / 2);
      return;
    }

    // 顶部秒刻度尺
    const rulerH = DT_RULER_H;
    if (L.total > 0) {
      ctx.strokeStyle = "#3a3a3a";
      ctx.beginPath(); ctx.moveTo(L.padX, rulerH - 2); ctx.lineTo(W - L.padX, rulerH - 2); ctx.stroke();
      const step = this._rulerStep(L.pxPerSec, L.usable);
      ctx.font = "9px sans-serif";
      ctx.textBaseline = "top";
      for (let t = 0; t <= L.total + 1e-6; t += step) {
        const x = L.padX + t * L.pxPerSec;
        if (x > W - L.padX + 1) break;
        ctx.strokeStyle = "#555";
        ctx.beginPath(); ctx.moveTo(x, rulerH - 8); ctx.lineTo(x, rulerH - 2); ctx.stroke();
        ctx.fillStyle = "#7a7a7a";
        ctx.fillText(Math.round(t) + "s", x + 2, 0);
      }
    }

    // 刻度线上的生成进度条（done 绿满条 / current 琥珀按比例增长）
    this._drawRulerProgress(ctx, L);

    const top = rulerH + DT_TOP_GAP;
    const bh = this._blockHeight();
    const drag = this._drag && this._drag.moved ? this._drag : null;
    // 悬停块的起止秒（时间范围提示）；调时长拖动中跟随预览值
    let hoverRange = null;
    if (!reorderDrag && this._hover != null && this._segs[this._hover]) {
      const durs = drag && drag.resize ? L.blocks.map((bb) => (bb.i === drag.src ? drag.newDur : Number(this._segs[bb.i].duration) || 0)) : this._segs.map((s) => Number(s.duration) || 0);
      let st = 0;
      for (let k = 0; k < this._hover; k++) st += durs[k];
      hoverRange = [st, st + durs[this._hover]];
    }
    for (const b of L.blocks) {
      const seg = b.seg || this._segs[b.i];
      // 重排拖动：按新顺序定位，色相/序号随落位槽变化；源块本身改成跟随光标的幽灵（见下方落位框），此处只留槽
      const posIdx = reorderDrag ? reorderDrag.order.indexOf(b.i) : b.i;
      if (reorderDrag && reorderDrag.src === b.i) continue;
      this._paintSeg(ctx, b.x, b.w, top, bh, seg, String(posIdx + 1), this._segHue(posIdx), false, b.i === this._selected || b.i === this._hover, this._dropOver === b.i, b.i);
    }

    // 重排拖动中：非源块整体压暗，让被"拿起"的幽灵块一眼突出（源块不遮）
    if (reorderDrag) {
      ctx.fillStyle = "rgba(8,12,18,0.5)";
      for (const b of L.blocks) {
        if (b.i === reorderDrag.src) continue;
        this._rr(ctx, b.x + 1, top, Math.max(2, b.w - 2), bh, 4);
        ctx.fill();
      }
      // 落位槽虚框：源块松手后落在这里；幽灵块跟随光标浮动，拖动全程都有位移反馈
      const posIdx = reorderDrag.order.indexOf(reorderDrag.src);
      const slot = L.blocks[posIdx];
      if (slot) {
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2;
        this._rr(ctx, slot.x + 1, top, Math.max(2, slot.w - 2), bh, 4);
        ctx.fillStyle = "rgba(191,230,255,0.08)";
        ctx.fill();
        ctx.strokeStyle = "rgba(191,230,255,0.9)";
        ctx.stroke();
        ctx.restore();
      }
      const srcSeg = this._segs[reorderDrag.src];
      if (srcSeg && reorderDrag.w > 0) {
        this._paintSeg(ctx, this._ghostX(reorderDrag, L), reorderDrag.w, top, bh, srcSeg, String(posIdx + 1), this._segHue(posIdx), true, false, false, -1);
      }
    }

    // 时间轴尾部「＋」添加段按钮（宿主提供 onAdd 且非只读时）
    const chip = this._addChipRect();
    if (chip) {
      this._rr(ctx, chip.x, chip.y, chip.w, chip.h, 5);
      ctx.fillStyle = this._addHover ? "rgba(140,204,255,0.28)" : "rgba(255,255,255,0.07)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = this._addHover ? "#8cf" : "rgba(255,255,255,0.25)";
      ctx.stroke();
      ctx.fillStyle = this._addHover ? "#cfe8ff" : "#9aa4b0";
      ctx.font = "bold 14px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("+", chip.x + chip.w / 2, chip.y + chip.h / 2 + 1);
      ctx.textAlign = "left";
    }

    // 悬停提示：块内左下角显示该段时间范围（如 "5–10s"）
    if (hoverRange) {
      const hb = L.blocks[this._hover];
      if (hb) {
        const txt = `${Math.round(hoverRange[0])}–${Math.round(hoverRange[1])}s`;
        ctx.font = "9px sans-serif";
        const tw = ctx.measureText(txt).width + 8;
        let tx = Math.max(hb.x + 4, hb.x + hb.w - tw - 26);
        const ty = top + bh - 15;
        this._rr(ctx, tx, ty, tw, 13, 3);
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fill();
        ctx.fillStyle = "#eee";
        ctx.textBaseline = "top";
        ctx.fillText(txt, tx + 4, ty + 2);
      }
    }

    // 拖拽：源块在落位槽留虚框占位、本体作为幽灵块跟随光标浮动（其余块已让位，落位框不与他人重叠）
  }

  // 刻度线上的生成进度条：在秒刻度尺底部画彩色填充条，按段宽对齐。
  // done = 绿色满条；current = 琥珀色按 step/total_steps 比例增长；未开始不画。
  _drawRulerProgress(ctx, L) {
    const p = this._progress;
    if (!p || !p.active) return;
    const barH = 5;
    const y = DT_RULER_H - barH - 1;   // 刻度线底沿上方
    for (const b of L.blocks) {
      const [state, ratio] = this._segProgressState(b.i);
      if (!state) continue;
      const x = b.x + 2;
      const fullW = Math.max(4, b.w - 4);
      if (state === "done") {
        ctx.fillStyle = "#3fb950";
        this._rr(ctx, x, y, fullW, barH, 2);
        ctx.fill();
      } else if (state === "current") {
        // 背景槽（暗色）+ 前景填充（按比例增长）
        ctx.fillStyle = "rgba(230,162,60,0.2)";
        this._rr(ctx, x, y, fullW, barH, 2);
        ctx.fill();
        const fillW = Math.max(4, fullW * ratio);
        ctx.fillStyle = "#e6a23c";
        this._rr(ctx, x, y, fillW, barH, 2);
        ctx.fill();
      }
    }
  }

  // 某段当前的生成状态：返回 [state, ratio]——state: "done"|"current"|""，ratio: 0~1（当前段内步数进度）。
  // 由宿主经 getProgress() 提供 director 运行进度；非活动或无进度时全部返回 ["", 0]。
  _segProgressState(i) {
    const p = this._progress;
    if (!p || !p.active) return ["", 0];
    const cur = Number(p.segment_index);
    if (i < cur) return ["done", 1];
    if (i === cur) {
      const total = Number(p.total_steps) || 0;
      const step = Number(p.step) || 0;
      return ["current", total > 0 ? Math.min(1, step / total) : 0];
    }
    return ["", 0];
  }

  // 参考素材展示（r2v）：参考图按原比例逐张横排平铺满块高（能放几张放几张，画在首帧同区域之上），
  // 视频/音频无缩略图，右上角小徽标显示数量。seg.mat = { images, videos, audios }、seg.matThumbs = [url...]。
  _paintMat(ctx, x, w, top, bh, seg) {
    const mat = seg.mat;
    if (!mat || !(mat.images || mat.videos || mat.audios)) return;
    const iw = Math.max(2, w - 2);
    // 参考图平铺：逐张按原比例裁竖条横排，一轮放完后整组循环重复，铺满块宽不留空白
    const urls = Array.isArray(seg.matThumbs) ? seg.matThumbs : [];
    const imgs = [];
    for (const u of urls) {
      const img = this._thumbs.get(u);
      if (!img || !img.complete || !img.naturalWidth) continue;
      imgs.push(img);
    }
    if (imgs.length) {
      const tileH = bh - 8;
      const right = x + w - 5;
      ctx.save();
      this._rr(ctx, x + 5, top + 4, Math.max(2, iw - 8), tileH, 3);
      ctx.clip();
      let cx = x + 5;
      let i = 0;
      while (cx < right) {
        const img = imgs[i % imgs.length];
        const tw = Math.max(12, tileH * (img.naturalWidth / img.naturalHeight));
        this._drawThumb(img, cx, top + 4, tw, tileH);
        cx += tw;
        i++;
      }
      ctx.restore();
    }
    // 视频/音频数量徽标（右上角，位于时长左侧，避开左上序号）
    const badges = [];
    if (mat.videos) badges.push(['▶' + mat.videos, '#b06bff']);
    if (mat.audios) badges.push(['♪' + mat.audios, '#3fbf7f']);
    if (!badges.length) return;
    ctx.font = 'bold 9px sans-serif';
    let bw = 0;
    for (const [label] of badges) bw += ctx.measureText(label).width + 8 + 3;
    let bx = x + w - 5 - bw;
    if (seg.duration) bx -= ctx.measureText(String(seg.duration) + 's').width + 6;   // 给时长让位（粗体偏宽，方向安全）
    const by = top + 4;
    for (const [label, color] of badges) {
      const tw2 = ctx.measureText(label).width + 8;
      this._rr(ctx, bx, by, tw2, 13, 3);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + tw2 / 2, by + 7);
      ctx.textAlign = 'left';
      bx += tw2 + 3;
    }
  }

  // 绘制单个分段块（普通/幽灵共用）：浅色身份底（重排不变色）；有首帧图则平铺满块宽，文字白字描边，否则浅底深字
  // idx 用于 checkable 时间轴：未勾选的块压暗、勾选框悬停时出现（已勾选常显）；幽灵块传 -1
  _paintSeg(ctx, x, w, top, bh, seg, numLabel, hue, ghost, sel, drop, idx) {
    const iw = Math.max(2, w - 2);
    const checked = this._checked.has(idx);
    const dim = this.opts.checkable && !checked;
    this._rr(ctx, x + 1, top, iw, bh, 4);
    // 半透明块底色：色相只作分段身份，饱和度压到 32%、静止 alpha 0.2，铺满块宽时不再压住首帧缩略图；
    // 选中的加深靠 alpha 抬一档加亮描边，静止与选中仍是同一色相，重排换槽时块不跳色
    // 拖动中的块（幽灵）更醒目：填充更实更亮、描边更粗且用更亮的色，并加轻微投影营造“拿起/悬浮”感；静止与选中态配色不变
    if (ghost) { ctx.shadowColor = "rgba(120,205,255,0.85)"; ctx.shadowBlur = 8; }
    ctx.fillStyle = "hsla(" + hue + ",32%," + (ghost ? 62 : sel ? 58 : 50) + "%," + (ghost ? 0.55 : sel ? 0.32 : dim ? 0.09 : 0.2) + ")";
    ctx.fill();
    ctx.lineWidth = ghost ? 2.5 : (sel || drop ? 1.5 : 1);
    ctx.strokeStyle = ghost ? "#bfe6ff" : sel ? "#8cf" : drop ? "#e6a23c" : "rgba(255,255,255,0.16)";
    ctx.stroke();
    if (ghost) { ctx.shadowBlur = 0; }
    if (drop) {
      // 素材拖放落点：半透明橙色覆盖提示「放到这 = 设为该段首帧」
      ctx.fillStyle = "rgba(230,162,60,0.18)";
      this._rr(ctx, x + 1, top, iw, bh, 4);
      ctx.fill();
    }

    // 首帧图：按原比例裁出竖条后横向重复，铺满块宽
    const img = seg.thumbUrl ? this._thumbs.get(seg.thumbUrl) : null;
    const tiled = !!(img && img.complete && img.naturalWidth > 0);
    if (tiled) {
      const tileH = bh - 8;
      const tw = Math.max(12, tileH * (img.naturalWidth / img.naturalHeight));
      ctx.save();
      this._rr(ctx, x + 5, top + 4, Math.max(2, iw - 8), tileH, 3);
      ctx.clip();
      for (let tx = x + 5; tx < x + w - 5; tx += tw) this._drawThumb(img, tx, top + 4, tw, tileH);
      ctx.restore();
    }

    const put = (t, tx, ty, font, color) => {
      ctx.font = font;
      ctx.lineWidth = 2.5; ctx.strokeStyle = "rgba(0,0,0,0.65)"; ctx.strokeText(t, tx, ty);
      ctx.fillStyle = color;
      ctx.fillText(t, tx, ty);
    };

    // 半透明文字背景：按字号定位圆角矩形（文字顶在 ty），画在描边/填充之前，提升缩略图上的可读性。
    const textBg = (t, tx, ty, font) => {
      const m = font.match(/(\d+(?:\.\d+)?)px/);
      const fs = m ? parseFloat(m[1]) : 12;
      ctx.font = font;
      this._rr(ctx, tx - 3, ty - 2, ctx.measureText(t).width + 6, fs + 4, 3);
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fill();
    };

    // 参考素材展示（r2v）：参考图平铺满块 + 视频/音频数量徽标（先画图片，文字再覆盖其上保证可读）
    this._paintMat(ctx, x, w, top, bh, seg);

    // 勾选框（仅 checkable，悬停 / 已勾选才画）：勾选 = 本次运行包含该段；未勾选的块底色已压暗
    if (this._checkVisible(idx, checked)) {
      const c = this._checkRect(x, top);
      this._rr(ctx, c.x, c.y, c.s, c.s, 3);
      ctx.fillStyle = checked ? "rgba(140,204,255,0.92)" : "rgba(0,0,0,0.42)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = checked ? "#bfe6ff" : "rgba(255,255,255,0.55)";
      ctx.stroke();
      if (checked) {
        ctx.beginPath();
        ctx.moveTo(c.x + 3, c.y + 7);
        ctx.lineTo(c.x + 5.5, c.y + 9.5);
        ctx.lineTo(c.x + 10, c.y + 3.5);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#08111c";
        ctx.stroke();
      }
    }

    // 序号（左上）+ 时长（右上）：块顶部一行；半透明背景 + 白字深色描边，画在图片之上
    const numX = this.opts.checkable ? x + 6 + DT_CHECK_S + 4 : x + 6;
    ctx.textBaseline = "top";
    textBg(numLabel, numX, top + 4, "bold 10px sans-serif");
    put(numLabel, numX, top + 4, "bold 10px sans-serif", "#fff");
    if (seg.duration) {
      const d = String(seg.duration) + "s";
      ctx.font = "9px sans-serif";
      const dx = x + w - ctx.measureText(d).width - 5;
      textBg(d, dx, top + 4, "9px sans-serif");
      put(d, dx, top + 4, "9px sans-serif", "#fff");
    }

    // 提示词片段：块底部（Y轴底部，末行贴下沿留 5px），最多两行（超出截断加省略号），画在图片之上。
    // 用 _promptSummary 去掉 H3 固定字段标签，只留画面描述正文，避免摘要被标签占满。
    if (seg.prompt) {
      ctx.font = "11px sans-serif";
      const lines = this._fitLines(ctx, this._promptSummary(seg.prompt), Math.max(20, w - 14), 2);
      if (lines.length) {
        const fs = 11, lineH = 13;
        const bottomY = top + bh - 5;
        // 半透明背景块：覆盖全部行（末行底在 bottomY，首行顶在 bottomY-(n-1)*lineH-fs）
        let maxW = 0;
        for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);
        this._rr(ctx, x + 3, bottomY - (lines.length - 1) * lineH - fs - 2, maxW + 6, (lines.length - 1) * lineH + fs + 4, 3);
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fill();
        ctx.textBaseline = "bottom";
        for (let li = 0; li < lines.length; li++) {
          put(lines[li], x + 6, bottomY - (lines.length - 1 - li) * lineH, "11px sans-serif", "#fff");
        }
      }
    }

    // 生成进度已移到刻度线上渲染（见 _drawRulerProgress），块内不再画顶部细条。
  }
}