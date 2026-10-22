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

    /* 三态（空 / 错 / 加载）统一走共享组件：措辞与结构只在 panel-kit.js 定义一次。
       组件库不在时降级成一句提示 —— 整块空白比降级更坏。 */
    const kit = window.BAI_KIT || null;
    const S3 = (kind, text, opts) => (kit
      ? kit[kind](text, opts)
      : '<div class="hint">' + esc(text) + "</div>");

    let data = null;
    let lasterr = "";
    let inflight = false;
    let loaded = false;   // 至少成功读过一回（没读过 ≠ 没有账号）
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
      if (!loaded && !lasterr) {
        /* 第一次读还没回来：先说「在读」，别拿空态冒充「没有账号」。 */
        body.innerHTML = S3("loadingState", "正在读账号信息…", { hint: "读完这一块就知道每家有哪些账号、缺什么才能用上。" });
        return;
      }
      if (lasterr) {
        /* 读不到 ⇒ 整块换成错误态（必须带下一步）：
           「没有账号」与「读不到账号」是两件事，混起来用户会去查一个没发生的事。 */
        body.innerHTML = S3("errorState", "读不到账号信息", {
          hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
          detail: lasterr,
        });
        return;
      }
      if (!rows.length) {
        /* 空态要说清「怎么才会出现」：不然用户不知道要先去客户端登录。 */
        body.innerHTML = S3("emptyState", "还没有账号信息", {
          hint: "读一遍本机的登录态就会出现 —— 先启动对应客户端并登录，再回来看。",
        });
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
        loaded = true;
        /* ⚠ 读完就重画：不重画的话这一块会**停在「正在读」**直到下一轮 5 秒轮询
           （load() 里 `if (inflight) return;` 不会等这次读，update() 也等不到它）。 */
        render();
      }
    }

    function signature() {
      const rows = Array.isArray(data && data.providers) ? data.providers : [];
      return JSON.stringify(rows.map((r) => [
        r.key, r.configured, r.source, num(r.accounts && r.accounts.length), r.missing || "",
      ])) + "|" + (loaded ? "1" : "0") + "|" + lasterr;
    }

    /* 首屏先画「在读」并把第一次读发出去：否则这 5 秒里这一块是空白，
       空白既不是「在读」也不是「没有账号」，用户只能猜。 */
    render();
    load();

    return {
      async update() {
        await load();
        if (lasterr) {
          /* 读不到 ⇒ 整块换成错误态（必须带下一步）：
             「没有账号」与「读不到账号」是两件事，混起来用户会去查一个没发生的事。 */
          const body = q('[data-role="ac-body"]');
          if (body) {
            body.innerHTML = S3("errorState", "读不到账号信息", {
              hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
              detail: lasterr,
            });
          }
          return;
        }
        const s = signature();
        if (s !== sig) { sig = s; render(); }
      },
      refresh() { return load(); },
    };
  },
};
