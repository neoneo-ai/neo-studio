#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * tools/pose_prop_clay.mjs — 道具卡片预览图的白膜渲染器。
 *
 * 卡片上的预览图来自三家：Poly Haven 的实物照片、BlenderKit 的官方渲染、本项目自己拍的 clay。
 * 原色排在一页里是一块彩色马赛克（照片还带着黑底与杂物），形状反倒看不清 —— 道具卡要的是
 * 「灰底 + 白膜」这一种读法，一页里每张卡都一样才认得出道具本身。
 *
 * 渲染器就是打包好的姿势页：它本来就是 three.js + 同一套 GLB 与注册表管线，页面把
 * `window.__poseDebug` 露出来（props.addProp / props.group / scene / camera / renderer）。
 * 逐件 addProp 上画布、摘掉贴图与颜色覆成白膜、按包围盒套一台 3/4 机位、隐藏素体与地面，
 * 然后拍一张方图。不引新依赖：浏览器用仓库已有的 playwright，页面取 <数据根>/pose/dist，
 * 全程本地（页面那几条 /__pose3d/ping 是它自己的 sidecar 探针，静态伺服答不了很正常）。
 *
 * 默认只出图到 <repo>/tmp/prop_clay，不动任何已发布的图；`--apply` 才把图写回
 * <dist>/models/props/preview/（云端那批由 tools\pose_prop_previews.py 上传，是另一步）。
 *
 * 用法：
 *     node tools/pose_prop_clay.mjs                      # 全部道具出图到 tmp/prop_clay
 *     node tools/pose_prop_clay.mjs --only katana,crate   # 只渲点名的那几件
 *     node tools/pose_prop_clay.mjs --apply               # 写回 dist 的 preview 目录
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(REPO, "tmp", "prop_clay");
// 灰底取中性灰：卡片是深色圆角框，图框本身亮一档才托得住白膜的轮廓
const BACKDROP = 0x8f8f8f;
// 白膜不是纯白：0xf2f2f2 在灰底上留得下一档阴影层次，纯白会把高光与背景糊成一片
const CLAY = 0xf2f2f2;
const VIEW_DIR = [0.42, 0.28, 0.86];   // 3/4 前侧、略高一点的机位，和随包那批 clay 图同一个角度
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
    ".json": "application/json", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
    ".wasm": "application/wasm", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" };
// 一件道具最多等 20 秒：坏 GLB 与 3MB 的大件都要给足，但一件卡死不许拖住整批
const ADD_TIMEOUT = 20000;

/** 一件道具的预览图文件名：注册表行自己写的 preview 优先，内置程序化道具按约定名 builtin-<id>.png。
 *  两处都没有就按 GLB 的裸文件名取（与 pose.js 的 propPreviewUrl 同一条口径）。 */
export function previewNameFor(option) {
    const key = String(option?.propKey ?? option?.key ?? "");
    const named = String(option?.preview ?? "").split(/[\\/]/).pop();
    if (named && named !== "undefined") return named;
    if (key.startsWith("builtin:")) return `builtin-${key.slice("builtin:".length)}.png`;
    const stem = key.replace(/^glb:/, "").replace(/\.glb$/i, "");
    return `${stem}.png`;
}

function parseArgs(argv) {
    const out = { dist: "", out: DEFAULT_OUT, side: 512, only: [], apply: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--apply") out.apply = true;
        else if (a === "--dist") out.dist = argv[++i] ?? "";
        else if (a === "--out") out.out = argv[++i] ?? out.out;
        else if (a === "--side") out.side = Math.max(64, Number(argv[++i]) || out.side);
        else if (a === "--only") out.only = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        else if (a === "--help" || a === "-h") out.help = true;
    }
    return out;
}

/** 数据根里的姿势产物目录：NEO_STUDIO_DATA 指哪就在哪，桌面端默认在 <repo>/data */
function defaultDist() {
    const env = process.env.NEO_STUDIO_DATA;
    if (env) return path.join(env, "pose", "dist");
    return path.join(REPO, "data", "pose", "dist");
}

function serve(root) {
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(String(req.url).split("?")[0]);
        const file = path.join(root, url === "/" ? "index.html" : url);
        if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404);
            res.end("not found");
            return;
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** 在页面里摆好一件道具并套好机位：失败就交回原因，成功给 Playwright 一个可截的画布 */
const STAGE_PROP = `async (job) => {
    const d = window.__poseDebug;
    const scene = d.scene;
    await d.props.clearAll();
    const added = await d.props.addProp({ propKey: job.key, ground: true, place: "free", avoid: [] });
    if (!added || added.ok === false) return { error: (added && added.error) || "addProp failed" };
    // 只留光与道具：素体、地面、网格、helper 一并藏掉，白膜图里不许出现别人的影子
    const propGroup = d.props.group;
    const keep = new Set();
    for (let p = propGroup; p; p = p.parent) keep.add(p);
    scene.children.forEach((c) => {
        if (!keep.has(c) && !c.isLight && !c.isCamera) c.visible = false;
    });
    scene.background = null;
    d.renderer.setClearColor(job.backdrop, 1);
    // 白膜：GLB 自带的贴图与颜色全摘掉，只留几何；材质 clone 一份，不动注册表里那份共享材质
    propGroup.traverse((m) => {
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        const clay = mats.map((mat) => {
            const c = mat.clone();
            c.map = null; c.normalMap = null; c.roughnessMap = null; c.metalnessMap = null;
            c.emissiveMap = null; c.aoMap = null; c.alphaMap = null;
            if (c.color && c.color.setHex) c.color.setHex(job.clay);
            c.metalness = 0;
            c.roughness = 0.55;
            c.needsUpdate = true;
            return c;
        });
        m.material = Array.isArray(m.material) ? clay : clay[0];
    });
    // 包围盒：用几何自带的 boundingBox 与 mesh 的世界矩阵手算 —— 页面只露对象，不给 THREE 的构造器
    propGroup.updateMatrixWorld(true);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    propGroup.traverse((m) => {
        if (!m.isMesh || !m.geometry) return;
        m.geometry.computeBoundingBox?.();
        const bb = m.geometry.boundingBox;
        if (!bb) return;
        const v = m.position.clone();
        for (const x of [bb.min.x, bb.max.x]) {
            for (const y of [bb.min.y, bb.max.y]) {
                for (const z of [bb.min.z, bb.max.z]) {
                    v.set(x, y, z).applyMatrix4(m.matrixWorld);
                    min[0] = Math.min(min[0], v.x); max[0] = Math.max(max[0], v.x);
                    min[1] = Math.min(min[1], v.y); max[1] = Math.max(max[1], v.y);
                    min[2] = Math.min(min[2], v.z); max[2] = Math.max(max[2], v.z);
                }
            }
        }
    });
    if (!Number.isFinite(min[0])) return { error: "no geometry" };
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 0.05);
    const cam = d.camera;
    cam.fov = 30;
    cam.near = Math.max(0.001, size / 1000);
    cam.far = size * 100;
    // 按包围球套机位（半径 / sin(半视角)）：球在任何朝向下都装得下，斜看过去也不会把宽件的角切掉；
    // 1.15 的余量让长条件占到画面八成上下，和随包那批 clay 图同一个观感
    const radius = 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const dist = (radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.15;
    const len = Math.hypot(job.dir[0], job.dir[1], job.dir[2]);
    const eye = cam.position.clone().set(
        c[0] + (job.dir[0] / len) * dist, c[1] + (job.dir[1] / len) * dist, c[2] + (job.dir[2] / len) * dist);
    const target = cam.position.clone().set(c[0], c[1], c[2]);
    cam.position.copy(eye);
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    if (d.orbit) {
        d.orbit.enabled = false;
        if (d.orbit.target && d.orbit.target.copy) d.orbit.target.copy(target);
        d.orbit.update?.();
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { id: added.id, label: added.label, size: +size.toFixed(3) };
}`;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log("node tools/pose_prop_clay.mjs [--dist <dir>] [--out <dir>] [--side 512] [--only a,b] [--apply]");
        return 0;
    }
    const dist = path.resolve(args.dist || defaultDist());
    const outDir = args.apply ? path.join(dist, "models", "props", "preview") : path.resolve(args.out);
    if (!fs.existsSync(path.join(dist, "index.html"))) {
        console.error(`姿势产物不在：${dist}（先跑 tools\\sync_pose_dist.ps1，或用 --dist 指过去）`);
        return 1;
    }
    fs.mkdirSync(outDir, { recursive: true });

    const { chromium } = await import("playwright");
    const server = await serve(dist);
    const base = `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: args.side, height: args.side } });
    let done = 0;
    let failed = 0;
    try {
        await page.goto(base, { waitUntil: "load" });
        await page.waitForFunction(() => window.__poseDebug?.isReady?.(), null, { timeout: 60000 });
        // 工具条、提示条与面板压在画布上：截的是整窗，先把它们藏掉（只动显示，不动数据）
        await page.addStyleTag({
            content: "#hint,#toolbar,#btnChrome,#modePill,#toast,aside,details{display:none !important}",
        });
        const options = await page.evaluate(() => window.__poseDebug.props.options());
        const wanted = args.only.length
            ? options.filter((o) => args.only.some((n) => String(o.propKey).includes(n)))
            : options;
        if (!wanted.length) {
            console.error("没有匹配的道具：--only 写注册表 key 的一段（katana / crate / builtin:chair）");
            return 1;
        }
        console.log(`渲染 ${wanted.length} 件 → ${outDir}`);
        for (const opt of wanted) {
            const name = previewNameFor(opt);
            const job = { key: opt.propKey, backdrop: BACKDROP, clay: CLAY, dir: VIEW_DIR };
            let staged;
            try {
                // 传字符串时 Playwright 只把表达式求值成「那个箭头函数」，不会调用它：这里直接拼成一次调用
                staged = await Promise.race([
                    page.evaluate(`(${STAGE_PROP})(${JSON.stringify(job)})`),
                    new Promise((_, rej) => setTimeout(() => rej(new Error("addProp 超时")), ADD_TIMEOUT)),
                ]);
            } catch (e) {
                staged = { error: String(e?.message || e) };
            }
            if (staged?.error) {
                failed += 1;
                console.log(`  ✗ ${opt.propKey}：${staged.error}`);
                continue;
            }
            await page.screenshot({ path: path.join(outDir, name) });
            done += 1;
            console.log(`  ✓ ${opt.propKey} → ${name}（尺度 ${staged.size}m）`);
        }
    } finally {
        await browser.close();
        server.close();
    }
    console.log(`完成：${done} 张${failed ? `，失败 ${failed} 件` : ""}`
        + `${args.apply ? "（已写回 preview 目录）" : `（在 ${outDir}，核对后加 --apply 写回）`}`);
    return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().then((code) => { process.exitCode = code; }).catch((e) => {
        console.error(e);
        process.exitCode = 1;
    });
}

