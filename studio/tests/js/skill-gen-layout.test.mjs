// Playwright 渲染验证：在真实浏览器里确认技能详情弹窗的出图设置布局。
// postcss（css-integrity.test.mjs）只查 CSS 结构是否合法；这里补上"规则是否真的按预期渲染"：
//   model / LoRA / 尺寸区(张数·长边·比例) / 折叠区(Text Encoder·VAE·输出前缀) → 标签左 | 控件右（两栏 grid）
//   LoRA 行                              → 标签 | 动态列表 | 「+ 添加」（三栏 grid）
//   出图张数 / 长边尺寸 / 默认比例 / 输出前缀 → 标签左 | 控件右（两栏 grid）
// DOM 结构按 skill.js / image-gen.js 生成的 class 复刻，CSS 用真实的 web/prompts.css。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const css = fs.readFileSync(path.join(webDir, "prompts.css"), "utf8");

// 复刻 .rs-skill-gen-settings（skill.js genSettingsWrap）内部结构；class 与源码一致
const harnessDom = `
<div class="rs-skill-modal-overlay" style="display:block; position:static;">
  <div class="rs-skill-modal rs-skill-detail" style="width:640px;">
    <div class="rs-skill-modal-content">
      <div class="rs-gen-settings rs-skill-gen-settings">
        <div class="rs-config-row rs-gen-settings-header"><label class="rs-form-label">出图设置（优先于默认设置）</label></div>
        <div class="rs-gen-model-section">
          <div class="rs-config-row"><label class="rs-form-label">Model</label><select></select></div>
          <div class="rs-config-row"><label class="rs-form-label">LoRA</label><div class="rs-gen-lora-list"></div><button type="button" class="rs-gen-lora-add">+ 添加 LoRA</button></div>
        </div>
        <div class="rs-gen-size-section">
          <div class="rs-config-row"><label class="rs-form-label">长边尺寸</label><select></select></div>
          <div class="rs-config-row"><label class="rs-form-label">默认比例</label><select></select></div>
        </div>
        <div class="rs-gen-advanced">
          <input type="checkbox" class="rs-gen-adv-check" aria-label="Text Encoder / VAE / 出图张数 / 输出前缀（高级）">
          <span class="rs-gen-adv-label">Text Encoder / VAE / 出图张数 / 输出前缀（高级）</span>
          <div class="rs-gen-adv-content">
            <div class="rs-config-row rs-gen-adv-row"><label class="rs-form-label">Text Encoder</label><select></select></div>
            <div class="rs-config-row rs-gen-adv-row"><label class="rs-form-label">VAE</label><select></select></div>
            <div class="rs-config-row rs-gen-adv-row"><label class="rs-form-label">出图张数</label><input class="rs-form-input" type="number"></div>
            <div class="rs-config-row rs-gen-adv-row"><label class="rs-form-label">输出前缀</label><input class="rs-form-input" type="text"></div>
          </div>
        </div>
      </div>
      <!-- 视频设置区容器没有 rs-skill-gen-settings class，模型行与高级组行为都必须一致 -->
      <div class="rs-gen-settings rs-skill-video-gen-settings">
        <div class="rs-gen-model-section">
          <div class="rs-config-row"><label class="rs-form-label">生视频模型</label><select></select></div>
          <div class="rs-config-row"><label class="rs-form-label">步数</label><input type="number"></div>
          <div class="rs-config-row"><label class="rs-form-label">LoRA</label><div class="rs-gen-lora-list"></div><button type="button" class="rs-gen-lora-add">+ 添加 LoRA</button></div>
        </div>
        <div class="rs-gen-advanced">
          <input type="checkbox" class="rs-gen-adv-check" aria-label="Text Encoder / VAE（视频）/ VAE（音频）（高级）">
          <span class="rs-gen-adv-label">Text Encoder / VAE（视频）/ VAE（音频）（高级）</span>
          <div class="rs-gen-adv-content">
            <div class="rs-config-row rs-gen-adv-row"><label class="rs-form-label">VAE（视频）</label><select></select></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>`;

test("技能弹窗出图设置：各配置行标签左|控件右（模型/LoRA/折叠区/尺寸）", async (t) => {
    let browser;
    try {
        browser = await chromium.launch();
    } catch (e) {
        t.skip("chromium 未安装：先运行 npx playwright install chromium");
        return;
    }
    try {
        const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
        await page.setContent(
            `<html><head><meta charset="utf-8"><style>${css}</style></head><body>${harnessDom}</body></html>`,
            { waitUntil: "load" },
        );

        // 默认收起；点标题文字不展开（防误点），勾选开头复选框才展开
        const advCheck = page.locator(".rs-skill-gen-settings .rs-gen-adv-check");
        const advContent = page.locator(".rs-skill-gen-settings .rs-gen-adv-content");
        assert.equal(await advCheck.isChecked(), false, "复选框应默认未勾选");
        assert.equal(await advContent.evaluate((c) => getComputedStyle(c).display), "none", "折叠区应默认收起");
        await page.locator(".rs-skill-gen-settings .rs-gen-adv-label").click({ position: { x: 60, y: 8 } });
        assert.equal(await advCheck.isChecked(), false, "点标题文字不应展开");
        assert.equal(await advContent.evaluate((c) => getComputedStyle(c).display), "none", "点标题文字后仍应收起");
        await advCheck.check();
        assert.equal(await advContent.evaluate((c) => getComputedStyle(c).display), "flex", "勾选复选框应展开");

        // 视频设置区容器（无 rs-skill-gen-settings class）的高级组行为必须一致
        const vCheck = page.locator(".rs-skill-video-gen-settings .rs-gen-adv-check");
        const vContent = page.locator(".rs-skill-video-gen-settings .rs-gen-adv-content");
        assert.equal(await vContent.evaluate((c) => getComputedStyle(c).display), "none", "视频高级组应默认收起");
        await vCheck.check();
        assert.equal(await vContent.evaluate((c) => getComputedStyle(c).display), "flex", "勾选视频高级组复选框应展开");

        // 展开后再量列数（隐藏时 grid 轨道不解析为 used 值，minmax() 序列化带空格会干扰计数）
        const r = await page.evaluate(() => {
            const colsOf = (sel) => {
                const el = document.querySelector(sel);
                if (!el) return -1;
                const s = getComputedStyle(el);
                return s.display === "grid" ? s.gridTemplateColumns.split(" ").filter(Boolean).length : -1;
            };
            const label = document.querySelector(".rs-gen-advanced .rs-gen-adv-label");
            const advBox = document.querySelector(".rs-gen-advanced");
            return {
                model: colsOf(".rs-skill-gen-settings .rs-gen-model-section > .rs-config-row"),
                adv: colsOf(".rs-skill-gen-settings .rs-gen-adv-row"),
                lora: colsOf(".rs-skill-gen-settings .rs-gen-model-section > .rs-config-row:last-child"),
                size: colsOf(".rs-skill-gen-settings .rs-gen-size-section > .rs-config-row"),
                vModel: colsOf(".rs-skill-video-gen-settings .rs-gen-model-section > .rs-config-row"),
                vLora: colsOf(".rs-skill-video-gen-settings .rs-gen-model-section > .rs-config-row:last-child"),
                labelNarrow: !!(label && advBox &&
                    label.getBoundingClientRect().width < advBox.getBoundingClientRect().width - 1),
            };
        });

        assert.equal(r.model, 2, `Model 行应为两栏（label | 控件），实际 ${r.model}`);
        assert.equal(r.adv, 2, `折叠区内 Text Encoder/VAE 行应为两栏，实际 ${r.adv}`);
        assert.equal(r.lora, 3, `LoRA 行应为三栏（label | 列表 | 添加按钮），实际 ${r.lora}`);
        assert.equal(r.size, 2, `尺寸区各行（张数/长边/比例）应为两栏，实际 ${r.size}`);
        assert.equal(r.vModel, 2, `视频模型/步数行应为两栏（label | 控件），实际 ${r.vModel}`);
        assert.equal(r.vLora, 3, `视频 LoRA 行应为三栏（label | 列表 | 添加按钮），实际 ${r.vLora}`);
        assert.ok(r.labelNarrow, "折叠标题应只占文字宽度（仅勾选复选框展开），不应铺满整行");
    } finally {
        if (browser) await browser.close();
    }
});

// 标题栏 ? 徽标：基础 .rs-btn 在标题栏里有 padding 4px 10px、在 .rs-skill-detail 里 font-size 12px，
// 徽标选择器必须压过这两条，否则 22px 圆框里只剩 2px 内容宽，? 被挤到圆的右侧、看起来偏离。
const headerDom = `
<div class="rs-skill-modal rs-skill-detail" style="width:640px">
  <div class="rs-skill-modal-header">
    <span class="rs-skill-modal-title">技能</span>
    <div class="rs-skill-name-wrap"><span class="rs-skill-name-view">技能名</span></div>
    <span class="rs-source-badge rs-skill-detail-badge">SYS</span>
    <button type="button" class="rs-btn rs-btn-local rs-skill-doc-btn">?</button>
    <button type="button" class="rs-btn rs-btn-local">⧉ 复制为自定义</button>
    <button class="rs-skill-modal-close">✕</button>
  </div>
</div>`;

test("技能弹窗标题栏：? 徽标居圆框正中、与相邻按钮同一中线", async (t) => {
    let browser;
    try {
        browser = await chromium.launch();
    } catch (e) {
        t.skip("chromium 未安装：先运行 npx playwright install chromium");
        return;
    }
    try {
        const page = await browser.newPage({ viewport: { width: 900, height: 300 } });
        await page.setContent(
            `<html><head><meta charset="utf-8"><style>${css}</style></head><body>${headerDom}</body></html>`,
            { waitUntil: "load" },
        );
        const m = await page.evaluate(() => {
            const el = document.querySelector(".rs-skill-doc-btn");
            const cs = getComputedStyle(el);
            const center = (b) => ({ cx: b.x + b.width / 2, cy: b.y + b.height / 2, w: b.width, h: b.height });
            const rng = document.createRange();
            rng.selectNodeContents(el);
            return {
                badge: center(el.getBoundingClientRect()),
                glyph: center(rng.getBoundingClientRect()),
                copy: center(document.querySelector(".rs-btn-local:not(.rs-skill-doc-btn)").getBoundingClientRect()),
                pad: cs.padding,
                fs: cs.fontSize,
                grow: cs.flexGrow,
                ai: cs.alignItems,
                jc: cs.justifyContent,
                br: cs.borderRadius,
            };
        });
        assert.equal(m.pad, "0px", `徽标 padding 应被压过标题栏 .rs-btn 的 4px 10px，实际 ${m.pad}`);
        assert.equal(m.fs, "13px", `徽标字号应压过 .rs-skill-detail .rs-btn 的 12px，实际 ${m.fs}`);
        assert.equal(m.grow, "0", "徽标不应被 flex:1 拉伸");
        assert.equal(m.ai, "center", "徽标内容应水平居中");
        assert.equal(m.jc, "center", "徽标内容应垂直居中");
        assert.equal(m.br, "50%", "徽标应为圆框");
        assert.ok(Math.abs(m.glyph.cx - m.badge.cx) <= 1.5, `? 应落在圆框水平正中，偏差 ${(m.glyph.cx - m.badge.cx).toFixed(1)}px`);
        assert.ok(Math.abs(m.glyph.cy - m.badge.cy) <= 1.5, `? 应落在圆框垂直正中，偏差 ${(m.glyph.cy - m.badge.cy).toFixed(1)}px`);
        assert.ok(Math.abs(m.badge.cy - m.copy.cy) <= 1, `徽标应与「⧉ 复制为自定义」同一中线，偏差 ${(m.badge.cy - m.copy.cy).toFixed(1)}px`);
    } finally {
        if (browser) await browser.close();
    }
});
