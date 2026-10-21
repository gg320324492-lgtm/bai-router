/* edit-json.mjs —— 保留格式的 JSON / JSONC 编辑器
 *
 * ## 为什么需要它
 *
 * 本项目要改的是**别人家的配置文件**（`~/.claude/settings.json`），不是自己的数据文件。
 * 用户可能手改过它：加过注释、调过顺序、换过缩进风格。用 `JSON.stringify` 整份重写，
 * 会把这些统统抹平——用户下次打开文件发现自己的注释没了，是本软件造成的。
 *
 * 更糟的是「读不出来」这件事：用户文件里有个尾逗号或注释，**Claude Code 若能容忍**，
 * 本软件用裸 `JSON.parse` 就读不了；读不了若当成「空对象」再写回去，用户其余配置当场蒸发。
 *
 * 所以本模块的规矩只有一条：**宁可什么都不做，也不能弄坏用户的文件。**
 *
 * ## 核心做法：不反序列化，直接定位字节区间再 splice
 *
 * 参考 magpie 的 `internal/edit/json.go`：它用 gjson 拿值在原字节里的区间，
 * 再对原字节做 splice（gjson 的 `Index`/`Raw` 就是字节区间），于是注释、键顺序、
 * 缩进天然全保留。Go 版靠 `jsonc.ToJSONInPlace` 把注释换成等长空白，好让 gjson 的
 * offset 能 1:1 映射回原文。
 *
 * Node 侧没有这两个库，于是自己写：下面这个递归下降解析器**在解析的同时就把每个值
 * 的字节区间记进节点里**。定位因此是零成本的——不用二次扫描、不用猜路径。
 *
 * ## 与 Go 版的一处有意不同
 *
 * Go 的 `insertKey` 把新键插到对象的**第一个**成员位置。本模块插到**末尾**
 * （父指令要求，且更合用）：用户的既有键因此原地不动、留在文件原来的位置，
 * 我们写的键沉到最后。末尾若带注释，注释也跟着留在末尾。
 *
 * ## 边界
 *
 * 本模块**不碰 fs**：读文件、原子写盘都由调用方做（`server.mjs` 里已有 `writeAtomic`，
 * 不要在这里重复造）。本模块也不碰 `Date.now()`：它没有时间概念。
 */

/* ---------- 词法：空白与注释 ---------- */

const WS = " \t\n\r";

function isWs(c) {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/* BOM 单独摘出来：解析与 splice 都在没有 BOM 的正文上做，最后再贴回去，
 * 免得「插到最前面」这类操作把 BOM 顶掉。 */
function splitBom(text) {
  if (text.charCodeAt(0) === 0xfeff) return { bom: "﻿", body: text.slice(1) };
  return { bom: "", body: text };
}

/* ---------- 语法：带字节区间的递归下降 ---------- */

/* 每个节点都带 start/end（值在原文里的字节区间）。对象节点还带 members：
 * 每个成员记 key/keyStart/keyEnd/valueStart/valueEnd。定位全靠这些字段。 */
function parseTree(text) {
  let i = 0;

  function fail(msg, at) {
    const e = new Error(msg);
    e.pos = at == null ? i : at;
    throw e;
  }

  function skipWs() {
    for (;;) {
      while (i < text.length && isWs(text[i])) i++;
      if (text[i] === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (text[i] === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        if (e < 0) fail("块注释没有闭合");
        i = e + 2;
        continue;
      }
      return;
    }
  }

  function parseString() {
    const start = i;
    if (text[i] !== '"') fail("这里应该是一个字符串");
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("字符串没有闭合", start);
      const c = text[i];
      if (c === '"') { i++; break; }
      if (c === "\\") {
        const e = text[i + 1];
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("\\u 转义不是四个十六进制位");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const map = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (!(e in map)) fail("未知的转义 \\" + e);
        out += map[e];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return { type: "string", start, end: i, value: out };
  }

  function parseNumber() {
    const start = i;
    if (text[i] === "-") i++;
    while (i < text.length && text[i] >= "0" && text[i] <= "9") i++;
    if (text[i] === ".") {
      i++;
      while (i < text.length && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      while (i < text.length && text[i] >= "0" && text[i] <= "9") i++;
    }
    const rawText = text.slice(start, i);
    const num = Number(rawText);
    if (!Number.isFinite(num)) fail("这不是一个合法的数字", start);
    return { type: "number", start, end: i, value: num };
  }

  function parseLiteral() {
    const start = i;
    if (text.startsWith("true", i)) { i += 4; return { type: "boolean", start, end: i, value: true }; }
    if (text.startsWith("false", i)) { i += 5; return { type: "boolean", start, end: i, value: false }; }
    if (text.startsWith("null", i)) { i += 4; return { type: "null", start, end: i, value: null }; }
    fail("这里不是一个合法的值", start);
  }

  function parseValue() {
    skipWs();
    if (i >= text.length) fail("内容到这里就空了");
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    return parseLiteral();
  }

  /* 对象：容忍尾逗号，但不容忍连续两个逗号。 */
  function parseObject() {
    const start = i;
    i++;
    const members = [];
    const value = {};
    for (;;) {
      skipWs();
      if (i >= text.length) fail("对象没有闭合");
      if (text[i] === "}") { i++; break; }
      if (text[i] === ",") {
        if (!members.length) fail("对象里多了一个逗号");
        i++;
        skipWs();
        if (text[i] === ",") fail("对象里多了一个逗号");
        continue;
      }
      const keyNode = parseString();
      skipWs();
      if (text[i] !== ":") fail("键后面应该跟一个冒号");
      i++;
      const v = parseValue();
      members.push({
        key: keyNode.value,
        keyStart: keyNode.start,
        keyEnd: keyNode.end,
        valueStart: v.start,
        valueEnd: v.end,
        node: v,
      });
      value[keyNode.value] = v.value;
    }
    return { type: "object", start, end: i, members, value };
  }

  function parseArray() {
    const start = i;
    i++;
    const items = [];
    const value = [];
    for (;;) {
      skipWs();
      if (i >= text.length) fail("数组没有闭合");
      if (text[i] === "]") { i++; break; }
      if (text[i] === ",") {
        if (!items.length) fail("数组里多了一个逗号");
        i++;
        skipWs();
        if (text[i] === ",") fail("数组里多了一个逗号");
        continue;
      }
      const v = parseValue();
      items.push({ valueStart: v.start, valueEnd: v.end, node: v });
      value.push(v.value);
    }
    return { type: "array", start, end: i, items, value };
  }

  try {
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    skipWs();
    if (i >= text.length) return { ok: false, error: "内容是空的", line: 1, column: 1 };
    const root = parseValue();
    skipWs();
    if (i < text.length) return { ok: false, error: "根节点后面还有多余内容", line: lineOf(text, i), column: colOf(text, i) };
    return { ok: true, root };
  } catch (e) {
    const pos = e && e.pos != null ? e.pos : 0;
    return { ok: false, error: e && e.message ? e.message : String(e), line: lineOf(text, pos), column: colOf(text, pos) };
  }
}

function lineOf(text, pos) {
  let line = 1;
  for (let k = 0; k < pos && k < text.length; k++) if (text[k] === "\n") line++;
  return line;
}

function colOf(text, pos) {
  let col = 1;
  for (let k = 0; k < pos && k < text.length; k++) {
    if (text[k] === "\n") col = 1; else col++;
  }
  return col;
}

/* ---------- 路径 ---------- */

/* 点号分隔；反斜杠转义的反斜杠点是一个键的一部分
 * （VS Code 的 settings.json 里有 "chat.defaultModel" 这种带点的键）。 */
export function splitPath(keyPath) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < keyPath.length; i++) {
    if (keyPath[i] === "\\") { i++; continue; }
    if (keyPath[i] === ".") { parts.push(keyPath.slice(start, i)); start = i + 1; }
  }
  parts.push(keyPath.slice(start));
  return parts;
}

export function unescapeKey(part) {
  return part.replace(/\\\./g, ".");
}

function findNode(root, parts) {
  let node = root;
  for (const part of parts) {
    if (!node || node.type !== "object") return null;
    const want = unescapeKey(part);
    let hit = null;
    /* 同名键取**最后一个** —— 与 JSON.parse 的语义一致（后者胜）。
     * 取第一个的话：文件里 `{"env":{...},"env":{...}}` 时，我们改的是**被遮住的那一个**，
     * 而实际生效的是后一个 → 改动**静默无效**，用户看着「接线成功」而配置没变。
     * （JSON.parse 本身也是后者胜：parseObject 里 `value[key] = v.value` 逐个覆盖。） */
    for (const m of node.members) {
      if (m.key === want) hit = m;
    }
    if (!hit) return null;
    node = hit.node;
  }
  return node;
}

/* ---------- 字节工具 ---------- */

function splice(text, at, n, withText) {
  return text.slice(0, at) + withText + text.slice(at + n);
}

/* pos 所在行的前导空白 */
function lineIndent(text, pos) {
  const start = text.slice(0, Math.max(0, pos)).lastIndexOf("\n") + 1;
  let i = start;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  return text.slice(start, i);
}

/* 从 pos 之后那一行的缩进推出一级缩进：下一行比当前 base 多出来的那截。
 * 推不出来时：base 里有 tab 或文件里有 "\n\t" 就用 tab，否则两个空格。 */
function indentUnit(text, pos, base) {
  const nl = text.indexOf("\n", pos);
  if (nl >= 0) {
    const next = lineIndent(text, nl + 1);
    if (next.length > base.length && next.startsWith(base)) return next.slice(base.length);
  }
  if (base.includes("\t") || text.includes("\n\t")) return "\t";
  return "  ";
}

/* 按文件风格渲染一个值。prefix 是续行前缀（Go 的 MarshalIndent 同款语义：
 * 首行不带前缀，续行都带）。 */
function marshal(value, unit, prefix) {
  const s = JSON.stringify(value, null, unit);
  if (s === undefined) return "null";
  const lines = s.split("\n");
  if (lines.length === 1) return s;
  return lines.map((l, k) => (k === 0 ? l : prefix + l)).join("\n");
}

function marshalAt(text, pos, value) {
  if (!text.includes("\n")) return JSON.stringify(value);
  const base = lineIndent(text, pos);
  return marshal(value, indentUnit(text, pos, base), base);
}

/* 原文件全用 CRLF 就把结果也全转成 CRLF；混合换行保持原样不统一。 */
function keepCRLF(out, orig) {
  const n = countOf(orig, "\n");
  if (n === 0 || countOf(orig, "\r\n") !== n) return out;
  return out.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

function countOf(text, needle) {
  let n = 0, at = 0;
  for (;;) {
    const k = text.indexOf(needle, at);
    if (k < 0) return n;
    n++;
    at = k + needle.length;
  }
}

function matchBrace(text, open) {
  let depth = 0, inStr = false;
  for (let k = open; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (c === "\\") k++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return k; }
  }
  return -1;
}

/* 被删成员独占一行时，连整行一起删，免得 CRLF 文件留下空行。 */
function pastLineEnd(text, i) {
  if (text.startsWith("\r\n", i)) return i + 2;
  if (text[i] === "\n") return i + 1;
  return i;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, k) => deepEqual(x, b[k]));
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/* ---------- 插入与删除 ---------- */

/* 往对象里加一个键：插到**末尾**，用户既有的键原地不动。
 * 返回 { at, hasComma }：at 是插入位置，hasComma 表示那里已经有逗号。 */
function insertionPoint(text, obj) {
  if (!obj.members.length) return { at: obj.start + 1, hasComma: false, empty: true };
  const last = obj.members[obj.members.length - 1];
  let j = last.valueEnd;
  while (j < text.length) {
    const c = text[j];
    if (c === ",") return { at: j + 1, hasComma: true, empty: false };
    if (isWs(c)) { j++; continue; }
    if (c === "/" && text[j + 1] === "/") { while (j < text.length && text[j] !== "\n") j++; continue; }
    if (c === "/" && text[j + 1] === "*") {
      const e = text.indexOf("*/", j + 2);
      j = e < 0 ? text.length : e + 2;
      continue;
    }
    break;
  }
  return { at: last.valueEnd, hasComma: false, empty: false };
}

function insertKey(text, obj, key, value) {
  const k = JSON.stringify(key);
  const pretty = text.includes("\n");
  const ip = insertionPoint(text, obj);
  if (!pretty) {
    const v = JSON.stringify(value);
    if (ip.empty) return splice(text, ip.at, 0, k + ":" + v);
    /* ⚠ 插入点**可能已经有逗号**（`{"a":1,}` 这种尾逗号写法）。
     *   无条件再加一个逗号 → `{"a":1,,"b":2}` → 整个文件变非法 JSON。
     *   已有的逗号直接当分隔符用。 */
    return splice(text, ip.at, 0, (ip.hasComma ? "" : ",") + k + ":" + v);
  }
  const base = lineIndent(text, obj.start);
  const unit = indentUnit(text, obj.start, base);
  const child = base + unit;
  const v = marshal(value, unit, child);
  const kv = child + k + ": " + v;
  if (ip.empty) {
    return splice(text, obj.start, obj.end - obj.start, "{\n" + kv + "\n" + base + "}");
  }
  return splice(text, ip.at, 0, (ip.hasComma ? "\n" : ",\n") + kv);
}

/* 从对象里删掉一个成员：连逗号一起删干净。 */
function deleteMember(text, obj, member) {
  const keyStart = member.keyStart;
  const valueEnd = member.valueEnd;
  const ls = text.slice(0, keyStart).lastIndexOf("\n") + 1;
  const alone = text.slice(ls, keyStart).trim() === "";
  let j = valueEnd;
  while (j < text.length && isWs(text[j])) j++;
  let from = keyStart, to = valueEnd;
  if (text[j] === ",") {
    to = j + 1;
    if (alone) { from = ls; to = pastLineEnd(text, to); }
    return splice(text, from, to - from, "");
  }
  if (alone) { from = ls; to = pastLineEnd(text, to); }
  const out = splice(text, from, to - from, "");
  /* 它是最后一个成员：把它前面那个逗号也去掉，否则会留下 {"a":1,} 这种尾巴。 */
  let k = keyStart;
  while (k > 0 && isWs(text[k - 1])) k--;
  if (k > 0 && text[k - 1] === ",") return splice(out, k - 1, 1, "");
  return out;
}

/* 删空之后把空对象收成 {}。对象里若还留着注释就不收——注释比 {} 重要。 */
function collapseIfEmpty(text, objStart) {
  const close = matchBrace(text, objStart);
  if (close < 0) return text;
  if (text.slice(objStart + 1, close).trim() !== "") return text;
  return splice(text, objStart, close - objStart + 1, "{}");
}

/* ---------- 内部实现（正文，不含 BOM） ---------- */

function nest(parts, value) {
  let v = value;
  for (let k = parts.length - 1; k >= 0; k--) v = { [unescapeKey(parts[k])]: v };
  return v;
}

function setIn(text, path, value) {
  const tree = parseTree(text);
  if (!tree.ok) return { ok: false, error: tree.error, line: tree.line, column: tree.column };
  const root = tree.root;
  if (root.type !== "object") return { ok: false, error: "根节点不是一个 JSON 对象" };
  const parts = splitPath(path);
  if (!parts.length || !parts[0]) return { ok: false, error: "键路径是空的" };

  /* 找最长存在的祖先：精确命中就换值；祖先是标量就换成嵌套对象；
   * 祖先是对象就往里插一个键。 */
  for (let k = parts.length; k >= 1; k--) {
    const node = findNode(root, parts.slice(0, k));
    if (!node) continue;
    if (k === parts.length) {
      if (deepEqual(node.value, value)) return { ok: true, text, changed: false };
      const m = marshalAt(text, node.start, value);
      return { ok: true, text: splice(text, node.start, node.end - node.start, m), changed: true };
    }
    if (node.type !== "object") {
      const m = marshalAt(text, node.start, nest(parts.slice(k), value));
      return { ok: true, text: splice(text, node.start, node.end - node.start, m), changed: true };
    }
    const nested = nest(parts.slice(k + 1), value);
    return { ok: true, text: insertKey(text, node, unescapeKey(parts[k]), nested), changed: true };
  }
  const nested = nest(parts.slice(1), value);
  return { ok: true, text: insertKey(text, root, unescapeKey(parts[0]), nested), changed: true };
}

function delIn(text, path) {
  const tree = parseTree(text);
  if (!tree.ok) return { ok: false, error: tree.error, line: tree.line, column: tree.column };
  const parts = splitPath(path);
  if (!parts.length) return { ok: true, text, changed: false };
  const parent = findNode(tree.root, parts.slice(0, -1));
  if (!parent || parent.type !== "object") return { ok: true, text, changed: false };
  const lastKey = unescapeKey(parts[parts.length - 1]);
  /* 同名键**全部**删掉。
   * 只删一个的话，前面的同名键会「复活」并顶替它（JSON 解析时后者胜）——
   * 表现就是「删了等于没删」，而且面板上还看不出任何异常。 */
  const hits = parent.members.filter((m) => m.key === lastKey);
  if (!hits.length) return { ok: true, text, changed: false };
  let out = text;
  /* 从后往前删：后面的先删，前面的成员偏移才不会因为删除而失效。 */
  for (let i = hits.length - 1; i >= 0; i--) out = deleteMember(out, parent, hits[i]);
  if (hits.length === parent.members.length) out = collapseIfEmpty(out, parent.start);
  return { ok: true, text: out, changed: true };
}

/* ---------- 公开 API ---------- */

/* 读一个 JSON / JSONC 文件的内容。
 *
 * 成功 → { ok: true, value }（value 是普通 JS 值）
 * 失败 → { ok: false, error, line, column }
 *
 * ⚠ 失败**绝不**返回 { ok: true, value: {} }。读不出来就是「不知道」，
 * 不是「空」——把两者混同是本项目吃过大亏的地方（把用户配置读失败当成空对象，
 * 再写回去，用户其余配置当场蒸发）。「文件不存在」由调用方自己判断，那是
 * 合法状态、可以从空开始建；「文件在但读不懂」必须中止，不能覆盖。 */
export function parseJsonc(text) {
  const tree = parseTree(text);
  if (!tree.ok) return { ok: false, error: tree.error, line: tree.line, column: tree.column };
  return { ok: true, value: tree.root.value };
}

/* 读某个键路径的值。
 * 路径不存在 → { ok: true, value: undefined, found: false }
 * 解析失败   → { ok: false, error, line, column } */
export function getPath(text, path) {
  const tree = parseTree(text);
  if (!tree.ok) return { ok: false, error: tree.error, line: tree.line, column: tree.column };
  const node = findNode(tree.root, splitPath(path));
  if (!node) return { ok: true, value: undefined, found: false };
  return { ok: true, value: node.value, found: true };
}

/* 写一个键路径，保留注释、键顺序、缩进、换行风格与 BOM。
 * 成功 → { ok: true, text, changed }（changed 为 false 表示原值本来就一样，不该写盘）
 * 失败 → { ok: false, error, line, column } */
export function setPath(text, path, value) {
  const { bom, body } = splitBom(text);
  const src = body.trim() === "" ? "{}\n" : body;
  const r = setIn(src, path, value);
  if (!r.ok) return r;
  const out = bom + keepCRLF(r.text, body);
  const check = parseJsonc(out);
  if (!check.ok) return { ok: false, error: "改写结果不可解析：" + check.error };
  return { ok: true, text: out, changed: r.changed };
}

/* 删一个键路径，其余原样保留。
 * 键不存在 → { ok: true, text, changed: false } */
export function delPath(text, path) {
  const { bom, body } = splitBom(text);
  const r = delIn(body, path);
  if (!r.ok) return r;
  const out = bom + keepCRLF(r.text, body);
  const check = parseJsonc(out);
  if (!check.ok) return { ok: false, error: "改写结果不可解析：" + check.error };
  return { ok: true, text: out, changed: r.changed };
}

/* 一次改多处：edits 是 [{path, value}] 或 [{path, delete: true}]，按顺序应用。
 * 任一处出错就整体失败（不产出半改的文件）。 */
export function applyEdits(text, edits) {
  const { bom, body } = splitBom(text);
  let cur = body.trim() === "" ? "{}\n" : body;
  let changed = false;
  for (const e of edits || []) {
    if (!e || typeof e.path !== "string") return { ok: false, error: "这条编辑没有键路径" };
    const r = e.delete ? delIn(cur, e.path) : setIn(cur, e.path, e.value);
    if (!r.ok) return r;
    if (r.changed) changed = true;
    cur = r.text;
  }
  const out = bom + keepCRLF(cur, body);
  const check = parseJsonc(out);
  if (!check.ok) return { ok: false, error: "改写结果不可解析：" + check.error };
  return { ok: true, text: out, changed };
}

/* 看出这份文件的书写风格，好让写回时对齐。
 * 返回 { bom, crlf, mixed, indentUnit, indentWidth, trailingNewline } */
export function detectFormat(text) {
  const { bom, body } = splitBom(text);
  const nl = countOf(body, "\n");
  const crlf = countOf(body, "\r\n");
  const base = lineIndent(body, 0);
  const unit = indentUnit(body, 0, base);
  return {
    bom: bom.length > 0,
    crlf: nl > 0 && crlf === nl,
    mixed: crlf > 0 && crlf < nl,
    indentUnit: unit,
    indentWidth: unit === "\t" ? 1 : unit.length,
    trailingNewline: /\n$/.test(body),
  };
}
