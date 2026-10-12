/**
 * 回归测试：**只按 PID 终止之前的身份核对**（v1.0.77 · 契约红线相关）
 *
 * ## 缺陷是什么
 *
 * 契约明文规定「`taskkill` 只按 PID，绝不用 `taskkill /IM`」——按名字杀会误杀
 * 正在跑的正式实例。但**只按 PID 杀有镜像风险**：
 *
 *     读 PID 文件 → `process.kill(pid, 0)` 判存在 → `process.kill(pid)` 真杀
 *
 * 中间**没有任何**「这个 PID 还是不是当初那个进程」的校验。若原进程已死、
 * Windows 把 PID 分配给了别的程序，`kill(pid,0)` 为真，我们却会**杀掉一个完全
 * 无关的进程**。
 *
 * ## 修法
 *
 * 记录 PID 的**同时**记录它的启动时间；终止前要求「同一个 PID 的启动时间没变」。
 * 进程存活期间启动时间不变，PID 一旦被回收，新进程的启动时间必然更晚——两者可判。
 * 参考 `.research/dsh-wb/src/host-heartbeat.ts:194-203`（`isHeartbeatProcessAlive`）。
 *
 * 三态而不是两态：`same` 才动手；`recycled`（PID 被回收）与 `unverifiable`
 * （取不到启动时间 / 旧格式记录）**一律不杀**，并把结论如实说给用户。
 *
 * ## 测试打的是什么
 *
 * **直接 import 仓库里那份 `src/server/proc-identity.cjs`**——不是抄一份重写。
 * 取实测启动时间的那一步靠注入的 `readStartMs` 桩替代，于是断言跑在**真逻辑**上，
 * **不启动、不终止任何真进程**。另有一条真机自检（读自己的启动时间）证明
 * 「取启动时间」这一步在 Windows 上确实能用。
 *
 * 红线：
 *   · **一个真进程都不杀**（唯一的真进程调用是「读自己」，不写不杀）。
 *   · 不碰真实 `%APPDATA%\bai-router`，落盘用 `os.tmpdir()` 下的临时目录。
 *   · 不引入 `taskkill /IM`（本文件与被测源码里都断言它不出现）。
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const PI = require(path.join(REPO, "src", "server", "proc-identity.cjs"));
const {
  VERDICT_SAME, VERDICT_RECYCLED, VERDICT_UNVERIFIABLE,
  pidIdentityVerdict, pidIdentityMessage, recordedStartFromRecord,
  selfStartTimeMs, procStartTimeMs, verifyPidRecord, TOLERANCE_MS,
} = PI;

const MAIN_SRC = readFileSync(path.join(REPO, "src", "main.js"), "utf8");
const SERVER_SRC = readFileSync(path.join(REPO, "src", "server", "server.mjs"), "utf8");
const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-pid-identity-"));
after(() => { try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

const PID = 4242;
/** 一个假的「记录下来的启动时间」基准点（2026-10-12 10:00:00 UTC）。 */
const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);

/* ================================================================== *
 * ① 纯判据：三态
 * ================================================================== */
describe("① 身份判据：same 才动手，recycled / unverifiable 都不动手", () => {
  test("启动时间没变 → same（**可以**终止）", () => {
    const v = pidIdentityVerdict({ recordedStartMs: T0, actualStartMs: T0 + 40 });
    assert.equal(v.verdict, VERDICT_SAME);
    assert.match(v.why, /一致/, "要说清凭什么判同一个人");
  });

  test("★ PID 相同但启动时间变了 → recycled（**拒绝**终止）", () => {
    // 原进程 10:00:00 启动 → 10:30 死了 → Windows 把同一个 PID 给了 14:00 起的别的程序
    const v = pidIdentityVerdict({ recordedStartMs: T0, actualStartMs: T0 + 4 * 3600_000 });
    assert.equal(v.verdict, VERDICT_RECYCLED);
    assert.match(v.why, /回收/, "要明说这个 PID 已经被系统回收给别的程序了");
  });

  test("反向对照：同一组输入，差 40ms 与差 4h 必须落在两侧（证明不是恒真）", () => {
    assert.equal(pidIdentityVerdict({ recordedStartMs: T0, actualStartMs: T0 + 40 }).verdict, VERDICT_SAME);
    assert.equal(pidIdentityVerdict({ recordedStartMs: T0, actualStartMs: T0 + 4 * 3600_000 }).verdict, VERDICT_RECYCLED);
  });

  test("反向对照：把启动时间校验整个去掉（只留 PID 存活），两种情况都会变成「杀」", () => {
    // 旧代码只有 process.kill(pid, 0)，它对这两个输入的答案一模一样：
    const oldWay = (pidAlive) => (pidAlive ? "kill" : "skip");
    assert.equal(oldWay(true), oldWay(true), "旧判据分不出「同一个进程」与「PID 被回收」");
    assert.equal(oldWay(true), "kill", "于是它会对完全无关的程序也返回 kill —— 这就是那个洞");
  });

  test("取不到实测启动时间 → unverifiable（**不杀**）", () => {
    const v = pidIdentityVerdict({ recordedStartMs: T0, actualStartMs: null });
    assert.equal(v.verdict, VERDICT_UNVERIFIABLE);
    assert.match(v.why, /取不到/, "必须说清是「读不到」而不是「不是同一个」");
  });

  test("非法 PID → unverifiable（不杀），且绝不变成拼进命令行的数字", async () => {
    /* 归一化必须挡住 `Number(true)===1` / `Number(null)===0` / `Number([])===0`：
     * 这个值会拼进 PowerShell 的 `-Filter 'ProcessId=N'`。每一种都必须**压根不去问**。 */
    for (const bad of [0, -1, 1.5, "abc", "", null, undefined, NaN, true, false, [], {}, "1; rm -rf x"]) {
      let asked = 0;
      const v = await verifyPidRecord({
        pid: bad, record: { startTimeMs: T0 },
        readStartMs: async () => { asked++; return T0; },
      });
      assert.equal(v.verdict, VERDICT_UNVERIFIABLE, `${JSON.stringify(bad)} 应当核不了`);
      assert.equal(asked, 0, `${JSON.stringify(bad)} 竟然被拿去查启动时间了`);
    }
    // 合法的那两种写法照常判
    assert.equal((await verifyPidRecord({ pid: "4242", record: { startTimeMs: T0 }, readStartMs: async () => T0 })).verdict, VERDICT_SAME);
    assert.equal((await verifyPidRecord({ pid: 4242, record: { startTimeMs: T0 }, readStartMs: async () => T0 })).verdict, VERDICT_SAME);
  });
});

/* ================================================================== *
 * ② 没有启动时间字段时：锚点上界 / 旧格式一律不杀
 * ================================================================== */
describe("② 旧格式 PID 文件（没有启动时间）怎么处理", () => {
  test("有锚点（文件写入时刻）→ 能判：进程比文件老 = same", () => {
    // sidecar.pid 是 WorkBuddy 自己写的，格式不由我们定 → 退到「文件写入时刻」当上界。
    const v = pidIdentityVerdict({ recordedStartMs: null, actualStartMs: T0, anchorMs: T0 + 1000 });
    assert.equal(v.verdict, VERDICT_SAME);
  });

  test("★ PID 文件写着它、但进程比文件还晚起（PID 被回收）→ recycled，不杀", () => {
    const v = pidIdentityVerdict({ recordedStartMs: null, actualStartMs: T0 + 60 * 60_000, anchorMs: T0 });
    assert.equal(v.verdict, VERDICT_RECYCLED);
    assert.match(v.why, /回收/, "理由要说给用户听");
  });

  test("★ 旧格式 + 没有任何锚点（来自 HTTP 自报而不是文件）→ unverifiable，**不杀**", async () => {
    // 老版本服务不报 startTimeMs，又没有文件可当锚点 → 核不到 → 按保守起见不终止。
    const v = await verifyPidRecord({
      pid: PID, record: { pid: PID, up: true, version: "1.0.76" }, file: null,
      readStartMs: async () => T0 + 5 * 60_000,       // 进程确实活着、启动时间也读得到
    });
    assert.equal(v.verdict, VERDICT_UNVERIFIABLE, "读得到启动时间也不够——没有可对照的记录就不许动手");
    assert.match(v.why, /没有启动时间/, "要说清为什么核不了");
  });

  test("反向对照：同一个「旧格式」记录，补上 startTimeMs 之后立刻能判", async () => {
    const bad = await verifyPidRecord({
      pid: PID, record: { pid: PID }, file: null,
      readStartMs: async () => T0 + 5 * 60_000,
    });
    assert.equal(bad.verdict, VERDICT_UNVERIFIABLE);
    const good = await verifyPidRecord({
      pid: PID, record: { pid: PID, startTimeMs: T0 + 5 * 60_000 }, file: null,
      readStartMs: async () => T0 + 5 * 60_000 + 12,   // 同一进程：读数只差几毫秒
    });
    assert.equal(good.verdict, VERDICT_SAME, "写的一侧记了启动时间 → 就能判了");
  });

  test("记录字段名兼容：数字、ISO 串、几种常见写法都认", () => {
    assert.equal(recordedStartFromRecord({ startTimeMs: T0 }), T0);
    assert.equal(recordedStartFromRecord({ startedAt: new Date(T0).toISOString() }), T0);
    assert.equal(recordedStartFromRecord({ start_time: String(T0) }), T0);
    assert.equal(recordedStartFromRecord({ pid: 1 }), null, "老格式 → null（=无法验证）");
    assert.equal(recordedStartFromRecord(null), null);
    assert.equal(recordedStartFromRecord({ startedAt: "not-a-date" }), null, "垃圾值不许被当成有效时间");
  });

  test("★ 旧格式 + PID 文件 → **不杀**（verifyPidRecord 走锚点后能判，但判不过就不动手）", async () => {
    // 真文件，mtime 固定在 T0；实测进程启动时间比 mtime 还晚 1 小时 → 判定为 PID 已回收。
    // ⚠️ utimesSync 吃的是 **Date（毫秒）**，不要再 /1000 —— 那会把锚点推到 1970 年去。
    const f = path.join(TMPROOT, "sidecar.pid");
    writeFileSync(f, JSON.stringify({ pid: PID, controlPipeUuid: "u" }));
    const when = new Date(T0);
    utimesSync(f, when, when);
    const rec = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(recordedStartFromRecord(rec), null, "这个文件是老格式（没有启动时间字段）");
    const v = await verifyPidRecord({ pid: PID, file: f, record: rec, readStartMs: async () => T0 + 3600_000 });
    assert.equal(v.verdict, VERDICT_RECYCLED, `锚点读成了 ${v.anchorMs}，期望 ${T0}`);
    // 反向：同一文件，进程比 mtime 老 → 同一个进程，可以动手
    const ok = await verifyPidRecord({ pid: PID, file: f, record: rec, readStartMs: async () => T0 - 5000 });
    assert.equal(ok.verdict, VERDICT_SAME);
  });
});

/* ================================================================== *
 * ③ 端到端（注入桩）：verifyPidRecord 的完整链路
 * ================================================================== */
describe("③ verifyPidRecord：读实测值 → 选锚 → 判定", () => {
  test("注入的实测值不抛异常就一定会被用上（桩真的接上了）", async () => {
    let asked = null;
    const v = await verifyPidRecord({
      pid: PID, record: { pid: PID, startTimeMs: T0 },
      readStartMs: async (p) => { asked = p; return T0; },
    });
    assert.equal(asked, PID, "必须按记录里的 PID 去问启动时间");
    assert.equal(v.verdict, VERDICT_SAME);
  });

  test("取启动时间那一步抛异常 → 落 unverifiable，不许崩、也不许放行", async () => {
    const v = await verifyPidRecord({
      pid: PID, record: { pid: PID, startTimeMs: T0 },
      readStartMs: async () => { throw new Error("powershell 炸了"); },
    });
    assert.equal(v.verdict, VERDICT_UNVERIFIABLE);
  });

  test("PID 非法 → unverifiable，且**不会**去问启动时间", async () => {
    let called = 0;
    const v = await verifyPidRecord({ pid: "abc", record: {}, readStartMs: async () => { called++; return T0; } });
    assert.equal(v.verdict, VERDICT_UNVERIFIABLE);
    assert.equal(called, 0, "非法 PID 一律直接拒掉——它还会拼进命令行");
  });

  test("三态文案都要说清「为什么没动手」——尤其 unverifiable 不许静默", () => {
    const m = (verdict) => pidIdentityMessage(pidIdentityVerdict(verdict), { pid: PID, source: "测试" });
    assert.match(m({ recordedStartMs: T0, actualStartMs: T0 }), /身份核对通过/, "same：核对通过");
    assert.match(m({ recordedStartMs: T0, actualStartMs: T0 + 9e6 }), /拒绝终止/, "recycled：明说拒绝");
    assert.match(m({ recordedStartMs: T0, actualStartMs: null }), /跳过终止/, "unverifiable：明说跳过");
    assert.match(m({ recordedStartMs: T0, actualStartMs: null }), /无法验证/, "并解释核不了的原因");
  });
});

/* ================================================================== *
 * ④ 真机自检：Windows 上确实读得到启动时间（只读自己，不杀任何进程）
 * ================================================================== */
describe("④ 真机自检（只读，绝不终止任何进程）", () => {
  test("selfStartTimeMs() 是有限数且大致等于现在（说明 uptime 相减这条路真的通）", () => {
    const s = selfStartTimeMs();
    assert.ok(Number.isFinite(s) && s > 0, "启动时刻必须是有限正数");
    assert.ok(s <= Date.now(), "启动时刻不可能在将来");
    assert.ok(Date.now() - s < 3600_000, "本进程刚起来，启动时刻不可能差出 1 小时");
  });

  test("真读一次启动时间（读的是**自己**，PowerShell 查询不改任何进程状态）", async () => {
    const actual = await procStartTimeMs(process.pid);
    if (process.platform !== "win32") { assert.equal(actual, null, "非 Windows 明确返回 null（不猜）"); return; }
    assert.ok(Number.isFinite(actual), `Windows 上应当读得到启动时间，实际 ${actual}`);
    const diff = Math.abs(actual - selfStartTimeMs());
    assert.ok(diff <= TOLERANCE_MS + 60_000,
      `CIM 的 CreationDate 与 uptime 推算值差 ${diff}ms，超出合理范围（两者应当只差取整误差）`);
  });

  test("★ 真读一个刚被复用的对照：进程不存在 → null → unverifiable，不许当成同一个人", async () => {
    // 取一个几乎不可能存在的 PID（比 32 位上界还大）：CIM 查不到 → null。
    const v = await verifyPidRecord({ pid: 4294967000, record: { startTimeMs: Date.now() } });
    assert.equal(v.verdict, VERDICT_UNVERIFIABLE);
  });
});

/* ================================================================== *
 * ⑤ 调用点：确实接上了，且没有偷换成 /IM
 * ================================================================== */
describe("⑤ 调用点：两处「PID 来自外部」的终止都过了身份核对", () => {
  test("main.js 的 killServiceIfOurs：核对通过才 taskkill，只按 /PID", () => {
    const fn = MAIN_SRC.slice(MAIN_SRC.indexOf("async function killServiceIfOurs"),
      MAIN_SRC.indexOf("async function ensureServer"));
    assert.ok(fn.length > 200, "必须真的找到这个函数");
    assert.ok(/verifyPidRecord\(/.test(fn), "终止前必须调身份核对");
    assert.ok(/verdict !== procIdentity\.VERDICT_SAME/.test(fn), "只有 same 才允许动手");
    assert.ok(/if \(!procIdentity\)[\s\S]*?return false/.test(fn), "核对模块不可用 → 不杀（不许裸着 taskkill）");
    assert.ok(/taskkill", \["\/F", "\/PID"/.test(fn), "taskkill 仍然只按 PID");
    assert.equal(/\/IM/.test(fn), false, "绝不许出现 /IM（按名字杀会误杀正在跑的正式实例）");
  });

  test("main.js 两处终止都改走这个闸门（不再有裸 taskkill /PID）", () => {
    const bare = MAIN_SRC.match(/execFile\("taskkill", \["\/F", "\/PID"[^\n]*?st\.service\.pid/g) || [];
    assert.equal(bare.length, 0, `仍有 ${bare.length} 处拿 st.service.pid 直接 taskkill`);
    // 定义是 `async function killServiceIfOurs(st, why)`，不带 await，所以只数调用点：
    assert.equal((MAIN_SRC.match(/\bawait killServiceIfOurs\(st,/g) || []).length, 2, "ensureServer 与 restartServer 两处都要走闸门");
    assert.ok(!/\(\s*killServiceIfOurs\(st,/.test(MAIN_SRC), "不许把闸门的结果丢掉");
    assert.ok(/String\(sv\.pid\) === String\(process\.pid\)/.test(MAIN_SRC), "自己永远不杀");
  });

  test("server.mjs 踢侧车：先核对身份再杀，核不过就换一个候选 / 如实报 pid_unverified", () => {
    const fn = SERVER_SRC.slice(SERVER_SRC.indexOf("async function wbKickHostSession"),
      SERVER_SRC.indexOf("function findWbCliScript"));
    assert.ok(/verifyPidRecord\(\{ pid: j\.pid, file: p, record: j \}\)/.test(fn), "必须带 file（拿 mtime 当锚点）与 record");
    assert.ok(/ident\.verdict !== VERDICT_SAME/.test(fn), "核对不过就 continue，绝不选它");
    assert.ok(/action: "pid_unverified"/.test(fn), "要有一个专门的不杀结论，而不是假装没这回事");
    assert.match(fn, /已一律不终止/, "detail 必须明说一个进程都没杀");
    assert.ok(SERVER_SRC.includes('kact === "pid_unverified"'), "超时分诊要接住这个新结论");
  });

  test("进程启动时间是「写 PID 的地方」一并记下的：/api/status 的 service.startTimeMs", () => {
    assert.ok(/const SERVICE_START_MS = selfStartTimeMs\(\)/.test(SERVER_SRC), "服务端自己算出启动时刻（零成本，不用外呼）");
    assert.ok(/service:\s*\{[\s\S]{0,300}startTimeMs: SERVICE_START_MS/.test(SERVER_SRC), "随 service 一起报出去供调用方核对");
  });

  test("红线：本次改动没有引入 taskkill /IM（契约：只按 PID）", () => {
    /* 宽匹配：注释里提到也算——红线是不许出现这个词，不只是不许出现在参数里。 */
    const TASKKILL_IM = /taskkill[^\n]*\/IM/g;
    const mainBad = MAIN_SRC.match(TASKKILL_IM) || [];
    assert.equal(mainBad.length, 0, `main.js 里出现了 /IM 调用：${mainBad.join(" | ")}`);
    // server.mjs 里已知的 /IM 只有自升级 apply.cmd 里那一条**既有**脚本行（本次不动它，
    // 见 REFACTOR-CONTRACT；它不在「PID 来自磁盘文件」的终止路径上）。计数锁死：
    // 新增一条就会红。（匹配在 `/IM` 处收尾，所以还要回源文件确认那一行的全文。）
    const srvAll = SERVER_SRC.match(TASKKILL_IM) || [];
    assert.equal(srvAll.length, 1, `server.mjs 出现了新的 /IM：${srvAll.join(" | ")}`);
    const imLine = SERVER_SRC.split("\n").find((l) => /taskkill[^\n]*\/IM/.test(l));
    assert.match(imLine || "", /taskkill \/F \/IM "B\.AI Router\.exe"/, "那唯一一条必须是既有的 apply.cmd 行");
    // 而本次动过的两条终止路径（服务自报 PID / sidecar PID 文件）必须干净
    const killFn = SERVER_SRC.slice(SERVER_SRC.indexOf("async function wbKickHostSession"),
      SERVER_SRC.indexOf("function findWbCliScript"));
    assert.equal(/\/IM/.test(killFn), false, "踢侧车那条路径里不许出现 /IM");
    const piRaw = readFileSync(path.join(REPO, "src", "server", "proc-identity.cjs"), "utf8");
    const piCode = piRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/\/IM/.test(piCode), false, "新模块的代码里也不许有 /IM");
    assert.equal(/taskkill/.test(piCode), false, "新模块不自己调 taskkill——它只负责判定，动手的事留给调用方");
  });
});