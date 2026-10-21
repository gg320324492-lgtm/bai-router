# B.AI 路由台 —— 一键升级/重装（不依赖应用内置更新器）
#
# 用法（在目标电脑任意 PowerShell 窗口）：
#   稳定版通道（默认）：
#     powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://github.com/gg320324492-lgtm/bai-router/releases/latest/download/upgrade.ps1 -UseBasicParsing | iex"
#   测试版通道（留在 beta 上）：
#     $sb=[scriptblock]::Create((iwr https://github.com/gg320324492-lgtm/bai-router/releases/download/v1.0.94-beta.1/upgrade.ps1 -UseBasicParsing).Content); & $sb beta
#
# ⚠ 通道是怎么定的（优先级从高到低）：
#   ① 命令行第一个参数（"stable" / "beta"）
#   ② 用户在托盘「更新通道」里选的那条（读 %APPDATA%\bai-router\config.json 的 updateChannel）
#   ③ 读不到就当稳定版
#   为什么要 ②：测试版用户跑救砖升级，**默认应该留在测试版**，
#   否则「升一下」反而把他拽回稳定版——那不叫救砖，叫降级。
#
# 它做什么：
#   1. 按通道找到 GitHub 上那个通道的最新 release
#   2. 下载那个版本的安装包
#   3. 校验 sha512（对那个版本自己的 yml）与 Authenticode 签名
#   4. 关掉当前程序 → 静默安装 → 重新启动
#
# ⚠ 顺序很重要：**先下载并校验完，才关程序、开安装器**。
#   这样下载失败/校验不过时，当前这份安装**一点都没被动过**。
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = "gg320324492-lgtm/bai-router"

# ── 下面这些函数只是定义；主流程放在文件末尾的 if 里 ──────────────────────
# 这样测试可以「只加载函数、不执行主流程」：
#   powershell -Command "$env:BAI_ROUTER_PS_LIB=1; . .\scripts\upgrade.ps1; Get-InstallerSha512 '...'"
# 而 `| iex` 那条路（用户实际用的）不会设这个变量，主流程照常跑。

# 取 yml 里的**安装包** sha512。
#
# ⚠⚠ yml 里其实有**两个** sha512：
#     files:   下面缩进的那个 —— 属于 files: 列表里的某一项（可能是 blockmap）
#     顶格的那个           —— electron-builder 给安装包写的，electron-updater 用的也是它
#   只抓第一个匹配容易抓错（两者一般相等，但不该靠运气）。
#   这里两个都取，**不一致就拒绝安装**——清单和产物对不上，宁可不装。
#
# ⚠ 另一个坑：`Invoke-RestMethod` 取 .yml 返回的是**字符串**（不是响应对象），
#   所以 `.Content` 是 $null。早期版本写成 `(Invoke-RestMethod ...).Content`，
#   于是 `$want` 恒为 null、`if ($want)` 恒假 —— **sha512 校验从来没真正跑过**，
#   只是一段看着像在校验的装饰代码。这里直接用返回值本身。
function Get-InstallerSha512([string]$text, [string]$exeName) {
  if (-not $text) { return $null }
  $lines = $text -split "`r?`n"
  $top = $null      # 顶格 sha512:（安装包）
  $inFiles = $null  # files: 里与安装包同名那一项的 sha512
  $cur = $null      # 当前 files: 项的 url
  foreach ($ln in $lines) {
    if ($null -eq $top -and $ln -match '^sha512:\s*([A-Za-z0-9+/=]+)\s*$') { $top = $Matches[1] }
    if ($ln -match '^\s*-\s*url:\s*(\S+)\s*$') { $cur = $Matches[1]; continue }
    if ($null -eq $inFiles -and $cur -and $ln -match '^\s+sha512:\s*([A-Za-z0-9+/=]+)\s*$') {
      if ((Split-Path $cur -Leaf) -eq $exeName) { $inFiles = $Matches[1] }
    }
  }
  if ($top -and $inFiles) {
    if ($top -ne $inFiles) { throw "yml 里两处 sha512 不一致（顶格 vs files 项），拒绝安装" }
    return $top
  }
  if ($top) { return $top }
  return $inFiles
}

# 取远端文本（yml）。按 UTF-8 显式解码，不靠 .NET 猜代码页。
#
# 为什么用 WebClient 而不是 Invoke-RestMethod / Invoke-WebRequest：
#   · Invoke-RestMethod 对 .yml 返回的是**字符串**（没有 .Content）——这正是
#     旧版那个「取 .Content 拿到 null、校验静默跳过」的坑。
#   · Invoke-WebRequest 走的是 .NET 的分块解码路径，遇到 chunked 响应容易出岔子；
#     而 yml 只有一个 sha512 行要读，不值得冒这个险。
#   · WebClient.DownloadData 直接给**原始字节**，解码由我们自己说了算（UTF-8）。
#
# ⚠ 代理兜底：救砖脚本最怕的就是「网络这条路也堵了」。系统代理不通时退回直连，
#   再不行才报错——两条路都堵了，那就是真的没网，报错是对的。
function Get-RemoteText([string]$url) {
  $bytes = $null
  try {
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add("User-Agent", "bai-router")
    $bytes = $wc.DownloadData($url)
  } catch {
    Write-Host ("⚠ 走系统代理失败，改用直连重试：$($_.Exception.Message)")
    [System.Net.WebRequest]::DefaultWebProxy = $null
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add("User-Agent", "bai-router")
    $bytes = $wc.DownloadData($url)
  }
  return [System.Text.Encoding]::UTF8.GetString($bytes)
}

# 校验安装包：sha512 + Authenticode 签名。任何一项不过就抛，**当前安装不受影响**。
function Assert-Installer([string]$file, [string]$repo, [string]$tag, [string]$exeName) {
  $isPre = $tag -match '-'
  $ymlName = if ($isPre) { "beta.yml" } else { "latest.yml" }
  $ymlUrl = "https://github.com/$repo/releases/download/$tag/$ymlName"
  $want512 = $null
  try {
    $text = Get-RemoteText $ymlUrl
    $want512 = Get-InstallerSha512 $text $exeName
  } catch {
    Write-Host ("⚠ 取不到 $ymlName 的 sha512：$($_.Exception.Message)")
  }
  if ($want512) {
    $got = [Convert]::ToBase64String([System.Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($file)))
    if ($got -ne $want512.Trim()) { throw "sha512 校验失败，已中止（当前安装未被改动）" }
    Write-Host "sha512 校验通过"
  } else {
    Write-Host "⚠ 没有可用的 sha512，跳过哈希校验（仍会验签名）"
  }

  $sig = Get-AuthenticodeSignature $file
  if ($sig.Status -ne "Valid") { throw "签名无效（状态: $($sig.Status)），已中止，当前安装未被改动" }
  $sub = $sig.SignerCertificate.Subject
  if ($sub -notmatch "B\.AI Router Personal") { throw "签名者异常: $sub（已中止，当前安装未被改动）" }
  Write-Host "签名校验通过: $sub"
}

if (-not $env:BAI_ROUTER_PS_LIB) {
  # ── 主流程 ────────────────────────────────────────────────────────────
  $channel = "stable"
  if ($args -and $args.Count -ge 1 -and $args[0]) {
    $a = ([string]$args[0]).Trim().ToLower()
    if ($a -eq "beta" -or $a -eq "stable") { $channel = $a }
  } else {
    # 读用户在托盘里选的通道（config.json 的 updateChannel）
    try {
      $cfgPath = Join-Path $env:APPDATA "bai-router\config.json"
      if (Test-Path $cfgPath) {
        $c = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($c.updateChannel -eq "beta") { $channel = "beta" }
      }
    } catch { }
  }
  Write-Host "目标通道: $channel"

  Write-Host "查询最新版本..."
  if ($channel -eq "beta") {
    # /releases/latest **排除**预发布，所以 beta 通道必须自己翻列表挑最新的预发布。
    $rels = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=30" -Headers @{ "User-Agent" = "bai-upgrade" }
    $sel = $rels | Where-Object { $_.prerelease -and -not $_.draft } | Select-Object -First 1
    if (-not $sel) { throw "这个仓库还没有测试版 release" }
  } else {
    $sel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "bai-upgrade" }
  }
  $asset = $sel.assets | Where-Object { $_.name -match '^BARRouter-Setup-.*\.exe$' } | Select-Object -First 1
  if (-not $asset) { throw "release $($sel.tag_name) 里没有安装包" }

  $tmp = Join-Path $env:TEMP "bai-selfupdate\setup.exe"
  New-Item -ItemType Directory -Force (Split-Path $tmp) | Out-Null
  Write-Host ("下载 {0} ({1:N0} MB)..." -f $asset.name, ($asset.size / 1MB))
  $prevProgress = $ProgressPreference; $ProgressPreference = "Continue"
  Invoke-WebRequest $asset.browser_download_url -OutFile $tmp -UseBasicParsing
  $ProgressPreference = $prevProgress

  Assert-Installer $tmp $repo $sel.tag_name $asset.name

  Get-Process | Where-Object { $_.Name -eq "B.AI Router" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 1
  Write-Host "启动安装（静默，原地升级，配置保留）..."
  Start-Process $tmp -ArgumentList "/S"
  Start-Sleep 3
  $exe = @("$env:LOCALAPPDATA\Programs\bai-router\B.AI Router\B.AI Router.exe", "D:\Users\$env:USERNAME\AppData\Local\Programs\bai-router\B.AI Router\B.AI Router.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($exe) { Start-Process $exe -ArgumentList "--min"; Write-Host "已用新版重新启动 ✓" }
  Write-Host "完成。"
}
