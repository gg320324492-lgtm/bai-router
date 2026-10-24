/**
 * 热修「装在别处的这一份」—— scripts/hotfix-install.mjs
 *
 * ## 为什么要有这个脚本
 *
 * **本机跑的是安装版**（`%LOCALAPPDATA%\Programs\B.AI Router`），不是仓库里那份
 * ⇒ **仓库改了不会自动生效**。要生效只有两条路：
 *   ① 走发版流程（打安装包 → 装）—— 正规，但用户得等下载 + 点安装。
 *   ② **热修**：直接把改过的文件覆盖到安装目录 —— **立刻生效**，代价是
 *      「装的那一份」与「仓库」暂时不一致（发版后就一致了）。
 *
 * 这个脚本做 ②，且**做对了才动手**：
 *   · 先**停**软件（覆盖 asar 时文件被占着会失败）；
 *   · 覆盖**服务端**（`resources/server/`）—— 按仓库的 `src/server/` 整份同步；
 *   · 覆盖**壳**（`resources/app.asar`）—— 解包 → 换 `src/*.js` → 重打包；
 *     ⚠ **必须保留 asar 里的 `node_modules`**（electron-updater 在那儿）⇒
 *       所以是「解包 → 换文件 → 重打包」，不是「重新 pack 一个新的」。
 *   · **不动版本号**：装的那一份仍报它原来的版本 ⇒ 升级通道的行为不变
 *     （用户还在稳定通道上，就让他继续按稳定通道收更新；我们只是把 bug 修掉了）。
 *
 * ## 用法
 *
 *   node scripts/hotfix-install.mjs            # 先看一眼要改什么，再改
 *   node scripts/hotfix-install.mjs --apply    # 真改
 *
 * 环境变量：
 *   · `BAI_INSTALL_DIR` —— 安装目录（默认 `%LOCALAPPDATA%\Programs\B.AI Router`）
 *
 * ## 红线
 *
 * · 只覆盖**代码**，不碰用户的配置/日志/备份（那些在数据目录里）。
 * · 覆盖前给安装目录留一份 `.hotfix-bak`（只留被改的那几个文件）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

const INSTALL_DIR = String(process.env.BAI_INSTALL_DIR
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "B.AI Router"));
const ASAR = path.join(INSTALL_DIR, "resources", "app.asar");
const SERVER_DST = path.join(INSTALL_DIR, "resources", "server");
const ASAR_TOOL = path.join(REPO, "node_modules", ".bin", process.platform === "win32" ? "asar.cmd" : "asar");

/** 壳里那几个文件（要覆盖进 asar 的）。 */
const APP_FILES = ["src/main.js", "src/preload.js", "src/install-consistency.js", "src/update-channel.js"];

function log(m) { console.log(m); }

/** 目录下的全部文件（相对路径）。 */
function listFiles(dir, base = dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out);
    else out.push(path.relative(base, p).replace(/\\/g, "/"));
  }
  return out;
}

if (!fs.existsSync(ASAR)) {
  console.error(`★ 找不到 ${ASAR} —— 安装目录不对？（可用 BAI_INSTALL_DIR 指定）`);
  process.exit(1);
}

/* ── ① 要改哪些 ───────────────────────────────────────────── */
const serverFiles = listFiles(path.join(REPO, "src", "server"))
  .filter((f) => !f.startsWith("node_modules/"));
const changed = [];
for (const f of serverFiles) {
  const src = path.join(REPO, "src", "server", f);
  const dst = path.join(SERVER_DST, f);
  let same = false;
  try {
    same = fs.readFileSync(src).equals(fs.readFileSync(dst));
  } catch { same = false; }
  if (!same) changed.push(f);
}
const appChanged = APP_FILES.filter((f) => {
  const src = path.join(REPO, f);
  if (!fs.existsSync(src)) return false;
  try { return !fs.readFileSync(src).equals(fs.readFileSync(path.join(INSTALL_DIR, "resources", "app", f))); }
  catch { return true; }   // asar 里读不到 ⇒ 一律算要改
});

log(`安装目录：${INSTALL_DIR}`);
log(`服务端要覆盖 ${changed.length} 个文件，壳要覆盖 ${appChanged.length} 个：`);
for (const f of changed.slice(0, 40)) log(`  · server/${f}`);
for (const f of appChanged) log(`  · app/${f}`);
if (!changed.length && !appChanged.length) {
  log("（已经是最新 —— 不用动）");
  process.exit(0);
}
if (!APPLY) {
  log("\n（这只是预演。加 --apply 才真改。）");
  process.exit(0);
}

/* ── ② 停软件 ─────────────────────────────────────────────── */
log("\n停软件…");
try {
  execFileSync("taskkill", ["/F", "/T", "/IM", "B.AI Router.exe"], { stdio: "ignore", timeout: 30000 });
} catch { /* 本来就没在跑 */ }
await new Promise((r) => setTimeout(r, 1500));

/* ── ③ 覆盖服务端 ─────────────────────────────────────────── */
const bakDir = path.join(INSTALL_DIR, "resources", ".hotfix-bak");
for (const f of changed) {
  const src = path.join(REPO, "src", "server", f);
  const dst = path.join(SERVER_DST, f);
  if (fs.existsSync(dst)) {
    const bak = path.join(bakDir, f);
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(dst, bak);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
log(`服务端已覆盖 ${changed.length} 个文件（原件在 resources/.hotfix-bak/）`);

/* ── ④ 覆盖壳（解包 → 换文件 → 重打包）───────────────────── */
if (appChanged.length) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bai-asar-"));
  try {
    const r = spawnSync(ASAR_TOOL, ["extract", ASAR, tmp], { stdio: "inherit", shell: true });
    if (r.status !== 0) throw new Error(`解包失败（exit ${r.status}）`);
    for (const f of APP_FILES) {
      const src = path.join(REPO, f);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(tmp, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    const outAsar = ASAR + ".new";
    if (fs.existsSync(outAsar)) fs.rmSync(outAsar);
    const r2 = spawnSync(ASAR_TOOL, ["pack", tmp, outAsar], { stdio: "inherit", shell: true });
    if (r2.status !== 0) throw new Error(`重打包失败（exit ${r2.status}）`);
    /* ⚠ 换之前把旧的留一份（万一新包起不来，能退回去）。 */
    fs.copyFileSync(ASAR, ASAR + ".hotfix-bak");
    fs.copyFileSync(outAsar, ASAR);
    fs.rmSync(outAsar, { force: true });
    log(`壳已重打包（旧包留在 ${path.basename(ASAR)}.hotfix-bak）`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ── ⑤ 起软件 ─────────────────────────────────────────────── */
log("起软件…");
try {
  const exe = path.join(INSTALL_DIR, "B.AI Router.exe");
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
} catch (e) {
  log(`起软件失败：${e && e.message}（可以手动双击图标）`);
}
log("完。");
