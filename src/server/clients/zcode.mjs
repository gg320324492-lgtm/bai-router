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
// 盖掉。做法是**按元素匹配**：认出我们那一条（providerId 是我们的）就改它，
// 没有就追加；**用户自己的条目原样留着**。我们把合并后的**整个数组**当成一个
// 值写进去 —— 底座按「键路径 → 一个值」备份 ⇒ 断开时整个数组原样写回 ⇒
// 用户的条目一个字不丢。
//
// ## 能力项：**我们不知道 ⇒ 不写那个键**
//
// providerModelRules 里每个模型一条（上下文窗口、输入模态、思考档位…）——
// 我们的模型 id 是**档位**（provider 无关），能力由**映射到哪家上游**决定
// （claude-opus-5 在 sn 映射到 glm-5.2、在 wb 映射到 hy3，逐家不同）⇒ 真不知道。
// 写 false 是断言（我们只是不知道），写 true 是撒谎（用户真去发一张上游收不下的
// 图，当场报错）⇒ **那条规则我们不写**（ZCode 用它自己的默认，保守）。
// 真值到位后（T15-c 的「模型元数据下发」）再把它加上。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：上面两个文件（rules 的 provider 那一条 + 旧形状的 provider 块）。
//   · 做了 magpie 的**保留**：用户在 ZCode 里改过的 providerName / 关掉过的
//     enabled / 自己加的键，我们改了它也留着（地址、key、格式、模型列表是我们的）。
//   · 没做：模型的 rules（providerModelRules）、manualProviderModelRules
//     （用户手填的，一律不碰）、ZCode 自己在 provider 设置里选的 api 格式
//     （我们没有那份信息 ⇒ 两份都写 anthropic-messages）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { curValue, pickModel } from "./json-util.mjs";

/** 我们用的 provider id（providerRules 里的 providerId / config.json 里的键）。 */
function pidOf(ctx) {
  return ctx.providerId || "bai";
}

/**
 * 旧形状（config.json）的 provider 块。
 *
 * ⚠ **能力项一律不写**：上下文窗口（limit）、输入模态（modalities）我们不知道
 *   （档位 provider 无关，逐家不同）⇒ 写 false 是断言、写 true 是撒谎 ⇒ 不写，
 *   ZCode 用它自己的默认（保守）。真值到位后再加。
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
 * mergeRules —— 把我们那一条并进 ZCode 自己的 providerRules。
 *
 * 认出我们那一条（providerId 是我们的）就改它，没有就追加；**用户自己的条目
 * 原样留着**（magpie 的规矩：地址、key、格式与模型列表是它的，其余是用户的）。
 * 用户在 ZCode 里把这条关了 ⇒ 保持关。
 */
function mergeRules(list, ours) {
  const kept = [];
  let old = null;
  for (const r of list) {
    if (r && r.providerId === ours.providerId) { old = r; continue; }
    kept.push(r);
  }
  const merged = { ...(old || {}), ...ours };
  merged.config = { ...((old && old.config) || {}), ...ours.config };
  if (old && typeof old.enabled === "boolean") merged.enabled = old.enabled;
  return [...kept, merged];
}

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
          const cur = curValue(rules, "json", "config.providerConfigRules.providerRules");
          const list = cur.existed && Array.isArray(cur.value) ? cur.value : [];
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
            /* 整个数组当一个值写：用户自己的条目在里面原样留着，
               断开时底座把整个数组原样写回。 */
            { path: "config.providerConfigRules.providerRules", value: mergeRules(list, ours) },
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
            { path: `provider.${pid}`, value: providerBlock(ctx) },
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
