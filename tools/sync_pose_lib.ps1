# 把 3d-pose-art 的姿势库（pose-lib 的库数据）同步进数据根，装成「3D 摆姿」页的姿势库。
#
# 库只有一份落点：<数据根>/pose/lib/。studio/pose.py 只读这一级（LIB_DIR），静态伺服挂在
# /pose-lib/ 上；库不进 Registry 包也不进 exe（data/ 不随包分发），所以同步完刷新页面就生效。
# 库数据在 Neo Studio 这边全程只读：「存为姿态」写的是 pose/presets/，不写库。
#
# 从仓库根运行：
#   pwsh tools\sync_pose_lib.ps1 -Source D:\Work\projects\3d-pose-art
#   pwsh tools\sync_pose_lib.ps1 -Source D:\Work\projects\3d-pose-art -Light   # 只带轻量预览
#   pwsh tools\sync_pose_lib.ps1 -Source D:\Work\projects\3d-pose-art -All     # 连 depth 一起带
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [string]$DataRoot = "$PSScriptRoot\..\data",
    [switch]$Light,
    [switch]$All
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    Write-Host "找不到姿势库目录：$Source（应指向 3d-pose-art 仓库根或它的 pose-lib）" -ForegroundColor Red
    exit 1
}
$repo = (Resolve-Path -LiteralPath $Source).Path
# 仓库根与库目录两种写法都接：指仓库根时进 pose-lib/，直接把 -Source 指到 pose-lib 上也照样成立
$libSrc = Join-Path $repo "pose-lib"
if (-not (Test-Path -LiteralPath $libSrc -PathType Container)) { $libSrc = $repo }
if (-not (Test-Path -LiteralPath (Join-Path $libSrc "index.json") -PathType Leaf)) {
    Write-Host "姿势库里没有索引清单：$libSrc\index.json。在摆姿仓库里跑 npm run lib -- reindex 生成它。" -ForegroundColor Red
    exit 1
}
$srcPoses = Join-Path $libSrc "poses"
if (-not (Test-Path -LiteralPath $srcPoses -PathType Container)) {
    Write-Host "姿势库里没有 poses\：$srcPoses（库里只有索引清单的话先跑 npm run lib -- save/preview/reindex）" -ForegroundColor Red
    exit 1
}

# pose/ 下的 scenes、refs 与 presets 是用户写的场景与素材，本脚本只镜像库自己那一目录，不碰它们
$poseDir = Join-Path (Resolve-Path -LiteralPath $DataRoot).Path "pose"
$dest = Join-Path $poseDir "lib"
$destPoses = Join-Path $dest "poses"
$srcPreview = Join-Path $libSrc "preview"
$destPreview = Join-Path $dest "preview"
New-Item -ItemType Directory -Force -Path $destPoses | Out-Null

# 预览档位：卡片缩略图默认取 clay（写实渲染那张最直观），缺 clay 的条目才落到 skeleton / silhouette。
# 没有 depth 的档位时这类条目一路落到 skeleton —— depth 本来就是最末一档，只在 -All 里发。
# 宽档跑过一轮再跑窄档时 /MIR 不清 /XF 的排除项，靠下面那段 stale 删除把多余档位摘掉。
$skip = @()
if (-not $All) { $skip += "*depth.png" }
if ($Light) { $skip += "*clay.png" }
$ship = if ($All) { "clay + skeleton + silhouette + depth" } elseif ($Light) { "skeleton + silhouette" } else { "clay + skeleton + silhouette" }

# poses/ 整目录镜像：库里一条姿态就是一个 .pose.json，重名以库为准，用户在 Neo Studio 里改不到它
robocopy $srcPoses $destPoses /MIR /NFL /NDL /NJH /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "同步 poses 失败（robocopy 退出码 $LASTEXITCODE）" -ForegroundColor Red; exit 1 }

if (Test-Path -LiteralPath $srcPreview -PathType Container) {
    New-Item -ItemType Directory -Force -Path $destPreview | Out-Null
    # /XF 只在真有排除档位时给：留一个空 /XF 的话 robocopy 把后面的 /NFL 当成排除清单，整条同步直接失败
    $rob = @($srcPreview, $destPreview, "/MIR")
    if ($skip.Count) { $rob = $rob + @("/XF") + $skip }
    $rob = $rob + @("/NFL", "/NDL", "/NJH", "/NP")
    robocopy @rob | Out-Null
    if ($LASTEXITCODE -ge 8) { Write-Host "同步预览图失败（robocopy 退出码 $LASTEXITCODE）" -ForegroundColor Red; exit 1 }
    # 被排除的那一档在上一轮宽档里可能已经落进库里：/MIR 不清排除项，不删的话库里会留一套
    # 这一档不该发的图（弹窗按 clay 优先选图，留下的 depth 只会白占体积）
    foreach ($pattern in $skip) {
        foreach ($stale in @(Get-ChildItem -LiteralPath $destPreview -File -Filter $pattern -ErrorAction SilentlyContinue)) {
            Remove-Item -LiteralPath $stale.FullName -Force
        }
    }
}

# 索引清单与分类注册表在库根上：弹窗按 index.json 渲染，categories.json 只是分类名的一层旁表
foreach ($name in @("index.json", "categories.json")) {
    $src = Join-Path $libSrc $name
    if (Test-Path -LiteralPath $src -PathType Leaf) { Copy-Item -LiteralPath $src -Destination $dest -Force }
}

$files = @(Get-ChildItem -LiteralPath $dest -Recurse -File)
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
Write-Host "姿势库已落进 $dest" -ForegroundColor Green
Write-Host ("  {0} 个文件，{1:N1} MB，预览档位：{2}" -f $files.Count, ($bytes / 1MB), $ship)
Write-Host "刷新 Neo Studio 窗口的「3D 摆姿」页即可生效（页面逐请求判断库在不在，不必重启）。"
exit 0