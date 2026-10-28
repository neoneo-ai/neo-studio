# 素体模型来源与授权

本目录下的 GLB 均取自 [mrdoob/three.js](https://github.com/mrdoob/three.js) 仓库
`examples/models/gltf/`（three.js 以 MIT 授权发布，示例资源随仓库一同分发）。

| 文件 | 上游文件 | 作者 / 授权 | 说明 |
|---|---|---|---|
| `ybot.glb` | `Xbot.glb` | Y Bot — PixelMannen，CC0 | 默认素体；蒙皮网格 `Beta_Joints`（眼/牙/舌）+ `Beta_Surface` |
| `soldier.glb` | `Soldier.glb` | Mixamo（经 three.js 分发） | 士兵素体；两套蒙皮网格，手指不参与形变 |

> 2026-10-21 移除：`michelle.glb`（`Michelle.glb`，three.js 示例资源，Mixamo 素材）。
> 它落在下面「再分发提醒」的灰色地带，故不再随仓库分发。女性素体请改用程序化女性素体
> （下拉里的「女性素体（程序化）」）或本地导入的 `ch07.glb`。

## 使用注意

- 仓库内的两个 GLB 与本地导入素体都是 **Mixamo 骨架命名**（`mixamorig:Hips` 等）。加载时 `src/core/character.js`
  会把前缀统一成 `mixamorigHips`，以便与预设、序列化、IK 路由表里的短名（`LeftArm` 等）对齐。
- 骨骼带 `0.01` 缩放（模型以厘米为单位制作），因此关节手柄半径与描边厚度需要按
  `unitComp = 1 / 根世界缩放` 补偿，见 `character.js` 中的注释。
- 本项目把材质整体替换为无贴图的「黏土」`MeshStandardMaterial`，不保留原始贴图。

## 再分发提醒

若要把这些模型随本仓库**再分发或用于商业产品**，请各自回到上游确认授权：
CC0（Y Bot）可自由使用；Soldier 与本地导入的 ch38 / ch07 源自 Mixamo 素材，Mixamo 资源的再分发条款
与 three.js 仓库的 MIT 并不完全等价，必要时请改为从 mixamo.com 自行取得授权
（本地导入区那两个就是这么处理的：产物不进仓库，各自下载各自导入）。

## 本地导入区（不随仓库分发）

`scripts/importMixamo.mjs` 可把 Mixamo 下载的 FBX 变成本项目可用的素体 GLB
（去纹理、去动画、骨骼名去数字前缀、按包围盒生成机位）。产物默认写在
`public/models/<key>.glb`，并已在 `.gitignore` 里 —— **Mixamo 资源授权仅限个人
使用，禁止提交进仓库**，克隆仓库的人请自行下载同名 FBX 跑一遍导入脚本：

```bash
npm run import -- "G:/Downloads/Ch38_nonPBR.fbx" --key ch38 --label "男性素体 Ch38"
```

| 文件 | 上游文件 | 作者 / 授权 | 说明 |
|---|---|---|---|
| `ch38.glb` | `Ch38_nonPBR.fbx`（mixamo.com） | Mixamo（Adobe 账号授权，仅个人使用） | Tony 于 2026-10-20 本地导入：去纹理、去动画、骨骼名 `mixamorig5:` → `mixamorig:`；男性素体，蒙皮网格 Body / Hair / Shirt / Shorts / Shoes / Socks / Eyelashes |
| `ch07.glb` | `Ch07_nonPBR.fbx`（mixamo.com） | Mixamo（Adobe 账号授权，仅个人使用） | Tony 于 2026-10-20 本地导入：同上处理；女性素体，蒙皮网格 Body / Hair / Suit / Pants / Heels / Shirt / Eyelashes |
| `body1391.glb` | `1391_thumbnail.png`（PoseMy.Art 素材，本地）→ HMR2.0 估 SMPL betas | SMPL 模型（Max Planck 授权，用户自备）+ 4D-Humans 代码（MIT） | Tony 于 2026-10-24 生成（`scripts/smplRigGlb.py`）：SMPL 规范 T-Pose 网格 + SMPL 蒙皮 top-4 → 22 根 Mixamo 骨骼（绑定旋转 = 单位四元数）、无贴图无动画；产物 `public/models/body*.glb` 在 .gitignore 里 |

> 这两个模型的骨骼前缀带数字（`mixamorig5:` / `mixamorig8:`），与仓库内三个模型的
> `mixamorig:` 不同。`src/core/character.js` 的 `normalizeBoneName()` 会一并归一为
> `mixamorigHips` 这类内部短名，导入脚本也会直接写进 GLB。

## 道具模型（public/models/props/）

| 文件 | 上游文件 | 作者 / 授权 | 说明 |
|---|---|---|---|
| `prop_test_box.glb` | 无上游（脚本生成） | 本项目自制 | `scripts/makePropGlb.mjs` 生成的最小 glTF 2.0 箱体，GLB 道具通路（node / E2E 测试）的基准文件 |
| `arrow.glb` | `ARROW.obj`（本地下载的 ARROW.obj（来源与授权待确认）） | 见来源页授权 | Tony 于 2026-10-25 用 `scripts/importProp.mjs` 导入：.obj → 烘焙 实测主方向→Y、单位 ×1；6346 三角面，上场 0.26×1.00×0.12m |
| `sting-sword.glb` | `Sting-Sword.glb`（本地下载，来源页与授权待确认） | 见来源页授权 | Tony 于 2026-10-25 用 `scripts/importProp.mjs` 导入：.glb 直通（原拓扑 + 原材质，未去贴图）、单位 ×0.01、根节点把 z 轴立到 +Y；4 网格 / 1234 三角面，上场 0.21 × 1.00 × 0.03 m（长宽比 37:1） |

> `arrow.glb` / `sting-sword.glb` 是**本地导入产物**：来源页授权确认之前不随仓库分发（在 `.gitignore` 内，与 `ch38` / `ch07` 同口径）。
> 克隆后重新生成：`npm run prop:import -- "你的ARROW.obj" --file arrow --label 箭 --source 来源URL --author 我`；
> 克隆后重新生成剑：`npm run prop:import -- "你的Sting-Sword.glb" --file sting-sword --label 细剑 --source 来源URL --author 我`；
> 缺文件时 UI 选中失败在「提示 + 保持当前物体」，道具 node 测试自动跳过那一条（`tests/propRuntime.node.test.mjs`）。
>
> 道具的「立着」约定（长轴沿 `+Y`、底面中心在原点）与 `--up auto` 的判据见 README「导入道具与武器」。
