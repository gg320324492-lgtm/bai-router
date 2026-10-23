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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 不是客户端声明的文件。 */
const NOT_CLIENT = new Set(["base.mjs", "registry.mjs"]);

let cache = null;

/**
 * allClients —— 列出全部客户端声明。
 *
 * 返回 `[{ id, name, protocol, note, files }]`，按 name 排（稳定顺序，
 * 面板上不会因为文件系统的读取顺序而跳动）。
 *
 * ⚠ 某个文件加载失败 ⇒ **抛出去**（让调用方如实报），不静默跳过 ——
 *   一个装不上的客户端声明，用户得知道。
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
  /* 按显示名排；同名按 id 排（保证顺序稳定）。 */
  out.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id))
    || String(a.id).localeCompare(String(b.id)));
  cache = out;
  return out;
}

/**
 * clientById —— 按 id 找一份客户端声明。找不到返回 null。
 */
export async function clientById(id) {
  const list = await allClients();
  return list.find((c) => String(c.id) === String(id)) || null;
}
