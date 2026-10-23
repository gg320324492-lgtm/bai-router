/* cards/plugins.js —— 插件渠道卡（声明式加一家渠道，不用改代码）。
 *
 * 这张卡回答的是「**能不能不加一家新渠道**」：
 *   ① 插件目录在哪、里面装了哪些、每家的上游/协议/端口/模型
 *   ② 凭据（插件声明里**不许带**凭据 —— 那是分发物，带 key 等于把 key 发给所有装它的人）
 *   ③ 装不上的声明与**为什么装不上**（人话，不是 "invalid schema"）
 *   ④ 一键接线：把这家接到 Claude Code 上
 *
 * ── 三条口径 ──
 *   ① **形状来自声明，凭据来自这里**。声明改了就能改用户的上游与模型清单 ——
 *      那正是「插件」的意思（用户自己决定装不装）；但**凭据绝不进声明**。
 *   ② 插件渠道**不出现在出厂渠道矩阵里**（那张表是静态清单）。它们在这里单列，
 *      免得一个第三方声明去改动用户对出厂渠道的认知。
 *   ③ 装不上的声明**要说清为什么** —— 用户看得懂才能改。一句「加载失败」等于没说。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["plugins"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));

    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    let box = $("pluginsPanel");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "pluginsPanel";
      box.innerHTML = `
        <div class="pb-head">
          <h3>插件渠道</h3>
          <span class="sub">一份 JSON 声明就能加一家渠道 · 不改代码</span>
        </div>
        <div class="fieldset">
          <div class="fpline"><span class="k">插件目录</span><span class="v mono" data-role="p-dir">—</span></div>
          <div style="margin-top:8px">
            <button type="button" class="btn sm" data-role="p-reload">重新扫描目录</button>
          </div>
          <div class="result" data-role="p-result"></div>
          <div data-role="p-note"></div>
          <div data-role="p-body"></div>
          <div data-role="p-mw"></div>
          <div data-role="p-cp"></div>
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
    let loaded = false;   // 至少成功读过一回（没读过 ≠ 没有插件）
    let sig = "";

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

    function setResult(text, ok) {
      const el = q('[data-role="p-result"]');
      if (!el) return;
      el.textContent = text || "";
      el.className = "result" + (ok === false ? " err" : ok === true ? " ok" : "");
    }

    function renderBody() {
      const body = q('[data-role="p-body"]');
      if (!body) return;
      if (!loaded && !lasterr) {
        /* 第一次读还没回来：先说「在读」，别拿空态冒充「没有插件」。 */
        body.innerHTML = S3("loadingState", "正在读插件清单…", { hint: "读完这一块就知道插件目录里装了哪些。" });
        return;
      }
      if (lasterr) {
        /* 读不到 ⇒ 整块换成错误态（必须带下一步）。 */
        body.innerHTML = S3("errorState", "读不到插件清单", {
          hint: "点上面的「重新扫描目录」重试；还不行就看诊断抽屉（右上角）。",
          detail: lasterr,
        });
        return;
      }
      const plugins = Array.isArray(data && data.plugins) ? data.plugins : [];
      const errors = Array.isArray(data && data.errors) ? data.errors : [];

      const errHtml = errors.length ? `
        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:13px">装不上的声明</h2>
          <span class="note">${errors.length} 份</span>
        </div>
        ${errors.map((e) => `<div class="hint" style="margin-top:6px;padding:10px 12px;border:1px solid var(--line);border-radius:9px">
          <b class="mono">${esc(String(e.file || ""))}</b><br>${esc(String(e.error || ""))}
        </div>`).join("")}` : "";

      const rows = plugins.map((p) => {
        const id = String(p.id || "");
        const needKey = !!p.credentialField;
        return `<div class="fieldset" style="margin-top:12px">
          <div class="fpline">
            <span class="k">${esc(String(p.name || id))}</span>
            <span class="v mono">${esc(id)}</span>
            <span class="v dim">${esc(String(p.protocol || ""))} · 端口 ${esc(num(p.relayPort))}</span>
          </div>
          <div class="fpline"><span class="k">上游</span><span class="v mono" style="word-break:break-all">${esc(String(p.upstream || ""))}</span></div>
          <div class="fpline"><span class="k">模型</span><span class="v mono">${esc((p.models || []).join(" · "))}</span></div>
          ${needKey ? `<div class="fpline">
            <span class="k">凭据</span>
            <span class="v"><input type="password" data-role="p-key-${esc(id)}" autocomplete="new-password" placeholder="${p.hasCredential ? "已填写（留空则不改）" : "粘贴 " + esc(String(p.credentialField))}" style="width:260px"></span>
            <span class="v"><button type="button" class="btn sm" data-role="p-save-${esc(id)}">保存凭据</button></span>
          </div>` : `<div class="fpline"><span class="k">凭据</span><span class="v dim">这个渠道的认证方式不需要凭据</span></div>`}
          <div style="margin-top:8px">
            <button type="button" class="btn sm" data-role="p-apply-${esc(id)}">接到 Claude Code</button>
            <span class="v dim" data-role="p-state-${esc(id)}" style="margin-left:8px"></span>
          </div>
        </div>`;
      }).join("");

      body.innerHTML = errHtml + (plugins.length ? rows : S3("emptyState", "还没有插件渠道", {
        hint: "把一份 JSON 声明放进上面的插件目录，点「重新扫描目录」即可 —— 声明里不许带凭据（那是分发物），凭据在这一张卡里填。",
      }));
    }

    function bindRows() {
      const body = q('[data-role="p-body"]');
      if (!body) return;
      const plugins = Array.isArray(data && data.plugins) ? data.plugins : [];
      for (const p of plugins) {
        const id = String(p.id || "");
        const saveBtn = body.querySelector(`[data-role="p-save-${id}"]`);
        if (saveBtn) {
          saveBtn.addEventListener("click", async () => {
            const input = body.querySelector(`[data-role="p-key-${id}"]`);
            const key = input ? String(input.value || "") : "";
            if (!key) { setResult("凭据没填", false); return; }
            setResult("正在保存…");
            try {
              const r = await ctx.api("/api/plugins/credential", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ id, key }),
              });
              if (r && r.ok === false) throw new Error(r.error || "保存失败");
              if (input) input.value = "";          // 凭据不留在输入框里
              setResult("✔ 已保存（不回显）", true);
              await load(); renderBody();
            } catch (e) {
              setResult("✖ 保存失败：" + String((e && e.message) || e), false);
            }
          });
        }
        const applyBtn = body.querySelector(`[data-role="p-apply-${id}"]`);
        if (applyBtn) {
          applyBtn.addEventListener("click", async () => {
            setResult("正在接线…");
            try {
              const r = await ctx.api("/api/apply", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ provider: id, cli: true, desktop: false }),
                timeoutMs: 30000,
              });
              if (r && r.ok === false) throw new Error(r.error || "接线失败");
              setResult(`✔ 已把 ${p.name || id} 接到 Claude Code`, true);
            } catch (e) {
              setResult("✖ 接线失败：" + String((e && e.message) || e), false);
            }
          });
        }
      }
    }

    /* middleware 插件（声明式的请求改写）：**另一个目录**，别和 provider 插件混在一起。 */
    async function loadMiddleware() {
      try {
        const r = await ctx.api("/api/middleware");
        return r && r.ok !== false ? r : { list: [], errors: [], dir: "" };
      } catch { return { list: [], errors: [], dir: "" }; }
    }

    function renderMiddleware(mw) {
      const box = q('[data-role="p-mw"]');
      if (!box) return;
      const list = Array.isArray(mw.list) ? mw.list : [];
      const errors = Array.isArray(mw.errors) ? mw.errors : [];
      if (!list.length && !errors.length) { box.innerHTML = ""; return; }
      box.innerHTML = `
        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:13px">middleware 插件</h2>
          <span class="note">声明式的请求改写 · 装在 <span class="mono">${esc(String(mw.dir || ""))}</span></span>
        </div>
        <div class="fpline">
          <span class="k">已装</span>
          <span class="v">${list.length ? list.map((m) => `${esc(String(m.name || m.id))}（${esc(String(m.id))}，${num(m.rules)} 条规则）`).join("；") : "（无）"}</span>
        </div>
        ${errors.length ? errors.map((e) => `<div class="hint" style="margin-top:6px;padding:10px 12px;border:1px solid var(--line);border-radius:9px">
          <b class="mono">${esc(String(e.file || ""))}</b><br>${esc(String(e.error || ""))}
        </div>`).join("") : ""}
        <div style="margin-top:8px">
          <button type="button" class="btn sm" data-role="p-mw-reload">重新扫描 middleware 目录</button>
        </div>`;
      const btn = box.querySelector('[data-role="p-mw-reload"]');
      if (btn) {
        btn.addEventListener("click", async () => {
          setResult("正在重新扫描…");
          try {
            const r = await ctx.api("/api/middleware/reload", {
              method: "POST", headers: { "content-type": "application/json" }, body: "{}",
            });
            if (r && r.ok === false) throw new Error(r.error || "重载失败");
            setResult(`✔ 已重载：装上 ${num(r.loaded)} 条${(r.errors || []).length ? `，${r.errors.length} 份装不上` : ""}`, true);
            renderMiddleware(await loadMiddleware());
          } catch (e) {
            setResult("✖ 重载失败：" + String((e && e.message) || e), false);
          }
        });
      }
    }

    /* ---- 代码插件（pluginrt）：真代码，跑在子进程里 ----
     *
     * 与上面两节的分界（用户看到的是三种不同的东西，混起来就会用错）：
     *   · 插件渠道 —— 声明式加一家上游渠道（一份 JSON）。
     *   · middleware —— 声明式改写请求（一份 JSON）。
     *   · 代码插件 —— **真代码**（用户自己写的 JS），跑在子进程里，有权限模型。
     */
    let cpSig = "";

    async function loadCodePlugins() {
      try {
        const r = await ctx.api("/api/code-plugins");
        return r && r.ok !== false ? r : { list: [], errors: [], dir: "" };
      } catch { return { list: [], errors: [], dir: "" }; }
    }

    function renderCodePlugins(cp) {
      const box = q('[data-role="p-cp"]');
      if (!box) return;
      const list = Array.isArray(cp.list) ? cp.list : [];
      const errors = Array.isArray(cp.errors) ? cp.errors : [];
      /* ⚠⚠ **一个都没装时也要画这一块**（早先直接 return 掉整块）：
       *   那等于把「代码插件」这个功能**藏起来**了 —— 用户看不到它存在，
       *   更看不到「怎么装」。一个看不见入口的功能等于没有。
       *   所以空的时候画成一段**引导**（目录在哪 + 怎么装 + 一键建样板）。 */
      const stateOf = (s) => (s === "active" ? "在跑" : s === "dead" ? "已死（上次超时被杀掉）" : String(s || "—"));
      const dir = String(cp.dir || "");
      box.innerHTML = `
        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:13px">代码插件</h2>
          <span class="note">真代码 · 跑在<b>子进程</b>里（有权限模型与超时封顶）· 装在 <span class="mono">${esc(dir)}</span></span>
        </div>
        ${list.length ? "" : `<div class="hint" style="margin:2px 0 8px">
          一个都还没装。代码插件是你自己写的 JS：每个插件一个目录，里面放一份
          <span class="mono">plugin.json</span>（清单）与一个入口文件（.mjs）。
          写好后点「重新扫描代码插件目录」就会装上。
        </div>`}
        ${list.map((p) => {
          const perms = Array.isArray(p.permissions) ? p.permissions : [];
          return `<div class="fpline" style="align-items:flex-start">
            <span class="k">${esc(String(p.name || p.id))}<br><span class="mono dim" style="font-size: 11px">${esc(String(p.id || ""))}</span></span>
            <span class="v">${esc(stateOf(p.status))} · 单次超时 ${num(p.timeoutMs)}ms
              ${perms.length ? `<div class="hint" style="margin-top:4px">${perms.map((x) => esc(String(x.label || x.kind || ""))).join("<br>")}</div>` : ""}
            </span>
          </div>`;
        }).join("")}
        ${errors.length ? errors.map((e) => `<div class="hint" style="margin-top:6px;padding:10px 12px;border:1px solid var(--line);border-radius:9px">
          <b class="mono">${esc(String(e.dir || ""))}</b><br>${esc(String(e.message || ""))}
        </div>`).join("") : ""}
        <div style="margin-top:8px;display:flex;gap:7px;flex-wrap:wrap">
          <button type="button" class="btn sm" data-role="p-cp-reload">重新扫描代码插件目录</button>
          <button type="button" class="btn sm ghost" data-role="p-cp-how">怎么装？</button>
          <button type="button" class="btn sm ghost" data-role="p-cp-scaffold">建一个样板插件</button>
        </div>
        <div data-role="p-cp-how-box"></div>`;
      const btn = box.querySelector('[data-role="p-cp-reload"]');
      if (btn) {
        btn.addEventListener("click", async () => {
          setResult("正在重新扫描代码插件…");
          try {
            const r = await ctx.api("/api/code-plugins/reload", {
              method: "POST", headers: { "content-type": "application/json" }, body: "{}",
            });
            if (r && r.ok === false) throw new Error(r.error || "重载失败");
            setResult(`✔ 已重载：装上 ${num((r.installed || []).length)} 个代码插件${(r.errors || []).length ? `，${r.errors.length} 个装不上` : ""}`, true);
            renderCodePlugins(await loadCodePlugins());
          } catch (e) {
            setResult("✖ 重载失败：" + String((e && e.message) || e), false);
          }
        });
      }
      /* 「怎么装」：把三步与两份文件的**内容**摆出来（能直接照抄），
       * 而不是只给一个目录路径 —— 路径不告诉人格式。 */
      const how = box.querySelector('[data-role="p-cp-how"]');
      const howBox = box.querySelector('[data-role="p-cp-how-box"]');
      if (how && howBox) {
        how.addEventListener("click", () => {
          if (howBox.innerHTML) { howBox.innerHTML = ""; how.textContent = "怎么装？"; return; }
          how.textContent = "收起";
          howBox.innerHTML = `
            <div class="hint" style="margin-top:8px;padding:10px 12px;border:1px solid var(--line);border-radius:9px">
              <b>三步</b>：① 在 <span class="mono">${esc(dir)}</span> 下建一个目录（名字只许小写字母、数字、短横线）；
              ② 里面放一份 <span class="mono">plugin.json</span> 与一个入口文件 <span class="mono">main.mjs</span>；
              ③ 回上面点「重新扫描代码插件目录」。
              <div style="margin-top:8px">最省事的是点「建一个样板插件」—— 它会在那个目录里写好这两份文件，改一改就能用。</div>
            </div>`;
        });
      }
      /* 「建一个样板插件」：让用户一步拿到能改的两份文件，而不是照着文档抄。 */
      const sc = box.querySelector('[data-role="p-cp-scaffold"]');
      if (sc) {
        sc.addEventListener("click", async () => {
          setResult("正在建样板插件…");
          try {
            const r = await ctx.api("/api/code-plugins/scaffold", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: "example" }),
            });
            if (r && r.ok === false) throw new Error(r.error || "建样板失败");
            setResult(`✔ 样板已建好：${r.entry || r.dir} —— 改完点「重新扫描代码插件目录」`, true);
          } catch (e) {
            setResult("✖ 建样板失败：" + String((e && e.message) || e), false);
          }
        });
      }
    }

    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await ctx.api("/api/plugins");
        if (r && r.ok === false) throw new Error(r.error || "读不到插件清单");
        data = r || null;
        lasterr = "";
      } catch (e) {
        lasterr = String((e && e.message) || e);
      } finally {
        inflight = false;
        loaded = true;
        /* ⚠ 读完就重画：不重画的话这一块会**停在「正在读」**直到下一轮 5 秒轮询
           （load() 里 `if (inflight) return;` 不会等这次读，update() 也等不到它）。 */
        renderBody();
        bindRows();
      }
    }

    const reloadBtn = q('[data-role="p-reload"]');
    if (reloadBtn) {
      reloadBtn.addEventListener("click", async () => {
        setResult("正在重新扫描…");
        try {
          const r = await ctx.api("/api/plugins/reload", {
            method: "POST", headers: { "content-type": "application/json" }, body: "{}",
          });
          if (r && r.ok === false) throw new Error(r.error || "重载失败");
          setResult(`✔ 重载完成：装上 ${num(r.loaded)} 家${(r.errors || []).length ? `，${r.errors.length} 份装不上` : ""}`, true);
          await load(); renderBody();
        } catch (e) {
          setResult("✖ 重载失败：" + String((e && e.message) || e), false);
        }
      });
    }

    function signature() {
      const plugins = Array.isArray(data && data.plugins) ? data.plugins : [];
      const errors = Array.isArray(data && data.errors) ? data.errors : [];
      return JSON.stringify([
        plugins.map((p) => [p.id, p.hasCredential, p.relayPort, p.upstream]),
        errors.map((e) => e.file),
      ]);
    }

    /* 首屏先画「在读」并把第一次读发出去：否则这 5 秒里这一块是空白，
       空白既不是「在读」也不是「没有插件」，用户只能猜。 */
    renderBody();
    bindRows();
    load();

    return {
      async update() {
        await load();
        const note = q('[data-role="p-note"]');
        if (note) {
          note.innerHTML = lasterr
            ? S3("errorState", "读不到插件清单", {
              hint: "点上面的「重新扫描目录」重试；还不行就看诊断抽屉（右上角）。",
              detail: lasterr,
            })
            : "";
        }
        const dir = q('[data-role="p-dir"]');
        if (dir && data) dir.textContent = String(data.dir || "—");
        const s = signature();
        if (s !== sig) { sig = s; renderBody(); bindRows(); renderMiddleware(await loadMiddleware()); }
        /* 代码插件自己的一份签名：它只在「重载」后变，与插件渠道那条线无关。 */
        const cp = await loadCodePlugins();
        const cs = JSON.stringify([
          (cp.list || []).map((p) => [p.id, p.status, p.timeoutMs]),
          (cp.errors || []).map((e) => [e.dir, e.message]),
        ]);
        if (cs !== cpSig) { cpSig = cs; renderCodePlugins(cp); }
      },
      refresh() { return load(); },
    };
  },
};
