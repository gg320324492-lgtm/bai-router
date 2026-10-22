/**
 * 账号发现（src/server/account-discovery.mjs）的口径测试。
 *
 * ## 测什么
 *
 * 这一层是「对标 magpie 复刻」的第四步：把八家**根本不一样**的凭据来源
 * （配置里的 key / 本机令牌仓库 / 令牌文件 / OAuth 登录态 / 传输层自带认证）
 * 收成**一个**判据，并把粒度从 provider 级降到**账号级**。
 *
 *   ① 与 server.mjs 的 providerConfigured **逐项对齐**（锚点 + 行为双查）
 *   ② 八家各自的凭据来源（source）与账号清单
 *   ③ 令牌池：一家的多个号、逐号可用性、逐号休息键
 *   ④ or：一组轮换 key，每把各自休息
 *   ⑤ mm：登录态的三种说法（作废 / 登录了但令牌读不到 / 压根没登录）
 *   ⑥ qd：令牌文件 vs 手动兜底
 *   ⑦ 绝不编造：读不到 ≠ 配好了；没接线的判不了
 *   ⑧ 绝不回显凭据：只给指纹，且指纹就是仓库既有的 keyFp 口径
 *   ⑨ 反向对照：把实现改坏，对应断言**必须红**
 *
 * ## 反向对照怎么做的
 *
 * 把 src/server/account-discovery.mjs 的源码**复制一份到临时目录**、按锚点改坏、
 * import 进来跑同一组断言，然后证明：
 *   · 同一组断言在**改坏**的实现上**真的会红**（不是恒真断言）；
 *   · 同一组断言在**原版**实现上是绿的。
 * 另有一组是**源码锚点对照**：把 server.mjs 的 providerConfigured 源码复制一份、
 * 改掉其中一条判据，证明锚点检查会拒收 —— 锚点检查自己也必须有对照。
 *
 * ## 红线
 *
 * 🔴 全文没有一个真实令牌/API key。夹具里的凭据形态串是明显假的占位串。
 *    落盘只在 os.tmpdir() 下的临时目录，**绝不碰真实的 %APPDATA%\bai-router**。
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";

import { discoverAccounts, fpOf, keyIdOf } from "../src/server/account-discovery.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MODULE = path.join(REPO, "src", "server", "account-discovery.mjs");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const MM_AUTH = path.join(REPO, "src", "server", "mm-auth.mjs");
const SRC = readFileSync(MODULE, "utf8");
const SERVER_SRC = readFileSync(SERVER, "utf8");
const MM_AUTH_SRC = readFileSync(MM_AUTH, "utf8");

/**
 * 去掉注释，只留代码。
 *
 * 为什么需要：模块头注释里写着「零时钟：不调 Date.now()」——
 * 拿带注释的源码去 grep「不许出现 Date.now」，会把**说明**当成**违规**。
 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const SRC_CODE = codeOnly(SRC);

const NOW = 1_780_000_000_000;

/* 🔴 明显不是真凭据的假凭据：中段有可辨认的标记，用来证明返回值里
 *    **除了指纹允许的那几段之外**没有泄漏别的东西。 */
const KEY_BAI = "sk-bai-DUMMYSECRET-0001";
const KEY_SN = "sk-sn-DUMMYSECRET-0002";
const KEY_ZEN = "sk-zen-DUMMYSECRET-0003";
const KEY_OR1 = "sk-or-v1-DUMMYSECRET-0004";
const KEY_OR2 = "sk-or-v1-DUMMYSECRET-0005";
const TOK_WB_A = "wbdummy-a.bbdummy-DUMMYSECRET.bbdummy-payload";
const TOK_WB_B = "wbdummy-b.bbdummy-DUMMYSECRET.bbdummy-payload";
const TOK_QD = "jt-DUMMYSECRET-qoder-token";

const TMP_DIRS = [];
after(() => {
  for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } }
});

function tmpDir() {
  const d = mkdtempSync(path.join(os.tmpdir(), "bai-account-discovery-"));
  TMP_DIRS.push(d);
  return d;
}

/* ====================================================================== *
 * 夹具
 * ====================================================================== */

/** 一份「什么都没配」的配置。字段形状照 config.defaults.json 的切片。 */
function baseCfg(over = {}) {
  return {
    apiKey: "",
    sn: { apiKey: "" },
    zen: { apiKey: "", transport: "direct" },
    qd: { token: "", tokenFile: "" },
    or: { keys: [] },
    wb: {},
    wbai: {},
    mm: {},
    failover: { chain: ["qd", "bai", "sn", "zen", "wb", "wbai", "mm", "or"] },
    ...over,
  };
}

/** 一个账号池（形状照 wb-pool-wiring.mjs 的 normalizeAccount 产物）。 */
function poolOf(accounts, extra = {}) {
  return { accounts, synthetic: false, mode: "priority", ...extra };
}

/** 一条 wb 账号。 */
function acct(id, accessToken, extra = {}) {
  return { id, label: id, accessToken, refreshToken: "", disabled: false, ignored: false, ...extra };
}

const byKey = (res, k) => res.providers.find((p) => p.key === k);

/* ====================================================================== *
 * ① 与 providerConfigured 对齐
 * ====================================================================== */

/**
 * server.mjs 的 providerConfigured 判据**逐条**抄在这里。
 *
 * 为什么抄而不是 import server.mjs：server.mjs 是热路径，import 它会把整个
 * 中继进程拉起来（还要占端口）。这里要的是**判据本身**，不是那个进程。
 * 抄完还要靠下面那组**源码锚点**盯着 server.mjs 不许悄悄改口径。
 */
function refConfigured(provider, cfg, injected = {}) {
  if (provider === "bai") return !!cfg.apiKey;
  if (provider === "sn") return !!cfg.sn?.apiKey;
  if (provider === "wb") return !!cfg.wb?.accessToken;      // ⚠ 见 ①c
  if (provider === "wbai") return !!cfg.wbai?.accessToken;  // ⚠ 见 ①c
  if (provider === "zen") return !!cfg.zen?.apiKey || injected.zenTransport === "opencode";
  if (provider === "or") return (cfg.or?.keys || []).filter((k) => typeof k === "string" && k.trim()).length > 0;
  if (provider === "qd") return !!injected.qdOk;
  if (provider === "mm") return !!(injected.mm?.configured && !injected.mm.invalid);
  return false;
}

/**
 * 源码锚点：server.mjs 里的判据**必须还是那几条**。
 *
 * 为什么要有这层：① 组的对齐是「抄一遍」，抄的那份会随时间腐烂。
 * 锚点把 server.mjs 的判据钉住 —— 那边一改，这边立刻红，
 * 提醒「统一判据得跟着改」。
 */
function assertAlignedAnchors(src) {
  const must = [
    'if (provider === "bai") return !!cfg.apiKey;',
    'if (provider === "sn") return !!cfg.sn?.apiKey;',
    'if (provider === "wb") return !!cfg.wb?.accessToken;',
    'if (provider === "wbai") return !!cfg.wbai?.accessToken;',
    "return !!cfg.zen?.apiKey || zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE;",
    "if (provider === \"or\") return orKeys(cfg).length > 0;",
    "if (provider === \"qd\") { try { qdEnsureToken(cfg); return true; } catch { return false; } }",
    "const snap = mmTokens.recheck();",
    "return snap.configured && !snap.invalid;",
    // orKeys 的口径：非空字符串，trim 过就算数（保留原串，不裁剪）
    "const orKeys = (cfg) => (((cfg && cfg.or && cfg.or.keys) || DEFAULTS.or.keys).filter((k) => typeof k === \"string\" && k.trim()));",
    // qd：手动填的令牌优先于文件
    "const manual = (cfg.qd && cfg.qd.token) || \"\";",
    "if (manual.trim()) return manual.trim();",
  ];
  for (const m of must) {
    assert.ok(src.includes(m), `server.mjs 的判据变了，锚点没命中：\n${m}`);
  }
  /* mm 的 configured 口径住在 mm-auth.mjs 里（server.mjs 只问它）——
   * 钉在那儿，免得有人改了它而这边还以为口径没变。 */
  const mmMust = "configured: !!(st.accessToken || (st.refreshToken && !st.invalid)),";
  assert.ok(MM_AUTH_SRC.includes(mmMust), `mm-auth.mjs 的判据变了，锚点没命中：\n${mmMust}`);
}

describe("① 判据与 providerConfigured 对齐", () => {
  test("①a 源码锚点：server.mjs 的判据还是那几条", () => {
    assertAlignedAnchors(SERVER_SRC);
  });

  test("①b 配置型的四家（bai/sn/zen直连/or）：逐项一致", () => {
    const cases = [
      ["bai", baseCfg({ apiKey: KEY_BAI })],
      ["bai", baseCfg()],
      ["sn", baseCfg({ sn: { apiKey: KEY_SN } })],
      ["sn", baseCfg()],
      ["zen", baseCfg({ zen: { apiKey: KEY_ZEN, transport: "direct" } })],
      ["zen", baseCfg()],
      ["or", baseCfg({ or: { keys: [KEY_OR1] } })],
      ["or", baseCfg({ or: { keys: [] } })],
      ["or", baseCfg({ or: { keys: ["   "] } })],          // 空白串不算
      ["or", baseCfg({ or: { keys: [KEY_OR1, KEY_OR2] } })],
    ];
    for (const [p, cfg] of cases) {
      const got = byKey(discoverAccounts(cfg, {}), p).configured;
      assert.equal(got, refConfigured(p, cfg), `${p} 的判据与 providerConfigured 不一致`);
    }
  });

  test("①c wb/wbai：与 providerConfigured 的**分歧**是故意的，而且方向是对的", () => {
    /* 分歧一：配了账号池、没填顶层 accessToken。
     * 旧判据说「未配置」（转移链会跳过这一格），但令牌明明在池子里 ——
     * 实际取令牌的路径（wbPickAccount）走的是池子，不是顶层那一个字段。 */
    const cfg = baseCfg({
      wb: { accessToken: "", accounts: [acct("a1", TOK_WB_A)] },
    });
    assert.equal(refConfigured("wb", cfg), false, "旧判据确实说未配置（这是分歧的来源）");
    assert.equal(byKey(discoverAccounts(cfg, { wbPool: () => poolOf([acct("a1", TOK_WB_A)]) }), "wb").configured, true,
      "统一判据按池子的真实状态判：号在池子里就算配好了");

    /* 分歧二：填了顶层 accessToken、池子里一个号都没填令牌。
     * 旧判据说「已配置」，但池子里根本没有令牌 —— 转移链会去撞一个必然失败的渠道。 */
    const cfg2 = baseCfg({
      wb: { accessToken: TOK_WB_A, accounts: [acct("a1", "")] },
    });
    assert.equal(refConfigured("wb", cfg2), true, "旧判据确实说已配置（这是分歧的来源）");
    assert.equal(byKey(discoverAccounts(cfg2, { wbPool: () => poolOf([acct("a1", "")]) }), "wb").configured, false,
      "统一判据按池子的真实状态判：号没填令牌就不算配好了");
  });

  test("①d 零时钟 / 零 IO：模块自己不碰时钟也不碰磁盘", () => {
    assert.ok(!/Date\.now\s*\(/.test(SRC_CODE), "模块内部不许取时钟（时间由 opts.now 传进来）");
    assert.ok(!/new\s+Date\s*\(/.test(SRC_CODE), "模块内部不许造时间对象");
    assert.ok(!/from\s+["']node:fs["']/.test(SRC_CODE), "模块不许 import fs（IO 一律由调用方注入）");
    assert.ok(!/from\s+["']node:(http|https|net)["']/.test(SRC_CODE), "模块不许联网");
    assert.ok(!/server\.mjs|wb-pool-wiring|mm-auth|qoder-patch|oc-wiring/.test(SRC_CODE),
      "模块不许 import 那些带 IO 的模块");
  });
});

/* ====================================================================== *
 * ② 八家的来源与账号清单
 * ====================================================================== */

describe("② 每家的凭据来源（source）", () => {
  test("②a source 六种取值都能被正确区分", () => {
    const res = discoverAccounts(baseCfg({
      apiKey: KEY_BAI,
      sn: { apiKey: KEY_SN },
      zen: { apiKey: KEY_ZEN, transport: "direct" },
      or: { keys: [KEY_OR1] },
      wb: { accounts: [acct("a1", TOK_WB_A)] },
      wbai: { accounts: [acct("b1", TOK_WB_B)] },
    }), {
      wbPool: (p) => poolOf([p === "wb" ? acct("a1", TOK_WB_A) : acct("b1", TOK_WB_B)]),
      qdToken: () => ({ ok: true, token: TOK_QD, via: "file", at: NOW }),
      mmStatus: () => ({ configured: true, invalid: false, hasAccess: true, hasRefresh: true, recordKey: "acct-1", filePresent: true }),
    });
    assert.equal(byKey(res, "bai").source, "config");
    assert.equal(byKey(res, "sn").source, "config");
    assert.equal(byKey(res, "or").source, "config");
    assert.equal(byKey(res, "wb").source, "token-pool");
    assert.equal(byKey(res, "wbai").source, "token-pool");
    assert.equal(byKey(res, "qd").source, "token-file");
    assert.equal(byKey(res, "mm").source, "oauth");
    assert.equal(byKey(res, "zen").source, "config");
  });

  test("②b zen 走传输层时 source=transport，且不读那把 key", () => {
    const res = discoverAccounts(baseCfg({ zen: { apiKey: KEY_ZEN, transport: "opencode" } }), {});
    const zen = byKey(res, "zen");
    assert.equal(zen.configured, true, "transport=opencode 时不配 key 也算配好了（与 providerConfigured 同）");
    assert.equal(zen.source, "transport");
    assert.equal(zen.accounts.length, 1);
    assert.equal(zen.accounts[0].kind, "transport");
    assert.ok(!JSON.stringify(res).includes("DUMMYSECRET-0003"), "传输层那条路用不上那把 key，就不该提它");
  });

  test("②c 八家都在，顺序跟着转移链", () => {
    const res = discoverAccounts(baseCfg(), {});
    assert.equal(res.providers.length, 8);
    assert.deepEqual(res.providers.map((p) => p.key), ["qd", "bai", "sn", "zen", "wb", "wbai", "mm", "or"]);
    assert.deepEqual(res.providers.map((p) => p.name),
      ["Qoder", "B.AI", "SenseNova", "OpenCode Zen", "WorkBuddy", "WorkBuddy AI", "MiniMax 会员", "OpenRouter"]);
  });

  test("②d 每家都带 restKey / canRefresh / missing 三件套", () => {
    const res = discoverAccounts(baseCfg(), {});
    for (const p of res.providers) {
      assert.equal(typeof p.restKey, "string");
      assert.equal(typeof p.canRefresh, "boolean");
      assert.ok(p.missing === null || typeof p.missing === "string");
      assert.equal(typeof p.detail, "string");
      assert.ok(p.detail.length > 0, `${p.key} 没有说人话`);
    }
  });
});

/* ====================================================================== *
 * ③ 令牌池：一家多个号
 * ====================================================================== */

describe("③ 令牌池（wb/wbai）：一家几个号、分别是谁", () => {
  const pool = poolOf([
    acct("work", TOK_WB_A, { label: "工作号", refreshToken: "r-a" }),
    acct("personal", TOK_WB_B, { label: "个人号" }),
    acct("disabled-one", TOK_WB_B, { disabled: true }),
    acct("no-token", ""),
  ]);

  test("③a 四个号全列出来（停用的、没令牌的也在列）", () => {
    const res = discoverAccounts(baseCfg({ wb: { accounts: pool.accounts } }), { wbPool: () => pool });
    const wb = byKey(res, "wb");
    assert.equal(wb.accounts.length, 4, "少一个就是「配置里有 4 个、界面只显示 3 个」那种说不清的落差");
    assert.deepEqual(wb.accounts.map((a) => a.id), ["work", "personal", "disabled-one", "no-token"]);
    assert.deepEqual(wb.accounts.map((a) => a.label), ["工作号", "个人号", "disabled-one", "no-token"]);
  });

  test("③b 可用性逐号判：没令牌 / 停用的都不算可用", () => {
    const res = discoverAccounts(baseCfg({ wb: { accounts: pool.accounts } }), { wbPool: () => pool });
    const wb = byKey(res, "wb");
    assert.deepEqual(wb.accounts.map((a) => a.usable), [true, true, false, false]);
    assert.equal(wb.configured, true);
  });

  test("③c 休息键逐号分（wb@<id>，小写）", () => {
    const res = discoverAccounts(baseCfg({ wb: { accounts: pool.accounts } }), { wbPool: () => pool });
    const wb = byKey(res, "wb");
    assert.equal(wb.restKey, "wb", "provider 级的键是 provider 本身（现有 cooldown 表就是这么记的）");
    assert.deepEqual(wb.accounts.map((a) => a.restKey), ["wb@work", "wb@personal", "wb@disabled-one", "wb@no-token"]);
  });

  test("③d 一个号都没有 ⇒ 说清楚缺什么", () => {
    const empty = poolOf([acct("x", "")]);
    const wb = byKey(discoverAccounts(baseCfg({ wb: { accounts: empty.accounts } }), { wbPool: () => empty }), "wb");
    assert.equal(wb.configured, false);
    assert.equal(wb.source, "none");
    assert.ok(wb.missing && wb.missing.length > 0);
    assert.ok(/令牌/.test(wb.missing), `missing 应该说缺令牌：${wb.missing}`);
  });

  test("③e wb 与 wbai 的池子互不通用（两版令牌不通用）", () => {
    const seen = [];
    const res = discoverAccounts(baseCfg({ wb: { accounts: pool.accounts }, wbai: { accounts: pool.accounts } }), {
      wbPool: (p) => { seen.push(p); return p === "wb" ? poolOf([acct("cn", TOK_WB_A)]) : poolOf([acct("ai", TOK_WB_B)]); },
    });
    assert.deepEqual(seen, ["wb", "wbai"], "每个渠道各问一次自己的池子");
    assert.deepEqual(byKey(res, "wb").accounts.map((a) => a.id), ["cn"]);
    assert.deepEqual(byKey(res, "wbai").accounts.map((a) => a.id), ["ai"]);
  });

  test("③f 能续期的号单独标出来", () => {
    const res = discoverAccounts(baseCfg({ wb: { accounts: pool.accounts } }), { wbPool: () => pool });
    const wb = byKey(res, "wb");
    assert.equal(wb.canRefresh, true, "有一个号带刷新令牌就能续");
    assert.deepEqual(wb.accounts.map((a) => a.canRefresh), [true, false, false, false]);
  });
});

/* ====================================================================== *
 * ④ or：一组轮换 key
 * ====================================================================== */

describe("④ or：一组轮换 key，每把各自休息", () => {
  test("④a 两把 key ⇒ 两个账号、各自一把", () => {
    const res = discoverAccounts(baseCfg({ or: { keys: [KEY_OR1, KEY_OR2] } }), {});
    const or = byKey(res, "or");
    assert.equal(or.configured, true);
    assert.equal(or.accounts.length, 2);
    assert.equal(or.source, "config");
  });

  test("④b 一把 key 时整家以 or 的名义休息，多把才按 key 分（magpie 的 perKeyBarred）", () => {
    const one = byKey(discoverAccounts(baseCfg({ or: { keys: [KEY_OR1] } }), {}), "or");
    assert.equal(one.accounts[0].restKey, "or");
    const two = byKey(discoverAccounts(baseCfg({ or: { keys: [KEY_OR1, KEY_OR2] } }), {}), "or");
    assert.equal(two.restKey, "or", "provider 级键不变（现有冷却表靠它）");
    assert.notEqual(two.accounts[0].restKey, two.accounts[1].restKey, "两把 key 必须能各自休息");
    assert.ok(two.accounts[0].restKey.startsWith("or#"));
  });

  test("④c 两把 key 的指纹不同（不会认成同一把）", () => {
    const two = byKey(discoverAccounts(baseCfg({ or: { keys: [KEY_OR1, KEY_OR2] } }), {}), "or");
    assert.notEqual(two.accounts[0].id, two.accounts[1].id);
  });
});

/* ====================================================================== *
 * ⑤ mm：登录态的三种说法
 * ====================================================================== */

describe("⑤ mm：登录态的三种状态必须分开说", () => {
  test("⑤a 有可用令牌 ⇒ 配好了", () => {
    const mm = byKey(discoverAccounts(baseCfg(), {
      mmStatus: () => ({ configured: true, invalid: false, hasAccess: true, hasRefresh: true, recordKey: "acct-1", filePresent: true }),
    }), "mm");
    assert.equal(mm.configured, true);
    assert.equal(mm.source, "oauth");
    assert.equal(mm.canRefresh, true);
    assert.equal(mm.missing, null);
    assert.equal(mm.accounts[0].restKey, "mm@acct-1");
  });

  test("⑤b 登录态作废 ⇒ 不算配好，缺的是「重新登录」", () => {
    const mm = byKey(discoverAccounts(baseCfg(), {
      mmStatus: () => ({ configured: true, invalid: true, hasAccess: true, hasRefresh: true, recordKey: "acct-1", filePresent: true }),
    }), "mm");
    assert.equal(mm.configured, false, "invalid_grant 之后这一格不能再用（与 providerConfigured 同）");
    assert.ok(/作废/.test(mm.detail), mm.detail);
    assert.ok(/重新登录/.test(mm.missing), mm.missing);
  });

  test("⑤c 「登录了但令牌读不到」与「压根没登录」是两种说法", () => {
    const unreadable = byKey(discoverAccounts(baseCfg(), {
      mmStatus: () => ({ configured: false, invalid: false, hasAccess: false, hasRefresh: false, recordKey: "acct-1", filePresent: true }),
    }), "mm");
    const notLogged = byKey(discoverAccounts(baseCfg(), {
      mmStatus: () => ({ configured: false, invalid: false, hasAccess: false, hasRefresh: false, recordKey: null, filePresent: false }),
    }), "mm");

    assert.equal(unreadable.configured, false);
    assert.equal(notLogged.configured, false);
    assert.notEqual(unreadable.detail, notLogged.detail, "这两种情况的药不同，不能说成同一句");
    assert.ok(/令牌读不出来/.test(unreadable.detail), unreadable.detail);
    assert.ok(/没有/.test(notLogged.detail) && /登录态/.test(notLogged.detail), notLogged.detail);
    assert.ok(!/令牌读不出来/.test(notLogged.detail), "没登录不能说成「令牌读不出来」");
    assert.ok(/重新登录/.test(unreadable.missing), unreadable.missing);
    assert.ok(/登录一次/.test(notLogged.missing), notLogged.missing);
  });

  test("⑤d filePresent 未知时不许替它猜", () => {
    const mm = byKey(discoverAccounts(baseCfg(), {
      mmStatus: () => ({ configured: false, invalid: false, hasAccess: false, hasRefresh: false, recordKey: null }),
    }), "mm");
    assert.equal(mm.configured, false);
    assert.ok(/未知|由接线层判定/.test(mm.detail), mm.detail);
    assert.ok(!/令牌读不出来/.test(mm.detail), "没给 filePresent 就不能说「令牌读不出来」");
  });
});

/* ====================================================================== *
 * ⑥ qd
 * ====================================================================== */

describe("⑥ qd：令牌文件 vs 手动兜底", () => {
  test("⑥a 令牌文件来的 ⇒ source=token-file", () => {
    const qd = byKey(discoverAccounts(baseCfg(), {
      qdToken: () => ({ ok: true, token: TOK_QD, via: "file", at: NOW - 60_000 }),
    }), "qd");
    assert.equal(qd.configured, true);
    assert.equal(qd.source, "token-file");
    assert.equal(qd.accounts[0].kind, "token-file");
    assert.equal(qd.restKey, "qd");
  });

  test("⑥b 手动填的 ⇒ source=config（兜底路径）", () => {
    const qd = byKey(discoverAccounts(baseCfg({ qd: { token: TOK_QD } }), {
      qdToken: () => ({ ok: true, token: TOK_QD, via: "manual" }),
    }), "qd");
    assert.equal(qd.configured, true);
    assert.equal(qd.source, "config");
  });

  test("⑥c 补丁没装 / Qoder 没开是两种提示", () => {
    const a = byKey(discoverAccounts(baseCfg(), { qdToken: () => ({ ok: false, reason: "patch-missing" }) }), "qd");
    const b = byKey(discoverAccounts(baseCfg(), { qdToken: () => ({ ok: false, reason: "not-running" }) }), "qd");
    assert.equal(a.configured, false);
    assert.equal(b.configured, false);
    assert.notEqual(a.missing, b.missing);
    assert.ok(/补丁/.test(a.missing), a.missing);
    assert.ok(/启动|运行/.test(b.missing), b.missing);
  });

  test("⑥d 令牌文件很旧 ⇒ 说出来（Qoder 大概没在跑）", () => {
    const old = byKey(discoverAccounts(baseCfg(), {
      now: NOW,
      qdToken: () => ({ ok: true, token: TOK_QD, via: "file", at: NOW - 30 * 60_000 }),
    }), "qd");
    assert.equal(old.configured, true, "旧文件不等于没配好 —— Qoder 可能只是没开");
    assert.ok(/分钟前/.test(old.detail), old.detail);
  });
});

/* ====================================================================== *
 * ⑦ 绝不编造
 * ====================================================================== */

describe("⑦ 绝不编造：读不到 ≠ 配好了", () => {
  test("⑦a 没注入接线的那几家 ⇒ 判不了，不许说配好了", () => {
    const res = discoverAccounts(baseCfg({
      apiKey: KEY_BAI,
      sn: { apiKey: KEY_SN },
      zen: { apiKey: KEY_ZEN, transport: "direct" },
      or: { keys: [KEY_OR1] },
      wb: { accounts: [acct("a1", TOK_WB_A)] },
    }), {});
    for (const k of ["qd", "mm"]) {
      assert.equal(byKey(res, k).configured, false, `${k} 没接上线，不许说配好了`);
      assert.equal(byKey(res, k).source, "none");
      assert.ok(/未接入|判不了/.test(byKey(res, k).missing), byKey(res, k).missing);
    }
    assert.equal(byKey(res, "wb").configured, false, "wb 的池子没注入 ⇒ 判不了");
  });

  test("⑦b 注入的读取函数自己抛异常 ⇒ 当作读不到，不许当成配好了", () => {
    const res = discoverAccounts(baseCfg(), {
      qdToken: () => { throw new Error("炸了"); },
      mmStatus: () => { throw new Error("炸了"); },
      wbPool: () => { throw new Error("炸了"); },
    });
    for (const k of ["qd", "mm", "wb"]) {
      assert.equal(byKey(res, k).configured, false, `${k} 的读取炸了 ⇒ 不许说配好了`);
    }
  });

  test("⑦c 配好了的那几家，一件都不许漏", () => {
    const res = discoverAccounts(baseCfg({
      apiKey: KEY_BAI,
      sn: { apiKey: KEY_SN },
      zen: { apiKey: KEY_ZEN, transport: "direct" },
      or: { keys: [KEY_OR1] },
      wb: { accounts: [acct("a1", TOK_WB_A)] },
      wbai: { accounts: [acct("b1", TOK_WB_B)] },
    }), {
      wbPool: (p) => poolOf([p === "wb" ? acct("a1", TOK_WB_A) : acct("b1", TOK_WB_B)]),
      qdToken: () => ({ ok: true, token: TOK_QD, via: "file", at: NOW }),
      mmStatus: () => ({ configured: true, invalid: false, hasAccess: true, hasRefresh: true, recordKey: "acct-1", filePresent: true }),
    });
    for (const p of res.providers) {
      assert.equal(p.configured, true, `${p.key} 明明配好了却判成没配好`);
      assert.ok(p.accounts.length > 0, `${p.key} 配好了却没有账号清单`);
      assert.equal(p.missing, null);
    }
  });
});

/* ====================================================================== *
 * ⑧ 绝不回显凭据
 * ====================================================================== */

describe("⑧ 绝不回显凭据", () => {
  test("⑧a 返回值里没有凭据明文（指纹允许的那几段除外）", () => {
    const res = discoverAccounts(baseCfg({
      apiKey: KEY_BAI,
      sn: { apiKey: KEY_SN },
      zen: { apiKey: KEY_ZEN, transport: "direct" },
      or: { keys: [KEY_OR1, KEY_OR2] },
      wb: { accounts: [acct("a1", TOK_WB_A)] },
    }), {
      wbPool: () => poolOf([acct("a1", TOK_WB_A)]),
      qdToken: () => ({ ok: true, token: TOK_QD, via: "file", at: NOW }),
      mmStatus: () => ({ configured: true, invalid: false, hasAccess: true, hasRefresh: true, recordKey: "acct-1", filePresent: true }),
    });
    const out = JSON.stringify(res);
    for (const secret of [KEY_BAI, KEY_SN, KEY_ZEN, KEY_OR1, KEY_OR2, TOK_WB_A, TOK_QD]) {
      assert.ok(!out.includes(secret), `凭据明文进了返回值：${secret.slice(0, 10)}…`);
      assert.ok(!out.includes("DUMMYSECRET"), `凭据中段进了返回值（${secret.slice(0, 10)}… 的 DUMMYSECRET）`);
    }
  });

  test("⑧b 指纹就是仓库既有的 keyFp 口径（首 7 + 尾 2 + 长度）", () => {
    assert.equal(fpOf(KEY_BAI), KEY_BAI.slice(0, 7) + "…" + KEY_BAI.slice(-2) + `(${KEY_BAI.length})`);
    assert.equal(fpOf("short"), "***", "太短的凭据连指纹都不给");
    assert.equal(fpOf(""), "(空)");
    const res = discoverAccounts(baseCfg({ apiKey: KEY_BAI }), {});
    assert.equal(byKey(res, "bai").accounts[0].fp, fpOf(KEY_BAI));
  });

  test("⑧c id 是不可逆的 sha256 前缀，不是凭据本身", () => {
    const id = keyIdOf(KEY_BAI);
    assert.match(id, /^[0-9a-f]{10}$/, "magpie 的 KeyID 口径：sha256 前 5 字节");
    assert.ok(!id.includes("sk-"));
    assert.notEqual(keyIdOf(KEY_BAI), keyIdOf(KEY_SN));
    assert.equal(keyIdOf(""), null);
  });
});

/* ====================================================================== *
 * ⑨ 反向对照
 * ====================================================================== */

/**
 * 把实现改坏：源码复制一份到临时目录、按锚点改、import 进来。
 *
 * 锚点必须**恰好命中一次** —— 命中 0 次说明源码变了（不猜、不硬改），
 * 命中多次说明锚点不唯一（两种都判失败）。
 */
async function loadMutated(pairs) {
  let out = SRC;
  for (const [from, to] of pairs) {
    const hits = out.split(from).length - 1;
    assert.equal(hits, 1, `锚点必须恰好命中一次（实际 ${hits} 次）：${from}`);
    out = out.replace(from, to);
  }
  const dir = tmpDir();
  const file = path.join(dir, "mutated.mjs");
  writeFileSync(file, out, "utf8");
  return import(pathToFileURL(file).href);
}

/* ---- 下面这些是「同一组断言」：原版绿、改坏版红 ---- */

function assertBaiNeedsKey(mod) {
  assert.equal(byKey(mod.discoverAccounts(baseCfg(), {}), "bai").configured, false);
  assert.equal(byKey(mod.discoverAccounts(baseCfg({ apiKey: KEY_BAI }), {}), "bai").configured, true);
}

function assertWbUsablePerAccount(mod) {
  const p = poolOf([acct("ok", TOK_WB_A), acct("off", TOK_WB_B, { disabled: true })]);
  const wb = byKey(mod.discoverAccounts(baseCfg({ wb: { accounts: p.accounts } }), { wbPool: () => p }), "wb");
  assert.deepEqual(wb.accounts.map((a) => a.usable), [true, false]);
}

function assertMmInvalidNotConfigured(mod) {
  const mm = byKey(mod.discoverAccounts(baseCfg(), {
    mmStatus: () => ({ configured: true, invalid: true, hasAccess: true, hasRefresh: true, recordKey: "acct-1", filePresent: true }),
  }), "mm");
  assert.equal(mm.configured, false);
}

function assertMmDistinguishesUnreadable(mod) {
  const unreadable = byKey(mod.discoverAccounts(baseCfg(), {
    mmStatus: () => ({ configured: false, invalid: false, hasAccess: false, hasRefresh: false, recordKey: "acct-1", filePresent: true }),
  }), "mm");
  const notLogged = byKey(mod.discoverAccounts(baseCfg(), {
    mmStatus: () => ({ configured: false, invalid: false, hasAccess: false, hasRefresh: false, recordKey: null, filePresent: false }),
  }), "mm");
  assert.notEqual(unreadable.detail, notLogged.detail);
  assert.ok(/令牌读不出来/.test(unreadable.detail), unreadable.detail);
}

function assertOrPerKeyRest(mod) {
  const or = byKey(mod.discoverAccounts(baseCfg({ or: { keys: [KEY_OR1, KEY_OR2] } }), {}), "or");
  assert.notEqual(or.accounts[0].restKey, or.accounts[1].restKey);
}

function assertNoCredentialLeak(mod) {
  const out = JSON.stringify(mod.discoverAccounts(baseCfg({ apiKey: KEY_BAI }), {}));
  assert.ok(!out.includes("DUMMYSECRET"));
}

function assertQdManualIsConfig(mod) {
  const qd = byKey(mod.discoverAccounts(baseCfg({ qd: { token: TOK_QD } }), {
    qdToken: () => ({ ok: true, token: TOK_QD, via: "manual" }),
  }), "qd");
  assert.equal(qd.source, "config");
}

function assertUnwiredIsUnjudgeable(mod) {
  const qd = byKey(mod.discoverAccounts(baseCfg(), {}), "qd");
  assert.ok(/未接入|判不了/.test(qd.missing), qd.missing);
  assert.equal(qd.configured, false);
}

describe("⑨ 反向对照 —— 改坏实现，对应断言必须红", () => {
  test("⑨a bai 判据改成「永远配好了」⇒ ①b 必须红", async () => {
    const bad = await loadMutated([
      ['function discoverBai(cfg) {\n  const key = String(cfg.apiKey || "");\n  const ok = !!key;',
        'function discoverBai(cfg) {\n  const key = String(cfg.apiKey || "");\n  const ok = true;'],
    ]);
    assert.throws(() => assertBaiNeedsKey(bad), "改坏后 ①b 竟然还是绿的 —— 那是恒真断言");
    assert.doesNotThrow(() => assertBaiNeedsKey({ discoverAccounts }));
  });

  test("⑨b 池子里停用的号也算可用 ⇒ ③b 必须红", async () => {
    const bad = await loadMutated([
      ["const usable = !!tok && !disabled && !ignored;", "const usable = !!tok;"],
    ]);
    assert.throws(() => assertWbUsablePerAccount(bad));
    assert.doesNotThrow(() => assertWbUsablePerAccount({ discoverAccounts }));
  });

  test("⑨c 忽略登录态作废标记 ⇒ ⑤b 必须红", async () => {
    const bad = await loadMutated([
      ["const ok = st.configured === true && !invalid;", "const ok = st.configured === true;"],
    ]);
    assert.throws(() => assertMmInvalidNotConfigured(bad));
    assert.doesNotThrow(() => assertMmInvalidNotConfigured({ discoverAccounts }));
  });

  test("⑨d 把「登录了但令牌读不到」说成「没登录」⇒ ⑤c 必须红", async () => {
    const bad = await loadMutated([
      ['"登录态文件在、账号记录也在，但令牌读不出来"', '"本机没有 MiniMax Code 的登录态"'],
    ]);
    assert.throws(() => assertMmDistinguishesUnreadable(bad));
    assert.doesNotThrow(() => assertMmDistinguishesUnreadable({ discoverAccounts }));
  });

  test("⑨e 多把 key 不分休息键 ⇒ ④b 必须红", async () => {
    const bad = await loadMutated([
      ['restKey: multi ? `or#${keyIdOf(k)}` : "or",', 'restKey: "or",'],
    ]);
    assert.throws(() => assertOrPerKeyRest(bad));
    assert.doesNotThrow(() => assertOrPerKeyRest({ discoverAccounts }));
  });

  test("⑨f 指纹改成回显凭据 ⇒ ⑧a 必须红", async () => {
    const bad = await loadMutated([
      ['return s.length <= 12 ? "***" : s.slice(0, 7) + "…" + s.slice(-2) + "(" + s.length + ")";', "return s;"],
    ]);
    assert.throws(() => assertNoCredentialLeak(bad));
    assert.doesNotThrow(() => assertNoCredentialLeak({ discoverAccounts }));
  });

  test("⑨g qd 的手动兜底被当成文件 ⇒ ⑥b 必须红", async () => {
    const bad = await loadMutated([
      ['const via = st.via || (manual && manual === token ? "manual" : "file");', 'const via = "file";'],
    ]);
    assert.throws(() => assertQdManualIsConfig(bad));
    assert.doesNotThrow(() => assertQdManualIsConfig({ discoverAccounts }));
  });

  test("⑨h 没接入线的那几家被说成「配好了」⇒ ⑦a 必须红", async () => {
    const bad = await loadMutated([
      ['if (typeof opts.qdToken !== "function") {', "if (false) {"],
    ]);
    assert.throws(() => assertUnwiredIsUnjudgeable(bad));
    assert.doesNotThrow(() => assertUnwiredIsUnjudgeable({ discoverAccounts }));
  });

  test("⑨i 源码锚点检查自己也有对照：改掉 server.mjs 的判据，锚点必须拒收", () => {
    /* 锚点检查若是恒真的，它就等于没有 —— 这里把 server.mjs 的源码复制一份、
     * 改掉一条判据，证明锚点会红。 */
    const broken = SERVER_SRC.replace(
      'if (provider === "bai") return !!cfg.apiKey;',
      'if (provider === "bai") return true;'
    );
    assert.notEqual(broken, SERVER_SRC, "改坏没生效（源码变了？）");
    assert.throws(() => assertAlignedAnchors(broken), "锚点检查收下了改坏的判据 —— 它是恒真的");
    assert.doesNotThrow(() => assertAlignedAnchors(SERVER_SRC));
  });

  test("⑩j 零时钟检查自己也有对照：模块里塞一个 Date.now，检查必须红", () => {
    const check = (src) => {
      assert.ok(!/Date\.now\s*\(/.test(src), "模块内部不许取时钟（时间由 opts.now 传进来）");
    };
    assert.throws(() => check(SRC_CODE + "\nconst x = Date.now();\n"), "零时钟检查收下了带 Date.now 的源码");
    assert.doesNotThrow(() => check(SRC_CODE));
  });
});
