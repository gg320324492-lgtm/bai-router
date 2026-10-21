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

/* 「静默换人」提示文案（v1.0.88）。
 *
 * 为什么它得单独立一个函数、还要能被测试原样抠出来跑：
 * 这条提示的全部价值在于**说人话**。「故障转移」「降级」「旁路」这些词用户读不出
 * 「我的钱花到哪儿去了」，所以这里只陈述三件事实 + 一条可执行的下一步：
 *   ① 你选的是谁  ② 实际回答你的是谁  ③ 换了几次、什么时候
 * 入口与实际服务渠道**相同时**必须一个字都不提示——天天误报的告警比不报更坏，
 * 用户会学会无视它（这是本项目在 served/target 那条上已经吃过的亏）。
 *
 * @param sj          /api/status 的 status.failover.silentJump
 * @param nameOf      渠道键 → 显示名（调用方从清单拿，本文件不认识任何渠道名）
 * @param badgeKindOf 渠道键 → 清单里 badge.kind，用来判「这一跳要不要花钱」
 * @returns {level,title,lines,advice} 或 null（不该提示时返回 null）
 */
function jumpAdvice(sj, nameOf, badgeKindOf) {
  const act = sj && Array.isArray(sj.active)
    ? sj.active.filter((e) => e && e.from && e.to && e.from !== e.to)
    : [];
  if (!act.length) return null;

  /* 「要花钱」只认 `e.costs` ——**服务端按那个模型自己的 credits 算好的结论**
   * （true=计费 / false=免费 / null=查不到）。
   *
   * ⚠ v1.0.88 实测打脸过一次：**不能用渠道的 badge.kind 判**。
   * providers.js 里 `kind:"cn"` 同时挂在「境内付费」(sn) 和「0 积分」(wb) 两家身上，
   * 它表示**境内**不是**收费**。按它判，会把 WorkBuddy 的 0 积分模型
   * （实测 hy3、step-5-preview 都是 credits=x0.00）报成「在你的账上花钱」——
   * **误报比不报更坏**：用户会为一个不存在的扣费去排查、去改配置。
   * badgeKindOf 只留给「渠道是什么」这类描述性文案，不参与计费判断。 */
  const costs = (e) => e.costs === true;

  /* 挑最该被看见的那一条：确实计费的优先，其次窗口内次数多的。 */
  let worst = null;
  for (const e of act) {
    const c = costs(e);
    if (!worst || (c && !costs(worst)) || (c === costs(worst) && (e.count || 0) > (worst.count || 0))) worst = e;
  }
  const money = costs(worst);
  const now = Date.now();
  const ago = (iso) => {
    const m = Math.max(0, Math.round((now - Date.parse(iso || "")) / 60000));
    if (!isFinite(m)) return "时间未知";
    if (m < 1) return "刚刚";
    if (m < 60) return `${m} 分钟前`;
    if (m < 60 * 24) return `${Math.round(m / 60)} 小时前`;
    return `${Math.round(m / 1440)} 天前`;
  };
  const wmin = sj.windowMin > 1 ? Math.round(sj.windowMin / 60) : 1;

  const lines = [];
  const c60 = worst.count || 0;
  lines.push(c60 > 0
    ? `最近 ${wmin} 小时发生 ${c60} 次${sj.total ? `，本次启动以来累计 ${sj.total} 次` : ""}`
    : `本次启动以来累计 ${sj.total || 0} 次，最近一次在 ${ago(worst.lastAt)}`);
  /* 「最近一次」已经写在上面那行里就别重复一遍。 */
  if (c60 > 0) lines.push(`最近一次：${ago(worst.lastAt)}`);
  if (worst.model) lines.push(`实际发出去的模型：${worst.model}`);
  if (money) {
    lines.push(`${nameOf(worst.to)} 是计费渠道——上面这些对话是在它的账上完成的，不是在你选的那家。`);
  }
  const others = act.length - 1;
  if (others > 0) lines.push(`另有 ${others} 种组合也在换人，往下拉能看到逐条记录。`);

  return {
    level: money ? "err" : "warn",
    title: `你选的是 ${nameOf(worst.from)}，实际回答你的是 ${nameOf(worst.to)}`,
    lines,
    advice: money
      ? `想让每一句都走 ${nameOf(worst.from)}：把 ${nameOf(worst.to)} 从下面那条顺序里删掉，`
      + `或者直接关掉「自动故障转移」——关掉之后 ${nameOf(worst.from)} 一失败就会把错误原样报给你，不会有人替你接手。`
      : `想让每一句都走 ${nameOf(worst.from)}：把它后面的候选从下面那条顺序里删掉，`
      + `或者关掉「自动故障转移」——关掉之后失败会原样报给你，不会有人替你接手。`,
  };
}

/** 记录最近一次拿到的提示，供 refresh() 复用（切视图回来时不必等下一轮轮询）。 */
let lastJump = null;

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

    const nameOf = (k) => (MANIFEST[k] && (MANIFEST[k].name || MANIFEST[k].shortName)) || k;
    const badgeKindOf = (k) => ((MANIFEST[k] || {}).badge || {}).kind || "";

    slot.innerHTML = `
      <div class="jumpalarm" id="foJump" hidden></div>
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

    /* 静默换人提示。画在**最顶上、开关之前**，不塞进任何折叠区：
       这条信息的意思是「你以为在用的那家没有回答你」，把它藏在需要点开的地方，
       等于没报。 */
    function renderJump() {
      const box = $("foJump");
      if (!box) return;
      const adv = jumpAdvice(lastJump, nameOf, badgeKindOf);
      if (!adv) { box.hidden = true; box.innerHTML = ""; return; }
      box.hidden = false;
      box.className = "jumpalarm " + adv.level;
      box.innerHTML = `
        <div class="jhead"><span class="jico">!</span><b>${esc(adv.title)}</b></div>
        <div class="jlines">${adv.lines.map((l) => `<div>${esc(l)}</div>`).join("")}</div>
        <div class="jadvice">${esc(adv.advice)}</div>`;
    }

    /* 链序草稿 + 开关：用户动过就只留在内存里，点保存才落盘。 */
    let draft = null;
    let enabled = false;
    let cooling = {};
    /* dirty = 「用户在这张卡上动过手，还没保存」。
     *
     * 为什么必须有它（v1.0.88 修的真 bug）：panel-common.js 每 5 秒轮询一次并把
     * 响应交给 update()。从前的 update() 无条件 `enabled = f.enabled`，于是
     * 「点开关关掉 → 最多 5 秒后被服务端旧值盖回开启」——面板在不听用户的话。
     * 这不是配色小毛病：这个模块刚被证明会**静默**把用户选的渠道换成另一家，
     * 用户正是因此才来查这个开关的。
     *
     * ⚠ dirty 同时保护 draft。draft 以前只是**恰好**没被 update() 写（巧合，不是
     *   设计保证）；这里把它纳入同一道闸，以后谁在 update() 里补一行 `draft = order()`
     *   也踩不到同一个坑。 */
    let dirty = false;

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

      /* 静默换人提示画在最顶上，且不受 dirty 影响——它是「服务端刚报的事实」，
         不是用户正在编辑的草稿，不该被本地改动挡住。 */
      renderJump();

      const cool = $("foCool");
      if (cool) {
        /* ⚠ v1.0.88 修：原来这里筛的是 `cooling[k].until` —— 但 update() 映射出来的
         * 字段是 **leftSec**（failover.mjs 的 failoverSnapshot 给的原始名是
         * `cooldownLeftSec`，到这儿已经换过两次了）。`until` 恒为 undefined，
         * 于是筛选恒为空，**这行「冷却中」汇总从来没显示过**——而下面第 210 行
         * 用的恰恰是 leftSec，同一段代码里两个名字并存，坏的那个还没人碰。
         * 判据改用 leftSec（它就是剩余秒数，不用再乘 1000）。 */
        const ks = Object.keys(cooling).filter((k) => (cooling[k].leftSec || 0) > 0);
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
      dirty = true;          // 用户的意愿高于下一轮轮询读到的服务端旧值
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
      dirty = true;
      render();
    });

    $("btnSaveFo").addEventListener("click", () => ctx.withBusy($("btnSaveFo"), async () => {
      const r = await ctx.postJSON("/api/config", { failover: { enabled, chain: draft } });
      ctx.showResult($("foResult"),
        "✔ 已保存：故障转移已" + (enabled ? "开启" : "关闭")
        + "，链序 " + draft.map((k) => ctx.nameOf(k)).join(" → ") + "（立即生效）", true);
      /* 落盘成功 ⇒ 手上这份就是权威，清脏，下一轮起重新听服务端的。 */
      dirty = false;
      if (typeof ctx.poll === "function") ctx.poll();
      if (r && r.messages && r.messages.length) draft = order();
    }));

    render();

    return {
      /* 轮询刷新。
       *
       * 🔴 v1.0.88 修正了一条**与代码相反**的注释。旧注释写的是「开关与顺序在草稿里，
       * 用户没点保存前不被覆盖」——可代码里 `enabled = f.enabled` 是**无条件**赋值，
       * 于是每 5 秒（panel-common.js 的 setInterval(poll, 5000)）就把用户刚点的开关
       * 盖回服务端旧值。这就是「关掉之后会自动打开」的全部原因。
       *
       * 现在的契约：**dirty 期间开关与链序都只认用户手上的那份**；保存成功后清脏，
       * 此后照常跟随服务端。冷却倒计时与静默换人提示不在 dirty 管辖内——它们是服务端
       * 的实时事实，不该被「用户正在编辑」挡住。 */
      update(status) {
        const f = (status && status.failover) || {};
        /* 静默换人（v1.0.88）：无条件收下，它是事实不是草稿。 */
        lastJump = f.silentJump || null;
        if (!dirty && typeof f.enabled === "boolean") enabled = f.enabled;
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
      /* 测试与排查用：读回 dirty。不导出副作用，读不到就白测了。 */
      _isDirty() { return dirty; },
    };
  },
};