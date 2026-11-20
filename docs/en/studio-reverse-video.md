# Video Reverse Prompt

The 视频反推 card in the **Edit** section of the Studio home page opens `#/reverse_video`
(`studio/web/reverse-video/reverse-video.js`). The top bar has no tab for it: that card is the only way in, and
deleting it from the home layout (add it back in the card picker) leaves the page unreachable. The route is
`POST /rs_prompts/reverse_video_prompt` (`studio/llm.py`) — a separate endpoint and a separate landing file
from the 图片反推 page; the two pages share nothing.

## Using it

1. **Pick a video**: `从素材库选视频` opens the media-library modal and a card drops into the player
   (this modal accepts videos only, `accept: "video"`); the player reads the range-served `/neo_frames/video`
   stream, which is what makes seeking land on a frame. `换视频` opens the same modal.
2. **Set the sampling range by dragging**: the time window under the player spans the whole clip by default. Drag
   either handle to set a closed range, the player jumps to the frame under your hand while you drag; the two
   handles never cross, the ends never leave the clip, and `全片` (Whole clip) resets the window to the full video.
   Tab reaches the track: `←` `→` nudge the nearer handle by 0.5 s (`Shift` by 5 s) and `Home` spans the whole clip.
   The 帧数 chips pick how many frames the batch has (1 / 2 / 4 / 6 / 8 / 12), and the ticks on the window mark the
   seconds that batch samples. The page is one centered column, the player sits dead center.
3. **Extract frames**: this happens in the browser, reusing the canvas capture of the 视频抽帧 page
   (`rangeTimes` and `captureFrames` in `studio/web/frames/frames.js`) — N frames spread evenly across the dragged
   window, downscaled to a 768 px side. Each thumbnail in the strip carries the second it was taken at; the batch is
   only shown here, it is never saved into the library.
4. **Pick the output language**: the 中文 / 英文 chips in the result-box header set the `language` of the next
   request (the backend knows `zh` / `en`); switching languages does not touch the run in flight.
5. **Reverse-prompt**: the whole frame batch goes out in one request, each frame with its own timestamp, and the
   text streams into the result box token by token — **the box appears the moment the first text arrives** (no empty
   block on the page before a run, and no frame around the text: it sits directly on the page, in the same single
   centered column as the player); the page has a single scrollbar — the outer page one — and it follows the stream,
   scrolling to the bottom of the text as each piece lands (the text never scrolls inside its own box); the finished
   text is written to
   `<video>.rp.txt` next to the video, visible when browsing the library. The status line (running / done / failed)
   sits outside the box, so it stays readable while the box is collapsed.
6. **Copy the prompt**: `复制提示词` puts the result text on the clipboard; with an empty result it only reports
   that there is nothing to copy and writes nothing.

The timestamp labels are part of the prompt text (`frame 1 at 00:06.900`, 中文 `帧1@00:06.900`): the model reads
camera motion, pacing and order from them, because frames without timestamps are unrelated pictures to it. Nothing
outside the dragged window is described — the text covers only what this stretch shows.

The result lands in `.rp.txt`, never in the same-name `.txt`: that `.txt` is the live-parameter sidecar the
"generate a video from this again" path reads (`_read_sidecar` in `studio/gallery.py`), so writing a reverse-prompt
result there would overwrite the user's generation settings in one shot. Changing the language or the frame count
re-runs the reversal — the backend stores both in the `<video>.rp-lang` marker, and a cached result only matches
when language and frame count both equal the request.

Switching videos invalidates the stream in flight: text from the previous video never lands in this video's result
box, and the frame strip and the box clear together. When the backend reports the failure inside the stream
(`[ERROR]` frame), the status line shows that reason; the result box never passes a half-finished text off as
success. More than 12 frames in one request is refused by the backend on the spot (`REVERSE_VIDEO_MAX_FRAMES`),
and the frame-count chips stop at that number.

The page starts as that one card: the language chips and the copy button live inside the result box, and there is
no box on the page before a result. Once a video is picked, the player, the time window and the frame strip sit
directly on the page, the result text lands with no frame around it, all in one centered column.

## Offline mode

The reverse chain is registered on `studio/llm.py`'s routes, so the offline desktop window serves this shot itself (the
`prompt_reverse_video` entry in `app/studio_caps.py`): the video is located by the gallery media finder and the finished
text is written to `<video>.rp.txt` — LLM chain plus filesystem, the execution queue is never touched. Frame extraction
also runs in the browser, so the whole page works with the kernel down. The only prerequisite is a configured LLM; the
native engine takes only the first frame, so a multi-frame shot is refused on the spot (see [llm.md](llm.md)).

## Agent and MCP

MCP exposes the image path only (`reverse_prompt`, `studio/mcp_server.py`). Video reversal needs the frame batch
captured from a player in the browser; MCP has no player, so it exposes no tool that could only receive empty frames.
