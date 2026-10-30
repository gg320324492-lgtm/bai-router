/**
 * scripts/failover-model-truth-test.mjs ——
 * 故障转移之后，**面板显示的模型 / 渠道必须就是实际在服务的那一个**。
 *
 * ## 这条链路此前是断的（2026-10-30 实测）
 *
 * 起一个隔离实例（真 server + 两个假上游）：入口 bai 的上游回 500 → 转移到 sn 成功。
 * **实际服务的是 sn 按自己映射重解析出来的模型**（探针实测：上游 B 收到的是 sn 的模型），
 * 可是改之前 /api/status 给的是：
 *
 *   顶层（= bai 那一格）的 recent:
 *     { tier: "claude-opus-5", target: <bai 打算路由的模型>,
 *       served: <**同一个**>, mismatch: **false** }
 *   sn.recent: { tier: null }
 *
 * ⇒ **面板显示的模型 ≠ 实际服务的模型，而它自己算出来的「不一致」还是 false**
 *   —— 全链路没有一处说真话（目标渠道那格干脆是空的）。
 *   这正是用户待办里「模型显示对不上」那一条的机制。
 *
 * ## 改完之后必须成立
 *
 *   ① 入口那格的 `recent.served` = **实际服务的那家**发出去的模型；
 *   ② `recent.target` 仍是「我们打算路由到哪」（入口家的映射）；
 *   ③ 两者不同 ⇒ `mismatch === true` ⇒ 面板**现有的**告警机制如实报出来；
 *   ④ `recent.servedProvider` = 实际服务的那家的渠道键；`recent.handoff` = 确实换了人；
 *   ⑤ 目标渠道那格**也有**这次调用的观察（tier 非空），且它自己**不**被误报成不一致；
 *   ⑥ **没换人**时（普通成功请求）：served === target、mismatch === false、
 *      servedProvider 为 null —— 一条误报都不许有。
 *
 * ## 判别力（为什么这不是恒真的测试）
 *
 * 同一个实例里连打两条请求，**只改上游的行为**：
 *   · 第一条：上游回 200 ⇒ 不转移 ⇒ 断言 mismatch=false、servedProvider=null；
 *   · 第二条（隔 2.5 秒，让它成为独立的一条观察）：上游回 500 ⇒ 转移
 *     ⇒ 断言 mismatch=true、servedProvider=sn、handoff=true。
 * 两条断言互为对照：判据若是恒真的，第一条必然红。
 *
 * ## 红线
 *
 * 🔴 落盘只在 os.tmpdir() 下的临时目录 + BAI_DATA_DIR，**绝不碰真实的
 *    %APPDATA%\bai-router**；端口全部动态挑空闲；进程只按 **PID** 收。
 * 🔴 全文没有一个真实令牌（夹具里的凭据是明显假的占位串）；不连真网络
 *    （所有渠道的 upstream 都指到假上游）。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER_DIR = path.join(REPO, "src", "server");
const SERVER = path.join(SERVER_DIR, "server.mjs");
const DEFAULTS_JSON = path.join(SERVER_DIR, "config.defaults.json");
const PANEL_SRC = fs.readFileSync(path.join(SERVER_DIR, "panel-common.js"), "utf8");
const QUOTA_SRC = fs.readFileSync(path.join(SERVER_DIR, "cards", "quota-panel.js"), "utf8");

/* 夹具常量：全部带 test- 前缀，断言里出现它们只可能来自本测试自己配的夹具。 */
const BAI_MODEL = "test-bai-opus-model";   // bai 自己映射出来的模型（转移**前**打算发的）
const SN_MODEL = "test-sn-opus-model";     // sn 自己映射出来的模型（转移**后**真正发的）
const TOK_BAI = "test-bai-key-placeholder";
const TOK_SN = "test-sn-key-placeholder";

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-fo-model-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

async function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

const procs = new Set();
function track(p) { procs.add(p); p.on("exit", () => procs.delete(p)); return p; }
function killAll() {
  for (const p of procs) {
    try { if (p.pid) spawnSync("taskkill", ["/PID", String(p.pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
    try { p.kill(); } catch { }
  }
  procs.clear();
}

/**
 * 假上游：mode 由 `gate.mode` 决定（"ok" / "fail"）。
 * 记下每一次 /v1/messages 的模型名 —— 那是「谁真的服务了」的**上游视角**的事实。
 */
function startFakeUpstream(gate, hits) {
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      const url = String(rq.url || "");
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) || {}; } catch { }
      if (url.indexOf("/v1/messages") < 0) { rs.writeHead(404); rs.end("{}"); return; }
      const model = String(body.model || "");
      hits.push({ url, model });
      if (gate.mode === "fail") {
        rs.writeHead(500, { "content-type": "application/json" });
        rs.end(JSON.stringify({ error: { message: "boom (fixture)" } }));
        return;
      }
      rs.writeHead(200, { "content-type": "application/json" });
      rs.end(JSON.stringify({
        id: "msg_fixture", type: "message", role: "assistant", model,
        content: [{ type: "text", text: "fixture:" + model }],
        stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 },
      }));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

describe("故障转移后：面板显示的渠道/模型 = 实际在服务的那一个", () => {
  let child, upstreamA, upstreamB, dataDir, P;
  const hitsA = [], hitsB = [];
  const gateA = { mode: "ok" }, gateB = { mode: "ok" };
  let stdout = "";

  before(async () => {
    upstreamA = await startFakeUpstream(gateA, hitsA);
    upstreamB = await startFakeUpstream(gateB, hitsB);
    const portA = upstreamA.address().port, portB = upstreamB.address().port;
    P = { bai: await freePort(), sn: await freePort(), panel: await freePort() };

    dataDir = path.join(TMPROOT, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const cfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));

    /* 入口 bai（扁平）：字段摊在 cfg 顶层。 */
    cfg.apiKey = TOK_BAI;
    cfg.upstream = `http://127.0.0.1:${portA}`;
    cfg.relayPort = P.bai;
    cfg.defaultModel = BAI_MODEL;
    cfg.availableModels = [BAI_MODEL];
    cfg.mapping = { "claude-opus-5": { target: BAI_MODEL, label: "档·Opus" } };

    /* 目标 sn：转移时按**它自己的**映射重解析 ⇒ 真正发出去的是 SN_MODEL。 */
    cfg.sn = {
      ...cfg.sn,
      apiKey: TOK_SN,
      upstream: `http://127.0.0.1:${portB}`,
      relayPort: P.sn,
      useProxy: false,
      defaultModel: SN_MODEL,
      availableModels: [SN_MODEL],
      mapping: { "claude-opus-5": { target: SN_MODEL, label: "档·Opus" } },
    };

    /* 其余渠道：全部指到假上游、凭据清空 ⇒ 启动期的目录同步碰不到真网络。 */
    for (const k of ["wb", "wbai", "zen", "qd", "mm", "or"]) {
      cfg[k] = { ...cfg[k], relayPort: await freePort(), upstream: `http://127.0.0.1:${portA}` };
      cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
      if (k === "or") cfg[k].keys = [];
    }
    cfg.panelPort = P.panel;
    cfg._modelsSynced = "dev";
    /* 打开故障转移，链上只有 sn。 */
    cfg.failover = { ...(cfg.failover || {}), enabled: true, chain: ["sn"] };
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");

    const env = {
      ...process.env, BAI_DATA_DIR: dataDir, BAI_NO_PROXY_AUTODETECT: "1", BAI_ENV_FIXED: "1",
    };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    env.NO_PROXY = "127.0.0.1,localhost";
    child = track(spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stdout += String(d); });
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) return; }
      catch { }
      await sleep(300);
    }
    throw new Error(`server.mjs 60 秒内没起来。日志尾：${stdout.slice(-1500)}`);
  }, { timeout: 120000 });

  after(() => {
    killAll();
    try { upstreamA && upstreamA.close(); } catch { }
    try { upstreamB && upstreamB.close(); } catch { }
  });

  const ask = () => fetch(`http://127.0.0.1:${P.bai}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${TOK_BAI}` },
    body: JSON.stringify({ model: "claude-opus-5", max_tokens: 900, messages: [{ role: "user", content: "问" }] }),
    signal: AbortSignal.timeout(30000),
  }).then(async (r) => ({ status: r.status, text: await r.text() }));

  const status = () => fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json());

  test("① 不转移：面板显示的模型 = 实际服务的模型，且**不许**报不一致", async () => {
    gateA.mode = "ok";
    hitsA.length = 0; hitsB.length = 0;
    const r = await ask();
    assert.equal(r.status, 200, `应当成功。实际 ${r.status}：${r.text.slice(0, 200)}`);

    const chatA = hitsA.filter((h) => h.url.indexOf("/v1/messages") >= 0);
    assert.equal(chatA.length, 1, `入口上游应当被调用一次。实际 ${JSON.stringify(hitsA)}`);
    assert.equal(chatA[0].model, BAI_MODEL, `实际服务的应当是 bai 自己的模型。实际 ${JSON.stringify(chatA.map((h) => h.model))}`);
    assert.equal(hitsB.length, 0, "★ 没失败就不该转移，上游 B 一个字都不该收到");

    const st = await status();
    /* ⚠ bai 在 /api/status 里是**平铺**的（历史字段名，见 statusPayload），不在 st.bai 下。 */
    const R = st.recent;
    assert.equal(R.tier, "claude-opus-5", `实际 ${JSON.stringify(R)}`);
    assert.equal(R.target, BAI_MODEL, `实际 ${JSON.stringify(R)}`);
    assert.equal(R.served, BAI_MODEL, `实际 ${JSON.stringify(R)}`);
    assert.equal(R.mismatch, false, `★ 正常路径不许报不一致。实际 ${JSON.stringify(R)}`);
    assert.equal(R.servedProvider, null, `★ 没换人就不该有「谁在服务」。实际 ${JSON.stringify(R)}`);
    assert.equal(R.handoff, false, `实际 ${JSON.stringify(R)}`);
  }, { timeout: 60000 });

  test("② 转移：入口那格显示**实际服务的那家**，目标那格也有观察，两边都不说假话", async () => {
    /* 隔 2.5 秒，让这条成为**独立**的一条观察（否则会与上一条合并成同一条）。 */
    await sleep(2500);
    gateA.mode = "fail";                 // 入口上游这一轮失败
    hitsA.length = 0; hitsB.length = 0;
    const r = await ask();
    assert.equal(r.status, 200, `转移后应当成功。实际 ${r.status}：${r.text.slice(0, 200)}`);

    /* ① 上游视角的事实：真正服务的是 sn 自己的模型。 */
    const chatB = hitsB.filter((h) => h.url.indexOf("/v1/messages") >= 0);
    assert.equal(chatB.length, 1, `目标上游应当被调用一次。实际 ${JSON.stringify(hitsB)}`);
    assert.equal(chatB[0].model, SN_MODEL,
      `★ 实际服务的必须是 sn 按自己映射重解析出来的模型。实际 ${JSON.stringify(chatB.map((h) => h.model))}`);

    const st = await status();

    /* ② 入口那格：served 必须是实际服务的那家，target 仍是「打算路由到哪」。 */
    const R = st.recent;
    assert.equal(R.served, SN_MODEL,
      `★ 入口那格显示的模型必须是实际服务的那个（${SN_MODEL}）。实际 ${JSON.stringify(R)}`);
    assert.equal(R.target, BAI_MODEL, `target 仍是入口家打算路由到的那个。实际 ${JSON.stringify(R)}`);
    assert.equal(R.mismatch, true,
      `★ 两个模型不同 ⇒ mismatch 必须为 true，否则面板不会报「不一致」。实际 ${JSON.stringify(R)}`);
    assert.equal(R.servedProvider, "sn", `★ 必须说清是哪家在服务。实际 ${JSON.stringify(R)}`);
    assert.equal(R.handoff, true, `★ 这次确实换了人。实际 ${JSON.stringify(R)}`);

    /* ③ 目标那格：也要有这次调用的观察，而且**不**被误报成不一致。 */
    const T = st.sn.recent;
    assert.ok(T.tier, `★ 目标渠道那格也得记下这次调用（tier 为空 = 面板说它没动静，其实它刚服务过）。实际 ${JSON.stringify(T)}`);
    assert.equal(T.served, SN_MODEL, `目标那格显示的模型必须是它自己发的那个。实际 ${JSON.stringify(T)}`);
    assert.equal(T.target, SN_MODEL, `目标那格的 target 也是它自己的映射。实际 ${JSON.stringify(T)}`);
    assert.equal(T.mismatch, false, `★ 目标那格不许被误报成「不一致」。实际 ${JSON.stringify(T)}`);

    /* ④ 故障转移屏那份留痕仍然对（它本来就是对的，别被这次改动弄坏）。 */
    const sj = st.failover.silentJump;
    assert.ok(sj && sj.total >= 1, `实际 ${JSON.stringify(sj)}`);
    const hop = sj.active.find((x) => x.from === "bai" && x.to === "sn");
    assert.ok(hop, `实际 ${JSON.stringify(sj.active)}`);
    assert.equal(hop.model, SN_MODEL, `实际 ${JSON.stringify(hop)}`);
  }, { timeout: 60000 });
});

/* ====================================================================== *
 * 面板层：措辞必须说清「实际是哪家在服务」，且不许编造
 * ====================================================================== */
describe("面板措辞：说得出「谁在服务」，且不编造", () => {
  /** 把 panel-common.js 里的 modelIdentityItems + servedNote 抠出来在 vm 里求值。 */
  function loadIdentity() {
    const ls = PANEL_SRC.split(/\r?\n/);
    const a = ls.findIndex((l) => l.includes("function modelIdentityItems(S, name) {"));
    if (a < 0) throw new Error("抠不出 modelIdentityItems —— 签名变了？");
    const b = ls.findIndex((l, i) => i > a && l.trim() === "function buildDiag() {");
    if (b < 0) throw new Error("抠不出收尾 buildDiag");
    const body = `(() => {
      const esc = (s) => String(s == null ? "" : s);
      ${ls.slice(a, b).join("\n")}
      return { modelIdentityItems, servedNote };
    })()`;
    return vm.runInNewContext(body, { console }, { filename: "panel-model-identity" });
  }

  test("① 换了人：标题点名「由哪家提供」，正文点破「换了渠道」", () => {
    const { modelIdentityItems } = loadIdentity();
    const st = {
      servedProviderName: "示例目标家",
      recent: {
        tier: "claude-opus-5", label: "档·Opus",
        target: "模型A", served: "模型B", mismatch: true, handoff: true,
        observedAt: new Date("2026-10-30T08:00:00.000Z").toISOString(),
      },
      modelFallback: [],
    };
    const items = modelIdentityItems(st, "示例入口家");
    assert.equal(items.length, 1, `实际 ${JSON.stringify(items)}`);
    const it = items[0];
    assert.equal(it.s, "err", `实际 ${it.s}`);
    assert.ok(it.t.includes("模型A"), `★ 标题要含「打算路由到」的。实际 ${it.t}`);
    assert.ok(it.t.includes("模型B"), `★ 标题要含「实际服务的」。实际 ${it.t}`);
    assert.ok(it.t.includes("示例目标家"), `★ 标题要含实际服务那家的名字。实际 ${it.t}`);
    assert.match(it.t, /实际服务的是/, `实际 ${it.t}`);
    assert.match(it.m, /换了渠道/, `★ 正文要点破「换了渠道」。实际 ${it.m}`);
  });

  test("② 没换人（老格式 / 无 servedProviderName）：一个字都不许多", () => {
    const { modelIdentityItems } = loadIdentity();
    const st = {
      recent: {
        tier: "claude-opus-5", label: "档·Opus",
        target: "模型A", served: "模型B", mismatch: true,
        observedAt: new Date("2026-10-30T08:00:00.000Z").toISOString(),
      },
      modelFallback: [],
    };
    const items = modelIdentityItems(st, "示例入口家");
    assert.equal(items.length, 1, `实际 ${JSON.stringify(items)}`);
    const it = items[0];
    assert.match(it.t, /实际服务的是/, `实际 ${it.t}`);
    assert.equal(/换了渠道/.test(it.m), false,
      `★ 没确认换过渠道就不许说「换了渠道」——那是编造。实际 ${it.m}`);
    assert.equal(/示例目标家/.test(it.t + it.m), false, "没有渠道名就不许凭空出现一个");
  });

  test("③ 正常路径：一条都不出（与改动前逐字一致）", () => {
    const { modelIdentityItems } = loadIdentity();
    const st = {
      servedProviderName: "示例目标家",
      recent: {
        tier: "claude-opus-5", target: "模型A", served: "模型A", mismatch: false,
        observedAt: new Date().toISOString(),
      },
      modelFallback: [],
    };
    assert.equal(JSON.stringify(modelIdentityItems(st, "示例入口家")), "[]",
      `★ 正常路径不许产生任何条目。实际 ${JSON.stringify(modelIdentityItems(st, "示例入口家"))}`);
  });

  test("④ 映射区那一行也要说得出「由哪家提供」", () => {
    const { servedNote } = loadIdentity();
    const R = { tier: "claude-opus-5", target: "模型A", served: "模型B", mismatch: true };
    const note = servedNote(R, "示例目标家");
    assert.ok(note.includes("模型B"), `★ 必须显示实际服务的模型。实际 ${note}`);
    assert.ok(note.includes("模型A"), `★ tooltip 里必须同时给出打算路由到哪个。实际 ${note}`);
    assert.ok(note.includes("示例目标家"), `★ 必须说清是哪家在服务。实际 ${note}`);

    /* 不给渠道名时退回原措辞（老格式不许崩、不许凭空出现一个渠道名）。 */
    const bare = servedNote(R);
    assert.ok(bare.includes("模型B"), `实际 ${bare}`);
    assert.equal(/示例目标家/.test(bare), false, "没给渠道名就不许凭空出现一个");

    /* 正常路径一个字都不加（与服务端 mismatch=false 的口径一致）。 */
    assert.equal(servedNote({ tier: "claude-opus-5", target: "模型A", served: "模型A", mismatch: false }, "示例目标家"), "");
    assert.equal(servedNote(null, "示例目标家"), "");
  });

  test("⑤ servedNote 不许再退回死代码：映射区必须真的调它", () => {
    /* v17 单页改版后 servedNote 曾**一个调用点都没有**（定义了没人用）——
       于是「实际服务 X」在面板上根本不会显示，而 model-truth-test 里那条
       「矩阵格渲染逐字一致」的断言是**现算**的，测不到它 ⇒ 绿灯掩盖了死代码。
       这条判据防它再退化。 */
    const calls = (PANEL_SRC.match(/servedNote\(/g) || []).length;
    assert.ok(calls >= 2,
      `★ panel-common.js 里 servedNote 只出现 ${calls} 次 —— 定义之外没有调用点，`
      + "它就是死代码，「实际服务 X」永远不会出现在映射区");
  });
});

/* ====================================================================== *
 * 额度屏：转移后那一格不能把**别家**的模型画在自己名下
 * ====================================================================== *
 *
 * `cards/quota-panel.js` 的 `modelQuotaRows` 用 `recent.served` 当
 * 「正在消耗额度的那个模型」（`const live = served || target;`）——
 * 改完服务端之后这层**变准了**（它指的就是真正在消耗额度的那个模型）。
 *
 * 但**归属**要跟着对：转移成功后，入口渠道那一格里的 served 是**别家**的模型 ——
 * 那笔额度扣在**别家**头上，倍率也得查**别家**的目录（查这一家的必然查不到，
 * 只会显示成「倍率未知」—— 那不是「未知」，是**问错了人**）。
 *
 * ⇒ 这一格不画「当前」行，改说清「这次实际由「X」服务，额度记在它那边」。
 */
describe("额度屏：转移后那一格不冒充「当前」", () => {
  /** 把 quota-panel.js 整张卡在 vm 里求值（只调纯函数，不 mount、不碰 DOM）。 */
  function loadQuotaCard(src) {
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(src === undefined ? QUOTA_SRC : src, ctx, { filename: "quota-panel.js" });
    const mod = ctx.window.BAI_CARDS && ctx.window.BAI_CARDS["quota-panel"];
    assert.ok(mod, "卡片必须导出 window.BAI_CARDS[\"quota-panel\"]");
    return mod;
  }

  const TIER_ZH = { "claude-opus-5": "Opus" };
  const CFG = { mapping: { "claude-opus-5": { target: "模型A", label: "档·Opus" } } };
  const CATALOG = { loading: false, err: "", data: { all: [{ key: "模型A", name: "模型A", credits: "x0.29" }] } };

  const rowsOf = (card, recent, extra) => card.modelQuotaRows(Object.assign({
    key: "alpha", name: "假渠道一", tierZh: TIER_ZH,
    slice: { recent, pool: { accounts: [{ available: true }] } },
    cfg: CFG, catalog: CATALOG,
  }, extra || {}));

  test("① 实际由别家服务：这一格不画「当前」，说清额度记在谁那边", () => {
    const card = loadQuotaCard();
    const g = rowsOf(card, {
      tier: "claude-opus-5", label: "档·Opus",
      target: "模型A", served: "模型B", mismatch: true,
      servedProvider: "beta", handoff: true,
    }, { servedProviderName: "假渠道二" });

    assert.equal(g.hasCurrent, false,
      `★ 这一家没在服务任何东西，不许标「当前」。实际 ${JSON.stringify(g)}`);
    assert.equal(g.rows.length, 1, `实际 ${JSON.stringify(g.rows)}`);
    assert.equal(g.rows[0].kind, "configured",
      `★ 画出来的那一行必须是「配置」口径，不是「当前」。实际 ${JSON.stringify(g.rows[0])}`);
    assert.ok(g.summary.includes("假渠道二"),
      `★ 必须说清这次实际由谁在服务。实际 ${g.summary}`);
    assert.ok(g.summary.includes("额度"),
      `★ 必须说清额度记在谁那边。实际 ${g.summary}`);
    /* ⚠ 绝不许把别家的模型名当成这一家的「当前」画出来。 */
    assert.equal(g.rows.some((r) => r.model === "模型B"), false,
      `★ 别家的模型不许出现在这一家的行里。实际 ${JSON.stringify(g.rows)}`);
  });

  test("② 服务的是自己 / 没有 servedProvider：与改动前逐字一致", () => {
    const card = loadQuotaCard();
    /* ②a servedProvider 就是自己（目标渠道那格：它自己的观察被记过）。 */
    const self = rowsOf(card, {
      tier: "claude-opus-5", target: "模型A", served: "模型A", mismatch: false,
      servedProvider: "alpha",
    }, { servedProviderName: "假渠道一" });
    assert.equal(self.hasCurrent, true, `实际 ${JSON.stringify(self)}`);
    assert.equal(self.rows[0].kind, "current", `实际 ${JSON.stringify(self.rows[0])}`);
    assert.equal(self.rows[0].model, "模型A", `实际 ${JSON.stringify(self.rows[0])}`);
    assert.equal(self.rows[0].credits, "x0.29", `倍率要照常查出来。实际 ${JSON.stringify(self.rows[0])}`);
    assert.equal(self.summary, "", `有当前档位时不需要那句提示。实际 ${self.summary}`);

    /* ②b 根本没有 servedProvider（老服务端 / 没发生过转移）⇒ 行为一字不变。 */
    const plain = rowsOf(card, {
      tier: "claude-opus-5", target: "模型A", served: "模型A", mismatch: false,
    });
    assert.equal(JSON.stringify(plain), JSON.stringify(self),
      `★ 没有 servedProvider 时必须与「服务的是自己」逐字一致。\nplain=${JSON.stringify(plain)}\nself =${JSON.stringify(self)}`);
  });

  test("③ 反向对照：把归属判断改坏 ⇒ ① 必须判为不一致", () => {
    const anchor = "const servedElsewhere = !!(sp && myKey && sp !== myKey);";
    assert.ok(QUOTA_SRC.includes(anchor), "★ 锚点不在源码里，改坏这一步没生效");
    const broken = loadQuotaCard(QUOTA_SRC.replace(anchor, "const servedElsewhere = false;"));
    const g = rowsOf(broken, {
      tier: "claude-opus-5", target: "模型A", served: "模型B", mismatch: true,
      servedProvider: "beta", handoff: true,
    }, { servedProviderName: "假渠道二" });
    assert.equal(g.hasCurrent, true,
      "★ 改坏之后这一格又把别家的模型当成「当前」了 —— 说明 ① 那条断言有分辨力");
    assert.equal(g.rows[0].kind, "current",
      "★ 改坏之后又画成了「当前」行 —— 说明 ① 那条断言有分辨力");
    assert.equal(g.rows[0].model, "模型B",
      "★ 改坏之后别家的模型被画在这一家名下 —— 说明 ① 那条断言有分辨力");
  });
});
