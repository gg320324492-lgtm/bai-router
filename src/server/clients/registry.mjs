// src/server/clients/registry.mjs —— 客户端接线的**名录**
//
// ## 为什么是「扫目录」而不是「写死一张表」
//
// 客户端接线文件是一个一个长出来的（每个客户端一份声明，见 base.mjs 的说明）。
// 写死一张表意味着每加一个客户端就要改两处 —— 而且漏改一处时，症状是
// 「文件在那儿但列表里没有」，很难查。
//
// 扫目录的代价是要认得出「哪些不是客户端声明」：
//   · `base.mjs` —— 是底座，不是客户端
//   · `formats-*.mjs` —— 是格式读写器（它们靠副作用注册自己）
//   · `registry.mjs` —— 是本文件
//   · `agent-plugin.mjs` —— 是插件声明的解析层，也不是客户端
//
// ## magpie 的对应
//
// magpie 的 `internal/agent/agents.go` 的 `builtins()` 是一张写死的表
// （66 个）。本仓用扫目录代替 —— 差别只在「加客户端时要不要改表」。
//
// ## 纪律
//
//   · 动态 import（所以新增的文件不用改本文件）
//   · 一个文件里可以有多个客户端声明（都收进来）
//   · 加载失败**如实报**，不静默跳过 —— 「有个客户端的声明坏了」必须看得见
//
// ## 两个来源
//
//   ① **内置声明** —— 本目录下的 `*.mjs`（上面的规则管的就是它）。
//   ② **插件声明** —— 用户放在 `<数据目录>/agent-plugins/*.json` 里的 JSON
//      （见 agent-plugin.mjs）。**一份 JSON 加一个客户端**，不用改代码。
//
// ⚠ 两个来源**目录分开**（`agent-plugins` vs 插件渠道的 `plugins`）：一个是
//   面板的客户端名录，一个是网关的上游落点，混在一起会让两套校验互相报错。
//
// ⚠ 插件声明装不上 ⇒ **一条看得见的坏条目**（与内置声明坏了时一模一样），
//   其余客户端照常用 —— 一个坏插件不该让面板变成一片空白。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadAgentPlugins, agentPluginDir } from "./agent-plugin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 不是客户端声明的文件。 */
const NOT_CLIENT = new Set(["base.mjs", "registry.mjs", "agent-plugin.mjs"]);

let cache = null;

/**
 * allClients —— 列出全部客户端声明（**两个来源**：内置的 .mjs + 插件的 JSON）。
 *
 * 返回 `[{ id, name, protocol, note, files }]`，按 name 排（稳定顺序，
 * 面板上不会因为文件系统的读取顺序而跳动）。
 *
 * ⚠ 某个声明装不上 ⇒ **不抛出去**，而是变成一条**看得见的坏条目**
 *   （`broken: true` + 说明为什么坏）—— 一个坏声明不许把整张名单掀成空白。
 *   内置的坏了与插件的坏了，坏条目的形状一样。
 *
 * ⚠ 结果**有缓存**：加了一个新的 .mjs 或放了一份新的插件 JSON 之后，要
 *   {@link rescanClients} 才会被看见。
 */
export async function allClients() {
  if (cache) return cache;
  const out = [];
  const files = fs.readdirSync(HERE).filter((f) => f.endsWith(".mjs")).sort();
  for (const f of files) {
    if (NOT_CLIENT.has(f)) continue;
    let mod;
    try {
      mod = await import(pathToFileURL(path.join(HERE, f)).href);
    } catch (e) {
      /* ⚠ **一个装不上的声明不许炸掉整张列表** —— 那样面板上会是一片空白，
       *   用户连「是哪个客户端坏了」都看不到。改成一条**看得见的**坏条目：
       *   列表里它带着错误说明，其余客户端照常用。 */
      out.push({
        id: "broken:" + f.replace(/\.mjs$/, ""),
        name: "（装不上的客户端声明）" + f,
        protocol: "",
        note: "这个声明文件加载失败：" + String((e && e.message) || e),
        broken: true,
        files: () => [],
      });
      continue;
    }
    /* `formats-*.mjs` 也要 import —— 它们靠**副作用**把 TOML/YAML 的读写器
       注册进 base.mjs 的格式表。不 import 的话，接 TOML 客户端时会说
       「还不知道怎么读写 toml 格式」。但它们不是客户端声明，不收进名录。 */
    if (f.startsWith("formats-")) continue;
    for (const v of Object.values(mod)) {
      if (!v || typeof v !== "object") continue;
      if (!v.id || typeof v.files !== "function") continue;
      out.push(v);
    }
  }
  /* 第二个来源：用户放的**插件声明**（`<数据目录>/agent-plugins/*.json`）。
   *
   * ⚠ 内置的 id 先算出来 —— 插件不许占用内置客户端的 id（撞了报错，不覆盖）。
   * ⚠ 装不上的插件声明 ⇒ **一条看得见的坏条目**（与内置声明坏了时同一套做法），
   *   其余客户端照常用。 */
  const plug = loadAgentPlugins({ builtinIds: out.map((c) => c.id) });
  for (const c of plug.clients) out.push(c);
  for (const e of plug.errors) out.push(brokenPluginEntry(e));

  /* 按显示名排；同名按 id 排（保证顺序稳定）。 */
  out.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id))
    || String(a.id).localeCompare(String(b.id)));
  cache = out;
  return out;
}

/**
 * brokenPluginEntry —— 装不上的插件声明，在名单里留一条**看得见**的痕迹。
 *
 * ⚠ 形状与内置声明加载失败时那条**一模一样**（id 带 broken: 前缀、
 *   `broken: true`、`files()` 返回空）—— 面板与测试认的就是那个形状。
 */
function brokenPluginEntry(e) {
  const file = String((e && e.file) || "");
  return {
    id: "broken-plugin:" + file.replace(/\.json$/i, ""),
    name: "（装不上的客户端声明）" + file,
    protocol: "",
    note: "这份插件声明装不上：" + String((e && e.error) || e),
    broken: true,
    plugin: true,
    files: () => [],
  };
}

/**
 * clientById —— 按 id 找一份客户端声明。找不到返回 null。
 */
export async function clientById(id) {
  const list = await allClients();
  return list.find((c) => String(c.id) === String(id)) || null;
}

/**
 * invalidateClientCache —— 丢掉名录缓存。
 *
 * ⚠ **谁在什么时候调用它**：用户往插件目录里放了一份新的 JSON 声明之后，
 *   名录得重扫一遍才看得见它（名录有缓存 ⇒ 不重扫就一直是旧的）。
 *   服务端要开一个「重新扫描」入口（POST 之类）调它 —— **接线由负责人做**
 *   （server.mjs 是热路径，本文件不碰它）。
 */
export function invalidateClientCache() {
  cache = null;
}

/**
 * rescanClients —— 重扫一遍名录（丢掉缓存 → 重新读目录），返回新的名单。
 *
 * 与 {@link invalidateClientCache} 的区别：它**顺带**把新名单读出来，
 * 调用方不用再调一次 allClients()。
 */
export async function rescanClients() {
  invalidateClientCache();
  return allClients();
}

/**
 * agentPluginsDir —— 插件声明在哪儿（面板要能告诉用户「把文件放这儿」）。
 */
export function agentPluginsDir(dataDir) {
  return agentPluginDir(dataDir);
}
