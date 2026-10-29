# Video Frame Extraction

> 🇨🇳 中文: [../studio-frames.md](../studio-frames.md)

The "视频抽帧" card on the Studio home opens `#/frames` (`studio/web/frames/frames.js`). It stands on its own,
separate from the Pose page and the library: extraction happens in the browser — the player seeks to each
timestamp, the canvas draws that frame, and the PNG is handed to the local service one at a time. The local
service only does the two file-layer jobs (`studio/frames.py`), and the desktop service answers them offline too.

## Using the page

1. **Pick a video**: `从素材库选视频` opens the library modal and a clicked card swaps into the player;
   `本机视频` uses the browser's own file picker and never uploads. A non-video (image, audio) is rejected with
   its file name reported.
2. **Set the start point**: press and drag the progress bar — the yellow line follows the pointer, and the
   second you land on is where extraction starts; releasing the pointer settles it. `跳到首帧` / `跳到末帧`
   move it to the clip's first or last frame, and `起点（秒）` also takes a number.
3. **Extract**: `帧数` and `间隔（毫秒）` decide which timestamps after the start point get queued; a timestamp
   past the end of the clip is not queued, and a start point beyond the clip is reported as "起点越过片尾了"
   rather than extracted as repeated last frames. A run is capped at 50 frames.
4. **Save into the library**: extracted frames live only in the page; each card saves one frame, or
   `全部存进素材库` saves them in a row. A saved card reports "已存" and does not send it again.

## Where the frames land

`<ComfyUI output directory>/Frames/`, which is the `Frames` subfolder the library shows when browsing `output`
(the asset's `subfolder="Frames"`). Frame names carry their timestamp: `frame-00_07_125.png` (`mm:ss.mmm`, with
the colon replaced by underscores because Windows file names do not take colons). A duplicate gets `_1` appended:
two frames inside the same second do not overwrite each other when the gap is under one second.

The directory is created by `studio/gallery.py` at load time; the plugin and the desktop app share that landing
path, so a frame looks exactly like ComfyUI's own output entries in the UI.

## `/neo_frames/*`

| Method  | Route                   | Description                                                                                             |
|---------|-------------------------|---------------------------------------------------------------------------------------------------------|
| GET     | `/neo_frames/video`     | Range response for that library video: same asset lookup as the library, so seeking lands, non-video 400|
| POST    | `/neo_frames/save`      | Writes one PNG frame into `Frames`, replies `{filename, subfolder, size}`, one request per frame        |

The video must come back as a range response: the library's `/neo_gallery/video` reads the whole file into
memory, and a browser without range support only streams forward, so seeking lands at the beginning and every
extracted frame is the first one. A frame run seeks repeatedly, so this route also sends `Cache-Control` so the
ranges can be reused.

Controls stay locked while extracting and saving: seeking is a chain of async events, and clicking twice would
queue the player behind the timestamps, which reads as "clicked Extract but nothing happened". Saves go one at a
time: a batch would push the whole run against the 48 MB request-body limit, and what the user wants is usually
one of those frames — saving in a row never leaves a half-saved run.

One path for both hosts: the desktop window extracts and saves frames with no ComfyUI runtime (the frames group
in `app/studio_caps.py`).
