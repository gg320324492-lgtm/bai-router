// src/server/clients/minimax-code.mjs —— MiniMax Code（MiniMax 的 mcode CLI 与桌面端）
//
// ## 配置文件
//
//   ~/.minimax/config.yaml（$MINIMAX_DATA_DIR 设了就用那儿）
//
// ## magpie 的对应
//
// internal/agent/minimax.go。
//
// ## MiniMax Code 的配置长什么样
//
//   defaultModel: "custom_provider:bai/sn/claude-opus-5"
//
//   custom_provider:                ← 第三方 provider 都在这儿
//     bai:
//       name: bai
//       kind: custom
//       enabled: true
//       api: openai-completions      ← 用哪种方言
//       options:
//         apiKey: "…"
//         baseURL: "http://127.0.0.1:15799"
//         authMode: api-key
//         headers:
//           User-Agent: minimax-code
//       models:                      ← 模型表，键是模型 id
//         sn/claude-opus-5:
//           name: Claude Opus 5
//           limit:
//             context: 128000
//
// ## 三件要说清的事
//
// ① **provider 的名字是「custom_provider:bai」**，配置里的键却是
//    `custom_provider.bai` —— 一个冒号一个点，magpie 那边就是这么写的
//    （mcodeProvider / mcodeEntry 两个常量）。
// ② **baseURL 不带 /v1**（magpie 写的是 gw）：MiniMax Code 自己会拼
//    /chat/completions。统一网关 /chat/completions 与 /v1/chat/completions
//    都答。
// ③ **模型表的键就是模型 id**（`sn/claude-opus-5`），不是「provider/模型」
//    —— MiniMax Code 把 `custom_provider:bai/` 拼在前面就成
//    `custom_provider:bai/sn/claude-opus-5`。
//
//    ⚠ magpie 那边模型表键用的是**扁平写法**（`bb-codex~gpt-6.1-sol`），
//    因为 MiniMax Code 规定「SubAgent 的模型」整个串里只能有一个斜杠
//    （#1387），而 magpie 的网关会把 `~` 还原成 `/`。
//    **我们的网关只认 `provider/档位`**，不认 `~` —— 所以这里用**原样的
//    模型 id**。代价是 defaultModel 那个串里有两个斜杠
//    （`custom_provider:bai/sn/claude-opus-5`）；MiniMax Code 按第一个斜杠
//    切分，provider = custom_provider:bai、model = sn/claude-opus-5，
//    正好对上模型表里的键。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：provider 条目（连模型表）、defaultModel。
//   · 做了 magpie 用 stash 做的那件事的**等价物**：defaultModel 原来的值由底座
//     备份，断开时只还原那一处。
//   · 没做：「模型表键写成斜杠的老写法搬成扁平写法、老的那份留着但关掉」
//     （magpie 的 #1387 兼容层）。
//   · 没做：thinking.effortOptions / defaultEffort（每个模型的思考档）与
//     capabilities.support_image —— **我们不知道**（档位 provider 无关，能力逐家
//     不同）⇒ 那些键**不写**（不写 false 也不写 true；理由见下面代码注释）。
//   · 没做：defaultLightModel、memory.captureModel、memory.consolidationModel
//     这几个「也指着模型」的设置（magpie 一并搬）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel, envDir } from "./util.mjs";
import { gw, labelOf } from "./client-utils.mjs";
import "./formats-yaml.mjs";

/** MiniMax Code 的数据目录：$MINIMAX_DATA_DIR，否则 ~/.minimax。 */
function minimaxDir(ctx) {
  return envDir("MINIMAX_DATA_DIR") || path.join(ctx.home, ".minimax");
}

/** 模型表：键是模型 id。逐键写（用户自己在别处的模型留着不动）。 */
function modelTable(ctx) {
  const out = [];
  for (const m of ctx.models || []) {
    const t = `custom_provider.bai.models."${m.id}"`;
    out.push({ path: `${t}.name`, value: labelOf(m) });
    /* ⚠ 128000 是**兜底约定**不是实测值：有真值用真的（m.context），真实上限
       一旦有来源（渠道目录的 max_input_tokens 之类）就用那个顶掉。 */
    out.push({ path: `${t}.limit.context`, value: m.context || 128000 });
    /* ⚠ **能力项我们不知道 ⇒ 不写那个键**（不是写 false、也不是写 true）：
       我们的模型 id 是**档位**（provider 无关），而能力由**映射到哪家上游**决定
       （同一档位在 sn 映射到 glm-5.2、在 wb 映射到 hy3，图片与思考逐家不同）
       ⇒ 断言「不支持」等于替**所有**上游下结论，我们没有依据。
       「不写」与「写 false」对 Go 客户端**等价**（读不到 ⇒ 取零值），但「不写」
       把那个**位置空着** ⇒ 将来有了真值是「**加一个键**」，而写 false 就占着它。
       ⚠ **更不能写 true** —— 那会让用户真去发一个上游不认的思考参数，当场报错。
       真值随 T15-c 的「模型元数据下发」到位。 */
  }
  return out;
}

export const minimaxCodeClient = {
  id: "minimax-code",
  name: "MiniMax Code",
  protocol: "chat",
  note: "MiniMax 的 mcode CLI 与桌面端",

  files: (ctx) => {
    const file = path.join(minimaxDir(ctx), "config.yaml");
    return [
      {
        path: file,
        format: "yaml",
        writes: () => {
          const pick = pickModel(ctx);
          return [
            { path: "custom_provider.bai.name", value: "bai" },
            { path: "custom_provider.bai.kind", value: "custom" },
            { path: "custom_provider.bai.enabled", value: true },
            /* 统一网关说的是 OpenAI 的 chat completions */
            { path: "custom_provider.bai.api", value: "openai-completions" },
            { path: "custom_provider.bai.options.apiKey", value: ctx.apiKey || "" },
            { path: "custom_provider.bai.options.baseURL", value: gw(ctx) },
            { path: "custom_provider.bai.options.authMode", value: "api-key" },
            { path: "custom_provider.bai.options.headers.User-Agent", value: "minimax-code" },
            ...modelTable(ctx),
            { path: "defaultModel", value: `custom_provider:bai/${pick.id}` },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "custom_provider.bai.options.baseURL");
          return !!(r && r.ok && r.found);
        },
      },
    ];
  },
};
