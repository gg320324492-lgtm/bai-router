// 一键发布新版本：先改 package.json 的 version，然后运行  node scripts/publish.cjs "更新说明"
// 流程：electron-builder 构建 → gh release create v<version> (exe + latest.yml)
const { execSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const v = pkg.version;
const owner = pkg.build.publish[0].owner, repo = pkg.build.publish[0].repo;
const exe = `BARRouter-Setup-${v}.exe`;

// 更新日志来源（v1.0.51）：release-notes.md 是唯一权威来源。
// 理由：该文件同时被 electron-builder（build.releaseInfo.releaseNotesFile）写进
// latest.yml —— 也就是客户端「软件内更新」真正读的那份。命令行 `node scripts/publish.cjs "..."` 只发
// GitHub release 页面（人看的），两者分开就会漂移（这就是本次要修的"数据链路断在中间"）。
// 所以：文件存在 → 一律以文件为准，命令行参数降级为「GitHub release 正文」的补充说明；
// 文件不存在 → 回退到旧的命令行参数行为，保证老习惯仍可用，不硬失败。
const notesFile = path.join(ROOT, "release-notes.md");
let notes = process.argv[2] || "";
const hasNotesFile = fs.existsSync(notesFile);
if (hasNotesFile) {
  notes = fs.readFileSync(notesFile, "utf8").trim();
  if (!notes) { console.log("⚠ release-notes.md 为空——将回退到命令行参数/默认值"); notes = process.argv[2] || `v${v}`; }
} else {
  notes = process.argv[2] || `v${v}`;
}

const run = (cmd) => { console.log("»", cmd); execSync(cmd, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/" } }); };

// 发布前置：用发布机当前配置刷新随包默认快照（脱敏 apiKey）→ 新电脑开箱即得同款模型列表/映射
try {
  const userCfgPath = path.join(process.env.APPDATA, "bai-router", "config.json");
  if (fs.existsSync(userCfgPath)) {
    const local = JSON.parse(fs.readFileSync(userCfgPath, "utf8"));
    const def = { ...local, apiKey: "" };
    delete def._modelsSynced;
    // sn（SenseNova）块：发布机 config 可能还没有（旧版未写入）或残留密钥——一律以代码默认+脱敏为准
    if (def.sn) { def.sn = { ...def.sn, apiKey: "" }; }
    else {
      const cur = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "server", "config.defaults.json"), "utf8"));
      if (cur.sn) def.sn = { ...cur.sn, apiKey: "" };
    }
    // wb（WorkBuddy）块：JWT 令牌绝不进发布机快照；发布机没配过就沿用代码默认（同样脱敏）
    if (def.wb) { def.wb = { ...def.wb, accessToken: "", refreshToken: "", deviceToken: "" }; }
    else {
      const cur2 = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "server", "config.defaults.json"), "utf8"));
      if (cur2.wb) def.wb = { ...cur2.wb, accessToken: "", refreshToken: "", deviceToken: "" };
    }
    // zen（OpenCode Zen）块：API Key 同样绝不进快照
    if (def.zen) { def.zen = { ...def.zen, apiKey: "" }; }
    else {
      const cur3 = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "server", "config.defaults.json"), "utf8"));
      if (cur3.zen) def.zen = { ...cur3.zen, apiKey: "" };
    }
    // or（OpenRouter）块：三把 API Key 绝不进发布机快照——快照随安装包发给所有机器，
    // key 进去等于公开泄露（v1.0.58 加第 6 家时补上；本机没配过时从仓库 defaults 继承结构、keys 仍清空）。
    if (def.or) { def.or = { ...def.or, keys: [] }; }
    else {
      const curOr = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "server", "config.defaults.json"), "utf8"));
      if (curOr.or) def.or = { ...curOr.or, keys: [] };
    }
    // failover（自动故障转移）：**一律以仓库里的 config.defaults.json 为准**，不从发布机快照取。
    // 原实现是 `def.failover || curFo.failover`——发布机的设置只要存在就赢。而「这台机器
    // 勾没勾故障转移」是**用户偏好**，不是出厂默认：一旦发布机关着开关，每次发布都会把
    // 随包快照里的 enabled 改成 false，发给所有新用户，等于替他们做了决定。
    // chain 仍顺带收敛到已知提供方（与 loadCfg 语义一致：兜底恒在末尾）——仓库里写错也拦得住。
    {
      const curFo = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "server", "config.defaults.json"), "utf8"));
      if (curFo.failover) {
        const fo = { ...curFo.failover };
        const chain = (fo.chain || []).filter((x) => ["bai", "sn", "wb", "zen", "qd", "or"].includes(x));
        /* 收敛后为空就原样保留仓库里写的 chain：这一段只做"剔除未知渠道 / 兜底垫末尾"，
           不该把一份完整的出厂默认改写成空链。 */
        if (chain.length) {
          if (!chain.includes("or")) chain.push("or");
          fo.chain = chain;
        }
        def.failover = fo;
        console.log(`» failover 取自仓库 defaults（不跟发布机走）: enabled=${fo.enabled} chain=${(fo.chain || []).join(">")}`);
      } else {
        delete def.failover;   // 仓库里没写这个块，就别把发布机的带进随包快照
      }
    }
    // qd（Qoder）块：token 是手动兜底用的 jt- jobToken，绝不进快照
    // （正常路径下它恒为空——真实令牌由 worker 补丁写在 %TEMP%\qoder-token.json，不落 config）
    // tokenFile/modelsFile 是发布机的 %TEMP% 绝对路径，原样进快照会被 C13 闸门拦下；
    // 清空即可——运行期 fixQdFile() 会把空值/异机路径自愈回本机 os.tmpdir()。
    if (def.qd) { def.qd = { ...def.qd, token: "", tokenFile: "", modelsFile: "" }; }
    else {
      const cur4 = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "server", "config.defaults.json"), "utf8"));
      if (cur4.qd) def.qd = { ...cur4.qd, token: "", tokenFile: "", modelsFile: "" };
    }
    fs.writeFileSync(path.join(ROOT, "src", "server", "config.defaults.json"), JSON.stringify(def, null, 2) + "\n");
    console.log(`» 默认快照已同步发布机: ${def.availableModels.length} 个模型${def.sn ? " + SenseNova " + def.sn.availableModels.length + " 个" : ""}`);
  } else console.log("» 未找到发布机配置，沿用仓库内 defaults 快照");
} catch (e) { console.log("» 快照同步跳过:", e.message); }

if (fs.existsSync(path.join(ROOT, "dist", exe))) console.log(`⚠ dist/${exe} 已存在——若确认重发请先删除或升版本号`);

// 清单/模板一致性闸门（v1.0.46）：五页收敛成「一份模板 + 一份清单」后，
// 加第 6 家最容易漏改一处就静默出错（上一轮就出过五处复制粘贴漂移）。
// scripts/check-manifest.cjs 把这类漏改变成构建期失败——放在 electron-builder 之前，
// 先花 0.1 秒拦住，别等打包五分钟才发现。
const CHECK_MANIFEST = path.join(ROOT, "scripts", "check-manifest.cjs");
const runCheckManifest = (stage) => {
  console.log(`» 发布闸门 [${stage}]：校验清单/模板/插槽/配色一致性`);
  try {
    execFileSync(process.execPath, [CHECK_MANIFEST], { cwd: ROOT, stdio: "inherit" });
  } catch (e) {
    if (e && e.code === "ENOENT") {
      throw new Error(`发布闸门失败：找不到 ${CHECK_MANIFEST}`);
    }
    throw new Error(`发布闸门失败：scripts/check-manifest.cjs 未通过（见上方 ${stage} 阶段的报错）。发布已中止。`);
  }
};
runCheckManifest("preflight");

run("npx electron-builder --win nsis");
// 发布闸门：打包产物必须模块齐全（v1.0.29 曾漏打包 install-consistency.js 导致启动即崩）
{
  const asar = path.join(ROOT, "dist", "win-unpacked", "resources", "app.asar");
  const list = execSync(`npx --yes @electron/asar l "${asar}"`, { cwd: ROOT }).toString().replace(/\\/g, "/");
  const need = ["src/main.js", "src/preload.js", "src/install-consistency.js"];
  const miss = need.filter((f) => !list.includes(f));
  // 五个页面都 <script src="/panel-common.js">，缺了它所有页面的底栏与更新控件都会消失
  const pcOk = fs.existsSync(path.join(ROOT, "dist", "win-unpacked", "resources", "server", "panel-common.js"));
  // server.mjs 静态 import 了 failover.mjs，缺了整个服务起不来
  const foOk = fs.existsSync(path.join(ROOT, "dist", "win-unpacked", "resources", "server", "failover.mjs"));
  // v1.0.46 五页收敛成一份模板：模板/清单/CSS 任缺其一，五个页面全白屏
  const srv = path.join(ROOT, "dist", "win-unpacked", "resources", "server");
  const need2 = ["provider.html", "providers.js", "panel-common.css", "failover.mjs"];
  const miss2 = need2.filter((x) => !fs.existsSync(path.join(srv, x)));
  const cardsDir = path.join(srv, "cards");
  const cardOk = ["failover.js", "model-catalog.js", "token-capture.js"]
    .filter((x) => !fs.existsSync(path.join(cardsDir, x)));
  if (miss.length || miss2.length || cardOk.length) throw new Error(
    "打包产物缺文件: " + miss.concat(miss2).concat(cardOk.map((x) => "cards/" + x)).join(",")
    + (pcOk ? "" : " + resources/server/panel-common.js") + (foOk ? "" : " + resources/server/failover.mjs"));
  console.log("» 发布闸门通过：asar 模块齐全；provider.html / providers.js / panel-common.css / panel-common.js / failover.mjs / cards/* 已随包");
}
// 清单/模板一致性闸门的第二道：打包完再验一次，防止构建过程动了这些文件
// （或 dist 里的副本是旧的）才发布出去。
runCheckManifest("post-build");
// upgrade.ps1：救砖/一键升级脚本，作为 release 资产随每个版本发布（旧版更新器损坏的用户无需打开网页）
if (!fs.existsSync(path.join(ROOT, "dist", "upgrade.ps1"))) {
  fs.copyFileSync(path.join(ROOT, "scripts", "upgrade.ps1"), path.join(ROOT, "dist", "upgrade.ps1"));
}
/* 用 execFileSync + 参数数组，而不是把内容拼进 shell 字符串。
   原因：notes 现在是 release-notes.md 的全文（多行 markdown，含反引号）。拼进
   `gh ... --notes "…"` 后，双引号内的反引号会被 bash 当**命令替换**执行——
   实测「含反引号 `echo INJECTED` 的文本」会变成「含反引号 INJECTED 的文本」，
   日志正文被破坏，且等同于把发版脚本变成任意命令执行入口。参数数组不经过 shell。 */
const gh = (args) => {
  console.log("» gh", args.map((a) => (a.length > 60 ? a.slice(0, 57) + "…" : a)).join(" "));
  return execFileSync("gh", args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
};
gh([
  "release", "create", `v${v}`, "-R", `${owner}/${repo}`,
  `dist/${exe}`, `dist/${exe}.blockmap`, "dist/upgrade.ps1", "dist/latest.yml",
  "--title", `v${v}`, "--notes", notes,
]);
// 命令行参数没有被当作正文时（文件存在），把它作为「发布说明」追加到 GitHub release
// 正文——单纯给人看的备注，不影响 latest.yml。失败只警告：客户端更新日志不依赖它。
if (hasNotesFile && process.argv[2] && process.argv[2] !== notes) {
  try {
    gh(["release", "edit", `v${v}`, "-R", `${owner}/${repo}`, "--notes", `${notes}\n\n---\n\n${process.argv[2]}`]);
  } catch (e) { console.log("⚠ GitHub release 正文追加备注失败（不影响软件内更新日志）：", e.message); }
}
console.log(`\n✔ 已发布 v${v} → https://github.com/${owner}/${repo}/releases/tag/v${v}`);
console.log("  各电脑上的软件将在启动 8 秒内或点「检查更新」时自动收到新版。");
