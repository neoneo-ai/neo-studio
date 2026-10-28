# 把 3d-pose-art 的 vite 产物同步进数据根，装成「3D 摆姿」页的摆姿包。
#
# 摆姿包只有一份落点：<数据根>/pose/dist/。插件与桌面端都只读这里（studio/pose.py 的 DIST_DIR），
# 产物不进 Registry 包也不进 exe（data/ 不随包分发），所以装完包刷新页面就生效，不必重启。
#
# 从仓库根运行：
#   pwsh tools\sync_pose_dist.ps1 -Source D:\Work\projects\3d-pose-art
#   pwsh tools\sync_pose_dist.ps1 -Source D:\Work\projects\3d-pose-art -Build   # 先 npm run build
#   pwsh tools\sync_pose_dist.ps1 -Source ..\3d-pose-art -DataRoot D:\NeoStudioData
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [string]$DataRoot = "$PSScriptRoot\..\data",
    [switch]$Build
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    Write-Host "找不到摆姿仓库目录：$Source（应指向 3d-pose-art 仓库根）" -ForegroundColor Red
    exit 1
}
$repo = (Resolve-Path -LiteralPath $Source).Path
$dist = Join-Path $repo "dist"
if (-not (Test-Path -LiteralPath (Join-Path $repo "package.json") -PathType Leaf)) {
    Write-Host "不在 3d-pose-art 仓库根：$repo（应能看到 package.json）" -ForegroundColor Red
    exit 1
}

if ($Build) {
    Push-Location -LiteralPath $repo
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { Write-Host "npm run build 失败" -ForegroundColor Red; exit 1 }
    } finally { Pop-Location }
}

if (-not (Test-Path -LiteralPath (Join-Path $dist "index.html"))) {
    Write-Host "没有构建产物：$dist\index.html 不存在。先加 -Build，或在摆姿仓库里跑 npm run build。" -ForegroundColor Red
    exit 1
}

# pose/ 下的 scenes 与 refs 是用户写的场景与素材，本脚本只镜像 dist/，不碰它们
$poseDir = Join-Path (Resolve-Path -LiteralPath $DataRoot).Path "pose"
$dest = Join-Path $poseDir "dist"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# 自备素体（宿主面板导入的 GLB）落在 dest\models 里，源产物里没有它们：robocopy /MIR 会把这些
# 「源里没有的文件」连根清掉，用户导入的素体就随一次重装摆姿包无声消失。所以先把源产物里
# 没有的那几份挪进临时目录存着，镜像完再原样搬回来。
$srcModelRoot = Join-Path $dist "models"
$destModelRoot = Join-Path $dest "models"
$stash = $null
if (Test-Path -LiteralPath $destModelRoot -PathType Container) {
    $srcNames = [System.Collections.Generic.HashSet[string]]::new()
    if (Test-Path -LiteralPath $srcModelRoot -PathType Container) {
        foreach ($f in Get-ChildItem -LiteralPath $srcModelRoot -Recurse -File) {
            [void]$srcNames.Add($f.FullName.Substring($srcModelRoot.Length))
        }
    }
    $extra = @(Get-ChildItem -LiteralPath $destModelRoot -Recurse -File | Where-Object {
        -not $srcNames.Contains($_.FullName.Substring($destModelRoot.Length))
    })
    if ($extra.Count) {
        $stash = Join-Path ([System.IO.Path]::GetTempPath()) ("pose_models_keep_" + [Guid]::NewGuid().ToString("N"))
        foreach ($f in $extra) {
            $keep = Join-Path $stash $f.FullName.Substring($destModelRoot.Length).Trim('\')
            $dir = Split-Path -Parent $keep
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
            Copy-Item -LiteralPath $f.FullName -Destination $keep -Force
        }
    }
}

# /MIR 只清 dist/ 里上一版的多余文件：产物是可重建的缓存，场景与素材不在镜像范围内
robocopy $dist $dest /MIR /NFL /NDL /NJH /NP | Out-Null
if ($LASTEXITCODE -ge 8) {
    if ($stash) { Remove-Item -LiteralPath $stash -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host "同步失败（robocopy 退出码 $LASTEXITCODE）" -ForegroundColor Red
    exit 1
}

$kept = 0
if ($stash) {
    foreach ($f in Get-ChildItem -LiteralPath $stash -Recurse -File) {
        $back = Join-Path $destModelRoot $f.FullName.Substring($stash.Length).Trim('\')
        $dir = Split-Path -Parent $back
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Copy-Item -LiteralPath $f.FullName -Destination $back -Force
        $kept++
    }
    Remove-Item -LiteralPath $stash -Recurse -Force -ErrorAction SilentlyContinue
}

# 摆姿包是 MIT 作品：随产物带上它的许可证与致谢，装出来的页面不能只剩一份没有出处的代码
$attribution = @("LICENSE", "LICENSE.md", "NOTICE", "NOTICE.md", "THIRD-PARTY-NOTICES.md")
$copied = 0
foreach ($name in $attribution) {
    $src = Join-Path $repo $name
    if (Test-Path -LiteralPath $src -PathType Leaf) {
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $copied++
    }
}

$files = Get-ChildItem -LiteralPath $dest -Recurse -File
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
Write-Host "摆姿包已落进 $dest" -ForegroundColor Green
Write-Host ("  {0} 个文件，{1:N1} MB，许可证文件 {2} 份" -f $files.Count, ($bytes / 1MB), $copied)
Write-Host "刷新 Neo Studio 窗口的「3D 摆姿」页即可生效（页面逐请求判断装没装，不必重启）。"
exit 0
