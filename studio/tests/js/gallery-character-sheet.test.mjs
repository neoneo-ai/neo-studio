// Neo Gallery 卡片「生成角色图（多视图）」：固定 Qwen Image 2.1 + 单参考图请求体。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, sleep, click, flush } from "./setup.mjs";
import { app, resetSidebarTab } from "./mocks/comfy-app.mjs";

test("buildCharacterSheetRequest 固定走 qwen_image_21 且不带全局 LoRA", async () => {
    resetEnv();
    clearRoutes();
    const { buildCharacterSheetRequest } = await import("../../web/gallery-gen.js");
    const body = buildCharacterSheetRequest("NeoAgent/portrait.png");
    assert.equal(body.skill_id, "qwen_image_21");
    assert.equal(body.width, 1920);
    assert.equal(body.height, 1080);
    assert.deepEqual(body.references, [{ kind: "input", value: "NeoAgent/portrait.png" }]);
    assert.deepEqual(body.loras, []);
    assert.equal(body.skip_enhance, true);
    assert.equal(body.output_prefix, "CharacterSheet");
    assert.match(body.prompt, /多视图/);
    assert.match(body.prompt, /大头特写/);
    assert.match(body.prompt, /正面全身/);
    assert.match(body.prompt, /侧面全身/);
    assert.match(body.prompt, /背面全身/);
});

test("⋯ 菜单「生成角色图」：小窗显示参考图，点生成后窗口内出结果预览", async () => {
    resetEnv();
    clearRoutes();
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const jumps = [];
    const gallery = {
        app: {},
        maxThumbnailSize: 320,
        displayLabels: true,
        deleteItem() {},
        showDirectoryStructure(source, path) { jumps.push([source, path]); return Promise.resolve(); },
    };
    resetSidebarTab();
    app.neoGallery = gallery;   // 「打开输出目录」经侧栏助手走全局画廊实例
    const card = new GalleryCard(gallery);
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "portrait", filename: "portrait.png" }, "", "Output", anchor);

    const item = [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes("生成角色图"));
    assert.equal(item?.textContent, "生成角色图（多视图）");
    click(item);
    assert.equal(document.querySelector(".neo-gallery-collect-menu"), null, "菜单应关闭");

    const overlay = document.querySelector(".neo-gallery-cs-modal-overlay");
    assert.ok(overlay, "应弹出角色图小窗");
    // 参考图预览（与卡片同一缩略图缓存接口），不能只给一个文件名
    const refImg = overlay.querySelector(".neo-gallery-story-ref-img");
    assert.match(refImg?.getAttribute("src") || "", /\/neo_gallery\/thumbnail\?filename=portrait\.png&subfolder=&size=480$/);
    // idle：有「生成」按钮，且尚未发请求
    const genBtn = overlay.querySelectorAll(".neo-gallery-story-btn")[1];
    assert.equal(genBtn?.textContent, "生成");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_image_gen/generate").length, 0);

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    let body = null;
    mockRoute("/neo_image_gen/generate", (b) => {
        body = b;
        return jsonResponse({ task_id: "cs1", status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/cs1", () => jsonResponse({
        task_id: "cs1", status: "succeeded", width: 1920, height: 1080,
        images: [{ filename: "character_sheet_00001_.png", subfolder: "CharacterSheet/2026-09-24", url: "/cs.png" }],
    }));

    click(genBtn);
    await sleep(50);

    const copy = fetchLog.find((c) => c.path === "/neo_gallery/copy_to_input");
    assert.ok(copy, "卡片图片应先经 copy_to_input 落到 input/ 当参考图");
    assert.equal(copy.query.get("filename"), "portrait.png");
    assert.ok(body, "应发出 /neo_image_gen/generate 请求");
    assert.equal(body.skill_id, "qwen_image_21");
    assert.equal(body.output_prefix, "CharacterSheet");
    assert.deepEqual(body.references, [{ kind: "input", value: "portrait.png" }]);

    // 窗口保持打开并显示结果预览（走 thumbnail 缓存接口，size=640）
    const resultImg = overlay.querySelector(".neo-gallery-cs-result-img");
    assert.match(resultImg?.getAttribute("src") || "", /\/neo_gallery\/thumbnail\?filename=character_sheet_00001_\.png&subfolder=CharacterSheet%2F2026-09-24&size=640$/);

    // 成功后有「打开输出目录」按钮，点击跳转画廊 CharacterSheet 主目录
    const openDirBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "打开输出目录");
    assert.ok(openDirBtn, "成功后应有「打开输出目录」按钮");
    click(openDirBtn);
    await sleep(10);
    assert.deepEqual(jumps, [["CharacterSheet", []]], "打开角色主目录");
});
