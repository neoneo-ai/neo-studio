// app 单体的取值口径。官方前端把 app 实例装在 comfyAPI.app.app，而 comfyAPI 是逐键增量装配的，
// 装到那一句要等 app chunk 整个跑完；`import { app } from "scripts/app.js"` 是那份 shim 求值那一刻
// 的一次性快照，装配晚到它就是永久的 undefined —— 顶层 app.registerExtension(...) 当场抛
// "reading 'registerExtension' of undefined"，整条模块图被标成失败（再 import 只会得到
// "Failed to fetch dynamically imported module"），侧栏 tab 与顶栏按钮随它一起没了。
// 注册因此一律在调用时刻取值，装配晚到就等它落地。独立 Studio 页没有 ComfyUI 的 app 实例，
// shim/comfy-api.js 把 app 本体直接装在 comfyAPI.app 上，所以 app.app 缺席时退回 app。
const RETRY_MS = 250;
const RETRY_LIMIT = 40;   // 前端慢装配最多等 10 秒；注册不上的顶栏与侧栏不在页面上装空壳

/** 调用时刻的 app 单体；前端还没装配完时给 null。 */
export function comfyApp() {
    const api = window.comfyAPI;
    return api?.app?.app || api?.app || null;
}

/**
 * 注册 Neo Studio 的扩展。app 已就位就是同步注册（正常路径，不留定时器）；
 * 没就位就按 RETRY_MS 等到装配完成，等不到就在控制台说明不可用。
 */
export function registerExtension(ext) {
    let waited = 0;
    const attempt = () => {
        const app = comfyApp();
        if (app && addExtension(app, ext)) return;
        if (++waited >= RETRY_LIMIT) {
            console.warn(`[Neo Studio] ${ext?.name} 未注册：ComfyUI 的 app 单体没有装配完成，顶栏与侧栏入口本次不可用`);
            return;
        }
        setTimeout(attempt, RETRY_MS);
    };
    attempt();
}

function addExtension(app, ext) {
    try {
        if (app.extensionManager?.registerExtension) app.extensionManager.registerExtension(ext);
        else if (app.registerExtension) app.registerExtension(ext);
        else return false;
    } catch { return false; }
    // 前端装配半途退出时 registerExtension 是个空壳，调用不报错也不收扩展：
    // 以扩展列表收下为准，没收下就继续等下一次装配。
    const list = app.extensionManager?.extensions;
    return Array.isArray(list) ? list.some((e) => e?.name === ext?.name) : true;
}
