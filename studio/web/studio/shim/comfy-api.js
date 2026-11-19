// 独立 Studio 页面的 window.comfyAPI 装配：web/ 模块按官方入口取 $el
// （`const { $el } = window.comfyAPI.ui;` 在模块求值那一刻就要读到值），所以这份装配
// 必须排在 studio-app.js 之前加载，晚一步整页模块图在第一个 $el 处抛 undefined。
// 本文件会被 ComfyUI 的前端扩展加载器当扩展导入（它把 web/ 下每个 .js 都列进扩展表），
// 在 ComfyUI 文档里执行那句赋值就是把官方装配整份换掉：comfyAPI.app.app 从此是 undefined，
// 每个插件顶层的 app.registerExtension(...) 一起抛，侧栏与顶栏全没。因此只认 Studio 页自己的
// #ns-view 根节点：不在 Studio 页上就不碰 window.comfyAPI。
import { app } from "./app.js";
import { api } from "./api.js";
import { $el } from "./ui.js";

if (document.getElementById("ns-view")) {
    window.comfyAPI = {
        app,
        api: { api },
        ui: { $el },
    };
}
