// 界面语言核心（js/core/i18n.js）：中文原文作 key、缺项回落中文、插值、落盘与刷新
import test from "node:test";
import assert from "node:assert/strict";
import "./setup.mjs";
import { t, tf, getLang, setLang, applyLang, LANGS } from "../../web/js/core/i18n.js";

const LANG_KEY = "neo_studio_lang";

test("默认语言跟随浏览器语言（jsdom 为 en-US）", async () => {
    localStorage.removeItem(LANG_KEY);
    // setup.mjs 把共享模块实例钉在中文基线，这里取一份新实例才测得到浏览器语言判定
    const fresh = await import(`../../web/js/core/i18n.js?detect=${Date.now()}`);
    assert.equal(fresh.getLang(), "en");
    assert.deepEqual(LANGS.map((l) => l.value), ["zh", "en"]);
});

test("英文模式：字典命中出英文，缺项回落中文原文", () => {
    setLang("en");
    assert.equal(t("设置"), "Settings");
    assert.equal(t("这句没进字典"), "这句没进字典");
});

test("中文模式：原文原样返回", () => {
    setLang("zh");
    assert.equal(t("设置"), "设置");
    assert.equal(t("这句没进字典"), "这句没进字典");
});

test("tf 按占位符插值，两种语言共用同一个 key", () => {
    const zh = "把当前画布落盘技能 \"{id}\"（先列出变更、确认后写入）";
    setLang("zh");
    assert.equal(tf(zh, { id: "custom_a" }), "把当前画布落盘技能 \"custom_a\"（先列出变更、确认后写入）");
    setLang("en");
    assert.equal(tf(zh, { id: "custom_a" }), "Write this canvas back to skill \"custom_a\" (changes are listed first, then confirmed).");
});

test("setLang 落盘 localStorage，getLang 读回", () => {
    setLang("en");
    assert.equal(localStorage.getItem(LANG_KEY), "en");
    assert.equal(getLang(), "en");
    setLang("zh");
    assert.equal(localStorage.getItem(LANG_KEY), "zh");
    assert.equal(getLang(), "zh");
});

test("applyLang 落盘后整页刷新", () => {
    const reloads = [];
    const realLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", { value: { reload: () => reloads.push(1) }, configurable: true, writable: true });
    try {
        applyLang("en");
        assert.deepEqual(reloads, [1], "切换语言应整页刷新");
        assert.equal(localStorage.getItem(LANG_KEY), "en");
    } finally {
        Object.defineProperty(globalThis, "location", { value: realLocation, configurable: true, writable: true });
        localStorage.removeItem(LANG_KEY);
    }
});
