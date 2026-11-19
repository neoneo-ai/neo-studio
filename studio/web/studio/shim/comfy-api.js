// 独立 Studio 页面的 window.comfyAPI 装配：web/ 模块按官方入口取 $el
// （`const { $el } = window.comfyAPI.ui;` 在模块求值那一刻就要读到值），所以这份装配
// 必须排在 studio-app.js 之前加载，晚一步整页模块图在第一个 $el 处抛 undefined。
// 只有 studio/index.html 引用本文件：在 ComfyUI 文档里没有任何入口加载它，
// 前端自己装好的 window.comfyAPI 不会被这里的替身覆盖。
import { app } from "./app.js";
import { api } from "./api.js";
import { $el } from "./ui.js";

window.comfyAPI = {
    app,
    api: { api },
    ui: { $el },
};
