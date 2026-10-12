"use strict";
/**
 * 进程身份核对：**只按 PID 终止之前，先确认这个 PID 还是不是当初那个进程。**
 *
 * ## 为什么要它
 *
 * 契约明文规定「`taskkill` 只按 PID，绝不按进程名（镜像名）杀」——按名字杀会误杀
 * 正在跑的正式实例。但**只按 PID 杀有镜像风险**：原进程已死、Windows 把同一个 PID
 * 分配给了别的程序，此时「PID 还活着」为真，我们却会**杀掉一个完全无关的进程**。
 * 原来的代码链是
 * 「读 PID 文件 → `process.kill(pid, 0)` 判存在 → `process.kill(pid)` 真杀」，
 * 中间没有任何身份校验。
 *
 * ## 判法：启动时间（双重判活）
 *
 * 参考 `.research/dsh-wb/src/host-heartbeat.ts:194-203` 的
 * `isHeartbeatProcessAlive`：记录 PID 的**同时**记录它的启动时间，之后要求
 * 「同一个 PID 的启动时间没变」才动手。进程启动时间在进程存活期间**不变**，
 * 而 PID 一旦被回收，新进程的启动时间一定是**更晚**的——于是两者可判。
 *
 * 取启动时间不新增任何依赖：
 *   · Windows —— `Get-CimInstance Win32_Process` 的 `CreationDate`（PowerShell 内置，
 *     本仓库的 apply.cmd 与 oc-wiring-test 都已经在用同一个数据源）；
 *   · 写的一侧**不用外呼**——`Date.now() - process.uptime() * 1000` 就是自己的启动
 *     时刻，精确且零成本。
 *
 * ## 三态而不是两态（这是本模块的核心）
 *
 *   `"same"`          同一个进程 → **可以**终止
 *   `"recycled"`      PID 已被系统回收给别的进程 → **拒绝**终止
 *   `"unverifiable"`  取不到启动时间（读不到 / 旧格式记录里没有）→ **拒绝**终止
 *
 * ⚠️ `unverifiable` 也**不杀**，是刻意的保守：**校验不了就不动手**，而不是
 *    「查不到就当是自己人」。代价只是偶尔少杀一个僵尸进程，收益是绝不误杀
 *    用户的别的程序。调用方必须把这句话**如实说给用户**，不许静默照杀。
 */

const { execFile } = require("node:child_process");
const fs = require("node:fs");

/** 三态常量。 */
const VERDICT_SAME = "same";
const VERDICT_RECYCLED = "recycled";
const VERDICT_UNVERIFIABLE = "unverifiable";

/**
 * 容差（毫秒）。CIM 的 `CreationDate` 有取整误差，PID 文件的 mtime 与
 * CreationDate 之间也存在毫秒级抖动。**只放宽到秒级**：Windows 的 PID 要绕一大圈
 * 才会被复用，秒级容差不可能把「被复用的新进程」误判成「同一个」。
 */
const TOLERANCE_MS = 5000;

/** 记录里可能出现的启动时间字段名（自己写的、以及顺手记了一笔的第三方）。 */
const START_FIELDS = ["startTimeMs", "startedAt", "start_time", "startTime", "createdAt"];

/**
 * 把任意输入归一成合法 PID（正整数）或 `null`。
 *
 * ⚠️ 与 toEpochMs 同源的坑：`Number(true) === 1`、`Number(null) === 0`。
 *    这个值要拼进 PowerShell 命令行（`-Filter 'ProcessId=N'`），所以**必须**先卡死
 *    类型再取值，绝不能让 `true` 变成 `ProcessId=1`。
 */
function toPid(v) {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 本进程自己的启动时刻（epoch ms）。`process.uptime()` 是单调的运行时长，
 * 两者相减免掉任何一次系统调用——写的一侧因此零成本。
 */
function selfStartTimeMs() {
  return Date.now() - process.uptime() * 1000;
}

/**
 * 读某个 PID **现在**的启动时刻（epoch ms）；读不到返回 `null`。
 *
 * 刻意**不做** `process.kill(pid, 0)` 预判——那是本模块要替代的弱判据，
 * 重复它只会让人以为已经校验过了。进程不存在时 CIM 查不到，天然返回 null。
 */
async function procStartTimeMs(pid) {
  const n = toPid(pid);
  if (n === null) return null;                 // 非法 PID 一律直接拒掉
  if (process.platform !== "win32") return null;   // 本产品只出 Windows 包
  /* `.ToUnixTimeMilliseconds()` 是**方法**不是属性——写成 `Select-Object -ExpandProperty
     UnixTimeMilliseconds` 会报 "Property cannot be found"，于是永远读不到启动时间、
     永远落 unverifiable（虽然不会误杀，但功能等于没接）。这里实测过两种写法。 */
  const ps =
    "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=" + n + "';"
    + "if($p){([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const v = Number(String(stdout || "").trim());
        resolve(Number.isFinite(v) && v > 0 ? v : null);
      });
  });
}

/**
 * 从一条 PID 记录里取「记录下来的启动时间」。取不到返回 `null`（= 旧格式）。
 * 认数字（epoch ms）与 ISO 串两种写法。
 */
function recordedStartFromRecord(record) {
  if (!record || typeof record !== "object") return null;
  for (const k of START_FIELDS) {
    const v = record[k];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    const t = Date.parse(String(v));
    if (Number.isFinite(t) && t > 0) return t;
  }
  return null;
}

/** PID 记录的**写入时刻**：记录里没写启动时间时，用它当「进程不晚于此刻启动」的上界。 */
function pidFileAnchorMs(file) {
  if (!file) return null;
  try { const s = fs.statSync(file).mtimeMs; return Number.isFinite(s) ? s : null; } catch { return null; }
}

/**
 * 归一化一个「时间戳或 null」的输入。
 *
 * ⚠️ 这里的坑很实在：`Number(null) === 0`、`Number("") === 0`，都是**有限数**，
 *    用 `Number.isFinite(Number(x))` 判空会把「没有」当成「1970 年」，于是旧格式
 *    的 PID 记录会被当成「记录了一个 0」，判据整条走偏。所以必须显式挡掉
 *    null / undefined / 空串 / 非正数。
 */
function toEpochMs(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * **纯函数**：判定一次身份核对的结果。测试直接喂数字，不碰真进程。
 *
 * 两种锚：
 *   · `recordedStartMs` —— 记录里**明写了**启动时间（我们自己写的记录走这条）：
 *     两次读数必须一致（差 ≤ 容差），不一致即 `recycled`。
 *   · 没有就退到 `anchorMs` —— 「这个 PID 的启动时间不得晚于锚点时刻」。
 *     PID 文件的写入时刻天然满足它：写文件的进程自己比文件老。
 *   · 两者都没有 → `unverifiable`（**不杀**）。
 */
function pidIdentityVerdict({ recordedStartMs, actualStartMs, anchorMs = null, toleranceMs = TOLERANCE_MS } = {}) {
  const tol = Number.isFinite(Number(toleranceMs)) ? Math.abs(Number(toleranceMs)) : TOLERANCE_MS;
  const rec = toEpochMs(recordedStartMs);
  const act = toEpochMs(actualStartMs);

  if (act === null) {
    return { verdict: VERDICT_UNVERIFIABLE, recordedStartMs: rec, anchorMs: anchorMs ?? null, why: "取不到这个 PID 现在的启动时间（进程可能已退出，或当前平台读不到）" };
  }
  if (rec !== null) {
    const diff = Math.abs(act - rec);
    if (diff <= tol) {
      return { verdict: VERDICT_SAME, recordedStartMs: rec, anchorMs: null, why: `启动时间一致（记录 ${rec} / 实测 ${act}，差 ${diff}ms ≤ 容差 ${tol}ms）` };
    }
    return { verdict: VERDICT_RECYCLED, recordedStartMs: rec, anchorMs: null, why: `启动时间对不上（记录 ${rec} / 实测 ${act}，差 ${diff}ms > 容差 ${tol}ms）——这个 PID 已被系统回收给了别的进程，不再是当初那个` };
  }
  const anc = toEpochMs(anchorMs);
  if (anc === null) {
    return { verdict: VERDICT_UNVERIFIABLE, recordedStartMs: null, anchorMs: null, why: "记录里没有启动时间，也没有可用作上界的锚点时刻——无法验证，按保守起见不终止" };
  }
  if (act <= anc + tol) {
    return { verdict: VERDICT_SAME, recordedStartMs: null, anchorMs: anc, why: `启动时间 ${act} 不晚于记录写入时刻 ${anc}（容差 ${tol}ms）——同一个进程` };
  }
  return { verdict: VERDICT_RECYCLED, recordedStartMs: null, anchorMs: anc, why: `启动时间 ${act} 晚于记录写入时刻 ${anc}（容差 ${tol}ms）——这个 PID 已被系统回收给了别的进程` };
}

/**
 * 面向用户的说明文案。**三态都要说出来**——尤其 `unverifiable`：用户有权知道
 * 我们是「核对过才没动手」还是「压根没核对成」。
 */
function pidIdentityMessage(v, { pid, source } = {}) {
  const head = `${source || "进程身份核对"}：PID ${pid}`;
  if (!v || v.verdict === VERDICT_SAME) return `${head} 身份核对通过（${(v && v.why) || "同一个进程"}）`;
  if (v.verdict === VERDICT_RECYCLED) return `${head} 疑似已被系统回收给别的进程（${v.why}）——**已拒绝终止**，绝不误杀无关程序`;
  return `${head} 无法验证身份（${v.why}）——**已跳过终止**；宁可留着，也不冒险杀错`;
}

/**
 * 一次完整的核对：读实测启动时间 → 选锚 → 判定。
 *
 * `readStartMs` 可注入（测试注入假的，于是断言跑在**真逻辑**上且不碰任何真进程）。
 * `file` 传 null 表示这条记录不来自文件（例如来自 `/api/status` 自报），
 * 此时没有 mtime 锚点，记录里又没有启动时间就必然落到 `unverifiable`。
 */
async function verifyPidRecord({ pid, file = null, record = null, readStartMs = null } = {}) {
  const n = toPid(pid);
  if (n === null) {
    return { verdict: VERDICT_UNVERIFIABLE, recordedStartMs: null, anchorMs: null, why: `PID 非法（${JSON.stringify(pid)}）` };
  }
  const read = typeof readStartMs === "function" ? readStartMs : procStartTimeMs;
  let actualStartMs = null;
  try { actualStartMs = await read(n); } catch { actualStartMs = null; }
  const recordedStartMs = recordedStartFromRecord(record);
  const anchorMs = recordedStartMs === null ? pidFileAnchorMs(file) : null;
  return pidIdentityVerdict({ recordedStartMs, actualStartMs, anchorMs });
}

module.exports = {
  VERDICT_SAME,
  VERDICT_RECYCLED,
  VERDICT_UNVERIFIABLE,
  TOLERANCE_MS,
  selfStartTimeMs,
  procStartTimeMs,
  recordedStartFromRecord,
  pidFileAnchorMs,
  pidIdentityVerdict,
  pidIdentityMessage,
  verifyPidRecord,
};