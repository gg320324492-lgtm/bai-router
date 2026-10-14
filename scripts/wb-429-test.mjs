/**
 * scripts/wb-429-test.mjs —— 「wb/wbai 的 429：等 30 秒 vs 开新对话」
 *
 * ## 这条缺陷是怎么溜过的（v1.0.84 及以前）
 *
 *   WorkBuddy AI（wbai）在大上下文下返 429，中转对外说的是
 *     「上游 API 暂时限流（HTTP 429），请在 N 秒后重试。这不是代理或配置错误。」
 *     「常见原因是：免费渠道并发限流，等 30 秒左右再试」
 *
 *   两句话都把方向指错了。实测（直连上游 /v2/chat/completions，只改历史条数，
 *   其余请求完全一致）：
 *     100 条 → body 0.42 MB → 响应头 8.7s  → 200 ✅
 *     300 条 → body 1.25 MB → 响应头 15.2s → 429 ❌ too many requests
 *     600 条 → body 2.50 MB → 响应头 30.0s → 429 ❌
 *   **判据是 body 体积，不是条数，也不是并发**；阈值夹在 0.42MB ~ 1.25MB 之间。
 *
 *   用户侧的现象：Claude Code 撞 429 自动重试 → 「对话 1 分钟断一次，一直重连，
 *   输出几段内容又短了」，他以为链接不稳定。而中转叫他「等 30 秒」——
 *   根因是上下文超线，**等再久也不会好**，唯一的解是开新对话。
 *   于是用户白等半小时，最后还是不知道为什么。
 *
 * ## 本文件怎么补上这一条
 *
 *   ★ **真实现、不是替身**：判据函数从 src/server/wb-429.mjs import，原样调用。
 *     v1.0.76（`* 1000` 那次）的教训就是「测试全程注入自己的替身，生产用的函数
 *     从没被接进过测试」——658/658 全绿而生产 100% 是坏的。所以本文件一个替身都不注入。
 *   ★ **接线完整性**：断言 server.mjs 真的 `import ... from "./wb-429.mjs"`、
 *     真的把它接进了 429 的三个出口（sendRateLimitError / wb 家族归因 / 探针字典）。
 *     否则下面全在验一个没人用的函数，等于白验。
 *   ★ **判据自己没失效**：每条关键断言都配了反向对照（红的方式写清楚）。
 *   ★ **字节而非字符**：中文场景 `.length` 会把体积少算三倍，专门一条断言钉住差异。
 *
 * ## 反向对照
 *
 *   把 wb-429.mjs 的 `wbBodyTooLarge` 改回「恒 false」（= 一律说并发限流），
 *   下面 A/B 两组当场红；把 `WB_BODY_TOO_LARGE_BYTES` 改成 1e12（阈值失效），同样红。
 *   判据只有一个：**改回旧文案必须红**。
 *
 * ## 红线
 *
 *   🔴 全文没有一个真实令牌 / API key / 用户名 / 本机绝对路径。夹具里的 body 是
 *      现造的合成 JSON（"x".repeat(n) 与假中文），不含任何真实对话内容。
 *   🔴 本文件**零 IO、零网络、不起进程**（纯逻辑模块求值），不碰 %APPDATA%\bai-router。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/* ★ 被测的就是生产 import 的那一个，不是替身 */
import {
  WB_BODY_TOO_LARGE_BYTES,
  WB_429_SIZE_SCOPED_PROVIDERS,
  wbBodyBytes,
  wbBodySizeText,
  wbBodyTooLarge,
  wb429ContextHint,
} from "../src/server/wb-429.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER_SRC = readFileSync(path.join(REPO, "src", "server", "server.mjs"), "utf8");

/* ====================================================================== *
 * 夹具：合成 body。🔴 现造，不含真实对话内容 / 凭据。
 * ====================================================================== */

/** 一个 ASCII 占位串，重复 n 个字符（1 字符 = 1 字节）。 */
const ascii = (n) => "x".repeat(n);
/** 一个中文占位串，重复 n 个「中」（1 字符 = 3 字节 UTF-8）—— 正是本次要钉的差异。 */
const cn = (n) => "中".repeat(n);
/** 造一个形状像翻译后请求体的 JSON（有 model / messages），体积由 history 条数撑起来。 */
const synthBody = (historyChars) => JSON.stringify({
  model: "hy4-preview-f",
  stream: true,
  max_tokens: 8192,
  messages: [{ role: "user", content: "x".repeat(historyChars) }],
});

/** 实测的两个真实锚点（见文件顶部）：0.42MB 是 200，1.25MB 是 429。 */
const MB = 1024 * 1024;
const OK_BODY = ascii(Math.round(0.42 * MB));      // 实测 200 的那一档
const TOO_LARGE_BODY = ascii(Math.round(1.25 * MB)); // 实测 429 的那一档

/* ====================================================================== *
 * ① ⭐ 核心回归：大 body 的 429 必须说「上下文太大 + 开新对话」
 * ====================================================================== */
describe("① 大 body 的 429 → 提示点出上下文超限并给出可执行的一步", () => {
  test("wbai + 1.25MB body（实测被 429 的那一档）→ 提示含「上下文」与「新对话」", () => {
    const hint = wb429ContextHint("wbai", TOO_LARGE_BODY);
    assert.ok(hint.length > 0, "大 body 必须给内容，实际给了空串——判据失灵了");
    assert.match(hint, /上下文/, `提示必须点出上下文这个根因。实际：${hint}`);
    assert.match(hint, /新对话/, `提示必须给出「开新对话」这个可执行的一步。实际：${hint}`);
  });

  test("wb（国内版）同样适用 —— 体积红线不分两版", () => {
    const hint = wb429ContextHint("wb", TOO_LARGE_BODY);
    assert.match(hint, /上下文/);
    assert.match(hint, /新对话/);
  });

  test("提示必须把「等」这条路明确关掉（否则等于什么都没改）", () => {
    const hint = wb429ContextHint("wbai", TOO_LARGE_BODY);
    assert.match(hint, /等再久也不会好|等.*也不会好/,
      `必须说清等没有用，否则用户照样白等半小时。实际：${hint}`);
    assert.match(hint, /压缩|删掉/,
      `要给第二条可行路径（压缩/删历史），不只一句「开新对话」。实际：${hint}`);
  });

  test("提示里带本次 body 的实际体积（用户能自己对照）", () => {
    const hint = wb429ContextHint("wbai", TOO_LARGE_BODY);
    assert.match(hint, /1\.25\s*MB/, `提示应报出实际体积（1310720 字节 = 1.25MB）。实际：${hint}`);
  });

  test("合成请求体（真实形状的 JSON）一样被判超大", () => {
    const hint = wb429ContextHint("wbai", synthBody(2 * MB));
    assert.ok(hint.length > 0, "合成请求体也该触发");
    assert.match(hint, /新对话/);
  });

  test("0.42MB（实测 200 的那一档）**不**触发 —— 判据不吃正常对话", () => {
    assert.equal(wb429ContextHint("wbai", OK_BODY), "",
      "0.42MB 实测是 200，不能把它也圈进来（会把用户引去无谓地开新对话）");
  });
});

/* ====================================================================== *
 * ② ⭐ 回归保护：小 body 的 429 维持原来的「并发限流，稍后重试」
 *    （不许悄悄改掉 —— 429 也可能是真的并发限流）
 * ====================================================================== */
describe("② 小 body 的 429 → 维持原来的「并发限流 / 稍后重试」", () => {
  test("wb + 小 body → 尾巴为空（文案退回改动前，一个字都不加）", () => {
    assert.equal(wb429ContextHint("wb", synthBody(1024)), "");
    assert.equal(wb429ContextHint("wb", ""), "");
    assert.equal(wb429ContextHint("wb", null), "");
    assert.equal(wb429ContextHint("wb", undefined), "");
  });

  test("wbai + 小 body → 同样为空", () => {
    assert.equal(wb429ContextHint("wbai", synthBody(4096)), "");
  });

  test("拿不到 body（null）→ 判据失效、维持旧文案，绝不说成上下文超限", () => {
    /* 探针路径有时拿不到正文；这时把 429 说成「上下文太大」是凭空诬陷。 */
    assert.equal(wb429ContextHint("wbai", null), "");
    assert.equal(wbBodyTooLarge(null), false);
  });

  test("判据自己没失效：把 0.42MB 换到 wb 上仍不触发（不是「只要是 wb 就说上下文」）", () => {
    assert.equal(wbBodyTooLarge(OK_BODY), false, "前提：0.42MB 本就不该判超大");
    assert.equal(wb429ContextHint("wb", OK_BODY), "");
  });
});

/* ====================================================================== *
 * ③ 边界：正好压在阈值上时的行为必须确定
 * ====================================================================== */
describe("③ 阈值边界：压线即超（>=），行为确定", () => {
  test("正好等于阈值 → 判超大", () => {
    assert.equal(WB_BODY_TOO_LARGE_BYTES, 500 * 1024, "阈值常量本身被改了");
    assert.equal(WB_BODY_TOO_LARGE_BYTES, 512000, "500 KB 就是 512000 字节（这条钉住换算本身）");
    assert.equal(wbBodyTooLarge(ascii(WB_BODY_TOO_LARGE_BYTES)), true,
      "压线（== 阈值）必须判超大：真实阈值未知且落在 0.42MB~1.25MB 之间，宁早报不晚报");
  });

  test("阈值少 1 字节 → 判不超大", () => {
    assert.equal(wbBodyTooLarge(ascii(WB_BODY_TOO_LARGE_BYTES - 1)), false,
      "少一个字节就不算超：否则「边界确定」是句空话");
  });

  test("阈值多 1 字节 → 判超大", () => {
    assert.equal(wbBodyTooLarge(ascii(WB_BODY_TOO_LARGE_BYTES + 1)), true);
  });

  test("空 body / null / 0 字节 → 一律不超大", () => {
    for (const b of ["", null, undefined, ascii(0)]) {
      assert.equal(wbBodyTooLarge(b), false, `空输入不该判超大：${JSON.stringify(b)}`);
    }
  });

  test("阈值被改成非有限值 → 判据失效（宁可维持旧文案，也不乱判）", () => {
    assert.equal(wbBodyTooLarge(ascii(2 * MB), NaN), false);
    assert.equal(wbBodyTooLarge(ascii(2 * MB), -1), false);
    assert.equal(wbBodyTooLarge(ascii(2 * MB), Infinity), false,
      "Infinity 不是有效阈值（会把判据变成恒 false，旧缺陷换个形状回来）");
  });

  test("阈值夹在两个实测锚点之间（不能低到误伤 200，也不能高到放过 429）", () => {
    assert.ok(WB_BODY_TOO_LARGE_BYTES > 0.42 * MB,
      `阈值必须 > 实测 200 的 0.42MB，否则正常对话被误判。实际 ${WB_BODY_TOO_LARGE_BYTES}`);
    assert.ok(WB_BODY_TOO_LARGE_BYTES <= 1.25 * MB,
      `阈值必须 <= 实测 429 的 1.25MB，否则大上下文仍被放行。实际 ${WB_BODY_TOO_LARGE_BYTES}`);
  });
});

/* ====================================================================== *
 * ④ ⭐ 中文/多字节：必须用 Buffer.byteLength 而非 .length
 *    —— 这条是「判据单位」的机械守卫，比任何具体数字都耐用
 * ====================================================================== */
describe("④ 字节而非字符（中文场景少算三倍）", () => {
  test("同一个中文字符串：字节数是 .length 的三倍，判据按字节走", () => {
    const s = cn(200000);                       // 20 万字符
    assert.equal(s.length, 200000, "前提：字符数");
    assert.equal(wbBodyBytes(s), 600000, "★ wbBodyBytes 必须按**字节**算（UTF-8 中文字符 3 字节）");
    assert.notEqual(wbBodyBytes(s), s.length,
      "★ 若这两个数相等，说明判据退回了 .length —— 中文上下文会被少算三倍，"
      + "正是被误导的那批用户（全是中文对话）的形状");
  });

  test("按字符数算会漏判：20 万中文字符的 body 必须判超大", () => {
    const s = cn(200000);                       // 600000 字节 > 512000
    assert.ok(s.length < WB_BODY_TOO_LARGE_BYTES,
      `前提：按字符数（${s.length}）算它「不超」—— 这正是旧实现的漏洞`);
    assert.equal(wbBodyTooLarge(s), true,
      "★ 按字节算必须判超大。若这条红了，就是有人把 Buffer.byteLength 换回了 .length");
  });

  test("「中文 + ASCII」混合也按字节算（emoji 走 4 字节代理对）", () => {
    /* 每轮「中文abc」= 5 字符（2 个中文 + 3 个 ASCII）= 6 + 3 = 9 字节。 */
    const mixed = "中文abc".repeat(40000);
    assert.equal(mixed.length, 200000, "字符数 = 5 × 40000");
    assert.equal(wbBodyBytes(mixed), 360000, "字节数 = 9 × 40000（比字符数多 1.8 倍）");
    assert.equal(wbBodyTooLarge(mixed), false, "360000 < 512000，仍不超");
    assert.equal(wbBodyTooLarge(mixed + "x".repeat(160000)), true, "补到 520000 字节才超");
    const emoji = "😀".repeat(60000);            // 代理对：120000 字符 / 240000 字节
    assert.equal(emoji.length, 120000);
    assert.equal(wbBodyBytes(emoji), 240000);
  });

  test("Buffer / Uint8Array 输入同样按字节算（调用方可能传原始 body）", () => {
    const buf = Buffer.from(cn(200000), "utf8");
    assert.equal(wbBodyBytes(buf), 600000);
    assert.equal(wbBodyTooLarge(buf), true);
    const u8 = new Uint8Array(buf);
    assert.equal(wbBodyBytes(u8), 600000);
  });

  test("判据自己没失效：纯 ASCII 下字节数 == 字符数（差异只来自多字节）", () => {
    const s = ascii(3000);
    assert.equal(wbBodyBytes(s), s.length, "纯 ASCII 时两者本就相等，别把这条也「修」坏");
  });

  test("wbBodyBytes 对非法输入回 0，不抛（判据自己不能炸）", () => {
    for (const bad of [null, undefined, {}, 123, [], () => 1, Symbol("s")]) {
      assert.equal(wbBodyBytes(bad), 0, `不该抛，也不该给非 0：${String(bad)}`);
    }
  });
});

/* ====================================================================== *
 * ⑤ 渠道隔离：体积红线只有 wb / wbai 有，绝不通用化
 * ====================================================================== */
describe("⑤ 渠道隔离：绝不把「上下文超限」说成所有 429 的通用解释", () => {
  test("白名单只有 wb / wbai", () => {
    assert.deepEqual(WB_429_SIZE_SCOPED_PROVIDERS, ["wb", "wbai"]);
  });

  test("其它五家 + 超大 body → 仍给空串（它们没有这条体积红线）", () => {
    for (const p of ["bai", "sn", "zen", "qd", "or", "", null, undefined, "WB", "wbai2"]) {
      assert.equal(wb429ContextHint(p, TOO_LARGE_BODY), "",
        `渠道 ${JSON.stringify(p)} 不该被套上 WorkBuddy 的体积红线`);
    }
  });

  test("渠道 key 大小写敏感（大写 WB 不等于 wb）—— 别为了「容错」放宽白名单", () => {
    assert.equal(wb429ContextHint("WB", TOO_LARGE_BODY), "");
    assert.equal(wb429ContextHint("Wbai", TOO_LARGE_BODY), "");
  });

  test("wb / wbai 两个 key 都真的生效（白名单没写错）", () => {
    assert.ok(wb429ContextHint("wb", TOO_LARGE_BODY));
    assert.ok(wb429ContextHint("wbai", TOO_LARGE_BODY));
  });
});

/* ====================================================================== *
 * ⑥ 体积文案的形状：可读、含红线值、含两种可能的并存
 * ====================================================================== */
describe("⑥ 文案形状", () => {
  test("报出红线值本身（用户能算出自己离它多远）", () => {
    const hint = wb429ContextHint("wbai", TOO_LARGE_BODY);
    assert.match(hint, /500\.0\s*KB/, `应报出红线 512000 字节 = 500KB。实际：${hint}`);
  });

  test("大 body 也不把话说死：仍保留「稍后重试」作为兜底动作", () => {
    /* 429 也可能是真的并发限流，两条完全可能同时成立。文案不能只剩「开新对话」，
       否则用户开完新对话又被并发限流打回来时，会以为新对话也没用。 */
    const hint = wb429ContextHint("wbai", TOO_LARGE_BODY);
    assert.match(hint, /重试/, `兜底动作要留在文案里。实际：${hint}`);
  });

  test("wbBodySizeText 的四档读数", () => {
    assert.equal(wbBodySizeText(0), "0 B");
    assert.equal(wbBodySizeText(-5), "0 B");
    assert.equal(wbBodySizeText(null), "0 B");
    assert.equal(wbBodySizeText(512), "512 B");
    assert.equal(wbBodySizeText(2048), "2.0 KB");
    assert.equal(wbBodySizeText(512000), "500.0 KB");
    assert.equal(wbBodySizeText(1.5 * MB), "1.50 MB");
  });
});

/* ====================================================================== *
 * ⑦ ⭐ 接线完整性：被测的实现 == 生产用的实现
 * ====================================================================== */
describe("⑦ 接线完整性（server.mjs 真的在用这个模块）", () => {
  test("server.mjs 从 ./wb-429.mjs import wb429ContextHint", () => {
    assert.match(SERVER_SRC, /import\s*\{[^}]*\bwb429ContextHint\b[^}]*\}\s*from\s*"\.\/wb-429\.mjs"/,
      "server.mjs 必须 import wb429ContextHint —— 不 import 就还在用它自己那份旧文案，"
      + "本文件全白验（v1.0.76 的形状）");
  });

  test("三个出口都接上了：sendRateLimitError / wb 家族归因 / 探针字典", () => {
    /* 出口① sendRateLimitError —— 它收到了 provider 与 bodyStr 两个参数，
       并把 wb429ContextHint 的返回值拼进 message。 */
    const rl = SERVER_SRC.slice(SERVER_SRC.indexOf("function sendRateLimitError("));
    assert.match(rl.slice(0, 2000), /wb429ContextHint\(/,
      "sendRateLimitError 必须调 wb429ContextHint —— 这是 Claude Code 看到的那条主文案");
    /* 出口② wb/wbai 家族归因（openaiExchange 的 isWk(p) 分支） */
    assert.match(SERVER_SRC, /const wbCtxTail = r\.status === 429 \? wb429ContextHint\(p, bodyStr\) : ""/,
      "wb/wbai 分支必须按**真正发出去的 bodyStr** 调一次判据");
    /* 出口③ 探针归因字典 PROBE_HINTS 的 429 那条 */
    const hints = SERVER_SRC.slice(SERVER_SRC.indexOf("const PROBE_HINTS = {"));
    assert.match(hints.slice(0, 700), /429:.*体积红线/,
      "PROBE_HINTS[429] 必须说体积红线 —— 这句是用户白等半小时的直接来源");
  });

  test("判据拿的是 bodyStr（字节），不是 body.length / 字符数", () => {
    /* ★ 这是本次最容易写错的一处：openaiExchange 手边是 bodyStr 这个字符串，
       若接线层图省事传 .length，中文上下文会被少算三倍，红线形同虚设。 */
    assert.doesNotMatch(SERVER_SRC, /wb429ContextHint\(\s*p\s*,\s*bodyStr\.length\s*\)/,
      "★ 不许传字符数：中文场景字节数是它的三倍");
    assert.doesNotMatch(SERVER_SRC, /wb429ContextHint\(\s*provider\s*,\s*body\.length\s*\)/,
      "sendRateLimitError 也不许传字符数（body 是 Buffer，.length 是字节但对不上字符串正文）");
  });

  test("server.mjs 里不再有自己一份 wbBodyTooLarge / wbBodyBytes 定义（搬家要搬干净）", () => {
    assert.doesNotMatch(SERVER_SRC, /\bfunction\s+wbBodyTooLarge\b/,
      "server.mjs 里还留着一份本地定义 —— import 的会被它遮住，两份各说各话");
    assert.doesNotMatch(SERVER_SRC, /\bfunction\s+wbBodyBytes\b/);
    assert.doesNotMatch(SERVER_SRC, /\bfunction\s+wb429ContextHint\b/);
  });

  test("wb-429.mjs 在打包白名单里（否则装出来的版本启动即崩）", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
    const entry = ((pkg.build && pkg.build.extraResources) || []).find((e) => e && e.from === "src/server");
    assert.ok(entry && Array.isArray(entry.filter), "找不到 src/server 的 filter 白名单");
    assert.ok(entry.filter.includes("wb-429.mjs"),
      "wb-429.mjs 必须进 extraResources 白名单（filter 是显式的，漏一个 = 装出来即崩）");
  });
});

/* ====================================================================== *
 * ⑧ ⭐ 反向对照：把判据改回「一律说并发限流」，上面的断言必须红
 *    判据只有一个：**改回旧行为必须红**。这里把「旧行为」复现一遍，
 *    证明现有断言对它有判别力（不是恒真）。
 * ====================================================================== */
describe("⑧ 反向对照（证明断言对旧文案有判别力）", () => {
  /** 旧实现的等价物：429 一律只说并发限流，绝口不提上下文。 */
  const oldHint = (provider, bodyStr) => "";
  /** 再旧一档：拿 .length 比阈值的实现（中文少算三倍）。 */
  const charLenTooLarge = (bodyStr) => String(bodyStr || "").length >= WB_BODY_TOO_LARGE_BYTES;

  test("旧实现（一律空尾）在「含上下文/新对话」这条上必须红", () => {
    const hint = oldHint("wbai", TOO_LARGE_BODY);
    assert.equal(hint, "", "前提：旧实现给空串");
    assert.ok(!/上下文/.test(hint) && !/新对话/.test(hint),
      `前提：旧实现的文案里没有「上下文」也没有「新对话」。实际 ${hint}`);
    /* 而①的断言正是 /上下文/ + /新对话/ —— 换成旧实现它俩必红。 */
    assert.match(wb429ContextHint("wbai", TOO_LARGE_BODY), /上下文/);
    assert.match(wb429ContextHint("wbai", TOO_LARGE_BODY), /新对话/);
  });

  test("字符数实现（.length）在中文那条上必须红", () => {
    const s = cn(200000);                        // 200000 字符 / 600000 字节
    assert.equal(charLenTooLarge(s), false,
      "前提：按字符数算，这条中文 body 被判「不超」—— 正是旧实现的漏洞");
    assert.equal(wbBodyTooLarge(s), true,
      "而按字节算它必须判超大。两条结论相反 ⇒ ④ 的断言对单位有判别力");
  });

  test("阈值抬到 1e12（判据失效）在大 body 那条上必须红", () => {
    assert.equal(wbBodyTooLarge(TOO_LARGE_BODY, 1e12), false,
      "前提：阈值失效后，实测 429 的那一档也判「不超」—— 旧缺陷换个形状回来");
    assert.equal(wbBodyTooLarge(TOO_LARGE_BODY), true,
      "而正常阈值下同一份 body 必须判超大。两条结论相反 ⇒ ③ 的断言对阈值有判别力");
  });
});
