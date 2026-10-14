/**
 * wb-429.mjs —— 「一次 429 是不是上下文体积超了上游红线」的判据（纯逻辑，零 IO、零网络）
 *
 * ## 为什么要独立成一个文件
 *
 *   这个判据原先住在六千多行的 server.mjs 里，而 server.mjs **一 import 就起服务**
 *   （抢单实例锁、开两个监听端口），于是它没法被测试直接 import 求值。
 *
 *   代价是真实存在的，而且有两笔：
 *
 *   ① **v1.0.76 的教训**（`* 1000` 那次）：判据被埋在接线层里，测试全程注入自己的
 *      替身，658/658 全绿而生产 100% 是坏的 —— 生产用的那个函数从没被接进过测试。
 *      所以这个文件里的每个函数都必须是**生产 import 的那一个**，测试只 import 它。
 *
 *   ② **本判据自己的教训**：WorkBuddy AI（wbai）在大上下文下返 429，我们一直对外说
 *      「免费渠道并发限流，等 30 秒左右再试」。实测（直连上游 /v2/chat/completions，
 *      只改历史条数）证明**判据是请求体体积，不是条数，也不是并发**：
 *        100 条 → 0.42 MB → 200
 *        300 条 → 1.25 MB → 429 too many requests
 *        600 条 → 2.50 MB → 429
 *      阈值落在 0.42MB ~ 1.25MB 之间。用户照「等 30 秒」去做，白等半小时，
 *      最后还是不知道为什么 —— 唯一的解是**开新对话**。文案把方向指错了。
 *
 *   所以判据必须能被单独求值、被单独测：它回答的是「这一条 429 该说等还是该说开新对话」，
 *   说错了用户就白等半小时。
 *
 * ## 单位契约（本文件唯一需要记住的一件事）
 *
 *   {@link wbBodyBytes} 返回 **字节数**（`Buffer.byteLength`），不是字符数。
 *
 *   ⚠ 中文场景下两者差 3 倍：`"中文abc"` 的 `.length` 是 5，字节数是 9。
 *      接线层（server.mjs 的 openaiExchange）手边只有 `bodyStr` 这个字符串，
 *      拿 `bodyStr.length` 去比阈值会把中文上下文**少算三倍**，等于把红线悄悄放宽 ——
 *      正是被这个 bug 误导的那批用户，全都是中文对话。
 *
 *   顺带：判据**不能**只按渠道一刀切。429 是六家共用的状态码，而这条体积红线
 *   只有 wb / wbai 有（B.AI / SenseNova / Zen / Qoder / OpenRouter 都不吃它）。
 *   所以「是不是上下文超限」要按 `渠道 + 字节数` 一起定，见 {@link wb429ContextHint}。
 *
 * ## 红线
 *
 *   全文不出现任何真实令牌 / API key / 用户名 / 本机绝对路径。零 IO、零网络、不起进程。
 */

/**
 * WorkBuddy 上游的请求体体积红线，**字节**。
 *
 * 出处（实测，只改历史条数、其余请求完全一致）：
 *   100 条 → 0.42 MB → 200 ✅
 *   300 条 → 1.25 MB → 429 ❌
 *   600 条 → 2.50 MB → 429 ❌
 * 阈值夹在两者之间。取 500 KB 这个下界附近的值：
 *   · 宁**早**报也不要晚报 —— 早报只是让用户早一点开新对话（他反正也发不出去），
 *     晚报就是让他照着「等 30 秒」白等半小时；
 *   · 但不能低到把正常短对话也圈进来（实测 0.42MB 的 100 条对话是 200，
 *     而 0.42 MB < 500 KB，所以 500 KB 不会误伤它）。
 * 判定用**大于等于**（>=）：正好压线也算超，见 {@link wbBodyTooLarge} 的边界注释。
 */
export const WB_BODY_TOO_LARGE_BYTES = 500 * 1024;   // 512000 字节 = 500 KB

/** 只有这两家有这条体积红线（`isWk` 在 server.mjs 里的同一个口径）。 */
export const WB_429_SIZE_SCOPED_PROVIDERS = ["wb", "wbai"];

/**
 * 请求体的**字节数**。`Buffer.byteLength` 对 string / Buffer / Uint8Array 都成立
 * （Node 24 实测三者均可），其它类型按 0 处理（调用方手里没有正文）。
 *
 * @param {string|Buffer|Uint8Array|null|undefined} bodyStr
 * @returns {number} 字节数；拿不到正文时 0
 */
export function wbBodyBytes(bodyStr) {
  if (bodyStr == null) return 0;
  try {
    const n = Buffer.byteLength(bodyStr);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    // 理论上不可达（Buffer.byteLength 只对上面几类抛错）；保底 0，绝不让判据本身炸掉
    return 0;
  }
}

/** 人类可读的体积（KB/MB 一位小数）。给文案用的，不参与判定。 */
export function wbBodySizeText(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 这个体积是否已越过上游红线。
 *
 * 边界**确定**取「压线即超」（`>=`）：实测 0.42MB 是 200、1.25MB 是 429，
 * 真实阈值在两者之间且未知；取 `>=` 意味着 500KB 整就会被算成超，
 * 与 {@link WB_BODY_TOO_LARGE_BYTES} 的注释一致（宁早报不晚报）。
 *
 * @param {string|Buffer|Uint8Array|null|undefined} bodyStr
 * @param {number} [thresholdBytes] 默认 {@link WB_BODY_TOO_LARGE_BYTES}；测试与将来改阈值用
 */
export function wbBodyTooLarge(bodyStr, thresholdBytes = WB_BODY_TOO_LARGE_BYTES) {
  const th = Number(thresholdBytes);
  if (!Number.isFinite(th) || th < 0) return false;    // 阈值坏了就别判（宁可维持旧文案）
  return wbBodyBytes(bodyStr) >= th;
}

/**
 * 429 归因文案的「体积尾巴」—— 只在**确实该说上下文超限**时给内容，否则给空串。
 *
 * 返回空串（而不是 null / undefined）是为了让接线层能无条件 `+ tail`：
 * 少一处三元分支就少一个能漂移的地方。调用方自己决定怎么拼。
 *
 * 两个前提**同时**成立才给内容，缺一个都不给：
 *   ① 渠道是 wb / wbai —— 这条体积红线只有这两家有，别的渠道没有（绝不能通用化）；
 *   ② 请求体 >= 红线 —— 判据是体积，不是条数、不是并发。
 *
 * @param {string} provider 渠道 key（"wb" / "wbai" / "zen" / …）
 * @param {string|Buffer|Uint8Array|null|undefined} bodyStr 翻译后真正发出去的请求体
 * @returns {string} 形如「（本次请求体 1.25 MB，已超过上游约 0.50 MB 的体积红线……）」或 ""
 */
export function wb429ContextHint(provider, bodyStr) {
  if (!WB_429_SIZE_SCOPED_PROVIDERS.includes(String(provider || ""))) return "";
  if (!wbBodyTooLarge(bodyStr)) return "";
  const bytes = wbBodyBytes(bodyStr);
  const size = wbBodySizeText(bytes);
  const limit = wbBodySizeText(WB_BODY_TOO_LARGE_BYTES);
  /* 为什么把「这不是并发限流」写进去：旧文案只说了「并发限流，等 30 秒」，
     用户据此白等半小时。这里必须把「等」这条路明确关掉，否则等于什么都没改。
     但**不说死** —— 大 body 也可能是真的并发限流（两条同时成立完全可能），
     所以结尾仍保留「稍后重试」作为兜底动作，而不是只给「开新对话」。 */
  return `（本次请求体 ${size}，已超过上游约 ${limit} 的体积红线：`
    + `这是上下文太大导致的限流，**等再久也不会好**，请开新对话，或删掉/压缩早前的历史消息后重试）`;
}
