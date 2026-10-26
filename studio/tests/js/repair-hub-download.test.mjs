// 工作流修复（workflow.js）：失效模型行在「本地无候选」时给出模型库下载入口。
// 覆盖 Qwen Image 2.1 换脸这类场景——CLIPLoader 要的 text_encoders 本地为空，
// 手动选择下拉没有任何候选，修复无从下手，必须能跳到模型库下载。
import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { resetEnv, clearRoutes, mockRoute, jsonResponse, sleep, click } from "./setup.mjs";

const { buildChangesTable } = await import("../../web/workflow.js");
const { closeModelHub } = await import("../../web/model-hub.js");

beforeEach(() => {
    resetEnv();
    clearRoutes();
    closeModelHub();
});

function mockHubRoutes() {
    mockRoute("/neo_model_hub/settings", () => jsonResponse({
        settings: {
            source: "modelscope", hf_endpoint: "", hf_token: "", ms_token: "",
            llm_subdir: "LLM", timeout_total: 3600, sock_read: 120,
        },
        registry: { groups: [], bundles: [] },
        categories: ["text_encoders", "diffusion_models"],
        sources: ["modelscope", "huggingface"],
    }));
    mockRoute("/neo_model_hub/repos", () => jsonResponse({ repos: [] }));
    mockRoute("/neo_model_hub/files", () => jsonResponse({ files: [], categories: ["text_encoders"] }));
}

// 本地 text_encoders 为空：CLIPLoader 的 clip_name 无候选 → 必须出现模型库按钮
test("本地无候选的失效行出现「模型库」按钮", () => {
    const changes = [{
        node: "2", input: "clip_name", type: "CLIPLoader",
        old: "qwen3vl_8b_int8_convrot.safetensors", new: null, candidates: [],
    }];
    const table = buildChangesTable(changes, () => {}, () => {});
    const btns = [...table.querySelectorAll("button")].filter((b) => b.textContent.includes("模型库"));

    assert.equal(btns.length, 1, "无候选的失效行应给出模型库下载入口");
    assert.match(table.textContent, /未找到可用文件/);
});

test("已自动匹配的行不出现模型库按钮（无需下载）", () => {
    const changes = [{
        node: "3", input: "vae_name", type: "VAELoader",
        old: "qwen_image_2.1_vae_bf16.safetensors", new: "qwen_image_2.1_vae.safetensors", score: 0.93,
    }];
    const table = buildChangesTable(changes, () => {}, () => {});
    const btns = [...table.querySelectorAll("button")].filter((b) => b.textContent.includes("模型库"));

    assert.equal(btns.length, 0, "匹配成功的行不该提示下载");
});

// 有本地候选时：下拉 + 模型库按钮并存（可手动替换，也可直接下载）
test("有候选的行同时保留下拉框与模型库按钮", () => {
    const changes = [{
        node: "2", input: "clip_name", type: "CLIPLoader",
        old: "qwen3vl_8b.safetensors", new: null, candidates: ["qwen3vl_4b_fp8_scaled.safetensors"],
    }];
    const table = buildChangesTable(changes, () => {}, () => {});

    assert.ok(table.querySelector("select"), "手动选择下拉应保留");
    assert.ok([...table.querySelectorAll("button")].some((b) => b.textContent.includes("模型库")));
});

test("点模型库按钮：以模型名预填搜索并预选 text_encoders 类别", async () => {
    mockHubRoutes();
    const changes = [{
        node: "2", input: "clip_name", type: "CLIPLoader",
        old: "sub/dir/qwen3vl_8b_int8_convrot.safetensors", new: null, candidates: [],
    }];
    const table = buildChangesTable(changes, () => {}, () => {});
    document.body.appendChild(table);

    click([...table.querySelectorAll("button")].find((b) => b.textContent.includes("模型库")));
    await sleep(120);

    const overlay = document.querySelector(".neo-hub-overlay");
    assert.ok(overlay, "模型库弹窗未打开");
    // 搜索词去掉子目录与后缀
    assert.equal(overlay.querySelector(".neo-hub-search").value, "qwen3vl_8b_int8_convrot");
    // clip_name → text_encoders 预选落盘类别
    assert.equal(overlay.querySelector(".neo-hub-cat").value, "text_encoders");

    closeModelHub();
});