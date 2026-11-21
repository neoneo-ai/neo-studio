// 画布生成层的运行态：四条链共用这一份节点运行态（running 按节点 id 记着一发），加「脱手」这一档 —— 切画布
// 与卸页只把在途的那一发脱手：图与片落在 Output 目录里，不再写回旧画布，也不在页面外头留一份没人收的监听。
// 进度写回与终态收摊都从这一层出去（落图在 finish，落片在出片族的轮询），族模块只读这几张表，不各存一份。
import { t, tf } from "../../../js/core/i18n.js";
import { RUN_LABELS, runKind } from "./node-types.js";

export function createCanvasState({ host, toast }) {
    // 一发一份运行态（节点上那一行状态就是它）。watchTask 在终态自己摘监听；切画布只把这一发脱手：
    // 图已经落在 Output 目录，不再写回旧画布，也不在页面外头留一份没人收的监听
    const running = new Map();
    const detached = new Set();
    const timers = new Map();     // 轮询链（简单视频 / 配方单段）的计时句柄：task_id → setInterval
    const chains = new Map();     // 串联的车尾节点 id → 这一列还在跑的段节点 id（车尾的进度与整列取消读它）
    const llmRuns = new Map();    // 增强 / 反推的在途一发：节点 id → {abort, stopped}（取消与脱手都按节点摘这一发）

    function stateOf(node) {
        const st = running.get(node.id);
        return {
            status: st?.status || "",
            // kind 给状态行认串联的车尾：那一行数的是链上的段数，不是某一发的步数
            kind: st?.kind || "",
            done: st?.done || 0,
            total: st?.total || 0,
            error: st?.error || "",
        };
    }

    function setRunning(id, patch) {
        running.set(id, { ...(running.get(id) || {}), ...patch });
        host.paintNodes();
    }

    /** 这一张节点那一发在提示条里说的话（RUN_LABELS 里那一行）：节点已经不在这一张画布上（切走了、撤销掉了）
     *  就按生图那一发收 —— 图与片都已经在 Output 目录里，只剩一句落点 */
    function labelsOf(nodeId) {
        const node = host.getState().nodes.find((n) => n.id === nodeId);
        return RUN_LABELS[node ? runKind(node) : "image"];
    }

    function finish(nodeId, snap) {
        const fell = detached.delete(snap.task_id);
        const labels = labelsOf(nodeId);
        if (snap.status === "succeeded") {
            running.delete(nodeId);
            host.paintNodes();
            // 切画布时脱手的那一发、以及节点已被删掉的：图就在 Output 目录里，不往现在这张画布上写
            if (fell || !host.hasNode(nodeId)) { toast(t(labels.fell), "success"); return; }
            host.applyResult(nodeId, snap.images || [], labels.out);
            toast(tf(labels.doneN, { n: (snap.images || []).length }), "success");
            return;
        }
        if (snap.status === "cancelled") {
            running.delete(nodeId);
            host.paintNodes();
            toast(t(labels.cancelled), "info");
            return;
        }
        const msg = String(snap.error || "");
        const needKey = ["GEMINI_API_KEY", "GOOGLE_API_KEY"].some((k) => msg.includes(k)) || msg.includes("apiKey");
        running.set(nodeId, { ...(running.get(nodeId) || {}),
            status: "failed", error: needKey ? t("技能缺 API Key，在技能管理里填好再出图") : msg });
        host.paintNodes();
        if (needKey) {
            toast(t("技能缺 API Key，已为你打开技能管理"), "info");
            return;
        }
        toast(`${t(labels.failToast)}${msg ? `：${msg}` : ""}`, "error");
    }

    /** 切画布项目：这一发脱手 —— 图落在 Output 目录里，不再写回旧画布，也不在页面外头留一份没人收的监听 */
    function detachTask(taskId, nodeId) {
        detached.add(taskId);
        running.delete(nodeId);
    }

    return { running, detached, timers, chains, llmRuns, stateOf, setRunning, labelsOf, finish, detachTask };
}
