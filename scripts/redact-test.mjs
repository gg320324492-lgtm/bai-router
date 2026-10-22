/* 脱敏（src/server/redact.mjs）的口径测试。
 *
 * 这个模块的活儿只有一件：**把凭据从一段文本里抹掉，但抹得让人还认得出那是什么**。
 * 于是它只有两种错法，两种都是 bug：
 *   · **漏伤** —— 认不出来的凭据留在原地，那一行日志等于把 key 抄了一遍；
 *   · **误伤** —— 模型名、状态词、普通 id 被抹掉，日志没法读了，
 *     而它本来就不是秘密。
 *
 * 所以本文件正反两面都测：
 *   ① 形态覆盖（漏伤）—— API key / JWT / Bearer / cookie / 邮箱 / 手机号 …
 *   ② 反向对照（误伤）—— 模型名、短 id、日志里的普通词，一个都不许动
 *   ③ 形状保留 —— 长度逐字不变、头尾还在、中间是 '*'
 *   ④ 反向对照 —— 把实现改坏（改源码副本再 import），证明对应断言真的会红
 *
 * ⚠ 夹具里的凭据**一律是现造的假货**（明写着 test / fake / 0000…），
 *    不用任何看起来像真 key 的串 —— 测试文件是要进 git 的。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redact, redactWithHits, hasSecret, redactDeep, KINDS } from "../src/server/redact.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src/server/redact.mjs");

/* ── 假凭据：一律现造，形状对、内容假 ─────────────────────────────── */
const FAKE_SK = "sk-test-0000000000000000000000000000";
const FAKE_SK_ANT = "sk-ant-test-11111111111111111111111111111111";
const FAKE_SK_PROJ = "sk-proj-test-22222222222222222222222222222222";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiIsImtpZCI6ImZha2UifQ." +
  "eyJzdWIiOiJmYWtlLWFjY291bnQtMDAwMSIsImV4cCI6OTk5OTk5OTk5OX0." +
  "ZmFrZS1zaWduYXR1cmUtdmFsdWUtaW5pLXBsYWNlaG9sZC1ub3Qtc2VjcmV0";
const FAKE_GHP = "ghp_test0000000000000000000000000000000000";
const FAKE_AKIA = "AKIATESTTESTTESTTEST";
const FAKE_B64 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const FAKE_HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/* ====================================================================== *
 * ① 形态覆盖：认得出来的凭据，一条都不许留在原地
 * ====================================================================== */
describe("① 形态覆盖（漏伤是 bug）", () => {
  test("①a sk- 系列的四种变体都要被抹", () => {
    for (const k of [FAKE_SK, FAKE_SK_ANT, FAKE_SK_PROJ, FAKE_GHP, FAKE_AKIA]) {
      assert.equal(hasSecret(k), true, `没认出这是个凭据：${k.slice(0, 8)}…`);
      const out = redact(k);
      assert.notEqual(out, k, "原样返回了 —— 等于没脱敏");
      assert.equal(out.length, k.length, "长度变了：日志里凭据那一行的位置会对不上");
      assert.ok(!out.includes(k), "输出里还留着完整的凭据");
    }
  });

  test("①b JWT 认得出、且归类成 JWT", () => {
    assert.equal(hasSecret(FAKE_JWT), true);
    const { hits } = redactWithHits(FAKE_JWT);
    assert.ok(
      hits.some((h) => h.kind === "JWT"),
      `JWT 归类错了：${JSON.stringify(hits)}`,
    );
    const out = redact(FAKE_JWT);
    assert.ok(!out.includes("ZmFrZS1zaWduYXR1cmU"), "签名段还在");
    assert.ok(!out.includes("eyJzdWIiOiJmYWtl"), "载荷段还在");
  });

  test("①c 头部形态：Authorization / x-api-key / Bearer / Cookie", () => {
    const cases = [
      `authorization: Bearer ${FAKE_SK}`,
      `x-api-key: ${FAKE_SK}`,
      `Authorization: Bearer ${FAKE_JWT}`,
      `Cookie: sid=${FAKE_SK}; theme=dark`,
    ];
    for (const c of cases) {
      assert.equal(hasSecret(c), true, `没认出：${c.slice(0, 24)}…`);
      const out = redact(c);
      assert.ok(!out.includes(FAKE_SK), `凭据还在：${out}`);
      assert.ok(!out.includes(FAKE_JWT), `凭据还在：${out}`);
      assert.equal(out.length, c.length);
    }
  });

  test("①d Cookie 只抹值、名字留着（名字是诊断线索）", () => {
    const out = redact("Cookie: sid=abc123def456; theme=dark");
    assert.ok(out.includes("sid="), "cookie 名字被抹了 —— 「是不是登录态掉了」这条线索没了");
    assert.ok(out.includes("theme="), "cookie 名字被抹了");
    assert.ok(!out.includes("abc123def456"), "cookie 的值还在");
    assert.ok(!out.includes("dark"), "cookie 的值还在");
  });

  test("①e 邮箱与手机号", () => {
    const mail = redact("联系 alice@example.com 处理");
    assert.ok(!mail.includes("alice@example.com"), "邮箱还在");
    assert.ok(mail.includes("@"), "邮箱的结构没了 —— 看的人不知道这里本来是个邮箱");
    assert.ok(mail.includes(".com"), "TLD 也被抹了 —— 「公司邮箱还是私人邮箱」这条线索没了");
    const tel = redact("来电 13800138000");
    assert.ok(!tel.includes("13800138000"), "手机号还在");
    assert.ok(tel.startsWith("来电 138"), "号段没留着 —— 认不出这是手机号");
  });

  test("①f 赋值式凭据与 URL 里的口令", () => {
    const p = redact("password=SuperSecret123");
    assert.ok(!p.includes("SuperSecret123"), "口令还在");
    const u = redact("https://user:hunter2pass@example.com/path");
    assert.ok(!u.includes("hunter2pass"), "URL 里的口令还在");
    const k = redact('{"key": "abcdefgh12345678ijkl"}');
    assert.ok(!k.includes("abcdefgh12345678ijkl"), "名为 key 的字段没被抹");
  });

  test("①g 长十六进制与长 base64（无前缀可认时的兜底）", () => {
    const h = redact(`sha256=${FAKE_HEX}`);
    assert.ok(!h.includes(FAKE_HEX), "长 hex 还在");
    const b = redact(`blob ${FAKE_B64}`);
    assert.ok(!b.includes(FAKE_B64), "长 base64 还在");
  });

  test("①h 脱敏后输出里不得再出现任何形似 JWT 的长串", () => {
    /* 面板状态接口有一条硬规则：响应里不得出现任何形似 JWT 的长串。
     * 脱敏后的输出将来是要接到面板上的，所以它自己就得满足这条。 */
    const out = redact(`token=${FAKE_JWT}`);
    assert.ok(
      !/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/.test(out),
      `脱敏后的输出仍然形似 JWT：${out}`,
    );
  });
});

/* ====================================================================== *
 * ② 反向对照：正常内容一个都不许动（误伤是 bug）
 * ====================================================================== */
describe("② 反向对照 —— 正常内容不许被抹", () => {
  test("②a 模型名一个都不许动", () => {
    /* 这一条最要紧：台账要按模型查账，模型名被抹了这本账就没法查了。 */
    const models = [
      "anthropic/claude-opus-4-1-20250805",
      "anthropic/Claude-Opus-4-1-20250805",
      "claude-sonnet-4-5-20250929",
      "gpt-4o-2024-08-06",
      "gpt-4o-mini",
      "glm-4.6",
      "deepseek-chat",
      "qwen/qwen3-max",
      "moonshotai/kimi-k2-thinking-preview",
      "MiniMax-M2.1",
      "zai-org/GLM-4.6-Air",
      "doubao-1-5-pro-32k",
      "text-embedding-3-large",
      "us.anthropic.claude-opus-4-1-20250805-v1:0",
    ];
    for (const m of models) {
      assert.equal(redact(m), m, `模型名被抹了：${m}`);
      assert.equal(hasSecret(m), false, `模型名被当成了凭据：${m}`);
    }
  });

  test("②b 短 id、uuid、普通词不许动", () => {
    const benign = [
      "req_1a2b3c",
      "550e8400-e29b-41d4-a716-446655440000",
      "token: expired",
      "tokenizer: 12345678",
      "secret: hidden",
      "status: succeeded",
      "thisisaveryverylongwordwithoutanydigitsatall",
      "aVeryLongCamelCaseIdentifierWithNoDigits",
    ];
    for (const b of benign) {
      assert.equal(redact(b), b, `普通内容被抹了：${b}`);
    }
  });

  test("②c 正常日志行不许动", () => {
    const lines = [
      "GET /v1/messages 200 in 1234ms",
      "上游返回 429，请求过于频繁，请稍后再试",
      "这是一段普通的中文日志：错误码 42，耗时 3ms",
      "https://api.example.com/v1/messages",
      "cooling { quota: true, 1790s }",
    ];
    for (const l of lines) {
      assert.equal(redact(l), l, `日志行被抹了：${l}`);
    }
  });

  test("②d 文件名里的 @ 不是邮箱（magpie #3029 的教训）", () => {
    /* magpie 把 261020_14-16-11@2x.jpg 当成邮箱抹了，模型再也读不出那个文件。
     * 同样的坑不能在本仓库再踩一次。 */
    const name = "261020_14-16-11@2x.jpg";
    assert.equal(redact(name), name, "文件名被当邮箱抹了");
    const png = "screenshot@2x.png";
    assert.equal(redact(png), png, "文件名被当邮箱抹了");
  });

  test("②e sk- 前面挨着字母/短横线时不算 key", () => {
    /* risk- / task- 这类词里都藏着 sk-，不挡回去会把普通词当成 key。 */
    assert.equal(redact("risk-management-sk-not-a-key"), "risk-management-sk-not-a-key");
    assert.equal(redact("task-list-item"), "task-list-item");
  });
});

/* ====================================================================== *
 * ③ 形状保留
 * ====================================================================== */
describe("③ 形状保留 —— 抹掉但让人认得出", () => {
  test("③a 长度逐字不变", () => {
    const samples = [
      FAKE_SK,
      FAKE_JWT,
      `authorization: Bearer ${FAKE_JWT}`,
      "Cookie: sid=abc123def456; theme=dark",
      "联系 alice@example.com，来电 13800138000",
      "password=SuperSecret123",
    ];
    for (const s of samples) {
      assert.equal(redact(s).length, s.length, `长度变了：${s}`);
    }
  });

  test("③b 头尾留下、中间是 '*'", () => {
    const out = redact(FAKE_SK_ANT);
    assert.ok(out.startsWith("sk-ant-"), `前缀没留住，看不出是什么家的：${out}`);
    assert.ok(out.includes("*"), "中间不是 '*'");
    assert.ok(!out.includes("1111111111111111"), "随机段还在");
    /* 尾巴留 4 位：够在多行日志里认出是哪一条，又不够还原 */
    assert.ok(out.endsWith("1111"), `尾巴没留住：${out}`);
  });

  test("③c 同一份凭据在两条日志里必须是同一个样子", () => {
    /* 形状每次不一样的话，排查的人会以为是两回事。 */
    const core = "sk-ant-";
    const a = redact(`key=${FAKE_SK_ANT}`);
    const b = redact(`另一处 ${FAKE_SK_ANT} 出现了`);
    const cut = (s) => s.slice(s.indexOf(core), s.indexOf(core) + FAKE_SK_ANT.length);
    assert.ok(a.includes(core) && b.includes(core), "前缀没留住");
    assert.equal(cut(a), cut(b), "同一份凭据在两处显示成了两个样子");
  });

  test("③d 二次脱敏不会把内容还原（掩码不是编码）", () => {
    for (const s of [FAKE_SK, FAKE_JWT, FAKE_SK_ANT]) {
      const once = redact(s);
      const twice = redact(once);
      assert.ok(!twice.includes(s), "二次脱敏把凭据还原出来了");
      assert.equal(twice.length, once.length);
    }
  });

  test("③e redactDeep 把对象里的每一处字符串都洗掉", () => {
    const src = {
      agent: "claude-code",
      note: `用了 ${FAKE_SK}`,
      list: [`cookie=${FAKE_JWT}`],
    };
    const out = redactDeep(src);
    assert.ok(!out.note.includes(FAKE_SK), "对象里的凭据没洗掉");
    assert.ok(!out.list[0].includes(FAKE_JWT), "数组里的凭据没洗掉");
    assert.equal(out.agent, "claude-code");
    assert.equal(src.note, `用了 ${FAKE_SK}`, "原对象被就地改了 —— 调用方会拿到一个已经被洗过的对象");
  });
});

/* ====================================================================== *
 * ④ 反向对照：把实现改坏，对应断言必须真的会红
 * ====================================================================== */

/** 把源码改坏，写进临时目录，再 import 进来。 */
async function loadMutated(srcFile, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bai-redact-mut-"));
  const src = fs.readFileSync(srcFile, "utf8");
  const out = mutate(src);
  assert.notEqual(out, src, "变异没有生效 —— 反向对照就是空转");
  const file = path.join(dir, path.basename(srcFile));
  fs.writeFileSync(file, out, "utf8");
  return import(pathToFileURL(file).href);
}

/**
 * 断言「改坏之后，这条断言会红」。
 *
 * @param {Function} mutate  改源码
 * @param {Function} check   断言（对着被改坏的模块跑；不满足就该抛）
 * @param {string}   label   这条反向对照在钉什么
 */
async function reverseControl(mutate, check, label) {
  const mutated = await loadMutated(SRC, mutate);
  let threw = false;
  try {
    check(mutated);
  } catch {
    threw = true;
  }
  assert.ok(threw, `${label}：把实现改坏之后断言居然还是绿的 —— 这条反向对照是空转的`);
}

describe("④ 反向对照 —— 改坏实现，对应断言必须红", () => {
  test("④a 把 JWT 规则改瞎（eyJ → eyZZZ），①b 必须红", async () => {
    /* 正着先验一遍：原实现满足断言 */
    const hits = redactWithHits(FAKE_JWT).hits;
    assert.ok(hits.some((h) => h.kind === "JWT"), "原实现就认不出 JWT —— ①b 先挂了");

    await reverseControl(
      (src) => src.replace("eyJ[A-Za-z0-9_-]{8,}", "eyZZZ[A-Za-z0-9_-]{8,}"),
      (m) => {
        const h = m.redactWithHits(FAKE_JWT).hits;
        assert.ok(
          h.some((x) => x.kind === "JWT"),
          `JWT 规则改瞎了却还归成 JWT：${JSON.stringify(h)}`,
        );
      },
      "JWT 规则",
    );
  });

  test("④b 把掩码换成「直接删掉」，①a 的长度不变必须红", async () => {
    assert.equal(redact(FAKE_SK).length, FAKE_SK.length, "原实现长度就不对");

    await reverseControl(
      (src) => src.replace('"*".repeat(mid)', '""'),
      (m) => {
        assert.equal(m.redact(FAKE_SK).length, FAKE_SK.length, "掩码改成了删除，长度必然变");
      },
      "掩码不许退化成删除",
    );
  });

  test("④c 把「随机串」判据放宽成永远成立，②a 的模型名必须红", async () => {
    const model = "anthropic/Claude-Opus-4-1-20250805";
    assert.equal(redact(model), model, "原实现就抹了模型名 —— ②a 先挂了");

    await reverseControl(
      (src) => src.replace("return seps <= 3;", "return true;"),
      (m) => {
        assert.equal(m.redact(model), model, "随机串判据放宽后模型名被当成凭据抹了");
      },
      "随机串判据",
    );
  });

  test("④d 把边界检查去掉，②e 的 risk- 必须红", async () => {
    const word = "risk-management-sk-not-a-key";
    assert.equal(redact(word), word, "原实现就抹了 —— ②e 先挂了");

    await reverseControl(
      (src) =>
        src.replace(
          "(?<![A-Za-z0-9_-])(?:sk|rk|pk)-",
          "(?:sk|rk|pk)-",
        ),
      (m) => {
        assert.equal(m.redact(word), word, "边界检查去掉后 risk- 里的 sk- 被当成了 key");
      },
      "sk- 的左边界",
    );
  });

  test("④e 把邮箱的掩码改成「整段删掉」，①e 必须红", async () => {
    /* 这条守的是「掩码是掩码，不是删除」这条契约在 EMAIL 这条路上也没塌 */
    await reverseControl(
      (src) => src.replace("EMAIL: { mode: \"custom\", fn: maskEmail },", "EMAIL: { mode: \"custom\", fn: () => \"\" },"),
      (m) => {
        const out = m.redact("联系 alice@example.com 处理");
        assert.ok(!out.includes("alice@example.com"), "邮箱还在");
        assert.equal(out.length, "联系 alice@example.com 处理".length, "长度变了");
      },
      "邮箱掩码",
    );
  });
});

/* ====================================================================== *
 * ⑤ 边界：输入不许把模块带崩
 * ====================================================================== */
describe("⑤ 边界", () => {
  test("⑤a null / undefined / 非字符串", () => {
    assert.equal(redact(null), "");
    assert.equal(redact(undefined), "");
    assert.equal(redact(123), "123");
    assert.equal(redact({}), "[object Object]");
  });

  test("⑤b 空串与短串", () => {
    assert.equal(redact(""), "");
    assert.equal(redact("ab"), "ab");
  });

  test("⑤c 归类名是固定的那一套", () => {
    assert.deepEqual(
      [...KINDS].sort(),
      ["API_KEY", "AUTH_HEADER", "BASE64", "BEARER", "COOKIE", "EMAIL", "HEX", "JWT", "PASSWORD", "PHONE", "SECRET"].sort(),
    );
  });
});
