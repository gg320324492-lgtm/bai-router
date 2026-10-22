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
      /* 点格子 = 选中那家，**并跳到渠道页**。
         事件挂在盒子上（事件委托）——格子是共享组件拼出来的字符串，
         卡片不能给它逐个绑事件。监听器只在建盒子时挂一次：
         同一个盒子被第二个视图复用时不会挂两遍。
         ⚠ 为什么要点完就跳页：渠道页是主从布局（左列表 + 右详情），
           「选中」这件事的**结果**在那屏才看得见。停在总览屏只改一个
           看不见的选中态，等于点了没反应 —— 旧结构里点格子会就地展开，
           看得见；现在不跳就断了。 */
      const openChannel = (key) => {
        if (!key) return;
        if (ctx.selectChannel) ctx.selectChannel(key);
        if (ctx.setView) ctx.setView("channels");
      };
      box.addEventListener("click", (ev) => {
        const cell = ev.target && ev.target.closest ? ev.target.closest("[data-channel]") : null;
        if (!cell) return;
        openChannel(cell.getAttribute("data-channel"));
      });
      /* 键盘也要够得着：格子能点，就不能只给鼠标。
         ⚠ 光有 tabindex 不够 —— 键盘用户按 Space 不会有反应，
           那比不可达更糟：它看起来能聚焦，却按不动。所以 Enter 与 Space 都要自己接。 */
      box.addEventListener("keydown", (ev) => {
        if (!ev || (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar")) return;
        const cell = ev.target && ev.target.closest ? ev.target.closest("[data-channel]") : null;
        if (!cell) return;
        if (ev.preventDefault) ev.preventDefault();   // Space 默认会滚页
        openChannel(cell.getAttribute("data-channel"));
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
      /* 三态：还在读 / 读不到 / 没有渠道 —— 三件事不许混成一句「没有渠道」。 */
      if (!loaded) {
        body.innerHTML = kit.loadingState("正在读渠道状态…", { hint: "读完这一格就知道谁在扛请求、谁歇着。" });
        return;
      }
      if (lasterr) {
        body.innerHTML = kit.errorState("读不到渠道状态", {
          hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
          detail: lasterr,
        });
        return;
      }
      const rows = Array.isArray(data && data.channels) ? data.channels : [];
      if (!rows.length) {
        body.innerHTML = kit.emptyState("还没有渠道信息", {
          hint: "清单里还没有可用的渠道 —— 先在设置里接一家。",
        });
        return;
      }
      body.innerHTML = kit.heatmap(rows, {});
      markCells();
    }

    /* 格子能点 ⇒ 必须键盘也够得着：给 role="button" 与 tabindex="0"。
       共享组件不替卡片决定交互（它只画格子），所以这一步归卡片做。
       这里是 DOM 操作，桩环境里可能没有 querySelectorAll —— 判一下再动。 */
    function markCells() {
      const body = q('[data-role="hm-body"]');
      if (!body || typeof body.querySelectorAll !== "function") return;
      for (const cell of body.querySelectorAll("[data-channel]")) {
        if (!cell || typeof cell.setAttribute !== "function") continue;
        if (cell.getAttribute("role") === "button") continue;
        cell.setAttribute("role", "button");
        cell.setAttribute("tabindex", "0");
      }
    }

    /* 挂载时已经在读的那一次，update() 要**接着等它**而不是跳过 ——
       跳过会让首屏多显示一个轮询周期的空态（用户以为没有渠道）。 */
    function load() {
      if (pending) return pending;
      pending = (async () => {
        try {
          /* 走渲染层的**共享读法**（ctx.loadChanStates）：同一个端点全屏只拉一份。
             渠道页左栏、状态条卡、热力图卡读的是同一份数据——同屏显示的状态
             才可能是同一时刻的。 */
          const r = typeof ctx.loadChanStates === "function"
            ? await ctx.loadChanStates()
            : await ctx.api("/api/channels/state");
          if (r && r.ok === false) throw new Error(r.error || "读不到渠道状态");
          data = r || null;
          lasterr = "";
        } catch (e) {
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
        /* 签名里带上「读到没有」与失败原因 —— 否则读失败那一轮签名不变，
           错误态就永远画不出来。 */
        const s = signature() + "|" + (loaded ? "1" : "0") + "|" + lasterr;
        if (s !== sig) { sig = s; render(); }
      },
      refresh() { return load().then(() => { render(); }); },
    };
  },
};
