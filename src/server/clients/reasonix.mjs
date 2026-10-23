// src/server/clients/reasonix.mjs —— Reasonix Studio（2.x）与它的原生 CLI
//
// ## 配置文件 —— **两个**
//
//   ① ~/.reasonix/config.toml
//      （$REASONIX_HOME，否则 Windows 上 %APPDATA%\reasonix，其余 ~/.reasonix）
//
//      default_model = "bai/sn/claude-opus-5"     ← 执行器（Executor）用哪个模型
//
//      [agent]
//      planner_model = "bai/sn/claude-opus-5"      ← 计划（Plan）用哪个模型
//
//      [desktop]
//      provider_access = ["bai"]                  ← Studio 的「provider 访问权」
//
//      [[providers]]                              ← ⚠ 数组的表：一个 provider 一段
//      name = "bai"
//      kind = "openai"
//      base_url = "http://127.0.0.1:15799/v1"
//      api_key_env = "BAI_REASONIX_API_KEY"       ← 只写**变量名**
//      model = "sn/claude-opus-5"
//      models = ["sn/claude-opus-5"]
//      default = "sn/claude-opus-5"
//      no_proxy = true
//      （reasoning_protocol **不写** —— 那是「会不会思考」的断言，我们不知道）
//
//   ② 同一目录下的 .env —— 真的 key：
//
//      BAI_REASONIX_API_KEY=…
//
// ## magpie 的对应
//
// internal/agent/reasonix.go。
//
// ## ⚠ 形状的核对程度
//
//   **形状照 magpie（internal/agent/<name>.go），本机没装这个客户端 ⇒ 未在本机核对过。**
//   本机装了并核对过真实配置的只有 MiniMax Code（~/.minimax/config.yaml）与
//   Hermes Agent（~/.hermes/config.yaml）—— 见那两个文件里的说明。
//
// ## 三件要说清的事
//
// ① **provider 是数组的表**（[[providers]]），元素没有名字，只能靠里面的
//    `name` 认 —— 所以我们的键路径写成 `providers[name=bai].base_url`：
//    方括号里是「判别键=值」。TOML 读写器认这个写法（见 formats-toml.mjs）。
// ② **key 不在 config.toml 里**：Reasonix 的 provider 条目只有 api_key_env
//    （环境变量的名字），真的值在旁边的 .env。所以我们**要写两个文件**；
//    少写 .env 就等于没接（Reasonix 拿不到凭据）。
// ③ **model_overrides 我们没写**：那是每个模型的思考档、看图与否、窗口大小的
//    细账（magpie 的 reasonixModel）。我们这层不知道模型的这些细账，写上去
//    只能是编的。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：provider 段、default_model、agent.planner_model、
//     desktop.provider_access、.env 里的那个变量。
//   · 做了 magpie 用 stash 做的那件事的**等价物**：那几处的原值由底座备份，
//     断开时只还原那几处。
//   · 没做：model_overrides（逐模型的 supported_efforts / vision /
//     context_window / max_output_tokens）与 provider.effort。
//   · 没做：「用户自己写的 provider 段原样保留」—— magpie 认领**自己那一个**
//     （name = magpie 且 api_key_env 是它的那个变量），别人的不动；我们逐键
//     写 providers[name=bai] 里我们自己的那几个键，用户自己那一段不碰。
//   · 没做：.env 里那个变量已存在且不是我们写的时候要报「不是我们接的」
//     （magpie 的 checkOwner）—— 我们没做这个所有权检查。
//   · 没做：项目/会话级的模型覆盖（Executor 与 Plan 都能被覆盖）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { pickModel } from "./util.mjs";
import { gwV1, modelIds } from "./client-utils.mjs";
import "./formats-toml.mjs";
import "./formats-dotenv.mjs";

/** 我们写进 .env 的那个变量名（Reasonix 的 provider 条目只认变量名）。 */
export const REASONIX_KEY_ENV = "BAI_REASONIX_API_KEY";

/** Reasonix 的目录：$REASONIX_HOME，否则 Windows 上 %APPDATA%\reasonix，其余 ~/.reasonix。 */
function reasonixDir(ctx) {
  const home = String(process.env.REASONIX_HOME || "").trim();
  if (home) return path.resolve(home);
  if (process.platform === "win32") {
    const appdata = String(process.env.APPDATA || "").trim();
    if (appdata) return path.join(appdata, "reasonix");
  }
  return path.join(ctx.home, ".reasonix");
}

export const reasonixClient = {
  id: "reasonix",
  name: "Reasonix Studio",
  protocol: "chat",
  note: "Reasonix Studio 2.x 与原生 CLI",

  files: (ctx) => {
    const dir = reasonixDir(ctx);
    return [
      {
        path: path.join(dir, "config.toml"),
        format: "toml",
        writes: () => {
          const pick = pickModel(ctx);
          /* ⚠ **判别键 `name` 必须排在最后** ——
             数组的表（[[providers]]）的元素没有名字，只能靠里面的 name 认。
             断开时底座是**按写入的顺序**逐条还原的：先把 name 删了，后面那些
             `providers[name=bai].xxx` 就认不出那个元素了，键会留在文件里。
             所以 name 最后一个写、也最后一个删。 */
          return [
            { path: "providers[name=bai].kind", value: "openai" },
            { path: "providers[name=bai].base_url", value: gwV1(ctx) },
            { path: "providers[name=bai].api_key_env", value: REASONIX_KEY_ENV },
            { path: "providers[name=bai].models", value: modelIds(ctx) },
            { path: "providers[name=bai].model", value: pick.id },
            { path: "providers[name=bai].default", value: pick.id },
            /* ⚠ **reasoning_protocol 不写** —— 它是 magpie 那边对「这个模型会不会
               思考」的默认断言（magpie 有 catalog，逐个模型都算得出，所以它敢写；
               我们只有**档位**，同一档位映射到不同上游、能力逐家不同 ⇒ 真不知道）。
               「不写」与「写 false」对客户端等价，但「不写」把位置空着 ⇒ 将来
               有真值是「加一个键」。⚠ 写 "openai" 更糟：用户真去发一个上游不认的
               思考参数，当场报错。 */

            { path: "providers[name=bai].no_proxy", value: true },
            { path: "default_model", value: `bai/${pick.id}` },
            { path: "agent.planner_model", value: `bai/${pick.id}` },
            { path: "desktop.provider_access", value: ["bai"] },
            /* 判别键：最后写（也就最后被还原掉） */
            { path: "providers[name=bai].name", value: "bai" },
          ];
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "providers[name=bai].base_url");
          return !!(r && r.ok && r.found);
        },
      },
      {
        /* 真的 key 在 .env 里（provider 条目只有 api_key_env —— 变量名） */
        path: path.join(dir, ".env"),
        format: "dotenv",
        writes: () => [
          { path: REASONIX_KEY_ENV, value: ctx.apiKey || "" },
        ],
        wired: (text, fmt) => {
          const r = fmt.getPath(text, REASONIX_KEY_ENV);
          return !!(r && r.ok && r.found);
        },
      },
    ];
  },
};
