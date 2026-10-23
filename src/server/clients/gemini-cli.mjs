// src/server/clients/gemini-cli.mjs —— Gemini CLI（Google 的 CLI）
//
// ## 配置文件
//
//   ~/.gemini/settings.json   —— 认证方式 + 选哪个模型
//   ~/.gemini/.env            —— 网关地址 + 凭据（Gemini CLI 自己会读这个文件）
//
// ## magpie 的对应
//
// internal/agent/gemini.go。Gemini CLI 只说 **Google 自己的规范**，而本仓的
// 统一网关**早就认这个协议**（`/v1beta/models/{model}:generateContent`，见
// src/server/protocols.mjs）—— 差的是「把客户端的配置文件写好」。
//
// ## 配置长什么样
//
//   settings.json：
//     security.auth.selectedType = "gemini-api-key"   ← 走 API key，而不是 Google 登录
//     model.name                 = "sn/claude-opus-5" ← provider/档位
//
//   .env（dotenv）：
//     GOOGLE_GEMINI_BASE_URL = http://127.0.0.1:15799   ← ⚠ **不带 /v1**
//     GEMINI_API_KEY         = …
//
// ## 三件要说清的事
//
// ① **base_url 不带 /v1**。Gemini CLI 自己拼 `/v1beta/models/…`，所以这里给
//    网关的根地址就够。（Codex 那边**要带** /v1 —— 它自己拼 `/responses`。
//    两者不一样，别抄错。）
//
// ② **模型名在路径里**：`provider/档位` 里的斜杠会被 URL 编码成 `%2F`，
//    网关那边会解码回来 ✓（见 protocols.mjs 的 geminiProtocol.modelIdOf）。
//
// ③ **两个文件都要写**。只改 settings.json 不改 .env 的话，Gemini CLI 仍然
//    按 Google 登录走我们的地址 —— 那必然失败。
//
// ## 没做的（与 magpie 的差别，明说）
//
//   · magpie 有一整套「接管 / 不接管」的判定（`routed()`）：它会认出「用户自己
//     把 base_url 指到了别处」并尊重用户的选择。这层只看「我们自己接的」。
//   · magpie 的 stash（把用户原来的 .env 与 auth 方式存起来）：这层的
//     **路径级备份**做的是同一件事 —— 断开时只还原我们写过的那几个键。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";

export const geminiCliClient = {
  id: "gemini-cli",
  name: "Gemini CLI",
  protocol: "gemini",
  note: "Google 的 CLI（说 Gemini 规范）",

  files: (ctx) => [
    {
      path: path.join(ctx.home, ".gemini", "settings.json"),
      format: "json",
      writes: () => [
        { path: "security.auth.selectedType", value: "gemini-api-key" },
        { path: "model.name", value: (ctx.models && ctx.models[0] && ctx.models[0].id) || "" },
      ],
      wired: (text, fmt) => {
        const r = fmt.getPath(text, "security.auth.selectedType");
        return !!(r && r.ok && r.found && String(r.value) === "gemini-api-key");
      },
    },
    {
      path: path.join(ctx.home, ".gemini", ".env"),
      format: "dotenv",
      writes: () => [
        /* ⚠ dotenv 的键**没有层级** —— 路径就是键名本身（base.mjs 的点分路径
           *   对它是单段）*。 */
        { path: "GOOGLE_GEMINI_BASE_URL", value: String(ctx.baseUrl || "").replace(/\/+$/, "") },
        { path: "GEMINI_API_KEY", value: ctx.apiKey || "" },
      ],
      wired: (text, fmt) => {
        const r = fmt.getPath(text, "GOOGLE_GEMINI_BASE_URL");
        return !!(r && r.ok && r.found && String(r.value || "").includes("127.0.0.1"));
      },
    },
  ],
};
