// electron-updater 6.8.9 的 Windows 签名验证把 PowerShell stdout 直接 JSON.parse，
// 而 ConvertTo-Json 默认深度 2 会先打一行黄色 WARNING（带 ANSI 转义）再输出截断 JSON，
// 导致自动更新必炸 "Unexpected token '\x1b[33;1mWAR...'"。
// 补丁：$WarningPreference 压制警告 + ConvertTo-Json -Depth 5 根治截断。
// npm install 后由 postinstall 自动执行；上游修复后本脚本可删。
const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "..", "node_modules", "electron-updater", "out", "windowsExecutableCodeSignatureVerifier.js");
let code = fs.readFileSync(file, "utf8");
const before = "Get-AuthenticodeSignature -LiteralPath '${tempUpdateFile}' | ConvertTo-Json -Compress";
const after = "$WarningPreference='SilentlyContinue'; Get-AuthenticodeSignature -LiteralPath '${tempUpdateFile}' | ConvertTo-Json -Compress -Depth 5";
if (code.includes(after)) { console.log("[patch-updater] 已打过，跳过"); process.exit(0); }
if (!code.includes(before)) { console.error("[patch-updater] 未找到目标代码，electron-updater 可能已升级——请人工核对"); process.exit(1); }
code = code.replace(before, after);
fs.writeFileSync(file, code);
console.log("[patch-updater] 已应用：压制 ConvertTo-Json 截断警告 + Depth 5");
