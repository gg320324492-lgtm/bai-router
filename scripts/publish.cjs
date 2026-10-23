// 一键发布新版本：先改 package.json 的 version，然后运行  node scripts/publish.cjs "更新说明"
// 流程：electron-builder 构建 → gh release create v<version> (exe + latest.yml 或 beta.yml)
//   稳定版 → latest.yml；预发布版（1.0.93-beta.1）→ beta.yml，且在 GitHub 上标 prerelease。
const { execSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { decideProxyUse, buildGhEnv, runDirectProbe, gitNetVariants, gitRemoteError } = require("./publish-proxy.cjs");
const { assertCleanSource, assertRemoteSource } = require("./publish-source.cjs");
const { syncSeed } = require("./publish-seed.cjs");
const { isPrereleaseVersion } = require("../src/update-channel.js");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const v = pkg.version;
const owner = pkg.build.publish[0].owner, repo = pkg.build.publish[0].repo;
const exe = `BARRouter-Setup-${v}.exe`;

/* ★ 更新通道：预发布版本走**自己那条** feed。
 *
 * electron-builder 自己会按版本号推导通道（appInfo.channel 取 semver 的
 * prerelease 标签）：版本是 `1.0.93-beta.1` → 通道 "beta" → 产出 `beta.yml`；
 * 版本是 `1.0.93` → 通道 "latest" → 产出 `latest.yml`。
 * 所以**构建命令一个字都不用改**，只有「上传哪份 yml」要跟着变。
 *
 * ⚠ 关键：**预发布版本绝不能上传 latest.yml**。latest.yml 是稳定版用户
 * 唯一读的那份，上传了就等于把测试版推给了所有稳定版用户——
 * 那就不是「选择性升级」了。 */
const isPre = isPrereleaseVersion(v);
const ymlName = isPre ? "beta.yml" : "latest.yml";

// 2026-10-13：历史发版只上传安装包，未推源码，gh 默认在旧 main 上打了新版 tag。
// 构建前固定来源；直接查发布仓库，不能把本地 origin/main 缓存当作远端实况。
const releaseRepository = `https://github.com/${owner}/${repo}.git`;
const readGit = (args, env = process.env) => execFileSync("git", args, {
  cwd: ROOT, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"], env,
});

/* 远端核对的执行器：依次试「带代理」与「不带代理」，哪条通用哪条。
 *
 * ⚠⚠ 为什么不能直接用上传那份 env（2026-10-22 实测踩到）：
 *   上传走哪条路由由**探测**决定，而探测打的是 api.github.com；
 *   核对打的是 **github.com** —— 实测直连 api.github.com 0.8 秒、
 *   直连 github.com **16.7 秒**（同一个 IP 段，时延差一个数量级），
 *   git 的连接预算撑不住那次握手：
 *     fatal: unable to access '…': Failed to connect to github.com port 443 after 21108 ms
 *   探测说「直连可用」→ 脚本把代理变量摘掉 → 恰好把**核对那条路**断掉。
 *
 *   也就是说：**探测量的是一条路，决定的却是另一条路**。两条路各走各的，
 *   远端核对自己挑一条能通的就行 —— 与上传那条路**解耦**。
 */
const noProxyEnv = buildGhEnv(process.env, { useProxy: false });
let ghEnv = null;   // 发布时再定（见下方 decideProxyUse)

/* 远端核对该试哪几条路、全部试过之后怎么报错 —— 都在 publish-proxy.cjs 里
   （纯函数，能被测试钉住）。⚠ 「显式指定 BAI_GIT_PROXY」排第一档：
   「环境里有没有代理变量」是**偶然**的，不能靠运气。 */
function netEnvVariants() {
  return gitNetVariants(process.env, ghEnv, noProxyEnv);
}
function readGitRemote(args) {
  let last = null;
  for (const env of netEnvVariants()) {
    try { return readGit(args, env); } catch (e) { last = e; }
  }
  throw gitRemoteError(last);
}
const releaseHead = assertCleanSource(readGit);
assertRemoteSource(readGitRemote, { repository: releaseRepository, head: releaseHead, tag: `v${v}` });

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

/* 「按 ref 的键顺序重建 obj」这个工具已随快照同步逻辑一起搬进 scripts/publish-seed.cjs
 * （reorderLike）——那段是唯一用得上它的地方，留在本文件里就成了没人调用的死代码。 */

const run = (cmd) => { console.log("»", cmd); execSync(cmd, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/" } }); };

// 发布前置：用发布机当前配置刷新随包默认快照（脱敏 apiKey）→ 新电脑开箱即得同款模型列表/映射
//
// 同步逻辑已抽成 scripts/publish-seed.cjs 的**纯函数**（syncSeed）：
// 那一段里有按渠道名写死的名单，漏改一处的后果是**静默**的（v1.0.65 的 wbai、
// v1.0.89 的 mm 各一次），所以不能埋在副作用里只能靠"发一版看看"来验——
// 现在由 scripts/publish-seed-test.mjs 直接求值，名单与仓库链对不上就当场红。
try {
  const userCfgPath = path.join(process.env.APPDATA, "bai-router", "config.json");
  if (fs.existsSync(userCfgPath)) {
    const local = JSON.parse(fs.readFileSync(userCfgPath, "utf8"));
    const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "server", "config.defaults.json"), "utf8"));
    const r = syncSeed(local, CUR);
    fs.writeFileSync(path.join(ROOT, "src", "server", "config.defaults.json"), JSON.stringify(r.seed, null, 2) + "\n");
    for (const n of r.notes) console.log("» " + n);
  } else console.log("» 未找到发布机配置，沿用仓库内 defaults 快照");
} catch (e) { console.log("» 快照同步跳过:", e.message); }

// 脚本同步出的 seed 也必须成为已提交源码，不能让安装包与发布 tag 内容漂移。
assertCleanSource(readGit, releaseHead);

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
  const need2 = ["provider.html", "providers.js", "panel-common.css", "failover.mjs", "zen-probe.mjs"];
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
// rollback.ps1：一键回退脚本（装回旧版），同样作为 release 资产发布。
// 有了它，「选择性升级」才真正闭环——升上去容易，退回来也得是一条命令。
if (!fs.existsSync(path.join(ROOT, "dist", "rollback.ps1"))) {
  fs.copyFileSync(path.join(ROOT, "scripts", "rollback.ps1"), path.join(ROOT, "dist", "rollback.ps1"));
}
/* 预发布版：把 latest.yml 改名成 beta.yml。
 *
 * electron-builder 的清单文件名跟的是 **publish.channel**，不是版本号
 * （updateInfoBuilder.js 的 `computeChannelNames`：`publishConfig.channel || "latest"`；
 *  GitHub provider 只产**一份**清单，所以配了 channel=beta 就只会产 beta.yml）。
 *
 * 那为什么不直接给 publish 配 channel？因为 `publish` 是一段**数组**
 * （provider / owner / repo 都在里面），为了一个通道名就要把 owner/repo 在命令行上
 * 再抄一遍——那种重复迟早会漂移（改了一处忘了另一处，发布到别人的仓库去）。
 *
 * 而**内容是逐字相同的**：yml 里只有 version / files / path / sha512 / releaseNotes /
 * releaseDate，**没有任何通道标记**。通道只决定**文件名**。所以把 latest.yml 改名成
 * beta.yml，与「让构建器直接产 beta.yml」完全等价。
 *
 * ⚠ 稳定版**绝不能**走这条路：latest.yml 是稳定版用户唯一读的那份。预发布版改名后
 * **不上传** latest.yml，稳定版那份继续指着上一个稳定版——这就是「选择性升级」的隔离点。 */
if (isPre) {
  const built = path.join(ROOT, "dist", "latest.yml");
  const want = path.join(ROOT, "dist", ymlName);
  if (fs.existsSync(built)) {
    fs.renameSync(built, want);
    console.log(`» 预发布版：清单改名 latest.yml → ${ymlName}（内容不变，通道只由文件名决定）`);
  } else if (!fs.existsSync(want)) {
    throw new Error(`预发布版找不到可用的清单：dist/latest.yml 与 dist/${ymlName} 都不存在`);
  }
}
/* 用 execFileSync + 参数数组，而不是把内容拼进 shell 字符串。
   原因：notes 现在是 release-notes.md 的全文（多行 markdown，含反引号）。拼进
   `gh ... --notes "…"` 后，双引号内的反引号会被 bash 当**命令替换**执行——
   实测「含反引号 `echo INJECTED` 的文本」会变成「含反引号 INJECTED 的文本」，
   日志正文被破坏，且等同于把发版脚本变成任意命令执行入口。参数数组不经过 shell。 */
/* ── 发版这一步的网络路径（v1.0.78）────────────────────────────────────────
 *
 * `gh release create` 要上传 111MB 安装包。2026-10-12 实测两次：经本机 Clash 的
 * HTTP 代理会**卡死**（挂 20+ 分钟，CPU 只用 0.56 秒＝纯等待，不是在传），最后失败；
 * 去掉代理变量则 90~130 秒完成。本机开着 Clash TUN，所以去代理后直连照样通。
 *
 * 但**不能无条件清**：万一某台机器没有 TUN、只能靠 HTTP 代理出网，清掉就根本发不出去。
 * 所以先探一次「不带代理能不能连通 GitHub」（≤4 秒），通了才清，不通就保留。
 * 判定逻辑抽在 scripts/publish-proxy.cjs（纯函数 + 注入探测器），
 * 由 scripts/publish-proxy-test.mjs 覆盖四种情形，不必真上传、不必真联网。
 *
 * ⚠ 边界：`run()`（electron-builder）一个代理变量都不动——它可能要靠代理拉
 *   二进制镜像（ELECTRON_BUILDER_BINARIES_MIRROR）。本模块只造一份**新**的
 *   env 传给 gh，全程不写 process.env，所以构建阶段的网络设置原封不动。
 * ⚠ 只打印代理变量的**名**，不打印值：代理 URL 里可能嵌着 user:password。 */
const proxyDecision = decideProxyUse(process.env, runDirectProbe);
ghEnv = buildGhEnv(process.env, proxyDecision);
console.log(`» 发版网络路径：${proxyDecision.useProxy ? "走代理上传（保留代理变量）" : "直连上传（本次已清掉代理变量）"}`);
console.log(`  理由：${proxyDecision.reason}`);

// 构建耗时数分钟；发布前再次检查本地来源、远端 main 和已存在的 tag。
assertCleanSource(readGit, releaseHead);
assertRemoteSource(readGitRemote, {
  repository: releaseRepository, head: releaseHead, tag: `v${v}`,
});

const gh = (args) => {
  console.log("» gh", args.map((a) => (a.length > 60 ? a.slice(0, 57) + "…" : a)).join(" "));
  // env 显式给 ghEnv：上面那份是**新建**对象，构建阶段那份（process.env）没被动过。
  return execFileSync("gh", args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: ghEnv });
};
/* 上传失败要把三件事说清楚，否则现在这种「静默挂 20 分钟后失败」的形态等于
   把用户丢在黑箱前（实测还会被 gh 自己清掉刚建的 draft，连补救的落点都没了）：
 *   ① draft 可能已被清理 —— 给出确认命令；
 *   ② 卡住时看 CPU —— 几乎不动就是在等网络，不是在传；
 *   ③ 重试命令 —— 脚本整体重跑，或手工重发（--notes-file 避开引号/反引号地狱）。 */
const ghRc = (e) => (e && typeof e.status === "number" ? e.status : (e && e.signal ? `信号 ${e.signal}` : "?"));
try {
  gh([
    "release", "create", `v${v}`, "-R", `${owner}/${repo}`,
    "--target", releaseHead,
    `dist/${exe}`, `dist/${exe}.blockmap`, "dist/upgrade.ps1", "dist/rollback.ps1", `dist/${ymlName}`,
    "--title", `v${v}`, "--notes", notes,
    /* 预发布版在 GitHub 上标成 prerelease，**不会**占住 Latest。
     * 这一步很要紧：Latest 是人从 releases 页面点下载时的默认落点，
     * 测试版占了它，就等于把测试版塞给了所有人 —— 那不叫「选择性升级」。 */
    ...(isPre ? ["--prerelease"] : []),
  ]);
} catch (e) {
  console.error([
    ``,
    `✖ 发版失败：gh release create 退出码 ${ghRc(e)}`,
    ``,
    `  ⚠ gh 在上传失败时**可能已经删掉**刚创建的 draft release（这是 gh 自己的清理行为）。`,
    `    先确认草稿还在不在：  gh release view v${v} -R ${owner}/${repo}`,
    ``,
    `  ⚠ 如果这次是「长时间没输出然后失败」：看 CPU。占用几乎不动＝在等网络，不是在传。`,
    `    经代理传大包会这样（2026-10-12 卡 20+ 分钟）；上面已打印本次走的网络路径。`,
    ``,
    `  ↺ 重试（重跑全部闸门后重发）：  node scripts/publish.cjs`,
    `  ↺ 或手工重发上传：`,
    `      gh release create v${v} -R ${owner}/${repo} \\`,
    `        "dist/${exe}" "dist/${exe}.blockmap" dist/upgrade.ps1 dist/rollback.ps1 dist/${ymlName} \\`,
    `        --target ${releaseHead} --title v${v} --notes-file release-notes.md`,
    ``,
  ].join("\n"));
  throw e;
}
// 命令行参数没有被当作正文时（文件存在），把它作为「发布说明」追加到 GitHub release
// 正文——单纯给人看的备注，不影响 latest.yml。失败只警告：客户端更新日志不依赖它。
if (hasNotesFile && process.argv[2] && process.argv[2] !== notes) {
  try {
    gh(["release", "edit", `v${v}`, "-R", `${owner}/${repo}`, "--notes", `${notes}\n\n---\n\n${process.argv[2]}`]);
  } catch (e) { console.log("⚠ GitHub release 正文追加备注失败（不影响软件内更新日志）：", e.message); }
}
console.log(`\n✔ 已发布 v${v} → https://github.com/${owner}/${repo}/releases/tag/v${v}`);
console.log("  各电脑上的软件将在启动 8 秒内或点「检查更新」时自动收到新版。");
