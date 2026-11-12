# Voice Clone

> 🇨🇳 中文: [../studio-voice-clone.md](../studio-voice-clone.md)

The "声音克隆" card in the **Create** section of the Studio home opens `#/voice`
(`studio/web/voice-clone/voice-clone.js`). The top bar has no tab for it: that home card is the only way in. The
generation chain is the same one the audio card's ⋯ menu uses ("生成语音") — `voice-gen.js` calls `/neo_voice/*` and
tracks progress through the `rs.voice_gen.status` event instead of polling HTTP — and the waveform widget is the same
single implementation (`voiceAudioWidget`, exported from `gallery-card-tools.js`).

## The path

1. **Pick a reference audio**: `从素材库选音频` opens the library modal; clicking an audio card puts its waveform on
   the reference slot. This modal only accepts audio (`accept: "audio"`) — clicking an image or video card opens the
   lightbox instead. The text box prefills the voice skill's `default_prompt` from its `config.json`; text the user
   already typed is never overwritten.
2. **Write the text to speak**: with an empty box, clicking Generate only says "请先输入要说的文字" and sends nothing.
3. **Generate**: the reference audio goes through `/neo_gallery/copy_to_input` into `input/` as `{{REF_AUDIO_1}}`, the
   text goes in as `{{PROMPT}}`, the skill is `cosyvoice_voice`, and SaveAudio writes the output to `Output/Voice`.
   The page shows the 排队中… / 合成中… lines and fills the progress bar from the snapshots the backend pushes; the
   stages that report no step count get a bar that moves on its own.
4. **Cancel the task**: `取消任务` sends `POST /neo_voice/cancel/<task_id>` and lands the run as "已取消" — a success
   event that arrives late does not read it back as success.
5. **Audition and collect**: on success the result area holds one playable waveform, and `打开输出目录` switches the
   library to the `Voice` folder.

Picking a new audio re-copies the reference: the `copy_to_input` name follows the new file, and the previous audio's
traces (reference waveform plus the earlier result waveform) are cleared from the page. Closing the window stops this
page's players; the task itself finishes inside the execution queue.

## Offline

Voice generation needs the ComfyUI execution queue, so in the desktop window with ComfyUI not running the 生成 button
reads "需要 ComfyUI"; clicking it hands the desktop app the job of starting the kernel instead of sending a request
that can only answer 409 (`app/studio_caps.py`, the `voice` flag).

## Agent and MCP

The same chain is exposed on the MCP tool surface as `voice_clone` (`studio/mcp_server.py`): `prompt` is the text to
speak and `ref_audio` is the reference audio name — a library audio with a `subfolder` is copied into `input/` through
`/neo_gallery/copy_to_input` first, the same channel this page uses when picking audio. It returns a `task_id` as soon
as it is queued; the agent dock polls `task_status` to the terminal state and the output lands in the snapshot's
`audios`.
