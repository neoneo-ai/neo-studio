/**
 * voice-gen.js
 * 语音生成客户端：/neo_voice/* API 包装与任务事件等待（rs.voice_gen.status）。
 * 参考音频来自画廊音频卡片，经 copy_to_input 落 input/ 后作为 {{REF_AUDIO_1}}；
 * 目标文字走 {{PROMPT}}；输出为 SaveAudio 落盘的音频，弹窗内显示波形并播放。
 */

import { api } from "../../../../scripts/api.js";
import { t } from "./js/core/i18n.js";
import { queueTrack } from "./queue-panel.js";

const VOICE_API = "/neo_voice";
const VOICE_STATUS_EVENT = "rs.voice_gen.status";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
export const VOICE_SKILL_ID = "cosyvoice_voice";

async function getJson(path) {
    const resp = await fetch(path);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    return data;
}

/** 语音生成请求体（/neo_voice/generate）：参考音频 + 目标文字，输出走独立 Voice 目录 */
export function buildVoiceRequest(refName, targetText) {
    return {
        skill_id: VOICE_SKILL_ID,
        prompt: targetText,
        references: [{ kind: "input", value: refName }],
        output_prefix: "Voice",
    };
}

/** 提交语音任务，返回任务快照（含 task_id / warnings）；失败抛 Error(后端消息) */
export async function requestVoiceGeneration(payload) {
    const resp = await fetch(`${VOICE_API}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.error) throw new Error(data?.error || `HTTP ${resp.status}`);
    queueTrack("voice", data, { label: payload?.prompt });
    return data;
}

export async function cancelVoiceTask(taskId) {
    try {
        await fetch(`${VOICE_API}/cancel/${encodeURIComponent(taskId)}`, { method: "POST" });
    } catch (e) {
        console.warn("cancel voice task failed:", e);
    }
}

/**
 * 等待语音任务到终态（succeeded/failed/cancelled），返回最终快照。
 * 后端把快照按变化经 WebSocket 推送（rs.voice_gen.status），订阅事件而非轮询 HTTP；
 * 订阅后兜底首拉一次当前状态，断线重连时再拉一次补漏；约 40 分钟无终态按失败收场。
 */
export function watchVoiceTask(taskId, onSnapshot, isCancelled) {
    return new Promise((resolve) => {
        const statusUrl = `${VOICE_API}/status/${encodeURIComponent(taskId)}`;
        let timeout;
        function finish(snap) {
            clearTimeout(timeout);
            api.removeEventListener(VOICE_STATUS_EVENT, onStatus);
            api.removeEventListener("reconnected", onReconnected);
            resolve(snap);
        }
        function apply(snap) {
            if (!snap || snap.task_id !== taskId) return;
            onSnapshot?.(snap);
            if (TERMINAL_STATUSES.has(snap.status)) finish(snap);
        }
        function resync() {
            getJson(statusUrl).then(apply).catch(() => {});
        }
        function onStatus(event) {
            if (isCancelled?.()) return finish({ status: "cancelled" });
            apply(event.detail);
        }
        function onReconnected() {
            if (isCancelled?.()) return finish({ status: "cancelled" });
            resync();
        }
        timeout = setTimeout(
            () => finish({ status: "failed", error: t("等待语音生成超时，请稍后在 Gallery 查看") }),
            40 * 60 * 1000
        );
        api.addEventListener(VOICE_STATUS_EVENT, onStatus);
        api.addEventListener("reconnected", onReconnected);
        if (isCancelled?.()) {
            finish({ status: "cancelled" });
            return;
        }
        resync();
    });
}
