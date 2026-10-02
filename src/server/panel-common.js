/* panel-common.js —— 五个提供方页面（bai / sn / wb / zen / qd）共用的渲染层。
 *
 * 由来：此前五页各带一份内联 <script>，约 2600 行、54–70% 逐字重复，而且已经漂移
 * （qd/zen 把 badge 的 mine 写成了 "wb"、sn 页的 keyMatch 字段各家不同、提示条里
 * 「接在别的渠道上」连本页自己的 mode 也算进去了……）。本文件是唯一一份渲染实现，
 * 各家差异全部从 window.BAI_PROVIDERS（providers.js 清单）读。
 *
 * 页面结构：provider.html 是唯一模板，只有外壳 + 插槽；本文件负责把清单里的文案
 * 与结构填进去，并把通用交互（信号灯 / 徽章 / 提示条 / 路由表 / 设置卡 / 两步引导 /
 * 主题 / 窗口控制 / 折叠卡 / 页脚 / 横幅 / 底栏 / 备用升级）全部接上。
 *
 * 各家专属（token-capture / model-catalog / failover）不在这里，由 cards/*.js 经
 * 下面的 mountCards() 挂到 #slot-extra；它们造出来的元素（#cardTok / #tokStat /
 * #tokToggle / #btnSaveTok …）共享层一律不再接管（存在即接 + 卡先挂载）。
 *
 * 启动顺序：pathname → key → 注入清单文案与结构 → 挂载 extraCards → 接线 → 轮询。
 */
(() => {
  if (document.panelCommonReady) return;
  document.panelCommonReady = 1;

  /* ======================================================================
   * 0. 基础工具（自包含，不依赖任何页面内联脚本的全局）
   * ==================================================================== */
  const $ = (id) => document.getElementById(id);
  const has = (id) => !!$(id);
  const q = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clsx = (el, on, name) => { if (el) el.classList.toggle(name, !!on); };
  const showEl = (el, on) => { if (el) el.style.display = on ? "" : "none"; };

  async function api(path, opts) {
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  const postJSON = (path, body) => api(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  function setLed(el, state, pulse) {
    if (!el) return;
    el.className = "led " + state + (pulse ? " pulse" : "");
  }

  /* ======================================================================
   * 1. 常量表：档位名与 mode 标签是固定领域名词，不随各家变
   * ==================================================================== */
  const TIERS = [
    { key: "claude-fable-5", zh: "Fable · 最强" },
    { key: "claude-sonnet-5", zh: "Sonnet · 均衡" },
    { key: "claude-opus-5", zh: "Opus · 重型" },
    { key: "claude-haiku-4-5", zh: "Haiku · 快速" },
  ];
  const TIER_ZH = {
    "claude-fable-5": "Fable", "claude-sonnet-5": "Sonnet",
    "claude-opus-5": "Opus", "claude-haiku-4-5": "Haiku",
  };
  const MODE_TXT = { ccswitch: "CC SWITCH", other: "其他", unknown: "未知" };

  /* 本路由台自家提供的渠道。此前每页各自硬编码一份"还有别的端接在谁身上"的判断，
   * 结果各漏一部分（sn 页漏了 zen/qd，wb/zen/qd 三页都只列了 bai+sn）——第五家一加
   * 进来就又漂移。收口到这里。 */
  window.BAI_OURS = ["bai", "sn", "wb", "zen", "qd"];
  window.baiIsOurs = (m) => window.BAI_OURS.includes(m);
  /* 本页该拿哪个 keyMatch 字段来比对自己的凭据（此前各页都写死成 keyMatchWb） */
  window.baiKeyMatchField = (provider) => ({
    bai: "keyMatch", sn: "keyMatchSn", wb: "keyMatchWb", zen: "keyMatchZen", qd: "keyMatchQd",
  }[provider] || "keyMatch");

  /* ======================================================================
   * 2. 保留区：更新横幅 / 底栏三按钮 / 备用升级 / 停止服务
   *    （与重构前逐字一致，拆出来是因为它与"当前是哪个提供方"无关）
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

  /* --- 2.3 内嵌通知横幅（showInfo，五页共用） --- */
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
    b.classList.add("show");
    $("bnrUpdSelf").style.display = "none";
    $("bnrUpdGo").style.display = "none";
    $("bnrUpdLater").style.display = "none";
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
  if (has("bnrUpdGo") && !window.baiDesktop) $("bnrUpdGo").onclick = () => window.baiDesktop && window.baiDesktop.installUpdate();

  if (has("stopBtn")) {
    $("stopBtn").addEventListener("click", () => {
      if (window.baiDesktop) {
        if (confirm("退出软件？退出后中转停止，B.AI 模式下的桌面版 Claude 会断线。")) window.baiDesktop.quit();
        return;
      }
      if (!confirm("停止服务后中转 15722 也会停止，桌面版/CLI 若在 B.AI 模式会立即断线。确定停止？")) return;
      api("/api/service/stop", { method: "POST" }).finally(() => {
        document.body.innerHTML = '<div style="font-family:sans-serif;color:#8b8e9a;padding:40px;text-align:center">服务已停止。重新双击「B.AI 路由台」图标即可恢复。</div>';
      });
    });
  }

  /* --- 2.6 桌面壳 / 浏览器 的页脚按钮差异 + 更新状态渲染 --- */
  if (window.baiDesktop) {
    if (has("stopBtn")) $("stopBtn").textContent = "退出软件";
    if (has("updBtn")) $("updBtn").style.display = "";
    if (has("btnSelfUpd")) $("btnSelfUpd").style.display = "";

    // 旧副本提示（v1.0.29）：正从手工副本运行、正式版在别处且更新
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

    const paintUpdate = (st) => {
      const b = $("bnrUpdate");
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
          : ((st.msg || "未知错误") + " —— 多为 Clash 节点抖动：开/换节点后点「重试」，或直接点「备用升级」（走路由台下载通道，通常更稳）。"));
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
    };

    window.baiDesktop.onAppEvent((ev) => {
      if (ev && ev.kind === "update") paintUpdate(ev.state);
    });
    if (has("bnrUpdGo")) $("bnrUpdGo").onclick = () => window.baiDesktop.installUpdate();
  }

  /* ======================================================================
   * 3. 定位当前提供方
   * ==================================================================== */
  const MANIFEST = window.BAI_PROVIDERS || {};
  const normPath = (p) => (p || "/").replace(/\/+$/, "") || "/";
  const here = normPath(location.pathname);
  let KEY = null;
  for (const k in MANIFEST) {
    if (MANIFEST[k] && normPath(MANIFEST[k].path) === here) { KEY = k; break; }
  }
  const P = KEY ? (MANIFEST[KEY] || {}) : null;

  /* 过渡期兜底：只保留区生效，两种情况 ——
     1) 清单里没有当前路径（providers.js 还没这个提供方）
     2) 页面不是新模板（没有 #slot-extra 插槽，说明还是旧的 ui/sn/wb/zen/qd.html，
        它们各自带内联 <script>，共享渲染层再跑一遍会双重绑定） */
  if (!P || !has("slot-extra")) {
    console.warn("[panel-common] " + here + " 不是新模板（无 #slot-extra），只启用保留区");
    return;
  }
  P.key = P.key || KEY;
  const key = P.key;
  const C = P.cred || {};                    // 凭据灯文案（可选）

  /* 简称：清单未给 shortName 时，从灯名反推（"Zen 中转" → "Zen"） */
  const SHORT = P.shortName || String((P.lampNames && P.lampNames.relay) || "")
    .replace(/\s*中转$/, "") || P.tab || key;

  /* 徽章文字：清单 badgeText 优先，否则 tab 大写；zen 的 tab 是 "OpenCode Zen"，
     旧页徽章写的是 "ZEN"，故这里补一张小表（补进 providers.js 的 badgeText 后可删）。 */
  const BADGE_FALLBACK = { zen: "ZEN" };
  for (const k in MANIFEST) {
    const t = MANIFEST[k].tab || k;
    MODE_TXT[k] = MANIFEST[k].badgeText || BADGE_FALLBACK[k] || t.toUpperCase();
  }

  /* /api/config 的形状：bai 在顶层，其余四家在同名子对象 */
  const sliceOf = (c, p) => (p === "bai" ? (c || {}) : ((c || {})[p] || {}));
  /* /api/status 的形状：bai 的 relay/upstream/recent 在顶层，其余在同名子对象 */
  const stOf = (s) => (key === "bai" ? (s || {}) : ((s || {})[key] || {}));

  let cfg = null, status = null, busy = false, cards = [];
  const slice = () => sliceOf(cfg, key);
  const st = () => stOf(status);

  /* 清单未提供、但旧页面上有、且无法由其它字段推出的少量文案/数据。
     每条都注明来源页；providers.js 补上同名字段后会自动优先用清单的值。 */
  const FB = {
    bai: {
      brands: { qwen: "Qwen", glm: "GLM", deepseek: "DeepSeek", hy: "HY", mimo: "MiMo", kimi: "Kimi", minimax: "MiniMax" },
      labelSuffix: " 1M",
      noCallHint: "尚未观察到 Claude Code 调用",
      testNote: {
        single: "（测试的就是你 Claude Code 里显示的那个模型，名字完全一致）",
        all: "（最近 30 分钟没观察到真实对话流量，已测全部四档；在 Claude Code 发条消息后再点，会自动对准当前档位）",
      },
      modelsRefreshMsg: "✔ 已拉取上游模型目录 {count} 个\n已更新可选模型列表（四个映射目标强制保留）",
      eventTitles: { check: "检查更新 / 部署" },
      sys: { proxy: true, panelPort: true, proxyDetect: true, useProxyRow: false },
    },
    sn: {
      brands: { sensenova: "SenseNova", deepseek: "DeepSeek", glm: "GLM", kimi: "Kimi", neo: "Neo", u: "U" },
      testNote: { all: "（最近 30 分钟没观察到真实对话流量，已测全部四档；SenseNova 有 TPM 限流，429 稍候再测即可）" },
      modelsRefreshMsg: "✔ 已拉取可对话模型 {count} 个（图像模型已自动排除）\n下拉框已更新（映射目标强制保留）",
    },
    wb: {
      brands: { deepseek: "DeepSeek", hy: "Hy", glm: "GLM", kimi: "Kimi", qwen: "Qwen" },
      defaultModels: ["deepseek-v4.1-flash", "hy4-preview-f", "hy3"],
      applyInfoMsg: "现在可以在 Claude Code 的模型菜单里选择 WorkBuddy 的三款免费模型了。",
      resetModelsMsg: "✔ 已恢复为三款免费模型：{list}",
      step1Hint: "请先完成第 1 步「一键获取令牌」。",
    },
    zen: {
      brands: { deepseek: "DeepSeek", hy: "Hy", glm: "GLM", kimi: "Kimi", qwen: "Qwen" },
      // 原先抄的是 WorkBuddy 的三款（deepseek-v4.1-flash/hy4-preview-f/hy3）——
      // Zen 免费档里唯一能外部调用的是 space-bunny-free。
      defaultModels: ["space-bunny-free"],
      cred: { txtOk: "已配置", subOk: "在下方「Zen 设置」管理", subNone: "在下方「Zen 设置」填 oc_sk_ 密钥" },
      sys: { apiKey: true },
      applyInfoMsg: "现在可以在 Claude Code 的模型菜单里选择 Zen 的免费模型了。",
      resetModelsMsg: "✔ 已恢复为 Zen 免费模型：{list}",
      step1Hint: "请先完成第 1 步：在下方「Zen 设置」填入 API Key 并保存。",
    },
    qd: {
      brands: { lite: "Qoder Lite", auto: "Qoder Auto" },
      defaultModels: ["lite", "auto"],
      cred: { kind: "file", txtOk: "已就绪", subOk: "随 Qoder 启动自动轮换", txtNone: "未读到", subNone: "请启动 Qoder 桌面端", preview: "jt-…（已就绪）" },
      sys: { tokenView: true },
      applyInfoMsg: "现在可以在 Claude Code 的模型菜单里选择 Qoder 的模型了。",
      resetModelsMsg: "✔ 已恢复为 Qoder 默认模型：{list}",
      step1Hint: "请先完成第 1 步：启动 Qoder 桌面端并保持运行（令牌会自动写入 %TEMP%/qoder-token.json）。",
    },
  }[key] || {};

  /* 清单优先，其次兜底表 */
  const opt = (name) => (P[name] != null ? P[name] : FB[name]);
  const DEFAULT_MODELS = opt("defaultModels") || [];
  const BRANDS = opt("brands") || {};
  const LABEL_SUFFIX = opt("labelSuffix") || "";
  const CRED = Object.assign({}, FB.cred || {}, C);

  const GUIDE = Array.isArray(P.guide) ? P.guide : [];
  const HAS_GUIDE = GUIDE.length > 0;
  const primaryBtn = P.primaryBtn || `${P.accentLabel || "接通"} ${SHORT}`;

  /* {btn} → primaryBtn（清单里所有提示条都这么写） */
  const fill = (tpl, vars) => String(tpl == null ? "" : tpl)
    .replace(/\{btn\}/g, primaryBtn)
    .replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m));

  /* ======================================================================
   * 4. 静态文案 + 结构注入：把清单里的文本位与专属区块填进模板
   * ==================================================================== */
  function applyText(id, text, html) {
    const el = $(id);
    if (!el) return null;
    if (text == null) return el;                       // null = 本页没有这块，调用方决定去留
    if (html) el.innerHTML = text; else el.textContent = text;
    return el;
  }

  function buildRouteKey() {
    const rk = P.routeKey;
    const slot = $("slot-route");
    if (!slot || !rk) return;
    slot.innerHTML = `
      <div class="keyrow">
        <span class="k">${esc(rk.label || "")}</span>
        <input type="password" id="apiKey" autocomplete="off" placeholder="${esc(rk.placeholder || "")}">
        <button class="btn-sm" id="keyToggle" type="button">显示</button>
      </div>`;
  }

  function buildSysExtras() {
    const slot = $("slot-sys");
    if (!slot) return;
    const S = FB.sys || {};
    if (S.proxy || S.panelPort || S.proxyDetect) {
      const g = document.createElement("div");
      g.className = "grid2";
      g.innerHTML = `
        <div class="fld"><label for="fProxy">本地代理（出海通道，留空=直连/TUN）</label><input type="text" id="fProxy" placeholder="http://127.0.0.1:7890 / 7897 / 留空直连"></div>
        ${S.proxyDetect ? '<button class="btn-sm" id="btnProxyDetect" type="button" style="align-self:end">自动检测代理</button>' : ""}
        ${S.panelPort ? '<div class="fld"><label for="fPanelPort">面板端口</label><input type="text" id="fPanelPort" placeholder="15723"></div>' : ""}`;
      slot.appendChild(g);
    }
    if (S.tokenView) {
      const d = document.createElement("div");
      d.className = "fld";
      d.innerHTML = `<label for="fTokenView">令牌（jt-…）</label><input type="text" id="fTokenView" readonly placeholder="启动 ${esc(SHORT)} 后自动读取" style="font-family:var(--mono);opacity:.75">`;
      slot.appendChild(d);
    }
    /* 凭据手填框（Zen 的 oc_sk_…）：标题取清单里凭据灯的名字，括注与占位符取副行
       第一个词（"oc_sk_… 密钥" → oc_sk_…），造好挪进 .grid2 排在上游地址前面。 */
    if (S.apiKey) {
      const credName = (P.lampNames && P.lampNames.cred) || "API Key";
      const credHint = String((P.lampSubs && P.lampSubs.cred) || "").split(/\s+/)[0] || "";
      const d = document.createElement("div");
      d.className = "fld";
      d.innerHTML = `<label for="fApiKey">${esc(credName)}${credHint ? "（" + esc(credHint) + "）" : ""}</label>`
        + `<input type="password" id="fApiKey" placeholder="${esc(credHint)}">`;
      slot.appendChild(d);
      const g2 = q("#cardSys .grid2") || q(".card .grid2");
      if (g2) g2.prepend(d);
    }
  }

  /* 没有两步引导的页面（B.AI / SenseNova）：把引导卡里的主按钮、两端勾选框与
     #applyResult 搬进接线卡，还原旧页面「接通 X / 接回 CC Switch / 终端·桌面版」
     一行排布，而不是白留一张空卡。 */
  function relocateApplyRow() {
    const guide = q(".card.guide");
    if (!guide) return;
    if (HAS_GUIDE) return;
    const actions = q("#btnRestore") && $("btnRestore").closest(".actions");
    const body = actions && actions.parentNode;
    const step2 = $("step2");
    const act = step2 && q(".stepAct", step2);
    const apply = $("btnApply");
    const checks = act && act.querySelector(".checks");
    if (actions && apply) {
      apply.textContent = primaryBtn;
      $("btnRestore").before(apply);
      if (checks) $("btnRestore").after(checks);
    }
    const res = $("applyResult");
    if (body && res) body.appendChild(res);
    guide.style.display = "none";
  }

  function applyManifest() {
    /* 4.0 data-provider（provider.html 的引导脚本已设，这里只兜底） */
    const root = document.documentElement;
    if (!root.getAttribute("data-provider")) root.setAttribute("data-provider", key);
    if (document.body && !document.body.getAttribute("data-provider")) {
      document.body.setAttribute("data-provider", key);
    }

    /* 4.1 标题 */
    if (P.title) document.title = P.title;
    applyText("h1Text", P.h1);
    applyText("h1Sub", P.sub);

    /* 4.2 导航 tab 高亮（模板里写死的那份 .active 不保险，按 data-key 重算） */
    for (const a of document.querySelectorAll(".prov-tab")) {
      const k = a.dataset ? a.dataset.key : null;
      if (k) clsx(a, k === key, "active");
    }

    /* 4.3 两步引导 */
    if (has("btnApply")) $("btnApply").textContent = primaryBtn;
    if (HAS_GUIDE) {
      applyText("eyebGuide", P.guideEyebrow);
      applyText("ttlGuide", P.guideTitle);
      for (let i = 0; i < 2; i++) {
        const g = GUIDE[i];
        if (!g) continue;
        applyText("ttlStep" + (i + 1), g.title, true);
        applyText("descStep" + (i + 1), g.desc, true);
      }
      /* 第 1 步自带按钮的页面（WorkBuddy）：按钮文案来自 guide[0].act，
         点击逻辑由 token-capture 卡接（它按 #btnCapture 找）。 */
      const act = GUIDE[0] && GUIDE[0].act;
      const slot = $("slot-step1");
      if (act && slot) {
        slot.innerHTML = `<button class="btn-main" id="btnCapture">${esc(act)}</button><span class="stepHint" id="hint1"></span>`;
      }
    }
    relocateApplyRow();

    /* 4.4 接线卡 */
    applyText("eyebPatch", P.cardEyebrow);
    const ph = $("patchHint");
    if (ph) {
      if (P.wireHint) ph.innerHTML = P.wireHint; else ph.style.display = "none";
    }

    /* 4.5 路由表 */
    applyText("eyebRoute", P.routeEyebrow);
    applyText("ttlRoute", P.routeTitle);
    applyText("thTarget", P.targetName ? "→ " + P.targetName : null);
    const rh = $("routeHint");
    if (rh) { if (P.hint) rh.innerHTML = P.hint; else rh.style.display = "none"; }
    buildRouteKey();

    /* 4.6 设置卡 */
    applyText("eyebSys", P.settingsEyebrow);
    applyText("ttlSys", P.settingsTitle);
    applyText("sysAux", P.settingsAux);
    const SL = P.settingsLabels || {};
    const bridge = /协议桥/.test(String((P.lampSubs && P.lampSubs.relay) || ""));
    applyText("lblUpstream", SL.upstream || `上游地址（${bridge ? "OpenAI 协议，内置桥翻译" : "Anthropic 兼容"}）`);
    applyText("lblRelayPort", SL.relayPort || `${key === "bai" ? "" : SHORT + " "}中转端口`);
    const upRow = $("useProxyRow");
    if (upRow) {
      const on = (FB.sys || {}).useProxyRow !== false;
      showEl(upRow, on);
      if (on) applyText("useProxyText", P.useProxyText || `让 ${SHORT} 也走本机代理（默认直连；仅当直连被拦时开启）`);
    }
    buildSysExtras();
    /* B.AI 独有「部署到本机…」；「恢复默认模型」只有清单给了默认清单的页面才有 */
    showEl($("btnDeploy"), !!((FB.sys || {}).deploy || key === "bai"));
    showEl($("btnResetModels"), DEFAULT_MODELS.length > 0);
    /* 「刷新模型列表」只有 B.AI / SenseNova 真有可拉的实时目录：wb 的模型清单随客户端
       product config 下发（无接口），zen/qd 各自有专属目录卡（model-catalog）。清单里
       没有字段能区分这两组——它们在其它字段上完全一致——故按 key 判定。 */
    showEl($("btnModels"), key === "bai" || key === "sn");

    /* 4.7 页脚 */
    if (has("footPaths")) {
      $("footPaths").textContent = window.baiDesktop
        ? (P.footNote || "")
        : (P.footNoteAlt || "");
    }
  }

  /* ======================================================================
   * 5. 信号灯：模板给三盏固定容器（relay/upstream/cred），clash / cc 由这里造，
   *    造完按清单 lamps 的顺序摆进 .lamps 栅格里
   * ==================================================================== */
  const LAMP_DEFS = {
    relay: { box: "lampRelay", name: "nameRelay", led: "ledRelay", txt: "txtRelay", sub: "subRelay" },
    upstream: { box: "lampUp", name: "nameUp", led: "ledUp", txt: "txtUp", sub: "subUp" },
    cred: { box: "lampTok", name: "nameTok", led: "ledTok", txt: "txtTok", sub: "subTok" },
    cc: { led: "ledCc", txt: "txtCc", sub: "subCc" },
    ccswitch: { led: "ledCc", txt: "txtCc", sub: "subCc" },
    clash: { led: "ledClash", txt: "txtClash", sub: "subClash" },
  };
  const lampList = () => (Array.isArray(P.lamps) && P.lamps.length ? P.lamps : ["relay", "upstream", "cred"]);

  function ensureLamp(id) {
    const d = LAMP_DEFS[id];
    if (!d) return null;
    if (d.box && $(d.box)) return $(d.box);
    if ($(d.led)) return $(d.led).closest(".lamp");
    const wrap = document.createElement("div");
    wrap.className = "lamp";
    wrap.dataset.lamp = id;
    const nm = document.createElement("div");
    nm.className = "name";
    nm.textContent = (P.lampNames && P.lampNames[id]) || "";
    const val = document.createElement("div");
    val.className = "val";
    const led = document.createElement("span");
    led.className = "led"; led.id = d.led;
    const txt = document.createElement("span");
    txt.id = d.txt; txt.textContent = "—";
    val.append(led, txt);
    const sub = document.createElement("div");
    sub.className = "sub"; sub.id = d.sub; sub.title = "";
    if (P.lampSubs && P.lampSubs[id] != null) sub.textContent = P.lampSubs[id];
    wrap.append(nm, val, sub);
    /* 先在插槽里造（模板给的插槽是官方构造点），再挪进 .lamps 栅格 */
    const slot = $("slot-lamps") || q(".lamps");
    if (slot) slot.appendChild(wrap);
    return wrap;
  }

  function buildLamps() {
    const grid = q(".lamps");
    const want = lampList().map((id) => (id === "ccswitch" ? "cc" : id));
    const boxes = {};
    for (const id of want) {
      const el = ensureLamp(id);
      if (!el) continue;
      boxes[id] = el;
      const d = LAMP_DEFS[id];
      const nm = el.querySelector(".name");
      if (nm && P.lampNames && P.lampNames[id]) nm.textContent = P.lampNames[id];
      const sub = $(d.sub);
      if (sub && P.lampSubs && P.lampSubs[id] != null) sub.textContent = P.lampSubs[id];
    }
    if (grid) for (const id of want) if (boxes[id]) grid.appendChild(boxes[id]);   // appendChild 即移动，按清单顺序排
    /* 清单没点名的固定容器藏起来（B.AI / SenseNova 没有凭据灯） */
    for (const id in LAMP_DEFS) {
      const b = LAMP_DEFS[id].box && $(LAMP_DEFS[id].box);
      if (b) showEl(b, want.includes(id));
    }
  }

  function paintRelay(s, S) {
    const relay = S.relay || {};
    setLed($("ledRelay"), relay && relay.up ? "g pulse" : "r");
    $("txtRelay").textContent = relay && relay.up ? "运行中" : "已停止";
    const rl = S.relayLast || {};
    const fresh = rl.at && Date.now() - new Date(rl.at).getTime() < 30 * 60000;
    /* 没有最近错误时，副行显示「:端口 → ……」；尾巴取清单 lampSubs.relay 里
       冒号端口之后的那截（sn 是「→ 上游」，wb/zen/qd 多一层「协议桥」）。 */
    let tail = "";
    const t0 = String((P.lampSubs && P.lampSubs.relay) || "");
    const m = t0.match(/^:\s*\d+/);
    if (m) tail = t0.slice(m[0].length);
    $("subRelay").textContent = fresh ? `最近错误·${rl.kind}: ${rl.message}` : ":" + (relay.port || "—") + tail;
    $("subRelay").title = fresh ? `${rl.at}\n${rl.message}` : "";
  }
  function paintUpstream(s, S) {
    const up = S.upstream || {};
    if (S.recent && S.recent.tier) {
      const fresh = S.recent.observedAt && (Date.now() - new Date(S.recent.observedAt).getTime() < 30 * 60000);
      if (up.tested === true) { setLed($("ledUp"), "g"); $("txtUp").textContent = `${up.model} ${up.ms}ms`; }
      else if (up.tested === false) { setLed($("ledUp"), "r"); $("txtUp").textContent = "测试失败"; }
      else { setLed($("ledUp"), fresh ? "g" : "a"); $("txtUp").textContent = fresh ? "正常" : "待测试"; }
      $("subUp").textContent = fresh
        ? `使用中: ${S.recent.label}${LABEL_SUFFIX}`
        : (up.error || opt("noCallHint") || "尚未观察到 Claude 调用");
    } else {
      setLed($("ledUp"), up.tested === true ? "g" : up.tested === false ? "r" : "a");
      $("txtUp").textContent = up.tested === true ? `正常 ${up.ms}ms` : up.tested === false ? "失败" : "未测试";
      $("subUp").textContent = up.tested === true ? (up.model || "") : (up.error || "点「测试连通」检查");
    }
  }
  function paintCred(s, S) {
    const t = S.token || {};
    const ready = typeof t.configured === "boolean" ? t.configured : S.keyConfigured === true;
    const days = t.expiresInDays;
    if (!ready) {
      setLed($("ledTok"), "r");
      $("txtTok").textContent = CRED.txtNone || "未配置";
      $("subTok").textContent = CRED.subNone || (P.settingsTitle ? `在下方「${P.settingsTitle}」里填` : "");
    } else if (days != null && days <= 7) {
      setLed($("ledTok"), "a pulse");
      $("txtTok").textContent = `剩 ${days} 天`;
      $("subTok").textContent = t.hasRefresh ? "将自动续期" : (CRED.subNoRefresh || "无刷新令牌，到期需重新捕获");
    } else {
      setLed($("ledTok"), "g");
      $("txtTok").textContent = days != null ? `剩 ${days} 天` : (CRED.txtOk || "已配置");
      $("subTok").textContent = t.expAt
        ? "有效期至 " + new Date(t.expAt).toLocaleDateString("zh-CN")
        : (CRED.subOk || "");
    }
  }
  function paintCc(s) {
    setLed($("ledCc"), s.ccswitch && s.ccswitch.running ? "a" : "g");
    $("txtCc").textContent = s.ccswitch && s.ccswitch.running ? "运行中" : "未运行";
  }
  function paintClash(s) {
    setLed($("ledClash"), s.clash && s.clash.alive ? "g" : "r");
    $("txtClash").textContent = s.clash && s.clash.alive ? "正常" : "不可用";
    $("subClash").textContent = (s.clash && s.clash.alive)
      ? `${s.proxy || "直连"} · ${s.clash.ms}ms`
      : "未检测到可用通道（点下方「检测」自动寻找）";
  }
  const LAMP_PAINTERS = {
    relay: paintRelay, upstream: paintUpstream, cred: paintCred, cc: paintCc, ccswitch: paintCc, clash: paintClash,
  };
  const activeLamps = () => lampList().map((id) => (id === "ccswitch" ? "cc" : id)).filter((id) => LAMP_DEFS[id]);

  /* ======================================================================
   * 6. renderStatus：服务灯 + 信号灯 + 接线徽章 + 提示条
   * ==================================================================== */
  function paintBadges(s) {
    const paint = (el, m) => {
      if (!el || !m) return;
      const mine = m.mode === key;
      el.className = "badge " + (mine ? "mine" : m.mode === "unknown" ? "unk" : "other");
      el.textContent = MODE_TXT[m.mode] || m.mode;
      el.title = m.baseUrl || "";
      const patch = el === $("cliBadge") ? $("patchCli") : $("patchDesk");
      if (!patch) return;
      clsx(patch, mine, "state-mine");
      clsx(patch, !mine && (window.baiIsOurs(m.mode) || m.mode === "ccswitch"), "state-other");
      /* 实际生效的凭据指纹：与本页不一致时标红（中转是透传客户端那把 key） */
      let kf = patch.querySelector(".keyfp");
      if (m.keyFp) {
        if (!kf) {
          kf = document.createElement("span");
          kf.className = "keyfp";
          patch.querySelector(".who").appendChild(kf);
        }
        const ok = !mine || m[window.baiKeyMatchField(key)] !== false;
        kf.textContent = (ok ? "🔑" : "⚠️") + m.keyFp;
        kf.style.color = ok ? "var(--dim)" : "var(--err)";
        kf.title = mine
          ? (ok
            ? `此端实际使用的凭据：${m.keyFp}（与本页一致）`
            : `此端凭据(${m.keyFp}) 与本页凭据不一致！重开对应终端/桌面版，或重新点「${primaryBtn}」。`)
          : `此端实际使用的凭据：${m.keyFp}（未接 ${SHORT}，本页不比对）`;
        kf.style.display = "";
      } else if (kf) kf.style.display = "none";
    };
    paint($("cliBadge"), s.cli);
    paint($("deskBadge"), s.desktop);
    applyText("patchTime", "检查于 " + new Date(s.now).toLocaleTimeString("zh-CN", { hour12: false }));
  }

  /* 提示条：keyMismatch（红色）/ 别的自家渠道 / 两端都在 CC Switch / CC Switch 在跑。
   * 清单 notices 里 {btn} 会被换成 primaryBtn；B.AI 页对 WorkBuddy 另有一句 onWb。 */
  function paintNotice(s) {
    const n = q(".notice") || $("notice");
    if (!n) return;
    n.classList.remove("show", "err");
    const NT = P.notices || {};
    const ends = [s.cli, s.desktop].filter(Boolean);
    const other = ends.find((e) => window.baiIsOurs(e.mode) && e.mode !== key);
    const kf = window.baiKeyMatchField(key);
    let txt = "", err = false;
    if (ends.some((e) => e.mode === key && e[kf] === false) && NT.keyMismatch) {
      txt = fill(NT.keyMismatch, {}); err = true;
    } else if (other) {
      txt = fill(NT[other.mode] || NT.other || NT.stale, {});
    } else if (NT.ccBoth && s.cli && s.desktop && s.cli.mode === "ccswitch" && s.desktop.mode === "ccswitch") {
      // 只有 bai 定义了 ccBoth；缺这条判断时 fill(undefined) 得到空串，
      // `if (!txt) return` 会把后面「CC Switch 正在运行」那条整条吞掉（四页都受影响）。
      txt = fill(NT.ccBoth, {});
    } else if (s.ccswitch && s.ccswitch.running) {
      txt = fill(NT.ccSwitch, {});
    }
    if (!txt) return;
    n.textContent = txt;
    n.classList.add("show");
    if (err) n.classList.add("err");
  }

  function renderStatus(s) {
    status = s;
    const S = st();
    $("svc").innerHTML = `服务 <b class="${s.service && s.service.up ? "" : "off"}">●</b> :${(S.relay || {}).port || "—"} / :${s.panel.port}`;
    for (const id of activeLamps()) {
      if ($(LAMP_DEFS[id].txt)) LAMP_PAINTERS[id](s, S);
    }
    /* 状态派生的设置字段（Qoder 那只读令牌框）——跟着状态走，别等下一次读配置 */
    if (has("fTokenView")) {
      const t = S.token || {};
      $("fTokenView").value = t.configured ? (CRED.preview || "jt-…（已就绪）") : "";
    }
    paintBadges(s);
    paintNotice(s);
  }

  /* ======================================================================
   * 7. renderRoute：四档 Claude 档位 → 目标模型 → 界面显示名
   * ==================================================================== */
  function prettyName(id) {
    return String(id).split("-").map((seg) => {
      const low = seg.toLowerCase();
      if (BRANDS[low]) return BRANDS[low];
      if (/^[0-9]/.test(seg)) return seg;                 // 版本号段原样
      const ver = low.match(/^([a-z]+)([0-9].*)$/);       // vision2 / v4 之类拆分 capitalize 前缀
      if (ver && BRANDS[ver[1]]) return BRANDS[ver[1]] + ver[2];
      return seg.charAt(0).toUpperCase() + seg.slice(1);
    }).join("-");
  }
  /* 下拉里显示的名字：model-catalog 卡把 /api/models 的 labels 暂存在这儿
     （Qoder 的 lite → 「Qwen3.8-Flash · 免费档」），value 仍是原始 key。 */
  const optText = (m) => {
    const L = window.BAI_MODEL_LABELS;
    return (L && L[m]) || m;
  };

  function renderRoute() {
    const tb = $("routeBody");
    if (!tb) return;
    const S = slice();
    const list = S.availableModels || [];
    tb.innerHTML = "";
    for (const t of TIERS) {
      const m = (S.mapping || {})[t.key] || { target: "", label: t.zh };
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
      sel.value = isCustom ? "__custom__" : m.target;
      const lbl = document.createElement("input");
      lbl.type = "text"; lbl.className = "lbl"; lbl.dataset.tier = t.key; lbl.dataset.role = "label";
      lbl.value = m.label; lbl.placeholder = "显示名";
      const cus = document.createElement("input");
      cus.type = "text"; cus.className = "custom"; cus.dataset.tier = t.key; cus.dataset.role = "custom";
      cus.value = isCustom ? m.target : ""; cus.placeholder = "输入模型名";
      cus.style.display = isCustom ? "" : "none";
      cus.style.marginTop = "4px";
      sel.addEventListener("change", () => {
        tr.querySelector('[data-role="custom"]').style.display = sel.value === "__custom__" ? "" : "none";
        const target = sel.value === "__custom__" ? (cus.value || "") : sel.value;
        if (target) lbl.value = prettyName(target);
      });
      cus.addEventListener("input", () => {
        if (sel.value === "__custom__" && cus.value) lbl.value = prettyName(cus.value);
      });
      tr.children[1].append(sel, cus);
      tr.children[2].appendChild(lbl);
      tb.appendChild(tr);
    }
  }

  /* ======================================================================
   * 8. renderSys：设置卡回填（凭据输入框由 cards/*.js 自己管，见 wire()）
   * ==================================================================== */
  const SYS_FIELDS = [
    ["fUpstream", "upstream"], ["fRelayPort", "relayPort"],
    ["fProxy", "proxy"], ["fPanelPort", "panelPort"], ["fApiKey", "apiKey"],
  ];
  function renderSys() {
    const S = slice();
    for (const [id, field] of SYS_FIELDS) {
      const el = $(id);
      if (!el) continue;
      el.value = S[field] || "";
      if (el.id === "fUpstream" && !el.placeholder) el.placeholder = S.upstream || "";
    }
    if (has("ckUseProxy")) $("ckUseProxy").checked = S.useProxy === true;
    if (has("fModels")) $("fModels").value = (S.availableModels || []).join("\n");
    /* 路由卡里的密钥行（B.AI / SenseNova）——旧页面是在 renderRoute 里回填的 */
    const ak = $("apiKey");
    if (ak) ak.value = S.apiKey || "";
    const hr = $("hintRelayPort");
    if (hr) hr.textContent = ":" + (S.relayPort || String(P.relayHint || "").replace(":", ""));
  }

  /* 令牌体检条：只有共享层自己管凭据输入框时才有（WorkBuddy 那张卡自己管） */
  function jwtExp(tok) {
    try {
      const seg = String(tok || "").split(".")[1];
      if (!seg) return null;
      const p = JSON.parse(atob(seg.replace(/-/g, "+").replace(/_/g, "/")));
      return typeof p.exp === "number" ? p.exp : null;
    } catch { return null; }
  }
  let ownsTokStat = false;
  function renderTokStat() {
    if (!ownsTokStat) return;
    const stat = $("tokStat");
    if (!stat) return;
    const S = slice(), t = st().token || {};
    if (t.tokenFile || CRED.kind === "file") {
      stat.innerHTML = t.configured
        ? `<span style="color:var(--ok)">✔ 已读到令牌</span>　<span class="mono">${esc(t.tokenFile || "")}</span>`
        : `<span style="color:var(--err)">✘ 未读到令牌</span>　${esc(CRED.notReady || "请先启动对应客户端")}`;
      return;
    }
    const exp = jwtExp(S.accessToken);
    if (!S.accessToken) { stat.innerHTML = `<span>访问令牌：<b class="warn">未配置</b></span>`; return; }
    const days = exp ? Math.max(0, Math.round((exp * 1000 - Date.now()) / 86400000)) : null;
    stat.innerHTML =
      `<span>访问令牌：<b>已配置</b></span>` +
      (exp
        ? `<span>有效期至 <b>${new Date(exp * 1000).toLocaleDateString("zh-CN")}</b>（剩 ${days} 天）</span>`
        : `<span>有效期：<b>无法解析</b></span>`) +
      `<span>刷新令牌：<b>${S.refreshToken ? "有（自动续期）" : "无"}</b></span>` +
      `<span>设备令牌：<b>${S.deviceToken ? "有" : "无"}</b></span>` +
      `<span>用户 ID：<b>${S.userId ? "有" : "无"}</b></span>`;
  }

  /* ======================================================================
   * 9. renderSteps：两步引导的状态机（凭据就绪 → 已接线）
   * ==================================================================== */
  function credReady() {
    const S = slice(), t = st().token;
    if (t && typeof t.configured === "boolean") return t.configured;
    if (P.credField) return !!S[P.credField];
    return !!(S.accessToken || S.apiKey);
  }
  const wiredToMe = () => !!status && (status.cli.mode === key || status.desktop.mode === key);

  function renderSteps() {
    if (!HAS_GUIDE) return;
    const s1 = $("step1"), s2 = $("step2");
    if (!s1) return;
    const cred = credReady(), wired = wiredToMe();
    s1.classList.toggle("done", cred);
    s1.classList.toggle("active", !cred);
    $("state1").textContent = cred ? "✓ 已完成" : "待完成";
    if (s2) {
      s2.classList.toggle("done", cred && wired);
      s2.classList.toggle("active", cred && !wired);
      s2.classList.toggle("locked", !cred);
      const b = $("btnApply");
      if (b) b.disabled = !cred || busy;
      $("state2").textContent = !cred ? "等待步骤一完成" : (wired ? "✓ 已接入" : "待完成");
      $("state2").style.color = (!cred) ? "" : (wired ? "var(--ok)" : "var(--accent)");
    }
    applyText("guideAux", (cred && wired) ? "全部就绪" : (cred ? "还差第 2 步" : "从第 1 步开始"));
  }

  /* ======================================================================
   * 10. 轮询 / 配置 / 忙碌包装
   * ==================================================================== */
  async function refreshConfig() {
    cfg = await api("/api/config");
    renderRoute();
    renderSys();
    renderTokStat();
    renderSteps();
  }

  /* 失败信息的落点：按钮所在卡片末尾的 .result（契约：每张卡的 .body 末尾恰好一个），
     找不到才退回 #applyResult。旧实现无条件写 #applyResult，于是 SenseNova 点
     「刷新模型列表」失败时，错误冒到页面顶部不相干的「当前接线」卡里，按钮旁边一片空白。
     卡片内的落点由 DOM 结构决定，调用点不必各自声明；确实需要时可传第三参显式覆盖。
     槽在点按钮时就取定（而非报错后才找），避免 fn() 里的重绘改变判断依据。 */
  function errSlotOf(btn, explicit) {
    if (explicit) return explicit;
    const card = btn && btn.closest ? btn.closest(".card") : null;
    return (card && q(".result", card)) || $("applyResult");
  }

  async function withBusy(btn, fn, errSlot) {
    const slot = errSlotOf(btn, errSlot);
    busy = true;
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "处理中…"; }
    try { await fn(); } catch (e) { showResult(slot, "出错了：" + e.message, false); }
    finally {
      if (btn) { btn.disabled = false; btn.textContent = old; }
      busy = false;
      poll();
    }
  }

  async function poll() {
    if (busy) return;
    try {
      const s = await api("/api/status");
      renderStatus(s);
      renderSteps();
      renderTokStat();
      for (const c of cards) {
        try { if (c.update) c.update(s, cfg); } catch (e) { console.warn("[card] " + c.name, e); }
      }
    } catch {
      $("svc").innerHTML = `服务 <b class="off">○</b> 已停止`;
      setLed($("ledRelay"), "r");
      $("txtRelay").textContent = "已停止";
    }
  }
  const refreshCards = () => {
    for (const c of cards) { try { if (c.refresh) c.refresh(); } catch (e) { console.warn("[card] " + c.name, e); } }
  };

  /* ======================================================================
   * 11. 动作接线（一律"存在即接"；cards/*.js 造出来的元素共享层不再接管）
   * ==================================================================== */
  function onClick(id, fn) {
    const el = $(id);
    if (el) el.addEventListener("click", fn);
  }

  async function applyMe() {
    if (HAS_GUIDE && !credReady()) {
      showResult($("applyResult"), fill(opt("step1Hint") || "请先完成第 1 步。", {}), false);
      return;
    }
    const r = await postJSON("/api/apply", {
      provider: key, cli: $("ckCli").checked, desktop: $("ckDesk").checked,
    });
    showResult($("applyResult"),
      (P.applyDone || `✔ 已${P.accentLabel || "接入"} ${SHORT}（切换前配置已自动快照）`)
      + "\n" + (r.warnings || []).map((w) => "· " + w).join("\n"), true);
    const msg = opt("applyInfoMsg");
    if (msg) showInfo(P.applyInfoTitle || "接入完成", msg);
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
    const body = { provider: key, mapping };
    /* B.AI / SenseNova 的密钥行在路由卡里，「保存映射」顺手一起存（旧页行为） */
    if (has("apiKey")) body.apiKey = $("apiKey").value;
    const r = await postJSON("/api/config", body);
    showResult($("testResult"), "✔ 映射已保存并生效\n" + (r.hints || []).map((h) => "· " + h).join("\n"), true);
    await refreshConfig();
  }

  async function testTiers() {
    const all = has("ckAllTiers") && $("ckAllTiers").checked;
    const r = await postJSON("/api/test", all ? { provider: key, all: true } : { provider: key });
    const single = !!r.active && !all;
    const note = opt("testNote") || {};
    const lines = (r.tiers || []).map((t) => {
      const name = t.label + LABEL_SUFFIX;
      const who = single ? "当前使用：" : (TIER_ZH[t.tier] || t.tier) + "：";
      return t.ok ? `✔ ${who}${name} · ${t.ms}ms` : `✘ ${who}${name} · 失败：${t.error}`;
    });
    const tail = single ? (note.single || "") : (note.all || "（最近 30 分钟没观察到真实对话流量，已测全部四档）");
    showResult($("testResult"), lines.join("\n") + (tail ? "\n" + tail : ""), !!r.ok);
  }

  async function refreshModels() {
    const r = await api(key === "bai" ? "/api/models" : "/api/models?p=" + key);
    const S = slice();
    const curTargets = TIERS
      .map((t) => String(((S.mapping || {})[t.key] || {}).target || "").toLowerCase())
      .filter(Boolean);
    const merged = [...new Set([...(r.models || []), ...curTargets])];
    await postJSON("/api/config", { provider: key, availableModels: merged });
    await refreshConfig();
    refreshCards();
    showResult($("testResult"),
      fill(opt("modelsRefreshMsg") || "✔ 已拉取模型 {count} 个\n下拉框已更新（映射目标强制保留）", { count: r.count }), true);
  }

  async function saveSys() {
    const body = { provider: key };
    for (const [id, field] of SYS_FIELDS) {
      const el = $(id);
      if (el && el.value.trim()) body[field] = el.value.trim();   // 空值不下发：apiKey 空串服务端会忽略
    }
    if (has("ckUseProxy")) body.useProxy = $("ckUseProxy").checked;
    if (has("fModels")) body.availableModels = $("fModels").value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
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
    await refreshConfig();
  }

  async function resetModels() {
    if (!DEFAULT_MODELS.length) return;
    await postJSON("/api/config", { provider: key, availableModels: DEFAULT_MODELS });
    await refreshConfig();
    showResult($("sysResult"),
      fill(opt("resetModelsMsg") || "✔ 已恢复默认模型：{list}", { list: DEFAULT_MODELS.join("、") }), true);
  }

  async function deployLocal() {
    if (window.baiDesktop) { await window.baiDesktop.deployLocal(); return; }
    const r = await postJSON("/api/deploy-local", { shortcuts: true, autostart: true, probeProxy: true });
    showResult($("sysResult"), "✔ 部署完成\n" + (r.messages || [r.error || ""]).join("\n"), !!r.ok);
  }

  async function detectProxy() {
    const b = $("btnProxyDetect");
    b.disabled = true; b.textContent = "检测中…";
    try {
      const r = await api("/api/proxy-detect", { method: "POST" });
      if (window.baiDesktop) showInfo(r.applied ? "代理已自动切换" : "代理检测", r.message, r.applied ? 0 : 5000);
      else alert(r.message);
      await refreshConfig();
      poll();
    } catch (e) {
      if (window.baiDesktop) showInfo("检测失败", e.message, 5000);
      else alert("检测失败：" + e.message);
    } finally { b.disabled = false; b.textContent = "自动检测代理"; }
  }

  function wire() {
    /* 卡挂载在前：它们造出来的 #cardTok / #tokStat / #tokToggle / #btnSaveTok 归卡自己管 */
    ownsTokStat = !has("tokStat");

    onClick("btnApply", () => withBusy($("btnApply"), applyMe));
    onClick("btnRestore", () => withBusy($("btnRestore"), async () => {
      const r = await postJSON("/api/restore", { cli: $("ckCli").checked, desktop: $("ckDesk").checked });
      showResult($("applyResult"),
        "✔ 已接回 CC Switch\n" + r.messages.map((m) => "· " + m).concat(r.hints.map((h) => "· " + h)).join("\n"), true);
    }));
    onClick("btnSave", () => withBusy($("btnSave"), saveMapping));
    onClick("btnTest", () => withBusy($("btnTest"), testTiers));
    onClick("btnModels", () => withBusy($("btnModels"), refreshModels));
    onClick("btnSaveSys", () => withBusy($("btnSaveSys"), saveSys));
    onClick("btnResetModels", () => withBusy($("btnResetModels"), resetModels));
    onClick("btnDeploy", () => withBusy($("btnDeploy"), deployLocal));
    onClick("btnProxyDetect", detectProxy);

    /* 凭据四件套（没有 token-capture 卡时由共享层兜底） */
    if (ownsTokStat) {
      const TOK_FIELDS = [["accessToken", "accessToken"], ["refreshToken", "refreshToken"],
        ["deviceToken", "deviceToken"], ["userId", "userId"]];
      onClick("btnSaveTok", () => withBusy($("btnSaveTok"), async () => {
        const body = { provider: key };
        for (const [id, f] of TOK_FIELDS) if ($(id)) body[f] = $(id).value.trim();
        const r = await postJSON("/api/config", body);
        showResult($("tokResult"), "✔ 令牌已保存\n" + (r.hints || []).map((h) => "· " + h).join("\n"), true);
        await refreshConfig();
        poll();
      }));
      onClick("tokToggle", () => {
        const els = ["accessToken", "refreshToken", "deviceToken"].map($).filter(Boolean);
        if (!els.length) return;
        const showing = els[0].type === "text";
        els.forEach((el) => { el.type = showing ? "password" : "text"; });
        $("tokToggle").textContent = showing ? "显示" : "隐藏";
      });
    }
    onClick("keyToggle", () => {
      const k = $("apiKey") || $("fApiKey");
      if (!k) return;
      const show = k.type === "password";
      k.type = show ? "text" : "password";
      $("keyToggle").textContent = show ? "隐藏" : "显示";
    });
  }

  /* ======================================================================
   * 12. 主题 / 窗口控制 / 折叠卡
   * ==================================================================== */
  function wireTheme() {
    const TKEY = "bai.theme";
    const apply = (t) => {
      document.documentElement.setAttribute("data-theme", t);
      const i = $("themeIcon"), x = $("themeText");
      if (i) i.textContent = t === "light" ? "☀" : "☾";
      if (x) x.textContent = t === "light" ? "亮色" : "暗色";
    };
    let t = null;
    try { t = localStorage.getItem(TKEY); } catch { }
    if (!t) {
      /* 没选过 → 跟随系统；系统也没说就保持暗色（与历史表现一致） */
      try { t = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; }
      catch (e) { t = "dark"; }
    }
    apply(t);
    const btn = $("themeBtn");
    if (btn) btn.addEventListener("click", () => {
      t = (document.documentElement.getAttribute("data-theme") === "light") ? "dark" : "light";
      try { localStorage.setItem(TKEY, t); } catch { }
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
    /* 双击标题栏空白处 = 最大化/还原 */
    const hd = document.querySelector("header");
    if (hd) hd.addEventListener("dblclick", (e) => {
      if (e.target.closest(".winCtrls") || e.target.closest(".prov-tab") || e.target.closest("button")) return;
      D.winToggleMaximize();
    });
  }

  /* 通用折叠卡（记忆展开状态；清单 foldKey 沿用旧页面的 localStorage 键） */
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
      try { localStorage.setItem(storeKey, col ? "0" : "1"); } catch { }
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  }

  /* ======================================================================
   * 13. 页脚 + 桌面事件
   * ==================================================================== */
  function wireFooter() {
    if (window.baiDesktop) {
      if (has("verTxt")) api("/api/version").then((v) => { $("verTxt").textContent = "v" + v.version; }).catch(() => { });
      const T = Object.assign({}, (FB.eventTitles || {}), (P.eventTitles || {}));
      window.baiDesktop.onAppEvent((ev) => {
        if (!ev) return;
        if (ev.kind === "recovered") showInfo(T.recovered || "服务恢复", ev.text);
        else if (ev.kind === "check") showInfo(T.check || "路由台", ev.text, ev.sticky ? 0 : 6000);
        else if (ev.kind === "deployed") showInfo(T.deployed || "已自动部署", ev.text, 8000);
      });
    }
  }

  /* ======================================================================
   * 14. extraCards 插槽：依次 /cards/<name>.js，再调 window.BAI_CARDS[name].mount(ctx)
   *     mount 可返回 { update(), refresh() }；update 每轮 poll 调一次。
   * ==================================================================== */
  const ctx = {
    key, PROVIDER: key, P,
    get cfg() { return cfg; },
    get status() { return status; },
    get slice() { return slice(); },
    get st() { return st(); },
    slot: $("slot-extra"),
    $, q, api, postJSON, showInfo, showResult, setLed, withBusy, esc,
    poll, refreshConfig, renderStatus, renderRoute, renderSys, renderSteps,
    fold, loadScript, TIERS, MODE_TXT, SHORT, fill,
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

  async function mountCards() {
    const names = Array.isArray(P.extraCards) ? P.extraCards : [];
    for (const name of names) {
      try {
        await loadScript("/cards/" + name + ".js");
        const mod = (window.BAI_CARDS || {})[name];
        if (!mod || typeof mod.mount !== "function") { console.warn("[card] " + name + " 未导出 mount()"); continue; }
        const view = mod.mount(ctx) || {};
        cards.push({ name, update: view.update, refresh: view.refresh });
      } catch (e) {
        console.warn("[card] " + name, e);
      }
    }
  }

  /* ======================================================================
   * 15. 启动
   * ==================================================================== */
  applyManifest();
  buildLamps();
  wireTheme();
  wireWindowCtrls();
  mountCards().finally(() => {
    fold("cardSys", "headSys", P.foldKey || ("bai.fold." + key));
    wire();
    wireFooter();
    poll();
    refreshConfig().catch((e) => showResult($("applyResult"), "配置加载失败：" + e.message, false));
    setInterval(poll, 5000);
  });
})();
