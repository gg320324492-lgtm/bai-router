// src/server/clients/pi.mjs —— Pi
//
// ## 配置文件
//
//   ~/.pi/agent/settings.json（$PI_CODING_AGENT_DIR 设了就用那儿；"~" 展开成家目录）
//   ~/.pi/agent/models.json
//
// ## magpie 的对应
//
// internal/agent/agents.go 的 `piLikeKeyed`（Pi 那一族：Pi、OmO、Prime Agent
// 都用这一份形状）。Pi 的 provider 在 **models.json** 里：
//
//   {"providers":{"magpie":{
//      "name":"magpie","baseUrl":"…","api":"openai-completions","apiKey":"…",
//      "compat":{"sendSessionAffinityHeaders":true},
//      "models":[{"id":"…","name":"…","reasoning":…,"contextWindow":…,"maxTokens":…}]}}}
//
// 而**用哪个 provider、哪个模型**在 settings.json 里：
//
//   {"defaultProvider":"magpie","defaultModel":"magpie/<模型 id>",
//    "enabledModels":["…"],"defaultThinkingLevel":"…"}
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：models.json 的 providers.<我们的 id>（含模型清单）+ settings.json 的
//     defaultProvider / defaultModel。
//   · 做了 magpie 的 enabledModels 处理：**用户自己有那份清单时**，把我们的模型
//     加进去（Pi 的 Ctrl+P 循环与 /scoped-models 只认清单里的东西 —— 不加，
//     选中的模型永远轮不到）；**用户没有那份清单时，不新建**（magpie：
//     "never makes one where there is none"）。
//   · 没做：defaultThinkingLevel（我们的接线上下文里没有「这个档位支持哪些
//     effort」这一项 —— 不猜，不写一个 Pi 不认的档位）。
//   · 没做：compat.sendSessionAffinityHeaders（magpie 用来在请求里带
//     session 亲和头，好让它的用量台账认得出是同一场会话 —— 我们的网关不靠它）。
//   · 没做：contextWindow / maxTokens / cost（接线上下文里没有上下文窗口与
//     单价这一项 —— 写假的会让 Pi 提前压缩上下文、或者算错花费）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { curValue, pickModel, envDir } from "./json-util.mjs";

/** Pi 的 agent 目录。 */
function piDir(ctx) {
  const d = envDir("PI_CODING_AGENT_DIR");
  if (d) {
    /* Pi 认 "~" 当家目录（agents.go 的 homeDir） */
    if (d === "~" || d.startsWith("~/") || d.startsWith("~\\")) {
      return path.join(ctx.home, d.slice(1));
    }
    if (path.isAbsolute(d)) return path.resolve(d);
  }
  return path.join(ctx.home, ".pi", "agent");
}

export const piClient = {
  id: "pi",
  name: "Pi",
  protocol: "chat",
  note: "Pi（provider/model 那种形状）",

  files: (ctx) => {
    const dir = piDir(ctx);
    const settings = path.join(dir, "settings.json");
    const models = path.join(dir, "models.json");
    const pid = ctx.providerId || "bai";
    return [
      {
        path: models,
        writes: () => {
          pickModel(ctx);
          const provider = {
            name: ctx.providerName || "B.AI",
            /* Pi 按 baseUrl + /chat/completions 问 —— 统一网关答这个路径。 */
            baseUrl: ctx.baseUrl,
            /* 说 Chat Completions 方言（Pi 的 api 字段就是这么写的） */
            api: "openai-completions",
            apiKey: ctx.apiKey || "",
            models: (ctx.models || []).map((m) => ({
              id: m.id,
              name: m.label || m.id,
            })),
          };
          return [{ path: `providers.${pid}`, value: provider }];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, `providers.${pid}`);
          return !!(r && r.ok && r.found);
        },
      },
      {
        path: settings,
        writes: () => {
          const pick = pickModel(ctx);
          const ref = `${pid}/${pick.id}`;
          const writes = [
            { path: "defaultProvider", value: pid },
            { path: "defaultModel", value: ref },
          ];
          /* enabledModels 是 Pi 的「这些模型可用」的清单。用户自己有才补 ——
             没有就不新建（magpie 的规矩：那份清单是用户的）。 */
          const scope = curValue(settings, "json", "enabledModels");
          if (scope.existed && Array.isArray(scope.value) && scope.value.length) {
            const refs = (ctx.models || []).map((m) => `${pid}/${m.id}`);
            const kept = scope.value.filter((x) => typeof x === "string" && !refs.includes(x));
            writes.push({ path: "enabledModels", value: [...kept, ...refs] });
          }
          return writes;
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "defaultProvider");
          return !!(r && r.ok && r.found && r.value === pid);
        },
      },
    ];
  },
};
