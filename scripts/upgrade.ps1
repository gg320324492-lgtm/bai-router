# B.AI 路由台 —— 一键升级/重装（不依赖应用内置更新器）
# 用法（在目标电脑任意 PowerShell 窗口）：
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://github.com/gg320324492-lgtm/bai-router/releases/latest/download/upgrade.ps1 -UseBasicParsing | iex"
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = "gg320324492-lgtm/bai-router"
Write-Host "查询最新版..."
$rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "bai-upgrade" }
$asset = $rel.assets | Where-Object { $_.name -match '^BARRouter-Setup-.*\.exe$' } | Select-Object -First 1
if (-not $asset) { throw "release $($rel.tag_name) 里没有安装包" }
$tmp = Join-Path $env:TEMP "bai-selfupdate\setup.exe"
New-Item -ItemType Directory -Force (Split-Path $tmp) | Out-Null
Write-Host ("下载 {0} ({1:N0} MB)..." -f $asset.name, ($asset.size / 1MB))
$prevProgress = $ProgressPreference; $ProgressPreference = "Continue"
Invoke-WebRequest $asset.browser_download_url -OutFile $tmp -UseBasicParsing
$ProgressPreference = $prevProgress
$want = (Invoke-RestMethod "https://github.com/$repo/releases/latest/download/latest.yml" -UseBasicParsing).Content | Select-String -Pattern 'sha512:\s*(.+)' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -First 1
if ($want) {
  $got = [Convert]::ToBase64String([System.Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($tmp))))
  if ($got -ne $want.Trim()) { throw "sha512 校验失败，已中止" }
  Write-Host "sha512 校验通过"
}
$sub = (Get-AuthenticodeSignature $tmp).SignerCertificate.Subject
if ($sub -notmatch "B\.AI Router Personal") { throw "签名者异常: $sub" }
Write-Host "签名校验通过: $sub"
Get-Process | Where-Object { $_.Name -eq "B.AI Router" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1
Write-Host "启动安装（静默，原地升级，配置保留）..."
Start-Process $tmp -ArgumentList "/S"
Start-Sleep 3
$exe = @("$env:LOCALAPPDATA\Programs\bai-router\B.AI Router\B.AI Router.exe", "D:\Users\$env:USERNAME\AppData\Local\Programs\bai-router\B.AI Router\B.AI Router.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($exe) { Start-Process $exe -ArgumentList "--min"; Write-Host "已用新版重新启动 ✓" }
Write-Host "完成。"
