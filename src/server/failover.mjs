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

// 「额度用尽」是另一种失败：它不是抖动，等多久都不会自己好（实测 OpenCode Zen 的
// FreeUsageLimitError 连打全 429，官方也未公布免费额度重置时间）。这种失败给 90 秒
// 冷却毫无意义——冷却一过下条请求又原样撞上去。这里单独给一档长冷却：
// 取 30 分钟是权衡：①短于任何合理的额度重置周期之外还要"能自愈"——官方真重置了，
// 最多半小时后自动恢复，用户不用手动清冷却；②半小时才探一次，撞死渠道的代价可忽略。
// 注意：**不要**为了个例去改上面那个全局 90 秒——那影响所有渠道的瞬时失败。
export const FAILOVER_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;

const failoverState = new Map(); // provider -> { until, lastErr, quota }

// 注意：本模块不引用 server.mjs 的 noteRelayError——那是另一个模块的函数，
// 跨模块直接调用会 ReferenceError（v1.0.43 初版踩过）。日志由调用方记。
// opts.quota = true 表示这次失败是「额度用尽」（非瞬时），冷却按 FAILOVER_QUOTA_COOLDOWN_MS 算；
// 不传 opts 的老调用行为完全不变（仍 90 秒）。
export function failoverCooldown(p, err, opts) {
  const quota = !!(opts && opts.quota);
  const prev = failoverState.get(p);
  // 不允许把「额度用尽」的长冷却降级成短冷却：额度冷却窗口内若又来一次别的失败
  // （网络异常、超时…），把它冲成 90 秒等于立刻放行，下条请求又去撞已知没额度的渠道。
  if (!quota && prev && prev.quota && prev.until > Date.now()) return;
  failoverState.set(p, {
    until: Date.now() + (quota ? FAILOVER_QUOTA_COOLDOWN_MS : FAILOVER_COOLDOWN_MS),
    lastErr: String(err || "").slice(0, 160),
    quota,
  });
}

// 是否正处在「额度用尽」冷却中。与 failoverAvailable 分开导出，是因为两种冷却对
// **入口提供方**的语义不同：瞬时冷却期间入口照样优先（手动选的就是首选），
// 只有额度这种"等也没用"的失败才让入口也退到后面——见 server.mjs 的 attemptWithFailover。
export function failoverQuotaBlocked(p) {
  const s = failoverState.get(p);
  return !!(s && s.quota && s.until > Date.now());
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
    if (s.until > Date.now()) out[p] = { cooldownLeftSec: Math.ceil((s.until - Date.now()) / 1000), lastErr: s.lastErr, quota: !!s.quota };
  }
  return out;
}

/* ====================================================================== *
 * 静默换人留痕（v1.0.88）——「我选的是 A，实际回答我的是 B」必须能被看见。
 *
 * 背景是一桩真实事故：用户在另一台机器上把 OpenCode Zen 配成入口，链序里紧跟着
 * WorkBuddy。Zen 免费档约 75% 的请求会挂起（上游不吐首 token），中转在**还没发出
 * 响应头**时判定失败、自动改投 WorkBuddy —— WorkBuddy 正常应答，于是每一次对话
 * 都在 WorkBuddy 上真实计费（实测每发约 $0.049），而面板上一切正常。
 * 跳转早就被 noteFailoverEvent 记进日志，只是那只是 `log()`，谁都不会去看。
 *
 * 🔴 本模块只**记录**，不碰任何判定：哪些错误该转移、转移到谁，一个字都没改。
 *
 * —— 内存为什么是有界的（这是长期运行的服务，必须说清楚）——
 *   ① 明细环 silentJumpLog：定长 SILENT_JUMP_LOG 条，unshift + 溢出 pop。
 *   ② 组合表 silentJumpPairs：**按渠道对**（from|to）开条目，不是按流量开条目。
 *      渠道集合是封闭的（providers.js 清单，最多 7 家可进链），所以条目数上界是
 *      7×7=49，与跑了多久、多少条请求无关。再加一道 SILENT_JUMP_MAX_PAIRS 兜底，
 *      万一将来传入的 from/to 变成不可枚举的动态值，也不会失控。
 *   ③ 每条里的 minutes 是定长 SILENT_JUMP_WINDOW_MIN 的分钟桶环；minutes 本身也只
 *      增不删地按分钟数滚动，不是无限增长。
 *   三层都是"按固定上界"而不是"按时间清理"，所以最坏占用是个常数，跟运行时长无关。
 */
export const SILENT_JUMP_LOG = 50;          // 保留的最近明细条数
export const SILENT_JUMP_WINDOW_MIN = 60;  // 面板「最近 1 小时」的窗口 = 60 个分钟桶
export const SILENT_JUMP_MAX_PAIRS = 64;   // 组合表硬上界（渠道对 7×7=49 远小于它）

const silentJumpLog = [];    // 最近若干条 {at, from, to, model}，最新的在 [0]
const silentJumpPairs = new Map(); // "from|to" -> {from,to,total,lastAt,model,minutes:[{m,c}]}
let silentJumpFirstAt = null;      // 本次服务运行以来第一次换人的时刻

/** "from|to" —— 用 | 而不是 :，渠道键里不含分隔符，键不会被歧义解析。 */
const pairKey = (from, to) => `${from}|${to}`;

/**
 * 记一次「入口渠道 → 实际服务的渠道」的换人。
 *
 * @param from  用户/客户端连的那个渠道（入口）
 * @param tries attemptWithFailover 的尝试表：{provider, ok} / {provider, skipped}
 * @param model 实际发出去的那个模型名（可空）。面板靠它说清「钱花到哪个模型上了」。
 * @param now   测试可注入假时刻；产品代码不传（不传就是 Date.now()）。
 * @returns 记下了就返回 {from,to}，没换人就返回 null。
 */
export function noteSilentJump(from, tries, model, costs, now) {
  if (!from || !Array.isArray(tries)) return null;
  /* 「实际服务的」= tries 里第一个 ok 且**不是入口本身**的那家。
     · 全部 ok:false（最后那句 502）⇒ 没有人服务过，不记 —— 记下来会变成
       「实际回答你的是 X」而事实上没人回答，是编造。
     · ok 的就是入口 ⇒ 没换人，不记。
     · 入口被跳过（额度冷却中）、下一家接上 ⇒ from≠to，如实记，这正是用户体感到的。 */
  const served = tries.find((t) => t && t.ok === true && t.provider && t.provider !== from);
  if (!served) return null;

  const at = typeof now === "number" ? now : Date.now();
  const m = Math.floor(at / 60000);
  const key = pairKey(from, served.provider);
  let rec = silentJumpPairs.get(key);
  if (!rec) {
    /* 兜底上界：真到这一格说明 from/to 超出了渠道集合，宁可淘汰最久没动静的一条，
       也不能让 Map 随流量长大。 */
    if (silentJumpPairs.size >= SILENT_JUMP_MAX_PAIRS) {
      let oldestKey = null, oldestAt = Infinity;
      for (const [k, v] of silentJumpPairs) {
        if (v.lastAt < oldestAt) { oldestAt = v.lastAt; oldestKey = k; }
      }
      if (oldestKey != null) silentJumpPairs.delete(oldestKey);
    }
    rec = { from, to: served.provider, total: 0, lastAt: at, model: model || null, minutes: [], costs: costs ?? null };
    silentJumpPairs.set(key, rec);
  }
  rec.total++;
  rec.lastAt = at;
  if (model) rec.model = model;
  /* costs 由调用方按**那个模型自己的 credits** 算好（true=计费 / false=免费 / null=查不到）。
     查不到就保持 null，面板据此**不下结论**——把「不知道」说成「在扣你钱」是误报，
     比不提示更坏。 */
  if (costs != null) rec.costs = costs;
  /* 分钟桶：同一分钟内只加计数；跨分钟则头插一条并把超窗的丢掉。 */
  const head = rec.minutes[0];
  if (head && head.m === m) head.c++;
  else { rec.minutes.unshift({ m, c: 1 }); if (rec.minutes.length > SILENT_JUMP_WINDOW_MIN) rec.minutes.length = SILENT_JUMP_WINDOW_MIN; }

  /* 明细里的 at 存成 ISO 字符串，与 active[].lastAt 同一个形状 —— 面板只认一种，
     混着放的话那个 Date.parse(x.at) 在真跑起来时会静悄悄变 NaN，渲染成「NaN 分钟前」。 */
  silentJumpLog.unshift({ at: new Date(at).toISOString(), from, to: served.provider, model: model || null });
  if (silentJumpLog.length > SILENT_JUMP_LOG) silentJumpLog.length = SILENT_JUMP_LOG;
  if (silentJumpFirstAt == null) silentJumpFirstAt = at;
  return { from, to: served.provider };
}

/** 最近 N 分钟内这一对渠道换了几次（桶环上求和；超窗的桶顺手丢掉，保持结构定长）。 */
function countInWindow(rec, windowMin, nowMin) {
  let n = 0;
  const keep = [];
  for (const b of rec.minutes) {
    if (b.m > nowMin - windowMin) { n += b.c; keep.push(b); }
  }
  if (keep.length !== rec.minutes.length) rec.minutes = keep;
  return n;
}

/**
 * 给 /api/status 用的快照。面板只读这三个字段：
 *   total  本次服务运行以来累计换了几次（null 表示一次都没有）
 *   active [{from,to,count,total,lastAt,model}] —— 只含「入口 ≠ 实际服务」的组合
 *   recent [{at,from,to,model}] —— 最近几条时间线
 *
 * @param now 测试可注入假时刻；产品代码不传。
 */
export function silentJumpSnapshot(now) {
  const at = typeof now === "number" ? now : Date.now();
  const nowMin = Math.floor(at / 60000);
  if (!silentJumpLog.length && silentJumpPairs.size === 0) {
    return { total: 0, firstAt: null, lastAt: null, active: [], recent: [], kept: 0, windowMin: SILENT_JUMP_WINDOW_MIN };
  }
  const active = [];
  for (const rec of silentJumpPairs.values()) {
    const count = countInWindow(rec, SILENT_JUMP_WINDOW_MIN, nowMin);
    /* 这一对的最后一次已经超出整段窗口 ⇒ 不再出现在「当前」面板里（它是历史，
       不是现状）。条目本身不删：留着才不会因为翻一次窗口就丢历史计数。 */
    if (rec.lastAt <= nowMin * 60000 - SILENT_JUMP_WINDOW_MIN * 60000) continue;
    active.push({
      from: rec.from, to: rec.to,
      count,                                   // 最近 windowMin 分钟
      total: rec.total,                         // 累计
      lastAt: new Date(rec.lastAt).toISOString(),
      model: rec.model || null,
      /* true=那个模型计费 / false=免费 / null=查不到（面板据此不说扣钱）。 */
      costs: rec.costs === true ? true : rec.costs === false ? false : null,
    });
  }
  /* 排在前面的先看：窗口内次数多的，其次是最近发生的。 */
  active.sort((a, b) => (b.count - a.count) || (Date.parse(b.lastAt) - Date.parse(a.lastAt)));
  return {
    /* total 是「各组合累计之和」，不是明细环的长度 —— 明细环会淘汰老条目，
       拿它的长度当累计，用户看到的数字会莫名其妙地掉回去。 */
    total: [...silentJumpPairs.values()].reduce((n, r) => n + r.total, 0),
    firstAt: silentJumpFirstAt ? new Date(silentJumpFirstAt).toISOString() : null,
    lastAt: silentJumpLog.length ? silentJumpLog[0].at : null,
    active,
    recent: silentJumpLog.slice(0, 8),
    /* kept = 明细环里**此刻**还留着的条数（不是 recent 那个上限 8）。
       给「有界」这件事一个可观测的口：面板排查时能一眼看出缓冲区有没有在涨，
       测试也才能真的验到「淘汰生效」而不是只验到「展示时被截断了」。 */
    kept: silentJumpLog.length,
    windowMin: SILENT_JUMP_WINDOW_MIN,
  };
}

/** 只给测试用：把留痕清空。产品代码没有理由调用它。 */
export function _resetSilentJumpForTest() {
  silentJumpLog.length = 0;
  silentJumpPairs.clear();
  silentJumpFirstAt = null;
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