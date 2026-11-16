#!/usr/bin/env node
// Promo video recording harness for Neo Studio.
//
// Drives the live ComfyUI with Playwright, records the browser context to webm,
// injects a bottom caption bar so subtitles are baked into the picture, and
// muxes the CosyVoice3 narration track in with the bundled ffmpeg.
//
// Usage:
//   node tools/capture-video.mjs <scenario> [options]
//     --out <path>     output .mp4 (default tmp/video/<scenario>.mp4)
//     --comfy <url>    ComfyUI URL (default http://127.0.0.1:8188)
//     --keep-webm      keep the raw webm for inspection
//
// Narration timing comes from tmp/narration/<scenario>/segments.json, written by
// tools/tts_cosyvoice.py. Each segment carries its measured duration, so a beat
// lasts exactly as long as its narration line plus a pad — picture and voice stay
// in sync without guessing at the nominal windows in docs/promo/video-scripts.md.
import { chromium } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'F:\\comfy\\Comfyui-WF-2026.8.8\\python\\Lib\\site-packages\\imageio_ffmpeg\\binaries\\ffmpeg-win-x86_64-v7.1.exe';
const PYTHON = process.env.PYTHON || 'F:\\comfy\\Comfyui-WF-2026.8.8\\python\\python.exe';

const argv = process.argv.slice(2);
const getOpt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const scenarioName = argv.find((a) => !a.startsWith('--'));
if (!scenarioName) {
  console.error('usage: node tools/capture-video.mjs <scenario> [--out p] [--comfy url]');
  process.exit(1);
}
const COMFY_URL = getOpt('comfy', 'http://127.0.0.1:8188');

// 字幕：每屏一行，与 segments.json 的段一一对应
const CAPTIONS = {
  script1: [
    '一张宫格图 → 一条成片',
    '＋ 新增导演配方 📖 宫格图分镜 → 🧩 宫格图故事板',
    '✂️ 拆分到各段 每格 = 该段首帧 · 行优先切格',
    '全局故事参考 🎞️ 分镜时间线 选模式与技能',
    '逐段生成 琥珀=当前段 绿=已完成 · 勾选只跑勾选段',
    '单个含音频 VIDEO 接缝 6 帧淡化',
    '两个节点，一条片子',
  ],
  script2: [
    '一排 LoadImage？不要',
    '🔲 Neo Reference Grid 槽位 1~12 · 拖放重排',
    '⚡ Neo Prompt Agent 一句话 → ✨ 生成 槽位自动增长',
    '<Picture 1> = 第 1 槽 · 参考图 ≤9',
    '配方保存 → 宫格优先填回',
  ],
  script3: [
    '社区/网盘工作流 = 满屏红节点',
    '🅝 → 🔧 修复工作流 置信度百分比 · 三档阈值',
    '手动改选 · 记住映射 缺模型 → 📥 模型库',
    '📥 模型库 双源搜索 · 自动归类落盘',
    '.part + meta.json 取消保留断点 · Range 续传',
    '修复记录仅存本机',
  ],
};



function loadSegments(scenario) {
  const p = path.join(ROOT, 'tmp', 'narration', scenario, 'segments.json');
  if (!fs.existsSync(p)) {
    console.error(`missing ${p} — run: python tools/tts_cosyvoice.py ${scenario}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---- helpers --------------------------------------------------------------
function makeHelpers(page, segments) {
  const h = {
    page,
    segments,
    caption(text) {
      return page.evaluate((t) => { document.querySelector('#neo-caption').textContent = t; }, text);
    },
    wait: (ms) => page.waitForTimeout(ms),
    run: (fn) => page.evaluate(fn),
    click(sel) { return page.locator(sel).first().click(); },
    clickText(sel, text) { return page.locator(sel).filter({ hasText: text }).first().click(); },
    async openMenu() {
      for (let i = 0; i < 3; i++) {
        await h.click('.neo-n-menu-btn');
        await h.wait(500);
        if (await h.count('.neo-n-menu') > 0) return;
      }
    },
    dragTo(srcSel, dstSel) { return page.locator(srcSel).first().dragTo(page.locator(dstSel).first()); },
    typeInto(sel, value) {
      return page.evaluate(({ s, v }) => {
        const el = document.querySelector(s);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, { s: sel, v: value });
    },
    pickSelect(sel, value) {
      return page.evaluate(({ s, v }) => {
        const el = document.querySelector(s);
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, { s: sel, v: value });
    },
    count(sel) { return page.locator(sel).count(); },
    shot(name) { return page.screenshot({ path: path.join(ROOT, 'tmp', 'video', 'frames', `${name}.png`) }); },

    timings: [],
    runStart: 0,

    // 一拍 = 一段旁白：先换字幕，跑动作，再补足到该段实测时长 + pad
    // 动作超出旁白窗口时下一拍会顺延，实测起点记进 timings，供旁白轨按真实时间补静音对齐
    async beat(index, actions) {
      if (!h.runStart) h.runStart = Date.now();
      const t0 = Date.now();
      await h.caption(CAPTIONS[scenarioName][index] || '');
      if (actions) await actions();
      const left = (segments.segments[index].beat * 1000) - (Date.now() - t0);
      if (left > 0) await h.wait(left);
      h.timings.push({ index, start: (t0 - h.runStart) / 1000, dur: (Date.now() - t0) / 1000 });
    },

    async init() {
      await page.goto(COMFY_URL, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !!window.app && !!window.LiteGraph, null, { timeout: 90000 });
      await page.evaluate(() => {
        const d = document.createElement('div');
        d.id = 'neo-caption';
        d.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99999;'
          + 'pointer-events:none;font:600 30px/1.4 "Microsoft YaHei",sans-serif;color:#fff;'
          + 'background:rgba(10,10,14,.82);padding:14px 28px;border-radius:12px;'
          + 'border:1px solid rgba(255,255,255,.18);max-width:74%;text-align:center;';
        document.body.appendChild(d);
      });
      await h.wait(1200);
    },

    // 素材面板：确保面板可见 → 回首页 → 进第一个目录 → 滚动侧栏容器加载足够图片卡片
    async openGallery(minCards = 12) {
      const btn = page.locator('button[aria-label="Neo Gallery"]');
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await page.locator('.neo-gallery-panel').isVisible()) break;
        await btn.click();
        await h.wait(1500);
      }
      await page.locator('.neo-gallery-breadcrumb-home').first().click();
      const dirs = page.locator('.neo-gallery-category-card');
      for (let i = 0; i < 20; i++) {
        if (await dirs.count() > 0) break;
        await h.wait(1000);
      }
      if (await dirs.count() === 0) { await h.shot('gallery-fail'); throw new Error('no gallery directories'); }
      await dirs.first().click();
      for (let i = 0; i < 30; i++) {
        const n = await page.locator('.neo-gallery-thumb-container').count();
        if (n >= minCards) return n;
        await page.evaluate(() => {
          const sc = document.querySelector('.sidebar-content-container');
          if (sc) sc.scrollTop += 600;
        });
        await h.wait(800);
      }
      return page.locator('.neo-gallery-thumb-container').count();
    },

    // 素材面板按目录名逐级进入（如 ['Output','StoryBoard','2026-09-27']），滚动侧栏加载卡片
    async navGallery(parts, minCards = 6) {
      const btn = page.locator('button[aria-label="Neo Gallery"]');
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await page.locator('.neo-gallery-panel').isVisible()) break;
        await btn.click();
        await h.wait(1500);
      }
      // 首页（目录视图）面包屑是隐藏的，只有进了子目录才显示
      const home = page.locator('.neo-gallery-breadcrumb-home').first();
      if (await home.isVisible()) {
        await home.click();
        await h.wait(1200);
      }
      for (const part of parts) {
        const card = page.locator('.neo-gallery-category-card').filter({ hasText: part }).first();
        await card.waitFor({ state: 'visible', timeout: 20000 });
        await card.click();
        await h.wait(1600);
      }
      for (let i = 0; i < 30; i++) {
        const n = await page.locator('.neo-gallery-thumb-container').count();
        if (n >= minCards) return n;
        await page.evaluate(() => {
          const sc = document.querySelector('.sidebar-content-container');
          if (sc) sc.scrollTop += 600;
        });
        await h.wait(800);
      }
      return page.locator('.neo-gallery-thumb-container').count();
    },

    clearGraph: () => page.evaluate(() => { app.graph.clear(); }),
  };
  return h;
}

// ---- main ---------------------------------------------------------------
async function main() {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    console.error(`unknown scenario "${scenarioName}". available: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  const segments = loadSegments(scenarioName);
  const outDir = path.join(ROOT, 'tmp', 'video');
  fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });
  const outPath = getOpt('out', path.join(outDir, `${scenarioName}.mp4`));

  const browser = await chromium.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] });
  const webmsDir = path.join(outDir, 'webms');
  fs.mkdirSync(webmsDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: webmsDir, size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();
  const h = makeHelpers(page, segments);
  // recordVideo 从建页那一刻就开始录，h.init() 的 goto 白屏在录制头部，
  // 记下录制起点，第一拍实测起点减它就是片头白屏长度，成片用 -ss 切掉
  const recStart = Date.now();

  const video = page.video();
  try {
    await scenario(h);
  } finally {
    await page.close();
  }
  const webm = await video.path();
  const keepWebm = path.join(outDir, `${scenarioName}.webm`);
  fs.copyFileSync(webm, keepWebm);
  await browser.close();

  const lead = (h.runStart - recStart) / 1000;
  // 旁白按实测节拍起点补静音，音轨铺满切掉片头后的整条视频，最后一拍不会被 -shortest 裁掉
  const d = spawnSync(FFMPEG, ['-i', keepWebm], { encoding: 'utf8' }).stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  const webmDur = +d[1] * 3600 + +d[2] * 60 + +d[3] + +d[4] / 100;
  const timingsPath = path.join(outDir, scenarioName, 'beat-timings.json');
  fs.mkdirSync(path.dirname(timingsPath), { recursive: true });
  fs.writeFileSync(timingsPath, JSON.stringify(h.timings, null, 1));
  const wav = path.join(ROOT, 'tmp', 'narration', scenarioName, 'narration_sync.wav');
  execFileSync(PYTHON, [path.join(ROOT, 'tools', 'pad-narration.py'), scenarioName, timingsPath, String(webmDur), String(lead)], { stdio: 'inherit' });

  execFileSync(FFMPEG, [
    '-y', '-ss', String(lead), '-i', keepWebm, '-i', wav,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', outPath,
  ], { stdio: 'inherit' });

  console.log('wrote', outPath, 'lead', lead.toFixed(2), 's raw webm at', keepWebm);
}

// ---- scenarios ----------------------------------------------------------
const SCENARIOS = {};

SCENARIOS.script1 = async (h) => {
  const GRID = 'generated_en_3.webp';   // Pictures 里的 2×3 六格分镜图（机器人干活）
  const MERGED = '冰雷玄幻对打_merged_20260920-205514.mp4';   // 落在 output/neo_director_merge/
  const mergedUrl = () => `/view?filename=${encodeURIComponent(MERGED)}&subfolder=neo_director_merge&type=output`;
  const RECIPE = '宫格成片演示';

  // 逐段生成进度是节点每 500ms 轮询 /neo_video_gen/director_progress 得来的；
  // UI 演示用路由喂进度值，让琥珀条按比例增长、完成段变绿，不跑真实生成。
  const prog = { active: false, segment_index: -1, total_segments: 0, step: 0, total_steps: 0 };
  const openVideo = (url, title) => h.page.evaluate(async ([u, t]) => {
    const lb = await import('/extensions/comfyui-neo-studio/lightbox.js');
    lb.Lightbox.open({ items: [{ kind: 'video', url: u, title: t }] });
  }, [url, title]);

  await h.init();
  await h.page.route('**/neo_video_gen/director_progress', (route) => route.fulfill({ json: prog }));

  // 0 成片快闪 2 秒 → 宫格图素材库
  await h.beat(0, async () => {
    await openVideo(mergedUrl(), '成片');
    await h.wait(2400);
    await h.page.evaluate(async () => (await import('/extensions/comfyui-neo-studio/lightbox.js')).Lightbox.close());
    await h.wait(500);
    await h.clearGraph();
    await h.navGallery(['Pictures'], 6);
  });

  // 1 导演节点 → ✎ 编辑器 → 🧩 宫格图故事板卡片，从素材库拖入宫格图
  await h.beat(1, async () => {
    await h.page.evaluate(() => {
      const n = LiteGraph.createNode('NeoH3VideoDirector');
      n.pos = [300, 140];
      app.graph.add(n);
      window.__dir = n;
      // DOM widget 只在节点被选中、画布重绘后才挂载显示
      app.canvas.selectNode(n, false);
      app.canvas.setZoom(1);
      app.canvas.setDirty(true, true);
    });
    await h.wait(1800);
    await h.page.locator('.neo-dtl-new').first().click();
    await h.page.locator('.neo-director-grid-src').first().waitFor({ state: 'visible', timeout: 15000 });
    await h.page.locator(`.neo-gallery-thumb-container[data-filename="${GRID}"]`).first().dragTo(h.page.locator('.neo-director-grid-src'));
    await h.page.locator('.neo-director-grid-src img').first().waitFor({ state: 'visible', timeout: 20000 });
    console.log('grid src', await h.page.evaluate(() => document.querySelector('.neo-director-grid-src img')?.title || ''));
    await h.wait(1400);
  });

  // 2 切分方式自动检测 → ✂️ 拆分到各段 → 各段对照逐格出现
  await h.beat(2, async () => {
    await h.pickSelect('.neo-director-grid-mode', 'auto');
    await h.page.locator('.neo-director-grid-split').first().click();
    await h.page.locator('.neo-director-grid-status').first().filter({ hasText: '格' }).waitFor({ timeout: 20000 });
    await h.page.locator('.neo-director-story-seg-item').first().waitFor({ state: 'visible', timeout: 15000 });
    await h.wait(1400);
    console.log('story cells', await h.count('.neo-director-story-seg-item'));
  });

  // 3 全局故事参考（原图内嵌提示词）→ 时间线页选模式与技能 → 保存 → 回画布
  let frames = [];
  await h.beat(3, async () => {
    await h.page.locator('.neo-director-grid-prompts').first().waitFor({ state: 'visible' });
    frames = await h.page.evaluate(() => [...document.querySelectorAll('.neo-director-story-seg-item img')]
      .map((i) => i.getAttribute('src')).filter((s) => s && s.includes('/view')));
    console.log('cell thumbs', frames.length);
    await h.page.locator('.neo-director-name-view').first().click();   // 名称框默认是只读 span，点一下才变输入框
    await h.page.locator('.neo-director-name').first().fill(RECIPE);
    await h.wait(900);
    await h.page.locator('.neo-director-tab').filter({ hasText: '分镜时间线' }).first().click();
    await h.wait(900);
    await h.pickSelect('.neo-director-mode', 'f2v');
    const skill = await h.page.evaluate(() => {
      const s = document.querySelector('.neo-director-global-skill');
      return s && s.options.length ? s.options[0].value : '';
    });
    if (skill) await h.pickSelect('.neo-director-global-skill', skill);
    await h.wait(900);
    await h.page.locator('.neo-director-save').first().click();
    await h.page.locator('.neo-director-grid-src').first().waitFor({ state: 'hidden', timeout: 20000 });
    await h.wait(1200);
    await h.page.evaluate(() => { app.canvas.setZoom(0.7); });
  });

  // 4 逐段生成：琥珀按比例增长、完成段变绿、节点内实时预览出画面、悬停段块勾选
  await h.beat(4, async () => {
    const nodeId = await h.page.evaluate(() => window.__dir.id);
    const n = frames.length || 6;
    prog.active = true;
    prog.total_segments = n;
    prog.total_steps = 30;
    for (let i = 0; i < n; i++) {
      prog.segment_index = i;
      prog.step = 0;
      const url = frames[i] || frames[0];
      if (url) {
        await h.page.evaluate(({ id, u }) => {
          window.dispatchEvent(new CustomEvent('rs.h3.preview', { detail: { node_id: String(id), frames: [u], fps: 6 } }));
        }, { id: nodeId, u: url });
      }
      for (let k = 0; k < 4; k++) {
        prog.step = Math.round(((k + 1) * prog.total_steps) / 4);
        await h.wait(500);
      }
    }
    prog.active = false;
    // 悬停段块 → 左上角勾选框出现 → 点它只跑勾选的段
    // 时间轴缩到最小，让 6 段全部落在可视区内（scrollLeft 归零），勾选框命中才与画面一致
    await h.page.evaluate(() => { window.__dir._neoDtTimeline.setZoom(0.25); });
    await h.wait(600);
    const pt = await h.page.evaluate((i) => {
      const tl = window.__dir._neoDtTimeline;
      const b = tl._layout().blocks[i];
      const rect = tl.canvas.getBoundingClientRect();
      const k = (tl.canvas.clientWidth || rect.width) / rect.width;
      const x = rect.left + (b.x + 11.5) / k, y = rect.top + 32.5 / k;
      const lp = tl._localPoint({ clientX: x, clientY: y });
      return {
        pt: [Math.round(x), Math.round(y)], local: [Math.round(lp.x), Math.round(lp.y)],
        hits: tl._hitsCheck(lp.x, lp.y, i), block: [Math.round(b.x), Math.round(b.w)],
        rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width)],
        clientW: tl.canvas.clientWidth, scroll: tl.scroll.scrollLeft,
      };
    }, Math.min(2, n - 1));
    console.log('check pt', JSON.stringify(pt));
    await h.page.mouse.move(pt.pt[0], pt.pt[1]);
    await h.wait(600);
    await h.page.mouse.click(pt.pt[0], pt.pt[1]);
    await h.wait(1200);
    console.log('checked', await h.page.evaluate(() => window.__dir._neoDtTimeline.getChecked()));
  });

  // 5 播放成片，特写接缝
  await h.beat(5, async () => {
    await openVideo(mergedUrl(), '成片');
    await h.page.locator('.neo-lightbox-video').first().waitFor({ state: 'visible', timeout: 15000 });
    await h.page.evaluate(() => { const v = document.querySelector('.neo-lightbox-video'); if (v) v.currentTime = 6; });
    await h.wait(1200);
    await h.page.evaluate(() => { const v = document.querySelector('.neo-lightbox-video'); if (v) v.currentTime = 20; });
    await h.wait(2000);
  });

  // 6 画布全景：只有导演节点和 SaveVideo
  await h.beat(6, async () => {
    await h.page.evaluate(async () => {
      (await import('/extensions/comfyui-neo-studio/lightbox.js')).Lightbox.close();
      const d = window.__dir;
      const sv = LiteGraph.createNode('SaveVideo');
      sv.pos = [d.pos[0] + 520, d.pos[1] + 60];
      app.graph.add(sv);
      d.connect(0, sv, 0);
      app.canvas.setZoom(0.45);
    });
    await h.wait(1600);
    await h.page.locator('.neo-n-menu-btn').first().click();
    await h.wait(1600);
    console.log('graph nodes', await h.page.evaluate(() => app.graph.nodes.map((n) => n.type)));
  });
};

SCENARIOS.script3 = async (h) => {
  const COMMUNITY = 'minimax-h3-community.png';   // input/ 里内嵌工作流的社区图（tools/make-community-workflow.py 生成）

  await h.init();

  // 0 素材库导入社区工作流：满屏红节点，顶栏 🅝 亮红点
  await h.beat(0, async () => {
    await h.clearGraph();
    // 清掉上次录制留下的修复映射，保证每次录制都从「全部失效」开始
    await h.page.evaluate(async () => {
      for (const k of ['text_encoders|qwen3vl_32b_minimax_h3_fp16',
                       'diffusion_models|minimax_h3_fl2va_fp8_convrot'])
        await fetch(`/neo_nodes/repair_mappings?key=${encodeURIComponent(k)}`, { method: 'DELETE' });
    });
    await h.navGallery(['Input', 'NeoDemo'], 5);
    const card = h.page.locator(`.neo-gallery-thumb-container[data-filename="${COMMUNITY}"]`).first();
    await card.waitFor({ state: 'visible', timeout: 20000 });
    await card.click();
    const imp = h.page.locator('.neo-lightbox-panel-btn').filter({ hasText: '导入工作流' }).first();
    await imp.waitFor({ state: 'visible', timeout: 20000 });
    await imp.click();
    await h.page.locator('.neo-n-menu-btn.neo-repair-hint').first().waitFor({ state: 'visible', timeout: 20000 });
    await h.page.evaluate(() => { app.canvas.setZoom(0.5); });
    console.log('graph nodes', await h.page.evaluate(() => app.graph.nodes.length));
    await h.wait(2200);
  });

  // 1 🅝 → 🔧 修复工作流：删除线 / 绿色候选 / 置信度 / 三档阈值
  await h.beat(1, async () => {
    await h.openMenu();
    await h.clickText('.neo-n-menu-item', '修复工作流');
    await h.page.locator('.neo-repair-dialog').waitFor({ state: 'visible', timeout: 20000 });
    await h.wait(1800);
    const thr = h.page.locator('.neo-repair-dialog select').first();
    for (const t of ['strict', 'loose', 'standard']) {
      await thr.selectOption(t);
      await h.wait(1600);
    }
    await h.wait(1200);
  });

  // 2 手动改选 + 记住映射 + 缺模型行 → 📥 模型库
  await h.beat(2, async () => {
    // 严格档：UNET 行掉成手动选择，VAE 行保持「📥 模型库」按钮
    const thr = h.page.locator('.neo-repair-dialog select').first();
    await thr.selectOption('strict');
    await h.wait(1200);
    const pick = h.page.locator('.neo-repair-dialog select').filter({ hasText: '手动选择' }).first();
    const opts = await pick.locator('option').allTextContents();
    if (opts.length > 1) {
      await pick.selectOption({ index: 1 });
      await h.wait(1200);
    }
    const remember = h.page.locator('.neo-repair-dialog input[type=checkbox]');
    if (await remember.count()) { await remember.first().check(); await h.wait(700); }
    await h.clickText('.neo-repair-dialog button', '📥 模型库');
    await h.page.locator('.neo-hub-overlay').waitFor({ state: 'visible', timeout: 15000 });
    await h.wait(1500);
    await h.page.locator('.neo-hub-head .neo-hub-icon-btn').last().click();
    await h.page.locator('.neo-hub-overlay').first().waitFor({ state: 'hidden', timeout: 10000 });
    await h.wait(800);
    await h.clickText('.neo-repair-dialog button', '修复');
    await h.wait(2500);
    await h.run(() => { app.canvas.setZoom(0.8); });
    await h.wait(1200);
  });

  // 3 模型库：选源、搜仓库、文件清单带类别与大小、已存在标记
  await h.beat(3, async () => {
    await h.openMenu();
    await h.clickText('.neo-n-menu-item', '模型库');
    await h.page.locator('.neo-hub-overlay').waitFor({ state: 'visible', timeout: 15000 });
    await h.clickText('.neo-hub-src-btn', 'ModelScope');
    await h.typeInto('.neo-hub-search', 'MiniMax H3');
    await h.clickText('.neo-hub-btn', '搜索');
    for (let i = 0; i < 25; i++) {
      const n = await h.count('.neo-hub-repo option');
      if (n > 1) break;
      await h.wait(1000);
    }
    await h.wait(1500);
    await h.page.locator('.neo-hub-repo').selectOption({ index: 1 });
    for (let i = 0; i < 25; i++) {
      const n = await h.count('.neo-hub-files option');
      if (n > 0) break;
      await h.wait(1000);
    }
    await h.wait(2000);
    await h.page.locator('.neo-hub-files').evaluate((el) => { el.scrollTop = 0; });
    await h.wait(1200);
  });

  // 4 下载 → 取消（断点保留）→ 续传
  await h.beat(4, async () => {
    const biggest = await h.page.locator('.neo-hub-files').evaluate((el) => {
      let best = -1, size = -1;
      [...el.options].forEach((o, i) => {
        if (o.textContent.includes('已存在')) return;
        const m = /([\d.]+)\s*(GB|MB|KB)/.exec(o.textContent);
        const v = m ? parseFloat(m[1]) * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1) : 0;
        if (v > size) { size = v; best = i; }
      });
      return best;
    });
    if (biggest < 0) throw new Error('no downloadable file in repo list');
    await h.page.locator('.neo-hub-files').selectOption({ index: biggest });
    await h.wait(900);
    await h.click('.neo-hub-dl');
    let running = false;
    for (let i = 0; i < 30; i++) {
      const s = await h.page.evaluate(() => ({
        status: document.querySelector('.neo-hub-status')?.textContent || '',
        prog: document.querySelector('.neo-hub-prog')?.textContent || '',
        cancel: document.querySelector('.neo-hub-cancel')?.disabled,
      }));
      console.log('dl', i, JSON.stringify(s));
      if (s.cancel === false) { running = true; break; }
      await h.wait(1000);
    }
    if (!running) throw new Error('download never reached running state');
    await h.wait(2500);
    await h.click('.neo-hub-cancel');
    await h.wait(2500);
    console.log('after cancel:', await h.page.locator('.neo-hub-status').first().textContent());
    await h.click('.neo-hub-dl');
    await h.wait(4000);
  });

  // 5 修复记录（仅存本机）
  await h.beat(5, async () => {
    if (await h.count('.neo-hub-overlay')) {
      await h.page.locator('.neo-hub-head .neo-hub-icon-btn').last().click();
      await h.page.locator('.neo-hub-overlay').first().waitFor({ state: 'hidden', timeout: 10000 });
    }
    await h.openMenu();
    await h.clickText('.neo-n-menu-item', '修复记录');
    await h.page.locator('.neo-repair-log-dialog').waitFor({ state: 'visible', timeout: 15000 });
    await h.wait(2500);
    await h.page.locator('.neo-repair-log-dialog').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await h.wait(1500);
  });
};

SCENARIOS.script2 = async (h) => {
  await h.init();

  // 0 传统画布：一排 LoadImage，连线乱
  await h.beat(0, async () => {
    await h.run(() => {
      app.graph.clear();
      const nodes = [];
      for (let i = 0; i < 12; i++) {
        const n = LiteGraph.createNode('LoadImage');
        n.pos = [60 + i * 150, 140 + (i % 3) * 60];
        app.graph.add(n);
        nodes.push(n);
      }
      for (let i = 1; i < nodes.length; i++) nodes[i].connect(0, nodes[i - 1], 0);
      app.canvas.setZoom(0.55);
    });
    await h.wait(2200);
  });

  // 1 宫格节点：槽位 9→12，素材面板拖入 12 张，瓷砖重排
  await h.beat(1, async () => {
    await h.run(() => {
      app.graph.clear();
      const g = LiteGraph.createNode('NeoRefGrid');
      g.pos = [380, 120];
      g.size = [560, 320];
      app.graph.add(g);
      window.__grid = g;
      app.canvas.setZoom(1);
    });
    await h.wait(1400);
    for (let i = 0; i < 3; i++) {
      await h.page.locator('.neo-rg-btn').nth(1).click();
      await h.wait(450);
    }
    const n = await h.openGallery(12);
    console.log('gallery cards', n);
    const names = await h.page.evaluate(() =>
      [...document.querySelectorAll('.neo-gallery-thumb-container')].slice(0, 12).map((c) => c.dataset.filename));
    for (const name of names) {
      const card = h.page.locator(`.neo-gallery-thumb-container[data-filename="${name}"]`).first();
      await card.dragTo(h.page.locator('.neo-rg-grid'));
      await h.wait(320);
    }
    await h.wait(600);
    await h.page.locator('.neo-rg-cell').nth(0).dragTo(h.page.locator('.neo-rg-cell').nth(5));
    await h.wait(900);
  });

  // 2 提示词智能体：快捷框一句话 → ✨ 生成
  await h.beat(2, async () => {
    await h.run(() => {
      const a = LiteGraph.createNode('NeoPromptAgent');
      a.pos = [1000, 120];
      app.graph.add(a);
    });
    await h.wait(1400);
    await h.pickSelect('.rs-thinking-depth-select', 'off');
    await h.typeInto('.rs-quick-input', '雨夜霓虹街头，女特工回眸');
    await h.wait(400);
    await h.click('.rs-generate-btn');
    for (let i = 0; i < 20; i++) {
      const len = await h.page.evaluate(() => [...document.querySelectorAll('textarea:not(.rs-quick-input)')]
        .map((t) => t.value.length).sort((a, b) => b - a)[0] || 0);
      if (len > 60) break;
      await h.wait(500);
    }
    await h.wait(1200);
  });

  // 3 Picture 标记 + 输出槽 image_1..image_12 逐个露出
  await h.beat(3, async () => {
    await h.run(() => {
      const ta = [...document.querySelectorAll('textarea:not(.rs-quick-input)')].find((t) => t.value.length > 60);
      if (ta) {
        ta.value = `<Picture 1> 的女主角站在 <Picture 2> 的街角，` + ta.value;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const g = window.__grid;
      const pv = [];
      for (let i = 0; i < 12; i++) {
        const n = LiteGraph.createNode('PreviewImage');
        if (!n) continue;
        n.pos = [1420, 40 + i * 130];
        app.graph.add(n);
        pv.push(n);
      }
      window.__pv = pv;
      console.log('grid', !!g, 'pv', pv.length);
    });
    for (let i = 0; i < 12; i++) {
      await h.page.evaluate((i) => { window.__grid.connect(2 + i, window.__pv[i], 0); }, i);
      await h.wait(320);
    }
    await h.wait(1000);
  });

  // 4 保存配方 → 还原（宫格优先填回）
  await h.beat(4, async () => {
    await h.page.locator('.neo-rg-btn:has(.pi-save)').first().click();
    await h.page.locator('.neo-rg-dialog').waitFor({ state: 'visible', timeout: 10000 });
    await h.page.locator('.neo-rg-input').fill('视频配方演示');
    await h.wait(1200);
    await h.page.locator('.neo-rg-dialog-save').click();
    await h.page.locator('.neo-rg-overlay').first().waitFor({ state: 'hidden', timeout: 20000 });
    await h.page.locator('button[aria-label="Neo Recipes (视频配方)"]').click();
    await h.page.locator('.neo-recipes-card').first().waitFor({ state: 'visible', timeout: 20000 });
    await h.wait(800);
    await h.page.locator('.neo-recipes-card').first().hover();
    await h.page.locator('.neo-recipes-send').first().click();
    await h.wait(2500);
    await h.run(() => { app.canvas.setZoom(0.6); });
    await h.wait(1500);
  });
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});



