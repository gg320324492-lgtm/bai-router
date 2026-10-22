/* cards/limits.js —— 限流卡（每家并发上限 / 每分钟请求上限）。
 *
 * 这张卡回答的是「**别把某一家打爆**」：
 *   把某家的并发开满 → 上游回 429 → 整条故障转移链跟着挨打。
 *   magpie 有两道闸（并发道 + 每分钟请求数），这里是对应的开关。
 *
 * ── 三条口径 ──
 *   ① **0 = 不限**（默认）。限流是用户自己开的开关 —— 它不该突然开始拦请求。
 *   ② 上限是**每家一份**的全局默认；逐家覆盖写在 cfg[provider].limits 里
 *      （面板暂不给逐家输入 —— 那是另一张卡的活）。
 *   ③ 两道闸**顺序**是「先并发名额、后每分钟名额」：每分钟名额记的是**真发出去的
 *      请求**，先占它会在并发排队时白耗额度。
 *
 * ── 渠道名一律不写死 ──
 *   显示名走 ctx.nameOf(key)；清单之外的渠道原样显示 key。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["limits"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));

    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    let box = $("limitsPanel");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "limitsPanel";
      box.innerHTML = `
        <div class="pb-head">
          <h3>限流</h3>
          <span class="sub">每家一份上限 · 0 = 不限</span>
        </div>
        <div class="fieldset">
          <div class="fpline">
            <span class="k">并发上限</span>
            <span class="v"><input type="number" min="0" step="1" data-role="l-conc" style="width:110px"></span>
            <span class="v dim">每家同时在途的请求数</span>
          </div>
          <div class="fpline">
            <span class="k">每分钟上限</span>
            <span class="v"><input type="number" min="0" step="1" data-role="l-rpm" style="width:110px"></span>
            <span class="v dim">每家每分钟最多发多少个请求</span>
          </div>
          <div style="margin-top:8px">
            <button type="button" class="btn sm" data-role="l-save">保存</button>
            <button type="button" class="btn sm" data-role="l-reset">恢复不限</button>
          </div>
          <div class="result" data-role="l-result"></div>
          <div data-role="l-note"></div>
          <div data-role="l-body"></div>
          <div data-role="l-budget"></div>
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
    let loaded = false;   // 至少成功读过一回（没读过 ≠ 没有占用数据）
    let sig = "";

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const int = (v) => num(v).toLocaleString("zh-CN");

    const known = (k) => (ctx.channels || []).indexOf(k) >= 0;
    const nameOfKey = (k) => {
      const s = String(k == null ? "" : k);
      if (!s) return "—";
      return known(s) ? ctx.nameOf(s) : s;
    };

    function setResult(text, ok) {
      const el = q('[data-role="l-result"]');
      if (!el) return;
      el.textContent = text || "";
      el.className = "result" + (ok === false ? " err" : ok === true ? " ok" : "");
    }

    function renderInputs() {
      const l = (data && data.limits) || {};
      const conc = q('[data-role="l-conc"]');
      const rpm = q('[data-role="l-rpm"]');
      /* 只在「用户没在改」时回填 —— 否则每 5 秒一次轮询会把用户正在输入的数字冲掉。 */
      if (conc && document.activeElement !== conc) conc.value = String(num(l.concurrency));
      if (rpm && document.activeElement !== rpm) rpm.value = String(num(l.rpm));
    }

    function renderBody() {
      const body = q('[data-role="l-body"]');
      if (!body) return;
      const stats = (data && data.stats) || {};
      const keys = Object.keys(stats);
      if (!loaded && !lasterr) {
        /* 第一次读还没回来：先说「在读」，别拿空态冒充「没有占用数据」。 */
        body.innerHTML = S3("loadingState", "正在读限流状态…", { hint: "读完这一块就知道各家现在被占了多少名额。" });
        return;
      }
      if (lasterr) {
        /* 读不到 ⇒ 整块换成错误态（必须带下一步）。 */
        body.innerHTML = S3("errorState", "读不到限流状态", {
          hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
          detail: lasterr,
        });
        return;
      }
      if (!keys.length) {
        /* 空态要说清「怎么才会出现」：空白会让用户以为这张卡坏了。 */
        body.innerHTML = S3("emptyState", "还没有各家的占用数据", {
          hint: "发生过请求之后这里才会有在途 / 排队 / 被拒的数字 —— 上面两个上限仍然可以随时填。",
        });
        return;
      }
      const rows = keys.map((k) => {
        const s = stats[k] || {};
        const busy = num(s.busy);
        const lim = num(s.limit);
        return `<tr>
            <td>${esc(nameOfKey(k))}</td>
            <td class="dim">${esc(lim ? `${busy} / ${lim}` : "不限")}</td>
            <td class="dim">${esc(num(s.waiting))}</td>
            <td class="dim">${esc(int(s.rejected))}</td>
            <td class="dim">${esc(num(s.leaked) ? esc(num(s.leaked)) + " ⚠" : "0")}</td>
          </tr>`;
      }).join("");
      body.innerHTML = `
        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:12px">当前占用</h2>
          <span class="note">在途 / 上限 · 排队 · 被拒 · 漏还</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr>
            <th style="width:34%">渠道</th>
            <th style="width:24%">在途/上限</th>
            <th style="width:14%">排队</th>
            <th style="width:14%">被拒</th>
            <th style="width:14%">漏还</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    function renderBudget() {
      const box = q('[data-role="l-budget"]');
      if (!box) return;
      const stats = (data && data.stats) || {};
      const keys = Object.keys(stats);
      if (!keys.length) { box.innerHTML = ""; return; }
      const rows = keys.map((k) => {
        const s = stats[k] || {};
        const b = s.budget || null;
        const used = b ? num(b.used) : 0;
        const limit = b ? num(b.limit) : 0;
        const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
        const exhausted = b && b.exhausted;
        return `<tr>
            <td>${esc(nameOfKey(k))}</td>
            <td><input type="number" min="0" step="1000" data-role="q-h-${esc(k)}" value="${b && b.hourly ? esc(num(b.hourly)) : ""}" placeholder="不限" style="width:110px"></td>
            <td><input type="number" min="0" step="10000" data-role="q-d-${esc(k)}" value="${b && b.daily ? esc(num(b.daily)) : ""}" placeholder="不限" style="width:110px"></td>
            <td class="dim">${limit ? `${int(used)} / ${int(limit)}（${pct}%）` : "—"}</td>
            <td>${exhausted ? '<span class="led err"></span> 已用完' : (b ? '<span class="led ok"></span> 正常' : "—")}</td>
            <td><button type="button" class="btn sm" data-role="q-save-${esc(k)}">保存</button></td>
          </tr>`;
      }).join("");
      box.innerHTML = `
        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:12px">额度预算</h2>
          <span class="note">单位是 token（不是钱）· 用完了这家会自己歇到窗口重置</span>
        </div>
        <table class="route" style="table-layout:fixed">
          <thead><tr>
            <th style="width:20%">渠道</th>
            <th style="width:20%">每小时上限</th>
            <th style="width:20%">每天上限</th>
            <th style="width:20%">已用 / 上限</th>
            <th style="width:12%">状态</th>
            <th style="width:8%"></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      for (const k of keys) {
        const btn = box.querySelector(`[data-role="q-save-${k}"]`);
        if (!btn) continue;
        btn.addEventListener("click", async () => {
          const h = box.querySelector(`[data-role="q-h-${k}"]`);
          const d = box.querySelector(`[data-role="q-d-${k}"]`);
          setResult("正在保存…");
          try {
            const r = await ctx.api("/api/quota", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({
                provider: k,
                hourly: h && h.value !== "" ? h.value : null,
                daily: d && d.value !== "" ? d.value : null,
              }),
            });
            if (r && r.ok === false) throw new Error(r.error || "保存失败");
            setResult(`✔ 已保存 ${nameOfKey(k)} 的额度预算`, true);
            await load(); renderTotals(); renderBody(); renderBudget();
          } catch (e) {
            setResult("✖ 保存失败：" + String((e && e.message) || e), false);
          }
        });
      }
    }

    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await ctx.api("/api/limits");
        if (r && r.ok === false) throw new Error(r.error || "读不到限流设置");
        data = r || null;
        lasterr = "";
      } catch (e) {
        lasterr = String((e && e.message) || e);
      } finally {
        inflight = false;
        loaded = true;
        /* ⚠ 读完就重画：不重画的话这一块会**停在「正在读」**直到下一轮 5 秒轮询
           （load() 里 `if (inflight) return;` 不会等这次读，update() 也等不到它）。 */
        renderInputs();
        renderBody();
        renderBudget();
      }
    }

    async function save(conc, rpm) {
      setResult("正在保存…");
      try {
        const r = await ctx.api("/api/limits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ concurrency: conc, rpm }),
        });
        if (r && r.ok === false) throw new Error(r.error || "保存失败");
        setResult("✔ 已保存", true);
        await load();
        renderInputs();
        renderBody();
      } catch (e) {
        setResult("✖ 保存失败：" + String((e && e.message) || e), false);
      }
    }

    const bind = (role, fn) => {
      const el = q(`[data-role="${role}"]`);
      if (el) el.addEventListener("click", fn);
    };
    bind("l-save", () => {
      const conc = Math.max(0, Math.floor(num(q('[data-role="l-conc"]') && q('[data-role="l-conc"]').value)));
      const rpm = Math.max(0, Math.floor(num(q('[data-role="l-rpm"]') && q('[data-role="l-rpm"]').value)));
      save(conc, rpm);
    });
    bind("l-reset", () => {
      if (!confirm("恢复成不限？各家的并发与每分钟上限都会归零（不再拦任何请求）。")) return;
      save(0, 0);
    });

    function signature() {
      const s = (data && data.stats) || {};
      return JSON.stringify([(data && data.limits && data.limits.concurrency) || 0,
        (data && data.limits && data.limits.rpm) || 0,
        Object.keys(s).map((k) => [k, s[k].busy, s[k].waiting, s[k].rejected,
          s[k].budget ? s[k].budget.used : 0, s[k].budget ? s[k].budget.limit : 0]).flat()])
        + "|" + (loaded ? "1" : "0") + "|" + lasterr;
    }

    /* 首屏先画「在读」并把第一次读发出去：否则这 5 秒里这一块是空白，
       空白既不是「在读」也不是「没有占用数据」，用户只能猜。 */
    renderInputs();
    renderBody();
    renderBudget();
    load();

    return {
      async update() {
        await load();
        const note = q('[data-role="l-note"]');
        if (note) {
          note.innerHTML = lasterr
            ? S3("errorState", "读不到限流状态", {
              hint: "看诊断抽屉（右上角）确认是中转没起来还是端口不通；修好后面板会自己读回来。",
              detail: lasterr,
            })
            : "";
        }
        const s = signature();
        if (s !== sig) { sig = s; renderInputs(); renderBody(); renderBudget(); }
      },
      refresh() { return load(); },
    };
  },
};
