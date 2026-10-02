import { Writable } from "node:stream";
// 自动故障转移（v1.0.43）
//
// 目标：Claude Code 只接一次线（指向当前提供方那个端口），之后由中转自己决定用谁。
// 用户不需要在额度用光、渠道挂掉时手动切。
//
// 为什么不改 openaiExchange / 原生通道：那里有 11 处错误出口（wbAnthroError、
// sendRateLimitError、sendUnexpectedUpstreamResponse…），都是已在生产跑的路径。
// 为了加"换个渠道重试"去改它们，风险远大于收益。改为在外面包一层**影子 res**：
// 每次尝试先写进内存缓冲，首个响应若是错误就整段丢弃、换下一家；若是 200 才一次性
// 落给客户端。现有代码一行不动，行为完全由捕获器决定。
//
// 不变式（重要）：故障转移只发生在**首个响应字节写给客户端之前**。一旦 SSE 的
// message_start 已经发出，就不能"收回"再换渠道——那是把半截内容拼上另一家的开头。
// 所以捕获器把 writeHead(200) 视为成功并立即固化，200 之后不再转移。

// 连续失败后跳过该渠道一段时间：否则每条请求都要先等一遍死渠道的超时，
// 转移就变成了"更慢的失败"。冷却期让一次故障只付一次超时代价。
export const FAILOVER_COOLDOWN_MS = 90 * 1000;

const failoverState = new Map(); // provider -> { until, lastErr }

// 注意：本模块不引用 server.mjs 的 noteRelayError——那是另一个模块的函数，
// 跨模块直接调用会 ReferenceError（v1.0.43 初版踩过）。日志由调用方记。
export function failoverCooldown(p, err) {
  failoverState.set(p, { until: Date.now() + FAILOVER_COOLDOWN_MS, lastErr: String(err || "").slice(0, 160) });
}

export function failoverAvailable(p) {
  const s = failoverState.get(p);
  if (!s || !s.until) return true;
  if (Date.now() >= s.until) { failoverState.delete(p); return true; }
  return false;
}

export function failoverClear(p) {
  failoverState.delete(p);
}

export function failoverSnapshot() {
  const out = {};
  for (const [p, s] of failoverState) {
    if (s.until > Date.now()) out[p] = { cooldownLeftSec: Math.ceil((s.until - Date.now()) / 1000), lastErr: s.lastErr };
  }
  return out;
}

// 影子 res：一次尝试先把响应收在内存里，由调用方决定丢弃还是落盘。
//
// 两种模式：
//   · writeHead(>=400) —— 缓冲模式。这次尝试算失败，缓冲整段后丢弃，换下一家。
//   · writeHead(<400) —— **立刻**把响应头发给真实客户端，转为直通模式，后续 chunk
//     直接透传、end 直接收尾。
// 之所以在 200 的瞬间就固化：Claude Code 是流式的，若等整条流结束再决定去留，
// 上游的 SSE 会全部堆在内存里，而且"已经决定换渠道却先把首字节发给客户端"是做不到的。
// 换句话说：故障转移只发生在**首个响应头写出之前**，这与 relay 层 30s 响应头超时的
// 既有语义天然对齐——真超时/连不上时，一个字节都还没发出去。
//
// 必须继承 stream.Writable：原生 Anthropic 通道（bai/sn）是
// `Readable.fromWeb(r.body).pipe(res)` 把上游流直接灌进 res 的，普通对象没有
// on/emit/once，pipe 会抛 "dest.on is not a function"（v1.0.43 初版踩过）。
export class CaptureRes extends Writable {
  constructor(real) {
    super();
    this.real = real;
    this.buf = [];            // 仅缓冲模式用
    this.streaming = false;   // 已把头发给真实客户端
    this.status = 0;
    this.headers = null;
  }
  get headersSent() { return this.streaming; }
  // writableEnded 必须反映"真的 end() 过了没有"。曾经写成 `!this.streaming`，
  // 结果缓冲模式下恒为 true —— wbAnthroError 看到它以为响应已结束，直接 end()
  // 却不写状态码，cap.status 停在 0，被误判成"网络错误"而触发本不该发生的转移。
  // 交给 Writable 自己的实现即可（end() 前它就是 false）。
  get writableEnded() { return super.writableEnded; }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers || {};
    if (status >= 400) return this;          // 缓冲，等调用方裁决
    this.streaming = true;                    // 200：立刻固化，后续直通
    try { this.real.writeHead(status, this.headers); } catch { }
    return this;
  }
  _write(chunk, _enc, cb) {
    if (this.streaming) {
      try { this.real.write(chunk); } catch { }
    } else {
      this.buf.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    cb();
  }
  _final(cb) {
    if (this.streaming) { try { this.real.end(); } catch { } }
    cb();
  }
  // 覆写头操作：真实响应头由 writeHead 转发，Writable 自己那份没人读。
  setHeader() { return this; }
  getHeader() { return undefined; }
  removeHeader() { }

  // 这次尝试是否可用。直通模式（已发 200）恒为真；缓冲模式看有没有收到成功头。
  ok() { return this.streaming || this.status > 0 && this.status < 400; }

  // 把缓冲的错误响应落盘（调用方判定"不该转移"时用）。
  flushBuffered() {
    if (this.streaming) return false;
    if (!this.headers) return false;
    try { this.real.writeHead(this.status, this.headers); } catch { }
    for (const b of this.buf) this.real.write(b);
    this.real.end();
    this.buf = [];
    return true;
  }
  discard() { this.buf = []; this.status = 0; this.headers = null; }
}

// 判定某次失败是否值得换一个渠道重试。
// 400 不转移：那是请求本身有问题（参数错、上下文超长），换几家都一样失败，
// 反而把真实报错埋掉。429/5xx/超时/网络错才转移。
export function shouldFailover(status) {
  if (status >= 400 && status < 500 && status !== 429 && status !== 401 && status !== 403) return false;
  if (status === 0) return true;                        // 网络错 / 超时（尚未拿到状态码）
  return status === 429 || status === 401 || status === 403 || status >= 500;
}