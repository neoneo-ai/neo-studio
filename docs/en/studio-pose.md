# 3D Pose

The 3D Pose page runs 3d-pose-art's browser pose inside Neo Studio: the page runs three.js in an
iframe, and the host only serves the build, hosts the page and answers the bridge. Posing, the
timeline and the export all happen in the browser - the local service only reads and writes files.

## The pose package

The build has two landing paths, checked per request in this order, and **the data-root copy shadows
the bundled copy file for file** (which is why a fresh build and a user-imported figure win):

| Landing path | Contents | Where it comes from |
|--------------|----------|---------------------|
| `<data root>/pose/dist/` | Full build, `*.map` included, about 16 MB | `tools\sync_pose_dist.ps1` |
| `studio/pose_dist/` | Minimal licensed copy, code + the CC0 figure, 3.9 MB | `tools\build_pose_package.ps1`, ships with the Registry package and the exe |

What goes into the bundled copy is decided by **licence**, not by size: `models/ATTRIBUTION.md` marks
only `ybot.glb` (CC0, PixelMannen's Y Bot) as freely redistributable, so it is the only GLB that ships.
Mixamo (`soldier` / `ch38` / `ch07`) and the SMPL-derived bodies (`body1391` plus three thumbnails) are
personal-use only under their own terms, and the prop GLBs are unlicensed - none of them ship. The prop
registry `models/props/index.json` has its `props` array emptied: listing a GLB the package does not ship
means shipping a control that can only fail, so emptying the registry and emptying the files is one act,
and the procedural props stay available. `*.map` (4.4 MB) stays out: the build carries a single
`sourceMappingURL` and browsers fetch it only with devtools open, so shipping it only makes every user
download 4.4 MB more. The package also carries `LICENSE`, `THIRD-PARTY.md` (the upstream licence banners
terser deleted are restated there) and `MANIFEST.json` (`bytes` + `sha256` per file). Absolute
development-machine paths baked into the build (the figure registry's `sourceImage`) are scrubbed at
packaging time.

```
pwsh tools\build_pose_package.ps1                                       # take the ready build from <data root>/pose/dist
pwsh tools\build_pose_package.ps1 -Source <3d-pose-art repo root> -Build # npm run build first
pwsh tools\test_pose_package.ps1                                        # re-check the shipped package: manifest hashes, size cap, forbidden shapes
pwsh tools\sync_pose_dist.ps1 -Source <3d-pose-art repo root>           # full build into the data root (the preferred level)
```

`robocopy /MIR` mirrors `dist/` only, so the scenes and assets the user wrote in
`<data root>/pose/scenes/` and `pose/refs/` stay out of the mirror - and so do the GLBs the panel's
"Import Own Character" wrote into `pose/dist/models/`, which the source build does not contain: the sync
script parks those "files the source does not have" in a temporary directory and moves them back after
mirroring, so reinstalling the pose package never silently deletes an imported figure. `LICENSE` /
`NOTICE` from the source repo root land in the package next to the build (the pose package is MIT work,
so an installed copy must carry its license text and attribution). Reloading the page is enough after a
sync: the installed check runs per request, so the window does not need a restart.

## Page and static prefix

| Method | Route               | Purpose                                                             |
|--------|---------------------|---------------------------------------------------------------------|
| GET    | `/neo-pose`         | Short path: 302 to the entry page when installed, 404 with the install hint when not |
| GET    | `/pose-dist/{path}` | Package subresources (`index.html`, `assets/**`, GLB, wasm)          |
| GET    | `/models/{path}`    | The origin-root path baked into the build: the prop registry and the GLBs |

The build uses `base: './'` relative imports, so the page must sit on a URL with directory depth:
only then does `./assets/x.js` resolve to `/pose-dist/assets/x.js`. Serving the page directly at the
root-level `/neo-pose` makes every subresource resolve to `/assets/*`, and the pose page cannot even
load its own modules - hence the short path is a redirect. The prefix stays out of the `/neo`
namespace (the capability table lists `/neo` routes one by one) and out of `/extensions` (the desktop
middleware stamps the whole `/extensions` tree `no-store`, which would re-send the hashed wasm on
every reload). Files in `assets/` carry a content hash and get `immutable` caching; unhashed entries
are revalidated every time. The prefix itself (`/pose-dist/`, an empty path) lands on the entry page:
typing the prefix in the address bar opens the page, the same directory convention a static server
uses. Files are looked up through both landing paths (data root, then the bundled copy), and both are
checked by `inside_dir`, so "running on the bundled copy" and "running on the data-root build" look
exactly the same in the URLs.

`.wasm` is forced to `application/wasm`: Windows reads `mimetypes` from the registry, and with
`application/octet-stream` `WebAssembly.instantiateStreaming` refuses the bytes, Draco cannot decode
the GLB, and the pose page never loads a figure.

The GLB files and registries under `dist/models/` are copied verbatim from `public/`, and the page
builds their addresses from its own directory (`src/core/appBase.js`): a root deployment resolves to
`/`, a host prefix resolves to `/pose-dist/`. vite's `base: './'` only rewrites build-time module
references, never runtime strings - a hardcoded `/models/ybot.glb` under a prefix hits the site root,
every figure 404s, and the viewport shows nothing but the procedural skeleton. An installed package
therefore has to sit in the whole directory under `/pose-dist/`; keeping only `assets/` is not enough.

The host answers both prefixes: `appBase.js` looks at the first URL segment, so a page under
`pose-dist` takes `/pose-dist/models/` and any other page takes the origin-root `/models/`. The prop
registry and the GLBs therefore live on one static handler mounted under two names, with the same
two-level lookup and the same in-root check. A host that mounts only `/pose-dist` answers
`/models/props/index.json` with a 404, the page reads the registry as empty, and every "add prop" and
GLB body reports failure while the page itself works - an empty registry is a missing host prefix, not
a user problem.

ComfyUI itself owns `/models` (the model-type list) and the single-segment `/models/<name>` (the file
list of one model type), so on the plugin host a single-segment path is ComfyUI's and only the
path-with-a-directory form - the registry and the props - reaches the pose handler. A page served under
`/pose-dist/` takes the prefix form on both hosts and never hits that ordering question.

## Bridge routes

| Method   | Route                      | Purpose                                                                                        |
|----------|----------------------------|------------------------------------------------------------------------------------------------|
| GET      | `/neo_pose/status`         | Install state, which landing path is live, the shipped manifest, the GLBs present, capability flags, saved scenes and poses, bridge names, missing-package hint |
| GET      | `/neo_pose/scenes`         | Scene list (`name` / `size` / `mtime`, newest first)                                           |
| GET      | `/neo_pose/scene?name=`    | Read one scene                                                                                 |
| POST     | `/neo_pose/scene`          | Write a scene (`{name, scene}`, `.tmp` + replace, atomic)                                      |
| GET      | `/neo_pose/presets`        | Pose library list (`name` / `size` / `mtime`, newest first)                                    |
| GET      | `/neo_pose/preset?name=`   | Read one pose (PoseFile v1 returned verbatim)                                                  |
| POST     | `/neo_pose/preset`         | Write a pose (`{name, pose}`, `.tmp` + replace, atomic)                                        |
| POST     | `/neo_pose/preset/delete`  | Delete one pose (single item, same name whitelist)                                             |
| POST     | `/neo_pose/import_image`   | Hand one library asset to the page (`{filename, subfolder, type}`)                             |
| POST     | `/neo_pose/import_model`   | Write an own-figure GLB to `pose/dist/models/<key>.glb`                                        |
| GET      | `/neo_pose/refs/{name}`    | Serve that reference image back to the page (same-origin)                                      |
| POST     | `/neo_pose/export_image`   | Store the page canvas (`{data: dataURL, name}`) into the library                               |
| POST     | `/neo_pose/export_set`     | Store a ControlNet set (`{files: [{name, data}]}`, ≤12) into the library                       |

What `/neo_pose/status` reports about the landing paths and the shipped copy: `installed` (an entry page
in either level), `dist_dir` and `dist_source` (the live level - `data_root` or `package`),
`package_installed` and `package_dir`, `models_present` (the GLB file names present across both levels),
and `manifest_version` / `manifest_built` / `manifest_files` / `manifest_bytes` (the contents of the
shipped `MANIFEST.json`; empty and zero when there is no manifest).

`/neo_pose/import_model` takes `{key, data}` (a base64 GLB) or `{key, filename, subfolder, type}` (a
library file, resolved through Gallery's own resolver). All four checks run before anything is written:
the `key` goes through the scene-name whitelist, exactly one source must be given, the byte count must
stay under 35 MB (what still fits the 48 MB request-body cap once base64 is packed into JSON), and
the file header must be `glTF`. The only landing path is
`<data root>/pose/dist/models/<key>.glb` (written `.tmp` + replace; importing the same key replaces that
figure and never creates a second key), and the reply is `{key, name, url, size, from}`. The panel's
"Import Own Character" uses the local file picker - the library list only shows images, so a Mixamo
download comes in through the picker. Registering the figure stays page-side (the pose page's own local
import area keys it); the host only tells the user the key.

Page and scene names go through a whitelist: an alphanumeric first character, at most 64 characters,
only `A-Za-z0-9_.-`. The figure key goes through the same one (the file name is `<key>.glb`).
Subresource paths resolve symlinks and are forced inside one of the two landing paths; a URL
with `..`, a drive letter or an absolute path is `400`. Pose file names are
`<data root>/pose/presets/<name>.pose.json`, through the same whitelist. Exported images land in
`output/Pose` - a subfolder of the normal output directory, the same place the library browses any other
output. A single image is de-duplicated and replies `{filename, subfolder, size}` with `subfolder` set to
`Pose`, and a set is validated file by file before any file is written, replying `{saved, count}` - one
invalid file writes nothing at all. Thumbnails, full-size previews, drag-into-node and the "⋯ → Delete"
action all resolve through that same relative `Pose` subfolder, and the panel's export toast names it.

Scenes go to `<data root>/pose/scenes/<name>.json`, the pose library to `<data root>/pose/presets/`,
reference copies to `<data root>/pose/refs/`, and imported figures to `<data root>/pose/dist/models/`;
none of the four survives as part of what `tools\sync_pose_dist.ps1` mirrors (the script parks the files
the source build does not have and moves them back), so reinstalling the package leaves them alone.

All thirteen routes only read and write files, so the offline desktop service answers every one of them
(`_POSE` in `app/studio_caps.py`). `/pose-dist` is a static prefix each host registers directly and
is not a capability-table entry.
## Host view and message directions

The desktop top bar's Pose tab and the home card "3D Pose" open `#/pose`; the host module is
`studio/web/pose/pose.js`. The host panel has five groups: Pose (import an asset, canvas snapshot),
Pose library (save, apply, delete), Scene (write a name and save, pick one and load), ControlNet export
(tick the formats, export the set) and Canvas state (one read-only line);
the character row carries
"Import Own Character" with a key field, and the bottom of the left column explains that only the CC0
figure ships when the page runs on the bundled copy. Every control stays disabled
until `pose:ready`, and the panel appears with it; the bridge is torn down with `pose:dispose`, so
leaving the page leaves no listener behind.

The preset and the pose library apply in one click: changing the preset dropdown sends `preset/apply`,
and clicking a library entry reads that file back and sends `pose/apply` (the Load Pose button is kept
for a typed-in name), so the panel no longer has an "Apply Preset" step.

The panel has no 摆姿模式 / 吸附 / 轮廓线 / 主体层 checkboxes: posing starts by clicking the figure, which
makes the page enter pose mode on its own and leave it on an empty-space click, the page starts with snap
and outline off, and the figure stays visible - so the canvas state line mirrors only the character, its
count and the prop count. The ControlNet set is untouched by this: the line-art pass turns the outline
shells on and off inside the export itself. The two looks come from the page (studio grey / dark), and the
page opens grey, so once `meta/list` lands the panel puts the appearance on 暗色 and sends `look/set`; a
pose package whose list has no dark look is left alone. The shipped package's dark look draws a readable floor
grid: its grid lines are `0x6d7786` fully opaque, because the desktop window renders at `devicePixelRatio` 1, where
a 1px line is anti-aliased to about half coverage, so the colour carries the contrast and both hosts show the
same floor.

"Import Own Character" does not depend on the page's command layer (it calls the host's own
`/neo_pose/import_model`), so it stays clickable on an old package (`caps.hostUi` false, the panel
disabled wholesale) - what it imports is a file, not a page action.

The page's own six-row toolbar is `fixed` over the canvas, and in a short window it covers exactly the
viewport posing needs: the bottom-left "面板：展开" button and the `T` key collapse it down to its first
row (the row height is measured at runtime, because wrapping makes the first row depend on the width),
and the state is stored in the page's own localStorage - nothing to do with the host toolbar.

| Message             | Direction   | Payload                   | Purpose                                                |
|---------------------|-------------|---------------------------|--------------------------------------------------------|
| `pose:ready`        | page → host | none                      | The page finished setup; the host replies `pose:theme` |
| `pose:theme`        | host → page | `{caps, lang}`            | Capability flags and language: greys out unavailable controls |
| `neo:import-image`  | host → page | `{url, name}`             | The asset picked in the library                        |
| `pose:export-image` | host → page | reply port `{data, name}` | Ask for the canvas; the page answers with a dataURL    |
| `pose:save-scene`   | host → page | reply port `{name, scene}` | Ask for the scene; the page answers with scene JSON    |
| `pose:open-scene`   | host → page | `{scene}`                 | Put a stored scene back into the page                  |
| `pose:call`         | host → page | `{action, args}` + reply port `{ok, data}` | A panel action runs one of the page's own commands |
| `pose:state`        | page → host | `{state}`                 | Canvas state snapshot, shown on the state line            |

Request messages carry a `MessageChannel` reply port, so one request's reply only arrives on that
port; inbound notifications are accepted only from this iframe (`event.source`) and from the host's
own origin, and any message name outside the list is dropped. The iframe sandbox is
`allow-scripts allow-same-origin allow-downloads` - no `allow-popups`, `allow-forms` or
`allow-top-navigation`.

The page-side bridge is `src/neoBridge.js` in the pose repository: it exists only when the page really
runs inside the same-origin iframe, and a standalone deployment (`npm run dev`, a static site) attaches
no listener at all. The bridge adds no capability of its own - it reuses three paths the page already
has: whole-scene serialization (save), the clean snapshot (joints, gizmo and the reference-plane layer
are hidden before the canvas is read, the same code the Download screenshot button uses), and the
reference-plane add (import an asset), and the page's own commands (apply a pose, the ControlNet render,
the canvas snapshot) - which is what the panel's `pose:call` runs. When serialization fails the page
stays silent on the reply port so the host times out with "the pose page did not answer" - it never
hands the host an error object for the host to write into its scenes directory as a scene. The contract
and the failure paths are in the pose repository's `docs/neo-studio-bridge.md`.

The prop row is a dropdown plus a name box. The dropdown shows the Chinese prop name, while the value sent
to the page has to be the propKey the page understands (`builtin:chair` for a procedural prop,
`glb:<file>` for a registry one); the name box takes a typed name and the host resolves it against the prop
list `meta/list` sends down - the Chinese names (椅子 / 凳子 / 桌子 / 木箱 / 木桶 / 大球 / 小球 / 圆柱 / 斜坡 /
单杠 / 台座 / 垫子 / 剑 / 短剑 / 长矛 / 弓 / 盾, plus every registry label), a bare id (`chair`,
`arrow.glb`, `arrow`) and the full key all land on the same entry, and a full-width bracket suffix in a
label (细剑（Sting）) resolves by the name in front of it. When the name is not on that list the panel says
plainly that the prop table has no such prop, reports what can be typed and how many entries there are, and
sends no `pose:call` - the prop definitions live in one place, inside the pose package, and the host does
not guess them.

## What the desktop does not offer

In `/neo_pose/status`, the flags `photo3d`, `mesh`, `pano` and `lib_write` are always
`false`: photo point estimation, mesh generation, pano and library writes need 3d-pose-art's Python
sidecar (`pose_server.py`), which the desktop process does not start. The page greys those controls out
and the host exposes no route for them. Those panels already degrade through their own service probes
(`/__pose3d/ping`, `/__pose-lib/ping`): the endpoints exist only in vite dev/preview, so on a statically
served host the probes fail and the panels disable themselves with the project's existing "the answer is
not the estimation service" rule. `caps` is the host confirming that same state, not a second switch.

`body_import` is `true`, and it is the host's own path: only the licence-clean CC0 figure ships, the rest
are figures the user supplies, written into the data root through `/neo_pose/import_model` and registered
in the page's own local import area by key - neither the write nor the registration needs the sidecar.
The page's built-in figure registry lists six GLB figures while the package ships one, so on the bundled
copy the other entries cannot fetch their file; that is why the left column says plainly which level the
page is running on, instead of leaving people to think the figure list is broken.

`hostUi` is `true`: the host ships its own panel (import an asset, the pose library, scenes, ControlNet
export, the canvas state line) and sends it down with `pose:theme`, so the page folds away the demo
toolbar meant for standalone runs - only one set of controls is ever on screen. That chrome is hidden
before the page's first paint as well: the entry page's inline head script sets `data-host-ui` whenever
it runs inside an iframe (the same `parent !== window` predicate the bridge uses), so opening Pose no
longer shows the standalone 3d-pose-art editor for a moment and then swaps to the host layout. The
old-package fallback lives on the host: when `caps.hostUi` is not `true` the panel is disabled with a
notice to re-run `tools\sync_pose_dist.ps1`, so no button is left standing there only to idle.

## Not installed

When neither landing path has an `index.html` (no data-root sync, and `studio/pose_dist` deleted):
`/neo-pose` answers 404 with the install hint, `/neo_pose/status` reports `installed: false` with
`dist_source: ""`, and the host shows "3D Pose is not installed" with both install routes
(`tools\sync_pose_dist.ps1` for the full build, the bundled `studio/pose_dist`) and a Check again
button - no iframe, no toolbar.

When the page opens and the figure list is fine but every "add prop" fails, that is not a missing
install: the registry request (`/models/props/index.json`) came back 404 on the host, so the page read
the registry as empty. Check that path's status code in the browser's Network panel, and read
`dist_source` from `/neo_pose/status` to see which landing path is live. The bundled copy carries no
props by design (the licence rule), so props need the full build via `tools\sync_pose_dist.ps1`.

## Tests

- `studio/tests/test_pose_bridge.py`: path containment, the scene-name whitelist, wasm MIME,
  hashed/unhashed caching, atomic scene and pose writes, the pose round trip, preset deletion, the
  reference copy with its page-side result, exporting one image and a ControlNet set into the library,
  the set that is refused whole with nothing left on disk, the short-path redirect; both landing paths
  (the bundled copy as fallback, the data root shadowing same-named files, the hint when both are
  missing), the prop-registry prefix resolving in both levels, the shipped manifest inside `status`,
  the imported-figure landing path with its five checks (key / source / size / header / library size),
  the library-source resolution, and refused requests leaving no trace.
- `app/tests/test_studio_server.py::PoseBridgeTests`: the redirect, serving subresources offline and
  refusing to escape the package, the `/models` prefix answering the registry and the prop GLBs
  (including the imported figure and the data root shadowing the bundled copy), the scene round trip,
  the pose round trip, the flags and route ownership (checked against the pose module's own route
  table, one by one), the bundled-copy fallback level, importing an own figure offline with the 35 MB
  cap, and the request-body cap sitting above that route.
- `studio/tests/js/pose-bridge.test.mjs`: the host's not-installed form, the iframe attributes, the
  bridge's source and origin checks, the hostUi gating, the import / export / pose-apply / scene /
  set-export paths, the routes each message reaches, the note shown on the bundled copy, and importing
  an own figure (the base64 upload and the key checks).
- `tools\test_pose_package.ps1`: the shipped package's own self-check - required files, build shape,
  forbidden shapes (`*.map`, GLBs outside the whitelist, prop GLBs, loose JSON), per-file sha256 and
  byte verification, an empty prop registry, development-machine absolute paths, and the size cap.
- The page-side bridge in the pose repository: `tests/neoBridge.node.test.mjs` (when the bridge exists,
  the source and origin gates, the reply-port answers, and how a failure is voiced).
- The deployment root in the pose repository: `tests/appBase.node.test.mjs` (a root deployment stays
  byte-for-byte identical, a prefix deployment folds asset URLs into the prefix), plus the browser suite
  checks "the default figure GLB is fetched through the deployment root" and "collapsing the toolbar
  keeps only its first row".

The pose package's own implementation and page copy live in the 3d-pose-art repository (MIT); this
repository only serves its build and provides the bridge, without forking its source.

