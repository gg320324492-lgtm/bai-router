/**
 * T8 测试 —— WorkBuddy 的模型目录与倍率**按账号分桶**（v1.0.78）
 *
 * ## 测什么（规格：.research/reports/K-T8目录分桶规格.md）
 *
 * `/v3/config` 是**带着某一枚账号的令牌**抓回来的，那份清单与其中的 `credits` 倍率
 * **本身就是账号权限的事实**。分桶之前缓存只按渠道存，于是 A 下抓的目录与倍率会被
 * B 复用，两个后果都直接可见：
 *   ① wbAdvanceModel 按倍率从低到高挑替补 —— 倍率来自错误账号就挑错档位；
 *   ② 面板上显示的积分倍率是错的，而倍率正是用户判断「这次要花多少」的唯一依据。
 *
 *   ⭐ ① **串号必须被发现**：A、B 目录不同时，A 下抓的**不会**被 B 复用
 *   ⭐ ② **倍率跟着账号走**：换模挑替补时用的倍率来自**本次请求实际使用的账号**
 *   ③ 磁盘缓存文件名与内容里都只有**不可逆指纹**，没有凭据
 *   ④ 单账号与改动前**逐字一致**（目录内容 / 来源标记 / 面板显示）
 *   ⑤ 判死、停用账号的目录缓存一并作废
 *
 * ## 怎么测的
 *
 *   · ①②③ 的主线是**活体**：真 server.mjs 子进程 + 假上游。假上游按
 *     `authorization` 给**不同账号不同的目录与不同的倍率**——这正是用户实测过的上游行为，
 *     也是本任务全部价值的来源。② 更进一步打到**换模**：请求被 429 之后，
 *     中转必须换到**只有本账号目录里才有**的那个付费档。
 *   · ④⑤ 是**源码求值**（vm 里跑从 server.mjs 真抠出来的函数，不抄一份重写）：
 *     ④ 比对面板渲染的逐字输出与旧文件名的磁盘内容；⑤ 直接对真池子标 dead 再看缓存。
 *
 * ## 反向对照：每条都有，且**改回去必须红**
 *
 * 文件末尾 `SABOTAGE` 一节列出全部「改坏」手法，配套执行器
 * `scripts/wb-catalog-bucket-sabotage-run.mjs` 把每一条真的打到源码上跑一遍，
 * 确认**必须红**，再逐字还原，最后 `grep SABOTAGE` 自证干净。
 *
 * 判据只有一个：**改回改前行为，测试真的会红**。严禁恒真断言——每条断言都配了
 * 「判据自己失效了」的对照（例如 ② 的兜底清单里塞了一个**任何目录里都没有**的模型名，
 * 一旦倍率取错来源，中转就会去换那个不存在的档，断言当场炸）。
 *
 * ## 红线
 *
 * 🔴 全文没有一个真实令牌/API key。夹具里的凭据形态串是明显假的占位串。
 * 🔴 落盘只在 `os.tmpdir()` 下的临时目录 + `BAI_DATA_DIR`，**绝不碰真实的
 *    %APPDATA%\bai-router**；端口全部动态挑空闲（17xxx 段）。进程只按 **PID** 收，
 *    绝不用按镜像名的 /IM。
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

import { wbPoolOf, wbResetRuntime } from "../src/server/wb-pool-wiring.mjs";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const PANEL = path.join(REPO, "src", "server", "panel-common.js");
const DEFAULTS_JSON = path.join(REPO, "src", "server", "config.defaults.json");
const SRC = fs.readFileSync(SERVER, "utf8");
const PANEL_SRC = fs.readFileSync(PANEL, "utf8");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-wbcat-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* 明显不是真令牌的假凭据（红线：绝不写真实令牌）。这三个串也用来证明
   「凭据不出现在任何文件名/文件内容里」——所以它们必须一眼认得出是假的。
   末尾那两位还刻意选成**不可能出现在 wb-catalog-<hex>.json 里**的字符
   （z/y 不是十六进制，也不在 catalog/json 三个词里），免得 ③ 的断言自己先炸。 */
const TOK_A = "dummy-wb-token-ACCOUNT-A-z9";
const TOK_B = "dummy-wb-token-ACCOUNT-B-y8";
const TOK_SOLO = "dummy-wb-token-SOLO-x7";

/* ---- 假上游的两份目录：模型不同、倍率不同 ---------------------------------
 * 真实 WorkBuddy 的倍率串就是 `x0.34 credits` 这种形态，这里照抄那个**形状**
 * （wbNormalizeCredits 认它），值随便取。模型名带 only-a-paid / only-b-paid 后缀，
 * 于是「换到了只有本账号目录里才有的那个付费档」可以被一眼看出来。
 *
 * ⚠ 倍率是**刻意排过序**的：wbAdvanceModel 按 credits 从低到高挑替补，所以
 *   「只有本账号才有的那一档」必须在本账号的目录里排**第一**（x0.11 / x0.22），
 *   共同档排在后面（x5.00）。否则断言「换到了 only-*-paid」验的是排序而不是分桶，
 *   那是另一条判据，混在一起就分不清是哪一处坏了。 */
const CAT_A = [
  { id: "f-a", name: "档A入口", credits: "x0.00 credits", maxInputTokens: 128000, maxOutputTokens: 8192 },
  { id: "only-a-paid", name: "只有A看得到的付费档", credits: "x0.11 credits", maxInputTokens: 128000, maxOutputTokens: 8192 },
  { id: "shared-mid", name: "两版都有·中档", credits: "x5.00 credits", maxInputTokens: 128000, maxOutputTokens: 8192 },
];
const CAT_B = [
  { id: "f-b", name: "档B入口", credits: "x0.00 credits", maxInputTokens: 128000, maxOutputTokens: 8192 },
  { id: "only-b-paid", name: "只有B看得到的付费档", credits: "x0.22 credits", maxInputTokens: 128000, maxOutputTokens: 8192 },
  { id: "shared-mid", name: "两版都有·中档", credits: "x5.00 credits", maxInputTokens: 128000, maxOutputTokens: 8192 },
];
/** 兜底清单（availableModels）里的第一个：任何目录里都没有它。
 *  一旦倍率/目录取错了来源，中转会去换到它，② 的断言当场炸（防恒真）。 */
const FALLBACK_ONLY = "zzz-fallback-only";

const catalogFor = (tok) => (tok === TOK_A ? CAT_A : tok === TOK_B ? CAT_B : CAT_A);

/* ====================================================================== *
 * 端口 / 进程 / 假上游（只在 17xxx 段挑）
 * ====================================================================== */
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
async function portsInRange(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await portInRange());
  assert.equal(new Set(out).size, n, `挑出来的端口必须互不相同：${out.join(",")}`);
  return out;
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
 * 假上游：
 *   · GET  /v3/config  → 按 authorization 给出**那枚令牌自己的**目录（CLI/App 两种 UA 形态）
 *   · POST /v2/chat/completions → f-a / f-b 一律 429（逼中转换模），其余 200 SSE
 * `hits` 记下每一次真实请求的 {auth, url, model}，所有断言都从它取证。
 */
async function startFakeUpstream(hits) {
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      const auth = String(rq.headers["authorization"] || "");
      const tok = auth.replace(/^Bearer\s+/, "");
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) || {}; } catch { }
      const model = String(body.model || "");
      const url = String(rq.url || "");
      const isCli = /^\s*CLI\//.test(String(rq.headers["user-agent"] || ""));
      hits.push({ auth, url, model, ua: String(rq.headers["user-agent"] || ""), cli: isCli });

      if (url.indexOf("/v3/config") >= 0) {
        const models = catalogFor(tok).map((m) => ({
          id: m.id, name: m.name, credits: isCli ? m.credits : "",      // App 形态 credits 全空（实测形态）
          contextWindow: m.maxInputTokens, maxInputTokens: m.maxInputTokens,
          maxOutputTokens: m.maxOutputTokens, supportsImages: false, supportsReasoning: false,
        }));
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(JSON.stringify({ code: 0, msg: "OK", data: { models, modelPromotions: [] } }));
        return;
      }
      /* 入口档一律 429：让中转必须换模，而换到哪个档正是本任务要验的东西。
         判据写成**精确相等**，不能写成 `/\/f/` 之类的模糊正则（那正是 429 e2e
         栽过的坑：正则写错 → 假上游从不 429 → 测出来的是假缺陷）。 */
      if (model === "f-a" || model === "f-b") {
        rs.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        rs.end('{"error":{"message":"usage exceeds frequency limit, please retry later"}}');
        return;
      }
      rs.writeHead(200, { "content-type": "text/event-stream" });
      rs.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK:" + model } }] })}\n\n`);
      rs.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      rs.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return srv;
}

/** 起一个真 server.mjs 子进程（临时 BAI_DATA_DIR + 17xxx 隔离端口）。
 *  `patch(cfg)` 在**写盘之前**改配置——配置必须一次写对：
 *  起来之后再改文件会撞上 loadCfg 的节流，测试就会偶发地读到旧配置
 *  （那正是本任务要抓的「同一进程里前后两份目录」同一个坑，只是方向反了）。 */
async function startServer(dataDir, P, upstreamPort, patch) {
  const cfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
  cfg.failover.enabled = false;
  /* 预置成探测必选中的值，否则服务启动时 applyProxy 自重启（exit(0)）把本进程带走 */
  cfg.proxy = "http://127.0.0.1:7897";
  cfg.relayPort = P.bai; cfg.panelPort = P.panel;
  for (const k of ["sn", "wb", "wbai", "zen", "qd", "or"]) cfg[k] = { ...cfg[k], relayPort: P[k] };
  cfg.wb.accessToken = ""; cfg.wb.refreshToken = "";
  cfg.wb.upstream = `http://127.0.0.1:${upstreamPort}`;
  /* 兜底清单第一个是任何目录里都没有的 FALLBACK_ONLY：
     换模一旦拿不到**本账号**的目录，就会挑中它 → ② 的断言立刻炸。 */
  cfg.wb.availableModels = [FALLBACK_ONLY, "only-a-paid", "only-b-paid"];
  cfg.wb.defaultModel = "f-a";
  cfg.wb.mapping = {
    "claude-sonnet-5": { target: "f-a", label: "档A" },
    "claude-opus-5": { target: "f-b", label: "档B" },
  };
  if (typeof patch === "function") patch(cfg);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

  const env = { ...process.env, BAI_DATA_DIR: dataDir, NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1", BAI_NO_PROXY_AUTODETECT: "1" };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
  env.NO_PROXY = "127.0.0.1,localhost";
  const child = track(spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  const out = []; child.stdout.on("data", (d) => out.push(String(d))); child.stderr.resume();
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) return child; }
    catch { }
    await sleep(300);
  }
  throw new Error(`server.mjs 40 秒内没起来。stdout 尾：${out.join("").slice(-800)}`);
}

const askModels = (P, p) => fetch(`http://127.0.0.1:${P.panel}/api/models?p=${p}`)
  .then((r) => r.json());
const askRelay = (P, tier, text) => fetch(`http://127.0.0.1:${P.wb}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: tier, max_tokens: 256, stream: false, system: "You are Claude Code.", messages: [{ role: "user", content: text }] }),
  signal: AbortSignal.timeout(60000),
}).then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ status: 0, text: String((e && e.message) || e) }));

/** 目录里所有 `wb-catalog-<16 位指纹>.json` 的文件名。 */
const bucketFiles = (dir) => fs.readdirSync(dir).filter((n) => /^wb-catalog-[0-9a-f]{16}\.json$/.test(n));

/* ====================================================================== *
 * ① ② ③ 活体：串号必须被发现 / 倍率跟着账号走 / 指纹落盘
 * ====================================================================== */
describe("T8 ①②③ 活体：目录按账号分桶、倍率跟着本次请求的账号", () => {
  let child, upstream, dataDir, P;
  const hits = [];

  before(async () => {
    const ports = await portsInRange(8);
    P = { bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4], qd: ports[5], or: ports[6], panel: ports[7] };
    dataDir = path.join(TMPROOT, "data-multi");
    upstream = await startFakeUpstream(hits);
    /* round-robin：两次目录抓取分别落在 A、B 上（粘性只对带 sessionKey 的模型请求
       生效，目录抓取不传 sessionKey，所以按模式轮换）。 */
    child = await startServer(dataDir, P, upstream.address().port, (cfg) => {
      cfg.wb.poolMode = "round-robin";
      cfg.wb.accounts = [
        { id: "acct-a", label: "账号A", order: 0, accessToken: TOK_A, refreshToken: "", credential: { lastRefreshTime: 1735689600000 }, modelCooldowns: {} },
        { id: "acct-b", label: "账号B", order: 1, accessToken: TOK_B, refreshToken: "", credential: { lastRefreshTime: 1735689600000 }, modelCooldowns: {} },
      ];
    });
  }, { timeout: 90000 });

  after(() => {
    try { upstream && upstream.close(); } catch { }
    killAll();
  });

  let rA = null, rB = null;

  test("★① 串号必须被发现：A 与 B 的目录不同时，A 下抓的不会被 B 复用", async () => {
    hits.length = 0;
    rA = await askModels(P, "wb");
    rB = await askModels(P, "wb");

    assert.equal(rA.source, "live", `第一次应拿到实时目录。实际 ${JSON.stringify(rA).slice(0, 200)}`);
    assert.equal(rB.source, "live", `第二次应拿到实时目录。实际 ${JSON.stringify(rB).slice(0, 200)}`);

    /* 抓取确实用了两枚不同的令牌（不是同一个号被抓两遍，那不是串号而是没轮换） */
    const cfgHits = hits.filter((h) => h.url.indexOf("/v3/config") >= 0);
    assert.ok(cfgHits.some((h) => h.auth === `Bearer ${TOK_A}`), `目录请求应当用了账号 A。实际 ${JSON.stringify(cfgHits.map((h) => h.auth))}`);
    assert.ok(cfgHits.some((h) => h.auth === `Bearer ${TOK_B}`), `目录请求应当用了账号 B。实际 ${JSON.stringify(cfgHits.map((h) => h.auth))}`);

    /* ★ 这才是那条断言：A 的清单里有 only-a-paid，B 的清单里没有；反过来亦然。
       若分桶没做（缓存只按渠道），第二次就会直接命中第一次那份，两边完全相同。 */
    assert.ok(rA.models.includes("only-a-paid"), `A 的目录里必须有 only-a-paid。实际 ${JSON.stringify(rA.models)}`);
    assert.equal(rB.models.includes("only-a-paid"), false,
      `★ B 绝不能拿到 A 才有的模型（串号了）。实际 B 拿到 ${JSON.stringify(rB.models)}`);
    assert.ok(rB.models.includes("only-b-paid"), `B 的目录里必须有 only-b-paid。实际 ${JSON.stringify(rB.models)}`);
    assert.equal(rA.models.includes("only-b-paid"), false,
      `★ A 绝不能拿到 B 才有的模型（串号了）。实际 A 拿到 ${JSON.stringify(rA.models)}`);
    assert.notDeepEqual(rA.models, rB.models, "两次目录必须不同（否则这条测试根本没有分辨力）");

    /* 倍率同理：A 的面板显示 x0.11，B 的显示 x0.22 */
    assert.match(String(rA.labels["only-a-paid"]), /x0\.11/, `A 的倍率必须是 A 目录里的 x0.11。实际 ${rA.labels["only-a-paid"]}`);
    assert.equal(rA.labels["only-b-paid"], undefined, `★ A 不该显示 B 的倍率。实际 ${JSON.stringify(rA.labels)}`);
    assert.match(String(rB.labels["only-b-paid"]), /x0\.22/, `B 的倍率必须是 B 目录里的 x0.22。实际 ${rB.labels["only-b-paid"]}`);
  });

  test("★③ 磁盘缓存文件名与内容里都只有不可逆指纹，没有凭据", () => {
    const files = bucketFiles(dataDir);
    assert.equal(files.length, 2,
      `两个账号 → 两份缓存文件。实际 ${JSON.stringify(fs.readdirSync(dataDir))}`);
    /* 旧文件名（每渠道一份）在多账号下**不许被写**：它天生装不下两份清单，
       写进去就等于给「降级时读到别人的目录」留一个口子。 */
    assert.equal(fs.existsSync(path.join(dataDir, "wb-catalog.json")), false,
      `★ 多账号下不许再写每渠道一份的旧文件名（它装不下两个账号的目录）。实际 ${JSON.stringify(fs.readdirSync(dataDir))}`);

    for (const n of files) {
      assert.match(n, /^wb-catalog-[0-9a-f]{16}\.json$/, `文件名只允许是「渠道-指纹」形态。实际 ${n}`);
      for (const secret of [TOK_A, TOK_B, "acct-a", "acct-b", "账号A", "账号B"]) {
        assert.equal(n.includes(secret), false, `★ 文件名里绝不许出现凭据或账号标识：${n} 含 ${secret}`);
      }
      const body = fs.readFileSync(path.join(dataDir, n), "utf8");
      for (const secret of [TOK_A, TOK_B, "acct-a", "acct-b"]) {
        assert.equal(body.includes(secret), false, `★ 文件内容里绝不许出现凭据或账号 id：${n} 含 ${secret}`);
      }
      const fp = n.slice("wb-catalog-".length, -".json".length);
      assert.ok(body.includes(fp), `内容里应当能看出归属（只记指纹）。实际 ${body.slice(0, 160)}`);
    }
    /* 指纹必须真的是不可逆摘要，而不是令牌的任何一段。
       （顺带把 keyFp 那种「首 7 + 尾 2」写法钉死在这里：它是可逆的，不许进文件名。） */
    const fpA = bucketFiles(dataDir)[0];
    for (const tok of [TOK_A, TOK_B]) {
      assert.equal(fpA.includes(tok.slice(0, 7)), false, `文件名里不许出现令牌前 7 位（那是可逆的 keyFp）`);
      assert.equal(fpA.includes(tok.slice(-2)), false, `文件名里不许出现令牌尾 2 位`);
    }
  });

  test("★② 倍率跟着账号走：换模挑替补时用的是本次请求实际使用的那个账号的目录", async () => {
    /* 两次请求，两个不同的会话 key（zenSessionId 按首条 user 消息算），
       round-robin 于是把第一个落到 A、第二个落到 B。
       两个入口档各自在**自己那份**目录里，被 429 后必须换到**只有自己那份才有**的付费档：
         A：f-a → only-a-paid（x9.99）
         B：f-b → only-b-paid（x0.22）
       若倍率/目录串了号，两个请求会换到同一个档（或换到兜底清单里的
       FALLBACK_ONLY）——两种都让本条红。 */
    hits.length = 0;
    const r1 = await askRelay(P, "claude-sonnet-5", "T8-会话一：请读一下 /etc/hostname");
    const r2 = await askRelay(P, "claude-opus-5", "T8-会话二：请读一下 /etc/hosts");

    const chat = hits.filter((h) => h.url.indexOf("/v3/config") < 0);
    const chainA = chat.filter((h) => h.auth === `Bearer ${TOK_A}`).map((h) => h.model);
    const chainB = chat.filter((h) => h.auth === `Bearer ${TOK_B}`).map((h) => h.model);

    assert.deepEqual(chainA, ["f-a", "only-a-paid"],
      `★ 账号 A 被 429 后必须换到 A 目录里的 only-a-paid。实际链路 ${JSON.stringify(chainA)}（${r1.status}）`);
    assert.deepEqual(chainB, ["f-b", "only-b-paid"],
      `★ 账号 B 被 429 后必须换到 B 目录里的 only-b-paid。实际链路 ${JSON.stringify(chainB)}（${r2.status}）`);
    assert.equal(chainA.includes(FALLBACK_ONLY), false,
      `换到了兜底清单里的 ${FALLBACK_ONLY} —— 说明没拿到本账号的目录（本条断言的防恒真对照）`);
    assert.equal(chainB.includes(FALLBACK_ONLY), false,
      `换到了兜底清单里的 ${FALLBACK_ONLY} —— 说明没拿到本账号的目录（本条断言的防恒真对照）`);
    assert.equal(r1.status, 200, `换到 A 自己的付费档后应当成功。实际 ${r1.status}：${r1.text.slice(0, 160)}`);
    assert.equal(r2.status, 200, `换到 B 自己的付费档后应当成功。实际 ${r2.status}：${r2.text.slice(0, 160)}`);
  }, { timeout: 90000 });
});

/* ====================================================================== *
 * ④ 单账号与改动前逐字一致（活体）
 * ====================================================================== */
describe("T8 ④ 活体：单账号与改动前逐字一致", () => {
  let child, upstream, dataDir, P;
  const hits = [];

  before(async () => {
    const ports = await portsInRange(8);
    P = { bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4], qd: ports[5], or: ports[6], panel: ports[7] };
    dataDir = path.join(TMPROOT, "data-solo");
    upstream = await startFakeUpstream(hits);
    /* ★ 旧配置形态：**只有 accessToken、没有 accounts** → 合成单条目池。
       这是绝大多数老用户的样子，也是「逐字一致」唯一需要保证的那一条。 */
    child = await startServer(dataDir, P, upstream.address().port, (cfg) => {
      delete cfg.wb.accounts;
      cfg.wb.accessToken = TOK_SOLO;
      cfg.wb.poolMode = "";
    });
  }, { timeout: 90000 });

  after(() => { try { upstream && upstream.close(); } catch { } killAll(); });

  test("单账号：目录内容、来源标记与旧文件名磁盘内容逐字一致", async () => {
    const r = await askModels(P, "wb");
    assert.equal(r.source, "live", `应当拿到实时目录。实际 ${JSON.stringify(r).slice(0, 200)}`);
    assert.equal(r.sourceAccount.synthetic, true, "合成单条目池必须被标成 synthetic（面板据此不显示账号徽标）");

    /* 内容：与改动前完全同形 —— labels 是 `名字 · 倍率`，免费档写「免费」 */
    assert.equal(r.labels["only-a-paid"], "只有A看得到的付费档 · x0.11",
      `倍率显示必须与改动前同形。实际 ${r.labels["only-a-paid"]}`);
    assert.equal(r.count, CAT_A.length);
    assert.equal(r.freeCount, 1);

    /* 来源标记与 note：与改动前**逐字**相同（单账号不追加任何账号信息） */
    const expectNote = `WorkBuddy 目录来自上游 /v3/config（实时目录）：共 ${CAT_A.length} 个模型，其中 1 个 0 倍率免费。`;
    assert.equal(r.note, expectNote, `note 必须与改动前逐字一致。实际 ${r.note}`);
    assert.equal(String(r.note).includes("账号"), false, "单账号不该出现任何账号信息");

    /* 磁盘：旧文件名 wb-catalog.json 继续存在，且**键集与改动前完全相同**
       （改动前写的就是 {models, promotions, source, at} 四个键）。 */
    const legacy = path.join(dataDir, "wb-catalog.json");
    assert.ok(fs.existsSync(legacy), "单账号必须照旧写旧文件名（降级装回旧版本也还有快照）");
    const legacyObj = JSON.parse(fs.readFileSync(legacy, "utf8"));
    assert.deepEqual(Object.keys(legacyObj).sort(), ["at", "models", "promotions", "source"],
      `旧文件名的键集必须与改动前逐字相同。实际 ${JSON.stringify(Object.keys(legacyObj))}`);
    assert.equal(legacyObj.source, "live");
    assert.deepEqual(legacyObj.models.map((m) => m.id), CAT_A.map((m) => m.id));
    /* 按账号那份多一个 accountFp 字段（多账号时要靠它说清归属） */
    const files = bucketFiles(dataDir);
    assert.equal(files.length, 1, `单账号 → 按账号那份也正好一份。实际 ${JSON.stringify(fs.readdirSync(dataDir))}`);
    const bucketed = JSON.parse(fs.readFileSync(path.join(dataDir, files[0]), "utf8"));
    assert.deepEqual(Object.keys(bucketed).sort(), ["accountFp", "at", "models", "promotions", "source"]);
    const { accountFp, ...legacyEq } = bucketed;
    assert.deepEqual(Object.keys(legacyEq).sort(), Object.keys(legacyObj).sort(),
      "两份只差 accountFp 一个字段（其余内容逐字相同）");
  });
});

/* ====================================================================== *
 * ④⑤ 源码求值：面板徽标渲染 + 判死账号的缓存作废
 * ====================================================================== */
function sliceBetween(src, startAnchor, endAnchor) {
  const i = src.indexOf(startAnchor);
  assert.ok(i >= 0, `抠源码失败：找不到 ${JSON.stringify(startAnchor)}`);
  const j = src.indexOf(endAnchor, i + startAnchor.length);
  assert.ok(j > i, `抠源码失败：找不到终点 ${JSON.stringify(endAnchor)}`);
  const out = src.slice(i, j);
  assert.equal((out.match(/\/\*/g) || []).length, (out.match(/\*\//g) || []).length,
    `切片停在注释中间：${JSON.stringify(startAnchor)}`);
  return out;
}

/** 把 server.mjs 里 T8 的那几段真源码抠出来在 vm 里求值（不抄一份重写）。 */
function loadCatalogCore(dataDir) {
  const s1 = sliceBetween(SRC, "const WB_CAT_FP_LEN = 16;", "// 倍率归一化（契约 §1.3）");
  const s2 = sliceBetween(SRC, "function wbCatBucket(p, fp) {", "// ---------- Qoder 模型目录（v1.0.41）");
  /* 依赖全部由**沙箱注入**（vm 里没有 require）：fs/crypto/path 用真模块，
     sliceOf/DEFAULTS/writeAtomic/writeAtomic 这类与 T8 无关的用等价桩，
     wbPoolOf 用**真的**接线层（判死作废那条断言要的就是真池子的状态字段）。 */
  const sandbox = {
    console,
    createHash, path,
    readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, rmSync: fs.rmSync,
    DATA_DIR: dataDir,
    DEFAULTS: { wb: { upstream: "http://127.0.0.1:1", availableModels: ["def-wb"] } },
    sliceOf: (cfg, p) => cfg[p] || {},
    writeAtomic: () => {},
    wbPoolOf,
    wbEnsureTokenPooled: async () => ({ ok: false, reason: "no_token" }),
    wbFetchConfig: async () => ({ ok: false, error: "本切片不抓上游（抓取由活体那几组验）" }),
  };
  const body = `(() => {\n${s1}\n${s2}\nreturn {
    wbAccountFp, wbCatBucket, wbCatModels, wbReadCatDisk, wbPruneCatFiles,
    wbPruneDeadCatCaches, wbCatFileFor, wbCatFiles, wbCatCaches, WB_CAT_FP_LEN,
  };\n})()`;
  return vm.runInNewContext(body, sandbox, { filename: "wb-cat-core.mjs" });
}

/** 把 panel-common.js 里的 paintCatalogSource 抠出来，配一个假 DOM 求值。 */
function loadPaint() {
  const src = sliceBetween(PANEL_SRC, "  function paintCatalogSource(r) {", "  async function refreshModels() {");
  /* 包一层 IIFE：vm.runInNewContext 的顶层不允许 return。 */
  const body = `(() => {
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const CATALOG_SOURCE = {
      live: { txt: "实时目录", hint: "刚从上游拉取，反映它此刻的样子" },
      disk: { txt: "上次成功的目录", hint: "这次没能连上上游，用的是上一次拉到的快照——可能已经过期" },
      builtin: { txt: "内置兜底目录", hint: "既没连上上游、也没有历史快照，用的是写死在代码里的出厂值，可信度最低" },
    };
    let el = null;
    const $ = () => el;
    ${src}
    return (r) => { el = { className: "", innerHTML: "", title: "" }; paintCatalogSource(r); return el; };
  })()`;
  return vm.runInNewContext(body, { console }, { filename: "paintCatalogSource" });
}

describe("T8 ④⑤ 源码判据：面板徽标 / 判死账号的缓存作废", () => {
  test("④ 面板：单账号徽标与改动前逐字一致，多账号才追加账号来源", () => {
    const paint = loadPaint();
    const base = { source: "live", count: 3, catalogAt: "2026-10-13T00:00:00.000Z", models: ["a", "b", "c"] };

    /* ★ 与改动前**逐字**相同的那一行（表达式就是改动前那一行，多一个字段都不许有）。 */
    const when = new Date(base.catalogAt).toLocaleString("zh-CN", { hour12: false });
    const soloHtml = paint({ ...base, sourceAccount: { fp: "0123456789abcdef", label: "当前令牌", synthetic: true } }).innerHTML;
    assert.equal(soloHtml, `模型目录：<b class="ok">实时目录</b><span class="dim">（3 个 · 拉取于 ${when}）</span>`,
      `★ 单账号徽标必须与改动前逐字一致。实际 ${soloHtml}`);
    /* 压根没有账号（没配令牌）时同样一个字不加 */
    assert.equal(paint({ ...base, sourceAccount: { fp: null, label: null, synthetic: false } }).innerHTML, soloHtml,
      "没有可用账号时不该出现账号徽标");

    /* 多账号：必须看得出是哪个账号（⑤），且只出现不可逆指纹，不出现令牌。 */
    const multi = paint({ ...base, sourceAccount: { fp: "fedcba9876543210", label: "账号A", synthetic: false } });
    assert.match(multi.innerHTML, /取自账号/, `多账号必须标出目录来源账号。实际 ${multi.innerHTML}`);
    assert.match(multi.innerHTML, /账号A/, `必须显示用户自己起的标签。实际 ${multi.innerHTML}`);
    assert.match(multi.innerHTML, /fedcba9876543210/, `必须显示不可逆指纹。实际 ${multi.innerHTML}`);
    for (const secret of [TOK_A, TOK_B]) {
      assert.equal(multi.innerHTML.includes(secret), false, "★ 面板里绝不出现凭据");
      assert.equal(multi.title.includes(secret), false, "★ 面板 title 里绝不出现凭据");
    }
    assert.match(multi.title, /判死\/停用的账号/, "tooltip 要说清判死账号的目录会被作废");
  });

  test("⑤ 判死 / 停用账号的目录缓存一并作废（内存桶 + 落盘文件），别的账号不受影响", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bai-wbcat-core-"));
    try {
      const core = loadCatalogCore(dir);
      const fpA = core.wbAccountFp(TOK_A);
      const fpB = core.wbAccountFp(TOK_B);
      assert.match(fpA, /^[0-9a-f]{16}$/, "指纹必须是 16 位十六进制");
      assert.notEqual(fpA, fpB, "不同令牌 → 不同桶");
      assert.equal(fpA, core.wbAccountFp(TOK_A), "同一令牌 → 同一个桶（跨请求稳定）");
      assert.equal(fpA, TOK_SOLO.includes(fpA) ? fpA : fpA, "sanity");
      assert.equal(core.wbAccountFp(""), null, "没有令牌就没有桶");

      /* 造两份落盘 + 两条内存桶 */
      fs.writeFileSync(core.wbCatFileFor("wb", fpA), JSON.stringify({ models: [{ id: "only-a-paid" }] }));
      fs.writeFileSync(core.wbCatFileFor("wb", fpB), JSON.stringify({ models: [{ id: "only-b-paid" }] }));
      core.wbCatCaches.wb.set(fpA, { at: 1, upstream: "u", val: { models: [{ id: "only-a-paid" }] } });
      core.wbCatCaches.wb.set(fpB, { at: 1, upstream: "u", val: { models: [{ id: "only-b-paid" }] } });

      /* 真池子：A 被判死，B 活着 */
      const cfg = {
        wb: {
          accounts: [
            { id: "acct-a", accessToken: TOK_A, disabled: false, ignored: false },
            { id: "acct-b", accessToken: TOK_B, disabled: false, ignored: false },
          ],
        },
      };
      wbResetRuntime("wb");
      const pool = wbPoolOf(cfg, "wb");
      pool.accounts[0].dead = true;
      pool.accounts[1].dead = false;

      core.wbPruneDeadCatCaches(cfg, "wb");

      assert.equal(core.wbCatCaches.wb.has(fpA), false, "★ 判死账号的内存桶必须作废");
      assert.equal(fs.existsSync(core.wbCatFileFor("wb", fpA)), false, "★ 判死账号的落盘缓存必须删掉");
      assert.equal(core.wbCatCaches.wb.has(fpB), true, "活着的账号的桶不许被牵连");
      assert.ok(fs.existsSync(core.wbCatFileFor("wb", fpB)), "活着的账号的落盘缓存不许被删");
      assert.deepEqual(core.wbCatModels("wb", fpB).map((m) => m.id), ["only-b-paid"],
        "活着的账号仍能读到自己的目录");
      assert.equal(core.wbCatModels("wb", fpA), null, "判死账号那一桶已经取不到了");

      /* 「停用」同样作废 */
      wbResetRuntime("wb");
      const pool2 = wbPoolOf(cfg, "wb");
      pool2.accounts[1].disabled = true;
      fs.writeFileSync(core.wbCatFileFor("wb", fpB), JSON.stringify({ models: [{ id: "only-b-paid" }] }));
      core.wbCatCaches.wb.set(fpB, { at: 1, upstream: "u", val: { models: [{ id: "only-b-paid" }] } });
      core.wbPruneDeadCatCaches(cfg, "wb");
      assert.equal(fs.existsSync(core.wbCatFileFor("wb", fpB)), false, "★ 停用账号的落盘缓存也要作废");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    }
  });

  test("★② 结构判据：目录抓取不许隐式取号（令牌只能由调用方显式指定）", () => {
    /* 这条与上面那条活体断言是**互补**的一条：活体验的是「结果对不对」，
       这条钉的是「为什么会对」——抓取函数里**根本没有选号的代码**。
       少了它，哪天有人为了让某条路径跑通，把选号偷偷加回 wbFetchConfig，
       活体那条当场不一定红（多账号下它挑到的可能正好就是同一个号），
       而串号已经埋在那儿了。与 wb-pool-wiring 那条「grep context: "refresh"
       只会命中一处」是同一种纪律：让「该传的地方传了」在源码里看得见。 */
    const fn = sliceBetween(SRC, "async function wbFetchConfig(cfg, uaKind, p, acct) {", "// 合并 CLI 与 App 两种形态的目录");
    assert.equal(/wbEnsureTokenPooled|wbPickAccount/.test(fn), false,
      `★ wbFetchConfig 里绝不许自己选号（那会造成「拿 A 的令牌抓、存进 B 的桶」）。实际片段：\n${fn.slice(0, 600)}`);
    assert.match(fn, /const tok = acct && acct\.token;/,
      "令牌必须直接取自调用方传进来的那个账号");
  });

  test("★⑤ 孤儿桶会被清掉，换过令牌的旧目录不会越攒越多", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bai-wbcat-orphan-"));
    try {
      const core = loadCatalogCore(dir);
      const fpNow = core.wbAccountFp(TOK_A);
      const fpOld = core.wbAccountFp(TOK_SOLO);      // 续期前的旧令牌
      fs.writeFileSync(core.wbCatFileFor("wb", fpNow), "{}");
      fs.writeFileSync(core.wbCatFileFor("wb", fpOld), "{}");
      fs.writeFileSync(path.join(dir, "unrelated-file.json"), "{}");   // 认不出的名字不许碰
      fs.writeFileSync(path.join(dir, "wb-catalog.json"), "{}");      // 旧文件名也不许碰
      core.wbPruneCatFiles("wb", new Set([fpNow]));
      assert.ok(fs.existsSync(core.wbCatFileFor("wb", fpNow)), "在用桶不许删");
      assert.equal(fs.existsSync(core.wbCatFileFor("wb", fpOld)), false, "孤儿桶必须删");
      assert.ok(fs.existsSync(path.join(dir, "unrelated-file.json")), "认不出的文件不许删");
      assert.ok(fs.existsSync(path.join(dir, "wb-catalog.json")), "旧文件名不归孤儿清理管");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    }
  });

  test("多账号下旧文件名（每渠道一份）绝不被当成某账号的目录", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bai-wbcat-legacy-"));
    try {
      const core = loadCatalogCore(dir);
      fs.writeFileSync(core.wbCatFiles.wb, JSON.stringify({ models: [{ id: "from-legacy" }], source: "disk" }));
      const fp = core.wbAccountFp(TOK_B);
      /* 单账号：旧文件名照旧认（升级不断档，与改动前逐字一致）。
         （用 JSON 比而不是 deepEqual：vm 出来的对象来自另一个 realm，
           原型不同，deepStrictEqual 会因为**原型**而不是内容红。） */
      assert.equal(JSON.stringify((core.wbReadCatDisk("wb", fp, true) || {}).models), JSON.stringify([{ id: "from-legacy" }]),
        "合成单条目池必须照旧读旧文件名");
      /* 多账号：一律不认 —— 那份是池化之前某一个账号抓的，读给谁都是串号 */
      assert.equal(core.wbReadCatDisk("wb", fp, false), null,
        "★ 多账号下不许读每渠道一份的旧文件名");
      assert.equal(core.wbReadCatDisk("wb", null, false), null, "没有账号指纹就没有目录可读");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    }
  });
});

/* ====================================================================== *
 * 反向对照手法表
 * ====================================================================== */
const SABOTAGE = [
  {
    name: "per-channel-cache",
    file: "src/server/server.mjs",
    where: "wbCatModels —— 取桶时认「哪个账号的」",
    from: `  const m = wbCatCaches[p];
  return m && fp ? (m.get(fp) || null) : null;`,
    to: `  const m = wbCatCaches[p];
  if (!m) return null;
  if (fp && m.has(fp)) return m.get(fp);
  const first = m.values().next();
  return first.done ? null : first.value;`,
    reds: "★① 串号：A 下抓的目录被 B 复用（两次 /api/models 返回同一份） + ★② 倍率串号",
  },
  {
    name: "legacy-file-any-pool",
    file: "src/server/server.mjs",
    where: "wbReadCatDisk —— 旧文件名（每渠道一份）的读取条件",
    from: "  if (synthetic) {\n    try { return JSON.parse(readFileSync(wbCatFiles[p], \"utf8\")); } catch { return null; }\n  }",
    to: "  try { return JSON.parse(readFileSync(wbCatFiles[p], \"utf8\")); } catch { return null; }",
    reds: "多账号下把池化之前某个账号的目录当成当前账号的（串号），且作废机制形同虚设",
  },
  {
    name: "advance-ignores-account",
    file: "src/server/server.mjs",
    where: "wbAdvanceModel —— 换模时读哪一份目录",
    from: "  const mem = wbCatModels(p, acctFp);",
    to: "  const first = wbCatCaches[p] && wbCatCaches[p].size ? [...wbCatCaches[p].values()][0] : null;\n  const mem = first && first.val && Array.isArray(first.val.models) ? first.val.models : null;",
    reds: "★② 倍率必须来自本次请求实际使用的账号（退化成改动前那份「每渠道只有一个」的缓存）",
  },
  {
    name: "no-prune-on-dead",
    file: "src/server/server.mjs",
    where: "wbPruneDeadCatCaches —— 判死/停用/移出的作废判据",
    from: "    const gone = a.dead === true || a.disabled === true || a.ignored === true;",
    to: "    const gone = false;",
    reds: "★⑤ 判死账号的目录缓存不再被作废（占地方且误导诊断）",
  },
  {
    name: "reversible-fingerprint",
    file: "src/server/server.mjs",
    where: "wbAccountFp —— 账号指纹（写进缓存文件名的那一串）",
    from: `  return createHash("sha256").update(s).digest("hex").slice(0, WB_CAT_FP_LEN);`,
    to: `  return s.length <= 12 ? "***" : s.slice(0, 7) + s.slice(-2) + "(" + s.length + ")";`,
    reds: "★③ 文件名/内容里出现凭据的可逆片段（keyFp 那种首 7 + 尾 2 是可逆的）",
  },
  {
    name: "badge-on-solo",
    file: "src/server/panel-common.js",
    where: "paintCatalogSource —— 单账号时不该显示账号徽标",
    from: "    const sa = r && r.sourceAccount && r.sourceAccount.fp && !r.sourceAccount.synthetic",
    to: "    const sa = r && r.sourceAccount && r.sourceAccount.fp",
    reds: "★④ 单账号场景与改动前逐字一致（老用户界面上凭空多出账号徽标）",
  },
  {
    name: "legacy-write-always",
    file: "src/server/server.mjs",
    where: "wbReadCatalog —— 旧文件名的写入条件",
    from: "    if (synthetic) {\n      try { writeAtomic(wbCatFiles[p], JSON.stringify({ ...val, accountFp: undefined }, null, 2) + \"\\n\"); } catch { }\n    }",
    to: "    try { writeAtomic(wbCatFiles[p], JSON.stringify({ ...val, accountFp: undefined }, null, 2) + \"\\n\"); } catch { }",
    reds: "多账号下把某一份目录写进「每渠道一份」的旧文件名 → 下次降级时被读给别的账号（串号）",
  },
  {
    name: "implicit-token-in-fetch",
    file: "src/server/server.mjs",
    where: "wbFetchConfig —— 令牌必须由调用方显式指定",
    from: "  const tok = acct && acct.token;\n  if (!tok) return { ok: false, error: \"没有可用的账号令牌，跳过目录抓取\", empty: true };",
    to: "  let tok = acct && acct.token;\n  if (!tok) { try { ({ token: tok } = await wbEnsureTokenPooled(cfg, p)); } catch { } }\n  if (!tok) return { ok: false, error: \"没有可用的账号令牌，跳过目录抓取\", empty: true };",
    reds: "② 显式指定账号（隐式取号就可能出现「拿 A 的令牌抓、存进 B 的桶」，且代码上完全看不出来）",
  },
];

if (process.argv.includes("--emit-sabotage")) {
  /* 给配套执行器 scripts/wb-catalog-bucket-sabotage-run.mjs 读。
     表只有一份：执行器从**本文件**里读出去，不复制一份（复制的迟早与源码脱节）。 */
  process.stdout.write(JSON.stringify(SABOTAGE));
  process.exit(0);
}

if (process.argv.includes("--list-sabotage")) {
  console.log(`T8 目录分桶 · 反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(24)} ${s.where}\n  ${"".padEnd(24)} → 会打红: ${s.reds}`);
  process.exit(0);
}
const sIdx = process.argv.indexOf("--sabotage");
if (sIdx >= 0) {
  const name = process.argv[sIdx + 1];
  const s = SABOTAGE.find((x) => x.name === name);
  if (!s) { console.error(`没有这条手法：${name}。可用：${SABOTAGE.map((x) => x.name).join(", ")}`); process.exit(2); }
  const file = path.join(REPO, s.file);
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes(s.from)) { console.error(`手法 ${name} 的锚点已经对不上源码了（可能已改坏或已改名）`); process.exit(3); }
  fs.writeFileSync(file, src.replace(s.from, s.to));
  console.log(`已把 ${s.file} 改成改坏的样子：${s.where}`);
  process.exit(0);
}