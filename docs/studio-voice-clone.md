# 声音克隆

Studio 首页「开始创作」板块的卡片「声音克隆」进 `#/voice`（`studio/web/voice-clone/voice-clone.js`）。
顶栏没有这一枚页签：首页那张卡是这页唯一的来路。生成链与音频卡片 ⋯ 菜单的「生成语音」是同一条
（`voice-gen.js` 打 `/neo_voice/*`，进度认 `rs.voice_gen.status` 事件，不轮询 HTTP），波形控件也是那一份
（`gallery-card-tools.js` 导出的 `voiceAudioWidget`）。

## 用这条路径

1. **挑一段参考音频**：`从素材库选音频` 开素材库弹窗，点一张音频卡片落上参考波形；这一扇弹窗只放行音频
   （`accept: "audio"`），图片与视频点它是开灯箱浏览。文字框在这一步预填语音技能 `config.json` 的
   `default_prompt`，用户写过的字不会被覆盖。
2. **写要说的文字**：文字为空时点生成只报「请先输入要说的文字」，不发请求。
3. **生成**：参考音频经 `/neo_gallery/copy_to_input` 落进 `input/` 当 `{{REF_AUDIO_1}}`，文字走
   `{{PROMPT}}`，技能是 `cosyvoice_voice`，产物由 SaveAudio 落 `Output/Voice`。页上给「排队中…」与
   「合成中…」两句读数，进度条按后端推的快照填；没有步数的那一段（排队、模型加载）条自己走。
4. **取消任务**：`取消任务` 发 `POST /neo_voice/cancel/<task_id>`，并把这一发落成「已取消」——晚到的
   成功事件不把它读成成功。
5. **试听与取件**：成功后结果区是一条可播放的波形；`打开输出目录` 把素材库切到 `Voice` 目录。

换音频会重拷一份参考：`copy_to_input` 那份名字跟着换，上一段音频的影子不留在页上（参考波形与上一发的
结果波形一起收掉）。窗口收起时这一页的播放器停掉，任务本身在执行队列里跑完。

## 离线形态

语音生成要吃 ComfyUI 的执行队列，桌面端窗口在 ComfyUI 未就绪时把「生成」写成「需要 ComfyUI」，
点它交桌面端拉起内核，不发一条注定 409 的请求（`app/studio_caps.py` 的 `voice` 一位）。
