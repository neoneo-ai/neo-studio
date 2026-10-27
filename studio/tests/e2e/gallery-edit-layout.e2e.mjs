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
/** 技能与自定参数面板左栏的一行：技能名 + 它钉的主模型短名（与 skillParamsChip 的 renderSkills 同构） */
const pickItem = (name, main, on = false) =>
    `<button class="neo-gallery-gm-menu-item neo-gallery-gm-skill-item${on ? " neo-gallery-gm-menu-on" : ""}">`
    + `<span class="neo-gallery-gm-skill-name">${name}</span>`
    + (main ? `<span class="neo-gallery-gm-skill-sub">${main}</span>` : "") + `</button>`;

const modalInner = (w, h, outpaint) => `
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
      <div class="neo-gallery-cs-status"><div class="neo-gallery-story-hint">填写编辑指令后点「生成」。</div></div>
      <div class="neo-gallery-gm-composer">
        <div class="neo-gallery-edit-refline">
          <div class="neo-gallery-edit-refdrop-row">
            <div class="neo-gallery-edit-refdrop"><span class="neo-gallery-edit-refdrop-icon">＋</span><span class="neo-gallery-edit-refdrop-cap">参考</span></div>
            <div class="neo-gallery-edit-refpicks">
              <div class="neo-gallery-edit-refcount"><span>参考图</span><span class="neo-gallery-edit-refcount-num">0/9</span></div>
              <button class="neo-gallery-edit-refpick">⬆ 本地上传</button>
              <button class="neo-gallery-edit-refpick">🖼 素材库取用</button>
            </div>
          </div>
          <textarea class="neo-gallery-story-input neo-gallery-gm-quick-input" rows="4"></textarea>
        </div>
        <div class="neo-gallery-gm-composer-bar neo-gallery-gm-chips">
          <span class="neo-gallery-gm-chip-wrap">
            <button id="e2e-skill-chip" class="neo-gallery-gm-chip-btn"><span class="neo-gallery-gm-chip-icon"></span><span class="neo-gallery-gm-chip-label">Qwen Image 2.1</span><span class="neo-gallery-gm-chip-caret">▾</span></button>
            <div id="e2e-skill-panel" class="rs-runtime-menu neo-gallery-gm-chip-menu neo-gallery-gm-chip-panel neo-gallery-gm-skills-panel" style="display:none">
              <div class="neo-gallery-gm-skills-col">
                <div class="neo-gallery-gm-skill-group">Qwen Image</div>
                ${pickItem("Qwen Image 2.1", "qwen_image_2.1_int8_convrot", true)}
                ${pickItem("Qwen 换脸", "qwen_image_2.1_int8_convrot")}
                ${pickItem("Qwen 局部重绘", "qwen_image_2.1_int8_convrot")}
                ${pickItem("Qwen 扩图", "qwen_image_2.1_int8_convrot")}
                <div class="neo-gallery-gm-skill-group">Krea2</div>
                ${pickItem("Krea2文生图", "krea2")}
                ${pickItem("Krea2 风格", "krea2")}
                <div class="neo-gallery-gm-skill-group">MOSS</div>
                ${pickItem("MOSS 文生图", "MOSS-TS-MOSS-Image-SFT-0715-Stage2_int8_convrot")}
                ${pickItem("MOSS 图编辑", "MOSS-TS-MOSS-Image-SFT-0715-Stage2_int8_convrot")}
                <div class="neo-gallery-gm-skill-group">其他</div>
                ${pickItem("我的自定技能", "")}
                ${pickItem("同事给的技能包", "")}
              </div>
              <div class="neo-gallery-gm-params-col"><div class="neo-gallery-edit-model-box"><div class="rs-gen-model-section"></div></div></div>
              <div class="neo-gallery-gm-panel-foot"><button class="neo-gallery-gm-panel-done">完成</button></div>
            </div>
            <select class="neo-recipes-sort neo-gallery-gm-chip-select neo-gallery-gm-skill-sel" hidden><option>Qwen Image 2.1</option></select>
          </span>
          <span class="neo-gallery-gm-chip-wrap">
            <button id="e2e-mode-chip" class="neo-gallery-gm-chip-btn"><span class="neo-gallery-gm-chip-icon"></span><span class="neo-gallery-gm-chip-label">常规</span><span class="neo-gallery-gm-chip-caret">▾</span></button>
            <div class="rs-runtime-menu neo-gallery-gm-chip-menu"></div>
            <select class="neo-recipes-sort neo-gallery-gm-chip-select neo-gallery-edit-mode-select" hidden><option>常规</option></select>
          </span>
          <button class="neo-gallery-gm-chip-btn neo-gallery-edit-size-chip"><span class="neo-gallery-gm-chip-icon"></span><span class="neo-gallery-gm-chip-label"><label class="neo-director-field-label">目标分辨率</label><span class="neo-gallery-edit-size-chip-val">${w}×${h}</span></span></button>
          <div class="neo-gallery-gm-composer-gap"></div>
          <button class="neo-gallery-story-btn neo-gallery-story-btn-primary neo-gallery-gm-gen-btn">生成</button>
        </div>
        <div class="neo-gallery-edit-size-editor" style="display:none"><input type="number" id="img-edit-width" value="${w}"><span> × </span><input type="number" id="img-edit-height" value="${h}"></div>
      </div>
      <div class="neo-gallery-story-actions"><button class="neo-gallery-story-btn">取消</button></div>
    </div>`;

const body = (w, h, outpaint) => `
<div class="neo-gallery-story-modal-overlay neo-gallery-edit-modal-overlay">
  <div class="neo-gallery-story-modal neo-gallery-edit-modal">
    <div class="neo-gallery-story-titlebar"><span class="neo-gallery-story-title">图片编辑</span><span class="neo-gallery-story-close">×</span></div>
    ${modalInner(w, h, outpaint)}
  </div>
</div>`;

// 桌面绘画页内嵌形态：面板铺在 .ns-paint-panel 宿主里（贴底布局由 studio/style.css 管）
const embeddedBody = (w, h) => `
<div class="ns-page ns-paint"><div class="ns-paint-panel ns-paint-panel--edit ns-paint-edit">
  <div class="neo-gallery-gen-panel">
    <div class="neo-gallery-story-modal neo-gallery-edit-modal neo-gallery-story-modal--embedded">
      ${modalInner(w, h, false)}
    </div>
  </div>
</div></div>`;

// chip 菜单的收起态与浮出定位由 prompts.css 的 .rs-runtime-menu 基座给；本页只注入 gallery.css，
// 这里补一份基座，chip 菜单在布局里才是「收起时不占位」的浮层
const baseCss = `.rs-runtime-menu { display: none; position: fixed; z-index: 9400; background: #2a2a2a; border: 1px solid #5090cc; border-radius: 6px; padding: 8px 10px; min-width: 210px; }`;
const styleCss = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");

const html = (w, h, outpaint) =>
    `<!doctype html><html><head><style>${baseCss}${css}</style></head><body>${body(w, h, outpaint)}</body></html>`;

const embeddedHtml = (w, h) =>
    `<!doctype html><html><head><style>${baseCss}${css}${styleCss}</style></head><body>${embeddedBody(w, h)}</body></html>`;

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
        composer: box(".neo-gallery-gm-composer"),
        bar: box(".neo-gallery-gm-composer-bar"),
        genBtn: box(".neo-gallery-gm-composer-bar .neo-gallery-gm-gen-btn"),
        modeChip: box("#e2e-mode-chip"),
        skillChip: box("#e2e-skill-chip"),
        skillPanel: box("#e2e-skill-panel"),
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
        // 操作区在输入卡下方收尾，指令框在底行 chips 上方，「生成」钉在输入卡里
        assert.ok(m.genBtn.y + m.genBtn.h <= m.actions.y + 1, `输入卡应在操作区上方：gen=${JSON.stringify(m.genBtn)} actions=${JSON.stringify(m.actions)}`);
        assert.ok(m.prompt.y + m.prompt.h <= m.genBtn.y + 1, `指令框应在输入卡底行上方：prompt=${JSON.stringify(m.prompt)} gen=${JSON.stringify(m.genBtn)}`);
        assert.ok(within(m.genBtn, m.composer), `「生成」应在输入卡内：gen=${JSON.stringify(m.genBtn)} composer=${JSON.stringify(m.composer)}`);
        // 底行 = 技能与自定参数 chip + 模式 chip + 尺寸 chip + 生成；双栏面板默认不显示（点 chip 才浮出）
        assert.ok(within(m.modeChip, m.bar), `模式 chip 应在输入卡底行内：mode=${JSON.stringify(m.modeChip)} bar=${JSON.stringify(m.bar)}`);
        assert.ok(within(m.skillChip, m.bar), `技能 chip 应在输入卡底行内：skill=${JSON.stringify(m.skillChip)} bar=${JSON.stringify(m.bar)}`);
        assert.ok(m.skillPanel.w === 0 && m.skillPanel.h === 0, `技能与自定参数面板默认不显示：panel=${JSON.stringify(m.skillPanel)}`);

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

test("图片编辑输入卡：短窗口里底行 chips 与「生成」都在视口内的同一行", { timeout: 60000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 620 } });
    await page.setContent(embeddedHtml(1280, 848));
    await page.waitForTimeout(80);
    const m = await page.evaluate(measure);
    await page.close();

    assert.ok(m.bar.y + m.bar.h <= 621, `输入卡底行应落在视口内：bar=${JSON.stringify(m.bar)}`);
    assert.ok(within(m.modeChip, m.bar) && within(m.skillChip, m.bar) && within(m.genBtn, m.bar),
        `chip 与「生成」都应在底行内：mode=${JSON.stringify(m.modeChip)} skill=${JSON.stringify(m.skillChip)} gen=${JSON.stringify(m.genBtn)}`);
    assert.ok(Math.abs(m.modeChip.y - m.genBtn.y) < m.genBtn.h,
        `短窗口底行不换行（换行的 chip 会被折叠线切掉）：mode=${JSON.stringify(m.modeChip)} gen=${JSON.stringify(m.genBtn)}`);
    assert.ok(m.prompt.h <= Math.round(620 * 0.42) + 1, `指令框高度应被视口压住：prompt=${JSON.stringify(m.prompt)}`);
});

// 技能与自定参数并成双栏面板后，宽度与高度都是新的溢出风险：贴底 chip 向上开，
// 壳的 max-height（62vh + 绘画页按面板上沿收）要在三种窗口里都装得下，溢出留给左栏滚
const openPanel = () => {
    const chip = document.querySelector("#e2e-skill-chip");
    const panel = document.querySelector("#e2e-skill-panel");
    panel.style.display = "grid";   // 与 gallery-gen.js 开面板时写死的值一致（双栏不吃样式表顺序）
    // 与 gallery-gen.js 开面板同一套定位：钉在 chip 上方，右缘不出屏
    const r = chip.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8))}px`;
    const above = r.top - panel.offsetHeight - 6;
    panel.style.top = `${above > 8 ? above : r.bottom + 6}px`;
    const box = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const col = panel.querySelector(".neo-gallery-gm-skills-col");
    const done = panel.querySelector(".neo-gallery-gm-panel-done");
    const out = {
        panel: box(panel), chip: box(chip), col: box(col), foot: done ? box(done) : null,
        colScrollH: col.scrollHeight,
        panelScrollH: panel.scrollHeight, panelClientH: panel.clientHeight,
        cols: panel.children.length,
        colOverflow: getComputedStyle(col).overflowY,
        panelMax: getComputedStyle(panel).maxHeight,
        vw: window.innerWidth, vh: window.innerHeight,
    };
    panel.style.display = "none";
    return out;
};

for (const [vw, vh] of [[1600, 950], [1280, 620], [1280, 520]]) {
    test(`图片编辑输入卡：${vw}×${vh} 里技能与自定参数双栏面板整块落在视口内`, { timeout: 60000 }, async () => {
        const page = await browser.newPage({ viewport: { width: vw, height: vh } });
        await page.setContent(embeddedHtml(vw, 848));
        await page.waitForTimeout(80);
        const p = await page.evaluate(openPanel);
        await page.close();

        assert.equal(p.cols, 3, `面板是「技能栏 + 自定参数栏 + 完成 foot」三个直接子节点：${vw}×${vh}`);
        assert.ok(p.panel.h > 60, `面板是一块有内容的浮层：panel=${JSON.stringify(p.panel)}`);
        assert.ok(p.panel.y >= 0 && p.panel.y + p.panel.h <= p.vh + 1,
            `面板纵向落在视口内：panel=${JSON.stringify(p.panel)} vh=${p.vh}`);
        assert.ok(p.panel.x >= 0 && p.panel.x + p.panel.w <= p.vw + 1,
            `面板横向落在视口内：panel=${JSON.stringify(p.panel)} vw=${p.vw}`);
        assert.ok(p.panel.y + p.panel.h <= p.chip.y + 1, `面板从 chip 上方浮出：panel=${JSON.stringify(p.panel)} chip=${JSON.stringify(p.chip)}`);
        // 结果断言（不钉旧机制值）：技能再多，面板自身不滚 —— 溢出收进左栏，「完成」钉在面板底
        assert.ok(p.panelScrollH <= p.panelClientH + 1,
            `面板自身不滚动（溢出留给左栏，「完成」靠滚面板才见就是这里失守）：panelScrollH=${p.panelScrollH} clientH=${p.panelClientH}`);
        assert.ok(p.foot && p.foot.y >= 0 && p.foot.y + p.foot.h <= p.vh + 1,
            `「完成」落在视口内（不滚动就可见）：foot=${JSON.stringify(p.foot)} vh=${p.vh}`);
        assert.ok(p.foot && p.foot.y + p.foot.h <= p.panel.y + p.panel.h + 1,
            `「完成」收在面板底边内：foot=${JSON.stringify(p.foot)} panel=${JSON.stringify(p.panel)}`);
        assert.ok(p.col.h <= p.colScrollH + 1, `技能列不溢出自己的盒子：col=${JSON.stringify(p.col)} scrollH=${p.colScrollH}`);
        if (p.colScrollH > p.col.h) {
            assert.equal(p.colOverflow, "auto", `技能多于壳高时由左栏出滚动条（面板整块不再长高）：${vw}×${vh}`);
        }
    });
}
