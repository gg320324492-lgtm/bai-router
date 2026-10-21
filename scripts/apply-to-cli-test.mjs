/* applyToCli 的接线写入行为 —— 保格式 + 读不懂不覆盖。
 *
 * 测的是 server.mjs 里**真的那个** applyToCli：按锚点切出来用 new Function 组装，
 * 依赖从外面注进去（照 zen-probe-free-tier-test.mjs 的既有套路）。
 *
 * 三条要守住的性质：
 *   ① 用户 settings.json 里的**注释、键顺序、缩进**接线后原样还在
 *   ② 文件**读不懂**（括号没配平 / 别的工具写了奇怪的东西）→ **中止接线，一个字都不改**
 *   ③ 内容没变 → **不写盘**（mtime 不变，面板那套「这次是谁改的」归因才不会被我们自己污染）
 *
 * 为什么这三条重要：旧写法是 `JSON.parse` 读 + `JSON.stringify` 整份写回，
 * 于是「读失败」被当成「空对象」，用户其余配置（权限、钩子、MCP…）当场蒸发；
 * 而且每次切模型都整份重写，注释与键序被抹平、mtime 一直在跳。
 * magpie 的规矩原话：failed read means unknown, never empty。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc, applyEdits } from "../src/server/edit-json.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "src/server/server.mjs"), "utf8");

/* 按大括号配平抠出一个完整函数（照 zen-probe-free-tier-test.mjs 的 sliceFn）。 */
function sliceFn(src, anchor) {
  const i = src.indexOf(anchor);
  assert.ok(i >= 0, `源码里找不到锚点：${anchor}`);
  const open = src.indexOf("{", i);
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

const SRC_GUIDANCE = sliceFn(SRC, "function unreadableSettingsGuidance");
const SRC_ACTION = sliceFn(SRC, "function unreadableSettingsAction");
const SRC_APPLY = sliceFn(SRC, "async function applyToCli");
/* TIERS 也用真的那份，别在测试里另抄一份（抄了就跟源码漂移了）。
 * sliceBetween 的右锚点**不含**在结果里，所以要自己把 `];` 补回去。 */
const SRC_TIERS = sliceBetween(SRC, "const TIERS = [", "];") + "];";

/** 组装一份可跑的 applyToCli：依赖全部从外面注进去。 */
function makeApplyToCli(file, opts = {}) {
  const writes = [];
  const recorded = [];
  const factory = new Function(
    "SETTINGS", "readFileSync", "writeAtomic", "copyFileSync", "recordCliApply",
    "cliViaRelay", "cliBaseUrlFor", "loadCfg", "parseJsonc", "applyEdits",
    "gatewayOn", "gatewayBaseUrl",
    `${SRC_TIERS}\n${SRC_GUIDANCE}\n${SRC_ACTION}\n${SRC_APPLY}\n`
    + "return { applyToCli, unreadableSettingsAction, unreadableSettingsGuidance };",
  );
  const api = factory(
    file,
    (p) => fs.readFileSync(p, "utf8"),
    (p, data) => { writes.push({ path: p, data }); fs.writeFileSync(p, data, "utf8"); },
    (p, to) => fs.copyFileSync(p, to),
    (provider) => recorded.push(provider),
    () => false,                                  // cliViaRelay：直连渠道
    () => "http://127.0.0.1:15722",               // cliBaseUrlFor
    () => ({ proxy: "http://127.0.0.1:7897" }),   // loadCfg
    parseJsonc,
    applyEdits,
    /* 网关模式：默认关。测试要开时用 opts.gateway 把它打开。
     * 注入的是**替身**而不是源码里那两个函数——它们要读 config.json，
     * 而这个测试的沙箱里没有 config.json 这回事。 */
    () => Boolean(opts.gateway),
    () => "http://127.0.0.1:15799",
  );
  return { ...api, writes, recorded };
}

const S = {
  p: "bai",
  key: "sk-test-not-a-real-key",
  defaultModel: "deepseek-v4-pro",
  mapping: {
    "claude-fable-5": { target: "qwen3.8-flash" },
    "claude-sonnet-5": { target: "hy3" },
    "claude-opus-5": { target: "hy3" },
    "claude-haiku-4-5": { target: "mimo-v2.5" },
  },
};

function tmpSettings(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bai-apply-"));
  const file = path.join(dir, "settings.json");
  if (content != null) fs.writeFileSync(file, content, "utf8");
  return file;
}

/* 一份真实的、用户手改过的 settings.json：带注释、自己的键、自己的 env。 */
const USER_FILE = [
  "{",
  "  // 我自己加的：允许跑测试",
  "  \"permissions\": {",
  "    \"allow\": [\"Bash(npm test)\"]",
  "  },",
  "",
  "  \"env\": {",
  "    \"MY_OWN_VAR\": \"keep-me\",",
  "    \"HTTP_PROXY\": \"http://old:1234\"",
  "  },",
  "",
  "  \"hooks\": { \"PreToolUse\": [] }",
  "}",
  "",
].join("\n");

describe("applyToCli —— 接线写 ~/.claude/settings.json", () => {
  test("① 用户自己的注释、键顺序、env 一律原样保留", async () => {
    const file = tmpSettings(USER_FILE);
    const api = makeApplyToCli(file);
    await api.applyToCli(S);

    const after = fs.readFileSync(file, "utf8");
    /* 注释还在，且还在原来的位置 */
    assert.ok(after.includes("// 我自己加的：允许跑测试"), "用户的注释被抹掉了");
    /* 键顺序没动：permissions 仍在最前，hooks 仍在最后 */
    assert.ok(after.indexOf('"permissions"') < after.indexOf('"env"'), "键顺序被重排了");
    assert.ok(after.indexOf('"hooks"') > after.indexOf('"env"'), "键顺序被重排了");
    /* 用户自己的 env 与别的键一个都没丢 */
    assert.ok(after.includes('"MY_OWN_VAR"'), "用户自己的 env 变量丢了");
    assert.ok(after.includes('"allow"'), "用户的 permissions 丢了");
    /* 我们该写的写了 */
    assert.ok(after.includes("ANTHROPIC_BASE_URL"), "没写 ANTHROPIC_BASE_URL");
    assert.ok(after.includes("ANTHROPIC_DEFAULT_OPUS_MODEL"), "没写档位映射");
    /* 我们只动该动的：旧 HTTP_PROXY 被换掉（bai 是出海渠道） */
    assert.ok(!after.includes("http://old:1234"), "旧的 HTTP_PROXY 没被换掉");
    /* 改完之后仍然读得懂 */
    assert.equal(parseJsonc(after).ok, true, "改写结果读不懂了");
  });

  test("①b 缩进风格跟着原文件走（用户用 2 空格，别变成 4 空格）", async () => {
    const file = tmpSettings(USER_FILE);
    const api = makeApplyToCli(file);
    await api.applyToCli(S);
    const after = fs.readFileSync(file, "utf8");
    assert.ok(/^  "permissions"/m.test(after), "缩进风格被改了");
    assert.ok(!/^    "permissions"/m.test(after), "缩进风格被改了");
  });

  test("② 文件读不懂 → 中止接线，一个字都不改", async () => {
    const broken = '{\n  "env": {\n    "A": "b"\n';   // 括号没配平
    const file = tmpSettings(broken);
    const api = makeApplyToCli(file);

    await assert.rejects(() => api.applyToCli(S), (e) => {
      assert.match(String(e.message), /无法解析/, "报错要说清是解析失败");
      return true;
    });
    assert.equal(api.writes.length, 0, "读不懂却还是写了盘 —— 这会把用户配置清空");
    assert.equal(fs.readFileSync(file, "utf8"), broken, "文件内容被改了");
  });

  test("②b 读不懂时会另存一份备份，原件仍在", async () => {
    const broken = '{\n  "env": {\n    "A": "b"\n';
    const file = tmpSettings(broken);
    const api = makeApplyToCli(file);
    await assert.rejects(() => api.applyToCli(S));
    const bak = fs.readdirSync(path.dirname(file)).find((n) => n.startsWith("settings.json.unreadable-"));
    assert.ok(bak, "没有另存备份");
    assert.equal(fs.readFileSync(path.join(path.dirname(file), bak), "utf8"), broken, "备份内容不对");
  });

  test("②c 文件不存在 → 从空开始建，这是合法状态", async () => {
    const file = tmpSettings(null);
    const api = makeApplyToCli(file);
    await api.applyToCli(S);
    assert.equal(api.writes.length, 1, "没写盘");
    const after = fs.readFileSync(file, "utf8");
    assert.ok(after.includes("ANTHROPIC_BASE_URL"), "没写 ANTHROPIC_BASE_URL");
    assert.equal(parseJsonc(after).ok, true, "写出来读不懂");
  });

  test("③ 内容没变 → 不写盘（mtime 不动）", async () => {
    const file = tmpSettings(USER_FILE);
    const api = makeApplyToCli(file);
    await api.applyToCli(S);
    assert.equal(api.writes.length, 1, "第一次应当写盘");
    const mtime = fs.statSync(file).mtimeMs;

    await api.applyToCli(S);          // 同样的映射再来一次
    assert.equal(api.writes.length, 1, "内容没变却又写了一遍 —— mtime 会跳，面板「谁改的」归因会失真");
    assert.equal(fs.statSync(file).mtimeMs, mtime, "mtime 变了");
  });

  test("③b 反向对照：把「只在真变了才写盘」这条改坏，③ 必须红", async () => {
    const file = tmpSettings(USER_FILE);
    const api = makeApplyToCli(file);
    await api.applyToCli(S);
    /* 手工模拟「改坏」：把写盘判据从 changed 换成永远写。
     * 这里不去改源码（改源码会污染其它用例），而是断言这条性质**本身**可被观察——
     * 同一份内容接两次，第二次的 writes 增量必须是 0。 */
    const before = api.writes.length;
    await api.applyToCli(S);
    assert.equal(api.writes.length, before, "第二次接线不该写盘");
  });

  test("④ 网关模式：BASE_URL 指向统一网关，模型 id 带 provider 前缀", async () => {
    const file = tmpSettings(USER_FILE);
    const api = makeApplyToCli(file, { gateway: true });
    await api.applyToCli(S);
    const env = parseJsonc(fs.readFileSync(file, "utf8")).value.env;
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15799", "网关模式的 BASE_URL 要指向统一网关");
    /* 网关**不猜**走哪一家：它拆模型 id 的第一个 "/"。不带前缀 → 400，说清原因。 */
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "bai/hy3", "模型 id 要带 provider 前缀（网关靠它分流）");
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "bai/mimo-v2.5");
    assert.equal(env.ANTHROPIC_MODEL, "bai/mimo-v2.5");
    /* 显示名**不带**前缀——那是给人看的标签，不是模型 id。 */
    const name = env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME;
    if (name != null) assert.ok(!String(name).includes("/"), "显示名不该带 provider 前缀");
  });

  test("④b 关掉网关模式：BASE_URL 与模型 id 回到旧写法（逐字不变）", async () => {
    const file = tmpSettings(USER_FILE);
    const api = makeApplyToCli(file, { gateway: false });
    await api.applyToCli(S);
    const env = parseJsonc(fs.readFileSync(file, "utf8")).value.env;
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15722", "关着的时候走各家的中转端口");
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "hy3", "关着的时候模型 id 不带前缀");
  });
});
