// src/server/clients/cline.mjs —— Cline 的 CLI
//
// ## 配置文件
//
//   ~/.cline/data/settings/providers.json（$CLINE_DIR / $CLINE_DATA_DIR 改了就是那儿）
//   ~/.cline/data/settings/models.json      （模型清单在它旁边）
//
// ## magpie 的对应
//
// internal/agent/cline.go。Cline 的 provider 都在 providers.json 里：
//
//   {"version":1,"lastUsedProvider":"<id>","modes":{},"providers":{"<id>":{
//     "settings":{"provider":"<id>","apiKey":…,"model":…,"baseUrl":…,
//       "headers":{…},"reasoning":{"effort":…}},
//     "updatedAt":…,"tokenSource":"manual"}}}
//
// 一个会话跑的是 lastUsedProvider 那个 provider 的模型。
//
// ⚠ **magpie 接管的是 Cline 内建的 openai-compatible provider**（不是自己新增
//   一个）：Cline 会拒绝 providers.json 里一个它不认识的 provider（"Unknown or
//   disabled provider"），而它内建的那个 openai-compatible 只列 gpt-4o。所以
//   magpie 把模型清单写进**另一个文件** models.json 里那个 provider 的位置：
//
//   {"version":1,"providers":{"openai-compatible":{
//     "provider":{"name":"…","baseUrl":"…","defaultModelId":"<模型 id>"},
//     "models":{"<模型 id>":{"id":…,"name":…,"capabilities":["streaming","tools"]}}}}}
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：providers.json 的 providers.openai-compatible（带 key、模型、地址、
//     User-Agent 头）、lastUsedProvider，以及 models.json 里那份模型清单。
//   · 没做：**effort**。magpie 写 settings.reasoning（{"enabled":true,"effort":…}）。
//     我们的接线上下文里没有 effort 这一项 —— 不猜，不写一个客户端不认的值。
//   · 没做：magpie 对 **VS Code 扩展**那一层的接线（globalState.json 的
//     actModeApiProvider / openAiBaseUrl… 与 secrets.json 的 openAiApiKey）。
//     我们只管 CLI 的这两个文件。
//   · 没做：magpie 对 **Cline 桌面版**那一层（它在 web view 的 localStorage 里
//     挑 provider 与模型，根本不读这两个文件）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { curValue, pickModel, envDir } from "./json-util.mjs";

/** magpie 接管的那个 provider 的 id（Cline 内建的那个 openai-compatible）。 */
const SLOT = "openai-compatible";

/** 配置文件在哪儿。 */
function clineFiles(ctx) {
  const dir = envDir("CLINE_DIR") || path.join(ctx.home, ".cline");
  const data = envDir("CLINE_DATA_DIR") || path.join(dir, "data");
  const settings = path.join(data, "settings");
  return {
    providers: path.join(settings, "providers.json"),
    models: path.join(settings, "models.json"),
  };
}

export const clineClient = {
  id: "cline",
  name: "Cline",
  protocol: "chat",
  note: "Cline 的 CLI（OpenAI 兼容 provider）",

  files: (ctx) => {
    const files = clineFiles(ctx);
    return [
      {
        /* providers.json 先写 —— 它是「用哪个 provider」的那一份；
           models.json 写失败时它已经写好了，底座会如实报错并留下备份。 */
        path: files.providers,
        writes: () => {
          const pick = pickModel(ctx);
          const entry = {
            settings: {
              provider: SLOT,
              apiKey: ctx.apiKey || "",
              model: pick.id,
              baseUrl: ctx.baseUrl,
              /* Cline 自己的请求只带 AI SDK 的 User-Agent，认不出是 Cline ——
                 这个头是 magpie 加的，一并照抄。 */
              headers: { "User-Agent": "cline" },
            },
            updatedAt: new Date().toISOString(),
            tokenSource: "manual",
          };
          const writes = [];
          /* version 只在缺的时候补 —— 用户自己写的版本号我们不改。 */
          if (!curValue(files.providers, "json", "version").existed) {
            writes.push({ path: "version", value: 1 });
          }
          writes.push({ path: `providers.${SLOT}`, value: entry });
          writes.push({ path: "lastUsedProvider", value: SLOT });
          return writes;
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, `providers.${SLOT}`);
          return !!(r && r.ok && r.found);
        },
      },
      {
        path: files.models,
        writes: () => {
          const pick = pickModel(ctx);
          const models = {};
          for (const m of ctx.models || []) {
            models[m.id] = {
              id: m.id,
              name: m.label || m.id,
              capabilities: ["streaming", "tools"],
            };
          }
          const writes = [];
          if (!curValue(files.models, "json", "version").existed) {
            writes.push({ path: "version", value: 1 });
          }
          writes.push({
            path: `providers.${SLOT}`,
            value: {
              provider: {
                name: ctx.providerName || "B.AI",
                baseUrl: ctx.baseUrl,
                defaultModelId: pick.id,
              },
              models,
            },
          });
          return writes;
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, `providers.${SLOT}`);
          return !!(r && r.ok && r.found);
        },
      },
    ];
  },
};
