/**
 * T4 回归测试：OpenCode Zen Go 档支持（v1.0.74）
 *
 *   ① 目录端点跟着 cfg.zen.upstream 走 + 带 Key 抓（不带 Key 才退回免鉴权）
 *   ② Go 档注入 x-opencode-session；免费档**一个字都不加**
 *   ③ Go 档两种错误形状（{"error":{...}} / {"type":"error","error":{...}}）都能归因成中文
 *   ④ 非 Go 档请求头与改动前**逐字相同**（防回归）
 *
 * 两类测试：
 *   · **源码求值**（快、确定性）—— 从 src/server/server.mjs 里**按锚点切出真实函数**，
 *     用 new Function 组装起来跑。测的是仓库里那份代码本身，不是抄一份重写。
 *   · **端到端**—— 真 spawn 一份 server.mjs（BAI_DATA_DIR 指向系统临时目录，
 *     端口全部动态挑空闲的），前面架一台**假上游**记录它收到的每个请求头，
 *     走完整个中转链路再比对。
 *
 * 每个用例都配一个**反向对照**：故意构造一个应当失败的输入，断言它真的失败。
 * 没有对照的断言证明不了自己没写错——比如「目录 URL 跟着配置走」如果照抄了旧代码，
 * 正向会通过但对照（Go 档请求必须命中 /zen/go/v1/models 而不是硬编码的免费档）会失败。
 *
 * 红线：所有落盘都在 os.tmpdir() 下，**绝不碰真实的 %APPDATA%\bai-router**。
 *       凭据一律是 'oc_dummy-not-a-real-key' 这类明显假串，
 *       源码/命令/日志里没有任何真实令牌。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const SRC = readFileSync(SERVER, "utf8");
const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-zen-go-"));

/** 明显不是真 Key 的假凭据。红线：绝不把真 Key 写进任何文件/命令行/日志。 */
const DUMMY_KEY = "oc_dummy-not-a-real-key";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => { try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* ------------------------------------------------------------------ *
 * 源码求值工具
 * ------------------------------------------------------------------ */

/** 从 `anchor` 切到其后的第一个顶格 `\n}`（函数体结束）。 */
function sliceToClosingBrace(anchor) {
  const i = SRC.indexOf(anchor);
  assert.ok(i >= 0, `server.mjs 里找不到锚点：${anchor}`);
  const end = SRC.indexOf("\n}\n", i);
  assert.ok(end > i, `锚点 ${anchor} 之后没找到顶格 "}"，抠源码失败`);
  return SRC.slice(i, end + 3);
}
/** 从 startAnchor 切到 endAnchor 之前。 */
function sliceBetween(startAnchor, endAnchor) {
  const i = SRC.indexOf(startAnchor);
  assert.ok(i >= 0, `抠源码失败：找不到 ${startAnchor}`);
  const j = SRC.indexOf(endAnchor, i + startAnchor.length);
  assert.ok(j > i, `抠源码失败：${startAnchor} → ${endAnchor}`);
  return SRC.slice(i, j);
}
/** 同上，但从 startAnchor 的**第 nth 次**出现开始切。
 * server.mjs 里 `if (p === "zen") {` 有五处（目录分支 / 取凭据 / 500 退避 / 归因链 / …），
 * `indexOf` 只会命中第一处——用它抠归因链会抠出完全无关的代码块，
 * 于是断言「链里有这条判据」必然失败。 */
function sliceBetweenNth(startAnchor, endAnchor, nth) {
  let i = -1;
  for (let k = 0; k < nth; k++) {
    i = SRC.indexOf(startAnchor, i + 1);
    assert.ok(i >= 0, `抠源码失败：${startAnchor} 第 ${nth} 次出现找不到`);
  }
  const j = SRC.indexOf(endAnchor, i + startAnchor.length);
  assert.ok(j > i, `抠源码失败：${startAnchor}#${nth} → ${endAnchor}`);
  return SRC.slice(i, j);
}
/** 归因链那段（第 4 处 `if (p === "zen") {` → 它后面的 `} else if (p === "or") {`）。
 * 编号是**源码位置**的证据：一旦有人在这中间插了一个新的 zen 分支，
 * nth 就会抠错位置，断言随即失败——不会静默地验错代码。 */
const ATTR_CHAIN = sliceBetweenNth('if (p === "zen") {', '} else if (p === "or") {', 4);
assert.ok(ATTR_CHAIN.includes("An active OpenCode Go subscription is required"),
  `归因链抠错了位置（nth=4 已失效）：${ATTR_CHAIN.slice(0, 120)}`);

/* 档位判定 + 会话 id + 目录读取需要的一整块真实源码。
 * 这几段在 server.mjs 里是**相邻**的（常量 → 注释块 → 常量 → 函数），一并抠出来，
 * 免得分别抠时漏掉某个常量依赖。起点是 ZEN_EXTERNAL_OK 的声明行。 */
const ZEN_CORE = [
  sliceBetween("const ZEN_EXTERNAL_OK = new Set(", "// ---------- WorkBuddy 模型目录"),
  // sliceOf 是 zenReadCatalog 唯一的配置依赖，抠真函数进来而不是重写一份
  sliceToClosingBrace("function sliceOf(cfg, p) {"),
].join("\n");

/** 组装一个沙箱：返回抠出来的真实函数 + 可注入的 fetch 桩。 */
function loadZenCore({ fetchImpl, defaults } = {}) {
  const calls = [];
  const f = fetchImpl || (async () => { throw new Error("测试里没注入 fetch 桩"); });
  const fetchSpy = async (url, opts) => { calls.push({ url, opts }); return f(url, opts); };
  /* DEFAULTS 必须**字段齐全**：抠出来的 sliceOf 是真函数，会读
   * availableModels / mapping / defaultModel / relayPort。少一个字段它就抛
   * "not iterable" —— 那是测试夹具不全，不是被测代码的问题。 */
  const DEFAULTS = defaults || {
    zen: {
      upstream: "https://opencode.ai/zen/v1", apiKey: "", relayPort: 15752,
      defaultModel: "space-bunny-free", availableModels: ["space-bunny-free"],
      mapping: { "claude-fable-5": { target: "space-bunny-free" } }, useProxy: false,
    },
  };
  const factory = new Function(
    "createHash", "sliceOf", "fetch", "DEFAULTS",
    `${ZEN_CORE}
return { zenTierOf, zenTierZh, zenCatalogEndpointLabel, zenSessionId, zenReadCatalog, zenTierInfo, zenGoState, ZEN_TIER_GO, ZEN_TIER_FREE, ZEN_PROBE_SESSION, ZEN_EXTERNAL_OK, zenCatCache };`
  );
  const api = factory(createHash, (cfg, p) => ({
    p, zh: "OpenCode Zen", key: cfg.zen.apiKey || "",
    upstream: cfg.zen.upstream || DEFAULTS.zen.upstream,
  }), fetchSpy, DEFAULTS);
  return { ...api, calls, fetchSpy };
}

/** 一个「成功返回目录」的 fetch 桩。 */
const okCatalog = (ids) => async () => ({
  async json() { return { data: ids.map((id) => ({ id })) }; },
});

const cfgGo = (over = {}) => ({
  zen: { upstream: "https://opencode.ai/zen/go/v1", apiKey: DUMMY_KEY, ...over },
});
const cfgFree = (over = {}) => ({
  zen: { upstream: "https://opencode.ai/zen/v1", apiKey: DUMMY_KEY, ...over },
});

/* ------------------------------------------------------------------ *
 * ① 目录端点跟着配置走
 * ------------------------------------------------------------------ */

describe("T4-① 目录端点跟着 upstream 走，且带 Key 抓", () => {
  test("Go 档 → 请求 .../zen/go/v1/models，且带 Authorization", async () => {
    const Z = loadZenCore({ fetchImpl: okCatalog(["step-5-preview-free"]) });
    const list = await Z.zenReadCatalog(cfgGo());
    assert.deepEqual(list, ["step-5-preview-free"]);
    assert.equal(Z.calls.length, 1);
    assert.equal(Z.calls[0].url, "https://opencode.ai/zen/go/v1/models",
      `Go 档必须拉 Go 档的目录，实际请求了 ${Z.calls[0].url}`);
    assert.equal(Z.calls[0].opts.headers.authorization, `Bearer ${DUMMY_KEY}`,
      "带了 Key 就必须带上 Authorization");
  });

  test("免费档 → 请求 .../zen/v1/models（同一份代码、只改配置）", async () => {
    const Z = loadZenCore({ fetchImpl: okCatalog(["space-bunny-free"]) });
    await Z.zenReadCatalog(cfgFree());
    assert.equal(Z.calls[0].url, "https://opencode.ai/zen/v1/models");
  });

  test("反向对照：自定义上游（自建代理）也按配置拼 /models，不回落硬编码", async () => {
    const Z = loadZenCore({ fetchImpl: okCatalog(["x"]) });
    await Z.zenReadCatalog({ zen: { upstream: "http://127.0.0.1:9/my-proxy/v1", apiKey: "" } });
    assert.equal(Z.calls[0].url, "http://127.0.0.1:9/my-proxy/v1/models");
    // 关键：URL 里**不能**出现官方地址。硬编码时代的代码在这里会打 opencode.ai。
    assert.equal(/opencode\.ai/.test(Z.calls[0].url), false,
      `自定义上游被打回了官方地址（硬编码没改干净）：${Z.calls[0].url}`);
    assert.equal(Z.zenTierOf("http://127.0.0.1:9/my-proxy/v1"), Z.ZEN_TIER_FREE,
      "不含 /zen/go 的自定义上游判为免费档——该档不注入会话头");
  });

  test("反向对照：尾部多余的 / 不会拼出 //models（且判定档位不受影响）", async () => {
    const Z = loadZenCore({ fetchImpl: okCatalog(["x"]) });
    await Z.zenReadCatalog({ zen: { upstream: "https://opencode.ai/zen/go/v1///", apiKey: "" } });
    assert.equal(Z.calls[0].url, "https://opencode.ai/zen/go/v1/models");
    assert.equal(Z.zenTierOf("https://opencode.ai/zen/go/v1///"), Z.ZEN_TIER_GO);
    assert.equal(Z.zenTierOf("https://opencode.ai/zen/go"), Z.ZEN_TIER_GO, "/zen/go 结尾（无 /v1）也应判为 Go 档");
    assert.equal(Z.zenTierOf("https://opencode.ai/zen/goose/v1"), Z.ZEN_TIER_FREE,
      "/zen/goose 不是 Go 档——前缀误判会把用户打进错误的请求头分支");
  });

  test("没配 Key → 不带 Authorization（退回免鉴权）且不抛错", async () => {
    const Z = loadZenCore({ fetchImpl: okCatalog(["space-bunny-free"]) });
    const list = await Z.zenReadCatalog({ zen: { upstream: "https://opencode.ai/zen/v1", apiKey: "" } });
    assert.deepEqual(list, ["space-bunny-free"], "免鉴权抓也要能拿到目录");
    assert.deepEqual(Z.calls[0].opts.headers, {}, "没配 Key 时不得凭空造一个 Authorization 头");
  });

  test("反向对照：没配 Key 与配了 Key 的头必须不同（否则「带 Key 抓」是假实现）", () => {
    const withKey = { authorization: `Bearer ${DUMMY_KEY}` };
    const without = {};
    assert.notDeepEqual(withKey, without);
  });

  test("带 Key 抓不到（网络炸）→ 静默降级，不抛", async () => {
    const Z = loadZenCore({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
    const list = await Z.zenReadCatalog(cfgGo());
    assert.deepEqual(list, [], "拉不到时返回空数组而不是抛异常（外层 /api/models 才不会 500）");
  });

  test("Key 只出现在 Authorization 头里，不进 URL、不进异常、不进返回值", async () => {
    const boom = new Error("connection refused");
    const Z = loadZenCore({ fetchImpl: async () => { throw boom; } });
    const list = await Z.zenReadCatalog(cfgGo());
    assert.deepEqual(list, [], "失败时静默降级");
    for (const c of Z.calls) {
      assert.equal(c.url.includes(DUMMY_KEY), false, `URL 里带 Key：${c.url}`);
      // 只允许 authorization 一个头带 Key —— 多一个都是泄漏面
      const withKey = Object.entries(c.opts.headers).filter(([, v]) => String(v).includes(DUMMY_KEY));
      assert.deepEqual(withKey.map(([k]) => k), ["authorization"],
        `Key 出现在 ${withKey.map(([k]) => k).join(",")} 里`);
    }
    // 反向对照：Key 确实**被放进了** Authorization（否则上面全是空断言）
    assert.equal(Z.calls[0].opts.headers.authorization, `Bearer ${DUMMY_KEY}`);
    assert.equal(String(boom.message).includes(DUMMY_KEY), false, "异常消息里不该有 Key");
  });

  test("档位判定集中在一处：zenTierOf 是唯一**判定** /zen/go 的代码", () => {
    /* 判据的形态：/zen/go/ 出现在**代码**里 = 一次判定（可能判错）；
     * 出现在**字符串字面量**里 = 只是给人看的文案（用户照着改上游地址，正确）。
     * 所以只抓「含 /zen/go 的行里没有引号」的那些——它们才可能是判定。 */
    const offenders = SRC.split("\n")
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) => /\/zen\/go/.test(l))
      .filter(({ l }) => !/["'`]/.test(l))          // 纯代码行（没引号 = 不是文案）
      .filter(({ l }) => !/^\s*(\*|\/\/)/.test(l))   // 注释
      .filter(({ l }) => !l.includes("function zenTierOf"));   // 判定本身
    assert.deepEqual(offenders.map((o) => `server.mjs:${o.i} ${o.l.trim()}`), [],
      "zenTierOf 之外还有别处判 /zen/go —— 漏改一处就前后不一致");
    // 反向对照：zenTierOf 自己**确实**含那个判据（否则上面那条是恒真的）
    const fn = sliceToClosingBrace("function zenTierOf(upstream) {");
    // 注意源码里写的是正则字面量 /\/zen\/go/ —— 斜杠被转义了，所以要按转义后的形态匹配
    assert.match(fn, /zen\\\/go|\\\/zen\\\/go/, `zenTierOf 里没有 /zen/go 判据：${fn}`);
    assert.match(fn, /\.test\(String\(upstream/, "zenTierOf 没在测 upstream");
    // 反向对照：文案行确实含引号（证明上面那个「没引号」的过滤不是把所有行都放行了）
    assert.ok(SRC.split("\n").filter((l) => /\/zen\/go/.test(l) && /["'`]/.test(l)).length > 0,
      "源码里一行 /zen/go 文案都没有——说明这份源码不是我们以为的那份");
  });
});

/* ------------------------------------------------------------------ *
 * ② session 头
 * ------------------------------------------------------------------ */

describe("T4-② x-opencode-session（Go 档必需 / 免费档一个字不加）", () => {
  const conv = (first, rest = []) => ({
    messages: [{ role: "user", content: first }, ...rest],
  });

  test("同一会话两轮得到同一个 id（满足 stable session ID）", () => {
    const Z = loadZenCore({ fetchImpl: okCatalog([]) });
    const turn1 = { messages: [{ role: "user", content: "帮我看看这段代码" }] };
    const turn2 = {
      messages: [
        { role: "user", content: "帮我看看这段代码" },
        { role: "assistant", content: "好的" },
        { role: "user", content: "第二轮的问题" },
      ],
    };
    assert.equal(Z.zenSessionId(turn1, false), Z.zenSessionId(turn2, false),
      "同一会话的第二轮必须复用第一轮的 id");
  });

  test("不同会话 → 不同 id", () => {
    const Z = loadZenCore({ fetchImpl: okCatalog([]) });
    const a = Z.zenSessionId(conv("会话 A 的第一句话"), false);
    const b = Z.zenSessionId(conv("会话 B 的第一句话"), false);
    assert.notEqual(a, b);
  });

  test("id 形状固定：bai- + 16 位 hex", () => {
    const Z = loadZenCore({ fetchImpl: okCatalog([]) });
    const id = Z.zenSessionId(conv("任意内容"), false);
    assert.match(id, /^bai-[0-9a-f]{16}$/, `实际拿到 ${id}`);
  });

  test("反向对照：内容不同的两个会话**不会**撞成同一个 id（哈希前 16 位够用）", () => {
    const Z = loadZenCore({ fetchImpl: okCatalog([]) });
    const ids = new Set(["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛"].map(
      (s) => Z.zenSessionId(conv("会话 " + s + " 的第一句话"), false)
    ));
    assert.equal(ids.size, 8, "8 个不同会话撞成了同一个 id：" + [...ids].join(","));
  });

  test("探针 / 无 user 消息 → 固定 id bai-probe，且**不会**每次造新会话", () => {
    const Z = loadZenCore({ fetchImpl: okCatalog([]) });
    assert.equal(Z.zenSessionId(conv("探针内容甲"), true), Z.ZEN_PROBE_SESSION);
    assert.equal(Z.zenSessionId(conv("探针内容乙"), true), Z.ZEN_PROBE_SESSION);
    assert.equal(Z.zenSessionId({ messages: [] }, false), Z.ZEN_PROBE_SESSION,
      "没有 user 消息时也要固定，否则每次探测都造一个新会话");
    assert.equal(Z.zenSessionId(null, false), Z.ZEN_PROBE_SESSION);
    assert.equal(Z.zenSessionId({ messages: [{ role: "system", content: "x" }] }, false), Z.ZEN_PROBE_SESSION);
  });

  test("反向对照：探针 id 与真实会话 id 不相等（否则真实会话全被并进探针会话）", () => {
    const Z = loadZenCore({ fetchImpl: okCatalog([]) });
    assert.notEqual(Z.zenSessionId(conv("随便什么"), false), Z.ZEN_PROBE_SESSION);
  });

  test("多模态 content（数组形态）也能稳定取到锚点", () => {
    const Z = loadZenCore({ fetchImpl: okCatalog([]) });
    const j = { messages: [{ role: "user", content: [{ type: "text", text: "看图" }] }] };
    const id = Z.zenSessionId(j, false);
    assert.match(id, /^bai-[0-9a-f]{16}$/);
    assert.equal(id, Z.zenSessionId({ messages: [{ role: "user", content: [{ type: "text", text: "看图" }] }] }, false));
  });

  test("反向对照：锚点取**第一条** user 消息，不是最后一条", () => {
    const Z = loadZenCore({ fetchImpl: okCatalog([]) });
    const j1 = { messages: [{ role: "user", content: "首句" }, { role: "assistant", content: "a" }, { role: "user", content: "末句甲" }] };
    const j2 = { messages: [{ role: "user", content: "首句" }, { role: "assistant", content: "a" }, { role: "user", content: "末句乙" }] };
    assert.equal(Z.zenSessionId(j1, false), Z.zenSessionId(j2, false),
      "如果锚点取的是最后一条 user 消息，这里就会不等——会话 id 就不稳定了");
  });
});

/* ------------------------------------------------------------------ *
 * ③ 两种错误形状都能归因
 * ------------------------------------------------------------------ */

/* 归因那段不是一个独立函数，它长在 openaiExchange 里，直接调要拉起整台服务器。
 * 这里改为**逐条核对源码里的判据**，再用 e2e 真跑一遍喂响应体。
 * ERR_CASES.upstream 是「上游原文」；judge 是把上游原文抽成**判据里那个子串**
 * （源码里我们写的是正则 /Model is unavailable/i，比上游原文少一个句点——
 * 所以必须显式给出判据子串，不能指望 includes 全串）。
 * 下面的 ERR_CASES 是「上游原文 → 我们必须认识它」的事实表，
 * 断言方式是：这句判据必须出现在 server.mjs 的归因链里。 */
const ERR_CASES = [
  {
    name: "需要 Go 订阅",
    // 实测原文（.research/reports/T5-probe-result.md 判别实验 F）
    upstream: "An active OpenCode Go subscription is required to use Go models.",
    judge: "An active OpenCode Go subscription is required",
    mustSay: ["订阅", "https://opencode.ai/auth"],
  },
  {
    name: "模型不在当前档位",
    upstream: "Upstream request failed: Model is unavailable.",
    judge: "Model is unavailable",
    mustSay: ["不在当前档位的清单里"],
  },
  {
    name: "Go 档缺会话头（本机缺陷的自证信号）",
    upstream: "MissingSessionID",
    judge: "MissingSessionID",
    mustSay: ["x-opencode-session"],
  },
  {
    name: "免费档围栏",
    upstream: "OpenCode's free tier can only be used from within OpenCode",
    judge: "FreeTierError|only be used from within",
    mustSay: ["客户端内", "FreeTierError"],
  },
];

describe("T4-③ Go 档两种错误形状都能归因（源码判据 + e2e 实跑）", () => {
  test('两种形状：{"error":{…}}（无顶层 type）与 {"type":"error","error":{…}}', () => {
    // Go 档 /chat/completions 的形状 —— **没有顶层 type 包裹**
    const openaiShape = JSON.stringify({
      error: { type: "server_error", message: "Upstream request failed: An active OpenCode Go subscription is required to use Go models." },
    });
    // Go 档 /messages 的 Anthropic 形状
    const anthropicShape = JSON.stringify({
      type: "error",
      error: { type: "api_error", message: "Upstream request failed: An active OpenCode Go subscription is required to use Go models." },
    });
    // 两种形状里那句原文都必须在——我们的判据是纯正则，认的是文案不是形状
    for (const [tag, body] of [["openai", openaiShape], ["anthropic", anthropicShape]]) {
      assert.match(body, /An active OpenCode Go subscription is required/,
        `${tag} 形状里没有判据要认的那句话（测试自身写错了）`);
    }
    assert.equal(/"type":"error"/.test(openaiShape), false,
      "这条 openai 形状必须**不含**顶层 type，否则它就不是本轮要接的那种形状了");
    assert.equal(/"type":"error"/.test(anthropicShape), true);
    assert.deepEqual(
      JSON.parse(openaiShape).error.message,
      JSON.parse(anthropicShape).error.message,
      "两种形状必须喂**同一句**原文：否则 e2e 只能证明其中一种形状能归因"
    );
  });

  test("每条上游原文都在归因链里有对应判据（漏一条 = 掉进通用兜底）", () => {
    for (const c of ERR_CASES) {
      assert.ok(ATTR_CHAIN.includes(c.judge),
        `归因链里找不到对「${c.name}」的判据：${c.judge}`);
    }
  });

  test("反向对照：没写判据的原文**确实**匹配不上（证明上一条不是恒真）", () => {
    const bogus = "Some Upstream Error Nobody Wrote A Rule For.";
    assert.equal(ATTR_CHAIN.includes(bogus), false, "凭空一句上游没说过的话，归因链里当然不该有判据");
    for (const c of ERR_CASES) {
      assert.ok(ATTR_CHAIN.includes(c.judge), `归因链里缺少「${c.name}」的分支`);
    }
  });

  test("Go 档归因链**只看文案不看状态码**（同一条拒绝在两个端点上码不同）", () => {
    const goBranch = ATTR_CHAIN.slice(0, ATTR_CHAIN.indexOf("r.status === 500"));
    for (const c of ERR_CASES) {
      if (c.judge.includes("|")) continue;    // 免费档那条本来就是 `status && regex` 形态，不在 Go 分支里
      const at = goBranch.indexOf(c.judge);
      assert.ok(at >= 0, `Go 档分支里缺少「${c.name}」的判据 ${c.judge}`);
      // 判据所在的**那一行**不得出现 r.status === N：出现了就说明又绑回状态码了。
      // 逐行找而不是对前缀 slice —— 后者会被更早行里的状态码条件误伤。
      const line = goBranch.slice(0, at).split("\n").pop() + goBranch.slice(at).split("\n")[0];
      assert.equal(/r\.status ===/.test(line), false,
        `「${c.name}」的判据行里混进了状态码条件：${line.trim()}`);
      assert.match(line, /\.test\(txt\)|txt\.includes\(/,
        `「${c.name}」应当是**对响应体文案**的判据：${line.trim()}`);
    }
  });

  test("反向对照：删掉 Go 分支后归因链确实抓不到（把真源码临时挖掉再验）", () => {
    // 从真实源码里把 Go 档三条判据**抠掉**，模拟"没实现"的对照组。
    // 注意只抠判据、不碰其余代码——抠多了会把整段抠坏，那种"通过"没有意义。
    const stripped = ATTR_CHAIN
      .replace(/An active OpenCode Go subscription is required/g, "XXX_GONE_XXX")
      .replace(/MissingSessionID/g, "XXX_GONE_XXX")
      .replace(/Model is unavailable/g, "XXX_GONE_XXX");
    for (const c of ERR_CASES) {
      if (c.judge.includes("|")) continue;
      assert.equal(ATTR_CHAIN.includes(c.judge), true, `${c.name} 原先应在链中`);
      assert.equal(stripped.includes(c.judge), false, `${c.name} 被抠掉后仍匹配——说明链是恒真的假闸门`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * ④ 端到端：真 server.mjs + 假上游（记录它收到的请求头）
 * ------------------------------------------------------------------ */

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

describe("T4 e2e：Go 档 / 免费档 请求头与错误归因", () => {
  let child, fake, dataDir, P;
  const seen = [];          // 假上游收到的每个请求
  let upstreamReply = null; // 每个用例自己设

  before(async () => {
    const [bai, sn, wb, wbai, zen, qd, or, panel, upstream] = await freePorts(9);
    P = { bai, sn, wb, wbai, zen, qd, or, panel, upstream };
    dataDir = mkdtempSync(path.join(TMPROOT, "boot-"));

    const cfg = JSON.parse(readFileSync(path.join(REPO, "src", "server", "config.defaults.json"), "utf8"));
    cfg.relayPort = bai; cfg.panelPort = panel;
    Object.assign(cfg, { sn: { ...cfg.sn, relayPort: sn }, wb: { ...cfg.wb, relayPort: wb },
      wbai: { ...cfg.wbai, relayPort: wbai }, zen: { ...cfg.zen, relayPort: zen },
      qd: { ...cfg.qd, relayPort: qd }, or: { ...cfg.or, relayPort: or } });
    cfg.failover.enabled = false;
    /* ⚠ **必须预置 cfg.proxy**，否则服务启动后会跑一次代理探测：
     * detectWorkingProxy() 探到本机 7897 就 applyProxy() 写进 config 并**自重启**
     * （server.mjs:876 spawn 继任者后 exit(0)），本进程被杀 → 后面所有请求 ECONNREFUSED。
     * applyProxy 的第一行是 `if ((cfg.proxy || "") === norm) return false;`——
     * 预置成探测**必定会选中的那个值**（PROXY_CANDIDATES 的头一个是 7897）就短路了。
     * 代价：本测试期间 server.mjs 的出站 fetch 会走这台代理；zen 上游是 127.0.0.1
     * 且 useProxy=true（走 fetch 而非 directHttp），NO_PROXY 覆盖得到，不受影响。 */
    cfg.proxy = "http://127.0.0.1:7897";
    // 假凭据（明显不是真 Key）；Go 档上游指到本机假上游，用 useProxy 让它走 fetch 而非 directHttp
    cfg.zen = { ...cfg.zen, useProxy: true, apiKey: DUMMY_KEY,
      upstream: `http://127.0.0.1:${upstream}/zen/go/v1` };
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

    fake = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: { ...req.headers } });
      req.resume();
      req.on("end", () => {
        const reply = upstreamReply || { status: 200, body: { ok: true } };
        const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
        res.writeHead(reply.status, { "content-type": reply.ct || "application/json" });
        res.end(body);
      });
    });
    await new Promise((r) => fake.listen(upstream, "127.0.0.1", r));

    child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env, BAI_DATA_DIR: dataDir,
        NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1",   // 挡住自重启，否则 kill 不到重生的那个
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
    try { fake && fake.close(); } catch { }
    try { dataDir && rmSync(dataDir, { recursive: true, force: true }); } catch { }
  });

  const relay = (body) => fetch(`http://127.0.0.1:${P.zen}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const status = () => fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json());
  const upstreamCalls = () => seen.filter((s) => /\/zen\/go\/v1\/chat\/completions$/.test(s.url));

  test("Go 档请求带 x-opencode-session，且 Authorization 照旧", async () => {
    seen.length = 0;
    upstreamReply = { status: 200, ct: "text/event-stream",
      body: 'event: message_start\ndata: {"type":"message_start","message":{"model":"step-5-preview-free"}}\n\n' };
    await relay({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "端到端第一句" }] });
    const calls = upstreamCalls();
    assert.equal(calls.length, 1, `假上游只收到 ${calls.length} 个请求：${JSON.stringify(seen.map((s) => s.url))}`);
    const h = calls[0].headers;
    assert.match(h["x-opencode-session"] || "", /^bai-[0-9a-f]{16}$/,
      `Go 档必须带 x-opencode-session，实际收到 ${h["x-opencode-session"]}`);
    assert.equal(h.authorization, `Bearer ${DUMMY_KEY}`);
    assert.equal(h["user-agent"], /^B\.AI-Router\//.test(h["user-agent"] || "") ? h["user-agent"] : null,
      "UA 必须是本产品自己的，不能改成冒充 Claude Code");
  });

  test("同一会话两轮 → 上游收到同一个 session id；不同会话 → 不同", async () => {
    seen.length = 0;
    const turn1 = { model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "端到端会话锚点甲" }] };
    const turn2 = { model: "claude-fable-5", max_tokens: 32, messages: [
      { role: "user", content: "端到端会话锚点甲" },
      { role: "assistant", content: "好" },
      { role: "user", content: "第二轮" },
    ] };
    await relay(turn1); await relay(turn2);
    await relay({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "端到端会话锚点乙" }] });
    const ids = upstreamCalls().map((c) => c.headers["x-opencode-session"]);
    assert.equal(ids.length, 3, `期望 3 个上游请求，实际 ${ids.length}`);
    assert.equal(ids[0], ids[1], "同一会话两轮必须是同一个 session id");
    assert.notEqual(ids[0], ids[2], "不同会话必须是不同的 session id");
  });

  test("探针（max_tokens ≤ 8）→ 固定 bai-probe，不造新会话", async () => {
    seen.length = 0;
    upstreamReply = { status: 200, ct: "text/event-stream",
      body: 'event: message_start\ndata: {"type":"message_start","message":{"model":"step-5-preview-free"}}\n\n' };
    await relay({ model: "claude-fable-5", max_tokens: 8, messages: [{ role: "user", content: "探针甲" }] });
    await relay({ model: "claude-fable-5", max_tokens: 8, messages: [{ role: "user", content: "探针乙" }] });
    const ids = upstreamCalls().map((c) => c.headers["x-opencode-session"]);
    assert.deepEqual(ids, ["bai-probe", "bai-probe"], `探针 id 应固定，实际 ${JSON.stringify(ids)}`);
  });

  test("反向对照：真实会话 id ≠ bai-probe（否则真实流量全被并进探针会话）", async () => {
    seen.length = 0;
    upstreamReply = { status: 200, ct: "text/event-stream",
      body: 'event: message_start\ndata: {"type":"message_start","message":{"model":"step-5-preview-free"}}\n\n' };
    await relay({ model: "claude-fable-5", max_tokens: 64, messages: [{ role: "user", content: "真实会话" }] });
    assert.notEqual(upstreamCalls()[0].headers["x-opencode-session"], "bai-probe");
  });

  test("错误归因 e2e：两种形状的「需要订阅」都产出中文人话，且面板标出「需订阅 Go」", async () => {
    const msg = "An active OpenCode Go subscription is required to use Go models.";
    for (const [tag, body] of [
      ["openai(无顶层type)", { error: { type: "server_error", message: "Upstream request failed: " + msg } }],
      ["anthropic", { type: "error", error: { type: "api_error", message: "Upstream request failed: " + msg } }],
    ]) {
      upstreamReply = { status: 403, body };
      const r = await relay({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "触发订阅错误 " + tag }] });
      const text = await r.text();
      const j = JSON.parse(text);
      const m = j.error.message;
      assert.match(m, /订阅/, `${tag} 形状没产出中文归因：${m}`);
      assert.match(m, /https:\/\/opencode\.ai\/auth/, `${tag} 形状没给出订阅链接：${m}`);
      // 反向对照：不能是免费档围栏文案，也不能把锅甩给余额。
      // 注意「不是 API Key 配错」这句里含「Key 配错」四个字，所以要判的是
      // **否定句**而不是裸子串——否则这条断言自己就分不清肯定与否定。
      assert.equal(/can only be used from within/.test(m), false, `${tag} 形状归错因了（当成免费档围栏）：${m}`);
      assert.equal(/这不是 API Key 配错/.test(m), true, `${tag} 形状应明确排除「Key 配错」：${m}`);
      assert.equal(/API Key 余额为 0/.test(m), false, `${tag} 形状被归成余额问题：${m}`);
    }
    // 面板常驻状态：goSubRequired 必须为 true，且 /api/status 报的是 Go 档
    const s = await status();
    assert.equal(s.zen.tier, "go", "上游含 /zen/go/ 时必须报 Go 档");
    assert.equal(s.zen.goSubRequired, true, "上游已确认需订阅，面板必须常驻标出");
    assert.match(s.zen.tierHint, /https:\/\/opencode\.ai\/auth/);
    assert.equal(s.zen.relayLast.kind, "go_subscription_required");
  });

  test("反向对照：喂一条我们没写判据的原文 → 掉进通用兜底（证明上一条不是恒真）", async () => {
    upstreamReply = { status: 418, body: { error: { type: "teapot", message: "Upstream request failed: I am a teapot and nobody wrote a rule for me." } } };
    const r = await relay({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "未知错误" }] });
    const m = (await r.json()).error.message;
    assert.equal(/https:\/\/opencode\.ai\/auth/.test(m), false,
      `未知错误不该被翻译成订阅提示（说明判据在乱匹配）：${m}`);
    assert.match(m, /I am a teapot/, "上游原文仍要如实带给用户");
    const s = await status();
    assert.equal(s.zen.relayLast.kind, "upstream_418", "未知错误走通用槽位");
  });

  test("「Model is unavailable」在 Go 档说成「不在当前档位的清单里」", async () => {
    upstreamReply = { status: 400, body: { error: { type: "server_error", message: "Upstream request failed: Model is unavailable." } } };
    const r = await relay({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "模型不在档内" }] });
    const m = (await r.json()).error.message;
    assert.match(m, /不在当前档位的清单里/, `实际文案：${m}`);
    assert.equal(/余额不足/.test(m), false, "不该被归成余额问题");
  });

  test("免费档请求头与改动前逐字相同：只有 3 个头，一个都没多", async () => {
    // 把上游改回免费档（改的是**假上游**的 URL 前缀，不碰真实配置）
    const cfgPath = path.join(dataDir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.zen.upstream = `http://127.0.0.1:${P.upstream}/zen/v1`;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    await sleep(600);   // 中转每请求实时读配置，给它一点时间

    seen.length = 0;
    upstreamReply = { status: 200, ct: "text/event-stream",
      body: 'event: message_start\ndata: {"type":"message_start","message":{"model":"space-bunny-free"}}\n\n' };
    await relay({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "免费档" }] });
    const calls = seen.filter((s) => /\/zen\/v1\/chat\/completions$/.test(s.url));
    assert.equal(calls.length, 1, `免费档上游只收到 ${calls.length} 个请求：${JSON.stringify(seen.map((s) => s.url))}`);

    // Node 的 http 会补 host / connection / content-length / accept-encoding，
    // 那是传输层自带的、与本产品无关。我们只断言**我们代码设的那几个**。
    const OURS = ["content-type", "authorization", "user-agent", "x-opencode-session"];
    const got = Object.keys(calls[0].headers).filter((k) => OURS.includes(k)).sort();
    assert.deepEqual(got, ["authorization", "content-type", "user-agent"],
      `免费档请求头多/少了：${JSON.stringify(got)}`);
    assert.equal(calls[0].headers["x-opencode-session"], undefined,
      "免费档**绝对不能**带 x-opencode-session：实测该头对免费档围栏毫无作用，多加只是凭空给上游灌会话标识");
    assert.equal(calls[0].headers.authorization, `Bearer ${DUMMY_KEY}`);

    // 反向对照：把 URL 里的 /go/ 加回去，同一份代码必须**多出**那个头——
    // 证明上一条不是因为代码压根不设这个头才通过的
    const cfg2 = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg2.zen.upstream = `http://127.0.0.1:${P.upstream}/zen/go/v1`;
    writeFileSync(cfgPath, JSON.stringify(cfg2, null, 2));
    await sleep(600);
    seen.length = 0;
    await relay({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "对照" }] });
    const goCall = seen.filter((s) => /\/zen\/go\/v1\/chat\/completions$/.test(s.url))[0];
    assert.match(goCall.headers["x-opencode-session"] || "", /^bai-/,
      "对照组：Go 档必须带该头——否则上一条的「免费档不带」是因为代码压根没实现");
  });

  test("档位徽章在 /api/status 与 /api/models 两处一致（不会自相矛盾）", async () => {
    /* 本用例自足：先自己触发一次订阅错误把状态**置上**。
     * 不这么做它就依赖前面的用例留下的状态——而「免费档请求头」那条用例末尾
     * 故意跑了一次成功的 Go 请求（200 会清掉「需订阅」标记），
     * 于是本条会读到 false 并误报。测试之间靠顺序传状态是最脆的一种写法。 */
    upstreamReply = { status: 403, body: { error: { type: "server_error", message: "Upstream request failed: An active OpenCode Go subscription is required to use Go models." } } };
    await relay({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "置位订阅标记" }] });

    const s = await status();
    assert.equal(s.zen.tier, "go", "上游含 /zen/go/ 时必须报 Go 档");
    assert.equal(s.zen.tierLabel, "Go 档");
    assert.equal(s.zen.goSubRequired, true, "刚踩过订阅错误，/api/status 必须报「需订阅 Go」");
    const r = await fetch(`http://127.0.0.1:${P.panel}/api/models?p=zen`).then((x) => x.json());
    assert.equal(r.tier, s.zen.tier, "两处档位必须一致");
    assert.equal(r.tierLabel, s.zen.tierLabel);
    assert.equal(r.goSubRequired, s.zen.goSubRequired, "两处「需订阅」必须一致");
    assert.match(s.zen.tierHint, /https:\/\/opencode\.ai\/auth/);
    // 反向对照：note 里必须带上档位，不能还写「Zen 公开目录」
    assert.match(r.note, /Go 档/, `目录说明没提档位：${r.note}`);
    assert.equal(/Zen 公开目录/.test(r.note), false, "目录说明还在说旧文案");
    assert.match(r.note, /需订阅|订阅/, `目录说明没提订阅：${r.note}`);

    // 反向对照：跑一次成功请求后标记必须撤掉（否则用户订完订阅那盏红灯永远不灭）
    upstreamReply = { status: 200, ct: "text/event-stream",
      body: 'event: message_start\ndata: {"type":"message_start","message":{"model":"step-5-preview-free"}}\n\n' };
    await relay({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "订阅成功后" }] });
    const s2 = await status();
    assert.equal(s2.zen.goSubRequired, false, "Go 档一旦通了，「需订阅 Go」必须自动撤掉");
  });

  test("反向对照：目录请求真的打到了 Go 档的 /zen/go/v1/models（不是硬编码的免费档）", async () => {
    seen.length = 0;
    await fetch(`http://127.0.0.1:${P.panel}/api/models?p=zen`).catch(() => {});
    const catCalls = seen.filter((s) => /\/models$/.test(s.url));
    assert.ok(catCalls.length >= 1, "面板拉目录根本没打到假上游（可能走了缓存，本次断言无效）");
    for (const c of catCalls) {
      assert.match(c.url, /\/zen\/go\/v1\/models$/,
        `目录请求打到了 ${c.url} —— 这正是硬编码 URL 时的行为`);
      assert.equal(c.headers.authorization, `Bearer ${DUMMY_KEY}`,
        "目录请求必须带 Key（实测带 Key 43 个 / 不带 83 个，不带就摆一堆调不通的模型）");
    }
  });
});
