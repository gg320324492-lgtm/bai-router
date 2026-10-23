// src/server/clients/formats-toml.mjs —— TOML 的最小读写器
//
// ## 为什么自己写
//
// 仓库零第三方依赖（不引 toml 解析器），而这一批客户端里有四个是 TOML：
// Kimi Code、jcode、StepCode、Reasonix Studio、Grok Build。
// 它们的配置形状是**已知**的（magpie 的 internal/agent/<name>.go 写着确切的键路径），
// 所以要的不是完整 TOML 实现，是「这些形状能读能写、读不懂就报错」。
//
// ## 纪律：读不懂就不写
//
// 解析失败一律返回 `{ ok:false, error, line }`，**绝不**返回「当成空配置」。
// 用户文件里有一段本模块读不懂的 TOML，若把它当空的再写回去，用户其余配置当场蒸发
// —— 这正是本仓库吃过大亏的地方（见 edit-json.mjs 的 parseJsonc）。
//
// ## 支持什么
//
//   · 段：`[table]`、`[table.sub]`、段头里带引号的键（`[models."bai/sn/x"]`）
//   · 数组的表：`[[providers]]`（Reasonix 的 provider 就是这么写的）
//   · 值：字符串（基本/字面/多行）、整数、浮点、布尔、数组、内联表、日期（当字符串）
//   · 注释：行尾的 `#` 与整行注释都保留（写的时候不碰它们）
//
// ## 不支持什么（写到了就报错，不猜）
//
//   · 多行字符串的**再编辑**（能读，读出来的值再写回去会变成单行）——只在用户没动过它时成立
//   · 表里同一个键写两遍（后写的覆盖先写的，与 TOML 规范一致）
//   · 段头之外的「表被拆成多段」以外的怪写法
//
// ## 写的时候保留什么
//
//   · 用户的注释、键顺序、段顺序、空行 —— 一律不碰
//   · 我们要写的键：**就地改**那一行（保留行尾注释与 `=` 两边的空格风格）；
//     文件里没有就**追加一段**（追加在文件末尾，TOML 允许任何顺序）
//   · 删一个键 = 删掉它那一行；段里删空了，**连段头一起删**
//
// ## 行尾
//
// 写盘统一 LF（仓库纪律）。用户文件里原有的 CRLF 会被归一成 LF —— 内容一个不少，
// 只是行尾统一了。

import { registerFormat } from "./base.mjs";
import { splitPathParts, splitPathRaw } from "./paths.mjs";

/* ------------------------------------------------------------------ *
 * 值
 * ------------------------------------------------------------------ */

/**
 * 一个 TOML 值。type 用来区分「字符串 123」与「数字 123」——
 * 备份/还原走的是 JS 值，还原时要写回**同样的种类**。
 */
function jsValue(v) {
  switch (v.type) {
    case "string": return v.value;
    case "number": return v.value;
    case "boolean": return v.value;
    case "datetime": return v.value;
    case "array": return v.items.map(jsValue);
    case "table": {
      const out = {};
      for (const f of v.fields) out[f.key] = jsValue(f.value);
      return out;
    }
    default: return null;
  }
}

/* ---------- 词法：跳过空白与注释 ---------- */

function skipInline(text, i) {
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  return i;
}

/** 跳到下一个非空白、非注释的字符（可以跨行）。 */
function skipAll(text, i) {
  for (;;) {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
    if (text[i] === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
    return i;
  }
}

/* ---------- 词法：字符串 ---------- */

function scanBasicString(text, i) {
  let j = i + 1;
  let out = "";
  while (j < text.length) {
    const c = text[j];
    if (c === '"') return { ok: true, value: { type: "string", value: out }, end: j + 1 };
    if (c === "\n") return { ok: false, error: "字符串没有闭合（行尾）", at: i };
    if (c === "\\") {
      const e = text[j + 1];
      const map = { '"': '"', "\\": "\\", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t" };
      if (e in map) { out += map[e]; j += 2; continue; }
      if (e === "u" || e === "U") {
        const len = e === "u" ? 4 : 8;
        const hex = text.slice(j + 2, j + 2 + len);
        if (hex.length !== len || !/^[0-9A-Fa-f]+$/.test(hex)) {
          return { ok: false, error: "字符串里的转义不完整", at: j };
        }
        out += String.fromCodePoint(parseInt(hex, 16));
        j += 2 + len;
        continue;
      }
      return { ok: false, error: "字符串里有不认识的转义", at: j };
    }
    out += c;
    j++;
  }
  return { ok: false, error: "字符串没有闭合", at: i };
}

function scanLiteralString(text, i) {
  let j = i + 1;
  let out = "";
  while (j < text.length) {
    const c = text[j];
    if (c === "'") return { ok: true, value: { type: "string", value: out }, end: j + 1 };
    if (c === "\n") return { ok: false, error: "字符串没有闭合（行尾）", at: i };
    out += c;
    j++;
  }
  return { ok: false, error: "字符串没有闭合", at: i };
}

/** 多行字符串（""" 与 '''）：只求「读得出」，写回时会被压成单行。 */
function scanMultilineString(text, i, delim) {
  const close = delim === '"""' ? '"""' : "'''";
  let j = i + 3;
  if (text[j] === "\n") j++;
  let out = "";
  for (;;) {
    if (j >= text.length) return { ok: false, error: "多行字符串没有闭合", at: i };
    if (text.startsWith(close, j)) {
      let v = out;
      if (delim === '"""') {
        v = v.replace(/\\\n\s*/g, "").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      return { ok: true, value: { type: "string", value: v }, end: j + 3 };
    }
    out += text[j];
    j++;
  }
}

/* ---------- 词法：键 ---------- */

/** 读一个键：裸键 / "双引号" / '单引号'。 */
function scanKey(text, i) {
  if (text[i] === '"') {
    const r = scanBasicString(text, i);
    if (!r.ok) return { ok: false, error: r.error, at: r.at };
    return { ok: true, key: r.value.value, start: i, end: r.end };
  }
  if (text[i] === "'") {
    const r = scanLiteralString(text, i);
    if (!r.ok) return { ok: false, error: r.error, at: r.at };
    return { ok: true, key: r.value.value, start: i, end: r.end };
  }
  const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
  if (!m) return { ok: false, error: "这里不是一个键", at: i };
  return { ok: true, key: m[0], start: i, end: i + m[0].length };
}

/* ---------- 词法：值 ---------- */

function scanValue(text, i) {
  const c = text[i];
  if (c === '"') {
    if (text.startsWith('"""', i)) return scanMultilineString(text, i, '"""');
    return scanBasicString(text, i);
  }
  if (c === "'") {
    if (text.startsWith("'''", i)) return scanMultilineString(text, i, "'''");
    return scanLiteralString(text, i);
  }
  if (c === "[") return scanArray(text, i);
  if (c === "{") return scanInlineTable(text, i);
  const rest = text.slice(i);
  let m = /^(true|false)(?![A-Za-z0-9_-])/.exec(rest);
  if (m) return { ok: true, value: { type: "boolean", value: m[1] === "true" }, end: i + m[1].length };
  /* ⚠ **日期要先于数字认** —— 数字那条正则会先吃掉 `1979` 里的前四位，
     剩下 `-05-27` 就成了「值后面还有别的东西」，整份文件被判读不懂。
     用户配置里一个日期就把接线堵死，是很常见的事。 */
  m = /^\d{4}-\d{2}-\d{2}(?:[Tt ][^\s,}\]]*)?/.exec(rest);
  if (m) return { ok: true, value: { type: "datetime", value: m[0] }, end: i + m[0].length };
  m = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?/.exec(rest);
  if (m) return { ok: true, value: { type: "datetime", value: m[0] }, end: i + m[0].length };
  m = /^[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(rest);
  if (m && m[0]) {
    const num = Number(m[0].replace(/_/g, ""));
    if (Number.isFinite(num)) return { ok: true, value: { type: "number", value: num }, end: i + m[0].length };
  }
  return { ok: false, error: "这里不是一个能认出来的值", at: i };
}

function scanArray(text, i) {
  const items = [];
  let j = skipAll(text, i + 1);
  for (;;) {
    if (j >= text.length) return { ok: false, error: "数组没有闭合", at: i };
    if (text[j] === "]") return { ok: true, value: { type: "array", items }, end: j + 1 };
    const r = scanValue(text, j);
    if (!r.ok) return r;
    items.push(r.value);
    j = skipAll(text, r.end);
    if (text[j] === ",") { j = skipAll(text, j + 1); continue; }
    if (text[j] === "]") return { ok: true, value: { type: "array", items }, end: j + 1 };
    return { ok: false, error: "数组里少了逗号", at: j };
  }
}

function scanInlineTable(text, i) {
  const fields = [];
  let j = skipAll(text, i + 1);
  for (;;) {
    if (j >= text.length) return { ok: false, error: "内联表没有闭合", at: i };
    if (text[j] === "}") return { ok: true, value: { type: "table", fields }, end: j + 1 };
    const k = scanKey(text, j);
    if (!k.ok) return { ok: false, error: "内联表里读不懂键", at: k.at };
    j = skipAll(text, k.end);
    if (text[j] !== "=") return { ok: false, error: "内联表里键后面没有等号", at: j };
    j = skipAll(text, j + 1);
    const r = scanValue(text, j);
    if (!r.ok) return r;
    fields.push({ key: k.key, value: r.value });
    j = skipAll(text, r.end);
    if (text[j] === ",") { j = skipAll(text, j + 1); continue; }
    if (text[j] === "}") return { ok: true, value: { type: "table", fields }, end: j + 1 };
    return { ok: false, error: "内联表里少了逗号", at: j };
  }
}

/* ------------------------------------------------------------------ *
 * 文档
 * ------------------------------------------------------------------ */

/**
 * 一个段。
 *   kind    —— root（第一段头之前）/ table（[a.b]）/ array（[[a.b]]）
 *   path    —— 段路径（键已解引号）
 *   entries —— 本段直接定义的键
 */
function newBlock(kind, path, header, headerLine, headerStart) {
  return {
    kind, path, header, headerLine, headerStart,
    headerEnd: headerStart,
    entries: [],
    bodyStart: 0,
  };
}

/** 行号表：字符位置 → 行号（1 基）。 */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** 段头里的路径：`[models."bai/sn/x"]` → ["models", "bai/sn/x"]。 */
function parseHeaderPath(s, line) {
  const segs = [];
  let i = 0;
  for (;;) {
    i = skipInline(s, i);
    const k = scanKey(s, i);
    if (!k.ok) return { ok: false, error: "段头里的键读不懂", line };
    segs.push(k.key);
    i = skipInline(s, k.end);
    if (i >= s.length) break;
    if (s[i] === ".") { i++; continue; }
    return { ok: false, error: "段头里有看不懂的东西", line };
  }
  if (!segs.length) return { ok: false, error: "段头是空的", line };
  return { ok: true, path: segs };
}

/**
 * parseDoc —— 把一份 TOML 文本读成段与键。
 *
 * 失败 → `{ ok:false, error, line }`（**绝不**返回空文档）。
 */
function parseDoc(text) {
  const starts = lineIndex(text);
  const blocks = [];
  const root = newBlock("root", [], "", 0, 0);
  blocks.push(root);
  let cur = root;
  let i = 0;
  while (i < text.length) {
    /* 跳过空白与注释 */
    for (;;) {
      const c = text[i];
      if (c === "\n" || c === "\r" || c === " " || c === "\t") { i++; continue; }
      if (c === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
      break;
    }
    if (i >= text.length) break;
    if (text[i] === "[") {
      const isArray = text.startsWith("[[", i);
      const closeTok = isArray ? "]]" : "]";
      const end = text.indexOf(closeTok, i + (isArray ? 2 : 1));
      const line = lineOf(starts, i);
      if (end < 0) return { ok: false, error: "段头没有闭合", line };
      const head = text.slice(i, end + closeTok.length);
      const inner = text.slice(i + (isArray ? 2 : 1), end);
      const p = parseHeaderPath(inner, line);
      if (!p.ok) return p;
      cur = newBlock(isArray ? "array" : "table", p.path, head, line, i);
      cur.headerEnd = end + closeTok.length;
      blocks.push(cur);
      i = cur.headerEnd;
      /* 段头后面只允许空白与注释 —— `[a] xyz = 1` 不是合法的 TOML，
         放过去就等于把那段字归到了 [a] 表里（读出来是另一回事）。 */
      let j = i;
      while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
      if (text[j] === "#") { while (j < text.length && text[j] !== "\n") j++; }
      else if (text[j] === "\r") j++;
      if (j < text.length && text[j] !== "\n") {
        return { ok: false, error: "段头后面还有别的东西", line: lineOf(starts, i) };
      }
      i = j < text.length ? j + 1 : j;
      continue;
    }
    /* key = value */
    const k = scanKey(text, i);
    if (!k.ok) return { ok: false, error: k.error, line: lineOf(starts, k.at) };
    let j = skipInline(text, k.end);
    if (text[j] !== "=") return { ok: false, error: "键后面没有等号", line: lineOf(starts, j) };
    j = skipInline(text, j + 1);
    const r = scanValue(text, j);
    if (!r.ok) return { ok: false, error: r.error, line: lineOf(starts, r.at) };
    cur.entries.push({
      key: k.key,
      keyStart: k.start,
      keyEnd: k.end,
      valueStart: j,
      valueEnd: r.end,
      value: r.value,
      line: lineOf(starts, k.start),
      valueEndLine: lineOf(starts, Math.max(k.start, r.end - 1)),
    });
    /* 值后面只允许空白与注释 */
    let t = r.end;
    while (t < text.length && (text[t] === " " || text[t] === "\t")) t++;
    if (text[t] === "#") { while (t < text.length && text[t] !== "\n") t++; }
    else if (text[t] === "\r") t++;
    if (t < text.length && text[t] !== "\n") {
      return { ok: false, error: "值后面还有别的东西", line: lineOf(starts, t) };
    }
    i = t;
  }
  /* 段的范围：到下一个段头之前 */
  for (let k = 0; k < blocks.length; k++) {
    blocks[k].bodyStart = blocks[k].headerLine + 1;
  }
  return { ok: true, blocks, starts };
}

/* ------------------------------------------------------------------ *
 * 树
 * ------------------------------------------------------------------ */

/**
 * 把段合成一棵树。
 *   map   —— { type:"map", entries: Map<string, node>, blocks: [block] }
 *   array —— { type:"array", items: [map], blocks: [block] }
 *   标量  —— { type:"scalar", value, entry }
 */
function buildTree(blocks) {
  const root = { type: "map", entries: new Map(), blocks: [] };
  for (const b of blocks) {
    if (b.kind === "root") { mergeBlock(root, b); root.blocks.push(b); continue; }
    const parent = ensureMap(root, b.path.slice(0, -1));
    if (!parent) {
      /* 上级不是表（`a = 1` 之后又来 `[a.b]`）—— 这是**冲突**，如实报，
         不许在这里崩掉（崩了就是 500，用户只看到一句「Cannot read properties」）。 */
      return { ok: false, error: `段 [${b.path.join(".")}] 的上级不是一个表` };
    }
    const last = b.path[b.path.length - 1];
    if (b.kind === "array") {
      let arr = parent.entries.get(last);
      if (!arr) { arr = { type: "array", items: [], blocks: [] }; parent.entries.set(last, arr); }
      if (arr.type !== "array") return { ok: false, error: `段 [[${b.path.join(".")}]] 与已有的同名表冲突` };
      const item = { type: "map", entries: new Map(), blocks: [] };
      mergeBlock(item, b);
      item.blocks.push(b);
      arr.items.push(item);
      arr.blocks.push(b);
    } else {
      let m = parent.entries.get(last);
      if (!m) { m = { type: "map", entries: new Map(), blocks: [] }; parent.entries.set(last, m); }
      if (m.type !== "map") return { ok: false, error: `段 [${b.path.join(".")}] 与已有的同名数组冲突` };
      mergeBlock(m, b);
      m.blocks.push(b);
    }
  }
  return { ok: true, root };
}

function mergeBlock(mapNode, block) {
  for (const e of block.entries) {
    mapNode.entries.set(e.key, { type: "scalar", value: e.value, entry: e, block });
  }
}

/** 沿路径走到一张表；缺的中间表**就地补出来**（TOML 里 [a.b] 隐含 a 是表）。 */
function ensureMap(root, path) {
  let node = root;
  for (const seg of path) {
    if (node.type !== "map") return null;
    let child = node.entries.get(seg);
    if (!child) {
      child = { type: "map", entries: new Map(), blocks: [] };
      node.entries.set(seg, child);
    }
    if (child.type !== "map") return null;
    node = child;
  }
  return node;
}

/**
 * 路径里的「选择器」：`providers[name=bai]`。
 *
 * 数组的表（[[providers]]）的元素没有键名，只能靠里面某个键来认。
 * Reasonix 的 provider 就是这么认的（magpie 的 SetTOMLArrayTable(path, "providers", "name", …)）。
 */
function parseSelector(seg) {
  const m = /^([^\[\]]+)\[([A-Za-z0-9_-]+)=(.*)\]$/.exec(String(seg || ""));
  if (!m) return null;
  let value = m[3];
  if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
    value = value.slice(1, -1);
  }
  return { base: m[1], key: m[2], value };
}

/**
 * 沿路径找节点。
 *   → { ok:true, node }         找到了
 *   → { ok:true, missing:true, at } 路径上有一段不存在（at 是断掉的那一段的下标）
 *   → { ok:false, error }       路径本身讲不通
 *
 * `walked` 一路记下**具体路径**（不含选择器）——写的时候要知道段头该长什么样。
 */
function resolvePath(root, segments) {
  let node = root;
  const walked = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (node.type !== "map") return { ok: false, error: "路径的这一段不是一个表" };
    const sel = parseSelector(seg);
    const name = sel ? sel.base : seg;
    const child = node.entries.get(name);
    if (!child) return { ok: true, missing: true, at: i, walked };
    if (!sel) { node = child; walked.push(name); continue; }
    if (child.type !== "array") return { ok: false, error: `「${name}」不是数组的表，选不了元素` };
    const item = child.items.find((it) => {
      const e = it.entries.get(sel.key);
      return e && e.value && e.value.type === "string" && e.value.value === sel.value;
    });
    if (!item) return { ok: true, missing: true, at: i, walked: walked.concat([name]) };
    node = item;
    walked.push(name);
  }
  return { ok: true, node, walked };
}

/* ---------- 路径段 ---------- */

/** 一个路径段能不能当裸键写（TOML 的裸键只允许字母数字下划线连字符）。 */
function isBarePathSeg(k) {
  return /^[A-Za-z0-9_-]+$/.test(String(k));
}

/** 路径段 → 路径文本（必要时加引号：键里有斜杠或点时必须加）。 */
function quotePathSeg(k) {
  return '"' + String(k).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** 段数组 → 路径文本。 */
function joinPath(parts) {
  return parts
    .map((x) => (x.quoted || !isBarePathSeg(x.key) ? quotePathSeg(x.key) : x.key))
    .join(".");
}

/** 一个值是不是「一张表」（不是数组、不是 null）。 */
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 两个值一样吗（深比较；TOML 的 5 与 "5" 不一样）。 */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameValue(x, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function quoteTomlKey(k) {
  if (/^[A-Za-z0-9_-]+$/.test(k)) return k;
  return '"' + String(k).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function quoteTomlString(s) {
  let out = '"';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

/** 一个值写成 TOML 的样子（单行）。 */
function renderTomlValue(v) {
  if (v === null || v === undefined) return '""';
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  if (typeof v === "string") return quoteTomlString(v);
  if (Array.isArray(v)) {
    const items = v.map((x) => renderTomlValue(x));
    /* 全是标量 → 一行；里有表 → 一行一个（TOML 的数组可以跨行） */
    if (items.every((x) => !x.includes("{"))) return "[" + items.join(", ") + "]";
    return "[\n" + items.map((x) => "  " + x).join(",\n") + ",\n]";
  }
  if (typeof v === "object") {
    const parts = Object.entries(v).map(([k, x]) => `${quoteTomlKey(k)} = ${renderTomlValue(x)}`);
    return "{ " + parts.join(", ") + " }";
  }
  return '""';
}

/** 段头：`[a.b]`；数组的表：`[[a.b]]`。 */
function renderHeader(path, isArray) {
  const body = path.map(quoteTomlKey).join(".");
  return isArray ? `[[${body}]]` : `[${body}]`;
}

/* ------------------------------------------------------------------ *
 * 文本工具
 * ------------------------------------------------------------------ */

/** 位置 pos 所在行的行尾（下一个 "\n" 的下标，或文末）。 */
function lineEndAt(text, pos) {
  const n = text.indexOf("\n", pos);
  return n < 0 ? text.length : n;
}

/* ------------------------------------------------------------------ *
 * 公开：getPath / setPath / delPath
 * ------------------------------------------------------------------ */

/** getPath —— 读一个点分路径的值。 */
export function getPath(text, p) {
  let segments;
  try {
    segments = splitPathParts(p).map((x) => x.key);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!segments.length || !segments[0]) return { ok: true, value: undefined, found: false };
  const doc = parseDoc(String(text || ""));
  if (!doc.ok) return { ok: false, error: doc.error, line: doc.line };
  const tree = buildTree(doc.blocks);
  if (!tree.ok) return { ok: false, error: tree.error };
  const r = resolvePath(tree.root, segments);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.missing) return { ok: true, value: undefined, found: false };
  const node = r.node;
  if (node.type === "scalar") return { ok: true, value: jsValue(node.value), found: true };
  if (node.type === "map") {
    const out = {};
    for (const [k, v] of node.entries) {
      out[k] = v.type === "scalar" ? jsValue(v.value) : mapNodeToJs(v);
    }
    return { ok: true, value: out, found: true };
  }
  return { ok: true, value: node.items.map(mapNodeToJs), found: true };
}

function mapNodeToJs(node) {
  if (node.type === "scalar") return jsValue(node.value);
  if (node.type === "map") {
    const out = {};
    for (const [k, v] of node.entries) out[k] = mapNodeToJs(v);
    return out;
  }
  return node.items.map(mapNodeToJs);
}

/**
 * setPath —— 写一个点分路径的值。
 *
 * 就地改那一行（保留行尾注释）；文件里没有这一段就**追加一段**在文件末尾。
 */
export function setPath(text, p, value) {
  let parts;
  try {
    parts = splitPathParts(p);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  const segments = parts.map((x) => x.key);
  if (!segments.length || !segments[0]) return { ok: false, error: "键路径是空的" };
  const src = String(text || "");
  const doc = parseDoc(src);
  if (!doc.ok) return { ok: false, error: doc.error, line: doc.line };
  const tree = buildTree(doc.blocks);
  if (!tree.ok) return { ok: false, error: tree.error };

  const lastSeg = segments[segments.length - 1];
  const parentSegs = segments.slice(0, -1);

  /* 父级（最后一段之外的那几段，可能带选择器） */
  let parent = tree.root;
  let parentPath = [];
  if (parentSegs.length) {
    const pr = resolvePath(tree.root, parentSegs);
    if (!pr.ok) return { ok: false, error: pr.error };
    if (pr.missing) return createChain(src, doc, parentSegs, pr, lastSeg, value);
    parent = pr.node;
    parentPath = pr.walked;
  }
  if (parent.type !== "map") return { ok: false, error: "这一段路径的上级不是一个表" };

  /* ① 普通键 */
  const existing = parent.entries.get(lastSeg);
  if (existing && existing.type === "scalar") {
    const e = existing.entry;
    /* ⚠ **值一样 ⇒ 一个字都不动**（用户原来的写法留着：引号风格、注释全在） */
    if (sameValue(jsValue(e.value), value)) return { ok: true, text: src, changed: false };
    const old = src.slice(e.valueStart, e.valueEnd);
    const out = src.slice(0, e.valueStart) + renderTomlValueLike(old, value) + src.slice(e.valueEnd);
    return finish(out, src);
  }
  /* ② 值是一张表 ⇒ **展开成它自己的段**（[父.子] + 段里的键）。
     ⚠⚠ 千万别写成 `[父]` + 一行内联表 ——
        父表若已被别的段**隐式定义**过（`[model_providers.other]` 就隐式定义了
        `model_providers`），再写一遍 `[model_providers]` 就是「同一张表定义两次」，
        解析器直接报错 ⇒ 用户整个 config.toml 读不了（Codex 的 MCP 配置一起废）。
        展开成子段就没这回事：点分路径与 TOML 段一一对应，父表只被隐式定义一次。 */
  if (isPlainObject(value)) {
    let text = src;
    if (existing && existing.type === "map") {
      /* 目标已经是张表 ⇒ 同步：把新对象里没有的旧键删掉（否则还原时多出我们的键） */
      for (const k of [...existing.entries.keys()]) {
        if (Object.prototype.hasOwnProperty.call(value, k)) continue;
        const childParts = parts.slice(0, -1).concat([{ key: k, quoted: !isBarePathSeg(k) }]);
        const d = delPath(text, joinPath(childParts));
        if (!d.ok) return d;
        text = d.text;
      }
    }
    return setObjectAt(text, doc, segments, parts, value);
  }
  if (existing) {
    return { ok: false, error: "这一段路径指的是一整段表或数组，不能整体替换（请逐键写）" };
  }
  /* 没有这个键：找它该在哪个段里 */
  const blocks = parent.blocks || [];
  if (blocks.length) {
    const block = blocks[blocks.length - 1];
    return setKeyInBlock(src, doc, block, lastSeg, value);
  }
  /* 父级是隐含出来的（文件里根本没有 [这一段]）→ 建一段 */
  const head = renderHeader(parentPath, false);
  const line = `${head}\n${quoteTomlKey(lastSeg)} = ${renderTomlValue(value)}\n`;
  return finish(src + (src.endsWith("\n") || src === "" ? "" : "\n") + line, src);
}

/**
 * setObjectAt —— 把一张表写进某个路径：**逐键写**，每一层自己成段。
 *
 *   model_providers.bai = { name = "B.AI", wire_api = "responses" }
 *   ⇒
 *   [model_providers.bai]
 *   name = "B.AI"
 *   wire_api = "responses"
 *
 * 嵌套的对象再往下展开一层（`[model_providers.bai.options]`），
 * 数组写成行内值（`models = [{ … }]` —— 行内表不建段，不会撞上「表定义两次」）。
 */
function setObjectAt(src, doc, segments, parts, value) {
  let text = src;
  for (const [k, v] of Object.entries(value)) {
    const childParts = parts.concat([{ key: k, quoted: !isBarePathSeg(k) }]);
    let r;
    if (isPlainObject(v)) {
      r = setObjectAt(text, doc, segments.concat([k]), childParts, v);
    } else {
      r = setPath(text, joinPath(childParts), v);
    }
    if (!r.ok) return r;
    text = r.text;
  }
  return { ok: true, text, changed: text !== src };
}

/**
 * createChain —— 路径上有几段还不存在，把它们**建出来**再写最后一个键。
 *
 * 两种形状：
 *   · 普通段   `providers.bai.base_url` → 建一段 `[providers.bai]`
 *   · 选择器段 `providers[name=bai].kind` → 建一段 `[[providers]]`，
 *     并把判别键（name = "bai"）一并写上 —— 否则那个元素认不出来
 */
function createChain(src, doc, parentSegs, pr, lastSeg, value) {
  const rest = parentSegs.slice(pr.at);
  const segs = [];
  let disc = null;
  let lastIsArray = false;
  let selBase = null;
  for (let i = 0; i < rest.length; i++) {
    const sel = parseSelector(rest[i]);
    if (sel) {
      if (i !== rest.length - 1) {
        return { ok: false, error: "数组的表后面再接普通段，这一层写不了" };
      }
      selBase = sel.base;
      disc = { key: sel.key, value: sel.value };
      lastIsArray = true;
      continue;
    }
    segs.push(rest[i]);
  }
  /* 选择器那一段：段头就是那个数组本身（[[providers]]）。
     数组已经在文件里 ⇒ 追加一个新元素；不在 ⇒ 第一次建它。 */
  const headPath = selBase
    ? (pr.walked.length && pr.walked[pr.walked.length - 1] === selBase ? pr.walked : pr.walked.concat([selBase]))
    : pr.walked.concat(segs);
  let body = "";
  /* 判别键就是我们要写的那个键时，别写两遍 */
  if (disc && disc.key !== lastSeg) body += `${quoteTomlKey(disc.key)} = ${quoteTomlString(disc.value)}\n`;
  body += `${quoteTomlKey(lastSeg)} = ${renderTomlValue(value)}\n`;
  const head = renderHeader(headPath, lastIsArray);
  const tail = `${head}\n${body}`;
  return finish(src + (src.endsWith("\n") || src === "" ? "" : "\n") + tail, src);
}

/**
 * 在一个段里写一个键（就地加行，或改那一行）。
 *
 * ⚠ **根段的键必须写在第一个段头之前** —— TOML 里段头之后的键属于那个段，
 *   `default_model = "x"` 写在 `[providers.bai]` 后面就成了 providers.bai 的键。
 */
function setKeyInBlock(src, doc, block, key, value) {
  const hit = block.entries.find((e) => e.key === key);
  if (hit) {
    /* ⚠ 值一样 ⇒ 一个字都不动（用户原来的写法留着） */
    if (sameValue(jsValue(hit.value), value)) return { ok: true, text: src, changed: false };
    const old = src.slice(hit.valueStart, hit.valueEnd);
    const out = src.slice(0, hit.valueStart) + renderTomlValueLike(old, value) + src.slice(hit.valueEnd);
    return finish(out, src);
  }
  /* 这个段里没有这个键 → 加一行 */
  const line = `${quoteTomlKey(key)} = ${renderTomlValue(value)}\n`;
  let at;
  if (block.kind === "root") {
    if (block.entries.length) {
      const last = block.entries[block.entries.length - 1];
      at = lineEndAt(src, last.valueEnd) + 1;
    } else {
      /* 根段还没有键 → 写在第一个段头之前（文件头的注释留在上面） */
      const first = doc.blocks.find((b) => b.kind !== "root");
      at = first ? first.headerStart : src.length;
    }
  } else if (block.entries.length) {
    const last = block.entries[block.entries.length - 1];
    at = lineEndAt(src, last.valueEnd) + 1;
  } else {
    /* 空段 → 加在段头后面 */
    at = lineEndAt(src, block.headerEnd) + 1;
  }
  const head = src.slice(0, at);
  /* ⚠ 上一行**没有换行**（用户的文件末尾没换行）时得补一个 ——
     不补的话新键会粘在上一行后面：`a = 1b = 2`。 */
  const glue = head === "" || head.endsWith("\n") ? "" : "\n";
  const out = head + glue + line + src.slice(at);
  return finish(out, src);
}

/** delPath —— 删一个点分路径；段里删空了，段头一起删。 */
export function delPath(text, p) {
  let segments;
  try {
    segments = splitPathParts(p).map((x) => x.key);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!segments.length || !segments[0]) return { ok: true, text, changed: false };
  const src = String(text || "");
  if (src.trim() === "") return { ok: true, text: src, changed: false };
  const doc = parseDoc(src);
  if (!doc.ok) return { ok: false, error: doc.error, line: doc.line };
  const tree = buildTree(doc.blocks);
  if (!tree.ok) return { ok: false, error: tree.error };
  const r = resolvePath(tree.root, segments);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.missing) return { ok: true, text: src, changed: false };

  const node = r.node;
  if (node.type === "scalar") {
    const e = node.entry;
    const from = lineStartAt(src, e.keyStart);
    const to = lineEndAt(src, e.valueEnd);
    let out = src.slice(0, from) + src.slice(Math.min(to + 1, src.length));
    /* 段里删空了 → 连段头一起删（根段没有头，根段的键删完就完了） */
    const blk = node.block;
    if (blk && blk.kind !== "root" && !blk.entries.some((x) => x !== e)) {
      out = dropBlockLines(out, blk, e);
    }
    return finish(out, src);
  }
  /* 整段（表或数组的表）→ 连它下面的段一起删 */
  const base = r.walked || [];
  const doomed = [];
  const seen = new Set();
  for (const b of node.blocks || []) {
    if (!seen.has(b)) { seen.add(b); doomed.push(b); }
  }
  for (const b of doc.blocks) {
    if (b.kind === "root" || seen.has(b)) continue;
    if (b.path.length <= base.length) continue;
    let under = true;
    for (let i = 0; i < base.length; i++) {
      if (b.path[i] !== base[i]) { under = false; break; }
    }
    if (under) { seen.add(b); doomed.push(b); }
  }
  if (!doomed.length) return { ok: true, text: src, changed: false };
  let out = src;
  /* 从后往前删，免得行号偏移 */
  for (const b of doomed.slice().reverse()) out = dropBlockLines(out, b);
  return finish(out, src);
}

/**
 * 删掉一个段（段头 + 它自己的那些行）。
 *
 * ⚠ **只删这个段自己的行** —— 段的「范围」不是「到下一个段头之前」：
 *   下一个段头紧跟着的时候（这一段是空的），把「下一个段头之前」当成自己的
 *   行，就会把**下一个段的头也删掉**（实测：删空 `[model."…"]` 之后，
 *   `[features]` 的头没了，`campaigns = false` 留在了上一个段里）。
 *   所以这里按**这一段自己的键**算范围。
 *
 * ⚠ 段**外面**的行一个都不碰 —— 哪怕那是空行或注释：
 *   用户的文件里那些空行也是用户的东西（断开时得原样还原）。
 */
function dropBlockLines(text, block, exceptEntry) {
  const lines = text.split("\n");
  const kill = new Set();
  const rest = block.entries.filter((x) => x !== exceptEntry);
  const end = rest.length ? rest[rest.length - 1].valueEndLine : block.headerLine;
  for (let ln = block.headerLine; ln <= end; ln++) kill.add(ln);
  return lines.filter((_, idx) => !kill.has(idx + 1)).join("\n");
}

function lineStartAt(text, pos) {
  const n = text.lastIndexOf("\n", Math.max(0, pos - 1));
  return n < 0 ? 0 : n + 1;
}

/**
 * finish —— 收尾：**行尾与末尾换行照原文件的样子**。
 *
 * ⚠ 断开时要能**逐字节**还原用户那份文件 —— 所以 CRLF 的文件还原回去还是
 *   CRLF，原本没有末尾换行的还原回去还是没有。
 *   （edit-json.mjs 的 keepCRLF 是同一个规矩。）
 *   ⚠ 顺带把**整份**文件统一成一种行尾：我们新插进去的行是 LF，
 *     原文件若是 CRLF，不统一就会变成「一半 CRLF 一半 LF」的怪文件。
 */
function finish(newText, origText) {
  const src = origText == null ? "" : String(origText);
  const norm = String(newText).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const eol = eolOf(src);
  let out = eol === "\r\n" ? norm.replace(/\n/g, "\r\n") : norm;
  const hadFinal = src === "" || /\n$/.test(src);
  if (hadFinal) {
    if (out !== "" && !out.endsWith(eol)) out += eol;
  } else if (out.endsWith(eol)) {
    out = out.slice(0, out.length - eol.length);
  }
  return { ok: true, text: out, changed: src === undefined ? true : out !== src };
}

/** eolOf —— 这个文件用哪种行尾（全 CRLF ⇒ CRLF，其余 ⇒ LF）。 */
function eolOf(text) {
  const s = String(text || "");
  const nl = (s.match(/\n/g) || []).length;
  const crlf = (s.match(/\r\n/g) || []).length;
  return nl > 0 && crlf === nl ? "\r\n" : "\n";
}

/**
 * renderTomlValueLike —— 按**原来那个值**的写法写新的值。
 *
 * 备份里存的是**解析后的值**（不是原文），所以还原时无从知道用户当初写的是
 * `'x'` 还是 `"x"`。若我们写的时候沿用用户原来的引号风格（这里就是），
 * 还原时也沿用同一个风格 —— 断开以后文件才**一个字节都不差**。
 */
function renderTomlValueLike(oldText, value) {
  const old = String(oldText || "");
  if (typeof value === "string") {
    if (old.startsWith("'") && !value.includes("'")) return "'" + value + "'";
    if (old.startsWith('"')) return quoteTomlString(value);
  }
  return renderTomlValue(value);
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

registerFormat("toml", {
  getPath, setPath, delPath,
  /* ⚠ **分路径器要用格式自己的**（底座算父路径时用它）：键里可以带点 ——
     有的客户端把模型 id 当表名（models."bai/wb/glm-5.2"），用 p.split(".")
     会把引号段切碎 ⇒ 算出来的父路径不合法 ⇒ 还原时抛错。
     这里返回**保留引号的段**：parts.slice(0,k).join(".") 才拼得回原路径。 */
  splitPath: splitPathRaw,
});

export { getPath as tomlGetPath, setPath as tomlSetPath, delPath as tomlDelPath };
