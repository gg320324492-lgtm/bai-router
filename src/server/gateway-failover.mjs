/**
 * gateway-failover.mjs —— 统一网关（magpie 形态的那个「一个端口」）的**档位识别**。
 *
 * ## 它补的是哪个洞
 *
 * bai-router 一直有故障转移：`server.mjs` 的 `attemptWithFailover` 按 `cfg.failover.chain`
 * 挨家试，每家**按自己的映射表**把档位重新解析成模型。
 *
 * 而**档位（tier）在网关模式下会丢**：
 *   · 网关（`gateway.mjs`）拆模型 id 的 `provider/...` 前缀，把请求交给**那一家**的
 *     relay handler。
 *   · 若模型 id 写的是 `provider/最终模型`（如 `sn/glm-5.2`），**档位信息就没了**。
 *     转移时不知道该用哪一档 → 要么把原模型发给下一家（多半 400），
 *     要么靠反查把档位猜回来（多档同模型时**必然猜错**）。
 *
 * ## 正确形态：`provider/档位`
 *
 * **档位是 provider 无关的抽象，「最终模型名」是 provider 相关的具体值。**
 * magpie 的模型 id 就是这个语义：id 里带的是「档位/槽位」，每家自己的表把槽位
 * 翻成它的真实模型名。我们这边的 `mapping[档位].target` 正是那张表。
 *
 * 所以网关模式下模型 id 应当写成 `provider/档位`（如 `sn/claude-opus-5`）：
 *   · 网关只做**前缀剥离**，档位原样透传给中转 → **档位不丢**；
 *   · 中转沿用老路径那套「档位 → 本家模型」解析，**一个字都不用改**；
 *   · 故障转移时 `bodyFor(档位)` 按**目标家**重解析，也就自动正确了。
 *
 * ## 本模块提供两个方向
 *
 *   · `tierKeyFor` —— 「这个名字**本身就是**该家的一个档位吗？」（新写法走这条）
 *   · `tierOfModel` —— 「**哪个**档位指向这个模型？」（旧写法/用户手写走这条；
 *     **命中多个就是歧义，返回 null，不猜**）
 *
 * ## 边界
 *
 *   · **纯逻辑**：零依赖、不碰 fs、不碰网络、**内部绝不调 `Date.now()`**（时间由
 *     `opts.now` 传进来）。这样它能被单测逐字断言，也不会在半夜改写别人的配置。
 *   · **不改任何既有文件**：本模块只**读** cfg。它是给 `server.mjs` 接线用的零件，
 *     不是第二个故障转移实现——真正的「转移」（发请求、判成败、冷却）仍在 server.mjs。
 */
import { KNOWN_PROVIDERS, parseGatewayModel } from "./gateway.mjs";

/* ========================================================================== *
 * 一、照抄 server.mjs 的三个小工具（逐字一致，见下方「为什么照抄」）
 * ========================================================================== */

/**
 * 为什么照抄：`server.mjs` 的 `resolveModel` 用它把客户端送来的名字**归一化**
 * （去 [..] 后缀 + 转小写）。我们要与它的**回落语义一字不差**（见 resolveTargetIn），
 * 就不能自己另发明一套归一化——两套归一化一旦分叉，「用户点的档位」与「实际跑的模型」
 * 就会在转移时对不上，而那种错**面板上看不出来**（只有一行日志）。
 *
 * ⚠ 只归一化**查表用的 key**；查出来的 target 原样返回（上游 id 大小写敏感，见 mm）。
 */
function normalizeModel(name) {
  return String(name).replace(/\s*\[[^\]]*\]\s*$/, "").trim().toLowerCase();
}

/**
 * 档位 key：Claude Code 有时发来的是**带日期后缀的规范 id**
 * （claude-haiku-4-5-20251001），而映射表的 key 是**不带日期的档位名**。
 * 与 `server.mjs` 的 `tierKeyOf` 逐字相同。
 */
function tierKeyOf(base) {
  const m = /^(.+)-\d{8}$/.exec(String(base));
  return m ? m[1] : String(base);
}

/**
 * 可用清单里的匹配：**大小写不敏感**，命中时返回**清单里的原样写法**。
 * 与 `server.mjs` 的 `listedModelOf` 逐字相同。
 *
 * ⚠ 返回的是**清单里的写法**（不是小写版）——上游 id 大小写敏感，发错了会 400。
 */
function listedModelOf(base, list) {
  const arr = Array.isArray(list) ? list : [];
  const hit = arr.find((x) => String(x).toLowerCase() === base);
  return hit == null ? null : String(hit);
}

/* ========================================================================== *
 * 二、渠道切片：某家在 cfg 里的映射表 / 可用清单 / 默认模型
 * ========================================================================== */

/**
 * 取某渠道的切片（mapping / availableModels / defaultModel）。
 *
 * ⚠ **bai 是「扁平」的**：它的字段直接摊在 cfg 顶层（`cfg.mapping` / `cfg.defaultModel` /
 * `cfg.availableModels`），其余七家在 `cfg[provider]` 子对象里。
 * 这不是本模块的发明——`server.mjs` 的 `sliceOf` 与 `providerConfigured` 都是这么
 * special-case 的，同一个理由（cfg 里既有渠道键也有一堆非渠道键，bai 当年是第一个渠道，
 * 字段就直接摊在顶层了）。这里照抄那个形状，否则给 bai 找映射会一路找到 undefined。
 */
export function sliceOfProvider(provider, cfg) {
  const c = cfg || {};
  const sub = provider === "bai" ? c : (c[provider] || {});
  return {
    provider,
    mapping: sub.mapping && typeof sub.mapping === "object" ? sub.mapping : {},
    availableModels: Array.isArray(sub.availableModels) ? sub.availableModels : [],
    defaultModel: typeof sub.defaultModel === "string" ? sub.defaultModel : "",
  };
}

/* ========================================================================== *
 * 三、档位反查与重解析（本模块的核心）
 * ========================================================================== */

/**
 * **档位反查**：给定 (provider, 模型)，找出**哪一档的 target 等于这个模型**。
 *
 * ⚠⚠ **命中多个 = 歧义 = 返回 null，不猜。**
 *
 * 这条曾经写错过，代价很大。原文是「取第一个命中的档位……为什么无害：两档映射到
 * 同一个模型时，转移后拿到的模型一样」。**那是错的**：转移后拿到的模型由**目标家**
 * 按档位决定，而目标家的各档**指向不同的模型**。出厂默认里 zen/qd/or/mm 的四档
 * 全指向同一个模型，于是反查必然命中四个：
 *   · 反查 zen/space-bunny-free → 命中 fable（第一个）
 *   · 转移到 wb → wb 的 fable 档是 deepseek-v4.1-flash
 *   · 而用户点的是 opus 档，在 wb 上应该是 hy3
 * 也就是说：**用户点 opus，转移后跑的是 fable 的模型**——计费档位被悄悄换掉了，
 * 而面板上什么异常都看不到。
 *
 * 歧义不是可以「挑一个」的技术细节：**档位是从模型名反推出来的，而模型名在
 * provider 内部不再能区分档位**（多档同模型时），信息在链路上就丢了。
 * 唯一正确的做法是别丢——见 `tierKeyFor` 与网关的档位透传。
 *
 * ⚠ 比较用**逐字相等**（不做大小写归一）：上游模型 id 是**大小写敏感**的
 * （MiniMax 的 `MiniMax-M3.1-Flash` 就是），大小写不敏感地匹配有命中**另一个**档位
 * 的可能——那就不是「同模型」，那是「换了一个模型」。
 *
 * @param {string} provider 渠道键（sn / wb / …）
 * @param {string} model 该渠道下的模型名（最终模型名）
 * @param {object} cfg 全量配置
 * @returns {string|null} 档位 key；反查不到**或命中多个**都返回 null
 */
export function tierOfModel(provider, model, cfg) {
  if (!provider || model == null) return null;
  const want = String(model);
  if (!want) return null;
  const slice = sliceOfProvider(provider, cfg);
  let found = null;
  for (const [tier, entry] of Object.entries(slice.mapping)) {
    if (!entry || !entry.target) continue;              // 空 target 不该命中任何东西
    if (String(entry.target) !== want) continue;
    if (found !== null) return null;                    // 命中第二个 → 歧义 → 不猜
    found = tier;
  }
  return found;
}

/**
 * **档位识别**：给定 (provider, 名字)，这个名字**是不是该家的一个档位**？
 *
 * 与 `tierOfModel` 是**反向**的一问一答：
 *   · `tierKeyFor`  —— 「这个名字本身就是个档位吗？」（模型 id 写 `provider/档位` 时用）
 *   · `tierOfModel` —— 「哪个档位指向这个模型？」（模型 id 写 `provider/最终模型` 时用）
 *
 * 为什么两个都要：模型 id 有两种写法，两种都得认。
 *   · `provider/档位`（**新写法，网关模式下的正规写法**）→ 档位**直接就在 id 里**，
 *     不用反查，也不会有歧义（档位名本身就是唯一的）。中转按本家映射解析即可。
 *   · `provider/最终模型`（旧写法 / 用户手写）→ 只能反查，多档同模型时必然歧义 →
 *     返回 null（宁可不知道，也不要用错档位）。
 *
 * 归一化与 `server.mjs` 的 `normalizeModel` / `tierKeyOf` 逐字一致：
 * 去 `[..]` 后缀、转小写、去日期后缀（claude-haiku-4-5-20251001 → claude-haiku-4-5）。
 *
 * @param {string} provider 渠道键
 * @param {string} name 模型 id 的模型段
 * @param {object} cfg 全量配置
 * @param {object} [opts]
 * @param {string[]} [opts.tiers] 已知档位 key 清单（server.mjs 的 TIERS）。
 *   传了就多认一层：**这一家没配这个档位，但它是系统认得的档位** → 仍按档位处理，
 *   让中转按「本家映射 → 回落本家默认模型」走，并留下一条回落留痕。
 *   不传就只认「这一家映射表里有的」（够用的常态：出厂默认四家各四档齐全）。
 * @returns {string|null} 是档位就返回**档位 key**，不是就返回 null
 */
export function tierKeyFor(provider, name, cfg, opts = {}) {
  if (!provider || name == null) return null;
  const base = normalizeModel(name);
  if (!base) return null;
  const mapping = sliceOfProvider(provider, cfg).mapping;
  const known = Array.isArray(opts.tiers) ? opts.tiers : [];
  /* 逐级降级：先精确，再去日期后缀，再去小版本（claude-sonnet-5-5 → claude-sonnet-5）。
   * ⚠ 与 server.mjs 的 resolveModelTarget **同一套降级序列** —— 两边口径必须一致：
   *   一边认得「带小版本的档位名」、另一边不认，就会出现「查表认得、转移不认」
   *   这种鬼故事（档位在入口解析对了，转移时又当成不知道的模型名）。 */
  for (const k of tierKeyChain(base)) {
    if (Object.prototype.hasOwnProperty.call(mapping, k)) return k;
    if (known.includes(k)) return k;
  }
  return null;
}

/**
 * 档位名的降级序列：先精确，再去日期后缀，再去小版本。
 *
 * ⚠ 为什么必须有：客户端（Claude Code）送来的模型 id 带**小版本**
 *   （claude-sonnet-5-5），而映射表的 key 是**档位名**（claude-sonnet-5）。
 *   差一段就查不到 → 静默回落到默认模型 → 用户点 opus、跑的是默认那个。
 *   小版本**会继续涨**，所以修法不是把 key 改成带小版本（下次升级又对不上），
 *   而是查表时逐级降级 —— 用户的映射表不用因为厂商升小版本而重填。
 *
 * 顺序要紧：claude-haiku-4-5 必须**精确**命中（降级会把它错降成 claude-haiku-4）。
 */
function tierKeyChain(base) {
  const out = [];
  const push = (v) => {
    const s = String(v == null ? "" : v);
    if (s && !out.includes(s)) out.push(s);
  };
  push(base);
  push(tierKeyOf(base));
  let cur = out[out.length - 1] || "";
  for (let i = 0; i < 2; i++) {
    const m = /^(.+)-\d+$/.exec(cur);
    if (!m) break;
    cur = m[1];
    push(cur);
  }
  return out;
}

/**
 * 在某家渠道上，把**档位**解析成**模型名**。
 *
 * 查找规则与 `server.mjs` 的 `resolveModel` / `resolveModelTarget` **逐字相同**：
 *   ① 映射表：先查原名，再查去掉日期后缀的档位名
 *   ② 可用清单：先查原名，再查去掉日期后缀的档位名；大小写不敏感
 *   ③ 都没有 → 回落**这一家自己的 `defaultModel`**
 *
 * 为什么回落要用**目标家自己的** defaultModel：这正是 `server.mjs` 里
 * `attemptWithFailover` 的 `bodyFor` 干的事——转移时每个目标渠道都按**它自己的**
 * 映射重新解析，解析不到就落到**它**的默认模型（主渠道的映射在别的渠道往往不存在：
 * Qoder 的 lite / WorkBuddy 的 deepseek-* / Zen 的 space-bunny-free 互不相通）。
 * 用入口家的默认模型，等于把「这一家没有这个档位」变成「把入口的模型名硬发给这一家」
 * ——那正是转移后 400 的老毛病。
 *
 * @param {string|null} tier 档位 key（null = 不知道档位 → 直接回落）
 * @param {string} provider 目标渠道键
 * @param {object} cfg 全量配置
 * @param {object} [opts]
 * @param {string} [opts.fallbackProvider] 回落时用**谁**的 defaultModel（缺省＝目标家自己）。
 *   给它换人是一条**别的语义**（那条语义里「回落」指的是别家的默认模型），
 *   正常路径不传——传了就等于承认「这一格不按目标家自己算」。
 * @returns {string} 目标家在这个档位上的模型名；没有该档位 → 目标家的 defaultModel
 */
export function resolveForProvider(tier, provider, cfg, opts = {}) {
  const slice = sliceOfProvider(provider, cfg);
  const hit = resolveTargetIn(tier, slice);
  if (hit) return hit;
  /* 回落用**目标家自己**的 defaultModel。 */
  const fbProvider = opts.fallbackProvider || provider;
  const fb = fbProvider === provider ? slice : sliceOfProvider(fbProvider, cfg);
  return fb.defaultModel || "";
}

/**
 * 在**某一片渠道**（切片）里解析档位 → 模型名。**命中返回模型名，没命中返回 null**
 * （要不要回落交给调用方）。
 *
 * ⚠ 与 `server.mjs` 的 `resolveModelTarget` **同一形状、同一顺序**：
 *   逐级降级（tierKeyChain），**每一级里先查映射表再查可用清单**。
 *   两条路径的「档位 → 模型」是同一件事，规则必须逐字一致 ——
 *   入口解析对了、转移时解析成别的模型，用户看到的就是「有时 opus 有时不是 opus」，
 *   而面板上只多一条看不出所以然的记录。
 */
function resolveTargetIn(tier, slice) {
  if (tier == null) return null;
  const base = normalizeModel(tier);
  if (!base) return null;
  /* ⚠ **映射表整体优先于可用清单** —— 与 `server.mjs` 的 resolveModelTarget
   *   同一顺序（映射各级查完，再查清单各级）。组序调换的后果很具体：
   *   客户端送 claude-opus-5-20251001（带日期的规范 id），上游清单里正好有这一条，
   *   于是清单先命中，用户在映射表里写的那个对应关系被跳过，跑的是另一个模型。 */
  const chain = tierKeyChain(base);
  for (const k of chain) {
    const m = slice.mapping?.[k];
    if (m && m.target) return m.target;
  }
  for (const k of chain) {
    const l = listedModelOf(k, slice.availableModels);
    if (l) return l;
  }
  return null;
}

/* ========================================================================== *
 * 四、渠道凭据判据（与 server.mjs 的 providerConfigured 同口径）
 * ========================================================================== */

/**
 * 默认的「这家配了凭据吗」判据 —— **照抄 `server.mjs` 的 `providerConfigured`**。
 *
 * ⚠ 但只能抄**从 cfg 里看得出来**的那一部分：`providerConfigured` 里有两格是**看 io 的**
 * ——qd 要读令牌文件（`qdEnsureToken`，令牌每次客户端启动都轮换），mm 要问内存里的
 * 会员登录态（`mmTokens.recheck()`）。本模块**不碰 fs**，抄不了那两格。
 *
 * 所以：**要精确同口径，调用方用 `opts.isConfigured` 把 server.mjs 的
 * `providerConfigured` 注入进来**（server.mjs 接线时应当这么做）。
 * 这里的默认判据只保证「cfg 里能看出来没配的那几家会被跳过」，并且对
 * **qd / mm 保守判成没配**——宁可跳过（少一个备选），也不要拿一个必然 401 的渠道去试。
 */
function defaultConfigured(cfg, provider) {
  const c = cfg || {};
  if (provider === "bai") return !!c.apiKey;
  if (provider === "sn") return !!c.sn?.apiKey;
  if (provider === "wb") return !!c.wb?.accessToken;
  if (provider === "wbai") return !!c.wbai?.accessToken;
  /* zen 直连要 Zen 的 API Key；经 OpenCode 那条路用 OpenCode 自己的认证，不读这把 Key。
     传输开关的判据与 `oc-wiring.mjs` 的 `zenTransportOf` 逐字相同（严格等于 "opencode"，
     认不出来的值一律当 direct）。 */
  if (provider === "zen") return !!c.zen?.apiKey || c.zen?.transport === "opencode";
  /* or 是轮换区：至少 1 把 key 就算配置好（与 server.mjs 的 orKeys 同一口径）。 */
  if (provider === "or") return orKeys(c).length > 0;
  /* qd 的令牌通常在文件里（cfg.qd.token 只是手动粘贴的兜底），mm 的登录态压根不在 cfg 里。
     这两格默认判成「没配」——理由见上面的注释；要精确同口径请注入 opts.isConfigured。 */
  if (provider === "qd") return !!c.qd?.token;
  if (provider === "mm") return false;
  return false;
}

/** or（OpenRouter）的轮换 key 列表（与 server.mjs 的 orKeys 同一口径）。 */
function orKeys(cfg) {
  const keys = cfg && cfg.or && Array.isArray(cfg.or.keys) ? cfg.or.keys : [];
  return keys.filter((k) => typeof k === "string" && k.trim());
}

/* ========================================================================== *
 * 五、候选链
 * ========================================================================== */

/**
 * 转移备选：**按 `cfg.failover.chain` 里的其余各家**，
 * 每家按**它自己的**映射把档位重新解析成模型名。
 *
 * @param {string} provider 入口渠道（不出现在备选里）
 * @param {string|null} tier 档位 key（null = 不知道 → 各家都用自己的 defaultModel）
 * @param {object} cfg 全量配置
 * @param {object} [opts] 见 planGatewayChain
 * @returns {{provider:string, model:string, tier:string|null}[]}
 */
export function gatewayFallbacks(provider, tier, cfg, opts = {}) {
  const c = cfg || {};
  const entry = String(provider || "").trim().toLowerCase();
  const chain = Array.isArray(opts.chain) ? opts.chain : chainOf(c);
  const isConfigured = typeof opts.isConfigured === "function"
    ? opts.isConfigured
    : (p) => defaultConfigured(c, p);
  const rest = [];
  for (const raw of chain) {
    const key = String(raw || "").trim().toLowerCase();
    if (!key || key === entry) continue;                 // 入口永远排第一，且只出现一次
    if (!KNOWN_PROVIDERS.includes(key)) continue;       // 不认识的渠道直接不认（不猜）
    if (rest.includes(key)) continue;                   // chain 里有重复的也不重复试
    if (!isConfigured(key)) continue;                    // 没配凭据的跳过
    rest.push(key);
  }
  /* 排序钩子：调用方可以注入 server.mjs 的 orderChain（magpie 的路由组语义）。
     本模块**自己不打分、不排序**——它没有额度信号，也没有冷却表，
     排序策略归 server.mjs（它的 orderChain 在没有额度信号时原样返回，
     正好等于这里的默认顺序，见 scripts/chain-order-test.mjs ②）。 */
  const ordered = typeof opts.order === "function"
    ? sanitizeOrder(opts.order(rest, opts.now), entry)
    : rest;
  return ordered.map((p) => ({
    provider: p,
    model: resolveForProvider(tier, p, c),
    tier: tier == null ? null : tier,
  }));
}

/**
 * 统一网关的候选链：**入口第一家 + 转移备选**。
 *
 * 顺序与 magpie 一致：**用户手选的就是首选**，不该被 chain 里的顺序顶掉。
 * 所以入口永远排第一（`opts.entry` 或从模型 id 的前缀得到），
 * 其余按 `cfg.failover.chain` 的顺序（可由 `opts.order` 换成路由策略的顺序）。
 *
 * @param {string} model 客户端送来的模型 id（网关形态是 `provider/模型`）
 * @param {object} cfg 全量配置
 * @param {object} [opts]
 * @param {string} [opts.entry] 入口渠道键（不给就从模型 id 的前缀取）
 * @param {string[]} [opts.chain] 覆盖 `cfg.failover.chain`
 * @param {(p:string)=>boolean} [opts.isConfigured] 「这家配了凭据吗」的判据
 *   （接线时注入 server.mjs 的 providerConfigured，即精确同口径）
 * @param {number} [opts.now] 传给 `opts.order` 的时刻（**本模块自己不取时间**）
 * @param {(list:string[], now:number|undefined)=>string[]} [opts.order] 排序钩子
 * @returns {{provider:string, model:string, tier:string|null}[]}
 */
export function planGatewayChain(model, cfg, opts = {}) {
  const c = cfg || {};
  const parsed = parseGatewayModel(model, opts.isProvider);
  const entry = opts.entry
    ? String(opts.entry).trim().toLowerCase()
    : (parsed ? parsed.provider : "");
  if (!entry) return [];
  /* 模型段：模型 id 带前缀时取前缀后面那一段（已经是最终模型名），否则整串就是模型名。 */
  const entryModel = parsed ? parsed.model : String(model == null ? "" : model);
  const tier = tierOfModel(entry, entryModel, c);
  const head = { provider: entry, model: entryModel, tier };
  return [head, ...gatewayFallbacks(entry, tier, c, opts)];
}

/* ========================================================================== *
 * 六、小工具
 * ========================================================================== */

/** 转移链：来自 cfg（server.mjs 的 failover.chain 在这里是唯一的清单来源）。 */
function chainOf(cfg) {
  const f = cfg && cfg.failover;
  return f && Array.isArray(f.chain) ? f.chain : [];
}

/**
 * 排序钩子返回值的清洗：只认已知渠道、去掉入口、去重。
 * 钩子是外部代码，它返回什么我们都不能照单全收（否则一个写错的钩子能把请求
 * 发给一家根本没点的公司）。
 */
function sanitizeOrder(list, entry) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const key = String(raw || "").trim().toLowerCase();
    if (!key || key === entry) continue;
    if (!KNOWN_PROVIDERS.includes(key)) continue;
    if (out.includes(key)) continue;
    out.push(key);
  }
  return out;
}
