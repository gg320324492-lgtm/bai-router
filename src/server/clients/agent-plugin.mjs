// src/server/clients/agent-plugin.mjs —— 「**一份 JSON 加一个客户端**」
//
// ## 它补的是哪个洞
//
// 客户端接线声明（`src/server/clients/*.mjs`）现在有 28 份，全是**代码**：
// 加一个客户端 = 写一个 .mjs + 提一次 PR + 发一版。
//
// magpie 给的是另一条路 —— **agent plugin**（`docs/reference.md` 的
// 「Agent plugins」一节）：用户自己放一份 `*.agent.js` 声明，magpie 就多认识
// 一个客户端，面板上能接上/断开。
//
// ## ⚠ 为什么不执行第三方 JS（本文件最要紧的一条）
//
// magpie 的 agent plugin 是**要被执行**的：它的 pluginrt 是**进程内**的组合
// 运行时（`internal/agentplug` —— moejs，与主程序**同进程**跑）⇒ 第三方 JS 能
// 读用户文件、能起进程、能改任意状态 ⇒ 面板上点一下「装」，等于发了一段
// 任意代码执行权。
//
// 本仓**不做**这件事。理由不是偷懒，是**刻意的收窄**：
//
//   ① 客户端声明需要的**只是数据** —— 配置文件在哪、provider 块长什么样、
//      模型清单怎么写 —— **全是数据，不是逻辑**。magpie 那个 `connect()`
//      除了拼两三个值之外什么也没做，把它写成 JSON 一点能力都没少。
//   ② **数据可以被「看一眼」**。审一份 JSON 与审一段 JS 不是一回事：
//      审的人看不懂就等于没审 —— 而插件是要分发给别人的东西。
//   ③ **分发物的权力越小，装它的人越敢点「装」**。
//
// ⇒ 所以这里的插件是**一份 JSON 声明**，与「插件渠道」同构：声明放数据目录、
//   凭据不在声明里、撞键报错不覆盖、装不上不拖垮启动。
//
// ## magpie 的对应
//
//   magpie 的 agent 导出         本仓的 JSON 字段
//   ──────────────────────       ─────────────────────
//   id / name                    id / name
//   config（配置文件）            config（+ format）
//   model（模型 id 写在哪）        model
//   connect() 返回的键值对         writes（值是**模板**，不是 JS）
//   ——                         modelList（模型清单；magpie 靠 connect 拿到 models）
//   ——                         wired（怎么判「接上了」；magpie 靠 stash 指纹）
//   bin / ua / icon / notice     ——（本仓用不上，见文件末尾「做不到的」）
//   prefix（模型 id 前缀）        ——（**刻意不做**，见下面 prefix 那段）
//
// ## ⚠ prefix 为什么不做
//
// magpie 的模型 id 是裸的（`gpt-5.5`），它的客户端要 `openai/gpt-5.5` ⇒
// magpie 用 `prefix` 表达「客户端要的那一层命名空间」。
//
// 本仓的模型 id **自带**那一层：`provider/档位`（`bai/claude-opus-5`）——
// 那正是 prefix 的职责，已经在 id 里了。再加一层前缀会写成
// `openai/bai/claude-opus-5` ⇒ **网关按 provider 前缀认家，写成这样等于
// 把模型认错了**（这条本仓吃过亏：模型 id 必须写 provider/档位，写最终模型名
// 会静默换掉计费档位）。
//
// ⇒ 所以**不提供 prefix**。这不是少做一项，是同一件事换个地方表达。
//
// ## 声明的完整形状（v1）
//
// ```jsonc
// {
//   "manifestVersion": 1,
//
//   "id": "aider",                  // 客户端 id（小写字母数字 . _ -），不许与内置客户端撞
//   "name": "Aider",                // 面板上显示的名字
//   "protocol": "chat",             // 可选，默认 chat：chat / anthropic / responses / gemini
//   "note": "Aider（YAML 配置）",     // 可选：一句话说明
//
//   "config": "~/.aider.conf.yml",  // 必填：配置文件（~ 与 $VAR 会展开）
//   "format": "yaml",               // 可选：json / jsonc / yaml / toml / dotenv
//                                    //   （不给就按扩展名猜；猜不出来要报错）
//
//   "model": "model",               // 可选：模型 id 写在哪个键路径（不给 = 不写模型）
//
//   "writes": {                     // 可选：其它要写的键路径 → 值
//     "openai-api-base": "${baseUrlV1}",
//     "openai-api-key":  "${apiKey}"
//   },
//
//   "modelList": {                  // 可选：模型清单
//     "path": "models",             //   写在哪
//     "as": "array",                //   array（数组）| map（以模型 id 为键的对象）
//     "item": { "id": "${id}", "name": "${name}" }   // 每项长什么样
//   },
//
//   "wired": { "path": "openai-api-base", "value": "${baseUrlV1}" }  // 可选
// }
// ```
//
// ### 值怎么写：模板
//
// `writes` / `modelList.item` / `wired.value` 的值是**模板**，不是字面量：
//
//   · 整串就是 `${名字}` ⇒ 换成那个值的**原样**（字符串、数字、数组、对象都行）；
//   · 串里夹着 `${名字}` ⇒ 拼成文本（那个值得是字符串/数字/布尔）。
//
// 主作用域（`writes` / `wired.value` 里可用）：
//
//   ${baseUrl}      网关根地址（不带 /v1）
//   ${baseUrlV1}    网关的 /v1 地址
//   ${apiKey}       接线时给的**占位** key（本地网关不校验它，但客户端多半要求非空）
//   ${providerId}   接的那一家的键（"bai" / "sn" / 插件渠道的键…）
//   ${providerName} 接的那一家的显示名
//   ${modelId}      选中的模型 id（**provider/档位**）
//   ${modelLabel}   选中的模型显示名
//
// `modelList.item` 里可用（**每项各自一份**）：
//
//   ${id}           这一项的模型 id（provider/档位）
//   ${name}         这一项的模型显示名
//   ${provider}     同 ${providerId}
//   ${providerName} 同 ${providerName}
//
// ⚠ **键路径里只许用 `${providerId}`**（它的值不含点与斜杠，插进去不会把路径
//   切坏）。别的占位符不许出现在键路径里 —— 模型 id 是 `provider/档位`，
//   档位里可能带点（`glm-5.2`），插进键路径会把「父路径」算错 ⇒ 还原时炸掉。
//   需要「以模型 id 当表名」那种形状的客户端，用内置声明（Kimi / Grok / Pi…）。
//
// ### 凭据不许进声明
//
// 三条，与「插件渠道」同纪律：
//
//   ① 顶层字段名不许是凭据名（apiKey / key / token / secret / password…）；
//   ② **写凭据的那一处**（键路径末段含 key / token / secret / password…），
//      它的值**只能是占位符**，不许写字面量 —— 声明是要分发给别人的东西，
//      里面带 key 等于把你的 key 发给所有装它的人；
//   ③ 凭据的值永远来自接线时的上下文（`${apiKey}` ⇒ 本地网关的占位 key），
//      **不是**用户的真实上游 key —— 客户端连的是本机网关，不需要真 key。
//
// ## 纪律
//
//   · 装不上**不拖垮**：声明写错 ⇒ 一条**看得见的坏条目**（由 registry.mjs 造，
//     与内置声明坏了时的做法一模一样），其余客户端照常用。
//   · 撞 id **报错不覆盖**：插件 id 与内置客户端撞、或两个插件撞 ⇒ 都不装。
//   · 本模块**不写盘**：接线与还原由底座（base.mjs）管，它按路径级备份，
//     断开时只还原我们写过的那几处。
//
// ## 与「插件渠道」的目录分工
//
//   `<数据目录>/plugins/*.json`        插件**渠道** —— 加一家**上游**（provider）
//   `<数据目录>/agent-plugins/*.json`  插件**客户端** —— 加一个**客户端**
//
// 两个目录**分开**：一个是网关的上游落点，一个是面板的客户端名录，装的东西、
// 校验的规则、撞键的规则都不一样。混在一个目录里 ⇒ 插件渠道那套校验会把
// 客户端声明当渠道声明报错（反之亦然），用户看到的是「为什么我的客户端坏了」。
//
// ## 做不到的（magpie 能、我们收窄后不能）
//
//   · **执行第三方 JS**（magpie 的 connect() 可以写任意逻辑）—— 刻意不做。
//   · **一个客户端多个配置文件** —— 本版一个声明只管**一个**文件
//     （magpie 也是如此）。要多个文件 ⇒ 内置声明（Pi 要改两个文件）。
//   · **bin / ua / icon / notice / library**（magpie 用它们记可执行文件名、
//     User-Agent、图标、改完的提示、instructions/MCP/skills 的位置）——
//     本仓的客户端声明里没有这些位置。
//   · **connect-only 那种「客户端自己挑模型」的接法**（magpie 的 `model` 留空
//     时 connect 只写网关那几个键）—— 本仓的 `model` 省略时就是「不写模型」，
//     但**不写**模型清单 ⇒ 那样的客户端接上后没有模型可用。
//   · **按插件来源分组的「我的插件」视图**（magpie 的 Agents 页把插件装的
//     客户端与内置的分开列）—— 本仓的客户端屏是一张平表（插件装的会在
//     `note` 里标出「插件声明 xxx.json」）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseManifest, formatErrors } from "../plugin.mjs";
import { pickModel } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 数据目录的落点：与 server.mjs 的 DATA_DIR 同一口径（BAI_DATA_DIR 优先）。 */
const SERVER_DIR = path.dirname(HERE);

/* ====================================================================== *
 * 常量
 * ====================================================================== */

/** 声明的格式版本。现在只认 1 —— 版本不认识就报错（别猜着解析）。 */
export const AGENT_MANIFEST_VERSION = 1;

/** 插件目录名（相对数据目录）。与插件渠道的 `plugins` **分开**。 */
export const AGENT_PLUGIN_DIRNAME = "agent-plugins";

/**
 * 客户端 id 的形状：小写字母、数字、`.`、`_`、`-`；首字符得是字母或数字；
 * 总长 ≤ 64。
 *
 * 与 magpie 的 agentplug.idOK 同一套（`^[a-z0-9][a-z0-9._-]{0,63}$`）。
 * 由客户端 id 会进备份文件名、当 URL 的一段、也是面板上「是哪一家」的
 * 唯一标识 —— 放开大小写会造出 "Aider" 与 "aider" 两个看着一样、行为不同的。
 */
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 顶层允许出现的字段（其余一律当「不认识的字段」报错）。 */
const KNOWN_FIELDS = Object.freeze([
  "manifestVersion", "id", "name", "protocol", "note",
  "config", "format", "model", "writes", "modelList", "wired",
]);

/**
 * 凭据字段名 —— 顶层出现就是错。
 *
 * ⚠ 这是 plugin.mjs 的 `CREDENTIAL_FIELDS` 的**同一份名单**（那份没导出，
 *   只能抄）。抄的东西会漂 ⇒ `scripts/agent-plugin-test.mjs` 里有**防漂移
 *   断言**（对着 plugin.mjs 的源码比），名单变了会红。
 */
export const CREDENTIAL_FIELDS = Object.freeze([
  "apiKey", "api_key", "apikey", "key", "token", "accessToken", "access_token",
  "refreshToken", "refresh_token", "secret", "secretKey", "secret_key",
  "password", "credential", "credentials", "authorization", "bearer",
  "sessionToken", "session_token",
]);

/** 客户端能说的方言（与 base.mjs 文件头那句注释同一份）。 */
const PROTOCOLS = Object.freeze(["chat", "anthropic", "responses", "gemini"]);

/** 支持的文件格式 → 底座里注册的读写器名字。 */
const FORMATS = Object.freeze({
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  dotenv: "dotenv", env: "dotenv",
  "json-list": "json-list",
});

/** 按扩展名猜格式（声明里没写 format 时）。 */
const FORMAT_BY_EXT = Object.freeze({
  ".json": "json", ".jsonc": "json",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml",
  ".env": "dotenv",
});

/**
 * 主作用域的占位符。
 *
 * 值是给用户看的一句话说明（面板与报错里用得上）。
 */
export const PLACEHOLDERS = Object.freeze({
  baseUrl: "网关根地址（不带 /v1）",
  baseUrlV1: "网关的 /v1 地址",
  apiKey: "接线时给的占位 key",
  providerId: "接的那一家的键",
  providerName: "接的那一家的显示名",
  modelId: "选中的模型 id（provider/档位）",
  modelLabel: "选中的模型显示名",
});

/** `modelList.item` 里的占位符（每项各自一份）。 */
export const ITEM_PLACEHOLDERS = Object.freeze({
  id: "这一项的模型 id（provider/档位）",
  name: "这一项的模型显示名",
  provider: "接的那一家的键",
  providerName: "接的那一家的显示名",
});

/** 键路径里只许用的占位符（值不含点与斜杠，插进去不会把路径切坏）。 */
const PATH_PLACEHOLDERS = Object.freeze(["providerId"]);

/** 键路径末段里出现这些词 ⇒ 那一处是「写凭据的地方」。 */
const CREDENTIAL_WORDS = Object.freeze([
  "key", "apikey", "token", "accesstoken", "refreshtoken", "sessiontoken",
  "secret", "secretkey", "password", "passwd", "passphrase",
  "authorization", "bearer", "cookie", "credential", "credentials",
]);

/* ====================================================================== *
 * 目录
 * ====================================================================== */

/**
 * agentPluginDir —— 插件客户端的声明目录。
 *
 * `<数据目录>/agent-plugins`：
 *   · 安装版 ⇒ `%APPDATA%\bai-router\agent-plugins`（BAI_DATA_DIR 指的那儿）；
 *   · 开发版 ⇒ `src/server/agent-plugins`（与插件渠道的 `src/server/plugins`
 *     同一套落点规则，只是**目录名不同**）。
 *
 * ⚠ 与插件渠道的目录**必须分开**（理由见文件头）。
 * ⚠ 每次调用都现算（不缓存）—— 测试要能把它指到临时目录。
 */
export function agentPluginDir(dataDir) {
  const base = dataDir || process.env.BAI_DATA_DIR || SERVER_DIR;
  return path.join(base, AGENT_PLUGIN_DIRNAME);
}

/* ====================================================================== *
 * 校验
 * ====================================================================== */

/**
 * validateAgentManifest —— 逐项校验一份声明，给**人话**错误。
 *
 * 返回 `{ ok, errors, manifest }`：`errors` 每条 `{ field, message }`，
 * `manifest` 是过了之后的**归一化**声明（没过就是 null）。
 *
 * @param {object} obj 待校验的声明（parseAgentManifest 的产物）
 * @param {{builtinIds?:string[]}} [opts] 内置客户端的 id 名单（不许被插件占用）
 */
export function validateAgentManifest(obj, opts = {}) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  const builtin = new Set((Array.isArray(opts.builtinIds) ? opts.builtinIds : []).map(String));

  if (!isPlainObject(obj)) {
    return {
      ok: false,
      errors: [{ field: "", message: "声明的顶层必须是一个 JSON 对象（{ … }），不是数组或标量。" }],
      manifest: null,
    };
  }

  /* ① 凭据字段 —— 先查（与 plugin.mjs 同一顺序：它比「不认识的字段」更该被
   *    单独点名：作者以为带上了 key，被拒时若只说「不认识的字段」，他多半会
   *    改成随便一个别的名字再试一遍）。 */
  for (const k of Object.keys(obj)) {
    if (CREDENTIAL_FIELDS.includes(k)) {
      fail(k, `声明里不许带凭据字段「${k}」：插件是要分发给别人的东西，`
        + "里面带 key 等于把你的 key 发给所有装这个插件的人。凭据请在接线时给。");
    }
  }

  /* ② 不认识的字段 —— 报错而不是忽略（`conifg` 这种手误若被静默忽略，
   *    这份声明会以「没写配置文件」的样子通过，用户看到的是另一种错）。 */
  for (const k of Object.keys(obj)) {
    if (!KNOWN_FIELDS.includes(k) && !CREDENTIAL_FIELDS.includes(k)) {
      fail(k, `声明里有不认识的字段「${k}」：可用的字段只有 ${KNOWN_FIELDS.join("、")}。`);
    }
  }

  /* ③ 格式版本 */
  const mv = obj.manifestVersion;
  if (mv === undefined) {
    fail("manifestVersion", `声明缺少「manifestVersion」：这是声明的格式版本，本程序只认 ${AGENT_MANIFEST_VERSION}。`);
  } else if (typeof mv !== "number" || !Number.isInteger(mv)) {
    fail("manifestVersion", `格式版本得是整数（现在认 ${AGENT_MANIFEST_VERSION}），拿到的是 ${JSON.stringify(mv)}。`);
  } else if (mv !== AGENT_MANIFEST_VERSION) {
    fail("manifestVersion", `这份声明的格式版本是 ${mv}，本程序只认 ${AGENT_MANIFEST_VERSION}：`
      + "新版本写的东西旧程序读不了，别猜着解析。");
  }

  /* ④ 客户端 id */
  let id = null;
  if (obj.id === undefined) {
    fail("id", "声明缺少「id」：这是客户端的稳定标识（备份文件名、面板上的唯一标识都用它），"
      + "只许小写字母、数字、点、下划线和短横线。");
  } else if (typeof obj.id !== "string" || !obj.id.trim()) {
    fail("id", "客户端 id 得是一段非空的文字。");
  } else {
    id = obj.id.trim();
    if (!AGENT_ID_RE.test(id)) {
      fail("id", `客户端 id「${id}」不合法：只许小写字母、数字、点、下划线和短横线`
        + "（像 aider、my-client），而且第一个字符得是字母或数字。");
    } else if (builtin.has(id)) {
      fail("id", `客户端 id「${id}」跟内置客户端撞了：插件不能占用内置客户端的 id ——`
        + "那等于让一个插件顶掉内置的那一份，用户接的到底是哪个就说不清了。");
    }
  }

  /* ⑤ 显示名 */
  let name = null;
  if (obj.name === undefined) {
    fail("name", "声明缺少「name」：这是面板上显示的名字。");
  } else if (typeof obj.name !== "string" || !obj.name.trim()) {
    fail("name", "显示名不能为空。");
  } else if (obj.name.trim().length > 60) {
    fail("name", "显示名太长了（60 个字以内）。");
  } else {
    name = obj.name.trim();
  }

  /* ⑥ 方言 */
  let protocol = "chat";
  if (obj.protocol !== undefined) {
    if (typeof obj.protocol !== "string" || !PROTOCOLS.includes(obj.protocol)) {
      fail("protocol", `方言「${obj.protocol}」不认：只许 ${PROTOCOLS.join(" / ")}。`);
    } else {
      protocol = obj.protocol;
    }
  }

  /* ⑦ 一句话说明（可选） */
  let note = "";
  if (obj.note !== undefined) {
    if (typeof obj.note !== "string") {
      fail("note", "note 得是一段文字。");
    } else if (obj.note.trim().length > 200) {
      fail("note", "note 太长了（200 个字以内）。");
    } else {
      note = obj.note.trim();
    }
  }

  /* ⑧ 配置文件 */
  let config = null;
  if (obj.config === undefined) {
    fail("config", "声明缺少「config」：这是那个客户端的配置文件在哪"
      + "（可以写 ~ 开头，也可以写 $环境变量）。");
  } else if (typeof obj.config !== "string" || !obj.config.trim()) {
    fail("config", "配置文件路径得是一段非空的文字。");
  } else if (obj.config.includes("\0")) {
    fail("config", "配置文件路径里有空字节 —— 那不是路径。");
  } else {
    config = obj.config.trim();
  }

  /* ⑨ 格式 */
  let format = null;
  if (obj.format !== undefined) {
    if (typeof obj.format !== "string" || !FORMATS[obj.format.trim().toLowerCase()]) {
      fail("format", `格式「${obj.format}」不认：只许 ${Object.keys(FORMATS).join(" / ")}。`);
    } else {
      format = FORMATS[obj.format.trim().toLowerCase()];
    }
  } else if (config) {
    const ext = path.extname(String(config).split(/[\\/]/).pop() || "").toLowerCase();
    format = FORMAT_BY_EXT[ext] || null;
    if (!format) {
      fail("format", `看不出「${config}」是什么格式（扩展名「${ext || "无"}」不认识）：`
        + `请在声明里写明 format（${Object.keys(FORMATS).join(" / ")}）。`);
    }
  }

  /* ⑩ 模型写在哪个键（可选） */
  let model = "";
  if (obj.model !== undefined) {
    if (typeof obj.model !== "string" || !obj.model.trim()) {
      fail("model", "model 得是一段非空的文字（模型 id 写在哪个键路径）。");
    } else {
      model = obj.model.trim();
      for (const e of pathPlaceholders(model)) {
        if (!PATH_PLACEHOLDERS.includes(e)) {
          fail("model", `model 的键路径里不许用「\${${e}}」：键路径只许用 ${PATH_PLACEHOLDERS.map((x) => `\${${x}}`).join("、")}`
            + "（别的占位符的值可能带点或斜杠，插进键路径会把「父路径」算错 ⇒ 断开时还原会炸）。");
          break;
        }
      }
    }
  }

  /* ⑪ 要写的键路径 → 值 */
  const writes = {};
  if (obj.writes !== undefined) {
    if (!isPlainObject(obj.writes)) {
      fail("writes", "writes 得是一个对象（键路径 → 值，像 {\"openai-api-base\": \"${baseUrlV1}\"}）。");
    } else {
      for (const [k, v] of Object.entries(obj.writes)) {
        if (!k.trim()) {
          fail("writes", "writes 里有空的键路径。");
          continue;
        }
        for (const e of pathPlaceholders(k)) {
          if (!PATH_PLACEHOLDERS.includes(e)) {
            fail(`writes.${k}`, `键路径里不许用「\${${e}}」：只许用 ${PATH_PLACEHOLDERS.map((x) => `\${${x}}`).join("、")}。`);
            break;
          }
        }
        const phs = templatePlaceholders(v);
        for (const e of phs) {
          if (!Object.prototype.hasOwnProperty.call(PLACEHOLDERS, e)) {
            fail(`writes.${k}`, `占位符「\${${e}}」不认：可用的有 ${Object.keys(PLACEHOLDERS).map((x) => `\${${x}}`).join("、")}。`);
          }
        }
        /* ⚠ **写凭据的那一处，值只能是占位符** —— 字面量一律拒绝。
         *   这是「凭据不进声明」这条纪律的**兜底**：作者把真 key 写进来时，
         *   这一条会当场拦下，而不是把它发出去。
         *   ⚠ **要往对象里看**：写一个 provider 块时，声明长这样
         *     {"providers.bai": {"apiKey": "…"}} —— 凭据槽是**嵌套**的那一层，
         *     只看最外层的键路径会漏掉它。 */
        const credHits = credentialViolations(v, lastSegment(k));
        if (credHits.length) {
          fail(`writes.${k}`, `这一处是写凭据的地方（${credHits.map((x) => `「${x}」`).join("、")}），`
            + "值只能是占位符（${apiKey} 这样），不许写字面量 —— 声明是要分发给别人的东西，"
            + "里面带 key 等于把你的 key 发给所有装它的人。");
        }
        writes[k.trim()] = v;
      }
    }
  }

  /* ⑫ 模型清单 */
  let modelList = null;
  if (obj.modelList !== undefined) {
    if (!isPlainObject(obj.modelList)) {
      fail("modelList", "modelList 得是一个对象（{ path, as, item }）。");
    } else {
      const mlPath = obj.modelList.path;
      if (typeof mlPath !== "string" || !mlPath.trim()) {
        fail("modelList.path", "modelList 缺少「path」：模型清单写在哪。");
      } else {
        for (const e of pathPlaceholders(mlPath)) {
          if (!PATH_PLACEHOLDERS.includes(e)) {
            fail("modelList.path", `键路径里不许用「\${${e}}」：只许用 ${PATH_PLACEHOLDERS.map((x) => `\${${x}}`).join("、")}。`);
            break;
          }
        }
      }
      const as = obj.modelList.as === undefined ? "array" : obj.modelList.as;
      if (as !== "array" && as !== "map") {
        fail("modelList.as", `modelList.as「${as}」不认：只许 array（数组）或 map（以模型 id 为键的对象）。`);
      }
      if (!isPlainObject(obj.modelList.item)) {
        fail("modelList.item", "modelList 缺少「item」：清单里每一项长什么样"
          + "（一个对象模板，像 {\"id\": \"${id}\", \"name\": \"${name}\"}）。");
      } else {
        for (const e of templatePlaceholders(obj.modelList.item)) {
          if (!Object.prototype.hasOwnProperty.call(ITEM_PLACEHOLDERS, e)) {
            fail("modelList.item", `占位符「\${${e}}」不认：item 里可用的有 ${Object.keys(ITEM_PLACEHOLDERS).map((x) => `\${${x}}`).join("、")}。`);
          }
        }
        /* 清单的每一项里也不许藏字面量凭据（与 writes 同一条纪律）。 */
        const itemCreds = credentialViolations(obj.modelList.item, "");
        if (itemCreds.length) {
          fail("modelList.item", `清单项里${itemCreds.map((x) => `「${x}」`).join("、")}是写凭据的地方，`
            + "值只能是占位符（${apiKey} 这样），不许写字面量 —— 声明是要分发给别人的东西。");
        }
      }
      if (typeof mlPath === "string" && mlPath.trim() && isPlainObject(obj.modelList.item)
        && (as === "array" || as === "map")) {
        modelList = { path: mlPath.trim(), as, item: obj.modelList.item };
      }
    }
  }

  /* ⑬ 怎么判「接上了」 */
  let wired = null;
  if (obj.wired !== undefined) {
    if (!isPlainObject(obj.wired)) {
      fail("wired", "wired 得是一个对象（{ path, value } 或 { path, contains }）。");
    } else {
      const wp = obj.wired.path;
      if (typeof wp !== "string" || !wp.trim()) {
        fail("wired.path", "wired 缺少「path」：看哪一处来判断接上了。");
      } else {
        for (const e of pathPlaceholders(wp)) {
          if (!PATH_PLACEHOLDERS.includes(e)) {
            fail("wired.path", `键路径里不许用「\${${e}}」：只许用 ${PATH_PLACEHOLDERS.map((x) => `\${${x}}`).join("、")}。`);
            break;
          }
        }
      }
      const hasValue = obj.wired.value !== undefined;
      const hasContains = obj.wired.contains !== undefined;
      if (hasValue && hasContains) {
        fail("wired", "wired 里「value」与「contains」只能给一个（前者比相等，后者比包含）。");
      } else if (!hasValue && !hasContains) {
        fail("wired", "wired 得给「value」（那一处的值应当是什么）或「contains」（那一处应当包含什么）。");
      }
      if (hasValue) {
        for (const e of templatePlaceholders(obj.wired.value)) {
          if (!Object.prototype.hasOwnProperty.call(PLACEHOLDERS, e)) {
            fail("wired.value", `占位符「\${${e}}」不认：可用的有 ${Object.keys(PLACEHOLDERS).map((x) => `\${${x}}`).join("、")}。`);
          }
        }
      }
      if (typeof wp === "string" && wp.trim() && (hasValue || hasContains)) {
        wired = hasValue
          ? { path: wp.trim(), mode: "eq", value: obj.wired.value }
          : { path: wp.trim(), mode: "contains", value: obj.wired.contains };
      }
    }
  }

  /* ⑭ 总得写点什么 —— magpie 的 agentplug.go 也是这条：
   *    「agent.model names no key, and there is no connect to write the gateway:
   *    say one or both」。写不出任何东西的声明，接上了也没有意义。 */
  if (!model && !Object.keys(writes).length && !modelList) {
    fail("model", "这份声明没有写任何东西：至少要有 model、writes、modelList 之一"
      + "（不然接上了也不会有任何变化）。");
  }

  if (errors.length) return { ok: false, errors, manifest: null };

  return {
    ok: true,
    errors: [],
    manifest: {
      manifestVersion: AGENT_MANIFEST_VERSION,
      id, name, protocol, note,
      config, format,
      model,
      writes,
      modelList,
      wired,
    },
  };
}

/* ====================================================================== *
 * 生成客户端声明
 * ====================================================================== */

/**
 * agentPluginClient —— 把一份**过了校验**的声明变成客户端声明。
 *
 * 出来的形状与 `src/server/clients/*.mjs` 里那些内置声明**一模一样**
 * （`{ id, name, protocol, note, files(ctx) }`）⇒ 底座（base.mjs）不用知道
 * 这个客户端是从哪儿来的。
 *
 * 额外挂两个字段给面板/测试用：`plugin`（true）、`pluginFile`（哪份声明）。
 */
export function agentPluginClient(manifest, opts = {}) {
  const m = manifest;
  const source = opts.source == null ? "" : String(opts.source);
  const note = [m.note, source ? `（插件声明 ${source}）` : ""].filter(Boolean).join(" ");

  return {
    id: m.id,
    name: m.name,
    protocol: m.protocol,
    note,
    /* 面板上要认得出「这是用户自己加的」—— 内置客户端没有这两个字段。 */
    plugin: true,
    pluginFile: source,
    pluginDir: opts.dir == null ? "" : String(opts.dir),

    files: (ctx) => {
      const filePath = resolveConfigPath(m.config, ctx);
      return [
        {
          path: filePath,
          format: m.format,
          /* ⚠ **writes 必须是函数**：base.mjs 在调用它外面包了 try/catch ——
           *   「没有可选的模型」这类错会被报成「算 <客户端> 要写什么时出错」
           *   并**中止**（不写半个配置）。写在 files() 里就会变成一个没人接的
           *   异常，直接把整条接口掀了。 */
          writes: (c) => buildWrites(m, buildScope(m, c)),
          wired: (text, fmt) => judgeWired(m, buildScope(m, ctx), text, fmt),
        },
      ];
    },
  };
}

/* ====================================================================== *
 * 装（扫目录）
 * ====================================================================== */

/**
 * loadAgentPlugins —— 扫插件目录，把装得上的变成客户端声明，装不上的记下来。
 *
 * 返回 `{ dir, clients, errors }`：
 *   · `clients` —— 装上了的客户端声明；
 *   · `errors`  —— `[{ file, error }]`：**装不上的**声明与原因。
 *
 * ⚠ **一个装不上不许掀掉整张名单**（registry.mjs 会把每条 error 变成一条
 *   看得见的坏条目）。
 *
 * @param {{dir?:string, dataDir?:string, builtinIds?:string[]}} [opts]
 */
export function loadAgentPlugins(opts = {}) {
  const dir = opts.dir || agentPluginDir(opts.dataDir);
  const clients = [];
  const errors = [];
  let files = [];
  try {
    if (fs.existsSync(dir)) {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json")).sort();
    }
  } catch {
    /* 目录读不到就当没有插件 —— 不能因为一个目录坏了就起不来。 */
  }

  const seen = new Map();   // id → 文件名（撞 id 时要说清是谁撞谁）
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      const obj = parseManifest(text);
      const v = validateAgentManifest(obj, { builtinIds: opts.builtinIds });
      if (!v.ok) throw new Error(formatErrors(v.errors));
      if (seen.has(v.manifest.id)) {
        throw new Error(`客户端 id「${v.manifest.id}」已经有另一份声明了（${seen.get(v.manifest.id)}）：`
          + "一个客户端 id 只能有一份声明 —— 两份都装上会互相顶掉。");
      }
      seen.set(v.manifest.id, f);
      clients.push(agentPluginClient(v.manifest, { source: f, dir }));
    } catch (e) {
      errors.push({ file: f, error: String((e && e.message) || e).slice(0, 400) });
    }
  }
  return { dir, clients, errors };
}

/* ====================================================================== *
 * 内部
 * ====================================================================== */

/** 是不是普通对象（不是数组、不是 null）。 */
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * buildScope —— 接线时的那份上下文（占位符的值从这儿来）。
 *
 * ⚠ `modelId` 需要一个模型 —— 没有模型时**抛错**（与 util.mjs 的 pickModel
 *   同一句说法）：写一个没有模型的 provider 块对用户毫无意义。
 */
function buildScope(m, ctx) {
  const c = ctx || {};
  const models = Array.isArray(c.models) ? c.models : [];
  const needModel = needsModel(m);
  const pick = needModel ? pickModel(c) : (models[0] || null);
  return {
    baseUrl: String(c.baseUrl || ""),
    baseUrlV1: String(c.baseUrl || "") + "/v1",
    apiKey: String(c.apiKey || ""),
    providerId: String(c.providerId || "bai"),
    providerName: String(c.providerName || "B.AI"),
    modelId: pick ? String(pick.id || "") : "",
    modelLabel: pick ? String(pick.label || pick.id || "") : "",
    models,
  };
}

/** 这份声明要不要一个模型（model 字段，或模板里引用了 modelId/modelLabel）。 */
function needsModel(m) {
  if (m.model) return true;
  const phs = new Set();
  for (const v of Object.values(m.writes || {})) templatePlaceholders(v, phs);
  if (m.modelList && m.modelList.item) templatePlaceholders(m.modelList.item, phs);
  return phs.has("modelId") || phs.has("modelLabel");
}

/**
 * buildWrites —— 这份声明要写哪几处。
 *
 * 顺序：**model → writes → modelList**（先写模型那一处，模型清单在后 ——
 * 清单里用的就是模型 id）。
 */
function buildWrites(m, scope) {
  const out = [];
  if (m.model) {
    out.push({
      path: expandPath(m.model, scope, "model"),
      value: scope.modelId,
    });
  }
  for (const [k, v] of Object.entries(m.writes || {})) {
    out.push({
      path: expandPath(k, scope, `writes.${k}`),
      value: expandTemplate(v, scope, `writes.${k}`),
    });
  }
  if (m.modelList) {
    out.push({
      path: expandPath(m.modelList.path, scope, "modelList.path"),
      value: buildModelList(m.modelList, scope),
    });
  }
  return out;
}

/** 模型清单：数组（array）还是以模型 id 为键的对象（map）。 */
function buildModelList(ml, scope) {
  const list = Array.isArray(scope.models) ? scope.models : [];
  if (ml.as === "map") {
    const out = {};
    for (const one of list) {
      out[String(one.id || "")] = expandTemplate(ml.item, itemScope(one, scope), "modelList.item");
    }
    return out;
  }
  return list.map((one) => expandTemplate(ml.item, itemScope(one, scope), "modelList.item"));
}

/** 清单里每一项的模板作用域。 */
function itemScope(one, scope) {
  return {
    id: String(one.id || ""),
    name: String(one.label || one.id || ""),
    provider: scope.providerId,
    providerName: scope.providerName,
  };
}

/**
 * judgeWired —— 现在接的是不是我们。
 *
 * 声明里写了 `wired` 就按它说的判；没写就按**默认判据**：
 *   ① 值里含网关地址的那一处（内置声明也 mostly 是这么判的 —— 看它写的
 *      base url 还在不在）；
 *   ② 没有 ⇒ 模型那一处；
 *   ③ 还没有 ⇒ 第一处。
 */
function judgeWired(m, scope, text, fmt) {
  let spec = m.wired;
  if (!spec) {
    try {
      spec = defaultWiredSpec(m, scope);
    } catch {
      return false;
    }
  }
  if (!spec) return false;
  let p = "";
  try {
    p = expandPath(spec.path, scope, "wired.path");
  } catch {
    return false;
  }
  let cur;
  try {
    const r = fmt.getPath(text, p);
    if (!r || !r.ok || !r.found) return false;
    cur = r.value;
  } catch {
    return false;
  }
  let expected;
  try {
    expected = spec.mode === "contains"
      ? String(expandTemplate(spec.value, scope, "wired.value"))
      : expandTemplate(spec.value, scope, "wired.value");
  } catch {
    return false;
  }
  if (spec.mode === "contains") {
    return String(cur == null ? "" : cur).includes(String(expected == null ? "" : expected));
  }
  return sameValue(cur, expected);
}

/** 默认判据：挑一处「值里含网关地址」的写入口；没有就挑模型那一处。 */
function defaultWiredSpec(m, scope) {
  let writes = [];
  try {
    writes = buildWrites(m, scope);
  } catch {
    writes = [];
  }
  const base = String(scope.baseUrl || "");
  const hit = writes.find((w) => typeof w.value === "string" && base && w.value.includes(base));
  if (hit) return { path: hit.path, mode: "eq", value: hit.value };
  if (m.model) {
    const w = writes.find((x) => x.path === expandPath(m.model, scope, "model"));
    if (w) return { path: w.path, mode: "eq", value: w.value };
  }
  if (writes.length) return { path: writes[0].path, mode: "eq", value: writes[0].value };
  return null;
}

/**
 * expandTemplate —— 把模板换成值。
 *
 *   · 整串 `${名字}` ⇒ 换成那个值的**原样**（数组、对象也照原样）；
 *   · 串里夹着 `${名字}` ⇒ 拼成文本。
 */
function expandTemplate(tpl, scope, where) {
  if (typeof tpl === "string") return expandString(tpl, scope, where);
  if (Array.isArray(tpl)) return tpl.map((v, i) => expandTemplate(v, scope, `${where}[${i}]`));
  if (isPlainObject(tpl)) {
    const out = {};
    for (const [k, v] of Object.entries(tpl)) out[k] = expandTemplate(v, scope, `${where}.${k}`);
    return out;
  }
  return tpl;
}

function expandString(s, scope, where) {
  const whole = /^\$\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(s);
  if (whole) {
    const key = whole[1];
    if (!Object.prototype.hasOwnProperty.call(scope, key)) {
      throw new Error(`${where}：占位符「${key}」不认（可用的：${Object.keys(scope).join("、")}）`);
    }
    return scope[key];
  }
  return s.replace(/\$\{([A-Za-z][A-Za-z0-9]*)\}/g, (all, key) => {
    if (!Object.prototype.hasOwnProperty.call(scope, key)) {
      throw new Error(`${where}：占位符「${key}」不认（可用的：${Object.keys(scope).join("、")}）`);
    }
    const v = scope[key];
    if (v === null || v === undefined) return "";
    if (typeof v === "object") {
      throw new Error(`${where}：占位符「${key}」是个对象/数组，拼不进文本里 —— `
        + "要整个值就用「${" + key + "}」单独一串。");
    }
    return String(v);
  });
}

/**
 * expandPath —— 键路径里只许 `${providerId}`。
 *
 * ⚠ 别的占位符不许出现在键路径里：模型 id 是 `provider/档位`，档位里可能
 *   带点（`glm-5.2`），插进键路径会把「父路径」算错 ⇒ 还原时炸掉
 *   （这坑本仓踩过：base.mjs 那段「键里可以带点」的注释）。
 */
function expandPath(p, scope, where) {
  return String(p).replace(/\$\{([A-Za-z][A-Za-z0-9]*)\}/g, (all, key) => {
    if (!PATH_PLACEHOLDERS.includes(key)) {
      throw new Error(`${where}：键路径里不许用「${key}」：只许用 ${PATH_PLACEHOLDERS.join("、")}`);
    }
    return String(scope[key] == null ? "" : scope[key]);
  });
}

/** 模板里用到的占位符名字（去重）。 */
function templatePlaceholders(tpl, out = new Set()) {
  if (typeof tpl === "string") {
    for (const m of tpl.matchAll(/\$\{([A-Za-z][A-Za-z0-9]*)\}/g)) out.add(m[1]);
    return out;
  }
  if (Array.isArray(tpl)) {
    for (const v of tpl) templatePlaceholders(v, out);
    return out;
  }
  if (isPlainObject(tpl)) {
    for (const v of Object.values(tpl)) templatePlaceholders(v, out);
  }
  return out;
}

/** 键路径里用到的占位符名字（去重）。 */
function pathPlaceholders(p) {
  const out = new Set();
  for (const m of String(p).matchAll(/\$\{([A-Za-z][A-Za-z0-9]*)\}/g)) out.add(m[1]);
  return [...out];
}

/** 这个值是不是「整串就是一个占位符」。 */
function isPurePlaceholder(v) {
  return typeof v === "string" && /^\$\{[A-Za-z][A-Za-z0-9]*\}$/.test(v.trim());
}

/** 键路径的末段。 */
function lastSegment(p) {
  return String(p).split(".").pop() || "";
}

/**
 * isCredentialWord —— 这个名字像不像一个「写凭据的地方」。
 *
 * 按 `-` / `_` / `.` / 空格切开，逐段比对（不按子串比：`monkey` 里也有 "key"）。
 */
function isCredentialWord(name) {
  const words = String(name).split(/[-_.\s]+/).filter(Boolean).map((w) => w.toLowerCase());
  return words.some((w) => CREDENTIAL_WORDS.includes(w));
}

/**
 * credentialViolations —— 这份值里有没有「凭据槽里写着字面量」。
 *
 * 走遍整棵值：每一处的**名字**像凭据（key / token / secret / password…），
 * 而它的值**不是**一个占位符 ⇒ 就是一处违例。
 *
 * ⚠ 对象里的键也要看（`{"providers.bai": {"apiKey": "…"}}` —— 凭据槽在
 *   **嵌套**那一层，只看最外层会漏）。
 *
 * @returns {string[]} 违例的名字（去重）
 */
function credentialViolations(value, name, out = []) {
  if (isCredentialWord(name) && !isPurePlaceholder(value)) {
    out.push(name);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) credentialViolations(v, name, out);
    return out;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) credentialViolations(v, k, out);
  }
  return [...new Set(out)];
}

/** 两个值是不是同一个（对象按键序无关比）。 */
function sameValue(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

/**
 * resolveConfigPath —— 声明里的路径怎么变成真的路径。
 *
 *   · `~` / `~/…` ⇒ 家目录（**接线时的那份** ctx.home，测试里是临时目录）；
 *   · `$VAR` / `${VAR}` ⇒ 环境变量（magpie 的 pluggedPath 同一套）。
 *
 * ⚠ 展开之后**不在** ctx.home / %APPDATA% / %LOCALAPPDATA% 之下的 ⇒
 *   底座（base.mjs）会拒绝写（它有那道护栏）—— 这里不重复那道判断。
 */
function resolveConfigPath(cfg, ctx) {
  const home = String((ctx && ctx.home) || "");
  const env = (ctx && ctx.env) || process.env;
  let p = expandEnvVars(String(cfg || ""), env);
  if (p === "~") p = home;
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = path.join(home, p.slice(2));
  return path.resolve(p);
}

/** `$VAR` / `${VAR}` ⇒ 环境变量（没设就是空串，与 magpie 的 os.Expand 一致）。 */
function expandEnvVars(s, env) {
  const e = env || {};
  return String(s).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (all, a, b) => {
      const k = a || b;
      const v = e[k];
      return v == null ? "" : String(v);
    });
}
