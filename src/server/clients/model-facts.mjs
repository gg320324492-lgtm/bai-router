// src/server/clients/model-facts.mjs —— **模型真值表**（窗口 / 输出上限）
//
// ## 这个模块补的是哪个洞
//
// 我们写进客户端模型表的**只有 id 与名字**；窗口与输出上限一直是**兜底值**
// （`clients/muse-models.mjs` 的 128000 / 32000）。用户看到 128K 会以为
// 「这模型只能吃 128K、最多输出 32K」—— 那是假的。
//
// 这个模块给出一张**带日期戳**的表，以及查它的入口。设计稿：
// `docs/client-wiring-deep-plan.md` §2.1（数据来源）与 §三 阶段 1（内置表）。
//
// ## 两类东西必须分清（**本模块只管第一类**）
//
//   ① **窗口 / 输出上限** —— 有「兜底约定」这一说（magpie 自己也有：
//      `internal/gateway/muse.go:12-15` 的 128000 / 32000）。写兜底可以，
//      但**必须标明是约定不是实测值** ⇒ 本表的每条都带 `kind` 与 `source`。
//   ② **思考档 / 收不收图** —— **永远没有真值**（能力由映射到哪家上游决定，
//      逐家不同）。⇒ **不写那个键**（不是写 false）。见
//      `clients/muse-models.mjs` 的文件头 ②。本模块**不碰**这一类。
//
// ## 表的键为什么是「渠道 + 最终模型名」
//
//   · **不是档位名**（`claude-opus-5`）：那是 provider 无关的别名，
//     同一个档位在 sn 映射到 glm-5.2、在 wb 映射到 hy3 —— 按档位存就得写四条。
//   · **是最终模型名**（`glm-5.2`）：那是模型本身。设计稿 §2.1 第 1 条说的
//     「按最终模型名归一」指的就是这个 —— 档位 → 最终模型名的映射本来就在
//     `cfg[渠道].mapping` 里。
//   · **前一段是渠道**：⚠ **实测证明同一个模型在不同渠道的窗口不一样**
//     （2026-10-23 实测：hy4-preview 在 wb 目录说 960000，在 wbai 目录说
//     1000000；glm-5.2 的输出上限 wb 说 64000、wbai 说 48000）。
//     那是**渠道侧各自的限制**，不是模型的属性 ⇒ 不混成一条。
//
// ## 真值从哪来（按分量排序，照设计稿 §2.1）
//
//   ① **渠道自己的目录接口**（最近的真源，零新增网络依赖）：
//      · wb / wbai —— `GET {upstream}/v3/config`，模型对象带
//        `maxInputTokens` / `maxOutputTokens`（驼峰）。
//        ⚠ 实测 2026-10-23：UA 才是闸门，CLI 形态才拿得到完整目录。
//        ⚠ 落盘缓存（`wb-catalog-*.json`）**把这两个字段丢了** —— 本仓的
//          `wbMapModel` 用它们做过滤却没存 ⇒ 只有原始响应里才有。
//      · qd —— `%TEMP%/qoder-models.json` 的 `app[]`，带 `max_input_tokens`
//        （蛇形），**没有**输出上限。
//   ② **本表（人工核对）**：八家 × 四档只有三十来条，人工核对比机器映射更准
//      （设计稿 §2.1 第 1 条：「映射错了会写错窗口 —— 那比不写更坏」）。
//   ③ **约定值**：兜底。**必须标明是约定。**
//
//   ⚠ **models.dev 不进关键路径**（设计稿 §四）：我们的 id 与它的 id 不同源。
//
// ## 纪律
//
//   · 纯 ESM、零第三方依赖、**零 IO**、**零时钟**（不 import 本仓任何别的模块）。
//   · 表**只读**（冻结）；查询函数不改调用方给进来的东西。
//   · **凭据不进这个文件**（表、注释、导出里都不许有真 key）。

/**
 * 约定值：不知道窗口 / 输出上限时用的兜底。
 *
 * ⚠ **兜底，不是真实上限**。出处：magpie `internal/gateway/muse.go:12-15`
 *   （`museContext = 128000` / `museOutput = 32000`）。
 * ⚠ 与 `clients/muse-models.mjs` 的 `MUSE_CONTEXT_FALLBACK` /
 *   `MUSE_OUTPUT_FALLBACK` **必须是同一对数** —— 不一致的话，
 *   「表里没有这条」与「表里说这条是约定」会给出不同的数字。
 */
export const CONVENTION_CONTEXT = 128000;
export const CONVENTION_OUTPUT = 32000;

/**
 * 最小可信窗口 —— 低于它就**当不知道**（不当真值）。
 *
 * 抄 magpie `internal/catalog/catalog.go:421` 的 `LeastWindow = 2048`：
 * 「比这更小的窗口装不下一个 agent 的系统提示词」⇒ 这样的数字多半是上游
 * 填错了或单位不对，**当作没给**比当真值好。
 *
 * ⚠ 这是 magpie 那条纪律在本仓的写法：**绝不把可疑值当真值**。
 */
export const LEAST_WINDOW = 2048;

/**
 * 一条模型事实。
 *
 * @typedef {object} ModelFact
 * @property {number} context  上下文窗口（0 = 不知道）
 * @property {number} output   输出上限（0 = 不知道）
 * @property {"measured"|"measured-elsewhere"|"shared"|"convention"} kind  四档，见下
 * @property {string} source   来源（人可读）
 * @property {string} sourceId 渠道目录里的原样 id（归一**前**的）
 * @property {string} at       日期戳（记于哪天）
 * @property {string} [note]   补充说明（归一方式、与其他渠道的出入…）
 */

/**
 * 四档 `kind` 的意思 —— **除 `shared` 外都发给客户端**：
 *
 *   · `measured` —— **本渠道自己**的目录接口说的。⇒ **发给客户端**。
 *   · `measured-elsewhere` —— **同一个模型 id** 在**两个独立渠道**的目录接口里
 *     给出**同一个值**（来源不是本家）。⇒ **发给客户端**，但**来源必须如实写
 *     「非本家目录」**。
 *     ⚠ **判据要卡严**：必须是**同一个模型 id**。名字不同的一律不算 ——
 *       `kimi-k3`（wbai 的目录）与 `kimi-k3-1`（wb 的目录）是**两个不同的模型**，
 *       数值撞了是**巧合**（同一家厂商的相邻版本常同窗口），不是「一个模型被测了两次」。
 *       「两家一致」的力量恰恰在于：两份来源指向**同一条**。
 *     ⚠ 证据强度：两家互不相干的渠道（wb 的国内站 + wbai 的国际站）对同一个模型
 *       测出同一个窗口与输出上限 ⇒ 这不是猜的，是**实测**；
 *       差的那 4 万（hy4-preview 在 wb 96 万 / wbai 100 万）是**渠道自己的额外限制**，
 *       与模型无关。
 *   · `shared` —— **只有一家**别家渠道测过（单点证据）。⇒ **不下发**。
 *     ⚠ **为什么不发**：单点证据可能不准；而**宁可报大也不能报小** ——
 *       报大 ⇒ 用户发超长 ⇒ 上游**诚实报错**（看得见）；报小 ⇒ 客户端
 *       （Claude Code 这类）**自动压缩上下文** ⇒ 用户无谓丢历史、**毫无报错**
 *       （那个才是真的坏）。
 *       ⇒ 等第二家渠道测到、或本家目录开口，再升级成 `measured-elsewhere`。
 *   · `convention` —— **约定值**（没有任何渠道目录接口能告诉我们这件事）。
 *     ⇒ 值就是兜底值本身，但要**标明是约定**。
 *
 * ⚠ **「宁可报大」的判据为什么反过来**（2026-10-23 拍板订正）：
 *   窗口报大 ⇒ 上游诚实报错（失败得诚实）；
 *   窗口报小 ⇒ 客户端静默压缩上下文（失败得**不诚实**，用户还不知道）。
 */

/**
 * 内置真值表。**键 = `渠道/最终模型名`**。
 *
 * ⚠ 每条的 `at` 是**记下这个值的日期** —— 上游改了窗口，表会过时，
 *   由「渠道目录优先 + 日期戳可见」兜住（设计稿 §2.1「怎么标过期了」）。
 *
 * ⚠ `kind`：
 *   · `measured` —— **渠道自己说的**（目录接口里的字段）。
 *   · `convention` —— **约定值**：没有任何渠道目录接口能告诉我们这件事。
 *
 * ⚠ `sourceId` 是**渠道目录里的原样 id**，可能与键里的模型名不同
 *   （归一：大小写不同 / 后缀不同）。归一方式写在 `note` 里 —— 这一条
 *   决定了「渠道目录覆盖表里的值」能不能对上号，别删。
 */
export const MODEL_FACTS = Object.freeze({
  /* ---- bai（聚合渠道 api.b.ai，本身没有目录接口） ---- */
  "bai/qwen3.8-flash": {
    context: CONVENTION_CONTEXT, output: CONVENTION_OUTPUT,
    kind: "convention", source: "约定（无渠道目录接口）", sourceId: "",
    at: "2026-10-23",
    note: "bai 是聚合渠道，没有自己的模型目录；qwen3.8-flash 的真实上限本仓无从得知。",
  },
  "bai/hy3": {
    context: 192000, output: 64000,
    kind: "measured-elsewhere", source: "wb /v3/config 与 wbai /v3/config（两家目录实测一致，非本家目录）",
    sourceId: "hy3", at: "2026-10-23",
    note: "bai 无目录接口 —— 此值是**两家独立渠道**（wb 国内站 + wbai 国际站）对同一模型"
      + "测出的同一个值 ⇒ 证据强度够，按「宁可报大、不报小」下发；来源**不是本家**。",
  },
  "bai/mimo-v2.5": {
    context: CONVENTION_CONTEXT, output: CONVENTION_OUTPUT,
    kind: "convention", source: "约定（无渠道目录接口）", sourceId: "",
    at: "2026-10-23",
    note: "目录里只有 mimo-v2.6-pro（**另一个版本**），不能拿来当 v2.5 的窗口。",
  },

  /* ---- sn（SenseNova，无目录接口） ---- */
  "sn/sensenova-6.8-flash-lite": {
    context: CONVENTION_CONTEXT, output: CONVENTION_OUTPUT,
    kind: "convention", source: "约定（无渠道目录接口）", sourceId: "",
    at: "2026-10-23",
    note: "SenseNova 没有公开的模型目录接口。",
  },
  "sn/deepseek-v4-flash": {
    context: 1000000, output: 50000,
    kind: "shared", source: "wb /v3/config（同一模型）", sourceId: "deepseek-v4-flash",
    at: "2026-10-23",
    note: "sn 无目录接口 —— 此值是**别的渠道**对同一模型的实测，**不下发**。",
  },
  "sn/glm-5.2": {
    context: 1000000, output: 64000,
    kind: "shared", source: "wb /v3/config（同一模型）", sourceId: "glm-5.2",
    at: "2026-10-23",
    note: "sn 无目录接口 —— **不下发**。⚠ wbai 目录对同一模型说输出上限是 48000 —— "
      + "渠道侧限制本就逐家不同，这正是不肯把别家的值发出去的理由。",
  },
  "sn/kimi-k3": {
    context: 1000000, output: 32000,
    kind: "shared", source: "wbai /v3/config（同一模型）", sourceId: "kimi-k3",
    at: "2026-10-23",
    note: "sn 无目录接口 ⇒ **不下发**。⚠ wb 目录里那条叫 `kimi-k3-1` —— "
      + "**名字不同的两个模型**（数值撞了是巧合），按「同一个模型 id 才算两家一致」的"
      + "判据，它**不算** wb 的旁证 ⇒ 只有 wbai 一个来源 ⇒ 单家。",
  },

  /* ---- wb（国内版 www.workbuddy.cn —— 有目录接口） ---- */
  "wb/deepseek-v4.1-flash": {
    context: 1000000, output: 128000,
    kind: "measured", source: "wb /v3/config", sourceId: "deepseek-v4.1-flash",
    at: "2026-10-23",
  },
  "wb/hy4-preview-f": {
    context: 960000, output: 64000,
    kind: "measured", source: "wb /v3/config", sourceId: "hy4-preview",
    at: "2026-10-23",
    note: "归一：我们的档位指向 hy4-preview-f，目录里的 id 是 hy4-preview（无 -f 后缀）。"
      + "⚠ wbai 目录对同一模型说窗口是 1000000 —— 渠道侧限制逐家不同。",
  },
  "wb/hy3": {
    context: 192000, output: 64000,
    kind: "measured", source: "wb /v3/config", sourceId: "hy3",
    at: "2026-10-23",
  },

  /* ---- wbai（国际版 www.workbuddy.ai —— 有目录接口） ---- */
  "wbai/deepseek-v4.1-flash": {
    context: 1000000, output: 128000,
    kind: "measured", source: "wbai /v3/config", sourceId: "deepseek-v4.1-flash",
    at: "2026-10-23",
  },
  "wbai/hy4-preview-f": {
    context: 1000000, output: 64000,
    kind: "measured", source: "wbai /v3/config", sourceId: "hy4-preview",
    at: "2026-10-23",
    note: "归一：目录里的 id 是 hy4-preview（我们的档位指向 hy4-preview-f）。"
      + "⚠ wb 目录对同一模型说窗口是 960000。",
  },
  "wbai/hy3": {
    context: 192000, output: 64000,
    kind: "measured", source: "wbai /v3/config", sourceId: "hy3",
    at: "2026-10-23",
  },
  /* ---- 下面几条：出厂快照里没有，但**渠道目录里有**（用户改过档位映射就会用到） ----
   *
   * ⚠ 为什么表要收这些：表是**按最终模型名**归一的（设计稿 §2.1 第 1 条）——
   *   档位名（`claude-opus-5`）是 provider 无关的别名，用户随时能把它指向别的模型。
   *   渠道目录是**活的**（2026-10-23 实测 wb/wbai 目录里都有 step-5-preview），
   *   它说 step-5-preview 能吃 100 万 ⇒ 表就该有这一条。
   */
  "wb/step-5-preview": {
    context: 1000000, output: 64000,
    kind: "measured", source: "wb /v3/config", sourceId: "step-5-preview",
    at: "2026-10-23",
  },
  "wbai/step-5-preview": {
    context: 1000000, output: 64000,
    kind: "measured", source: "wbai /v3/config", sourceId: "step-5-preview",
    at: "2026-10-23",
  },
  "wbai/hy4-preview": {
    context: 1000000, output: 64000,
    kind: "measured", source: "wbai /v3/config", sourceId: "hy4-preview",
    at: "2026-10-23",
    note: "与 wbai/hy4-preview-f 是**同一个模型**（同一个渠道目录里的同一个 id）——"
      + "两条并存是因为出厂快照用 -f、用户配置用不带后缀的那个。",
  },

  /* ---- zen（opencode.ai/zen —— 无目录接口） ---- */
  "zen/space-bunny-free": {
    context: 1000000, output: 128000,
    kind: "shared", source: "wb /v3/config（同一模型）", sourceId: "space-bunny",
    at: "2026-10-23",
    note: "归一：剥掉 -free 后缀对上目录里的 space-bunny。zen 无目录接口 —— **不下发**。"
      + "⚠ zen 的 free 档真实上限可能比这个更严。",
  },
  /* zen 的 free 档（实测本机在用）：zen 的目录接口 `GET {upstream}/models`
     **不带窗口信息**（实测 2026-10-23：条目只有 id/object/created/owned_by）⇒
     这几条**没有真值**，只能是约定值。 */
  "zen/beam-free": {
    context: CONVENTION_CONTEXT, output: CONVENTION_OUTPUT,
    kind: "convention", source: "约定（zen 的目录不带窗口信息）", sourceId: "",
    at: "2026-10-23",
  },
  "zen/deepseek-v4.1-flash-free": {
    context: CONVENTION_CONTEXT, output: CONVENTION_OUTPUT,
    kind: "convention", source: "约定（zen 的目录不带窗口信息）", sourceId: "",
    at: "2026-10-23",
  },
  "zen/nemotron-3.5-lightning-free": {
    context: CONVENTION_CONTEXT, output: CONVENTION_OUTPUT,
    kind: "convention", source: "约定（zen 的目录不带窗口信息）", sourceId: "",
    at: "2026-10-23",
  },
  "zen/mimo-v2.6-flash-free": {
    context: CONVENTION_CONTEXT, output: CONVENTION_OUTPUT,
    kind: "convention", source: "约定（zen 的目录不带窗口信息）", sourceId: "",
    at: "2026-10-23",
  },

  /* ---- qd（Qoder —— 目录在 %TEMP%/qoder-models.json，不在本仓手上） ---- */
  "qd/lite": {
    context: CONVENTION_CONTEXT, output: CONVENTION_OUTPUT,
    kind: "convention", source: "约定（Qoder 目录里没有这一条）", sourceId: "",
    at: "2026-10-23",
    note: "qd 的四档都指向 lite，而 lite 是**服务端别名** —— Qoder 客户端目录"
      + "（app[]）里没有它，只有 auto/ultimate/gmodel 这类真实档位。",
  },

  /* ---- mm（MiniMax —— 无目录接口） ---- */
  "mm/MiniMax-M3.1-Flash": {
    context: 1000000, output: 128000,
    kind: "measured-elsewhere", source: "wb /v3/config 与 wbai /v3/config（两家目录实测一致，非本家目录）",
    sourceId: "minimax-m3.1-flash", at: "2026-10-23",
    note: "归一：大小写不同（目录里是 minimax-m3.1-flash）。两家独立渠道实测一致 ⇒ 证据强度够，"
      + "按「宁可报大、不报小」下发；来源**不是本家**（mm 自己没有目录接口）。",
  },

  /* ---- or（OpenRouter —— 无目录接口） ---- */
  "or/openrouter/free": {
    context: CONVENTION_CONTEXT, output: CONVENTION_OUTPUT,
    kind: "convention", source: "约定（无渠道目录接口）", sourceId: "",
    at: "2026-10-23",
    note: "openrouter/free 每次请求路由到**不同的模型** ⇒ 没有一个固定的窗口。",
  },
});

/**
 * 出厂档位 → 最终模型名（**快照**）。
 *
 * ⚠ **这是快照，不是真相**：用户在面板上改过 `cfg[渠道].mapping` 之后，
 *   这里就与实际不符了 —— 所以它只用来做**静态兜底查询**。
 *   要准确的值，请用 {@link factForId}（它读 cfg）。
 *
 * 取自 `src/server/config.defaults.json` 的 `mapping`（2026-10-23 快照）。
 */
export const OUTLET_TIERS = Object.freeze({
  bai: Object.freeze({
    "claude-fable-5": "qwen3.8-flash",
    "claude-sonnet-5": "hy3",
    "claude-opus-5": "hy3",
    "claude-haiku-4-5": "mimo-v2.5",
  }),
  sn: Object.freeze({
    "claude-fable-5": "sensenova-6.8-flash-lite",
    "claude-sonnet-5": "deepseek-v4-flash",
    "claude-opus-5": "glm-5.2",
    "claude-haiku-4-5": "kimi-k3",
  }),
  wb: Object.freeze({
    "claude-fable-5": "deepseek-v4.1-flash",
    "claude-sonnet-5": "hy4-preview-f",
    "claude-opus-5": "hy3",
    "claude-haiku-4-5": "deepseek-v4.1-flash",
  }),
  wbai: Object.freeze({
    "claude-fable-5": "deepseek-v4.1-flash",
    "claude-sonnet-5": "hy4-preview-f",
    "claude-opus-5": "hy3",
    "claude-haiku-4-5": "deepseek-v4.1-flash",
  }),
  zen: Object.freeze({
    "claude-fable-5": "space-bunny-free",
    "claude-sonnet-5": "space-bunny-free",
    "claude-opus-5": "space-bunny-free",
    "claude-haiku-4-5": "space-bunny-free",
  }),
  qd: Object.freeze({
    "claude-fable-5": "lite",
    "claude-sonnet-5": "lite",
    "claude-opus-5": "lite",
    "claude-haiku-4-5": "lite",
  }),
  mm: Object.freeze({
    "claude-fable-5": "MiniMax-M3.1-Flash",
    "claude-sonnet-5": "MiniMax-M3.1-Flash",
    "claude-opus-5": "MiniMax-M3.1-Flash",
    "claude-haiku-4-5": "MiniMax-M3.1-Flash",
  }),
  or: Object.freeze({
    "claude-fable-5": "openrouter/free",
    "claude-sonnet-5": "openrouter/free",
    "claude-opus-5": "openrouter/free",
    "claude-haiku-4-5": "openrouter/free",
  }),
});

/** 出厂快照的日期（与 MODEL_FACTS 的日期戳同一批）。 */
export const OUTLET_TIERS_AT = "2026-10-23";

/**
 * windowOf —— 一个数是不是可信的窗口值。
 *
 * 抄 magpie `internal/catalog/catalog.go:426` 的 `Window(n)`：小于
 * {@link LEAST_WINDOW} 的当**不知道**（0）。
 *
 * @param {unknown} n
 * @returns {number} 可信就取整后的值；不可信（不是正数 / 太小 / 不是有限数）⇒ 0
 */
export function windowOf(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < LEAST_WINDOW) return 0;
  return Math.round(v);
}

/**
 * factFor —— 查某个**渠道的某个最终模型**的事实。
 *
 * @param {string} provider 渠道（bai/sn/wb/wbai/zen/qd/mm/or）
 * @param {string} target 最终模型名（`cfg[渠道].mapping[档位].target`）
 * @returns {ModelFact|null} 没有 ⇒ null（**不是**兜底值：兜底由调用方决定）
 */
export function factFor(provider, target) {
  const p = String(provider == null ? "" : provider).trim();
  const t = String(target == null ? "" : target).trim();
  if (!p || !t) return null;
  const f = MODEL_FACTS[`${p}/${t}`];
  return f ? { ...f } : null;
}

/**
 * factForTier —— 按**档位**查（**静态**路径，用出厂快照解析最终模型名）。
 *
 * ⚠ 用户改过 `cfg[渠道].mapping` 之后这里会失配 ⇒ 要准确的值用
 *   {@link factForId}（它读 cfg）。
 *
 * @param {string} provider 渠道
 * @param {string} tier 档位（claude-opus-5…）
 * @returns {ModelFact|null}
 */
export function factForTier(provider, tier) {
  const p = String(provider == null ? "" : provider).trim();
  const t = String(tier == null ? "" : tier).trim();
  const m = OUTLET_TIERS[p];
  if (!m) return null;
  const target = m[t];
  return target ? factFor(p, target) : null;
}

/**
 * 某渠道在 cfg 里的那一片。
 *
 * ⚠ **bai 是扁平的**：它的 `mapping` / `defaultModel` 直接摊在 cfg 顶层
 *   （其余渠道在 `cfg[渠道]` 里）—— 与 `gateway-failover.mjs` 的
 *   `sliceOfProvider` 同一口径。
 */
function sliceOf(cfg, provider) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  if (provider === "bai") return c;
  const s = c[provider];
  return s && typeof s === "object" ? s : {};
}

/**
 * resolveTarget —— cfg 里某渠道某档位指向哪个最终模型。
 *
 * @param {object} cfg
 * @param {string} provider
 * @param {string} tier
 * @returns {string} 找不到 ⇒ 空串
 */
export function resolveTarget(cfg, provider, tier) {
  const t = String(tier == null ? "" : tier).trim();
  if (!t) return "";
  const mapping = sliceOf(cfg, provider).mapping;
  const m = mapping && typeof mapping === "object" ? mapping[t] : null;
  if (m && typeof m === "object" && m.target) return String(m.target).trim();
  /* 形状也可能是裸串（有的配置直接写模型名）—— 两种都认。 */
  if (typeof m === "string" && m.trim()) return m.trim();
  return "";
}

/**
 * factForId —— 按**模型 id**（`provider/档位`）查事实（**权威**路径）。
 *
 * ⚠ 权威 = 它读的是**当前 cfg** 的映射 ⇒ 用户改过档位映射也能对上。
 *
 * @param {object} cfg
 * @param {string} id 模型 id（`provider/档位`）
 * @param {object} [opts] · runtime —— **运行时覆盖层**（渠道目录拉下来的那份）
 * @returns {ModelFact|null}
 */
export function factForId(cfg, id, opts) {
  const s = String(id == null ? "" : id).trim();
  const i = s.indexOf("/");
  if (i <= 0) return null;
  const provider = s.slice(0, i);
  const tier = s.slice(i + 1);
  const target = resolveTarget(cfg, provider, tier);
  if (!target) return null;
  const runtime = runtimeFact(opts, provider, target);
  if (runtime) return runtime;
  return factFor(provider, target);
}

/**
 * runtimeFact —— 运行时覆盖层里查一条事实。
 *
 * ⚠ **覆盖层优先于内置表**：渠道目录是**活的**，它说的比人工核对的表新
 *   （设计稿 §2.1「渠道目录能说真话时以渠道为准，并顺手刷新表里的那条与日期戳」）。
 *
 * @param {object} [opts] · runtime
 * @param {string} provider
 * @param {string} target 最终模型名
 * @returns {ModelFact|null}
 */
function runtimeFact(opts, provider, target) {
  const runtime = opts && opts.runtime && typeof opts.runtime === "object" ? opts.runtime : null;
  if (!runtime) return null;
  const f = runtime[`${provider}/${target}`];
  if (!f || typeof f !== "object") return null;
  return { ...f };
}

/**
 * factsFor —— 给一串模型 id 求**可下发**的事实表。
 *
 * 这是 **Muse 那条通道**要的形状（`clients/muse-models.mjs` 的 `opts.facts`）：
 * `{ [id]: { context, output, kind, source, at } }`。
 *
 * ⚠ **只给「可下发」的**（`publishable`）：`shared`（别的渠道的实测）**不给** ——
 *   本渠道自己没说过，报大比报小危险（见 kind 的说明）。
 * ⚠ **查不到就不给**：查不到事实的 id **不出现**在这个映射里 ——
 *   由 Muse 那侧决定用什么兜底。**这里绝不填兜底值**：兜底是「我不知道」，
 *   混进真值里就分不清了（设计稿 §2.1「绝不把兜底当真值」）。
 *
 * @param {object} cfg
 * @param {string[]} ids 模型 id 列表
 * @param {object} [opts] · runtime —— **运行时覆盖层**（渠道目录拉下来的那份）
 * @returns {Object<string,{context:number,output:number,kind:string,source:string,at:string}>}
 */
export function factsFor(cfg, ids, opts) {
  const out = {};
  const list = Array.isArray(ids) ? ids : [];
  for (const id of list) {
    const f = factForId(cfg, id, opts);
    if (!f || !publishable(f)) continue;
    const context = windowOf(f.context);
    const output = windowOf(f.output);
    if (!context && !output) continue;
    out[id] = {
      context: context || 0,
      output: output || 0,
      kind: f.kind,
      source: f.source,
      at: f.at,
    };
  }
  return out;
}

/**
 * limitsFor —— 给一串模型 id 求 `{ [id]: { context, output } }`。
 *
 * 这是 **Muse 那条通道**要的形状（`clients/muse-models.mjs` 的 `opts.limits`）。
 *
 * ⚠ **拿不到就是拿不到**：查不到事实的 id **不出现**在这个映射里 ——
 *   由 Muse 那侧决定用什么兜底。**这里绝不填兜底值**：兜底是「我不知道」，
 *   混进真值里就分不清了（设计稿 §2.1「绝不把兜底当真值」）。
 * ⚠ 与 `factsFor` 同一口径：**只给可下发的**（`shared` 不给）。
 *
 * @param {object} cfg
 * @param {string[]} ids 模型 id 列表
 * @param {object} [opts] · runtime —— **运行时覆盖层**（渠道目录拉下来的那份）
 * @returns {Object<string,{context:number,output:number}>}
 */
export function limitsFor(cfg, ids, opts) {
  const out = {};
  const list = Array.isArray(ids) ? ids : [];
  for (const id of list) {
    const f = factForId(cfg, id, opts);
    if (!f || !publishable(f)) continue;
    const context = windowOf(f.context);
    const output = windowOf(f.output);
    if (!context && !output) continue;
    out[id] = { context: context || 0, output: output || 0 };
  }
  return out;
}

/**
 * publishable —— 这条事实**能不能发给客户端**。
 *
 * ⚠ **只有 `shared` 不行**（单点证据：只有一家别家渠道测过）。
 *   `measured`（本家测的）、`measured-elsewhere`（两家一致）、`convention`（约定）
 *   都发 —— 依据是「**宁可报大**：报大是上游诚实报错，报小是客户端静默压缩上下文
 *   且毫无报错」；后者才是真的坏。
 *
 * @param {ModelFact|null} fact
 * @returns {boolean}
 */
export function publishable(fact) {
  if (!fact || typeof fact !== "object") return false;
  const k = String(fact.kind || "");
  if (k === "shared") return false;
  return k === "measured" || k === "measured-elsewhere" || k === "convention";
}

/**
 * factsForEntries —— 给**模型清单条目**求事实表（省得调用方自己 map）。
 *
 * ⚠ **为什么有它**：调用方（`server.mjs` 的 `gatewayMuseModels`）手里的 `entries`
 *   就是 `gatewayModelEntries(cfg)` 的结果，而 `factsFor` 要的是**模型 id 数组**
 *   ⇒ 调用方得自己写 `entries.map((e) => e.id)`。
 *   ⚠ 那一行是**最容易接错**的地方：`entries` 变量名写错 ⇒ 拿到空数组 ⇒
 *   **静默拿到空表**（没有报错，只是真值全没了）。这个函数把 map 收进来，
 *   并且**两种形状都收**（条目对象数组或 id 字符串数组）⇒ 少一个抄错的点。
 *
 * @param {object} cfg
 * @param {Array} entries 模型清单条目（`{ id }`）或模型 id 字符串
 * @param {object} [opts] · runtime —— 运行时覆盖层
 * @returns {Object<string,{context:number,output:number,kind:string,source:string,at:string}>}
 */
export function factsForEntries(cfg, entries, opts) {
  return factsFor(cfg, entryIds(entries), opts);
}

/**
 * entryIds —— 从模型清单条目里取出模型 id 数组。
 *
 * @param {Array} entries 条目对象（`{ id }`）或 id 字符串
 * @returns {string[]}
 */
function entryIds(entries) {
  const out = [];
  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) {
    const id = e && typeof e === "object" ? String(e.id == null ? "" : e.id).trim() : String(e == null ? "" : e).trim();
    if (id) out.push(id);
  }
  return out;
}

/**
 * describeFactLookup —— **诊断**：这次查到了什么、没查到什么。
 *
 * ⚠ **为什么有它**：「静默退回兜底」是这一层最阴的坏法 —— 接线接错（变量名写错、
 *   cfg 取错、entries 是空的）时**不报错**，只是所有模型都用兜底值，
 *   从外面看「一切正常，只是窗口全是 128K」。
 *   ⇒ 接线后跑一次这个函数，看 `nonDefault` 与 `byKind` 就知道接对没有。
 *
 * ⚠ **三个指标要分清**（分不清就会把「全退回兜底」看成「接好了」）：
 *   · `ids`      —— 该查的模型 id 有几个。
 *   · `found`    —— 表里**有**这一条的个数（**含约定值** ⇒ 常常等于 ids）。
 *   · `nonDefault` —— **值不是兜底值**的个数 ⇒ 这才是「真接到真值了」的条数。
 *     ⚠ **`ids > 0` 而 `nonDefault === 0`** ⇒ 全退回兜底 ⇒ **接错了**。
 *
 * @param {object} cfg
 * @param {Array} entries 模型清单条目或 id 字符串
 * @param {object} [opts] · runtime
 * @returns {{ids:number, found:number, nonDefault:number, byKind:object, missing:string[], facts:object}}
 */
export function describeFactLookup(cfg, entries, opts) {
  const ids = entryIds(entries);
  const facts = factsFor(cfg, ids, opts);
  const missing = ids.filter((id) => !facts[id]);
  const byKind = {};
  let nonDefault = 0;
  for (const id of ids) {
    const f = facts[id];
    if (!f) continue;
    const k = String(f.kind || "");
    byKind[k] = (byKind[k] || 0) + 1;
    if (f.context !== CONVENTION_CONTEXT || f.output !== CONVENTION_OUTPUT) nonDefault++;
  }
  return {
    ids: ids.length,
    found: ids.length - missing.length,
    nonDefault,
    byKind,
    missing,
    facts,
  };
}

/**
 * describeFact —— 把一条事实说成人能读的一行（面板上写来源与日期用）。
 *
 * ⚠ **`measured-elsewhere` 的措辞不能含糊**：它必须让人看得出「来源不是本家」，
 *   否则就是把别家的限制当成本家的说。
 *
 * @param {ModelFact|null} fact
 * @returns {string} 没有 ⇒ "未知（没有真值）"
 */
export function describeFact(fact) {
  if (!fact || typeof fact !== "object") return "未知（没有真值）";
  const kind = fact.kind === "measured" ? "实测"
    : (fact.kind === "measured-elsewhere" ? "实测（他渠道，非本家目录）"
      : (fact.kind === "shared" ? "参考（他渠道单家实测）" : "约定"));
  const src = fact.source ? String(fact.source) : "未知来源";
  const at = fact.at ? String(fact.at) : "日期不详";
  return `${kind} · ${src} · 记于 ${at}`;
}

/**
 * factRows —— 表里的全部条目（面板上列出来用）。
 *
 * @returns {Array<{key:string, provider:string, target:string, fact:ModelFact}>}
 */
export function factRows() {
  return Object.keys(MODEL_FACTS).map((key) => {
    const i = key.indexOf("/");
    return {
      key,
      provider: key.slice(0, i),
      target: key.slice(i + 1),
      fact: { ...MODEL_FACTS[key] },
    };
  });
}
