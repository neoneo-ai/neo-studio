// 把插件里 `../../scripts/app.js`、`../../../../scripts/app.js` 这类前端 shim 导入重定向到本地 mock。
// 必须在任何插件模块被解析之前调用（setup.mjs 的模块体里）。
import { registerHooks } from "node:module";

const SHIMS = {
    "app.js": "./mocks/comfy-app.mjs",
    "api.js": "./mocks/comfy-api.mjs",
};

let installed = false;

export function installHooks() {
    if (installed) return;
    installed = true;
    registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier.includes("scripts/")) {
                const rel = SHIMS[specifier.slice(specifier.lastIndexOf("/") + 1)];
                if (rel) return { url: new URL(rel, import.meta.url).href, shortCircuit: true };
            }
            return nextResolve(specifier, context);
        },
    });
}
