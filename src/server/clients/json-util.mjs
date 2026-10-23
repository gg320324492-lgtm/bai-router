// src/server/clients/json-util.mjs —— 这一批 **JSON** 客户端声明的共用小工具
//
// ## 为什么单独一个文件
//
// TOML / YAML 那一批客户端用不上「读用户当前配置」这一类工具（那两个格式的
// 读写器自己管解析）；JSON 这一批几乎每个都要先读一遍用户的配置，再决定往
// 哪儿写什么（把用户自己的条目留在前面，把我们的一块加进去）。
//
// ⚠ 读文件走 base.mjs 的 readFileText（文件不在 ≠ 读不出来，两件事分开）；
//   取值走 base.mjs 的 pathValue（它把「读不出来」与「没有」分得清清楚楚 ——
//   这两件事混同是本仓库吃过大亏的地方：把用户配置读失败当成空对象再写回去，
//   用户其余配置当场蒸发）。
//
// 本文件**不导出任何客户端声明**（没有 id + files 的对象）—— 名录 registry.mjs
// 扫目录时会把这里的函数跳过。

import { readFileText, pathValue, formatOf } from "./base.mjs";
import { parseJsonc } from "../edit-json.mjs";

/* 共享的那两个（util.mjs）在每个客户端都要用，这里转出去，
   客户端就只认一个入口。 */
export { pickModel, envDir } from "./util.mjs";

/**
 * curValue —— 用户当前配置里某个键路径的值。
 *
 * 返回 `{ existed: true, value }`（有）、`{ existed: false }`（没有）、
 * `{ error }`（读不出来 —— 调用方要么报错中止，要么当「没有」处理，
 * **绝不**拿它当空配置覆盖用户的文件）。
 */
export function curValue(file, fmtName, p) {
  const fmt = formatOf(fmtName || "json");
  if (!fmt) return { error: `还不知道怎么读写 ${fmtName} 格式的文件` };
  const r = readFileText(file);
  if (!r.ok) return { error: r.error };
  const v = pathValue(r.text, p, fmt);
  if (v.error) return { error: v.error };
  return v.existed ? { existed: true, value: v.value } : { existed: false };
}

/** 是不是普通对象（不是数组、不是 null）。 */
export function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * curObj —— 用户当前配置里某个**对象**的值；不是对象就当没有。
 *
 * 用户的值写坏了（该是对象的地方是个数组）⇒ 当没有 —— 我们写自己的那份，
 * 底座会把原值备份下来，断开时原样还回去。
 */
export function curObj(file, fmtName, p) {
  const v = curValue(file, fmtName, p);
  return v.existed && isObj(v.value) ? v.value : null;
}

/**
 * mergeObj —— 把我们的字段盖在用户的对象上。
 *
 * 用户那份不是对象 ⇒ 只用我们的（不猜、不把用户的数组摊成键）。
 */
export function mergeObj(base, ours) {
  return isObj(base) ? { ...base, ...ours } : { ...ours };
}

/**
 * rootShapeOf —— 一个 JSON 文件的根是什么形状。
 *
 * 返回 `"array"`（根是数组）、`"object"`（根是对象）、`"empty"`（文件不在或空的）、
 * `"broken"`（在，但解析不了）、`"unreadable"`（读不了）。
 *
 * WorkBuddy 那几个客户端的 models.json **根可能是数组**（WorkBuddy 自己写的
 * 形状），也可能是对象（CodeBuddy Code 的 CLI 写的形状）—— 得先看一眼才知道
 * 该往哪种形状里写。
 */
export function rootShapeOf(file) {
  const r = readFileText(file);
  if (!r.ok) return "unreadable";
  if (!r.exists || !r.text.trim()) return "empty";
  const j = parseJsonc(r.text);
  if (!j.ok) return "broken";
  return Array.isArray(j.value) ? "array" : "object";
}
