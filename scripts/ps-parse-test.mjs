/* 发布的 .ps1 脚本必须**真的能解析**。
 *
 * 起因（2026-10-21 实测）：`scripts/upgrade.ps1` 第 19 行多了一个右括号
 * （4 个左对 5 个右）。于是**README 里那条「一行命令救砖」从来没跑通过**——
 * 而那恰恰是「内置更新器坏了、面板也开不了」时用户唯一的救命稻草。
 * 一个自己都跑不起来的救援脚本，等于没有。
 *
 * 这条测试守两件事：
 *   ① **括号配平**（纯 JS，任何平台都能跑，CI 也跑得到）
 *   ② **含非 ASCII 的脚本必须有 UTF-8 BOM** —— Windows PowerShell 5.1 从磁盘读
 *      .ps1 时，没 BOM 就按系统 ANSI 代码页读（本机是 GBK/936）。UTF-8 里一个
 *      中文字 3 字节、第三个字节落在 GBK 的前导字节区；当中文字紧挨着收尾引号时
 *      （`明"`），那个引号会被当成续字节吃掉，字符串失去闭合 → 语法错。
 *      有 BOM 时 5.1 才会按 UTF-8 解。
 *      ⚠ BOM 也让「从磁盘跑」这条路恢复正常——之前两条路都坏，只是坏法不同。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = ["scripts/upgrade.ps1", "scripts/rollback.ps1"];

/**
 * 剥掉字符串与注释后，检查括号是否配平。
 * 认得 PowerShell 的三种字符串：'...'（'' 转义）、"..."（` 与 "" 转义）、
 * 以及 here-string @"..."@ / @'...'@。
 */
export function bracketBalance(src) {
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    /* here-string：@" 换行 ... "@ */
    if ((c === "@" && (src[i + 1] === '"' || src[i + 1] === "'"))) {
      const q = src[i + 1];
      const close = q + "@";
      const end = src.indexOf(close, i + 2);
      if (end < 0) return { ok: false, why: "here-string 没有闭合" };
      i = end + 2;
      continue;
    }
    if (c === "#") {                       // 注释到行尾
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "'") {                       // 单引号字符串（'' 转义）
      i++;
      while (i < n) {
        if (src[i] === "'" && src[i + 1] === "'") { i += 2; continue; }
        if (src[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '"') {                       // 双引号字符串（` 与 "" 转义）
      i++;
      while (i < n) {
        if (src[i] === "`") { i += 2; continue; }
        if (src[i] === '"' && src[i + 1] === '"') { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") { stack.push({ c, at: i }); i++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (!top) return { ok: false, why: `第 ${lineOf(src, i)} 行多了个收尾的 ${c}` };
      if (top.c !== pairs[c]) {
        return { ok: false, why: `第 ${lineOf(src, i)} 行的 ${c} 与第 ${lineOf(src, top.at)} 行的 ${top.c} 不配对` };
      }
      i++;
      continue;
    }
    i++;
  }
  if (stack.length) {
    const t = stack[stack.length - 1];
    return { ok: false, why: `第 ${lineOf(src, t.at)} 行的 ${t.c} 没有闭合` };
  }
  return { ok: true };
}
function lineOf(src, at) { return src.slice(0, at).split("\n").length; }

describe("发布的 .ps1 脚本", () => {
  for (const rel of SCRIPTS) {
    test(`${rel} 括号配平`, () => {
      const raw = fs.readFileSync(path.join(ROOT, rel));
      const src = raw.toString("utf8").replace(/^﻿/, "");
      const r = bracketBalance(src);
      assert.ok(r.ok, `${rel} 括号不配平：${r.why}`);
    });

    test(`${rel} 含非 ASCII 时必须有 UTF-8 BOM`, () => {
      const raw = fs.readFileSync(path.join(ROOT, rel));
      const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
      const body = raw.toString("utf8").replace(/^﻿/, "");
      const nonAscii = /[^\x00-\x7F]/.test(body);
      if (nonAscii) {
        assert.ok(hasBom,
          `${rel} 含中文但没有 UTF-8 BOM —— Windows PowerShell 5.1 会按系统 ANSI 代码页读它，`
          + `中文字紧挨收尾引号时那个引号会被吃掉，脚本直接语法错。`);
      }
    });
  }

  test("有 PowerShell 时，真解析一遍（最权威的判据）", () => {
    if (process.platform !== "win32") { return; }   // CI 跑在 ubuntu 上，跳过
    for (const rel of SCRIPTS) {
      const abs = path.join(ROOT, rel);
      const ps = `
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$err=$null
[void][System.Management.Automation.Language.Parser]::ParseFile('${abs.replace(/'/g, "''")}',[ref]$null,[ref]$err)
if($err -and $err.Count -gt 0){ $err | Select-Object -First 3 | ForEach-Object { Write-Host ('行 ' + $_.Extent.StartLineNumber + ': ' + $_.Message) }; exit 1 }
exit 0
`;
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { encoding: "utf8", timeout: 60000 });
      assert.equal(r.status, 0, `${rel} 解析失败：\n${r.stdout || ""}${r.stderr || ""}`);
    }
  });
});
