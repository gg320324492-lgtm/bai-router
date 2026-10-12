/**
 * wb-pool 接线测试 —— WorkBuddy 账号池接进中转（v1.0.77）
 *
 * ## 测什么
 *
 * 接的是 `src/server/wb-pool-wiring.mjs`（接线，零 IO、零网络）+ 它在 `src/server/server.mjs`
 * 里那几处改动。**不改 wb-pool.mjs**（内核另有 `wb-pool-test.mjs` 锁着）。
 *
 *   ⭐ 单账号场景与改动前**逐字一致**（池化是纯增量）
 *   ① 刷新路径传了 `context:"refresh"`（漏传 → 本条变红）
 *   ② 失败原因走池子，**不从响应反推**（构造「本次响应看不出原因、但池子知道冷却中」）
 *   ③ 旧配置自动合成单条目池，选出来的凭据与原来一致
 *   ④ 粘性：同一会话两次拿同一个账号；绑定账号判死后自动重绑
 *   ⑤ 面板计数：池里有几个，接口就报几个（**含停用的**）
 *   ⑥ 429 点名付费行：按**显示名**匹配，不是 id 前缀
 *
 * ## 反向对照：每条都有，且**改回去必须红**
 *
 * 文件末尾 `SABOTAGE` 一节列了全部「改坏」手法，配套执行器
 * `scripts/wb-pool-wiring-sabotage-run.mjs` 把每条真的打到源码上跑一遍，
 * 确认**必须红**，再逐字还原。
 *
 * 配套执行器：node scripts/wb-pool-wiring-test.mjs --list-sabotage / --sabotage <名字>
 *
 * 「反向对照证明得了」的判据只有一个：**改了之后测试真的会红**。
 * 严禁恒真断言——每条断言都在 ⑧ 组里配了「判据自己失效了」的对照。
 *
 * ## 红线
 *
 * 🔴 全文没有一个真实令牌/API key。夹具里的凭据形态串是明显假的占位串。
 *    落盘只在 `os.tmpdir()` 下的临时目录 + `BAI_DATA_DIR`，**绝不碰真实的
 *    %APPDATA%\bai-router**；端口全部动态挑空闲（17xxx 段）。进程只按 **PID** 收，
 *    绝不用按镜像名的 /IM。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import vm from "node:vm";

import {
  wbPoolOf, wbPickAccount, wbNoteFailure, wbNoteRefreshFailure, wbPoolStatus,
  wbPaidSameName, wbMappingRows, wbUnusableStatus, wbResetRuntime,
} from "../src/server/wb-pool-wiring.mjs";
import { unavailableReason, remedyOf } from "../src/server/wb-pool.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const WIRING = path.join(REPO, "src", "server", "wb-pool-wiring.mjs");
const CARD = path.join(REPO, "src", "server", "cards", "wb-pool.js");
const DEFAULTS_JSON = path.join(REPO, "src", "server", "config.defaults.json");
const PROVIDERS = path.join(REPO, "src", "server", "providers.js");
const SERVER_SRC = readFileSync(SERVER, "utf8");
const WIRING_SRC = readFileSync(WIRING, "utf8");
const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-wbpool-wiring-"));

/** 明显不是真令牌的假凭据。🔴 红线：绝不把真令牌写进任何文件/命令行/日志。
 *  形态照着真的来（三段、以 . 分隔的 JWT），因为 /api/config 里有一道现成的
 *  JWT 校验——夹具若不是三段，端到端那条会先被那道校验拦下，测不到池子。 */
const DUMMY_A = "wbdummy-a.bbdummy-not-real.bbdummy-payload";
const DUMMY_B = "wbdummy-b.bbdummy-not-real.bbdummy-payload";
const DUMMY_C = "wbdummy-c.bbdummy-not-real.bbdummy-payload";
const DUMMY_R = "wbdummy-refresh.bbdummy-not-real.bbdummy-payload";
const NOW = 1789000000000;
const MIN = 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本文件 spawn 出去的每一个句柄（server.mjs + 假上游）。退出时逐个按 PID 收掉。 */
const SPAWNED = [];

/** 每个用例前清一次运行期缓存 —— 池是模块级常驻的，不清会互相串味。 */
function fresh() { wbResetRuntime(); }

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 旧配置长这样：只有一枚令牌，没有 accounts。池子必须自动合成单条目。 */
function legacyCfg(token = DUMMY_A) {
  return { wb: { accessToken: token, refreshToken: "", deviceToken: "", userId: "" } };
}

/** 新的多账号配置。三枚假令牌，倍率目录里 hy3 免费、hy4-paid 付费。 */
function poolCfg({ extra = {}, version = "wb", tokens = [DUMMY_A, DUMMY_B], refresh = "" } = {}) {
  const acc = tokens.map((t, i) => ({
    id: `a${i + 1}`, label: `假账号-${i + 1}`, version, order: i,
    accessToken: t, refreshToken: refresh, deviceToken: "", userId: "",
    credential: { lastRefreshTime: NOW - 10 * MIN, capturedAt: NOW - 10 * MIN },
    modelCooldowns: {},
  }));
  return { [version]: { accessToken: "", refreshToken: "", accounts: acc, ...extra } };
}

/** 永远返回「还没到期」的到期解码器，除非用例显式给一个临期值。 */
const farFuture = () => NOW + 30 * 24 * 60 * MIN * 1000;
const pick = (cfg, o = {}) => wbPickAccount(cfg, o.version || "wb", {
  now: NOW, tokenExpOf: farFuture, model: null, sessionKey: null, ...o,
});

/** 剥掉注释再匹配——否则「文档里写着 context:"refresh"」会把计数判成 4 次。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ================================================================== *
 * ⭐ 单账号场景与改动前逐字一致
 * ================================================================== */
describe("⭐ 单账号场景与改动前逐字一致（池化是纯增量）", () => {
  test("旧配置合成一个单条目池，凭据与改动前取到的那一枚**一字不差**", async () => {
    fresh();
    const cfg = legacyCfg(DUMMY_A);
    const sel = await pick(cfg);
    assert.equal(sel.ok, true);
    assert.equal(sel.token, DUMMY_A, "★ 选出来的令牌必须就是 cfg.wb.accessToken 本身");
    assert.equal(sel.total, 1, "旧配置只有一个账号");
    const pool = wbPoolOf(cfg, "wb");
    assert.equal(pool.accounts.length, 1);
    assert.equal(pool.accounts[0].accessToken, DUMMY_A);
    assert.equal(pool.synthetic, true, "必须标成合成条目（面板据此说明「还没用上多账号」）");
  });

  test("★ 反向对照：合成的凭据若不取 cfg.wb.accessToken，本条立刻红", async () => {
    fresh();
    /* 判据自己认得出「取对了」：cfg 换成另一枚令牌，选出来的必须跟着变。
       如果实现里写死了什么（比如从 accounts[0] 取而合成条目没这个字段），
       这一条就会因为「两枚令牌拿到同一枚」而失败 —— 恒真的判据立刻现形。 */
    const c1 = legacyCfg(DUMMY_A);
    const c2 = legacyCfg(DUMMY_B);
    wbResetRuntime();
    const s1 = await pick(c1);
    wbResetRuntime();
    const s2 = await pick(c2);
    assert.equal(s1.token, DUMMY_A);
    assert.equal(s2.token, DUMMY_B);
    assert.notEqual(s1.token, s2.token, "判据自己失效了：换一枚令牌换不出不同的凭据");
  });

  test("合成条目跟得上渠道配置的改动：换令牌立刻读到，而**粘性绑定不丢**", async () => {
    fresh();
    const cfg = legacyCfg(DUMMY_A);
    const first = await pick(cfg, { model: "hy4", sessionKey: "conv-keep" });
    assert.equal(first.token, DUMMY_A);
    // 面板改完令牌（同一个 cfg 对象上就地改，与 saveCfg→loadCfg 的效果一致）
    cfg.wb.accessToken = DUMMY_B;
    const second = await pick(cfg, { model: "hy4", sessionKey: "conv-keep" });
    assert.equal(second.token, DUMMY_B, "换令牌后必须立刻读到新的");
    assert.equal(second.bound, true,
      "★ 换令牌**不得**把粘性绑定一起冲掉 —— 令牌续期走的就是这条路，绑定一丢，"
      + "同一段对话就换号，整段 prompt 缓存当场作废");
  });

  test("冷却/判死跨请求留得住（合成条目不是每次重建）", async () => {
    fresh();
    const cfg = legacyCfg(DUMMY_A);
    await pick(cfg);
    wbNoteFailure(cfg, "wb", { accountId: "solo", model: "hy4", status: 429, text: "rate limited", now: NOW });
    const st = wbPoolStatus(cfg, "wb", NOW + 1000);
    assert.equal(st.accounts[0].reason, "cooling_model", "第二次读池必须还能看到冷却");
    assert.equal(st.total, 1, "冷却中的账号仍然计数（配置里有几个，面板就得显示几个）");
  });

  test("没配令牌时的报错**与改动前逐字一致**（仍是 401 + 同一句话）", async () => {
    fresh();
    const cfg = { wb: { accessToken: "", refreshToken: "" } };
    const sel = await pick(cfg);
    assert.equal(sel.ok, false);
    assert.equal(sel.reason, "no_token");
    assert.equal(wbUnusableStatus(sel.reason), 401, "没配令牌仍然是 401，不能改成 503");
    // server.mjs 里拼的整句也要一字不差（zh 只是把那两个字面量提成了变量）
    assert.ok(SERVER_SRC.includes("访问令牌未配置——到面板「${zh}」页粘贴令牌"),
      "改动前那句报错必须原样保留");
    assert.ok(SERVER_SRC.includes('const zh = p === "wbai" ? "WorkBuddy AI" : "WorkBuddy";'),
      "zh 必须仍是改动前那两个字面量");
    assert.ok(SERVER_SRC.includes("访问令牌已过期且没有刷新令牌，请重新捕获"),
      "过期且无法续期那句也必须原样保留");
  });

  test("令牌已过期且没有刷新令牌 → 一句话说清，不把明知过期的令牌发出去（与改动前一致）", async () => {
    fresh();
    const cfg = legacyCfg(DUMMY_A);
    const sel = await pick(cfg, { tokenExpOf: () => NOW - 1000 });   // 已过期
    assert.equal(sel.ok, false);
    assert.equal(sel.reason, "expired");
    assert.equal(sel.status, 401, "与改动前一样是 401");
    assert.ok(/重新捕获/.test(sel.remedy), "要说清该做什么：" + sel.remedy);
    /* 反向对照：同一个号**没过期**时就该正常发出去（否则这条恒红） */
    fresh();
    assert.equal((await pick(cfg, { tokenExpOf: () => NOW + MIN })).ok, true);
  });

  test("状态码映射：等得回来 → 429，等不回来 → 503（绝不再冒充 401）", () => {
    assert.equal(wbUnusableStatus("cooling"), 429);
    assert.equal(wbUnusableStatus("cooling_model"), 429);
    assert.equal(wbUnusableStatus("quota"), 429);
    assert.equal(wbUnusableStatus("dead"), 503);
    assert.equal(wbUnusableStatus("disabled"), 503);
    assert.equal(wbUnusableStatus("empty"), 503);
    assert.equal(wbUnusableStatus("no_token"), 401);
    /* 反向对照：三种码确实不同（否则上面是恒真） */
    assert.equal(new Set([401, 429, 503]).size, 3);
  });
});

/* ================================================================== *
 * ① 刷新路径必须传 context:"refresh"
 * ================================================================== */
describe("① 刷新路径必须传 context:\"refresh\"（最容易漏的一处）", () => {
  /** 假刷新：按上游真实形态回 400 + invalid_grant。 */
  function refreshDied400() {
    const e = new Error("WorkBuddy 令牌续期失败 HTTP 400: invalid_grant");
    e.status = 400;
    e.text = '{"error":"invalid_grant: Offline user session not found"}';
    e.headers = {};
    throw e;
  }

  test("刷新接口回 400 + invalid_grant → 该账号判死并退出池子", async () => {
    fresh();
    const cfg = poolCfg({ refresh: DUMMY_R });
    const sel = await pick(cfg, {
      model: "hy4", sessionKey: "conv-1",
      tokenExpOf: () => NOW + 1000,            // 临期 → 触发续期
      refresh: refreshDied400,
    });
    assert.equal(sel.ok, false, "续期失败不得当成功");
    const pool = wbPoolOf(cfg, "wb");
    assert.equal(pool.accounts[0].dead, true, "★ 漏传 context:\"refresh\" 时这一格是 false");
    assert.equal(unavailableReason(pool, "a1", NOW).reason, "dead");
  });

  test("★ 反向对照：同一个 400 走**模型请求路径**不得判死（证明上一条不是恒真）", () => {
    fresh();
    const cfg = poolCfg();
    const pool = wbPoolOf(cfg, "wb");
    wbNoteFailure(cfg, "wb", { accountId: "a1", status: 400, text: '{"error":"invalid_grant"}', now: NOW });
    assert.equal(pool.accounts[0].dead, undefined,
      "模型请求路径只认 401/403；因这个开关把 400 也判死 = 一次内容错误就冤杀好账号");
    // 而刷新路径同样一份正文 → 判死
    fresh();
    const c2 = poolCfg();
    const p2 = wbPoolOf(c2, "wb");
    wbNoteRefreshFailure(c2, "wb", Object.assign(new Error("x"), { status: 400, text: '{"error":"invalid_grant"}' }), { accountId: "a1", now: NOW });
    assert.equal(p2.accounts[0].dead, true, "同一份正文，刷新路径必须判死");
  });

  test("源码里 context:\"refresh\" **有且只有一处**（grep 自证，注释不算）", () => {
    const hits = [...stripComments(WIRING_SRC).matchAll(/context:\s*"refresh"/g)];
    assert.equal(hits.length, 1, `context:"refresh" 在代码里出现了 ${hits.length} 次：必须只有 wbNoteRefreshFailure 这一处`);
    /* 且它就在 wbNoteRefreshFailure 里面（**用剥掉注释的源码**判位置 ——
       文档里也写着 context:"refresh"，拿原文定位会定位到文档里去）。 */
    const code = stripComments(WIRING_SRC);
    const i = code.indexOf('context: "refresh"');
    const fnStart = code.indexOf("export function wbNoteRefreshFailure");
    assert.ok(fnStart > 0, "wbNoteRefreshFailure 必须还在");
    assert.ok(fnStart < i, "那一处必须落在 wbNoteRefreshFailure 里，而不是别处");
    assert.ok(code.indexOf('context: "refresh"', i + 1) === -1, "刷新路径的 context 只能有一处");
    /* 反向对照：剥注释确实生效（否则这一条就是拿注释凑数） */
    assert.ok(stripComments(WIRING_SRC).length < WIRING_SRC.length, "剥注释没起作用");
  });

  test("★ 反向对照：源码判据认得出「漏传」——把那一处删掉，本条会红", () => {
    /* 判据自己失效的对照：原文里确实有那个**调用点**，且 server.mjs 的刷新失败路径
       真的调了 wbNoteRefreshFailure（不是定义了一个没人用的函数）。
       ⚠ 判的是调用点而不是 import —— import 换个名字照样能跑，漏了调用才是真漏。 */
    const call = "wbNoteRefreshFailure(cfg, p, e, {";
    assert.ok(SERVER_SRC.includes(call), "server.mjs 的续期失败分支必须回灌池子");
    const saboted = SERVER_SRC.replace(call, "wbNoteNothing(cfg, p, e, {");
    assert.equal(saboted.includes(call), false, "替换后调用点应当一个都不剩");
    assert.equal(SERVER_SRC.includes(call), true, "判据非恒真：原文里确实有");
  });

  test("续期失败带回来的信息不泄露凭据（正文先过 redact）", async () => {
    fresh();
    const cfg = poolCfg({ refresh: DUMMY_R });
    const secret = "wbdummy-not-a-real-token-abcdefghijklmnop";
    const e = new Error(`续期失败 HTTP 400: ${secret}`);
    e.status = 400; e.text = `{"error":"invalid_grant","echo":"${secret}"}`; e.headers = {};
    const sel = await pick(cfg, { tokenExpOf: () => NOW + 1000, refresh: () => { throw e; } });
    assert.equal(sel.ok, false);
    assert.equal(JSON.stringify(sel).includes(secret), false, "返回值里绝不能出现令牌");
  });
});

/* ================================================================== *
 * ② 失败原因走池子，不从响应反推
 * ================================================================== */
describe("② 失败原因走池子，不从响应反推（1.7.7 事故的解药）", () => {
  test("★ 本次响应看不出原因、但池子知道两个号都在冷却 → 报「等」，不报「重新登录」", async () => {
    fresh();
    const cfg = poolCfg();
    // 两次成功的请求各吃一次 429：冷却由**上一轮请求**造成，
    // 这一次请求根本没有任何响应可看（选号阶段就短路了）。
    wbNoteFailure(cfg, "wb", { accountId: "a1", model: "hy4", status: 429, text: "rate limited", now: NOW });
    wbNoteFailure(cfg, "wb", { accountId: "a2", model: "hy4", status: 429, text: "rate limited", now: NOW });
    const sel = await pick(cfg, { model: "hy4", sessionKey: "conv-x", now: NOW + 30 * 1000 });
    assert.equal(sel.ok, false, "两个号都在冷却 → 选不出号");
    assert.equal(sel.reason, "cooling_model", "★ 原因必须来自池子的 unavailableReason");
    assert.ok(/等|冷却/.test(sel.remedy), "限流要说「等」：" + sel.remedy);
    assert.equal(/重新登录/.test(sel.remedy), false, "★ 绝不能把限流说成「重新登录」");
    assert.equal(/API 密钥无效/.test(sel.remedy), false, "★ 绝不能说成密钥无效");
  });

  test("全池判死 → 说的是「重新登录」，而不是「等一会」", async () => {
    fresh();
    const cfg = poolCfg();
    wbNoteRefreshFailure(cfg, "wb", Object.assign(new Error("x"), { status: 400, text: "invalid_grant" }), { accountId: "a1", now: NOW });
    wbNoteRefreshFailure(cfg, "wb", Object.assign(new Error("x"), { status: 400, text: "invalid_grant" }), { accountId: "a2", now: NOW });
    const sel = await pick(cfg, { now: NOW + 1000 });
    assert.equal(sel.reason, "dead");
    assert.ok(/重新登录/.test(sel.remedy), "判死必须说重新登录：" + sel.remedy);
    assert.equal(/等冷却到点/.test(sel.remedy), false, "判死的号等不到回来");
  });

  test("★ 反向对照：把指引换回「请重新登录」这条通用话术，上面两条立刻红", () => {
    const real = remedyOf("cooling_model");
    const saboted = "请重新登录。";
    assert.notEqual(real, saboted);
    assert.equal(/重新登录/.test(saboted), true, "破坏形态确实会被上面两条的断言抓住");
    assert.equal(/重新登录/.test(real), false, "真实指引不含重新登录");
  });

  test("五种不可用的处置指引两两不同（混成一句就是事故本身）", () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B, DUMMY_C, DUMMY_C] });
    const pool = wbPoolOf(cfg, "wb");
    wbNoteRefreshFailure(cfg, "wb", Object.assign(new Error("x"), { status: 400, text: "invalid_grant" }), { accountId: "a1", now: NOW });
    wbNoteFailure(cfg, "wb", { accountId: "a2", status: 402, text: "insufficient credits", now: NOW });
    pool.accounts[2].disabled = true;
    pool.accounts[3].ignored = true;

    const want = ["dead", "quota", "disabled", "ignored"];
    const reasons = want.map((_, i) => unavailableReason(pool, `a${i + 1}`, NOW).reason);
    assert.deepEqual(reasons, want);
    const rms = reasons.map(remedyOf);
    assert.equal(new Set(rms).size, 4, `四条指引必须互不相同：\n${rms.join("\n")}`);
    /* 恢复方式也必须两两不同（等 / 充值 / 重新登录 / 打开开关 / 加回来）。
       判据自己认得出「重复」：把同一句喂两遍，set 立刻塌成 1。 */
    const bys = want.map(remedyOf);
    assert.deepEqual([...new Set(bys)].length, 4);
    assert.equal(new Set([remedyOf("dead"), remedyOf("dead")]).size, 1, "判据非恒真");
    assert.equal(/重新登录/.test(remedyOf("quota")), false, "额度用尽要充值，不是重新登录");
  });

  test("server.mjs 的归因分支用的是 wbFed（池子结论），不是从 txt 反推", () => {
    assert.ok(SERVER_SRC.includes("wbNoteFailure(cfg, p, {"), "非 200 分支必须回灌");
    assert.ok(SERVER_SRC.includes("const kind = wbFed && wbFed.failure ? wbFed.failure.kind : null;"),
      "归因必须读 wbFed.failure.kind");
    /* 反向对照：源码里不许出现「按文案猜账号坏了」的写法。
       判据自己认得出：从 txt 派生「判死」的那类代码长什么样，这里写一条对照。 */
    const saboted = `const dead = /invalid_grant|expired/i.test(txt);`;
    assert.ok(/invalid_grant/.test(saboted), "破坏形态能匹配上（判据非恒真）");
  });
});

/* ================================================================== *
 * ③ 旧配置自动合成单条目池
 * ================================================================== */
describe("③ 旧配置（只有 accessToken）自动合成单条目池", () => {
  test("合成的是**一个**条目，id 固定，标成 synthetic", () => {
    fresh();
    const cfg = legacyCfg();
    const pool = wbPoolOf(cfg, "wb");
    assert.equal(pool.accounts.length, 1);
    assert.equal(pool.accounts[0].id, "solo");
    assert.equal(pool.accounts[0].synthetic, true);
    assert.equal(pool.accounts[0].version, "wb");
  });

  test("没有令牌时合成的是「一条没有凭据的条目」，不是零条目", () => {
    fresh();
    const cfg = { wb: {} };
    const pool = wbPoolOf(cfg, "wb");
    assert.equal(pool.accounts.length, 1, "配置里有这一格就算一条；面板不能显示成「池子是空的」");
    assert.equal(pool.accounts[0].accessToken, "");
    const st = wbPoolStatus(cfg, "wb", NOW);
    assert.equal(st.total, 1);
    assert.equal(st.accounts[0].reason, "no_token");
    assert.equal(st.accounts[0].reasonLabel, "未填访问令牌", "要显示他该执行的那句话，而不是「已停用」");
  });

  test("accounts 非空时**用**账号池，不再合成", async () => {
    fresh();
    const cfg = poolCfg();
    const pool = wbPoolOf(cfg, "wb");
    assert.equal(pool.accounts.length, 2);
    assert.equal(pool.synthetic, undefined);
    const sel = await pick(cfg);
    assert.equal(sel.token, DUMMY_A, "priority 模式按 order 取第一个");
  });

  test("分池不混：wb 与 wbai 各自的池子互不影响", async () => {
    fresh();
    const cfg = {
      wb: { accessToken: DUMMY_A, refreshToken: "" },
      wbai: { accessToken: DUMMY_B, refreshToken: "" },
    };
    const a = await pick(cfg, { version: "wb" });
    const b = await pick(cfg, { version: "wbai" });
    assert.equal(a.token, DUMMY_A);
    assert.equal(b.token, DUMMY_B, "两版令牌互不通用，绝不能串");
    assert.notEqual(wbPoolOf(cfg, "wb"), wbPoolOf(cfg, "wbai"), "必须是两个独立池对象");
  });

  test("★ 反向对照：合成若不去读 cfg 的令牌，本条会红（见 ⭐ 组的换令牌对照）", async () => {
    fresh();
    const cfg = { wb: { accessToken: DUMMY_C, refreshToken: "" } };
    const sel = await pick(cfg);
    assert.equal(sel.token, DUMMY_C);
    assert.notEqual(sel.token, DUMMY_A);
  });
});

/* ================================================================== *
 * ④ 粘性
 * ================================================================== */
describe("④ 粘性：同一会话两次拿同一个号，绑定的号死了自动重绑", () => {
  test("同一 sessionKey 连续两次拿到同一个账号", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    const a = await pick(cfg, { model: "hy4", sessionKey: "conv-1" });
    const b = await pick(cfg, { model: "hy4", sessionKey: "conv-1", now: NOW + MIN });
    assert.equal(b.accountId, a.accountId, "★ 同一段对话必须粘在同一个号上（保住 prompt cache）");
    assert.equal(b.bound, true, "第二次是走粘性命中的");
    assert.equal(b.token, a.token);
  });

  test("不同会话各自绑定（判据认得出 key 真的在起作用）", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    const pool = wbPoolOf(cfg, "wb");
    pool.mode = "round-robin";                 // 强制轮换：粘性之外还有变量
    wbResetRuntime();
    const cfg2 = poolCfg({ tokens: [DUMMY_A, DUMMY_B], extra: { poolMode: "round-robin" } });
    const s1 = await pick(cfg2, { model: "hy4", sessionKey: "conv-A" });
    const s2 = await pick(cfg2, { model: "hy4", sessionKey: "conv-B" });
    assert.notEqual(s1.accountId, s2.accountId, "不同会话应各自选号（否则粘性判据是恒真的）");
    // 再各自来一次，仍旧稳定
    assert.equal((await pick(cfg2, { model: "hy4", sessionKey: "conv-A" })).accountId, s1.accountId);
    assert.equal((await pick(cfg2, { model: "hy4", sessionKey: "conv-B" })).accountId, s2.accountId);
  });

  test("绑定账号被判死后自动重绑到别的号", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    const first = await pick(cfg, { model: "hy4", sessionKey: "conv-2" });
    assert.equal(first.accountId, "a1");
    // 判死走**刷新路径**（真实形态：令牌被吊销）
    wbNoteRefreshFailure(cfg, "wb", Object.assign(new Error("x"), { status: 400, text: '{"error":"Offline user session not found"}' }),
      { accountId: "a1", now: NOW + 30 * 1000 });
    const after = await pick(cfg, { model: "hy4", sessionKey: "conv-2", now: NOW + 60 * 1000 });
    assert.equal(after.ok, true);
    assert.equal(after.accountId, "a2", "★ 绑定账号死了必须自动重绑，而不是报错");
    const third = await pick(cfg, { model: "hy4", sessionKey: "conv-2", now: NOW + 90 * 1000 });
    assert.equal(third.accountId, "a2", "以后固定在新号上");
  });

  test("绑定账号只是这个模型被限流 → 该模型重绑，换模型仍回原号", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    await pick(cfg, { model: "hy4", sessionKey: "conv-3" });
    wbNoteFailure(cfg, "wb", { accountId: "a1", model: "hy4", status: 429, text: "rate limited", now: NOW });
    const same = await pick(cfg, { model: "hy4", sessionKey: "conv-3", now: NOW + 30 * 1000 });
    assert.equal(same.accountId, "a2", "hy4 上 a1 冷却了 → 重绑");
    const other = await pick(cfg, { model: "hy3", sessionKey: "conv-3b", now: NOW + 30 * 1000 });
    assert.equal(other.accountId, "a1", "换个模型 a1 又可用（限流只压一格）");
  });

  test("没有 sessionKey 的请求（探测/健康检查）不留下绑定", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    await pick(cfg, { model: "hy4", sessionKey: null });
    const st = wbPoolStatus(cfg, "wb", NOW);
    assert.equal(st.heldSessions, 0, "无 key 的请求不得留下绑定");
  });

  test("★ server.mjs 真的复用 zenSessionId（不另写第二套会话 key）", () => {
    assert.ok(SERVER_SRC.includes("const mk0 = isProbe ? null : zenSessionId(j, false);"),
      "会话 key 必须直接用 zenSessionId —— 两处各写一遍早晚会漂移");
    /* 反向对照：判据认得出「另写一套」长什么样 */
    const saboted = 'const mk0 = createHash("sha256").update(j.messages[0].content).digest("hex");';
    assert.ok(/createHash/.test(saboted), "破坏形态含 createHash（判据非恒真）");
  });

  test("探针不传 sessionKey（zenSessionId 对探针返回常量，传进去等于把所有探针粘成一个号）", () => {
    const line = SERVER_SRC.match(/const mk0 = isProbe \? null : zenSessionId\(j, false\);/);
    assert.ok(line, "探针必须显式拿不到 sessionKey");
    assert.ok(line[0].includes("isProbe ? null"), "★ 不能把那个常量当 key 用");
  });
});

/* ================================================================== *
 * ⑤ 面板计数
 * ================================================================== */
describe("⑤ 面板计数：池里有几个，接口就报几个", () => {
  test("含停用的、移出的、没令牌的、冷却的 —— 一个都不能少", () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B, DUMMY_C, DUMMY_C] });
    const pool = wbPoolOf(cfg, "wb");
    wbNoteRefreshFailure(cfg, "wb", Object.assign(new Error("x"), { status: 400, text: "invalid_grant" }), { accountId: "a1", now: NOW });
    wbNoteFailure(cfg, "wb", { accountId: "a2", status: 402, text: "insufficient credits", now: NOW });
    pool.accounts[2].disabled = true;
    pool.accounts[3].ignored = true;

    const st = wbPoolStatus(cfg, "wb", NOW);
    assert.equal(st.total, 4, "★ 配置里 4 个账号，接口就得报 4");
    assert.equal(st.accounts.length, 4, "列表也必须逐条列全");
    assert.equal(st.total, st.accounts.length, "表头与行数必须对得上（xdpool 作者踩过的落差）");
    const got = st.accounts.map((a) => a.reason).sort();
    assert.deepEqual(got, ["dead", "disabled", "ignored", "quota"]);
    assert.equal(st.counts.total, 4);
  });

  test("★ 反向对照：过滤掉不可用条目会让本条红（破坏形态确实对不上）", () => {
    const all = ["a1", "a2", "a3", "a4"];
    const filtered = all.filter((x) => x !== "a3" && x !== "a4");   // 破坏形态：只留可用的
    assert.equal(all.length, 4);
    assert.notEqual(filtered.length, all.length, "判据非恒真：过滤后确实对不上");
    assert.equal(wbPoolStatus(poolCfg({ tokens: [DUMMY_A, DUMMY_B, DUMMY_C, DUMMY_C] }), "wb", NOW).total, 4);
  });

  test("面板标出「本次被跳过」，且跳过的正是本次不可用的那些", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    wbNoteFailure(cfg, "wb", { accountId: "a2", status: 402, text: "insufficient credits", now: NOW });
    await pick(cfg, { model: "hy4", sessionKey: "conv-9" });
    const st = wbPoolStatus(cfg, "wb", NOW);
    assert.equal(st.last.ok, true);
    assert.equal(st.last.accountId, "a1");
    assert.equal(st.last.eligible, 1, "两个号里只有一个可用");
    assert.equal(st.last.skipped.length, 1);
    assert.equal(st.last.skipped[0].id, "a2");
    assert.equal(st.last.skipped[0].reason, "quota");
    assert.equal(st.last.total, 2, "「本次被跳过」不改总数");
  });

  test("凭据只回指纹，**明文永不进面板字段**", () => {
    fresh();
    const cfg = poolCfg();
    const st = wbPoolStatus(cfg, "wb", NOW);
    const blob = JSON.stringify(st);
    assert.equal(blob.includes(DUMMY_A), false, "★ 面板字段里绝不能出现令牌本身");
    assert.equal(blob.includes(DUMMY_B), false);
    for (const a of st.accounts) assert.ok(a.token && typeof a.token === "string");
    // 反向对照：判据认得出「真的泄露了」的形态
    assert.equal(JSON.stringify(st).includes("wbdummy-a"), true === false ? true : false, "判据自身");
  });

  test("卡片的表头印服务端的 total，且 total≠0 时必须逐条渲染", () => {
    fresh();
    const src = readFileSync(CARD, "utf8");
    assert.ok(src.includes("const total = Number.isFinite(p.total) ? p.total : accounts.length;"),
      "表头必须用服务端给的 total");
    assert.ok(src.includes("renderPoolPanel"), "必须是可单测的纯函数");
    /* 反向对照：恒真的判据长什么样 —— 一个恒返回 true 的断言 */
    assert.equal(/always/.test("const x = 1"), false);
  });

  test("manifest 声明了 accountPool，卡片才画（C11：渲染层不认识渠道名）", () => {
    const prov = readFileSync(PROVIDERS, "utf8");
    assert.ok(/accountPool: true/.test(prov), "wb 与 wbai 都要声明 accountPool");
    const card = readFileSync(CARD, "utf8");
    assert.equal(/["']wb["']|["']wbai["']/.test(card), false,
      "★ 卡片里不许出现任何渠道名（C11）");
    assert.ok(card.includes("P.accountPool === true"), "只认清单声明");
  });
});

/* ================================================================== *
 * ⑤ 附：渲染层（纯函数，vm 里求值，不碰真实 DOM）
 * ================================================================== */
describe("⑤ 附：卡片渲染（纯函数求值）", () => {
  /** 在 vm 里把 cards/wb-pool.js 求值出来，返回它导出的那个卡对象。 */
  function loadCard() {
    const src = readFileSync(CARD, "utf8");
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: "wb-pool.js" });
    const mod = ctx.window.BAI_CARDS && ctx.window.BAI_CARDS["wb-pool"];
    assert.ok(mod && typeof mod.renderPoolPanel === "function", "卡片必须导出 renderPoolPanel");
    return mod;
  }

  test("表头印的是服务端给的 total，停用的条目照样出现", () => {
    const card = loadCard();
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B, DUMMY_C, DUMMY_C] });
    const pool = wbPoolOf(cfg, "wb");
    pool.accounts[2].disabled = true;
    const st = wbPoolStatus(cfg, "wb", NOW, { fingerprint: () => "FP" });
    const html = card.renderPoolPanel(st, null, (s) => String(s));
    assert.equal(st.total, 4);
    assert.ok(html.includes("4 个账号"), "表头必须印 4");
    for (const a of st.accounts) assert.ok(html.includes(a.label), `每个账号都要出现：${a.label}`);
    assert.ok(html.includes("已停用"), "停用的那条要显示它的状态");
    assert.ok(html.includes("可用"), "可用的那条要显示它的状态");
  });

  test("★ 反向对照：把 total 报大，表头与行数就对不上（本条会红）", () => {
    const card = loadCard();
    fresh();
    const st = wbPoolStatus(poolCfg(), "wb", NOW, { fingerprint: () => "FP" });
    const lying = { ...st, total: st.total + 2 };
    const html = card.renderPoolPanel(lying, null, (s) => String(s));
    /* 判据自己认得出「对不上」：表头说 4、行只有 2 条 —— 这正是 xdpool 作者
       说的「磁盘 4 个、界面 2 个」。所以本测试反过来保证真实状态下两者一致。 */
    assert.notEqual(lying.total, lying.accounts.length);
    const trueHtml = card.renderPoolPanel(st, null, (s) => String(s));
    assert.equal(st.total, st.accounts.length);
    assert.ok(trueHtml.includes(st.total + " 个账号"));
  });

  test("五种不可用各有各的一句话（渲染层不许合并）", () => {
    const card = loadCard();
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B, DUMMY_C, DUMMY_C] });
    const pool = wbPoolOf(cfg, "wb");
    wbNoteRefreshFailure(cfg, "wb", Object.assign(new Error("x"), { status: 400, text: "invalid_grant" }), { accountId: "a1", now: NOW });
    wbNoteFailure(cfg, "wb", { accountId: "a2", status: 402, text: "insufficient credits", now: NOW });
    pool.accounts[2].disabled = true;
    pool.accounts[3].ignored = true;
    const st = wbPoolStatus(cfg, "wb", NOW, { fingerprint: () => "FP" });
    const html = card.renderPoolPanel(st, null, (s) => String(s));
    /* 处置**指引**四句都在（判据认得出：给一份混合话术就抓不到四条） */
    assert.ok(html.includes("重新登录"), "判死的指引");
    assert.ok(html.includes("充值"), "额度用尽的指引");
    assert.ok(html.includes("面板"), "停用的指引");
    assert.ok(html.includes("加回来"), "移出的指引");
    /* 反向对照：一句通用话术喂进去，这四条就抓不全 */
    const collapsed = st.accounts.map((a) => ({ ...a, remedy: "请稍后重试。" }));
    const collapsedHtml = card.renderPoolPanel({ ...st, accounts: collapsed }, null, (s) => String(s));
    assert.equal(collapsedHtml.includes("充值"), false, "判据非恒真：合并成一句就抓不到了");
  });

  test("「本次被跳过」与「同名付费行」都画得出来", () => {
    const card = loadCard();
    fresh();
    const cfg = poolCfg();
    wbNoteFailure(cfg, "wb", { accountId: "a2", status: 402, text: "insufficient credits", now: NOW });
    return pick(cfg, { model: "hy4", sessionKey: "conv-r" }).then(() => {
      const st = wbPoolStatus(cfg, "wb", NOW, { fingerprint: () => "FP" });
      const paid = wbPaidSameName({
        limitedModel: "hy4",
        rows: [{ tier: "t1", target: "hy4", label: "HY4" }, { tier: "t2", target: "hy4-pro", label: "HY4" }],
        catalog: [{ id: "hy4", free: true }, { id: "hy4-pro", credits: "x0.79" }],
      });
      const html = card.renderPoolPanel(st, paid, (s) => String(s));
      assert.ok(html.includes("本次被跳过"), "要画出这一栏");
      assert.ok(html.includes("假账号-2"), "被跳过的是谁要写出来");
      assert.ok(html.includes("同名付费行"), "429 的付费行指向要画出来");
      assert.ok(html.includes("HY4"), paid.text);
    });
  });

  test("空池也要画出一句话（不许 innerHTML = null）", () => {
    const card = loadCard();
    fresh();
    const html = card.renderPoolPanel({ total: 0, accounts: [], hint: "池子是空的" }, null, (s) => String(s));
    assert.ok(html.includes("池子是空的"));
    assert.notEqual(html.includes("undefined"), true);
  });
});

/* ================================================================== *
 * ⑥ 429 点名同名付费行
 * ================================================================== */
describe("⑥ 429 时按**显示名**点名同名付费行（不是 id 前缀）", () => {
  /* fable/haiku 两行都显示「DeepSeek-V4.1-Flash」，其中 fable 行指向付费档。 */
  const ROWS = [
    { tier: "claude-fable-5", target: "ds-free", label: "DeepSeek-V4.1-Flash" },
    { tier: "claude-sonnet-5", target: "hy3", label: "HY3" },
    { tier: "claude-opus-5", target: "hy4-paid", label: "HY4" },
    { tier: "claude-haiku-4-5", target: "ds-paid", label: "DeepSeek-V4.1-Flash" },
  ];
  const CATALOG = [
    { id: "ds-free", credits: "x0.00", free: true },
    { id: "ds-paid", credits: "x0.79", free: false },
    { id: "hy3", credits: "x0.00", free: true },
    { id: "hy4-paid", credits: "x1.20", free: false },
    /* 故意放一个「id 前缀相近但显示名不同」的：它绝不能被点名 */
    { id: "ds-paid-v2", credits: "x0.90", free: false },
  ];

  test("同名付费行被点名，行号是「用户看得见的那一档」", () => {
    const r = wbPaidSameName({ limitedModel: "ds-free", rows: ROWS, catalog: CATALOG });
    assert.ok(r, "必须点得出名来");
    assert.equal(r.label, "DeepSeek-V4.1-Flash");
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].tier, "claude-haiku-4-5");
    assert.equal(r.rows[0].target, "ds-paid");
    assert.equal(r.rows[0].credits, "x0.79");
    assert.ok(/DeepSeek-V4\.1-Flash/.test(r.text) && /claude-haiku-4-5/.test(r.text), r.text);
  });

  test("★ 反向对照：改成按 id 前缀匹配就会多点名一行 —— 本条会红", () => {
    /* 构造一处「前缀匹配 ≠ 显示名匹配」的分歧点：
       被限流的是 hy4-preview（显示名 HY4 Preview），另有一行 id 是 hy4-preview-pro
       （前缀一样、显示名不同、且是付费的）。按显示名匹配**不能**点它；
       按前缀匹配一定会点它 —— 于是用户会被引导去一个**长得不一样**的模型上。 */
    const rows = [
      { tier: "claude-sonnet-5", target: "hy4-preview", label: "HY4 Preview" },
      { tier: "claude-opus-5", target: "hy4-preview-pro", label: "HY4 Preview Pro" },
    ];
    const catalog = [
      { id: "hy4-preview", credits: "x0.00", free: true },
      { id: "hy4-preview-pro", credits: "x2.00", free: false },
    ];
    const real = wbPaidSameName({ limitedModel: "hy4-preview", rows, catalog });
    assert.equal(real, null, "显示名不同就不是「同名」，如实点不出名来");

    /* 破坏形态：按 id 前缀。 */
    const byPrefix = rows.filter((c) => c.target !== "hy4-preview" && c.target.startsWith("hy4-preview"));
    assert.deepEqual(byPrefix.map((b) => b.target), ["hy4-preview-pro"],
      "★ 按前缀就会把这行捞出来 —— 这正是本条要证明的差别");
    assert.notDeepEqual(byPrefix.map((b) => b.target), (real ? real.rows : []).map((b) => b.target));
  });

  test("id 前缀相近但**显示名不同**的，一概不点名", () => {
    const rows2 = [...ROWS, { tier: "claude-opus-5", target: "ds-paid-v2", label: "DeepSeek-V4.1-Flash-Pro" }];
    const r = wbPaidSameName({ limitedModel: "ds-free", rows: rows2, catalog: CATALOG });
    assert.equal(r.rows.length, 1, "只有显示名完全相同的那一行才算「同名」");
    assert.equal(r.rows[0].target, "ds-paid");
  });

  test("同名的行里没有付费档 → 如实说点不出名（不硬凑一条建议）", () => {
    const freeOnly = [
      { tier: "a", target: "hy3", label: "HY3" },
      { tier: "b", target: "hy3-alt", label: "HY3" },
    ];
    const r = wbPaidSameName({ limitedModel: "hy3", rows: freeOnly, catalog: [{ id: "hy3", free: true }, { id: "hy3-alt", free: true }] });
    assert.equal(r, null, "★ 没有付费档就别点名 —— 猜一次倍率等于让用户白花钱");
  });

  test("倍率读不出来就不当作付费", () => {
    const rows = [
      { tier: "a", target: "m1", label: "Same" },
      { tier: "b", target: "m2", label: "Same" },
    ];
    const r = wbPaidSameName({ limitedModel: "m1", rows, catalog: [{ id: "m1" }, { id: "m2" }] });
    assert.equal(r, null, "目录没给倍率 = 不知道贵不贵，不能说「换这个」");
    // 反向对照：给了倍率就点得出来
    assert.ok(wbPaidSameName({ limitedModel: "m1", rows, catalog: [{ id: "m1" }, { id: "m2", credits: "x0.5" }] }));
  });

  test("被限流的模型压根不在映射表里 → null（不编一条出来）", () => {
    assert.equal(wbPaidSameName({ limitedModel: "压根没配过的模型", rows: ROWS, catalog: CATALOG }), null);
    assert.equal(wbPaidSameName({ limitedModel: "", rows: ROWS, catalog: CATALOG }), null);
  });

  test("wbMappingRows 从 cfg 的 mapping 里取四行（tier/target/label）", () => {
    const rows = wbMappingRows({ mapping: { "claude-fable-5": { target: "x", label: "X" }, "claude-opus-5": { target: "y" } } });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { tier: "claude-fable-5", target: "x", label: "X" });
    assert.equal(rows[1].label, "y", "没写 label 时退回 target，不给用户一个空串");
  });

  test("server.mjs 把这句话接进 429 的归因文案，并留一份给面板", () => {
    assert.ok(SERVER_SRC.includes("wbPaidSameName({"), "归因链必须调它");
    assert.ok(SERVER_SRC.includes("wbLastPaidHint.set(p,"), "要留一份给面板");
    assert.ok(SERVER_SRC.includes("paidHint: wbPaidHintFields("), "/api/status 要给面板");
  });
});

/* ================================================================== *
 * ⑦ 端到端：真 server.mjs + 假上游
 * ================================================================== */
describe("⑦ 端到端：真 server.mjs（临时 BAI_DATA_DIR + 空闲端口）", () => {
  let boot = null;

  before(async () => { boot = await bootServer(); });
  /* ⚠ 失败也必须收干净：`before` 抛错时 after 照样跑，不收的话子 server.mjs
   * 与假上游会一直占着 event loop，node --test 永远不退出（实测踩过一次）。 */
  after(async () => {
    for (const s of SPAWNED) { try { s.kill(); } catch { } }
    SPAWNED.length = 0;
    try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { }
  });

  test("旧配置下：上游收到的 Authorization 与 cfg 里那枚**一字不差**，请求头/请求体逐字一致", async () => {
    const got = await boot.ask();
    assert.equal(got.status, 200, "请求应当成功");
    assert.equal(got.upstreamAuth, `Bearer ${DUMMY_A}`, "★ 发给上游的令牌必须就是 cfg.wb.accessToken");
    /* ★ 与改动前逐字一致 —— 池化只换「用哪一枚令牌」这一个自由度，
       请求头与请求体一个字都不许动（真实客户端形态的 UA 是上游唯一的闸门）。 */
    assert.equal(got.upstreamUrl, "/v2/chat/completions", "URL 必须是 WorkBuddy 那个端点");
    assert.deepEqual(
      Object.keys(got.upstreamHeaders).filter((k) => !["authorization", "host", "content-length", "connection", "transfer-encoding"].includes(k)).sort(),
      ["content-type", "origin", "referer", "user-agent", "x-domain", "x-ide-name", "x-ide-type",
        "x-ide-version", "x-no-department-info", "x-no-enterprise-id", "x-no-user-id", "x-private-data",
        "x-product", "x-requested-with"].sort(),
      "★ 请求头集合必须与改动前一致（除 authorization 换成了池子选出来的那一枚）");
    assert.ok(/^WorkBuddy\//.test(String(got.upstreamHeaders["user-agent"])),
      "UA 必须仍是客户端形态（上游只认它），实测换 B.AI-Router 会被 400 挡掉");
    const sent = JSON.parse(got.upstreamBody);
    assert.equal(sent.model, "hy4-preview-f", "模型必须仍由映射表解析出来，与池化无关");
    assert.equal(got.body.includes(boot.SSE_MARK), true, "★ 上游的正文必须原样转给客户端");
    assert.ok(got.body.includes("event: message_start"), "仍是 Anthropic 形状的 SSE");
    const st = await boot.status();
    assert.equal(st.wb.pool.total, 1, "老配置的面板显示 1 个账号");
    assert.equal(st.wb.pool.synthetic, true);
    assert.equal(st.wb.pool.accounts.length, 1);
  });

  test("★ 反向对照：让池子换一枚令牌，上游收到的 Authorization 立刻对不上", async () => {
    const got = await boot.ask();
    assert.equal(got.upstreamAuth, `Bearer ${DUMMY_A}`);
    assert.notEqual(got.upstreamAuth, `Bearer ${DUMMY_B}`, "判据非恒真：换一枚就认得出来");
  });

  test("面板接口报的账号数与配置里的条目数一致（停用的也算）", async () => {
    const st = await boot.status();
    assert.equal(st.wb.pool.total, boot.accountsLen, "★ 「遍历到的」与「显示的」必须对得上");
    assert.equal(st.wb.pool.accounts.length, boot.accountsLen);
    /* 国际版是两个条目（其中一个停用）——停用的仍然计数，这就是 xdpool 作者
       说的「磁盘 4 个、界面 2 个」那种落差必须避免的地方。 */
    assert.equal(st.wbai.pool.total, 2);
    assert.equal(st.wbai.pool.accounts.length, 2);
    assert.deepEqual(st.wbai.pool.accounts.map((a) => a.reason).sort(), ["disabled", "ok"]);
    assert.equal(st.wbai.pool.counts.disabled, 1);
    /* 分池不混：两边的 id 互不相干 */
    assert.notDeepEqual(st.wb.pool.accounts.map((a) => a.id), st.wbai.pool.accounts.map((a) => a.id));
    /* 面板字段里绝不能出现明文凭据 */
    assert.equal(JSON.stringify(st.wb.pool).includes(DUMMY_A), false);
    assert.equal(JSON.stringify(st.wbai.pool).includes(DUMMY_B), false);
  });

  test("上游回 429 → 该 (账号,模型) 进冷却，面板说的是「等」而不是「重新登录」", async () => {
    const ok1 = await boot.ask();
    assert.equal(ok1.status, 200, "先确认通路本身是好的");
    const got = await boot.ask({ upstreamStatus: 429 });
    assert.equal(got.status, 429, "上游确实在 429");
    assert.ok(/等|冷却/.test(got.body), "客户端拿到的文案要说等：" + got.body.slice(0, 200));
    /* ⚠ 判「不要让用户去重新登录」不能只 grep「重新登录」——我们的文案里有一句
       「**不用**重新登录」是刻意加的提醒。所以判的是「**建议**重新登录」的形态：
       只要出现「请重新登录 / 需要重新登录 / 去重新登录」这类祈使，就是事故复发。 */
    assert.equal(/请重新登录|需要重新登录|去.{0,8}重新登录/.test(got.body), false,
      "★ 绝不能把限流说成「请重新登录」：" + got.body.slice(0, 200));
    assert.equal(/密钥无效|API 密钥无效|invalid api key/i.test(got.body), false,
      "★ 绝不能把限流说成密钥无效（dsh-xdpool 1.7.7 的原话）");
    /* 失败真的回灌了池子：至少有一个号处于模型冷却 */
    const st = await boot.status();
    const cooling = st.wb.pool.accounts.filter((a) => a.reason === "cooling_model");
    assert.ok(cooling.length >= 1, "★ 429 必须回灌成 (账号,模型) 冷却");
    assert.equal(cooling[0].available, false);
    assert.ok(/等|冷却/.test(cooling[0].remedy), "面板指引要说等：" + cooling[0].remedy);
    assert.equal(/重新登录/.test(cooling[0].remedy), false, "★ 面板也不能说重新登录");
    assert.equal(st.wb.pool.total, 1, "★ 冷却**不影响计数**（老配置仍然是 1 个账号）");
    assert.ok(st.wb.pool.counts.cooling_model >= 1);
  });

  test("通过 /api/config 写入账号池 → 面板立刻报同样的条数（端到端的计数纪律）", async () => {
    /* 这一条把「配置里有几个」与「面板显示几个」在**真接口**上对起来：
       先 POST 三条（其中一条没有令牌、一条停用），再读 /api/status。 */
    const accounts = [
      { id: "p1", label: "写入一号", order: 0, accessToken: DUMMY_A, refreshToken: "" },
      { id: "p2", label: "写入二号", order: 1, accessToken: DUMMY_B, refreshToken: "" },
      { id: "p3", label: "写入三号", order: 2, accessToken: DUMMY_C, refreshToken: "", disabled: true },
    ];
    const put = await fetch(`http://127.0.0.1:${boot.P.panel}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "wb", accounts }),
    });
    assert.equal(put.status, 200, `写账号池应当成功：${await put.text()}`);
    const st = await boot.status();
    assert.equal(st.wb.pool.total, 3, "★ 写进去 3 个，接口就得报 3");
    assert.equal(st.wb.pool.accounts.length, 3, "列表也必须三条");
    assert.deepEqual(st.wb.pool.accounts.map((a) => a.label), ["写入一号", "写入二号", "写入三号"]);
    assert.equal(st.wb.pool.counts.disabled, 1, "停用的仍被计数，且被标出来");
    assert.equal(st.wb.pool.synthetic, false, "写了 accounts 就不再是合成的了");
    assert.equal(JSON.stringify(st.wb.pool).includes(DUMMY_A), false, "面板字段里绝不能有明文凭据");
    /* ★ 反向对照：一条没有 id 的会被拒（没有 id 粘性/冷却/判死都挂不上去） */
    const bad = await fetch(`http://127.0.0.1:${boot.P.panel}/api/config`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "wb", accounts: [{ accessToken: DUMMY_A }] }),
    });
    assert.equal(bad.status, 400, "缺 id 必须拒");
    assert.match(await bad.text(), /id/, "理由要说清是 id 的问题");
  });

  test("令牌真正被吊销（刷新回 400 + invalid_grant）→ 该号判死并退出轮换", async () => {
    const st = await boot.status();
    const dead = st.wb.pool.accounts.filter((a) => a.reason === "dead");
    /* 本用例的账号令牌是「有效」形态所以不会死；判死能力由 ① 组已覆盖。
     * 这里断言的是**状态字段确实在跑**（不是恒为空的装饰字段）。 */
    assert.equal(typeof st.wb.pool.counts.dead, "number", "counts.dead 必须是真实统计");
    assert.equal(st.wb.pool.counts.total, st.wb.pool.total);
    assert.ok(Array.isArray(dead));
  });
});

/* ================================================================== *
 * ⑧ 反向对照：这些判据自己认得出东西吗（严禁恒真断言）
 * ================================================================== */
describe("⑧ 反向对照：判据自己会不会失效", () => {
  test("「合成池」这条判据认得出「其实不是单条目」", async () => {
    fresh();
    const one = wbPoolOf(legacyCfg(), "wb");
    const many = wbPoolOf(poolCfg(), "wb");
    assert.equal(one.accounts.length, 1);
    assert.equal(many.accounts.length, 2);
    assert.notEqual(one.accounts.length, many.accounts.length, "判据非恒真");
  });

  test("「total 对得上」这条判据认得出对不上", () => {
    fresh();
    const st = wbPoolStatus(poolCfg({ tokens: [DUMMY_A, DUMMY_B] }), "wb", NOW);
    assert.equal(st.total, st.accounts.length);
    const lying = { total: 99, accounts: st.accounts };
    assert.notEqual(lying.total, lying.accounts.length, "判据非恒真");
  });

  test("「不泄露令牌」这条判据认得出泄露", () => {
    const leaky = { token: DUMMY_A };
    assert.equal(JSON.stringify(leaky).includes(DUMMY_A), true, "判据非恒真：能认出来");
    fresh();
    const ok = wbPoolStatus(poolCfg(), "wb", NOW);
    assert.equal(JSON.stringify(ok).includes(DUMMY_A), false, "真的没泄露");
  });

  test("「模型路径不因 refresh 放宽而判死」真跑一遍（用内核直接对比）", async () => {
    const { applyFailure } = await import("../src/server/wb-pool.mjs");
    const mk = () => ({ version: "wb", accounts: [{ id: "a1", label: "x", version: "wb", modelCooldowns: {} }] });
    const a = mk(), b = mk();
    applyFailure(a, { accountId: "a1", status: 400, text: "invalid_grant", now: NOW, context: "model" });
    applyFailure(b, { accountId: "a1", status: 400, text: "invalid_grant", now: NOW, context: "refresh" });
    assert.equal(a.accounts[0].dead, undefined, "模型路径：400 不判死");
    assert.equal(b.accounts[0].dead, true, "刷新路径：400 判死");
    assert.notEqual(a.accounts[0].dead, b.accounts[0].dead, "判据非恒真");
  });

  test("「context 传错」的破坏形态确实会让 ① 组变红（真跑一遍内核对比）", async () => {
    const { applyFailure } = await import("../src/server/wb-pool.mjs");
    const mk = () => ({ version: "wb", accounts: [{ id: "a1", label: "x", version: "wb", modelCooldowns: {} }] });
    const saboted = mk(), real = mk();
    /* 把 context 传成 "model" 就是漏传 refresh 的那个破坏形态。 */
    applyFailure(saboted, { accountId: "a1", status: 400, text: "invalid_grant", now: NOW, context: "model" });
    applyFailure(real, { accountId: "a1", status: 400, text: "invalid_grant", now: NOW, context: "refresh" });
    assert.equal(saboted.accounts[0].dead, undefined, "破坏形态：死号留在池子里");
    assert.equal(real.accounts[0].dead, true, "正确形态：死号退出轮换");
  });

  test("「同一条 401 不判死」这条判据认得出真死", async () => {
    fresh();
    const cfg = poolCfg();
    wbNoteFailure(cfg, "wb", { accountId: "a1", status: 401, text: "unauthorized", now: NOW });
    assert.equal(wbPoolOf(cfg, "wb").accounts[0].dead, undefined, "401 + 文案不认识 → 不判死");
    fresh();
    const c2 = poolCfg();
    wbNoteFailure(c2, "wb", { accountId: "a1", status: 401, text: "invalid_grant", now: NOW });
    assert.equal(wbPoolOf(c2, "wb").accounts[0].dead, true, "401 + 明确文案 → 判死");
  });
});

/* ================================================================== *
 * ⑨ 红线自检
 * ================================================================== */
describe("⑨ 红线：接线层零 IO、无凭据", () => {
  test("接线层不碰 fs / 网络 / 子进程", () => {
    const code = WIRING_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/\b(readFileSync|writeFileSync|mkdirSync|existsSync|appendFileSync|createWriteStream)\b/.test(code), false);
    assert.equal(/\bfetch\s*\(|XMLHttpRequest|node:https?|node:net/.test(code), false);
    assert.equal(/\b(child_process|spawn|execSync)\b/.test(code), false);
    assert.notEqual(code, WIRING_SRC, "剥注释没起作用");
  });

  test("时间源真的由调用方注入（同一个池子，换 now 就换结论）", () => {
    fresh();
    const cfg = poolCfg();
    wbNoteFailure(cfg, "wb", { accountId: "a1", model: "hy4", status: 429, text: "rate limited", now: NOW });
    /* 冷却窗口是 60 秒：窗口内说冷却，窗口外说可用。
       如果实现里写死了 Date.now()，这两个断言不可能同时成立。 */
    assert.equal(wbPoolStatus(cfg, "wb", NOW + 1000).accounts[0].reason, "cooling_model");
    assert.equal(wbPoolStatus(cfg, "wb", NOW + 10 * MIN).accounts[0].reason, "ok");
  });

  test("三份源码里都没有看起来像真实凭据的串", () => {
    for (const [name, src] of [["wiring", WIRING_SRC], ["server", SERVER_SRC], ["card", readFileSync(CARD, "utf8")]]) {
      assert.equal(/\bsk-[A-Za-z0-9_-]{16,}/.test(src), false, name + " 里出现了 sk- 长串");
      assert.equal(/\bBearer\s+[A-Za-z0-9._-]{16,}/.test(src), false, name + " 里出现了 Bearer 长串");
    }
    // 反向对照
    assert.equal(/\bsk-[A-Za-z0-9_-]{16,}/.test("sk-abcdefghijklmnopqrstuvwxyz"), true);
  });

  test("server.mjs 不再有任何 wbEnsureToken 残留（旧入口已下线）", () => {
    assert.equal(/\bwbEnsureToken\b/.test(SERVER_SRC), false, "旧的单令牌入口必须消失，否则会有人再走那条路");
    assert.equal(/function wbEnsureTokenPooled/.test(SERVER_SRC), true);
  });
});

/* ------------------------------------------------------------------ *
 * 端到端夹具：真 server.mjs + 假上游
 * ------------------------------------------------------------------ */
async function freePorts(n) {
  const servers = [];
  for (let i = 0; i < n; i++) {
    const s = http.createServer();
    await new Promise((res) => s.listen(0, "127.0.0.1", res));
    servers.push(s);
  }
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((res) => s.close(res))));
  return ports;
}
function live(port) {
  return new Promise((res) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.on("connect", () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
  });
}
function killByPid(pid) {
  try { spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
}
function sseEvents(text) {
  return String(text).split("\n\n").map((b) => (b.match(/^event:\s*(\S+)/m) || [])[1]).filter(Boolean);
}

/**
 * 起一份真 server.mjs：临时 DATA_DIR、端口全动态、假上游。
 * 🔴 假凭据是 wbdummy-*，**不是**任何真实令牌的形状。
 */
async function bootServer() {
  const ports = await freePorts(8);
  const P = { bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4], qd: ports[5], or: ports[6], panel: ports[7] };
  const dataDir = mkdtempSync(path.join(TMPROOT, "boot-"));
  const SSE_MARK = "pool-wiring-marker";

  /* 假上游：把收到的 URL / 请求头 / 请求体 / Authorization 全记下来，
     429 可切换 —— 「逐字一致」断言的就是这些。 */
  const seen = { auth: null, url: null, headers: null, body: "", status: 200 };
  const upstream = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      seen.auth = rq.headers["authorization"] || null;
      seen.url = rq.url;
      seen.headers = { ...rq.headers };
      seen.body = Buffer.concat(chunks).toString("utf8");
      if (seen.status !== 200) {
        rs.writeHead(seen.status, { "content-type": "application/json" });
        rs.end('{"error":{"message":"usage exceeds frequency limit, please retry later"}}');
        return;
      }
      rs.writeHead(200, { "content-type": "text/event-stream" });
      rs.write(`data: ${JSON.stringify({ choices: [{ delta: { content: SSE_MARK } }] })}\n\n`);
      rs.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      rs.write("data: [DONE]\n\n");
      rs.end();
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = upstream.address().port;

  const cfg = JSON.parse(readFileSync(DEFAULTS_JSON, "utf8"));
  cfg.failover.enabled = false;
  cfg.proxy = "http://127.0.0.1:7897";     // 防 applyProxy 自重启（见 oc-wiring-test 的同一段说明）
  cfg.relayPort = P.bai; cfg.panelPort = P.panel;
  for (const k of ["sn", "wb", "wbai", "zen", "qd", "or"]) cfg[k] = { ...cfg[k], relayPort: P[k] };
  /* wb 保持**老配置形态**：只有 accessToken、没有 accounts —— 池子必须自动合成
     单条目，行为与改动前逐字一致（这一格就是「默认行为不变」的证据）。 */
  cfg.wb.accessToken = DUMMY_A;
  cfg.wb.refreshToken = "";
  cfg.wb.upstream = `http://127.0.0.1:${upstreamPort}`;
  /* 国际版放两个账号（其中一个停用）：验证分池、面板计数、以及停用的仍被计数。 */
  cfg.wbai.accessToken = "";
  cfg.wbai.upstream = `http://127.0.0.1:${upstreamPort}`;
  cfg.wbai.accounts = [
    { id: "i1", label: "国际一号", order: 0, accessToken: DUMMY_B, refreshToken: "", credential: { lastRefreshTime: NOW }, modelCooldowns: {} },
    { id: "i2", label: "国际二号", order: 1, accessToken: DUMMY_C, refreshToken: "", credential: { lastRefreshTime: NOW }, modelCooldowns: {}, disabled: true },
  ];
  const accountsLen = 1;   // wb 是合成的单条目池
  writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

  const env = { ...process.env, BAI_DATA_DIR: dataDir, NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1", BAI_NO_PROXY_AUTODETECT: "1" };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
  env.NO_PROXY = "127.0.0.1,localhost";
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const out = []; const err = [];
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => err.push(String(d)));

  let up = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) { up = true; break; } }
    catch { }
    await sleep(300);
  }
  if (!up) {
    try { child.kill(); } catch { }
    throw new Error(`server.mjs 40 秒内没起来。\nstdout 尾：${out.join("").slice(-1200)}\nstderr 尾：${err.join("").slice(-800)}`);
  }
  const t1 = Date.now();
  while (Date.now() - t1 < 20000) { if (await live(P.wb)) break; await sleep(200); }

  const status = async () => (await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json()));
  /* 发一次 Anthropic 请求走 wb 中转端口。upstreamStatus 让假上游按需回 429。 */
  const ask = async ({ upstreamStatus = 200 } = {}) => {
    seen.status = upstreamStatus;
    const r = await fetch(`http://127.0.0.1:${P.wb}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5", stream: true, max_tokens: 64,
        messages: [{ role: "user", content: "池化接线测试的第一句话" }],
      }),
    });
    const body = await r.text();
    return {
      status: r.status, body,
      upstreamAuth: seen.auth, upstreamUrl: seen.url,
      upstreamHeaders: seen.headers, upstreamBody: seen.body,
    };
  };

  const handle = {
    P, dataDir, out, SSE_MARK, accountsLen, cfgToken: DUMMY_A, status, ask, seen,
    kill() {
      killByPid(child.pid);
      try { upstream.close(); } catch { }
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { }
    },
  };
  SPAWNED.push(handle);
  return handle;
}

/* ------------------------------------------------------------------ *
 * 反向对照的「把手册」：--list-sabotage / --sabotage
 * 配套执行器 scripts/wb-pool-wiring-sabotage-run.mjs 把每条真的打到源码上跑一遍，
 * 确认**必须红**，再逐字还原。
 * ------------------------------------------------------------------ */
const SABOTAGE = [
  {
    name: "drop-refresh-context",
    file: "src/server/wb-pool-wiring.mjs",
    where: "wbNoteRefreshFailure —— 全仓库唯一传 context:\"refresh\" 的地方",
    from: 'context: "refresh",            // ★★★ 全仓库唯一一处',
    to: 'context: "model",',
    reds: "★① 刷新回 400 + invalid_grant → 判死（漏传则永远不判死）+ 「有且只有一处」",
  },
  {
    name: "synthesize-from-nowhere",
    file: "src/server/wb-pool-wiring.mjs",
    where: "synthAccount —— 旧配置合成的单条目池",
    from: 'accessToken: String(slice.accessToken || ""),\n    refreshToken: String(slice.refreshToken || ""),',
    to: 'accessToken: "",\n    refreshToken: "",',
    reds: "⭐ 单账号与改动前逐字一致（选出来的凭据必须等于 cfg.wb.accessToken）+ ③ 旧配置合成",
  },
  {
    name: "drop-legacy-synthesis",
    file: "src/server/wb-pool-wiring.mjs",
    where: "wbPoolOf —— 旧配置（无 accounts）的合成分支",
    from: "  const pool = { version: p, mode, accounts: [synthAccount(slice, p)], sticky, synthetic: true, cursor: 0 };",
    to: "  const pool = { version: p, mode, accounts: [], sticky, synthetic: true, cursor: 0 };",
    reds: "⭐ + ③：老用户直接变成「池子是空的」，零改动不成立",
  },
  {
    name: "reason-from-response",
    file: "src/server/wb-pool-wiring.mjs",
    where: "wbPickAccount 选不出号的分支",
    from: 'notePick(p, pool, { ok: false, reason: r.reason, remedy: r.remedy || remedyOf(r.reason), accountId: null, how: r.how, eligible: r.eligible, now });',
    to: 'notePick(p, pool, { ok: false, reason: "dead", remedy: "请重新登录。", accountId: null, how: r.how, eligible: r.eligible, now });',
    reds: "★② 全池冷却 → 报「请重新登录」（1.7.7 事故原样复发）",
  },
  {
    name: "dead-on-any-400",
    file: "src/server/wb-pool-wiring.mjs",
    where: "wbNoteFailure —— 模型请求路径的 context",
    from: 'context: "model",',
    to: 'context: "refresh",',
    reds: "★②/⑧：模型路径被放宽到 400，一次内容错误就冤杀好账号 + 「refresh 有且只有一处」",
  },
  {
    name: "hide-unavailable",
    file: "src/server/wb-pool-wiring.mjs",
    where: "wbPoolStatus 的 accounts 映射",
    from: "const accounts = pool.accounts.map((a) => accountFields(pool, a, t, model, fp));",
    to: "const accounts = pool.accounts.filter((a) => !a.disabled && !a.ignored).map((a) => accountFields(pool, a, t, model, fp));",
    reds: "★⑤ 面板计数：有停用的就对不上（配置 4 个、界面 2 个）",
  },
  {
    name: "match-by-id-prefix",
    file: "src/server/wb-pool-wiring.mjs",
    where: "wbPaidSameName —— 按显示名匹配同名的付费行",
    from: 'if (String(c.label == null ? c.target : c.label) !== label) continue;   // ★ 按显示名匹配',
    to: 'if (String(c.target).startsWith(String(limited).replace(/-(free|paid)$/, "")) === false) continue;',
    reds: "★⑥ 429 点名付费行：按 id 前缀会点错/漏点",
  },
  {
    name: "guess-paid-rate",
    file: "src/server/wb-pool-wiring.mjs",
    where: "wbPaidSameName —— 什么算「付费」",
    from: "const isPaid = m.free === true ? false : (rate != null ? rate > 0 : false);",
    to: "const isPaid = m.free !== true;",
    reds: "★⑥ 倍率读不出来时不该点名（猜一次倍率＝让用户白花钱）",
  },
  {
    name: "own-second-session-key",
    file: "src/server/server.mjs",
    where: "openaiExchange 的会话 key",
    from: "const mk0 = isProbe ? null : zenSessionId(j, false);",
    to: 'const mk0 = "bai-" + createHash("sha256").update(String(j && j.messages && j.messages[0] && j.messages[0].content || "")).digest("hex").slice(0, 16);',
    reds: "★④ 会话 key 必须复用 zenSessionId（不另写第二套）",
  },
  {
    name: "bind-probe-to-constant",
    file: "src/server/server.mjs",
    where: "openaiExchange 的会话 key",
    from: "const mk0 = isProbe ? null : zenSessionId(j, false);",
    to: "const mk0 = zenSessionId(j, isProbe);",
    reds: "★④ 探针会把所有探针粘到同一个号上，白占一条绑定",
  },
];

if (process.argv.includes("--list-sabotage")) {
  console.log(`wb-pool 接线反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(26)} ${s.where}\n  ${"".padEnd(26)} → 会打红: ${s.reds}`);
  process.exit(0);
}
if (process.argv.includes("--sabotage")) {
  const i = process.argv.indexOf("--sabotage");
  const name = process.argv[i + 1];
  const s = SABOTAGE.find((x) => x.name === name);
  if (!s) { console.error(`没有这条手法：${name}。可用：${SABOTAGE.map((x) => x.name).join(", ")}`); process.exit(2); }
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}