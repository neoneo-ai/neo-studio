// 绘画页的中间舞台：右栏那一轮智能体的过程与产物在页面生成面板下方放大显示，模式条与面板留在上方。
// 舞台只吃实时帧（右栏同一路 SSE 交过来），自己不留状态——新的 run 帧一到就清场，
// 中间永远只有当前这一轮；产物点开走弹出窗口，页面自己不导航。
// 偏好表单里那一项开关（本机 localStorage，不进 configs/agent_prefs.json 的六个字段）
// 关掉时整块摘掉，绘画页回到没有舞台的布局。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetEnv, flush, sleep, mockRoute, clearRoutes, jsonResponse, sseResponse, click, inputText, fetchLog } from "./setup.mjs";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const studioBody = fs.readFileSync(path.join(webDir, "studio", "index.html"), "utf8").match(/<body>([\s\S]*?)<\/body>/)[1];

let seq = 0;
const importApp = () => import(`../../web/studio/studio-app.js?stage=${seq++}`);

const SKILLS = [{ id: "sk_cat", name: "cat_prompt", cn_name: "橘猫技能", category: "image_gen", gen_image: true }];
const RUN_ID = "0123456789abcdef0123456789abcdef";
const PREFS_GET = { preferred_skill: "sk_cat", preferred_size: "1:1", preferred_family: "", style_notes: "", avoid: "", confirm_films: false };

// hashchange 在 jsdom 里是宏任务：设完 hash 要等一轮事件循环，路由才把页面切过去
const settle = async () => { await sleep(0); await flush(); };

async function openStudio() {
    resetEnv();
    clearRoutes();
    document.body.innerHTML = studioBody;
    mockRoute("/neo_studio/version", jsonResponse({ success: true, plugin_version: "9.9.9", comfyui_version: "0.1", recipes: [] }));
    mockRoute("/rs_prompts/skills", jsonResponse(SKILLS));
    mockRoute("/neo_image_gen/models", jsonResponse({ diffusion_models: ["krea2/krea2_turbo.safetensors"] }));
    mockRoute("/neo_image_gen/settings", jsonResponse({ target_megapixels: 1.5 }));
    mockRoute("/neo_video_gen/settings", jsonResponse({}));
    mockRoute("/neo_agent/prefs", (body, call) => jsonResponse(
        call.method === "POST" ? { ok: true, prefs: PREFS_GET } : { ok: true, prefs: PREFS_GET }));
    window.location.hash = "#/paint";
    await importApp();
    await settle();
    await settle();
    click(document.getElementById("ns-agent-toggle"));
    await flush(20);
}

const dock = () => document.querySelector("#ns-agent-dock");
const input = () => dock().querySelector(".neo-agent-input");
const runBtn = () => dock().querySelector(".neo-agent-run");
const stage = () => document.querySelector(".ns-paint .ns-agent-stage");
const stageHost = () => document.querySelector(".ns-paint .ns-paint-stage");
const paintMain = () => document.querySelector(".ns-paint .ns-paint-main");
const stageMedia = () => [...stage().querySelectorAll(".ns-agent-stage-media img, .ns-agent-stage-media video")];
const stagePreviewBox = () => stage().querySelector(".ns-agent-stage-preview");
const stageRows = () => [...stage().querySelectorAll(".ns-agent-stage-plan-row")].map((r) => r.textContent);
const stageFoot = () => stage().querySelector(".ns-agent-stage-plan-foot").textContent;
const stageFacts = () => [...stage().querySelectorAll(".ns-agent-stage-fact")].map((c) => c.textContent);
const stageStatus = () => stage().querySelector(".ns-agent-stage-status").textContent;
const stageIdle = () => stage().querySelector(".ns-agent-stage-idle");
const stageAnswer = () => stage().querySelector(".ns-agent-stage-answer");
const stageToggle = () => document.querySelector('.ns-agent-prefs [name="stage_mode"]');
const previewToggle = () => document.querySelector('.ns-agent-prefs [name="preview_mode"]');
const prefsSaveBtn = () => document.querySelector(".ns-prefs-save");
const prefsPosts = () => fetchLog.filter((c) => c.path === "/neo_agent/prefs" && c.method === "POST");
const runPosts = () => fetchLog.filter((c) => c.path === "/neo_agent/run" && c.method === "POST");

function mockStream(frames) {
    mockRoute("/neo_agent/run", () => sseResponse(
        frames.map((f) => `data: ${JSON.stringify(f)}`).concat("data: [DONE]")));
}

async function run(frames) {
    mockStream(frames);
    inputText(input(), "画一只橘猫");
    click(runBtn());
    await flush(40);
}

// 一轮完整帧：清场 → 清单 → 焦点链 → 工具 → 产物 → 清单划掉 → 收场
const ROUND = [
    { kind: "run", run_id: RUN_ID },
    { kind: "plan_steps", steps: [{ tool: "generate_image", key_args: "1 张", note: "出图", done: false },
                                   { tool: "save_recipe", key_args: "橘猫", note: "存配方", done: false }] },
    { kind: "focus", focus: { skill_id: "sk_cat", model: "krea2/krea2_turbo.safetensors", loras: ["a.safetensors"], width: 1024, height: 1024, seed: 7, prompt: "橘猫" } },
    { kind: "tool_call", tool: "generate_image", text: "{}" },
    { kind: "tool_result", tool: "generate_image", text: "出了 2 张", media: [
        { kind: "image", url: "/view?filename=a.png&subfolder=&type=output", title: "a" },
        { kind: "video", url: "/view?filename=b.mp4&subfolder=&type=output", title: "b" }] },
    { kind: "plan_steps", steps: [{ tool: "generate_image", key_args: "1 张", note: "出图", done: true },
                                   { tool: "save_recipe", key_args: "橘猫", note: "存配方", done: false }] },
    { kind: "finish", text: "出好了：2 张", media: [{ kind: "image", url: "/view?filename=c.png&subfolder=&type=output", title: "c" }], options: [] },
];

const gear = () => [...dock().querySelectorAll(".neo-agent-head-btn")].find((b) => b.title.includes("智能体偏好"));
const SIX_PREFS = ["avoid", "confirm_films", "preferred_family", "preferred_size", "preferred_skill", "style_notes"];

test("绘画页下方有中间舞台：一轮跑完后过程、焦点事实与产物铺在生成面板下面", async () => {
    await openStudio();
    assert.ok(stageHost(), "绘画页应有舞台宿主");
    assert.ok(stage(), "默认开关下绘画页应挂着舞台");
    assert.ok(!stage().hidden, "挂着的舞台应可见");
    // 舞台挂在生成面板与显存条之后：产物那一大块放大时不把本页原界面挤下去
    assert.equal([...paintMain().children].at(-1), stageHost(), "舞台宿主应是右栏最后一块");
    assert.ok(paintMain().querySelector(".ns-paint-panel"), "生成面板应在舞台之上");
    assert.match(stageIdle().textContent, /右栏/, "没跑过就只有一行说明");

    await run(ROUND);

    assert.ok(stageIdle().hidden, "跑起来后不该还铺那行说明");
    assert.equal(stageMedia().length, 3, "两次产物共 3 张图 / 片铺成大图格");
    assert.equal(stageMedia()[1].tagName.toLowerCase(), "video", "mp4 产物铺成可播放的片");
    assert.equal(stageRows().length, 2, "执行清单整份重铺，两条一步不落");
    assert.match(stageRows()[0], /^1\. generate_image（1 张）：出图$/, "划掉的行打勾并带上关键参数");
    assert.match(stageFoot(), /1\/2 已完成/, "进度按整张清单算");
    assert.deepEqual(stageFacts(), ["技能 sk_cat", "主模型 krea2/krea2_turbo.safetensors",
        "LoRA a.safetensors", "宽 1024", "高 1024"], "中间只铺用户在放映区认得出的事实");
    assert.match(stageStatus(), /本轮完成/, "收场后状态行写明这一轮已收场");
    assert.match(stageAnswer().textContent, /出好了：2 张/, "最终回答落在中间");
    assert.equal(runPosts()[0].body.preview_side, 1024, "舞台挂着时要全尺寸预览档：帧铺在中间才不糊");
});

// 中间那一块的归属：采样动画只在跑的时候占位，产物一到就退场换结果图。
// 退场后新的采样步要重新上台——pause() 过的播放器不收迟到载荷，留着会把新帧吃掉
const PREVIEW_STEP = { frames: ["data:image/jpeg;base64,AAAA"], fps: 4 };

test("产物一到预览退场：中间那一块换给结果图，新的采样步再回到台上", async () => {
    await openStudio();
    await run([
        { kind: "run", run_id: RUN_ID },
        { kind: "tool_call", tool: "generate_image", text: "{}" },
        { kind: "status", text: "采样中", preview: PREVIEW_STEP },
    ]);
    assert.ok(!stagePreviewBox().hidden, "采样在跑时预览应铺在中间");
    assert.equal(stageMedia().length, 0, "产物到达之前中间不该有图");

    await run([
        { kind: "run", run_id: RUN_ID },
        { kind: "status", text: "采样中", preview: PREVIEW_STEP },
        { kind: "tool_result", tool: "generate_image", text: "出了 1 张", media:
            [{ kind: "image", url: "/view?filename=a.png&subfolder=&type=output", title: "a" }] },
        { kind: "finish", text: "出好了：1 张", media: [], options: [] },
    ]);
    assert.ok(stagePreviewBox().hidden, "产物上台后采样预览不该还占着中间那一块");
    assert.equal(stageMedia().length, 1, "结果图应铺在中间那一块");

    await run([
        { kind: "run", run_id: "ffffffffffffffffffffffffffffffff" },
        { kind: "tool_result", tool: "list_models", text: "{}" },
        { kind: "status", text: "采样中", preview: PREVIEW_STEP },
    ]);
    assert.ok(!stagePreviewBox().hidden, "没有产物的新采样步应把预览接回中间");
    assert.equal(stagePreviewBox().querySelectorAll(".neo-dtl-live-img").length, 1,
        "退场再上台只挂一个播放器：旧实例的节点不该留在中间");

    const css = fs.readFileSync(path.join(webDir, "studio", "style.css"), "utf8");
    const mediaMax = Number(css.match(/\.ns-agent-stage-media img[^\n]*\n\s*width[^}]*max-height: (\d+)px/)[1]);
    const previewRule = css.match(/\.ns-agent-stage-preview \{[^}]*\}/)[0];
    assert.ok(!/[^-]height:\s*\d+px/.test(previewRule),
        "采样预览块不该有定高：定高配 100% 宽会把竖图裁成头部特写");
    const previewSide = Number(fs.readFileSync(path.join(webDir, "agent-stage.js"), "utf8")
        .match(/const PREVIEW_MAX_SIDE = (\d+)/)[1]);
    assert.ok(previewSide <= mediaMax,
        `采样预览最长边（${previewSide}px）不该高过结果图块（${mediaMax}px）：产物才是这一轮的主体`);
});

// 竖图那一档：块宽跟着画面宽高比走，高由图自己定（定高 + 100% 宽 = 竖图被裁成头部特写）
const PREVIEW_TALL = { frames: ["data:image/jpeg;base64,AAAA"], fps: 4, w: 768, h: 1344 };
const PREVIEW_WIDE = { frames: ["data:image/jpeg;base64,BBBB"], fps: 4, w: 1344, h: 768 };

test("竖图预览按画面比例定块宽：竖图铺成整张竖图，横图仍铺满块宽上限", async () => {
    await openStudio();
    await run([
        { kind: "run", run_id: RUN_ID },
        { kind: "tool_call", tool: "generate_image", text: "{}" },
        { kind: "status", text: "采样中", preview: PREVIEW_TALL },
    ]);
    assert.equal(stagePreviewBox().style.maxWidth, "274px",
        "768x1344 的竖图：块宽 = 最长边 480 × 宽高比 = 274px，图整张落在块里不裁");

    await run([
        { kind: "run", run_id: RUN_ID },
        { kind: "tool_call", tool: "generate_image", text: "{}" },
        { kind: "status", text: "采样中", preview: PREVIEW_WIDE },
    ]);
    assert.equal(stagePreviewBox().style.maxWidth, "720px",
        "1344x768 的横图：块宽取 CSS 上限 720px，高按画面比例落回 480 那一档");
});

test("新的 run 帧清场：中间只有当前这一轮，不堆第二条历史", async () => {
    await openStudio();
    await run(ROUND);
    assert.equal(stageMedia().length, 3);

    await run([
        { kind: "run", run_id: "ffffffffffffffffffffffffffffffff" },
        { kind: "tool_result", tool: "generate_image", text: "出了 1 张",
          media: [{ kind: "image", url: "/view?filename=d.png&subfolder=&type=output", title: "d" }] },
    ]);

    assert.equal(stageMedia().length, 1, "上一轮的产物不能留在中间");
    assert.equal(stageRows().length, 0, "上一轮的清单也应清掉");
    assert.ok(!stageAnswer().textContent, "上一轮的最终回答也应清掉");
    assert.match(stageMedia()[0].src, /d\.png/, "中间留下的应是这一轮的产物");
});

// generate_image 的 tool_result 交一次产物，finish_task 收场时按同一批产物名再交一次：中间只认 url，
// 第二遍是重复像素，不该在结果区铺成第二格
test("同一张产物只铺一格：finish_task 重交的产物不在中间铺第二遍", async () => {
    await openStudio();
    await run([
        { kind: "run", run_id: RUN_ID },
        { kind: "tool_result", tool: "generate_image", text: "出了 1 张", media:
            [{ kind: "image", url: "/view?filename=a.png&subfolder=&type=output", title: "a" }] },
        { kind: "finish", text: "出好了：2 张", media: [
            { kind: "image", url: "/view?filename=a.png&subfolder=&type=output", title: "a" },
            { kind: "image", url: "/view?filename=c.png&subfolder=&type=output", title: "c" }],
          options: [] },
    ]);
    assert.deepEqual(stageMedia().map((n) => n.getAttribute("src")),
        ["/view?filename=a.png&subfolder=&type=output", "/view?filename=c.png&subfolder=&type=output"],
        "a.png 只铺一格，收场里没铺过的 c.png 照铺");
});


test("舞台产物点开放大窗口：看大图不把页面切走", async () => {
    await openStudio();
    await run(ROUND);
    click(stageMedia()[0]);
    assert.ok(document.querySelector(".neo-lightbox"), "点产物应开弹出窗口");
    assert.match(window.location.hash, /#\/paint/, "看大图不该把页面切走");
});

test("偏好表单里关掉中间舞台：绘画页摘掉舞台，开关只存本机偏好，不进偏好文件", async () => {
    await openStudio();
    await run(ROUND.slice(0, 5));
    assert.ok(stage(), "开局应有舞台");

    click(gear());
    await flush(20);
    const box = stageToggle();
    assert.ok(box, "偏好表单应有中间舞台开关");
    assert.ok(box.checked, "默认开");

    click(box);   // jsdom 的 checkbox 点击自带 change
    await flush(10);
    assert.equal(box.checked, false, "点一下应翻成关");
    assert.ok(!stage(), "关掉后绘画页不该还挂着舞台");
    assert.ok(stageHost(), "宿主留着：绘画页回到没有舞台的布局");
    assert.equal(window.localStorage.getItem("neo_studio_agent_stage"), "0", "开关存本机偏好");

    // 关着的一轮：右栏照旧收帧，中间不留任何东西
    await run([
        { kind: "run", run_id: RUN_ID },
        { kind: "tool_result", tool: "generate_image", text: "出了 1 张",
          media: [{ kind: "image", url: "/view?filename=e.png&subfolder=&type=output", title: "e" }] },
    ]);
    assert.ok(!stage(), "关着的开关不该把舞台挂回来");
    assert.equal(dock().querySelectorAll(".neo-agent-media img").length, 1, "右栏产物不受开关影响");
    assert.equal(runPosts()[1].body.preview_side, 384, "关掉舞台后回到右栏卡片那一档：栏子就这么宽，别白灌带宽");

    // 重进那一栏会重读偏好：后端读回来的只有六个字段，改不动界面开关
    click(gear());
    await flush(20);
    assert.equal(stageToggle().checked, false, "重读偏好不应把界面开关按后端值改回去");

    click(prefsSaveBtn());
    await flush(20);
    const posts = prefsPosts();
    assert.equal(posts.length, 1, "保存只发一次");
    assert.deepEqual(Object.keys(posts[0].body).sort(), SIX_PREFS, "保存只发后端收净的那六个字段");
    assert.ok(!("stage_mode" in posts[0].body), "界面开关不该进偏好请求体");

    click(stageToggle());
    await flush(10);
    assert.ok(stage(), "重新打开应把舞台挂回绘画页顶部");
    assert.equal(window.localStorage.getItem("neo_studio_agent_stage"), "1");
});

// 采样预览是本机开关（与舞台开关同类，存同一份 localStorage 偏好）：关掉就是这一轮向后端要 0 档，
// SSE 里不再有 base64 帧，中间与右栏都不铺动画；中途关掉要把在跑的动画立刻收掉
test("偏好表单里关掉采样预览：这一轮向后端要 0 档，中间与右栏都不铺动画", async () => {
    const SAMPLING = [{ kind: "run", run_id: RUN_ID },
                      { kind: "tool_call", tool: "generate_image", text: "{}" },
                      { kind: "status", text: "采样中", preview: PREVIEW_STEP }];
    await openStudio();
    await run(SAMPLING);
    assert.ok(!stagePreviewBox().hidden, "默认开：采样在跑时中间铺动画");

    click(gear());
    await flush(20);
    const box = previewToggle();
    assert.ok(box, "偏好表单应有采样预览开关");
    assert.ok(box.checked, "默认开");

    click(box);   // 中途关掉：在跑的动画立刻收掉
    await flush(10);
    assert.equal(window.localStorage.getItem("neo_studio_agent_preview"), "0", "开关存本机偏好");
    assert.ok(stagePreviewBox().hidden, "关掉后中间不该还铺着动画");
    assert.equal(stagePreviewBox().querySelectorAll(".neo-dtl-live-img").length, 0,
        "关掉应把播放器整个收掉，不是只藏起来");

    // 后端这一轮收不到 preview_side 就要发货载：关掉后要的是 0 档，迟到帧也不接回中间
    await run(SAMPLING);
    assert.equal(runPosts()[1].body.preview_side, 0, "关掉后这一轮要 0 档：SSE 里不该有 base64 帧");
    assert.ok(stagePreviewBox().hidden, "关着的开关不该把动画接回中间");
    const lastCard = () => [...dock().querySelectorAll(".neo-agent-tool")].at(-1);
    assert.equal(lastCard().querySelectorAll(".neo-agent-tool-preview .neo-dtl-live-img").length, 0,
        "右栏这一张卡片同样不铺播放器");

    click(prefsSaveBtn());
    await flush(20);
    assert.deepEqual(Object.keys(prefsPosts()[0].body).sort(), SIX_PREFS,
        "采样预览开关不进偏好请求体，只写本机 localStorage");

    // 跑完一轮后右栏回到时间线，重开那一栏才摸得到开关
    click(gear());
    await flush(20);
    click(previewToggle());
    await flush(10);
    assert.equal(window.localStorage.getItem("neo_studio_agent_preview"), "1");
    await run(SAMPLING);
    assert.equal(runPosts()[2].body.preview_side, 1024, "重新打开要回舞台那一档");
    assert.ok(!stagePreviewBox().hidden, "重新打开后的采样步应把动画接回中间");
});

// 失败收场的那一行重试：整段提示词在提交这一步就离开输入框了，LLM 502 这类一次性失败要用户
// 重打一遍是说不过去的。这一行按上一发的文本、模式与附件图原样重发，跑成之后收掉
const sseLines = (frames) => frames.map((f) => `data: ${JSON.stringify(f)}`);
const retryBar = () => dock().querySelector(".neo-agent-retrybar");

test("LLM 失败收场给一行重试键：按上一发原样重发，跑成之后那一行收掉", async () => {
    await openStudio();
    let answer = 0;
    mockRoute("/neo_agent/run", () => sseResponse(
        answer++ === 0
            ? sseLines([{ kind: "run", run_id: RUN_ID }])
                .concat("data: [ERROR] Remote LLM HTTP 502: Error code: 502", "data: [DONE]")
            : sseLines(ROUND).concat("data: [DONE]")));

    inputText(input(), "画一个学生图片");
    click(runBtn());
    await flush(40);

    assert.ok(retryBar(), "失败收场应有重试那一行");
    assert.ok(!retryBar().hidden, "失败后那一行应铺出来");
    assert.match(retryBar().textContent, /重试.*画一个学生图片/, "那一行写明重发的是哪一句");
    assert.match(dock().querySelector(".neo-agent-answer-error").textContent, /502/, "右栏写明失败原因");
    assert.equal(input().value, "", "整段原文在提交时已离开输入框：重发只能靠那一行");
    assert.equal(runPosts()[0].body.text, "画一个学生图片");

    // 输入框里写着一发新的就不动手：那一行重发的是上一发，不能把草稿覆盖掉
    inputText(input(), "换一个背景");
    click(retryBar());
    await flush(20);
    assert.equal(runPosts().length, 1, "有草稿时点重试不发请求");
    assert.ok(!retryBar().hidden, "被草稿挡住时那一行留在原地");
    inputText(input(), "");

    click(retryBar());
    await flush(40);
    assert.equal(runPosts().length, 2, "点那一行应重发一次");
    assert.equal(runPosts()[1].body.text, "画一个学生图片", "重发的是上一发的原文，不用重新输入");
    assert.equal(runPosts()[1].body.mode, "act", "模式跟着上一发");
    assert.equal(runPosts()[1].body.preview_side, 1024, "重发按当前布局要预览档：舞台挂着");
    assert.ok(!("resume" in runPosts()[1].body), "重发是新的一轮，不接旧会话");
    assert.ok(retryBar().hidden, "跑成了的一轮收掉那一行");
    assert.match(stageAnswer().textContent, /出好了/, "重发这一轮的过程照旧铺在中间");
});
