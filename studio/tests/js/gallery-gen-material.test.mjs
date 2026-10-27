// 画廊搜索行「生成素材」：纯提示词一键生成新素材，默认 Krea2 文生图（image_gen），
// 成功后可打开 Output 下实际落盘的日期子目录。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, sseResponse, fetchLog, sleep, click, keydown, inputText, changeValue, fire } from "./setup.mjs";
import { dispatchApiEvent } from "./mocks/comfy-api.mjs";
import { app, resetSidebarTab } from "./mocks/comfy-app.mjs";

test("生成素材弹窗：默认 Krea2 文生图，成功后可打开输出目录", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    const dirCalls = [];
    resetSidebarTab();
    app.neoGallery = { showDirectoryStructure: (source, segs) => dirCalls.push([source, segs]) };

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
    ]));
    let genCount = 0;
    mockRoute("/neo_image_gen/generate", () => {
        genCount += 1;
        return jsonResponse({ task_id: "gm1", status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/gm1", () => jsonResponse({
        task_id: "gm1", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "krea2_00001_.png", subfolder: "NeoAgent/2026-10-01", url: "/g.png" }],
    }));

    openGenMaterialDialog({ deleteItem: () => Promise.resolve(true) });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    assert.ok(overlay, "应弹出生成素材弹窗");

    await sleep(50);
    // 技能下拉列吃文字输入的技能（两栖的 Qwen 也在列），默认 Krea2 文生图
    const skillSel = overlay.querySelector(".neo-recipes-sort");
    assert.ok(skillSel, "应有技能下拉");
    assert.equal([...skillSel.options].map(o => o.value).join(","), "image_gen,qwen_image_21", "文生图页列吃文字的技能，两栖技能也在列");
    assert.equal(skillSel.value, "image_gen", "默认选中 Krea2 文生图");

    // idle：有「生成」按钮，且尚未发请求
    const btns = () => [...overlay.querySelectorAll(".neo-gallery-story-btn")].map(b => b.textContent);
    assert.ok(btns().includes("生成"), "idle 应有「生成」按钮");
    assert.equal(fetchLog.filter(c => c.path === "/neo_image_gen/generate").length, 0);

    inputText(overlay.querySelector(".neo-gallery-story-input"), "红色陶瓷杯的白底产品图");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(80);

    // 请求体：skill_id=image_gen、skip_enhance=true，不带参考图
    const genReq = fetchLog.filter(c => c.path === "/neo_image_gen/generate").at(-1);
    assert.equal(genReq?.body.skill_id, "image_gen");
    assert.equal(genReq?.body.skip_enhance, true);
    assert.ok(!genReq?.body.references, "纯文生图不应带参考图");

    // 成功：结果预览 + 「打开输出目录 / 再生成 / 关闭」
    const resultImg = overlay.querySelector(".neo-gallery-cs-result-img");
    assert.match(resultImg?.getAttribute("src") || "", /\/neo_gallery\/thumbnail\?filename=krea2_00001_\.png/);
    assert.ok(btns().includes("打开输出目录"), "成功后应有「打开输出目录」按钮");
    assert.ok(btns().includes("再生成"), "成功后应保留「再生成」按钮");

    // 点「打开输出目录」→ 打开左侧素材栏并跳到 Output/NeoAgent/<日期>，窗口保持打开
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "打开输出目录"));
    assert.equal(app.extensionManager.sidebarTab.activeSidebarTabId, "neo.gallery", "打开左侧素材面板");
    assert.deepEqual(dirCalls, [["Output", ["NeoAgent", "2026-10-01"]]]);
    assert.equal(document.querySelector(".neo-gallery-gm-modal-overlay"), overlay, "打开输出目录后窗口不关闭");
    assert.equal(genCount, 1);
    delete app.neoGallery;
});

test("生成素材弹窗：生成中显示预览区与进度条，成功后结果图原位替换", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "gm2", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/gm2", () => jsonResponse({
        task_id: "gm2", status: "running", progress: { value: 3, max: 10 }, images: [],
    }));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    inputText(overlay.querySelector(".neo-gallery-story-input"), "海边灯塔");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(50);

    // 生成中：预览区（spinner + 进度条 30%）
    const preview = overlay.querySelector(".neo-gallery-gm-preview");
    assert.ok(preview, "生成中应有预览区");
    assert.equal(preview.querySelector(".neo-gallery-cs-progress-fill")?.style.width, "30%", "进度条按 progress.value/max 填充");

    // 实时预览推送：预览图替换 spinner（与节点预览同源）
    const previewUrl = "data:image/jpeg;base64,QUJDREVG";
    dispatchApiEvent("rs.image_gen.status", {
        task_id: "gm2", status: "running", progress: { value: 5, max: 10 }, preview: previewUrl,
    });
    await sleep(20);
    const liveImg = overlay.querySelector(".neo-gallery-gm-preview-img");
    assert.ok(liveImg, "生成中拿到实时预览图应在预览区显示");
    assert.equal(liveImg.getAttribute("src"), previewUrl);
    assert.equal(preview.querySelector(".neo-gallery-cs-progress-fill")?.style.width, "50%");

    // 派发终态：结果图原位替换预览区（同一容器变为 .neo-gallery-cs-result）
    dispatchApiEvent("rs.image_gen.status", {
        task_id: "gm2", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "krea2_00002_.png", subfolder: "NeoAgent/2026-10-01", url: "/g.png" }],
    });
    await sleep(20);
    const resultBox = overlay.querySelector(".neo-gallery-cs-result");
    assert.ok(resultBox, "成功后预览区应原位替换为结果区");
    assert.match(resultBox.querySelector("img")?.getAttribute("src") || "", /krea2_00002_\.png/, "结果图显示在预览区原位置");
});

test("生成素材弹窗：提示词为空时不发请求", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    mockRoute("/rs_prompts/skills", () => jsonResponse([]));

    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(50);
    assert.equal(fetchLog.filter(c => c.path === "/neo_image_gen/generate").length, 0, "空提示词不应发请求");
});

test("生成素材弹窗：自定参数——自动不带覆盖，选主模型+LoRA 后请求体带上", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: ["krea2.safetensors", "qwen_image_2.1.safetensors"],
        text_encoders: ["qwen3vl_4b.safetensors"],
        vae: ["qwen_image_vae.safetensors"],
        loras: ["style_a.safetensors"],
        suggested_diffusion_models: "krea2.safetensors",
    }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "gm3", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/gm3", () => jsonResponse({
        task_id: "gm3", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "krea2_00003_.png", subfolder: "NeoAgent/2026-10-01", url: "/g.png" }],
    }));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50); // 等模型列表填充

    // 默认折叠；展开后显示自定参数区（主模型下拉预填「自动」= 跟随设置）
    const toggle = overlay.querySelector(".neo-gallery-gm-model-toggle");
    assert.ok(toggle, "应有「自定参数」折叠行");
    click(toggle);
    const modelBox = overlay.querySelector(".neo-gallery-gm-model-box");
    assert.notEqual(modelBox.style.display, "none", "点击后应展开");
    const modelSel = overlay.querySelector(".rs-gen-model-section select");
    assert.ok(modelSel, "展开后应有主模型下拉");
    assert.equal(overlay.querySelectorAll(".rs-gen-model-section .rs-gen-adv-row").length, 0, "覆盖区只露出生图模型与 LoRA（无 TE / VAE 行）");
    assert.equal(modelSel.value, "", "默认「自动」（跟随设置），不预填");
    assert.equal(overlay.querySelectorAll(".rs-gen-lora-row").length, 0, "默认无 LoRA 行");

    // 自动态：请求体不带 model / loras 覆盖（不冲掉全局设置）
    inputText(overlay.querySelector(".neo-gallery-story-input"), "海边灯塔");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(80);
    let req = fetchLog.filter(c => c.path === "/neo_image_gen/generate").at(-1);
    assert.ok(!("model" in (req.body || {})), "自动态请求体不应带 model 覆盖");
    assert.ok(!("loras" in (req.body || {})), "自动态请求体不应带 loras 覆盖");

    // 选主模型 + 加一条 LoRA（强度 0.8）→「再生成」请求体带上覆盖
    modelSel.value = "qwen_image_2.1.safetensors";
    click(overlay.querySelector(".rs-gen-lora-add"));
    const loraRow = overlay.querySelector(".rs-gen-lora-row");
    assert.ok(loraRow, "应有 LoRA 行");
    loraRow.querySelector("select").value = "style_a.safetensors";
    loraRow.querySelector(".rs-gen-lora-strength").value = "0.8";
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "再生成"));
    await sleep(80);
    req = fetchLog.filter(c => c.path === "/neo_image_gen/generate").at(-1);
    assert.equal(req.body.model, "qwen_image_2.1.safetensors", "请求体应带所选主模型");
    assert.deepEqual(req.body.loras, [{ name: "style_a.safetensors", strength: 0.8 }], "请求体应带所选 LoRA 与强度");

    // 关窗重开：覆盖清除，回到「自动」且无 LoRA 行
    click(overlay.querySelector(".neo-gallery-story-close"));
    assert.equal(document.querySelector(".neo-gallery-gm-modal-overlay"), null, "关闭后弹窗应移除");
    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay2 = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50); // 等模型列表填充
    click(overlay2.querySelector(".neo-gallery-gm-model-toggle"));
    assert.equal(overlay2.querySelector(".rs-gen-model-section select").value, "", "重开后主模型回到「自动」");
    assert.equal(overlay2.querySelectorAll(".rs-gen-lora-row").length, 0, "重开后无 LoRA 行");
});

test("生成素材弹窗：自定参数——宽高比与最长边可选并写入请求体", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: ["krea2.safetensors"],
        text_encoders: ["qwen3vl_4b.safetensors"],
        vae: ["qwen_image_vae.safetensors"],
        loras: [],
    }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "gm_ratio", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/gm_ratio", () => jsonResponse({
        task_id: "gm_ratio", status: "succeeded", width: 1344, height: 768,
        images: [{ filename: "krea2_r_.png", subfolder: "NeoAgent/2026-10-01", url: "/r.png" }],
    }));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);

    // 展开自定参数区，验证比例与最长边下拉存在（同行）
    click(overlay.querySelector(".neo-gallery-gm-model-toggle"));
    const sizeRow = overlay.querySelector(".neo-gallery-gm-size-row");
    const [ratioSel, edgeSel] = sizeRow.querySelectorAll("select");
    assert.ok(ratioSel, "应有「宽高比」片");
    assert.ok(edgeSel, "应有「最长边」片");

    assert.equal(ratioSel.value, "", "默认态为空（跟随设置）");
    assert.equal(edgeSel.value, "", "默认态为空（跟随设置）");
    // 比例选项与导演编辑页同源：值纯比例、显示带中文备注
    const ratioTexts = [...ratioSel.options].map(o => o.textContent);
    assert.ok(ratioTexts.includes("1:1 (方形)"), "比例选项应带中文备注");
    assert.ok(ratioTexts.includes("16:9 (宽屏)"), "比例选项应带中文备注");

    // 默认态：请求体不带 ratio / edge 覆盖
    inputText(overlay.querySelector(".neo-gallery-story-input"), "测试图");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(80);
    let req = fetchLog.filter(c => c.path === "/neo_image_gen/generate").at(-1);
    assert.ok(!("default_ratio" in (req.body || {})), "默认态不应带 default_ratio");
    assert.ok(!("base_resolution" in (req.body || {})), "默认态不应带 base_resolution");

    // 选择 16:9 + 2048 → 请求体带上覆盖
    ratioSel.value = "16:9";
    edgeSel.value = "2048";
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "再生成"));
    await sleep(80);
    req = fetchLog.filter(c => c.path === "/neo_image_gen/generate").at(-1);
    assert.equal(req.body.default_ratio, "16:9", "请求体应带所选比例");
    assert.equal(req.body.base_resolution, 2048, "请求体应带所选最长边");
});

test("生成素材弹窗：切换生成技能后自定参数同步为该技能配置的主模型 / LoRA / 比例 / 最长边", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
        { id: "qwen_t2i", cn_name: "Qwen 文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: ["krea2.safetensors", "qwen_image_2.1.safetensors"],
        loras: ["style_a.safetensors", "style_b.safetensors"],
    }));
    mockRoute("/neo_image_gen/skill_config", (b, call) => jsonResponse(
        call.query.get("skill_id") === "qwen_t2i"
            ? { model: "qwen_image_2.1.safetensors", loras: [{ name: "style_b.safetensors", strength: 0.6 }], default_ratio: "16:9", base_resolution: 2048 }
            : {}));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50); // 等模型列表与技能配置应用

    click(overlay.querySelector(".neo-gallery-gm-model-toggle"));
    const modelSel = overlay.querySelector(".rs-gen-model-section select");
    assert.equal(modelSel.value, "", "默认技能无配置 → 自动");
    assert.equal(overlay.querySelectorAll(".rs-gen-lora-row").length, 0);

    // 切到 Qwen 文生图 → 覆盖同步为其配置的主模型 + LoRA + 比例 + 最长边
    const skillSel = overlay.querySelector(".neo-recipes-sort");
    changeValue(skillSel, "qwen_t2i");
    await sleep(30);
    assert.equal(modelSel.value, "qwen_image_2.1.safetensors", "主模型同步为技能配置");
    const loraRow = overlay.querySelector(".rs-gen-lora-row");
    assert.ok(loraRow, "应出现技能配置的 LoRA 行");
    assert.equal(loraRow.querySelector("select").value, "style_b.safetensors");
    assert.equal(loraRow.querySelector(".rs-gen-lora-strength").value, "0.6");
    const sizeRow = overlay.querySelector(".neo-gallery-gm-size-row");
    const [ratioSel, edgeSel] = sizeRow.querySelectorAll("select");
    assert.equal(ratioSel.value, "16:9", "比例同步为技能配置");
    assert.equal(edgeSel.value, "2048", "最长边同步为技能配置");
    assert.equal(ratioSel.options[0].textContent, "默认 (16:9 宽屏)", "「默认」选项显示技能配置的比例（带备注）");
    assert.equal(edgeSel.options[0].textContent, "默认 (2048)", "「默认」选项显示技能配置的最长边");

    // 切回 → 覆盖回到自动
    changeValue(skillSel, "image_gen");
    await sleep(30);
    assert.equal(modelSel.value, "", "切回后回到自动");
    assert.equal(overlay.querySelectorAll(".rs-gen-lora-row").length, 0);
    assert.equal(ratioSel.value, "", "切回后比例回到默认");
    assert.equal(edgeSel.value, "", "切回后最长边回到默认");
    assert.equal(ratioSel.options[0].textContent, "默认", "无配置时「默认」选项不带值");
    assert.equal(edgeSel.options[0].textContent, "默认");
});

test("生成素材弹窗：成功后可删除结果图并回到 idle", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    const deletedCalls = [];
    const gallery = {
        showDirectoryStructure: () => {},
        deleteItem: async (name, sub) => { deletedCalls.push([name, sub]); return true; },
    };

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "gm5", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/gm5", () => jsonResponse({
        task_id: "gm5", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "krea2_00009_.png", subfolder: "NeoAgent/2026-10-01", url: "/g.png" }],
    }));

    openGenMaterialDialog(gallery);
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    inputText(overlay.querySelector(".neo-gallery-story-input"), "红色陶瓷杯的白底产品图");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(80);

    const btns = () => [...overlay.querySelectorAll(".neo-gallery-story-btn")].map(b => b.textContent);
    assert.ok(btns().includes("删除"), "成功后应有「删除」按钮");

    // 点「删除」→ 按落盘 filename/subfolder 调 deleteItem，删完回 idle（结果图清除、可再生成）
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "删除"));
    await sleep(30);
    assert.deepEqual(deletedCalls, [["krea2_00009_.png", "NeoAgent/2026-10-01"]], "deleteItem 应带落盘文件名与子目录");
    assert.ok(btns().includes("生成"), "删除后应回到 idle，可继续生成");
    assert.equal(overlay.querySelector(".neo-gallery-cs-result-img"), null, "删除后结果图应清除");
});

test("生成素材弹窗：记住上次选中的技能（关窗不清除）", async () => {
    resetEnv();
    clearRoutes();
    localStorage.clear();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
        { id: "flux_t2i", cn_name: "Flux 文生图", category: "image_gen", gen_image: true },
    ]));

    // 首次打开：无记忆 → 默认 Krea2 文生图
    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    let overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);
    const skillSel = overlay.querySelector(".neo-recipes-sort");
    assert.equal(skillSel.value, "image_gen", "无记忆时默认 Krea2 文生图");

    // 切到 Flux 并关窗 → 重开：记住 Flux
    changeValue(skillSel, "flux_t2i");
    overlay.remove();
    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);
    assert.equal(overlay.querySelector(".neo-recipes-sort").value, "flux_t2i", "重开后应记住上次选中的技能");

    // 记住的技能已不在列表 → 回 Krea2 默认
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    overlay.remove();
    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);
    assert.equal(overlay.querySelector(".neo-recipes-sort").value, "image_gen", "记住的技能失效时回 Krea2 文生图");
    localStorage.clear();
});

test("生成素材弹窗：选中的主模型+LoRA 组合可保存为新技能", async () => {
    resetEnv();
    clearRoutes();
    localStorage.clear();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
        { id: "qwen_image_21_style_a", cn_name: "qwen_image_2.1-style_a", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: ["krea2.safetensors", "qwen_image_2.1.safetensors"],
        text_encoders: ["qwen3vl_4b.safetensors"],
        vae: ["qwen_image_vae.safetensors"],
        loras: ["style_a.safetensors"],
    }));
    // 新技能的 config.json = 保存的组合（与后端 save_combo_as_skill 一致），切到它后覆盖区重放不变
    mockRoute("/neo_image_gen/skill_config", (b, call) => jsonResponse(
        call.query.get("skill_id") === "qwen_image_21_style_a"
            ? { model: "qwen_image_2.1.safetensors", loras: [{ name: "style_a.safetensors", strength: 0.8 }] }
            : {}));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50); // 等模型列表填充

    click(overlay.querySelector(".neo-gallery-gm-model-toggle"));
    const saveBtn = overlay.querySelector(".neo-gallery-gm-save-skill");
    assert.ok(saveBtn, "应有「保存为新技能」按钮");
    assert.equal(saveBtn.style.display, "none", "未选主模型 / LoRA 时保存按钮应隐藏");

    // 选主模型 + LoRA → 保存按钮出现
    const modelSel = overlay.querySelector(".rs-gen-model-section select");
    changeValue(modelSel, "qwen_image_2.1.safetensors");
    click(overlay.querySelector(".rs-gen-lora-add"));
    const loraRow = overlay.querySelector(".rs-gen-lora-row");
    changeValue(loraRow.querySelector("select"), "style_a.safetensors");
    loraRow.querySelector(".rs-gen-lora-strength").value = "0.8";
    assert.notEqual(saveBtn.style.display, "none", "选中主模型 + LoRA 后保存按钮应出现");

    // 选宽高比 + 最长边 → 一并写入保存请求体
    const sizeRow = overlay.querySelector(".neo-gallery-gm-size-row");
    const [ratioSel, edgeSel] = sizeRow.querySelectorAll("select");
    ratioSel.value = "16:9";
    edgeSel.value = "2048";

    // 点保存 → 请求体带当前技能 + 主模型 + LoRA + 比例 + 最长边；成功后下拉选中新技能并记住
    mockRoute("/neo_image_gen/save_combo_skill", () => jsonResponse({
        success: true, id: "qwen_image_21_style_a", name: "qwen_image_2.1-style_a",
    }));
    click(saveBtn);
    await sleep(50);
    const saveReq = fetchLog.filter(c => c.path === "/neo_image_gen/save_combo_skill").at(-1);
    assert.equal(saveReq?.body.skill_id, "image_gen", "请求体应带当前技能");
    assert.equal(saveReq?.body.model, "qwen_image_2.1.safetensors");
    assert.deepEqual(saveReq?.body.loras, [{ name: "style_a.safetensors", strength: 0.8 }]);
    assert.equal(saveReq?.body.ratio, "16:9", "请求体应带所选宽高比");
    assert.equal(saveReq?.body.edge, "2048", "请求体应带所选最长边");

    const skillSel = overlay.querySelector(".neo-recipes-sort");
    assert.ok([...skillSel.options].some(o => o.value === "qwen_image_21_style_a"), "新技能应出现在下拉里");
    assert.equal(skillSel.value, "qwen_image_21_style_a", "保存后下拉应选中新技能");
    assert.equal(localStorage.getItem("neo.gallery.gen_material.skill"), "qwen_image_21_style_a", "新技能应被记住");

    // 失败：后端 400 → 错误 toast，下拉选择不变
    mockRoute("/neo_image_gen/save_combo_skill", () => jsonResponse({ error: "请先选择主模型或 LoRA" }, 400));
    click(saveBtn);
    await sleep(50);
    const toasts = [...document.querySelectorAll(".neo-at")].map(t => t.textContent).join("|");
    assert.match(toasts, /保存为新技能失败/, "失败应弹错误 toast");
    assert.equal(skillSel.value, "qwen_image_21_style_a", "失败时下拉选择不变");
});

test("生成素材弹窗：增强仿 agent quick input + output，支持选择增强 skill", async () => {
    resetEnv();
    clearRoutes();
    localStorage.clear();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
        { id: "smart_prompt", cn_name: "智能提示词", category: "task" },
        { id: "general_enhance", cn_name: "通用增强", category: "image_enhance" },
    ]));
    let enhanceBody = null;
    let releaseContent;
    const contentGate = new Promise((r) => { releaseContent = r; });
    mockRoute("/rs_prompts/stream_generate_prompt", (b) => {
        enhanceBody = b;
        // 自定义 reader：thinking / status 帧送达后暂停正文，便于断言流中面板状态
        const enc = new TextEncoder();
        const lines = [
            'data: {"text":"分析主体……","kind":"thinking"}\n',
            'data: {"text":"生成中（按需读引用文件）…","kind":"status"}\n',
            'data: {"text":"红色陶瓷杯，","kind":"content"}\n',
            'data: {"text":"白底产品图，柔和布光。","kind":"content"}\n',
            "data: [DONE]\n",
        ];
        let i = 0;
        return {
            ok: true,
            status: 200,
            async json() { throw new Error("sse"); },
            async text() { return lines.join(""); },
            body: {
                getReader: () => ({
                    async read() {
                        if (i >= lines.length) return { done: true, value: undefined };
                        if (i === 2) await contentGate;
                        return { done: false, value: enc.encode(lines[i++]) };
                    },
                    releaseLock() {},
                })
            }
        };
    });

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50); // 等技能下拉填充

    // agent 式双框（chat 习惯）：output 在上 + quick input 在下；增强 skill 下拉只列图像增强类，顶部「默认」空选项
    const quickInput = overlay.querySelector(".neo-gallery-gm-quick-input");
    const outputInput = overlay.querySelector(".neo-gallery-story-input");
    const enhanceSel = overlay.querySelector(".neo-gallery-gm-enhance-skill");
    assert.ok(quickInput && outputInput, "应有 quick input 与 output 双框");
    const modalChildren = [...overlay.querySelector(".neo-gallery-story-modal").children];
    const outputWrap = overlay.querySelector(".neo-gallery-gm-output-wrap");
    const quickWrap = overlay.querySelector(".neo-gallery-gm-quick-wrap");
    assert.ok(modalChildren.indexOf(outputWrap) < modalChildren.indexOf(quickWrap), "output 框应在 quick input 上方（chat 习惯）");
    assert.equal([...enhanceSel.options].map(o => o.value).join(","), ",general_enhance", "增强下拉只列图像增强技能（顶部默认空选项，task / 生图类排除）");

    const enhanceBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "增强");
    assert.ok(enhanceBtn, "应有「增强」按钮");

    // llm-chat 式布局：增强下拉 + 集成在 quick input 内部底边工具栏；/▾/☰ 浮出在 output 框右下角
    const inputToolbar = overlay.querySelector(".neo-gallery-gm-input-toolbar");
    assert.ok(quickWrap && inputToolbar && quickWrap.contains(inputToolbar), "增强工具栏应在 quick input 包装内");
    assert.equal(inputToolbar.querySelector(".neo-gallery-gm-enhance-skill"), enhanceSel, "增强下拉应在工具栏内");
    assert.ok(inputToolbar.contains(enhanceBtn), "增强应在工具栏内");
    const floatGroup = overlay.querySelector(".neo-gallery-gm-float-group");
    assert.ok(outputWrap && outputWrap.contains(floatGroup), "浮出按钮组应在 output 框包装内");
    assert.equal(floatGroup.querySelectorAll(".neo-gallery-gm-tool-btn").length, 1, "浮出组只剩一枚 ⋯：随机填入 / 运行时随机 / 预设列表收进菜单");
    assert.equal(overlay.querySelector(".neo-gallery-gm-more-btn").textContent, "⋯", "⋯ 应带三点字形");
    assert.ok(overlay.querySelector(".neo-gallery-gm-more-menu .neo-gallery-gm-menu-item"), "⋯ 菜单里应有条目按钮");


    // 双框皆空：不发请求
    click(enhanceBtn);
    await sleep(20);
    assert.equal(fetchLog.filter(c => c.path === "/rs_prompts/stream_generate_prompt").length, 0, "双框皆空不应发请求");

    // quick input 有内容：请求体带 text + skillId（默认 = 空值，后端 smart_prompt 自动路由）
    inputText(quickInput, "红色陶瓷杯");
    click(enhanceBtn);
    await sleep(40); // thinking / status 帧送达且 rAF 已刷
    assert.ok(enhanceBody, "应调用 /rs_prompts/stream_generate_prompt");
    assert.equal(enhanceBody.text, "红色陶瓷杯");
    assert.equal(enhanceBody.skillId, "", "默认增强 skill 发空值（后端自动路由）");

    // 流中：思考面板 + 流程状态行显示在 output 上方（与节点输出框共用）
    const panels = [...overlay.querySelectorAll(".rs-thinking")];
    assert.equal(panels.length, 2, "流中应有思考面板与状态行两个面板");
    assert.match(panels[0].querySelector(".rs-thinking-body").textContent, /分析主体/, "思考面板应显示 reasoning_content");
    assert.match(panels[1].querySelector(".rs-thinking-body").textContent, /生成中/, "状态行应显示流程阶段");

    // 正文出现：思考面板清除、状态行保留到流结束，正文完整写入 output，quick input 保留不自动清空
    releaseContent();
    await sleep(80);
    const remain = [...overlay.querySelectorAll(".rs-thinking")];
    assert.equal(remain.length, 1, "正文出现后只剩状态行");
    assert.ok(!outputInput.value.includes("分析主体"), "thinking 不应写入 output");
    assert.ok(!outputInput.value.includes("生成中"), "status 不应写入 output");
    assert.equal(outputInput.value, "红色陶瓷杯，白底产品图，柔和布光。");
    assert.equal(quickInput.value, "红色陶瓷杯", "增强成功后 quick input 保留不自动清空");
    assert.equal(enhanceBtn.textContent, "增强", "完成后按钮应恢复");

    // 第二轮：output 已有提示词 + quick input 新指令 → 按 \n\n---\n\n 拼接（同节点）；所选增强 skill 随请求发出并被记住
    mockRoute("/rs_prompts/stream_generate_prompt", (b) => {
        enhanceBody = b;
        return sseResponse([
            'data: {"text":"红色陶瓷杯，白底产品图，柔和布光。改为写实风格。","kind":"content"}\n',
            "data: [DONE]\n",
        ]);
    });
    changeValue(enhanceSel, "general_enhance");
    inputText(quickInput, "改成写实风格");
    click(enhanceBtn);
    await sleep(80);
    assert.equal(enhanceBody.text, "红色陶瓷杯，白底产品图，柔和布光。\n\n---\n\n改成写实风格", "quick 新指令应与 output 已有提示词拼接");
    assert.equal(enhanceBody.skillId, "general_enhance", "skillId 取所选增强 skill");
    assert.equal(outputInput.value, "红色陶瓷杯，白底产品图，柔和布光。改为写实风格。");
    assert.equal(quickInput.value, "改成写实风格", "第二轮 quick input 同样保留");
    assert.equal(localStorage.getItem("neo.gallery.gen_material.enhance_skill"), "general_enhance", "增强 skill 选择应被记住");

    // 失败：错误 toast（带 LLM 设置入口），output 保持原文
    mockRoute("/rs_prompts/stream_generate_prompt", () => jsonResponse({ error: "LLM 未配置" }, 500));
    inputText(quickInput, "再改一次");
    click(enhanceBtn);
    await sleep(80);
    const toasts = [...document.querySelectorAll(".neo-at")].map(t => t.textContent).join("|");
    assert.match(toasts, /提示词增强失败/, "失败应弹错误 toast");
    assert.equal(outputInput.value, "红色陶瓷杯，白底产品图，柔和布光。改为写实风格。", "失败时 output 保持原文");
});

test("快捷输入命令终端式历史：↑/↓ 召回之前生成的提示词（去重），关窗后持久", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");
    localStorage.removeItem("neo.gallery.gen_material.quick_history");
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "krea2-t2i", name: "Krea2 文生图" },
        { id: "other-skill", name: "其他技能" },
    ]));
    let genCalls = 0;
    const okStatus = (id) => jsonResponse({ task_id: id, status: "succeeded", width: 512, height: 512, images: [{ filename: "out.png", subfolder: "NeoAgent/2026-10-01", url: "/g.png" }] });
    mockRoute("/neo_image_gen/generate", () => {
        genCalls += 1;
        return jsonResponse({ task_id: `t${genCalls}`, status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/t1", () => okStatus("t1"));
    mockRoute("/neo_image_gen/status/t2", () => okStatus("t2"));

    const g = { showDirectoryStructure: () => {} };
    openGenMaterialDialog(g);
    await sleep(50);
    const quick = document.querySelector(".neo-gallery-gm-quick-input");
    inputText(quick, "红色陶瓷杯白底产品图");
    click([...document.querySelectorAll(".neo-gallery-story-actions button")].find((b) => b.textContent === "生成"));
    await sleep(80);

    // 清空后 ↑ 召回最近一条；↓ 回原草稿（空）
    inputText(quick, "");
    keydown(quick, "ArrowUp");
    assert.equal(quick.value, "红色陶瓷杯白底产品图");
    keydown(quick, "ArrowDown");
    assert.equal(quick.value, "");

    // 召回后改写再生成：新条目进历史顶部（同一条目不重复入史）
    keydown(quick, "ArrowUp");
    inputText(quick, "蓝色玻璃杯棚拍光");
    const again = [...document.querySelectorAll(".neo-gallery-story-actions button")].find((b) => b.textContent === "再生成");
    click(again);
    await sleep(80);
    assert.equal(genCalls, 2);

    // ↑↑ 依次走过两条历史
    inputText(quick, "");
    keydown(quick, "ArrowUp");
    assert.equal(quick.value, "蓝色玻璃杯棚拍光");
    keydown(quick, "ArrowUp");
    assert.equal(quick.value, "红色陶瓷杯白底产品图");

    // 重开弹窗：历史持久（localStorage）
    openGenMaterialDialog(g);
    await sleep(50);
    const quick2 = document.querySelector(".neo-gallery-gm-quick-input");
    keydown(quick2, "ArrowUp");
    assert.equal(quick2.value, "蓝色玻璃杯棚拍光");

    localStorage.removeItem("neo.gallery.gen_material.quick_history");
    document.querySelector(".neo-gallery-gm-modal-overlay")?.remove();
});

test("快捷输入历史只记快捷输入：增强后入史的是快捷输入内容，不是增强的长文", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");
    localStorage.removeItem("neo.gallery.gen_material.quick_history");
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse([
        'data: {"text":"红色陶瓷杯，白底产品图，柔和布光，高清细节。","kind":"content"}\n',
        "data: [DONE]\n",
    ]));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);
    const quick = overlay.querySelector(".neo-gallery-gm-quick-input");
    const output = overlay.querySelector(".neo-gallery-story-input");

    inputText(quick, "红色陶瓷杯");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "增强"));
    await sleep(80);
    assert.equal(output.value, "红色陶瓷杯，白底产品图，柔和布光，高清细节。");
    assert.equal(quick.value, "红色陶瓷杯", "增强成功后 quick input 保留不自动清空");

    // ↑ 召回的是快捷输入内容（若误记了增强长文，这里会召回长文）
    keydown(quick, "ArrowUp");
    assert.equal(quick.value, "红色陶瓷杯", "历史里应是快捷输入内容，不是增强的长文");

    localStorage.removeItem("neo.gallery.gen_material.quick_history");
    document.querySelector(".neo-gallery-gm-modal-overlay")?.remove();
});

test("output 框独立历史：增强+生成后 ↑ 在 output 召回最终提示词，quick 框不受影响", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");
    localStorage.removeItem("neo.gallery.gen_material.quick_history");
    localStorage.removeItem("neo.gallery.gen_material.output_history");
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/rs_prompts/stream_generate_prompt", () => sseResponse([
        'data: {"text":"红色陶瓷杯，白底产品图，柔和布光，高清细节。","kind":"content"}\n',
        "data: [DONE]\n",
    ]));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "gmh1", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/gmh1", () => jsonResponse({
        task_id: "gmh1", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "krea2_00009_.png", subfolder: "NeoAgent/2026-10-01", url: "/g.png" }],
    }));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);
    const quick = overlay.querySelector(".neo-gallery-gm-quick-input");
    const output = overlay.querySelector(".neo-gallery-story-input");

    // 增强 → 用 output 的增强内容生成
    inputText(quick, "红色陶瓷杯");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "增强"));
    await sleep(80);
    const finalPrompt = "红色陶瓷杯，白底产品图，柔和布光，高清细节。";
    assert.equal(output.value, finalPrompt);
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(120);

    // ↑ 在 output 框召回最终提示词（增强长文）
    keydown(output, "ArrowUp");
    assert.equal(output.value, finalPrompt, "↑ 在 output 框应召回生成用过的最终提示词");

    // ↑ 在 quick 框不召回它（两份历史独立），快捷历史里只有快捷输入
    keydown(quick, "ArrowUp");
    assert.equal(quick.value, "红色陶瓷杯", "↑ 在 quick 框只召回快捷输入内容");

    const outHist = JSON.parse(localStorage.getItem("neo.gallery.gen_material.output_history"));
    const quickHist = JSON.parse(localStorage.getItem("neo.gallery.gen_material.quick_history"));
    assert.deepEqual(outHist, [finalPrompt], "output 历史独立存储最终提示词");
    assert.deepEqual(quickHist, ["红色陶瓷杯"], "快捷历史只含快捷输入内容");

    localStorage.removeItem("neo.gallery.gen_material.quick_history");
    localStorage.removeItem("neo.gallery.gen_material.output_history");
    document.querySelector(".neo-gallery-gm-modal-overlay")?.remove();
});

test("随机填入：从运行时混合池抽一条填入 output 框", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");
    localStorage.removeItem("neo.gallery.gen_material.runtime_random");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/rs_prompts/random_prompts", () => jsonResponse({ texts: ["混合池里的一条随机提示词"] }));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);

    click(overlay.querySelector(".neo-gallery-gm-more-btn"));
    click([...overlay.querySelectorAll(".neo-gallery-gm-menu-item")].find(b => b.textContent === "随机填入一条提示词"));
    await sleep(80);


    assert.equal(overlay.querySelector(".neo-gallery-story-input").value, "混合池里的一条随机提示词", "随机抽到的提示词应填入 output 框");
    const req = fetchLog.filter(c => c.path === "/rs_prompts/random_prompts").at(-1);
    assert.deepEqual(req?.body, { count: 1 }, "随机填入应向混合池请求 1 条");
    document.querySelector(".neo-gallery-gm-modal-overlay")?.remove();
});

test("运行时随机批量：启用后逐张生成 N 张，状态持久化到 localStorage", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");
    localStorage.removeItem("neo.gallery.gen_material.runtime_random");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/rs_prompts/random_prompts", () => jsonResponse({ texts: ["随机提示词A", "随机提示词B"] }));
    let genCount = 0;
    mockRoute("/neo_image_gen/generate", () => {
        genCount += 1;
        return jsonResponse({ task_id: `gmb${genCount}`, status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/gmb1", () => jsonResponse({
        task_id: "gmb1", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "krea2_b1_.png", subfolder: "NeoAgent/2026-10-01", url: "/b1.png" }],
    }));
    mockRoute("/neo_image_gen/status/gmb2", () => jsonResponse({
        task_id: "gmb2", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "krea2_b2_.png", subfolder: "NeoAgent/2026-10-01", url: "/b2.png" }],
    }));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);

    // ⋯ 打开工具菜单：启用运行时随机 + 数量调为 2
    const moreBtn = overlay.querySelector(".neo-gallery-gm-more-btn");
    click(moreBtn);
    const menu = overlay.querySelector(".neo-gallery-gm-more-menu");
    assert.equal(menu.style.display, "block", "⋯ 菜单应打开");
    const runtimeCheck = menu.querySelector("input[type=checkbox]");
    runtimeCheck.checked = true;
    fire(runtimeCheck, "change");
    click([...menu.querySelectorAll(".rs-runtime-count-btn")].find(b => b.textContent === "+"));
    assert.equal(menu.querySelector(".rs-runtime-count-val").textContent, "2", "数量应设为 2");
    assert.ok(moreBtn.classList.contains("neo-gallery-gm-tool-on"), "运行时随机开启时 ⋯ 应高亮");
    click(moreBtn); // 关菜单


    // 生成 → 批量：抽 2 条逐张生成
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(200);

    const randReq = fetchLog.filter(c => c.path === "/rs_prompts/random_prompts").at(-1);
    assert.deepEqual(randReq?.body, { count: 2 }, "批量应向混合池请求 2 条");
    const genReqs = fetchLog.filter(c => c.path === "/neo_image_gen/generate");
    assert.equal(genReqs.length, 2, "应逐张生成 2 次");
    assert.deepEqual(genReqs.map(r => r.body.prompt), ["随机提示词A", "随机提示词B"], "按抽到的提示词顺序生成");

    // 两张都成功：结果图在位 + 完成提示
    const previewBox = overlay.querySelector(".neo-gallery-cs-result");
    assert.equal(previewBox.querySelectorAll(".neo-gallery-cs-result-img").length, 2, "两张结果图应在位");
    assert.match(overlay.querySelector(".neo-gallery-story-hint").textContent, /已生成 2\/2/);

    // 状态持久化
    assert.deepEqual(JSON.parse(localStorage.getItem("neo.gallery.gen_material.runtime_random")), { enabled: true, count: 2 });
    document.querySelector(".neo-gallery-gm-modal-overlay")?.remove();
});

test("运行时随机批量：取消保留已生成的图", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");
    localStorage.removeItem("neo.gallery.gen_material.runtime_random");
    localStorage.setItem("neo.gallery.gen_material.runtime_random", JSON.stringify({ enabled: true, count: 2 }));

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/rs_prompts/random_prompts", () => jsonResponse({ texts: ["随机提示词A", "随机提示词B"] }));
    let genCount = 0;
    mockRoute("/neo_image_gen/generate", () => {
        genCount += 1;
        return jsonResponse({ task_id: `gmc${genCount}`, status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/gmc1", () => jsonResponse({
        task_id: "gmc1", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "krea2_c1_.png", subfolder: "NeoAgent/2026-10-01", url: "/c1.png" }],
    }));
    mockRoute("/neo_image_gen/status/gmc2", () => jsonResponse({ task_id: "gmc2", status: "running", progress: { value: 1, max: 8 }, images: [] }));
    mockRoute("/neo_image_gen/cancel/gmc2", () => jsonResponse({}));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);

    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "生成"));
    await sleep(150); // 第一张完成，第二张运行中

    const cancelBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find(b => b.textContent === "取消任务");
    assert.ok(cancelBtn, "批量运行中应有「取消任务」按钮");
    click(cancelBtn);
    dispatchApiEvent("rs.image_gen.status", { task_id: "gmc2", status: "running" });
    await sleep(100);

    // 已取消：保留第一张，提示 1/2
    const previewBox = overlay.querySelector(".neo-gallery-cs-result");
    assert.equal(previewBox.querySelectorAll(".neo-gallery-cs-result-img").length, 1, "应保留已生成的图");
    assert.match(overlay.querySelector(".neo-gallery-story-hint").textContent, /已生成 1\/2/);
    assert.ok(fetchLog.some(c => c.path === "/neo_image_gen/cancel/gmc2"), "应发出取消请求");
    document.querySelector(".neo-gallery-gm-modal-overlay")?.remove();
});

test("☰ 预设列表：搜索 + 点击填入 output 框（无配方条目）", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");
    localStorage.removeItem("neo.gallery.gen_material.runtime_random");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse([
        { name: "红色陶瓷杯", source: "presets" },
        { name: "白底产品图", source: "custom" },
    ]));
    mockRoute("/rs_prompts/load_prompt", () => jsonResponse({ text: "RED CERAMIC CUP, white background, soft lighting" }));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);

    click(overlay.querySelector(".neo-gallery-gm-more-btn"));
    click([...overlay.querySelectorAll(".neo-gallery-gm-menu-item")].find(b => b.textContent === "预设列表"));
    await sleep(80);


    const presetOverlay = overlay.querySelector(".rs-preset-list-overlay");
    assert.equal(presetOverlay.style.display, "flex", "预设列表浮层应打开");
    assert.equal(presetOverlay.querySelectorAll(".rs-preset-item").length, 2, "应列出 2 条预设");

    // 搜索过滤
    inputText(presetOverlay.querySelector(".rs-preset-search-input"), "陶瓷");
    assert.equal(presetOverlay.querySelectorAll(".rs-preset-item").length, 1, "搜索后应只剩 1 条");

    // 点击填入 output 框并关闭浮层
    click(presetOverlay.querySelector(".rs-preset-item"));
    await sleep(80);
    assert.equal(overlay.querySelector(".neo-gallery-story-input").value, "RED CERAMIC CUP, white background, soft lighting", "点击预设应填入 output 框");
    assert.equal(presetOverlay.style.display, "none", "填入后浮层应关闭");
    document.querySelector(".neo-gallery-gm-modal-overlay")?.remove();
});

test("生成素材弹窗：文生图下拉按技能输入形态分类——两栖技能在列，必须带参考图的编辑类排除", async () => {
    resetEnv();
    clearRoutes();
    localStorage.clear();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true, mode: "t2i" },
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1 生图/编辑", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_face_swap", cn_name: "Qwen Image 2.1 换脸", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
        { id: "canvas_ref_skill", cn_name: "画布导入参考编辑", category: "image_gen", gen_image: true, requires_ref: true },
    ]));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);
    const skillSel = overlay.querySelector(".neo-recipes-sort");
    assert.deepEqual([...skillSel.options].map(o => o.value), ["image_gen", "qwen_image_21"],
        "文生图页只列吃文字的技能：换脸这类必须带参考图的技能在本页没有图可给，列出来只会出废图");
    overlay.remove();
});


test("输出框空态收成一行：聚焦 / 输入展开，空内容失焦收回", async () => {
    resetEnv();
    clearRoutes();
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);
    const output = overlay.querySelector(".neo-gallery-story-input");
    const wrap = overlay.querySelector(".neo-gallery-gm-output-wrap");
    assert.ok(!wrap.classList.contains("neo-gallery-gm-output-open"), "idle 空态输出框应收成一行");

    fire(output, "focus");
    assert.ok(wrap.classList.contains("neo-gallery-gm-output-open"), "聚焦后应展开");
    fire(output, "blur");
    assert.ok(!wrap.classList.contains("neo-gallery-gm-output-open"), "空内容失焦应收回");

    inputText(output, "红色陶瓷杯");
    keydown(output, "ArrowUp");
    assert.ok(wrap.classList.contains("neo-gallery-gm-output-open"), "输入 / 键盘召回后应展开");
    fire(output, "blur");
    assert.ok(wrap.classList.contains("neo-gallery-gm-output-open"), "有内容时失焦不收回");
    overlay.remove();
});

test("⋯ 菜单：Esc 先关菜单，再关预设浮层", async () => {
    resetEnv();
    clearRoutes();
    localStorage.removeItem("neo.gallery.gen_material.runtime_random");
    const { openGenMaterialDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "image_gen", cn_name: "Krea2文生图", category: "image_gen", gen_image: true },
    ]));
    mockRoute("/rs_prompts/list_prompts", () => jsonResponse([{ name: "红色陶瓷杯", source: "presets" }]));

    openGenMaterialDialog({ showDirectoryStructure: () => {} });
    const overlay = document.querySelector(".neo-gallery-gm-modal-overlay");
    await sleep(50);

    const moreBtn = overlay.querySelector(".neo-gallery-gm-more-btn");
    const menu = overlay.querySelector(".neo-gallery-gm-more-menu");
    click(moreBtn);
    assert.equal(menu.style.display, "block", "点 ⋯ 应打开菜单");
    keydown(document, "Escape");
    assert.equal(menu.style.display, "none", "Esc 应先关 ⋯ 菜单，不关窗");

    click([...overlay.querySelectorAll(".neo-gallery-gm-menu-item")].find(b => b.textContent === "预设列表"));
    const presetOverlay = overlay.querySelector(".rs-preset-list-overlay");
    assert.equal(presetOverlay.style.display, "flex", "菜单条目应打开预设列表");
    keydown(document, "Escape");
    assert.equal(presetOverlay.style.display, "none", "Esc 再关预设浮层");
    overlay.remove();
});

