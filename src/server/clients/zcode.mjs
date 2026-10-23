// src/server/clients/zcode.mjs —— ZCode（智谱的桌面端）
//
// ## magpie 的对应
//
// internal/agent/zcode.go（那个文件有 600 多行 —— magpie 把「ZCode 3.14 的
// provider_config.json rules 形状」「原生联网搜索的 stash」「用户手改的变体」
// 全做进去了）。
//
// 本仓先做**能用**的那一层：写 `config.json` 的 provider 块（OpenCode 那种
// 形状），让 ZCode 的模型选择器里出现 B.AI 的模型。
//
// ## ZCode 的配置长什么样
//
// ~/.zcode/v2/config.json：
//   {"provider":{"<id>":{
//      "name":"B.AI",
//      "kind":"openai-compatible",      ← 说哪种方言（anthropic / openai-compatible / openai）
//      "enabled":true,
//      "source":"custom",
//      "options":{"apiKey":"…","baseURL":"http://127.0.0.1:15799"},
//      "models":{"<模型 id>":{"name":"…","limit":{…},"modalities":{…}}}}}}
//
// ## 三件要说清的事
//
// ① **模型 id 写完整**（`provider/档位`，例如 `sn/claude-opus-5`）。这是本仓
//    网关的模型 id 约定：客户端拿这个 id 直接发过来，我们认得。
// ② **baseURL 不带 /v1**：ZCode 的 openai-compatible provider 自己拼
//    `/chat/completions`。统一网关两个路径都答（`/chat/completions` 与
//    `/v1/chat/completions`），所以这里给不带 /v1 的根地址就够。
// ③ **ZCode 3.14 换了地方**：它把 provider 搬到 `provider_config.json`
//    （rules 形状），`config.json` 只在启动时 import 一次。所以**新装的 3.14+
//    可能要重启一次 ZCode 才看得到**。这一点写在 detail 里 —— 不假装一次就配好。
//
// ## 纪律
//
//   · 凭据不落在这个文件里（声明是分发物）；key 由接线时给。
//   · 写之前先备份「provider.<id>」这一处的原值（base.mjs 统一管）。

import path from "node:path";

/** 这个客户端的 provider 块（按 ZCode 的形状）。 */
function providerBlock(ctx) {
  const models = {};
  for (const m of ctx.models || []) {
    models[m.id] = {
      name: m.label || m.id,
      /* 没有上限就不写这两个字段 —— 客户端会用自己的默认值，
         写死一个假的上限反而会让它把回复截短。 */
      limit: m.context ? { context: m.context } : {},
      modalities: { input: ["text"], output: ["text"] },
    };
  }
  return {
    name: ctx.providerName || "B.AI",
    /* 我们说 chat 方言 ⇒ ZCode 的 openai-compatible（magpie 的 zcodeKinds：
       anthropic-messages ⇒ anthropic，openai-chat-completions ⇒ openai-compatible）。 */
    kind: "openai-compatible",
    enabled: true,
    source: "custom",
    options: { apiKey: ctx.apiKey || "", baseURL: ctx.baseUrl || "" },
    models,
  };
}

export const zcodeClient = {
  id: "zcode",
  name: "ZCode",
  protocol: "chat",
  note: "智谱的桌面端（OpenCode 那种 provider 形状）",

  files: (ctx) => [
    {
      path: path.join(ctx.home, ".zcode", "v2", "config.json"),
      writes: () => [
        { path: `provider.${ctx.providerId || "bai"}`, value: providerBlock(ctx) },
      ],
      wired: (text, fmt) => {
        const r = fmt.getPath(text, `provider.${ctx.providerId || "bai"}`);
        return !!(r && r.ok && r.found);
      },
    },
  ],
};
