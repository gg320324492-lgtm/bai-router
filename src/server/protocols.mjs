/**
 * protocols.mjs —— **入向协议适配**：Responses / Gemini → 统一 IR → Anthropic 形状。
 *
 * ## 为什么要有这一层
 *
 * 统一网关原本只认 Anthropic 规范（Claude Code / Claude 桌面版都这么说）。
 * 但用 OpenAI **Responses API**（Codex）或 **Gemini** 规范（Gemini CLI）的客户端
 * 连不上 —— 它们说的话网关听不懂。
 *
 * 这一层做的事就一件：**把客户端的话翻成 Anthropic 形状**，交给那家的中转
 * （跟 Anthropic 那条路**完全一样**的中转、一样的模型解析、一样的故障转移）。
 * 回程由 protocol-res.mjs 负责（把上游的应答翻回客户端的协议）。
 *
 * ## 模型 id 的约定：**与 Anthropic 那条路一模一样**
 *
 * 模型 id 必须是 `provider/档位`（如 `sn/claude-opus-5`）：
 *   · `provider` 前缀决定**走哪一家**（网关靠它分流）；
 *   · `档位` 决定**用哪一档**（各家的映射表把档位翻成它自己的模型名）。
 *
 * ⚠ Gemini 的模型名在**路径**里（`/v1beta/models/{model}:generateContent`），
 *   所以那一段要是 `sn/claude-opus-5`，URL 编码后是 `sn%2Fclaude-opus-5`。
 *   Responses 的模型名在**请求体**的 `model` 字段里，写起来自然些。
 *
 * ## 不许猜
 *
 * 协议解析失败 → **如实报错**（400），把「哪一处不对」说出来。
 * 静默丢掉一个字段 = 模型看不到上一轮，还答得像模像样 —— 那比报错更坏。
 */
import { parseResponses, buildResponses, responsesDecoder } from "./responses.mjs";
import { parseGemini, buildGemini, geminiDecoder } from "./gemini.mjs";
import { chatProtocol } from "./chat-protocol.mjs";
import { buildAnthropic } from "./ir.mjs";

/** Responses：模型名在请求体的 `model` 字段里。 */
export const responsesProtocol = {
  id: "responses",
  label: "OpenAI Responses",
  match: (path, method) => method === "POST" && path === "/v1/responses",
  modelIdOf: (path, body) => (body && typeof body.model === "string" ? body.model : ""),
  parse: (body) => parseResponses(body),
  toAnthropic: (ir) => buildAnthropic(ir),
  streamingOf: (ir) => !!(ir && ir.stream),
  /* ⚠ **必须显式说 source="anthropic"**：Responses 的解码器**不自动认**上游规范
   *   （不传就默认 "chat"），而 Gemini 的解码器会自动认 —— 两个模块的口径不一致。
   *   这里为什么能写死：到达网关回程的**一律是 Anthropic 形状**（协议桥已经把
   *   上游的 chat 形状转过；直连渠道本来就是 Anthropic），所以上游说什么，
   *   到这一层都是 Anthropic。
   *   ⚠ 写死比自动认更稳：自动认认错了就会「静默丢正文」（chat 解码器读不懂
   *   Anthropic 的 content_block_delta → 正文一片空白，而应答看起来是成功的）。 */
  decoder: (opts) => responsesDecoder({ ...(opts || {}), source: "anthropic" }),
  buildJson: (ir, opts) => buildResponses(ir, opts || {}),
  errorBody: (message, status) => ({
    error: { message: String(message || ""), type: "upstream_error", code: Number(status) || 502 },
  }),
};

/** Gemini：模型名在**路径**里，且路径尾部是 `:generateContent` 或 `:streamGenerateContent`。 */
export const geminiProtocol = {
  id: "gemini",
  label: "Gemini generateContent",
  /* ⚠ 模型段用 `(.*)`（贪婪）而不是 `([^:]+)`：模型 id 里本身带一个斜杠
   *   （`sn/claude-opus-5`），贪婪才能一路吃到最后一个冒号。 */
  match: (path, method) => method === "POST" && /^\/v1beta\/models\/.+:(streamGenerateContent|generateContent)$/.test(path),
  modelIdOf: (path) => {
    const m = /^\/v1beta\/models\/(.+):(streamGenerateContent|generateContent)$/.exec(path);
    if (!m) return "";
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  },
  parse: (body) => parseGemini(body),
  toAnthropic: (ir) => buildAnthropic(ir),
  /* 流不流是**路径**说了算（`:streamGenerateContent`），不是请求体里的字段。 */
  streamingOf: (ir, path) => /:streamGenerateContent$/.test(String(path || "")),
  /* 同样写死 source="anthropic"（理由见 responses 那条）：
   * Gemini 的解码器虽然会自动认，但**自动认认错了会静默丢正文**，
   * 而到达这一层的上游应答一律是 Anthropic 形状 —— 写死最稳。 */
  decoder: (opts) => geminiDecoder({ ...(opts || {}), source: "anthropic" }),
  buildJson: (ir, opts) => buildGemini(ir, opts || {}),
  errorBody: (message, status) => ({
    error: { code: Number(status) || 502, message: String(message || ""), status: "ERROR" },
  }),
};

/** 全部支持的入向协议（顺序 = 匹配顺序；路径互不重叠，顺序其实无所谓）。
 *
 *  ④ chat —— OpenAI Chat Completions。这一族客户端最广（magpie 的 66 个 agent
 *     里 40 多个说这种话：Qoder、ZCode、Kimi Code、Qwen Code、MiniMax Code、
 *     CodeBuddy、WorkBuddy、Droid、Cline、jcode、Goose、Crush、Pi、omp、
 *     OpenCode、Cursor CLI、Grok、AtomCode…）。它排在最后：**路径互不重叠**，
 *     谁先谁后无所谓；放最后是为了读起来「按字母/常见度」时它是新增的那条。
 */
export const PROTOCOLS = [responsesProtocol, geminiProtocol, chatProtocol];

/** 按路径与方法挑一个协议；不认得就 null（**不猜**）。 */
export function pickProtocol(path, method) {
  for (const p of PROTOCOLS) {
    try { if (p.match(path, method)) return p; } catch { /* 挑不动就当不认得 */ }
  }
  return null;
}
