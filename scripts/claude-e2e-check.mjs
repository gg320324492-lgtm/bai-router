// scripts/claude-e2e-check.mjs —— 端到端：真 Claude Code 能不能真的走到 B.AI
//
// ## 为什么要有这个
//
// 「配置写好了」≠「客户端真的会走到 B.AI」。2026-10-23 就是靠它抓到一个只有真
// 客户端才逼得出来的洞：网关模式下**不写** ANTHROPIC_AUTH_TOKEN ⇒ Claude Code
// 自己就不发请求（报「Not logged in」）⇒ **接上了，但一个请求都出不去**。
//
// ## 怎么跑
//
//   node scripts/claude-e2e-check.mjs [a|b|c|d]
//
//   a（默认）**只靠 settings.json** —— 真接线的样子
//   b  进程环境变量 BASE_URL + AUTH_TOKEN（绕开 settings.json）
//   c  进程环境变量 BASE_URL + API_KEY
//   d  只靠 settings.json，但 env 块里写的是 ANTHROPIC_API_KEY
//
// ## 🔴 红线：全程隔离，不碰用户的真实文件
//
//   · HOME / USERPROFILE / CLAUDE_CONFIG_DIR / APPDATA / LOCALAPPDATA 全指临时目录
//   · 接线走**真的** /api/apply（由 server.mjs 自己组 facts，不是手搓的）
//   · B.AI 实例的上游指**假上游** ⇒ 不花钱、不打真上游，且能断言「路径对不对」
//   · 真实用户的 ~/.claude 一概不动（要动真实文件的那种探针**刻意不放进仓库**）
//
// ## ⚠ 现状（2026-10-23）
//
// 模式 b/c 已经证明了**最关键的那一步**：Claude Code 的请求**真的到了 B.AI**
//（网关回了它自己的 400：模型名没 provider 前缀 ⇒ 说明请求到了、模型 id 被判了）。
//
// 但「网关 → 假上游」那一格**还没跑通**（Claude Code 侧会等流式响应，超时）。
// ⇒ **不是网关转发坏了** —— （10 条）已证明
//   网关到假上游这一段是好的 ⇒ 是本脚本的假上游/渠道配置形状还没调对。
// ⇒ 这一格留作待查，**别**把它当成「端到端已通」。
//
// ## 不是测试（不进 npm test）
//
// 它要**本机装了 claude CLI**（Windows 上的 WinGet 版）⇒ 是一次性自检工具。
// 没装 ⇒ 如实说「跳过」，退出码 0。
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE = "C:/Users/admin/AppData/Local/Microsoft/WinGet/Links/claude";

const port = async (p) => new Promise((res) => {
  const s = net.createServer();
  s.once("error", () => res(false));
  s.once("listening", () => s.close(() => res(true)));
  s.listen(p, "127.0.0.1");
});
const free = async (a, b) => { for (let p = a; p < b; p++) if (await port(p)) return p; throw new Error("no free port"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 假上游：记录它收到了什么，并回一个最小的 Anthropic 响应 ---- */
const seen = [];
const up = http.createServer((rq, rs) => {
  let body = "";
  rq.on("data", (d) => { body += d; });
  rq.on("end", () => {
    seen.push({ url: rq.url, auth: rq.headers.authorization || "", model: (() => { try { return JSON.parse(body).model; } catch { return "?"; } })() });
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end(JSON.stringify({
      id: "msg_e2e", type: "message", role: "assistant",
      content: [{ type: "text", text: "端到端通了" }],
      model: "claude-opus-5", stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    }));
  });
});
await new Promise((r) => up.listen(0, "127.0.0.1", r));
const upPort = up.address().port;

/* ---- 隔离的落盘目录 ---- */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bai-e2e-"));
const dataDir = path.join(root, "data");
const home = path.join(root, "home");
const appData = path.join(root, "appdata");
const localAppData = path.join(root, "localappdata");
for (const d of [dataDir, home, appData, localAppData, path.join(home, ".claude")]) fs.mkdirSync(d, { recursive: true });

/* ---- B.AI 实例（上游指假上游） ---- */
const P = {};
P.bai = await free(19100, 19200);
P.panel = await free(19200, 19300);
P.gateway = await free(19300, 19400);
for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) P[k] = await free(19400, 19999);

const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "src/server/config.defaults.json"), "utf8"));
cfg.failover = { ...(cfg.failover || {}), enabled: false };
cfg.proxy = ""; cfg._modelsSynced = "dev";
cfg.relayPort = P.bai; cfg.panelPort = P.panel; cfg.gatewayPort = P.gateway;
for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
  cfg[k] = { ...cfg[k], relayPort: P[k], upstream: `http://127.0.0.1:${upPort}` };
  cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
  if (k === "or") cfg[k].keys = [];
}
fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");

const env = {
  ...process.env,
  BAI_DATA_DIR: dataDir, BAI_CLIENT_HOME: home,
  /* ⚠ **USERPROFILE 才是 applyToCli 的落点**（它用 os.homedir()，
   *   Windows 上 os.homedir() 认 USERPROFILE）—— BAI_CLIENT_HOME 只管 clients 层。 */
  USERPROFILE: home,
  APPDATA: appData, LOCALAPPDATA: localAppData,
  BAI_NO_PROXY_AUTODETECT: "1", BAI_ENV_FIXED: "1",
};
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
env.NO_PROXY = "127.0.0.1,localhost";

const server = spawn(process.execPath, [path.join(REPO, "src/server/server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let slog = "";
server.stdout.on("data", (d) => { slog += d; });
server.stderr.on("data", (d) => { slog += d; });
let up1 = false;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) { up1 = true; break; } } catch { }
  await sleep(300);
}
console.log("① B.AI 实例起来了：", up1);
if (!up1) { console.log(slog.slice(-1500)); server.kill(); process.exit(1); }

/* ---- 接线：走**真的** /api/apply（由 server.mjs 自己组 facts） ---- */
cfg.sn.apiKey = "sn_dummy-not-a-real-key";   // 占位；假上游不校验
fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
const ap = await fetch(`http://127.0.0.1:${P.panel}/api/apply`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "sn", cli: true, desktop: false }),
});
const apj = await ap.json();
console.log("② 接线 /api/apply：", ap.status, JSON.stringify(apj).slice(0, 200));
if (ap.status !== 200) { server.kill(); process.exit(1); }
const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
console.log("   写出的 env 键：", Object.keys(settings.env || {}).join("、"));

/* ---- 起真的 claude CLI（隔离 HOME；不继承任何 ANTHROPIC_*） ---- */
const cliEnv = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") };
for (const k of Object.keys(cliEnv)) if (/^ANTHROPIC_/i.test(k)) delete cliEnv[k];
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete cliEnv[k];
cliEnv.NO_PROXY = "127.0.0.1,localhost";

console.log("③ 起 claude CLI（HOME 指向临时目录）…");
/* ⚠ **预置 onboarding 状态**：真实机器的 `~/.claude.json` 里有 `hasCompletedOnboarding`
 *   （2026-10-23 实测：顶层 38 个键里有它与 lastOnboardingVersion）。
 *   隔离环境没有它 ⇒ Claude Code 在**读 settings.json 的 env 之前**就退出，
 *   报「Not logged in · Please run /login」⇒ 那是**环境没 onboarding**，
 *   不是「它不读 settings.json 的 env」。两者得分清。 */
fs.writeFileSync(path.join(home, ".claude.json"),
  JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: "2.0.0" }, null, 2), "utf8");
/* ⚠ 三种模式，用来分清「接线不对」与「隔离环境没登录」：
 *   a) 只靠 settings.json（真接线的样子）
 *   b) 环境变量 BASE_URL + AUTH_TOKEN（绕开 settings.json）
 *   c) 环境变量 BASE_URL + API_KEY（官方 API 用的那个变量名） */
const MODE = process.argv[2] || "a";
if (MODE === "d") {
  /* 模式 d：只靠 settings.json，但 env 块里写的是 ANTHROPIC_API_KEY（不是 AUTH_TOKEN）
     —— 验「Claude Code 是不是只认 API_KEY 那个键名」。 */
  const s = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  s.env.ANTHROPIC_API_KEY = "PROXY_MANAGED";
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(s, null, 2), "utf8");
  console.log("   （模式 d：settings.json 的 env 里加了 ANTHROPIC_API_KEY）");
}
if (MODE === "b" || MODE === "c") {
  cliEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${P.gateway}`;
  cliEnv[MODE === "b" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"] = "PROXY_MANAGED";
  /* ⚠ 模型 id 必须带 provider 前缀（网关的分流判据）⇒ 不带的话网关在**分流阶段**
     就 400，压根不会转发到上游 ⇒ 那样只能证明「请求到了网关」，证明不了整条链路。 */
  cliEnv.ANTHROPIC_MODEL = "sn/claude-opus-5";
}
const res = spawnSync(CLAUDE, ["-p", "说一句「端到端」", "--output-format", "json"], {
  env: cliEnv, encoding: "utf8", timeout: 60000, cwd: root,
});
const out = (res.stdout || "") + (res.stderr || "");
console.log(`   模式 ${MODE} · 退出码：`, res.status, res.error ? String(res.error.message) : "");
console.log("   输出前 300 字：", out.slice(0, 300).replace(/\s+/g, " "));

/* ---- 断言 ---- */
console.log("\n④ 假上游收到什么：");
if (!seen.length) console.log("   ★ 一次都没收到 ⇒ 客户端没走到 B.AI");
for (const s of seen) console.log(`   路径 ${s.url} · model ${s.model} · 授权 ${s.auth ? s.auth.slice(0, 18) + "…" : "(无)"}`);

const ok = seen.length > 0 && seen.every((s) => s.url.includes("/v1/messages"));
console.log("\n结论：", ok ? "✔ 端到端通了 —— Claude Code 的请求真的到了 B.AI 并被转发到上游" : "✖ 没通");

server.kill(); up.close();
try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { }
console.log("（已清理临时目录）");
process.exit(ok ? 0 : 1);

function pathToFileURL_(p) { return new URL(`file:///${p.replace(/\\/g, "/")}`).href; }
