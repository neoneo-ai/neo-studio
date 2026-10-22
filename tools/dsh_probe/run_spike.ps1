# dsh 内核探针入口（dev-only，tools/ 不进 Registry 包）。
# 四件事：查 Node 与 python、把 pinned 的 @deepseek-ai/dsh 装进探针目录、自检我们的 MCP 工具面、
# 跑三条任务各出一份 report。只写 tools/dsh_probe 与 data/dsh_probe，从不删任何东西。
param(
  [string]$ApiKey = "",
  [string]$ComfyUrl = "http://127.0.0.1:8188",
  [string]$DshVersion = "0.2.1-rc.2",
  [string]$Model = "deepseek-chat",
  [switch]$SelfTest
)
$ErrorActionPreference = "Stop"
$Probe = $PSScriptRoot
$Repo = (Resolve-Path (Join-Path $Probe "..\\..")).Path
$NpmPrefix = Join-Path $Probe "npm"
$Reports = Join-Path $Probe "reports"
$HostPy = Join-Path $Probe "dsh_host.py"

function Require($cmd, $msg) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Write-Host $msg; exit 1 }
}

Require node "找不到 node：dsh 要 Node 22.18 以上"
Require python "找不到 python"

if ($SelfTest) {
  & python (Join-Path $Repo "studio\mcp_server.py") --selftest
  exit $LASTEXITCODE
}

New-Item -ItemType Directory -Force -Path $NpmPrefix | Out-Null
$Dsh = Join-Path $NpmPrefix "node_modules\.bin\dsh.cmd"
if (-not (Test-Path $Dsh)) {
  # 本目录自带 package.json：npm 的项目根是向上找最近的 package.json，没有这份文件时
  # 安装会落进仓库根（它有自己的 package.json），把探针依赖写进项目的测试清单里。
  # --prefer-offline 是实测出来的：这台机器上 npm 的在线解析会挂死（CPU 冻结、零产出），
  # 走缓存 611 包 37 秒。
  Write-Host ("npm install 到 " + $NpmPrefix + "（只装探针目录，pinned " + $DshVersion + "）")
  Push-Location $NpmPrefix
  npm install --no-audit --no-fund --prefer-offline --loglevel=error
  Pop-Location
}
if (-not (Test-Path $Dsh)) { Write-Host ("dsh 没装出来：" + $Dsh); exit 1 }

if (-not $ApiKey) { $ApiKey = $env:DEEPSEEK_API_KEY }
if (-not $ApiKey) {
  Write-Host "要 -ApiKey 或环境变量 DEEPSEEK_API_KEY：sdk-minimal 那棵树只有 DeepSeek 的 API-key adapter"
  exit 1
}

$env:DEEPSEEK_API_KEY = $ApiKey
$env:DSH_MODEL = $Model
$env:NEO_MCP_COMFY_URL = $ComfyUrl
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Out = Join-Path $Reports $Stamp
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# 三条任务对着右栏的三条主路径：出图、导演配方跑单段、正文型技能走 generate_prompt
$Tasks = @(
  @{ id = "t1-image"; text = "先调 neo_status 确认 Neo Studio 在线，再用 list_skills 认一个纯文生图技能（references 为空就选 mode=t2i），然后 generate_image 出一张图：窗台上打盹的橘猫，暖色阳光，写实。出图后调 task_status 轮询到终态，并用 get_media 报产物名。" },
  @{ id = "t2-director"; text = "用导演配方做一条 3 段短片：先 list_skills 看技能、list_models 看主模型，然后 director_plan 分段、director_save 落一份新配方（名字带 spike 前缀），最后 segment_run 只跑第 1 段并用 task_status 轮询到终态。" },
  @{ id = "t3-skill"; text = "先 list_skills(all=true, q=正文) 找一份正文型技能（has_workflow=false），拿它调 generate_prompt 跑完它自己那套流程，把产出的那份文本交回来，不要逐段裸调生成工具。" }
)
foreach ($t in $Tasks) {
  $report = Join-Path $Out ($t.id + ".json")
  Write-Host ""
  Write-Host ("=== " + $t.id + " ===")
  & python $HostPy --task $t.text --session-id ($Stamp + "-" + $t.id) --out $report -v
  Write-Host ("report: " + $report)
}

Write-Host ""
Write-Host ("报告目录：" + $Out)
Write-Host "要读的四个数：turn.event_types 的事件词表、turn.usage 的逐轮 token、turn.inbound_requests 里闸的落点、stderr_tail 里 MCP 桥的超时与体积。"
