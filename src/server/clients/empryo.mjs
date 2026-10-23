// src/server/clients/empryo.mjs —— Empryo
//
// ## 配置文件
//
//   ~/.empryo/config.json
//
// ## magpie 的对应
//
// internal/agent/empryo.go。Empryo 自有的 provider 是 "providers" 这个**数组**：
//
//   {"providers":[{"id":"…","name":"…","baseURL":"…","envVar":"…",
//      "models":[…],"modelsAPI":"…"}],
//    "defaultModel":"<provider id>/<模型 id>"}
//
// provider 是 OpenAI 兼容的端点：它从 modelsAPI（没有就 baseURL + "/models"）
// 列模型，问 baseURL + "/chat/completions"。**没有 envVar 就不会把用户的 key
// 发出去**。会话从哪个模型起是 defaultModel（在第一个 "/" 处拆开）。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：providers 里我们那一条（id = 我们的 provider id）+ defaultModel。
//   · 做了 magpie 的**合并**：用户自己的 provider 留在数组里（magpie：
//     "The user's providers and other keys are left as they are"）。
//   · 做了**保留用户手改**：用户在 Empryo 里改过的 **provider 显示名**留着；
//     用户自己加的 provider 原样留着、位置不变；用户自己填的 `envVar` 留着
//     （Empryo 靠它决定发不发 key）。归属表见 EMPRYO_MERGE。
//   · 没做：envVar —— magpie 也没写（它写的话，Empryo 会去找那个环境变量；
//     我们的网关本地不校验 key，不给 envVar 正合适）。
//   · ⚠ **注意**：Empryo 只把「baseURL 有应答（2xx / 401 / 403）」的 provider
//     列出来。统一网关目前只有 GET /v1/models 答 200，其余 GET 答 405 ——
//     所以 Empryo **可能不列**我们的 provider（这是网关那一侧的事：
//     要么网关也答 GET /v1，要么这一行先不接）。这一层照样把配置写好。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel } from "./json-util.mjs";

/**
 * EMPRYO_MERGE —— providers 数组里**我们那一条**的字段归属（合并层的 spec）。
 *
 * 通用合并层（merge-policy.mjs，底座 base.mjs 调用）在写盘前把「我们要写的值」
 * 与「用户文件里的现值」合并。这个 spec 就是 Empryo 的**归属表**：
 *
 * | 字段 | 归谁 | 为什么 |
 * | --- | --- | --- |
 * | `name` | **用户的** | 用户在 Empryo 里改过的 provider 显示名留着（设计稿 §2.2(a)） |
 * | `id` | 我们的 | 认出「我们那一条」的钥匙（magpie 同：empryo.go 里按 id 认） |
 * | `baseURL` / `modelsAPI` | 我们的 | 地址是机器该管的（§2.2(a)）—— 不比对、照写 |
 * | 我们没写的键（`envVar` / `models`…） | **保留用户的** | 弱保留那一层（magpie 的 theirsKept）—— Empryo 的 `envVar` 决定它**发不发 key**，用户自己填的要留着 |
 */
const EMPRYO_MERGE = {
  mode: "array",
  key: "id",
  theirs: ["name"],
};

export const empryoClient = {
  id: "empryo",
  name: "Empryo",
  protocol: "chat",
  note: "Empryo（OpenAI 兼容 provider 数组）",

  files: (ctx) => {
    const file = path.join(ctx.home, ".empryo", "config.json");
    const pid = ctx.providerId || "bai";
    return [
      {
        path: file,
        writes: () => {
          const pick = pickModel(ctx);
          const mine = {
            id: pid,
            name: ctx.providerName || "B.AI",
            /* Empryo 问 baseURL + "/chat/completions" ⇒ 统一网关答这个路径。 */
            baseURL: ctx.baseUrl,
            /* 列模型的地方：统一网关的 GET /v1/models。 */
            modelsAPI: `${ctx.baseUrl}/v1/models`,
          };
          /* 用户自己的 provider 留着（我们那一条按 id 覆盖）。 */
          return [
            /* ⚠ 合并层在写盘前把它与文件里的现值合并：用户自己的 provider 原样
               留着、位置不变，我们那一条**就地**合并（用户改过的 name 留着；
               地址换成我们的）。归属见 EMPRYO_MERGE。 */
            { path: "providers", value: mine, merge: EMPRYO_MERGE },
            { path: "defaultModel", value: `${pid}/${pick.id}` },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "providers");
          if (!(r && r.ok && r.found && Array.isArray(r.value))) return false;
          return r.value.some((p) => p && p.id === pid);
        },
      },
    ];
  },
};
