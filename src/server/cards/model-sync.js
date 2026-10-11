/* cards/model-sync.js —— 「刷新全部模型」：一键体检六家提供方的模型目录。
 *
 * 各家自己的「刷新模型列表」按钮只管自己那一家、拉完就静默写回；这张卡管的是
 * 跨渠道的横向视图：一次性把六家都扫一遍，给出「谁多了几个 / 谁少了几个」的摘要，
 * 由用户确认后才写进 config.json。默认视图一行一家、只给计数（扫一眼就能看完），
 * 有变化的行点得开，在下方滚动区里看具体的模型 id。
 *
 * 端点契约（server.mjs，与本文件并行开发，勿改）：
 *   POST /api/models/scan-all   {}          -> { ok, changed, providers:[…] }
 *   POST /api/models/apply-all  { apply:{} } -> { ok, applied:[…] }
 * providers[i] = { key, name, status:"ok"|"error"|"static"|"empty",
 *                   added:[], removed:[], count, have, note?, error? }
 *
 * 两处刻意的写法，改动前先读：
 *   1) 头部那颗按钮不在任何 .card 里（产品决定放页签旁边），所以 withBusy 的
 *      errSlotOf 找不到落点 —— 必须把 #msyncResult 显式传进去，否则报错会冒到
 *      页面顶部不相干那张卡的 .result 上。
 *   2) window.baiDesktop 一定要判空：面板也能用浏览器直开 127.0.0.1:15723，
 *      那条路上没有 preload 注入的桥（见 src/preload.js 顶部说明），
 *      不判空就是整块面板在浏览器里直接白屏。
 *
 * 配色一律走 var(--ok)/var(--err)/var(--dim)/var(--accent)：
 * 强调色是按 html[data-provider] 换的，写死十六进制会在两套主题里都错色。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["model-sync"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));

    /* 可刷目录的渠道：清单里 chainable 的那些（交还区不是本台渠道，没有模型目录）。
       顺序按清单书写序，与转移链默认序一致。 */
    const MANIFEST = window.BAI_PROVIDERS || {};
    const ORDER = Object.keys(MANIFEST).filter((k) => MANIFEST[k] && MANIFEST[k].chainable === true);
    const nameOf = (k) => {
      const P = MANIFEST[k] || {};
      return P.name || P.shortName || P.tab || P.h1 || k;
    };

    let state = null;          // { providers:[…], applied:boolean }
    let picked = null;         // 当前展开明细的 provider key
    let busy = false;          // 本卡自己的忙标志（withBusy 的那个是它闭包里的，拿不到）
    let btnLabel = "";         // 按钮文案缓存，供 5 秒一次的 update() 比对

    /* ------------------------------------------------------------------
     * A. 状态带上的按钮。
     *    v17 单页改版后没有 .prov-tab 页签导航了，按钮改挂在状态带的动作行
     *    （#btnBest / #btnRestore2 / #btnDiag 那一排）——它本来就是顶栏级的动作。
     *    门禁 C9 只数 navViews 里的 data-view，插一个 button 它看不见；
     *    header * 已经是 -webkit-app-region:no-drag，拖窗口照常。
     * ------------------------------------------------------------------ */
    let btn = $("btnModelSync");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "btnModelSync";
      btn.type = "button";
      btn.className = "btn ghost sm";
      btn.textContent = "刷新全部模型";
      btn.title = "依次拉取各家渠道的模型目录，与当前配置对比后给出增删摘要；确认后才写入配置";
      const acts = document.querySelector("#statusBand .acts");
      const hint = acts ? acts.querySelector(".hintx") : null;
      if (acts) { if (hint) hint.before(btn); else acts.appendChild(btn); }
      else document.body.appendChild(btn);
      btnLabel = btn.textContent;

      btn.addEventListener("click", () => {
        ensurePanel();
        setTitle("正在扫描六家模型目录…");
        setOverall("依次向上游取目录，逐家与当前配置对比，请稍候…");
        $("msyncRows").innerHTML = "";
        hideNotes();
        busy = true;
        ctx.withBusy(btn, scan, $("msyncResult"));
      });
    } else {
      /* 重复挂载（同页 extraCards 写重了）时直接收手，别把监听器接两遍 */
      return { update() { }, refresh() { } };
    }

    /* ------------------------------------------------------------------
     * B. 摘要面板：复用 .banner-wrap 现有的竖排栈，追加一块 .banner。
     *    不用 showInfo() —— 它写死在 #bnrInfo 上，只有标题+一段字，放不下六行摘要。
     * ------------------------------------------------------------------ */
    function ensurePanel() {
      const wrap = document.querySelector(".banner-wrap");
      if (!wrap) return;
      if ($("msyncPanel")) { $("msyncPanel").classList.add("show"); return; }
      const d = document.createElement("div");
      d.className = "banner";
      d.id = "msyncPanel";
      d.innerHTML = `
        <div class="t" id="msyncTitle">刷新全部模型</div>
        <div class="tokstat" id="msyncOverall"></div>
        <div id="msyncRows"></div>
        <div id="msyncNotesWrap" style="display:none">
          <div class="msync-note" id="msyncNotesTitle" style="margin-top:8px"></div>
          <pre class="notes" id="msyncNotes"></pre>
        </div>
        <div class="row" id="msyncBtns" style="display:none">
          <button class="btn-main btn-sm" id="btnMsyncApply" type="button" style="padding:5px 14px">应用变更</button>
          <button class="btn-sm" id="btnMsyncRescan" type="button">重新扫描</button>
        </div>
        <div class="result" id="msyncResult"></div>
        <button class="x" id="msyncX" type="button" title="关闭">✕</button>`;
      wrap.appendChild(d);   // 排在 #bnrUpdate / #bnrInfo 下面，三块横幅竖着叠
      d.classList.add("show");

      /* 明细区按需展开：点有变化的那一行，下方滚动区换成这家的模型 id */
      $("msyncRows").addEventListener("click", (e) => {
        const row = e.target.closest ? e.target.closest(".msync-row[data-k]") : null;
        if (row) showNotes(row.getAttribute("data-k"));
      });
      $("msyncX").addEventListener("click", () => {
        $("msyncPanel").classList.remove("show");
        hideNotes();
        const r = $("msyncResult");
        if (r) { r.textContent = ""; r.className = "result"; }
      });
      $("btnMsyncRescan").addEventListener("click", () => {
        ensurePanel();
        setTitle("正在扫描六家模型目录…");
        setOverall("依次向上游取目录，逐家与当前配置对比，请稍候…");
        $("msyncRows").innerHTML = "";
        hideNotes();
        busy = true;
        ctx.withBusy(btn, scan, $("msyncResult"));
      });
      $("btnMsyncApply").addEventListener("click", () => {
        busy = true;
        ctx.withBusy($("btnMsyncApply"), apply, $("msyncResult"));
      });
    }

    const setTitle = (t) => { const el = $("msyncTitle"); if (el) el.textContent = t; };
    const setOverall = (html) => { const el = $("msyncOverall"); if (el) el.innerHTML = html; };
    const hideNotes = () => {
      picked = null;
      const w = $("msyncNotesWrap");
      if (w) w.style.display = "none";
      const box = $("msyncRows");
      if (box) for (const el of box.querySelectorAll(".msync-row")) el.classList.remove("open");
    };

    /* ------------------------------------------------------------------
     * C. 扫描 / 应用
     * ------------------------------------------------------------------ */
    async function scan() {
      busy = true;
      try {
        const j = await ctx.postJSON("/api/models/scan-all", {});
        state = norm(j);
        render();

        /* 桌面通知：只在真有变化时才弹。浏览器直开面板时 window.baiDesktop 是
           undefined（没有 preload 桥），所以这里必须判空——判空失败不能连带
           把下面已经画好的摘要一起弄丢，故单独 try 住。 */
        if (j && j.changed && window.baiDesktop && typeof window.baiDesktop.notifyModelsChanged === "function") {
          try {
            window.baiDesktop.notifyModelsChanged({
              count: state.providers.filter((p) => p.added.length || p.removed.length).length,
            });
          } catch (e) { /* 通知失败不影响扫描结果 */ }
        }
      } catch (e) {
        setTitle("刷新失败");
        setOverall("这次没能读完六家的目录，下面的红字是失败原因。");
        throw e;            // 交给 withBusy 写进显式传入的 #msyncResult
      } finally {
        busy = false;
        syncBtnLabel();
      }
    }

    async function apply() {
      if (!state) return;
      busy = true;
      try {
        // 先把配置回读到最新再算合并：mergeFor 读的是 ctx.cfg，扫描之后用户可能
        // 在「可选模型列表」里改过并保存过，用旧快照合并会连带覆盖掉那几行。
        try { await ctx.refreshConfig(); } catch (e) { /* 没读到就用已有的那份 */ }
        const applyMap = {};
        const skipped = [];
        for (const p of state.providers) {
          if (!p.added.length && !p.removed.length) continue;   // 只发用户真在接受的那些家
          const merged = mergeFor(p);
          if (!merged) { skipped.push(nameOf(p.key)); continue; }   // 手上没有现有名单，不猜
          applyMap[p.key] = merged;
        }
        if (!Object.keys(applyMap).length) {
          ctx.showResult($("msyncResult"), "没有可写入的变更：" + (skipped.length ? "这几家读不到当前配置（" + skipped.join("、") + "），请等配置加载完成再试。" : "六家都没有变化。"), false);
          return;   // busy 由 finally 复位
        }
        await ctx.postJSON("/api/models/apply-all", { apply: applyMap });
        state.applied = true;
        picked = null;
        try { await ctx.refreshConfig(); } catch (e) { /* 写成功就行，配置回读失败不翻案 */ }
        if (typeof ctx.renderRoute === "function") ctx.renderRoute();
        if (typeof ctx.poll === "function") ctx.poll();
        render();
        ctx.showResult($("msyncResult"), "✔ 已写入配置：" + Object.keys(applyMap).map(nameOf).join("、")
          + (skipped.length ? "\n（跳过 " + skipped.join("、") + "：读不到当前配置，未改动）" : ""), true);
      } finally {
        // 少了这个 finally，「没有可写入的变更」那条提前 return 会把 busy 永久
        // 卡在 true——syncBtnLabel() 见 busy 就直接返回，按钮徽标此后再也不更新。
        busy = false;
        syncBtnLabel();
      }
    }

    /* 合并后的完整清单 = 现有 − 移除 + 新增。
       服务端还会再兜一次映射目标（那几档 Claude 不能被删掉），这里按自己的算法发，
       让用户看到/算到的就是我们要写下去的那一份。
       取当前清单走 ctx.sliceOf：最早那家在 /api/config 里是**平铺**的（顶层就是它
       自己的字段），其余家在同名子对象下——v17 清单不再有 shape 字段，由共享层
       运行时探测，v1.0.x 之前那种 `MANIFEST[k].shape === "flat"` 的写法会让
       那一家读成空对象、进而被静默跳过「应用变更」。 */
    function mergeFor(p) {
      const cfg = ctx.cfg;
      if (!cfg) return null;
      const blk = typeof ctx.sliceOf === "function" ? ctx.sliceOf(cfg, p.key) : (cfg[p.key] || cfg);
      const cur = Array.isArray(blk.availableModels) ? blk.availableModels : [];
      if (!cur.length) return null;                 // 没有现有名单，合并会误删，不做
      const rm = new Set(p.removed);
      const out = [];
      for (const m of cur) if (!rm.has(m) && out.indexOf(m) < 0) out.push(m);
      for (const m of p.added) if (out.indexOf(m) < 0) out.push(m);
      return out;
    }

    /* ------------------------------------------------------------------
     * D. 绘制
     * ------------------------------------------------------------------ */
    const hasDelta = (p) => !!(p.added.length || p.removed.length);
    /* error/empty 都是「没拿到可信目录」，不能当成「0 变化」报给用户 */
    const failed = (p) => p.status === "error" || p.status === "empty";

    function norm(j) {
      const raw = Array.isArray(j && j.providers) ? j.providers : [];
      const byKey = {};
      for (const p of raw) if (p && p.key) byKey[p.key] = p;
      const list = ORDER.filter((k) => byKey[k]).map((k) => fix(byKey[k]));
      for (const p of raw) {                       // 清单外的（以后加了家）接在末尾，不丢
        if (p && p.key && !ORDER.includes(p.key)) list.push(fix(p));
      }
      return { changed: !!(j && j.changed), providers: list };
    }
    function fix(p) {
      return {
        key: p.key,
        name: p.name || nameOf(p.key),
        status: p.status || "ok",
        added: Array.isArray(p.added) ? p.added.slice() : [],
        removed: Array.isArray(p.removed) ? p.removed.slice() : [],
        count: typeof p.count === "number" ? p.count : null,
        have: typeof p.have === "number" ? p.have : null,
        note: p.note || "",
        error: p.error || "",
      };
    }

    function render() {
      if (!state) return;
      ensurePanel();
      const panel = $("msyncPanel");
      if (panel) panel.classList.add("show");

      const ps = state.providers;
      const changed = ps.filter(hasDelta);
      const bad = ps.filter(failed);

      setTitle(state.applied
        ? "✔ 已写入配置"
        : (changed.length ? "发现 " + changed.length + " 家模型有变化" : "六家模型目录都没有变化"));

      const parts = [`<span>已扫描 <b>${esc(ps.length)}</b> 家</span>`];
      parts.push(changed.length
        ? `<span>有变化：<b>${esc(changed.map((p) => p.name).join("、"))}</b></span>`
        : `<span><b>全部无变化</b></span>`);
      if (bad.length) parts.push(`<span class="warn"><b>${esc(bad.length)} 家没拿到目录</b></span>`);
      parts.push(state.applied ? `<span>映射目标已重新保护</span>` : `<span>确认后才会写入配置</span>`);
      setOverall(parts.join("　"));

      const box = $("msyncRows");
      if (box) {
        box.innerHTML = "";
        for (const p of ps) {
          const row = document.createElement("div");
          row.className = "msync-row" + (hasDelta(p) ? " openable" : "");
          if (hasDelta(p)) row.setAttribute("data-k", p.key);   // 有变化才可点开看明细
          row.innerHTML = `<span>${esc(p.name)}</span>` + rightSide(p);
          box.appendChild(row);
        }
      }

      const btns = $("msyncBtns");
      if (btns) btns.style.display = changed.length ? "" : "none";
      const ap = $("btnMsyncApply");
      if (ap) {
        ap.textContent = state.applied ? "已应用" : `应用变更（${changed.length} 家）`;
        ap.disabled = !!state.applied;
      }

      if (picked) showNotes(picked); else hideNotes();
      syncBtnLabel();
    }

    /* 右侧那一栏：变化给 +N / -N，没变化与失败各说各的实话 */
    function rightSide(p) {
      if (p.status === "error") {
        // 借用 .msync-del 的红：这里要表达的就是「这一家没成」，跟"少了几个"同属负面
        return `<span class="msync-del">拉取失败：${esc(p.error || p.note || "未知原因")}</span>`;
      }
      if (p.status === "empty") {
        return `<span class="msync-del">目录为空（缓存没能刷新）</span>`;
      }
      if (hasDelta(p)) {
        const a = p.added.length ? `<span class="msync-add">+${p.added.length}</span>` : "";
        const r = p.removed.length ? `<span class="msync-del">-${p.removed.length}</span>` : "";
        return `<span class="msync-delta">${a} ${r}</span><span class="msync-note">点开看明细 ▾</span>`;
      }
      if (p.status === "static") {
        return `<span class="msync-note">${esc(p.note || "静态目录，无实时对比")}</span>`;
      }
      const from = p.have != null ? p.have : null;
      const to = p.count != null ? p.count : null;
      return `<span class="msync-note">无变化${from != null && to != null ? `（${from} → ${to}）` : ""}</span>`;
    }

    function showNotes(key) {
      if (!state) return;
      const p = state.providers.find((x) => x.key === key);
      if (!p || !hasDelta(p)) { hideNotes(); return; }
      picked = key;
      const w = $("msyncNotesWrap");
      if (w) w.style.display = "";
      const ttl = $("msyncNotesTitle");
      if (ttl) ttl.textContent = p.name + " · 增删明细";
      const n = $("msyncNotes");
      if (n) {
        const merged = mergeFor(p);
        const lines = [];
        if (p.added.length) lines.push("新增 " + p.added.length + " 个：", ...p.added.map((m) => "+ " + m));
        if (p.removed.length) lines.push("", "移除 " + p.removed.length + " 个：", ...p.removed.map((m) => "- " + m));
        lines.push("", merged
          ? "应用后合计 " + merged.length + " 个（当前 " + (merged.length - p.added.length + p.removed.length) + " 个）"
          : "（读不到当前配置，没法算出合并后的清单）");
        n.innerHTML = esc(lines.join("\n"));
      }
      const box = $("msyncRows");
      if (box) {
        for (const el of box.querySelectorAll(".msync-row")) {
          el.classList.toggle("open", el.getAttribute("data-k") === key);
        }
      }
    }

    /* 按钮上的小徽标：只在有「未确认的变更」时出现，5 秒一次的 update 里同步一次 */
    function syncBtnLabel() {
      if (!btn || busy) return;
      const n = state && !state.applied ? state.providers.filter(hasDelta).length : 0;
      const label = n ? `刷新全部模型 · ${n}` : "刷新全部模型";
      if (label !== btnLabel) { btn.textContent = label; btnLabel = label; }
    }

    /* ------------------------------------------------------------------
     * E. 交给 poll 循环的两个钩子
     * ------------------------------------------------------------------ */
    return {
      // 每 5 秒调一次：只同步按钮文案（纯本地、无网络）。
      update() { syncBtnLabel(); },
      // 「刷新模型列表」等动作之后由共享层叫一次，此时配置刚换新，徽标要跟着收。
      refresh() { syncBtnLabel(); },
    };
  },
};
