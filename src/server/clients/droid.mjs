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
import { curValue, pickModel, envDir } from "./json-util.mjs";

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
    /* Droid 默认认为 Chat 的模型能看图 —— 我们的档位支不支持图像我们不知道，
       所以明说「不支持」：宁可让它少发图，也别发一个网关不收的字段。 */
    noImageSupport: true,
  };
}

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
          /* 用户自己的条目留在前面。认「是不是我们的」靠 id 前缀 custom:<pid>/。 */
          const list = curValue(file, "json", "customModels");
          const kept = (list.existed && Array.isArray(list.value))
            ? list.value.filter((e) => !(e && typeof e.id === "string" && e.id.startsWith(`custom:${pid}/`)))
            : [];
          return [
            { path: "customModels", value: [...kept, ...ours] },
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
