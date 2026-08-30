// 一键发布新版本：先改 package.json 的 version，然后运行  node publish.mjs "更新说明"
// 流程：electron-builder 构建 → gh release create v<version> (exe + latest.yml)
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const v = pkg.version;
const owner = pkg.build.publish[0].owner, repo = pkg.build.publish[0].repo;
const notes = process.argv[2] || `v${v}`;
const exe = `BARRouter-Setup-${v}.exe`;

const run = (cmd) => { console.log("»", cmd); execSync(cmd, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/" } }); };

if (fs.existsSync(path.join(ROOT, "dist", exe))) console.log(`⚠ dist/${exe} 已存在——若确认重发请先删除或升版本号`);
run("npx electron-builder --win nsis");
run(`gh release create v${v} -R ${owner}/${repo} "dist/${exe}" "dist/latest.yml" --title "v${v}" --notes "${notes.replace(/"/g, "'")}"`);
console.log(`\n✔ 已发布 v${v} → https://github.com/${owner}/${repo}/releases/tag/v${v}`);
console.log("  各电脑上的软件将在启动 8 秒内或点「检查更新」时自动收到新版。");
