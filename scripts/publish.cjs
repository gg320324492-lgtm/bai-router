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
    /* 仓库当前的出厂默认：下面多处要拿它当权威值，先读一次。 */
    const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "server", "config.defaults.json"), "utf8"));
    // sn（SenseNova）块：发布机 config 可能还没有（旧版未写入）或残留密钥——一律以代码默认+脱敏为准
    if (def.sn) { def.sn = { ...def.sn, apiKey: "" }; }
    else if (CUR.sn) { def.sn = { ...CUR.sn, apiKey: "" }; }
    // wb / wbai（WorkBuddy 两版）块：JWT 令牌绝不进发布机快照；发布机没配过就沿用代码默认（同样脱敏）
    // 两版凭据彼此独立，必须各清各的 —— 漏掉 wbai 就等于把国际版的 1411 字符 JWT 随安装包发给所有机器。
    // userId 一起清：它是指名账号的标识（请求里当 x-user-id 头带），本身不能鉴权，
    // 但它是本机登录态的一部分，与令牌同源。运行期 wbEnsureToken() 会从用户自己的
    // 登录态回填，出厂默认留空才是对的。v1.0.65 实测产物里两版都带着真实 UUID 发出去过。
    const WBD = { accessToken: "", refreshToken: "", deviceToken: "", userId: "" };
    if (def.wb) { def.wb = { ...def.wb, ...WBD }; }
    else if (CUR.wb) { def.wb = { ...CUR.wb, ...WBD }; }
    if (def.wbai) { def.wbai = { ...def.wbai, ...WBD }; }
    else if (CUR.wbai) { def.wbai = { ...CUR.wbai, ...WBD }; }
    // zen（OpenCode Zen）块：API Key 同样绝不进快照
    if (def.zen) { def.zen = { ...def.zen, apiKey: "" }; }
    else if (CUR.zen) { def.zen = { ...CUR.zen, apiKey: "" }; }
    // or（OpenRouter）块：三把 API Key 绝不进发布机快照——快照随安装包发给所有机器，
    // key 进去等于公开泄露（v1.0.58 加第 6 家时补上；本机没配过时从仓库 defaults 继承结构、keys 仍清空）。
    if (def.or) { def.or = { ...def.or, keys: [] }; }
    else if (CUR.or) { def.or = { ...CUR.or, keys: [] }; }
    /* ════════════════════════════════════════════════════════════════════
       「本机状态」字段：仓库里的值才是出厂默认，发布机那份只是这台机器当前的样子。
       快照是随安装包发给所有机器的，把本机状态烘进去等于让发布者替所有用户做决定。

       · failover  「这台机器勾没勾故障转移」是用户偏好。旧实现 `def.failover || 仓库`
                    让发布机的设置只要存在就赢——发布机关着开关，每次发布都把随包快照的
                    enabled 改成 false，发给所有新用户。
       · proxy     出厂默认就该是空（= 直连）。历史上存的是本机端口（v1.0.1 起 7890、
                    v1.0.19 改 7897），等于把一个只在你机器上成立的地址发给所有人。
                    启动自检会纠正它，所以一直没暴露——但那只是掩盖，不是没问题。
       · wb.upstream  发布机那条是 loadCfg 的 wbHealUpstream 按登录域名**自愈**的结果
                    （v1.0.59 起 .ai/.cn 之间切换），把自愈结果当出厂默认，等于替所有
                    新用户选了版别。自愈本身在运行期还会再跑一次。
       · zen.transport 「这台机器走直连还是走 OpenCode 客户端中转」是本机选择。
                    v1.0.75 加这一档时漏在这里：发布机那份 config.json 里不带该字段，
                    随包快照里也就没有它——出厂默认「靠缺失兜底成 direct」虽然行为正确，
                    但**更糟的情况是发布者自己切到了 opencode 再发版**，
                    快照就会把 opencode 当出厂默认发给所有新用户。
                    与 proxy 完全同类，故按规矩写进这一段。

       四者共同点：运行期 server.mjs 都会按各自机器修正它们，所以留在出厂默认里没有
       任何好处，只有"看起来配置齐全"的错觉。新增同类字段请写进这一段，别再散着写。

       ⚠ 自检：发布后请看 `git status`。这段改写的是**仓库里的** config.defaults.json，
       若它变脏了，说明上面某个「本机状态」字段漏在了这一段之外——那就是要修的地方。
       ════════════════════════════════════════════════════════════════════ */
    if (CUR.failover) {
      const fo = { ...CUR.failover };
      /* 允许清单要跟着 providers.js 走。漏一个渠道的后果是静默的：仓库 defaults 里
         明明写了 wbai（v1.0.65 加的第 7 家），这里会被当"未知渠道"剔掉，
         随包快照的故障转移链就少了国际版，且没有任何报错。 */
      const chain = (fo.chain || []).filter((x) => ["bai", "sn", "wb", "wbai", "zen", "qd", "or"].includes(x));
      /* 收敛后为空就原样保留仓库里写的 chain：这段只做"剔除未知渠道 / 兜底垫末尾"，
         不该把一份完整的出厂默认改写成空链。 */
      if (chain.length) {
        if (!chain.includes("or")) chain.push("or");
        fo.chain = chain;
      }
      def.failover = fo;
    } else {
      delete def.failover;   // 仓库里没写这个块，就别把发布机的带进随包快照
    }
    def.proxy = CUR.proxy == null ? "" : CUR.proxy;
    /* zen.transport 同样只认仓库的（本机选择不进出厂默认，见上面那段说明） */
    if (def.zen) def.zen.transport = (CUR.zen && CUR.zen.transport) || "direct";
    if (def.wb && CUR.wb && CUR.wb.upstream) def.wb.upstream = CUR.wb.upstream;
    /* availableModels 也取仓库的，不取发布机的。
     *
     * 理由与上面 failover/proxy 同一类，而且后果更直接：清单（providers.js）的 models
     * 才是映射下拉真正渲染的那一份，C8 闸门要求两者**逐条完全相等**。把发布机
     * 扫出来的目录烘进随包快照，就等于让这台机器的目录覆盖掉清单——两者一旦不同，
     * 闸门直接拦下发布（v1.0.65 实测：发布机的 wb 目录已长到 33 个、wbai 23 个，
     * 而清单里各只有 3 个，闸门报「在 seed config 里多出 30 个」）。
     *
     * 以前没暴露，是因为发布机的目录一直和清单一样短。用户扫了一次目录就漂了。
     * 随包默认应该反映项目认定的模型集合；要更新就改仓库里那份，两边一起改。 */
    if (Array.isArray(CUR.availableModels)) def.availableModels = CUR.availableModels;
    for (const k of ["sn", "wb", "wbai", "zen", "or", "qd"]) {
      if (def[k] && Array.isArray(CUR[k] && CUR[k].availableModels)) {
        def[k] = { ...def[k], availableModels: CUR[k].availableModels };
      }
    }
    /* 档位映射（tier → 目标模型 / 显示名）与默认模型，同样以仓库为准。
     *
     * 与 availableModels 同一类理由：它是**这台机器的用户偏好**，不是出厂默认。
     * 随包快照发给的是每一个新装用户，把发布者挑的模型烘进去，等于替所有用户做了
     * 这个选择。实测：v1.0.68 发布时本机的 `or` 档位是 nvidia/nemotron-3.5-lightning:free，
     * 仓库里写的是 openrouter/free——发布脚本把前者写回了随包默认。
     * （C8 闸门放行了它：那个模型确实在仓库的 or.availableModels 里，所以不算错，
     *   但「不算错」和「该由谁决定」是两件事。）
     *
     * 要改出厂默认就改仓库里这份，两边一起改——和 availableModels 同一套做法。 */
    for (const k of ["sn", "wb", "wbai", "zen", "or", "qd"]) {
      if (!def[k]) continue;
      const cur = CUR[k] || {};
      if (cur.mapping && typeof cur.mapping === "object") def[k].mapping = cur.mapping;
      if (typeof cur.defaultModel === "string" && cur.defaultModel) def[k].defaultModel = cur.defaultModel;
    }
    if (typeof CUR.defaultModel === "string" && CUR.defaultModel) def.defaultModel = CUR.defaultModel;
    console.log(`» 本机状态字段取自仓库 defaults: proxy=${def.proxy || "(空=直连)"}`
      + ` failover.enabled=${def.failover ? def.failover.enabled : "(无)"}`
      + ` wb.upstream=${(def.wb && def.wb.upstream) || "(无)"}`);
    // qd（Qoder）块：token 是手动兜底用的 jt- jobToken，绝不进快照
    // （正常路径下它恒为空——真实令牌由 worker 补丁写在 %TEMP%\qoder-token.json，不落 config）
    // tokenFile/modelsFile 是发布机的 %TEMP% 绝对路径，原样进快照会被 C13 闸门拦下；
    // 清空即可——运行期 fixQdFile() 会把空值/异机路径自愈回本机 os.tmpdir()。
    if (def.qd) { def.qd = { ...def.qd, token: "", tokenFile: "", modelsFile: "" }; }
    else if (CUR.qd) { def.qd = { ...CUR.qd, token: "", tokenFile: "", modelsFile: "" }; }
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
