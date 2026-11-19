/**
 * theme.js —— Studio 页面配色：深色是基准，浅色只覆盖同名 token，auto 交给系统。
 *
 * 深色就是 CSS 里那份基准：token 定义在 :root，[data-neo-theme="light"] 覆盖同名 token，
 * 属性也只挂在 Studio 页面自己的 <html> 上 —— ComfyUI 的画布与节点面板不进这套级联。
 * 选择存 localStorage（neo_studio_theme），没存过 = auto，按系统 prefers-color-scheme 定深浅。
 * 换配色只改 <html data-neo-theme>，不整页刷新：纯 CSS 级联没有模块级常量要重建，
 * 画布上正开的设置弹窗也不会因为切个颜色被打断（语言要刷新是另一回事）。
 * 生效深浅同时写进 <html data-neo-theme-resolved> 并回报桌面端，桌面端跟着换窗口底色。
 */

const THEME_KEY = "neo_studio_theme";

export const THEMES = [
    { value: "auto", label: "跟随系统" },
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" },
];

/** 存下来的选择：键不存在、值认不出来（手写过的脏值）一律落回 auto。 */
export function getTheme() {
    try {
        const saved = localStorage.getItem(THEME_KEY);
        return saved === "light" || saved === "dark" ? saved : "auto";
    } catch {
        return "auto";   // 隐私模式下 localStorage.getItem 直接抛
    }
}

function systemTheme() {
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

/** 选择 → 真正生效的深浅：auto 交给系统，其余照选。 */
export function resolveTheme(value = getTheme()) {
    return value === "auto" ? systemTheme() : value;
}

/** 页面上此刻生效的深浅（首帧由 index.html 的内联脚本钉好，这里读的就是那一枚）。 */
export function effectiveTheme() {
    return document.documentElement.dataset.neoTheme === "light" ? "light" : "dark";
}

/** 写进 <html> 并回报桌面端：CSS 只认 data-neo-theme，桌面端要的是生效深浅。 */
export function applyTheme(value = getTheme()) {
    const theme = resolveTheme(value);
    document.documentElement.dataset.neoTheme = theme;
    document.documentElement.dataset.neoThemeResolved = theme;
    // 桌面端窗口（pywebview 的 js_api）换标题栏与边框底色；浏览器标签页没有这座桥
    window.pywebview?.api?.set_theme?.(theme)?.catch?.(() => {});
    return theme;
}

/** 选一次配色：落盘 + 当场生效，返回生效深浅给提示文案。 */
export function setTheme(value) {
    const saved = value === "light" || value === "dark" ? value : "auto";
    try {
        localStorage.setItem(THEME_KEY, saved);
    } catch { /* 隐私模式：这一轮生效，落不了盘 */ }
    return applyTheme(saved);
}

/** 选了 auto 就要在系统翻面时跟着翻；选死深浅时不动。 */
export function watchSystemTheme() {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", () => {
        if (getTheme() === "auto") applyTheme("auto");
    });
}

/** 设置页与顶栏共用的一组单选：选完即生效，下方一行说明当前生效的是哪套。 */
export function initThemeControl(t, tf) {
    const status = document.createElement("div");
    status.className = "ns-theme-status";
    const refresh = () => {
        const theme = effectiveTheme();
        status.textContent = tf("当前生效：{theme}{auto}", {
            theme: t(theme === "light" ? "浅色" : "深色"),
            auto: getTheme() === "auto" ? t("（跟随系统）") : "",
        });
    };
    const rows = THEMES.map((opt) => {
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "ns-theme";
        input.value = opt.value;
        input.checked = opt.value === getTheme();
        input.addEventListener("change", () => {
            setTheme(opt.value);
            for (const row of rows) row.querySelector("input").checked = row.querySelector("input").value === opt.value;
            refresh();
        });
        const label = document.createElement("label");
        label.className = "ns-theme-row";
        const name = document.createElement("span");
        name.textContent = t(opt.label);
        label.append(input, name);
        return label;
    });
    const el = document.createElement("div");
    el.className = "ns-theme";
    const hint = document.createElement("div");
    hint.className = "ns-theme-hint";
    hint.textContent = t("选择后立即生效，不需要刷新。只影响 Studio 页面：ComfyUI 画布与节点面板保持深色。");
    el.append(...rows, status, hint);
    refresh();
    return { el, refresh };
}
