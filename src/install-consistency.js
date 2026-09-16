// 双份安装自检（v1.0.29）：防止"更新装进注册表位置、快捷方式仍指旧副本"错位
// a) 注册表版本 > 运行版本 → 正从旧副本运行：横幅提示 + 一键切换正式版
// b) 正式版在运行 → 自动校正桌面/开始菜单快捷方式
"use strict";
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

let ctx = null; // { app, spawn, logMain, getUpdateState, setUpdateState, syncTray, notifyWindow }
function init(options) { ctx = options; }

function cmpVer(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}

function readInstalledInfo() {
  if (!ctx.app.isPackaged || process.platform !== "win32") return Promise.resolve(null);
  // -Command 内联（不落 .ps1 文件避免编码坑）；输出可能混入 ANSI 警告行，取首个 "{" 后再解析
  // 反斜杠一律用 BS 变量拼接（源码里不写反斜杠字面量，防转义被吞）
  const BS = String.fromCharCode(92);
  const regPath = "HKCU:" + BS + "Software" + BS + "Microsoft" + BS + "Windows" + BS + "CurrentVersion" + BS + "Uninstall";
  const ps = "$WarningPreference='SilentlyContinue';" +
    "$k = Get-ChildItem '" + regPath + "' -ErrorAction SilentlyContinue | " +
    "Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName -like 'B.AI Router*' } | Select-Object -First 1; " +
    "if ($k) { Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue | " +
    "Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString | ConvertTo-Json -Compress -Depth 5 }";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { windowsHide: true, timeout: 20000 },
      (e, so) => {
        if (e || !so) return resolve(null);
        const s = String(so); const i = s.indexOf("{");
        if (i < 0) return resolve(null);
        let info = null;
        try { info = JSON.parse(s.slice(i)); } catch { return resolve(null); }
        let dir = String(info.InstallLocation || "").trim();
        if (!dir) {
          const u = String(info.UninstallString || "").replace(/"/g, "").trim();
          const exePath = u.split(" -")[0].split(" /")[0].trim();
          dir = path.dirname(exePath);
        }
        dir = dir.replace(/"/g, "").trim();
        if (dir && dir.length >= 2 && dir[1] === ":" && dir.includes("\\")) info._regDir = dir;
        resolve(info._regDir ? info : null);
      });
  });
}

async function check() {
  if (!ctx.app.isPackaged) return;
  const info = await readInstalledInfo();
  if (info) ctx.setInstalledInfo(info);
  if (!info) return;
  const regVer = String(info.DisplayVersion || "").trim();
  const runVer = ctx.app.getVersion();
  if (cmpVer(regVer, runVer) > 0) {
    // 旧副本在运行：不乱动快捷方式（正式版启动时会自己校准），只提示 + 提供切换
    const regExe = path.join(info._regDir, "B.AI Router.exe");
    ctx.setUpdateState({ phase: "stale", version: regVer, runPath: process.execPath, regPath: regExe, canSwitch: fs.existsSync(regExe) });
    ctx.logMain("检测到旧副本：运行 " + process.execPath + " (v" + runVer + ")，注册表正式版 " + regExe + " (v" + regVer + ")");
    ctx.syncTray();
    ctx.notifyWindow("app-event", { kind: "stale", state: ctx.getUpdateState() });
    return;
  }
  // 我们不落后于注册表 → 校准快捷方式到自己（可能还指着历史副本）
  const runDir = path.dirname(process.execPath);
  const isRealInstall = fs.existsSync(path.join(runDir, "Uninstall B.AI Router.exe"));
  if (!isRealInstall) return;
  const n = await repairShortcutsTo(process.execPath);
  if (n > 0) {
    ctx.logMain("已校正 " + n + " 个快捷方式 -> " + process.execPath);
    ctx.notifyWindow("app-event", { kind: "check", text: "已自动校正快捷方式指向（此前可能指向旧副本）" });
  }
}

function switchToInstalled() {
  const dir = ctx.getInstalledInfo() && ctx.getInstalledInfo()._regDir;
  if (!dir) return { ok: false, msg: "未找到注册表安装信息（绿色模式不支持）" };
  const runDir = path.dirname(process.execPath);
  if (path.resolve(dir).toLowerCase() === path.resolve(runDir).toLowerCase()) return { ok: false, msg: "当前已是正式版" };
  const exe = path.join(dir, "B.AI Router.exe");
  if (!fs.existsSync(exe)) return { ok: false, msg: "正式版主程序不存在：" + exe };
  try {
    ctx.spawn(exe, [], { detached: true, stdio: "ignore", cwd: dir, windowsHide: true,
      env: { ...process.env, BAI_SELFHEAL: "1" } }).unref();
    ctx.logMain("切换到正式版：" + exe);
    ctx.requestQuit();
    return { ok: true };
  } catch (e) { return { ok: false, msg: String((e && e.message) || e) }; }
}

async function repairShortcutsTo(exePath) {
  const exeJs = String(exePath).replace(/'/g, "''");
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$w = New-Object -ComObject WScript.Shell",
    "$exe = '" + exeJs + "'",
    "$bs = [char]92",
    "$files = @()",
    "$dt = [Environment]::GetFolderPath('Desktop'); if ($dt) { $files += (Join-Path $dt 'B.AI 路由台.lnk') }",
    "$files += (Join-Path $env:APPDATA ('Microsoft' + $bs + 'Windows' + $bs + 'Start Menu' + $bs + 'Programs' + $bs + 'B.AI 路由台.lnk'))",
    "$fixed = 0",
    "foreach ($f in $files) {",
    "  if (-not (Test-Path $f)) { continue }",
    "  $s = $w.CreateShortcut($f)",
    "  if ($s.TargetPath -and ($s.TargetPath.TrimEnd($bs) -ieq $exe)) { continue }",
    "  $s.TargetPath = $exe; $s.WorkingDirectory = (Split-Path $exe); $s.IconLocation = ($exe + ',0'); $s.Save()",
    "  $fixed++",
    "}",
    "Write-Output ('CHANGED=' + $fixed)",
  ].join("; ");
  const raw = await new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { windowsHide: true, timeout: 20000 },
      (e, so) => resolve(e ? "CHANGED=0" : String(so || "CHANGED=0")));
  });
  const m = /CHANGED=(\d+)/.exec(raw);
  return m ? parseInt(m[1], 10) : 0;
}

module.exports = { init, check, switchToInstalled };
