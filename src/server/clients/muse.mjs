// src/server/clients/muse.mjs —— Muse Code（Meta 的 muse CLI）
//
// ## 配置文件
//
//   ~/.config/muse/settings.json（$XDG_CONFIG_HOME 设了就用那儿）
//
// ## magpie 的对应
//
// internal/agent/muse.go。Muse 的请求去哪，是 endpoint_transport：
//
//   {"schema_version":1,
//    "endpoint_transport":{"base_url":"…","auth":"bearer"},
//    "model":"<模型 id>"}
//
// base_url 是它问的**那个 /responses**（OpenAI 的 Responses API，流式的）；
// auth 是 "bearer"（Meta 登录的令牌）或 "none"（不带 Authorization，也不问登录）。
//
// ⚠ Muse **拒绝没有 schema_version 的文件** —— 缺了它整份配置它不读。
//
// ## 我们这层做了什么 / 没做什么
//
//   · 做了：schema_version（缺才补）、endpoint_transport（base_url 指向网关、
//     auth 设为 none —— 这样 Meta 登录的令牌不会被送到我们的网关上）、model。
//   · base_url 我们填 **<网关>/v1**（不是不带 /v1 的根地址）：Muse 拼的是
//     base_url + "/responses"，而统一网关的 Responses 入口是 /v1/responses。
//   · 没做：magpie 把用户原来的 endpoint_transport / model **stash** 起来、
//     断开时放回去的那套（底座 base.mjs 备份的正是这两处的原值，断开时原样
//     还回去 —— 等价）。
//   · **做了：Muse 的模型清单**（2026-10-23 补）。Muse 的模型是从
//     <base_url 的主机>/muse-code/models 拉的那一份 —— 那个路径原先网关不提供，
//     于是 Muse 自己的清单里**没有**我们的模型。现在网关答它
//     （src/server/clients/muse-models.mjs 造清单，形状与 magpie 的 museModels
//     逐字同构；⚠ limit 是**兜底值**不是真实上限，Muse 会隐藏没有 limit 的模型）。
//
// ## 纪律
//
//   · 凭据不进这个文件（声明是分发物）：key 由接线时 ctx 给。
//   · 读不懂就不写：文件在但解析失败 ⇒ 底座报错、中止，用户的文件不动。

import path from "node:path";
import { curValue, pickModel, envDir } from "./json-util.mjs";

/** Muse 的配置目录。 */
function museDir(ctx) {
  const base = envDir("XDG_CONFIG_HOME") || path.join(ctx.home, ".config");
  return path.join(base, "muse");
}

export const museClient = {
  id: "muse",
  name: "Muse Code",
  protocol: "responses",
  note: "Meta 的 muse CLI（Responses 方言）",

  files: (ctx) => {
    const file = path.join(museDir(ctx), "settings.json");
    return [
      {
        path: file,
        writes: () => {
          const pick = pickModel(ctx);
          const writes = [];
          /* Muse 少了 schema_version 就不读这份文件 —— 缺了才补。 */
          if (!curValue(file, "json", "schema_version").existed) {
            writes.push({ path: "schema_version", value: 1 });
          }
          writes.push({
            path: "endpoint_transport",
            value: {
              /* Muse 拼 base_url + "/responses" ⇒ 这里要带 /v1。 */
              base_url: `${ctx.baseUrl}/v1`,
              /* none = 不带 Authorization，也不问登录 ——
                 Meta 登录的令牌不会被送到我们的网关上。 */
              auth: "none",
            },
          });
          writes.push({ path: "model", value: pick.id });
          return writes;
        },
        wired: (text, fmt) => {
          const r = fmt.getPath(text, "endpoint_transport.base_url");
          if (!(r && r.ok && r.found)) return false;
          const m = fmt.getPath(text, "model");
          return !!(m && m.ok && m.found);
        },
      },
    ];
  },
};
