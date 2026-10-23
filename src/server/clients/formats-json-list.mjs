// src/server/clients/formats-json-list.mjs —— 「根是数组」的 JSON 文件
//
// ## 为什么要有它
//
// WorkBuddy / WorkBuddy AI / CodeBuddy Code 的 models.json **根是一个数组**：
//
//   [{"id":"qwen-local","local":true,"url":"http://127.0.0.1:8080/v1/chat/completions"}]
//
// 而底座默认的 JSON 读写器（edit-json.mjs 的 setPath）只认**对象根** ——
// 对数组根它直接说「根节点不是一个 JSON 对象」，一个字节都写不进去。
//
// magpie 是自己解析、自己写整个文件的（internal/agent/workbuddy.go 的
// workbuddyRead / buddyWrite），所以它两种形状都能应付。本格式把
// 「根是数组」这件事接进底座，路径有两种写法：
//
//   · "$list"  —— 列表就在**根**上（数组形状的文件）
//   · "models" —— 列表在 **"models" 键**下（对象形状的文件 —— CodeBuddy Code
//     的 CLI 写的就是那份：{"models":[…],"availableModels":[…]}）
//
// 客户端声明按文件**当前的形状**挑路径；文件不在时按该客户端的默认形状
// （WorkBuddy 写裸数组、CodeBuddy Code 写对象 —— 与 magpie 一致）。
//
// ## 形状不变（这一条最重要）
//
// magpie 写 WorkBuddy 时**保留用户文件原来的形状**：裸数组还是裸数组，对象还是
// 对象（buddyWriteAt 里 `d.rest == nil` 时 out 就是那个数组）。本格式也这样 ——
// 绝不把用户的裸数组改成对象，反之亦然。把 WorkBuddy 写的裸数组改成对象，
// WorkBuddy 可能就看不见那些模型了（用户的东西我们不替它做主）。
//
// ## 纪律：读不懂就不写
//
// 解析失败一律返回 `{ ok:false, error }` —— 与 edit-json.mjs、formats-toml.mjs
// 同一口径。底座拿到它就中止，一个字节都不写用户的文件。

import { getPath, setPath, delPath, parseJsonc, detectFormat } from "../edit-json.mjs";
import { registerFormat } from "./base.mjs";

/** 列表在**根**上的那条路径。 */
export const LIST_PATH = "$list";

/** 列表在 "models" 键下的那条路径。 */
export const MODELS_PATH = "models";

/* ------------------------------------------------------------------ *
 * 内部
 * ------------------------------------------------------------------ */

/** parseRoot —— 解析出根节点；空文件当「没有根」。 */
function parseRoot(text) {
  const t = String(text || "");
  if (t.trim() === "") return { ok: true, root: undefined, empty: true };
  const j = parseJsonc(t);
  if (!j.ok) return { ok: false, error: j.error, line: j.line, column: j.column };
  return { ok: true, root: j.value, empty: false };
}

/**
 * writeRootArray —— 整个文件重写成一个数组。
 *
 * 按**原文件的排版习惯**来：BOM、缩进单位、CRLF、末尾有没有换行 —— 都照旧。
 * 断开时我们要能把用户原来那份**原样写回去**，排版变了就是「动了用户的东西」。
 */
function writeRootArray(text, value) {
  const f = detectFormat(text);
  const empty = String(text || "").trim() === "";
  /* 空文件（新建）⇒ 按 magpie 的排版写：两格缩进 + 末尾一个换行。
     已有文件 ⇒ 照它的样子（有换行就跟着缩进，没有就紧凑着写）。 */
  const pretty = empty || /\n/.test(text);
  const body = pretty ? JSON.stringify(value, null, f.indentUnit || "  ") : JSON.stringify(value);
  const tail = (empty ? true : f.trailingNewline) ? "\n" : "";
  let out = (f.bom ? "﻿" : "") + body + tail;
  if (f.crlf) out = out.replace(/\n/g, "\r\n");
  return out;
}

/* ------------------------------------------------------------------ *
 * 三个函数
 * ------------------------------------------------------------------ */

/** getPath —— 读一条路径。 */
function listGetPath(text, p) {
  const r = parseRoot(text);
  if (!r.ok) return { ok: false, error: r.error, line: r.line, column: r.column };
  if (r.empty) return { ok: true, value: undefined, found: false };
  if (p === LIST_PATH) {
    return Array.isArray(r.root)
      ? { ok: true, value: r.root, found: true }
      : { ok: true, value: undefined, found: false };
  }
  /* 数组根的文件里没有「键路径」这回事（路径是给对象根用的）。 */
  if (!r.root || typeof r.root !== "object" || Array.isArray(r.root)) {
    return { ok: true, value: undefined, found: false };
  }
  return getPath(text, p);
}

/** setPath —— 写一条路径。 */
function listSetPath(text, p, value) {
  const r = parseRoot(text);
  if (!r.ok) return { ok: false, error: r.error, line: r.line, column: r.column };
  if (p === LIST_PATH) {
    if (!Array.isArray(value)) return { ok: false, error: `${LIST_PATH} 这条路径要的是一个数组` };
    if (!r.empty && !Array.isArray(r.root)) {
      return { ok: false, error: "这个文件的根是对象，列表不在根上（该用 models 这条路径）" };
    }
    const out = writeRootArray(text, value);
    return { ok: true, text: out, changed: out !== text };
  }
  if (!r.empty && Array.isArray(r.root)) {
    return { ok: false, error: "这个文件的根是数组，这条路径写不进去（该用 $list）" };
  }
  return setPath(text, p, value);
}

/** delPath —— 删一条路径。 */
function listDelPath(text, p) {
  const r = parseRoot(text);
  if (!r.ok) return { ok: false, error: r.error, line: r.line, column: r.column };
  if (r.empty) return { ok: true, text, changed: false };
  if (p === LIST_PATH) {
    if (!Array.isArray(r.root)) return { ok: true, text, changed: false };
    /* 列表整个没了：留一个空列表（magpie 的 Disconnect 也留一个空列表，
       它不删用户的文件）。 */
    const out = writeRootArray(text, []);
    return { ok: true, text: out, changed: out !== text };
  }
  if (Array.isArray(r.root)) return { ok: true, text, changed: false };
  return delPath(text, p);
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

registerFormat("json-list", { getPath: listGetPath, setPath: listSetPath, delPath: listDelPath });

export {
  listGetPath as jsonListGetPath,
  listSetPath as jsonListSetPath,
  listDelPath as jsonListDelPath,
};
