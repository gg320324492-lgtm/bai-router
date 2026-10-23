// src/server/clients/hermes.mjs —— Hermes Agent（Nous Research）
//
// ## 配置文件
//
//   $HERMES_HOME/config.yaml
//   （否则 Windows 上 %LOCALAPPDATA%\hermes\config.yaml，其余 ~/.hermes/config.yaml）
//
// ## magpie 的对应
//
// internal/agent/hermes.go。
//
// ## ⚠⚠ 形状有**版本差异** —— 这一层两种都得能用
//
// magpie 写的是**映射**（`providers:` 下面挂 provider）：
//
//   model:
//     provider: magpie
//     default: <模型 id>
//   providers:
//     magpie:
//       name: magpie
//       base_url: http://127.0.0.1:15799/v1
//       api_key: "…"
//       api_mode: chat_completions
//       extra_headers: { User-Agent: hermes-agent }
//       models: [ … ]
//
// 但**用户这版**（本机实测的真实 config.yaml）里 provider 是一个**数组**
// （`custom_providers:`），每个元素一条，而且**每条自带默认模型** `model:`：
//
//   custom_providers:
//   - name: xiaomi
//     base_url: "…"
//     api_key: "…"          ← ⚠ 里面有真凭据，别抄进任何夹具/注释/提交
//     api_mode: anthropic_messages
//     models:
//       mimo-v2.5-pro:
//         name: MiMo v2.5 Pro
//     model: mimo-v2.5-pro   ← 每个 provider 自带的默认模型
//   model:
//     default: mimo-v2.5-pro
//     provider: xiaomi
//
// 照 magpie 写映射 ⇒ **用户这版 Hermes 读不到** ⇒「配置写好了但客户端不认」
// ⇒ 接了等于没接。
//
// ⇒ **按用户文件里已有的形状走**：
//   · 文件里有 `custom_providers`（数组）⇒ 在那个数组里写/改**我们那一条**
//     （按 `name` 认：找得到就改它，找不到就**追加**一条；用户自己的条目不碰）
//   · 没有 ⇒ 按 magpie 的映射写
//
// ## 三件要说清的事
//
// ① **数组元素按名字改**：键路径写成 `custom_providers[name=bai].base_url` ——
//    方括号里是「判别键=值」（见 formats-yaml.mjs 的选择器）。
//    ⚠ **判别键 `name` 必须排在 writes 的最后** —— 断开时底座是按写入顺序
//    逐条还原的，先把 name 删了，后面那些就认不出那个元素了。
// ② **provider 条目里的 `model:` 字段**也要写（每个 provider 自带默认模型）——
//    用户的形状里有它，缺了 Hermes 可能选不出模型。
// ③ **base_url 带 /v1**（magpie 写的是 gw + "/v1"）。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：两种形状都支持；provider 条目、model.provider、model.default。
//   · 做了 magpie 用 stash 做的那件事的**等价物**：那几处的原值由底座备份，
//     断开时只还原那几处。
//   · 没做：**每个 profile（bot）各有一份 config.yaml**，magpie 把 provider 也
//     写进每一份（否则那些 bot 的模型选择器里没有我们）。我们只写主配置。
//   · 没做：用户自己在 provider 条目里加的键（key_env、key_cmd、
//     request_timeout_seconds、extra_body、context_length、enabled、ssl_*）——
//     我们只写自己那几个键，用户加的那些不碰。
//   · 没做：api_key 写成环境变量引用（${VAR}）与 .env 的那套处理 —— 我们直接写值。
//   · 没做：agent.reasoning_effort（思考档）—— 我们这层不知道模型的档位。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import fs from "node:fs";
import path from "node:path";
import { pickModel } from "./util.mjs";
import { curValue } from "./json-util.mjs";
import { gwV1, modelIds } from "./client-utils.mjs";
import "./formats-yaml.mjs";

/** 我们这一家在 Hermes 里的名字（判别键 `name` 的值）。 */
const OUR_NAME = "bai";

/**
 * Hermes 的目录：**按「哪个存在就用哪个」**找。
 *
 * ⚠ magpie 写的是「Windows 上 %LOCALAPPDATA%\hermes」—— 那是**magpie 支持的
 *   客户端版本**的位置，**不等于用户装的那一版**：本机这版在 `~/.hermes/`
 *   （文件确实在 `C:\Users\admin\.hermes\config.yaml`）。
 *   ⇒ 顺序：$HERMES_HOME → ~/.hermes → %LOCALAPPDATA%\hermes
 *     （最后一个是 magpie 那版的位置，留着兼容别的机器）。
 *   ⇒ 都不存在时用第一个（~/.hermes —— 本机这版的默认位置）。
 */
function hermesDir(ctx) {
  const home = String(process.env.HERMES_HOME || "").trim();
  if (home) return path.resolve(home);
  const candidates = [path.join(String(ctx.home || ""), ".hermes")];
  if (process.platform === "win32") {
    const local = String(process.env.LOCALAPPDATA || "").trim();
    if (local) candidates.push(path.join(local, "hermes"));
  }
  for (const dir of candidates) {
    try { if (fs.existsSync(dir)) return dir; } catch { /* 读不到就当没有 */ }
  }
  return candidates[0];
}

/**
 * 用户这版的形状：**数组**（custom_providers）还是 magpie 的**映射**（providers）。
 *
 * 读的是用户文件里已有的形状 —— 文件里没有 custom_providers 就按映射走
 * （magpie 的老形状，也是新建文件时的默认）。
 */
function shapeOf(file) {
  const v = curValue(file, "yaml", "custom_providers");
  if (v.existed && Array.isArray(v.value)) return "array";
  return "map";
}

/** provider 条目的公共字段（两种形状都一样，只是挂的地方不同）。 */
function providerFields(ctx, pick) {
  return {
    name: OUR_NAME,
    base_url: gwV1(ctx),
    api_key: ctx.apiKey || "",
    api_mode: "chat_completions",
    /* 每个 provider 自带的默认模型 —— 用户这版的形状里有它，
       缺了 Hermes 可能选不出模型 */
    model: pick.id,
    models: modelIds(ctx),
  };
}

export const hermesClient = {
  id: "hermes",
  name: "Hermes Agent",
  protocol: "chat",
  note: "Nous Research 的 Hermes（CLI 与桌面端；数组/映射两种形状都支持）",

  files: (ctx) => {
    const file = path.join(hermesDir(ctx), "config.yaml");
    return [
      {
        path: file,
        format: "yaml",
        writes: () => {
          const pick = pickModel(ctx);
          const fields = providerFields(ctx, pick);
          const out = [];
          if (shapeOf(file) === "array") {
            /* 数组形状：在 custom_providers 里写我们那一条。
               ⚠ 判别键 name 排最后 —— 它既是「这个元素是谁」的标记，
               又是最后被还原掉的那一个（顺序错了会认不出这个元素）。 */
            out.push({ path: `custom_providers[name=${OUR_NAME}].base_url`, value: fields.base_url });
            out.push({ path: `custom_providers[name=${OUR_NAME}].api_key`, value: fields.api_key });
            out.push({ path: `custom_providers[name=${OUR_NAME}].api_mode`, value: fields.api_mode });
            out.push({ path: `custom_providers[name=${OUR_NAME}].model`, value: fields.model });
            out.push({ path: `custom_providers[name=${OUR_NAME}].models`, value: fields.models });
            out.push({ path: `custom_providers[name=${OUR_NAME}].name`, value: fields.name });
          } else {
            /* 映射形状（magpie 的） */
            out.push({ path: `providers.${OUR_NAME}.name`, value: fields.name });
            out.push({ path: `providers.${OUR_NAME}.base_url`, value: fields.base_url });
            out.push({ path: `providers.${OUR_NAME}.api_key`, value: fields.api_key });
            out.push({ path: `providers.${OUR_NAME}.api_mode`, value: fields.api_mode });
            out.push({ path: `providers.${OUR_NAME}.model`, value: fields.model });
            out.push({ path: `providers.${OUR_NAME}.models`, value: fields.models });
          }
          /* 模型与 provider 各指哪一家 —— 两种形状都是这两处 */
          out.push({ path: "model.provider", value: OUR_NAME });
          out.push({ path: "model.default", value: pick.id });
          return out;
        },
        wired: (text, fmt) => {
          const a = fmt.getPath(text, `custom_providers[name=${OUR_NAME}]`);
          if (a && a.ok && a.found) return true;
          const m = fmt.getPath(text, `providers.${OUR_NAME}`);
          return !!(m && m.ok && m.found);
        },
      },
    ];
  },
};
