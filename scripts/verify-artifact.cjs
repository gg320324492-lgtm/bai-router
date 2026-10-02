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
const missSrv = ["provider.html", "providers.js", "panel-common.css", "panel-common.js", "failover.mjs"]
  .filter((x) => !fs.existsSync(path.join(srv, x)));
const missCards = ["failover.js", "model-catalog.js", "token-capture.js"]
  .filter((x) => !fs.existsSync(path.join(srv, "cards", x)));

console.log("asar 模块缺失  :", missAsar.length ? missAsar.join(", ") : "无");
console.log("server 缺文件  :", missSrv.length ? missSrv.join(", ") : "无");
console.log("cards 缺文件   :", missCards.length ? missCards.join(", ") : "无");

// 旧五页此刻仍在包内（本版尚未删除）；哪天删了这里会如实报出来，不当成失败。
const legacy = ["ui.html", "sn.html", "wb.html", "zen.html", "qd.html"].filter((x) => fs.existsSync(path.join(srv, x)));
console.log("仍在包内的旧页 :", legacy.length ? legacy.join(", ") : "（无）");

const bad = missAsar.length + missSrv.length + missCards.length;
if (bad) {
  console.error(`\n✘ 打包产物缺 ${bad} 个文件`);
  process.exit(1);
}
console.log("\n✔ 打包产物核查通过");
