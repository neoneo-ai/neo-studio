// 画布卡面的控件基座：运行钮与胶囊（genBtn / genChip / countChip）、技能 + 自定参数那一枚共享胶囊
// （genParamsChip，就是绘画页与出视频页的那一枚）、节点上那行主模型摘要。胶囊菜单一律挂在页面交下来的那
// 一层浮层里 —— 世界层带 scale、节点裁剪自己的内容，菜单进节点里会跟着缩放并被切掉。共享胶囊按节点签名存
// 一份表单：改一格参数就整层重画，签名没变接同一块（下拉的焦点与滚动位置留着），面板不被重建；技能换了、
// 模型清单到手、这一发开跑 —— 签名变了才换新的，开着的面板重画完在原处接着弹开。四条链共用这一层。
import { t, tf } from "../../../js/core/i18n.js";
import { setIconLabel } from "../../../js/core/icons.js";
import { chipButton, guardMainModelFamily, skillParamsChip } from "../../../gen-utils.js";
import { createModelConfigSection, createVideoModelConfigSection, shortModelName } from "../../../image-gen.js";
import { skillDisplayName } from "../../../skill.js";
import { GEN_COUNT_MAX, GEN_PARAM_KEYS, STEPS_MAX, readGenOverrides, readGenParams } from "./gen-params.js";
import { LAST_SKILL_KEY, LAST_VIDEO_SKILL_KEY } from "./gen-catalog.js";

/** 卡面控件的工厂。`tailSkillSelect` 是串联车尾那一枚技能下拉（长在配方那一段里），装配层接进来 ——
 *  控件层不认配方，只认「传了 follow 就是车尾那一枚」；`groupLabels` / `modeGroup` 是页面交下来的出片
 *  模型分组名表与生成模式表 */
export function createCanvasControls({ $el, host, catalog, groupLabels, modeGroup, tailSkillSelect }) {
    const { cfgOf, primeCfg, skills, videoSkills } = catalog;
    const chips = new Set();
    // 技能 + 自定参数那一枚胶囊按节点存一份（nodeId → 签名 + 那一套表单）：patchMeta 每改一格就整层重画，
    // 面板每重画一次重建的话，下拉的焦点与滚动位置全丢了 —— 签名没变就接同一块；openParams 记着
    // 「这台节点的面板开着」，重画完在原处接着弹开
    const paramsChips = new Map();
    const openParams = new Set();

    // 胶囊菜单挂在页面给的浮层里（世界层带 scale、节点裁剪自己的内容，菜单进那一层会跟着缩放并被节点切掉）。
    // 节点每重画一次控件就整份重建，挂出去的菜单元素由页面在那一层里一起清掉 —— 收菜单只看 document 起手这一下
    document.addEventListener("pointerdown", (e) => {
        for (const chip of chips) {
            if (!chip.el.isConnected) chips.delete(chip);
            else if (chip.isOpen()) chip.closeOnOutside(e.target);
        }
        // 节点没了（删节点、切画布）就把这台节点的表单连同开着的面板一起收掉：那一层里没有节点认得它了
        for (const [id, entry] of paramsChips) {
            if (host.hasNode(id)) continue;
            chips.delete(entry.chip);
            entry.chip.close();
            paramsChips.delete(id);
        }
    }, true);

    /** 密度行上的停用说法：停用的那一张在生成卡与车厢最后一行都写出来，启用与停用都从双击节点那一发来 */
    function densityTitle(node) {
        return node.metadata?.disabled === true
            ? ` · ${t("已停用 · 双击节点启用")}`
            : ` · ${t("停用 · 双击节点停用")}`;
    }

    /** 节点上那行主模型：技能 config 里的那一个；比例与尺寸由技能自己定时说清楚。
     *  自定参数存在时这一行说的是这一发真正生效的那一套（换掉的主模型 / LoRA 条数 / 步数）。
     *  串联的车尾不铺这一行（段数、技能、分辨率都在顶行与那两枚胶囊上，见 chainControls） */
    function modelText(node) {
        const cfg = cfgOf(node.metadata.skill_id);
        if (!cfg) return `${t("主模型：读取中")}${densityTitle(node)}`;
        const ov = readGenOverrides(node);
        const model = ov.model || cfg.model;
        const parts = [model ? tf("主模型：{model}", { model: shortModelName(model) }) : t("主模型：跟随技能配置")];
        if (ov.loras?.length) parts.push(tf("LoRA ×{n}", { n: ov.loras.length }));
        if (ov.steps) parts.push(tf("{n} 步", { n: ov.steps }));
        return `${parts.join(" · ")}${densityTitle(node)}`;
    }

    function genBtn(label, iconName, onclick, title = label, disabled = false, extraClass = "") {
        // disabled 走属性：$el 把它当普通属性落，disabled="false" 在浏览器里就是真禁用（属性只看存在）
        const el = $el("button", { className: `ns-canvas-gen-btn${extraClass ? ` ${extraClass}` : ""}`,
            type: "button", title, "aria-label": title, onclick: disabled ? null : onclick });
        if (disabled) el.disabled = true;
        setIconLabel(el, iconName, label);
        return el;
    }

    /** 张数也是一枚胶囊：点开从 1 到 8 里选一枚（后端一次最多 8 张），不给它留第三格输入 */
    function countChip(node, params, busy) {
        const sel = $el("select", { disabled: busy, title: t("生图张数"),
            onchange: () => host.patchMeta(node.id, { count: Number(sel.value) || 1 }) });
        for (let i = 1; i <= GEN_COUNT_MAX; i += 1) {
            sel.append($el("option", { value: String(i), textContent: tf("{n} 张", { n: i }) }));
        }
        sel.value = String(params.count);
        return genChip(sel, { icon: "images" });
    }

    /** 节点上的一枚胶囊：菜单交页面那一层浮着（genMenus），控件自己留在节点里跟着缩放 */
    function genChip(sel, opts) {
        const chip = chipButton(sel, { ...opts, mount: () => host.genMenus() });
        chips.add(chip);
        return chip.el;
    }

    /** 那一枚技能胶囊里的技能下拉（共用胶囊把它当状态容器收在壳里，只列吃文字输入的生图技能）：
     *  技能被删了、列表没取到时把存的这一个也列出来，胶囊上不能看着是空的 */
    function paramsSkillSelect(node, busy, isVideo) {
        const saved = readGenParams(node).skill_id;
        const sel = $el("select", { disabled: busy,
            title: isVideo
                ? t("技能与自定参数：主模型 / LoRA 留空 = 跟随该技能配置与全局生视频设置")
                : t("技能与自定参数：只列吃文字输入的生图技能；主模型 / LoRA 留空 = 跟随该技能配置与全局生图设置"),
            onchange: () => {
                const id = sel.value;
                try { localStorage.setItem(isVideo ? LAST_VIDEO_SKILL_KEY : LAST_SKILL_KEY, id); } catch { /* 隐私模式记不住就算了，不挡出片 */ }
                // 换技能 = 技能钉的那一套整份换掉：这台节点自定的那几项跟着清空。patchMeta 要整层重画，
                // 记着「面板开着」才弹得回来 —— 绘画页选技能不收面板，右栏就是要看新技能钉的那一套
                openParams.add(node.id);
                host.patchMeta(node.id, { skill_id: id, gen_params: {} });
                primeCfg(id);
            } });
        sel.append($el("option", { value: "", textContent: t("未选技能") }));
        for (const s of (isVideo ? videoSkills.rows : skills.rows)) {
            const opt = $el("option", { value: s.id, textContent: skillDisplayName(s) });
            opt.__skillMeta = s;   // 面板左栏的技能分组与主模型家族守卫认的就是这一个
            sel.append(opt);
        }
        sel.value = saved;
        if (sel.value !== saved) {
            sel.value = "";
            sel.appendChild($el("option", { value: saved, textContent: saved, disabled: true, selected: true }));
        }
        return sel;
    }

    /** 出图 / 出片节点上那一枚技能胶囊就是绘画页与出视频页的那一枚（skillParamsChip）：点开的双栏面板
     *  左栏换技能、右栏改这一发的自定参数 —— 出图 = 主模型 + LoRA，出片 = 生视频模型 / Text Encoder /
     *  视频 VAE / 音频 VAE / 步数 + LoRA。空 = 跟随该技能 config 与全局生图 / 生视频设置：与技能钉的那一份
     *  相同的值不落盘，技能配置改了这台节点跟着走；改动当场写进 metadata.gen_params（进撤销栈、随画布落盘）。
     *  传了 `follow`（「跟随配方 …」那一句）就是串联车尾那一枚：只有技能一栏，出片参数不在这里改。
     *  表单按节点签名存一份（见 paramsChips）：改一格参数就整层重画，签名没变接同一块，面板不被重建；
     *  技能换了、模型清单到手、这一发开跑 —— 签名变了才换新的，面板开着时重画完接着在原处弹开 */
    function genParamsChip(node, { icon, isVideo, busy, follow }) {
        const tail = follow != null;   // 车尾那一枚：整列共用一个技能，参数是整列出片共用的那一份
        const skillId = readGenParams(node).skill_id;
        const models = catalog.models(isVideo);
        const key = `${tail ? "t" : isVideo ? "v" : "i"}|${skillId}|${(isVideo ? videoSkills : skills).rows.length}`
            + `|${busy ? 1 : 0}|${models ? 1 : 0}|${cfgOf(skillId) ? 1 : 0}|${tail ? follow : ""}`;
        // 撤销与切画布把节点对象整份换掉：闭包里那份旧的只能用来认 id，读值要拿画布上活着的那一台
        const live = () => host.getState().nodes.find((n) => n.id === node.id) || node;
        const keepOpen = openParams.has(node.id);   // 换旧的表单会收面板：这一份记着「收之前开着」，新的铺完接着弹开
        // 换表单那一路 old.chip.close() 走的是旧的 onClose，会把这一份抹掉：弹开之后要把它钉回去，
        // 下一发重画（技能 config 到手、模型清单到手）才认得出「这一台的面板还开着」
        const reopen = (chip) => { if (!keepOpen) return; chip.open(); openParams.add(node.id); };
        const old = paramsChips.get(node.id);
        if (old && old.key === key) {
            old.chip.sync();
            reopen(old.chip);
            return old;
        }
        if (old) {
            chips.delete(old.chip);
            old.chip.close();
            paramsChips.delete(node.id);
        }
        const skillSel = tail ? tailSkillSelect(node, busy, follow) : paramsSkillSelect(node, busy, isVideo);
        // 出片（含车尾那一枚）的右栏就是出视频页那块模型链表单；车尾改的这一段是整列出片共用的那一份
        const cfg = isVideo
            ? createVideoModelConfigSection()
            : createModelConfigSection({ getSkillId: () => readGenParams(live()).skill_id });
        const box = $el("div", { className: "neo-gallery-gm-model-box" }, [cfg.el]);
        if (!isVideo) {
            // 出图只露主模型与 LoRA：Text Encoder / VAE 是高级行，与绘画页那一条摘掉同一批
            for (const row of cfg.el.querySelectorAll(".rs-gen-adv-row")) row.remove();
            guardMainModelFamily(cfg, skillSel);   // 手填主模型与该技能家族对撞就当场收回这一选（绘画页同一判定）
        }
        if (tail) {
            // 车尾的步数在「参数」弹窗里（metadata.steps 那一份，与锚点 / 种子同处）：右栏只给模型链与 LoRA，一口子不两处
            box.querySelector(".rs-gen-steps")?.closest(".rs-config-row")?.remove();
        }
        const stored = readGenOverrides(live());
        const entry = {
            key,
            last: JSON.stringify(stored),
            chip: skillParamsChip(skillSel, box, {
                icon,
                getOverride: () => readGenOverrides(live()),
                // 出片技能按生成模式分组（出视频页同一份判法与词表）：全参考生视频那一组在画布上要看得见
                ...(isVideo ? { groupOf: modeGroup, groupLabels } : {}),
                panelClass: busy ? "ns-canvas-params-busy" : "",
                mount: () => host.genMenus(),
                onClose: () => openParams.delete(node.id),
            }),
        };
        chips.add(entry.chip);
        // 点开就记着「这台节点的面板开着」：整层重画完要在原处接着弹开（收窗那一路走 onClose 摘掉）
        entry.chip.chip.addEventListener("click", () => { if (entry.chip.isOpen()) openParams.add(node.id); });
        const write = () => {
            const ov = cfg.collect();
            const base = cfgOf(readGenParams(live()).skill_id) || {};
            const patch = {};
            for (const field of GEN_PARAM_KEYS) {
                const v = ov[field];
                if (v === "" || v == null) continue;
                if (field === "steps") {
                    // 步数没动过 = 这一发跟着技能配置走（出视频页同一判法）
                    if (cfg.stepsFollowSkill?.() || !(Number(v) > 0)) continue;
                    patch.steps = Math.min(Number(v), STEPS_MAX);
                    continue;
                }
                if (String(base[field] ?? "") === String(v)) continue;   // 与技能钉的一样 = 跟随，不钉死
                patch[field] = v;
            }
            const loras = (ov.loras || [])
                .filter((row) => String(typeof row === "string" ? row : row?.name || "").trim());
            if (loras.length) patch.loras = loras;
            const json = JSON.stringify(patch);
            if (json === entry.last) return;   // 真没改就不压撤销栈：加一条空 LoRA 行、点开下拉都算这一发
            entry.last = json;
            host.patchMeta(node.id, { gen_params: patch });
            entry.chip.sync();
        };
        cfg.el.addEventListener("change", write);
        // 删 LoRA 行（✕）与「+ 添加 LoRA」是按钮，不发 change：跟着点击写一次，不然删掉的那一条还钉在盘上
        cfg.el.addEventListener("click", write);
        // 模型清单没到手就不铺：面板里的模型行没有可列的东西，这一发照技能 config 与全局设置走
        if (models) cfg.load({ ...(cfgOf(skillId) || {}), ...stored }, models,
            { stepsFromRun: Number(stored.steps) >= 1 });
        paramsChips.set(node.id, entry);
        reopen(entry.chip);
        return entry;
    }

    return { chips, paramsChips, openParams, genBtn, genChip, countChip, genParamsChip, modelText };
}
