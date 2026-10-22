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
        </div>`;
      const viewRoot = (slot.closest && slot.closest(".view")) || slot;
      viewRoot.appendChild(box);
    }
    const q = (sel) => box.querySelector(sel);

    let data = null;
    let lasterr = "";
    let inflight = false;
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
      const plugins = Array.isArray(data && data.plugins) ? data.plugins : [];
      const errors = Array.isArray(data && data.errors) ? data.errors : [];

      const errHtml = errors.length ? `
        <div class="sechead" style="margin:16px 0 4px">
          <h2 style="font-size:12px">装不上的声明</h2>
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

      body.innerHTML = errHtml + (plugins.length ? rows : `
        <div class="hint" style="margin-top:12px;padding:12px 14px;border:1px solid var(--line);border-radius:9px;background:var(--panel2)">
          还没有插件渠道 —— <b>这不是出错</b>。<br>
          把一份 JSON 声明放进上面的插件目录，点「重新扫描目录」即可。
          声明里**不许带凭据**（那是分发物），凭据在这一张卡里填。
        </div>`);
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
          <h2 style="font-size:12px">middleware 插件</h2>
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

    return {
      async update() {
        await load();
        const note = q('[data-role="p-note"]');
        if (note) {
          note.innerHTML = lasterr
            ? `<div class="hint" style="margin-top:12px">读不到插件清单：${esc(lasterr)}</div>`
            : "";
        }
        const dir = q('[data-role="p-dir"]');
        if (dir && data) dir.textContent = String(data.dir || "—");
        const s = signature();
        if (s !== sig) { sig = s; renderBody(); bindRows(); renderMiddleware(await loadMiddleware()); }
      },
      refresh() { return load(); },
    };
  },
};
