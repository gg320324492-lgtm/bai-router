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
// ## 保留用户手改过的值（通用合并层）
//
// provider 块是**逐字段**写的（npm / name / options.baseURL / options.apiKey /
// models 各一条），每一条都带一份归属声明（merge-policy.mjs 的 spec）：
//
// | 字段 | 归谁 | 为什么 |
// | --- | --- | --- |
// | `provider.<pid>.name` | **用户的** | 用户在 OpenCode 里改过的 provider 显示名留着（根模式：`theirs: [""]` —— 标量没法用子路径表达归属） |
// | `provider.<pid>.models.<模型 id>.name` | **用户的** | 用户改过的模型名留着（通配 `*.name`） |
// | `provider.<pid>.models` 的**表名**（模型 id） | 我们的 | 模型 id 集合是机器该管的（设计稿 §2.2(a)）—— 我们没写的那些 id 保留用户的 |
// | `npm` / `options.baseURL` / `options.apiKey` | 我们的 | 方言、地址与 key 机器该管（§2.2(a)）—— 不参与比对、照写 |
// | 模型条目里我们没写的键（limit、variants…） | **保留用户的** | 我们压根没写 ⇒ 弱保留那一层留着（magpie 的 openCodeKept 也是逐个 variant 比对，agents.go:459-493） |
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import os from "node:os";
/* pickModel —— 选一个模型（清单里的第一个）。util.mjs 是这一层共用的工具，
   它导出 pickModel 与 envDir（重写它要保留这两个名字）。 */
import { pickModel } from "./util.mjs";

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
        /* ⚠ **模型 id 那一档**（`model`）—— 原来漏了：magpie 的 OpenCode 写
         *   `provider.<id>.model`（provider 块里的模型 id）⇒ 不写它，
         *   **客户端根本不知道用哪个模型**（它只有一份清单可选）。
         *   ⇒ 补上。
         *   ⚠ **用哪个当默认**：magpie 是让**用户在面板上选**的（它有模型选择器），
         *   我们还没有「用户选了哪一档」这个概念 ⇒ 暂用**清单里的第一个**
         *   （`pickModel`，与其它声明一致）⇒ 稳定、可预期。
         * ⚠ **不写** magpie 的 `small_model`：我们清单里最小的就是 haiku ⇒
         *   再没有更小的可当「小模型」⇒ 写它没有意义（magpie 的 small 是
         *   「它清单里更小的那个」）。 */
        const pick = pickModel(c);
        return [
          /* ⚠ 键是 `provider.<id>.<路径>` —— 键名里带点要转义（见文件头）。 */
          { path: `provider.${pid}.npm`, value: "@ai-sdk/openai-compatible" },
          /* provider 的**显示名**归用户：用户在 OpenCode 里改过就留着。
             ⚠ 这是「一个 write 只写一个字段」的声明（值是标量）⇒ 用**根模式**
               （theirs: [""]）：整个值逐值比对，一样就不动，不一样用户的赢。
               根模式对数组不适用（这里不是数组 ✓）。 */
          { path: `provider.${pid}.name`, value: c.providerName || "B.AI", merge: { theirs: [""] } },
          /* 地址与 key 是机器该管的（设计稿 §2.2(a)）—— 不参与比对、照写。 */
          { path: `provider.${pid}.options.baseURL`, value: `${String(c.baseUrl || "").replace(/\/+$/, "")}/v1` },
          { path: `provider.${pid}.options.apiKey`, value: c.apiKey || "" },
          /* 模型 id：机器该管的（设计稿 §2.2(a)）⇒ 照写、不比对。 */
          { path: `provider.${pid}.model`, value: pick.id },
          /* models 是**对象表**（模型 id 当表名）：用户改过的**模型名**归用户
             （通配 `*.name`），模型 id（表名）与别的键是机器该管的 / 保留用户的。
             ⚠ 路径是**相对 value 根**的 —— value 根**就是**这张表 ⇒ 写 `*.name`
               而不是 `models.*.name`（后者在这张表里永远匹配不上）。
             ⚠ 模型 id 里带点（`glm-5.2`）也没关系：合并层按**对象的键**递归，
               不走点分路径（merge-policy.mjs 的文件头）。 */
          { path: `provider.${pid}.models`, value: models, merge: { theirs: ["*.name"] } },
        ];
      },
      wired: (text, fmt) => {
        const r = fmt.getPath(text, `provider.${(ctx.providerId || "bai")}.options.baseURL`);
        return !!(r && r.ok && r.found && String(r.value || "").includes("127.0.0.1"));
      },
    },
  ],
};
