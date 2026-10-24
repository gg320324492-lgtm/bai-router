/* Cline 的**第二层**（globalState.json + secrets.json）与 OpenCode 的**模型表形状**
 * —— 2026-10-24
 *
 * ## 为什么要有这一条
 *
 * 「配置写好了」≠「客户端会走」。这两个客户端各有一处**只有真客户端实测**才暴露的
 * 坑（都是「配置写对了、客户端不认那一处」）：
 *
 * ① **Cline CLI**：只写 `providers.json` + `models.json` ⇒ CLI 直接输出
 *    「Not authenticated. Please run 'cline auth' first」，**一个请求都发不出**。
 *    它的**认证门**读的是另一份状态：`~/.cline/data/globalState.json`
 *    （地址 `openAiBaseUrl` 等）与 `~/.cline/data/secrets.json`（`openAiApiKey`）。
 *    magpie 写这两份（internal/agent/cline.go:72-108），我们原来漏了。
 *
 * ② **OpenCode**：它的模型表**用档位当表名**、条目里另带一个 **`id`**（发给 API 的
 *    那个模型 id）。它的寻址是 `providerId/modelId`（**按第一个斜杠切**）⇒
 *    表名里再带一遍 provider 前缀就会变成 `bai/bai/…`，而用户从我们面板上抄来的
 *    `sn/claude-opus-5` **选不了**（实测：`-m sn/claude-opus-5` ⇒ Model not found）。
 *
 * ## 测的是这几条
 *
 *   ① Cline：接上以后**四个**文件都在；第二层的键值对（地址带 /v1、模式是
 *     "openai"、模型 id、User-Agent 头、凭据）；**用户自己的键留着**；
 *     断开后**逐字**还原。
 *   ② OpenCode：模型表**表名=档位**、每条**带 `id`**（带 provider 前缀）；
 *     顶层 `model` 是 `provider/档位`（OpenCode 的寻址能解析的那个引用）；
 *     **迁移**：上一版的旧表名删掉、用户在那儿改过的名字搬过来、用户自己加的
 *     条目留着；断开后**逐字**还原。
 *
 * ⚠ **反向对照在最后一节**：把实现改坏（复制到临时目录改一改再 import 进来），
 *   证明前面那些断言**真的会红** —— 不会红的断言等于没写。
 *
 * 落盘只在 os.tmpdir()：**绝不碰**用户真的 ~/.cline 与 ~/.config/opencode。
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyClient, revertClient } from "../src/server/clients/base.mjs";
import { clineClient } from "../src/server/clients/cline.mjs";
import { opencodeClient } from "../src/server/clients/opencode.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_CLINE = path.join(HERE, "..", "src", "server", "clients", "cline.mjs");
const SRC_OPENCODE = path.join(HERE, "..", "src", "server", "clients", "opencode.mjs");
const CLIENTS_DIR = path.join(HERE, "..", "src", "server", "clients");
const SERVER_DIR = path.join(HERE, "..", "src", "server");

/* 假凭据：明显不是真的。 */
const FAKE_KEY = "bai-local-placeholder";
const BASE_URL = "http://127.0.0.1:15999";
const MODELS = [
  { id: "sn/claude-opus-5", label: "Claude Opus 5" },
  { id: "sn/glm-5.2", label: "GLM 5.2" },
];

/* ⚠ util.mjs 的 envDir 读的是 **process.env**（不是 ctx.env）——
 *   测试机上若恰好设了 CLINE_DIR / CLINE_DATA_DIR / OPENCODE_CONFIG_DIR，
 *   就会写到别处去 ⇒ 测之前先清掉、测完还回去。 */
const ENV_KEYS = ["CLINE_DIR", "CLINE_DATA_DIR", "OPENCODE_CONFIG_DIR"];
const SAVED_ENV = {};
for (const k of ENV_KEYS) {
  SAVED_ENV[k] = process.env[k];
  delete process.env[k];
}

/** 沙箱 home。 */
function makeHome(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `cline-oc-shape-${tag}-`));
  return { home, dataDir: path.join(home, "_bai-backups") };
}

function ctxOf(home, extra = {}) {
  return {
    home,
    baseUrl: BASE_URL,
    apiKey: FAKE_KEY,
    models: MODELS,
    providerId: "bai",
    providerName: "B.AI",
    env: { ...process.env },
    ...extra,
  };
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

/* ======================================================================
 * ① Cline 的第二层
 * ====================================================================== */

describe("① Cline：第二层（globalState.json + secrets.json）", () => {
  test("①a 接上以后四个文件都在，第二层的键值对", () => {
    const { home, dataDir } = makeHome("a");
    const r = applyClient(clineClient, ctxOf(home), { dataDir });
    assert.equal(r.ok, true, "接上应当成功：" + r.detail);

    const data = path.join(home, ".cline", "data");
    const state = readJson(path.join(data, "globalState.json"));
    const secrets = readJson(path.join(data, "secrets.json"));

    /* ⚠ 地址**带 /v1**（这一格 Cline 原样用；providers.json 那格它自己会拼 /v1）。 */
    assert.equal(state.openAiBaseUrl, BASE_URL + "/v1", "globalState 的地址应当是网关的 /v1");
    assert.equal(state.actModeApiProvider, "openai", "act 模式的 provider 槽位");
    assert.equal(state.planModeApiProvider, "openai", "plan 模式的 provider 槽位");
    assert.equal(state.actModeOpenAiModelId, MODELS[0].id, "act 模式的模型 id");
    assert.equal(state.planModeOpenAiModelId, MODELS[0].id, "plan 模式的模型 id");
    assert.equal(state.openAiHeaders?.["User-Agent"], "cline", "User-Agent 头");
    assert.equal(secrets.openAiApiKey, FAKE_KEY, "凭据落在 secrets.json");
  });

  test("①b 用户自己在 globalState.json / secrets.json 里的键留着", () => {
    const { home, dataDir } = makeHome("b");
    const data = path.join(home, ".cline", "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(data, "globalState.json"), JSON.stringify({
      welcomeViewCompleted: true, myOwnSetting: "keep-me",
    }, null, 2));
    writeFileSync(path.join(data, "secrets.json"), JSON.stringify({
      myOwnSecret: "keep-me-too",
    }, null, 2));

    const r = applyClient(clineClient, ctxOf(home), { dataDir });
    assert.equal(r.ok, true, "接上应当成功：" + r.detail);

    const state = readJson(path.join(data, "globalState.json"));
    const secrets = readJson(path.join(data, "secrets.json"));
    assert.equal(state.welcomeViewCompleted, true, "Cline 自己的键不该被我们动");
    assert.equal(state.myOwnSetting, "keep-me", "用户自己的键不该被我们动");
    assert.equal(secrets.myOwnSecret, "keep-me-too", "用户自己在 secrets.json 的键不该被我们动");
  });

  test("①c 断开后逐字还原", () => {
    const { home, dataDir } = makeHome("c");
    const data = path.join(home, ".cline", "data");
    mkdirSync(data, { recursive: true });
    const stateFile = path.join(data, "globalState.json");
    const secretsFile = path.join(data, "secrets.json");
    const stateBefore = JSON.stringify({ welcomeViewCompleted: true, myOwnSetting: "keep-me" }, null, 2);
    const secretsBefore = JSON.stringify({ myOwnSecret: "keep-me-too" }, null, 2);
    writeFileSync(stateFile, stateBefore);
    writeFileSync(secretsFile, secretsBefore);

    assert.equal(applyClient(clineClient, ctxOf(home), { dataDir }).ok, true);
    const back = revertClient(clineClient, { dataDir });
    assert.equal(back.ok, true, "断开应当成功：" + back.detail);
    assert.equal(readFileSync(stateFile, "utf8"), stateBefore, "globalState.json 应当逐字还原");
    assert.equal(readFileSync(secretsFile, "utf8"), secretsBefore, "secrets.json 应当逐字还原");
  });
});

/* ======================================================================
 * ② OpenCode 的模型表形状
 * ====================================================================== */

describe("② OpenCode：模型表用档位当表名、条目带 id、顶层 model 是引用", () => {
  test("②a 表名=档位、每条带带前缀的 id、顶层 model=provider/档位", () => {
    const { home, dataDir } = makeHome("a");
    const r = applyClient(opencodeClient, ctxOf(home), { dataDir });
    assert.equal(r.ok, true, "接上应当成功：" + r.detail);

    const cfg = readJson(path.join(home, ".config", "opencode", "opencode.json"));
    const models = cfg.provider.bai.models;

    /* 表名是**档位**（不是整个 id）。 */
    assert.deepEqual(Object.keys(models).sort(), ["claude-opus-5", "glm-5.2"],
      "模型表的表名应当是档位");

    /* 每条带 `id`（= 发给网关的那个完整 id，带 provider 前缀）。 */
    for (const [tier, entry] of Object.entries(models)) {
      assert.match(String(entry.id || ""), /^[a-z0-9]+\/[A-Za-z0-9._-]+$/,
        `条目「${tier}」的 id 必须是 provider/档位：${entry.id}`);
    }
    assert.equal(models["claude-opus-5"].id, "sn/claude-opus-5", "opus 那条的 id");

    /* 顶层 model 是**引用**：provider/档位 —— OpenCode 按第一个斜杠切。 */
    assert.equal(cfg.model, "bai/claude-opus-5", "顶层 model 应当是 provider/档位");
    /* provider 块里那处（另一处）写的是完整 id。 */
    assert.equal(cfg.provider.bai.model, "sn/claude-opus-5", "provider 块里的 model 是完整 id");
  });

  test("②b 用户从面板抄来的 id（provider/档位）在模型表里能解析", () => {
    const { home, dataDir } = makeHome("b");
    applyClient(opencodeClient, ctxOf(home), { dataDir });
    const cfg = readJson(path.join(home, ".config", "opencode", "opencode.json"));
    /* OpenCode 的寻址：引用按**第一个斜杠**切成 provider / model ⇒
       `bai/claude-opus-5` ⇒ provider=bai、model=claude-opus-5 ⇒ 表里要有那个档位。 */
    for (const m of MODELS) {
      const ref = "bai/" + m.id.slice(m.id.indexOf("/") + 1);
      const [, modelPart] = ref.split("/");
      assert.ok(cfg.provider.bai.models[modelPart],
        `用户抄来的 id「${ref}」应当能在模型表里解析（表里没有「${modelPart}」）`);
    }
  });

  test("②c 迁移：上一版的旧表名删掉、用户改过的名字搬过来、用户自己的条目留着", () => {
    const { home, dataDir } = makeHome("c");
    const dir = path.join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "opencode.json");
    /* 造一份「上一版」的形状：表名 = 整个模型 id；用户在 opus 那条改过显示名；
       另外还有一个**用户自己加的**条目（不是我们的 ⇒ 该留着）。 */
    writeFileSync(file, JSON.stringify({
      provider: {
        bai: {
          npm: "@ai-sdk/openai-compatible",
          name: "我改过的 provider 名",
          options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "old" },
          model: "sn/claude-opus-5",
          models: {
            "sn/claude-opus-5": { name: "★用户手改的名字★" },
            "sn/glm-5.2": { name: "GLM 5.2" },
            "my-own-model": { name: "我自己加的" },
          },
        },
      },
    }, null, 2));

    const r = applyClient(opencodeClient, ctxOf(home), { dataDir });
    assert.equal(r.ok, true, "接上应当成功：" + r.detail);

    const models = readJson(file).provider.bai.models;
    assert.ok(!("sn/claude-opus-5" in models), "旧表名（整个 id）应当被删掉");
    assert.ok(!("sn/glm-5.2" in models), "旧表名（整个 id）应当被删掉");
    assert.equal(models["claude-opus-5"].name, "★用户手改的名字★",
      "用户在那儿改过的名字应当搬到新表名上");
    assert.ok(models["my-own-model"], "用户自己加的条目应当留着");
  });

  test("②d 断开后逐字还原", () => {
    const { home, dataDir } = makeHome("d");
    const dir = path.join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "opencode.json");
    const before = JSON.stringify({
      provider: { bai: { models: { "sn/claude-opus-5": { name: "我的名字" } } } },
    }, null, 2);
    writeFileSync(file, before);
    assert.equal(applyClient(opencodeClient, ctxOf(home), { dataDir }).ok, true);
    const back = revertClient(opencodeClient, { dataDir });
    assert.equal(back.ok, true, "断开应当成功：" + back.detail);
    assert.equal(readFileSync(file, "utf8"), before, "应当逐字还原");
  });
});

/* ======================================================================
 * ③ 反向对照 —— 改坏实现，对应断言必须真的会红
 * ====================================================================== */

/**
 * 把声明与它的依赖复制到临时目录、改坏声明，再 import 进来。
 *
 * ⚠ 依赖也要复制：声明 import 的是 ./json-util.mjs 与 ./base.mjs，
 *   它们再 import ../edit-json.mjs —— 只复制声明的话，import 会断。
 *   目录形状照原样（clients/ 与 edit-json.mjs 平级）。
 */
async function mutant(srcFile, replacements) {
  const src = readFileSync(srcFile, "utf8");
  let out = src;
  for (const [from, to] of replacements) {
    assert.ok(out.includes(from), `改坏用的锚点不在源码里：${JSON.stringify(from)}`);
    out = out.replace(from, to);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cline-oc-mutant-"));
  const clients = path.join(root, "clients");
  fs.mkdirSync(clients, { recursive: true });
  fs.copyFileSync(path.join(SERVER_DIR, "edit-json.mjs"), path.join(root, "edit-json.mjs"));
  for (const f of fs.readdirSync(CLIENTS_DIR)) {
    if (!f.endsWith(".mjs")) continue;
    fs.copyFileSync(path.join(CLIENTS_DIR, f), path.join(clients, f));
  }
  const file = path.join(clients, path.basename(srcFile));
  fs.writeFileSync(file, out, "utf8");
  const mod = await import(pathToFileURL(file).href);
  return { mod, root };
}

/** 断言「改坏之后这条检查会红」。 */
async function mustGoRed(mod, check, why) {
  let threw = false;
  try {
    await check(mod);
  } catch {
    threw = true;
  }
  assert.equal(threw, true, `改坏之后这条断言竟然还过：${why}`);
}

describe("③ 反向对照 —— 改坏实现，对应断言必须真的会红", () => {
  test("③a 把 Cline 第二层的地址写错 ⇒ ①a 会红", async () => {
    const { mod } = await mutant(SRC_CLINE, [
      ['{ path: "openAiBaseUrl", value: gwV1(ctx) },', '{ path: "openAiBaseUrl", value: "" },'],
    ]);
    await mustGoRed(mod, async (m) => {
      const { home, dataDir } = makeHome("ma");
      m.mod.applyClient(m.mod.clineClient, ctxOf(home), { dataDir });
      const state = readJson(path.join(home, ".cline", "data", "globalState.json"));
      assert.equal(state.openAiBaseUrl, BASE_URL + "/v1", "globalState 的地址应当是网关的 /v1");
    }, "地址写错之后，①a 竟然还过");
  });

  test("③b 把 OpenCode 的表名改回整个 id ⇒ ②a 会红", async () => {
    const { mod } = await mutant(SRC_OPENCODE, [
      ["models[tierOf(m.id)] = { id: m.id, name: m.label || m.id };",
        "models[m.id] = { id: m.id, name: m.label || m.id };"],
    ]);
    await mustGoRed(mod, async (m) => {
      const { home, dataDir } = makeHome("mb");
      m.mod.applyClient(m.mod.opencodeClient, ctxOf(home), { dataDir });
      const cfg = readJson(path.join(home, ".config", "opencode", "opencode.json"));
      assert.deepEqual(Object.keys(cfg.provider.bai.models).sort(), ["claude-opus-5", "glm-5.2"],
        "模型表的表名应当是档位");
    }, "表名改回整个 id 之后，②a 竟然还过");
  });

  test("③c 把 OpenCode 条目里的 id 去掉 ⇒ ②a 会红（档位会单独发出去）", async () => {
    const { mod } = await mutant(SRC_OPENCODE, [
      ["models[tierOf(m.id)] = { id: m.id, name: m.label || m.id };",
        "models[tierOf(m.id)] = { name: m.label || m.id };"],
    ]);
    await mustGoRed(mod, async (m) => {
      const { home, dataDir } = makeHome("mc");
      m.mod.applyClient(m.mod.opencodeClient, ctxOf(home), { dataDir });
      const cfg = readJson(path.join(home, ".config", "opencode", "opencode.json"));
      for (const [tier, entry] of Object.entries(cfg.provider.bai.models)) {
        assert.match(String(entry.id || ""), /^[a-z0-9]+\/[A-Za-z0-9._-]+$/,
          `条目「${tier}」的 id 必须是 provider/档位：${entry.id}`);
      }
    }, "条目里的 id 去掉之后，②a 竟然还过");
  });

  test("③d 迁移不删旧表名 ⇒ ②c 会红", async () => {
    const { mod } = await mutant(SRC_OPENCODE, [
      ["writes.push({ path: legacyPath, delete: true });", "/* 不删了 */"],
    ]);
    await mustGoRed(mod, async (m) => {
      const { home, dataDir } = makeHome("md");
      const dir = path.join(home, ".config", "opencode");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "opencode.json");
      writeFileSync(file, JSON.stringify({
        provider: { bai: { models: { "sn/claude-opus-5": { name: "我的名字" } } } },
      }, null, 2));
      m.mod.applyClient(m.mod.opencodeClient, ctxOf(home), { dataDir });
      const models = readJson(file).provider.bai.models;
      assert.ok(!("sn/claude-opus-5" in models), "旧表名（整个 id）应当被删掉");
    }, "不删旧表名之后，②c 竟然还过");
  });
});

/* 测完把环境变量还回去。 */
after(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});
