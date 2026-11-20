/**
 * 瀑布流布局：卡片高度随缩略图朝向变化（竖图 3:4 / 横图 3:2 / 方形 1:1）。
 *
 * CSS multi-column 只能逐列填充，卡片高矮不一时会整列留白，阅读顺序也变成「先下后右」。
 * 这里改成最短列装箱 + 绝对定位：卡片保持 DOM 顺序，逐个放进当前最矮的一列，列宽固定
 * 为缩略图尺寸（与改造前的 grid-template-columns: repeat(auto-fill, Npx) 一致）。
 * 满幅页传 maxColumns：定宽列在宽屏排出的列数一夹住，余下的宽度要摊进每一列。
 * 缩略图加载后卡片变高由 ResizeObserver 触发重排，容器宽度变化（窗口/侧栏拉伸）同理。
 */

const GAP = 12;                  // 卡片间距，与卡片自身的 margin 无关
const FALLBACK_COLUMN_WIDTH = 320;

const controllers = new WeakMap();  // container -> Masonry

/**
 * 最短列装箱（与 DOM 无关，便于单测）：按顺序把每张卡片放进当前最矮的一列。
 * `heights` 为卡片高度，返回每张卡的 [列号, 距列顶距离] 和总高度。
 */
export function packColumns(heights, columns) {
    const bottoms = new Array(columns).fill(0);
    const placement = [];
    for (const height of heights) {
        let column = 0;
        for (let i = 1; i < columns; i++) {
            if (bottoms[i] < bottoms[column] - 0.5) column = i;
        }
        placement.push([column, bottoms[column]]);
        bottoms[column] += height + GAP;
    }
    return { placement, height: placement.length ? Math.max(...bottoms) - GAP : 0 };
}

class Masonry {
    constructor(container, columnWidth, maxColumns) {
        this.container = container;
        this.columnWidth = columnWidth || FALLBACK_COLUMN_WIDTH;
        this.maxColumns = maxColumns || 0;   // 0 = 定宽列：列数由页宽排出，卡片不随页宽拉伸
        this.frame = 0;
        this.resizeObserver = new ResizeObserver(() => this.schedule());
        this.mutationObserver = new MutationObserver(() => {
            this._observeChildren();
            this.schedule();
        });
        this.resizeObserver.observe(container);
        this.mutationObserver.observe(container, { childList: true });
        this._observeChildren();
    }

    _observeChildren() {
        for (const child of this.container.children) {
            this.resizeObserver.observe(child);
        }
    }

    setColumnWidth(columnWidth) {
        this.columnWidth = columnWidth || FALLBACK_COLUMN_WIDTH;
        this.schedule();
    }

    schedule() {
        if (this.frame) return;
        // 合并同一帧里的多次增删/尺寸变化，避免边加卡片边同步布局
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this._layout();
        });
    }

    _layout() {
        const container = this.container;
        const width = container.clientWidth;
        if (!width) return;   // 还在游离状态，等挂进 DOM 后由 ResizeObserver 再排

        let columnWidth = Math.min(this.columnWidth, width);
        let columns = Math.max(1, Math.floor((width + GAP) / (columnWidth + GAP)));
        if (this.maxColumns && columns > this.maxColumns) {
            // 列数一夹就有余宽剩下来：不摊进每一列的话卡片照定宽落位，页右沿留一条整幅空白
            columns = this.maxColumns;
            columnWidth = Math.floor((width - (columns - 1) * GAP) / columns);
        }
        // 载入行不是卡片：它排在网格底边之下占一整行，装箱与列宽都不该碰它
        const items = Array.from(container.children)
            .filter((el) => el.offsetWidth > 0 && !el.classList.contains("neo-gallery-load-status"));
        if (items.length === 0) {
            container.style.height = "0px";
            return;
        }

        container.classList.add("neo-gallery-masonry");
        for (const el of items) el.style.width = `${columnWidth}px`;

        // 先写宽度再读高度：整批写完后只触发一次强制布局
        const { placement, height } = packColumns(items.map((el) => el.offsetHeight), columns);
        items.forEach((el, i) => {
            el.style.left = `${placement[i][0] * (columnWidth + GAP)}px`;
            el.style.top = `${placement[i][1]}px`;
        });
        container.style.height = `${height}px`;
    }
}

/** 把容器交给瀑布流接管（卡片以缩略图尺寸为列宽，按最短列排布）。
 *  maxColumns 是列数上限：页宽排出的列数超过它时夹在这一档，余宽摊给每一列。 */
export function attachMasonry(container, columnWidth, maxColumns) {
    controllers.set(container, new Masonry(container, columnWidth, maxColumns));
}

/** 缩略图尺寸滑块改动后更新列宽并重排（容器已被回收时静默忽略）。 */
export function setMasonryColumnWidth(container, columnWidth) {
    const masonry = controllers.get(container);
    if (masonry) masonry.setColumnWidth(columnWidth);
}
