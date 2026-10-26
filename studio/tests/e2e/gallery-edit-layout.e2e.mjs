// E2E：图片编辑窗对比区布局——原图必须完整落在舞台内（既不被裁掉也不被撑爆），
// 且结果图层 / 分割线必须与原图盒重合（窗帘对比才能逐像素对齐）。
// 纯前端布局：直接注入 web/gallery.css 与真实 DOM 结构，不需要 ComfyUI 在跑。
// 用法：npm run e2e
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const css = fs.readFileSync(path.join(webDir, "gallery.css"), "utf8");

const svg = (w, h) => `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#777"/></svg>`)}`;

// 结果层：扩图时结果比原图宽（补边画布），用来验证它是否被铺满画布而不是缩进原图盒
const resultLayer = (w, h) =>
    `<div class="neo-gallery-edit-result-clip"><img class="neo-gallery-edit-compare-img neo-gallery-edit-result-img" src="${svg(w, h)}" alt="编辑结果"></div>`;

// 与 gallery-gen.js 的 openImageEditDialog 同构（图片在上、操作在下）
// 非扩图：结果层/分割线挂在图片盒内；扩图：三者都进画布（结果的坐标随画布一起缩放）
const body = (w, h, outpaint) => `
<div class="neo-gallery-story-modal-overlay neo-gallery-edit-modal-overlay">
  <div class="neo-gallery-story-modal neo-gallery-edit-modal">
    <div class="neo-gallery-story-titlebar"><span class="neo-gallery-story-title">图片编辑</span><span class="neo-gallery-story-close">×</span></div>
    <div class="neo-gallery-edit-compare">
      <div>
        <div class="neo-gallery-edit-compare-label">原图 / 编辑结果（拖拽分割线对比）</div>
        <div class="neo-gallery-edit-compare-stage">
          <div class="neo-gallery-edit-compare-imgwrap${outpaint ? " neo-gallery-edit-outpaint" : ""}">
            ${outpaint
                ? `<div class="neo-gallery-edit-outpaint-canvas" style="width:${w}px;height:${h}px;transform:scale(0.3)"><img class="neo-gallery-edit-compare-img" src="${svg(w, h)}" alt="原图">${resultLayer(w * 2, h)}<div class="neo-gallery-edit-outpaint-box"></div><div class="neo-gallery-edit-divider"></div></div>`
                : `<img class="neo-gallery-edit-compare-img" src="${svg(w, h)}" alt="原图">${resultLayer(w, h)}<div class="neo-gallery-edit-divider"></div>`}
          </div>
        </div>
      </div>
    </div>
    <div class="neo-gallery-edit-form">
      <div class="neo-gallery-edit-form-top-row">
        <div class="neo-gallery-story-form-row"><label class="neo-director-field-label">编辑技能</label><select><option>Qwen Image 2.1</option></select></div>
        <div class="neo-gallery-story-form-row"><label class="neo-director-field-label">目标分辨率</label><input type="number" id="img-edit-width" value="${w}"><span> × </span><input type="number" id="img-edit-height" value="${h}"></div>
      </div>
      <textarea class="neo-gallery-story-input" rows="4"></textarea>
      <div class="neo-gallery-cs-status"><div class="neo-gallery-story-hint">填写编辑指令后点「生成」。</div></div>
      <div class="neo-gallery-story-actions"><button class="neo-gallery-story-btn">取消</button><button class="neo-gallery-story-btn">生成</button></div>
    </div>
  </div>
</div>`;

const html = (w, h, outpaint) =>
    `<!doctype html><html><head><style>${css}</style></head><body>${body(w, h, outpaint)}</body></html>`;

const measure = () => {
    const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    return {
        stage: box(".neo-gallery-edit-compare-stage"),
        compare: box(".neo-gallery-edit-compare"),
        prompt: box(".neo-gallery-story-input"),
        status: box(".neo-gallery-cs-status"),
        actions: box(".neo-gallery-story-actions"),
        wrap: box(".neo-gallery-edit-compare-imgwrap"),
        img: box(".neo-gallery-edit-compare-img"),
        clip: box(".neo-gallery-edit-result-clip"),
        clipImg: box(".neo-gallery-edit-result-clip img"),
        canvas: box(".neo-gallery-edit-outpaint-canvas"),
        clipPath: getComputedStyle(document.querySelector(".neo-gallery-edit-result-clip")).clipPath,
    };
};

// 模拟 gallery-gen.js 的窗帘：取 50% 中间态，方便一次检查左右两侧各露出哪张图
const revealHalf = () => {
    const clip = document.querySelector(".neo-gallery-edit-result-clip");
    const divider = document.querySelector(".neo-gallery-edit-divider");
    clip.style.display = "";
    divider.style.display = "";
    clip.style.clipPath = "inset(0 0 0 50%)";
    divider.style.left = "50%";
    const b = clip.querySelector("img").getBoundingClientRect();
    // 临时打开命中测试：clip-path 之外不接收点击，可据此判定左右两侧各露出哪张图
    clip.style.pointerEvents = "auto";
    const hit = (fx) => document.elementFromPoint(b.left + b.width * fx, b.top + b.height / 2)?.className || "";
    const leftShown = hit(0.25);
    const rightShown = hit(0.75);
    clip.style.pointerEvents = "";
    return {
        clipBox: { w: Math.round(b.width), h: Math.round(b.height) },
        computed: getComputedStyle(clip).clipPath,
        leftShown,
        rightShown,
    };
};

const sameBox = (a, b) => a && b && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;
const within = (inner, outer) => inner && outer &&
    inner.x >= outer.x - 1 && inner.y >= outer.y - 1 &&
    inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1;

let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { if (browser) await browser.close(); });

// 竖图（会被 50vh 限高）、横图、超宽图、小图
for (const [w, h] of [[848, 1280], [1280, 848], [4000, 1000], [300, 200]]) {
    test(`图片编辑对比区：${w}×${h} 原图完整显示在舞台内，结果层/分割线与原图对齐`, { timeout: 60000 }, async () => {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        await page.setContent(html(w, h, false));
        await page.waitForTimeout(80);
        const m = await page.evaluate(measure);
        const reveal = await page.evaluate(revealHalf);
        await page.close();

        assert.ok(within(m.img, m.wrap), `原图应落在图片盒内：img=${JSON.stringify(m.img)} wrap=${JSON.stringify(m.wrap)}`);
        assert.ok(within(m.wrap, m.stage), `图片盒应落在舞台内：wrap=${JSON.stringify(m.wrap)} stage=${JSON.stringify(m.stage)}`);
        assert.ok(sameBox(m.wrap, m.img), `图片盒应与原图盒同尺寸：wrap=${JSON.stringify(m.wrap)} img=${JSON.stringify(m.img)}`);
        assert.ok(m.img.h <= 541 && m.img.w <= 1601, `原图不应被撑爆（≤50vh×舞台宽）：${JSON.stringify(m.img)}`);
        assert.ok(sameBox(m.clip, m.img), "结果裁剪层应覆盖原图盒（窗帘对比逐像素对齐）");
        assert.ok(sameBox(m.clipImg, m.img), "结果图应与原图同盒显示（object-fit:contain 留黑一致）");
        // 图片在上、操作在下：对比区必须在指令输入框/状态/按钮之上
        assert.ok(m.compare.y + m.compare.h <= m.prompt.y + 1, `对比区应在指令输入框上方：compare=${JSON.stringify(m.compare)} prompt=${JSON.stringify(m.prompt)}`);
        assert.ok(m.status.y + m.status.h <= m.actions.y + 1, `按钮应在状态文字下方：status=${JSON.stringify(m.status)} actions=${JSON.stringify(m.actions)}`);

        // 窗帘：分割线在 50% 时，结果图层仍是整幅原图盒（只被裁切，不缩放/不位移）
        assert.equal(reveal.computed, "inset(0px 0px 0px 50%)", "窗帘应由 clip-path 裁掉左侧 50%");
        assert.equal(reveal.clipBox.w, m.img.w, "结果图宽度必须是整幅图片盒宽（不能被裁成 50% 而变形）");
        assert.equal(reveal.clipBox.h, m.img.h, "结果图高度必须是整幅图片盒高");
        assert.ok(!reveal.leftShown.includes("neo-gallery-edit-result-img"), `分割线左侧应露出原图，实为 ${reveal.leftShown}`);
        assert.ok(reveal.rightShown.includes("neo-gallery-edit-result-img"), `分割线右侧应露出结果图，实为 ${reveal.rightShown}`);
    });
}

test("图片编辑对比区：分割线默认贴左边界（整幅结果图），手柄仍可抓取", { timeout: 60000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(html(848, 1280, false));
    await page.waitForTimeout(80);
    const m = await page.evaluate(() => {
        const clip = document.querySelector(".neo-gallery-edit-result-clip");
        const divider = document.querySelector(".neo-gallery-edit-divider");
        clip.style.display = "";
        divider.style.display = "";
        // 与 gallery-gen.js showResultOverlay 的默认位置一致：贴左边界
        clip.style.clipPath = "inset(0 0 0 0%)";
        divider.style.left = "0%";
        const d = divider.getBoundingClientRect();
        const modal = document.querySelector(".neo-gallery-edit-modal").getBoundingClientRect();
        const hit = document.elementFromPoint(d.left + d.width / 2, d.top + d.height / 2)?.className || "";
        return {
            divider: { x: Math.round(d.x), y: Math.round(d.y), h: Math.round(d.height) },
            modal: { x: Math.round(modal.x), y: Math.round(modal.y), h: Math.round(modal.height) },
            clipPath: getComputedStyle(clip).clipPath,
            hit,
        };
    });
    await page.close();

    assert.equal(m.clipPath, "inset(0px 0px 0px 0%)", "默认不裁切：整幅显示结果图");
    assert.ok(m.divider.y >= m.modal.y && m.divider.y + m.divider.h <= m.modal.y + m.modal.h,
        `分割线应落在弹窗纵向范围内：divider=${JSON.stringify(m.divider)} modal=${JSON.stringify(m.modal)}`);
    assert.ok(m.divider.x >= m.modal.x - 1,
        `贴左边界时不应越出弹窗左侧：divider=${JSON.stringify(m.divider)} modal=${JSON.stringify(m.modal)}`);
    assert.ok(m.hit.includes("neo-gallery-edit-divider"), `分割线应能抓取（命中自身），实为 ${m.hit}`);
});

test("图片编辑对比区：开扩图后图片盒仍是满宽 50vh 舞台（拖框/原图归位按舞台盒量尺寸）", { timeout: 60000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(html(848, 1280, true));
    await page.waitForTimeout(80);
    const m = await page.evaluate(measure);
    const reveal = await page.evaluate(revealHalf);
    const fit = await page.evaluate(() =>
        getComputedStyle(document.querySelector(".neo-gallery-edit-result-clip img")).objectFit);
    await page.close();

    assert.equal(m.wrap.h, 540, "扩图图片盒高应为 50vh");
    assert.equal(m.wrap.w, m.stage.w, "扩图图片盒应满宽（与舞台同宽）");
    assert.ok(m.canvas, "扩图应出现画布");
    // 结果层在画布内铺满画布：结果就是整幅补边画布，这样才能和画布里的原图区域逐像素对齐
    assert.equal(fit, "fill", "扩图结果图应铺满画布（object-fit:fill），不能 contain 缩到原图尺寸");
    assert.ok(sameBox(m.clip, m.canvas), `扩图结果层应与画布同盒：clip=${JSON.stringify(m.clip)} canvas=${JSON.stringify(m.canvas)}`);
    assert.ok(sameBox(m.clipImg, m.canvas), `扩图结果图（200% 宽）应被拉到画布尺寸：img=${JSON.stringify(m.clipImg)}`);
    assert.equal(reveal.clipBox.w, m.canvas.w, "窗帘裁切宽度必须是整幅画布宽");
    assert.equal(reveal.clipBox.h, m.canvas.h);
});
