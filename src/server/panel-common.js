/* panel-common.js —— 五个提供方页面共用的底栏与更新/退出控件。
 *
 * 为什么抽出来：这些控件此前只存在于 ui.html（B.AI 页），要铺到其余四页就得复制四份。
 * 而本项目已经反复栽在"页面之间复制粘贴导致漂移"上——导航 tab 漏加、zen.html 的
 * PROVIDER 常量忘了从 wb 改成 zen、main.js 的 noProxyList 漏了 zen。共用一份是唯一
 * 不会再漂的做法。
 *
 * 加载方式：紧跟各页内联 <script> 之后，依赖页面已定义的顶层 $ / api / showInfo
 * （经典脚本的顶层 const/function 共享同一个全局词法环境，跨脚本可直接按名引用）。
 */
(() => {
  if (document.getElementById("panelCommonReady")) return;
  document.getElementById("panelCommonReady") // 占位：重复加载时直接返回
    || Object.defineProperty(document, "panelCommonReady", { value: 1, configurable: true });

  /* ---------- 1. 补齐其余四页缺失的样式（横幅进度条 / 按钮行 / 退出按钮配色 / 常驻底栏） ---------- */
  if (!document.getElementById("panelCommonCss")) {
    const st = document.createElement("style");
    st.id = "panelCommonCss";
    st.textContent = `
      .banner .bar { height: 4px; background: var(--line); border-radius: 99px; margin: 8px 0 6px; overflow: hidden; }
      .banner .bar i { display: block; height: 100%; background: var(--amber); width: 0%; transition: width .4s ease; }
      .banner .row { display: flex; gap: 8px; margin-top: 8px; }
      .banner button { font-size: 12px; padding: 5px 12px; border-radius: 6px; }
      #stopBtn { color: #b06a6a; }

      /* 底栏常驻：检查更新 / 备用升级 / 退出软件不能随页面滚走。
         sticky 而非 fixed —— 内容列宽 860px 居中，fixed 会横跨整个窗口宽度、与
         居中的内容对不齐；sticky 贴着同一列的底边，且滚到页面末尾时自然落回原位，
         不会出现"页尾多出一条空白"。z-index 低于 .banner-wrap(50)，通知横幅仍在上层。 */
      footer {
        position: sticky;
        bottom: 0;
        z-index: 10;
        padding: 10px 0 4px;
        margin-top: 14px;
        background: var(--bg);
        box-shadow: 0 -1px 0 var(--line), 0 -12px 20px -14px rgba(0,0,0,.45);
      }
    `;
    document.head.appendChild(st);
  }

  /* ---------- 2. 注入更新横幅（插在 bnrInfo 之前，与 ui.html 原顺序一致） ---------- */
  const wrap = document.querySelector(".banner-wrap");
  if (wrap && !document.getElementById("bnrUpdate")) {
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
    wrap.insertBefore(b, document.getElementById("bnrInfo"));
  }

  /* ---------- 3. 注入底栏按钮（插在 verTxt 之后） ---------- */
  const footer = document.querySelector("footer");
  if (footer && !document.getElementById("updBtn")) {
    const mk = (id, label, title) => {
      const b = document.createElement("button");
      b.className = "btn-sm"; b.id = id; b.type = "button";
      if (title) b.title = title;
      b.textContent = label;
      return b;
    };
    const anchor = document.getElementById("verTxt");
    const add = [
      mk("updBtn", "检查更新"),
      mk("btnSelfUpd", "备用升级", "不依赖内置更新器，直接从 GitHub 下载最新安装包并升级"),
      mk("stopBtn", "停止服务"),
    ];
    let ref = anchor;
    for (const b of add) { if (ref) ref.after(b); ref = b; }
  }

  const has = (id) => !!document.getElementById(id);

  // 本路由台自家提供的五家渠道。此前每页各自硬编码一份"还有别的端接在谁身上"的判断，
  // 结果各漏一部分（sn 页漏了 zen/qd，wb/zen/qd 三页都只列了 bai+sn）——第五家一加进来
  // 就又漂移。收口到这里，新增提供方只需改这一处。
  window.BAI_OURS = ["bai", "sn", "wb", "zen", "qd"];
  window.baiIsOurs = (m) => window.BAI_OURS.includes(m);
  // 本页该拿哪个 keyMatch 字段来比对自己的凭据（此前各页都写死成 keyMatchWb）
  window.baiKeyMatchField = (provider) => ({
    bai: "keyMatch", sn: "keyMatchSn", wb: "keyMatchWb", zen: "keyMatchZen", qd: "keyMatchQd",
  }[provider] || "keyMatch");

  /* ---------- 4. 备用升级：独立于 electron-updater 的自救援通道 ---------- */
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

  /* ---------- 5. 接线 ---------- */
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

  /* ---------- 6. 桌面壳 / 浏览器 的页脚差异 + 更新状态渲染 ---------- */
  if (window.baiDesktop) {
    if (has("stopBtn")) $("stopBtn").textContent = "退出软件";
    if (has("updBtn")) $("updBtn").style.display = "";
    if (has("btnSelfUpd")) $("btnSelfUpd").style.display = "";
    if (has("verTxt")) api("/api/version").then((v) => { $("verTxt").textContent = "v" + v.version; }).catch(() => { });

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
})();
