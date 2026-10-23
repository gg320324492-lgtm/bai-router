// src/server/clients/grok.mjs —— Grok Build（xAI 的 grok CLI）
//
// ## 配置文件
//
//   ~/.grok/config.toml（$GROK_HOME 设了就用那儿）
//
// ## magpie 的对应
//
// internal/agent/grok.go。
//
// ## ⚠ 形状的核对程度
//
//   **形状照 magpie（internal/agent/<name>.go），本机没装这个客户端 ⇒ 未在本机核对过。**
//   本机装了并核对过真实配置的只有 MiniMax Code（~/.minimax/config.yaml）与
//   Hermes Agent（~/.hermes/config.yaml）—— 见那两个文件里的说明。
//
// ## Grok Build 的配置长什么样
//
//   [models]                          ← 默认用哪个模型
//   default = "bai/sn/claude-opus-5"
//
//   [features]                        ← 关掉「战役补丁」，否则默认模型会被覆盖
//   campaigns = false
//
//   [model."bai/sn/claude-opus-5"]    ← 模型表，键是「provider/模型」
//   model = "sn/claude-opus-5"        ← 问它哪个模型
//   name = "Claude Opus 5"            ← Grok 的 /model 里显示的名字
//   base_url = "http://127.0.0.1:15799/v1"
//   api_key = "…"
//   api_backend = "chat_completions"  ← 用哪种方言
//   context_window = 128000
//
// ## 三件要说清的事
//
// ① **模型表名带斜杠**，所以 TOML 里要引号：`[model."bai/sn/claude-opus-5"]`。
// ② **base_url 带 /v1**：magpie 写的是 at.v1()。
// ③ **campaigns = false**：登录着的 Grok 会从 xAI 拉「战役补丁」盖在 config.toml
//    上面（2026-09 的 grok-4.7-launch 就这么把 models.default 改了）——
//    选了 B.AI 的模型却被战役改回去，比没接还糟。magpie 也是这么关的；
//    断开时由底座把原值还原回去。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：模型表、默认模型、关战役补丁。
//   · 做了 magpie 用 stash 做的那件事的**等价物**：models.default 与
//     features.campaigns 原来的值由底座备份，断开时只还原那两处。
//   · 没做：reasoning_efforts（每个模型支持哪些思考档）与
//     default_reasoning_effort ——我们这层不知道模型的档位，只写模型本身。
//   · 没做：「Grok 自己登录账号的模型」也列进 /model（models_cache.json）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel, envDir } from "./util.mjs";
import { gwV1, labelOf, modelRef } from "./client-utils.mjs";
import "./formats-toml.mjs";

/** Grok 的目录：$GROK_HOME，否则 ~/.grok。 */
function grokDir(ctx) {
  return envDir("GROK_HOME") || path.join(ctx.home, ".grok");
}

/** 模型表：每个目录模型一张表，键是「provider/模型」。逐键写（不是整块替换）。 */
function modelTables(ctx) {
  const out = [];
  for (const m of ctx.models || []) {
    const t = `model."${modelRef(ctx, m)}"`;
    out.push({ path: `${t}.model`, value: m.id });
    out.push({ path: `${t}.name`, value: labelOf(m) });
    out.push({ path: `${t}.base_url`, value: gwV1(ctx) });
    out.push({ path: `${t}.api_key`, value: ctx.apiKey || "" });
    out.push({ path: `${t}.api_backend`, value: "chat_completions" });
    /* ⚠ 128000 是**兜底约定**不是实测值：有真值用真的（m.context），真实上限
       一旦有来源（渠道目录的 max_input_tokens 之类）就用那个顶掉。 */
    out.push({ path: `${t}.context_window`, value: m.context || 128000 });
  }
  return out;
}

export const grokClient = {
  id: "grok",
  name: "Grok Build",
  protocol: "chat",
  note: "xAI 的 grok CLI",

  files: (ctx) => {
    const file = path.join(grokDir(ctx), "config.toml");
    return [
      {
        path: file,
        format: "toml",
        writes: () => {
          const pick = pickModel(ctx);
          return [
            ...modelTables(ctx),
            { path: "models.default", value: modelRef(ctx, pick) },
            /* 登录着的 Grok 会用战役补丁盖掉默认模型 —— 关掉它 */
            { path: "features.campaigns", value: false },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "models.default");
          return !!(r && r.ok && r.found);
        },
      },
    ];
  },
};
