/* cards/traffic-page.js —— 流量页的卡（按天的花费与用量 + 会话亲和）。
 *
 * 这张卡回答的是「**钱花到哪儿了？谁在扛请求？**」：
 *   ① 按天的时间线：每天的请求数、失败数、token、花费
 *   ② 每家的流量：谁扛了请求、扛得怎么样（延迟）、花了多少
 *   ③ 会话亲和：哪些对话被钉在哪一家、钉在哪个号上、粘了多少次
 *
 * ── 口径一律来自服务端（/api/traffic），这里不改一遍 ────────────────
 *   服务端那侧是 traffic.mjs，它的口径与仓库既有的用法一致：
 *     · **转交（handed_on）不算失败**：它在网关内部把活交给了下一个候选，
 *       但仍写了自己的记录（可能已被厂商计费），所以它进「尝试」、进花费，
 *       不进「请求」、不进「失败」；
 *     · **估不出就是「—」**：费用拿不到时显示「—」，不显示 0（一个错数字
 *       比没有数字更坏，用户要拿它跟厂商账单对账）；
 *     · **查不到 ≠ 0**：会话在亲和表里、账本里查不到时，写「查不到」。
 *   这里若自己再算一套，两张卡对不上，用户得自己判断哪个是真的。
 *
 * ── 颜色只承载状态，用量高低由**长度**表示 ─────────────────────────
 *   量条的颜色 = 那段时间的**健康度**（有没有失败、是不是全失败），
 *   不是「用量大 ⇒ 红」。用量大只是量大，不是出事 —— 把它画成红色，
 *   用户会以为那天出了故障。为了不误用 kit.meter 的默认阈值配色
 *   （那是给额度条用的：超 75% 转黄、超 90% 转红），这里显式传 tone。
 *   颜色只经类名给（ok / warn / err / idle / brand），由 CSS 去 var() 取值 ——
 *   深浅两套主题都验过，写死色值就等于只支持一套主题。
 *
 * ── 渠道名一个字都不写 ──────────────────────────────────────────────
 *   显示名走 ctx.nameOf(key)；清单里没有的渠道原样显示 key
 *   （编出来的名字比 key 更难查）。
 *
 * ── 刷新节奏 ────────────────────────────────────────────────────────
 *   共享层每 5 秒轮询一次（panel-common.js 的 setInterval(poll, 5000) → cards.update()），
 *   本卡**不**自己另起定时器：两个节奏会打架，画面上的数会来回跳。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["traffic-page"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    /* 共享组件库是静态引入的（provider.html 里一个 <script>），不是卡片自己加载的 ——
       卡片是运行时动态加载的，它加载时组件库早就在页面上了。 */
    const kit = window.BAI_KIT || null;
    const esc = ctx.esc || (kit && kit.esc) || ((s) => String(s == null ? "" : s));
    /* 三态（空 / 错 / 加载）统一走共享组件：措辞与结构只在 panel-kit.js 定义一次。
       组件库不在时降级成一句提示 —— 整块空白比降级更坏。 */
    const S3 = (kind, text, opts) => (kit
      ? kit[kind](text, opts)
      : '<div class="hint">' + esc(text) + "</div>");

    /* ---- 容器：自建面板盒，挂在所在视图末尾 ----
     * 不去抢别人的插槽：接线由清单决定，这张卡自己造盒子。 */
    let box = $("trafficPage");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "trafficPage";
      box.innerHTML = `
        <div class="pb-head">
          <h3>流量</h3>
          <span class="sub">按天的花费与用量 · 谁在扛请求 · 会话粘在谁身上</span>
        </div>
        <div class="fieldset">
          <div class="rail" style="margin-bottom:0">
            <div class="rail-grid">
              <div class="gauge"><span class="cap">请求</span><div class="val" data-role="t-calls">—</div><div class="sub" data-role="s-calls"></div></div>
              <div class="gauge"><span class="cap">失败</span><div class="val"><span class="led idle" data-role="l-fail"></span><span data-role="t-fail">—</span></div><div class="sub" data-role="s-fail"></div></div>
              <div class="gauge"><span class="cap">花费</span><div class="val" data-role="t-cost">—</div><div class="sub" data-role="s-cost"></div></div>
              <div class="gauge"><span class="cap">token 入 / 出</span><div class="val" data-role="t-tok">—</div><div class="sub" data-role="s-tok"></div></div>
            </div>
          </div>
          <div data-role="tf-note"></div>
          <div data-role="tf-body"></div>
          <div class="result" data-role="tf-result"></div>
        </div>`;
      const viewRoot = (slot.closest && slot.closest(".view")) || slot;
      viewRoot.appendChild(box);
    }
    const q = (sel) => box.querySelector(sel);

    const DAYS = 30;        // 时间线默认看多少天
    const DAY_ROWS = 14;    // 明细表最多列这么多天（更早的天在上面的时间线条里）
    const CH_ROWS = 12;     // 每家流量最多列这么多行
    const SESSION_ROWS = 12; // 会话亲和最多列这么多行

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const int = (v) => num(v).toLocaleString("zh-CN");

    let data = null;      // 最近一次成功读到的 /api/traffic
    let lasterr = "";     // 最近一次读失败的原因
    let inflight = false;
    let loaded = false;   // 至少成功读过一回（没读过 ≠ 没有记录）
    let sig = "";         // 上一次画过的数据签名（数据没变就不重画）

    /* 清单里认识的渠道 → 显示名；不认识的原样显示 key。 */
    const known = (k) => (ctx.channels || []).indexOf(k) >= 0;
    const nameOfKey = (k) => {
      const s = String(k == null ? "" : k);
      if (!s) return "—";
      return known(s) ? ctx.nameOf(s) : s;
    };

    /* 费用：null = 估不出（**不是 0**）。 */
    function fmtCost(v) {
      if (v == null) return "—";
      const n = Number(v);
      if (!Number.isFinite(n)) return "—";
      return "$" + n.toFixed(4);
    }

    function fmtWhen(t) {
      if (!t) return "—";
      const d = new Date(t);
      if (!Number.isFinite(d.getTime())) return "—";
      return d.toLocaleString("zh-CN", {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
      });
    }

    /* 一段时间的健康度 → 语义色。
     * 有失败但不是全军覆没 = warn；全失败 = err；没有失败 = ok。
     * ⚠ 这是**状态**不是「用量大小」：用量再大也不是坏事。 */
    function healthTone(d) {
      const calls = num(d && d.calls);
      const failed = num(d && d.failed);
      if (!calls) return "idle";
      if (failed >= calls) return "err";
      if (failed > 0) return "warn";
      return "ok";
    }

    /* 量条：长度 = 占比，颜色 = 健康度。
     * 显式传 tone —— kit.meter 的默认阈值配色是给额度条用的（超 75% 转红），
     * 用在用量上会让「用得最多的一天」被画成红色，像出了故障。 */
    function bar(ratio, tone, title) {
      if (!kit) return "";
      return kit.meter(ratio, { max: 1, tone: tone, title: title, showPct: false });
    }

    function renderTotals() {
      const d = data || {};
      const t = d.totals || {};
      const set = (role, v) => { const el = q(`[data-role="${role}"]`); if (el) el.textContent = v; };

      const calls = num(t.calls);
      const failed = num(t.failed);
      const attempts = num(t.attempts);
      const handed = num(t.handedOn);

      set("t-calls", int(calls));
      set("t-fail", int(failed));
      set("t-cost", fmtCost(t.cost));
      set("t-tok", `${int(t.tokensIn)} / ${int(t.tokensOut)}`);

      const led = q('[data-role="l-fail"]');
      if (led) led.className = "led " + (!calls ? "idle" : failed > 0 ? "err" : "ok");

      /* 副行说清每个数的口径 —— 用户看着「请求 12」要知道 12 是什么。 */
      const sc = q('[data-role="s-calls"]');
      if (sc) sc.textContent = attempts ? `尝试 ${int(attempts)} 次（转交 ${int(handed)}）` : "";
      const sf = q('[data-role="s-fail"]');
      if (sf) sf.textContent = "转交下一候选的尝试不计失败";
      const sk = q('[data-role="s-tok"]');
      if (sk) {
        sk.textContent = `缓存读 ${int(t.cacheRead)} · 写 ${int(t.cacheWrite)}`;
      }
      const sco = q('[data-role="s-cost"]');
      if (sco) {
        /* 估不出就说「估不出」，并说清是**哪些模型**估不出 ——
           笼统一句「未统计」会让人以为账本坏了。 */
        const unknown = Array.isArray(t.unknownModels) ? t.unknownModels : [];
        if (t.cost == null) {
          sco.textContent = unknown.length
            ? `${unknown.length} 个模型估不出（未计入）`
            : "价格表里没有这些模型";
        } else {
          sco.textContent = t.pricedAt ? `单价表快照 ${t.pricedAt}` : "";
        }
      }
    }

    function renderBody() {
      const body = q('[data-role="tf-body"]');
      if (!body) return;
      const d = data || {};
      const days = Array.isArray(d.days) ? d.days : [];
      const channels = Array.isArray(d.channels) ? d.channels : [];
      const aff = d.affinity || {};
      const sessions = Array.isArray(aff.sessions) ? aff.sessions : [];

      const hasAnything = num((d.totals || {}).attempts) > 0
        || days.some((x) => num(x && x.attempts) > 0)
        || sessions.length > 0;

      if (!loaded && !lasterr) {
        /* 第一次读还没回来：先说「在读」，别拿空态冒充「没有记录」。 */
        body.innerHTML = S3("loadingState", "正在读流量数据…", { hint: "读完这一块就能看到钱按天花到哪儿去了。" });
        return;
      }

      if (!hasAnything) {
        /* 空态：**没有记录 ≠ 出错**。这句话必须写清楚 —— 空态被当成报错，
           用户会以为账本坏了，去翻日志、去看磁盘，越查越慌。
           空态还要说清「怎么才会出现」：不然用户不知道要等什么。 */
        body.innerHTML = S3("emptyState", "还没有用量记录", {
          hint: "账本是在第一次真实调用之后才开始记的 —— 等客户端跑一轮对话，这里就会按天出现（请求、失败、token、花费），并列出粘住的会话。",
        });
        return;
      }

      /* ── ① 按天时间线 ── */
      const maxTok = days.reduce((m, x) => Math.max(m, num(x && x.tokens)), 0);
      const rows = days.slice(-DAY_ROWS).reverse();
      const dayRows = rows.map((x) => {
        const tone = healthTone(x);
        const tip = [
          `${x.day}：请求 ${num(x.calls)}`,
          x.failed ? `失败 ${num(x.failed)}` : "",
          `token ${int(x.tokensIn)} 入 / ${int(x.tokensOut)} 出`,
          x.handedOn ? `转交 ${num(x.handedOn)}` : "",
          `花费 ${fmtCost(x.cost)}`,
        ].filter(Boolean).join(" · ");
        return `<tr>
            <td><span class="mono">${esc(x.day)}</span></td>
            <td>${bar(maxTok ? num(x.tokens) / maxTok : null, tone, tip)}</td>
            <td class="dim">${esc(int(x.calls))}</td>
            <td>${num(x.failed) ? `<span class="led err"></span> ${esc(int(x.failed))}` : '<span class="dim">0</span>'}</td>
            <td class="dim">${esc(`${int(x.tokensIn)} / ${int(x.tokensOut)}`)}</td>
            <td>${esc(fmtCost(x.cost))}</td>
          </tr>`;
      }).join("");

      /* ── ② 每家流量 ── */
      const chShown = channels.slice(0, CH_ROWS);
      const maxChTok = chShown.reduce((m, x) => Math.max(m, num(x && x.tokens)), 0);
      const chRows = chShown.map((x) => {
        const tone = healthTone(x);
        const avg = x.avgMs == null ? "—" : (num(x.avgMs) >= 1000
          ? (num(x.avgMs) / 1000).toFixed(2) + "s" : Math.round(num(x.avgMs)) + "ms");
        const tip = [
          `请求 ${num(x.calls)}`,
          x.failed ? `失败 ${num(x.failed)}` : "",
          `尝试 ${num(x.attempts)}`,
          x.handedOn ? `转交 ${num(x.handedOn)}` : "",
          `token ${int(x.tokensIn)} 入 / ${int(x.tokensOut)} 出`,
          `缓存读 ${int(x.cacheRead)} · 写 ${int(x.cacheWrite)}`,
          x.maxMs ? `最慢 ${Math.round(num(x.maxMs))}ms` : "",
        ].filter(Boolean).join(" · ");
        return `<tr>
            <td>${esc(nameOfKey(x.key))}</td>
            <td>${bar(maxChTok ? num(x.tokens) / maxChTok : null, tone, tip)}</td>
            <td class="dim">${esc(int(x.calls))}</td>
            <td>${num(x.failed) ? `<span class="led err"></span> ${esc(int(x.failed))}` : '<span class="dim">0</span>'}</td>
            <td class="dim">${esc(avg)}</td>
            <td>${esc(fmtCost(x.cost))}</td>
          </tr>`;
      }).join("");

      /* ── ③ 会话亲和 ── */
      const sShown = sessions.slice(0, SESSION_ROWS);
      const maxStick = sShown.reduce((m, x) => Math.max(m, num(x && x.calls)), 0);
      const sRows = sShown.map((x) => {
        const sess = String(x.session || "");
        const short = sess.length > 10 ? sess.slice(0, 10) + "…" : sess;
        /* 「查得到」与「粘在谁身上」是两件事：
           账本里查得到这个会话 ≠ 它现在还钉在这家。分开写，别混成一句。 */
        const where = x.pinned
          ? `<span class="led ok"></span> ${esc(x.account || "（未记账号）")}`
          : '<span class="dim">未钉住</span>';
        const seen = x.seen
          ? `<span class="led ok"></span> ${esc(int(x.calls))} 次`
          : '<span class="led idle"></span> 查不到';
        const tip = [
          `会话 ${sess}`,
          `渠道 ${nameOfKey(x.channel)}`,
          x.account ? `账号 ${x.account}` : "",
          x.model ? `模型 ${x.model}` : "",
          `粘住 ${num(x.calls)} 次`,
          x.cacheReadMeta || x.cacheWriteMeta
            ? `缓存读 ${int(x.cacheReadMeta)} · 写 ${int(x.cacheWriteMeta)}` : "",
          `最后 ${fmtWhen(x.lastAt)}`,
        ].filter(Boolean).join(" · ");
        return `<tr title="${esc(tip)}">
            <td><span class="mono">${esc(short)}</span></td>
            <td>${esc(nameOfKey(x.channel))}</td>
            <td>${where}</td>
            <td>${bar(maxStick ? num(x.calls) / maxStick : null, x.pinned ? "ok" : "idle", tip)}</td>
            <td>${seen}</td>
            <td class="dim">${esc(fmtWhen(x.lastAt))}</td>
          </tr>`;
      }).join("");

      const aTot = aff.totals || {};
      const affNote = num(aTot.unseen)
        ? `<div class="hint" style="margin-top:8px">有 <b>${esc(int(aTot.unseen))}</b> 个会话在亲和表里、账本里查不到 —— <b>查不到 ≠ 粘了 0 次</b>（账本可能被裁剪过，或会话刚建立）。</div>`
        : "";

      body.innerHTML = `
        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:12px">按天</h2>
          <span class="note">最近 ${esc(days.length)} 天${days.length > DAY_ROWS ? `（表里只列最近 ${DAY_ROWS} 天）` : ""} · 条长是 token 用量，颜色是那天的健康度</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr>
            <th style="width:16%">日期</th>
            <th style="width:26%">用量</th>
            <th style="width:11%">请求</th>
            <th style="width:11%">失败</th>
            <th style="width:20%">token 入 / 出</th>
            <th style="width:16%">花费</th>
          </tr></thead>
          <tbody>${dayRows || `<tr><td colspan="6" class="dim">还没有记录</td></tr>`}</tbody>
        </table>

        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:12px">每家流量</h2>
          <span class="note">谁扛了请求、扛得怎么样、花了多少${channels.length > CH_ROWS ? `（只列前 ${CH_ROWS} 家，共 ${channels.length} 家）` : ""}</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr>
            <th style="width:20%">渠道</th>
            <th style="width:24%">用量</th>
            <th style="width:11%">请求</th>
            <th style="width:11%">失败</th>
            <th style="width:16%">平均延迟</th>
            <th style="width:18%">花费</th>
          </tr></thead>
          <tbody>${chRows || `<tr><td colspan="6" class="dim">还没有记录</td></tr>`}</tbody>
        </table>

        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:12px">会话亲和</h2>
          <span class="note">这段对话粘在哪一家、粘在哪个号上 · 共 ${esc(int(aTot.sessions || 0))} 个会话 / ${esc(int(aTot.sticks || 0))} 次粘住${sessions.length > SESSION_ROWS ? `（只列最近 ${SESSION_ROWS} 个）` : ""}</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr>
            <th style="width:20%">会话</th>
            <th style="width:16%">渠道</th>
            <th style="width:22%">粘在哪个号</th>
            <th style="width:14%">粘住占比</th>
            <th style="width:14%">粘住次数</th>
            <th style="width:14%">最后</th>
          </tr></thead>
          <tbody>${sRows || `<tr><td colspan="6" class="dim">还没有粘住的会话 —— 这一层要在真的发生过对话之后才有</td></tr>`}</tbody>
        </table>
        ${affNote}`;
    }

    function render() {
      renderTotals();
      /* 数据没变就不重画表：每 5 秒整块重建一次会打断用户正在看的行。 */
      const d = data || {};
      const t = d.totals || {};
      const days = Array.isArray(d.days) ? d.days : [];
      const chans = Array.isArray(d.channels) ? d.channels : [];
      const aff = d.affinity || {};
      const sess = Array.isArray(aff.sessions) ? aff.sessions : [];
      const next = [
        num(t.calls), num(t.failed), num(t.attempts), t.cost == null ? "null" : num(t.cost),
        days.length, days.length ? String(days[days.length - 1].day || "") : "",
        chans.length, chans.length ? String(chans[0].key || "") : "",
        sess.length, sess.length ? String(sess[0].session || "") : "",
      ].join("|") + "|" + (loaded ? "1" : "0") + "|" + lasterr;
      if (next !== sig) { sig = next; renderBody(); }

      const note = q('[data-role="tf-note"]');
      if (note) {
        note.innerHTML = (lasterr && data)
          ? `<div class="hint" style="margin-top:12px;color:var(--warn)">上一次刷新失败：${esc(lasterr)}（下面显示的是上一次读到的结果）</div>`
          : "";
      }
      /* 读不到而且手上**没有**旧数据 ⇒ 整块换成错误态（必须带下一步）。
         有旧数据时保留旧数据 + 一行说明 —— 数字旧了一天比清空好。 */
      if (!data && lasterr) {
        const body = q('[data-role="tf-body"]');
        if (body) {
          body.innerHTML = S3("errorState", "读不到流量数据", {
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
        const r = await ctx.api("/api/traffic?days=" + DAYS);
        if (r && r.ok === false) throw new Error(r.error || "流量数据读取失败");
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
