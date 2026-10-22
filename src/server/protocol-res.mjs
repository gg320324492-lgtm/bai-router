/**
 * protocol-res.mjs —— **协议回程**：把上游的应答转成客户端要的那个协议。
 *
 * ## 它解决的是哪一半
 *
 * 统一网关的**入向**好办：客户端说 Responses / Gemini → 统一 IR → Anthropic 形状
 * → 交给那家的中转（跟 Anthropic 那条路完全一样）。
 *
 * 难的是**回程**：客户端要的是它自己那个协议的应答，而中转交回来的是
 * **Anthropic 形状**（协议桥已经把上游的 chat 形状转过了；直连渠道本来就是
 * Anthropic）。所以这里要做的是：
 *
 *   上游的 Anthropic SSE ──► 目标协议的 SSE      （流式客户端）
 *   上游的 Anthropic JSON ─► IR 应答 ─► 目标协议的 JSON   （非流式客户端）
 *
 * ⚠ **只认 Anthropic 一种输入**：协议桥（wb/qd/or/zen）已经在中转里把上游的
 *   chat 形状转成 Anthropic 了，直连渠道（bai/sn）本来就是 Anthropic。
 *   所以这里不需要知道上游是哪一家 —— 那是中转的事。
 *
 * ## 为什么自己写一个 Writable，而不是复用 CaptureRes
 *
 * CaptureRes 的 `setHeader` 是**空实现**（它把头留给转发时的 writeHead）——
 * 套上去会把中转设的头悄悄吞掉。所以这里自己写一个，头是**真存真转**的。
 *
 * ## 三种模式
 *
 *   sse   —— 上游回的是 SSE（流式）：喂给协议解码器，吐目标协议的 SSE 出去。
 *   json  —— 上游回的是一整包 JSON（非流式）：缓冲到结束，转成 IR 应答，
 *            再渲染成目标协议的 JSON。
 *   error —— 上游回的是错误（≥400）：缓冲，把错误正文转成目标协议的错误形状。
 *
 * ⚠ 错误**不原样转发**：Responses 与 Gemini 的错误外壳不一样
 *   （Responses 是 `{"error":{message,type}}`，Gemini 是
 *   `{"error":{code,message,status}}`）。原样转发的话客户端解析不出来，
 *   只会说「收到一坨不认识的东西」。
 */
import { Writable } from "node:stream";
import { anthropicDecoder, collector, parseAnthropicResponse } from "./ir.mjs";

/**
 * 把一份 Anthropic **应答 JSON** 还原成 Anthropic 的 SSE 形状。
 *
 * 什么时候用：客户端要流式，但上游回的是一整包 JSON（上游无视了 stream:true）。
 *   把它还原成 SSE，协议解码器就能照常工作 —— 免得「客户端要流式却收到一包 JSON」。
 */
export function anthropicResponseToSse(json) {
  const j = json && typeof json === "object" ? json : {};
  const content = Array.isArray(j.content) ? j.content : [];
  const out = [];
  const ev = (type, data) => {
    out.push(`event: ${type}`);
    out.push(`data: ${JSON.stringify(data)}`);
    out.push("");
  };
  ev("message_start", {
    type: "message_start",
    message: { id: String(j.id || ""), model: String(j.model || ""), role: "assistant", content: [], usage: j.usage || {} },
  });
  let idx = 0;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") {
      ev("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: String(b.text || "") } });
      ev("content_block_stop", { type: "content_block_stop", index: idx });
    } else if (b.type === "tool_use") {
      ev("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: String(b.id || ""), name: String(b.name || ""), input: {} } });
      ev("content_block_delta", {
        type: "content_block_delta", index: idx,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input || {}) },
      });
      ev("content_block_stop", { type: "content_block_stop", index: idx });
    } else if (b.type === "thinking") {
      ev("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: String(b.thinking || "") } });
      ev("content_block_stop", { type: "content_block_stop", index: idx });
    } else continue;
    idx++;
  }
  ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: String(j.stop_reason || "end_turn") },
    usage: j.usage || {},
  });
  ev("message_stop", { type: "message_stop" });
  return out.join("\n");
}

/**
 * 协议回程包装。把它套在真实 res 外面，中转往里写 Anthropic 形状，
 * 客户端收到的是它自己那个协议的形状。
 *
 * @param {object} real 真实的 res
 * @param {object} opts
 * @param {object} opts.decoder 协议解码器：decode(上游SSE文本) → 目标协议的 SSE 文本
 * @param {Function} opts.buildJson (ir应答, opts) → 目标协议的 JSON 体
 * @param {Function} opts.errorBody (message, status) → 目标协议的错误体
 * @param {boolean} [opts.streaming] 客户端要的是流式吗
 * @param {string} [opts.model] 应答里报的模型名
 * @param {Function} [opts.now] 时刻（不取真实时钟）
 */
export class ProtocolRes extends Writable {
  constructor(real, opts = {}) {
    super();
    this.real = real;
    this.decoder = opts.decoder || null;
    this.buildJson = opts.buildJson || null;
    this.errorBody = opts.errorBody || null;
    this.streaming = opts.streaming === true;
    this.model = String(opts.model || "");
    this.now = typeof opts.now === "function" ? opts.now : () => 0;
    this.headers = {};
    this.status = 0;
    this.mode = null;          // "sse" | "json" | "error"
    this.buf = [];
    this.sent = false;
    this.dec = anthropicDecoder();
    this.col = collector();
  }

  get headersSent() { return this.sent; }
  get writableEnded() { return super.writableEnded; }

  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; }
  getHeader(k) { return this.headers[String(k).toLowerCase()]; }
  removeHeader(k) { delete this.headers[String(k).toLowerCase()]; }

  writeHead(status, headers) {
    this.status = Number(status) || 0;
    if (headers && typeof headers === "object") {
      for (const [k, v] of Object.entries(headers)) this.headers[String(k).toLowerCase()] = v;
    }
    const ct = String(this.headers["content-type"] || "");
    if (this.status >= 400) {
      /* 错误：缓冲到结束再转（错误正文也要换成目标协议的外壳）。 */
      this.mode = "error";
      this.buf = [];
      return this;
    }
    if (ct.includes("text/event-stream")) {
      this.mode = "sse";
      this.sent = true;
      try {
        this.real.writeHead(this.status, { ...this.headers, "content-type": "text/event-stream; charset=utf-8" });
      } catch { }
      return this;
    }
    /* 非流式：缓冲整包，最后一次性转。 */
    this.mode = "json";
    this.buf = [];
    return this;
  }

  _write(chunk, _enc, cb) {
    try {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk == null ? "" : chunk);
      if (this.mode === "sse") {
        const out = this.decoder ? this.decoder.decode(text) : "";
        if (out) this.real.write(out);
      } else {
        this.buf.push(text);
      }
    } catch { /* 转换坏了也不能把连接挂死 —— 下面的 _final 会收尾 */ }
    cb();
  }

  _final(cb) {
    try {
      if (this.mode === "sse") {
        const out = this.decoder ? this.decoder.flush() : "";
        if (out) this.real.write(out);
        this.real.end();
      } else if (this.mode === "json") {
        const raw = this.buf.join("");
        let j = null;
        try { j = JSON.parse(raw); } catch { j = null; }
        if (this.streaming) {
          /* 客户端要流式，上游却回了一整包 JSON → 还原成 SSE 再喂协议解码器。 */
          const sse = anthropicResponseToSse(j);
          const out = this.decoder ? this.decoder.decode(sse) : "";
          this.sent = true;
          this.real.writeHead(this.status || 200, { "content-type": "text/event-stream; charset=utf-8" });
          if (out) this.real.write(out);
          const tail = this.decoder ? this.decoder.flush() : "";
          if (tail) this.real.write(tail);
          this.real.end();
        } else {
          const ir = parseAnthropicResponse(j);
          const body = this.buildJson ? this.buildJson(ir, { model: this.model, now: this.now() }) : j;
          this.sent = true;
          this.real.writeHead(this.status || 200, { "content-type": "application/json; charset=utf-8" });
          this.real.end(JSON.stringify(body == null ? {} : body));
        }
      } else if (this.mode === "error") {
        const raw = this.buf.join("");
        let msg = raw.slice(0, 300);
        try {
          const j = JSON.parse(raw);
          msg = String((j && j.error && j.error.message) || (j && j.message) || msg);
        } catch { }
        const body = this.errorBody ? this.errorBody(msg, this.status) : { error: { message: msg } };
        this.sent = true;
        this.real.writeHead(this.status || 502, { "content-type": "application/json; charset=utf-8" });
        this.real.end(JSON.stringify(body));
      } else {
        /* 一次头都没写（上游直接挂了）→ 也要给客户端一个说得清的应答。 */
        const body = this.errorBody ? this.errorBody("上游没有应答", this.status || 502) : { error: { message: "上游没有应答" } };
        this.sent = true;
        this.real.writeHead(this.status || 502, { "content-type": "application/json; charset=utf-8" });
        this.real.end(JSON.stringify(body));
      }
    } catch { try { this.real.end(); } catch { } }
    cb();
  }
}
