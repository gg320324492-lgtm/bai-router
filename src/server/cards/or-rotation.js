/* cards/or-rotation.js —— OpenRouter（/or，第 6 家）专属卡：「免费流水区」。
 *
 * 这一页与前五家的唯一实质差别：凭据不是一把 key，而是**最多 3 把 key 的轮换区**，
 * 且 429 有两种 limit_source 要分流（换模型 / 换 key）。分流逻辑全在 server.mjs 的
 * orPick / orAdvance，这张卡只负责三件事：
 *   1) 三把 key 的输入框（写入 POST /api/or/keys，回显只给 keyFp 指纹）
 *   2) 把 /api/status 的 or.*（当前 key 序号 / 当前模型 / 冷却 / 额度 / 重置倒计时）画出来
 *   3) 「刷新额度」「刷新免费模型目录」两个动作（POST /api/or/refresh）
 *
 * 明文安全：输入框只在用户主动粘贴时有值，保存后立刻用服务端回传的指纹覆盖显示；
 * 页面任何位置都不回显 key 明文，config.json 也不进任何会被提交的目录。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["or-rotation"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));
    const slot = ctx.slot || $("slot-extra");
    const KEYS = 3;

    slot.insertAdjacentHTML("beforeend", `
      <div class="card foldable" id="cardOrRot">
        <div class="head" id="headOrRot">
          <span class="eyebrow">轮换</span><span class="title">OpenRouter 免费流水区</span>
          <span class="aux" id="orRotAux">最多 ${KEYS} 把 key</span>
        </div>
        <div class="body">
          <div class="hint">
            <b>两层轮换</b>（实测两种 429 含义相反，不能混为一谈）：<br>
            · <span class="mono">limit_source=upstream_provider_shared_pool</span>（单个模型上游池子满）→
            <b>换模型</b>：同一把 key 下自动挑下一个免费模型；<br>
            · <span class="mono">limit_source=openrouter_free_tier_daily</span>（账号级 50 次/天）→
            <b>换 key</b>：第 1 把 → 第 2 把 → 第 3 把 → 第 1 把，按
            <span class="mono">X-RateLimit-Reset</span>（epoch 毫秒）判断何时轮回来；<br>
            · 三把 key 都在每日冷却 → <b>如实失败</b>并给出重置时间，不会空转重试。
          </div>

          <div class="keyrow"><span class="k">key 1</span><input type="password" id="orKey1" autocomplete="off" placeholder="sk-or-v1…"><span class="mono" id="orKeyFp1" style="opacity:.7">（空）</span></div>
          <div class="keyrow"><span class="k">key 2</span><input type="password" id="orKey2" autocomplete="off" placeholder="留空 = 只用 1 把 key"><span class="mono" id="orKeyFp2" style="opacity:.7">（空）</span></div>
          <div class="keyrow"><span class="k">key 3</span><input type="password" id="orKey3" autocomplete="off" placeholder="留空 = 不用第 3 把"><span class="mono" id="orKeyFp3" style="opacity:.7">（空）</span></div>

          <div class="saverow">
            <button class="btn-main" id="btnOrSaveKeys" type="button">保存 3 把 key</button>
            <button class="btn-ghost" id="btnOrQuota" type="button" title="GET /api/v1/auth/key 的 free_model_daily_requests">刷新额度</button>
            <button class="btn-ghost" id="btnOrModels" type="button" title="按 pricing 全 0 重筛免费模型目录，写回下拉框">刷新免费模型目录</button>
          </div>
          <div class="result" id="orKeysResult"></div>

          <div class="tokstat" id="orRotStat">正在读取轮换状态…</div>
          <div class="hint" id="orRotNote" style="margin-top:8px"></div>
        </div>
      </div>`);

    /* ---------------- 保存三把 key ---------------- */
    const saveKeys = async () => {
      const raw = [];
      for (let i = 1; i <= KEYS; i++) raw.push(($("orKey" + i) || {}).value || "");
      try {
        const r = await ctx.postJSON("/api/or/keys", { keys: raw });
        for (let i = 1; i <= KEYS; i++) {
          const inp = $("orKey" + i);
          if (inp) inp.value = "";                       // 明文立刻从内存里清掉
          const fp = (r.keys || []).find((x) => x.no === i);
          const el = $("orKeyFp" + i);
          if (el) el.textContent = fp ? fp.fp : "（空）";
        }
        ctx.showResult($("orKeysResult"), `✔ 已保存 ${r.keys ? r.keys.length : 0} 把 key（明文只落本机 config.json，页面只显示指纹）`, true);
        await ctx.refreshConfig();
        ctx.poll();
      } catch (e) {
        ctx.showResult($("orKeysResult"), "出错了：" + e.message, false);
      }
    };
    const bs = $("btnOrSaveKeys");
    if (bs) bs.addEventListener("click", saveKeys);

    /* ---------------- 刷新额度 / 刷新免费目录 ---------------- */
    const bq = $("btnOrQuota");
    if (bq) bq.addEventListener("click", async () => {
      try {
        const r = await ctx.api("/api/or/status?refresh=1");
        paintStat(null, r);
        ctx.showResult($("orKeysResult"), quotaLine(r.quota) || "额度已刷新", true);
      } catch (e) { ctx.showResult($("orKeysResult"), "出错了：" + e.message, false); }
    });
    const bm = $("btnOrModels");
    if (bm) bm.addEventListener("click", async () => {
      try {
        const r = await ctx.api("/api/or/refresh", { method: "POST" });
        await ctx.refreshConfig();
        if (ctx.renderRoute) ctx.renderRoute();
        ctx.showResult($("orKeysResult"), `✔ 已按 pricing 全 0 重筛：${r.count} 个免费模型（目录共 ${r.total} 个）`, true);
      } catch (e) { ctx.showResult($("orKeysResult"), "出错了：" + e.message, false); }
    });

    /* ---------------- 状态绘制 ---------------- */
    function quotaLine(q) {
      if (!q) return "额度：未读到（key 未配置或上游不可达）";
      if (q.error) return "额度：读取失败 —— " + q.error;
      const d = q.daily;
      if (!d) return "额度：上游未返回 free_model_daily_requests" + (q.stale ? "（下面是上次的缓存）" : "");
      return `今日免费额度：已用 ${d.used} / ${d.limit}，剩余 ${d.remaining}`;
    }
    function paintStat(st, orStatus) {
      const el = $("orRotStat");
      if (!el) return;
      const s = orStatus || (st && st.or) || null;
      if (!s) { el.textContent = "等待 /api/status…"; return; }
      const rot = s.rotation || {};
      const tk = s.token || {};
      // key 指纹：只画 keyFp，输入框保持空白（明文不回显）
      const list = tk.keys || [];
      for (let i = 1; i <= KEYS; i++) {
        const fe = $("orKeyFp" + i);
        if (!fe) continue;
        const e = list[i - 1];
        fe.textContent = e
          ? e.fp + (e.active ? " · 当前" : "") + (e.coolingUntil ? " · 冷却至 " + e.coolingUntil : "")
          : "（空）";
      }
      const parts = [];
      parts.push(`<span>当前 key：<b>${tk.configured ? "第 " + (rot.activeKeyNo || "?") + " 把 / 共 " + tk.keyCount + " 把" : "未配置"}</b></span>`);
      parts.push(`<span>当前模型：<b>${esc(rot.activeModel || "—")}</b></span>`);
      if (rot.cooledModels && rot.cooledModels.length) {
        parts.push(`<span class="warn">冷却中模型：${rot.cooledModels.length} 个（${esc(rot.cooledModels[0].model)}…）</span>`);
      }
      parts.push(`<span>${quotaLine(s.quota)}</span>`);
      if (rot.resetCountdownMs > 0) {
        const min = Math.round(rot.resetCountdownMs / 60000);
        parts.push(`<span>重置倒计时：<b>${min >= 60 ? Math.floor(min / 60) + " 小时 " + (min % 60) + " 分" : min + " 分"}</b>${rot.lastResetAt ? "（" + esc(rot.lastResetAt) + "）" : ""}</span>`);
      }
      if (rot.limitSource) parts.push(`<span>最近 429：<span class="mono">${esc(rot.limitSource)}</span></span>`);
      el.innerHTML = parts.join("　");
      const note = $("orRotNote");
      if (note) {
        const sw = rot.lastSwitch;
        note.textContent = sw
          ? `最近一次轮换：${sw.at}　${sw.kind === "key" ? `第 ${sw.from} 把 key → 第 ${sw.to} 把 key` : `模型 ${sw.from} → ${sw.to}`}${sw.why ? "（" + sw.why + "）" : ""}`
          : "尚未发生轮换（额度够用时不会动）。";
      }
    }

    /* 首屏把 config 里已有的 key 指纹填上（明文永远不回传） */
    function paintKeys(cfg) {
      const keys = ((cfg || {}).or && cfg.or.keys) || [];
      for (let i = 1; i <= KEYS; i++) {
        const el = $("orKeyFp" + i);
        if (el) el.textContent = keys[i - 1] ? "已保存（明文不回显）" : "（空）";
      }
      const aux = $("orRotAux");
      if (aux) aux.textContent = keys.length ? `已配置 ${keys.length} 把 key` : `最多 ${KEYS} 把 key（未配置）`;
    }

    // panel-common 每 5 秒轮询一次，把 /api/status 交给我们画
    return {
      update(st, cfg) { paintStat(st, null); if (cfg) paintKeys(cfg); },
      refresh() { paintKeys(ctx.cfg); },
    };
  },
};
