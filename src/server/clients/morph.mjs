// src/server/clients/morph.mjs —— Mister Morph（morph）
//
// ## 配置文件
//
//   ~/.morph/config.yaml（或 $MISTER_MORPH_CONFIG 指的那个文件）
//
// ## magpie 的对应
//
// internal/agent/morph.go。
//
// ## ⚠ 形状的核对程度
//
//   **形状照 magpie（internal/agent/<name>.go），本机没装这个客户端 ⇒ 未在本机核对过。**
//   本机装了并核对过真实配置的只有 MiniMax Code（~/.minimax/config.yaml）与
//   Hermes Agent（~/.hermes/config.yaml）—— 见那两个文件里的说明。
//
// ## morph 的配置长什么样
//
//   llm:
//     inference_provider: openai_response_compatible   ← 只有这一种方言可选
//     endpoint: http://127.0.0.1:15799/v1
//     api_key: "…"
//     model: sn/claude-opus-5
//     context_window_tokens: 128000
//     headers:
//       User-Agent: mistermorph
//
// ## 三件要说清的事
//
// ① **morph 没有「provider 列表」可加** —— 它只有 llm 这一块（magpie 的原话：
//    "It has no list of providers to add one to, so magpie takes llm over"）。
//    所以 llm 下面那几个键（地址、key、模型、窗口、User-Agent）都是我们的；
//    llm.profiles 与 llm.routes 是用户的，我们不碰。
// ② **inference_provider 是 morph 自己的枚举值**，能对上我们网关的只有
//    openai_response_compatible（OpenAI 的 Responses API）。magpie 也是这么写的；
//    我们的网关 /v1/responses 也答（protocols.mjs 里那条）。
// ③ **llm.provider 不用写**：morph 自己从 inference_provider 推出来
//    （magpie 特意没动它）。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：llm 下面那几处。
//   · 做了 magpie 用 stash 做的那件事的**等价物**：那几处的原值由底座备份，
//     断开时只还原那几处。
//   · 没做：llm.reasoning_effort（思考档）—— 我们这层不知道模型的档位。
//   · 没做：llm.profiles 与 llm.routes（用户的）：magpie 不动它们（路由到别的
//     profile 就让它路由过去）。我们只写上面那几个键，也不碰它们。
//
// ## 保留用户手改（通用合并层）
//
// | 字段 | 归谁 | 为什么 |
// | --- | --- | --- |
// | `llm.context_window_tokens` | **用户的** | 窗口是「用户可能手改」的字段（设计稿 §2.2(a)）—— 我们那个值是兜底不是真值 —— 根模式 |
// | `llm.inference_provider` / `endpoint` / `api_key` / `model` / `headers.User-Agent` | 我们的 | 方言、地址、令牌与模型 id 是机器该管的（§2.2(a)）—— 照写、不比对 |
// | `llm` 下我们没写的键（profiles / routes…） | **保留用户的** | 弱保留那一层（我们逐键写，本来就不碰它们） |
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel } from "./util.mjs";
import { gwV1 } from "./client-utils.mjs";
import "./formats-yaml.mjs";

/** morph 的配置文件：$MISTER_MORPH_CONFIG 指的那个文件，否则 ~/.morph/config.yaml。 */
function morphConfig(ctx) {
  const env = String(process.env.MISTER_MORPH_CONFIG || "").trim();
  if (env) return path.resolve(env);
  return path.join(ctx.home, ".morph", "config.yaml");
}

export const morphClient = {
  id: "morph",
  name: "Mister Morph",
  protocol: "responses",
  note: "morph（llm 那一块由路由台接管）",

  files: (ctx) => {
    const file = morphConfig(ctx);
    return [
      {
        path: file,
        format: "yaml",
        writes: () => {
          const pick = pickModel(ctx);
          return [
            { path: "llm.inference_provider", value: "openai_response_compatible" },
            { path: "llm.endpoint", value: gwV1(ctx) },
            { path: "llm.api_key", value: ctx.apiKey || "" },
            { path: "llm.headers.User-Agent", value: "mistermorph" },
            { path: "llm.model", value: pick.id },
            /* ⚠ 128000 是**兜底约定**不是实测值：有真值用真的（pick.context），
               真实上限一旦有来源（渠道目录的 max_input_tokens 之类）就用那个顶掉。
               ⚠ **窗口归用户**（设计稿 §2.2(a)：窗口是「用户可能手改」的字段）——
               *   那个兜底值不是真值，拿它盖掉用户自己调的窗口会让 morph
               *   **提前截断**上下文（宁可报大不要报小）。代价见 §2.2(d)：
               *   真值到位后这个值不会自动更新。 */
            { path: "llm.context_window_tokens", value: pick.context || 128000, merge: { theirs: [""] } },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "llm.endpoint");
          return !!(r && r.ok && r.found);
        },
      },
    ];
  },
};
