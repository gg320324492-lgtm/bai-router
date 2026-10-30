/* cards/model-catalog.js —— 凭据视图里「作业令牌（jobToken）」那一行的说明面板。
 *
 * v17 之前这里是两张卡：Zen 的「模型目录」与 Qoder 的「令牌从哪来」。单页改版后：
 *   · 令牌那块**保留并归位**——它讲的是「凭据从哪来」，正是凭据视图要回答的问题，
 *     按 credential.kind = "jobToken" 自认领同类行，不写死渠道名。
 *   · Zen 的公开模型目录**不再单列**：那是信息不是凭据，且下拉框本来只列真能
 *     调通的模型，公开目录的绝大多数被上游按产品策略锁住，摆在凭据视图里会误导。
 *     想看完整目录用映射编辑区的「刷新模型列表」。
 *
 * 与渲染层的分工（不重复）：
 *   渲染层给「状态徽章 + 一键装补丁 / 还原客户端」两个动作；
 *   本卡给「令牌为什么会轮换 / 存在哪 / 补丁到底装没装」的逐条说明与细分状态。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["model-catalog"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));
    const hosts = (typeof ctx.rowsOfKind === "function" ? ctx.rowsOfKind("jobToken") : []) || [];
    if (!hosts.length) return { update() { }, refresh() { } };

    const MANIFEST = window.BAI_PROVIDERS || {};
    /* 三态（空 / 错 / 加载）统一走共享组件：措辞与结构只在 panel-kit.js 定义一次。
       组件库不在时降级成一句提示 —— 整块空白比降级更坏。 */
    const kit = window.BAI_KIT || null;
    const S3 = (kind, text, opts) => (kit
      ? kit[kind](text, opts)
      : '<div class="hint">' + esc(text) + "</div>");
    const scoped = hosts.map((host) => {
      const row = host.closest(".credrow");
      const key = row && row.dataset ? row.dataset.k : null;
      const name = key ? ctx.nameOf(key) : "该渠道";
      /* ⚠ **凭据自取型**的行（清单声明了 credentialReadonly）**不在本卡的射程内**。
       * 本卡讲的是「令牌每次客户端启动都会轮换 / 存在哪 / 补丁装没装」——那是 Qoder
       * （worker 补丁 + 令牌文件）那一类的形状。自取型那一类（会员登录态）没有补丁、
       * 令牌也不在文件里，它有自己的一张卡（mm-member）。讲错形状比不讲更糟：
       * 用户会去找一个根本不存在的补丁按钮。 */
      if (key && MANIFEST[key] && MANIFEST[key].credentialReadonly) return null;
      host.innerHTML = `
        <div class="cardbody">
          <div class="tokstat" data-role="patchstat">${S3("loadingState", "正在检查补丁状态…", { hint: "读完这一行就知道补丁装没装、令牌文件新不新。" })}</div>
          <div class="hint" style="margin-top:10px">
            ${esc(name)} 的令牌<b>每次客户端启动都会轮换</b>，所以它不会被存进配置，
            也不会写进客户端的设置文件——中转每次请求现读，客户端换令牌后无需重启中转即自动跟随。
          </div>
          <div class="hint" style="margin-top:7px">
            令牌只存在于客户端的 worker 进程内存里（磁盘上没有任何明文副本），
            所以要在它每次带鉴权的出站请求上顺手落盘到一个临时文件。
            这一步由上方「一键装补丁」完成——<b>已内置在本路由台里，不需要装 Python</b>。
          </div>
          <div class="hint" style="margin-top:7px">
            <b>前提：${esc(name)} 桌面端必须保持运行。</b>关掉它就不会再刷新令牌文件，
            中转会读到上一次的旧令牌并返回未授权。客户端升级后会新增版本目录、补丁失效——
            回到这里再点一次「一键装补丁」即可（会自动发现所有版本）。
          </div>
          <div class="result" data-role="cres"></div>
        </div>`;
      const scope = host.firstElementChild;
      return { scope, key, $: (sel) => scope.querySelector(sel) };
    }).filter(Boolean);

    function paint(sc, status) {
      const box = sc.$('[data-role="patchstat"]');
      if (!box) return;
      const S = ctx.stOf(sc.key) || {};
      const p = S.patch || {};
      const t = S.token || {};
      /* ⚠ 服务端状态还没到 ⇒ 说「在读」。**不能**当成「没找到客户端安装目录」：
         那个结论要的是「真的找过了、确实没有」，不是「还没找」。 */
      if (!status && !ctx.status) {
        box.innerHTML = S3("loadingState", "正在检查补丁状态…", { hint: "读完这一行就知道补丁装没装、令牌文件新不新。" });
        return;
      }
      if (!S.patch) {
        /* 状态到了、但里面没有补丁这一段 ⇒ 读不到（**不是「没装补丁」**）。 */
        box.innerHTML = S3("errorState", "读不到补丁状态", {
          hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
        });
        return;
      }
      const bits = [];
      if (!p.found) {
        /* 错误态必须带下一步：只说「没找到」用户不知道该干什么。 */
        box.innerHTML = S3("errorState", "没找到客户端安装目录", {
          hint: "先装好对应的桌面端并启动它，再回到这里点「一键装补丁」—— 补丁是装在客户端里的，客户端不在就无处可装。",
        });
        return;
      }
      if (p.ready) {
        bits.push(`<span class="lvl ok" style="font-size:10px">补丁已装</span><span><span class="num">${p.patched}/${p.found}</span> 个 worker 副本</span>`);
        if (p.activeVer) bits.push(`<span>当前版本：<b>${esc(p.activeVer)}</b>（已打补丁）</span>`);
      } else if (p.patched > 0 && p.activeVer) {
        /* ⚠ **「有几份带补丁」不等于「现在跑的那份带补丁」**：客户端升级会新增版本
         *   目录，补丁不会自动跟过去。只按份数报状态会把这种情况说成「补丁已装」
         *   ⇒ 用户以为好了，令牌却永远抓不到（老版本那份白带补丁）。
         *   所以这里点名说清「当前版本没打」，并给可执行的下一步。 */
        bits.push(`<span class="lvl warn" style="font-size:10px">当前版本未打补丁</span>`
          + `<span>当前版本 <b>${esc(p.activeVer)}</b> 没有补丁（<span class="num">${p.patched}/${p.found}</span> 份带补丁的是旧版本）—— 再点一次「一键装补丁」</span>`);
      } else {
        bits.push(`<span class="lvl warn" style="font-size:10px">补丁未装</span><span>发现 <span class="num">${p.found}</span> 个 worker 副本</span>`);
      }
      /* 令牌文件还没刷新 = **还没发生**（客户端没开或没发请求），不是出错。 */
      let stateBlock = "";
      if (p.tokenFresh) {
        bits.push('<span class="lvl ok" style="font-size:10px">令牌文件新鲜</span><span>客户端正在刷新</span>');
      } else {
        stateBlock = S3("emptyState", "还没有令牌文件", {
          hint: "客户端启动并发一次带鉴权的请求就会刷出来 —— 补丁装好后保持客户端运行即可。"
            + "客户端升级后会新增版本目录、补丁不跟过去，记得再点一次「一键装补丁」。",
        });
      }
      if (p.cn) bits.push(`<span>另有国内版 ${p.cn} 份，有意跳过</span>`);
      if (t.tokenFile) bits.push(`<span>令牌文件：<b class="mono">${esc(t.tokenFile)}</b></span>`);
      box.innerHTML = stateBlock + bits.join("");
    }

    for (const sc of scoped) paint(sc, ctx.status);

    return {
      update(status) { for (const sc of scoped) paint(sc, status); },
      refresh() { for (const sc of scoped) paint(sc, ctx.status); },
    };
  },
};