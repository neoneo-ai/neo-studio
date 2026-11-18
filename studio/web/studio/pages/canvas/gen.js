// 画布上的生成节点：技能与参数存在节点 metadata 里（随画布落盘、进撤销栈、跟复制走），出图走「生成素材」
// 那条链（POST /neo_image_gen/generate + rs.image_gen.status 事件推送），结果写回该节点下游的图片节点。
// 参数控件直接铺在节点上 —— 胶囊与比例字形是 gen-utils 那一套，与绘画页同一手感；节点缩放时控件跟着缩放，
// 拖节点用控件之外那一片，缩放走四角尺寸柄。胶囊是精简的那一枚（图标 + 生效值，没有行标签），
// 每一枚是干什么的写在悬停提示里。
// 这一层不持画布 state：读写全走页面交下来的那几条（host.getState / patchMeta / applyResult / paintNodes）。
import { t, tf } from "../../../js/core/i18n.js";
import { setIconLabel } from "../../../js/core/icons.js";
import { chipButton, ratioGlyph } from "../../../gen-utils.js";
import { cancelTask, COMMON_EDGES, COMMON_RATIOS, getSkillGenConfig,
    requestGeneration, shortModelName, watchTask } from "../../../image-gen.js";
import { listSkills, skillAcceptsText, skillDisplayName } from "../../../skill.js";

// 画布自己记的默认技能（绘画页与视频页各记各的，同一套法）：新建生成节点带出上一次在这页选的技能
const LAST_SKILL_KEY = "neo.canvas.skill";
const GEN_COUNT_MAX = 8;          // 后端 MAX_IMAGES：一次最多这么多张，画布上也不至于铺不满

/** 生效参数：空串与 0 是「跟随」—— 技能 config 与全局生图设置由后端合并，请求里不带这一项 */
export function readGenParams(node) {
    const meta = node?.metadata || {};
    const count = parseInt(meta.count, 10);
    return {
        skill_id: String(meta.skill_id || ""),
        default_ratio: String(meta.default_ratio || ""),
        base_resolution: Number(meta.base_resolution) > 0 ? Number(meta.base_resolution) : 0,
        count: count >= 1 && count <= GEN_COUNT_MAX ? count : 1,
    };
}

/** 这一发的输入：上游连线里的提示词按连线顺序拼接；图片按参考图那套标注给后端 ——
 *  画布图片节点存的正是 Output 目录里的那一份，[output] 标注让后端从输出目录取并拷进 input */
export function genInputs(state, genNodeId) {
    const prompts = [];
    const references = [];
    for (const conn of state.connections) {
        if (conn.toNodeId !== genNodeId) continue;
        const node = state.nodes.find((n) => n.id === conn.fromNodeId);
        if (!node) continue;
        const text = String(node.metadata?.content || "").trim();
        if (node.type === "text" && text) prompts.push(text);
        const filename = node.type === "image" ? String(node.metadata?.filename || "") : "";
        if (!filename) continue;
        const sub = String(node.metadata?.subfolder || "");
        references.push({ kind: "input", value: `${sub ? `${sub}/` : ""}${filename}[output]` });
    }
    return { prompts, references };
}

export function createCanvasGen({ $el, toast, canGen, startComfy, host }) {
    // 一发一份运行态（节点上那一行状态就是它）。watchTask 在终态自己摘监听；切画布只把这一发脱手：
    // 图已经落在 Output 目录，不再写回旧画布，也不在页面外头留一份没人收的监听
    const running = new Map();
    const detached = new Set();
    const skills = { rows: [], inflight: null };
    const cfgs = { byId: new Map(), inflight: new Map() };
    const chips = new Set();
    // 胶囊菜单挂在页面给的浮层里（世界层带 scale、节点裁剪自己的内容，菜单进那一层会跟着缩放并被节点切掉）。
    // 节点每重画一次控件就整份重建，挂出去的菜单元素由页面在那一层里一起清掉 —— 收菜单只看 document 起手这一下
    document.addEventListener("pointerdown", (e) => {
        for (const chip of chips) {
            if (!chip.el.isConnected) chips.delete(chip);
            else if (chip.isOpen()) chip.closeOnOutside(e.target);
        }
    }, true);

    function loadSkills() {
        if (skills.rows.length) return Promise.resolve(skills.rows);
        if (!skills.inflight) {
            skills.inflight = listSkills()
                .then((rows) => {
                    skills.rows = (rows || []).filter((s) => s.gen_image && skillAcceptsText(s));
                    return skills.rows;
                })
                .catch(() => [])
                .finally(() => { skills.inflight = null; });
        }
        return skills.inflight;
    }

    function skillName(id) {
        if (!id) return t("未选技能");
        const hit = skills.rows.find((s) => s.id === id);
        return hit ? skillDisplayName(hit) : id;
    }

    /** 「加生成节点」的默认技能：上次在这页选的那一个，没有就落内置生图技能 */
    function defaultSkillId() {
        let last = "";
        try { last = localStorage.getItem(LAST_SKILL_KEY) || ""; } catch { /* 隐私模式记不住就算了，不挡建节点 */ }
        if (skills.rows.some((s) => s.id === last)) return last;
        return skills.rows.some((s) => s.id === "image_gen") ? "image_gen" : (skills.rows[0]?.id || "");
    }

    function stateOf(node) {
        const st = running.get(node.id);
        return {
            status: st?.status || "",
            done: st?.done || 0,
            total: st?.total || 0,
            error: st?.error || "",
            offline: canGen() === false,
        };
    }

    function setRunning(id, patch) {
        running.set(id, { ...(running.get(id) || {}), ...patch });
        host.paintNodes();
    }

    function finish(nodeId, snap) {
        const fell = detached.delete(snap.task_id);
        if (snap.status === "succeeded") {
            running.delete(nodeId);
            host.paintNodes();
            // 切画布时脱手的那一发、以及节点已被删掉的：图就在 Output 目录里，不往现在这张画布上写
            if (fell || !host.hasNode(nodeId)) { toast(t("图已存进 Output 目录"), "success"); return; }
            host.applyResult(nodeId, snap.images || []);
            toast(tf("已出图 {n} 张", { n: (snap.images || []).length }), "success");
            return;
        }
        if (snap.status === "cancelled") {
            running.delete(nodeId);
            host.paintNodes();
            toast(t("已取消出图"), "info");
            return;
        }
        const msg = String(snap.error || "");
        const needKey = ["GEMINI_API_KEY", "GOOGLE_API_KEY"].some((k) => msg.includes(k)) || msg.includes("apiKey");
        running.set(nodeId, { ...(running.get(nodeId) || {}),
            status: "failed", error: needKey ? t("技能缺 API Key，在技能管理里填好再出图") : msg });
        host.paintNodes();
        if (needKey) {
            toast(t("技能缺 API Key，已为你打开技能管理"), "info");
            startComfy?.();   // 页面把这一枚钮接去技能管理：缺 Key 就是要去填它
            return;
        }
        toast(`${t("出图失败")}${msg ? `：${msg}` : ""}`, "error");
    }

    function run(node) {
        if (running.has(node.id)) return;
        if (canGen() === false) {
            startComfy?.();   // 出图要执行队列：按一下就替用户去启它，这一发不排队
            toast(t("出图需要 ComfyUI 执行队列，已试着启动，好了再按一次"), "warn");
            return;
        }
        const params = readGenParams(node);
        if (!params.skill_id) { toast(t("先选一个生图技能"), "info"); return; }
        const state = host.getState();
        const { prompts, references } = genInputs(state, node.id);
        // 技能收不进文本就别把正文发出去：后端会 400，画布上提前说清楚（参考图照带）
        const skill = skills.rows.find((s) => s.id === params.skill_id);
        if (prompts.length && skill && !skillAcceptsText(skill)) {
            toast(tf("{skill} 不吃文本提示词，接上参考图再出图", { skill: skillName(params.skill_id) }), "info");
            return;
        }
        if (!prompts.length && !references.length) { toast(t("接一条文本或图片线过来再出图"), "info"); return; }
        const body = { skill_id: params.skill_id, prompt: prompts.join("\n\n"),
            references, count: params.count };
        if (params.default_ratio) body.default_ratio = params.default_ratio;
        if (params.base_resolution) body.base_resolution = params.base_resolution;
        Promise.resolve(startComfy())   // 宿主可以同步回话：不押它一定交 Promise
            .then(() => requestGeneration(body))
            .then((res) => {
                // requestGeneration 的契约：成功交后端那一份 {task_id,status}，失败抛 Error（落进 catch）
                setRunning(node.id, { task_id: res.task_id, status: res.status || "queued",
                    done: 0, total: params.count, error: "" });
                watchTask(res.task_id, (snap) => {
                    if (snap.status === "queued" || snap.status === "running") {
                        const cur = running.get(node.id);
                        if (!cur) return;   // 脱手的那一发不在这一张画布上，进度不写它
                        const p = snap.progress;
                        setRunning(node.id, { status: snap.status,
                            done: p ? Number(p.value) || 0 : (snap.images || []).length,
                            total: p ? Number(p.max) || cur.total : cur.total });
                        return;
                    }
                    finish(node.id, snap);
                });
            })
            .catch((err) => {
                const msg = String(err?.message || err);
                running.set(node.id, { status: "failed", error: msg });
                host.paintNodes();
                toast(`${t("出图失败")}：${msg}`, "error");
            });
    }

    function cancel(node) {
        const st = running.get(node.id);
        // 出队交后端：跑着的那一发后端会推 cancelled 那一格，摘监听与收摊都归 watchTask 与 finish
        if (st?.task_id) cancelTask(st.task_id);
        else running.delete(node.id);
    }

    /** 切画布项目：这一发脱手 —— 图落在 Output 目录里，不再写回旧画布，也不在页面外头留一份没人收的监听 */
    function detachTask(taskId, nodeId) {
        detached.add(taskId);
        running.delete(nodeId);
    }

    /** 卸页与切项目共用的那一发：把还在跑的先脱手，再断监听。脱手那一份名单留着 ——
     *  终态那一格晚于切画布到达时，靠它认得出「这一发不再写回哪张画布」，只说一句图已存进 Output */
    function stopAll() {
        for (const [nodeId, st] of running) detachTask(st.task_id, nodeId);
        running.clear();
    }

    /** 技能 config 缓存：节点上「主模型」那一行与比例 / 长边的跟随态读它。一份技能只取一次
     *  （画布上同技能的节点共用这一份），取到手才重画节点 */
    function cfgOf(skillId) {
        return cfgs.byId.get(String(skillId || "")) || null;
    }

    function primeCfg(skillId) {
        const id = String(skillId || "");
        if (!id || cfgs.byId.has(id) || cfgs.inflight.has(id)) return;
        const inflight = getSkillGenConfig(id)
            .then((cfg) => { cfgs.byId.set(id, cfg || {}); host.paintNodes(); })
            .catch(() => { cfgs.byId.set(id, {}); })
            .finally(() => { cfgs.inflight.delete(id); });
        cfgs.inflight.set(id, inflight);
    }

    /** 节点上那行主模型：技能 config 里的那一个；比例与尺寸由技能自己定时说清楚 */
    function modelText(skillId) {
        const cfg = cfgOf(skillId);
        if (!cfg) return t("主模型：读取中");
        return cfg.model ? tf("主模型：{model}", { model: shortModelName(cfg.model) }) : t("主模型：跟随技能配置");
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


    /**
     * 铺在节点上的控件：技能、比例、长边、张数一行一枚胶囊，出图与取消在右下角。
     * 改动当场走 host.patchMeta —— 进撤销栈、跟复制走、随画布落盘；比例与长边的「跟随」态跟着技能 config 走。
     */
    function controls(node) {
        const params = readGenParams(node);
        const st = running.get(node.id) || {};
        const busy = st.status === "queued" || st.status === "running";
        const offline = canGen() === false;
        const cfg = cfgOf(params.skill_id);
        primeCfg(params.skill_id);

        const skillSel = $el("select", { disabled: busy, title: t("技能"), onchange: () => {
            const id = skillSel.value;
            try { localStorage.setItem(LAST_SKILL_KEY, id); } catch { /* 隐私模式记不住就算了，不挡出图 */ }
            host.patchMeta(node.id, { skill_id: id });
            primeCfg(id);
        } });
        skillSel.append($el("option", { value: "", textContent: t("未选技能") }));
        for (const s of skills.rows) skillSel.append($el("option", { value: s.id, textContent: skillDisplayName(s) }));
        skillSel.value = params.skill_id;
        if (skillSel.value !== params.skill_id) {
            // 技能列表没取到、或节点上存的技能被删了：把存的这一个也列出来，参数行不能看着是空的
            skillSel.value = "";
            skillSel.appendChild($el("option", { value: params.skill_id, textContent: params.skill_id,
                disabled: true, selected: true }));
        }

        const ratioSel = $el("select", { disabled: busy, title: t("默认比例"),
            onchange: () => host.patchMeta(node.id, { default_ratio: ratioSel.value }) });
        ratioSel.append($el("option", { value: "", textContent: t("默认比例") }));
        for (const r of COMMON_RATIOS) ratioSel.append($el("option", { value: r, textContent: r }));
        ratioSel.value = params.default_ratio;
        ratioSel.dataset.follow = t("默认比例");
        if (cfg?.follow_ratio) {
            ratioSel.value = "";
            ratioSel.dataset.follow = t("跟随技能 {ratio}", { ratio: cfg.default_ratio || "" });
        }

        const edgeSel = $el("select", { disabled: busy, title: t("长边尺寸"),
            onchange: () => host.patchMeta(node.id, { base_resolution: Number(edgeSel.value) || 0 }) });
        edgeSel.append($el("option", { value: "0", textContent: t("长边尺寸") }));
        for (const e of COMMON_EDGES) edgeSel.append($el("option", { value: String(e), textContent: String(e) }));
        edgeSel.value = String(params.base_resolution || 0);
        edgeSel.dataset.follow = t("长边尺寸");
        if (cfg?.follow_resolution) {
            edgeSel.value = "0";
            edgeSel.dataset.follow = t("跟随技能 {edge}", { edge: cfg.base_resolution || "" });
        }

        const acts = [];
        if (busy) acts.push(genBtn(t("取消任务"), "cross", () => cancel(node), t("取消这一发后台任务")));
        // 出图是这一张卡的主按钮：独占最后一行铺满、主色实心，一眼看见（参考无限画布卡片底部那条生成钮）
        acts.push(genBtn(t("出图"), "play", () => run(node),
            // 离线不 disable：按下去就是要替用户去启队列的（run 里说清楚）；只有这一发在跑才收着
            offline ? t("出图需要 ComfyUI 执行队列") : t("提交这一发生图任务"), busy, "ns-canvas-gen-go"));
        return [
            $el("div", { className: "ns-canvas-gen-skill" }, [genChip(skillSel, { icon: "sparkles" })]),
            $el("div", { className: "ns-canvas-gen-params" },
                [genChip(ratioSel, { glyph: ratioGlyph() }), genChip(edgeSel, { icon: "image" }),
                    countChip(node, params, busy)]),
            $el("div", { className: "ns-canvas-gen-bottom" }, [$el("div", { className: "ns-canvas-gen-acts" }, acts)]),
        ];
    }

    /** 「加生成节点」把技能列表取到手：胶囊里列的就是那一份；技能被删了，旧画布上的节点要能认出来 */
    function prime() {
        loadSkills().then(host.paintNodes).catch(() => {});
    }

    return {
        stateOf,
        skillName,
        defaultSkillId,
        modelText,
        controls,
        prime,
        run,
        cancel,
        stopAll,
    };
}
