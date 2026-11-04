# update_neo_studio.ps1 - 把整合包里的 Neo Studio 更新到 GitHub Release 上的版本
# 只刷包里的 Neo Studio：Neo-Studio\（App 源码 + studio 副本 + tools 脚本 + 启动脚本）与
# ComfyUI\custom_nodes\comfyui-neo-studio\ 的代码副本，再往包内 python 补一次依赖，最后跑整包自检。
# ComfyUI 核心、清单里的必需插件、包内 python、模型与用户数据（Neo-Studio\data\、插件里的
# configs / gallery / locals / prompts / recipes / skills）一律不动：robocopy 不带 /MIR，
# 目标目录里同名代码被覆盖、其余文件原样留下，被覆盖的那几个先备份进包根 updates\backup-<旧版本>\。
# 联网只在跑这条脚本时发生一次（取 Release 与下载更新件），没有后台检查。机器连不上 GitHub 就在
# 能联网的机器上把更新件下下来，用 -Zip 指到本地那份。
# 用法（包根运行，pwsh；脚本是 UTF-8 无 BOM，Windows PowerShell 5.1 会把中文注释读成乱码）：
#   pwsh Neo-Studio\tools\update_neo_studio.ps1                       # 更新到 Release 最新版
#   pwsh Neo-Studio\tools\update_neo_studio.ps1 -Version 1.6.1       # 更新到指定版本
#   pwsh Neo-Studio\tools\update_neo_studio.ps1 -Zip <更新件.zip>    # 离线：用已下好的更新件
#   pwsh Neo-Studio\tools\update_neo_studio.ps1 -DryRun              # 只打印要做的事
param(
    [string]$Package = "",
    [string]$Version = "",
    [string]$Zip = "",
    [string]$Proxy = "",
    [switch]$SkipDeps,
    [switch]$Force,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression -ErrorAction SilentlyContinue
$ApiRoot = 'https://api.github.com/repos/neoneo-ai/neo-studio/releases'

function Log($m) { Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] $m" }
function WithProxy($uri, $outFile) {
    # 代理客户端接管 DNS 的机器直连连 api.github.com 都解析不到，这时把 -Proxy 指到本机代理
    if ($Proxy) { if ($outFile) { Invoke-WebRequest -Uri $uri -OutFile $outFile -Proxy $Proxy -TimeoutSec 120 } else { Invoke-RestMethod -Uri $uri -Proxy $Proxy -TimeoutSec 30 } }
    else { if ($outFile) { Invoke-WebRequest -Uri $uri -OutFile $outFile -TimeoutSec 120 } else { Invoke-RestMethod -Uri $uri -TimeoutSec 30 } }
}
function Read-PyVersion($Pyproject) {
    # 版本只有一个源：studio/pyproject.toml（util.plugin_version() 读的就是它）
    (Select-String -LiteralPath $Pyproject -Pattern '^\s*version\s*=\s*"([0-9][^"]*)"').Matches[0].Groups[1].Value
}
function Get-AppDeps($Pyproject) {
    # pip 25 的 -r pyproject.toml 把 [project] 当需求行读，直接报 Invalid requirement；App 依赖从这份声明里摘包名
    $text = Get-Content -LiteralPath $Pyproject -Raw -Encoding utf8
    $block = [regex]::Match($text, '(?m)^\s*dependencies\s*=\s*\[(.*?)\]', 'Singleline').Groups[1].Value
    @([regex]::Matches($block, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
}
function Sync-Tree($Src, $Dst, [string[]]$Xf) {
    # /E 不带 /MIR：整合包里的用户数据与配置不能被这次更新删掉，只覆盖同名文件
    $robo = @($Src, $Dst, '/E', '/COPY:DAT', '/NJH', '/NJS', '/NDL', '/NP', '/R:1', '/W:1', '/XD', '__pycache__', '/XF', '*.pyc')
    if ($Xf.Count) { $robo = $robo + '/XF' + $Xf }
    robocopy.exe @robo | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败($LASTEXITCODE)：$Src -> $Dst" }
    $global:LASTEXITCODE = 0
}
function Backup-Files($SrcRoot, $DstRoot, $Tag) {
    # 只备份更新件点名的文件：用户配置与密钥不在更新件里，也就不会被抄进包内的备份目录
    $n = 0
    foreach ($f in Get-ChildItem -LiteralPath $SrcRoot -Recurse -File) {
        $rel = $f.FullName.Substring($SrcRoot.Length).Trim('\')
        $cur = Join-Path $DstRoot $rel
        if (-not (Test-Path -LiteralPath $cur)) { continue }
        $bak = Join-Path $BackupDir ($Tag + '\' + $rel)
        New-Item -ItemType Directory -Force -Path (Split-Path $bak -Parent) | Out-Null
        Copy-Item -LiteralPath $cur -Destination $bak -Force
        $n++
    }
    return $n
}

# 包根：在包内跑就从脚本自己的位置往上算，在仓库里跑就按整合包默认落点推
if (-not $Package) {
    $guess = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    if (Test-Path -LiteralPath (Join-Path $guess 'ComfyUI\main.py')) { $Package = $guess }
    else { $Package = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'NeoStudio-Minimal' }
}
$Package = (Resolve-Path $Package).Path
$studioDest = Join-Path $Package 'Neo-Studio'
$pluginDest = Join-Path $Package 'ComfyUI\custom_nodes\comfyui-neo-studio'
foreach ($must in @((Join-Path $studioDest 'app\studio_app.py'), $pluginDest)) {
    if (-not (Test-Path -LiteralPath $must)) { throw "整合包根不对（缺 $must）：$Package" }
}
$curVer = Read-PyVersion (Join-Path $studioDest 'studio\pyproject.toml')
$py = Join-Path $Package 'python\python.exe'
$updatesDir = Join-Path $Package 'updates'
Log "整合包   : $Package"
Log "包内版本 : $curVer"

$targetVer = ''
$shaExpected = ''
$asset = $null
if ($Zip) {
    $zipPath = (Resolve-Path $Zip).Path
    $z = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $entry = $z.GetEntry('UPDATE.json')
        if (-not $entry) { throw "这份 zip 不是整合包更新件（里面没有 UPDATE.json）：$zipPath" }
        $meta = ConvertFrom-Json (New-Object IO.StreamReader($entry.Open(), [Text.Encoding]::UTF8)).ReadToEnd()
    } finally { $z.Dispose() }
    $targetVer = $meta.version
}
else {
    if ($Version) { $rel = WithProxy "$ApiRoot/tags/v$Version" } else { $rel = WithProxy "$ApiRoot/latest" }
    $targetVer = $rel.tag_name -replace '^v', ''
    $assetName = "Neo-Studio-$targetVer-package-update.zip"
    $asset = @($rel.assets | Where-Object { $_.name -eq $assetName }) | Select-Object -First 1
    if (-not $asset) { throw "v$targetVer 的 Release 没有 $assetName（整合包更新件从下一版起随 Release 发）；在仓库根跑 tools\build_studio_update.ps1 自己出一份，再用 -Zip 指过来" }
    $shaExpected = ($asset.digest -replace '^sha256:', '')
    Log "Release   : $($rel.tag_name)  更新件 $($asset.name) $([math]::Round($asset.size / 1MB, 1)) MB"
}

if ([version]$targetVer -le [version]$curVer -and -not $Force) {
    Log "已是最新（包内 $curVer，目标 $targetVer）；要重装同一版本加 -Force"
    exit 0
}
Log "更新计划 : $curVer -> $targetVer"
Log '  刷 Neo-Studio\（App 源码 + studio 副本 + tools 脚本 + 启动脚本）'
Log '  刷 ComfyUI\custom_nodes\comfyui-neo-studio（代码副本，configs\data_root.json 指针不动）'
if (-not $SkipDeps) { Log '  包内 python 补装 studio\requirements.txt 与桌面 App 依赖' }

New-Item -ItemType Directory -Force -Path $updatesDir | Out-Null
if (-not $Zip) {
    $zipPath = Join-Path $updatesDir $asset.name
    Log "下载更新件 -> $zipPath"
    WithProxy $asset.browser_download_url $zipPath
    $sha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
    Log "sha256 $sha"
    if ($shaExpected -and $sha -ne $shaExpected) { throw "sha256 与 Release 的 digest 对不上：拿到 $sha，Release 写的是 $shaExpected" }
}
$stage = Join-Path $updatesDir "staging-$targetVer"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
Log "解包 -> $stage"
# 条目名按 UTF-8 读：中文提示词预设的名字按系统代码页解出来是乱码，落盘后插件加载直接少文件
[IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $stage, [Text.Encoding]::UTF8, $true)
foreach ($must in @('studio\__init__.py', 'app\studio_app.py', 'tools\check_minimal_package.py', 'studio\pyproject.toml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $must))) { throw "更新件缺 $must：$zipPath" }
}
$newVer = Read-PyVersion (Join-Path $stage 'studio\pyproject.toml')
if ($newVer -ne $targetVer) { throw "更新件里写的版本是 $newVer，期望 $targetVer" }

$BackupDir = Join-Path $updatesDir ("backup-$curVer-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$b1 = Backup-Files $stage $studioDest 'Neo-Studio'
$b2 = Backup-Files (Join-Path $stage 'studio') $pluginDest 'comfyui-neo-studio'
Log "备份 $b1 + $b2 个将被覆盖的文件 -> $BackupDir"

# data_root.json 是数据根指针（plugin_paths.write_pointer 写的那份），更新代码不能把用户的数据根挪走
Sync-Tree $stage $studioDest @('data_root.json', 'UPDATE.json')
Sync-Tree (Join-Path $stage 'studio') $pluginDest @('data_root.json')
Copy-Item -LiteralPath (Join-Path $stage 'UPDATE.json') -Destination (Join-Path $updatesDir "UPDATE-$targetVer.json") -Force
Move-Item -LiteralPath $stage -Destination (Join-Path $updatesDir "extracted-$targetVer") -Force
Log "已刷到 $newVer"

if (-not $SkipDeps) {
    if (-not (Test-Path -LiteralPath $py)) { Log '包内没有 python\python.exe：跳过依赖，装完 Python 后跑 setup_runtime.bat' }
    else {
        # 约束取包内已装版本：插件要求的 numpy<2 这类约束会把包内 numpy 降级，pyarrow 当场废掉
        # （打印非 ASCII 的插件在 GBK 控制台下 import 会失败，pip 与自检都带 PYTHONUTF8）
        $env:PYTHONUTF8 = '1'
        $pins = @(& $py -m pip list --format=freeze 2>&1 | Where-Object { $_ -match '==' })
        $pinFile = Join-Path $env:TEMP 'neo_studio_update_pins.txt'
        Set-Content -LiteralPath $pinFile -Value ($pins -join "`r`n") -Encoding ascii
        $req = Join-Path $studioDest 'studio\requirements.txt'
        Log '补装插件依赖 <- Neo-Studio\studio\requirements.txt'
        $pip = & $py -m pip install --disable-pip-version-check -c $pinFile -r $req 2>&1
        if ($LASTEXITCODE) {
            Log "  带约束解不动（$(($pip | Select-Object -Last 1))）；改 --no-deps 只装清单里列的那几个包"
            & $py -m pip install --disable-pip-version-check --no-deps -r $req 2>&1 | Out-Null
            if ($LASTEXITCODE) { Log "  警告：requirements 没装完（退出码 $LASTEXITCODE），跑 setup_runtime.bat 补装" }
        }
        $appDeps = @(Get-AppDeps (Join-Path $studioDest 'pyproject.toml'))
        if ($appDeps) {
            Log "补装 App 依赖 -> $($appDeps -join ' ')"
            & $py -m pip install --disable-pip-version-check -c $pinFile @appDeps 2>&1 | Out-Null
            if ($LASTEXITCODE) { Log "  警告：App 依赖没装完（退出码 $LASTEXITCODE），跑 setup_app.bat 补装" }
        }
        Remove-Item -LiteralPath $pinFile -Force -ErrorAction SilentlyContinue
    }
}

if (Test-Path -LiteralPath $py) {
    Log '整包自检'
    & $py (Join-Path $studioDest 'tools\check_minimal_package.py') --package $Package
    if ($LASTEXITCODE) { throw "整包自检未通过（退出码 $LASTEXITCODE）；被覆盖的文件备份在 $BackupDir" }
}
Log "完成：$curVer -> $newVer（ComfyUI 核心、清单插件、包内 python、模型与用户数据都没动）"
Log '下一步：重启 Neo Studio 生效；插件副本里的用户配置与素材数据原样保留'
Log '  跑 Neo-Studio\tools\check_minimal_package.py --package 自检'
if ($DryRun) { Log '[DRY] 未写文件'; exit 0 }