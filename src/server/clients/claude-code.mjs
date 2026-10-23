// src/server/clients/claude-code.mjs —— Claude Code（Anthropic 的 CLI）
//
// ## 配置文件
//
//   ~/.claude/settings.json 的 **env 块**
//
// ## magpie 的对应
//
// internal/agent/claude.go。magpie 写的就是这些 env 键：
//   ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL /
//   ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL(+_NAME) /
//   API_TIMEOUT_MS / CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC /
//   NODE_USE_ENV_PROXY / NO_PROXY /（出海渠道还有）HTTPS_PROXY、HTTP_PROXY
//
// ## ⚠⚠ 为什么**不复写**这一段逻辑，而是**复用**它
//
// 这批 env 键里有**很多有历史教训的讲究**（`src/server/server.mjs` 的
// `applyToCli` 那段长注释里都写着）：
//   · 读失败**不当空**（当空会把用户其余配置写没）
//   · 走本地中转的渠道写**占位符**、不写真凭据（免得在用户主目录留明文副本）
//   · 网关模式模型 id 必须是**档位**（`provider/档位`）而不是最终模型名
//     —— **这条写反过一次**，代价是「用户点 opus、转移后跑的是 fable 的模型」
//   · 出海渠道写代理 env、境内渠道**删掉**代理 env
//
// 重写一遍等于把那些教训重新踩一遍。所以这里**一行都不重写**：
// `ctx.cli.editsFor()` 交出「要改哪几处」（edits 数组），由**底座**统一
// 备份与写盘 —— 于是这一条比原来的 `applyToCli` 还多一个能力：**能断开**
// （applyToCli 自己只留指纹，没有还原）。
//
// ## 断开的语义
//
// 底座按**键路径**备份（`env.ANTHROPIC_BASE_URL` 这样的粒度）⇒ 断开时只把
// 我们写过的那几个键还原/删掉，用户自己在 `env` 里的其它键一个字不动。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";

export const claudeCodeClient = {
  id: "claude-code",
  name: "Claude Code",
  protocol: "anthropic",
  note: "Anthropic 的 CLI（写 ~/.claude/settings.json 的 env 块）",

  files: (ctx) => [
    {
      path: path.join(ctx.home, ".claude", "settings.json"),
      format: "json",
      /* ⚠ edits 来自 `applyToCli` 本身（`ctx.cli.editsFor()`）——
       *   那些键路径与取值规则**一处都不重写**，见文件头。 */
      writes: (c) => c.cli.editsFor(),
      /* 「接上了」怎么判：base URL 指向我们的网关。
       * ⚠ 用 env 块里那个键判，而不是「文件里有没有 base url」——
       *   用户自己配过 base url（没接我们）时，那条会误判成接上了。 */
      wired: (text, fmt) => {
        const r = fmt.getPath(text, "env.ANTHROPIC_BASE_URL");
        return !!(r && r.ok && r.found && String(r.value || "").includes("127.0.0.1"));
      },
    },
  ],
};
