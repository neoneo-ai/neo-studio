// 配方列表卡片：多段导演配方点缩略图直接进编辑器（跳过详情）；普通配方仍打开详情。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sleep, dialogs, setConfirmAnswer } from "./setup.mjs";
import { appState } from "./mocks/comfy-app.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

function recipeFixture(over = {}) {
    return {
        name: "fx-recipe", source: "custom", prompt: "hello world",
        assets: [{ kind: "image", file: "a.png" }], samples: [], results: [],
        ...over,
    };
}

test("配方列表：多段导演配方点缩略图直接打开编辑器，普通配方仍打开详情", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] }; // 无 Load* 节点 → 编辑器无媒体候选
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "dir-recipe", type: "video_director", source: "custom", prompt: "", assets: [], samples: [] },
        { name: "normal-recipe", source: "custom", prompt: "hello", assets: [{ kind: "image", file: "a.png" }], samples: [] },
    ]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);

    const covers = Array.from(panel.querySelectorAll(".neo-recipes-card-media"));
    assert.equal(covers.length, 2, "两个配方卡片");

    // 多段导演配方（第一个）：点缩略图 → 打开编辑器浮层，不打开详情
    covers[0].click();
    await sleep(80);
    assert.ok(document.querySelector(".neo-director-overlay"), "导演配方点缩略图打开编辑器");
    assert.equal(document.querySelector(".neo-recipes-detail"), null, "未打开详情浮层");

    // 关闭编辑器，再测普通配方
    const closeBtn = document.querySelector(".neo-director-close");
    if (closeBtn) closeBtn.click();
    await sleep(20);

    // 普通配方（第二个）：点缩略图 → 打开详情浮层，不打开编辑器
    covers[1].click();
    await sleep(30);
    assert.ok(document.querySelector(".neo-recipes-detail"), "普通配方点缩略图打开详情");
    assert.equal(document.querySelector(".neo-director-overlay"), null, "未打开编辑器");
});

test("配方面板：directorOnly 只列多段导演配方并隐藏筛选 chips", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "dir-recipe", type: "video_director", source: "custom", prompt: "", assets: [], samples: [] },
        { name: "normal-recipe", source: "custom", prompt: "hello", assets: [{ kind: "image", file: "a.png" }], samples: [] },
    ]));

    const panel = await createRecipesPanel({ directorOnly: true });
    document.body.appendChild(panel);

    const names = Array.from(panel.querySelectorAll(".neo-recipes-card-name span:first-child")).map(el => el.textContent);
    assert.deepEqual(names, ["dir-recipe"], "只显示导演配方");
    assert.equal(panel.querySelectorAll(".neo-recipes-chip").length, 0, "筛选 chips 隐藏");
});

test("配方卡片：每个配方都有复制按钮，点击调用 /rs_recipes/copy 传源名", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "src-recipe", source: "custom", prompt: "hello", assets: [], samples: [] },
        { name: "preset-x", source: "preset", prompt: "pp", assets: [], samples: [] },
    ]));
    let copyBody = null;
    mockRoute("/rs_recipes/copy", (body) => {
        copyBody = body;
        return jsonResponse({ success: true, name: "src-recipe-copy" });
    });

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);

    // custom 与 preset 配方都应显示复制按钮（preset 可复制成 custom）
    assert.equal(panel.querySelectorAll(".neo-recipes-card").length, 2, "两个配方卡片");
    const copyBtns = panel.querySelectorAll(".neo-recipes-copy");
    assert.equal(copyBtns.length, 2, "每个配方都有复制按钮");

    copyBtns[0].click();
    await sleep(80);
    assert.deepEqual(copyBody, { name: "src-recipe" }, "调用 /rs_recipes/copy 传源配方名");
    assert.ok(appState.toasts.some(t => t.summary === "配方已复制"), "复制成功弹 toast");
});

test("配方详情：导演配方显示段数/模式/技能/宽×高/总时长概览行", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
        { id: "sk-b", name: "技能 B", gen_video: true },
    ]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        {
            name: "dir-unified", type: "video_director", source: "custom", prompt: "", assets: [], samples: [],
            shared: { width: 1344, height: 768, mode: "t2v" },
            segments: [
                { skill_id: "sk-a", prompt: "p1", duration_sec: 5 },
                { skill_id: "sk-a", prompt: "p2", duration_sec: 5 },
                { skill_id: "sk-a", prompt: "p3", duration_sec: 5 },
            ],
        },
        {
            name: "dir-mixed", type: "video_director", source: "custom", prompt: "", assets: [], samples: [],
            shared: { width: 768, height: 1344, mode: "mixed" },
            segments: [
                { skill_id: "sk-a", prompt: "p1", duration_sec: 5, mode: "i2v" },
                { skill_id: "sk-b", prompt: "p2", duration_sec: 3.5, mode: "t2v" },
            ],
        },
    ]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);

    // 统一模式：技能同名聚合 ×3，总时长 15s
    panel.querySelector(".neo-recipes-card-name").click();
    await sleep(80);
    let meta = document.querySelector(".neo-recipes-detail-meta");
    assert.ok(meta, "导演配方详情有概览行");
    assert.equal(meta.textContent, "3 段 · 关键帧生视频 · 技能 A ×3 · 1344×768 · 总时长 15s", "统一模式概览行内容（旧 t2v 显示为 f2v）");

    // 混合模式：多技能并列、小数总时长
    document.querySelector(".neo-recipes-detail-close")?.click();
    await sleep(20);
    const names = panel.querySelectorAll(".neo-recipes-card-name");
    names[1].click();
    await sleep(80);
    meta = document.querySelector(".neo-recipes-detail-meta");
    assert.equal(meta.textContent, "2 段 · 混合模式 · 技能 A、技能 B · 768×1344 · 总时长 8.5s", "混合模式概览行内容");
});

test("配方卡片：多段导演配方正文显示摘要行（代替无提示词）", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "sk-a", name: "技能 A", gen_video: true },
    ]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        {
            name: "dir-card", type: "video_director", source: "custom", prompt: "", assets: [], samples: [],
            shared: { width: 960, height: 544, mode: "i2v" },
            segments: [
                { skill_id: "sk-a", prompt: "p1", duration_sec: 5 },
                { skill_id: "sk-a", prompt: "p2", duration_sec: 5 },
            ],
        },
    ]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    const meta = panel.querySelector(".neo-recipes-card-summary");
    assert.equal(meta.textContent, "2 段 · 关键帧生视频 · 技能 A ×2 · 960×544 · 总时长 10s", "多段导演卡片摘要行（折叠区）显示概览（旧 i2v 显示为 f2v）");
});


// ---- 配方结果（results）：执行产物路径的查看与删除 ----

function resultRecipe(over = {}) {
    return {
        name: "res-recipe", type: "video_director", source: "custom", prompt: "", assets: [], samples: [],
        result_count: 1,
        results: [{ filename: "shot_00001.mp4", subfolder: "", kind: "video", at: "2026-01-01 00:00:00" }],
        ...over,
    };
}

test("配方详情：结果区按 output 路径渲染，点击打开 Lightbox，卡片显示结果数", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([resultRecipe()]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    assert.match(panel.querySelector(".neo-recipes-card-chips").textContent, /1 个结果/, "卡片 chips 带结果数");

    panel.querySelector(".neo-recipes-card-name").click();
    await sleep(60);
    const sections = [...document.querySelectorAll(".neo-recipes-detail-section")].map(e => e.textContent);
    assert.ok(sections.includes("结果（1）"), `详情有结果区：${sections.join(",")}`);

    const item = document.querySelector(".neo-recipes-result-del").closest(".neo-recipes-detail-asset");
    const video = item.querySelector("video");
    assert.ok(video, "视频结果用 video 缩略图");
    assert.equal(video.getAttribute("src"), "/view?filename=shot_00001.mp4&subfolder=&type=output", "走 ComfyUI 原生 /view 读 output 文件");
    assert.match(item.querySelector(".neo-recipes-detail-file").textContent, /shot_00001\.mp4/);
    assert.match(document.querySelector(".neo-recipes-result-del").title, /output/, "删除按钮说明会删磁盘文件");

    item.click();
    await sleep(60);
    assert.ok(document.querySelector(".neo-lightbox"), "点击结果打开 Lightbox");
    document.querySelector(".neo-lightbox-close")?.click();
});

test("配方详情：删除结果先 confirm；取消不删，确认后调 delete_result 并刷新", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    let recipes = [resultRecipe()];
    mockRoute("/rs_recipes/list", () => jsonResponse(recipes));
    let deleted = null;
    mockRoute("/rs_recipes/delete_result", (body) => {
        deleted = body;
        recipes = [resultRecipe({ results: [], result_count: 0 })];
        return jsonResponse({ success: true, deleted: true });
    });

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    panel.querySelector(".neo-recipes-card-name").click();
    await sleep(60);

    setConfirmAnswer(false); // 取消
    document.querySelector(".neo-recipes-result-del").click();
    await sleep(40);
    assert.equal(deleted, null, "取消确认不得调用删除接口");
    assert.equal(dialogs.confirms.length, 1);
    assert.match(dialogs.confirms[0], /shot_00001\.mp4/, "确认文案带文件名");
    assert.ok(document.querySelector(".neo-recipes-result-del"), "条目仍在");

    setConfirmAnswer(true); // 确认
    document.querySelector(".neo-recipes-result-del").click();
    await sleep(100);
    assert.deepEqual(deleted, { name: "res-recipe", filename: "shot_00001.mp4", subfolder: "", kind: "video" },
        "传配方名 + 路径 + 类型");
    assert.equal(document.querySelectorAll(".neo-recipes-result-del").length, 0, "删除后详情重渲染，结果区消失");
});




test("详情浮层：Esc 关闭并移除 overlay", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([recipeFixture()]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    panel.querySelector(".neo-recipes-card-name").click();
    await sleep(60);
    assert.ok(document.querySelector(".neo-recipes-detail"), "详情已打开");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await sleep(30);
    assert.equal(document.querySelector(".neo-recipes-detail"), null, "Esc 关闭详情浮层");
});

test("thumbUrl：生成 /rs_recipes/thumbnail 查询串（dir 可选）", async () => {
    const { thumbUrl } = await import("../../web/recipes.js");
    assert.match(thumbUrl("my recipe", "a b.png", "", 112),
        /\/rs_recipes\/thumbnail\?recipe=my%20recipe&file=a%20b\.png&size=112$/,
        "无 dir 时不带 dir 参数");
    assert.match(thumbUrl("r", "f.jpg", "samples", 256),
        /\/rs_recipes\/thumbnail\?recipe=r&file=f\.jpg&size=256&dir=samples$/,
        "有 dir 时追加 dir 参数");
});

test("卡片封面：图片走缩略图 URL，懒加载；无资源时占位符", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        recipeFixture({ cover: "cover.png" }),
        recipeFixture({ name: "no-asset", assets: [], samples: [], cover: null }),
    ]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    const covers = [...panel.querySelectorAll(".neo-recipes-card-media")];
    const img = covers[0].querySelector("img");
    assert.match(img.src, /\/rs_recipes\/thumbnail\?recipe=[^&]*&file=cover\.png&size=256/, "封面用 256px 缩略图");
    assert.equal(img.getAttribute("loading"), "lazy", "封面懒加载");
    assert.ok(covers[1].querySelector(".neo-recipes-card-no-cover"), "无资源配方显示占位符");
});


test("卡片媒体区：导演配方显示各段首帧网格，普通配方多图示例", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        {
            name: "dir-frames", type: "video_director", source: "custom", prompt: "", assets: [], samples: [],
            segments: [
                { skill_id: "s", first_frame: "f1.png" },
                { skill_id: "s", first_frame: "f2.png" },
                { skill_id: "s", first_frame: "f3.png" },
            ],
        },
        {
            name: "multi-sample", source: "custom", prompt: "", cover: null, assets: [],
            samples: [{ kind: "image", file: "s1.png" }, { kind: "image", file: "s2.png" }],
        },
    ]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    const medias = [...panel.querySelectorAll(".neo-recipes-card-media")];
    assert.equal(medias[0].querySelectorAll("img").length, 3, "导演配方显示 3 张首帧");
    assert.match(medias[0].querySelector("img").src, /file=f1\.png&size=192/, "首帧用 192px 缩略图");
    assert.equal(medias[1].querySelectorAll("img").length, 2, "多图示例显示 2 张");
    assert.ok(!medias[1].classList.contains("single"), "多图不套用单张横幅样式");
});

test("卡片按钮：主操作直接展示，其余收进 ⋯ 更多菜单", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        { name: "normal-custom", source: "custom", prompt: "hello", assets: [], samples: [] },
    ]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    const card = panel.querySelector(".neo-recipes-card");
    assert.ok(card.querySelector(".neo-recipes-send"), "发送为直接按钮");
    assert.ok(card.querySelector(".neo-recipes-copy"), "复制为直接按钮");
    const directBtns = [...card.querySelectorAll(".neo-recipes-card-actions > button")];
    assert.equal(directBtns.length, 2, "仅 2 个直接按钮 + ⋯");
    const moreBtn = card.querySelector(".neo-recipes-more");
    assert.ok(moreBtn, "有 ⋯ 更多按钮");
    moreBtn.click();
    await sleep(20);
    const menu = card.querySelector(".neo-recipes-more-menu");
    assert.ok(menu.classList.contains("open"), "点击 ⋯ 展开菜单");
    const items = [...menu.querySelectorAll(".neo-recipes-more-item")].map(e => e.textContent);
    assert.ok(items.some(t => t.includes("追加")), "菜单含「追加」");
    assert.ok(items.some(t => t.includes("导出")), "菜单含「导出」");
    assert.ok(items.some(t => t.includes("删除")), "菜单含「删除」");
});


test("工具条：搜索/筛选/排序即时生效并持久化到 prefs", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    let savedPrefs = null;
    mockRoute("/userdata/neo_recipes_data.json", (body, call) => {
        if (call.method === "POST") savedPrefs = body;
        return jsonResponse({ recipes_prefs: null });
    });
    const recipes = [
        recipeFixture({ name: "alpha 普通" }),
        recipeFixture({ name: "beta 导演", type: "video_director", segments: [{ desc: "海浪" }] }),
        recipeFixture({ name: "gamma 预设", source: "preset" }),
    ];
    mockRoute("/rs_recipes/list", () => jsonResponse(recipes));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    const cardNames = () => [...panel.querySelectorAll(".neo-recipes-card-name")].map(e => e.querySelector("span").textContent);
    const chip = (label) => [...panel.querySelectorAll(".neo-recipes-tools .neo-recipes-chip")].find(e => e.textContent === label);
    assert.deepEqual(cardNames(), ["alpha 普通", "beta 导演", "gamma 预设"], "默认全部显示");

    // 筛选：仅多段
    chip("多段").click();
    await sleep(30);
    assert.deepEqual(cardNames(), ["beta 导演"], "筛选「多段」只显示导演配方");

    // 搜索（恢复全部后按名称过滤）
    chip("全部").click();
    await sleep(30);
    const search = panel.querySelector(".neo-recipes-search");
    search.value = "alpha";
    search.dispatchEvent(new Event("input"));
    await sleep(260);   // 搜索防抖 200ms
    assert.deepEqual(cardNames(), ["alpha 普通"], "搜索按名称过滤");

    // 排序：名称升序（清空搜索）
    search.value = "";
    search.dispatchEvent(new Event("input"));
    await sleep(260);
    const sortSel = panel.querySelector(".neo-recipes-sort");
    sortSel.value = "name";
    sortSel.dispatchEvent(new Event("change"));
    await sleep(30);
    assert.deepEqual(cardNames(), ["alpha 普通", "beta 导演", "gamma 预设"], "按名称排序（组内升序）");

    // prefs 已防抖持久化
    await sleep(360);
    assert.ok(savedPrefs?.recipes_prefs, "prefs 已保存");
    assert.equal(savedPrefs.recipes_prefs.sort, "name", "排序选择已持久化");
});

test("分组标题：点击折叠/展开，折叠时隐藏该组卡片", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([
        recipeFixture({ name: "a" }),
        recipeFixture({ name: "b 预设", source: "preset" }),
    ]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    assert.equal(panel.querySelectorAll(".neo-recipes-card").length, 2, "两组都展开");

    const myTitle = [...panel.querySelectorAll(".neo-recipes-group-title")].find(e => e.textContent.includes("我的配方"));
    myTitle.click();
    await sleep(30);
    assert.match(myTitle.textContent, /▸/, "折叠后显示 ▸");
    assert.equal(panel.querySelectorAll(".neo-recipes-card").length, 1, "折叠「我的配方」后只剩预设组卡片");

    myTitle.click();
    await sleep(30);
    assert.equal(panel.querySelectorAll(".neo-recipes-card").length, 2, "再次点击展开");
});

test("getRecipesPanel：单例复用同一 DOM，重复调用触发刷新", async () => {
    const { getRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    let listCalls = 0;
    mockRoute("/rs_recipes/list", () => { listCalls++; return jsonResponse([recipeFixture()]); });

    const p1 = await getRecipesPanel();
    const p2 = await getRecipesPanel();
    assert.equal(p1, p2, "两次调用返回同一面板元素");
    assert.ok(listCalls >= 2, "重复调用触发列表刷新");
});

test("详情浮层：底部有「复制提示词」按钮，无提示词时禁用", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([recipeFixture({ prompt: "" })]));

    const panel = await createRecipesPanel();
    document.body.appendChild(panel);
    panel.querySelector(".neo-recipes-card-name").click();
    await sleep(60);
    const copyBtn = document.querySelector(".neo-recipes-detail-copy");
    assert.ok(copyBtn, "详情底部有复制提示词按钮");
    assert.equal(copyBtn.disabled, true, "无提示词时禁用");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
});

// ====== selectable 模式（Studio 导演页：点卡片选中并回传 onSelect，直接喂整片生成区） ======
function directorRecipe(name) {
    return { name, type: "video_director", source: "custom", prompt: "", assets: [], samples: [], results: [] };
}

test("配方面板：selectable 点卡片选中并回传 onSelect，高亮对应卡片（不打开详情/编辑器）", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([directorRecipe("dir-a"), directorRecipe("dir-b")]));

    const selected = [];
    const panel = await createRecipesPanel({ directorOnly: true, onSelect: (r) => selected.push(r.name) });
    document.body.appendChild(panel);
    await sleep(80);

    const cards = [...panel.querySelectorAll(".neo-recipes-card")];
    assert.equal(cards.length, 2, "两个导演配方卡片");
    cards[1].click();
    await sleep(30);
    assert.deepEqual(selected, ["dir-b"], "onSelect 收到被点配方");
    assert.ok(cards[1].classList.contains("neo-recipes-card-selected"), "被点卡片高亮");
    assert.ok(!cards[0].classList.contains("neo-recipes-card-selected"), "其它卡片不高亮");
    assert.equal(document.querySelector(".neo-recipes-detail"), null, "选中不打开详情浮层");
    assert.equal(document.querySelector(".neo-director-overlay"), null, "选中不打开编辑器");
});

test("配方面板：autoSelectFirst 首次加载自动选中首个配方", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([directorRecipe("dir-a"), directorRecipe("dir-b")]));

    const selected = [];
    const panel = await createRecipesPanel({ directorOnly: true, autoSelectFirst: true, onSelect: (r) => selected.push(r.name) });
    document.body.appendChild(panel);
    await sleep(80);

    assert.deepEqual(selected, ["dir-a"], "自动选中首个配方");
    assert.ok(panel.querySelector(".neo-recipes-card").classList.contains("neo-recipes-card-selected"), "首个卡片高亮");
});

test("配方面板：initialSelection 只恢复高亮，不重放 onSelect（弹窗开着刷新不能被选中关掉）", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([directorRecipe("dir-a"), directorRecipe("dir-b")]));

    const selected = [];
    const panel = await createRecipesPanel({ directorOnly: true, autoSelectFirst: true, initialSelection: "dir-b", onSelect: (r) => selected.push(r.name) });
    document.body.appendChild(panel);
    await sleep(80);

    assert.deepEqual(selected, [], "宿主已选中这份就不重放 onSelect");
    const cards = [...panel.querySelectorAll(".neo-recipes-card")];
    assert.ok(cards[1].classList.contains("neo-recipes-card-selected"), "dir-b 高亮");
});

test("配方面板：selectable 卡片带「详情」按钮，点它打开详情浮层（不触发选中回传）", async () => {
    const { createRecipesPanel } = await import("../../web/recipes.js");
    appState.graph = { _nodes: [] };
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));
    mockRoute("/rs_recipes/list", () => jsonResponse([directorRecipe("dir-a")]));

    const selected = [];
    const panel = await createRecipesPanel({ directorOnly: true, onSelect: (r) => selected.push(r.name) });
    document.body.appendChild(panel);
    await sleep(80);

    const detailBtn = panel.querySelector(".neo-recipes-detail-open");
    assert.ok(detailBtn, "selectable 卡片有「详情」按钮");
    detailBtn.click();
    await sleep(60);
    assert.ok(document.querySelector(".neo-recipes-detail"), "点详情按钮打开详情浮层");
    assert.deepEqual(selected, [], "点详情按钮不触发选中回传");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
});