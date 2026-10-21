/* ---------- 统一网关入口（magpie 形态：一个端口，按模型 id 的 provider 前缀分流） ----------
 *
 * ## 它是什么
 *
 * bai-router 一直是「**一个提供方一个中转端口**」：bai 15722 / sn 15732 / wb 15742 /
 * zen 15752 / qd 15762 / or 15772 / wbai 15782 / mm 15792。Claude Code 连的是某一家，
 * 换一家就要改接线。
 *
 * magpie 是「**一个端口**」：模型 id 写成 `provider/模型`（如 `sn/glm-5.2`），
 * 网关自己拆前缀决定走哪一家。本模块就是那个网关的**入口层**：
 * 拆前缀 → 挑提供方 → 把请求交给那家的中转 handler。
 *
 * ## 本步的边界（**只做加法，不做替换**）
 *
 *   · 8 个旧端口与它们的行为**一字不变**；网关是**新增**的第 9 个端口。
 *   · 切默认、拆旧端口是后面的步骤，本步一概不做。
 *
 * ## 为什么要「模型已定稿」这个标记
 *
 * 中转里的 `resolveModel(档位名)` 做的是「档位名（claude-opus-5）→ 该提供方自己的
 * 真实模型名」。网关收到的模型 id **已经是最终模型名**了（`provider/模型` 里的
 * 模型段），再解析一遍就是拿模型名去查档位表 —— 查不到就**静默回落到默认模型**，
 * 用户点了 A 却跑了 B。所以网关必须能告诉中转「**这个模型不要再解析了**」：
 * 就是 `req[GATEWAY_MODEL]` 这个标记。
 *
 * ## body 的接力（本文件最容易出错的地方）
 *
 * 网关要读请求体才能拿到 model 字段；而中转 handler 自己也会读 `req` 的流。
 * Node 的请求流**只能被读一遍**：网关读完就 end 了，中转再挂 'data'/'end'
 * 监听器只会永远等不到 'end'（请求挂死，客户端干等超时）。
 *
 * 办法：网关把读完并改写过的 body **挂在 `req[GATEWAY_BODY]` 上**，
 * 中转 handler 优先用它（server.mjs 的 makeRelayHandler 里那三行），
 * 不再等流。请求流本身仍由网关读完 —— 不挂监听器不等于不读，
 * socket 不会挂起。没有这个标记的请求（现有 8 个端口）走的还是原来那条路，一字未变。
 */

/** 已知渠道键。**唯一的渠道集合来源**（与 server.mjs 的 CHANNELS 一致）。
 *  provider 前缀不在这里 → 解析失败 → 网关如实说「不认识这家」，不猜。 */
export const KNOWN_PROVIDERS = Object.freeze(["bai", "sn", "wb", "wbai", "zen", "qd", "mm", "or"]);

/** req[GATEWAY_MODEL]：这个请求的模型名**已经定稿**，中转**不许再解析**。
 *  用 Symbol 而不是普通字符串键：不会与客户端可能带来的任何 header/字段撞名。 */
export const GATEWAY_MODEL = Symbol("bai.gateway.model");

/** req[GATEWAY_BODY]：网关读完并改写过的请求体（模型段已从 `provider/模型` 里剥出来）。
 *  中转 handler 优先用它，别再等流 —— 原因见本文件顶部「body 的接力」。 */
export const GATEWAY_BODY = Symbol("bai.gateway.body");

const defaultIsProvider = (key) => KNOWN_PROVIDERS.includes(key);

/**
 * 拆 `provider/模型`。
 *
 * 规则：
 *   · 按**第一个** "/" 拆 —— 模型段里可以再带斜杠（OpenRouter 的 `openai/gpt-4o`
 *     这类 id 就是），那是模型名的一部分，不是第二个前缀。
 *   · provider 必须在已知渠道键集合里，否则返回 null（**不猜**：猜错就是
 *     把请求发给一家根本没点的公司）。
 *   · 没有 "/"、前缀为空、模型段为空 → null。
 *
 * @param {string} model 客户端送来的模型 id
 * @param {(key:string)=>boolean} [isProvider] 「这个 provider 键认识吗」的判据
 * @returns {{provider:string, model:string}|null}
 */
export function parseGatewayModel(model, isProvider = defaultIsProvider) {
  if (typeof model !== "string") return null;
  const raw = model.trim();
  const at = raw.indexOf("/");
  if (at <= 0) return null;                       // 没有前缀（或前缀为空）
  const provider = raw.slice(0, at).trim().toLowerCase();
  const rest = raw.slice(at + 1).trim();
  if (!provider || !rest) return null;            // "sn/" 后面没有模型名
  if (typeof isProvider === "function" && !isProvider(provider)) return null;
  return { provider, model: rest };
}

/**
 * 造一个统一网关的请求处理器。
 *
 * 行为：
 *   1. 读完请求体 → 解析 JSON → 取 model 字段
 *   2. 解析不出合法的 `provider/模型` → **如实报错**（400 / 404），
 *      **绝不静默走老路** —— 静默走老路会让人以为「网关生效了」，
 *      实际请求根本没经过前缀分流，那比直接报错更坏。
 *   3. 命中 → 把模型段写回请求体、挂上 GATEWAY_MODEL / GATEWAY_BODY，
 *      交给那家的中转 handler 处理（同一个 req、同一个 res）。
 *
 * @param {object} o
 * @param {Record<string, (req:any,res:any)=>void>} o.handlers provider 键 → 中转 handler
 * @param {(key:string)=>boolean} [o.isProvider] 「这个 provider 键认识吗」的判据
 * @returns {(req:any,res:any)=>void}
 */
export function makeGatewayHandler({ handlers, isProvider = defaultIsProvider } = {}) {
  const map = handlers && typeof handlers === "object" ? handlers : {};
  return (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      /* 非 POST 的探测请求（GET /v1/models 之类）**如实说清**网关承接什么，
       * 而不是回一句「请求体为空」让人以为是客户端发坏了包。
       * ⚠ 网关**不**代理模型清单：清单是「某一家有哪些模型」，与「走哪一家」有关，
       *   得等 provider 前缀定下来才知道 —— 那属于下一步的事。 */
      if (req.method && req.method !== "POST") {
        return gatewayError(res, 405,
          `统一网关只承接 POST 模型调用（${req.method} ${String(req.url || "")} 没有请求体可用）——模型清单请直连对应提供方的中转端口`);
      }
      let raw = Buffer.concat(chunks);
      let j = null;
      let parsedJson = false;
      try { j = JSON.parse(raw.toString("utf8")); parsedJson = true; } catch { j = null; }
      if (!parsedJson) {
        return gatewayError(res, 400,
          `统一网关的请求体必须是带 model 字段的 Anthropic messages JSON（${describeBody(raw)}）`);
      }
      if (!j || typeof j !== "object" || Array.isArray(j)) {
        return gatewayError(res, 400,
          `统一网关的请求体必须是一个 JSON 对象（收到的是 ${Array.isArray(j) ? "数组" : typeof j}）——它得带 model 字段（${describeBody(raw)}）`);
      }
      const modelName = typeof j.model === "string" ? j.model : "";
      if (!modelName.trim()) {
        return gatewayError(res, 400,
          "统一网关的请求体里没有可用的 model 字段——模型名必须写成 provider/模型 的形式（例如 sn/glm-5.2）");
      }
      const parsed = parseGatewayModel(modelName, isProvider);
      if (!parsed) {
        /* 两种失败要分开说清楚：**没带前缀**是请求方写错了（400），
         * **带前缀但这家不认识**是地址不存在（404）。混成一句 400 会让人
         * 以为是自己模型名拼错，而实际上是渠道名拼错。 */
        const at = modelName.indexOf("/");
        if (at < 0) {
          return gatewayError(res, 400,
            `模型名「${modelName}」没有 provider 前缀——统一网关要求写成 provider/模型（例如 sn/glm-5.2）`);
        }
        return gatewayError(res, 404,
          `统一网关不认识 provider「${modelName.slice(0, at).trim()}」（已知渠道：${KNOWN_PROVIDERS.join("、")}）`);
      }
      const handler = Object.prototype.hasOwnProperty.call(map, parsed.provider)
        ? map[parsed.provider]
        : null;
      if (typeof handler !== "function") {
        return gatewayError(res, 404,
          `provider「${parsed.provider}」在本实例没有中转处理器（已知渠道：${KNOWN_PROVIDERS.join("、")}）`);
      }
      /* 把模型段写回请求体：上游要看到的是**最终模型名**，不是 provider/模型。
       * 键序不变（JSON.parse 保序），所以写回后的字节与中转自己解析再拼出来的完全一致。 */
      j.model = parsed.model;
      raw = Buffer.from(JSON.stringify(j));
      /* 交棒：模型名标成「已定稿」，body 交出去（provider 的 handler 直接用它，
       * 不用再等已经 end 掉的流）。 */
      req[GATEWAY_MODEL] = parsed.model;
      req[GATEWAY_BODY] = raw;
      try {
        handler(req, res);
      } catch (e) {
        gatewayError(res, 502, `provider「${parsed.provider}」的中转处理抛异常：${String((e && e.message) || e)}`);
      }
    });
  };
}

/** 网关自己的错误应答：Anthropic 规范形状（客户端按这个解析错误，
 *  与中转里的 wbAnthroError 同一形状，只是没有渠道前缀——此时还不知道是哪一家）。 */
function gatewayError(res, status, msg) {
  if (res.headersSent || res.writableEnded) { try { res.end(); } catch { } return; }
  const s = Number(status) >= 400 && Number(status) < 600 ? Number(status) : 400;
  const type = s === 404 ? "not_found_error" : s >= 500 ? "api_error" : "invalid_request_error";
  res.writeHead(s, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ type: "error", error: { type, message: String(msg) } }));
}

/** 说清「实际收到了什么」——与中转里那句 400 同一口径：
 *  「请求体为空」「不是 JSON」「JSON 解析失败」三件事以前共用一句话，排查时等于没说话。 */
function describeBody(raw) {
  const len = raw && raw.length ? raw.length : 0;
  if (!len) return "请求体为空";
  const head = raw.toString("utf8").replace(/\s+/g, " ").slice(0, 80);
  return `body 不是合法 JSON｜长度=${len} 字节｜前 80 字节=${head}`;
}
