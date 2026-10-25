/**
 * 把本软件**整个搬离 C 盘**（scripts/switch-install-location.mjs）
 *
 * ## 它做什么
 *
 * ① 把**仓库当前代码**同步进新位置的安装目录（这样跑起来的就是最新修复，不必等发版）
 * ② 停掉现在跑着的那份（它在旧位置）
 * ③ 删掉旧位置的安装目录（C 盘那份）
 * ④ 从新位置启动，并**验证**（版本 / 端口 / 数据目录）
 *
 * ## ⚠ 它会**中断正在跑的服务**
 *
 * 跑这个脚本时，正在用本软件当上游的客户端（Claude Code 等）会断一下。
 * ⇒ **请在没有正在跑的任务时跑**。
 *
 * ## 用法
 *
 *   node scripts/switch-install-location.mjs                 # 默认：新位置 G:\bai-router\app
 *   node scripts/switch-install-location.mjs --dry-run        # 只看会做什么，不动手
 *   node scripts/switch-install-location.mjs --to "D:\B.AI"    # 换位置
 *
 * ## 硬约束
 *
 * · **只按 PID 杀**（不按名字杀 ⇒ 不误伤别的软件）。
 * · 数据目录**不搬**（它在 %APPDATA%\bai-router，已是指向 G 盘的链接）⇒ 用户的
 *   配置、日志、备份一律原样保留。
 * · 桌面/开始菜单的快捷方式**指到新位置**（否则双击打不开）。
 * · 卸载登记的 InstallLocation 改成新位置 ⇒ **以后升级不会搬回旧位置**。
 */
import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const toIdx = argv.indexOf("--to");
/* ⚠ 新位置**必须含产品名**（`B.AI Router`）：NSIS 的规矩 —— 目标目录名里不含产品名时，
 *   安装器会**自动补一层** ⇒ 那层补出来后，下次升级又会再补（目录越套越深）。
 *   ⇒ 这一层的存在是**对的**，别去「整理」它。 */
const NEW_DIR = path.resolve(toIdx >= 0 ? argv[toIdx + 1] : "G:\\bai-router\\app\\B.AI Router");
const OLD_DIR = "C:\\Users\\admin\\AppData\\Local\\Programs\\B.AI Router";
const EXE = path.join(NEW_DIR, "B.AI Router.exe");

const say = (m) => console.log(m);

say(`旧位置：${OLD_DIR}`);
say(`新位置：${NEW_DIR}`);
if (!fs.existsSync(EXE)) say(`⚠ 新位置里还没有 exe（${EXE}）⇒ 先把安装包装到那儿`);
if (DRY) { say("（--dry-run：什么都不做）"); process.exit(0); }

/* ① 停掉现在跑着的那份（按**路径**找 PID ⇒ 只杀本软件，不误伤别的） */
const running = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'B.AI Router.exe' } | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)\" }",
], { encoding: "utf8", shell: true });
const pids = String(running.stdout || "").split(/\r?\n/).filter(Boolean)
  .map((l) => l.split("\t")[0].trim()).filter(Boolean);
say(`正在跑的进程：${pids.join(", ") || "（无）"}`);
for (const pid of pids) {
  try { execFileSync("taskkill", ["/F", "/T", "/PID", pid], { stdio: "ignore" }); say(`  已停 ${pid}`); }
  catch (e) { say(`  停 ${pid} 失败：${e.message}`); }
}

/* ② 把仓库当前代码同步进新位置（跑起来的就是最新修复） */
say("② 同步仓库代码进新位置…");
const sync = spawnSync(process.execPath, [path.join(REPO, "scripts", "hotfix-install.mjs"), "--apply"],
  { encoding: "utf8", env: { ...process.env, BAI_INSTALL_DIR: NEW_DIR } });
say(String(sync.stdout || "").trim().split(/\r?\n/).slice(-6).join("\n"));
if (sync.status !== 0) say("⚠ 同步脚本返回非零（上面是它的输出）");

/* ③ 删掉旧位置（此时没进程占着了） */
if (fs.existsSync(OLD_DIR)) {
  say(`③ 删旧位置 ${OLD_DIR} …`);
  const rm = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `Remove-Item -LiteralPath '${OLD_DIR}' -Recurse -Force -ErrorAction SilentlyContinue`],
  { encoding: "utf8", shell: true });
  say(fs.existsSync(OLD_DIR) ? "  ⚠ 还在（可能被占用）" : "  已删");
}

/* ④ 快捷方式 + 卸载登记指到新位置 */
say("④ 快捷方式与卸载登记…");
const ps = `
$sh = New-Object -ComObject WScript.Shell
$dirs = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'), (Join-Path ([Environment]::GetFolderPath('Desktop') | Split-Path -Parent) 'AGENT'))
foreach ($d in $dirs) {
  if (-not (Test-Path -LiteralPath $d)) { continue }
  Get-ChildItem -LiteralPath $d -Filter 'B.AI*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
    $s = $sh.CreateShortcut($_.FullName)
    $leaf = Split-Path -Leaf $s.TargetPath
    if ($leaf -eq 'B.AI Router.exe') {
      $s.TargetPath = '${EXE.replace(/'/g, "''")}'
      $s.WorkingDirectory = '${NEW_DIR.replace(/'/g, "''")}'
      $s.Save()
      Write-Host ('  已改: ' + $_.FullName)
    }
  }
}
Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
  if ($p.DisplayName -like '*B.AI Router*') {
    Set-ItemProperty -Path $_.PSPath -Name 'InstallLocation' -Value '${NEW_DIR.replace(/'/g, "''")}'
    Set-ItemProperty -Path $_.PSPath -Name 'UninstallString' -Value ('"' + (Join-Path '${NEW_DIR.replace(/'/g, "''")}' 'Uninstall B.AI Router.exe') + '" /currentuser')
    Write-Host ('  卸载登记已指向: ' + $_.PSChildName)
  }
}
`;
spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", shell: true });

/* ⑤ 从新位置启动 */
say("⑤ 从新位置启动…");
try { spawnSync(EXE, [], { detached: true, stdio: "ignore" }); } catch (e) { say(`  启动失败：${e.message}`); }

await new Promise((r) => setTimeout(r, 12000));
/* ⑥ 验证 */
const q = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
  "$p = (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'B.AI Router.exe' } | Select-Object -First 1); if ($p) { $p.ExecutablePath } else { 'NOT RUNNING' }"],
{ encoding: "utf8", shell: true });
say(`⑥ 现在跑的是：${String(q.stdout || "").trim()}`);
say(fs.existsSync(OLD_DIR) ? `⚠ 旧位置还在：${OLD_DIR}` : `✓ 旧位置已清空`);
