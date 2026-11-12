# Image Reverse Prompt

> 🇨🇳 中文: [../studio-reverse.md](../studio-reverse.md)

The "图片反推" card in the **Edit** section of the Studio home opens `#/reverse`
(`studio/web/reverse-prompt/reverse-prompt.js`). The top bar has no tab for it: that home card is the only way in, and
hiding the card in the home editor closes the page off. Reverse prompting runs through the same endpoint the asset
card's ⋯ menu uses (`POST /rs_prompts/reverse_prompt`, `studio/llm.py`); the page only picks an image, puts the text
on screen, and copies it.

## The path

1. **Pick an image**: `从素材库选图` opens the library modal, and clicking a card drops it onto the reference slot.
   This modal only accepts images (`accept: "image"`) — clicking a video or audio card opens the lightbox instead.
   `换图` opens the same modal.
2. **Pick the output language**: the `中文` / `英文` chips in the result header set the `language` of the next request
   (the backend takes `zh` / `en`); switching languages does not touch the run in flight.
3. **Reverse-prompt**: the text lands in the result box piece by piece — the backend streams it token by token over
   SSE and writes the finished prompt into the `.txt` next to the image, visible when browsing the library, exactly
   the same landing spot as the card's own reverse prompt.
4. **Copy the prompt**: `复制提示词` writes the result box text to the clipboard; with an empty box it only says
   "还没有可复制的提示词" and writes nothing.

Changing the image or running again invalidates the stream in flight: text from the previous image never lands in the
new box. When the backend writes a failure into the stream (a `[ERROR]` frame), the status line shows the backend's
own reason — the result box never passes a half-finished run off as success.

## Offline

Reverse prompting needs the kernel-side LLM chain and image reading, so in the desktop window with ComfyUI not running
the 反推 button reads "需要 ComfyUI"; clicking it hands the desktop app the job of starting the kernel instead of
sending a request that can only answer 409 (`app/studio_caps.py`, the `prompt_reverse` flag).
