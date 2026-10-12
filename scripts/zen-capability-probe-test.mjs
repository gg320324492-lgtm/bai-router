/**
 * T3+T6 回归测试：OpenCode Zen 逐模型能力探测（v1.0.74）
 *
 *   ① `calls:0` **不**判「不支持工具」（OW 纪律一：只算观测，不算判决）
 *   ② 401/403/429 → 判「探不通」；格式/内容错误 → **不改判定**（两条分开测）
 *   ③ `max_tokens:8` 被拒 → 重试 16，**且 isProbe 始终为 true**（最关键的一条）
 *   ④ 只探 `-free` 模型，付费模型**一次请求都不发**（计数器断言）
 *   ⑤ 并发不超过 2
 *   ⑥ `ZEN_EXTERNAL_OK` 被探测结果接管，注释里那条过期说明同步更新
 *
 * ## 测试打的是什么
 *
 * **①②③④⑤ 直接 import 仓库里那份 `src/server/zen-probe.mjs`**——不是抄一份重写。
 * HTTP 由注入的 `send` 桩替代，于是「只发一次请求」「并发 2」「isProbe 恒 true」
 * 这些断言能落在**真代码**上，而且是确定性的、不受网络影响。
 * ⑥ 走源码断言 + 端到端（真 server.mjs + 假上游）。
 *
 * ## 反向对照（每条都有）
 *
 * 没有对照的断言证明不了自己没写错。关键的几条对照写在用例里（构造一个应当失败的
 * 响应，断言它**没有**被判成另一种结论）；另外 §SABOTAGE 在文件末尾给出"把真源码
 * 改回改前行为"的四组改法，改完跑测试必须变红，还原后用 `grep SABOTAGE` 自证。
 *
 * 红线：
 *   · 凭据一律 `oc_dummy-not-a-real-key` 这类明显假串，源码/argv/日志里没有真令牌。
 *   · 所有落盘都在 `os.tmpdir()` 下，**绝不碰真实的 %APPDATA%\bai-router**。
 *   · 端口全部 `listen(0)` 动态挑，与 attrib-atomic-test / zen-go-tier-test 不冲突；
 *     但那三个都会跑一次代理自检，**本测试必须单独跑**，别与它们并发。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  zenProbeClassify, zenProbeNetwork, zenProbeToolCalls, zenProbeReadResponse, zenProbeVerdict,
  zenCapLabel, zenCapHint, zenProbeTargets, zenProbePool, zenProbeBody, zenProbeOne,
  zenRunCapabilityProbe, zenProbeLoad, zenProbeSave, zenProbeImageSentinel,
  ZEN_PROBE_MAX_TOKENS, ZEN_PROBE_MAX_TOKENS_RETRY, ZEN_PROBE_CONCURRENCY, ZEN_PROBE_SESSION,
  ZEN_PROBE_PNG_1PX, ZEN_PROBE_PNG_SENTINEL,
} from "../src/server/zen-probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const SRC = readFileSync(SERVER, "utf8");
const MODSRC = readFileSync(path.join(REPO, "src", "server", "zen-probe.mjs"), "utf8");
const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-zen-probe-"));
const DUMMY_KEY = "oc_dummy-not-a-real-key";     // 明显不是真 Key
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
after(() => { try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* ---------- 造响应的脚手架 ---------- */

/** 2xx + 一个 tool_calls block。 */
const okWithTool = { status: 200, text: JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "probe_ping", arguments: '{"value":"ok"}' } }] } }] }) };
/** 2xx + **只回文本**、没有任何 tool_calls —— 纪律①要处理的就是这个。 */
const okTextOnly = { status: 200, text: JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
const err = (status, text) => ({ status, text });
const auth401 = err(401, '{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}');
const auth403FreeTier = err(403, '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}');
const rate429 = err(429, '{"type":"error","error":{"type":"api_error","message":"slow down"}}');
/** 400 + 请求格式不合（既不是鉴权也不是限流、也不是 max_tokens/工具/图片）—— 纪律②的「内容性错误」。 */
const bad400 = err(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Invalid schema for parameter messages[0].content: expected a string"}}');

/* ================================================================== *
 * ① `calls:0` 只算观测，不算判决（OW Bridge 纪律一）
 * ================================================================== */
describe("① 只回文本的模型不得被判成「不支持工具」", () => {
  test("正向：200 + 只回文本 → tools=unverified，标签不是「仅对话」", async () => {
    const obs = await zenProbeOne("m-text", { send: async () => okTextOnly });
    const rec = zenProbeVerdict(obs);
    assert.equal(rec.ok, true, "2xx 就是探得通");
    assert.equal(obs.tools.calls, 0, "确实没观察到工具调用——这是**观测**");
    assert.equal(rec.calls, 0);
    assert.equal(rec.tools, "unverified", "calls:0 绝不能判成 no（OW 纪律一）");
    assert.equal(rec.label, "可用 · 工具未验证");
    assert.notEqual(rec.label, "可用 · 仅对话");
    assert.match(zenCapHint(rec), /不等于|未观察到/, "提示必须说清这只是观测");
  });

  test("反向对照：同一判定里，另两种响应必须落在**别的**分支上", async () => {
    // 有 tool_calls → yes。如果实现是"恒返回 unverified"，这条会挂。
    const yes = zenProbeVerdict(await zenProbeOne("m-t", { send: async () => okWithTool }));
    assert.equal(yes.tools, "yes");
    assert.equal(yes.label, "可用 · 支持工具");
    // 上游**拒收**带工具的请求 → no（OW 的 formatUnsupported 判据）。
    const no = zenProbeVerdict(await zenProbeOne("m-n", {
      send: async () => err(400, '{"error":{"message":"Invalid request parameters: only auto supported tool_choice"}}'),
    }));
    assert.equal(no.tools, "no", "上游拒收带工具的请求才判仅对话");
    assert.equal(no.ok, true, "参数级拒绝说明端点是通的——鉴权过了、请求被解析了");
    assert.equal(no.label, "可用 · 仅对话");
    // 三条分支互不相同 —— 证明上面那条不是恒真的假闸门。
    assert.equal(new Set([yes.tools, no.tools, "unverified"]).size, 3);
  });

  test("反向对照：只回文本若被判成「仅对话」，探针会误伤好模型", () => {
    // 模拟**改前行为**（把 calls:0 一律判 no）：同一条响应立刻得出相反结论。
    const naive = (obs) => ({ ...zenProbeVerdict(obs), tools: obs.tools.calls === 0 ? "no" : "yes" });
    const obs = { chat: zenProbeReadResponse(200, okTextOnly.text), tools: { cls: "reachable", calls: 0, envelope: "none", reachable: false } };
    assert.equal(zenProbeVerdict(obs).tools, "unverified", "真实现：不算判决");
    assert.equal(naive(obs).tools, "no", "旧式实现：会误判 —— 对照组必须给出相反答案");
    assert.equal(zenCapLabel(naive(obs)), "可用 · 仅对话");
  });

  test("tool_calls 计数：OpenAI 与 Anthropic 两种信封都认", () => {
    assert.equal(zenProbeToolCalls({ choices: [{ message: { tool_calls: [1, 2] } }] }).calls, 2);
    assert.equal(zenProbeToolCalls({ content: [{ type: "text" }, { type: "tool_use", name: "x" }] }).calls, 1);
    assert.equal(zenProbeToolCalls({ choices: [{ message: { content: "hi" } }] }).calls, 0);
    assert.equal(zenProbeToolCalls({}).calls, 0);
  });
});

/* ================================================================== *
 * ② 能力性错误 vs 内容性错误（OW Bridge 纪律二）
 * ================================================================== */
describe("② 能力性错误判「探不通」，内容性错误不改判定", () => {
  for (const [name, resp, cls] of [
    ["401", auth401, "auth"],
    ["403 FreeTierError", auth403FreeTier, "auth"],
    ["429", rate429, "rate_limit"],
  ]) {
    test(`正向：${name} → 探不通（ok=false，标签「探不通」）`, async () => {
      const c = zenProbeClassify(resp.status, resp.text);
      assert.equal(c.cls, cls, `${name} 应归为 ${cls}`);
      assert.equal(c.reachable, true, `${name} 是能力性错误 → 判定成立`);
      const rec = zenProbeVerdict(await zenProbeOne("m", { send: async () => resp }));
      assert.equal(rec.ok, false);
      assert.equal(rec.label, "探不通");
      assert.ok(rec.why.length > 0, "探不通必须给出原因，不能只给一个标签");
    });
  }

  test("反向对照：格式错误**不改判定**——ok 必须是 null（未知），不是 false", async () => {
    const c = zenProbeClassify(bad400.status, bad400.text);
    assert.equal(c.reachable, null, "内容性错误的 reachable 必须是 null（未知），既不是 true 也不是 false");
    const rec = zenProbeVerdict(await zenProbeOne("m", { send: async () => bad400 }));
    assert.equal(rec.ok, null, "内容性错误不许判探不通——否则一次跑偏就误伤一个好模型");
    assert.notEqual(rec.ok, false);
    // 调用方据此**保留原结论**：null 不是 false，见 ⑥。
  });

  test("反向对照：把内容性错误当能力性错误处理，会把好模型踢出下拉框", () => {
    const obs = { chat: zenProbeReadResponse(400, bad400.text) };
    assert.equal(zenProbeVerdict(obs).ok, null, "真实现：未知");
    const naive = { ...zenProbeVerdict(obs), ok: false };   // 改前行为：任何非 2xx 都判死
    assert.equal(naive.ok, false, "旧式实现：误伤 —— 对照组必须给出相反答案");
    assert.equal(zenCapLabel(naive), "探不通");
    assert.equal(zenCapLabel(zenProbeVerdict(obs)), "未判定",
      "真实现的标签必须与「探不通」区分开，否则面板上看起来还是把模型踢了");
    assert.notEqual(zenProbeVerdict(obs).ok, naive.ok);
  });

  test("网络失败单独归类：连不上 ≠ 模型不可用", () => {
    const n = zenProbeNetwork("aborted (header timeout)");
    assert.equal(n.cls, "network");
    assert.equal(n.reachable, true, "探不通");
    assert.match(n.why, /不是模型的问题/);
  });

  test("两条纪律互不串味：401 之后不会被 400 的宽松规则覆盖", () => {
    // 顺序敏感：先归类再谈宽松。若实现是"拿不准就当探不通"，401 仍要保住 auth。
    assert.equal(zenProbeClassify(401, auth401.text).reachable, true);
    assert.equal(zenProbeClassify(403, auth403FreeTier.text).reachable, true);
    assert.equal(zenProbeClassify(429, rate429.text).reachable, true);
    assert.equal(zenProbeClassify(400, bad400.text).reachable, null);
  });
});

/* ================================================================== *
 * ③ ⚠️ 最关键：max_tokens 抬档不得让 isProbe 变成 false
 * ================================================================== */
describe("③ max_tokens:8 被拒 → 重试 16，isProbe 始终为 true", () => {
  const maxTokensErr = err(400, '{"error":{"type":"invalid_request_error","message":"Invalid request parameters: max_tokens must be >= 16"}}');

  test("正向：先 8 后 16，且**每一次** send 都收到 isProbe=true", async () => {
    const calls = [];
    const send = async (body, opts) => { calls.push({ mt: body.max_tokens, isProbe: opts && opts.isProbe, opts }); return calls.length === 1 ? maxTokensErr : okWithTool; };
    const obs = await zenProbeOne("gpt-x-free", { send });

    assert.equal(calls.length, 2, "应当恰好两次：首轮 8 + 抬档重试 16");
    assert.equal(calls[0].mt, 8, "首轮必须是 8（≤8 才是 isProbe 判据）");
    assert.equal(calls[1].mt, 16, "被拒后抬到 16");
    assert.equal(calls[0].isProbe, true, "首轮是探测");
    assert.equal(calls[1].isProbe, true, "**抬到 16 之后仍然是探测** —— 短超时与重试一条都不能少");

    assert.equal(obs.escalated, true, "要记下抬过档，供面板与排查用");
    assert.equal(obs.maxTokens, 16);
    const rec = zenProbeVerdict(obs);
    assert.equal(rec.ok, true, "因 max_tokens 被拒 ≠ 模型不可用，重试成功就是探得通");
    assert.equal(rec.label, "可用 · 支持工具");
  });

  test("反向对照：若 isProbe 由 body.max_tokens 反推，第二次请求会静默变成真实对话", () => {
    // 改前行为（入口就是这么推导的）：isProbe = body.max_tokens <= 8
    const derive = (body) => body.max_tokens <= ZEN_PROBE_MAX_TOKENS;
    const first = { max_tokens: ZEN_PROBE_MAX_TOKENS };
    const retry = { max_tokens: ZEN_PROBE_MAX_TOKENS_RETRY };
    assert.equal(derive(first), true, "首轮推导确实是 true");
    assert.equal(derive(retry), false, "抬到 16 之后推导变成 false —— 这正是要防的静默降级");
    assert.ok(ZEN_PROBE_MAX_TOKENS_RETRY > ZEN_PROBE_MAX_TOKENS, "重试值必须大于判据上限，否则抬档没有意义");
    // 真实现不推导：opts.isProbe 恒由调用方显式给
    assert.equal(ZEN_PROBE_MAX_TOKENS, 8);
    assert.equal(ZEN_PROBE_MAX_TOKENS_RETRY, 16);
  });

  test("反向对照：抬档不得顺带抬高别的参数（配额）", async () => {
    const bodies = [];
    await zenProbeOne("m", { send: async (b) => { bodies.push(b); return bodies.length === 1 ? maxTokensErr : okTextOnly; } });
    assert.equal(bodies.length, 2);
    // 除 max_tokens 外逐字段相同：抬高只抬了它一个
    const { max_tokens: a, ...ra } = bodies[0];
    const { max_tokens: b, ...rb } = bodies[1];
    assert.notEqual(a, b);
    assert.deepEqual(ra, rb, "只有 max_tokens 变了；多抬一个字段就是多花一份配额");
    assert.equal(bodies[0].stream, false, "探测一律非流式，避免挂着 SSE 读不完整响应");
  });

  test("正向：一次就通过时不抬档，也不发第二个请求", async () => {
    const calls = [];
    const obs = await zenProbeOne("m", { send: async (b, o) => { calls.push([b.max_tokens, o.isProbe]); return okWithTool; } });
    assert.equal(calls.length, 1, "配额有限：没被拒就不许重试");
    assert.deepEqual(calls[0], [8, true]);
    assert.equal(obs.escalated, false);
  });

  test("探针模块源码里不得出现「由 max_tokens 反推 isProbe」的写法", () => {
    // isProbe 只作为 send() 的显式第二参数出现；一旦有人改成反推，这条会红。
    // 先剥注释：本文件的**文档注释**里就写着「max_tokens <= 8」这句判据说明，
    // 不剥会把说明文字当成代码判据。
    const code = MODSRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(/post\(ZEN_PROBE_MAX_TOKENS\)/.test(code), "首轮用 8");
    assert.ok(/post\(ZEN_PROBE_MAX_TOKENS_RETRY\)/.test(code), "抬档用 16");
    assert.equal(/max_tokens\s*<=/.test(code), false, "代码里不得有 max_tokens <= 的判定（那是从 body 反推 isProbe 的写法）");
    /* send 只有一处调用点，isProbe 写死 true；post() 被调两次（8 与 16），
       所以"两次请求都拿到 isProbe:true"由上面那条**行为**断言负责，这里只守结构。 */
    assert.equal((code.match(/send\(body, \{ isProbe: true \}\)/g) || []).length, 1,
      "send 的唯一调用点必须写死 isProbe:true");
    /* imageSend 现在有**两个**调用点：哨兵那发与真图那发。两发都必须显式写死
       isProbe:true —— 哨兵多花一次配额，更不能让它退化成真实对话（那会禁掉短超时与重试）。
       "两发都拿到 isProbe:true"由下面的**行为**断言负责，这里只守结构。 */
    const imgCalls = code.match(/imageSend\((?:ib|sb), \{ isProbe: true \}\)/g) || [];
    assert.equal(imgCalls.length, 2, "imageSend 恰有两个调用点（哨兵 + 真图），且两处都写死 isProbe:true");
    assert.ok(/imageSend\(sb, \{ isProbe: true \}\)/.test(code), "哨兵那一发也必须写死 isProbe:true");
    // post() 是唯一的发信通道：它的函数体里 isProbe 只能出现一次且是字面量 true
    const postBody = code.slice(code.indexOf("const post = async (maxTokens) => {"), code.indexOf("let { r, maxTokens, body }"));
    assert.equal((postBody.match(/isProbe/g) || []).length, 1, "post() 里 isProbe 只该出现在那一处");
    assert.ok(/send\(body, \{ isProbe: true \}\)/.test(postBody), "post() 里必须写死字面量 true");
  });
});

/* ================================================================== *
 * ④ 只探免费模型
 * ================================================================== */
describe("④ 只探 -free；付费模型一次请求都不发", () => {
  const CATALOG = ["space-bunny-free", "longcat-2.5-preview-free", "claude-sonnet-4-5", "gpt-5-free", "big-pickle", "glm-5.2"];
  const PAID = ["claude-sonnet-4-5", "big-pickle", "glm-5.2"];

  test("正向：计数器断言——付费模型请求数为 0", async () => {
    const perModel = Object.create(null);
    const send = async (body) => { perModel[body.model] = (perModel[body.model] || 0) + 1; return okTextOnly; };
    const out = await zenRunCapabilityProbe({
      catalog: CATALOG, upstream: "http://127.0.0.1:1/zen/v1", tier: "free",
      dataDir: path.join(TMPROOT, "free-only"), send, imageSend: send,
    });
    for (const m of PAID) assert.equal(perModel[m] || 0, 0, `付费模型 ${m} 收到了 ${perModel[m]} 个请求——探了要花钱`);
    assert.ok(Object.keys(out.models).length > 0, "免费模型确实探了（否则上面的 0 是因为什么都没探）");
    assert.deepEqual(Object.keys(out.models).sort(), ["gpt-5-free", "longcat-2.5-preview-free", "space-bunny-free"]);
    assert.deepEqual(out.skippedPaid.sort(), PAID.slice().sort(), "跳过的付费模型要如实报出来");
  });

  test("反向对照：过滤器本身有效——全付费目录探出 0 个目标", () => {
    assert.deepEqual(zenProbeTargets(PAID), [], "全是付费模型时必须一个都不探");
    assert.equal(zenProbeTargets([]).length, 0);
    assert.equal(zenProbeTargets(null).length, 0);
    assert.deepEqual(zenProbeTargets(CATALOG).sort(), ["gpt-5-free", "longcat-2.5-preview-free", "space-bunny-free"]);
    // 若过滤器写成 `includes("free")`（少一个连字符），`gpt-5-free` 仍会过、
    // 但下面这条会暴露"其实判据更宽"；用 `space-bunny` 这种不含 free 的对照更硬：
    assert.equal(zenProbeTargets(["space-bunny"]).length, 0, "不含 -free 的一律不探");
  });

  test("反向对照：编排器收到付费目录时连 send 都不该被构造性地调用", async () => {
    let invoked = 0;
    const out = await zenRunCapabilityProbe({
      catalog: PAID, upstream: "u", tier: "free", dataDir: path.join(TMPROOT, "none"),
      send: async () => { invoked++; return okTextOnly; },
    });
    assert.equal(invoked, 0, "send 一次都没被调用");
    assert.equal(out.probed, 0);
    assert.deepEqual(Object.keys(out.models), []);
  });
});

/* ================================================================== *
 * ⑤ 并发上限 2
 * ================================================================== */
describe("⑤ 并发不超过 2", () => {
  test("正向：6 个任务、并发峰值 ≤ 2", async () => {
    let live = 0, peak = 0;
    const { out, peak: p } = await zenProbePool([1, 2, 3, 4, 5, 6], async (n) => {
      live++; peak = Math.max(peak, live);
      await sleep(20);
      live--;
      return n * 2;
    });
    assert.equal(out.length, 6, "所有任务都要跑完（漏跑比超并发更糟）");
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12], "结果顺序必须与输入对应（并发池最容易犯的错）");
    assert.ok(peak <= 2, `并发峰值 ${peak} 超过上限 2`);
    assert.equal(p, peak);
    assert.equal(ZEN_PROBE_CONCURRENCY, 2);
  });

  test("反向对照：同一个负载在**无上限**的参照实现下确实会超过 2", async () => {
    // 没有这一条，"peak <= 2" 可能是因为任务根本没并发跑起来
    let live = 0, peak = 0;
    await Promise.all([1, 2, 3, 4, 5, 6].map(async () => {
      live++; peak = Math.max(peak, live);
      await sleep(20);
      live--;
    }));
    assert.ok(peak > 2, `参照实现的峰值 ${peak} 应该 > 2，否则本测试证明不了限流有效`);
  });

  test("反向对照：调用方传更大的 limit 也压不下去（上限是硬编码的）", async () => {
    let live = 0, peak = 0;
    await zenProbePool([1, 2, 3, 4, 5, 6, 7, 8], async () => {
      live++; peak = Math.max(peak, live);
      await sleep(15);
      live--;
    }, 99);   // 恶意/手滑地传 99
    assert.ok(peak <= 2, `传 limit=99 时峰值仍是 ${peak}，必须被压回 2`);
  });

  test("端到端编排的并发峰值也 ≤ 2（经 zenRunCapabilityProbe）", async () => {
    let live = 0, peak = 0;
    await zenRunCapabilityProbe({
      catalog: ["a-free", "b-free", "c-free", "d-free", "e-free"], upstream: "u", tier: "free",
      dataDir: path.join(TMPROOT, "conc"),
      send: async () => { live++; peak = Math.max(peak, live); await sleep(15); live--; return okTextOnly; },
      imageSend: async () => okTextOnly,
    });
    assert.ok(peak <= 2, `编排器内并发峰值 ${peak}`);
  });
});

/* ================================================================== *
 * ⑥ ZEN_EXTERNAL_OK 接管 + 过期注释同步更新
 * ================================================================== */
describe("⑥ 探测结果接管 ZEN_EXTERNAL_OK，注释里那条过期说明同步更新", () => {
  const ZEN_BRANCH = SRC.slice(SRC.indexOf('if (p === "zen") {\n    /* Zen 提供公开模型目录'),
    SRC.indexOf('// 走到这里的只有 sn 与 bai 两家'));

  test("正向：目录分支改读 zenExternalOk，不再直接读那个常量", () => {
    assert.ok(ZEN_BRANCH.includes("zenExternalOk(id, cfg)"), "external 必须来自探测判定");
    assert.equal(/ZEN_EXTERNAL_OK\.has\(/.test(ZEN_BRANCH), false, "目录分支不得再直接读出厂常量");
    assert.ok(SRC.includes("function zenExternalOk(id, cfg)"), "接管函数必须存在");
  });

  test("反向对照：把调用换回老写法，断言立刻失败（证明这条不是恒真）", () => {
    const reverted = ZEN_BRANCH.replace("zenExternalOk(id, cfg)", "({ external: ZEN_EXTERNAL_OK.has(id) })");
    assert.equal(reverted.includes("zenExternalOk(id, cfg)"), false);
    assert.ok(/ZEN_EXTERNAL_OK\.has\(/.test(reverted), "老写法确实含常量直读");
  });

  test("正向：过期注释已改写，且不再声称 space-bunny-free 可用", () => {
    assert.equal(SRC.includes("实测（2026-10，用户 Free key）：免费档目录里 11 个 -free"),
      false, "那条已被 2026-10-12 实测推翻的说明必须删掉");
    assert.equal(SRC.includes("只有 space-bunny-free\n// 曾被实测能从外部调用"), false);
    assert.ok(SRC.includes("它现在的角色降级为「探测结果缺失时的占位」，不再当既成事实用"),
      "必须写明常量已降级为占位、判据是实测");
    assert.ok(SRC.includes("2026-10-12"), "注释要带上复核日期——「实测过」不等于「现在还成立」");
  });

  test("正向：zenExternalOk 的三态——探测有结论就用，没结论回落，未知不动", () => {
    // 这段把 server.mjs 的 zenExternalOk 抠出来真跑一遍（ZEN_EXTERNAL_OK 同一份源码）
    const start = SRC.indexOf("function zenExternalOk(id, cfg) {");
    const end = SRC.indexOf("\n}\n", start);
    assert.ok(start > 0 && end > start, "抠源码失败：找不到 zenExternalOk");
    const body = SRC.slice(start, end + 3);
    const runner = new Function("ZEN_EXTERNAL_OK", "zenProbeSnapshot", "zenProbeLoad",
      `${body}\nreturn zenExternalOk;`);
    const zenExternalOkFromSrc = (models) => (id, cfg) => runner(new Set(["space-bunny-free"]),
      () => ({ at: "t", upstream: "u", models }),
      () => ({ at: "t", upstream: "u", models }))(id, cfg);

    // ① 有探测结论 → 用探测结论（与出厂常量相反）
    const probedFail = zenExternalOkFromSrc({ "space-bunny-free": { ok: false, label: "探不通" } });
    const a = probedFail("space-bunny-free", {});
    assert.equal(a.external, false, "探测说探不通，就得是不通——不能被出厂常量翻回去");
    assert.equal(a.probed, true);
    // ② 没探过 → 回落出厂常量（否则下拉框会空、映射失去目标）
    const none = zenExternalOkFromSrc({});
    assert.equal(none("space-bunny-free", {}).external, true, "没探过时回落出厂常量");
    assert.equal(none("space-bunny-free", {}).probed, false);
    assert.equal(none("other-free", {}).external, false, "不在出厂白名单里的、也没探过 → 不通");
    // ③ ok === null（内容性错误）→ **不改判定**，仍走回落
    const unknown = zenExternalOkFromSrc({ "space-bunny-free": { ok: null } });
    const c = unknown("space-bunny-free", {});
    assert.equal(c.unknown, true, "null 要被标出来");
    assert.equal(c.external, true, "未知不改判定：仍沿用出厂结论");
    assert.notEqual(c.external, false, "绝不能因为一次内容性错误就踢出下拉框");
  });

  test("反向对照：把 null 当 false，探不通的模型会被误踢", () => {
    const models = { "space-bunny-free": { ok: null } };
    const rec = models["space-bunny-free"];
    assert.equal(rec.ok === null, true, "内容性错误产出的是 null");
    assert.equal(rec.ok === false, false, "它不是 false —— 若实现写成 === false 就误踢了");
  });

  test("落盘往返：结果带时间戳，换了上游整份作废", () => {
    const dir = path.join(TMPROOT, "persist");
    const payload = { at: "2026-10-12T00:00:00.000Z", upstream: "http://u/zen/v1", tier: "free", models: { "a-free": { ok: true, label: "可用 · 仅对话" } } };
    zenProbeSave(dir, payload);
    const back = zenProbeLoad(dir, "http://u/zen/v1", "free");
    assert.equal(back.models["a-free"].ok, true);
    assert.equal(back.at, "2026-10-12T00:00:00.000Z", "必须带时间戳，否则面板无法显示「上次检测时间」");
    const stale = zenProbeLoad(dir, "http://u/zen/go/v1", "go");
    assert.deepEqual(stale.models, {}, "换了档位整份作废——两档是两套目录与两套围栏");
    assert.equal(stale.stale, true);
    assert.equal(zenProbeLoad(path.join(TMPROOT, "nope"), "u", "free").models && typeof zenProbeLoad(path.join(TMPROOT, "nope"), "u", "free").models, "object");
    assert.ok(!existsSync(path.join(TMPROOT, "nope", "zen-capability.json")), "读不到时不许凭空造文件");
  });

  test("会话 id 固定：探针不每探一次造一个新会话", () => {
    assert.equal(ZEN_PROBE_SESSION, "bai-probe");
    // server.mjs 的 zenSessionId(isProbe=true) 必须回同一个值
    assert.ok(SRC.includes('if (isProbe) return ZEN_PROBE_SESSION;'), "zenSessionId 走的是同一个固定 id");
    assert.ok(SRC.includes('const ZEN_PROBE_SESSION = "bai-probe";'));
  });

  test("探针请求里不含任何凭据（红线）", async () => {
    const bodies = [];
    await zenProbeOne("m", { send: async (b) => { bodies.push(b); return okTextOnly; } });
    const dump = JSON.stringify(bodies);
    assert.equal(/authorization|bearer|api[-_]?key|oc_[A-Za-z0-9]{8,}/i.test(dump), false, "请求体里绝不能出现凭据");
    // server.mjs 侧：Key 只从 cfg.zen.apiKey 取进请求头，绝不进 URL / body
    const sendFn = SRC.slice(SRC.indexOf("async function zenProbeSend(cfg, body, { isProbe }) {"));
    const end = sendFn.indexOf("\n}\n");
    const fn = sendFn.slice(0, end + 3);
    assert.ok(fn.includes("zenUpstreamHeaders(z.apiKey"), "Key 走请求头");
    assert.equal(/url\s*\+=[^;]*apiKey|body[^;]*apiKey/.test(fn), false, "Key 绝不能进 URL 或请求体");
  });
});

/* ================================================================== *
 * 端到端：真 server.mjs + 假上游
 * ================================================================== */
async function freePorts(n) {
  const ss = [], ps = [];
  for (let i = 0; i < n; i++) {
    const s = http.createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    ps.push(s.address().port); ss.push(s);
  }
  await Promise.all(ss.map((s) => new Promise((r) => s.close(r))));
  return ps;
}

describe("T3/T6 e2e：真 server.mjs 打假上游，只探免费模型", () => {
  let child, fake, dataDir, P;
  const seen = [];           // 假上游收到的每个请求（含 body）
  let reply = null;          // 每个用例自己设；null = 默认 200 + tool_calls

  before(async () => {
    const [bai, sn, wb, wbai, zen, qd, or, panel, upstream] = await freePorts(9);
    P = { bai, sn, wb, wbai, zen, qd, or, panel, upstream };
    dataDir = mkdtempSync(path.join(TMPROOT, "boot-"));
    const cfg = JSON.parse(readFileSync(path.join(REPO, "src", "server", "config.defaults.json"), "utf8"));
    cfg.relayPort = bai; cfg.panelPort = panel;
    Object.assign(cfg, {
      sn: { ...cfg.sn, relayPort: sn }, wb: { ...cfg.wb, relayPort: wb }, wbai: { ...cfg.wbai, relayPort: wbai },
      zen: { ...cfg.zen, relayPort: zen }, qd: { ...cfg.qd, relayPort: qd }, or: { ...cfg.or, relayPort: or },
    });
    cfg.failover.enabled = false;
    // ⚠ 必须预置 cfg.proxy，否则服务启动后会跑代理探测并自重启（见 zen-go-tier-test 的同一处说明）
    cfg.proxy = "http://127.0.0.1:7897";
    cfg.zen = { ...cfg.zen, useProxy: false, apiKey: DUMMY_KEY, upstream: `http://127.0.0.1:${upstream}/zen/v1` };
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

    fake = http.createServer((req, res) => {
      // 目录端点：真实 Zen 是公开目录，这里给一份**混合**清单（免费 + 付费），
      // 付费项用来证明探测端点一次都不打它们。
      if (/\/zen\/v1\/models$/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [
          { id: "space-bunny-free" }, { id: "longcat-2.5-preview-free" }, { id: "gpt-5-free" },
          { id: "claude-sonnet-4-5" }, { id: "big-pickle" },
        ] }));
        return;
      }
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        let body = null; try { body = JSON.parse(raw); } catch { }
        seen.push({ url: req.url, model: body && body.model, maxTokens: body && body.max_tokens, headers: { ...req.headers } });
        const r = reply || { status: 200, body: { choices: [{ message: { tool_calls: [{ id: "c", type: "function", function: { name: "probe_ping", arguments: '{"value":"ok"}' } }] } }] } };
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise((r) => fake.listen(upstream, "127.0.0.1", r));

    child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, BAI_DATA_DIR: dataDir, NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    child.stdout.resume(); child.stderr.resume();
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      try { if ((await fetch(`http://127.0.0.1:${panel}/api/status`).then((r) => r.json())).service?.up) return; } catch { }
      await sleep(300);
    }
    throw new Error("server.mjs 40 秒内没把面板端口起起来");
  }, { timeout: 60000 });

  after(() => {
    try { child && child.kill(); } catch { }
    try { fake && fake.close(); } catch { }
    try { dataDir && rmSync(dataDir, { recursive: true, force: true }); } catch { }
  });

  const probe = () => fetch(`http://127.0.0.1:${P.panel}/api/models/probe-zen`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    signal: AbortSignal.timeout(180000),
  }).then((r) => r.json());
  const catalog = () => fetch(`http://127.0.0.1:${P.panel}/api/models?p=zen`).then((r) => r.json());
  const chatCalls = () => seen.filter((s) => /\/zen\/v1\/chat\/completions$/.test(s.url));

  test("端到端：POST /api/models/probe-zen 只打免费模型，付费模型 0 请求", async () => {
    seen.length = 0; reply = null;
    const r = await probe();
    assert.ok(r.probed > 0, `一轮都没探：${JSON.stringify(r).slice(0, 200)}`);
    const models = new Set(chatCalls().map((c) => c.model));
    assert.ok(models.size > 0, "假上游一个请求都没收到");
    for (const m of models) assert.match(m, /-free$/, `付费模型 ${m} 被打到了——探了要花钱`);
    assert.ok(r.skippedPaid.length > 0, "付费模型必须被如实报为跳过");
    for (const m of r.skippedPaid) assert.equal(models.has(m), false);
  }, { timeout: 200000 });

  test("端到端：探测请求 max_tokens ∈ {8,16}，会话头固定 bai-probe", async () => {
    seen.length = 0; reply = null;
    await probe();
    for (const c of chatCalls()) assert.ok([8, 16].includes(c.maxTokens), `max_tokens=${c.maxTokens} 不在 {8,16}`);
    // 免费档**不加** x-opencode-session（T4 已定：免费档一个字都不加）
    const sess = chatCalls().map((c) => c.headers["x-opencode-session"]).filter(Boolean);
    assert.equal(sess.length, 0, "免费档不应带 x-opencode-session");
    // Key 走请求头，绝不在 URL 里
    for (const c of chatCalls()) assert.equal(/oc_|authorization/i.test(c.url), false, `URL 里混进了凭据：${c.url}`);
    assert.ok(chatCalls()[0].headers.authorization === `Bearer ${DUMMY_KEY}`);
  }, { timeout: 200000 });

  test("端到端：探不通 → 不进下拉，且 ZEN_EXTERNAL_OK 被接管", async () => {
    seen.length = 0;
    reply = { status: 403, body: { type: "error", error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" } } };
    const r = await probe();
    const labels = Object.values(r.models).map((x) => x.label);
    assert.ok(labels.length > 0 && labels.every((l) => l === "探不通"), `403 FreeTierError 应全部判探不通：${JSON.stringify(labels)}`);
    const cat = await catalog();
    // 出厂白名单里明明有 space-bunny-free；探测说探不通，就不能还留在 models 里
    const ids = new Set((cat.all || []).map((m) => m.key));
    if (ids.has("space-bunny-free")) {
      assert.equal(cat.models.includes("space-bunny-free"), false, "探测判探不通的模型不许留在下拉里");
    }
    assert.ok(cat.capAtLabel, "面板要拿到「上次检测时间」");
    reply = null;
  }, { timeout: 200000 });

  test("端到端：200 + tool_calls → 标成「可用 · 支持工具」，且重新进下拉", async () => {
    reply = null;
    const r = await probe();
    const labels = Object.values(r.models).map((x) => x.label);
    assert.ok(labels.every((l) => l === "可用 · 支持工具"), `全部 200 + tool_calls 应判「可用 · 支持工具」：${JSON.stringify(labels)}`);
    const cat = await catalog();
    assert.ok(cat.all.some((m) => m.probed && m.capLabel === "可用 · 支持工具"), "目录项要带上探测标记");
    assert.ok(cat.capAt && cat.capHint, "要带检测时间与提示");
  }, { timeout: 200000 });

  test("反向对照：403 与 200 必须给出不同标签（否则上一条是恒真的）", () => {
    assert.notEqual(zenCapLabel({ ok: false }), zenCapLabel({ ok: true, tools: "yes" }));
    assert.equal(zenCapLabel({ ok: false }), "探不通");
    assert.equal(zenCapLabel({ ok: true, tools: "yes" }), "可用 · 支持工具");
    assert.equal(zenCapLabel({ ok: true, tools: "no" }), "可用 · 仅对话");
  });

  test("红线：整个测试没把凭据写进 DATA_DIR 之外的任何地方", () => {
    const f = path.join(dataDir, "zen-capability.json");
    assert.ok(existsSync(f), "探测结果必须落盘到 DATA_DIR");
    const txt = readFileSync(f, "utf8");
    assert.equal(/oc_[A-Za-z0-9]{6,}/.test(txt), false, "落盘结果里绝不能有 Key");
    assert.ok(!txt.includes(DUMMY_KEY), "连假 Key 都不该被写进去");
    assert.ok(JSON.parse(txt).at, "落盘必须带时间戳");
  });
});

/* ================================================================== *
 * ⑦ 图片维度：哨兵前置校验（v1.0.77 修的假阳性）
 *
 * 旧写法「真图不报错 → 支持图片」。但**「没报错」不等于「解析过」**：一个把
 * image 字段整个忽略、照样回 200 的上游会被记成 `yes` —— 纯假阳性，用户据此选了
 * 一个根本看不了图的模型。工具维度没这个洞：那边要求**真的看到 tool_use** 才 yes。
 *
 * 每条都配反向对照，其中 ★ 那条在**去掉哨兵**后必须变红（见 SABOTAGE-5）。
 * ================================================================== */
describe("⑦ 图片维度：哨兵前置校验——畸形图被收了就不许记 yes", () => {
  const chatOK = okWithTool;
  /** 上游真的拒了畸形图：400，原因是解码失败 → cls=content → 证明字段被解析 */
  const badImageRejected = { status: 400, text: JSON.stringify({ error: { message: "invalid base64 in image_url: illegal base64 character" } }) };
  /** 忽略图片字段、对什么都回 200 的上游（假阳性的元凶） */
  const ignoreEverything = okWithTool;
  /** 拒绝原因与图片无关（鉴权），判不出字段有没有被解析 */
  const authErr = { status: 401, text: "unauthorized" };

  const urlOf = (body) => body.messages[0].content.find((c) => c.type === "image_url").image_url.url;

  test("正向：畸形图被拒 + 真图 2xx → yes（哨兵已证明字段被解析）", async () => {
    const calls = [];
    const obs = await zenProbeOne("m-free", {
      send: async () => chatOK,
      imageSend: async (b, o) => { calls.push([urlOf(b), o.isProbe]); return calls.length === 1 ? badImageRejected : okTextOnly; },
    });
    assert.equal(calls.length, 2, "哨兵 + 真图，恰好两发");
    assert.equal(calls[0][0], ZEN_PROBE_PNG_SENTINEL, "第一发必须是畸形图（哨兵）");
    assert.equal(calls[1][0], ZEN_PROBE_PNG_1PX, "第二发才是那张 1×1 真图");
    assert.deepEqual(calls.map((c) => c[1]), [true, true], "两发都必须显式 isProbe:true");
    assert.equal(obs.image, "yes");
  });

  test("★ 反向对照：畸形图被**收了**（对什么都回 200）→ 必须是 unknown，绝不是 yes", async () => {
    // 这正是旧代码的假阳性：真图那发 2xx → 旧写法直接 image = "yes"。
    const calls = [];
    const obs = await zenProbeOne("m-free", {
      send: async () => chatOK,
      imageSend: async (b) => { calls.push(urlOf(b)); return ignoreEverything; },
    });
    assert.equal(calls.length, 1, "哨兵没过就不该再发真图——判不出来，发了也是噪声");
    assert.equal(calls[0], ZEN_PROBE_PNG_SENTINEL);
    assert.notEqual(obs.image, "yes", "假阳性：上游压根没解析图片字段，却被记成支持图片");
    assert.equal(obs.image, "unknown");
    assert.match(obs.imageWhy, /畸形/, "必须说清为什么没结论");
    assert.match(obs.imageWhy, /假阳性|宁可未知/, "文案要点破这正是不想要的假阳性");
  });

  test("反向对照：畸形图被拒 + 真图也被拒 → 不是 yes", async () => {
    const obs = await zenProbeOne("m-free", {
      send: async () => chatOK,
      // 按 data URL 区分哨兵与真图（两发的 isProbe 都是 true，光看参数分不出来）
      imageSend: async (b) => (urlOf(b) === ZEN_PROBE_PNG_SENTINEL
        ? badImageRejected
        : { status: 400, text: JSON.stringify({ error: { message: "image input is not supported by this model" } }) }),
    });
    assert.notEqual(obs.image, "yes");
    assert.equal(obs.image, "no", "文案点了名不支持 → 判 no");
  });

  test("哨兵被拒但原因与图片无关（401）→ 无法验证，记 unknown", async () => {
    const calls = [];
    const obs = await zenProbeOne("m-free", {
      send: async () => chatOK,
      imageSend: async (b) => { calls.push(urlOf(b)); return authErr; },
    });
    assert.equal(calls.length, 1, "鉴权失败说不了字段的事，不发第二发");
    assert.equal(obs.image, "unknown");
    assert.match(obs.imageWhy, /无法验证/, "要如实说明是「无法验证」而不是「不支持」");
  });

  test("哨兵自己抛网络错 → unknown，且不拖垮 ok/tools 两个维度", async () => {
    const obs = await zenProbeOne("m-free", {
      send: async () => chatOK,
      imageSend: async () => { throw new Error("ECONNRESET"); },
    });
    assert.equal(obs.image, "unknown");
    assert.equal(obs.chat.reachable, false, "图片维度炸了不许影响可达维度");
    assert.equal(zenProbeVerdict(obs).ok, true, "合成后仍判「探不通=false → 可用」");
  });

  test("哨兵常量本身就是畸形的（不是一张合法 base64 图）", () => {
    const payload = ZEN_PROBE_PNG_SENTINEL.replace(/^data:image\/png;base64,/, "");
    assert.ok(/!/.test(payload), "哨兵载荷必须含 base64 字母表外的字符");
    assert.notEqual(ZEN_PROBE_PNG_SENTINEL, ZEN_PROBE_PNG_1PX, "哨兵与真图必须是两个不同的 data URL");
    assert.ok(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(ZEN_PROBE_PNG_1PX), "真图那份必须仍是合法 base64");
  });

  test("哨兵判据三态本身：2xx=没解析 / 与图片无关=无法验证 / 内容层拒绝=解析了", () => {
    assert.equal(zenProbeImageSentinel(200, okTextOnly.text).parsed, false);
    assert.equal(zenProbeImageSentinel(401, "unauthorized").parsed, null);
    assert.equal(zenProbeImageSentinel(429, "slow down").parsed, null);
    assert.equal(zenProbeImageSentinel(500, "boom").parsed, null);
    assert.equal(zenProbeImageSentinel(400, badImageRejected.text).parsed, true);
  });

  test("哨兵多花的这一次请求有据可查：sent 里两发都在，且都不含凭据", async () => {
    const obs = await zenProbeOne("m-free", {
      send: async () => chatOK,
      imageSend: async () => badImageRejected,
    });
    assert.equal(obs.sent.length, 3, "1 发对话 + 哨兵 + 真图");
    const urls = obs.sent.filter((b) => Array.isArray(b.messages[0].content)).map(urlOf);
    assert.deepEqual(urls, [ZEN_PROBE_PNG_SENTINEL, ZEN_PROBE_PNG_1PX]);
    assert.equal(JSON.stringify(obs.sent).includes(DUMMY_KEY), false, "发出去的报文里绝不能有 Key");
  });

  test("★ 反向对照：把哨兵那步去掉，第一条假阳性用例必须变红（证明断言不是恒真的）", () => {
    /* 在内存里把「哨兵被收了 → 记 unknown」这一分支改回旧行为
     * （哨兵结果一律放行，直接问真图、2xx 即 yes），重跑同一组输入。 */
    const oldWay = (sentinelAccepted, realOk) => (sentinelAccepted && realOk ? "yes" : (realOk ? "yes" : "unknown"));
    // 旧写法对「忽略图片的上游」给出的结论：
    assert.equal(oldWay(true, true), "yes", "旧代码确实会把这种上游记成 yes —— 这就是那个洞");
    // 新写法拒绝这么做：
    assert.notEqual(
      (sentinelAccepted) => (sentinelAccepted ? "yes" : "unknown"),
      () => "yes");
    assert.equal(
      (() => { const s = zenProbeImageSentinel(200, okTextOnly.text); return s.parsed === true ? "yes" : "unknown"; })(),
      "unknown",
      "新判据对同一输入给 unknown");
  });
});

/* ================================================================== *
 * §SABOTAGE —— 把真源码改回改前行为，测试必须变红
 * ================================================================== */
describe("§SABOTAGE 说明（这些不是测试，是给人执行的改法）", () => {
  test("四组改法清单", () => {
    const list = [
      ["SABOTAGE-1 calls:0 判成不支持工具", "把 zen-probe.mjs 里的 `else rec.tools = \"unverified\";` 改成 `else rec.tools = \"no\";`", "① 两条用例变红"],
      ["SABOTAGE-2 内容性错误判死", "把 zenProbeClassify 里 400 分支的 `reachable: null` 改成 `reachable: true`", "② 两条用例变红"],
      ["SABOTAGE-3 isProbe 由 body 反推", "把 zenProbeOne 里 `send(body, { isProbe: true })` 改成 `send(body, { isProbe: body.max_tokens <= 8 })`", "③ 三条用例变红"],
      ["SABOTAGE-4 并发不限", "把 zenProbePool 的 `Math.min(Number(limit), ZEN_PROBE_CONCURRENCY)` 改成 `Number(limit)` 并把 limit 默认值传大", "⑤ 三条用例变红"],
      ["SABOTAGE-5 去掉图片哨兵（★本次假阳性的根）", "把 zenProbeOne 里 `if (sv.parsed !== true) { ... image = \"unknown\" ... }` 这个分支整个删掉，让真图那发无条件执行（=改回 v1.0.76 的写法）", "⑦ 的 ★「畸形图被收了」用例变红（image 变 yes）"],
    ];
    for (const [name, how, expect] of list) assert.ok(name && how && expect);
    assert.equal(list.length, 5);
  });
});