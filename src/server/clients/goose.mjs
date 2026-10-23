// src/server/clients/goose.mjs —— Goose（Block 的 goose，CLI 与桌面端）
//
// ## 配置文件 —— **两个**
//
//   ① ~/.config/goose/config.yaml
//      （Windows 上是 %APPDATA%\Block\goose\config\config.yaml）
//
//      active_provider: bai              ← 用哪一家
//      providers:
//        bai:
//          enabled: true
//          model: sn/claude-opus-5        ← 哪家的哪个模型
//          configured: true
//
//   ② 同目录下的 custom_providers/bai.json —— **provider 自己的定义**
//      （Goose 启动时读）：
//
//      {
//        "name": "bai",
//        "engine": "openai",
//        "display_name": "B.AI",
//        "description": "…",
//        "api_key_env": "",
//        "base_url": "http://127.0.0.1:15799/v1",
//        "headers": { "Authorization": "Bearer …" },
//        "requires_auth": false,
//        "skip_canonical_filtering": true,
//        "dynamic_models": false,
//        "models": [ { "name": "sn/claude-opus-5", "context_limit": 128000 } ]
//      }
//
//      ⚠ 这个 JSON 的**根就是 provider 本身**（不是 providers.<id> 那一层），
//      所以我们逐个根键写（edit-json 的键路径不能指向根）。
//
// ## magpie 的对应
//
// internal/agent/goose.go。
//
// ## ⚠ 形状的核对程度
//
//   **形状照 magpie（internal/agent/<name>.go），本机没装这个客户端 ⇒ 未在本机核对过。**
//   本机装了并核对过真实配置的只有 MiniMax Code（~/.minimax/config.yaml）与
//   Hermes Agent（~/.hermes/config.yaml）—— 见那两个文件里的说明。
//
// ## 三件要说清的事
//
// ① **只写 config.yaml 是不够的** —— Goose 靠 custom_providers 那个文件才知道
//    我们这家怎么连、有哪些模型。magpie 也是两个文件一起写。
// ② **Goose 自己拼 /chat/completions**，base_url 写 at.v1()（带 /v1）。
// ③ **dynamic_models = false**：让 Goose 只用我们给的那几个模型，别去问网关的
//    /v1/models（那上面全是别家的模型与窗口）。skip_canonical_filtering 也是
//    同一个意思：别按 Goose 自己的目录过滤我们的模型。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：config.yaml 的四处 + custom_providers 那个 JSON。
//   · 做了 magpie 用 stash 做的那件事的**等价物**：那几处键路径的原值由底座
//     备份，断开时只还原那几处。
//   · 做了**保留用户手改**：
//     · `providers.bai.enabled`（开关）归用户 —— 用户在 Goose 里关掉的 provider
//       保持关（设计稿 §2.2(a)；ZCode 同）。
//     · `custom_providers/bai.json` 的 `display_name`（显示名）归用户。
//     · 模型清单里的 `context_limit`（窗口）归用户 —— 我们那个 128000 是兜底
//       不是真值，拿它盖掉用户自己调的会**提前截断**上下文。
//     · 用户自己在 custom_providers 里加的键保留 —— 我们逐个根键写，本来就不碰
//       它们（magpie 逐键合并，见 goose.go:161-178）。
//   · 没做：magpie 那套 `headers` 的**逐键**合并（magpie goose.go:176 把用户的
//     头并进我们的头里）—— 我们只逐键写 `headers.Authorization`，
//     用户自己加的别的头键留着，但同一个头键上用户改的值会被我们盖掉
//     （那是令牌，机器该管的）。
//   · 没做：老式的扁平键（GOOSE_PROVIDER / GOOSE_MODEL）—— magpie 会在新式的
//     providers 映射存在时把它们删掉；我们只写新式的那一套。
//   · 没做：每个模型「会不会思考」的判断（goose 的 `reasoning` 那个键）——
//     **我们不知道**，所以**不写那个键**（不写 false、也不写 true；理由见下面
//     providerJson 那处的注释）。我们只写 context_limit（且它是兜底值）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel } from "./util.mjs";
import { gwV1 } from "./client-utils.mjs";
import "./formats-yaml.mjs";

/** Goose 的配置目录：Windows 上 %APPDATA%\Block\goose\config，其余 ~/.config/goose。 */
function gooseDir(ctx) {
  if (process.platform === "win32") {
    const appdata = String(process.env.APPDATA || "").trim();
    if (appdata) return path.join(appdata, "Block", "goose", "config");
  }
  return path.join(ctx.home, ".config", "goose");
}

/** provider 的定义（custom_providers/<id>.json 的内容）。 */
function providerJson(ctx) {
  const models = (ctx.models || []).map((m) => ({
    name: m.id,
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
    context_limit: m.context || 128000,
  }));
  return {
    name: "bai",
    engine: "openai",
    display_name: ctx.providerName || "B.AI",
    description: "Every model this router has, through its local gateway",
    api_key_env: "",
    base_url: gwV1(ctx),
    headers: { Authorization: `Bearer ${ctx.apiKey || ""}` },
    requires_auth: false,
    skip_canonical_filtering: true,
    dynamic_models: models.length ? false : undefined,
    models,
  };
}

export const gooseClient = {
  id: "goose",
  name: "Goose",
  protocol: "chat",
  note: "Block 的 goose（CLI 与桌面端）",

  files: (ctx) => {
    const dir = gooseDir(ctx);
    return [
      {
        path: path.join(dir, "config.yaml"),
        format: "yaml",
        writes: () => {
          const pick = pickModel(ctx);
          return [
            { path: "active_provider", value: "bai" },
            /* ⚠ **开关归用户**（设计稿 §2.2(a)：「关掉的开关」是用户手改的东西；
             *   ZCode 那边的 `enabled` 也是这么归的）。根模式（`theirs: [""]`）：
             *   用户在 Goose 里把这个 provider 关掉了就让它关着。 */
            { path: "providers.bai.enabled", value: true, merge: { theirs: [""] } },
            { path: "providers.bai.model", value: pick.id },
            { path: "providers.bai.configured", value: true },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "providers.bai");
          return !!(r && r.ok && r.found);
        },
      },
      {
        /* Goose 的 provider 定义：custom_providers 目录下，文件名就是 provider 的 id */
        path: path.join(dir, "custom_providers", "bai.json"),
        format: "json",
        writes: () => {
          const p = providerJson(ctx);
          /* 根就是 provider 本身 ⇒ 逐个根键写 */
          const out = [];
          for (const [k, v] of Object.entries(p)) {
            if (v === undefined) continue;
            /* ⚠ **头逐键写**（不是整块写）：用户自己在 headers 里加的头留着
             *   （magpie goose.go:176 是逐键合并的）—— 我们只写自己那一个
             *   Authorization，它本来就是机器该管的（令牌）。
             *   ⚠ 整块写会把用户加的头整个盖掉。 */
            if (k === "headers" && v && typeof v === "object") {
              for (const [hk, hv] of Object.entries(v)) {
                out.push({ path: `headers.${hk}`, value: hv });
              }
              continue;
            }
            const w = { path: k, value: v };
            /* ⚠ **provider 的显示名归用户**（设计稿 §2.2(a)）—— 根模式：
             *   标量没法用子路径表达归属 ⇒ 整个值逐值比对，一样就不动，
             *   不一样**用户的赢**。 */
            if (k === "display_name") w.merge = { theirs: [""] };
            /* ⚠ **模型清单逐条合并**：用户自己加的模型留着、位置不变，
             *   我们那几条**就地**合并（用户改过的窗口留着）。识别键是模型 id
             *   （`name`）—— 逐条唯一 ⇒ 不用像 WorkBuddy 那样再排一次顺序。 */
            if (k === "models") w.merge = { mode: "array", key: "name", theirs: ["context_limit"] };
            out.push(w);
          }
          return out;
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "base_url");
          return !!(r && r.ok && r.found);
        },
      },
    ];
  },
};
