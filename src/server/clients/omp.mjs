// src/server/clients/omp.mjs —— omp（oh-my-pi，Pi 的分支）
//
// ## 配置文件 —— **两个**
//
//   ① ~/.omp/agent/config.yml —— 每个角色的模型：
//
//      modelRoles:
//        default: bai/sn/claude-opus-5       ← 「provider/模型」
//
//   ② ~/.omp/agent/models.yml —— provider 的定义（Pi 那种形状）：
//
//      providers:
//        bai:
//          baseUrl: http://127.0.0.1:15799/v1
//          api: openai-completions
//          auth: none                        ← 回环上的网关不要 key
//          headers:
//            User-Agent: omp
//          models:
//            - id: sn/claude-opus-5
//              name: Claude Opus 5
//              contextWindow: 128000
//              input: [text]
//
// ## magpie 的对应
//
// internal/agent/omp.go。
//
// ## ⚠ 形状的核对程度
//
//   **形状照 magpie（internal/agent/<name>.go），本机没装这个客户端 ⇒ 未在本机核对过。**
//   本机装了并核对过真实配置的只有 MiniMax Code（~/.minimax/config.yaml）与
//   Hermes Agent（~/.hermes/config.yaml）—— 见那两个文件里的说明。
//
// ## 三件要说清的事
//
// ① **模型引用是「provider/模型」**：omp 拿 modelRoles 里的值去 models.yml 里
//    找 provider 名 + 模型 id 两段（magpie 的说法："omp matches whole against
//    provider/id"）。所以 default 写 `bai/sn/claude-opus-5`。
// ② **auth: none**：回环上的网关不问 key。magpie 特意不写 apiKey。
// ③ **baseUrl 带 /v1**（magpie 写的是 gw + "/v1"）。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：config.yml 的 modelRoles.default、models.yml 的 provider 条目。
//   · 做了 magpie 用 stash 做的那件事的**等价物**：那两处的原值由底座备份，
//     断开时只还原那两处。
//   · 没做：**十个角色**（default / task / smol / slow / plan / vision / advisor /
//     commit / tiny / memory）以及 retry.fallbackChains、enabledModels、
//     task.agentModelOverrides 这些「也指着模型」的地方 —— magpie 逐个改。
//     我们只改 modelRoles.default（主模型）。
//   · 没做：profiles（~/.omp/profiles/<name>/agent 下各有一份 config.yml 与
//     models.yml）—— 我们只写默认那一份。
//   · 没做：模型条目里的 api / baseUrl（按模型方言分开）、thinking.efforts ——
//     我们这层不知道模型的这些细账。
//   · 没做：compat.promptCacheSessionHeader（会话头）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel } from "./util.mjs";
import { gwV1, labelOf, modelRef } from "./client-utils.mjs";
import "./formats-yaml.mjs";

/** omp 的目录：$PI_CONFIG_DIR，否则 ~/.omp；profile 的话在 profiles/<name>/agent。 */
function ompAgentDir(ctx) {
  const root = String(process.env.PI_CONFIG_DIR || "").trim();
  const base = root ? path.join(ctx.home, root) : path.join(ctx.home, ".omp");
  const profile = String(process.env.OMP_PROFILE || process.env.PI_PROFILE || "").trim();
  if (profile && profile !== "default") return path.join(base, "profiles", profile, "agent");
  return path.join(base, "agent");
}

/** models.yml 里的 provider 条目：逐键写（models 那一串是模型清单，整串写）。 */
function providerEntry(ctx) {
  const out = [
    { path: "providers.bai.baseUrl", value: gwV1(ctx) },
    { path: "providers.bai.api", value: "openai-completions" },
    { path: "providers.bai.auth", value: "none" },
    { path: "providers.bai.headers.User-Agent", value: "omp" },
    {
      path: "providers.bai.models",
      value: (ctx.models || []).map((m) => ({
        id: m.id,
        name: labelOf(m),
        /* ⚠ **能力项我们不知道 ⇒ 不写那个键**（不是写 false、也不是写 true）：
       我们的模型 id 是**档位**（provider 无关），而能力由**映射到哪家上游**决定
       （同一档位在 sn 映射到 glm-5.2、在 wb 映射到 hy3，图片与思考逐家不同）
       ⇒ 断言「不支持」等于替**所有**上游下结论，我们没有依据。
       「不写」与「写 false」对 Go 客户端**等价**（读不到 ⇒ 取零值），但「不写」
       把那个**位置空着** ⇒ 将来有了真值是「**加一个键**」，而写 false 就占着它。
       ⚠ **更不能写 true** —— 那会让用户真去发一个上游不认的思考参数，当场报错。
       真值随 T15-c 的「模型元数据下发」到位。 */
        /* ⚠ 128000 是**兜底约定**不是实测值：有真值用真的（m.context），真实上限
           一旦有来源（渠道目录的 max_input_tokens 之类）就用那个顶掉。 */
        contextWindow: m.context || 128000,
        /* ⚠ `input` 写的是**下限**（文本是所有模型都收的），**不是**「只收文本」
           的断言 —— 能收图片的档位我们不知道（能力逐家不同），所以不写 image。 */
        input: ["text"],
      })),
    },
  ];
  return out;
}

export const ompClient = {
  id: "omp",
  name: "omp (oh-my-pi)",
  protocol: "chat",
  note: "oh-my-pi（Pi 的分支）",

  files: (ctx) => {
    const dir = ompAgentDir(ctx);
    return [
      {
        path: path.join(dir, "config.yml"),
        format: "yaml",
        writes: () => {
          const pick = pickModel(ctx);
          return [{ path: "modelRoles.default", value: modelRef(ctx, pick) }];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "modelRoles.default");
          return !!(r && r.ok && r.found);
        },
      },
      {
        path: path.join(dir, "models.yml"),
        format: "yaml",
        writes: () => providerEntry(ctx),
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "providers.bai.baseUrl");
          return !!(r && r.ok && r.found);
        },
      },
    ];
  },
};
