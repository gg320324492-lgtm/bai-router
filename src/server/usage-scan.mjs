/**
 * usage-scan —— 从**流过的** SSE 字节里顺手捡出用量数字，不改流、不缓冲。
 *
 * 为什么需要它：账本（usage-ledger）要记这次请求花了多少 token，但——
 * · 协议桥那条路（wb/wbai/qd/or/zen/mm）：用量是桥自己解析出来的，**传得上来**；
 * · 透传那条路（bai/sn）：上游的 Anthropic 响应是**原样管道**过去的
 *   （`stream.pipe(res)`），中转根本没看内容，所以拿不到用量。
 *
 * 那就在管道中间插一个 Transform：字节**原样透传**（不缓冲、不改变时序），
 * 同时在文本里扫 usage 字段。Anthropic 的 SSE 里：
 *   · `message_start` 事件带 `usage.input_tokens` 与 `usage.cache_read_input_tokens`
 *   · `message_delta` 事件带 `usage.output_tokens`
 * OpenAI 的 SSE 里：`usage.prompt_tokens` / `usage.completion_tokens` /
 *   `usage.prompt_tokens_details.cached_tokens`
 *
 * ⚠ **只捡「见过的第一个」与「见过的最后一个」**：
 *   · input / cache_read 出现在流的开头（message_start）→ 取**第一个**；
 *   · output 出现在流的末尾（message_delta）→ 取**最后一个**。
 *
 * ⚠ 数字可能被 chunk 切开，所以每次都带着上一块的尾巴一起扫（重叠 256 字符，
 *   足够装下任何一个 JSON 数字）。扫完只留尾巴，内存有界。
 */
import { Transform } from "node:stream";

const OVERLAP = 256;

/* 各家给 token 数起的名。用一个宽松的写法统一认：
 *   "input_tokens":123  /  "prompt_tokens":123  /  "inputTokens":123
 * 缓存另认：cache_read_input_tokens / cache_read_tokens / cached_tokens */
const IN_RE = /"(?:input_tokens|prompt_tokens|inputTokens)"\s*:\s*(\d+)/g;
const OUT_RE = /"(?:output_tokens|completion_tokens|outputTokens)"\s*:\s*(\d+)/g;
const CACHE_RE = /"(?:cache_read_input_tokens|cache_read_tokens|cached_tokens|prompt_tokens_details)"\s*:\s*(\d+)/g;

/**
 * 造一个扫描器。
 * @param {object} sink 会被就地填上 { in, out, cacheRead, cacheWrite }（未见到就不填）
 */
export function makeUsageScanner(sink) {
  const out = sink && typeof sink === "object" ? sink : {};
  let tail = "";
  let seenIn = false;
  let seenOut = false;
  let seenCache = false;

  function scan(text) {
    /* 缓存：OpenAI 把缓存放在 details 对象里（嵌套一层），那个正则抓不到，
     * 所以缓存另认一次 "cached_tokens"。 */
    IN_RE.lastIndex = 0;
    let m;
    while ((m = IN_RE.exec(text)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) { out.in = n; seenIn = true; }
      break;                       // 只取第一个
    }
    OUT_RE.lastIndex = 0;
    while ((m = OUT_RE.exec(text)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) { out.out = n; seenOut = true; }
      /* 继续扫：输出可能在多个事件里出现（流式增量），取**最后一个**。 */
    }
    CACHE_RE.lastIndex = 0;
    while ((m = CACHE_RE.exec(text)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && !seenCache) { out.cacheRead = n; seenCache = true; }
      break;
    }
    if (!seenCache) {
      const m2 = /"cached_tokens"\s*:\s*(\d+)/.exec(text);
      if (m2) { const n = Number(m2[1]); if (Number.isFinite(n)) { out.cacheRead = n; seenCache = true; } }
    }
  }

  const tr = new Transform({
    transform(chunk, _enc, cb) {
      try {
        const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        scan(tail + s);
        tail = (tail + s).slice(-OVERLAP);
      } catch { /* 扫描失败绝不能影响流量 */ }
      cb(null, chunk);          // 字节原样透传
    },
    flush(cb) {
      try { if (tail) scan(tail); } catch { }
      cb();
    },
  });
  return tr;
}
