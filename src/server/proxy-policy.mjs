/**
 * src/server/proxy-policy.mjs —— 「走哪条通道」的判定（纯逻辑，可测）
 *
 * ## 这解决的是「老是被杀掉」
 *
 * 桌面壳的看门狗只看「子进程退出」⇒ 一次**主动**的自重启就被计成一次崩溃
 * （横幅 + 崩溃计数 + 端口互抢）。而「主动自重启」最常见的来源就是**换代理** ——
 * Node 在启动时就把代理配置缓存进 env 了 ⇒ 换了代理就必须重启进程。
 *
 * ⇒ 于是**判定**就成了关键：判得太松 ⇒ 每 10 分钟自杀一次。
 *
 * ### 原来的判据（错在哪）
 *
 * 原来只有一个判据：**端到端 curl 探上游**（`curl -x <代理> … https://api.b.ai/v1/models`）。
 * 任何 HTTP 状态码都算「通」⇒ 只有**超时/连不上**才算不通。
 * 而上游一慢、一限流、证书抖一下 ⇒ 探针就误判「这个代理坏了」⇒ 换代理 ⇒ 重启 ⇒
 * 新进程又去探，**这次另一个代理探通了** ⇒ 再换 ⇒ **来回跳**。
 *
 * 那台机器上 Clash 同时占着 **7890 与 7897** 两个端口，正好构成这个条件：
 * 2026-10-20/21 的日志里，服务以 604s / 1811s / 3617s 的寿命反复退出，
 * 且新进程起来 **4~5 秒**就再退一次（3s 探测延迟 + 1.2s 切换延迟）——
 * 那就是「换过去 → 又探不通 → 换回来」的循环。
 *
 * ### 现在的判据（两级）
 *
 * | 通道 | 「能不能用」怎么判 |
 * | --- | --- |
 * | 本地代理（`http://127.0.0.1:port`） | **端口还通不通**（TCP 连一下）—— 端口通着就说明代理进程还在；上游通不通是**上游**的事，换代理也未必治 |
 * | 直连（`DIRECT` / TUN） | 端到端探上游（直连没有端口可探） |
 *
 * ⇒ **周期探测**只在「当前代理的端口死了」时才换（换到第一个端到端真探得通的候选）。
 * ⇒ **手动检测**（`/api/proxy-detect`，用户点的）用 `thorough` 模式：每条候选都
 *   端到端探 ⇒ 真的能帮用户找到一条能用的路。
 *
 * ## 纪律
 *
 * · 纯逻辑：探针（`portAlive` / `probe`）由调用方注入 ⇒ 本文件能单测。
 * · **拿不准就不动**：判不出来返回 null（调用方不换、不重启）——
 *   宁可少换一次代理，也别让服务反复重启。
 */

import net from "node:net";

/**
 * proxyPortAlive —— 本地代理的**端口**还通不通（只做一次 TCP 连接）。
 *
 * @param {string} proxy  形如 `http://127.0.0.1:7890`
 * @param {number} timeoutMs 超时（默认 1500ms）
 * @returns {Promise<boolean>} 端口通 ⇒ true
 */
export function proxyPortAlive(proxy, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let u = null;
    try { u = new URL(String(proxy || "")); } catch { return resolve(false); }
    const host = u.hostname;
    /* 只有**本地**代理才判端口；别的（理论上不会有）当作「活的」——
       不然会把一个真在用的远程代理误判成死的。 */
    if (!/^(127\.0\.0\.1|localhost|::1)$/i.test(host)) return resolve(true);
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return resolve(false);

    let sock = null;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { sock && sock.destroy(); } catch { /* 忽略 */ }
      resolve(v);
    };
    try {
      sock = net.connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    } catch {
      return done(false);
    }
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.on("timeout", () => done(false));
  });
}

/**
 * chooseChannel —— 选一条「能用」的通道。
 *
 * @param {object} o
 * @param {string} o.current        当前配置的通道（`""` = 直连/TUN）
 * @param {boolean} [o.thorough]    true = 每条候选都要端到端探上游（**手动**检测用）；
 *                                  false = 当前通道只看本地端口（**周期探测**用）
 * @param {string[]} o.candidates    候选通道（按优先级）
 * @param {(p:string)=>Promise<boolean>} o.portAlive  端口判据
 * @param {(p:string)=>Promise<boolean>} o.probe      端到端判据
 * @returns {Promise<string|null>} 选中的通道；null = **一条都没找到**（调用方不换）
 */
export async function chooseChannel(o) {
  const current = String((o && o.current) || "").trim();
  const thorough = !!(o && o.thorough);
  const candidates = [...new Set(((o && o.candidates) || []).filter(Boolean))];
  const portAlive = o && o.portAlive;
  const probe = o && o.probe;
  if (typeof portAlive !== "function" || typeof probe !== "function") {
    throw new Error("chooseChannel 需要 portAlive 与 probe 两个判据");
  }

  /* ① 当前通道能用 ⇒ 就用它，**不换**。 */
  if (current) {
    /* ⚠ 周期探测（thorough=false）**只看本地代理的端口** ——
       上游一慢/一限流就换代理 ⇒ 重启 ⇒ 来回跳（见文件头）。 */
    const ok = thorough ? await probe(current) : await portAlive(current);
    if (ok) return current;
  } else {
    /* 直连没有端口可探 ⇒ 只能端到端探。 */
    if (await probe("DIRECT")) return "DIRECT";
  }

  /* ② 当前通道不能用 ⇒ 按候选顺序找一条**端到端真探得通**的。
     ⚠ 候选必须端到端探通才选：换过去得真能用，
       不然只是把「能用但慢」换成「不能用」而已。 */
  for (const c of candidates) {
    if (c === current) continue;
    if (!(await portAlive(c))) continue;   // 端口都不通 ⇒ 死的，别浪费 6 秒
    if (await probe(c)) return c;
  }
  /* ③ 兜底：直连（TUN/全局模式不需要本地端口）。 */
  if (await probe("DIRECT")) return "DIRECT";
  return null;
}
