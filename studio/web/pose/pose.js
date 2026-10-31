/**
 * pose.js — 桌面端「3D 摆姿」页宿主（Studio 视图）。
 *
 * 摆姿包 = 3d-pose-art 的 vite 产物，后端伺服在 /pose-dist/，短路径 /neo-pose 跳到入口页
 * （产物是 base:'./' 的相对 import，页面必须有目录深度，理由见 studio/pose.py）。控件在宿主这一侧：
 * 左栏姿势库与场景，右栏摆姿控制面板，画布在中间的 iframe 里跑。宿主复刻不了那份 three.js 运行时，
 * 面板的每个动作都经 pose:call 落进页面（动作清单在摆姿页 src/ui/hostCommands.js），画布状态经
 * pose:state 回流。页面在 caps.hostUi 下收起自己的 demo 控件 —— 同一时刻只有一套控件在场上。
 *
 * 桥的消息名与方向 —— 名单由 /neo_pose/status 下发，宿主、摆姿页、后端测试三处同名：
 *   页面 → 宿主  pose:ready        页面装配完，宿主立刻回一份 pose:theme
 *   页面 → 宿主  pose:state        画布状态快照（素体 / 人数 / 道具数），面板镜像它
 *   宿主 → 页面  pose:theme        能力位与语言：caps.hostUi 决定页面收不收 demo 控件
 *   宿主 → 页面  pose:export-image 请求导出画布，页面从回复端口回 {data, name}
 *   宿主 → 页面  pose:save-scene   请求序列化场景，页面从回复端口回 {scene}
 *   宿主 → 页面  pose:open-scene   把已存场景装回页面
 *   宿主 → 页面  pose:call         一个面板动作，页面从回复端口回 {ok, data} 或 {ok:false, error}
 * 请求类消息带 MessageChannel 回复端口：回复只落在这条端口上，宿主页上另挂一个 iframe 也
 * 冒充不了回复。入站通知另外认两件事 —— 来源必须是本页这张 iframe，origin 必须与宿主同源。
 */
import { t, tf, getLang } from "../js/core/i18n.js";
import { setIconLabel } from "../js/core/icons.js";
import { createLibraryModal } from "../js/core/lib-modal.js";

// 组件样式在第一次建视图时注入（幂等）：本模块也会被主画布页的扩展图加载，
// 放在模块顶层会让画布为一份用不上的样式表发一次请求。
function ensureCss() {
    if (document.getElementById("neo-pose-css")) return;
    const link = document.createElement("link");
    link.id = "neo-pose-css";
    link.rel = "stylesheet";
    link.href = "/extensions/comfyui-neo-studio/pose/pose.css";
    document.head.appendChild(link);
}

export const POSE_PAGE_URL = "/neo-pose";   // 后端 302 到前缀下的入口页

const CALL_TIMEOUT_MS = 15000;   // 页面不回包就解锁控件：一次点击不许把面板锁死
const MAX_SET_FILES = 12;        // /neo_pose/export_set 一次落盘的上限，与后端常量同值
const MAX_GLB_BYTES = 48 * 1024 * 1024;   // /neo_pose/import_model 的一份自备素体上限，与后端同值
const BODY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;   // 素体 key：与后端 SCENE_NAME_RE 同一条

// 姿势库（pose-lib）：库数据由 tools\sync_pose_lib.ps1 同步进 <数据根>/pose/lib，静态伺服挂在 /pose-lib/
// 上一级（studio/pose.py 的 LIB_PREFIX）。库里一份条目就是画布导出的 PoseFile，套进画布走的是
// 「载入姿态」那条 pose/apply —— 库只是多出来的另一批文件，不造第二条套用通路。
const LIB_PREFIX = "/pose-lib";
const LIB_INDEX = `${LIB_PREFIX}/index.json`;
const LIB_PAGE = 200;      // 一次渲染的卡片上限：库里 600+ 条全塞进 DOM，首屏与滚动都撑不住
const LIB_VARIANTS = ["clay", "skeleton", "silhouette", "depth"];   // 缩略图优先级，与摆姿页 thumbOf 同一条
const LIB_SYNC_HINT = "姿势库未同步：跑 tools\\sync_pose_lib.ps1 -Source <3d-pose-art 仓库根>" +
    " 把 pose-lib 同步进 <数据根>/pose/lib。";

/** 页面开局是摄影棚灰（摆姿页 core/scene.js 的 LOOKS.studio），面板按产品口径把外观定在暗色档 */
const DEFAULT_LOOK_KEY = "dark";

/** 道具显示名归一：页面 label 带全角括号后缀（细剑（Sting））时，括号前的名字也算同一个名字 */
function propChoiceName(text) {
    return String(text ?? "").trim().toLowerCase()
        .replace(/[（(].*?[)）]\s*$/, "")
        .replace(/\s+/g, "");
}

/**
 * 自由填写的道具名 → 页面认的 propKey（内置 `builtin:chair`、注册表 `glb:arrow.glb`）。
 *
 * 面板上看见的是中文 label（椅子），页面 addProp 要的是带前缀的 propKey，中间这一层只能
 * 宿主做：内置道具表在摆姿包里，宿主不许复刻它的定义，只做「名字 → 清单里那一项」的查找。
 * 认四种写法：全 key、裸 id（chair / arrow.glb）、中文 label（椅子 / 细剑）。
 * @param {string} input 用户输入
 * @param {Array<{key?: string, propKey?: string, label?: string}>} options meta/list 的道具项
 * @returns {string|null} 命中的 propKey；清单里没有这个定义时 null
 */
export function resolvePropChoice(input, options) {
    const full = propChoiceName(input);
    if (!full) return "";
    const q = full.replace(/\.glb$/, "");   // 带扩展名的写法（arrow.glb）与裸名（arrow）同一个落点
    const rows = Array.isArray(options) ? options : [];
    const keyOf = (r) => String(r.key ?? r.propKey ?? "");
    const bareOf = (r) => propChoiceName(keyOf(r).replace(/^(builtin|glb):/, "")).replace(/\.glb$/, "");
    const hit = rows.find((r) => propChoiceName(keyOf(r)) === full)
        || rows.find((r) => propChoiceName(r.label) === full)
        || rows.find((r) => bareOf(r) === q);
    return hit ? keyOf(hit) : null;
}

/** 建「3D 摆姿」视图。依赖由宿主注入：api 走 shim（离线与在线同一条路） */
export function createPoseView({ api, $el, toast }) {
    return async function buildPose(el) {
        ensureCss();
        el.classList.add("ns-pose");
        let frame = null;
        let caps = {};
        let pickedPreset = "";
        let pickedScene = "";
        let pickedProp = "";
        let propChoices = [];   // meta/list 的道具项：自由填写的名字只在这份清单里解析，不猜定义
        const canvas = {};

        // 两层门控：读写本机文件只认 pose:ready；摆姿动作还要 caps.hostUi —— 旧摆姿包没有
        // 宿主命令层，控件摆出来只会在页面里空转（能力不可用就不出控件）
        const libGate = [];
        const panelGate = [];

        const btn = (label, iconKey, gate, extra = "") => {
            const b = $el("button", { className: "ns-pose-btn" + extra, type: "button" });
            setIconLabel(b, iconKey, t(label));
            gate.push(b);
            return b;
        };
        const sel = (label, gate) => {
            const s = $el("select", { className: "ns-pose-sel", title: t(label) });
            gate.push(s);
            return s;
        };
        const field = (placeholder) => $el("input", {
            className: "ns-pose-name", type: "text", spellcheck: "false", placeholder: t(placeholder),
        });
        const row = (kids) => $el("div", { className: "ns-pose-row" }, kids);
        const list = (extra = "") => $el("div", { className: "ns-pose-list" + extra });
        const head = (label) => $el("div", { className: "ns-pose-head", textContent: t(label) });
        const group = (label, kids) => $el("section", { className: "ns-pose-group" }, [head(label), ...kids]);

        /* 左栏：姿势库（pose/export 的产物）与场景（pose:save-scene 的产物），都是数据根里的文件 */
        const presetList = list();
        const sceneList = list();
        const presetName = field("姿态名");
        const sceneName = field("场景名");
        const btnSavePreset = btn("存为姿态", "copy", panelGate);
        const btnLoadPreset = btn("载入姿态", "send", panelGate);
        const btnDelPreset = btn("删姿态", "trash", libGate);
        const btnBrowseLib = btn("浏览姿势库…", "list", panelGate);   // pose-lib 的库浏览器 + 本机姿势文件
        const btnSaveScene = btn("存为场景", "copy", libGate);
        const btnLoadScene = btn("载入场景", "folder", libGate);
        const btnBrowseScenes = btn("浏览场景…", "list", libGate);    // 数据根的场景列表 + 本机场景文件
        // 跑在随包副本上要说清楚：随包只发 CC0 那一份素体，其余 GLB 素体不在页面上。
        // 不写这一句，用户只会以为素体列表坏了
        const pkgNote = $el("div", {
            className: "ns-pose-blank",
            textContent: t("摆姿页跑在随包的最小摆姿包上：随包只分发 CC0 素体，其余素体请「导入自备素体」。"),
        });
        pkgNote.hidden = true;
        const lib = $el("aside", { className: "ns-pose-side" }, [
            head("姿势库"),
            presetList,
            row([presetName, btnSavePreset]),
            row([btnLoadPreset, btnDelPreset, btnBrowseLib]),
            head("场景"),
            sceneList,
            row([sceneName, btnSaveScene]),
            row([btnBrowseScenes, btnLoadScene]),
            head("摆姿包"),
            pkgNote,
        ]);

        /* 右栏：控制面板。下拉内容一次由 meta/list 给齐，面板不逐样问页面 */
        const notice = $el("div", {
            className: "ns-pose-notice",
            textContent: t("摆姿包不含宿主命令层：运行 tools\\sync_pose_dist.ps1 同步最新构建产物。"),
        });
        notice.hidden = true;
        const stateBox = $el("div", { className: "ns-pose-state" });
        const formatBox = $el("div", { className: "ns-pose-formats" });
        const propList = list();
        const modelSel = sel("素体", panelGate);
        const presetSel = sel("预设", panelGate);
        const lookSel = sel("外观", panelGate);
        const propSel = sel("道具", panelGate);
        const boneSel = sel("挂点骨", panelGate);
        const viewSel = sel("视角", panelGate);
        const sizeSel = sel("尺寸", panelGate);
        const exportLabel = field("标签（默认 pose）");

        const btnAddMember = btn("加素体", "plus", panelGate);
        const btnDelMember = btn("删当前素体", "cross", panelGate);
        const btnResetPose = btn("重置姿态", "history", panelGate);
        // 自备素体：随包只发 CC0 那一份 GLB（授权口径），Mixamo 与 SMPL 那几份要用户自备。
        // key 默认取文件名 —— 页面按 <key>.glb 取文件，key 与文件名对上才有得选。
        const bodyKey = field("素体 key（默认取文件名）");
        const btnImportBody = btn("导入自备素体", "folder", libGate);
        const bodyFile = $el("input", { className: "ns-pose-file", type: "file", accept: ".glb" });
        btnImportBody.title = t("自备素体只支持 .glb");
        const propName = field("道具名（例：椅子）");
        const btnAddProp = btn("添加道具", "plus", panelGate);
        const btnAttachProp = btn("挂到骨点", "plug", panelGate);
        const btnGroundProp = btn("落地", "target", panelGate);
        const btnDelProp = btn("删道具", "trash", panelGate);
        const btnExportSet = btn("导出图组到素材库", "send", panelGate, " ns-pose-btn-primary");
        const btnShot = btn("画布截图", "image", panelGate);

        const panel = $el("aside", { className: "ns-pose-side ns-pose-panel" }, [
            head("控制面板"),
            notice,
            group("画布状态", [stateBox]),
            group("素体", [row([modelSel, btnAddMember]), row([btnDelMember, btnResetPose]),
                row([bodyKey, btnImportBody]), bodyFile]),
            group("摆姿", [row([presetSel]), row([lookSel])]),
            group("道具", [
                row([propSel, propName]),
                row([btnAddProp]),
                propList,
                row([boneSel, btnAttachProp]),
                row([btnGroundProp, btnDelProp]),
            ]),
            group("ControlNet 导出", [row([viewSel, sizeSel]), formatBox, row([exportLabel]),
                row([btnExportSet, btnShot])]),
        ]);

        const stage = $el("div", { className: "ns-pose-stage" });
        el.append($el("div", { className: "ns-pose-body" }, [lib, stage, panel]));

        const setLib = (on) => libGate.forEach((n) => { n.disabled = !on; });
        const setPanel = (on) => panelGate.forEach((n) => { n.disabled = !on; });
        // 缺包与后端未就绪时整幅侧栏收起：那时每个控件都只会失败
        const setChrome = (on) => { lib.hidden = !on; panel.hidden = !on; };
        setLib(false);
        setPanel(false);

        const post = (type, payload, replyPort) => {
            const msg = { type, ...payload };
            if (replyPort) frame.contentWindow.postMessage(msg, window.location.origin, [replyPort]);
            else frame.contentWindow.postMessage(msg, window.location.origin);
        };

        // 向页面要一份回复（动作结果 / 导出图 / 场景 JSON）：页面不回就超时，面板不被一次点击锁死
        const request = (type, payload = {}) => new Promise((resolve, reject) => {
            const ch = new MessageChannel();
            const timer = setTimeout(() => reject(new Error(t("摆姿页未响应"))), CALL_TIMEOUT_MS);
            ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
            ch.port1.onmessageerror = () => { clearTimeout(timer); reject(new Error(t("摆姿页回复不可读"))); };
            post(type, payload, ch.port2);
        });

        /** 一个面板动作 → 页面：{ok:false, error} 在这变成异常，调用处只写成功路径 */
        const action = async (name, args = {}) => {
            const reply = await request("pose:call", { action: name, args });
            if (!reply?.ok) throw new Error(reply?.error || t("摆姿页拒绝了动作"));
            return reply.data || {};
        };

        const json = async (path, payload) => {
            const resp = await api.fetchApi(path, payload ? {
                method: "POST",
                body: JSON.stringify(payload),
                headers: { "Content-Type": "application/json" },
            } : undefined);
            const data = await resp.json().catch(() => null);
            if (!resp.ok || !data?.success) throw new Error(data?.error || t("操作失败"));
            return data;
        };

        // 一次动作期间锁控件：桥是异步的，连点会在页面里排成一队；跑完按能力位恢复
        const run = async (fn) => {
            setLib(false);
            setPanel(false);
            try { await fn(); } catch (e) { toast(tf("失败：{msg}", { msg: e.message })); }
            setLib(true);
            setPanel(caps.hostUi === true);
        };

        const fill = (select, rows, placeholder) => select.replaceChildren(
            $el("option", { value: "", textContent: t(placeholder) }),
            // 道具那一项页面给的是 { propKey, label }：value 落空时浏览器会拿 label 文本当 value，
            // 面板发出去的就是「椅子」这种显示名，页面的道具定义表查不到
            ...rows.map((r) => $el("option", {
                value: r.key ?? r.propKey ?? "",
                textContent: r.label || r.key || r.propKey,
            })),
        );

        /* ===== 姿势库 / 场景弹窗：pose-lib 的库浏览器与本机文件两条路共用素材库那扇弹窗外壳 =====
           库是数据根里另一批读得到的文件（<数据根>/pose/lib），Neo Studio 这边只读它：
           「存为姿态」写的还是 pose/presets/，库里一份条目读回来就是一次 pose/apply。 */
        const libModal = createLibraryModal({ storageKey: "neo_studio_pose_libmodal", scope: "pose" });
        let libIndex = null;      // index.json 读到的那份；null = 库还没同步或读不成，弹窗出同步指引
        let libShown = LIB_PAGE;
        const libSearch = $el("input", {
            className: "ns-pose-lib-search", type: "search", spellcheck: "false",
            placeholder: t("搜索姿势（名字 / 分类 / 标签）"),
        });
        const libGroupSel = $el("select", { className: "ns-pose-sel ns-pose-lib-group", title: t("分组") });
        const libMeta = $el("p", { className: "ns-pose-lib-meta" });
        const libBlank = $el("p", { className: "ns-pose-lib-blank" });
        const libGrid = $el("div", { className: "ns-pose-lib-grid" });
        const libMore = $el("button", { className: "ns-pose-btn ns-pose-lib-more", type: "button" });
        libGate.push(libMore, libSearch, libGroupSel);   // 弹窗里的这一片与左栏同一把门禁：ready 之前不可点
        const modalSceneList = list(" ns-pose-lib-list");
        const btnLibLocal = btn("本机姿势文件…", "folder", panelGate);
        const btnSceneLocal = btn("本机场景文件…", "folder", libGate);
        // 两个隐藏的文件选择器：库里没有想要的姿势 / 场景时从本机挑一份，走的还是同一条套用与装载路
        const libFile = $el("input", { className: "ns-pose-file", type: "file", accept: ".pose.json,.json" });
        const sceneFile = $el("input", { className: "ns-pose-file", type: "file", accept: ".json" });
        const libPane = $el("div", { className: "ns-pose-libpane" }, [
            row([libSearch, libGroupSel, btnLibLocal]), libMeta, libBlank, libGrid, libMore,
        ]);
        const scenePane = $el("div", { className: "ns-pose-libpane" }, [row([btnSceneLocal]), modalSceneList]);
        libModal.setContent(libPane);
        el.append(libModal.el, libFile, sceneFile);

        /** 库文件的一条 JSON：库自己的 PoseFile 不带 success 字段，json() 会把缺 success 的当失败 */
        const libJson = async (path) => {
            const resp = await api.fetchApi(path);
            const data = await resp.json().catch(() => null);
            if (!resp.ok || !data) throw new Error(tf("读不到库文件：{path}", { path }));
            return data;
        };

        /** 本机的一份 JSON 文件（姿态 / 场景）：与自备素体同一条 FileReader 路，不是 JSON 对象就在这出声 */
        const readJsonFile = (file) => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                let parsed = null;
                try { parsed = JSON.parse(String(reader.result)); } catch { /* 空文件与坏 JSON 一起当无效 */ }
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    reject(new Error(t("本机文件不是一份 JSON 对象")));
                    return;
                }
                resolve(parsed);
            };
            reader.onerror = () => reject(new Error(t("读文件失败")));
            reader.readAsText(file);
        });

        /** meta/list 一次给全：面板每个下拉与勾选组都从这份清单来，不再逐样问页面 */
        function paintMeta(m) {
            fill(modelSel, m.models || [], "选择素体…");
            fill(presetSel, m.presets || [], "选择预设…");
            fill(lookSel, m.looks || [], "外观");
            propChoices = m.props || [];
            fill(propSel, propChoices, "选择道具…");
            fill(boneSel, (m.bones || []).map((b) => ({ key: String(b), label: String(b) })), "挂点骨…");
            fill(viewSel, m.views || [], "视角");
            fill(sizeSel, (m.sizes || []).map((n) => ({ key: String(n), label: `${n}px` })), "尺寸");
            formatBox.replaceChildren(...(m.formats || []).map((f) => $el("label", {
                className: "ns-pose-format", title: f.hint || f.label,
            }, [$el("input", { type: "checkbox", className: "ns-pose-check", value: f.key, checked: "checked" }), f.label])));
        }

        /** 外观定在暗色档：摆姿页的 LOOKS 只有摄影棚灰与暗色两档，旧包没有暗色档就不动 */
        async function applyDefaultLook(m) {
            const hit = (m.looks || []).find((l) => l.key === DEFAULT_LOOK_KEY);
            if (!hit) return;
            lookSel.value = hit.key;
            await action("look/set", { key: hit.key }).catch(() => {});
        }

        const stateRow = (key, value) => $el("div", { className: "ns-pose-state-row" }, [
            $el("span", { className: "ns-pose-state-key", textContent: t(key) }),
            $el("span", { className: "ns-pose-state-val", textContent: value }),
        ]);

        /** 画布状态镜像到状态栏：页面侧自己改了控件（点画布、按快捷键），面板跟着对账 */
        function paintState(s) {
            Object.assign(canvas, s || {});
            stateBox.replaceChildren(
                stateRow("素体", canvas.model || "—"),
                stateRow("素体数", String(canvas.members ?? "—")),
                stateRow("道具数", String(canvas.props ?? 0)),
            );
        }

        const paintFileList = (box, rows, picked, onPick) => {
            if (!rows.length) {
                box.replaceChildren($el("div", { className: "ns-pose-blank", textContent: t("还没有存档") }));
                return;
            }
            box.replaceChildren(...rows.map((r) => $el("div", {
                className: "ns-pose-item" + (r.name === picked ? " ns-pose-item-on" : ""),
                textContent: r.name, title: r.name, onclick: () => onPick(r.name),
            })));
        };

        function paintProps(data) {
            const items = data.items || [];
            if (!items.some((it) => it.id === pickedProp)) pickedProp = items[0]?.id || "";
            const rows = items.map((it) => $el("div", {
                className: "ns-pose-item" + (it.id === pickedProp ? " ns-pose-item-on" : ""),
                textContent: `${it.label || it.id} · ${it.attach?.bone || t("未挂载")}`,
                title: it.id, onclick: () => { pickedProp = it.id; refreshProps(); },
            }));
            propList.replaceChildren(...(rows.length ? rows
                : [$el("div", { className: "ns-pose-blank", textContent: t("场上没有道具") })]));
            fill(boneSel, (data.bones || []).map((b) => ({ key: String(b), label: String(b) })), "挂点骨…");
        }

        const libCard = (entry) => {
            const label = entry.label || entry.id;
            const thumb = previewOf(entry);
            const img = thumb
                ? $el("img", { className: "ns-pose-lib-thumb", src: `${LIB_PREFIX}/${thumb}`, alt: label, loading: "lazy" })
                : $el("div", { className: "ns-pose-lib-noimg", textContent: t("无预览") });
            const card = $el("button", {
                className: "ns-pose-lib-card", type: "button", title: label,
                dataset: { libId: String(entry.id) },
            }, [img, $el("p", { className: "ns-pose-lib-label", textContent: label }),
                $el("p", { className: "ns-pose-lib-tags", textContent: libTagsOf(entry) })]);
            card.onclick = () => run(async () => {
                const file = await libJson(`${LIB_PREFIX}/${entry.path}`);
                const r = await action("pose/apply", { file });
                libModal.close();
                toast(tf("已套用库内姿态：{name}（骨骼 {applied} 处，缺 {missing} 处）",
                    { name: label, applied: r.applied ?? 0, missing: (r.missing || []).length }));
            });
            return card;
        };

        function renderLibIndex() {
            const rows = libFilter(libIndex?.entries, { q: libSearch.value, group: libGroupSel.value });
            const sections = libGroups(rows.slice(0, libShown), libIndex?.groups);
            libGrid.replaceChildren(...sections.flatMap((sec) => [
                $el("h4", { className: "ns-pose-lib-group-title", textContent: `${sec.label}（${sec.items.length}）` }),
                ...sec.items.map(libCard),
            ]));
            libGrid.hidden = !rows.length;
            libBlank.hidden = rows.length > 0;
            // 库没同步出同步指引，同步了才说「没有匹配」：一个空浏览器不是库的样子
            libBlank.textContent = libIndex ? t("没有匹配的姿势") : t(LIB_SYNC_HINT);
            libMore.hidden = rows.length <= libShown;
            libMore.textContent = tf("加载更多（还有 {n} 条）", { n: rows.length - libShown });
            libMeta.textContent = libIndex
                ? tf("{total} 个姿势 · 显示 {shown}", { total: libIndex.count ?? rows.length, shown: rows.length })
                : "";
        }

        /** 弹窗开在哪一档：场景那一档列数据根的存档，姿势那一档列 pose-lib 的库 */
        async function openLibModal(kind) {
            libModal.setContent(kind === "scene" ? scenePane : libPane);
            libModal.open(kind === "scene" ? t("载入场景") : t("姿势库"));
            if (kind === "scene") return;
            if (libIndex === null) {
                try {
                    libIndex = await libJson(LIB_INDEX);
                    fill(libGroupSel, (libIndex.groups || []).map((g) => ({
                        key: g.key, label: `${g.label || g.key}（${g.count ?? 0}）`,
                    })), "全部分组");
                } catch {
                    // 读不出索引 = 库没同步：这句就是弹窗里那句同步指引要说的同一件事
                    toast(tf("读不到库文件：{path}", { path: LIB_INDEX }));
                }
            }
            libShown = LIB_PAGE;
            renderLibIndex();
        }

        libSearch.oninput = () => renderLibIndex();
        libGroupSel.onchange = () => renderLibIndex();
        libMore.onclick = () => { libShown += LIB_PAGE; renderLibIndex(); };
        btnBrowseLib.onclick = () => openLibModal("pose");
        btnBrowseScenes.onclick = () => openLibModal("scene");
        btnLibLocal.onclick = () => { libFile.value = ""; libFile.click(); };
        btnSceneLocal.onclick = () => { sceneFile.value = ""; sceneFile.click(); };

        libFile.onchange = () => {
            const pickedFile = libFile.files && libFile.files[0];
            libFile.value = "";
            if (!pickedFile) return;
            run(async () => {
                const file = await readJsonFile(pickedFile);
                const r = await action("pose/apply", { file });
                libModal.close();
                toast(tf("已套用本机姿态：{name}（骨骼 {applied} 处，缺 {missing} 处）",
                    { name: pickedFile.name, applied: r.applied ?? 0, missing: (r.missing || []).length }));
            });
        };

        sceneFile.onchange = () => {
            const pickedFile = sceneFile.files && sceneFile.files[0];
            sceneFile.value = "";
            if (!pickedFile) return;
            run(async () => {
                post("pose:open-scene", { scene: await readJsonFile(pickedFile) });
                libModal.close();
                toast(tf("已载入本机场景：{name}", { name: pickedFile.name }));
            });
        };

        const refreshPresets = () => json("/neo_pose/presets").then((d) => {
            /* 点一条 = 选它并把它套上：姿势库的卡片本来就是「用这份姿势」，不该再要一步 */
            paintFileList(presetList, d.presets || [], pickedPreset, (n) => run(() => loadPoseFile(n)));
        }).catch(() => paintFileList(presetList, [], "", () => {}));

        const refreshScenes = () => json("/neo_pose/scenes").then((d) => {
            paintFileList(sceneList, d.scenes || [], pickedScene, (n) => { pickedScene = n; refreshScenes(); });
            /* 弹窗里点一条 = 读那份场景装进页面再收起弹窗：同一批文件在两处列（左栏与弹窗），装载只有一条路 */
            paintFileList(modalSceneList, d.scenes || [], pickedScene, (n) => run(async () => {
                pickedScene = n;
                await refreshScenes();
                const data = await json(`/neo_pose/scene?name=${encodeURIComponent(n)}`);
                post("pose:open-scene", { scene: data.scene });
                libModal.close();
                toast(tf("已载入场景：{name}", { name: n }));
            }));
        }).catch(() => {
            paintFileList(sceneList, [], "", () => {});
            paintFileList(modalSceneList, [], "", () => {});
        });

        const refreshProps = () => action("prop/list").then(paintProps)
            .catch((e) => toast(tf("道具列表失败：{msg}", { msg: e.message })));

        /* 自备素体：GLB 从本机读进内存再交后端 —— 素材库列表只列图片，用户从 Mixamo 下来的那份
           走的是文件选择器，落点由后端定（<数据根>/pose/dist/models/<key>.glb）。
           登记动作不在宿主这边：页面自己的本地导入区按 key 认它，宿主只把 key 报给用户。 */
        btnImportBody.onclick = () => { bodyFile.value = ""; bodyFile.click(); };
        bodyFile.onchange = () => {
            const file = bodyFile.files && bodyFile.files[0];
            bodyFile.value = "";
            if (!file) return;
            if (!/\.glb$/i.test(file.name)) { toast(t("自备素体只支持 .glb")); return; }
            if (file.size > MAX_GLB_BYTES) {
                toast(tf("GLB 超过 {n}MB 上限", { n: Math.round(MAX_GLB_BYTES / 1048576) }));
                return;
            }
            const key = bodyKey.value.trim() || file.name.replace(/\.glb$/i, "");
            if (!BODY_KEY_RE.test(key)) {
                toast(t("素体 key 只允许字母数字与 _ . -（64 字符内）"));
                bodyKey.focus();
                return;
            }
            const reader = new FileReader();
            reader.onload = () => run(async () => {
                const data = String(reader.result).split(",")[1] || "";
                const saved = await json("/neo_pose/import_model", { key, data });
                bodyKey.value = "";
                toast(tf("自备素体已写进摆姿包：{key}（在摆姿页的本地导入区登记这个 key 后可选）",
                    { key: saved.key }));
            });
            reader.onerror = () => toast(t("读文件失败"));
            reader.readAsDataURL(file);
        };

        /* 姿势库：pose/export 交回 PoseFile v1，后端只写文件；载入是读文件再交回 pose/apply */
        btnSavePreset.onclick = () => run(async () => {
            const typed = presetName.value.trim();
            if (!typed) { toast(t("请先写姿态名")); presetName.focus(); return; }
            const { file } = await action("pose/export");
            await json("/neo_pose/preset", { name: typed, pose: file });
            presetName.value = "";
            pickedPreset = typed;
            await refreshPresets();
            toast(tf("已存入姿势库：{name}", { name: typed }));
        });

        /* 预设下拉一改就套：面板不再要「套用预设」第二步 —— 下拉里那一项就是用户要的结果 */
        presetSel.onchange = () => run(async () => {
            if (!presetSel.value) return;
            paintState(await action("preset/apply", { key: presetSel.value }));
        });

        /* 姿势库的一条 = 读文件并套上：点一下就是结果，不再要「载入姿态」第二步 */
        async function loadPoseFile(name) {
            pickedPreset = name;
            await refreshPresets();
            const data = await json(`/neo_pose/preset?name=${encodeURIComponent(name)}`);
            const r = await action("pose/apply", { file: data.pose });
            toast(tf("已套用姿态：{name}（骨骼 {applied} 处，缺 {missing} 处）",
                { name, applied: r.applied ?? 0, missing: (r.missing || []).length }));
        }

        btnLoadPreset.onclick = () => run(async () => {
            const name = presetName.value.trim() || pickedPreset;
            if (!name) { toast(t("先在姿势库里选一个姿态")); return; }
            await loadPoseFile(name);
        });

        btnDelPreset.onclick = () => run(async () => {
            if (!pickedPreset) { toast(t("先在姿势库里选一个姿态")); return; }
            await json("/neo_pose/preset/delete", { name: pickedPreset });
            toast(tf("已删除姿态：{name}", { name: pickedPreset }));
            pickedPreset = "";
            await refreshPresets();
        });

        btnSaveScene.onclick = () => run(async () => {
            const typed = sceneName.value.trim();
            if (!typed) { toast(t("请先写场景名")); sceneName.focus(); return; }
            const reply = await request("pose:save-scene");
            await json("/neo_pose/scene", { name: typed, scene: reply?.scene ?? reply });
            sceneName.value = "";
            pickedScene = typed;
            await refreshScenes();
            toast(tf("场景已保存：{name}", { name: typed }));
        });

        btnLoadScene.onclick = () => run(async () => {
            const name = sceneName.value.trim() || pickedScene;
            if (!name) { toast(t("先在场景里选一个")); return; }
            const data = await json(`/neo_pose/scene?name=${encodeURIComponent(name)}`);
            post("pose:open-scene", { scene: data.scene });
            toast(tf("已载入场景：{name}", { name }));
        });

        /* 面板动作 → 画布：动作结果带回状态就镜像，道具变动则重问一次 prop/list */
        btnAddMember.onclick = () => run(() =>
            action("member/add", modelSel.value ? { key: modelSel.value } : {}).then(paintState));
        btnDelMember.onclick = () => run(() => action("member/remove").then(paintState));
        btnResetPose.onclick = () => run(() => action("scene/reset").then(paintState));
        lookSel.onchange = () => run(() => action("look/set", { key: lookSel.value }));

        btnAddProp.onclick = () => run(async () => {
            const typed = propName.value.trim();
            const key = typed ? resolvePropChoice(typed, propChoices) : propSel.value;
            propName.value = "";   // 一次性输入：写完就清，与自备素体 key 同一口径
            if (typed && !key) {
                toast(tf("道具表里没有「{name}」：可输入 椅子 / 桌子 / 剑 这类名字（共 {n} 项），或从下拉选",
                    { name: typed, n: propChoices.length }));
                return;
            }
            if (!key) { toast(t("先选一个道具")); return; }
            await action("prop/add", { key });
            await refreshProps();
        });
        btnAttachProp.onclick = () => run(async () => {
            if (!pickedProp || !boneSel.value) { toast(t("先选道具与挂点骨")); return; }
            await action("prop/attach", { id: pickedProp, bone: boneSel.value });
            await refreshProps();
        });
        btnGroundProp.onclick = () => run(async () => {
            if (!pickedProp) { toast(t("先选一个道具")); return; }
            await action("prop/ground", { id: pickedProp });
        });
        btnDelProp.onclick = () => run(async () => {
            if (!pickedProp) { toast(t("先选一个道具")); return; }
            await action("prop/remove", { id: pickedProp });
            pickedProp = "";
            await refreshProps();
        });

        /* ControlNet 图组：页面交回 {name, data} 列表，后端落进素材库的 Pose 目录（output/Pose） */
        btnExportSet.onclick = () => run(async () => {
            const formats = [...formatBox.querySelectorAll("input:checked")].map((b) => b.value);
            if (!formats.length) { toast(t("先勾要导出的格式")); return; }
            if (formats.length > MAX_SET_FILES) { toast(tf("一次最多导出 {n} 张", { n: MAX_SET_FILES })); return; }
            const r = await action("export/images", {
                view: viewSel.value,
                size: Number(sizeSel.value) || 512,
                formats,
                label: exportLabel.value.trim() || null,
            });
            const saved = await json("/neo_pose/export_set", { files: r.files });
            toast(tf("已导出 {n} 张到素材库的 Pose 目录", { n: saved.count ?? (saved.saved || []).length }));
        });

        btnShot.onclick = () => run(async () => {
            const { data } = await action("snapshot");
            const saved = await json("/neo_pose/export_image", { data, name: "pose_shot" });
            toast(tf("画布截图已进素材库的 Pose 目录：{name}", { name: saved.filename }));
        });

        window.addEventListener("message", (event) => {
            // 只认本页这张 iframe 的同源消息：宿主上其它来源的 postMessage 一律丢
            if (!frame || event.source !== frame.contentWindow) return;
            if (event.origin !== window.location.origin) return;
            if (event.data?.type === "pose:ready") {
                setLib(true);
                post("pose:theme", { caps, lang: getLang() });
                if (caps.hostUi !== true) {
                    // 旧摆姿包没有宿主命令层：面板说明缺什么，不摆点了只会空转的控件
                    notice.hidden = false;
                    return;
                }
                notice.hidden = true;
                setPanel(true);
                action("meta/list").then(async (m) => {
                    paintMeta(m);
                    await applyDefaultLook(m);
                }).catch((e) => toast(tf("读取摆姿元数据失败：{msg}", { msg: e.message })));
                refreshProps();
                return;
            }
            if (event.data?.type === "pose:state") paintState(event.data.state);
        });

        async function render() {
            stage.replaceChildren($el("div", { className: "ns-pose-hint", textContent: t("读取摆姿状态…") }));
            setLib(false);
            setPanel(false);
            frame = null;
            let status = null;
            try { status = await json("/neo_pose/status"); } catch { status = null; }
            if (!status) {
                setChrome(false);
                stage.replaceChildren($el("div", { className: "ns-pose-empty" }, [
                    $el("h3", { textContent: t("摆姿状态读不到") }),
                    $el("p", { textContent: t("后端未就绪：刷新页面重试。") }),
                ]));
                return;
            }
            caps = status.caps || {};
            pkgNote.hidden = status.dist_source !== "package";
            if (!status.installed) {
                // 缺包要说清楚缺什么、怎么装：iframe 直接指向不存在的入口页只剩白屏
                setChrome(false);
                const retry = $el("button", { className: "ns-pose-btn", type: "button", onclick: render });
                setIconLabel(retry, "history", t("重新检查"));
                stage.replaceChildren($el("div", { className: "ns-pose-empty" }, [
                    $el("h3", { textContent: t("3D 摆姿未安装") }),
                    $el("p", { textContent: status.hint || t("未找到摆姿包。") }),
                    retry,
                ]));
                return;
            }
            setChrome(true);
            frame = $el("iframe", {
                className: "ns-pose-frame",
                title: t("3D 摆姿"),
                src: POSE_PAGE_URL,
                // allow-downloads 给页面自存 GLB；不给 allow-popups / allow-forms / allow-top-navigation，
                // 摆姿页只需要脚本、同源存储与被拦截的下载
                sandbox: "allow-scripts allow-same-origin allow-downloads",
            });
            stage.replaceChildren(frame);
            refreshPresets();
            refreshScenes();
        }
        await render();
    };
}

/** 卡片缩略图优先级：clay 是写实渲染那张，一眼看得出姿势；缺 clay 的条目落到 skeleton / silhouette / depth。
    口径与摆姿页 src/ui/libraryPanel.js 的 thumbOf 同一条（库的 inbox 源图不在同步范围内，不作候选）。 */
export function previewOf(entry) {
    const p = entry?.preview || {};
    for (const key of LIB_VARIANTS) { if (p[key]) return String(p[key]); }
    return "";
}

/** 搜索口径与摆姿仓库 poseLibrary.js 的 filterIndex 同一份字段表：label / 分类 / 标签 / id / source */
export function libFilter(entries, { q = "", group = "" } = {}) {
    const text = String(q || "").trim().toLowerCase();
    return (entries || []).filter((e) => {
        if (group && !(e.groups || []).includes(group)) return false;
        if (!text) return true;
        const hay = [e.label, ...(e.categories || []), ...(e.tags || []), e.id, e.source]
            .join(" ").toLowerCase();
        return hay.includes(text);
    });
}

/** 按归并组分层：一条姿态可能挂多个组，只落在排最前的那个组里 —— 弹窗里出现两张同 id 的卡，点击会串 */
export function libGroups(entries, groups) {
    const rank = new Map((groups || []).map((g, i) => [String(g.key), i]));
    const labelOf = new Map((groups || []).map((g) => [String(g.key), g.label || g.key]));
    const seen = new Set();
    const buckets = new Map();
    for (const e of entries || []) {
        const id = String(e?.id ?? "");
        if (seen.has(id)) continue;
        seen.add(id);
        const keys = (e.groups || []).map((k) => String(k));
        const key = keys.length
            ? keys.sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99))[0]
            : "other";
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(e);
    }
    return [...buckets.entries()]
        .sort((a, b) => (rank.get(a[0]) ?? 99) - (rank.get(b[0]) ?? 99))
        .map(([key, items]) => ({ key, label: labelOf.get(key) || key, items }));
}

/** 卡片副标题：分类头两条 + 来源；库里 preset / manual 这两种来源满库都是，标出来没意义，
    只有 photo3d / mixamo 这类真实来源值得用户看见（口径与摆姿页卡片副标题同一份字段表） */
export function libTagsOf(entry) {
    const cats = [...new Set(entry?.categories || [])].slice(0, 2).join(" / ");
    const source = entry?.source;
    return source && source !== "manual" && source !== "preset" ? `${cats} · ${source}` : cats;
}
