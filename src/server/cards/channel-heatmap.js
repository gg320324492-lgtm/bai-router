/* cards/channel-heatmap.js —— 总览屏的渠道热力图（一家一格）。
 *
 * 这张卡回答的是「**现在谁扛着、谁扛不了**」：一眼看完各家状态，
 * 不用在四张卡之间来回翻译措辞。
 *
 * ── 为什么格子交给共享组件画 ──
 *   状态的颜色与措辞由 BAI_KIT 一处定义（src/server/panel-kit.js）。
 *   这张卡自己写一份就等于又开一个真相源：改一次措辞要改两处，漏一处就漂。
 *   所以这张卡只做三件事：取数据、把数据交给 BAI_KIT.heatmap、把格子点回渠道。
 *
 * ── 三态齐全（改版 P5 的验收项）──
 *   加载中 / 有数据 / 读不到，三种情况各画各的，不拿空白冒充「没有渠道」。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["channel-heatmap"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    let box = $("channelHeatmap");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "channelHeatmap";
      box.innerHTML = `
        <div class="pb-head">
          <h3>渠道热力图</h3>
          <span class="sub">一家一格 · 点格子切到那家</span>
        </div>
        <div class="fieldset">
          <div data-role="hm-body"></div>
        </div>`;
      const viewRoot = (slot.closest && slot.closest(".view")) || slot;
      viewRoot.appendChild(box);
      /* 点格子 = 选中那家。事件挂在盒子上（事件委托）——
         格子是共享组件拼出来的字符串，卡片不能给它逐个绑事件。
         监听器只在建盒子时挂一次：同一个盒子被第二个视图复用时不会挂两遍。 */
      box.addEventListener("click", (ev) => {
        const cell = ev.target && ev.target.closest ? ev.target.closest("[data-channel]") : null;
        if (!cell) return;
        const key = cell.getAttribute("data-channel");
        if (key && ctx.selectChannel) ctx.selectChannel(key);
      });
    }
    const q = (sel) => box.querySelector(sel);

    /* 共享组件库是静态引入的（provider.html 里一个 <script>），不是卡片自己加载的 ——
       卡片是运行时动态加载的，它加载时组件库早就在页面上了。 */
    const kit = window.BAI_KIT || null;
    const esc = ctx.esc || (kit && kit.esc) || ((s) => String(s == null ? "" : s));

    let data = null;
    let lasterr = "";
    let pending = null;
    let loaded = false;
    let sig = "";

    function render() {
      const body = q('[data-role="hm-body"]');
      if (!body) return;
      if (!kit) {
        body.innerHTML = `<div class="hint" style="margin-top:12px">共享组件库没加载 —— 这一格画不出来。</div>`;
        return;
      }
      if (!loaded) {
        body.innerHTML = `<div class="hint" style="margin-top:12px">正在读渠道状态…</div>`;
        return;
      }
      const rows = Array.isArray(data && data.channels) ? data.channels : [];
      body.innerHTML = kit.heatmap(rows, { empty: "还没有渠道信息 —— 这不是出错。" });
    }

    /* 挂载时已经在读的那一次，update() 要**接着等它**而不是跳过 ——
       跳过会让首屏多显示一个轮询周期的空态（用户以为没有渠道）。 */
    function load() {
      if (pending) return pending;
      pending = (async () => {
        try {
          const r = await ctx.api("/api/channels/state");
          if (r && r.ok === false) throw new Error(r.error || "读不到渠道状态");
          data = r || null;
          lasterr = "";
        } catch (e) {
          lasterr = String((e && e.message) || e);
        } finally {
          loaded = true;
          pending = null;
        }
      })();
      return pending;
    }

    /* 只在数据真的变了时重画 —— 每 5 秒一次的轮询不该每次都重建 DOM。 */
    function signature() {
      const rows = Array.isArray(data && data.channels) ? data.channels : [];
      return JSON.stringify(rows.map((r) => [
        r.key, r.state, r.reason, r.busy, r.used, r.limit, r.ratio, r.detail,
      ]));
    }

    render();
    load();

    return {
      async update() {
        await load();
        const body = q('[data-role="hm-body"]');
        if (lasterr) {
          if (body) body.innerHTML = `<div class="hint" style="margin-top:12px">读不到渠道状态：${esc(lasterr)}</div>`;
          return;
        }
        const s = signature();
        if (s !== sig) { sig = s; render(); }
      },
      refresh() { return load(); },
    };
  },
};
