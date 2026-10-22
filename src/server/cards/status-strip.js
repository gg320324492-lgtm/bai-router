/* cards/status-strip.js —— 总览屏顶部的横条（服务 / 当前接的 / 流量 / 用量 / 额度）。
 *
 * 这张卡回答的是「**现在能不能用**」——改版原则 2「一屏一个答案」：
 * 打开面板第一眼就该看到答案，而不是先读完一段说明。
 *
 * ── 为什么格子交给共享组件画 ──
 *   五格的名字（服务 / 当前接的 / 流量 / 用量 / 额度）与状态措辞一样属于
 *   「全局一致」的东西，定义在 BAI_KIT 里（src/server/panel-kit.js）。
 *   这张卡自己写就等于又开一个真相源：改一次名字要改两处，漏一处就漂。
 *
 * ── 数据从哪来（刻意不新增请求）──
 *   服务 / 当前接的：ctx.status —— 渲染层已经读过 /api/status，这里只是复用，
 *                   不再发一次请求（改版硬约束：新屏多了不等于请求多了）。
 *   流量 / 用量 / 额度：/api/channels/state —— 渠道各自的在途数与配额，
 *                   汇总成一行。读不到时这三格画成「—」，不猜、不填零。
 *                   （同一个接口的热力图卡也在读，服务端应当缓存。）
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["status-strip"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    let box = $("statusStrip");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "statusStrip";
      box.innerHTML = `
        <div class="pb-head">
          <h3>当前概况</h3>
          <span class="sub">服务 · 当前接的 · 流量 · 用量 · 额度</span>
        </div>
        <div class="fieldset">
          <div data-role="ss-body"></div>
        </div>`;
      const viewRoot = (slot.closest && slot.closest(".view")) || slot;
      viewRoot.appendChild(box);
    }
    const q = (sel) => box.querySelector(sel);

    const kit = window.BAI_KIT || null;
    const esc = ctx.esc || (kit && kit.esc) || ((s) => String(s == null ? "" : s));
    const nameOf = (key) => (ctx.nameOf ? ctx.nameOf(key) : key);

    /* 三态（空 / 错 / 加载）统一走共享组件：措辞与结构只在 panel-kit.js 定义一次。
       组件库不在时降级成一句提示 —— 整块空白比降级更坏。 */
    const S3 = (kind, text, opts) => (kit
      ? kit[kind](text, opts)
      : '<div class="hint">' + esc(text) + "</div>");

    let data = null;
    let pending = null;
    let sig = "";
    let loaded = false;   // 至少成功读过一回（没读过 ≠ 没有渠道）
    let lasterr = "";     // 最近一次读失败的原因

    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    function fmtDur(sec) {
      const s = Math.max(0, Math.floor(num(sec)));
      if (s < 60) return s + " 秒";
      if (s < 3600) return Math.floor(s / 60) + " 分钟";
      if (s < 86400) return Math.floor(s / 3600) + " 小时";
      return Math.floor(s / 86400) + " 天";
    }

    function fmtInt(v) {
      const n = Math.round(num(v));
      if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
      return String(n);
    }

    /* 汇总各家的在途数与配额。
       「没有」与「是 0」必须分开：没有预算限制 ≠ 用光了。 */
    function aggregate(rows) {
      const out = { busy: 0, carriers: 0, used: 0, limit: 0, hasUsed: false, hasLimit: false };
      for (const r of rows) {
        if (!r) continue;
        const b = num(r.busy);
        if (b > 0) { out.busy += b; out.carriers++; }
        if (r.used != null) { out.used += num(r.used); out.hasUsed = true; }
        if (r.limit != null && num(r.limit) > 0) { out.limit += num(r.limit); out.hasLimit = true; }
      }
      return out;
    }

    /* 当前接的是**两端真正在用的那家**（CLI / 桌面版的 mode），
       不是面板里正选中的那家 —— 两者经常不是一回事。 */
    function currentWiring(status) {
      const cli = (status && status.cli) || {};
      const desk = (status && status.desktop) || {};
      const ends = [cli, desk].filter((x) => x && x.mode);
      if (!ends.length) return { text: "两端都还没接线", tone: "idle", sub: "" };
      const modes = Array.from(new Set(ends.map((e) => e.mode)));
      return {
        text: modes.map((m) => nameOf(m)).join(" + "),
        tone: "brand",
        sub: modes.length > 1 ? "两端都接在它上面" : "一端接在它上面",
      };
    }

    function buildCells() {
      const status = ctx.status || null;
      const svc = (status && status.service) || null;
      const rows = Array.isArray(data && data.channels) ? data.channels : [];
      const agg = aggregate(rows);
      const wiring = currentWiring(status);

      let quotaTone = "idle";
      let quotaText = "—";
      let quotaSub = "";
      if (agg.hasLimit && agg.limit > 0 && agg.hasUsed) {
        const frac = Math.min(1, agg.used / agg.limit);
        quotaTone = frac >= 0.9 ? "err" : frac >= 0.75 ? "warn" : "ok";
        quotaText = "剩 " + Math.round((1 - frac) * 100) + "%";
        quotaSub = fmtInt(agg.used) + " / " + fmtInt(agg.limit);
      } else if (agg.hasLimit && agg.limit > 0) {
        /* 知道上限但读不到用量：只报上限，不报「剩 100%」——
           那个百分数没有依据，报出来就是编数字。 */
        quotaText = "上限 " + fmtInt(agg.limit);
      }

      return {
        service: {
          tone: svc ? (svc.up === false ? "err" : "ok") : "idle",
          text: svc ? (svc.up === false ? "已停止" : "运行中") : "—",
          sub: svc && svc.up !== false && svc.uptimeSec != null ? "已运行 " + fmtDur(svc.uptimeSec) : "",
        },
        current: { tone: wiring.tone, text: wiring.text, sub: wiring.sub },
        traffic: {
          tone: agg.busy > 0 ? "ok" : "idle",
          text: agg.busy > 0 ? agg.busy + " 在途" : "空闲",
          sub: agg.carriers > 0 ? agg.carriers + " 家在扛" : "",
        },
        usage: {
          tone: agg.hasUsed ? "ok" : "idle",
          text: agg.hasUsed ? fmtInt(agg.used) : "—",
          sub: agg.hasUsed ? "已用 token" : "",
        },
        quota: { tone: quotaTone, text: quotaText, sub: quotaSub },
      };
    }

    function render() {
      const body = q('[data-role="ss-body"]');
      if (!body) return;
      if (!kit) {
        body.innerHTML = `<div class="hint" style="margin-top:12px">共享组件库没加载 —— 这一行画不出来。</div>`;
        return;
      }
      /* ⚠ 读不到时**不把整行换成错误块**：这一行还带着服务端已经知道的事实
       *   （服务在不在跑、当前接的是谁），整块换掉会把已知信息一起抹了。
       *   所以横条照画，下面补一句「读不到哪一块、怎么办」。 */
      const rows = Array.isArray(data && data.channels) ? data.channels : [];
      let tail = "";
      if (!loaded) {
        tail = S3("loadingState", "正在读渠道状态…", { hint: "读完这一行就知道谁在扛请求、额度还剩多少。" });
      } else if (lasterr) {
        tail = S3("errorState", "读不到渠道状态", {
          hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通。",
          detail: lasterr,
        });
      } else if (!rows.length) {
        tail = S3("emptyState", "还没有渠道信息", {
          hint: "清单里还没有可用的渠道 —— 先在设置里接一家。",
        });
      }
      body.innerHTML = kit.statusStrip(buildCells()) + tail;
    }

    /* 挂载时已经在读的那一次，update() 要接着等它而不是跳过 ——
       跳过会让首屏多显示一个轮询周期的空数字。 */
    function load() {
      if (pending) return pending;
      pending = (async () => {
        try {
          /* 走渲染层的**共享读法**（ctx.loadChanStates）：同一个端点全屏只拉一份。
             热力图卡、渠道页左栏、这张状态条读的是同一份数据。 */
          const r = typeof ctx.loadChanStates === "function"
            ? await ctx.loadChanStates()
            : await ctx.api("/api/channels/state");
          data = (r && r.ok === false) ? null : (r || null);
          lasterr = "";
        } catch (e) {
          /* 读不到就如实说读不到，并给出下一步；不猜数字：错数字比没数字更坏。
             （三格仍画「—」，但下面有一句说明为什么是「—」——不然用户以为没数据。） */
          data = null;
          lasterr = String((e && e.message) || e);
        } finally {
          loaded = true;
          pending = null;
          /* ⚠ 读完就重画：数据一到就更新，不必等下一轮 5 秒轮询。 */
          render();
        }
      })();
      return pending;
    }

    function signature() {
      const status = ctx.status || null;
      const rows = Array.isArray(data && data.channels) ? data.channels : [];
      return JSON.stringify([
        status && status.service ? [status.service.up, status.service.uptimeSec] : null,
        status && status.cli ? status.cli.mode : null,
        status && status.desktop ? status.desktop.mode : null,
        rows.map((r) => [r && r.busy, r && r.used, r && r.limit]),
      ]);
    }

    render();
    load();

    return {
      async update() {
        await load();
        /* 签名里带上「读到没有」与「上一次为什么失败」——
           否则读失败那一轮签名不变，错误态就永远画不出来。 */
        const s = signature() + "|" + (loaded ? "1" : "0") + "|" + lasterr;
        if (s !== sig) { sig = s; render(); }
      },
      refresh() { return load().then(() => { render(); }); },
    };
  },
};
