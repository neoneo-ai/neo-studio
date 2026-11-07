/**
 * pose.js — 桌面端「3D 姿势」页宿主（Studio 视图）。
 *
 * 姿势包 = 3d-pose-art 的 vite 产物，后端伺服在 /pose-dist/，短路径 /neo-pose 跳到入口页
 * （产物是 base:'./' 的相对 import，页面必须有目录深度，理由见 studio/pose.py）。控件在宿主这一侧，
 * 但不占画布的位置：iframe 画布吃满整页，控件挂在画布上的两条透明工具条（左上 姿势库 / 角色与外观 / 道具，
 * 右上 保存姿势 / 导出图组 / 画布状态），点一条开一扇浮在画布上的弹层或整扇弹窗，Esc、点弹层外、再点同一条钮都是关；
 * 预设姿势与整张道具表都在「姿势库 / 道具」那两扇弹窗里。宿主复刻不了那份 three.js 运行时，
 * 面板的每个动作都经 pose:call 落进页面（动作清单在姿势页 src/ui/hostCommands.js），画布状态经
 * pose:state 回流。页面在 caps.hostUi 下收起自己的 demo 控件 —— 同一时刻只有一套控件在场上。
 *
 * 桥的消息名与方向 —— 名单由 /neo_pose/status 下发，宿主、姿势页、后端测试三处同名：
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
import { setIconLabel, icon } from "../js/core/icons.js";
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

// 姿势库（pose-lib）：库数据由 tools\sync_pose_lib.ps1 同步进 <数据根>/pose/lib，静态伺服挂在 /pose-lib/
// 上一级（studio/pose.py 的 LIB_PREFIX）。库里一份条目是一整场（多人 + 道具 + 视角），套进画布走
// pose:call 的 scene/apply —— 库只是多出来的另一批文件，不造第二条套用通路。
const LIB_PREFIX = "/pose-lib";
const LIB_INDEX = `${LIB_PREFIX}/index.json`;
const LIB_PAGE = 200;      // 一次渲染的卡片上限：库里 600+ 条全塞进 DOM，首屏与滚动都撑不住
const LIB_LIST_PAGE = 120; // 本机存档那行的分页上限：列表比卡片窄，一屏塞的行数更少
const LIB_VARIANTS = ["clay", "skeleton", "silhouette", "depth"];   // 缩略图优先级，与姿势页 thumbOf 同一条
const LIB_ORIGIN_CLASS = { lib: "ship", lab: "lab", cloud: "cloud" };
const LIB_ORIGIN_LABEL = { lib: "预设", lab: "本地", cloud: "云端" };   // 合并库每条的出处：预设随仓库分发只读，本地是本机自己写的，云端在 OSS
const LIB_ORIGIN_TITLE = {
    lib: ` · ${t("预设库：随姿势仓库分发，只读")}`,
    lab: ` · ${t("本地库：本机自己写的姿态")}`,
    cloud: ` · ${t("云端库：OSS 上那棵树，取回的文件缓存在本机")}`,
};
const LIB_ORIGIN_ORDER = [{ key: "lib", label: "预设（只读）" }, { key: "lab", label: "本地（可写）" }];
const LIB_SYNC_HINT = "姿势库未同步：跑 tools\\sync_pose_lib.ps1 -Source <3d-pose-art 仓库根> 把 pose-lib 同步进" +
    " <数据根>/pose/lib，或在「启动设置 → 姿势仓库」填上仓库目录，桌面端每次启动自动同步。";

// 云端姿势库与云端道具（studio/pose_cloud.py）：清单吃 /neo_pose/cloud_index，场景 JSON 与道具 GLB
// 一律经 /neo_pose/cloud_file 落到本机缓存（<数据根>/pose/oss_cache），套用与加具走的还是
// pose:call 那两条通路，姿势页不认第二个来源。预览图是唯一直连 OSS 的一张 <img>。
const CLOUD_INDEX = "/neo_pose/cloud_index";
const CLOUD_FILE = "/neo_pose/cloud_file";
// 道具预览图的地址就两条：本机那批走页面写死的 /models/props/ 那一级（pose.py 伺服），
// 云端那批直连 OSS（与姿势库封面同一口径 —— 封面只是一张 <img>，不碰姿势页契约）
const MODELS_PREFIX = "/models";
const CLOUD_PROPS_KEY = "props";
const CLOUD_SYNC_HINT = "云端姿势库未配置：在 <数据根>/configs/oss_presets.json 里写 pose_index_url，" +
    "云端那棵树用 tools\\pose_deploy_oss.py 上传（默认只列清单，加 --apply 才上传）。";


/** 面板只发标准男 / 标准女两具基座（姿势仓库 src/pose/character.js 的 CHARACTERS 表首两条）：
    Mixamo、SMPL 派生与用户自备的 GLB 一律不进面板 —— 那几份的授权条款不在我们手里，两具 CC0 基座在。
    STANDARD_CHAR_LABELS 只是兜底名：页面 meta/list 报了这一档就用页面那份，面板不复刻定义。 */
const STANDARD_CHAR_KEYS = ["bodyMale", "bodyFemale"];
const STANDARD_CHAR_LABELS = ["标准男性", "标准女性"];
/** 页面开局挂的就是标准男基座：素体下拉与姿势库的基座筛选都以它起头 ——
    下拉停在「选择素体…」时「加素体」会跟着页面当前素体走，用户看不见自己将拿到哪具身。 */
const DEFAULT_CHAR_KEY = STANDARD_CHAR_KEYS[0];

/** 页面开局是摄影棚灰（姿势页 core/scene.js 的 LOOKS.studio），面板按产品口径把外观定在暗色档 */
const DEFAULT_LOOK_KEY = "dark";

/** ControlNet 导出默认落在「当前视角」：面板不动用户调好的机位就能出图
    （页面 EXPORT_VIEWS.current 是 null，导出口径就是沿用现场相机） */
const DEFAULT_VIEW_KEY = "current";

/** 道具卡片一页 120 件：整张道具表在弹窗里翻页，页码是布局偏好，重开停在同一页 */
const PROP_PAGE_KEY = "neo_studio_pose_prop_page";
const PROP_PAGE_SIZE = 120;

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
 * 宿主做：内置道具表在姿势包里，宿主不许复刻它的定义，只做「名字 → 清单里那一项」的查找。
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

/**
 * meta/list 的素体清单 → 面板发得出的那几档（标准男 / 标准女）。
 *
 * 页面注册的基座比面板发的多（Mixamo、SMPL 派生、用户自备的 GLB）：面板只按白名单出选项，
 * 一条点了只会失败的控件不发货。label 用页面那份，面板不复刻定义；页面没报这一档就不出这一条。
 * @param {Array<{key?: string, label?: string}>} models meta/list 的 models
 * @returns {Array<{key: string, label: string}>} 白名单内的素体，顺序就是白名单顺序
 */
export function standardCharOptions(models) {
    return STANDARD_CHAR_KEYS.reduce((acc, key, i) => {
        const hit = (models || []).find((m) => String(m.key) === key);
        if (hit) acc.push({ key, label: hit.label || t(STANDARD_CHAR_LABELS[i]) });
        return acc;
    }, []);
}

/** 建「3D 姿势」视图。依赖由宿主注入：api 走 shim（离线与在线同一条路） */
export function createPoseView({ api, $el, toast }) {
    return async function buildPose(el) {
        ensureCss();
        el.classList.add("ns-pose");
        let frame = null;
        let caps = {};
        let pickedScene = "";
        let pickedProp = "";   // 场上道具的选中项（落地 / 删道具吃的就是这一条）
        let propChoices = [];   // meta/list 的道具项：自由填写的名字只在这份清单里解析，不猜定义
        let sceneNames = [];      // pose/scenes/ 的本机存档：姿势库弹窗下半那一列
        let libListShown = LIB_LIST_PAGE;   // 本机存档这一列这一屏渲染到第几条
        const canvas = {};

        // 两层门控：读写本机文件只认 pose:ready；姿势动作还要 caps.hostUi —— 旧姿势包没有
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
        // 透明工具条与弹层：画布吃满整页，控件浮在画布上。弹层钮是布局入口，不进 libGate/panelGate
        // —— 页面没 ready 时也要看得见本机存档清单与画布状态；缺包时两条工具条连弹层一起不出
        const dockBar = (side) => $el("div", { className: `ns-pose-dock ns-pose-dock-${side}` });
        const dockL = dockBar("left");
        const dockR = dockBar("right");
        const popBoxes = [];
        let openKey = "";
        function closePop() {
            openKey = "";
            for (const { box, chip } of popBoxes) {
                box.hidden = true;
                chip.classList.remove("ns-pose-dock-btn-on");
                chip.setAttribute("aria-expanded", "false");
            }
        }
        function openPop(key) {
            if (openKey === key) { closePop(); return; }   // 同一条钮再点一次就是关
            closePop();   // 一次只留一扇弹层：画布上不许叠两层控件
            const hit = popBoxes.find((p) => p.key === key);
            if (!hit) return;
            openKey = key;
            hit.box.hidden = false;
            hit.chip.classList.add("ns-pose-dock-btn-on");
            hit.chip.setAttribute("aria-expanded", "true");
        }
        function popPanel({ key, label, iconKey, side }) {
            const chip = $el("button", { className: "ns-pose-btn ns-pose-dock-btn", type: "button", "aria-expanded": "false" });
            setIconLabel(chip, iconKey, t(label));
            chip.title = t(label);
            const close = $el("button", { className: "ns-pose-btn ns-pose-pop-close", type: "button", title: t("关闭面板（Esc）") }, [icon("cross", 14)]);
            const box = $el("div", { className: `ns-pose-pop ns-pose-pop-${side}`, dataset: { pop: key }, role: "dialog" }, [
                $el("div", { className: "ns-pose-pop-head" }, [
                    $el("span", { className: "ns-pose-pop-title", textContent: t(label) }), close,
                ]),
            ]);
            box.hidden = true;   // 开局全关：这一页要的是画布，弹层是点开才有的
            popBoxes.push({ box, chip, key });
            chip.onclick = () => openPop(key);
            close.onclick = () => closePop();
            (side === "left" ? dockL : dockR).append(chip);
            return box;
        }
        /** 工具条上直接干一件事的钮（姿势库与道具就是开那扇弹窗，没有中间那一层弹层）：
         *  不吃弹层那套开合，亮起态由 paintDockModal 跟着弹窗自己的开合走 */
        const dockAction = (side, { label, iconKey, action }) => {
            const chip = $el("button", { className: "ns-pose-btn ns-pose-dock-btn", type: "button", "aria-expanded": "false" });
            setIconLabel(chip, iconKey, t(label));
            chip.title = t(label);
            chip.onclick = () => action();
            (side === "left" ? dockL : dockR).append(chip);
            return chip;
        };
        /** 弹窗开着时那颗工具条钮亮着：「再点一次就是关」这件事要在钮上看得见，否则第二下看着像重载内容。
         *  收窗的路有 Esc / 遮罩 / 标题栏 ✕ / 套用后收窗四条，都从外壳的 onClose 回调过这一条 */
        const paintDockModal = (chip, modal) => {
            chip.classList.toggle("ns-pose-dock-btn-on", modal.isOpen());
            chip.setAttribute("aria-expanded", String(modal.isOpen()));
        };

        /* 本机姿势存档（pose:save-scene 写进 pose/scenes/ 的那批）排在「姿势库」弹窗里预设清单的下面：
           弹窗吃满一整屏时，上面是库的卡片网格，下面是这一列存档，两边共用一条装载路。
           搜索框按名字过滤，一屏 120 行走「加载更多」。
           搜索框只带 ns-pose-list-search：弹窗搜索框那条 flex: 1 是弹窗顶部那一横行的样式（在 CSS 里排在
           这一条之后），这一列是竖排的，共用同一份就是让输入框自己吃满列高 */
        const libFilterSearch = $el("input", {
            className: "ns-pose-list-search", type: "search", spellcheck: "false",
            placeholder: t("搜索本机姿势（按名字）"),
        });
        const poseList = list(" ns-pose-pose-list");
        const btnListMore = $el("button", { className: "ns-pose-btn ns-pose-list-more", type: "button" });
        btnListMore.hidden = true;
        libGate.push(libFilterSearch, btnListMore);
        const poseName = field("姿势名");
        const btnSavePose = btn("存为姿势", "copy", libGate);

        /* 弹层与弹窗里的控件。下拉内容一次由 meta/list 给齐，面板不逐样问页面 */
        const notice = $el("div", {
            className: "ns-pose-notice",
            textContent: t("姿势包不含宿主命令层：运行 tools\\sync_pose_dist.ps1 同步最新构建产物。"),
        });
        notice.hidden = true;
        const stateBox = $el("div", { className: "ns-pose-state" });
        const formatBox = $el("div", { className: "ns-pose-formats" });
        const propList = list();
        const modelSel = sel("素体", panelGate);
        const lookSel = sel("外观", panelGate);
        const viewSel = sel("视角", panelGate);
        const sizeSel = sel("尺寸", panelGate);
        const exportLabel = field("标签（默认 pose）");

        const btnAddMember = btn("加素体", "plus", panelGate);
        const btnDelMember = btn("删当前素体", "cross", panelGate);
        const btnResetPose = btn("重置姿态", "history", panelGate);
        const propName = field("道具名（例：椅子 · 回车添加）");
        // 道具是一件件带预览图的卡片，不是一个下拉：下拉里只有名字，用户得猜哪件是长棍、哪件是手枪
        const propSearch = $el("input", {
            className: "ns-pose-prop-search", type: "search", spellcheck: "false",
            placeholder: t("搜索道具（名字 / 云端）"),
        });
        const propGrid = $el("div", { className: "ns-pose-prop-grid" });
        const propMeta = $el("p", { className: "ns-pose-prop-meta" });
        const propPager = $el("div", { className: "ns-pose-prop-pager" });
        panelGate.push(propSearch);
        const btnGroundProp = btn("落地", "target", panelGate);
        const btnDelProp = btn("删道具", "trash", panelGate);
        const btnExportSet = btn("导出图组到素材库", "send", panelGate, " ns-pose-btn-primary");
        const btnShot = btn("画布截图", "image", panelGate);

        // 工具条：左边是「看东西」的入口（姿势库与道具直接开整屏弹窗），右边是「出东西」的入口（保存 / 导出 / 状态）
        const btnLib = dockAction("left", { label: "姿势库", iconKey: "list", action: openLibModal });
        const popChar = popPanel({ key: "char", label: "角色与外观", iconKey: "user", side: "left" });
        const btnProp = dockAction("left", { label: "道具", iconKey: "target", action: openPropModal });
        const popSave = popPanel({ key: "save", label: "保存姿势", iconKey: "save", side: "right" });
        const popExport = popPanel({ key: "export", label: "导出图组", iconKey: "send", side: "right" });
        const popState = popPanel({ key: "state", label: "画布状态", iconKey: "info", side: "right" });
        popChar.append(
            group("素体", [row([modelSel, btnAddMember]), row([btnDelMember, btnResetPose])]),
            group("外观", [row([lookSel])]),
        );
        popSave.append(group("保存姿势", [row([poseName, btnSavePose])]));
        popExport.append(group("ControlNet 导出", [row([viewSel, sizeSel]), formatBox,
            row([exportLabel]), row([btnExportSet, btnShot])]));
        popState.append(notice, stateBox);

        const stage = $el("div", { className: "ns-pose-stage" });
        el.append(stage, dockL, dockR, popChar, popSave, popExport, popState);

        const setLib = (on) => libGate.forEach((n) => { n.disabled = !on; });
        const setPanel = (on) => panelGate.forEach((n) => { n.disabled = !on; });
        // 缺包与后端未就绪时两条工具条整条收起、弹层全关：那时每个控件都只会失败
        const setChrome = (on) => { dockL.hidden = !on; dockR.hidden = !on; if (!on) closePop(); };
        setLib(false);
        setPanel(false);

        /* 弹层的关法三条，都不给画布添控件：Esc、点在弹层与工具条之外、再点同一条弹层钮。
           Esc 走 document 的 capture，弹窗与灯箱开着时这一发归它们，弹层不抢着关。
           iframe 里的点击不冒到宿主文档：在画布里拖动素体不会把弹层关掉，这一条要说明白 */
        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape" || !openKey) return;
            if (document.querySelector(".ns-libmodal:not(.ns-hidden), .neo-lightbox")) return;
            closePop();
        }, true);
        document.addEventListener("click", (e) => {
            if (!openKey) return;
            if (e.target instanceof Element && e.target.closest(".ns-pose-pop, .ns-pose-dock")) return;
            closePop();
        });

        const post = (type, payload, replyPort) => {
            const msg = { type, ...payload };
            if (replyPort) frame.contentWindow.postMessage(msg, window.location.origin, [replyPort]);
            else frame.contentWindow.postMessage(msg, window.location.origin);
        };

        // 向页面要一份回复（动作结果 / 导出图 / 场景 JSON）：页面不回就超时，面板不被一次点击锁死
        const request = (type, payload = {}) => new Promise((resolve, reject) => {
            const ch = new MessageChannel();
            const timer = setTimeout(() => reject(new Error(t("姿势页未响应"))), CALL_TIMEOUT_MS);
            ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
            ch.port1.onmessageerror = () => { clearTimeout(timer); reject(new Error(t("姿势页回复不可读"))); };
            post(type, payload, ch.port2);
        });

        /** 一个面板动作 → 页面：{ok:false, error} 在这变成异常，调用处只写成功路径 */
        const action = async (name, args = {}) => {
            const reply = await request("pose:call", { action: name, args });
            if (!reply?.ok) throw new Error(reply?.error || t("姿势页拒绝了动作"));
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

        /* ===== 姿势库弹窗：pose-lib 的整场库与本机姿势文件两条路共用素材库那扇弹窗外壳 =====
           库是数据根里另一批读得到的文件（<数据根>/pose/lib），Neo Studio 这边只读它：
           「存为姿势」写的还是 pose/scenes/，库里一份条目读回来就是一次 scene/apply。 */
        const libModal = createLibraryModal({ storageKey: "neo_studio_pose_libmodal", scope: "pose" });
        let libIndex = null;      // index.json 读到的那份；null = 库还没同步或读不成，弹窗出同步指引
        let libShown = LIB_PAGE;
        const libSearch = $el("input", {
            className: "ns-pose-lib-search", type: "search", spellcheck: "false",
            placeholder: t("搜索姿势（名字 / 分类 / 标签）"),
        });
        const libGroupSel = $el("select", { className: "ns-pose-sel ns-pose-lib-group", title: t("分组") });
        const libCharSel = $el("select", {
            className: "ns-pose-sel ns-pose-lib-char",
            title: t("按基座筛选：一条姿态挂着它的基座，挂在女基座上的姿态套到男素体上身型与盆宽全歪"),
        });
        const libOriginSel = $el("select", {
            className: "ns-pose-sel ns-pose-lib-origin", title: t("按来源筛选：预设随仓库分发只读，本地是本机自己写的"),
        });
        // 库来源：本机库 = 数据根的 pose/lib；云端库 = OSS 那份索引 + 本机缓存的副本
        const libSourceSel = $el("select", {
            className: "ns-pose-sel ns-pose-lib-source",
            title: t("库来源：本机库读数据根的 pose-lib，云端库读 OSS 上那棵树（文件先落本机缓存）"),
        });

        const libMeta = $el("p", { className: "ns-pose-lib-meta" });
        const libBlank = $el("p", { className: "ns-pose-lib-blank" });
        const libGrid = $el("div", { className: "ns-pose-lib-grid" });
        const libMore = $el("button", { className: "ns-pose-btn ns-pose-lib-more", type: "button" });
        libGate.push(libMore, libSearch, libGroupSel, libCharSel, libOriginSel, libSourceSel);   // 弹窗里的这一片与本机存档同一把门禁：ready 之前不可点
        const btnSceneLocal = btn("本机姿势文件…", "folder", libGate);
        // 库里没有想要的姿势时从本机挑一份 JSON，走的还是装载那条路
        const sceneFile = $el("input", { className: "ns-pose-file", type: "file", accept: ".json" });
        // 弹窗吃满一整屏时上面是库的卡片网格，下面是本机存档那一列：两边共用一条装载路，
        // 用户在同一个窗口里挑预设的整场与自己存的场景
        const libPane = $el("div", { className: "ns-pose-libpane" }, [
            $el("div", { className: "ns-pose-lib-preset" }, [
                row([libSourceSel, libSearch, libGroupSel, libCharSel, libOriginSel, btnSceneLocal]),
                libMeta, libBlank, libGrid, libMore,
            ]),
            $el("div", { className: "ns-pose-lib-local" }, [
                head("本机存档"),
                libFilterSearch, poseList, btnListMore,
            ]),
        ]);

        libModal.setContent(libPane);
        libModal.setOnClose(() => paintDockModal(btnLib, libModal));
        el.append(libModal.el, sceneFile);

        /* ===== 道具弹窗：和姿势库同一扇素材库外壳 =====
           道具表是一整页卡片（一页 PROP_PAGE_SIZE 件，页码条在下方），点工具条的「道具」直接开这一扇：
           点一张卡就是加一件，画面板上立刻多一件 —— 不用先选中再按一颗「添加道具」。
           搜索一次重画卡片、数量行与页码条，三者同一份结果。页码是布局偏好，落在 localStorage，
           重开停在同一页；云端索引落地后补画一次就是新的一页卡片。 */
        const propModal = createLibraryModal({ storageKey: "neo_studio_pose_propmodal", scope: "pose" });
        let propPage = 0;
        try { propPage = Math.max(0, parseInt(localStorage.getItem(PROP_PAGE_KEY), 10) || 0); } catch { /* 隐私模式读不到偏好就从第一页开 */ }
        const propPane = $el("div", { className: "ns-pose-proppane" }, [
            $el("div", { className: "ns-pose-prop-tools" }, [propSearch, propName]),
            propMeta,
            propGrid,
            propPager,
            row([btnGroundProp, btnDelProp]),
            $el("div", { className: "ns-pose-prop-added" }, [head("场上道具"), propList]),
        ]);
        propModal.setContent(propPane);
        propModal.setOnClose(() => paintDockModal(btnProp, propModal));
        el.append(propModal.el);
        /** 开道具弹窗：先按当前清单重画一页再开壳，弹窗开着时索引落地（云端）也看得见新卡片；
         *  同一条钮再点一次就是关 —— 弹窗的关法只有 Esc / 遮罩 / 标题栏 ✕，用户在这颗钮上点第二下
         *  原本只是把同一页卡片重刷一遍，收不掉这扇盖住整屏的窗 */
        function openPropModal() {
            if (propModal.isOpen()) { propModal.close(); return; }
            paintPropGrid();
            propModal.open(t("道具"));
            paintDockModal(btnProp, propModal);
            libModal.close();   // 两扇弹窗不叠：开这一扇就把姿势库那扇收起
        }

        /** 库文件的一条 JSON：库自己的 PoseFile 不带 success 字段，json() 会把缺 success 的当失败 */
        const libJson = async (path) => {
            const resp = await api.fetchApi(path);
            const data = await resp.json().catch(() => null);
            if (!resp.ok || !data) throw new Error(tf("读不到库文件：{path}", { path }));
            return data;
        };

        let libCloud = null;        // 云端清单：null = 没读过；未配置与读不到都出云端指引，不出一个空浏览器
        let cloudStatus = null;     // /neo_pose/cloud_status：enabled / available / props，决定云端那一条能不能选

        /** 云端的一份文件 → 本机缓存：场景 JSON 交回对象；道具只要落进缓存，页面自己按 /models/props/ 取它 */
        const cloudFile = async (rel, asJson) => {
            const resp = await api.fetchApi(`${CLOUD_FILE}?path=${encodeURIComponent(rel)}`);
            if (!resp.ok) {
                const data = await resp.json().catch(() => null);
                throw new Error(data?.error || tf("读不到云端文件：{path}", { path: rel }));
            }
            return asJson ? await resp.json() : null;
        };

        /** 云端清单读一次就留住：行字段与 pose/lib 的条目同名，卡片渲染与筛选都吃同一套代码 */
        async function ensureCloudIndex() {
            if (libCloud) return libCloud;
            const data = await json(CLOUD_INDEX);
            libCloud = {
                base_url: String(data.base_url || ""),
                count: data.count ?? (data.entries || []).length,
                groups: data.groups || [],
                entries: data.entries || [],
                props: data.props || [],
            };
            return libCloud;
        }


        /** 本机的一份 JSON 文件（姿态 / 姿势）：FileReader 读进来，不是 JSON 对象就在这出声 */
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

        /** meta/list 的素体清单：基座筛选要拿它把 charKey 译成中文 label，不另存一份定义 */
        let metaModels = [];

        /** meta/list 一次给全：面板每个下拉与勾选组都从这份清单来，不再逐样问页面 */
        function paintMeta(m) {
            metaModels = standardCharOptions(m.models);
            fill(modelSel, metaModels, "选择素体…");
            applyDefaultChar();
            fill(lookSel, m.looks || [], "外观");
            propChoices = m.props || [];
            paintPropGrid();
            fill(viewSel, m.views || [], "视角");
            applyDefaultView();
            fill(sizeSel, (m.sizes || []).map((n) => ({ key: String(n), label: `${n}px` })), "尺寸");
            formatBox.replaceChildren(...(m.formats || []).map((f) => $el("label", {
                className: "ns-pose-format", title: f.hint || f.label,
            }, [$el("input", { type: "checkbox", className: "ns-pose-check", value: f.key, checked: "checked" }), f.label])));
        }

        /** 云端道具在页面清单里的形状：key 走注册表口径 glb:<裸文件名>，页面的 addProp 认它，
         *  取文件由宿主这条通路负责（cloud_file 落进 <数据根>/pose/oss_cache/models/props/）。
         *  preview 是云端行里的道具注册表原行带的预览路径（pose_cloud.py 写的是云端键 props/preview/x.png）。 */
        const cloudPropChoices = () => (libCloud?.props || []).map((p) => ({
            key: `glb:${p.file}`,
            label: `${p.label}（${t("云端")}）`,
            path: p.path,
            cloud: true,
            preview: String(p.preview || ""),
        }));

        /** 道具卡片与道具名解析吃同一份清单：本机那批在前，云端那批带「云端」后缀排在后 */
        const allPropChoices = () => [...propChoices.map((o) => ({
            key: String(o.key ?? o.propKey ?? ""), label: o.label, preview: String(o.preview || ""),
        })), ...cloudPropChoices()];

        /** 卡片的预览图地址：注册表 preview 是道具目录里的相对路径，本机那一级就是页面写死的
         *  /models/props/，云端那棵树里道具目录叫 props/；内置道具没有注册表行，按
         *  preview/builtin-<id>.png 这条约定名取。两处都没图就是真没图，卡片出「无预览」，不给它挂一张转圈的 <img> */
        const propPreviewUrl = (choice) => {
            const builtinId = String(choice.key).startsWith("builtin:")
                ? String(choice.key).slice("builtin:".length) : "";
            const rel = choice.preview || (builtinId ? `preview/builtin-${builtinId}.png` : "");
            if (!rel) return "";
            return choice.cloud
                ? `${(libCloud?.base_url || "").replace(/\/+$/, "")}/${CLOUD_PROPS_KEY}/${rel}`
                : `${MODELS_PREFIX}/${CLOUD_PROPS_KEY}/${rel}`;
        };

        /** 一张道具有一张预览图：点卡片就是加一件（posemy 那种口径），不先选中再按「添加道具」——
         *  多一步只为了让用户再确认一次自己刚点的那张图 */
        const propCard = (choice) => {
            const url = propPreviewUrl(choice);
            const pic = $el("span", { className: "ns-pose-prop-pic" });
            if (url) {
                const img = $el("img", { className: "ns-pose-prop-thumb", src: url, alt: choice.label, loading: "lazy" });
                // 图不在仓库里（道具没渲染过、随包只发了 GLB 没发图）就在卡片里说，不挂一张坏图
                img.onerror = () => img.replaceWith($el("span", { className: "ns-pose-prop-noimg", textContent: t("无预览") }));
                pic.append(img);
            } else {
                pic.append($el("span", { className: "ns-pose-prop-noimg", textContent: t("无预览") }));
            }
            const card = $el("button", {
                className: "ns-pose-prop-card",
                type: "button", title: tf("点到画布上：{name}", { name: choice.label }), dataset: { propKey: choice.key },
            }, [
                pic,
                $el("span", { className: "ns-pose-prop-label", textContent: choice.label }),
                ...(choice.cloud ? [$el("span", { className: "ns-pose-prop-badge", textContent: t("云端") })] : []),
            ]);
            // 卡片不在 panelGate 里（每画一页就重造一批）：缺命令层时整页禁用，点了只会在页面里空转
            card.disabled = caps.hostUi !== true;
            card.onclick = () => run(() => addPropChoice(choice.key));
            return card;
        };

        /** 道具表一页卡片：搜索过滤一次重画卡片、页码条与数量行，三者同一份筛选结果 */
        function paintPropGrid() {
            const all = allPropChoices();
            const rows = propRows();
            const pages = Math.max(1, Math.ceil(rows.length / PROP_PAGE_SIZE));
            propPage = Math.min(propPage, pages - 1);
            const slice = rows.slice(propPage * PROP_PAGE_SIZE, (propPage + 1) * PROP_PAGE_SIZE);
            propGrid.replaceChildren(...(slice.length
                ? slice.map(propCard)
                : [$el("p", { className: "ns-pose-prop-blank", textContent: t("道具表里没有匹配的道具") })]));
            paintPropPager(pages);
            propMeta.textContent = tf("{total} 件道具 · 第 {page}/{pages} 页", {
                total: all.length,
                page: propPage + 1,
                pages,
            });
        }

        /** 搜索框当前筛出来的那批：卡片、页码条与「搜索回车」共用这一份，不各算一遍 */
        function propRows() {
            const q = propSearch.value.trim().toLowerCase();
            const all = allPropChoices();
            return q ? all.filter((c) => `${c.label} ${c.key}`.toLowerCase().includes(q)) : all;
        }

        /** 页码条：首页三颗、当前页前后各一颗、末页三颗，中间空档用省略号接上；一页装得下就整条不出 */
        function paintPropPager(pages) {
            const pick = (p) => {
                const cur = p === propPage;
                const b = $el("button", {
                    className: "ns-pose-btn ns-pose-prop-page" + (cur ? " ns-pose-prop-page-on" : ""),
                    type: "button", textContent: String(p + 1), dataset: { page: String(p) },
                });
                if (cur) b.setAttribute("aria-current", "page");
                b.onclick = () => { propPage = p; savePropPage(); paintPropGrid(); };
                return b;
            };
            const jump = (step, label) => {
                const b = $el("button", { className: "ns-pose-btn ns-pose-prop-page ns-pose-prop-jump", type: "button" }, [icon("chevron", 14)]);
                b.title = t(label);
                b.setAttribute("aria-label", t(label));
                b.disabled = step < 0 ? propPage === 0 : propPage >= pages - 1;
                b.onclick = () => {
                    propPage = Math.max(0, Math.min(pages - 1, propPage + step));
                    savePropPage();
                    paintPropGrid();
                };
                return b;
            };
            const marks = new Set([0, 1, 2, propPage - 1, propPage, propPage + 1, pages - 3, pages - 2, pages - 1]);
            const nums = [...marks].filter((p) => p >= 0 && p < pages).sort((a, b) => a - b);
            const kids = [jump(-1, "上一页")];
            nums.forEach((p, i) => {
                if (i && p - nums[i - 1] > 1) kids.push($el("span", { className: "ns-pose-prop-gap", textContent: "…" }));
                kids.push(pick(p));
            });
            kids.push(jump(1, "下一页"));
            propPager.replaceChildren(...kids);
            propPager.hidden = pages < 2;   // 一页装得下就没有翻页这回事
        }

        function savePropPage() {
            try { localStorage.setItem(PROP_PAGE_KEY, String(propPage)); } catch { /* 偏好写不进不影响用 */ }
        }


        /** 外观定在暗色档：姿势页的 LOOKS 只有摄影棚灰与暗色两档，旧包没有暗色档就不动 */
        async function applyDefaultLook(m) {
            const hit = (m.looks || []).find((l) => l.key === DEFAULT_LOOK_KEY);
            if (!hit) return;
            lookSel.value = hit.key;
            await action("look/set", { key: hit.key }).catch(() => {});
        }

        /** 素体下拉落在标准男基座上：页面开局挂的就是它（姿势页 src/pose/character.js 的 CHARACTERS 表首），
         *  旧姿势包没这一档就停在「选择素体…」—— 下拉里那一项就是「加素体」将拿到的那具身，不能写一个没有的 */
        function applyDefaultChar() {
            if (modelSel.value) return;
            if (!metaModels.some((m) => m.key === DEFAULT_CHAR_KEY)) return;
            modelSel.value = DEFAULT_CHAR_KEY;
            if (!canvas.model) canvas.model = DEFAULT_CHAR_KEY;   // 首个 pose:state 之前也要让基座筛选有个落点
        }

        /** 导出视角定在「当前视角」：面板不动用户调好的机位就能出图（页面 view=current 沿用现场相机）。
         *  旧姿势包的 views 里没有这一档就不动 —— 下拉停在「视角」上，页面自己落它那份默认 */
        function applyDefaultView() {
            if ([...viewSel.options].some((o) => o.value === DEFAULT_VIEW_KEY)) viewSel.value = DEFAULT_VIEW_KEY;
        }

        const stateRow = (key, value) => $el("div", { className: "ns-pose-state-row" }, [
            $el("span", { className: "ns-pose-state-key", textContent: t(key) }),
            $el("span", { className: "ns-pose-state-val", textContent: value }),
        ]);

        /** 画布状态镜像到状态栏：页面侧自己改了控件（点画布、按快捷键），面板跟着对账 */
        function paintState(s) {
            Object.assign(canvas, s || {});
            if (canvas.model) {
                // 页面自己换了素体：素体下拉与库的基座筛选跟着对账。下拉里没有这一档（画布挂的是用户在
                // 姿势页自己那侧导入的基座）就两条都不动 —— 把 select.value 写空等于丢掉用户的筛选
                if ([...modelSel.options].some((o) => o.value === canvas.model)) {
                    modelSel.value = canvas.model;
                    if ([...libCharSel.options].some((o) => o.value === canvas.model)) {
                        libCharSel.value = canvas.model;   // 弹窗的基座筛选跟着对账
                    }
                }
            }
            stateBox.replaceChildren(
                stateRow("素体", canvas.model || "—"),
                stateRow("素体数", String(canvas.members ?? "—")),
                stateRow("道具数", String(canvas.props ?? 0)),
            );
        }

        /** 姿势库弹窗下半只列本机姿势存档（pose/scenes/）：预设姿势都在上半那一片卡片里，
         *  这一栏不再排一份预设清单 —— 库里有的东西不在这里重复一遍。搜索框按名字过滤，
         *  一屏 120 行走「加载更多」，点一行就是一次装载 */
        function paintPoseList() {
            const q = libFilterSearch.value.trim().toLowerCase();
            const sceneRows = (sceneNames || [])
                .filter((n) => !q || String(n).toLowerCase().includes(q))
                .sort((a, b) => String(a).localeCompare(String(b), "en"));
            const rows = sceneRows.slice(0, libListShown).map((n) => $el("div", {
                className: "ns-pose-item" + (n === pickedScene ? " ns-pose-item-on" : ""),
                title: String(n),
                onclick: () => loadScene(n),
            }, [
                $el("span", { className: "ns-pose-item-label", textContent: String(n) }),
                $el("span", {
                    className: "ns-pose-row-origin ns-pose-lib-origin-lab",
                    textContent: t(LIB_ORIGIN_LABEL.lab),
                }),
            ]));
            const left = sceneRows.length - rows.length;
            if (!rows.length) {
                rows.push($el("div", {
                    className: "ns-pose-item ns-pose-item-empty",
                }, [$el("span", { className: "ns-pose-item-label", textContent: t("没有匹配的姿势") })]));
            }
            btnListMore.hidden = left <= 0;
            btnListMore.textContent = tf("加载更多（还有 {n} 条）", { n: left });
            poseList.replaceChildren(...rows);
        }

        function paintProps(data) {
            const items = data.items || [];
            if (!items.some((it) => it.id === pickedProp)) pickedProp = items[0]?.id || "";
            // 落点写在行上：道具自己找的空位，用户要能看见它落在哪（面板不猜坐标，页面算完报回来）
            const rows = items.map((it) => $el("div", {
                className: "ns-pose-item" + (it.id === pickedProp ? " ns-pose-item-on" : ""),
                textContent: `${it.label || it.id} · ${it.attach?.bone
                    ? tf("挂在 {bone}", { bone: it.attach.bone })
                    : (Array.isArray(it.position)
                        ? `(${Number(it.position[0]).toFixed(2)}, ${Number(it.position[2]).toFixed(2)})`
                        : t("未挂载"))}`,
                title: it.id, onclick: () => { pickedProp = it.id; refreshProps(); },
            }));
            propList.replaceChildren(...(rows.length ? rows
                : [$el("div", { className: "ns-pose-blank", textContent: t("场上没有道具") })]));
        }

        /** 出处角标：合并库里一条落在哪根库由同步脚本写的 origin 说，云端那批由来源开关说；
         *  旧版清单没有这一字段 = 本地库那份（合并库落在本机，预设是这次拆库才有的） */
        const originBadge = (entry) => {
            const key = entry.cloud ? "cloud" : (entry.origin === "lib" ? "lib" : "lab");
            return $el("span", {
                className: `ns-pose-lib-origin-badge ns-pose-lib-origin-${LIB_ORIGIN_CLASS[key]}`,
                textContent: t(LIB_ORIGIN_LABEL[key]),
                title: LIB_ORIGIN_TITLE[key],
            });
        };

        /** 卡片预览图的地址：本机库走 /pose-lib/ 前缀，云端库直连 OSS —— 封面只是一张 <img>，
         *  不碰姿势页的任何契约，也就无须为它开第二条伺服通路。后端给的 base_url 带尾斜杠，拼之前剥掉 */
        const libThumbUrl = (entry, thumb) => entry.cloud
            ? `${(libCloud?.base_url || "").replace(/\/+$/, "")}/${thumb}`
            : `${LIB_PREFIX}/${thumb}`;


        /** 一条库条目的场景 JSON：本机库读 /pose-lib/，云端库经 cloud_file 落进本机缓存再读回来 */
        const libSceneJson = (entry) => entry.cloud
            ? cloudFile(entry.path, true)
            : libJson(`${LIB_PREFIX}/${entry.path}`);


        const libCard = (entry) => {
            const label = entry.label || entry.id;
            const thumb = previewOf(entry);
            // 预览图是姿势仓库对着来源参考图渲染的那一张：参考图版式可以把同一个人画两遍
            // （「手臂绘图参考」就是一张纸两个视角），图上的个数比场景文件里的人数多。
            // 角上标住这张是参考图，人数只在副标题那一行按场景文件说。
            const pic = thumb
                ? $el("div", { className: "ns-pose-lib-thumbbox" }, [
                    $el("img", { className: "ns-pose-lib-thumb", src: libThumbUrl(entry, thumb), alt: label, loading: "lazy" }),
                    $el("span", { className: "ns-pose-lib-ref", textContent: t("参考图") }),
                    originBadge(entry),
                ])
                : $el("div", { className: "ns-pose-lib-noimgbox" }, [
                    $el("div", { className: "ns-pose-lib-noimg", textContent: t("无预览") }), originBadge(entry),
                ]);
            const card = $el("button", {
                className: "ns-pose-lib-card", type: "button", title: label,
                dataset: { libId: String(entry.id) },
            }, [pic, $el("p", { className: "ns-pose-lib-label", textContent: label }),
                $el("p", { className: "ns-pose-lib-tags", textContent: libTagsOf(entry) })]);
            card.onclick = () => run(async () => {
                const file = await libSceneJson(entry);
                // 整场套用是页面自己的一条命令，走 pose:call；库文件自带视角，套完镜头对着整场
                const r = await action("scene/apply", { file });
                if (!r.ok) throw new Error(tf("姿势没有套上：{msg}",
                    { msg: (r.errors || []).join("；") || t("页面未报告原因") }));
                libModal.close();
                toast(tf("已套用整场：{name}（{rigs} 副骨架 · {props} 个物体）",
                    { name: label, rigs: r.rigsApplied ?? 0, props: r.propsApplied ?? 0 }));
            });
            return card;
        };

        /** 分组下拉的条数按来源过滤后的库数：清单 groups 自带那份 count 是预设集自己算的，
         *  本机 pose-lab 新写的姿态不在里面，一筛来源就对不上屏上的卡 */
        const libGroupRows = (rows, index) => libGroups(rows, index?.groups).map((sec) => ({
            key: sec.key, label: `${sec.label}（${sec.count}）`,
        }));

        /** 弹窗当前吃的那份库：本机 = 数据根 pose/lib 的合并库，云端 = cloud_index 的行（字段同名） */
        const sourceIndex = () => (libSourceSel.value === "cloud" ? libCloud : libIndex);

        function renderLibIndex() {
            const cloud = libSourceSel.value === "cloud";
            const index = sourceIndex();
            libOriginSel.hidden = cloud;   // 云端那批没有预设 / 本地之分，来源筛选在它身上没有意义
            const pickedGroup = libGroupSel.value;
            const byChar = { origin: cloud ? "" : libOriginSel.value, charKey: libCharSel.value };
            fill(libGroupSel, libGroupRows(libFilter(index?.entries, byChar), index), "全部分组");
            libGroupSel.value = pickedGroup;   // 重建选项后落回原选择；来源一换原分组不存在就落回全部
            const rows = libFilter(index?.entries,
                { q: libSearch.value, group: libGroupSel.value, ...byChar });
            const sections = libGroups(rows.slice(0, libShown), index?.groups);
            libGrid.replaceChildren(...sections.flatMap((sec) => [
                $el("h4", { className: "ns-pose-lib-group-title", textContent: `${sec.label}（${sec.items.length}）` }),
                ...sec.items.map(libCard),
            ]));
            libGrid.hidden = !rows.length;
            libBlank.hidden = rows.length > 0;
            // 库没同步出同步指引，云端没配置出云端指引，都有了才说「没有匹配」：一个空浏览器不是库的样子
            libBlank.textContent = t(cloud ? (libCloud ? "没有匹配的云端姿势" : CLOUD_SYNC_HINT)
                : (libIndex ? "没有匹配的姿势" : LIB_SYNC_HINT));
            libMore.hidden = rows.length <= libShown;
            libMore.textContent = tf("加载更多（还有 {n} 条）", { n: rows.length - libShown });
            // 条数从过滤后的分层数出来：预设 / 本地一筛，清单 groups 里预设集自己那份 count 就对不上屏上的卡
            libMeta.textContent = index
                ? (cloud
                    ? tf("{total} 个云端姿势 · 显示 {shown}", {
                        total: index.count ?? rows.length, shown: rows.length,
                    })
                    : tf("{total} 个姿势（预设 {ship} · 本地 {lab}）· 显示 {shown}", {
                        total: index.count ?? rows.length,
                        ship: (index.entries || []).filter((e) => e.origin === "lib").length,
                        lab: (index.entries || []).filter((e) => e.origin !== "lib").length,
                        shown: rows.length,
                    }))
                : "";
        }


        /** 弹窗只装一件事：pose-lib 的整场库（本机那份 + 云端那份）；数据根的本机存档与选本机文件都在下半那一列。
         *  同一条钮再点一次就是关，与道具那扇窗同一口径 */
        async function openLibModal() {
            if (libModal.isOpen()) { libModal.close(); return; }
            libModal.setContent(libPane);
            libModal.open(t("姿势库"));
            paintDockModal(btnLib, libModal);
            // 未配置的云端不是一个「点了只会失败」的来源：那一条干脆不出现（AGENTS 的产品口径）
            const sources = [{ key: "local", label: t("本机库") }];
            if (cloudStatus?.enabled === true) sources.push({ key: "cloud", label: t("云端库") });
            const keep = sources.some((s) => s.key === libSourceSel.value) ? libSourceSel.value : "local";
            libSourceSel.replaceChildren(...sources.map((s) => $el("option", { value: s.key, textContent: s.label })));
            libSourceSel.value = keep;
            if (libIndex === null) {
                try {
                    libIndex = await libJson(LIB_INDEX);
                    fillLibCharSel();
                    fill(libGroupSel, libGroupRows(libFilter(libIndex.entries, { origin: libOriginSel.value, charKey: libCharSel.value }), libIndex), "全部分组");
                    fill(libOriginSel, LIB_ORIGIN_ORDER.map((o) => ({ key: o.key, label: t(o.label) })), "全部来源");
                } catch {
                    // 读不出索引 = 库没同步：这句就是弹窗里那句同步指引要说的同一件事
                    toast(tf("读不到库文件：{path}", { path: LIB_INDEX }));
                }
            }
            libShown = LIB_PAGE;
            libListShown = LIB_LIST_PAGE;   // 清一次分页：重新进窗时本机存档那一列回到第一屏
            renderLibIndex();
            paintPoseList();
        }


        /** 基座筛选跟着素体下拉同一批基座（标准男 / 标准女）：库里一条姿态挂着它的基座
         *  （同步脚本按姿势仓库的分派结果写进 charKey），默认停在画布当前那具素体 ——
         *  库默认就是「套得上当前素体」的那一批，挂在女基座上的姿态筛到男素体上是上半身全歪 */
        function fillLibCharSel() {
            const allowed = new Set(metaModels.map((m) => m.key));
            const keys = [...new Set((libIndex?.entries || []).map((e) => String(e.charKey || "")))]
                .filter((k) => allowed.has(k));
            const current = allowed.has(canvas.model) ? canvas.model : DEFAULT_CHAR_KEY;
            if (!keys.includes(current)) keys.unshift(current);
            const labels = new Map(metaModels.map((m) => [m.key, m.label]));
            fill(libCharSel, keys.map((k) => ({ key: k, label: labels.get(k) || k })), t("全部基座"));
            libCharSel.value = current;
            libListShown = LIB_LIST_PAGE;
            paintPoseList();
        }

        libSearch.oninput = () => renderLibIndex();
        libGroupSel.onchange = () => renderLibIndex();
        libCharSel.onchange = () => { renderLibIndex(); };
        libOriginSel.onchange = () => renderLibIndex();
        // 切到云端 = 现读一次清单（几十 KB，读失败就把弹窗交给那句云端指引，不出空浏览器）
        libSourceSel.onchange = () => run(async () => {
            if (libSourceSel.value === "cloud" && !libCloud) {
                try { await ensureCloudIndex(); } catch (e) { toast(tf("读不到云端索引：{msg}", { msg: e.message })); }
                libShown = LIB_PAGE;
            }
            renderLibIndex();
        });

        libMore.onclick = () => { libShown += LIB_PAGE; renderLibIndex(); };
        libFilterSearch.oninput = () => { libListShown = LIB_LIST_PAGE; paintPoseList(); };
        btnListMore.onclick = () => { libListShown += LIB_LIST_PAGE; paintPoseList(); };
        btnSceneLocal.onclick = () => { sceneFile.value = ""; sceneFile.click(); };

        /* 本机的一份姿势文件：库里没有的那份一样装得进，走的还是 pose:open-scene 那条装载路 */
        sceneFile.onchange = () => {
            const pickedFile = sceneFile.files && sceneFile.files[0];
            sceneFile.value = "";
            if (!pickedFile) return;
            run(async () => {
                post("pose:open-scene", { scene: await readJsonFile(pickedFile) });
                libModal.close();
                toast(tf("已载入本机姿势：{name}", { name: pickedFile.name }));
            });
        };

        /* 姿势存档 = 读那份场景装进页面：弹窗里点一行就是装载，预设卡片点下去也是同一条 pose:open-scene */
        const loadScene = (name) => run(async () => {
            pickedScene = name;
            await refreshScenes();
            const data = await json(`/neo_pose/scene?name=${encodeURIComponent(name)}`);
            post("pose:open-scene", { scene: data.scene });
            toast(tf("已载入姿势：{name}", { name }));
        });

        const refreshScenes = () => json("/neo_pose/scenes").then((d) => {
            sceneNames = (d.scenes || []).map((s) => s.name);
            paintPoseList();
        }).catch(() => { sceneNames = []; paintPoseList(); });

        const refreshProps = () => action("prop/list").then(paintProps)
            .catch((e) => toast(tf("道具列表失败：{msg}", { msg: e.message })));

        /* 「保存姿势」是右上角的工具条入口：名字写进 pose/scenes/，与弹窗里那一列本机存档对上 */
        btnSavePose.onclick = () => run(async () => {
            const typed = poseName.value.trim();
            if (!typed) { toast(t("请先写姿势名")); poseName.focus(); return; }
            const reply = await request("pose:save-scene");
            await json("/neo_pose/scene", { name: typed, scene: reply?.scene ?? reply });
            poseName.value = "";
            pickedScene = typed;
            await refreshScenes();
            toast(tf("姿势已保存：{name}", { name: typed }));
        });

        /* 面板动作 → 画布：动作结果带回状态就镜像，道具变动则重问一次 prop/list */
        btnAddMember.onclick = () => run(() =>
            action("member/add", modelSel.value ? { key: modelSel.value } : {}).then(paintState));
        btnDelMember.onclick = () => run(() => action("member/remove").then(paintState));
        btnResetPose.onclick = () => run(() => action("scene/reset").then(paintState));
        lookSel.onchange = () => run(() => action("look/set", { key: lookSel.value }));
        // 素体下拉就是「换当前素体」：换完基座筛选跟着走，库里显示的始终是套得进当前素体的那一批
        modelSel.onchange = () => run(async () => {
            if (!modelSel.value) return;
            await action("model/set", { key: modelSel.value });
            // 库里没有挂在这一具基座上的姿态时不动筛选：写一个下拉里没有的值等于把筛选清成「全部基座」
            if ([...libCharSel.options].some((o) => o.value === modelSel.value)) {
                libCharSel.value = modelSel.value;
            }
            canvas.model = modelSel.value;
        });

        /** 加一件道具：云端先把 GLB 落进本机缓存（页面那条 /models/props/<file>.glb 由第三级 fallback
         *  接住，姿势页与道具注册表都不知道这批来自云端）；落点由页面算 —— prop/add 找空位（避开素体
         *  与场上已有道具），面板不猜坐标 */
        async function addPropChoice(key) {
            const choices = allPropChoices();
            const cloudProp = choices.find((c) => c.key === key && c.path);
            if (cloudProp) await cloudFile(cloudProp.path, false);
            await action("prop/add", { key });
            await refreshProps();
            toast(tf("已添加道具：{name}", { name: choices.find((c) => c.key === key)?.label || key }));
        }
        propSearch.oninput = () => paintPropGrid();
        /* 回车即添加（不点任何按钮）：搜索框回车加筛出来的第一件，道具名框回车按名字解析 ——
           名字在清单里找不到就不发请求 */
        propSearch.onkeydown = (e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const hit = propRows()[0];
            if (!hit) { toast(t("道具表里没有匹配的道具")); return; }
            run(() => addPropChoice(hit.key));
        };
        propName.onkeydown = (e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const choices = allPropChoices();
            const typed = propName.value.trim();
            propName.value = "";   // 一次性输入：写完就清，下一发不覆盖上一发
            if (!typed) { toast(t("道具名还空着：写 椅子 / 桌子 / 剑 这类名字再回车")); return; }
            const key = resolvePropChoice(typed, choices);
            if (!key) {
                toast(tf("道具表里没有「{name}」：可输入 椅子 / 桌子 / 剑 这类名字（共 {n} 项），或点一张卡片",
                    { name: typed, n: choices.length }));
                return;
            }
            run(() => addPropChoice(key));
        };
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
                    // 旧姿势包没有宿主命令层：面板说明缺什么，不摆点了只会空转的控件
                    notice.hidden = false;
                    return;
                }
                notice.hidden = true;
                setPanel(true);
                // 配了云端就在进页时读一次清单：道具下拉先画本机那批，云端那份落到再补一次画。
                // 这一发不吊在桥的回复链上——meta/list 的回复与 look 预设都不该拖住云端道具出现，读不到就只留本机那批
                if (cloudStatus?.enabled === true) ensureCloudIndex().then(paintPropGrid).catch(() => {});
                action("meta/list").then(async (m) => {
                    paintMeta(m);
                    await applyDefaultLook(m);
                }).catch((e) => toast(tf("读取姿势元数据失败：{msg}", { msg: e.message })));
                refreshProps();
                return;
            }
            if (event.data?.type === "pose:state") paintState(event.data.state);
        });

        async function render() {
            stage.replaceChildren($el("div", { className: "ns-pose-hint", textContent: t("读取姿势状态…") }));
            setLib(false);
            setPanel(false);
            frame = null;
            let status = null;
            try { status = await json("/neo_pose/status"); } catch { status = null; }
            if (!status) {
                setChrome(false);
                stage.replaceChildren($el("div", { className: "ns-pose-empty" }, [
                    $el("h3", { textContent: t("姿势状态读不到") }),
                    $el("p", { textContent: t("后端未就绪：刷新页面重试。") }),
                ]));
                return;
            }
            caps = status.caps || {};
            // 云端配没配置决定两件事：姿势库的来源下拉有没有「云端库」那一条、道具下拉有没有云端组
            cloudStatus = await json("/neo_pose/cloud_status").catch(() => null);
            if (!status.installed) {
                // 缺包要说清楚缺什么、怎么装：iframe 直接指向不存在的入口页只剩白屏
                setChrome(false);
                const retry = $el("button", { className: "ns-pose-btn", type: "button", onclick: render });
                setIconLabel(retry, "history", t("重新检查"));
                stage.replaceChildren($el("div", { className: "ns-pose-empty" }, [
                    $el("h3", { textContent: t("3D 姿势未安装") }),
                    $el("p", { textContent: status.hint || t("未找到姿势包。") }),
                    retry,
                ]));
                return;
            }
            setChrome(true);
            frame = $el("iframe", {
                className: "ns-pose-frame",
                title: t("3D 姿势"),
                src: POSE_PAGE_URL,
                // allow-downloads 给页面自存 GLB；不给 allow-popups / allow-forms / allow-top-navigation，
                // 姿势页只需要脚本、同源存储与被拦截的下载
                sandbox: "allow-scripts allow-same-origin allow-downloads",
            });
            stage.replaceChildren(frame);
            refreshScenes();
        }
        await render();
    };
}

/** 卡片缩略图优先级：clay 是写实渲染那张，一眼看得出姿势；缺 clay 的条目落到 skeleton / silhouette / depth。
    口径与姿势页 src/ui/libraryPanel.js 的 thumbOf 同一条（库的 inbox 源图不在同步范围内，不作候选）。 */
export function previewOf(entry) {
    const p = entry?.preview || {};
    for (const key of LIB_VARIANTS) { if (p[key]) return String(p[key]); }
    return "";
}

/** 搜索口径与姿势仓库 poseLibrary.js 的 filterIndex 同一份字段表：label / 分类 / 标签 / id / source；
 *  origin 是合并库每条的出处（预设 lib / 本地 lab），旧版清单没这字段 = 本地库那份；
 *  charKey 是这条姿态挂的基座（同步脚本按姿势仓库 lib:bodies 的分派结果写进索引），
 *  旧版清单没这字段 = 没分派过基座，一筛基座就看不见它 —— 套上去多半是女姿挂男身 */
export function libFilter(entries, { q = "", group = "", origin = "", charKey = "" } = {}) {
    const text = String(q || "").trim().toLowerCase();
    return (entries || []).filter((e) => {
        if (group && !(e.groups || []).includes(group)) return false;
        if (origin && String(e.origin || "lab") !== origin) return false;
        if (charKey && String(e.charKey || "") !== charKey) return false;
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
        .map(([key, items]) => ({ key, label: labelOf.get(key) || key, items, count: items.length }));
}

/** 卡片副标题：人数与道具数写在最前 —— 多人场景要在卡片上分得出来；其后是分类头两条与来源。
    库里 preset / manual 这两种来源满库都是，标出来没意义，
    只有 photo3d / mixamo 这类真实来源值得用户看见（口径与姿势页卡片副标题同一份字段表） */
export function libTagsOf(entry) {
    const cats = [...new Set(entry?.categories || [])].slice(0, 2).join(" / ");
    const source = entry?.source;
    const real = source && source !== "manual" && source !== "preset" ? ` · ${source}` : "";
    const people = tf("{people}人", { people: Number(entry?.people) || 0 });
    const props = tf(" · {props}道具", { props: Number(entry?.props) || 0 });
    return `${people}${props} · ${cats}${real}`;
}
