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
//       "tool_call":true,
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
//   ① **limit 的来源**（2026-10-23 起不再是「一律兜底」）。
//      magpie 知道每个模型的上下文窗口与输出上限（`e.Context` /
//      `e.PublishedOutput()`），所以它给真值；它不知道时才用兜底（128000 / 32000）。
//      我们现在也有真值了 —— `model-facts.mjs` 的**真值表**（按最终模型名归一，
//      每条带来源与日期）。⚠ 本模块**零 import**（见纪律段）⇒ 真值由**调用方**
//      经 `opts` 递进来。优先级：
//
//        ① `opts.limits` —— 调用方**显式**给的（最权威；按当前 cfg 解析出的值）
//        ② `opts.facts`  —— 调用方给的事实表（形状同上，多带来源与日期）
//        ③ **兜底值** 128000 / 32000（什么都不知道时）
//
//      ⚠ **兜底值必须标明是约定不是实测值**：真值表里每条都带 `kind`
//        （measured / measured-elsewhere / shared / convention）与 `source` + 日期戳；用
//        `describeMuseLimits()` 取那行说明 —— ⚠ **不塞进 Muse 的 JSON**
//        （那个形状逐字照 magpie，多一个字段就是不合形状）。
//      ⚠ 用户看到 128K 会以为「这模型只能吃 128K、最多输出 32K」—— 那是假的。
//      ⚠ **limit 不能没有**：Muse 会**隐藏**没有 limit（或 limit 缺一半）的模型 ——
//        隐藏了用户就选不到它，这一整层就白做了。这是本模块存在的理由。
//   ② **attachment / reasoning / temperature 这三个键我们**不写**。**
//      magpie 从目录里读「这个模型收不收图 / 有没有思考档」（`e.Images`、
//      `len(e.Efforts) > 0`），我们没有这份信息 —— 我们的模型 id 是**档位**
//      （provider 无关），而能力由**映射到哪家上游**决定（`claude-opus-5` 在 sn
//      映射到 glm-5.2、在 wb 映射到 hy3，逐家不同）⇒ 写有是撒谎，写没有
//      是在**断言**「不支持」—— 而我们只是**不知道**。
//      ⇒ 不写这个键：Muse 读不到就是零值 false（效果与写 false 一样），
//        但那个**位置空着** —— 将来有了真值是「加一个键」，而不是把假值改成真值。
//      ⚠ 更不能写有：那会让 Muse 往一个不认的参数上撞，当场报错。
//   ③ **description 署我们的名**（"via B.AI"；magpie 写 "via magpie"）。
//
// ## 纪律
//
//   · 纯 ESM、零依赖、零 IO、零时钟、**零 import**（不许 import 本仓任何别的模块）。
//     ⚠ 「零 import」不是洁癖：`scripts/muse-models-test.mjs` 的 ④a 断言了它，
//       ⑤ 段的反向对照还要**把本文件单独复制到临时目录再 import** —— 一旦
//       import 别的模块，副本里就找不到那个模块，反向对照会假红。
//       ⇒ 真值表住在 `model-facts.mjs`，**由调用方通过 `opts` 递进来**。
//   · 不改调用方给进来的 entries（纯读）。

/**
 * 不知道窗口时告诉 Muse 的兜底值。
 *
 * ⚠ **兜底，不是真实上限**（见文件头 ①）。出处：magpie internal/gateway/muse.go:12-15。
 *
 * ⚠ 与 `model-facts.mjs` 的 `CONVENTION_CONTEXT` / `CONVENTION_OUTPUT`
 *   **必须是同一对数** —— 不一致的话，「表里没有这一条」与「表里说这一条
 *   是约定值」会给出不同的数字，用户会看到同一个模型前后不一样。
 *   （`scripts/model-facts-test.mjs` 有一条断言钉住这两个常量相等。）
 */
export const MUSE_CONTEXT_FALLBACK = 128000;
export const MUSE_OUTPUT_FALLBACK = 32000;

/** description 里署的名（magpie 写的是 "via magpie"）。 */
const DEFAULT_VIA = "B.AI";

/**
 * 把一条「已知上限」规整成 `{ context, output }`（任一半可以是 0 = 不知道）。
 *
 * @param {unknown} v
 * @returns {{context:number, output:number, kind:string, source:string, at:string}|null}
 */
function factEntry(v) {
  if (!v || typeof v !== "object") return null;
  const c = Number(v.context);
  const o = Number(v.output);
  return {
    context: Number.isFinite(c) && c > 0 ? Math.round(c) : 0,
    output: Number.isFinite(o) && o > 0 ? Math.round(o) : 0,
    kind: String(v.kind || ""),
    source: String(v.source || ""),
    at: String(v.at || ""),
  };
}

/**
 * resolveKnown —— 这个 id 的上限**最终**是哪一级给的。
 *
 * 优先级（见文件头 ①）：
 *   ① `opts.limits`（调用方显式给的，最权威）
 *   ② `opts.facts`（调用方给的事实表）
 *   ③ 什么都不知道 ⇒ 兜底
 *
 * @param {string} id 模型 id（`provider/档位`）
 * @param {object} o 选项
 * @returns {{context:number, output:number, kind:string, source:string, at:string, level:string}}
 */
function resolveKnown(id, o) {
  const explicit = factEntry(o.limits && o.limits[id]);
  if (explicit) return { ...explicit, level: "explicit" };

  const given = factEntry(o.facts && o.facts[id]);
  if (given) {
    /* ⚠ `shared`（**只有一家**别家渠道测过的，单点证据）**不下发**。
     *   ⚠ 依据是「宁可报大也不能报小」：报大 ⇒ 上游诚实报错（看得见）；
     *     报小 ⇒ 客户端自动压缩上下文，用户无谓丢历史且**毫无报错**。
     *     `measured-elsewhere`（两家实测一致）**照发** —— 它的 `source`
     *     会写明「非本家目录」。
     *   调用方（`model-facts.mjs`）本来就只递「可发」的条目 —— 这里是防呆。 */
    if (given.kind === "shared") {
      return {
        context: 0, output: 0, kind: given.kind, source: given.source, at: given.at,
        level: "shared",
        /* 参考值留着**给人看**（describeMuseLimits 会写出来），不进 limit。 */
        ref: { context: given.context, output: given.output },
      };
    }
    return { ...given, level: "facts" };
  }

  return { context: 0, output: 0, kind: "", source: "", at: "", level: "fallback" };
}

/**
 * 一个模型的窗口与输出上限。
 *
 * ⚠ **limit 永远有两个数** —— Muse 会**隐藏** limit 缺一半的模型（见文件头 ①）。
 *   不知道的那一半用兜底值补上（magpie 同样 min(museOutput, ctx)：
 *   输出上限比窗口还大，那个数就是假的）。
 *
 * @param {string} id 模型 id（`provider/档位`）
 * @param {object} known 已知上限 `{ context, output }`（0 = 不知道）
 * @returns {{context:number, output:number}}
 */
function limitFor(id, known) {
  const k = known && typeof known === "object" ? known : null;
  const ctx = k && Number.isFinite(k.context) && k.context > 0
    ? Math.round(k.context)
    : MUSE_CONTEXT_FALLBACK;
  const out = k && Number.isFinite(k.output) && k.output > 0
    ? Math.round(k.output)
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
 *               **最高优先级**（调用方按当前 cfg 解析出来的值）。
 *   · facts  —— 事实表：{ [id]: { context, output, kind, source, at } }；
 *               形状与 limits 相同，但带来源与日期（面板上要显示就用它）。
 *   · 两者都没有 ⇒ **兜底值**（128000 / 32000）。
 *     ⚠ 真值表在 `model-facts.mjs` —— 本模块**零 import**（见纪律段）⇒
 *       由调用方用 `limitsFor(cfg, ids)` / `factsFor(cfg, ids)` 递进来。
 * @returns {{object:"list", data:object[]}} Muse 要的 JSON
 */
export function buildMuseModels(entries, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const via = typeof o.via === "string" && o.via.trim() ? o.via.trim() : DEFAULT_VIA;
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
    /* 这一行的已知上限（值来自哪一级 ⇒ 见 resolveKnown）。
     * ⚠ 变量名 `limits` 是沿用旧版的 —— 旧版它是一张「所有 id 的映射」，
     *   现在是「这一行的那一条」。名字留着是为了 `scripts/muse-models-test.mjs`
     *   的反向对照（⑤a）把这一行改坏时，锚点仍然唯一 —— 所以**注释里不许
     *   再写一遍那行代码的字面**（`replace` 只会改到第一处，改到注释就白改）。 */
    const limits = resolveKnown(id, o);
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
          /* ⚠⚠ **attachment / reasoning / temperature 这三个键我们**不写** ——
           *   我们的模型 id 是**档位**（provider 无关），而**能力由映射到哪家上游
           *   决定**：`claude-opus-5` 在 sn 映射到 glm-5.2、在 wb 映射到 hy3，
           *   图片与思考的支持**逐家不同** ⇒ 写 true 是撒谎，写 false 是在**断言**
           *   「不支持」—— 而我们只是**不知道**。
           *   magpie 能写真值是因为它有一份 catalog（`e.Images`、`len(e.Efforts)>0`）；
           *   我们没有 ⇒ **不写这个键**，让 Muse 按自己的默认走
           *   （Go 客户端读不到就是零值 false，所以效果与写 false 一样，
           *     但那个位置**空着** —— 将来有了真值是「加一个键」，
           *     而不是每个客户端逐个把假值改成真值）。
           *   ⚠ **窗口与输出上限的真值已经到位**（T15-c 阶段 1：`model-facts.mjs`
           *     的真值表，2026-10-23）—— 但那是**另一类**东西：窗口是模型自身的
           *     属性，而「收不收图 / 有没有思考档」**永远没有真值**（逐家不同），
           *     所以这三个键仍然不写。 */
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

/**
 * describeMuseLimits —— 每个模型的窗口/上限**是哪一级给的**（人可读一行）。
 *
 * ⚠ **不塞进 Muse 的 JSON**：那个形状逐字照 magpie 的 `museModels`
 *   （多一个字段就是不合形状）—— 面板上要显示「来源与日期」时用这个。
 *
 * ⚠ `shared`（别的渠道对同一模型的实测）那一条会写成「参考：… 本渠道未实测，
 *   按兜底给」—— 它**不下发**（报大比报小危险，见 `model-facts.mjs` 的 kind 说明）。
 *
 * @param {Array<{id:string}>} entries 模型清单条目
 * @param {object} [opts] 与 `buildMuseModels` 同一组选项
 * @returns {Object<string,string>} `{ [id]: 说明 }`
 */
export function describeMuseLimits(entries, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const list = Array.isArray(entries) ? entries : [];
  const out = {};
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const id = String(e.id == null ? "" : e.id).trim();
    if (!id) continue;
    const k = resolveKnown(id, o);
    const lim = limitFor(id, k);
    if (k.level === "fallback") {
      out[id] = `兜底值（约定，不是实测）· ${lim.context}/${lim.output}`;
      continue;
    }
    if (k.level === "shared") {
      const ref = k.ref ? `${k.ref.context}/${k.ref.output}` : "未知";
      out[id] = `参考：${ref}（${k.source}${k.at ? `，记于 ${k.at}` : ""}）`
        + ` —— 本渠道未实测，按兜底给 · ${lim.context}/${lim.output}`;
      continue;
    }
    const kind = k.kind === "convention" ? "约定"
      : (k.kind === "measured" ? "实测"
        : (k.kind === "measured-elsewhere" ? "实测（他渠道，非本家目录）" : "给定"));
    const src = k.source || "来源由调用方给出";
    const at = k.at ? ` · 记于 ${k.at}` : "";
    out[id] = `${kind} · ${src}${at} · ${lim.context}/${lim.output}`;
  }
  return out;
}
