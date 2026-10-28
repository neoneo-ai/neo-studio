# 随包产物的第三方授权

摆姿页的 ssets/*.js 是 vite + terser 的一次 rollup，构建会删掉上游的许可横幅，所以在这里补齐出处：

- three.js（渲染器，随产物分发）— MIT，https://github.com/mrdoob/three.js
- Draco 网格解码（内联进产物 JS，产物里没有 .wasm 文件）— Apache-2.0，https://github.com/google/draco
- 素体 models/ybot.glb（上游 Xbot.glb，作者 PixelMannen）— CC0，随产物分发

GLB 与道具的逐文件来源与授权见 [models/ATTRIBUTION.md](models/ATTRIBUTION.md)。Mixamo 与 SMPL 派生的
素体不随包分发（各自条款仅限个人使用），由使用者自备 GLB 从宿主面板「自备素体」导入，落点
<数据根>/pose/dist/models/。摆姿页源码见摆姿仓库（MIT）。
