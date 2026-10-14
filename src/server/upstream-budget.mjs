/**
 * upstream-budget.mjs —— 上游「响应头预算」按请求体大小分档（纯逻辑、零 IO、零网络）
 *
 * ## 为什么要独立成一个文件
 *
 *   这套规则原先是一行写死在 `openaiExchange` 里的 `: 30000`。而 server.mjs
 *   **一 import 就起服务**（抢单实例锁、开两个监听端口），住在里面的逻辑没法被
 *   测试直接 import 求值 —— 于是只能「注入一个替身去测」，而替身证明不了本体。
 *   v1.0.76 的 `wbTokenExp` 漏 `* 1000` 就是这么上线的（见 wb-token.mjs 顶部）。
 *   本文件与 zen-probe.mjs / wb-token.mjs / wb-pool.mjs 同属一类：**纯逻辑、
 *   零 IO、零网络**，测试直接 import，断言的就是生产跑的那一份。
 *
 * ## 病根（v1.0.85，实测确认）
 *
 *   WorkBuddy AI（`wbai`）在**大上下文**请求下被我们自己的中转掐断。直连上游、
 *   同样体量的 body、只改历史条数，实测响应头到达耗时：
 *
 *     | 历史条数 | body 大小 | 响应头到达 |
 *     |---------|----------|-----------|
 *     | 100     | 0.42 MB  | 8.7 s     |
 *     | 300     | 1.25 MB  | 15.2 s（复测 15~19 s）|
 *     | 600     | 2.50 MB  | 30.0 s    |
 *
 *   而我们给的是**一刀切 30 秒、没有任何余量**：上传 1.3MB、上游读 1283 条消息、
 *   长上下文预填，全挤在这 30 秒里。一抖就 502，用户看到的现象是
 *   「对话 1 分钟断一次，然后一直重连」。
 *
 *   注意**延迟本身在 30 秒内是能到的**（1.25MB 实测 15~19s）——所以病根不是
 *   「上游太慢」，是「我们的预算没有随体量增长」。
 *
 * ## 分档依据（为什么是这几个数）
 *
 *   把三个实测点拟合一下：t ≈ 4.4 s + 10.2 s/MB。三个点的残差都在 1 秒内
 *   （1.25MB 拟合 17.2s，实测 15.2s，落在复测的 15~19s 带内）。
 *   也就是说**固定开销约 4.4 秒、每 MB 约 10.2 秒**。预算按这个斜率配，
 *   每一档都留 1.8~3.2 倍余量：
 *
 *     | 档位            | 预算   | 拟合需要 | 余量  |
 *     |-----------------|--------|---------|-------|
 *     | < 512 KB        | 30 s   | 9.5 s   | 3.2×  |
 *     | < 1.5 MB        | 45 s   | 19.8 s  | 2.3×  |
 *     | < 3 MB          | 75 s   | 35.1 s  | 2.1×  |
 *     | < 6 MB          | 120 s  | 65.8 s  | 1.8×  |
 *     | ≥ 6 MB          | 180 s  | （封顶） |       |
 *
 *   余量随体量增大而收窄是**故意的**：档位越大，30 秒那个固定底噪占比越小，
 *   而再往上放宽会让「上游真的挂了」也要等更久才失败转移。180 秒是硬上限 ——
 *   「必须有上限」和「必须够用」是同一个约束的两面，只满足一面就是另一种故障。
 *
 * ## ⚠ 单位：字节，不是字符
 *
 *   调用方必须传 `Buffer.byteLength(bodyStr)`，**不是** `bodyStr.length`。
 *   中文场景下 UTF-8 是 3 字节/字，字节数能到字符数的 3 倍 —— 拿字符数去分档，
 *   等于把「2.5MB 的请求」当成「0.85MB 的请求」发给一个 30 秒预算，正好修不到点子上。
 *   {@link upstreamBodyBytes} 就是为这件事存在的：把「怎么安全地取字节数」
 *   收在一处，调用方没有机会用错。
 *
 * ## 红线
 *
 *   🔴 本文件零 IO、零网络、零定时器、零进程。只做整数比较与查表。
 */

/* ---------- 响应头预算（连接 + 上传 + 上游读完请求 + 响应头） ---------- */

/** 小请求的响应头预算（毫秒）。**这就是原来那个一刀切的 30 秒，一个字都没改。**
 *  导出它是为了让测试能钉住「小请求没有被顺手放宽」——那是本次改动唯一的回归风险。 */
export const UPSTREAM_HEADER_TIMEOUT_MS = 30000;

/** 分档表，从小到大排列，`maxBytes` 是**上界（不含）**。 */
export const UPSTREAM_HEADER_TIERS = Object.freeze([
  Object.freeze({ maxBytes: 512 * 1024, ms: UPSTREAM_HEADER_TIMEOUT_MS, why: "≤0.5MB：小对话，30 秒本来就有 3.2 倍余量，不动" }),
  Object.freeze({ maxBytes: 1536 * 1024, ms: 45000, why: "≤1.5MB：覆盖实测的 1.25MB（需 15~19s）" }),
  Object.freeze({ maxBytes: 3 * 1024 * 1024, ms: 75000, why: "≤3MB：覆盖实测的 2.5MB（需 30s）" }),
  Object.freeze({ maxBytes: 6 * 1024 * 1024, ms: 120000, why: "≤6MB：按 10.2s/MB 外推需 65.8s" }),
]);

/** 预算硬上限（毫秒）。再大的 body 也只等这么久 —— 不能无限等。 */
export const UPSTREAM_HEADER_BUDGET_CAP_MS = 180000;

/* ---------- 首事件闸门预算 ---------- */

/** 首事件闸门的下限（毫秒）。**小请求今天就是 90 秒，逐字不变。** */
export const UPSTREAM_FIRST_EVENT_FLOOR_MS = 90000;

/** 首事件闸门相对响应头预算的倍数。
 *  响应头预算里已经含了「上传 + 上游读完请求」；首事件还要再等一轮预填，
 *  所以按 2 倍给。取 2 而不是 3：3 倍会让 3MB 档的首事件等到 225 秒、6MB 档等到
 *  360 秒，而闸门等满意味着「上游连上了却一直不吐字」也要挂那么久才转移 ——
 *  那是把一种故障换成了另一种。 */
export const UPSTREAM_FIRST_EVENT_FACTOR = 2;

/** 首事件闸门的硬上限（毫秒）。 */
export const UPSTREAM_FIRST_EVENT_CAP_MS = 300000;

/**
 * 请求体的字节数。**只认字符串**；其余形态（Buffer / undefined / null）按「读不出」处理。
 *
 * ⚠ 这里刻意不用 `bodyStr.length`：那是**字符数**。中文（以及 emoji、CJK 标点）
 * 在 UTF-8 下是 3~4 字节，0.85M 字符的请求体实际是 2.5MB。拿字符数分档会让
 * 最需要放宽的那一档拿到底噪预算，修了等于没修。
 *
 * @param {string} bodyStr
 * @returns {number} 字节数；不是字符串时返回 0
 */
export function upstreamBodyBytes(bodyStr) {
  if (typeof bodyStr !== "string") return 0;
  return Buffer.byteLength(bodyStr);
}

/** 把「字节数」归一成一个可比较的非负整数。非有限值一律当成最大档 ——
 *  「读不出大小」不等于「请求很小」，赌小的代价是把一次本来会成功的请求掐断。 */
function normBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return Number.isFinite(n) && n <= 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.floor(n);
}

/**
 * 响应头预算（毫秒）＝ f(请求体字节数)。
 *
 * 单调不降、有上限。小 body（< 512 KB）恒等于 {@link UPSTREAM_HEADER_TIMEOUT_MS}。
 *
 * @param {number} bytes 请求体**字节数**（见 {@link upstreamBodyBytes}）
 * @returns {number} 毫秒，落在 [30000, 180000]
 */
export function upstreamHeaderBudgetMs(bytes) {
  const n = normBytes(bytes);
  if (!Number.isFinite(n)) return UPSTREAM_HEADER_BUDGET_CAP_MS;
  for (const t of UPSTREAM_HEADER_TIERS) if (n < t.maxBytes) return t.ms;
  return UPSTREAM_HEADER_BUDGET_CAP_MS;
}

/**
 * 首事件闸门预算（毫秒）。**必须不窄于** {@link upstreamHeaderBudgetMs} 的返回值 ——
 * 否则「响应头等到了、首事件又被掐」，用户看到一次「已经连上却又断」，
 * 比不修更糟。所以这里取 `max(90 秒, 响应头预算 × 2)`，再封顶 300 秒。
 *
 * 小请求（< 512 KB）恒等于 90 秒，与改动前逐字相同。
 *
 * @param {number} bytes 请求体**字节数**
 * @returns {number} 毫秒，落在 [90000, 300000]
 */
export function upstreamFirstEventBudgetMs(bytes) {
  const head = upstreamHeaderBudgetMs(bytes);
  const widened = head * UPSTREAM_FIRST_EVENT_FACTOR;
  return Math.min(UPSTREAM_FIRST_EVENT_CAP_MS, Math.max(UPSTREAM_FIRST_EVENT_FLOOR_MS, widened));
}

/** 这一档的人类可读理由（面板/日志/测试断言用，不参与计算）。 */
export function upstreamBudgetTierLabel(bytes) {
  const n = normBytes(bytes);
  if (!Number.isFinite(n)) return `≥6MB（读不出大小，按上限等）`;
  for (const t of UPSTREAM_HEADER_TIERS) if (n < t.maxBytes) return `<${Math.round(t.maxBytes / 1024)}KB → ${t.ms}ms`;
  return `≥${Math.round(UPSTREAM_HEADER_TIERS[UPSTREAM_HEADER_TIERS.length - 1].maxBytes / 1024)}KB → ${UPSTREAM_HEADER_BUDGET_CAP_MS}ms（封顶）`;
}
