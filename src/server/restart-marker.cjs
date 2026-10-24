/**
 * src/server/restart-marker.cjs —— 「主动退出」标记（写与读都在这里）
 *
 * ## 这解决的是「老是被杀掉」
 *
 * 桌面壳（src/main.js）的看门狗只看「子进程退出」这一件事 ⇒ 它分不清
 *
 *   ① **进程自己决定退出** —— 代理切换、NO_PROXY 自检、用户点的重启与停止、升级安装
 *   ② **它崩了**
 *
 * ⇒ 于是 ① 被计成 ②：弹「服务已自动恢复运行」横幅、计入「连续 5 次秒退 ⇒ 熔断切诊断页」
 * 的计数、甚至触发「系统 Node 不兼容」的运行时切换。
 *
 * 那台机器上 Clash 同时占着 **7890 与 7897** 两个端口，10 分钟一次的代理探测在两者
 * 之间来回跳 ⇒ **每跳一次自杀一次** ⇒ 用户看到的现象就是「软件老是被杀掉」。
 *
 * ⇒ 办法很朴素：**主动退出前留一个标记**，壳读到它就知道这次是「安排好的」。
 *
 * ## 形状
 *
 *   {"reason":"proxy-changed","at":1750000000000}
 *
 * · `reason` —— 机器可读的短标签（见下方 REASONS）
 * · `at` —— 写标记的时刻（毫秒）⇒ 用来判断标记是否**新鲜**
 *
 * ## 两条纪律
 *
 * ★ **一次性**：读走就删 ⇒ 标记只对**那一次**退出有效。
 * ★ **不许遮住真崩溃**：标记超过 FRESH_MS 就是过期（上次没被读到、这次是真的崩了）
 *   ⇒ 一律按**崩溃**处理。宁可多报一次崩溃，不许把真崩溃藏起来。
 *
 * ## 为什么放在 src/server/ 下（而不是 src/）
 *
 * 这个文件**两边都要用**：服务端（server.mjs，ESM）写、壳（main.js，CommonJS）读。
 * 打包时 src/server 会整份复制到 `resources/server/`（extraResources），
 * 而壳在 `resources/app/` ⇒ 只有把文件放在 server 那一侧，两边才都够得着
 * （壳按 app.isPackaged 拼 `resources/server/restart-marker.cjs`）。
 *
 * 扩展名用 `.cjs` 是因为同目录下已有 `proc-identity.cjs` 这个先例：
 * server 目录里没有 package.json，`.js` 会按 CommonJS 解析，但显式写 `.cjs`
 * 不受将来任何 package.json 的影响。
 */

const fs = require("node:fs");
const path = require("node:path");

/** 标记文件名（落在数据目录里，与 config.json 同级）。 */
const MARKER_FILE = "restart-reason.json";

/** 标记最多算「新鲜」多久（毫秒）。超过 ⇒ 当作没有标记（不许遮住真崩溃）。 */
const FRESH_MS = 120000;

/**
 * 已知的退出原因（写的人与读的人共用这一份 ⇒ 形状不会漂）。
 *
 * · proxy-changed       —— 代理探测换了通道，进程必须重启才能让新代理生效
 * · no-proxy-selfcheck  —— NO_PROXY 自检发现与壳算的不一致，自行重启一次
 * · user-restart        —— 用户在面板上点了「重启服务」
 * · user-stop           —— 用户在面板上点了「停止服务」
 * · selfupdate-install  —— 升级安装脚本要接管了，本进程让位
 */
const REASONS = Object.freeze([
  "proxy-changed",
  "no-proxy-selfcheck",
  "user-restart",
  "user-stop",
  "selfupdate-install",
]);

/** 标记文件在哪个目录下的完整路径。 */
function markerPath(dataDir) {
  return path.join(String(dataDir || ""), MARKER_FILE);
}

/**
 * 写标记（服务端在**自己决定退出之前**调用）。
 *
 * @param {string} dataDir 数据目录（壳与服务端指向同一个）
 * @param {string} reason  原因标签
 * @returns {boolean} 写成功与否（**写不出去也不该挡住退出** —— 顶多多一次误报的崩溃横幅）
 */
function markIntentionalExit(dataDir, reason) {
  try {
    fs.writeFileSync(
      markerPath(dataDir),
      JSON.stringify({ reason: String(reason), at: Date.now() }),
      "utf8"
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 读标记（壳在子进程退出时调用）。
 *
 * @param {string} dataDir 数据目录
 * @returns {{intentional: boolean, reason: string|null, why: string, ageMs: number}}
 *   · `intentional: true` ⇒ 这次退出是**安排好的**（不是崩溃）
 *   · `intentional: false` ⇒ 没有标记 / 标记坏了 / 标记过期 ⇒ 按**崩溃**处理
 *   · `why` —— 判定依据（no-marker / bad-json / no-reason / stale / ok），只为排查用
 */
function readRestartReason(dataDir) {
  const f = markerPath(dataDir);
  let raw = null;
  try {
    if (!fs.existsSync(f)) return { intentional: false, reason: null, why: "no-marker", ageMs: 0 };
    raw = fs.readFileSync(f, "utf8");
  } catch {
    return { intentional: false, reason: null, why: "no-marker", ageMs: 0 };
  }
  // 一次性：读完就删（删不掉也不影响这次判定 —— 下一轮会再删一次）
  try { fs.unlinkSync(f); } catch { /* 忽略 */ }

  let j = null;
  try { j = JSON.parse(raw); } catch { /* 忽略 */ }
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    return { intentional: false, reason: null, why: "bad-json", ageMs: 0 };
  }
  if (typeof j.reason !== "string" || !j.reason) {
    return { intentional: false, reason: null, why: "no-reason", ageMs: 0 };
  }
  const at = typeof j.at === "number" ? j.at : NaN;
  if (!Number.isFinite(at)) {
    return { intentional: false, reason: j.reason, why: "no-reason", ageMs: 0 };
  }
  const ageMs = Date.now() - at;
  // 未来时间戳也当过期（时钟跳变 / 写坏）⇒ 不许拿它遮住真崩溃
  if (ageMs < 0 || ageMs > FRESH_MS) {
    return { intentional: false, reason: j.reason, why: "stale", ageMs };
  }
  return { intentional: true, reason: j.reason, why: "ok", ageMs };
}

module.exports = { MARKER_FILE, FRESH_MS, REASONS, markerPath, markIntentionalExit, readRestartReason };
