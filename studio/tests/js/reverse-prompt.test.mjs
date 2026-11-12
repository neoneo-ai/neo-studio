// Studio「图片反推」页（web/reverse-prompt/reverse-prompt.js）：取图 → 反推请求体 → SSE 逐段上屏 → 复制。
// 接口与素材卡 ⋯ 菜单那条反推同源（POST /rs_prompts/reverse_prompt），本页只做取图、上屏、复制三件事；
// 运行按钮交宿主的 gateRun（能力缺时点它引导启动内核，不发假请求）。
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetEnv, mockRoute, clearRoutes, sseResponse, fetchLog, click, flush, sleep } from "./setup.mjs";
import { $el } from "../../web/studio/shim/ui.js";
// reverse-prompt.js 顶层导入 gallery-utils.js（它要 scripts/* 的 shim），必须等 setup.mjs 装好钩子再动态取
const { createReverseView, REVERSE_LANGS, reverseRequestBody } =
    await import("../../web/reverse-prompt/reverse-prompt.js");

// 用例的 mock 在建视图之前就注册，先清掉上一条用例留下的路由表
beforeEach(() => clearRoutes());

const settle = async () => { await flush(20); await sleep(0); await flush(20); };

/** 反推流的帧形与后端一致：meta 头帧不进正文，text 帧是增量，[DONE] 收尾 */
function mockReverse(frames, extra = []) {
    mockRoute("/rs_prompts/reverse_prompt", () => sseResponse([
        'data: {"meta":{"status":"start","language":"zh"}}',
        ...frames.map((text) => "data: " + JSON.stringify({ text })),
        ...extra,
        "data: [DONE]",
    ]));
}

function mounted() {
    const api = { fetchApi: (path, opts) => fetch(path, opts) };
    const host = $el("div");
    document.body.appendChild(host);
    const toasts = [];
    const copied = [];
    const gated = [];
    let pickCb = null;
    const build = createReverseView({
        api, $el,
        toast: (m) => toasts.push(m),
        openMaterial: (cb) => { pickCb = cb; },
        gateRun: (btn, feature, label) => { gated.push({ btn, feature, label }); },
    });
    // jsdom 没有剪贴板：桩一枚，复制这条路径才测得到「写进去的是哪一段」
    Object.defineProperty(window.navigator, "clipboard", {
        value: { writeText: async (text) => { copied.push(text); } },
        configurable: true, writable: true,
    });
    const env = {
        host, toasts, copied, gated,
        pick: (item) => {
            click(env.button("从素材库选图"));   // 弹窗由宿主开：用例只把交回来的那一项喂进回调
            pickCb?.(item);
        },
        button: (label) => [...host.querySelectorAll(".ns-reverse-btn")].find((b) => b.textContent.includes(label)),
        // 复制钮按落点取，不按字取：复制成功那一刻它改口成「已复制」，按字就找不着了
        copy: () => host.querySelector(".ns-reverse-head .ns-reverse-btn"),
        chip: (label) => [...host.querySelectorAll(".ns-reverse-chip")].find((c) => c.textContent.includes(label)),
        out: () => host.querySelector(".ns-reverse-out"),
        status: () => host.querySelector(".ns-reverse-status"),
        reverseCalls: () => fetchLog.filter((c) => c.path === "/rs_prompts/reverse_prompt"),
    };
    return build(host).then(() => env);
}

test("反推请求体：就是画廊那三元组，语言认 zh / en", () => {
    assert.deepEqual(reverseRequestBody({ filename: "a.png", subfolder: "Output/2026-10-10" }, "zh"),
        { filename: "a.png", subfolder: "Output/2026-10-10", language: "zh" });
    assert.deepEqual(reverseRequestBody({ filename: "a.png" }, "en"),
        { filename: "a.png", subfolder: "", language: "en" });
    assert.deepEqual(REVERSE_LANGS.map((l) => l.value), ["zh", "en"], "与后端认的那对取值同源");
});

test("没选图时只有起手卡片：反推与换图不出可点的控件", async () => {
    resetEnv();
    const env = await mounted();
    assert.ok(env.host.querySelector(".ns-reverse-empty"), "起手卡片要告诉用户从哪儿起手");
    assert.ok(env.host.querySelector(".ns-reverse-out-box").hidden, "没有图就没有结果框");
    assert.ok(env.button("反推").disabled, "能力用不到就不出可点的按钮");
    assert.ok(env.button("换图").disabled);
    assert.deepEqual(env.gated.map((g) => [g.feature, g.label]), [["prompt_reverse", "反推"]],
        "运行按钮交宿主闸门：离线时点它引导启动内核");
});

test("素材库点来的图落上参考位：路径、缩略图与控件解禁一起跟上", async () => {
    resetEnv();
    const env = await mounted();
    env.pick({ filename: "hero.png", subfolder: "Output/2026-10-10" });
    await settle();
    assert.equal(env.host.querySelector(".ns-reverse-pill").textContent, "Output/2026-10-10/hero.png");
    assert.match(env.host.querySelector(".ns-reverse-preview").src, /\/neo_gallery\/thumbnail/);
    assert.ok(env.host.querySelector(".ns-reverse-empty").hidden, "有图了就该收起手卡片");
    assert.ok(!env.host.querySelector(".ns-reverse-out-box").hidden);
    assert.ok(!env.button("反推").disabled);
    assert.equal(env.reverseCalls().length, 0, "选图不该自己发起反推");
});

test("反推逐段上屏：正文来自 text 帧，meta 帧不进结果，落点写进状态句", async () => {
    resetEnv();
    mockReverse(["一座", "红色灯塔", "立在悬崖上"]);
    const env = await mounted();
    env.pick({ filename: "hero.png", subfolder: "Output" });
    await settle();
    click(env.button("反推"));
    await settle();
    assert.equal(env.out().textContent, "一座红色灯塔立在悬崖上");
    assert.match(env.status().textContent, /已生成，结果同时写进图片同目录的 \.txt/);
    assert.deepEqual(env.reverseCalls()[0].body, { filename: "hero.png", subfolder: "Output", language: "zh" });
});

test("语言 chip 换的是下一发的请求体：默认中文，点英文就发 en", async () => {
    resetEnv();
    mockReverse(["a lighthouse"]);
    const env = await mounted();
    env.pick({ filename: "hero.png", subfolder: "" });
    await settle();
    assert.ok(env.chip("中文").classList.contains("is-on"));
    click(env.chip("英文"));
    assert.ok(env.chip("英文").classList.contains("is-on"));
    click(env.button("反推"));
    await settle();
    assert.equal(env.reverseCalls()[0].body.language, "en");
});

test("后端把失败写进流里：状态句说清失败，不拿半截正文装成功", async () => {
    resetEnv();
    mockRoute("/rs_prompts/reverse_prompt", () => sseResponse([
        'data: {"text":"半"}',
        'data: {"text":"截"}',
        "data: [ERROR] LLM 未配置",
    ]));
    const env = await mounted();
    env.pick({ filename: "hero.png", subfolder: "" });
    await settle();
    click(env.button("反推"));
    await settle();
    assert.match(env.status().textContent, /LLM 未配置/);
    assert.ok(!env.button("反推").disabled, "这一发结束了，按钮要回到能再发一次的状态");
});

test("复制提示词送进去的是结果框正文；空结果只说清楚，不写剪贴板", async () => {
    resetEnv();
    mockReverse(["一座红色灯塔"]);
    const env = await mounted();
    env.pick({ filename: "hero.png", subfolder: "" });
    await settle();
    click(env.copy());
    await settle();
    assert.deepEqual(env.copied, [], "没有正文就不写剪贴板");
    assert.match(env.toasts.join("|"), /还没有可复制的提示词/);
    click(env.button("反推"));
    await settle();
    click(env.copy());
    await settle();
    assert.deepEqual(env.copied, ["一座红色灯塔"]);
    assert.match(env.copy().textContent, /已复制/);
});

