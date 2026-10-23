// src/server/clients/opencode.mjs —— OpenCode（opencode.ai 的 CLI）
//
// ## 配置文件
//
//   $OPENCODE_CONFIG_DIR/opencode.json(c)
//   否则 $XDG_CONFIG_HOME/opencode/opencode.json(c)
//   否则 ~/.config/opencode/opencode.json(c)
//
// ## magpie 的对应
//
// internal/agent/agents.go 的 opencode 那条（还有 air.go 用到同一形状）。
// magpie 写的是一个 provider 条目：
//
//   {"npm":"@ai-sdk/openai-compatible","name":"magpie",
//    "options":{"baseURL":"<网关>/v1","apiKey":"<key>"},
//    "models":{"<模型 id>":{…}}}
//
// ## ⚠ 与本仓既有的 OpenCode 支持是什么关系
//
// 本仓早就有 OpenCode 的**两样**东西，但**都不是「接线」**：
//   · src/server/oc-wiring.mjs  —— **装** OpenCode CLI（下载官方安装器）
//   · src/server/cards/oc-transport.js —— 切「传输方式」（direct / 走本地桥）
// 而「把 B.AI 的 provider 写进 opencode.json」这一环**原先没有** ——
// 这一条是补上它的。
//
// ## 模型表的键
//
// magpie 用 `provider.FlatID`（`~` 分隔的扁平 id）当键。我们这边键就是
// `provider/档位` 本身 —— **斜杠不是 JSON 路径的分隔符**（点才是），所以
// `provider.bai.models.sn/claude-opus-5.name` 这种点分路径是**切得开的** ✓
// ⚠ 但模型 id 里**带点**时（`glm-5.2`）就要转义（`glm-5\.2`）——
//   底座用格式自己的分路径器处理这件事（见 clients/base.mjs 的 FORMATS 注释）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import os from "node:os";

/** OpenCode 的配置目录：$OPENCODE_CONFIG_DIR → $XDG_CONFIG_HOME/opencode → ~/.config/opencode */
function opencodeDir(ctx) {
  const env = ctx.env || process.env;
  const d = String(env.OPENCODE_CONFIG_DIR || "").trim();
  if (d) return d;
  const xdg = String(env.XDG_CONFIG_HOME || "").trim();
  if (xdg) return path.join(xdg, "opencode");
  return path.join(ctx.home || os.homedir(), ".config", "opencode");
}

export const opencodeClient = {
  id: "opencode",
  name: "OpenCode",
  protocol: "chat",
  note: "opencode.ai 的 CLI（写 opencode.json 的 provider 条目）",

  files: (ctx) => [
    {
      path: path.join(opencodeDir(ctx), "opencode.json"),
      format: "json",
      writes: (c) => {
        const pid = c.providerId || "bai";
        const models = {};
        for (const m of c.models || []) {
          models[m.id] = { name: m.label || m.id };
        }
        return [
          /* ⚠ 键是 `provider.<id>.<路径>` —— 键名里带点要转义（见文件头）。 */
          { path: `provider.${pid}.npm`, value: "@ai-sdk/openai-compatible" },
          { path: `provider.${pid}.name`, value: c.providerName || "B.AI" },
          { path: `provider.${pid}.options.baseURL`, value: `${String(c.baseUrl || "").replace(/\/+$/, "")}/v1` },
          { path: `provider.${pid}.options.apiKey`, value: c.apiKey || "" },
          { path: `provider.${pid}.models`, value: models },
        ];
      },
      wired: (text, fmt) => {
        const r = fmt.getPath(text, `provider.${(ctx.providerId || "bai")}.options.baseURL`);
        return !!(r && r.ok && r.found && String(r.value || "").includes("127.0.0.1"));
      },
    },
  ],
};
