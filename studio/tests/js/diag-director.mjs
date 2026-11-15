import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep, click, flush, fetchLog } from "./setup.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];
globalThis.WebSocket = class { constructor(u) { this.url = u; } send() {} close() {} };
let seq = 0;

async function boot() {
    resetEnv();
    clearRoutes();
    document.body.innerHTML = studioBody;
    window.location.hash = "#/home";
    mockRoute("/neo_studio/version", jsonResponse({ success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [] }));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "R1", type: "video_director", source: "user", shared: { mode: "f2v" }, assets: [], loras: [], segments: [{ skill_id: "sk-a", prompt: "段一", duration_sec: 3, first_frame: "seed1.png" }, { skill_id: "sk-a", prompt: "段二", duration_sec: 4 }] },
        { name: "R2", type: "video_director", source: "user", shared: { mode: "f2v" }, assets: [], loras: [], segments: [{ skill_id: "sk-a", prompt: "甲", duration_sec: 2 }, { skill_id: "sk-a", prompt: "乙", duration_sec: 2, mode: "r2v" }, { skill_id: "sk-a", prompt: "丙", duration_sec: 2 }] },
    ]));
    mockRoute("/rs_recipes/load", (b) => jsonResponse({ success: true, recipe: b.name === "R2"
        ? { name: "R2", type: "video_director", source: "user", shared: { mode: "f2v" }, assets: [], loras: [], segments: [{ skill_id: "sk-a", prompt: "甲", duration_sec: 2 }, { skill_id: "sk-a", prompt: "乙", duration_sec: 2, mode: "r2v" }, { skill_id: "sk-a", prompt: "丙", duration_sec: 2 }] }
        : { name: "R1", type: "video_director", source: "user", shared: { mode: "f2v" }, assets: [], loras: [], segments: [{ skill_id: "sk-a", prompt: "段一", duration_sec: 3, first_frame: "seed1.png" }, { skill_id: "sk-a", prompt: "段二", duration_sec: 4 }] } }));
    mockRoute("/rs_recipes/director_spec", (b, call) => jsonResponse(call.query.get("name") === "R2"
        ? { success: true, segments: [{}, {}, {}], defaults: { width: 1344, height: 768, steps: 8 } }
        : { success: true, segments: [{ ref_input: "seed1.png", last_input: "" }], defaults: { width: 640, height: 384, steps: 20 } }));
    mockRoute("/rs_prompts/skills", () => jsonResponse([{ id: "sk-a", cn_name: "技能 A", gen_video: true, mode: "f2v", gen_config: { ref_kinds: ["image"] } }]));
    mockRoute("/neo_video_gen/director_progress", () => jsonResponse({ success: true, active: false, segment_index: -1, total_segments: 0, step: 0, total_steps: 0 }));
    mockRoute("/neo_video_gen/models", () => jsonResponse({ success: true, models: {} }));
    mockRoute("/neo_image_gen/skill_config", () => jsonResponse({}));
    mockRoute("/neo_skill_models/check", () => jsonResponse({ success: true, check: { has_manifest: true, blocked: false, missing: [], missing_count: 0 } }));
    mockRoute("/neo_studio/queue", () => jsonResponse({ success: true, online: true, image: 0, segment: 0, film: 0, simple: 0, voice: 0, total: 0, rows: [] }));
    mockRoute("/neo_studio/director/generate", (body) => { globalThis.__genBody = body; return jsonResponse({ success: true, task_id: "task-1", prompt_id: "p1", recipe: body.recipe, seed: body.seed, status: "queued", progress: null, error: "", created: 0, updated: 0 }); });
    mockRoute("/neo_studio/director/task-1", () => jsonResponse({ success: true, task_id: "task-1", status: "queued", progress: null, error: "" }));
    mockRoute("/neo_gallery/copy_to_input", (b, call) => jsonResponse({ success: true, filename: `copied_${call.query.get("filename")}` }));
    mockRoute("/neo_studio/director/spec", () => jsonResponse({ success: true, recipe: "R1", segments: [{ ref_input: "", last_input: "" }], defaults: { width: 640, height: 384, steps: 20 } }));
    await import(`../../web/studio/studio-app.js?diag=${seq++}`);
    await sleep(0); await flush(); await sleep(0); await flush();
}

await boot();
console.log("TABS", [...document.querySelectorAll(".ns-tabs a")].map((a) => a.dataset.tab).join(","));
const tab = document.querySelector('.ns-tabs a[data-tab="director"]');
if (tab) { click(tab); await sleep(300); }
const host = document.querySelector(".ns-director-timeline");
const t = host.__neoDirectorTimeline;
t.canvas.__rect = { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 120, width: 600, height: 120 };
const sel = document.querySelector(".ns-director-recipe");
sel.value = "R2";
sel.dispatchEvent(new Event("change", { bubbles: true }));
await sleep(60);
console.log("LAYOUT", JSON.stringify(t._layout().blocks));
console.log("SEGS", t._segs.length, "OPTS", t.opts.getSegments().length, "W", t._width(), "VW", t._visibleWidth(), "BH", t._blockHeight(), "ZOOM", t.getZoom());
const mouse = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
const pt = (i) => {
    const b = t._layout().blocks[i];
    for (let y = 0; y <= 60; y += 2) for (let x = b.x; x <= b.x + 60; x += 2) if (t._blockAt(x) === i && t._hitsCheck(x, y, i)) return [x, y];
    return null;
};
for (const i of [0, 2]) {
    const p = pt(i);
    console.log("CHECKPT", i, JSON.stringify(p), "blockAt", p ? t._blockAt(p[0]) : "n/a");
    if (p) t.canvas.dispatchEvent(mouse("mousedown", p[0], p[1]));
    await sleep(20);
    console.log("CHECKED", JSON.stringify(t.getChecked()), "HINT", document.querySelector(".ns-director-checkhint")?.textContent);
}
const run = document.querySelector(".ns-director-run");
console.log("RUN_DISABLED", run.disabled, "CLASSES", run.className);
const cfgPanel = document.querySelector(".ns-director-cfg-panel");
console.log("PANEL_OPEN", cfgPanel?.open ?? cfgPanel?.hidden ?? "n/a");
const modelSel = document.querySelector(".ns-director-cfg-panel select");
console.log("CFGSELECTS", [...document.querySelectorAll(".ns-director-cfg-panel select")].map((s) => s.multiple ? "multi" : "single").join(","));
if (modelSel) { modelSel.value = "h3/model_b.safetensors"; modelSel.dispatchEvent(new Event("change", { bubbles: true })); }
const seed = document.querySelector(".ns-director-seed");
console.log("SEED", !!seed);
if (seed) { seed.value = "8888"; seed.dispatchEvent(new Event("change", { bubbles: true })); }
console.log("CFG_BTN", !!document.querySelector(".ns-director-cfg-btn"));
run.click();
await sleep(120);
console.log("STATUS", document.querySelector(".ns-director-status")?.textContent);
console.log("PATHS", fetchLog.filter((c) => c.method === "POST").map((c) => c.path).join(","));
console.log("BODY", JSON.stringify(globalThis.__genBody));
process.exit(0);
