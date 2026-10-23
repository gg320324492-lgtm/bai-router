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
import { curValue, pickModel } from "./json-util.mjs";

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
          const list = curValue(file, "json", "providers");
          const kept = (list.existed && Array.isArray(list.value))
            ? list.value.filter((p) => !(p && p.id === pid))
            : [];
          return [
            { path: "providers", value: [...kept, mine] },
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
