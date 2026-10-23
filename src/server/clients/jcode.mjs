// src/server/clients/jcode.mjs —— jcode（1jehuang/jcode，Rust 写的编码代理）
//
// ## 配置文件
//
//   ~/.jcode/config.toml（$JCODE_HOME 设了就用那儿）
//
// ## magpie 的对应
//
// internal/agent/jcode.go。
//
// ## ⚠ 形状的核对程度
//
//   **形状照 magpie（internal/agent/<name>.go），本机没装这个客户端 ⇒ 未在本机核对过。**
//   本机装了并核对过真实配置的只有 MiniMax Code（~/.minimax/config.yaml）与
//   Hermes Agent（~/.hermes/config.yaml）—— 见那两个文件里的说明。
//
// ## jcode 的配置长什么样
//
//   [provider]                        ← jcode 启动时用哪一家、哪个模型
//   default_provider = "bai"
//   default_model = "sn/claude-opus-5"
//
//   [providers.bai]                   ← 一份「档案」（profile）
//   type = "openai-compatible"        ← jcode 的 chat completions 客户端
//   base_url = "http://127.0.0.1:15799/v1"
//   api_key = "…"
//   requires_api_key = true           ← 回环上的网关也要一个非空的 key
//   models = [                        ← 模型清单（行内表）
//     { id = "sn/claude-opus-5", context_window = 128000, input = ["text"] },
//   ]
//
// ## 三件要说清的事
//
// ① **base_url 带 /v1**：magpie 写的是 at.v1()。
// ② **requires_api_key = true**：jcode 看见回环地址会以为「不用 key」，
//    于是**一个 key 都不发** —— 那个 key 的作用是让网关知道「是 jcode 来的」。
// ③ **models 是行内表数组**，不是 [[…]] 段 —— magpie 这么写，jcode 这么读。
//    我们照抄（TOML 读写器两种都支持）。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：档案块、模型清单、启动用的 provider 与模型。
//   · 做了 magpie 用 stash 做的那件事的**等价物**：[provider] 那两处原来的值由
//     底座备份，断开时只还原那两处。
//   · 没做：「用户自己在这份档案里加的键（headers、extra_body、某个模型的
//     reasoning_effort）保留」—— magpie 是逐键合并；我们也是**逐键写**
//     （只有模型清单那一串是整串写），用户加的那些键我们压根不碰。
//   · 没做：jcode 自己的 provider（它的登录档）列进 /model 选择器。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel, envDir } from "./util.mjs";
import { gwV1 } from "./client-utils.mjs";
import "./formats-toml.mjs";

/** jcode 的目录：$JCODE_HOME，否则 ~/.jcode。 */
function jcodeDir(ctx) {
  return envDir("JCODE_HOME") || path.join(ctx.home, ".jcode");
}

/** 模型清单：jcode 的 NamedProviderModelConfig 形状。 */
function modelList(ctx) {
  return (ctx.models || []).map((m) => ({
    id: m.id,
    /* ⚠ 128000 是**兜底约定**不是实测值（magpie 同款）：有真值用真的（m.context），
       真实上限一旦有来源（渠道目录的 max_input_tokens 之类）就用那个顶掉。 */
    context_window: m.context || 128000,
    /* ⚠ `input` 写的是**下限**（文本是所有模型都收的），**不是**「这个模型只收
       文本」的断言 —— 能收图片的档位我们不知道（同上，能力逐家不同），所以不写
       image。⚠ 也**不能整个不写**：jcode 那边这个键缺了，模型可能被当成「什么
       都不收」⇒ 那比少报一个能力更糟。 */
    input: ["text"],
    /* ⚠ **能力项我们不知道 ⇒ 不写那个键**（不是写 false、也不是写 true）：
       我们的模型 id 是**档位**（provider 无关），而能力由**映射到哪家上游**决定
       （同一档位在 sn 映射到 glm-5.2、在 wb 映射到 hy3，图片与思考逐家不同）
       ⇒ 断言「不支持」等于替**所有**上游下结论，我们没有依据。
       「不写」与「写 false」对 Go 客户端**等价**（读不到 ⇒ 取零值），但「不写」
       把那个**位置空着** ⇒ 将来有了真值是「**加一个键**」，而写 false 就占着它。
       ⚠ **更不能写 true** —— 那会让用户真去发一个上游不认的思考参数，当场报错。
       真值随 T15-c 的「模型元数据下发」到位。 */
  }));
}

export const jcodeClient = {
  id: "jcode",
  name: "jcode",
  protocol: "chat",
  note: "1jehuang/jcode（Rust 写的编码代理）",

  files: (ctx) => {
    const file = path.join(jcodeDir(ctx), "config.toml");
    return [
      {
        path: file,
        format: "toml",
        writes: () => {
          const pick = pickModel(ctx);
          return [
            { path: "providers.bai.type", value: "openai-compatible" },
            { path: "providers.bai.base_url", value: gwV1(ctx) },
            { path: "providers.bai.api_key", value: ctx.apiKey || "" },
            { path: "providers.bai.requires_api_key", value: true },
            { path: "providers.bai.models", value: modelList(ctx) },
            { path: "provider.default_provider", value: "bai" },
            { path: "provider.default_model", value: pick.id },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "providers.bai.base_url");
          return !!(r && r.ok && r.found);
        },
      },
    ];
  },
};
