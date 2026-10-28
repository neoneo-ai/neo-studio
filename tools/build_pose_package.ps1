# 生成随包分发的最小摆姿包：studio/pose_dist/（git 已跟踪 → 随 Registry 包与 exe 分发）。
#
# 全量产物 16 MB 里只有一小份能随包发：授权干净的代码 + 唯一一个可再分发的内置素体。
# 素体清单写死在构建产物里（ybot / soldier / ch38 / ch07 / body1391 + 三个程序化素体），
# 所以「带哪个 GLB」由 models/ATTRIBUTION.md 的授权口径决定，不由体积决定：
#   ybot.glb                              CC0（PixelMannen 的 Y Bot）—— 唯一写明可自由使用
#   soldier / ch38 / ch07                 Mixamo 素材，条款与 three.js 的 MIT 不等价，不随包发
#   body1391 / body-*-thumbnail(.glb)     SMPL 派生几何（Max Planck 授权，用户自备），不入库
#   props/*.glb                           自制 1 个 + 来源授权待确认 2 个 + 未登记 3 个，全部不随包发
# 道具注册表是页面运行期读的文件（models/props/index.json），清空 props 数组就等于只发货程序化道具
# —— 注册表里列一个 dist 里没有的 GLB 就是发一条点了只会失败的控件，所以清表与清文件是同一件事。
#
# 源 map（4.4 MB，占全产物 27%）不进包：产物只有一条 //# sourceMappingURL，浏览器只在 devtools
# 打开时取它，随包发只会让每个用户多下载 4.4 MB 而运行行为一点不变。map 留在摆姿仓库与数据根全量
# 产物里（tools\sync_pose_dist.ps1 那条路），开发者调试仍然有。
#
# 从仓库根跑：
#   pwsh tools\build_pose_package.ps1                                   # 取 <数据根>/pose/dist 的现成产物
#   pwsh tools\build_pose_package.ps1 -Source D:\Work\projects\3d-pose-art            # 取该仓库的 dist
#   pwsh tools\build_pose_package.ps1 -Source D:\Work\projects\3d-pose-art -Build     # 先 npm run build
#   pwsh tools\build_pose_package.ps1 -Dist D:\somewhere\dist -Out D:\tmp\pose_pkg
param(
    [string]$Source = "",
    [string]$Dist = "",
    [string]$Out = "",
    [switch]$Build
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path -LiteralPath "$PSScriptRoot\..").Path
$outDir = if ($Out) { $Out } else { Join-Path $repo "studio\pose_dist" }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# 随包 GLB 白名单：加任何一个都要先在摆姿仓库的 ATTRIBUTION 里有可再分发的授权行
$allowedGlb = @("ybot.glb")
# 包体积上限：代码 1.1 MB + Y Bot 2.8 MB 实测 4.0 MB，留 0.5 MB 余量给产物增长
$maxPackageBytes = 4.5 * 1MB
$required = @("index.html", "LICENSE", "models/ATTRIBUTION.md", "models/ybot.glb", "models/props/index.json")
$assetExt = @(".js", ".css", ".wasm", ".json", ".woff", ".woff2", ".ttf", ".ktx2")

function Fail([string]$msg) { Write-Host $msg -ForegroundColor Red; exit 1 }
function Write-Text([string]$path, [string]$text) { [System.IO.File]::WriteAllText($path, $text, $utf8NoBom) }
function Copy-File([string]$srcPath, [string]$stage, [string]$rel) {
    $dst = Join-Path $stage $rel
    $dir = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item -LiteralPath $srcPath -Destination $dst -Force
}

if ($Build) {
    if (-not $Source) { Fail "-Build 要配 -Source（在摆姿仓库根跑 npm run build）" }
    Push-Location -LiteralPath (Resolve-Path -LiteralPath $Source).Path
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { Fail "npm run build 失败" }
    } finally { Pop-Location }
}

$src = $Dist
if (-not $src -and $Source) { $src = Join-Path (Resolve-Path -LiteralPath $Source).Path "dist" }
if (-not $src) { $src = Join-Path $repo "data\pose\dist" }
if (-not (Test-Path -LiteralPath $src -PathType Container)) {
    Fail "找不到构建产物目录：$src（用 -Source 指向 3d-pose-art 仓库根，或用 -Dist 直接指产物目录）"
}
$src = (Resolve-Path -LiteralPath $src).Path

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("pose_pkg_" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
    # 1. 入口页与许可证：入口页每次校验，许可证是产物目录里现成的那份
    Copy-File (Join-Path $src "index.html") $stage "index.html"
    foreach ($name in @("LICENSE", "LICENSE.md", "NOTICE", "NOTICE.md")) {
        $lic = Join-Path $src $name
        if (Test-Path -LiteralPath $lic -PathType Leaf) { Copy-File $lic $stage $name; break }
    }

    # 2. 代码：vite 的 assets/ 全量带（js/css/wasm/字体），只摘掉 *.map
    $assets = Join-Path $src "assets"
    if (-not (Test-Path -LiteralPath $assets -PathType Container)) { Fail "产物里没有 assets/：$assets" }
    $jsCopied = 0
    foreach ($f in Get-ChildItem -LiteralPath $assets -File) {
        if ($f.Extension -eq ".map") { continue }
        if ($assetExt -notcontains $f.Extension) { continue }
        Copy-File $f.FullName $stage "assets\$($f.Name)"
        if ($f.Extension -eq ".js") { $jsCopied++ }
    }
    if ($jsCopied -lt 1) { Fail "assets/ 里没有 js：产物不是 vite 构建产物？" }

    # 3. 发布清洗：产物里烘进了开发机的个人路径（素体注册表的 sourceImage 字段），随包发出去等于把
    #    开发者的目录结构交给所有用户。正解是摆姿仓库侧别把本机路径写进注册表，这里先把发货副本清掉。
    foreach ($js in Get-ChildItem -LiteralPath (Join-Path $stage "assets") -Filter "*.js") {
        $text = [System.IO.File]::ReadAllText($js.FullName)
        $cleaned = [regex]::Replace($text, 'sourceImage:\s*`[^`]*`', 'sourceImage:``')
        if ($cleaned -ne $text) { Write-Text $js.FullName $cleaned }
        # 只看引号后紧跟「盘符 + 斜杠」的字面量：协议串（https://…）也是「字母: /」，不能一起算
        $probe = "['" + [char]34 + [char]96 + "][A-Za-z]:[\\/]"
        if ($cleaned -match $probe) {
            Fail "产物里仍有开发机绝对路径（$($js.Name)）：随包发不出去，去摆姿仓库把注册表里的本机路径去掉"
        }
    }

    # 4. 素材：GLB 只带白名单里那一个，道具注册表清空（程序化道具照旧可用，GLB 道具走自备导入）
    foreach ($glb in $allowedGlb) {
        $p = Join-Path $src (Join-Path "models" $glb)
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
            Fail "随包素体缺失：$p（页面内置清单里的 $glb 不在，页面上就一个 GLB 素体都选不到）"
        }
        Copy-File $p $stage "models\$glb"
    }
    $attr = Join-Path $src "models\ATTRIBUTION.md"
    if (Test-Path -LiteralPath $attr -PathType Leaf) { Copy-File $attr $stage "models\ATTRIBUTION.md" }
    $reg = Join-Path $src "models\props\index.json"
    $regDest = Join-Path $stage "models\props\index.json"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $regDest) | Out-Null
    if (Test-Path -LiteralPath $reg -PathType Leaf) {
        $data = Get-Content -LiteralPath $reg -Raw -Encoding utf8 | ConvertFrom-Json
        $clean = [ordered]@{ _readme = $data._readme; props = @() }
        Write-Text $regDest (($clean | ConvertTo-Json -Depth 6) + "`n")
    } else {
        Write-Text $regDest "{`"props`": []}`n"
    }


    # 5. 第三方授权：terser 把上游许可横幅删干净了（产物里 /*! 计数 0），随包发这段代码要把出处补回来
    Write-Text (Join-Path $stage "THIRD-PARTY.md") (@(
        "# 随包产物的第三方授权",
        "",
        "摆姿页的 `assets/*.js` 是 vite + terser 的一次 rollup，构建会删掉上游的许可横幅，所以在这里补齐出处：",
        "",
        "- three.js（渲染器，随产物分发）— MIT，https://github.com/mrdoob/three.js",
        "- Draco 网格解码（内联进产物 JS，产物里没有 .wasm 文件）— Apache-2.0，https://github.com/google/draco",
        "- 素体 `models/ybot.glb`（上游 `Xbot.glb`，作者 PixelMannen）— CC0，随产物分发",
        "",
        "GLB 与道具的逐文件来源与授权见 [models/ATTRIBUTION.md](models/ATTRIBUTION.md)。Mixamo 与 SMPL 派生的",
        "素体不随包分发（各自条款仅限个人使用），由使用者自备 GLB 从宿主面板「自备素体」导入，落点",
        "`<数据根>/pose/dist/models/`。摆姿页源码见摆姿仓库（MIT）。",
        ""
    ) -join "`n")

    # 6. 发货清单：逐文件 sha256 与体积，后端 /neo_pose/status 把这份交出去，装机后能不能跑一眼可见
    $rows = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{
            path   = $_.FullName.Substring($stage.Length + 1).Replace("\", "/")
            bytes  = [int]$_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()
        }
    })
    $total = ($rows | Measure-Object -Property bytes -Sum).Sum
    foreach ($name in $required) {
        if (-not ($rows | Where-Object { $_.path -eq $name })) { Fail "随包清单缺文件：$name" }
    }
    $forbidden = @($rows | Where-Object {
        ($_.path -like "*.map") -or
        ($_.path -like "models/*.glb" -and $allowedGlb -notcontains (Split-Path -Leaf $_.path)) -or
        ($_.path -like "models/props/*.glb") -or
        ($_.path -like "models/*.json" -and $_.path -notlike "models/props/*") -or
        ($_.path -like "*animation-demo*")
    })
    if ($forbidden.Count) { Fail "随包清单里有不该发货的文件：$($forbidden.path -join ', ')" }
    if ($total -gt $maxPackageBytes) {
        Fail ("随包体积 {0:N2} MB 超过上限 {1:N1} MB：加素材要先改授权口径与上限，不能让它无声变大" -f ($total / 1MB), ($maxPackageBytes / 1MB))
    }
    $manifest = [ordered]@{
        format      = "3dpose.package/1"
        generator   = "tools/build_pose_package.ps1"
        built_utc   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
        total_bytes = [int]$total
        files       = $rows
    }
    Write-Text (Join-Path $stage "MANIFEST.json") (($manifest | ConvertTo-Json -Depth 4) + "`n")

    # 7. 落包：/MIR 只清上一版的多余文件，pose_dist 是可重建的产物镜像，装机副本不留旧哈希文件
    if (-not (Test-Path -LiteralPath $outDir -PathType Container)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    robocopy $stage $outDir /MIR /NFL /NDL /NJH /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "落包失败（robocopy 退出码 $LASTEXITCODE）" }

    $outFiles = @(Get-ChildItem -LiteralPath $outDir -Recurse -File)
    Write-Host "最小摆姿包已落进 $outDir" -ForegroundColor Green
    Write-Host ("  {0} 个文件，{1:N2} MB（上限 {2:N1} MB），GLB 素体 {3} 份" -f `
        $outFiles.Count, ($total / 1MB), ($maxPackageBytes / 1MB), (@($outFiles | Where-Object { $_.Extension -eq ".glb" }).Count))
    Write-Host "  清单见 MANIFEST.json（逐文件 sha256）；未随包的 GLB 走宿主面板「自备素体」导入"
    exit 0
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

