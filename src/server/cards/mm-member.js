/* cards/mm-member.js —— 「会员额度通道」卡（v1.0.89）。
 *
 * 这一格与别家**不是一回事**，所以必须有一张自己的卡把话说清楚：
 *
 *   ① 它走的是 **MiniMax 会员额度**（MiniMax Code 登录的那个账号自带的免费/会员额度），
 *      **不是**开放平台按量计费的 API Key。两者的账单、限额、失效方式全不一样，
 *      混成一句「MiniMax」会让人以为充了钱就无限用。
 *   ② 凭据**不是用户填的**，是从本机 **MiniMax Code 的登录态**里拿的。
 *      所以「没登录」不是「没填 key」，处置是回客户端登录，不是找输入框。
 *   ③ 令牌**只存在内存**：不写 config.json、不写日志、面板上也看不到明文。
 *      代价是**重启路由台要重新读**（重新登录 MiniMax Code 即可恢复）——这条必须说在前面。
 *   ④ 上游真正挑刺的只有两处：**鉴权令牌**与**工具定义的形状**。
 *     请求头（UA / Origin / Referer）和 system prompt **都不是校验对象**——
 *     2026-10-19 实测过 9 种头组合与 4 种 system prompt 形状，全部 200。
 *     中转照样全套发头是为了与真客户端一致，但**别把它当成「缺了就 401」的原因**：
 *     那样一旦上游改了规则，就会跑去调一个根本不相关的东西。
 *
 * ── 这张卡只画「清单声明了 memberQuota 的渠道」的那一格 ──
 * 状态（有没有读到登录态 / 令牌还有多久 / 是否已失效）全部来自 /api/status 的
 * `<渠道>.token`；渲染层因此既不需要认识渠道名，也不需要认识令牌（C11）。
 *
 * 导出 renderMemberPanel 为纯函数给 scripts/mm-auth-test.mjs 直接求值
 * （vm 里只挂一个空 window，测试不碰真实 DOM）。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["mm-member"] = {
  /* ================================================================== *
   * 纯函数区（无 DOM、无网络，测试直接调）
   * ================================================================== */

  /**
   * 画这一格。**纯函数**：只认传进来的数据，不读全局、不碰 DOM。
   *
   * @param {object} token /api/status 的 `<渠道>.token`（**不含令牌值**）
   * @param {object} [o]
   * @param {string} [o.name]      渠道显示名
   * @param {string} [o.hint]      服务端给的一句话提示（凭据行那边也用同一句）
   * @param {string} [o.upstream]  上游地址
   * @param {Function} [esc]
   * @returns {string} HTML
   */
  renderMemberPanel(token, o = {}) {
    const esc = o.esc || ((s) => String(s == null ? "" : s).replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
    const t = token || {};
    const name = o.name || "该渠道";

    /* 状态一行。**不显示令牌本身**——只说"读到了没有 / 还剩多久 / 是否已失效"。 */
    let state, stateCls;
    if (t.invalid === true) {
      state = "登录态已失效"; stateCls = "err";
    } else if (!t.configured) {
      state = "未读到登录态"; stateCls = "idle";
    } else if (t.expiresInSec != null && t.expiresInSec <= 0) {
      state = "已过期，等续期"; stateCls = "warn";
    } else {
      state = "已读到"; stateCls = "ok";
    }
    const remainTxt = t.expiresInSec != null
      ? `访问令牌还剩约 ${Math.max(0, Math.round(t.expiresInSec / 60))} 分钟（到期自动续期）`
      : "";

    return `<div class="fieldset">
      <div class="fpline"><span class="k">额度性质</span><span class="v ${stateCls}">${esc(state)}</span></div>
      <div class="fpline"><span class="k">计费口径</span><span class="v">会员额度（MiniMax Code 登录的账号自带）· <b>不是</b>开放平台按量计费</span></div>
      <div class="fpline"><span class="k">凭据来源</span><span class="v">本机 <b>MiniMax Code</b> 的登录态（不是手填的 key）</span></div>
      <div class="fpline"><span class="k">令牌存放</span><span class="v">只在内存里 · 不落 config.json · 日志与页面都没有明文</span></div>
      ${remainTxt ? `<div class="fpline"><span class="k">有效期</span><span class="v">${esc(remainTxt)}</span></div>` : ""}
      ${t.renewCount ? `<div class="fpline"><span class="k">已续期</span><span class="v">${esc(String(t.renewCount))} 次</span></div>` : ""}
      ${t.authPath ? `<div class="fpline"><span class="k">登录态文件</span><span class="v" style="font-family:var(--mono);white-space:normal;word-break:break-all">${esc(t.authPath)}</span></div>` : ""}
      ${o.upstream ? `<div class="fpline"><span class="k">上游</span><span class="v" style="font-family:var(--mono);white-space:normal;word-break:break-all">${esc(o.upstream)}</span></div>` : ""}
      ${t.error ? `<div class="hint" style="margin-top:8px;color:var(--err);white-space:pre-wrap">${esc(t.error)}</div>` : ""}
      ${o.hint ? `<div class="hint" style="margin-top:8px;white-space:pre-wrap">${esc(o.hint)}</div>` : ""}
      <div class="hint" style="margin-top:9px;white-space:pre-wrap">
        <b>怎么才能用起来</b>：先在 <b>MiniMax Code</b> 里登录（凭据就是从它的登录态拿的），
        回到本页点凭据行上的「重新读取登录态」，再点这一格的「接入」。
      </div>
      <div class="hint" style="margin-top:7px;white-space:pre-wrap">
        <b>令牌只存在内存</b>：路由台退出即失效，磁盘上没有任何副本（连 config.json 都不写）。
        所以<b>重启路由台后要重新读一次</b>——重新登录 MiniMax Code 即可恢复，
        不需要（也不应该）去别处找明文。
      </div>
      <div class="hint" style="margin-top:7px;white-space:pre-wrap">
        <b>上游到底挑什么刺</b>：实测只有两处会拒绝——<b>鉴权令牌</b>（必须是
        <code>authorization: Bearer</code>）与<b>工具定义的形状</b>（要扁平的
        <code>{type, name, input_schema}</code>，中转已自动转换）。
        <b>请求头和 system prompt 都不是校验对象</b>，去掉照样能通。
        所以这一格出问题时先看这两处，而不是去调 UA。
      </div>
    </div>`;
  },

  /** 清单里声明了才画。**只有真值算数**——渲染层不许自己决定要不要画这一格。 */
  shouldShow(P) {
    return !!(P && P.memberQuota === true);
  },

  /* ================================================================== *
   * 挂载
   * ================================================================== */
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const MANIFEST = window.BAI_PROVIDERS || {};
    const NAME = "mm-member";
    const self = this;

    /* 落点：与「凭据」同一区的下方（映射编辑卡之下、诊断抽屉之上）。
       清单里声明了 memberQuota 的渠道才显示它；换到别的渠道就收起来。 */
    let panel = $(NAME);
    if (!panel) {
      const anchor = $("mapPanel");
      panel = document.createElement("div");
      panel.className = "panelbox";
      panel.id = NAME;
      panel.style.display = "none";
      panel.innerHTML = `<div class="pb-head"><h3>会员额度通道</h3><span class="sub">凭据从本机客户端登录态取，令牌只在内存</span></div>`;
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

    function paint() {
      const P = declared();
      if (!P) { panel.style.display = "none"; return; }
      panel.style.display = "";
      const S = ctx.stOf(key()) || {};
      body.innerHTML = self.renderMemberPanel(S.token || null, {
        name: ctx.nameOf(key()),
        hint: S.tokenHint || "",
        upstream: (S.upstream || {}).host || "",
        esc: ctx.esc,
      });
    }

    paint();
    return {
      update() { paint(); },
      refresh() { paint(); },
    };
  },
};
