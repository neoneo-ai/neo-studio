// Neo Gallery 音频卡片「生成语音」：CosyVoice 零样本克隆，参考音频经 copy_to_input 落
// input/ 作 {{REF_AUDIO_1}}，目标文字走 {{PROMPT}}，产物落 Output/Voice，弹窗内显示波形并播放。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, mockRoute, clearRoutes, jsonResponse, fetchLog, sleep, click } from "./setup.mjs";
import { dispatchApiEvent } from "./mocks/comfy-api.mjs";

beforeEach(() => {
    resetEnv();
    clearRoutes();
});

function itemByLabel(label) {
    return [...document.querySelectorAll(".neo-gallery-collect-item")]
        .find((el) => el.textContent.includes(label));
}

function makeGallery() {
    return {
        gallery: {
            app: { extensionManager: { toast: { add: () => {} } } },
            maxThumbnailSize: 320,
            displayLabels: true,
            showDirectoryStructure() { return Promise.resolve(); },
        },
    };
}

function openAudioMenu(card, gallery) {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    card._showCollectMenu(gallery, { name: "voice_ref", filename: "voice_ref.wav" }, "", "Output", anchor);
}

function mockVoiceRoutes(taskId) {
    mockRoute("/neo_gallery/copy_to_input", () => jsonResponse({ success: true, filename: "voice_ref.wav" }));
    mockRoute("/neo_image_gen/skill_config", () => jsonResponse({ default_prompt: "你好，世界，这是一段语音测试。" }));
    mockRoute("/neo_voice/generate", (b) => jsonResponse({
        task_id: taskId, prompt_id: "P1", status: "queued", created: 0, updated: 0,
        prompt: b.prompt, seed: 1, audios: [], progress: null, error: "", warnings: [],
    }));
    mockRoute("/neo_voice/status/*", () => jsonResponse({
        task_id: taskId, prompt_id: "P1", status: "queued", created: 0, updated: 0,
        prompt: "你好", seed: 1, audios: [], progress: null, error: "", warnings: [],
    }));
}

test("buildVoiceRequest：CosyVoice 预设 + 参考音频 + 目标文字 + Voice 前缀", async () => {
    const { buildVoiceRequest } = await import("../../web/voice-gen.js");
    const body = buildVoiceRequest("NeoAgent/ref.wav", "你好世界");
    assert.equal(body.skill_id, "cosyvoice_voice");
    assert.equal(body.prompt, "你好世界");
    assert.deepEqual(body.references, [{ kind: "input", value: "NeoAgent/ref.wav" }]);
    assert.equal(body.output_prefix, "Voice");
});

test("音频卡片 ⋯ 菜单出现「生成语音」，图片卡片不出现", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery();
    const card = new GalleryCard(gallery);

    openAudioMenu(card, gallery);
    assert.ok(itemByLabel("生成语音"), "音频卡片应有语音入口");
    card._removeCollectMenu();

    const anchor2 = document.createElement("div");
    document.body.appendChild(anchor2);
    card._showCollectMenu(gallery, { name: "shot", filename: "shot.png" }, "", "Output", anchor2);
    assert.equal(itemByLabel("生成语音"), undefined, "图片卡片不应出现语音入口");
    card._removeCollectMenu();
});

test("语音弹窗：参考波形 + 目标文字 + 生成 → 排队 → 成功结果波形", async () => {
    const { GalleryCard } = await import("../../web/gallery-card.js");
    const { gallery } = makeGallery();
    const card = new GalleryCard(gallery);
    const taskId = "T1";
    mockVoiceRoutes(taskId);

    openAudioMenu(card, gallery);
    click(itemByLabel("生成语音"));
    await sleep(10);

    const overlay = document.querySelector(".neo-gallery-voice-modal-overlay");
    assert.ok(overlay, "应弹出语音弹窗");
    assert.match(overlay.querySelector(".neo-gallery-story-title").textContent, /生成语音/);
    assert.ok(overlay.querySelector(".neo-gallery-voice-audio .neo-gallery-audio-waveform"), "应有参考波形");
    const textarea = overlay.querySelector(".neo-gallery-story-input");
    assert.ok(textarea, "应有目标文字输入框");
    assert.equal(textarea.value, "你好，世界，这是一段语音测试。", "应预填 config.json 的 default_prompt");

    const genBtn = [...overlay.querySelectorAll(".neo-gallery-story-btn")].find((b) => b.textContent.includes("生成"));
    click(genBtn);
    await sleep(20);

    const copyCall = fetchLog.find((c) => c.path === "/neo_gallery/copy_to_input");
    assert.ok(copyCall, "应调用 copy_to_input");
    const genCall = fetchLog.find((c) => c.path === "/neo_voice/generate");
    assert.ok(genCall, "应调用 /neo_voice/generate");
    assert.equal(genCall.body.prompt, "你好，世界，这是一段语音测试。");
    assert.equal(genCall.body.references[0].value, "voice_ref.wav");

    assert.ok(overlay.querySelector(".neo-gallery-cs-progress"), "应显示排队进度");

    dispatchApiEvent("rs.voice_gen.status", {
        task_id: taskId, prompt_id: "P1", status: "succeeded", created: 0, updated: 0,
        prompt: "你好，世界", seed: 1,
        audios: [{ filename: "hello_0001.mp3", subfolder: "Voice/2026-10-10", url: "/view?filename=hello_0001.mp3&subfolder=Voice/2026-10-10&type=output" }],
        progress: null, error: "", warnings: [],
    });
    await sleep(10);

    const result = overlay.querySelector(".neo-gallery-voice-result");
    assert.ok(result, "应显示结果区");
    assert.ok(result.querySelector(".neo-gallery-audio-waveform"), "结果应有波形");
    assert.ok(result.querySelector(".neo-gallery-audio-play-btn"), "结果应有播放按钮");
});
