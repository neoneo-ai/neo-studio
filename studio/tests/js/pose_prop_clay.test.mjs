// tools/pose_prop_clay.mjs 的纯函数：一件道具渲染出来的图写回哪一个文件名
import test from "node:test";
import assert from "node:assert/strict";
import { previewNameFor } from "../../../tools/pose_prop_clay.mjs";

test("previewNameFor：注册表行自带的 preview 优先，取裸文件名", () => {
    assert.equal(previewNameFor({ propKey: "glb:katana.glb", preview: "preview/katana.png" }), "katana.png");
    assert.equal(previewNameFor({ propKey: "glb:x.glb", preview: "props\\preview\\x.png" }), "x.png");
});

test("previewNameFor：内置程序化道具按约定名 builtin-<id>.png", () => {
    assert.equal(previewNameFor({ propKey: "builtin:chair" }), "builtin-chair.png");
});

test("previewNameFor：两处都没有就按 GLB 裸文件名", () => {
    assert.equal(previewNameFor({ propKey: "glb:sword_thin.glb" }), "sword_thin.png");
    assert.equal(previewNameFor({ key: "glb:a.glb", preview: "" }), "a.png");
});
