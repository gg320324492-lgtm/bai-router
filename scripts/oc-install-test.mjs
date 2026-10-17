/**
 * scripts/oc-install-test.mjs —— 「一键安装 OpenCode CLI」（2026-10-17）
 *
 * 测什么：
 *   ① tar.gz 提取：从**合成**归档里按名字取条目；条目不存在 / 头声明的长度超出实际 都要如实失败
 *   ② sha512 完整性校验：对的过、错一个字节的拒、畸形值（md5-、空）一律拒
 *   ③ 编排：用**假 fetch** 跑通「元数据 → 下载 → 校验 → 解包 → 落盘」全链
 *   ④ 纪律：缺 integrity 就**不下载**；校验不过**不落盘**；解出的东西不像二进制**不落盘**；
 *      非 Windows 直接拒；落点只允许在 ~/.opencode/bin 下（路径由 ocCliDest 钉死）
 *
 * 红线：本套件**绝不联网**（所有请求都走假 fetch）、不碰真实 HOME（homedir/dest 全部注入临时目录）、
 *       不含任何真实令牌。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";

import {
  OC_CLI_VERSION, OC_CLI_PKG, OC_CLI_ENTRY, OC_CLI_MIN_BYTES,
  ocCliDest, metadataUrl, verifyIntegrity, extractFromTarGz, installOpenCodeCli,
} from "../src/server/oc-install.mjs";

const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-oc-install-"));
process.on("exit", () => { try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* ------------------------------------------------------------------ *
 * 合成 tar.gz（只构造我们解析器认识的那一小块 tar 写法）
 * ------------------------------------------------------------------ */
function tarHeader(name, size) {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "utf8");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");   // 八进制 size，12 字节
  h.write("0", 156, 1, "ascii");                                         // typeflag '0'
  h.write("ustar\0", 257, 6, "ascii");
  return h;
}
function tarGz(entries) {
  const parts = [];
  for (const [name, buf] of entries) {
    parts.push(tarHeader(name, buf.length), buf);
    const pad = (512 - (buf.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));   // 两个全零块 = 归档结束
  return zlib.gzipSync(Buffer.concat(parts));
}
/** 看着像真二进制的最小内容：MZ 头 + 指定字节数的填充。 */
function fakeExe(bytes) {
  const b = Buffer.alloc(bytes, 0x41);
  b[0] = 0x4d; b[1] = 0x5a;   // "MZ"
  return b;
}
function sha512Integrity(buf) {
  return "sha512-" + createHash("sha512").update(buf).digest("base64");
}

/** 假 fetch：按 URL 分流「元数据」与「tarball」，并把调用记录在案。 */
function fakeFetch({ gz, integrity, tarball = "https://registry.npmjs.org/opencode-windows-x64/-/opencode-windows-x64-1.19.3.tgz", metaName = OC_CLI_PKG }) {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://registry.npmjs.org/") && String(url).endsWith(`/${OC_CLI_VERSION}`)) {
      return {
        ok: true, status: 200,
        json: async () => ({ name: metaName, version: OC_CLI_VERSION, dist: { tarball, integrity } }),
      };
    }
    return { ok: true, status: 200, arrayBuffer: async () => gz };
  };
  return { f, calls };
}

/* ================================================================== *
 * ① tar.gz 提取
 * ================================================================== */
describe("① tar.gz 提取：按名字取条目", () => {
  test("取得到：内容逐字节一致；无关条目（含目录项）被跳过", () => {
    const exe = fakeExe(700);   // 跨过 512 边界，验证按 size 推进
    const gz = tarGz([
      ["package/package.json", Buffer.from('{"name":"x"}', "utf8")],
      [OC_CLI_ENTRY, exe],
      ["package/README.md", Buffer.from("hello", "utf8")],
    ]);
    const got = extractFromTarGz(gz, OC_CLI_ENTRY);
    assert.ok(got, "必须能取到条目");
    assert.equal(Buffer.compare(Buffer.from(got), exe), 0, "取出的内容必须逐字节一致");
  });

  test("没有这个条目 → null（反向对照：别把 SELECT 逻辑写成恒真）", () => {
    const gz = tarGz([["package/package.json", Buffer.from("{}", "utf8")]]);
    assert.equal(extractFromTarGz(gz, OC_CLI_ENTRY), null);
  });

  test("头里声明的长度超出实际内容 → null（防把坏归档当成功）", () => {
    const real = fakeExe(100);
    const gz = tarGz([[OC_CLI_ENTRY, real]]);
    /* 手工把头里的 size 改大：重新拼一份、只改头。 */
    const tar = zlib.gunzipSync(gz);
    tar.write((100000).toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    assert.equal(extractFromTarGz(zlib.gzipSync(tar), OC_CLI_ENTRY), null);
  });
});

/* ================================================================== *
 * ② sha512 完整性
 * ================================================================== */
describe("② sha512 校验：宁可不装，也不装没校验的东西", () => {
  const buf = fakeExe(64);

  test("对的过；改一个字节就拒；畸形值一律拒", () => {
    assert.equal(verifyIntegrity(buf, sha512Integrity(buf)), true, "正确摘要必须通过");

    const tampered = Buffer.from(buf); tampered[10] ^= 0xff;
    assert.equal(verifyIntegrity(tampered, sha512Integrity(buf)), false, "改过内容必须拒");

    for (const bad of ["", null, undefined, "md5-AAAA", "sha512-", "sha1-AAAA"]) {
      assert.equal(verifyIntegrity(buf, bad), false, `畸形 integrity ${JSON.stringify(bad)} 必须拒`);
    }
  });
});

/* ================================================================== *
 * ③ 编排：假 fetch 全链
 * ================================================================== */
describe("③ 编排：元数据 → 下载 → 校验 → 解包 → 落盘", () => {
  const exe = fakeExe(4096);

  test("成功：文件落盘且内容一致；请求顺序 = 先元数据后 tarball", async () => {
    const gz = tarGz([[OC_CLI_ENTRY, exe]]);
    const { f, calls } = fakeFetch({ gz, integrity: sha512Integrity(gz) });
    const dest = path.join(TMPROOT, "ok", ".opencode", "bin", "opencode.exe");
    const r = await installOpenCodeCli({ fetchImpl: f, dest, minBytes: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.path, dest);
    assert.equal(r.version, OC_CLI_VERSION);
    assert.equal(Buffer.compare(readFileSync(dest), exe), 0, "落盘的必须就是解出来的那 4096 字节");
    assert.equal(calls.length, 2, "只该发两次请求");
    assert.match(calls[0], /registry\.npmjs\.org/, "第一次必须是元数据");
  });

  test("校验不过 → 拒装且**不落盘**（反向对照：把 integrity 换成别的摘要）", async () => {
    const gz = tarGz([[OC_CLI_ENTRY, exe]]);
    const other = Buffer.from("别的字节");
    const { f } = fakeFetch({ gz, integrity: sha512Integrity(other) });
    const dest = path.join(TMPROOT, "mismatch", "opencode.exe");
    const r = await installOpenCodeCli({ fetchImpl: f, dest, minBytes: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "integrity-mismatch");
    assert.equal(existsSync(dest), false, "★ 校验不过必须一个字节都不落盘");
  });

  test("元数据没有 integrity → 拒装，而且**连下载都不发起**", async () => {
    const gz = tarGz([[OC_CLI_ENTRY, exe]]);
    const { f, calls } = fakeFetch({ gz, integrity: undefined });
    const dest = path.join(TMPROOT, "no-int", "opencode.exe");
    const r = await installOpenCodeCli({ fetchImpl: f, dest, minBytes: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "metadata-failed");
    assert.equal(calls.length, 1, "★ 拿不到校验值就不下载：只允许元数据那一次请求");
    assert.equal(existsSync(dest), false);
  });

  test("归档里没有那个条目 / 文件太小 / 没有 MZ 头 → 三种具名拒绝，均不落盘", async () => {
    // 条目缺失
    let gz = tarGz([["package/package.json", Buffer.from("{}", "utf8")]]);
    let r = await installOpenCodeCli({ fetchImpl: fakeFetch({ gz, integrity: sha512Integrity(gz) }).f, dest: path.join(TMPROOT, "a", "opencode.exe"), minBytes: 2 });
    assert.equal(r.ok, false); assert.equal(r.reason, "entry-missing");

    // 太小
    gz = tarGz([[OC_CLI_ENTRY, fakeExe(100)]]);
    r = await installOpenCodeCli({ fetchImpl: fakeFetch({ gz, integrity: sha512Integrity(gz) }).f, dest: path.join(TMPROOT, "b", "opencode.exe"), minBytes: 4096 });
    assert.equal(r.ok, false); assert.equal(r.reason, "entry-suspicious");

    // 不是 PE
    const notExe = Buffer.alloc(4096, 0x58);   // "XXXX…"，没有 MZ
    gz = tarGz([[OC_CLI_ENTRY, notExe]]);
    r = await installOpenCodeCli({ fetchImpl: fakeFetch({ gz, integrity: sha512Integrity(gz) }).f, dest: path.join(TMPROOT, "c", "opencode.exe"), minBytes: 2 });
    assert.equal(r.ok, false); assert.equal(r.reason, "entry-suspicious");

    assert.equal(existsSync(path.join(TMPROOT, "a")), false);
    assert.equal(existsSync(path.join(TMPROOT, "b")), false);
    assert.equal(existsSync(path.join(TMPROOT, "c")), false);
  });

  test("非 Windows → 直接拒，且一次请求都不发", async () => {
    const { f, calls } = fakeFetch({ gz: Buffer.alloc(0), integrity: "sha512-AAAA" });
    const r = await installOpenCodeCli({ fetchImpl: f, dest: path.join(TMPROOT, "x", "opencode.exe"), platform: "linux" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unsupported-platform");
    assert.equal(calls.length, 0);
  });
});

/* ================================================================== *
 * ④ 路径与版本纪律
 * ================================================================== */
describe("④ 路径与版本纪律", () => {
  test("落点只允许在 ~/.opencode/bin/opencode.exe 下（与 oc-runtime 的发现路径对齐）", () => {
    assert.equal(ocCliDest("C:\\fake-home"), path.join("C:\\fake-home", ".opencode", "bin", "opencode.exe"));
  });

  test("元数据 URL 指向 npm 官方 registry 的这个包与版本", () => {
    assert.equal(metadataUrl(), `https://registry.npmjs.org/${OC_CLI_PKG}/${OC_CLI_VERSION}`);
  });

  test("条目标名与最小体积常量没被顺手改掉（换版本 = 重新完整验证一条链路，不是改个数字）", () => {
    assert.equal(OC_CLI_ENTRY, "package/bin/opencode.exe");
    assert.equal(OC_CLI_MIN_BYTES, 50 * 1024 * 1024);
    assert.equal(OC_CLI_VERSION, "1.19.3", "换版本前先跑通 npm run test:oc-e2e 的真机端到端");
  });
});
