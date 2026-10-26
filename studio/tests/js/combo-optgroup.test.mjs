// combo optgroup 回归：下拉列表应渲染 <optgroup> 分类标题，选项归属正确，
// 过滤时空组隐藏，键盘导航跳过标题。
import test from "node:test";
import assert from "node:assert/strict";
import { resetEnv, window as testWindow } from "./setup.mjs";

test("combo：optgroup 分类标题渲染 + 过滤 + 键盘导航跳过标题", async () => {
    resetEnv();
    const { attachComboBox } = await import("../../web/combo-box.js");

    const select = document.createElement("select");
    // 生产 select 顶部恒有一个 value="" 的「默认」占位项；这里同样保留，
    // 使 select.value 初始为空（否则原生 select 默认取首个 option 值，导致自动高亮）
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "默认";
    const g1 = document.createElement("optgroup");
    g1.label = "出图 (Krea2)";
    const g2 = document.createElement("optgroup");
    g2.label = "风格模板";
    const opt1 = document.createElement("option");
    opt1.value = "gen_a";
    opt1.textContent = "出图A";
    const opt2 = document.createElement("option");
    opt2.value = "gen_b";
    opt2.textContent = "出图B";
    const opt3 = document.createElement("option");
    opt3.value = "style_k";
    opt3.textContent = "卡通K";
    g1.append(opt1, opt2);
    g2.append(opt3);
    select.append(def, g1, g2);
    document.body.appendChild(select);

    const { box, destroy } = attachComboBox(select, { emptyText: "无匹配" });
    document.body.appendChild(box);
    const inputEl = box.querySelector("input");

    // 展开列表
    inputEl.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }));
    const listEl = document.querySelector(".rs-combo-list");
    assert.notEqual(listEl.style.display, "none", "点击应展开列表");

    const categories = Array.from(listEl.querySelectorAll(".rs-combo-category"));
    const items = Array.from(listEl.querySelectorAll("[data-value]"));
    assert.equal(categories.length, 2, "应渲染两个分类标题");
    assert.equal(categories[0].textContent, "出图 (Krea2)");
    assert.equal(categories[1].textContent, "风格模板");
    assert.equal(items.length, 4, "应渲染 默认 + 三个选项");
    assert.equal(items[0].dataset.value, "", "首项为默认占位");
    assert.equal(items[1].dataset.value, "gen_a");
    assert.equal(items[3].dataset.value, "style_k");
    // 分组内选项应比分类标题多缩进（padding-left 22px）；顶层默认占位保持 cssText 的 8px 不缩进
    assert.equal(items[0].style.paddingLeft, "8px", "默认占位不缩进");
    assert.equal(items[1].style.paddingLeft, "22px", "optgroup 内选项应缩进");
    assert.equal(items[3].style.paddingLeft, "22px", "第二个 optgroup 内选项也应缩进");

    // 键盘导航：↑↓ 跳过分类标题，只在选项间移动
    // 初始高亮在「默认」(idx 0)；ArrowDown 一步进入首个真实选项 gen_a（跳过分类标题），Enter 确认
    inputEl.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    inputEl.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(select.value, "gen_a", "ArrowDown 应从默认跳到首个真实选项（跳过分类标题）");

    // 过滤：输入"卡通"应隐藏空组
    inputEl.value = "卡通";
    inputEl.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    const catsAfterFilter = Array.from(listEl.querySelectorAll(".rs-combo-category"));
    const itemsAfter = Array.from(listEl.querySelectorAll("[data-value]"));
    assert.equal(catsAfterFilter.length, 1, "过滤后空的分类组应隐藏");
    assert.equal(itemsAfter.length, 1, "过滤后应剩 1 项");
    assert.equal(itemsAfter[0].dataset.value, "style_k");

    // 过滤无匹配：应显示 empty 文本，无分类标题
    inputEl.value = "zzz";
    inputEl.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    const catsNoMatch = Array.from(listEl.querySelectorAll(".rs-combo-category"));
    const itemsNoMatch = Array.from(listEl.querySelectorAll("[data-value]"));
    assert.equal(catsNoMatch.length, 0, "无匹配时不应有分类标题");
    assert.equal(itemsNoMatch.length, 0, "无匹配时不应有选项");
    // jsdom 会把 color:#777 规范化为 rgb(...)，按文本内容定位 empty 占位
    const empty = Array.from(listEl.querySelectorAll("div")).find(d => d.textContent === "无匹配");
    assert.ok(empty, "无匹配时应显示 empty 占位");

    destroy();
});

test("combo：option 的 data-tags（中文拼音/首字母缩写）参与过滤", async () => {
    resetEnv();
    const { attachComboBox } = await import("../../web/combo-box.js");

    const select = document.createElement("select");
    // textContent 是中文名（不含拼音），仅靠后端追加的 data-tags 才能被拼音命中
    const opt1 = document.createElement("option");
    opt1.value = "anime_style";
    opt1.textContent = "动漫风格";
    opt1.dataset.tags = "dongmanfengge dmfg"; // 全拼 + 首字母缩写（与 skill.js populateSkillOptions 的空格分隔格式一致）
    const opt2 = document.createElement("option");
    opt2.value = "other";
    opt2.textContent = "其他技能";
    select.append(opt1, opt2);
    document.body.appendChild(select);

    const { box, destroy } = attachComboBox(select);
    document.body.appendChild(box);
    const inputEl = box.querySelector("input");
    inputEl.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }));
    const listEl = document.querySelector(".rs-combo-list");

    // 首字母缩写 dmfg 命中「动漫风格」
    inputEl.value = "dmfg";
    inputEl.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    let items = Array.from(listEl.querySelectorAll("[data-value]"));
    assert.equal(items.length, 1, "拼音首字母缩写应命中 1 项");
    assert.equal(items[0].dataset.value, "anime_style");

    // 全拼片段 dongman 也命中
    inputEl.value = "dongman";
    inputEl.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    items = Array.from(listEl.querySelectorAll("[data-value]"));
    assert.equal(items.length, 1, "拼音全拼片段应命中 1 项");
    assert.equal(items[0].dataset.value, "anime_style");

    // 无关查询不命中带 tags 的项
    inputEl.value = "zzz";
    inputEl.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    items = Array.from(listEl.querySelectorAll("[data-value]"));
    assert.equal(items.length, 0, "无关查询不应命中");

    destroy();
});