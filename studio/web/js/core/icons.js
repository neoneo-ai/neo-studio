/**
 * icons.js — 复制 / 删除这类应用级图标的唯一出口。
 * 同一枚图形只留一份 path 常量：inline SVG 用 currentColor 描边，按钮自己的
 * 颜色与 hover 直接落在图标上，各模块不必再各写一个 ⧉ / 🗑 字形（字形随字体变样、
 * 在 WebView2 里还会掉色成 emoji）。
 */

const PATHS = {
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    cross: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
};

/** 建一枚图标（每次新建节点，同一枚图标要出现在多个按钮里） */
export function icon(name, size = 14) {
    const box = document.createElement("span");
    box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"`
        + ` viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"`
        + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`
        + ` style="flex:none;vertical-align:-3px">${PATHS[name]}</svg>`;
    return box.firstChild;
}

/** 纯图标钮：钮面只有图标，文案交给调用方的 title */
export function setIcon(btn, name, size) {
    btn.replaceChildren(icon(name, size));
}

/** 图标 + 文案钮：图标打头，文案跟着，中间留一个字宽 */
export function setIconLabel(btn, name, label, size) {
    btn.replaceChildren(icon(name, size), ` ${label}`);
}
