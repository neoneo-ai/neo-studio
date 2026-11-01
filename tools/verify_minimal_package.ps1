# Neo Studio 最小整合包验收脚本：先跑整包自检，再核对自检管不到的三件事。
# 用法：tools\verify_minimal_package.ps1 [-Package D:\Work\projects\NeoStudio-Minimal]
param([string]$Package = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'NeoStudio-Minimal'))
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path -LiteralPath $Package)) { throw "整合包不存在：$Package" }

$comfyui = Join-Path $Package 'ComfyUI'
$studio = Join-Path $Package 'Neo-Studio'
$plugins = Join-Path $comfyui 'custom_nodes'
$manifest = Get-Content -LiteralPath (Join-Path $Repo 'tools\minimal_plugins.json') -Raw | ConvertFrom-Json
$fail = 0

function Check($label, $ok) {
    if ($ok) { "[OK]   $label" } else { "[FAIL] $label"; $script:fail = 1 }
}

# 1) 整包自检（布局、空 models、盘符路径、密钥、krea2edit、节点可满足性、插件清单）
$py = Join-Path $Package 'python\python.exe'
if (-not (Test-Path -LiteralPath $py)) { $py = (Get-Command python -ErrorAction SilentlyContinue).Source }
if (-not $py) { throw "没有可用的 python.exe 跑自检" }
& $py (Join-Path $Repo 'tools\check_minimal_package.py') --package $Package
if ($LASTEXITCODE) { $fail = 1 }

# 2) 清单里的必需插件都要在包内，排除的插件一个都不能在
foreach ($p in $manifest.required) {
    Check "必需插件 $($p.name)" (Test-Path -LiteralPath (Join-Path $plugins $p.name))
}
foreach ($p in $manifest.excluded) {
    Check "排除插件 $($p.name) 不在包内" (-not (Test-Path -LiteralPath (Join-Path $plugins $p.name)))
}

# 3) 插件副本带的是当前预设集：删掉的预设不能复活
$shipped = Join-Path $plugins 'comfyui-neo-studio\skills\presets'
$source = Get-ChildItem -LiteralPath (Join-Path $Repo 'studio\skills\presets') -Directory | Select-Object -ExpandProperty Name
$present = Get-ChildItem -LiteralPath $shipped -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
Check "插件副本预设数 $($present.Count) == 源码预设数 $($source.Count)" ($present.Count -eq $source.Count)
Check "image_gen_image 预设不在包内" (-not ($present -contains 'image_gen_image'))
$missing = @($source | Where-Object { $present -notcontains $_ })
Check "源码预设全部随包" ($missing.Count -eq 0)
if ($missing) { "  缺：$($missing -join ', ')" }

# 4) 安装脚本与启动器在位
foreach ($f in 'NeoStudio.bat', 'NeoStudio.vbs', 'setup_runtime.bat', 'setup_app.bat', '组件清单.md') {
    Check "$f" (Test-Path -LiteralPath (Join-Path $Package $f))
}
foreach ($f in 'neo-studio-app.vbs', 'neo-studio.ps1', 'tools\install_plugin.ps1') {
    Check "Neo-Studio\$f" (Test-Path -LiteralPath (Join-Path $studio $f))
}

# 5) 体积概览：模型不随包发，models 树应当只有 .keep
$modelFiles = Get-ChildItem -LiteralPath (Join-Path $comfyui 'models') -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne '.keep' }
Check "models 里没有模型文件" ($modelFiles.Count -eq 0)
$bytes = (Get-ChildItem -LiteralPath $Package -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Sum Length).Sum
"[INFO] 整包体积 $([math]::Round($bytes / 1GB, 2))GB，文件 $((Get-ChildItem -LiteralPath $Package -Recurse -File -ErrorAction SilentlyContinue).Count) 个"

if ($fail) { "[FAIL] 验收未通过"; exit 1 }
"[PASS] 验收通过：$Package"
