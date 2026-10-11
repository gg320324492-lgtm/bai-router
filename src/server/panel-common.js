/* panel-common.js —— 单页控制台的全部渲染与交互（契约 REFACTOR-CONTRACT-v17 · 里程碑 4）。
 *
 * 由来：v1.0.48 起这里是「五个提供方页面共用的一份渲染层」，七个 URL 各渲染同一张
 * provider.html，只靠 path 决定选中哪家。v17 把「七页同构」改成「一张单页 + 四个视图」——
 * 本文件随之重写：不再是"某一页的渲染层"，而是**整张单页**的渲染层。
 *
 * 硬约束（由 scripts/check-manifest.cjs 的闸门强制，违反即构建期失败）：
 *   C5  不许再读已被处置表删掉的 25 个 id（见 IN_FLIGHT_IDS，里程碑 4 落地后该台账清空）
 *   C11 本文件里**不许出现任何渠道名字面量**——不做 `=== "wb"`、不拿 `["wb"]` 当下标、
 *        不写死渠道名数组。各家差异一律从 window.BAI_PROVIDERS 清单读。
 *   C12 渲染层必读的渠道字段每家都必须有（与 C1 求交集，防两处漂移）
 *
 * 启动顺序：清单就位 → path 决定选中渠道 → hash 决定视图 → 注入文案与结构 →
 *          挂载该视图的卡片 → 接线 → 轮询状态 + 配置。
 */
(() => {
  if (document.panelCommonReady) return;
  document.panelCommonReady = 1;

  /* ======================================================================
   * 0. 基础工具
   * ==================================================================== */
  const $ = (id) => document.getElementById(id);
  const has = (id) => !!$(id);
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clsx = (el, on, name) => { if (el) el.classList.toggle(name, !!on); };
  const showEl = (el, on) => { if (el) el.style.display = on ? "" : "none"; };
  const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);

  async function api(path, opts) {
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  const postJSON = (path, body) => api(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  /* 状态语义色只有四态 + 一色品牌。led/badge/cell 一律走这里，CSS 侧同名。 */
  const STATE = {
    ok: { cls: "ok", txt: "就绪" },
    warn: { cls: "warn", txt: "需留意" },
    err: { cls: "err", txt: "故障" },
    idle: { cls: "idle", txt: "未配置" },
  };
  function setLed(el, state, pulse) {
    if (!el) return;
    el.className = "led " + state + (pulse ? " pulse" : "");
  }

  /* ======================================================================
   * 1. 常量表：档位名与 mode 标签是固定领域名词，不随各家变
   * ==================================================================== */
  const TIERS = [
    { key: "claude-fable-5", zh: "Fable · 最强", short: "Fable" },
    { key: "claude-sonnet-5", zh: "Sonnet · 均衡", short: "Sonnet" },
    { key: "claude-opus-5", zh: "Opus · 重型", short: "Opus" },
    { key: "claude-haiku-4-5", zh: "Haiku · 快速", short: "Haiku" },
  ];
  const TIER_ZH = {};
  for (const t of TIERS) TIER_ZH[t.key] = t.short;
  const MODE_TXT = { ccswitch: "CC SWITCH", other: "其他", unknown: "未知" };
  for (const k in (window.BAI_PROVIDERS || {})) {
    const t = (window.BAI_PROVIDERS[k] || {}).tab || k;
    MODE_TXT[k] = String(t).toUpperCase();
  }

  /* ======================================================================
   * 2. 保留区：更新横幅 / 底栏三按钮 / 备用升级 / 停止服务
   *    （与"当前是哪个提供方"无关，整段从重构前逐字保留）
   * ==================================================================== */

  /* --- 2.1 更新横幅（插在 bnrInfo 之前） --- */
  const wrap = document.querySelector(".banner-wrap");
  if (wrap && !has("bnrUpdate")) {
    const b = document.createElement("div");
    b.className = "banner";
    b.id = "bnrUpdate";
    b.innerHTML = `
      <div class="t" id="bnrUpdTitle">更新</div>
      <div class="bar" id="bnrUpdBarWrap"><i id="bnrUpdBar"></i></div>
      <div id="bnrUpdMsg" style="font-size:12px;color:var(--dim)"></div>
      <div id="bnrUpdNotes" style="display:none"></div>
      <div class="row" id="bnrUpdRow" style="display:none">
        <button class="btn-main" id="bnrUpdGo" type="button" style="padding:6px 14px;font-size:12px">重启安装</button>
        <button class="btn-sm" id="bnrUpdSelf" type="button" style="display:none">备用升级</button>
        <button class="btn-sm" id="bnrUpdLater" type="button">稍后</button>
      </div>
      <button class="x" id="bnrUpdX" type="button" title="关闭">✕</button>`;
    wrap.insertBefore(b, $("bnrInfo"));
  }

  /* --- 2.2 底栏按钮（插在 verTxt 之后） --- */
  const footer = document.querySelector("footer");
  if (footer && !has("updBtn")) {
    const mk = (id, label, title) => {
      const b = document.createElement("button");
      b.className = "btn-sm"; b.id = id; b.type = "button";
      if (title) b.title = title;
      b.textContent = label;
      return b;
    };
    const anchor = $("verTxt");
    const add = [
      mk("updBtn", "检查更新"),
      mk("btnSelfUpd", "备用升级", "不依赖内置更新器，直接从 GitHub 下载最新安装包并升级"),
      mk("stopBtn", "停止服务"),
    ];
    let ref = anchor;
    for (const b of add) { if (ref) ref.after(b); ref = b; }
  }

  /* --- 2.3 内嵌通知横幅（showInfo，全站共用） --- */
  let infoTimer = null;
  function showInfo(title, msg, ms) {
    const b = $("bnrInfo");
    if (!b) return;
    $("bnrInfoTitle").textContent = title;
    $("bnrInfoMsg").textContent = msg;
    b.classList.add("show");
    clearTimeout(infoTimer);
    if (ms == null) ms = 6000;
    if (ms) infoTimer = setTimeout(() => b.classList.remove("show"), ms);
  }
  if (has("bnrInfoX")) $("bnrInfoX").onclick = () => $("bnrInfo").classList.remove("show");

  function showResult(el, text, good) {
    if (!el) return;
    el.textContent = text;
    el.className = "result show " + (good ? "good" : "bad");
  }

  /* --- 2.4 备用升级：独立于 electron-updater 的自救援通道 --- */
  let suTimer = null;
  function paintSelf(st) {
    const b = $("bnrUpdate");
    if (!b) return;
    b.classList.add("show");
    if (has("bnrUpdSelf")) $("bnrUpdSelf").style.display = "none";
    if (has("bnrUpdGo")) $("bnrUpdGo").style.display = "none";
    if (has("bnrUpdLater")) $("bnrUpdLater").style.display = "none";
    $("bnrUpdRow").style.display = "";
    if (st.phase === "resolving") {
      $("bnrUpdTitle").textContent = "备用升级：查询最新版…";
      $("bnrUpdBarWrap").style.display = "none";
    } else if (st.phase === "downloading") {
      $("bnrUpdTitle").textContent = `备用升级：下载 ${st.version || ""}`;
      $("bnrUpdBarWrap").style.display = "";
      $("bnrUpdBar").style.width = (st.percent || 0) + "%";
      $("bnrUpdMsg").textContent = `${st.percent || 0}% · ${((st.got || 0) / 1048576).toFixed(0)} / ${((st.total || 0) / 1048576).toFixed(0)} MB`;
      $("bnrUpdLater").style.display = "";
    } else if (st.phase === "verifying") {
      $("bnrUpdTitle").textContent = "备用升级：校验安装包（sha512 + 数字签名）…";
      $("bnrUpdBarWrap").style.display = "none";
    } else if (st.phase === "ready") {
      if (suTimer) { clearInterval(suTimer); suTimer = null; }
      $("bnrUpdTitle").textContent = `${st.version} 已下载并校验通过`;
      $("bnrUpdBarWrap").style.display = "none";
      $("bnrUpdMsg").textContent = "点「立即重启安装」后应用会自动退出、静默升级并重新拉起（约 15 秒）。";
      $("bnrUpdGo").style.display = "";
      $("bnrUpdGo").textContent = "立即重启安装";
      $("bnrUpdGo").disabled = false;
      $("bnrUpdGo").onclick = async () => {
        $("bnrUpdGo").disabled = true;
        try {
          const r = await api("/api/selfupdate/install", { method: "POST" });
          $("bnrUpdMsg").textContent = r.message || "正在退出并安装…";
        } catch (e) {
          $("bnrUpdGo").disabled = false;
          $("bnrUpdMsg").textContent = "启动安装失败：" + e.message;
        }
      };
      $("bnrUpdLater").style.display = "";
    } else if (st.phase === "error") {
      if (suTimer) { clearInterval(suTimer); suTimer = null; }
      b.classList.remove("show");
      showInfo("备用升级失败", st.error || "未知错误", 0);
    }
  }
  async function startSelfUpdate() {
    if (!confirm("备用升级不依赖内置更新器：由路由台自己从 GitHub 下载最新版、校验签名后静默安装（期间应用会退出并自动重开，配置保留）。继续？")) return;
    try { await api("/api/selfupdate", { method: "POST" }); } catch (e) { showInfo("备用升级", "启动失败：" + e.message, 0); return; }
    if (suTimer) clearInterval(suTimer);
    paintSelf({ phase: "resolving" });
    suTimer = setInterval(async () => {
      try { paintSelf(await api("/api/selfupdate/status")); } catch { /* 安装阶段服务退出，轮询自然停止 */ }
    }, 1200);
  }

  /* --- 2.5 接线 --- */
  if (has("updBtn")) $("updBtn").addEventListener("click", () => { if (window.baiDesktop) window.baiDesktop.checkUpdate(); });
  if (has("btnSelfUpd")) $("btnSelfUpd").addEventListener("click", startSelfUpdate);
  if (has("bnrUpdSelf")) $("bnrUpdSelf").addEventListener("click", startSelfUpdate);
  if (has("bnrUpdLater")) $("bnrUpdLater").onclick = () => $("bnrUpdate").classList.remove("show");
  if (has("bnrUpdX")) $("bnrUpdX").onclick = () => $("bnrUpdate").classList.remove("show");

  if (has("stopBtn")) {
    $("stopBtn").addEventListener("click", () => {
      if (window.baiDesktop) {
        if (confirm("退出软件？退出后中转停止，模式下的桌面版 Claude 会断线。")) window.baiDesktop.quit();
        return;
      }
      if (!confirm("停止服务后中转也会停止，桌面版/CLI 若在中转模式下会立即断线。确定停止？")) return;
      api("/api/service/stop", { method: "POST" }).finally(() => {
        document.body.innerHTML = '<div style="font-family:sans-serif;color:#8b8e9a;padding:40px;text-align:center">服务已停止。重新双击「路由台」图标即可恢复。</div>';
      });
    });
  }

  /* --- 2.6 更新模态对话框（手动检查才弹；自动检查保持静默） --- */
  const notesToText = (raw) => {
    if (raw == null) return "";
    if (Array.isArray(raw)) {
      return raw.map((r) => (r && typeof r.note === "string" ? r.note : "")).filter(Boolean).join("\n\n");
    }
    if (typeof raw !== "string") return "";
    return raw
      .replace(/^[ \t]*#{1,6}[ \t]*/gm, "")
      .replace(/\*\*/g, "")
      .replace(/\r\n?/g, "\n")
      .trim();
  };

  let modalEl = null;
  let lastModalState = null;
  function ensureUpdateModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement("div");
    modalEl.className = "updModal";
    modalEl.id = "updModal";
    modalEl.style.display = "none";
    modalEl.innerHTML =
      '<div class="updModalMask" id="updModalMask"></div>' +
      '<div class="updModalCard" role="dialog" aria-modal="true" aria-labelledby="updModalTitle">' +
        '<div class="t" id="updModalTitle">发现新版本</div>' +
        '<div class="sub" id="updModalSub"></div>' +
        '<div class="bar" id="updModalBarWrap"><i id="updModalBar"></i></div>' +
        '<div class="notesWrap" id="updModalNotesWrap">' +
          '<div class="notesLbl">更新日志</div>' +
          '<pre class="notes" id="updModalNotes"></pre>' +
        '</div>' +
        '<div class="row">' +
          '<button class="btn-main" id="updModalGo" type="button">立即安装</button>' +
          '<button class="btn-sm" id="updModalLater" type="button">稍后</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modalEl);
    $("updModalLater").onclick = () => closeUpdateModal();
    $("updModalMask").onclick = () => closeUpdateModal();
    $("updModalGo").onclick = () => {
      if (window.baiDesktop) window.baiDesktop.installUpdate();
    };
    return modalEl;
  }

  function closeUpdateModal() {
    if (modalEl) modalEl.style.display = "none";
    if (lastModalState) { try { paintUpdate(lastModalState); } catch { /* 收起时的重画失败不阻塞 */ } }
  }

  function paintUpdateModal(st) {
    ensureUpdateModal();
    lastModalState = st;
    const title = $("updModalTitle"), sub = $("updModalSub");
    const barWrap = $("updModalBarWrap"), bar = $("updModalBar");
    const go = $("updModalGo");

    title.textContent = `发现新版本 v${st.version || "?"}`;

    if (st.phase === "ready") {
      sub.textContent = "新版本已下载完成，重启即可安装（中转会中断几秒）。";
      barWrap.style.display = "none";
      go.textContent = "立即重启安装";
      go.disabled = false;
    } else {
      const pct = Math.max(0, Math.min(100, Number(st.percent) || 0));
      sub.textContent = pct > 0
        ? `正在下载：${pct}%（下载完成后按钮会变成「立即重启安装」）`
        : "点「立即安装」开始下载；也可以稍后再说。";
      barWrap.style.display = "";
      bar.style.width = pct + "%";
      go.textContent = pct > 0 ? "正在下载…" : "立即安装";
      go.disabled = pct > 0;
    }

    const notesWrap = $("updModalNotesWrap");
    const txt = notesToText(st.releaseNotes);
    if (!txt) {
      notesWrap.style.display = "none";
      $("updModalNotes").textContent = "";
    } else {
      notesWrap.style.display = "";
      $("updModalNotes").textContent = txt;
    }

    if (modalEl.style.display === "none") modalEl.style.display = "";
  }

  /* --- 2.7 桌面壳 / 浏览器 的页脚按钮差异 + 更新状态渲染 --- */
  if (window.baiDesktop) {
    if (has("stopBtn")) $("stopBtn").textContent = "退出软件";
    if (has("updBtn")) $("updBtn").style.display = "";
    if (has("btnSelfUpd")) $("btnSelfUpd").style.display = "";

    const paintStale = (st) => {
      const b = $("bnrUpdate");
      b.classList.add("show");
      $("bnrUpdBarWrap").style.display = "none";
      $("bnrUpdSelf").style.display = "none";
      $("bnrUpdLater").style.display = "none";
      $("bnrUpdRow").style.display = "";
      $("bnrUpdTitle").textContent = `检测到正在运行旧副本（正式版 v${st.version} 安装在别处）`;
      const go = $("bnrUpdGo");
      go.style.display = "";
      if (st.canSwitch) {
        $("bnrUpdMsg").textContent = "自动更新只会安装到正式目录，你打开的这份副本永远不会被更新。点「切换到正式版」立即改用最新安装（界面会自动重开），快捷方式也将一并校正。";
        go.textContent = "切换到正式版 v" + st.version;
        go.onclick = async () => {
          go.disabled = true;
          const r = await window.baiDesktop.switchInstalled();
          go.disabled = false;
          if (!r || !r.ok) {
            $("bnrUpdTitle").textContent = "切换失败";
            $("bnrUpdMsg").textContent = (r && r.msg) || "未知错误，可退出后从桌面图标重新打开";
          }
        };
      } else {
        $("bnrUpdMsg").textContent = "正式版主程序似乎已被删除或移动（" + (st.regPath || "") + "）。请重新安装最新版：退出本程序后运行安装包。";
        go.textContent = "知道了";
        go.onclick = () => b.classList.remove("show");
      }
    };

    const NOTES_MAX = 3;
    const NOTES_BULLET = "· ";
    const isOpenNotes = { v: false };
    const notesLines = (txt) => String(txt || "").split("\n").map((l) => l.trim()).filter(Boolean);

    function paintNotes(raw) {
      const box = $("bnrUpdNotes");
      if (!box) return;
      const txt = notesToText(raw);
      if (!txt) { box.style.display = "none"; box.innerHTML = ""; return; }
      box.style.display = "";
      const lines = notesLines(txt);
      const more = lines.length > NOTES_MAX;
      const shown = isOpenNotes.v ? lines : lines.slice(0, NOTES_MAX);
      const rest = lines.length - NOTES_MAX;
      let html = `<pre class="notes">${esc(shown.map((l) => NOTES_BULLET + l).join("\n"))}</pre>`;
      if (more) {
        const label = isOpenNotes.v ? "收起" : `详情（还有 ${rest} 行）`;
        html += `<button class="btn-sm notesToggle" id="bnrUpdNotesBtn" type="button" style="margin-top:6px;padding:3px 10px;font-size:11px">${esc(label)}</button>`;
      }
      box.innerHTML = html;
      if (more) {
        const btn = $("bnrUpdNotesBtn");
        if (btn) btn.onclick = () => { isOpenNotes.v = !isOpenNotes.v; paintNotes(raw); };
      }
    }

    const paintUpdate = (st) => {
      const b = $("bnrUpdate");
      if (!b) return;
      if (!st || st.phase === "latest" || st.phase === "checking") { b.classList.remove("show"); return; }
      b.classList.add("show");
      if (st.phase === "downloading") {
        $("bnrUpdTitle").textContent = st.percent >= 100 ? "正在校验安装包…" : `正在下载 v${st.version}`;
        $("bnrUpdBarWrap").style.display = "";
        $("bnrUpdBar").style.width = (st.percent || 0) + "%";
        $("bnrUpdMsg").textContent = (st.percent || 0) + "% · 完成后会自动切换为「重启安装」按钮";
        $("bnrUpdRow").style.display = "none";
      } else if (st.phase === "ready") {
        $("bnrUpdTitle").textContent = `v${st.version} 已就绪`;
        $("bnrUpdBarWrap").style.display = "none";
        $("bnrUpdMsg").textContent = "重启安装约需 10 秒，中转会中断几秒；也可稍后退出时自动安装。";
        $("bnrUpdRow").style.display = "";
      } else if (st.phase === "error") {
        const certIssue = /not signed by the application owner|publisherNames/i.test(st.msg || "");
        $("bnrUpdTitle").textContent = certIssue ? "更新被证书校验拦下" : "更新失败";
        $("bnrUpdBarWrap").style.display = "none";
        $("bnrUpdMsg").textContent = (certIssue
          ? "这台电脑还没信任软件证书（每台电脑只需一次）。点「信任并重试」即可自动完成。"
          : ((st.msg || "未知错误") + " —— 多为代理节点抖动：开/换节点后点「重试」，或直接点「备用升级」（走路由台下载通道，通常更稳）。"));
        $("bnrUpdRow").style.display = "";
        $("bnrUpdSelf").style.display = "";
        $("bnrUpdGo").textContent = certIssue ? "信任并重试" : "重试更新";
        $("bnrUpdGo").onclick = async () => {
          if (certIssue) {
            $("bnrUpdGo").disabled = true;
            $("bnrUpdMsg").textContent = "正在导入证书…";
            const r = await window.baiDesktop.trustCert();
            $("bnrUpdGo").disabled = false;
            $("bnrUpdMsg").textContent = r.ok ? "证书已信任，重新检查更新…" : ("证书导入失败：" + (r.msg || "未知") + "，重试或手动运行 trust-cert.cmd");
          }
          window.baiDesktop.checkUpdate();
        };
        return;
      }
      $("bnrUpdGo").textContent = "重启安装";
      $("bnrUpdGo").onclick = () => window.baiDesktop.installUpdate();
      paintNotes(st.releaseNotes);
    };

    /* 横幅与弹框是**同一笔更新事务的两个视图**，靠 txid（主进程单调递增）认事务：
       只渲染当前事务，其余一律丢弃。curTxid=当前显示哪笔，seenTxid=见过的最大 txid
       （水位线，不随事务作废而清零——否则作废后迟到的旧事件会复活弹框）。 */
    let curTxid = null;
    let seenTxid = 0;

    window.baiDesktop.onAppEvent((ev) => {
      if (!ev || ev.kind !== "update") return;
      const s = ev.state || {};

      if (s.txid == null) {
        if (s.phase === "latest" || s.phase === "checking") curTxid = null;
        closeUpdateModal();
        paintUpdate(s);
        return;
      }
      if (s.txid < seenTxid) return;
      seenTxid = s.txid;

      if (s.txid !== curTxid) {
        closeUpdateModal();
        curTxid = s.txid;
      }

      const wantsModal = s.manual === true && (s.phase === "downloading" || s.phase === "ready");
      if (wantsModal) {
        const b = $("bnrUpdate");
        if (b) b.classList.remove("show");
        paintUpdateModal(s);
      } else {
        closeUpdateModal();
        paintUpdate(s);
      }
    });
    if (has("bnrUpdGo")) $("bnrUpdGo").onclick = () => window.baiDesktop.installUpdate();
    if (window.baiDesktop.onStaleCopy) {
      try { window.baiDesktop.onStaleCopy(paintStale); } catch { /* 旧壳没有这个桥 */ }
    }
  }

  /* ======================================================================
   * 3. 清单 / 视图表 / 选中渠道
   * ==================================================================== */
  const MANIFEST = window.BAI_PROVIDERS || {};
  const VIEWS = Array.isArray(window.BAI_VIEWS) ? window.BAI_VIEWS : [];
  const ALL_KEYS = Object.keys(MANIFEST).filter((k) => MANIFEST[k]);
  /* 进转移链的渠道（矩阵格序 = 转移链顺序；清单的书写顺序就是链序） */
  const CHAIN_KEYS = ALL_KEYS.filter((k) => MANIFEST[k].chainable === true);
  /* 不进链的那几格（交还区） */
  const HANDOFF_KEYS = ALL_KEYS.filter((k) => MANIFEST[k].chainable !== true);

  /* 凭据 / 中转这类字段的取法：清单里有的渠道在 status/config 里挂在同名子对象下，
     有的（最早那家）是**平铺**的——顶层字段直接就是它自己的。这里运行时探测，
     不在渲染层写死是哪一家（C11：渲染层不许出现渠道名字面量）。 */
  const sliceOf = (obj, key) => {
    if (!obj) return {};
    const sub = obj[key];
    return (sub && typeof sub === "object" && !Array.isArray(sub)) ? sub : obj;
  };
  const cfgOf = (key) => sliceOf(cfg, key);
  const stOf = (key) => sliceOf(status, key);

  const nameOf = (key) => {
    const p = MANIFEST[key] || {};
    return p.name || p.shortName || p.tab || key;
  };

  /* 接线徽章的比对字段：/api/status 的 cli/desktop 里带 keyMatch<首字母大写> 家族
     （keyMatchSn / keyMatchWb …），最早那家是裸的 keyMatch。两个候选都试，
     渲染层因此不需要知道具体是哪一家。 */
  const keyMatchOf = (m, key) => {
    if (!m) return undefined;
    const alt = "keyMatch" + key.charAt(0).toUpperCase() + key.slice(1);
    if (typeof m[alt] === "boolean") return m[alt];
    if (typeof m.keyMatch === "boolean") return m.keyMatch;
    return undefined;
  };

  let cfg = null, status = null, busy = false, cards = [];
  let polling = false;      // 轮询重入保护（不是 busy：busy 是"有动作在飞"）
  let selected = null;      // 当前选中的渠道 key；null = 还没定（等第一次 status）
  let fromPath = false;     // 选中是否由 URL 路径直接决定（决定要不要滚动+高亮）

  const normPath = (p) => (p || "/").replace(/\/+$/, "") || "/";
  function keyFromPath(p) {
    const here = normPath(p);
    for (const k of ALL_KEYS) {
      const mp = MANIFEST[k].path;
      if (mp == null) continue;                 // 交还区没有独立 URL
      if (normPath(mp) === here) return k;
    }
    return null;
  }
  function chainOf() {
    const f = (status && status.failover) || {};
    const list = Array.isArray(f.chain) && f.chain.length ? f.chain.slice() : CHAIN_KEYS.slice();
    return list.filter((k) => CHAIN_KEYS.includes(k));
  }

  /* ======================================================================
   * 4. 视图切换（URL hash：#/console · #/cred · #/fo · #/settings）
   * ==================================================================== */
  let currentView = (VIEWS[0] || {}).id || null;
  function viewFromHash() {
    const raw = String(location.hash || "").replace(/^#\/?/, "").trim();
    const hit = VIEWS.find((v) => v && v.id === raw);
    return hit ? hit.id : ((VIEWS[0] || {}).id);
  }
  function viewOf(id) { return VIEWS.find((v) => v && v.id === id) || null; }

  function setView(id, push) {
    const v = viewOf(id);
    if (!v) return;
    currentView = v.id;
    for (const vv of VIEWS) {
      const box = $(vv.dom);
      if (box) box.classList.toggle("on", vv.id === v.id);
    }
    for (const b of qa("#navViews [data-view]")) {
      const on = b.getAttribute("data-view") === v.id;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
    if (push !== false) {
      const want = "#/" + v.id;
      if (location.hash !== want) history.replaceState(null, "", want);
    }
    mountCardsFor(v.id);
  }

  /* ======================================================================
   * 5. 渠道的「就绪 / 需留意 / 故障 / 未配置」判定
   *    只看本机当下真实读到的字段；读不到就说读不到，不做乐观假设。
   * ==================================================================== */
  function credState(key) {
    const P = MANIFEST[key] || {};
    const kind = (P.credential || {}).kind || "none";
    if (kind === "none") return { s: "idle", txt: "不适用", detail: "不是本台渠道" };
    const S = stOf(key);
    const t = S.token || {};
    if (typeof t.configured === "boolean") {
      if (!t.configured) return { s: "idle", txt: "未配置", detail: (P.credential || {}).label || "凭据未就绪" };
      /* 轮换型令牌（jobToken）：令牌文件还在 ≠ 还在用。客户端没找到 = 上一次运行
         留下的陈旧文件，中转读到它只会 401 —— 这种要说"需留意"而不是"已就绪"。 */
      const p = S.patch || null;
      if (p && p.found === false) {
        return { s: "warn", txt: "令牌陈旧", detail: "本机没找到客户端安装目录，读到的是上次运行留下的文件" };
      }
      if (p && p.tokenFresh === false) {
        return { s: "warn", txt: "令牌未刷新", detail: "客户端没开或没发过带鉴权的请求" };
      }
      const days = t.expiresInDays;
      if (keyCount(t) > 1) {
        return { s: "ok", txt: `${t.keyCount} 把 key`, detail: t.keys.filter((k) => k.active).map((k) => k.fp).join(" · ") || "" };
      }
      if (days != null && days <= 7) return { s: "warn", txt: `剩 ${days} 天`, detail: t.hasRefresh ? "将自动续期" : "无刷新令牌，到期需重新获取" };
      return { s: "ok", txt: "已就绪", detail: t.expAt ? "有效期至 " + new Date(t.expAt).toLocaleDateString("zh-CN") : "" };
    }
    if (typeof S.keyConfigured === "boolean") {
      return S.keyConfigured
        ? { s: "ok", txt: "已就绪", detail: "" }
        : { s: "idle", txt: "未配置", detail: (P.credential || {}).label || "凭据未就绪" };
    }
    const C = cfgOf(key);
    if (C.apiKey) return { s: "ok", txt: "已就绪", detail: "指纹 " + fp(C.apiKey) };
    return { s: "idle", txt: "未配置", detail: (P.credential || {}).label || "凭据未就绪" };
  }
  const keyCount = (t) => (typeof t.keyCount === "number" ? t.keyCount : 0);

  /* 密钥指纹：只显示头尾，绝不回显明文（页面上任何位置都不出现明文密钥）。 */
  function fp(s) {
    const v = String(s == null ? "" : s);
    if (!v) return "";
    if (v.length <= 8) return v.slice(0, 2) + "…";
    return v.slice(0, 4) + "…" + v.slice(-4);
  }

  /* 综合一格的状态：先看中转起没起，再看凭据。两者都好才算就绪。 */
  function channelState(key) {
    const P = MANIFEST[key] || {};
    if (P.chainable !== true) {
      const running = status && status.ccswitch && status.ccswitch.running;
      return running
        ? { s: "warn", txt: "运行中", detail: "可能随时把配置改回它自己的端口" }
        : { s: "ok", txt: "未运行", detail: "配置可以安全地放在路由台上" };
    }
    const S = stOf(key);
    const cred = credState(key);
    const relayUp = !!(S.relay && S.relay.up);
    const up = S.upstream || {};
    const wired = wiredTo(key);
    if (!relayUp) return { s: "err", txt: "中转未起", detail: cred.detail };
    if (cred.s === "idle") return { s: "idle", txt: "凭据未配", detail: cred.detail };
    if (up.tested === false) return { s: "err", txt: "上游不可用", detail: up.error || "" };
    if (cred.s === "warn") return { s: "warn", txt: cred.txt, detail: cred.detail };
    if (up.tested === true) return { s: "ok", txt: wired ? "已接入" : "就绪", detail: up.model ? `${up.model} ${up.ms}ms` : "" };
    return { s: "ok", txt: wired ? "已接入" : "就绪", detail: cred.detail };
  }
  const wiredTo = (key) => !!status && ((status.cli && status.cli.mode === key) || (status.desktop && status.desktop.mode === key));

  /* ======================================================================
   * 6. 状态带：六个单元 + 一句人话总结 + 三个主动作
   * ==================================================================== */
  /* 出海代理格：模板给的是占位 markup（<span class="led"></span><span>—</span>），
     整块换掉再填，否则会出现 "— ● 正常" 这种半截旧值。 */
  function ensureClashUnit() {
    const box = $("lampClash");
    if (!box || $("txtClash")) return;
    const val = q(".val", box);
    if (!val) return;
    val.innerHTML = "";
    const led = document.createElement("span"); led.className = "led"; led.id = "ledClash";
    const txt = document.createElement("span"); txt.id = "txtClash"; txt.textContent = "—";
    val.append(led, txt);
    const sub = document.createElement("div"); sub.className = "sub"; sub.id = "subClash";
    box.appendChild(sub);
  }

  function paintBand(s) {
    const up = !!(s.service && s.service.up);
    setLed($("ledRelay"), up ? "ok" : "err", false);
    const selPort = selected ? ((stOf(selected).relay || {}).port) : null;
    $("txtRelay").textContent = up ? "运行中" : "已停止";
    const rl = (selected ? stOf(selected).relayLast : null) || {};
    const fresh = rl.at && Date.now() - new Date(rl.at).getTime() < 30 * 60000;
    $("subRelay").textContent = fresh
      ? `最近错误·${rl.kind}: ${rl.message}`
      : `中转 :${selPort || "—"} / 面板 :${(s.panel || {}).port || "—"}`;
    $("subRelay").title = fresh ? `${rl.at}\n${rl.message}` : "";

    ensureClashUnit();
    const cl = s.clash || {};
    setLed($("ledClash"), cl.alive ? "ok" : "err", false);
    $("txtClash").textContent = cl.alive ? "正常" : "不可用";
    $("subClash").textContent = cl.alive ? `${s.proxy || "直连"} · ${cl.ms || "?"}ms` : "未检测到可用通道";

    /* 本台凭据：看的是"当前接线那家"的凭据；没接线就看选中那家 */
    const tk = selected ? credState(selected) : { s: "idle", txt: "—" };
    setLed($("ledTok"), tk.s, false);
    $("txtTok").textContent = tk.txt;
    $("subTok").textContent = tk.detail || ((P_credLabel(selected)) || "");

    /* 可用渠道：数一数有多少家处于 ok */
    const states = CHAIN_KEYS.map(channelState);
    const okN = states.filter((x) => x.s === "ok").length;
    const warnN = states.filter((x) => x.s === "warn").length;
    const errN = states.filter((x) => x.s === "err").length;
    const idleN = states.filter((x) => x.s === "idle").length;
    const bandS = errN ? "err" : (okN ? "ok" : (warnN ? "warn" : "idle"));
    setLed($("ledUp"), bandS, false);
    $("txtUp").textContent = `${okN}/${CHAIN_KEYS.length} 可用`;
    /* 这行塞在 min-width 132px 的格子里，写长了会折行把整行仪表撑不齐，用短词。 */
    $("subUp").textContent = `就绪 ${okN} · 留意 ${warnN} · 故障 ${errN} · 未配 ${idleN}`;

    if (has("patchTime")) {
      $("patchTime").textContent = "检查于 " + new Date(s.now).toLocaleTimeString("zh-CN", { hour12: false });
    }
    /* 顶栏那颗服务胶囊。端口只来自 /api/status 的数字字段，用 textContent 拼，
       不走 innerHTML —— 免得把接口返回值当标记解析。 */
    const svc = $("svc");
    if (svc) {
      svc.textContent = "";
      const b = document.createElement("b");
      b.textContent = up ? "●" : "○";
      if (!up) b.className = "off";
      svc.append("服务 ", b, ` :${selPort || "—"} / :${(s.panel || {}).port || "—"}`);
    }
    paintSentence(s, okN, warnN, errN, idleN);
  }
  const P_credLabel = (key) => {
    const p = key ? (MANIFEST[key] || {}) : null;
    return p ? ((p.credential || {}).label || "") : "";
  };

  /* 一句话总结：照设计稿句式，数据缺失就说缺失，不乐观。 */
  function paintSentence(s, okN, warnN, errN, idleN) {
    const el = $("statusSentence");
    if (!el) return;
    const cl = s.clash || {};
    const bits = [];
    bits.push(s.service && s.service.up ? "路由台在跑" : "路由台已停止");
    bits.push(cl.alive ? "出海通道正常" : "出海通道不可用（境内渠道不受影响）");
    const cli = s.cli || {}, desk = s.desktop || {};
    const ends = [cli, desk].filter((x) => x && x.mode);
    if (!ends.length) bits.push("两端都还没接线");
    else {
      const modes = Array.from(new Set(ends.map((e) => e.mode)));
      bits.push(`当前接线：${modes.map((m) => (MANIFEST[m] ? nameOf(m) : (MODE_TXT[m] || m))).join(" + ")}`);
      const mismatch = ends.some((e) => e.mode === selected && keyMatchOf(e, selected) === false);
      if (mismatch) bits.push("面板里的凭据与实际生效的不一致，需重开对应端");
    }
    if (s.ccswitch && s.ccswitch.running) bits.push("配置交还工具正在运行，它可能随时改回自己的配置");
    /* 四类都要说到：只报"0 家可用 · 5 家还没配凭据"会把那 1 家"需留意"的吞掉，
       用户数格子时对不上账。 */
    const parts = [];
    if (okN) parts.push(`${okN} 家可用`);
    if (warnN) parts.push(`${warnN} 家需留意`);
    if (errN) parts.push(`${errN} 家故障`);
    if (idleN) parts.push(`${idleN} 家还没配凭据`);
    bits.push(parts.join(" · ") || "暂无可用渠道");
    el.textContent = bits.join("；") + "。";
  }

  /* 两端接线徽章：接的是谁 + 实际生效的凭据指纹（明文永不出现）。 */
  function paintBadges(s) {
    const paint = (badgeId, m, patchId) => {
      const el = $(badgeId), patch = $(patchId);
      if (!el || !m || !m.mode) return;
      const mine = m.mode === selected;
      el.className = "badge " + (mine ? "mine" : (MANIFEST[m.mode] ? "other" : "unk"));
      el.textContent = MODE_TXT[m.mode] || m.mode;
      el.title = m.baseUrl || "";
      if (!patch) return;
      clsx(patch, mine, "state-mine");
      clsx(patch, !mine && !!MANIFEST[m.mode], "state-other");
      let kf = q(".keyfp", patch);
      if (m.keyFp) {
        if (!kf) {
          kf = document.createElement("span");
          kf.className = "keyfp";
          const who = q(".who", patch);
          if (who) who.appendChild(kf);
        }
        const ok = !mine || keyMatchOf(m, selected) !== false;
        kf.textContent = (ok ? "🔑 " : "⚠️ ") + m.keyFp;
        kf.style.color = ok ? "var(--dim)" : "var(--err)";
        kf.title = ok ? `此端实际使用的凭据：${m.keyFp}` : `此端凭据(${m.keyFp}) 与面板里的不一致！重开对应端，或重新接通 ${nameOf(selected || "")}`;
        kf.style.display = "";
      } else if (kf) kf.style.display = "none";
    };
    paint("cliBadge", s.cli, "patchCli");
    paint("deskBadge", s.desktop, "patchDesk");
  }

  /* ======================================================================
   * 7. 渠道矩阵（八格：六家 + 交还区 + 转移链格。格序 = 转移链顺序）
   * ==================================================================== */
  const primaryText = (key) => `一键接入 ${nameOf(key)}`;

  function buildMatrix() {
    const grid = $("matrixGrid");
    if (!grid) return;
    grid.innerHTML = "";
    for (const key of chainOf().length ? chainOf() : CHAIN_KEYS) {
      grid.appendChild(cellFor(key));
    }
    for (const key of HANDOFF_KEYS) grid.appendChild(cellFor(key));
    grid.appendChild(chainCell());
    paintMatrix();
  }

  function cellFor(key) {
    const P = MANIFEST[key] || {};
    const el = document.createElement("div");
    el.className = "cell";
    el.dataset.k = key;
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.innerHTML = `
      <div class="celltop">
        <span class="letter">${esc(P.letter || "")}</span>
        <span class="cbadge ${esc((P.badge || {}).kind || "neutral")}">${esc((P.badge || {}).text || "")}</span>
      </div>
      <div class="cname">${esc(nameOf(key))}${P.path ? `<span class="cpath">${esc(P.path)}</span>` : ""}</div>
      <div class="ctag">${esc(P.tagline || "")}</div>
      <div class="cmap"></div>
      <div class="crelay"></div>
      <div class="cfoot"></div>`;
    el.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      selectChannel(key);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectChannel(key); }
    });
    return el;
  }

  function chainCell() {
    const el = document.createElement("div");
    el.className = "cell chaincell";
    el.dataset.k = "__chain";
    el.innerHTML = `
      <div class="celltop"><span class="letter">FO</span><span class="cbadge neutral">顺序</span></div>
      <div class="cname">故障转移链</div>
      <div class="ctag">额度用光或上游挂掉时，中转按这个顺序自己换人</div>
      <div class="chainlist"></div>
      <div class="cfoot"><button class="btn sm ghost" type="button" data-go="fo">调整顺序 →</button></div>`;
    const btn = q("button", el);
    if (btn) btn.addEventListener("click", () => setView("fo"));
    return el;
  }

  function paintMatrix() {
    const grid = $("matrixGrid");
    if (!grid) return;
    for (const el of qa(".cell", grid)) {
      const key = el.dataset.k;
      if (hasBusyIn(el)) continue;          // 这格里有按钮正在动作，别把它重建掉
      if (key === "__chain") {
        const box = q(".chainlist", el);
        if (box) {
          const f = (status && status.failover) || {};
          const list = chainOf();
          box.innerHTML = !list.length
            ? '<span class="dim">转移链为空</span>'
            : list.map((k, i) => {
              const st = channelState(k);
              return `<span class="chitem"><i class="dot ${st.s}"></i><b>${i + 1}</b> ${esc(nameOf(k))}</span>`;
            }).join("") + (f.enabled ? "" : '<span class="chainoff">当前已关闭</span>');
        }
        continue;
      }
      const st = channelState(key);
      el.dataset.state = st.s;
      clsx(el, key === selected, "sel");
      const P = MANIFEST[key] || {};
      const cm = q(".cmap", el);
      if (cm) {
        if (P.chainable !== true) {
          cm.innerHTML = '<span class="dim">配置交还给它，它自己管端口与凭据</span>';
        } else {
          const C = cfgOf(key);
          const map = C.mapping || {};
          cm.innerHTML = TIERS.map((t) => {
            const m = map[t.key] || {};
            return `<span class="mrow"><i class="t">${esc(t.short)}</i><i class="v">${esc(m.label || m.target || "未设")}</i></span>`;
          }).join("");
        }
      }
      const cr = q(".crelay", el);
      if (cr) {
        if (P.chainable !== true) {
          cr.innerHTML = status && status.ccswitch && status.ccswitch.running
            ? '<span class="rl warn">正在运行</span>'
            : '<span class="rl idle">未运行</span>';
        } else {
          const C = cfgOf(key);
          cr.innerHTML = `<span class="rl">中转 :${C.relayPort || "—"}</span><span class="rl2">${esc((P.credential || {}).label || "")}</span>`;
        }
      }
      const foot = q(".cfoot", el);
      if (foot) {
        if (P.chainable !== true) {
          foot.innerHTML = `<button class="btn sm" type="button" data-act="restore">接回 ${esc(nameOf(key))}</button>`;
        } else {
          foot.innerHTML = `<button class="btn sm primary" type="button" data-act="apply" ${st.s === "idle" ? "disabled" : ""}>${esc(primaryText(key))}</button>`
            + `<span class="cstate ${st.s}">${esc(st.txt)}</span>`;
        }
        const btn = q("button", foot);
        if (btn) btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (btn.dataset.act === "apply") applyChannel(key);
          else restoreExternal();
        });
      }
    }
  }

  /* ======================================================================
   * 8. 映射编辑区（当前选中渠道的四档）
   * ==================================================================== */
  function prettyName(key, id) {
    const BRANDS = (MANIFEST[key] || {}).brands || {};
    return String(id).split("-").map((seg) => {
      const low = seg.toLowerCase();
      if (BRANDS[low]) return BRANDS[low];
      if (/^[0-9]/.test(seg)) return seg;
      const ver = low.match(/^([a-z]+)([0-9].*)$/);
      if (ver && BRANDS[ver[1]]) return BRANDS[ver[1]] + ver[2];
      return seg.charAt(0).toUpperCase() + seg.slice(1);
    }).join("-");
  }
  /* 下拉里的显示名：model-catalog 卡把 /api/models 的 labels 暂存在这里 */
  const optText = (m) => {
    const L = window.BAI_MODEL_LABELS;
    return (L && L[m]) || m;
  };

  function renderRoute() {
    const tb = $("routeBody");
    if (!tb) return;
    const badge = $("mapBadge"), title = $("mapTitle"), sub = $("mapSub");
    if (!selected) {
      tb.innerHTML = '<tr><td colspan="3" class="dim">先在上面的矩阵里选一个渠道</td></tr>';
      if (badge) badge.textContent = "—";
      return;
    }
    const P = MANIFEST[selected] || {};
    if (P.chainable !== true) {
      tb.innerHTML = `<tr><td colspan="3" class="dim">${esc(nameOf(selected))}不是本台渠道，没有映射编辑区。去矩阵里选一家要接的。</td></tr>`;
      if (badge) badge.textContent = P.letter || "";
      if (title) title.textContent = nameOf(selected);
      if (sub) sub.textContent = P.tagline || "";
      showEl($("btnSave"), false); showEl($("btnTest"), false);
      showEl($("btnModels"), false); showEl($("btnResetModels"), false);
      return;
    }
    showEl($("btnSave"), true); showEl($("btnTest"), true);
    showEl($("btnModels"), (P.models || []).length > 0);
    showEl($("btnResetModels"), (P.defaultModels || []).length > 0);

    if (badge) badge.textContent = P.letter || "";
    if (title) title.textContent = `${nameOf(selected)} · 模型映射`;
    if (sub) sub.textContent = `${(P.models || []).length} 个可选模型 · 四档全部指向本渠道自己的模型名`;

    const C = cfgOf(selected);
    const list = Array.isArray(C.availableModels) && C.availableModels.length ? C.availableModels : (P.models || []);
    tb.innerHTML = "";
    for (const t of TIERS) {
      const m = (C.mapping || {})[t.key] || {};
      const isCustom = !!m.target && !list.includes(m.target);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><div class="tier">${esc(t.key)}</div><div class="zh">${esc(t.zh)}</div></td>
        <td><span class="arrow">─►&nbsp;</span></td>
        <td></td>`;
      const sel = document.createElement("select");
      sel.dataset.tier = t.key; sel.dataset.role = "target";
      for (const o of [...list, "__custom__"]) {
        const op = document.createElement("option");
        if (o === "__custom__") { op.value = "__custom__"; op.textContent = "自定义…"; }
        else { op.value = o; op.textContent = optText(o); op.title = o; }
        sel.appendChild(op);
      }
      sel.value = isCustom ? "__custom__" : (m.target || "");
      const lbl = document.createElement("input");
      lbl.type = "text"; lbl.className = "lbl"; lbl.dataset.tier = t.key; lbl.dataset.role = "label";
      lbl.value = m.label || ""; lbl.placeholder = "显示名";
      const cus = document.createElement("input");
      cus.type = "text"; cus.className = "custom"; cus.dataset.tier = t.key; cus.dataset.role = "custom";
      cus.value = isCustom ? m.target : ""; cus.placeholder = "输入模型名";
      cus.style.display = isCustom ? "" : "none";
      sel.addEventListener("change", () => {
        cus.style.display = sel.value === "__custom__" ? "" : "none";
        const target = sel.value === "__custom__" ? (cus.value || "") : sel.value;
        if (target) lbl.value = prettyName(selected, target);
      });
      cus.addEventListener("input", () => {
        if (sel.value === "__custom__" && cus.value) lbl.value = prettyName(selected, cus.value);
      });
      tr.children[1].append(sel, cus);
      tr.children[2].appendChild(lbl);
      tb.appendChild(tr);
    }
    const hint = $("patchHint");
    if (hint) hint.textContent = P.conclusion || "";
    const hr = $("hintRelayPort");
    if (hr) hr.textContent = ":" + (C.relayPort || "—");
  }

  /* ======================================================================
   * 9. 凭据视图：每家一行，按清单 credential.kind 分派
   * ==================================================================== */
  function buildCredList() {
    const box = $("credList");
    if (!box) return;
    box.innerHTML = "";
    for (const key of ALL_KEYS) {
      const P = MANIFEST[key] || {};
      const C = P.credential || {};
      const row = document.createElement("div");
      row.className = "credrow";
      row.dataset.k = key;
      row.innerHTML = `
        <div class="cl">
          <span class="letter">${esc(P.letter || "")}</span>
          <div class="clname">${esc(nameOf(key))}<span class="cpath">${esc(P.path || "本台交还区")}</span></div>
        </div>
        <div class="ck"><span class="kindbadge">${esc(C.label || "凭据")}</span><span class="chint">${esc(C.hint || "")}</span></div>
        <div class="cs"></div>
        <div class="ca"></div>
        <div class="crow" data-role="detail"></div>`;
      q(".cs", row).setAttribute("data-role", "state");
      q(".ca", row).setAttribute("data-role", "act");
      q(".cl", row).addEventListener("click", () => selectChannel(key));
      box.appendChild(row);
    }
    paintCredList();
  }

  function paintCredList() {
    const box = $("credList");
    if (!box) return;
    for (const row of qa(".credrow", box)) {
      const key = row.dataset.k;
      if (hasBusyIn(row)) continue;        // 同上：行内有动作在飞就别重建
      const P = MANIFEST[key] || {};
      const kind = (P.credential || {}).kind || "none";
      const st = credState(key);
      const stBox = q('[data-role="state"]', row);
      const act = q('[data-role="act"]', row);
      clsx(row, key === selected, "sel");

      if (kind === "apiKey") {
        const C = cfgOf(key);
        const shown = C.apiKey ? esc(fp(C.apiKey)) : "";
        stBox.innerHTML = `<span class="pill ${st.s}">${esc(st.txt)}</span>`
          + (shown ? `<span class="fp mono">${shown}</span>` : "");
        act.innerHTML = `<input type="password" class="keyinput" autocomplete="off" placeholder="${esc(C.hint || "")}" data-role="key">`
          + `<button class="btn sm" type="button" data-act="savekey">保存</button>`
          + `<button class="btn sm ghost" type="button" data-act="toggle">显示</button>`;
      } else if (kind === "jwt") {
        const S = stOf(key);
        const t = S.token || {};
        stBox.innerHTML = `<span class="pill ${st.s}">${esc(st.txt)}</span>`
          + (S.edition ? `<span class="fp">版别 ${esc(S.edition)}</span>` : "")
          + (t.expAt ? `<span class="fp">有效期至 ${esc(new Date(t.expAt).toLocaleDateString("zh-CN"))}</span>` : "");
        act.innerHTML = `<button class="btn sm primary" type="button" data-act="capture">一键获取令牌</button>`
          + `<button class="btn sm ghost" type="button" data-act="manual">手动填写</button>`;
      } else if (kind === "jobToken") {
        const S = stOf(key);
        const p = S.patch || {};
        const t = S.token || {};
        /* 徽章走 credState：不能在这里写死"已读到令牌"——令牌文件还在 ≠ 还在用。
           客户端没找到时那是上一次运行留下的陈旧文件，写成"已读到"会与状态带矛盾。 */
        stBox.innerHTML = `<span class="pill ${st.s}">${esc(st.txt)}</span>`
          + (st.detail ? `<span class="fp">${esc(st.detail)}</span>` : "")
          + (p.found && p.tokenFresh === false ? '<span class="fp">客户端没开或没发过带鉴权的请求</span>' : "")
          + (t.tokenFile ? `<span class="fp">令牌文件：${esc(t.tokenFile)}</span>` : "");
        act.innerHTML = `<button class="btn sm primary" type="button" data-act="patch" ${p.ready ? "disabled" : ""}>一键装补丁</button>`
          + `<button class="btn sm ghost" type="button" data-act="revert">还原客户端</button>`;
      } else if (kind === "keys3") {
        const t = (stOf(key).token) || {};
        const keys = Array.isArray(t.keys) ? t.keys : [];
        stBox.innerHTML = `<span class="pill ${st.s}">${esc(st.txt)}</span>`
          + (keys.length
            ? `<span class="fp mono">${keys.map((k) => esc(k.fp) + (k.active ? " ◂ 在用" : "")).join(" · ")}</span>`
            : `<span class="fp">一把都没有</span>`);
        if (!q(".keybox", act)) {
          act.innerHTML = `<button class="btn sm" type="button" data-act="keys">编辑三把 key</button>`
            + `<button class="btn sm ghost" type="button" data-act="quota">刷新免费目录与额度</button>`;
        }
      } else {
        stBox.innerHTML = `<span class="pill idle">不适用</span><span class="fp">不是本台渠道</span>`;
        act.innerHTML = "";
      }

      /* 通用按钮接线。轮换区编辑器打开时，它的按钮已各自单独接过分派，
         这里必须跳过，否则每轮 poll 都会再叠一个监听器（点一次发两次请求）。 */
      const btn = q("button[data-act]", act);
      if (btn && !q(".keybox", act)) btn.addEventListener("click", () => credAction(key, btn));
      const tg = q('button[data-act="toggle"]', act);
      if (tg) tg.addEventListener("click", () => {
        const inp = q(".keyinput", act);
        if (!inp) return;
        const showNow = inp.type === "password";
        inp.type = showNow ? "text" : "password";
        tg.textContent = showNow ? "隐藏" : "显示";
      });
    }
  }

  /* 令牌捕获的流程所有者登记表。
     共享层按 credential.kind 画出「一键获取令牌」按钮，但驱动它的流程可能属于卡片
     （token-capture 卡有等待面板要逐级刷新、还要轮询后端阶段文案）。卡片在 mount 时
     registerCapture(key, fn) 接管自己那一行；没注册的行由下面的兜底实现直接调接口。
     两者只会有一个跑——credistAction 里先查表再决定，不会双跑。 */
  const captureHandlers = {};
  const registerCapture = (key, fn) => { captureHandlers[key] = fn; };

  async function credAction(key, btn) {
    const act = btn.dataset.act;                 // 动作名（字符串）
    const row = q(`.credrow[data-k="${CSS.escape(key)}"]`);
    /* 行内的操作区容器。**别和上面的 act 混**：act 是字符串，
       下面要往操作区里塞编辑器、还要在里面 querySelector——用 act 当容器用会炸成
       "(root || document).querySelector is not a function"。 */
    const actBox = row ? q('[data-role="act"]', row) : null;
    const P = MANIFEST[key] || {};
    const kind = (P.credential || {}).kind || "none";
    try {
      if (act === "savekey") {
        const inp = q(".keyinput", row);
        const val = inp ? inp.value.trim() : "";
        if (!val) { showResult($("applyResult"), "没有输入密钥。", false); return; }
        await withBusy(btn, async () => {
          await postJSON("/api/config", { provider: key, apiKey: val });
          if (inp) inp.value = "";
          await refreshConfig();
          poll();
        }, $("applyResult"));
        showResult($("applyResult"), `✔ ${nameOf(key)} 的密钥已保存（明文只落在本机 config.json，页面不回显）。`, true);
      } else if (act === "capture") {
        const h = captureHandlers[key];
        if (typeof h === "function") { await h(btn); return; }   // 卡片接管（token-capture）
        await withBusy(btn, async () => {
          const r = await postJSON("/api/wb/capture", {});
          if (!r.ok) throw new Error(r.error || "未捕获到令牌");
        }, $("applyResult"));
        await refreshConfig(); poll();
        showResult($("applyResult"), `✔ ${nameOf(key)} 令牌已捕获并写入配置。到期后点「一键获取令牌」重取。`, true);
      } else if (act === "patch" || act === "revert") {
        let o = null;   // 只在**真的成功**之后才赋值；保持 null 就是给 withBusy 报错的信号
        await withBusy(btn, async () => {
          const url = act === "patch" ? "/api/qd/patch/apply" : "/api/qd/patch/revert";
          const r = await postJSON(url, {});
          if (r && r.error) throw new Error(r.error);
          /* 判成败**不能看 r.ok**：服务端回的是 `{ ok: r.fail === 0, ...r }`，
             而补丁函数自己返回的 `ok` 是「成功装了几个」的**计数**——展开写在后面，
             把前面那个布尔值盖掉了。所以 ok 实际是数字：0 既是"一个都没装上"，
             也是"本机根本没找到安装目录"。拿它当布尔判，会把"什么都没做"
             显示成"✔ 补丁已装"。这里只用语义明确的 total / fail / already。 */
          const total = Number(r.total) || 0;
          const fail = Number(r.fail) || 0;
          const done = (Number(r.ok) || 0) + (Number(r.already) || 0);
          if (act === "revert") { o = { act, total, fail, done }; return; }
          if (total === 0) throw new Error(`本机没找到 ${nameOf(key)} 客户端的安装目录，什么都没改（先装好桌面端再试）`);
          if (fail > 0) throw new Error(`${fail}/${total} 个 worker 副本补丁失败`);
          o = { act, total, fail, done };
        }, $("applyResult"));
        if (!o) return;                       // withBusy 已把失败原因写进结果行
        await refreshConfig(); poll();
        showResult($("applyResult"), o.act === "revert"
          ? `✔ ${nameOf(key)} 客户端已还原（补丁移除${o.total ? `：${o.total} 份` : "：本机没有找到已打补丁的副本"}）。`
          : `✔ 补丁已装到 ${nameOf(key)} 的 ${o.total} 个 worker 副本（本次生效 ${o.done} 个）。请确认桌面端正在运行——令牌每次启动会轮换。`, true);
      } else if (act === "keys") {
        /* 明文读不回来（服务端只回显指纹），所以编辑 = 重填三把。
           语义必须说清楚：保存会用这里填的**整体替换**现有轮换区，留空的格子会被删掉。
           因此这里绝不预填、也不允许一次空提交——那等于清空用户的 key。 */
        actBox.innerHTML = `
          <div class="keybox">
            <span class="kn">1</span><input type="password" class="keyinput" autocomplete="off" placeholder="sk-or-v1…（留空=不这把）">
          </div>
          <div class="keybox">
            <span class="kn">2</span><input type="password" class="keyinput" autocomplete="off" placeholder="sk-or-v1…">
          </div>
          <div class="keybox">
            <span class="kn">3</span><input type="password" class="keyinput" autocomplete="off" placeholder="sk-or-v1…">
          </div>
          <div class="keynote">保存会用这里填的三把**整体替换**现有轮换区——明文读不回来，
            所以没填的格子等于删除。要保留旧 key 就得把它重新填一遍。</div>
          <button class="btn sm primary" type="button" data-act="keysave">保存三把</button>
          <button class="btn sm ghost" type="button" data-act="keycancel">取消</button>`;
        q('button[data-act="keysave"]', actBox).addEventListener("click", () => credAction(key, q('button[data-act="keysave"]', actBox)));
        q('button[data-act="keycancel"]', actBox).addEventListener("click", () => paintCredList());
      } else if (act === "keysave") {
        const vals = qa(".keyinput", actBox).map((i) => i.value.trim());
        if (!vals.some(Boolean)) {
          showResult($("applyResult"),
            "三格都空着——真要清空轮换区的话，这会删掉全部已存的 key，请确认后再点一次。", false);
          return;
        }
        if (!confirm("保存会用这里填的 key 整体替换现有轮换区，没填的格子会被删除。确定？")) return;
        await withBusy(btn, async () => {
          const r = await postJSON("/api/or/keys", { keys: vals });
          if (r && r.error) throw new Error(r.error);
        });
        await refreshConfig(); poll();
        showResult($("applyResult"), `✔ ${nameOf(key)} 轮换区已更新。`, true);
      } else if (act === "quota") {
        await withBusy(btn, async () => { await postJSON("/api/or/refresh", {}); }, $("applyResult"));
        await refreshConfig(); poll();
        showResult($("applyResult"),
          "已按 pricing 全 0 重筛免费模型目录并重查额度。非免费档账号的用量接口读不到——"
          + "页面上会如实说「上游不提供」，不会编数字。", true);
      } else if (act === "manual") {
        showResult($("applyResult"),
          "手动填写需要把浏览器开发者工具里的鉴权请求头逐条粘回来。这条路很长，"
          + "平时用「一键获取令牌」就够了；确实要用时按 F12 → Network → 任一对话请求，"
          + "把 Authorization / X-Refresh-Token / X-Device-Token / X-User-Id 对应填进本机 config.json。", true);
      }
    } catch (e) {
      showResult($("applyResult"), "✘ " + e.message, false);
    }
  }

  /* ======================================================================
   * 10. 诊断抽屉：只呈现本机当前已知问题，绝不编造历史错误 / 错误数 / 时间线
   * ==================================================================== */
  function buildDiag() {
    const list = $("diagList");
    if (!list) return;
    const items = [];

    /* ① 路由台自身 */
    if (status && !status.service) items.push({ s: "err", t: "状态接口没有返回服务信息", m: "面板与中转可能已断开，刷新页面重试。" });
    else if (status && !(status.service || {}).up) items.push({ s: "err", t: "路由台服务已停止", m: "所有中转都已停止。重新启动路由台。" });

    /* ② 出海代理 */
    const cl = (status && status.clash) || {};
    if (status && cl.alive === false && CHAIN_KEYS.some((k) => credState(k).s !== "idle")) {
      const needProxy = CHAIN_KEYS.filter((k) => credState(k).s !== "idle" && (cfgOf(k).useProxy === true));
      items.push(needProxy.length
        ? { s: "err", t: "出海通道不可用，但有渠道勾选了「走本机代理」", m: `${needProxy.map(nameOf).join("、")} 会因此连不上。到设置视图关掉勾选，或换一个可用节点。` }
        : { s: "warn", t: "出海通道不可用", m: "目前没有渠道依赖它，境内渠道不受影响；要用海外渠道时先解决代理。" });
    }

    /* ③ 逐渠道：凭据 / 上游 / 中转 */
    for (const key of chainOf().length ? chainOf() : CHAIN_KEYS) {
      const P = MANIFEST[key] || {};
      const st = channelState(key);
      const S = stOf(key);
      const up = S.upstream || {};
      const rl = S.relayLast || {};
      const fresh = rl.at && Date.now() - new Date(rl.at).getTime() < 30 * 60000;

      if (st.s === "idle") {
        items.push({ s: "idle", t: `${nameOf(key)}：${P.conclusion || ""}`.trim(), m: P.remedy || "" });
        continue;
      }
      if (up.tested === false) {
        items.push({ s: "err", t: `${nameOf(key)} 上游连不上：${up.error || "未知错误"}`, m: P.remedy || "" });
      } else if (fresh && rl.message) {
        items.push({ s: "err", t: `${nameOf(key)} 最近一次请求失败（${rl.kind || "未知"}）`, m: `${rl.message}\n（${rl.at}）` });
      } else if (st.s === "warn") {
        items.push({ s: "warn", t: `${nameOf(key)}：${st.txt}`, m: st.detail || P.remedy || "" });
      } else if (up.tested === true) {
        items.push({ s: "ok", t: `${nameOf(key)} 上游正常`, m: `${up.model || ""} ${up.ms || "?"}ms · ${P.conclusion || ""}`.trim() });
      } else {
        items.push({ s: "ok", t: `${nameOf(key)} 凭据就绪、上游未测过`, m: `未探测过只算「未验」，不算故障。${P.remedy || ""}`.trim() });
      }
    }

    /* ④ 交还区 */
    if (status && status.ccswitch && status.ccswitch.running) {
      items.push({ s: "warn", t: "配置交还工具正在运行", m: "它可能随时把配置改回自己的端口。想让它退场：点「一键最优」或从任意渠道接通。" });
    }

    /* ⑤ 额度余量：上游不提供就如实说没有，不编数字（真实数据源留给阶段二） */
    items.push({ s: "idle", t: "额度余量：暂无数据", m: "上游没有给本路由台可读的额度接口，页面上不显示任何估算数字。" });

    list.innerHTML = items.map((it) => `
      <div class="ditem ${it.s}">
        <span class="dot ${it.s}"></span>
        <div class="dx">
          <div class="dt">${esc(it.t)}</div>
          ${it.m ? `<div class="dm">${esc(it.m)}</div>` : ""}
        </div>
      </div>`).join("");

    const bad = items.filter((i) => i.s === "err").length;
    const warn = items.filter((i) => i.s === "warn").length;
    const sum = $("diagSum"), mini = $("diagMini");
    if (sum) sum.textContent = bad ? `${bad} 条故障 · ${warn} 条留意` : (warn ? `${warn} 条需留意` : "没有观察到失败");
    if (mini) mini.textContent = `${items.length} 条结论`;
  }

  /* ======================================================================
   * 11. 设置视图
   * ==================================================================== */
  /* 平铺渠道时替「走本机代理」勾选框的那行说明（勾选框隐藏后总得说清楚去哪看）。 */
  let proxyNote = null;
  function ensureProxyNote() {
    if (proxyNote && proxyNote.isConnected) return proxyNote;
    const ck = $("ckUseProxy");
    if (!ck) return null;
    const label = ck.closest("label");
    proxyNote = document.createElement("div");
    proxyNote.className = "hint proxynote";
    if (label && label.parentNode) label.parentNode.insertBefore(proxyNote, label.nextSibling);
    return proxyNote;
  }

  /* 用户正在改的输入框不许被轮询覆盖。设置视图的字段每 5 秒就会被回填一次，
     从前没有这层判断——在「上游地址」里打一半字，光标一移开内容就被抹掉。
     判定：正被聚焦，或者动过但还没保存（data-dirty，保存成功后清掉）。 */
  function markDirtyInputs() {
    for (const id of ["fUpstream", "fRelayPort"]) {
      const el = $(id);
      if (el && !el.dataset.wired) {
        el.dataset.wired = "1";
        el.addEventListener("input", () => { el.dataset.dirty = "1"; });
        el.addEventListener("blur", () => { if (el.value === "") delete el.dataset.dirty; });
      }
    }
  }
  /* 勾选框也要认「动过但没保存」：change 事件打 dirty，保存成功后清掉。 */
  function wireProxyCheckbox() {
    const ck = $("ckUseProxy");
    if (ck && !ck.dataset.wired) {
      ck.dataset.wired = "1";
      ck.addEventListener("change", () => { ck.dataset.dirty = "1"; });
    }
  }
  function clearDirtyInputs() {
    for (const id of ["fUpstream", "fRelayPort"]) {
      const el = $(id);
      if (el) delete el.dataset.dirty;
    }
    const ck = $("ckUseProxy");
    if (ck) delete ck.dataset.dirty;
  }

  function renderSys() {
    if (!selected) return;
    const P = MANIFEST[selected] || {};
    if (P.chainable !== true) return;
    const C = cfgOf(selected);
    const SL = P.settingsLabels || {};
    markDirtyInputs();
    wireProxyCheckbox();
    const setV = (id, v) => {
      const el = $(id);
      if (!el) return;
      if (el === document.activeElement || el.dataset.dirty === "1") return;
      el.value = v == null ? "" : v;
    };
    setV("fUpstream", C.upstream);
    setV("fRelayPort", C.relayPort);
    if (has("lblUpstream")) $("lblUpstream").textContent = SL.upstream || "上游地址";
    if (has("lblRelayPort")) $("lblRelayPort").textContent = SL.relayPort || "中转端口";

    /* 「走本机代理」这个开关只对**嵌套**渠道有意义：服务端 /api/config 明确写了
       `if (P !== "bai" && typeof b.useProxy === "boolean")`——最早那家走的是**进程级**
       的 cfg.proxy 字段（改它要重启），没有 per-channel 的 useProxy。
       若照样画勾选框，用户勾上、点保存、页面回一句"✔ 设置已保存"，而配置里根本没
       这个字段——这是最坏的一种"成功"：看起来生效了，其实没有。
       平铺与否运行时判定（sliceOf 返回根对象即平铺），不写渠道名。 */
    const flat = cfg != null && cfgOf(selected) === cfg;
    const ckRow = has("ckUseProxy") ? $("ckUseProxy").closest("label") : null;
    showEl($("ckUseProxy"), !flat);
    showEl(ckRow, !flat);
    /* 勾选框同理：轮询不能把用户刚点上的状态弹回去（点完还没按保存就变回去，
       用户会以为自己没点上）。 */
    if (has("ckUseProxy") && !flat) {
      const ck = $("ckUseProxy");
      if (ck !== document.activeElement && ck.dataset.dirty !== "1") ck.checked = C.useProxy === true;
    }

    const note = ensureProxyNote();
    if (note) {
      note.style.display = flat ? "" : "none";
      if (flat) {
        note.textContent =
          `本渠道走进程级代理：${(status && status.proxy) || "直连"}——由启动自检自动挑选，`
          + "不是这一家的开关（其余渠道才有「让本渠道也走本机代理」）。";
      }
    }

    showEl($("btnDeploy"), P.chainable === true);

    const box = $("setChannels");
    if (box && !q(".chntable", box)) {
      const rows = chainOf().length ? chainOf() : CHAIN_KEYS;
      const t = document.createElement("div");
      t.className = "chntable";
      t.innerHTML = `<table class="route"><thead><tr><th>渠道</th><th>中转端口</th><th>上游</th><th>走代理</th></tr></thead><tbody>${
        rows.map((k) => `<tr data-k="${esc(k)}"><td class="zh">${esc(nameOf(k))}</td>`
          + `<td class="mono"></td><td class="mono dim"></td><td class="zh"></td></tr>`).join("")
      }</tbody></table>`;
      box.appendChild(t);
    }
    if (box) {
      for (const tr of qa(".chntable tbody tr", box)) {
        const C2 = cfgOf(tr.dataset.k);
        const tds = tr.children;
        tds[1].textContent = ":" + (C2.relayPort || "—");
        tds[2].textContent = C2.upstream || "—";
        tds[2].title = C2.upstream || "";          // 表格里截断了，完整地址放 title
        tds[3].textContent = C2.useProxy === true ? "走代理" : "直连";
        clsx(tds[3], C2.useProxy === true, "warncell");
      }
    }
  }

  /* ======================================================================
   * 12. 动作
   * ==================================================================== */
  function errSlotOf(btn, explicit) {
    if (explicit) return explicit;
    const box = btn && btn.closest ? btn.closest(".view") : null;
    return (box && q(".result", box)) || $("applyResult");
  }
  /* 容器里有没有正在动作的按钮？有就别重绘这个容器——
     重建 innerHTML 会把那个按钮连同它的 disabled 状态一起换掉，
     动作还在飞、界面上的按钮却已经能再点一次。 */
  const hasBusyIn = (el) => !!(el && el.querySelector("[data-busy]"));

  async function withBusy(btn, fn, errSlot) {
    const slot = errSlotOf(btn, errSlot);
    busy = true;
    const old = btn ? btn.textContent : "";
    /* 长动作要给人看得见的进展：按钮上走秒。测试连通在慢网络下能跑两分多钟，
       只写一个"处理中…"用户无从判断是卡住了还是还在跑。 */
    let tick = null;
    if (btn) {
      btn.dataset.busy = "1";
      btn.disabled = true;
      btn.textContent = "处理中… 0s";
      const t0 = Date.now();
      tick = setInterval(() => {
        if (!btn.isConnected) { clearInterval(tick); tick = null; return; }
        btn.textContent = `处理中… ${Math.round((Date.now() - t0) / 1000)}s`;
      }, 1000);
    }
    try { await fn(); } catch (e) { showResult(slot, "出错了：" + e.message, false); }
    finally {
      if (tick) clearInterval(tick);
      if (btn) {
        delete btn.dataset.busy;
        btn.disabled = false;
        btn.textContent = old;
      }
      busy = false;
      poll();
    }
  }

  function onClick(id, fn) {
    const el = $(id);
    if (el) el.addEventListener("click", fn);
  }

  async function applyChannel(key) {
    const r = await postJSON("/api/apply", { provider: key });
    showResult($("applyResult"),
      `✔ 已接入 ${nameOf(key)}（切换前配置已自动快照）`
      + "\n" + (r.warnings || []).map((w) => "· " + w).join("\n"), true);
    selectChannel(key);
    poll();
  }

  async function restoreExternal() {
    const r = await postJSON("/api/restore", {});
    showResult($("applyResult"),
      "✔ 已接回配置交还工具\n"
      + [].concat(r.messages || [], r.hints || []).map((m) => "· " + m).join("\n"), true);
    poll();
  }

  /* 「一键最优」：沿转移链找第一家凭据就绪且中转在跑的，接通它。
     一家都找不到就如实说没有，不硬接。 */
  async function bestChannel() {
    const list = chainOf().length ? chainOf() : CHAIN_KEYS;
    for (const k of list) {
      const st = channelState(k);
      if (st.s === "ok" || st.s === "warn") return k;
    }
    return null;
  }
  function applyBest() {
    withBusy($("btnBest"), async () => {
      const k = await bestChannel();
      if (!k) {
        showResult($("applyResult"),
          "没有一家渠道处于可用状态——先去凭据视图把至少一家的凭据配好。", false);
        return;
      }
      await applyChannel(k);
      showResult($("applyResult"), `✔ 已按转移链顺序选中并接入 ${nameOf(k)}。`, true);
    }, $("applyResult"));
  }

  async function saveMapping() {
    const mapping = {};
    for (const t of TIERS) {
      const sel = document.querySelector(`select[data-tier="${t.key}"]`);
      const cus = document.querySelector(`input[data-role="custom"][data-tier="${t.key}"]`);
      const lbl = document.querySelector(`input[data-role="label"][data-tier="${t.key}"]`);
      if (!sel) continue;
      const target = sel.value === "__custom__" ? (cus ? cus.value : "") : sel.value;
      mapping[t.key] = { target: (target || "").trim().toLowerCase(), label: lbl ? lbl.value : "" };
    }
    const r = await postJSON("/api/config", { provider: selected, mapping });
    showResult($("testResult"), "✔ 映射已保存并生效\n" + (r.hints || []).map((h) => "· " + h).join("\n"), true);
    await refreshConfig();
  }

  async function testTiers() {
    const all = has("ckAllTiers") && $("ckAllTiers").checked;
    const r = await postJSON("/api/test", all ? { provider: selected, all: true } : { provider: selected });
    const single = !!r.active && !all;
    const lines = (r.tiers || []).map((t) => {
      const who = single ? "当前使用：" : (TIER_ZH[t.tier] || t.tier) + "：";
      return t.ok ? `✔ ${who}${t.label} · ${t.ms}ms` : `✘ ${who}${t.label} · 失败：${t.error}`;
    });
    const tail = single ? "" : "（最近 30 分钟没观察到真实对话流量，已测全部四档）";
    showResult($("testResult"), lines.join("\n") + (tail ? "\n" + tail : ""), !!r.ok);
  }

  async function refreshModels() {
    const P = MANIFEST[selected] || {};
    const r = await api("/api/models?p=" + selected);
    const C = cfgOf(selected);
    const curTargets = TIERS
      .map((t) => String(((C.mapping || {})[t.key] || {}).target || "").toLowerCase())
      .filter(Boolean);
    const merged = [...new Set([...(r.models || []), ...curTargets])];
    await postJSON("/api/config", { provider: selected, availableModels: merged });
    await refreshConfig();
    refreshCards();
    showResult($("testResult"), `✔ ${nameOf(selected)} 已拉取模型 ${r.count} 个\n下拉框已更新（映射目标强制保留）`, true);
    if (r.note) showInfo(nameOf(selected), r.note, 0);
    if (P.models && P.models.length) {
      /* 清单与实时目录有出入时据实提醒（发布机上的出厂清单 vs 本机实际可用） */
      const extra = merged.filter((m) => !P.models.includes(m));
      const gone = P.models.filter((m) => !merged.includes(m));
      if (extra.length || gone.length) {
        showResult($("testResult"),
          `✔ ${nameOf(selected)} 已拉取模型 ${r.count} 个\n下拉框已更新（映射目标强制保留）`
          + "\n注意：本机实际目录与发布时清单不一致——多出 " + extra.length + " 个、少了 " + gone.length
          + " 个。清单是出厂默认值，实际可用以上游为准。", true);
      }
    }
  }

  async function resetModels() {
    const P = MANIFEST[selected] || {};
    const defs = P.defaultModels || [];
    if (!defs.length) return;
    await postJSON("/api/config", { provider: selected, availableModels: defs });
    await refreshConfig();
    showResult($("sysResult"), `✔ ${nameOf(selected)} 已恢复默认模型：${defs.join("、")}`, true);
  }

  async function saveSys() {
    const body = { provider: selected };
    for (const [id, field] of [["fUpstream", "upstream"], ["fRelayPort", "relayPort"]]) {
      const el = $(id);
      if (el && el.value.trim()) body[field] = el.value.trim();
    }
    if (has("ckUseProxy") && cfgOf(selected) !== cfg) body.useProxy = $("ckUseProxy").checked;
    const r = await postJSON("/api/config", body);
    const lines = ["✔ 设置已保存", ...(r.messages || []), ...(r.hints || [])];
    if (r.needRestart) {
      showResult($("sysResult"), lines.join("\n") + "\n\n端口改动需重启服务生效", true);
      const rb = document.createElement("button");
      rb.className = "btn-main"; rb.type = "button"; rb.textContent = "保存并重启服务";
      rb.style.cssText = "margin-top:8px;padding:6px 16px";
      rb.onclick = () => withBusy(rb, async () => {
        if (window.baiDesktop) { await window.baiDesktop.restartServer(); showResult($("sysResult"), "✔ 服务已重启（页面将自动刷新）", true); poll(); }
        else { await api("/api/service/restart", { method: "POST" }); showResult($("sysResult"), "✔ 服务正在重启，5 秒后自动回到页面", true); setTimeout(() => location.reload(), 5000); }
      });
      $("sysResult").appendChild(rb);
    } else {
      showResult($("sysResult"), lines.join("\n"), true);
    }
    clearDirtyInputs();
    await refreshConfig();
  }

  async function deployLocal() {
    if (window.baiDesktop) { await window.baiDesktop.deployLocal(); return; }
    const r = await postJSON("/api/deploy-local", { shortcuts: true, autostart: true, probeProxy: true });
    showResult($("sysResult"), "✔ 部署完成\n" + (r.messages || [r.error || ""]).join("\n"), !!r.ok);
  }

  /* ======================================================================
   * 13. 轮询 / 配置
   * ==================================================================== */
  async function refreshConfig() {
    cfg = await api("/api/config");
    renderRoute();
    renderSys();
    paintMatrix();
  }

  async function poll() {
    /* 轮询**不再**被 busy 拦住。
       从前这里是 `if (busy) return`，本意是防止重绘把正在点的按钮换掉（矩阵与凭据行
       每次都重建 innerHTML），代价却是：任何一个长动作期间（测试连通在这类网络下
       能跑两分多钟）整个 5 秒轮询停摆，状态带与诊断抽屉一起冻结，用户除了按钮上的
       "处理中…" 之外什么都看不到，以为面板死了。
       现在改成各管各的：
         · 重入保护交给 polling —— 两次轮询不该叠在一起，这是它本来的职责；
         · 重绘安全交给 withBusy 给按钮打的 [data-busy] 标记 —— 画到带这个标记的
           容器就跳过，动作结束后 withBusy 的 finally 会补一次 poll()，状态自然刷新。 */
    if (polling) return;
    polling = true;
    try {
      const s = await api("/api/status");
      status = s;
      if (!selected) { pickInitial(s); applySelectionUi(); }
      paintBand(s);
      paintBadges(s);
      paintMatrix();
      buildDiag();
      renderSys();
      for (const c of cards) {
        try { if (c.update) c.update(s, cfg); } catch (e) { console.warn("[card] " + c.name, e); }
      }
    } catch {
      const el = $("svc");
      if (el) el.innerHTML = `服务 <b class="off">○</b> 已停止`;
      setLed($("ledRelay"), "err", false);
      const txt = $("txtRelay");
      if (txt) txt.textContent = "已停止";
    } finally {
      polling = false;
    }
  }
  const refreshCards = () => {
    for (const c of cards) { try { if (c.refresh) c.refresh(); } catch (e) { console.warn("[card] " + c.name, e); } }
  };

  /* ======================================================================
   * 14. 选中渠道 / 视图切换的接线
   * ==================================================================== */
  function pickInitial(s) {
    const fromUrl = keyFromPath(location.pathname);
    if (fromUrl) { selected = fromUrl; fromPath = true; return; }
    /* 根路径 /：选中当前接线的那家；都没接线就选转移链首位 */
    const ends = [s.cli, s.desktop].filter(Boolean).map((e) => e.mode);
    const wired = ends.find((m) => m && MANIFEST[m] && MANIFEST[m].chainable === true);
    selected = wired || (chainOf()[0] || CHAIN_KEYS[0] || null);
  }

  /* 选中渠道后的 UI 回灌。抽出来是因为「首次从 status 判定出渠道」与「用户点卡片」
     是同一条路径，只是后者多一步滚动高亮。 */
  function applySelectionUi() {
    const P = MANIFEST[selected] || {};
    document.title = P.title || "路由台";
    const t = $("h1Text");
    if (t) t.textContent = selected ? nameOf(selected) : "路由台";
    renderRoute();
    renderSys();
    paintMatrix();
    paintCredList();
    buildDiag();
  }

  function selectChannel(key) {
    if (!MANIFEST[key]) return;
    selected = key;
    clearDirtyInputs();      // 换渠道 = 换一份配置，未保存的半截字不带过去
    applySelectionUi();
    const cell = q(`.cell[data-k="${CSS.escape(key)}"]`, $("matrixGrid"));
    if (cell) {
      cell.classList.add("flash");
      cell.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    refreshCards();
  }

  /* ======================================================================
   * 15. 主题 / 窗口控制 / 折叠
   * ==================================================================== */
  function wireTheme() {
    const TKEY = "bai.theme";
    const apply = (t) => {
      const root = document.documentElement;
      /* 换肤那一帧把过渡全关掉（CSS 里 html.no-trans 有对应规则）。
         颜色属性带 transition 时换肤会拖尾；在不产帧的环境里还会永远停在旧值。
         用 setTimeout 而不是双 rAF —— 隐藏窗口不触发 rAF，那条路会卡住不上。 */
      root.classList.add("no-trans");
      root.setAttribute("data-theme", t);
      setTimeout(() => root.classList.remove("no-trans"), 0);
      const i = $("themeIcon"), x = $("themeText");
      if (i) i.textContent = t === "light" ? "☀" : "☾";
      if (x) x.textContent = t === "light" ? "亮色" : "暗色";
    };
    let t = null;
    try { t = localStorage.getItem(TKEY); } catch { /* 无痕模式读不到，走系统 */ }
    if (!t) {
      try { t = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; }
      catch (e) { t = "dark"; }
    }
    apply(t);
    const btn = $("themeBtn");
    if (btn) btn.addEventListener("click", () => {
      t = (document.documentElement.getAttribute("data-theme") === "light") ? "dark" : "light";
      try { localStorage.setItem(TKEY, t); } catch { /* 写不进去也不影响本次切换 */ }
      apply(t);
    });
    window.addEventListener("storage", (e) => { if (e.key === TKEY && e.newValue) apply(e.newValue); });
  }

  function wireWindowCtrls() {
    const D = window.baiDesktop;
    const hasFrame = !!(D && D.winMinimize);
    document.body.classList.toggle("app-frame", hasFrame);
    document.body.classList.toggle("no-frame", !hasFrame);
    if (!hasFrame) return;
    const on = (id, fn) => {
      const el = $(id);
      if (el) el.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    };
    on("winMin", () => D.winMinimize());
    on("winMax", () => D.winToggleMaximize());
    on("winClose", () => D.winClose());
    const syncMax = (s) => { const b = $("winMax"); if (b && s) b.title = s.maximized ? "向下还原" : "最大化"; };
    if (D.onWindowState) D.onWindowState(syncMax);
    const hd = document.querySelector("header");
    if (hd) hd.addEventListener("dblclick", (e) => {
      if (e.target.closest(".winCtrls") || e.target.closest(".tabs") || e.target.closest("button")) return;
      D.winToggleMaximize();
    });
  }

  function fold(cardId, headId, storeKey, startCollapsed) {
    const card = $(cardId), head = $(headId);
    if (!card || !head) return;
    head.setAttribute("tabindex", "0");
    head.setAttribute("role", "button");
    let col0;
    if (startCollapsed === undefined) {
      try { col0 = localStorage.getItem(storeKey) !== "1"; } catch { col0 = true; }
    } else col0 = startCollapsed;
    if (col0) card.classList.add("collapsed");
    const sync = () => head.setAttribute("aria-expanded", String(!card.classList.contains("collapsed")));
    sync();
    const toggle = () => {
      const col = card.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", String(!col));
      try { localStorage.setItem(storeKey, col ? "0" : "1"); } catch { /* 记不住也不该报错 */ }
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  }

  /* ======================================================================
   * 16. 页脚 + 桌面事件
   * ==================================================================== */
  function wireFooter() {
    if (has("verTxt") && window.baiDesktop) {
      api("/api/version").then((v) => { $("verTxt").textContent = "v" + v.version; }).catch(() => { });
    } else if (has("verTxt")) {
      api("/api/version").then((v) => { $("verTxt").textContent = "v" + v.version; }).catch(() => { });
    }
    if (has("footPaths")) {
      $("footPaths").textContent = ALL_KEYS
        .filter((k) => MANIFEST[k].path)
        .map((k) => MANIFEST[k].path).join("  ");
    }
    if (window.baiDesktop) {
      window.baiDesktop.onAppEvent((ev) => {
        if (!ev) return;
        if (ev.kind === "recovered") showInfo("服务恢复", ev.text);
        else if (ev.kind === "check") showInfo("路由台", ev.text, ev.sticky ? 0 : 6000);
        else if (ev.kind === "deployed") showInfo("已自动部署", ev.text, 8000);
      });
    }
  }

  /* ======================================================================
   * 17. 卡片挂载：按视图（BAI_VIEWS[].cards）而不是按渠道（extraCards）
   *     卡片属于视图而不属于渠道——旧架构同一张卡在总览页挂一份、各家页挂另一份，
   *     漂移就是这么来的。
   * ==================================================================== */
  /* 凭据视图里的卡片按 credential.kind 自认领自己的行——不写渠道名，
     新增一家同类型的渠道时卡片自动跟过去，不必改卡也不用改渲染层。 */
  function rowsOfKind(kind) {
    const box = $("credList");
    if (!box) return [];
    const keys = ALL_KEYS.filter((k) => ((MANIFEST[k].credential || {}).kind || "none") === kind);
    return keys.map((k) => {
      const row = q(`.credrow[data-k="${CSS.escape(k)}"]`, box);
      return row ? q('[data-role="detail"]', row) : null;
    }).filter(Boolean);
  }

  const ctx = {
    get cfg() { return cfg; },
    get status() { return status; },
    get channel() { return selected; },
    get view() { return currentView; },
    channels: ALL_KEYS,
    nameOf, cfgOf, stOf, sliceOf, channelState, credState, chainOf, rowsOfKind, TIERS, TIER_ZH, MODE_TXT, esc, cap,
    $, q, qa, api, postJSON, showInfo, showResult, setLed, withBusy, poll, refreshConfig,
    renderRoute, selectChannel, setView, fp, registerCapture,
  };

  function loadScript(src, ms) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      const t = setTimeout(() => reject(new Error("加载超时 " + src)), ms || 6000);
      s.src = src;
      s.onload = () => { clearTimeout(t); resolve(); };
      s.onerror = () => { clearTimeout(t); reject(new Error("加载失败 " + src)); };
      document.head.appendChild(s);
    });
  }

  const mountedFor = new Map();
  async function mountCardsFor(viewId) {
    const v = viewOf(viewId);
    if (!v) return;
    if (mountedFor.get(viewId)) { refreshCards(); return; }
    mountedFor.set(viewId, true);
    for (const name of (v.cards || [])) {
      try {
        await loadScript("/cards/" + name + ".js");
        const mod = (window.BAI_CARDS || {})[name];
        if (!mod || typeof mod.mount !== "function") { console.warn("[card] " + name + " 未导出 mount()"); continue; }
        /* 卡片落点：优先该视图里的 #foPanel / #credList 一类插槽，否则落进视图容器末尾 */
        const host = q(`#${v.dom} [data-cardhost]`) || $(v.dom) || $("slot-extra");
        const view = mod.mount(Object.assign({}, ctx, { slot: host, view: v.id })) || {};
        cards.push({ name, view: v.id, update: view.update, refresh: view.refresh });
      } catch (e) {
        console.warn("[card] " + name, e);
      }
    }
    refreshCards();
  }

  /* ======================================================================
   * 18. 启动
   * ==================================================================== */
  function wire() {
    for (const b of qa("#navViews [data-view]")) {
      b.addEventListener("click", () => setView(b.getAttribute("data-view")));
    }
    onClick("btnBest", applyBest);
    onClick("btnRestore2", () => withBusy($("btnRestore2"), restoreExternal, $("applyResult")));
    onClick("btnRestore", () => withBusy($("btnRestore"), restoreExternal, $("applyResult")));
    onClick("btnSave", () => withBusy($("btnSave"), saveMapping, $("testResult")));
    onClick("btnTest", () => withBusy($("btnTest"), testTiers, $("testResult")));
    onClick("btnModels", () => withBusy($("btnModels"), refreshModels, $("testResult")));
    onClick("btnResetModels", () => withBusy($("btnResetModels"), resetModels, $("sysResult")));
    onClick("btnSaveSys", () => withBusy($("btnSaveSys"), saveSys, $("sysResult")));
    onClick("btnDeploy", () => withBusy($("btnDeploy"), deployLocal, $("sysResult")));

    const db = $("diagBar"), dd = $("diagDrawer");
    if (db && dd) {
      const toggle = () => {
        const open = dd.classList.toggle("open");
        db.setAttribute("aria-expanded", String(open));
        if (open) buildDiag();
      };
      db.addEventListener("click", toggle);
      onClick("btnDiag", toggle);
      const setOpen = (on) => { dd.classList.toggle("open", on); db.setAttribute("aria-expanded", String(on)); if (on) buildDiag(); };
      if (db.dataset.open === "1") setOpen(true);
    }
  }

  function boot() {
    /* data-provider 只用于微调底色温度，配色不再按渠道切换（模板引导脚本已设，这里兜底） */
    const root = document.documentElement;
    if (!root.getAttribute("data-provider")) {
      root.setAttribute("data-provider", (keyFromPath(location.pathname)) || "home");
    }
    applyTextOrNull("h1Text", selected ? nameOf(selected) : "路由台");

    setView(viewFromHash(), false);
    buildMatrix();
    buildCredList();
    wireTheme();
    wireWindowCtrls();
    wire();

    poll();
    refreshConfig().catch((e) => showResult($("applyResult"), "配置加载失败：" + e.message, false));
    setInterval(poll, 5000);
    wireFooter();
    setTimeout(() => {
      if (selected && fromPath) {
        const cell = q(`.cell[data-k="${CSS.escape(selected)}"]`, $("matrixGrid"));
        if (cell) { cell.scrollIntoView({ block: "center", behavior: "smooth" }); cell.classList.add("flash"); }
      }
    }, 350);

    window.addEventListener("hashchange", () => setView(viewFromHash(), false));
  }

  function applyTextOrNull(id, text) {
    const el = $(id);
    if (el && text != null) el.textContent = text;
  }

  boot();
})();