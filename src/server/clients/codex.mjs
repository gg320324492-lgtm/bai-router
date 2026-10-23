// src/server/clients/codex.mjs —— Codex（OpenAI 的 CLI）
//
// ## 配置文件
//
//   ~/.codex/config.toml
//
// ## magpie 的对应
//
// internal/agent/codex.go。Codex 只说 **OpenAI Responses** 规范，而本仓的
// 统一网关**早就认这个协议**（`/v1/responses`，见 src/server/protocols.mjs）——
// 也就是说它差的是「把客户端的配置文件写好」，不是「网关听不懂它」。
//
// ## Codex 的配置长什么样
//
//   model_provider = "bai"                     ← 用哪一家
//   model = "sn/claude-opus-5"                  ← 用哪一档（provider/档位 写法）
//
//   [model_providers.bai]
//   name = "B.AI"
//   base_url = "http://127.0.0.1:15799/v1"     ← ⚠ **带 /v1**：Codex 自己拼 /responses
//   wire_api = "responses"                     ← 它说哪种规范
//   experimental_bearer_token = "…"            ← 鉴权用的头
//
// ## 三件要说清的事
//
// ① **base_url 带 /v1**。Codex 打的是 `base_url + /responses`，所以 base_url
//    要指到 `/v1`；网关答 `/v1/responses` ✓。而 Gemini CLI 那边**不带** /v1
//    （它自己拼 `/v1beta/…`）—— 两者不一样，别抄错。
//
// ② **模型 id 写完整**（`provider/档位`）。网关按前缀分流，没有前缀一律 400。
//
// ③ **没写模型清单**（magpie 写 `model_catalog_json` 指向一份自己的清单，
//    让用户在 Codex 的 /model 里能挑）。那是**深度定制**的一部分
//    （见 docs/replication-plan.md 的 T15-c）；这一层只写死一个模型，
//    够用。想换模型：断开重接，或直接在 Codex 里改 `model` 那行。
//
// ## 没做的（与 magpie 的差别，明说）
//
//   · `model_catalog_json` 清单文件（上面 ③ 说了）
//   · `http_headers`（那个头是让 Codex 自带的图片工具能用的；缺了只是不能画，
//     别的照常）
//   · `capabilities`、后台压缩那套（magpie 写的时候会把用户自己那份保留下来）
//   · magpie 那个「Codex 自己的 multi_agent_v2 开着会抢多智能体」的通知
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";

/** 我们用的 provider id（也是 TOML 里的表名）。 */
const PID = "bai";

/**
 * providerTable —— `[model_providers.bai]` 那张表。
 *
 * `base_url` **带 /v1**（理由见文件头 ①）。
 */
function providerTable(ctx) {
  return {
    name: ctx.providerName || "B.AI",
    base_url: String(ctx.baseUrl || "").replace(/\/+$/, "") + "/v1",
    wire_api: "responses",
    experimental_bearer_token: ctx.apiKey || "",
  };
}

export const codexClient = {
  id: "codex",
  name: "Codex",
  protocol: "responses",
  note: "OpenAI 的 CLI（说 Responses 规范）",

  files: (ctx) => [
    {
      path: path.join(ctx.home, ".codex", "config.toml"),
      format: "toml",
      /* ⚠⚠ **provider 表逐键写**，不整块写（这是 TOML 的一个硬约束）：
       *   用户自己的 config.toml 里很可能已经有 `[model_providers.other]` ——
       *   它**隐式定义**了表 `model_providers`。这时再写一个 `[model_providers]`
       *   段 + 内联表 = **同一张表被定义两次 = 非法 TOML** ⇒ 解析器报错 ⇒
       *   **Codex 读不了整个配置文件**（连他的 MCP 配置一起废掉）。
       *   逐键写产出的是 `[model_providers.bai]` **子表段**，父表只被隐式定义
       *   一次 ⇒ 无论用户文件里有什么都是合法的。
       *   （这条也写进了 docs/replication-plan.md 的教训里。） */
      writes: () => {
        const t = providerTable(ctx);
        const out = [
          { path: "model_provider", value: PID },
          { path: "model", value: (ctx.models && ctx.models[0] && ctx.models[0].id) || "" },
        ];
        for (const [k, v] of Object.entries(t)) {
          out.push({ path: `model_providers.${PID}.${k}`, value: v });
        }
        return out;
      },
      wired: (text, fmt) => {
        const r = fmt.getPath(text, "model_provider");
        return !!(r && r.ok && r.found && String(r.value) === PID);
      },
    },
  ],
};
