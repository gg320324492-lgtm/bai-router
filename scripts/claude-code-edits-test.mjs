/**
 * Claude Code 接线的那几处 env —— claudeCodeEdits（scripts/claude-code-edits-test.mjs）
 *
 * ## 测什么
 *
 * ★ ① **网关模式下必须有 ANTHROPIC_AUTH_TOKEN**（2026-10-23 端到端实测抓到的洞）
 * ★ ② **用户自己设过 token 就留着**（onlyIfAbsent）—— 别用占位符盖掉他那份
 * ★ ③ **老路（不走网关）**：直连渠道写真 key、走本地中转的写占位符
 * ★ ④ 模型 id：网关模式写 `provider/档位`，老路写最终模型名（档位被换掉的老坑）
 * ★ ⑤ **反向对照**：把 ① 那条改坏，① 必须红
 *
 * ## ① 那条洞的来龙去脉（别再踩回去）
 *
 * 原来的推理是：「请求先到统一网关，网关按模型 id 的 provider 前缀分流 ⇒ 客户端
 * 送来的 token 对网关**没有意义** ⇒ 保留用户自己那份，别用占位符盖掉」。
 *
 * ⚠ **那个推理漏了一步**：「网关不校验客户端的 token」**≠**「客户端可以没有 token」。
 * Claude Code 自己**没有 token 就不发请求** —— 它直接报
 * 「Not logged in · Please run /login」，一个请求都不发出来。
 * 2026-10-23 的端到端实测（真 claude CLI + 假上游）抓到了它：
 * 出厂默认是**网关模式**，而网关模式**不写**这个键 ⇒ **新接线的客户端一个请求都发不出去**
 * （用户老配置里本来就有这个键，所以他自己一直没察觉）。
 *
 * ⇒ 修法：网关模式**也**写，但写**占位符**（真 key 留在用户主目录是「里程碑 4b」
 *   明确要避免的），且**用户自己设过就留着**（onlyIfAbsent）。
 *
 * ## 红线
 *
 * 🔴 全文没有一个真实令牌/API key（夹具里的都是 `-dummy-not-a-real-` 之类的占位）。
 * 🔴 落盘只在 os.tmpdir() 下的临时目录。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { claudeCodeEdits } from "../src/server/clients/claude-code-edits.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-cc-edits-"));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/** 一份最小事实集。 */
const FACTS = {
  tiers: [
    { key: "claude-haiku-4-5", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL" },
    { key: "claude-sonnet-5", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL" },
    { key: "claude-opus-5", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
  ],
  gw: true,
  gatewayBaseUrl: "http://127.0.0.1:15799",
  cliBaseUrl: "http://127.0.0.1:15722",
  viaLocalRelay: false,
  proxyManagedToken: "PROXY_MANAGED",
  providerId: "sn",
  channelId: "sn",
  key: "sn_dummy-not-a-real-key",
  mapping: {
    "claude-haiku-4-5": { target: "mimo-v2.5" },
    "claude-sonnet-5": { target: "hy3" },
    "claude-opus-5": { target: "hy3" },
  },
  defaultModel: "deepseek-v4-pro",
  proxy: "",
};

/** 在 edits 里找某个 env 键。 */
function envEdit(edits, key) {
  return edits.find((e) => e.path === "env." + key);
}
const envValue = (edits, key) => {
  const e = envEdit(edits, key);
  return e && !e.delete ? e.value : undefined;
};

/* ====================================================================== *
 * ① 网关模式下必须有 token
 * ====================================================================== */
describe("① 网关模式：必须有 ANTHROPIC_AUTH_TOKEN", () => {
  test("①a 网关模式的 edits 里必须有 ANTHROPIC_AUTH_TOKEN，且是占位符", () => {
    const e = claudeCodeEdits(FACTS);
    const tok = envEdit(e, "ANTHROPIC_AUTH_TOKEN");
    assert.ok(tok, "★ 网关模式没写这个键 ⇒ Claude Code 不会发请求（端到端实测：报 Not logged in）");
    assert.equal(tok.delete, undefined, "不能是删键");
    assert.equal(tok.value, "PROXY_MANAGED", "写的是占位符，不是真 key");
  });

  test("①b ⚠ **绝不写真 key**（真 key 留在用户主目录是「里程碑 4b」要避免的）", () => {
    const e = claudeCodeEdits(FACTS);
    const tok = envValue(e, "ANTHROPIC_AUTH_TOKEN");
    assert.ok(!String(tok || "").includes(FACTS.key),
      "★ 把渠道的真 key 写进了客户端配置");
    assert.ok(!/sk-|gho_|ghp_/.test(String(tok || "")), "★ 看着像真凭据");
  });

  test("①c 用户自己设过 token ⇒ 留着（onlyIfAbsent），别用占位符盖掉", () => {
    const e = claudeCodeEdits(FACTS);
    const tok = envEdit(e, "ANTHROPIC_AUTH_TOKEN");
    assert.equal(tok.onlyIfAbsent, true,
      "★ 没有 onlyIfAbsent ⇒ 会盖掉用户自己那份（他可能有别的用途）");
  });

  test("①d BASE_URL 指向统一网关", () => {
    assert.equal(envValue(claudeCodeEdits(FACTS), "ANTHROPIC_BASE_URL"), FACTS.gatewayBaseUrl);
  });
});

/* ====================================================================== *
 * ② ③ 老路
 * ====================================================================== */
describe("② 老路（不走网关）：直连写真 key、走本地中转的写占位符", () => {
  test("②a 直连渠道 ⇒ 写渠道自己的 key", () => {
    const e = claudeCodeEdits({ ...FACTS, gw: false, viaLocalRelay: false });
    assert.equal(envValue(e, "ANTHROPIC_AUTH_TOKEN"), FACTS.key);
    assert.equal(envValue(e, "ANTHROPIC_BASE_URL"), FACTS.cliBaseUrl);
  });

  test("②b 走本地中转的渠道 ⇒ 写占位符（不写真凭据）", () => {
    const e = claudeCodeEdits({ ...FACTS, gw: false, viaLocalRelay: true });
    assert.equal(envValue(e, "ANTHROPIC_AUTH_TOKEN"), "PROXY_MANAGED");
  });

  test("②c 老路写 token 时**不**带 onlyIfAbsent（老路就是要管这个值）", () => {
    const e = claudeCodeEdits({ ...FACTS, gw: false });
    const tok = envEdit(e, "ANTHROPIC_AUTH_TOKEN");
    assert.equal(tok.onlyIfAbsent, undefined);
  });
});

/* ====================================================================== *
 * ④ 模型 id：档位 vs 最终模型名
 * ====================================================================== */
describe("④ 模型 id", () => {
  test("④a 网关模式写 `provider/档位`", () => {
    const e = claudeCodeEdits(FACTS);
    assert.equal(envValue(e, "ANTHROPIC_DEFAULT_SONNET_MODEL"), "sn/claude-sonnet-5");
    assert.equal(envValue(e, "ANTHROPIC_DEFAULT_OPUS_MODEL"), "sn/claude-opus-5");
  });

  test("④b 老路写最终模型名（档位被换掉的老坑）", () => {
    const e = claudeCodeEdits({ ...FACTS, gw: false });
    assert.equal(envValue(e, "ANTHROPIC_DEFAULT_SONNET_MODEL"), "hy3");
  });

  test("④c 网关模式下**不**写 `_NAME`（用户没填 label 就不写）", () => {
    const e = claudeCodeEdits(FACTS);
    assert.equal(envEdit(e, "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"), undefined);
  });
});

/* ====================================================================== *
 * ⑤ 反向对照
 * ====================================================================== */
describe("⑤ 反向对照：把 ① 那条改坏，① 必须红", () => {
  test("⑤a 删掉网关模式写 token 的那两行 ⇒ ①a 必须失败", async () => {
    /* 手法：把 claude-code-edits.mjs 复制到临时目录，在**副本**上删掉
       `else { edits.push({ path: "env.ANTHROPIC_AUTH_TOKEN", ... }) }` 那一支，
       再 import 副本跑 ①a 的判据 —— 它必须抓不到「有写 token」这件事。
       ⚠ 改的是副本，仓库源码一个字不动。 */
    const dir = path.join(TMPROOT, "broken");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(REPO, "src", "server", "clients", "claude-code-edits.mjs");
    const text = fs.readFileSync(src, "utf8");
    const broken = text.replace(
      /  \} else \{\n    edits\.push\(\{ path: "env\.ANTHROPIC_AUTH_TOKEN"[^\n]*\n  \}\n/,
      "  }\n",
    );
    assert.notEqual(broken, text,
      "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    fs.writeFileSync(path.join(dir, "claude-code-edits.mjs"), broken, "utf8");
    const mod = await import(pathToFileURL(path.join(dir, "claude-code-edits.mjs")).href + `?v=${Date.now()}`);
    const e = mod.claudeCodeEdits(FACTS);
    assert.equal(envEdit(e, "ANTHROPIC_AUTH_TOKEN"), undefined,
      "★ 改坏之后仍判成「有写 token」—— 那 ①a 的判据是恒真的，测了个寂寞");
  });
});
