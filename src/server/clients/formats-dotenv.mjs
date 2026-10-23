// src/server/clients/formats-dotenv.mjs —— .env 的最小读写器
//
// ## 为什么需要它
//
// Reasonix Studio 的 provider 条目里只有 `api_key_env`（**环境变量的名字**），
// 真的 key 放在配置文件旁边的 `.env` 里（magpie 的 reasonix.go 就是这么写的：
// edit.SetEnvFile(env, edit.KV{Path: reasonixKey, Value: gwKey()}）。
//
// 没有这个 .env，Reasonix 拿不到凭据，接线等于没接。
//
// ## 支持什么
//
//   · `KEY = value` / `KEY=value` / `export KEY=value`
//   · 值可以用单引号或双引号包起来（引号里的 `#` 不是注释，**引号后面还能跟注释**）
//   · 整行注释与空行原样保留
//   · 读不懂的行原样保留（不猜、不丢）
//
// ## 不支持什么
//
//   · 多行值、变量展开（`$FOO`）——原样保留，不展开
//   · 一个键写两遍——按**最后一个**算（与 shell、TOML 都一致）：
//     读最后一个、写最后一个、**删也只删最后一个**（否则「写」与「删」不是互逆的）
//
// ## 写的时候保留什么
//
//   · 只换**值**那一段：`export ` 前缀、`=` 两边的空格、行尾注释都留着。
//   · 值的引号风格也留着（用户写的是 `"x"` 就还是 `"x"`）——
//     否则断开时还原出来的文件与用户原来那份不是逐字节相同。

import { registerFormat } from "./base.mjs";

const KEY_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * 读一行。
 *
 * 返回 `{ raw, key, value, valueStart, valueEnd, comment, quoted }`：
 *   · key 为 null —— 这一行不是「键 = 值」（注释、空行、读不懂的行）
 *   · valueStart/valueEnd —— 值在**这一行**里的字符区间（写的时候只换它）
 *   · comment —— 行尾注释（不在引号里的那个 #）
 *   · quoted —— 值的引号字符（"" 表示没引号）
 */
function readLine(raw) {
  const line = raw.replace(/\r$/, "");
  const t = line.trim();
  if (!t || t.startsWith("#")) return { raw: line, key: null, value: null };
  const m = KEY_RE.exec(line);
  if (!m) return { raw: line, key: null, value: null };
  const key = m[1];
  const afterEq = m[0].length;
  /* 值从等号后面第一个非空白字符开始 */
  let vs = afterEq;
  while (vs < line.length && (line[vs] === " " || line[vs] === "\t")) vs++;
  let ve = line.length;
  let quoted = "";
  let value = "";
  let comment = "";
  if (line[vs] === '"' || line[vs] === "'") {
    const q = line[vs];
    let j = vs + 1;
    let out = "";
    let closed = false;
    for (; j < line.length; j++) {
      const c = line[j];
      if (q === '"' && c === "\\") {
        const u = unescapeQuoted(line, j);
        out += u.text;
        j = u.next - 1;
        continue;
      }
      if (c === q) { closed = true; j += 1; break; }
      out += c;
    }
    if (!closed) {
      /* 引号没闭合 —— 整行当作读不懂（值原样留着，不猜） */
      return { raw: line, key: null, value: null };
    }
    value = out;
    quoted = q;
    ve = j;
    const rest = line.slice(j).trim();
    if (rest !== "" && !rest.startsWith("#")) {
      /* 引号后面还有别的东西 —— 读不懂 */
      return { raw: line, key: null, value: null };
    }
    comment = rest.startsWith("#") ? rest : "";
  } else {
    /* 没引号的：行尾的 # 是注释 */
    let cut = line.length;
    for (let k = vs; k < line.length; k++) {
      if (line[k] === "#" && (k === vs || line[k - 1] === " " || line[k - 1] === "\t")) { cut = k; break; }
    }
    value = line.slice(vs, cut).trimEnd();
    ve = cut;
    while (ve > vs && (line[ve - 1] === " " || line[ve - 1] === "\t")) ve -= 1;
    comment = cut < line.length ? line.slice(cut).trim() : "";
  }
  return { raw: line, key, value, valueStart: vs, valueEnd: ve, comment, quoted };
}

/**
 * 双引号里的一个转义（line[j] 是反斜杠）。
 *
 * ⚠ **一个一个来** —— 不能先 replace("\\n") 再 replace("\\\\")：
 *   那样 `C:\\new dir` 里的 `\\n` 会被当成转义换行吃掉（值就变了）。
 */
function unescapeQuoted(line, j) {
  const e = line[j + 1];
  const map = { '"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t" };
  if (e in map) return { text: map[e], next: j + 2 };
  if (e === "u") {
    const hex = line.slice(j + 2, j + 6);
    if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
      return { text: String.fromCharCode(parseInt(hex, 16)), next: j + 6 };
    }
  }
  return { text: e == null ? "" : e, next: j + 2 };
}

/** 一个值写成 .env 里的样子（不带引号 —— 引号由调用方按原来的风格决定）。 */
function plainValue(v) {
  const s = String(v == null ? "" : v);
  /* 值里有空白、引号、# 或 $ 就得用引号包起来 —— 否则 .env 的读法会走样 */
  if (s === "" || /[\s#"'$]/.test(s)) return JSON.stringify(s);
  return s;
}

/** 一个值按给定的引号风格写出来。 */
function renderValue(v, quoted) {
  const s = String(v == null ? "" : v);
  if (quoted === "'") return "'" + s.replace(/'/g, "''") + "'";
  if (quoted === '"') return JSON.stringify(s);
  return plainValue(s);
}

/** getPath —— 读一个环境变量（路径就是变量名，不带点）。 */
export function getPath(text, p) {
  const key = String(p || "").trim();
  if (!key) return { ok: true, value: undefined, found: false };
  const lines = String(text || "").split("\n");
  let found = null;
  for (const raw of lines) {
    const L = readLine(raw);
    if (L.key === key) found = L.value;   /* 最后一个赢 */
  }
  if (found === null) return { ok: true, value: undefined, found: false };
  return { ok: true, value: found, found: true };
}

/** setPath —— 写一个环境变量；只换**值**那一段，其余（前缀、空格、注释）留着。 */
export function setPath(text, p, value) {
  const key = String(p || "").trim();
  if (!key) return { ok: false, error: "键路径是空的" };
  const src = String(text || "");
  const lines = src.split("\n");
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    if (readLine(lines[i]).key === key) hit = i;   /* 最后一个赢 */
  }
  if (hit >= 0) {
    const L = readLine(lines[hit]);
    const rendered = renderValue(value, L.quoted);
    lines[hit] = L.raw.slice(0, L.valueStart) + rendered + L.raw.slice(L.valueEnd);
  } else {
    /* 末尾若有空行，插在它前面，别让文件以空行结尾 */
    let at = lines.length;
    while (at > 0 && lines[at - 1].trim() === "") at--;
    lines.splice(at, 0, `${key} = ${renderValue(value, "")}`);
  }
  const out = lines.join("\n").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withNl = out.endsWith("\n") || out === "" ? out : out + "\n";
  return { ok: true, text: withNl, changed: withNl !== src };
}

/** delPath —— 删掉**最后一个**那个键（与「最后一个赢」一致：写与删互逆）。 */
export function delPath(text, p) {
  const key = String(p || "").trim();
  if (!key) return { ok: true, text, changed: false };
  const src = String(text || "");
  const lines = src.split("\n");
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    if (readLine(lines[i]).key === key) hit = i;
  }
  if (hit < 0) return { ok: true, text: src, changed: false };
  lines.splice(hit, 1);
  const out = lines.join("\n").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withNl = out.endsWith("\n") || out === "" ? out : out + "\n";
  return { ok: true, text: withNl, changed: withNl !== src };
}

registerFormat("dotenv", {
  getPath, setPath, delPath,
  /* ⚠ **dotenv 的键没有层级** —— 路径就是键名本身（GOOGLE_GEMINI_BASE_URL），
     **不加点分**。所以这里只切一刀（切了也没有意义），让底座算父路径时
     认得「这个路径只有一段、没有父路径」。 */
  splitPath: (p) => [String(p == null ? "" : p)],
});

export { getPath as dotenvGetPath, setPath as dotenvSetPath, delPath as dotenvDelPath };
