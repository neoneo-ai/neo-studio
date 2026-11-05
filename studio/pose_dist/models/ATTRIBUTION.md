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

## 标准素体三件套（随仓库分发，2026-11-03 起入库）

标准基座是姿势库分派与预览渲染的落点（标准女 / 标准男 + 体型可调的 MPFB 素体，判据见
`src/pose/poseGender.js`）。它们不是下载来的模型，是**本项目自己生成的**：Blender 无头 + MPFB2
表型滑块 → MPFB2 自带 mixamo 骨架 → T-pose 烘成绑定姿态 → `rebakeRig` 把骨旋转烘成单位四元数。
MPFB2 的基网格是 CC0 资产，可随仓库分发，所以在 `.gitignore` 里从 `public/models/body*.glb`
通配中单独放出来（`!public/models/bodyMale.glb` 等三行）。

| 文件 | 生成方式 | 上游 / 授权 | 说明 |
|---|---|---|---|
| `bodyMale.glb` | `npm run body:mpfb -- --key bodyMale --label "标准男性素体（CC0）" --gender 0.85 --age 0.35 --muscle 0.6 --weight 0.5 --proportions 0.5 --cupsize 0.5 --height 1.78` | MPFB2（MakeHuman Community，基网格 CC0）+ 本项目生成链 `scripts/mpfbBodyRun.mjs` / `scripts/mpfbBody.py` | 注册键 `bodyMale`；52 根 `mixamorig:` 骨（五指各 3 节）+ 1 套蒙皮 + 1 个网格（26,756 三角面）；米制 `unitComp = 1`（无根缩放，与 Mixamo 的 0.01 差 100 倍 → 跨基座套用的位移换算见 README「骨骼位移与挂点位移带的是源骨架的局部单位」）；无贴图，运行时替换为黏土材质 |
| `bodyFemale.glb` | 同上，`--key bodyFemale --gender 0 --age 0.35 --muscle 0.4 --weight 0.55 --proportions 0.55 --cupsize 0.8 --height 1.66` | 同上 | 注册键 `bodyFemale`；女性特征要 gender 到底 + cupsize 抬起 + 臀腿比例三条一起给才明显（`src/core/bodyShapePresets.js` 的 female-standard 同值） |
| `bodyMPFB.glb` | `npm run body:mpfb -- --key bodyMPFB --label "MPFB 素体" --height 1.75 --gender 0.5 --muscle 0.5 --weight 0.5` | 同上 | 注册键 `bodyMPFB`；体型可调的通用款，面板「MPFB 体型」的基准 |

- 前置：Blender ≥4.2 + MPFB 扩展（`--command extension install-file`）；生成过程与逐骨旋转的取数口径见 README「从 MPFB2 造素体」。
- 入库的都是**注册表里的三个 key**（`src/core/character.js`）。网页面板调体型产出的一次性变体
  （`bodyMPFB-<时间戳>.glb`，`scripts/mpfbBody.mjs`）与照片 → SMPL 派生素体（`body1391.glb`、
  `body-2320_thumbnail.glb` 等，Max Planck 授权）继续不入库。
- 校验口径（入库前实测）：GLB 魔数 `glTF` / version 2 / 声明长度 == 文件长度；54 nodes、1 skin、52 joints、1 个蒙皮网格、80,268 索引（= 26,756 三角面）、52 根 `mixamorig` 骨、节点无缩放（米制）。


## 道具模型（public/models/props/）

| 文件                | 上游文件                                                       | 作者 / 授权          | 说明                                                                                                                                   |
| :------------------ | :------------------------------------------------------------- | :------------------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| `prop_test_box.glb` | 无上游（脚本生成）                                             | 本项目自制           | `scripts/makePropGlb.mjs` 生成的最小 glTF 2.0 箱体，GLB 道具通路（node / E2E 测试）的基准文件                                          |
| `stick.glb`         | 无上游（脚本生成）                                             | 本项目自制           | `node scripts/makePropGlb.mjs --builtin stick` 生成：与内置 `builtin:stick` 同一份零件清单（棍身 + 打击端），随产物分发（可再分发）     |
| `sword.glb`         | 无上游（脚本生成）                                             | 本项目自制           | `node scripts/makePropGlb.mjs --builtin sword` 生成：与内置 `builtin:sword` 同一份零件清单（刃 / 护手 / 柄 / 首），随产物分发          |
| `arrow.glb`         | `ARROW.obj`（本地下载的 ARROW.obj（来源与授权待确认））        | 见来源页授权         | Tony 于 2026-10-25 用 `scripts/importProp.mjs` 导入：.obj → 烘焙 实测主方向→Y、单位 ×1；6346 三角面，上场 0.26×1.00×0.12m                |
| `sting-sword.glb`   | `Sting-Sword.glb`（本地下载，来源页与授权待确认）              | 见来源页授权         | Tony 于 2026-10-25 用 `scripts/importProp.mjs` 导入：.glb 直通（原拓扑 + 原材质，未去贴图）、单位 ×0.01、根节点把 z 轴立到 +Y；4 网格 / 1234 三角面，上场 0.21 × 1.00 × 0.03 m（长宽比 37:1） |

> `stick.glb` / `sword.glb` 是**脚本生成的自制道具**：几何来自 `src/core/propKit.js` 的零件清单，
> 授权口径与 `prop_test_box.glb` 相同，可随产物与插件包分发（`tools/build_pose_package.ps1` 的
> GLB 白名单里有它们）；改动零件清单后重跑上面两条命令即可重新生成。

> `arrow.glb` / `sting-sword.glb` 是**本地导入产物**：来源页授权确认之前不随仓库分发（在 `.gitignore` 内，与 `ch38` / `ch07` 同口径）。
> 克隆后重新生成：`npm run prop:import -- "你的ARROW.obj" --file arrow --label 箭 --source 来源URL --author 我`；
> 克隆后重新生成剑：`npm run prop:import -- "你的Sting-Sword.glb" --file sting-sword --label 细剑 --source 来源URL --author 我`；
> 缺文件时 UI 选中失败在「提示 + 保持当前物体」，道具 node 测试自动跳过那一条（`tests/propRuntime.node.test.mjs`）。
>
> 道具的「立着」约定（长轴沿 `+Y`、底面中心在原点）与 `--up auto` 的判据见 README「导入道具与武器」。
| `katana.glb` | `antique_katana_01.fbx`（https://polyhaven.com/a/antique_katana_01 — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；6670 三角面，上场 0.09×1.00×0.09m |
| `saber.glb` | `wooden_handle_saber.fbx`（https://polyhaven.com/a/wooden_handle_saber — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；4031 三角面，上场 0.03×1.00×0.13m |
| `estoc.glb` | `antique_estoc.fbx`（https://polyhaven.com/a/antique_estoc — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；8246 三角面，上场 0.25×1.00×0.10m |
| `dagger_medieval.glb` | `ornate_medieval_dagger.fbx`（https://polyhaven.com/a/ornate_medieval_dagger — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；6290 三角面，上场 0.34×1.00×0.07m |
| `machete.glb` | `machete.fbx`（https://polyhaven.com/a/machete — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；3032 三角面，上场 0.06×1.00×0.08m |
| `knife_fish.glb` | `fish_knife.fbx`（https://polyhaven.com/a/fish_knife — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；2736 三角面，上场 0.13×1.00×0.08m |
| `mace.glb` | `ornate_medieval_mace.fbx`（https://polyhaven.com/a/ornate_medieval_mace — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；14762 三角面，上场 0.15×1.00×0.16m |
| `war_hammer.glb` | `ornate_war_hammer.fbx`（https://polyhaven.com/a/ornate_war_hammer — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；5192 三角面，上场 0.20×1.00×0.05m |
| `sledgehammer.glb` | `sledgehammer_01.fbx`（https://polyhaven.com/a/sledgehammer_01 — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；2596 三角面，上场 0.21×1.00×0.09m |
| `axe_wood.glb` | `wooden_axe.fbx`（https://polyhaven.com/a/wooden_axe — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；3348 三角面，上场 0.07×1.00×0.34m |
| `hatchet.glb` | `hatchet.fbx`（https://polyhaven.com/a/hatchet — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；5250 三角面，上场 0.09×1.00×0.36m |
| `shield_kite.glb` | `kite_shield.fbx`（https://polyhaven.com/a/kite_shield — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；10306 三角面，上场 0.39×1.00×0.10m |
| `pistol_service.glb` | `service_pistol.fbx`（https://polyhaven.com/a/service_pistol — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；27548 三角面，上场 1.07×1.00×0.11m |
| `rifle_bolt.glb` | `bolt_action_rifle_7_62.fbx`（https://polyhaven.com/a/bolt_action_rifle_7_62 — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；19985 三角面，上场 6.02×1.00×0.33m |
| `bat_baseball.glb` | `baseball_bat.fbx`（https://polyhaven.com/a/baseball_bat — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；2672 三角面，上场 0.07×1.00×0.07m |
| `chair_garden.glb` | `GreenChair_01.fbx`（https://polyhaven.com/a/GreenChair_01 — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；4213 三角面，上场 0.64×1.00×0.63m |
| `stool_chinese.glb` | `chinese_stool.fbx`（https://polyhaven.com/a/chinese_stool — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；1090 三角面，上场 0.95×1.00×0.80m |
| `table_side.glb` | `side_table_01.fbx`（https://polyhaven.com/a/side_table_01 — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；2756 三角面，上场 1.00×1.00×0.82m |
| `barrel_oil.glb` | `Barrel_01.fbx`（https://polyhaven.com/a/Barrel_01 — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；2682 三角面，上场 0.64×1.00×0.64m |
| `crate_military.glb` | `wooden_military_crate.fbx`（https://polyhaven.com/a/wooden_military_crate — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | Poly Haven（CC0） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.fbx → 烘焙 指定轴 0/1/0→Y、单位 ×0.01；22986 三角面，上场 2.67×1.00×1.12m |
| `jian.glb` | `jian.glb`（https://www.blendkit.com/api/v1/assets/8caf0aa5-cf62-415e-bff6-a2a83bc37952/ — BlenderKit（CC0 1.0 公有领域，可商用可再分发）） | 见来源页授权 | BlenderKit：foehn N（cc_zero） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.glb → 烘焙 y 轴（指定）→Y、单位 ×1、去贴图；5629 三角面，上场 5.20×1.00×20.48m ；注册表 scale 1.29 → 世界最长边 1.29m（BlenderKit 真实长边 1.29m，姿态=立起来（长轴沿局部 +Y、柄端在底部）） |
| `staff.glb` | `staff.glb`（https://www.blendkit.com/api/v1/assets/814a30f3-74e7-489f-beb5-3d7831a8971c/ — BlenderKit（CC0 1.0 公有领域，可商用可再分发）） | 见来源页授权 | BlenderKit：foehn N（cc_zero） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.glb → 烘焙 y 轴（指定）→Y、单位 ×1、去贴图；2064 三角面，上场 1.37×1.00×25.96m ；注册表 scale 1.997 → 世界最长边 2.00m（BlenderKit 真实长边 2.00m，姿态=立起来（长轴沿局部 +Y、柄端在底部）） |
| `sword_thin.glb` | `sword_thin.glb`（https://www.blendkit.com/api/v1/assets/c75631ce-806b-4d9a-ad9d-3b59c94ae5c7/ — BlenderKit（Royalty Free（免版税，可商用，署名要求见来源页））） | 见来源页授权 | BlenderKit：Vadim Gubey（royalty_free） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.glb → 烘焙 y 轴（指定）→Y、单位 ×1、去贴图；3120 三角面，上场 6.51×1.00×33.96m ；注册表 scale 0.76 → 世界最长边 0.76m（BlenderKit 真实长边 0.76m，姿态=立起来（长轴沿局部 +Y、柄端在底部）） |
| `sword_thin_long.glb` | `sword_thin_long.glb`（https://www.blendkit.com/api/v1/assets/2c41ee5b-78a8-41eb-a414-02b5cb4a0a6b/ — BlenderKit（Royalty Free（免版税，可商用，署名要求见来源页））） | 见来源页授权 | BlenderKit：Garshasp khedri（royalty_free） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.glb → 烘焙 y 轴（指定）→Y、单位 ×1、去贴图；844 三角面，上场 11.59×1.00×56.69m ；注册表 scale 1.199 → 世界最长边 1.20m（BlenderKit 真实长边 1.20m，姿态=立起来（长轴沿局部 +Y、柄端在底部）） |
| `staff_thin.glb` | `staff_thin.glb`（https://www.blendkit.com/api/v1/assets/b28903ad-129f-45fc-91ca-510f6b9937b6/ — BlenderKit（Royalty Free（免版税，可商用，署名要求见来源页））） | 见来源页授权 | BlenderKit：Gabriel Dobrachinski（royalty_free） 于 2026-11-03 用 `scripts/importProp.mjs` 导入：.glb → 烘焙 y 轴（指定）→Y、单位 ×1、去贴图；2147 三角面，上场 3.79×1.00×90.02m ；注册表 scale 1.895 → 世界最长边 1.90m（BlenderKit 真实长边 1.90m，姿态=立起来（长轴沿局部 +Y、柄端在底部）） |
