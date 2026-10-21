/**
 * scripts/wb-capture-report-test.mjs —— 「令牌捕获其实成功了，界面却报获取失败」。
 *
 * ## 用户看到的（两件事同时成立，缺一不可）
 *     访问令牌: 已捕获   有效期至: …（剩 28 天）   刷新令牌: 有
 *     ✗ 获取失败：读取超时（超过 12 秒）
 *   用户据此以为令牌没抓到，于是在另一台电脑上反复「完全退出客户端 → 重试」。
 *
 * ## 三个原因，一条一条地被本文件钉住
 *   ① POST /api/wb/capture 会阻塞最长 10 分钟（要等用户在客户端里发消息），
 *      而面板 api() 的默认读超时只有 12 秒 → 12 秒必放弃，**服务端还在正常等着钩子**。
 *   ② cards/token-capture.js 的轮询只更新进度文字，**从不报告完成**。
 *   ③ /api/wb/capture/status 不报本次捕获的**结果**，前端即使继续轮询也判断不出结束。
 *
 * ## 本文件怎么验的
 *   ★ 端到端：把 server.mjs 里**真源码**（wbCaptureRestore / wbCaptureToken /
 *     wbCaptureStatusPayload / wbCaptureBody / keyFp）切出来，挂在一个真 http 服务上，
 *     真 socket、真挂钟、真 12 秒客户端超时（面板 api() 的真源码）。
 *     为什么不对着 spawn 起来的 server.mjs 跑捕获：findWbCliScript 会查注册表和
 *     C:\Program Files，真跑一次捕获就会**往用户真实的 WorkBuddy 安装目录里注入钩子**，
 *     还会去踢 sidecar 进程 —— 那不是测试敢碰的。状态接口契约那一组仍走真 server.mjs。
 *   ★ 前端：cards/token-capture.js 的**真源码**跑在一个最小 DOM 沙箱里，
 *     定时器全部被记账，结束后逐个核对没有野定时器残留。
 *   ★ 明文外泄：塞一个明显是假的令牌进去，断言它**不出现在**任何一处响应/文案里。
 *
 * ## 反向对照
 *   文件末尾 SABOTAGE 表 + scripts/wb-capture-report-sabotage-run.mjs（grep SABOTAGE 可定位）。
 *   判据只有一个——改回改前行为，测试必须红。严禁恒真断言。
 *
 * ## 红线
 *   🔴 全文没有一个真实令牌/API key。夹具里的令牌是明显假的占位串。
 *   🔴 落盘只在 os.tmpdir() 下的临时目录 + BAI_DATA_DIR，**绝不碰真实 %APPDATA%\bai-router**；
 *      端口动态挑空闲，全部落在 17xxx 段；进程只按 **PID** 收，绝不用 /IM。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER_PATH = path.join(REPO, "src", "server", "server.mjs");
const PANEL_PATH = path.join(REPO, "src", "server", "panel-common.js");
const CARD_PATH = path.join(REPO, "src", "server", "cards", "token-capture.js");
const DEFAULTS_JSON = path.join(REPO, "src", "server", "config.defaults.json");
const SERVER_SRC = readFileSync(SERVER_PATH, "utf8");
const PANEL_SRC = readFileSync(PANEL_PATH, "utf8");
const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-wbcap-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 明显不是真令牌的假凭据（红线：绝不写真实令牌）。写成 JWT 三段的样子只是为了让
   keyFp 的脱敏形态有意义，绝不是任何真实凭证。 */
const TOK_WITH_REFRESH = "eyJhbGciOiJIUzI1NiJ9.FAKE-DUMMY-ACCESS-TOKEN-WITH-REFRESH-000111222333444555666777888999";
const TOK_NO_REFRESH = "eyJhbGciOiJIUzI1NiJ9.FAKE-DUMMY-ACCESS-TOKEN-NO-REFRESH-abcdefghijklmnopqrstuvwx";
const REFRESH_FAKE = "fake-refresh-token-not-real";

/* ====================================================================== *
 * 0. 抠真源码（不是抄一份重写）。锚点对不上当场炸，不会静默验错代码。
 * ====================================================================== */
/* 块注释收支是否平衡（切片若停在注释中间，求值出来就是一段语法错误）。
 * 判据只认**行首**的开标记，和**空白前导**的闭标记 —— 本仓库里 `[\r\n]` 后跟斜杠星
 * 这种正则字面量会被朴素的闭标记计数误判成注释结束（前导是 `]`，注释结束不可能
 * 紧跟在 `]` 后面，按这个特征排除掉）。 */
function commentBalance(src) {
  let open = 0, close = 0;
  const OPEN = new RegExp("^\\s*/\\*", "g");
  const CLOSE = new RegExp("(?:^|\\s)\\*\\/", "g");
  const IN_RE = new RegExp("\\]\\*\\/", "g");
  for (const l of src.split("\n")) {
    open += (l.match(OPEN) || []).length;
    close += (l.match(CLOSE) || []).length - (l.match(IN_RE) || []).length;
  }
  return { open, close };
}
function sliceBetween(src, startAnchor, endAnchor) {
  const i = src.indexOf(startAnchor);
  assert.ok(i >= 0, `抠源码失败：找不到 ${JSON.stringify(startAnchor)}`);
  const j = src.indexOf(endAnchor, i + startAnchor.length);
  assert.ok(j > i, `抠源码失败：${JSON.stringify(startAnchor)} → ${JSON.stringify(endAnchor)} 没找到终点`);
  const out = src.slice(i, j);
  const bal = commentBalance(out);
  assert.equal(bal.open, bal.close,
    `切片停在注释中间（/*=${bal.open} */=${bal.close}）：${JSON.stringify(startAnchor)}`);
  return out;
}
/* 面板里这些函数缩进在 IIFE 内，切出来后统一去掉两格，好放进 new Function。 */
const dedent = (src) => src.split("\n").map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join("\n");

/* ---- server.mjs 侧 ---- */
const SRV_RESTORE = sliceBetween(SERVER_SRC,
  "async function wbCaptureRestore() {",
  "const WB_CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;");
const SRV_CAPTURE = sliceBetween(SERVER_SRC,
  "const WB_CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;",
  "/* /api/wb/capture/status 的响应体。");
const SRV_STATUS = sliceBetween(SERVER_SRC,
  "/* /api/wb/capture/status 的响应体。",
  "/* POST /api/wb/capture 的处理体。");
const SRV_BODY = sliceBetween(SERVER_SRC,
  "/* POST /api/wb/capture 的处理体。",
  "// WorkBuddy 网关对 Claude Code");
const SRV_KEYFP = sliceBetween(SERVER_SRC, "function keyFp(k) {", "function desktopConfigFile() {");

/* 捕获窗口缩到 windowMs（毫秒）。**只换这一个数字**，其余逐字是生产源码 ——
   「等 10 分钟」与「等 3 秒」走的是同一段代码，否则测不出 10 分钟那条路的正确性。 */
const SRV_CAPTURE_PARAM = SRV_CAPTURE.replace(
  "const WB_CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;",
  "const WB_CAPTURE_TIMEOUT_MS = D.windowMs;");
assert.notEqual(SRV_CAPTURE_PARAM, SRV_CAPTURE, "捕获窗口参数化没打上 —— 超时那条用例会失去意义");

const makeCapture = new Function("D", `
  "use strict";
  const { fsPromises, existsSync, readFileSync, writeFileSync, rmSync, path, WB_BACKUP_FILE, log,
          findWbCliScript, wbMd5, WB_CAPTURE_HOOK, DATA_DIR, wbKickHostSession,
          wbClientRunningBefore, wbClientRestartedAfter, wbClientExeFromScript, wbAutoRestartClient,
          loadCfg, saveCfg, wbTokenExp } = D;
  const WB_PREWARM_GRACE_MS = 25000;
  let wbCapState = { active: false, startedAt: null, error: null, p: "wb" };
  ${SRV_RESTORE}
  ${SRV_CAPTURE_PARAM}
  ${SRV_STATUS}
  ${SRV_BODY}
  ${SRV_KEYFP}
  return { wbCaptureToken, wbCaptureStatusPayload, wbCaptureBody, keyFp,
           WB_CAPTURE_RESULT_TTL_MS, state: () => wbCapState };
`);

/* ---- panel-common.js 侧 ---- */
/* api + postJSON 必须一起切：postJSON 只是 api 的一层壳，两者在源码里紧挨着。 */
const PANEL_API = dedent(sliceBetween(PANEL_SRC,
  "async function api(path, opts) {",
  "const CAP_WINDOW_FALLBACK_MS = 10 * 60 * 1000;"));
const PANEL_CAPTO = dedent(sliceBetween(PANEL_SRC,
  "const CAP_WINDOW_FALLBACK_MS = 10 * 60 * 1000;",
  "/* 状态语义色只有四态 + 一色品牌。"));
const PANEL_SHOWRES = dedent(sliceBetween(PANEL_SRC,
  "function showResult(el, text, good) {",
  "/* --- 2.4 备用升级"));
const PANEL_FALLBACK = dedent(sliceBetween(PANEL_SRC,
  "async function captureFallback(key, btn) {",
  "async function credAction(key, btn) {"));
assert.ok(PANEL_API.includes("const postJSON"), "api 切片必须把 postJSON 一起带上（它是 api 的一层壳）");

/* 名字不许和切片里声明的重名：D 只提供切片**没有**定义的东西
   （api / postJSON / capTimeoutMs / showResult / captureFallback 都由切片自己定义）。 */
const makePanel = new Function("D", `
  "use strict";
  const { fetchImpl, AbortSignalImpl, $, withBusy, refreshConfig, poll, nameOf } = D;
  const fetch = fetchImpl, AbortSignal = AbortSignalImpl;
  ${PANEL_API}
  ${PANEL_CAPTO}
  ${PANEL_SHOWRES}
  ${PANEL_FALLBACK}
  return { api, postJSON, capTimeoutMs, showResult, captureFallback };
`);

/* ====================================================================== *
 * 1. 最小 DOM（只够 cards/token-capture.js 跑起来）
 * ====================================================================== */
const VOID_TAGS = new Set(["input", "br", "hr", "img", "meta", "link"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const unesc = (s) => String(s).replace(/&(#?\w+);/g, (_, e) => (ENTITIES[e] != null ? ENTITIES[e] : _));

function parseAttrs(s) {
  const out = {};
  const re = /([a-zA-Z_:@][-\w:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s || ""))) {
    out[m[1]] = unesc(m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] != null ? m[5] : "")));
  }
  return out;
}
function compileSel(sel) {
  const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]*\])*)$/.exec(String(sel).trim());
  assert.ok(m, `测试 DOM 不支持这个选择器：${sel}`);
  const parts = [];
  const re = /\.([\w-]+)|\[([^\]=]+?)(?:=["']?([^\]"']*)["']?)?\]/g;
  let x;
  while ((x = re.exec(m[2] || ""))) {
    if (x[1]) parts.push({ t: "cls", v: x[1] });
    else parts.push({ t: "attr", k: x[2], v: x[3] });
  }
  return { tag: m[1] ? m[1].toUpperCase() : null, parts };
}
class TextNode {
  constructor(t) { this._text = t; this.children = []; this.parentNode = null; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v == null ? "" : v); }
  get innerHTML() { return this._text; }
}
class El {
  constructor(tag, attrs) {
    this.tagName = String(tag || "div").toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this._text = "";
    this.className = "";
    this.value = "";
    this.readOnly = false;
    this.disabled = false;
    this.isConnected = true;
    this.dataset = {};
    this.listeners = {};
    this.classList = {
      toggle: (n, on) => {
        const cur = new Set(String(this.className || "").split(/\s+/).filter(Boolean));
        if (on) cur.add(n); else cur.delete(n);
        this.className = [...cur].join(" ");
      },
    };
    for (const k of Object.keys(this.attrs)) {
      if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = this.attrs[k];
    }
  }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  appendChild(el) { el.parentNode = this; this.children.push(el); return el; }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
  }
  set textContent(v) { this._text = String(v == null ? "" : v); this.children = []; }
  get innerHTML() { return this.children.length ? this.children.map(serialize).join("") : this._text; }
  set innerHTML(v) { this.children = []; parseHTML(String(v), this); }
  matches(sel) {
    const c = compileSel(sel);
    if (c.tag && this.tagName !== c.tag) return false;
    return c.parts.every((p) => p.t === "cls"
      ? String(this.className || this.attrs.class || "").split(/\s+/).includes(p.v)
      : (p.v == null ? this.getAttribute(p.k) != null : this.getAttribute(p.k) === p.v));
  }
  _walk(fn) { for (const c of this.children) { if (!(c instanceof El)) continue; fn(c); c._walk(fn); } }
  querySelectorAll(sel) { const out = []; this._walk((e) => { if (e.matches(sel)) out.push(e); }); return out; }
  querySelector(sel) { let r = null; this._walk((e) => { if (!r && e.matches(sel)) r = e; }); return r; }
  closest(sel) { let e = this; while (e) { if (e.matches(sel)) return e; e = e.parentNode; } return null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type, target) { for (const fn of this.listeners[type] || []) fn({ target: target || this }); }
}
function serialize(el) {
  const a = Object.keys(el.attrs).map((k) => ` ${k}="${el.attrs[k]}"`).join("");
  const tag = el.tagName.toLowerCase();
  return VOID_TAGS.has(tag) ? `<${tag}${a}>` : `<${tag}${a}>${el.innerHTML}</${tag}>`;
}
function parseHTML(html, parent) {
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9-]+)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith("<!--")) continue;
    if (m[5] != null) { top().appendChild(new TextNode(m[5])); continue; }
    const tag = m[2].toLowerCase();
    if (m[1] === "/") {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }
    const el = new El(tag, parseAttrs(m[3]));
    top().appendChild(el);
    if (!VOID_TAGS.has(tag) && m[4] !== "/") stack.push(el);
  }
  return parent;
}

/* ====================================================================== *
 * 2. 捕获服务：真 server.mjs 源码 + 真 http 监听
 * ====================================================================== */
const takenPorts = new Set();
async function portInRange() {
  for (let p = 17100; p < 17999; p++) {
    if (takenPorts.has(p)) continue;
    const free = await new Promise((res) => {
      const s = net.createServer();
      s.once("error", () => res(false));
      s.once("listening", () => s.close(() => res(true)));
      s.listen(p, "127.0.0.1");
    });
    if (free) { takenPorts.add(p); return p; }
  }
  throw new Error("17xxx 段找不到空闲端口");
}
async function portsInRange(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await portInRange());
  assert.equal(new Set(out).size, n, `挑出来的端口必须互不相同：${out.join(",")}`);
  return out;
}

const procs = new Set();
function track(p) { procs.add(p); p.on("exit", () => procs.delete(p)); return p; }
function killAll() {
  for (const p of procs) {
    try { if (p.pid) spawnSync("taskkill", ["/PID", String(p.pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
    try { p.kill(); } catch { }
    /* 同上：管道不销毁，事件循环会被服务端自己拉起的子进程吊住。 */
    try { p.stdout && p.stdout.destroy(); } catch { }
    try { p.stderr && p.stderr.destroy(); } catch { }
    try { p.unref(); } catch { }
  }
  procs.clear();
}
const openSockets = new Set();
after(() => {
  killAll();
  for (const s of openSockets) { try { s.destroy(); } catch { } }
  try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { }
});

/**
 * 起一个捕获服务。
 *   windowMs    这一轮捕获等多久（默认后端的 10 分钟）
 *   postHoldMs  捕获**结束之后**，POST 的响应还要压多久才发出去（模拟服务端收尾慢/网络卡）。
 *               给个大数 = POST 一直挂着不回来 —— 正是用户遇到的那种局面。
 *   refuseFrom  从第 N 次 POST 起直接拒绝（模拟「上一次获取还在进行中」）：
 *               状态原样保留，于是上一轮留下的 done 仍然能被 status 读到。
 */
async function startCaptureServer(opts = {}) {
  const o = Object.assign({ windowMs: 600000, postHoldMs: 0, refuseFrom: Infinity }, opts);
  const dir = fs.mkdtempSync(path.join(TMPROOT, "cap-"));
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  /* 假 WorkBuddy CLI 脚本：只在临时目录里，绝不碰真实安装目录 */
  const script = path.join(dir, "app.asar.unpacked", "cli", "bin", "codebuddy");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  const original = "#!/usr/bin/env node\nconsole.log('codebuddy CLI')\n";
  fs.writeFileSync(script, original, "utf8");
  const outFile = path.join(dataDir, "wb-captured-token.json");

  let cfg = { wb: { accessToken: "", refreshToken: "" }, wbai: { accessToken: "", refreshToken: "" } };
  let runs = 0;
  const cap = makeCapture({
    windowMs: o.windowMs,
    fsPromises: fs.promises,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    rmSync: fs.rmSync,
    path,
    WB_BACKUP_FILE: path.join(dir, "wb-codebuddy.bak.json"),
    log: () => { },                       // 日志通道一律丢弃：绝不让令牌有机会进日志
    findWbCliScript: async () => script,
    wbMd5: (s) => "md5-" + String(s).length,
    WB_CAPTURE_HOOK: "\n// === BAI-CAPTURE-HOOK ===\n// === /BAI-CAPTURE-HOOK ===\n",
    DATA_DIR: dataDir,
    wbKickHostSession: async () => ({ action: "no_sidecar", detail: "测试桩：没有 WorkBuddy 后台" }),
    /* v1.0.82 新增：捕获流程会调它自动重启客户端。本文件只关心「捕获成功/失败怎么报」，
       自动重启本身由 wb-auto-capture-test.mjs 用假进程表专门验；这里给一个诚实的桩
       （不假装重启成功，免得掩盖了别的回归）。 */
    wbAutoRestartClient: async () => ({ action: "not_running", detail: "测试桩：客户端没有在运行", killed: 0 }),
    wbClientExeFromScript: () => null,
    wbClientRunningBefore: async () => false,
    wbClientRestartedAfter: async () => false,
    loadCfg: () => JSON.parse(JSON.stringify(cfg)),
    saveCfg: (c) => { cfg = JSON.parse(JSON.stringify(c)); },
    wbTokenExp: () => "2030-01-01T00:00:00.000Z",
  });

  const port = await portInRange();
  const sockets = new Set();
  const server = http.createServer(async (rq, rs) => {
    sockets.add(rs.socket); openSockets.add(rs.socket);
    rs.socket.on("close", () => { sockets.delete(rs.socket); openSockets.delete(rs.socket); });
    let body = {};
    if (rq.method === "POST") {
      const chunks = [];
      for await (const c of rq) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { }
    }
    const url = String(rq.url || "").split("?")[0];
    let payload;
    if (url === "/api/wb/capture/status") {
      payload = cap.wbCaptureStatusPayload();
    } else if (url === "/api/wb/capture") {
      if (runs >= o.refuseFrom) {
        /* 拒绝这一轮：wbCapState 原样不动 —— 上一轮的 done 仍然留在那儿。
           这正是「拿到旧结果」最容易发生的场景。 */
        payload = { ok: false, error: "上一次获取还在进行中（已等待 3 秒）。请稍候重试" };
      } else {
        runs++;
        payload = await cap.wbCaptureBody(body);
        if (o.postHoldMs > 0) await sleep(o.postHoldMs);   // 捕获结束后再压住响应
      }
    } else { rs.writeHead(404); rs.end("{}"); return; }
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${port}`, script, original, outFile, cap,
    cfg: () => cfg,
    state: () => cap.state(),
    runs: () => runs,
    /* 模拟「客户端发了一条带鉴权的请求」：钩子把令牌写到这个文件。 */
    fire(payload) { fs.writeFileSync(outFile, JSON.stringify(payload), "utf8"); },
    async waitActive(maxMs = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) { if (cap.state().active) return true; await sleep(100); }
      return false;
    },
    async close() {
      for (const s of sockets) { try { s.destroy(); } catch { } }
      await new Promise((r) => server.close(r));
      try { rmSync(dir, { recursive: true, force: true }); } catch { }
    },
  };
}

/* ====================================================================== *
 * 3. 卡片沙箱：真 cards/token-capture.js + 真 panel api() + 记账的定时器
 * ====================================================================== */
function mountCard(base) {
  const liveIntervals = new Set();
  const timers = { set: 0, cleared: 0 };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toUrl = (u) => (String(u).startsWith("http") ? String(u) : base + u);

  /* 真 api() + 真 postJSON + 真 capTimeoutMs：默认读超时 12 秒，正是用户被掐断的那条。 */
  const panel = makePanel({
    fetchImpl: (u, o) => fetch(toUrl(u), o),
    AbortSignalImpl: AbortSignal,
    $: () => null,
    withBusy: async (_btn, fn) => { await fn(); },
    refreshConfig: async () => { }, poll: () => { }, nameOf: (k) => k,
  });

  const sandbox = {
    window: {}, console,
    document: { getElementById: () => null },
    fetch: (u, o) => fetch(toUrl(u), o),
    AbortSignal,
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); liveIntervals.add(id); timers.set++; return id; },
    clearInterval: (id) => { timers.cleared++; liveIntervals.delete(id); return clearInterval(id); },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(CARD_PATH, "utf8"), sandbox, { filename: CARD_PATH });
  const mod = (sandbox.window.BAI_CARDS || {})["token-capture"];
  assert.ok(mod, "cards/token-capture.js 必须登记 window.BAI_CARDS[\"token-capture\"]");

  /* 一行凭据：.credrow[data-k=wb] 里画着捕获按钮 + 一个「jwt」宿主元素。 */
  const row = new El("div", { "class": "credrow", "data-k": "wb" });
  const captureBtn = new El("button", { "data-act": "capture" });
  captureBtn.textContent = "一键获取令牌";
  const manualBtn = new El("button", { "data-act": "manual" });
  const host = new El("span", {});
  row.appendChild(captureBtn); row.appendChild(manualBtn); row.appendChild(host);

  const results = [];
  const handlers = {};
  const apiCalls = [];
  const ctx = {
    $: (sel) => row.querySelector(sel),
    esc,
    rowsOfKind: (kind) => (kind === "jwt" ? [host] : []),
    cfgOf: () => ({}),
    stOf: () => ({ token: { configured: false } }),
    status: {},
    api: (p, o) => { apiCalls.push({ path: p, opts: o || {} }); return panel.api(toUrl(p), o); },
    showResult: (el, text, good) => { results.push({ text: String(text), good: !!good }); panel.showResult(el, text, good); },
    refreshConfig: async () => { },
    poll: () => { },
    registerCapture: (key, fn) => { handlers[key] = fn; },
    capTimeoutMs: panel.capTimeoutMs,
  };
  mod.mount(ctx);
  assert.equal(typeof handlers.wb, "function", "卡片必须接管 wb 那一行的捕获流程");
  return {
    row, captureBtn, manualBtn, host, results, handlers, apiCalls, timers, liveIntervals,
    resEl: () => host.querySelector('[data-role="res"]'),
    resultText: () => String((host.querySelector('[data-role="res"]') || {}).textContent || ""),
    resultClass: () => String((host.querySelector('[data-role="res"]') || {}).className || ""),
    progressVisible: () => host.querySelector('[data-role="prog"]').style.display !== "none",
    click: () => handlers.wb(captureBtn),
  };
}

/* ====================================================================== *
 * 4. 用例
 * ====================================================================== */

test("勾选自动重启时请求显式携带许可，完成后开关恢复可用", async () => {
  const srv = await startCaptureServer({ windowMs: 3000 });
  const ui = mountCard(srv.base);
  try {
    const box = ui.host.querySelector('[data-role="auto-restart"]');
    assert.ok(box);
    box.checked = true;
    const done = ui.click();
    assert.equal(box.disabled, true);
    assert.ok(await srv.waitActive());
    const request = ui.apiCalls.find((x) => x.path === "/api/wb/capture" && x.opts.method === "POST");
    assert.equal(JSON.parse(request.opts.body).autoRestart, true);
    srv.fire({ accessToken: TOK_WITH_REFRESH });
    await done;
    assert.equal(box.disabled, false);
  } finally { await srv.close(); }
});

/* ---------------------------------------------------------------- *
 * ★ ① 端到端复现：12 秒客户端超时 + 真阻塞捕获。
 *   改前：12 秒准时抛 TimeoutError → 「✘ 获取失败：读取超时（超过 12 秒）」，
 *          而服务端还在等钩子；用户据此以为没抓到。
 *   改后：POST 拿到的是后端给的捕获窗口 + 余量，14 秒后令牌一到就成功报出来。
 * ---------------------------------------------------------------- */
describe("★ ① 端到端：12 秒读超时不再把成功的捕获掐成失败", () => {
  let srv, ui;
  before(async () => { srv = await startCaptureServer(); ui = mountCard(srv.base); }, { timeout: 60000 });
  after(async () => { await srv.close(); });

  test("捕获阻塞 14 秒才拿到令牌：12 秒那一步不报失败，最后报成功", async () => {
    const done = ui.click();                        // 不 await：这一步要跑十几秒
    assert.ok(await srv.waitActive(), "后端应该正挂在捕获上（active=true）");

    /* POST 必须**不是** 12 秒默认值 —— 这是「12 秒必放弃」的直接反证 */
    const post = ui.apiCalls.find((c) => c.path === "/api/wb/capture" && c.opts.method === "POST");
    assert.ok(post, "卡片必须真的发 POST /api/wb/capture");
    assert.equal(JSON.parse(post.opts.body).autoRestart, false, "未勾选时必须向后端明确禁止自动重启");
    assert.ok(post.opts.timeoutMs > 12000,
      `POST 的读超时必须给足捕获窗口（实得 ${post.opts.timeoutMs}）—— 12 秒默认值会把成功掐成失败`);

    /* 卡在 12 秒这条线上：改前就是这里报「读取超时」 */
    await sleep(13000);
    assert.ok(!/获取失败|读取超时/.test(ui.resultText()),
      `12 秒之后绝不能报失败（实得「${ui.resultText().slice(0, 80)}」）`);
    assert.equal(srv.state().active, true, "12 秒时服务端应仍在正常等待钩子（active=true）");

    /* 14 秒：模拟客户端终于发了一条带鉴权的消息 */
    srv.fire({ accessToken: TOK_WITH_REFRESH, refreshToken: REFRESH_FAKE });
    await done;
    await sleep(1200);                              // 给轮询一拍

    assert.ok(/✔ 令牌获取成功/.test(ui.resultText()),
      `捕获成功后必须报成功（实得「${ui.resultText().slice(0, 90)}」）`);
    assert.ok(!/获取失败|读取超时/.test(ui.resultText()), "任何时刻都不能出现「获取失败」");
  }, { timeout: 90000 });

  test("★ 结果能从 /api/wb/capture/status 拿到（不必等那条长 POST）", async () => {
    const s = await fetch(srv.base + "/api/wb/capture/status").then((r) => r.json());
    assert.equal(s.done, true, "status 必须报 done —— 前端全靠它判断捕获结束了");
    assert.equal(s.ok, true);
    assert.ok(typeof s.masked === "string" && s.masked.length > 0, "必须带脱敏后的令牌");
    assert.equal(s.hasRefresh, true);
    assert.equal(s.error, null);
    assert.ok(Number(s.finishedAt) > 0, "必须带 finishedAt");
    assert.equal(s.startedAt, srv.state().startedAt, "status 的 startedAt 要能对上这一轮");
  }, { timeout: 60000 });   // 兜底超时：done 永不到达时**挂住**比失败更糟，会拖死 CI
});

/* ---------------------------------------------------------------- *
 * ★ ② 成功会被报出来（带脱敏令牌），且**明文令牌不外泄**。
 * ---------------------------------------------------------------- */
describe("★ ② 成功会被报出来，且令牌明文不外泄", () => {
  let srv, ui;
  before(async () => { srv = await startCaptureServer(); ui = mountCard(srv.base); });
  after(async () => { await srv.close(); });

  test("抓到令牌（有刷新）→ 报成功 + 带脱敏令牌；明文一处都不许出现", async () => {
    const done = ui.click();
    assert.ok(await srv.waitActive(), "后端应该正挂在捕获上");
    srv.fire({ accessToken: TOK_WITH_REFRESH, refreshToken: REFRESH_FAKE });
    await done;
    await sleep(1200);

    const txt = ui.resultText();
    assert.ok(/✔ 令牌获取成功/.test(txt), `必须报成功（实得「${txt.slice(0, 90)}」）`);
    assert.ok(!/未捕获到刷新令牌/.test(txt), "抓到了刷新令牌就不该再提醒「未捕获到刷新令牌」");
    assert.equal(ui.resultClass(), "result show good", "成功结果必须是 good 样式");
    /* 脱敏形态在：keyFp 的「前 7 字符 + … + 后 2 字符 + 长度」 */
    const fp = srv.cap.keyFp(TOK_WITH_REFRESH);
    assert.ok(txt.includes(fp), `成功文案里必须带脱敏后的令牌（期望含「${fp}」，实得「${txt.slice(0, 90)}」）`);
    assert.notEqual(fp, TOK_WITH_REFRESH);
    assert.ok(!txt.includes(TOK_WITH_REFRESH), "🔴 令牌明文绝不许出现在结果文案里");

    /* 🔴 明文一处都不许外泄 */
    const st = await fetch(srv.base + "/api/wb/capture/status").then((r) => r.text());
    assert.ok(!st.includes(TOK_WITH_REFRESH), "🔴 令牌明文绝不许出现在 /status 响应里");
    assert.ok(!st.includes(REFRESH_FAKE), "🔴 刷新令牌明文绝不许出现在 /status 响应里");
    assert.ok(!JSON.stringify(srv.state()).includes(TOK_WITH_REFRESH), "🔴 令牌明文绝不许留在服务端状态里");
    /* 但配置里确实写进去了（脱敏只是**显示**层的事，落盘要真令牌才对得上） */
    assert.equal(srv.cfg().wb.accessToken, TOK_WITH_REFRESH, "令牌必须真的写进 cfg.wb");
  }, { timeout: 60000 });   // 兜底超时：done 永不到达时**挂住**比失败更糟，会拖死 CI

  test("抓到令牌但没有刷新令牌 → 如实提醒「未捕获到刷新令牌」", async () => {
    const srv2 = await startCaptureServer();
    const ui2 = mountCard(srv2.base);
    const done = ui2.click();
    assert.ok(await srv2.waitActive(), "后端应该正挂在捕获上");
    srv2.fire({ accessToken: TOK_NO_REFRESH });
    await done;
    await sleep(1200);
    assert.ok(/✔ 令牌获取成功/.test(ui2.resultText()), "没有刷新令牌**不影响**成功");
    assert.ok(/未捕获到刷新令牌/.test(ui2.resultText()),
      `没有刷新令牌时必须如实说明（实得「${ui2.resultText().slice(0, 130)}」）`);
    assert.ok(!ui2.resultText().includes(TOK_NO_REFRESH), "🔴 令牌明文绝不许出现在结果文案里");
    await srv2.close();
  }, { timeout: 60000 });   // 兜底超时：done 永不到达时**挂住**比失败更糟，会拖死 CI
});

/* ---------------------------------------------------------------- *
 * ★ ③ 超时会被报出来（有结论的失败），而不是一直转圈。
 *   这里 POST **一直不返回**（服务端还在收尾），正是用户遇到的那种局面。
 * ---------------------------------------------------------------- */
describe("★ ③ 捕获超时会被报出来，而不是一直转圈", () => {
  let srv, ui;
  before(async () => {
    srv = await startCaptureServer({ windowMs: 3000, postHoldMs: 120000 });  // POST 挂着不回
    ui = mountCard(srv.base);
    ui.click().catch(() => { });          // 这条 POST 不会回来；异常由卡片自己吞
    assert.ok(await srv.waitActive(), "后端应该正挂在捕获上");
  }, { timeout: 30000 });
  after(async () => { await srv.close(); });

  test("捕获以超时结束 → 报「失败 + 超时原因」，进度面板收起", async () => {
    await sleep(7000);                    // 3 秒捕获结束 + 2 秒轮询的一拍
    const txt = ui.resultText();
    assert.ok(/✘ 获取失败/.test(txt), `超时必须报失败（实得「${txt.slice(0, 100)}」）`);
    assert.ok(/等待超时/.test(txt), `必须说清是等待超时（实得「${txt.slice(0, 130)}」）`);
    assert.ok(!/正在等待|仍在等待/.test(txt), "结束后不该再显示等待中的话");
    assert.equal(ui.resultClass(), "result show bad", "失败结果必须是 bad 样式");
    assert.equal(ui.progressVisible(), false, "结束后进度面板必须收起");
    assert.equal(ui.captureBtn.disabled, false, "结束后按钮必须可再点");
  }, { timeout: 60000 });   // 兜底超时：done 永不到达时**挂住**比失败更糟，会拖死 CI

  test("★ 轮询会停：结束后定时器必须全部清掉（不留野定时器）", async () => {
    assert.equal(ui.liveIntervals.size, 0,
      `完成后仍有 ${ui.liveIntervals.size} 个定时器在跑 —— 那是野定时器`);
    assert.ok(ui.timers.cleared >= 2,
      `两个定时器（文案推进 + 轮询）都必须 clearInterval（实得 cleared=${ui.timers.cleared}）`);
  }, { timeout: 60000 });   // 兜底超时：done 永不到达时**挂住**比失败更糟，会拖死 CI
});

/* ---------------------------------------------------------------- *
 * ★ ⑤ 结果必须对得上**本次**：上一轮留下的 done 不得被下一轮误读。
 * ---------------------------------------------------------------- */
describe("★ ⑤ 结果与本次捕获对得上", () => {
  test("上一轮的 done/ok 不会被这一轮误读成自己的结果", async () => {
    const srv = await startCaptureServer({ refuseFrom: 1, postHoldMs: 4000 });

    /* —— 第 1 轮：正常抓到令牌，状态里会留下 done/ok/masked —— */
    const ui1 = mountCard(srv.base);
    const done1 = ui1.click();
    assert.ok(await srv.waitActive(), "第 1 轮应该正挂在捕获上");
    srv.fire({ accessToken: TOK_WITH_REFRESH, refreshToken: REFRESH_FAKE });
    await done1;
    await sleep(600);
    const st1 = await fetch(srv.base + "/api/wb/capture/status").then((r) => r.json());
    assert.equal(st1.done, true, "第 1 轮结束后状态里确实留着 done");
    const staleMasked = st1.masked;
    assert.ok(staleMasked && staleMasked.length > 0, "第 1 轮确实留下了脱敏令牌");

    /* —— 第 2 轮：后端拒绝，状态原样保留（第 1 轮的 done 仍在）—— */
    const ui2 = mountCard(srv.base);
    ui2.click().catch(() => { });
    await sleep(5000);
    const txt = ui2.resultText();
    assert.ok(/上一次获取还在进行中/.test(txt),
      `第 2 轮必须报它自己的结果（实得「${txt.slice(0, 110)}」）`);
    assert.ok(!/令牌获取成功/.test(txt),
      `🔴 绝不能把上一轮的 done 报成这一轮的成功（实得「${txt.slice(0, 110)}」）`);
    assert.ok(!txt.includes(staleMasked), "🔴 上一轮留下的脱敏令牌不得出现在这一轮的结果里");
    await srv.close();
  }, { timeout: 60000 });   // 兜底超时：done 永不到达时**挂住**比失败更糟，会拖死 CI
});

/* ---------------------------------------------------------------- *
 * ④ panel-common 的兜底路径（没被卡片接管的那一行）。
 *    真 api() + 真 postJSON + 真 capTimeoutMs + 真 captureFallback，
 *    只把 fetch 换成本地桩（返回 12 秒超时的那个真异常）。
 * ---------------------------------------------------------------- */
  function panelFor(calls, slot, mode) {
    return makePanel({
      fetchImpl: async (u, o) => {
        const url = String(u);
        calls.push({ url, init: o || {} });
        if (/\/api\/wb\/capture\/status$/.test(url)) {
          return { ok: true, status: 200, json: async () => ({ timeoutMs: 600000, active: false, done: false }) };
        }
        if (/\/api\/wb\/capture$/.test(url)) {
          if (mode === "timeout") {
            /* 真 api() 会把这个 AbortError 认成超时并置 err.timedOut —— 走的正是真实路径 */
            const e = new Error("The operation was aborted due to timeout");
            e.name = "TimeoutError";
            throw e;
          }
          return { ok: true, status: 200, json: async () => ({ ok: true, masked: "eyJhbGc…99(83)" }) };
        }
        throw new Error("不该请求这个地址：" + url);
      },
      AbortSignalImpl: AbortSignal,
      $: () => slot,
      /* 与真 withBusy 同样的兜底：出错写进结果行（而不往外抛） */
      withBusy: async (_btn, fn, errSlot) => {
        try { await fn(); } catch (e) { errSlot.textContent = "出错了：" + e.message; }
      },
      refreshConfig: async () => { }, poll: () => { }, nameOf: (k) => k,
    });
  }

  test("兜底 POST 带上捕获窗口的 timeoutMs；成功如实报出来", async () => {
    const calls = [];
    const slot = new El("div", { id: "applyResult" });
    const panel = panelFor(calls, slot, "ok");
    await panel.captureFallback("wb", { textContent: "一键获取令牌" });
    const post = calls.find((c) => c.url.endsWith("/api/wb/capture"));
    assert.ok(post, "兜底路径必须真的发 POST /api/wb/capture");
    assert.ok(post.init.timeoutMs > 12000,
      `兜底 POST 同样不能走 12 秒默认值（实得 ${post.init.timeoutMs}）—— 成功会被掐成失败`);
    assert.ok(calls.some((c) => c.url.endsWith("/api/wb/capture/status")),
      "必须先问后端这次要等多久");
    assert.ok(/✔/.test(String(slot.textContent)) && /令牌已捕获/.test(String(slot.textContent)),
      `成功要如实报出来（实得「${String(slot.textContent).slice(0, 90)}」）`);
    assert.ok(!/获取失败|出错了/.test(String(slot.textContent)),
      `不该报失败（实得「${String(slot.textContent)}」）`);
  }, { timeout: 60000 });   // 兜底超时：done 永不到达时**挂住**比失败更糟，会拖死 CI

  test("兜底 POST 真的超时了 → 也不得说「获取失败」", async () => {
    const calls = [];
    const slot = new El("div", { id: "applyResult" });
    const panel = panelFor(calls, slot, "timeout");
    await panel.captureFallback("wb", { textContent: "一键获取令牌" });
    const txt = String(slot.textContent);
    assert.ok(!/获取失败|出错了|读取超时/.test(txt),
      `读超时**不等于失败** —— 兜底也不许说失败（实得「${txt.slice(0, 110)}」）`);
    assert.ok(/不代表失败|仍在后台/.test(txt),
      `必须如实说「捕获仍在后台继续」（实得「${txt.slice(0, 110)}」）`);
    const post = calls.find((c) => c.url.endsWith("/api/wb/capture"));
    assert.ok(post && post.init.timeoutMs > 12000,
      `即便这次真的超时了，timeoutMs 也必须是给足的（实得 ${post && post.init.timeoutMs}）`);
  }, { timeout: 60000 });   // 兜底超时：done 永不到达时**挂住**比失败更糟，会拖死 CI

/* ---------------------------------------------------------------- *
 * 真 server.mjs：状态接口契约
 * ---------------------------------------------------------------- */
describe("真 server.mjs 的状态接口契约", () => {
  let child, P, dataDir, killed = false;
  before(async () => {
    const ports = await portsInRange(9);
    P = { bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4], qd: ports[5], or: ports[6], panel: ports[7], mm: ports[8] };
    dataDir = fs.mkdtempSync(path.join(TMPROOT, "real-"));
    const cfg = JSON.parse(readFileSync(DEFAULTS_JSON, "utf8"));
    cfg.failover.enabled = false;
    /* ① 预置成一个必定命中探测的值 → applyProxy 首行短路，**不自重启**；
     * ② 同时把代理环境变量从子进程环境里摘掉。两件事缺一不可。 */
    cfg.proxy = "http://127.0.0.1:7897";
    cfg.relayPort = P.bai; cfg.panelPort = P.panel;
    for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) cfg[k] = { ...cfg[k], relayPort: P[k] };
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));
    const env = { ...process.env, BAI_DATA_DIR: dataDir, BAI_ENV_FIXED: "1", BAI_NO_PROXY_AUTODETECT: "1" };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    env.NO_PROXY = "127.0.0.1,localhost";
    child = track(spawn(process.execPath, [SERVER_PATH], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
    const out = [];
    child.stdout.on("data", (d) => out.push(String(d)));
    child.stderr.on("data", (d) => out.push(String(d)));
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) return; } catch { }
      await sleep(300);
    }
    throw new Error("真 server.mjs 40 秒内没把面板端口起起来。\n" + out.join("").slice(-800));
  }, { timeout: 90000 });
  after(() => {
    if (child && child.pid && !killed) {
      killed = true;
      try { spawnSync("taskkill", ["/PID", String(child.pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
      /* ⚠ 管道必须显式 destroy：不销毁的话，服务端自己拉起的子进程仍攥着继承来的
         stdout/stderr，node 的事件循环会被这些 PipeWrap 一直吊住 —— 全部用例都跑完了，
         进程还要多等一两分钟才肯退出（实测多等 104 秒）。 */
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { }
      try { child.unref(); } catch { }
    }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { }
  });

  test("刚启动时 status 报「没有结果」，而不是上一次遗留的结局", async () => {
    const s = await fetch(`http://127.0.0.1:${P.panel}/api/wb/capture/status`).then((r) => r.json());
    assert.equal(s.done, false, "没跑过捕获 ⇒ done=false");
    assert.equal(s.ok, false);
    assert.equal(s.masked, null, "没有令牌 ⇒ masked 必须是 null（不是空串，更不是明文）");
    assert.equal(s.hasRefresh, null, "没有结果时 hasRefresh 必须是 null（与 false 区分得开）");
    assert.equal(s.error, null);
    assert.equal(s.finishedAt, null);
    assert.equal(s.active, false);
    assert.equal(s.startedAt, null);
    assert.equal(s.timeoutMs, 600000, "捕获窗口 10 分钟 —— 前端就靠它给 POST 定 timeoutMs");
    for (const k of ["provider", "needRestart", "restarted", "elapsedMs", "remainMs",
      "gotAccessToken", "phase", "phaseText", "kick"]) {
      assert.ok(k in s, `status 少了原有字段 ${k}（回归保护）`);
    }
  }, { timeout: 60000 });   // 兜底超时：done 永不到达时**挂住**比失败更糟，会拖死 CI

  test("🔴 status 响应里不得出现任何形似 JWT 的长串", async () => {
    const s = await fetch(`http://127.0.0.1:${P.panel}/api/wb/capture/status`).then((r) => r.text());
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(s), "status 里不得出现 JWT 形态的长串");
  }, { timeout: 60000 });   // 兜底超时：done 永不到达时**挂住**比失败更糟，会拖死 CI
});

/* ====================================================================== *
 * SABOTAGE —— 「改坏」手法清单
 * 每一条都要**真的打到源码上跑一遍**，确认对应断言变红，再逐字还原。
 * 执行器：node scripts/wb-capture-report-sabotage-run.mjs
 *   S1 no-done-branch          去掉轮询里的「done → 收摊」分支      → ★① ★③ ★④ 必红
 *   S2 post-default-timeout    POST 改回走 12 秒默认超时             → ★① 必红
 *   S3 server-no-result        后端不再留存结果（done 永远 false）    → ★① ★③ ★⑤ 必红
 *   S4 no-startedat-check      去掉 startedAt 对账                   → ★⑤ 必红
 *   S5 no-clearinterval        收摊时不 clearInterval                → ★④ 必红
 *   S6 fallback-default-timeout 兜底 POST 改回 12 秒默认超时          → ④ 必红
 *   S7 fallback-timeout-as-failure 兜底把读超时当失败报出去           → ④ 必红
 *
 *   跑完执行器之后，源码里必须一条 SABOTAGE 标记都搜不到。
 * ====================================================================== */
export const SABOTAGE = [
  {
    name: "no-done-branch", file: "cards/token-capture.js",
    what: "把轮询里的「看到 done 就收摊并报结论」整段废掉（改回改前行为）",
    from: `          if (s && s.done && s.startedAt != null && s.startedAt !== run.prevStartedAt) {`,
    to: `          if (false && s && s.done && s.startedAt != null && s.startedAt !== run.prevStartedAt) {`,
    reds: "★① 端到端不再报成功 / ★③ 超时不再报失败 / ★④ 定时器不再被清",
  },
  {
    name: "post-default-timeout", file: "cards/token-capture.js",
    what: "把 POST 的 timeoutMs 拿掉，让它走 ctx.api() 的 12 秒默认值",
    from: `            timeoutMs: capTimeoutMs(run.windowMs),`,
    to: `            timeoutMs: undefined,`,
    reds: "★① 12 秒准时报「读取超时」",
  },
  {
    name: "server-no-result", file: "server.mjs",
    what: "后端不再留存本次捕获的结果（done 永远为 false）",
    from: `    done: fresh,`,
    to: `    done: false,`,
    reds: "★① status 拿不到结果 / ★③ 超时不会被报出来 / 真 server 契约",
  },
  {
    name: "no-startedat-check", file: "cards/token-capture.js",
    what: "去掉 startedAt 对账：不再区分「本次的结果」与「上一次留下的 done」",
    from: `          if (s && s.done && s.startedAt != null && s.startedAt !== run.prevStartedAt) {`,
    to: `          if (s && s.done) {`,
    reds: "★⑤ 上一轮的 done 会被这一轮误读成自己的成功",
  },
  {
    name: "no-clearinterval", file: "cards/token-capture.js",
    what: "收摊时不 clearInterval（把停表逻辑掏空，留下野定时器）",
    from: `    function stopTimers(sc) {
      const cur = timers.get(sc);
      if (!cur) return false;
      clearInterval(cur.tick);
      clearInterval(cur.poll);
      timers.delete(sc);
      return true;
    }`,
    to: `    function stopTimers(sc) {
      timers.delete(sc);
      return true;
    }`,
    reds: "★④ 完成后仍有野定时器在跑",
  },
  {
    name: "fallback-default-timeout", file: "panel-common.js",
    what: "兜底 POST 不再给 timeoutMs（改回 12 秒默认值那条路）",
    from: `        r = await postJSON("/api/wb/capture", {}, { timeoutMs: capTimeoutMs(capMs) });`,
    to: `        r = await postJSON("/api/wb/capture", {});`,
    reds: "④ 兜底 POST 的 timeoutMs 断言",
  },
  {
    name: "fallback-timeout-as-failure", file: "panel-common.js",
    what: "兜底把读超时当失败报出去（改回改前行为）",
    from: `        if (e && e.timedOut) { outcome = { pending: true }; return; }`,
    to: `        if (false && e && e.timedOut) { outcome = { pending: true }; return; }`,
    reds: "④ 「读超时不得说失败」那条断言",
  },
];

const FILE_PATHS = {
  "server.mjs": SERVER_PATH,
  "panel-common.js": PANEL_PATH,
  "cards/token-capture.js": CARD_PATH,
};
for (const s of SABOTAGE) s.path = FILE_PATHS[s.file];

if (process.argv.includes("--list-sabotage")) {
  console.log(`wb-capture-report 反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(28)} ${s.file} · ${s.what}\n  ${"".padEnd(28)} → 会打红: ${s.reds}`);
  process.exit(0);
}
if (process.argv.includes("--sabotage")) {
  const name = process.argv[process.argv.indexOf("--sabotage") + 1];
  const s = SABOTAGE.find((x) => x.name === name);
  if (!s) { console.error(`没有这条手法：${name}`); process.exit(2); }
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}
