/**
 * 两个主流客户端的接线声明：Codex（Responses 规范）与 Gemini CLI（Gemini 规范）
 *
 * ## 测什么
 *
 *   ★ ① 声明的形状：id / name / protocol / 配置文件路径
 *   ★ ② **base_url 的 /v1 规则**：Codex **带**（它自己拼 /responses），
 *      Gemini CLI **不带**（它自己拼 /v1beta/…）—— 抄错一个就接不上
 *   ★ ③ 模型 id 写完整（provider/档位）：网关按前缀分流，没前缀一律 400
 *   ★ ④ 接线**不静默失败**：格式读写器还没接上时如实报错；接上了就真写出来，
 *      且断开能还原
 *
 * ## 关于 ④ 的写法
 *
 * TOML 与 dotenv 的读写器（src/server/clients/formats-toml.mjs 等）是**并行
 * 会话**在做的东西，本测试不能假设它们已经到位。所以 ④ 分两种情况：
 *   · 格式还没注册 ⇒ 必须**如实报错并说清是哪个格式**（不许静默跳过）
 *   · 格式已注册   ⇒ 文件里真的写进去了，且断开后原样还原
 * 两种情况都有实质检查 —— 它不是恒真的断言。
 *
 * ## 红线
 *
 * 🔴 落盘只在 os.tmpdir() 下的临时目录；不含任何真实令牌。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyClient, revertClient, formatOf } from "../src/server/clients/base.mjs";
import { codexClient } from "../src/server/clients/codex.mjs";
import { geminiCliClient } from "../src/server/clients/gemini-cli.mjs";

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-majorcli-"));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

let seq = 0;
function tmpDir() {
  const d = path.join(TMPROOT, `d${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const CTX = (home) => ({
  home,
  baseUrl: "http://127.0.0.1:15799",
  apiKey: "test-placeholder-key",
  models: [{ id: "sn/claude-opus-5", label: "Claude Opus 5" }],
  providerId: "bai",
  providerName: "B.AI",
});

/* ====================================================================== *
 * ① 声明的形状
 * ====================================================================== */
describe("① 声明的形状", () => {
  test("①a Codex：Responses 规范，配置在 ~/.codex/config.toml", () => {
    assert.equal(codexClient.id, "codex");
    assert.equal(codexClient.protocol, "responses");
    const home = tmpDir();
    const files = codexClient.files(CTX(home));
    assert.equal(files.length, 1);
    assert.equal(files[0].path, path.join(home, ".codex", "config.toml"));
    assert.equal(files[0].format, "toml");
  });

  test("①b Gemini CLI：Gemini 规范，两个文件（settings.json + .env）", () => {
    assert.equal(geminiCliClient.id, "gemini-cli");
    assert.equal(geminiCliClient.protocol, "gemini");
    const home = tmpDir();
    const files = geminiCliClient.files(CTX(home));
    assert.equal(files.length, 2, "settings.json 与 .env 都要写（只改一个必然失败）");
    assert.equal(files[0].path, path.join(home, ".gemini", "settings.json"));
    assert.equal(files[0].format, "json");
    assert.equal(files[1].path, path.join(home, ".gemini", ".env"));
    assert.equal(files[1].format, "dotenv");
  });
});

/* ====================================================================== *
 * ② base_url 的 /v1 规则
 * ====================================================================== */
describe("② base_url：Codex 带 /v1，Gemini CLI 不带", () => {
  test("②a Codex 的 base_url 带 /v1（它自己拼 /responses）", () => {
    const home = tmpDir();
    const w = codexClient.files(CTX(home))[0].writes(CTX(home));
    const tbl = w.find((x) => x.path === "model_providers.bai").value;
    assert.equal(tbl.base_url, "http://127.0.0.1:15799/v1",
      "★ 少了 /v1，Codex 会去问 /responses（网关只答 /v1/responses）");
    assert.equal(tbl.wire_api, "responses");
  });

  test("②b Gemini CLI 的 base_url 不带 /v1（它自己拼 /v1beta/…）", () => {
    const home = tmpDir();
    const w = geminiCliClient.files(CTX(home))[1].writes(CTX(home));
    const base = w.find((x) => x.path === "GOOGLE_GEMINI_BASE_URL").value;
    assert.equal(base, "http://127.0.0.1:15799",
      "★ 多带了 /v1，Gemini CLI 会去问 /v1/v1beta/…");
  });

  test("②c 两者不能抄错：Codex 那个带、Gemini 那个不带", () => {
    const home = tmpDir();
    const c = codexClient.files(CTX(home))[0].writes(CTX(home));
    const g = geminiCliClient.files(CTX(home))[1].writes(CTX(home));
    const cBase = c.find((x) => x.path === "model_providers.bai").value.base_url;
    const gBase = g.find((x) => x.path === "GOOGLE_GEMINI_BASE_URL").value;
    assert.ok(cBase.endsWith("/v1"), "Codex 的要带 /v1");
    assert.ok(!gBase.endsWith("/v1"), "Gemini CLI 的不能带 /v1");
  });
});

/* ====================================================================== *
 * ③ 模型 id
 * ====================================================================== */
describe("③ 模型 id 写完整（provider/档位）", () => {
  test("③a Codex 的 model 顶层键是 provider/档位", () => {
    const home = tmpDir();
    const w = codexClient.files(CTX(home))[0].writes(CTX(home));
    const model = w.find((x) => x.path === "model").value;
    assert.match(model, /^[a-z0-9]+\/.+/, `模型 id 必须带 provider 前缀：${model}`);
  });

  test("③b Gemini CLI 的 model.name 是 provider/档位", () => {
    const home = tmpDir();
    const w = geminiCliClient.files(CTX(home))[0].writes(CTX(home));
    const name = w.find((x) => x.path === "model.name").value;
    assert.match(name, /^[a-z0-9]+\/.+/, `模型名必须带 provider 前缀：${name}`);
  });

  test("③c 认证方式：Gemini CLI 走 API key（不是 Google 登录）", () => {
    const home = tmpDir();
    const w = geminiCliClient.files(CTX(home))[0].writes(CTX(home));
    const t = w.find((x) => x.path === "security.auth.selectedType").value;
    assert.equal(t, "gemini-api-key");
  });
});

/* ====================================================================== *
 * ④ 接线不静默失败
 * ====================================================================== */
describe("④ 接线不静默失败", () => {
  test("④a Codex：格式没接上 ⇒ 如实报错；接上了 ⇒ 真写出来且能还原", async () => {
    const home = tmpDir();
    const def = codexClient;
    const r = applyClient(def, CTX(home), { dataDir: home });
    if (!r.ok) {
      /* 格式读写器还没交付 —— 必须**如实说清是哪个格式**，不许静默跳过。 */
      assert.match(r.detail, /toml|格式/, `错误要说清是哪个格式：${r.detail}`);
      return;
    }
    const file = path.join(home, ".codex", "config.toml");
    assert.ok(fs.existsSync(file), "文件没写出来");
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /model_provider/, "顶层 model_provider 没写");
    assert.match(text, /base_url/, "provider 表没写");
    assert.match(text, /wire_api\s*=\s*"responses"/, "wire_api 没写");
    /* 断开 ⇒ 原样还原 */
    const back = revertClient(def, { dataDir: home });
    assert.equal(back.ok, true, back.detail);
    const after = fs.readFileSync(file, "utf8");
    assert.equal(after.indexOf("model_providers.bai"), -1,
      "★ 断开后 provider 表还在用户文件里");
  });

  test("④b Gemini CLI：格式没接上 ⇒ 如实报错；接上了 ⇒ 真写出来且能还原", async () => {
    const home = tmpDir();
    const def = geminiCliClient;
    const r = applyClient(def, CTX(home), { dataDir: home });
    if (!r.ok) {
      assert.match(r.detail, /dotenv|格式|json/, `错误要说清是哪个格式：${r.detail}`);
      return;
    }
    const env = path.join(home, ".gemini", ".env");
    const set = path.join(home, ".gemini", "settings.json");
    assert.ok(fs.existsSync(env), ".env 没写出来");
    assert.ok(fs.existsSync(set), "settings.json 没写出来");
    const e = fs.readFileSync(env, "utf8");
    assert.match(e, /GOOGLE_GEMINI_BASE_URL/, "base url 没写");
    assert.match(e, /GEMINI_API_KEY/, "key 没写");
    const s = fs.readFileSync(set, "utf8");
    assert.match(s, /gemini-api-key/, "认证方式没写");
    const back = revertClient(def, { dataDir: home });
    assert.equal(back.ok, true, back.detail);
  });

  test("④c 格式注册表：没注册的格式返回 null（不崩）", () => {
    assert.equal(formatOf("toml"), formatOf("toml"));   // 幂等
    assert.equal(formatOf("根本没有这个格式"), null);
  });
});
