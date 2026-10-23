// src/server/clients/muse-models.mjs —— Muse Code 的模型清单
//
// ## 补的是哪个洞
//
// Muse Code（Meta 的 muse CLI）**不从 `/v1/models` 拉清单** —— 它在每次会话开始前
// 去问 **`<base_url 的主机>/muse-code/models`**。magpie 在网关根上挂了这个路径
// （internal/gateway/gateway.go:665：`mux.HandleFunc("GET /muse-code/models", s.museModels)`）。
//
// 我们没有这个路径 ⇒ Muse 自己的清单里**没有**我们的模型 ⇒ 用户在 Muse 里选不到
// 任何档位（哪怕接线把 endpoint_transport 与 model 都写好了）。
// 这是「接上了但没真打通」里的第三个。
//
// ## magpie 的对应
//
//   · internal/gateway/muse.go      —— `museModels`：清单长什么样（**逐字照它**）
//   · internal/gateway/muse.go:12-15 —— `museContext` / `museOutput`：不知道窗口时的兜底值
//   · internal/agent/muse.go        —— 客户端那侧：它去哪个地址拉、清单里的 id 怎么用
//
// ## 形状（逐字照 magpie 的 museModels）
//
//   {"object":"list","data":[{
//     "id":"sn/claude-opus-5","object":"model","created":0,"owned_by":"sn",
//     "metadata":{"muse-code":{
//       "name":"Claude Opus 5","family":"sn","is_hidden":false,
//       "attachment":false,"reasoning":false,"temperature":false,"tool_call":true,
//       "modalities":{"input":["text"],"output":["text"]},
//       "options":{"include":[]},"variants":{},
//       "description":"Claude Opus 5 via B.AI",
//       "limit":{"context":128000,"output":32000}}}}]}
//
// ⚠ **id 必须逐字原样**（`provider/档位`）：Muse 会把它原样送回
//   `/v1/responses` 当 model —— 改了它，Muse 就会问一个网关不认识的模型。
//
// ## 与 magpie **有意不同**的三处
//
//   ① **limit 是兜底值，不是真实上限。**
//      我们不知道每个模型的上下文窗口与输出上限 —— magpie 知道（`e.Context` /
//      `e.PublishedOutput()`），所以它给真值；它不知道时才用兜底（128000 / 32000）。
//      我们**一律用兜底**。⚠ 用户看到 128K 会以为「这模型只能吃 128K、
//      最多输出 32K」—— 那是假的。真实上限一旦有来源（渠道目录里的
//      max_input_tokens 之类），用 `opts.limits` 传进来顶掉兜底。
//      ⚠ **limit 不能没有**：Muse 会**隐藏**没有 limit（或 limit 缺一半）的模型 ——
//        隐藏了用户就选不到它，这一整层就白做了。这是本模块存在的理由。
//   ② **attachment / reasoning 恒为 false。**
//      magpie 从目录里读「这个模型收不收图 / 有没有思考档」，我们没有这份信息。
//      宁可说没有（Muse 于是不给这两项开关），也不要说有 —— 说有会让 Muse
//      往一个不认的参数上撞。
//   ③ **description 署我们的名**（"via B.AI"；magpie 写 "via magpie"）。
//
// ## 纪律
//
//   · 纯 ESM、零依赖、零 IO、零时钟（不 import 本仓任何别的模块）。
//   · 不改调用方给进来的 entries（纯读）。

/**
 * 不知道窗口时告诉 Muse 的兜底值。
 *
 * ⚠ **兜底，不是真实上限**（见文件头 ①）。出处：magpie internal/gateway/muse.go:12-15。
 */
export const MUSE_CONTEXT_FALLBACK = 128000;
export const MUSE_OUTPUT_FALLBACK = 32000;

/** description 里署的名（magpie 写的是 "via magpie"）。 */
const DEFAULT_VIA = "B.AI";

/**
 * 一个模型的窗口与输出上限。
 *
 * @param {string} id 模型 id（`provider/档位`）
 * @param {object} limits 已知的真实上限：{ [id]: { context, output } }
 * @returns {{context:number, output:number}}
 */
function limitFor(id, limits) {
  const known = limits && typeof limits[id] === "object" && limits[id] !== null ? limits[id] : null;
  const ctx = known && Number.isFinite(known.context) && known.context > 0
    ? Math.round(known.context)
    : MUSE_CONTEXT_FALLBACK;
  /* 不知道输出上限时：不超过窗口本身（magpie 同样 min(museOutput, ctx)）——
   * 输出上限比窗口还大，那这个数就是假的。 */
  const out = known && Number.isFinite(known.output) && known.output > 0
    ? Math.round(known.output)
    : Math.min(MUSE_OUTPUT_FALLBACK, ctx);
  return { context: ctx, output: out };
}

/**
 * 造 Muse Code 要的模型清单。
 *
 * @param {Array<{id:string, ownedBy?:string, displayName?:string}>} entries
 *   模型清单条目。`id` 已是 `provider/档位`（网关的模型 id 约定），
 *   原样送出 —— Muse 会把它原样送回 `/v1/responses`。
 * @param {object} [opts]
 *   · via    —— description 里的署名（默认 "B.AI"）
 *   · limits —— 已知的真实上限：{ [id]: { context, output } }；
 *               没有的模型用兜底值（见文件头 ①）
 * @returns {{object:"list", data:object[]}} Muse 要的 JSON
 */
export function buildMuseModels(entries, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const via = typeof o.via === "string" && o.via.trim() ? o.via.trim() : DEFAULT_VIA;
  const limits = o.limits && typeof o.limits === "object" ? o.limits : {};
  const list = Array.isArray(entries) ? entries : [];
  const data = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const id = String(e.id == null ? "" : e.id).trim();
    /* 没 id 的行 Muse 用不了（它按 id 选模型），丢掉比留着强。 */
    if (!id) continue;
    /* ownedBy / displayName 缺了就从 id 里推 —— id 的形状是 provider/档位。 */
    const provider = String(e.ownedBy == null || String(e.ownedBy).trim() === "" ? id.split("/")[0] : e.ownedBy).trim();
    const name = String(e.displayName == null || String(e.displayName).trim() === "" ? id.split("/").pop() : e.displayName).trim() || id;
    data.push({
      id,
      object: "model",
      created: 0,
      owned_by: provider,
      metadata: {
        "muse-code": {
          name,
          family: provider,
          is_hidden: false,
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          modalities: { input: ["text"], output: ["text"] },
          options: { include: [] },
          variants: {},
          description: `${name} via ${via}`,
          limit: limitFor(id, limits),
        },
      },
    });
  }
  return { object: "list", data };
}
