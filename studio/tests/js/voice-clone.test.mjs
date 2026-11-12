// Studio「声音克隆」页（web/voice-clone/voice-clone.js）：取参考音频 → 写文字 → 排队/合成进度 → 结果波形。
// 生成链与素材卡 ⋯ 菜单那条同源（voice-gen.js：/neo_voice/*，进度认 rs.voice_gen.status 事件），
// 波形控件也是那一份（gallery-card-tools.js 导出的 voiceAudioWidget），页面自己不重写波形。
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, click, flush, sleep } from "./setup.mjs";
import { dispatchApiEvent } from "./mocks/comfy-api.mjs";
import { app as comfyApp, appState, resetSidebarTab } from "./mocks/comfy-app.mjs";
import { $el } from "../../web/studio/shim/ui.js";
// voice-clone.js 顶层导入 gallery-utils.js 与 gallery-card-tools.js（都要 scripts/* 的 shim），
// 必须等 setup.mjs 装好钩子再动态取
const { createVoiceCloneView, voiceStatusLabel, voiceProgressPct, VOICE_OUT_DIR } =
    await import("../../web/voice-clone/voice-clone.js");

// 用例的 mock 在建视图之前就注册，先清掉上一条用例留下的路由表
beforeEach(() => clearRoutes());

const settle = async () => { await flush(20); await sleep(0); await flush(20); };

const snap = (taskId, over = {}) => ({
    task_id: taskId, prompt_id: "P1", status: "queued", created: 0, updated: 0,
    prompt: "你好，世界", seed: 1, audios: [], progress: null, error: "", warnings: [], ...over,
});

function mockVoiceRoutes(taskId = "T1") {
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "voice_ref.wav" }));
    mockRoute("/neo_image_gen/skill_config", () => jsonResponse({ default_prompt: "你好，世界，这是一段语音测试。" }));
    mockRoute("/neo_voice/generate", () => jsonResponse(snap(taskId)));
    mockRoute("/neo_voice/status/*", () => jsonResponse(snap(taskId)));
    mockRoute("/neo_voice/cancel/*", () => jsonResponse({ success: true }));
}

function mounted() {
    const host = $el("div");
    document.body.appendChild(host);
    const gated = [];
    let pickCb = null;
    const build = createVoiceCloneView({
        $el,
        openMaterial: (cb) => { pickCb = cb; },
        gateRun: (btn, feature, label) => gated.push({ btn, feature, label }),
    });
    const env = {
        host, gated,
        pick: (item) => {
            click(env.button("从素材库选音频"));   // 弹窗由宿主开：用例只把交回来的那一项喂进回调
            pickCb?.(item);
        },
        button: (label) => [...host.querySelectorAll(".ns-voice-btn")].find((b) => b.textContent.includes(label)),
        text: () => host.querySelector(".ns-voice-text"),
        status: () => host.querySelector(".ns-voice-status"),
        track: () => host.querySelector(".ns-voice-track"),
        fill: () => host.querySelector(".ns-voice-fill"),
        result: () => host.querySelector(".ns-voice-result"),
    };
    return build(host).then(() => env);
}

test("进度读数与百分比：只有 running 说成合成中，没有步数就是 0（样式那侧走不定长条）", () => {
    assert.equal(voiceStatusLabel("running"), "合成中…");
    assert.equal(voiceStatusLabel("queued"), "排队中…");
    assert.equal(voiceProgressPct({ value: 1, max: 4 }), 25);
    assert.equal(voiceProgressPct(null), 0);
    assert.equal(voiceProgressPct({ value: 9, max: 4 }), 100, "越界的读数不该把条撑出去");
    assert.equal(VOICE_OUT_DIR, "Voice", "与 studio/voice_gen.py 的 Output/Voice 同值");
});

test("没选音频时只有起手卡片：生成不出可点的控件，按钮交宿主闸门", async () => {
    resetEnv();
    const env = await mounted();
    assert.ok(env.host.querySelector(".ns-voice-empty"), "起手卡片要告诉用户从哪儿起手");
    assert.ok(env.host.querySelector(".ns-voice-composer").hidden, "没有参考音频就没有生成区");
    assert.ok(env.button("生成").disabled, "能力用不到就不出可点的按钮");
    assert.ok(env.button("取消任务").hidden, "没有任务在跑就不出取消");
    assert.deepEqual(env.gated.map((g) => [g.feature, g.label]), [["voice", "生成"]]);
});

test("素材库点来的音频落参考波形：路径、波形控件与技能默认文字一起跟上", async () => {
    resetEnv();
    mockVoiceRoutes();
    const env = await mounted();
    env.pick({ filename: "voice_ref.wav", subfolder: "Output/Voice" });
    await settle();
    assert.equal(env.host.querySelector(".ns-voice-pill").textContent, "Output/Voice/voice_ref.wav");
    assert.ok(env.host.querySelector(".ns-voice-ref .neo-gallery-audio-waveform"), "参考音频要有波形与播放按钮");
    assert.ok(env.host.querySelector(".ns-voice-ref .neo-gallery-audio-play-btn"));
    assert.equal(env.text().value, "你好，世界，这是一段语音测试。", "预填与素材卡语音弹窗同一份来源");
    assert.ok(env.host.querySelector(".ns-voice-empty").hidden, "有音频了就该收起手卡片");
    assert.ok(!env.button("生成").disabled);
});

test("空文字点生成只说清楚：不发请求、不进排队", async () => {
    resetEnv();
    mockVoiceRoutes();
    const env = await mounted();
    env.pick({ filename: "voice_ref.wav", subfolder: "" });
    await settle();
    env.text().value = "";   // 预填的字清空掉才是真空
    click(env.button("生成"));
    await settle();
    assert.match(env.status().textContent, /请先输入要说的文字/);
    assert.equal(fetchLog.filter((c) => c.path === "/neo_voice/generate").length, 0);
    assert.ok(env.track().hidden, "没有任务在跑就不出进度条");
});

test("生成走那一条链：参考音频拷进 input、文字进 prompt，进度随事件走，结果出波形", async () => {
    resetEnv();
    mockVoiceRoutes();
    const env = await mounted();
    env.pick({ filename: "voice_ref.wav", subfolder: "" });
    await settle();
    click(env.button("生成"));
    await settle();

    const gen = fetchLog.find((c) => c.path === "/neo_voice/generate");
    assert.ok(gen, "应提交 /neo_voice/generate");
    assert.equal(gen.body.skill_id, "cosyvoice_voice");
    assert.equal(gen.body.prompt, "你好，世界，这是一段语音测试。");
    assert.deepEqual(gen.body.references, [{ kind: "input", value: "voice_ref.wav" }]);
    assert.equal(gen.body.output_prefix, "Voice");
    assert.match(env.status().textContent, /排队中…/);
    assert.ok(!env.track().hidden);
    assert.ok(!env.button("取消任务").hidden);

    dispatchApiEvent("rs.voice_gen.status", snap("T1", { status: "running", progress: { value: 1, max: 4 } }));
    await settle();
    assert.match(env.status().textContent, /合成中…/);
    assert.equal(env.fill().style.width, "25%");

    dispatchApiEvent("rs.voice_gen.status", snap("T1", {
        status: "succeeded",
        audios: [{ filename: "hello_0001.mp3", subfolder: "Voice/2026-10-10", url: "/view?filename=hello_0001.mp3&subfolder=Voice/2026-10-10&type=output" }],
    }));
    await settle();
    assert.match(env.status().textContent, /已生成语音，点波形播放试听；产物在 Output\/Voice/);
    assert.ok(env.result().querySelector(".neo-gallery-audio-waveform"), "结果要有可试听的波形");
    assert.ok(env.track().hidden, "终态之后进度条收起");
    assert.ok(!env.button("打开输出目录").hidden);

    resetSidebarTab();   // 素材库那侧的侧栏替身：openGallerySidebar 没有侧栏就整条路都不走
    const dirs = [];
    comfyApp.neoGallery = { showDirectoryStructure: (source, path) => dirs.push([source, path]) };
    click(env.button("打开输出目录"));
    assert.deepEqual(dirs, [["Voice", []]], "打开输出目录交的是素材库的 Voice 目录");
    assert.ok(appState._sidebarTab.history.includes("neo.gallery"), "侧栏替身切到素材库");
});

test("取消任务：取消请求发出去，晚到的事件也只落成已取消，不落成成功", async () => {
    resetEnv();
    mockVoiceRoutes("T9");
    const env = await mounted();
    env.pick({ filename: "voice_ref.wav", subfolder: "" });
    await settle();
    click(env.button("生成"));
    await settle();
    click(env.button("取消任务"));
    await settle();
    assert.equal(fetchLog.filter((c) => c.path === "/neo_voice/cancel/T9").length, 1);
    dispatchApiEvent("rs.voice_gen.status", snap("T9", { status: "succeeded", audios: [{ filename: "x.mp3", subfolder: "Voice", url: "/view?filename=x.mp3" }] }));
    await settle();
    assert.match(env.status().textContent, /已取消/);
    assert.ok(env.result().querySelector(".neo-gallery-audio-waveform") === null, "取消掉的这一发不该铺结果波形");
    assert.ok(!env.button("生成").disabled, "这一发结束了，按钮要能再发一次");
});

