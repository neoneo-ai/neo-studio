# Neo Studio 最小整合包打包脚本：产出"装完就能跑、模型自己放"的文件夹。
# 产物 = ComfyUI 核心 + 清单里的必需插件 + Neo Studio（App 源码 + 装好的插件）+ 便携 Python + 相对路径启动器。
# 不随包发：模型、插件自带的 annotator/权重、.git、__pycache__、user 数据、密钥。
# 用法（仓库根运行）：tools\build_minimal_package.ps1 [-ComfyUI <ComfyUI root>] [-Target <包根>]
#       [-PluginMode copy|git] [-SkipPython] [-CoreOnly] [-SkipPluginDeps] [-DryRun] [-Zip]
param(
    [string]$ComfyUI = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'ComfyUI'),
    [string]$Target = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'NeoStudio-Minimal'),
    [ValidateSet('copy', 'git')][string]$PluginMode = 'copy',
    [string]$PythonVersion = '3.12.10',
    [string]$PythonSource = '',
    [switch]$SkipPython,
    [switch]$CoreOnly,
    [switch]$SkipPluginDeps,
    [switch]$DryRun,
    [switch]$Zip
)
$ErrorActionPreference = 'Stop'
$Studio = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'minimal_plugins.json') -Raw | ConvertFrom-Json
$Plugins = @($Manifest.required)
if ($CoreOnly) { $Plugins = @() }
if (-not $PythonSource) { $PythonSource = Join-Path (Split-Path $ComfyUI -Parent) 'python' }

function Log($m) { Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] $m" }
function Run($exe, [string[]]$a) {
    & $exe @a | Out-Host
    if ($LASTEXITCODE) { throw "$exe $($a -join ' ') 退出码 $LASTEXITCODE" }
}

function Copy-Tree($Source, $Dest, [string[]]$Xd = @(), [string[]]$Xf = @(), [switch]$Mir) {
    # robocopy 只拷数据流（/COPY:DAT），/XD /XF 把 .git、__pycache__、模型与插件自带权重挡在包外
    $Xd = @($Xd | Where-Object { $_ })
    $Xf = @($Xf | Where-Object { $_ })
    # /MIR 是重建成品包的 python\ 用的：源里没的（上一次构建降级出来的包）必须清掉，不然 site-packages 是混合版本
    $mode = if ($Mir) { '/MIR' } else { '/E' }
    $robo = @($Source, $Dest, $mode, '/COPY:DAT', '/NJH', '/NJS', '/NDL', '/NP', '/R:1', '/W:1')
    if ($Xd.Count) { $robo = $robo + '/XD' + $Xd }
    if ($Xf.Count) { $robo = $robo + '/XF' + $Xf }
    robocopy.exe @robo | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败($LASTEXITCODE)：$Source -> $Dest" }
    $global:LASTEXITCODE = 0
}

function Get-AppDeps($Pyproject) {
    # pip 25 的 -r pyproject.toml 把 [project] 当需求行读，直接报 Invalid requirement；App 依赖从这份声明里摘包名
    $text = Get-Content -LiteralPath $Pyproject -Raw -Encoding utf8
    $block = [regex]::Match($text, '(?m)^\s*dependencies\s*=\s*\[(.*?)\]', 'Singleline').Groups[1].Value
    @([regex]::Matches($block, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
}

function New-ModelsTree($Root) {
    # 生成的产物路径由 Neo Studio 插件配置决定，这些目录必须先存在，生成任务才不会写失败
    $sub = @('checkpoints', 'clip', 'clip_vision', 'configs', 'controlnet', 'diffusion_models',
             'embeddings', 'ipadapter', 'latent_custom_node', 'layerstyle', 'loras', 'lora_cache',
             'style_models', 'text_encoders', 'unet', 'upscale_models', 'vae', 'audio', 'audio/voices',
             'video', 'detection', 'backgrounds')
    foreach ($s in $sub) {
        $dir = Join-Path $Root ("models\$s")
        if ($DryRun) { Log "  models\$s"; continue }
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir '.keep') -Value '' -NoNewline
    }
}

function New-PluginDir($Plugin, $Dest) {
    # copy 模式直接搬现成的插件目录（自带权重按清单 strip 排除）；git 模式按清单 commit 从上游拉，
    # 只有 git 模式能核对落点 commit，copy 模式的落点就是开发机现在跑着的那份
    $src = Join-Path (Join-Path $ComfyUI 'custom_nodes') $Plugin.name
    if ($PluginMode -eq 'copy') {
        if (-not (Test-Path -LiteralPath $src)) { throw "插件源不存在：$src" }
        Log "插件 $($Plugin.name)：复制 $src（排除 $(@($Plugin.strip | Where-Object { $_ }) -join '/')）"
        if ($DryRun) { return }
        Copy-Tree $src $Dest (@('.git', '__pycache__') + @($Plugin.strip)) @('*.pyc')
        foreach ($strip in @($Plugin.strip | Where-Object { $_ })) {
            if (Test-Path -LiteralPath (Join-Path $Dest $strip)) { throw "$($Plugin.name) 的自带权重 $strip 没排除掉" }
        }
        return
    }
    Log "插件 $($Plugin.name)：git clone $($Plugin.repo) @ $($Plugin.commit.Substring(0, 8))"
    if ($DryRun) { return }
    if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
    Run 'git' @('clone', '--quiet', $Plugin.repo, $Dest)
    Run 'git' @('-C', $Dest, 'checkout', '--quiet', $Plugin.commit)
    Get-ChildItem -LiteralPath $Dest -Recurse -Directory -Include '__pycache__' | Remove-Item -Recurse -Force
    $real = (git -C $Dest rev-parse HEAD).Trim()
    if ($real -ne $Plugin.commit) { throw "$($Plugin.name) 落点 $($real.Substring(0,8)) 与清单 $($Plugin.commit.Substring(0,8)) 不一致" }
}


function Write-Launchers {
    # 启动器全用相对路径：VBS 从当前目录算包根，BAT 用 %~dp0，整包换盘符不用改任何东西
    $vbs = @(
        "' Neo Studio 整合包启动器：双击 NeoStudio.bat。ComfyUI 由桌面 App 作为子进程带起。",
        "' 模型放 ComfyUI\models\，包不随包发模型；用户数据落 Neo-Studio\data\。",
        'Option Explicit',
        'Dim sh, fso, root, pyw, exe, cmd',
        'Set sh = CreateObject("WScript.Shell")',
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'root = sh.CurrentDirectory',
        'If Right(root, 1) = "\" Then root = Left(root, Len(root) - 1)',
        'pyw = root & "\python\pythonw.exe"',
        'exe = root & "\Neo-Studio\app\studio_app.py"',
        'If Not fso.FileExists(pyw) Then',
        '    MsgBox "整合包缺 python\pythonw.exe。" & vbCrLf & "把 Python {0} 装进包根目录的 python\，" & vbCrLf & _',
        '           "或用 mklink /J 把 python\ 指到已装好的可移植 Python。", vbCritical, "Neo Studio"',
        '    WScript.Quit 1',
        'End If',
        'If Not fso.FileExists(exe) Then',
        '    MsgBox "整合包缺 Neo-Studio\app\studio_app.py。", vbCritical, "Neo Studio"',
        '    WScript.Quit 1',
        'End If',
        'cmd = Chr(34) & pyw & Chr(34) & " " & Chr(34) & exe & Chr(34)',
        'sh.Environment("Process")("PYTHONUTF8") = "1"   '' 插件打印非 ASCII 时 GBK 控制台会让 import 直接失败',
        'sh.CurrentDirectory = root & "\Neo-Studio"',
        'sh.Run cmd, 1, False'
    ) -join "`r`n"
    $vbs = $vbs -f $PythonVersion
    # WSH 只认带 BOM 的 UTF-16 中文脚本，写 ANSI 会让 MsgBox 变乱码
    Set-Content -LiteralPath (Join-Path $Target 'NeoStudio.vbs') -Value $vbs -Encoding unicode
    $bat = @('@echo off', 'setlocal', 'cd /d "%~dp0"', 'wscript "NeoStudio.vbs"') -join "`r`n"
    Set-Content -LiteralPath (Join-Path $Target 'NeoStudio.bat') -Value $bat -Encoding ascii
}

function Write-SetupScripts {
    # 两个 setup 脚本写死相对路径，安装者双击即可；pip 要联网，文案里说明
    # -c 约束取包内已装版本：插件要求的 numpy<2 这类约束会把包内 numpy 降级，pyarrow 当场废掉
    $pin = 'set PINS=%TEMP%\neo_studio_pins.txt'
    $pip = 'python\python.exe -m pip install --disable-pip-version-check -c "%PINS%"'
    $runtime = @(
        '@echo off', 'setlocal', 'cd /d "%~dp0"',
        'echo Deps ship pre-installed in python\. Run this only after replacing python\, or when Neo Studio says a dep is missing.',
        $pin,
        'python\python.exe -m pip list --format=freeze> "%PINS%" || goto :fail',
        "$pip -r ComfyUI\requirements.txt || goto :fail",
        "$pip -r Neo-Studio\studio\requirements.txt || goto :fail"
    ) + @(
        'rem plugin lists name the packages the plugin imports; their deps come from the two lines above',
        'rem --no-deps keeps pip from downgrading numpy for mediapipe and breaking pyarrow'
    ) + @($Plugins | ForEach-Object { "$pip --no-deps -r ComfyUI\custom_nodes\$($_.name)\requirements.txt || goto :fail" }) + @(
        'del "%PINS%" >nul 2>nul',
        'echo [OK] runtime deps installed. Next: setup_app.bat',
        'goto :eof',
        ':fail', 'del "%PINS%" >nul 2>nul',
        'echo [FAIL] pip install failed. Check the network and the python\ folder.', 'exit /b 1'
    ) -join "`r`n"
    $appDeps = @(Get-AppDeps (Join-Path $Studio 'pyproject.toml'))
    $app = @(
        '@echo off', 'setlocal', 'cd /d "%~dp0"',
        'echo Deps ship pre-installed in python\. Run this only after replacing python\, or when the window will not open.',
        $pin,
        'python\python.exe -m pip list --format=freeze> "%PINS%" || goto :fail',
        "$pip $($appDeps -join ' ') || goto :fail",
        'del "%PINS%" >nul 2>nul',
        'echo [OK] desktop app deps installed in python\. Next: NeoStudio.bat',
        'goto :eof',
        ':fail', 'del "%PINS%" >nul 2>nul',
        'echo [FAIL] pip install failed. Check the network.', 'exit /b 1'
    ) -join "`r`n"
    Set-Content -LiteralPath (Join-Path $Target 'setup_runtime.bat') -Value $runtime -Encoding ascii
    Set-Content -LiteralPath (Join-Path $Target 'setup_app.bat') -Value $app -Encoding ascii
}

function Write-PackageDoc {
    # 组件清单只写相对路径：整包换机器、换盘符都不用改文档
    $rows = @($Plugins | ForEach-Object { '| {0,-33} | 必需 | {1,-8} | {2,-55} |' -f $_.name, $_.commit.Substring(0, 8), ($_.nodes -join ', ') })
    if (-not $rows) { $rows = @('| （CoreOnly：本次没装必需插件）              |      |          |                                                       |') }
    $doc = @(
        '# Neo Studio 最小整合包',
        '',
        '装完就能跑，模型不随包发。ComfyUI 由 Neo Studio 桌面 App 作为子进程带起，不用单独启动。',
        '',
        '## 首次安装（按顺序跑一次）',
        '',
        '依赖（torch + CUDA、ComfyUI 内核依赖、Neo Studio 插件依赖、桌面 App 依赖）构建时已装进包内 `python\`，',
        '正常情况不用装东西：',
        '',
        '1. `NeoStudio.bat`      —— 打开 Neo Studio 窗口',
        '',
        '只有把包内 `python\` 换成了新的 Python、或窗口提示缺依赖时，才补跑这两个（要联网）：',
        '',
        '2. `setup_runtime.bat`  —— 装 ComfyUI 内核与插件依赖',
        '3. `setup_app.bat`      —— 装桌面 App 依赖（pywebview）',
        '',
        '依赖没装就双击也能开窗口：App 的引导页会说清缺哪一项。「启动设置」里有装依赖的按钮。',
        '',
        '## 目录',
        '',
        '| 名称                                       | 说明                                                  |',
        '| ------------------------------------------ | ----------------------------------------------------- |',
        ('| `python\`                                  | 便携 Python {0}；也可 `mklink /J` 指向已装好的 Python |' -f $PythonVersion),
        ('| `ComfyUI\`                                 | ComfyUI {0} 核心（commit {1}）+ 必需插件              |' -f $Manifest.comfyui.version, $Manifest.comfyui.commit.Substring(0, 8)),
        '| `ComfyUI\models\`                          | 空目录树，模型放这里                                  |',
        '| `ComfyUI\custom_nodes\comfyui-neo-studio\` | Neo Studio 插件（生成入口）                           |',
        '| `Neo-Studio\`                              | 桌面 App 源码、启动脚本、`tools\install_plugin.ps1`   |',
        '| `Neo-Studio\data\`                         | 首次启动生成的用户数据（图库、配置、配方）            |',
        '',
        '## 插件清单',
        '',
        '| 插件                              | 角色 | commit   | 提供节点                                                  |',
        '| --------------------------------- | ---- | -------- | --------------------------------------------------------- |',
        ($rows -join "`r`n"),
        ('| {0,-33} | 必需 | {1,-8} | {2,-55} |' -f 'comfyui-neo-studio', '随源码', 'NeoImageGen 等 Neo Studio 生成节点'),
        '',
        '清单文件 `Neo-Studio\tools\minimal_plugins.json`。`comfyui-krea2edit` 明确排除，别装回来。',
        '',
        '## 模型与权重',
        '',
        '- 图/视频：模型放进 `ComfyUI\models\` 对应子目录（`checkpoints`、`diffusion_models`、`text_encoders`、`vae`、`loras`、`controlnet`）。',
        '- ControlNet 预处理：`comfyui_controlnet_aux` 首次运行 `AIO_Preprocessor` 时自己下载 annotator 模型到 `custom_nodes\comfyui_controlnet_aux\anmodels`。',
        '- 语音：`comfyui_fl-cosyvoice3` 的权重（约 1.4GB）不随包发；要用的话放回 `ComfyUI\custom_nodes\comfyui_fl-cosyvoice3\FL_CosyVoice3\`。',
        '- 这个语音插件启动时打印非 ASCII 横幅，输出编码不是 UTF-8 时导入会失败；`NeoStudio.bat` 已把 `PYTHONUTF8=1` 传进去，单独跑 ComfyUI 时自己带上。',
        '- 音色上传后落 `ComfyUI\models\audio\voices`，生成产物落 `models\audio` 与 `models\video`。',
        '- 依赖：torch + CUDA 与全部插件、App 依赖在构建时已装进包内 `python\`，包开箱即用，不用再装。',
        '- `mediapipe`（ControlNet 的 face 类预处理器）与 `whisper` 在 numpy 2.5 下 import 失败；要用就 `python\python.exe -m pip install "numpy<2"` 后重启 ComfyUI。',
        '',
        '## 自检',
        '',
        '装完跑一次：`python\python.exe Neo-Studio\tools\check_minimal_package.py --package .`',
        '核对必需节点、插件依赖 import、空 models 树、无盘符路径、无密钥文件、无 comfyui-krea2edit 痕迹。',
        ''
    ) -join "`r`n"
    Set-Content -LiteralPath (Join-Path $Target '组件清单.md') -Value $doc -Encoding utf8
}

$EXTRA_YAML = @(
    '# Neo Studio 整合包：模型全部放 ComfyUI\models\，本文件只引用包内相对路径',
    '# 值必须是字符串：ComfyUI 的 extra_config 对每个键做 split，写 true 会直接崩',
    'neo_studio_minimal:',
    '    base_path: ./',
    '    is_default: true',
    '    checkpoints: models/checkpoints/',
    '    configs: models/configs/',
    '    diffusion_models: |',
    '        models/diffusion_models/',
    '        models/unet/',
    '    vae: models/vae/',
    '    text_encoders: |',
    '        models/text_encoders/',
    '        models/clip/',
    '    clip: models/clip/',
    '    clip_vision: models/clip_vision/',
    '    controlnet: models/controlnet/',
    '    loras: models/loras/',
    '    lora_cache: models/lora_cache/',
    '    embeddings: models/embeddings/',
    '    ipadapter: models/ipadapter/',
    '    latent_custom_node: models/latent_custom_node/',
    '    layerstyle: models/layerstyle/',
    '    style_models: models/style_models/',
    '    unet: models/unet/',
    '    upscale_models: models/upscale_models/',
    '    vae_approx: models/vae_approx/',
    '    audio: models/audio/',
    '    video: models/video/',
    '    detection: models/detection/',
    '    backgrounds: models/backgrounds/',
    ''
) -join "`r`n"

Log "源 ComfyUI   : $ComfyUI ($($Manifest.comfyui.version) @ $($Manifest.comfyui.commit.Substring(0, 8)))"
Log "源 Neo-Studio: $Studio"
Log "目标         : $Target   插件模式: $PluginMode   DryRun: $DryRun"
if (-not (Test-Path -LiteralPath (Join-Path $ComfyUI 'main.py'))) { throw "找不到 ComfyUI 根目录：$ComfyUI" }
if (-not (Test-Path -LiteralPath (Join-Path $Studio 'app\studio_app.py'))) { throw "找不到 Neo Studio 源码：$Studio" }

$comfyDest = Join-Path $Target 'ComfyUI'
$studioDest = Join-Path $Target 'Neo-Studio'
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $Target | Out-Null }

Log 'ComfyUI 核心'
if ($DryRun) {
    Log "  复制 $ComfyUI -> $comfyDest（排除 .git/__pycache__/custom_nodes/user/output/input/temp）"
}
else {
    # 顶层排除项给全路径：/XD 按名字匹配会连 comfy\ldm\models、comfy_api\input 这种代码包一起排掉
    Copy-Tree $ComfyUI $comfyDest ((Join-Path $ComfyUI 'models'), (Join-Path $ComfyUI 'custom_nodes'),
                                    (Join-Path $ComfyUI 'user'), (Join-Path $ComfyUI 'output'),
                                    (Join-Path $ComfyUI 'input'), (Join-Path $ComfyUI 'temp'),
                                    (Join-Path $ComfyUI 'tests'), (Join-Path $ComfyUI 'tmp'),
                                    (Join-Path $ComfyUI 'x'), '.git', '__pycache__', '.venv', 'venv',
                                    '.cache', '.pytest_cache', '.ruff_cache', '.qwen', '.clinerules',
                                    '.vscode') @('*.pyc')
}

foreach ($p in $Plugins) { New-PluginDir $p (Join-Path $comfyDest "custom_nodes\$($p.name)") }

Log 'Neo Studio：App 源码 + 装好的插件'
if ($DryRun) {
    Log "  复制 $Studio -> $studioDest（排除 .git/.venv/data/dist/__pycache__）"
    Log "  复制 $studioDest\studio -> $comfyDest\custom_nodes\comfyui-neo-studio（排除 tests）"
}
else {
    Copy-Tree $Studio $studioDest @('.git', '.venv', 'data', 'dist', 'build', '__pycache__', 'tmp') @('*.pyc', 'data_root.json')
    Copy-Tree (Join-Path $studioDest 'studio') (Join-Path $comfyDest 'custom_nodes\comfyui-neo-studio') @('.git', '__pycache__', 'tests') @('*.pyc', 'data_root.json')
}

if ($SkipPython) {
    Log '跳过 Python 复制：写 python.link.txt'
    $note = "要复用已装好的可移植 Python，在包根目录执行：`r`n    mklink /J python ""<可移植 Python 根目录>""`r`n启动器只认包内的 python\pythonw.exe。"
    if (-not $DryRun) { Set-Content -LiteralPath (Join-Path $Target 'python.link.txt') -Value $note -Encoding utf8 }
}
elseif (Test-Path -LiteralPath (Join-Path $PythonSource 'pythonw.exe')) {
    Log "便携 Python: $PythonSource"
    $pyDest = Join-Path $Target 'python'
    # 用户用 mklink /J 把包内 python\ 指到他的可移植 Python 时，/MIR 会去清他那份 Python
    $link = Get-Item -LiteralPath $pyDest -Force -ErrorAction SilentlyContinue
    if ($link -and $link.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        Log '  包内 python\ 已是指向外部 Python 的链接：不复制、不清它，依赖装进它'
    }
    elseif (-not $DryRun) { Copy-Tree $PythonSource $pyDest @('__pycache__') @('*.pyc') -Mir }
}
else {
    Log "找不到 $PythonSource\pythonw.exe：写 python.link.txt 说明"
    $note = "把便携 Python $PythonVersion 放到包根目录的 python\，或执行：`r`n    mklink /J python ""<可移植 Python 根目录>"""
    if (-not $DryRun) { Set-Content -LiteralPath (Join-Path $Target 'python.link.txt') -Value $note -Encoding utf8 }
}

Log 'models 空目录树 + extra_model_paths.yaml'
if ($DryRun) {
    New-ModelsTree $comfyDest
    Log '  写 extra_model_paths.yaml（只指 models/ 下相对路径）'
}
else {
    New-ModelsTree $comfyDest
    Set-Content -LiteralPath (Join-Path $comfyDest 'extra_model_paths.yaml') -Value $EXTRA_YAML -Encoding utf8
    Write-Launchers
    Write-SetupScripts
    Write-PackageDoc
}

if (-not $DryRun -and -not $SkipPluginDeps) {
    # 依赖预装进包内 python\：包开箱即用，setup_*.bat 只剩换掉 python\ 之后的修复路径。
    # 约束取包内已装版本：不加约束时 mediapipe 要求的 numpy<2 会把 numpy 降级，pyarrow 当场导入不了
    $pipPy = Join-Path $Target 'python\python.exe'
    if (-not (Test-Path -LiteralPath $pipPy)) {
        Log '包内没有 python\python.exe：依赖没预装，装完 Python 后跑 setup_runtime.bat → setup_app.bat'
    }
    else {
        $pins = @(& $pipPy -m pip list --format=freeze 2>&1 | Where-Object { $_ -match '^[A-Za-z0-9_.-]+==' })
        $pinFile = Join-Path $env:TEMP 'neo_studio_minimal_pins.txt'
        Set-Content -LiteralPath $pinFile -Value ($pins -join "`r`n") -Encoding ascii
        $reqs = @((Join-Path $comfyDest 'requirements.txt'), (Join-Path $studioDest 'studio\requirements.txt'))
        foreach ($p in $Plugins) { $reqs += (Join-Path $comfyDest "custom_nodes\$($p.name)\requirements.txt") }
        foreach ($req in $reqs) {
            if (-not (Test-Path -LiteralPath $req)) { continue }
            Log "预装依赖 <- $req"
            $pip = & $pipPy -m pip install --disable-pip-version-check -c $pinFile -r $req 2>&1
            if ($LASTEXITCODE) {
                # mediapipe 要 numpy<2、pyarrow 要 numpy>=2：带约束时 pip 解不出这种对撞，退 1
                Log "  带约束解不动（$(($pip | Select-Object -Last 1))）；改 --no-deps 只装清单里列的那几个包"
                & $pipPy -m pip install --disable-pip-version-check --no-deps -r $req 2>&1 | Out-Null
                if ($LASTEXITCODE) { Log "  警告：$req 没装完（退出码 $LASTEXITCODE），目标机上跑 setup_runtime.bat 补装" }
            }
        }
        $appDeps = @(Get-AppDeps (Join-Path $studioDest 'pyproject.toml'))
        if ($appDeps) {
            Log "预装 App 依赖 -> $($appDeps -join ' ')"
            & $pipPy -m pip install --disable-pip-version-check -c $pinFile @appDeps 2>&1 | Out-Null
            if ($LASTEXITCODE) { Log "  警告：App 依赖没装完（退出码 $LASTEXITCODE），目标机上跑 setup_app.bat 补装" }
        }
        Remove-Item -LiteralPath $pinFile -Force -ErrorAction SilentlyContinue
    }
}

if (-not $DryRun) {
    Log '整包自检'
    $py = Join-Path $Target 'python\python.exe'
    if (-not (Test-Path -LiteralPath $py)) { $py = (Get-Command python -ErrorAction SilentlyContinue).Source }
    if ($py) { Run $py @((Join-Path $studioDest 'tools\check_minimal_package.py'), '--package', $Target) }
    else { Log '  没有可用 python.exe，自检跳过（装完 Python 后自己跑一次）' }
}

if ($Zip -and -not $DryRun) {
    $zipPath = "$Target-$(Get-Date -Format 'yyyyMMdd').zip"
    Log "压缩整包 -> $zipPath（含 python\，耗时较长）"
    Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $Target | ForEach-Object { $_.FullName }) -DestinationPath $zipPath -Force
}

Log "完成：$Target"
Log '下一步：直接双击 NeoStudio.bat（依赖已装进包内 python\，setup_*.bat 是修复路径）'

