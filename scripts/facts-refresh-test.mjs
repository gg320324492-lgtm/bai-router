// scripts/facts-refresh-test.mjs —— **模型真值表的后台刷表**（阶段 3）+ **静默空表**查询
//
// ## 这个测试钉住什么
//
//   · `src/server/clients/facts-refresh.mjs` —— 刷表（拉 → 合并 → 守卫 → 落盘）
//   · `src/server/clients/model-facts.mjs` 的 `describeFactLookup` / `summarizeFactLookup`
//     —— 「这次有 N 条是真值、M 条是兜底」那一行账
//
// ## 与设计稿的关系
//
// `docs/client-wiring-deep-plan.md` §2.1（数据来源）与 §三 阶段 1 / 阶段 3。
// 交接：`model-facts-handoff.md` 第九节「待办」①（后台刷表）与 ②（静默空表断言）。
//
// ## 反向对照（改了哪一处 ⇒ 哪条断言必须红）
//
// | 改动的地方                                  | 必须红的断言 |
// | ----------------------------------------- | ------------ |
// | `refreshFacts`「全都拉不到也写」            | ④a          |
// | `refreshFacts` 的凭据守卫去掉              | ⑥a          |
// | `resolveDataDir` 不认 `BAI_DATA_DIR`       | ①a          |
// | `describeFactLookup` 的 `nonDefault` 判定   | ⑧b          |
// | `summarizeFactLookup` 的兜底计数            | ⑧d          |
//
// ⚠ 反向对照**真的跑红**才算数（做法照 `scripts/clients-base-test.mjs` 的 ⑥：
//   把源码复制到临时目录 → 在**副本**上改坏 → import 副本 → 跑判据 ⇒ 必须抛）。
//   ⚠ 改的是副本，仓库源码一个字不动。
//
// ## 红线
//
// 🔴 落盘只在 os.tmpdir() 下的临时目录 —— **绝不碰真实的用户 home**。
// 🔴 全文没有一个真实令牌（夹具里的凭据形态串是明显假的占位串）。
// 🔴 本文件**不注册进 package.json**（由负责人统一注册）。

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MODEL_FACTS, OUTLET_TIERS_AT,
  describeFactLookup, summarizeFactLookup,
} from "../src/server/clients/model-facts.mjs";
import {
  MODEL_FACTS_FILE_NAME, resolveDataDir, loadRefreshCfg, secretsOf,
  findSecretIn, refreshFacts, runRefresh, renderRefreshResult,
} from "../src/server/clients/facts-refresh.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-facts-refresh-"));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

let seq = 0;
function tmpDir() {
  const d = path.join(TMPROOT, `t${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 假的凭据（明显不是真的）。 */
const FAKE_TOKEN = "sk-fake-token-000000-not-a-real-token";

/** 一份「只够刷表用」的假配置。 */
const FAKE_CFG = {
  wb: { upstream: "https://www.workbuddy.cn", accessToken: FAKE_TOKEN },
  wbai: { upstream: "https://www.workbuddy.ai", accessToken: "sk-fake-wbai-000000-not-real" },
  qd: { modelsFile: "" },
};

/** 假目录（当 `collectCatalogs` 的返回值用）。 */
function catalog(provider, entries, source) {
  return {
    provider,
    entries,
    at: "2026-10-24T00:00:00.000Z",
    source: source || `${provider} /v3/config`,
  };
}

/** 假的 collect（注入给 `refreshFacts`）。 */
function fakeCollect(catalogs, errors) {
  return async () => ({ catalogs: catalogs || [], errors: errors || [] });
}

/** 读回覆盖层。 */
function readOverlay(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, MODEL_FACTS_FILE_NAME), "utf8"));
}

/* 出厂档位（照 config.defaults.json 的 mapping 抄一份）。
 *
 * ⚠ **三个 id 覆盖三种情况**（⑧ 那组断言靠它们）：
 *   · `wb/claude-opus-5` → hy3 ⇒ 表里是 `measured` ⇒ **真值**。
 *   · `bai/claude-fable-5` → qwen3.8-flash ⇒ 表里是 `convention` ⇒
 *     **查到了但值就是兜底** ⇒ 算「兜底」，不算真值。
 *   · `sn/claude-sonnet-5` → deepseek-v4-flash ⇒ 表里是 `shared`（单点证据）
 *     ⇒ **不下发** ⇒ 连「查到了」都不算。
 *   · `zz/claude-opus-5` ⇒ 表里根本没有 ⇒ 兜底。 */
const CFG = {
  mapping: { "claude-fable-5": { target: "qwen3.8-flash", label: "Qwen3.8-Flash" } },
  wb: { mapping: { "claude-opus-5": { target: "hy3", label: "HY3" } } },
  wbai: { mapping: { "claude-opus-5": { target: "hy4-preview-f", label: "Hy4-Preview-F" } } },
  sn: { mapping: { "claude-sonnet-5": { target: "deepseek-v4-flash", label: "DeepSeek-V4-Flash" } } },
};

/* ============================================================================
 * ① 数据目录解析（**必须与 server.mjs 的 DATA_DIR 同口径**）
 * ========================================================================== */
describe("① 数据目录解析", () => {
  test("①a BAI_DATA_DIR 最优先（应用起进程时一定设了它）", () => {
    const d = resolveDataDir({
      env: { BAI_DATA_DIR: path.join(TMPROOT, "from-env"), APPDATA: path.join(TMPROOT, "appdata") },
      serverDir: TMPROOT,
    });
    assert.equal(d, path.join(TMPROOT, "from-env"), "没认 BAI_DATA_DIR");
  });

  test("①b 显式 dataDir 最优先（连 BAI_DATA_DIR 都压得住）", () => {
    const d = resolveDataDir({
      dataDir: path.join(TMPROOT, "explicit"),
      env: { BAI_DATA_DIR: path.join(TMPROOT, "from-env") },
      serverDir: TMPROOT,
    });
    assert.equal(d, path.join(TMPROOT, "explicit"), "没认显式 dataDir");
  });

  test("①c server 目录里有 config.json ⇒ 用 server 目录（开发/绿色模式）", () => {
    const serverDir = tmpDir();
    fs.writeFileSync(path.join(serverDir, "config.json"), "{}", "utf8");
    const d = resolveDataDir({ env: { APPDATA: path.join(TMPROOT, "appdata") }, serverDir });
    assert.equal(d, serverDir, "开发模式没落在 server 目录（server.mjs 的 HERE 兜底）");
  });

  test("①d server 目录里没有 config.json ⇒ %APPDATA%/bai-router（安装版）", () => {
    const serverDir = tmpDir();
    const appData = tmpDir();
    const d = resolveDataDir({ env: { APPDATA: appData }, serverDir });
    assert.equal(d, path.join(appData, "bai-router"), "安装版没落在 %APPDATA%/bai-router");
  });
});

/* ============================================================================
 * ② 读配置：只取刷表要用的那几块
 * ========================================================================== */
describe("② 读配置", () => {
  test("②a 只取 wb/wbai/qd 三块，别的字段（apiKey 等）不进来", async () => {
    const dataDir = tmpDir();
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
      apiKey: "sk-secret-should-not-be-read",
      wb: { upstream: "https://www.workbuddy.cn", accessToken: FAKE_TOKEN, relayPort: 1234 },
      qd: { modelsFile: "C:/tmp/qoder-models.json" },
    }), "utf8");
    const serverDir = tmpDir();
    const loaded = await loadRefreshCfg({ dataDir, serverDir, env: {} });
    assert.deepEqual(Object.keys(loaded.cfg).sort(), ["qd", "wb", "wbai"], "取多了不该取的渠道");
    assert.equal(loaded.cfg.wb.relayPort, undefined, "把 relayPort 带进来了");
    assert.equal(loaded.cfg.wb.upstream, "https://www.workbuddy.cn");
    assert.equal(loaded.cfg.qd.modelsFile, "C:/tmp/qoder-models.json");
  });

  test("②b 令牌进的是凭据清单（内存），不落盘", async () => {
    const dataDir = tmpDir();
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
      wb: { accessToken: FAKE_TOKEN },
    }), "utf8");
    const loaded = await loadRefreshCfg({ dataDir, serverDir: tmpDir(), env: {} });
    assert.ok(loaded.secrets.includes(FAKE_TOKEN), "凭据清单里没有令牌");
    assert.deepEqual(secretsOf({ wb: { accessToken: "短" } }), [], "短串不该算凭据");
  });

  test("②c 用户把令牌清空了（登出）⇒ 不拿出厂默认值顶回去", async () => {
    const dataDir = tmpDir();
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
      wb: { accessToken: "" },
    }), "utf8");
    const serverDir = tmpDir();
    fs.writeFileSync(path.join(serverDir, "config.defaults.json"), JSON.stringify({
      wb: { accessToken: "出厂令牌不该被顶上来", upstream: "https://www.workbuddy.cn" },
    }), "utf8");
    const loaded = await loadRefreshCfg({ dataDir, serverDir, env: {} });
    assert.equal(loaded.cfg.wb.accessToken, "", "空令牌被出厂值顶回去了");
    assert.equal(loaded.cfg.wb.upstream, "https://www.workbuddy.cn", "上游地址该由出厂值兜底");
  });

  test("②d qd 的目录文件路径为空 ⇒ 用 server.mjs 的同一处兜底", async () => {
    const dataDir = tmpDir();
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ qd: {} }), "utf8");
    const loaded = await loadRefreshCfg({ dataDir, serverDir: tmpDir(), env: {} });
    assert.equal(loaded.cfg.qd.modelsFile, path.join(os.tmpdir(), "qoder-models.json"));
  });
});

/* ============================================================================
 * ③ 刷表：正常路径
 * ========================================================================== */
describe("③ 刷表：拉 → 合并 → 落盘", () => {
  test("③a 写成 <dataDir>/model-facts.json，且记了 baseAt（内置表的版本号）", async () => {
    const dir = tmpDir();
    const r = await refreshFacts({
      dataDir: dir,
      cfg: FAKE_CFG,
      collect: fakeCollect([catalog("wb", [{ id: "hy3", context: 192000, output: 64000 }])]),
      at: "2026-10-24T00:00:00.000Z",
    });
    assert.equal(r.ok, true, "刷表没成功");
    assert.equal(r.wrote, true);
    const j = readOverlay(dir);
    assert.equal(j.baseAt, OUTLET_TIERS_AT, "baseAt 不是内置表的版本号 ⇒ 内置表一改，覆盖层就该作废");
    assert.equal(j.facts["wb/hy3"].context, 192000);
    assert.equal(j.facts["wb/hy3"].kind, "measured", "渠道目录来的值该是 measured");
  });

  test("③b 原子写：不留半份临时文件", async () => {
    const dir = tmpDir();
    await refreshFacts({
      dataDir: dir,
      cfg: FAKE_CFG,
      collect: fakeCollect([catalog("wb", [{ id: "hy3", context: 192000, output: 64000 }])]),
    });
    const left = fs.readdirSync(dir);
    assert.equal(left.length, 1, `目录里不止一个文件：${left.join(",")}`);
    assert.equal(left[0], MODEL_FACTS_FILE_NAME);
    assert.ok(!left.some((n) => /\.tmp-/.test(n)), "留了临时文件");
  });

  test("③c 落盘内容里没有凭据（守卫的正面）", async () => {
    const dir = tmpDir();
    await refreshFacts({
      dataDir: dir,
      cfg: FAKE_CFG,
      collect: fakeCollect([catalog("wb", [{ id: "hy3", context: 192000, output: 64000 }])]),
    });
    const raw = fs.readFileSync(path.join(dir, MODEL_FACTS_FILE_NAME), "utf8");
    assert.ok(!raw.includes(FAKE_TOKEN), "令牌落进覆盖层了");
    assert.equal(findSecretIn(raw, [FAKE_TOKEN]), null, "守卫在覆盖层里认出了令牌（不该有）");
    assert.equal(findSecretIn(`这里有令牌 ${FAKE_TOKEN} 哟`, [FAKE_TOKEN]), FAKE_TOKEN, "守卫自己认不出令牌");
    assert.equal(findSecretIn(raw, ["别的东西"]), null, "守卫乱报了");
  });

  test("③d 内置表打底：目录里没有的条目还在（拉取是补充，不是清仓）", async () => {
    const dir = tmpDir();
    await refreshFacts({
      dataDir: dir,
      cfg: FAKE_CFG,
      collect: fakeCollect([catalog("wb", [{ id: "hy3", context: 192000, output: 64000 }])]),
    });
    const j = readOverlay(dir);
    assert.ok(j.facts["bai/hy3"], "内置表的条目被清掉了");
    assert.ok(j.facts["sn/glm-5.2"], "内置表的条目被清掉了");
  });

  test("③e 渠道目录的值覆盖内置表里的旧值（渠道能说真话时以渠道为准）", async () => {
    const dir = tmpDir();
    await refreshFacts({
      dataDir: dir,
      cfg: FAKE_CFG,
      collect: fakeCollect([catalog("wb", [{ id: "hy4-preview", context: 999000, output: 64000 }])]),
    });
    const j = readOverlay(dir);
    /* 内置表里 wb/hy4-preview-f 的 sourceId 就是 hy4-preview ⇒ 靠 sourceId 对上号。 */
    assert.equal(j.facts["wb/hy4-preview-f"].context, 999000, "目录的值没盖掉内置表的旧值");
  });
});

/* ============================================================================
 * ④ 一条都没拉到 ⇒ **不写文件**（这是最该安静退回去的一步）
 * ========================================================================== */
describe("④ 拉不到就安静退回去", () => {
  test("④a 全都拉不到 ⇒ 不写文件（不把旧覆盖层清掉）", async () => {
    const dir = tmpDir();
    const r = await refreshFacts({
      dataDir: dir,
      cfg: FAKE_CFG,
      collect: fakeCollect([], [{ provider: "wb", error: "模拟：网络不通" }]),
    });
    assert.equal(r.ok, false, "没拉到却报成功");
    assert.equal(r.reason, "no-catalogs");
    assert.equal(r.wrote, false);
    assert.ok(!fs.existsSync(path.join(dir, MODEL_FACTS_FILE_NAME)), "没拉到却写了文件");
  });

  test("④b 全都拉不到 ⇒ 旧覆盖层原样不动（客户端照常用上一份）", async () => {
    const dir = tmpDir();
    const old = '{"note":"旧的","at":"2026-10-23T00:00:00.000Z","baseAt":"2026-10-23","facts":{}}';
    fs.writeFileSync(path.join(dir, MODEL_FACTS_FILE_NAME), old, "utf8");
    const r = await refreshFacts({
      dataDir: dir,
      cfg: FAKE_CFG,
      collect: fakeCollect([], [{ provider: "wb", error: "模拟：令牌过期" }]),
    });
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(path.join(dir, MODEL_FACTS_FILE_NAME), "utf8"), old, "旧覆盖层被动过了");
  });

  test("④c 失败时给得出人话（面板/日志上看得见）", () => {
    const line = renderRefreshResult({
      ok: false, reason: "no-catalogs", file: "x",
      errors: [{ provider: "wb", error: "网络不通" }],
    });
    assert.ok(line.includes("一条目录都没拉到"), line);
    assert.ok(line.includes("wb：网络不通"), line);
  });
});

/* ============================================================================
 * ⑤ 一家挂掉不影响另一家
 * ========================================================================== */
describe("⑤ 逐个来：一个失败不影响别的", () => {
  test("⑤a wb 失败、wbai 成功 ⇒ 写了一家的值，另一家照样打底", async () => {
    const dir = tmpDir();
    const r = await refreshFacts({
      dataDir: dir,
      cfg: FAKE_CFG,
      collect: fakeCollect(
        [catalog("wbai", [{ id: "hy4-preview", context: 1000000, output: 64000 }])],
        [{ provider: "wb", error: "模拟：令牌过期" }],
      ),
    });
    assert.equal(r.ok, true, "一家失败就不写了");
    assert.equal(r.errors.length, 1);
    const j = readOverlay(dir);
    assert.equal(j.facts["wbai/hy4-preview-f"].context, 1000000, "成功那家的值没写进去");
    assert.ok(j.facts["wb/hy3"], "另一家的内置值没了");
  });
});

/* ============================================================================
 * ⑥ 凭据守卫
 * ========================================================================== */
describe("⑥ 凭据不进任何文件", () => {
  test("⑥a 落盘内容里会出现令牌 ⇒ 拒绝写", async () => {
    const dir = tmpDir();
    const r = await refreshFacts({
      dataDir: dir,
      cfg: FAKE_CFG,
      collect: fakeCollect([
        catalog("wb", [{ id: "hy3", context: 192000, output: 64000 }],
          `https://www.workbuddy.cn/v3/config?token=${FAKE_TOKEN}`),
      ]),
    });
    assert.equal(r.ok, false, "有凭据也写出去了");
    assert.equal(r.reason, "credential-leak");
    assert.ok(!fs.existsSync(path.join(dir, MODEL_FACTS_FILE_NAME)), "有凭据却落了盘");
  });
});

/* ============================================================================
 * ⑦ 落盘失败 ⇒ 安静退回去
 * ========================================================================== */
describe("⑦ 落盘失败", () => {
  test("⑦a 目标路径是个目录 ⇒ 落盘失败，但不抛", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, MODEL_FACTS_FILE_NAME), { recursive: true });
    const r = await refreshFacts({
      dataDir: dir,
      cfg: FAKE_CFG,
      collect: fakeCollect([catalog("wb", [{ id: "hy3", context: 192000, output: 64000 }])]),
    });
    assert.equal(r.ok, false, "落盘失败却报成功");
    assert.equal(r.reason, "save-failed");
    assert.ok(r.error, "没说是哪儿失败");
  });
});

/* ============================================================================
 * ⑧ 「静默空表」那一行账
 * ========================================================================== */
describe("⑧ 静默空表：看得见的账", () => {
  const entries = [
    { id: "wb/claude-opus-5" },       // 表里是 measured ⇒ 真值
    { id: "bai/claude-fable-5" },     // 表里是 convention ⇒ 查到了但值就是兜底
    { id: "sn/claude-sonnet-5" },     // 表里是 shared（单点证据）⇒ 不下发 ⇒ 查不到
    { id: "zz/claude-opus-5" },       // 表里根本没有
  ];

  test("⑧a 形状：总条数 / 查到的 / 非兜底的 / 兜底的 / 可疑", () => {
    const r = describeFactLookup(CFG, entries);
    assert.equal(r.total, 4);
    assert.equal(r.ids, 4, "ids 与 total 应当是同一个数");
    assert.equal(r.found, 2, "只有 measured 与 convention 算「查到了」（shared 不下发）");
    assert.equal(r.nonDefault, 1, "只有 wb/hy3 是非兜底的值");
    assert.equal(r.fallback, 3, "兜底条数 = 总条数 - 非兜底条数");
    assert.equal(r.status, "ok");
    assert.equal(r.suspicious, false);
    assert.equal(r.reason, "");
    assert.deepEqual(r.missing, ["sn/claude-sonnet-5", "zz/claude-opus-5"]);
  });

  test("⑧b 一个真值都没有 ⇒ suspicious + reason（这正是要看见的那种坏法）", () => {
    /* 一个是约定值、一个表里没有 ⇒ 全退回兜底。 */
    const r = describeFactLookup(CFG, [{ id: "bai/claude-fable-5" }, { id: "zz/claude-opus-5" }]);
    assert.equal(r.total, 2);
    assert.equal(r.nonDefault, 0);
    assert.equal(r.fallback, 2);
    assert.equal(r.status, "all-fallback");
    assert.equal(r.suspicious, true, "全兜底却没报出来 —— 那就是白接了");
    assert.ok(r.reason.length > 0, "没有说明");
  });

  test("⑧c 清单是空的 ⇒ status=empty，但**不算可疑**（用户没配渠道不是接线错）", () => {
    const r = describeFactLookup(CFG, []);
    assert.equal(r.total, 0);
    assert.equal(r.status, "empty");
    assert.equal(r.suspicious, false, "空清单不该报警");
  });

  test("⑧d 那一行账：N 条真值、M 条兜底", () => {
    const r = describeFactLookup(CFG, entries);
    const line = summarizeFactLookup(r);
    assert.ok(line.includes("4 个模型"), line);
    assert.ok(line.includes("1 条真值"), line);
    assert.ok(line.includes("3 条兜底"), line);
    assert.ok(line.includes("measured 1"), `真值的 kind 分类没写出来：${line}`);
    assert.ok(!line.includes("convention"), "约定值不该被算成真值：" + line);
  });

  test("⑧e 全兜底时那一行带 ⚠", () => {
    const r = describeFactLookup(CFG, [{ id: "zz/claude-opus-5" }]);
    const line = summarizeFactLookup(r);
    assert.ok(line.includes("⚠"), line);
    assert.ok(line.includes("0 条真值"), line);
  });

  test("⑧f 覆盖层优先于内置表（runtime 生效）", () => {
    const runtime = {
      "wb/hy3": { context: 1000000, output: 128000, kind: "measured", source: "wb /v3/config", at: "2026-10-24" },
    };
    const r = describeFactLookup(CFG, [{ id: "wb/claude-opus-5" }], { runtime });
    assert.equal(r.facts["wb/claude-opus-5"].context, 1000000, "覆盖层没生效");
    assert.equal(r.nonDefault, 1);
  });
});

/* ============================================================================
 * ⑨ 进程边界（刷表是**独立进程**）
 * ========================================================================== */
describe("⑨ 进程边界", () => {
  test("⑨a 刷表模块不 import server.mjs（热路径不该被拖进来）", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "server", "clients", "facts-refresh.mjs"), "utf8");
    assert.ok(!/from\s+"\.\.\/server\.mjs"/.test(src), "刷表模块 import 了 server.mjs");
  });

  test("⑨b server.mjs 不 import 刷表模块（刷表在独立进程里）", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "server", "server.mjs"), "utf8");
    assert.ok(!src.includes("facts-refresh"), "server.mjs 引用了刷表模块 —— 刷表必须是独立进程");
  });
});

/* ============================================================================
 * ⑩ 反向对照：改坏实现 ⇒ 对应断言必须真的会红
 * ========================================================================== */
describe("⑩ 反向对照 —— 改坏实现，对应断言必须真的会红", () => {
  /** 把源码复制到临时目录 → 在**副本**上改坏 → import 副本。 */
  async function mutant(rel, replacements, extraFiles) {
    const src = fs.readFileSync(path.join(REPO, rel), "utf8");
    let out = src;
    for (const [from, to] of replacements) {
      assert.ok(out.includes(from), `改坏用的锚点不在源码里：${JSON.stringify(from)}`);
      /* ⚠ **锚点必须只出现一次** —— `replace` 只改第一处；要是同一段字面
       *   在注释里也有一份，改坏就改到注释上去了 ⇒ 这条反向对照会假红
       *   （`model-facts-handoff.md` §七.1 记的坑）。 */
      const n = src.split(from).length - 1;
      assert.equal(n, 1, `锚点在源码里出现了 ${n} 次 —— 改坏可能改到注释上：${JSON.stringify(from)}`);
      out = out.replace(from, to);
    }
    assert.notEqual(out, src, "改坏的副本跟原文一模一样 —— 这条反向对照失效了");
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, path.basename(rel)), out, "utf8");
    for (const f of extraFiles || []) {
      fs.copyFileSync(path.join(REPO, f), path.join(dir, path.basename(f)));
    }
    return import(pathToFileURL(path.join(dir, path.basename(rel))).href);
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

  const REFRESH_DEPS = ["src/server/clients/model-facts.mjs", "src/server/clients/facts-sources.mjs"];

  test("⑩a refreshFacts「全都拉不到也写」⇒ ④a 会红", async () => {
    const mod = await mutant("src/server/clients/facts-refresh.mjs", [
      ["  if (!list.length) {", "  if (false) {   // SABOTAGE：拉不到也往下走"],
    ], REFRESH_DEPS);
    await mustGoRed(mod, async (m) => {
      const dir = tmpDir();
      const r = await m.refreshFacts({
        dataDir: dir,
        cfg: FAKE_CFG,
        collect: fakeCollect([], [{ provider: "wb", error: "模拟" }]),
      });
      assert.ok(!fs.existsSync(path.join(dir, MODEL_FACTS_FILE_NAME)),
        "一条都没拉到却把文件写了 —— 旧覆盖层被清空了");
    }, "拉不到也写之后，④a 竟然还过");
  });

  test("⑩b refreshFacts 的凭据守卫去掉 ⇒ ⑥a 会红", async () => {
    const mod = await mutant("src/server/clients/facts-refresh.mjs", [
      ["  const hit = findSecretIn(JSON.stringify(facts), secrets);", "  const hit = null;   // SABOTAGE：守卫去掉"],
    ], REFRESH_DEPS);
    await mustGoRed(mod, async (m) => {
      const dir = tmpDir();
      await m.refreshFacts({
        dataDir: dir,
        cfg: FAKE_CFG,
        collect: fakeCollect([{
          provider: "wb",
          entries: [{ id: "hy3", context: 192000, output: 64000 }],
          at: "2026-10-24T00:00:00.000Z",
          source: `https://www.workbuddy.cn/v3/config?token=${FAKE_TOKEN}`,
        }]),
      });
      const raw = fs.readFileSync(path.join(dir, MODEL_FACTS_FILE_NAME), "utf8");
      assert.ok(!raw.includes(FAKE_TOKEN), "令牌落进覆盖层了");
    }, "守卫去掉之后，⑥a 竟然还过");
  });

  test("⑩c resolveDataDir 不认 BAI_DATA_DIR ⇒ ①a 会红", async () => {
    const mod = await mutant("src/server/clients/facts-refresh.mjs", [
      ["  const fromEnv = String(env.BAI_DATA_DIR || \"\").trim();\n  if (fromEnv) return fromEnv;",
        "  const fromEnv = \"\";   // SABOTAGE：不认 BAI_DATA_DIR"],
    ], REFRESH_DEPS);
    await mustGoRed(mod, async (m) => {
      const d = m.resolveDataDir({
        env: { BAI_DATA_DIR: path.join(TMPROOT, "from-env"), APPDATA: path.join(TMPROOT, "appdata") },
        serverDir: tmpDir(),
      });
      assert.equal(d, path.join(TMPROOT, "from-env"), "没认 BAI_DATA_DIR");
    }, "不认 BAI_DATA_DIR 之后，①a 竟然还过");
  });

  test("⑩d describeFactLookup 的 nonDefault 判定改坏 ⇒ ⑧b 会红", async () => {
    const mod = await mutant("src/server/clients/model-facts.mjs", [
      ["    if (f.context !== CONVENTION_CONTEXT || f.output !== CONVENTION_OUTPUT) nonDefault++;",
        "    nonDefault++;   // SABOTAGE：约定值也算真值"],
    ]);
    await mustGoRed(mod, async (m) => {
      /* ⚠ 用一个**查得到但值是兜底**的 id（约定值）：改坏之后它会被算成真值。 */
      const r = m.describeFactLookup(CFG, [{ id: "bai/claude-fable-5" }]);
      assert.equal(r.nonDefault, 0, "约定值被算成了真值");
    }, "nonDefault 判定改坏之后，⑧b 竟然还过");
  });

  test("⑩e summarizeFactLookup 的兜底计数改坏 ⇒ ⑧d 会红", async () => {
    const mod = await mutant("src/server/clients/model-facts.mjs", [
      ["  const fallback = Number(s.fallback != null ? s.fallback : Math.max(0, total - real));",
        "  const fallback = 0;   // SABOTAGE：兜底条数不数了"],
    ]);
    await mustGoRed(mod, async (m) => {
      const r = m.describeFactLookup(CFG, [
        { id: "wb/claude-opus-5" },
        { id: "sn/claude-opus-5" },
        { id: "zz/claude-opus-5" },
      ]);
      const line = m.summarizeFactLookup(r);
      assert.ok(line.includes("2 条兜底"), `兜底条数没算出来：${line}`);
    }, "兜底计数改坏之后，⑧d 竟然还过");
  });
});
