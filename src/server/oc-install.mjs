/* oc-install.mjs —— OpenCode CLI 的**一键安装**（2026-10-17）。
 *
 * ## 这个文件解决什么
 *
 * 「OpenCode 客户端中转」要求本机有一个 opencode **命令行版（1.x）**。新机器的实际
 * 情况通常是：装了 OpenCode 桌面版，但没有命令行版；而桌面版自带的 CLI 是 2.x 线，
 * 与本桥不兼容（实测：无 `--pure` 参数、API 换代、/api/* 需要它自己的鉴权）。
 * 用户要的是「装好路由台就能一键用」。
 *
 * ## 原则修订说明（重要，别把它改回去）
 *
 * oc-runtime / oc-wiring 的旧文案写着「本产品不会替你下载」——那条纪律防的是
 * **猜一种装法硬装下去**（猜错 = 用户以为装好了，其实只是换了个坏路径）。
 * 本文件不是猜：来源固定（npm 官方 registry 的平台包）、版本固定（下面这个常量，
 * 是完整验证过的那种）、下载后**先做 sha512 校验再落盘**、落点是官方安装脚本
 * 自己的位置（`~/.opencode/bin/opencode.exe`，oc-runtime 的发现逻辑本来就会找它）。
 * 而且**只有用户点了面板上的「一键安装」按钮才会走到这里**——没有任何自动触发路径。
 * 所以文案改成了「只在你点击时下载，除此之外不自动下载」。
 *
 * ## 纪律
 *
 * - 网络与目录全部可注入：测试用假 fetch，**不联网**、不碰真实 HOME。
 * - 校验不过**绝不落盘**（下载物一律丢弃）。
 * - 全程没有任何凭据；日志里不出现路径以外的东西。
 * - 平台固定 Windows（本产品是 Windows 安装包）；其他平台如实报不支持，不硬来。
 *
 * @module server/oc-install
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import zlib from "node:zlib";

/** 安装哪个版本。换版本 = **重新完整验证一条链路**之后再动这里，不许顺手升级。 */
export const OC_CLI_VERSION = "1.19.3";
/** npm 上的平台包名（真身二进制在这一包里；主包 opencode-ai 里只有一个启动器）。 */
export const OC_CLI_PKG = "opencode-windows-x64";
export const OC_CLI_REGISTRY = "https://registry.npmjs.org";
/** 归档里那条目就叫这个名。 */
export const OC_CLI_ENTRY = "package/bin/opencode.exe";
/** 真身约 181MB。小于这个数一律当坏包（防截断 / 防代理塞一个错误页进来）。 */
export const OC_CLI_MIN_BYTES = 50 * 1024 * 1024;

/** 落点：官方安装脚本用过的位置（oc-runtime 的二进制发现逻辑本来就会找这里）。 */
export function ocCliDest(homedir = os.homedir()) {
  return path.join(homedir, ".opencode", "bin", "opencode.exe");
}

/** 元数据端点（npm registry 的版本信息：给 `dist.tarball` 与 `dist.integrity`）。 */
export function metadataUrl() {
  return `${OC_CLI_REGISTRY}/${OC_CLI_PKG}/${OC_CLI_VERSION}`;
}

/**
 * sha512 完整性校验。`integrity` 形如 `sha512-<base64>`（npm 的标准形状）。
 * 拿不到合格的 integrity 值时**返回 false**——宁可不装，也不装一个没校验的东西。
 */
export function verifyIntegrity(buf, integrity) {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(String(integrity || ""));
  if (!m) return false;
  const got = createHash("sha512").update(buf).digest("base64");
  return got === m[1];
}

/**
 * 从 tar.gz 里按名字取出一个条目，返回它的字节（subarray 视图，不再复制一份 181MB）。
 *
 * 只实现我们真用到的那一小块 tar 读法（ustar 头、八进制 size、512 对齐、全零块结束）；
 * 够取 `package/bin/opencode.exe`（短名字，不会出现 GNU LongLink）。找不到回 null。
 *
 * @param {Buffer} gz .tgz 原文
 * @param {string} entryName 例如 `package/bin/opencode.exe`
 * @returns {Buffer|null}
 */
export function extractFromTarGz(gz, entryName) {
  const tar = zlib.gunzipSync(gz);
  let pos = 0;
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) if (header[i] !== 0) { allZero = false; break; }
    if (allZero) break;   // 两个全零块 = 归档结束
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").replace(/^\.\//, "");
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8) || 0;
    const dataStart = pos + 512;
    if (name === entryName) {
      if (dataStart + size > tar.length) return null;   // 头说的大小超出实际 = 坏归档
      return tar.subarray(dataStart, dataStart + size);
    }
    pos = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * 一键安装。按顺序：元数据 → 下载 tarball → sha512 校验 → 解包 → 落盘。
 *
 * 任何一步失败都**不落盘**并带具名 `reason` 返回（调用方原样报给用户，不反推）。
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] 注入的 fetch（测试用；默认全局 fetch）
 * @param {string} [opts.homedir] 测试注入
 * @param {string} [opts.dest] 覆盖落点（测试用）
 * @param {string} [opts.platform] 测试注入（默认 process.platform）
 * @param {number} [opts.timeoutMs] 下载超时（默认 600 秒）
 * @param {number} [opts.minBytes] 测试注入；默认 OC_CLI_MIN_BYTES
 * @param {Function} [opts.log] 日志口（默认静默）
 * @returns {Promise<{ok:true,path:string,bytes:number,version:string}
 *                   |{ok:false,reason:string,message:string}>}
 */
export async function installOpenCodeCli(opts = {}) {
  const {
    fetchImpl = typeof fetch === "function" ? fetch : null,
    homedir = os.homedir(),
    dest = ocCliDest(homedir),
    platform = process.platform,
    timeoutMs = 600_000,
    minBytes = OC_CLI_MIN_BYTES,
    log = () => {},
  } = opts;

  if (platform !== "win32") {
    return { ok: false, reason: "unsupported-platform", message: `一键安装目前只支持 Windows（当前平台：${platform}）` };
  }
  if (!fetchImpl) return { ok: false, reason: "no-fetch", message: "运行环境没有可用的 fetch" };

  /* ① 元数据。拿不到 tarball URL 或 integrity 就不继续——没有校验值的下载一律不装。 */
  let meta = null;
  try {
    const r = await fetchImpl(metadataUrl(), { signal: AbortSignal.timeout(30_000) });
    if (!r || !r.ok) return { ok: false, reason: "metadata-failed", message: `registry 元数据 HTTP ${(r && r.status) || "?"}` };
    meta = await r.json();
  } catch (e) {
    return { ok: false, reason: "metadata-failed", message: String((e && e.message) || e).slice(0, 200) };
  }
  const url = meta && meta.dist && meta.dist.tarball;
  const integrity = meta && meta.dist && meta.dist.integrity;
  if (typeof url !== "string" || !/^https:\/\//.test(url)) {
    return { ok: false, reason: "metadata-failed", message: "元数据里没有合格的 tarball URL" };
  }
  if (typeof integrity !== "string" || !integrity) {
    return { ok: false, reason: "metadata-failed", message: "元数据里没有 integrity——拿不到校验值就不下载" };
  }
  if (meta && meta.name && meta.name !== OC_CLI_PKG) {
    return { ok: false, reason: "metadata-failed", message: `元数据包名不符：${String(meta.name).slice(0, 60)}` };
  }

  /* ② 下载（约 60MB 压缩包）。 */
  log(`OpenCode 一键安装：下载 ${url}`);
  let gz = null;
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r || !r.ok) return { ok: false, reason: "download-failed", message: `tarball HTTP ${(r && r.status) || "?"}` };
    gz = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    return { ok: false, reason: "download-failed", message: String((e && e.message) || e).slice(0, 200) };
  }

  /* ③ 先校验再谈落盘。不通过 = 直接扔，不写任何文件。 */
  if (!verifyIntegrity(gz, integrity)) {
    return { ok: false, reason: "integrity-mismatch", message: "sha512 校验不通过（下载可能被代理/网络篡改或截断），已丢弃、未落盘" };
  }

  /* ④ 解包 + sanity。 */
  let exe = null;
  try {
    exe = extractFromTarGz(gz, OC_CLI_ENTRY);
  } catch (e) {
    return { ok: false, reason: "extract-failed", message: `解包失败：${String((e && e.message) || e).slice(0, 160)}` };
  }
  if (!exe || !exe.length) return { ok: false, reason: "entry-missing", message: `归档里没有 ${OC_CLI_ENTRY}` };
  if (exe.length < minBytes) {
    return { ok: false, reason: "entry-suspicious", message: `解出的二进制只有 ${exe.length} 字节（< ${minBytes}），拒绝落盘` };
  }
  if (!(exe[0] === 0x4d && exe[1] === 0x5a)) {
    return { ok: false, reason: "entry-suspicious", message: "解出的文件没有 PE 的 MZ 头——不是可执行文件，拒绝落盘" };
  }

  /* ⑤ 写盘：先写 .part 再改名（改名即生效，避免半截文件被当成装好的二进制找到）。 */
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part-${process.pid}`;
    fs.writeFileSync(tmp, exe);
    fs.renameSync(tmp, dest);
  } catch (e) {
    return {
      ok: false, reason: "write-failed",
      message: `写盘失败：${String((e && e.message) || e).slice(0, 160)}（若该路径下已有 opencode 正在运行，先关掉再试）`,
    };
  }
  log(`OpenCode 一键安装：完成 ${dest}（${exe.length} 字节，sha512 通过）`);
  return { ok: true, path: dest, bytes: exe.length, version: OC_CLI_VERSION };
}
