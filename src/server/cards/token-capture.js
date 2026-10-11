/* cards/token-capture.js —— 凭据视图里「访问令牌（jwt）」那一行的内联面板。
 *
 * v17 之前这是 WorkBuddy 页面的一张独立折叠卡 + 两步引导里的「一键获取令牌」按钮。
 * 单页改版后令牌逻辑按清单的 credential.kind = "jwt" 自认领凭据视图里所有同类行
 * ——不写死渠道名，新增一家令牌型渠道时这张卡自动跟过去。
 *
 * 保留的是两条真正有用的路：
 *   1) 「一键获取令牌」：装钩子 → 提示用户在客户端里触发 → 抓 Authorization → 写回配置
 *      （令牌**只存内存**，不落 config.json；这一步是 jwt 类型渠道的核心动作）
 *   2) 「手动填写令牌」：一键获取失败时的备用方式（浏览器 F12 抓四个头）
 *
 * 折叠壳由渲染层提供（凭据行本身就是可展开的），本卡不再自带 .card.foldable。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["token-capture"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));
    const hosts = (typeof ctx.rowsOfKind === "function" ? ctx.rowsOfKind("jwt") : []) || [];
    if (!hosts.length) return { update() { }, refresh() { } };

    /* 每家一个独立的作用域：同一张卡挂在多行上时，id 必须带渠道 key 才不打架 */
    let seq = 0;
    const scoped = hosts.map((host) => {
      const key = (host.closest(".credrow") || {}).dataset ? host.closest(".credrow").dataset.k : null;
      const n = key || ("c" + (++seq));
      host.innerHTML = `
        <div class="cardbody" data-cid="tc-${esc(n)}">
          <div class="tcap">
            <span class="k">怎么拿</span>
            <span class="v">在本机客户端里发一条带鉴权的请求，中转把令牌抓回来（只存内存，不落配置）</span>
          </div>
          <div class="progress" data-role="prog" style="display:none">
            <div class="spin"></div>
            <div>
              <div class="pTitle" data-role="ptitle"></div>
              <div class="pDesc" data-role="pdesc"></div>
            </div>
          </div>
          <div class="tokstat" data-role="stat">正在读取令牌状态…</div>
          <div class="keybox" data-role="keys" style="display:none"></div>
          <div class="result" data-role="res"></div>
        </div>`;
      const scope = host.querySelector('[data-cid]');
      return {
        host, scope, key,
        /* 委托到整行：本卡**不画**「一键获取令牌 / 手动填写」按钮——那两个由渲染层按
           credential.kind 统一分派，画两份会出现两个同名按钮。用事件委托接过去，
           谁画的按钮都走同一条流程。 */
        row: host.closest(".credrow") || scope,
        $: (sel) => scope.querySelector(sel),
        $all: (sel) => Array.from(scope.querySelectorAll(sel)),
        tokstat() { return scope.querySelector('[data-role="stat"]'); },
      };
    });

    /* ---------------- 等待面板 ---------------- */
    const CAP_TIPS = [
      "正在等待客户端触发…",
      "如果 10 秒内没反应，请在对应客户端里打开一个对话，或随便发一条消息",
      "钩子已就位，客户端一发起带鉴权的请求就会自动抓到访问令牌",
      "仍在等待中…（最长 2 分 30 秒，可随时关闭页面重试）",
    ];
    const timers = new Map();
    function showProgress(sc, on) {
      const box = sc.$('[data-role="prog"]');
      if (!box) return;
      box.style.display = on ? "flex" : "none";
      const cur = timers.get(sc);
      if (cur) { clearInterval(cur.tick); clearInterval(cur.poll); timers.delete(sc); }
      if (!on) return;
      let n = 0;
      sc.$('[data-role="ptitle"]').textContent = CAP_TIPS[0];
      sc.$('[data-role="pdesc"]').textContent = "完成后会自动还原对客户端的临时改动，不影响它正常使用。";
      const tick = setInterval(() => {
        n = Math.min(n + 1, CAP_TIPS.length - 1);
        sc.$('[data-role="ptitle"]').textContent = CAP_TIPS[n];
      }, 12000);
      const poll = setInterval(async () => {
        try {
          const s = await ctx.api("/api/wb/capture/status");
          if (s && s.gotAccessToken) {
            sc.$('[data-role="ptitle"]').textContent = "已捕获到访问令牌，正在写入配置…";
            sc.$('[data-role="pdesc"]').textContent = "刷新令牌只在令牌到期续期时才会出现；没有它也能正常使用，到期后重新获取即可。";
          } else if (s && s.active && s.phaseText) {
            const secs = Math.round((s.elapsedMs || 0) / 1000);
            sc.$('[data-role="pdesc"]').textContent = s.phaseText + `（已等待 ${secs} 秒，最长 150 秒）`;
          }
        } catch { /* 轮询失败不影响主流程 */ }
      }, 2000);
      timers.set(sc, { tick, poll });
    }

    /* ---------------- 手动填写（备用路径，事件委托到行内的按钮） ---------------- */
    const FIELDS = [
      ["accessToken", "访问令牌", "eyJ…（JWT，三段）"],
      ["refreshToken", "刷新令牌", "eyJ…（用于到期自动续期）"],
      ["deviceToken", "设备令牌", "可留空"],
      ["userId", "用户 ID", "可留空"],
    ];
    function openManual(sc) {
      const box = sc.$('[data-role="keys"]');
      if (!box) return;
      if (box.style.display !== "none") { box.style.display = "none"; return; }
      const C = ctx.cfgOf(sc.key) || {};
      box.style.display = "";
      box.innerHTML = FIELDS.map(([f, k, ph]) =>
        `<div class="keyrow-inline"><span class="n">${esc(k)}</span>`
        + `<input type="password" autocomplete="off" placeholder="${esc(ph)}" data-f="${esc(f)}" value="${esc(C[f] ? "已保存（不回显）" : "")}" ${C[f] ? "readonly" : ""}>`
        + (C[f] ? `<span class="live">已保存</span>` : "")
        + "</div>").join("")
        + `<div class="saverow"><button class="btn sm" type="button" data-act="savetok" data-n="${esc(sc.key)}">保存令牌</button>
             <span class="fpline" style="border:0;padding:0"><span class="v zh">已保存过的格子不回显明文，要改就清空重填</span></span></div>`;
      const b = box.querySelector('[data-act="savetok"]');
      if (b) b.addEventListener("click", () => saveTok(sc, box, b));
    }
    async function saveTok(sc, box, btn) {
      const body = { provider: sc.key };
      for (const inp of Array.from(box.querySelectorAll("input[data-f]"))) {
        if (inp.readOnly) continue;
        body[inp.dataset.f] = inp.value.trim();
      }
      await ctx.withBusy(btn, async () => {
        const r = await ctx.postJSON("/api/config", body);
        ctx.showResult(sc.$('[data-role="res"]'), "✔ 令牌已保存\n" + (r.hints || []).map((h) => "· " + h).join("\n"), true);
        box.style.display = "none";
        await ctx.refreshConfig();
        ctx.poll();
      }, sc.$('[data-role="res"]'));
    }

    /* ---------------- 令牌体检条 ---------------- */
    function paint(sc, status) {
      const stat = sc.tokstat();
      if (!stat) return;
      const S = ctx.stOf(sc.key) || {};
      const t = S.token || {};
      const parts = [];
      if (S.edition) parts.push(`<span>版别：<b>${esc(S.edition)}</b></span>`);
      if (S.authDomain) parts.push(`<span>登录域名：<b>${esc(S.authDomain)}</b></span>`);
      if (!t.configured) {
        parts.push('<span>访问令牌：<b class="warn">未捕获</b></span>');
        parts.push('<span>本机需已安装并登录对应客户端</span>');
      } else {
        parts.push('<span>访问令牌：<b>已捕获</b></span>');
        if (t.expAt) parts.push(`<span>有效期至：<b>${esc(new Date(t.expAt).toLocaleDateString("zh-CN"))}</b>（剩 ${t.expiresInDays} 天）</span>`);
        parts.push(`<span>刷新令牌：<b>${t.hasRefresh ? "有（自动续期）" : "无"}</b></span>`);
      }
      stat.innerHTML = parts.join("");
      /* 按钮是渲染层画的，本卡只改它的文案（存在即改，不重建元素）。 */
      const btn = sc.row.querySelector('[data-act="capture"]');
      if (btn) btn.textContent = t.configured ? "重新获取令牌" : "一键获取令牌";
    }

    /* ---------------- 流程所有权 ----------------
     按钮由渲染层按 credential.kind 画出；**本卡注册接管**，共享层就不会自己跑一遍
     （否则一次点击会发两次 /api/wb/capture）。注册不了的那一行由共享层兜底。 */
    for (const sc of scoped) {
      if (typeof ctx.registerCapture !== "function") break;
      ctx.registerCapture(sc.key, async (btn) => {
        if (btn.disabled) return;                 // 防连点
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = "获取中…";
        showProgress(sc, true);
        try {
          const r = await ctx.api("/api/wb/capture", { method: "POST" });
          if (r && r.ok) {
            let msg = "✔ 令牌获取成功（" + (r.masked || "") + "），已自动填入并保存。";
            if (r.hasRefresh === false) {
              msg += "\n注意：本次未捕获到刷新令牌（它只在令牌续期时才随请求发出）。";
              msg += "访问令牌到期后重新点一次即可。";
            }
            ctx.showResult(sc.$('[data-role="res"]'), msg, true);
          } else {
            ctx.showResult(sc.$('[data-role="res"]'),
              "✘ 获取失败：" + ((r && r.error) || "未知原因") + "\n可改用「手动填写」作为备用方式。", false);
          }
        } catch (err) {
          ctx.showResult(sc.$('[data-role="res"]'), "✘ 获取失败：" + err.message, false);
        } finally {
          showProgress(sc, false);
          btn.disabled = false;
          btn.textContent = old;
          await ctx.refreshConfig().catch(() => { });
          ctx.poll();
        }
      });
    }

    /* 「手动填写」仍然用委托：它没有进度面板，共享层的兜底实现够用，
       卡片只负责把四个输入框与保存按钮展开到行里。 */
    for (const sc of scoped) {
      sc.row.addEventListener("click", (e) => {
        const btn = e.target.closest('button[data-act="manual"]');
        if (btn) openManual(sc);
      });
    }

    for (const sc of scoped) paint(sc, ctx.status);

    return {
      update(status) { for (const sc of scoped) paint(sc, status); },
      refresh() { for (const sc of scoped) paint(sc, ctx.status); },
    };
  },
};