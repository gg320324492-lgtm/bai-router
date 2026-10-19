/**
 * scripts/mm-auth-test.mjs —— MiniMax 会员托管通道（渠道键 `mm`）的凭据与转发头
 *
 * ## 这条测试在钉什么
 *
 *   ① **续期轮换**：MiniMax 的 refresh token 是**一次性**的——刷新成功后旧的立即作废
 *      （invalid_grant: this refresh token can no longer be used, start a new authorization）。
 *      所以「刷新成功后必须立刻把返回的新 refresh_token 存进内存」不是洁癖，是**硬要求**：
 *      不存就等于把凭据链打断，下一次续期必然失败。
 *      → 断言的是**内存里的 refreshToken 变成了新返回的那一个**，而不只是"刷新成功了"。
 *
 *   ② **续期失败要如实报、且不重试刷**：invalid_grant 之后必须给出
 *      「MiniMax 登录态已失效，请在 MiniMax Code 里重新登录」这句话，
 *      而且**第二次调用不得再打网络**（否则就是拿上游当靶子刷）。
 *
 *   ③ **令牌不外泄**：这是本任务里最要紧的一条——用户是付了钱的会员，令牌泄漏的后果由他承担。
 *      断言覆盖三处：**落盘文件**（真的去扫文件内容）、**日志字符串**、**错误消息**。
 *      ⚠ 落盘那一条**不是**"看代码里有没有 writeFileSync"就完事——那只是间接证据。
 *        这里真的跑一遍完整生命周期，把期间**任何**被写下的文件内容读回来 grep 令牌值。
 *
 *   ④ **转发头正确**：上游同时校验 Bearer 令牌 / 完整 MiniMaxAgent UA / Origin / Referer，
 *      实测过 7 种组合，只有这一全套返回 200（`token` 头、无 UA、无 Origin 的变体全部 401）。
 *      断言既查"该有的头都在"，也查"客户端送来的同名头一律作废"。
 *
 *   ⑤ **接线完整性**：断言 server.mjs 真的 import 了 mm-auth.mjs、真的把 mm 挂进
 *      渠道表、真的把 prepareHeaders 接到中转上——否则就是"模块测得挺好、线上没接"。
 *      （wb-token-test.mjs 的教训：判据被替身顶替，等于没有判据。）
 *
 *   ④b **工具定义形状转换**：MiniMax 托管端点只认**扁平**形状的工具定义
 *      （`{type:"function", name, description, input_schema}`），
 *      而 Claude Code 发的是 Anthropic 的**嵌套**形状（`{type:"function", function:{name,…}}`）。
 *      原样透传 → 上游 400「invalid params, function name is empty (2013)」。
 *      ⚠ 极具误导性：没有工具的请求一切正常，一带工具整条对话就断。
 *      所以除了测转换函数本身，还要测**它确实被挂到了中转上**。
 *
 * ## 反向对照
 *
 *   本文件没有配套 sabotage 执行器（红线限定只许新增这一个脚本）。反向验证靠手工回退：
 *   把 src/server/mm-auth.mjs 里对应的地方改回改前行为，下面 ①②③④ 里对应的断言当场红。
 *   逐条锚点见文末「反向对照锚点」一节。判据只有一个：**改回去必须红**。
 *
 * ## 红线
 *
 *   🔴 全文没有一个真实令牌 / API key / 用户名 / 本机绝对路径。
 *      夹具全是现造的假值（fake-access-token-… / fake-refresh-token-…）。
 *   🔴 本文件**不读真实的 ~/.minimax/auth/...**：登录态一律用注入的假 readAuth 造。
 *   🔴 本文件**零网络**：fetch 是注入的假实现，一个真实请求都不发。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

import {
  createMmTokenStore, mmBuildHeaders, mmAuthFilePath, readMmAuthRecord, mmCanonicalModel,
  mmNormalizeTools, mmNormalizeBodyTools,
  MM_TOKEN_ENDPOINT, MM_INFER_BASE, MM_MODEL, MM_CLIENT_ID, MM_SCOPE, MM_AUDIENCE,
  MM_ORIGIN, MM_REFERER, MM_USER_AGENT, MM_PLACEHOLDER_KEY, MM_LOGIN_INVALID_MSG,
} from "../src/server/mm-auth.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER_SRC = readFileSync(path.join(REPO, "src", "server", "server.mjs"), "utf8");
const MM_AUTH_SRC = readFileSync(path.join(REPO, "src", "server", "mm-auth.mjs"), "utf8");
const PROVIDERS_SRC = readFileSync(path.join(REPO, "src", "server", "providers.js"), "utf8");

/* ====================================================================== *
 * 夹具：全是假值。🔴 没有任何一个是真的。
 * ====================================================================== */

const OLD_ACCESS = "fake-access-token-old-0001";
const OLD_REFRESH = "fake-refresh-token-old-0001";
const NEW_ACCESS = "fake-access-token-new-0002";
const NEW_REFRESH = "fake-refresh-token-new-0002";
/** 假登录态记录（注入用，不碰真实文件）。 */
const fakeRecord = (over = {}) => ({
  accessToken: OLD_ACCESS,
  refreshToken: OLD_REFRESH,
  expiresAtMs: 0,
  clientId: MM_CLIENT_ID,
  scopes: MM_SCOPE,
  audience: MM_AUDIENCE,
  recordKey: "fake-account-key-0",
  ...over,
});

/** 造一个假的 fetch：记录每次调用，按脚本返回（responder 可以是 async）。 */
function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = await responder(calls.length, url, init);
    if (typeof r === "string") throw new Error(r);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      async text() { return typeof r.body === "string" ? r.body : JSON.stringify(r.body || {}); },
    };
  };
  fn.calls = calls;
  return fn;
}

/** 把仓库摆成「已从登录态读到了凭据」的样子（与启动时那次读取等价）。 */
function seedLoaded(store, over = {}) {
  const rec = fakeRecord(over);
  store.state.loaded = true;
  store.state.accessToken = rec.accessToken;
  store.state.refreshToken = rec.refreshToken;
  store.state.expiresAtMs = rec.expiresAtMs;
  store.state.recordKey = rec.recordKey;
  return store;
}

/** 令牌仓库的默认装配：假 readAuth（不读真实文件）+ 可注入的 fetch + 假 now。 */
function makeStore({ fetchImpl, readAuth, now, log } = {}) {
  const logs = [];
  const store = createMmTokenStore({
    fetchImpl: fetchImpl || fakeFetch(() => ({ status: 200, body: {} })),
    readAuth: readAuth || (() => fakeRecord()),
    now: now || (() => Date.now()),
    authPath: path.join(os.tmpdir(), "mm-auth-test-not-real", "auth.json"),
    log: log || ((m) => logs.push(String(m))),
  });
  store.logs = logs;
  return store;
}

/* ====================================================================== *
 * ① 续期轮换
 * ====================================================================== */

describe("mm 续期轮换", () => {
  test("刷新成功后，内存里的 refresh token 必须变成新返回的那一个", async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600, token_type: "Bearer" },
    }));
    const store = makeStore({ fetchImpl });
    /* 令牌已过期 → ensure() 必须走续期。 */
    seedLoaded(store);
    store.state.expiresAtMs = Date.now() - 1000;

    const tok = await store.ensure();

    assert.equal(tok, NEW_ACCESS, "ensure() 必须返回新的访问令牌");
    assert.equal(store.state.accessToken, NEW_ACCESS, "内存里的访问令牌必须换成新的");
    /* 🔴 这条是本组的核心断言：旧 refresh token 已被上游作废，
       内存里若还留着旧的，下一次续期必然 invalid_grant。 */
    assert.equal(store.state.refreshToken, NEW_REFRESH, "内存里的 refresh token 必须轮换成新返回的那一个");
    assert.notEqual(store.state.refreshToken, OLD_REFRESH, "旧的 refresh token 不许还留在内存里");
  });

  test("续期请求的形状：form-urlencoded + 四个 OAuth 参数齐全", async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600 },
    }));
    const store = makeStore({ fetchImpl });
    seedLoaded(store);
    store.state.expiresAtMs = Date.now() - 1000;

    await store.ensure();

    assert.equal(fetchImpl.calls.length, 1, "过期后必须打且只打一次续期请求");
    const call = fetchImpl.calls[0];
    assert.equal(call.url, MM_TOKEN_ENDPOINT, "续期端点必须是 account.minimax.cn 的 oauth2/token");
    assert.equal(call.init.method, "POST");
    assert.equal(String(call.init.headers["content-type"]), "application/x-www-form-urlencoded",
      "续期请求必须是 form-urlencoded");
    const body = new URLSearchParams(String(call.init.body));
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("client_id"), "mcode-public");
    assert.equal(body.get("scope"), "agent.default");
    assert.equal(body.get("audience"), "agent-backend");
    assert.equal(body.get("refresh_token"), OLD_REFRESH, "请求体里带的是当时内存里那把刷新令牌");
  });

  test("还够用的令牌不续期（不白打上游）", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: {} }));
    const store = makeStore({ fetchImpl });
    seedLoaded(store);
    store.state.expiresAtMs = Date.now() + 30 * 60 * 1000;   // 还有 30 分钟

    const tok = await store.ensure();
    assert.equal(tok, OLD_ACCESS);
    assert.equal(fetchImpl.calls.length, 0, "令牌还新鲜就不该打续期端点");
  });

  test("并发请求只打一次续期（refresh token 是一次性的，并发会打死自己）", async () => {
    let n = 0;
    const fetchImpl = fakeFetch(async () => {
      n++;
      await new Promise((r) => setTimeout(r, 20));
      return { status: 200, body: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600 } };
    });
    const store = makeStore({ fetchImpl });
    seedLoaded(store);
    store.state.expiresAtMs = Date.now() - 1000;

    const all = await Promise.all([store.ensure(), store.ensure(), store.ensure()]);
    assert.equal(n, 1, "同一时刻只允许一次续期在飞");
    assert.deepEqual(new Set(all), new Set([NEW_ACCESS]));
  });
});

/* ====================================================================== *
 * ② 续期失败：如实报 + 不重试刷
 * ====================================================================== */

describe("mm 续期失败", () => {
  test("invalid_grant → 如实报「登录态已失效」，且不再重试", async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "this refresh token can no longer be used, start a new authorization",
      },
    }));
    const store = makeStore({ fetchImpl });
    seedLoaded(store);
    store.state.expiresAtMs = Date.now() - 1000;

    await assert.rejects(() => store.ensure(), (e) => {
      assert.match(String(e && e.message), /登录态已失效/,
        "失败原因必须说清是登录态没了（处置是重新登录，不是等一等）");
      assert.ok(String(e && e.message).includes(MM_LOGIN_INVALID_MSG),
        "错误消息必须用统一的那句话");
      assert.ok(!String(e && e.message).includes(OLD_REFRESH), "错误消息里不许带令牌值");
      assert.ok(!String(e && e.message).includes(OLD_ACCESS), "错误消息里不许带令牌值");
      return true;
    });

    /* 🔴 不重试刷：第二次调用**不得**再打网络。 */
    const callsAfterFirst = fetchImpl.calls.length;
    await assert.rejects(() => store.ensure(), /登录态已失效/);
    assert.equal(fetchImpl.calls.length, callsAfterFirst,
      "invalid_grant 之后不得反复打续期端点（那是拿上游当靶子刷）");

    const snap = store.snapshot();
    assert.equal(snap.invalid, true, "状态快照要标出登录态已失效");
    assert.equal(snap.configured, false, "失效之后不算「已配置」");
  });

  test("网络失败（临时性）走冷却，不立刻连打", async () => {
    const fetchImpl = fakeFetch(() => "boom-network");
    const store = makeStore({ fetchImpl });
    seedLoaded(store);
    store.state.expiresAtMs = Date.now() - 1000;

    await assert.rejects(() => store.ensure(), /续期请求失败/);
    const calls = fetchImpl.calls.length;
    await assert.rejects(() => store.ensure(), /刚刚失败过/);
    assert.equal(fetchImpl.calls.length, calls, "冷却期内不得再打续期端点");
  });
});

/* ====================================================================== *
 * ③ 令牌不外泄
 * ====================================================================== */

describe("mm 令牌不外泄", () => {
  const require_ = createRequire(import.meta.url);
  let fsMod = null;
  let writes = [];
  const orig = {};

  beforeEach(() => {
    fsMod = require_("node:fs");
    writes = [];
    for (const k of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync",
      "renameSync", "copyFileSync", "createWriteStream", "writeFile", "appendFile", "mkdir", "rm"]) {
      orig[k] = fsMod[k];
      if (typeof orig[k] !== "function") continue;
      fsMod[k] = function patched(...args) {
        writes.push({ api: k, args: args.map((a) => (typeof a === "string" ? a : (a && a.toString ? a.toString() : String(a)))) });
        return orig[k].apply(fsMod, args);
      };
    }
  });

  afterEach(() => {
    for (const k of Object.keys(orig)) {
      if (orig[k] === undefined) continue;
      try { fsMod[k] = orig[k]; } catch { }
    }
  });

  test("完整生命周期里：没有令牌值落进任何文件、日志或错误消息", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mm-auth-leak-"));
    const authFile = path.join(dir, "auth.json");

    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600 },
    }));
    const logs = [];
    const store = makeStore({
      fetchImpl,
      log: (m) => logs.push(String(m)),
      readAuth: () => fakeRecord(),
    });

    /* 走一遍完整生命周期：读登录态 → 过期 → 续期（轮换）→ 再读快照 → 再续期。 */
    store.readAuthFile();
    store.state.expiresAtMs = Date.now() - 1000;
    await store.ensure();
    const snap = store.snapshot();
    store.state.expiresAtMs = Date.now() - 1000;
    await store.ensure();

    /* ②b 失败路径也要走一遍：**错误消息**是最容易漏出令牌的地方——
     *    失败文案通常是「把上游回的话原样转述」，而上游偶尔会把凭据带在回包里。
     *    所以这里让续期返回一个**带令牌串**的失败响应，断言它被洗掉。 */
    const leakyFetch = fakeFetch(() => ({
      status: 500,
      body: { error: "server_error", error_description: "failed for token " + OLD_REFRESH },
    }));
    const leakyStore = makeStore({ fetchImpl: leakyFetch, log: (m) => logs.push(String(m)) });
    leakyStore.state.loaded = true;
    leakyStore.state.accessToken = OLD_ACCESS;
    leakyStore.state.refreshToken = OLD_REFRESH;
    leakyStore.state.expiresAtMs = Date.now() - 1000;
    let errMsg = "";
    try { await leakyStore.ensure(); } catch (e) { errMsg = String((e && e.message) || e); }
    assert.ok(errMsg, "失败路径必须真的失败（否则这条断言是空转）");
    assert.ok(!errMsg.includes(OLD_REFRESH), "错误消息里出现了刷新令牌");
    assert.ok(!errMsg.includes(OLD_ACCESS), "错误消息里出现了访问令牌");
    assert.ok(!String(leakyStore.snapshot().error || "").includes(OLD_REFRESH),
      "状态快照的 error 字段里出现了刷新令牌");

    /* ① 落盘文件：把期间写下的每个文件内容读回来 grep。 */
    for (const w of writes) {
      const text = w.args.join(" ");
      assert.ok(!text.includes(NEW_ACCESS), `fs.${w.api} 写下的内容里出现了访问令牌`);
      assert.ok(!text.includes(NEW_REFRESH), `fs.${w.api} 写下的内容里出现了刷新令牌`);
      assert.ok(!text.includes(OLD_ACCESS), `fs.${w.api} 写下的内容里出现了访问令牌`);
      assert.ok(!text.includes(OLD_REFRESH), `fs.${w.api} 写下的内容里出现了刷新令牌`);
    }
    /* 目录里一个文件都不该多出来（凭据只存内存）。 */
    const files = readdirSync(dir);
    for (const f of files) {
      const p = path.join(dir, f);
      if (!statSync(p).isFile()) continue;
      const text = readFileSync(p, "utf8");
      assert.ok(!text.includes(NEW_ACCESS) && !text.includes(NEW_REFRESH)
        && !text.includes(OLD_ACCESS) && !text.includes(OLD_REFRESH),
        `文件 ${f} 里出现了令牌值`);
    }

    /* ② 日志字符串 */
    for (const l of logs) {
      assert.ok(!l.includes(NEW_ACCESS), "日志里出现了访问令牌");
      assert.ok(!l.includes(NEW_REFRESH), "日志里出现了刷新令牌");
      assert.ok(!l.includes(OLD_ACCESS), "日志里出现了访问令牌");
      assert.ok(!l.includes(OLD_REFRESH), "日志里出现了刷新令牌");
    }

    /* ③ 状态快照（它会原样进 /api/status 交给面板） */
    const snapText = JSON.stringify(snap);
    assert.ok(!snapText.includes(NEW_ACCESS), "状态快照里出现了访问令牌");
    assert.ok(!snapText.includes(NEW_REFRESH), "状态快照里出现了刷新令牌");
    assert.ok(!snapText.includes(OLD_ACCESS), "状态快照里出现了访问令牌");
    assert.ok(!snapText.includes(OLD_REFRESH), "状态快照里出现了刷新令牌");
    assert.equal(snap.accessLen, NEW_ACCESS.length, "快照里只许有令牌**长度**");

    /* ④ 源文件里根本没有写盘 API（机械检查，不靠肉眼）。 */
    for (const api of ["writeFileSync", "appendFileSync", "createWriteStream", "mkdirSync",
      "rmSync", "unlinkSync", "renameSync", "copyFileSync"]) {
      assert.ok(!new RegExp(`\\b${api}\\b`).test(MM_AUTH_SRC),
        `mm-auth.mjs 里出现了写盘 API ${api} —— 凭据只存内存，不许落盘`);
    }
    void authFile;
  });

  test("读登录态的函数本身不写盘、也不把令牌吐进异常消息", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mm-auth-read-"));
    /* 指向一个不存在的文件：应当安静地返回 null（读不到 = 没登录），不抛异常。 */
    const rec = readMmAuthRecord(path.join(dir, "nope.json"));
    assert.equal(rec, null, "读不到登录态时返回 null，不是抛异常");
  });
});

/* ====================================================================== *
 * ④ 转发头
 * ====================================================================== */

describe("mm 转发头", () => {
  test("该有的头都在：Bearer + 完整 UA + Origin + Referer + x-api-key", () => {
    const h = mmBuildHeaders(NEW_ACCESS, {});
    assert.equal(h["authorization"], "Bearer " + NEW_ACCESS, "鉴权走 Authorization: Bearer");
    assert.equal(h["x-api-key"], MM_PLACEHOLDER_KEY, "x-api-key 是占位符 sk-xxx");
    assert.equal(h["x-api-key"], "sk-xxx");
    assert.equal(h["origin"], MM_ORIGIN);
    assert.equal(h["referer"], MM_REFERER);
    assert.equal(h["user-agent"], MM_USER_AGENT);
    assert.ok(h["user-agent"].startsWith("MiniMaxAgent "), "UA 必须是 MiniMaxAgent 形态");
    assert.ok(h["user-agent"].includes("Chrome/148.0.7778.280"), "UA 里要带真实浏览器版本");
    assert.equal(h["anthropic-version"], "2023-06-01");
    assert.equal(h["content-type"], "application/json");
  });

  test("客户端送来的同名头一律作废（上游只认我们这套）", () => {
    const clientHeaders = {
      "authorization": "Bearer client-supplied-token",
      "x-api-key": "sk-client-supplied",
      "user-agent": "claude-cli/1.0",
      "origin": "https://not-minimax.example",
      "referer": "https://not-minimax.example/",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    const h = mmBuildHeaders(NEW_ACCESS, clientHeaders);
    const flat = JSON.stringify(h);
    assert.ok(!flat.includes("client-supplied-token"), "客户端的 authorization 必须被覆盖");
    assert.ok(!flat.includes("sk-client-supplied"), "客户端的 x-api-key 必须被覆盖");
    assert.ok(!flat.includes("claude-cli/1.0"), "客户端的 user-agent 必须被覆盖");
    assert.ok(!flat.includes("not-minimax.example"), "客户端的 origin/referer 必须被覆盖");
    assert.equal(h["authorization"], "Bearer " + NEW_ACCESS);
    assert.equal(h["x-api-key"], "sk-xxx");
    assert.equal(h["user-agent"], MM_USER_AGENT);
    assert.equal(h["origin"], MM_ORIGIN);
    assert.equal(h["referer"], MM_REFERER);
  });

  test("协议头照旧透传（anthropic-beta / accept）", () => {
    const h = mmBuildHeaders(NEW_ACCESS, { "anthropic-beta": "fake-beta-1", "accept": "text/event-stream" });
    assert.equal(h["anthropic-beta"], "fake-beta-1");
    assert.equal(h["accept"], "text/event-stream");
  });
});

/* ====================================================================== *
 * ④b 工具定义形状转换（v1.0.89 · 真机实测发现的坑）
 *
 *   MiniMax 托管端点虽然讲 Anthropic 协议，但**工具定义要的是扁平形状**：
 *       { "type":"function", "name":"Read", "description":…, "input_schema":{…} }
 *   而 Claude Code 发的是 Anthropic 的**嵌套**形状：
 *       { "type":"function", "function":{ "name":"Read", … } }
 *
 *   原样透传嵌套形状 → 上游回 400
 *     "invalid params, function name is empty (2013)"
 *   实测：嵌套 → 400；扁平 → 200；扁平 + 顶层 type:function → 200。
 *
 *   ⚠ 这个错**极具误导性**：没有工具的请求一切正常（上游没东西可挑），
 *     一带工具就整条对话失败；而 400 的正文常常是空的，面板上更看不出来。
 * ====================================================================== */

describe("mm 工具定义形状转换", () => {
  const SCHEMA = { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] };
  const NESTED = [{ type: "function", function: { name: "Read", description: "读文件", input_schema: SCHEMA } }];

  test("嵌套形状 → 扁平形状（name/description/input_schema 提到顶层）", () => {
    const out = mmNormalizeTools(NESTED);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "Read", "name 必须被提到顶层——上游就认这个（2013 function name is empty）");
    assert.equal(out[0].description, "读文件");
    assert.deepEqual(out[0].input_schema, SCHEMA);
    assert.equal(out[0].function, undefined, "嵌套的 function 包装必须去掉");
    assert.equal(out[0].type, "function", "顶层 type 保留（上游认）");
  });

  test("本来就是扁平的 → 原样保留（用户可能自己填了扁平形状）", () => {
    const flat = [{ type: "function", name: "Read", description: "d", input_schema: SCHEMA }];
    assert.deepEqual(mmNormalizeTools(flat), flat, "已经是扁平的不许被改写");
  });

  test("认不出形状的条目原样返回（不猜）", () => {
    const weird = [
      { type: "function" },                                    // 没有 function 也没有 name
      { type: "function", function: { description: "没名字" } }, // function 里没有 name
      null,
      "not-an-object",
    ];
    assert.deepEqual(mmNormalizeTools(weird), weird, "形状不认识的条目不许被瞎改");
  });

  test("非数组的 tools 原样返回", () => {
    assert.equal(mmNormalizeTools(null), null);
    assert.equal(mmNormalizeTools(undefined), undefined);
    assert.equal(mmNormalizeTools("x"), "x");
  });

  test("mmNormalizeBodyTools：body 里的 tools 被换成扁平的", () => {
    const body = Buffer.from(JSON.stringify({ model: "MiniMax-M3.1-Flash", messages: [], tools: NESTED }));
    const out = JSON.parse(mmNormalizeBodyTools(body).toString("utf8"));
    assert.equal(out.tools[0].name, "Read");
    assert.equal(out.tools[0].function, undefined);
    assert.equal(out.model, "MiniMax-M3.1-Flash", "别的字段不许被动");
  });

  test("mmNormalizeBodyTools：没有 tools / body 非法 / body 为空 → 原样返回", () => {
    const noTools = Buffer.from(JSON.stringify({ model: "x", messages: [] }));
    assert.equal(mmNormalizeBodyTools(noTools).toString("utf8"), noTools.toString("utf8"),
      "没有 tools 就不该动 body");
    const bad = Buffer.from("not json");
    assert.equal(mmNormalizeBodyTools(bad).toString("utf8"), "not json", "body 不是 JSON 就原样");
    assert.equal(mmNormalizeBodyTools(Buffer.alloc(0)).length, 0, "空 body 原样");
    assert.equal(mmNormalizeBodyTools(null), null);
  });

  test("★ 接线：mm 渠道必须挂上 prepareBody（否则带工具的请求全被 400）", () => {
    /* ⚠ 必须**两处注册点分别**断言。
     *   只断言「文件里出现过 prepareBody: mmPrepareBody」是不够的——
     *   删掉其中一处，另一处还在，正则会照样匹配上，测试假绿。
     *   （这正是 wb-token-test.mjs 的老教训：判据被替身顶替，等于没有判据。） */
    const chLine = SERVER_SRC.match(/^\s*mm:\s*\["MiniMax[^\n]*$/m);
    assert.ok(chLine, "渠道表里必须有 mm 那一行");
    assert.match(chLine[0], /prepareBody:\s*mmPrepareBody/,
      "渠道表的 mm 那一行必须挂 prepareBody —— 少了它，带工具的请求会被上游 400 拒掉");

    const mk = SERVER_SRC.match(/makeRelay\(\s*"mm"[\s\S]*?\);/);
    assert.ok(mk, "必须有 makeRelay(\"mm\", …) 这一次调用");
    assert.match(mk[0], /prepareBody:\s*mmPrepareBody/,
      "makeRelay(\"mm\", …) 的 opts 里必须挂 prepareBody");

    assert.match(SERVER_SRC, /function mmPrepareBody\(/,
      "必须有 mmPrepareBody 这个函数");
    assert.match(SERVER_SRC, /body = fo\.opts\.prepareBody\(/,
      "handleUpstream 必须在发出去之前调用 prepareBody 改写 body");
  });
});

/* ====================================================================== *
 * ⑤ 接线完整性（server.mjs / 清单 / 种子配置）
 * ====================================================================== */

describe("mm 接线完整性", () => {
  test("server.mjs 真的 import 了 mm-auth.mjs 并把它接进中转", () => {
    assert.match(SERVER_SRC, /from "\.\/mm-auth\.mjs"/, "server.mjs 必须 import mm-auth.mjs");
    assert.match(SERVER_SRC, /createMmTokenStore\(/, "server.mjs 必须建一个令牌仓库");
    assert.match(SERVER_SRC, /prepareHeaders:\s*mmPrepareHeaders/, "中转必须挂上 prepareHeaders 钩子");
    assert.match(SERVER_SRC, /async function mmPrepareHeaders/, "必须有 mmPrepareHeaders");
    assert.match(SERVER_SRC, /mmTokens\.ensure\(\)/, "prepareHeaders 必须走令牌仓库（而不是自己拼）");
    assert.match(SERVER_SRC, /mmBuildHeaders\(/, "prepareHeaders 必须用 mmBuildHeaders 造头");
  });

  test("mm 在渠道表里，且在 or 之前（or 是永远排最后的兜底位）", () => {
    const m = SERVER_SRC.match(/const CHANNELS = \[([^\]]+)\]/);
    assert.ok(m, "CHANNELS 常量得找得到");
    const list = m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    assert.ok(list.includes("mm"), "CHANNELS 里必须有 mm");
    assert.ok(list.indexOf("mm") < list.indexOf("or"), "mm 必须排在 or 之前");
    assert.ok(list.indexOf("mm") > list.indexOf("wbai"), "mm 排在 wbai 之后（不破坏既有顺序）");
  });

  test("上游地址与模型对得上（拼出来必须是 .../llm/v1/messages）", () => {
    const defaults = JSON.parse(readFileSync(path.join(REPO, "src", "server", "config.defaults.json"), "utf8"));
    assert.equal(defaults.mm.upstream, MM_INFER_BASE);
    /* server.mjs 的 DEFAULTS.mm.upstream 是**中转真正用的那个**（seed 只在 config.json
     * 不存在时兜底）。两处必须一致——不一致的话，seed 里的那套是对的、中转发的却是错的，
     * 而面板完全看不出来（目录与映射都照 seed 显示）。 */
    assert.match(SERVER_SRC, /upstream:\s*MM_INFER_BASE\s*,/,
      "server.mjs 的 DEFAULTS.mm.upstream 必须**正好**是 MM_INFER_BASE（多一段 /v1 就会打到错端点）");
    assert.match(SERVER_SRC, /defaultModel:\s*MM_MODEL\s*,/, "server.mjs 的 DEFAULTS.mm.defaultModel 必须是 MM_MODEL");
    assert.equal(defaults.mm.upstream + "/v1/messages",
      "https://agent.minimax.cn/mavis/api/v1/llm/v1/messages",
      "中转拼 upstream + req.url 必须正好是官方那个端点（不能多一层 /v1）");
    assert.equal(defaults.mm.defaultModel, MM_MODEL);
    assert.deepEqual(defaults.mm.availableModels, [MM_MODEL]);
    /* 转移链：mm 在 or 之前。 */
    const chain = defaults.failover.chain;
    assert.ok(chain.includes("mm"), "出厂转移链里必须有 mm");
    assert.ok(chain.indexOf("mm") < chain.indexOf("or"), "出厂转移链里 mm 必须在 or 之前");
    /* 种子配置里不许有凭据字段（令牌只存内存）。 */
    const mmBlock = JSON.stringify(defaults.mm);
    assert.ok(!/accessToken|refreshToken|"token"/.test(mmBlock), "种子配置里不许出现任何令牌字段");
  });

  test("清单里有 mm，且四条必写的事实都在", () => {
    /* 清单是纯数据，用 vm 求值（与 check-manifest 同一手法）。 */
    const sandbox = { window: {} };
    runInNewContext(readFileSync(path.join(REPO, "src", "server", "providers.js"), "utf8"), sandbox);
    const P = sandbox.window.BAI_PROVIDERS && sandbox.window.BAI_PROVIDERS.mm;
    assert.ok(P, "清单里必须有 mm 这一条");
    assert.equal(P.key, "mm");
    assert.equal(P.path, "/mm");
    assert.equal(P.chainable, true);
    assert.equal(P.letter, "MM");
    assert.ok(P.models.includes(MM_MODEL), "清单的 models 要与种子配置一致");
    assert.ok(P.credentialReadonly && P.credentialReadonly.api, "mm 的凭据是自取型：要声明 credentialReadonly");
    assert.ok(P.memberQuota === true, "mm 要声明 memberQuota（会员额度卡据此认领）");
    const text = [P.tagline, P.conclusion, P.remedy, P.caveat].join("\n");
    assert.match(text, /会员额度/, "要说清走的是会员额度");
    assert.match(text, /开放平台/, "要说清与开放平台按量计费是两回事");
    assert.match(text, /MiniMax Code/, "要说清凭据来自 MiniMax Code 的登录态");
    assert.match(text, /只存在内存|只在内存/, "要说清令牌只存在内存");
    assert.match(text, /指纹/, "要说清上游做客户端指纹校验");
  });

  test("面板的只读凭据行与卡片都在（渲染层那一侧）", () => {
    const commonSrc = readFileSync(path.join(REPO, "src", "server", "panel-common.js"), "utf8");
    assert.match(commonSrc, /credentialReadonly/, "panel-common.js 要认 credentialReadonly（画只读凭据行）");
    assert.match(commonSrc, /data-act="reread"/, "只读凭据行要给「重新读取」动作");
    const cardSrc = readFileSync(path.join(REPO, "src", "server", "cards", "mm-member.js"), "utf8");
    assert.match(cardSrc, /memberQuota/, "会员额度卡要按清单声明认领");
    assert.match(PROVIDERS_SRC, /"mm-member"/, "视图表里要挂上 mm-member 卡");
  });
});

/* ====================================================================== *
 * ⑥ 卡片文案（面板上最终显示什么）
 * ====================================================================== */

describe("mm 会员额度卡", () => {
  /** 在 vm 里求值卡片（它只往 window.BAI_CARDS 上挂东西，不碰 DOM）。 */
  function loadCard() {
    const sandbox = { window: {} };
    runInNewContext(readFileSync(path.join(REPO, "src", "server", "cards", "mm-member.js"), "utf8"), sandbox);
    return sandbox.window.BAI_CARDS["mm-member"];
  }

  test("四条必写的事实都在卡片的输出里", () => {
    const card = loadCard();
    const html = card.renderMemberPanel(
      { configured: true, invalid: false, autoRenew: true, expiresInSec: 1800, renewCount: 2, accessLen: 60 },
      { name: "MiniMax 会员", hint: "令牌只在内存里", upstream: "agent.minimax.cn" },
    );
    assert.match(html, /会员额度/, "① 要写明这是会员额度");
    assert.match(html, /不是.*开放平台按量计费|不是<\/b>开放平台/, "① 要写明与开放平台按量计费是两回事");
    assert.match(html, /MiniMax Code/, "② 要写明要先在 MiniMax Code 里登录");
    assert.match(html, /登录态/, "② 要写明凭据来自它的登录态");
    assert.match(html, /只在内存|只存在内存/, "③ 要写明令牌只存在内存");
    assert.match(html, /重启/, "③ 要写明重启路由台要重新读");
    assert.match(html, /指纹/, "④ 要写明上游做客户端指纹校验");
    assert.match(html, /UA \/ Origin \/ Referer|UA、Origin、Referer/, "④ 要写明我们已经带上了正确的头");
  });

  test("登录态失效时，卡片报红并把该做什么说清楚", () => {
    const card = loadCard();
    const html = card.renderMemberPanel({ configured: false, invalid: true, error: MM_LOGIN_INVALID_MSG }, { name: "MiniMax 会员" });
    assert.match(html, /登录态已失效/);
    assert.match(html, /MiniMax Code/);
  });

  test("清单没声明 memberQuota 的渠道不画这张卡", () => {
    const card = loadCard();
    assert.equal(card.shouldShow({ memberQuota: true }), true);
    assert.equal(card.shouldShow({}), false);
    assert.equal(card.shouldShow(null), false);
  });
});

/* ====================================================================== *
 * ⑦ 模型 id 的大小写（上游 id 大小写敏感，而面板保存映射时会转小写）
 * ====================================================================== */

describe("mm 模型 id 大小写", () => {
  test("认得出来的 id 一律还原成上游的官方写法", () => {
    assert.equal(mmCanonicalModel("MiniMax-M3.1-Flash"), "MiniMax-M3.1-Flash");
    assert.equal(mmCanonicalModel("minimax-m3.1-flash"), "MiniMax-M3.1-Flash",
      "面板保存映射时转的小写必须被还原——否则发出去的名字被改了");
    assert.equal(mmCanonicalModel("  minimax-m3.1-flash  "), "MiniMax-M3.1-Flash");
  });

  test("认不出来的（用户自己填的）原样返回", () => {
    assert.equal(mmCanonicalModel("some-custom-model"), "some-custom-model");
    assert.equal(mmCanonicalModel(""), "");
    assert.equal(mmCanonicalModel(null), "");
  });

  test("保存映射的路径上确实走了归一（不许只在下拉里好看）", () => {
    assert.match(SERVER_SRC, /P === "mm" \? mmCanonicalModel\(/,
      "/api/config 存映射目标时必须走 mmCanonicalModel");
    assert.match(SERVER_SRC, /mmCanonicalModel\(b\.defaultModel\)/,
      "/api/config 存默认模型时必须走 mmCanonicalModel");
    assert.match(SERVER_SRC, /k === "mm" \? mmCanonicalModel\(x\)/,
      "批量刷新模型列表时 mm 也必须走 mmCanonicalModel");
  });
});

/* ====================================================================== *
 * 反向对照锚点
 *
 *   手工回退下列任意一处，下面对应的断言必须当场红：
 *
 *   ① 轮换（mm-auth.mjs）
 *      把 `if (j.refresh_token && typeof j.refresh_token === "string" && j.refresh_token.trim()) {
 *         st.refreshToken = j.refresh_token.trim();
 *       }` 整段删掉 → 「① 续期轮换」组的
 *      `assert.equal(store.state.refreshToken, NEW_REFRESH)` 红。
 *
 *   ② 不重试（mm-auth.mjs）
 *      把 `st.invalid = true;` 删掉 → 「② 续期失败」组的
 *      `assert.equal(fetchImpl.calls.length, callsAfterFirst)` 红（会一直打网络）。
 *
 *   ③ 不外泄（mm-auth.mjs）
 *      把 `const at = j && j.access_token;` 改成把 access_token 塞进 st.error
 *      （例如 `st.error = "token=" + at`）→ 「③ 令牌不外泄」组的
 *      日志/快照断言红。
 *      或：在 mm-auth.mjs 里加一句 `writeFileSync(authPath, JSON.stringify(st))` →
 *      「③ 令牌不外泄」组的「fs 写下的内容」与「源文件里没有写盘 API」两条同时红。
 *
 *   ④ 头（mm-auth.mjs）
 *      把 `origin: MM_ORIGIN` 删掉 → 「④ 转发头」组的 origin 断言红。
 *      把 `"x-api-key": MM_PLACEHOLDER_KEY` 改成透传客户端的 → 「客户端同名头作废」那条红。
 *
 *   ⑤ 接线（server.mjs）
 *      把 CHANNELS 里的 "mm" 删掉 → 「⑤ 接线完整性」组的渠道表断言红。
 *
 *   ④b 工具形状转换（mm-auth.mjs + server.mjs）
 *      把 `mmNormalizeTools` 改成直接 `return tools`（即不转）→
 *      「④b 工具定义形状转换」组的「嵌套 → 扁平」红。
 *      把 server.mjs 里 `prepareBody: mmPrepareBody` 删掉 →
 *      同组的「★ 接线」那条红（此时模块测得挺好、线上带工具的请求全被 400）。
 * ====================================================================== */
