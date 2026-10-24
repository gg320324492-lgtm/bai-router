// src/server/clients/cline.mjs —— Cline 的 CLI
//
// ## 配置文件
//
//   ~/.cline/data/settings/providers.json（$CLINE_DIR / $CLINE_DATA_DIR 改了就是那儿）
//   ~/.cline/data/settings/models.json      （模型清单在它旁边）
//   ~/.cline/data/globalState.json          （★ 第二层，见下）
//   ~/.cline/data/secrets.json              （★ 第二层，见下）
//
// ## magpie 的对应
//
// internal/agent/cline.go。Cline 的 provider 都在 providers.json 里：
//
//   {"version":1,"lastUsedProvider":"<id>","modes":{},"providers":{"<id>":{
//     "settings":{"provider":"<id>","apiKey":…,"model":…,"baseUrl":…,
//       "headers":{…},"reasoning":{"effort":…}},
//     "updatedAt":…,"tokenSource":"manual"}}}
//
// 一个会话跑的是 lastUsedProvider 那个 provider 的模型。
//
// ⚠ **magpie 接管的是 Cline 内建的 openai-compatible provider**（不是自己新增
//   一个）：Cline 会拒绝 providers.json 里一个它不认识的 provider（"Unknown or
//   disabled provider"），而它内建的那个 openai-compatible 只列 gpt-4o。所以
//   magpie 把模型清单写进**另一个文件** models.json 里那个 provider 的位置：
//
//   {"version":1,"providers":{"openai-compatible":{
//     "provider":{"name":"…","baseUrl":"…","defaultModelId":"<模型 id>"},
//     "models":{"<模型 id>":{"id":…,"name":…,"capabilities":["streaming","tools"]}}}}}
//
// ## ★ 第二层：globalState.json + secrets.json（2026-10-24 补）
//
// **只写 providers.json + models.json 的话，Cline CLI 一个请求都发不出去。**
//
// 实测（真 cline CLI v2.14.0 + 隔离 HOME + 本地假上游，2026-10-23）：
// 只写我们原来那两份 ⇒ CLI 直接输出
// 「Not authenticated. Please run 'cline auth' first」⇒ **零请求**。
//
// 原因：Cline 的**认证门**读的是**另一份状态**，不是 providers.json：
// 它用全局状态构造出 `apiConfiguration`，再看那儿有没有内置 provider 的键
// （`openAiApiKey` / `apiKey`(anthropic) / `clineApiKey` …）。
// 那份状态在两个文件里：
//
//   ~/.cline/data/globalState.json
//     openAiBaseUrl            ← **地址**
//     openAiHeaders            ← {"User-Agent":"cline"}
//     actModeApiProvider       ← "openai"（= openai-compatible 那个槽位）
//     planModeApiProvider      ← 同上
//     actModeOpenAiModelId     ← 模型 id
//     planModeOpenAiModelId    ← 同上
//   ~/.cline/data/secrets.json
//     openAiApiKey             ← **凭据**
//
// magpie 写的正是这两份（`internal/agent/cline.go:72-108`）—— 它的注释还写明
// 「**扩展层优先读自己那份 state**，providers.json 的 `lastUsedProvider` 只在
// 「模式没选模型」时才生效」。
//
// ### 与 magpie 的一处**有意**不同
//
// magpie **只在 `globalState.json` 已存在时**才写第二层
// （`if _, err := os.Stat(state); err != nil { return nil }`）——
// 因为它瞄准的是 **VS Code 扩展**那份状态，扩展没跑过就没有那份文件。
//
// **我们无条件写**（文件不在就建）：我们接的是 **CLI**，而 **CLI 自己第一次跑
// 就会建 globalState.json**（实测：它建了 `welcomeViewCompleted` 等键）⇒
// 「等用户先跑一次再点接上」不是我们能接受的交互。
// ⇒ 文件不在时我们建一份（只放我们写的这几个键），Cline 之后自己往里补它的键
// （实测：它读我们那份、用着我们的地址，同时把缺的键补上）。
//
// ### 断开时怎么还原
//
// 底座按**键路径**备份 ⇒ 断开时只把我们写的那几个键还原/删掉，
// 用户自己在 globalState.json / secrets.json 里的其它键一个字不动。
// （文件是我们建的 ⇒ 断开后剩一个只含 Cline 自己的键的文件 —— 那是 Cline 的
// 文件，不是我们的痕迹。）
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：providers.json 的 providers.openai-compatible（带 key、模型、地址、
//     User-Agent 头）、lastUsedProvider，models.json 里那份模型清单，
//     以及上面那**第二层**（globalState.json + secrets.json）。
//   · 没做：**effort**。magpie 写 settings.reasoning（{"enabled":true,"effort":…}）。
//     我们的接线上下文里没有 effort 这一项 —— 不猜，不写一个客户端不认的值。
//   · 没做：magpie 对 **Cline 桌面版**那一层（它在 web view 的 localStorage 里
//     挑 provider 与模型，根本不读这些文件）。
//
// ## 保留用户手改（通用合并层）
//
// | 字段 | 归谁 | 为什么 |
// | --- | --- | --- |
// | models.json 的 `providers.openai-compatible.provider.name` | **用户的** | 用户在 Cline 里改过的 provider 显示名留着（设计稿 §2.2(a)） |
// | models.json 的 `providers.openai-compatible.models.<模型 id>.name` | **用户的** | 用户改过的模型显示名留着（同上） |
// | models.json 的模型 id（表名与 `.id`） | 我们的 | 模型 id 集合是机器该管的（§2.2(a)） |
// | providers.json 里我们没写的键（`settings.reasoning` 思考档…） | **保留用户的** | 弱保留那一层（我们没写 ⇒ 留着；magpie cline.go:409-429 同款） |
// | `settings.apiKey` / `baseUrl` / `model` / `headers.User-Agent`、`provider.baseUrl` / `defaultModelId` | 我们的 | 地址、令牌、方言与「用哪一档」是机器该管的（§2.2(a)）—— 照写、不比对 |
// | `lastUsedProvider` | 我们的 | 机器该管的：我们接的就是那个槽位 |
// | globalState.json 里我们没写的键 | **保留用户的** | 弱保留那一层（逐键写 ⇒ 天然只碰我们那几处） |
// | `openAiHeaders` 里用户自己加的头 | **保留用户的** | 弱保留那一层（`merge: { theirs: [] }`） |
// | `openAiBaseUrl` / `openAiApiKey` / `actMode*` / `planMode*` | 我们的 | 地址、凭据与「用哪一档」机器该管（§2.2(a)）—— 照写、不比对 |
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//     ⚠ 但 **secrets.json 里的 `openAiApiKey` 就是那个 key 的落点** ——
//     客户端就认那儿，不写进去它就不认我们 ⇒ 这是**运行时**的值，不是声明里的。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { curValue, pickModel, envDir } from "./json-util.mjs";
import { gwV1 } from "./client-utils.mjs";

/** magpie 接管的那个 provider 的 id（Cline 内建的那个 openai-compatible）。 */
const SLOT = "openai-compatible";

/** 配置文件在哪儿。 */
function clineFiles(ctx) {
  const dir = envDir("CLINE_DIR") || path.join(ctx.home, ".cline");
  const data = envDir("CLINE_DATA_DIR") || path.join(dir, "data");
  const settings = path.join(data, "settings");
  return {
    providers: path.join(settings, "providers.json"),
    models: path.join(settings, "models.json"),
    /* ⚠ 第二层在 **data 目录下**（不是 settings/ 下）——
     *   magpie 的 cline.go:72 就是 `filepath.Join(data, "globalState.json")`。 */
    state: path.join(data, "globalState.json"),
    secrets: path.join(data, "secrets.json"),
  };
}

export const clineClient = {
  id: "cline",
  name: "Cline",
  protocol: "chat",
  note: "Cline 的 CLI（OpenAI 兼容 provider）",

  /* ⚠ **「装没装」看客户端自己的目录**，不看 `data/settings/` ——
   *   那是 **Cline 第一次运行才建**的（实测：首次跑会写 welcomeViewCompleted
   *   等键）⇒ 刚装上、还没跑过的 Cline 会被误判成「没装这个客户端」。
   *   （ZCode 当年也是这个坑：ZCode 的判据已修过一轮。）
   *   声明了这一条 ⇒ 面板上说的是「装了，但还没生成过这个配置文件」，
   *   用户不用去下载。 */
  installedDir: (ctx) => envDir("CLINE_DIR") || path.join(ctx.home, ".cline"),

  files: (ctx) => {
    const files = clineFiles(ctx);
    return [
      {
        /* providers.json 先写 —— 它是「用哪个 provider」的那一份；
           models.json 写失败时它已经写好了，底座会如实报错并留下备份。 */
        path: files.providers,
        writes: () => {
          const pick = pickModel(ctx);
          const entry = {
            settings: {
              provider: SLOT,
              apiKey: ctx.apiKey || "",
              model: pick.id,
              baseUrl: ctx.baseUrl,
              /* Cline 自己的请求只带 AI SDK 的 User-Agent，认不出是 Cline ——
                 这个头是 magpie 加的，一并照抄。 */
              headers: { "User-Agent": "cline" },
            },
            updatedAt: new Date().toISOString(),
            tokenSource: "manual",
          };
          const writes = [];
          /* version 只在缺的时候补 —— 用户自己写的版本号我们不改。 */
          if (!curValue(files.providers, "json", "version").existed) {
            writes.push({ path: "version", value: 1 });
          }
          /* ⚠ **保留用户手改**：这一条整块写下去会把用户在 Cline 里设的
           *   **思考档**（`settings.reasoning`）、自己加的 headers 一起盖掉。
           *   ⇒ 挂一份「弱保留」的合并声明：`theirs: []` = **没有哪个键显式
           *   归用户**，但**我们没写的键保留用户的**（合并层的第三层，
           *   magpie 的 theirsKept 同款）。
           *   而我们写的那几个键（`settings.apiKey` / `baseUrl` / `model`、
           *   `headers.User-Agent`）仍然是机器该管的 ⇒ 照写、不比对
           *   （设计稿 §2.2(a)）。 */
          writes.push({ path: `providers.${SLOT}`, value: entry, merge: { theirs: [] } });
          writes.push({ path: "lastUsedProvider", value: SLOT });
          return writes;
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, `providers.${SLOT}`);
          return !!(r && r.ok && r.found);
        },
      },
      {
        path: files.models,
        writes: () => {
          const pick = pickModel(ctx);
          const models = {};
          for (const m of ctx.models || []) {
            models[m.id] = {
              id: m.id,
              name: m.label || m.id,
              capabilities: ["streaming", "tools"],
            };
          }
          const writes = [];
          if (!curValue(files.models, "json", "version").existed) {
            writes.push({ path: "version", value: 1 });
          }
          writes.push({
            path: `providers.${SLOT}`,
            value: {
              provider: {
                name: ctx.providerName || "B.AI",
                baseUrl: ctx.baseUrl,
                defaultModelId: pick.id,
              },
              models,
            },
            /* ⚠ **保留用户手改**（通用合并层）：
             *   · `provider.name` —— 用户在 Cline 里改过的 provider 显示名留着
             *     （设计稿 §2.2(a)）。
             *   · `models.<模型 id>.name` —— 用户改过的模型显示名留着（同上）。
             *     ⚠ 通配写 `models.*.name`：路径是**相对 value 根**的，而这条
             *       write 的 value 根**就是** `providers.openai-compatible` 那个
             *       对象 ⇒ `models` 下面才是模型表 ⇒ `models.*.name` 匹配得上。
             *   · 模型 id（`models` 的表名与 `models.<id>.id`）是机器该管的 ⇒
             *     换回我们的；用户自己加的模型条目原样留着（弱保留那一层）。
             *   · `provider.baseUrl` / `defaultModelId` 是机器该管的 ⇒ 照写。 */
            merge: { theirs: ["provider.name", "models.*.name"] },
          });
          return writes;
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, `providers.${SLOT}`);
          return !!(r && r.ok && r.found);
        },
      },
      /* ── 第二层：globalState.json ──────────────────────────────────────
       *
       * Cline 的认证门与地址都读这份状态（见文件头「★ 第二层」）。
       * ⚠ **逐键写** ⇒ 用户自己在 globalState.json 里的其它键一个字不动
       *   （Cline 自己会往里放 welcomeViewCompleted / remoteRulesToggles…）。
       */
      {
        path: files.state,
        writes: () => {
          const pick = pickModel(ctx);
          return [
            /* ⚠ **"openai"** 是 Cline 那边 openai-compatible 槽位的名字
             *   （magpie 的 cline.go:100 照抄：actModeApiProvider = "openai"）。 */
            { path: "actModeApiProvider", value: "openai" },
            { path: "planModeApiProvider", value: "openai" },
            { path: "actModeOpenAiModelId", value: pick.id },
            { path: "planModeOpenAiModelId", value: pick.id },
            /* ⚠ **带 /v1**（magpie 的 at.v1()）—— 这一格 Cline 是**原样**用的
             *   （providers.json 那格它自己会拼 /v1 ⇒ 两处不一样，别抄错）。 */
            { path: "openAiBaseUrl", value: gwV1(ctx) },
            /* 用户自己在这个对象里加的头留着（弱保留）。 */
            { path: "openAiHeaders", value: { "User-Agent": "cline" }, merge: { theirs: [] } },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "openAiBaseUrl");
          return !!(r && r.ok && r.found && String(r.value || "").includes("127.0.0.1"));
        },
      },
      /* ── 第二层：secrets.json ───────────────────────────────────────────
       *
       * 凭据的落点（Cline 的认证门认 `openAiApiKey`）。
       * ⚠ **凭据不进声明文件** —— 这里写的是**运行时**给的值（ctx.apiKey），
       *   而客户端就认这个文件 ⇒ 不写进去它就不认我们。
       */
      {
        path: files.secrets,
        writes: () => [{ path: "openAiApiKey", value: ctx.apiKey || "" }],
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "openAiApiKey");
          return !!(r && r.ok && r.found && String(r.value || "") !== "");
        },
      },
    ];
  },
};
