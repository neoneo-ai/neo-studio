// Neo Gallery 卡片「图片编辑」：以原图为参考，用所选技能 + 编辑指令生成新图；
// 成功后保留「再生成」按钮，支持连续重复生成，不必关窗重开。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, sleep, click, inputText, window } from "./setup.mjs";
import { dispatchApiEvent } from "./mocks/comfy-api.mjs";

test("图片编辑弹窗：目标分辨率默认取原图尺寸（32 对齐），原图过大按设置的 MP 等比封顶", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");
    const realImage = globalThis.Image;
    // 尺寸探针（new Image()）立刻回尺寸；目标像素数（MP）来自「生图默认设置」
    const withImageSize = async (w, h) => {
        globalThis.Image = class {
            set src(_v) { this.naturalWidth = w; this.naturalHeight = h; this.onload?.(); }
        };
        openImageEditDialog({ app: {}, maxThumbnailSize: 320, displayLabels: true },
                            { name: "p", filename: "p.png" }, "");
        const overlay = [...document.querySelectorAll(".neo-gallery-edit-modal-overlay")].pop();
        await sleep(20);   // 设置请求 → 探针
        return [overlay.querySelector("#img-edit-width").value, overlay.querySelector("#img-edit-height").value];
    };
    mockRoute("/neo_image_gen/settings", () => jsonResponse({ target_megapixels: 1.5 }));
    assert.deepEqual(await withImageSize(800, 600), ["800", "608"]);        // 小图：保持原尺寸（32 对齐）
    assert.deepEqual(await withImageSize(4000, 3000), ["1440", "1088"]);   // 大图：按 1.5MP 等比封顶
    mockRoute("/neo_image_gen/settings", () => jsonResponse({ target_megapixels: 2.0 }));
    assert.deepEqual(await withImageSize(4000, 3000), ["1664", "1248"]);   // MP 改成 2.0 后封顶值随之变化
    globalThis.Image = realImage;
});

test("图片编辑弹窗：idle 有「生成」，成功后保留「再生成」可连续重复生成", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    const image = { name: "portrait", filename: "portrait.png" };
    openImageEditDialog(gallery, image, "");

    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    assert.ok(overlay, "应弹出图片编辑弹窗");

    // idle：有「生成」按钮，且尚未发请求
    const btns = () => [...overlay.querySelectorAll(".neo-gallery-story-btn")].map((b) => b.textContent);
    const idleGenBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成");
    assert.ok(idleGenBtn, "idle 应有「生成」按钮");
    assert.equal(fetchLog.filter((c) => c.path === "/neo_image_gen/generate").length, 0);

    // 目标分辨率 32 对齐：手输非 32 倍数会在 change 时纠正（Qwen2.1 latent 一格 = 32px，错开会偏）
    const wIn = overlay.querySelector("#img-edit-width");
    wIn.value = "1000";
    wIn.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(wIn.value, "992");
    assert.equal(overlay.querySelector("#img-edit-height").step, "32");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
    ]));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    mockRoute("/neo_image_gen/settings", () => jsonResponse({ target_megapixels: 1.5 }));
    let genCount = 0;
    mockRoute("/neo_image_gen/generate", () => {
        genCount += 1;
        return jsonResponse({ task_id: "ie1", status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/ie1", () => jsonResponse({
        task_id: "ie1", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "edit_00001_.png", subfolder: "Output/2026-09-30", url: "/e.png" }],
    }));

    inputText(overlay.querySelector(".neo-gallery-story-input"), "把背景换成海边日落");
    click(idleGenBtn);
    await sleep(80);

    // 第一次生成成功：结果显示，且操作区保留「再生成」+「关闭」（核心修复点）
    const resultImg = overlay.querySelector(".neo-gallery-edit-compare-img[alt='编辑结果']");
    assert.match(resultImg?.getAttribute("src") || "", /\/neo_gallery\/thumbnail\?filename=edit_00001_\.png/);
    assert.ok(btns().includes("再生成"), "成功后应保留「再生成」按钮");
    assert.ok(btns().includes("关闭"), "成功后应有「关闭」按钮");
    assert.equal(genCount, 1);

    // 点「再生成」→ 再次发请求，无需关窗重开（连续重复生成）
    const regenBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "再生成");
    click(regenBtn);
    await sleep(80);
    assert.equal(genCount, 2, "点「再生成」应再次发出 /neo_image_gen/generate 请求");
});

test("图片编辑弹窗：扩图开关切到扩图技能，拖框后请求带 outpaint 且不带 loras", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    // skills mock 必须在开窗前注册（下拉 fetch 在开窗时同步发出）
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    const image = { name: "portrait", filename: "portrait.png" };
    openImageEditDialog(gallery, image, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    // jsdom 无布局：给原图显示/自然尺寸（显示 400×300，自然 800×600）
    const origImg = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImg, key, { value, configurable: true });
    }

    // 打开扩图：技能切到扩图技能、控制行出现、宽高输入隐藏、提示词预填默认触发词
    const outpaintBtn = overlay.querySelector(".neo-gallery-edit-outpaint-btn");
    click(outpaintBtn);
    const skillSel = overlay.querySelector(".neo-gallery-story-form-row select");
    assert.equal(skillSel.value, "qwen_image_21_outpaint", "开扩图应切到扩图技能");
    assert.notEqual(overlay.querySelector(".neo-gallery-edit-outpaint-row").style.display, "none");
    assert.equal(overlay.querySelector("#img-edit-width").style.display, "none");
    assert.match(overlay.querySelector(".neo-gallery-story-input").value, /Outpaint the image/);

    // 默认跟随原图：未拖框时目标尺寸 = 原图自然尺寸（不套目标像素、不缩放）
    assert.equal(overlay.querySelector(".neo-gallery-edit-size-label").textContent, "目标 800×600",
        "开扩图应先按原图尺寸，扩图大小要由拖框决定");
    assert.equal(overlay.querySelector(".neo-gallery-edit-mp").value, "1.5", "默认目标像素 1.5MP（与参考工作流一致）");

    // 拖 se 手柄：显示 400×300 → 500×360（自然像素 right=208 bottom=128）
    const pointerAt = (el, type, x, y) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        ev.clientX = x;
        ev.clientY = y;
        ev.button = 0;
        el.dispatchEvent(ev);
    };
    const seHandle = overlay.querySelector(".neo-gallery-edit-outpaint-handle-se");
    pointerAt(seHandle, "pointerdown", 400, 300);
    pointerAt(window, "pointermove", 500, 360);
    pointerAt(window, "pointerup", 500, 360);

    // 画布（500×360）超出舞台（显示 400×300）→ 整体等比缩小 scale(0.8)，手柄反向缩放保持可抓取
    const canvasEl = overlay.querySelector(".neo-gallery-edit-outpaint-canvas");
    assert.equal(canvasEl.style.transform, "scale(0.8)");
    assert.equal(canvasEl.style.getPropertyValue("--op-inv"), "1.2500");

    // 结果尺寸标签：补边画布（1MP 层 1184×896 + 留白 296/179）整幅缩放到 1.5MP → 1472×1056
    assert.equal(overlay.querySelector(".neo-gallery-edit-size-label").textContent, "目标 1472×1056",
        "目标尺寸 = 补边画布缩放到目标像素后的出图尺寸");

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    let genBody = null;
    mockRoute("/neo_image_gen/generate", (body) => {
        genBody = body;
        return jsonResponse({ task_id: "ie2", status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/ie2", () => jsonResponse({
        task_id: "ie2", status: "succeeded", width: 1008, height: 728,
        images: [{ filename: "outp_00001_.png", subfolder: "Output/2026-10-03", url: "/o.png" }],
    }));

    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(80);

    assert.ok(genBody, "应发出扩图生成请求");
    assert.equal(genBody.skill_id, "qwen_image_21_outpaint");
    // 留白按「1MP 归一化层」的像素算（拖出来的比例不变），出图尺寸 = 画布缩放到 1.5MP
    assert.deepEqual(genBody.outpaint, { left: 0, top: 0, right: 296, bottom: 179, total_pixels: 1.5 });
    assert.equal(genBody.loras, undefined, "扩图模式不应传 loras（由技能 config 固定）");
    assert.equal(genBody.width, 1472, "出图尺寸 = 补边画布缩放到 1.5MP（32 对齐）");
    assert.equal(genBody.height, 1056);
    assert.equal(genBody.width % 32, 0, "画布宽应 32 对齐（编码器才不会二次缩放参考图）");
    assert.equal(genBody.height % 32, 0, "画布高应 32 对齐");
    assert.equal(genBody.outpaint.top, 0, "没拖上边就不该有上留白");
    assert.equal(genBody.outpaint.left, 0, "没拖左边就不该有左留白");

    // MP 是可选旋钮：改了就按新目标像素重算出图尺寸
    const mpInput = overlay.querySelector(".neo-gallery-edit-mp");
    mpInput.value = "2";
    mpInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(overlay.querySelector(".neo-gallery-edit-size-label").textContent, "目标 1696×1248");
    mpInput.value = "1.5";
    mpInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(overlay.querySelector(".neo-gallery-edit-size-label").textContent, "目标 1472×1056");

    // 扩图结果层挂进画布：结果就是整幅补边画布，落在画布里才和原图区域逐像素对齐
    // （挂图片盒会被 contain 缩放到原图尺寸 → 对比时看着整体偏移）
    assert.equal(overlay.querySelector(".neo-gallery-edit-result-clip").parentElement, canvasEl,
        "扩图结果层应挂在画布内（与补边画布同盒）");
    assert.equal(overlay.querySelector(".neo-gallery-edit-divider").parentElement, canvasEl,
        "扩图分割线应挂在画布内（百分比按画布宽算）");

    // 关闭扩图：技能切回、拖框移除
    click(outpaintBtn);
    assert.equal(skillSel.value, "qwen_image_21");
    assert.equal(overlay.querySelector(".neo-gallery-edit-outpaint-box"), null);
    const imgWrapEl = overlay.querySelector(".neo-gallery-edit-compare-imgwrap");
    assert.equal(overlay.querySelector(".neo-gallery-edit-result-clip").parentElement, imgWrapEl,
        "关掉扩图后结果层应回到图片盒");
    assert.equal(overlay.querySelector(".neo-gallery-edit-divider").parentElement, imgWrapEl);
});

test("图片编辑弹窗：扩图拖框画布边长封顶 4× 原图，超出舞台整体缩小", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    const image = { name: "portrait", filename: "portrait.png" };
    openImageEditDialog(gallery, image, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    // jsdom 无布局：给原图显示/自然尺寸（显示 400×300，自然 800×600）
    const origImg = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImg, key, { value, configurable: true });
    }

    click(overlay.querySelector(".neo-gallery-edit-outpaint-btn"));
    const pointerAt = (el, type, x, y) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        ev.clientX = x;
        ev.clientY = y;
        ev.button = 0;
        el.dispatchEvent(ev);
    };
    // 一次拖到极远处：画布被封顶在 4× 原图（1600×1200）
    const seHandle = overlay.querySelector(".neo-gallery-edit-outpaint-handle-se");
    pointerAt(seHandle, "pointerdown", 400, 300);
    pointerAt(window, "pointermove", 20000, 20000);
    pointerAt(window, "pointerup", 20000, 20000);

    const canvasEl = overlay.querySelector(".neo-gallery-edit-outpaint-canvas");
    assert.equal(canvasEl.style.width, "1600px");
    assert.equal(canvasEl.style.height, "1200px");
    // 显示缩放 min(1, 400/1600, 300/1200) = 0.25，画布始终不越出舞台
    assert.equal(canvasEl.style.transform, "scale(0.25)");
});
test("图片编辑弹窗：扩图基准取 contain 后的可见图片尺寸，原图元素盒的留黑不算进画布", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "wide", filename: "wide.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    // 原图元素盒 800×300（object-fit:contain 左右留黑），自然 800×600；舞台 800×300
    const origImg = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 800], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImg, key, { value, configurable: true });
    }
    const stage = overlay.querySelector(".neo-gallery-edit-compare-imgwrap");
    for (const [key, value] of [["clientWidth", 800], ["clientHeight", 300]]) {
        Object.defineProperty(stage, key, { value, configurable: true });
    }

    click(overlay.querySelector(".neo-gallery-edit-outpaint-btn"));

    // contain: min(800/800, 300/600)=0.5 → 画布 400×300（把元素盒当画布会得到 800×300，即"点开自动变大"）
    const canvasEl = overlay.querySelector(".neo-gallery-edit-outpaint-canvas");
    assert.equal(canvasEl.style.width, "400px");
    assert.equal(canvasEl.style.height, "300px");
    // 基准冻结：原图移进画布后不再反量它（画布内量它只会得到 0 → 退回自然尺寸）
    assert.equal(origImg.style.width, "400px");
    assert.equal(origImg.style.height, "300px");
    assert.equal(canvasEl.style.transform, "scale(1)");
    // 无留白 → 目标尺寸就是原图自然尺寸（默认不套 MP 目标）
    assert.equal(overlay.querySelector(".neo-gallery-edit-size-label").textContent, "目标 800×600");
});

test("图片编辑弹窗：扩图拖框体是平移留白，不会把框缩回原图", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    const origImg = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImg, key, { value, configurable: true });
    }

    click(overlay.querySelector(".neo-gallery-edit-outpaint-btn"));
    const pointerAt = (el, type, x, y) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        ev.clientX = x;
        ev.clientY = y;
        ev.button = 0;
        el.dispatchEvent(ev);
    };
    // 先拖 se 手柄加留白：400×300 → 500×360
    const seHandle = overlay.querySelector(".neo-gallery-edit-outpaint-handle-se");
    pointerAt(seHandle, "pointerdown", 400, 300);
    pointerAt(window, "pointermove", 500, 360);
    pointerAt(window, "pointerup", 500, 360);
    const canvasEl = overlay.querySelector(".neo-gallery-edit-outpaint-canvas");
    assert.equal(canvasEl.style.width, "500px");

    // 再拖框体向左：此时显示缩放 0.8（指针位移换算 ×1.25），但框必须包住原图 → 左移被夹在 100
    const boxEl = overlay.querySelector(".neo-gallery-edit-outpaint-box");
    pointerAt(boxEl, "pointerdown", 400, 300);
    pointerAt(window, "pointermove", 300, 300);
    pointerAt(window, "pointerup", 300, 300);
    assert.equal(canvasEl.style.width, "500px", "拖框体不应改变画布尺寸");
    assert.equal(canvasEl.style.height, "360px");
    assert.equal(origImg.style.left, "100px", "原图应在画布内右移 100（左边留白）");
    assert.equal(origImg.style.top, "0px");

    // 继续左拖：夹在包住原图的极限，不再移动
    pointerAt(boxEl, "pointerdown", 400, 300);
    pointerAt(window, "pointermove", 0, 300);
    pointerAt(window, "pointerup", 0, 300);
    assert.equal(origImg.style.left, "100px");

    // 留白只是从右边换到左边，画布尺寸不变 → 出图尺寸也不变
    assert.equal(overlay.querySelector(".neo-gallery-edit-size-label").textContent, "目标 1472×1056");
});

test("图片编辑弹窗：局部开关切到局部技能、涂抹画布出现，未涂抹禁止生成", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_local_edit", cn_name: "Qwen Image 2.1 高分局部编辑", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    const origImg = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImg, key, { value, configurable: true });
    }

    const localBtn = overlay.querySelector(".neo-gallery-edit-outpaint-btn:nth-of-type(2)");
    assert.ok(localBtn && localBtn.textContent.includes("局部"), "应有「局部」按钮");
    click(localBtn);
    await sleep(10);

    const skillSel = overlay.querySelector(".neo-gallery-story-form-row select");
    assert.equal(skillSel.value, "qwen_image_21_local_edit", "开局部应切到局部技能");
    const localRow = [...overlay.querySelectorAll(".neo-gallery-edit-outpaint-row")]
        .find((r) => r.contains(overlay.querySelector(".neo-gallery-edit-brush")));
    assert.ok(localRow && localRow.style.display !== "none", "应出现局部控制行（画笔/橡皮）");
    assert.ok(overlay.querySelector(".neo-gallery-edit-paint-canvas"), "应出现涂抹画布");
    assert.equal(overlay.querySelector("#img-edit-width").style.display, "none", "局部模式隐藏宽高输入");

    // 未涂抹直接生成 → 报错、不发请求
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    let genCount = 0;
    mockRoute("/neo_image_gen/generate", () => { genCount += 1; return jsonResponse({ task_id: "ie3", status: "queued", images: [] }); });
    inputText(overlay.querySelector(".neo-gallery-story-input"), "把划痕去掉");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(40);
    assert.equal(genCount, 0, "未涂抹不应发出请求");
    assert.match(overlay.querySelector(".neo-gallery-story-hint-error")?.textContent || "", /涂抹/);

    // 关闭局部：技能切回、画布移除
    click(localBtn);
    await sleep(10);
    assert.equal(skillSel.value, "qwen_image_21");
    assert.equal(overlay.querySelector(".neo-gallery-edit-paint-canvas"), null);
});

test("图片编辑弹窗：点选删除——点击后 SAM3 分割出遮罩预览（预填删除提示词、可改），请求带 remove_points", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    // jsdom 无布局：给原图自然尺寸（800×600）；点击层默认 300×150 → 显示/自然比例 0.375 / 0.25
    const origImg = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImg, key, { value, configurable: true });
    }

    const promptInput = overlay.querySelector(".neo-gallery-story-input");
    const genBtn = () => [...overlay.querySelectorAll(".neo-gallery-story-btn")]
        .find((b) => ["生成", "再生成", "重试"].includes(b.textContent));
    let genBody = null;
    let genCount = 0;
    let segCount = 0;
    let segBodies = [];
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    mockRoute("/neo_image_gen/segment_points", (body) => {
        segCount += 1;
        segBodies.push(body);
        return jsonResponse({ mask: `NeoAgent/_neo_sam3_mask_t${segCount}.png` });
    });
    mockRoute("/neo_image_gen/generate", (body) => {
        genCount += 1;
        genBody = body;
        return jsonResponse({ task_id: "ie4", status: "queued", images: [] });
    });
    mockRoute("/neo_image_gen/status/ie4", () => jsonResponse({
        task_id: "ie4", status: "succeeded", width: 800, height: 600,
        images: [{ filename: "rm_00001_.png", subfolder: "Output/2026-10-03", url: "/o.png" }],
    }));

    // 开点选删除：控制行出现、宽高输入隐藏、透明点击层出现，技能保持 Qwen Image 2.1
    const removeBtn = [...overlay.querySelectorAll(".neo-gallery-edit-outpaint-btn")]
        .find((b) => b.textContent.includes("点选删除"));
    assert.ok(removeBtn, "应有「点选删除」按钮");
    click(removeBtn);
    await sleep(30);   // 含 copy_to_input 请求
    const skillSel = overlay.querySelector(".neo-gallery-story-form-row select");
    assert.equal(skillSel.value, "qwen_image_21", "点选删除应走 Qwen Image 2.1 编辑链");
    const removeRow = [...overlay.querySelectorAll(".neo-gallery-edit-outpaint-row")]
        .find((r) => r.textContent.includes("清空标记"));
    assert.ok(removeRow && removeRow.style.display !== "none", "应出现点选控制行");
    assert.equal(overlay.querySelector("#img-edit-width").style.display, "none", "点选模式隐藏宽高输入（出图同原图）");
    const removeCanvas = overlay.querySelector(".neo-gallery-edit-remove-canvas");
    assert.ok(removeCanvas, "应出现透明点击层");
    assert.ok(overlay.querySelector(".neo-gallery-edit-refdrop-row").classList.contains("disabled"),
        "点选模式只用首张参考，额外参考应禁用");

    // 未标记直接生成 → 报错、不发请求
    click(genBtn());
    await sleep(40);
    assert.equal(genCount, 0, "未标记不应发出请求");
    assert.match(overlay.querySelector(".neo-gallery-story-hint-error")?.textContent || "", /标记/);

    const pointerAt = (el, type, x, y) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        ev.clientX = x;
        ev.clientY = y;
        ev.button = 0;
        el.dispatchEvent(ev);
    };

    // 点击标记两个物体（显示坐标 → 自然像素：100/0.375≈267、75/0.25=300；200/0.375≈533、100/0.25=400）
    pointerAt(removeCanvas, "pointerdown", 100, 75);
    pointerAt(removeCanvas, "pointerdown", 200, 100);
    await sleep(800);   // 防抖 600ms → SAM3 分割出遮罩预览
    assert.equal(segCount, 1, "标记后应调一次分割");
    assert.deepEqual(segBodies[0], { image: "portrait.png", points: [{ x: 267, y: 300 }, { x: 533, y: 400 }] },
        "分割请求应带原图名与原图像素坐标");
    assert.match(promptInput.value, /Remove the object in the red highlighted area/,
        "开点选删除应预填默认删除提示词（用户可见可改）");

    // 生成：预填只是默认值、用户可改；请求带 remove_points 与输入框里的提示词
    inputText(promptInput, "只删掉左边那把椅子");
    click(genBtn());
    await sleep(80);
    assert.equal(genCount, 1, "已标记应发出请求");
    assert.deepEqual(genBody.remove_points, [{ x: 267, y: 300 }, { x: 533, y: 400 }],
        "remove_points 应为原图像素坐标");
    assert.equal(genBody.prompt, "只删掉左边那把椅子", "请求应带用户改过的提示词");
    assert.equal(genBody.skill_id, "qwen_image_21");

    // 点已有标记取消一个 → 防抖后重新分割
    pointerAt(removeCanvas, "pointerdown", 100, 75);
    await sleep(800);
    assert.equal(segCount, 2, "标记变化应重新分割");
    assert.deepEqual(segBodies[1].points, [{ x: 533, y: 400 }], "重新分割只带剩余标记点");

    // 清空标记：遮罩预览清除、不再发分割请求
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "清空标记"));
    await sleep(800);
    assert.equal(segCount, 2, "清空后不应再发分割请求");

    // 重新标记 → 再次分割（不覆盖用户改过的提示词）
    pointerAt(removeCanvas, "pointerdown", 300, 120);
    await sleep(800);
    assert.equal(segCount, 3, "重新标记后应再次分割");
    assert.equal(promptInput.value, "只删掉左边那把椅子", "重新分割不应覆盖用户改过的提示词");

    // 无标记生成 → 报错、不发新请求
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "清空标记"));
    click(genBtn());
    await sleep(40);
    assert.equal(genCount, 1, "无标记不应发出请求");

    // 关闭点选：点击层移除
    click(removeBtn);
    await sleep(10);
    assert.equal(overlay.querySelector(".neo-gallery-edit-remove-canvas"), null, "关闭后点击层应移除");
});

test("图片编辑弹窗：第二参考图拖放选中后随请求发送，扩图/局部模式下不可用", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
    ]));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "body_b.png" }));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    const refDropZone = overlay.querySelector(".neo-gallery-edit-refdrop");
    assert.ok(refDropZone, "应有参考图拖放区");

    // 模拟从素材库拖放（application/x-neo-gallery MIME）
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"body_b.png","subfolder":"people"}' : "") };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });
    refDropZone.dispatchEvent(dropEv);
    await sleep(30);

    const chipImg = overlay.querySelector(".neo-gallery-edit-refchip-img");
    assert.ok(chipImg, "拖放后应显示参考图缩略图");
    assert.match(chipImg.getAttribute("src"), /filename=body_b\.png/);

    // 生成请求携带第二张参考图
    let genBody = null;
    mockRoute("/neo_image_gen/generate", (body) => { genBody = body; return jsonResponse({ task_id: "ie4", status: "queued", images: [] }); });
    inputText(overlay.querySelector(".neo-gallery-story-input"), "把脸换成参考图的脸");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(60);
    assert.ok(genBody, "应发出生成请求");
    assert.equal(genBody.references.length, 2);
    assert.deepEqual(genBody.references[1], { kind: "input", value: "body_b.png" });

    // 开扩图：第二参考不可用且被清除
    const outpaintBtn = overlay.querySelector(".neo-gallery-edit-outpaint-btn");
    click(outpaintBtn);
    await sleep(10);
    assert.ok(overlay.querySelector(".neo-gallery-edit-refdrop-row").classList.contains("disabled"), "扩图模式下拖放区应禁用");
    assert.equal(overlay.querySelector(".neo-gallery-edit-refchip-img"), null, "扩图模式应清除已选第二参考");
});

test("图片编辑弹窗：姿势开关切到姿势编辑技能并预填默认触发词，第二参考图作姿势参考随请求发送", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_pose_edit", cn_name: "Qwen Image 2.1 姿势编辑", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true,
          gen_config: { default_prompt: "Change the pose of the person in <image1> to [describe the new pose], keeping the face unchanged" } },
    ]));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "pose_b.png" }));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    const poseBtn = [...overlay.querySelectorAll(".neo-gallery-edit-outpaint-btn")].find((b) => b.textContent.includes("姿势"));
    assert.ok(poseBtn, "应有「姿势」开关");
    click(poseBtn);
    await sleep(10);

    const skillSel = overlay.querySelector(".neo-gallery-story-form-row select");
    assert.equal(skillSel.value, "qwen_image_21_pose_edit", "开姿势应切到姿势编辑技能");
    assert.ok(poseBtn.classList.contains("on"), "姿势开关应高亮");
    const promptInput = overlay.querySelector(".neo-gallery-story-input");
    assert.match(promptInput.value, /Change the pose of the person in <image1>/,
        "无参考图时应预填技能 config.json 的默认姿势触发词");
    // 姿势编辑走常规画布：目标分辨率保持可见，参考图区可用（第 2 张 = 姿势参考）
    assert.notEqual(overlay.querySelector("#img-edit-width").style.display, "none", "姿势模式应保留目标分辨率输入");
    assert.ok(!overlay.querySelector(".neo-gallery-edit-refdrop-row").classList.contains("disabled"), "姿势模式参考图区应可用");

    // 从素材库拖入姿势参考 → 触发词自动换成迁移姿势的默认词
    const refDropZone = overlay.querySelector(".neo-gallery-edit-refdrop");
    const dt = { getData: (m) => (m === "application/x-neo-gallery" ? '{"filename":"pose_b.png","subfolder":""}' : "") };
    const dropEv = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv, "dataTransfer", { value: dt, configurable: true });
    refDropZone.dispatchEvent(dropEv);
    await sleep(30);
    assert.match(promptInput.value, /Adopt the pose of the person in <image2>/,
        "拖入姿势参考后应自动换成迁移姿势的默认触发词");

    let genBody = null;
    mockRoute("/neo_image_gen/generate", (body) => { genBody = body; return jsonResponse({ task_id: "ie5", status: "queued", images: [] }); });
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(60);
    assert.ok(genBody, "应发出生成请求");
    assert.equal(genBody.skill_id, "qwen_image_21_pose_edit");
    assert.equal(genBody.references.length, 2);
    assert.deepEqual(genBody.references[1], { kind: "input", value: "pose_b.png" }, "姿势参考应进第 2 槽");
    assert.match(genBody.prompt, /Adopt the pose of the person in <image2>/, "请求应带迁移触发词");

    // 删掉姿势参考 → 触发词换回按提示词改姿势的默认词
    click(overlay.querySelector(".neo-gallery-edit-refchip-x"));
    await sleep(10);
    assert.match(promptInput.value, /Change the pose of the person in <image1>/,
        "移除姿势参考后应换回技能默认触发词");

    // 用户自己写过的提示词不被自动替换
    promptInput.value = "自定义姿势指令";
    const dropEv2 = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEv2, "dataTransfer", { value: dt, configurable: true });
    overlay.querySelector(".neo-gallery-edit-refdrop").dispatchEvent(dropEv2);
    await sleep(30);
    assert.equal(promptInput.value, "自定义姿势指令", "已有自定义提示词时不应被默认词覆盖");

    // 关姿势 → 回常规编辑技能，已选姿势参考保留
    click(poseBtn);
    await sleep(10);
    assert.equal(skillSel.value, "qwen_image_21", "关姿势应回到常规编辑技能");
    assert.ok(!poseBtn.classList.contains("on"), "关姿势后开关应熄灭");
    assert.ok(overlay.querySelector(".neo-gallery-edit-refchip-img"), "关姿势后已选参考图应保留");
});

test("图片编辑弹窗：生成失败（缺模型）弹 action toast 引导去技能详情", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
    ]));

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "ie5", status: "queued", images: [] }));
    // 非终态：resync 不结算（getJson 遇 error 字段会抛并被吞），失败终态由 WS 事件推送
    mockRoute("/neo_image_gen/status/ie5", () => jsonResponse({ task_id: "ie5", status: "running" }));

    inputText(overlay.querySelector(".neo-gallery-story-input"), "把背景换成海边日落");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(50);

    // 派发失败终态：缺模型（非 LLM 报文），带候选提示
    dispatchApiEvent("rs.image_gen.status", { task_id: "ie5", status: "failed", error: "找不到模型 Qwen/qwen_image_2.1_int8_convrot.safetensors（diffusion_models）；候选: QwenImage2.1\\qwen_image_2.1_int8_convrot.safetensors" });
    await sleep(10);

    // 窗内留错误 + 可重试
    assert.match(overlay.querySelector(".neo-gallery-story-hint-error")?.textContent || "", /找不到模型/);
    assert.ok([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "重试"), "可重试");

    // 弹 action toast：summary/detail + 「打开技能详情」入口（而非仅提示）
    const toast = [...document.querySelectorAll(".neo-at")].at(-1);
    assert.ok(toast, "应弹 action toast");
    assert.equal(toast.querySelector(".neo-at-summary").textContent, "图片编辑生成失败");
    assert.match(toast.querySelector(".neo-at-detail").textContent, /找不到模型/);
    assert.equal(toast.querySelector(".neo-at-action").textContent, "打开技能详情");
});


test("图片编辑弹窗：窗帘对比——结果层挂在图片盒内，拖分割线只裁切结果图（不缩放/不移位原图）", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    const gallery = { app: {}, maxThumbnailSize: 320, displayLabels: true };
    openImageEditDialog(gallery, { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
    ]));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "ie6", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/ie6", () => jsonResponse({
        task_id: "ie6", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "edit_00001_.png", subfolder: "Output/2026-09-30", url: "/e.png" }],
    }));

    const wrap = overlay.querySelector(".neo-gallery-edit-compare-imgwrap");
    const clip = overlay.querySelector(".neo-gallery-edit-result-clip");
    const divider = overlay.querySelector(".neo-gallery-edit-divider");
    // 结果层/分割线必须挂在图片盒内：只有同盒才能和原图逐像素对齐
    assert.equal(clip?.parentElement, wrap, "结果裁剪层应挂在图片盒内");
    assert.equal(divider?.parentElement, wrap, "分割线应挂在图片盒内");
    assert.equal(overlay.querySelector(".neo-gallery-edit-compare-stage")?.firstElementChild, wrap);
    assert.equal(clip.style.display, "none", "未生成时不应显示结果层");

    inputText(overlay.querySelector(".neo-gallery-story-input"), "把背景换成海边日落");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(80);

    // 成功后：分割线贴左边界（整幅结果图），往右拖才露出原图
    assert.notEqual(clip.style.display, "none", "生成成功后应显示结果层");
    assert.notEqual(divider.style.display, "none", "生成成功后应显示分割线");
    assert.equal(clip.style.clipPath, "inset(0 0 0 0%)", "默认贴左边界：整幅显示结果图");
    assert.equal(divider.style.left, "0%");
    assert.equal(clip.style.width, "", "结果层宽度不得跟随分割线（否则结果图会被压扁）");

    // 拖分割线：按下后必须拖过阈值才算拖窗帘，原地按下即抬起是「点图」
    wrap.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 300, width: 400, height: 300 });
    const pointer = (type, x) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        ev.clientX = x;
        ev.clientY = 150;
        ev.button = 0;
        return ev;
    };
    const lightbox = () => document.querySelector(".neo-lightbox");
    const closeLightbox = () => document.querySelector(".neo-lightbox-close").click();

    // 点分割线把手（未拖动）：窗帘不动，进灯箱看大图
    divider.dispatchEvent(pointer("pointerdown", 200));
    document.dispatchEvent(pointer("pointerup", 200));
    assert.equal(clip.style.clipPath, "inset(0 0 0 0%)", "点分割线不该动窗帘");
    assert.ok(lightbox(), "点分割线（未拖动）应打开灯箱看大图");
    closeLightbox();

    // 拖不到阈值（3px）：仍算点击，窗帘不动
    divider.dispatchEvent(pointer("pointerdown", 200));
    document.dispatchEvent(pointer("pointermove", 203));
    document.dispatchEvent(pointer("pointerup", 203));
    assert.equal(clip.style.clipPath, "inset(0 0 0 0%)", "拖不到阈值不该动窗帘");
    assert.ok(lightbox(), "拖不到阈值应算点击，打开灯箱");
    closeLightbox();

    // 点原图（未拖动）：看大图，窗帘不动
    const origEl = overlay.querySelector(".neo-gallery-edit-compare-img:not(.neo-gallery-edit-result-img)");
    origEl.dispatchEvent(pointer("pointerdown", 260));
    document.dispatchEvent(pointer("pointerup", 260));
    assert.equal(clip.style.clipPath, "inset(0 0 0 0%)", "点原图不该动窗帘");
    assert.ok(lightbox(), "点原图（未拖动）应打开灯箱看大图");
    closeLightbox();

    // 拖过阈值到 25%：只改裁切位置，不打开灯箱
    divider.dispatchEvent(pointer("pointerdown", 200));
    document.dispatchEvent(pointer("pointermove", 100));
    assert.equal(clip.style.clipPath, "inset(0 0 0 25%)", "拖动应把裁切位置换成分割线百分比");
    assert.equal(divider.style.left, "25%");
    assert.equal(clip.style.width, "", "拖动过程中结果层宽度始终不变");
    assert.equal(lightbox(), null, "拖窗帘不应打开灯箱");

    // 松手后继续移动不再改变窗帘；关窗后 document 上的监听要一并移除
    document.dispatchEvent(pointer("pointerup", 100));
    document.dispatchEvent(pointer("pointermove", 300));
    assert.equal(clip.style.clipPath, "inset(0 0 0 25%)", "松手后不应再跟随鼠标");
    divider.dispatchEvent(pointer("pointerdown", 100));
    overlay.remove();
    document.dispatchEvent(pointer("pointermove", 300));
    document.dispatchEvent(pointer("pointerup", 300));
    assert.equal(clip.style.clipPath, "inset(0 0 0 25%)", "关窗后 document 监听应已移除");
});

test("图片编辑弹窗：常规编辑成功后左侧换成缩放后的原图，两侧同尺寸才能逐像素对比", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");
    openImageEditDialog({ app: {}, maxThumbnailSize: 320, displayLabels: true },
                        { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
    ]));
    mockRoute("/neo_image_gen/settings", () => jsonResponse({ target_megapixels: 1.5 }));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "ie7", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/ie7", () => jsonResponse({
        task_id: "ie7", status: "succeeded", width: 32, height: 32, canvas: [32, 32],
        images: [{ filename: "edit_00001_.png", subfolder: "Output/2026-09-30", url: "/e.png" }],
    }));
    // 尺寸探针（桩为 8×6）回值 → 默认目标分辨率 32×32（32 对齐）
    await sleep(20);
    assert.equal(overlay.querySelector("#img-edit-width").value, "32");

    const origImg = () => overlay.querySelector(".neo-gallery-edit-compare-img:not(.neo-gallery-edit-result-img)");
    const label = () => overlay.querySelector(".neo-gallery-edit-compare-label");
    assert.equal(label().textContent, "原图 / 编辑结果（拖拽分割线对比）");

    inputText(overlay.querySelector(".neo-gallery-story-input"), "去掉头上的花");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(80);

    // 后端把原图缩放到目标尺寸后才送进模型，左侧也换成同一张（两侧同尺寸，窗帘才能逐像素对齐）
    assert.match(origImg().getAttribute("src"), /^data:image\/png/, "左侧应换成缩放后的原图");
    assert.match(label().textContent, /原图（缩放到 32×32）/, "标题应写明缩放尺寸");

    // 切到扩图：基准要用原图自然尺寸，左侧必须还原成原图
    click(overlay.querySelector(".neo-gallery-edit-outpaint-btn"));
    assert.match(origImg().getAttribute("src"), /filename=portrait\.png/, "扩图模式下左侧应还原成原图");
    assert.equal(label().textContent, "原图 / 编辑结果（拖拽分割线对比）");
});

test("图片编辑弹窗：扩图模式不替换左侧原图（扩图基准要用原图自然尺寸）", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");
    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
    ]));
    openImageEditDialog({ app: {}, maxThumbnailSize: 320, displayLabels: true },
                        { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);
    const origImgEl = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImgEl, key, { value, configurable: true });
    }
    mockRoute("/neo_image_gen/settings", () => jsonResponse({ target_megapixels: 1.5 }));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "ie9", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/ie9", () => jsonResponse({
        task_id: "ie9", status: "succeeded", width: 1024, height: 1024, canvas: [1024, 1024],
        images: [{ filename: "outp_00001_.png", subfolder: "Output/2026-10-03", url: "/o.png" }],
    }));

    click(overlay.querySelector(".neo-gallery-edit-outpaint-btn"));   // 开扩图
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(80);

    const origImg = overlay.querySelector(".neo-gallery-edit-compare-img:not(.neo-gallery-edit-result-img)");
    assert.match(origImg.getAttribute("src"), /filename=portrait\.png/, "扩图模式不应替换左侧原图");
    assert.equal(overlay.querySelector(".neo-gallery-edit-compare-label").textContent,
                 "原图 / 编辑结果（拖拽分割线对比）");
});

test("图片编辑弹窗：扩图比例预设按原图取最小覆盖框，反复切换不累积变大", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
    ]));

    openImageEditDialog({ app: {}, maxThumbnailSize: 320, displayLabels: true },
                        { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    // jsdom 无布局：显示 400×300（4:3），自然 800×600
    const origImgEl = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImgEl, key, { value, configurable: true });
    }
    click(overlay.querySelector(".neo-gallery-edit-outpaint-btn"));

    const canvasEl = overlay.querySelector(".neo-gallery-edit-outpaint-canvas");
    // 拖框由 CSS 铺满画布，几何要从画布盒 + 原图在画布内的偏移反读（+0 归一化 -0）
    const boxRect = () => [-parseFloat(origImgEl.style.left || "0") + 0, -parseFloat(origImgEl.style.top || "0") + 0,
                           parseFloat(canvasEl.style.width), parseFloat(canvasEl.style.height)];
    const ratioSel = overlay.querySelector(".neo-gallery-edit-ratio");
    const pickRatio = (r) => {
        ratioSel.value = r;
        ratioSel.dispatchEvent(new window.Event("change", { bubbles: true }));
    };
    // 锁住目标比例 + 盖住原图 + 主导方向贴满（= 该比例的最小覆盖框，原图不会被缩成一小块）
    const checkMin = (label, R) => {
        const [x, y, w, h] = boxRect();
        assert.ok(Math.abs(w / h - R) < 1e-6, `${label}: 框比例 ${w / h} 应锁在 ${R}`);
        assert.ok(x <= 1e-6 && y <= 1e-6 && x + w >= 400 - 1e-6 && y + h >= 300 - 1e-6,
                  `${label}: 框 ${JSON.stringify([x, y, w, h])} 应盖住原图 400×300`);
        assert.ok(Math.abs(Math.max(400 / w, 300 / h) - 1) < 1e-6,
                  `${label}: 框 ${w}×${h} 不是最小覆盖框，原图在框里被缩小了`);
        return [x, y, w, h];
    };

    pickRatio("1:1");
    const sq1 = checkMin("1:1", 1);
    assert.deepEqual(sq1, [0, -50, 400, 400]);
    pickRatio("16:9"); checkMin("16:9", 16 / 9);
    pickRatio("9:16"); checkMin("9:16", 9 / 16);
    pickRatio("3:4");  checkMin("3:4", 3 / 4);
    pickRatio("21:9"); checkMin("21:9", 21 / 9);
    // 旧实现以「当前框」为基准只放大不缩回，切几轮框就累积变大、原图缩成一小块
    pickRatio("1:1");
    assert.deepEqual(checkMin("切回 1:1", 1), sq1, "反复切换比例不应累积变大");
    pickRatio("16:9"); pickRatio("9:16"); pickRatio("21:9"); pickRatio("1:1");
    assert.deepEqual(checkMin("再切四轮 1:1", 1), sq1);
});


test("图片编辑面板：自定参数——默认收起不带覆盖，选主模型 + LoRA 后请求体带上，切扩图重放该技能配置", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
    ]));
    mockRoute("/neo_image_gen/models", () => jsonResponse({
        diffusion_models: ["krea2.safetensors", "qwen_image_2.1.safetensors"],
        text_encoders: ["qwen3vl_4b.safetensors"],
        vae: ["qwen_image_vae.safetensors"],
        loras: ["style_a.safetensors", "outpaint_lora.safetensors"],
        suggested_diffusion_models: "qwen_image_2.1.safetensors",
    }));
    mockRoute("/neo_image_gen/skill_config", (_b, call) => jsonResponse(
        call.query.get("skill_id") === "qwen_image_21_outpaint"
            ? { model: "qwen_image_2.1.safetensors", loras: [{ name: "outpaint_lora.safetensors", strength: 0.9 }] }
            : {}));
    mockRoute("/neo_image_gen/settings", () => jsonResponse({ target_megapixels: 1.5 }));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "ie_adv", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/ie_adv", () => jsonResponse({
        task_id: "ie_adv", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "edit_00001_.png", subfolder: "Output/2026-09-30", url: "/e.png" }],
    }));

    openImageEditDialog({ app: {}, maxThumbnailSize: 320, displayLabels: true },
                        { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(50);   // 模型列表 → 当前技能 config

    // 默认收起；展开后只有生图模型 + LoRA（TE / VAE 行裁掉），主模型回到「自动」
    const toggle = overlay.querySelector(".neo-gallery-edit-form .neo-gallery-gm-model-toggle");
    assert.ok(toggle, "图片编辑面板应有「自定参数」折叠行");
    const box = overlay.querySelector(".neo-gallery-edit-model-box");
    assert.ok(box, "应有自定参数区");
    assert.equal(box.style.display, "none", "默认收起");
    click(toggle);
    assert.notEqual(box.style.display, "none", "点击后应展开");
    assert.equal(box.querySelectorAll(".rs-gen-adv-row").length, 0, "只露出生图模型与 LoRA（无 TE / VAE 行）");
    const modelSel = box.querySelector(".rs-gen-model-section select");
    assert.equal(modelSel.value, "", "默认「自动」（跟随技能配置与全局设置），不预填");
    assert.equal(box.querySelectorAll(".rs-gen-lora-row").length, 0, "默认无 LoRA 行");

    // 自动态：请求体不带 model / loras 覆盖（不冲掉技能 config 与全局设置里的显式配置）
    inputText(overlay.querySelector(".neo-gallery-story-input"), "把背景换成海边日落");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(80);
    let req = fetchLog.filter((c) => c.path === "/neo_image_gen/generate").at(-1);
    assert.ok(!("model" in (req.body || {})), "自动态请求体不应带 model 覆盖");
    assert.ok(!("loras" in (req.body || {})), "自动态请求体不应带 loras 覆盖");

    // 选主模型 + 加一条 LoRA（强度 0.8）→「再生成」请求体带上覆盖
    modelSel.value = "krea2.safetensors";
    click(box.querySelector(".rs-gen-lora-add"));
    const loraRow = box.querySelector(".rs-gen-lora-row");
    assert.ok(loraRow, "应有 LoRA 行");
    loraRow.querySelector("select").value = "style_a.safetensors";
    loraRow.querySelector(".rs-gen-lora-strength").value = "0.8";
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "再生成"));
    await sleep(80);
    req = fetchLog.filter((c) => c.path === "/neo_image_gen/generate").at(-1);
    assert.equal(req.body.model, "krea2.safetensors", "请求体应带所选主模型");
    assert.deepEqual(req.body.loras, [{ name: "style_a.safetensors", strength: 0.8 }], "请求体应带所选 LoRA 与强度");

    // 开扩图：技能是程序切过去的（不触发 onchange），自定参数要重放到扩图技能 config 的模型与 LoRA
    const origImg = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImg, key, { value, configurable: true });
    }
    click(overlay.querySelector(".neo-gallery-edit-outpaint-btn"));
    await sleep(50);
    assert.equal(modelSel.value, "qwen_image_2.1.safetensors", "切扩图后主模型应重放该技能配置");
    assert.deepEqual([...box.querySelectorAll(".rs-gen-lora-row select")].map((s) => s.value),
                     ["outpaint_lora.safetensors"], "切扩图后 LoRA 行应重放该技能配置");
});

test("图片编辑弹窗：扩图锁定比例拖拽只等比缩放，不变形、不缩回原图内、不超封顶", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
    ]));

    openImageEditDialog({ app: {}, maxThumbnailSize: 320, displayLabels: true },
                        { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    const origImgEl = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImgEl, key, { value, configurable: true });
    }
    click(overlay.querySelector(".neo-gallery-edit-outpaint-btn"));

    const canvasEl = overlay.querySelector(".neo-gallery-edit-outpaint-canvas");
    const boxRect = () => [-parseFloat(origImgEl.style.left || "0") + 0, -parseFloat(origImgEl.style.top || "0") + 0,
                           parseFloat(canvasEl.style.width), parseFloat(canvasEl.style.height)];
    const ratioSel = overlay.querySelector(".neo-gallery-edit-ratio");
    const pickRatio = (r) => {
        ratioSel.value = r;
        ratioSel.dispatchEvent(new window.Event("change", { bubbles: true }));
    };
    const pointerAt = (el, type, x, y) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        ev.clientX = x;
        ev.clientY = y;
        ev.button = 0;
        el.dispatchEvent(ev);
    };
    const drag = (sel, x0, y0, x1, y1) => {
        pointerAt(overlay.querySelector(sel), "pointerdown", x0, y0);
        pointerAt(window, "pointermove", x1, y1);
        pointerAt(window, "pointerup", x1, y1);
    };
    const checkLock = (label, R) => {
        const [x, y, w, h] = boxRect();
        assert.ok(Math.abs(w / h - R) < 1e-6, `${label}: 框被拖成 ${w}×${h}（比例 ${w / h}），应锁在 ${R}`);
        assert.ok(x <= 1e-6 && y <= 1e-6 && x + w >= 400 - 1e-6 && y + h >= 300 - 1e-6,
                  `${label}: 框 ${JSON.stringify([x, y, w, h])} 应盖住原图 400×300`);
        return [x, y, w, h];
    };

    // 自由模式：手柄按边伸缩，不锁比例
    drag(".neo-gallery-edit-outpaint-handle-se", 400, 300, 500, 360);
    assert.deepEqual(boxRect(), [0, 0, 500, 360]);

    pickRatio("1:1");
    checkLock("1:1 预设", 1);
    drag(".neo-gallery-edit-outpaint-handle-se", 400, 350, 500, 450);
    checkLock("1:1 拖 se 放大", 1);
    drag(".neo-gallery-edit-outpaint-handle-n", 200, -45, 200, -345);
    checkLock("1:1 拖 n 放大", 1);
    // 把手拖过对边：缩放系数会掉到 0 甚至负数，下限必须锁在「仍盖住原图」
    drag(".neo-gallery-edit-outpaint-handle-n", 200, -420, 200, 900);
    checkLock("1:1 拖 n 拖过对边", 1);
    // 封顶：拖再远也不超过原图 4 倍，封顶后仍是 1:1
    drag(".neo-gallery-edit-outpaint-handle-se", 400, 400, 9000, 9000);
    const [x, y, w, h] = checkLock("1:1 封顶", 1);
    assert.ok(w <= 1600 + 1e-6 && h <= 1200 + 1e-6, `封顶失效：${w}×${h}`);
});

test("图片编辑弹窗：看大图——点原图/点分割线（未拖动）进灯箱，拖过阈值才算拖窗帘；按钮各模式通用", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
        { id: "qwen_image_21_outpaint", cn_name: "Qwen Image 2.1 扩图", category: "image_gen", gen_image: true, mode: "edit", requires_ref: true },
    ]));

    openImageEditDialog({ app: {}, maxThumbnailSize: 320, displayLabels: true },
                        { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    const origImgEl = overlay.querySelector(".neo-gallery-edit-compare-imgwrap img");
    for (const [key, value] of [["clientWidth", 400], ["clientHeight", 300],
                                ["naturalWidth", 800], ["naturalHeight", 600]]) {
        Object.defineProperty(origImgEl, key, { value, configurable: true });
    }

    const pointerAt = (el, type, x, y) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        ev.clientX = x;
        ev.clientY = y;
        ev.button = 0;
        el.dispatchEvent(ev);
    };
    const lightbox = () => document.querySelector(".neo-lightbox");
    const closeLightbox = () => document.querySelector(".neo-lightbox-close")?.click();

    // 标签行的「看大图」：局部/点选模式点图是涂抹/打点，灯箱只能从这里进
    const zoomBtn = overlay.querySelector(".neo-gallery-edit-zoom-btn");
    assert.ok(zoomBtn, "标签行应有「看大图」按钮");
    click(zoomBtn);
    assert.ok(lightbox(), "「看大图」应打开灯箱");
    closeLightbox();

    // 常规模式：点原图（未拖动）看大图；在原图上拖过阈值是拖窗帘，不进灯箱
    const wrap = overlay.querySelector(".neo-gallery-edit-compare-imgwrap");
    wrap.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 300, width: 400, height: 300 });
    pointerAt(origImgEl, "pointerdown", 200, 150);
    pointerAt(document, "pointerup", 200, 150);
    assert.ok(lightbox(), "常规模式点原图（未拖动）应打开灯箱");
    closeLightbox();

    pointerAt(origImgEl, "pointerdown", 200, 150);
    pointerAt(document, "pointermove", 100, 150);
    pointerAt(document, "pointerup", 100, 150);
    assert.equal(lightbox(), null, "在原图上拖过阈值是拖窗帘，不应打开灯箱");

    // 开扩图：拖框铺满画布，原图点不到 → 框体上按下即抬起就是点图
    click(overlay.querySelector(".neo-gallery-edit-outpaint-btn"));
    await sleep(10);
    const boxEl = overlay.querySelector(".neo-gallery-edit-outpaint-box");

    pointerAt(boxEl, "pointerdown", 200, 150);
    pointerAt(window, "pointerup", 200, 150);
    assert.ok(lightbox(), "扩图模式点框体（未拖动）应打开灯箱");
    closeLightbox();

    pointerAt(boxEl, "pointerdown", 200, 150);
    pointerAt(window, "pointermove", 120, 150);
    pointerAt(window, "pointerup", 120, 150);
    assert.equal(lightbox(), null, "拖动框体只挪留白，不应打开灯箱");

    pointerAt(overlay.querySelector(".neo-gallery-edit-outpaint-handle-se"), "pointerdown", 400, 300);
    pointerAt(window, "pointerup", 400, 300);
    assert.equal(lightbox(), null, "按手柄（含原地抬起）是抓取，不应打开灯箱");
});


test("图片编辑弹窗：点图看大图按窗帘位置定——窗帘右侧看结果图、左侧看原图", async () => {
    resetEnv();
    clearRoutes();
    const { openImageEditDialog } = await import("../../web/gallery-gen.js");

    mockRoute("/rs_prompts/skills", () => jsonResponse([
        { id: "qwen_image_21", cn_name: "Qwen Image 2.1", category: "image_gen", gen_image: true, mode: "t2i_edit" },
    ]));
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "portrait.png" }));
    mockRoute("/neo_image_gen/generate", () => jsonResponse({ task_id: "ie13", status: "queued", images: [] }));
    mockRoute("/neo_image_gen/status/ie13", () => jsonResponse({
        task_id: "ie13", status: "succeeded", width: 1024, height: 1024,
        images: [{ filename: "edit_00013_.png", subfolder: "Output/2026-10-16", url: "/view?filename=edit_00013_.png&type=output" }],
    }));

    openImageEditDialog({ app: {}, maxThumbnailSize: 320, displayLabels: true },
                        { name: "portrait", filename: "portrait.png" }, "");
    const overlay = document.querySelector(".neo-gallery-edit-modal-overlay");
    await sleep(20);

    const wrap = overlay.querySelector(".neo-gallery-edit-compare-imgwrap");
    const clip = overlay.querySelector(".neo-gallery-edit-result-clip");
    const divider = overlay.querySelector(".neo-gallery-edit-divider");
    const origEl = overlay.querySelector(".neo-gallery-edit-compare-img:not(.neo-gallery-edit-result-img)");
    wrap.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 300, width: 400, height: 300 });
    const pointer = (el, type, x) => {
        const ev = new window.Event(type, { bubbles: true, cancelable: true });
        ev.clientX = x;
        ev.clientY = 150;
        ev.button = 0;
        el.dispatchEvent(ev);
    };
    const caption = () => document.querySelector(".neo-lightbox-caption")?.textContent;
    const closeLightbox = () => document.querySelector(".neo-lightbox-close")?.click();

    inputText(overlay.querySelector(".neo-gallery-story-input"), "换上性感衣服");
    click([...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent === "生成"));
    await sleep(80);
    assert.equal(clip.style.clipPath, "inset(0 0 0 0%)", "生成后窗帘贴左边界：整幅都是结果图");

    // 窗帘贴左：可见的全是结果图，点图看的就是结果大图（旧写法固定开原图）
    pointer(origEl, "pointerdown", 200);
    pointer(document, "pointerup", 200);
    assert.equal(caption(), "edit_00013_.png", "窗帘贴左时点图应看结果大图");
    closeLightbox();

    // 拖窗帘到 65%：左侧露原图、右侧露结果，点哪一侧看哪张
    pointer(divider, "pointerdown", 200);
    pointer(document, "pointermove", 260);
    pointer(document, "pointerup", 260);
    assert.equal(clip.style.clipPath, "inset(0 0 0 65%)", "拖过阈值应把窗帘移到 65%");

    pointer(origEl, "pointerdown", 100);
    pointer(document, "pointerup", 100);
    assert.equal(caption(), "portrait.png", "窗帘左侧点图应看原图");
    closeLightbox();

    pointer(origEl, "pointerdown", 380);
    pointer(document, "pointerup", 380);
    assert.equal(caption(), "edit_00013_.png", "窗帘右侧点图应看结果大图");
    closeLightbox();

    // 窗帘贴右：整幅都是原图，点哪里都只看原图
    pointer(divider, "pointerdown", 380);
    pointer(document, "pointermove", 400);
    pointer(document, "pointerup", 400);
    assert.equal(clip.style.clipPath, "inset(0 0 0 100%)", "窗帘应贴到右边界");
    pointer(origEl, "pointerdown", 380);
    pointer(document, "pointerup", 380);
    assert.equal(caption(), "portrait.png", "窗帘贴右时点图应看原图");
    closeLightbox();

    // 点分割线把手（未拖动）：把手是边界，固定看原图
    pointer(divider, "pointerdown", 200);
    pointer(document, "pointerup", 200);
    assert.equal(caption(), "portrait.png", "点分割线把手应看原图");
    closeLightbox();

    // 结果图挂在灯箱列表末尾：从原图 → 翻页能到结果大图
    click(overlay.querySelector(".neo-gallery-edit-zoom-btn"));
    assert.equal(caption(), "portrait.png", "「看大图」按钮从原图进");
    document.querySelector(".neo-lightbox-next").click();
    assert.equal(caption(), "edit_00013_.png", "→ 翻页应能翻到结果大图");
    closeLightbox();
});

