// src/server/clients/zcode.mjs —— ZCode（智谱的桌面端）
//
// ## 配置文件 —— **两个**，两份形状
//
//   ① ~/.zcode/v2/provider_config.json —— **3.14+ 真正读的那份**（rules 形状）
//   ② ~/.zcode/v2/config.json           —— **旧版**读的那份（provider 形状）
//
// ⚠ ZCode 3.14 把 provider 搬到 provider_config.json，config.json 只在**启动时**
//   import 一次 —— 加在 config.json 里的 provider 后来**再也进不了**它的选择器。
//   （本机 `%USERPROFILE%\.zcode\v2\` 里就只有 provider_config.json，没有
//   config.json —— 只看了**键名与类型**，没抄值。）
//
// ### ① provider_config.json 的形状（magpie 的 rules）
//
//   {"schemaVersion":1,
//    "config":{
//      "providerConfigRules":{"providerRules":[{"providerId":"bai",
//        "providerName":"B.AI","enabled":true,
//        "config":{"group":"standard-personal",
//          "access":{"type":"api-key","apiKey":"…"},
//          "api":{"type":"anthropic-messages","baseUrl":"http://127.0.0.1:15799"},
//          "personalModelIds":[…],"modelOrder":[…]}}]},
//      "modelConfigRules":{"providerModelRules":[…],
//        "manualProviderModelRules":[…]}}}
//
// ### ② config.json 的形状（旧的 provider 块）
//
//   {"provider":{"bai":{"name":"B.AI","kind":"anthropic","enabled":true,
//     "source":"custom","options":{"apiKey":"…","baseURL":"…"},
//     "models":{"<模型 id>":{"name":"…"}}}}}
//
// ## magpie 的对应
//
// internal/agent/zcode.go。magpie **两份都写**：rules 那份给 3.14+、config.json
// 那份给旧版；api 的格式按用户在 ZCode 里选的那个来（没有就默认
// **anthropic-messages** —— zcodeKinds：anthropic-messages ⇒ kind "anthropic"，
// openai-chat-completions ⇒ "openai-compatible"，openai-responses ⇒ "openai"）。
// 我们没有那份「用户选了什么」的信息 ⇒ 两份都写 **anthropic-messages**
// （网关答 /v1/messages ✓ —— Anthropic 的 SDK 自己拼那个 /v1）。
//
// ## 数组怎么写（**不整份覆盖**）
//
// providerRules 是个**数组**：ZCode 自己往里写别的 provider，我们不能把它整份
// 盖掉。做法是**按元素匹配**：认出我们那一条（providerId 是我们的）就**就地**
// 合并它，没有就追加；**用户自己的条目原样留着、位置不变**。
//
// ⚠ 这层用的是**通用合并层**（clients/merge-policy.mjs，底座 base.mjs 调用）：
//   我们在 `writes` 里只给出**我们那一条** + 一份字段归属声明（`merge`），
//   底座在写盘前把它与文件里的现值合并。归属声明见下面的 RULE_MERGE / LEGACY_MERGE。
//   ⇒ ZCode 与别的客户端**共用同一套机制**，不必各写一套合并。
//
// 合并后的**整个数组**当成一个值写进去 —— 底座按「键路径 → 一个值」备份 ⇒
// 断开时整个数组原样写回 ⇒ 用户的条目一个字不丢。
//
// ## 模型规则（providerModelRules）：**整套不写** —— 但两条理由不一样，别混
//
// providerModelRules 里每个模型一条（上下文窗口、输入模态、思考档位…）。我们
// **整套不写**，可两件事的根据不同：
//
//   · **输入模态（inputFormat.supportsImage）是能力项** —— 我们的模型 id 是**档位**
//     （provider 无关），支不支持图片由**映射到哪家上游**决定（claude-opus-5 在 sn
//     映射到 glm-5.2、在 wb 映射到 hy3，逐家不同）⇒ **永远没有真值**。写 false 是
//     断言（我们只是不知道），写 true 是撒谎（用户真去发一张上游收不下的图，当场报错）。
//   · **上下文窗口（properties.contextWindow）不是能力项** —— 它的真值来自
//     `m.context`，只是**还没到位**（阶段 1 的元数据表）⇒ 现在写就是假数字。而且在
//     **新**形状里窗口是**逐模型的规则**，不是 provider 块里的一个键 ⇒ 要写就得
//     整套规则，不是加一个键。
//   · 另一条：**ZCode 没有「缺窗口就隐藏模型」的证据**（Muse 有，我们实测过）⇒
//     空着不影响用户选模型。
//
// ⇒ 真值到位（阶段 1）后整套规则再加。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：上面两个文件（rules 的 provider 那一条 + 旧形状的 provider 块）。
//   · 做了 magpie 的**保留**：用户在 ZCode 里改过的 providerName / 关掉过的
//     enabled / 自己加的键 / 改过的模型名，我们改了它也留着（地址、key、格式、
//     模型 id 集合是我们的）。逐字段的归属见 RULE_MERGE / LEGACY_MERGE。
//   · 没做：模型的 rules（providerModelRules）、manualProviderModelRules
//     （用户手填的，一律不碰）、ZCode 自己在 provider 设置里选的 api 格式
//     （我们没有那份信息 ⇒ 两份都写 anthropic-messages）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel } from "./json-util.mjs";

/** 我们用的 provider id（providerRules 里的 providerId / config.json 里的键）。 */
function pidOf(ctx) {
  return ctx.providerId || "bai";
}

/**
 * 旧形状（config.json）的 provider 块。
 *
 * ⚠ 两个键都不写，**理由不同**：
 *   · `limit`（上下文窗口）**不是能力项** —— 真值来自 `m.context`，还没到位
 *     （阶段 1 的元数据表）⇒ 现在写就是假数字（写假的会让 ZCode 提前截断上下文）
 *     ⇒ 等真值。
 *   · `modalities`（输入模态）是**能力项** ⇒ 永远没有真值 ⇒ 不写（写 false 是断言、
 *     写 true 是撒谎）。
 *   ⇒ 两条都不写 ⇒ ZCode 用它自己的默认（保守）。
 */
function providerBlock(ctx) {
  const models = {};
  for (const m of ctx.models || []) {
    models[m.id] = { name: m.label || m.id };
  }
  return {
    name: ctx.providerName || "B.AI",
    /* 与 rules 那份同一方言（anthropic-messages ⇒ kind "anthropic"，
       magpie 的 zcodeKinds 就是这么映的）。baseURL 是**根地址**（不带 /v1）——
       Anthropic 的 SDK 自己拼那个 /v1（网关答 /v1/messages ✓）。 */
    kind: "anthropic",
    enabled: true,
    source: "custom",
    options: { apiKey: ctx.apiKey || "", baseURL: ctx.baseUrl },
    models,
  };
}

/**
 * 新形状（provider_config.json）的 provider rule。
 *
 * 形状照 magpie 的 zcodeRules（internal/agent/zcode.go）。
 */
function ruleBlock(ctx) {
  const pid = pidOf(ctx);
  const ids = (ctx.models || []).map((m) => m.id);
  return {
    providerId: pid,
    providerName: ctx.providerName || "B.AI",
    enabled: true,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: ctx.apiKey || "" },
      api: { type: "anthropic-messages", baseUrl: ctx.baseUrl },
      personalModelIds: ids,
      modelOrder: ids,
    },
  };
}

/**
 * RULE_MERGE —— providerRules 里**我们那一条**的字段归属。
 *
 * 通用合并层（merge-policy.mjs）的 spec：
 *
 * | 字段 | 归谁 | 为什么 |
 * | --- | --- | --- |
 * | `providerId` | 我们的 | 认出「我们那一条」的钥匙（magpie 同） |
 * | `providerName` | **用户的** | 用户在 ZCode 里改过的名字留着（magpie zcode.go:495 同） |
 * | `enabled` | **用户的** | 用户在 ZCode 里关掉的 provider 保持关（magpie zcode.go:486 同） |
 * | `config.group` | 我们的 | magpie 的 `own` 列表里有它（zcode.go:499） |
 * | `config.personalModelIds` | 我们的 | 模型 id 集合是机器该管的（设计稿 §2.2(a)） |
 * | `config.modelOrder` | 我们的 | 同上 —— 它是「显示顺序」，随 id 集合走 |
 * | `config.access` / `config.api` | 我们的（但用户加的键留着） | 地址与 key 机器该管；键名、格式我们说了算 |
 * | 其它顶层键（logo、visibility…） | 保留用户的 | 我们压根没写（magpie zcode.go:503 的 `mergeKept(old, rule, nil)`） |
 *
 * ⚠ **位置**：合并层认出我们那一条后**留在原位**（magpie zcode.go:508 的
 *   `slices.Insert(providers, at, rule)`）⇒ 用户排的顺序不变。
 *
 * ⚠ `config.modelOrder` 归我们管（magpie 也归它），但**用户自己在模型清单
 *   里加的条目、改的相对顺序仍然保留** —— 那是数组合并那一层的事，不是这个键。
 */
const RULE_MERGE = {
  mode: "array",
  key: "providerId",
  theirs: ["providerName", "enabled"],
  whole: ["config.group", "config.personalModelIds", "config.modelOrder"],
};

/**
 * LEGACY_MERGE —— 旧形状（config.json）里 `provider.<pid>` 块的字段归属。
 *
 * | 字段 | 归谁 | 为什么 |
 * | --- | --- | --- |
 * | `name` | **用户的** | 用户改过的 provider 名字留着（设计稿 §2.2(a)：「模型名」） |
 * | `enabled` | **用户的** | 用户关掉的保持关（magpie zcode.go:150 同） |
 * | `models.*.name` | **用户的** | 用户改过的模型名留着 |
 * | `options`（apiKey / baseURL）、`kind`、`source` | 我们的 | 机器该管的（地址、key、方言） |
 * | `models` 里我们没写的模型 id | 保留用户的 | 用户自己加的模型留着 |
 */
const LEGACY_MERGE = {
  theirs: ["name", "enabled", "models.*.name"],
};

export const zcodeClient = {
  id: "zcode",
  name: "ZCode",
  protocol: "anthropic",
  note: "智谱的桌面端（3.14+ 走 provider_config.json 的 rules）",

  files: (ctx) => {
    const dir = path.join(ctx.home, ".zcode", "v2");
    const rules = path.join(dir, "provider_config.json");
    const legacy = path.join(dir, "config.json");
    const pid = pidOf(ctx);
    return [
      {
        /* ① 3.14+ 真正读的那份（rules 形状）—— 放第一个：面板的状态也看它。 */
        path: rules,
        writes: () => {
          /* 一个模型都没有就别写 —— 写一份没有模型的 provider 对用户没意义。 */
          pickModel(ctx);
          const ours = ruleBlock(ctx);
          return [
            /* schemaVersion 缺才补（用户若是 2 就留着）。 */
            { path: "schemaVersion", value: 1, onlyIfAbsent: true },
            /* modelConfigRules 我们**不写内容**（模型能力我们不知道 ⇒ 不写那条
               规则）⇒ 只在它压根不存在时给个空壳，让 ZCode 的形状完整。 */
            {
              path: "config.modelConfigRules",
              value: { providerModelRules: [], manualProviderModelRules: [] },
              onlyIfAbsent: true,
            },
            /* 只写**我们那一条**（写成一项的数组，形状与那个键该有的样子一致）；
               通用合并层在用户的清单里认出它、**就地**合并：
               用户自己的条目原样留着、位置不变，我们那一条也留在原位。
               字段归属见 RULE_MERGE。
               ⚠ 断开时底座把**整个数组**原样写回（备份记的是写盘前的原值）⇒
                 用户的条目一个字不丢。 */
            {
              path: "config.providerConfigRules.providerRules",
              value: [ours],
              merge: RULE_MERGE,
            },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "config.providerConfigRules.providerRules");
          return !!(r && r.ok && r.found && Array.isArray(r.value)
            && r.value.some((x) => x && x.providerId === pid));
        },
      },
      {
        /* ② 旧版 ZCode 读的那份（provider 形状）—— magpie 也写它。 */
        path: legacy,
        writes: () => {
          pickModel(ctx);
          return [
            /* 字段归属见 LEGACY_MERGE：名字与开关归用户，地址/key/方言归我们，
               用户自己加的模型留着、用户改过的模型名留着。 */
            { path: `provider.${pid}`, value: providerBlock(ctx), merge: LEGACY_MERGE },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, `provider.${pid}`);
          return !!(r && r.ok && r.found);
        },
      },
    ];
  },
};
