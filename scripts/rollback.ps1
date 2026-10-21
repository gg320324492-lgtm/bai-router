# B.AI 路由台 —— 一键回退到指定旧版本（不依赖应用内置更新器）
#
# 用法 A（交互选择，在目标电脑任意 PowerShell 窗口）：
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://github.com/gg320324492-lgtm/bai-router/releases/latest/download/rollback.ps1 -UseBasicParsing | iex"
#
# 用法 B（直接指定版本，先存成文件再跑）：
#   iwr https://github.com/gg320324492-lgtm/bai-router/releases/latest/download/rollback.ps1 -UseBasicParsing -OutFile "$env:TEMP\rollback.ps1"
#   & "$env:TEMP\rollback.ps1" 1.0.92
#
# 它做什么：
#   1. 列出 GitHub 上可用的版本（稳定版与测试版都列出来，测试版标出来）
#   2. 选一个 → 下载那个版本的安装包
#   3. 校验 sha512（对那个版本自己的 yml）与 Authenticode 签名
#   4. 关掉当前程序 → 静默安装旧版 → 重新启动
#
# ⚠ 顺序很重要：**先下载并校验完，才关程序、开安装器**。
#   这样下载失败/校验不过时，当前这份安装**一点都没被动过**——这是回退脚本
#   与「一键升级」脚本共同的红线：任何一步失败都不许把用户弄到「装不上」的状态。
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = "gg320324492-lgtm/bai-router"

Write-Host "查询可用版本..."
try {
  $rels = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=30" -Headers @{ "User-Agent" = "bai-rollback" }
} catch {
  throw "查不到版本列表：$($_.Exception.Message)"
}
if (-not $rels -or $rels.Count -eq 0) { throw "这个仓库一个 release 都没有" }

Write-Host ""
Write-Host "  序号  版本                说明"
Write-Host "  ----  ------------------  ------------------------------"
$pick = $null
for ($i = 0; $i -lt $rels.Count; $i++) {
  $r = $rels[$i]
  $ver = $r.tag_name -replace '^v', ''
  $has = @($r.assets | Where-Object { $_.name -match '^BARRouter-Setup-.*\.exe$' }).Count -gt 0
  if (-not $has) { continue }
  $tag = if ($r.prerelease) { "测试版（beta）" } else { "稳定版" }
  $mark = if ($r.prerelease) { " ←" } else { "" }
  Write-Host ("  {0,4}  {1,-18}  {2}{3}" -f ($i + 1), $ver, $tag, $mark)
  if ($null -eq $pick) { $pick = $r }
}
Write-Host ""

# 参数指定版本时用它，否则交互问。参数走脚本文件调用（用法 B）时才有。
$want = $null
if ($args -and $args.Count -ge 1 -and $args[0]) { $want = ([string]$args[0]).Trim() -replace '^v', '' }

if ($want) {
  $sel = $rels | Where-Object { ($_.tag_name -replace '^v', '') -eq $want } | Select-Object -First 1
  if (-not $sel) { throw "没有找到版本 $want" }
} else {
  $ans = Read-Host "回退到哪个版本？输入版本号（留空 = 最近一个）"
  if ($ans) {
    $ans = $ans.Trim() -replace '^v', ''
    $sel = $rels | Where-Object { ($_.tag_name -replace '^v', '') -eq $ans } | Select-Object -First 1
    if (-not $sel) { throw "没有找到版本 $ans" }
  } else {
    $sel = $rels | Where-Object { -not $_.prerelease } | Select-Object -First 1
    if (-not $sel) { $sel = $rels[0] }
  }
}

$ver = $sel.tag_name -replace '^v', ''
$asset = $sel.assets | Where-Object { $_.name -match '^BARRouter-Setup-.*\.exe$' } | Select-Object -First 1
if (-not $asset) { throw "release $($sel.tag_name) 里没有安装包" }

# 预发布版本（1.0.93-beta.1）当初发的是 beta.yml，稳定版发的是 latest.yml。
# 校验必须对**那个版本自己**的 yml，否则 sha512 对不上。
$isPre = $ver -match '-'
$ymlName = if ($isPre) { "beta.yml" } else { "latest.yml" }

$tmp = Join-Path $env:TEMP "bai-rollback\setup-$ver.exe"
New-Item -ItemType Directory -Force (Split-Path $tmp) | Out-Null
Write-Host ("下载 {0}（{1}）({2:N0} MB)..." -f $ver, $asset.name, ($asset.size / 1MB))
$prevProgress = $ProgressPreference; $ProgressPreference = "Continue"
Invoke-WebRequest $asset.browser_download_url -OutFile $tmp -UseBasicParsing
$ProgressPreference = $prevProgress

$ymlUrl = "https://github.com/$repo/releases/download/$($sel.tag_name)/$ymlName"
$want512 = $null
try {
  $want512 = (Invoke-RestMethod $ymlUrl -UseBasicParsing).Content |
    Select-String -Pattern 'sha512:\s*(.+)' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -First 1
} catch {
  Write-Host "取不到 $ymlName 的 sha512（该版本可能没发这份清单），跳过哈希校验"
}
if ($want512) {
  $got = [Convert]::ToBase64String([System.Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($tmp)))
  if ($got -ne $want512.Trim()) { throw "sha512 校验失败，已中止（当前安装未被改动）" }
  Write-Host "sha512 校验通过"
}

$sub = (Get-AuthenticodeSignature $tmp).SignerCertificate.Subject
if ($sub -notmatch "B\.AI Router Personal") { throw "签名者异常: $sub（已中止，当前安装未被改动）" }
Write-Host "签名校验通过: $sub"

# 走到这里才算真的能动当前安装。
Get-Process | Where-Object { $_.Name -eq "B.AI Router" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1
Write-Host "安装旧版（静默，配置保留）..."
Start-Process $tmp -ArgumentList "/S"
Start-Sleep 4
$exe = @("$env:LOCALAPPDATA\Programs\bai-router\B.AI Router\B.AI Router.exe", "D:\Users\$env:USERNAME\AppData\Local\Programs\bai-router\B.AI Router\B.AI Router.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($exe) { Start-Process $exe -ArgumentList "--min"; Write-Host "已用 v$ver 重新启动 ✓" }
Write-Host "回退完成。"
