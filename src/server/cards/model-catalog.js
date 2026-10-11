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

    const scoped = hosts.map((host) => {
      const row = host.closest(".credrow");
      const key = row && row.dataset ? row.dataset.k : null;
      const name = key ? ctx.nameOf(key) : "该渠道";
      host.innerHTML = `
        <div class="cardbody">
          <div class="tokstat" data-role="patchstat">正在检查补丁状态…</div>
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
    });

    function paint(sc, status) {
      const box = sc.$('[data-role="patchstat"]');
      if (!box) return;
      const S = ctx.stOf(sc.key) || {};
      const p = S.patch || {};
      const t = S.token || {};
      const bits = [];
      if (!p.found) {
        bits.push('<span class="lvl err" style="font-size:10px">没找到客户端安装目录</span>');
        bits.push("<span>请确认本机已装对应桌面端</span>");
      } else {
        bits.push(p.ready
          ? `<span class="lvl ok" style="font-size:10px">补丁已装</span><span>${p.patched}/${p.found} 个 worker 副本</span>`
          : `<span class="lvl warn" style="font-size:10px">补丁未装</span><span>发现 ${p.found} 个 worker 副本</span>`);
        bits.push(p.tokenFresh
          ? '<span class="lvl ok" style="font-size:10px">令牌文件新鲜</span><span>客户端正在刷新</span>'
          : '<span>令牌文件未刷新 —— 客户端没开或没发请求</span>');
      }
      if (p.cn) bits.push(`<span>另有国内版 ${p.cn} 份，有意跳过</span>`);
      if (t.tokenFile) bits.push(`<span>令牌文件：<b class="mono">${esc(t.tokenFile)}</b></span>`);
      box.innerHTML = bits.join("");
    }

    for (const sc of scoped) paint(sc, ctx.status);

    return {
      update(status) { for (const sc of scoped) paint(sc, status); },
      refresh() { for (const sc of scoped) paint(sc, ctx.status); },
    };
  },
};