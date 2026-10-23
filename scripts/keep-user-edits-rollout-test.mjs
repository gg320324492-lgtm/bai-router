/**
 * 「保留用户手改」的通用合并层 · 铺到三个客户端
 * （scripts/keep-user-edits-rollout-test.mjs）
 *
 * ## 测什么
 *
 * 通用合并层（src/server/clients/merge-policy.mjs）在三个**真实声明**上：
 *
 *   ★ ① **WorkBuddy**（models.json，数组根 / 对象根两种形状）
 *   ★ ② **Qwen Code**（settings.json 的 modelProviders.openai）
 *   ★ ③ **OpenCode**（opencode.json 的 provider.<pid>，逐字段写）
 *
 * 每个客户端都跑这几件事：
 *   · 用户改过的**模型名 / provider 名**留着（逐值比对）
 *   · 用户**自己加的**条目 / 模型 / 键原样留着、位置不变
 *   · 用户改了**顺序** ⇒ 顺序留着，且 id 与名字**不错位**
 *     （合并层按出现顺序配对 ⇒ 我们的清单要按用户文件里的顺序排好）
 *   · **地址 / key / 模型 id 集合**仍然是我们的（机器该管的照写）
 *   · **断开后文件与接线前逐字相同**（硬红线）
 *   · 读不懂的配置 ⇒ 中止，用户的文件一个字不动
 *
 * ## 反向对照（每条都**真的跑红**才算数）
 *
 *   ④a 把合并层改成「总是我们的赢」    ⇒ ①a/②a/③a 的「名字留着」必须失效
 *   ④b 把「备份里存原值」改成「存新值」 ⇒ ①e/②c/③c 的「逐字还原」必须失效
 *   ④c 把弱保留改成「抹掉用户的键」    ⇒ 「用户自己加的条目留着」必须失效
 *   ④d 把**每个客户端自己的归属表**改坏 ⇒ 该客户端的「名字留着」必须失效
 *   ④e 把 alignOurs 改坏（不排了）    ⇒ 「顺序改了不错位」必须失效
 *
 * ⚠ 改坏副本放在临时目录里 import —— **绝不改仓库里的源码**。
 * ⚠ 锚点与源码脱节时**明确报「锚点与源码脱节」**，不假绿。
 *
 * ## 红线
 *
 * 🔴 落盘只在 os.tmpdir() 下的临时目录 —— **绝不碰真实的用户 home**。
 * 🔴 客户端自己的目录变量（WORKBUDDY_CONFIG_DIR / QWEN_HOME /
 *    OPENCODE_CONFIG_DIR / XDG_CONFIG_HOME）一律清掉，
 *    APPDATA / LOCALAPPDATA 指到临时目录（底座的写盘护栏认这两个根）。
 * 🔴 全文没有一个真实令牌/API key（夹具里的 key 是明显假的占位串）。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyClient, revertClient } from "../src/server/clients/base.mjs";
/* 头号格式「根是数组」的读写器要**注册**进底座（workbuddy 的 models.json 两种形状都靠它）。 */
import "../src/server/clients/formats-json-list.mjs";
import { workBuddyClient } from "../src/server/clients/workbuddy.mjs";
import { qwenCodeClient } from "../src/server/clients/qwen-code.mjs";
import { opencodeClient } from "../src/server/clients/opencode.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-keep-rollout-"));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* ------------------------------------------------------------------ *
 * 隔离：客户端自己的目录变量一律清掉，APPDATA / LOCALAPPDATA 指到临时目录
 * ------------------------------------------------------------------ */
for (const k of ["WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "QWEN_HOME",
  "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
  delete process.env[k];
}
process.env.APPDATA = path.join(TMPROOT, "appdata");
process.env.LOCALAPPDATA = path.join(TMPROOT, "localappdata");
process.env.BAI_CLIENT_HOME = path.join(TMPROOT, "client-home");

let seq = 0;
function tmpDir() {
  const d = path.join(TMPROOT, `r${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 接线上下文（两个模型：第二个的 id **带点** —— 键里带点的那条路要一起测）。 */
const CTX = {
  home: "",
  baseUrl: "http://127.0.0.1:15799",
  apiKey: "bai-local",
  models: [
    { id: "sn/claude-opus-5", label: "Claude Opus 5" },
    { id: "sn/glm-5.2", label: "GLM 5.2" },
  ],
  providerId: "bai",
  providerName: "B.AI",
};

/** 旧网关地址 —— 「地址是机器该管的 ⇒ 必须换成我们的」。 */
const OLD_URL = "http://127.0.0.1:15798";

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}
/** 夹具一律用紧凑 JSON —— 断开后要逐字相同（排版也得一样）。 */
function writeJson(file, obj) {
  writeText(file, JSON.stringify(obj));
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/* 三个客户端各自的配置文件（在临时 home 底下）。 */
const wbFile = (home) => path.join(home, ".workbuddy", "models.json");
const qwFile = (home) => path.join(home, ".qwen", "settings.json");
const ocFile = (home) => path.join(home, ".config", "opencode", "opencode.json");

/* ====================================================================== *
 * ① WorkBuddy
 * ====================================================================== */
describe("① WorkBuddy：models.json（数组根）", () => {
  const oursEntry = (m, over = {}) => ({
    id: m.id, name: m.label, vendor: "bai", apiKey: CTX.apiKey,
    url: `${CTX.baseUrl}/v1/chat/completions`, supportsToolCall: true, ...over,
  });

  test("①a 用户改过的模型名留着；用户自己的条目原样、位置不变；地址/key 换成我们的", () => {
    const home = tmpDir();
    const file = wbFile(home);
    writeJson(file, [
      oursEntry(CTX.models[0], { name: "我改过的名字", url: `${OLD_URL}/v1/chat/completions`, disabled: true }),
      { id: "qwen-local", name: "本地通义", vendor: "alibaba", apiKey: "别人的key", url: "https://别处/v1/chat/completions" },
      oursEntry(CTX.models[1]),
    ]);
    const r = applyClient(workBuddyClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = readJson(file);
    assert.equal(j.length, 3, "不该多出/少掉条目");
    assert.equal(j[0].id, "sn/claude-opus-5", "★ 我们的条目被挪到末尾了");
    assert.equal(j[0].name, "我改过的名字", "★ 用户改过的模型名被改回去了");
    assert.equal(j[0].url, `${CTX.baseUrl}/v1/chat/completions`, "地址是机器该管的 ⇒ 必须换成我们的");
    assert.equal(j[0].apiKey, CTX.apiKey, "key 是机器该管的 ⇒ 必须换成我们的");
    assert.equal(j[0].disabled, true, "★ 用户关掉的模型被重新打开了（disabled 我们压根没写 ⇒ 该留着）");
    assert.equal(j[1].id, "qwen-local", "★ 用户自己的条目被挪位/抹了");
    assert.equal(j[1].url, "https://别处/v1/chat/completions", "★ 用户自己条目的地址被我们改了");
    assert.equal(j[1].apiKey, "别人的key", "★ 用户自己条目的 key 被我们改了");
    assert.equal(j[2].id, "sn/glm-5.2", "★ 我们另一条模型没原地留着");
  });

  test("①b WorkBuddy 自己的表单存过的那一条（vendor 成了 Custom）认得出 ⇒ 不重复", () => {
    /* magpie 的 kept_effort_test.go:53-60 记着：WorkBuddy 的 Settings > Models
       把改过的模型**整条**存回去，vendor 存成 "Custom"（只有手改 json 才留着
       vendor）⇒ 只认 vendor 会认不出它 ⇒ 同一个模型出现两次。 */
    const home = tmpDir();
    const file = wbFile(home);
    writeJson(file, [{
      id: "sn/claude-opus-5", name: "我改过的名字", vendor: "Custom", apiKey: CTX.apiKey,
      url: `${OLD_URL}/v1/chat/completions`, supportsToolCall: true, useCustomProtocol: false,
    }]);
    const r = applyClient(workBuddyClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = readJson(file);
    const same = j.filter((e) => e && e.id === "sn/claude-opus-5");
    assert.equal(same.length, 1, "★ 同一个模型出现了两次（magpie 要求 no second entry of any model）");
    assert.equal(same[0].name, "我改过的名字", "★ 用户改过的模型名被改回去了");
    assert.equal(same[0].vendor, "bai", "★ vendor 没换回我们的（magpie 同：sync 后 vendor 归 magpie）");
    assert.equal(same[0].url, `${CTX.baseUrl}/v1/chat/completions`, "地址是机器该管的");
    assert.equal(same[0].useCustomProtocol, false, "★ 用户自己加的键被抹掉了");
  });

  test("①c 用户改了顺序 ⇒ 顺序留着，id 与名字**不错位**", () => {
    /* 合并层认出「我们那一条」靠识别键（一个组）⇒ 它按**出现顺序**配对
       ⇒ 我们的清单必须按用户文件里的顺序排好（alignOurs），否则用户的改名
       会贴到别的模型上：显示「M2」的那个条目其实问的是 m1。 */
    const home = tmpDir();
    const file = wbFile(home);
    writeJson(file, [
      oursEntry(CTX.models[1]),                                   // sn/glm-5.2 在前
      oursEntry(CTX.models[0], { name: "我改过的 Opus" }),          // sn/claude-opus-5 在后
    ]);
    const r = applyClient(workBuddyClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = readJson(file);
    assert.equal(j[0].id, "sn/glm-5.2", "★ 顺序没留住");
    assert.equal(j[0].name, "GLM 5.2", "★ 名字贴到了别的模型上（id 与名字错位）");
    assert.equal(j[1].id, "sn/claude-opus-5", "★ 顺序没留住");
    assert.equal(j[1].name, "我改过的 Opus", "★ 用户改过的名字被改回去了");
  });

  test("①d 我们自己的档位顺序变了 ⇒ 配对同样不错位", () => {
    /* ctx.models 的顺序不是固定的（档位表改了顺序就会变）⇒ 同一套配对问题。 */
    const home = tmpDir();
    const file = wbFile(home);
    writeJson(file, [
      oursEntry(CTX.models[0]),                                   // 文件里 opus 在前
      oursEntry(CTX.models[1]),
    ]);
    const ctx = { ...CTX, home, models: [CTX.models[1], CTX.models[0]] };  // 这次 glm 在前
    const r = applyClient(workBuddyClient, ctx, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = readJson(file);
    assert.equal(j[0].id, "sn/claude-opus-5", "★ 我们的档位顺序变了 ⇒ 用户的条目被错位了");
    assert.equal(j[0].name, "Claude Opus 5", "★ 名字贴到了别的模型上");
    assert.equal(j[1].id, "sn/glm-5.2");
    assert.equal(j[1].name, "GLM 5.2");
  });

  test("①e 断开后与接线前**逐字相同**", () => {
    const home = tmpDir();
    const file = wbFile(home);
    const before = JSON.stringify([
      oursEntry(CTX.models[0], { name: "我改过的名字", disabled: true }),
      { id: "qwen-local", name: "本地通义", vendor: "alibaba", apiKey: "别人的key" },
    ]);
    writeText(file, before);
    applyClient(workBuddyClient, { ...CTX, home }, { dataDir: home });
    const back = revertClient(workBuddyClient, { dataDir: home });
    assert.equal(back.ok, true, back.detail);
    assert.equal(fs.readFileSync(file, "utf8"), before, "★ 断开后与原来不逐字相同");
  });

  test("①f 对象根（CodeBuddy Code 那种形状）也是同一套判据", () => {
    const home = tmpDir();
    const file = wbFile(home);
    writeJson(file, {
      models: [oursEntry(CTX.models[0], { name: "我改过的名字" })],
      availableModels: ["sn/claude-opus-5", "qwen-local"],
    });
    const r = applyClient(workBuddyClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = readJson(file);
    assert.equal(j.models[0].name, "我改过的名字", "★ 用户改过的模型名被改回去了");
    assert.equal(j.models[0].url, `${CTX.baseUrl}/v1/chat/completions`, "地址是机器该管的");
    assert.ok(j.availableModels.includes("qwen-local"), "★ 用户自己那条被 availableModels 抹了");
  });

  test("①g 读不懂的 models.json ⇒ 中止，用户的文件一个字不动", () => {
    const home = tmpDir();
    const file = wbFile(home);
    const broken = "{ 这不是 json";
    writeText(file, broken);
    const r = applyClient(workBuddyClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, false, "坏文件不该被接线");
    assert.match(String(r.detail || ""), /读不懂|读不了/);
    assert.equal(fs.readFileSync(file, "utf8"), broken, "★ 用户的坏文件被改写了");
  });
});

/* ====================================================================== *
 * ② Qwen Code
 * ====================================================================== */
describe("② Qwen Code：settings.json 的 modelProviders.openai", () => {
  const oursEntry = (m, over = {}) => ({
    baseUrl: CTX.baseUrl, envKey: "BAI_QWEN_API_KEY", id: m.id, name: m.label, ...over,
  });

  test("②a 改过的 name 留着；用户自己的条目原样、位置不变；地址换成我们的", () => {
    const home = tmpDir();
    const file = qwFile(home);
    writeJson(file, {
      modelProviders: {
        openai: [
          oursEntry(CTX.models[0], { name: "我改过的名字", baseUrl: OLD_URL }),
          { baseUrl: "https://别人的/v1", envKey: "MY_KEY", id: "gpt-4o", name: "我自己的模型" },
          oursEntry(CTX.models[1]),
        ],
      },
      model: { name: "sn/claude-opus-5" },
      security: { auth: { selectedType: "openai" } },
      env: { MY_KEY: "别人的key" },
    });
    const r = applyClient(qwenCodeClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = readJson(file);
    const list = j.modelProviders.openai;
    assert.equal(list.length, 3, "不该多出/少掉条目");
    assert.equal(list[0].id, "sn/claude-opus-5", "★ 我们的条目被挪到末尾了");
    assert.equal(list[0].name, "我改过的名字", "★ 用户改过的名字被改回去了");
    assert.equal(list[0].baseUrl, CTX.baseUrl, "地址是机器该管的 ⇒ 必须换成我们的");
    assert.equal(list[0].envKey, "BAI_QWEN_API_KEY", "envKey 是我们的（认出「我们那一条」的钥匙）");
    assert.equal(list[1].id, "gpt-4o", "★ 用户自己的条目被抹了");
    assert.equal(list[1].baseUrl, "https://别人的/v1", "★ 用户自己条目的地址被我们改了");
    assert.equal(list[1].name, "我自己的模型", "★ 用户自己条目的名字被我们改了");
    assert.equal(list[2].id, "sn/glm-5.2", "★ 我们另一条模型没原地留着");
    assert.equal(j.env.MY_KEY, "别人的key", "★ 用户 env 里的变量被动了");
    assert.equal(j.env.BAI_QWEN_API_KEY, CTX.apiKey, "key 是机器该管的");
    assert.equal(j.model.baseUrl, CTX.baseUrl, "地址是机器该管的");
  });

  test("②b 用户改了顺序 ⇒ 顺序留着，id 与名字不错位", () => {
    const home = tmpDir();
    const file = qwFile(home);
    writeJson(file, {
      modelProviders: {
        openai: [
          oursEntry(CTX.models[1]),                                   // glm 在前
          oursEntry(CTX.models[0], { name: "我改过的名字" }),          // opus 在后
        ],
      },
    });
    const r = applyClient(qwenCodeClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const list = readJson(file).modelProviders.openai;
    assert.equal(list[0].id, "sn/glm-5.2", "★ 顺序没留住");
    assert.equal(list[0].name, "GLM 5.2", "★ 名字贴到了别的模型上");
    assert.equal(list[1].id, "sn/claude-opus-5");
    assert.equal(list[1].name, "我改过的名字", "★ 用户改过的名字被改回去了");
  });

  test("②c 断开后与接线前**逐字相同**", () => {
    const home = tmpDir();
    const file = qwFile(home);
    const before = JSON.stringify({
      modelProviders: {
        openai: [
          oursEntry(CTX.models[0], { name: "我改过的名字", baseUrl: OLD_URL }),
          { baseUrl: "https://别人的/v1", envKey: "MY_KEY", id: "gpt-4o", name: "我自己的模型" },
        ],
      },
      model: { name: "sn/claude-opus-5" },
      security: { auth: { selectedType: "openai" } },
      env: { MY_KEY: "别人的key" },
    });
    writeText(file, before);
    applyClient(qwenCodeClient, { ...CTX, home }, { dataDir: home });
    const back = revertClient(qwenCodeClient, { dataDir: home });
    assert.equal(back.ok, true, back.detail);
    assert.equal(fs.readFileSync(file, "utf8"), before, "★ 断开后与原来不逐字相同");
  });

  test("②d 读不懂的 settings.json ⇒ 中止，用户的文件一个字不动", () => {
    const home = tmpDir();
    const file = qwFile(home);
    const broken = "{ 坏的";
    writeText(file, broken);
    const r = applyClient(qwenCodeClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, false, "坏文件不该被接线");
    assert.equal(fs.readFileSync(file, "utf8"), broken, "★ 用户的坏文件被改写了");
  });
});

/* ====================================================================== *
 * ③ OpenCode
 * ====================================================================== */
describe("③ OpenCode：opencode.json 的 provider.<pid>", () => {
  test("③a provider 改名留着（根模式）；模型名留着；用户自己的模型留着", () => {
    const home = tmpDir();
    const file = ocFile(home);
    writeJson(file, {
      provider: {
        bai: {
          npm: "@ai-sdk/openai-compatible",
          name: "我改过的 provider 名",
          options: { baseURL: `${OLD_URL}/v1`, apiKey: "旧key" },
          models: {
            "sn/claude-opus-5": { name: "我改过的模型名" },
            "sn/glm-5.2": { name: "GLM 5.2" },
            "我自己的/模型": { name: "我自己的模型" },
          },
        },
        other: { npm: "@ai-sdk/openai", name: "别人的" },
      },
      theme: "dark",
    });
    const r = applyClient(opencodeClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const j = readJson(file);
    const bai = j.provider.bai;
    assert.equal(bai.name, "我改过的 provider 名", "★ 用户改过的 provider 名被改回去了");
    assert.equal(bai.options.baseURL, `${CTX.baseUrl}/v1`, "地址是机器该管的 ⇒ 必须换成我们的");
    assert.equal(bai.options.apiKey, CTX.apiKey, "key 是机器该管的 ⇒ 必须换成我们的");
    assert.equal(bai.npm, "@ai-sdk/openai-compatible", "方言/包名是机器该管的");
    assert.equal(bai.models["sn/claude-opus-5"].name, "我改过的模型名", "★ 用户改过的模型名被改回去了");
    assert.equal(bai.models["sn/glm-5.2"].name, "GLM 5.2", "★ 我们的模型名被改回去了");
    assert.equal(bai.models["我自己的/模型"].name, "我自己的模型", "★ 用户自己加的模型被抹了");
    assert.equal(j.provider.other.name, "别人的", "★ 别人的 provider 被动了");
    assert.equal(j.theme, "dark", "★ 用户的其它配置被动");
  });

  test("③b 模型 id 里带点（sn/glm-5.2）时，切路径不会切坏它", () => {
    const home = tmpDir();
    const file = ocFile(home);
    writeJson(file, { provider: { bai: { models: { "sn/glm-5.2": { name: "我改过的名字" } } } } });
    const r = applyClient(opencodeClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, true, r.detail);
    const models = readJson(file).provider.bai.models;
    assert.equal(models["sn/glm-5.2"].name, "我改过的名字", "★ 带点的键被切坏了");
    assert.ok(models["sn/claude-opus-5"], "★ 我们的模型没写进去");
  });

  test("③c 断开后与接线前**逐字相同**", () => {
    const home = tmpDir();
    const file = ocFile(home);
    const before = JSON.stringify({
      provider: {
        bai: {
          npm: "@ai-sdk/openai-compatible",
          name: "我改过的 provider 名",
          options: { baseURL: `${OLD_URL}/v1`, apiKey: "旧key" },
          models: { "sn/claude-opus-5": { name: "我改过的模型名" }, "我自己的/模型": { name: "我自己的模型" } },
        },
      },
      theme: "dark",
    });
    writeText(file, before);
    applyClient(opencodeClient, { ...CTX, home }, { dataDir: home });
    const back = revertClient(opencodeClient, { dataDir: home });
    assert.equal(back.ok, true, back.detail);
    assert.equal(fs.readFileSync(file, "utf8"), before, "★ 断开后与原来不逐字相同");
  });

  test("③d 读不懂的 opencode.json ⇒ 中止，用户的文件一个字不动", () => {
    const home = tmpDir();
    const file = ocFile(home);
    const broken = "{ 坏的";
    writeText(file, broken);
    const r = applyClient(opencodeClient, { ...CTX, home }, { dataDir: home });
    assert.equal(r.ok, false, "坏文件不该被接线");
    assert.equal(fs.readFileSync(file, "utf8"), broken, "★ 用户的坏文件被改写了");
  });
});

/* ====================================================================== *
 * ⑤ 内容没变 ⇒ 不重写用户的文件
 * ====================================================================== */
describe("⑤ 合并后与现值一样 ⇒ 那个文件一个字都不动", () => {
  const cases = [
    ["WorkBuddy", workBuddyClient, wbFile],
    ["Qwen Code", qwenCodeClient, qwFile],
    ["OpenCode", opencodeClient, ocFile],
  ];
  for (const [name, def, fileOf] of cases) {
    test(`⑤ ${name}：再接一次，文件逐字不变`, () => {
      const home = tmpDir();
      const file = fileOf(home);
      const ctx = { ...CTX, home };
      const first = applyClient(def, ctx, { dataDir: home });
      assert.equal(first.ok, true, first.detail);
      const before = fs.readFileSync(file, "utf8");
      const again = applyClient(def, ctx, { dataDir: home });
      assert.equal(again.ok, true, again.detail);
      assert.equal(fs.readFileSync(file, "utf8"), before,
        "★ 内容没变却把文件重写了一遍（用户手写的排版被换掉了）");
    });
  }
});

/* ====================================================================== *
 * ④ 反向对照：改坏 ⇒ 判据必须红
 * ====================================================================== */

/**
 * copyTree —— 把 clients 目录 + edit-json.mjs 复制一份到临时目录。
 *
 * 改坏的副本在副本里 import —— **仓库里的源码一个字不动**。
 */
function copyTree(tag) {
  const dir = path.join(TMPROOT, tag);
  const dst = path.join(dir, "src", "server", "clients");
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(path.join(REPO, "src", "server", "clients"))) {
    if (!f.endsWith(".mjs")) continue;
    fs.copyFileSync(path.join(REPO, "src", "server", "clients", f), path.join(dst, f));
  }
  fs.mkdirSync(path.join(dir, "src", "server"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "src", "server", "edit-json.mjs"), path.join(dir, "src", "server", "edit-json.mjs"));
  return dir;
}

/** patch —— 在副本里改坏一处；**锚点对不上就当场报「锚点与源码脱节」**。 */
function patch(dir, rel, from, to) {
  const file = path.join(dir, "src", "server", "clients", rel);
  const text = fs.readFileSync(file, "utf8");
  const broken = text.replace(from, to);
  assert.notEqual(broken, text,
    `改坏的副本没改成（${rel} 的锚点与源码脱节了）—— 这条反向对照失效了`);
  fs.writeFileSync(file, broken, "utf8");
}

/**
 * importPatched —— import 副本里的一个模块。
 *
 * ⚠ **不带查询串**：副本里的客户端声明 import 的是「同目录的 base.mjs」——
 *   带查询串会多出一个模块实例 ⇒ 底座的「格式注册表」与客户端看到的不是同一份
 *   ⇒ 「json-list」格式找不到。副本目录每次都是新的 ⇒ 不会吃到上一次的缓存。
 */
async function importPatched(dir, rel) {
  const file = path.join(dir, "src", "server", "clients", rel);
  return import(pathToFileURL(file).href);
}

describe("④ 反向对照：改坏 ⇒ 判据必须红", () => {
  test("④a 把合并层改成「总是我们的赢」⇒ 三个客户端的「名字留着」都失效", async () => {
    const dir = copyTree("broken-merge-ours");
    /* 子路径的 theirs（数组元素里的 name 那种） */
    patch(dir, "merge-policy.mjs",
      "    if (sameValue(have, ours)) return ours;\n"
        + "    kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });\n"
        + "    return have;",
      "    if (sameValue(have, ours)) return ours;\n"
        + "    kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });\n"
        + "    return ours;   // SABOTAGE：用户的赢被改成我们的赢");
    /* 根模式的 theirs（标量那种 —— OpenCode 的 provider 名走这条） */
    patch(dir, "merge-policy.mjs",
      "      if (sameValue(have, ours)) return ours;\n"
        + "      kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });\n"
        + "      return have;",
      "      if (sameValue(have, ours)) return ours;\n"
        + "      kept.push({ path: prefix, theirs: safeValue(have), ours: safeValue(ours) });\n"
        + "      return ours;   // SABOTAGE：根模式里用户的赢被改成我们的赢");
    const base = await importPatched(dir, "base.mjs");
    const wb = await importPatched(dir, "workbuddy.mjs");
    const qw = await importPatched(dir, "qwen-code.mjs");
    const oc = await importPatched(dir, "opencode.mjs");

    /* WorkBuddy */
    let home = tmpDir();
    let file = wbFile(home);
    writeJson(file, [{ id: "sn/claude-opus-5", name: "我改过的名字", vendor: "bai", apiKey: CTX.apiKey, url: `${OLD_URL}/v1/chat/completions` }]);
    const wbr = base.applyClient(wb.workBuddyClient, { ...CTX, home }, { dataDir: home });
    assert.equal(wbr.ok, true, wbr.detail);
    assert.notEqual(readJson(file)[0].name, "我改过的名字",
      "★ 改坏之后仍然保留用户的名字 —— 那 ①a 的判据是恒真的，测了个寂寞");

    /* Qwen Code */
    home = tmpDir();
    file = qwFile(home);
    writeJson(file, { modelProviders: { openai: [{ baseUrl: OLD_URL, envKey: "BAI_QWEN_API_KEY", id: "sn/claude-opus-5", name: "我改过的名字" }] } });
    const qwr = base.applyClient(qw.qwenCodeClient, { ...CTX, home }, { dataDir: home });
    assert.equal(qwr.ok, true, qwr.detail);
    assert.notEqual(readJson(file).modelProviders.openai[0].name, "我改过的名字",
      "★ 改坏之后仍然保留用户的名字 —— 那 ②a 的判据是恒真的，测了个寂寞");

    /* OpenCode */
    home = tmpDir();
    file = ocFile(home);
    writeJson(file, { provider: { bai: { name: "我改过的 provider 名", models: { "sn/claude-opus-5": { name: "我改过的模型名" } } } } });
    const ocr = base.applyClient(oc.opencodeClient, { ...CTX, home }, { dataDir: home });
    assert.equal(ocr.ok, true, ocr.detail);
    const ocj = readJson(file);
    assert.notEqual(ocj.provider.bai.name, "我改过的 provider 名",
      "★ 改坏之后仍然保留用户的 provider 名 —— 那 ③a 的判据是恒真的，测了个寂寞");
    assert.notEqual(ocj.provider.bai.models["sn/claude-opus-5"].name, "我改过的模型名",
      "★ 改坏之后仍然保留用户的模型名 —— 那 ③a 的判据是恒真的，测了个寂寞");
  });

  test("④b 把「备份里存原值」改成「存新值」⇒ 三个客户端的「逐字还原」都失效", async () => {
    const dir = copyTree("broken-base");
    patch(dir, "base.mjs",
      "        value: e.before.existed === true ? e.before.value : null,\n      })),",
      "        value: e.value,   // SABOTAGE：备份里存的是写后的新值\n      })),");
    const base = await importPatched(dir, "base.mjs");
    const wb = await importPatched(dir, "workbuddy.mjs");
    const qw = await importPatched(dir, "qwen-code.mjs");
    const oc = await importPatched(dir, "opencode.mjs");

    const home = tmpDir();
    const file = wbFile(home);
    const before = JSON.stringify([{ id: "sn/claude-opus-5", name: "我改过的名字", vendor: "bai", apiKey: CTX.apiKey, url: `${OLD_URL}/v1/chat/completions` }]);
    writeText(file, before);
    base.applyClient(wb.workBuddyClient, { ...CTX, home }, { dataDir: home });
    base.revertClient(wb.workBuddyClient, { dataDir: home });
    assert.notEqual(fs.readFileSync(file, "utf8"), before,
      "★ 改坏之后仍然逐字还原 —— 那 ①e 的判据是恒真的，测了个寂寞");

    const home2 = tmpDir();
    const file2 = qwFile(home2);
    const before2 = JSON.stringify({ modelProviders: { openai: [{ baseUrl: OLD_URL, envKey: "BAI_QWEN_API_KEY", id: "sn/claude-opus-5", name: "我改过的名字" }] } });
    writeText(file2, before2);
    base.applyClient(qw.qwenCodeClient, { ...CTX, home: home2 }, { dataDir: home2 });
    base.revertClient(qw.qwenCodeClient, { dataDir: home2 });
    assert.notEqual(fs.readFileSync(file2, "utf8"), before2,
      "★ 改坏之后仍然逐字还原 —— 那 ②c 的判据是恒真的，测了个寂寞");

    const home3 = tmpDir();
    const file3 = ocFile(home3);
    const before3 = JSON.stringify({ provider: { bai: { name: "我改过的 provider 名", models: { "sn/claude-opus-5": { name: "我改过的模型名" } } } } });
    writeText(file3, before3);
    base.applyClient(oc.opencodeClient, { ...CTX, home: home3 }, { dataDir: home3 });
    base.revertClient(oc.opencodeClient, { dataDir: home3 });
    assert.notEqual(fs.readFileSync(file3, "utf8"), before3,
      "★ 改坏之后仍然逐字还原 —— 那 ③c 的判据是恒真的，测了个寂寞");
  });

  test("④c 把弱保留改成「抹掉用户没写的键」⇒ 「用户自己加的条目留着」失效", async () => {
    const dir = copyTree("broken-weakkeep");
    patch(dir, "merge-policy.mjs",
      "      out[k] = hv;                    /* 我们没写 ⇒ 用户的留下 */",
      "      out[k] = undefined;             // SABOTAGE：用户没写的键被抹掉");
    const base = await importPatched(dir, "base.mjs");
    const wb = await importPatched(dir, "workbuddy.mjs");
    const oc = await importPatched(dir, "opencode.mjs");

    let home = tmpDir();
    let file = wbFile(home);
    writeJson(file, [
      { id: "sn/claude-opus-5", name: "Opus", vendor: "bai", apiKey: CTX.apiKey, url: `${CTX.baseUrl}/v1/chat/completions` },
      { id: "qwen-local", name: "本地通义", vendor: "alibaba", apiKey: "别人的key", url: "https://别处/v1/chat/completions" },
    ]);
    base.applyClient(wb.workBuddyClient, { ...CTX, home }, { dataDir: home });
    assert.notEqual(readJson(file)[1], undefined,
      "★ 改坏之后用户自己那条还在 —— 那 ①a 的判据是恒真的，测了个寂寞");

    home = tmpDir();
    file = ocFile(home);
    writeJson(file, { provider: { bai: { models: { "我自己的/模型": { name: "我自己的模型" } } } } });
    base.applyClient(oc.opencodeClient, { ...CTX, home }, { dataDir: home });
    assert.equal(readJson(file).provider.bai.models["我自己的/模型"], undefined,
      "★ 改坏之后用户自己那个模型还在 —— 那 ③a 的判据是恒真的，测了个寂寞");
  });

  test("④d 把每个客户端**自己的归属表**改坏 ⇒ 该客户端的「名字留着」失效", async () => {
    /* WorkBuddy：把 theirs 里的 name 去掉（= 不承认「名字归用户」） */
    let dir = copyTree("broken-spec-wb");
    patch(dir, "workbuddy.mjs",
      "  key: \"apiKey\",\n  theirs: [\"name\"],",
      "  key: \"apiKey\",\n  theirs: [],   /* SABOTAGE：名字不归用户了 */");
    let base = await importPatched(dir, "base.mjs");
    let wb = await importPatched(dir, "workbuddy.mjs");
    let home = tmpDir();
    let file = wbFile(home);
    writeJson(file, [{ id: "sn/claude-opus-5", name: "我改过的名字", vendor: "bai", apiKey: CTX.apiKey, url: `${OLD_URL}/v1/chat/completions` }]);
    base.applyClient(wb.workBuddyClient, { ...CTX, home }, { dataDir: home });
    assert.notEqual(readJson(file)[0].name, "我改过的名字",
      "★ 改坏归属表之后仍然保留用户的名字 —— 那 ①a 的判据是恒真的，测了个寂寞");

    /* Qwen Code */
    dir = copyTree("broken-spec-qw");
    patch(dir, "qwen-code.mjs",
      "  key: \"envKey\",\n  theirs: [\"name\"],",
      "  key: \"envKey\",\n  theirs: [],   /* SABOTAGE：名字不归用户了 */");
    base = await importPatched(dir, "base.mjs");
    let qw = await importPatched(dir, "qwen-code.mjs");
    home = tmpDir();
    file = qwFile(home);
    writeJson(file, { modelProviders: { openai: [{ baseUrl: OLD_URL, envKey: "BAI_QWEN_API_KEY", id: "sn/claude-opus-5", name: "我改过的名字" }] } });
    base.applyClient(qw.qwenCodeClient, { ...CTX, home }, { dataDir: home });
    assert.notEqual(readJson(file).modelProviders.openai[0].name, "我改过的名字",
      "★ 改坏归属表之后仍然保留用户的名字 —— 那 ②a 的判据是恒真的，测了个寂寞");

    /* OpenCode：模型名的通配 */
    dir = copyTree("broken-spec-oc");
    patch(dir, "opencode.mjs",
      "merge: { theirs: [\"*.name\"] }",
      "merge: { theirs: [] }   /* SABOTAGE：模型名不归用户了 */");
    base = await importPatched(dir, "base.mjs");
    let oc = await importPatched(dir, "opencode.mjs");
    home = tmpDir();
    file = ocFile(home);
    writeJson(file, { provider: { bai: { models: { "sn/claude-opus-5": { name: "我改过的模型名" } } } } });
    base.applyClient(oc.opencodeClient, { ...CTX, home }, { dataDir: home });
    assert.notEqual(readJson(file).provider.bai.models["sn/claude-opus-5"].name, "我改过的模型名",
      "★ 改坏归属表之后仍然保留用户的模型名 —— 那 ③a 的判据是恒真的，测了个寂寞");
  });

  test("④e 把 alignOurs 改坏（不排了）⇒ 「顺序改了不错位」失效", async () => {
    const dir = copyTree("broken-align");
    patch(dir, "workbuddy.mjs",
      "  /* 文件里还没有我们那几条 ⇒ 没有顺序要对 ⇒ 我们的顺序就是我们的顺序。 */\n  if (!mine.length) return ours;",
      "  if (!mine.length) return ours;\n  return ours;   /* SABOTAGE：不按用户文件里的顺序排了 */");
    const base = await importPatched(dir, "base.mjs");
    const wb = await importPatched(dir, "workbuddy.mjs");
    const home = tmpDir();
    const file = wbFile(home);
    writeJson(file, [
      { id: "sn/glm-5.2", name: "GLM 5.2", vendor: "bai", apiKey: CTX.apiKey, url: `${CTX.baseUrl}/v1/chat/completions` },
      { id: "sn/claude-opus-5", name: "我改过的 Opus", vendor: "bai", apiKey: CTX.apiKey, url: `${CTX.baseUrl}/v1/chat/completions` },
    ]);
    base.applyClient(wb.workBuddyClient, { ...CTX, home }, { dataDir: home });
    const j = readJson(file);
    /* ⚠ 错位最先露馅的是**模型 id**：名字是「用户的」⇒ 两种情况下都留在原位；
       变的是我们的 id 顶着用户那条的位（点「M2」那个条目其实问的是另一个模型）。 */
    assert.notEqual(j[0].id, "sn/glm-5.2",
      "★ 改坏对齐之后 id 仍然配得上 —— 那 ①c 的判据是恒真的，测了个寂寞");
  });
});
