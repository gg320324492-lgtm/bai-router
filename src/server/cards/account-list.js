/* cards/account-list.js —— 账号卡（每家有哪些可用账号、缺什么才能用上）。
 *
 * 这张卡回答的是「**这家到底配好了没有**」：
 *   ① 每家的凭据从哪来（配置里的 key / 本机的令牌仓库 / 令牌文件 / OAuth 登录态 / 传输层）
 *   ② 有几个可用账号（**一家可能有好几个**：WorkBuddy 的令牌仓库、OpenRouter 的轮换 key）
 *   ③ **缺什么**才能用上（没填 key / 客户端没登录 / 令牌文件不在）
 *
 * ── 为什么单独一屏，而不是塞进渠道矩阵 ──
 *   渠道矩阵回答「这家通不通」，账号卡回答「**为什么不通、缺哪一样**」。
 *   后者是用户真正卡住时要看的东西 —— 混在一张表里反而找不到。
 *
 * ── 纪律 ──
 *   ⚠ **绝不显示凭据本身**：只显示账号的 id / 标签 / 指纹（仓库里有 keyFp 那套口径）。
 *   ⚠ 「没配上」要说清**缺什么**，不是一句「未配置」。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["account-list"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));

    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    let box = $("accountList");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "accountList";
      box.innerHTML = `
        <div class="pb-head">
          <h3>账号</h3>
          <span class="sub">每家有哪些可用账号 · 缺什么才能用上</span>
        </div>
        <div class="fieldset">
          <div data-role="ac-body"></div>
          <div class="result" data-role="ac-result"></div>
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

    const SOURCE_LABEL = {
      config: "配置里的 key",
      "token-pool": "本机令牌仓库",
      "token-file": "客户端令牌文件",
      oauth: "本机登录态",
      transport: "传输层自带",
      none: "没有",
    };

    function render() {
      const body = q('[data-role="ac-body"]');
      if (!body) return;
      const rows = Array.isArray(data && data.providers) ? data.providers : [];
      if (!rows.length) {
        body.innerHTML = `<div class="hint" style="margin-top:12px;padding:12px 14px;border:1px solid var(--line);border-radius:9px;background:var(--panel2)">
          还没有账号信息 —— <b>这不是出错</b>。读一遍本机的登录态就会出现。
        </div>`;
        return;
      }
      const trs = rows.map((r) => {
        const accounts = Array.isArray(r.accounts) ? r.accounts : [];
        const acct = accounts.length
          ? accounts.map((a) => `<span class="mono">${esc(String(a.id || a.label || ""))}</span>${a.usable === false ? '<span class="dim">（不可用）</span>' : ""}`).join("、")
          : '<span class="dim">—</span>';
        const state = r.configured
          ? '<span class="led ok"></span> 可用'
          : '<span class="led err"></span> 没配上';
        return `<tr>
            <td>${esc(String(r.name || r.key || ""))}</td>
            <td>${state}</td>
            <td class="dim">${esc(SOURCE_LABEL[r.source] || String(r.source || ""))}</td>
            <td>${acct}</td>
            <td class="dim">${r.missing ? esc(String(r.missing)) : (r.detail ? esc(String(r.detail)) : "—")}</td>
          </tr>`;
      }).join("");
      body.innerHTML = `
        <table class="route" style="table-layout:fixed">
          <thead><tr>
            <th style="width:16%">渠道</th>
            <th style="width:14%">状态</th>
            <th style="width:18%">凭据来源</th>
            <th style="width:22%">可用账号</th>
            <th style="width:30%">说明 / 缺什么</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>`;
    }

    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await ctx.api("/api/accounts");
        if (r && r.ok === false) throw new Error(r.error || "读不到账号信息");
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
        r.key, r.configured, r.source, num(r.accounts && r.accounts.length), r.missing || "",
      ]));
    }

    return {
      async update() {
        await load();
        if (lasterr) {
          const body = q('[data-role="ac-body"]');
          if (body) body.innerHTML = `<div class="hint" style="margin-top:12px">读不到账号信息：${esc(lasterr)}</div>`;
          return;
        }
        const s = signature();
        if (s !== sig) { sig = s; render(); }
      },
      refresh() { return load(); },
    };
  },
};
