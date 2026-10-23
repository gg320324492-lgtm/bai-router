// src/server/clients/client-utils.mjs —— 网关地址与模型引用的共用小工具
//
// ## 网关地址：带不带 /v1
//
// ctx.baseUrl 是 `http://127.0.0.1:<gatewayPort>`（**不带** /v1）。统一网关
// 两个路径都答（`/chat/completions` 与 `/v1/chat/completions`），所以带不带都能通。
//
// 但**照抄 magpie 的写法更保险**：magpie 的每个客户端都写死了自己要哪一种，
// 客户端自己会在后面拼 `/chat/completions` 或 `/responses`：
//   · at.v1()  = gw + "/v1"   ← Kimi / Goose / Grok / Morph / Hermes / StepCode / Reasonix
//   · at.gw()   = gw           ← MiniMax Code
// 本模块把这两条各自叫 gwV1(ctx) 与 gw(ctx)，别混。
//
// ## 模型 id：provider/档位
//
// ctx.models 里每一项的 id 已经是 `provider/档位`（例如 `sn/claude-opus-5`）——
// **不要**在这里再加工。客户端要发给网关的就是它。
// 客户端内部把「provider 与模型」分开写的地方（Kimi 的 [models."…"]、Grok 的
// [model."…"]、omp 的 modelRoles）用的是 **modelRef**：providerId + "/" + 模型 id，
// 因为那些客户端自己会在前面拼上 provider 名（magpie 那边是 "magpie/" + 目录 id）。
//
// ## 与 util.mjs 的分工
//
// util.mjs（主会话那份）放的是「读用户当前配置」那一类工具；本模块放的是
// 「怎么写地址、怎么写模型引用」这一类 —— 两边不重叠。

/** 网关根地址（不带 /v1）。 */
export function gw(ctx) {
  return String((ctx && ctx.baseUrl) || "");
}

/** 网关的 /v1 地址。 */
export function gwV1(ctx) {
  return gw(ctx) + "/v1";
}

/** 客户端的 provider 名（我们这层的 providerId，默认 "bai"）。 */
export function providerId(ctx) {
  return String((ctx && ctx.providerId) || "bai");
}

/** 客户端的 provider 显示名。 */
export function providerName(ctx) {
  return String((ctx && ctx.providerName) || "B.AI");
}

/** 目录里全部模型的 id。 */
export function modelIds(ctx) {
  return ((ctx && ctx.models) || []).map((m) => m.id);
}

/** 模型 id 的显示名（没有 label 就用 id）。 */
export function labelOf(m) {
  if (!m) return "";
  return String(m.label || m.id || "");
}

/**
 * modelRef —— 客户端自己拼 provider 时的那个写法：`bai/sn/claude-opus-5`。
 *
 * Kimi 的模型表叫 `[models."bai/sn/claude-opus-5"]`、Grok 的叫
 * `[model."bai/sn/claude-opus-5"]`、omp 的 modelRoles 写 `bai/sn/claude-opus-5`
 * —— 都是「客户端的 provider 名 + 我们的模型 id」。
 */
export function modelRef(ctx, m) {
  if (!m) return "";
  return providerId(ctx) + "/" + m.id;
}
