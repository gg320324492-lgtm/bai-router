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

  /* 超时是**必需的**：fetch 不自带超时，接口一慢（取上游目录首访能到 1.6s，
     网络不好时更久）就会无限期挂着 —— 界面于是永远停在「正在读取…」，用户分不清
     是加载慢还是已经死了。
     opt.timeoutMs 可覆盖；默认 12s：实测 /api/status 常态 0.4s、首访取目录 1.6s，
     12s 留足了余量又不至于让人干等到放弃。 */
  async function api(path, opts) {
    const o = opts || {};
    const ms = o.timeoutMs || 12000;
    try {
      const r = await fetch(path, { ...o, signal: AbortSignal.timeout(ms) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    } catch (e) {
      // 超时要能和服务故障区分开：前者是「慢」，后者是「没了」——
      // 两者都报「已停止」是把加载慢说成崩溃，用户会白重启一次。
      const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
      const err = new Error(timedOut ? `读取超时（超过 ${Math.round(ms / 1000)} 秒）` : String((e && e.message) || e));
      err.timedOut = !!timedOut;
      err.path = path;
      throw err;
    }
  }
  const postJSON = (path, body, opts) => api(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(opts || {}),
  });

  /* 令牌捕获的 POST 会**一直阻塞到捕获结束**（后端最长等 10 分钟），而 api() 的默认
     读超时只有 12 秒 —— 拿默认值去发，一次**成功**的捕获也会被掐成「读取超时」，
     而服务端还挂着钩子正常在等。用户看到的就是「明明抓到了，却报获取失败」，
     于是反复重开客户端、反复重来（实测复现的就是这个）。
     所以凡是发 /api/wb/capture 的地方，都必须显式给 timeoutMs：先问后端这次要等多久
     （/api/wb/capture/status 的 timeoutMs），再加上余量；问不到就用兜底窗口，
     宁可等久，也不误报失败。 */
  const CAP_WINDOW_FALLBACK_MS = 10 * 60 * 1000;
  const CAP_TIMEOUT_MARGIN_MS = 60 * 1000;
  const capTimeoutMs = (backendMs) => (Number(backendMs) || CAP_WINDOW_FALLBACK_MS) + CAP_TIMEOUT_MARGIN_MS;

  /* ======================================================================
   * 0b. 上游型动作的**显式**读预算（v1.0.81）
   *
   * 病根是**预算倒挂**：api() 的默认值 12 秒是给「读本机状态」那种快接口兜底的，
   * 而后端凡是打上游，一律给自己 15 秒以上的预算（zenReadCatalog 15s、
   * orFetchFreeModels 15s、wbFetchConfig 15s、探测 45s…）。上游只要用满自己那份，
   * 前端 100% 先断 —— 然后把一次**成功**报成「✘ 读取超时（超过 12 秒）」。
   * 这是同一族缺陷的**第三轮**修复（第一轮 v1.0.79 修 /api/config，第二轮 v1.0.80 修
   * /api/wb/capture，本轮一次修掉六个：/api/test、/api/models 的两个调用点、
   * /api/models/scan-all、/api/or/refresh）。
   *
   * 🔴 **不要动 api() 里的 12000。** 它是共享层的安全网：值没变/接口快时立刻返回，
   *     接口死了不会让人干等两分钟。改默认值会让所有慢接口一起失去保护。
   *     正解是**逐个调用点声明自己需要多久** —— 也就是下面这几个常量。
   *
   * 处置分两类，别一律「把 timeout 调大」糊过去：
   *   · 长到没法等、又拿得到进度出口的（测连通 ≤545s）→ 改成**提交 + 轮询**，
   *     见 testTiers()：每次读都是短的，全程有反馈，真超时也不会说成失败。
   *   · 几十秒量级、用户要的就是当场结果的（拉目录、扫六家、重查额度）→ 显式给足。
   *
   * 三个数字都写清了「后端最坏多久」的**来源**，改动 server.mjs 的上游预算时必须回来
   * 改这里；scripts/api-timeout-budget-test.mjs 会把两边的数字机械地对账。
   */
  /* GET /api/models?p= —— 拉上游实时目录。wb/wbai 最坏 45 秒，且**不是** 15 秒：
     wbCatalogAccount 可能先触发一次令牌续期（15s），wbReadCatalog 再串行拉
     CLI 形态（15s）与 App 形态（15s）——三次串行。60s = 45s + 余量。
     ⚠ 只有缓存过期后的第一次真跑满（wb/zen 目录缓存 TTL 都是 30 分钟），日常不受影响。 */
  const CATALOG_TIMEOUT_MS = 60000;
  /* POST /api/models/scan-all —— 六家 allSettled 并行，墙钟 = 最慢的那家，
     也就是上面那条 wb 的 45 秒。给同一个数字。 */
  const SCAN_ALL_TIMEOUT_MS = 60000;
  /* POST /api/or/refresh —— orFetchFreeModels(15s) 串行 orFetchQuota(12s) = 27 秒。
     45s = 27s + 余量。 */
  const OR_REFRESH_TIMEOUT_MS = 45000;

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

  /* --- 2.3b 键盘：Esc 关掉浮层；Tab / 方向键 = 键盘操作 ---
   *
   * ⚠ **Esc 关浮层**是硬要求：键盘用户打开一个弹层后，焦点被关在弹层里，
   *   而弹层只有一个「×」按钮时，Tab 出来就是一圈绕不出去的死路。
   *   弹层是「临时的」，Esc 是最自然的「我不要了」。
   *
   * ⚠ **键盘 vs 鼠标**要分清：切屏时挪焦点只对键盘用户有用
   *   （鼠标点一下导航，焦点跟着跳走反而像失灵）。 */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab" || e.key.startsWith("Arrow")) lastFocusWasKeyboard = true;
    if (e.key !== "Escape") return;
    /* 浮层优先：更新弹窗 > 通知横幅。 */
    const modal = $("updModal");
    if (modal && modal.classList.contains("show")) {
      try { closeUpdateModal(); } catch { }
      return;
    }
    const b = $("bnrInfo");
    if (b && b.classList.contains("show")) { b.classList.remove("show"); return; }
    const su = $("bnrUpdate");
    if (su && su.classList.contains("show")) { su.classList.remove("show"); return; }
    /* 输入框里按 Esc 不该关浮层（用户可能要放弃输入但保留弹层）—— 这里不处理输入框，
       上面的浮层优先级已经够了。 */
  }, true);
  document.addEventListener("mousedown", () => { lastFocusWasKeyboard = false; }, true);

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
  /* ---------- 渠道状态层（/api/channels/state）的**共享一份** ----------
   *
   * 为什么要共享：这个端点给出六态 + used/limit/ratio，总览的热力图卡、
   * 状态条卡、渠道页左栏都要它。**各自拉就是三份**——同一个端点被请求三次，
   * 而且三份数据可能来自三个时刻（同屏显示的状态对不上，就是这么来的）。
   *
   * 所以这里拉一份放进缓存，三处都从缓存读。
   * 缓存**只新鲜 5 秒**：状态层本身探上游有 5 分钟缓存，再短也没用；
   * 而 5 秒足够让轮询（也是 5 秒一轮）拿到新的一份。
   */
  let chanStates = null;         // { channels: [...] } —— 最近一次读到的
  let chanStatesAt = 0;          // 读到的时刻（ms）
  let chanStatesPending = null;  // 在途的请求（防并发重复拉）

  const CHAN_STATES_TTL_MS = 5000;

  async function loadChanStates(force) {
    const now = Date.now();
    if (!force && chanStates && now - chanStatesAt < CHAN_STATES_TTL_MS) return chanStates;
    if (chanStatesPending) return chanStatesPending;      // 已有在途的，排队等它
    chanStatesPending = (async () => {
      try {
        const r = await api("/api/channels/state");
        if (r && r.ok === false) throw new Error(r.error || "状态层读不到");
        chanStates = r || null;
        chanStatesAt = Date.now();
      } catch (e) {
        /* 读不到就**保留上一份**（可能已过期但仍是最后已知的真相），
           不把整表清空——清空会让左栏整列变成「探不到」，比显示旧值更糟。 */
        console.warn("[chanStates] 读状态层失败", e && e.message);
      } finally {
        chanStatesPending = null;
      }
      return chanStates;
    })();
    return chanStatesPending;
  }

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
  /* 逐模型能力标记（v1.0.74 T3+T6）：id → { capLabel, capHint }，**全部来自服务端探测结果**。
   * 空表 = 这一家没有能力探测（大多数渠道），下拉框外观与加这项之前逐字相同。 */
  let capByModel = Object.create(null);

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
   * 4. 视图切换（URL hash：#/console · #/channels · #/fo · #/settings · #/quota）
   *
   * 老 hash 别名：**凭据屏已并入渠道屏**（docs/ui-redesign.md §1 的关键决定），
   * 但老链接（书签、外部文档）还指向 #/cred。所以这里留一张别名表：
   * 命中别名就落到新屏去，**不 404、也不留死链**。
   *
   * ⚠ 别名只认**旧段名**这一个方向：新段名（channels）永远落到自己。
   *   反过来把 channels 指向 cred 会在下一轮再退役时又断一次。
   */
  const LEGACY_VIEW_ALIAS = { cred: "channels" };
  let currentView = (VIEWS[0] || {}).id || null;
  /* 这次是**老段名**（要走别名）吗？—— 用来决定要不要把地址栏改成新段名。 */
  let hashWasLegacy = false;
  function viewFromHash() {
    const raw = String(location.hash || "").replace(/^#\/?/, "").trim();
    const hit = VIEWS.find((v) => v && v.id === raw);
    if (hit) { hashWasLegacy = false; return hit.id; }
    /* 老段名 → 新屏。找不到对应的新屏（清单还没改完）时退回首屏，不空白。 */
    const alias = LEGACY_VIEW_ALIAS[raw];
    if (alias && VIEWS.some((v) => v && v.id === alias)) { hashWasLegacy = true; return alias; }
    hashWasLegacy = false;
    return ((VIEWS[0] || {}).id);
  }
  function viewOf(id) { return VIEWS.find((v) => v && v.id === id) || null; }

  /* 焦点是从键盘来的吗（Tab / 方向键）？—— 用来决定「切屏要不要挪焦点」。
   * 键盘用户挪焦点才有用；鼠标用户挪了反而像失灵。 */
  let lastFocusWasKeyboard = false;

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
      /* ⚠ **roving tabindex**：tablist 里只有**当前那个** tab 能被 Tab 到达，
       *   其余是 -1（用方向键移动）。这是 ARIA tab 模式的标准做法 ——
       *   否则键盘用户每换一屏都要 Tab 过六个按钮才能进内容。
       *   （鼠标不受影响：点哪个都点得着。） */
      b.setAttribute("tabindex", on ? "0" : "-1");
    }
    /* 老段名落地后**把地址栏改成新段名**：内容已经是新屏了，地址栏还挂着
       旧段名会让人以为没跳转成功（老书签、老文档里传的都是旧段名）。
       只改 hash、不加历史记录 —— 用户按「后退」该回到上一个视图，
       而不是在自己开的这一屏里来回弹。
       ⚠ 与 push 无关：老段名是「纠正一个过期的地址」，不是「切屏」，
       所以首屏加载（push=false）时也要改。 */
    if (push !== false || hashWasLegacy) {
      const want = "#/" + v.id;
      if (location.hash !== want) history.replaceState(null, "", want);
    }
    mountCardsFor(v.id);
    focusView(v.id);
  }

  /* 视图切换后把焦点送进新视图。
   *
   * ⚠ 为什么必须做：键盘用户按了「渠道」之后，焦点还留在导航栏的那颗按钮上 ——
   *   屏幕阅读器会继续念「渠道，按钮」，用户得自己 Tab 过去才知道换屏了。
   *   焦点跟着内容走，是「换屏了」这件事对键盘与读屏用户**可见**的唯一办法。
   *
   * ⚠ 焦点落在容器上（tabindex="-1"）而不是标题上：标题不是交互元素，
   *   给它加 tabindex 会让它出现在 Tab 序列里（多一个停靠点）。
   *   容器带 role="region" + aria-label，读屏软件会念出这一屏的名字。
   *
   * ⚠ 只在**键盘**操作时移动焦点：鼠标用户点导航不移动焦点，
   *   否则鼠标点一下、焦点就跳走，视觉上像是「点了没反应」。 */
  function focusView(id) {
    try {
      if (lastFocusWasKeyboard === false) return;
      const box = $("view" + id.charAt(0).toUpperCase() + id.slice(1));
      if (box && typeof box.focus === "function") box.focus({ preventScroll: true });
    } catch { /* 焦点挪不动不该影响切屏 */ }
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
      /* 凭据已作废（上游说登录态失效）：**报红并说清该做什么**。
       * 这不是「未配置」——东西曾经是好的，是被上游作废了；处置也不同
       * （要重新登录，不是第一次去配）。 */
      if (t.invalid === true) {
        return { s: "err", txt: "凭据已失效", detail: t.error || "登录态已失效，请到对应客户端重新登录" };
      }
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
      /* 自动续期型凭据（会员托管那一类）：到期**不是**问题——它会自己续。
       * 报成黄色的「剩 0 天」会让人以为要手工处理；真正要处理的是续不上，
       * 那由上面的 invalid 分支报红。 */
      if (t.autoRenew === true) {
        return { s: "ok", txt: "已就绪", detail: S.tokenHint || "令牌到期自动续期" };
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
    /* 「预期内被拒」优先于红色的「上游不可用」（v1.0.78）。
     * 这一档确实发不出消息，但对「免费档 + 直连」这个组合来说**上游本来就会拒**——
     * 报成故障会让用户去查一个根本没坏的东西（本次要修的现象：真实对话完全正常，
     * 面板却显示成红色故障）。所以走 warn 而不是 err，账上不计进「故障」那一栏。
     * 副行给的是**可执行的下一步**，不是「换个模型试试」这种猜谜式提示。 */
    if (up.expected === true) {
      const names = (up.expectedTiers || []).join("、");
      return {
        s: "warn", txt: "预期内被拒",
        detail: (names ? `（${names} 档）` : "") + (up.expectedWhy || ""),
      };
    }
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
    /* 「预期内被拒」换个前缀（v1.0.78）：这一类不是故障，写成「最近错误」会与它旁边
     * 真正需要处理的错误混成一类，用户分不出哪条该动手。措辞与归因标签保持一致。 */
    const rlPrefix = rl.kind === "free_tier_direct" ? "已知限制" : "最近错误";
    $("subRelay").textContent = fresh
      ? `${rlPrefix}·${rl.kind}: ${rl.message}`
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
    if (s.ccswitch && s.ccswitch.cli && s.ccswitch.cli.state === "taken-over") {
      bits.push("CLI 接线已被 " + (s.ccswitch.cli.writer === "ccswitch" ? "CC Switch" : "其它程序") + " 接管");
    } else if (s.ccswitch && s.ccswitch.running) bits.push("配置交还工具正在运行，它可能随时改回自己的配置");
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

  /* 左栏：渠道一览。**一行一家**——名字 + 状态药丸 + 一个用量小条。
   *
   * 为什么不再画 4×2 的矩阵格子：格子把「这家是谁」「能不能用」「映射到哪个模型」
   * 「中转口是多少」挤在一张卡里，八家排下来要滚一屏半，而其中三样在选中之后
   * 才有用。左栏只留「选谁」需要的三样，其余全进右栏（改一家不用滚）。
   *
   * 状态药丸走**服务端状态层**（/api/channels/state 的六态，与总览热力图同源），
   * 用量小条同源取 ratio —— 这样同一个渠道在总览与渠道页显示的是同一份事实，
   * 而不是两套各算各的。
   */
  function buildChanList() {
    const list = $("matrixGrid");
    if (!list) return;
    list.innerHTML = "";
    for (const key of chainOf().length ? chainOf() : CHAIN_KEYS) {
      list.appendChild(chanRowFor(key));
    }
    paintChanList();
  }

  function chanRowFor(key) {
    const P = MANIFEST[key] || {};
    const el = document.createElement("button");
    el.type = "button";
    el.className = "chan-row";
    el.dataset.k = key;
    el.innerHTML = `
      <span class="letter">${esc(P.letter || "")}</span>
      <span class="cr-name">${esc(nameOf(key))}</span>
      <span class="cr-meter" data-role="meter"></span>
      <span class="cr-state" data-role="state"></span>`;
    el.addEventListener("click", () => selectChannel(key));
    return el;
  }

  /* 左栏重画：状态药丸 + 用量小条。
   *
   * 数据来自**服务端状态层**（/api/channels/state）：六态 + used/limit/ratio。
   * 为什么不用渲染层自己算的那套（channelState）：那套只有四态、且「预算用完」
   * 与「上游不可用」都落在 err 上，跟总览的热力图对不上——同一渠道在两屏显示
   * 两种状态，正是改版原则 1（状态是数据，不是一处一处重算）要消灭的东西。
   *
   * 探不到就画「—」，**不画 0**：0 会被读成「额度用完了」。
   */
  function paintChanList() {
    const list = $("matrixGrid");
    if (!list) return;
    const byKey = {};
    for (const c of ((chanStates && chanStates.channels) || [])) {
      if (c && c.key) byKey[c.key] = c;
    }
    for (const el of qa(".chan-row", list)) {
      const key = el.dataset.k;
      if (!key) continue;
      clsx(el, key === selected, "sel");
      const c = byKey[key] || null;
      const st = c ? channelStateOf(c) : null;
      const stateBox = q('[data-role="state"]', el);
      if (stateBox) {
        stateBox.innerHTML = st
          ? `<span class="pill ${st.tone}" title="${esc(st.reason || "")}">${esc(st.text)}</span>`
          : '<span class="pill idle" title="状态探不到">探不到</span>';
      }
      const meterBox = q('[data-role="meter"]', el);
      if (meterBox) {
        /* ratio 是百分比（0–100），meter 收的是比例（0–1）——除以 100 别忘了，
         * 忘了就会画成满格（10% 显示成 1000%）。 */
        /* 未配置（unconfigured）的渠道**不画用量条**：它压根没在用，
           画一条出来会被读成「它在跑、用了多少」—— 而真相是「它还没接上」。
           这正是「探不到 ≠ 0」的同一条纪律：不画 ≠ 画 0。 */
        const notConfigured = st && st.s === "unconfigured";
        const r = !notConfigured && c && typeof c.ratio === "number" ? c.ratio : null;
        /* 阈值与额度屏一致（过 75% 转黄、过 90% 转红）：同一件事在两屏
           用同一套阈值，用户不用记两遍。 */
        const tone = r == null ? "" : (r >= 90 ? "err" : (r >= 75 ? "warn" : ""));
        meterBox.innerHTML = r == null
          ? `<span class="cr-meter-empty" title="${notConfigured ? "还没配置，不在用" : "探不到用量"}">—</span>`
          : `<span class="cr-meter-bar"><i class="cr-meter-fill ${tone}" style="width:${Math.max(0, Math.min(100, r)).toFixed(1)}%"></i></span>`;
        meterBox.title = c && c.used != null && c.limit != null
          ? `已用 ${c.used} / ${c.limit}`
          : "探不到用量";
      }
    }
  }

  /* 服务端六态 → 面板显示用的 {text, tone, reason}。
   * tone 直接复用语义色（ok/warn/err/idle），所以两屏的同一个渠道是同一个颜色。
   */
  function channelStateOf(c) {
    const s = String((c && c.state) || "unknown");
    const tone = { ok: "ok", cooling: "warn", resting: "warn", exhausted: "err", unconfigured: "idle", unknown: "idle" }[s] || "idle";
    const text = { ok: "可用", cooling: "冷却中", resting: "休息中", exhausted: "预算用完", unconfigured: "未配置", unknown: "状态不明" }[s] || "状态不明";
    return { s, tone, text, reason: String((c && c.reason) || "") };
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
      showEl($("btnProbe"), false);
      return;
    }
    showEl($("btnSave"), true); showEl($("btnTest"), true);
    showEl($("btnModels"), (P.models || []).length > 0);
    showEl($("btnResetModels"), (P.defaultModels || []).length > 0);
    /* 能力探测按钮（v1.0.74 T3+T6）：**只有清单声明 capabilityProbe 的渠道才画**。
     * 端点与判定全在服务端，渲染层既不拼 URL 也不认识渠道名（C11）。 */
    showEl($("btnProbe"), P.capabilityProbe === true);

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
        else {
          op.value = o;
          /* 能力标记挂在选项文字后面（v1.0.74）：「space-bunny-free · 探不通」比让用户
           * 点了才发现要好。标签与说明都来自服务端探测结果，这里不自己判定。 */
          const cp = capByModel[o];
          op.textContent = optText(o) + (cp && cp.capLabel ? " · " + cp.capLabel : "");
          op.title = o + (cp && cp.capHint ? "\n\n" + cp.capHint : "");
        }
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
  /* 折叠态是**一行一家**：字母 + 名字 + 凭据类型徽章 + 状态药丸 + 箭头。
     状态药丸必须住在这行里 —— 收起时也要一眼看出「哪家好了、哪家没配」，
     坏消息不许藏在展开之后（原则：不藏坏消息）。
     这一段是纯字符串函数（不碰 DOM），端到端测试可以直接在 vm 里求值它的产物，
     断言的是**结构**而不是源码文本。 */
  function credRowHtml(key) {
    const P = MANIFEST[key] || {};
    const C = P.credential || {};
    return `
      <div class="credhead" data-role="head" role="button" tabindex="0" aria-expanded="false" aria-controls="credbody-${esc(key)}">
        <span class="cl">
          <span class="letter" title="选中这一家">${esc(P.letter || "")}</span>
          <span class="clname">${esc(nameOf(key))}</span>
        </span>
        <span class="kindbadge">${esc(C.label || "凭据")}</span>
        <span class="credpill" data-role="pill"></span>
        <span class="chev" aria-hidden="true">▸</span>
        <span class="credwhy" data-role="why"></span>
      </div>
      <div class="credbody" data-role="body" id="credbody-${esc(key)}">
        <div class="ck">
          <span class="cpath">${esc(P.path || "本台交还区")}</span>
          <span class="chint">${esc(C.hint || "")}</span>
        </div>
        <div class="cs" data-role="state"></div>
        <div class="ca" data-role="act"></div>
        <div class="crow" data-role="detail"></div>
      </div>`;
  }

  /* 状态药丸：**全页唯一的一份**，措辞与颜色一律来自 credState（状态是数据，不是装饰）。
     它画在折叠的那一行里，所以行内那块（data-role="state"）只留「证据」：
     指纹、有效期、令牌文件 —— 那些要展开才看得懂的东西。 */
  function credPillHtml(st) {
    return `<span class="pill ${st.s}">${esc(st.txt)}</span>`;
  }

  /* 坏消息不许藏在收起的行后面：状态是 warn/err 时把**原因**也摆在头一行下面。
     ok 的 detail 是「证据」（指纹 / 有效期），那属于展开后的那块，不摆在这儿；
     idle（未配置）也不摆 —— 药丸本身已经写着「未配置」，再补一句凭据类型是噪声。 */
  function credWhyHtml(st) {
    if (!st) return "";
    if (st.s !== "warn" && st.s !== "err") return "";
    return st.detail ? esc(st.detail) : "";
  }

  /* 手风琴：同时只开一行。
     为什么不是各自独立：这一屏要回答的是「哪家好了、哪家没配」，
     开着的那一行就是「正在动的那一家」；多开几行又把页面撑回今天那么长
     —— 那正是这次要治的病。 */
  function toggleCredRow(row) {
    const open = !row.classList.contains("open");
    const box = $("credList");
    if (!box) return;
    for (const r of qa(".credrow", box)) {
      const on = (r === row) && open;
      r.classList.toggle("open", on);
      const h = q(".credhead", r);
      if (h) h.setAttribute("aria-expanded", String(on));
    }
  }

  function buildCredList() {
    const box = $("credList");
    if (!box) return;
    box.innerHTML = "";
    for (const key of ALL_KEYS) {
      const row = document.createElement("div");
      row.className = "credrow";
      row.dataset.k = key;
      row.innerHTML = credRowHtml(key);
      /* 字母徽章：点它仍然是「选中这一家」（旧行为，一字不改）。
         名字 / 类型 / 状态 / 箭头那一行则是「展开这一家」—— 点名字是最自然的展开动作，
         把它让给「选中」反而会让人以为点了没反应。 */
      q(".letter", row).addEventListener("click", (e) => { e.stopPropagation(); selectChannel(key); });
      const head = q(".credhead", row);
      head.addEventListener("click", () => toggleCredRow(row));
      head.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCredRow(row); }
      });
      box.appendChild(row);
    }
    /* 行内的按钮被点到时先把这一行展开：折叠状态下那些按钮是看不见的，
       脚本直接点它们时用户看到的却是「什么都没发生」。
       挂在**捕获**阶段，所以展开发生在按钮自己的处理函数之前。 */
    if (!box.dataset.expandOnAct) {
      box.dataset.expandOnAct = "1";
      box.addEventListener("click", (e) => {
        const btn = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
        if (!btn) return;
        const r = btn.closest(".credrow");
        if (r && !r.classList.contains("open")) toggleCredRow(r);
      }, true);
    }
    paintCredList();
  }

  /* 只重画**常驻的那一格**（状态药丸与它的原因），不动输入框与按钮。
   *
   * 为什么不能直接调 paintCredList：它会把行内的 innerHTML 重写一遍，而
   * apiKey 那一档的行里**有输入框** —— 每 5 秒重写一次，用户正在敲的半截 key
   * 会被抹掉。所以这里只碰药丸与原因两处。
   *
   * 为什么需要它：状态药丸是**折叠时唯一看得见的状态**（不藏坏消息），
   * 它要是停在启动那一刻的样子，「刚才还正常的渠道现在坏了」就没人看得见了。 */
  function repaintCredPills() {
    const box = $("credList");
    if (!box) return;
    for (const row of qa(".credrow", box)) {
      const key = row.dataset.k;
      if (!key) continue;
      if (hasBusyIn(row)) continue;        // 行内有动作在飞就别动它
      const st = credState(key);
      const pill = q('[data-role="pill"]', row);
      if (pill) pill.innerHTML = credPillHtml(st);
      const why = q('[data-role="why"]', row);
      if (why) why.innerHTML = credWhyHtml(st);
    }
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
      const pillBox = q('[data-role="pill"]', row);
      const whyBox = q('[data-role="why"]', row);
      clsx(row, key === selected, "sel");

      /* 药丸画在**折叠的那一行**里（收起也看得见），措辞与颜色只来自 credState。
         行内那块（data-role="state"）从此只放**证据**：指纹、有效期、令牌文件。 */
      pillBox.innerHTML = credPillHtml(st);
      whyBox.innerHTML = credWhyHtml(st);

      /* 凭据**不由用户填写**（自取型）：中转从本机的客户端登录态自取令牌。
       * 画成**只读**：没有输入框、没有「保存」——让用户去填一个用不上的密钥，
       * 只会让人以为还差一步，实际那一步在客户端里（登录）。
       * 唯一的动作是「重新读取登录态」：用户在客户端登录完，点它把新凭据捡回来。
       * 端点与按钮文案都由清单给（credentialReadonly.api / .label），渲染层不认识渠道名。
       *
       * ⚠ 这一支**排在 kind 分派之前**：自取型的性质盖过 kind 说它是哪一类
       * （kind 只决定"凭据视图给不给输入框"），顺序放错就会出现"声明了自取型却仍画输入框"。 */
      if (P.credentialReadonly && typeof P.credentialReadonly === "object") {
        const ro = P.credentialReadonly;
        stBox.innerHTML = (st.detail ? `<span class="fp zh">${esc(st.detail)}</span>` : "");
        act.innerHTML = `<button class="btn sm" type="button" data-act="reread">${esc(ro.label || "重新读取登录态")}</button>`;
      } else if (kind === "apiKey") {
        const C = cfgOf(key);
        const shown = C.apiKey ? esc(fp(C.apiKey)) : "";
        stBox.innerHTML = (shown ? `<span class="fp mono">${shown}</span>` : "");
        act.innerHTML = `<input type="password" class="keyinput" autocomplete="off" placeholder="${esc(C.hint || "")}" data-role="key">`
          + `<button class="btn sm" type="button" data-act="savekey">保存</button>`
          + `<button class="btn sm ghost" type="button" data-act="toggle">显示</button>`;
      } else if (kind === "jwt") {
        const S = stOf(key);
        const t = S.token || {};
        stBox.innerHTML = (S.edition ? `<span class="fp">版别 ${esc(S.edition)}</span>` : "")
          + (t.expAt ? `<span class="fp">有效期至 ${esc(new Date(t.expAt).toLocaleDateString("zh-CN"))}</span>` : "");
        act.innerHTML = `<button class="btn sm primary" type="button" data-act="capture">一键获取令牌</button>`
          + `<button class="btn sm ghost" type="button" data-act="manual">手动填写</button>`;
      } else if (kind === "jobToken") {
        const S = stOf(key);
        const p = S.patch || {};
        const t = S.token || {};
        /* 徽章走 credState：不能在这里写死"已读到令牌"——令牌文件还在 ≠ 还在用。
           客户端没找到时那是上一次运行留下的陈旧文件，写成"已读到"会与状态带矛盾。 */
        stBox.innerHTML = (st.detail ? `<span class="fp">${esc(st.detail)}</span>` : "")
          + (p.found && p.tokenFresh === false ? '<span class="fp">客户端没开或没发过带鉴权的请求</span>' : "")
          + (t.tokenFile ? `<span class="fp">令牌文件：${esc(t.tokenFile)}</span>` : "");
        act.innerHTML = `<button class="btn sm primary" type="button" data-act="patch" ${p.ready ? "disabled" : ""}>一键装补丁</button>`
          + `<button class="btn sm ghost" type="button" data-act="revert">还原客户端</button>`;
      } else if (kind === "keys3") {
        const t = (stOf(key).token) || {};
        const keys = Array.isArray(t.keys) ? t.keys : [];
        stBox.innerHTML = (keys.length
          ? `<span class="fp mono">${keys.map((k) => esc(k.fp) + (k.active ? ` <span class="ui-font">◂ 在用</span>` : "")).join(" · ")}</span>`
          : `<span class="fp">一把都没有</span>`);
        if (!q(".keybox", act)) {
          act.innerHTML = `<button class="btn sm" type="button" data-act="keys">编辑三把 key</button>`
            + `<button class="btn sm ghost" type="button" data-act="quota">刷新免费目录与额度</button>`;
        }
      } else {
        stBox.innerHTML = `<span class="fp">不是本台渠道</span>`;
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

  /* 「一键获取令牌」的**兜底**路径：没被卡片接管的那一行走这里。
     抠成独立函数（而不是内联在 credAction 的分支里），端到端测试才能直接复用真逻辑。
     它和卡片那条路踩的是同一个坑 —— POST 会阻塞到捕获结束（后端最长 10 分钟），
     而面板 api() 的默认读超时只有 12 秒：一次**成功**的捕获也会被掐成「读取超时」，
     服务端却还在后台正常等着钩子，用户据此以为没抓到。所以必须显式给足 timeoutMs。 */
  async function captureFallback(key, btn) {
    const slot = $("applyResult");
    let outcome = null;
    await withBusy(btn, async () => {
      /* 先问后端这次要等多久（/api/wb/capture/status 的 timeoutMs），再加余量 */
      let capMs = 0;
      try { const st = await api("/api/wb/capture/status"); capMs = Number(st && st.timeoutMs) || 0; } catch { }
      let r;
      try {
        r = await postJSON("/api/wb/capture", {}, { timeoutMs: capTimeoutMs(capMs) });
      } catch (e) {
        /* 读超时**不等于失败**：捕获在服务端后台进行，这里放弃的只是这一次 HTTP 读。
           如实说「仍在继续」，绝不说「获取失败」—— 说错会让用户白重开一遍客户端。 */
        if (e && e.timedOut) { outcome = { pending: true }; return; }
        throw e;
      }
      if (!r.ok) throw new Error(r.error || "未捕获到令牌");
      outcome = { ok: true };
    }, slot);
    await refreshConfig(); poll();
    if (outcome && outcome.pending) {
      showResult(slot, "⏳ 仍在后台等待客户端触发令牌 —— 这**不代表失败**，捕获还在继续。"
        + "请在客户端里发一条消息，稍后刷新本页查看结果。", true);
    } else if (outcome && outcome.ok) {
      showResult(slot, `✔ ${nameOf(key)} 令牌已捕获并写入配置。到期后点「一键获取令牌」重取。`, true);
    }
  }

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
      } else if (act === "reread") {
        /* 自取型凭据的「重新读取」：让中转再去本机的客户端登录态里读一遍。
         * 端点在清单里给（credentialReadonly.api）——渲染层不认识渠道名（C11）。
         * 服务端只会回**状态快照**（长度/有效期/是否有效），不会回令牌明文。 */
        const ro = P.credentialReadonly || {};
        const url = ro.api || "";
        if (!url) {
          showResult($("applyResult"), "这一行没有配置「重新读取」的接口（清单里缺 credentialReadonly.api）。", false);
          return;
        }
        await withBusy(btn, async () => {
          const r = await postJSON(url, {});
          if (r && r.error) throw new Error(r.error);
        }, $("applyResult"));
        await refreshConfig();
        poll();
        showResult($("applyResult"),
          `✔ ${nameOf(key)}：已重新读取本机登录态。`
          + "（令牌只存在内存里，页面与日志都不会显示它的明文。）", true);
      } else if (act === "capture") {
        const h = captureHandlers[key];
        if (typeof h === "function") { await h(btn); return; }   // 卡片接管（token-capture）
        await captureFallback(key, btn);
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
          <div class="keynote">保存会用这里填的三把「整体替换」现有轮换区——明文读不回来，
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
        /* 显式给足读预算（v1.0.81）：后端是 orFetchFreeModels(15s) 串行
           orFetchQuota(12s) = 最坏 27 秒 > api() 的默认 12 秒。拿默认值发，
           OpenRouter 一慢就会把一次**成功**的重查报成「读取超时」。 */
        await withBusy(btn, async () => { await postJSON("/api/or/refresh", {}, { timeoutMs: OR_REFRESH_TIMEOUT_MS }); }, $("applyResult"));
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
   * 9b. 「以为在用 A 其实在用 B」的两处呈现（v1.0.78 T9）
   *
   * 抽成两个纯函数是有原因的：这件事**必须能被测**，而 buildDiag / paintChanList
   * 那一坨闭包依赖（cfg / status / DOM）没法在 vm 里求值。这里只吃 /api/status
   * 给的那一份，输出字符串或 items 数组，渲染层只负责把它放上去。
   *
   * 两条信号来自同一件事的上下游，对用户是同一句话：
   *   · modelFallback[] —— 客户端送来的模型名查不到，被**静默回落到默认模型**
   *     （解析这一步就错了：发的 A，出去的是 B）
   *   · recent.mismatch —— 真实服务的模型（served）与我们打算路由到的（target）不是同一个
   *     （解析对了，但上游服务的不是它）
   * 处置不同，所以分开列；两条都以「你选的是 A、实际跑的是 B」这句人话开头。
   *
   * 渲染层不认识任何渠道名（C11）：渠道显示名由调用方用 nameOf 传进来；
   * 也不认识任何模型名——全是 /api/status 给的原文，本函数只做转义与排版。
   */
  function modelIdentityItems(S, name) {
    const items = [];
    const R = (S && S.recent) || null;
    const fb = (S && Array.isArray(S.modelFallback)) ? S.modelFallback : [];
    const when = (x) => (x ? new Date(x).toLocaleString("zh-CN", { hour12: false }) : "（时间未知）");
    /* 最多列三条：同一个错配反复回落也只占三行，面板不会被刷屏淹没。 */
    for (const f of fb.slice(0, 3)) {
      const tail = Number(f.count) > 1 ? `（累计 ${f.count} 次，最近一次 ${when(f.lastAt)}）` : `（${when(f.lastAt)}）`;
      items.push({
        s: "err",
        t: `${name}：你发的模型名「${f.requested}」查不到，已被回落到「${f.landed}」${tail}`,
        m: "模型名在本渠道的映射表和可用清单里都查不到时，本路由台会**静默**改用它的默认模型——"
          + "请求照样成功，所以从结果上看不出任何异常，而这正是「以为在用 A 其实在用 B」。\n"
          + "常见两种成因：① 客户端指向了别家的中转口，却发着别家的模型名；"
          + "② 这一档在本渠道没配目标模型。\n"
          + "怎么办：到该渠道卡的「档位映射」里把这一档的目标模型选对，"
          + "或者把客户端指回它自己该用的中转口。",
      });
    }
    /* 两个判据都要满足才报警：服务端标了 mismatch，**且**两个名字确实不同。
     * 只信 mismatch 的话，一旦那份状态自相矛盾（mismatch=true 但两个名字一样），
     * 面板就会打印「你以为在用 x，实际服务的是 x」——那正是本节要消灭的那类假话。 */
    if (R && R.tier && R.served && R.served !== R.target && R.mismatch === true) {
      const who = R.label && R.label !== R.tier ? `（界面显示名 ${R.label}）` : "";
      items.push({
        s: "err",
        t: `${name}：你以为在用「${R.target}」，实际服务的是「${R.served}」`,
        m: `正在用的档位是 ${R.tier}${who}。我们打算路由到「${R.target}」（档位映射里配的那个），`
          + `但真实服务的是「${R.served}」——两个都摆出来，是因为这正是要看见的那件事。\n`
          + `最后一次这样的请求：${when(R.observedAt)}。`,
      });
    }
    return items;
  }

  /** 矩阵格「档位映射」里，正在用的那一档旁边补一句**真实服务的模型**。
   *  只在 served 与 target 不一致时出现——正常路径一个字都不加（与改动前逐字一致）。 */
  function servedNote(R) {
    /* 判据与 modelIdentityItems 里那一条**完全相同**：服务端标了 mismatch，
       且两个名字确实不同。只信前者的话，一份自相矛盾的状态会让矩阵格显示
       「实际服务 x」而它旁边就是同一个 x。 */
    if (!R || !R.tier || R.mismatch !== true || !R.served || R.served === R.target) return "";
    return `<i class="serveddiff" title="我们打算路由到：${esc(R.target)}（档位映射里配的那个）；`
      + `实际服务的是：${esc(R.served)}。两者不一致，所以两个都摆出来。">实际服务 ${esc(R.served)}</i>`;
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
      /* 档位不可用（v1.0.74 T4）：**优先于**「上游连不上」与「最近一次失败」——
       * 那些信号此刻全都在指错方向。用户点一次发送看到一句 FreeTierError，
       * 面板其余部分却一片正常（凭据就绪、上游可达），下次他多半会以为是网络抖动。
       * 真正的原因是「这一档用不了」，且它是账号级的、持续到用户去订阅为止，
       * 所以必须常驻在这里，而不是绑在 30 分钟新鲜的 relayLast 上。 */
      if (S.goSubRequired === true) {
        items.push({ s: "err", t: `${nameOf(key)} 当前是 ${S.tierLabel || "Go 档"}，但账号还没订阅`, m: S.tierHint || "" });
        continue;
      }
      if (P.tierBadge === true && S.tierLabel) {
        /* 两档可用性完全不同：即便此刻通着，也得让用户知道自己站在哪一档上——
         * 免费档随时可能因为上游改规则而失效，Go 档随时可能因为没订阅而失效。
         * 已确认「需订阅」的情形走上面那条 err 项，不在这里重复报。 */
        items.push({
          s: "warn", t: `${nameOf(key)} 当前档位：${S.tierLabel}`,
          m: (S.tierHint || "") + (P.remedy ? "\n\n" + P.remedy : ""),
        });
        continue;
      }
      /* 令牌归属不符：**最高优先级**，排在"上游连不上"之前。
       * 这类错配其它信号全都指错方向——版别判定读的是本版登录文件（对的），
       * 令牌取自 config.json（历史遗留的另一版令牌，没人核对），
       * 而"能拉到 N 个模型"也证明不了什么：/v3/config 不校验令牌。
       * 结果面板一片正常，实际每次请求都被上游网关 401。 */
      const own = (S.token || {}).ownership || null;
      if (own && own.state === "mismatch") {
        /* 去哪一版重抓由清单给（counterpart），渲染层不写死渠道名——C11 就是管这个的。 */
        const cpKey = P.counterpart || "";
        const cp = cpKey ? MANIFEST[cpKey] : null;
        items.push({
          s: "err",
          t: `${nameOf(key)} 装的是另一个账号的令牌`,
          m: `配置里的令牌自称属于账号 ${own.tokenSub}…，`
            + `而本版登录文件（${own.authFile}）里的账号是 ${own.authUid}…——两者对不上。\n`
            + `这个渠道的每次请求都会被上游网关拒绝（401），但面板此前看不出来：`
            + `版别判定读的是本版登录文件、判出来是对的；"能拉到模型列表"也证明不了什么，`
            + `因为模型目录接口根本不校验令牌。\n`
            + (cp ? `怎么办：打开「${cp.shortName || cp.name || cpKey}」客户端，到本页点「一键获取令牌」重新抓一次`
                   + `（两版登录文件不同，别抓错版）。` : `怎么办：到本页点「一键获取令牌」重新抓一次。`),
        });
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

    /* ③b 模型身份（v1.0.78 T9）：「你以为在用 A，实际跑的是 B」。
     *
     * 单独一轮而不是塞进 ③ 的优先级链：③ 那一串 continue 是"每家只报最要紧的那一条"，
     * 而模型身份错配与凭据错配是**两件独立的事**，都成立时都得看得见。
     * 判定本身在 modelIdentityItems 里（纯函数，可测）。 */
    for (const key of chainOf().length ? chainOf() : CHAIN_KEYS) {
      const items2 = modelIdentityItems(stOf(key), nameOf(key));
      for (const it of items2) items.push(it);
    }

    /* ④ 交还区：分「只是它在跑」和「它已经把配置换掉了」两档。
     * 此前只有前者，而那是个弱信号——它挂着不动也算「在跑」。真正要紧的是后者：
     * 我们写进 ~/.claude/settings.json 的东西没了，CLI 实际连的是别处，
     * 而面板此前对此**完全沉默**（cliMode 只认端口/域名，CC Switch 走 direct 模式
     * 写自己的 https 上游时落到 mode:"other"，看不出是谁接管的）。 */
    {
      const cc = (status && status.ccswitch) || null;
      const own = (cc && cc.cli) || null;
      const when = (x) => (x ? new Date(x).toLocaleString("zh-CN", { hour12: false }) : "（时间未知）");
      if (own && own.state === "taken-over") {
        const who = own.writer === "ccswitch" ? "CC Switch" : "别的程序（或手动编辑）";
        items.push({
          s: "err",
          t: "CLI 接线已被 " + who + " 接管",
          m: "本路由台于 " + when(own.at) + " 写进 ~/.claude/settings.json 的配置，"
            + "在 " + when(own.writtenAt) + " 被换掉了。\n"
            + "现在 CLI 实际连的是：" + (own.currentBaseUrl || "（空）") + "\n"
            + "判据：" + (own.evidence || "") + "\n"
            + "要让本路由台重新接管：随便点一张渠道卡的「接通」，或在交还工具里把供应商切回来。",
        });
      } else if (cc && cc.running) {
        items.push({ s: "warn", t: "配置交还工具正在运行", m: "它的接线目前还是本路由台的，但它随时可能改回去。想让它退场：点「一键最优」或从任意渠道接通。" });
      }
    }

    /* ④b WorkBuddy 换模记录。
     *
     * 这件事此前**面板上完全看不见**，而且藏错了地方：换模走的是 noteRelayError，
     * 于是显示成「最近一次请求失败（rate_limit_quota）」——而请求明明拿到了 200。
     * 抽屉只呈现「当前已知问题」，换模成功的多数不是问题；但下面两种情况是：
     *   ① 换到了**付费档**（跟钱有关，用户该知道自己在烧积分）
     *   ② 半小时内刚换过（说明这个模型正在被限流，马上还会再换）
     * 超过这些窗口的就不占版面了——那属于历史，不是当前状况。
     *
     * v1.0.67 的 bug：①用的是**整段历史里有没有过**（服务端扫全部 20 条、无时间边界），
     * 于是换过一次付费档之后那个黄灯会一直挂着，直到再攒够 20 次才消失。现在服务端
     * 报 escalatedAt（最近一次的时间），新鲜度在这里按窗口判——「多久算当前」是呈现
     * 层的判断，不该由服务端一个无期限的布尔替它做主。 */
    {
      const rot = (status && status.wbRotation) || null;
      const when = (x) => (x ? new Date(x).toLocaleString("zh-CN", { hour12: false }) : "（时间未知）");
      const recent = rot && Array.isArray(rot.recent) ? rot.recent : [];
      if (recent.length) {
        const last = recent[0];
        const ageMin = (Date.now() - new Date(last.at).getTime()) / 60000;
        /* 付费档的提醒窗口比普通换模长得多：花钱这件事，用户隔一天回来看也该知道。
         * 但也不能无限——一周前的一次换模不该再挂黄灯。 */
        const paidMin = rot.escalatedAt ? (Date.now() - new Date(rot.escalatedAt).getTime()) / 60000 : Infinity;
        const paid = paidMin < 24 * 60;
        const fresh = ageMin < 30;
        if (paid || fresh) {
          const rateTxt = (e) => (e.free === true ? "免费" : e.credits ? String(e.credits) : "倍率未知");
          const lines = recent.slice(0, 4).map((e) => {
            const jump = e.steps > 1 ? `（连换 ${e.steps} 次）` : "";
            return `${when(e.at)}  ${e.from} → ${e.to}  ${rateTxt(e)}${e.recovered ? "" : "  ✗ 最终没成功"}${jump}`;
          });
          const whenAg = (mins) => (mins < 60 ? `${Math.round(mins)} 分钟前`
            : mins < 24 * 60 ? `${Math.round(mins / 60)} 小时前`
            : `${Math.round(mins / 1440)} 天前`);
          items.push({
            s: paid ? "warn" : "idle",
            t: paid
              ? `有请求被换到了付费模型（${whenAg(paidMin)}，本次会话共 ${rot.total} 次换模）`
              : `WorkBuddy 换过模（本次会话共 ${rot.total} 次，最近一次在 ${whenAg(ageMin)}）`,
            m: "触发原因：上游返回频率限制。换模是兜底手段，请求本身仍然成功——"
              + "所以它不是故障，此前却显示成「最近一次请求失败」。\n"
              + (paid ? "注意：换过去的是要消耗积分的档位，下面这几条请过一眼。\n" : "")
              + lines.join("\n"),
          });
        }
      }
    }

    /* ④c 静默换人（v1.0.88）。
     *
     * 「你选的是 A，实际回答你的是 B」这条必须有两个落点：故障转移视图顶部（大块、
     * 不折叠），以及**这里**——诊断抽屉是用户不进故障转移视图时的默认去处，
     * 只做一个落点就等于默认看不见。
     *
     * 语气分两档，判据只有一条：实际服务的那家是不是**计费**渠道（badge.kind 为
     * paid/cn），而入口那家是免费的（free/intl）。是 → err（扣钱，红）；否 → warn。
     * 数据一律来自 /api/status 的 failover.silentJump，服务端只记事实、不定价，
     * 所以这里报的是「换了谁」而不是替上游报价。 */
    {
      const sj = (status && status.failover && status.failover.silentJump) || null;
      const act = sj && Array.isArray(sj.active) ? sj.active.filter((e) => e && e.from && e.to && e.from !== e.to) : [];
      if (act.length) {
        const kindOf = (k) => (((MANIFEST[k] || {}).badge) || {}).kind || "";
        const money = act.some((e) => ["paid", "cn"].includes(kindOf(e.to)) && ["free", "intl"].includes(kindOf(e.from)));
        const wmin = sj.windowMin > 1 ? Math.round(sj.windowMin / 60) : 1;
        const whenAg = (iso) => {
          const m = (Date.now() - Date.parse(iso || "")) / 60000;
          if (!isFinite(m)) return "时间未知";
          if (m < 1) return "刚刚";
          if (m < 60) return `${Math.round(m)} 分钟前`;
          if (m < 1440) return `${Math.round(m / 60)} 小时前`;
          return `${Math.round(m / 1440)} 天前`;
        };
        const lines = act.slice(0, 4).map((e) => {
          const n = `${nameOf(e.from)} → ${nameOf(e.to)}`;
          const cnt = e.count > 0 ? `最近 ${wmin} 小时 ${e.count} 次` : "最近 1 小时内没有";
          return `${whenAg(e.lastAt)}　${n}　${cnt}（累计 ${e.total} 次）${e.model ? `　模型 ${e.model}` : ""}`;
        });
        const top = act[0];
        items.push({
          s: money ? "err" : "warn",
          t: money
            ? `你选的渠道没有回答你，${nameOf(top.to)} 在替你回答（并且要计费）`
            : `你选的渠道没有回答你，${nameOf(top.to)} 正在替它回答`,
          m: `自动故障转移开着的时候，${nameOf(top.from)} 一失败就由下一家接手，请求照样成功——`
            + "所以界面看不出任何异常，但回答你的已经不是你选的那家了。\n"
            + (money ? "注意：接手的那家是计费渠道，上面这些对话记在它的账上。\n" : "")
            + lines.join("\n")
            + `\n要停掉：进「故障转移」视图，把后面那几家从顺序里删掉，或关掉自动故障转移。`,
        });
      }
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

  /* 「测试连通」的轮询节奏与放弃条件（v1.0.81）。 */
  const TEST_POLL_MS = 2000;
  /* 12 分钟 > 后端最坏 545 秒（45s×3 重试 ×4 档串行 + 档间 1.5s）。给足一倍余量，
     免得慢机器上刚要收工就被前端放弃。⚠ 到点了**也不说失败** —— 探测还在服务端跑着，
     说「失败」正是本次要消灭的那类假报。 */
  const TEST_WAIT_LIMIT_MS = 12 * 60 * 1000;

  /* 等这一家的探测跑完，返回 /api/status 里那一份 upstream。
   *
   * 为什么必须轮询而不是延长 timeout：一次探测最坏 9 分钟。用一个大 timeout 去等它，
   * 用户全程毫无反馈，而且**真超了还是假失败**——与改之前一模一样。
   * 轮询的每一次读都只有几毫秒（/api/status 是纯本地组包 + 9 秒内的本机探测；
   * 实测空载 p50≈315ms、探测在跑时最大 1311ms），12 秒的默认值绰绰有余，
   * 所以**不去动它、也不给这个调用点加 timeoutMs**（加了会让
   * api-timeout-budget-test 的「快接口不许被加预算」当场变红，而那是有意的纪律）。
   * 真遇到慢机器读被掐断也不慌：下面按「读失败」如实说，不冒充「正在排队」。
   */
  async function waitTestDone(P, slot) {
    const t0 = Date.now();
    /* 最近一次**真的读到过**的那份 upstream。读失败时用它兜底 ——
       「这一轮没读到」不等于「探测不在跑」，把前者当成后者就会把一次还在跑着的
       探测说成「正在排队」，而用户恰恰分不出这两者，只能一直干等。 */
    let lastUp = null;
    for (;;) {
      let s = null;
      /* 单次读失败（服务重启中/某一轮慢）**不等于探测失败**：下一轮再说。
         这里若 throw，外层 withBusy 会把一次还在正常跑的探测写成一坨红字。 */
      try { s = await api("/api/status"); } catch { /* 下一轮 */ }
      /* ⚠ 必须读**刚拿到的这一份** s。原来读的是模块级 stOf(P) —— 那是 poll() 五秒前的
         旧状态，而 s 就在手边：poll 一旦没跟上（刚进页面、或某一轮它自己失败），
         就等于**拿到了新状态却去读旧的**，running 恒读到 false，一次好端端跑着的
         探测被一轮轮地说成「正在排队/发起探测」。这正是实测复现的那句文案。 */
      if (s) lastUp = sliceOf(s, P).upstream || {};
      const up = lastUp || {};
      const secs = Math.round((Date.now() - t0) / 1000);
      if (up.running) {
        showResult(slot, `⏳ 正在逐档探测…（已 ${secs}s）\n`
          + "上游慢的时候这一下最长可能几分钟（勾了「测全部四档」会更久）。探测在服务端跑着，"
          + "面板不会掐断它，也不用刷新页面。", true);
        await new Promise((r) => setTimeout(r, TEST_POLL_MS));
        continue;
      }
      /* 跑完了。⚠ 不能只看 running===false：POST 返回时探测可能已经结束（本地中转很快），
         那时 running 压根没被观测到 true，那样会读到**上一次**的残留结果。
         所以还要看 at 不早于本次发起（t0 之前 1 秒内不算旧账）。 */
      if (up.at && Date.parse(up.at) >= t0 - 1000) return up;
      if (Date.now() - t0 > TEST_WAIT_LIMIT_MS) return null;
      /* 没读到 s 时**不许说「正在排队」** —— 排队/发起探测是**后端**的状态，
         我们这一轮压根没问到后端，就没有依据说它在排队。读超时也不是失败：
         探测在服务端照跑，如实说「没读到、稍后重试」，下一轮读到了自己就接上。 */
      showResult(slot, s
        ? `⏳ 正在排队/发起探测…（已 ${secs}s）`
        : `⏳ 这一轮没读到本机状态（已 ${secs}s），稍后重试。\n`
          + "探测在服务端跑着，面板不会掐断它，也不用刷新页面。", true);
      await new Promise((r) => setTimeout(r, TEST_POLL_MS));
    }
  }

  async function testTiers() {
    const all = has("ckAllTiers") && $("ckAllTiers").checked;
    const P = selected;
    const slot = $("testResult");
    /* v1.0.81：POST 立刻回包（后端把探测丢后台了），这里轮 /api/status 取结果。
       这一步超时不会「误报失败」：读的是本机状态，不是上游。 */
    const r = await postJSON("/api/test", all ? { provider: P, all: true } : { provider: P });
    if (r.alreadyRunning) showResult(slot, "⏳ 这一家已经在探测了，接着等它跑完…", true);
    const up = await waitTestDone(P, slot);
    /* 放弃等待 ≠ 失败：探测仍在服务端跑，结果会由 5 秒轮询的 /api/status 正常显示。
       如实说「还在跑」，绝不说「失败」——与 v1.0.79/80 同一个纪律。 */
    if (!up) {
      showResult(slot, "⏳ 探测仍在服务端继续（已等满 12 分钟），**这不是失败**。\n"
        + "结果出来后会由状态轮询自动显示，也可以点上面的「刷新」重看。", true);
      return;
    }
    const tiers = up.tiers || [];
    const single = !!up.active && !all;
    const lines = tiers.map((t) => {
      const who = single ? "当前使用：" : (TIER_ZH[t.tier] || t.tier) + "：";
      return t.ok ? `✔ ${who}${t.label} · ${t.ms}ms` : `✘ ${who}${t.label} · 失败：${t.error}`;
    });
    const tail = single ? "" : "（最近 30 分钟没观察到真实对话流量，已测全部四档）";
    showResult(slot, lines.join("\n") + (tail ? "\n" + tail : ""), !!up.ok);
  }

  /* 目录来源徽标：**常驻**在映射编辑区上方。
   *
   * 为什么要常驻而不是刷新时闪一句 showInfo：出处决定这份目录**该不该信**——
   * 实时目录是上游当下的样子，落盘是上一次成功的快照（可能已经过期很久），
   * 内置兜底则是写死在代码里的出厂值、可信度最低。v1.0.71 实测踩过这个：
   * 我直连 /v3/config 拿到 37 个模型（其中没有 step-5-preview），而项目走
   * wbReadCatalog 拿到的是 33 个的另一份——**同一渠道、两份目录、内容不一致**。
   * 当时无法判断该信哪一份，正是因为面板上没写这份目录从哪来。 */
  const CATALOG_SOURCE = {
    live: { txt: "实时目录", hint: "刚从上游拉取，反映它此刻的样子" },
    disk: { txt: "上次成功的目录", hint: "这次没能连上上游，用的是上一次拉到的快照——可能已经过期" },
    builtin: { txt: "内置兜底目录", hint: "既没连上上游、也没有历史快照，用的是写死在代码里的出厂值，可信度最低" },
  };
  function paintCatalogSource(r) {
    const el = $("catSource");
    if (!el) return;
    /* 档位前缀（v1.0.74 T4）：两档的目录是两回事（免费档 83 个 / Go 档 38 个），
     * 而免费档列出的模型**一个都调不通**（上游 403 FreeTierError）。所以这份目录
     * 属于哪一档，比它有多少个模型重要得多——必须写在最前面。 */
    const tierLabel = r && r.tierLabel ? String(r.tierLabel) : "";
    const tierHtml = tierLabel
      ? `<b class="${r.goSubRequired ? "warn" : ""}">${esc(tierLabel)}</b>`
        + (r.goSubRequired ? '<b class="warn"> · 需订阅</b>' : "") + `<span class="dim"> · </span>`
      : "";
    const s = (r && r.source) || null;
    const meta = s ? (CATALOG_SOURCE[s] || { txt: s, hint: "来源未知" }) : null;
    /* 能力检测出处（v1.0.74 T3+T6）：**上次检测时间必须常驻**。
     * 结论会过期——上游随时可能加围栏或恢复额度，用户看到「可用 · 支持工具」
     * 时有权知道那是几分钟前测的、还是三天前的。文案由服务端算好，这里不拼。 */
    const capHtml = r && r.capAtLabel
      ? `<span class="dim"> · 上次检测 ${esc(r.capAtLabel)}${r.capStale ? "（上游已改，这份作废）" : ""}</span>`
      : (r && r.capHint ? `<span class="dim"> · ${esc(r.capHint)}</span>` : "");
    if (!meta) {
      /* 分两种「没有 source」：这家渠道压根不报出处（sn/qd/or 的目录来自各自
       * 的接口，没有「实时/快照/兜底」这一说），还是确实没拉过。
       * 混为一谈就会把「这条渠道不适用」说成「你没拉」，误导人去点没用的按钮。 */
      const n = r && Array.isArray(r.models) ? r.models.length : null;
      if (n == null) {
        el.className = "catsrc dim";
        el.innerHTML = tierHtml + "模型目录：未拉取过，点「刷新模型列表」获取";
        el.title = "";
      } else {
        el.className = "catsrc";
        el.innerHTML = `模型目录：${tierHtml}<b class="ok">已加载</b><span class="dim">（${n} 个 · 该渠道的目录每次都直接取，不分实时与快照）</span>${capHtml}`;
        el.title = (r && r.note) || "";
      }
      return;
    }
    /* ★ v1.0.78 T8：**这份目录是哪个账号的**（⑤）。
     * `/v3/config` 是带着某一枚账号的令牌抓回来的，那份清单和其中的倍率**本身就是
     * 账号权限的事实**——多账号时不标出账号，用户看到的就是一份「不知道该信几分」的价。
     * 只显示服务端给的**不可逆指纹 + 用户自己起的标签**，渲染层永远不接触凭据。
     * 单账号（synthetic）或压根没账号时**一个字都不加**——池化对老用户是纯增量，
     * 徽标与改动前逐字一致。 */
    const sa = r && r.sourceAccount && r.sourceAccount.fp && !r.sourceAccount.synthetic
      ? r.sourceAccount : null;
    const acctHtml = sa
      ? `<span class="dim"> · 取自账号 <b>${esc(String(sa.label || ""))}</b>（指纹 ${esc(String(sa.fp))}）</span>`
      : "";
    // disk / builtin 都不是上游当下的样子，标成需留意，别让它看起来和实时目录一样可信
    el.innerHTML = `模型目录：${tierHtml}<b class="${s === "live" ? "ok" : "warn"}">${meta.txt}</b>`
      + `<span class="dim">（${r.count || 0} 个${r.catalogAt ? " · 拉取于 " + new Date(r.catalogAt).toLocaleString("zh-CN", { hour12: false }) : ""}）</span>${acctHtml}${capHtml}`;
    el.title = (r && r.tierHint ? r.tierHint + "\n\n" : "") + meta.hint
      + (sa ? "\n\n这份目录与其中的积分倍率属于账号「" + String(sa.label || "") + "」（指纹 " + String(sa.fp) + "）："
        + "不同账号可见的模型与倍率可能不同，换账号后会重新拉一份。"
        + "判死/停用的账号，它的目录缓存会被一并作废。" : "")
      + (r && r.capHint ? "\n\n" + r.capHint : "") + (r && r.note ? "\n\n" + r.note : "");
    el.className = "catsrc";
  }

  async function refreshModels() {
    const P = MANIFEST[selected] || {};
    /* ★ v1.0.81：这一步过去吃 api() 的默认 12 秒，而后端拉目录最坏 45 秒（wb）——
       同一个按钮的**后面**一步（POST /api/config 写 availableModels）v1.0.79 已经修过，
       **前面**这一步没修，所以那个按钮至今仍可能假报失败。这里显式给 CATALOG_TIMEOUT_MS。 */
    const r = await api("/api/models?p=" + selected, { timeoutMs: CATALOG_TIMEOUT_MS });
    /* 逐模型能力标记（v1.0.74 T3+T6）：**文案全部来自服务端**，渲染层只按 id 取来显示，
     * 因此不需要认识任何渠道名（C11）。没有 capLabel 的渠道（非探测类）这张表就是空的，
     * 下拉框外观与改动前逐字相同。 */
    capByModel = Object.create(null);
    for (const m of (Array.isArray(r.all) ? r.all : [])) if (m && m.key && m.capLabel) capByModel[m.key] = m;
    const C = cfgOf(selected);
    const curTargets = TIERS
      .map((t) => String(((C.mapping || {})[t.key] || {}).target || "").toLowerCase())
      .filter(Boolean);
    const merged = [...new Set([...(r.models || []), ...curTargets])];
    await postJSON("/api/config", { provider: selected, availableModels: merged });
    await refreshConfig();
    refreshCards();
    showResult($("testResult"), `✔ ${nameOf(selected)} 已拉取模型 ${r.count} 个\n下拉框已更新（映射目标强制保留）`, true);
    paintCatalogSource(r);
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

  /* 能力探测（v1.0.74 T3+T6）：对免费模型逐个发真实请求，取代那份已被实测推翻的
   * 出厂白名单。文案与判定**全部来自服务端**——这里只负责显示，
   * 不复制判定逻辑，也因此不认识任何渠道名（C11）。
   *
   * 超时给足：并发 2、每个 10 秒、免费模型最多十来个，最坏一轮要一分多钟。
   * api() 默认 12 秒会中途掐断，那会让用户以为探测失败——其实是前端自己放弃了。 */
  async function runCapabilityProbe() {
    const slot = $("testResult");
    showResult(slot, "正在逐个探测免费模型（只探免费模型、并发 2、每个最多 10 秒）…", true);
    const r = await api("/api/models/probe-zen", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      timeoutMs: 300000,
    });
    const lines = [`✔ ${r.summary || "探测完成"}`, `检出时间：${r.atLabel || ""}`];
    const models = r.models || {};
    for (const id of Object.keys(models).sort()) {
      const rec = models[id];
      lines.push(`· ${id} — ${rec.label}` + (rec.why ? `（${rec.why}）` : ""));
    }
    showResult(slot, lines.join("\n"), true);
    // 重拉一次目录，让下拉框与出处徽章立刻带上新的能力标记
    await refreshModels();
    showResult(slot, lines.join("\n"), true);
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
    paintChanList();
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
    /* 「正在读…」持续多久就说多久。骨架态下顶栏只剩一个 `—`，看起来和"没响应"
       一模一样；超过 5 秒就明说是慢、以及卡在哪一步，用户不用干等着猜。 */
    const slowTimer = setTimeout(() => {
      /* 只看「本次 poll 还没回来」，**不看** status 有没有旧值。
       * 原来判的是 !status —— 首次加载才有提示，之后每轮 poll 因为 status 早已有值而
       * 永远不提示。可慢提示最该出现的恰恰是后者：界面还挂着**旧**数据，这次又没刷上来，
       * 用户分不清"这就是最新的"还是"卡住了"。 */
      const el = $("statusSentence");
      if (el) el.textContent = status
        ? "正在刷新本机状态…已超过 5 秒（页面显示的仍是上一次的结果）。多半是某个上游接口慢"
        : "仍在读取本机状态…已超过 5 秒。本机实测约需 0.5 秒，若长时间不动多半是某个上游接口慢（点「诊断抽屉」可看）";
      const svc = $("svc");
      if (svc) svc.innerHTML = status ? '服务 <b class="off">…</b> 刷新中' : '服务 <b class="off">…</b> 读取中';
    }, 5000);
    try {
      const s = await api("/api/status");
      status = s;
      /* 状态层与状态带**并行**拉：它俩互不依赖，串行会把首屏多等一个来回。
         拉完再画左栏（药丸与用量条都出自它）。 */
      await loadChanStates();
      if (!selected) { pickInitial(s); applySelectionUi(); loadCatalogSource(); }
      paintBand(s);
      paintBadges(s);
      paintChanList();
      repaintCredPills();
      buildDiag();
      renderSys();
      for (const c of cards) {
        try { if (c.update) c.update(s, cfg); } catch (e) { console.warn("[card] " + c.name, e); }
      }
    } catch (e) {
      /* 超时 ≠ 服务已停。原来这里是裸 catch，一律画成「已停止」——把「慢」说成
         「崩溃」，用户会照着提示去重启一次，而重启解决不了一个慢接口。 */
      if (e && e.timedOut) {
        const el = $("statusSentence");
        // e.message 已经是「读取超时（超过 12 秒）」，不要再套一层造成「读取超时（读取超时…」
        if (el) el.textContent = `${e.message}。服务可能仍在运行，只是某个接口没响应——先别急着重启，等下一轮轮询或点「诊断抽屉」`;
        const svc = $("svc");
        if (svc) svc.innerHTML = '服务 <b class="off">…</b> 读取超时';
        setLed($("ledRelay"), "warn", true);
        const txt = $("txtRelay");
        if (txt) txt.textContent = "读取超时";
      } else {
        const el = $("svc");
        if (el) el.innerHTML = `服务 <b class="off">○</b> 已停止`;
        setLed($("ledRelay"), "err", false);
        const txt = $("txtRelay");
        if (txt) txt.textContent = "已停止";
        const sent = $("statusSentence");
        if (sent) sent.textContent = "连不上本机服务（" + String((e && e.message) || e) + "）";
      }
    } finally {
      clearTimeout(slowTimer);
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
    paintChanList();
    paintChanHead();
    paintCredList();
    buildDiag();
  }

  /* 右栏抬头：**这一家是谁** + 一眼要到的三样（徽章 / 档位 / 中转口）。
   *
   * 为什么抬头要有中转口：改一家的时候最常问的是「我改的是哪一路」——
   * 端口不在眼前的话，改错一路的概率不低（八家各有各的端口）。
   */
  function paintChanHead() {
    const box = $("chanHead");
    if (!box) return;
    const key = selected;
    if (!key) { box.innerHTML = ""; return; }
    const P = MANIFEST[key] || {};
    const S = stOf(key);
    const C = cfgOf(key);
    const badge = P.badge || {};
    const bits = [];
    /* 档位徽章（v1.0.74 T4）：只有清单声明 tierBadge 的渠道才有。
       两档可用性完全不同（免费档被封 / Go 档需订阅），不显著标出来用户就
       不知道自己站在哪一档上。档位本身来自 /api/status，渲染层不认渠道名（C11）。 */
    if (P.tierBadge === true && S.tierLabel) {
      const needSub = S.goSubRequired === true;
      const cls = needSub ? "err" : (S.tier === "go" ? "ok" : "warn");
      bits.push(`<span class="chh-tier tb ${cls}" title="${esc(S.tierHint || "")}">`
        + `${needSub ? "需订阅 Go" : esc(S.tierLabel)}</span>`);
    }
    if (P.caveat) {
      bits.push(`<span class="chh-caveat" title="${esc(P.caveat)}">⚠ ${esc(P.caveat)}</span>`);
    }
    const relay = (P.chainable === true) ? (C.relayPort || "—") : "—";
    /* 「接通这家」按钮：4×2 矩阵退役后，矩阵格子里那个「一键接入 X」按钮
       没了宿主 —— 不补回来的话，用户就没有「只接通这一家」的办法了
       （状态带上的「一键最优」是另一回事：它自己挑一家，不问你选谁）。 */
    const canApply = P.chainable === true;
    const st = canApply ? channelState(key) : null;
    box.innerHTML = `
      <div class="chh-main">
        <span class="letter">${esc(P.letter || "")}</span>
        <span class="chh-name">${esc(nameOf(key))}</span>
        ${badge.text ? `<span class="cbadge ${esc(badge.kind || "neutral")}">${esc(badge.text)}</span>` : ""}
        ${bits.join("")}
        <span class="chh-relay" title="这一路的中转端口">中转 :${esc(relay)}</span>
        ${canApply
          ? `<button class="btn sm primary chh-apply" type="button" data-act="apply" ${st && st.s === "idle" ? "disabled" : ""}>${esc(primaryText(key))}</button>`
          : `<button class="btn sm chh-apply" type="button" data-act="restore">接回 ${esc(nameOf(key))}</button>`}
      </div>
      <div class="chh-sub">${esc(P.tagline || "")}</div>`;
    const btn = q("button[data-act]", box);
    if (btn) btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.dataset.act === "apply") applyChannel(key);
      else restoreExternal();
    });
  }

  /* 让选中那家的凭据行是**展开**的。
   *
   * 为什么右栏只显示这一家：左栏已经是一列渠道（名字 + 状态药丸 + 用量条），
   * 那是手风琴「收起时也看得见状态」的活儿 —— 两边都列八家就是同一份信息
   * 出现两次（改版原则 1 要消灭的正是这个）。右栏只留「选中那家的凭据细节」。
   *
   * ⚠ 九行**都留在 DOM 里**，只有非选中那家被隐藏：卡片（令牌捕获 / 模型目录 /
   *   轮换区）是按 credential.kind 认领行的，隐藏掉行会让它们没有宿主。
   */
  function openSelectedCredRow(key) {
    const row = q(`.credrow[data-k="${CSS.escape(key)}"]`, $("credList"));
    if (row && !row.classList.contains("open")) toggleCredRow(row);
  }

  function selectChannel(key) {
    if (!MANIFEST[key]) return;
    selected = key;
    clearDirtyInputs();      // 换渠道 = 换一份配置，未保存的半截字不带过去
    applySelectionUi();
    openSelectedCredRow(key);
    const row = q(`.chan-row[data-k="${CSS.escape(key)}"]`, $("matrixGrid"));
    if (row) {
      row.classList.add("flash");
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    refreshCards();
    /* 换渠道时也把目录出处拉一次。不能只在点「刷新模型列表」后才显示出处——
     * 那正是最需要它的时刻（判断这份目录能不能信）却恰恰看不到。走缓存，不打上游。 */
    loadCatalogSource();
  }

  /* 只取目录信息、不动配置与下拉：切渠道/首次进入时用来画出处徽标。 */
  async function loadCatalogSource() {
    const key = selected;
    if (!key) return;
    try {
      /* 同一个上游型接口、同一个预算（v1.0.81）：这里失败只 console.warn、界面停在
         旧徽标上，所以过去没人注意它也在吃 12 秒。改成显式 60s 是为了**别让冷缓存的
         首次进入**把徽标悄悄留成上一次的样子 —— 留旧徽标比说「没拉过」轻，但也会骗人。 */
      const r = await api("/api/models?p=" + key, { timeoutMs: CATALOG_TIMEOUT_MS });
      if (selected !== key) return;   // 期间又切了渠道，丢弃这次结果
      paintCatalogSource(r);
    } catch (e) {
      /* 取不到就留着上一次显示的，不覆盖成误导性的「未拉取过」——
         但要留下痕迹：这个静默曾经把「出处一直不显示」藏了很久。 */
      console.warn("[catSource] 取目录出处失败", e && e.message);
    }
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
    /* 页脚版本号改从 /api/status 的 service 取，不再单走 /api/version——
     * 多带出「这份代码跑在哪、是安装版还是源码构建」。
     *
     * 为什么值得占一行：已安装版与源码构建共用同一个单实例锁，后启动的那个**静默退出**，
     * 面板由先跑的那个继续服务，两边看着都正常。v1.0.67 实测就栽在这儿——源码实例被
     * 已安装版挤掉，之后所有请求都打在旧版上，页脚却只是「v1.0.64」，
     * 不刻意去比对根本发现不了。鼠标悬停给出完整脚本路径，那才是决定性证据。 */
    if (has("verTxt")) {
      api("/api/status").then((s) => {
        const sv = (s && s.service) || {};
        if (!sv.version) return;
        const isSrc = sv.build === "source";
        $("verTxt").textContent = "v" + sv.version + (isSrc ? " · 源码" : " · 安装版");
        $("verTxt").title = "正在服务本面板的进程：\n" + (sv.script || "(未知)")
          + "\nPID " + (sv.pid || "?") + " · 已运行 " + (sv.uptimeSec || 0) + " 秒";
      }).catch(() => { });
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
    /* 发 /api/wb/capture 必用的读超时（后端捕获窗口 + 余量）。卡片自己也有兜底实现，
       这里给出来是为了**只有一处定义**这个数字，两条路径不会各算各的。 */
    capTimeoutMs,
    /* 上游型动作的显式读预算（v1.0.81）。卡片自己调 /api/models/scan-all 也要给足，
       数字**只在这里定义一次** —— 两边各写各的，改了一边就会重新出现预算倒挂。 */
    CATALOG_TIMEOUT_MS, SCAN_ALL_TIMEOUT_MS, OR_REFRESH_TIMEOUT_MS,
    $, q, qa, api, postJSON, showInfo, showResult, setLed, withBusy, poll, refreshConfig,
    renderRoute, selectChannel, setView, fp, registerCapture,
    /* 渠道状态层的**共享读法**（见上面 loadChanStates 的注释）：
       卡片改读它，三处共用一份数据，而不是各自拉同一个端点。 */
    loadChanStates,
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
      /* ⚠ **方向键在 tablist 里移动**（ARIA tab 模式的标准键盘行为）：
       *   ← → 换屏、Home/End 跳首尾。
       *   配合 roving tabindex（只有当前 tab 在 Tab 序列里），键盘用户
       *   才能既快又不错位地换屏。 */
      b.addEventListener("keydown", (e) => {
        if (!e) return;
        const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
        if (keys.indexOf(e.key) < 0) return;
        const all = qa("#navViews [data-view]");
        if (!all.length) return;
        const i = all.indexOf(b);
        let j = i;
        if (e.key === "ArrowLeft") j = (i - 1 + all.length) % all.length;
        else if (e.key === "ArrowRight") j = (i + 1) % all.length;
        else if (e.key === "Home") j = 0;
        else j = all.length - 1;
        if (e.preventDefault) e.preventDefault();     // 别让方向键去滚页面
        const next = all[j];
        if (!next) return;
        next.focus();
        setView(next.getAttribute("data-view"));
      });
    }
    onClick("btnBest", applyBest);
    onClick("btnRestore2", () => withBusy($("btnRestore2"), restoreExternal, $("applyResult")));
    onClick("btnRestore", () => withBusy($("btnRestore"), restoreExternal, $("applyResult")));
    onClick("btnSave", () => withBusy($("btnSave"), saveMapping, $("testResult")));
    onClick("btnTest", () => withBusy($("btnTest"), testTiers, $("testResult")));
    onClick("btnModels", () => withBusy($("btnModels"), refreshModels, $("testResult")));
    onClick("btnResetModels", () => withBusy($("btnResetModels"), resetModels, $("sysResult")));
    onClick("btnProbe", () => withBusy($("btnProbe"), runCapabilityProbe, $("testResult")));
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
    buildChanList();
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
        const row = q(`.chan-row[data-k="${CSS.escape(selected)}"]`, $("matrixGrid"));
        if (row) { row.scrollIntoView({ block: "center", behavior: "smooth" }); row.classList.add("flash"); }
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