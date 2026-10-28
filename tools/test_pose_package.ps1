# 随包摆姿包的自检：读 studio\pose_dist，按 MANIFEST.json 逐文件核对，并挡住那几条「不该发货」的形态。
#
# 与 tools\build_pose_package.ps1 的构建期校验同一口径，两处各一份的理由不同：构建时挡住是防止发出去，
# 这条是装机后（以及改了包之后）能复查 —— 有人手工往 pose_dist 里塞了 GLB 或 .map，构建脚本不会知道，
# 这条会。授权口径也在这一条里钉住：随包 GLB 白名单外的素体（Mixamo / SMPL 派生）一条都不许多。
#
# 从仓库根跑：
#   pwsh tools\test_pose_package.ps1
#   pwsh tools\test_pose_package.ps1 -Dist D:\somewhere\pose_dist
param(
    [string]$Dist = "",
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path -LiteralPath "$PSScriptRoot\..").Path
$root = if ($Dist) { $Dist } else { Join-Path $repo "studio\pose_dist" }

# 与构建脚本同值：加任何一个 GLB 要先在摆姿仓库的 ATTRIBUTION 里有可再分发的授权行
$allowedGlb = @("ybot.glb")
$maxPackageBytes = 4.5 * 1MB
$required = @("index.html", "LICENSE", "THIRD-PARTY.md", "MANIFEST.json",
              "models/ATTRIBUTION.md", "models/ybot.glb", "models/props/index.json")

$problems = [System.Collections.Generic.List[string]]::new()
function Bad([string]$msg) { $problems.Add($msg) }

if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    Write-Host "找不到随包摆姿包：$root（跑 pwsh tools\build_pose_package.ps1 先生成）" -ForegroundColor Red
    exit 1
}
$root = (Resolve-Path -LiteralPath $root).Path

$files = @(Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
    [pscustomobject]@{
        path  = $_.FullName.Substring($root.Length + 1).Replace("\", "/")
        bytes = [int]$_.Length
        full  = $_.FullName
    }
})
$paths = @($files | ForEach-Object { $_.path })

# 1. 必需文件：缺任何一个，装完机的页面就是少一块（入口页、授权、清单、素体、道具注册表）
foreach ($name in $required) {
    if ($paths -notcontains $name) { Bad "缺文件：$name" }
}

# 2. 产物形状：入口页要有 assets 里那一对 js/css，vite 的哈希名字换版会变，条数不能变
$js = @($files | Where-Object { $_.path -like "assets/index-*.js" })
$css = @($files | Where-Object { $_.path -like "assets/index-*.css" })
if ($js.Count -ne 1) { Bad "assets/ 里的 index-*.js 应是一份，实测 $($js.Count)" }
if ($css.Count -ne 1) { Bad "assets/ 里的 index-*.css 应是一份，实测 $($css.Count)" }

# 3. 不该发货的形态：map（4.4 MB 且只给 devtools 用）、白名单外的 GLB、道具 GLB、
#    models 根下的散 JSON（注册表只在 models/props/ 里）、摆姿仓库的动画 demo 文件
foreach ($row in $files) {
    if ($row.path -like "*.map") { Bad "随包发了 source map：$($row.path)" }
    if ($row.path -like "models/*.glb" -and $allowedGlb -notcontains (Split-Path -Leaf $row.path)) {
        Bad "随包发了白名单外的素体 GLB：$($row.path)"
    }
    if ($row.path -like "models/props/*.glb") { Bad "随包发了道具 GLB：$($row.path)" }
    if ($row.path -like "models/*.json" -and $row.path -notlike "models/props/*") {
        Bad "models/ 根下发了散 JSON：$($row.path)"
    }
    if ($row.path -like "*animation-demo*") { Bad "随包发了动画 demo 相关文件：$($row.path)" }
}

# 4. 逐文件核对发货清单：清单说的字节数与 sha256 要等于盘上那份，清单也必须覆盖整包。
#    清单自己不算在内：一份清单算不出自己的哈希（写进去就变了），这条口径与构建脚本一致。
$manifestPath = Join-Path $root "MANIFEST.json"
$total = ($files | Measure-Object -Property bytes -Sum).Sum
$listedScope = @($files | Where-Object { $_.path -ne "MANIFEST.json" })
$listedScopeTotal = ($listedScope | Measure-Object -Property bytes -Sum).Sum
if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($manifest.format -ne "3dpose.package/1") { Bad "清单格式位不是 3dpose.package/1：$($manifest.format)" }
    $listed = @($manifest.files)
    $listedPaths = @($listed | ForEach-Object { $_.path })
    foreach ($row in $listedScope) {
        $entry = @($listed | Where-Object { $_.path -eq $row.path })
        if ($entry.Count -eq 0) { Bad "清单里没有这一份：$($row.path)" ; continue }
        $entry = $entry[0]
        if ([int]$entry.bytes -ne $row.bytes) {
            Bad "清单体积对不上：$($row.path) 清单 $([int]$entry.bytes)，盘上 $($row.bytes)"
        }
        $hash = (Get-FileHash -LiteralPath $row.full -Algorithm SHA256).Hash.ToLower()
        if ($entry.sha256 -ne $hash) { Bad "清单哈希对不上：$($row.path)" }
    }
    foreach ($p in $listedPaths) { if ($paths -notcontains $p) { Bad "清单里多出一份没有的文件：$p" } }
    if ([int]$manifest.total_bytes -ne $listedScopeTotal) {
        Bad "清单总体积对不上：清单 $([int]$manifest.total_bytes)，盘上 $listedScopeTotal"
    }
} else {
    Bad "缺发货清单：MANIFEST.json"
}

# 5. 道具注册表必须是空的：注册表里列一个包里没发的 GLB，就是发一条点了只会失败的控件
$regPath = Join-Path $root "models\props\index.json"
if (Test-Path -LiteralPath $regPath -PathType Leaf) {
    $reg = Get-Content -LiteralPath $regPath -Raw -Encoding utf8 | ConvertFrom-Json
    if (@($reg.props).Count -ne 0) {
        Bad "道具注册表不是空的（$( @($reg.props).Count) 条）：随包没发道具 GLB，注册表要先清空"
    }
}

# 6. 发布清洗：开发机的绝对路径不许烘在产物里（素体注册表的 sourceImage 曾把本机目录发出去）。
#    只看引号后紧跟「盘符 + 斜杠」的字面量：协议串（https://…）也是「字母: /」，不能一起算
$probe = "['" + [char]34 + [char]96 + "][A-Za-z]:[\\/]"
foreach ($row in $files) {
    if ($row.path -notlike "*.js") { continue }
    $text = [System.IO.File]::ReadAllText($row.full)
    if ($text -match 'sourceImage:\s*`[^`]+`') { Bad "产物里留着 sourceImage 的本机路径：$($row.path)" }
    if ($text -match $probe) { Bad "产物里仍有开发机绝对路径：$($row.path)" }
}

# 7. 随包素体要真是能解析的 GLB：页面对它跑 Draco，头不对就是整页选不到素体
foreach ($glb in $allowedGlb) {
    $p = Join-Path $root ("models\" + $glb)
    if (Test-Path -LiteralPath $p -PathType Leaf) {
        $bytes = [System.IO.File]::ReadAllBytes($p)
        if ($bytes.Length -lt 12 -or [System.Text.Encoding]::ASCII.GetString($bytes[0..3]) -ne "glTF") {
            Bad "随包素体不是合法 GLB：models/$glb"
        }
    }
}

# 8. 体积上限：这条是「随包分发」这个承诺本身，涨体积要先改授权口径与上限
if ($total -gt $maxPackageBytes) {
    Bad ("随包体积 {0:N2} MB 超过上限 {1:N1} MB" -f ($total / 1MB), ($maxPackageBytes / 1MB))
}

# 9. 发出去的是 git 里的那一份字节：清单比的是 sha256，而 git 存的是 LF 那份。core.autocrlf=true
#    的机器 checkout 出来带 CRLF，盘上字节与清单就全对不上，自检会指着正常的包报错。
#    这条把「仓库字节 == 盘上字节」钉住，仓库根 .gitattributes 的 -text 就是为了让它对得上
#    （口径见 docs/release.md）。只在这条跑的是仓库里那份时查，-Dist 指别处时不查。
$repoRoot = Join-Path $repo "studio\pose_dist"
$gitChecked = $false
if ((Resolve-Path -LiteralPath $root).Path -eq $repoRoot) {
    $gitChecked = $true
    $tracked = @{}
    foreach ($line in @(git -C $repo ls-files -s -- studio/pose_dist)) {
        $parts = "$line" -split '\s+'
        if ($parts.Count -ge 4) { $tracked[$parts[3].Replace("\", "/")] = $parts[1] }
    }
    if (-not $tracked.Count) { Bad "git 里没有 studio/pose_dist 的任何一份：随包发不出去" }
    foreach ($row in $files) {
        $gitPath = "studio/pose_dist/" + $row.path
        if (-not $tracked.ContainsKey($gitPath)) { Bad "git 里没有这一份，随包发不出去：$gitPath"; continue }
        $diskHash = "$(git -C $repo hash-object -- $gitPath)".Trim()
        if ($diskHash -ne $tracked[$gitPath]) {
            Bad "仓库里的那份与盘上不是同一份字节（行尾被转换了？）：$($row.path)"
        }
    }
}

if ($problems.Count) {
    Write-Host "随包摆姿包自检未通过：$root" -ForegroundColor Red
    foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
    exit 1
}

if (-not $Quiet) {
    Write-Host "随包摆姿包自检通过：$root" -ForegroundColor Green
    Write-Host ("  {0} 个文件，{1:N2} MB（上限 {2:N1} MB），清单逐文件 sha256 已核对" -f `
        $files.Count, ($total / 1MB), ($maxPackageBytes / 1MB))
    Write-Host "  随包 GLB：$($allowedGlb -join ', ')；自备素体走宿主面板「导入自备素体」，落点 <数据根>/pose/dist/models/"
    if ($gitChecked) { Write-Host "  逐文件字节与 git 索引里那份一致（随包发的就是仓库里那份）" }
}
exit 0