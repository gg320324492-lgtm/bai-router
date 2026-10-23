/* cards/quota-panel.js —— 额度视图的卡（每家的额度、预算与休息状态）。
 *
 * 这张卡回答的是「**这家还剩多少、还能用多久**」：
 *   ① 预算（用户自己设的 token 上限）与已用量
 *   ② 这家现在是不是在休息（额度冷却 / 预算用尽），歇到什么时候
 *   ③ 上游自己报的余额（探得到时）与**它的可信度**（探不到就明说探不到）
 *
 * ── 三条口径，别在渲染层改 ──
 *   ① **「探不到」与「余额是 0」是两件事**：
 *      探不到 → 显示「探不到（原因）」；上游真的报 0 → 显示「0」。
 *      混起来会让用户以为账号被封了，而真相可能只是这条网络不通。
 *   ② **「按账本估的」与「上游报的」要分开标**：一个是我们的估算，一个是上游的权威值。
 *      用户要知道这个数字有多可信。
 *   ③ 估不出来的模型**不估价**（显示「—」），不拿别的模型的价顶替。
 *   ④ **渠道级的数与模型级的数不能共用一格**（改版原则 1）：
 *      上面那张表是**渠道级**的（这家一共还剩多少）；下面那一块是**模型级**的
 *      （这一家当前档位那个模型的积分倍率与此刻状态）。含义不同的两个数摆在一列里，
 *      用户就得自己判断哪个说的是自己 —— 那正是这一屏最不该留给用户的事。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["quota-panel"] = {
  /* ================================================================== *
   * 纯函数区（无 DOM、无网络；测试在 vm 里求值这张卡就能直接调）
   * ================================================================== */

  /**
   * 倍率串 → {credits, free, known}。
   *
   * ⚠ **口径只在这里定义一次**。上游有两种写法（"x0.79" 与 "x0.34 credits"），
   *   另有空串（这份目录没给倍率）。**免费那一档恰恰是 "x0.00"** ——
   *   判错一次就等于把「不扣积分」说成「要花钱」，用户会因此换错档位。
   *   所以先剥掉 " credits" 后缀再判（服务端已剥过一遍，这里再剥一次是兜底）。
   *
   * @param {object} entry 目录里的一条模型记录（{credits, free}）
   * @returns {{credits:string|null, free:boolean, known:boolean}}
   */
  modelCredits(entry) {
    const e = entry && typeof entry === "object" ? entry : {};
    const raw = e.credits == null ? "" : String(e.credits);
    const s = raw.trim().replace(/\s*credits\s*$/i, "").trim();
    if (!s) return { credits: null, free: e.free === true, known: false };
    /* free 由服务端归一过（它知道上游那两种写法）；没给才自己判。 */
    const free = e.free === true ? true : (e.free === false ? false : /^x?0\.0+$/.test(s));
    return { credits: s, free, known: true };
  },

  /**
   * 这个模型此刻在账号池里是不是在冷却（上游只对某几个模型限流）。
   *
   * ⚠ 冷却是**模型级**的：整号可用、但上游只对某几个模型限流。
   *   所以这一格必须单独说「该模型在限流」，不能写成「这家不可用」——
   *   那是两个意思（改版原则 1）。
   *
   * @param {object} pool /api/status 里这一家的 pool
   * @param {string} modelId 要问的那个模型 id
   * @returns {{cooling:boolean, accounts:string[]}}
   */
  modelCooling(pool, modelId) {
    const accounts = pool && Array.isArray(pool.accounts) ? pool.accounts : [];
    const id = String(modelId == null ? "" : modelId);
    if (!id) return { cooling: false, accounts: [] };
    const hit = [];
    for (const a of accounts) {
      const list = a && Array.isArray(a.coolingModels) ? a.coolingModels : [];
      if (list.some((m) => String(m) === id)) hit.push(String((a && a.label) || (a && a.id) || ""));
    }
    return { cooling: hit.length > 0, accounts: hit };
  },

  /**
   * 组装「模型级额度」的那些行。
   *
   * ── 三种行，**口径不能混** ──
   *   · "current"    此刻正在服务的那一档（服务端记的最近一次真实调用）。
   *   · "configured" 用户在映射表里**配**的档位 ——「你打算用哪个」。
   *   · 另有一行**提示行**（summary）：没走过这一家时说明「此刻没有正在服务的模型」
   *     **并说清下一步** —— 未知态不带下一步就是死胡同（P5 的规矩）。
   *
   * ⚠ **「配的」与「正在服务的」是两件事，不能共用一个说法**：
   *   配的       = `cfg[渠道].mapping`（用户写的意图）；
   *   正在服务的 = `/api/status` 的 `recent.served`（真实发生过的）。
   *   两者不一致时**两个都报** ——「以为在用 A 其实在用 B」正是这个差异本身。
   *
   * @param {object} o
   *   · key/name   渠道 key 与显示名（ctx.nameOf）
   *   · tierZh     档位短名表（ctx.TIER_ZH）
   *   · slice      /api/status 里这一家的那一块（要 recent 与 pool）
   *   · catalog    {loading, err, data} —— /api/models 那一家的目录状态
   *   · cfg        这一家的配置块（要 mapping）
   * @returns {{channel:string, rows:Array, hasCurrent:boolean, summary:string}}
   */
  modelQuotaRows(o) {
    const self = this;
    const opt = o && typeof o === "object" ? o : {};
    const slice = opt.slice && typeof opt.slice === "object" ? opt.slice : {};
    const pool = slice.pool && typeof slice.pool === "object" ? slice.pool : null;
    const recent = slice.recent && typeof slice.recent === "object" ? slice.recent : {};
    const cfg = opt.cfg && typeof opt.cfg === "object" ? opt.cfg : {};
    const cat = opt.catalog && typeof opt.catalog === "object" ? opt.catalog : null;
    const data = cat && cat.data && typeof cat.data === "object" ? cat.data : null;
    const all = data && Array.isArray(data.all) ? data.all : [];
    const tierZh = opt.tierZh && typeof opt.tierZh === "object" ? opt.tierZh : {};
    const accounts = pool && Array.isArray(pool.accounts) ? pool.accounts : [];
    const usable = accounts.some((a) => a && a.available === true);
    const channel = String(opt.name == null ? (opt.key == null ? "" : opt.key) : opt.name);

    const tier = recent.tier ? String(recent.tier) : null;
    const target = recent.target ? String(recent.target) : null;
    const served = recent.served ? String(recent.served) : null;
    /* ★ 真实**服务**的那个模型才是正在消耗额度的那个；没服务过就看打算路由到哪。 */
    const live = served || target;

    /* 一行的全部事实：某个模型 + 它的倍率 + 它此刻的状态。 */
    const factsOf = (modelId, kind, tierKey, planned, fallbackName) => {
      const id = modelId ? String(modelId) : null;
      const entry = id ? (all.find((m) => m && String(m.key) === id) || null) : null;
      const cr = self.modelCredits(entry);
      const cool = self.modelCooling(pool, id);
      /* 模型显示名：目录里**有正经名字**就用它；目录退化成兜底（名字就是 id）时，
       *   用用户在映射表里起的那个名字 —— 兜底目录不该把「DeepSeek-V4.1-Flash」
       *   显示成两遍 id。 */
      const catName = entry && entry.name ? String(entry.name) : "";
      const name = (catName && catName !== id) ? catName : (fallbackName || catName || id);
      return {
        kind,
        tier: tierKey || null,
        tierLabel: tierKey ? String(tierZh[tierKey] || tierKey) : null,
        model: id,
        modelName: name,
        planned: planned || null,
        mismatch: !!(id && planned && id !== planned),
        credits: cr.credits,
        free: cr.free,
        /* ⚠ **没读到目录不等于倍率是 0** —— 那是两件事（口径①）。
         *   目录读不到就标「不知道」，不拿 0 顶替。 */
        creditsKnown: cr.known,
        cooling: cool.cooling,
        coolingAccounts: cool.accounts,
        usable,
        catalogLoading: !!(cat && cat.loading),
        catalogError: cat && cat.err ? String(cat.err) : "",
        catalogSource: data ? String(data.source || "") : "",
        catalogAt: data && data.catalogAt ? String(data.catalogAt) : "",
        /* ⚠ 目录是**某一个账号**的权限事实（多账号时各号可见的倍率可能不同）——
         *   所以出处要能说清是哪个号的（只给用户自己起的标签，绝不给凭据）。 */
        catalogAccount: data && data.sourceAccount && data.sourceAccount.label
          ? String(data.sourceAccount.label) : "",
      };
    };

    const rows = [];
    let summary = "";
    if (tier) {
      rows.push(factsOf(live, "current", tier, target, null));
    } else {
      /* 没走过这一家 ⇒ 把「你配的档位」摆出来（**配置的口径**，不是正在服务的）。 */
      const mapping = cfg.mapping && typeof cfg.mapping === "object" ? cfg.mapping : {};
      for (const t of Object.keys(mapping)) {
        const m = mapping[t] || {};
        rows.push(factsOf(m.target ? String(m.target) : "", "configured", String(t), null,
          m.label ? String(m.label) : null));
      }
      /* ⚠ **未知态必须带下一步**：只说「不知道」是死胡同，用户不知道该做什么。 */
      summary = rows.length
        ? "此刻没有正在服务的模型 · 走过这一家（或点「测试连通」）之后，这里会显示当前档位那个模型的倍率。"
        : "这一家还没配映射表：到「渠道」页把每个档位指向你想用的模型。";
    }
    return { channel, rows, hasCurrent: !!tier, noTraffic: !tier, summary };
  },

  /**
   * 画「模型级额度」那一块。**纯函数**：只认传进来的组，不读全局、不碰 DOM。
   *
   * @param {Array} groups modelQuotaRows 的产物（一个渠道一组）
   * @param {Function} [esc]
   * @param {object} [kit] 共享组件库（window.BAI_KIT）
   * @returns {string} HTML；没有组时返回空串（整块不画）
   */
  renderModelQuota(groups, esc, kit) {
    const e = esc || ((s) => String(s == null ? "" : s));
    const list = Array.isArray(groups) ? groups : [];
    /* 没有带账号池的渠道 ⇒ 整块不画。
       「没配置的渠道干脆不画条」——画一条空条会被读成「它在跑」。 */
    if (!list.length) return "";

    /* 这一块里有没有「配置」档位的行？（有的话才需要解释两个口径的差别） */
    const hasConfigured = list.some((g) => (Array.isArray(g.rows) ? g.rows : [])
      .some((r) => r && r.kind === "configured"));

    const trs = list.map((g) => {
      const rows = Array.isArray(g.rows) ? g.rows : [];
      /* ⚠ **没走过这一家 ⇒ 先给一句带下一步的话**（提示行）。
       *   渠道名在这一行上，下面几行（配的档位）留空，看起来是一组。 */
      const head = (!g.hasCurrent && g.summary)
        ? `<tr><td>${e(g.channel)}</td><td colspan="4" class="dim">${e(g.summary)}</td></tr>`
        : "";
      const body = rows.map((r, i) => {
        /* 口径徽章：**「当前」= 此刻真实在服务的那一档**，
           **「配置」= 你在映射表里写的档位**。两个说法不许混成一个。 */
        const badge = g.hasCurrent
          ? '<span class="pill ok" style="font-size:10px">当前</span>'
          : '<span class="pill idle" style="font-size:10px">配置</span>';
        const tierCell = r.tier
          ? `${badge} <span>${e(r.tierLabel)}</span> <span class="dim mono">（${e(r.tier)}）</span>`
          : badge;
        const modelCell = r.model
          ? `<span>${e(r.modelName)}</span> <span class="dim mono">${e(r.model)}</span>`
            + (r.mismatch ? `<span class="dim">（与计划的 ${e(r.planned)} 不一致）</span>` : "")
          : '<span class="dim">—</span>';
        /* 倍率的**出处**：哪个账号的那份目录、什么时候抓的、是不是降级来的。
           放 title 里（不占版面）—— 但它得在：多账号时「x0.29」是**某一个号**的数，
           不说清是哪个号的，用户看到的是一个不知道该信几分的数。 */
        const prov = [
          r.catalogAccount ? "账号「" + r.catalogAccount + "」的目录" : "",
          r.catalogSource === "live" ? "实时抓的" : (r.catalogSource ? "降级来源（不是实时抓的）" : ""),
          r.catalogAt ? ("抓于 " + r.catalogAt) : "",
        ].filter(Boolean).join(" · ");
        const titleAttr = prov ? ` title="${e(prov)}"` : "";
        /* ⚠ 三种「没有」要分开：目录还在读 / 目录读到了但这个模型没有倍率 /
         *   目录根本没读到。混成一句「倍率未知」，用户分不出该不该刷新。
         *   ⚠ **「倍率未知」绝不能显示成 0** —— 那是两件事（口径①）：
         *   0 会被读成「这款模型不扣积分」（其实免费档恰恰是 x0.00）。
         *   ⚠ **已经知道的数优先于「在读」**：后台换新目录时那一格不该闪一下
         *   「读目录中…」—— 那会让用户以为刚才是没有倍率。 */
        const creditsCell = r.free
          ? `<span${titleAttr}>免费</span>` + (r.creditsKnown ? ' <span class="dim">（<span class="num">x0.00</span>）</span>' : "")
          : (r.creditsKnown
            ? `<span class="num"${titleAttr}>${e(r.credits)}</span>`
            : (r.catalogLoading
              ? '<span class="dim">读目录中…</span>'
              : `<span class="dim" title="${e([r.catalogError || "这份目录里没有这个模型的倍率", prov].filter(Boolean).join(" · "))}">倍率未知</span>`));
        /* 「该模型此刻」只说这个模型，不替整号下结论（口径④）。
           ⚠ **配了但此刻没在用的档位**说「这一档还没在用」——
           说「可用」会让人以为它正在跑；说「不知道」又是个死胡同。 */
        const stateCell = r.cooling
          ? `<span class="led warn"></span> 该模型在限流${r.coolingAccounts.length ? "（" + e(r.coolingAccounts.join("、")) + "）" : ""}`
          : (g.hasCurrent
            ? (r.usable
              ? '<span class="led ok"></span> 可用'
              : '<span class="led idle"></span> 池里没有可用账号')
            : '<span class="led idle"></span> 这一档还没在用');
        /* 渠道名：没走过这一家时由上面那行提示行说（配置档位那几行留空，像一组）。 */
        const chanCell = g.hasCurrent ? `<td>${e(g.channel)}</td>` : "<td></td>";
        return `<tr>
          ${chanCell}
          <td>${tierCell}</td>
          <td>${modelCell}</td>
          <td>${creditsCell}</td>
          <td>${stateCell}</td>
        </tr>`;
      }).join("");
      return head + body;
    }).join("");

    return `
        <div class="pb-head" style="margin-top:16px">
          <h3>模型级额度</h3>
          <span class="sub">这一家在用哪一档 · 那个模型的积分倍率 · 此刻能不能用</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr>
            <th style="width:16%">渠道</th>
            <th style="width:24%">档位</th>
            <th style="width:24%">指向的模型</th>
            <th style="width:14%">积分倍率</th>
            <th style="width:22%">该模型此刻</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>
        <div class="hint" style="margin-top:10px">
          <b>这一块是模型级的</b>：<b>这一家的额度长在模型上</b> —— 上游没有渠道级的余额接口，
          所以上面那张表的「上游余额」对这一家显示「探不到」；那<b>不是</b>这家没额度，
          是它压根没有「这一家一共还剩多少」这个数。两个数含义不同，不能互相替代。
        </div>
        <div class="hint" style="margin-top:7px">
          <b>积分倍率</b>是这个模型每用一单位扣多少积分：x0.00 = 不扣积分（免费），
          x0.29 = 每用一单位扣 0.29 积分。倍率取自账号池那一份目录（上游 /v3/config）。
        </div>
        <div class="hint" style="margin-top:7px">
          <b>「还剩多少积分、还能用几次」拿不到</b>：上游没有给这个查询接口（两个候选地址实测都 404），
          所以这里<b>不编一个数</b>——想知道余额只能去上游控制台看。
        </div>
        ${hasConfigured ? `<div class="hint" style="margin-top:7px">
          <b>「当前」与「配置」是两个口径</b>：「当前」= 此刻真实在服务的那一档，
          「配置」= 你在映射表里写的档位。<b>没走过这一家时只有「配置」</b>——
          那是你打算怎么用，不是此刻在用；两者指向的模型不一样时那一行会写明。
        </div>` : ""}`;
  },

  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));
    const self = this;

    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    let box = $("quotaOverview");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "quotaOverview";
      box.innerHTML = `
        <div class="pb-head">
          <h3>各家额度</h3>
          <span class="sub">预算 · 已用 · 休息状态 · 上游余额</span>
        </div>
        <div class="fieldset">
          <div data-role="qov-body"></div>
          <div data-role="qov-model"></div>
          <div class="result" data-role="qov-result"></div>
        </div>`;
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

    let data = null;
    let lasterr = "";
    let inflight = false;
    let loaded = false;   // 至少成功读过一回（没读过 ≠ 没有额度信息）
    let sig = "";

    /* ── 模型级额度要的第二份数据 ──
     *
     * ① **当前档位与它服务的那个模型**：/api/status 的 recent（**不走上游**）。
     * ② **那个模型的积分倍率**：/api/models 的目录 —— ⚠ 这一份**要走上游**
     *    （上游 /v3/config，实测 15~45 秒），所以：
     *      · 它**不跟每 5 秒一次的轮询走**（卡片自己只取一次，刷新按钮才重取）——
     *        「不多发请求」是这一屏的硬约束；
     *      · 取回来之前那一格先画「读目录中…」，**不把「还没读到」当成「倍率 0」**。
     */
    const catState = new Map();   // 渠道 key → {loading, err, data}

    /** 哪些渠道有「模型级」这一说？**按结构认，不写死渠道名**（C11）：
     *  带账号池的那一格 —— 当前是 WorkBuddy 两版。 */
    function poolKeys() {
      const keys = Array.isArray(ctx.channels) ? ctx.channels : [];
      const out = [];
      for (const k of keys) {
        const S = (typeof ctx.stOf === "function" ? ctx.stOf(k) : null) || {};
        const pool = S.pool;
        if (!pool || typeof pool !== "object") continue;
        const accts = Array.isArray(pool.accounts) ? pool.accounts : [];
        /* 没配账号的渠道不画：画一条空条会被读成「它在跑」。 */
        if (!accts.length) continue;
        /* ⚠ **连令牌都没填的账号不算「这一家在用」** —— 那一行会只剩
         *   「最近没走过这一家 / 倍率未知」，全是空话，用户只会以为面板坏了。
         *   判据取自池子自己写的 reason（服务端算的，不是这里另判一套）。 */
        const used = accts.some((a) => a && a.reason !== "no_token");
        if (!used) continue;
        out.push(k);
      }
      return out;
    }

    /** 取一家目录。`keepOld` = 保留旧值（后台换新，不清空已知的倍率）。 */
    async function loadCatalog(key, keepOld) {
      const cur = catState.get(key);
      if (cur && !keepOld) return cur;
      if (cur && cur.loading) return cur;        // 已经在飞就别再发一次
      const st = {
        loading: true,
        err: cur && keepOld ? cur.err : "",
        data: cur && keepOld ? cur.data : null,
      };
      catState.set(key, st);
      try {
        const r = await ctx.api("/api/models?p=" + encodeURIComponent(key), { timeoutMs: ctx.CATALOG_TIMEOUT_MS });
        if (r && r.ok === false) throw new Error(r.error || "读不到模型目录");
        st.data = r || null;
      } catch (e) {
        st.err = String((e && e.message) || e);
      } finally {
        st.loading = false;
      }
      return st;
    }

    /** 发起缺失的那几份目录读取（`keepOld` = 已有也换新）。 */
    function ensureCatalogs(keys, keepOld) {
      for (const k of keys) {
        if (!keepOld && catState.has(k)) continue;
        loadCatalog(k, keepOld).then(() => { if (!lasterr) render(); });
      }
    }

    /** 模型级那些组（纯函数算出来的数据，渲染层只照着显示）。 */
    function modelGroups() {
      const tierZh = ctx.TIER_ZH || {};
      return poolKeys().map((k) => self.modelQuotaRows({
        key: k,
        name: typeof ctx.nameOf === "function" ? ctx.nameOf(k) : k,
        tierZh,
        slice: (typeof ctx.stOf === "function" ? ctx.stOf(k) : null) || {},
        /* 配置块：映射表（每档指向哪个模型）在里面 ——
           「没走过这一家」时那一块要摆出的是**配的**档位。 */
        cfg: (typeof ctx.cfgOf === "function" ? ctx.cfgOf(k) : null) || {},
        /* 目录还没开始读 ⇒ 那一格显示「读目录中…」，不是「倍率未知」：
           「还没问」与「问了、拿不到」是两件事，混起来用户会以为倍率真 0。 */
        catalog: catState.get(k) || { loading: true, err: "", data: null },
      }));
    }

    /** 画模型级那一块。 */
    function renderModelSection() {
      const host = q('[data-role="qov-model"]');
      if (!host) return;
      host.innerHTML = self.renderModelQuota(modelGroups(), esc, kit);
    }

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const int = (v) => num(v).toLocaleString("zh-CN");

    function fmtWhen(t) {
      if (!t) return "—";
      const d = new Date(t);
      if (!Number.isFinite(d.getTime())) return "—";
      return d.toLocaleString("zh-CN", { hour12: false });
    }

    function fmtLeft(ms) {
      if (!ms) return "—";
      const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
      if (s < 60) return `${s} 秒后`;
      if (s < 3600) return `${Math.round(s / 60)} 分钟后`;
      return `${Math.round(s / 3600)} 小时后`;
    }

    function render() {
      /* 模型级那一块与上面那张表**各自独立**：上面读的是渠道级的余额，
         这一块读的是「当前档位那个模型」。上面读失败不该把这一块一起抹掉。 */
      renderModelSection();
      const body = q('[data-role="qov-body"]');
      if (!body) return;
      const rows = Array.isArray(data && data.providers) ? data.providers : [];
      if (!loaded && !lasterr) {
        /* 第一次读还没回来：先说「在读」，别拿空态冒充「没有额度信息」。 */
        body.innerHTML = S3("loadingState", "正在读额度信息…", { hint: "读完这一块就知道各家还剩多少、还能用多久。" });
        return;
      }
      if (lasterr) {
        /* 读不到 ⇒ 整块换成错误态（必须带下一步）：
           「没有额度」与「读不到额度」是两件事，混起来用户会去查一个没发生的事。 */
        body.innerHTML = S3("errorState", "读不到额度信息", {
          hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
          detail: lasterr,
        });
        return;
      }
      if (!rows.length) {
        /* 空态要说清「怎么才会出现」：不然用户不知道该去哪儿做点什么。 */
        body.innerHTML = S3("emptyState", "还没有渠道的额度信息", {
          hint: "额度要等真的发生过调用、或者你给某家设了预算之后才有 —— 先在故障转移屏设个预算，或跑一轮对话。",
        });
        return;
      }
      const trs = rows.map((r) => {
        const b = r.budget || null;
        const limit = b ? num(b.limit) : 0;
        const used = b ? num(b.used) : 0;
        const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
        /* ⚠ 状态**不许**自己另算一套：这一格必须与总览页、渠道矩阵上说的
         *   同一件事（改版原则 1：状态是数据，不是装饰）。
         *   自己算会出这种错：没配凭据的渠道在这里显示「可用」，
         *   而总览页说「凭据未配」——用户得自己判断哪个是真的。
         *   额度这一屏**独有**的两格（休息中 / 冷却中）优先，其余交给共享的
         *   channelState。 */
        const shared = (typeof ctx.channelState === "function" && r.key)
          ? ctx.channelState(r.key) : null;
        const state = r.resting
          ? '<span class="led warn"></span> 休息中'
          : (r.cooling
            ? '<span class="led warn"></span> 冷却中'
            : (shared
              ? `<span class="led ${esc(String(shared.s || "idle"))}"></span> ${esc(String(shared.txt || "—"))}`
              : '<span class="led idle"></span> —'));
        const budgetCell = !b
          ? '<span class="dim">未设预算</span>'
          : `<span class="num">${int(used)} / ${int(limit)}</span> <span class="dim">（<span class="num">${pct}%</span>）</span>`;
        const limitCell = !b
          ? "—"
          : [b.hourly ? `每小时 <span class="num">${int(b.hourly)}</span>` : "", b.daily ? `每天 <span class="num">${int(b.daily)}</span>` : ""].filter(Boolean).join(" · ") || "—";
        /* ⚠ 探不到时**只写「探不到」**，完整原因放进 title。
         *   原来把整句原因（一句能有两行）直接印在表里，八行一模一样地铺开 ——
         *   表格被一堵字墙占满，真正要看的「余额」那一列反而看不见了。 */
        const probe = r.probe
          ? (r.probe.known
            ? `<span class="num">${int(r.probe.used)} / ${r.probe.limit != null ? int(r.probe.limit) : "—"}</span> <span class="dim">（上游报）</span>`
            : `<span class="dim" title="${esc(String(r.probe.error || "原因不明"))}">探不到</span>`)
          : '<span class="dim">未探测</span>';
        const cost = r.cost
          ? (r.cost.known ? `<span class="num">$${num(r.cost.total).toFixed(4)}</span>` : '<span class="dim">估不出</span>')
          : '<span class="dim">—</span>';
        return `<tr>
            <td>${esc(String(r.name || r.key || ""))}</td>
            <td>${limitCell}</td>
            <td>${budgetCell}</td>
            <td>${probe}</td>
            <td>${cost}</td>
            <td>${state}${r.restUntil ? ` <span class="dim num">${esc(fmtLeft(r.restUntil))}</span>` : ""}</td>
          </tr>`;
      }).join("");
      body.innerHTML = `
        <table class="route" style="table-layout:fixed">
          <thead><tr>
            <th style="width:16%">渠道</th>
            <th style="width:22%">预算上限</th>
            <th style="width:20%">已用 / 上限</th>
            <th style="width:18%">上游余额</th>
            <th style="width:10%">花费</th>
            <th style="width:14%">状态</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>
        ${(data && data.pricedAt) ? `<div class="hint" style="margin-top:10px">单价表快照：<span class="num">${esc(String(data.pricedAt))}</span>（价格会随厂商调价漂移；估不出的模型显示「—」，不拿别的价顶替）</div>` : ""}`;
    }

    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await ctx.api("/api/quota/overview");
        if (r && r.ok === false) throw new Error(r.error || "读不到额度信息");
        data = r || null;
        lasterr = "";
      } catch (e) {
        lasterr = String((e && e.message) || e);
      } finally {
        inflight = false;
        loaded = true;
        /* ⚠ 读完就重画：不重画的话这一块会**停在「正在读」**直到下一轮 5 秒轮询
           （load() 里 `if (inflight) return;` 不会等这次读，update() 也等不到它）。 */
        render();
      }
    }

    function signature() {
      const rows = Array.isArray(data && data.providers) ? data.providers : [];
      /* ⚠ 模型级那些行也要进签名：当前档位变了（recent 变）就得重画，
         否则那一块会停在旧档位上 —— 用户看到的是「还在用上一个模型」。 */
      const mgroups = modelGroups();
      return JSON.stringify(rows.map((r) => [
        r.key, r.budget ? r.budget.used : 0, r.budget ? r.budget.limit : 0,
        r.resting, r.restUntil, r.cooling,
        r.probe ? r.probe.known : null, r.cost ? r.cost.total : null,
      ])) + "|" + JSON.stringify(mgroups.map((g) => [
        g.channel, g.hasCurrent, g.summary,
        (g.rows || []).map((r) => [r.kind, r.tier, r.model, r.credits, r.creditsKnown, r.cooling, r.usable]),
      ])) + "|" + (loaded ? "1" : "0") + "|" + lasterr;
    }

    /* 首屏先画「在读」并把第一次读发出去：否则这 5 秒里这一块是空白，
       空白既不是「在读」也不是「没有额度信息」，用户只能猜。 */
    render();
    load();

    return {
      async update() {
        await load();
        /* 目录只补缺的那几份：**每 5 秒轮询不该多打上游**。
           补到了会自己重画（loadCatalog 的 then 里调 render）。 */
        ensureCatalogs(poolKeys());
        if (lasterr) {
          /* 读不到 ⇒ 整块换成错误态（必须带下一步）：
             「没有额度」与「读不到额度」是两件事，混起来用户会去查一个没发生的事。 */
          const body = q('[data-role="qov-body"]');
          if (body) {
            body.innerHTML = S3("errorState", "读不到额度信息", {
              hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
              detail: lasterr,
            });
          }
          return;
        }
        const s = signature();
        if (s !== sig) { sig = s; render(); }
      },
      refresh() {
        /* 刷新 = 「我要看当下的」：目录也重取（**保留旧值** ——
           立刻清空会让那一格闪一下「读目录中…」，用户会以为刚才是没有倍率）。
           服务端那份目录缓存 30 分钟，所以这里反复点也不会多打上游。 */
        ensureCatalogs(poolKeys(), true);
        return load();
      },
    };
  },
};
