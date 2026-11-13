# Documentation Index

> 🇨🇳 中文: [../README.md](../README.md)

This directory splits the plugin documentation by major module. The entry points remain the root
[README.md](../../README.md) (end users) and [Developer_EN.md](../../Developer_EN.md) (developers).

**Downloads in China**: the integration pack and the models are on Quark Pan →
[https://pan.quark.cn/s/4028d4e655e3](https://pan.quark.cn/s/4028d4e655e3).

## Feature modules (end users)

| Document | Contents |
|------|------|
| [prompts.md](prompts.md) | Prompt nodes, UI buttons, image reverse-prompting, `@` / `/` menus |
| [skills.md](skills.md) | Skill management: skill files, manager window, workflow-area editing, canvas import and write-back |
| [llm.md](llm.md) | LLM modes, cloud providers, local GGUF installation, model directory conventions |
| [image-gen.md](image-gen.md) | Image generation: chat generation, the Image Gen & Edit node, sizes and outpainting |
| [preset-models.md](preset-models.md) | Preset model inventory: the `models.json` manifest of all 38 preset skills (files, folders, sizes, sources) |
| [h3-video-gen.md](h3-video-gen.md) | Video generation: director recipe execution, single-segment regeneration, grid split, templates |
| [recipes.md](recipes.md) | Recipes: saving, sending to the workflow, the director recipe editor |
| [gallery.md](gallery.md) | Asset library: browsing, lightbox, file management, Civitai LORA, bookmarks |
| [studio-frames.md](studio-frames.md) | Video frame extraction: the player, the start point and gap, frames landing in `output/Frames` |
| [studio-reverse.md](studio-reverse.md) | Image reverse prompt: a home-card-only page, SSE output onto the page, the `.txt` landing spot and copy |
| [studio-voice-clone.md](studio-voice-clone.md) | Voice clone: reference audio plus text, progress and cancel, the result waveform |
| [workflow-repair.md](workflow-repair.md) | Workflow model-path repair |
| [model-hub.md](model-hub.md) | Model hub: Comfy-Org curated section, dual-source search, resumable downloads |
| [studio-pose.md](studio-pose.md) | 3D Pose: installing the pose package, the page and bridge routes, scenes and exports |

## Developer documentation

| Document | Contents |
|------|------|
| [architecture.md](architecture.md) | Project structure, module responsibilities, node registration, data & configuration directories |
| [api-routes.md](api-routes.md) | Backend API route overview |
| [studio-desktop.md](studio-desktop.md) | Studio desktop: startup sequence, frameless window, close teardown, plugin sync, cache and logs |
| [testing.md](testing.md) | pytest unit tests and JS regression tests |
| [mcp.md](mcp.md) | MCP server: external agent access (tool list, async tasks, loopback limit) |
| [release.md](release.md) | Registry publishing and offline tooling |