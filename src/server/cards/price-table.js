/* cards/price-table.js —— 价格表卡（单价表是哪天的快照 · 单价多少 · 哪些估不出）。
 *
 * 这张卡回答的是「**面板上那些费用是按哪张单价表算的**」：
 *   ① 这张单价表是哪天的快照（价格会漂移，用户要拿它跟厂商账单对账）
 *   ② 表里估得出的那些模型，各是多少单价
 *   ③ 估不出的那些渠道，以及**为什么**估不出
 *   ④ 一个「更新价格表」按钮 —— 更新**只由用户点**触发
 *
 * ── 三条纪律 ──
 *   ① **不自动更新**：价格是用户对账的依据。自动更新会让「今天我花了多少钱」
 *      这句话的含义在某天悄悄变掉，而用户只会觉得路由台在骗他。
 *      所以更新是「用户点了才发生」的事。
 *   ② **刷新失败 ⇒ 继续用旧表**：拉不到或拉回来的表不合格，都如实说
 *      「继续用旧的那张」。**绝不清空费用** —— 清空了用户会以为
 *      「今天没花钱」，那是比「数字旧了一天」坏得多的结果。
 *   ③ **「估出 0」与「估不出」是两件事**：0 是源里明说的免费，「—」是源里
 *      没列、查不到。把「—」当 0 用，缓存费就被算成了免费（magpie 栽在这里）。
 *
 * ── 端点形状（服务端已实现，见 server.mjs 的 pricingOverview）────────
 *   GET  /api/pricing         → { ok, pricedAt, currency, unit, source,
 *                                 ageDays, stale, entries:[{key,name,input,output,
 *                                 cacheRead,cacheWrite}], refreshing, lastError }
 *   POST /api/pricing/refresh → { ok, started }   ← **非阻塞**：立刻回包，
 *                                  刷新在服务端跑，本卡轮 GET 看 refreshing。
 *   ⚠ 条目的四个通道叫 **input / output / cacheRead / cacheWrite**
 *     （pricing.mjs 的口径），不是 models.dev 那边的 prompt / completion ——
 *     写错了四个价全是 null，而 null 在价格表里意味着「不知道」。
 *
 * ── 渠道名一律不写死 ──
 * 显示名走服务端给的 name（清单里那份）或 ctx.nameOf(key)；本文件不认识任何渠道。
 *
 * ── 颜色只用语义类名 ──
 * ok / warn / err / idle / brand 五类由 CSS 变量在深浅两套主题里各自取值；
 * 这里写死一个色值就等于把这张卡钉在深色主题上。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["price-table"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));

    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    /* ---- 容器：自建面板盒，挂在所在视图末尾 ----
     * 盒子的 id 带上视图 id：同一张卡挂到两个视图时，两个视图各要一个盒子
     * （只按固定 id 找，第二屏会拿到第一屏那一个，落在错的视图里）。 */
    const viewId = String((ctx && ctx.view) || "main");
    const boxId = "priceTablePanel-" + viewId;

    let box = $(boxId);
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = boxId;
      box.innerHTML = `
        <div class="pb-head">
          <h3>价格表</h3>
          <span class="sub">单价表是哪天的快照 · 哪些估得出、哪些估不出</span>
        </div>
        <div class="fieldset">
          <div data-role="pt-head"></div>
          <div data-role="pt-body"></div>
          <div data-role="pt-unpriced"></div>
          <div data-role="pt-legend"></div>
          <div data-role="pt-note"></div>
          <div style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <button type="button" class="btn sm" data-role="pt-refresh">更新价格表</button>
            <span class="hint">价格表**不会自动更新** —— 换一张表就是换一种「今天花了多少钱」的口径，所以由你决定什么时候换。</span>
          </div>
          <div class="result" data-role="pt-result"></div>
        </div>`;
      const viewRoot = (slot.closest && slot.closest(".view")) || slot;
      viewRoot.appendChild(box);
    }
    const q = (sel) => box.querySelector(sel);

    /* 刷新是**非阻塞**的：POST 立刻回包，刷新在服务端跑，本卡轮 GET 看结果。
     * （models.dev 的 api.json 有几 MB，前端 12 秒的默认预算会把一次成功
     *   的刷新掐成「读取超时」—— 与 POST /api/test、/api/models/scan-all 同一套做法。）*/
    const REFRESH_POLL_MS = 1000;
    const REFRESH_WAIT_MAX_MS = 120000;

    let data = null;      // 最近一次成功读到的 /api/pricing
    let lasterr = "";     // 最近一次**读**失败的原因（读失败 ≠ 刷新失败）
    let inflight = null;  // 正在飞的那次读取（并发调用共用它，见 load）
    let sig = "";         // 上一次画过的数据签名（数据没变就不重画表）

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

    /* 取一个单价通道。
     * ★ **字段不存在**与**字段写着 null**都算「不知道」：前者是源里没这一项，
     *   后者是源里明说查不到。两者都不许折成 0。 */
    const pickPrice = (e, ...names) => {
      for (const n of names) {
        if (!e || !Object.prototype.hasOwnProperty.call(e, n)) continue;
        const v = e[n];
        if (v === null || v === undefined) return null;
        const x = Number(v);
        return Number.isFinite(x) ? x : null;
      }
      return null;
    };

    /* 一个单价怎么写：
     *   0 → 「0」（源里明说是免费）
     *   null → 「—」（源里没列，查不到）
     * 这两格长得不一样，是故意的：一个是免费，一个是不知道。 */
    function fmtPrice(v) {
      if (v === null || v === undefined) {
        return { txt: "—", title: "源里没列这一项，查不到（不按 0 算）" };
      }
      if (v === 0) return { txt: "0", title: "源里明说是 0 —— 这一款真的免费" };
      return { txt: String(Number(Number(v).toFixed(6))), title: "" };
    }

    /* 渠道显示名：服务端给的（清单里那份）优先，其次 ctx.nameOf，最后退回 key。 */
    const nameOfKey = (key, given) => {
      if (given) return String(given);
      const k = String(key == null ? "" : key);
      if (!k) return "—";
      try {
        if (typeof ctx.nameOf === "function") {
          const n = ctx.nameOf(k);
          if (n) return String(n);
        }
      } catch (e) { /* 清单里没有这一家就退回 key */ }
      return k;
    };

    /* 一条条目拆成「厂商」与「模型」两格。
     * 服务端的 name 有两种形状：「厂商 · 模型」（带分隔符）或只有厂商显示名。 */
    function splitEntry(eo) {
      const e = eo && typeof eo === "object" ? eo : {};
      const key = String(e.key || "");
      const slash = key.indexOf("/");
      const channel = slash > 0 ? key.slice(0, slash) : key;
      const model = String(e.model || (slash > 0 ? key.slice(slash + 1) : key));
      const raw = String(e.name || "");
      const sep = raw.indexOf(" · ");
      if (sep > 0) return { vendor: raw.slice(0, sep), model: raw.slice(sep + 3) || model };
      return { vendor: nameOfKey(channel, raw), model };
    }

    /* 估不出的渠道。
     * 服务端给了 `unpriced` 就直接用（它知道每一家为什么估不出）；
     * 没给就自己按「表里一条条目都没有」推 —— 渠道清单走 ctx.chainOf()
     * （可接通的那些；交还区不是渠道，不该出现在这里）。 */
    function unpricedRows(d) {
      if (Array.isArray(d.unpriced)) {
        return d.unpriced.map((u) => ({
          key: String((u && u.key) || ""),
          name: nameOfKey(u && u.key, u && u.name),
          why: String((u && u.why) || "表里没有这一家的单价"),
        }));
      }
      const priced = new Set();
      for (const e of (Array.isArray(d.entries) ? d.entries : [])) {
        const k = String((e && e.key) || "");
        const i = k.indexOf("/");
        if (i > 0) priced.add(k.slice(0, i));
      }
      let keys = [];
      try {
        if (typeof ctx.chainOf === "function") keys = ctx.chainOf() || [];
        else if (Array.isArray(ctx.channels)) keys = ctx.channels;
      } catch (e) { keys = []; }
      return keys.filter((k) => !priced.has(k)).map((k) => ({
        key: k,
        name: nameOfKey(k),
        why: "这张表里没有这一家的单价 —— 它不按 token 计价，或公开渠道查不到转售价",
      }));
    }

    function renderHead() {
      const el = q('[data-role="pt-head"]');
      if (!el) return;
      const d = data || {};
      const pricedAt = String(d.pricedAt || "");
      const age = d.ageDays === null || d.ageDays === undefined ? null : num(d.ageDays);
      const stale = !!d.stale;
      const source = d.source === "remote" ? "远端更新" : (d.source === "builtin" ? "内置表" : "");
      const refreshing = d.refreshing === true;

      let pill;
      if (!pricedAt) {
        pill = '<span class="pill idle">读不到快照日期</span>';
      } else if (age === null) {
        pill = '<span class="pill idle">快照 ' + esc(pricedAt) + "</span>";
      } else if (stale) {
        pill = '<span class="pill warn">' + esc(String(age)) + " 天前的快照 · 已陈旧</span>";
      } else {
        pill = '<span class="pill ok">' + esc(String(age)) + " 天前的快照</span>";
      }

      el.innerHTML = `
        <div class="sechead" style="margin-top:6px">
          <h2>单价表</h2>
          <span class="note">快照 <span class="mono">${esc(pricedAt || "—")}</span>${source ? " · 来源：" + esc(source) : ""}</span>
          <span class="spacer"></span>
          ${refreshing ? '<span class="pill brand">正在更新…</span>' : ""}
          ${pill}
        </div>` + (stale
          ? `<div class="hint" style="margin:2px 2px 10px"><span class="pill warn">陈旧</span> 这张单价表已经 ${esc(String(age))} 天没更新了 —— 厂商可能早就调过价。拿它对账之前，先点下面的「更新价格表」。</div>`
          : "");
    }

    function renderBody() {
      const el = q('[data-role="pt-body"]');
      if (!el) return;
      const d = data || {};
      const rows = Array.isArray(d.entries) ? d.entries : [];
      if (!rows.length) {
        el.innerHTML = `<div class="hint" style="margin:6px 0 0">这张单价表里一条可用的单价都没有。</div>`;
        return;
      }
      const trs = rows.map((eo) => {
        const e = eo && typeof eo === "object" ? eo : {};
        const sp = splitEntry(e);
        const cells = [
          pickPrice(e, "input", "prompt"),
          pickPrice(e, "output", "completion"),
          pickPrice(e, "cacheRead", "cache_read"),
          pickPrice(e, "cacheWrite", "cache_write"),
        ].map(fmtPrice);
        const tds = cells.map((c) => `<td${c.title ? ` title="${esc(c.title)}"` : ""}>${c.txt === "—" ? '<span class="dim">—</span>' : '<span class="mono">' + esc(c.txt) + "</span>"}</td>`).join("");
        return `<tr>
            <td>${esc(sp.vendor)}</td>
            <td><span class="mono">${esc(sp.model)}</span></td>
            ${tds}
          </tr>`;
      }).join("");

      el.innerHTML = `
        <div class="sechead" style="margin:14px 0 4px">
          <h2>估得出的单价</h2>
          <span class="note">${esc(String(rows.length))} 条</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr>
            <th style="width:22%">厂商</th>
            <th style="width:30%">模型</th>
            <th style="width:12%">输入</th>
            <th style="width:12%">输出</th>
            <th style="width:12%">缓存读</th>
            <th style="width:12%">缓存写</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>`;
    }

    function renderUnpriced() {
      const el = q('[data-role="pt-unpriced"]');
      if (!el) return;
      const rows = unpricedRows(data || {});
      if (!rows.length) {
        el.innerHTML = `<div class="hint" style="margin:12px 0 0">清单里的每一家都估得出。</div>`;
        return;
      }
      const trs = rows.map((u) => `<tr>
            <td>${esc(u.name)}</td>
            <td class="dim">${esc(u.why)}</td>
          </tr>`).join("");
      el.innerHTML = `
        <div class="sechead" style="margin:16px 0 4px">
          <h2>估不出的渠道</h2>
          <span class="note">这些不是免费 —— 是不按 token 计价，或查不到转售价</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr><th style="width:30%">渠道</th><th style="width:70%">为什么估不出</th></tr></thead>
          <tbody>${trs}</tbody>
        </table>`;
    }

    function renderLegend() {
      const el = q('[data-role="pt-legend"]');
      if (!el) return;
      const cur = String((data && data.currency) || "USD");
      const unit = String((data && data.unit) || "perMillion");
      const unitTxt = unit === "perMillion" || unit === "per-1M-tokens" ? "每百万 token" : unit;
      el.innerHTML = `<div class="hint" style="margin:12px 0 0">
        单价单位：${esc(cur)} / ${esc(unitTxt)}。
        <b>0</b> = 源里明说是免费；<b>—</b> = 源里没列、查不到（不按 0 算，也不拿别的价顶替）。
      </div>`;
    }

    function render() {
      renderHead();
      renderBody();
      renderUnpriced();
      renderLegend();
      const note = q('[data-role="pt-note"]');
      if (note) {
        /* 服务端记下来的「刚才那次刷新为什么失败」要一直看得见 ——
         * 它是用户理解「为什么表没换」的唯一线索。 */
        const lastErr = String((data && data.lastError) || "");
        note.innerHTML = (lastErr || (lasterr && data))
          ? `<div class="hint" style="margin-top:8px"><span class="pill warn">${lastErr ? "上次刷新没成功" : "读失败"}</span> ${esc(lastErr || lasterr)}${lastErr ? "" : "（下面显示的是上一次读到的结果）"}</div>`
          : "";
      }
      if (!data && lasterr) {
        const res = q('[data-role="pt-result"]');
        if (res) {
          res.textContent = "读不到价格表：" + lasterr;
          res.className = "result show bad";
        }
      }
    }

    /* 画。
     * ⚠ 数据没变就不重画：每 5 秒整块重建一次会打断用户正在看的行。 */
    function paint() {
      const d = data || {};
      const next = JSON.stringify([
        d.pricedAt, d.stale, d.ageDays, d.source, d.refreshing, d.lastError, lasterr,
        (d.entries || []).length, (d.unpriced || []).length,
      ]);
      if (next === sig) return;
      sig = next;
      render();
    }

    /* 读价格表。
     * ⚠ 并发调用**共用同一个 promise**：早先这里是 `if (inflight) return;`，
     *   而轮询与「刷新后重读」会撞上 —— 后来的那次直接空手返回，
     *   于是 update() 拿着上一份数据（甚至是空的）就画了。
     * ⚠ 读到之后**就地重画**：早先把重画放在 update() 里，
     *   于是首屏永远滞后一个轮询周期（5 秒）才出内容。 */
    function load() {
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const r = await ctx.api("/api/pricing");
          if (r && r.ok === false) throw new Error(r.error || "读不到价格表");
          data = r || null;
          lasterr = "";
        } catch (e) {
          lasterr = String((e && e.message) || e);
        } finally {
          inflight = null;
          paint();
        }
      })();
      return inflight;
    }

    function setResult(text, good) {
      const el = q('[data-role="pt-result"]');
      if (!el) return;
      el.textContent = text || "";
      el.className = "result show" + (good === true ? " good" : good === false ? " bad" : "");
    }

    /* 轮 GET 直到刷新跑完（服务端把 refreshing 落回 false）。 */
    async function waitRefresh() {
      const t0 = Date.now();
      for (;;) {
        const d = await ctx.api("/api/pricing");
        if (!d || d.refreshing !== true) return d;
        if (Date.now() - t0 > REFRESH_WAIT_MAX_MS) return d;
        await new Promise((r) => setTimeout(r, REFRESH_POLL_MS));
      }
    }

    async function doRefresh() {
      const btn = q('[data-role="pt-refresh"]');
      const oldText = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "正在更新…"; }
      setResult("正在拉 models.dev 的最新单价…（要联网，可能十几秒）");
      try {
        const r = await ctx.api("/api/pricing/refresh", {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
        if (r && r.ok === false) throw new Error(r.error || "更新失败");
        if (r && r.started === false) {
          setResult("没有开始刷新：" + String(r.reason || "已经在刷了，等它跑完"), false);
          return;
        }
        const done = await waitRefresh();
        await load();   // load() 自己会重画（paint 在里面）
        /* 服务端把「为什么没换」写进 lastError（拉不到 / 不合格 / 比现在旧）。 */
        const err = String((done && done.lastError) || "");
        if (err) {
          setResult("✖ 没有更新：" + err, false);
        } else {
          setResult("✔ 已更新：单价表换成 " + String((done && done.pricedAt) || "") + " 那张", true);
        }
      } catch (e) {
        /* ★ 拉不到 / 不合格 ⇒ 继续用现在这张。**绝不清空费用**：
         *   清空了用户会以为「今天没花钱」。data 保持原样，面板继续显示旧表。 */
        setResult("✖ 更新失败：" + String((e && e.message) || e)
          + " —— 继续用现在这张单价表（费用不受影响）", false);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = oldText; }
      }
    }

    const btn = q('[data-role="pt-refresh"]');
    if (btn) btn.addEventListener("click", doRefresh);

    render();
    load();

    /* 视图不在眼前时就不读 —— 省下的是本机的一次本地 HTTP，不是用户的等待。 */
    const hidden = () => {
      const vr = box.closest && box.closest(".view");
      if (!vr || !vr.classList || typeof vr.classList.contains !== "function") return false;
      return !vr.classList.contains("on");
    };

    return {
      async update() {
        if (hidden()) return;
        await load();
      },
      refresh() { if (!hidden()) return load(); },
    };
  },
};
