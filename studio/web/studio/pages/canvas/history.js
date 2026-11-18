// 画布编辑的撤销 / 重做：两条栈，栈里只记节点与连线两样 —— 视口与背景不进栈，
// 撤销不该把用户脚下的那片画面一起拽走。栈由页面持有（page.js 一份），这里只管快照与进出。
// 上游 infinite-canvas 没有这一层（它的持久化 hooks 不在移植范围），是 Neo Studio 自己的编辑命令栈。
import { serializeCanvas } from "./store.js";

/** 栈深上限：一份快照就是整叠节点对象，画布上几百张时栈深也得有个顶 */
export const HISTORY_LIMIT = 60;

/** 改动之前那一份的快照：走一遍存盘形状再把节点与连线深拷出来，栈里的快照不会跟着后续改动一起变 */
export function snapshotCanvas(state) {
    const saved = serializeCanvas(state);
    return {
        nodes: saved.nodes.map((node) => ({ ...node, position: { ...node.position }, metadata: { ...node.metadata } })),
        connections: saved.connections.map((conn) => ({ ...conn })),
    };
}

export function createHistory(limit = HISTORY_LIMIT) {
    const undoStack = [], redoStack = [];
    const cap = (stack) => { while (stack.length > limit) stack.shift(); };
    return {
        /** 落笔之前记一份：新改动同时清掉重做栈（撤销过之后再改，重做那条链就断了） */
        push(before) {
            undoStack.push(before);
            redoStack.length = 0;
            cap(undoStack);
        },
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        undo(current) {
            if (!undoStack.length) return null;
            redoStack.push(current);
            cap(redoStack);
            return undoStack.pop();
        },
        redo(current) {
            if (!redoStack.length) return null;
            undoStack.push(current);
            cap(undoStack);
            return redoStack.pop();
        },
        /** 换画布与新建画布要清栈：上一张的改动不能撤销到这一张上来 */
        clear() {
            undoStack.length = 0;
            redoStack.length = 0;
        },
    };
}
