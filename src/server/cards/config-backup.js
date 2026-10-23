/* cards/config-backup.js —— 配置备份卡（导出 / 导入 / 备份清单）。
 *
 * 这张卡回答的是「**重装一次，这些还在吗**」：
 *   ① 备份目录在哪、里面有哪些备份、各自多大、什么时候的
 *   ② 导出一份（**口令加密**）——备份里**有**真实凭据，所以必须是密文
 *   ③ 导入一份（合并回当前配置，不是整份替换）
 *
 * ── 三条纪律，比功能更要紧 ──
 *   ① **口令绝不落盘、绝不进日志、绝不回显**。它只在这一请求里活着。
 *      用完立刻把输入框清空（DOM 里留着就等于把口令留在屏幕上）。
 *   ② **导入是破坏性的** → 必须先确认，且后端在还原**之前**先把当前配置
 *      另存一份（before-import-*.json）。用户当年就是这么丢过配置的。
 *   ③ **只还原路由台自己的配置**，不动 ~/.claude/settings.json
 *      （那是用户自己写的权限与钩子，整份覆盖会抹掉注释与键序）。
 *      备份里**带着**那一块，供换机时手工取用。
 *
 * ── 刷新节奏 ──
 *   共享层每 5 秒轮询一次（panel-common.js 的 setInterval(poll, 5000) → cards.update()），
 *   本卡**不**自己另起一个定时器：两个节奏会打架（一个先到、一个后到，画面上的数会来回跳）。
 */
window.BAI_CARDS = window.BAI_CARDS || {};
window.BAI_CARDS["config-backup"] = {
  mount(ctx) {
    const $ = ctx.$ || ((id) => document.getElementById(id));
    const esc = ctx.esc || ((s) => String(s == null ? "" : s));

    const slot = ctx.slot || $("slot-extra");
    if (!slot) return { update() { }, refresh() { } };

    /* ---- 容器：自建面板盒，挂在所在视图末尾 ---- */
    let box = $("backupPanel");
    if (!box) {
      box = document.createElement("div");
      box.className = "panelbox";
      box.id = "backupPanel";
      box.innerHTML = `
        <div class="pb-head">
          <h3>配置备份</h3>
          <span class="sub">带凭据的快照 · 口令加密 · 只在本地</span>
        </div>
        <div class="fieldset">
          <div class="rail" style="margin-bottom:0">
            <div class="rail-grid">
              <div class="gauge"><span class="cap">备份份数</span><div class="val" data-role="b-count">—</div><div class="sub" data-role="s-count"></div></div>
              <div class="gauge"><span class="cap">最近一次</span><div class="val" data-role="b-when" style="font-size:13px">—</div><div class="sub"></div></div>
            </div>
          </div>
          <div class="fpline"><span class="k">备份目录</span><span class="v mono" data-role="b-dir">—</span></div>
          <div data-role="b-list"></div>
          <div class="sechead" style="margin:16px 0 4px">
            <h2 style="font-size:13px">导出</h2>
            <span class="note">导出的文件里<b>有</b>你的真实凭据，所以必须加密</span>
          </div>
          <div class="fpline">
            <span class="k">口令</span>
            <span class="v"><input type="password" data-role="b-pass" autocomplete="new-password" placeholder="至少 8 个字符" style="width:220px"></span>
          </div>
          <div style="margin-top:8px">
            <button type="button" class="btn sm" data-role="b-export">导出备份</button>
            <button type="button" class="btn sm" data-role="b-import">导入选中的备份</button>
          </div>
          <div class="result" data-role="b-result"></div>
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

    let data = null;      // 最近一次读到的 /api/backup
    let lasterr = "";
    let inflight = false;
    let loaded = false;   // 至少成功读过一回（没读过 ≠ 没有备份）
    let selected = "";    // 选中的备份文件名
    let sig = "";

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const int = (v) => num(v).toLocaleString("zh-CN");

    function fmtWhen(t) {
      if (!t) return "—";
      const d = new Date(t);
      if (!Number.isFinite(d.getTime())) return "—";
      return d.toLocaleString("zh-CN", { hour12: false });
    }

    function setResult(text, ok) {
      const el = q('[data-role="b-result"]');
      if (!el) return;
      el.textContent = text || "";
      el.className = "result" + (ok === false ? " err" : ok === true ? " ok" : "");
    }

    function render() {
      const d = data || {};
      const files = Array.isArray(d.files) ? d.files : [];
      const set = (role, v) => { const el = q(`[data-role="${role}"]`); if (el) el.textContent = v; };

      set("b-count", int(files.length));
      set("b-dir", String(d.dir || "—"));
      set("s-count", files.length ? "本地目录 · 不上传" : "还没有备份");
      set("b-when", files.length ? fmtWhen(files[0].at) : "—");

      const list = q('[data-role="b-list"]');
      if (list) {
        if (!loaded && !lasterr) {
          /* 第一次读还没回来：先说「在读」，别拿空态冒充「没有备份」。 */
          list.innerHTML = S3("loadingState", "正在读备份清单…", { hint: "读完这一块就知道本机存着哪几份备份。" });
        } else if (lasterr) {
          /* 读不到 ⇒ 整块换成错误态（必须带下一步）。 */
          list.innerHTML = S3("errorState", "读不到备份清单", {
            hint: "看诊断抽屉（右上角）确认数据目录是否可读；修好后面板会自己读回来。",
            detail: lasterr,
          });
        } else if (!files.length) {
          /* 空态要说清「怎么才会出现」：不然用户不知道要点哪个按钮。 */
          list.innerHTML = S3("emptyState", "还没有备份", {
            hint: "填好下面的口令点「导出备份」—— 重装一次或换台电脑，凭据与映射能一起带走。",
          });
        } else {
          list.innerHTML = `<table class="route" style="table-layout:fixed;margin-top:12px">
            <thead><tr><th style="width:46%">文件</th><th style="width:18%">大小</th><th style="width:36%">时间</th></tr></thead>
            <tbody>${files.map((f) => `<tr${f.name === selected ? ' style="outline:1px solid var(--accent)"' : ""}>
                <td><label style="cursor:pointer"><input type="radio" name="bk-sel" value="${esc(f.name)}"${f.name === selected ? " checked" : ""}> <span class="mono">${esc(f.name)}</span></label></td>
                <td class="dim">${esc(int(num(f.bytes) / 1024))} KB</td>
                <td class="dim">${esc(fmtWhen(f.at))}</td>
              </tr>`).join("")}</tbody>
          </table>`;
          /* 单选：选中哪一份就导入哪一份 —— 用 radio 而不是下拉，是因为备份名里
             带时间戳，列表比下拉更容易看清「哪一份是最新的」。 */
          list.querySelectorAll('input[name="bk-sel"]').forEach((el) => {
            el.addEventListener("change", () => { selected = el.value; render(); });
          });
        }
      }
    }

    async function load() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await ctx.api("/api/backup");
        if (r && r.ok === false) throw new Error(r.error || "读不到备份清单");
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

    /* 口令：读一次，用完立刻清空输入框（DOM 里留着 = 留在屏幕上）。 */
    function takePassphrase() {
      const el = q('[data-role="b-pass"]');
      const v = el ? String(el.value || "") : "";
      if (el) el.value = "";
      return v;
    }

    async function doExport() {
      const pass = takePassphrase();
      if (pass.length < 8) { setResult("口令至少 8 个字符", false); return; }
      setResult("正在导出…");
      try {
        const r = await ctx.api("/api/backup/export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ passphrase: pass }),
          timeoutMs: 60000,
        });
        if (r && r.ok === false) throw new Error(r.error || "导出失败");
        setResult(`✔ 已导出：${r.name}（${int(num(r.bytes) / 1024)} KB）· 记住口令，否则解不开`, true);
        await load();
        render();
      } catch (e) {
        setResult("✖ 导出失败：" + String((e && e.message) || e), false);
      }
    }

    async function doImport() {
      if (!selected) { setResult("先在上面选一份备份", false); return; }
      const pass = takePassphrase();
      if (pass.length < 8) { setResult("口令至少 8 个字符", false); return; }
      if (!confirm("导入会用这份备份**合并**回当前配置（路由台自己的那份）。\n"
        + "还原之前会先把当前配置另存一份 before-import-*.json。\n"
        + "Claude Code 那侧（~/.claude/settings.json）不会被改动。\n\n继续？")) return;
      setResult("正在导入…");
      try {
        const r = await ctx.api("/api/backup/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ passphrase: pass, file: selected }),
          timeoutMs: 60000,
        });
        if (r && r.ok === false) throw new Error(r.error || "导入失败");
        setResult(`✔ 导入完成（${r.changed ? "配置有变化" : "配置没变化"}）· 改动前的配置已存为 ${r.safety || "（未生成）"}`, true);
      } catch (e) {
        setResult("✖ 导入失败：" + String((e && e.message) || e), false);
      }
    }

    const bind = (role, fn) => {
      const el = q(`[data-role="${role}"]`);
      if (el) el.addEventListener("click", fn);
    };
    bind("b-export", doExport);
    bind("b-import", doImport);

    function signature() {
      const files = Array.isArray(data && data.files) ? data.files : [];
      return JSON.stringify([files.length, files[0] ? files[0].name : "", files[0] ? files[0].at : 0, selected])
        + "|" + (loaded ? "1" : "0") + "|" + lasterr;
    }

    /* 首屏先画「在读」并把第一次读发出去：否则这 5 秒里这一块是空白，
       空白既不是「在读」也不是「没有备份」，用户只能猜。 */
    render();
    load();

    return {
      async update() {
        await load();
        if (lasterr && !data) {
          /* 读不到 ⇒ 整块换成错误态（必须带下一步）：
             「没有备份」与「读不到备份」是两件事，混起来用户会去查一个没发生的事。 */
          const list = q('[data-role="b-list"]');
          if (list) {
            list.innerHTML = S3("errorState", "读不到备份清单", {
              hint: "看诊断抽屉（右上角）确认数据目录是否可读；修好后面板会自己读回来。",
              detail: lasterr,
            });
          }
          return;
        }
        const s = signature();
        if (s !== sig) { sig = s; render(); }
      },
      refresh() { return load(); },
    };
  },
};
