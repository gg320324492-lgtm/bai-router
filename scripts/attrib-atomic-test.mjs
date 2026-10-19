/**
 * T1 + T2 回归测试（v1.0.74）
 *
 *   T1  Zen / Qoder / OpenRouter 的流式故障被记到 wb 槽位（退化三元 + 两处写死）
 *   T2  writeAtomic 对 Windows 的 EPERM/EACCES/EBUSY 零重试
 *
 * 两类测试：
 *   · **源码求值**（快、确定性）—— 从 src/server/server.mjs 里**按文本抠出真实函数**，
 *     用 new Function 组装起来跑。测的是仓库里那份代码本身，不是抄一份重写。
 *   · **端到端**—— 真的 spawn 一份 server.mjs（BAI_DATA_DIR 指向系统临时目录，
 *     端口全部动态挑空闲的），配一个本机假上游打出 Qoder「All backends failed」形态的
 *     SSE 错误，走完 bail() 再读面板 /api/status 的 relayLast。
 *
 * 红线：所有落盘都在 os.tmpdir() 下，**绝不碰真实的 %APPDATA%\bai-router**。
 *       假凭据一律是 'sk-dummy-not-a-real-key' 这类明显假串，源码里没有任何真实令牌。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import {
  mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, openSync, closeSync,
} from "node:fs";
import { renameSync, writeFileSync as realWriteFileSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const SRC = readFileSync(SERVER, "utf8");
const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-attrib-atomic-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => { try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* ------------------------------------------------------------------ *
 * 源码求值工具：从 server.mjs 里按锚点切出真实源码块
 * ------------------------------------------------------------------ */

/** 从 `anchor` 出现处切到其后的第一个 `\n}\n`（函数/方法体结束）。 */
function sliceToClosingBrace(anchor) {
  const i = SRC.indexOf(anchor);
  assert.ok(i >= 0, `server.mjs 里找不到锚点：${anchor}`);
  const end = SRC.indexOf("\n}\n", i);
  assert.ok(end > i, `锚点 ${anchor} 之后没找到顶格 "}"，抠源码失败`);
  return SRC.slice(i, end + 3);
}

/** 从 startAnchor 切到 endAnchor 之前（用于「声明 + 紧跟的注释块」这种连续块）。 */
function sliceBetween(startAnchor, endAnchor) {
  const i = SRC.indexOf(startAnchor);
  const j = SRC.indexOf(endAnchor, i + startAnchor.length);
  assert.ok(i >= 0 && j > i, `抠源码失败：${startAnchor} → ${endAnchor}`);
  return SRC.slice(i, j);
}

/** 组装一个沙箱：返回抠出来的真实函数 + 可观察状态。 */
function loadRealCode() {
  const relayErrorsSrc = sliceBetween("const relayErrors = {", "function noteRelayError(");
  const attrSrc = sliceBetween('let wbErrPrefix = "WorkBuddy";', "function wbAnthroError(");
  const noteSrc = sliceToClosingBrace("function noteRelayError(");
  const atomicSrc = sliceBetween("const ATOMIC_TRANSIENT = ", "function writeAtomic(file, data, opts) {");
  const waSrc = sliceToClosingBrace("function writeAtomic(file, data, opts) {");

  const factory = new Function(
    "writeFileSync", "renameSync", "SharedArrayBuffer", "Int32Array", "Atomics", "CHANNEL_LABELS",
    `${relayErrorsSrc}
${attrSrc}
${noteSrc}
${atomicSrc}
${waSrc}
return {
  relayErrors, noteRelayError, setErrProvider, errChannel, writeAtomic,
  get prefix() { return wbErrPrefix; },
  get channel() { return wbErrChannel; },
  delays: ATOMIC_DELAYS,
};`
  );
  return factory(realWriteFileSync, renameSync, SharedArrayBuffer, Int32Array, Atomics, {
    bai: "B.AI", sn: "SenseNova", wb: "WorkBuddy", wbai: "WorkBuddy AI",
    zen: "OpenCode Zen", qd: "Qoder", or: "OpenRouter",
  });
}

/** 把 server.mjs 里某一行原文拿出来直接求值（测调用点，不是重写）。 */
function evalCallSiteLine(re, scopeNames, scopeValues, extra) {
  const m = SRC.match(re);
  assert.ok(m, `server.mjs 里找不到调用点：${re}`);
  const line = m[0];
  const keys = Object.keys(extra || {});
  const fn = new Function(...scopeNames, ...keys, line);
  fn(...scopeValues, ...keys.map((k) => extra[k]));
  return line;
}

/* ------------------------------------------------------------------ *
 * T1 —— 归因
 * ------------------------------------------------------------------ */

describe("T1 流式故障归因（setErrProvider 带渠道）", () => {
  test("退化三元已消除：全文件无 `? \"wb\" : \"wb\"`", () => {
    assert.equal(
      SRC.includes('? "wb" : "wb"'), false,
      'server.mjs 里还有退化三元 `? "wb" : "wb"`'
    );
    // wbPipe 这段共用桥里，所有 noteRelayError 都必须走 errChannel()，不得写死渠道。
    // 4 处：首事件闸门超时 / 上游 SSE 报错(bail) / 流中断 / 空流里的未知形状
    // （第 4 处是 v1.0.74「200+空流」具名归因加的**诊断**通道——它记 unrecognized_shape，
    //   注意它不 bail：未知形状判成功并原样透传，槽位只是给面板看的）。
    const pipeSrc = sliceBetween("async function wbPipe(", "const DUMP_MAX_BYTES = ");
    const slots = pipeSrc.match(/noteRelayError\(([^,]+),/g) || [];
    assert.equal(slots.length, 4, `wbPipe 里应有 4 处 noteRelayError，实际 ${slots.length}`);
    const notChannelled = slots.filter((s) => !s.startsWith("noteRelayError(errChannel()"));
    assert.deepEqual(notChannelled, [], `wbPipe 里还有写死/间接渠道的归因：${notChannelled.join(" | ")}`);
    // 四种故障类型都要在：首事件闸门超时 / 上游 SSE 报错 / 流中断 / 未知形状（不判失败，只记诊断）
    for (const kind of ["timeout", "upstream_sse_error", "network", "unrecognized_shape"]) {
      assert.ok(pipeSrc.includes(`"${kind}"`), `wbPipe 里缺 ${kind} 归因`);
    }
  });

  test("过期注释已改对：五个提供方（wb/wbai/zen/qd/or）", () => {
    assert.match(SRC, /五个\*\*提供方共用/);
    // relaySpec 里 openai:true 的确实就是这五个
    const spec = sliceToClosingBrace("function relaySpec(provider, cfg) {");
    const openai = [...spec.matchAll(/(\w+): \["([^"]+)".*\{ openai: true \}\]/g)].map((m) => m[1]);
    assert.deepEqual(openai.sort(), ["or", "qd", "wb", "wbai", "zen"]);
  });

  test("setErrProvider(name, channel) 五个渠道各归各槽", () => {
    const C = loadRealCode();
    const channels = ["wb", "wbai", "zen", "qd", "or"];
    for (const p of channels) {
      // 清干净所有槽位
      for (const k of Object.keys(C.relayErrors)) C.relayErrors[k] = { kind: null, message: null, at: null };
      C.setErrProvider("OpenCode Zen", p);
      assert.equal(C.channel, p, "setErrProvider 没把渠道记下来");
      C.noteRelayError(C.errChannel(), "timeout", `${p} 上游 60s 内未发出首个响应块`);
      assert.equal(C.relayErrors[p].kind, "timeout", `${p} 的故障没记到自己的槽位`);
      for (const other of channels) {
        if (other === p) continue;
        assert.equal(C.relayErrors[other].kind, null, `${p} 的故障漏进了 ${other} 槽位`);
      }
    }
  });

  test("三个真实调用点都把渠道 key 传了下去", () => {
    const C = loadRealCode();
    // openaiExchange：setErrProvider(NAME, p);
    let line = evalCallSiteLine(/^\s*setErrProvider\(NAME, p\);.*$/m,
      ["setErrProvider"], [C.setErrProvider], { NAME: "OpenCode Zen", p: "zen" });
    assert.equal(C.channel, "zen");
    assert.equal(C.prefix, "OpenCode Zen");

    // makeRelay：setErrProvider(relayLabel(p), p);
    C.setErrProvider("X", "wb");
    evalCallSiteLine(/^\s*setErrProvider\(relayLabel\(p\), p\);.*$/m,
      ["setErrProvider", "relayLabel"], [C.setErrProvider, (x) => ({ or: "OpenRouter" }[x] || x)], { p: "or" });
    assert.equal(C.channel, "or");
    assert.equal(C.prefix, "OpenRouter");

    // 影子 res 分支：setErrProvider(relayLabel(fo.provider), fo.provider);
    C.setErrProvider("X", "wb");
    evalCallSiteLine(/^\s*setErrProvider\(relayLabel\(fo\.provider\), fo\.provider\);.*$/m,
      ["setErrProvider", "relayLabel"], [C.setErrProvider, (x) => ({ qd: "Qoder" }[x] || x)], { fo: { provider: "qd" } });
    assert.equal(C.channel, "qd");
    assert.equal(C.prefix, "Qoder");
  });

  test("向后兼容：setErrProvider(name) 不传渠道时回落到 wb，不产出 undefined 槽位", () => {
    const C = loadRealCode();
    for (const bad of [undefined, null, "", 0, {}, []]) {
      C.setErrProvider("WorkBuddy", "zen");
      C.setErrProvider("WorkBuddy", bad);
      assert.equal(C.channel, "wb", `传 ${JSON.stringify(bad)} 时应回落 wb`);
      C.noteRelayError(C.errChannel(), "network", "断流");
      assert.equal(C.relayErrors.wb.kind, "network");
      assert.equal(C.relayErrors.zen.kind, null, "上一轮 zen 的槽位不该残留");
    }
    // noteRelayError 对未知渠道仍按原逻辑 fallback（bai），没有 undefined 键
    assert.equal(Object.prototype.hasOwnProperty.call(C.relayErrors, "undefined"), false);
  });

  test("残留并发风险已在注释里写明（模块级全局仍会串）", () => {
    const blk = sliceBetween('let wbErrPrefix = "WorkBuddy";', "function wbAnthroError(");
    assert.match(blk, /残留并发风险/);
    assert.match(blk, /本轮有意没动/);
    assert.match(blk, /errChannel\(\)/, "注释应点名仍会串的读取点");
    assert.match(blk, /模块级全局/);
  });
});

/* ------------------------------------------------------------------ *
 * T1 端到端：真 server.mjs + 假上游
 * ------------------------------------------------------------------ */

/** 挑 N 个当前空闲的本地端口。 */
async function freePorts(n) {
  const servers = [];
  const ports = [];
  for (let i = 0; i < n; i++) {
    const s = http.createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    ports.push(s.address().port);
    servers.push(s);
  }
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

describe("T1 端到端：真 server.mjs 跑一次流式故障", () => {
  let child, fake, dataDir, P;

  before(async () => {
    const [bai, sn, wb, wbai, zen, qd, or, panel, upstream, mm] = await freePorts(10);
    P = { bai, sn, wb, wbai, zen, qd, or, panel, upstream, mm };
    dataDir = mkdtempSync(path.join(TMPROOT, "boot-"));

    const cfg = JSON.parse(readFileSync(path.join(REPO, "src", "server", "config.defaults.json"), "utf8"));
    cfg.relayPort = bai; cfg.panelPort = panel;
    Object.assign(cfg, { sn: { ...cfg.sn, relayPort: sn }, wb: { ...cfg.wb, relayPort: wb },
      wbai: { ...cfg.wbai, relayPort: wbai }, zen: { ...cfg.zen, relayPort: zen },
      qd: { ...cfg.qd, relayPort: qd }, mm: { ...cfg.mm, relayPort: mm },
      or: { ...cfg.or, relayPort: or } });
    cfg.failover.enabled = false;                 // 不让故障转移到别的渠道，污染断言
    // 假凭据（明显不是真 key）+ 全部拨到本机假上游
    cfg.zen = { ...cfg.zen, useProxy: true, apiKey: "sk-dummy-not-a-real-key", upstream: `http://127.0.0.1:${upstream}/v1` };
    cfg.or = { ...cfg.or, useProxy: true, keys: ["sk-or-v1-dummy-not-real"], upstream: `http://127.0.0.1:${upstream}/v1` };
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

    // 假上游：HTTP 200 但 SSE 里塞 error —— Qoder「All backends failed」的真实形态，
    // 正是 wbPipe → bail() → noteRelayError(errChannel(), "upstream_sse_error") 那条路。
    fake = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: error\ndata: ${JSON.stringify({ code: "provider_error", message: "All backends failed" })}\n\n`);
        res.end();
      });
    });
    await new Promise((r) => fake.listen(upstream, "127.0.0.1", r));

    child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env, BAI_DATA_DIR: dataDir,
        // 这两个 env 用来**阻止它自重启**：needEnvRestart 要求 NODE_USE_ENV_PROXY !== "1"，
        // 而自重启是 detached+unref 的——不挡住的话 child.kill() 杀不到重生的那个，会留孤儿占端口。
        NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1",
        // 第三个闸门：关掉**自动**代理探测。它和上面两个是**不同的**重启路径，必须一起挡：
        // 自动探测探到与配置不同的代理（本机 Clash 在 127.0.0.1:7897，而这里的 cfg.proxy 是空串
        // =直连）就会 applyProxy() 写配置、再 exit(0) 自重启换继任者——本进程被杀，正在飞的
        // fetch 直接 ECONNRESET，本用例的 status 轮询窗口正好压在这个窗口上（实测偶发红）。
        // 面板上手动检测走的是另一条路，不受此闸门影响，行为照旧。
        BAI_NO_PROXY_AUTODETECT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    child.stdout.resume(); child.stderr.resume();

    const status = () => fetch(`http://127.0.0.1:${panel}/api/status`).then((r) => r.json());
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      try { if ((await status()).service?.up) return; } catch { }
      await sleep(300);
    }
    throw new Error("server.mjs 40 秒内没把面板端口起起来");
  }, { timeout: 60000 });

  after(() => {
    try { child && child.kill(); } catch { }
    try { fake && fake.close(); } catch { }
    try { dataDir && rmSync(dataDir, { recursive: true, force: true }); } catch { }
  });

  test("zen / or 的 SSE 故障各记各槽位，wb / qd 保持空", async () => {
    for (const [name, port, model] of [["zen", P.zen, "space-bunny-free"], ["or", P.or, "openrouter/free"]]) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      const body = await r.text();
      assert.equal(r.status, 502, `${name} 没走到 bail()：${body}`);
      assert.match(body, new RegExp(`\\[${name === "zen" ? "OpenCode Zen" : "OpenRouter"}\\]`), `前缀不对：${body}`);
    }

    const status = () => fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json());
    const t0 = Date.now();
    let s;
    while (Date.now() - t0 < 20000) {
      s = await status();
      if (s.zen?.relayLast?.kind && s.or?.relayLast?.kind) break;
      await sleep(250);
    }
    // —— 核心断言 ——
    assert.equal(s.zen.relayLast.kind, "upstream_sse_error", "zen 的故障没记到 zen 槽位");
    assert.equal(s.or.relayLast.kind, "upstream_sse_error", "or 的故障没记到 or 槽位");
    // 改之前这两个都会落在 wb 槽位上（退化三元 / 写死 "wb"）
    assert.equal(s.wb.relayLast.kind, null, `wb 槽位被污染了：${JSON.stringify(s.wb.relayLast)}`);
    assert.equal(s.qd.relayLast.kind, null, `qd 槽位被污染了：${JSON.stringify(s.qd.relayLast)}`);
    // 面板不能因此冒出 undefined 槽位
    for (const k of ["zen", "or", "wb", "qd"]) {
      assert.ok(s[k], `${k} 状态缺失`);
      assert.ok("kind" in s[k].relayLast);
    }
  });
});

/* ------------------------------------------------------------------ *
 * T2 —— writeAtomic 抗锁
 * ------------------------------------------------------------------ */

/** 用 PowerShell 以 FileShare::None 独占握住 file，握手文件一到就说明握住了。 */
function holdExclusive(file, holdMs, handshake) {
  const script = `$f=[System.IO.File]::Open('${file}','Open','ReadWrite','None');`
    + `New-Item -ItemType File -Path '${handshake}' -Force | Out-Null;`
    + `Start-Sleep -Milliseconds ${holdMs};$f.Dispose();`;
  const p = execFile("powershell", ["-NoProfile", "-Command", script], { windowsHide: true });
  p.stdout.resume(); p.stderr.resume();
  return p;
}

describe("T2 writeAtomic：Windows 抗锁重试", () => {
  test("真机 EPERM：独占句柄下先确认裸 rename 会失败，再由 writeAtomic 重试写成功", async () => {
    const C = loadRealCode();
    const dir = mkdtempSync(path.join(TMPROOT, "lock-"));
    const target = path.join(dir, "locked.json");
    const handshake = path.join(dir, "held.txt");
    writeFileSync(target, "OLD\n");

    // 假中转先自己写 tmp；第二次（重试）writeAtomic 会重写它 —— 用来证明「重跑整个流程」
    const tmp = target + ".tmp";
    writeFileSync(tmp, "CONTROL\n");
    const hp = holdExclusive(target, 450, handshake);
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && !existsSync(handshake)) await sleep(25);
    assert.ok(existsSync(handshake), "PowerShell 没握住独占句柄（15s 超时）");

    // —— 对照组：同一条 rename，不带重试，必须真的抛 EPERM（证明锁是真的，不是摆设）
    let controlCode = null;
    try { renameSync(tmp, target); } catch (e) { controlCode = e.code; }
    assert.equal(controlCode, "EPERM", `裸 rename 本该撞锁，却拿到 ${controlCode}`);
    // 注意：FileShare::None 期间连**读**都 EBUSY，内容断言只能放到句柄释放之后

    // —— 主角：同一条 rename，带上 writeAtomic 的退避重试
    const t1 = Date.now();
    C.writeAtomic(target, "NEW\n");
    const elapsed = Date.now() - t1;
    await new Promise((r) => hp.on("exit", r));

    assert.equal(readFileSync(target, "utf8"), "NEW\n", "重试后没写成功");
    assert.equal(existsSync(tmp), false, "tmp 没被 rename 掉");
    // 退避表前 4 项之和 = 50+100+200+400 = 750ms：至少要走到第 5 次尝试才算真退了避
    assert.ok(elapsed >= 700, `只花了 ${elapsed}ms，说明重试路径压根没走（真撞锁应 ≥750ms）`);
    assert.ok(elapsed < 3000, `阻塞 ${elapsed}ms，超出设计上限`);
  }, { timeout: 60000 });

  test("注入 rename：前两次 EPERM、第三次成功（共 3 次尝试，阻塞 ≈ 退避和）", () => {
    const C = loadRealCode();
    const dir = mkdtempSync(path.join(TMPROOT, "inject-"));
    const target = path.join(dir, "a.json");
    let calls = 0;
    const fakeRename = (a, b) => {
      calls++;
      if (calls <= 2) { const e = new Error("EPERM: injected"); e.code = "EPERM"; throw e; }
      renameSync(a, b);
    };
    const t0 = Date.now();
    C.writeAtomic(target, "payload", { rename: fakeRename });
    const elapsed = Date.now() - t0;
    assert.equal(calls, 3, `期望恰好 3 次 rename，实际 ${calls}`);
    assert.equal(readFileSync(target, "utf8"), "payload");
    assert.ok(elapsed >= 145, `退避 50+100=150ms，实际只阻塞 ${elapsed}ms`);
  });

  test("退避表总阻塞上限 ≤ 1.5 秒（落在 server.mjs 的常量里）", () => {
    const C = loadRealCode();
    assert.deepEqual(C.delays, [50, 100, 200, 400, 600]);
    const total = C.delays.reduce((a, b) => a + b, 0);
    assert.ok(total <= 1500, `退避总阻塞 ${total}ms 超过 1.5 秒上限`);
    assert.equal(C.delays.length, 5, "重试次数 = 退避表长度");
  });

  test("不吞真错误：目录不存在 → ENOENT 立即抛出，且一次都不重试", () => {
    const C = loadRealCode();
    const dir = mkdtempSync(path.join(TMPROOT, "enoent-"));
    const t0 = Date.now();
    assert.throws(
      () => C.writeAtomic(path.join(dir, "no-such-dir", "x.json"), "d"),
      (e) => e.code === "ENOENT",
      "目录不存在应当抛 ENOENT"
    );
    assert.ok(Date.now() - t0 < 100, "ENOENT 不该走退避重试");
  });

  test("不吞真错误：注入 ENOSPC → 立即抛出，只试 1 次（不白等 1.35 秒）", () => {
    const C = loadRealCode();
    const dir = mkdtempSync(path.join(TMPROOT, "enospc-"));
    const target = path.join(dir, "b.json");
    let calls = 0;
    const t0 = Date.now();
    assert.throws(
      () => C.writeAtomic(target, "d", {
        rename: () => { calls++; const e = new Error("ENOSPC: injected"); e.code = "ENOSPC"; throw e; },
      }),
      (e) => e.code === "ENOSPC"
    );
    assert.equal(calls, 1, `ENOSPC 重试了 ${calls} 次，不该重试`);
    assert.ok(Date.now() - t0 < 100);
  });

  test("瞬时错误用尽预算后仍抛出原始错误（不静默）", () => {
    const C = loadRealCode();
    const dir = mkdtempSync(path.join(TMPROOT, "exhaust-"));
    const target = path.join(dir, "c.json");
    let calls = 0;
    assert.throws(
      () => C.writeAtomic(target, "d", {
        rename: () => { calls++; const e = new Error("EBUSY: injected"); e.code = "EBUSY"; throw e; },
      }),
      (e) => e.code === "EBUSY"
    );
    assert.equal(calls, C.delays.length + 1, `期望 ${C.delays.length + 1} 次（1 + 5 次重试），实际 ${calls}`);
  });

  test("重试重跑整个 writeFileSync + rename（每次都重新落 tmp）", () => {
    const C = loadRealCode();
    const dir = mkdtempSync(path.join(TMPROOT, "whole-"));
    const target = path.join(dir, "d.json");
    const tmp = target + ".tmp";
    let calls = 0;
    const renameSpy = (a, b) => {
      calls++;
      // 每次 rename 前 tmp 必须**当场存在且内容完整**（若只重试 rename，第 2 次起会用到残缺/不存在的 tmp）
      assert.equal(a, tmp);
      assert.equal(readFileSync(tmp, "utf8"), "hello");
      if (calls === 1) { const e = new Error("EPERM"); e.code = "EPERM"; throw e; }
      renameSync(a, b);
    };
    C.writeAtomic(target, "hello", { rename: renameSpy });
    assert.equal(calls, 2);
    assert.equal(readFileSync(target, "utf8"), "hello");
  });
});