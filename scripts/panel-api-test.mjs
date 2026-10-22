/* 配置备份 / 审计台账 的**接口**活体测试（真起一个 server.mjs）。
 *
 * 这条链路上有三件事只有真跑起来才验得了：
 *   ① 备份文件**真的**落在备份目录里，而且**明文不在文件里**；
 *   ② 口令错 / 文件名带路径 → 服务端**拒**（不是回一句含糊的错误）；
 *   ③ 导入**之前**会把当前配置另存一份 —— 还原是破坏性的，得留回头路。
 *
 * ⚠ 落盘只在 os.tmpdir() 下的临时目录 + BAI_DATA_DIR，**绝不碰真实
 *   %APPDATA%\bai-router**，也绝不碰真实的 ~/.claude/settings.json。
 * ⚠ 夹具里的凭据一律 `sk-test-…`（明显是假的）。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(REPO, "src", "server", "server.mjs");
const DEFAULTS_JSON = path.join(REPO, "src", "server", "config.defaults.json");
const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-backup-api-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

describe("备份 / 审计接口（真 server.mjs）", () => {
  let child = null;
  let dataDir = "";
  let panel = 0;
  let relayOf = {};
  let killed = false;

  before(async () => {
    const ports = [];
    for (let i = 0; i < 11; i++) ports.push(await freePort());
    assert.equal(new Set(ports).size, 11, "端口必须互不相同");
    /* ⚠ 端口逐个对号入座，别用 indexOf 去索引 —— 那样很容易把两个角色分到同一个号
     *   （本仓库吃过一次：面板和中转撞号，服务起不来，测试只报「超时」看不出原因）。 */
    const ROLES = ["bai", "sn", "wb", "wbai", "zen", "qd", "mm", "or"];
    ROLES.forEach((k, i) => { relayOf[k] = ports[i]; });
    panel = ports[8];
    const gateway = ports[9];
    dataDir = fs.mkdtempSync(path.join(TMPROOT, "data-"));
    const cfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
    cfg.failover.enabled = false;
    cfg.proxy = "http://127.0.0.1:7897";   // 预置成命中探测的值 → applyProxy 首行短路，不自重启
    cfg.relayPort = relayOf.bai; cfg.panelPort = panel;
    /* ⚠ 统一网关的端口**必须**改：出厂的 15799 是真实装机正在用的号，
     *   测试抢它 = 抢用户的端口（这正是 sandbox-launch.cjs 逐个改端口的原因）。 */
    cfg.gatewayPort = gateway;
    for (const k of ROLES.slice(1)) cfg[k] = { ...cfg[k], relayPort: relayOf[k] };
    /* 塞一把**假的**凭据进去：导出后要验「明文不在备份文件里」。 */
    cfg.apiKey = "sk-test-0000000000000000000000000000000000000001";
    cfg.sn = { ...cfg.sn, apiKey: "sk-test-0000000000000000000000000000000000000002" };
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

    const env = { ...process.env, BAI_DATA_DIR: dataDir, BAI_ENV_FIXED: "1", BAI_NO_PROXY_AUTODETECT: "1" };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    env.NO_PROXY = "127.0.0.1,localhost";
    child = spawn(process.execPath, [SERVER_PATH], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out = [];
    child.stdout.on("data", (d) => out.push(String(d)));
    child.stderr.on("data", (d) => out.push(String(d)));
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      try {
        const s = await fetch(`http://127.0.0.1:${panel}/api/status`).then((r) => r.json());
        if (s && s.service && s.service.up) return;
      } catch { }
      await sleep(300);
    }
    throw new Error("真 server.mjs 40 秒内没把面板端口起起来。\n" + out.join("").slice(-800));
  }, { timeout: 90000 });

  after(() => {
    if (child && child.pid && !killed) {
      killed = true;
      try { spawnSync("taskkill", ["/PID", String(child.pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { }
      try { child.unref(); } catch { }
    }
    try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { }
  });

  /* ⚠ 失败是用 **HTTP 状态码**表示的（仓库惯例：body 里只有 error，没有 ok:false；
   *   面板的 ctx.api 就是靠 !r.ok 抛错并把 j.error 显示出来）。所以这里把状态码
   *   一并带回来 —— 只看 body 会把「400 + error」当成成功。 */
  const api = async (p, opts) => {
    const r = await fetch(`http://127.0.0.1:${panel}${p}`, opts);
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, body: j };
  };
  const post = (p, body) => api(p, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  test("① 备份清单：目录对、初始为空", async () => {
    const r = await api("/api/backup");
    assert.equal(r.status, 200);
    assert.ok(String(r.body.dir || "").endsWith("backups"), `备份目录不对：${r.body.dir}`);
    assert.deepEqual(r.body.files, [], "一开始不该有备份");
  });

  test("② 口令太短 → 拒（太短等于没加密）", async () => {
    const r = await post("/api/backup/export", { passphrase: "1234" });
    assert.equal(r.status, 400, "4 位口令居然放行了");
    assert.match(String(r.body.error || ""), /8/, "错误信息要说明要多少位");
  });

  test("③ 导出：文件真落盘，且**明文不在文件里**", async () => {
    const r = await post("/api/backup/export", { passphrase: "correct-horse-battery" });
    assert.equal(r.status, 200, `导出失败：${JSON.stringify(r.body)}`);
    const name = r.body.name;
    assert.ok(name && String(name).endsWith(".bak"), "文件名后缀不对");
    const file = path.join(dataDir, "backups", name);
    assert.ok(fs.existsSync(file), "备份文件没落盘");
    const raw = fs.readFileSync(file);
    const asLatin = raw.toString("latin1");
    assert.equal(asLatin.includes("sk-test-0000"), false, "**明文凭据进了备份文件**");
    assert.equal(asLatin.includes("glm-5.2"), false, "明文模型名进了备份文件");
    /* 清单里能看到它 */
    const list = await api("/api/backup");
    assert.ok(list.body.files.some((f) => f.name === name), "备份清单里没有刚导出的那份");
    assert.ok(list.body.files[0].bytes > 0, "大小不该是 0");
  });

  test("④ 口令错 → 导入被拒，且**当前配置没被动过**", async () => {
    const before = fs.readFileSync(path.join(dataDir, "config.json"), "utf8");
    const list = await api("/api/backup");
    const name = list.body.files[0].name;
    const r = await post("/api/backup/import", { passphrase: "wrong-passphrase", file: name });
    assert.equal(r.status, 400, "错口令居然导入成功了");
    assert.match(String(r.body.error || ""), /口令|PASSPHRASE/i, "错误信息要说清是口令不对");
    assert.equal(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"), before, "失败的导入动了配置");
  });

  test("⑤ 文件名带路径 → 拒（否则一个 ../ 就能读任意文件进来解密）", async () => {
    for (const bad of ["../config.json", "..\\config.json", "sub/dir.bak"]) {
      const r = await post("/api/backup/import", { passphrase: "correct-horse-battery", file: bad });
      assert.equal(r.status, 400, `文件名 ${bad} 居然被放行了`);
    }
  });

  test("⑥ 导入成功：配置还原，且**还原前另存了一份**", async () => {
    const list = await api("/api/backup");
    const name = list.body.files[0].name;
    /* 先把配置改掉（去掉那把假凭据），再导入，看它有没有被还原回来。 */
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    delete cfg.apiKey;
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

    const r = await post("/api/backup/import", { passphrase: "correct-horse-battery", file: name });
    assert.equal(r.status, 200, `导入失败：${JSON.stringify(r.body)}`);
    assert.equal(r.body.changed, true, "配置明明少了一把它却说没变化");
    const after = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    assert.equal(after.apiKey, "sk-test-0000000000000000000000000000000000000001", "凭据没被还原回来");
    /* 还原前的配置另存了一份 —— 还原是破坏性的，得留回头路。 */
    assert.ok(r.body.safety && fs.existsSync(r.body.safety), "还原前没另存当前配置");
    assert.match(String(r.body.safety), /before-import/, "另存的文件名不对");
  });

  test("⑦ 审计台账接口可读（空态不是错）", async () => {
    const r = await api("/api/audit");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.records), "records 必须是数组");
    assert.ok(r.body.summary && typeof r.body.summary.total === "number", "summary 要有 total");
  });

  test("⑧ 限流：默认不限（上限 0），存了也读得回来", async () => {
    const before = await api("/api/limits");
    assert.equal(before.status, 200);
    assert.equal(before.body.limits.concurrency, 0, "默认不该限流");
    assert.equal(before.body.limits.rpm, 0, "默认不该限流");

    const save = await post("/api/limits", { concurrency: 2, rpm: 30 });
    assert.equal(save.status, 200, `保存失败：${JSON.stringify(save.body)}`);
    const after = await api("/api/limits");
    assert.equal(after.body.limits.concurrency, 2);
    assert.equal(after.body.limits.rpm, 30);
    await post("/api/limits", { concurrency: 0, rpm: 0 });
  });

  test("⑨ ★ 闸门在链路上，而且**名额一定会被还**", async () => {
    /* 漏一次释放 = 永久占一个坑 = 那家的请求从此全排队（用户看到的是「卡住」，
     * 而不是「并发上限」——那种 bug 极难查）。
     * 所以这里打若干个**必然失败**的请求（上游没人听 → 连不上），
     * 失败走的正是「异常路径」—— 最容易漏释放的那条路。 */
    await post("/api/limits", { concurrency: 1, rpm: 0 });
    /* 上游指到一个没人听的端口 → 必然连不上 */
    const cfgPath = path.join(dataDir, "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.sn = { ...cfg.sn, upstream: "http://127.0.0.1:9" };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    /* 让服务端重新读配置：POST /api/limits 会 loadCfg → saveCfg，顺带把磁盘上的
     * 配置换成服务端看到的那份（它把 limits 合并进去）。 */
    await post("/api/limits", { concurrency: 1, rpm: 0 });

    const before = await api("/api/limits");
    const got0 = numOr0(before.body.stats && before.body.stats.sn && before.body.stats.sn.acquired);

    for (let i = 0; i < 3; i++) {
      await fetch(`http://127.0.0.1:${relayOf.sn}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-opus-5", max_tokens: 8, messages: [{ role: "user", content: "闸门自检" }] }),
      }).catch(() => { });
    }

    const after = await api("/api/limits");
    const s = (after.body.stats && after.body.stats.sn) || {};
    assert.ok(numOr0(s.acquired) > got0, `闸门没在链路上（acquired 没涨：${JSON.stringify(s)}）`);
    assert.equal(numOr0(s.busy), 0, "还有名额没释放（busy≠0）—— 那家会一直排队");
    assert.equal(numOr0(s.leaked), 0, "有名额漏还了 —— 那家从此永久排队");

    /* 顺带验一下**审计台账**：刚才那几次尝试都该在册（哪怕它们全失败了）。
     * 这是审计台账存在的意义 —— 「昨天卡了」得能翻出那段时间每条请求去了哪。 */
    const au = await api("/api/audit?limit=50");
    const snRecs = au.body.records.filter((r) => r.provider === "sn");
    assert.ok(snRecs.length >= 3, `审计台账里 sn 的记录只有 ${snRecs.length} 条 —— 那几次尝试没被记下来`);
    assert.ok(snRecs.some((r) => r.outcome === "error"), "失败的那几次也要在册（失败的尝试最该被记）");
    /* 台账里绝不能出现凭据 */
    assert.equal(JSON.stringify(au.body.records).includes("sk-test-0000"), false, "审计台账里出现了凭据！");

    await post("/api/limits", { concurrency: 0, rpm: 0 });
  });
});

function numOr0(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
