// 技能页（#/skills）：默认停在引导页，管理组件点了入口才装配——落地在引导页时不拉技能列表，也不铺一块空列表。
// 起手版式照导演页 / 绘画页 / 视频页的空白态（.neo-gallery-gm-idle 主行 + 细注行 + 四角括号）；三个入口分别
// 是导入 API 工作流建技能、写一份 skill.md 模板技能、浏览与编辑已有技能。
// 工厂只接装配层给得出的那两样（建元素与提示条）；技能管理组件、导入接口、文案与图标自己 import。
import { t, tf } from "../../js/core/i18n.js";
import { setIconLabel } from "../../js/core/icons.js";
import { createSkillManager, importWorkflowSkill } from "../../skill.js";

/** @typedef {Object} SkillsPageHost
 *  @property {Function} $el 建元素
 *  @property {Function} toast 提示文本 */

export function createSkillsPage({ $el, toast }) {
// ====== 技能页：引导页（默认）+ 统一技能管理（技能列表 / 新建模板技能 / 导入工作流）======
// 管理组件是 skill.js 的 createSkillManager，与顶栏「技能管理」同组件：这一页直接展开它，不弹窗，
// 标题条兼作返回引导页的入口；内嵌详情有未保存修改时返回前先确认，回引导页就卸掉整个组件。
function buildSkills(el) {
    el.classList.add("ns-skills");
    const page = $el("div", { className: "ns-skills-page" });
    el.appendChild(page);

    const managerHost = $el("div", { className: "ns-skills-manager" });
    let mgr = null;
    let building = null;   // 装配中的管理者：连点入口不会叠出两份

    // 返回引导页：内嵌详情有未保存修改时先确认，再卸掉整个管理组件（下次进列表重新装配）
    const showGuide = () => {
        if (mgr?.isDirty() && !confirm(t("当前技能有未保存的修改，返回引导页将丢弃这些修改。"))) return;
        mgr?.close();
        mgr = null;
        page.classList.remove("ns-skills-editing");
    };

    const ensureManager = () => {
        if (mgr) return Promise.resolve(mgr);
        if (building) return building;
        building = Promise.resolve().then(() => {
            const m = createSkillManager(managerHost, { showClose: false, showCanvasBtn: false, autoSelect: false });
            // 列表态的标题条兼作返回引导页的入口；页里没有可拖的窗，标题就写这一块的名字
            m.head.querySelector(".rs-skill-manager-title").textContent = t("技能列表");
            const back = $el("button", { className: "ns-skills-back", type: "button", textContent: t("← 引导页"), title: t("返回技能引导页") });
            back.addEventListener("click", showGuide);
            m.head.prepend(back);
            mgr = m;
            return m;
        }).finally(() => { building = null; });
        return building;
    };

    // 进列表：list = 选中默认展开分类的第一项，new = 直接开新建表单，不传 = 只铺列表（导入后按 id 定位）
    const showManager = async (mode) => {
        const m = await ensureManager();
        page.classList.add("ns-skills-editing");
        await m.ready;
        if (mgr !== m) return m;   // 装配途中已经回到引导页：别再把详情铺进已卸掉的面板
        if (mode === "new") await m.openNew();
        else if (mode === "list") await m.selectFirst();
        return m;
    };

    const importBtn = $el("button", { className: "ns-btn", type: "button", title: t("选择 ComfyUI 导出的 API 工作流（.json），新建一份带工作流的生成技能") });
    setIconLabel(importBtn, "folder", t("导入工作流"));
    const newBtn = $el("button", { className: "ns-btn", type: "button", title: t("写一份 skill.md 模板技能，不绑定工作流") });
    setIconLabel(newBtn, "pencil", t("新建模板技能"));
    const listBtn = $el("button", { className: "ns-btn", type: "button", title: t("浏览、编辑和删除已有技能") });
    setIconLabel(listBtn, "list", t("技能列表"));
    newBtn.onclick = () => showManager("new");
    listBtn.onclick = () => showManager("list");

    const fileInput = $el("input", { type: "file", accept: ".json,application/json", className: "ns-skills-file" });
    fileInput.hidden = true;
    importBtn.onclick = () => { fileInput.value = ""; fileInput.click(); };
    fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        fileInput.value = "";   // 同一个文件再选一次也要触发 change
        if (!file) return;
        let text;
        try { text = await file.text(); }
        catch { toast(t("导入失败：无法读取文件")); return; }
        let data;
        try { data = JSON.parse(text); }
        catch { toast(t("导入失败：文件不是合法的 JSON")); return; }
        const problem = workflowImportProblem(data);
        if (problem) { toast(t("导入失败：") + problem); return; }
        let saved;
        try {
            saved = await importWorkflowSkill(data, file.name.replace(/\.json$/i, "") || "my-workflow");
        } catch (e) {
            toast(tf("导入失败：{msg}", { msg: e.message }));
            return;
        }
        if (!saved) return;   // 命名对话框取消
        const m = await showManager();
        if (mgr !== m) return;   // 列表铺开前已经回到引导页
        await m.openSkill(saved.id);
    });

    const guide = $el("div", { className: "ns-skills-guide" }, [
        $el("div", { className: "ns-skills-guide-card neo-gallery-gm-idle" }, [
            $el("div", { className: "neo-gallery-gm-idle-title", textContent: t("技能") }),
            $el("div", { className: "neo-gallery-gm-idle-sub", textContent: t("导入工作流，或从模板新建技能") }),
            $el("i", { className: "ns-video-corner c-tl" }),
            $el("i", { className: "ns-video-corner c-tr" }),
            $el("i", { className: "ns-video-corner c-bl" }),
            $el("i", { className: "ns-video-corner c-br" }),
        ]),
        $el("div", { className: "ns-skills-guide-actions" }, [importBtn, newBtn, listBtn]),
    ]);
    page.append(guide, managerHost, fileInput);
}

// 导入只收 API 工作流（扁平的 node_id → { class_type, inputs }）：ComfyUI 直接点「保存」给出的是
// 界面工作流（nodes / links），塞进技能目录后渲染不出能提交的 API prompt。返回空串 = 可以导入。
function workflowImportProblem(data) {
    if (!data || typeof data !== "object" || Array.isArray(data) || !Object.keys(data).length)
        return t("文件里没有工作流");
    if (Array.isArray(data.nodes) || Array.isArray(data.links))
        return t("这是 ComfyUI 的界面工作流，请在 ComfyUI 里用「导出（API）」保存后再导入");
    for (const node of Object.values(data)) {
        if (!node || typeof node !== "object" || typeof node.class_type !== "string"
            || !node.inputs || typeof node.inputs !== "object")
            return t("文件不是 API 工作流（节点缺少 class_type / inputs）");
    }
    return "";
}

return { buildSkills };
}
