/**
 * edit-json.mjs 的测试
 *
 *   node --test scripts/edit-json-test.mjs
 *
 * ## 这个模块为什么这么难测
 *
 * 因为它改的是**用户的文件**。一个「看起来能用」的编辑器，可能悄悄抹掉用户的注释、
 * 把缩进换掉、把键序打乱、把 CRLF 变成 LF——这些都不会让程序报错，只会让用户
 * 在某个无关的时刻发现自己的配置变了。所以这里的断言大多不是「结果对不对」，
 * 而是「**别的地方有没有被动过**」。
 *
 * ## 断言手法
 *
 * 改一个值之后，把新值换回旧值，**整个文本必须与原文逐字相同**。这一招同时盖住
 * 注释、键序、缩进、换行、BOM——任何一处被动过都会露馅。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonc, getPath, setPath, delPath, applyEdits, detectFormat,
} from "../src/server/edit-json.mjs";

/* ══════════════════════════════════════════════════════════════
 * ① 解析层
 * ══════════════════════════════════════════════════════════════ */

test("① 普通 JSON 能解析", () => {
  const r = parseJsonc('{"a":1,"b":"x","c":true,"d":null,"e":[1,2]}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { a: 1, b: "x", c: true, d: null, e: [1, 2] });
});

test("① 行注释与块注释都容忍", () => {
  const r = parseJsonc('{\n  // 我的注释\n  "a": 1, /* 块注释 */\n  "b": 2\n}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { a: 1, b: 2 });
});

test("① 尾逗号容忍，但连续两个逗号不容忍", () => {
  assert.equal(parseJsonc('{"a":1,}').ok, true);
  assert.equal(parseJsonc('[1,2,]').ok, true);
  const bad = parseJsonc('{"a":1,,}');
  assert.equal(bad.ok, false);
});

test("① UTF-8 BOM 容忍", () => {
  const r = parseJsonc('﻿{"a":1}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { a: 1 });
});

test("① 转义与 Unicode 正确", () => {
  const r = parseJsonc('{"s":"a\\"b\\\\c\\n\\u4e2d","n":-1.5e3}');
  assert.equal(r.ok, true);
  assert.equal(r.value.s, 'a"b\\c\n中');
  assert.equal(r.value.n, -1500);
});

test("★ ① 非法 JSON 必须报失败，且**绝不能**返回 {} 当空对象", () => {
  /* 这是本模块最重要的一条：读不出来是「不知道」，不是「空」。
   * 把两者混同 = 把用户其余配置写回去时抹掉。 */
  for (const bad of ['{"a":', "{a:1}", '{"a":1,,"b":2}', "not json", '{"a":1} extra']) {
    const r = parseJsonc(bad);
    assert.equal(r.ok, false, `应该判失败：${bad}`);
    assert.notEqual(r.value, {}, `绝不能把失败当空对象：${bad}`);
    assert.equal(typeof r.error, "string");
    assert.equal(typeof r.line, "number");
  }
});

test("① 未闭合的结构报失败并带行列", () => {
  const r = parseJsonc('{\n  "a": 1\n');
  assert.equal(r.ok, false);
  assert.equal(r.line, 3);
});

/* ══════════════════════════════════════════════════════════════
 * ② 读
 * ══════════════════════════════════════════════════════════════ */

test("② 读嵌套路径", () => {
  const r = getPath('{"env":{"BASE":"http://x"}}', "env.BASE");
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.equal(r.value, "http://x");
});

test("② 路径不存在 → found:false，不是解析失败", () => {
  const r = getPath('{"a":1}', "b.c");
  assert.equal(r.ok, true);
  assert.equal(r.found, false);
});

test("② 键里带点用反斜杠转义", () => {
  const r = getPath('{"chat.defaultModel":"x"}', "chat\\.defaultModel");
  assert.equal(r.found, true);
  assert.equal(r.value, "x");
});

/* ══════════════════════════════════════════════════════════════
 * ③ 写：别的地方有没有被动过
 * ══════════════════════════════════════════════════════════════ */

test("★ ③ 改已有键的值 → 别的键顺序不变、缩进不变、注释还在", () => {
  const before = '{\n  // 我的注释\n  "a": 1,\n  "b": 2,\n  "c": 3\n}';
  const r = setPath(before, "b", 20);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  /* 把新值换回旧值，整个文本必须与原文逐字相同 —— 一处都不许动过 */
  assert.equal(r.text.replace('"b": 20', '"b": 2'), before);
  assert.match(r.text, /\/\/ 我的注释/);
});

test("★ ③ 改嵌套路径 → 只有那一段字节变了", () => {
  const before = '{\n  "a": 1,\n  "env": {\n    "X": "old",\n    "Y": "keep"\n  }\n}';
  const r = setPath(before, "env.X", "new");
  assert.equal(r.ok, true);
  assert.equal(r.text.replace('"X": "new"', '"X": "old"'), before);
});

test("③ 加新键 → 插到对象末尾，缩进与原风格一致", () => {
  const before = '{\n  "a": 1\n}';
  const r = setPath(before, "b", 2);
  assert.equal(r.ok, true);
  assert.equal(r.text, '{\n  "a": 1,\n  "b": 2\n}');
  assert.deepEqual(Object.keys(parseJsonc(r.text).value), ["a", "b"]);
});

test("③ 加嵌套路径（父不存在）→ 自动建出嵌套对象", () => {
  const r = setPath('{\n  "a": 1\n}', "env.BASE", "http://x");
  assert.equal(r.ok, true);
  assert.deepEqual(parseJsonc(r.text).value, { a: 1, env: { BASE: "http://x" } });
});

test("③ 祖先是标量时，换成嵌套对象", () => {
  const r = setPath('{\n  "env": "x"\n}', "env.BASE", "http://y");
  assert.equal(r.ok, true);
  assert.deepEqual(parseJsonc(r.text).value, { env: { BASE: "http://y" } });
});

test("★ ③ 幂等：同样的 setPath 调两次，第二次 changed=false 且文本逐字相同", () => {
  const once = setPath('{\n  "a": 1\n}', "a", 2);
  assert.equal(once.changed, true);
  const twice = setPath(once.text, "a", 2);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
});

/* ══════════════════════════════════════════════════════════════
 * ④ 删
 * ══════════════════════════════════════════════════════════════ */

test("★ ④ 删中间的键 → 逗号处理干净", () => {
  const r = delPath('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}', "b");
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.text, '{\n  "a": 1,\n  "c": 3\n}');
  assert.equal(parseJsonc(r.text).ok, true);
});

test("★ ④ 删最后一个键 → 前面的逗号也要去掉，不能留下 {\"a\":1,}", () => {
  const r = delPath('{\n  "a": 1,\n  "b": 2\n}', "b");
  assert.equal(r.ok, true);
  assert.equal(r.text, '{\n  "a": 1\n}');
  assert.ok(!/,}/.test(r.text), "不能留下尾逗号");
});

test("④ 删独占一行的键 → 整行删掉，不留空行", () => {
  const r = delPath('{\n  "a": 1,\n  "b": 2\n}', "a");
  assert.equal(r.text, '{\n  "b": 2\n}');
  assert.ok(!/\n\s*\n/.test(r.text), "不该留下空行");
});

test("④ 删掉唯一的键 → 对象折叠成 {}", () => {
  const r = delPath('{\n  "a": 1\n}', "a");
  assert.equal(r.text, "{}");
});

test("④ 删不存在的键 → changed=false，文本逐字不变", () => {
  const before = '{\n  "a": 1\n}';
  const r = delPath(before, "zzz");
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.text, before);
});

test("④ 删键时旁边的注释保留", () => {
  const r = delPath('{\n  "a": 1, // 留着\n  "b": 2\n}', "a");
  assert.match(r.text, /\/\/ 留着/);
  assert.equal(parseJsonc(r.text).ok, true);
});

/* ══════════════════════════════════════════════════════════════
 * ⑤ 风格保持
 * ══════════════════════════════════════════════════════════════ */

test("★ ⑤ BOM 保持", () => {
  const before = '﻿{\n  "a": 1\n}';
  const r = setPath(before, "a", 2);
  assert.ok(r.text.startsWith("﻿"), "BOM 必须在");
  assert.equal(r.text.replace('"a": 2', '"a": 1'), before);
});

test("★ ⑤ CRLF 保持，且新插入的行也是 CRLF", () => {
  const before = '{\r\n  "a": 1\r\n}';
  const r = setPath(before, "b", 2);
  assert.equal(r.ok, true);
  assert.ok(!/[^\r]\n/.test(r.text), "不该出现裸 LF");
  assert.ok(r.text.includes('\r\n  "b": 2'), "新键的行尾必须是 CRLF");
});

test("★ ⑤ tab 缩进保持", () => {
  const before = '{\n\t"a": 1\n}';
  const r = setPath(before, "b", 2);
  assert.ok(r.text.includes('\n\t"b": 2'), "新键该用 tab 缩进");
});

test("★ ⑤ 2 空格 / 4 空格缩进各自保持", () => {
  const two = setPath('{\n  "a": 1\n}', "b", 2);
  assert.ok(two.text.includes('\n  "b": 2'));
  const four = setPath('{\n    "a": 1\n}', "b", 2);
  assert.ok(four.text.includes('\n    "b": 2'));
});

test("⑤ 末尾换行保持", () => {
  const withNl = setPath('{\n  "a": 1\n}\n', "a", 2);
  assert.ok(withNl.text.endsWith("\n"));
});

test("⑤ 混合换行不被统一", () => {
  const before = '{\r\n  "a": 1\n}';
  const r = setPath(before, "b", 2);
  assert.equal(r.ok, true);
  assert.ok(r.text.includes("\r\n"), "原有的 CRLF 段落得留着");
  assert.ok(r.text.includes("\n"), "原有的 LF 段落也得留着");
});

/* ══════════════════════════════════════════════════════════════
 * ⑥ 一次改多处
 * ══════════════════════════════════════════════════════════════ */

test("⑥ applyEdits 一次改多处", () => {
  const r = applyEdits('{\n  "a": 1,\n  "b": 2\n}', [
    { path: "a", value: 10 },
    { path: "c", value: 3 },
    { path: "b", delete: true },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(parseJsonc(r.text).value, { a: 10, c: 3 });
});

test("★ ⑥ applyEdits 中间出错 → 整体失败，不产出半改的文件", () => {
  /* 根不是对象 → 改不了。这条必须整体失败、不能产出半改的文件。 */
  const bad = applyEdits("[1,2]", [{ path: "a", value: 1 }]);
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.error, "string");
  assert.equal(bad.text, undefined, "失败时不能顺带吐一份改了一半的文本");
});

test("⑥ applyEdits 里的父路径不存在 → 会自动建出中间层", () => {
  const r = applyEdits('{\n  "a": 1\n}', [{ path: "b.c.d", value: 1 }]);
  assert.equal(r.ok, true);
  assert.deepEqual(parseJsonc(r.text).value, { a: 1, b: { c: { d: 1 } } });
});

/* ══════════════════════════════════════════════════════════════
 * ⑦ detectFormat
 * ══════════════════════════════════════════════════════════════ */

test("⑦ detectFormat 认出各风格", () => {
  assert.equal(detectFormat('﻿{}').bom, true);
  assert.equal(detectFormat('{\r\n  "a": 1\r\n}').crlf, true);
  assert.equal(detectFormat('{\n  "a": 1\n}').crlf, false);
  assert.equal(detectFormat('{\n\t"a": 1\n}').indentUnit, "\t");
  assert.equal(detectFormat('{\n  "a": 1\n}').indentUnit, "  ");
  assert.equal(detectFormat('{\n    "a": 1\n}').indentUnit, "    ");
});

/* ══════════════════════════════════════════════════════════════
 * 反向对照：改坏源码，这些测试必须红
 * ══════════════════════════════════════════════════════════════ */

const SABOTAGE = [
  {
    name: "改写改成整份重排",
    file: "src/server/edit-json.mjs",
    from: "  const r = setIn(src, path, value);",
    to: "  const r = (() => { const v = parseJsonc(src).value || {}; const ps = splitPath(path); let c = v; for (let i = 0; i < ps.length - 1; i++) { c[ps[i]] = c[ps[i]] || {}; c = c[ps[i]]; } c[ps[ps.length - 1]] = value; return { ok: true, text: JSON.stringify(v, null, 2), changed: true }; })();",
    where: "setPath 改成整份 JSON.stringify 重写",
    reds: "① 注释还在 / 只动那一段字节 —— 整份重写会把注释抹掉",
  },
  {
    name: "删键不处理前逗号",
    file: "src/server/edit-json.mjs",
    from: '  if (k > 0 && text[k - 1] === ",") return splice(out, k - 1, 1, "");',
    to: '  if (false) return splice(out, k - 1, 1, "");',
    where: "deleteMember 去掉「删最后一个成员时把前一个逗号也删掉」",
    reds: "④ 删最后一个键 → 留下 {\"a\":1,} 的尾逗号",
  },
  {
    name: "解析失败当成空",
    file: "src/server/edit-json.mjs",
    from: "  const tree = parseTree(text);\n  if (!tree.ok) return { ok: false, error: tree.error, line: tree.line, column: tree.column };\n  return { ok: true, value: tree.root.value };",
    to: "  const tree = parseTree(text);\n  if (!tree.ok) return { ok: true, value: {} };\n  return { ok: true, value: tree.root.value };",
    where: "parseJsonc 把解析失败当成空对象",
    reds: "★ ① 非法 JSON 必须报失败，且绝不能返回 {}",
  },
  {
    name: "不再保持 CRLF",
    file: "src/server/edit-json.mjs",
    from: '  if (n === 0 || countOf(orig, "\\r\\n") !== n) return out;',
    to: "  if (true) return out;",
    where: "keepCRLF 直接返回，CRLF 文件被改成 LF",
    reds: "★ ⑤ CRLF 保持，且新插入的行也是 CRLF",
  },
  {
    name: "新键插到开头",
    file: "src/server/edit-json.mjs",
    from: "  const ip = insertionPoint(text, obj);",
    to: "  const ip = { at: obj.start + 1, hasComma: obj.members.length > 0, empty: !obj.members.length };",
    where: "insertKey 改成插到对象开头",
    reds: "③ 加新键 → 插到对象末尾，缩进与原风格一致（键序会变）",
  },
];

/* 执行器用的两个钩子：
 *   --sabotage        给人看的手法表
 *   --sabotage-json   机器读的手法表（执行器用这个） */
if (process.argv.includes("--sabotage-json")) {
  console.log(JSON.stringify(SABOTAGE, null, 2));
  process.exit(0);
}
if (process.argv.includes("--sabotage")) {
  console.log(`edit-json 反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）：`);
  for (const s of SABOTAGE) {
    console.log(`  ${s.name.padEnd(24)} ${s.where}`);
    console.log(`  ${"".padEnd(24)} → 会打红: ${s.reds}`);
  }
  const only = process.argv[process.argv.indexOf("--sabotage") + 1];
  if (only && !only.startsWith("--")) {
    const s = SABOTAGE.find((x) => x.name === only);
    if (!s) { console.error(`没有这条手法：${only}`); process.exit(2); }
    console.log(JSON.stringify(s, null, 2));
  }
  process.exit(0);
}
