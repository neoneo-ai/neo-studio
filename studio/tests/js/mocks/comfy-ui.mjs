// scripts/ui.js 的 `$el` 替身：setup.mjs 把它装进 window.comfyAPI.ui，只覆盖 Neo Studio 用到的语义
// $el(tag, { className, id, textContent, innerHTML, value, style, dataset, onclick|onClick: fn, ...attrs }, children)
export function $el(tag, options = null, children = null) {
    const parts = Array.isArray(tag) ? tag : [tag];
    const el = document.createElement(parts[0]);
    if (parts.length > 1) el.classList.add(...parts.slice(1));

    if (options && typeof options === "object") {
        for (const [key, value] of Object.entries(options)) {
            if (value === undefined || value === null) continue;
            if (key === "class" || key === "className") {
                el.className = value;
            } else if (key === "id") {
                el.id = value;
            } else if (key === "textContent") {
                el.textContent = value;
            } else if (key === "innerHTML" || key === "html") {
                el.innerHTML = value;
            } else if (key === "style") {
                // 对齐真实 ComfyUI $el：style 必须是对象；传字符串会在 CSSStyleDeclaration 上报索引 setter 错误
                Object.assign(el.style, value);
            } else if (key === "dataset" && typeof value === "object") {
                Object.assign(el.dataset, value);
            } else if (typeof value === "function") {
                el.addEventListener(key.startsWith("on") ? key.slice(2) : key, value);
            } else if (key === "value") {
                el.value = value;
            } else {
                el.setAttribute(key, value);
            }
        }
    }

    const kids = children == null ? [] : Array.isArray(children) ? children : [children];
    for (const kid of kids) {
        if (kid == null) continue;
        el.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return el;
}
