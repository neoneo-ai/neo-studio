# Canvas

Images and prompts, laid out on one canvas. The canvas page puts image nodes, prompt nodes and generation nodes on the same zoomable, pannable board; the connections between nodes decide which prompts and reference images a run carries, and where the finished images land. The page lives in `studio/web/studio/pages/canvas/` (`page.js` is the page, with `geometry.js` / `nodes.js` / `interactions.js` / `store.js` / `history.js` / `gen.js` under it), and one canvas's nodes and connections land in `canvas/<canvas id>.json` under the data root.

## Where this page is

- The `canvas` view of the Studio shell: the same path in the desktop window and in the plugin page (`createCanvasPage` in `studio/web/studio/studio-app.js`). "Place on canvas" in the material library and the gallery sends the picked assets here and lays them out as image nodes on a non-overlapping grid.
- The desktop window opens this page with no ComfyUI runtime: all five `/neo_canvas/*` routes are in the canvas group of `app/studio_caps.py`, and reading and writing a canvas is a pure file layer. The generation run needs the execution queue, so pressing 出图 offline starts ComfyUI for the user and says "Generation needs the ComfyUI queue - it is starting, press again once it is up" instead of locking the button.

## The toolbar

The toolbar is one row that never wraps: every control is an icon button, its name in the tooltip and its `aria-label`,
and the keyboard chord in the tooltip of the ones that have a shortcut. When the window is narrower than the row, the
bar scrolls sideways inside itself (no scrollbar shown) instead of dropping to a second row. A thin divider separates
the three groups.

- **Canvas group**: the canvas drop-down (switch the current canvas) plus the 新建画布 / 重命名 / 删除画布 icon buttons. Deleting a canvas asks for confirmation and takes `canvas/<canvas id>.json` with it.
- **Nodes and clipboard group**: the 加图片 / 加提示词 / 加生成节点 icon buttons, then 复制选中 (Ctrl+D), 剪切选中 (Ctrl+X), 复制 (Ctrl+C), 粘贴 (Ctrl+V), 撤销 (Ctrl+Z) and 重做 (Ctrl+Shift+Z or Ctrl+Y). With nothing to undo or redo those two sit greyed, and a greyed one stays greyed under the pointer.
- **View group**: zoom out / the current percentage / zoom in, then after a divider 适应内容 and 背景 (the dots / fine lines / blank cycle), and at the far right the save status slot (未保存 / {seconds} 秒后保存 / 已保存 / 保存失败 / 离线).

## Nodes

| Node             | What this one is                                                                                                                                                                                                                           |
| ---              | ---                                                                                                                                                                                                                                        |
| Prompt node      | One block of text; the words live in `metadata.content`, and a line into a generation node contributes its text to that run in connection order.                                                                                           |
| Image node       | One image, positioned by the library's `filename` + `subfolder`, shown with the Gallery thumbnail and a placeholder when it cannot be read. Dragging a material card from the library onto the canvas lands an image node too.             |
| Generation node  | A card covered in its own controls (next section). It carries no prompt of its own: prompts and reference images come in through the lines connected to it.                                                                                |
| Hero image       | An image node recorded as `metadata.hero` carries the 「主图」 badge at its top-left; switch it from the bar that floats out when the node is selected.                                                                                        |
| Node actions bar | Floats at the top-right while the node is selected: an empty image node gains 选图 (open the library and take one), image nodes have 设为主图, and every node has 复制节点 and 删除节点. Deleting takes the node together with the lines attached to it. |

Connections live on the two points at the node's left and right: start at the right point and drag onto another node and that is a connection; releasing on empty ground says "A connection has to land on a node". The four corner handles change this node's width and height, and the arrow keys nudge the selected nodes by 8px (40px with Shift), every step undoable.

## The card on a generation node

| Control           | What it does                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---               | ---                                                                                                                                                                                                                                                                                                                                                                                                           |
| Skill chip        | One chip with an icon and the skill name, sized to its content; opening it switches to another entry of the image-generation skill list from the skills page, and a freshly laid node defaults to the last one used. The 主模型 line on the card reads that skill's config: the model name when it can be read, 「主模型：跟随技能配置」 when it cannot.                                                                     |
| The parameter row | Ratio, long edge and count share one row, one chip each, each chip's meaning in its tooltip. Ratio and long edge default to following the skill config and the global generation settings - the chip then reads 「默认比例」 / 「长边尺寸」 - and an override shows the value in force; the ratio chip's icon is that ratio's shape. The count chip opens a pick from 1 to 8 (the backend eats at most 8 images per run). |
| 出图                | The primary button owning the last row: a filled primary block across it. While the run is going it settles to a soft fill, with its position and width unchanged.                                                                                                                                                                                                                                            |
| 取消任务              | Only appears while this run is queued or running; pressing it hands the dequeue to the backend and the node drops back out of the running state.                                                                                                                                                                                                                                                              |
| The status line   | "Queued" and "Generating {done}/{total}" follow that run's backend progress; when it fails the line carries the reason and the card turns red.                                                                                                                                                                                                                                                                |

- Every control writes into the node's `metadata` on the spot: undoable, travelling with a copied node and saving with the canvas. Starting a drag on the control area does not drag the node.
- The chip menus float on the page layer (`.ns-canvas-gen-menus`), not inside the node: the world layer carries a scale and nodes clip their own content, so putting a menu into either of those layers loses on both sides.
- The generation request carries the upstream prompts and reference images in connection order. With no usable line it says "Run a text or image line into this node first"; when that skill takes no text prompt it names the skill and asks for a reference image.
- Finished images fill the downstream empty image nodes in connection order; the leftovers create image nodes on the right, connected to this generation node, and one undo takes back every image this run laid down.
- Switching canvases or removing the source node detaches the run: the results do not write the old canvas, the page only says "The images are saved in the Output folder".
- A skill missing its API key says so and opens Skill Management to fill it; a failed submission reports "Generation failed", a finished one reports "Generated {n} images".

## Gestures and keys

| Gesture / key                         | What it does                                                                                                                                                         |
| ---                                   | ---                                                                                                                                                                  |
| Wheel                                 | Zooms this board around the pointer                                                                                                                                  |
| Middle button / Space / Ctrl on empty | Pans the board (Space and Ctrl are the temporary grab hand)                                                                                                          |
| Drag from empty ground                | Pans this board; a press that never moved is a click on empty ground and it drops the selection on release                                                           |
| Shift + drag from empty ground        | Marquee select: the nodes the dragged box covers join the selection as of the press                                                                                  |
| Delete / Backspace                    | Deletes the selected nodes and the lines attached to them                                                                                                            |
| Esc                                   | Drops the selection; with the caret inside a text body it pulls the caret out of the body first                                                                      |
| Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y)        | Undo / redo                                                                                                                                                          |
| Ctrl+D                                | Duplicates the selected nodes                                                                                                                                        |
| Ctrl+C / Ctrl+X / Ctrl+V              | Copy / cut / paste nodes; with the caret inside a text body those four keys belong to the browser's own text actions, and the page says how to get back to the nodes |
| Ctrl+A                                | Selects every node                                                                                                                                                   |

The tooltips of 撤销, 重做, 复制选中, 剪切选中, 复制 and 粘贴 in the toolbar carry these shortcuts, while each `aria-label` stays a clean name.

## Undo and saving

Undo and redo are two stacks in `pages/canvas/history.js`: the stacks record only nodes and connections, never the viewport or the background; the depth is capped at 60, and switching or creating a canvas clears them. One drag and one stretch of typing count as a single change, so one undo takes back the whole stretch.

Changes accumulate in this page's memory and land on disk 900ms after the last one, viewport and background included; leaving the page saves first. The indicator at the right end of the toolbar is whether this one landed. `canvas/index.json` is a list cache - delete it and the list is rebuilt from the canvas files; deletion only exists as the single-item route the UI offers, and nothing clears the whole `canvas/` folder.

## `/neo_canvas/*`

| Method | Route                 | What it does                                                   |
| ---    | ---                   | ---                                                            |
| GET    | `/neo_canvas/list`    | The canvas list (the index plus canvas files the index missed) |
| GET    | `/neo_canvas/project` | One canvas's nodes and connections (`?id=`)                    |
| POST   | `/neo_canvas/project` | Saves one canvas: the write layer refuses an unfinished JSON   |
| POST   | `/neo_canvas/rename`  | Changes the title                                              |
| POST   | `/neo_canvas/delete`  | Deletes one canvas                                             |

The backend is `studio/canvas.py`: writes go through a temporary file swap under one lock for concurrency, and the offline desktop service answers the same group of routes, so the plugin and the offline window write the same file.

