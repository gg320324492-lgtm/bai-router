// scripts/env-shadow-test.mjs —— env-shadow.mjs 的测试
//
// 红线：接线写进配置文件的地址/凭据**可能根本没生效** —— 用户系统里那个同名
// 环境变量会盖掉它，而面板显示「已接上」。这一层一旦被改弱（漏报、误报、
// 或者把明文凭据写进报告），用户就会拿着一个「连上了但答不对」的客户端查半天。
//
// 所以每条断言都写成「旧代码必然让它红」的样子，并把「把实现改坏」的那几种
// 改法真的跑一遍，证明对应的断言**真的会红**。
//
// 跑法：node --test scripts/env-shadow-test.mjs
//
// 纪律：
//   · **不碰真注册表**：读注册表那层用 opts.exec 注入假的 runner。
//   · **不碰用户真配置**：只读声明，不写盘；落盘只在 os.tmpdir()。
//   · 报告里**不能出现明文凭据** —— 有一条断言专门盯这个。

import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  maskValue, sameValue, envVarNameOf, severityOf, reasonOf,
  normalizeUserEnv, readUserEnv, detectEnvShadow, checkClientEnvShadow, envShadowNotice,
} from "../src/server/clients/env-shadow.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "server", "clients", "env-shadow.mjs");

/**
 * mutated —— 把实现改坏，跑一遍，证明对应的断言会红。
 * 改坏的副本写到临时目录 ⇒ **仓库里的源码一个字不动**。
 */
let mutSeq = 0;
async function mutated(pairs) {
  let src = readFileSync(SRC, "utf8");
  for (const [from, to] of pairs) {
    assert.ok(src.includes(from), `锚点不在源码里，改坏的方式已经失效：${from}`);
    src = src.replace(from, to);
  }
  const dir = mkdtempSync(join(tmpdir(), "env-shadow-mut-"));
  const file = join(dir, "env-shadow.mjs");
  writeFileSync(file, src, "utf8");
  mutSeq += 1;
  const mod = await import(pathToFileURL(file).href + "#" + mutSeq);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 收不走就算了 */ }
  return mod;
}

/**
 * stripComments —— 把注释剥掉，只留代码。
 *
 * ⚠ 为什么需要它：模块的文件头就写着「**不拿进程环境当用户环境**」，
 *   那句里的 `process.env` 是**说明文字**而不是代码。扫全文会把正确的
 *   注释判成违规 —— 这条断言自己就是这么翻车的。
 *   ⇒ 断言要针对**代码锚点**，不是注释里出现的那个词。
 *
 * ⚠ 只剥「独立成行的注释」与块注释：这个模块的注释都这么写
 *   （没有「代码后面跟一句 //」那种），所以不必去处理行尾注释
 *   （处理它得小心字符串里的 `//`，比如 URL）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/* ---------- ① 哪些键算「环境变量名」 ---------- */

test("① dotenv 格式：键路径整条就是环境变量名（dotenv 的键没有层级）", () => {
  assert.equal(envVarNameOf({ path: "GOOGLE_GEMINI_BASE_URL" }, "dotenv"), "GOOGLE_GEMINI_BASE_URL");
  assert.equal(envVarNameOf({ path: "GEMINI_API_KEY" }, "dotenv"), "GEMINI_API_KEY");
  /* ⚠ dotenv 自己会忽略不合规的键名 ⇒ 那不是环境变量 */
  assert.equal(envVarNameOf({ path: "A-B" }, "dotenv"), null);
  assert.equal(envVarNameOf({ path: "1X" }, "dotenv"), null);
});

test("① 其它格式：只有 env.<NAME> 这种单段形状才算环境变量名", () => {
  assert.equal(envVarNameOf({ path: "env.ANTHROPIC_BASE_URL" }, "json"), "ANTHROPIC_BASE_URL");
  assert.equal(envVarNameOf({ path: "env.BAI_QWEN_API_KEY" }, "json"), "BAI_QWEN_API_KEY");
  /* env 块里的嵌套键不是环境变量 */
  assert.equal(envVarNameOf({ path: "env.foo.bar" }, "json"), null);
  /* 配置文件自己的键与环境变量无关 */
  assert.equal(envVarNameOf({ path: "model.name" }, "json"), null);
  assert.equal(envVarNameOf({ path: "security.auth.selectedType" }, "json"), null);
  assert.equal(envVarNameOf({ path: "" }, "json"), null);
  assert.equal(envVarNameOf(null, "json"), null);
});

test("★ ① 强度按「客户端怎么读环境变量」分，**不按格式分**", () => {
  /* Gemini CLI（同源实现只填补空缺）：真环境变量赢 ⇒ 一定被盖 */
  assert.equal(severityOf({ path: "GOOGLE_GEMINI_BASE_URL" }, "dotenv", "gemini-cli"), "blocking");
  assert.equal(severityOf({ path: "env.BAI_QWEN_API_KEY" }, "json", "qwen-code"), "blocking");
  /* Claude Code：实测自己的配置赢 ⇒ 压根不报 */
  assert.equal(severityOf({ path: "env.ANTHROPIC_BASE_URL" }, "json", "claude-code"), null);
  /* 没列入已知名单的 ⇒ 只提醒，不替客户端下定论 */
  assert.equal(severityOf({ path: "BAI_REASONIX_API_KEY" }, "dotenv", "reasonix"), "advisory");
  assert.equal(severityOf({ path: "env.X" }, "json", "some-other"), "advisory");
  /* 声明式覆盖压过内置名单 */
  assert.equal(severityOf({ path: "env.X" }, "json", "claude-code", "env-wins"), "blocking");
  assert.equal(severityOf({ path: "env.X" }, "json", "gemini-cli", "config-wins"), null);
  assert.match(reasonOf("blocking"), /环境变量/);
  assert.match(reasonOf("advisory"), /取决于/);
});

/* ---------- ② 遮蔽判据 ---------- */

const WRITES_DOTENV = [
  { path: "GOOGLE_GEMINI_BASE_URL", value: "http://127.0.0.1:15799", file: "C:/u/.gemini/.env", format: "dotenv" },
  { path: "GEMINI_API_KEY", value: "bai-local", file: "C:/u/.gemini/.env", format: "dotenv" },
];

test("★ ② 同名且值不同 ⇒ 报遮蔽：我们写的地址不生效", () => {
  const r = detectEnvShadow({
    writes: WRITES_DOTENV,
    userEnv: [{ name: "GOOGLE_GEMINI_BASE_URL", value: "https://generativelanguage.googleapis.com", scope: "User" }],
    clientId: "gemini-cli", clientName: "Gemini CLI",
  });
  assert.equal(r.shadowed, true, "必须报出遮蔽");
  assert.equal(r.shadows.length, 1);
  const s = r.shadows[0];
  assert.equal(s.envKey, "GOOGLE_GEMINI_BASE_URL");
  assert.equal(s.clientId, "gemini-cli");
  assert.equal(s.clientName, "Gemini CLI");
  assert.equal(s.severity, "blocking");
  assert.equal(s.scope, "User");
  assert.equal(s.same, false);
  /* 没被盖住的那个键不该出现在报告里 */
  assert.equal(r.shadows.filter((x) => x.envKey === "GEMINI_API_KEY").length, 0);
});

test("★ ② 同名且值相同 ⇒ 不算遮蔽（只是碰巧一样），但要单独记一笔", () => {
  const r = detectEnvShadow({
    writes: WRITES_DOTENV,
    userEnv: [{ name: "GOOGLE_GEMINI_BASE_URL", value: "http://127.0.0.1:15799", scope: "User" }],
    clientId: "gemini-cli",
  });
  assert.equal(r.shadowed, false, "值一样 ⇒ 不是遮蔽");
  assert.equal(r.shadows.length, 0);
  assert.equal(r.same.length, 1);
  assert.equal(r.same[0].envKey, "GOOGLE_GEMINI_BASE_URL");
  assert.equal(r.same[0].same, true);
});

test("② 系统里没有同名变量 ⇒ 干净", () => {
  const r = detectEnvShadow({
    writes: WRITES_DOTENV,
    userEnv: [{ name: "PATH", value: "C:\\Windows", scope: "Machine" }],
    clientId: "gemini-cli",
  });
  assert.equal(r.shadowed, false);
  assert.equal(r.shadows.length, 0);
  assert.equal(r.checked, 2, "两个 env 键都要查过");
});

test("★ ② 我们自己这个键是空的 ⇒ 谈不上被盖（我们压根没写东西）", () => {
  const r = detectEnvShadow({
    writes: [{ path: "GEMINI_API_KEY", value: "", file: "x/.env", format: "dotenv" }],
    userEnv: [{ name: "GEMINI_API_KEY", value: "别人的key", scope: "User" }],
    clientId: "gemini-cli",
  });
  assert.equal(r.shadows.length, 0, "空值不算被盖");
  assert.equal(r.empty.length, 1, "但要记一笔：那个键是空的");
  assert.equal(r.empty[0].envKey, "GEMINI_API_KEY");
});

test("② 尾斜杠只差一个 ⇒ 算一样（地址类常犯的毛病）", () => {
  assert.equal(sameValue("http://127.0.0.1:15799", "http://127.0.0.1:15799/"), true);
  assert.equal(sameValue("  http://127.0.0.1:15799  ", "http://127.0.0.1:15799"), true);
  assert.equal(sameValue("http://127.0.0.1:15799", "http://127.0.0.1:15999"), false);
  /* ⚠ 大小写不归一：凭据大小写敏感，归一过头会把「真的不同」说成一样 ⇒ 漏报 */
  assert.equal(sameValue("sk-ABC", "sk-abc"), false);
  /* ⚠ 两个空值：不能因为归一后都是 "" 就说一样 */
  assert.equal(sameValue("", "/"), false);
  assert.equal(sameValue("", ""), true);
});

test("★ ② Windows 上环境变量名不区分大小写（GOOGLE_GEMINI_BASE_URL 与小写是同一个）", () => {
  const r = detectEnvShadow({
    writes: WRITES_DOTENV,
    userEnv: [{ name: "google_gemini_base_url", value: "https://别的地址", scope: "User" }],
    clientId: "gemini-cli",
  });
  assert.equal(r.shadows.length, 1, "Windows 上大小写不同也撞名 ⇒ 必须报出来");
  assert.equal(r.shadows[0].envKey, "GOOGLE_GEMINI_BASE_URL", "报的是我们写的那个名字");
});

test("② POSIX 上大小写不同就是不同 ⇒ 不撞名", () => {
  const r = detectEnvShadow({
    writes: WRITES_DOTENV,
    userEnv: [{ name: "google_gemini_base_url", value: "https://别的地址", scope: "User" }],
    clientId: "gemini-cli",
    caseInsensitive: false,
  });
  assert.equal(r.shadows.length, 0);
});

test("② 同一名字 User 与 Machine 都有 ⇒ 取 User 的那个（Windows 的实际行为）", () => {
  const env = normalizeUserEnv([
    { name: "GEMINI_API_KEY", value: "机器级的", scope: "Machine" },
    { name: "GEMINI_API_KEY", value: "用户级的", scope: "User" },
  ]);
  const hit = env.get("GEMINI_API_KEY");
  assert.equal(hit.value, "用户级的");
  assert.equal(hit.scope, "User");
});

/* ---------- ③ 脱敏 ---------- */

test("★ ③ 报告里不能出现明文凭据（只有前几位与长度）", () => {
  const SECRET = "sk-live-THIS-MUST-NEVER-LEAK-9f3a2b";
  const r = detectEnvShadow({
    writes: [{ path: "GEMINI_API_KEY", value: SECRET, file: "x/.env", format: "dotenv" }],
    userEnv: [{ name: "GEMINI_API_KEY", value: "sk-live-别的-KEY-abcdef", scope: "User" }],
    clientId: "gemini-cli",
  });
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes(SECRET), "我们的凭据原文不能出现在报告里");
  assert.ok(!dump.includes("sk-live-别的-KEY-abcdef"), "用户系统里的原文也不能出现");
  assert.match(dump, /sk-liv/);
  assert.match(dump, /长度/);
});

test("③ 脱敏：短值只报长度（贴前几位等于贴全文）", () => {
  const m = maskValue("abc");
  assert.ok(!m.masked.includes("abc"), "短值不能露出内容：" + m.masked);
  assert.equal(m.length, 3);
  const e = maskValue("");
  assert.equal(e.length, 0);
  assert.equal(e.masked, "(空)");
  const l = maskValue("0123456789");
  assert.equal(l.length, 10);
  assert.ok(l.masked.startsWith("012345"));
  assert.ok(!l.masked.includes("789"), "只给前几位");
});

/* ---------- ④ 读注册表那层（注入假的 runner，不碰真注册表） ---------- */

/** 造一个假的 exec：把「注册表里有什么」直接编码成模块要的那份 Base64。 */
function fakeExec(envPairs, opts = {}) {
  return (file, args, o) => {
    if (opts.fail) throw new Error("假的失败：" + (opts.fail || ""));
    const obj = {};
    for (const p of envPairs) obj[`${p.scope}|${p.name}`] = p.value;
    const json = JSON.stringify(obj);
    return Buffer.from(json, "utf8").toString("base64");
  };
}

test("④ 读回来的注册表内容能正确解开（scope 与值都在）", () => {
  const r = readUserEnv({
    platform: "win32",
    exec: fakeExec([
      { scope: "User", name: "GOOGLE_GEMINI_BASE_URL", value: "http://127.0.0.1:15799" },
      { scope: "Machine", name: "PATH", value: "C:\\Windows\\system32" },
    ]),
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.source, "windows-registry");
  const u = r.env.find((e) => e.name === "GOOGLE_GEMINI_BASE_URL");
  assert.equal(u.value, "http://127.0.0.1:15799");
  assert.equal(u.scope, "User");
  const m = r.env.find((e) => e.name === "PATH");
  assert.equal(m.scope, "Machine");
});

test("★ ④ 读不到时必须 ok:false 且带一句能给人看的错（不能假装没遮蔽）", () => {
  const r = readUserEnv({ platform: "win32", exec: fakeExec([], { fail: "powershell 没了" }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /powershell/);
  assert.equal(r.env.length, 0);
});

test("④ 非 Windows 平台 ⇒ 如实说「还没实现」，不假装查过了", () => {
  const r = readUserEnv({ platform: "linux", exec: fakeExec([]) });
  assert.equal(r.ok, false);
  assert.match(r.error, /Windows/);
});

test("★ ④ 不用进程环境当「用户设置过的环境变量」", () => {
  const ONLY = "ENV_SHADOW_TEST_ONLY_IN_PROCESS";
  process.env[ONLY] = "在进程里，不在注册表里";
  try {
    const r = readUserEnv({ platform: "win32", exec: fakeExec([]) });
    assert.equal(r.ok, true, r.error);
    assert.equal(
      r.env.find((e) => e.name === ONLY), undefined,
      "进程环境不是用户设置过的环境变量 ⇒ 不能混进来",
    );
  } finally {
    delete process.env[ONLY];
  }
});

/* ---------- ⑤ 用真的客户端声明跑一遍 ---------- */

test("★ ⑤ Gemini CLI 的声明：两个行业标准名的键都会被查", async () => {
  const { geminiCliClient } = await import("../src/server/clients/gemini-cli.mjs");
  const r = checkClientEnvShadow(geminiCliClient, {
    home: "C:/fake-home", baseUrl: "http://127.0.0.1:15799", apiKey: "bai-local",
  }, {
    env: [
      { name: "GOOGLE_GEMINI_BASE_URL", value: "https://generativelanguage.googleapis.com", scope: "User" },
      { name: "GEMINI_API_KEY", value: "别人的key", scope: "User" },
    ],
  });
  assert.equal(r.ok, true, r.detail);
  const keys = r.shadows.map((s) => s.envKey).sort();
  assert.deepEqual(keys, ["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL"]);
  assert.ok(r.shadows.every((s) => s.severity === "blocking"), "写在 .env 里 ⇒ 确定被盖");
  assert.ok(r.shadows.every((s) => s.file.includes(".gemini")), "要说清写在哪个文件：" + r.shadows[0].file);
});

test("★ ⑤ Claude Code：已实测它自己的配置赢 ⇒ 同名环境变量盖不住 ⇒ 不报遮蔽", async () => {
  const { claudeCodeClient } = await import("../src/server/clients/claude-code.mjs");
  const r = checkClientEnvShadow(claudeCodeClient, {
    home: "C:/fake-home",
    baseUrl: "http://127.0.0.1:15799",
    apiKey: "bai-local",
    cli: { editsFor: () => [{ path: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:15799" }] },
  }, {
    env: [{ name: "ANTHROPIC_BASE_URL", value: "https://别的地址", scope: "User" }],
  });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.shadows.length, 0, "claude-code 已实测是配置赢 ⇒ 不该报遮蔽");
  assert.equal(r.checked, 1, "但确实查过（不是压根没查）");
  assert.equal(r.ignored.length, 1, "要留个痕：查过、判定为不影响");
  assert.equal(r.ignored[0].envKey, "ANTHROPIC_BASE_URL");
});

test("⑤ Reasonix 的声明：.env 里的那个变量名会被查", async () => {
  const { reasonixClient } = await import("../src/server/clients/reasonix.mjs");
  const r = checkClientEnvShadow(reasonixClient, {
    home: "C:/fake-home", baseUrl: "http://127.0.0.1:15799", apiKey: "bai-local",
    models: [{ id: "sn/claude-opus-5", label: "Opus" }],
  }, {
    env: [{ name: "BAI_REASONIX_API_KEY", value: "别的key", scope: "User" }],
  });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.shadows.length, 1);
  assert.equal(r.shadows[0].envKey, "BAI_REASONIX_API_KEY");
  /* ⚠ Reasonix **自己的 dotenv 读取器**对重复赋值的处理与编辑器不同
   *   （magpie internal/agent/reasonix.go:151-154 明写）⇒ 运行时优先级不确定
   *   ⇒ 只提醒，不说「已确定被盖住」。 */
  assert.equal(r.shadows[0].severity, "advisory");
});

test("★ ⑤ 声明式覆盖压过内置名单（主线程可以把判定挪进各客户端声明）", () => {
  const def = {
    id: "reasonix",
    name: "Reasonix Studio",
    envShadow: { priority: "env-wins" },
    files: (ctx) => [{
      path: "C:/x/.env",
      format: "dotenv",
      writes: () => [{ path: "BAI_REASONIX_API_KEY", value: "bai-local" }],
    }],
  };
  const r = checkClientEnvShadow(def, {}, {
    env: [{ name: "BAI_REASONIX_API_KEY", value: "别的key", scope: "User" }],
  });
  assert.equal(r.shadows.length, 1);
  assert.equal(r.shadows[0].severity, "blocking", "声明说 env-wins ⇒ 就是 blocking");

  const def2 = { ...def, envShadow: { priority: "config-wins" } };
  const r2 = checkClientEnvShadow(def2, {}, {
    env: [{ name: "BAI_REASONIX_API_KEY", value: "别的key", scope: "User" }],
  });
  assert.equal(r2.shadows.length, 0, "声明说 config-wins ⇒ 不报");
  assert.equal(r2.ignored.length, 1);
});

test("⑤ 非 env 键的客户端（模型名那些）查不出东西来", async () => {
  const { geminiCliClient } = await import("../src/server/clients/gemini-cli.mjs");
  const r = checkClientEnvShadow(geminiCliClient, {
    home: "C:/fake-home", baseUrl: "http://127.0.0.1:15799", apiKey: "bai-local",
  }, {
    env: [
      { name: "model", value: "x" }, { name: "security", value: "x" },
      { name: "GOOGLE_GEMINI_BASE_URL", value: "http://127.0.0.1:15799", scope: "User" },
    ],
  });
  assert.equal(r.shadows.length, 0, "值一样 ⇒ 不算遮蔽");
  assert.equal(r.same.length, 1);
});

/* ---------- ⑥ 提示文案 ---------- */

test("★ ⑥ 遮蔽时那句话要说清：哪个客户端、哪个键、我们写的什么、用户那个是什么（脱敏）", () => {
  const SECRET = "sk-live-NEVER-LEAK-1234567890";
  const r = detectEnvShadow({
    writes: [{ path: "GEMINI_API_KEY", value: SECRET, file: "C:/u/.gemini/.env", format: "dotenv" }],
    userEnv: [{ name: "GEMINI_API_KEY", value: "sk-live-OTHER-0987654321", scope: "User" }],
    clientId: "gemini-cli", clientName: "Gemini CLI",
  });
  const note = envShadowNotice({ ...r, envOk: true });
  assert.match(note, /Gemini CLI/);
  assert.match(note, /GEMINI_API_KEY/);
  assert.match(note, /\.gemini/);
  assert.match(note, /用户级/);
  assert.ok(!note.includes(SECRET), "文案里不能有明文凭据");
  assert.ok(!note.includes("sk-live-OTHER-0987654321"), "文案里不能有用户的明文值");
});

test("★ ⑥ 读不到用户环境变量时，文案必须说「没查成」（沉默会被读成「没遮蔽」）", () => {
  const note = envShadowNotice({ ok: true, checked: 0, shadows: [], same: [], empty: [], envOk: false, envError: "注册表读不到" });
  assert.match(note, /注册表读不到/);
  assert.ok(!/没有遮蔽/.test(note));
});

test("★ ⑥ 读失败时传 envRead 进去，不能被当成「读到了而且是空的」", async () => {
  const { geminiCliClient } = await import("../src/server/clients/gemini-cli.mjs");
  const r = checkClientEnvShadow(geminiCliClient, {
    home: "C:/fake-home", baseUrl: "http://127.0.0.1:15799", apiKey: "bai-local",
  }, {
    envRead: { ok: false, env: [], source: "windows-registry", error: "注册表读不到" },
  });
  assert.equal(r.envOk, false, "读失败的状态要传下去");
  assert.match(r.detail, /注册表读不到/);
  assert.match(r.detail, /没法确认/);
  assert.equal(r.shadows.length, 0);
});

test("⑥ scope 是透传的：主线程自己加的档（进程级）文案不能被说成「用户级」", () => {
  const r = detectEnvShadow({
    writes: [{ path: "GEMINI_API_KEY", value: "bai-local", file: "x/.env", format: "dotenv" }],
    userEnv: [{ name: "GEMINI_API_KEY", value: "别的key", scope: "Process" }],
    clientId: "gemini-cli", clientName: "Gemini CLI",
  });
  assert.equal(r.shadows[0].scope, "Process", "scope 原样传下去");
  const note = envShadowNotice({ ...r, envOk: true });
  assert.match(note, /进程级/, "文案要说对来源：" + note);
  assert.ok(!/用户级/.test(note), "不能把进程环境说成用户环境：" + note);
});

test("⑥ 没有遮蔽 ⇒ 文案不打扰用户", () => {
  const note = envShadowNotice({ ok: true, checked: 2, shadows: [], same: [], empty: [], envOk: true });
  assert.equal(note, "");
});

/* ---------- ⑦ 反向对照：把实现改坏，断言必须红 ---------- */

test("★ ⑦ 反向对照：dotenv 的键认不出来，「同名不同值要报遮蔽」这条断言必须红", async () => {
  const bad = await mutated([[
    `if (String(format || "").toLowerCase() === "dotenv") {
    return ENV_NAME_RE.test(p) ? p : null;
  }`,
    `if (String(format || "").toLowerCase() === "dotenv") {
    return null;
  }`,
  ]]);
  const good = detectEnvShadow({
    writes: WRITES_DOTENV,
    userEnv: [{ name: "GOOGLE_GEMINI_BASE_URL", value: "https://别的", scope: "User" }],
  });
  assert.equal(good.shadows.length, 1, "好的实现");

  const broken = bad.detectEnvShadow({
    writes: WRITES_DOTENV,
    userEnv: [{ name: "GOOGLE_GEMINI_BASE_URL", value: "https://别的", scope: "User" }],
  });
  assert.equal(broken.shadows.length, 0, "改坏之后这条断言必须红");
});

test("★ ⑦ 反向对照：env 块的键认不出来，「env 块也要查」这条断言必须红", async () => {
  const bad = await mutated([[
    `const m = /^env\\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(p);
  return m ? m[1] : null;`,
    `return null;`,
  ]]);
  const writes = [{ path: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:15799", file: "s.json", format: "json" }];
  const good = detectEnvShadow({ writes, userEnv: [{ name: "ANTHROPIC_BASE_URL", value: "https://别的", scope: "User" }] });
  assert.equal(good.shadows.length, 1, "好的实现");

  const broken = bad.detectEnvShadow({ writes, userEnv: [{ name: "ANTHROPIC_BASE_URL", value: "https://别的", scope: "User" }] });
  assert.equal(broken.shadows.length, 0, "改坏之后这条断言必须红");
});

test("★ ⑦ 反向对照：值比较永远判「不同」，「值一样不算遮蔽」这条断言必须红", async () => {
  const bad = await mutated([[
    `if (x === y) return true;`,
    `if (x === y) return false;`,
  ]]);
  const writes = [{ path: "GOOGLE_GEMINI_BASE_URL", value: "http://127.0.0.1:15799", file: "x/.env", format: "dotenv" }];
  const userEnv = [{ name: "GOOGLE_GEMINI_BASE_URL", value: "http://127.0.0.1:15799", scope: "User" }];
  const good = detectEnvShadow({ writes, userEnv });
  assert.equal(good.shadows.length, 0, "好的实现：值一样不是遮蔽");

  const broken = bad.detectEnvShadow({ writes, userEnv });
  assert.equal(broken.shadows.length, 1, "改坏之后这条断言必须红");
});

test("★ ⑦ 反向对照：值比较永远判「一样」，「值不同要报遮蔽」这条断言必须红", async () => {
  const bad = await mutated([[
    `if (x === y) return true;`,
    `if (x === y) return true;
  return true;`,
  ]]);
  const writes = [{ path: "GOOGLE_GEMINI_BASE_URL", value: "http://127.0.0.1:15799", file: "x/.env", format: "dotenv" }];
  const userEnv = [{ name: "GOOGLE_GEMINI_BASE_URL", value: "https://别的", scope: "User" }];
  const good = detectEnvShadow({ writes, userEnv });
  assert.equal(good.shadows.length, 1, "好的实现");

  const broken = bad.detectEnvShadow({ writes, userEnv });
  assert.equal(broken.shadows.length, 0, "改坏之后这条断言必须红（否则真遮蔽会被漏报）");
});

test("★ ⑦ 反向对照：大小写归一去掉，「Windows 上撞名要报出来」这条断言必须红", async () => {
  const bad = await mutated([[
    `const ci = opts.caseInsensitive !== false;`,
    `const ci = false;`,
  ]]);
  const writes = [{ path: "GOOGLE_GEMINI_BASE_URL", value: "http://127.0.0.1:15799", file: "x/.env", format: "dotenv" }];
  const userEnv = [{ name: "google_gemini_base_url", value: "https://别的", scope: "User" }];
  const good = detectEnvShadow({ writes, userEnv });
  assert.equal(good.shadows.length, 1, "好的实现");

  const broken = bad.detectEnvShadow({ writes, userEnv });
  assert.equal(broken.shadows.length, 0, "改坏之后这条断言必须红");
});

test("★ ⑦ 反向对照：脱敏改成贴全文，「报告里不能有明文凭据」这条断言必须红", async () => {
  const bad = await mutated([[
    `if (s.length <= 6) return { masked: \`(短值，长度 \${s.length})\`, length: s.length };`,
    `return { masked: s, length: s.length };`,
  ]]);
  const SECRET = "sk-live-THIS-MUST-NEVER-LEAK-9f3a2b";
  const writes = [{ path: "GEMINI_API_KEY", value: SECRET, file: "x/.env", format: "dotenv" }];
  const userEnv = [{ name: "GEMINI_API_KEY", value: "sk-live-别的", scope: "User" }];
  const good = detectEnvShadow({ writes, userEnv });
  assert.ok(!JSON.stringify(good).includes(SECRET), "好的实现不漏明文");

  const broken = bad.detectEnvShadow({ writes, userEnv });
  assert.ok(
    JSON.stringify(broken).includes(SECRET),
    "改坏之后这条断言必须红（否则报告里会带出真凭据）",
  );
});

test("★ ⑦ 反向对照：把进程环境当用户环境，「不拿进程环境当用户环境」这条断言必须红", async () => {
  const bad = await mutated([[
    `return { ok: true, env, source: "windows-registry", error: "" };`,
    `return { ok: true, env: [...env, ...Object.keys(process.env).map((k) => ({ name: k, value: process.env[k], scope: "Process" }))], source: "windows-registry", error: "" };`,
  ]]);
  const ONLY = "ENV_SHADOW_TEST_ONLY_IN_PROCESS_2";
  process.env[ONLY] = "在进程里";
  try {
    const good = readUserEnv({ platform: "win32", exec: fakeExec([]) });
    assert.equal(good.env.find((e) => e.name === ONLY), undefined, "好的实现不混进程环境");

    const broken = bad.readUserEnv({ platform: "win32", exec: fakeExec([]) });
    assert.notEqual(
      broken.env.find((e) => e.name === ONLY), undefined,
      "改坏之后这条断言必须红（进程环境不是用户设置过的）",
    );
  } finally {
    delete process.env[ONLY];
  }
});

test("★ ⑦ 反向对照：把「环境变量赢」的名单去掉，Gemini CLI 这条断言必须红", async () => {
  const bad = await mutated([[
    `const ENV_WINS = new Set(["gemini-cli", "qwen-code"]);`,
    `const ENV_WINS = new Set(["qwen-code"]);`,
  ]]);
  const writes = [{ path: "GOOGLE_GEMINI_BASE_URL", value: "http://127.0.0.1:15799", file: "x/.env", format: "dotenv" }];
  const userEnv = [{ name: "GOOGLE_GEMINI_BASE_URL", value: "https://别的", scope: "User" }];
  const good = detectEnvShadow({ writes, userEnv, clientId: "gemini-cli" });
  assert.equal(good.shadows.length, 1, "好的实现");
  assert.equal(good.shadows[0].severity, "blocking", "Gemini CLI 是真环境变量赢 ⇒ 确定被盖");

  const broken = bad.detectEnvShadow({ writes, userEnv, clientId: "gemini-cli" });
  assert.equal(broken.shadows[0].severity, "advisory", "改坏之后这条断言必须红");
});

test("★ ⑦ 反向对照：把「配置赢」的名单去掉，Claude Code 不报遮蔽这条断言必须红", async () => {
  const bad = await mutated([[
    `if (CONFIG_WINS.has(id)) return null;`,
    `if (false) return null;`,
  ]]);
  const writes = [{ path: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:15799", file: "s.json", format: "json" }];
  const userEnv = [{ name: "ANTHROPIC_BASE_URL", value: "https://别的", scope: "User" }];
  const good = detectEnvShadow({ writes, userEnv, clientId: "claude-code" });
  assert.equal(good.shadows.length, 0, "好的实现：实测配置赢 ⇒ 不报");

  const broken = bad.detectEnvShadow({ writes, userEnv, clientId: "claude-code" });
  assert.equal(broken.shadows.length, 1, "改坏之后这条断言必须红");
});

/* ---------- ⑧ 仓库规矩 ---------- */

test("⑧ 模块只依赖 node: 内置模块：不 import 仓库里别的模块，也不拿进程环境当数据源", () => {
  const src = readFileSync(SRC, "utf8");
  const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(specs.length > 0, "总得有点 import");
  for (const s of specs) {
    assert.ok(s.startsWith("node:"), "只准 import node: 内置模块，实际：" + s);
  }
  /* ⚠ 断言要针对**代码**，不是注释里出现的那个词 ——
   *   文件头就写着「不拿进程环境当用户环境」，那句 `process.env` 是**说明**，
   *   不是代码。扫全文会把正确的注释判成违规（这条断言自己就是这么翻车的）。
   *   ⇒ 先把注释剥掉，再看代码里还有没有。 */
  const code = stripComments(src);
  assert.ok(!/process\.env/.test(code), "代码里不许拿进程环境当用户环境");
  /* ⚠ 也不许写用户的配置：这个模块只读 */
  assert.ok(!/writeFileSync|appendFileSync|mkdirSync/.test(code), "这个模块只读，不写盘");
});

test("⑧ 文件头说明与导出的名字对得上（主线程要按名字接）", async () => {
  const mod = await import("../src/server/clients/env-shadow.mjs");
  for (const n of [
    "detectEnvShadow", "checkClientEnvShadow", "envShadowNotice",
    "readUserEnv", "envVarNameOf", "maskValue", "sameValue",
  ]) {
    assert.equal(typeof mod[n], "function", "得导出 " + n);
  }
});
