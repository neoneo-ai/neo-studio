# build_studio_update.ps1 - 生成整合包更新件 Neo-Studio-<版本>-package-update.zip
# 给「已经装好的整合包」用：普通用户在包根跑 tools\update_neo_studio.ps1，从 GitHub Release 拉这份 zip
# 刷新包里的 Neo Studio，ComfyUI 核心、清单插件、包内 python、模型与用户数据都不动。
# 内容边界 = 更新脚本要刷的那几样，按仓库相对路径原样摆进 zip：
#   studio/  = git 已跟踪文件减去开发目录（与 install_plugin.ps1、build_studio_exe.ps1 同一份排除）
#   app/     = 桌面 App 源码（tests 不进）
#   tools/   = 白名单：清单、整包自检、插件安装、更新脚本本身
#   根文件   = 桌面依赖清单、启动脚本、README / CHANGELOG / LICENSE
# 不发：仓库文档（docs/、Developer.md、AGENTS.md）、.github、tests、tools/ 里的开发脚本、数据根与密钥文件。
# 更新件的版本只有一个源：studio/pyproject.toml 的 version（util.plugin_version() 读的就是它）。
# 用法（仓库根运行）: tools\build_studio_update.ps1 [-OutFile <zip 路径>] [-DryRun]
param(
    [string]$OutFile = "",
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Add-Type -AssemblyName System.IO.Compression -ErrorAction SilentlyContinue

# 版本源只有一份：studio/pyproject.toml，这里不写死版本号
$Version = (Select-String -LiteralPath (Join-Path $Repo 'studio\pyproject.toml') -Pattern '^\s*version\s*=\s*"([0-9][^"]*)"').Matches[0].Groups[1].Value
if (-not $Version) { throw "读不到 studio/pyproject.toml 里的 version" }
if (-not $OutFile) { $OutFile = Join-Path $Repo ("build\Neo-Studio-$Version-package-update.zip") }

# 与 install_plugin.ps1 / build_studio_exe.ps1 同一份副本边界：锚定开头，^tools/ 不会误杀 web/studio/tools.js
$STUDIO_EXCLUDES = @(
    '^tests/', '^example_workflows/', '^assets/', '^__pycache__/', '^\.git/',
    '^node_modules/', '^\.gitignore$', '^package(-lock)?\.json$'
)
$APP_EXCLUDES = @('^tests/', '^__pycache__/', '^\.git/')
$TOOLS_FILES = @(
    'minimal_plugins.json', 'check_minimal_package.py', 'install_plugin.ps1',
    'update_neo_studio.ps1', 'build_studio_update.ps1'
)
$ROOT_FILES = @(
    'pyproject.toml', 'README.md', 'README_ZH.md', 'CHANGELOG.md', 'LICENSE',
    'neo-studio.bat', 'neo-studio-app.bat', 'neo-studio-app.vbs', 'neo-studio.ps1'
)

function Tracked-Files($Dir, [string[]]$Excludes) {
    # -z 用 NUL 分条 + 控制台切 UTF-8：默认输出把非 ASCII 转义成 "..."，中文提示词预设会丢
    $enc = [Console]::OutputEncoding
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $rel = (git -C (Join-Path $Repo $Dir) ls-files -z -- .) -split "`0" | Where-Object { $_ }
    [Console]::OutputEncoding = $enc
    @($rel | ForEach-Object { $_ -replace '\\', '/' } |
        Where-Object { $f = $_; -not (@($Excludes | Where-Object { $f -match $_ }).Count) })
}

$entries = @()
foreach ($rel in (Tracked-Files 'studio' $STUDIO_EXCLUDES)) { $entries += @{ rel = "studio/$rel"; src = (Join-Path $Repo ("studio\" + ($rel -replace '/', '\'))) } }
foreach ($rel in (Tracked-Files 'app' $APP_EXCLUDES)) { $entries += @{ rel = "app/$rel"; src = (Join-Path $Repo ("app\" + ($rel -replace '/', '\'))) } }
foreach ($rel in $TOOLS_FILES) { $entries += @{ rel = "tools/$rel"; src = (Join-Path $Repo ("tools\" + $rel)) } }
foreach ($rel in $ROOT_FILES) { $entries += @{ rel = $rel; src = (Join-Path $Repo $rel) } }

$missing = @($entries | Where-Object { -not (Test-Path -LiteralPath $_.src) } | ForEach-Object { $_.rel })
if ($missing.Count) { throw "清单里点名、工作树里没有：$($missing -join ', ')" }
$bytes = ($entries | ForEach-Object { (Get-Item -LiteralPath $_.src).Length } | Measure-Object -Sum).Sum

Write-Host "[PLAN] Neo-Studio-$Version-package-update.zip  $($entries.Count) 个文件  $([math]::Round($bytes / 1MB, 2)) MB" -ForegroundColor Cyan
Write-Host ("[PLAN] studio {0} / app {1} / tools {2} / 根文件 {3}" -f @(
    @($entries | Where-Object { $_.rel -like 'studio/*' }).Count,
    @($entries | Where-Object { $_.rel -like 'app/*' }).Count,
    @($entries | Where-Object { $_.rel -like 'tools/*' }).Count,
    @($entries | Where-Object { $_.rel -notlike '*/*' }).Count)) -ForegroundColor Cyan
if ($DryRun) { Write-Host '[DRY] 未写文件' -ForegroundColor Green; exit 0 }

New-Item -ItemType Directory -Force -Path (Split-Path $OutFile -Parent) | Out-Null
if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
# 条目名显式 UTF-8：中文预设名用系统代码页写进 zip，解包时名字就是乱码，插件加载直接少文件
$zip = [IO.Compression.ZipFile]::Open($OutFile, 'Create', [Text.Encoding]::UTF8)
try {
    foreach ($e in $entries) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $e.src, $e.rel) | Out-Null }
    $meta = [ordered]@{
        version       = $Version
        kind          = 'neo-studio-package-update'
        generated_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        files         = $entries.Count
    }
    $entry = $zip.CreateEntry('UPDATE.json')
    $w = New-Object IO.StreamWriter($entry.Open(), (New-Object Text.UTF8Encoding($false)))
    $w.Write(($meta | ConvertTo-Json)); $w.Close()
} finally { $zip.Dispose() }

$zipBytes = (Get-Item -LiteralPath $OutFile).Length
Write-Host ("[DONE] $OutFile  {0:N1} MB" -f ($zipBytes / 1MB)) -ForegroundColor Green
Write-Host ("[DONE] sha256 {0}" -f (Get-FileHash -LiteralPath $OutFile -Algorithm SHA256).Hash.ToLower()) -ForegroundColor Green
Write-Host '[NEXT] 挂到 Release：gh release upload v<版本> 这份 zip（release-app.yml 已自动做）' -ForegroundColor Green