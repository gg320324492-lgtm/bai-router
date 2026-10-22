/* cards/or-rotation.js —— 凭据视图里「多把 key 轮换区（keys3）」那一行的状态面板。
 *
 * v17 之前这是 OpenRouter 页的「免费流水区」折叠卡。凭据输入本身已由渲染层按
 * credential.kind = "keys3" 统一分派（那部分逻辑三家共用，不该每家一份），
 * 本卡只保留**只读状态**——这些是轮换区独有的、别处看不到的真数据：
 *   1) 当前在用第几把 key / 当前模型
 *   2) 每把 key 的指纹与冷却到什么时候
 *   3) 额度与重置倒计时（读不到就说读不到，不编数字）
 *   4) 两层轮换的判定依据（两种 429 含义相反，不能混为一谈）
 *
 * 分流逻辑全在 server.mjs 的轮换实现里，本卡只呈现结果。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["or-rotation"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));
    const hosts = (typeof ctx.rowsOfKind === "function" ? ctx.rowsOfKind("keys3") : []) || [];
    if (!hosts.length) return { update() { }, refresh() { } };

    /* 三态（空 / 错 / 加载）统一走共享组件：措辞与结构只在 panel-kit.js 定义一次。
       组件库不在时降级成一句提示 —— 整块空白比降级更坏。 */
    const kit = window.BAI_KIT || null;
    const S3 = (kind, text, opts) => (kit
      ? kit[kind](text, opts)
      : '<div class="hint">' + esc(text) + "</div>");

    const scoped = hosts.map((host) => {
      const row = host.closest(".credrow");
      const key = row && row.dataset ? row.dataset.k : null;
      host.innerHTML = `
        <div class="cardbody">
          <div class="tokstat" data-role="rotstat">${S3("loadingState", "正在读轮换状态…", { hint: "读完这一行就知道现在在用第几把 key、冷却到什么时候。" })}</div>
          <div class="hint" data-role="rotnote" style="margin-top:8px"></div>
          <div class="hint" style="margin-top:8px">
            <b>两层轮换</b>（两种限额含义相反，不能混为一谈）：<br>
            · 单个模型的上游池子满 → <b>换模型</b>：同一把 key 下自动挑下一个可用模型；<br>
            · 账号级每日次数用尽 → <b>换 key</b>：第 1 把 → 第 2 把 → 第 3 把 → 第 1 把，
            按上游返回的重置时间判断何时轮回来；<br>
            · 三把 key 都在冷却 → <b>如实失败</b>并给出重置时间，不会空转重试。
          </div>
        </div>`;
      const scope = host.firstElementChild;
      return { scope, key, $: (sel) => scope.querySelector(sel) };
    });

    function quotaLine(q) {
      if (!q) return "额度：未读到（key 未配置或上游不可达）";
      /* 读失败的详情由下面那一块错误态承担（带下一步），这里只点一句，
           免得同一句失败说两遍、还互相盖住。 */
      if (q.error) return "额度：读不到（原因见下）";
      const d = q.daily;
      if (!d) return "额度：上游未返回每日免费次数" + (q.stale ? "（下面是上次的缓存）" : "");
      return `今日免费额度：已用 ${d.used} / ${d.limit}，剩余 ${d.remaining}`;
    }

    function paint(sc, status) {
      const el = sc.$('[data-role="rotstat"]');
      if (!el) return;
      const S = ctx.stOf(sc.key) || {};
      const rot = S.rotation || {};
      const tk = S.token || {};
      const keys = Array.isArray(tk.keys) ? tk.keys : [];

      /* ⚠ 服务端状态还没到 ⇒ 说「在读」。**不能**当成「轮换区里没有 key」：
         那个结论要的是「真的读过了、确实一把都没有」，不是「还没读」。 */
      if (!status && !ctx.status) {
        el.innerHTML = S3("loadingState", "正在读轮换状态…", { hint: "读完这一行就知道现在在用第几把 key、冷却到什么时候。" });
        return;
      }
      if (!S.token) {
        /* 状态到了、但里面没有令牌这一段 ⇒ 读不到（**不是「一把 key 都没有」**）。 */
        el.innerHTML = S3("errorState", "读不到轮换状态", {
          hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
        });
        return;
      }
      if (!keys.length) {
        /* 空态要说清「怎么才会出现」：不然用户以为轮换坏了。 */
        el.innerHTML = S3("emptyState", "轮换区里还没有 key", {
          hint: "在上面填一把 API Key —— 三把全在冷却时，才有备用的可换。",
        });
        return;
      }

      const parts = [];
      parts.push(`<span>当前 key：<b>${tk.configured ? "第 " + (rot.activeKeyNo || "?") + " 把 / 共 " + (tk.keyCount || keys.length) + " 把" : "未配置"}</b></span>`);
      if (rot.activeModel) parts.push(`<span>当前模型：<b class="mono">${esc(rot.activeModel)}</b></span>`);
      if (rot.cooledModels && rot.cooledModels.length) {
        parts.push(`<span class="warn">冷却中模型：${rot.cooledModels.length} 个（${esc(rot.cooledModels[0].model)}…）</span>`);
      }
      for (const k of keys) {
        parts.push(`<span class="keyrow-inline"><span class="n">${k.no}</span>`
          + `<span class="${k.active ? "live" : ""}">${esc(k.fp)}${k.active ? " · 当前在用" : ""}`
          + (k.coolingUntil ? " · 冷却至 " + esc(new Date(k.coolingUntil).toLocaleString("zh-CN")) : "")
          + "</span></span>");
      }
      parts.push(`<span>${esc(quotaLine(S.quota))}</span>`);
      if (rot.resetCountdownMs > 0) {
        const min = Math.round(rot.resetCountdownMs / 60000);
        parts.push(`<span>重置倒计时：<b>${min >= 60 ? Math.floor(min / 60) + " 小时 " + (min % 60) + " 分" : min + " 分"}</b></span>`);
      }
      if (rot.limitSource) parts.push(`<span>最近一次限额来源：<b class="mono">${esc(rot.limitSource)}</b></span>`);
      el.innerHTML = parts.join("　");

      const note = sc.$('[data-role="rotnote"]');
      if (note) {
        const sw = rot.lastSwitch;
        /* 额度读不到 ⇒ **只**把额度这一块说成错误态：当前在用第几把、冷却到什么时候
           都是真的，混成一句「读不到」会把已知的事实一起抹掉。 */
        const quotaErr = (S.quota && S.quota.error) ? String(S.quota.error) : "";
        const rotLine = sw
          ? `最近一次轮换：${sw.at}　${sw.kind === "key" ? `第 ${sw.from} 把 key → 第 ${sw.to} 把 key` : `模型 ${sw.from} → ${sw.to}`}${sw.why ? "（" + sw.why + "）" : ""}`
          : "尚未发生轮换（额度够用时不会动）。";
        note.innerHTML = (quotaErr
          ? S3("errorState", "读不到额度", {
            hint: "点凭据行上的「刷新额度」重试 —— 额度读不到不影响对话，只是看不到还剩多少。",
            detail: quotaErr,
          })
          : "") + '<span class="hint">' + esc(rotLine) + "</span>";
      }
    }

    for (const sc of scoped) paint(sc, ctx.status);

    return {
      update(status) { for (const sc of scoped) paint(sc, status); },
      refresh() { for (const sc of scoped) paint(sc, ctx.status); },
    };
  },
};