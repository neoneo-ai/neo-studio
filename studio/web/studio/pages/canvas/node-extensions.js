// 画布节点的仓内扩展点：这一列描述符与 node-types.js 里内置那一列同形，由它并进同一张注册表。
// 两条都是静态 import 的常量 —— 没有运行期注册，也不从仓外取代码；画布 state 与落盘只住在 page.js，
// 这一层的渲染只吃 nodeElement 交下来的那几个参数，不自持模块级状态。
// 一行要过的形状全在 canvas-node-types 那一条用例里钉着：type 是裸词（studio/canvas.py 逐类原样落盘的
// 口径）、title 与默认框齐、add 落进三大档之一且菜单名在 i18n 词表里、doc 中英文各一行、卡面由行自带的
// render 给出。没有 run 就没有运行钮、没有能力位、闸门也不拦这一张。
import { t } from "../../../js/core/i18n.js";

/** 备注卡的颜色标记：存在 metadata.tone，空 = 跟卡面同色（CSS 认 .ns-canvas-note[data-tone]） */
const NOTE_TONES = [["", "默认色"], ["warm", "暖"], ["cool", "冷"], ["alert", "醒目"]];

export const NODE_EXTENSIONS = [
    {
        type: "note",
        title: "备注卡",
        w: 240, h: 160,
        css: "ns-canvas-node-note",
        body: "note",
        bodyText: true,
        doc: { zh: ["备注卡"], en: ["Note card"] },
        add: { label: "加备注卡", icon: "list", group: "text" },
        render: noteCard,
    },
];

/** 备注卡：整张是正文框，底行一枚颜色标记 —— 这一张不跑任何东西，结果也不落它身上 */
function noteCard(node, { $el, onText, onMeta }) {
    const tone = NOTE_TONES.some(([value]) => value === node.metadata.tone) ? node.metadata.tone : "";
    const pick = $el("select", {
        className: "ns-canvas-note-tone",
        title: t("备注卡的颜色"),
        onchange: (e) => onMeta?.(node, { tone: e.target.value }),
    }, NOTE_TONES.map(([value, label]) => $el("option", { value, textContent: t(label) })));
    pick.value = tone;
    return $el("div", { className: "ns-canvas-note", dataset: { tone } }, [
        $el("textarea", {
            className: "ns-canvas-node-textarea ns-canvas-note-text",
            value: String(node.metadata.content || ""),
            placeholder: t("写一句备注：这一张不跑出片"),
            oninput: (e) => onText?.(node, e.target.value),
        }),
        pick,
    ]);
}
