// CSS 结构完整性守卫：用 postcss 逐个解析 web/ 下的 .css，捕获未闭合块 / 语法错误。
// 这类错误在浏览器里是「静默」的——不报错、不白屏，只会让后续规则悄悄失效（级联被污染），
// 极难定位。postcss.parse 对真正的结构错误会抛 CssSyntaxError，正好在这里把它拦成红灯。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");

test("web/*.css 均为结构合法的 CSS（无未闭合块 / 语法错误）", async () => {
    const cssFiles = fs.readdirSync(webDir).filter((f) => f.endsWith(".css")).sort();
    assert.ok(cssFiles.length > 0, `未在 ${webDir} 找到 .css 文件`);

    const errors = [];
    for (const name of cssFiles) {
        const file = path.join(webDir, name);
        try {
            await postcss.parse(fs.readFileSync(file, "utf8"), { from: file });
        } catch (e) {
            const loc = e.line ? `（第 ${e.line} 行，第 ${e.column} 列）` : "";
            errors.push(`${name}${loc}: ${e.reason || e.message}`);
        }
    }

    assert.deepEqual(errors, [], "存在结构非法的 CSS：\n" + errors.join("\n"));
});


// ── 配色令牌：深浅两套值与桌面窗口底色 ──────────────────────

test("[data-neo-theme=light] 块只写令牌，关键底色与桌面窗口建窗底色同色", () => {
    const lightBlock = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8")
        .match(/\[data-neo-theme="light"\]\s*\{([^}]*)\}/);
    assert.ok(lightBlock, 'style.css 缺少 [data-neo-theme="light"] 令牌块');
    const tokens = new Map([...lightBlock[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)]
        .map(([, name, value]) => [name, value.trim().toLowerCase()]));
    assert.ok(tokens.size >= 20, `浅色令牌块只覆盖 ${tokens.size} 个令牌`);
    for (const name of ["--ns-bg", "--ns-panel", "--ns-panel-alt", "--ns-field",
                        "--ns-fg", "--ns-fg-2", "--ns-border", "--ns-accent"])
        assert.match(tokens.get(name) || "", /^#[0-9a-f]{6}$/, `${name} 的浅色值不是十六进制色`);
    // 桌面窗口建窗底色（app/studio_app.py 的 THEME_BG）与页面底色令牌同色：标题栏与页面不能两层色
    const py = fs.readFileSync(path.join(webDir, "..", "..", "app", "studio_app.py"), "utf8");
    const pyLight = py.match(/THEME_BG = \{[^}]*"light":\s*"(#[0-9a-f]{6})"/);
    assert.ok(pyLight, "app/studio_app.py 缺少 THEME_BG 的浅色底色");
    assert.equal(pyLight[1].toLowerCase(), tokens.get("--ns-bg"), "桌面窗口浅色底色与页面底色令牌不同色");
});
// agent-panel.css 用 --neo-vsc-* 时全部不带 fallback：名字缺定义时 CSS 不报错，整条声明在
// 计算期作废，绘画页输入卡就漏出页面底色——浅色系下是一块像被禁用的灰。深浅两块都得有定义。
test("--neo-vsc-* 在深浅两块都有定义（输入卡底色不靠 fallback）", () => {
    const styleCss = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
    const used = new Set();
    for (const name of fs.readdirSync(webDir).filter((f) => f.endsWith(".css"))) {
        const css = fs.readFileSync(path.join(webDir, name), "utf8");
        for (const m of css.matchAll(/var\((--neo-vsc-[a-z0-9-]+)/g)) used.add(m[1]);
    }
    assert.ok(used.size >= 20, `--neo-vsc-* 引用数量异常，解析未覆盖: ${used.size}`);
    const defined = (block) => new Set([...block.matchAll(/(--neo-vsc-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const dark = new Set([...styleCss.matchAll(/:root\s*\{([^}]*)\}/g)].flatMap((m) => [...defined(m[1])]));
    const light = new Set([...styleCss.matchAll(/\[data-neo-theme="light"\]\s*\{([^}]*)\}/g)].flatMap((m) => [...defined(m[1])]));
    // --neo-vsc-mono 是字体栈不是颜色，只在 :root 定义一次，浅色块靠继承拿到
    const themeOnly = new Set(["--neo-vsc-mono"]);
    const missing = [...used].sort().filter((n) => !dark.has(n) || (!light.has(n) && !themeOnly.has(n)));
    assert.deepEqual(missing, [], "缺少深色或浅色定义的 --neo-vsc-* 令牌");
});


// 提示词页（含技能弹窗 / 预设弹窗 / 组合框）是 body 上的浮层，scoped 选择器覆盖不到：
// 配色必须全部走 var(--ns-*)，暗色值只留在回退位，浅色块补齐同名令牌。
test("prompts.css 配色全部吃主题令牌，且每个令牌都有深浅两套值", () => {
    const css = fs.readFileSync(path.join(webDir, "prompts.css"), "utf8");
    const styleCss = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");

    const hardcoded = [...css.matchAll(/(?:background|background-color|color|border|border-color|border-\w+|box-shadow|fill|stroke|outline|accent-color)\s*:\s*([^;{}]+)/g)]
        .map(([, v]) => v.trim())
        .filter((v) => /#[0-9a-f]{3,8}\b|rgba?\(/.test(v) && !v.includes("var(--ns-"));
    assert.deepEqual(hardcoded, [], "prompts.css 存在未走令牌的配色：\n" + hardcoded.join("\n"));

    const lightBlock = styleCss.match(/\[data-neo-theme="light"\]\s*\{([^}]*)\}/);
    assert.ok(lightBlock, 'style.css 缺少 [data-neo-theme="light"] 令牌块');
    const darkNames = new Set([...styleCss.matchAll(/(--ns-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const lightNames = new Set([...lightBlock[1].matchAll(/(--ns-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...new Set([...css.matchAll(/var\((--ns-[a-z0-9-]+)/g)].map((m) => m[1]))];
    assert.ok(used.length > 100, `prompts.css 只引用了 ${used.length} 个令牌，疑似配色没接上主题`);
    assert.deepEqual(used.filter((n) => !darkNames.has(n) || !lightNames.has(n)), [],
        "prompts.css 用到的令牌缺少暗色或浅色值（浅色下会漏出深色）");

    // var() 必须逐行闭合：浏览器会整条丢掉不平衡的声明，等于配色没接上主题
    const unbalanced = css.split("\n")
        .filter((l) => l.includes("var(--ns-")
            && (l.match(/\(/g) || []).length !== (l.match(/\)/g) || []).length)
        .map((l) => l.trim());
    assert.deepEqual(unbalanced, [], "prompts.css 存在 var() 括号不平衡的声明：\n" + unbalanced.join("\n"));
});

// 浅色下输入框要接近白色、正文文字要够深：早期 fill_light 把暗底洗成中灰（rgb 187 一档）、
// 把深字洗成近白（浅色下等于白字白底），绘画/视频那类应用页的输入框因此整片偏暗。
test("浅色令牌：暗底洗白、深字压深，输入框底色不能停在灰", () => {
    const styleCss = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
    const lightBlock = styleCss.match(/\[data-neo-theme="light"\]\s*\{([^}]*)\}/);
    assert.ok(lightBlock, 'style.css 缺少 [data-neo-theme="light"] 令牌块');
    const defs = (block) => new Map([...block.matchAll(/(--ns-[a-z0-9-]+)\s*:\s*([^;]+);/g)]
        .map(([, n, v]) => [n, v.trim().toLowerCase()]));
    const dark = defs(styleCss.slice(0, lightBlock.index));
    const light = defs(lightBlock[1]);
    const lum = (v) => {
        let m = v.match(/^#([0-9a-f]{6})/);
        if (m) { const h = parseInt(m[1], 16); return (((h >> 16) & 255) * 0.2126 + ((h >> 8) & 255) * 0.7152 + (h & 255) * 0.0722) / 255; }
        m = v.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) return (+m[1] * 0.2126 + +m[2] * 0.7152 + +m[3] * 0.0722) / 255;
        return null;
    };
    const darkTooGray = [], textInvisible = [];
    for (const [name, lv] of light) {
        const dv = dark.get(name);
        if (!dv || dv.startsWith("var(") || lv.startsWith("var(")) continue;
        const dl = lum(dv), ll = lum(lv);
        if (dl === null || ll === null) continue;
        if (/^--ns-(background|background-color|background-image|p-bg|p-other)-/.test(name) && dl <= 0.28 && ll < 0.94)
            darkTooGray.push(`${name}: dark=${dv} light=${lv}`);
        if (/^--ns-(color-|p-fg-)/.test(name) && dl >= 0.6 && ll > 0.55)
            textInvisible.push(`${name}: dark=${dv} light=${lv}`);
    }
    assert.deepEqual(darkTooGray, [], "浅色下输入框/面板底色停在灰：\n" + darkTooGray.join("\n"));
    assert.deepEqual(textInvisible, [], "浅色下正文文字被洗成近白：\n" + textInvisible.join("\n"));
});


// 输入卡 / 预览框 / 文本域这类「页面内嵌表面」在浅色下必须近白：scrim 族的语义是往页面上压一层黑，
// 白页上压 35% 黑就是一块中灰，读起来像被禁用的输入框。这些表面走 --ns-inset-surface*，浅色只许压 ≤0.10 的黑；
// 阴影与图上蒙层（含参考图的黑底 letterbox）继续吃 scrim 族——深色底上压黑在两个主题下都是对的。
test("浅色下输入卡/预览框不吃黑色蒙层，底色停在灰就是红灯", () => {
    const styleCss = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
    const css = fs.readFileSync(path.join(webDir, "gallery.css"), "utf8");
    const lightBlock = styleCss.match(/\[data-neo-theme="light"\]\s*\{([\s\S]*?)\n\}/);
    assert.ok(lightBlock, 'style.css 缺少 [data-neo-theme="light"] 令牌块');
    const light = new Map([...lightBlock[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, n, v]) => [n, v.trim()]));
    const blackAlpha = (v) => {
        const m = /^rgba\(\s*0,\s*0,\s*0,\s*([\d.]+)\s*\)$/.exec(v);
        return m ? parseFloat(m[1]) : null;
    };
    const surface = /\.(neo-gallery-gm-composer|neo-gallery-gm-preview|neo-gallery-story-idea|neo-gallery-story-grid|neo-gallery-rp-result|neo-gallery-story-ref)(?!-img)\b/;
    const offenders = [];
    for (const rule of css.matchAll(/([^\n{}]+)\{([^}]*)\}/g)) {
        const sel = rule[1].replace(/\s+/g, " ").trim();
        if (!surface.test(sel)) continue;
        for (const part of rule[2].split(";")) {
            const decl = part.trim();
            if (!/^background(-color)?:/.test(decl)) continue;
            const m = decl.match(/var\((--[\w-]+)/);
            if (!m) continue;
            if (m[1].startsWith("--ns-scrim-")) { offenders.push(`${sel}: 表面底色吃了黑色蒙层 ${m[1]}`); continue; }
            const a = blackAlpha(light.get(m[1]) || "");
            if (a !== null && a > 0.1) offenders.push(`${sel}: ${m[1]} 浅色压黑 ${a} > 0.10`);
        }
    }
    assert.deepEqual(offenders, [], "浅色下输入卡/预览框底色停在灰：\n" + offenders.join("\n"));
});
