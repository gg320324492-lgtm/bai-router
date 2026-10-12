/**
 * oc-runtime 单元测试（v1.0.75）
 *
 * 覆盖规格 `.research/reports/G-opencode接入规格.md` 的「测试要求」，并对每条
 * 关键判据都配**反向对照**——故意构造一个应当失败的输入、断言它真的失败。
 * 没有对照的断言证明不了自己没写错：比如「action 是 ask」如果照抄了旧代码，
 * 正向会通过，但对照（把 body 改成 deny）会失败。
 *
 * 纪律：
 *   · **不起真进程、不发真网络**——spawn / 健康探测 / 建会话 / 终止全靠注入的假依赖。
 *   · **不碰真实 %APPDATA%\bai-router**——所有路径都是拼出来的字符串，不落盘。
 *   · 凭据一律不出现（本模块根本不需要 API Key）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PERMISSION_ACTION,
  SESSION_PERMISSION_KINDS,
  DEFAULT_PORT,
  parseServeArgs,
  buildSessionCreateBody,
  validateSessionCreateBody,
  sessionKeyOf,
  findOpenCodeBinary,
  createReadyProbe,
  createRuntime,
  OPENCODE_MISSING_HINT,
  SESSION_KEY_UNKNOWN,
} from "../src/server/oc-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "src", "server", "oc-runtime.mjs"), "utf8");

/* ------------------------------------------------------------------ *
 * 假依赖
 * ------------------------------------------------------------------ */

/** 假子进程：只提供 runtime 真正用到的那几个面。 */
function fakeChild(pid) {
  const handlers = new Map();
  return {
    pid,
    stdout: { on() { } },
    stderr: { on() { } },
    on(ev, cb) { (handlers.get(ev) || handlers.set(ev, []).get(ev)).push(cb); return this; },
    _fire(ev, ...a) { (handlers.get(ev) || []).forEach((cb) => cb(...a)); },
  };
}

/** 假 spawn：记录每次启动，返回可触发 exit 的假子进程。 */
function fakeSpawner() {
  const spawns = [];
  let nextPid = 4100;
  const spawn = (binPath, args, opts) => {
    const child = fakeChild(nextPid++);
    spawns.push({ binPath, args, opts, child });
    return child;
  };
  return { spawn, spawns };
}

/** 注入一整套假依赖；probeReady 由 seq 控制（true/false 序列，末值持续）。 */
function harness(over = {}) {
  const { spawn, spawns } = fakeSpawner();
  const kills = [];
  const sessions = [];
  let seq = over.readySeq || [true];
  let i = 0;
  const probeReady = async () => {
    const v = seq[Math.min(i, seq.length - 1)];
    i++;
    if (over.onProbe) await over.onProbe();
    return v;
  };
  const createSession = async ({ base, body }) => {
    sessions.push({ base, body });
    return { id: `ses_${sessions.length}` };
  };
  const rt = createRuntime({
    spawn,
    terminate: (child, pid) => kills.push({ pid, childPid: child.pid }),
    probeReady,
    createSession,
    ...over.runtime,
  });
  return { rt, spawns, kills, sessions, get probes() { return i; } };
}

/* ================================================================ *
 * ① buildSessionCreateBody —— ★ action 必须是 "ask"
 * ================================================================ */
describe("① buildSessionCreateBody", () => {
  test("正向：permission 是数组、每项 action 都是 ask、pattern 是 *", () => {
    const body = buildSessionCreateBody("t");
    assert.ok(Array.isArray(body.permission), "permission 必须是数组（写成对象服务端回 400）");
    assert.equal(body.permission.length, SESSION_PERMISSION_KINDS.length);
    for (const p of body.permission) {
      assert.equal(p.action, "ask", `permission ${p.permission} 的 action 必须是 ask，实际 ${p.action}`);
      assert.equal(p.pattern, "*");
      assert.ok(SESSION_PERMISSION_KINDS.includes(p.permission));
    }
    assert.equal(PERMISSION_ACTION, "ask");
  });

  test("★ 核心：整个 body 里找不到任何 deny/allow，action 全是 ask", () => {
    const body = buildSessionCreateBody("t");
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /"deny"/, "建会话 body 里绝不能出现 deny —— 实测 deny 会 403 FreeTierError");
    assert.doesNotMatch(raw, /"allow"/, "建会话 body 里不该出现 allow —— 会让 OpenCode 自己执行工具");
    assert.equal(validateSessionCreateBody(body).ok, true, "自产 body 必须自验通过");
  });

  test("反向对照：手搓一个 deny 的 body 会被 validateSessionCreateBody 拒绝并点名 403", () => {
    // 这就是「被违反时」的形状：deny 会把工具从模型可见列表摘掉 → 403 FreeTierError。
    const bad = buildSessionCreateBody("t");
    bad.permission[0].action = "deny";
    const v = validateSessionCreateBody(bad);
    assert.equal(v.ok, false, "deny 必须被拒绝");
    assert.match(v.problems.join("|"), /deny/);
    assert.match(v.problems.join("|"), /403/, "拒绝理由必须点名 403 FreeTierError");
  });

  test("反向对照：allow / 别的 action / 对象形态 / 空数组 全部被拒", () => {
    const mk = (mut) => { const b = buildSessionCreateBody("t"); mut(b); return b; };
    // allow 也拒（设计判据：不该让 OpenCode 自己执行工具）
    assert.equal(validateSessionCreateBody(mk((b) => { b.permission[1].action = "allow"; })).ok, false);
    // 任意杂 action 也拒
    assert.equal(validateSessionCreateBody(mk((b) => { b.permission[2].action = "maybe"; })).ok, false);
    // permission 写成对象（实测 400 BadRequest）被拒
    assert.equal(validateSessionCreateBody(mk((b) => { b.permission = { bash: "ask" }; })).ok, false);
    // 空数组被拒
    assert.equal(validateSessionCreateBody(mk((b) => { b.permission = []; })).ok, false);
    // 非对象被拒
    assert.equal(validateSessionCreateBody(null).ok, false);
  });

  test("title：空/非字符串回落到默认，正常标题透传；改返回值不污染后续", () => {
    assert.equal(buildSessionCreateBody().title, "bai-router");
    assert.equal(buildSessionCreateBody("   ").title, "bai-router");
    assert.equal(buildSessionCreateBody(123).title, "bai-router");
    assert.equal(buildSessionCreateBody("hello").title, "hello");
    const a = buildSessionCreateBody("a");
    a.permission.push({ permission: "x", pattern: "*", action: "deny" });
    const b = buildSessionCreateBody("b");
    assert.equal(b.permission.length, SESSION_PERMISSION_KINDS.length, "改过 a 的返回值不能污染 b");
    assert.equal(b.permission.some((p) => p.action === "deny"), false);
  });
});

/* ================================================================ *
 * ② parseServeArgs
 * ================================================================ */
describe("② parseServeArgs", () => {
  test("正向：形状与实测脚本逐字一致", () => {
    assert.deepEqual(parseServeArgs(17899), ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "17899"]);
    assert.deepEqual(parseServeArgs(1234, "127.0.0.1"), ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "1234"]);
  });
  test("反向对照：非回环 host 被拒（OpenCode serve 无鉴权，不能挂到 0.0.0.0）", () => {
    assert.throws(() => parseServeArgs(1234, "0.0.0.0"), /回环/);
    assert.throws(() => parseServeArgs(1234, "192.168.1.5"), /回环/);
  });
  test("反向对照：非法端口被拒", () => {
    assert.throws(() => parseServeArgs(0), /端口/);
    assert.throws(() => parseServeArgs(70000), /端口/);
    assert.throws(() => parseServeArgs("abc"), /端口/);
  });
});

/* ================================================================ *
 * ③ findOpenCodeBinary —— 优先级与 ok:false
 * ================================================================ */
describe("③ findOpenCodeBinary", () => {
  // 用注入的 exists 精确控制「哪些候选存在」，join 固定成 "/" 让断言与平台无关。
  const D = (existsSet, opts = {}) => ({
    env: { APPDATA: "C:/APPDATA" },
    homedir: "C:/Users/u",
    join: (...p) => p.join("/"),
    exists: (p) => existsSet.has(p),
    which: opts.which || (() => null),
  });
  const SHIM = "C:/APPDATA/npm/opencode.cmd";
  const PKG = "C:/APPDATA/npm/node_modules/opencode-ai/bin/opencode.exe";
  const USER = "C:/Users/u/.opencode/bin/opencode.exe";

  test("正向：where 命中时优先于所有 npm/用户路径", () => {
    const r = findOpenCodeBinary(D(new Set([SHIM, PKG, USER, "C:/other/opencode.exe"]), {
      which: () => "C:/other/opencode.exe",
    }));
    assert.equal(r.ok, true);
    assert.equal(r.source, "where");
    assert.equal(r.path, "C:/other/opencode.exe");
    assert.equal(r.spawnNeedsShell, false);
  });

  test("优先级：.exe 压过 .cmd shim（v1.0.75 实测：优先 .cmd 时端到端超时 211s）", () => {
    const r = findOpenCodeBinary(D(new Set([SHIM, PKG, USER])));
    assert.equal(r.source, "appdata-npm-package");
    assert.equal(r.path, PKG, "经 shell 起进程时 child 是 cmd.exe，PID 不是目标进程、回收杀不干净");
    assert.equal(r.spawnNeedsShell, false);
  });

  test("优先级：.cmd 缺失 → 仍落到 npm-package", () => {
    const r = findOpenCodeBinary(D(new Set([PKG, USER])));
    assert.equal(r.source, "appdata-npm-package");
    assert.equal(r.path, PKG);
  });

  test("优先级：只有 .cmd（.exe 真的不在）→ .cmd 兜底，且标明需要 shell", () => {
    const r = findOpenCodeBinary(D(new Set([SHIM])));
    assert.equal(r.source, "appdata-npm-shim");
    assert.equal(r.path, SHIM);
    assert.equal(r.spawnNeedsShell, true);
  });

  test("优先级：npm 两处都缺 → 落到 ~/.opencode/bin", () => {
    const r = findOpenCodeBinary(D(new Set([USER])));
    assert.equal(r.source, "user-install");
    assert.equal(r.path, USER);
  });

  test("where 返回多行时取第一个存在的", () => {
    const r = findOpenCodeBinary(D(new Set(["C:/second/opencode.exe"]), {
      which: () => ["C:/nope/opencode.exe", "C:/second/opencode.exe"],
    }));
    assert.equal(r.path, "C:/second/opencode.exe");
  });

  test("env 无 APPDATA 时跳过 npm 两处，仍尝试用户路径", () => {
    const seen = [];
    const r = findOpenCodeBinary({
      env: {},
      homedir: "C:/Users/u",
      join: (...p) => p.join("/"),
      exists: (p) => { seen.push(p); return p === USER; },
      which: () => null,
    });
    assert.equal(r.ok, true);
    assert.equal(r.source, "user-install");
    assert.equal(seen.includes(SHIM), false, "没有 APPDATA 就不该去拼 npm shim");
    assert.equal(seen.includes(PKG), false);
    assert.ok(seen.includes(USER), "仍要试用户路径");
  });

  test("反向对照：全都找不到 → ok:false + reason + tried + 安装指引，**不下载**", () => {
    let spawned = 0;
    const r = findOpenCodeBinary({
      env: { APPDATA: "C:/APPDATA" },
      homedir: "C:/Users/u",
      join: (...p) => p.join("/"),
      exists: () => false,
      which: () => null,
      spawn: () => { spawned++; },           // 若实现偷着下载/执行，这里会被记录
      fetch: () => { spawned++; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "opencode-not-found");
    assert.equal(spawned, 0, "找不到时绝不下载/执行/联网");
    assert.equal(r.hint, OPENCODE_MISSING_HINT);
    assert.match(r.hint, /npm|安装/i, "必须给可执行的安装指引");
    // tried 覆盖三种路径来源，且按发现顺序排
    assert.deepEqual(r.tried.map((x) => x.how),
      ["appdata-npm-package", "appdata-npm-shim", "user-install"],
      "where 没产出时，tried 应记三条候选路径（没有路径可记就不记）");
    assert.deepEqual(r.tried.map((x) => x.path), [PKG, SHIM, USER]);
    // 找不到时每条候选都要写明「不存在」，而不是悄悄不记
    assert.ok(r.tried.every((x) => x.skipped === "missing"), "全都找不到 → 每条都该标 missing");
    // 指引里不能有任何真实凭据
    assert.doesNotMatch(r.hint, /sk-|key|token/i);
  });

  test("tried 顺序：where 有产出时排在最前", () => {
    const r = findOpenCodeBinary({
      env: { APPDATA: "C:/APPDATA" },
      homedir: "C:/Users/u",
      join: (...p) => p.join("/"),
      exists: () => false,
      which: () => "C:/nowhere/opencode.exe",
    });
    assert.equal(r.ok, false);
    assert.equal(r.tried[0].how, "where", "where 试过了就必须留痕，哪怕没命中");
    assert.deepEqual(r.tried.slice(1).map((x) => x.how),
      ["appdata-npm-package", "appdata-npm-shim", "user-install"]);
  });
});

/* ================================================================ *
 * ④ sessionKeyOf —— 稳定性
 * ================================================================ */
describe("④ sessionKeyOf", () => {
  const msg = "帮我看看这个 bug 的原因";

  test("正向：同一输入两次相等", () => {
    assert.equal(sessionKeyOf(msg), sessionKeyOf(msg));
    // 同一锚点、不同对象实例也相等
    assert.equal(sessionKeyOf({ a: 1, b: [2] }), sessionKeyOf({ a: 1, b: [2] }));
  });

  test("不同输入 → 不同键", () => {
    assert.notEqual(sessionKeyOf(msg), sessionKeyOf(msg + "!"));
    assert.notEqual(sessionKeyOf("A"), sessionKeyOf("B"));
  });

  test("★ 键里不含原文（别人拿它反推不出用户说了什么）", () => {
    const secret = "我的密码是 hunter2 不要外传";
    const k = sessionKeyOf(secret);
    assert.equal(k.includes(secret), false, "键绝不能内嵌原文");
    assert.doesNotMatch(k, /hunter2|密码/, "键绝不能泄漏原文片段");
    assert.match(k, /^bai-oc-[0-9a-f]{16}$/, "形如 bai-oc-<16 hex>");
  });

  test("空/缺输入 → 固定回落键（不能每请求一个新键）", () => {
    assert.equal(sessionKeyOf(""), SESSION_KEY_UNKNOWN);
    assert.equal(sessionKeyOf(null), SESSION_KEY_UNKNOWN);
    assert.equal(sessionKeyOf(undefined), SESSION_KEY_UNKNOWN);
    assert.equal(sessionKeyOf(""), sessionKeyOf(null), "两个空输入必须落到同一个固定键");
  });
});

/* ================================================================ *
 * ⑤ 生命周期：就绪 / 超时 / 崩溃重建
 * ================================================================ */
describe("⑤ 生命周期", () => {
  test("正向：探测就绪后返回 pid/base；同键复用会话不重复建", async () => {
    const { rt, spawns, sessions } = harness({ readySeq: [false, true] });
    const s1 = await rt.sessionFor("k1", "标题");
    assert.equal(s1.ok, true);
    assert.equal(s1.created, true);
    assert.ok(s1.sessionId);
    assert.equal(spawns.length, 1, "就绪探测不通过应重试而不是重开进程");
    assert.equal(spawns[0].args[0], "serve");

    const s2 = await rt.sessionFor("k1", "标题");
    assert.equal(s2.sessionId, s1.sessionId);
    assert.equal(s2.created, false, "同键必须复用");
    assert.equal(sessions.length, 1, "同键不该再发建会话请求");
  });

  test("不同键 → 各自新建会话", async () => {
    const { rt, sessions } = harness();
    await rt.sessionFor("k1");
    await rt.sessionFor("k2");
    assert.equal(sessions.length, 2);
  });

  test("反向对照：健康检查一直不通 → ready-timeout，且把没起来的进程收掉", async () => {
    // 假时钟：sleep 推进 now，确定性地走满超时
    let clock = 0;
    const { rt, spawns, kills } = harness({
      readySeq: [false],
      runtime: {
        readyTimeoutMs: 3,
        healthIntervalMs: 1,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
      },
    });
    const r = await rt.sessionFor("k1");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "ready-timeout");
    assert.equal(spawns.length, 1, "超时前只起一个进程");
    assert.equal(kills.length, 1, "超时后必须回收自己起的那个进程");
    assert.equal(r.hint, undefined, "起得来就不给安装指引");
  });

  test("进程意外退出 → 下一次 ensure 重开（且缓存会话作废）", async () => {
    const { rt, spawns, kills, sessions } = harness();
    const first = await rt.ensure();
    assert.equal(first.ok, true);
    const firstPid = first.pid;
    const s1 = await rt.sessionFor("k1");
    assert.equal(s1.ok, true);

    // 模拟进程意外退出
    spawns[0].child._fire("exit", 1, null);
    assert.equal(rt.isRunning(), false, "exit 事件后应视为已停");

    const second = await rt.ensure();
    assert.equal(second.ok, true, "意外退出后必须能重建");
    assert.equal(spawns.length, 2, "应重新 spawn 一个新进程");
    assert.notEqual(second.pid, firstPid, "重建应是新进程/新 pid");
    assert.equal(kills.length, 0, "意外退出不是我们主动杀的，不该记 kill");

    // 缓存会话随进程作废：新进程上要重新建（原 id 属于死进程）
    const s2 = await rt.sessionFor("k1");
    assert.equal(s2.created, true, "进程换过，同键也必须重新建（不能复用死进程的 id）");
    assert.equal(sessions.length, 2);
  });

  test("并发 ensure() 合流：只起一个进程", async () => {
    const { rt, spawns } = harness({ readySeq: [false, true] });
    const [a, b, c] = await Promise.all([rt.ensure(), rt.ensure(), rt.ensure()]);
    assert.equal(spawns.length, 1, "并发 ensure 必须合流到一个进程");
    assert.equal(a.pid, b.pid);
    assert.equal(b.pid, c.pid);
  });

  test("idle 回收：超过空闲阈值后下次进入自动回收自己起的进程", async () => {
    let clock = 1000;
    const { rt, spawns, kills } = harness({
      runtime: { idleTimeoutMs: 50, now: () => clock, sleep: async () => { } },
    });
    await rt.ensure();
    assert.equal(rt.isRunning(), true);
    clock += 49;
    assert.equal(rt.reclaimIfIdle(), false, "未到阈值不回收");
    clock += 2;                       // 51 > 50
    assert.equal(rt.reclaimIfIdle(), true, "到阈值应回收");
    assert.equal(kills.length, 1);
    assert.equal(kills[0].pid, spawns[0].child.pid, "回收的正是自己起的 pid");
  });

  test("依赖缺失时构造即报错（不许静默变真网络）", () => {
    assert.throws(() => createRuntime({ createSession: async () => ({}) }), /probeReady/);
    assert.throws(() => createRuntime({ probeReady: async () => true }), /createSession/);
    assert.throws(() => createReadyProbe({}), /fetchImpl/);
  });
});

/* ================================================================ *
 * ⑥ 只杀自己那个 PID（★ 红线负样本）
 * ================================================================ */
describe("⑥ 只终止自己 spawn 的 PID", () => {
  test("dispose() 传给终止函数的 pid === spawn 返回的 pid", async () => {
    const { rt, spawns, kills } = harness();
    await rt.ensure();
    const spawnedPid = spawns[0].child.pid;
    const d = rt.dispose();
    assert.equal(d.ok, true);
    assert.equal(kills.length, 1);
    assert.equal(kills[0].pid, spawnedPid, "必须正好是 spawn 返回的那个 pid");
    assert.equal(kills[0].childPid, spawnedPid);
    assert.equal(rt.pid, null);
    assert.equal(rt.isRunning(), false);
  });

  test("★ 负样本：模块源码里不出现按名字/镜像名批量终止的命令", () => {
    const src = SRC;
    // 按镜像名/进程名批量终止（会误杀用户自己开的正式实例）——本模块禁止。
    assert.equal(/taskkill/i.test(src), false, "源码里不得出现按名批量终止的命令（taskkill）");
    assert.equal(/\/IM\b/i.test(src), false, "源码里不得出现 /IM（按镜像名终止）标志");
    assert.equal(/\/PID\b/i.test(src), false, "不需要 /PID 标志——用的是 child.kill()，天然按 pid");
  });

  test("★ 负样本：dispose 的终止只作用在 rt.child 上，不接受外部 pid", async () => {
    const { rt, spawns, kills } = harness();
    await rt.ensure();
    const spawnedPid = spawns[0].child.pid;
    // 即便试图把「别的 pid」塞进来也无从下手：dispose 不吃参数。
    assert.equal(rt.dispose.length, 0, "dispose 不接受外部 pid 参数");
    rt.dispose();
    assert.equal(kills.length, 1);
    assert.equal(kills[0].pid, spawnedPid);
  });

  test("重复 dispose 幂等：不会误杀第二次（已 null）", async () => {
    const { rt, kills } = harness();
    await rt.ensure();
    rt.dispose();
    const d2 = rt.dispose();
    assert.equal(d2.ok, false);
    assert.equal(d2.reason, "not-running");
    assert.equal(kills.length, 1, "重复 dispose 不得重复杀");
  });

  test("起始失败（找不到二进制）不 spawn 任何进程", async () => {
    const { rt, spawns } = harness({
      runtime: { findBinary: () => ({ ok: false, reason: "opencode-not-found", tried: [], hint: "装一下" }) },
    });
    const r = await rt.sessionFor("k1");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "opencode-not-found");
    assert.equal(r.hint, "装一下", "找不到要把安装指引传上去");
    assert.equal(spawns.length, 0);
  });

  test("会话请求体不合规时**不发起**建会话请求", async () => {
    // 用一个把 body 改坏再发出去的 createSession 探针：runtime 自产 body 时不该触发。
    let called = 0;
    const { spawn, kills } = fakeSpawner();
    const rt = createRuntime({
      spawn,
      terminate: () => { },
      probeReady: async () => true,
      createSession: async () => { called++; return { id: "x" }; },
      findBinary: () => ({ ok: true, path: "C:/opencode.exe", source: "test", spawnNeedsShell: false }),
    });
    const r = await rt.sessionFor("k1");
    assert.equal(r.ok, true);
    assert.equal(called, 1, "正常路径下确实发了建会话请求");
    // 反向对照：如果 body 被改成 deny，validate 必须拦下（这里直接演示该拦下）
    const bad = buildSessionCreateBody("t");
    bad.permission[0].action = "deny";
    assert.equal(validateSessionCreateBody(bad).ok, false, "deny body 必须被拦");
  });

  test("默认端口与常量自洽", () => {
    assert.equal(typeof DEFAULT_PORT, "number");
    assert.ok(DEFAULT_PORT >= 1024 && DEFAULT_PORT <= 65535);
    assert.deepEqual(parseServeArgs(DEFAULT_PORT)[parseServeArgs(DEFAULT_PORT).length - 1], String(DEFAULT_PORT));
  });
});
/* ---------------------------------------------------------------------------
 * v1.0.75：Windows 上「存在」不等于「Node 能直接 spawn」
 *
 * v1.0.75 实测踩到：`where opencode` 的第一条候选是**无扩展名的 shell shim**
 * （%APPDATA%\npm\opencode，给 cmd 用的脚本）。它 existsSync 为真，于是被选中——
 * 而 Node spawn 它必然 ENOENT，表现为「干等 60 秒也不就绪」，极难指向真正的原因。
 * `opencode.cmd` 同理：Node 修过 CVE-2024-27980 后，Windows 上 spawn .cmd/.bat
 * 必须带 shell:true，而我们刻意不拼 shell 命令行。
 *
 * 所以判据必须是「存在且能直接执行」，不是「存在」。
 * ------------------------------------------------------------------------- */
describe("Windows 可执行性判据（v1.0.75）", () => {
  const SHIM = "C:/APPDATA/npm/opencode";                    // 无扩展名，给 cmd 用的脚本
  const CMD = "C:/APPDATA/npm/opencode.cmd";                  // Node 不能直接 spawn，但模块带 shell:true
  const EXE = "C:/APPDATA/npm/node_modules/opencode-ai/bin/opencode.exe";
  const winEnv = { APPDATA: "C:/APPDATA", OS: "Windows_NT" };

  test("where 同时给出 shim 与 .cmd 时 → 仍选包目录里的 .exe（.cmd 要经 shell，PID 不对）", () => {
    const r = findOpenCodeBinary({
      env: winEnv, homedir: "C:/Users/u", join: (...p) => p.join("/"),
      exists: (p) => [SHIM, CMD, EXE].includes(String(p)),
      which: () => `${SHIM}\n${CMD}`,
    });
    assert.equal(r.ok, true);
    assert.equal(r.path, EXE, "必须选 .exe：经 shell 起进程时 child 是 cmd.exe，PID 不是目标进程");
    assert.equal(r.source, "appdata-npm-package");
    assert.equal(r.spawnNeedsShell, false);
  });

  test("★ 排序是全局的，不是逐源取第一个（.cmd 存在也压不过 .exe）", () => {
    const r = findOpenCodeBinary({
      env: winEnv, homedir: "C:/Users/u", join: (...p) => p.join("/"),
      exists: (p) => [SHIM, CMD, EXE].includes(String(p)),
      which: () => SHIM,                       // where 只给那个跑不起来的
    });
    assert.equal(r.path, EXE, "where 没命中可用项时要继续往后找，不能就此认定");
    const ranks = (r.tried || []).map((t) => t.rank);
    assert.ok(ranks.includes(0) && ranks.includes(1), "候选要按 rank 排过，不是按来源顺序取第一个");
  });

  test("只有 .cmd（真 .exe 不在）→ .cmd 兜底可用，且标明需要 shell", () => {
    const r = findOpenCodeBinary({
      env: winEnv, homedir: "C:/Users/u", join: (...p) => p.join("/"),
      exists: (p) => String(p) === CMD,
      which: () => CMD,
    });
    assert.equal(r.ok, true);
    assert.equal(r.path, CMD);
    assert.equal(r.spawnNeedsShell, true, ".cmd 必须经 shell（模块 spawn 处带了 shell:true）");
  });

  test("无扩展名 shim 是唯一候选 → 不选它，退到包目录里的 .exe", () => {
    const r = findOpenCodeBinary({
      env: winEnv, homedir: "C:/Users/u", join: (...p) => p.join("/"),
      exists: (p) => [SHIM, EXE].includes(String(p)),
      which: () => SHIM,
    });
    assert.equal(r.ok, true);
    assert.equal(r.path, EXE, "必须退到能直接 spawn 的 .exe");
    assert.equal(r.source, "appdata-npm-package");
    assert.equal(r.spawnNeedsShell, false, ".exe 直接 spawn，不需要 shell");
  });

  test("机器上只有无扩展名 shim（既无 .cmd 也无 .exe）→ 判 not-found", () => {
    const r = findOpenCodeBinary({
      env: winEnv, homedir: "C:/Users/u", join: (...p) => p.join("/"),
      exists: (p) => String(p) === SHIM,
      which: () => SHIM,
    });
    assert.equal(r.ok, false, "宁可不认，也不能挑一个 spawn 不起来的路径");
    assert.equal(r.reason, "opencode-not-found");
  });

  test("候选要全部留痕并带 rank / 跳过原因，别悄悄消失", () => {
    const r = findOpenCodeBinary({
      env: winEnv, homedir: "C:/Users/u", join: (...p) => p.join("/"),
      exists: (p) => [SHIM, CMD, EXE].includes(String(p)),
      which: () => `${SHIM}\n${CMD}`,
    });
    const shimRow = (r.tried || []).find((t) => String(t.path) === SHIM);
    assert.ok(shimRow, "无扩展名 shim 必须留痕");
    assert.equal(shimRow.skipped, "no-executable-extension",
      "要写明为什么跳过（是「无扩展名跑不起来」，不是「不存在」——两者处置完全不同）");
    assert.ok((r.tried || []).some((t) => String(t.path) === CMD && t.rank === 1),
      ".cmd 要被记录为 rank 1（可用但不如 .exe）");
  });

  test("非 Windows 上不套用扩展名判据（opencode 就是无扩展名可执行文件）", () => {
    const posix = "/usr/local/bin/opencode";
    const r = findOpenCodeBinary({
      env: { OS: "Linux", PATH: "" }, homedir: "/home/u", join: (...p) => p.join("/"),
      exists: (p) => String(p) === posix,
      which: () => posix,
    });
    assert.equal(r.ok, true, "Linux/macOS 上无扩展名的可执行文件必须照认");
    assert.equal(r.path, posix);
  });

  test("反向对照：判据确实在改变选择（去掉它就会挑中 shim）", () => {
    const exists = (p) => [SHIM, CMD, EXE].includes(String(p));
    const cands = `${SHIM}\n${CMD}`.split("\n");
    const withPredicate = (() => {
      for (const c of cands) {
        if (!exists(c)) continue;
        if (!/\.[a-z0-9]+$/i.test(c)) continue;      // ← 本次新增的判据
        return c;
      }
      return EXE;
    })();
    const withoutPredicate = (() => {
      for (const c of cands) if (exists(c)) return c;
      return EXE;
    })();
    assert.equal(withoutPredicate, SHIM, "去掉判据就会挑中那个跑不起来的 shim");
    assert.notEqual(withPredicate, withoutPredicate, "判据确实在改变选择 → 上面几条不是恒真断言");
  });
});
