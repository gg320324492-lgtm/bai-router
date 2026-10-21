/* 统一网关的档位识别 —— 档位反查 / 档位识别 / 目标家重解析 / 候选链顺序。
 *
 * ## 这份测试在守什么
 *
 * 网关模式下故障转移链断掉的根因是：**模型 id 里没有档位了**。
 * 网关收到的 `provider/...` 里的模型段若是**最终模型名**，转移时不知道该用哪一档，
 * 只能把原模型硬发给下一家 → 下一家多半不服务这个模型 → 400。
 *
 * 两个方向：
 *   · `tierKeyFor` —— 模型 id 写 `provider/档位`（**正规写法**）→ 档位就在 id 里，
 *     无损、无歧义。这份测试盯住它认得准。
 *   · `tierOfModel` —— 模型 id 写 `provider/最终模型`（旧写法 / 用户手写）→ 只能反查。
 *
 * ⚠⚠ **反查命中多个 = 歧义 = 必须返回 null。**
 * 这条曾经写反过（旧实现「取第一个」），代价是：zen 的四档都指向 space-bunny-free，
 * 反查必然命中四个 → 取到 fable → 转移到 wb 时用了 wb 的 **fable** 档模型
 * （deepseek-v4.1-flash），而用户点的是 **opus** 档（应是 hy3）。
 * **用户点的档位被悄悄换掉，面板上什么都看不出来。**
 *
 * 这份测试盯住四件事：
 *   ① 反查**不许猜**——查不到**或**命中多个都 null。
 *   ② 档位识别（tierKeyFor）认得准，且不把模型名误认成档位。
 *   ③ 回落语义必须与 `server.mjs` 现有的 `resolveModel` **一字不差**（逐条对拍）。
 *   ④ 顺序语义与 magpie 一致：**用户手选的就是首选**，入口永远第一。
 *
 * 末尾两条**反向对照**把源码改坏（歧义时返回第一个 / 回落用入口家的默认模型），
 * 证明对应断言**真的会红**——恒真的测试比没有测试更坏。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as GF from "../src/server/gateway-failover.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "src/server/gateway-failover.mjs");
const GATEWAY_PATH = path.join(ROOT, "src/server/gateway.mjs");
const MODULE_SRC = fs.readFileSync(MODULE_PATH, "utf8");

/* ---------- 夹具：一份能同时撑起八条断言的配置 ----------
 *
 * 刻意做出四种形状：
 *   · bai 是**扁平**的（字段摊在 cfg 顶层），其余七家在 cfg[provider] 子对象里；
 *   · sn 的 fable-5 与 opus-5 **映射到同一个模型**（歧义：反查该取哪一个）；
 *   · wb **故意没有** claude-haiku-4-5 这一档（回落目标家的 defaultModel）；
 *   · zen **没配凭据**（必须被跳过）。
 */
function makeCfg() {
  return {
    /* bai：扁平渠道 */
    apiKey: "sk-bai",
    defaultModel: "bai-default",
    availableModels: ["bai-default", "bai-extra"],
    mapping: { "claude-opus-5": { target: "bai-model", label: "Bai" } },

    sn: {
      apiKey: "sk-sn",
      defaultModel: "sn-default",
      availableModels: ["sn-default", "sn-shared", "sn-haiku", "glm-5.2"],
      mapping: {
        "claude-fable-5": { target: "sn-shared" },     // 与下一档同模型 → 歧义
        "claude-opus-5": { target: "sn-shared" },
        "claude-sonnet-5": { target: "glm-5.2" },
        "claude-haiku-4-5": { target: "sn-haiku" },
      },
    },

    wb: {
      accessToken: "wb-token",
      defaultModel: "wb-default",
      availableModels: ["wb-default", "wb-shared", "hy3", "hy4-preview-f"],
      mapping: {
        "claude-fable-5": { target: "wb-shared" },
        "claude-opus-5": { target: "wb-shared" },       // 与上一档同模型 → 转移结果一致
        "claude-sonnet-5": { target: "hy3" },
        /* 故意没有 claude-haiku-4-5 → 用来测回落 */
      },
    },

    zen: {
      apiKey: "",                                      // 没配凭据 → 必须被跳过
      defaultModel: "zen-default",
      availableModels: ["zen-default"],
      mapping: { "claude-opus-5": { target: "zen-model" } },
    },

    failover: { enabled: true, chain: ["wb", "sn", "zen", "bai"] },
  };
}

describe("档位反查", () => {
  test("① 给定 (provider, 模型) → 拿到正确的档位", () => {
    const cfg = makeCfg();
    assert.equal(GF.tierOfModel("sn", "glm-5.2", cfg), "claude-sonnet-5");
    assert.equal(GF.tierOfModel("sn", "sn-haiku", cfg), "claude-haiku-4-5");
    assert.equal(GF.tierOfModel("wb", "hy3", cfg), "claude-sonnet-5");
    assert.equal(GF.tierOfModel("bai", "bai-model", cfg), "claude-opus-5");
  });

  test("② 反查不到 → null（不许猜）", () => {
    const cfg = makeCfg();
    /* 模型根本不是这家映射里的任何一档 */
    assert.equal(GF.tierOfModel("sn", "hy3", cfg), null, "hy3 是 wb 的模型，不是 sn 的档位");
    assert.equal(GF.tierOfModel("sn", "压根没有的模型", cfg), null);
    /* 渠道本身不认识 */
    assert.equal(GF.tierOfModel("不认识这家", "hy3", cfg), null);
    /* 空模型名不许命中任何东西 */
    assert.equal(GF.tierOfModel("sn", "", cfg), null);
  });

  test("③ 两档映射到同一个模型 → **歧义，返回 null**（不许挑一个）", () => {
    const cfg = makeCfg();
    /* sn 的 fable-5 与 opus-5 都指向 sn-shared —— 反查命中两个，档位**不可知**。
     * 挑一个（哪怕挑对了一个）也是**瞎猜**：挑错就是「用户点 opus 跑了 fable 的模型」。 */
    assert.equal(GF.tierOfModel("sn", "sn-shared", cfg), null,
      "命中多个 = 歧义 = 档位不可知，必须返回 null");
    /* 歧义时转移**绝不能**把入口家的模型硬发给下一家 —— 只能用目标家自己的默认模型 */
    const plan = GF.planGatewayChain("sn/sn-shared", cfg);
    assert.equal(plan[0].provider, "sn");
    assert.equal(plan[0].tier, null, "档位不可知就不许填一个");
    assert.equal(plan[1].provider, "wb");
    assert.equal(plan[1].model, "wb-default",
      "档位不可知时用目标家自己的默认模型");
    assert.notEqual(plan[1].model, "sn-shared",
      "把入口家的模型硬发给下一家 → 下一家不服务它 → 400，且失败原因会被记成「下一家坏了」");
  });

  test("③b 档位识别（tierKeyFor）：模型 id 写 provider/档位 时认得准", () => {
    const cfg = makeCfg();
    /* 档位名 → 档位本身 */
    assert.equal(GF.tierKeyFor("sn", "claude-opus-5", cfg), "claude-opus-5");
    assert.equal(GF.tierKeyFor("sn", "claude-sonnet-5", cfg), "claude-sonnet-5");
    /* 带日期后缀的规范 id 也要认（claude-haiku-4-5-20251001） */
    assert.equal(GF.tierKeyFor("sn", "claude-haiku-4-5-20251001", cfg), "claude-haiku-4-5");
    /* 最终模型名**不是**档位 */
    assert.equal(GF.tierKeyFor("sn", "glm-5.2", cfg), null, "模型名不是档位");
    assert.equal(GF.tierKeyFor("sn", "sn-shared", cfg), null);
    assert.equal(GF.tierKeyFor("wb", "hy3", cfg), null);
    /* 渠道不认识 */
    assert.equal(GF.tierKeyFor("不认识这家", "claude-opus-5", cfg), null);
    /* 这一家没配这一档，但它是系统认得的档位 → 仍按档位处理（交给中转按本家回落） */
    assert.equal(GF.tierKeyFor("wb", "claude-haiku-4-5", cfg, { tiers: ["claude-haiku-4-5"] }),
      "claude-haiku-4-5", "认得系统的档位清单");
    assert.equal(GF.tierKeyFor("wb", "claude-haiku-4-5", cfg), null,
      "没给 tiers 清单时只认这一家映射表里有的");
  });
});

describe("转移时的重解析", () => {
  test("④ 入口在 sn、chain 里有 wb → 第二项是 wb，模型是 wb 自己映射的那个", () => {
    const cfg = makeCfg();
    const plan = GF.planGatewayChain("sn/glm-5.2", cfg);
    assert.equal(plan[0].provider, "sn");
    assert.equal(plan[0].model, "glm-5.2");
    assert.equal(plan[0].tier, "claude-sonnet-5");
    assert.equal(plan[1].provider, "wb");
    /* wb 的 claude-sonnet-5 映射到 hy3 —— 不是入口那个 glm-5.2 */
    assert.equal(plan[1].model, "hy3", "转移后必须用目标家自己的映射重解析");
    assert.notEqual(plan[1].model, plan[0].model, "把原模型硬发给下一家就是那个 400");
  });

  test("⑤ 目标家没有该档位 → 回落到**该家**的 defaultModel（不是入口家的）", () => {
    const cfg = makeCfg();
    /* sn 的 claude-haiku-4-5 → sn-haiku；wb 压根没有这一档 */
    const plan = GF.planGatewayChain("sn/sn-haiku", cfg);
    assert.equal(plan[0].tier, "claude-haiku-4-5");
    assert.equal(plan[1].provider, "wb");
    assert.equal(plan[1].model, "wb-default", "回落必须用目标家 wb 自己的 defaultModel");
    assert.notEqual(plan[1].model, "sn-default", "拿入口家的默认模型就是发错了模型");
    /* 单独问一次 resolveForProvider，口径必须一样 */
    assert.equal(GF.resolveForProvider("claude-haiku-4-5", "wb", cfg), "wb-default");
    assert.equal(GF.resolveForProvider("claude-haiku-4-5", "sn", cfg), "sn-haiku");
  });

  test("⑥ 回落语义与 server.mjs 的 resolveModel **逐条对拍**", () => {
    /* server.mjs 一 import 就起服务，只能把它的解析本体抠出来跑（与
       scripts/chain-order-test.mjs 同一手法）。noteModelFallback 是留痕用的，
       这里换成空实现——它不影响解析结果。 */
    const serverResolveModel = serverResolveModelFactory();
    const cfg = makeCfg();
    /* 额外做一份：让 wb 的**可用清单**里出现档位名，用来覆盖 resolveModel 的
       第二条分支（清单里查到了就返回清单里的原样写法）。 */
    const cfg2 = makeCfg();
    cfg2.wb.availableModels = [...cfg2.wb.availableModels, "claude-haiku-4-5"];

    for (const p of ["bai", "sn", "wb", "zen"]) {
      const tiers = ["claude-opus-5", "claude-sonnet-5", "claude-fable-5",
        "claude-haiku-4-5", "claude-opus-5-20251001", "压根没有的档位"];
      for (const c of [cfg, cfg2]) {
        const slice = GF.sliceOfProvider(p, c);
        for (const t of tiers) {
          assert.equal(
            GF.resolveForProvider(t, p, c),
            serverResolveModel(t, slice, p),
            `渠道 ${p} 档位 ${t}：我们的回落与 server.mjs 的 resolveModel 不一致`,
          );
        }
      }
    }
  });
});

describe("候选链", () => {
  test("⑦ 没配凭据的渠道被跳过", () => {
    const cfg = makeCfg();
    const plan = GF.planGatewayChain("sn/glm-5.2", cfg);
    assert.ok(!plan.some((x) => x.provider === "zen"), "zen 没配 apiKey，不该进链");
    assert.deepEqual(plan.map((x) => x.provider), ["sn", "wb", "bai"]);
  });

  test("⑧ 入口永远第一（哪怕 chain 里它在中间）", () => {
    const cfg = makeCfg();
    /* chain = ["wb", "sn", "zen", "bai"] —— sn 在中间 */
    const plan = GF.planGatewayChain("sn/glm-5.2", cfg);
    assert.equal(plan[0].provider, "sn", "用户手选的就是首选，不该被 chain 顺序顶掉");
    /* 入口也可以显式给（不依赖模型 id 的前缀） */
    const byOpt = GF.planGatewayChain("glm-5.2", cfg, { entry: "sn" });
    assert.equal(byOpt[0].provider, "sn");
    assert.equal(byOpt[0].model, "glm-5.2");
  });

  test("⑨ 候选链与备选函数给的是同一份答案", () => {
    const cfg = makeCfg();
    const tier = GF.tierOfModel("sn", "glm-5.2", cfg);
    const fb = GF.gatewayFallbacks("sn", tier, cfg);
    const plan = GF.planGatewayChain("sn/glm-5.2", cfg);
    assert.deepEqual(plan.slice(1), fb);
  });
});

/** 去掉注释（块注释 + 行注释）——判「有没有调 Date.now」只看**代码**，不看注释里提到它。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    /* 行注释：前面不是 ":" 的才算（免得把 https:// 误伤成注释） */
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("硬约束", () => {
  test("⑩ 模块内部绝不调 Date.now()（时间由参数传入）", () => {
    const code = stripComments(MODULE_SRC);
    assert.equal(/Date\s*\.\s*now\s*\(/.test(code), false,
      "本模块必须零时钟：时间只从 opts.now 进来");
    assert.equal(/new\s+Date\s*\(/.test(code), false);
    /* 时刻只许从参数进来 */
    assert.equal(/opts\s*\.\s*now/.test(code), true, "opts.now 必须真的被用上");
  });

  test("⑪ 不碰 fs / 网络，唯一的依赖是 gateway.mjs", () => {
    const code = stripComments(MODULE_SRC);
    assert.equal(/node:fs|node:http|node:net|node:https|require\s*\(/.test(code), false,
      "本模块是纯逻辑，不许碰 IO");
    const imports = [...MODULE_SRC.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["./gateway.mjs"],
      "只许依赖 gateway.mjs（渠道清单 KNOWN_PROVIDERS 与模型 id 拆分都在那儿）");
  });

  test("⑫ 渠道集合不另抄一份（用 gateway.mjs 的 KNOWN_PROVIDERS）", () => {
    assert.equal(/KNOWN_PROVIDERS/.test(MODULE_SRC), true);
    /* 名单不许在本模块里再写一遍字面量 */
    assert.equal(/\[\s*"bai"\s*,\s*"sn"/.test(MODULE_SRC), false,
      "渠道名单只许有一份（在 gateway.mjs 里）");
  });
});

/* ========================================================================== *
 * 反向对照：把源码改坏，证明对应断言**真的会红**
 * ========================================================================== */

/** 契约断言：正向必须全绿；改坏之后必须至少红一条。 */
function contractChecks(mod) {
  const cfg = makeCfg();
  assert.equal(mod.tierOfModel("sn", "glm-5.2", cfg), "claude-sonnet-5", "① 反查");
  assert.equal(mod.tierOfModel("sn", "hy3", cfg), null, "② 反查不到");
  assert.equal(mod.tierOfModel("sn", "sn-shared", cfg), null, "③ 歧义 → null（不许挑一个）");

  const amb = mod.planGatewayChain("sn/sn-shared", cfg);
  assert.equal(amb[1].model, "wb-default", "③ 歧义时用目标家自己的默认模型");
  assert.notEqual(amb[1].model, "sn-shared", "③ 绝不把入口家的模型硬发给下一家");

  /* 档位识别（新写法走这条） */
  assert.equal(mod.tierKeyFor("sn", "claude-opus-5", cfg), "claude-opus-5", "③b 档位识别");
  assert.equal(mod.tierKeyFor("sn", "glm-5.2", cfg), null, "③b 模型名不是档位");

  const plan = mod.planGatewayChain("sn/glm-5.2", cfg);
  assert.equal(plan[1].provider, "wb", "④ 第二项是 wb");
  assert.equal(plan[1].model, "hy3", "④ 模型是 wb 自己映射的那个");

  const fb = mod.planGatewayChain("sn/sn-haiku", cfg);
  assert.equal(fb[1].model, "wb-default", "⑤ 回落用目标家自己的 defaultModel");

  assert.ok(!plan.some((x) => x.provider === "zen"), "⑦ 没配凭据的跳过");
  assert.equal(plan[0].provider, "sn", "⑧ 入口永远第一");
}

/**
 * 造一个「改坏之后」的模块：改源码 → 写到临时目录 → import 进来。
 * ⚠ 改的是**副本**，仓库里的源码一个字都不动。
 */
async function mutantModule(name, from, to) {
  assert.equal(MODULE_SRC.includes(from), true,
    `锚点对不上源码了（手法或源码变了，这条反向对照失效）：${from}`);
  const src = MODULE_SRC
    .replace(from, to)
    /* 副本落在临时目录，相对 import 会失效 —— 改成绝对 file URL */
    .replace('"./gateway.mjs"', JSON.stringify(pathToFileURL(GATEWAY_PATH).href));
  const file = path.join(os.tmpdir(), `bai-gateway-failover-mutant-${name}.mjs`);
  fs.writeFileSync(file, src, "utf8");
  return import(pathToFileURL(file).href);
}

describe("反向对照（改坏源码，断言必须红）", () => {
  test("⑬ 正向：契约全绿", () => {
    contractChecks(GF);
  });

  test("⑭ 把「歧义时返回第一个」改坏 → 必须打红", async () => {
    /* 这正是旧实现（「取第一个命中的档位」）——它会让「用户点 opus、转移后跑 fable 的
     * 模型」这种错**重新回来**，而面板上看不出来。 */
    const bad = await mutantModule(
      "ambiguous-first",
      "    if (found !== null) return null;                    // 命中第二个 → 歧义 → 不猜",
      "    if (found !== null) return found;                  // SABOTAGE：歧义时取第一个",
    );
    assert.throws(() => contractChecks(bad),
      "歧义改成取第一个之后断言竟然还绿 —— 那这条断言是恒真的");
    const cfg = makeCfg();
    assert.equal(bad.tierOfModel("sn", "sn-shared", cfg), "claude-fable-5",
      "改坏之后确实挑了一个档位");
    const plan = bad.planGatewayChain("sn/sn-shared", cfg);
    assert.equal(plan[1].model, "wb-shared",
      "挑中的档位决定了转移后跑哪个模型 —— 这就是「用户点 opus 跑了 fable 的模型」");
    assert.notEqual(plan[1].model, "wb-default");
  });

  test("⑭b 把「档位反查」改坏（一律返回 null）→ 必须打红", async () => {
    const bad = await mutantModule(
      "tier-null",
      "    found = tier;\n  }\n  return found;",
      "    found = null;   // SABOTAGE：反查一律返回 null\n  }\n  return found;",
    );
    assert.throws(() => contractChecks(bad),
      "反查改成返回 null 之后断言竟然还绿 —— 那这条断言是恒真的");
    /* 说清是哪一条红的：转移后的模型退化成目标家的默认模型 */
    const cfg = makeCfg();
    const plan = bad.planGatewayChain("sn/glm-5.2", cfg);
    assert.equal(plan[1].model, "wb-default", "档位丢了 → 转移后用错模型");
    assert.notEqual(plan[1].model, "hy3");
  });

  test("⑮ 把「回落用目标家 defaultModel」改坏（用入口家的）→ 必须打红", async () => {
    const bad = await mutantModule(
      "fallback-entry",
      "    model: resolveForProvider(tier, p, c),",
      "    model: resolveForProvider(tier, p, c, { fallbackProvider: entry }),",
    );
    assert.throws(() => contractChecks(bad),
      "回落改成用入口家的默认模型之后断言竟然还绿 —— 那这条断言是恒真的");
    const cfg = makeCfg();
    const plan = bad.planGatewayChain("sn/sn-haiku", cfg);
    assert.equal(plan[1].model, "sn-default", "回落用错了家 → 发出去的模型不对");
    assert.notEqual(plan[1].model, "wb-default");
  });
});

/* ========================================================================== *
 * 从 server.mjs 里抠出 resolveModel 本体（server.mjs 一 import 就起服务）
 * ========================================================================== */

/** 按锚点抠出一个函数的源码（大括号配平为止）。 */
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

/** 造出 server.mjs 的 resolveModel（留痕函数换成空实现——它不影响解析结果）。 */
function serverResolveModelFactory() {
  const SRC = fs.readFileSync(path.join(ROOT, "src/server/server.mjs"), "utf8");
  const body = [
    sliceFn(SRC, "function normalizeModel"),
    sliceFn(SRC, "function tierKeyOf"),
    sliceFn(SRC, "function listedModelOf"),
    sliceFn(SRC, "function resolveModelTarget"),
    sliceFn(SRC, "function resolveModel(name, cfg, ch)"),
  ].join("\n");
  const factory = new Function("noteModelFallback", `${body}\nreturn resolveModel;`);
  return factory(() => { });
}
