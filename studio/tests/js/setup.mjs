// 测试环境入口：注册模块钩子、建 jsdom、装桩。插件模块必须在导入本模块之后动态 import。
import { installHooks } from "./hooks.mjs";

installHooks();

import { JSDOM } from "jsdom";
import {
    installGlobals,
    installDeterminism,
    installMediaStub,
    installObserverStub,
    installRectStub,
    installPollSpeedup,
    resetDeterminism,
} from "./helpers/env.mjs";
import { installDialogs, resetDialogs, setConfirmAnswer, dialogs } from "./helpers/dialogs.mjs";
import { installFetch, mockRoute, clearRoutes, resetFetchLog, fetchLog, missingRoutes, jsonResponse, sseResponse } from "./helpers/fetch.mjs";
import { clearObjectInfoCache } from "../../web/js/core/object-info.js";
import { configure as configureRoutes } from "../../web/studio/shim/route.js";
import { setLang } from "../../web/js/core/i18n.js";

const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    url: "http://test.local/",
});

export const window = dom.window;

installGlobals(dom.window);
installDeterminism(dom.window);
installMediaStub(dom.window);
installObserverStub(dom.window);
installRectStub(dom.window);
installPollSpeedup(dom.window);
installDialogs(dom.window);
installFetch();

// 用例基线语言：jsdom 的 navigator.language 是 en-US，不钉中文的话断言里的中文原文会全变英文
setLang("zh");

export { mockRoute, clearRoutes, resetFetchLog, fetchLog, missingRoutes, jsonResponse, sseResponse };
export { dialogs, setConfirmAnswer, resetDialogs };
export { resetDeterminism };

/** 节点定义 fixture 同时挂到全量 /object_info 与按 class 的 /object_info/{class}（插件按 class 拉取）。 */
export function mockObjectInfo(fixture) {
    mockRoute("/object_info", () => jsonResponse(fixture));
    mockRoute("/object_info/*", (b, call, params) => jsonResponse({ [params.rest]: fixture[params.rest] }));
}
export { assertGolden, serializeDom, domSnapshot, fire, click, keydown, inputText, changeValue, makeFile, pasteClipboard, dropFiles, clearBody, flush, sleep } from "./helpers/dom.mjs";
export * as graph from "./helpers/fake-graph.mjs";

export function resetEnv() {
    resetDeterminism();
    resetDialogs();
    resetFetchLog();
    setLang("zh");               // 用例里切过英文要复位，避免串到后面的用例
    clearObjectInfoCache();   // 节点定义/模型目录缓存是模块级，清掉避免跨用例串味
    delete window.pywebview;  // 桌面端的 js_api 桩：用例各自声明，留着会让后面的「浏览器标签页」用例当桌面端窗口
    window.location.hash = "";   // 上一个个例留在 URL 里的 fragment：开机落哪一页全靠它，不复位就是串味
    document.body.innerHTML = "";
    document.body.className = "";   // 离线标记这类 body 级状态：不清的话会串到后面的用例
    configureRoutes({ desktopRoutes: [], comfyBase: "" });   // 归属表与直连目标是模块级：不复位的话翻面用例会把后面的用例打到 ComfyUI 上
}
