/**
 * 回归测试：Zen 免费档的 403 是**探测方式造成的假阳性**，不是渠道故障（v1.0.78）
 *
 * ## 现象
 *   Zen 直连 + 免费档，**真实对话完全正常**（消息正常返回），面板「最近错误」却显示一条红色：
 *     upstream_403: 转移走（HTTP 403）
 *     {"type":"permission_error","message":"[OpenCode Zen] OpenCode's free tier can only be used from within OpenCode"}
 *
 * ## 根因
 *   `/api/test` 的连通性测试发的请求体**没有 tools 字段**，而 Zen 免费档的围栏判据恰恰是
 *   「发给模型的请求里必须带工具」——不带就回 403 FreeTierError。
 *   Claude Code 的真实流量本来就带工具，所以**带工具的探测才代表真实可用性**。
 *
 * ## 覆盖
 *   ① /api/test 的探测请求**带上了最小工具**，且 `max_tokens` **仍是 8**（isProbe 的判据）
 *   ② 免费档+直连的 403 归到「预期内被拒」，**不算故障**；**其它渠道的 403 照旧算故障**
 *   ③ **非 Zen 渠道的探测请求体与改动前逐字一致**（不给别的渠道凭空加字段）
 *   ④ 面板文案能看出**下一步该做什么**（切 Go 档 / 让故障转移落到其它通道）
 *   ⑤ 反向对照：把 tools 从探测体里去掉，① 必须变红（见文件末尾 SABOTAGE）
 *
 * ## 两类测试
 *   · **源码求值**—— 从 server.mjs / panel-common.js 里**按锚点切出真实函数**，
 *     用 new Function 组装起来跑；zen-probe.mjs 是无网络的纯模块，直接 import。
 *     测的是仓库里那份代码本身，不是抄一份重写。
 *   · **端到端**—— 真 spawn 一份 server.mjs（BAI_DATA_DIR 指向系统临时目录，
 *     端口全部动态挑空闲的），前面架一台**假上游**记录它收到的每个请求体，
 *     走完整个中转链路再比对。
 *
 * 红线：所有落盘都在 os.tmpdir() 下，**绝不碰真实的 %APPDATA%\bai-router**。
 *       凭据一律是 'oc_dummy-not-a-real-key' 这类明显假串，源码/命令行/日志里没有真实令牌。
 *       spawn 真 server.mjs 时必须带 BAI_NO_PROXY_AUTODETECT=1（否则它自重启就 kill 不掉了）。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";

/* zen-probe.mjs 是一行网络代码都没有的纯模块，直接 import 测真源码。 */
import {
  zenExpectedRejection, zenProbeClassify, ZEN_FREE_TIER_DIRECT_KIND, ZEN_PROBE_TOOL_ANTHROPIC,
} from "../src/server/zen-probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const PANEL = path.join(REPO, "src", "server", "panel-common.js");
const SRC = readFileSync(SERVER, "utf8");
const PANEL_SRC = readFileSync(PANEL, "utf8");
const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-zen-free-"));

/** 明显不是真 Key 的假凭据。红线：绝不把真 Key 写进任何文件/命令行/日志。 */
const DUMMY_KEY = "oc_dummy-not-a-real-key";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
after(() => { try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/** 上游免费档围栏的真实响应体形状（用户机器上实测截获的原文）。 */
const FREE_TIER_403_BODY = {
  type: "permission_error",
  message: "[OpenCode Zen] OpenCode's free tier can only be used from within OpenCode",
};
/** 另一条**也是 403、但真的是故障的拒绝（模型未授权）。用来证明分类不是「403 一律预期内」。 */
const REAL_FAULT_403_BODY = {
  type: "permission_error",
  message: "[OpenCode Zen] Model access is disabled for this key",
};

/* ------------------------------------------------------------------ *
 * 源码求值工具
 * ------------------------------------------------------------------ */
/** 按大括号配平抠出一个完整函数/箭头函数体（不看缩进——panel-common.js 里
 *  每个函数都是两格缩进，靠 "\n}" 那种顶格锚点是抠不出来的）。 */
function sliceFn(src, anchor) {
  const i = src.indexOf(anchor);
  assert.ok(i >= 0, `源码里找不到锚点：${anchor}`);
  const open = src.indexOf("{", i);
  assert.ok(open > i, `锚点 ${anchor} 之后没找到 "{"`);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const ch = src[k];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error(`锚点 ${anchor} 的大括号没配平`);
}
function sliceBetween(src, startAnchor, endAnchor) {
  const i = src.indexOf(startAnchor);
  assert.ok(i >= 0, `抠源码失败：找不到 ${startAnchor}`);
  const j = src.indexOf(endAnchor, i + startAnchor.length);
  assert.ok(j > i, `抠源码失败：${startAnchor} → ${endAnchor}`);
  return src.slice(i, j);
}

/** 改动前 `/api/test` 探测体的**逐字**样子。③ 用它逐字比对非 Zen 渠道。 */
const PRE_CHANGE_PROBE_BODY = { model: "claude-fable-5[1M]", max_tokens: 8, messages: [{ role: "user", content: "ok" }] };

/** 把 server.mjs 里那个真的 probeBody 抠出来跑（它是个闭包里的箭头函数，切不出作用域，
 *  所以按锚点切出表达式再 new Function 组装）。传 P / ZEN_PROBE_TOOL_ANTHROPIC 进去。
 *  `tier` 是档位名——注意别把它和渠道键 P 搞混（搞混了下面 ③ 会全线误报）。 */
function probeBodyFor(P, tier = "claude-fable-5") {
  const expr = sliceBetween(SRC, "const probeBody = ", "const probe = async");
  assert.ok(expr.includes("=>"), `抠出来的 probeBody 不像箭头函数：${expr.slice(0, 120)}`);
  const trimmed = expr.slice("const probeBody = ".length).trim().replace(/;\s*$/, "");
  const fn = new Function("P", "ZEN_PROBE_TOOL_ANTHROPIC", `return (${trimmed});`);
  return fn(P, ZEN_PROBE_TOOL_ANTHROPIC)(tier);
}

/** 把 panel-common.js 里那个真的 channelState 抠出来跑。闭包依赖（MANIFEST / status /
 *  stOf / credState / wiredTo）由本测试喂桩——它们全是纯查表，不含判据，判据都在 channelState 里。
 *  wiredTo 在真源码里是紧跟其后的一条 const，一起切不出来，这里按同样的写法补上。 */
function channelStateFor({ upstream, cred = { s: "ok", txt: "已就绪", detail: "" }, relayUp = true, manifest = { chainable: true }, wired = false }) {
  const src = sliceFn(PANEL_SRC, "function channelState(key) {")
    + "\nconst wiredTo = (key) => !!wired;";
  const status = { cli: { mode: wired ? "x" : null }, desktop: { mode: null } };
  const stOf = () => ({ relay: { up: relayUp }, upstream });
  return new Function("MANIFEST", "status", "stOf", "credState", "wired", src
    + "\nreturn channelState;")(
      { zen: manifest }, status, stOf, () => cred, wired)("zen");
}

/* ================================================================== *
 * ① 探测请求带上了工具
 * ================================================================== */
describe("① /api/test 的探测请求带上了最小工具", () => {
  test("Zen 渠道：tools 非空，且 max_tokens 仍是 8（isProbe 的判据不许被改坏）", () => {
    const b = probeBodyFor("zen");
    assert.ok(Array.isArray(b.tools), `Zen 探测体必须有 tools 数组，实际 ${JSON.stringify(Object.keys(b))}`);
    assert.equal(b.tools.length, 1, "只要一个工具就够（配额纪律：一个维度一个问题）");
    assert.equal(typeof b.tools[0].name, "string", "工具必须有名字");
    assert.ok(b.tools[0].name.length > 0, "工具名不能是空串");
    assert.ok(b.tools[0].input_schema, "工具必须带 input_schema（/v1/messages 是 Anthropic 形状）");
    /* ★ isProbe 判据：max_tokens <= 8。改了它会连带禁掉短超时与 429 重试。 */
    assert.equal(b.max_tokens, 8, `max_tokens 必须仍是 8（isProbe 的判据），实际 ${b.max_tokens}`);
    assert.ok(b.max_tokens <= 8, "只要 <= 8 就行；> 8 会让入口判成真实对话，禁掉全部重试");
  });

  test("工具形状与 server.mjs 的 wbToOpenAI 对得上（发错形状上游直接 400）", () => {
    /* wbToOpenAI 收的是 Anthropic 形状的 tools：按 t.name / t.input_schema 取值。 */
    const wbSrc = sliceFn(SRC, "function wbToOpenAI(j) {");
    assert.match(wbSrc, /j\.tools[\s\S]{0,200}t\.name/, "wbToOpenAI 必须按 name 取工具名");
    assert.match(wbSrc, /j\.tools[\s\S]{0,300}input_schema/, "wbToOpenAI 必须按 input_schema 取参数");
    assert.ok(ZEN_PROBE_TOOL_ANTHROPIC.name, "本模块导出的工具必须有 name");
    assert.ok(ZEN_PROBE_TOOL_ANTHROPIC.input_schema, "本模块导出的工具必须有 input_schema");
    /* 形状对得上，逐字字段名不能错（input_schema 拼错就退化成空参数，不会报错但探测失真）。 */
    assert.equal(typeof ZEN_PROBE_TOOL_ANTHROPIC.input_schema.type, "string");
    assert.ok(ZEN_PROBE_TOOL_ANTHROPIC.input_schema.properties, "工具参数至少要有一个字段");
  });

  test("刻意不带 tool_choice：只想问「请求形状收不收」，不想逼模型真的去调工具", () => {
    const b = probeBodyFor("zen");
    assert.equal(b.tool_choice, undefined, `探测不该带 tool_choice（会逼出 tool_call，白花配额），实际 ${b.tool_choice}`);
    assert.equal(b.parallel_tool_calls, undefined, "探测不该带 parallel_tool_calls");
  });

  test("反向对照：不带 tools 的请求体确实没有 tools 键（证明上一条不是恒真）", () => {
    const b = PRE_CHANGE_PROBE_BODY;
    assert.equal(b.tools, undefined, "改动前的探测体没有 tools —— 这正是根因本身");
  });
});

/* ================================================================== *
 * ③ 正常渠道零变化
 * ================================================================== */
describe("③ 非 Zen 渠道的探测请求体逐字未变", () => {
  for (const P of ["bai", "sn", "wb", "wbai", "qd", "or"]) {
    test(`${P} 渠道：请求体与改动前逐字一致`, () => {
      const b = probeBodyFor(P);
      assert.deepEqual(b, PRE_CHANGE_PROBE_BODY,
        `${P} 是正常渠道，探测体一个字都不该变（实际 ${JSON.stringify(b)}）`);
      assert.equal(b.tools, undefined, `${P} 不该被凭空加上 tools`);
    });
  }
  test("反向对照：Zen 渠道确实变了（否则上面六条可能只是没抠到真代码）", () => {
    const b = probeBodyFor("zen");
    assert.notDeepEqual(b, PRE_CHANGE_PROBE_BODY, "Zen 探测体应当与改动前不同（多了 tools）");
  });
});

/* ================================================================== *
 * ② 403 的分类
 * ================================================================== */
describe("② 403 分类：预期内 ≠ 故障", () => {
  test("免费档 + 直连的 FreeTierError → 预期内，且归类沿用 zenProbeClassify", () => {
    const txt = JSON.stringify(FREE_TIER_403_BODY);
    const r = zenExpectedRejection(403, txt, { provider: "zen", isGo: false, transport: "direct" });
    assert.equal(r.expected, true, "免费档+直连的 FreeTierError 必须判成预期内");
    assert.equal(r.kind, ZEN_FREE_TIER_DIRECT_KIND, `kind 必须是 ${ZEN_FREE_TIER_DIRECT_KIND}`);
    /* 不另造一套分类：cls 直接取自 zenProbeClassify */
    assert.equal(r.cls, zenProbeClassify(403, txt).cls, "cls 必须复用 zenProbeClassify 的分类，不另造");
    assert.equal(r.cls, "auth", "如实记成 auth：Key 没问题，是这一档在直连下被围栏拒");
  });

  test("★ 其它渠道的 403 仍按故障报（放宽这一条比原 bug 更危险）", () => {
    const txt = JSON.stringify(FREE_TIER_403_BODY);
    for (const provider of ["bai", "sn", "wb", "wbai", "qd", "or"]) {
      const r = zenExpectedRejection(403, txt, { provider, isGo: false, transport: "direct" });
      assert.equal(r.expected, false, `${provider} 渠道的 403 **必须**仍按故障报`);
      assert.equal(r.kind, "", `${provider} 不该拿到预期内的 kind`);
    }
  });

  test("★ 同一个渠道、同一个 403 码，但原因不同 → 仍按故障报", () => {
    const r = zenExpectedRejection(403, JSON.stringify(REAL_FAULT_403_BODY),
      { provider: "zen", isGo: false, transport: "direct" });
    assert.equal(r.expected, false, "「模型未授权」是真故障，不能被洗成预期内");
  });

  test("走 OpenCode 客户端中转时不该被拒 → 报这个错说明是真故障", () => {
    const r = zenExpectedRejection(403, JSON.stringify(FREE_TIER_403_BODY),
      { provider: "zen", isGo: false, transport: "opencode" });
    assert.equal(r.expected, false, "客户端中转那条路模型手上就有工具，报这个错是真故障");
  });

  test("Go 档的 403 是「需要订阅」，另一条产品级限制，不在这里吞掉", () => {
    const r = zenExpectedRejection(403, JSON.stringify(FREE_TIER_403_BODY),
      { provider: "zen", isGo: true, transport: "direct" });
    assert.equal(r.expected, false, "Go 档由 go_subscription_required 单独归因，不走本函数");
  });

  test("非 403（401/429/500）与非免费档文案：一律 expected=false", () => {
    const txt = JSON.stringify(FREE_TIER_403_BODY);
    assert.equal(zenExpectedRejection(401, txt, { provider: "zen" }).expected, false, "401 是鉴权，不是围栏");
    assert.equal(zenExpectedRejection(429, txt, { provider: "zen" }).expected, false, "429 是限流");
    assert.equal(zenExpectedRejection(500, txt, { provider: "zen" }).expected, false, "500 是上游故障");
    assert.equal(zenExpectedRejection(403, "Forbidden", { provider: "zen" }).expected, false, "没有 FreeTierError 字样就不认");
    assert.equal(zenExpectedRejection(403, "", { provider: "zen" }).expected, false, "空正文不认（宁可漏判成故障）");
  });

  test("反向对照：拿不到上游原文时判成故障（证明判据确实在读原文）", () => {
    /* 本机中转会把 FreeTierError 转译成中文，原文一丢就再也判不出来——
     * 所以 readProbeJson 必须把 raw 挂在错误上。这条同时锁住那行代码。 */
    const r = zenExpectedRejection(403, "上游拒绝请求（HTTP 403）：[OpenCode Zen] ...", { provider: "zen" });
    assert.equal(r.expected, false, "转译后的中文不含 FreeTierError 字样，必须按故障报");
    assert.match(SRC, /err\.upstreamRaw = raw/, "readProbeJson 必须把上游原文挂到错误上，否则永远判不出预期内");
    assert.match(SRC, /err\.upstreamStatus = response\.status/, "还得把上游状态码挂上（转译后码可能对不上）");
  });
});

/* ================================================================== *
 * ④ 面板文案可执行
 * ================================================================== */
describe("④ 面板：预期内被拒 ≠ 红色故障，且文案给出下一步", () => {
  const WHY = zenExpectedRejection(403, JSON.stringify(FREE_TIER_403_BODY), { provider: "zen" }).why;

  test("预期内 → warn（中性），不进「故障」那一栏", () => {
    const s = channelStateFor({ upstream: { tested: false, expected: true, expectedWhy: WHY, expectedTiers: ["Space-Bunny-Free"], error: "上游拒绝请求（HTTP 403）" } });
    assert.equal(s.s, "warn", `预期内被拒不该报成 err（那样会亮红灯），实际 s=${s.s} txt=${s.txt}`);
    assert.notEqual(s.s, "err", "绝不能是 err");
    assert.equal(s.txt, "预期内被拒");
    assert.match(s.detail, /Space-Bunny-Free/, "副行要说清是哪一档");
  });

  test("★ 文案能看出下一步该做什么（两条路都点出来）", () => {
    const s = channelStateFor({ upstream: { tested: false, expected: true, expectedWhy: WHY, expectedTiers: [] } });
    assert.match(s.detail, /Go 档/, "必须点出「切 Go 档」这条");
    assert.match(s.detail, /opencode\.ai\/zen\/go\/v1/, "切 Go 档要给出确切的上游地址，否则用户不知道填哪");
    assert.match(s.detail, /opencode\.ai\/auth/, "切 Go 档要给出订阅入口，否则用户不知道去哪订阅");
    assert.match(s.detail, /故障转移/, "必须点出「让故障转移落到其它通道」这条");
    assert.match(s.detail, /wb\/wbai\/or/, "要指名可落到的通道，否则用户不知道还能用谁");
    /* 免费档已被服务端封死，**不能再把用户往「改走客户端中转」那条路上引**——
     * 那条路实测也已过不去，照旧引导会让人反复尝试一条无效的路径。 */
    assert.doesNotMatch(s.detail, /改走 OpenCode 客户端中转/, "不该再推荐已失效的客户端中转这条出路");
  });

  test("★ 真故障仍然是红色故障（不能被上面两条带跑）", () => {
    const s = channelStateFor({ upstream: { tested: false, expected: false, error: "上游返回 HTTP 500" } });
    assert.equal(s.s, "err", "真故障必须照旧报成 err（灯是红的）");
    assert.equal(s.txt, "上游不可用");
  });

  test("反向对照：没有 expected 字段（老服务端）时行为一字不变", () => {
    const s = channelStateFor({ upstream: { tested: false, error: "上游返回 HTTP 500" } });
    assert.equal(s.s, "err", "没带 expected 的老载荷必须仍走原来的分支");
    const ok = channelStateFor({ upstream: { tested: true, model: "m", ms: 12 } });
    assert.equal(ok.s, "ok", "通过时不受影响");
  });

  test("面板的「最近错误」副行对预期内这一类换前缀（与真错误区分开）", () => {
    assert.match(PANEL_SRC, /rl\.kind === "free_tier_direct" \? "已知限制" : "最近错误"/,
      "预期内被拒不该与真故障共用「最近错误」这个前缀");
    /* 面板必须真的认得这个 kind，否则前缀永远走不到那个分支。 */
    assert.match(SRC, new RegExp(`noteRelayError\\(p, ZEN_FREE_TIER_DIRECT_KIND`),
      "中转路径必须用这个产品级 kind");
    assert.match(PANEL_SRC, /"free_tier_direct"/, "面板必须按字面量认这个 kind");
  });
});

/* ================================================================== *
 * e2e：真 spawn server.mjs，假上游记录它收到的每个请求体
 * ================================================================== */
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

describe("e2e：/api/test 真跑一遍，工具确实发到了上游", () => {
  let child, fake, dataDir, P;
  const seen = [];             // 假上游收到的每个请求（含解析后的 body）
  let upstreamReply = null;    // 每个用例自己设

  before(async () => {
    const [bai, zen, qd, panel, upstream, mm] = await freePorts(6);
    P = { bai, zen, qd, panel, upstream, mm };
    dataDir = mkdtempSync(path.join(TMPROOT, "boot-"));

    const cfg = JSON.parse(readFileSync(path.join(REPO, "src", "server", "config.defaults.json"), "utf8"));
    cfg.relayPort = bai; cfg.panelPort = panel;
    Object.assign(cfg, {
      sn: { ...cfg.sn, relayPort: 15881 }, wb: { ...cfg.wb, relayPort: 15882 },
      wbai: { ...cfg.wbai, relayPort: 15883 }, zen: { ...cfg.zen, relayPort: zen },
      qd: { ...cfg.qd, relayPort: qd }, mm: { ...cfg.mm, relayPort: mm },
      or: { ...cfg.or, relayPort: 15884 },
    });
    cfg.failover.enabled = false;   // 只测 zen 自己的链路，别让别的渠道搅进来
    /* ⚠ 必须预置 cfg.proxy：否则启动后跑一次代理探测，探到本机 7897 就 applyProxy()
     * **自重启**（spawn 继任者后 exit(0)），本进程被杀 → 后面全 ECONNREFUSED。
     * applyProxy 第一行是「与现值相同就短路」，预置成探测必定选中的头一个值即可。 */
    cfg.proxy = "http://127.0.0.1:7897";
    cfg.zen = {
      ...cfg.zen, apiKey: DUMMY_KEY, transport: "direct",
      upstream: `http://127.0.0.1:${upstream}/zen/v1`,   // **免费档**（没有 /zen/go）
    };
    /* ⚠ **qd 必须给一个令牌**（2026-10-24 补）：qd 的探测在**发请求之前**先
     *   要令牌（server.mjs 的 qdEnsureToken ⇒ 没有令牌就直接判「不可用」，
     *   **一个请求都不发**）⇒ 假上游自然「一个 qd 请求都没收到」。
     *   ⚠ 这个失败是**环境相关**的：机器上装了 Qoder、令牌文件在时，它能过；
     *   令牌不在（没装 Qoder / 没登录）时就红 ⇒ 跟被测的那段逻辑无关。
     *   ⇒ 这里给一个**假的**令牌（假的占位串，不是真凭据）⇒ 探测能走到假上游。 */
    cfg.qd = { ...cfg.qd, token: DUMMY_KEY, upstream: `http://127.0.0.1:${upstream}/qd/v1` };
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

    fake = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = null;
        try { body = JSON.parse(raw); } catch { /* 非 JSON */ }
        seen.push({ url: req.url, raw, body });
        const reply = upstreamReply || { status: 200, ct: "application/json", body: { ok: true } };
        const out = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
        res.writeHead(reply.status, { "content-type": reply.ct || "application/json" });
        res.end(out);
      });
    });
    await new Promise((r) => fake.listen(upstream, "127.0.0.1", r));

    child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env, BAI_DATA_DIR: dataDir,
        NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1", BAI_NO_PROXY_AUTODETECT: "1",
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

  /* v1.0.81：POST /api/test 改成**立刻回包、探测在后台跑**（原先它在 HTTP 请求里
     同步跑完四档，最坏 ≈545 秒，而面板读超时只有 12 秒 —— 上游一慢就把一次正常的
     探测报成「读取超时」）。所以这里发完 POST 必须**轮 /api/status 等它跑完**，
     再把 upstream 那一块还原成过去 POST 的返回形状，下面的断言一句都不用改。
     ⚠ 判「跑完」不能只看 running===false：POST 返回时探测可能已经跑完（假上游极快），
       那时 running 压根没被观测到 true —— 那样会立刻读到**上一次**的残留结果。
       所以还要看 at ≥ 发请求那一刻。 */
  const test_ = async (provider, extra = {}) => {
    const t0 = Date.now();
    const post = await fetch(`http://127.0.0.1:${P.panel}/api/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, all: true, ...extra }),
      signal: AbortSignal.timeout(120000),
    }).then((r) => r.json());
    assert.equal(post.started, true, `POST 应回 started:true，实际 ${JSON.stringify(post)}`);
    const up = await (async () => {
      const t1 = Date.now();
      while (Date.now() - t1 < 100000) {
        const s = await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json());
        const u = (s[provider] || s).upstream || {};
        if (!u.running && u.at && Date.parse(u.at) >= t0 - 1000) return u;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("探测 100 秒没跑完");
    })();
    const tiers = up.tiers || [];
    return {
      ok: up.ok, provider, tiers,
      pass: tiers.filter((t) => t.ok).length, total: tiers.length,
      active: up.active, expected: up.expected,
    };
  };
  const status = () => fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json());
  const zenUpstreamCalls = () => seen.filter((s) => /\/zen\/v1\/chat\/completions$/.test(s.url));

  test("★ Zen 探测：上游真的收到了非空的 tools", async () => {
    seen.length = 0;
    upstreamReply = { status: 200, ct: "application/json", body: { model: "space-bunny-free" } };
    const r = await test_("zen");
    const calls = zenUpstreamCalls();
    assert.ok(calls.length > 0, `假上游一个 zen 请求都没收到：${JSON.stringify(seen.map((s) => s.url))}`);
    for (const c of calls) {
      assert.ok(Array.isArray(c.body.tools) && c.body.tools.length > 0,
        `发给上游的请求必须带非空 tools，实际 ${JSON.stringify(c.body.tools)}`);
      assert.equal(typeof c.body.tools[0].function.name, "string",
        "转成 OpenAI 形状后工具名应落在 function.name");
      assert.ok(c.body.tools[0].function.parameters, "参数应落在 function.parameters");
    }
    assert.ok(r.tiers.length > 0, "/api/test 应当返回逐档结果");
  });

  test("★ 非 Zen 渠道：上游收到的请求体与改动前逐字一致（没有 tools）", async () => {
    seen.length = 0;
    upstreamReply = { status: 200, ct: "application/json", body: { model: "lite" } };
    await test_("qd");
    const calls = seen.filter((s) => /\/qd\/v1\/chat\/completions$/.test(s.url));
    assert.ok(calls.length > 0, `假上游一个 qd 请求都没收到：${JSON.stringify(seen.map((s) => s.url))}`);
    for (const c of calls) {
      assert.equal(c.body.tools, undefined, `qd 的请求体不该有 tools，实际 ${JSON.stringify(c.body.tools)}`);
      assert.equal(c.body.tool_choice, undefined, "qd 的请求体不该有 tool_choice");
    }
  });

  test("★ 免费档 + 直连被拒 403：判成「预期内」，不算故障", async () => {
    seen.length = 0;
    upstreamReply = { status: 403, body: FREE_TIER_403_BODY };
    const r = await test_("zen");
    assert.equal(r.expected, true, `免费档+直连的 403 必须判成预期内，实际 ${JSON.stringify(r.tiers.map((x) => x.error))}`);
    assert.equal(r.ok, false, "这一档确实发不出消息，ok 仍要如实是 false");
    for (const t of r.tiers) {
      assert.equal(t.expected, true, `每档都应标成预期内：${JSON.stringify(t)}`);
      assert.equal(t.expectedKind, ZEN_FREE_TIER_DIRECT_KIND, "kind 必须是产品级标签");
      assert.match(t.expectedWhy, /Go 档/, "文案要给出下一步");
      assert.match(t.expectedWhy, /故障转移/, "文案要给出下一步：另一条是让故障转移落到其它通道");
    }
    const st = await status();
    assert.equal(st.zen.upstream.expected, true, "/api/status 必须把这个状态透给面板");
    assert.match(st.zen.upstream.expectedWhy, /Go 档/, "透过去的 why 也要有可执行的下一步");
  }, { timeout: 120000 });

  test("★ 同样 403 但原因不同（模型未授权）：仍然按故障报", async () => {
    seen.length = 0;
    upstreamReply = { status: 403, body: REAL_FAULT_403_BODY };
    const r = await test_("zen");
    assert.equal(r.expected, false, "真故障不能被洗成预期内");
    for (const t of r.tiers) {
      assert.equal(t.expected, undefined, `真故障的档位不该带 expected，实际 ${JSON.stringify(t)}`);
    }
    const st = await status();
    assert.equal(st.zen.upstream.expected, false, "/api/status 也要如实报 false");
    assert.equal(st.zen.upstream.tested, false, "而 tested 仍是 false（面板据此亮红灯）");
  }, { timeout: 120000 });

  test("中转路径：预期内这一类用产品级 kind，不再是笼统的 upstream_403", async () => {
    seen.length = 0;
    upstreamReply = { status: 403, body: FREE_TIER_403_BODY };
    await fetch(`http://127.0.0.1:${P.zen}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-fable-5", max_tokens: 8, messages: [{ role: "user", content: "ok" }], tools: [ZEN_PROBE_TOOL_ANTHROPIC] }),
      signal: AbortSignal.timeout(30000),
    }).catch(() => { });
    const st = await status();
    const rl = st.zen.relayLast || {};
    assert.equal(rl.kind, ZEN_FREE_TIER_DIRECT_KIND, `relayLast.kind 应当是产品级标签，实际 ${rl.kind}（消息：${rl.message}）`);
    assert.match(rl.message, /Go 档/, "relayLast 的文案要点出 Go 档");
    assert.match(rl.message, /故障转移/, "relayLast 的文案要点出另一条：让故障转移落到其它通道");
    assert.doesNotMatch(rl.message, /^\s*转移走（HTTP 403）：\{/, "不能被覆盖成笼统的「转移走 + JSON 原文」（那正是本次要修的现象）");
  }, { timeout: 60000 });
});

/* ================================================================== *
 * 反向对照（执行器见 zen-probe-free-tier-sabotage-run.mjs）
 * ================================================================== */
const SABOTAGE = [
  {
    name: "probe-drops-tools",
    file: "src/server/server.mjs",
    from: '        ? { model: tier + "[1M]", max_tokens: 8, messages: [{ role: "user", content: "ok" }], tools: [ZEN_PROBE_TOOL_ANTHROPIC] }',
    to: '        ? { model: tier + "[1M]", max_tokens: 8, messages: [{ role: "user", content: "ok" }] }',
    where: "/api/test 的 Zen 探测体去掉 tools",
    reds: "① Zen 探测：上游真的收到了非空的 tools",
  },
  {
    name: "probe-bumps-max-tokens",
    file: "src/server/server.mjs",
    from: '        ? { model: tier + "[1M]", max_tokens: 8, messages: [{ role: "user", content: "ok" }], tools: [ZEN_PROBE_TOOL_ANTHROPIC] }',
    to: '        ? { model: tier + "[1M]", max_tokens: 64, messages: [{ role: "user", content: "ok" }], tools: [ZEN_PROBE_TOOL_ANTHROPIC] }',
    where: "/api/test 的 Zen 探测体把 max_tokens 抬到 64",
    reds: "① max_tokens 仍是 8（isProbe 的判据不许被改坏）",
  },
  {
    name: "tools-to-every-channel",
    file: "src/server/server.mjs",
    from: '      const probeBody = (tier) => (P === "zen"',
    to: '      const probeBody = (tier) => (true',
    where: "给所有渠道都加上 tools",
    reds: "③ qd 渠道：请求体与改动前逐字一致",
  },
  {
    name: "classify-any-provider",
    file: "src/server/zen-probe.mjs",
    from: '  if (provider !== "zen") return base;',
    to: '  if (provider === "__never__") return base;',
    where: "预期内判定不再限定 zen 渠道",
    reds: "② 其它渠道的 403 仍按故障报",
  },
  {
    name: "classify-any-403",
    file: "src/server/zen-probe.mjs",
    from: '  if (!/FreeTierError|only be used from within/i.test(t)) return base;',
    to: '  if (false) return base;',
    where: "只认状态码 403，不认 FreeTierError 文案",
    reds: "② 同一个渠道、同一个 403 码，但原因不同 → 仍按故障报",
  },
  {
    name: "panel-still-red",
    file: "src/server/panel-common.js",
    from: '    if (up.expected === true) {',
    to: '    if (false) {',
    where: "面板不再把预期内判成中性",
    reds: "④ 预期内 → warn（中性），不进「故障」那一栏",
  },
  {
    name: "panel-vague-copy",
    file: "src/server/panel-common.js",
    from: 'detail: (names ? `（${names} 档）` : "") + (up.expectedWhy || ""),',
    to: 'detail: (names ? `（${names} 档）` : "") + "请稍后重试。",',
    where: "文案改成「请稍后重试」这种猜谜式提示",
    reds: "④ 文案能看出下一步该做什么",
  },
  {
    name: "relay-kind-back-to-403",
    file: "src/server/server.mjs",
    from: '        noteRelayError(p, ZEN_FREE_TIER_DIRECT_KIND,\n',
    to: '        noteRelayError(p, "upstream_403",\n',
    where: "中转路径退回笼统的 upstream_403",
    reds: "e2e 中转路径：预期内这一类用产品级 kind",
  },
];

/* 执行器用的两个钩子：
 *   --sabotage        给人看的手法表（grep SABOTAGE 可定位）
 *   --sabotage-json   机器读的手法表（执行器用这个，避免在人类文案里 JSON.parse） */
if (process.argv.includes("--sabotage-json")) {
  console.log(JSON.stringify(SABOTAGE, null, 2));
  process.exit(0);
}
if (process.argv.includes("--sabotage")) {
  console.log(`zen-probe-free-tier 反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）：`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(28)} ${s.where}\n  ${"".padEnd(28)} → 会打红: ${s.reds}`);
  const only = process.argv[process.argv.indexOf("--sabotage") + 1];
  if (only && !only.startsWith("--")) {
    const s = SABOTAGE.find((x) => x.name === only);
    if (!s) { console.error(`没有这条手法：${only}。可用：${SABOTAGE.map((x) => x.name).join(", ")}`); process.exit(2); }
    console.log(JSON.stringify(s, null, 2));
  }
  process.exit(0);
}
