/* cards/wb-pool.js —— 「账号池」状态卡（v1.0.77）。
 *
 * 回答的是四个问题，每一个的答案都在服务端算完了：
 *   ① 池里有几个账号（**必须与遍历到的条目数一致** —— 见下方「计数纪律」）
 *   ② 每个账号现在能不能用、为什么不能、**该做什么**
 *   ③ 本次选中了谁、**谁被跳过了**
 *   ④ 最近一次 429 时「同名的付费行」在哪一行
 *
 * ── 这张卡只画「清单声明了 accountPool 的渠道」的那一格 ──
 * 状态、处置指引、reason 的中文标签全部来自 /api/status 的 `<渠道>.pool`；
 * 渲染层因此既不需要认识渠道名，也不需要认识 reason 码（C11）。
 *
 * ── 计数纪律（xdpool 作者踩过的坑）──
 * 「磁盘 4 个文件、界面 2 个账号」用户是说不清的。所以这里的表头**直接印服务端的
 * total**，行数也**由同一个 accounts 数组**渲染 —— 两处一旦对不上，渲染出来的
 * 「3 / 3」就是假的。而且 total 由服务端算（见 wbPoolStatus），渲染层不重数一遍：
 * 重数一遍就是多一个能漂移的地方。
 *
 * ── 每种不可用的处置**互不相同**，不许合并成一句 ──
 * 判死要重新登录、额度用尽要充值、限流等一会、停用去面板打开、移出去加回来——
 * 五句话混成一句「请重新登录」，就是 dsh-xdpool 1.7.7 事故的形态
 * （限流被说成密钥无效，用户跑去重新登录一个根本没坏的账号）。
 *
 * 导出 renderPoolPanel 为纯函数给 scripts/wb-pool-wiring-test.mjs 直接求值
 * （vm 里只挂一个空 window，测试不碰真实 DOM）。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["wb-pool"] = {
  /* ================================================================== *
   * 纯函数区（无 DOM、无网络，测试直接调）
   * ================================================================== */

  /**
   * 画这一格。**纯函数**：只认传进来的数据，不读全局、不碰 DOM。
   *
   * @param {object} pool /api/status 的 `<渠道>.pool`
   * @param {{label?:string, rows?:Array}} [paidHint] 最近一次 429 的「同名付费行」
   * @param {Function} [esc]
   * @param {object} [kit] 共享组件库（window.BAI_KIT）。**传进来才有三态**：
   *   这个纯函数在单测里被直接求值（vm 里只有一个空 window），那时没有组件库。
   * @returns {string} HTML
   */
  renderPoolPanel(pool, paidHint, esc, kit) {
    const e = esc || ((s) => String(s == null ? "" : s).replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
    const p = pool || {};
    const accounts = Array.isArray(p.accounts) ? p.accounts : [];
    /* ★ 表头印的是**服务端给的** total，不是 accounts.length —— 服务端已经保证
     *   两者相等（同一个数组算出来的），渲染层不重数一遍以免多一个能漂移的地方。 */
    const total = Number.isFinite(p.total) ? p.total : accounts.length;

    if (!total) {
      /* 空态：池子里一把都没有。**空 ≠ 出错** —— 说清「怎么才会出现」：
         用户得知道要先在上面填令牌，不是去查故障。 */
      if (kit && kit.emptyState) {
        return kit.emptyState("账号池里还没有账号", {
          hint: p.hint || "先在上面填一把访问令牌 —— 抓到一个账号之后，这里会逐个列出它能不能用、不能用了该做什么。",
        });
      }
      return `<div class="fieldset">
        <div class="fpline"><span class="k">账号池</span><span class="v">空</span></div>
        <div class="hint" style="margin-top:8px;white-space:pre-wrap">${e(p.hint || "")}</div>
      </div>`;
    }

    const cls = (a) => (a.available ? "ok" : (/判死|移出|未填/.test(String(a.reasonLabel || "")) ? "err" : "warn"));
    const rows = accounts.map((a, i) => {
      const until = a.until
        ? `<div class="fpline"><span class="k">到点</span><span class="v">${e(new Date(a.until).toLocaleString("zh-CN", { hour12: false }))}</span></div>`
        : "";
      const stuck = a.heldSessions > 0
        ? `<div class="fpline"><span class="k">粘住</span><span class="v">${e(String(a.heldSessions))} 段对话</span></div>` : "";
      const stale = a.stale ? `<div class="fpline"><span class="k">凭据</span><span class="v warn">很久没刷新了（仍可用）</span></div>` : "";
      return `<div class="ocopt${a.available ? " on" : ""}" data-role="wb-pool-row">
        <span class="body">
          <span class="t">${e((Number.isFinite(a.no) && a.no ? a.no : i + 1) + ". " + (a.label || a.id))}${a.synthetic ? "（老配置合成的单条目）" : ""}</span>
          <span class="v ${cls(a)}">${e(a.reasonLabel || a.reason || "")}</span>
          <span class="d">${e(a.remedy || "")}</span>
          ${until}${stuck}${stale}
        </span>
      </div>`;
    }).join("");

    const last = p.last;
    const lastLine = !last ? "" : last.ok
      ? `<div class="fpline"><span class="k">本次选中</span><span class="v ok">${e(last.label || last.accountId || "")}${last.how ? "（" + e(last.how) + "）" : ""}</span></div>
         <div class="fpline"><span class="k">可用/总数</span><span class="v">${e(String(last.eligible))} / ${e(String(last.total))}</span></div>`
      : (kit && kit.errorState
        /* 上次选号失败：错误态**必须带下一步** ——「该做什么」就是下一步，
           少了它用户只能自己猜这个号是不是该重新登录。 */
        ? kit.errorState("上次选号失败", {
          hint: last.remedy || "按下面这一条处置说明处理，处理完点「重新获取令牌」再试。",
          detail: last.reasonLabel || "",
        })
        : `<div class="fpline"><span class="k">上次选号</span><span class="v err">${e(last.reasonLabel || "")}</span></div>
         <div class="fpline"><span class="k">该做什么</span><span class="v zh">${e(last.remedy || "")}</span></div>`);
    const skipped = last && Array.isArray(last.skipped) && last.skipped.length
      ? `<div class="fpline"><span class="k">本次被跳过</span><span class="v">${e(last.skipped.map((s) => (s.label || s.id) + "（" + (s.reason || "") + "）").join("、"))}</span></div>`
      : `<div class="fpline"><span class="k">本次被跳过</span><span class="v">无</span></div>`;

    const paid = paidHint && paidHint.text
      ? `<div class="hint" style="margin-top:9px;white-space:pre-wrap"><b>同名付费行</b>：${e(paidHint.text)}</div>` : "";

    return `<div class="fieldset">
      <div class="fpline"><span class="k">账号池</span><span class="v ok">${e(String(total))} 个账号 · ${e(p.mode || "")}${p.synthetic ? " · 单账号（与池化之前逐字一致）" : ""}</span></div>
      <div class="ocopts" data-role="wb-pool-list">${rows}</div>
      <div data-role="wb-pool-last">${lastLine}${skipped}</div>
      ${paid}
      <div class="hint" style="margin-top:9px;white-space:pre-wrap">${e(p.hint || "")}</div>
    </div>`;
  },

  /** 清单里声明了才画。**只有布尔 true 算数**——渲染层不许自己决定要不要画这一格。 */
  shouldShow(P) {
    return !!(P && P.accountPool === true);
  },

  /* ================================================================== *
   * 挂载
   * ================================================================== */
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const MANIFEST = window.BAI_PROVIDERS || {};
    const NAME = "wb-pool";
    const self = this;

    /* 落点：与「凭据」同一区的下方（映射编辑卡之下、诊断抽屉之上）。
       清单里声明了 accountPool 的渠道才显示它；换到别的渠道就收起来。 */
    let panel = $(NAME);
    if (!panel) {
      const anchor = $("mapPanel");
      panel = document.createElement("div");
      panel.className = "panelbox";
      panel.id = NAME;
      panel.style.display = "none";
      panel.innerHTML = `<div class="pb-head"><h3>账号池</h3><span class="sub">同一段对话粘一个号，用不了才换</span></div>`;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
      else document.body.appendChild(panel);
    }

    const body = document.createElement("div");
    panel.appendChild(body);

    const key = () => ctx.channel || "";
    const declared = () => {
      const P = MANIFEST[key()] || {};
      return self.shouldShow(P) ? P : null;
    };

    /* 三态（空 / 错 / 加载）统一走共享组件：措辞与结构只在 panel-kit.js 定义一次。
       组件库不在时降级成一句提示 —— 整块空白比降级更坏。 */
    const kit = window.BAI_KIT || null;

    function paint(status) {
      const P = declared();
      if (!P) { panel.style.display = "none"; return; }
      panel.style.display = "";
      const st = status || ctx.status;
      /* ⚠ 服务端状态还没到 ⇒ 说「在读」。**不能**当成「池子里没有账号」：
         那个结论要的是「真的读过了、确实一把都没有」，不是「还没读」。 */
      if (!st) {
        body.innerHTML = kit
          ? kit.loadingState("正在读账号池…", { hint: "读完这一块就知道池里有几个账号、现在能不能用。" })
          : "";
        return;
      }
      const S = ctx.stOf(key()) || {};
      body.innerHTML = self.renderPoolPanel(S.pool || null, S.paidHint || null, ctx.esc, kit);
    }

    paint();
    return {
      update(status) { paint(status); },
      refresh() { paint(ctx.status); },
    };
  },
};