/**
 * agent plugin 的**接线**（scripts/agent-plugin-wiring-test.mjs）
 *
 * ## 测什么
 *
 * `scripts/agent-plugin-test.mjs` 测的是**模块本身**（声明怎么读、怎么长成客户端
 * 声明）。这一份测的是**接线那一层** —— 也就是「用户放一份声明到面板上能不能看见、
 * 坏声明会不会被藏起来」：
 *
 *   ① `GET /api/clients` 要给出**插件目录**（否则用户不知道往哪放声明）
 *   ② `POST /api/clients/rescan` 要真的**丢掉缓存重扫**（不然用户放完声明点
 *      「重新扫描」没反应 —— 名录有缓存，re-scan 只把缓存又拉了一遍）
 *   ③ 重扫后**插件客户端要出现在列表里**，且带 plugin 标记
 *   ④ **坏声明要变成看得见的坏条目**（不能炸掉整张列表，也不能被藏起来）
 *   ⑤ `broken` 标记要**传给面板**（面板据此不给「接上/断开」按钮）
 *
 * ## 🔴 红线
 *
 *   · 落盘只在 os.tmpdir() 下的临时目录（DATA_DIR / home / APPDATA 全隔离）
 *   · 端口动态挑空闲；进程只按 **PID** 收
 *   · 全文没有一个真实令牌/API key
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const port = async (p) => new Promise((res) => {
  const s = net.createServer();
  s.once("error", () => res(false));
  s.once("listening", () => s.close(() => res(true)));
  s.listen(p, "127.0.0.1");
});
const free = async (a, b) => { for (let p = a; p < b; p++) if (await port(p)) return p; throw new Error("没有空闲端口"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("agent plugin 的接线：放一份声明 ⇒ 面板上看得见", () => {
  let server, root, dataDir, home, plugDir, P, slog = "";

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bai-plugin-wiring-"));
    dataDir = path.join(root, "data");
    home = path.join(root, "home");
    plugDir = path.join(dataDir, "agent-plugins");
    for (const d of [dataDir, home, plugDir]) fs.mkdirSync(d, { recursive: true });

    P = {};
    P.bai = await free(19100, 19200);
    P.panel = await free(19200, 19300);
    P.gateway = await free(19300, 19400);
    for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) P[k] = await free(19400, 19999);

    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "src", "server", "config.defaults.json"), "utf8"));
    cfg.failover = { ...(cfg.failover || {}), enabled: false };
    cfg.proxy = ""; cfg._modelsSynced = "dev";
    cfg.relayPort = P.bai; cfg.panelPort = P.panel; cfg.gatewayPort = P.gateway;
    for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
      cfg[k] = { ...cfg[k], relayPort: P[k], upstream: "http://127.0.0.1:1" };
      cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
      if (k === "or") cfg[k].keys = [];
    }
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");

    const env = {
      ...process.env,
      BAI_DATA_DIR: dataDir, BAI_CLIENT_HOME: home, USERPROFILE: home,
      APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
      BAI_NO_PROXY_AUTODETECT: "1", BAI_ENV_FIXED: "1",
    };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    env.NO_PROXY = "127.0.0.1,localhost";

    server = spawn(process.execPath, [path.join(REPO, "src", "server", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (d) => { slog += d; });
    server.stderr.on("data", (d) => { slog += d; });
    for (let i = 0; i < 120; i++) {
      try {
        const st = await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json());
        if (st.service && st.service.up) return;
      } catch { }
      await sleep(300);
    }
    throw new Error("server.mjs 起不来：" + slog.slice(-1200));
  }, { timeout: 120000 });

  after(() => {
    try { server && server.kill(); } catch { }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { }
  });

  const get = async () => (await fetch(`http://127.0.0.1:${P.panel}/api/clients`)).json();
  const rescan = async () => {
    const r = await fetch(`http://127.0.0.1:${P.panel}/api/clients/rescan`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    return { status: r.status, json: await r.json() };
  };

  test("① /api/clients 要给出插件目录（用户得知道往哪放声明）", async () => {
    const j = await get();
    assert.equal(j.ok, true);
    assert.ok(j.pluginsDir, "★ 没给插件目录 ⇒ 用户不知道从哪下手");
    assert.ok(String(j.pluginsDir).includes("agent-plugins"), `目录不对：${j.pluginsDir}`);
  });

  test("② rescan 要真的重扫（丢缓存），不是把缓存又拉一遍", async () => {
    const before = (await get()).list.length;
    fs.writeFileSync(path.join(plugDir, "demo.json"), JSON.stringify({
      manifestVersion: 1, id: "demo-cli", name: "Demo CLI", protocol: "chat",
      note: "测试用的", config: "~/.demo-cli.conf.json", format: "json",
      writes: { "api-base": "${baseUrlV1}", "api-key": "${apiKey}" },
      wired: { path: "api-base", value: "${baseUrlV1}" },
    }, null, 2), "utf8");
    const r = await rescan();
    assert.equal(r.status, 200, `rescan 失败：${JSON.stringify(r.json)}`);
    assert.equal(r.json.ok, true);
    assert.ok(r.json.count > before, `★ 重扫后客户端数没变（${before} → ${r.json.count}）`);
    assert.ok(r.json.dir, "★ 没给插件目录");
  });

  test("③ 插件客户端出现在列表里，且带 plugin 标记", async () => {
    const j = await get();
    const demo = (j.list || []).find((c) => c.id === "demo-cli");
    assert.ok(demo, `★ 插件客户端不在列表里：${(j.list || []).map((c) => c.id).join(", ")}`);
    assert.equal(demo.plugin, true, "★ 没带 plugin 标记 ⇒ 面板上分不出它是用户自己加的");
    assert.equal(demo.protocol, "chat");
  });

  test("④ 坏声明 ⇒ 看得见的坏条目（不炸整张列表，也不被藏起来）", async () => {
    fs.writeFileSync(path.join(plugDir, "broken.json"), "{ 这不是 JSON", "utf8");
    await rescan();
    const j = await get();
    const bad = (j.list || []).find((c) => String(c.id || "").startsWith("broken"));
    assert.ok(bad, "★ 坏声明没变成坏条目（要么被藏起来、要么把整张列表炸了）");
    assert.match(String(bad.note || ""), /装不上|失败|不对/, "坏条目要说清为什么坏");
  });

  test("⑤ broken 标记要传给面板（面板据此不给「接上/断开」按钮）", async () => {
    const j = await get();
    const bad = (j.list || []).find((c) => String(c.id || "").startsWith("broken"));
    assert.ok(bad);
    assert.equal(bad.broken, true, "★ broken 没传给面板 ⇒ 面板会给坏条目显示「接上」按钮");
  });
});
