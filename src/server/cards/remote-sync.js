/* cards/remote-sync.js —— 远端同步卡（换电脑配置不丢）。
 *
 * 这张卡回答的是「**换台电脑 / 重装一次，配置还在吗**」：
 *   ① 同步目标（本地目录 / WebDAV / GitHub）+ 它的地址与凭据
 *   ② 一条「同步」按钮：把本地配置加密推上去；远端更新了就把远端拉回来
 *   ③ 上次同步是什么时候、干了什么
 *
 * ── 三条纪律 ──
 *   ① **口令每次都要输入**，绝不落盘：远端那份就是用它加密的。
 *      面板的输入框用完就清空。
 *   ② **远端存的是密文**（AES-256-GCM），不是明文 JSON —— 远端被读到也看不出配置。
 *   ③ **冲突不静默覆盖**：远端变了会告诉你，由你选边（同步结果里写着「远端比我新」）。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["remote-sync"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));

    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    let box = $("syncPanel");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "syncPanel";
      box.innerHTML = `
        <div class="pb-head">
          <h3>远端同步</h3>
          <span class="sub">配置加密推到远端 · 远端更新了再拉回来</span>
        </div>
        <div class="fieldset">
          <div class="fpline">
            <span class="k">目标</span>
            <span class="v">
              <select data-role="s-kind" style="width:150px">
                <option value="local">本地目录</option>
                <option value="webdav">WebDAV</option>
                <option value="github">GitHub</option>
              </select>
            </span>
          </div>
          <div class="fpline" data-role="w-local"><span class="k">目录</span>
            <span class="v"><input type="text" data-role="s-dir" placeholder="留空 = 数据目录下的 sync" style="width:280px"></span></div>
          <div class="fpline" data-role="w-webdav"><span class="k">地址</span>
            <span class="v"><input type="text" data-role="s-url" placeholder="https://dav.example/remote.php/dav/files/user" style="width:280px"></span></div>
          <div class="fpline" data-role="w-webdav"><span class="k">令牌</span>
            <span class="v"><input type="password" data-role="s-token" autocomplete="new-password" placeholder="Bearer 或 Basic 用户名/口令" style="width:220px"></span></div>
          <div class="fpline" data-role="w-github"><span class="k">仓库</span>
            <span class="v"><input type="text" data-role="s-repo" placeholder="owner/name" style="width:180px"></span></div>
          <div class="fpline" data-role="w-github"><span class="k">令牌</span>
            <span class="v"><input type="password" data-role="s-ghtoken" autocomplete="new-password" placeholder="GitHub token" style="width:220px"></span></div>
          <div class="fpline"><span class="k">加密口令</span>
            <span class="v"><input type="password" data-role="s-pass" autocomplete="new-password" placeholder="至少 8 个字符 · 每次同步都要输入" style="width:220px"></span></div>
          <div style="margin-top:8px">
            <button type="button" class="btn sm" data-role="s-save">保存目标</button>
            <button type="button" class="btn sm" data-role="s-run">现在同步</button>
          </div>
          <div class="result" data-role="s-result"></div>
          <div data-role="s-note"></div>
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
    let loaded = false;   // 至少成功读过一回（没读过 ≠ 没配目标）
    let sig = "";

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

    function setResult(text, ok) {
      const el = q('[data-role="s-result"]');
      if (!el) return;
      el.textContent = text || "";
      el.className = "result" + (ok === false ? " err" : ok === true ? " ok" : "");
    }

    function showKind() {
      const kind = (q('[data-role="s-kind"]') || {}).value || "local";
      for (const k of ["local", "webdav", "github"]) {
        const row = q(`[data-role="w-${k}"]`);
        if (row) row.style.display = (k === kind) ? "" : "none";
      }
    }

    function render() {
      const d = data || {};
      const kind = d.kind || "local";
      const sel = q('[data-role="s-kind"]');
      if (sel && document.activeElement !== sel) sel.value = kind;
      const set = (role, v) => { const el = q(`[data-role="${role}"]`); if (el && document.activeElement !== el) el.value = v == null ? "" : String(v); };
      set("s-dir", d.dir || "");
      set("s-url", d.url || "");
      set("s-repo", d.repo || "");
      showKind();
      const note = q('[data-role="s-note"]');
      if (note) {
        if (!loaded && !lasterr) {
          note.innerHTML = S3("loadingState", "正在读同步状态…", { hint: "读完这一块就知道上次同步是什么时候、推到了哪儿。" });
        } else if (lasterr) {
          note.innerHTML = S3("errorState", "读不到同步状态", {
            hint: "看诊断抽屉（右上角）确认是中转没起来还是远端不可达；修好后面板会自己读回来。",
            detail: lasterr,
          });
        } else if (!d.configured) {
          /* 空态要说清「怎么才会出现」：不然用户不知道要先配目标。 */
          note.innerHTML = S3("emptyState", "还没配同步目标", {
            hint: "选一个目标（本地目录 / WebDAV / GitHub）、填加密口令，再点「保存目标」—— 远端存的是密文，但口令不保存，每次同步都要再输一次。",
          });
        } else {
          note.innerHTML = `<div class="hint" style="margin-top:12px">上次同步：${d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString("zh-CN") : "（还没有）"}${d.lastAction ? " · " + esc(d.lastAction) : ""}</div>`;
        }
      }
    }

    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await ctx.api("/api/sync");
        if (r && r.ok === false) throw new Error(r.error || "读不到同步状态");
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

    const val = (role) => {
      const el = q(`[data-role="${role}"]`);
      return el ? String(el.value || "").trim() : "";
    };

    const bind = (role, fn) => {
      const el = q(`[data-role="${role}"]`);
      if (el) el.addEventListener("click", fn);
    };
    bind("s-save", async () => {
      const kind = val("s-kind");
      const body = { kind, dir: val("s-dir"), url: val("s-url"), repo: val("s-repo") };
      /* 令牌只有**填了**才带上去（留空 = 不改已存的那把）。 */
      const tok = val("s-token");
      const gtok = val("s-ghtoken");
      if (tok) body.token = tok;
      if (gtok) body.token = gtok;
      setResult("正在保存…");
      try {
        const r = await ctx.api("/api/sync/target", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        if (r && r.ok === false) throw new Error(r.error || "保存失败");
        setResult("✔ 已保存同步目标", true);
        await load(); render();
      } catch (e) {
        setResult("✖ 保存失败：" + String((e && e.message) || e), false);
      }
    });

    bind("s-run", async () => {
      const pass = val("s-pass");
      const el = q('[data-role="s-pass"]');
      if (el) el.value = "";                    // 用完立刻清空
      if (pass.length < 8) { setResult("加密口令至少 8 个字符", false); return; }
      setResult("正在同步…");
      try {
        const r = await ctx.api("/api/sync", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ passphrase: pass }), timeoutMs: 60000,
        });
        if (r && r.ok === false) throw new Error(r.error || "同步失败");
        const bits = [];
        if (r.pushed) bits.push("已推到远端");
        if ((r.pulled || []).length) bits.push("已把远端的更新拉回本地");
        if (!bits.length) bits.push("两边一样，没什么要同步");
        setResult("✔ " + bits.join("；") + (r.notice ? "（" + r.notice + "）" : ""), true);
        await load(); render();
      } catch (e) {
        setResult("✖ 同步失败：" + String((e && e.message) || e), false);
      }
    });

    const sel = q('[data-role="s-kind"]');
    if (sel) sel.addEventListener("change", showKind);

    function signature() {
      const d = data || {};
      return JSON.stringify([d.kind, d.url, d.repo, d.dir, d.lastSyncAt, d.lastAction, d.configured])
        + "|" + (loaded ? "1" : "0") + "|" + lasterr;
    }

    /* 首屏先画「在读」并把第一次读发出去：否则这 5 秒里这一块是空白，
       空白既不是「在读」也不是「没配目标」，用户只能猜。 */
    render();
    load();

    return {
      async update() {
        await load();
        const s = signature();
        if (s !== sig) { sig = s; render(); }
      },
      refresh() { return load().then(() => { render(); }); },
    };
  },
};
