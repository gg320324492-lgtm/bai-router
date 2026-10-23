// src/server/clients/kimi-code.mjs —— Kimi Code（月之暗面的 CLI）
//
// ## 配置文件
//
//   ~/.kimi/config.toml（$KIMI_SHARE_DIR 设了就用那儿）
//
// ## magpie 的对应
//
// internal/agent/kimi.go。
//
// ## ⚠ 形状的核对程度
//
//   **形状照 magpie（internal/agent/<name>.go），本机没装这个客户端 ⇒ 未在本机核对过。**
//   本机装了并核对过真实配置的只有 MiniMax Code（~/.minimax/config.yaml）与
//   Hermes Agent（~/.hermes/config.yaml）—— 见那两个文件里的说明。
//
// ## Kimi Code 的配置长什么样
//
//   default_model = "bai/sn/claude-opus-5"      ← 顶层键，会话默认用哪个模型
//
//   [providers.bai]                             ← 我们这家
//   type = "kimi"                               ← Kimi 自己的 chat completions 方言
//   base_url = "http://127.0.0.1:15799/v1"
//   api_key = "…"
//
//   [models."bai/sn/claude-opus-5"]              ← 模型表，键是「provider/模型」
//   provider = "bai"                            ← 问哪一家
//   model = "sn/claude-opus-5"                  ← 问它哪个模型
//   display_name = "Claude Opus 5"              ← Kimi 的 /model 里显示的名字
//   max_context_size = 128000
//
// ## 三件要说清的事
//
// ① **模型表名带斜杠**，所以 TOML 里要引号：`[models."bai/sn/claude-opus-5"]`。
//    我们的键路径写法也是 `models."bai/sn/claude-opus-5".provider` —— 引号里
//    的斜杠是一个键名的一部分（见 paths.mjs）。
// ② **base_url 带 /v1**：Kimi 自己会在后面拼 `/chat/completions`，magpie 写的是
//    at.v1()（= 网关 + /v1）。统一网关 /v1/chat/completions 与 /chat/completions
//    都答，两种都通，但照抄 magpie 更保险。
// ③ **default_model 会被改**：magpie 也是这样（用户原来那一档先存起来，
//    断开时放回去 —— 由 base.mjs 的备份/还原统一管）。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：provider 的那几个键、每个模型一张表、default_model
//     （**逐键写**，不是整块替换 —— 用户自己在 provider 表里加的键留着不动）。
//   · 做了 magpie 用 stash 做的那件事的**等价物**：default_model 原来的值由底座
//     备份，断开时只还原那一处 —— 其余一个字不动。
//   · 没做：新版 Kimi Code 的 ~/.kimi-code（kimi-cli 1.50 之后只读那个目录，
//     magpie 会按目录探测）——我们只写 ~/.kimi（$KIMI_SHARE_DIR）。
//   · 没做：capabilities（tool_use / image_in / thinking）、max_output_size、
//     support_efforts / default_effort ——那些是「模型支持什么」的细账，
//     我们这层只知道模型 id 与显示名。
//
// ## 保留用户手改（通用合并层）
//
// | 字段 | 归谁 | 为什么 |
// | --- | --- | --- |
// | `models."<provider/模型>".display_name` | **用户的** | 用户在 Kimi 的 /model 里改过的显示名留着（设计稿 §2.2(a)）—— 根模式 |
// | `models."<provider/模型>".max_context_size` | **用户的** | 窗口是「用户可能手改」的字段（§2.2(a)）—— 我们那个值是兜底不是真值 |
// | `models."<provider/模型>".provider` / `.model`、`providers.bai.*` | 我们的 | 模型 id、地址、令牌与方言是机器该管的（§2.2(a)）—— 照写、不比对 |
// | `default_model` | 我们的 | 用哪一档是机器该管的（与地址是一对） |
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel, envDir } from "./util.mjs";
import { gwV1, labelOf, modelRef } from "./client-utils.mjs";
import "./formats-toml.mjs";

/** Kimi 的配置目录：$KIMI_SHARE_DIR，否则 ~/.kimi。 */
function kimiDir(ctx) {
  return envDir("KIMI_SHARE_DIR") || path.join(ctx.home, ".kimi");
}

/** 模型表：每个目录模型一张表，键是「provider/模型」。逐键写（不是整块替换）。 */
function modelTables(ctx) {
  const out = [];
  for (const m of ctx.models || []) {
    const t = `models."${modelRef(ctx, m)}"`;
    out.push({ path: `${t}.provider`, value: "bai" });
    out.push({ path: `${t}.model`, value: m.id });
    /* ⚠ **显示名归用户**（设计稿 §2.2(a)：模型名是「用户可能手改」的字段）——
     *   用户在 Kimi 的 /model 里改过的名字留着。根模式（`theirs: [""]`）：
     *   标量没法用子路径表达归属 ⇒ 整个值逐值比对，一样就不动，
     *   不一样**用户的赢**。 */
    out.push({ path: `${t}.display_name`, value: labelOf(m), merge: { theirs: [""] } });
    /* Kimi 要一个上下文窗口才肯压缩；128000 是 magpie 同款的**兜底约定**
       （不是实测值）：有真值用真的（m.context），真实上限一旦有来源
       （渠道目录的 max_input_tokens 之类）就用那个顶掉。
       ⚠ **窗口归用户**（设计稿 §2.2(a)）—— 那个兜底值不是真值，拿它盖掉用户
       *   自己调的窗口会让 Kimi **提前压缩**上下文（宁可报大不要报小）。
       *   代价见 §2.2(d)：真值到位后这个值不会自动更新。 */
    out.push({ path: `${t}.max_context_size`, value: m.context || 128000, merge: { theirs: [""] } });
  }
  return out;
}

export const kimiCodeClient = {
  id: "kimi-code",
  name: "Kimi Code",
  protocol: "chat",
  note: "月之暗面的 CLI（kimi-cli / Kimi Code）",

  files: (ctx) => {
    const file = path.join(kimiDir(ctx), "config.toml");
    return [
      {
        path: file,
        format: "toml",
        writes: () => {
          const pick = pickModel(ctx);
          return [
            { path: "providers.bai.type", value: "kimi" },
            { path: "providers.bai.base_url", value: gwV1(ctx) },
            { path: "providers.bai.api_key", value: ctx.apiKey || "" },
            ...modelTables(ctx),
            { path: "default_model", value: modelRef(ctx, pick) },
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
