/**
 * 旧中转端口 = 统一网关的**兼容入口**（scripts/compat-relay-test.mjs）
 *
 * ## 测什么
 *
 * T2「单网关化」的收尾：旧的 8 个中转端口不再自己中转，而是把请求**转发给统一网关**
 * （先补上 `provider/档位` 前缀）⇒ 对内只剩一个中转，而**老配置照旧能用**。
 *
 *   ① 老配置（model 写**最终模型名**）打旧端口 ⇒ 补前缀 ⇒ 网关分流 ⇒ 上游收到
 *   ①′ 用**别的档位**的模型名 ⇒ 也补上前缀并分流进来（不补就会 400）
 *   ② model 已经是 `provider/档位` ⇒ 原样（不被二次处理）
 *   ③ 网关本身照旧（不受影响）
 *   ④ **网关模式关掉 ⇒ 旧端口自己中转**（回退路径完整，不用重启）
 *
 * ## ⚠ 判据里有个容易搞反的地方
 *
 * **网关的职责就是把 `provider/档位` 的前缀剥掉再打上游** ⇒ **假上游看到的是最终
 * 模型名**（如 `hy3`），**不是** `bai/claude-opus-5` ⇒ 拿「上游看到 provider/档位」
 * 当判据会**永远红**。
 * ⇒ 真正证明「前缀补上了」的是：**客户端拿到 200**（不补 ⇒ 网关 400
 *   「模型名 hy3 没有 provider 前缀」）。
 *
 * ## 🔴 红线
 *
 * · 落盘只在 `os.tmpdir()` 下的临时目录（DATA_DIR / HOME / APPDATA 全隔离）；
 * · 上游是**本机假服务** ⇒ 不发真请求、不花钱；
 * · 端口动态挑空闲（真机上 15721–15799 都被 B.AI 占着）；
 * · 进程只按 **PID** 收。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const freePort = async (p) => new Promise((res) => {
  const s = net.createServer();
  s.once("error", () => res(false));
  s.once("listening", () => s.close(() => res(true)));
  s.listen(p, "127.0.0.1");
});
const free = async (a, b) => { for (let p = a; p < b; p++) if (await freePort(p)) return p; throw new Error("没有空闲端口"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("旧中转端口 = 统一网关的兼容入口", () => {
  let server, root, dataDir, home, cfgFile, P, up, seen = [];
  let upPort = 0;

  before(async () => {
    /* 本机假上游：记录它收到了什么 */
    up = http.createServer((rq, rs) => {
      const chunks = [];
      rq.on("data", (c) => chunks.push(c));
      rq.on("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { }
        seen.push({ url: rq.url, model: body && body.model });
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(JSON.stringify({
          id: "msg_x", type: "message", role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: (body && body.model) || "x", stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      });
    });
    await new Promise((r) => up.listen(0, "127.0.0.1", r));
    upPort = up.address().port;

    root = fs.mkdtempSync(path.join(os.tmpdir(), "bai-compat-relay-"));
    dataDir = path.join(root, "data");
    home = path.join(root, "home");
    for (const d of [dataDir, home]) fs.mkdirSync(d, { recursive: true });

    P = {};
    P.bai = await free(19100, 19120);
    P.gateway = await free(19120, 19140);
    P.panel = await free(19140, 19160);
    let pcur = 19160;
    for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
      P[k] = await free(pcur, pcur + 40);
      pcur = P[k] + 1;   // ⚠ 每个渠道必须**不同**的端口
    }

    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "src/server/config.defaults.json"), "utf8"));
    cfg.failover = { ...(cfg.failover || {}), enabled: false };
    cfg.proxy = ""; cfg._modelsSynced = "dev";
    cfg.relayPort = P.bai; cfg.panelPort = P.panel; cfg.gatewayPort = P.gateway;
    cfg.gatewayMode = "on";
    /* ⚠ 兼容入口是**默认关**的开关（默认行为一字不变）⇒ 这条测试**显式打开**它，
       测的正是「打开之后」的新行为。 */
    cfg.legacyPortAsGateway = "on";
    /* ⚠ 兼容入口是**默认关**的开关（默认行为一字不变）⇒ 这条测试**显式打开**它，
    /* bai 的一档：模型 id 是档位名、目标是最终模型名 */
    cfg.mapping = { "claude-opus-5": { target: "hy3", label: "HY3" } };
    cfg.apiKey = "dummy-not-a-real-key";
    cfg.upstream = `http://127.0.0.1:${upPort}`;
    for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
      cfg[k] = { ...cfg[k], relayPort: P[k], upstream: `http://127.0.0.1:${upPort}` };
      cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
      if (k === "or") cfg[k].keys = [];
    }
    cfgFile = path.join(dataDir, "config.json");
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), "utf8");

    const env = {
      ...process.env, BAI_DATA_DIR: dataDir, BAI_CLIENT_HOME: home, USERPROFILE: home,
      APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
      BAI_NO_PROXY_AUTODETECT: "1", BAI_ENV_FIXED: "1",
    };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    env.NO_PROXY = "127.0.0.1,localhost";

    server = spawn(process.execPath, [path.join(REPO, "src/server/server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let slog = "";
    server.stdout.on("data", (d) => { slog += d; });
    server.stderr.on("data", (d) => { slog += d; });
    for (let i = 0; i < 120; i++) {
      try {
        const st = await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json());
        if (st.service && st.service.up) return;
      } catch { }
      await sleep(300);
    }
    throw new Error("server.mjs 起不来：" + slog.slice(-1500));
  }, { timeout: 120000 });

  after(() => {
    try { server && server.kill(); } catch { }
    try { up && up.close(); } catch { }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { }
  });

  const post = async (port_, body, path_ = "/v1/messages") => {
    const r = await fetch(`http://127.0.0.1:${port_}${path_}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    return { status: r.status, text: await r.text() };
  };

  test("① 老配置（model 写最终模型名）打旧端口 ⇒ 补前缀 ⇒ 网关分流 ⇒ 上游收到", async () => {
    seen.length = 0;
    const r = await post(P.bai, { model: "hy3", messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    assert.equal(seen.length, 1, `假上游没收到请求（收到 ${seen.length} 次）`);
    assert.equal(r.status, 200, `客户端应拿到 200（不补前缀的话网关会 400），实际 ${r.status}：${r.text.slice(0, 200)}`);
    assert.doesNotMatch(r.text, /没有 provider 前缀/, "★ 网关说模型名没 provider 前缀 ⇒ 前缀没补上");
  });

  test("①′ 别的档位的模型名也补上前缀并分流进来（不补就会 400）", async () => {
    seen.length = 0;
    const r = await post(P.bai, { model: "qwen3.8-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    assert.equal(seen.length, 1, `上游没收到（${seen.length} 次）`);
    assert.equal(seen[0].model, "qwen3.8-flash");
    assert.equal(r.status, 200, `实际 ${r.status}：${r.text.slice(0, 200)}`);
  });

  test("② model 已经是 provider/档位 ⇒ 原样转发（不被二次处理）", async () => {
    seen.length = 0;
    const r = await post(P.bai, { model: "bai/claude-opus-5", messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    assert.equal(seen.length, 1);
    /* ⚠ 上游看到的是**最终模型名**（网关把前缀剥掉了）—— 那是对的，不是 bug */
    assert.equal(seen[0].model, "hy3");
    assert.equal(r.status, 200);
  });

  test("③ 网关本身照旧（不受兼容入口影响）", async () => {
    seen.length = 0;
    const r = await post(P.gateway, { model: "bai/claude-opus-5", messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    assert.equal(seen.length, 1);
    assert.equal(r.status, 200);
  });

  test("④ 网关模式关掉 ⇒ 旧端口自己中转（回退路径完整，不用重启）", async () => {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    cfg.gatewayMode = "off";
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), "utf8");
    await sleep(1500);
    seen.length = 0;
    const r = await post(P.bai, { model: "hy3", messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    assert.equal(seen.length, 1, `老路自己中转没生效（上游收到 ${seen.length} 次）`);
    assert.equal(seen[0].model, "hy3", "★ 关掉后模型名应原样（老路不补前缀）");
    assert.equal(r.status, 200);
  });
});
