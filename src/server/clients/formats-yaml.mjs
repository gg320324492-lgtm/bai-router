// src/server/clients/formats-yaml.mjs —— YAML 的最小读写器
//
// ## 为什么自己写
//
// 仓库零第三方依赖（不引 yaml 解析器），而这一批客户端里有四个是 YAML：
// Goose、MiniMax Code、Hermes Agent、Mister Morph、omp（两个文件都是）。
//
// ## 纪律：解析失败必须报错，不许猜
//
// YAML 缩进敏感 —— 猜错了写回去，用户文件当场变形。所以：
//   · 读不出来 ⇒ `{ ok:false, error, line }`，**绝不**当空配置
//   · 只支持**已知形状**（客户端配置里那些），遇到读不懂的结构就报错
//
// ## 支持什么
//
//   · 嵌套映射（缩进）
//   · 标量：字符串（单/双引号）、数字、布尔、空
//   · 列表：块序列（`- item`）与行内（`[a, b]`）
//   · 行内映射（`{a: 1}`）
//   · 注释（整行与行尾）、空行
//   · 块标量（`|` 与 `>`）——能读，写回时压成一行
//
// ## 不支持什么
//
//   · 锚点与别名（`&x` / `*x`）、标签（`!!str`）、多文档（`---` 分隔）——读到就报错
//   · 复杂键（`? key`）——报错
//   · 制表符缩进（YAML 本身就不允许）——报错
//
// ## 写的时候保留什么
//
//   · 用户的注释、键顺序、缩进风格 —— 一律不碰
//   · 我们要写的键：**就地改**那一行（行尾注释与 `=`/`:` 两边的空格都留着）
//   · 文件里没有 → **追加**到末尾（YAML 的顶层键在文件哪个位置都算数）
//
// ## 行尾
//
// 写盘统一 LF（仓库纪律）。

import { registerFormat } from "./base.mjs";
import { splitPathParts, splitPathRaw } from "./paths.mjs";

/* ------------------------------------------------------------------ *
 * 行
 * ------------------------------------------------------------------ */

/** 把文本拆成行，并记下每行的缩进与「是不是空/注释」。 */
function toLines(text) {
  /* 空文件 ⇒ **没有行**（不是「有一行空的」）—— 否则新建的文件第一行是空的 */
  if (String(text || "") === "") return [];
  return text.split("\n").map((raw) => {
    const body = raw.replace(/\r$/, "");
    const t = body.trim();
    const blank = t === "";
    const comment = !blank && t.startsWith("#");
    let indent = 0;
    if (!blank && !comment) {
      while (indent < body.length && body[indent] === " ") indent++;
      if (body[indent] === "\t") return { raw, text: body, indent: -1, blank: false, comment: false, tab: true };
    }
    return { raw, text: body, indent, blank, comment, tab: false };
  });
}

function nextContent(lines, i) {
  while (i < lines.length && (lines[i].blank || lines[i].comment)) i++;
  return i;
}

/* ------------------------------------------------------------------ *
 * 标量
 * ------------------------------------------------------------------ */

const TRUE_WORDS = new Set(["true", "True", "TRUE"]);
const FALSE_WORDS = new Set(["false", "False", "FALSE"]);
const NULL_WORDS = new Set(["null", "Null", "NULL", "~"]);

/** 纯量文本 → JS 值。 */
function plainValue(raw) {
  const s = String(raw);
  if (s === "") return null;
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  if (NULL_WORDS.has(s)) return null;
  if (/^[+-]?\d+$/.test(s)) return Number(s);
  if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(s)) return Number(s);
  return s;
}

/** 注释从哪儿开始（`#` 前面是空白或行首才算）。 */
function commentAt(t) {
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "#" && (i === 0 || t[i - 1] === " " || t[i - 1] === "\t")) return i;
  }
  return -1;
}

function parseQuoted(t, i, lineNo) {
  const q = t[i];
  let j = i + 1;
  let out = "";
  for (;;) {
    if (j >= t.length) return { error: { error: "引号没闭合", line: lineNo } };
    const c = t[j];
    if (q === '"' && c === "\\") {
      const e = t[j + 1];
      const map = { '"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t" };
      if (e in map) { out += map[e]; j += 2; continue; }
      if (e === "u") {
        const hex = t.slice(j + 2, j + 6);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return { error: { error: "\\u 转义不完整", line: lineNo } };
        out += String.fromCharCode(parseInt(hex, 16));
        j += 6;
        continue;
      }
      return { error: { error: "不认识的转义", line: lineNo } };
    }
    if (c === q) {
      if (q === "'" && t[j + 1] === "'") { out += "'"; j += 2; continue; }
      return { value: out, end: j + 1 };
    }
    out += c;
    j++;
  }
}

/** 行内集合（`[a, b]` / `{a: 1}`）——递归读。 */
function parseFlow(t, i, lineNo) {
  const c = t[i];
  if (c === '"' || c === "'") {
    const r = parseQuoted(t, i, lineNo);
    if (r.error) return r;
    return { value: r.value, end: r.end };
  }
  if (c === "[") {
    const items = [];
    let j = i + 1;
    for (;;) {
      while (j < t.length && /\s/.test(t[j])) j++;
      if (j >= t.length) return { error: { error: "行内数组没闭合", line: lineNo } };
      if (t[j] === "]") return { value: items, end: j + 1 };
      const r = parseFlow(t, j, lineNo);
      if (r.error) return r;
      items.push(r.value);
      j = r.end;
      while (j < t.length && /\s/.test(t[j])) j++;
      if (t[j] === ",") { j++; continue; }
      if (t[j] === "]") return { value: items, end: j + 1 };
      return { error: { error: "行内数组里少了逗号", line: lineNo } };
    }
  }
  if (c === "{") {
    const obj = {};
    let j = i + 1;
    for (;;) {
      while (j < t.length && /\s/.test(t[j])) j++;
      if (j >= t.length) return { error: { error: "行内映射没闭合", line: lineNo } };
      if (t[j] === "}") return { value: obj, end: j + 1 };
      /* 键：读到冒号为止（引号里的键也算 —— 引号里可能有冒号） */
      let kEnd = j;
      if (t[kEnd] === '"' || t[kEnd] === "'") {
        const q = t[kEnd];
        let p = kEnd + 1;
        while (p < t.length) {
          if (q === '"' && t[p] === "\\") { p += 2; continue; }
          if (t[p] === q) { if (q === "'" && t[p + 1] === "'") { p += 2; continue; } break; }
          p++;
        }
        if (p >= t.length) return { error: { error: "行内映射的键没闭合", line: lineNo } };
        kEnd = p + 1;
      } else {
        while (kEnd < t.length && t[kEnd] !== ":" && t[kEnd] !== "," && t[kEnd] !== "}") kEnd++;
      }
      if (t[kEnd] !== ":") return { error: { error: "行内映射里键后面没有冒号", line: lineNo } };
      const key = t.slice(j, kEnd).trim().replace(/^["']/, "").replace(/["']$/, "");
      let m = kEnd + 1;
      while (m < t.length && /\s/.test(t[m])) m++;
      const v = parseFlow(t, m, lineNo);
      if (v.error) return v;
      obj[key] = v.value;
      j = v.end;
      while (j < t.length && /\s/.test(t[j])) j++;
      if (t[j] === ",") { j++; continue; }
      if (t[j] === "}") return { value: obj, end: j + 1 };
      return { error: { error: "行内映射里少了逗号", line: lineNo } };
    }
  }
  let j = i;
  while (j < t.length && t[j] !== "," && t[j] !== "]" && t[j] !== "}") j++;
  return { value: plainValue(t.slice(i, j).trim()), end: j };
}

/**
 * parseScalarText —— 读一行里的一个值。
 *
 * col 是这个值在**整行**里的起始列（用来写回去时原地替换）。
 */
function parseScalarText(t, col, lineIdx) {
  if (t.startsWith("&") || t.startsWith("*")) {
    return { error: { error: "锚点与别名这一层不支持", line: lineIdx + 1 } };
  }
  if (t.startsWith("!")) {
    return { error: { error: "标签这一层不支持", line: lineIdx + 1 } };
  }
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0];
    let j = 1;
    let out = "";
    for (;;) {
      if (j >= t.length) return { error: { error: "引号没闭合", line: lineIdx + 1 } };
      const c = t[j];
      if (q === '"' && c === "\\") {
        const e = t[j + 1];
        const map = { '"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t" };
        if (e in map) { out += map[e]; j += 2; continue; }
        if (e === "u") {
          const hex = t.slice(j + 2, j + 6);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return { error: { error: "\\u 转义不完整", line: lineIdx + 1 } };
          out += String.fromCharCode(parseInt(hex, 16));
          j += 6;
          continue;
        }
        return { error: { error: "不认识的转义", line: lineIdx + 1 } };
      }
      if (c === q) {
        if (q === "'" && t[j + 1] === "'") { out += "'"; j += 2; continue; }
        break;
      }
      out += c;
      j++;
    }
    const after = t.slice(j + 1).trim();
    if (after !== "" && !after.startsWith("#")) {
      return { error: { error: "引号后面还有别的东西", line: lineIdx + 1 } };
    }
    return {
      node: {
        type: "scalar", value: out, raw: t.slice(0, j + 1),
        line: lineIdx, colStart: col, colEnd: col + j + 1, endLine: lineIdx, comment: after,
      },
    };
  }
  if (t.startsWith("[") || t.startsWith("{")) {
    const r = parseFlow(t, 0, lineIdx + 1);
    if (r.error) return r;
    const after = t.slice(r.end).trim();
    if (after !== "" && !after.startsWith("#")) {
      return { error: { error: "行内集合后面还有别的东西", line: lineIdx + 1 } };
    }
    return {
      node: {
        type: "scalar", value: r.value, raw: t.slice(0, r.end),
        line: lineIdx, colStart: col, colEnd: col + r.end, endLine: lineIdx, comment: after,
      },
    };
  }
  const at = commentAt(t);
  const raw = (at < 0 ? t : t.slice(0, at)).trimEnd();
  const comment = at < 0 ? "" : t.slice(at).trim();
  return {
    node: {
      type: "scalar", value: plainValue(raw), raw,
      line: lineIdx, colStart: col, colEnd: col + raw.length, endLine: lineIdx, comment,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 键
 * ------------------------------------------------------------------ */

/**
 * splitKey —— 读一行开头的「键: 值」。
 *
 * 返回 null 表示这一行不是键值对（那就是错了）。
 * 键可以带引号；值从冒号后的第一个非空白字符开始。
 */
function splitKey(line, indent) {
  let i = indent;
  let key;
  let keyRaw;
  if (line[i] === '"' || line[i] === "'") {
    const q = line[i];
    let j = i + 1;
    while (j < line.length) {
      if (q === '"' && line[j] === "\\") { j += 2; continue; }
      if (line[j] === q) {
        if (q === "'" && line[j + 1] === "'") { j += 2; continue; }
        break;
      }
      j++;
    }
    if (j >= line.length) return null;
    keyRaw = line.slice(i, j + 1);
    /* ⚠ **键要去引号**（2026-10-23 修的既有毛病，不是本轮引入）：
     *   原来双引号分支把**键**也交给 `plainValue` —— 而那是处理**值**的
     *   （`true`/`null`/数字），对 `"sn/claude-opus-5"` 这种带引号的字符串
     *   它**原样返回**（连引号一起）⇒ 树里的键是 `"sn/claude-opus-5"`（带引号）
     *   ⇒ 用路径 `models."sn/claude-opus-5".name` 找**永远找不到**
     *   ⇒ 写回去还会**多写一个不带引号的同名键**（YAML 语义相同、字面不同），
     *     客户端只认其中一种 ⇒ 用户在带引号那个里改的值**被盖掉**。
     *   ⇒ 键按 YAML 语义去引号（双引号里 `\"` `\\` 是转义）；单引号里 `''` 是转义。
     *   ⚠ 写回时仍用 `keyRaw`（原样）⇒ 沿用用户文件里那个键的字面形式。 */
    key = q === '"'
      ? line.slice(i + 1, j).replace(/\\(.)/g, "$1")
      : line.slice(i + 1, j).replace(/''/g, "'");
    i = j + 1;
    if (line[i] !== ":") return null;
  } else {
    let at = -1;
    for (let k = indent; k < line.length; k++) {
      if (line[k] === ":" && (k + 1 >= line.length || line[k + 1] === " " || line[k + 1] === "\t")) { at = k; break; }
    }
    if (at < 0) return null;
    key = line.slice(indent, at).trim();
    if (!key) return null;
    keyRaw = line.slice(indent, at);
    i = at;
  }
  let v = i + 1;
  while (v < line.length && (line[v] === " " || line[v] === "\t")) v++;
  return { key: String(key), keyRaw, valueCol: v, valueText: line.slice(v) };
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

function parseBlock(lines, start, indent) {
  const i0 = nextContent(lines, start);
  if (i0 >= lines.length) return { node: { type: "map", entries: [], indent, endLine: start - 1 }, next: start };
  if (lines[i0].tab) return { error: { error: "缩进里不能用制表符", line: i0 + 1 } };
  if (lines[i0].indent < indent) return { node: { type: "map", entries: [], indent, endLine: start - 1 }, next: i0 };
  const t = lines[i0].text.slice(lines[i0].indent);
  if (t === "-" || t.startsWith("- ")) return parseSeq(lines, i0, lines[i0].indent);
  return parseMap(lines, i0, lines[i0].indent);
}

function parseMap(lines, start, indent) {
  const entries = [];
  let i = start;
  let lastEnd = start - 1;
  while (i < lines.length) {
    const L = lines[i];
    if (L.blank || L.comment) { i++; continue; }
    if (L.tab) return { error: { error: "缩进里不能用制表符", line: i + 1 } };
    if (L.indent < indent) break;
    if (L.indent > indent) return { error: { error: "缩进多了一层", line: i + 1 } };
    const t = L.text.slice(L.indent);
    if (t === "-" || t.startsWith("- ")) break;
    const kv = splitKey(L.text, L.indent);
    if (!kv) return { error: { error: "这一行不是「键: 值」", line: i + 1 } };
    /* `key:   # 注释` —— 冒号后面只有注释时，这个键的**值是空的**，
       下面缩进着的那块才是它的值。（不这么认的话，用户在父键上写一句注释，
       整份文件就被判成「缩进多了一层」。） */
    const onlyComment = kv.valueText.trim() !== "" && kv.valueText.trim().startsWith("#");
    let value;
    let next;
    if (kv.valueText === "" || onlyComment) {
      const j = nextContent(lines, i + 1);
      if (j < lines.length && lines[j].indent > indent) {
        const r = parseBlock(lines, j, lines[j].indent);
        if (r.error) return r;
        value = r.node;
        next = r.next;
      } else if (j < lines.length && lines[j].indent === indent && isSeqLine(lines[j])) {
        /* 序列可以跟它的键**齐平**：
             servers:
             - name: a
           这是 YAML 最常见的两种列表写法之一。 */
        const r = parseSeq(lines, j, indent);
        if (r.error) return r;
        value = r.node;
        next = r.next;
      } else {
        value = { type: "scalar", value: null, raw: "", line: i, colStart: L.text.length, colEnd: L.text.length, endLine: i, comment: "" };
        next = i + 1;
      }
    } else if (/^[|>][-+]?[0-9]*$/.test(kv.valueText)) {
      const r = parseBlockScalar(lines, i + 1, indent, kv.valueText);
      if (r.error) return r;
      value = r.node;
      next = r.next;
    } else {
      const sc = parseScalarText(kv.valueText, kv.valueCol, i);
      if (sc.error) return sc;
      value = sc.node;
      next = i + 1;
    }
    const entry = {
      key: kv.key, keyRaw: kv.keyRaw, value, line: i, indent: L.indent,
      valueCol: kv.valueCol, endLine: value.endLine != null ? value.endLine : i,
      /* 键那一行行尾的注释（`key:   # 注释`）—— 整块替换时得留着 */
      comment: onlyComment ? kv.valueText.trim() : "",
    };
    entries.push(entry);
    lastEnd = entry.endLine;
    i = next;
  }
  return { node: { type: "map", entries, indent, endLine: lastEnd }, next: i };
}

function parseSeq(lines, start, indent) {
  const items = [];
  let i = start;
  let lastEnd = start - 1;
  while (i < lines.length) {
    const L = lines[i];
    if (L.blank || L.comment) { i++; continue; }
    if (L.tab) return { error: { error: "缩进里不能用制表符", line: i + 1 } };
    if (L.indent < indent) break;
    if (L.indent > indent) return { error: { error: "缩进多了一层", line: i + 1 } };
    const t = L.text.slice(L.indent);
    if (!(t === "-" || t.startsWith("- "))) break;
    const rest = t.slice(1);
    const lead = rest.length - rest.trimStart().length;
    const content = rest.trimStart();
    const contentCol = L.indent + 1 + lead;
    let value;
    let next;
    if (content === "") {
      const j = nextContent(lines, i + 1);
      if (j < lines.length && lines[j].indent > indent) {
        const r = parseBlock(lines, j, lines[j].indent);
        if (r.error) return r;
        value = r.node;
        next = r.next;
      } else {
        value = { type: "scalar", value: null, raw: "", line: i, colStart: L.text.length, colEnd: L.text.length, endLine: i, comment: "" };
        next = i + 1;
      }
    } else if (isKeyLine(content)) {
      /* "- 键: 值" —— 把它看成缩进更深的一张小表 */
      const sub = lines.slice();
      sub[i] = { raw: L.raw, text: " ".repeat(contentCol) + content, indent: contentCol, blank: false, comment: false, tab: false };
      const r = parseMap(sub, i, contentCol);
      if (r.error) return r;
      value = r.node;
      next = r.next;
    } else {
      const sc = parseScalarText(content, contentCol, i);
      if (sc.error) return sc;
      value = sc.node;
      next = i + 1;
    }
    items.push({ value, line: i, indent: L.indent });
    lastEnd = value.endLine != null ? value.endLine : i;
    i = next;
  }
  return { node: { type: "seq", items, indent, endLine: lastEnd }, next: i };
}

/** 一段文字是不是「键: 值」（用来认「- 键: 值」这种列表项）。 */
function isKeyLine(content) {
  if (content.startsWith('"') || content.startsWith("'")) return splitKey(content, 0) !== null;
  for (let k = 0; k < content.length; k++) {
    if (content[k] === ":" && (k + 1 >= content.length || content[k + 1] === " " || content[k + 1] === "\t")) {
      return content.slice(0, k).trim() !== "";
    }
  }
  return false;
}

/** 这一行是不是一个序列项（`- ` 或就是一个 `-`）。 */
function isSeqLine(L) {
  const t = L.text.slice(L.indent);
  return t === "-" || t.startsWith("- ");
}

/** 块标量（`|` 与 `>`）。 */
function parseBlockScalar(lines, start, indent, header) {
  const body = [];
  let j = start;
  let blockIndent = -1;
  while (j < lines.length) {
    const L = lines[j];
    if (L.blank) { body.push(""); j++; continue; }
    if (L.indent <= indent) break;
    if (blockIndent < 0) blockIndent = L.indent;
    body.push(L.text.slice(blockIndent));
    j++;
  }
  while (body.length && body[body.length - 1] === "") body.pop();
  const text = header[0] === ">" ? body.join(" ").trim() : body.join("\n");
  return {
    node: {
      type: "scalar", value: text, raw: header,
      line: start - 1, colStart: 0, colEnd: 0, endLine: j - 1, comment: "",
    },
    next: j,
  };
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function isScalarValue(v) {
  return v === null || v === undefined || typeof v !== "object";
}

/** 两个值一样吗（深比较；YAML 的 5 与 "5" 不一样）。 */
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

/**
 * 一个字符串要不要加引号。
 *
 * ⚠ **别把 URL 判成要加引号** —— `http://127.0.0.1:15799/v1` 里的冒号后面
 *   没有空格，是合法的纯量。加了引号就会把用户文件里的写法改掉（引号风格一变，
 *   断开时就还原不回原样了）。真正的规矩是 YAML 的那一条：**冒号后跟空格**
 *   或者**行尾的冒号**才需要引号。
 */
function needsQuote(s) {
  if (s === "") return true;
  if (s !== s.trim()) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/: /.test(s) || /:$/.test(s)) return true;
  if (/[,\[\]{}&*!|>'"%@`]/.test(s)) return true;
  /* 只在「# 会被当成注释」时才要引号（# 前面有空白或它在开头）。 */
  if (/(^|\s)#/.test(s)) return true;
  if (/\s/.test(s)) return true;
  if (TRUE_WORDS.has(s) || FALSE_WORDS.has(s) || NULL_WORDS.has(s)) return true;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return true;
  return false;
}

function yamlScalar(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  const s = String(v);
  return needsQuote(s) ? JSON.stringify(s) : s;
}

function yamlKey(k) {
  const s = String(k);
  return needsQuote(s) ? JSON.stringify(s) : s;
}

/** 一个值渲染成若干行（块状）。行里已经带好缩进。 */
function blockLines(v, indent, unit) {
  const pad = " ".repeat(indent);
  if (Array.isArray(v)) {
    const out = [];
    for (const item of v) {
      if (isScalarValue(item)) { out.push(pad + "- " + yamlScalar(item)); continue; }
      const sub = blockLines(item, indent + unit.length, unit);
      if (!sub.length) { out.push(pad + "-"); continue; }
      out.push(pad + "- " + sub[0].slice(indent + unit.length));
      for (let k = 1; k < sub.length; k++) out.push(sub[k]);
    }
    return out;
  }
  if (v && typeof v === "object") {
    const out = [];
    for (const [k, val] of Object.entries(v)) {
      const key = yamlKey(k);
      if (isScalarValue(val)) { out.push(pad + key + ": " + yamlScalar(val)); continue; }
      out.push(pad + key + ":");
      for (const l of blockLines(val, indent + unit.length, unit)) out.push(l);
    }
    return out;
  }
  return [pad + yamlScalar(v)];
}

/** 一串还没建出来的键 → 若干行。 */
function renderChain(segments, value, indent, unit) {
  const key = yamlKey(segments[0]);
  if (segments.length === 1) {
    if (isScalarValue(value)) return [" ".repeat(indent) + key + ": " + yamlScalar(value)];
    return [" ".repeat(indent) + key + ":"].concat(blockLines(value, indent + unit.length, unit));
  }
  return [" ".repeat(indent) + key + ":"].concat(renderChain(segments.slice(1), value, indent + unit.length, unit));
}

/** 一串键 → 一个嵌套的值（`["a","b"]` + 1 ⇒ `{a:{b:1}}`）。 */
function nestValue(segments, value) {
  let v = value;
  for (let k = segments.length - 1; k >= 0; k--) v = { [segments[k]]: v };
  return v;
}

/** 一个映射渲染成**列表的一个元素**（`- key: value`）。 */
function renderListItem(obj, indent, unit) {
  const sub = blockLines(obj, indent + unit.length, unit);
  if (!sub.length) return [" ".repeat(indent) + "- {}"];
  return [" ".repeat(indent) + "- " + sub[0].slice(indent + unit.length)].concat(sub.slice(1));
}

/* ------------------------------------------------------------------ *
 * 文档
 * ------------------------------------------------------------------ */

/** 文件里用的一级缩进（默认两个空格）。 */
function detectUnit(lines) {
  const indents = new Set();
  for (const L of lines) {
    if (L.blank || L.comment || L.indent <= 0) continue;
    indents.add(L.indent);
  }
  let min = Infinity;
  for (const v of indents) if (v < min) min = v;
  return Number.isFinite(min) ? " ".repeat(min) : "  ";
}

function parseYamlDoc(text) {
  const lines = toLines(String(text || ""));
  for (const L of lines) {
    if (L.tab) {
      return { ok: false, error: "缩进里不能用制表符", line: lines.indexOf(L) + 1 };
    }
  }
  const unit = detectUnit(lines);
  const first = nextContent(lines, 0);
  if (first >= lines.length) {
    return { ok: true, lines, unit, root: { type: "map", entries: [], indent: 0, endLine: -1 } };
  }
  const r = parseBlock(lines, first, lines[first].indent);
  if (r.error) return { ok: false, error: r.error.error, line: r.error.line };
  if (r.node.type !== "map") {
    return { ok: false, error: "根节点不是一个映射", line: first + 1 };
  }
  /* 根块后面还有内容 ⇒ 这份文件我们没读全 —— **不能当没事**：
     读不全还照样写，写出去的东西就是错的。 */
  if (r.next < lines.length) {
    const L = lines[r.next];
    if (!(L.blank || L.comment)) {
      return { ok: false, error: "根节点后面还有多余内容", line: r.next + 1 };
    }
  }
  return { ok: true, lines, unit, root: r.node };
}

/* ------------------------------------------------------------------ *
 * 查
 * ------------------------------------------------------------------ */

function nodeToJs(node) {
  if (!node) return null;
  if (node.type === "scalar") return node.value;
  if (node.type === "seq") return node.items.map((it) => nodeToJs(it.value));
  const out = {};
  for (const e of node.entries) out[e.key] = nodeToJs(e.value);
  return out;
}

/** 同名键取**最后一个**（与 JSON.parse 的语义一致：后者胜）。 */
function lastEntry(mapNode, key) {
  let hit = null;
  for (const e of mapNode.entries) if (e.key === key) hit = e;
  return hit;
}

/**
 * 路径里的「选择器」：`custom_providers[name=bai]`。
 *
 * 列表的元素没有名字，只能靠里面某个键来认 —— Hermes 的 provider 就是一个
 * 数组，每个元素一条（magpie 那边写的是映射，见 hermes.mjs 的说明）。
 *
 * ⚠ 选择器的**值里不能有点**（点分路径的分隔符就是点）；值里要有点就写
 *   `name=a\.b`（反斜杠转义，见 paths.mjs）。
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
 * 找一条路径。
 *   → { ok:true, entry, map, chain }  找到了
 *   → { ok:true, missing:true, at, map, chain, sel } 路径上有一段不存在
 *
 * `chain` 是走过的每一段（每一段一个条目）——删的时候要靠它把「空掉的父块」也删掉。
 *
 * ⚠ 「空值当映射」：`providers:` 后面没东西时，它其实是个**空映射**。
 *   我们往里写子键时得插在**它下面**，不是文件末尾 —— 所以这里给它造一个
 *   记着「我是哪个条目的值」的映射（synthetic），插的位置由它决定。
 */
function findPath(root, segments, unit) {
  const chain = [];
  let map = root;
  for (let i = 0; i < segments.length; i++) {
    const sel = parseSelector(segments[i]);
    if (sel) {
      /* 选择器：先找到那个列表，再在里面找「判别键 = 值」的那一条 */
      if (!map || map.type !== "map") return { ok: false, error: "路径的这一段不是一个映射" };
      const listEntry = lastEntry(map, sel.base);
      if (!listEntry) return { ok: true, missing: true, at: i, map, chain, sel };
      chain.push(listEntry);
      if (listEntry.value.type !== "seq") {
        return { ok: false, error: `「${sel.base}」不是一个列表，选不了元素` };
      }
      const found = listEntry.value.items.find((it) => {
        const e = lastEntry(it.value, sel.key);
        return e && e.value.type === "scalar" && String(e.value.value) === sel.value;
      });
      if (!found) {
        return { ok: true, missing: true, at: i, map, chain, sel, list: listEntry.value, listEntry };
      }
      /* 记下「这个映射是某个列表里的一个元素」—— 删空了就把它整个拿掉 */
      found.value.seqOwner = listEntry.value;
      found.value.seqItemLine = found.line;
      found.value.seqItemIndent = found.indent;
      map = found.value;
      if (i === segments.length - 1) {
        return { ok: true, entry: null, item: found, itemLine: found.line, map, chain };
      }
      continue;
    }
    if (!map || map.type !== "map") return { ok: false, error: "路径的这一段不是一个映射" };
    const e = lastEntry(map, segments[i]);
    if (!e) return { ok: true, missing: true, at: i, map, chain };
    chain.push(e);
    if (i === segments.length - 1) return { ok: true, entry: e, map, chain };
    if (e.value.type === "map") { map = e.value; continue; }
    if (e.value.type === "scalar" && e.value.value === null) {
      /* 空值（`key:` 后面没东西）当空映射 */
      map = {
        type: "map", entries: [], indent: e.indent + String(unit || "  ").length,
        endLine: e.endLine, synthetic: true, parentEntry: e,
      };
      continue;
    }
    return { ok: false, error: "路径的这一段不是一个映射" };
  }
  return { ok: false, error: "路径是空的" };
}

/* ------------------------------------------------------------------ *
 * 公开 API
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
  const doc = parseYamlDoc(text);
  if (!doc.ok) return { ok: false, error: doc.error, line: doc.line };
  const r = findPath(doc.root, segments, doc.unit);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.missing) return { ok: true, value: undefined, found: false };
  /* 路径最后一段是选择器 ⇒ 读到的是那个元素本身 */
  if (r.item && !r.entry) return { ok: true, value: nodeToJs(r.item.value), found: true };
  return { ok: true, value: nodeToJs(r.entry.value), found: true };
}

/** setPath —— 写一个点分路径的值。 */
export function setPath(text, p, value) {
  let segments;
  try {
    segments = splitPathParts(p).map((x) => x.key);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!segments.length || !segments[0]) return { ok: false, error: "键路径是空的" };
  const src = String(text || "");
  const doc = parseYamlDoc(src);
  if (!doc.ok) return { ok: false, error: doc.error, line: doc.line };
  const lines = doc.lines.slice();
  const r = findPath(doc.root, segments, doc.unit);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.missing) {
    /* 缺的是「列表里我们那一条」⇒ **追加一个元素**（不碰用户自己的条目） */
    if (r.sel) {
      const list = r.list;
      const itemIndent = list.indent;
      const item = {};
      /* ⚠ **判别键写在最前面** —— 元素是靠它认出来的：
         先写 name，后面的键才找得到这个元素（断开时它也最后被删）。 */
      item[r.sel.key] = r.sel.value;
      Object.assign(item, nestValue(segments.slice(r.at + 1), value));
      const rendered = renderListItem(item, itemIndent, doc.unit);
      const at = list.items.length
        ? list.items[list.items.length - 1].value.endLine + 1
        : (r.listEntry ? r.listEntry.endLine + 1 : lines.length);
      const out = lines.slice(0, at).concat(rendered, lines.slice(at));
      return finish(linesToText(out), src);
    }
    /* 缺的那几段 → 在最深的一个已有映射里补出来 */
    const map = r.map;
    const childIndent = map.indent;
    const rendered = renderChain(segments.slice(r.at), value, childIndent, doc.unit);
    /* 插在哪：那个映射的最后一条之后；「空值当映射」的那种就插在它下面 */
    let at;
    if (map.synthetic) at = map.parentEntry.endLine + 1;
    else if (map.entries.length) at = map.entries[map.entries.length - 1].endLine + 1;
    else at = lines.length;
    const out = lines.slice(0, at).concat(rendered, lines.slice(at));
    return finish(linesToText(out), src);
  }
  /* 路径最后一段是选择器 ⇒ 整个元素都换掉 */
  if (r.item && !r.entry) {
    const item = r.item;
    const body = blockLines(value, item.indent + doc.unit.length, doc.unit);
    const head = [" ".repeat(item.indent) + "- " + (body.length ? body[0].slice(item.indent + doc.unit.length) : "{}")];
    const out = lines.slice(0, item.line).concat(head, body.slice(1), lines.slice(item.value.endLine + 1));
    return finish(linesToText(out), src);
  }
  /* 找到了：就地改 */
  const entry = r.entry;
  if (isScalarValue(value)) {
    /* ⚠⚠ **值一样 ⇒ 一个字都不动**（用户原来的写法留着：引号、注释全在）。
       这比「按值判断要不要引号」更稳：还原时用户的原值与它原来的写法一致，
       断开以后**逐字节**相同。
       （反例：我们写的是 `name: "Claude Opus 5"`（带空格 ⇒ 要引号），
         还原时若沿用那一行的引号风格，用户的 `name: user-own-value`
         就会变成 `name: "user-own-value"` —— 值一样、字节不同。） */
    if (sameValue(entry.value.value, value)) {
      return { ok: true, text: src, changed: false };
    }
    const L = lines[entry.line];
    /* ⚠ **引号风格**：备份里存的是**解析后的值**（不是原文），所以还原时
         无从知道用户当初写的是 `"x"`、`'x'` 还是 `x`。
         ⇒ 规则：**新的值需要引号时**，沿用原来那个引号字符；**不需要时**写
           规范形式（不加引号）—— 规范形式是绝大多数人手写的样子，也是
           断开时最能还原回去的样子。
           ⚠ 反过来（原来的带引号、新的不需要，还硬留着引号）会让断开以后
           多出一对引号 ⇒ 文件与用户原来那份**不再逐字节相同**。 */
    const oldRaw = String(entry.value.raw || "");
    let text;
    if (typeof value === "string" && needsQuote(value)) {
      if (oldRaw.startsWith("'")) text = "'" + value.replace(/'/g, "''") + "'";
      else text = JSON.stringify(value);
    } else {
      text = yamlScalar(value);
    }
    const text2 = L.text.slice(0, entry.value.colStart) + text + L.text.slice(entry.value.colEnd);
    lines[entry.line] = { ...L, text: text2, raw: text2 };
    return finish(linesToText(lines), src);
  }
  /* 值是一整块（映射/序列）→ 整块换掉（键那一行的行尾注释留着） */
  const pad = " ".repeat(entry.indent);
  const head = pad + entry.keyRaw + ":" + (entry.comment ? " " + entry.comment : "");
  const body = blockLines(value, entry.indent + doc.unit.length, doc.unit);
  const out = lines.slice(0, entry.line).concat([head].concat(body), lines.slice(entry.endLine + 1));
  return finish(linesToText(out), src);
}

/** delPath —— 删一个点分路径；映射被删空了就把它自己那一块也删掉。 */
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
  const doc = parseYamlDoc(src);
  if (!doc.ok) return { ok: false, error: doc.error, line: doc.line };
  const r = findPath(doc.root, segments, doc.unit);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.missing) return { ok: true, text: src, changed: false };

  /* 先把要删的行号算齐（一次删，别删一行挪一次索引） */
  const kill = new Set();
  const add = (e) => { for (let ln = e.line; ln <= e.endLine; ln++) kill.add(ln); };

  /* 路径最后一段是选择器 ⇒ 删掉**整个元素** */
  if (r.item && !r.entry) {
    const item = r.item;
    for (let ln = item.line; ln <= item.value.endLine; ln++) kill.add(ln);
    const lines = doc.lines.filter((_, idx) => !kill.has(idx));
    return finish(linesToText(lines), src);
  }

  const entry = r.entry;
  const chain = r.chain || [];
  add(entry);
  /* 父映射被删空了 → 把它自己那一块也删掉（根映射不算） */
  let i = chain.length - 1;
  while (i >= 1) {
    const owner = chain[i - 1].value;
    if (!owner || owner.type !== "map") break;
    if (owner.entries.length !== 1) break;
    if (owner.seqOwner) {
      /* 父块是**列表里的一个元素** → 元素空了就把整个元素拿掉 */
      for (let ln = owner.seqItemLine; ln <= owner.endLine; ln++) kill.add(ln);
      break;
    }
    add(chain[i - 1]);
    i -= 1;
  }
  const lines = doc.lines.filter((_, idx) => !kill.has(idx));
  return finish(linesToText(lines), src);
}

/** 行数组 → 文本（行尾统一 LF）。数组里可以是行对象，也可以是直接写好的文本行。 */
function linesToText(lines) {
  return lines.map((l) => (typeof l === "string" ? l : l.text)).join("\n");
}

/**
 * finish —— 收尾：**行尾与末尾换行照原文件的样子**。
 *
 * ⚠ 断开时要能**逐字节**还原用户那份文件 —— 所以 CRLF 的文件还原回去还是
 *   CRLF，原本没有末尾换行的还原回去还是没有。
 *   （edit-json.mjs 的 keepCRLF 是同一个规矩；本仓的 JSON 那一族也这么做。）
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

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

registerFormat("yaml", {
  getPath, setPath, delPath,
  /* 见 formats-toml.mjs 的同一段注释：分路径器要用格式自己的，
     且返回**保留引号的段**（父路径要拼得回原路径）。 */
  splitPath: splitPathRaw,
});

export { getPath as yamlGetPath, setPath as yamlSetPath, delPath as yamlDelPath };
