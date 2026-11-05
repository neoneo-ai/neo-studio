# 把 3d-pose-art 的姿势库同步进数据根，装成「3D 摆姿」页的场景库。
#
# 摆姿仓库那边库拆成两根（npm run lib:split）：pose-lib/ 出厂库（只读、随仓库分发）与
# pose-lab/ 本地库（作者自己写的姿态，可写）。Neo Studio 只要一份合并结果：
#   <数据根>/pose/lib/  ← 出厂集 + 本地集，同 id 本地胜出
# studio/pose.py 只读这一级（LIB_DIR），静态伺服挂在 /pose-lib/ 上；库不进 Registry 包也不进
# exe（data/ 不随包分发），所以同步完刷新页面就生效。库数据在 Neo Studio 这边全程只读：
# 场景写的是 pose/scenes/，不写库。
#
# 索引不在这里算：合并索引由摆姿仓库自己算（node scripts\poseLib.mjs merged），
# 同 id 谁赢、origin 怎么标都在那一份实现里，这里只搬文件 + 取那份索引。
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

function Fail([string]$msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    Fail "找不到摆姿仓库目录：$Source（应指向 3d-pose-art 仓库根）"
}
$repo = (Resolve-Path -LiteralPath $Source).Path
# -Source 指到 pose-lib/ 上也接：那种写法拿不到 scripts\poseLib.mjs，往上一级找仓库根
if (-not (Test-Path -LiteralPath (Join-Path $repo "pose-lib") -PathType Container)) {
    $repo = (Split-Path -Parent $repo)
}
$cli = Join-Path $repo "scripts\poseLib.mjs"
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    Fail "摆姿仓库根不对：$repo（看不到 scripts\poseLib.mjs）"
}
$ship = Join-Path $repo "pose-lib"
$lab = Join-Path $repo "pose-lab"
if (-not (Test-Path -LiteralPath (Join-Path $ship "index.json") -PathType Leaf)) {
    Fail "出厂库里没有索引清单：$ship\index.json。在摆姿仓库里跑 npm run lib -- shipped 生成它。"
}
if (-not (Test-Path -LiteralPath (Join-Path $ship "poses") -PathType Container)) {
    Fail "出厂库里没有 poses\：$(Join-Path $ship 'poses')"
}
$hasLab = Test-Path -LiteralPath (Join-Path $lab "poses") -PathType Container
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "找不到 node：合并索引要跑摆姿仓库的 scripts\poseLib.mjs merged" }

# pose/ 下的 scenes、refs 与 presets 是用户写的场景与素材，本脚本只镜像库自己那一目录，不碰它们
$poseDir = Join-Path (Resolve-Path -LiteralPath $DataRoot).Path "pose"
$dest = Join-Path $poseDir "lib"
$destPoses = Join-Path $dest "poses"
$srcPreview = Join-Path $ship "preview"
$destPreview = Join-Path $dest "preview"
New-Item -ItemType Directory -Force -Path $destPoses | Out-Null

# 预览档位：卡片缩略图默认取 clay（写实渲染那张最直观），缺 clay 的条目才落到 skeleton / silhouette。
# 没有 depth 的档位时这类条目一路落到 skeleton —— depth 本来就是最末一档，只在 -All 里发。
# 宽档跑过一轮再跑窄档时 /MIR 不清 /XF 的排除项，靠下面那段 stale 删除把多余档位摘掉。
$skip = @()
if (-not $All) { $skip += "*depth.png" }
if ($Light) { $skip += "*clay.png" }
$shipTier = if ($All) { "clay + skeleton + silhouette + depth" } elseif ($Light) { "skeleton + silhouette" } else { "clay + skeleton + silhouette" }

# 两遍镜像：先把本地库 /MIR 进目标（顺手清掉上一轮的多余文件），再把出厂集里目标没有的文件补进来。
# 补文件必须带 /E：库文件全在 poses/<分组>/ 子目录里，robocopy 默认不下钻子目录，
# 少了 /E 就是「出厂集一条都没补上」。/XO 让出厂集永不压过同名文件（/XC /XN 一起给 = 
# 只补目标里没有的那批），这条与摆姿仓库合并索引的「同 id 本地胜出」是同一件事的两个面。
function Invoke-Robocopy([array]$rob) {
    robocopy @rob /NFL /NDL /NJH /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "同步失败（robocopy 退出码 $LASTEXITCODE）" }
}

$labPoses = Join-Path $lab "poses"
$shipPoses = Join-Path $ship "poses"
if ($hasLab) {
    Invoke-Robocopy @($labPoses, $destPoses, "/MIR")
} else {
    Write-Host "本地库 pose-lab 没有 poses\，这一轮只同步出厂集" -ForegroundColor Yellow
    Invoke-Robocopy @($shipPoses, $destPoses, "/MIR")
}
# 出厂集只补目标里没有的文件（poses 子树以内，别把 preview/inbox 抖进 poses\）
Invoke-Robocopy @($shipPoses, $destPoses, "/E", "/XC", "/XN", "/XO")

# 预览图同一套两遍；档位排除在两边都生效，最后清掉宽档轮留下的多余档位
if ($hasLab -and (Test-Path -LiteralPath (Join-Path $lab "preview") -PathType Container)) {
    $labPrev = Join-Path $lab "preview"
    $rob = @($labPrev, $destPreview, "/MIR")
    if ($skip.Count) { $rob = $rob + @("/XF") + $skip }
    Invoke-Robocopy $rob
} elseif (Test-Path -LiteralPath $srcPreview -PathType Container) {
    $rob = @($srcPreview, $destPreview, "/MIR")
    if ($skip.Count) { $rob = $rob + @("/XF") + $skip }
    Invoke-Robocopy $rob
}
if (Test-Path -LiteralPath $srcPreview -PathType Container) {
    $rob = @($srcPreview, $destPreview, "/E", "/XC", "/XN", "/XO")
    if ($skip.Count) { $rob = $rob + @("/XF") + $skip }
    Invoke-Robocopy $rob
}
if (Test-Path -LiteralPath $destPreview -PathType Container) {
    foreach ($pattern in $skip) {
        foreach ($stale in @(Get-ChildItem -LiteralPath $destPreview -File -Filter $pattern -ErrorAction SilentlyContinue)) {
            Remove-Item -LiteralPath $stale.FullName -Force
        }
    }
}

# 索引清单交给摆姿仓库自己算（出厂 + 本地、同 id 本地胜出、条目带 origin），这里只收结果
$mergedOut = Join-Path $dest "index.json"
& $node.Source $cli merged --out $mergedOut
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $mergedOut -PathType Leaf)) {
    Fail "合并索引没生成：$mergedOut（在摆姿仓库里跑 npm run lib -- merged 看具体报错）"
}

# 分类登记：本地库改过用本地库；授权说明随出厂库走（库数据发到哪，授权跟到哪）
$cats = if (Test-Path -LiteralPath (Join-Path $lab "categories.json") -PathType Leaf) {
    Join-Path $lab "categories.json"
} elseif (Test-Path -LiteralPath (Join-Path $ship "categories.json") -PathType Leaf) {
    Join-Path $ship "categories.json"
} else { $null }
if ($cats) { Copy-Item -LiteralPath $cats -Destination $dest -Force }
$attr = Join-Path $ship "ATTRIBUTION.md"
if (Test-Path -LiteralPath $attr -PathType Leaf) { Copy-Item -LiteralPath $attr -Destination $dest -Force }

$files = @(Get-ChildItem -LiteralPath $dest -Recurse -File)
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
$index = Get-Content -LiteralPath $mergedOut -Raw | ConvertFrom-Json
$fromShip = @($index.entries | Where-Object { $_.origin -eq "lib" }).Count
Write-Host "场景库已落进 $dest" -ForegroundColor Green
Write-Host ("  {0} 个文件，{1:N1} MB，预览档位：{2}" -f $files.Count, ($bytes / 1MB), $shipTier)
Write-Host ("  索引 {0} 条（出厂 {1} · 本地 {2}）" -f $index.count, $fromShip, ($index.count - $fromShip))
Write-Host "刷新 Neo Studio 窗口的「3D 摆姿」页即可生效（页面逐请求判断库在不在，不必重启）。"
exit 0
