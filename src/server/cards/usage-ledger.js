/* cards/usage-ledger.js —— 用量账本卡（每一次调用记一行）。
 *
 * 这张卡回答的是「钱花到哪儿去了」：
 *   ① 汇总：请求数、失败数、输入/输出 token、缓存读写、费用
 *   ② 按渠道、按模型两张小表
 *   ③ 最近若干条请求：时间、渠道、模型、状态、耗时、token、重试次数
 *
 * ── 账本的三条语义，本卡必须照着说，否则账会对不上 ──
 *   ① **req 与 served 是两件事**：客户端问的模型（req）常常不等于厂商实际答的
 *      （served）。所以模型列在两者不同时把 served 也摆出来（`问的 → 答的`）。
 *   ② **handed_on 不算失败**：一次请求在网关内部试了多个候选，某个 try 失败后被
 *      转交给下一个候选时，它仍写自己的记录（可能已经被厂商计费了），但**不是这次
 *      请求的结果**。所以「已转交」单独一种状态（黄），不并进失败数。
 *   ③ **失败数只数真失败**：与后端口径一致（status ≥ 400 且不是 handed_on）。
 *
 * ── 渠道名一律不写死 ──
 * 渠道显示名走 ctx.nameOf(key)；账本里出现清单之外的渠道时**原样显示那个 key**，
 * 不替它编名字（编出来的名字比 key 更难查）。
 *
 * ── 刷新节奏 ──
 * 共享层每 5 秒轮询一次（panel-common.js 的 setInterval(poll, 5000) → cards.update()），
 * 本卡**不**自己另起一个定时器：两个节奏会打架（一个先到、一个后到，画面上的数会来回跳）。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["usage-ledger"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));

    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    /* ---- 容器：自建面板盒，挂在所在视图末尾 ----
     * 控制台视图没有专属插槽（cards 里只有 oc-transport 用的是自建盒子的写法），
     * 所以这里同样自建一个盒子，落在视图容器末尾，不去抢别人的插槽。 */
    let box = $("ulPanel");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "ulPanel";
      box.innerHTML = `
        <div class="pb-head">
          <h3>用量账本</h3>
          <span class="sub">每一次调用记一行 · 每 5 秒刷新一次</span>
        </div>
        <div class="fieldset">
          <div class="rail" style="margin-bottom:0">
            <div class="rail-grid">
              <div class="gauge"><span class="cap">请求数</span><div class="val" data-role="t-req">—</div><div class="sub" data-role="s-req"></div></div>
              <div class="gauge"><span class="cap">失败数</span><div class="val"><span class="led idle" data-role="l-fail"></span><span data-role="t-fail">—</span></div><div class="sub" data-role="s-fail"></div></div>
              <div class="gauge"><span class="cap">输入 token</span><div class="val" data-role="t-in">—</div><div class="sub"></div></div>
              <div class="gauge"><span class="cap">输出 token</span><div class="val" data-role="t-out">—</div><div class="sub"></div></div>
              <div class="gauge"><span class="cap">缓存读</span><div class="val" data-role="t-cr">—</div><div class="sub"></div></div>
              <div class="gauge"><span class="cap">缓存写</span><div class="val" data-role="t-cw">—</div><div class="sub"></div></div>
              <div class="gauge"><span class="cap">费用</span><div class="val" data-role="t-cost">—</div><div class="sub" data-role="s-cost"></div></div>
            </div>
          </div>
          <div data-role="ul-note"></div>
          <div data-role="ul-body"></div>
          <div class="result" data-role="ul-result"></div>
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

    const RECENT_MAX = 30;     // 最近请求最多列这么多条
    const MODEL_MAX = 15;      // 按模型最多列这么多行（后端已经截到 30，这里再收一档）
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const int = (v) => num(v).toLocaleString("zh-CN");

    let data = null;      // 最近一次成功读到的 /api/usage
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

    /* 状态：已转交（黄）单独一种，不并进失败；其余按 HTTP 码分四态。 */
    function statusOf(r) {
      if (r && r.handedOn) return { cls: "warn", txt: "已转交" };
      const s = num(r && r.status);
      if (!s) return { cls: "idle", txt: "—" };
      if (s >= 200 && s < 300) return { cls: "ok", txt: String(s) };
      if (s >= 400) return { cls: "err", txt: String(s) };
      return { cls: "warn", txt: String(s) };
    }

    function renderTotals() {
      const d = data || {};
      const t = d.totals || {};
      const set = (role, v) => { const el = q(`[data-role="${role}"]`); if (el) el.textContent = v; };

      const req = num(t.requests);
      const failed = num(t.failed);
      set("t-req", int(req));
      set("t-fail", int(failed));
      set("t-in", int(t.tokensIn));
      set("t-out", int(t.tokensOut));
      set("t-cr", int(t.cacheRead));
      set("t-cw", int(t.cacheWrite));

      const led = q('[data-role="l-fail"]');
      if (led) led.className = "led " + (!req ? "idle" : failed > 0 ? "err" : "ok");

      /* 副行说清失败数的口径：转交的尝试不算失败（否则用户会以为少算了）。 */
      const sf = q('[data-role="s-fail"]');
      if (sf) sf.textContent = "转交下一候选的尝试不计失败";

      /* 费用：服务端现在**会算**了（pricing.mjs）。
       * ⚠ 算不出来时是 null（不是 0）—— 一个错数字比没有数字更坏，用户要拿它对账。
       *   所以「估不出」要说清是**哪些模型**估不出，而不是笼统一句「未统计」。 */
      const cost = t.cost == null ? null : Number(t.cost);
      const hasCost = cost != null && Number.isFinite(cost);
      set("t-cost", hasCost ? cost.toFixed(4) : "—");
      const sc = q('[data-role="s-cost"]');
      if (sc) {
        const unknown = Array.isArray(t.unknownModels) ? t.unknownModels : [];
        if (hasCost && !unknown.length) sc.textContent = t.pricedAt ? `单价表快照 ${t.pricedAt}` : "";
        else if (hasCost) sc.textContent = `${unknown.length} 个模型估不出（未计入）`;
        else sc.textContent = unknown.length ? `${unknown.length} 个模型估不出` : "价格表里没有这些模型";
      }
      const sr = q('[data-role="s-req"]');
      if (sr) sr.textContent = "";
    }

    function renderBody() {
      const body = q('[data-role="ul-body"]');
      if (!body) return;
      if (!loaded && !lasterr) {
        /* 第一次读还没回来：先说「在读」，别拿空态冒充「没有记录」。 */
        body.innerHTML = S3("loadingState", "正在读用量账本…", { hint: "读完这一块就能看到钱花到哪儿去了。" });
        return;
      }
      const d = data || {};
      const recs = Array.isArray(d.rows) ? d.rows : [];
      const provs = Array.isArray(d.byProvider) ? d.byProvider : [];
      const models = Array.isArray(d.byModel) ? d.byModel : [];
      const total = num((d.totals || {}).requests);

      if (!total && !recs.length && !provs.length) {
        /* 空态：**没有记录 ≠ 出错**。这句话必须写清楚——空态被当成报错，用户会
         * 以为账本坏了，去翻日志、去看磁盘，越查越慌。
         * 空态还要说清「怎么才会出现」：不然用户不知道要等什么。 */
        body.innerHTML = S3("emptyState", "还没有用量记录", {
          hint: "账本是在第一次真实调用之后才开始记的 —— 等客户端跑一轮对话，这里就会逐行出现（时间、渠道、模型、状态、耗时、token、重试次数）。",
        });
        return;
      }

      const provRows = provs.map((p) => `<tr>
          <td>${esc(nameOfKey(p && p.key))}</td>
          <td class="dim">${esc(int(p && p.requests))}</td>
          <td class="dim">${esc(int(p && p.tokens))}</td>
        </tr>`).join("");

      const shownModels = models.slice(0, MODEL_MAX);
      const modelRows = shownModels.map((m) => `<tr>
          <td><span class="mono">${esc(String((m && m.key) || ""))}</span></td>
          <td class="dim">${esc(int(m && m.requests))}</td>
          <td class="dim">${esc(int(m && m.tokens))}</td>
        </tr>`).join("");

      const recent = recs.slice(0, RECENT_MAX);
      const recentRows = recent.map((r) => {
        const st = statusOf(r);
        const reqM = String((r && r.req) || "");
        const model = String((r && r.model) || reqM || "");
        const served = String((r && r.served) || "");
        const ms = num(r && r.ms);
        const dur = ms ? (ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : Math.round(ms) + "ms") : "—";
        const tries = num(r && r.tries);
        const tok = `${int(r && r.in)} / ${int(r && r.out)}`;
        const err = String((r && r.error) || "");
        const tip = [
          err ? "错误：" + err : "",
          r && r.ttftMs ? "首字 " + num(r.ttftMs) + "ms" : "",
          r && r.agent ? "发起方：" + String(r.agent) : "",
          r && r.kind ? "类型：" + String(r.kind) : "",
        ].filter(Boolean).join(" · ");
        return `<tr>
            <td class="dim">${esc(fmtTime(r && r.t))}</td>
            <td>${esc(nameOfKey(r && r.provider))}</td>
            <td><span class="mono">${esc(model)}</span>${served && served !== model ? `<span class="zh">→ ${esc(served)}</span>` : ""}</td>
            <td${tip ? ` title="${esc(tip)}"` : ""}><span class="led ${st.cls}"></span> ${esc(st.txt)}</td>
            <td class="dim">${esc(dur)}</td>
            <td class="dim">${esc(tok)}</td>
            <td class="dim">${tries > 1 ? esc(tries) + " 次" : "—"}</td>
          </tr>`;
      }).join("");

      body.innerHTML = `
        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:13px">按渠道</h2>
          <span class="note">请求数与 token（输入 + 输出）</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr><th style="width:48%">渠道</th><th style="width:22%">请求</th><th style="width:30%">token</th></tr></thead>
          <tbody>${provRows || `<tr><td colspan="3" class="dim">还没有记录</td></tr>`}</tbody>
        </table>

        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:13px">按模型</h2>
          <span class="note">${models.length > MODEL_MAX ? `只列前 ${MODEL_MAX} 个（共 ${models.length} 个）` : "按请求数排序"}</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr><th style="width:48%">模型</th><th style="width:22%">请求</th><th style="width:30%">token</th></tr></thead>
          <tbody>${modelRows || `<tr><td colspan="3" class="dim">还没有记录</td></tr>`}</tbody>
        </table>

        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:13px">最近请求</h2>
          <span class="note">最新 ${Math.min(recent.length, RECENT_MAX)} 条${recs.length > RECENT_MAX ? "（后端只保留最近 200 条）" : ""}</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr>
            <th style="width:11%">时间</th>
            <th style="width:14%">渠道</th>
            <th style="width:24%">模型</th>
            <th style="width:10%">状态</th>
            <th style="width:10%">耗时</th>
            <th style="width:19%">token（入/出）</th>
            <th style="width:12%">重试</th>
          </tr></thead>
          <tbody>${recentRows || `<tr><td colspan="7" class="dim">还没有记录</td></tr>`}</tbody>
        </table>`;
    }

    function render() {
      renderTotals();
      /* 数据没变就不重画表：每 5 秒整块重建一次会打断用户正在看的行、正在选的文字。 */
      const d = data || {};
      const recs = Array.isArray(d.rows) ? d.rows : [];
      const t = d.totals || {};
      /* 签名里带上「读到没有」与失败原因 —— 否则读失败那一轮签名不变，
         错误态就永远画不出来。 */
      const next = [num(t.requests), num(t.failed), recs.length,
        recs[0] ? String(recs[0].t || "") : "", recs[0] ? num(recs[0].status) : 0].join("|")
        + "|" + (loaded ? "1" : "0") + "|" + lasterr;
      if (next !== sig) { sig = next; renderBody(); }

      const note = q('[data-role="ul-note"]');
      if (note) {
        note.innerHTML = (lasterr && data)
          ? `<div class="hint" style="margin-top:12px;color:var(--warn)">上一次刷新失败：${esc(lasterr)}（下面显示的是上一次读到的结果）</div>`
          : "";
      }
      /* 读不到而且手上**没有**旧数据 ⇒ 整块换成错误态（必须带下一步）。
         有旧数据时保留旧数据 + 一行说明 —— 数字旧了一天比清空好。 */
      if (!data && lasterr) {
        const body = q('[data-role="ul-body"]');
        if (body) {
          body.innerHTML = S3("errorState", "读不到用量账本", {
            hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
            detail: lasterr,
          });
        }
      }
    }

    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await ctx.api("/api/usage");
        if (r && r.ok === false) throw new Error(r.error || "用量账本读取失败");
        data = r || {};
        lasterr = "";
      } catch (e) {
        lasterr = String((e && e.message) || e);
      } finally {
        inflight = false;
        loaded = true;
        render();
      }
    }

    render();
    load();

    /* 视图不在眼前时就不读——省下的是本机的一次本地 HTTP，不是用户的等待。 */
    const hidden = () => {
      const vr = box.closest && box.closest(".view");
      if (!vr || !vr.classList || typeof vr.classList.contains !== "function") return false;
      return !vr.classList.contains("on");
    };

    return {
      update() { if (!hidden()) load(); },
      refresh() { if (!hidden()) load(); },
    };
  },
};
