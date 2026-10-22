/* panel-kit.js —— 面板共享组件库：状态徽章 / 量条 / 顶部横条 / 渠道热力图。
 *
 * ── 补的是哪个洞 ──
 *   改版前每张卡自己写 HTML：同一个「冷却中」在四张卡里四种措辞四种颜色，
 *   「没配上」有的写「未配置」有的写「没配好」。用户得自己在脑子里翻译；
 *   改一次配色要改四个文件，漏一个就漂，而且漂了没人发现。
 *   本文件把「状态 → 措辞 → 颜色」收成**一处**，卡片只负责取数据、传参。
 *
 * ── 为什么色只能用语义类名 ──
 *   深浅两套主题的颜色都由 CSS 变量定义（--ok / --warn / --err / --idle / --brand）。
 *   组件里写死一个十六进制色值，就等于把这套组件钉在深色主题上：浅色主题下
 *   同一个色值的对比度会掉到 4.5:1 以下，而「两套主题都得能读」正是改版的验收标准。
 *   所以颜色只经**类名**给（ok / warn / err / idle / brand），由 CSS 去 var() 取值。
 *   组件里出现任何写死的颜色 = 这条纪律破了（改版原则：不引入新配色）。
 *
 * ── 为什么状态措辞要集中一处 ──
 *   改版原则 1 是「状态是数据，不是装饰」：同一个渠道在任何地方都显示同一个状态。
 *   措辞一旦散在卡片里，就一定会出现「冷却中」与「冷却中（还差 30 秒）」并存 ——
 *   用户会以为那是两回事，其实只是两处措辞没对齐。
 *   「哪种状态配哪种颜色」同样是数据：把「探不到」画成红色，用户会以为账号被封了，
 *   真相可能只是这条网络不通 —— 「探不到」与「坏了」必须分开。
 *   所以六种状态的中文措辞与语义色**只在本文件定义一次**，卡片不许自己写。
 *
 * ── 入参形状（每个组件都返回 HTML 字符串；不碰 DOM、不读全局、不发请求）──
 *   esc(s)                       -> 转义后的字符串（& < > " '）
 *   stateBadge(state, text, opts)
 *     state  六态之一：'ok' | 'cooling' | 'resting' | 'exhausted' | 'unconfigured' | 'unknown'
 *            （不认识的一律当 unknown 处理，宁可说「不明」也不说错）
 *     text   可选，覆盖默认措辞；null / 空串 ⇒ 用本文件里的措辞
 *     opts   { tone?, title?, className?, dot? }；tone ∈ ok | warn | err | idle | brand
 *   meter(ratio, opts)
 *     ratio  0..opts.max 的比例（opts.max 默认 1，即 0..1）；null / 非数 ⇒ 画成「—」
 *     opts   { max?=1, warn?=0.75, err?=0.9, showPct?=true, label?, title?, className? }
 *   statusStrip(data)
 *     data   { service?, current?, traffic?, usage?, quota? }
 *            每格 { tone, text, sub?, label? }；tone ∈ ok | warn | err | idle | brand
 *   heatmap(channels, opts)
 *     channels  [{ key, name, state, reason, busy, used, limit, ratio, detail }]
 *     opts      { empty?, showMeter?=true, className? }
 *   emptyState(text, opts) / errorState(text, opts) / loadingState(text, opts)
 *     text     主句（说清发生了什么）
 *     opts     { hint?, detail?, className? }
 *              hint = **下一步**（错误态必给：一句「加载失败」是猜谜）
 *              detail = 补充（原始报错、trace id 之类；给用户看的是「怎么办」，
 *              原始报错进这里，别把技术黑话当主句）
 *
 * ── CSS 契约（.bkit-* 由渲染层补；颜色一律 var(--*)，不许写死）──
 *   .bkit-badge .bkit-meter .bkit-meter-track .bkit-meter-fill{ok,warn,err,idle}
 *   .bkit-meter-pct .bkit-meter-label .bkit-strip .bkit-strip-cell .bkit-strip-cap
 *   .bkit-strip-val .bkit-strip-sub .bkit-heat .bkit-heat-cell .bkit-heat-top
 *   .bkit-heat-name .bkit-heat-meter .bkit-heat-meta .bkit-heat-empty
 *   色点与徽章复用现成的 .led / .pill + 语义类（.led.ok、.pill.warn 等）——
 *   这两套在深浅两套主题里都验过，不重造第三套。
 */
(function (global) {
  "use strict";

  /* ── 状态的唯一真相：措辞、含义提示、语义色都在这里 ──
     别处再写一份就是漂移的开始（改版问题 4：同一个信息四种样子）。 */
  const STATE_TEXT = {
    ok: "可用",
    cooling: "冷却中",
    resting: "休息中",
    exhausted: "预算用完",
    unconfigured: "未配置",
    unknown: "状态不明",
  };
  const STATE_HINT = {
    ok: "一切正常",
    cooling: "等一会儿就好",
    resting: "额度、预算或令牌出了问题",
    exhausted: "这一家的额度已经见底",
    unconfigured: "缺凭据，或者还没登录",
    unknown: "探不到，不代表坏了",
  };
  const STATE_TONE = {
    ok: "ok",
    cooling: "warn",
    resting: "warn",
    exhausted: "err",
    unconfigured: "idle",
    unknown: "idle",
  };
  const STATES = ["ok", "cooling", "resting", "exhausted", "unconfigured", "unknown"];
  const TONES = ["ok", "warn", "err", "idle", "brand"];

  /* 面板要显示上游返回的字符串（含渠道名、错误原因、令牌指纹前缀）。
     不转义就等于把上游的原文当 HTML 解析 —— 上游一句话就能在面板里执行脚本。 */
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isTone = (t) => TONES.indexOf(t) >= 0;
  const toneOf = (state) => (own(STATE_TONE, state) ? STATE_TONE[state] : "idle");
  const textOf = (state) => (own(STATE_TEXT, state) ? STATE_TEXT[state] : STATE_TEXT.unknown);
  const hintOf = (state) => (own(STATE_HINT, state) ? STATE_HINT[state] : STATE_HINT.unknown);

  /* 比例要区分「没有」与「是 0」：0% 是真的用光了，null 是压根没这项数据。
     混起来会让人以为额度归零（真出事）而不是没读到（假出事）。 */
  const ratioOf = (v) => {
    if (v == null || v === "" || v === true || v === false) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  /* 状态徽章：一个色点 + 一句话。
     颜色只从语义类名来（.led ok / .pill ok），不写死色值 —— 否则只有一套主题能用。 */
  function stateBadge(state, text, opts) {
    const o = opts || {};
    const tone = isTone(o.tone) ? o.tone : toneOf(state);
    const label = (text == null || text === "") ? textOf(state) : String(text);
    const tip = (o.title == null || o.title === "") ? hintOf(state) : String(o.title);
    const cls = "bkit-badge pill " + tone + (o.className ? " " + String(o.className) : "");
    const dot = o.dot === false ? "" : "<i class=\"led " + tone + "\"></i>";
    return "<span class=\"" + esc(cls) + "\""
      + (tip ? " title=\"" + esc(tip) + "\"" : "") + ">" + dot + esc(label) + "</span>";
  }

  /* 小量条：百分比 + 阈值着色。
     阈值之上先转黄再转红 —— 一眼能看出「快满了」而不是「满了才知道」。 */
  function meter(ratio, opts) {
    const o = opts || {};
    const rawMax = ratioOf(o.max);
    const max = rawMax == null || rawMax <= 0 ? 1 : rawMax;
    const r = ratioOf(ratio);
    const known = r != null;
    const frac = known ? Math.min(1, Math.max(0, r / max)) : 0;
    const pct = Math.round(frac * 100);
    const rawErr = ratioOf(o.err);
    const rawWarn = ratioOf(o.warn);
    const errAt = rawErr == null ? 0.9 : rawErr;
    const warnAt = rawWarn == null ? 0.75 : rawWarn;
    const tone = isTone(o.tone) ? o.tone
      : (known ? (frac >= errAt ? "err" : frac >= warnAt ? "warn" : "ok") : "idle");
    const tip = (o.title == null || o.title === "") ? (known ? pct + "%" : "") : String(o.title);
    const cls = "bkit-meter" + (o.className ? " " + String(o.className) : "");
    const label = o.label ? "<span class=\"bkit-meter-label\">" + esc(o.label) + "</span>" : "";
    const pctHtml = o.showPct === false ? ""
      : "<span class=\"bkit-meter-pct\">" + (known ? pct + "%" : "—") + "</span>";
    /* inline style 里只放宽度（几何），颜色一律走类名：
       写死颜色就等于只有一套主题能用，深浅切换时这条会露馅。 */
    const fill = "<i class=\"bkit-meter-fill " + tone + "\" style=\"width:" + (known ? pct : 0) + "%\"></i>";
    return "<span class=\"" + esc(cls) + "\""
      + (tip ? " title=\"" + esc(tip) + "\"" : "") + ">"
      + label + "<span class=\"bkit-meter-track\">" + fill + "</span>" + pctHtml + "</span>";
  }

  /* 顶部横条的五格：服务 / 当前接的 / 流量 / 用量 / 额度。
     格名写死在这里（组件的职责），格里的文字与颜色由调用方传进来。 */
  const STRIP_CELLS = [
    ["service", "服务"],
    ["current", "当前接的"],
    ["traffic", "流量"],
    ["usage", "用量"],
    ["quota", "额度"],
  ];

  function statusStrip(data) {
    const d = data && typeof data === "object" ? data : {};
    const cells = STRIP_CELLS.map((pair) => {
      const key = pair[0];
      const defLabel = pair[1];
      const c = (d[key] && typeof d[key] === "object") ? d[key] : {};
      const tone = isTone(c.tone) ? c.tone : "idle";
      const label = (c.label == null || c.label === "") ? defLabel : String(c.label);
      const val = (c.text == null || c.text === "") ? "—" : String(c.text);
      const sub = (c.sub == null || c.sub === "") ? "" : String(c.sub);
      return "<div class=\"bkit-strip-cell\">"
        + "<span class=\"bkit-strip-cap\">" + esc(label) + "</span>"
        + "<span class=\"bkit-strip-val\"><i class=\"led " + tone + "\"></i>" + esc(val) + "</span>"
        + (sub ? "<span class=\"bkit-strip-sub\">" + esc(sub) + "</span>" : "")
        + "</div>";
    }).join("");
    return "<div class=\"bkit-strip\">" + cells + "</div>";
  }

  /* 渠道热力图：一家一格。
     格子只回答「这家现在什么情况」，不回答「为什么」——为什么放 title 与详情行。 */
  function heatmap(channels, opts) {
    const o = opts || {};
    const list = Array.isArray(channels) ? channels : [];
    if (!list.length) {
      return "<div class=\"bkit-heat bkit-heat-empty\">" + esc(o.empty || "没有渠道信息") + "</div>";
    }
    const cells = list.map((raw) => {
      const c = (raw && typeof raw === "object") ? raw : {};
      const key = c.key == null ? "" : String(c.key);
      const name = (c.name == null || c.name === "") ? key : String(c.name);
      const state = c.state == null ? "unknown" : String(c.state);
      const reason = c.reason == null ? "" : String(c.reason);
      const detail = c.detail == null ? "" : String(c.detail);
      const tip = [reason, detail].filter(Boolean).join(" · ");
      const busy = ratioOf(c.busy);
      const used = ratioOf(c.used);
      const limit = ratioOf(c.limit);
      const ratio = ratioOf(c.ratio);
      let meterHtml = "";
      if (o.showMeter !== false) {
        if (ratio != null) {
          /* ⚠ **ratio 的口径是百分比（0–100）** —— 与本仓既有的一致
           *   （routes.mjs 的 Seat.used、quota.mjs 与 channel-state.mjs 的 ratio
           *   都是 0–100）。量条内部按分数（0–1）算，所以这里要除 100。
           *   当成 0–1 的分数会让「10%」显示成「1000%」→ 满格红色。 */
          meterHtml = meter(ratio / 100, { max: 1, title: (used != null && limit != null) ? used + " / " + limit : "" });
        } else if (used != null && limit != null && limit > 0) {
          meterHtml = meter(used / limit, { max: 1, title: used + " / " + limit });
        }
      }
      const bits = [];
      if (busy != null && busy > 0) bits.push("在途 " + busy);
      if (used != null && limit != null && limit > 0) bits.push(Math.round(used) + " / " + Math.round(limit));
      else if (used != null) bits.push("已用 " + Math.round(used));
      return "<div class=\"bkit-heat-cell\" data-channel=\"" + esc(key) + "\""
        + (tip ? " title=\"" + esc(tip) + "\"" : "") + ">"
        + "<div class=\"bkit-heat-top\"><span class=\"bkit-heat-name\">" + esc(name) + "</span>"
        + stateBadge(state, null, { title: reason }) + "</div>"
        + (meterHtml ? "<div class=\"bkit-heat-meter\">" + meterHtml + "</div>" : "")
        + (bits.length ? "<div class=\"bkit-heat-meta\">" + esc(bits.join(" · ")) + "</div>" : "")
        + "</div>";
    }).join("");
    return "<div class=\"bkit-heat" + (o.className ? " " + esc(o.className) : "") + "\">" + cells + "</div>";
  }

  /* ── 三态：空 / 错 / 加载 ──────────────────────────────────────────
   *
   * 同一个意思在二十张卡里说二十种话，是「用户得自己翻译」的最大来源：
   * 「还没有记录」/「没有数据」/「空空如也」/「暂无」…… 各写一遍，
   * 用户得自己认出「这几种说法是一件事」。所以三态只在这里定义一次。
   *
   * 三态必须**分开**，不能都叫「没数据」：
   *   · 空态 —— 没有数据**不是出错**。「还没发生过」与「读不到」混成一句，
   *     用户会以为出了故障，去查一个根本没发生的事。
   *   · 错态 —— **必须带下一步**。一句「加载失败」是猜谜；
   *     「读不到：连接被拒 —— 看诊断抽屉」才是能执行的。
   *   · 加载态 —— 读屏软件要能读出来（role=status + aria-busy）。
   *
   * 颜色一律经**类名**给（idle / err / brand），由 CSS 去 var() 取值 ——
   * 写死色值就等于只支持一套主题。
   */
  function stateBlock(kind, text, opts) {
    const o = opts || {};
    const hint = o.hint == null ? "" : String(o.hint);
    const detail = o.detail == null ? "" : String(o.detail);
    const cls = "bkit-state bkit-state-" + kind + (o.className ? " " + String(o.className) : "");
    /* 图标是**装饰**：读屏软件读它只会多念一个符号，所以 aria-hidden。
       文字本身已经说清了一切。 */
    const icon = kind === "loading"
      ? '<span class="bkit-state-spin" aria-hidden="true"></span>'
      : '<span class="bkit-state-icon" aria-hidden="true">' + (kind === "error" ? "!" : "○") + "</span>";
    return '<div class="' + esc(cls) + '" role="status"' + (kind === "loading" ? ' aria-busy="true"' : "") + ">"
      + icon
      + '<div class="bkit-state-main">'
      + '<div class="bkit-state-text">' + esc(text == null ? "" : String(text)) + "</div>"
      + (hint ? '<div class="bkit-state-hint">' + esc(hint) + "</div>" : "")
      + (detail ? '<div class="bkit-state-detail">' + esc(detail) + "</div>" : "")
      + "</div></div>";
  }

  /** 空态：还没有数据。给「怎么才会出现」，别给「读不到」。 */
  function emptyState(text, opts) { return stateBlock("empty", text, opts); }

  /** 错误态：读不到 / 坏了。**必须给下一步**（opts.hint）。 */
  function errorState(text, opts) { return stateBlock("error", text, opts); }

  /** 加载态：正在读。 */
  function loadingState(text, opts) { return stateBlock("loading", text, opts); }

  global.BAI_KIT = {
    STATES: STATES,
    STATE_TEXT: STATE_TEXT,
    STATE_HINT: STATE_HINT,
    STATE_TONE: STATE_TONE,
    TONES: TONES,
    esc: esc,
    toneOf: toneOf,
    textOf: textOf,
    hintOf: hintOf,
    stateBadge: stateBadge,
    meter: meter,
    statusStrip: statusStrip,
    heatmap: heatmap,
    emptyState: emptyState,
    errorState: errorState,
    loadingState: loadingState,
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
