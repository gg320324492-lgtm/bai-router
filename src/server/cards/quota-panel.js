/* cards/quota-panel.js —— 额度视图的卡（每家的额度、预算与休息状态）。
 *
 * 这张卡回答的是「**这家还剩多少、还能用多久**」：
 *   ① 预算（用户自己设的 token 上限）与已用量
 *   ② 这家现在是不是在休息（额度冷却 / 预算用尽），歇到什么时候
 *   ③ 上游自己报的余额（探得到时）与**它的可信度**（探不到就明说探不到）
 *
 * ── 三条口径，别在渲染层改 ──
 *   ① **「探不到」与「余额是 0」是两件事**：
 *      探不到 → 显示「探不到（原因）」；上游真的报 0 → 显示「0」。
 *      混起来会让用户以为账号被封了，而真相可能只是这条网络不通。
 *   ② **「按账本估的」与「上游报的」要分开标**：一个是我们的估算，一个是上游的权威值。
 *      用户要知道这个数字有多可信。
 *   ③ 估不出来的模型**不估价**（显示「—」），不拿别的模型的价顶替。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["quota-panel"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));

    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    let box = $("quotaOverview");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "quotaOverview";
      box.innerHTML = `
        <div class="pb-head">
          <h3>各家额度</h3>
          <span class="sub">预算 · 已用 · 休息状态 · 上游余额</span>
        </div>
        <div class="fieldset">
          <div data-role="qov-body"></div>
          <div class="result" data-role="qov-result"></div>
        </div>`;
      const viewRoot = (slot.closest && slot.closest(".view")) || slot;
      viewRoot.appendChild(box);
    }
    const q = (sel) => box.querySelector(sel);

    let data = null;
    let lasterr = "";
    let inflight = false;
    let sig = "";

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const int = (v) => num(v).toLocaleString("zh-CN");

    function fmtWhen(t) {
      if (!t) return "—";
      const d = new Date(t);
      if (!Number.isFinite(d.getTime())) return "—";
      return d.toLocaleString("zh-CN", { hour12: false });
    }

    function fmtLeft(ms) {
      if (!ms) return "—";
      const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
      if (s < 60) return `${s} 秒后`;
      if (s < 3600) return `${Math.round(s / 60)} 分钟后`;
      return `${Math.round(s / 3600)} 小时后`;
    }

    function render() {
      const body = q('[data-role="qov-body"]');
      if (!body) return;
      const rows = Array.isArray(data && data.providers) ? data.providers : [];
      if (!rows.length) {
        body.innerHTML = `<div class="hint" style="margin-top:12px;padding:12px 14px;border:1px solid var(--line);border-radius:9px;background:var(--panel2)">
          还没有渠道的额度信息 —— <b>这不是出错</b>。额度要等真的发生过调用、或者你给某家设了预算之后才有。
        </div>`;
        return;
      }
      const trs = rows.map((r) => {
        const b = r.budget || null;
        const limit = b ? num(b.limit) : 0;
        const used = b ? num(b.used) : 0;
        const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
        const state = r.resting
          ? '<span class="led warn"></span> 休息中'
          : (r.cooling ? '<span class="led warn"></span> 冷却中' : '<span class="led ok"></span> 可用');
        const budgetCell = !b
          ? '<span class="dim">未设预算</span>'
          : `<span class="mono">${int(used)} / ${int(limit)}</span> <span class="dim">（${pct}%）</span>`;
        const limitCell = !b
          ? "—"
          : [b.hourly ? `每小时 ${int(b.hourly)}` : "", b.daily ? `每天 ${int(b.daily)}` : ""].filter(Boolean).join(" · ") || "—";
        const probe = r.probe
          ? (r.probe.known
            ? `<span class="mono">${int(r.probe.used)} / ${r.probe.limit != null ? int(r.probe.limit) : "—"}</span> <span class="dim">（上游报）</span>`
            : `<span class="dim">探不到：${esc(String(r.probe.error || "原因不明"))}</span>`)
          : '<span class="dim">未探测</span>';
        const cost = r.cost
          ? (r.cost.known ? `<span class="mono">$${num(r.cost.total).toFixed(4)}</span>` : '<span class="dim">估不出</span>')
          : '<span class="dim">—</span>';
        return `<tr>
            <td>${esc(String(r.name || r.key || ""))}</td>
            <td>${limitCell}</td>
            <td>${budgetCell}</td>
            <td>${probe}</td>
            <td>${cost}</td>
            <td>${state}${r.restUntil ? ` <span class="dim">${esc(fmtLeft(r.restUntil))}</span>` : ""}</td>
          </tr>`;
      }).join("");
      body.innerHTML = `
        <table class="route" style="table-layout:fixed">
          <thead><tr>
            <th style="width:16%">渠道</th>
            <th style="width:22%">预算上限</th>
            <th style="width:20%">已用 / 上限</th>
            <th style="width:18%">上游余额</th>
            <th style="width:10%">花费</th>
            <th style="width:14%">状态</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>
        ${(data && data.pricedAt) ? `<div class="hint" style="margin-top:10px">单价表快照：<span class="mono">${esc(String(data.pricedAt))}</span>（价格会随厂商调价漂移；估不出的模型显示「—」，不拿别的价顶替）</div>` : ""}`;
    }

    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await ctx.api("/api/quota/overview");
        if (r && r.ok === false) throw new Error(r.error || "读不到额度信息");
        data = r || null;
        lasterr = "";
      } catch (e) {
        lasterr = String((e && e.message) || e);
      } finally {
        inflight = false;
      }
    }

    function signature() {
      const rows = Array.isArray(data && data.providers) ? data.providers : [];
      return JSON.stringify(rows.map((r) => [
        r.key, r.budget ? r.budget.used : 0, r.budget ? r.budget.limit : 0,
        r.resting, r.restUntil, r.cooling,
        r.probe ? r.probe.known : null, r.cost ? r.cost.total : null,
      ]));
    }

    return {
      async update() {
        await load();
        if (lasterr) {
          const body = q('[data-role="qov-body"]');
          if (body) body.innerHTML = `<div class="hint" style="margin-top:12px">读不到额度信息：${esc(lasterr)}</div>`;
          return;
        }
        const s = signature();
        if (s !== sig) { sig = s; render(); }
      },
      refresh() { return load(); },
    };
  },
};
