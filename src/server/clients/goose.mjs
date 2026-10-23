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
//   · 没做：用户自己在 custom_providers 里加的 display_name、header 保留
//     （magpie 逐键合并；我们逐个根键写，display_name 与 header 这两处
//     我们写自己的值 —— 用户改的那份不会自动跟着回来）。
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
            { path: "providers.bai.enabled", value: true },
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
            out.push({ path: k, value: v });
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
