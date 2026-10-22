/**
 * sync-targets.mjs —— 同步目标的 IO 适配器（本地目录 / WebDAV / GitHub）
 * （纯逻辑：IO 全部由调用方注入，本模块自己不碰网络、不碰磁盘、不取时钟）
 *
 * ## 它补的是哪个洞
 *
 * sync.mjs 把「同步策略」写完了：合并、冲突、幂等、面板上那句话，全都齐了。
 * 但它**一个字节也送不出去**——它只定义了目标适配器的*接口*，
 * 真正读远端、写远端的三个实现**至今不存在**。
 * 于是「配置能同步」这件事在仓库里仍只是纸面上的：面板上没有 WebDAV 地址可填，
 * 也没有任何一行代码会把 config.json 推到用户自己控制的远端去。
 *
 * 本模块补的正是缺的那一半：**三个目标的 IO 适配器**。
 * 策略归 sync.mjs，本模块只管「怎么把这份字节放到远端去、
 * 怎么确认放的时候没把别人的更新盖掉」。
 *
 * ## 对标 magpie 的哪个文件
 *
 *   yetone/magpie  internal/davsync/dav.go     —— WebDAV 的读/条件写（ETag、PROPFIND、If-Match）
 *   yetone/magpie  internal/davsync/github.go  —— GitHub 目标（Contents API + blob SHA）
 *   yetone/magpie  internal/davsync/s3.go      —— 「盲写」那一路（本地目录与它同形）
 *   yetone/magpie  docs/subsystems/sync-backup.md —— 契约：远端接口、条件写被拒后重走合并
 *
 * 照抄的语义：
 *   · **远端接口只有三个动作**：读、写、问状态。magpie 的 remote 接口（dav.go:104-112）
 *     也是这三件事（get / put / version）。本模块三个适配器就是这三件事。
 *   · **写之前必须问状态，写的时候必须带条件**（magpie 的 remote.put 收 etag 参数）。
 *     条件不满足是「别的机器抢先写过了」，**不是**「写失败了」——两者的处置完全相反，
 *     所以错误码必须分开（sync.mjs 的 REMOTE_CHANGED_CODES）。
 *   · **ETag 弱匹配那件事照抄 magpie 的教训**（dav.go:262-268、#1362）：
 *     读的时候要 `Accept-Encoding: identity`，否则服务器压缩过的副本会给出另一个 ETag，
 *     之后每一次 If-Match 都会被判成「远端变了」——于是同步永远推不上去。
 *   · **GitHub 用 Contents API + blob SHA，不用 Releases**（github.go 的 commit()）。
 *   · **公开仓库拒绝**（github.go 的 prepare）：公开仓库的提交历史等于把每一版加密备份
 *     摊给所有人慢慢猜口令。
 *
 * ## 与 magpie 有意不同的点（及原因）
 *
 * 1. **IO 全部由调用方注入，本模块一个字节都不自己发。**
 *    magpie 的 davsync 自带 WebDAV/S3/GitHub 三套客户端（dav.go / s3.go / github.go）。
 *    本模块只定义**适配器怎么组装请求、怎么解释回答**，真正的 fetch 与 fs 由调用方给。
 *    理由与 sync.mjs 相同：整条链路能在内存里跑完，测试离线可跑，
 *    「同步策略」与「同步策略的执行」可以分开审。
 *
 * 2. **本地目录也做条件写（客户端比对内容哈希）。**
 *    magpie 的本地/S3 那一路是**盲写**（dav.go 的 version.Blind、s3.go 的 #1776）：
 *    没有服务端版本号，写下去就是覆盖。
 *    本仓库把「写之前必须先问状态」当红线，所以本地目录也先读一遍算哈希再比对。
 *    **这是我们自己的取舍**，而且必须说清它的短处：这是**客户端**比对，
 *    读和写之间仍有一个窗口（TOCTOU），挡不住「同一瞬间并发写」；
 *    挡得住的是「另一台机器刚刚推过」这种常见情况——那正是要挡的那一种。
 *
 * 3. **服务器不给 ETag 时不写，而不是退化成盲写。**
 *    magpie 的 put 只在 etag 非空时才加 If-Match（dav.go:335-338），
 *    没有 ETag 就变成一次盲写。本仓库把 WebDAV 定义成条件写目标
 *    （sync.mjs 的 TARGETS.webdav.conditional = true），
 *    所以服务器不给 ETag 时我们只允许「新建」（If-None-Match: *），
 *    不允许「覆盖已有的文件」。宁可同步失败，也不覆盖别人的更新。
 *
 * 4. **不做 magpie 的「用上次读到的整份好副本重建远端」那条路**（理由同 sync.mjs）：
 *    远端文件坏了由调用方停下并说清楚，本模块不偷偷重建——旧副本可能比远端旧，
 *    偷偷重建会把另一台机器更新的配置顶掉。
 *
 * 5. **只做「读远端 / 写远端 / 问状态」，不做 S3、不做用量文件、不做锁。**
 *    本仓库的用量统计有自己的账本（usage-ledger.mjs），不需要 magpie 那套
 *    「顺带同步用量文件」的通道。
 *
 * ## 三个目标各自的条件写与冲突语义
 *
 *   目标        版本号            写之前问状态      写的时候带什么条件            条件不满足时
 *   ──────────  ────────────────  ────────────────  ───────────────────────────  ──────────────────
 *   本地目录    文件内容的 sha256  读一遍现文件算哈希  客户端比对：ifVersion 为 null  抛 CHANGED
 *                                                     ⇒「只许在还没有文件时写」；    （= 远端被别人改过，
 *                                                     否则「只许在还是我读到的那份    runSync 归成
 *                                                     时写」                         REMOTE_CHANGED）
 *   WebDAV      ETag              PROPFIND（不支持    服务端条件写：ifVersion 为 null ⇒ `If-None-Match: *`
 *                                就退回 HEAD）       ⇒ `If-None-Match: *`；否则      412 ⇒ 抛 CHANGED
 *                                                     ⇒ `If-Match: <etag>`
 *   GitHub      blob SHA          GET Contents API    服务端条件写：带 `sha` ⇒ 只许   409 / 422 ⇒ 抛 CHANGED
 *                                                     覆盖那一份；不带 `sha` ⇒
 *                                                     只许新建
 *
 * 冲突（两边都改过）的**判定口径不在本模块**：它统一用 sync.mjs 的 compareState
 * （same / local-newer / remote-newer / diverged / unknown），
 * 本模块只提供 `compareTarget()` 把适配器接上去，**不另造第二套口径**。
 *
 * ## 边界（刻意不做的事）
 *
 *   · **只 import ./sync.mjs**（对外口径的来源）+ node: 内置模块。
 *   · **不碰网络、不碰磁盘**：fetch 与 fs 由调用方注入，测试可以离线跑。
 *   · **不取 Date.now()**：时刻由 opts.now 传入（`Date.parse` 只用来解析**服务器给的**
 *     Last-Modified，那不是取本机时刻）。
 *   · **凭据只出现在请求头里**，绝不进返回值、错误信息或日志；
 *     错误信息里的凭据一律由 scrub 抹掉（抹不掉的形态也由调用方兜底）。
 */

import { createHash } from "node:crypto";
import { compareState, SyncError, TARGETS } from "./sync.mjs";

/* ====================================================================== *
 * 常量
 * ====================================================================== */

/** 冲突时选哪一边。默认 "error"：报出来，不替用户做主。 */
export const CONFLICT_POLICIES = Object.freeze(["error", "local", "remote"]);

/** GitHub 的 API 主机**不可配置**：token 只发给这一个主机。 */
const GITHUB_API = "https://api.github.com";

/** GitHub 的 API 版本头（magpie github.go 的同名头）。 */
const GITHUB_API_VERSION = "2022-11-28";

/** 单份快照的上限。超过就不给写，免得写到一半被服务端截断（magpie 的 64 MiB）。 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * PROPFIND 的请求体。
 *
 * 为什么带体：有些 WebDAV 服务端（nginx 的 dav 模块一类）只在请求体里
 * 写明要哪些属性时才肯返回它们；magpie 发空体（dav.go 的 there/length），
 * 是因为它只问「有没有」与「多长」，不问 ETag。本模块要 ETag，
 * 所以得自己问明白要哪几个属性。
 */
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8" ?>' +
  '<D:propfind xmlns:D="DAV:"><D:prop>' +
  "<D:getetag/><D:getlastmodified/><D:getcontentlength/><D:resourcetype/>" +
  "</D:prop></D:propfind>";

/* ====================================================================== *
 * 小工具
 * ====================================================================== */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function requireNow(now) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new SyncError(
      "NO_TIME",
      "需要 opts.now（毫秒时间戳）：本模块不取 Date.now()，时刻一律由调用方给",
    );
  }
  return now;
}

/** 一段字节的版本号（本地目录目标用它当 ETag 一类的版本号）。 */
function hashBytes(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 抹掉凭据。
 *
 * 为什么要有这个：调用方注入的 fetch 有可能把请求头整个塞进错误信息里
 * （有些 HTTP 库就是这么干的），而凭据一旦进了错误信息就会进日志、进面板、
 * 进 issue。本模块的所有对外文本都过这一道。
 */
function makeScrubber(secrets) {
  const list = [];
  for (const s of secrets || []) {
    if (typeof s === "string" && s.length >= 4) list.push(s);
  }
  return function scrub(text) {
    if (text == null) return "";
    let out = String(text);
    for (const s of list) out = out.split(s).join("***");
    /* Bearer / Basic 后面那一段是凭据本身，比「token: xxx」这种形态更常见，
       所以先抹它——否则上面的 key:value 规则只会抹掉 "Bearer" 这个词。 */
    out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***");
    out = out.replace(
      /\b(authorization|token|password|passwd|secret|api[_-]?key)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
      "$1: ***",
    );
    return out;
  };
}

/** URL 里的 userinfo（https://user:pass@host/）不能进错误信息。 */
function safeUrl(u) {
  try {
    return String(u).replace(/\/\/[^/@\s]*@/, "//***@");
  } catch {
    return "";
  }
}

/** 「远端被别人改过了」——这个 code 必须在 sync.mjs 的 REMOTE_CHANGED_CODES 里。 */
function changedError(message) {
  return new SyncError("CHANGED", message);
}

/** 头取值：兼容 Headers 对象与普通对象两种注入形态。 */
function makeHeaderGetter(headers) {
  if (!headers) return () => null;
  if (typeof headers.get === "function") return (name) => headers.get(name);
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return (name) => {
    const v = lower[String(name).toLowerCase()];
    return v == null ? null : v;
  };
}

/** 拼路径。用 "/" 拼：调用方给什么分隔符都能被 Windows 的 fs 认。 */
function joinPath(dir, name) {
  if (!dir) return name;
  return `${String(dir).replace(/[\\/]+$/, "")}/${name}`;
}

/* ====================================================================== *
 * 适配器的统一契约
 * ====================================================================== */

/**
 * 同步目标适配器 —— 本模块的三个实现都正好是这三个动作。
 *
 *   read()   —— 读远端那份快照。没有文件时返回 **null**（不是空字节：
 *               空文件是「坏文件」，两回事）。version 按 TARGETS 里写的来。
 *   write()  —— 写远端。ifVersion 非空 ⇒ 条件写（远端被别人改过就抛 CHANGED）；
 *               ifVersion 为 null ⇒ 「只许在还没有文件时才写」。
 *   status() —— 问远端现在是什么状态：{ exists, version, modifiedAt, size }。
 *               写之前**必须**先问一次（红线：不能无条件覆盖）。
 *
 * read/write 的签名与 sync.mjs 的 SyncTarget 对齐，所以 sync.mjs 的 runSync
 * 可以直接吃这三个适配器，不需要改它一个字。
 */

/* ====================================================================== *
 * ① 本地目录目标
 * ====================================================================== */

/**
 * 本地目录目标：把快照放到用户自己指定的一个目录里。
 *
 * 注入的 IO：
 *   readFile(path)   → Uint8Array（文件在）；**null**（文件不在）；抛错（文件在但读不出来）
 *   writeFile(path, bytes) → 写一个文件
 *   rename(from, to)       → 改名（原子写的那一半）
 *   unlink(path)           → 删文件（可选：写失败时清掉临时文件）
 *   stat(path)             → { size, mtimeMs }（可选：给 status() 提供修改时间）
 *   now                    → 毫秒时间戳（数字或函数）
 *
 * 为什么「文件不在」要用 null 而不是抛错：调用方的 readFile 通常就是 fs.promises.readFile，
 * 它对「不在」抛 ENOENT、对「在但读不出」抛 EACCES，两种都得能分开——
 * 「读失败 = 未知，绝不是空」是本仓库吃过大亏的那条规矩。
 */
export function createLocalTarget(opts = {}) {
  const readFile = opts.readFile;
  const writeFile = opts.writeFile;
  const rename = opts.rename;
  const unlink = opts.unlink;
  const stat = opts.stat;
  if (typeof readFile !== "function" || typeof writeFile !== "function" || typeof rename !== "function") {
    throw new SyncError(
      "BAD_OPTION",
      "本地目录目标需要注入 readFile / writeFile / rename 三个函数：本模块自己不碰磁盘",
    );
  }
  const file = opts.file || TARGETS.local.file;
  const targetPath = opts.path || joinPath(opts.dir, file);
  const scrub = makeScrubber([]);
  let seq = 0;

  function stamp() {
    const raw = typeof opts.now === "function" ? opts.now() : opts.now;
    return requireNow(raw);
  }

  /** 读一遍现文件。null = 不在；抛错 = 在但读不出来（**不是**当成空）。 */
  async function readBytes() {
    let bytes;
    try {
      bytes = await readFile(targetPath);
    } catch (e) {
      throw new SyncError(
        "REMOTE_UNREADABLE",
        `读远端快照失败：${scrub(e && e.message ? e.message : String(e))}`,
        e,
      );
    }
    if (bytes == null) return null;
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  }

  async function status() {
    const bytes = await readBytes();
    if (bytes == null) {
      return { exists: false, version: null, modifiedAt: null, size: 0 };
    }
    let modifiedAt = null;
    if (typeof stat === "function") {
      try {
        const st = await stat(targetPath);
        if (st && typeof st.mtimeMs === "number") modifiedAt = st.mtimeMs;
      } catch {
        /* 拿不到修改时间不算失败：版本号是内容哈希，那才是判据。 */
      }
    }
    return { exists: true, version: hashBytes(bytes), modifiedAt, size: bytes.length };
  }

  async function read() {
    const bytes = await readBytes();
    if (bytes == null) return null;
    return { bytes, version: hashBytes(bytes) };
  }

  async function write(bytes, writeOpts = {}) {
    const ifVersion = writeOpts.ifVersion == null ? null : String(writeOpts.ifVersion);
    /* 写之前先问状态：本地目录没有服务端版本号，只能自己读一遍算哈希再比对。
       这挡不住「同一瞬间并发写」，但挡得住「另一台机器刚刚推过」——
       那正是要挡的那一种。 */
    const st = await status();
    if (ifVersion == null) {
      if (st.exists) {
        throw changedError("远端已经有文件了，不许覆盖：只许在还没有文件时写");
      }
    } else if (!st.exists) {
      throw changedError("远端的那份已经不在了，不许写：写下去会变成新建而不是覆盖");
    } else if (st.version !== ifVersion) {
      throw changedError("远端已经被别的机器改过了，不许覆盖");
    }

    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    seq += 1;
    const tmp = `${targetPath}.tmp-${stamp()}-${seq}`;
    try {
      await writeFile(tmp, data);
    } catch (e) {
      throw new SyncError(
        "WRITE_FAILED",
        `写远端快照失败：${scrub(e && e.message ? e.message : String(e))}`,
        e,
      );
    }
    try {
      await rename(tmp, targetPath);
    } catch (e) {
      /* 临时文件留在那儿不会让人少配置，但会让下一次同步看错「远端是什么」。
         顺手清掉；清不掉就算了，不许因为清不掉把整次写判成失败。 */
      if (typeof unlink === "function") {
        try {
          await unlink(tmp);
        } catch {
          /* 故意忽略 */
        }
      }
      throw new SyncError(
        "WRITE_FAILED",
        `写远端快照失败：${scrub(e && e.message ? e.message : String(e))}`,
        e,
      );
    }
    return { version: hashBytes(data) };
  }

  return { kind: "local", file, path: targetPath, read, write, status };
}

/* ====================================================================== *
 * ② WebDAV 目标
 * ====================================================================== */

/* --- WebDAV 的 multistatus 解析（自己写的：不能引第三方依赖） --- */

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function safeDecodeUri(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 取某个标签里的文字。WebDAV 的命名空间前缀各家不一样，所以前缀不写死。 */
function tagText(block, name) {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?${name}>`,
    "i",
  );
  const m = block.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

/**
 * 一个 response 里的 propstat 们。
 *
 * 为什么按 propstat 拆：一个 response 里可能有好几段 propstat，
 * 有一段是 200（属性有值），另一段是 404（这个属性没有）。
 * 不拆开就会把「404 的空值」当成「属性的值」——
 * getetag 恰好在 404 那段里的话，我们会拿到一个空 ETag，
 * 然后下一次 If-Match 就成了 `If-Match: ""`（匹配不上任何东西，写必被拒）。
 */
function propStatsOf(block) {
  const re = /<(?:[A-Za-z0-9_.-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?propstat>/gi;
  const out = [];
  let m;
  while ((m = re.exec(block))) {
    const inner = m[1];
    const prop = inner.match(/<(?:[A-Za-z0-9_.-]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?prop>/i);
    out.push({
      props: prop ? prop[1] : "",
      status: tagText(inner, "status") || "",
    });
  }
  return out;
}

/** href 的最后一段（文件名的那个）。 */
function lastSegment(href) {
  const p = String(href).split(/[?#]/)[0];
  const segs = p.split("/").filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : "";
  return decodeXmlEntities(safeDecodeUri(last));
}

/** 把 207 的 multistatus 拆成一条条条目。 */
function parseMultiStatus(xml) {
  const out = [];
  const re = /<(?:[A-Za-z0-9_.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?response>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const href = tagText(block, "href");
    if (href == null) continue;
    const stats = propStatsOf(block);
    const chosen = stats.find((s) => /200/.test(s.status)) || stats[0] || { props: "" };
    const props = chosen.props;
    const rt = props.match(
      /<(?:[A-Za-z0-9_.-]+:)?resourcetype\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?resourcetype>)/i,
    );
    const isCollection = !!(rt && rt[3] && /<(?:[A-Za-z0-9_.-]+:)?collection\b/i.test(rt[3]));
    const length = tagText(props, "getcontentlength");
    out.push({
      href,
      name: lastSegment(href),
      isCollection,
      etag: tagText(props, "getetag"),
      lastModified: tagText(props, "getlastmodified"),
      size: length != null && /^\d+$/.test(length) ? Number(length) : null,
    });
  }
  return out;
}

/**
 * WebDAV 目标。
 *
 * 注入的 IO：
 *   fetch(url, init) → 类 fetch 的回答：{ status, headers, arrayBuffer() }
 *   baseUrl           → 目录地址，如 https://dav.example.com/remote.php/dav/files/me
 *   file              → 文件名，默认 sync.mjs 的 TARGETS.webdav.file
 *   auth              → { user, pass } 或 { bearer }（只进请求头）
 *   headers           → 额外的请求头
 *
 * ## ETag 怎么用（这一段是本文件最要紧的语义）
 *
 * ETag 是**服务器给某个文件版本的一个不透明字符串**（通常是 `"abc123"`，带引号；
 * 弱 ETag 是 `W/"abc123"`）。它只表示「这一份是这一份」，不含内容也不含时间，
 * 客户端**不许**去猜它的含义。
 *
 *   `If-Match: "abc123"`      —— 只有当远端当前这一份的 ETag **正好等于** "abc123"
 *                                时才允许写；不等就回 **412 Precondition Failed**。
 *                                这是「我读到的就是我要覆盖的那一份」的断言：
 *                                别人在这期间改过 → 拒绝 → 绝不覆盖别人的更新。
 *
 *   `If-Match: *`             —— 与上面**完全不是一回事**：它只问「这个文件在不在」，
 *                                在就允许写（不看是哪一份）。**我们不用它**——
 *                                它挡不住别人的更新。
 *
 *   `If-None-Match: *`        —— 只有当远端当前**没有**这个文件时才允许写；
 *                                在就回 412/409。这是「新建远端的第一份」用的写法：
 *                                只在空远端上落笔，不覆盖任何已有文件。
 *
 *   `If-None-Match: "abc123"` —— 又与上面**不是一回事**：它问「只要它还是我读到的那份
 *                                就允许写」——语义上等于 `If-Match: "abc123"`。
 *                                **我们也不用它**：部分服务器把它实现成
 *                                「不匹配就当成功」，那正好是我们要防的「静默覆盖」。
 *
 * 所以本模块的映射是死的：ifVersion 为空 ⇒ `If-None-Match: *`；
 * ifVersion 非空 ⇒ `If-Match: <etag>`。
 */
export function createWebDavTarget(opts = {}) {
  const doFetch = opts.fetch;
  if (typeof doFetch !== "function") {
    throw new SyncError("BAD_OPTION", "WebDAV 目标需要一个注入的 fetch（opts.fetch）：本模块自己不联网");
  }
  const baseUrl = String(opts.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new SyncError("BAD_OPTION", "WebDAV 目标需要 baseUrl（目录地址）");
  }
  const file = opts.file || TARGETS.webdav.file;
  const targetName = lastSegment(file);

  const secrets = [];
  const headers = { ...(opts.headers || {}) };
  if (opts.auth) {
    if (opts.auth.bearer) {
      secrets.push(opts.auth.bearer);
      headers.Authorization = `Bearer ${opts.auth.bearer}`;
    } else if (opts.auth.user != null || opts.auth.pass != null) {
      const raw = `${opts.auth.user == null ? "" : opts.auth.user}:${opts.auth.pass == null ? "" : opts.auth.pass}`;
      const enc = Buffer.from(raw, "utf8").toString("base64");
      secrets.push(opts.auth.pass, raw, enc);
      headers.Authorization = `Basic ${enc}`;
    }
  }
  const scrub = makeScrubber(secrets);
  const fileUrl = `${baseUrl}/${file}`;

  async function request(method, url, init = {}) {
    let res;
    try {
      res = await doFetch(url, {
        method,
        headers: { ...headers, ...(init.headers || {}) },
        body: init.body,
      });
    } catch (e) {
      throw new SyncError(
        "REMOTE_ERROR",
        `WebDAV 请求失败：${scrub(e && e.message ? e.message : String(e))}`,
        e,
      );
    }
    const status = res && typeof res.status === "number" ? res.status : 0;
    const getHeader = makeHeaderGetter(res && res.headers);
    let body = null;
    if (res && status !== 204 && status !== 304) {
      if (typeof res.arrayBuffer === "function") body = Buffer.from(await res.arrayBuffer());
      else if (typeof res.text === "function") body = Buffer.from(await res.text(), "utf8");
      else if (res.body != null) body = Buffer.from(res.body);
    }
    return { status, getHeader, body };
  }

  function httpError(action, res) {
    if (res.status === 401) {
      return new SyncError("AUTH_FAILED", "WebDAV 服务器拒绝了用户名或口令（HTTP 401）");
    }
    if (res.status === 403) {
      return new SyncError("FORBIDDEN", "WebDAV 服务器不许这个账号做这件事（HTTP 403）");
    }
    if (res.status === 429) {
      return new SyncError("RATE_LIMITED", "WebDAV 服务器在限流（HTTP 429）：过一会儿再同步");
    }
    return new SyncError("REMOTE_ERROR", `${action} 失败：HTTP ${res.status}`);
  }

  /** 列目录（PROPFIND）。不支持 PROPFIND 的服务器由调用者退回 HEAD。 */
  async function listDir() {
    const res = await request("PROPFIND", `${baseUrl}/`, {
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    });
    if (res.status === 207) {
      return { ok: true, status: res.status, entries: parseMultiStatus(res.body ? res.body.toString("utf8") : "") };
    }
    if (res.status === 401) throw httpError("PROPFIND", res);
    if (res.status === 403) throw httpError("PROPFIND", res);
    if (res.status === 429) throw httpError("PROPFIND", res);
    if (res.status === 404 || res.status === 409 || res.status === 410) {
      return { ok: false, status: res.status, entries: [] };
    }
    if (res.status === 405 || res.status === 501) {
      return { ok: false, status: res.status, entries: [] };
    }
    throw httpError("PROPFIND", res);
  }

  /** 有些服务器不给 PROPFIND（405/501），那就退到 HEAD 问同一个文件。 */
  async function headStatus() {
    const res = await request("HEAD", fileUrl, {});
    if (res.status === 404 || res.status === 410) {
      return { exists: false, version: null, modifiedAt: null, size: 0 };
    }
    if (res.status < 200 || res.status >= 300) throw httpError("HEAD", res);
    const etag = res.getHeader("ETag");
    const lm = res.getHeader("Last-Modified");
    const len = Number(res.getHeader("Content-Length"));
    return {
      exists: true,
      version: etag || null,
      /* Date.parse 解析的是**服务器给的那个时刻**，不是读本机的钟。 */
      modifiedAt: lm ? Date.parse(lm) : null,
      size: Number.isFinite(len) && len >= 0 ? len : 0,
    };
  }

  async function status() {
    const listed = await listDir();
    if (!listed.ok) {
      if (listed.status === 405 || listed.status === 501) return headStatus();
      /* 目录都不在了 ⇒ 文件更不在。 */
      return { exists: false, version: null, modifiedAt: null, size: 0 };
    }
    const entry = listed.entries.find((e) => !e.isCollection && e.name === targetName);
    if (!entry) return { exists: false, version: null, modifiedAt: null, size: 0 };
    return {
      exists: true,
      version: entry.etag || null,
      modifiedAt: entry.lastModified ? Date.parse(entry.lastModified) : null,
      size: entry.size == null ? 0 : entry.size,
    };
  }

  async function read() {
    /* Accept-Encoding: identity —— 服务器压缩过的副本会给出另一个 ETag，
       之后每一次 If-Match 都会被判成「远端变了」，同步就永远推不上去
       （magpie dav.go 的 #1362 教训）。 */
    const res = await request("GET", fileUrl, { headers: { "Accept-Encoding": "identity" } });
    if (res.status === 404 || res.status === 410) return null;
    if (res.status === 401) throw httpError("GET", res);
    if (res.status === 403) throw httpError("GET", res);
    if (res.status === 429) throw httpError("GET", res);
    if (res.status !== 200) throw httpError("GET", res);
    const bytes = res.body || Buffer.alloc(0);
    return { bytes, version: res.getHeader("ETag") || null };
  }

  async function write(bytes, writeOpts = {}) {
    const ifVersion = writeOpts.ifVersion == null ? null : String(writeOpts.ifVersion);
    /* 写之前先问状态：这一步既回答「远端在不在」，也让我们在
       「服务器根本不给 ETag」时不至于做出一次没有条件的覆盖。 */
    const st = await status();
    const h = { "Content-Type": "application/octet-stream" };
    if (ifVersion == null) {
      if (st.exists) {
        /* 服务器不给 ETag 时我们连「我读到的是哪一份」都说不出来，
           更谈不上条件写——这时唯一安全的是不写（magpie 在这里是退化成盲写，
           我们不）。这个错要说清楚，不然用户会以为「远端被人改了」。 */
        if (!st.version) {
          throw new SyncError(
            "NO_VERSION",
            "这个 WebDAV 服务器不给 ETag：条件写没法做，不许覆盖已有的文件",
          );
        }
        throw changedError("远端已经有文件了，不许覆盖：只许在还没有文件时写");
      }
      h["If-None-Match"] = "*";
    } else {
      if (!st.exists) {
        throw changedError("远端的那份已经不在了，不许写");
      }
      h["If-Match"] = ifVersion;
    }
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    const res = await request("PUT", fileUrl, { headers: h, body: data });
    if (res.status === 412) {
      throw changedError("远端在你读它之后被别的机器改了，写被服务器拒绝（HTTP 412）");
    }
    if (res.status === 401) throw httpError("PUT", res);
    if (res.status === 403) throw httpError("PUT", res);
    if (res.status === 429) throw httpError("PUT", res);
    if (res.status === 409) {
      /* 409 在 WebDAV 里通常是「上一级目录不存在」，但也有服务器拿它回答条件失败。
         分不清就再问一次状态：文件在且版本变了 ⇒ 是别人改了。 */
      const now = await status();
      if (now.exists && now.version && now.version !== ifVersion) {
        throw changedError("远端在你读它之后被别的机器改了，写被服务器拒绝（HTTP 409）");
      }
      throw new SyncError("REMOTE_CONFLICT", "WebDAV 上写不进去：多半是那个目录还不存在，先建好再同步");
    }
    if (res.status < 200 || res.status >= 300) throw httpError("PUT", res);
    const etag = res.getHeader("ETag");
    if (etag) return { version: etag };
    /* 有的服务器 PUT 不回 ETag：那就再问一次状态，把新版本号拿回来。
       拿不回来的话下一轮就只能靠「新建」那条路，那太危险，宁可报错。 */
    const after = await status();
    if (!after.exists || !after.version) {
      throw new SyncError("REMOTE_ERROR", "WebDAV 写成功了，但服务器没有给出新的 ETag：下一轮没法做条件写");
    }
    return { version: after.version };
  }

  return { kind: "webdav", file, path: fileUrl, read, write, status };
}

/* ====================================================================== *
 * ③ GitHub 目标
 * ====================================================================== */

/**
 * GitHub 目标 —— 走 **Contents API**，不用 Releases。
 *
 * 为什么是 Contents API（理由写在这里，免得后来的人改回去）：
 *   1. **Releases 的资产（asset）没有条件写**。上传一个同名资产得到的是另一个
 *      资产 id，没有「我读的那一份还在不在」这回事——同步就退化成盲写，
 *      而「覆盖掉别人的更新」正是本仓库最不能出的错。
 *   2. **Contents API 的每次 PUT 就是一个 commit**，版本号是 blob SHA，
 *      而 **sha 不匹配时 GitHub 直接回 409**——这就是条件写。
 *   3. 我们同步的恰好是「一个文件」，Contents API 恰好是「一个文件的一个版本」，
 *      一一对应。Releases 是「发布物」，语义上多了一层用不上的东西。
 *
 * magpie 用的也是 Contents API + blob SHA（github.go 的 commit()）。
 *
 * 凭据纪律：
 *   · token **只**进 `Authorization` 头，且只发给 https://api.github.com
 *     （主机写死不可配置——magpie 同样拒绝跳到别处的重定向）。
 *   · token 绝不进返回值、绝不进错误信息、绝不进 commit message。
 *   · 仓库必须是私有的：公开仓库的提交历史等于把每一版加密备份交给所有人
 *     慢慢猜口令（magpie 的 prepare 拒绝公开仓库）。
 */
export function createGitHubTarget(opts = {}) {
  const doFetch = opts.fetch;
  if (typeof doFetch !== "function") {
    throw new SyncError("BAD_OPTION", "GitHub 目标需要一个注入的 fetch（opts.fetch）：本模块自己不联网");
  }
  const repo = String(opts.repo || "").trim().replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new SyncError("BAD_OPTION", "GitHub 目标需要 repo（owner/name 形式）");
  }
  const token = opts.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new SyncError("BAD_OPTION", "GitHub 目标需要一个 token：它是凭据，不进快照也不进日志");
  }
  const file = opts.file || TARGETS.github.file;
  const path = file.split("/").map(encodeURIComponent).join("/");
  const commitMessage = opts.message || "bai-router: 同步配置";
  const scrub = makeScrubber([token]);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "bai-router-sync",
  };
  let branch = opts.branch ? String(opts.branch).trim() : "";
  let prepared = false;

  async function request(method, apiPath, init = {}) {
    const url = `${GITHUB_API}${apiPath}`;
    let res;
    try {
      res = await doFetch(url, {
        method,
        headers: { ...headers, ...(init.headers || {}) },
        body: init.body,
      });
    } catch (e) {
      throw new SyncError(
        "REMOTE_ERROR",
        `GitHub 请求失败：${scrub(e && e.message ? e.message : String(e))}`,
        e,
      );
    }
    const status = res && typeof res.status === "number" ? res.status : 0;
    const getHeader = makeHeaderGetter(res && res.headers);
    let body = null;
    if (res && status !== 204 && status !== 304) {
      if (typeof res.arrayBuffer === "function") body = Buffer.from(await res.arrayBuffer());
      else if (typeof res.text === "function") body = Buffer.from(await res.text(), "utf8");
      else if (res.body != null) body = Buffer.from(res.body);
    }
    return { status, getHeader, body };
  }

  function githubError(action, res) {
    const text = res.body ? scrub(res.body.toString("utf8").slice(0, 300)) : "";
    if (res.status === 401) {
      return new SyncError("AUTH_FAILED", "GitHub 拒绝了这次同步令牌（HTTP 401）：它可能过期或被撤销了");
    }
    if (res.status === 403) {
      return new SyncError("FORBIDDEN", `GitHub 不许这个令牌做这件事（HTTP 403）：它需要仓库内容的读写权限${text ? "：" + text : ""}`);
    }
    if (res.status === 404) {
      return new SyncError("REMOTE_ERROR", `GitHub 上找不到它（HTTP 404）：${action}`);
    }
    if (res.status === 429) {
      return new SyncError("RATE_LIMITED", "GitHub 在限流（HTTP 429）：过一会儿再同步");
    }
    return new SyncError("REMOTE_ERROR", `${action} 失败：HTTP ${res.status}${text ? " " + text : ""}`);
  }

  /**
   * 第一次用之前先问两件事：仓库在不在、是不是私有的；顺带定下分支。
   *
   * 为什么必须问私有：公开仓库的提交历史会把**每一版**加密备份摊给所有人，
   * 他们可以在自己机器上慢慢猜口令。magpie 宁可同步失败也不写公开仓库。
   * 我们照抄；真要写公开仓库得显式说一声（opts.allowPublicRepo）。
   */
  async function prepare() {
    if (prepared) return;
    const res = await request("GET", `/repos/${repo}`);
    if (res.status !== 200) throw githubError("读仓库信息", res);
    let meta;
    try {
      meta = JSON.parse(res.body ? res.body.toString("utf8") : "");
    } catch {
      throw new SyncError("REMOTE_ERROR", "GitHub 返回的仓库信息不是 JSON：多半是中间有东西挡着");
    }
    if (meta.private !== true && opts.allowPublicRepo !== true) {
      throw new SyncError(
        "REPO_NOT_PRIVATE",
        `这个 GitHub 仓库不是私有的（或 GitHub 没说它是私有的）：公开仓库的历史会把每一版加密备份交给别人慢慢猜口令。请换个私有仓库`,
      );
    }
    if (!branch) branch = String(meta.default_branch || "");
    if (!branch) {
      throw new SyncError("REMOTE_ERROR", "这个仓库没有默认分支：先建一个初始 commit 再同步");
    }
    prepared = true;
  }

  /** 取一份内容。GitHub 给的是 base64；超过 1 MiB 时它给 blob SHA，得自己去取。 */
  async function contentBytes(meta) {
    const enc = meta && meta.encoding;
    if (enc === "base64") {
      const raw = String((meta && meta.content) || "").replace(/\s+/g, "");
      const buf = Buffer.from(raw, "base64");
      if (typeof meta.size === "number" && buf.length !== meta.size) {
        throw new SyncError("REMOTE_UNREADABLE", "GitHub 返回的快照不完整：拿到的字节数与它说的对不上");
      }
      return buf;
    }
    if (enc === "none" || enc == null) {
      const sha = meta && meta.sha;
      if (!sha) {
        throw new SyncError("REMOTE_UNREADABLE", "GitHub 既没给内容也没给 blob SHA：这份快照读不出来");
      }
      const res = await request("GET", `/repos/${repo}/git/blobs/${sha}`, {
        headers: { Accept: "application/vnd.github.raw+json" },
      });
      if (res.status !== 200) throw githubError("读 blob", res);
      return res.body || Buffer.alloc(0);
    }
    throw new SyncError("REMOTE_UNREADABLE", `GitHub 返回了本模块不认的内容编码：${scrub(String(enc))}`);
  }

  async function contentMeta() {
    const res = await request("GET", `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw githubError("读仓库内容", res);
    let meta;
    try {
      meta = JSON.parse(res.body ? res.body.toString("utf8") : "");
    } catch {
      throw new SyncError("REMOTE_ERROR", "GitHub 返回的内容信息不是 JSON");
    }
    if (!meta || meta.type !== "file" || !meta.sha) {
      throw new SyncError("REMOTE_UNREADABLE", "GitHub 上那个位置不是一个文件：同步要的是一个文件");
    }
    return meta;
  }

  async function status() {
    await prepare();
    const meta = await contentMeta();
    if (!meta) return { exists: false, version: null, modifiedAt: null, size: 0 };
    /* Contents API 不给修改时间（只有 commit 的信息里有，而那要多打一次接口）。
       版本号用 blob SHA 就够了，modifiedAt 只能是 null。 */
    return {
      exists: true,
      version: meta.sha,
      modifiedAt: null,
      size: typeof meta.size === "number" ? meta.size : 0,
    };
  }

  async function read() {
    await prepare();
    const meta = await contentMeta();
    if (!meta) return null;
    const bytes = await contentBytes(meta);
    return { bytes, version: meta.sha };
  }

  async function write(bytes, writeOpts = {}) {
    const ifVersion = writeOpts.ifVersion == null ? null : String(writeOpts.ifVersion);
    await prepare();
    /* 写之前先问状态：这一问决定「能不能新建」——
       没有 sha 的 PUT 在 GitHub 上只能创建不存在的文件，
       文件已经在了会回 422（"sha" wasn't supplied），那正是条件写该有的样子。 */
    const st = await status();
    if (ifVersion == null && st.exists) {
      throw changedError("远端已经有文件了，不许覆盖：只许在还没有文件时写");
    }
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (data.length > MAX_FILE_BYTES) {
      throw new SyncError("BAD_OPTION", "这份快照超过 64 MiB：GitHub 的内容接口放不下");
    }
    const body = {
      message: commitMessage,
      content: data.toString("base64"),
    };
    if (branch) body.branch = branch;
    if (ifVersion != null) body.sha = ifVersion;

    const res = await request("PUT", `/repos/${repo}/contents/${path}`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      throw changedError("远端在你读它之后被别的机器改了，GitHub 拒绝了这次写（HTTP 409）");
    }
    if (res.status === 422) {
      const text = res.body ? res.body.toString("utf8") : "";
      /* 422 且提到 sha：两种可能——文件是我们以为不存在、却被别人抢先建了；
         或者我们带的 sha 过期了。两种都是「远端变了」。 */
      if (/sha/i.test(text)) {
        throw changedError("远端在你读它之后被别的机器改了，GitHub 拒绝了这次写（HTTP 422）");
      }
      throw new SyncError("REMOTE_ERROR", `GitHub 拒绝了这次写：HTTP 422 ${scrub(text.slice(0, 200))}`);
    }
    if (res.status !== 200 && res.status !== 201) throw githubError("写仓库内容", res);
    let out = null;
    try {
      out = JSON.parse(res.body ? res.body.toString("utf8") : "");
    } catch {
      out = null;
    }
    const sha = out && out.content && out.content.sha ? out.content.sha : null;
    if (!sha) {
      /* 写成功了却拿不到新版本号：下一轮就做不了条件写。与其悄悄降级成盲写，
         不如把话说出来。 */
      throw new SyncError("REMOTE_ERROR", "GitHub 写成功了，但没有返回新的 blob SHA：下一轮没法做条件写");
    }
    return { version: sha };
  }

  return { kind: "github", file, path: `${repo}/${file}`, read, write, status };
}

/* ====================================================================== *
 * ④ 统一入口：建目标 / 比较 / 冲突策略
 * ====================================================================== */

/** 按名字建一个目标适配器。给面板用：用户填了地址，面板得知道这是哪一种。 */
export function createTarget(kind, opts = {}) {
  const k = String(kind || "").toLowerCase();
  if (k === "local") return createLocalTarget(opts);
  if (k === "webdav") return createWebDavTarget(opts);
  if (k === "github") return createGitHubTarget(opts);
  throw new SyncError("BAD_TARGET", `不认识的同步目标：${kind}`);
}

/**
 * 读远端那份快照并解开。
 *
 * 返回 { parts, createdAt, version } 或 null（远端没有文件）。
 * 解密归 backup.mjs 管，所以 open 由调用方注入——本模块不认识「快照」长什么样，
 * 只认识「部件名 → 值」。
 */
export async function readRemoteParts(target, open) {
  if (!target || typeof target.read !== "function") {
    throw new SyncError("BAD_TARGET", "同步目标必须提供 read");
  }
  if (typeof open !== "function") {
    throw new SyncError("BAD_OPTION", "读远端需要 open（解密归 backup.mjs 管）");
  }
  const file = await target.read();
  if (!file) return null;
  if (!file.bytes || file.bytes.length === 0) {
    throw new SyncError("REMOTE_UNREADABLE", "远端文件是空的，读不出备份");
  }
  let opened;
  try {
    opened = await open(file.bytes);
  } catch (e) {
    throw new SyncError(
      "REMOTE_UNREADABLE",
      `远端的备份打不开：${e && e.message ? e.message : String(e)}`,
      e,
    );
  }
  if (!opened || !isPlainObject(opened.parts)) {
    throw new SyncError("REMOTE_UNREADABLE", "远端那份解开之后不是一份备份");
  }
  return {
    parts: opened.parts,
    createdAt: typeof opened.createdAt === "number" ? opened.createdAt : 0,
    version: file.version == null ? null : file.version,
  };
}

/**
 * 「远端比我新吗 / 我比远端新吗 / 两边一样吗」——**直接用 sync.mjs 的 compareState**。
 *
 * 为什么不另写一套：口径一多，迟早有两处不一样。本模块只负责把适配器的
 * 「读远端」接到那一个口径上。
 */
export async function compareTarget(target, input = {}) {
  const remote = await readRemoteParts(target, input.open);
  const state = compareState({
    localParts: input.localParts,
    remote,
    state: input.state,
  });
  return state;
}

/**
 * 冲突时选哪一边。
 *
 * relation 用 sync.mjs 的 compareState 那五个值，口径一字不改：
 *   same         —— 两边一样，没什么可选的
 *   local-newer  —— 只有本地改了 ⇒ 本地赢（这也是冲突，只是没有歧义）
 *   remote-newer —— 只有远端改了 ⇒ 远端赢
 *   diverged     —— **两边都改过 ⇒ 冲突**
 *   unknown      —— 从来没同步过 / 远端没有文件
 *
 * policy 决定冲突时怎么办（**默认 error：报出来，不替用户做主**）：
 *   "error"  —— 报出来，调用方自己决定
 *   "local"  —— 显式选本地（返回里说清 winner 是 local）
 *   "remote" —— 显式选远端（返回里说清 winner 是 remote）
 *
 * 部件级的合并口径不在这里：那是 sync.mjs 的 planSync 的事（「新的赢」）。
 * 本函数是**文件级**的取舍：整份取哪边。
 */
export function resolveConflict(input = {}) {
  const relation = String(input.relation || "unknown");
  const policy = input.policy || "error";
  if (!CONFLICT_POLICIES.includes(policy)) {
    throw new SyncError("BAD_OPTION", `冲突策略只能是 ${CONFLICT_POLICIES.join(" / ")}`);
  }
  if (relation === "same") {
    return { relation, action: "none", winner: null, reason: "两边一样" };
  }
  if (relation === "local-newer") {
    return { relation, action: "use-local", winner: "local", reason: "只有本地改过" };
  }
  if (relation === "remote-newer") {
    return { relation, action: "use-remote", winner: "remote", reason: "只有远端改过" };
  }
  if (relation === "unknown") {
    return { relation, action: "none", winner: null, reason: "远端没有文件（或从没同步过）：没有冲突" };
  }
  /* diverged：两边都改过。 */
  if (policy === "error") {
    return {
      relation,
      action: "abort",
      winner: null,
      reason: "两边都改过了：报出来，不静默覆盖",
    };
  }
  if (policy === "local") {
    return { relation, action: "use-local", winner: "local", reason: "两边都改过，按调用方给的策略选本地" };
  }
  return { relation, action: "use-remote", winner: "remote", reason: "两边都改过，按调用方给的策略选远端" };
}
