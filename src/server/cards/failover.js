/* cards/failover.js —— 故障转移视图的主体（契约 v17 · 里程碑 4）。
 *
 * v17 之前这是「自动故障转移卡」：自带 .card.foldable 折叠壳，挂在 #slot-extra，
 * 每家提供方页面各挂一份（同一件事挂了七遍）。现在它**归故障转移视图所有**——
 * providers.js 的 window.BAI_VIEWS[fo].cards 点名它，视图容器 #viewFo 里的 #foPanel
 * 是挂载点。折叠壳由视图提供，卡片不再自带。
 *
 * 视图已提供「什么情况不会转移」那块说明，所以本卡只负责三件事：
 *   1) 总开关
 *   2) 顺序（↑↓ 调序，不再是逗号分隔的文本框）
 *   3) 每家的冷却倒计时
 *
 * 渠道名单一律从 ctx.channels + ctx.chainOf() 取，**不写死任何渠道名**。
 * 链序真实值来自 config.failover.chain（全局配置，不在清单条目里）。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["failover"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));
    const slot = ctx.slot || $("foPanel") || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    const MANIFEST = window.BAI_PROVIDERS || {};
    /* 可进链的渠道（chainable）。顺序按清单书写序，即出厂默认的链序。 */
    const POOL = (ctx.channels || Object.keys(MANIFEST))
      .filter((k) => (MANIFEST[k] || {}).chainable === true);

    slot.innerHTML = `
      <div class="fohead">
        <button class="switch" id="ckFailover" role="switch" aria-checked="false" aria-label="开启自动故障转移"><i></i></button>
        <div class="foheadtxt">
          <b>自动故障转移</b>
          <span>当前渠道 429 / 5xx / 超时 / 断线时，中转按下面的顺序自己换人</span>
        </div>
        <span class="spacer"></span>
        <span class="monote" id="foAux"></span>
      </div>
      <div class="seq" id="foSeq"></div>
      <div class="cooldown" id="foCool"></div>
      <div class="saverow">
        <button class="btn sm" id="btnSaveFo" type="button">保存顺序</button>
        <span class="fpline" style="border:0;padding:0"><span class="v zh">改完点保存立即生效，无需重启服务</span></span>
      </div>
      <div class="result" id="foResult"></div>`;

    /* 链序草稿：用户调序期间只改内存，点保存才落盘 */
    let draft = null;
    let enabled = false;
    let cooling = {};

    const order = () => {
      const cur = ctx.chainOf();
      const base = cur.length ? cur.filter((k) => POOL.includes(k)) : POOL.slice();
      for (const k of POOL) if (!base.includes(k)) base.push(k);   // 没进链的补在链尾
      return base;
    };

    function render() {
      if (!draft) draft = order();
      /* 池子变了（渠道增删）就把草稿对齐一次，避免留下一份对不上的序 */
      if (draft.length !== POOL.length || draft.some((k) => !POOL.includes(k))) draft = order();

      const sw = $("ckFailover");
      if (sw) sw.setAttribute("aria-checked", String(enabled));

      const seq = $("foSeq");
      if (seq) {
        seq.innerHTML = draft.map((k, i) => {
          const st = ctx.channelState(k);
          const cool = cooling[k];
          return `<span class="node${i === 0 ? " first" : ""}" data-k="${esc(k)}" data-i="${i}">
              <span class="no">${i + 1}</span>
              <span class="nm">${esc(ctx.nameOf(k))}</span>
              ${cool ? `<span class="cool">${Math.max(0, cool.leftSec | 0)}s</span>` : ""}
              <span class="ops">
                <button type="button" data-mv="up" title="上移"${i === 0 ? " disabled" : ""}>▲</button>
                <button type="button" data-mv="down" title="下移"${i === draft.length - 1 ? " disabled" : ""}>▼</button>
              </span>
            </span>${i === draft.length - 1 ? "" : '<span class="sep">→</span>'}`;
        }).join("");
      }

      const aux = $("foAux");
      if (aux) aux.textContent = enabled ? `已开启 · ${draft.length} 个候选` : "当前已关闭（不会自动换渠道）";

      const cool = $("foCool");
      if (cool) {
        const ks = Object.keys(cooling).filter((k) => (cooling[k].until || 0) * 1000 > Date.now());
        if (!ks.length) { cool.innerHTML = ""; cool.style.display = "none"; }
        else {
          cool.style.display = "";
          cool.innerHTML = '<span class="k">冷却中</span>'
            + ks.map((k) => {
              return `<span class="crow_"><b>${esc(ctx.nameOf(k))}</b> ${Math.max(0, cooling[k].leftSec | 0)}s`
                + (cooling[k].lastErr ? ` · ${esc(cooling[k].lastErr)}` : "") + "</span>";
            }).join("");
        }
      }
    }

    /* --- 事件 --- */
    const sw = $("ckFailover");
    if (sw) sw.addEventListener("click", () => {
      enabled = sw.getAttribute("aria-checked") !== "true";
      render();
    });

    const seq = $("foSeq");
    if (seq) seq.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mv]");
      if (!btn) return;
      const node = btn.closest(".node");
      if (!node) return;
      const i = Number(node.getAttribute("data-i"));
      const j = btn.dataset.mv === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= draft.length) return;
      const t = draft[i];
      draft[i] = draft[j];
      draft[j] = t;
      render();
    });

    $("btnSaveFo").addEventListener("click", () => ctx.withBusy($("btnSaveFo"), async () => {
      const r = await ctx.postJSON("/api/config", { failover: { enabled, chain: draft } });
      ctx.showResult($("foResult"),
        "✔ 已保存：故障转移已" + (enabled ? "开启" : "关闭")
        + "，链序 " + draft.map((k) => ctx.nameOf(k)).join(" → ") + "（立即生效）", true);
      if (typeof ctx.poll === "function") ctx.poll();
      if (r && r.messages && r.messages.length) draft = order();
    }));

    render();

    return {
      /* 轮询刷新：只读状态（开关与顺序在草稿里，用户没点保存前不被覆盖）。
         cooling[k] 来自 failoverSnapshot()：{cooldownLeftSec, lastErr, quota}，
         是**剩余秒数**不是绝对时间戳——每轮 poll 由服务端重新下发，直接显示即可。 */
      update(status) {
        const f = (status && status.failover) || {};
        if (typeof f.enabled === "boolean") enabled = f.enabled;
        const c = f.cooling || {};
        const next = {};
        for (const k of Object.keys(c)) {
          const v = c[k] || {};
          next[k] = { leftSec: Number(v.cooldownLeftSec) || 0, lastErr: v.lastErr || "" };
        }
        cooling = next;
        render();
      },
      refresh() { render(); },
    };
  },
};