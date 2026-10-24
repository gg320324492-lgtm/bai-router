/* cards/clients.js —— 客户端屏的卡（把 B.AI 接到装好的 CLI / 桌面端上）。
 *
 * 这张卡回答的是「**我装的那个客户端能不能用上 B.AI？**」：
 *   ① 有哪些客户端能接（magpie 支持 66 个，B.AI 正在一个个铺）
 *   ② 每一个：它的配置文件在哪、说哪种方言、现在接上了没有
 *   ③ 一键接上 / 一键断开
 *
 * ── 名字一个字都不写死 ──────────────────────────────────────────────
 *   客户端的名字、说明、方言全从 /api/clients 拿（那是 clients/registry.mjs
 *   扫目录得到的真实清单）。这里写死任何名字，第二天加了新客户端就会
 *   有一半在屏幕上对不上 —— 而且**渲染层不该知道有哪些客户端**：
 *   加客户端是服务端的事，前端不该跟着改。
 *
 * ── 颜色只承载状态 ────────────────────────────────────────────────
 *   LED 的 class（ok / idle / err）由 CSS 去 var() 取值，深浅两套主题都验过。
 *   写死色值就等于只支持一套主题。
 *
 * ── 「接上」会改用户的文件 ──────────────────────────────────────────
 *   接线会写客户端的配置文件（写之前先备份我们改的那几处，断开时原样还原）。
 *   这一句必须在按钮旁边说清楚 —— 用户有权知道自己点了会发生什么。
 *
 * ── 刷新节奏 ────────────────────────────────────────────────────────
 *   共享层每 5 秒轮询一次（panel-common.js → cards.update()），本卡**不**
 *   自己另起定时器：两个节奏会打架，画面上的数会来回跳。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["clients"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    const kit = window.BAI_KIT || null;
    const esc = ctx.esc || (kit && kit.esc) || ((s) => String(s == null ? "" : s));
    const S3 = (kind, text, opts) => (kit
      ? kit[kind](text, opts)
      : '<div class="hint">' + esc(text) + "</div>");

    let box = $("clientsPanel");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "clientsPanel";
      box.innerHTML = `
        <div class="pb-head">
          <h3>客户端</h3>
          <span class="sub">把 B.AI 接进装好的 CLI / 桌面端 · 断开时原样还原</span>
        </div>
        <div class="fieldset">
          <div class="fpline">
            <span class="k">统一网关地址</span>
            <span class="v mono" data-role="c-base">—</span>
          </div>
          <div class="fpline" style="align-items:flex-start;margin-top:6px">
            <span class="k">接哪一家</span>
            <span class="v">
              <span data-role="c-providers" style="display:flex;gap:6px;flex-wrap:wrap"></span>
              <div class="hint" style="margin-top:4px">
                多数客户端自己挑模型，走网关就行（模型 id 形如 <span class="mono">provider/档位</span>）；
                <b>Claude Code 挑不了模型</b>，要在这儿定一家，它才会写对模型 id。
              </div>
            </span>
          </div>
          <div style="margin-top:8px">
            <button type="button" class="btn sm" data-role="c-reload">重新扫描</button>
            <span class="v dim" style="margin-left:8px" data-role="c-count"></span>
          </div>
          <div class="hint" style="margin-top:6px">
            客户端里那几个能力项（图片 / 思考）目前是<b>保守值</b> —— 我们知道的是「档位」，
            不知道它映射到哪家上游（同一档位逐家能力不同），所以宁可先不给。
            真值随「模型元数据下发」到位。
          </div>
          <div class="hint" style="margin-top:4px" data-role="c-plugins"></div>
          <div class="result" data-role="c-result"></div>
          <div data-role="c-kept"></div>
          <div data-role="c-body"></div>
        </div>`;
      const viewRoot = (slot.closest && slot.closest(".view")) || slot;
      viewRoot.appendChild(box);
    }
    const q = (sel) => box.querySelector(sel);

    let data = null;
    let lasterr = "";
    let inflight = false;
    let loaded = false;
    let sig = "";
    /* ⚠「接哪一家」是**这张卡自己的**选择，不改面板的当前渠道
     *   （面板是按渠道分页的，切它会把用户带走）。 */
    let target = (ctx.channel || "bai");

    function setResult(text, ok) {
      const el = q('[data-role="c-result"]');
      if (!el) return;
      el.textContent = text || "";
      el.className = "result" + (ok === false ? " err" : ok === true ? " ok" : "");
    }

    /**
     * showKept —— 把「保留了你手改的 N 处」**列出来**（不只是说个数）。
     *
     * ⚠ **两类要分开说**（它们是两回事）：
     * · `theirs`（缺省）—— 那个键**我们本来就会写**，但用户改过 ⇒ 让给他
     *   ⇒ 显示「路径 · 你的值 · 我们记的值」；
     * · `unmanaged` —— **我们压根没写**的键，用户自己加的 ⇒ 弱保留层留下的
     *   ⇒ 只列**键名**（它们是「用户自己的一堆东西」，一个个列值太长）。
     * ⚠ **值可以显示**：kept 里的值**已过凭据脱敏**（长串会被换成
     *   「（长度 N 的长串…）」）⇒ 面板上直接显示即可，**不要**再往外发。
     * ⚠ 路径**带文件名**（`cfg.json:providers.bai.name`）—— 多文件的客户端里
     *   同一个点分路径会出现好几次（base.mjs 里拼的），不带文件名分不清是哪一份。
     * ⚠ 只列前 8 条：用户手改十几处的话，一屏铺开反而看不清。
     */
    function showKept(kept) {
      const box = q('[data-role="c-kept"]');
      if (!box) return;
      const list = Array.isArray(kept) ? kept : [];
      if (!list.length) { box.innerHTML = ""; return; }
      const theirs = list.filter((k) => k.kind !== "unmanaged");
      const unmanaged = list.filter((k) => k.kind === "unmanaged");
      const parts = [];
      if (theirs.length) {
        const rows = theirs.slice(0, 8).map((k) => (
          `<div class="dim" style="font-size:11px;margin-top:4px">` +
          `<span class="mono">${esc(String(k.path || ""))}</span>` +
          ` · 你的：${esc(String(k.theirs == null ? "（没这一项）" : k.theirs))}` +
          ` · 我们记的：${esc(String(k.ours == null ? "（没这一项）" : k.ours))}` +
          `</div>`
        )).join("");
        parts.push(
          `<details style="margin-top:6px">` +
          `<summary class="dim" style="cursor:pointer">保留了你手改的 ${theirs.length} 处（点开看是哪几处）</summary>` +
          rows +
          (theirs.length > 8 ? `<div class="dim" style="font-size:11px">…等 ${theirs.length} 处</div>` : "") +
          `</details>`
        );
      }
      if (unmanaged.length) {
        const names = unmanaged.slice(0, 12).map((k) => String(k.path || ""));
        parts.push(
          `<details style="margin-top:4px">` +
          `<summary class="dim" style="cursor:pointer">还留着你自己的 ${unmanaged.length} 个键（我们没写它们）</summary>` +
          `<div class="dim" style="font-size:11px;margin-top:4px">` +
          names.map((n) => `<span class="mono">${esc(n)}</span>`).join("、") +
          (unmanaged.length > 12 ? ` 等 ${unmanaged.length} 个` : "") +
          `</div></details>`
        );
      }
      box.innerHTML = parts.join("");
    }

    /* 一个客户端的**状态灯**：接上了是 ok，没接是 idle，装不上/读不懂是 err。
     * ⚠ **半个接线用黄灯（warn）**：绿灯 + 「已接上」对 Cursor CLI 那一格是误导
     *   （它的请求仍然走 Cursor 自己的后端，一个都没到 B.AI）。 */
    function ledOf(st) {
      if (!st) return "idle";
      if (st.halfWired) return "warn";
      if (st.wired) return st.partial ? "warn" : "ok";
      if (st.missing) return "idle";
      if (st.configured) return "idle";
      return "idle";
    }

    /* 状态的一句话。**说清是哪一种**：「没装」「装了但没配置」「没接」是三件事。
     * ⚠ 「已接上」只有**真的**走到 B.AI 才许说 —— 「半个接线」（声明层的
     *   partial）与「只接了一半」（多层客户端缺一层）都要另说。 */
    function statusText(st) {
      if (!st) return "—";
      if (st.halfWired) return "只接了一半";
      if (st.wired) return st.partial ? "只接了一半" : "已接上";
      if (st.missing) return "没装这个客户端";
      if (st.notConfigured) return "装了，还没生成过配置";
      if (st.configured) return st.partial ? "只接了一半" : "配置里有，但不是本机接的";
      return "没接";
    }

    /** 渠道按钮组：把「接哪一家」摆在明面上（Claude Code 挑不了模型，得人定）。 */
    function renderProviders() {
      const box2 = q('[data-role="c-providers"]');
      if (!box2) return;
      const keys = Array.isArray(ctx.channels) ? ctx.channels : [];
      if (!keys.length) { box2.innerHTML = ""; return; }
      box2.innerHTML = keys.map((k) => {
        const on = k === target;
        const label = ctx.nameOf ? ctx.nameOf(k) : k;
        return `<button type="button" class="btn sm${on ? " primary" : ""}" data-role="c-prov-${esc(k)}">${esc(label)}</button>`;
      }).join("");
      for (const k of keys) {
        const b = box2.querySelector(`[data-role="c-prov-${esc(k)}"]`);
        if (!b) continue;
        b.addEventListener("click", () => {
          if (target === k) return;
          target = k;
          renderProviders();
          setResult("接到「" + (ctx.nameOf ? ctx.nameOf(k) : k) + "」");
        });
      }
    }

    function renderBody() {
      const body = q('[data-role="c-body"]');
      if (!body) return;
      /* 统一网关地址：接上之后客户端里写的就是它 —— 用户要看得见。
       * ⚠ 在**这里**设（不是只放在 update() 里）：首屏是 renderBody 画的，
       *   update() 要等共享层下一轮轮询才来 —— 那之前它会一直显示「—」，
       *   看着像「没有地址」。 */
      const baseEl = q('[data-role="c-base"]');
      if (baseEl) baseEl.textContent = String((data && data.baseUrl) || "—");
      const list0 = Array.isArray(data && data.list) ? data.list : [];
      /* 插件声明放哪儿 ⇒ 告诉用户「从哪下手」，否则「一份 JSON 加一个客户端」这条
       * 功能用户压根不知道存在。 */
      const pdEl = q('[data-role="c-plugins"]');
      if (pdEl) {
        const dir = data && data.pluginsDir;
        pdEl.innerHTML = dir
          ? `想加一个<b>你自己的</b>客户端？往 <span class="mono">${esc(String(dir))}</span> 放一份 JSON 声明，再点「重新扫描」。`
          : "";
      }
      const cntEl = q('[data-role="c-count"]');
      if (cntEl) {
        /* ⚠ **只数真的走到 B.AI 的**：把「半个接线」（Cursor CLI 那一格：改了模型
         *   但请求仍然走 Cursor 自己的后端）算进「已接上」⇒ 这个数字会骗人。
         *   半个接线的另算、另说。 */
        const wired0 = list0.filter((c) => c.status && c.status.wired && !c.status.partial).length;
        const half0 = list0.filter((c) => c.status && (c.status.partial || c.status.halfWired)).length;
        cntEl.textContent = list0.length
          ? `${wired0} / ${list0.length} 已接上` + (half0 ? `（另有 ${half0} 个只接了一半）` : "")
          : "";
      }
      if (!loaded && !lasterr) {
        body.innerHTML = S3("loadingState", "正在读客户端清单…", { hint: "读完就知道哪些客户端能接、哪些已经接上了。" });
        return;
      }
      if (lasterr) {
        body.innerHTML = S3("errorState", "读不到客户端清单", {
          hint: "点上面的「重新扫描」重试；还不行就看诊断抽屉（右上角）。",
          detail: lasterr,
        });
        return;
      }
      const list = Array.isArray(data && data.list) ? data.list : [];
      if (!list.length) {
        body.innerHTML = S3("emptyState", "还没有可接的客户端", {
          hint: "这一屏列的是「能接 B.AI 的客户端」。清单是空的，说明服务端一个都没登记上。",
        });
        return;
      }

      /* ⚠ **排序在本地做**：已装的排前面、接上的排更前。服务端按名字排，
       *   而「装没装」会变 —— 每 5 秒重排一次的话，画面上的行会跳。
       *   「装了但还没生成配置」排在「没接」前面（离能接更近），
       *   「没装」排最后。 */
      const rank = (c) => {
        const st = c.status || {};
        if (st.wired) return 0;
        if (st.notConfigured) return 1;
        if (st.missing) return 3;
        return 2;
      };
      const rows = list.slice().sort((a, b) => rank(a) - rank(b)
        || String(a.name || a.id).localeCompare(String(b.name || b.id)));

      body.innerHTML = rows.map((c) => {
        const st = c.status || {};
        const broken = !!c.broken;
        return `<div class="fieldset" style="margin-top:10px">
          <div class="fpline" style="align-items:flex-start">
            <span class="k">
              <span class="led ${ledOf(st)}"></span>
              ${esc(String(c.name || c.id))}
              <br><span class="mono dim" style="font-size: 11px">${esc(String(c.id || ""))}</span>
            </span>
            <span class="v">
              ${esc(statusText(st))}
              ${c.protocol ? `<span class="dim"> · ${esc(String(c.protocol))}</span>` : ""}
              ${c.note ? `<div class="hint" style="margin-top:2px">${esc(String(c.note))}</div>` : ""}
              ${st.file ? `<div class="hint mono" style="margin-top:2px;word-break:break-all">${esc(String(st.file))}</div>` : ""}
            </span>
          </div>
          ${broken ? "" : `<div style="margin-top:8px;display:flex;gap:7px;flex-wrap:wrap">
            ${st.wired
              ? `<button type="button" class="btn sm ghost" data-role="c-rev-${esc(String(c.id))}">断开</button>`
              : `<button type="button" class="btn sm" data-role="c-app-${esc(String(c.id))}">接上</button>`}
            ${st.detail ? `<span class="v dim">${esc(String(st.detail))}</span>` : ""}
          </div>`}
        </div>`;
      }).join("");

      bindRows();
    }

    function bindRows() {
      const body = q('[data-role="c-body"]');
      if (!body) return;
      for (const c of (data && data.list) || []) {
        const id = String(c.id || "");
        const app = body.querySelector(`[data-role="c-app-${id}"]`);
        if (app) {
          app.addEventListener("click", async () => {
            setResult("正在接上…");
            try {
              const r = await ctx.api("/api/clients/apply", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ id, provider: target }),
                timeoutMs: 30000,
              });
              if (r && r.ok === false) throw new Error(r.error || r.detail || "接不上");
              setResult("✔ " + String((r && r.detail) || "已接上"), true);
              showKept(r && r.kept);
              await load(); renderBody();
            } catch (e) {
              setResult("✖ 接不上：" + String((e && e.message) || e), false);
            }
          });
        }
        const rev = body.querySelector(`[data-role="c-rev-${id}"]`);
        if (rev) {
          rev.addEventListener("click", async () => {
            /* 断开是**恢复**（把我们写的那几处还原回去），但它仍然要改用户文件 ——
               确认一下比较稳。 */
            if (typeof window.confirm === "function"
              && !window.confirm("断开会把 B.AI 从这个客户端的配置里摘掉（只还原我们写过的那几处，其余不动）。继续？")) return;
            setResult("正在断开…");
            try {
              const r = await ctx.api("/api/clients/revert", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ id }),
                timeoutMs: 30000,
              });
              if (r && r.ok === false) throw new Error(r.error || r.detail || "断不开");
              setResult("✔ " + String((r && r.detail) || "已断开"), true);
              showKept(null);   // 断开了 ⇒ 那份「保留了你手改的」清单不再成立
              await load(); renderBody();
            } catch (e) {
              setResult("✖ 断不开：" + String((e && e.message) || e), false);
            }
          });
        }
      }
    }

    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await ctx.api("/api/clients");
        if (r && r.ok === false) throw new Error(r.error || "读不到客户端清单");
        data = r || null;
        lasterr = "";
      } catch (e) {
        lasterr = String((e && e.message) || e);
      } finally {
        inflight = false;
        loaded = true;
        renderBody();
      }
    }

    const reloadBtn = q('[data-role="c-reload"]');
    if (reloadBtn) {
      reloadBtn.addEventListener("click", async () => {
        setResult("正在重新扫描…");
        /* ⚠ **必须先让服务端重扫**（丢掉名录缓存）：只 reload 面板拿到的是**缓存** ⇒
         *   用户刚放进 <数据目录>/agent-plugins/ 的声明不会出现在列表里，
         *   按钮看上去「点了没反应」。 */
        try {
          const r = await ctx.api("/api/clients/rescan", {
            method: "POST", headers: { "content-type": "application/json" },
            body: "{}", timeoutMs: 30000,
          });
          const n = r && r.count;
          setResult(n ? `✔ 扫完了（${n} 个客户端）` : "✔ 扫完了", true);
        } catch (e) {
          setResult("✖ 重扫失败：" + String((e && e.message) || e), false);
        }
        await load();
        renderBody();
      });
    }

    /* 首屏先画「在读」并把第一次读发出去。 */
    renderProviders();
    renderBody();
    load();

    const hidden = () => {
      const vr = box.closest && box.closest(".view");
      if (!vr || !vr.classList || typeof vr.classList.contains !== "function") return false;
      return !vr.classList.contains("on");
    };

    return {
      async update() {
        if (hidden()) return;
        await load();
        const s = JSON.stringify(((data && data.list) || []).map((c) => [c.id, c.status && c.status.wired, c.status && c.status.missing]));
        if (s !== sig) { sig = s; renderBody(); bindRows(); }
        const n = ((data && data.list) || []).length;
        const wired = ((data && data.list) || []).filter((c) => c.status && c.status.wired).length;
        const cnt = q('[data-role="c-count"]');
        if (cnt) cnt.textContent = n ? `${wired} / ${n} 已接上` : "";
      },
      refresh() { if (!hidden()) return load(); },
    };
  },
};
