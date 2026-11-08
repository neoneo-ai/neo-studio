// 素材库弹窗的取用过滤：调用方声明这一扇收哪一类素材，类别对不上的卡片点下去不取用（js/core/lib-modal.js）。
// 图片编辑的原图与参考位只吃图——视频落进 <img> 就是破图；出片参考区与抽帧页吃的正是视频，默认口径不能收紧。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, click } from "./setup.mjs";

// lib-modal.js 顶层导入 scripts/ui.js 与 gallery-utils.js，必须等 setup.mjs 装好 shim 钩子再动态取
const { createLibraryModal } = await import("../../web/js/core/lib-modal.js");

const KEY = "neo_test_libmodal_accept";

/** 取用模式开一扇弹窗：cards 是卡片文件名，picked 收每一次取用到的文件名，card 按文件名取卡片 */
function pickModal(accept, cards) {
    const picked = [];
    const modal = createLibraryModal({ storageKey: KEY, scope: "assets" });
    const host = document.createElement("div");
    for (const filename of cards) {
        const card = document.createElement("div");
        card.className = "neo-gallery-thumb-container";
        card.dataset.filename = filename;
        card.dataset.subfolder = "Output/2026-01-01";
        host.appendChild(card);
    }
    document.body.appendChild(modal.el);
    modal.setContent(host);
    modal.setPickMode({ onPick: (items) => picked.push(...items.map((i) => i.filename)), accept });
    modal.open("素材库取用");
    return {
        picked,
        isOpen: () => modal.isOpen(),
        card: (f) => modal.el.querySelector(`.neo-gallery-thumb-container[data-filename="${f}"]`),
    };
}

test("取用过滤：图片编辑开的那扇只放行图片，点视频与音频卡片不落取用", () => {
    resetEnv();
    const m = pickModal("image", ["a.png", "v.mp4", "s.mp3"]);
    click(m.card("a.png"));
    assert.deepEqual(m.picked, ["a.png"], "图片卡片照旧单点取用");
    assert.ok(!m.isOpen(), "取用即关窗");
});

test("取用过滤：图片编辑开的那扇点视频与音频卡片不取用、不关窗（落回卡片自己的灯箱浏览）", () => {
    resetEnv();
    const m = pickModal("image", ["v.mp4", "s.mp3"]);
    click(m.card("v.mp4"));
    click(m.card("s.mp3"));
    assert.deepEqual(m.picked, [], "视频与音频不落进原图 / 参考位的落点");
    assert.ok(m.isOpen(), "没取用到东西就不关窗");
});

test("取用过滤：抽帧页开的那扇只放行视频，图片卡片点下去不取用", () => {
    resetEnv();
    const m = pickModal("video", ["a.png", "v.mp4"]);
    click(m.card("a.png"));
    assert.deepEqual(m.picked, [], "抽帧页不吃图片");
    click(m.card("v.mp4"));
    assert.deepEqual(m.picked, ["v.mp4"], "视频卡片取用一条");
});

test("取用过滤：不声明类别就是媒体全收（出片参考区一直靠这条路透视频），非媒体文件照旧不取用", () => {
    resetEnv();
    const m = pickModal(undefined, ["v.mp4", "a.png", "w.txt"]);
    click(m.card("v.mp4"));
    assert.deepEqual(m.picked, ["v.mp4"], "视频照旧可取用");
    const m2 = pickModal(undefined, ["w.txt"]);
    click(m2.card("w.txt"));
    assert.deepEqual(m2.picked, [], "Lora / txt / 工作流这类文件点它是开灯箱，不是取用");
});
