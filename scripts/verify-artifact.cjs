// 打包产物核查（发布闸门第三道）：asar 模块齐全 + resources/server 随包文件齐全。
// 单独成文件是因为发布脚本里那段用 execSync 内联、带反斜杠转义，经 shell 传参会碎掉。
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const asar = path.join(ROOT, "dist", "win-unpacked", "resources", "app.asar");
const srv = path.join(ROOT, "dist", "win-unpacked", "resources", "server");

if (!fs.existsSync(asar)) {
  console.error("✘ 找不到打包产物 " + asar);
  process.exit(1);
}

// asar 条目名带前导反斜杠（"\src\main.js"），也带尾部 CR——归一化成 "src/main.js" 再比。
// 不能用 includes() 直接判定：那样 "src/main.js" 会被 "src/main.js.map" 之类的旁支误命中。
const list = execSync(`npx --yes @electron/asar l "${asar}"`, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
  .toString()
  .split(/\r?\n/)
  .map((s) => s.trim().replace(/\\/g, "/").replace(/^\/+/, ""))
  .filter(Boolean);

const missAsar = ["src/main.js", "src/preload.js", "src/install-consistency.js"].filter((f) => !list.includes(f));
const missSrv = ["provider.html", "providers.js", "panel-common.css", "panel-common.js", "failover.mjs", "qoder-patch.mjs"]
  .filter((x) => !fs.existsSync(path.join(srv, x)));
const missCards = ["failover.js", "model-catalog.js", "token-capture.js"]
  .filter((x) => !fs.existsSync(path.join(srv, "cards", x)));

console.log("asar 模块缺失  :", missAsar.length ? missAsar.join(", ") : "无");
console.log("server 缺文件  :", missSrv.length ? missSrv.join(", ") : "无");
console.log("cards 缺文件   :", missCards.length ? missCards.join(", ") : "无");

// 旧五页（ui/sn/wb/zen/qd.html）已于 v1.0.46 收敛成 provider.html + providers.js，
// 并在 v1.0.49 从仓库删除。它们带内联 <script> 且依赖 v1.0.48 已删的全局（baiIsOurs /
// baiKeyMatchField），一旦被误加回 extraResources 就是随包陷阱（页面半死且不报错）。
// 所以这里不再只做「报一声仍在包内」，而是反向断言：必须不存在，存在即构建失败——
// 把「已删除」变成发布闸门里可验证的约束，而不是一句沉默的旁注。
const legacy = ["ui.html", "sn.html", "wb.html", "zen.html", "qd.html"].filter((x) => fs.existsSync(path.join(srv, x)));
console.log("残留旧页      :", legacy.length ? legacy.join(", ") : "无");

const missing = missAsar.length + missSrv.length + missCards.length;
if (missing || legacy.length) {
  // 两个失败原因分开报，别把「混进旧页」也算成「缺文件」——那会打印出
  // 「缺 0 个文件」这种自相矛盾的话，让人以为哪里算错了。
  if (missing) console.error(`\n✘ 打包产物缺 ${missing} 个文件`);
  if (legacy.length) console.error(`\n✘ 打包产物里混进了已废弃的旧页：${legacy.join(", ")}——查 package.json 的 extraResources.filter 是否把它们加了回去（或 dist/ 是删除前的陈旧产物，重新打包即可）`);
  process.exit(1);
}
console.log("\n✔ 打包产物核查通过");
