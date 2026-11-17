// 应用注册表（web/studio/app-registry.js）的跨文件契约：一条描述符要在四处都兑现——
// 首页卡（home-layout.js 的 HOME_CARDS）、顶栏页签（index.html）、常驻页集合、装配层的 build 点名
// （studio-app.js 的 PAGE_BUILDERS）。以前这四处分头写，漏一处就是「卡点下去停在空白页」；
// 现在由这几发用例把四处钉在同一张表上。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./setup.mjs";   // 卡表那侧要 jsdom：模块钩子与全局必须在 import 它之前装好
import { HOME_CARDS } from "../../web/studio/home-layout.js";
import { ICON_NAMES } from "../../web/js/core/icons.js";
import { STUDIO_APPS, appById, homeCards, tabAppIds } from "../../web/studio/app-registry.js";

const studioDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/studio");
const indexHtml = fs.readFileSync(path.join(studioDir, "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(studioDir, "studio-app.js"), "utf8");

const sorted = (ids) => [...ids].sort();

test("描述符形状：id 不重复，有首页卡的那几条齐板块/图标/两行字，图标是页上画得出的那一名", () => {
    const ids = STUDIO_APPS.map((app) => app.id);
    assert.equal(new Set(ids).size, ids.length, "注册表里同一条页名不能出现两次");
    for (const app of STUDIO_APPS) {
        assert.match(app.id, /^[a-z][a-z0-9_]*$/, `注册表 id ${app.id} 必须是 hash 路由用的那形状`);
        if (!app.section) continue;
        assert.ok(["create", "edit", "material"].includes(app.section), `${app.id} 的板块名不在那三个里`);
        assert.ok(app.title && app.sub, `${app.id} 有首页卡却没写两行字`);
        assert.ok(ICON_NAMES.includes(app.icon), `${app.id} 的图标 ${app.icon} 是画不出的一名`);
    }
});

test("首页卡与页同源：注册表派生的直连卡就是卡表里的那一叠，落点指回注册表里的页", () => {
    const derived = homeCards();
    const pageCards = HOME_CARDS.filter((c) => c.target === "page");
    assert.deepEqual(sorted(pageCards.map((c) => c.id)), sorted(Object.keys(derived)),
        "卡表里直连本页的卡与注册表派生的那叠对不上（加页要在注册表写一条，卡表点名处也要写一行）");
    for (const card of pageCards) {
        const fromRegistry = derived[card.id];
        assert.ok(fromRegistry, `卡表的直连卡 ${card.id} 不在注册表里`);
        assert.deepEqual(card, fromRegistry, `卡表把直连卡 ${card.id} 又自己写了一遍`);
        assert.ok(appById(card.value), `卡 ${card.id} 落的页 ${card.value} 不在注册表里：点下去是空白页`);
    }
    // 卡 id 存在用户版式的 order/hidden 里：与页名同名的卡不写 cardId，旧版式里那两名才写
    for (const app of STUDIO_APPS) {
        if (app.cardId) assert.notEqual(app.cardId, app.id, `${app.id} 写了 cardId 又与页名相同`);
    }
});

test("顶栏页签：index.html 那一排页签落在的页，与注册表说该有页签的那一撮一模一样", () => {
    const domTabs = [...indexHtml.matchAll(/<a href="#\/[a-z_]+" data-tab="([a-z_]+)">/g)].map((m) => m[1]);
    assert.deepEqual(sorted(domTabs), sorted(tabAppIds()),
        "页签与注册表的 tab 对不上：注册表有 tab 而 index.html 没那一格 = 页签永不出现");
    assert.ok(appSource.includes('from "./app-registry.js"'), "装配层没把注册表引进来：路由与页签可见性还在各写各的");
});

test("常驻视图就是首页 / 导演 / 绘画 / 编辑四页：首页卡片直达的三页必须在第一次点之前挂好", () => {
    assert.deepEqual(sorted(STUDIO_APPS.filter((app) => app.eager).map((app) => app.id)),
        sorted(["home", "director", "paint", "edit"]));
});

test("注册表每一条都在装配层点名了一个 build：表里有一条、装配层缺点名 = 那一页点下去是空白页", () => {
    const block = appSource.match(/const PAGE_BUILDERS = \{([\s\S]*?)\};/);
    assert.ok(block, "装配层没有 PAGE_BUILDERS 这张表：路由的页名与页的实现又分头写了");
    const named = [...block[1].matchAll(/([A-Za-z_]+)\s*:/g)].map((m) => m[1]);
    assert.deepEqual(sorted(named), sorted(STUDIO_APPS.map((app) => app.id)),
        "PAGE_BUILDERS 点名的页与注册表对不上（缺的那一条点下去是空白页，多的那一条是死代码）");
});

test("深链参数只挂在认它的页上：首页配方卡开导演页，智能体页的入口开设置的那一栏", () => {
    const deepApps = STUDIO_APPS.filter((app) => app.deep).map((app) => [app.id, app.deep]);
    assert.deepEqual(deepApps, [["director", "recipe"], ["settings", "tab"]],
        "深链参数与认它的页对不上：路由只认注册表这一处，写歪了就没人接");
});

test("后端那份技能落地页清单与注册表同源：frontmatter 的 landing 只认这里那一名", () => {
    const py = fs.readFileSync(path.resolve(studioDir, "..", "..", "skill.py"), "utf8");
    const block = py.match(/SKILL_LANDINGS = \(([\s\S]*?)\)/);
    assert.ok(block, "studio/skill.py 没有 SKILL_LANDINGS 那份清单：落点合法性就没有人校验了");
    const landings = [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(sorted(landings), sorted(STUDIO_APPS.map((app) => app.id)),
        "技能能声明的落地页与注册表里的页对不上：写得出、跳不动的落点就是点了没反应");
});
