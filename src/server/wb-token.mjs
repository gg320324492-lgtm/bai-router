/**
 * wb-token.mjs —— WorkBuddy 访问令牌的 JWT 声明解码（纯逻辑，零 IO、零网络）
 *
 * ## 为什么要独立成一个文件
 *
 *   这三个函数原先住在六千多行的 server.mjs 里，而 server.mjs **一 import 就起服务**
 *   （抢单实例锁、开两个监听端口），于是它们没法被测试直接 import 求值。
 *
 *   代价是真实存在的：池化那次（v1.0.76 / commit 93ce3fe）把
 *   `exp * 1000 > Date.now()` 迁进接线层时漏掉了 `* 1000`，
 *   而 scripts/wb-pool-wiring-test.mjs 全程注入自己的替身 `tokenExpOf`、
 *   **生产里的 wbTokenExp 从没被接进过测试** —— 判据被替身顶替，等于没有判据。
 *   scripts/wb-token-test.mjs 补的就是这一条：把**真实现**接进真实选号路径。
 *
 * ## 单位契约（本文件唯一需要记住的一件事）
 *
 *   {@link wbTokenExp} 返回 **epoch 毫秒**（`p.exp * 1000`），不是 JWT 原生的秒。
 *
 *   接线层 wb-pool-wiring.mjs 的契约三处都按毫秒写：`tokenExpOf` 的签名注释、
 *   参数名 `expMs`、以及 `expMs <= now` / `tokenExpiring(expMs, now)`
 *   （`now` 来自 `Date.now()`）。毫秒也是这个仓库里其余各处的时间单位
 *   —— wb-pool.mjs 的 `toMs` 阈值、凭据的 `lastRefreshTime`/`capturedAt` 都是它。
 *
 *   ⚠ 改本函数时，server.mjs 里读它的几处（面板的 `expAt` / `expiresInDays`、
 *      续期日志的日期）曾经各自乘过 1000，那几处**必须一起改**。
 *      scripts/wb-token-test.mjs 里的「同量纲守卫」就是钉这件事的：
 *      断言 wbTokenExp() 的返回值与 Date.now() 处在同一数量级，
 *      比任何具体数字都耐用 —— 以后谁再顺手去掉这个 ×1000，测试当场红。
 *
 * ## 红线
 *
 *   全文不出现任何真实令牌/API key。只解载荷、**不验签**（理由见 {@link wbJwtPayload}）。
 */

/* 解 JWT 载荷（**不验签**，只取声明里的字段做诊断）。
 * 验不验签跟我们要回答的问题无关：要判断的是「这串令牌是谁的」，
 * 而 sub 是令牌自己声明的签发对象——要的正是"它自称是谁"，
 * 拿去和登录文件里的 account.uid 对一下即可。 */
export function wbJwtPayload(tok) {
  try {
    const seg = String(tok || "").split(".")[1];
    if (!seg) return null;
    const p = JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return p && typeof p === "object" ? p : null;
  } catch { return null; }
}

/**
 * 令牌的到期时刻，**返回 epoch 毫秒**（`p.exp * 1000`）。
 *
 * 取不到（不是 JWT / 没有 exp / exp 不是数字）一律 `null` —— 「读不出」与「已过期」
 * 不是一回事，调用方必须分开处理：接线层只对有限值判过期，`null` 一律按「不知道」放行。
 *
 * @param {string} tok
 * @returns {number|null} epoch **毫秒**
 */
export function wbTokenExp(tok) {
  const p = wbJwtPayload(tok);
  return p && typeof p.exp === "number" ? p.exp * 1000 : null;
}

/** 令牌自称的账号 id（JWT 的 sub）。不是 JWT / 取不到就 null。 */
export function wbTokenSub(tok) {
  const p = wbJwtPayload(tok);
  const s = p && p.sub;
  return typeof s === "string" && s ? s : null;
}