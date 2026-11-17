// 故事板页（首页「宫格图分镜」卡的落点）：只铺故事板那一面，无顶栏页签、无弹窗。
// 内容全在导演编辑器里（角色参考图 / 宫格图拆分 / 各段对照），这一页只做三件事：从空白配方起手、
// 把编辑器内嵌进本页（storyOnly = 无页签、时间线那一面收起）、把整页参数与出片那一面留给导演页。
// 全窗口只有一份导演编辑器：导演页要开全量那一面时，先让本页把钉着的这一份交出来。
import { t } from "../../js/core/i18n.js";
import { openDirectorEditor, currentDirectorEditor } from "../../director.js";

/** @typedef {Object} StoryboardPageHost
 *  @property {Function} $el 建元素
 *  @property {Function} toast 提示文本
 *  @property {Function} go 切页 */

/** 故事板页的工厂：内嵌编辑器与两条跨页钩子都留在这一个闭包里，随视图常驻 */
export function createStoryboardPage(host) {
    const { $el, toast, go } = host;
    let releaseHook = null;   // 导演页开全量编辑器前要让位的那一发：true = 可以让位
    let shownHook = null;     // 进本页要补拉的活：视图常驻显隐，回到本页要把内嵌编辑器补铺好

    async function build(el) {
        el.classList.add("ns-storyboard");
        const head = $el("div", { className: "ns-storyboard-head" }, [
            $el("span", { className: "ns-storyboard-title", textContent: t("宫格图分镜") }),
            $el("span", { className: "ns-storyboard-hint", textContent: t("空白配方起手，点「保存」才落盘；整片参数与逐段时长、出片都在导演页") }),
            $el("button", { className: "ns-btn", type: "button", textContent: t("去导演页"), onclick: () => go("director") }),
        ]);
        const hostEl = $el("div", { className: "ns-storyboard-host" });
        // 编辑器关掉（标题栏 ✕）后这一页不能是空白：留一行「打开宫格图分镜」占位（同生成素材页内嵌关闭那条口径）
        const placeholder = $el("div", { className: "ns-storyboard-placeholder" }, [
            $el("span", { textContent: t("宫格图分镜已关闭") }),
            $el("button", { className: "ns-btn", type: "button", textContent: t("打开宫格图分镜"), onclick: () => ensureBoard() }),
        ]);
        el.append(head, hostEl, placeholder);

        /** 收回「不属于这一页」的那份编辑器：干净就关掉；有未保存修改就停在原地请用户自己处理。
         *  true = 这一页可以铺自己的那一面。编辑器全窗口只有一份，两处不能同时钉着同一份配方。 */
        function releaseCur() {
            const cur = currentDirectorEditor();
            if (!cur) return true;
            if (hostEl.contains(cur.overlay)) return true;   // 本页钉着的就是它：不重建
            if (!cur.isDirty()) { cur.close(); return true; }
            toast(t("编辑器有未保存的修改，先保存或放弃"));
            return false;
        }

        async function ensureBoard() {
            if (!releaseCur()) return;
            if (hostEl.querySelector(".neo-director-embedded")) return;   // 已铺好：切页回来不重建（含这一页刚起手、还没落盘的那一份）
            // 这一页从空白配方起手，不认导演页那份选中态：上一次的分镜铺在面前，新建就没有位置了。
            // existing 传 null 走的是编辑器自己的新建那一路（一段空段、配方名空着）：底部「保存」按名字写盘，
            // 写成功广播「配方已保存」，导演页据此选中它——这一页不提前落盘，也不养第二条写路径
            await openDirectorEditor(null, null, -1, { container: hostEl, storyOnly: true });
        }

        shownHook = () => { ensureBoard().catch(e => console.error("[Neo Studio] storyboard open failed:", e)); };
        // 导演页「高级模式」要开的是全量编辑器（含时间线那一面）：本页钉着同一份配方时先收回内嵌那一份
        releaseHook = () => {
            const cur = currentDirectorEditor();
            if (!cur || !hostEl.contains(cur.overlay)) return true;   // 本页没钉编辑器：导演页照旧
            if (!cur.isDirty()) { cur.close(); return true; }
            toast(t("故事板有未保存的修改，先保存或放弃"));
            go("storyboard");   // 确认条就在这页里：把人带去能点到的那一面
            return false;
        };
        await ensureBoard();
    }

    return {
        build,
        releaseEditor: () => releaseHook?.() ?? true,
        shown: () => shownHook?.(),
    };
}
