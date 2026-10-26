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
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l1.582 6.135a.5.5 0 0 1-.962.963L14.063 15.5a2 2 0 0 0-1.437 1.437l-6.135 1.582a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174l-2.83 7.166 7.166-2.83z"/><path d="m15 5 4 4"/>',
    film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M20 7.5h-3"/><path d="M20 16.5h-3"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    wand: '<path d="m3 21 9-9"/><path d="m14 10 4 4"/><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8 19 13"/><path d="M12.2 6.2 11 5"/>',
    gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
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
