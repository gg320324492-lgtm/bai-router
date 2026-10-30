// qoder-patch.mjs —— 把 Qoder worker 补丁内置进路由台（Node 实现，不依赖 Python）。
//
// 背景（调研结论，2026-10-06）：
//   Qoder 的 jt- jobToken 只存在于 worker 子进程内存里，磁盘上**没有任何明文持久化**
//   （实测扫过 %APPDATA%\com.qoder.app.stable 全目录 + Local Storage leveldb +
//   qoder-data.v1.json + main.sqlite，0 处命中 "jt-"）。凭据库 auth.v1.dat 是
//   v10 信封 + AES-256-GCM + scrypt 加密的，密钥由主进程持有，worker 拿不到，中转更拿不到。
//   出网流量里也从没出现过 refresh_token（只有 Authorization + x-gw-user-id），
//   所以「中转侧凭 refresh_token 续期」这条路也不成立。
//   → 结论：**只能运行时抓**，补丁是唯一可行方案。
//
//   原方案是 qoder-patch/patch_worker.py，要求用户：
//     ① 装 Python  ② 每次 Qoder 升级后手动重跑 apply。
//   新电脑上没人跑过 → 令牌文件不存在 → 面板显示「未读到」。
//   本模块把同一套补丁算法用 Node 重写（Electron 自带 Node，零外部依赖），
//   由面板一键调用，把「装 Python + 手动跑脚本」彻底消掉。
//
// 与 Python 版保持**逐字节一致**的补丁产物，两边可以互相 apply/revert 不打架。
// 补丁点按**内容**定位（混淆后变量名各版本不同），新版本装好后重跑即可，不用改代码。
//
// ## ⚠ 落点：数据目录（**不是**系统盘临时目录）
//
// 补丁产物（令牌快照、模型目录、抓包日志）落在**数据目录**里，与 server.mjs 的
// DATA_DIR 同一套算法（`BAI_DATA_DIR` || 本模块所在目录 —— 两者同在 server/ 下，
// 算出来必然是同一个目录）。**这一处是「令牌落点」的唯一出处**：server.mjs 的
// `DEFAULTS.qd.tokenFile` 直接引用本模块导出的 `QODER_PATCH_PATHS.TOKFILE`，
// 中转读的和补丁写的是同一个字符串 ⇒ 差一个字节都不会出现。
//
// 早先这里写的是 `os.tmpdir()`，而 server.mjs 那侧在 2026-10-23 改成了 DATA_DIR
// （用户要求「不在系统盘留文件」）⇒ **两边落点分叉**：补丁写 Temp、中转读 DATA_DIR，
// 面板永远显示「未读到」（新机必现；本机只是碰巧还留着旧的 Temp 路径配置）。
// 现在这一侧也搬到数据目录，分叉消除。
//
// ⚠ 落点写在**补丁产物的字节里**（preamble 硬编码路径）⇒ 改落点 = 补丁产物变了，
//   已经打过旧补丁的副本必须**先还原再重打**（qpApply 自动做，见该函数）。

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// worker 在 resources 下的相对路径（各版本一致）
const REL = path.join("node_modules", "@qoder-ai", "qoder-agent-sdk", "dist",
  "_worker", "qoder-worker-runtime.obf.mjs");
// 国内版 Qoder CN 的包名不同（scope 相同）——有意不打，理由见下
const REL_CN = REL.replace("qoder-agent-sdk", "qoder-cn-agent-sdk");

// 数据目录：与 server.mjs 逐字同一套算法（server.mjs: `process.env.BAI_DATA_DIR || HERE`）。
// ⚠ 两个模块都在 server/ 目录下 ⇒ HERE 相同 ⇒ 算出来必然一致。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BAI_DATA_DIR || HERE;
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { }

/* 补丁产物落盘位置（数据目录）。
 * ⚠ 这三条路径会被**写进补丁产物**（preamble 里硬编码）⇒ 改这里等于改补丁字节，
 *   已经打过旧补丁的副本要重打（qpApply 认得旧补丁态并自动先还原）。 */
const OUT = path.join(DATA_DIR, "qoder-hdr.jsonl");
const TOKFILE = path.join(DATA_DIR, "qoder-token.json");
const MODELFILE = path.join(DATA_DIR, "qoder-models.json");

const MARKER = "WORKER RUNTIME PATCHED";

/* ---------------- 补丁 1：模块头，包装 globalThis.fetch ---------------- */
// 注意：JS 模板串里 `\n` 是换行、`\\n` 才是字面 \n。这里要写进 worker 的是字面 \n
// （worker 里 `JSON.stringify(o)+"\n"` 才是往文件里写换行），所以模板串里写 \\n。
function buildPreamble() {
  return "import{appendFileSync as __qHf,writeFileSync as __qWw}from\"node:fs\";"
    + "const __qOut=" + JSON.stringify(OUT) + ",__qTok=" + JSON.stringify(TOKFILE)
    + ",__qMod=" + JSON.stringify(MODELFILE) + ";"
    + "const __qW=o=>{try{__qHf(__qOut,JSON.stringify(o)+\"\\n\")}catch(__qE){}};"
    + "const __qOf=globalThis.fetch;"
    + "if(typeof __qOf===\"function\")globalThis.fetch=function(__qI,__qO){try{"
    + "const __qU=typeof __qI===\"string\"?__qI:(__qI&&__qI.url)||String(__qI);"
    + "let __qH={};try{const __qS=(__qO&&__qO.headers)||(__qI&&__qI.headers);"
    + "if(__qS){if(typeof __qS.forEach===\"function\"&&typeof __qS.get===\"function\"){"
    + "__qS.forEach((v,k)=>__qH[k]=v)}else{for(const k in __qS)__qH[k]=__qS[k]}}}catch(__qE){}"
    + "const __qL={};for(const k in __qH)__qL[k.toLowerCase()]=__qH[k];"
    + "if(__qL[\"x-gw-user-id\"]||__qL[\"authorization\"]||"
    + "/qoder|collaboration|completion|chat|runtime|algo|sign/i.test(__qU))"
    + "__qW({t:Date.now(),via:\"fetch\",url:__qU,headers:__qL,"
    + "body:__qO&&__qO.body?String(__qO.body).slice(0,6000):\"\"});"
    + "}catch(__qE){}return __qOf.apply(this,arguments)};"
    + "__qW({t:Date.now(),note:\"" + MARKER + "\",pid:process.pid});";
}

/* 当前补丁产物的**前导片段**（含落点路径）。导出给测试与诊断用。
 *
 * ⚠ 它是补丁**字节**的一部分 ⇒ 改落点它就变 ⇒ 已经打过旧补丁的副本会被判成
 *   stale（qpApply 会先从 .orig 还原再重打）。测试靠它构造「当前版补丁」的样本，
 *   好把 current / stale / none 三态钉住。 */
export const PATCH_PREAMBLE = buildPreamble();

/* ---------------- 补丁点按**内容**定位，不按变量/函数名 ---------------- */
// 混淆后的标识符每个版本都不同（0.4.3 是 zri/sAi，0.4.2 是 Xri，0.3.3 是 QZr/yYr…），
// 写死名字等于每个版本都要改代码。这里用稳定的结构特征来匹配。
// 这些正则与 Python 版逐个字符对齐，务必同步修改。
const RX_ZRI = /if\(([\w$]+)&&([\w$]+)\)return\{url:([\w$]+)\(([\w$]+),([\w$]+)\),path:\5,authMode:"authenticated",headers:\{\.\.\.await ([\w$]+)\(\1\),"x-gw-user-id":\2\}\};/g;
const RX_SAI = /async function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+)=\2\.method\.toUpperCase\(\),/g;
const RX_CATALOG = /"invalid_response";let ([^=]+)=([\w$]+)\(await ([\w$]+)\.text\(\)\),[\w$]+=JSON\.parse\(\1\);(?=[\w$]+\(\{requestId:[\w$]+,trigger:"model_catalog_fetch")/g;

function zriReplacement(m) {
  const [all, tok, uid, urlfn, av, pt, hdrfn] = m;
  return "if(" + tok + "&&" + uid + "){"
    + "let __qH={...await " + hdrfn + "(" + tok + "),\"x-gw-user-id\":" + uid + "};"
    // 令牌文件：jt- jobToken 每次客户端启动都轮换，中转按此文件现读
    + "try{__qWw(__qTok,JSON.stringify({token:" + tok + ",userId:" + uid + ",at:Date.now()}))}catch(__qE){}"
    + "try{__qHf(__qOut,JSON.stringify({t:Date.now(),via:\"zri\",h:__qH})+\"\\n\")}catch(__qE){}"
    + "return{url:" + urlfn + "(" + av + "," + pt + "),path:" + pt + ",authMode:\"authenticated\",headers:__qH}}";
}

function saiReplacement(m) {
  const [all, fn, a, b, c, v] = m;
  return "async function " + fn + "(" + a + "," + b + "," + c + "){"
    + "const __qH=(" + a + "&&" + a + ".init&&" + a + ".init.headers)||{};"
    + "try{__qHf(__qOut,JSON.stringify({t:Date.now(),via:\"sai\",op:" + a + "&&" + a + ".operation,"
    + "cls:" + a + "&&" + a + ".requestClass,url:" + a + "&&" + a + ".url,headers:__qH,"
    + "body:(" + a + "&&" + a + ".init&&" + a + ".init.body)?String(" + a + ".init.body).slice(0,8000):\"\""
    + "}+\"\\n\"))}catch(__qE){}"
    + "let " + v + "=" + a + ".method.toUpperCase(),";
}

function catalogReplacement(m) {
  const [all, dec] = m;
  // 与 Python 版逐字节一致：不额外加花括号，直接接在原语句之后。
  // （该处本就在一个函数体的语句位置，`E=E;try{...}catch{}` 是合法语句序列。）
  return all + dec + "=" + dec + ";try{__qWw(__qMod," + dec + ")}catch(__qE){}";
}

/* ---------------- 安装位置发现（不写死盘符/路径） ---------------- */
// 与 Python 版 qoder_bases() 对齐：本机 Qoder 装在 D 盘，新电脑可能是 C 盘或别的用户目录。
function qoderBases() {
  const out = [];
  const push = (p) => { if (p && existsSync(p) && isDir(p) && !out.includes(p)) out.push(p); };
  const local = process.env.LOCALAPPDATA || "";
  for (const sub of ["Qoder", path.join("Programs", "Qoder")]) {
    if (local) push(path.join(local, sub));
  }
  for (const k of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
    if (process.env[k]) push(path.join(process.env[k], "Qoder"));
  }
  // 用户资料可能落在非 C 盘。USERPROFILE 给出本账户 profile 目录名，
  // 据此拼出各盘符上同名 profile 的标准安装位置。
  const profile = path.basename(process.env.USERPROFILE || "Users") || "Users";
  const tails = [
    path.join("Users", profile, "AppData", "Local", "Programs", "Qoder"),
    path.join("Users", profile, "AppData", "Local", "Qoder"),
    path.join("Users", profile, "AppData", "Local", "Programs", "Qoder CN"),
    path.join("Programs", "Qoder"),
  ];
  for (let c = 67; c <= 90; c++) {
    const root = String.fromCharCode(c) + ":\\";
    if (!existsSync(root)) continue;
    for (const t of tails) push(path.join(root, t));
  }
  return out;
}

function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

// 发现所有 worker 副本：每个安装根下的 .qoder-versions/<ver>/resources 与根 resources/
function workerTargets() {
  const found = [];
  for (const base of qoderBases()) {
    const roots = [];
    const vdir = path.join(base, ".qoder-versions");
    if (isDir(vdir)) {
      for (const v of readdirSync(vdir).sort()) {
        roots.push([v, path.join(vdir, v, "resources")]);
      }
    }
    roots.push(["(root)", path.join(base, "resources")]);
    for (const [ver, res] of roots) {
      const p = path.join(res, "app.asar.unpacked", REL);
      if (existsSync(p)) found.push({ base, ver, file: p });
    }
  }
  return found;
}

// 被有意排除的国内版（仅用于提示）
function cnCopies() {
  const out = [];
  for (const base of qoderBases()) {
    const roots = [];
    const vdir = path.join(base, ".qoder-versions");
    if (isDir(vdir)) {
      for (const v of readdirSync(vdir).sort()) roots.push([v, path.join(vdir, v, "resources")]);
    }
    roots.push(["(root)", path.join(base, "resources")]);
    for (const [ver, res] of roots) {
      const p = path.join(res, "app.asar.unpacked", REL_CN);
      if (existsSync(p)) out.push({ base, ver, file: p });
    }
  }
  return out;
}

function isPatched(data) {
  const pre = buildPreamble();
  return data.slice(0, pre.length) === pre;
}

/* 带**任何**版本补丁的痕迹（不看 preamble 是否与当前一致）。
 *
 * 为什么需要它：落点路径是**写进补丁产物字节里**的（preamble 硬编码）⇒ 一旦
 * 落点改过（Temp → 数据目录），preamble 就变了 ⇒ `isPatched` 对旧补丁副本返回
 * false ⇒ 而旧补丁已经把源码里的补丁点**替换掉**了 ⇒ 在那份文件上再找补丁点
 * 必然是 0 处 ⇒ 「一键装补丁」会把每一份旧补丁副本报成失败。
 *
 * 判据取文件**开头**若干字节：MARKER 在 preamble 末尾，而 preamble 就在文件最
 * 前面（worker 全文 33MB，不能整读）。 */
function hasAnyPatchMark(data) {
  return typeof data === "string" && data.slice(0, 4096).includes(MARKER);
}

/* 补丁态三分：current（当前版本补丁）/ stale（旧版补丁，要先还原再重打）/ none。
 *
 * 抽成纯函数是为了能**测**：qpApply 里那套「跳过 / 先还原 / 直接打」的分支，
 * 以前没有测试能碰（要 33MB 的真 worker 才走得到），于是「改落点 ⇒ 旧补丁副本
 * 全部报失败」这类问题只能等真机踩到才发现。
 *
 * ⚠ stale 的判据是「带补丁痕迹、但不是当前 preamble」—— 不是「有没有 MARKER」：
 *   当前 preamble 自己也含 MARKER。 */
export function patchState(data) {
  if (typeof data !== "string") return "none";
  if (isPatched(data)) return "current";
  if (hasAnyPatchMark(data)) return "stale";
  return "none";
}

/* ---------------- 打补丁 / 还原 / 状态 ---------------- */

// 返回 { out, notes }；找不到唯一 zri 点则抛异常（说明该版本结构已变）
// 入参必须是 **字符串**（内部按 latin1 读写，见 qpApply）。传 Buffer 会一路
// 走到 data.matchAll 才炸出 "matchAll is not a function" —— 那个报错看不出真因，
// 所以在这里先挡一道并说清楚。
export function patchBytes(data) {
  if (typeof data !== "string") {
    throw new Error(`patchBytes 需要字符串（本模块按 latin1 读写），收到 ${Buffer.isBuffer(data) ? "Buffer" : typeof data}——请用 readFileSync(file, "latin1") 读取`);
  }
  const z = [...data.matchAll(RX_ZRI)];
  if (z.length !== 1) {
    throw new Error("鉴权头补丁点匹配 " + z.length + " 处（应为 1）——该版本结构可能已改变");
  }
  const edits = [{ m: z[0], rep: zriReplacement(z[0]) }];
  const notes = ["zri"];

  const s = [...data.matchAll(RX_SAI)];
  if (s.length === 1) { edits.push({ m: s[0], rep: saiReplacement(s[0]) }); notes.push("sai"); }
  else if (s.length > 1) throw new Error("传输层补丁点匹配 " + s.length + " 处（应为 0 或 1）");
  else notes.push("无sai(该版本无此函数，仅抓令牌)");

  const c = [...data.matchAll(RX_CATALOG)];
  if (c.length === 1) { edits.push({ m: c[0], rep: catalogReplacement(c[0]) }); notes.push("catalog"); }
  else if (c.length > 1) throw new Error("模型目录补丁点匹配 " + c.length + " 处（应为 0 或 1）");
  else notes.push("无catalog(该版本结构不同，不导出模型列表)");

  // 已按起点降序应用（从后往前替换，避免打乱后面的偏移）
  edits.sort((a, b) => b.m.index - a.m.index);
  const pristine = data.length;
  let body = data;
  for (const e of edits) {
    body = body.slice(0, e.m.index) + e.rep + body.slice(e.m.index + e.m[0].length);
  }
  const out = buildPreamble() + body;
  const delta = edits.reduce((n, e) => n + (e.rep.length - e.m[0].length), 0)
    + buildPreamble().length;
  if (out.length !== pristine + delta) {
    throw new Error("长度异常 " + out.length + " != " + (pristine + delta));
  }
  return { out, notes: notes.join("+") };
}

// apply：给所有副本打补丁（已在补丁态的跳过）；返回逐条结果
//
// ⚠ `targetsOverride` 只给测试用：真机路径是 workerTargets()（扫 Qoder 安装目录），
//   那条路要 33MB 的真 worker 才走得到 ⇒ 没法在测试里造 ⇒ 旧补丁态「先还原再重打」
//   那个分支会永远没有测试覆盖。所以这里留一个注入口，测试用假的副本文件走同一条路。
export function qpApply(targetsOverride) {
  const targets = Array.isArray(targetsOverride) ? targetsOverride : workerTargets();
  const results = [];
  let ok = 0, fail = 0, already = 0, refreshed = 0;
  for (const t of targets) {
    const bak = t.file + ".orig";
    let data = readFileSync(t.file, "latin1");
    /* ⚠ 补丁态先判清楚：current（跳过）/ stale（旧版补丁，要先还原再重打）/ none（直接打）。 */
    const st = patchState(data);
    if (st === "current") {
      already++; ok++;
      results.push({ ver: t.ver, file: t.file, state: "已打补丁", note: "跳过" });
      continue;
    }
    /* ⚠ **旧补丁态**：preamble 与当前不一致（落点改过）⇒ 这份文件里的补丁点
     *   已经被替换掉了 ⇒ 直接在上面找补丁点必然 0 处 ⇒ 报「结构可能已改变」，
     *   而真相是「这只是上一版的补丁」。有 .orig 备份就**先还原再重打**。
     *   少了这一步，改落点后第一次点「一键装补丁」会把所有旧补丁副本报成失败。 */
    let restored = false;
    if (st === "stale") {
      if (existsSync(bak)) {
        try { data = readFileSync(bak, "latin1"); restored = true; }
        catch { /* 读不出来就按原样试，失败时报错 */ }
      } else {
        fail++;
        results.push({
          ver: t.ver, file: t.file, state: "失败",
          note: "这个副本带旧版补丁、但没有 .orig 备份可还原——请先点「还原客户端」，再点「一键装补丁」",
        });
        continue;
      }
    }
    let out, notes;
    try { ({ out, notes } = patchBytes(data)); }
    catch (e) {
      fail++;
      results.push({
        ver: t.ver, file: t.file, state: "失败",
        note: String(e && e.message || e)
          + (st === "stale" ? "（该副本疑似已带补丁：先点「还原客户端」再点「一键装补丁」）" : ""),
      });
      continue;
    }
    try {
      if (!existsSync(bak)) copyFileSync(t.file, bak);
      writeFileSync(t.file, Buffer.from(out, "latin1"));
    } catch (e) {
      fail++;
      results.push({ ver: t.ver, file: t.file, state: "写入失败", note: String(e && e.message || e) });
      continue;
    }
    ok++;
    if (restored) refreshed++;
    results.push({
      ver: t.ver, file: t.file, state: "已打补丁",
      note: (restored ? "已从备份还原后重打 · " : "") + "补丁点 " + notes,
    });
  }
  return { ok, fail, already, refreshed, total: targets.length, results, tokenFile: TOKFILE, cn: cnCopies().length };
}

// revert：把备份写回去
export function qpRevert() {
  const targets = workerTargets();
  const results = [];
  let n = 0;
  for (const t of targets) {
    const bak = t.file + ".orig";
    if (!existsSync(bak)) continue;
    try {
      copyFileSync(bak, t.file);
      n++;
      results.push({ ver: t.ver, file: t.file, state: "已还原" });
    } catch (e) {
      results.push({ ver: t.ver, file: t.file, state: "还原失败", note: String(e && e.message || e) });
    }
  }
  return { reverted: n, total: targets.length, results };
}

/* 版本号比较：把 "0.5.1" / "0.4.11" / "0.10.0" 按**数字段**比大小。
 * 根 resources 那份记作 "(root)" ⇒ **最小**（它是安装时的旧副本，不是升级后的活跃版本）。
 * ⚠ 不用文件 mtime 判「哪个在跑」：打补丁本身会 writeFileSync ⇒ mtime 变成"现在"，
 *   于是刚打完补丁时「最新 mtime」会指向**最后被打的那份**（根 resources），
 *   而不是真正在跑的那个版本目录 —— 那会把判据带偏。版本号是稳定的。 */
function verCompare(a, b) {
  if (a === b) return 0;
  if (a === "(root)") return -1;
  if (b === "(root)") return 1;
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
export { verCompare };

// status：每个副本的补丁态 + 令牌文件新鲜度
export function qpStatus() {
  const targets = workerTargets();
  const pre = Buffer.from(buildPreamble(), "latin1");
  const isPatchedFile = (p) => {
    // 只读文件头即可判断（前导 preamble 完全一致）。worker 有 33MB，绝不能整文件读——
    // 状态接口每轮轮询都会调，整读 4 份 = 132MB/次。
    let fd;
    try {
      fd = openSync(p, "r");
      const buf = Buffer.alloc(pre.length);
      const n = readSync(fd, buf, 0, pre.length, 0);
      return n >= pre.length && buf.equals(pre);
    } catch { return false; }
    finally { if (fd !== undefined) try { closeSync(fd); } catch { } }
  };
  const copies = targets.map((t) => ({
    ver: t.ver, file: t.file,
    patched: isPatchedFile(t.file),
    backedUp: existsSync(t.file + ".orig"),
  }));
  /* 「当前活跃版本」= 版本号最大的那一份（根 resources 记作最小）。
   * ⚠ 它是**就绪判据**的关键：Qoder 升级会新增版本目录，补丁不会自动跟过去 ⇒
   *   「老版本那份还带着补丁」不等于「现在跑的那份带补丁」。面板只报
   *   patchedCount>0 会把这种情况说成「补丁已装」，而实际抓不到令牌。 */
  let latest = null;
  for (const c of copies) if (!latest || verCompare(c.ver, latest.ver) > 0) latest = c;
  let token = null, tokenAt = null, tokenFresh = false;
  try {
    const j = JSON.parse(readFileSync(TOKFILE, "utf8"));
    if (j && typeof j.token === "string" && j.token.trim()) {
      token = j.token.trim();
      tokenAt = j.at || null;
      // 5 分钟内有写入视为「新鲜」（Qoder 在跑）
      tokenFresh = typeof tokenAt === "number" && (Date.now() - tokenAt) < 5 * 60 * 1000;
    }
  } catch { }
  return {
    found: copies.length,
    patchedCount: copies.filter((c) => c.patched).length,
    copies,
    latest: latest ? { ver: latest.ver, file: latest.file, patched: latest.patched } : null,
    tokenFile: TOKFILE,
    token: token ? token.slice(0, 14) + "…" : null,
    tokenAt, tokenFresh,
    cn: cnCopies().length,
  };
}

export const QODER_PATCH_PATHS = { OUT, TOKFILE, MODELFILE, REL, DATA_DIR };

/**
 * qdFilePath —— 把「令牌 / 模型快照文件」的路径**归位**到本机的数据目录。
 *
 * ## 为什么要有这个函数
 *
 * 落点曾经**分叉**过：补丁写 `os.tmpdir()`、中转读数据目录 ⇒ 补丁明明装好了，
 * 中转永远读不到令牌（面板显示「未读到」）。根因是**落点被算了两遍**——
 * 两遍各算一次，早晚分叉。
 *
 * ⇒ 现在落点只有**一处出处**（本模块的 `QODER_PATCH_PATHS`），中转侧不再自己算；
 * 而 config.json 里**历史遗留**的路径要由本函数归位，否则老配置会一直指着
 * 一个没人再写的文件。
 *
 * ## 为什么是「**一律归位**」而不是「看形状猜」
 *
 * 这个字段**不是用户能设的**：面板只显示不可编辑、种子配置与 publish-seed 每次
 * 都把它清空。而它的正确值**只有一个** —— 补丁实际会写的地方。
 *
 * ⚠ 补丁的落点是**硬编码在补丁字节里**的（preamble），**它不读 config.json**
 *   ⇒ 用户把这个字段指到别处，补丁也不会写在那儿 ⇒ 只会「读不到令牌」。
 * ⇒ 所以历史上任何别的值（旧的临时目录、别的机器带来的死路径、手改的）都归位。
 *
 * ⚠ 早先那版按「形状」判（临时目录 + 同名 ⇒ 归位），看着更精细，实则**更脆**：
 *   它依赖 `os.tmpdir()` 的**当前**值，而 TEMP 环境变量一改（用户改了、某个软件
 *   改了、跑在别的壳里）就判不中 ⇒ 老配置继续指着死路径 ⇒ 白归位。
 *
 * @param {string} v config.json 里存的那个路径
 * @param {string} name 文件名（"qoder-token.json" / "qoder-models.json"）
 * @param {string} dataDir 本机的数据目录
 * @returns {string}
 */
export function qdFilePath(v, name, dataDir) {
  const def = path.join(dataDir, name);
  if (typeof v !== "string" || !v.trim()) return def;
  const norm = path.normalize(v.trim());
  // 已经是默认落点 ⇒ 原样留着（幂等，别把大小写/斜杠差异也改掉）
  if (norm.toLowerCase() === def.toLowerCase()) return v;
  return def;
}
