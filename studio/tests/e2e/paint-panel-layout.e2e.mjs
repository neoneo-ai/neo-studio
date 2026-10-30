// E2E：绘画页文生图面板与 chip 浮层的布局不变量（纯前端：注入 web/*.css 与真实同构 DOM，不需要 ComfyUI 在跑）。
// 三处易碎布局：结果区与输入卡之间的余隙归位、空档不足时内容从顶部铺开、浮层里的 LoRA 下拉宽度。
// 用法：npm run e2e
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const css = (f) => fs.readFileSync(path.join(webDir, f), "utf8");

const svg600 = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="100%" height="100%" fill="#777"/></svg>')}`;
const IDLE = `<div class="neo-gallery-gm-idle"><div class="neo-gallery-gm-idle-title">写一句话，回车即开</div><div class="neo-gallery-gm-idle-sub">模型 Qwen Image 2509 · 1024 · LoRA 0</div></div>`;
const RUNNING = `<div class="neo-gallery-gm-preview"><img src="${svg600}" alt="生成中"></div>`;
const RESULT = `<div class="neo-gallery-cs-result"><div class="neo-gallery-story-hint">生成完成，用时 12 秒</div></div>`;

// 与绘画页文生图面板同构：.ns-paint-panel.ns-paint-text 里一层内嵌弹窗（标题栏、结果区、输入卡、操作区）
const paintPanel = (statusInner) => `
    <div class="ns-paint">
      <div class="ns-paint-main">
        <div class="ns-paint-panel ns-paint-text neo-gallery-panel--wide">
          <div class="neo-gallery-gen-panel">
            <div class="neo-gallery-story-modal neo-gallery-story-modal--embedded">
              <div class="neo-gallery-story-titlebar"><span class="neo-gallery-story-title">文生图</span></div>
              <div class="neo-gallery-cs-status">${statusInner}</div>
              <div class="neo-gallery-gm-composer">
                <textarea class="neo-gallery-gm-quick-input" rows="4"></textarea>
                <div class="neo-gallery-gm-composer-bar neo-gallery-gm-chips">
                  ${chipWrap("e2e-skill-chip", "Qwen Image 2.1", chipPanel())}
                  <div class="neo-gallery-gm-composer-gap"></div>
                  <button class="neo-gallery-story-btn neo-gallery-story-btn-primary neo-gallery-gm-gen-btn">生成</button>
                </div>
              </div>
              <div class="neo-gallery-story-actions"><button class="neo-gallery-story-btn">存为配方</button></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

// 与 gallery-gen.js 的 skillParamsChip 浮层同构：chip 按钮 + 朝上开的双栏面板 + 藏在壳里的状态 select
const chipWrap = (id, label, panel) => `
    <span class="neo-gallery-gm-chip-wrap">
      <button id="${id}" class="neo-gallery-gm-chip-btn"><span class="neo-gallery-gm-chip-label">${label}</span><span class="neo-gallery-gm-chip-caret">▾</span></button>
      ${panel}
      <select class="neo-recipes-sort neo-gallery-gm-chip-select" hidden></select>
    </span>`;

const combo = (value) => `<div class="rs-model-select-box"><div style="position:relative">
      <input class="rs-form-input rs-combo-input" type="text" value="${value}">
      <span class="rs-combo-caret" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:14px;line-height:1;color:#888;pointer-events:none;z-index:1">▾</span>
    </div></div>`;

const loraRow = () => `
    <div class="rs-config-row">
      <label class="rs-form-label">LoRA</label>
      <div class="rs-gen-lora-list">
        <div class="rs-gen-lora-row">
          ${combo("Qwen-Image-Layer/Control/2509-LayerHug__DiffCtrl_20260901.safetensors")}
          <input class="rs-gen-lora-strength" type="number" min="-10" max="10" step="0.05" value="1">
          <button class="rs-gen-lora-del" type="button">✕</button>
        </div>
      </div>
      <button class="rs-btn rs-gen-lora-add" type="button">+ 添加 LoRA</button>
    </div>`;

const chipPanel = () => `
    <div id="e2e-chip-panel" class="rs-runtime-menu neo-gallery-gm-chip-menu neo-gallery-gm-chip-panel neo-gallery-gm-skills-panel" style="display:none">
      <div class="neo-gallery-gm-skills-col">
        <div class="neo-gallery-gm-menu-head">技能</div>
        <button class="neo-gallery-gm-menu-item neo-gallery-gm-skill-item"><span class="neo-gallery-gm-skill-name">Hug 控制</span><span class="neo-gallery-gm-skill-sub">Qwen Image 2.1</span></button>
      </div>
      <div class="neo-gallery-gm-params-col">
        <div class="neo-gallery-gm-model-box">
          <div class="rs-gen-model-section">
            <div class="rs-config-row">
              <label class="rs-form-label">生图模型</label>
              ${combo("qwen-image-2509")}
            </div>
            ${loraRow()}
          </div>
        </div>
      </div>
      <div class="neo-gallery-gm-panel-foot"><button class="rs-btn neo-gallery-gm-panel-done">完成</button></div>
    </div>`;

const embeddedHtml = (body) => `<!doctype html><html><head>
<meta charset="utf-8"><style>html,body{margin:0;background:#14161a;color:#cfd6e0;font:13px sans-serif}*{box-sizing:border-box}</style>
<style>${css("studio/style.css")}</style><style>${css("gallery.css")}</style><style>${css("prompts.css")}</style>
</head><body><div class="ns-view">${body}</div></body></html>`;

let browser;

test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser.close(); });

// 开浮层量一圈宽度：栏宽、LoRA 下拉、强度与 ✕ 的行内落位
const openChip = () => {
    const panel = document.querySelector("#e2e-chip-panel");
    panel.style.display = "grid";   // 与 gallery-gen.js 开面板时写死的值一致（双栏不吃样式表顺序）
    const box = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), right: Math.round(b.right) }; };
    const row = panel.querySelector(".rs-gen-lora-row");
    const combo = row.querySelector(".rs-model-select-box");
    const strength = row.querySelector(".rs-gen-lora-strength");
    const del = row.querySelector(".rs-gen-lora-del");
    const out = {
        lora: box(combo), strength: box(strength), del: box(del),
        rowBottom: Math.round(row.getBoundingClientRect().bottom),
        rowW: Math.round(row.getBoundingClientRect().width),
        strengthBottom: Math.round(strength.getBoundingClientRect().bottom),
        delBottom: Math.round(del.getBoundingClientRect().bottom),
    };
    panel.style.display = "none";
    return out;
};

for (const [name, inner] of [["running", RUNNING], ["result", RESULT]]) {
    test(`文生图 ${name} 态：内容贴着输入卡往上长，中间不留大片空白`, async () => {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await page.setContent(embeddedHtml(paintPanel(inner)), { waitUntil: "load" });
        await page.waitForTimeout(150);
        const g = await page.evaluate(() => {
            const b = (s) => document.querySelector(s).getBoundingClientRect();
            const cs = (s) => getComputedStyle(document.querySelector(s));
            const status = b(".neo-gallery-cs-status");
            const innerBox = b(".neo-gallery-cs-status > :first-child");
            const view = document.querySelector(".ns-view");
            return {
                statusTop: Math.round(status.top), statusBottom: Math.round(status.bottom),
                gap: Math.round(b(".neo-gallery-gm-composer").top - innerBox.bottom),
                composerBottom: Math.round(b(".neo-gallery-gm-composer").bottom),
                panelBottom: Math.round(b(".ns-paint-panel").bottom),
                composerMargin: cs(".neo-gallery-gm-composer").marginTop,
                viewScroll: view.scrollHeight - view.clientHeight,
            };
        });
        await page.close();
        assert.ok(g.statusBottom - g.statusTop > 60, `结果区吃到输入卡上方的余隙：${g.statusTop} → ${g.statusBottom}`);
        assert.ok(g.gap <= 12, `${name} 内容贴住输入卡，中间不留空白（留白 ${g.gap}px）`);
        assert.ok(g.composerBottom <= g.panelBottom && g.panelBottom - g.composerBottom <= 52,
            `输入卡收在面板底边（差 ${g.panelBottom - g.composerBottom}px，只剩面板内边距与隐藏的贴底操作区）`);
        assert.equal(g.composerMargin, "0px", "输入卡的 margin-top 归零，余隙交给结果区");
        assert.ok(g.viewScroll <= 2, `整页不溢出（溢出 ${g.viewScroll}px）`);
    });
}

// 余隙归位后的边界：起手提示居中、矮窗口照旧贴底、空档不够时内容从顶部铺开
// （首 child 的 margin-top:auto 只在有空间时吸余隙，挤不下时自动归零，上方内容不会滚成死角）
test("文生图空档归位：起手提示居中、矮窗口贴底、空档不足时内容从顶部铺开", async () => {
    const read = async (viewport, inner) => {
        const page = await browser.newPage({ viewport });
        await page.setContent(embeddedHtml(paintPanel(inner)), { waitUntil: "load" });
        await page.waitForTimeout(150);
        const out = await page.evaluate(() => {
            const b = (s) => document.querySelector(s).getBoundingClientRect();
            const status = b(".neo-gallery-cs-status");
            const idle = document.querySelector(".neo-gallery-gm-idle");
            const idleBox = idle ? idle.getBoundingClientRect() : null;
            const view = document.querySelector(".ns-view");
            return {
                statusTop: Math.round(status.top), statusBottom: Math.round(status.bottom),
                idleTop: idleBox ? Math.round(idleBox.top) : null,
                idleBottom: idleBox ? Math.round(idleBox.bottom) : null,
                innerTop: Math.round(b(".neo-gallery-cs-status > :first-child").top),
                composerBottom: Math.round(b(".neo-gallery-gm-composer").bottom),
                panelBottom: Math.round(b(".ns-paint-panel").bottom),
                viewScroll: view.scrollHeight - view.clientHeight,
            };
        });
        await page.close();
        return out;
    };
    const idle = await read({ width: 1440, height: 900 }, IDLE);
    assert.ok(idle.idleTop !== null
        && Math.abs((idle.idleTop - idle.statusTop) - (idle.statusBottom - idle.idleBottom)) <= 2,
        `起手提示落在那片余隙正中（上留 ${idle.idleTop - idle.statusTop} 下留 ${idle.statusBottom - idle.idleBottom}）`);
    const short = await read({ width: 1440, height: 560 }, IDLE);
    assert.ok(short.composerBottom <= short.panelBottom && short.panelBottom - short.composerBottom <= 52,
        `560px 高的窗口里输入卡照旧收在面板底边（差 ${short.panelBottom - short.composerBottom}px）`);
    const tiny = await read({ width: 1440, height: 460 }, IDLE);
    assert.ok(tiny.innerTop >= tiny.statusTop - 1,
        `空档不够时内容从容器顶部铺开（内容顶 ${tiny.innerTop} / 结果区顶 ${tiny.statusTop}）`);
    assert.ok(tiny.viewScroll <= 2, `460px 高的窗口不溢出（溢出 ${tiny.viewScroll}px）`);
});

// 浮层里的 LoRA 下拉：三种宿主宽度（宽素材页 / 窄侧栏标签页 / 窄窗口）都要拿到列的余宽，
// 长模型名不截断，强度与 ✕ 留在同一行
for (const [name, [width, height]] of [["素材页", [1440, 900]], ["侧栏", [420, 760]], ["窄窗", [640, 800]]]) {
    test(`chip 浮层的 LoRA 下拉随栏宽铺开（${name} ${width}x${height}）`, async () => {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.setContent(embeddedHtml(paintPanel(IDLE)), { waitUntil: "load" });
        await page.waitForTimeout(150);
        const r = await page.evaluate(openChip);
        await page.close();
        assert.ok(r.lora.w >= 200 && r.lora.w >= 0.6 * r.rowW,
            `${name}：LoRA 下拉拿到列的余宽（${r.lora.w}px / 行宽 ${r.rowW}px），旧的 320px 列宽上限读不全长模型名`);
        assert.ok(r.strengthBottom <= r.rowBottom + 1 && r.delBottom <= r.rowBottom + 1,
            `${name}：强度与 ✕ 落在同一行内（行底 ${r.rowBottom} / 强度底 ${r.strengthBottom} / ✕ 底 ${r.delBottom}）`);
    });
}

