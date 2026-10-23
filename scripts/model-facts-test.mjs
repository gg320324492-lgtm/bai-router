// scripts/model-facts-test.mjs —— **模型真值表**（阶段 1）+ **渠道目录作真源**（阶段 3）
//
// ## 这个测试钉住什么
//
//   · `src/server/clients/model-facts.mjs` —— 表（带来源与日期）+ 查询函数
//   · `src/server/clients/facts-sources.mjs` —— 渠道目录拉取 + 覆盖合并
//   · `src/server/clients/muse-models.mjs` —— 真值接进 Muse 的清单（兜底仍在）
//
// ## 与设计稿的关系
//
// `docs/client-wiring-deep-plan.md` §2.1（数据来源）与 §三 阶段 1 / 阶段 3。
//
// ## 反向对照（改了哪一处 ⇒ 哪条断言必须红）
//
// | 改动的地方                                          | 必须红的断言 |
// | --------------------------------------------------- | ------------ |
// | `publishable` 永远返回 true                          | ③d / ⑧c     |
// | `factsFor` / `limitsFor` 去掉 publishable 过滤        | ③d / ⑧c     |
// | `mergeCatalogFacts` 不覆盖已有条目                    | ⑤a          |
// | `mergeCatalogFacts` 不按渠道前缀隔离                  | ⑥a          |
// | `mergeCatalogFacts` 不更新日期戳                      | ⑤b          |
// | `fetchWbCatalog` 把空目录当成功                       | ④c          |
// | `fetchWbCatalog` 的错误消息回显令牌                   | ⑦a          |
// | `readQdCatalog` 把读不到文件当成功                    | ④e          |
// | `muse-models` 的 `opts.facts` 分支不生效              | ⑧a          |
// | `muse-models` 的 `opts.facts` 被 `opts.limits` 盖掉   | ⑧b          |
// | 兜底常量与 magpie 的 museContext/museOutput 不一致    | ②           |
// | `windowOf` 不把过小的值当「不知道」                   | ①e          |
// | 运行时覆盖层不生效                                    | ⑫a          |
// | `loadFacts` 把坏文件当空表                            | ⑬c          |
//
// ⚠ 反向对照**真的跑红**才算数（做法照 `scripts/clients-base-test.mjs` 的 ⑥：
//   把源码复制到临时目录 → 在**副本**上改坏 → import 副本 → 跑判据 ⇒ 必须抛）。
//   ⚠ 改的是副本，仓库源码一个字不动。
//
// ## 红线
//
// 🔴 落盘只在 os.tmpdir() 下的临时目录 —— **绝不碰真实的用户 home**。
// 🔴 全文没有一个真实令牌（夹具里的凭据形态串是明显假的占位串）。

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MODEL_FACTS, OUTLET_TIERS, OUTLET_TIERS_AT,
  CONVENTION_CONTEXT, CONVENTION_OUTPUT, LEAST_WINDOW,
  factFor, factForTier, factForId, factsFor, factsForEntries, describeFactLookup,
  limitsFor, describeFact, publishable,
  windowOf, resolveTarget, factRows,
} from "../src/server/clients/model-facts.mjs";
import {
  fetchWbCatalog, readQdCatalog, mergeCatalogFacts, collectCatalogs, DEFAULT_TIMEOUT_MS,
  loadFacts, saveFacts,
} from "../src/server/clients/facts-sources.mjs";
import {
  buildMuseModels, describeMuseLimits,
  MUSE_CONTEXT_FALLBACK, MUSE_OUTPUT_FALLBACK,
} from "../src/server/clients/muse-models.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-model-facts-"));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

let seq = 0;
function tmpDir() {
  const d = path.join(TMPROOT, `t${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/* 出厂档位（照 config.defaults.json 的 mapping 抄一份，测试不读那个文件
   —— 它是「出厂快照」，测试要钉的是**表**与**快照**对得上）。 */
const CFG = {
  mapping: {
    "claude-fable-5": { target: "qwen3.8-flash", label: "Qwen3.8-Flash" },
    "claude-sonnet-5": { target: "hy3", label: "HY3" },
    "claude-opus-5": { target: "hy3", label: "HY3" },
    "claude-haiku-4-5": { target: "mimo-v2.5", label: "MiMo-V2.5" },
  },
  sn: {
    mapping: {
      "claude-fable-5": { target: "sensenova-6.8-flash-lite", label: "SenseNova-6.8-Flash-Lite" },
      "claude-sonnet-5": { target: "deepseek-v4-flash", label: "DeepSeek-V4-Flash" },
      "claude-opus-5": { target: "glm-5.2", label: "GLM-5.2" },
      "claude-haiku-4-5": { target: "kimi-k3", label: "Kimi-K3" },
    },
  },
  wb: {
    mapping: {
      "claude-fable-5": { target: "deepseek-v4.1-flash", label: "DeepSeek-V4.1-Flash" },
      "claude-sonnet-5": { target: "hy4-preview-f", label: "Hy4-Preview-F" },
      "claude-opus-5": { target: "hy3", label: "HY3" },
      "claude-haiku-4-5": { target: "deepseek-v4.1-flash", label: "DeepSeek-V4.1-Flash" },
    },
  },
  wbai: {
    mapping: {
      "claude-fable-5": { target: "deepseek-v4.1-flash", label: "DeepSeek-V4.1-Flash" },
      "claude-sonnet-5": { target: "hy4-preview-f", label: "Hy4-Preview-F" },
      "claude-opus-5": { target: "hy3", label: "HY3" },
      "claude-haiku-4-5": { target: "deepseek-v4.1-flash", label: "DeepSeek-V4.1-Flash" },
    },
  },
  zen: { mapping: { "claude-opus-5": { target: "space-bunny-free", label: "Space-Bunny-Free" } } },
  qd: { mapping: { "claude-opus-5": { target: "lite", label: "Qoder Lite" } } },
  mm: { mapping: { "claude-opus-5": { target: "MiniMax-M3.1-Flash", label: "MiniMax-M3.1-Flash" } } },
  or: { mapping: { "claude-opus-5": { target: "openrouter/free", label: "OpenRouter Free" } } },
};

/* ============================================================================
 * **渠道目录实测快照**（2026-10-23，本机实测）
 *
 * 这是 wb / wbai 的 `/v3/config` **原始响应**里的模型 id 与它们的窗口/输出上限。
 * ⚠ 它有两处用处：
 *   ① 当「某个模型 id 在两家目录里都出现过吗」这件事的**客观判据** ——
 *      「两家一致」这条规则必须是可机械核对的，不能靠人眼。
 *   ② 当表里的值与目录**对得上吗**的对照。
 *
 * ⚠ **快照会过期**（上游改窗口）⇒ 表也得跟着改 ⇒ 那时这条测试会红 ——
 *   **那是正确的提醒**（设计稿 §2.1：「上游改窗口时表会过时 ⇒ 由渠道目录优先
 *   + 日期戳可见兜住」）。重测后更新这里与 `model-facts.mjs` 的表。
 *
 * ⚠ 值写成 0 = 目录里那条**没有**可信的窗口值（上游没给）。
 * ========================================================================== */
const WB_SNAPSHOT = {
  "default": [200000, 24000],
  "deepseek-v4-pro": [1000000, 128000],
  "deepseek-v4-flash": [1000000, 50000],
  "deepseek-v4.1-flash": [1000000, 128000],
  "deepseek-v3-2-volc": [96000, 32000],
  "minimax-m2.5": [200000, 48000],
  "minimax-m3": [512000, 64000],
  "minimax-m2.7": [200000, 48000],
  "glm-5.3": [1000000, 64000],
  "glm-5.3-flash": [1000000, 131072],
  "glm-5.2": [1000000, 64000],
  "glm-5.1": [200000, 48000],
  "glm-5.0": [200000, 48000],
  "glm-5.0-turbo": [200000, 48000],
  "glm-5v-turbo": [200000, 64000],
  "glm-4.7": [200000, 48000],
  "glm-4.6": [168000, 32000],
  "glm-4.6v": [128000, 32000],
  "kimi-k3-1": [1000000, 32000],
  "kimi-k2.8-preview": [1000000, 64000],
  "kimi-k2.7": [256000, 32000],
  "kimi-k2.6": [256000, 32000],
  "kimi-k2.5": [164000, 32000],
  "kimi-k2-thinking": [164000, 32000],
  "hy3": [192000, 64000],
  "hy3-x": [192000, 64000],
  "hy4-preview": [960000, 64000],
  "hy4-preview-x": [960000, 64000],
  "hunyuan-chat": [200000, 8192],
  "hunyuan-image-alpha": [0, 0],
  "hunyuan-image-alpha-edit": [0, 0],
  "space-bunny": [1000000, 128000],
  "step-5-preview": [1000000, 64000],
  "mimo-v2.6-pro": [1000000, 128000],
  "minimax-m3.1-flash": [1000000, 128000],
};
const WBAI_SNAPSHOT = {
  "default-model": [176000, 24000],
  "fast-model": [200000, 32000],
  "balanced-model": [256000, 32000],
  "primary-model": [272000, 72000],
  "deep-model": [176000, 24000],
  "deepseek-v4.1-flash": [1000000, 128000],
  "deepseek-v4.1-flash-sg": [1000000, 128000],
  "hy4-preview": [1000000, 64000],
  "hy3": [192000, 64000],
  "kimi-k2.8-preview": [1000000, 32000],
  "gpt-5.6-terra": [1000000, 128000],
  "gpt-5.6-luna": [1000000, 128000],
  "gpt-5.5": [1000000, 128000],
  "gpt-5.4": [272000, 72000],
  "gemini-3.5-flash": [1000000, 65536],
  "glm-5.3-flash": [1000000, 32000],
  "glm-5.3": [1000000, 48000],
  "glm-5.2": [1000000, 48000],
  "minimax-m3.1-flash": [1000000, 128000],
  "kimi-k3": [1000000, 32000],
  "kimi-k2.6": [256000, 32000],
  "gpt-6-astra": [1000000, 128000],
  "gpt-5.6-sol": [1000000, 128000],
  "grok-4.7": [1000000, 128000],
  "gemini-3.8-flash": [1000000, 128000],
  "gpt-6-sol": [1000000, 128000],
  "gpt-6-luna": [1000000, 128000],
  "gpt-6.1-sol": [1000000, 128000],
  "step-5-preview": [1000000, 64000],
};

/* ====================================================================== *
 * ① 表本身：形状、来源、日期、覆盖
 * ====================================================================== */
describe("① 真值表：每条都带来源与日期，且覆盖所有出厂档位", () => {
  test("①a 每条都有 kind / source / at，数值是正数", () => {
    for (const [key, f] of Object.entries(MODEL_FACTS)) {
      assert.ok(f && typeof f === "object", `${key} 不是对象`);
      assert.ok(["measured", "measured-elsewhere", "shared", "convention"].includes(f.kind),
        `${key} 的 kind 必须是四档之一，实际是 ${JSON.stringify(f.kind)}`);
      assert.ok(String(f.source || "").trim(), `${key} 缺来源 —— 「不知道」也得说清是不知道`);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(String(f.at || "")), `${key} 的日期戳格式不对：${f.at}`);
      assert.ok(Number.isFinite(f.context) && f.context > 0, `${key} 的 context 不该是 0 或非数`);
      assert.ok(Number.isFinite(f.output) && f.output > 0, `${key} 的 output 不该是 0 或非数`);
    }
  });

  test("①b 每个出厂档位都能查到一条事实（接线时不会有档位落到表外）", () => {
    for (const [provider, tiers] of Object.entries(OUTLET_TIERS)) {
      for (const tier of Object.keys(tiers)) {
        const f = factForTier(provider, tier);
        assert.ok(f, `${provider}/${tier} 查不到事实 —— 表少了一条`);
        assert.ok(f.context > 0 && f.output > 0, `${provider}/${tier} 的数值不对`);
      }
    }
  });

  test("①c 表的键都合法（provider 在名录里、查得到、数值有效）", () => {
    for (const key of Object.keys(MODEL_FACTS)) {
      const i = key.indexOf("/");
      assert.ok(i > 0, `键的形状不对（要 provider/模型名）：${key}`);
      const provider = key.slice(0, i);
      const target = key.slice(i + 1);
      assert.ok(OUTLET_TIERS[provider], `${key} 的渠道不在名录里`);
      const f = factFor(provider, target);
      assert.ok(f, `${key} 查不到自己`);
      assert.ok(f.context > 0 && f.output > 0, `${key} 的数值无效`);
    }
  });

  test("①c-2 出厂配置里用到的每个模型，表里都有（表覆盖出厂配置）", () => {
    for (const [provider, tiers] of Object.entries(OUTLET_TIERS)) {
      for (const target of new Set(Object.values(tiers))) {
        assert.ok(factFor(provider, target), `表里少了 ${provider}/${target} —— 出厂配置用到它`);
      }
    }
  });

  test("①c-3 表覆盖渠道目录里有的模型（渠道目录是活的）", () => {
    /* 实测 2026-10-23：wb 与 wbai 的目录里都有 step-5-preview，wbai 还有
       hy4-preview —— 用户把档位指向它们时，表里得有。 */
    for (const key of ["wb/step-5-preview", "wbai/step-5-preview", "wbai/hy4-preview"]) {
      assert.ok(factFor(key.split("/")[0], key.split("/")[1]), `表里少了 ${key}`);
    }
  });

  test("①d 表是只读的（改不动）", () => {
    assert.throws(() => { MODEL_FACTS["wb/hy3"] = null; }, "表被改动了");
    assert.ok(MODEL_FACTS["wb/hy3"], "表被改坏了");
  });

  test("①e windowOf：过小的值当「不知道」（magpie 的 LeastWindow 纪律）", () => {
    assert.equal(windowOf(0), 0);
    assert.equal(windowOf(-1), 0);
    assert.equal(windowOf("abc"), 0);
    assert.equal(windowOf(2047), 0, "比最小可信窗口还小 ⇒ 当不知道");
    assert.equal(windowOf(2048), 2048);
    assert.equal(windowOf(192000), 192000);
    assert.equal(windowOf(192000.7), 192001, "要取整");
  });

  test("①f factRows 能列出全部条目（面板上要列）", () => {
    const rows = factRows();
    assert.equal(rows.length, Object.keys(MODEL_FACTS).length);
    assert.ok(rows.every((r) => r.key && r.provider && r.target && r.fact));
  });
});

/* ====================================================================== *
 * ② 兜底值：与 magpie 的 museContext / museOutput 同一对数
 * ====================================================================== */
describe("② 兜底值与 magpie 一致（internal/gateway/muse.go:12-15）", () => {
  test("②a 本仓的兜底常量与 magpie 抄来的那对数相等", () => {
    assert.equal(MUSE_CONTEXT_FALLBACK, 128000);
    assert.equal(MUSE_OUTPUT_FALLBACK, 32000);
    assert.equal(CONVENTION_CONTEXT, MUSE_CONTEXT_FALLBACK, "约定值与兜底值必须是同一对数");
    assert.equal(CONVENTION_OUTPUT, MUSE_OUTPUT_FALLBACK, "约定值与兜底值必须是同一对数");
  });

  test("②b 表里 kind=convention 的条目，值就是兜底值", () => {
    for (const [key, f] of Object.entries(MODEL_FACTS)) {
      if (f.kind !== "convention") continue;
      assert.equal(f.context, CONVENTION_CONTEXT, `${key} 的约定值与兜底不一致`);
      assert.equal(f.output, CONVENTION_OUTPUT, `${key} 的约定值与兜底不一致`);
    }
  });

  test("②c 兜底值不许超过窗口", () => {
    assert.ok(MUSE_OUTPUT_FALLBACK <= MUSE_CONTEXT_FALLBACK);
  });
});

/* ====================================================================== *
 * ③ 三档 kind：只有 measured 能下发
 * ====================================================================== */
describe("③ kind 的三档：只有「本渠道自己测过的」能发给客户端", () => {
  test("③a 表里四档都有（不是只有一档）", () => {
    const kinds = new Set(Object.values(MODEL_FACTS).map((f) => f.kind));
    assert.ok(kinds.has("measured"), "表里没有 measured 的条目");
    assert.ok(kinds.has("measured-elsewhere"), "表里没有 measured-elsewhere 的条目");
    assert.ok(kinds.has("shared"), "表里没有 shared 的条目");
    assert.ok(kinds.has("convention"), "表里没有 convention 的条目");
  });

  test("③b measured / measured-elsewhere 的条目必须写清是哪家渠道的目录", () => {
    for (const [key, f] of Object.entries(MODEL_FACTS)) {
      if (f.kind !== "measured" && f.kind !== "measured-elsewhere") continue;
      assert.ok(/\/v3\/config|qoder-models\.json/.test(f.source),
        `${key} 是实测值，来源却不像渠道目录接口：${f.source}`);
    }
  });

  test("③b-2 measured-elsewhere 必须写明「非本家目录」（不能冒充本家真值）", () => {
    for (const [key, f] of Object.entries(MODEL_FACTS)) {
      if (f.kind !== "measured-elsewhere") continue;
      assert.ok(f.source.includes("非本家"), `${key} 的来源没写明「非本家目录」：${f.source}`);
      assert.ok(/两家/.test(f.source), `${key} 的来源没写明「两家一致」：${f.source}`);
    }
  });

  test("③b-3 measured-elsewhere 是可下发的（两家一致 ⇒ 证据够强）", () => {
    for (const [key, f] of Object.entries(MODEL_FACTS)) {
      if (f.kind !== "measured-elsewhere") continue;
      assert.equal(publishable(f), true, `${key} 是两家实测一致的，却没被当成可下发`);
    }
  });

  test("③b-4 「两家一致」必须机械可核对：同一个模型 id + 两家同值", () => {
    /* ⚠ 这是整条规则的**客观判据**（照 2026-10-23 的拍板：名字不同的不算）。
     *   用真实实测目录快照核对 —— 不能靠人眼。 */
    for (const [key, f] of Object.entries(MODEL_FACTS)) {
      if (f.kind !== "measured-elsewhere") continue;
      const wb = WB_SNAPSHOT[f.sourceId];
      const wbai = WBAI_SNAPSHOT[f.sourceId];
      assert.ok(wb, `${key} 的 sourceId「${f.sourceId}」wb 目录里没有 ⇒ 不是两家的共同模型`);
      assert.ok(wbai, `${key} 的 sourceId「${f.sourceId}」wbai 目录里没有 ⇒ 不是两家的共同模型`);
      assert.equal(wb[0], wbai[0], `${key}：两家对同一模型给的窗口不一样 ⇒ 不是「一致」`);
      assert.equal(wb[1], wbai[1], `${key}：两家对同一模型给的输出上限不一样 ⇒ 不是「一致」`);
      assert.equal(f.context, wb[0], `${key} 的窗口与快照对不上`);
      assert.equal(f.output, wb[1], `${key} 的输出上限与快照对不上`);
    }
  });

  test("③b-5 名字不同的两个模型不算「两家一致」（kimi-k3 vs kimi-k3-1）", () => {
    /* wbai 目录里叫 kimi-k3，wb 目录里叫 kimi-k3-1 —— **两个不同的模型**，
       数值撞了是巧合（同厂商相邻版本常同窗口），不是「一个模型被测了两次」。 */
    assert.equal(WB_SNAPSHOT["kimi-k3"], undefined, "wb 目录里居然有 kimi-k3");
    assert.ok(WBAI_SNAPSHOT["kimi-k3"], "wbai 目录里没有 kimi-k3");
    assert.equal(WB_SNAPSHOT["kimi-k3-1"][0], WBAI_SNAPSHOT["kimi-k3"][0], "两个模型的窗口应当相同（这正是陷阱）");

    const f = MODEL_FACTS["sn/kimi-k3"];
    assert.equal(f.kind, "shared", "kimi-k3 被当成了「两家一致」");
    assert.equal(publishable(f), false, "kimi-k3 不该被下发");
    const facts = factsFor(CFG, ["sn/claude-haiku-4-5"]);
    assert.ok(!facts["sn/claude-haiku-4-5"], "kimi-k3 的值被发出去了");
  });

  test("③b-6 同一个模型但两家值不同 ⇒ 也不算「两家一致」（hy4-preview）", () => {
    assert.equal(WB_SNAPSHOT["hy4-preview"][0], 960000);
    assert.equal(WBAI_SNAPSHOT["hy4-preview"][0], 1000000);
    /* wb/hy4-preview-f 是**本家实测**（kind=measured）⇒ 照发；
       但它**不是** measured-elsewhere（两家同值）。 */
    assert.equal(MODEL_FACTS["wb/hy4-preview-f"].kind, "measured");
    assert.equal(MODEL_FACTS["wbai/hy4-preview"].kind, "measured");
  });

  test("③c publishable：shared 不算可下发", () => {
    const shared = Object.entries(MODEL_FACTS).filter(([, f]) => f.kind === "shared");
    assert.ok(shared.length, "表里没有 shared 的条目 —— 这档没被用上");
    for (const [key, f] of shared) {
      assert.equal(publishable(f), false, `${key} 是 shared（别家渠道的值），不能下发`);
    }
  });

  test("③d factsFor / limitsFor 不给 shared（报大比报小危险）", () => {
    /* sn 的 glm-5.2 是 shared（wb 目录说 100 万，sn 自己没说）。 */
    const facts = factsFor(CFG, ["sn/claude-opus-5"]);
    assert.ok(!facts["sn/claude-opus-5"], "shared 的条目不该出现在 factsFor 的结果里");
    const limits = limitsFor(CFG, ["sn/claude-opus-5"]);
    assert.ok(!limits["sn/claude-opus-5"], "shared 的条目不该出现在 limitsFor 的结果里");
  });

  test("③e measured 的条目能被 factsFor 查到，且值与表一致", () => {
    const facts = factsFor(CFG, ["wb/claude-opus-5"]);
    const f = facts["wb/claude-opus-5"];
    assert.ok(f, "wb 的 opus 档位查不到事实");
    assert.equal(f.kind, "measured");
    assert.equal(f.context, MODEL_FACTS["wb/hy3"].context);
    assert.equal(f.output, MODEL_FACTS["wb/hy3"].output);
    assert.ok(f.at, "事实必须带日期戳");
    assert.ok(f.source, "事实必须带来源");
  });

  test("③f 查不到的 id 就不给（绝不填兜底值混进真值里）", () => {
    const facts = factsFor(CFG, ["xx/claude-opus-5", "wb/不存在的档位"]);
    assert.deepEqual(facts, {}, "查不到的不该出现");
  });
});

/* ====================================================================== *
 * ④ 渠道目录拉取：失败安静、空目录算失败、凭据不外泄
 * ====================================================================== */
describe("④ 渠道目录拉取（wb /v3/config 与 qd 的 qoder-models.json）", () => {
  /** 假 fetch：回一个固定应答。 */
  function fakeFetch(status, body, isText) {
    return async () => ({
      status,
      text: async () => (isText ? body : JSON.stringify(body)),
    });
  }

  test("④a wb：拿到目录就解析出窗口与输出上限（驼峰字段）", async () => {
    const r = await fetchWbCatalog({
      upstream: "https://www.workbuddy.cn",
      token: "sk-fake-not-a-real-token",
      at: "2026-10-23T00:00:00.000Z",
      fetchImpl: fakeFetch(200, {
        code: 0,
        data: { models: [
          { id: "hy3", maxInputTokens: 192000, maxOutputTokens: 64000 },
          { id: "hy4-preview", maxInputTokens: 960000, maxOutputTokens: 64000 },
        ] },
      }),
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.entries.length, 2);
    assert.deepEqual(r.entries[0], { id: "hy3", context: 192000, output: 64000 });
    assert.equal(r.entries[1].context, 960000);
    assert.equal(r.at, "2026-10-23T00:00:00.000Z");
  });

  test("④b wb：拉不到就安静地失败（不抛）", async () => {
    const r = await fetchWbCatalog({
      upstream: "https://www.workbuddy.cn",
      token: "sk-fake-not-a-real-token",
      fetchImpl: async () => { throw new Error("network down"); },
    });
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.equal(r.entries, undefined, "失败时不该有 entries");
  });

  test("④c wb：空目录算失败（成功码配空数据 —— 上游的空目录陷阱）", async () => {
    const r = await fetchWbCatalog({
      upstream: "https://www.workbuddy.cn",
      token: "sk-fake-not-a-real-token",
      fetchImpl: fakeFetch(200, { code: 0, data: { models: null } }),
    });
    assert.equal(r.ok, false, "空目录被当成了成功");
    assert.ok(r.error);
  });

  test("④d wb：上游自己的 code 报错也算失败（UA 不对就是 12403）", async () => {
    const r = await fetchWbCatalog({
      upstream: "https://www.workbuddy.cn",
      token: "sk-fake-not-a-real-token",
      fetchImpl: fakeFetch(200, { code: 12403, msg: "check ua" }),
    });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("12403") || r.error.includes("check ua"), r.error);
  });

  test("④e qd：读本地目录（蛇形字段，没有输出上限）", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "qoder-models.json");
    fs.writeFileSync(file, JSON.stringify({
      app: [
        { key: "auto", max_input_tokens: 200000 },
        { key: "ultimate", max_input_tokens: 1000000 },
      ],
    }), "utf8");
    const r = await readQdCatalog({ file, at: "2026-10-23T00:00:00.000Z" });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.entries.length, 2);
    assert.deepEqual(r.entries[0], { id: "auto", context: 200000, output: 0 });
    assert.equal(r.entries[0].output, 0, "Qoder 目录没有输出上限 ⇒ 0 = 不知道");
  });

  test("④f qd：文件读不到就安静地失败", async () => {
    const r = await readQdCatalog({ file: path.join(tmpDir(), "没有这个文件.json") });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  test("④g qd：形状不对（没有 app[]）也当失败", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "qoder-models.json");
    fs.writeFileSync(file, JSON.stringify({ chat: [] }), "utf8");
    const r = await readQdCatalog({ file });
    assert.equal(r.ok, false);
  });

  test("④h 拉取有超时（不许卡住关键路径）", () => {
    assert.ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 30000,
      "超时时间要么没设，要么太长（拉取是辅助，不该让人等）");
  });
});

/* ====================================================================== *
 * ⑤ 覆盖合并：拉得到就覆盖表里的值并更新日期戳
 * ====================================================================== */
describe("⑤ 渠道目录覆盖事实表（并更新日期戳）", () => {
  const BASE = {
    "wb/hy3": {
      context: 1, output: 2, kind: "measured",
      source: "旧来源", sourceId: "hy3", at: "2020-01-01", note: "",
    },
  };

  test("⑤a 拉到的值覆盖表里的值", () => {
    const out = mergeCatalogFacts(BASE, {
      provider: "wb",
      entries: [{ id: "hy3", context: 192000, output: 64000 }],
      at: "2026-10-23T06:38:47.966Z",
      source: "https://www.workbuddy.cn/v3/config",
    });
    assert.equal(out["wb/hy3"].context, 192000);
    assert.equal(out["wb/hy3"].output, 64000);
    assert.equal(out["wb/hy3"].kind, "measured");
  });

  test("⑤b 覆盖时更新日期戳与来源", () => {
    const out = mergeCatalogFacts(BASE, {
      provider: "wb",
      entries: [{ id: "hy3", context: 192000, output: 64000 }],
      at: "2026-10-23T06:38:47.966Z",
      source: "https://www.workbuddy.cn/v3/config",
    });
    assert.equal(out["wb/hy3"].at, "2026-10-23T06:38:47.966Z", "日期戳没更新");
    assert.ok(out["wb/hy3"].source.includes("/v3/config"), "来源没更新");
  });

  test("⑤c 合并是纯函数（不改传进来的表）", () => {
    const before = JSON.stringify(BASE);
    mergeCatalogFacts(BASE, {
      provider: "wb",
      entries: [{ id: "hy3", context: 192000, output: 64000 }],
      at: "2026-10-23T00:00:00.000Z",
      source: "x",
    });
    assert.equal(JSON.stringify(BASE), before, "传进来的表被改了");
  });

  test("⑤d 归一靠 sourceId 对上号（目录叫 hy4-preview，我们叫 hy4-preview-f）", () => {
    const base = {
      "wb/hy4-preview-f": {
        context: 1, output: 2, kind: "measured",
        source: "旧", sourceId: "hy4-preview", at: "2020-01-01", note: "",
      },
    };
    const out = mergeCatalogFacts(base, {
      provider: "wb",
      entries: [{ id: "hy4-preview", context: 960000, output: 64000 }],
      at: "2026-10-23T00:00:00.000Z",
      source: "wb /v3/config",
    });
    assert.equal(out["wb/hy4-preview-f"].context, 960000, "没对上号");
    assert.ok(!out["wb/hy4-preview"], "不该多出一条重复的条目");
  });

  test("⑤e 表里没有的模型，目录里有的会新增一条（measured）", () => {
    const out = mergeCatalogFacts({}, {
      provider: "wb",
      entries: [{ id: "glm-5.3", context: 1000000, output: 64000 }],
      at: "2026-10-23T00:00:00.000Z",
      source: "wb /v3/config",
    });
    assert.ok(out["wb/glm-5.3"], "目录里的新模型没进表");
    assert.equal(out["wb/glm-5.3"].kind, "measured");
  });

  test("⑤f 目录里没有的模型留在表里不动（拉取是补充，不是清仓）", () => {
    const base = {
      "wb/qd-lite-ish": {
        context: 5, output: 6, kind: "convention",
        source: "约定", sourceId: "", at: "2020-01-01", note: "",
      },
    };
    const out = mergeCatalogFacts(base, {
      provider: "wb",
      entries: [{ id: "hy3", context: 192000, output: 64000 }],
      at: "2026-10-23T00:00:00.000Z",
      source: "wb /v3/config",
    });
    assert.ok(out["wb/qd-lite-ish"], "表里的条目被清掉了");
    assert.equal(out["wb/qd-lite-ish"].context, 5);
  });

  test("⑤g 同一个模型的两个键都要更新（hy4-preview 与 hy4-preview-f）", () => {
    const base = {
      "wbai/hy4-preview": {
        context: 1, output: 2, kind: "measured", source: "旧", sourceId: "hy4-preview", at: "2020-01-01", note: "",
      },
      "wbai/hy4-preview-f": {
        context: 3, output: 4, kind: "measured", source: "旧", sourceId: "hy4-preview", at: "2020-01-01", note: "",
      },
    };
    const out = mergeCatalogFacts(base, {
      provider: "wbai",
      entries: [{ id: "hy4-preview", context: 1000000, output: 64000 }],
      at: "2026-10-23T00:00:00.000Z",
      source: "wbai /v3/config",
    });
    assert.equal(out["wbai/hy4-preview"].context, 1000000, "不带后缀的那个键没更新");
    assert.equal(out["wbai/hy4-preview-f"].context, 1000000, "带后缀的那个键没更新");
  });
});

/* ====================================================================== *
 * ⑥ 渠道之间不串号
 * ====================================================================== */
describe("⑥ 渠道之间不串号（同一个模型在不同渠道的值不一样）", () => {
  test("⑥a 覆盖只看同一个渠道的条目", () => {
    const base = {
      "wb/hy3": {
        context: 192000, output: 64000, kind: "measured",
        source: "wb /v3/config", sourceId: "hy3", at: "2026-10-23", note: "",
      },
      "wbai/hy3": {
        context: 192000, output: 64000, kind: "measured",
        source: "wbai /v3/config", sourceId: "hy3", at: "2026-10-23", note: "",
      },
    };
    const out = mergeCatalogFacts(base, {
      provider: "wbai",
      entries: [{ id: "hy3", context: 1000000, output: 64000 }],
      at: "2026-10-24T00:00:00.000Z",
      source: "wbai /v3/config",
    });
    assert.equal(out["wbai/hy3"].context, 1000000, "wbai 的值没被覆盖");
    assert.equal(out["wb/hy3"].context, 192000, "wb 的值被别家覆盖了 —— 串号了");
  });

  test("⑥b 表里同一个模型在不同渠道确实是两条", () => {
    assert.ok(MODEL_FACTS["wb/hy4-preview-f"], "wb/hy4-preview-f 不在表里");
    assert.ok(MODEL_FACTS["wbai/hy4-preview-f"], "wbai/hy4-preview-f 不在表里");
    assert.notEqual(
      MODEL_FACTS["wb/hy4-preview-f"].context,
      MODEL_FACTS["wbai/hy4-preview-f"].context,
      "两个渠道对同一模型的说法应当不同（实测就是不同）",
    );
  });
});

/* ====================================================================== *
 * ⑦ 凭据不外泄
 * ====================================================================== */
describe("⑦ 凭据不进任何返回值", () => {
  test("⑦a 失败时的消息里没有令牌", async () => {
    const fake = "sk-fake-000000-not-a-real-token";
    const r = await fetchWbCatalog({
      upstream: "https://www.workbuddy.cn",
      token: fake,
      fetchImpl: async () => ({ status: 401, text: async () => JSON.stringify({ code: 401, msg: "unauthorized" }) }),
    });
    assert.equal(r.ok, false);
    assert.equal(JSON.stringify(r).includes(fake), false, "令牌漏进了返回值");
  });

  test("⑦b 表与模块里没有凭据形态的串", () => {
    const s = JSON.stringify(MODEL_FACTS);
    assert.equal(/sk-[A-Za-z0-9]{8,}/.test(s), false, "表里有像令牌的东西");
    assert.equal(/Bearer\s+[A-Za-z0-9._-]{8,}/.test(s), false, "表里有像 Authorization 头的东西");
  });
});

/* ====================================================================== *
 * ⑧ 真值接进 Muse 的清单（兜底仍在）
 * ====================================================================== */
describe("⑧ 真值接进 Muse（muse-models.mjs）", () => {
  const ENTRIES = [
    { id: "wb/claude-opus-5", ownedBy: "wb", displayName: "HY3" },
    { id: "sn/claude-opus-5", ownedBy: "sn", displayName: "GLM-5.2" },
  ];

  test("⑧a opts.facts 里的真值进了 limit", () => {
    const payload = buildMuseModels(ENTRIES, {
      facts: {
        "wb/claude-opus-5": {
          context: 192000, output: 64000, kind: "measured",
          source: "wb /v3/config", at: "2026-10-23",
        },
      },
    });
    const lim = payload.data[0].metadata["muse-code"].limit;
    assert.equal(lim.context, 192000);
    assert.equal(lim.output, 64000);
    /* 没给的那一行仍是兜底。 */
    const lim2 = payload.data[1].metadata["muse-code"].limit;
    assert.equal(lim2.context, MUSE_CONTEXT_FALLBACK);
    assert.equal(lim2.output, MUSE_OUTPUT_FALLBACK);
  });

  test("⑧b opts.limits 优先于 opts.facts", () => {
    const payload = buildMuseModels(ENTRIES, {
      limits: { "wb/claude-opus-5": { context: 200000, output: 32000 } },
      facts: {
        "wb/claude-opus-5": {
          context: 192000, output: 64000, kind: "measured",
          source: "wb /v3/config", at: "2026-10-23",
        },
      },
    });
    const lim = payload.data[0].metadata["muse-code"].limit;
    assert.equal(lim.context, 200000, "limits 应当优先");
    assert.equal(lim.output, 32000);
  });

  test("⑧c shared 的事实不下发（走兜底）", () => {
    const payload = buildMuseModels(ENTRIES, {
      facts: {
        "sn/claude-opus-5": {
          context: 1000000, output: 64000, kind: "shared",
          source: "wb /v3/config（同一模型）", at: "2026-10-23",
        },
      },
    });
    const lim = payload.data[1].metadata["muse-code"].limit;
    assert.equal(lim.context, MUSE_CONTEXT_FALLBACK, "shared 的值被发出去了");
    assert.equal(lim.output, MUSE_OUTPUT_FALLBACK);
  });

  test("⑧f measured-elsewhere（两家实测一致）照发，标注写明非本家", () => {
    const payload = buildMuseModels([{ id: "bai/claude-opus-5" }], {
      facts: {
        "bai/claude-opus-5": {
          context: 192000, output: 64000, kind: "measured-elsewhere",
          source: "wb /v3/config 与 wbai /v3/config（两家目录实测一致，非本家目录）", at: "2026-10-23",
        },
      },
    });
    const lim = payload.data[0].metadata["muse-code"].limit;
    assert.equal(lim.context, 192000, "两家一致的值没发出去");
    assert.equal(lim.output, 64000);
    const d = describeMuseLimits([{ id: "bai/claude-opus-5" }], {
      facts: {
        "bai/claude-opus-5": {
          context: 192000, output: 64000, kind: "measured-elsewhere",
          source: "wb /v3/config 与 wbai /v3/config（两家目录实测一致，非本家目录）", at: "2026-10-23",
        },
      },
    });
    assert.ok(d["bai/claude-opus-5"].includes("非本家"), d["bai/claude-opus-5"]);
    assert.ok(d["bai/claude-opus-5"].includes("两家"), d["bai/claude-opus-5"]);
    assert.ok(d["bai/claude-opus-5"].includes("2026-10-23"), d["bai/claude-opus-5"]);
  });

  test("⑧d limit 永远有两个正数（Muse 会隐藏缺一半的模型）", () => {
    const payload = buildMuseModels(ENTRIES);
    for (const d of payload.data) {
      const lim = d.metadata["muse-code"].limit;
      assert.ok(lim, "没有 limit 的模型会被 Muse 隐藏");
      assert.ok(lim.context > 0 && lim.output > 0, "limit 缺一半也会被隐藏");
    }
  });

  test("⑧e describeMuseLimits 说得出来源与日期（面板上要显示）", () => {
    const d = describeMuseLimits(ENTRIES, {
      facts: {
        "wb/claude-opus-5": {
          context: 192000, output: 64000, kind: "measured",
          source: "wb /v3/config", at: "2026-10-23",
        },
      },
    });
    assert.ok(d["wb/claude-opus-5"].includes("实测"), d["wb/claude-opus-5"]);
    assert.ok(d["wb/claude-opus-5"].includes("wb /v3/config"), d["wb/claude-opus-5"]);
    assert.ok(d["wb/claude-opus-5"].includes("2026-10-23"), d["wb/claude-opus-5"]);
    assert.ok(d["sn/claude-opus-5"].includes("兜底"), d["sn/claude-opus-5"]);
  });

  test("⑧f 描述**不进** Muse 的 JSON（形状逐字照 magpie）", () => {
    const payload = buildMuseModels(ENTRIES, {
      facts: {
        "wb/claude-opus-5": {
          context: 192000, output: 64000, kind: "measured",
          source: "wb /v3/config", at: "2026-10-23",
        },
      },
    });
    const meta = payload.data[0].metadata["muse-code"];
    assert.deepEqual(Object.keys(meta).sort(), [
      "description", "family", "is_hidden", "limit", "modalities", "name", "options", "tool_call", "variants",
    ], "Muse 的 metadata 形状变了 —— magpie 是逐字照的");
  });
});

/* ====================================================================== *
 * ⑨ 查询函数的两种路径
 * ====================================================================== */
describe("⑨ 查询：出厂快照路径与当前 cfg 路径", () => {
  test("⑨a factForTier 走出厂快照（静态）", () => {
    const f = factForTier("wb", "claude-opus-5");
    assert.ok(f);
    assert.equal(f.context, MODEL_FACTS["wb/hy3"].context);
  });

  test("⑨b factForId 走当前 cfg（权威）", () => {
    const f = factForId(CFG, "wb/claude-opus-5");
    assert.ok(f);
    assert.equal(f.context, MODEL_FACTS["wb/hy3"].context);
  });

  test("⑨c 用户改过档位映射 ⇒ 权威路径跟着变", () => {
    const changed = JSON.parse(JSON.stringify(CFG));
    changed.wb.mapping["claude-opus-5"].target = "deepseek-v4.1-flash";
    const f = factForId(changed, "wb/claude-opus-5");
    assert.ok(f);
    assert.equal(f.context, MODEL_FACTS["wb/deepseek-v4.1-flash"].context,
      "改过映射后，权威路径还按旧的答");
    assert.notEqual(f.context, MODEL_FACTS["wb/hy3"].context);
  });

  test("⑨d resolveTarget：bai 是扁平的（映射摊在 cfg 顶层）", () => {
    assert.equal(resolveTarget(CFG, "bai", "claude-opus-5"), "hy3");
    assert.equal(resolveTarget(CFG, "wb", "claude-opus-5"), "hy3");
    assert.equal(resolveTarget(CFG, "wb", "没有这一档"), "");
  });

  test("⑨e 出厂快照的日期戳与表一致", () => {
    assert.match(OUTLET_TIERS_AT, /^\d{4}-\d{2}-\d{2}$/);
    for (const f of Object.values(MODEL_FACTS)) {
      assert.equal(f.at, OUTLET_TIERS_AT, "表里的日期戳与快照不是一个批次");
    }
  });

  test("⑨f describeFact 说得清是实测还是约定", () => {
    assert.ok(describeFact(MODEL_FACTS["wb/hy3"]).includes("实测"));
    assert.ok(describeFact(MODEL_FACTS["qd/lite"]).includes("约定"));
    assert.ok(describeFact(MODEL_FACTS["sn/glm-5.2"]).includes("参考"));
    assert.equal(describeFact(null), "未知（没有真值）");
  });
});

/* ====================================================================== *
 * ⑩ collectCatalogs：一个渠道失败不影响别的
 * ====================================================================== */
describe("⑩ 一次拉全部：一个失败不影响其它", () => {
  test("⑩a wb 挂了就只有 qd 少，其余照常", async () => {
    const dir = tmpDir();
    const qdFile = path.join(dir, "qoder-models.json");
    fs.writeFileSync(qdFile, JSON.stringify({ app: [{ key: "auto", max_input_tokens: 200000 }] }), "utf8");
    const cfg = {
      wb: { upstream: "https://www.workbuddy.cn", accessToken: "sk-fake-not-real" },
      wbai: { upstream: "https://www.workbuddy.ai", accessToken: "sk-fake-not-real" },
      qd: { modelsFile: qdFile },
    };
    const r = await collectCatalogs({
      cfg,
      at: "2026-10-23T00:00:00.000Z",
      fetchImpl: async () => { throw new Error("network down"); },
    });
    assert.equal(r.errors.length, 2, "wb 与 wbai 都该报错");
    assert.ok(r.errors.some((e) => e.provider === "wb"));
    assert.ok(r.errors.some((e) => e.provider === "wbai"));
    const qd = r.catalogs.find((c) => c.provider === "qd");
    assert.ok(qd, "qd 的目录没进来 —— 一个渠道失败把别的也带走了");
    assert.equal(qd.entries.length, 1);
  });

  test("⑩b 全挂时返回空表而不是抛（拉取不许阻塞关键路径）", async () => {
    const r = await collectCatalogs({
      cfg: { wb: { upstream: "", accessToken: "" }, wbai: { upstream: "", accessToken: "" }, qd: {} },
      fetchImpl: async () => { throw new Error("network down"); },
    });
    assert.equal(r.catalogs.length, 0);
    assert.equal(r.errors.length, 3);
  });
});

/* ====================================================================== *
 * ⑫-0 便利与诊断：给「接线时核对」用的两个出口
 * ====================================================================== */
describe("⑫-0 便利函数与诊断函数（接线核对用）", () => {
  const ENTRIES = [
    { id: "wb/claude-opus-5", ownedBy: "wb", displayName: "HY3" },
    { id: "sn/claude-opus-5", ownedBy: "sn", displayName: "GLM-5.2" },
  ];

  test("⑫-0a factsForEntries 与 factsFor 等价（少写一次 map）", () => {
    const a = factsForEntries(CFG, ENTRIES);
    const b = factsFor(CFG, ENTRIES.map((e) => e.id));
    assert.deepEqual(a, b);
  });

  test("⑫-0b factsForEntries 也收 id 字符串数组（形状宽容 ⇒ 少一个抄错点）", () => {
    const a = factsForEntries(CFG, ["wb/claude-opus-5"]);
    assert.ok(a["wb/claude-opus-5"], "字符串形态没查到");
  });

  test("⑫-0c describeFactLookup 能看出「静默退回兜底」", () => {
    const good = describeFactLookup(CFG, ENTRIES);
    assert.equal(good.ids, 2);
    assert.equal(good.found, 1, "wb/claude-opus-5 是本家实测，应当查到");
    assert.deepEqual(good.missing, ["sn/claude-opus-5"], "sn 那条是 single 证据，查不到才对");

    /* ⚠ 接线接错的样子：entries 是空的 ⇒ 不报错，只是全退回兜底。 */
    const empty = describeFactLookup(CFG, []);
    assert.equal(empty.ids, 0);
    assert.equal(empty.found, 0);
    assert.equal(empty.nonDefault, 0);
    assert.deepEqual(empty.facts, {}, "空 entries 竟拿到了事实");
  });

  test("⑫-0c-2 nonDefault 数的是「值不是兜底值」的条数（约定值不算真值）", () => {
    const r = describeFactLookup(CFG, ENTRIES);
    /* 测试 CFG 里：wb/claude-opus-5 → hy3（measured，本家实测），
       sn/claude-opus-5 → glm-5.2（shared，单点证据 ⇒ 不下发 ⇒ 不在 facts 里）。 */
    assert.equal(r.nonDefault, 1, "非兜底值的条数不对");
    assert.equal(r.byKind.measured, 1);
    assert.ok(!r.byKind.shared, "shared 不该出现在 facts 里");

    /* ⚠ 全是约定值时 nonDefault 必须是 0 —— 这正是「接错了但看不出来」的形态。 */
    const allConv = describeFactLookup(CFG, [{ id: "qd/claude-opus-5" }]);
    assert.equal(allConv.nonDefault, 0, "约定值被算成了真值");
    assert.equal(allConv.byKind.convention, 1);
  });

  test("⑫-0d 诊断里能看出「查到了的是哪一档」", () => {
    const r = describeFactLookup(CFG, ENTRIES);
    assert.equal(r.facts["wb/claude-opus-5"].kind, "measured");
    assert.ok(r.facts["wb/claude-opus-5"].source);
    assert.ok(r.facts["wb/claude-opus-5"].at);
  });
});

/* ====================================================================== *
 * ⑫ 运行时覆盖层：渠道目录拉下来的那份比内置表新
 * ====================================================================== */
describe("⑫ 运行时覆盖层（阶段 3 的落点）", () => {
  const RUNTIME = {
    "wb/hy3": {
      context: 250000, output: 70000, kind: "measured",
      source: "wb /v3/config", sourceId: "hy3", at: "2026-10-24T00:00:00.000Z",
    },
  };

  test("⑫a 覆盖层优先于内置表", () => {
    const facts = factsFor(CFG, ["wb/claude-opus-5"], { runtime: RUNTIME });
    assert.equal(facts["wb/claude-opus-5"].context, 250000, "覆盖层没生效");
    assert.equal(facts["wb/claude-opus-5"].at, "2026-10-24T00:00:00.000Z");
  });

  test("⑫b 覆盖层里没有的，走内置表", () => {
    const facts = factsFor(CFG, ["wb/claude-sonnet-5"], { runtime: RUNTIME });
    assert.ok(facts["wb/claude-sonnet-5"], "内置表那条丢了");
    /* ⚠ 本测试的 CFG 用的是**出厂**映射（wb 的 sonnet → hy4-preview-f）。 */
    assert.equal(facts["wb/claude-sonnet-5"].context, MODEL_FACTS["wb/hy4-preview-f"].context);
  });

  test("⑫c 覆盖层里的 shared 也不下发", () => {
    const facts = factsFor(CFG, ["sn/claude-opus-5"], {
      runtime: {
        "sn/glm-5.2": {
          context: 1000000, output: 64000, kind: "shared",
          source: "wb /v3/config（同一模型）", sourceId: "glm-5.2", at: "2026-10-23",
        },
      },
    });
    assert.ok(!facts["sn/claude-opus-5"], "shared 的条目被下发了");
  });

  test("⑫d 覆盖层是坏形状时被忽略（回退内置表，不抛）", () => {
    const facts = factsFor(CFG, ["wb/claude-opus-5"], { runtime: { "wb/hy3": "不是对象" } });
    assert.ok(facts["wb/claude-opus-5"], "坏形状的覆盖层把内置表也顶掉了");
    assert.equal(facts["wb/claude-opus-5"].context, MODEL_FACTS["wb/hy3"].context);
    const facts2 = factsFor(CFG, ["wb/claude-opus-5"], { runtime: null });
    assert.ok(facts2["wb/claude-opus-5"], "null 覆盖层把内置表也弄没了");
  });
});

/* ====================================================================== *
 * ⑬ 覆盖层的落盘：能存能读，坏了不炸
 * ====================================================================== */
describe("⑬ 覆盖层落盘", () => {
  test("⑬a 存了能读回来", async () => {
    const file = path.join(tmpDir(), "facts.json");
    const facts = {
      "wb/hy3": {
        context: 192000, output: 64000, kind: "measured",
        source: "wb /v3/config", sourceId: "hy3", at: "2026-10-23",
      },
    };
    const w = await saveFacts(file, facts, { at: "2026-10-23T00:00:00.000Z" });
    assert.equal(w.ok, true, w.error);
    const back = await loadFacts(file);
    assert.ok(back, "读不回来");
    assert.equal(back["wb/hy3"].context, 192000);
    assert.equal(back["wb/hy3"].source, "wb /v3/config");
  });

  test("⑬b 文件不在就当没有覆盖层（安静）", async () => {
    assert.equal(await loadFacts(path.join(tmpDir(), "没有这个文件.json")), null);
  });

  test("⑬c 坏文件读成 null（不是空表 —— 空表会把已知事实全丢掉）", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "facts.json");
    fs.writeFileSync(file, "{ 这不是 JSON", "utf8");
    assert.equal(await loadFacts(file), null);
    const file2 = path.join(dir, "facts2.json");
    fs.writeFileSync(file2, JSON.stringify({ facts: { "wb/hy3": "不是对象" } }), "utf8");
    const back = await loadFacts(file2);
    assert.ok(back, "坏条目全被丢掉了 ⇒ 读成 null");
    assert.equal(back["wb/hy3"], undefined, "形状不对的条目被留下了");
  });

  test("⑬d 落盘的内容里没有凭据", async () => {
    const file = path.join(tmpDir(), "facts.json");
    await saveFacts(file, {
      "wb/hy3": {
        context: 192000, output: 64000, kind: "measured",
        source: "wb /v3/config", sourceId: "hy3", at: "2026-10-23",
      },
    });
    const text = fs.readFileSync(file, "utf8");
    assert.equal(/sk-[A-Za-z0-9]{8,}/.test(text), false, "落盘文件里有像令牌的东西");
    assert.equal(/Bearer\s/i.test(text), false, "落盘文件里有像 Authorization 头的东西");
  });

  test("⑬e 落盘失败不抛（落盘是辅助，失败不该带倒主流程）", async () => {
    /* 传一个**不可能写**的路径（在 Windows 上，目录名带冒号是非法的）。 */
    const r = await saveFacts("C:\\坏:目录\\facts.json", {});
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  test("⑬f 覆盖层是「哪一版内置表」的补丁 —— 内置表一改，旧覆盖层自动作废", async () => {
    const file = path.join(tmpDir(), "facts.json");
    const facts = {
      "wb/hy3": {
        context: 192000, output: 64000, kind: "measured",
        source: "wb /v3/config", sourceId: "hy3", at: "2026-10-23",
      },
    };
    const w = await saveFacts(file, facts, { at: "2026-10-23T00:00:00.000Z", baseAt: "2026-10-23" });
    assert.equal(w.ok, true, w.error);
    assert.ok(await loadFacts(file, { baseAt: "2026-10-23" }), "同批的覆盖层读不回来");
    /* ⚠ 内置表换了日期戳（人改了源码）⇒ 磁盘上这份覆盖层是旧表的补丁 ⇒ 作废。 */
    assert.equal(await loadFacts(file, { baseAt: "2026-11-01" }), null,
      "旧表的覆盖层被当成了新表的补丁");
  });

  test("⑬g 不给 baseAt 就跳过「同批」校验（向后兼容）", async () => {
    const file = path.join(tmpDir(), "facts.json");
    await saveFacts(file, {
      "wb/hy3": { context: 192000, output: 64000, kind: "measured", source: "wb", sourceId: "hy3", at: "2026-10-23" },
    }, { baseAt: "2026-10-23" });
    assert.ok(await loadFacts(file), "没给 baseAt 也该读得回来");
  });
});

/* ====================================================================== *
 * ⑪ 反向对照：把实现改坏，对应断言必须真的会红
 * ====================================================================== */

/**
 * 复制一份源码到临时目录、按锚点改坏，再 import 进来。
 *
 * ⚠ 锚点必须真的在源码里（改不到就当场炸）—— 否则「改坏」这一步悄悄没生效，
 *   后面的「断言会红」就成了自欺欺人。
 * ⚠ 三个模块都是**单文件自足**的（model-facts 零 import；facts-sources 只用
 *   node 内置模块；muse-models 零 import）⇒ 复制单个文件就能 import。
 */
async function mutant(rel, replacements) {
  const src = fs.readFileSync(path.join(REPO, rel), "utf8");
  let out = src;
  for (const [from, to] of replacements) {
    assert.ok(out.includes(from), `改坏用的锚点不在源码里：${JSON.stringify(from)}`);
    out = out.replace(from, to);
  }
  const dir = tmpDir();
  const file = path.join(dir, path.basename(rel));
  fs.writeFileSync(file, out, "utf8");
  return import(pathToFileURL(file).href);
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

describe("⑪ 反向对照 —— 改坏实现，对应断言必须真的会红", () => {
  test("⑪a publishable 永远返回 true ⇒ ③c/③d 会红（shared 被下发）", async () => {
    const mod = await mutant("src/server/clients/model-facts.mjs", [
      ["  if (k === \"shared\") return false;", "  if (k === \"shared\") return true;   // SABOTAGE：shared 也放行"],
    ]);
    await mustGoRed(mod, async (m) => {
      const shared = Object.entries(m.MODEL_FACTS).find(([, f]) => f.kind === "shared");
      assert.ok(shared, "表里没有 shared 的条目");
      assert.equal(m.publishable(shared[1]), false, "shared 被当成可下发了");
    }, "publishable 放行 shared 之后，③c 竟然还过");
  });

  test("⑪b factsFor 去掉 publishable 过滤 ⇒ ③d 会红", async () => {
    const mod = await mutant("src/server/clients/model-facts.mjs", [
      ["    if (!f || !publishable(f)) continue;\n    const context = windowOf(f.context);\n    const output = windowOf(f.output);\n    if (!context && !output) continue;\n    out[id] = {\n      context: context || 0,",
        "    if (!f) continue;\n    const context = windowOf(f.context);\n    const output = windowOf(f.output);\n    if (!context && !output) continue;\n    out[id] = {\n      context: context || 0,"],
    ]);
    await mustGoRed(mod, async (m) => {
      const facts = m.factsFor(CFG, ["sn/claude-opus-5"]);
      assert.ok(!facts["sn/claude-opus-5"], "shared 的条目进了 factsFor");
    }, "factsFor 不再过滤 shared 之后，③d 竟然还过");
  });

  test("⑪c mergeCatalogFacts 不覆盖已有条目 ⇒ ⑤a 会红", async () => {
    const mod = await mutant("src/server/clients/facts-sources.mjs", [
      ["      context: context || 0,", "      context: (prev.context || 0),   // SABOTAGE：不覆盖"],
    ]);
    await mustGoRed(mod, async (m) => {
      const out = m.mergeCatalogFacts({
        "wb/hy3": { context: 1, output: 2, kind: "measured", source: "旧", sourceId: "hy3", at: "2020-01-01" },
      }, {
        provider: "wb",
        entries: [{ id: "hy3", context: 192000, output: 64000 }],
        at: "2026-10-23T00:00:00.000Z",
        source: "wb /v3/config",
      });
      assert.equal(out["wb/hy3"].context, 192000, "渠道目录的值没覆盖表里的值");
    }, "merge 不覆盖之后，⑤a 竟然还过");
  });

  test("⑪d mergeCatalogFacts 不按渠道前缀隔离 ⇒ ⑥a 会红（串号）", async () => {
    const mod = await mutant("src/server/clients/facts-sources.mjs", [
      ["      if (!k.startsWith(provider + \"/\")) continue;", "      // SABOTAGE：不隔离渠道"],
    ]);
    await mustGoRed(mod, async (m) => {
      const base = {
        "wb/hy3": { context: 192000, output: 64000, kind: "measured", source: "wb", sourceId: "hy3", at: "2026-10-23" },
        "wbai/hy3": { context: 192000, output: 64000, kind: "measured", source: "wbai", sourceId: "hy3", at: "2026-10-23" },
      };
      const out = m.mergeCatalogFacts(base, {
        provider: "wbai",
        entries: [{ id: "hy3", context: 1000000, output: 64000 }],
        at: "2026-10-24T00:00:00.000Z",
        source: "wbai /v3/config",
      });
      assert.equal(out["wb/hy3"].context, 192000, "wb 的值被 wbai 的目录覆盖了 —— 串号");
    }, "merge 不隔离渠道之后，⑥a 竟然还过");
  });

  test("⑪e mergeCatalogFacts 不更新日期戳 ⇒ ⑤b 会红", async () => {
    const mod = await mutant("src/server/clients/facts-sources.mjs", [
      ["        sourceId: id,\n        at,\n        note: prev.note || \"\",",
        "        sourceId: id,\n        at: prev.at || at,   // SABOTAGE：日期戳不更新\n        note: prev.note || \"\","],
    ]);
    await mustGoRed(mod, async (m) => {
      const out = m.mergeCatalogFacts({
        "wb/hy3": { context: 1, output: 2, kind: "measured", source: "旧", sourceId: "hy3", at: "2020-01-01" },
      }, {
        provider: "wb",
        entries: [{ id: "hy3", context: 192000, output: 64000 }],
        at: "2026-10-23T00:00:00.000Z",
        source: "wb /v3/config",
      });
      assert.equal(out["wb/hy3"].at, "2026-10-23T00:00:00.000Z", "日期戳没更新");
    }, "merge 不更新日期戳之后，⑤b 竟然还过");
  });

  test("⑪f fetchWbCatalog 把空目录当成功 ⇒ ④c 会红", async () => {
    const mod = await mutant("src/server/clients/facts-sources.mjs", [
      ["    return { ok: false, error: \"上游回了空目录（成功码但没有模型）\", at, source };",
        "    return { ok: true, entries: [], at, source };   // SABOTAGE：空目录当成功"],
    ]);
    await mustGoRed(mod, async (m) => {
      const r = await m.fetchWbCatalog({
        upstream: "https://www.workbuddy.cn",
        token: "sk-fake-not-real",
        fetchImpl: async () => ({
          status: 200,
          text: async () => JSON.stringify({ code: 0, data: { models: null } }),
        }),
      });
      assert.equal(r.ok, false, "空目录被当成了成功");
    }, "空目录当成功之后，④c 竟然还过");
  });

  test("⑪g readQdCatalog 把读不到当成功 ⇒ ④f 会红", async () => {
    const mod = await mutant("src/server/clients/facts-sources.mjs", [
      ["  } catch (e) {\n    return { ok: false, error: `读不到目录文件：${String((e && e.code) || e).slice(0, 80)}`, at, source };\n  }",
        "  } catch (e) {\n    return { ok: true, entries: [], at, source };   // SABOTAGE：读不到当成功\n  }"],
    ]);
    await mustGoRed(mod, async (m) => {
      const r = await m.readQdCatalog({ file: path.join(tmpDir(), "没有这个文件.json") });
      assert.equal(r.ok, false, "读不到文件被当成了成功");
    }, "读不到当成功之后，④f 竟然还过");
  });

  test("⑪h muse-models 的 opts.facts 不生效 ⇒ ⑧a 会红", async () => {
    const mod = await mutant("src/server/clients/muse-models.mjs", [
      ["  const given = factEntry(o.facts && o.facts[id]);", "  const given = null;   // SABOTAGE：facts 不生效"],
    ]);
    await mustGoRed(mod, async (m) => {
      const payload = m.buildMuseModels([{ id: "wb/claude-opus-5" }], {
        facts: { "wb/claude-opus-5": { context: 192000, output: 64000, kind: "measured" } },
      });
      const lim = payload.data[0].metadata["muse-code"].limit;
      assert.equal(lim.context, 192000, "真值没进 limit");
    }, "facts 不生效之后，⑧a 竟然还过");
  });

  test("⑪i muse-models 里 opts.limits 被 opts.facts 盖掉 ⇒ ⑧b 会红", async () => {
    const mod = await mutant("src/server/clients/muse-models.mjs", [
      ["  const explicit = factEntry(o.limits && o.limits[id]);", "  const explicit = null;   // SABOTAGE：limits 不优先"],
    ]);
    await mustGoRed(mod, async (m) => {
      const payload = m.buildMuseModels([{ id: "wb/claude-opus-5" }], {
        limits: { "wb/claude-opus-5": { context: 200000, output: 32000 } },
        facts: { "wb/claude-opus-5": { context: 192000, output: 64000, kind: "measured" } },
      });
      const lim = payload.data[0].metadata["muse-code"].limit;
      assert.equal(lim.context, 200000, "limits 没有优先于 facts");
    }, "limits 不优先之后，⑧b 竟然还过");
  });

  test("⑪j muse-models 把 shared 当可下发 ⇒ ⑧c 会红", async () => {
    const mod = await mutant("src/server/clients/muse-models.mjs", [
      ["    if (given.kind === \"shared\") {", "    if (false) {   // SABOTAGE：shared 也下发"],
    ]);
    await mustGoRed(mod, async (m) => {
      const payload = m.buildMuseModels([{ id: "sn/claude-opus-5" }], {
        facts: { "sn/claude-opus-5": { context: 1000000, output: 64000, kind: "shared" } },
      });
      const lim = payload.data[0].metadata["muse-code"].limit;
      assert.equal(lim.context, MUSE_CONTEXT_FALLBACK, "shared 的值被发出去了");
    }, "shared 也下发之后，⑧c 竟然还过");
  });

  test("⑪k windowOf 不把过小的值当「不知道」 ⇒ ①e 会红", async () => {
    const mod = await mutant("src/server/clients/model-facts.mjs", [
      ["  if (!Number.isFinite(v) || v < LEAST_WINDOW) return 0;", "  if (!Number.isFinite(v)) return 0;   // SABOTAGE：过小的值当真"],
    ]);
    await mustGoRed(mod, async (m) => {
      assert.equal(m.windowOf(2047), 0, "过小的值被当成了真窗口");
    }, "windowOf 放过小的值之后，①e 竟然还过");
  });

  test("⑪l 兜底常量与 magpie 的不一致 ⇒ ②a 会红", async () => {
    const mod = await mutant("src/server/clients/muse-models.mjs", [
      ["export const MUSE_CONTEXT_FALLBACK = 128000;", "export const MUSE_CONTEXT_FALLBACK = 64000;"],
    ]);
    await mustGoRed(mod, async (m) => {
      assert.equal(m.MUSE_CONTEXT_FALLBACK, 128000, "兜底值与 magpie 不一致了");
    }, "兜底值被改之后，②a 竟然还过");
  });

  test("⑪m 运行时覆盖层不生效 ⇒ ⑫a 会红（渠道目录的新值顶不掉旧表）", async () => {
    const mod = await mutant("src/server/clients/model-facts.mjs", [
      ["  const runtime = runtimeFact(opts, provider, target);", "  const runtime = null;   // SABOTAGE：覆盖层不生效"],
    ]);
    await mustGoRed(mod, async (m) => {
      const facts = m.factsFor(CFG, ["wb/claude-opus-5"], {
        runtime: {
          "wb/hy3": {
            context: 250000, output: 70000, kind: "measured",
            source: "wb /v3/config", sourceId: "hy3", at: "2026-10-24T00:00:00.000Z",
          },
        },
      });
      assert.equal(facts["wb/claude-opus-5"].context, 250000, "覆盖层没生效");
    }, "覆盖层不生效之后，⑫a 竟然还过");
  });

  test("⑪q loadFacts 不校验 baseAt ⇒ ⑬f 会红（旧表的覆盖层被当成新表的）", async () => {
    const mod = await mutant("src/server/clients/facts-sources.mjs", [
      ["    if (gotBase !== wantBase) return null;", "    // SABOTAGE：不校验同批"],
    ]);
    await mustGoRed(mod, async (m) => {
      const dir = tmpDir();
      const file = path.join(dir, "facts.json");
      await m.saveFacts(file, {
        "wb/hy3": { context: 192000, output: 64000, kind: "measured", source: "wb", sourceId: "hy3", at: "2026-10-23" },
      }, { baseAt: "2026-10-23" });
      assert.equal(await m.loadFacts(file, { baseAt: "2026-11-01" }), null,
        "旧表的覆盖层被当成了新表的补丁");
    }, "不校验 baseAt 之后，⑬f 竟然还过");
  });

  test("⑪p muse-models 把 measured-elsewhere 也拦下来 ⇒ ⑧f 会红（两家一致的值发不出去）", async () => {
    const mod = await mutant("src/server/clients/muse-models.mjs", [
      ["    if (given.kind === \"shared\") {", "    if (given.kind === \"shared\" || given.kind === \"measured-elsewhere\") {   // SABOTAGE"],
    ]);
    await mustGoRed(mod, async (m) => {
      const payload = m.buildMuseModels([{ id: "bai/claude-opus-5" }], {
        facts: {
          "bai/claude-opus-5": {
            context: 192000, output: 64000, kind: "measured-elsewhere",
            source: "wb /v3/config 与 wbai /v3/config（两家目录实测一致，非本家目录）", at: "2026-10-23",
          },
        },
      });
      const lim = payload.data[0].metadata["muse-code"].limit;
      assert.equal(lim.context, 192000, "两家一致的值没发出去");
    }, "measured-elsewhere 被拦下来之后，⑧f 竟然还过");
  });

  test("⑪n loadFacts 把坏文件当空表 ⇒ ⑬c 会红（已知事实会整个消失）", async () => {
    const mod = await mutant("src/server/clients/facts-sources.mjs", [
      ["  try { j = JSON.parse(raw); } catch { return null; }", "  try { j = JSON.parse(raw); } catch { return {}; }   // SABOTAGE：坏文件当空表"],
    ]);
    await mustGoRed(mod, async (m) => {
      const dir = tmpDir();
      const file = path.join(dir, "facts.json");
      fs.writeFileSync(file, "{ 这不是 JSON", "utf8");
      assert.equal(await m.loadFacts(file), null, "坏文件被当成了空表");
    }, "坏文件当空表之后，⑬c 竟然还过");
  });

  test("⑫o loadFacts 留下形状不对的条目 ⇒ ⑬c 会红", async () => {
    const mod = await mutant("src/server/clients/facts-sources.mjs", [
      ["    if (!v || typeof v !== \"object\") continue;\n    if (!Number.isFinite(Number(v.context)) && !Number.isFinite(Number(v.output))) continue;",
        "    // SABOTAGE：两道形状检查都去掉"],
    ]);
    await mustGoRed(mod, async (m) => {
      const dir = tmpDir();
      const file = path.join(dir, "facts2.json");
      fs.writeFileSync(file, JSON.stringify({ facts: { "wb/hy3": "不是对象" } }), "utf8");
      const back = await m.loadFacts(file);
      assert.ok(back);
      assert.equal(back["wb/hy3"], undefined, "形状不对的条目被留下了");
    }, "坏条目被留下之后，⑬c 竟然还过");
  });
});
