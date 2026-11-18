// 技能页（#/skills）：默认停在引导页，管理组件点了入口才装配——落地在引导页时不拉技能列表，也不铺一块空列表。
// 起手版式照导演页 / 绘画页 / 视频页的空白态（.neo-gallery-gm-idle 主行 + 细注行 + 四角括号）；三个入口分别
// 是导入 API 工作流建技能、写一份 skill.md 模板技能、浏览与编辑已有技能。
// 工厂只接装配层给得出的那两样（建元素与提示条）；技能管理组件、导入接口、文案与图标自己 import。
import { t, tf } from "../../js/core/i18n.js";
import { setIconLabel } from "../../js/core/icons.js";
import { createSkillManager, importWorkflowSkill, listSkillSources, installSkillSource, dispatchSkillsUpdated } from "../../skill.js";

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
        page.classList.remove("ns-skills-editing", "ns-skills-cloud");
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

    // 云端技能入口：源不可用就不出这枚控件（产品面不变量）。可用与否读一次本机配置就够——
    // 源未配置时后端不联网直接回「未配置」，配好了也在 TTL 内命中缓存索引，都不发请求
    const cloudBtn = $el("button", { className: "ns-btn", type: "button", title: t("从云端订阅源查看并安装技能") });
    setIconLabel(cloudBtn, "cloud", t("云端技能"));
    cloudBtn.hidden = true;
    cloudBtn.onclick = () => showCloud();
    listSkillSources().then((data) => { cloudBtn.hidden = !data.enabled; });

    let cloud = null;
    const showCloud = async () => {
        if (mgr?.isDirty() && !confirm(t("当前技能有未保存的修改，切到云端技能将丢弃这些修改。"))) return;
        page.classList.remove("ns-skills-editing");
        page.classList.add("ns-skills-cloud");
        cloud = cloud || buildCloudPanel(page, $el, toast, showGuide);
        await cloud.load(false);
    };

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
        $el("div", { className: "ns-skills-guide-actions" }, [importBtn, newBtn, listBtn, cloudBtn]),
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

// 云端技能面板：一份清单 + 每行的本地状态 + 安装/更新那一步。清单拉取只在本面板打开与「刷新清单」
// 时发生，拉取失败显示上次成功的清单与最近成功时间（已装的技能不受影响）。安装走后端那条既有
// 技能包安装口：装进 skills/custom/，预设只读与「只有 USR 可删」这两条规则一字不动地生效。
const CLOUD_STATE_LABELS = {
    not_installed: t("未安装"),
    installed: t("已安装"),
    upgrade: t("可更新"),
    local_modified: t("本地已修改"),
    blocked_preset: t("与内置技能同名"),
};
const CLOUD_ACTION_LABELS = { not_installed: t("安装"), upgrade: t("更新"), local_modified: t("确认覆盖") };

function cloudAgeText(hours) {
    if (hours === null || hours === undefined) return t("从未成功拉取");
    if (hours < 1) return t("刚刚");
    if (hours < 48) return tf("{n} 小时前", { n: Math.round(hours) });
    return tf("{n} 天前", { n: Math.round(hours / 24) });
}

function buildCloudPanel(host, $el, toast, back) {
    const panel = $el("div", { className: "ns-skills-cloud-panel" });
    const status = $el("div", { className: "ns-skills-cloud-status", textContent: t("云端清单加载中…") });
    const list = $el("div", { className: "ns-skills-cloud-list" });
    const refresh = $el("button", { className: "ns-btn", type: "button", textContent: "⟳ " + t("刷新清单"), title: t("重新拉取云端清单（唯一一次强拉）") });
    const backBtn = $el("button", { className: "ns-skills-back", type: "button", textContent: t("← 引导页"), title: t("返回技能引导页") });
    backBtn.addEventListener("click", back);
    refresh.addEventListener("click", () => load(true));
    panel.append(
        $el("div", { className: "ns-skills-cloud-bar" },
            [backBtn, $el("span", { className: "ns-skills-cloud-title", textContent: t("云端技能") }), refresh]),
        status, list);
    host.appendChild(panel);
    let loading = false;

    function statusLine(data) {
        const age = cloudAgeText(data.age_hours);
        if (!data.enabled) return data.hint || t("云端技能源未配置");
        if (data.reason === "fetch_failed") return tf("清单拉取失败，下面是上次成功的清单（{age}）", { age });
        if (data.reason === "bad_index") return tf("云端清单读不出，下面是上次成功的清单（{age}）", { age });
        return tf("共 {n} 条 · 最近刷新 {age}", { n: (data.skills || []).length, age });
    }

    async function installed(row) {
        toast(tf("已安装「{name}」", { name: row.name || row.id }));
        dispatchSkillsUpdated();
        await load(false);
    }

    async function install(row, btn) {
        btn.disabled = true;
        const r = await installSkillSource(row.id, false);
        if (r.success) return installed(row);
        // 本地改过的技能只在这一发确认后覆盖：后端没给 allow_modified 就一动不动文件
        if (r.code === "local_modified") {
            if (!confirm(tf("技能「{id}」本地已修改：覆盖会丢掉你改过的内容。要用云端这一份覆盖吗？", { id: row.id }))) {
                btn.disabled = false;
                return;
            }
            const forced = await installSkillSource(row.id, true);
            if (forced.success) return installed(row);
            toast(tf("安装失败：{msg}", { msg: forced.message }));
            btn.disabled = false;
            return;
        }
        toast(tf("安装失败：{msg}", { msg: r.message }));
        btn.disabled = false;
    }

    function render(data) {
        status.textContent = statusLine(data);
        const rows = data.skills || [];
        if (!rows.length) {
            list.replaceChildren($el("div", { className: "ns-skills-cloud-empty", textContent: t("云端清单里还没有技能") }));
            return;
        }
        list.replaceChildren(...rows.map((row) => {
            const kids = [
                $el("span", { className: "ns-skills-cloud-name", textContent: row.name || row.id, title: row.id }),
                $el("span", { className: "ns-skills-cloud-desc", textContent: row.description || "" }),
            ];
            if (row.state === "upgrade") {
                kids.push($el("span", { className: "ns-skills-cloud-meta", textContent: `${row.installed_version} → ${row.version}` }));
            }
            kids.push($el("span", { className: "ns-skills-cloud-state", textContent: CLOUD_STATE_LABELS[row.state] || "" }));
            const label = CLOUD_ACTION_LABELS[row.state];
            if (label) {
                const btn = $el("button", { className: "ns-btn", type: "button", textContent: label });
                btn.addEventListener("click", () => install(row, btn));
                kids.push(btn);
            }
            return $el("div", { className: "ns-skills-cloud-row" }, kids);
        }));
    }

    async function load(force) {
        if (loading) return null;
        loading = true;
        refresh.disabled = true;
        const data = await listSkillSources(force);
        refresh.disabled = false;
        loading = false;
        render(data);
        return data;
    }

    return { panel, load };
}

return { buildSkills };
}
