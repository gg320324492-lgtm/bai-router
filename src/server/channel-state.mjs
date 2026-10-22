/**
 * channel-state.mjs —— 渠道状态计算层（纯逻辑、零 import、零 IO、零时钟）
 *
 * ── 它补的是哪个洞 ────────────────────────────────────────────────────────
 *
 * 面板现在有五屏，同一个「这家什么状态」在四张卡里是**四套措辞、四种颜色**：
 *   · panel-common.js 的 credState/channelState：「已就绪 / 未配置 / 中转未起 /
 *     上游不可用 / 预期内被拒 / 凭据已失效 / 令牌陈旧」；
 *   · cards/quota-panel.js：「可用 / 冷却中 / 休息中」；
 *   · cards/or-rotation.js：「未配置 / 冷却中模型 / 额度：未读到」；
 *   · cards/failover.js：每家的冷却倒计时。
 * 同一个事实，四处措辞不同、颜色不同，用户得自己在脑子里翻译
 * （docs/ui-redesign.md 的问题 4 与原则 1：「状态是数据，不是装饰」）。
 *
 * 本模块是那条「一处算、一处着色」里的**算的那一处**：一个渠道 → 六态之一 +
 * 原因 + 数字。全局面板都从这里取，取到的必然一致。
 *
 * ── 为什么必须是「纯逻辑 + 全部注入」──────────────────────────────────────
 *
 * server.mjs 一 import 就起服务（抢单实例锁、开两个监听端口），住在里面的逻辑
 * 没法被测试直接 import 求值 —— 只能「注入一个替身去测」，而替身证明不了本体。
 * 本模块零 import、零 IO、零时钟：时刻、名称、在途数、冷却/休息/预算/凭据/探测
 * 全部由 ctx 注入，于是测试能**直接 import 生产跑的那一份**，离线跑完全部六态。
 *
 * ── 六态的优先级为什么是这个顺序 ──────────────────────────────────────────
 *
 *   unconfigured > exhausted > resting > cooling > ok，unknown 是兜底。
 *
 * ① **unconfigured 最高**：没配上的一家谈不上「休息」或「冷却」—— 它从来没通过过
 *    请求，那边的冷却计时器根本是空的。用户此刻要做的动作是「去配它」；报成
 *    「休息中，等 15 分钟」会让人白等一场。
 * ② **exhausted > resting**：两者常常同时成立（预算到顶了，而这家确实在休息）。
 *    exhausted 是**更具体的原因**（我们自己设的预算到顶了），resting 是**更笼统的
 *    容器**（上游额度 / 令牌 / 上游问题都往里装）。具体压笼统：面板显示红色
 *    「预算用完」，用户知道该调自己的预算；显示黄色「休息中」，用户不知道该调
 *    预算还是该干等上游。
 * ③ **resting > cooling**：cooling 是瞬时的（退避 1 分钟那种），resting 是把渠道
 *    彻底拿出轮转（额度 / 令牌 / 上游问题）。同时成立时按长的那个说了算 ——
 *    按短的显示，会让用户以为一分钟后就恢复。
 * ④ **cooling > ok**：冷却是确凿的事实，不能被「其它信号没发现问题」盖掉。
 * ⑤ **unknown 只在没有任何可用信号时才出现**：它是**兜底**，不是与其它五态并列
 *    的候选。它排在最后不是因为它最不重要，而是因为**它意味着「我们不知道」**
 *    —— 只有连一条正面证据都没有时，我们才敢说「不知道」。
 *
 * ── 「探不到」为什么不是「坏了」───────────────────────────────────────────
 *
 * 这是本模块最要紧的一条。面板上「未知」与「红色故障」必须分开，因为真相常常
 * 是：**这条网络不通 / 令牌没续期 / 厂商压根没这个接口** —— 三种都不是账号被封。
 * 混起来，用户会去查一个根本没坏的东西（magpie 自己的 GUI 就犯过这个：读不到的
 * 用量被渲染成红色，internal/gui/app.js 的 "Unknown: {why}" 走的是 err 色）。
 *
 * 所以这三条是硬的：
 *   · **探不到 → 数字是 null**（面板显示「—」）。绝不拿 0 顶替：0 会被读成
 *     「用完了」或「一点没花」，而真相是「不知道」；
 *   · **探不到 → 状态是 unknown（灰）**，不是 exhausted（红）、不是 resting（黄）；
 *   · **「探过读不出来」与「压根没有探测源」是两件事**：ctx 里 probeOf 返回
 *     null = 这一家没有额度探测源（**不是失败**）；返回 {known:false} = 探过，
 *     读不出来。**只有后者**才把「配好了但探不到」降级成 unknown。
 *
 * ── 与 magpie 的对应 ──────────────────────────────────────────────────────
 *
 * magpie 的 internal/gateway/routing.go 把「这家能不能用」拆成**三层正交**的
 * 事实；本模块是那三层的合并投影：
 *
 *   ① **配置态**（二元）：internal/provider/provider.go 的 Provider.Ready() ——
 *      「有账号 / 有 key / 这把 key 是可选的」。magpie 没有第三态，GUI 在 JS 侧
 *      再细分（internal/gui/app.js 的 p.key.set / p.account / p.vertex 分支）。
 *      → 本模块的 credentialOf 与 unconfigured。
 *
 *   ② **休息态**（带到期、到期自动醒）：routing.go 的 Rest 结构
 *      （Why / Status / Until / By / Failures / Key / Model），By 有九种
 *      （credit / retry-after / resets / window / quota / cooldown / backoff /
 *      restricted / off）；判定走 internal/gateway/fallback.go 的 restingOf /
 *      restLast / firstAwake，键分两级：restKey（provider@user，整号休息）与
 *      restID（provider@user/model，只那个模型休息）。
 *      → 本模块的 coolingOf / restingOf 与 cooling / resting 两态。
 *
 *   ③ **认知态**（三元，严格区分「厂商明说坏了」与「没问到」）：
 *      internal/provider/account.go 的 refreshRefused vs refreshFailed ——
 *      **只有厂商明说拒绝（400 / 401）才算登录态没了**，网络抖动与 403 一律不算
 *      （403 更可能是代理或机器人检查挡在中间）；internal/provider/logins_on.go
 *      的 savedRefreshFailed 只在 refused 时才写 Lapsed；
 *      internal/gateway/search_quota.go 写着 "a read that fails is said as
 *      unknown with why, never as 0 used"；internal/gateway/trace.go 的
 *      Known / Learns 两字段把「厂商说了」与「还没问过」分开。
 *      → 本模块的 probeOf、unknown 态，以及「探不到就是 null」这条硬规矩。
 *
 * magpie 的 GUI 用 keyDead（rest.why 是 auth 或 credit 才算「废了」）把「暂时
 * 背锅」与「账号永久坏了」分开。本模块没有「永久坏了」那一档（那是 exhausted 与
 * resting 的分工），但**「永久坏了」绝不能由「探不到」推出来**这一条，与
 * magpie 的 refreshRefused 同源。
 *
 * ── 红线 ──────────────────────────────────────────────────────────────────
 *   · 零 import：不依赖仓库任何模块（接线层把信号喂进来）。
 *   · 内部绝不调 Date.now()：现在几点一律由 ctx.now 传。
 *   · 缺注入项 = 「不知道」（→ unknown），**绝不当成「好」**。
 *   · 不编造数字：读不到就是 null（0 会被面板读成「用完了」）。
 *   · 注入项抛异常不许掀桌子：降级成「不知道」，面板不能因为一家出问题而整体挂掉。
 */

/** 六种状态，全局唯一的一份清单。顺序即面板默认的呈现顺序。 */
export const CHANNEL_STATES = ["ok", "cooling", "resting", "exhausted", "unconfigured", "unknown"];

/**
 * 判定优先级（理由见文件头）。数组顺序 = 判定顺序 = 从重到轻。
 *
 * ⚠ **unknown 不在这条链上**：它是兜底，不是候选。只有连一条正面证据都没有时，
 *   才会落到 unknown —— 「我们不知道」不该去和「我们知道的坏事」抢优先级。
 */
export const CHANNEL_STATE_PRIORITY = ["unconfigured", "exhausted", "resting", "cooling", "ok"];

/**
 * 读不到的数字一律是这个值。
 *
 * ⚠ **必须是 null，不能是 0**：面板把 0 读成「用完了 / 一点没花」，而真相是
 *   「不知道」。0 与 null 在这个模块里是两个意思，不是同一个意思的两种写法。
 */
const UNKNOWN_NUM = null;

/** 百分比夹在 0–100（与 quota.mjs 的 clampPct 同口径：量条只画得下 0–100）。 */
const clampPct = (x) => {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 100 ? 100 : x;
};

/** 数字读不出来就是 UNKNOWN_NUM。⚠ 0 是合法读数（「配了预算但还没花」）。 */
const numOrNull = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return UNKNOWN_NUM;
};

/** 只认普通对象（数组与 null 都当「没有」）。 */
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

/**
 * 调用注入项。注入项可能去读文件、发请求 —— 抛异常不许掀桌子。
 *
 * 为什么吞掉：面板要在**任何一家**出问题时仍然显示其余各家的状态。异常降级成
 * 「不知道」比整个面板 500 强，而「不知道」本来就是本模块的合法结论。
 */
const ask = (fn, provider) => {
  if (typeof fn !== "function") return undefined;
  try {
    return fn(provider);
  } catch {
    return undefined;
  }
};

/** 长文本截断（面板一行放不下，而 reason 是「一句人话」）。 */
const short = (s, n) => {
  const v = String(s == null ? "" : s).trim();
  if (v.length <= n) return v;
  return v.slice(0, n - 1) + "…";
};

/** 渠道 id：先问 ctx（可选扩展），再问 provider 自己的字段。 */
const keyOf = (provider, ctx) => {
  const fromCtx = ask(ctx.keyOf, provider);
  if (typeof fromCtx === "string" && fromCtx !== "") return fromCtx;
  if (typeof fromCtx === "number" && Number.isFinite(fromCtx)) return String(fromCtx);
  const p = obj(provider);
  for (const f of ["key", "id", "provider"]) {
    const v = p ? p[f] : undefined;
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
};

/** 显示名：ctx 优先，其次 provider.name，最后退回 id（总比空着强）。 */
const nameOf = (provider, ctx, key) => {
  const fromCtx = ask(ctx.nameOf, provider);
  if (typeof fromCtx === "string" && fromCtx !== "") return fromCtx;
  const p = obj(provider);
  const v = p ? p.name : undefined;
  if (typeof v === "string" && v !== "") return v;
  return key;
};

/** 「缺什么」可能是字符串，也可能是字符串数组。 */
const missingOf = (credential) => {
  if (!credential) return "";
  const m = credential.missing;
  if (typeof m === "string") return m.trim();
  if (Array.isArray(m)) return m.map((x) => String(x == null ? "" : x).trim()).filter(Boolean).join("、");
  return "";
};

/**
 * 到期了没有。
 *
 * ⚠ **until 为 0 / 缺失不算到期**：仓库里 0 是「没有时间」的惯用写法
 *   （quota.mjs 的 resetAtMs、server.mjs 的 restUntil 都用 0 表示「没有」），
 *   把它当成「1970 年就到期了」会把正在休息的渠道误判成可用。
 */
const expired = (until, now) => {
  const u = numOrNull(until);
  if (u == null || u <= 0) return false;
  if (now == null) return false;
  return now >= u;
};

/** 百分比：used 与 limit 都在才算是比例；limit 为 0 不是比例（是「没有上限」）。 */
const ratioOf = (used, limit) => {
  if (used == null || limit == null || !(limit > 0)) return UNKNOWN_NUM;
  return clampPct((used / limit) * 100);
};

/** 五个态各自的判据。unknown 是兜底，不在这里面。 */
const TESTS = {
  unconfigured: (s) => s.credConfigured === false,
  exhausted: (s) => s.budgetExhausted,
  resting: (s) => s.restingActive,
  cooling: (s) => s.coolingActive,
  ok: (s) => s.hasLiveness,
};

/**
 * 一个渠道的状态。
 *
 * @param {object} provider 渠道（至少带一个 id 字段：key / id / provider）
 * @param {object} ctx      全部信号注入（见文件头与下方各处注解）
 * @returns {{key:string, name:string, state:string, reason:string,
 *            busy:number|null, used:number|null, limit:number|null, ratio:number|null,
 *            detail:object}}
 */
export function channelState(provider, ctx) {
  const c = obj(ctx) || {};
  const key = keyOf(provider, c);
  const name = nameOf(provider, c, key);

  const now = numOrNull(c.now);
  const busy = numOrNull(ask(c.busyOf, provider));
  const cooling = obj(ask(c.coolingOf, provider));
  const resting = obj(ask(c.restingOf, provider));
  const budgetRaw = obj(ask(c.budgetOf, provider));
  const credential = obj(ask(c.credentialOf, provider));
  const probe = obj(ask(c.probeOf, provider));

  /* 凭据：只认布尔。别的形状（缺字段、字符串）一律当「不知道」——
     把「没告诉我」读成「没配」会把用户领到错误的修复动作上去。 */
  const credConfigured = credential && typeof credential.configured === "boolean" ? credential.configured : null;
  const missingText = missingOf(credential);
  const restNote = resting && resting.note ? short(String(resting.note), 120) : "";

  /* 预算：limit 为 0 在 quota.mjs 的口径里是「没设预算」，不是「上限为零」——
     当成预算会把面板显示成「0 / 0（0%）」，看着像「用完了」。known:false 同理
     （quotaState 的「没设预算」那一档就长这样）。 */
  const budgetLimit = budgetRaw ? numOrNull(budgetRaw.limit) : UNKNOWN_NUM;
  const budgetExhausted = !!(budgetRaw && budgetRaw.exhausted === true);
  const budget = budgetRaw && budgetRaw.known !== false && budgetLimit !== 0 ? budgetRaw : null;

  /* 探测：known:true = 上游应答了；known:false = 探过但读不出来；
     probe 为 null = 这一家压根没有探测源（**不是失败**）。 */
  const probeHasNumbers = !!probe && (numOrNull(probe.used) != null || numOrNull(probe.limit) != null);
  const probeKnown = !!probe && probe.known !== false && (probe.known === true || (probe.known == null && probeHasNumbers));
  const probeFailed = !!probe && probe.known === false;
  const probeError = probeFailed ? short(String(probe.error == null ? "" : probe.error), 120) : "";

  /* 休息 / 冷却：信调用方的布尔判定，但用 ctx.now 复核一次到期 ——
     调用方的布尔可能是上一轮留下的陈旧值。 */
  const coolingActive = !!(cooling && cooling.cooling === true) && !expired(cooling.until, now);
  const restingActive = !!(resting && resting.resting === true) && !expired(resting.until, now);

  /* 正面证据：有在途请求 = 这会儿就在服务；探测读到数 = 上游应答了；
     凭据配好 = 至少配上了。⚠ 「配好了但探过读不出来」**不算**正面证据：
     那正是「探不到 ≠ 坏了」要处理的局面 —— 灰的 unknown，而不是绿的 ok。 */
  const busyLive = busy != null && busy > 0;
  const credOk = credConfigured === true;
  const hasLiveness = busyLive || probeKnown || (credOk && !probeFailed);

  /* 优先级判定（顺序的理由见文件头）。 */
  const signals = { credConfigured, budgetExhausted, restingActive, coolingActive, hasLiveness };
  let state = "unknown";
  for (const st of CHANNEL_STATE_PRIORITY) {
    if (TESTS[st](signals)) {
      state = st;
      break;
    }
  }

  /* 数字跟着状态走：状态说「预算用完了」，数字就得是预算那一套，否则徽章与量条
     会互相打架（徽章红着、量条却显示上游还剩 80%）。 */
  let used = UNKNOWN_NUM;
  let limit = UNKNOWN_NUM;
  let ratio = UNKNOWN_NUM;
  const budgetNumbers = () => {
    used = numOrNull(budget.used);
    limit = numOrNull(budget.limit);
    ratio = numOrNull(budget.ratio);
    if (ratio == null) ratio = ratioOf(used, limit);
  };
  if (state === "exhausted" && budget) {
    budgetNumbers();
  } else if (probeKnown && (numOrNull(probe.used) != null || numOrNull(probe.limit) != null)) {
    used = numOrNull(probe.used);
    limit = numOrNull(probe.limit);
    ratio = ratioOf(used, limit);
  } else if (budget) {
    budgetNumbers();
  }

  /* 原因：一句人话，说清「为什么是这个状态」。刻意**不含**倒计时 ——
     倒计时每秒都在变，塞进 reason 会让整块面板每帧重排；
     时刻放在 detail 里由面板自己格式化。 */
  let reason = "";
  if (state === "ok") {
    reason = "可用";
  } else if (state === "cooling") {
    reason = "冷却中，等一会儿就好";
  } else if (state === "resting") {
    reason = restNote ? `休息中：${restNote}` : "休息中";
  } else if (state === "exhausted") {
    reason = "预算用完了";
  } else if (state === "unconfigured") {
    reason = missingText ? `没配上：${short(missingText, 120)}` : "没配上：凭据未就绪";
  } else if (probeFailed) {
    reason = credOk ? `已配好，但探不到：${probeError || "原因不明"}` : `探不到：${probeError || "原因不明"}`;
  } else {
    reason = "状态不明，说不准现在能不能用";
  }

  /* 证据：徽章背后的依据。budget 与 credential 一直带着（面板的量条与凭据格
     都要用），cooling / resting 只在它们就是结论时带（被压住的那个不是结论）。 */
  const detail = {};
  if (budget) {
    detail.budget = {
      exhausted: budgetExhausted,
      used: numOrNull(budget.used),
      limit: numOrNull(budget.limit),
      ratio: numOrNull(budget.ratio),
      resetAtMs: numOrNull(budget.resetAtMs),
    };
  }
  if (credential) {
    detail.credential = {
      configured: credConfigured,
      missing: missingText || null,
      accounts: Array.isArray(credential.accounts) ? credential.accounts.slice() : [],
    };
  }
  if (state === "cooling") {
    detail.cooling = { until: numOrNull(cooling.until) };
  }
  if (state === "resting") {
    detail.resting = { until: numOrNull(resting.until), note: restNote };
  }

  return {
    key,
    name,
    state,
    reason,
    busy,
    used,
    limit,
    ratio,
    detail,
  };
}

/**
 * 一批渠道 → 一张状态表。
 *
 * 键是渠道 id。⚠ 拿不到 id 的条目用下标占位（接线层给的每个 provider 都该有
 * id；真出现时至少不会静默丢掉一家）。
 *
 * @param {object[]} providers 渠道列表
 * @param {object} ctx         信号注入（见 channelState）
 * @returns {Object<string, object>} 渠道 id → 状态
 */
export function statesOf(providers, ctx) {
  const out = {};
  const list = Array.isArray(providers) ? providers : [];
  list.forEach((p, i) => {
    const s = channelState(p, ctx);
    const k = s.key || String(i);
    s.key = k;
    out[k] = s;
  });
  return out;
}
