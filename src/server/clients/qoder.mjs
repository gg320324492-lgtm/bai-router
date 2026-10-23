// src/server/clients/qoder.mjs —— Qoder 的 CLI（国际版）
//
// ## 配置文件
//
//   ~/.qoder/settings.json（$QODER_CONFIG_DIR 设了就用那儿）
//
// ## magpie 的对应
//
// internal/agent/qoder.go。Qoder 的自有 provider 是 "providers" 里的一个条目，
// 模型按 "<provider>/<model>" 挑：
//
//   {"providers":{"<id>":{
//      "displayName":"…","protocol":"openai","baseUrl":"…","apiKey":"…",
//      "model":"<模型 id>",
//      "models":[{"model":"<模型 id>","displayName":"…",
//         "contextWindow":…,"maxOutputTokens":…,
//         "capabilities":{"tools":true,"vision":…,"thinking":{…}}}]}},
//    "model":{"name":"<provider>/<模型 id>","reasoningEffort":…,
//      "preferences":{"<provider>/<模型 id>":{"reasoning":{"effort":…}}}}}
//
// 一个 openai 的 provider 是被 baseUrl + /chat/completions 问的；带 reasoning_effort
// 的模型才带那一句。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：providers 里我们那一条（含模型清单）+ model.name（当前用哪个）。
//   · 没做：**effort**。magpie 把「这个模型用多大力思考」写进 model.preferences
//     （1.1.6x 之后）或 model.reasoningEffort（更早的 Qoder）。我们的接线上下文
//     里没有「这个档位支持哪些 effort」这一项 —— **不猜**：宁可先不给，
//     也别写一个客户端不认的 effort 值。
//   · 没做：magpie 的 qoderKept（用户在那个 provider 上自己设的路由 —— 压缩/
//     摘要/子代理各用哪个模型、首包超时等 —— 保留着）。我们写 provider 那一条时
//     是**整条覆盖**的；用户改过的那些字段会在断开时由底座原样还回去。
//   · 没做：magpie 的 Sync（目录变了刷新模型清单）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel, envDir } from "./json-util.mjs";

/**
 * qoderDecl —— 造一份 Qoder 的声明。
 *
 * 国际版（Qoder）与国行（Qoder CN）是**同一个 CLI 的两个站点**：配置形状一样，
 * 只是目录、账号与计划不同（国行要 Qoder CN 计划的 BYOK）。所以两个声明共用
 * 这一份代码，只是参数不同 —— 免得两份抄着改、抄岔了。
 */
export function qoderDecl({ id, name, note, env, dirName }) {
  return {
    id,
    name,
    protocol: "chat",
    note,

    files: (ctx) => {
      const dir = envDir(env) || path.join(ctx.home, dirName);
      const file = path.join(dir, "settings.json");
      const pid = ctx.providerId || "bai";
      return [
        {
          path: file,
          writes: () => {
            const pick = pickModel(ctx);
            const models = (ctx.models || []).map((m) => ({
              model: m.id,
              displayName: m.label || m.id,
              /* ⚠ 图像与思考**不写**这两个键：「我们不知道」≠「不支持」——
                 我们的模型 id 是**档位**（provider 无关），支不支持图像/思考由**映射到
                 哪家上游**决定（逐家不同）⇒ 写 false 是断言，写 true 是撒谎
                 （用户真去发一个上游不认的思考参数，当场报错）。键不写 ⇒ Qoder 用
                 自己的默认（保守），将来有了真值（T15-c 的「模型元数据下发」）再加。 */
              capabilities: { tools: true },
            }));
            const provider = {
              displayName: ctx.providerName || "B.AI",
              /* openai = 说 Chat Completions 方言 ⇒ 统一网关的 /chat/completions */
              protocol: "openai",
              baseUrl: ctx.baseUrl,
              apiKey: ctx.apiKey || "",
              /* 这个 provider 起在哪个模型上（裸的模型 id，不带 provider 前缀） */
              model: pick.id,
              models,
            };
            return [
              /* providers.<我们的 id> —— 叶子：我们只占这一个格子，
                 用户自己的 provider 一个都不动。 */
              { path: `providers.${pid}`, value: provider },
              /* 当前用哪个模型 —— "<provider>/<模型 id>"（Qoder 认这个写法）。
                 写叶子：用户 model 里的 reasoningEffort / preferences 保留。 */
              { path: "model.name", value: `${pid}/${pick.id}` },
            ];
          },
          wired: (text, fmt) => {
            const r = fmt.getPath(text, `providers.${pid}`);
            return !!(r && r.ok && r.found);
          },
        },
      ];
    },
  };
}

export const qoderClient = qoderDecl({
  id: "qoder",
  name: "Qoder",
  note: "Qoder 的 CLI（国际版）",
  env: "QODER_CONFIG_DIR",
  dirName: ".qoder",
});
