// E2E：/neo-studio 在 390×844 手机视口下的版式不变量（纯前端：注入 web/*.css 与真实同构 DOM，不需要 ComfyUI 在跑）。
// 三条一改就碎的形态：整页横向溢出、两栏并排被压成读不了的窄条、只靠 :hover 显形的控件在手指上等于不存在。
// 同一批形态在 1440×900 桌面视口再验一遍反向断言：手机那一档不许动桌面宽窗口与 ComfyUI 侧栏的版式。
// 用法：npm run e2e
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const css = (f) => fs.readFileSync(path.join(webDir, f), "utf8");

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

// 顶栏与 studio/index.html 同构：8 枚页签 + ComfyUI 状态位，窄屏这一条要能横滚
const header = `
<header class="ns-header">
  <a class="ns-logo" href="#/home">新影工坊</a>
  <nav class="ns-tabs">
    <a href="#/home" data-tab="home" class="active">首页</a>
    <a href="#/gallery" data-tab="gallery">素材</a>
    <a href="#/paint" data-tab="paint">绘画</a>
    <a href="#/video" data-tab="video">视频</a>
    <a href="#/director" data-tab="director">导演</a>
    <a href="#/pose" data-tab="pose">摆姿</a>
    <a href="#/skills" data-tab="skills">技能</a>
    <a href="#/settings" data-tab="settings">设置</a>
  </nav>
  <span class="ns-comfy-status"><span class="ns-comfy-dot ns-comfy-run"></span>运行中</span>
</header>`;

const page = (cls, body) => `<main class="ns-page ${cls}">${body}</main>`;
const svgImg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="100%" height="100%" fill="#777"/></svg>')}`;

const homePage = page("ns-home", `
  <div class="ns-home">
    <div class="ns-home-hero">
      <h1>写一句话，出<span class="ns-home-accent">提示词 · 图 · 片</span></h1>
      <p>模型、参数与工作流由 Neo Studio 备好，写完直接出图。</p>
      <button class="ns-home-cta">从一句话开始</button>
    </div>
    <div class="ns-home-section">生成</div>
    <div class="ns-home-grid">
      ${["文生图", "图片编辑", "文生视频"].map((t) => `
        <a class="ns-home-card">
          <span class="ns-home-card-icon">✦</span>
          <span class="ns-home-card-text"><span class="ns-home-card-title">${t}</span><span class="ns-home-card-sub">一句话起手，参数在下一屏</span></span>
          <span>›</span>
        </a>`).join("")}
    </div>
  </div>`);

// 导演页（编辑器挂着）：生成面板的宽是分隔条拖过之后写进内联样式的，这里照写一条，验窄屏压得住它
const directorPage = page("ns-director", `
  <div class="ns-director-main">
    <div class="ns-director-editor">
      <div class="neo-director-panel neo-director-embedded">
        <div class="neo-director-title">
          <div class="neo-director-title-left"><span>分镜视频导演</span></div>
          <div class="neo-director-tabs"><button class="neo-director-tab active">时间线</button></div>
          <div class="neo-director-title-btns"><button class="neo-director-close">✕</button></div>
        </div>
        <div class="neo-director-body"><div class="neo-director-timeline"></div></div>
        <div class="neo-director-foot"><button class="rs-btn neo-director-cancel">取消</button><button class="rs-btn neo-director-save">保存</button></div>
      </div>
    </div>
    <div class="ns-director-split"></div>
    <div class="ns-gen-panel neo-gallery-panel" style="width: 470px">
      <div class="ns-gen-body">
        <div class="ns-gen-left"><div class="neo-gallery-story-actions"><button class="rs-btn">生成整片</button></div></div>
      </div>
    </div>
  </div>`);


// 绘画页（文生图）：与 gallery-gen.js 嵌进 .ns-paint-panel 的那块同构
const paintPage = page("ns-paint", `
  <div class="ns-paint-main">
    <div class="ns-paint-modes">
      <button class="ns-paint-mode-btn ns-paint-mode-on">文生图</button>
      <button class="ns-paint-mode-btn">图片编辑</button>
      <button class="ns-paint-lib-btn ns-btn">素材库</button>
    </div>
    <div class="ns-paint-panel ns-paint-text neo-gallery-panel">
      <div class="neo-gallery-gen-panel">
        <div class="neo-gallery-story-modal neo-gallery-story-modal--embedded">
          <div class="neo-gallery-cs-status"><div class="neo-gallery-gm-idle"><div class="neo-gallery-gm-idle-title">写一句话，回车即开</div></div></div>
          <div class="neo-gallery-gm-composer">
            <textarea class="neo-gallery-gm-quick-input" rows="4"></textarea>
            <div class="neo-gallery-gm-composer-bar neo-gallery-gm-chips">
              <span class="neo-gallery-gm-chip-wrap"><button class="neo-gallery-gm-chip-btn"><span class="neo-gallery-gm-chip-label">Qwen Image 2.1 · 1024×1024 · Steps 30 · Seed 123456 · LoRA 2</span></button></span>
              <div class="neo-gallery-gm-composer-gap"></div>
              <button class="neo-gallery-story-btn neo-gallery-story-btn-primary neo-gallery-gm-gen-btn">生成</button>
            </div>
          </div>
          <div class="neo-gallery-story-actions"><button class="neo-gallery-story-btn">存为配方</button></div>
        </div>
      </div>
    </div>
  </div>`);

const videoPage = page("ns-video", `
  <div class="ns-video-page">
    <div class="ns-video-stage">
      <div class="ns-video-clip">
        <video class="ns-video-player" controls></video>
        <div class="ns-video-clip-meta"><span class="ns-video-clip-name">一段海边.mp4</span><span class="ns-video-open">打开目录</span></div>
      </div>
    </div>
    <div class="ns-video-dock">
      <div class="ns-video-card neo-gallery-gm-composer">
        <div class="ns-video-head">
          <span class="ns-video-status">队列中 · 3/8 段</span>
          <div class="ns-gen-progress ns-video-progress"><div style="width:40%"></div></div>
        </div>
        <div class="ns-video-top">
          <div class="ns-video-deck"><span class="ns-video-refdrop">首帧</span><span class="ns-video-refdrop">尾帧</span><span class="ns-video-refdrop">参考图</span></div>
          <div class="ns-video-input">
            <textarea class="ns-video-prompt" rows="2"></textarea>
            <span class="ns-video-count">12</span>
          </div>
        </div>
        <div class="ns-video-chips neo-gallery-gm-composer-bar neo-gallery-gm-chips">
          <span class="neo-gallery-gm-chip-wrap"><button class="neo-gallery-gm-chip-btn"><span class="neo-gallery-gm-chip-label">Kling 2.1 · 1080p · 5s · Steps 30 · Seed 123456 · LoRA 2 · 提示词增强</span></button></span>
          <label class="ns-video-chip neo-gallery-gm-chip-group"><input class="ns-video-seed" type="number" value="123456"></label>
          <div class="neo-gallery-gm-composer-gap"></div>
          <button class="ns-video-cancel neo-gallery-story-btn">取消</button>
          <button class="ns-video-run neo-gallery-story-btn neo-gallery-story-btn-primary neo-gallery-gm-gen-btn">生成</button>
        </div>
      </div>
    </div>
  </div>`);

// 技能页（技能管理装配后）：与 skill.js 的 createSkillManagerPage 同构。
// 左栏宽度是拖过分隔条之后写进内联样式并落 localStorage 的，这里照写一条验窄屏压得住它
const skillsPage = page("ns-skills ns-skills-editing", `
  <div class="ns-skills-page">
    <div class="ns-skills-guide ns-hidden"></div>
    <div class="ns-skills-manager">
      <div class="rs-skill-manager">
        <div class="rs-skill-manager-head"><span class="rs-skill-manager-title">技能管理</span></div>
        <div class="rs-skill-manager-body">
          <div class="rs-skill-manager-left" style="width: 420px">
            <div class="rs-skill-item"><span class="rs-skill-item-name">Hug 控制</span></div>
          </div>
          <div class="rs-skill-manager-split"></div>
          <div class="rs-skill-manager-right">
            <div class="rs-skill-modal rs-skill-detail">
              <div class="rs-skill-modal-header"><span class="rs-skill-modal-title">Hug 控制</span></div>
              <div class="rs-skill-detail-actions"><button class="rs-btn">保存</button><button class="rs-btn">删除</button><button class="rs-btn">导出</button></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`);

const settingsPage = page("ns-settings-page", `
  <div class="ns-settings">
    <div class="ns-settings-tabs">
      <button class="ns-settings-tab">远程 LLM</button>
      <button class="ns-settings-tab active">启动设置</button>
      <button class="ns-settings-tab">关于</button>
    </div>
    <div class="ns-settings-content">
      <div class="ns-kernel">
        <span class="ns-kernel-state ns-kernel-run">ComfyUI 运行中</span>
        <span class="ns-kernel-note">端口 8188</span>
        <div class="ns-kernel-actions"><button class="ns-btn">重启</button><button class="ns-btn">停止</button></div>
      </div>
      <div class="ns-settings-section">
        <h3>ComfyUI 根目录</h3>
        <div class="ns-launch-row">
          <span class="ns-launch-label">根目录<span class="ns-info" data-tip="便携包的 ComfyUI 位置">i</span></span>
          <input class="ns-launch-input" value="D:\\ComfyUI">
        </div>
        <div class="ns-launch-actions"><button class="ns-btn ns-launch-apply">应用并重启</button></div>
      </div>
      <div class="ns-settings-section">
        <h3>关于</h3>
        <div class="ns-about-rows">
          <div class="ns-about-row">
            <span class="ns-about-label">数据目录</span>
            <span class="ns-about-value">D:\\Neo-Studio\\data\\gallery\\output\\2026-11-02</span>
            <div class="ns-about-btns"><button class="ns-btn ns-about-copy">复制</button><button class="ns-btn ns-about-open">打开</button></div>
          </div>
        </div>
      </div>
    </div>
  </div>`);

// 素材页：与 gallery.js 的 .neo-gallery-panel 同构。卡片上的取用 / 目录菜单 / 收藏与缩略图上的
// 操作条、收藏星、目录行的 隐藏/删除/设置 全是 opacity:0 的悬停控件，触摸档必须常驻
const galleryPage = page("ns-page--gallery", `
  <div class="ns-gallery-host">
    <div class="neo-gallery-panel neo-gallery-panel--wide">
      <div class="neo-gallery-topbar">
        <div class="neo-gallery-nav-group"><button class="neo-gallery-nav-btn">‹</button><button class="neo-gallery-nav-btn">›</button></div>
        <div class="neo-gallery-breadcrumb"><span>Output</span></div>
        <div class="neo-gallery-search-container"><input class="neo-gallery-search" placeholder="搜索图片"></div>
        <button class="neo-gallery-gm-btn">生成素材</button>
        <div class="neo-gallery-kind-bar"><button class="neo-gallery-kind-tab is-active">全部</button><button class="neo-gallery-kind-tab">图片</button></div>
      </div>
      <div class="neo-gallery-accordion">
        <div class="neo-gallery-dir-item">
          <span class="neo-gallery-dir-item-icon">📁</span>
          <span class="neo-gallery-dir-item-name">Output</span>
          <span class="neo-gallery-dir-item-actions"><button>隐藏</button><button>删除</button></span>
        </div>
        <div class="neo-gallery-category-card" style="width: 184px">
          <div class="neo-gallery-card-cover-wrapper"><div class="neo-gallery-card-cover-grid">
            <div class="neo-gallery-card-cover-grid-item"><img src="${svgImg}" alt=""></div>
          </div></div>
          <button class="neo-gallery-card-lora-send-btn">⚡</button>
          <button class="neo-gallery-card-dir-menu-btn">⋯</button>
          <button class="neo-gallery-card-civitai-save-btn">★</button>
          <div class="neo-gallery-card-label">sea.png</div>
        </div>
        <div class="neo-gallery-thumb-container" style="width: 184px">
          <div class="neo-gallery-thumb-img-wrapper"><img class="neo-gallery-thumb-img" src="${svgImg}" alt=""></div>
          <div class="neo-gallery-thumb-container-bottom">
            <div class="neo-gallery-thumb-info"><span class="neo-gallery-thumb-name">sea.png</span><span class="neo-gallery-thumb-date">11-02</span></div>
            <div class="neo-gallery-thumb-btn-bar"><button>✕</button><button>ℹ</button></div>
          </div>
          <button class="neo-gallery-thumb-bookmark-btn">⭐</button>
        </div>
      </div>
    </div>
  </div>`);

const libmodalPage = `
<div class="ns-libmodal">
  <div class="ns-libmodal-box">
    <div class="ns-libmodal-titlebar"><span class="ns-libmodal-title">素材库</span><button class="ns-libmodal-close">✕</button></div>
    <div class="ns-libmodal-content"><div class="ns-gallery-host"></div></div>
    <div class="ns-libmodal-pickbar"><span class="ns-libmodal-pick-count">已选 2 项</span><button class="ns-btn ns-libmodal-pick-use">取用</button></div>
    <div class="ns-libmodal-resize"></div>
  </div>
</div>`;

const lightboxPage = `
<div class="neo-lightbox neo-lightbox-with-panel">
  <div class="neo-lightbox-box neo-lightbox-with-panel">
    <div class="neo-lightbox-main">
      <div class="neo-lightbox-stage">
        <img class="neo-lightbox-media" src="${svgImg}" alt="">
        <button class="neo-lightbox-close">✕</button>
        <button class="neo-lightbox-nav neo-lightbox-prev">‹</button>
        <button class="neo-lightbox-nav neo-lightbox-next">›</button>
      </div>
      <div class="neo-lightbox-meta"><span class="neo-lightbox-counter">1 / 8</span><span class="neo-lightbox-caption">sea.png</span></div>
    </div>
    <div class="neo-lightbox-panel"><div class="neo-lightbox-panel-title">提示词</div></div>
  </div>
</div>`;

const posePage = page("ns-pose", `
  <div class="ns-pose">
    <div class="ns-pose-top">
      <span class="ns-pose-title">摆姿</span>
      <input class="ns-pose-name" placeholder="姿势名">
      <button class="ns-pose-random ns-btn">随机</button>
      <button class="ns-pose-save ns-btn">保存</button>
    </div>
    <div class="ns-pose-body">
      <aside class="ns-pose-side"><div class="ns-pose-lib-grid"><div class="ns-pose-lib-card"><div class="ns-pose-lib-thumb"></div></div></div></aside>
      <div class="ns-pose-stage"><canvas></canvas></div>
      <aside class="ns-pose-side ns-pose-panel"><div class="ns-pose-section"><span class="ns-pose-section-title">关节</span></div></aside>
    </div>
  </div>`);

const agentPage = page("ns-agent-page", `
  <div class="ns-agent-chat">
    <div class="neo-agent">
      <div class="neo-agent-body"><div class="neo-agent-empty">从一句话开始</div></div>
      <div class="neo-agent-foot"><textarea class="neo-agent-input"></textarea><button class="neo-agent-send">发送</button></div>
    </div>
  </div>`);

const doc = (body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>html,body{margin:0;height:100%;background:#14161a;color:#cfd6e0;font:13px sans-serif}*{box-sizing:border-box}</style>
<style>${css("studio/style.css")}</style><style>${css("gallery.css")}</style><style>${css("prompts.css")}</style>
<style>${css("recipes.css")}</style><style>${css("lightbox.css")}</style><style>${css("pose/pose.css")}</style>
<style>${css("agent-panel.css")}</style></head>
<body>${header}<div class="ns-body"><main class="ns-view">${body}</main></div></body></html>`;

const PAGES = {
    home: homePage, director: directorPage, paint: paintPage, video: videoPage,
    skills: skillsPage, settings: settingsPage, gallery: galleryPage,
    libmodal: libmodalPage, lightbox: lightboxPage, pose: posePage, agent: agentPage,
};

let browser;
// 本机没跑过 `npx playwright install` 时缓存里是旧 revision 的可执行文件，直接 launch 会报
// "Executable doesn't exist"；退回系统 Chrome，用例在同一台机器上就能跑
const launchBrowser = async () => {
    try {
        return await chromium.launch({ headless: true });
    } catch {
        return await chromium.launch({ headless: true, channel: "chrome" });
    }
};
test.before(async () => { browser = await launchBrowser(); });
test.after(async () => { await browser.close(); });

/** 在指定视口里装一页，跑一段页面内测量；touch 为真时用 CDP 把 hover/pointer 钉成触摸档
    （Playwright 没有改媒体特性的 API，触摸档那批规则全靠这一对判定） */
async function measure(body, viewport, { touch = false } = {}, fn) {
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
    const p = await context.newPage();
    await p.setContent(doc(body), { waitUntil: "load" });
    if (touch) {
        const cdp = await context.newCDPSession(p);
        await cdp.send("Emulation.setEmulatedMedia", {
            media: "",
            features: [{ name: "hover", value: "none" }, { name: "pointer", value: "coarse" }],
        });
    }
    await p.waitForTimeout(60);   // 等 CSS 落位与过渡跑完，不等任何异步数据
    const out = await p.evaluate(fn);
    await context.close();
    return out;
}



// 手机视口的公共底线：整份文档与所在页都不许出横向滚动条；顶栏页签条必须能横滚
const overflowCheck = () => {
    const pages = [...document.querySelectorAll(".ns-page, .ns-libmodal-box, .neo-lightbox-box")];
    const tabs = document.querySelector(".ns-tabs");
    // 贴右排布的溢出落在滚动原点左边的负区，scrollLeft 钳在 0 —— 手指滚不回去。studio-app.js 的
    // showView 按「页签宽之和 + 行距」判溢出并落 ns-tabs-scroll 翻成左起；fixture 不跑那段 JS，
    // 这里同一条测量与同一次 scrollIntoView（下一条顶栏用例）一样复刻过来
    const links = [...tabs.querySelectorAll("a")];
    const gap = parseFloat(getComputedStyle(tabs).columnGap) || 0;
    const need = links.reduce((sum, a) => sum + a.offsetWidth, 0) + gap * Math.max(0, links.length - 1);
    tabs.classList.toggle("ns-tabs-scroll", need > tabs.clientWidth + 1);
    tabs.scrollLeft = 9999;   // 左起之后溢出在右侧，滚到末端读回来就是「滚得开」的实证
    return {
        innerWidth: window.innerWidth,
        docScroll: document.documentElement.scrollWidth,
        widest: Math.max(...pages.map((el) => el.scrollWidth)),
        tabsScrolled: Math.abs(Math.round(tabs.scrollLeft)),
        tabsClient: tabs.clientWidth,
    };
};

for (const [name, body] of Object.entries(PAGES)) {
    test(`手机 390 宽：${name} 页不出横向滚动，顶栏页签条可横滚`, async () => {
        const m = await measure(body, MOBILE, { touch: true }, overflowCheck);
        assert.ok(m.docScroll <= m.innerWidth + 1, `${name}：整页出横向滚动（scrollWidth ${m.docScroll} > ${m.innerWidth}）`);
        assert.ok(m.widest <= m.innerWidth + 1, `${name}：页面容器溢出视口（${m.widest} > ${m.innerWidth}）`);
        assert.ok(m.tabsScrolled > 0, `${name}：顶栏页签条在手机上滚不动（滚到 ${m.tabsScrolled} / 可视 ${m.tabsClient}）`);
    });
}

test("手机顶栏：8 枚页签横滚后，选中那枚滚进可视区（showView 里的 scrollIntoView）", async () => {
    const m = await measure(homePage, MOBILE, { touch: true }, () => {
        const tabs = document.querySelector(".ns-tabs");
        const deep = tabs.querySelector('[data-tab="settings"]');
        deep.scrollIntoView({ inline: "center", block: "nearest" });   // 与 studio-app.js 的 showView 同一条调用
        const bar = tabs.getBoundingClientRect();
        const tab = deep.getBoundingClientRect();
        return {
            barRight: Math.round(bar.right), tabRight: Math.round(tab.right), tabLeft: Math.round(tab.left),
            tabH: Math.round(tab.height),
            headerH: Math.round(document.querySelector(".ns-header").getBoundingClientRect().height),
            statusShown: getComputedStyle(document.querySelector(".ns-comfy-status")).display !== "none",
        };
    });
    assert.ok(m.tabRight <= m.barRight + 1 && m.tabLeft >= 0, `选中页签没进可视区：${m.tabLeft} → ${m.tabRight} / 条右缘 ${m.barRight}`);
    assert.ok(m.tabH >= 44, `页签触摸目标只有 ${m.tabH}px`);
    assert.ok(m.headerH >= 44 && m.headerH <= 52, `顶栏高度 ${m.headerH}px 不是一行的量`);
    assert.ok(!m.statusShown, "390 宽里 ComfyUI 状态位没让位给页签");
});

test("手机绘画页：素材库按钮不骑在模式条上，chip 排能横滚到「生成」", async () => {
    const m = await measure(paintPage, MOBILE, { touch: true }, () => {
        const modesRow = document.querySelector(".ns-paint-modes");
        const modes = modesRow.getBoundingClientRect();
        const libBtn = document.querySelector(".ns-paint-lib-btn");
        const lib = libBtn.getBoundingClientRect();
        const bar = document.querySelector(".neo-gallery-gm-composer-bar");
        bar.scrollLeft = 9999;   // 滚到末端，「生成」必须整枚落进可视区
        const gen = bar.querySelector(".neo-gallery-gm-gen-btn").getBoundingClientRect();
        return {
            libStatic: getComputedStyle(libBtn).position === "static",
            // 素材库钮与模式钮的矩形相交才算叠在一起；比整行矩形比的是父子，永远为真
            overlap: [...modesRow.querySelectorAll(".ns-paint-mode-btn")].some((el) => {
                const r = el.getBoundingClientRect();
                return lib.left < r.right && lib.right > r.left && lib.top < r.bottom && lib.bottom > r.top;
            }),
            scrollable: getComputedStyle(bar).overflowX === "auto" || getComputedStyle(bar).overflowX === "scroll",
            genRight: Math.round(gen.right), barRight: Math.round(bar.getBoundingClientRect().right),
            inputH: Math.round(document.querySelector(".neo-gallery-gm-quick-input").getBoundingClientRect().height),
        };
    });
    assert.ok(m.libStatic, "素材库按钮还钉在模式条右端（窄屏会叠在模式条上）");
    assert.ok(!m.overlap, "素材库按钮与模式条行重叠");
    assert.ok(m.scrollable, "chip 排没有横向滚动能力，「生成」按钮够不着");
    assert.ok(m.genRight <= m.barRight + 1, `滚到底也看不到「生成」：${m.genRight} > ${m.barRight}`);
    assert.ok(m.inputH >= 88, `输入框只有 ${m.inputH}px`);
});

test("手机导演页：编辑器在上、生成面板在下，两栏贴整幅（压住分隔条写的内联宽度）", async () => {
    const m = await measure(directorPage, MOBILE, { touch: true }, () => {
        const b = (s) => document.querySelector(s).getBoundingClientRect();
        return {
            dir: getComputedStyle(document.querySelector(".ns-director-main")).flexDirection,
            splitShown: getComputedStyle(document.querySelector(".ns-director-split")).display !== "none",
            editorW: Math.round(b(".ns-director-editor").width),
            panelW: Math.round(b(".ns-gen-panel").width),
            mainW: Math.round(b(".ns-director-main").width),
            editorH: Math.round(b(".ns-director-editor").height),
            panelBelow: Math.round(b(".ns-gen-panel").top) >= Math.round(b(".ns-director-editor").bottom),
        };
    });
    assert.equal(m.dir, "column", "导演页主栏还是左右并排");
    assert.ok(!m.splitShown, "拖宽的分隔条在手机上还在（触摸上拖不动）");
    assert.ok(m.editorW === m.mainW && m.panelW === m.mainW, `两栏没贴整幅：编辑器 ${m.editorW} / 面板 ${m.panelW} / 主栏 ${m.mainW}`);
    assert.ok(m.panelBelow, "生成面板没落在编辑器下面");
    assert.ok(m.editorH >= 420, `编辑器只给到 ${m.editorH}px，时间线读不了`);
});


test("手机技能页：技能管理铺满本页，左列表在上成限高区，拖宽分隔条收起", async () => {
    const m = await measure(skillsPage, MOBILE, { touch: true }, () => {
        const b = (s) => document.querySelector(s).getBoundingClientRect();
        return {
            body: getComputedStyle(document.querySelector(".rs-skill-manager-body")).flexDirection,
            splitShown: getComputedStyle(document.querySelector(".rs-skill-manager-split")).display !== "none",
            managerW: Math.round(b(".rs-skill-manager").width),
            pageW: Math.round(b(".ns-page").width),
            leftW: Math.round(b(".rs-skill-manager-left").width),
            leftAbove: Math.round(b(".rs-skill-manager-right").top) >= Math.round(b(".rs-skill-manager-left").bottom),
        };
    });
    assert.equal(m.body, "column", "技能管理左右两栏没堆叠");
    assert.ok(!m.splitShown, "拖宽的分隔条在手机上还在");
    assert.ok(m.managerW === m.pageW, `技能管理没铺满本页：${m.managerW} / ${m.pageW}`);
    assert.ok(m.leftW === m.managerW, `左列表没回到整幅（拖过的内联宽度没压住）：${m.leftW}`);
    assert.ok(m.leftAbove, "详情没落在列表下面");
});

test("手机设置页：tab 移到顶部成一条可横滚的行，启动设置与关于行上下落", async () => {
    const m = await measure(settingsPage, MOBILE, { touch: true }, () => {
        const b = (s) => document.querySelector(s).getBoundingClientRect();
        const tabs = document.querySelector(".ns-settings-tabs");
        const last = [...tabs.querySelectorAll(".ns-settings-tab")].pop();
        last.scrollIntoView({ inline: "center" });
        return {
            dir: getComputedStyle(document.querySelector(".ns-settings")).flexDirection,
            tabDir: getComputedStyle(tabs).flexDirection,
            tabsW: Math.round(tabs.getBoundingClientRect().width),
            tabsH: Math.round(tabs.getBoundingClientRect().height),
            tabVisible: Math.round(last.getBoundingClientRect().right) <= Math.round(tabs.getBoundingClientRect().right) + 1,
            labelAbove: Math.round(b(".ns-launch-input").top) >= Math.round(b(".ns-launch-label").bottom) - 1,
            aboutWrap: Math.round(b(".ns-about-value").top) > Math.round(b(".ns-about-label").bottom) - 1,
            kernelWrap: getComputedStyle(document.querySelector(".ns-kernel")).flexWrap === "wrap",
        };
    });
    assert.equal(m.dir, "column", "设置页两栏没堆叠");
    assert.equal(m.tabDir, "row", "tab 还钉在左侧 150px 竖栏");
    assert.ok(m.tabsW > m.tabsH, `tab 行不是横的一条（${m.tabsW}×${m.tabsH}）`);
    assert.ok(m.tabVisible, "最后一个 tab 滚不进可视区");
    assert.ok(m.labelAbove, "启动设置的 label 还和输入框挤在一行");
    assert.ok(m.aboutWrap, "「关于」的路径值没落到 label 下一行");
    assert.ok(m.kernelWrap, "内核状态条没换行");
});

test("手机视频页：composer 胶囊贴满整幅并让开手势条，成片单列", async () => {
    const m = await measure(videoPage, MOBILE, { touch: true }, () => {
        const dock = document.querySelector(".ns-video-dock").getBoundingClientRect();
        const page = document.querySelector(".ns-video-page").getBoundingClientRect();
        const chips = document.querySelector(".ns-video-chips");
        const chipsCss = getComputedStyle(chips);
        chips.scrollLeft = 9999;   // 滚到末端，「生成」必须整枚落进胶囊可视区
        return {
            dockW: Math.round(dock.width),
            // 胶囊是 absolute 钉在页面上，100% 吃的是页面盒宽（页面 = 视口 - 页内衬）
            pageW: Math.round(page.width),
            dockInViewport: dock.right <= window.innerWidth && dock.bottom <= window.innerHeight,
            dockBottom: Math.round(window.innerHeight - dock.bottom),
            gridCols: getComputedStyle(document.querySelector(".ns-video-stage")).gridTemplateColumns.split(" ").length,
            chipsNowrap: chipsCss.flexWrap === "nowrap",
            chipsScrollable: chipsCss.overflowX === "auto" || chipsCss.overflowX === "scroll",
            genInDock: Math.round(document.querySelector(".ns-video-run").getBoundingClientRect().right)
                <= Math.round(dock.right),
        };
    });
    assert.ok(m.dockW >= m.pageW - 14, `composer 宽 ${m.dockW}px 没贴整幅（页面 ${m.pageW}px）`);
    assert.ok(m.dockInViewport, "composer 胶囊出屏");
    assert.ok(m.dockBottom >= 8, `胶囊贴到屏幕底边（留白 ${m.dockBottom}px）`);
    assert.equal(m.gridCols, 1, "成片卡片还是两列以上");
    assert.ok(m.chipsNowrap && m.chipsScrollable, "视频 composer 的 chip 排不能横滚（换行会把「生成」挤没）");
    assert.ok(m.genInDock, "「生成」按钮落在胶囊可视区外");
});

test("手机素材页：搜索框整行占位；触摸档下六组悬停控件一律常驻", async () => {
    const m = await measure(galleryPage, MOBILE, { touch: true }, () => {
        const bar = document.querySelector(".neo-gallery-topbar").getBoundingClientRect();
        const search = document.querySelector(".neo-gallery-search-container").getBoundingClientRect();
        const opacity = (s) => getComputedStyle(document.querySelector(s)).opacity;
        return {
            searchShare: Math.round((search.width / bar.width) * 100),
            thumbBar: opacity(".neo-gallery-thumb-btn-bar"),
            bookmark: opacity(".neo-gallery-thumb-bookmark-btn"),
            dirActions: opacity(".neo-gallery-dir-item-actions > button"),
            loraSend: opacity(".neo-gallery-card-lora-send-btn"),
            dirMenu: opacity(".neo-gallery-card-dir-menu-btn"),
            civitaiSave: opacity(".neo-gallery-card-civitai-save-btn"),
            inputFont: getComputedStyle(document.querySelector(".neo-gallery-search")).fontSize,
        };
    });
    assert.ok(m.searchShare >= 60, `搜索框只占顶栏 ${m.searchShare}%，一个词都打不全`);
    for (const [k, v] of Object.entries({
        "缩略图操作条": m.thumbBar, "收藏星": m.bookmark, "目录行操作": m.dirActions,
        "LoRA 取用": m.loraSend, "目录菜单": m.dirMenu, "收藏保存": m.civitaiSave,
    })) assert.equal(v, "1", `触摸档下「${k}」仍是隐藏的（opacity ${v}）`);
    assert.equal(m.inputFont, "16px", "搜索框字号 < 16px，iOS 聚焦时把整页放大且不会自己缩回");
});


test("手机弹窗层：素材库弹窗铺满整窗、灯箱侧栏落到画面下方、灯箱圆钮给到 44px", async () => {
    const lib = await measure(libmodalPage, MOBILE, { touch: true }, () => {
        const b = document.querySelector(".ns-libmodal-box").getBoundingClientRect();
        return {
            w: Math.round(b.width), h: Math.round(b.height),
            resizeShown: getComputedStyle(document.querySelector(".ns-libmodal-resize")).display !== "none",
        };
    });
    assert.equal(lib.w, MOBILE.width, `素材库弹窗宽 ${lib.w}px 没铺满`);
    assert.equal(lib.h, MOBILE.height, `素材库弹窗高 ${lib.h}px 没铺满`);
    assert.ok(!lib.resizeShown, "右缘调宽条在触摸设备上还挂着");

    const lb = await measure(lightboxPage, MOBILE, { touch: true }, () => {
        const b = (s) => document.querySelector(s).getBoundingClientRect();
        return {
            panelBelow: Math.round(b(".neo-lightbox-panel").top) >= Math.round(b(".neo-lightbox-main").bottom) - 1,
            panelW: Math.round(b(".neo-lightbox-panel").width),
            boxW: Math.round(b(".neo-lightbox-box").width),
            closeW: Math.round(b(".neo-lightbox-close").width),
        };
    });
    assert.ok(lb.panelBelow, "灯箱侧栏还在画面右侧");
    assert.ok(lb.panelW >= lb.boxW - 2, `灯箱侧栏宽 ${lb.panelW} / 盒宽 ${lb.boxW}`);
    assert.equal(lb.closeW, 44, "灯箱关闭钮没给到 44px 触摸目标");
});

test("手机摆姿页：画布在上，场景库与控制面板各占一截（三栏压不进 390）", async () => {
    const m = await measure(posePage, MOBILE, { touch: true }, () => {
        const b = (s) => document.querySelector(s).getBoundingClientRect();
        return {
            cols: getComputedStyle(document.querySelector(".ns-pose-body")).gridTemplateColumns.split(" ").length,
            stageW: Math.round(b(".ns-pose-stage").width),
            bodyW: Math.round(b(".ns-pose-body").width),
            stageAbove: Math.round(b(".ns-pose-panel").top) >= Math.round(b(".ns-pose-stage").bottom) - 1,
        };
    });
    assert.equal(m.cols, 1, "摆姿页还是多列");
    assert.equal(m.stageW, m.bodyW, `3D 舞台没独占整幅：${m.stageW} / ${m.bodyW}`);
    assert.ok(m.stageAbove, "控制面板没落在画布下面");
});


test("桌面 1440 宽：手机那一档一条都不吃（顶栏一行、两栏并排、悬停控件照旧）", async () => {
    const home = await measure(homePage, DESKTOP, {}, () => {
        const b = (s) => document.querySelector(s).getBoundingClientRect();
        const tabs = document.querySelector(".ns-tabs");
        return {
            headerH: Math.round(b(".ns-header").height),
            tabsScroll: tabs.scrollWidth, tabsClient: tabs.clientWidth,
            statusShown: getComputedStyle(document.querySelector(".ns-comfy-status")).display !== "none",
            gridCols: getComputedStyle(document.querySelector(".ns-home-grid")).gridTemplateColumns.split(" ").length,
            tabH: Math.round(b(".ns-tabs a").height),
            pagePad: getComputedStyle(document.querySelector(".ns-page")).paddingTop,
        };
    });
    assert.equal(home.headerH, 38, `桌面顶栏被移动端块改高了：${home.headerH}px`);
    assert.ok(home.tabsScroll <= home.tabsClient, "桌面页签条被改成了横滚");
    assert.ok(home.statusShown, "桌面顶栏的 ComfyUI 状态位被收掉了");
    assert.ok(home.gridCols >= 2, `桌面首页卡片被压成单列（${home.gridCols} 列）`);
    assert.ok(home.tabH < 44, `桌面页签被撑到 ${home.tabH}px`);
    assert.equal(home.pagePad, "30px", "桌面首页内衬被收成了手机那一档");

    const dir = await measure(directorPage, DESKTOP, {}, () => {
        const b = (s) => document.querySelector(s).getBoundingClientRect();
        return {
            dir: getComputedStyle(document.querySelector(".ns-director-main")).flexDirection,
            splitShown: getComputedStyle(document.querySelector(".ns-director-split")).display !== "none",
            sideBySide: Math.round(b(".ns-gen-panel").left) > Math.round(b(".ns-director-editor").right),
            panelW: Math.round(b(".ns-gen-panel").width),
        };
    });
    assert.equal(dir.dir, "row", "导演页主栏被移动端块改成了上下堆叠");
    assert.ok(dir.splitShown, "导演页的分隔条被收掉");
    assert.ok(dir.sideBySide, "桌面导演页两栏不并排");
    assert.equal(dir.panelW, 470, "生成面板丢了分隔条写的宽度");

    const sk = await measure(skillsPage, DESKTOP, {}, () => ({
        body: getComputedStyle(document.querySelector(".rs-skill-manager-body")).flexDirection,
        splitShown: getComputedStyle(document.querySelector(".rs-skill-manager-split")).display !== "none",
        leftW: Math.round(document.querySelector(".rs-skill-manager-left").getBoundingClientRect().width),
    }));
    assert.equal(sk.body, "row", "桌面技能管理被改成了上下堆叠");
    assert.ok(sk.splitShown, "桌面技能管理的分隔条被收掉");
    assert.equal(sk.leftW, 420, "桌面技能管理左列表被压回整幅（!important 漏进了桌面档）");
});


test("桌面 1440 宽（续）：设置页两栏、素材页悬停控件、灯箱侧栏、摆姿三栏照旧", async () => {
    const set = await measure(settingsPage, DESKTOP, {}, () => ({
        tabDir: getComputedStyle(document.querySelector(".ns-settings-tabs")).flexDirection,
        labelRow: Math.round(document.querySelector(".ns-launch-input").getBoundingClientRect().top)
            < Math.round(document.querySelector(".ns-launch-label").getBoundingClientRect().bottom),
        kernelWrap: getComputedStyle(document.querySelector(".ns-kernel")).flexWrap,
    }));
    assert.equal(set.tabDir, "column", "桌面设置页 tab 被搬到了顶部");
    assert.ok(set.labelRow, "桌面启动设置的 label 与输入框被拆成两行");
    assert.notEqual(set.kernelWrap, "wrap", "桌面内核状态条被改成了换行");

    const gal = await measure(galleryPage, DESKTOP, {}, () => {
        const opacity = (s) => getComputedStyle(document.querySelector(s)).opacity;
        return {
            searchW: Math.round(document.querySelector(".neo-gallery-search-container").getBoundingClientRect().width),
            thumbBar: opacity(".neo-gallery-thumb-btn-bar"),
            loraSend: opacity(".neo-gallery-card-lora-send-btn"),
            dirActions: opacity(".neo-gallery-dir-item-actions > button"),
            inputFont: getComputedStyle(document.querySelector(".neo-gallery-search")).fontSize,
        };
    });
    assert.ok(gal.searchW <= 150, `桌面搜索框被改成整行占位（${gal.searchW}px）`);
    // 宽面板的悬停控件在桌面端本来就半显形（gallery.css 的 --wide 规则，先于本次改动），
    // 触摸档才提到全显形；卡片角与目录行那三组基态是 0
    for (const [k, v] of Object.entries({ "缩略图操作条": gal.thumbBar, "LoRA 取用": gal.loraSend, "目录行操作": gal.dirActions }))
        assert.notEqual(v, "1", `桌面端「${k}」被改成了常驻（opacity ${v}）`);
    assert.notEqual(gal.inputFont, "16px", "桌面输入框字号被抬到 16px");

    const lb = await measure(lightboxPage, DESKTOP, {}, () => {
        const b = (s) => document.querySelector(s).getBoundingClientRect();
        return {
            panelRight: Math.round(b(".neo-lightbox-panel").left) >= Math.round(b(".neo-lightbox-main").right) - 1,
            closeW: Math.round(b(".neo-lightbox-close").width),
        };
    });
    assert.ok(lb.panelRight, "桌面灯箱侧栏被搬到了画面下方");
    assert.equal(lb.closeW, 34, "桌面灯箱圆钮被撑到 44px");

    const pose = await measure(posePage, DESKTOP, {}, () => ({
        cols: getComputedStyle(document.querySelector(".ns-pose-body")).gridTemplateColumns.split(" ").length,
    }));
    assert.ok(pose.cols >= 3, `桌面摆姿页被压成 ${pose.cols} 列`);
});

