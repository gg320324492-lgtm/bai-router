/**
 * 「一份 JSON 加一个客户端」（src/server/clients/agent-plugin.mjs）
 *
 * ## 测什么
 *
 *   ★ ① 一份 JSON ⇒ 名录里多一个**能接上**的客户端（面板认得出来）
 *   ★ ② **接上**：配置真的写对了（地址 / key / 模型 / 模型清单）
 *   ★ ③ **断开**：用户的文件**逐字**回到接上之前
 *   ★ ④ 状态：接完说「已接到 B.AI」
 *   ★ ⑤ **装不上不许拖垮**：坏声明 ⇒ 一条**看得见的坏条目**，其余照常用
 *   ★ ⑥ 凭据纪律：顶层凭据字段 / 写凭据那处的字面量 ⇒ 都不许
 *   ★ ⑦ 撞 id：撞内置客户端 / 两个插件撞 ⇒ 报错，不覆盖
 *   ★ ⑧ **重扫**：放一份新声明 ⇒ 不重扫看不见，重扫才看得见
 *   ★ ⑨ 防漂移：凭据字段名单与 plugin.mjs 是同一份
 *   ★ ⑩ **反向对照**：改坏两处 ⇒ 判据必须红
 *
 * ## 红线
 *
 * 🔴 落盘只在 os.tmpdir() 下的临时目录 —— **绝不碰真实的用户 home / %APPDATA%**。
 * 🔴 BAI_DATA_DIR / BAI_CLIENT_HOME / APPDATA / LOCALAPPDATA 全指到临时目录。
 * 🔴 全文没有一个真实令牌/API key（夹具里的凭据形态串是明显假的占位串）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyClient, revertClient, clientStatus } from "../src/server/clients/base.mjs";
import {
  allClients, rescanClients, clientById, invalidateClientCache, agentPluginsDir,
} from "../src/server/clients/registry.mjs";
import {
  validateAgentManifest, loadAgentPlugins, agentPluginDir,
  AGENT_MANIFEST_VERSION, CREDENTIAL_FIELDS, PLACEHOLDERS,
} from "../src/server/clients/agent-plugin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-agentplug-"));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* ⚠ 三个环境变量都要指到临时目录：
 *   · BAI_DATA_DIR —— 插件声明目录的落点（agent-plugins 在它下面）；
 *   · APPDATA / LOCALAPPDATA —— 底座那道护栏允许写的三个根之一，
 *     不指走的话 Windows 上有可能写到真目录去；
 *   · BAI_CLIENT_HOME —— 接线要写的那个「家」。 */
const DATA_DIR = path.join(TMPROOT, "data");
const HOME = path.join(TMPROOT, "home");
process.env.BAI_DATA_DIR = DATA_DIR;
process.env.BAI_CLIENT_HOME = HOME;
process.env.APPDATA = path.join(TMPROOT, "appdata");
process.env.LOCALAPPDATA = path.join(TMPROOT, "localappdata");
for (const d of [DATA_DIR, HOME, process.env.APPDATA, process.env.LOCALAPPDATA]) {
  fs.mkdirSync(d, { recursive: true });
}

const PLUGIN_DIR = path.join(DATA_DIR, "agent-plugins");

let seq = 0;
function tmpDir() {
  const d = path.join(TMPROOT, `t${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 把一份声明写进插件目录。 */
function putPlugin(name, obj) {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  fs.writeFileSync(path.join(PLUGIN_DIR, name), text, "utf8");
}

/** 插件目录清空（每个用例从干净状态开始）。 */
function clearPlugins() {
  try { fs.rmSync(PLUGIN_DIR, { recursive: true, force: true }); } catch { }
  invalidateClientCache();
}

const CTX = {
  home: HOME,
  baseUrl: "http://127.0.0.1:15799",
  apiKey: "test-placeholder-key",
  models: [{ id: "sn/claude-opus-5", label: "Claude Opus 5" }],
  providerId: "bai",
  providerName: "B.AI",
};

/** 一份能用的声明（假客户端，不指向任何真程序）。 */
const GOOD = {
  manifestVersion: 1,
  id: "aider",
  name: "Aider",
  protocol: "chat",
  note: "测试用的假客户端",
  config: "~/.aider/config.json",
  format: "json",
  model: "model",
  writes: {
    "openai-api-base": "${baseUrlV1}",
    "openai-api-key": "${apiKey}",
  },
  modelList: {
    path: "models",
    as: "array",
    item: { id: "${id}", name: "${name}" },
  },
};

/** 那个客户端的配置文件（用户自己的一份，带他自己的内容）。 */
function cfgFile() {
  return path.join(HOME, ".aider", "config.json");
}
function writeUserCfg() {
  fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
  fs.writeFileSync(cfgFile(), JSON.stringify({
    theme: "dark",
    "openai-api-base": "https://example.invalid/v1",
  }, null, 2), "utf8");
}

/* ====================================================================== *
 * ① 一份 JSON ⇒ 名录里多一个能接的客户端
 * ====================================================================== */
describe("① 一份 JSON 加一个客户端", () => {
  test("①a 目录在数据目录下的 agent-plugins（与插件渠道的 plugins 分开）", () => {
    assert.equal(agentPluginDir(DATA_DIR), PLUGIN_DIR);
    assert.equal(agentPluginsDir(DATA_DIR), PLUGIN_DIR);
    /* ⚠ 两个目录不许是同一个 —— 混在一起会让两套校验互相报错。 */
    assert.notEqual(PLUGIN_DIR, path.join(DATA_DIR, "plugins"));
  });

  test("①b 声明装上了 ⇒ 名录里有它，形状与内置声明一样", async () => {
    clearPlugins();
    putPlugin("aider.json", GOOD);
    const list = await rescanClients();
    const c = list.find((x) => x.id === "aider");
    assert.ok(c, `插件客户端不在名录里：${list.map((x) => x.id).join("、")}`);
    assert.equal(c.name, "Aider");
    assert.equal(c.protocol, "chat");
    assert.equal(typeof c.files, "function");
    /* 面板上要认得出「这是用户自己加的」。 */
    assert.equal(c.plugin, true);
    assert.equal(c.pluginFile, "aider.json");
    assert.ok(/插件声明/.test(c.note), `note 里没标出它是插件：${c.note}`);
    /* ⚠ 内置客户端一个也不能少（加插件不许弄坏别的）。 */
    assert.ok(list.some((x) => x.id === "pi"), "内置客户端 pi 不见了");
    assert.ok(list.some((x) => x.id === "zcode"), "内置客户端 zcode 不见了");
  });

  test("①c clientById 也认得它", async () => {
    clearPlugins();
    putPlugin("aider.json", GOOD);
    await rescanClients();
    const c = await clientById("aider");
    assert.ok(c, "clientById 找不到插件客户端");
    assert.equal(c.id, "aider");
    assert.equal(await clientById("没有这个"), null);
  });

  test("①d 没有插件目录 ⇒ 一个也不多（默认行为不变）", async () => {
    clearPlugins();
    const list = await rescanClients();
    assert.ok(!list.some((x) => x.plugin), "没有插件目录却出现了插件客户端");
  });
});

/* ====================================================================== *
 * ② 接上
 * ====================================================================== */
describe("② 接上：配置真的写对了", () => {
  test("②a 地址 / key / 模型 / 模型清单都写进去了", async () => {
    clearPlugins();
    putPlugin("aider.json", GOOD);
    await rescanClients();
    writeUserCfg();
    const def = await clientById("aider");
    const r = applyClient(def, CTX, { dataDir: DATA_DIR });
    assert.equal(r.ok, true, `接线失败：${r.detail}`);
    const j = JSON.parse(fs.readFileSync(cfgFile(), "utf8"));
    assert.equal(j["openai-api-base"], "http://127.0.0.1:15799/v1", "网关地址写错了");
    assert.equal(j["openai-api-key"], CTX.apiKey, "key 不是接线时给的那个");
    assert.equal(j.model, "sn/claude-opus-5", "模型 id 必须是 provider/档位 那一整个");
    assert.deepEqual(j.models, [{ id: "sn/claude-opus-5", name: "Claude Opus 5" }], "模型清单不对");
    /* 用户自己的内容一个字没动。 */
    assert.equal(j.theme, "dark");
  });

  test("②b ${providerId} 在键路径里能用（接哪一家，键路径跟着变）", async () => {
    clearPlugins();
    putPlugin("p2.json", {
      manifestVersion: 1,
      id: "p2",
      name: "P2",
      config: "~/.p2/config.json",
      format: "json",
      writes: { "providers.${providerId}.baseUrl": "${baseUrl}" },
    });
    await rescanClients();
    const def = await clientById("p2");
    const r = applyClient(def, { ...CTX, providerId: "sn" }, { dataDir: DATA_DIR });
    assert.equal(r.ok, true, r.detail);
    const j = JSON.parse(fs.readFileSync(path.join(HOME, ".p2", "config.json"), "utf8"));
    assert.ok(j.providers && j.providers.sn, `键路径没按 providerId 展开：${JSON.stringify(j)}`);
    assert.equal(j.providers.sn.baseUrl, CTX.baseUrl);
  });

  test("②c 没有模型时不写半个配置（报清楚，不写盘）", async () => {
    clearPlugins();
    putPlugin("aider.json", GOOD);
    await rescanClients();
    const def = await clientById("aider");
    const r = applyClient(def, { ...CTX, models: [] }, { dataDir: DATA_DIR });
    assert.equal(r.ok, false, "没有模型却报成功了");
    assert.ok(/模型/.test(r.detail), `报错里没提模型：${r.detail}`);
  });

  test("②d 配置路径越界 ⇒ 底座那道护栏拦住（声明不能把写入指到别处）", async () => {
    clearPlugins();
    putPlugin("evil.json", { ...GOOD, id: "evil", config: "/etc/bai-evil.json" });
    await rescanClients();
    const def = await clientById("evil");
    const r = applyClient(def, CTX, { dataDir: DATA_DIR });
    assert.equal(r.ok, false, "写到 home 之外居然成功了");
    assert.ok(/拒绝写/.test(r.detail), `报错没说是护栏拦的：${r.detail}`);
  });

  test("②e YAML 的声明也能接上（magpie 的例子就是 YAML）", async () => {
    clearPlugins();
    putPlugin("yml.json", {
      manifestVersion: 1,
      id: "ymlclient",
      name: "YAML 假客户端",
      config: "~/.ymlclient/config.yml",
      format: "yaml",
      model: "model",
      writes: {
        "openai-api-base": "${baseUrlV1}",
        "openai-api-key": "${apiKey}",
      },
    });
    await rescanClients();
    const def = await clientById("ymlclient");
    const r = applyClient(def, CTX, { dataDir: DATA_DIR });
    assert.equal(r.ok, true, `接线失败：${r.detail}`);
    const text = fs.readFileSync(path.join(HOME, ".ymlclient", "config.yml"), "utf8");
    assert.ok(text.includes("http://127.0.0.1:15799/v1"), `YAML 里没有网关地址：${text}`);
    assert.ok(text.includes("sn/claude-opus-5"), `YAML 里没有模型 id：${text}`);
    /* 状态也得说接上了。 */
    const st = clientStatus(def, CTX, { dataDir: DATA_DIR });
    assert.equal(st.wired, true, `状态不对：${JSON.stringify(st)}`);
  });
});

/* ====================================================================== *
 * ③ 断开
 * ====================================================================== */
describe("③ 断开：用户的文件逐字回到接上之前", () => {
  test("③a 还原后逐字相同", async () => {
    clearPlugins();
    putPlugin("aider.json", GOOD);
    await rescanClients();
    writeUserCfg();
    const before = fs.readFileSync(cfgFile(), "utf8");
    const def = await clientById("aider");
    const a = applyClient(def, CTX, { dataDir: DATA_DIR });
    assert.equal(a.ok, true, a.detail);
    const r = revertClient(def, { dataDir: DATA_DIR });
    assert.equal(r.ok, true, r.detail);
    assert.equal(fs.readFileSync(cfgFile(), "utf8"), before, "断开后用户的文件没有逐字还原");
  });
});

/* ====================================================================== *
 * ④ 状态
 * ====================================================================== */
describe("④ 面板的状态", () => {
  test("④a 接完说「已接到 B.AI」", async () => {
    clearPlugins();
    putPlugin("aider.json", GOOD);
    await rescanClients();
    writeUserCfg();
    const def = await clientById("aider");
    applyClient(def, CTX, { dataDir: DATA_DIR });
    const st = clientStatus(def, CTX, { dataDir: DATA_DIR });
    assert.equal(st.wired, true, `状态不对：${JSON.stringify(st)}`);
  });

  test("④b 没接的时候说「还没接」", async () => {
    clearPlugins();
    putPlugin("aider.json", GOOD);
    await rescanClients();
    writeUserCfg();
    const def = await clientById("aider");
    const st = clientStatus(def, CTX, { dataDir: DATA_DIR });
    assert.equal(st.wired, false);
  });
});

/* ====================================================================== *
 * ⑤ 装不上不许拖垮
 * ====================================================================== */
describe("⑤ 装不上不许拖垮：坏声明是看得见的坏条目", () => {
  test("⑤a 语法错的声明 ⇒ 一条坏条目，其余客户端照常用", async () => {
    clearPlugins();
    putPlugin("broken.json", "{ 这不是 JSON ");
    putPlugin("aider.json", GOOD);
    const list = await rescanClients();
    const bad = list.find((x) => x.broken);
    assert.ok(bad, "装不上的声明没有变成坏条目");
    assert.ok(/broken\.json/.test(bad.name), `坏条目的名字里没有文件名：${bad.name}`);
    assert.ok(bad.note && bad.note.length > 5, "坏条目没说明为什么坏");
    assert.equal(typeof bad.files, "function");
    assert.deepEqual(bad.files(CTX), [], "坏条目的 files() 应当是空的（不许它去写盘）");
    /* ⚠ 关键：一份坏声明不许把整张名单掀了。 */
    assert.ok(list.some((x) => x.id === "aider"), "一份坏声明把好客户端也拖没了");
    assert.ok(list.some((x) => x.id === "pi"), "一份坏声明把内置客户端也拖没了");
  });

  test("⑤b 字段不合法（占位符不认）⇒ 坏条目", async () => {
    clearPlugins();
    putPlugin("bad2.json", { ...GOOD, id: "bad2", writes: { "a": "${noSuchThing}" } });
    const list = await rescanClients();
    const bad = list.find((x) => x.broken);
    assert.ok(bad, "占位符写错却装上了");
    assert.ok(/noSuchThing/.test(bad.note), `坏条目没说清是哪个占位符：${bad.note}`);
  });

  test("⑤c loadAgentPlugins 把错误**如实**报出来（file + 为什么）", () => {
    clearPlugins();
    putPlugin("bad3.json", { ...GOOD, id: "bad3", manifestVersion: 99 });
    const r = loadAgentPlugins({ dir: PLUGIN_DIR, builtinIds: ["pi"] });
    assert.equal(r.clients.length, 0);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].file, "bad3.json");
    assert.ok(/版本/.test(r.errors[0].error), `错误说明没提版本：${r.errors[0].error}`);
  });
});

/* ====================================================================== *
 * ⑥ 凭据纪律
 * ====================================================================== */
describe("⑥ 凭据不进声明", () => {
  test("⑥a 顶层带凭据字段 ⇒ 报错", () => {
    const v = validateAgentManifest({ ...GOOD, apiKey: "sk-不该在这里" });
    assert.equal(v.ok, false);
    assert.ok(/凭据/.test(v.errors.map((e) => e.message).join("\n")));
  });

  test("⑥b 写凭据的那一处写**字面量** ⇒ 报错（不许把 key 发出去）", () => {
    const v = validateAgentManifest({
      ...GOOD,
      writes: { "openai-api-base": "${baseUrlV1}", "openai-api-key": "sk-字面量不该在这儿" },
    });
    assert.equal(v.ok, false, "字面量 key 竟然通过了");
    const msg = v.errors.map((e) => e.message).join("\n");
    assert.ok(/占位符/.test(msg), `报错没说要写占位符：${msg}`);
  });

  test("⑥c 写凭据的那一处写**占位符** ⇒ 通过（且写进去的是接线时给的那个）", async () => {
    clearPlugins();
    putPlugin("aider.json", GOOD);
    await rescanClients();
    writeUserCfg();
    const def = await clientById("aider");
    applyClient(def, CTX, { dataDir: DATA_DIR });
    const j = JSON.parse(fs.readFileSync(cfgFile(), "utf8"));
    assert.equal(j["openai-api-key"], CTX.apiKey, "写进去的不是接线时给的那个 key");
  });

  test("⑥d **嵌套**对象里的凭据槽也拦得住（provider 块那种写法）", () => {
    const v = validateAgentManifest({
      ...GOOD,
      writes: { "providers.bai": { baseUrl: "${baseUrl}", apiKey: "sk-字面量不该在这儿" } },
    });
    assert.equal(v.ok, false, "嵌套对象里的字面量 key 竟然通过了");
    const msg = v.errors.map((e) => e.message).join("\n");
    assert.ok(/apiKey/.test(msg), `报错没点名是哪个键：${msg}`);
  });

  test("⑥e 模型清单的每一项里也不许藏字面量凭据", () => {
    const v = validateAgentManifest({
      ...GOOD,
      modelList: { path: "models", as: "array", item: { id: "${id}", apiKey: "sk-字面量" } },
    });
    assert.equal(v.ok, false, "清单项里的字面量 key 竟然通过了");
  });

  test("⑥f 声明文件里一个凭据都没有（源码层面查）", () => {
    /* 声明是**分发物** —— 它的源码里不该出现任何凭据形态的串。 */
    const src = fs.readFileSync(path.join(REPO, "src", "server", "clients", "agent-plugin.mjs"), "utf8");
    assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(src), "模块源码里出现了疑似真 key");
  });
});

/* ====================================================================== *
 * ⑦ 撞 id
 * ====================================================================== */
describe("⑦ 撞 id 报错不覆盖", () => {
  test("⑦a 插件 id 撞内置客户端 ⇒ 报错，内置那一份不受影响", async () => {
    clearPlugins();
    putPlugin("pi.json", { ...GOOD, id: "pi", name: "假的 Pi" });
    const list = await rescanClients();
    const bad = list.find((x) => x.broken);
    assert.ok(bad, "撞了内置 id 却装上了");
    assert.ok(/撞/.test(bad.note), `报错没说清是撞了什么：${bad.note}`);
    const builtin = list.find((x) => x.id === "pi");
    assert.ok(builtin, "内置的 pi 不见了");
    assert.notEqual(builtin.plugin, true, "内置的 pi 被插件顶掉了");
  });

  test("⑦b 两个插件撞同一个 id ⇒ 后一个报错，不覆盖先一个", async () => {
    clearPlugins();
    putPlugin("a1.json", { ...GOOD, id: "dup", name: "第一个" });
    putPlugin("a2.json", { ...GOOD, id: "dup", name: "第二个" });
    const list = await rescanClients();
    const good = list.filter((x) => x.id === "dup");
    assert.equal(good.length, 1, "两个都装上了");
    assert.equal(good[0].name, "第一个", "后一个把先一个顶掉了");
    const bad = list.find((x) => x.broken);
    assert.ok(bad && /已经有另一份声明/.test(bad.note), `报错没说清是撞了谁：${bad && bad.note}`);
  });
});

/* ====================================================================== *
 * ⑧ 重扫
 * ====================================================================== */
describe("⑧ 插件改了要能重扫", () => {
  test("⑧a 名录有缓存：不重扫就看不见新声明", async () => {
    clearPlugins();
    putPlugin("aider.json", GOOD);
    await rescanClients();
    const before = await allClients();
    assert.ok(before.some((x) => x.id === "aider"));
    /* 放一份新的（不改已缓存的那份） */
    putPlugin("second.json", { ...GOOD, id: "second", name: "第二个" });
    const cached = await allClients();
    assert.ok(!cached.some((x) => x.id === "second"), "缓存没生效（那重扫入口就没意义了）");
    const rescanned = await rescanClients();
    assert.ok(rescanned.some((x) => x.id === "second"), "重扫之后还是看不见新声明");
  });

  test("⑧b 重扫之后，改坏了的那份变成坏条目", async () => {
    clearPlugins();
    putPlugin("aider.json", GOOD);
    await rescanClients();
    fs.writeFileSync(path.join(PLUGIN_DIR, "aider.json"), "{ 坏掉了 ", "utf8");
    const list = await rescanClients();
    assert.ok(list.find((x) => x.broken), "改坏之后没有变成坏条目");
    assert.ok(!list.some((x) => x.id === "aider"), "改坏的那份还在名单里");
  });
});

/* ====================================================================== *
 * ⑨ 防漂移
 * ====================================================================== */
describe("⑨ 防漂移", () => {
  test("⑨a 凭据字段名单与 plugin.mjs 是同一份", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "server", "plugin.mjs"), "utf8");
    const m = /const CREDENTIAL_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src);
    assert.ok(m, "plugin.mjs 里找不到 CREDENTIAL_FIELDS —— 名单改了形状就得同步改这份断言");
    const live = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual([...CREDENTIAL_FIELDS], live, "凭据字段名单漂移了");
  });

  test("⑨b 占位符名单与模块里的一致", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "server", "clients", "agent-plugin.mjs"), "utf8");
    const m = /export const PLACEHOLDERS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(src);
    assert.ok(m, "agent-plugin.mjs 里找不到 PLACEHOLDERS");
    const live = [...m[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)].map((x) => x[1]);
    assert.deepEqual(Object.keys(PLACEHOLDERS), live, "占位符名单漂移了");
  });
});

/* ====================================================================== *
 * ⑩ 反向对照
 * ====================================================================== */
describe("⑩ 反向对照：改坏 ⇒ 判据必须红", () => {
  test("⑩a 去掉「写凭据那处只许占位符」⇒ ⑥b 必须失效", async () => {
    /* 手法：把 agent-plugin.mjs 复制到临时目录，在**副本**上删掉那条检查，
       再 import 副本跑一遍 ⑥b 的判据 —— 它必须抓不到「字面量 key」。
       ⚠ 改的是副本，仓库源码一个字不动。 */
    const dir = path.join(TMPROOT, "broken-ap");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(REPO, "src", "server", "clients", "agent-plugin.mjs");
    const text = fs.readFileSync(src, "utf8");
    const broken = text.replace(
      "if (credHits.length) {",
      "if (false) {   // SABOTAGE：凭据槽那处不再拦字面量",
    );
    assert.notEqual(broken, text, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    fs.writeFileSync(path.join(dir, "agent-plugin.mjs"), broken, "utf8");
    /* 副本要能 import 到 ../plugin.mjs 与 ./util.mjs。 */
    fs.copyFileSync(path.join(REPO, "src", "server", "plugin.mjs"), path.join(TMPROOT, "plugin.mjs"));
    fs.copyFileSync(path.join(REPO, "src", "server", "clients", "util.mjs"), path.join(dir, "util.mjs"));

    const mod = await import(pathToFileURL(path.join(dir, "agent-plugin.mjs")).href + `?v=${Date.now()}`);
    const v = mod.validateAgentManifest({
      ...GOOD,
      writes: { "openai-api-base": "${baseUrlV1}", "openai-api-key": "sk-字面量不该在这儿" },
    });
    assert.equal(v.ok, true,
      "副本居然还拦住了 —— 那 ⑥b 抓的不是这条检查（或者副本没生效），这条反向对照失效了");
  });

  test("⑩b 去掉 registry 的「第二个来源」⇒ ①b 必须失效", async () => {
    const dir = path.join(TMPROOT, "broken-registry");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(REPO, "src", "server", "clients", "registry.mjs");
    const text = fs.readFileSync(src, "utf8");
    const broken = text.replace(
      "  const plug = loadAgentPlugins({ builtinIds: out.map((c) => c.id) });\n"
      + "  for (const c of plug.clients) out.push(c);\n"
      + "  for (const e of plug.errors) out.push(brokenPluginEntry(e));",
      "  /* SABOTAGE：第二个来源（插件声明）被去掉了 */",
    );
    assert.notEqual(broken, text, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    fs.writeFileSync(path.join(dir, "registry.mjs"), broken, "utf8");
    fs.copyFileSync(path.join(REPO, "src", "server", "clients", "agent-plugin.mjs"), path.join(dir, "agent-plugin.mjs"));
    fs.copyFileSync(path.join(REPO, "src", "server", "clients", "util.mjs"), path.join(dir, "util.mjs"));
    fs.copyFileSync(path.join(REPO, "src", "server", "plugin.mjs"), path.join(TMPROOT, "plugin.mjs"));

    clearPlugins();
    putPlugin("aider.json", GOOD);
    const mod = await import(pathToFileURL(path.join(dir, "registry.mjs")).href + `?v=${Date.now()}`);
    const list = await mod.allClients();
    assert.ok(!list.some((x) => x.id === "aider"),
      "副本里插件客户端还在 —— 那 ①b 抓的不是「第二个来源」，这条反向对照失效了");
  });
});

/* ====================================================================== *
 * ⑪ 声明格式本身
 * ====================================================================== */
describe("⑪ 声明的校验", () => {
  test("⑪a 缺字段 ⇒ 一条一条说清楚", () => {
    const v = validateAgentManifest({ manifestVersion: AGENT_MANIFEST_VERSION });
    assert.equal(v.ok, false);
    const fields = v.errors.map((e) => e.field);
    assert.ok(fields.includes("id"), "没说要 id");
    assert.ok(fields.includes("name"), "没说要 name");
    assert.ok(fields.includes("config"), "没说要 config");
  });

  test("⑪b 不认识的字段 ⇒ 报错（不静默忽略）", () => {
    const v = validateAgentManifest({ ...GOOD, conifg: "~/.x/config.json" });
    assert.equal(v.ok, false);
    assert.ok(/不认识/.test(v.errors.map((e) => e.message).join("\n")));
  });

  test("⑪c 键路径里不许用模型占位符（值可能带点，会把路径切坏）", () => {
    const v = validateAgentManifest({ ...GOOD, writes: { "models.${modelId}.name": "${modelLabel}" } });
    assert.equal(v.ok, false);
    assert.ok(/键路径/.test(v.errors.map((e) => e.message).join("\n")));
  });

  test("⑪d 什么都没写 ⇒ 报错（接上了也不会有变化）", () => {
    const v = validateAgentManifest({
      manifestVersion: 1, id: "x", name: "X", config: "~/.x/config.json", format: "json",
    });
    assert.equal(v.ok, false);
  });

  test("⑪e 格式猜不出来 ⇒ 要用户写明 format", () => {
    const v = validateAgentManifest({ ...GOOD, config: "~/.aider/config", format: undefined });
    assert.equal(v.ok, false);
    assert.ok(/format/.test(v.errors.map((e) => e.message).join("\n")));
  });
});
