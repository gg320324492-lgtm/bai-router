/* 救砖脚本的**校验**必须真的在校验。
 *
 * 起因（2026-10-22 实测）：两个救砖脚本原来都这么写——
 *
 *     $want512 = (Invoke-RestMethod $ymlUrl -UseBasicParsing).Content |
 *                Select-String -Pattern 'sha512:\s*(.+)' | ...
 *
 * `Invoke-RestMethod` 对 .yml 这类文本响应返回的是 **System.String**，
 * **不是**带 .Content 的响应对象 —— 字符串没有 Content 属性，于是它是 $null；
 * 后面 `if ($want512)` 恒假 → **sha512 校验从头到尾没跑过一次**。
 * 脚本头部却写着「校验 sha512」—— 一段看着像在校验、实际是装饰的代码。
 *
 * 签名校验（Authenticode）是真的，所以不至于毫无防护；但哈希这一层是空的。
 *
 * 这条测试守三件事：
 *   ① 解析函数从 yml 里取到的**必须是安装包那个** sha512
 *      （yml 里有**两个**：files: 下缩进那个可能属于 blockmap，顶格那个才是安装包）
 *   ② 两处不一致时**必须拒绝**（清单与产物对不上，宁可不装）
 *   ③ 反向对照：用本地 HTTP 服务把「旧的 .Content 写法恒为 null」这条钉死，
 *      免得哪天又改回那个写法而没人发现
 *
 * 脚本里那几个函数被 `if (-not $env:BAI_ROUTER_PS_LIB)` 包着，
 * 所以测试可以只加载函数、不跑主流程（主流程会联网、会 Read-Host）。
 *
 * ⚠ 两个实现细节（都是踩过的坑，改之前先读）：
 *   · 必须用**异步** spawn：同步 spawnSync 会阻塞事件循环，同进程的本地 HTTP
 *     服务根本没机会应答 → 请求挂到超时，看起来像「PowerShell 不会发本地请求」。
 *   · 必须让 PowerShell 绕过系统代理：本机开着 Clash，WinINET 的默认代理会把
 *     127.0.0.1 也发给代理，代理连不到本机 → 同样表现为超时。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = ["scripts/upgrade.ps1", "scripts/rollback.ps1"];

const EXE = "BARRouter-Setup-1.0.93-beta.1.exe";
const EXE_HASH = "lg0Fpgmj0LwoB+9QOmE2lv36t0UgnEadT3bhytSqGvFYHeYM4wd3DRBN+HLa+IpsaLlZQOOeGSQUJADL92Ar0g==";
const BM_HASH = "ZZZZbogusZZZZbogusZZZZbogusZZZZbogusZZZZbogusZZZZbogusZZZZbogusZZZZbogusZZZZbog==";

/* 真实 yml 的形状（照 v1.0.93-beta.1 的 beta.yml 裁剪，releaseNotes 去掉）。 */
const YML_NORMAL = [
  "version: 1.0.93-beta.1",
  "files:",
  `  - url: ${EXE}`,
  `    sha512: ${EXE_HASH}`,
  "    size: 111579216",
  `path: ${EXE}`,
  `sha512: ${EXE_HASH}`,
  "releaseDate: '2026-10-21T20:38:22.441Z'",
  "",
].join("\n");

/* blockmap 排在 exe **前面** —— 只抓「第一个 sha512」的实现会抓错。 */
const YML_BLOCKMAP_FIRST = [
  "version: 1.0.93-beta.1",
  "files:",
  `  - url: ${EXE}.blockmap`,
  `    sha512: ${BM_HASH}`,
  "    size: 222",
  `  - url: ${EXE}`,
  `    sha512: ${EXE_HASH}`,
  "    size: 111579216",
  `path: ${EXE}`,
  `sha512: ${EXE_HASH}`,
  "",
].join("\n");

/* 顶格与 files 项不一致 —— 清单和产物对不上，必须拒绝安装。 */
const YML_MISMATCH = [
  "version: 1.0.93-beta.1",
  "files:",
  `  - url: ${EXE}`,
  `    sha512: ${BM_HASH}`,
  "    size: 111579216",
  `path: ${EXE}`,
  `sha512: ${EXE_HASH}`,
  "",
].join("\n");

/* 起一个本地 HTTP 服务，把 yml 按 text/plain 发出去 —— 复现 GitHub 的行为。 */
let server = null;
let port = 0;
before(async () => {
  server = http.createServer((req, res) => {
    const body = Buffer.from(YML_NORMAL, "utf8");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
after(() => { if (server) server.close(); });

/**
 * 加载脚本（只定义函数）并跑一段 PowerShell 表达式。
 * 返回 { status, stdout, stderr }。
 */
function ps(scriptRel, body) {
  const abs = path.join(ROOT, scriptRel).replace(/'/g, "''");
  const code = `
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
[System.Net.WebRequest]::DefaultWebProxy = $null
$env:BAI_ROUTER_PS_LIB='1'
. '${abs}'
${body}
`;
  return new Promise((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", code]);
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { p.kill(); resolve({ status: null, stdout, stderr: stdout + stderr, timedOut: true }); }, 30000);
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    p.on("error", (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: stdout + stderr + String(e) }); });
  });
}

/* 把一段 yml 文本写进临时文件，让 PowerShell 读文件 —— 避免命令行里的引号/换行地狱。
 * ⚠ 必须 await fn(f)：否则 finally 会在 PowerShell 真正去读文件之前就把它删了。 */
async function withFixture(text, fn) {
  const f = path.join(os.tmpdir(), `bai-yml-${process.pid}-${Math.random().toString(36).slice(2)}.yml`);
  fs.writeFileSync(f, text, "utf8");
  try { return await fn(f); } finally { try { fs.unlinkSync(f); } catch { } }
}

const hasPwsh = process.platform === "win32";

describe("救砖脚本的 sha512 校验", () => {
  for (const rel of SCRIPTS) {
    test(`${rel} 装错的那条路径不会跑主流程`, { skip: !hasPwsh }, async () => {
      /* 只 dot-source。不设 BAI_ROUTER_PS_LIB 的话主流程会去联网 + Read-Host，
       * 在测试里会挂住。所以这里必须能「静默加载完就返回」。 */
      const r = await ps(rel, "Write-Host 'LOADED'");
      assert.equal(r.status, 0, `加载失败：${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /LOADED/, "脚本没有正常加载");
    });

    test(`${rel} 从 yml 里取的是安装包的 sha512`, { skip: !hasPwsh }, async () => {
      await withFixture(YML_NORMAL, async (f) => {
        const q = f.replace(/'/g, "''");
        const r = await ps(rel, `Write-Host ('HASH=' + (Get-InstallerSha512 ([IO.File]::ReadAllText('${q}')) '${EXE}'))`);
        assert.equal(r.status, 0, `执行失败：${r.stdout}${r.stderr}`);
        assert.match(r.stdout, /HASH=lg0Fpgmj0Lwo/,
          `取到的不是安装包的 sha512：${r.stdout}${r.stderr}`);
      });
    });

    test(`${rel} blockmap 排在前面时也不会取错`, { skip: !hasPwsh }, async () => {
      await withFixture(YML_BLOCKMAP_FIRST, async (f) => {
        const q = f.replace(/'/g, "''");
        const r = await ps(rel, `Write-Host ('HASH=' + (Get-InstallerSha512 ([IO.File]::ReadAllText('${q}')) '${EXE}'))`);
        assert.equal(r.status, 0, `执行失败：${r.stdout}${r.stderr}`);
        assert.match(r.stdout, /HASH=lg0Fpgmj0Lwo/, `取成了 blockmap 的哈希：${r.stdout}${r.stderr}`);
        assert.doesNotMatch(r.stdout, /HASH=ZZZZ/, "取成了 blockmap 的哈希");
      });
    });

    test(`${rel} 两处 sha512 不一致时拒绝安装`, { skip: !hasPwsh }, async () => {
      await withFixture(YML_MISMATCH, async (f) => {
        const q = f.replace(/'/g, "''");
        const r = await ps(rel, `Get-InstallerSha512 ([IO.File]::ReadAllText('${q}')) '${EXE}'`);
        assert.notEqual(r.status, 0, "两处不一致居然通过了——那等于没校验");
        assert.match(r.stdout + r.stderr, /不一致/, "报错信息要说明是不一致");
      });
    });

    test(`${rel} 能真的取到远端 yml 的哈希（端到端）`, { skip: !hasPwsh }, async () => {
      const url = `http://127.0.0.1:${port}/beta.yml`;
      const r = await ps(rel, `
$t = Get-RemoteText '${url}'
$h = Get-InstallerSha512 $t '${EXE}'
Write-Host ('LEN=' + $t.Length)
Write-Host ('HASH=' + $h)
`);
      assert.equal(r.status, 0, `执行失败：${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /LEN=\d{3,}/, `没取到 yml 正文：${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /HASH=lg0Fpgmj0Lwo/, `端到端取到的哈希不对：${r.stdout}${r.stderr}`);
    });
  }

  test("★ 反向对照：旧的 `.Content` 写法恒为 null（所以旧校验从没跑过）", { skip: !hasPwsh }, async () => {
    /* 本地 HTTP 服务按 text/plain 发 yml —— 与 GitHub 的行为一致。
     * 若哪天 GitHub 改了 Content-Type，这条会提示要重新核对（那时旧写法可能又能用了）。 */
    const url = `http://127.0.0.1:${port}/beta.yml`;
    const r = await ps("scripts/upgrade.ps1", `
$x = Invoke-RestMethod '${url}' -UseBasicParsing
Write-Host ('TYPE=' + $x.GetType().Name)
Write-Host ('CONTENT_IS_NULL=' + ($null -eq $x.Content))
$m = Select-String -InputObject $x.Content -Pattern 'sha512:\\s*(.+)' -AllMatches
Write-Host ('MATCH_IS_NULL=' + ($null -eq $m))
`);
    assert.equal(r.status, 0, `执行失败：${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /TYPE=String/, `预期返回字符串，实际：${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /CONTENT_IS_NULL=True/,
      `Invoke-RestMethod 对 .yml 返回的对象居然有 Content —— 旧写法可能又能用了，需重新核对：${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /MATCH_IS_NULL=True/,
      "旧写法居然能取到 sha512 —— 那旧校验就不是装饰，请重新评估这条断言");
  });

  test("两个脚本的校验函数必须一致（改一个不改另一个就会漂移）", { skip: !hasPwsh }, async () => {
    const outs = [];
    for (const rel of SCRIPTS) {
      const r = await ps(rel, `
$t = @'
${YML_NORMAL}
'@
Write-Host ('HASH=' + (Get-InstallerSha512 $t '${EXE}'))
`);
      assert.equal(r.status, 0, `${rel} 执行失败：${r.stdout}${r.stderr}`);
      const m = r.stdout.match(/HASH=(\S+)/);
      assert.ok(m, `${rel} 没输出 HASH：${r.stdout}${r.stderr}`);
      outs.push(m[1]);
    }
    assert.equal(outs[0], outs[1], "两个脚本的解析结果不同");
    assert.equal(outs[0], EXE_HASH);
  });
});
