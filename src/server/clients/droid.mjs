// src/server/clients/droid.mjs —— Droid（Factory 的 CLI）
//
// ## 配置文件
//
//   ~/.factory/settings.json
//   （$FACTORY_HOME_OVERRIDE 设了 ⇒ 用它下面的 .factory —— 注意它是**家目录**
//    的替代，不是 .factory 本身，与 magpie 一致）
//
// ## magpie 的对应
//
// internal/agent/droid.go。Factory 的 BYOK 模型是 "customModels" 这个**数组**，
// 每个成员：
//
//   {"model":"<模型 id>","id":"custom:<…>","displayName":"…","baseUrl":"…",
//    "apiKey":"…","provider":"generic-chat-completion-api",
//    "maxContextLimit":…,"maxOutputTokens":…,"noImageSupport":false}
//
// provider 有三种："anthropic"（Messages）、"openai"（Responses）、
// "generic-chat-completion-api"（Chat Completions）。
//
// 一个自定义模型在 /model 里按 "custom:<id>" 挑；新会话从哪个模型起是
// sessionDefaultSettings.model（顶层的 "model" 是旧的写法，droid 在它没设时
// 会搬过去）。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：customModels 里我们的那几条 + sessionDefaultSettings.model。
//   · 做了 magpie 的**合并**：用户自己的 customModels 条目留在前面（magpie：
//     「用户的条目原地不动，在前面」，这样他们自己的 id 不挪位）。
//   · 做了**保留用户手改**：用户在 Droid 里改过的**模型显示名**留着；改过的 id
//     换回我们的（模型 id 集合是机器该管的）；用户自己加的条目原样留着、位置
//     不变。归属表见 DROID_MERGE。
//   · 没做：每个模型按**它自己那家**的原生协议接（magpie 会看目录里这个模型
//     是 Anthropic 就写 anthropic + 网关根地址、是 Responses 就写 openai）。
//     我们统一写 generic-chat-completion-api —— 统一网关把客户端的话翻成
//     Anthropic 形状再发给各家（见 src/server/ir.mjs 的协议桥），所以走 Chat
//     这一条就够。
//   · 没做：maxContextLimit / maxOutputTokens（我们的接线上下文里没有「这个
//     档位的上下文窗口」这一项 —— 写一个假的数字会让 Droid 提前截断上下文）。
//   · 没做：旧的 ~/.factory/config.json（custom_models）—— magpie 也只读它、
//     不写它。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel, envDir } from "./json-util.mjs";

/** 配置文件在哪儿。 */
function droidFile(ctx) {
  const home = envDir("FACTORY_HOME_OVERRIDE") || ctx.home;
  return path.join(home, ".factory", "settings.json");
}

/** 我们自己的那一条自定义模型。 */
function entry(ctx, m, pid) {
  return {
    /* 问网关时用的模型 id（provider/档位 的完整写法） */
    model: m.id,
    /* Droid 里它叫什么：custom:<provider>/<模型 id> */
    id: `custom:${pid}/${m.id}`,
    displayName: m.label || m.id,
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey || "",
    /* Chat Completions ⇒ 统一网关的 /chat/completions */
    provider: "generic-chat-completion-api",
    /* ⚠ **不写** `noImageSupport`：「我们不知道」≠「不支持」——
       我们的模型 id 是**档位**（provider 无关），而支不支持图像由**映射到哪家
       上游**决定（claude-opus-5 在 sn 映射到 glm-5.2、在 wb 映射到 hy3，逐家不同）
       ⇒ 说「这个档位不能看图」是对**所有**上游的断言，我们没有依据。
       写 false 是断言（我们只是不知道），写 true 是撒谎（用户真去发一张上游收不下的
       图，当场报错）。键不写 ⇒ Droid 按自己的默认走（保守），将来有了真值
       （T15-c 的「模型元数据下发」）再加这个键。 */
  };
}

/**
 * DROID_MERGE —— customModels 里**我们那几条**的字段归属（合并层的 spec）。
 *
 * 通用合并层（merge-policy.mjs，底座 base.mjs 调用）在写盘前把「我们要写的值」
 * 与「用户文件里的现值」合并。这个 spec 就是 Droid 的**归属表**：
 *
 * | 字段 | 归谁 | 为什么 |
 * | --- | --- | --- |
 * | `displayName` | **用户的** | 用户在 Droid 里改过的模型显示名留着（设计稿 §2.2(a)：模型名是「用户可能手改」的字段） |
 * | `model` / `id` | 我们的 | 模型 id 集合是机器该管的（§2.2(a)）—— 用户改过的 id 会被换回来 |
 * | `baseUrl` / `apiKey` / `provider` | 我们的 | 地址、令牌与方言是机器该管的（§2.2(a)） |
 * | 我们没写的键（maxContextLimit…） | **保留用户的** | 弱保留那一层（magpie 的 theirsKept） |
 *
 * ⚠ **识别键是 `id`**（`custom:<provider>/<模型 id>`）—— 它**逐条唯一**
 *   ⇒ 不像 WorkBuddy 那样还要把我们的清单按用户文件里的顺序排好
 *   （alignOurs 那一套）：合并层直接按 id 认出「我们那一条」。
 */
const DROID_MERGE = {
  mode: "array",
  key: "id",
  theirs: ["displayName"],
};

export const droidClient = {
  id: "droid",
  name: "Droid",
  protocol: "chat",
  note: "Factory 的 CLI（BYOK 自定义模型）",

  files: (ctx) => {
    const file = droidFile(ctx);
    const pid = ctx.providerId || "bai";
    return [
      {
        path: file,
        writes: () => {
          const pick = pickModel(ctx);
          const ours = (ctx.models || []).map((m) => entry(ctx, m, pid));
          return [
            /* ⚠ 合并层在写盘前把它与文件里的现值合并：
               用户自己的条目原样留着、**位置不变**，我们那几条**就地**合并
               （用户改过的 displayName 留着；地址/key/模型 id 换成我们的）。
               归属见 DROID_MERGE。 */
            { path: "customModels", value: ours, merge: DROID_MERGE },
            /* 当前用哪个模型（叶子：用户 sessionDefaultSettings 里的别的设置留着） */
            { path: "sessionDefaultSettings.model", value: `custom:${pid}/${pick.id}` },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "customModels");
          if (!r || !r.ok || !r.found || !Array.isArray(r.value)) return false;
          return r.value.some((e) => e && typeof e.id === "string" && e.id.startsWith(`custom:${pid}/`));
        },
      },
    ];
  },
};
