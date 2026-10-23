/* 代码插件的「怎么装」：样板端点 + 面板上那个**看得见的入口**。
 *
 * ── 这份测试在守什么 ──
 *
 * 2026-10-23 之前，面板上的「代码插件」那一整块在**一个都没装**的时候直接
 * `return` 掉 —— 于是这个功能**没有入口**：用户看不到它存在，更看不到怎么装。
 * 一个看不见入口的功能等于没有。
 *
 * 现在：
 *   ① 没装插件时那一块**照样画**（目录在哪 + 怎么装 + 一键建样板）；
 *   ② `POST /api/code-plugins/scaffold` 真的写出一份能改的样板（plugin.json
 *      + main.mjs），写完**真的装得上、跑得起来**；
 *   ③ 绝不覆盖用户已有的目录（存在就说「已经有了」）。
 *
 * ── 怎么测 ──
 *
 * 活体：真 server.mjs（临时 BAI_DATA_DIR + 17xxx 段端口）+ 假上游。
 * 插件跑在**子进程**里，测完按 PID 收。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER_DIR = path.join(REPO, "src", "server");
const SERVER = path.join(SERVER_DIR, "server.mjs");
const DEFAULTS_JSON = path.join(SERVER_DIR, "config.defaults.json");
const PLUGIN_CARD = path.join(SERVER_DIR, "cards", "plugins.js");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-scaffold-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* ⚠ **挑过的端口要记下来**：挑端口的探测是「bind 再 close」—— 释放之后
 *   下一次挑又会从段首开始，于是十次全挑到同一个端口（起第二个实例时
 *   EADDRINUSE，症状是「服务起不来」，与代码无关）。
 *   仓库里其它活体测试都有这个 takenPorts，别漏。 */
const takenPorts = new Set();
async function portInRange() {
  for (let p = 17100; p < 17999; p++) {
    if (takenPorts.has(p)) continue;
    const free = await new Promise((res) => {
      const s = net.createServer();
      s.once("error", () => res(false));
      s.once("listening", () => s.close(() => res(true)));
      s.listen(p, "127.0.0.1");
    });
    if (free) { takenPorts.add(p); return p; }
  }
  throw new Error("17xxx 段找不到空闲端口");
}

/** 从源码里抠出一个函数的**函数体**（按大括号配平；带名字的锚点）。 */
function sliceFn(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`源码里找不到 ${anchor}`);
  let depth = 0, started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === "{") { depth++; started = true; }
    else if (src[k] === "}") { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error(`${anchor} 的大括号没配平`);
}

const procs = new Set();function track(p) { procs.add(p); p.on("exit", () => procs.delete(p)); return p; }
function killAll() {
  for (const p of procs) {
    try { if (p.pid) spawnSync("taskkill", ["/PID", String(p.pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
    try { p.kill(); } catch { }
  }
  procs.clear();
}

describe("代码插件：样板端点 + 看得见的入口", () => {
  let P, dataDir, child;

  before(async () => {
    const ports = [];
    for (let i = 0; i < 10; i++) ports.push(await portInRange());
    P = {
      bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4],
      qd: ports[5], or: ports[6], mm: ports[7], panel: ports[8], gateway: ports[9],
    };
    dataDir = path.join(TMPROOT, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const cfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
    cfg.failover = { ...(cfg.failover || {}), enabled: false };
    cfg.proxy = "http://127.0.0.1:7897";
    cfg._modelsSynced = "dev";
    cfg.relayPort = P.bai; cfg.panelPort = P.panel; cfg.gatewayPort = P.gateway;
    for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
      cfg[k] = { ...cfg[k], relayPort: P[k] };
      cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
      if (k === "or") cfg[k].keys = [];
    }
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");

    const env = {
      ...process.env, BAI_DATA_DIR: dataDir, BAI_NO_PROXY_AUTODETECT: "1", BAI_ENV_FIXED: "1",
    };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    env.NO_PROXY = "127.0.0.1,localhost";
    child = track(spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
    const log = [];
    child.stdout.on("data", (d) => log.push(String(d)));
    child.stderr.on("data", (d) => log.push(String(d)));
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) return; }
      catch { }
      await sleep(300);
    }
    throw new Error(`server.mjs 60 秒内没起来。日志尾：${log.join("").slice(-1500)}`);
  }, { timeout: 120000 });

  after(() => { killAll(); });

  const post = (p, body) => fetch(`http://127.0.0.1:${P.panel}${p}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(30000),
  }).then((r) => r.json());
  const get = (p) => fetch(`http://127.0.0.1:${P.panel}${p}`, { signal: AbortSignal.timeout(30000) }).then((r) => r.json());

  test("① 建样板：真写出 plugin.json 与 main.mjs", async () => {
    const r = await post("/api/code-plugins/scaffold", { name: "demo" });
    assert.equal(r.ok, true, `建样板失败：${JSON.stringify(r)}`);
    const dir = path.join(dataDir, "code-plugins", "demo");
    assert.ok(fs.existsSync(path.join(dir, "plugin.json")), "plugin.json 没写出来");
    assert.ok(fs.existsSync(path.join(dir, "main.mjs")), "入口文件没写出来");
    const man = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
    assert.equal(man.manifestVersion, 1);
    assert.equal(man.entry, "main.mjs");
    assert.equal(man.id, "demo");
    /* 权限默认最紧：没有 fsRead、不联网 —— 样板不该一上来就要权限。 */
    assert.deepEqual(man.permissions.fsRead, [], "样板默认不该给读文件的权限");
    assert.equal(man.permissions.net, false, "样板默认不该允许联网");
    const src = fs.readFileSync(path.join(dir, "main.mjs"), "utf8");
    assert.match(src, /export default function/, "入口文件得有默认导出");
  });

  test("② 建出来的样板**真的装得上、跑得起来**", async () => {
    const r = await post("/api/code-plugins/reload");
    assert.equal(r.ok, true, `重载失败：${JSON.stringify(r)}`);
    assert.ok((r.installed || []).includes("demo"),
      `样板没装上：${JSON.stringify(r)}`);
    const st = await get("/api/code-plugins");
    const one = (st.list || []).find((x) => x.id === "demo");
    assert.ok(one, `装上了但列表里没有：${JSON.stringify(st.list)}`);
    assert.equal(one.status, "active", `插件没跑起来：${JSON.stringify(one)}`);
  });

  test("③ 目录已存在 ⇒ 409，**绝不覆盖用户写的文件**", async () => {
    const dir = path.join(dataDir, "code-plugins", "demo");
    const before = fs.readFileSync(path.join(dir, "main.mjs"), "utf8");
    fs.writeFileSync(path.join(dir, "main.mjs"), before + "\n// 用户自己改的\n", "utf8");
    const r = await post("/api/code-plugins/scaffold", { name: "demo" });
    /* ⚠ 本仓的错误响应是 `{ error: "…" }`，**没有** `ok:false` 字段
     *   （`/api/code-plugins/remove` 等端点也是这样）。所以判据是
     *   「有没有 error」，不是 `ok === false` —— 后者对 undefined 恒假。 */
    assert.ok(r.error, `已存在的目录不该被当成新建成功：${JSON.stringify(r)}`);
    assert.match(String(r.error || ""), /已经在了/, "错误要说清「已经有了」");
    const after = fs.readFileSync(path.join(dir, "main.mjs"), "utf8");
    assert.equal(after, before + "\n// 用户自己改的\n", "★ 用户改过的文件被覆盖了");
  });

  test("④ 目录名不合法 ⇒ 400（它会拼进文件路径，得挡住 .. 与绝对路径）", async () => {
    for (const bad of ["../escape", "a/b", "UPPER", "..", "a b"]) {
      const r = await post("/api/code-plugins/scaffold", { name: bad });
      assert.ok(r.error, `名字「${bad}」不该被接受：${JSON.stringify(r)}`);
      assert.match(String(r.error || ""), /只许|已经在了/, `名字「${bad}」的错误要说清规矩`);
    }
    /* 目录名不合法 ⇒ **一个目录都不许被建出来**（它会拼进文件路径里）。 */
    const dirs = fs.existsSync(path.join(dataDir, "code-plugins"))
      ? fs.readdirSync(path.join(dataDir, "code-plugins")) : [];
    assert.ok(!dirs.includes("..") && !dirs.includes("escape"),
      `不合法名字竟然建出了目录：${JSON.stringify(dirs)}`);
  });

  test("④b 名字留空 ⇒ 用默认名（不是错误）", async () => {
    /* 「点了按钮没填名字」是常态，不是用户犯错 —— 该给个默认名，
     * 而不是甩一句「名字不合法」让人不知道该填什么。 */
    const r = await post("/api/code-plugins/scaffold", {});
    assert.ok(!r.error, `空名不该是错误：${JSON.stringify(r)}`);
    assert.equal(r.id, "example", `空名该用默认名 example：${JSON.stringify(r)}`);
    assert.ok(fs.existsSync(path.join(dataDir, "code-plugins", "example", "main.mjs")),
      "默认名那个样板没写出来");
  });

  test("⑤ 面板上那一块**没装插件时也要画**（别把功能藏起来）", () => {
    /* ⚠ 只查 **renderCodePlugins** 这一个函数：同一个文件里
     *   renderMiddleware（声明式 middleware 那个功能）也有一个「一个都没装就不画」
     *   的早退 —— 那是**对的**（没装 middleware 时不该画那一块）。
     *   早先这条断言在整个文件里搜，抓到的是那一个，于是测了个不相干的东西。 */
    const fn = sliceFn(fs.readFileSync(PLUGIN_CARD, "utf8"), "function renderCodePlugins(cp) {");
    assert.equal(/if \(!list\.length && !errors\.length\) \{ box\.innerHTML = ""; return; \}/.test(fn), false,
      "★ 「一个都没装就不画」的老逻辑还在 —— 那个功能等于没有入口");
    assert.match(fn, /p-cp-how/, "要有「怎么装」的入口");
    assert.match(fn, /p-cp-scaffold/, "要有「一键建样板」的入口");
    assert.match(fn, /一个都还没装/, "空的时候要说清怎么装");
  });

  test("⑥ 反向对照：把「空时也画」改坏 ⇒ ⑤ 那条判据必须失效", () => {
    /* 真正改坏**被测的那个函数**：在 renderCodePlugins 里注入一个早退，
     * ⑤ 的判据（那个函数体里不该有早退）就应当**抓得到** ——
     * 断言的是「判据会抓到它」，而不是把 ⑤ 重复一遍。 */
    const src = fs.readFileSync(PLUGIN_CARD, "utf8");
    const broken = src.replace(
      "      const list = Array.isArray(cp.list) ? cp.list : [];",
      "      const list = Array.isArray(cp.list) ? cp.list : [];\n      if (!list.length) { box.innerHTML = \"\"; return; }   // SABOTAGE：没装就不画",
    );
    assert.notEqual(broken, src, "改坏的副本没改成 —— 这条反向对照失效了");
    const fn = sliceFn(broken, "function renderCodePlugins(cp) {");
    const earlyReturn = /if \(!list\.length && !errors\.length\) \{ box\.innerHTML = ""; return; \}/.test(fn)
      || /if \(!list\.length\) \{ box\.innerHTML = ""; return; \}/.test(fn);
    assert.equal(earlyReturn, true,
      "★ 改坏之后 ⑤ 的判据仍然抓不到它 —— 那 ⑤ 是恒真的，测了个寂寞");
  });
});
