/* cards/audit-ledger.js —— 审计台账卡（链路上发生过什么）。
 *
 * 这张卡回答的是「**刚才到底发生了什么**」：
 *   ① 汇总：尝试数、失败数、平均耗时、p95 耗时
 *   ② 按归类分布：额度 / 限流 / 不被服务 / 认证 / 其它，各多少次
 *   ③ 按渠道：每家试了多少次、成了多少、慢了多久
 *   ④ 最近若干次尝试：时间、渠道、模型、结果、归类、耗时
 *
 * ── 它与「用量账本」不是一回事 ──
 *   用量账本记的是「**钱花到哪儿**」（token、费用、这次请求的最终结果）；
 *   审计台账记的是「**链路上发生过什么**」（每一次对外尝试，含失败的那次）。
 *   用途不同：用量账本拿去跟厂商账单对，审计台账用来复盘「昨天为什么卡」。
 *
 * ── 三条口径，别在渲染层改 ──
 *   ① **已转交（handedOn）不算失败**：那次尝试失败了，但活已经交给下一家了，
 *      它不是这条请求的结局。口径与后端 / 用量账本一致。
 *   ② **台账只在内存里，有硬上界**（后端保留最近 2000 条尝试）。
 *      所以它答的是「**最近**」，不是全量历史 —— 全量在用量账本那份 JSONL 里。
 *   ③ **空态不是报错**：没有记录只说明还没发生过调用，得说清楚，否则用户
 *      会以为台账坏了，去翻日志、去看磁盘，越查越慌。
 *
 * ── 渠道名一律不写死 ──
 *   显示名走 ctx.nameOf(key)；台账里出现清单之外的渠道时**原样显示那个 key**
 *   （编出来的名字比 key 更难查）。
 *
 * ── 刷新节奏 ──
 *   共享层每 5 秒轮询一次（panel-common.js 的 setInterval(poll, 5000) → cards.update()），
 *   本卡**不**自己另起一个定时器：两个节奏会打架（一个先到、一个后到，画面上的数会来回跳）。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["audit-ledger"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));

    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    /* ---- 容器：自建面板盒，挂在所在视图末尾 ----
     * 控制台视图没有专属插槽，所以这里自建一个盒子（与 usage-ledger 同款写法），
     * 落在视图容器末尾，不去抢别人的插槽。 */
    let box = $("auditPanel");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "auditPanel";
      box.innerHTML = `
        <div class="pb-head">
          <h3>审计台账</h3>
          <span class="sub">每一次对外尝试记一条 · 只在内存里（最近 2000 条）</span>
        </div>
        <div class="fieldset">
          <div class="rail" style="margin-bottom:0">
            <div class="rail-grid">
              <div class="gauge"><span class="cap">尝试数</span><div class="val" data-role="a-total">—</div><div class="sub" data-role="s-total"></div></div>
              <div class="gauge"><span class="cap">失败数</span><div class="val"><span class="led idle" data-role="l-fail"></span><span data-role="a-fail">—</span></div><div class="sub" data-role="s-fail"></div></div>
              <div class="gauge"><span class="cap">平均耗时</span><div class="val" data-role="a-avg">—</div><div class="sub"></div></div>
              <div class="gauge"><span class="cap">p95 耗时</span><div class="val" data-role="a-p95">—</div><div class="sub" data-role="s-p95"></div></div>
            </div>
          </div>
          <div data-role="a-note"></div>
          <div data-role="a-body"></div>
          <div class="result" data-role="a-result"></div>
        </div>`;
      const viewRoot = (slot.closest && slot.closest(".view")) || slot;
      viewRoot.appendChild(box);
    }
    const q = (sel) => box.querySelector(sel);

    /* 三态（空 / 错 / 加载）统一走共享组件：措辞与结构只在 panel-kit.js 定义一次。
       组件库不在时降级成一句提示 —— 整块空白比降级更坏。 */
    const kit = window.BAI_KIT || null;
    const S3 = (kind, text, opts) => (kit
      ? kit[kind](text, opts)
      : '<div class="hint">' + esc(text) + "</div>");

    const RECENT_MAX = 30;     // 最近尝试最多列这么多条
    const KIND_MAX = 8;        // 按归类最多列这么多行
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const int = (v) => num(v).toLocaleString("zh-CN");

    let data = null;      // 最近一次成功读到的 /api/audit
    let lasterr = "";     // 最近一次读失败的原因
    let inflight = false;
    let loaded = false;   // 至少成功读过一回（没读过 ≠ 没有记录）
    let sig = "";         // 上一次画过的数据签名（数据没变就不重画表）

    /* 清单里认识的渠道 → 显示名；不认识的原样显示 key。 */
    const known = (k) => (ctx.channels || []).indexOf(k) >= 0;
    const nameOfKey = (k) => {
      const s = String(k == null ? "" : k);
      if (!s) return "—";
      return known(s) ? ctx.nameOf(s) : s;
    };

    function fmtTime(t) {
      if (!t) return "—";
      const d = new Date(t);
      if (!Number.isFinite(d.getTime())) return "—";
      return d.toLocaleTimeString("zh-CN", { hour12: false });
    }

    function fmtDur(ms) {
      const n = num(ms);
      if (!n) return "—";
      return n >= 1000 ? (n / 1000).toFixed(2) + "s" : Math.round(n) + "ms";
    }

    /* 结果：已转交（黄）单独一种，不并进失败；其余按 HTTP 码分四态。 */
    function statusOf(r) {
      if (r && r.handedOn) return { cls: "warn", txt: "已转交" };
      const s = num(r && r.status);
      if (r && r.outcome === "ok") return { cls: "ok", txt: s ? String(s) : "成功" };
      if (!s) return { cls: "err", txt: "网络错" };
      if (s >= 200 && s < 300) return { cls: "ok", txt: String(s) };
      if (s >= 400) return { cls: "err", txt: String(s) };
      return { cls: "warn", txt: String(s) };
    }

    function renderTotals() {
      const s = (data && data.summary) || {};
      const set = (role, v) => { const el = q(`[data-role="${role}"]`); if (el) el.textContent = v; };

      const total = num(s.total);
      const failed = num(s.failed);
      set("a-total", int(total));
      set("a-fail", int(failed));
      set("a-avg", fmtDur(s.avgMs));
      set("a-p95", fmtDur(s.p95Ms));

      const led = q('[data-role="l-fail"]');
      if (led) led.className = "led " + (!total ? "idle" : failed > 0 ? "err" : "ok");

      const st = q('[data-role="s-total"]');
      if (st) st.textContent = "含失败的那次尝试";
      const sf = q('[data-role="s-fail"]');
      if (sf) sf.textContent = "转交下一候选的尝试不计失败";
      const sp = q('[data-role="s-p95"]');
      if (sp) sp.textContent = "最慢 " + fmtDur(s.maxMs);
    }

    function renderBody() {
      const body = q('[data-role="a-body"]');
      if (!body) return;
      if (!loaded && !lasterr) {
        /* 第一次读还没回来：先说「在读」，别拿空态冒充「没有记录」。 */
        body.innerHTML = S3("loadingState", "正在读审计台账…", { hint: "读完这一块就能看到链路上发生过什么。" });
        return;
      }
      const recs = Array.isArray(data && data.records) ? data.records : [];
      const s = (data && data.summary) || {};
      const kinds = Array.isArray(s.byKind) ? s.byKind : [];
      const provs = Array.isArray(s.byProvider) ? s.byProvider : [];

      if (!recs.length && !num(s.total)) {
        /* 空态：**没有记录 ≠ 出错**。这句话必须写清楚——空态被当成报错，用户会
         * 以为台账坏了，去翻日志、去看磁盘，越查越慌。
         * 空态还要说清「怎么才会出现」：不然用户不知道要等什么。 */
        body.innerHTML = S3("emptyState", "还没有审计记录", {
          hint: "台账是在第一次真实调用之后才开始记的 —— 每一次对外尝试（包括失败的那次）会逐行出现在这里：时间、渠道、模型、结果、归类、耗时。",
        });
        return;
      }

      const kindRows = kinds.slice(0, KIND_MAX).map((k) => `<tr>
          <td><span class="mono">${esc(String((k && k.name) || ""))}</span></td>
          <td class="dim">${esc(int(k && k.total))}</td>
          <td class="dim">${esc(int(k && k.failed))}</td>
          <td class="dim">${esc(fmtDur(k && k.avgMs))}</td>
        </tr>`).join("");

      const provRows = provs.map((p) => `<tr>
          <td>${esc(nameOfKey(p && p.name))}</td>
          <td class="dim">${esc(int(p && p.total))}</td>
          <td class="dim">${esc(int(p && p.failed))}</td>
          <td class="dim">${esc(fmtDur(p && p.avgMs))}</td>
        </tr>`).join("");

      const recent = recs.slice(0, RECENT_MAX);
      const recentRows = recent.map((r) => {
        const st = statusOf(r);
        const err = String((r && r.error) || "");
        const tip = [
          err ? "错误：" + err : "",
          r && r.kind ? "归类：" + String(r.kind) : "",
          r && r.agent ? "发起方：" + String(r.agent) : "",
          r && r.session ? "会话：" + String(r.session) : "",
        ].filter(Boolean).join(" · ");
        return `<tr>
            <td class="dim">${esc(fmtTime(r && r.ts))}</td>
            <td>${esc(nameOfKey(r && r.provider))}</td>
            <td><span class="mono">${esc(String((r && r.model) || "—"))}</span></td>
            <td${tip ? ` title="${esc(tip)}"` : ""}><span class="led ${st.cls}"></span> ${esc(st.txt)}</td>
            <td><span class="mono">${esc(String((r && r.kind) || ""))}</span></td>
            <td class="dim">${esc(fmtDur(r && r.ms))}</td>
          </tr>`;
      }).join("");

      body.innerHTML = `
        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:13px">按归类</h2>
          <span class="note">失败被归成了什么 —— 这一栏最说明问题</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr><th style="width:40%">归类</th><th style="width:20%">次数</th><th style="width:20%">失败</th><th style="width:20%">平均耗时</th></tr></thead>
          <tbody>${kindRows || `<tr><td colspan="4" class="dim">还没有记录</td></tr>`}</tbody>
        </table>

        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:13px">按渠道</h2>
          <span class="note">谁在扛请求、谁在拖后腿</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr><th style="width:40%">渠道</th><th style="width:20%">次数</th><th style="width:20%">失败</th><th style="width:20%">平均耗时</th></tr></thead>
          <tbody>${provRows || `<tr><td colspan="4" class="dim">还没有记录</td></tr>`}</tbody>
        </table>

        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:13px">最近尝试</h2>
          <span class="note">最新 ${Math.min(recent.length, RECENT_MAX)} 条</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr>
            <th style="width:11%">时间</th>
            <th style="width:14%">渠道</th>
            <th style="width:24%">模型</th>
            <th style="width:12%">结果</th>
            <th style="width:19%">归类</th>
            <th style="width:20%">耗时</th>
          </tr></thead>
          <tbody>${recentRows || `<tr><td colspan="6" class="dim">还没有记录</td></tr>`}</tbody>
        </table>`;
    }

    function render() {
      const note = q('[data-role="a-note"]');
      const result = q('[data-role="a-result"]');
      if (lasterr) {
        /* 读不到而且手上**没有**旧数据 ⇒ 整块换成错误态（必须带下一步）。
           有旧数据时保留旧数据 + 一行说明 —— 记录旧一天比清空好。 */
        if (!data) {
          if (note) note.innerHTML = "";
          const body = q('[data-role="a-body"]');
          if (body) {
            body.innerHTML = S3("errorState", "读不到审计台账", {
              hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
              detail: lasterr,
            });
          }
          renderTotals();
          return;
        }
        if (note) note.innerHTML = `<div class="hint" style="margin-top:12px">上一次刷新失败：${esc(lasterr)}（下面显示的是上一次读到的结果）</div>`;
        if (result) result.textContent = "";
        renderTotals();
        renderBody();
        return;
      }
      if (note) note.innerHTML = "";
      const s = (data && data.summary) || {};
      if (result) {
        const since = num(s.since);
        result.textContent = since
          ? `记录时段：${new Date(since).toLocaleString("zh-CN")} 起 · 共 ${int(s.total)} 次尝试`
          : "";
      }
      renderTotals();
      renderBody();
    }

    /* 数据签名：只画给用户看的那些字段变了才重画表（每 5 秒一次轮询，
     * 不看签名的话每次都重建整张表 DOM，滚动位置会跳）。
     * ⚠ 签名里必须带上「读失败的原因」：否则失败那一轮签名不变，
     *   错误态就永远画不出来。 */
    function signature() {
      if (!data) return "!" + lasterr;
      const recs = Array.isArray(data.records) ? data.records : [];
      return JSON.stringify([
        (data.summary || {}).total, (data.summary || {}).failed,
        (data.summary || {}).avgMs, (data.summary || {}).p95Ms,
        recs.length ? [recs[0].ts, recs[0].provider, recs[0].model, recs[0].outcome, recs[0].kind, recs[0].ms] : null,
      ]) + "|" + lasterr;
    }

    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await ctx.api("/api/audit?limit=50");
        if (r && r.ok === false) throw new Error(r.error || "审计台账读取失败");
        data = r || null;
        lasterr = "";
      } catch (e) {
        lasterr = String((e && e.message) || e);
      } finally {
        inflight = false;
        loaded = true;
        /* ⚠ 读完就重画：不重画的话这一块会**停在「正在读」**直到下一轮 5 秒轮询
           （load() 里 `if (inflight) return;` 不会等这次读，update() 也等不到它）。 */
        render();
      }
    }

    /* 首屏先画「在读」并把第一次读发出去：否则这 5 秒里这一块是空白，
       空白既不是「在读」也不是「没有记录」，用户只能猜。 */
    render();
    load();

    return {
      async update() {
        await load();
        const s = signature();
        if (s !== sig) { sig = s; render(); }
        else renderTotals();
      },
      refresh() { return load(); },
    };
  },
};
