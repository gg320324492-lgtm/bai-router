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
//   新电脑上没人跑过 → %TEMP%\qoder-token.json 不存在 → 面板显示「未读到」。
//   本模块把同一套补丁算法用 Node 重写（Electron 自带 Node，零外部依赖），
//   由面板一键调用，把「装 Python + 手动跑脚本」彻底消掉。
//
// 与 Python 版保持**逐字节一致**的补丁产物，两边可以互相 apply/revert 不打架。
// 补丁点按**内容**定位（混淆后变量名各版本不同），新版本装好后重跑即可，不用改代码。

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// worker 在 resources 下的相对路径（各版本一致）
const REL = path.join("node_modules", "@qoder-ai", "qoder-agent-sdk", "dist",
  "_worker", "qoder-worker-runtime.obf.mjs");
// 国内版 Qoder CN 的包名不同（scope 相同）——有意不打，理由见下
const REL_CN = REL.replace("qoder-agent-sdk", "qoder-cn-agent-sdk");

// 补丁产物落盘位置（与 Python 版一致，沿用 %TEMP%）
const TEMP = os.tmpdir();
const OUT = path.join(TEMP, "qoder-hdr.jsonl");
const TOKFILE = path.join(TEMP, "qoder-token.json");
const MODELFILE = path.join(TEMP, "qoder-models.json");

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
export function qpApply() {
  const targets = workerTargets();
  const results = [];
  let ok = 0, fail = 0, already = 0;
  for (const t of targets) {
    const data = readFileSync(t.file, "latin1");
    if (isPatched(data)) {
      already++; ok++;
      results.push({ ver: t.ver, file: t.file, state: "已打补丁", note: "跳过" });
      continue;
    }
    let out, notes;
    try { ({ out, notes } = patchBytes(data)); }
    catch (e) {
      fail++;
      results.push({ ver: t.ver, file: t.file, state: "失败", note: String(e && e.message || e) });
      continue;
    }
    const bak = t.file + ".orig";
    try {
      if (!existsSync(bak)) copyFileSync(t.file, bak);
      writeFileSync(t.file, Buffer.from(out, "latin1"));
    } catch (e) {
      fail++;
      results.push({ ver: t.ver, file: t.file, state: "写入失败", note: String(e && e.message || e) });
      continue;
    }
    ok++;
    results.push({ ver: t.ver, file: t.file, state: "已打补丁", note: "补丁点 " + notes });
  }
  return { ok, fail, already, total: targets.length, results, tokenFile: TOKFILE, cn: cnCopies().length };
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
    tokenFile: TOKFILE,
    token: token ? token.slice(0, 14) + "…" : null,
    tokenAt, tokenFresh,
    cn: cnCopies().length,
  };
}

export const QODER_PATCH_PATHS = { OUT, TOKFILE, MODELFILE, REL };
