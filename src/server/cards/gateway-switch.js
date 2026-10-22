/* cards/gateway-switch.js —— 统一网关开关卡（magpie 形态：一个端口，按 provider/模型 前缀分流）。
 *
 * 这张卡只回答三个问题：
 *   ① 现在请求先到哪个端口？（统一网关 / 各家自己的中转端口）
 *   ② 打开它会改变什么、不会改变什么？（两种模式用户可见行为一致，区别只在入口）
 *   ③ 网关能分流到哪些渠道、每家能分到哪些模型？
 *
 * ── 为什么开关不做「乐观翻转」──
 * 点一下先把开关拨过去、请求发在后面，是最常见的写法，也是最坏的做法：面板会说
 * 「已切到网关」而实际根本没切（后端拒绝、重新接线失败），用户照着这句话排查半天
 * ——那比没有这个开关更坏。所以这里的顺序是：**POST 成功 → 再读一次权威状态 → 才重画**；
 * 失败就把后端给的 error 原样摆出来，开关留在真实的那一档。
 *
 * ── 渠道名一律不写死 ──
 * 渠道清单来自 ctx.channels（= 清单 window.BAI_PROVIDERS 的键集）与 ctx.chainOf()，
 * 显示名走 ctx.nameOf(key)。网关自己报回来的 providers 只用来补充「每家能分到哪些
 * 模型」；它带的名字一律不采信（服务端那份与面板清单不同步时，以清单为准）。
 *
 * ── 落点：自建面板盒，挂在所在视图的末尾 ──
 * 故障转移视图的插槽 #foPanel 由 cards/failover.js 独占（它在 mount 里直接
 * slot.innerHTML = ...）。两个卡共用一个插槽 = 后挂的那个把前一个的 DOM 整块抹掉，
 * 前一个的监听器就此失联（画面上就是「开关按了没反应」）。所以本卡另起一个盒子。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["gateway-switch"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));

    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    /* ---- 容器 ---- */
    let box = $("gwPanel");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "gwPanel";
      box.innerHTML = `
        <div class="pb-head">
          <h3>统一网关</h3>
          <span class="sub">一个端口，按模型 id 的 provider/模型 前缀分流</span>
        </div>
        <div class="fieldset">
          <div class="fohead" style="padding:0 0 10px">
            <button class="switch" type="button" data-role="gw-switch" role="switch" aria-checked="false" aria-label="开启统一网关"><i></i></button>
            <div class="foheadtxt" style="flex:1 1 300px;min-width:0">
              <b>统一网关</b>
              <span>开着时请求先到统一网关（端口 <span data-role="gw-port-inline">—</span>），网关按模型 id 的
                provider/模型 前缀分流到那一家；关着时走各家自己的中转端口。两种模式用户可见的行为一致，
                区别只在请求先到哪个端口。</span>
            </div>
          </div>
          <div class="fpline"><span class="k">当前状态</span><span class="v" data-role="gw-state">读取中…</span></div>
          <div class="fpline"><span class="k">请求去向</span><span class="v zh" data-role="gw-where">读取中…</span></div>
          <div class="fpline"><span class="k">网关端口</span><span class="v" data-role="gw-port">—</span></div>
          <div class="result" data-role="gw-result"></div>
          <div class="sechead" style="margin:16px 0 4px">
            <h2 style="font-size:12px">可分流的渠道</h2>
            <span class="note" data-role="gw-chcount"></span>
          </div>
          <div data-role="gw-chans"></div>
        </div>`;
      /* 挂到视图容器末尾（.view 由渲染层切显隐）。找不到 .view 才退回插槽本身。 */
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

    /* ---- 状态 ---- */
    let mode = null;        // "on" | "off" | null（读不到）
    let port = null;        // 网关端口
    let gproviders = [];    // 服务端报回来的 [{key,name,models}]
    let loaded = false;     // 至少成功读过一回
    let lasterr = "";       // 最近一次读失败的原因
    let inflight = false;   // GET 在飞
    let busy = false;       // POST 在飞（切换期间不许再点）

    /* 清单里认识的渠道 → 显示名；不认识的原样显示 key（不替它编名字）。 */
    const known = (k) => (ctx.channels || []).indexOf(k) >= 0;
    const nameOfKey = (k) => (known(k) ? ctx.nameOf(k) : String(k));

    /* 渠道清单：转移链（能参与路由的）打头，网关自己报的补在后面。
     * 后者**必须**也是清单里的渠道才收——否则等于相信服务端那份名单。 */
    function channelKeys() {
      const out = [], seen = new Set();
      const push = (k) => {
        const s = String(k == null ? "" : k);
        if (s && !seen.has(s)) { seen.add(s); out.push(s); }
      };
      const chain = typeof ctx.chainOf === "function" ? (ctx.chainOf() || []) : [];
      for (const k of chain) push(k);
      for (const p of gproviders) if (p && known(p.key)) push(p.key);
      return out;
    }

    function render() {
      const sw = q('[data-role="gw-switch"]');
      if (sw) {
        sw.setAttribute("aria-checked", mode === "on" ? "true" : "false");
        sw.setAttribute("aria-label", mode === "on" ? "关闭统一网关" : "开启统一网关");
        sw.disabled = busy;
        sw.style.opacity = busy ? ".55" : "";
      }

      const st = q('[data-role="gw-state"]');
      if (st) {
        st.className = "v " + (mode === "on" ? "ok" : mode === "off" ? "" : "warn");
        st.textContent = mode === "on" ? "已开启" : mode === "off" ? "已关闭" : "读不到";
      }

      const where = q('[data-role="gw-where"]');
      if (where) {
        where.textContent = mode === "on"
          ? `先到统一网关（${port == null ? "端口未知" : port}），再按模型 id 的前缀分流到那一家`
          : mode === "off"
            ? "直接走各家自己的中转端口"
            : "读不到网关状态";
      }

      const p = q('[data-role="gw-port"]');
      if (p) p.textContent = port == null ? "—" : String(port);
      const pi = q('[data-role="gw-port-inline"]');
      if (pi) pi.textContent = port == null ? "端口未知" : String(port);

      const list = q('[data-role="gw-chans"]');
      const cnt = q('[data-role="gw-chcount"]');
      if (!list) return;

      if (!loaded && lasterr) {
        if (cnt) cnt.textContent = "";
        /* 读不到 ⇒ 错误态，且**必须带下一步**：一句「读不到」是猜谜。 */
        list.innerHTML = S3("errorState", "读不到网关状态", {
          hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
          detail: lasterr,
        });
        return;
      }
      if (!loaded) {
        if (cnt) cnt.textContent = "";
        list.innerHTML = S3("loadingState", "正在读网关状态…", { hint: "读完这一块就知道请求先到哪个端口。" });
        return;
      }

      const keys = channelKeys();
      if (cnt) cnt.textContent = keys.length ? `${keys.length} 家` : "";
      if (!keys.length) {
        /* 空态要说清「怎么才会出现」：不然用户以为网关坏了。 */
        list.innerHTML = S3("emptyState", "网关暂时没有可分流的渠道", {
          hint: "先在渠道页接一家，或在设置里把上游地址改成带 provider 前缀的 —— 网关按那个前缀分流。",
        });
        return;
      }
      const rows = keys.map((k) => {
        const gw = gproviders.find((p) => p && p.key === k) || null;
        /* 模型 id 现在写的是 `provider/档位`，所以这里列**档位**（= 模型 id 的后半段）。
         * 档位后面顺带标上它当前的模型，用户才知道「这一档现在跑的是什么」。 */
        const slots = gw && Array.isArray(gw.slots) ? gw.slots.filter((s) => s && s.tier) : [];
        const models = gw && Array.isArray(gw.models) ? gw.models.filter(Boolean) : [];
        const mtxt = slots.length
          ? slots.map((s) => s.model ? `${s.tier}→${s.model}` : s.tier).join(" · ")
          : (models.length
            ? models.join(" · ")
            : (gw ? "（这一家还没有可分流的档位）" : "（网关没有接管这一家）"));
        return `<div class="fpline">
            <span class="v zh" style="flex:none;min-width:88px;font-weight:650;color:var(--ink)">${esc(nameOfKey(k))}</span>
            <span class="v" style="flex:none;color:var(--dim)">${esc(k)}/</span>
            <span class="v zh" style="flex:1;min-width:0">${esc(mtxt)}</span>
          </div>`;
      }).join("");
      list.innerHTML = rows;
    }

    /* ---- 读状态 ---- */
    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await ctx.api("/api/gateway-mode");
        if (r && r.ok === false) throw new Error(r.error || "网关状态读取失败");
        mode = (r && r.mode === "on") ? "on" : (r && r.mode === "off" ? "off" : null);
        port = (r && r.port != null) ? r.port : null;
        gproviders = Array.isArray(r && r.providers) ? r.providers : [];
        lasterr = "";
        loaded = true;
      } catch (e) {
        lasterr = String((e && e.message) || e);
        loaded = false;
      } finally {
        inflight = false;
        render();
      }
    }

    /* ---- 切换 ---- */
    async function toggle() {
      if (busy) return;
      const next = mode === "on" ? "off" : "on";
      busy = true;
      render();
      const slot2 = q('[data-role="gw-result"]');
      try {
        const r = await ctx.postJSON("/api/gateway-mode", { mode: next });
        /* 服务端也可能用 200 回 ok:false —— 那也算没切，如实说。 */
        if (r && r.ok === false) throw new Error(r.error || "切换失败");
        const warns = r && Array.isArray(r.warnings) ? r.warnings : [];
        const head = next === "on"
          ? "✔ 已切到统一网关：请求现在先到网关端口，再按模型 id 的前缀分流"
          : "✔ 已切回各家自己的中转端口";
        if (ctx.showResult) ctx.showResult(slot2, warns.length ? head + "\n" + warns.map((w) => "· " + w).join("\n") : head, true);
      } catch (e) {
        /* 后端的 error 原样转述：静默失败比报错更坏（用户会以为切了）。 */
        if (ctx.showResult) ctx.showResult(slot2, "切换失败：" + String((e && e.message) || e), false);
      } finally {
        busy = false;
        /* 成败都重新读一次权威状态：成功了要更新端口/渠道，失败了要把开关拨回真实的那一档。 */
        await load();
      }
    }

    const sw = q('[data-role="gw-switch"]');
    if (sw) sw.addEventListener("click", () => { toggle(); });

    render();
    load();

    /* ---- 刷新节奏 ----
     * 共享层每 5 秒轮询一次（panel-common.js 的 setInterval(poll, 5000) → cards.update()），
     * 本卡**不**自己另起一个定时器：两个节奏会打架（一个先到、一个后到，画面上的数会来回跳）。
     * 视图不在眼前时就不读——省下的是本机的一次本地 HTTP，不是用户的等待。 */
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
