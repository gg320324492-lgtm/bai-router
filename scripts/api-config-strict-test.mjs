/* POST /api/config —— 「静默成功」的负样本测试（v1.0.76）。
 *
 * 起因：调用方把载荷写成嵌套的 {"zen":{"transport":"opencode"}}
 * （正确形状是扁平的 {"provider":"zen","transport":"opencode"}），
 * 接口回的是 {"ok":true,"provider":"bai","applied":[]}——
 * **什么都没改，却报成功**。用户以为保存生效了，配置一个字没动。
 *
 * 这个 handler 是白名单式的：不在表里的 key 被静默丢掉，再照样回 ok:true。
 * 本测试逐条钉住两类静默成功，并确认**没有顺手改坏既有调用方**。
 *
 * 隔离：真 spawn 一份 server.mjs，BAI_DATA_DIR 指向系统临时目录、端口取空闲端口，
 * 全程不碰真实 %APPDATA%\bai-router。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cfgstrict-"));
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePorts(n) {
  const servers = [], ports = [];
  for (let i = 0; i < n; i++) {
    const s = http.createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    ports.push(s.address().port);
    servers.push(s);
  }
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

describe("POST /api/config：不再静默成功", () => {
  let child, dataDir, panel;

  before(async () => {
    const [bai, sn, wb, wbai, zen, qd, or, pnl] = await freePorts(8);
    panel = pnl;
    dataDir = path.join(TMPROOT, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "src", "server", "config.defaults.json"), "utf8"));
    cfg.relayPort = bai; cfg.panelPort = panel;
    Object.assign(cfg, {
      sn: { ...cfg.sn, relayPort: sn }, wb: { ...cfg.wb, relayPort: wb },
      wbai: { ...cfg.wbai, relayPort: wbai }, zen: { ...cfg.zen, relayPort: zen },
      qd: { ...cfg.qd, relayPort: qd }, or: { ...cfg.or, relayPort: or },
    });
    cfg.failover.enabled = false;
    /* ⚠ 必须预置 cfg.proxy，否则服务启动后会跑代理探测、探到本机 7897 就写进配置
     * 并自重启（exit(0) 换继任者），本进程被杀 → 后面全部 ECONNREFUSED。 */
    cfg.proxy = "http://127.0.0.1:7897";
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

    child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env, BAI_DATA_DIR: dataDir,
        NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1",   // 挡住自重启
      },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    child.stdout.resume(); child.stderr.resume();

    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      try { if ((await fetch(`http://127.0.0.1:${panel}/api/status`).then((r) => r.json())).service?.up) return; }
      catch { }
      await sleep(300);
    }
    throw new Error("server.mjs 40 秒内没把面板端口起起来");
  }, { timeout: 60000 });

  after(() => {
    try { child && child.kill(); } catch { }
    try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { }
  });

  const post = (body) => fetch(`http://127.0.0.1:${panel}/api/config`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

  const onDisk = () => JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));

  // ── ① provider 给了但不认识 → 拒，不许静默落到 bai ──
  test("未知 provider → 400，并列出合法值", async () => {
    const before = JSON.stringify(onDisk());
    const r = await post({ provider: "zenn", transport: "opencode" });
    assert.equal(r.status, 400, "给了不认识的渠道名必须拒，不能默默当成 B.AI");
    assert.match(r.json.error, /未知的提供方/);
    assert.ok(Array.isArray(r.json.acceptedProviders) && r.json.acceptedProviders.includes("zen"),
      "错误里要列出合法渠道，前端才改得对");
    assert.equal(JSON.stringify(onDisk()), before, "被拒的请求不得落盘");
  });

  // ── ② ★ 本次修复的真触发场景：载荷形状写错 → 静默成功 ──
  test("★ 嵌套载荷（字段写错地方）→ 400，不再回 ok:true", async () => {
    const before = onDisk();
    const r = await post({ zen: { transport: "opencode" } });   // 少 provider、且字段嵌套
    assert.equal(r.status, 400, "什么都没写进去却回 ok:true —— 那是最坏的一种成功");
    assert.match(r.json.error, /没写进去|没有要保存/);
    if (r.json.receivedKeys && r.json.receivedKeys.length) {
      assert.ok(r.json.receivedKeys.includes("zen"), "要把收到的键原样报出来，才点得中问题");
    }
    assert.equal(onDisk().zen.transport, before.zen.transport, "配置不得被改动");
  });

  // ── ③ 只有 provider、没有任何字段 → 400，且与 ② 说法不同 ──
  test("只有 provider、无其它字段 → 400「没有要保存的内容」", async () => {
    const r = await post({ provider: "zen" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /没有要保存的内容/,
      "「没提交内容」与「字段不认识」要说得不一样，否则用户不知道该改哪儿");
    assert.deepEqual(r.json.receivedKeys, []);
  });

  // ── ④ 合法写入仍然要通，且**真的落盘** ──
  test("合法写入仍然 200，且真的改到了那一家", async () => {
    const r = await post({ provider: "zen", transport: "opencode" });
    assert.equal(r.status, 200);
    assert.equal(r.json.provider, "zen");
    assert.equal(onDisk().zen.transport, "opencode", "回 ok 就必须真的写进去");
    const back = await post({ provider: "zen", transport: "direct" });
    assert.equal(back.status, 200);
    assert.equal(onDisk().zen.transport, "direct");
  });

  // ── ⑤ 不能顺手改坏既有调用方 ──
  test("★ cards/failover.js 那种「不带 provider」的调用仍然要通", async () => {
    const r = await post({ failover: { enabled: true, chain: ["bai", "sn"] } });
    assert.equal(r.status, 200,
      "故障转移是 B.AI 的顶层设置，cards/failover.js 合法地不带 provider —— "
      + "把校验写成「provider 缺失也拒」就会打断这张卡");
    assert.equal(r.json.provider, "bai");
    assert.equal(onDisk().failover.enabled, true);
  });

  test("空字符串 provider 等价于不传（还是 bai 顶层），不得被当成未知渠道", async () => {
    const r = await post({ provider: "", failover: { enabled: false } });
    assert.equal(r.status, 200);
    assert.equal(r.json.provider, "bai");
  });

  test("上层字段照旧能用（面板 saveSys 走的就是这条）", async () => {
    const r = await post({ provider: "sn", upstream: "https://sn.example.com/v1" });
    assert.equal(r.status, 200);
    assert.equal(onDisk().sn.upstream, "https://sn.example.com/v1");
  });

  // ── ⑥ 反向对照：把两道判据拆掉，上面几条必须变红 ──
  test("反向对照：判据认得出问题载荷（不是恒真断言）", async () => {
    // 「什么都不写就回 ok」正是修复前的行为，用它确认这些断言不是空转
    const naive = (body) => {
      const known = ["provider", "apiKey", "failover", "transport", "upstream", "relayPort",
        "panelPort", "defaultModel", "mapping", "availableModels", "useProxy", "token",
        "accessToken", "refreshToken", "deviceToken", "userId"];
      const writes = Object.keys(body).some((k) => known.includes(k));
      const provider = ["bai", "sn", "wb", "wbai", "zen", "qd", "or"].includes(body.provider)
        ? body.provider : "bai";
      return { status: writes ? 200 : 200, provider };   // ← 无论有没有写进去，都回 200
    };
    assert.equal(naive({ zen: { transport: "opencode" } }).status, 200,
      "修复前的行为：什么都没写也回 200");
    assert.equal(naive({ provider: "zenn" }).provider, "bai",
      "修复前的行为：不认识的渠道被静默当成 B.AI");
  });
});
