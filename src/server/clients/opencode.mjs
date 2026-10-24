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
// ## 模型表的键：**档位**（表名）+ `id`（发给网关的那个）
//
// magpie 用 `provider.FlatID`（`~` 分隔的扁平 id）当键 —— 它的 id 里**没有斜杠**。
// 我们这边的模型 id 是 `provider/档位`（例如 `sn/claude-opus-5`）⇒ **有斜杠**，
// 而 OpenCode 的寻址是 **`providerId/modelId`**（**按第一个斜杠切**）：
// `-m bai/claude-opus-5` ⇒ provider=`bai`、model=`claude-opus-5`。
//
// ⇒ **表名必须是「档位」**（`claude-opus-5`），**不是**整个 id ——
//   否则表名里那截 provider 前缀会跟 OpenCode 自己的 provider 名**撞成两遍**
//   （`bai/bai/claude-opus-5`），而且用户从我们面板上抄到的 `sn/claude-opus-5`
//   在 OpenCode 里**选不了**（实测：`-m sn/claude-opus-5` ⇒ Model not found）。
//
// ⇒ **发给网关的那个 id 由条目的 `id` 字段带**（OpenCode 的模型条目有这个字段：
//   它是「API 请求里用的模型 id」）⇒ 表名是档位、请求里是 `sn/claude-opus-5`
//   —— **网关照样分得流**（网关要的就是带 provider 前缀的 id）。
//
// ⚠ 实测（真 opencode 1.19.3 + 隔离 HOME + 本地假上游，2026-10-23）：
//   · 表名=档位 + 条目带 `id` ⇒ 请求体里的 model = `sn/claude-opus-5` ✓
//   · 表名=整个 id（我们上一版）⇒ 请求体里也是对的，但 `opencode models` 列出的是
//     `bai/bai/sn/claude-opus-5`，而 `-m sn/claude-opus-5` 选不了 ⇒ ✗
//
// ## 顶层 `model`（默认模型）
//
// OpenCode 的**默认模型**在**顶层** `model`（magpie 也写在这儿），
// 写法是引用 `providerId/modelId` ⇒ 我们写 **`bai/<档位>`**。
// ⚠ provider 块里的 `provider.<pid>.model` 是**另一处**（provider 自己的默认），
//   两个都写、值都合法（实测：三种组合都能跑通）。
//
// ## 保留用户手改过的值（通用合并层）
//
// provider 块是**逐字段**写的（npm / name / options.baseURL / options.apiKey /
// models 各一条），每一条都带一份归属声明（merge-policy.mjs 的 spec）：
//
// | 字段 | 归谁 | 为什么 |
// | --- | --- | --- |
// | `provider.<pid>.name` | **用户的** | 用户在 OpenCode 里改过的 provider 显示名留着（根模式：`theirs: [""]` —— 标量没法用子路径表达归属） |
// | `provider.<pid>.models.<档位>.name` | **用户的** | 用户改过的模型名留着（通配 `*.name`） |
// | `provider.<pid>.models` 的**表名**（档位） | 我们的 | 模型 id 集合是机器该管的（设计稿 §2.2(a)）—— 我们没写的那些 id 保留用户的 |
// | `npm` / `options.baseURL` / `options.apiKey` / 条目里的 `id` | 我们的 | 方言、地址、key 与「发给网关的 id」机器该管（§2.2(a)）—— 不参与比对、照写 |
// | 模型条目里我们没写的键（limit、variants…） | **保留用户的** | 我们压根没写 ⇒ 弱保留那一层留着（magpie 的 openCodeKept 也是逐个 variant 比对，agents.go:459-493） |
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import os from "node:os";
import { curValue } from "./json-util.mjs";
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

/**
 * tierOf —— 模型 id 的**档位**部分。
 *
 * 我们的模型 id 是 `provider/档位`（`sn/claude-opus-5`）⇒ 档位 = `claude-opus-5`。
 * OpenCode 的模型表**用档位当表名**（见文件头「模型表的键」）：
 * 它的寻址是 `providerId/modelId`、**按第一个斜杠切** ⇒ 表名里再带一遍
 * provider 前缀就会变成 `bai/bai/…`（用户从我们面板上抄的 id 也选不了）。
 */
function tierOf(id) {
  const s = String(id || "");
  const i = s.indexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * escapeDots —— 键里的点要转义（JSON 路径用点分层）。
 *
 * edit-json 的分路径器（`splitPath` + `unescapeKey`）**只认反斜杠转义**
 * （见 clients/paths.mjs 的说明）⇒ 键里的点写成 `\.`。
 * ⚠ 只转义**点** —— 斜杠不用转义（它不是路径分隔符）。
 */
function escapeDots(key) {
  return String(key || "").replace(/\./g, "\\.");
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
        const file = path.join(opencodeDir(c), "opencode.json");
        /* ⚠ **表名 = 档位**，条目里的 **`id` = 发给网关的那个完整 id**
         *   （文件头「模型表的键」有实测依据）。
         *   ⇒ 用户在 OpenCode 里看到/抄的是 `bai/<档位>`，
         *     而网关收到的仍是 `sn/<档位>` ⇒ 分流不受影响。 */
        const models = {};
        for (const m of c.models || []) {
          models[tierOf(m.id)] = { id: m.id, name: m.label || m.id };
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
        /* ── 迁移（2026-10-24）：上一版的表名是**每个**模型 id ──────────────
         *
         * 上一版我们把 `sn/claude-opus-5` 整个当表名 ⇒ 那张表在 OpenCode 里
         * 显示成 `bai/bai/sn/claude-opus-5`（选不了）。现在表名是档位 ⇒
         * **旧表名要删掉**，否则清单里会多出一条。
         *
         * ⚠ 删之前**把用户在那儿改过的模型名搬过来** —— 否则用户自定义的
         *   显示名会丢（那一格归用户，见文件头的归属表）。
         * ⚠ 旧表名里可能有**点**（`sn/glm-5.2`）⇒ 路径里要点转义。
         * ⚠ **每一个**模型都要迁（不只默认那个）—— 否则清单里会剩下
         *   别的档位的旧表名。
         *
         * ⚠⚠ **先算「要删哪些旧表名」**（`legacyKeys`）—— 合并层要知道这件事：
         *   旧表名对合并层来说是「我们没写的键」⇒ 它会报成
         *   「还留着你自己的 N 个键」⇒ 而我们**明明把它删了** ⇒ 面板在骗人。
         *   ⇒ 用 `dropUnmanaged` 把这些键从那份清单里摘掉
         *   （**值仍然保留**在合并结果里，随后由删除那条 write 删掉）。 */
        const legacyKeys = [];
        for (const m of c.models || []) {
          const legacy = String((m && m.id) || "");
          if (!legacy || legacy === tierOf(legacy)) continue;
          legacyKeys.push(legacy);
          const tier = tierOf(legacy);
          const legacyPath = `provider.${pid}.models.${escapeDots(legacy)}`;
          const old = curValue(file, "json", `${legacyPath}.name`);
          if (old && old.existed && typeof old.value === "string" && old.value && models[tier]) {
            models[tier] = { ...models[tier], name: old.value };
          }
        }
        const writes = [
          /* ⚠ 键是 `provider.<id>.<路径>` —— 键名里带点要转义（见文件头）。 */
          { path: `provider.${pid}.npm`, value: "@ai-sdk/openai-compatible" },
          /* provider 的**显示名**归用户：用户在 OpenCode 里改过就留着。
             ⚠ 这是「一个 write 只写一个字段」的声明（值是标量）⇒ 用**根模式」
               （theirs: [""]）：整个值逐值比对，一样就不动，不一样用户的赢。
               根模式对数组不适用（这里不是数组 ✓）。 */
          { path: `provider.${pid}.name`, value: c.providerName || "B.AI", merge: { theirs: [""] } },
          /* 地址与 key 是机器该管的（设计稿 §2.2(a)）—— 不参与比对、照写。 */
          { path: `provider.${pid}.options.baseURL`, value: `${String(c.baseUrl || "").replace(/\/+$/, "")}/v1` },
          { path: `provider.${pid}.options.apiKey`, value: c.apiKey || "" },
          /* 模型 id：机器该管的（设计稿 §2.2(a)）⇒ 照写、不比对。 */
          { path: `provider.${pid}.model`, value: pick.id },
          /* models 是**对象表**（**档位**当表名）：用户改过的**模型名**归用户
             （通配 `*.name`），表名与别的键是机器该管的 / 保留用户的。
             ⚠ 路径是**相对 value 根**的 —— value 根**就是**这张表 ⇒ 写 `*.name`
               而不是 `models.*.name`（后者在这张表里永远匹配不上）。
             ⚠ 档位里带点（`glm-5.2`）也没关系：合并层按**对象的键**递归，
               不走点分路径（merge-policy.mjs 的文件头）。 */
          { path: `provider.${pid}.models`, value: models, merge: { theirs: ["*.name"], dropUnmanaged: legacyKeys } },
          /* ★ **顶层 `model`** —— OpenCode 的**默认模型**在这儿（magpie 也写这儿）。
             ⚠ 写法是**引用** `providerId/modelId`（按第一个斜杠切）⇒
             *   `bai/<档位>`（**不是** `bai/sn/<档位>` —— 那会被切成
             *   provider=`bai`、model=`sn/<档位>` ⇒ 找不到）。
             ⚠ 这与 provider 块里的 `provider.<pid>.model` 是**两处**：
             *   两处都写、值都合法（实测三种组合都能跑通）。 */
          { path: "model", value: `${pid}/${tierOf(pick.id)}` },
        ];
        /* ── 迁移（2026-10-24）：上一版的表名是**每个**模型 id ──────────────
         *
         * 上一版我们把 `sn/claude-opus-5` 整个当表名 ⇒ 那张表在 OpenCode 里
         * 显示成 `bai/bai/sn/claude-opus-5`（选不了）。现在表名是档位 ⇒
         * **旧表名要删掉**，否则清单里会多出一条。
         *
         * ⚠ 删之前**把用户在那儿改过的模型名搬过来** —— 否则用户自定义的
         *   显示名会丢（那一格归用户，见文件头的归属表）。
         * ⚠ 旧表名里可能有**点**（`sn/glm-5.2`）⇒ 路径里要点转义。
         * ⚠ **每一个**模型都要迁（不只默认那个）—— 否则清单里会剩下
         *   别的档位的旧表名。 */
        for (const legacy of legacyKeys) {
          writes.push({ path: `provider.${pid}.models.${escapeDots(legacy)}`, delete: true });
        }
        return writes;
      },
      wired: (text, fmt) => {
        const r = fmt.getPath(text, `provider.${(ctx.providerId || "bai")}.options.baseURL`);
        return !!(r && r.ok && r.found && String(r.value || "").includes("127.0.0.1"));
      },
    },
  ],
};
