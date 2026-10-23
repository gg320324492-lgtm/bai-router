// src/server/clients/stepcode.mjs —— StepCode
//
// ## 配置文件 —— **两个**
//
//   ① ~/.stepcode/config.toml（$STEPCODE_CONFIG_DIR 设了就用那儿）
//
//      defaultProvider = "bai"              ← 用哪一家
//      defaultModel = "sn/claude-opus-5"     ← 哪家的哪个模型
//
//   ② ~/.stepcode/models.json —— 模型目录（Pi 那种 provider 形状）：
//
//      {
//        "providers": {
//          "bai": {
//            "name": "bai",
//            "baseUrl": "http://127.0.0.1:15799/v1",
//            "api": "openai-completions",
//            "apiKey": "…",
//            "models": [ { "id": "sn/claude-opus-5", "name": "Claude Opus 5" } ]
//          }
//        }
//      }
//
// ## magpie 的对应
//
// internal/agent/stepcode.go。
//
// ## ⚠ 形状的核对程度
//
//   **形状照 magpie（internal/agent/<name>.go），本机没装这个客户端 ⇒ 未在本机核对过。**
//   本机装了并核对过真实配置的只有 MiniMax Code（~/.minimax/config.yaml）与
//   Hermes Agent（~/.hermes/config.yaml）—— 见那两个文件里的说明。
//
// ## 三件要说清的事
//
// ① **模型是「provider/模型」两段**：StepCode 的 defaultProvider 与 defaultModel
//    各写一半（magpie 写的是 magpieID 与目录 id）。所以 defaultModel 里放的是
//    **光秃秃的模型 id**（`sn/claude-opus-5`），不是「provider/模型」。
// ② **baseUrl 带 /v1**（magpie 写的是 at.v1()）。
// ③ **api 是 openai-completions** —— 我们统一网关说的是 OpenAI 的 chat completions。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：config.toml 的两处 + models.json 的 providers.bai。
//   · 做了 magpie 用 stash 做的那件事的**等价物**：那几处的原值由底座备份，
//     断开时只还原那几处。
//   · 没做：enabledModels（一个「哪些模型可用」的范围表）—— magpie 会把我们的
//     模型追加进去，并在断开时只撤掉自己追加的那几条。我们不碰它（用户自己
//     那份原样保留）。
//   · 没做：「用户自己在 models.json 的 providers.magpie 里加的键保留」——
//     magpie 逐键合并；我们整块写 providers.bai，断开时靠备份原样还原。
//   · 没做：项目本地的 .stepcode/config.toml 盖在全局之上（那是用户的事）。
//   · 没做：auth.json（StepCode 自己的登录）—— 不碰。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel, envDir } from "./util.mjs";
import { gwV1, labelOf } from "./client-utils.mjs";
import "./formats-toml.mjs";

/** StepCode 的目录：$STEPCODE_CONFIG_DIR，否则 ~/.stepcode。 */
function stepcodeDir(ctx) {
  return envDir("STEPCODE_CONFIG_DIR") || path.join(ctx.home, ".stepcode");
}

/** models.json 里的 provider 条目（Pi 的形状）。 */
function providerEntry(ctx) {
  return {
    name: "bai",
    baseUrl: gwV1(ctx),
    api: "openai-completions",
    apiKey: ctx.apiKey || "",
    models: (ctx.models || []).map((m) => ({
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
    })),
  };
}

export const stepcodeClient = {
  id: "stepcode",
  name: "StepCode",
  protocol: "chat",
  note: "StepCode（模型目录写在 models.json）",

  files: (ctx) => {
    const dir = stepcodeDir(ctx);
    return [
      {
        path: path.join(dir, "config.toml"),
        format: "toml",
        writes: () => {
          const pick = pickModel(ctx);
          return [
            { path: "defaultProvider", value: "bai" },
            { path: "defaultModel", value: pick.id },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "defaultProvider");
          return !!(r && r.ok && r.found);
        },
      },
      {
        path: path.join(dir, "models.json"),
        format: "json",
        writes: () => [
          { path: "providers.bai", value: providerEntry(ctx) },
        ],
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "providers.bai");
          return !!(r && r.ok && r.found);
        },
      },
    ];
  },
};
